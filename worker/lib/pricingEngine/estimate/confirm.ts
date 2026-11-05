/**
 * «تأكيد السعر» — REMOVING THE LABEL, AND THE OWNER'S PER-PRODUCT SETTINGS
 * (docs/SMART_PRICING.md §4.9, §3.8, §7; owner decision D2; DECISIONS rows
 * 278–279).
 *
 * POST /estimates/products/:id/confirm {version, accept_flags, combo_keys?}:
 *   1. every targeted SKU's measures are resolved as the engine resolves them
 *      (`resolveSkuInputs` over the chain, the model's and colour's own
 *      packages included): a measure is DEFAULTED when it resolves from the
 *      base field `applied_wire_json` records as `type_default` and the store
 *      still holds that very value. Any defaulted SKU refuses the whole call
 *      with 409 PRICE_ESTIMATE_DEFAULT_MEASURES — no flag overrides it
 *      (owner decision D2 with requirement 4); `waiting_on_apply: true` when
 *      the real measures of every one refused wait on the refresh's apply;
 *   2. every open SOFT flag of the targeted SKUs must be named in
 *      `accept_flags`, else 409 PRICE_ESTIMATE_FLAGS_OPEN with the codes:
 *      the soft flags of the APPLIED estimate (`flags_json`, whose soft and
 *      hard entries a later compute leaves alone — it replaces only the
 *      blocking and information ones), and what the catalogue says of those
 *      SKUs today (a capture now older than the type allows, an item gone
 *      from the newest capture, out of stock), read again here because time
 *      and new captures move them after the apply;
 *   3. the write: the WHOLE product (no `combo_keys`, or every sellable SKU) —
 *      the bookkeeping `confirmed` on real measures FIRST, then
 *      `products.price_estimate = 0` (trigger T2 lets it through only after
 *      that), the firm rows deleted, the audit, the pages purged; SOME SKUs —
 *      they become firm (`price_estimate_firm_skus`, trigger T4: only on a
 *      labelled product), the label stays for the others.
 * Each write is fenced on the bookkeeping version the owner read, and on the
 * product's pricing sequence as this call read it (the measures it judged).
 *
 * THE OWNER'S STATEMENT (§4.9 step 0; DECISIONS row 292): `real_measures:
 * {weight_g?, box_mm?}` — sent only after the owner ticked «هذه القياسات صحيحة
 * لهذا المنتج» under the very values the estimate is priced from — makes those
 * type-default measures the product's real ones, in the same batch as the
 * confirmation: the product's own package takes them where it is empty
 * («الأبعاد والوزن», a public spec), the base records are re-sourced from
 * `type_default` to `product_package`, and the lines, flags and measure basis
 * become what the next compute and apply write. No price moves: the base
 * pricing row is untouched and V2 never reads the product-level package. A
 * statement the store no longer matches is PRICING_CHANGED; one that cannot be
 * taken (the type's CBM, a package that differs or is partial, a weight lighter
 * than the product's own net weight) is refused with
 * PRICE_ESTIMATE_DEFAULT_MEASURES and its `reason`. Without the field the call
 * is exactly as before, but that a whole confirmation drops the default-measure
 * codes from the row's flags (none is left: step 1 proved it).
 *
 * `confirmGateOf` answers the same judgement before anything is sent
 * (`GET /estimates/products/:id` `confirm_gate`): the sheet's live hold.
 *
 * PUT /estimates/products/:id {version, state?, type_key?, sourcing_override?, route_override?}: pause
 * (`state: 'paused'` — refreshes stop, the label stays) and resume (`state: 'active'`: back to `estimated`
 * when applied, else `candidate`); the owner's type (type_source 'owner' — this is how a merged or
 * owner-built product is enrolled) and the sourcing and route overrides, which trigger T5 holds to the type's
 * rules (409 PRICE_ESTIMATE_TYPE_RULE).
 *
 * OWNER-ONLY: behind requireCostRead; every write after assertCostWrite.
 */
