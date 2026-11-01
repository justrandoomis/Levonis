/**
 * THE OWNER'S ESTIMATE SETTINGS (docs/SMART_PRICING.md §4.1, §7; migration
 * 0218; owner decisions D2 and D3, DECISIONS rows 279–280).
 *
 *   - the two switches (`price_estimate_control`): «apply» — off until the
 *     owner turns it on, and refused while the published purchase policy does
 *     not yet carry the estimated-price clause (`purchase.version >= 7`) — and
 *     «ordering», the emergency brake on estimated lines;
 *   - the per-type table (`price_estimate_types`): the route (air only where the
 *     type allows it, filament by sea only, the EU store by land only — the
 *     0218 CHECKs and trigger T5 hold the same rules), the US reference, the
 *     default package weight and box or CBM, the extra cost in IQD, the minimum
 *     profit in USD and the staleness days. Every figure is the owner's: the
 *     seed holds none and nothing here invents one (invariant I8). Each edit is
 *     version-fenced and audited in `pricing_audit` (0181's vocabulary:
 *     entity 'rule', action 'rule_set', entity_key 'estimate_type:<key>');
 *   - the measure suggestion: the median of the REAL package measures of the
 *     products of a type — offered, never saved without the owner's click.
 *
 * OWNER-ONLY: every caller sits behind requireCostRead (worker/routes/
 * adminPriceEstimates.ts); every write behind assertCostWrite.
 */
import { HttpError, notFound } from '../../http';
import { auditStatements } from '../../audit';
import { fence, isFenceMiss } from '../../operations';
import { getPolicyDocument } from '../../policies';
import { isMissingEstimateSchema } from '../../priceEstimateLabel';
import { inputInvalid } from '../whatIf';
import { pricingAuditStatement } from '../store';
import { loadPricingRates } from '../rates';
import { canonicalUsdRuleAmount } from '@levonis/pricing/ruleResolution';
import { canonicalManualCbm } from '@levonis/pricing/estimateInputs';
import { PRICE_ROUNDING_STEP_IQD } from '@levonis/pricing/priceRounding';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { ESTIMATE_REFUSALS, estimateServerMessage, type EstimateRefusalCode } from '@levonis/contracts/priceEstimates';
import {
  ESTIMATE_POLICY_MIN_VERSION,
  SEA_ONLY_TYPES,
  controlOf,
  isRoute,
  isSourcing,
  typeRowOf,
  type EstimateControl,
  type EstimateTypeRow,
} from './types';

/** The engine's 400 PRICING_INPUT_INVALID {field}, for the estimator's router (it imports the estimator alone). */
export { inputInvalid };

/* --------------------------------------------------------------- refusals -- */

/** An estimate refusal by its contract code (ar / en message; the client renders the viewer's language). */
export function estimateRefusal(code: EstimateRefusalCode, details?: Record<string, unknown>): HttpError {
  return new HttpError(ESTIMATE_REFUSALS[code].status, estimateServerMessage(code), code, details);
}

/** 400 UNKNOWN_FIELD {field}: a body key the route does not read (the NAME only). */
export const unknownField = (field: string): HttpError => new HttpError(400, serverMessage('UNKNOWN_FIELD'), 'UNKNOWN_FIELD', { field });

/** 409 PRICING_CHANGED: someone wrote between the owner's read and this write. */
export const pricingChanged = (): HttpError => new HttpError(409, serverMessage('PRICING_CHANGED'), 'PRICING_CHANGED');

/** A request body as an object whose every key is one the route reads (UNKNOWN_FIELD otherwise). */
export function strictObject(raw: unknown, allowed: readonly string[], field = 'body'): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw inputInvalid(field);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw unknownField(k);
  return o;
}

/** A whole version number as a body carries it. */
export function versionOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw inputInvalid('version');
  return v;
}

/* --------------------------------------------------------------- the reads -- */

/** The owner's two switches, or null on a database without 0218. */
export async function loadControl(db: D1Database): Promise<EstimateControl | null> {
  try {
    return controlOf(await db.prepare('SELECT apply_enabled, ordering_enabled, version, updated_by, updated_at FROM price_estimate_control WHERE id = 1').first<Record<string, unknown>>());
  } catch (e) {
    if (isMissingEstimateSchema(e)) return null;
    throw e;
  }
}

