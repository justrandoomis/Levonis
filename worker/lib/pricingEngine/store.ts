/**
 * THE ENGINE'S PRIVATE STORE: one product's inputs, rules and state — read by
 * an explicit column list, written by plain INSERT (new row) or version-fenced
 * UPDATE (existing row), never `ON CONFLICT` / `OR REPLACE` (migration 0181's
 * no-re-insert triggers refuse them).
 *
 * USD design §3 (the single store of current costs), §4 (the minimum profit in
 * USD), §6.4 (fences, audit). Every write batch built from here:
 *   1. fences the product's `product_pricing_state.inputs_seq` as read (every
 *      input and product rule bumps it by trigger, so a concurrent edit — or
 *      the engine's own writer — refuses the batch) and `config_version` (a
 *      central rate or a global rule moved);
 *   2. carries the owner-input token `pricing-input-owner:<product_id>`, so an
 *      IQD-converted supplier cost may be replaced (0181's
 *      `pricing_inputs_iqd_snapshot_frozen`), inserted first and deleted last;
 *   3. inserts the state row when the product has none (code inserts it on the
 *      first write — never a trigger, so a cascade delete never inserts one);
 *   4. writes the inputs and the rules, then `pricing_audit` (the values,
 *      private) and `audit_log` (ids and counts only), in the same batch.
 *
 * PRIVATE: every value here is the owner's. Nothing is logged; refusals carry
 * codes only. This module never names an accounting table (orders, order
 * lines, lots, the wallet: tests/pricingCurrencyRoles.test.ts) and never writes
 * a purchase row (USD design §7.1 G2).
 */
import type { PricingInputRow, SkuInputChain, SupplierCurrency } from '@levonis/pricing/costToPrice';
import type { PricingRuleKind, PricingRuleRow, PricingRuleScope, PricingRuleState, PricingRuleSource } from '@levonis/pricing/ruleResolution';
import type { ShippingProfile } from '@levonis/pricing/skuChannel';
import { fence } from '../operations';
import { newId } from '../crypto';

/** The four input levels (FX-7 adds colour and SKU): product → option → colour → SKU, the most specific wins. */
export type InputScope = 'base' | 'option' | 'color' | 'sku';

/** A `pricing_inputs` row (0181), as stored. Decimals are canonical TEXT. */
export interface StoredInputRow {
  product_id: string;
  scope: 'base' | 'option' | 'color' | 'sku';
  scope_id: string;
  origin: 'SOURCE' | 'MANUAL_OVERRIDE';
  supplier_cost_amount: string | null;
  supplier_cost_delta: string | null;
  supplier_cost_currency: SupplierCurrency | null;
  supplier_input_mode: 'SOURCE_CURRENCY' | 'IQD_CONVERTED' | null;
  original_input_amount: string | null;
  original_input_currency: string | null;
  conversion_rate_snapshot: string | null;
  conversion_fx_version: number | null;
  canonical_supplier_cost_usd: string | null;
  converted_at: string | null;
  shipping_profile: ShippingProfile | null;
  pricing_weight_g: number | null;
  shipping_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  manual_cbm: string | null;
  additional_cost_iqd: number | null;
  unresolved_fields: string;
  source_ref: string;
  version: number;
  updated_at: string;
}

export const INPUT_COLUMNS = [
  'product_id', 'scope', 'scope_id', 'origin', 'supplier_cost_amount', 'supplier_cost_delta', 'supplier_cost_currency',
  'supplier_input_mode', 'original_input_amount', 'original_input_currency', 'conversion_rate_snapshot', 'conversion_fx_version',
  'canonical_supplier_cost_usd', 'converted_at', 'shipping_profile', 'pricing_weight_g', 'shipping_weight_g', 'shipping_length_mm',
  'shipping_width_mm', 'shipping_height_mm', 'manual_cbm', 'additional_cost_iqd', 'unresolved_fields', 'source_ref', 'version', 'updated_at',
] as const satisfies readonly (keyof StoredInputRow)[];

