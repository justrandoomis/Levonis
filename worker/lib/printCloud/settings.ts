/**
 * Print Cloud configuration: one versioned row (`pc_settings`), defaults in
 * code, normalised on every read so a partial or stale row can never yield an
 * out-of-range value. Every numeric business rule the owner may want to tune
 * lives here rather than in a constant.
 *
 * COST KEYS (`cost_*`) are owner data: `publicSettings` strips them, and only
 * a cost writer may change them (worker/routes/printCloudAdmin.ts).
 */
import { invalid } from './errors';
import { many, one, type Stmt } from './db';
import { iso } from './util';

export type OveragePolicy = 'cap_at_reserved' | 'charge_from_balance';
export type FailurePolicy = 'no_charge' | 'charge_printed' | 'manual_review';
export type Responsible = 'workshop' | 'customer' | 'model' | 'undetermined';

export interface ImportProvider {
  id: string;
  hosts: string[];
  /** The provider's own JSON API for metadata, `{id}` substituted. Empty = none configured. */
  api_url: string;
  /**
   * Download is permitted ONLY when the provider's API answers with an
   * authorised file URL on one of these hosts. Empty = never download; the
   * link is saved and the customer uploads the file.
   */
  download_hosts: string[];
  enabled: boolean;
}

export interface PrintCloudConfig {
  /** Customer doors answer 503 PRINT_CLOUD_DISABLED until the owner opens the service. */
  enabled: boolean;
  quote_ttl_minutes: number;
  stock_hold_minutes: number;
  confirmation_ttl_minutes: number;
  /** Custom-quantity material prices are rounded UP to this step; exact pack prices are never rounded. */
  material_price_rounding_iqd: number;
  /** Never charge more for a smaller custom quantity than for the next pack that covers it. */
  cap_custom_price_at_next_pack: boolean;
  /** When actual use exceeds the reservation: bill only what was reserved, or the rest from the balance. */
  time_overage_policy: OveragePolicy;
  material_overage_policy: OveragePolicy;
  require_operator_approval: boolean;
  /** A confirmed or completed job the agent reports is verified by an operator before it is billed. */
  agent_reports_need_verification: boolean;
  telemetry_stale_seconds: number;
  failure_policy: Record<Responsible, FailurePolicy>;
  /** A verified workshop failure entitles the customer to a free reprint. */
  free_reprint_on_workshop_failure: boolean;
  max_upload_bytes: number;
  max_active_jobs_per_customer: number;
  /** A reminder below this many grams, unless the customer set their own threshold. */
  low_inventory_default_g: number;
  delivery: { enabled: boolean; pickup_enabled: boolean; flat_fee_iqd: number; fee_by_governorate: Record<string, number> };
  import_providers: ImportProvider[];
  /** Owner only: the electricity tariff used by the cost reports. */
  cost_electricity_iqd_per_kwh: number;
}

/**
 * The largest model the service accepts, whatever the settings say: the
 * gateway's body class for POST /api/print-cloud/v1/files is read from this
 * constant (services/gateway/src/uploadClasses.ts), and 40 MB is the
 * platform's largest accepted body.
 */
export const MODEL_UPLOAD_CEILING_BYTES = 40 * 1024 * 1024;

export const DEFAULT_IMPORT_PROVIDERS: ImportProvider[] = [
  { id: 'makerworld', hosts: ['makerworld.com'], api_url: '', download_hosts: [], enabled: true },
  { id: 'printables', hosts: ['printables.com'], api_url: '', download_hosts: [], enabled: true },
  { id: 'thingiverse', hosts: ['thingiverse.com'], api_url: '', download_hosts: [], enabled: true },
];

export const DEFAULT_CONFIG: PrintCloudConfig = Object.freeze({
  enabled: false,
  quote_ttl_minutes: 30,
  stock_hold_minutes: 60,
  confirmation_ttl_minutes: 120,
  material_price_rounding_iqd: 250,
  cap_custom_price_at_next_pack: true,
  time_overage_policy: 'cap_at_reserved',
  material_overage_policy: 'cap_at_reserved',
  require_operator_approval: true,
  agent_reports_need_verification: true,
  telemetry_stale_seconds: 120,
  failure_policy: { workshop: 'no_charge', customer: 'charge_printed', model: 'charge_printed', undetermined: 'manual_review' },
  free_reprint_on_workshop_failure: true,
  max_upload_bytes: MODEL_UPLOAD_CEILING_BYTES,
  max_active_jobs_per_customer: 25,
  low_inventory_default_g: 100,
  delivery: { enabled: true, pickup_enabled: true, flat_fee_iqd: 5000, fee_by_governorate: {} },
  import_providers: DEFAULT_IMPORT_PROVIDERS,
  cost_electricity_iqd_per_kwh: 0,
}) as PrintCloudConfig;