/** Every type, in the seed's order then the owner's (insertion order). */
export async function loadTypes(db: D1Database): Promise<EstimateTypeRow[]> {
  try {
    const { results } = await db.prepare('SELECT * FROM price_estimate_types ORDER BY rowid').all<Record<string, unknown>>();
    return (results ?? []).map(typeRowOf).filter((t): t is EstimateTypeRow => t !== null);
  } catch (e) {
    if (isMissingEstimateSchema(e)) return [];
    throw e;
  }
}

/**
 * Is the estimated-price clause in force (§9 row 280)? The published purchase policy carries it from
 * version 7 on, effective on its date. Until then no product may carry the label.
 */
export function estimatePolicyInForce(today: string = new Date().toISOString().slice(0, 10)): boolean {
  const doc = getPolicyDocument('purchase');
  if (!doc || doc.version < ESTIMATE_POLICY_MIN_VERSION) return false;
  const effective = String(doc.effective_at ?? '');
  return !effective || effective <= today;
}

/* -------------------------------------------------------------- the switches -- */

/**
 * PUT /estimates/control {version, apply_enabled?, ordering_enabled?} (the route asks a fresh sign-in first).
 * «apply» on is refused until the published purchase policy carries the clause (409 PRICE_ESTIMATE_POLICY_MISSING).
 */