/** A `pricing_rules` row (0181), as stored. */
export interface StoredRuleRow extends PricingRuleRow {
  amount_usd: string | null;
  source: PricingRuleSource;
  legacy_amount_iqd: number | null;
  legacy_usd_iqd_rate: string | null;
  legacy_result_id: string | null;
  updated_at: string;
}

const RULE_COLUMNS = [
  'id', 'kind', 'scope', 'catalog_id', 'product_id', 'scope_id', 'state', 'amount_usd', 'amount_iqd', 'legacy_amount_iqd',
  'legacy_usd_iqd_rate', 'source', 'legacy_result_id', 'version', 'updated_at',
] as const;

export interface PricingStateRow {
  product_id: string;
  mode: 'manual' | 'engine';
  inputs_seq: number;
  write_seq: number;
  /** Set when the owner took the product back to manual pricing (a later save then adopts only when asked). */
  opted_out_at?: string | null;
}

/** Everything the engine stores about one product, read in one snapshot. */
export interface ProductPricingData {
  product_id: string;
  state: PricingStateRow | null;
  inputs: StoredInputRow[];
  rules: StoredRuleRow[];
  config_version: number;
}

/** One product's store, in one batch (one snapshot). */
export async function loadProductPricing(db: D1Database, productId: string): Promise<ProductPricingData> {
  return (await loadProductsPricing(db, [productId])).get(productId)!;
}