const clampInt = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : def;
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);
const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;

const HOST_RE = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const GOVERNORATE_RE = /^[a-z_]{2,40}$/;
const MAX_GOVERNORATES = 30;
const MAX_PROVIDERS = 20;

function normalizeProviders(v: unknown): ImportProvider[] {
  if (!Array.isArray(v)) return DEFAULT_IMPORT_PROVIDERS.map((p) => ({ ...p }));
  const out: ImportProvider[] = [];
  for (const raw of v.slice(0, MAX_PROVIDERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === 'string' && /^[a-z0-9_-]{2,40}$/.test(p.id) ? p.id : '';
    if (!id || out.some((o) => o.id === id)) continue;
    const hosts = Array.isArray(p.hosts) ? p.hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h)).slice(0, 10) : [];
    if (!hosts.length) continue;
    const apiUrl = typeof p.api_url === 'string' && /^https:\/\/[^\s]+$/.test(p.api_url) ? p.api_url : '';
    const downloadHosts = Array.isArray(p.download_hosts)
      ? p.download_hosts.filter((h): h is string => typeof h === 'string' && HOST_RE.test(h)).slice(0, 10)
      : [];
    out.push({ id, hosts, api_url: apiUrl, download_hosts: downloadHosts, enabled: bool(p.enabled, true) });
  }
  return out;
}

const POLICIES: readonly FailurePolicy[] = ['no_charge', 'charge_printed', 'manual_review'];
const OVERAGE: readonly OveragePolicy[] = ['cap_at_reserved', 'charge_from_balance'];

export function normalizeConfig(raw: unknown): PrintCloudConfig {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_CONFIG;
  const fp = r.failure_policy && typeof r.failure_policy === 'object' ? (r.failure_policy as Record<string, unknown>) : {};
  const del = r.delivery && typeof r.delivery === 'object' ? (r.delivery as Record<string, unknown>) : {};
  const fees: Record<string, number> = {};
  if (del.fee_by_governorate && typeof del.fee_by_governorate === 'object') {
    for (const [k, v] of Object.entries(del.fee_by_governorate as Record<string, unknown>).slice(0, MAX_GOVERNORATES)) {
      if (GOVERNORATE_RE.test(k) && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000) fees[k] = v;
    }
  }
  return {
    enabled: bool(r.enabled, d.enabled),
    quote_ttl_minutes: clampInt(r.quote_ttl_minutes, d.quote_ttl_minutes, 5, 24 * 60),
    stock_hold_minutes: clampInt(r.stock_hold_minutes, d.stock_hold_minutes, 5, 7 * 24 * 60),
    confirmation_ttl_minutes: clampInt(r.confirmation_ttl_minutes, d.confirmation_ttl_minutes, 5, 7 * 24 * 60),
    material_price_rounding_iqd: clampInt(r.material_price_rounding_iqd, d.material_price_rounding_iqd, 0, 5000),
    cap_custom_price_at_next_pack: bool(r.cap_custom_price_at_next_pack, d.cap_custom_price_at_next_pack),
    time_overage_policy: pick(r.time_overage_policy, OVERAGE, d.time_overage_policy),
    material_overage_policy: pick(r.material_overage_policy, OVERAGE, d.material_overage_policy),
    require_operator_approval: bool(r.require_operator_approval, d.require_operator_approval),
    agent_reports_need_verification: bool(r.agent_reports_need_verification, d.agent_reports_need_verification),
    telemetry_stale_seconds: clampInt(r.telemetry_stale_seconds, d.telemetry_stale_seconds, 15, 3600),
    failure_policy: {
      workshop: pick(fp.workshop, POLICIES, d.failure_policy.workshop),
      customer: pick(fp.customer, POLICIES, d.failure_policy.customer),
      model: pick(fp.model, POLICIES, d.failure_policy.model),
      undetermined: pick(fp.undetermined, POLICIES, d.failure_policy.undetermined),
    },
    free_reprint_on_workshop_failure: bool(r.free_reprint_on_workshop_failure, d.free_reprint_on_workshop_failure),
    max_upload_bytes: clampInt(r.max_upload_bytes, d.max_upload_bytes, 1024, MODEL_UPLOAD_CEILING_BYTES),
    max_active_jobs_per_customer: clampInt(r.max_active_jobs_per_customer, d.max_active_jobs_per_customer, 1, 500),
    low_inventory_default_g: clampInt(r.low_inventory_default_g, d.low_inventory_default_g, 0, 100_000),
    delivery: {
      enabled: bool(del.enabled, d.delivery.enabled),
      pickup_enabled: bool(del.pickup_enabled, d.delivery.pickup_enabled),
      flat_fee_iqd: clampInt(del.flat_fee_iqd, d.delivery.flat_fee_iqd, 0, 1_000_000),
      fee_by_governorate: fees,
    },
    import_providers: normalizeProviders(r.import_providers),
    cost_electricity_iqd_per_kwh: clampInt(r.cost_electricity_iqd_per_kwh, d.cost_electricity_iqd_per_kwh, 0, 100_000),
  };
}