import { notFound } from '../../http';
import { auditStatements } from '../../audit';
import { fence, isFenceMiss } from '../../operations';
import { isEstimateRow } from '../../priceEstimateLabel';
import { inputInvalid } from '../whatIf';
import { loadProducts } from '../load';
import { loadProductsPricing } from '../store';
import { supplierPricesFor } from '../../supplierPrices/store';
import {
  attestBaseMeasures,
  lineMeasureSource,
  measureBasisOf,
  measureGate,
  parseAppliedWire,
  serializeAppliedWire,
  skuMeasureSources,
  type AppliedWire,
  type EstimateMeasureSource,
  type EstimateSku,
  type MeasureStatement,
  type StatedMeasures,
} from '@levonis/pricing/estimateInputs';
import { MAX_BOX_MM, MAX_WEIGHT_G } from '@levonis/pricing/costToPrice';
import { ESTIMATE_HARD_FLAGS, ESTIMATE_SOFT_FLAGS } from '@levonis/contracts/priceEstimates';
import { CATALOGUE_NOW_FLAGS, lineFlags, refreshStateOf } from './compute';
import { estimateSkusOf } from './merge';
import { estimateRefusal, loadTypes, pricingChanged, strictObject, versionOf } from './control';
import { effectiveRouting, estimateRowOf, isRoute, isSourcing, parseFlags, type PlanFlag, type ProductEstimateRow } from './types';

const PRODUCT_ID = /^[A-Za-z0-9_:.-]{1,80}$/;
const SOFT = new Set<string>(ESTIMATE_SOFT_FLAGS);
const MAX_KEYS = 240;
/** The soft codes the catalogue moves after an apply (time, a newer capture): read again at confirm. */
const CATALOGUE_NOW = new Set<string>(CATALOGUE_NOW_FLAGS);

async function estimateRow(db: D1Database, pid: string): Promise<ProductEstimateRow | null> {
  const r = await db.prepare('SELECT * FROM product_price_estimates WHERE product_id = ?').bind(pid).first<Record<string, unknown>>();
  return r ? estimateRowOf(r) : null;
}

/** What the catalogue says of these SKUs today (§3.7, as compute reads it), its moving soft codes only. */
async function catalogueFlagsNow(db: D1Database, pid: string, estimate: ProductEstimateRow, keys: readonly string[], today: string): Promise<PlanFlag[]> {
  const type = (await loadTypes(db)).find((t) => t.key === estimate.type_key);
  if (!type || !keys.length) return [];
  const routing = effectiveRouting(type, estimate);
  const request = { product_id: pid, combo_keys: keys, sourcing: routing.sourcing, us_reference_allowed: routing.us_reference_allowed, stale_after_days: type.stale_after_days };
  const prices = (await supplierPricesFor(db, [request], { today })).get(pid);
  const out: PlanFlag[] = [];
  for (const k of keys) for (const code of prices?.get(k)?.flags ?? []) if (CATALOGUE_NOW.has(code)) out.push({ code, combo_keys: [k] });
  return out;
}

/** A line's measure sources with no type default left once its refresh is applied (a line names the weaker of its two). */
const REAL_AFTER_APPLY = new Set<string>(['product', 'owner', 'colour', 'model']);

/**
 * Words only (step 1 decides): the real measures of every option refused wait on the refresh's apply — the latest
 * line of each is on them, no pricing row of the owner's was written since, and «التحديث» lists the product — so
 * that apply is the cure, not new measures. A failed read answers no.
 */
async function waitsOnApply(db: D1Database, pid: string, keys: readonly string[]): Promise<boolean> {
  return keys.length > 0 && (await waitingKeysOf(db, pid, keys)).length === keys.length;
}

/** The options among `keys` whose real measures wait on the refresh's apply (`waitsOnApply`, option by option); none on a failed read. */
async function waitingKeysOf(db: D1Database, pid: string, keys: readonly string[]): Promise<string[]> {
  try {
    const [{ results }, refresh] = await Promise.all([
      db.prepare('SELECT combo_key, measure_source FROM price_estimate_lines WHERE product_id = ?').bind(pid).all<{ combo_key: string; measure_source: string }>(),
      refreshStateOf(db, pid),
    ]);
    if (!refresh.listed || refresh.stale) return [];
    const lines = results ?? [];
    return keys.filter((k) => {
      const own = lines.filter((l) => l.combo_key === k);
      return own.length > 0 && own.every((l) => REAL_AFTER_APPLY.has(String(l.measure_source)));
    });
  } catch {
    return [];
  }
}