/** Several products' stores, in one batch; the global/category rules are read too (they apply to every product). */
export async function loadProductsPricing(db: D1Database, ids: readonly string[]): Promise<Map<string, ProductPricingData>> {
  const unique = [...new Set(ids)];
  const list = JSON.stringify(unique);
  const [state, inputs, rules, control] = await db.batch([
    db.prepare('SELECT product_id, mode, inputs_seq, write_seq, opted_out_at FROM product_pricing_state WHERE product_id IN (SELECT value FROM json_each(?))').bind(list),
    db.prepare(`SELECT ${INPUT_COLUMNS.join(', ')} FROM pricing_inputs WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, scope, scope_id, origin`).bind(list),
    db
      .prepare(`SELECT ${RULE_COLUMNS.join(', ')} FROM pricing_rules WHERE product_id IS NULL OR product_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .bind(list),
    db.prepare('SELECT config_version FROM pricing_engine_control WHERE id = 1'),
  ]);
  const states = ((state as D1Result<PricingStateRow>).results ?? []) as PricingStateRow[];
  const inputRows = ((inputs as D1Result<StoredInputRow>).results ?? []) as StoredInputRow[];
  const ruleRows = ((rules as D1Result<StoredRuleRow>).results ?? []) as StoredRuleRow[];
  const config = Number(((control as D1Result<{ config_version: number }>).results ?? [])[0]?.config_version ?? 0);
  const out = new Map<string, ProductPricingData>();
  for (const id of unique) {
    out.set(id, {
      product_id: id,
      state: states.find((s) => s.product_id === id) ?? null,
      inputs: inputRows.filter((r) => r.product_id === id),
      rules: ruleRows.filter((r) => r.product_id === id || r.product_id === null),
      config_version: config,
    });
  }
  return out;
}

// ------------------------------------------------------------ to E1

function unresolvedOf(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** A stored row as E1 reads it (`supplier_cost_amount` → `supplier_cost`, …). */
export function e1Row(row: Partial<StoredInputRow> | null | undefined): PricingInputRow | null {
  if (!row) return null;
  return {
    supplier_cost: row.supplier_cost_amount ?? null,
    supplier_cost_delta: row.supplier_cost_delta ?? null,
    supplier_currency: row.supplier_cost_currency ?? null,
    shipping_profile: row.shipping_profile ?? null,
    pricing_weight_g: row.pricing_weight_g ?? null,
    shipping_weight_g: row.shipping_weight_g ?? null,
    shipping_length_mm: row.shipping_length_mm ?? null,
    shipping_width_mm: row.shipping_width_mm ?? null,
    shipping_height_mm: row.shipping_height_mm ?? null,
    manual_cbm: row.manual_cbm ?? null,
    additional_cost_iqd: row.additional_cost_iqd ?? null,
    ...(row.origin === 'SOURCE' ? { unresolved_fields: unresolvedOf(row.unresolved_fields) } : {}),
  };
}

const rowAt = (inputs: readonly Partial<StoredInputRow>[], scope: string, scopeId: string, origin: StoredInputRow['origin']) =>
  inputs.find((r) => r.scope === scope && (r.scope_id ?? '') === scopeId && r.origin === origin) ?? null;

/** The input chain of one model (its option value, or the product itself): base, then the model's option. */
export function chainOf(inputs: readonly Partial<StoredInputRow>[], optionId: string): SkuInputChain {
  return chainOfUnit(inputs, { option_value_ids: optionId ? [optionId] : [], color_id: null, combo_key: null });
}

/** What one priced unit is: a model (its option value) or a SKU (its whole selection, its colour, its key). */
export interface UnitSelection {
  option_value_ids: readonly string[];
  color_id: string | null;
  /** The SKU's own key — null for a model, whose SKU level is its option level. */
  combo_key: string | null;
}

const scopeInputs = (inputs: readonly Partial<StoredInputRow>[], scope: string, scopeId: string) => ({
  scope_id: scopeId,
  source: e1Row(rowAt(inputs, scope, scopeId, 'SOURCE')),
  override: e1Row(rowAt(inputs, scope, scopeId, 'MANUAL_OVERRIDE')),
});

/**
 * The input chain of one unit (FX-7, E1's levels): the product, every selected
 * option value (one per group), the colour, and the exact SKU — empty levels
 * inherit, the most specific value wins (a supplier difference adds up).
 */
export function chainOfUnit(inputs: readonly Partial<StoredInputRow>[], unit: UnitSelection): SkuInputChain {
  return {
    base: { source: e1Row(rowAt(inputs, 'base', '', 'SOURCE')), override: e1Row(rowAt(inputs, 'base', '', 'MANUAL_OVERRIDE')) },
    options: unit.option_value_ids.filter(Boolean).map((id) => scopeInputs(inputs, 'option', id)),
    ...(unit.color_id ? { color: scopeInputs(inputs, 'color', unit.color_id) } : {}),
    ...(unit.combo_key ? { sku: scopeInputs(inputs, 'sku', unit.combo_key) } : {}),
  };
}

/** The owner's row (MANUAL_OVERRIDE) of one scope, or null. */
export const ownerRow = (inputs: readonly StoredInputRow[], scope: InputScope, scopeId: string): StoredInputRow | null =>
  inputs.find((r) => r.scope === scope && r.scope_id === (scope === 'base' ? '' : scopeId) && r.origin === 'MANUAL_OVERRIDE') ?? null;

// ------------------------------------------------------------ writes

/** The owner-writable columns of an input row (the IQD snapshot columns are only ever cleared). */
export interface InputFields {
  supplier_cost_amount: string | null;
  supplier_cost_delta: string | null;
  supplier_cost_currency: SupplierCurrency | null;
  shipping_profile: ShippingProfile | null;
  pricing_weight_g: number | null;
  shipping_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  manual_cbm: string | null;
  additional_cost_iqd: number | null;
}

export const INPUT_FIELD_NAMES = [
  'supplier_cost_amount', 'supplier_cost_delta', 'supplier_cost_currency', 'shipping_profile', 'pricing_weight_g', 'shipping_weight_g',
  'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'manual_cbm', 'additional_cost_iqd',
] as const satisfies readonly (keyof InputFields)[];

/**
 * The IQD convenience input's snapshot (FX plan §12; USD design §5.3 row 1):
 * the dinars the owner typed, converted ONCE at save to canonical USD
 * (`supplier_cost_amount`, currency USD) at the effective U of that moment.
 * Server-computed only — a request never carries these values.
 */
export interface IqdSnapshot {
  original_input_amount: string;
  conversion_rate_snapshot: string;
  conversion_fx_version: number;
  converted_at: string;
}

/** A stored row's IQD conversion snapshot, or null (a row priced in its source currency). */
export function storedIqdOf(row: Partial<StoredInputRow> | null | undefined): IqdSnapshot | null {
  if (!row || row.supplier_input_mode !== 'IQD_CONVERTED' || !row.original_input_amount || !row.conversion_rate_snapshot || !row.converted_at) return null;
  return {
    original_input_amount: row.original_input_amount,
    conversion_rate_snapshot: row.conversion_rate_snapshot,
    conversion_fx_version: Number(row.conversion_fx_version ?? 0),
    converted_at: row.converted_at,
  };
}

/** One owner-row write: the fields that change (absent = kept), at one scope. */
export interface InputWrite {
  scope: InputScope;
  scope_id: string;
  existing: StoredInputRow | null;
  set: Partial<InputFields>;
  source_ref: string;
  /** Set when this write converts typed dinars (the supplier cost is then that conversion's USD). */
  iqd?: IqdSnapshot;
}

/** The row an input write leaves, with the supplier-mode columns the 0181 CHECKs demand. */
export function nextInputRow(w: InputWrite): InputFields & { supplier_input_mode: StoredInputRow['supplier_input_mode']; clears_iqd_snapshot: boolean; iqd: IqdSnapshot | null } {
  const base: InputFields = {
    supplier_cost_amount: w.existing?.supplier_cost_amount ?? null,
    supplier_cost_delta: w.existing?.supplier_cost_delta ?? null,
    supplier_cost_currency: w.existing?.supplier_cost_currency ?? null,
    shipping_profile: w.existing?.shipping_profile ?? null,
    pricing_weight_g: w.existing?.pricing_weight_g ?? null,
    shipping_weight_g: w.existing?.shipping_weight_g ?? null,
    shipping_length_mm: w.existing?.shipping_length_mm ?? null,
    shipping_width_mm: w.existing?.shipping_width_mm ?? null,
    shipping_height_mm: w.existing?.shipping_height_mm ?? null,
    manual_cbm: w.existing?.manual_cbm ?? null,
    additional_cost_iqd: w.existing?.additional_cost_iqd ?? null,
  };
  const next = { ...base, ...w.set };
  // An absolute supplier cost replaces a difference at the same scope (CHECK amount XOR delta).
  if (w.set.supplier_cost_amount != null) next.supplier_cost_delta = null;
  const supplierTouched = 'supplier_cost_amount' in w.set || 'supplier_cost_delta' in w.set || 'supplier_cost_currency' in w.set;
  const hasSupplier = next.supplier_cost_amount != null || next.supplier_cost_delta != null;
  const wasConverted = w.existing?.supplier_input_mode === 'IQD_CONVERTED';
  if (w.iqd && hasSupplier) return { ...next, supplier_input_mode: 'IQD_CONVERTED', clears_iqd_snapshot: false, iqd: w.iqd };
  const mode: StoredInputRow['supplier_input_mode'] = !hasSupplier ? null : wasConverted && !supplierTouched ? 'IQD_CONVERTED' : 'SOURCE_CURRENCY';
  return { ...next, supplier_input_mode: mode, clears_iqd_snapshot: wasConverted && mode !== 'IQD_CONVERTED', iqd: null };
}

/** True when a write changes nothing of the stored row. */
export function inputWriteIsNoop(w: InputWrite): boolean {
  if (w.iqd) return false;
  if (!w.existing) return INPUT_FIELD_NAMES.every((k) => w.set[k] == null);
  const next = nextInputRow(w);
  return INPUT_FIELD_NAMES.every((k) => (next[k] ?? null) === (w.existing![k] ?? null)) && next.supplier_input_mode === w.existing.supplier_input_mode;
}

const IQD_COLUMNS = 'original_input_amount, original_input_currency, conversion_rate_snapshot, conversion_fx_version, canonical_supplier_cost_usd, converted_at';

/** D1 binds at most 100 parameters per statement; packed rows stop at 90 (the house margin: mediaRefs.ts DETACH_ROWS_PER_STATEMENT). */
export const PACKED_PARAMS_MAX = 90;

/**
 * Rows of ONE shape as multi-row INSERTs: the same values, bound in the same
 * order, as one statement per row would bind — at most PACKED_PARAMS_MAX bound
 * parameters a statement. Per-row triggers fire per row, exactly as before.
 */
export function packRows(db: D1Database, head: string, row: string, rows: readonly unknown[][]): D1PreparedStatement[] {
  if (!rows.length) return [];
  const width = rows[0].length;
  const marks = (row.match(/\?/g) ?? []).length;
  if (marks !== width || rows.some((r) => r.length !== width)) throw new Error(`packRows: ${marks} placeholders for rows of ${width}`);
  const per = Math.max(1, Math.floor(PACKED_PARAMS_MAX / width));
  const out: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    out.push(db.prepare(`${head} VALUES ${chunk.map(() => row).join(', ')}`).bind(...chunk.flat()));
  }
  return out;
}

/** How a writer lays its new rows out: one statement each (the default) or packed (`packRows`). */
export interface PackOptions {
  pack?: boolean;
}

const INPUT_INSERT_HEAD = (iqd: boolean) =>
  `INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, ${INPUT_FIELD_NAMES.join(', ')}, supplier_input_mode${iqd ? `, ${IQD_COLUMNS}` : ''}, source_ref, version, updated_by, updated_at)`;
const INPUT_INSERT_ROW = (iqd: boolean) => `(?, ?, ?, 'MANUAL_OVERRIDE', ${INPUT_FIELD_NAMES.map(() => '?').join(', ')}, ?${iqd ? ", ?, 'IQD', ?, ?, ?, ?" : ''}, ?, 1, ?, ?)`;

export function inputStatements(db: D1Database, productId: string, writes: readonly InputWrite[], actor: string, now: string, opts: PackOptions = {}): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const plain: unknown[][] = [];
  const converted: unknown[][] = [];
  for (const w of writes) {
    if (inputWriteIsNoop(w)) continue;
    const next = nextInputRow(w);
    const scopeId = w.scope === 'base' ? '' : w.scope_id;
    const values = INPUT_FIELD_NAMES.map((k) => next[k] ?? null);
    // A conversion stores its snapshot beside the canonical USD (0181: canonical = supplier_cost_amount).
    const iqd = next.iqd;
    const iqdValues = iqd ? [iqd.original_input_amount, iqd.conversion_rate_snapshot, iqd.conversion_fx_version, next.supplier_cost_amount, iqd.converted_at] : [];
    if (!w.existing) {
      const bound = [productId, w.scope, scopeId, ...values, next.supplier_input_mode, ...iqdValues, w.source_ref, actor, now];
      if (opts.pack) (iqd ? converted : plain).push(bound);
      else out.push(db.prepare(`${INPUT_INSERT_HEAD(!!iqd)}\n             VALUES ${INPUT_INSERT_ROW(!!iqd)}`).bind(...bound));
      continue;
    }
    const snapshot = iqd
      ? ", original_input_amount = ?, original_input_currency = 'IQD', conversion_rate_snapshot = ?, conversion_fx_version = ?, canonical_supplier_cost_usd = ?, converted_at = ?"
      : next.clears_iqd_snapshot
        ? ', original_input_amount = NULL, original_input_currency = NULL, conversion_rate_snapshot = NULL, conversion_fx_version = NULL, canonical_supplier_cost_usd = NULL, converted_at = NULL'
        : '';
    out.push(
      db
        .prepare(
          `UPDATE pricing_inputs SET ${INPUT_FIELD_NAMES.map((k) => `${k} = ?`).join(', ')}, supplier_input_mode = ?${snapshot},
                  source_ref = ?, version = version + 1, updated_by = ?, updated_at = ?
            WHERE product_id = ? AND scope = ? AND scope_id = ? AND origin = 'MANUAL_OVERRIDE' AND version = ?`
        )
        .bind(...values, next.supplier_input_mode, ...iqdValues, w.source_ref, actor, now, productId, w.scope, scopeId, w.existing.version)
    );
  }
  return [...out, ...packRows(db, INPUT_INSERT_HEAD(false), INPUT_INSERT_ROW(false), plain), ...packRows(db, INPUT_INSERT_HEAD(true), INPUT_INSERT_ROW(true), converted)];
}

/** One rule write: the row a (kind, scope, scope_id) target is left with. */
/** The rule levels the owner writes per product (FX-7 adds colour and SKU); global and category are refused. */
export type ProductRuleScope = Extract<PricingRuleScope, 'product' | 'option' | 'color' | 'sku'>;

export interface RuleWrite {
  kind: PricingRuleKind;
  scope: ProductRuleScope;
  scope_id: string;
  existing: StoredRuleRow | null;
  /** The id a NEW row takes (assigned up front so the engine's stored results can name it); absent = minted at write. */
  new_id?: string;
  next: {
    state: PricingRuleState;
    amount_usd: string | null;
    amount_iqd: number | null;
    source: PricingRuleSource;
    legacy_result_id: string | null;
  };
}

export function ruleWriteIsNoop(w: RuleWrite): boolean {
  const e = w.existing;
  if (!e) return w.next.state === 'INHERIT';
  return (
    e.state === w.next.state &&
    (e.amount_usd ?? null) === w.next.amount_usd &&
    (e.amount_iqd ?? null) === w.next.amount_iqd &&
    e.source === w.next.source &&
    (e.legacy_result_id ?? null) === w.next.legacy_result_id
  );
}

const RULE_INSERT_HEAD =
  'INSERT INTO pricing_rules (id, kind, scope, catalog_id, product_id, scope_id, state, amount_usd, amount_iqd, source, legacy_result_id, version, updated_by, updated_at)';
const RULE_INSERT_ROW = '(?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)';

export function ruleStatements(db: D1Database, productId: string, writes: readonly RuleWrite[], actor: string, now: string, opts: PackOptions = {}): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const fresh: unknown[][] = [];
  for (const w of writes) {
    if (ruleWriteIsNoop(w)) continue;
    const scopeId = w.scope === 'product' ? '' : w.scope_id;
    if (!w.existing) {
      const bound = [w.new_id ?? newId('prule'), w.kind, w.scope, productId, scopeId, w.next.state, w.next.amount_usd, w.next.amount_iqd, w.next.source, w.next.legacy_result_id, actor, now];
      if (opts.pack) fresh.push(bound);
      else out.push(db.prepare(`${RULE_INSERT_HEAD}\n             VALUES ${RULE_INSERT_ROW}`).bind(...bound));
      continue;
    }
    // A converted legacy figure belongs to its migrated row only (0181 CHECK); an owner row drops it.
    out.push(
      db
        .prepare(
          `UPDATE pricing_rules SET state = ?, amount_usd = ?, amount_iqd = ?, source = ?, legacy_result_id = ?,
                  legacy_amount_iqd = CASE WHEN ? = 'LEGACY_MIGRATION' THEN legacy_amount_iqd ELSE NULL END,
                  legacy_usd_iqd_rate = CASE WHEN ? = 'LEGACY_MIGRATION' THEN legacy_usd_iqd_rate ELSE NULL END,
                  version = version + 1, updated_by = ?, updated_at = ?
            WHERE id = ? AND version = ?`
        )
        .bind(w.next.state, w.next.amount_usd, w.next.amount_iqd, w.next.source, w.next.legacy_result_id, w.next.source, w.next.source, actor, now, w.existing.id, w.existing.version)
    );
  }
  return [...out, ...packRows(db, RULE_INSERT_HEAD, RULE_INSERT_ROW, fresh)];
}

/** The existing row of a rule target, or null. */
export const ruleAt = (rules: readonly StoredRuleRow[], productId: string, kind: PricingRuleKind, scope: ProductRuleScope, scopeId: string): StoredRuleRow | null =>
  rules.find((r) => r.product_id === productId && r.kind === kind && r.scope === scope && r.scope_id === (scope === 'product' ? '' : scopeId)) ?? null;

/**
 * The head of every write batch (see the file header): the fences on what was
 * read, the owner-input token, and the state row when there is none. The tail
 * (`batchTail`) deletes the token.
 */
export function batchHead(db: D1Database, data: ProductPricingData, now: string): D1PreparedStatement[] {
  const pid = data.product_id;
  return [
    ...(data.state
      ? fence(db, 'EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ? AND inputs_seq = ? AND write_seq = ? AND mode = ?)', [pid, data.state.inputs_seq, data.state.write_seq, data.state.mode])
      : fence(db, 'NOT EXISTS(SELECT 1 FROM product_pricing_state WHERE product_id = ?)', [pid])),
    ...fence(db, 'EXISTS(SELECT 1 FROM pricing_engine_control WHERE id = 1 AND config_version = ?)', [data.config_version]),
    db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').bind(`pricing-input-owner:${pid}`),
    ...(data.state ? [] : [db.prepare("INSERT INTO product_pricing_state (product_id, mode, updated_at) VALUES (?, 'manual', ?)").bind(pid, now)]),
  ];
}

export function batchTail(db: D1Database, productId: string): D1PreparedStatement[] {
  return [db.prepare('DELETE FROM ops_guards WHERE id = ?').bind(`pricing-input-owner:${productId}`)];
}

/** One `pricing_audit` row as a writer hands it over (the values live HERE, never in audit_log). */
export interface PricingAuditRow {
  /** Set when another row of the batch names this one (product_pricing_state.activation_audit_id). */
  id?: string;
  /** 'run': one automatic repricing run (FX-5), product_id null, counts only. */
  entity: 'input' | 'rule' | 'product_write' | 'sku_price' | 'engine_mode' | 'run';
  entity_key: string;
  product_id: string | null;
  action:
    | 'input_from_purchase'
    | 'rule_set'
    | 'legacy_accept'
    | 'update'
    | 'engine_entry'
    | 'reprice_owner'
    | 'rule_convert'
    | 'engine_exit'
    | 'reprice_auto'
    | 'run_finished';
  before?: unknown;
  after?: unknown;
  summary?: Record<string, unknown>;
  idempotency_key?: string | null;
  actor: string;
  now: string;
}

const AUDIT_INSERT =
  'INSERT INTO pricing_audit (id, entity, entity_key, product_id, action, pricing_before_json, pricing_after_json, summary_json, idempotency_key, actor_id, created_at)';
const AUDIT_ROW = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/** The eleven values one `pricing_audit` row binds, in column order. */
export function auditValues(row: PricingAuditRow): unknown[] {
  return [
    row.id ?? newId('paud'),
    row.entity,
    row.entity_key,
    row.product_id,
    row.action,
    row.before === undefined ? null : JSON.stringify(row.before),
    row.after === undefined ? null : JSON.stringify(row.after),
    JSON.stringify(row.summary ?? {}),
    row.idempotency_key ?? null,
    row.actor,
    row.now,
  ];
}

/** One `pricing_audit` row (the values live HERE, never in audit_log). */
export function pricingAuditStatement(db: D1Database, row: PricingAuditRow): D1PreparedStatement {
  return db.prepare(`${AUDIT_INSERT}\n       VALUES ${AUDIT_ROW}`).bind(...auditValues(row));
}

/** Many `pricing_audit` rows, packed (8 a statement): the same rows, the same values, as one statement each would write. */
export function pricingAuditStatements(db: D1Database, rows: readonly PricingAuditRow[]): D1PreparedStatement[] {
  return packRows(db, AUDIT_INSERT, AUDIT_ROW, rows.map(auditValues));
}

/** The stored values of an input row, for the audit (owner-only table), with an IQD conversion's snapshot. */
export function inputImage(row: (Partial<InputFields> & { iqd?: IqdSnapshot | null }) | null): (Partial<InputFields> & { iqd?: IqdSnapshot }) | null {
  if (!row) return null;
  const out: Partial<InputFields> & { iqd?: IqdSnapshot } = {};
  for (const k of INPUT_FIELD_NAMES) if (row[k] != null) (out as Record<string, unknown>)[k] = row[k];
  if (row.iqd) out.iqd = { ...row.iqd };
  return out;
}

export function ruleImage(r: { state: string; amount_usd: string | null; amount_iqd: number | null; source: string } | null) {
  return r ? { state: r.state, amount_usd: r.amount_usd ?? null, amount_iqd: r.amount_iqd ?? null, source: r.source } : null;
}