export async function setControl(db: D1Database, raw: unknown, actor: string, now: Date): Promise<EstimateControl> {
  const body = strictObject(raw, ['version', 'apply_enabled', 'ordering_enabled']);
  const version = versionOf(body.version);
  for (const k of ['apply_enabled', 'ordering_enabled'] as const) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') throw inputInvalid(k);
  }
  if (body.apply_enabled === undefined && body.ordering_enabled === undefined) throw inputInvalid('apply_enabled');
  const current = await loadControl(db);
  if (!current) throw estimateRefusal('PRICE_ESTIMATES_NOT_INSTALLED');
  if (current.version !== version) throw pricingChanged();
  const apply = body.apply_enabled === undefined ? current.apply_enabled : (body.apply_enabled as boolean);
  const ordering = body.ordering_enabled === undefined ? current.ordering_enabled : (body.ordering_enabled as boolean);
  if (apply && !current.apply_enabled && !estimatePolicyInForce(now.toISOString().slice(0, 10))) throw estimateRefusal('PRICE_ESTIMATE_POLICY_MISSING');
  const at = now.toISOString();
  const audit = await auditStatements(db, actor, 'price_estimate.control_set', 'price_estimate_control', {
    apply_enabled: apply,
    ordering_enabled: ordering,
  });
  try {
    await db.batch([
      ...fence(db, 'EXISTS (SELECT 1 FROM price_estimate_control WHERE id = 1 AND version = ?)', [version]),
      db
        .prepare('UPDATE price_estimate_control SET apply_enabled = ?, ordering_enabled = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = 1')
        .bind(apply ? 1 : 0, ordering ? 1 : 0, actor, at),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    throw e;
  }
  return { apply_enabled: apply, ordering_enabled: ordering, version: version + 1, updated_by: actor, updated_at: at };
}

/* ---------------------------------------------------------------- the types -- */

const TYPE_KEY = /^[a-z_]{2,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const MAX_WEIGHT = 100_000_000;
const MAX_AXIS = 100_000;
const MAX_EXTRA = 1_000_000_000;
/** The 0211 amount_usd grammar's ceiling (0218 USD6). */
const MAX_PROFIT_USD = 100_000;

const whole = (v: unknown, field: string, min: number, max: number): number | null => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw inputInvalid(field);
  return v;
};

function nameText(v: unknown, field: string): string {
  if (typeof v !== 'string') throw inputInvalid(field);
  const t = v.trim();
  if (t.length < 1 || t.length > 80 || CONTROL_CHARS.test(t)) throw inputInvalid(field);
  return t;
}

/** A minimum profit in USD as the 0218 column takes it (USD6), canonical, or null. */
function profitText(v: unknown): string | null {
  if (v === null) return null;
  const amount = typeof v === 'string' ? canonicalUsdRuleAmount(v.trim()) : null;
  if (!amount || amount.length > 13 || /\.\d{7,}$/.test(amount)) throw inputInvalid('min_profit_usd');
  const [int = '0'] = amount.split('.');
  if (int.length > 6 || Number(int) > MAX_PROFIT_USD || (Number(int) === MAX_PROFIT_USD && amount.includes('.'))) throw inputInvalid('min_profit_usd');
  return amount;
}

/** A default CBM as the 0218 column takes it (DEC 12), canonical, or null. */
function cbmText(v: unknown): string | null {
  if (v === null) return null;
  const cbm = typeof v === 'string' ? canonicalManualCbm(v.trim()) : null;
  if (!cbm) throw inputInvalid('default_cbm');
  return cbm;
}

/** The route rules of a type, in code before the CHECKs say the same (409 PRICE_ESTIMATE_TYPE_RULE). */
function checkTypeRules(t: Pick<EstimateTypeRow, 'key' | 'sourcing' | 'route' | 'allow_air' | 'us_reference_allowed'>): void {
  const eu = t.sourcing === 'EU_STORE_EUR';
  const broken =
    (eu && (t.route !== 'land' || t.allow_air)) ||
    (!eu && (t.route === 'land' || t.us_reference_allowed)) ||
    (t.route === 'air' && !t.allow_air) ||
    (SEA_ONLY_TYPES.includes(t.key) && (t.route !== 'sea' || t.allow_air));
  if (broken) throw estimateRefusal('PRICE_ESTIMATE_TYPE_RULE');
}

const EDITABLE = [
  'route',
  'allow_air',
  'us_reference_allowed',
  'default_weight_g',
  'default_length_mm',
  'default_width_mm',
  'default_height_mm',
  'default_cbm',
  'additional_cost_iqd',
  'min_profit_usd',
  'stale_after_days',
  'name_ar',
  'name_en',
  'name_ckb',
] as const;
type Editable = (typeof EDITABLE)[number];

/** The type a body leaves (a key the body leaves out keeps its stored value; null clears a figure). */
function typeAfter(stored: EstimateTypeRow, body: Record<string, unknown>): EstimateTypeRow {
  const next: EstimateTypeRow = { ...stored };
  const has = (k: Editable) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  if (has('route')) {
    if (!isRoute(body.route)) throw inputInvalid('route');
    next.route = body.route;
  }
  for (const k of ['allow_air', 'us_reference_allowed'] as const) {
    if (!has(k)) continue;
    if (typeof body[k] !== 'boolean') throw inputInvalid(k);
    next[k] = body[k] as boolean;
  }
  if (has('default_weight_g')) next.default_weight_g = whole(body.default_weight_g, 'default_weight_g', 1, MAX_WEIGHT);
  const box = (['default_length_mm', 'default_width_mm', 'default_height_mm'] as const).filter((k) => has(k));
  if (box.length) {
    // The box is one unit (as the form's): its three axes travel together, all set or all cleared.
    if (box.length !== 3) throw inputInvalid('default_box');
    const axes = (['default_length_mm', 'default_width_mm', 'default_height_mm'] as const).map((k) => whole(body[k], k, 1, MAX_AXIS));
    if (axes.some((a) => a === null) && axes.some((a) => a !== null)) throw inputInvalid('default_box');
    [next.default_length_mm, next.default_width_mm, next.default_height_mm] = axes;
  }
  if (has('default_cbm')) next.default_cbm = cbmText(body.default_cbm);
  if (has('additional_cost_iqd')) next.additional_cost_iqd = whole(body.additional_cost_iqd, 'additional_cost_iqd', 0, MAX_EXTRA);
  if (has('min_profit_usd')) next.min_profit_usd = profitText(body.min_profit_usd);
  if (has('stale_after_days')) next.stale_after_days = whole(body.stale_after_days, 'stale_after_days', 1, 365) ?? stored.stale_after_days;
  for (const k of ['name_ar', 'name_en', 'name_ckb'] as const) if (has(k)) next[k] = nameText(body[k], k);
  // DECISIONS row 183: a Sorani slot never carries a copy of the Arabic.
  if (next.name_ckb === next.name_ar) throw inputInvalid('name_ckb');
  checkTypeRules(next);
  return next;
}

/** The figures of a type as the audit holds them (owner-only `pricing_audit`). */
const figuresOf = (t: EstimateTypeRow) => ({
  route: t.route,
  allow_air: t.allow_air,
  us_reference_allowed: t.us_reference_allowed,
  default_weight_g: t.default_weight_g,
  default_box: t.default_length_mm === null ? null : [t.default_length_mm, t.default_width_mm, t.default_height_mm],
  default_cbm: t.default_cbm,
  additional_cost_iqd: t.additional_cost_iqd,
  min_profit_usd: t.min_profit_usd,
  stale_after_days: t.stale_after_days,
});

/**
 * Whether T × U sits below one rounding step (§4.3): the route floor then closes the route
 * (V2_ROUTE_BELOW_COST), so the type editor warns. Exact decimal arithmetic; a warning, never a price.
 */
export function profitBelowRouteFloor(minProfitUsd: string | null, usdIqd: string | null): boolean {
  if (!minProfitUsd || !usdIqd) return false;
  const parse = (s: string) => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
    return m ? { n: BigInt(`${m[1]}${m[2] ?? ''}`), scale: (m[2] ?? '').length } : null;
  };
  const t = parse(minProfitUsd);
  const u = parse(usdIqd);
  if (!t || !u) return false;
  return t.n * u.n < BigInt(PRICE_ROUNDING_STEP_IQD) * 10n ** BigInt(t.scale + u.scale);
}