/* ------------------------------------------------- the owner's statement of real measures -- */

/** `real_measures` as the body carries it: one or both of a whole weight and a whole box [L, W, H], each within the form's limits. */
function statedMeasuresOf(raw: unknown): StatedMeasures {
  const body = strictObject(raw, ['weight_g', 'box_mm'], 'real_measures');
  const whole = (v: unknown, max: number) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;
  const out: StatedMeasures = {};
  if (body.weight_g !== undefined) {
    if (!whole(body.weight_g, MAX_WEIGHT_G)) throw inputInvalid('real_measures');
    out.weight_g = body.weight_g as number;
  }
  if (body.box_mm !== undefined) {
    const box = body.box_mm;
    if (!Array.isArray(box) || box.length !== 3 || !box.every((a) => whole(a, MAX_BOX_MM))) throw inputInvalid('real_measures');
    out.box_mm = [box[0], box[1], box[2]] as [number, number, number];
  }
  if (out.weight_g === undefined && out.box_mm === undefined) throw inputInvalid('real_measures');
  return out;
}

const HARD = new Set<string>(ESTIMATE_HARD_FLAGS);
/** The default-measure code of each measure (§4.6). */
const HARD_OF = { weight: 'EST_DEFAULT_WEIGHT', cbm: 'EST_DEFAULT_BOX' } as const;

/**
 * The row's stored flags with each default-measure entry kept only for the SKUs still on that default (`still`,
 * by code), as the next apply writes them: an entry with its options loses the others (gone when none is left),
 * a bare or counted one stays while any SKU is (a count then says how many). Every other entry, and the text when
 * nothing changes, is kept exactly as stored.
 */
function flagsWithDefaultsOf(flagsJson: string, still: Readonly<Record<string, ReadonlySet<string>>>): string {
  let doc: unknown;
  try {
    doc = JSON.parse(flagsJson);
  } catch {
    return flagsJson;
  }
  if (!Array.isArray(doc)) return flagsJson;
  let changed = false;
  const out: unknown[] = [];
  for (const entry of doc) {
    const o = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    const code = typeof entry === 'string' ? entry : typeof o?.code === 'string' ? o.code : null;
    const keep = code !== null && HARD.has(code) ? still[code] : undefined;
    if (!keep) {
      out.push(entry);
      continue;
    }
    if (o && Array.isArray(o.combo_keys)) {
      const left = (o.combo_keys as unknown[]).filter((k): k is string => typeof k === 'string' && keep.has(k));
      if (left.length === o.combo_keys.length) out.push(entry);
      else {
        changed = true;
        if (left.length) out.push({ ...o, combo_keys: left });
      }
    } else if (!keep.size) changed = true;
    else if (o && typeof o.count === 'number' && o.count !== keep.size) {
      changed = true;
      out.push({ ...o, count: keep.size });
    } else out.push(entry);
  }
  return changed ? JSON.stringify(out) : flagsJson;
}

/** A whole confirmation leaves no default measure (step 1 proved it): the row's default-measure entries go, so the banner never shows «وزن افتراضي» on a confirmed product. */
const flagsWithoutDefaults = (flagsJson: string): string => flagsWithDefaultsOf(flagsJson, { EST_DEFAULT_WEIGHT: new Set(), EST_DEFAULT_BOX: new Set() });

/**
 * A line's flags with its default-measure codes as `sources` say and the line's other codes kept: sorted as the
 * planner sorts a SKU's codes, and within the column through compute's own `lineFlags` — what the next compute writes.
 */
function lineFlagsOf(flags: readonly string[], sources: { weight: EstimateMeasureSource; cbm: EstimateMeasureSource }): string[] {
  const codes = new Set(flags.filter((f) => !HARD.has(f)));
  if (sources.weight === 'type_default') codes.add(HARD_OF.weight);
  if (sources.cbm === 'type_default') codes.add(HARD_OF.cbm);
  return lineFlags([...codes].sort());
}

const lineFlagsList = (raw: unknown): string[] => parseFlags(raw).map((f) => f.code);