export interface LoadedConfig {
  config: PrintCloudConfig;
  version: number;
}

export async function loadConfig(db: D1Database): Promise<LoadedConfig> {
  const row = await one<{ value_json: string; version: number }>(db, "SELECT value_json, version FROM pc_settings WHERE key = 'config'");
  if (!row) return { config: normalizeConfig({}), version: 0 };
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    parsed = {};
  }
  return { config: normalizeConfig(parsed), version: Number(row.version) };
}

/** The configuration a non-owner may read: every `cost_*` key removed. */
export function publicSettings(config: PrintCloudConfig): Omit<PrintCloudConfig, 'cost_electricity_iqd_per_kwh'> {
  const { cost_electricity_iqd_per_kwh: _cost, ...rest } = config;
  return rest;
}

export const COST_SETTING_KEYS = ['cost_electricity_iqd_per_kwh'] as const;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The stored configuration with a patch laid over it KEY BY KEY at every
 * level: a patch naming one delivery or failure-policy key changes that key
 * alone, and every sibling keeps the value the owner set. Governorate fees
 * merge one by one, and a fee set to null removes that governorate. A list
 * (`import_providers`) is replaced whole.
 */
function mergeConfig(current: PrintCloudConfig, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current, ...patch };
  if (patch.failure_policy !== undefined) {
    if (!isObject(patch.failure_policy)) throw invalid('failure_policy', 'object_required');
    merged.failure_policy = { ...current.failure_policy, ...patch.failure_policy };
  }
  if (patch.delivery !== undefined) {
    if (!isObject(patch.delivery)) throw invalid('delivery', 'object_required');
    const fees = patch.delivery.fee_by_governorate;
    if (fees !== undefined && !isObject(fees)) throw invalid('delivery.fee_by_governorate', 'object_required');
    const kept = Object.entries({ ...current.delivery.fee_by_governorate, ...fees }).filter(([, fee]) => fee !== null);
    if (kept.length > MAX_GOVERNORATES) throw invalid('delivery.fee_by_governorate', 'too_many');
    merged.delivery = { ...current.delivery, ...patch.delivery, fee_by_governorate: Object.fromEntries(kept) };
  }
  return merged;
}

/** Why a stated value did not survive normalisation, in the words the catalogue's validators use. */
function refusal(kept: unknown, asked: unknown): string {
  if (typeof kept === 'number') return typeof asked === 'number' && Number.isSafeInteger(asked) ? 'out_of_range' : 'integer_required';
  if (typeof kept === 'boolean') return 'boolean_required';
  if (typeof kept === 'string') return 'not_allowed';
  return 'invalid_value';
}

/**
 * A value the patch states must come out of normalisation exactly as stated.
 * normalizeConfig is the safety net of every READ: it swaps anything out of
 * range, of the wrong type or unknown for the default. On a WRITE that swap
 * would change a business rule nobody asked to change, so it is refused.
 */