export interface TypeAnswer extends EstimateTypeRow {
  /** T × U is below one rounding step: the route would close (§4.3). */
  warnings: string[];
}

export async function typeAnswers(db: D1Database, types: readonly EstimateTypeRow[]): Promise<TypeAnswer[]> {
  const rates = types.some((t) => t.min_profit_usd) ? await loadPricingRates(db) : null;
  return types.map((t) => ({ ...t, warnings: profitBelowRouteFloor(t.min_profit_usd, rates?.usd_iqd ?? null) ? ['MIN_PROFIT_BELOW_ROUTE_FLOOR'] : [] }));
}

/** PUT /estimates/types/:key {version, …figures}: version-fenced, audited; answers the stored type. */
export async function updateType(db: D1Database, key: string, raw: unknown, actor: string, now: Date): Promise<EstimateTypeRow> {
  if (!TYPE_KEY.test(key)) throw notFound();
  const body = strictObject(raw, ['version', ...EDITABLE]);
  const version = versionOf(body.version);
  const stored = (await loadTypes(db)).find((t) => t.key === key);
  if (!stored) throw notFound();
  if (stored.version !== version) throw pricingChanged();
  const next = typeAfter(stored, body);
  const at = now.toISOString();
  const changed = EDITABLE.filter((k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined);
  const audit = await auditStatements(db, actor, 'price_estimate.type_set', key, { key, fields: changed });
  try {
    await db.batch([
      ...fence(db, 'EXISTS (SELECT 1 FROM price_estimate_types WHERE key = ? AND version = ?)', [key, version]),
      db
        .prepare(
          `UPDATE price_estimate_types
              SET name_ar = ?, name_en = ?, name_ckb = ?, route = ?, allow_air = ?, us_reference_allowed = ?,
                  default_weight_g = ?, default_length_mm = ?, default_width_mm = ?, default_height_mm = ?, default_cbm = ?,
                  additional_cost_iqd = ?, min_profit_usd = ?, stale_after_days = ?,
                  version = version + 1, updated_by = ?, updated_at = ?
            WHERE key = ?`
        )
        .bind(
          next.name_ar,
          next.name_en,
          next.name_ckb,
          next.route,
          next.allow_air ? 1 : 0,
          next.us_reference_allowed ? 1 : 0,
          next.default_weight_g,
          next.default_length_mm,
          next.default_width_mm,
          next.default_height_mm,
          next.default_cbm,
          next.additional_cost_iqd,
          next.min_profit_usd,
          next.stale_after_days,
          actor,
          at,
          key
        ),
      pricingAuditStatement(db, {
        entity: 'rule',
        entity_key: `estimate_type:${key}`,
        product_id: null,
        action: 'rule_set',
        before: figuresOf(stored),
        after: figuresOf(next),
        actor,
        now: at,
      }),
      ...audit.statements,
    ]);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    if (/CHECK constraint failed/i.test(e instanceof Error ? e.message : String(e))) throw estimateRefusal('PRICE_ESTIMATE_TYPE_RULE');
    throw e;
  }
  return { ...next, version: version + 1, updated_by: actor, updated_at: at };
}

/**
 * POST /estimates/types {key, name_ar, name_en, name_ckb, sourcing, route, allow_air?, us_reference_allowed?}: a
 * new type, every figure NULL until the owner types it (PUT). 409 PRICING_CHANGED when the key exists.
 */
export async function createType(db: D1Database, raw: unknown, actor: string, now: Date): Promise<EstimateTypeRow> {
  const body = strictObject(raw, ['key', 'name_ar', 'name_en', 'name_ckb', 'sourcing', 'route', 'allow_air', 'us_reference_allowed']);
  if (typeof body.key !== 'string' || !TYPE_KEY.test(body.key)) throw inputInvalid('key');
  if (!isSourcing(body.sourcing)) throw inputInvalid('sourcing');
  if (!isRoute(body.route)) throw inputInvalid('route');
  for (const k of ['allow_air', 'us_reference_allowed'] as const) if (body[k] !== undefined && typeof body[k] !== 'boolean') throw inputInvalid(k);
  const at = now.toISOString();
  const t: EstimateTypeRow = {
    key: body.key,
    name_ar: nameText(body.name_ar, 'name_ar'),
    name_en: nameText(body.name_en, 'name_en'),
    name_ckb: nameText(body.name_ckb, 'name_ckb'),
    sourcing: body.sourcing,
    route: body.route,
    allow_air: body.allow_air === true,
    us_reference_allowed: body.us_reference_allowed === true,
    default_weight_g: null,
    default_length_mm: null,
    default_width_mm: null,
    default_height_mm: null,
    default_cbm: null,
    additional_cost_iqd: null,
    min_profit_usd: null,
    stale_after_days: 60,
    version: 1,
    updated_by: actor,
    updated_at: at,
  };
  if (t.name_ckb === t.name_ar) throw inputInvalid('name_ckb');
  checkTypeRules(t);
  const audit = await auditStatements(db, actor, 'price_estimate.type_created', t.key, { key: t.key, sourcing: t.sourcing, route: t.route });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO price_estimate_types (key, name_ar, name_en, name_ckb, sourcing, route, allow_air, us_reference_allowed, version, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(t.key, t.name_ar, t.name_en, t.name_ckb, t.sourcing, t.route, t.allow_air ? 1 : 0, t.us_reference_allowed ? 1 : 0, actor, at),
      pricingAuditStatement(db, { entity: 'rule', entity_key: `estimate_type:${t.key}`, product_id: null, action: 'create', before: null, after: figuresOf(t), actor, now: at }),
      ...audit.statements,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: price_estimate_types\.key/i.test(msg)) throw pricingChanged();
    if (/CHECK constraint failed/i.test(msg)) throw estimateRefusal('PRICE_ESTIMATE_TYPE_RULE');
    throw e;
  }
  return t;
}