/**
 * The statement's writes (§4.9 step 0), laid after the call's two fences and before the confirmation: the
 * package where it is empty (the conditional UPDATE of `catalogImport/packageMeasures.ts`, the product's version
 * moved so an open form saves no stale copy) and a fence that it now holds the stated values; the record, the
 * row's default-measure flags and its measure basis; the lines of every SKU the re-recorded measures make real —
 * each exactly what the next compute and apply write; and the audit (names only).
 */
async function statementStatements(
  db: D1Database,
  pid: string,
  actor: string,
  at: string,
  taken: Extract<MeasureStatement, { ok: true }>,
  stored: Parameters<typeof skuMeasureSources>[0],
  skus: readonly EstimateSku[],
  before: AppliedWire | null,
  flagsJson: string
): Promise<D1PreparedStatement[]> {
  const after = taken.applied;
  const was = new Map(skus.map((s) => [s.combo_key, skuMeasureSources(stored, s, before)] as const));
  const now = new Map(skus.map((s) => [s.combo_key, skuMeasureSources(stored, s, after)] as const));
  const still = {
    [HARD_OF.weight]: new Set(skus.filter((s) => now.get(s.combo_key)!.weight === 'type_default').map((s) => s.combo_key)),
    [HARD_OF.cbm]: new Set(skus.filter((s) => now.get(s.combo_key)!.cbm === 'type_default').map((s) => s.combo_key)),
  };
  const moved = skus
    .map((s) => s.combo_key)
    .filter((k) => was.get(k)!.weight !== now.get(k)!.weight || was.get(k)!.cbm !== now.get(k)!.cbm);
  const { results } = await db
    .prepare('SELECT combo_key, channel, flags_json FROM price_estimate_lines WHERE product_id = ?')
    .bind(pid)
    .all<{ combo_key: string; channel: string; flags_json: string }>();
  const lines = (results ?? [])
    .filter((l) => moved.includes(String(l.combo_key)))
    .map((l) => {
      const m = now.get(String(l.combo_key))!;
      return { c: String(l.combo_key), ch: String(l.channel), m: lineMeasureSource(m.weight, m.cbm), f: lineFlagsOf(lineFlagsList(l.flags_json), m) };
    });
  const pkg = taken.package;
  const written = [...(pkg.weight_g !== null ? ['package_weight_g'] : []), ...(pkg.box ? ['package_depth_mm', 'package_width_mm', 'package_height_mm'] : [])];
  const weight = taken.fields.includes('shipping_weight_g') ? (after.inputs.find((f) => f.scope === 'base' && f.field === 'shipping_weight_g')!.value as number) : null;
  const box = taken.fields.includes('shipping_box') ? (after.inputs.find((f) => f.scope === 'base' && f.field === 'shipping_box')!.value as readonly [number, number, number]) : null;
  const audit = await auditStatements(db, actor, 'price_estimate.measures_attested', pid, { product_id: pid, fields: [...taken.fields], package: written, skus: moved.length });
  const LINE = `json_each(?2) j WHERE json_extract(j.value, '$.c') = price_estimate_lines.combo_key AND json_extract(j.value, '$.ch') = price_estimate_lines.channel`;
  return [
    ...(pkg.weight_g !== null
      ? [db.prepare('UPDATE products SET package_weight_g = ?2, updated_at = ?3 WHERE id = ?1 AND COALESCE(package_weight_g, 0) <= 0').bind(pid, pkg.weight_g, at)]
      : []),
    ...(weight !== null ? fence(db, 'EXISTS (SELECT 1 FROM products WHERE id = ? AND package_weight_g = ?)', [pid, weight]) : []),
    ...(pkg.box
      ? [
          // [L, W, H] → depth, width, height, as the estimator reads the package back (`productPackageOf`).
          db
            .prepare(
              `UPDATE products SET package_depth_mm = ?2, package_width_mm = ?3, package_height_mm = ?4, updated_at = ?5
                WHERE id = ?1 AND COALESCE(package_depth_mm, 0) <= 0 AND COALESCE(package_width_mm, 0) <= 0 AND COALESCE(package_height_mm, 0) <= 0`
            )
            .bind(pid, pkg.box[0], pkg.box[1], pkg.box[2], at),
        ]
      : []),
    ...(box !== null
      ? fence(db, 'EXISTS (SELECT 1 FROM products WHERE id = ? AND package_depth_mm = ? AND package_width_mm = ? AND package_height_mm = ?)', [pid, box[0], box[1], box[2]])
      : []),
    db
      .prepare('UPDATE product_price_estimates SET applied_wire_json = ?, flags_json = ?, measure_basis = ? WHERE product_id = ?')
      .bind(serializeAppliedWire(after), flagsWithDefaultsOf(flagsJson, still), measureBasisOf([...now.values()]), pid),
    ...(lines.length
      ? [
          db
            .prepare(
              `UPDATE price_estimate_lines
                  SET measure_source = (SELECT json_extract(j.value, '$.m') FROM ${LINE}),
                      flags_json = (SELECT json(json_extract(j.value, '$.f')) FROM ${LINE})
                WHERE product_id = ?1 AND EXISTS (SELECT 1 FROM ${LINE})`
            )
            .bind(pid, JSON.stringify(lines)),
        ]
      : []),
    ...audit.statements,
  ];
}

