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
import { parseAppliedWire, skuMeasureSources } from '@levonis/pricing/estimateInputs';
import { ESTIMATE_SOFT_FLAGS } from '@levonis/contracts/priceEstimates';
import { CATALOGUE_NOW_FLAGS, refreshStateOf } from './compute';
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
  try {
    const [{ results }, refresh] = await Promise.all([
      db.prepare('SELECT combo_key, measure_source FROM price_estimate_lines WHERE product_id = ?').bind(pid).all<{ combo_key: string; measure_source: string }>(),
      refreshStateOf(db, pid),
    ]);
    const lines = results ?? [];
    return (
      refresh.listed &&
      !refresh.stale &&
      keys.every((k) => {
        const own = lines.filter((l) => l.combo_key === k);
        return own.length > 0 && own.every((l) => REAL_AFTER_APPLY.has(String(l.measure_source)));
      })
    );
  } catch {
    return false;
  }
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
  const body = strictObject(raw, ['version', 'accept_flags', 'combo_keys']);
  const version = versionOf(body.version);
  const accept = body.accept_flags;
  if (!Array.isArray(accept) || accept.length > 40 || !accept.every((f) => typeof f === 'string' && /^[A-Z_]{3,60}$/.test(f))) throw inputInvalid('accept_flags');
  const accepted = new Set(accept as string[]);

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
  const applied = parseAppliedWire(estimate.applied_wire_json);
  const defaulted = targeted
    .filter((s) => {
      const m = skuMeasureSources(stored.inputs, s, applied);
      return m.weight === 'type_default' || m.cbm === 'type_default';
    })
    .map((s) => s.combo_key)
    .sort();
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
  });
  const statements: D1PreparedStatement[] = [
    ...fence(db, "EXISTS (SELECT 1 FROM product_price_estimates WHERE product_id = ? AND version = ? AND state = 'estimated')", [pid, version]),
    ...seqFence,
    ...(whole
      ? [
          // The confirmation FIRST (trigger T2 reads it), then the label.
          db
            .prepare(
              `UPDATE product_price_estimates SET state = 'confirmed', measure_basis = 'real', confirmed_at = ?, confirmed_by = ?,
                      version = version + 1, updated_by = ?, updated_at = ? WHERE product_id = ?`
            )
            .bind(at, actor, actor, at, pid),
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
    throw e;
  }
  return { product_id: pid, confirmed: whole ? 'whole' : 'skus', firm, version: version + 1 };
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