/* ----------------------------------------------------------- the suggestion -- */

export interface MeasureSuggestion {
  key: string;
  /** Products of the type with a real package measure. */
  count: number;
  weight_g: number | null;
  /** The box of the product whose volume is the median (a real box, never averaged). */
  box: [number, number, number] | null;
  /** That box's volume in m³, as the type's `default_cbm` would hold it. */
  cbm: string | null;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

/** A volume in mm³ as m³ decimal text (exact; at most 9 fraction digits), or null when it is not one. */
export function cbmOfVolume(mm3: bigint): string | null {
  if (mm3 <= 0n) return null;
  const int = mm3 / 1_000_000_000n;
  const frac = (mm3 % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return canonicalManualCbm(frac ? `${int}.${frac}` : `${int}`);
}

/**
 * GET /estimates/types/:key/suggest: the median of the REAL package measures (the products' own
 * `package_*` columns) of the products classified under this type. A proposal only — nothing is written.
 */
export async function suggestTypeMeasures(db: D1Database, key: string): Promise<MeasureSuggestion> {
  if (!TYPE_KEY.test(key)) throw notFound();
  if (!(await loadTypes(db)).some((t) => t.key === key)) throw notFound();
  const { results } = await db
    .prepare(
      `SELECT p.package_weight_g AS w, p.package_depth_mm AS l, p.package_width_mm AS wd, p.package_height_mm AS h
         FROM product_price_estimates e JOIN products p ON p.id = e.product_id
        WHERE e.type_key = ?`
    )
    .bind(key)
    .all<{ w: number | null; l: number | null; wd: number | null; h: number | null }>();
  const rows = results ?? [];
  const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
  const weights = rows.map((r) => pos(r.w)).filter((v): v is number => v !== null);
  const boxes = rows
    .map((r) => [pos(r.l), pos(r.wd), pos(r.h)] as const)
    .filter((b): b is readonly [number, number, number] => b.every((a) => a !== null))
    .map((b) => ({ box: [b[0], b[1], b[2]] as [number, number, number], volume: BigInt(b[0]) * BigInt(b[1]) * BigInt(b[2]) }))
    .sort((a, b) => (a.volume < b.volume ? -1 : a.volume > b.volume ? 1 : 0));
  const mid = boxes.length ? boxes[Math.floor((boxes.length - 1) / 2)]! : null;
  const measured = rows.filter((r) => pos(r.w) !== null || [r.l, r.wd, r.h].every((a) => pos(a) !== null)).length;
  return { key, count: measured, weight_g: median(weights), box: mid ? mid.box : null, cbm: mid ? cbmOfVolume(mid.volume) : null };
}