export interface ConfirmAnswer {
  product_id: string;
  /** 'whole': the label is gone; 'skus': the named SKUs are firm, the label stays for the others. */
  confirmed: 'whole' | 'skus';
  firm: string[];
  version: number;
}

/** POST /estimates/products/:id/confirm (see the file header). Answers what was confirmed; the route purges. */
export async function confirmEstimate(db: D1Database, pid: string, raw: unknown, actor: string, now: Date): Promise<ConfirmAnswer> {
  if (!PRODUCT_ID.test(pid)) throw notFound();
  const body = strictObject(raw, ['version', 'accept_flags', 'combo_keys', 'real_measures']);
  const version = versionOf(body.version);
  const accept = body.accept_flags;
  if (!Array.isArray(accept) || accept.length > 40 || !accept.every((f) => typeof f === 'string' && /^[A-Z_]{3,60}$/.test(f))) throw inputInvalid('accept_flags');
  const accepted = new Set(accept as string[]);
  const stated = body.real_measures === undefined ? null : statedMeasuresOf(body.real_measures);

  const loaded = (await loadProducts(db, [pid])).get(pid);
  if (!loaded) throw notFound();
  const estimate = await estimateRow(db, pid);
  if (!estimate || estimate.state !== 'estimated' || !isEstimateRow(loaded.row)) throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { state: estimate?.state ?? null });
  if (estimate.version !== version) throw pricingChanged();

  const skus = estimateSkusOf({ loaded });
  if (!skus) throw inputInvalid('combo_keys');
  const sellable = new Set(skus.map((s) => s.combo_key));
  let targeted = skus;
  if (body.combo_keys !== undefined) {
    const keys = body.combo_keys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS || !keys.every((k) => typeof k === 'string' && sellable.has(k)) || new Set(keys).size !== keys.length) {
      throw inputInvalid('combo_keys');
    }
    const named = new Set(keys as string[]);
    targeted = skus.filter((s) => named.has(s.combo_key));
  }
  const whole = targeted.length === skus.length;

  // 1. The measures, as the engine resolves them now (D2: never with a default left).
  const stored = (await loadProductsPricing(db, [pid])).get(pid)!;
  const recorded = parseAppliedWire(estimate.applied_wire_json);
  const defaultedUnder = (wire: AppliedWire | null) =>
    targeted
      .filter((s) => {
        const m = skuMeasureSources(stored.inputs, s, wire);
        return m.weight === 'type_default' || m.cbm === 'type_default';
      })
      .map((s) => s.combo_key)
      .sort();
  // 0. The owner's statement that the values shown are this product's real measures (row 292): judged against the
  // store before anything else, and step 1 then reads the measures as the statement leaves them.
  let taken: Extract<MeasureStatement, { ok: true }> | null = null;
  if (stated) {
    const statement = attestBaseMeasures(stored.inputs, recorded, loaded.doc.dimensions, stated);
    if (!statement.ok) {
      if (statement.reason === 'changed') throw pricingChanged();
      const keys = defaultedUnder(recorded);
      const waiting = keys.length ? await waitsOnApply(db, pid, keys) : false;
      throw estimateRefusal('PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: keys, reason: statement.reason, ...(waiting ? { waiting_on_apply: true } : {}) });
    }
    taken = statement;
  }
  const applied = taken ? taken.applied : recorded;
  const defaulted = defaultedUnder(applied);
  if (defaulted.length) {
    const waiting = await waitsOnApply(db, pid, defaulted);
    throw estimateRefusal('PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: defaulted, ...(waiting ? { waiting_on_apply: true } : {}) });
  }

  // 2. Every open soft flag of the targeted SKUs, accepted by name: the applied estimate's, and the catalogue's today.
  const targetedKeys = new Set(targeted.map((s) => s.combo_key));
  const catalogue = await catalogueFlagsNow(db, pid, estimate, [...targetedKeys], now.toISOString().slice(0, 10));
  const open = [...parseFlags(estimate.flags_json), ...catalogue]
    .filter((f) => SOFT.has(f.code) && (!f.combo_keys?.length || f.combo_keys.some((k) => targetedKeys.has(k))))
    .map((f) => f.code);
  const unaccepted = [...new Set(open)].filter((code) => !accepted.has(code)).sort();
  if (unaccepted.length) throw estimateRefusal('PRICE_ESTIMATE_FLAGS_OPEN', { flags: unaccepted });

  // 3. The write, fenced on the version read and on the pricing sequence the measures were judged at.
  const at = now.toISOString();
  const state = stored.state;
  const seqFence = state
    ? fence(db, 'EXISTS (SELECT 1 FROM product_pricing_state WHERE product_id = ? AND inputs_seq = ? AND write_seq = ?)', [pid, state.inputs_seq, state.write_seq])
    : fence(db, 'NOT EXISTS (SELECT 1 FROM product_pricing_state WHERE product_id = ?)', [pid]);
  const firm = whole ? [] : [...targetedKeys].sort();
  const audit = await auditStatements(db, actor, 'price_estimate.confirmed', pid, {
    product_id: pid,
    whole,
    skus: targeted.length,
    accepted_flags: [...accepted].filter((f) => open.includes(f)).sort(),
    ...(taken ? { measures_attested: true } : {}),
  });
  const statements: D1PreparedStatement[] = [
    ...fence(db, "EXISTS (SELECT 1 FROM product_price_estimates WHERE product_id = ? AND version = ? AND state = 'estimated')", [pid, version]),
    ...seqFence,
    ...(taken ? await statementStatements(db, pid, actor, at, taken, stored.inputs, skus, recorded, estimate.flags_json) : []),
    ...(whole
      ? [
          // The confirmation FIRST (trigger T2 reads it), then the label. No default measure is left (step 1), so
          // none stays on the row's flags either.
          db
            .prepare(
              `UPDATE product_price_estimates SET state = 'confirmed', measure_basis = 'real', flags_json = ?, confirmed_at = ?, confirmed_by = ?,
                      version = version + 1, updated_by = ?, updated_at = ? WHERE product_id = ?`
            )
            .bind(flagsWithoutDefaults(estimate.flags_json), at, actor, actor, at, pid),
          db.prepare('UPDATE products SET price_estimate = 0 WHERE id = ? AND price_estimate = 1').bind(pid),
          db.prepare('DELETE FROM price_estimate_firm_skus WHERE product_id = ?').bind(pid),
        ]
      : [
          db
            .prepare(
              `INSERT OR IGNORE INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at)
               SELECT ?1, value, ?2, ?3 FROM json_each(?4) WHERE 1`
            )
            .bind(pid, actor, at, JSON.stringify(firm)),
          db.prepare('UPDATE product_price_estimates SET version = version + 1, updated_by = ?, updated_at = ? WHERE product_id = ?').bind(actor, at, pid),
        ]),
    ...audit.statements,
  ];
  try {
    await db.batch(statements);
  } catch (e) {
    if (isFenceMiss(e)) throw pricingChanged();
    const msg = e instanceof Error ? e.message : String(e);
    if (/PRICE_ESTIMATE_LABEL_CLEAR_REFUSED/.test(msg)) throw estimateRefusal('PRICE_ESTIMATE_DEFAULT_MEASURES', { combo_keys: [] });
    if (/PRICE_ESTIMATE_FIRM_UNLABELLED/.test(msg)) throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { state: 'confirmed' });
    // A catalogue import's guard (0195 on the package, 0218 on the bookkeeping): the statement waits for it, said in words.
    if (taken && /IMPORT_FINANCIAL_WRITE_REFUSED/.test(msg)) throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { flags: ['EST_IMPORT_RUNNING'] });
    throw e;
  }
  return { product_id: pid, confirmed: whole ? 'whole' : 'skus', firm, version: version + 1 };
}

