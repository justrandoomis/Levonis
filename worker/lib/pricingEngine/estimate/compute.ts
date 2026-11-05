/**
 * «احسب» — ONE PRODUCT'S ESTIMATE, EVALUATED BEFORE ANY WRITE
 * (docs/SMART_PRICING.md §4.7, §4.8; owner decisions D1–D4; DECISIONS rows
 * 278–282).
 *
 * For one product `prepareEstimate`:
 *   1. classifies it (§3.8, ./classify.ts) and reads its type's figures and
 *      its own overrides (sourcing and route, §4.1);
 *   2. judges eligibility (§4.7): never-on-published (no V2 results, or the
 *      label already on), a stored method other than `cost`, a pending
 *      purchase review, an import running — and the STRUCTURE: either the
 *      product is already pre-order-only on exactly its route (`ready`, 5a),
 *      or it is an import-created product holding no stock setup that the
 *      apply makes so (`prepare`, 5b), or it is the owner's and is never
 *      restructured (EST_STRUCTURE_OWNER);
 *   3. builds the document the apply would leave — for 5b, the stored document
 *      changed only in `sale_types = ['pre_order']`, `selling_type` and ONE
 *      route at 0 commission, through the one planner every writer uses
 *      (`planProductSave`, then `draftLoadedOf`) — and reads it as V2 does
 *      (`loadV2Read`);
 *   4. reads each sellable SKU's supplier price (§3.7, WP5's
 *      `supplierPricesFor`) and lets the pure planner build the very wire the
 *      product form sends, merged three ways against what the last apply wrote
 *      (./merge.ts, packages/pricing/src/estimateInputs.ts);
 *   5. evaluates that wire with the engine itself, at the rates of
 *      `loadPricingRates` only: `desiredFor` → `evaluateDesired` →
 *      `evaluateV2Write` → `priceProductV2` (invariants I1, I8);
 *   6. answers the flags (§4.6, codes only), the lines per SKU × route and the
 *      preview hash the apply must carry.
 *
 * `computeEstimates` (POST /estimates/compute) stores that preview —
 * `product_price_estimates` (state, type, flags, hash, time) and
 * `price_estimate_lines` — and WRITES NO V2 TABLE: no input, rule, price,
 * result or state row. It runs under the invocation budget (`countedEstimateDb`).
 *
 * OWNER-ONLY (invariant I6): every line holds the owner's R and supplier price.
 */
import { NO_STOCK_SETUP_SQL, noStockSetupBinds } from '../../importStock';
import { countingD1, type CountedD1 } from '../../invocationCounter';
import { isEstimateRow } from '../../priceEstimateLabel';
import { parseProductRow, type ProductDoc } from '../../productModel';
import { planProductSave, type ProductSavePlan } from '../../productPersistence';
import { HttpError } from '../../http';
import type { Env } from '../../types';
import type { CostSubject } from '../../costAccess';
import { supplierPricesFor, type SkuSupplierPrice } from '../../supplierPrices/store';
import { inputInvalid } from '../whatIf';
import { loadProducts, type LoadedProduct } from '../load';
import { loadEngineControl } from '../engineWrite';
import { desiredFor, evaluateDesired, loadV2Read, parseV2Wire, storedMethodOf, type V2Read } from '../v2/api';
import { pendingReviewsOf } from '../v2/firstWrite';
import { draftLoadedOf, pinV2PriceFields } from '../v2/draft';
import type { V2Evaluation } from '../v2/evaluate';
import type { V2Desired } from '../v2/api';
import { canonicalManualCbm, parseAppliedWire, planEstimateInputs, type EstimatePlan } from '@levonis/pricing/estimateInputs';
import { MAX_BOX_MM } from '@levonis/pricing/costToPrice';
import { isSkuChannel, type PreorderRoute } from '@levonis/pricing/skuChannel';
import { ESTIMATE_HARD_FLAGS, ESTIMATE_SOFT_FLAGS } from '@levonis/contracts/priceEstimates';
import { classifyProducts, type ClassifyResult } from './classify';
import { loadControl, loadTypes } from './control';
import { estimateSkusOf, planInputOf, typeInputsOf, wireBodyOf, withEstimateRefs } from './merge';
import {
  ESTIMATE_COMPUTE_PAGE,
  ESTIMATE_INVOCATION_LIMIT,
  ESTIMATE_LIST_PAGE,
  ESTIMATE_PRODUCT_READS,
  SOURCING_CURRENCY,
  addFlag,
  blockingCodes,
  parseFlags,
  effectiveRouting,
  estimateRowOf,
  flagsJson,
  routeChannel,
  sortedFlags,
  type EstimateControl,
  type EstimateLine,
  type EstimatePreview,
  type EstimateSourcing,
  type EstimateTypeRow,
  type LinePriceSource,
  type PlanFlag,
  type ProductEstimateRow,
  type StoredFlag,
  type TypeSource,
} from './types';

/** Who computes and when (the owner: cost read and write). */
export interface EstimateContext {
  env: Env;
  user: CostSubject | null | undefined;
  actor: string;
  now: Date;
}

/** The page's shared reads (one set per call, whatever its size). */
export interface EstimatePage {
  loaded: Map<string, LoadedProduct>;
  estimates: Map<string, ProductEstimateRow>;
  types: Map<string, EstimateTypeRow>;
  control: EstimateControl | null;
  classification: Map<string, ClassifyResult>;
}

/** Everything one product's estimate is made of — what compute stores and apply writes. */
export interface PreparedEstimate {
  product_id: string;
  slug: string | null;
  loaded: LoadedProduct;
  estimate: ProductEstimateRow | null;
  type: EstimateTypeRow | null;
  type_source: TypeSource;
  sourcing: EstimateSourcing | null;
  route: PreorderRoute | null;
  /** The product's created import row's stock decision, or null (merged, or no source row). */
  stock_decision: string | null;
  structure: 'ready' | 'prepare' | 'owner' | null;
  /** 5b: the planner's statements (the apply lays them as the V2 write's `structure`). */
  structurePlan: ProductSavePlan | null;
  /** `products.updated_at` as read (the stale-edit fence of a structure write). */
  updatedAt: string | null;
  read: V2Read | null;
  plan: EstimatePlan | null;
  desired: V2Desired | null;
  ev: V2Evaluation | null;
  /** Skipped: confirmed or paused (the estimator never touches them), or not an ordinary product. */
  skipped: boolean;
  preview: EstimatePreview;
}

/* ------------------------------------------------------------- the reads -- */

const ESTIMATE_ROWS_SQL = 'SELECT * FROM product_price_estimates WHERE product_id IN (SELECT value FROM json_each(?))';

/** The page's shared reads: the products as the cart reads them, their bookkeeping, the types, the switches, the types decided. */
export async function loadEstimatePage(db: D1Database, ids: readonly string[]): Promise<EstimatePage> {
  const unique = [...new Set(ids)];
  const loaded = await loadProducts(db, unique);
  const [rows, typeRows, control] = await Promise.all([
    db.prepare(ESTIMATE_ROWS_SQL).bind(JSON.stringify(unique)).all<Record<string, unknown>>(),
    loadTypes(db),
    loadControl(db),
  ]);
  const estimates = new Map((rows.results ?? []).map((r) => [String(r.product_id), estimateRowOf(r)] as const));
  const types = new Map(typeRows.map((t) => [t.key, t] as const));
  const subjects = unique.filter((id) => loaded.has(id)).map((id) => ({ id, name: String(loaded.get(id)!.row.name ?? ''), estimate: estimates.get(id) ?? null }));
  const classification = await classifyProducts(db, subjects, [...types.keys()]);
  return { loaded, estimates, types, control, classification };
}

interface ProductFacts {
  v2_results: number;
  created_decision: string | null;
  import_running: boolean;
  reprice_blocked_code: string | null;
  direct_cell: boolean;
  no_stock_setup: boolean;
}