function assertKept(path: string, asked: unknown, kept: unknown): void {
  if (isObject(kept)) {
    if (!isObject(asked)) throw invalid(path, 'object_required');
    for (const [k, v] of Object.entries(asked)) {
      if (!has(kept, k)) throw invalid(`${path}.${k}`, 'unknown_setting');
      assertKept(`${path}.${k}`, v, kept[k]);
    }
    return;
  }
  if (Array.isArray(kept)) {
    if (!Array.isArray(asked)) throw invalid(path, 'array_required');
    if (asked.length !== kept.length) throw invalid(path, 'invalid_value');
    asked.forEach((v, i) => assertKept(`${path}[${i}]`, v, kept[i]));
    return;
  }
  if (asked !== kept) throw invalid(path, refusal(kept, asked));
}

/** Every stated key of a patch, checked against the configuration it produced. */
function assertPatchKept(patch: Record<string, unknown>, next: PrintCloudConfig): void {
  for (const [key, asked] of Object.entries(patch)) {
    if (key === 'delivery') {
      const { fee_by_governorate: fees, ...rest } = asked as Record<string, unknown>;
      assertKept('delivery', rest, next.delivery);
      for (const [g, fee] of Object.entries((fees ?? {}) as Record<string, unknown>)) {
        const path = `delivery.fee_by_governorate.${g}`;
        if (!GOVERNORATE_RE.test(g)) throw invalid(path, 'not_allowed');
        if (fee !== null && (!has(next.delivery.fee_by_governorate, g) || next.delivery.fee_by_governorate[g] !== fee)) throw invalid(path, refusal(0, fee));
      }
    } else if (key === 'import_providers') {
      // Each provider on its own, so a dropped one is named rather than shifting the rest.
      if (!Array.isArray(asked)) throw invalid(key, 'array_required');
      if (asked.length > MAX_PROVIDERS) throw invalid(key, 'too_many');
      asked.forEach((p, i) => {
        const [kept] = normalizeProviders([p]);
        if (!kept) throw invalid(`${key}[${i}]`, 'invalid_value');
        assertKept(`${key}[${i}]`, p, kept);
      });
      if (next.import_providers.length !== asked.length) throw invalid(key, 'duplicate');
    } else {
      assertKept(key, asked, next[key as keyof PrintCloudConfig]);
    }
  }
}

/**
 * The statement that writes a new configuration, fenced on the version the
 * editor read (a stale editor's save aborts with STATE_CHANGED). The patch is
 * merged over the stored config key by key (`mergeConfig`) and every value it
 * states is validated against the bounds of `normalizeConfig`: an unknown key
 * or a value out of range is refused, so a typo is an error, never a silent
 * no-op or a silent default.
 */
export function configWrite(
  db: D1Database,
  current: LoadedConfig,
  patch: Record<string, unknown>,
  actorId: string,
  now: Date
): { next: PrintCloudConfig; statements: Stmt[] } {
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(patch)) if (!known.has(k)) throw invalid(k, 'unknown_setting');
  const next = normalizeConfig(mergeConfig(current.config, patch));
  assertPatchKept(patch, next);
  const value = JSON.stringify(next);
  const statements: Stmt[] = [];
  if (current.version === 0) {
    statements.push(
      db
        .prepare("INSERT INTO pc_settings (key, value_json, version, updated_by, updated_at) VALUES ('config', ?, 1, ?, ?)")
        .bind(value, actorId, iso(now))
    );
  } else {
    statements.push(
      db
        .prepare("UPDATE pc_settings SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE key = 'config' AND version = ?")
        .bind(value, actorId, iso(now), current.version)
    );
    statements.push(
      db
        .prepare("INSERT INTO pc_fence (code, ok) SELECT 'STATE_CHANGED', CASE WHEN (SELECT version FROM pc_settings WHERE key = 'config') = ? THEN 1 ELSE 0 END")
        .bind(current.version + 1)
    );
  }
  return { next, statements };
}

/** Every unit row, for validating a variant's base unit. */
export async function unitRows(db: D1Database): Promise<Array<{ code: string; dimension: string; base_code: string; factor_to_base: number; is_base: number }>> {
  return many(db, 'SELECT code, dimension, base_code, factor_to_base, is_base FROM pc_units ORDER BY code');
}