/* ------------------------------------------------------------ the live gate -- */

/** `GET /estimates/products/:id` `confirm_gate`: §4.9's judgement of the measures as it stands now. */
export interface ConfirmGate {
  /** The SKUs step 1 refuses now, in key order (the sheet holds the options it confirms among them). */
  defaulted: string[];
  /** The refusal of the whole product would carry `waiting_on_apply` (its cure is the refresh's apply). */
  waiting_on_apply: boolean;
  /** The defaulted SKUs whose real measures wait on that apply, option by option (a refusal of those alone would say so). */
  waiting_keys: string[];
  /** The statement on offer (§4.9 step 0): the values those SKUs are priced from, and the SKUs it makes real. */
  real_measures: { weight_g: number | null; box_mm: [number, number, number] | null; combo_keys: string[] } | null;
  /** Why the other defaulted SKUs cannot be stated real. */
  blocked: 'type_cbm' | 'package_differs' | 'package_partial' | 'below_net' | null;
}

/**
 * THE SHEET'S LIVE HOLD (§4.9): what the confirmation asks of the measures now, from the reads step 1 makes — the
 * store, the record, the product's package — and the words of its refusal (`waitsOnApply`), so the sheet holds
 * exactly what the server refuses and offers the statement the server takes. Null for a product that is not
 * estimated, a grid that overflows, or any failed read (the sheet then falls back to the latest lines).
 */