/** One statement: what eligibility needs of a product beyond its document (§4.7). */
async function factsOf(db: D1Database, pid: string): Promise<ProductFacts> {
  const r = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pricing_v2_sku_results WHERE product_id = ?) AS v2_results,
         (SELECT stock_decision FROM product_source_refs WHERE product_id = ? AND match_kind = 'created' ORDER BY source, source_product_id LIMIT 1) AS created_decision,
         EXISTS (SELECT 1 FROM ops_guards WHERE id = 'catalog-import-batch') AS import_running,
         (SELECT reprice_blocked_code FROM product_pricing_state WHERE product_id = ?) AS reprice_blocked_code,
         EXISTS (SELECT 1 FROM product_option_fulfillment WHERE product_id = ? AND fulfillment_type = 'direct_sale' AND enabled = 1) AS direct_cell,
         (${NO_STOCK_SETUP_SQL}) AS no_stock_setup`
    )
    .bind(pid, pid, pid, pid, ...noStockSetupBinds(pid))
    .first<Record<string, unknown>>();
  return {
    v2_results: Number(r?.v2_results ?? 0),
    created_decision: r?.created_decision === null || r?.created_decision === undefined ? null : String(r.created_decision),
    import_running: Number(r?.import_running) === 1,
    reprice_blocked_code: r?.reprice_blocked_code ? String(r.reprice_blocked_code) : null,
    direct_cell: Number(r?.direct_cell) === 1,
    no_stock_setup: Number(r?.no_stock_setup) === 1,
  };
}

/* ------------------------------------------------------------ structure -- */

/**
 * §4.7 (5): `ready` — pre-order-only on exactly its route (one active route, no direct cell; an import
 * decision still to record needs the stock conditions of (b) too); `prepare` — an import-created product
 * with no stock setup the apply makes so; `owner` — anything else, never restructured.
 */
export function structureOf(doc: ProductDoc, route: PreorderRoute, facts: ProductFacts): 'ready' | 'prepare' | 'owner' {
  const active = (doc.preorder_transports ?? []).filter((t) => t.active !== false);
  const preorderOnly = doc.sale_types.length === 1 && doc.sale_types[0] === 'pre_order';
  if (preorderOnly && active.length === 1 && active[0]!.method === route && !facts.direct_cell) {
    return facts.created_decision === 'not_configured' && !facts.no_stock_setup ? 'owner' : 'ready';
  }
  if ((facts.created_decision === 'not_configured' || facts.created_decision === 'untracked') && facts.no_stock_setup) return 'prepare';
  return 'owner';
}

/**
 * 5b: the document the apply leaves — the stored one changed ONLY in its sale types and its one route at 0
 * commission (§4.8 step 1) — planned by the one planner every product writer goes through, read as the cart
 * reads it. Nothing is written here; the apply lays the plan's statements inside the V2 writer's batch.
 */
async function draftOf(db: D1Database, loaded: LoadedProduct, route: PreorderRoute, actor: string): Promise<{ plan: ProductSavePlan; draft: LoadedProduct }> {
  const prev = parseProductRow(loaded.row);
  const doc = parseProductRow(loaded.row);
  doc.sale_types = ['pre_order'];
  doc.selling_type = 'pre_order';
  doc.preorder_transports = [{ method: route, commission_iqd: 0, active: true }];
  // The V2 save's own pin: the stored ladder stays until the V2 writer replaces it in the same batch.
  pinV2PriceFields(doc, prev);
  const plan = await planProductSave(
    db,
    { mode: 'update', doc, prev, relations: null, actor: { adminId: actor, money: true }, priceHistory: false, hashtags: false },
    { relationMediaMetadata: 'deferred' }
  );
  return { plan, draft: await draftLoadedOf(db, plan, loaded) };
}

/* -------------------------------------------------------------- prepare -- */

const PREORDER_CHANNELS = new Set(['pre_order_air', 'pre_order_sea', 'pre_order_land']);
const LINE_SOURCES = new Set<string>(['tmall_cn', 'bambu_eu', 'bambu_us', 'typed', 'store_page']);

/** The answer of a product the estimator does not evaluate (skipped, or no type): its stored state only. */
function shallowPreview(p: Omit<PreparedEstimate, 'preview'>, flags: Map<string, PlanFlag>, at: string): EstimatePreview {
  const list = sortedFlags(flags);
  const blocked = blockingCodes(list);
  return {
    product_id: p.product_id,
    name: String(p.loaded.row.name ?? ''),
    state: p.estimate?.state ?? 'candidate',
    label: isEstimateRow(p.loaded.row),
    type: p.type?.key ?? null,
    type_source: p.type_source,
    sourcing: p.sourcing,
    route: p.route,
    currency: p.sourcing ? SOURCING_CURRENCY[p.sourcing] : null,
    structure: p.structure,
    measure_basis: p.estimate?.measure_basis ?? '',
    flags: list,
    blocking: true,
    blocked_by: blocked,
    preview_hash: null,
    computed_at: at,
    lines: [],
    version: p.estimate?.version ?? 0,
  };
}

/**
 * One product's estimate, evaluated, with nothing written (see the file header). Never throws for a
 * product the estimator cannot price: it answers the reason as a flag. An HttpError of the engine's
 * own (a draft the form would refuse) is answered as a blocking flag of its code.
 */
export async function prepareEstimate(db: D1Database, pid: string, page: EstimatePage, cx: EstimateContext): Promise<PreparedEstimate | null> {
  const loaded = page.loaded.get(pid);
  if (!loaded) return null;
  const at = cx.now.toISOString();
  const estimate = page.estimates.get(pid) ?? null;
  const flags = new Map<string, PlanFlag>();
  const classified = page.classification.get(pid) ?? { type_key: null, type_source: '' as const, flags: ['EST_TYPE_MISSING' as const] };
  const type = classified.type_key ? (page.types.get(classified.type_key) ?? null) : null;
  const routing = type ? effectiveRouting(type, estimate) : null;
  const base: Omit<PreparedEstimate, 'preview'> = {
    product_id: pid,
    slug: typeof loaded.row.slug === 'string' ? loaded.row.slug : null,
    loaded,
    estimate,
    type,
    type_source: (classified.type_source || '') as TypeSource,
    sourcing: routing?.sourcing ?? null,
    route: routing?.route ?? null,
    stock_decision: null,
    structure: null,
    structurePlan: null,
    updatedAt: loaded.row.updated_at === undefined || loaded.row.updated_at === null ? null : String(loaded.row.updated_at),
    read: null,
    plan: null,
    desired: null,
    ev: null,
    skipped: false,
  };

  // The estimator never touches a confirmed or paused product (§4.5), nor a bundle or a mystery box (§4.7 (2)).
  if (estimate && (estimate.state === 'confirmed' || estimate.state === 'paused')) {
    const p = { ...base, skipped: true };
    return { ...p, preview: shallowPreview(p, new Map(parseFlags(estimate.flags_json).map((f) => [f.code, f] as const)), at) };
  }
  if ((loaded.doc.composition ?? '') !== '') {
    addFlag(flags, 'EST_STRUCTURE_OWNER');
    const p = { ...base, skipped: true };
    return { ...p, preview: shallowPreview(p, flags, at) };
  }
  for (const f of classified.flags) addFlag(flags, f);
  if (!type || !routing) {
    if (!classified.flags.length) addFlag(flags, 'EST_TYPE_MISSING');
    return { ...base, preview: shallowPreview(base, flags, at) };
  }

  const facts = await factsOf(db, pid);
  const labelled = isEstimateRow(loaded.row);
  base.stock_decision = facts.created_decision;
  if (facts.import_running) addFlag(flags, 'EST_IMPORT_RUNNING');
  if (facts.v2_results > 0 && !labelled) addFlag(flags, 'EST_FIRM_PRICE');
  if (facts.reprice_blocked_code === 'PRICING_V2_LARGE_CHANGE') addFlag(flags, 'EST_LARGE_CHANGE_HELD');
  const structure = structureOf(loaded.doc, routing.route, facts);
  base.structure = structure;
  if (structure === 'owner') addFlag(flags, 'EST_STRUCTURE_OWNER');

  try {
    // 3. The document the apply would leave, read as V2 reads it.
    let draft = loaded;
    if (structure === 'prepare') {
      const d = await draftOf(db, loaded, routing.route, cx.actor);
      base.structurePlan = d.plan;
      draft = d.draft;
    }
    const read = (await loadV2Read(db, pid, draft))!;
    base.read = read;
    const method = storedMethodOf(read);
    if (method && method !== 'cost') addFlag(flags, 'EST_METHOD_OWNER');
    // A purchase review waiting (D1, row 249) — or, before a first V2 write, a stock purchase's overlay, which
    // `desiredFor` folds into the inputs (addendum A.7): the estimate would be laid over a purchase's real cost.
    const review = method ? await pendingReviewsOf(db, pid) : (read.review ?? null);
    if (review || (!method && (read.stored.direct_purchase?.inputs.length ?? 0) > 0)) addFlag(flags, 'EST_PURCHASE_REVIEW_PENDING');
    if (flags.has('EST_METHOD_OWNER') || flags.has('EST_FIRM_PRICE')) {
      return { ...base, preview: shallowPreview(base, flags, at) };
    }

    // 4. The supplier prices and the plan.
    const skus = estimateSkusOf(read);
    if (!skus) {
      addFlag(flags, 'SKU_GRID_TOO_LARGE');
      return { ...base, preview: shallowPreview(base, flags, at) };
    }
    const prices =
      (
        await supplierPricesFor(
          db,
          [{ product_id: pid, combo_keys: skus.map((s) => s.combo_key), sourcing: routing.sourcing, us_reference_allowed: routing.us_reference_allowed, stale_after_days: type.stale_after_days }],
          { today: at.slice(0, 10) }
        )
      ).get(pid) ?? new Map<string, SkuSupplierPrice>();
    const plan = planEstimateInputs(planInputOf(read, skus, typeInputsOf(type, routing.route), prices, estimate?.applied_wire_json ?? null));
    base.plan = plan;
    for (const f of plan.flags) addFlag(flags, f.code, f);
    // What the catalogue says of a SKU it cannot price (a suggestion to review, a key gone from the capture).
    for (const s of plan.skus) {
      if (s.supplier !== 'missing') continue;
      for (const code of prices.get(s.combo_key)?.flags ?? []) if (code !== 'EST_NO_PRICE') addFlag(flags, code, { combo_keys: [s.combo_key] });
    }

    // 5. The engine itself prices the wire (nothing is written).
    if (!plan.blocked_by.includes('EST_TOO_MANY_SCOPES')) {
      const wire = parseV2Wire(wireBodyOf(plan));
      const desired = withEstimateRefs(desiredFor(read, wire, { viewer: 'owner', env: cx.env, user: cx.user, now: at }), plan);
      base.desired = desired;
      const ev = await evaluateDesired(read, desired);
      base.ev = ev;
      if (!ev.complete) for (const code of ev.codes) addFlag(flags, code);
      // A blocked route is written OFF by an accepted preview: for an estimate (one route) it is never accepted.
      for (const b of ev.blocked) addFlag(flags, b.code ?? 'V2_ROUTE_BELOW_COST', { combo_keys: [b.combo_key] });
      // One route per estimated product (§4.1, DECISIONS row 220 (a)): any other channel is the owner's structure.
      const channel = routeChannel(routing.route);
      const others = ev.rows.filter((r) => r.channel !== channel).map((r) => r.combo_key);
      if (others.length) addFlag(flags, 'EST_STRUCTURE_OWNER', { combo_keys: others });
    }
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    addFlag(flags, e.code || 'PRICING_INPUT_INVALID');
  }
  return { ...base, preview: fullPreview(base, flags, at) };
}

/** The preview of an evaluated product: flags, lines per SKU × route, the hash an apply must carry. */
function fullPreview(p: Omit<PreparedEstimate, 'preview'>, flags: Map<string, PlanFlag>, at: string): EstimatePreview {
  const list = sortedFlags(flags);
  const blocked = blockingCodes(list);
  const ev = p.ev;
  const blocking = blocked.length > 0 || !ev || !ev.complete;
  const lines: EstimateLine[] = [];
  const stored = new Map((p.read?.v2?.results ?? []).map((r) => [`${r.combo_key}@${r.channel}`, r.final_price_iqd] as const));
  const skuPlans = new Map((p.plan?.skus ?? []).map((s) => [s.combo_key, s] as const));
  if (ev) {
    for (const row of ev.rows) {
      if (!PREORDER_CHANNELS.has(row.channel)) continue;
      const s = skuPlans.get(row.combo_key);
      const priced = s?.supplier === 'catalogue' && s.price ? s.price : null;
      lines.push({
        combo_key: row.combo_key,
        channel: row.channel,
        source: (priced && LINE_SOURCES.has(priced.source) ? priced.source : 'none') as LinePriceSource,
        supplier_amount: priced?.amount ?? null,
        supplier_currency: priced?.currency ?? null,
        measure_source: s?.measure_source ?? 'none',
        flags: s?.flags ?? [],
        est_cost_iqd: row.owner?.replacement_cost_iqd ?? null,
        est_price_iqd: row.new_iqd,
        published_price_iqd: stored.get(`${row.combo_key}@${row.channel}`) ?? null,
        change_pct: row.change_pct,
        large: row.large || row.drop_flag,
      });
    }
  } else if (p.plan && p.route) {
    const channel = routeChannel(p.route);
    for (const s of p.plan.skus) {
      lines.push({
        combo_key: s.combo_key,
        channel,
        source: (s.price && LINE_SOURCES.has(s.price.source) ? s.price.source : 'none') as LinePriceSource,
        supplier_amount: s.price?.amount ?? null,
        supplier_currency: s.price?.currency ?? null,
        measure_source: s.measure_source,
        flags: s.flags,
        est_cost_iqd: null,
        est_price_iqd: null,
        published_price_iqd: stored.get(`${s.combo_key}@${channel}`) ?? null,
        change_pct: null,
        large: false,
      });
    }
  }
  return {
    product_id: p.product_id,
    name: String(p.loaded.row.name ?? ''),
    state: p.estimate?.state ?? 'candidate',
    label: isEstimateRow(p.loaded.row),
    type: p.type?.key ?? null,
    type_source: p.type_source,
    sourcing: p.sourcing,
    route: p.route,
    currency: p.sourcing ? SOURCING_CURRENCY[p.sourcing] : null,
    structure: p.structure,
    measure_basis: p.plan?.measure_basis ?? p.estimate?.measure_basis ?? '',
    flags: list,
    blocking,
    blocked_by: blocked,
    preview_hash: !blocking && ev?.hash ? ev.hash : null,
    computed_at: at,
    lines,
    version: p.estimate?.version ?? 0,
  };
}

/* ---------------------------------------------------------------- storing -- */

/** `product_price_estimates.flags_json` (CHECK ≤ 4,000) and a line's (≤ 2,000). */
const PRODUCT_FLAGS_MAX = 4000;
const LINE_FLAGS_MAX = 2000;

/**
 * A line's flag codes within its column (CHECK ≤ 2,000 characters): the first codes that fit. The owner's statement
 * of real measures rewrites lines through it too (./confirm.ts), so they are what the next compute writes.
 */
export function lineFlags(codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    if (JSON.stringify([...out, c]).length > LINE_FLAGS_MAX) break;
    out.push(c);
  }
  return out;
}

/** The JSON list of lines `price_estimate_lines` takes through json_each (one bound parameter). */
export function linesJson(lines: readonly EstimateLine[]): string {
  return JSON.stringify(
    lines
      .filter((l) => isSkuChannel(l.channel) && PREORDER_CHANNELS.has(l.channel))
      .map((l) => ({
        c: l.combo_key,
        ch: l.channel,
        s: l.source,
        a: l.supplier_amount,
        u: l.supplier_currency,
        m: l.measure_source,
        f: lineFlags(l.flags),
        r: l.est_cost_iqd,
        e: l.est_price_iqd,
        p: l.published_price_iqd,
      }))
  );
}

/** The replacement of a product's preview lines: one DELETE and one INSERT through json_each. */
export function lineStatements(db: D1Database, pid: string, lines: readonly EstimateLine[], at: string): D1PreparedStatement[] {
  const json = linesJson(lines);
  return [
    db.prepare('DELETE FROM price_estimate_lines WHERE product_id = ?').bind(pid),
    ...(json === '[]'
      ? []
      : [
          db
            .prepare(
              `INSERT INTO price_estimate_lines
                 (product_id, combo_key, channel, price_source, supplier_amount, supplier_currency, measure_source, flags_json,
                  est_cost_iqd, est_price_iqd, published_price_iqd, computed_at)
               SELECT ?1, json_extract(j.value, '$.c'), json_extract(j.value, '$.ch'), json_extract(j.value, '$.s'),
                      json_extract(j.value, '$.a'), json_extract(j.value, '$.u'), json_extract(j.value, '$.m'),
                      json(json_extract(j.value, '$.f')), json_extract(j.value, '$.r'), json_extract(j.value, '$.e'),
                      json_extract(j.value, '$.p'), ?2
                 FROM json_each(?3) j WHERE 1`
            )
            .bind(pid, at, json),
        ]),
  ];
}

export const productFlagsJson = (flags: readonly PlanFlag[]): string => flagsJson(flags, PRODUCT_FLAGS_MAX);

/**
 * THE FLAGS OF AN `estimated` ROW (§4.6, §4.9). Customers are charged the APPLIED estimate's price, so its soft
 * and hard flags stay on the row until the next apply rewrites them: §4.9 accepts the soft ones by name and
 * judges them there (./confirm.ts). A refresh's own soft and hard codes describe the refresh's price: they are in
 * the compute answer and on its lines. What a refresh says of the product NOW is its blocking codes (why it cannot
 * be applied) and its information (EST_OWNER_EDITED, EST_LARGE_CHANGE_HELD) — classes confirm never reads — so
 * those replace the row's.
 */
const APPLIED_CODES: readonly string[] = [...ESTIMATE_HARD_FLAGS, ...ESTIMATE_SOFT_FLAGS];
const APPLIED_CODES_JSON = JSON.stringify(APPLIED_CODES);
const refreshOnly = (flags: readonly PlanFlag[]) => flags.filter((f) => !APPLIED_CODES.includes(f.code));

/**
 * A preview's blocking and information flags (every code neither hard nor soft) — what an `estimated` row takes
 * from a refresh — within the column.
 */
export const refreshFlagsJson = (flags: readonly PlanFlag[]): string => flagsJson(refreshOnly(flags), PRODUCT_FLAGS_MAX);

/** The same flags with their combo keys always counted (the codes and field names kept): the second try beside long applied ones. */
const countedRefreshFlagsJson = (flags: readonly PlanFlag[]): string =>
  JSON.stringify(refreshOnly(flags).map((f) => ({ code: f.code, ...(f.combo_keys?.length ? { count: f.combo_keys.length } : {}), ...(f.fields ? { fields: f.fields } : {}) })));

/** The row's stored soft and hard entries (?9 names those codes) and a refresh's flags (`refresh`), in code order, when they fit the column. */
const appliedWith = (refresh: string) => `(
      SELECT CASE WHEN length(m.j) <= ${PRODUCT_FLAGS_MAX} THEN m.j END FROM (
        SELECT json_group_array(json(u.v)) AS j FROM (
          SELECT s.v, s.c FROM (
            SELECT CASE f.type WHEN 'object' THEN f.value ELSE json_object('code', f.value) END AS v,
                   CASE f.type WHEN 'object' THEN json_extract(f.value, '$.code') ELSE f.value END AS c
              FROM json_each(product_price_estimates.flags_json) f
          ) s
           WHERE s.c IN (SELECT value FROM json_each(?9))
          UNION ALL
          SELECT r.value, json_extract(r.value, '$.code') FROM json_each(${refresh}) r
          ORDER BY 2
        ) u
      ) m
    )`;

/**
 * An `estimated` row's flags after a refresh, decided inside the upsert (so an apply that commits first is never
 * written over): its stored soft and hard entries with the refresh's blocking and information ones (?8); when
 * those do not fit beside them, with their combo keys counted (?10); with no room, the stored soft and hard
 * entries alone, so a previous refresh's entries never outlive a newer refresh. The stored flags whole only if
 * even those no longer fit (never cut).
 */
const ESTIMATED_FLAGS_SQL = `COALESCE(${appliedWith('?8')}, ${appliedWith('?10')}, ${appliedWith("'[]'")}, product_price_estimates.flags_json)`;

/**
 * What compute stores (owner-only bookkeeping, no V2 table): the row — born `candidate`, its type as decided,
 * its flags, hash and time, its version moved — and the lines. A confirmed or paused row is never rewritten
 * (the upsert's WHERE), and its lines stay. A candidate takes the preview's flags whole; an `estimated` row keeps
 * the applied estimate's soft and hard flags and takes the refresh's blocking and information ones (see
 * `APPLIED_CODES`).
 */
export function previewStatements(db: D1Database, p: PreparedEstimate, actor: string): D1PreparedStatement[] {
  const v = p.preview;
  const at = v.computed_at;
  return [
    db
      .prepare(
        `INSERT INTO product_price_estimates (product_id, type_key, type_source, state, flags_json, preview_hash, computed_at, version, updated_by, updated_at)
         VALUES (?1, ?2, ?3, 'candidate', ?4, ?5, ?6, 1, ?7, ?6)
         ON CONFLICT(product_id) DO UPDATE SET
           type_key = excluded.type_key, type_source = excluded.type_source,
           flags_json = CASE WHEN product_price_estimates.state = 'estimated' THEN ${ESTIMATED_FLAGS_SQL} ELSE excluded.flags_json END,
           preview_hash = excluded.preview_hash, computed_at = excluded.computed_at,
           version = product_price_estimates.version + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at
         WHERE product_price_estimates.state IN ('candidate', 'estimated')`
      )
      .bind(
        p.product_id,
        v.type,
        v.type_source,
        productFlagsJson(v.flags),
        v.preview_hash,
        at,
        actor,
        refreshFlagsJson(v.flags),
        APPLIED_CODES_JSON,
        countedRefreshFlagsJson(v.flags)
      ),
    ...(p.skipped ? [] : lineStatements(db, p.product_id, v.lines, at)),
  ];
}

/* --------------------------------------------------------------- the page -- */

/** The products a compute page reads: the ids named (≤ 10), or the next page of enrolled or import-created products. */
export async function computePageIds(db: D1Database, input: { cursor?: unknown; product_ids?: unknown }): Promise<{ ids: string[]; next: string | null }> {
  if (input.product_ids !== undefined) {
    const list = input.product_ids;
    if (!Array.isArray(list) || list.length < 1 || list.length > ESTIMATE_COMPUTE_PAGE || !list.every((x) => typeof x === 'string' && /^[A-Za-z0-9_:.-]{1,80}$/.test(x))) {
      throw inputInvalid('product_ids');
    }
    return { ids: [...new Set(list as string[])], next: null };
  }
  const cursor = input.cursor === undefined || input.cursor === null ? '' : input.cursor;
  if (typeof cursor !== 'string' || (cursor !== '' && !/^[A-Za-z0-9_:.-]{1,80}$/.test(cursor))) throw inputInvalid('cursor');
  // Never enrolled automatically: a merged product or one with no source row is computed only once the owner
  // enrolled it (its bookkeeping row, §3.8).
  const { results } = await db
    .prepare(
      `SELECT p.id FROM products p
        WHERE COALESCE(p.composition, '') = '' AND p.id > ?1
          AND (EXISTS (SELECT 1 FROM product_source_refs r WHERE r.product_id = p.id AND r.match_kind = 'created')
               OR EXISTS (SELECT 1 FROM product_price_estimates e WHERE e.product_id = p.id))
        ORDER BY p.id LIMIT ?2`
    )
    .bind(cursor, ESTIMATE_COMPUTE_PAGE + 1)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => String(r.id));
  const more = ids.length > ESTIMATE_COMPUTE_PAGE;
  const page = ids.slice(0, ESTIMATE_COMPUTE_PAGE);
  return { ids: page, next: more ? page[page.length - 1]! : null };
}

export interface ComputeAnswer {
  products: EstimatePreview[];
  /** Products named but not computed (the invocation budget): send them again. */
  deferred: string[];
  /** The next page's cursor (paging only), or null. */
  next_cursor: string | null;
  /** The D1 statements this call spent (reads and batches; the door's own reads are outside it). */
  spent: number;
}

/**
 * THE CALL'S OWN STATEMENTS, COUNTED (§4.8: at most 900 an invocation): a counting view of exactly the
 * binding it is given (worker/lib/invocationCounter.ts), every read and every batch statement counted, so
 * a caller counting the whole request still sees them. The estimator sizes its pages from it.
 */
export const countedEstimateDb = (raw: D1Database): CountedD1 => countingD1(raw);

/**
 * POST /estimates/compute {cursor | product_ids[≤10]}: each product's preview, stored as owner-only
 * bookkeeping (no V2 table written), within the invocation budget.
 */
export async function computeEstimates(
  raw: D1Database,
  input: { cursor?: unknown; product_ids?: unknown },
  cx: EstimateContext,
  opts: { limit?: number; counted?: CountedD1 } = {}
): Promise<ComputeAnswer> {
  const { db, counter } = opts.counted ?? countedEstimateDb(raw);
  const limit = opts.limit ?? ESTIMATE_INVOCATION_LIMIT;
  const { ids, next } = await computePageIds(db, input);
  const page = await loadEstimatePage(db, ids);
  const products: EstimatePreview[] = [];
  const deferred: string[] = [];
  for (const pid of ids) {
    if (deferred.length || counter.count + ESTIMATE_PRODUCT_READS > limit) {
      deferred.push(pid);
      continue;
    }
    const p = await prepareEstimate(db, pid, page, cx);
    if (!p) continue;
    // While an import batch runs, its guards refuse every write to the estimate tables (T12): answered, not stored.
    if (!p.skipped && !p.preview.flags.some((f) => f.code === 'EST_IMPORT_RUNNING')) {
      const statements = previewStatements(db, p, cx.actor);
      if (counter.count + statements.length > limit) {
        deferred.push(pid);
        continue;
      }
      try {
        await db.batch(statements);
      } catch (e) {
        // The type decided now contradicts the owner's route override (trigger T5): nothing stored, the reason told.
        if (!/PRICE_ESTIMATE_TYPE_RULE/.test(e instanceof Error ? e.message : String(e))) throw e;
        const flags = new Map(p.preview.flags.map((f) => [f.code, f] as const));
        addFlag(flags, 'PRICE_ESTIMATE_TYPE_RULE');
        const list = sortedFlags(flags);
        products.push({ ...p.preview, flags: list, blocking: true, blocked_by: blockingCodes(list), preview_hash: null });
        continue;
      }
    }
    products.push(p.preview);
  }
  // Paging by cursor, a deferred product starts the next page (the cursor stops before it); named ids come back as `deferred`.
  const paging = input.product_ids === undefined;
  const resume = (): string | null => {
    const at = ids.indexOf(deferred[0]!);
    return at > 0 ? ids[at - 1]! : typeof input.cursor === 'string' ? input.cursor : '';
  };
  return { products, deferred, next_cursor: deferred.length ? (paging ? resume() : null) : next, spent: counter.count };
}

/* -------------------------------------------------------- the stored reads -- */

/**
 * The catalogue's words for a SKU (§3.7) that time and newer captures move after an apply: a capture grown older
 * than the type allows, the matched item gone from the newest capture, out of stock. §4.9 reads them again at
 * confirm (./confirm.ts); the workspace shows the latest compute's beside the published estimate's flags.
 */
export const CATALOGUE_NOW_FLAGS: readonly string[] = ['EST_SNAPSHOT_STALE', 'EST_SOURCE_ITEM_MISSING', 'EST_SUPPLIER_OUT_OF_STOCK'];

/** The type-default measure codes (hard, §4.6). */
const HARD_CODES: readonly string[] = ESTIMATE_HARD_FLAGS;
/**
 * A line's measure sources the estimator never writes (estimateInputs.ts `skuMeasureSources`): the owner's, a
 * colour's or a model's. A SKU whose latest line names one of them is priced from real measures already in the
 * store — for its box, unless the type's CBM still decides the product level (`typeCbmHidesBox`). Its type's
 * default ('type_default') and its product's package ('product') wait on the estimator's next apply.
 */
const REAL_MEASURES: readonly string[] = ['owner', 'colour', 'model'];
/** A colour's or a model's own package: a level more specific than the product's, so nothing there hides it. */
const PACKAGED_MEASURES: readonly string[] = ['colour', 'model'];

/** A product's base row of the owner's origin (`pricing_inputs`, scope 'base'), the fields that decide its CBM there. */
export interface BaseCbmRow {
  manual_cbm: unknown;
  shipping_length_mm: unknown;
  shipping_width_mm: unknown;
  shipping_height_mm: unknown;
}

/**
 * THE TYPE'S CBM STILL DECIDES THE PRODUCT LEVEL. The last apply wrote the type's default CBM there as
 * `manual_cbm` (recorded `type_default`, §4.4 step 3) and the store still holds that very value, beside a whole
 * box entered there since (the pricing form has no manual-CBM field). A manual CBM decides its level (LD6), so that
 * box prices nothing yet: customers pay the price on the type's CBM, and §4.9 refuses PRICE_ESTIMATE_DEFAULT_MEASURES
 * (it reads the store). The latest lines describe the store as the NEXT apply leaves it — the type's CBM taken
 * away — so they call a SKU priced at the product level 'owner'. Until that apply only a colour's or a model's own
 * package, a more specific level, shows a SKU's box real (`PACKAGED_MEASURES`). Read as §4.9 reads the record
 * (`parseAppliedWire`, the value compared canonically).
 */
export function typeCbmHidesBox(appliedWireJson: unknown, base: BaseCbmRow | null | undefined): boolean {
  if (!base || [base.manual_cbm, base.shipping_length_mm, base.shipping_width_mm, base.shipping_height_mm].some((v) => v === null || v === undefined)) return false;
  const record = parseAppliedWire(appliedWireJson)?.inputs.find((f) => f.scope === 'base' && f.field === 'manual_cbm');
  return record?.source === 'type_default' && canonicalManualCbm(base.manual_cbm) === record.value;
}

/** A pricing row holding a CBM field (a box axis or a manual CBM): above the product level, its level decides the CBM of the SKUs it reaches (costToPrice `cbmCell`). */
const holdsCbm = (r: BaseCbmRow) => [r.manual_cbm, r.shipping_length_mm, r.shipping_width_mm, r.shipping_height_mm].some((v) => v !== null && v !== undefined);

/** Does a pricing row of this scope reach this SKU? Combo keys read 'o:<value>|…|c:<colour>' (inventory.ts `comboKey`). */
const reachesSku = (scope: unknown, scopeId: unknown, combo: string): boolean =>
  scope === 'sku' ? scopeId === combo : scope === 'color' ? `|${combo}|`.includes(`|c:${String(scopeId)}|`) : scope === 'option' ? `|${combo}|`.includes(`|o:${String(scopeId)}|`) : false;

/** What `shownFlags` reads of a labelled product's store (`storedEstimates`). */
export interface ShownStore {
  typeCbmHidesBox?: boolean;
  /** A level above the product's decides this SKU's CBM: a pricing row there holds a CBM field. */
  boxDecidedAbove?: (comboKey: string) => boolean;
  /** An owner's pricing row was written after the latest lines: they may no longer describe the store. */
  stale?: boolean;
}

/**
 * A line's codes the workspace shows with its product's flags (`shownFlags`): a type-default measure (what D2
 * holds the label on, as the confirmation sheet reads the lines) and the catalogue's words. A line's other codes
 * name the source of that compute's own price, and stay on the line.
 */
const LINE_SHOWN: readonly string[] = [...HARD_CODES, ...CATALOGUE_NOW_FLAGS];

/**
 * The flags the workspace and the product form's banner show for a product: the row's — for an `estimated` row,
 * the published estimate's soft and hard flags and the latest compute's blocking and information ones
 * (`previewStatements`) — and, for an estimated or paused product, what the latest compute's lines say of their
 * SKUs (`LINE_SHOWN`), each with its combo keys. A flag of the row that names no SKU is the product's already.
 * The row's default measures are the apply's: a SKU whose latest line is priced from real measures in the store
 * (`REAL_MEASURES`) is no longer shown under them — under the default box, while the type's CBM still decides the
 * product level (`typeCbmHidesBox`) and so the SKU's CBM (no level above decides it, `boxDecidedAbove`), only a SKU
 * on its colour's or model's own package. With no line, or once an owner's pricing row was written after those
 * lines (`stale`), the row's stand. Read only here: confirm judges the row, the store and the catalogue itself.
 * A CONFIRMED row has no default measure left (§4.9 step 1 proved it when it was confirmed): a default-measure entry
 * still stored there — a product confirmed before the confirmation dropped them from the row — is never shown, so
 * no confirmed product shows «وزن افتراضي».
 */
export function shownFlags(
  state: ProductEstimateRow['state'],
  flags: readonly StoredFlag[],
  lines: readonly Pick<EstimateLine, 'combo_key' | 'flags' | 'measure_source'>[],
  store: ShownStore = {}
): StoredFlag[] {
  if (state === 'confirmed') return flags.filter((f) => !HARD_CODES.includes(f.code));
  if (state !== 'estimated' && state !== 'paused') return [...flags];
  /** The measure sources that show this SKU's measure of `code` real in the store. */
  const proof = (code: string, comboKey: string) =>
    code === 'EST_DEFAULT_BOX' && store.typeCbmHidesBox && !store.boxDecidedAbove?.(comboKey) ? PACKAGED_MEASURES : REAL_MEASURES;
  const realFor = (code: string) => (l: Pick<EstimateLine, 'combo_key' | 'measure_source'>) => proof(code, l.combo_key).includes(l.measure_source);
  const kept: StoredFlag[] = [];
  for (const f of flags) {
    if (store.stale || !lines.length || !HARD_CODES.includes(f.code)) {
      kept.push(f);
      continue;
    }
    const real = realFor(f.code);
    if (!f.combo_keys?.length) {
      if (!lines.every(real)) kept.push(f);
      continue;
    }
    const cleared = new Set(lines.filter(real).map((l) => l.combo_key));
    const keys = f.combo_keys.filter((k) => !cleared.has(k));
    if (keys.length) kept.push(keys.length === f.combo_keys.length ? f : { ...f, combo_keys: keys });
  }
  const out = new Map(kept.map((f) => [f.code, { ...f }] as const));
  let added = false;
  for (const l of lines) {
    for (const code of l.flags) {
      if (!LINE_SHOWN.includes(code)) continue;
      const f = out.get(code);
      if (f && !f.combo_keys?.length) continue;
      addFlag(out, code, { combo_keys: [l.combo_key] });
      added = true;
    }
  }
  return added ? sortedFlags(out) : [...kept];
}

/** The workspace's lists (§7): every row, the candidates, those ready to apply, the estimated, their flags, those whose refresh moves a price or takes in real measures, the paused and the confirmed. */
export const LIST_FILTERS = ['all', 'candidate', 'ready', 'estimated', 'flags', 'refresh', 'paused', 'confirmed'] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

/** Codes and measure sources as SQL text literals ([A-Za-z_] only). */
const sqlTexts = (values: readonly string[]) => values.filter((c) => /^[A-Za-z_]+$/.test(c)).map((c) => `'${c}'`).join(', ');
const LINE_SHOWN_SQL = sqlTexts(LINE_SHOWN);
const HARD_SQL = sqlTexts(HARD_CODES);
const REAL_SQL = sqlTexts(REAL_MEASURES);
const PACKAGED_SQL = sqlTexts(PACKAGED_MEASURES);
/** A stored entry `f` as `parseFlags` reads it: its code (an object's text `code`, or a non-empty bare code) and its combo keys (an array). */
const ENTRY_CODE_SQL =
  "(CASE f.type WHEN 'object' THEN CASE json_type(f.value, '$.code') WHEN 'text' THEN json_extract(f.value, '$.code') END WHEN 'text' THEN NULLIF(f.value, '') END)";
const ENTRY_KEYS_SQL =
  "COALESCE(CASE f.type WHEN 'object' THEN CASE json_type(f.value, '$.combo_keys') WHEN 'array' THEN json_extract(f.value, '$.combo_keys') END END, '[]')";
/** `e.applied_wire_json` when `parseAppliedWire` reads its inputs (version 1, an array of them), else NULL. */
const APPLIED_SQL =
  "CASE WHEN json_valid(e.applied_wire_json) THEN CASE WHEN json_type(e.applied_wire_json, '$.v') IN ('integer', 'real') AND json_extract(e.applied_wire_json, '$.v') = 1 AND json_type(e.applied_wire_json, '$.inputs') = 'array' THEN e.applied_wire_json END END";
/** `typeCbmHidesBox` of the row `e`: its product's base row of the owner's origin, against the base `manual_cbm` its record holds. */
const TYPE_CBM_HIDES_BOX_SQL = `EXISTS (SELECT 1 FROM pricing_inputs b, json_each(${APPLIED_SQL}, '$.inputs') r
      WHERE b.product_id = e.product_id AND b.scope = 'base' AND b.scope_id = '' AND b.origin = 'MANUAL_OVERRIDE' AND b.manual_cbm IS NOT NULL
        AND b.shipping_length_mm IS NOT NULL AND b.shipping_width_mm IS NOT NULL AND b.shipping_height_mm IS NOT NULL
        AND r.type = 'object' AND json_extract(r.value, '$.scope') = 'base' AND (json_type(r.value, '$.scope_id') IS NULL OR json_extract(r.value, '$.scope_id') = '')
        AND json_extract(r.value, '$.field') = 'manual_cbm' AND json_extract(r.value, '$.source') = 'type_default'
        AND json_type(r.value, '$.value') = 'text' AND CAST(json_extract(r.value, '$.value') AS REAL) = CAST(b.manual_cbm AS REAL))`;
/**
 * Line `l`'s SKU has one of `fields` decided above the product level by an owner's pricing row that reaches it (its
 * SKU, colour or option): that level decides the measure whole or fails, so the product level never reaches it
 * (`decideMostSpecific`).
 */
const decidedAboveSql = (fields: readonly string[]) => `EXISTS (SELECT 1 FROM pricing_inputs n WHERE n.product_id = e.product_id AND n.origin = 'MANUAL_OVERRIDE' AND n.scope <> 'base'
        AND (${fields.map((c) => `n.${c} IS NOT NULL`).join(' OR ')})
        AND CASE n.scope WHEN 'sku' THEN n.scope_id = l.combo_key
                         WHEN 'color' THEN instr('|' || l.combo_key || '|', '|c:' || n.scope_id || '|') > 0
                         WHEN 'option' THEN instr('|' || l.combo_key || '|', '|o:' || n.scope_id || '|') > 0 ELSE 0 END)`;
/** `boxDecidedAbove` of line `l`'s SKU: a CBM field (`cbmCell`). */
const BOX_DECIDED_ABOVE_SQL = decidedAboveSql(['manual_cbm', 'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm']);
/** The same for the weight (`weightCell`). */
const WEIGHT_DECIDED_ABOVE_SQL = decidedAboveSql(['pricing_weight_g', 'shipping_weight_g']);
/** `stale` of the row `e`: an owner's pricing row of its product written after its latest lines. */
const STALE_SQL = "EXISTS (SELECT 1 FROM pricing_inputs i WHERE i.product_id = e.product_id AND i.origin = 'MANUAL_OVERRIDE' AND i.updated_at > e.computed_at)";
/** Line `l` shows entry `f`'s measure real for its SKU (`shownFlags`'s proof), `boxProof` the condition on `l` that does so for the box. */
const realLineSql = (boxProof: string) => `(l.measure_source IN (${REAL_SQL}) AND (${ENTRY_CODE_SQL} <> 'EST_DEFAULT_BOX' OR ${boxProof}))`;
/** The box's proof: a real line; while the type's CBM decides the product level, a package's line or a SKU whose CBM a level above decides. */
const BOX_REAL_SQL = `l.measure_source IN (${REAL_SQL})`;
const BOX_HIDDEN_SQL = `(l.measure_source IN (${PACKAGED_SQL}) OR ${BOX_DECIDED_ABOVE_SQL})`;
/** A row's default-measure entry still shown (`shownFlags`): on a SKU no line shows real; naming no SKU, unless every line does. */
const hardShownSql = (boxProof: string) => `EXISTS (SELECT 1 FROM json_each(e.flags_json) f WHERE ${ENTRY_CODE_SQL} IN (${HARD_SQL}) AND CASE
         WHEN EXISTS (SELECT 1 FROM json_each(${ENTRY_KEYS_SQL}) k WHERE k.type = 'text')
           THEN EXISTS (SELECT 1 FROM json_each(${ENTRY_KEYS_SQL}) k WHERE k.type = 'text' AND NOT EXISTS (
             SELECT 1 FROM price_estimate_lines l WHERE l.product_id = e.product_id AND l.combo_key = k.value AND ${realLineSql(boxProof)}))
         ELSE NOT EXISTS (SELECT 1 FROM price_estimate_lines l WHERE l.product_id = e.product_id)
           OR EXISTS (SELECT 1 FROM price_estimate_lines l WHERE l.product_id = e.product_id AND NOT ${realLineSql(boxProof)})
       END)`;
/** The row `e`'s product's own package as `productPackageOf` reads it: a whole positive weight; a box of three whole axes, each 1 to MAX_BOX_MM. */
const PACKAGE_WEIGHT_SQL = "EXISTS (SELECT 1 FROM products pk WHERE pk.id = e.product_id AND typeof(pk.package_weight_g) = 'integer' AND pk.package_weight_g > 0)";
const PACKAGE_BOX_SQL = `EXISTS (SELECT 1 FROM products pk WHERE pk.id = e.product_id
        AND ${['package_depth_mm', 'package_width_mm', 'package_height_mm'].map((c) => `typeof(pk.${c}) = 'integer' AND pk.${c} BETWEEN 1 AND ${MAX_BOX_MM}`).join(' AND ')})`;
/** The recorded value at `path` of record entry `r` (a JSON number) is the one base row `b` holds in `column`. */
const heldSql = (column: string, path: string) => `json_type(r.value, '${path}') IN ('integer', 'real') AND ${column} = json_extract(r.value, '${path}')`;
/**
 * The next apply puts the product's own package in place of the type's default `measure`, at the product level
 * (`planEstimateInputs` step 3, `mergeFields`): the last apply recorded that base field as the type's default, the
 * store still holds that very value there (the estimator's, §4.5), and the package now has that measure — the weight
 * for EST_DEFAULT_WEIGHT, the box for EST_DEFAULT_BOX (in place of the type's box, or of its CBM written as
 * `manual_cbm`). Read as `parseAppliedWire` reads the record, the CBM compared as `typeCbmHidesBox`.
 */
const packageReplacesSql = (measure: 'EST_DEFAULT_WEIGHT' | 'EST_DEFAULT_BOX') => `EXISTS (SELECT 1 FROM pricing_inputs b, json_each(${APPLIED_SQL}, '$.inputs') r
      WHERE b.product_id = e.product_id AND b.scope = 'base' AND b.scope_id = '' AND b.origin = 'MANUAL_OVERRIDE'
        AND r.type = 'object' AND json_extract(r.value, '$.scope') = 'base' AND (json_type(r.value, '$.scope_id') IS NULL OR json_extract(r.value, '$.scope_id') = '')
        AND json_extract(r.value, '$.source') = 'type_default' AND ${
          measure === 'EST_DEFAULT_WEIGHT'
            ? // An owner's pricing weight there decides the level before the shipping weight (`weightCell`).
              `json_extract(r.value, '$.field') = 'shipping_weight_g' AND b.pricing_weight_g IS NULL AND ${heldSql('b.shipping_weight_g', '$.value')} AND ${PACKAGE_WEIGHT_SQL}`
            : // An owner's manual CBM there decides the level before any box (`cbmCell`, LD6), so the box changes nothing.
              `${PACKAGE_BOX_SQL} AND CASE json_extract(r.value, '$.field')
            WHEN 'shipping_box' THEN b.manual_cbm IS NULL AND json_type(r.value, '$.value') = 'array' AND json_array_length(r.value, '$.value') = 3 AND ${heldSql('b.shipping_length_mm', '$.value[0]')}
              AND ${heldSql('b.shipping_width_mm', '$.value[1]')} AND ${heldSql('b.shipping_height_mm', '$.value[2]')}
            WHEN 'manual_cbm' THEN json_type(r.value, '$.value') = 'text' AND CAST(json_extract(r.value, '$.value') AS REAL) = CAST(b.manual_cbm AS REAL)
            ELSE 0 END`
        })`;
/**
 * Real measures that wait on the product's package: the next apply puts it in place of the type's default weight or
 * box at the product level (`packageReplacesSql`), and that measure reaches a SKU whose latest line is on the package
 * (no owner's row above the product level decides it). Read from the record and the store, never from how the row's
 * entries are stored: a line on the package says only that the weaker of its two measures is the package's, which
 * an earlier apply may already have taken in — and a re-apply that takes nothing in still makes every confirmed
 * option an estimate again. A colour's or model's own package deciding that measure is not read here (it errs
 * toward listing).
 */
const packageReachesSql = (above: string) =>
  `EXISTS (SELECT 1 FROM price_estimate_lines l WHERE l.product_id = e.product_id AND l.measure_source = 'product' AND NOT ${above})`;
const PACKAGE_WAITS_SQL = `((${packageReplacesSql('EST_DEFAULT_WEIGHT')}) AND ${packageReachesSql(WEIGHT_DECIDED_ABOVE_SQL)})
       OR ((${packageReplacesSql('EST_DEFAULT_BOX')}) AND ${packageReachesSql(BOX_DECIDED_ABOVE_SQL)})`;
/** While the type's CBM decides the product level: a latest line whose box it still decides — neither a package's line nor a SKU whose CBM a level above decides (`shownFlags`'s proof). */
const TYPE_CBM_WAITS_SQL = `${TYPE_CBM_HIDES_BOX_SQL} AND EXISTS (SELECT 1 FROM price_estimate_lines l WHERE l.product_id = e.product_id AND NOT ${BOX_HIDDEN_SQL})`;

const LIST_WHERE: Readonly<Record<ListFilter, string>> = {
  all: '1',
  candidate: "e.state = 'candidate'",
  // A hash is stored only for a preview with no blocking flag (`fullPreview`).
  ready: "e.state = 'candidate' AND e.preview_hash IS NOT NULL",
  estimated: "e.state = 'estimated'",
  // A labelled product with a flag to show, exactly as `shownFlags` shows it: a row's flag other than a default
  // measure; a row's default measure — any, once an owner's pricing row was written after the lines; else on a SKU
  // no line shows real (naming no SKU: unless every line does), for the box while the type's CBM decides the
  // product level only a package's line or a level above deciding the SKU's CBM; a line's default measure or
  // catalogue word.
  flags: `e.state = 'estimated' AND (
    EXISTS (SELECT 1 FROM json_each(e.flags_json) f WHERE ${ENTRY_CODE_SQL} NOT IN (${HARD_SQL}))
    OR CASE WHEN ${STALE_SQL} THEN EXISTS (SELECT 1 FROM json_each(e.flags_json) f WHERE ${ENTRY_CODE_SQL} IN (${HARD_SQL}))
            WHEN ${TYPE_CBM_HIDES_BOX_SQL} THEN ${hardShownSql(BOX_HIDDEN_SQL)} ELSE ${hardShownSql(BOX_REAL_SQL)} END
    OR EXISTS (SELECT 1 FROM price_estimate_lines l, json_each(l.flags_json) j WHERE l.product_id = e.product_id AND j.value IN (${LINE_SHOWN_SQL})))`,
  // A refresh that moves a price, or whose apply puts real measures in place of a type default even with no price
  // moved (§4.9 refuses until then): the type's CBM still decides some option's box (`TYPE_CBM_WAITS_SQL`), or the
  // product's package waits (`PACKAGE_WAITS_SQL`). That apply leaves neither, so the product leaves the list until a
  // price moves or more real measures wait — an apply that takes nothing in is never offered, since it would make
  // every confirmed option an estimate again.
  refresh: `e.state = 'estimated' AND e.preview_hash IS NOT NULL AND (
    EXISTS (SELECT 1 FROM price_estimate_lines l WHERE l.product_id = e.product_id AND l.est_price_iqd IS NOT l.published_price_iqd)
    OR (${TYPE_CBM_WAITS_SQL}) OR (${PACKAGE_WAITS_SQL}))`,
  paused: "e.state = 'paused'",
  confirmed: "e.state = 'confirmed'",
};

/** For one product: does «التحديث» list it now, and was an owner's pricing row written after its latest lines (`stale`)? */
export async function refreshStateOf(db: D1Database, pid: string): Promise<{ listed: boolean; stale: boolean }> {
  const r = await db
    .prepare(`SELECT (${LIST_WHERE.refresh}) AS listed, (${STALE_SQL}) AS stale FROM product_price_estimates e WHERE e.product_id = ?`)
    .bind(pid)
    .first<{ listed: number | null; stale: number | null }>();
  return { listed: Number(r?.listed) === 1, stale: Number(r?.stale) === 1 };
}

/** One product's stored estimate as the workspace reads it (owner-only). */
export interface StoredEstimate {
  product_id: string;
  name: string;
  slug: string;
  label: boolean;
  state: ProductEstimateRow['state'];
  type: string | null;
  type_source: TypeSource;
  sourcing_override: ProductEstimateRow['sourcing_override'];
  route_override: ProductEstimateRow['route_override'];
  measure_basis: ProductEstimateRow['measure_basis'];
  flags: StoredFlag[];
  preview_hash: string | null;
  computed_at: string | null;
  applied_at: string | null;
  confirmed_at: string | null;
  version: number;
  lines: EstimateLine[];
}

const pctOf = (from: number | null, to: number | null): string | null => {
  if (!from || to === null) return null;
  const q = ((to - from) * 10_000) / from;
  return ((Math.round(Math.abs(q)) * Math.sign(q)) / 100).toFixed(2);
};

/**
 * The owner's pricing rows of the page's labelled products, every scope (one statement): their CBM fields
 * (`typeCbmHidesBox` at the base, `boxDecidedAbove` above it) and when each was written (`stale`).
 */
const STORE_ROWS_SQL = `SELECT product_id, scope, scope_id, manual_cbm, shipping_length_mm, shipping_width_mm, shipping_height_mm, updated_at FROM pricing_inputs
  WHERE origin = 'MANUAL_OVERRIDE' AND product_id IN (SELECT value FROM json_each(?))`;
type StoreRow = BaseCbmRow & { product_id: string; scope: string; scope_id: string; updated_at: unknown };

/** What `shownFlags` reads of one labelled product's store, from its rows and the time of its latest lines. */
function storeOf(rows: readonly StoreRow[], e: ProductEstimateRow): ShownStore {
  const above = rows.filter((r) => r.scope !== 'base' && holdsCbm(r));
  const written = rows.map((r) => String(r.updated_at ?? '')).reduce((a, b) => (b > a ? b : a), '');
  return {
    typeCbmHidesBox: typeCbmHidesBox(e.applied_wire_json, rows.find((r) => r.scope === 'base' && r.scope_id === '') ?? null),
    boxDecidedAbove: (comboKey) => above.some((r) => reachesSku(r.scope, r.scope_id, comboKey)),
    stale: e.computed_at !== null && written > e.computed_at,
  };
}

/** Stored rows and their lines, in one statement each; for a labelled product, its pricing rows too (`shownFlags`). */
async function storedEstimates(db: D1Database, rows: readonly Record<string, unknown>[]): Promise<StoredEstimate[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.product_id));
  const labelled = rows.map(estimateRowOf).filter((e) => e.state === 'estimated' || e.state === 'paused').map((e) => e.product_id);
  const [{ results: lineRows }, control, storeRows] = await Promise.all([
    db
      .prepare('SELECT * FROM price_estimate_lines WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY product_id, combo_key, channel')
      .bind(JSON.stringify(ids))
      .all<Record<string, unknown>>(),
    loadEngineControl(db),
    labelled.length ? db.prepare(STORE_ROWS_SQL).bind(JSON.stringify(labelled)).all<StoreRow>().then((r) => r.results ?? []) : [],
  ]);
  const stores = new Map<string, StoreRow[]>();
  for (const s of storeRows) {
    const pid = String(s.product_id);
    if (!stores.has(pid)) stores.set(pid, []);
    stores.get(pid)!.push(s);
  }
  const byProduct = new Map<string, EstimateLine[]>();
  for (const l of lineRows ?? []) {
    const pid = String(l.product_id);
    const published = l.published_price_iqd === null || l.published_price_iqd === undefined ? null : Number(l.published_price_iqd);
    const est = l.est_price_iqd === null || l.est_price_iqd === undefined ? null : Number(l.est_price_iqd);
    const large = !!published && est !== null && (Math.abs(est - published) * 100 > control.large_change_pct * published || (published - est) * 100 > control.max_drop_pct * published);
    if (!byProduct.has(pid)) byProduct.set(pid, []);
    byProduct.get(pid)!.push({
      combo_key: String(l.combo_key),
      channel: String(l.channel) as EstimateLine['channel'],
      source: String(l.price_source) as LinePriceSource,
      supplier_amount: l.supplier_amount === null || l.supplier_amount === undefined ? null : String(l.supplier_amount),
      supplier_currency: (l.supplier_currency ?? null) as EstimateLine['supplier_currency'],
      measure_source: String(l.measure_source) as EstimateLine['measure_source'],
      flags: parseFlags(l.flags_json).map((f) => f.code),
      est_cost_iqd: l.est_cost_iqd === null || l.est_cost_iqd === undefined ? null : Number(l.est_cost_iqd),
      est_price_iqd: est,
      published_price_iqd: published,
      change_pct: pctOf(published, est),
      large,
    });
  }
  return rows.map((r) => {
    const e = estimateRowOf(r);
    const lines = byProduct.get(e.product_id) ?? [];
    return {
      product_id: e.product_id,
      name: String(r.product_name ?? ''),
      slug: String(r.product_slug ?? ''),
      label: Number(r.product_label) === 1,
      state: e.state,
      type: e.type_key,
      type_source: e.type_source,
      sourcing_override: e.sourcing_override,
      route_override: e.route_override,
      measure_basis: e.measure_basis,
      flags: shownFlags(e.state, parseFlags(e.flags_json), lines, storeOf(stores.get(e.product_id) ?? [], e)),
      preview_hash: e.preview_hash,
      computed_at: e.computed_at,
      applied_at: e.applied_at,
      confirmed_at: e.confirmed_at,
      version: e.version,
      lines,
    };
  });
}

const STORED_SELECT = `SELECT e.*, p.name AS product_name, p.slug AS product_slug, p.price_estimate AS product_label
  FROM product_price_estimates e JOIN products p ON p.id = e.product_id`;

/** GET /estimates/products?state=&cursor=: one page of stored estimates (25), ordered by product id. */
export async function listEstimates(db: D1Database, filter: ListFilter, cursor: string): Promise<{ products: StoredEstimate[]; next_cursor: string | null }> {
  const { results } = await db
    .prepare(`${STORED_SELECT} WHERE e.product_id > ? AND (${LIST_WHERE[filter]}) ORDER BY e.product_id LIMIT ?`)
    .bind(cursor, ESTIMATE_LIST_PAGE + 1)
    .all<Record<string, unknown>>();
  const rows = results ?? [];
  const more = rows.length > ESTIMATE_LIST_PAGE;
  const page = rows.slice(0, ESTIMATE_LIST_PAGE);
  return { products: await storedEstimates(db, page), next_cursor: more ? String(page[page.length - 1]!.product_id) : null };
}

/** GET /estimates/products/:id: one product's stored estimate, or null. */
export async function storedEstimateOf(db: D1Database, pid: string): Promise<StoredEstimate | null> {
  const row = await db.prepare(`${STORED_SELECT} WHERE e.product_id = ?`).bind(pid).first<Record<string, unknown>>();
  return row ? ((await storedEstimates(db, [row]))[0] ?? null) : null;
}