export async function confirmGateOf(db: D1Database, pid: string): Promise<ConfirmGate | null> {
  try {
    const [loaded, estimate, stored] = await Promise.all([
      loadProducts(db, [pid]).then((m) => m.get(pid) ?? null),
      estimateRow(db, pid),
      loadProductsPricing(db, [pid]).then((m) => m.get(pid) ?? null),
    ]);
    if (!loaded || !estimate || estimate.state !== 'estimated' || !stored) return null;
    const skus = estimateSkusOf({ loaded });
    if (!skus) return null;
    const gate = measureGate(stored.inputs, skus, parseAppliedWire(estimate.applied_wire_json), loaded.doc.dimensions);
    const waiting = gate.defaulted.length ? await waitingKeysOf(db, pid, gate.defaulted) : [];
    return {
      defaulted: gate.defaulted,
      waiting_on_apply: gate.defaulted.length > 0 && waiting.length === gate.defaulted.length,
      waiting_keys: waiting,
      real_measures: gate.stated,
      blocked: gate.blocked,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the settings -- */

export interface EstimateSettingsAnswer {
  product_id: string;
  state: ProductEstimateRow['state'];
  type_key: string | null;
  type_source: ProductEstimateRow['type_source'];
  sourcing_override: ProductEstimateRow['sourcing_override'];
  route_override: ProductEstimateRow['route_override'];
  version: number;
}

/**
 * PUT /estimates/products/:id (see the file header). A product with no bookkeeping row yet is enrolled by
 * this call (version 0, born `candidate`); an override always needs a type.
 */
export async function setEstimateProduct(db: D1Database, pid: string, raw: unknown, actor: string, now: Date): Promise<EstimateSettingsAnswer> {
  if (!PRODUCT_ID.test(pid)) throw notFound();
  const body = strictObject(raw, ['version', 'state', 'type_key', 'sourcing_override', 'route_override']);
  const version = versionOf(body.version);
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  if (!['state', 'type_key', 'sourcing_override', 'route_override'].some(has)) throw inputInvalid('state');
  const product = await db.prepare("SELECT id, COALESCE(composition, '') AS composition FROM products WHERE id = ?").bind(pid).first<{ id: string; composition: string }>();
  if (!product) throw notFound();
  if (product.composition !== '') throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { flags: ['EST_STRUCTURE_OWNER'] });
  const row = await estimateRow(db, pid);
  if ((row?.version ?? 0) !== version) throw pricingChanged();

  const next = {
    state: row?.state ?? 'candidate',
    type_key: row?.type_key ?? null,
    type_source: row?.type_source ?? '',
    sourcing_override: row?.sourcing_override ?? null,
    route_override: row?.route_override ?? null,
  } as Pick<ProductEstimateRow, 'state' | 'type_key' | 'type_source' | 'sourcing_override' | 'route_override'>;
  if (has('state')) {
    if (body.state === 'paused') {
      if (next.state !== 'candidate' && next.state !== 'estimated') throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { state: next.state });
      next.state = 'paused';
    } else if (body.state === 'active') {
      if (next.state !== 'paused') throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { state: next.state });
      next.state = row?.applied_at ? 'estimated' : 'candidate';
    } else throw inputInvalid('state');
  }
  if (next.state === 'confirmed') throw estimateRefusal('PRICE_ESTIMATE_NOT_ELIGIBLE', { state: 'confirmed' });
  if (has('type_key')) {
    if (body.type_key === null) {
      // The owner's choice withdrawn: the next compute classifies again (an applied product keeps its type).
      if (next.state === 'estimated') throw inputInvalid('type_key');
      next.type_key = null;
      next.type_source = '';
    } else {
      if (typeof body.type_key !== 'string' || !(await loadTypes(db)).some((t) => t.key === body.type_key)) throw inputInvalid('type_key');
      next.type_key = body.type_key;
      next.type_source = 'owner';
    }
  }
  if (has('sourcing_override')) {
    if (body.sourcing_override !== null && !isSourcing(body.sourcing_override)) throw inputInvalid('sourcing_override');
    next.sourcing_override = body.sourcing_override as ProductEstimateRow['sourcing_override'];
  }
  if (has('route_override')) {
    if (body.route_override !== null && !isRoute(body.route_override)) throw inputInvalid('route_override');
    next.route_override = body.route_override as ProductEstimateRow['route_override'];
  }
  if ((next.sourcing_override || next.route_override) && !next.type_key) throw inputInvalid('type_key');

  const at = now.toISOString();
  const audit = await auditStatements(db, actor, 'price_estimate.product_set', pid, {
    product_id: pid,
    fields: ['state', 'type_key', 'sourcing_override', 'route_override'].filter(has),
    state: next.state,
  });
  // An UPDATE of the row read, or the enrolment's INSERT — never an upsert: SQLite checks the INSERT row's CHECKs
  // (an `estimated` row needs its applied record) before it resolves the conflict.
  const write = row
    ? db
        .prepare(
          `UPDATE product_price_estimates SET type_key = ?, type_source = ?, sourcing_override = ?, route_override = ?, state = ?,
                  version = version + 1, updated_by = ?, updated_at = ? WHERE product_id = ?`
        )
        .bind(next.type_key, next.type_source, next.sourcing_override, next.route_override, next.state, actor, at, pid)
    : db
        .prepare(
          `INSERT INTO product_price_estimates (product_id, type_key, type_source, sourcing_override, route_override, state, version, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .bind(pid, next.type_key, next.type_source, next.sourcing_override, next.route_override, next.state, actor, at);
  try {
    await db.batch([...fence(db, 'COALESCE((SELECT version FROM product_price_estimates WHERE product_id = ?), 0) = ?', [pid, version]), write, ...audit.statements]);
  } catch (e) {
    if (isFenceMiss(e) || /UNIQUE constraint failed: product_price_estimates\.product_id/i.test(e instanceof Error ? e.message : String(e))) throw pricingChanged();
    if (/PRICE_ESTIMATE_TYPE_RULE/.test(e instanceof Error ? e.message : String(e))) throw estimateRefusal('PRICE_ESTIMATE_TYPE_RULE');
    throw e;
  }
  return { product_id: pid, ...next, version: version + 1 };
}
