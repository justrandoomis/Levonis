/**
 * PRICING V2-3b — THE OWNER'S AND THE PRICE EDITORS' V2 PRICING API
 * (implementation spec §4; docs/PRICING-V2.md §2.6, §2.7, §2.10; owner
 * decisions A1, B1, C1, D1, DECISIONS row 221; C-7, C-13, C-14).
 *
 * The product routes (worker/routes/adminProducts.ts) answer through here:
 *   - GET  /api/admin/products-v2/:id/pricing      the V2 state of a product
 *   - POST /api/admin/products-v2/pricing/preview  draft-capable, writes nothing
 *   - PUT  /api/admin/products-v2/:id/pricing      prices-only apply
 *   - POST /api/admin/products-v2 with `pricing_v2` structure + prices, one batch
 *
 * ROLES (§4.4 as amended by the owner's answer Q2, DECISIONS row 222 —
 * spec addendum A.1), enforced per FIELD from the request alone:
 *   - the OWNER (the verified owner: cost read and write) edits the method, the
 *     dollar price points, the pre-order discounts and the cost inputs and
 *     minimum profit, and reads every private figure (`v2_*`);
 *   - a PRICE EDITOR (every other admin — whoever may edit products today) on
 *     a price-first («سعر بالدولار») product reads and writes the same DOLLAR
 *     price points and discounts the owner does (`V2_STAFF_SEES_USD`), under
 *     keys outside FINANCIAL_FIELDS (`editor_usd`); never the method, a cost
 *     input, the minimum profit or anything derived from cost. On a
 *     cost-first product they read the final dinars and may change structure
 *     only (the save reprices from cost): a price write there is 403
 *     PRICING_V2_OWNER_ONLY {section: 3}. A product with no method yet (the
 *     clean start's «يحتاج تسعيرًا») is priced by an editor as price-first;
 *   - a cost field (or the method) from an editor is refused with 403
 *     COST_ACCESS_DENIED naming the FIELDS (never a value); `intents` (the
 *     superseded dinar intents) is 400 PRICING_INPUT_INVALID for everyone.
 *
 * THE GATES (§4.3), in order: a replayed hash answers `already`; the sequence
 * the client read must still be the stored one (PRICING_CHANGED); a price
 * change needs the preview's hash (PRICING_PREVIEW_REQUIRED / _STALE, each
 * carrying the fresh preview); a change above 15% (a drop above 30% is one)
 * needs the tick (PRICING_LARGE_CHANGE_CONFIRM) and a fresh sign-in
 * (REAUTH_REQUIRED); an incomplete evaluation saves its data only — a new
 * product is born V2 and hidden, an existing one keeps its last good prices —
 * and publishing an incomplete product is PRICING_V2_PRICE_MISSING. Every
 * refusal names its section (3 = «الأسعار», 5 = «الخيارات والألوان»).
 *
 * PRIVATE: every dollar figure, the rate, R, T, the floor and the cost inputs
 * are the owner's; nothing here logs a value.
 */
import type { Context } from 'hono';
import { procurementExactText, type ProcurementExact } from '@levonis/contracts/procurementCost';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { parseV2Usd, V2_SCOPES, type V2Discount, type V2Method, type V2PricePoint, type V2Scope } from '@levonis/pricing/priceV2';
import type { AppContext, Env } from '../../types';
import { HttpError } from '../../http';
import { canViewCost, canWriteCost, costRefusal, type CostSubject } from '../../costAccess';
import { V2_STAFF_SEES_USD } from '../../adminScope';
import { FRESH_SESSION_SECONDS, sessionAgeSeconds } from '../../session';
import { sha256Hex } from '../../crypto';
import { strictBody } from '../../fx/ownerActs';
import type { PricingContext } from '../../../routes/cart';
import { loadPreviewContext, loadProducts, type LoadedProduct } from '../load';
import { loadPricingRates, type PricingRates } from '../rates';
import { loadProductsPricing, type InputWrite, type ProductPricingData, type RuleWrite } from '../store';
import { isFenceMiss } from '../../operations';
import { engineCoreInstalled } from '../../engineInstalled';
import { importStockNotConfigured, importStockRefusal, isImportStockMiss } from '../../importStock';
import { loadEngineControl, priceImageOf, withRuleIds, type EngineControl } from '../engineWrite';
import { effectiveWrites, FORM_INPUT_FIELDS, formOptionIds, parseProductInputs } from '../productInputs';
import { parseRuleWrites } from '../ownerRules';
import { canonical, unitRuleTarget } from '../procurementPreview';
import { resolveRuleAt, type PricingRuleRow } from '@levonis/pricing/ruleResolution';
import { inputInvalid } from '../whatIf';
import { sellableSkus } from '../legacy';
import { evaluateV2Write, type V2Evaluation } from './evaluate';
import { discountsOf, loadV2Store, pointsOf, type V2Store } from './store';
import { v2EditorAnswer, v2OwnerAnswer } from './dto';
import { firstWriteInputs, pendingReviewsOf, reviewFoldInputs, withFirstWriteInputs, type FirstWriteReview } from './firstWrite';
import { loadShelves, type ProductShelf } from './shelf';

/* ------------------------------------------------------------------ who -- */

/** Who reads a V2 answer: the verified owner, or any other admin (a price editor). */
export type V2Viewer = 'owner' | 'editor';

export function v2ViewerOf(env: Env, user: CostSubject | null | undefined): V2Viewer {
  return canViewCost(env, user) && canWriteCost(env, user) ? 'owner' : 'editor';
}

/** The section a refusal names: 3 «الأسعار» (product-level prices), 5 «الخيارات والألوان» (a model, colour or SKU). */
const sectionOf = (scope: V2Scope | 'product' | null | undefined): 3 | 5 => (!scope || scope === 'product' ? 3 : 5);

const refusal = (status: number, code: Parameters<typeof serverMessage>[0], details: Record<string, unknown> = {}) =>
  new HttpError(status, serverMessage(code), code, { section: 3, ...details });

/* ----------------------------------------------------------------- reads -- */

/** Everything one V2 evaluation reads, as a route reads it. */
export interface V2Read {
  loaded: LoadedProduct;
  stored: ProductPricingData;
  v2: V2Store | null;
  ctx: PricingContext;
  rates: PricingRates | null;
  control: EngineControl;
  image: string;
  /** A product with no method yet: its pending purchase reviews (D1, row 247), folded into the owner's prefill. */
  review?: FirstWriteReview | null;
  /** The product's shelf (DECISIONS row 244): cost-first, a model with stock is priced from its costliest batch. */
  shelf?: ProductShelf | null;
}

/**
 * The stored product (or, with `draft`, the document the request would save)
 * and its pricing store, the guest pricing context, the last confirmed central
 * rates, the control row and the price image. Null for an unknown product.
 */
export async function loadV2Read(db: D1Database, productId: string, draft?: LoadedProduct): Promise<V2Read | null> {
  const loaded = draft ?? (await loadProducts(db, [productId])).get(productId) ?? null;
  if (!loaded) return null;
  // The stores' batches and the rates' batch one after another (never two batches at once); the settings,
  // the price image and the shelf (row 244, one statement) beside them — every save, preview and apply
  // waits on this read (round trips measured by tests/adminSaveRoundTrips.test.ts).
  const [{ stored, v2, control, rates }, ctx, image, shelves] = await Promise.all([
    loadV2Stores(db, [productId]).then(async (s) => ({ ...s, rates: await loadPricingRates(db) })),
    loadPreviewContext(db),
    priceImageOf(db, productId),
    loadShelves(db, [productId]),
  ]);
  const own = stored.get(productId)!;
  const review = storedMethodOf({ stored: own }) ? null : await pendingReviewsOf(db, productId);
  const shelf = shelves.get(productId) ?? null;
  return { loaded, stored: own, v2: v2.get(productId) ?? null, ctx, rates, control, image, review, shelf };
}

/** The engine control's defaults (0181's seeded row), for a database without it. */
const NO_ENGINE_CONTROL: EngineControl = { paused: false, large_change_pct: 15, max_drop_pct: 30 };

/**
 * The engine and V2 stores of several products, one read after another (never
 * two batches at once). A database before 0181 (a deploy ahead of its
 * migration) has no engine store at all: every product reads as unmigrated
 * and unstored, exactly as on a migrated database with no row, so every V2
 * read answers the same there (tests/costDeployAhead, tests/fxDeployAhead).
 */
export async function loadV2Stores(
  db: D1Database,
  ids: readonly string[]
): Promise<{ stored: Map<string, ProductPricingData>; v2: Map<string, V2Store | null>; control: EngineControl }> {
  if (!(await engineCoreInstalled(db))) {
    const stored = new Map<string, ProductPricingData>();
    const v2 = new Map<string, V2Store | null>();
    for (const id of ids) {
      stored.set(id, { product_id: id, state: null, inputs: [], rules: [], config_version: 0, direct_purchase: null, direct_purchase_available: false });
      v2.set(id, null);
    }
    return { stored, v2, control: NO_ENGINE_CONTROL };
  }
  // The control row is a plain read: it goes beside the first batch.
  const [stored, control] = await Promise.all([loadProductsPricing(db, ids), loadEngineControl(db)]);
  const v2 = await loadV2Store(db, ids);
  return { stored, v2, control };
}

/**
 * A V2 route's request body (and any object inside it): an extra key is
 * refused by name (UNKNOWN_FIELD) — the engine's one strict parser, so the
 * product router imports nothing of FX for it.
 */
export const v2Body = (raw: unknown, allowed: readonly string[]): Record<string, unknown> => strictBody(raw, allowed);

/** The product's V2 method today, or null (not V2: unmigrated, or new). */
export const storedMethodOf = (read: Pick<V2Read, 'stored'>): V2Method | null =>
  read.stored.state?.mode === 'engine' ? (read.stored.state.pricing_method ?? null) : null;

/* ------------------------------------------------------------- the wire -- */

/** The request's pricing block (§4.2 `V2DraftWire`), its shape checked; ids and values are checked against the product later. */
export interface V2Wire {
  method?: V2Method;
  points?: V2PricePoint[];
  discounts?: V2Discount[];
  cost?: { inputs?: unknown; minimum_profit?: unknown };
  /** Which keys the request carried (names only — what a non-owner is refused for). */
  sent: string[];
}

const MAX_ROWS = 400;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScope = (v: unknown): v is V2Scope => typeof v === 'string' && (V2_SCOPES as readonly string[]).includes(v);

/** The 0189 CHECK of each scope: the product a fixed price, a model fixed or ±, a colour ± only, an SKU fixed only. */
const KIND_AT: Readonly<Record<V2Scope, ReadonlyArray<'fixed' | 'delta'>>> = { product: ['fixed'], option: ['fixed', 'delta'], color: ['delta'], sku: ['fixed'] };

const usdText = (x: ProcurementExact): string => procurementExactText(x);

function scopeIdOf(raw: Record<string, unknown>, scope: V2Scope, field: string): string {
  const id = raw.id ?? raw.scope_id;
  if (scope === 'product') {
    if (id !== undefined && id !== null && id !== '') throw inputInvalid(`${field}.id`);
    return '';
  }
  if (typeof id !== 'string' || !id || id.length > 400) throw inputInvalid(`${field}.id`);
  return id;
}

function parsePoints(raw: unknown): V2PricePoint[] {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw inputInvalid('points');
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const r = strictBody(entry, ['scope', 'id', 'scope_id', 'kind', 'usd']);
    const field = `points[${i}]`;
    if (!isScope(r.scope)) throw inputInvalid(`${field}.scope`);
    const scope = r.scope;
    const id = scopeIdOf(r, scope, field);
    if (r.kind !== 'fixed' && r.kind !== 'delta') throw inputInvalid(`${field}.kind`);
    if (!KIND_AT[scope].includes(r.kind)) throw refusal(400, 'PRICING_V2_SCOPE_INVALID', { section: sectionOf(scope), scope, id, field: `${field}.kind` });
    const usd = typeof r.usd === 'string' ? parseV2Usd(r.usd.trim(), { signed: r.kind === 'delta' }) : null;
    if (!usd) throw inputInvalid(`${field}.usd`);
    const key = `${scope}\u0000${id}`;
    if (seen.has(key)) throw inputInvalid(field);
    seen.add(key);
    return { scope, scope_id: id, kind: r.kind, usd: usdText(usd) };
  });
}

function parseDiscounts(raw: unknown): V2Discount[] {
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw inputInvalid('discounts');
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    const r = strictBody(entry, ['scope', 'id', 'scope_id', 'usd']);
    const field = `discounts[${i}]`;
    if (!isScope(r.scope)) throw inputInvalid(`${field}.scope`);
    const scope = r.scope;
    const id = scopeIdOf(r, scope, field);
    const usd = typeof r.usd === 'string' ? parseV2Usd(r.usd.trim(), { zero: true }) : null;
    if (!usd) throw inputInvalid(`${field}.usd`);
    const key = `${scope}\u0000${id}`;
    if (seen.has(key)) throw inputInvalid(field);
    seen.add(key);
    return { scope, scope_id: id, usd: usdText(usd) };
  });
}

/** Parse the pricing block's SHAPE (absent block = nothing sent). Values are judged per role in `desiredFor`. */
export function parseV2Wire(raw: unknown): V2Wire {
  if (raw === undefined || raw === null) return { sent: [] };
  if (!isRecord(raw)) throw inputInvalid('pricing');
  // The dinar intents of the first V2-3b draft are gone (owner answer Q2): everyone sends dollars.
  if ('intents' in raw) throw inputInvalid('intents');
  const r = strictBody(raw, ['method', 'points', 'discounts', 'cost']);
  const sent = Object.keys(r).filter((k) => r[k] !== undefined);
  const out: V2Wire = { sent };
  if (r.method !== undefined) {
    if (r.method !== 'cost' && r.method !== 'usd') throw inputInvalid('method');
    out.method = r.method;
  }
  if (r.points !== undefined) out.points = parsePoints(r.points);
  if (r.discounts !== undefined) out.discounts = parseDiscounts(r.discounts);
  if (r.cost !== undefined) {
    const cost = strictBody(r.cost, ['inputs', 'minimum_profit']);
    out.cost = { inputs: cost.inputs, minimum_profit: cost.minimum_profit };
    sent.splice(sent.indexOf('cost'), 1, ...(['inputs', 'minimum_profit'] as const).filter((k) => cost[k] !== undefined).map((k) => `cost.${k}`));
  }
  return out;
}

/* ---------------------------------------------------------- the desired -- */

/** The set an evaluation prices: the store with the request laid over it. */
export interface V2Desired {
  method: V2Method;
  points: V2PricePoint[];
  discounts: V2Discount[];
  inputWrites: InputWrite[];
  ruleWrites: RuleWrite[];
  /** A price editor's evaluation: its hash binds no cost value (C-14, `evaluateV2Write`'s `opaqueCost`). */
  opaqueCost?: boolean;
}

/** The ids each scope may name on this product (the draft's, when a draft is priced). */
function scopeIdsOf(loaded: LoadedProduct): Record<Exclude<V2Scope, 'product'>, Set<string>> {
  const skus = sellableSkus(loaded.doc, loaded.view).skus.map((s) => s.combo_key).filter((k) => k !== '');
  return {
    option: formOptionIds(loaded),
    color: new Set(loaded.doc.colors.map((c) => c.id)),
    sku: new Set(skus),
  };
}

function checkScopes(rows: ReadonlyArray<{ scope: V2Scope; scope_id: string }>, ids: Record<Exclude<V2Scope, 'product'>, Set<string>>): void {
  for (const r of rows) {
    if (r.scope === 'product') continue;
    if (!ids[r.scope].has(r.scope_id)) throw refusal(400, 'PRICING_V2_SCOPE_INVALID', { section: sectionOf(r.scope), scope: r.scope, id: r.scope_id });
  }
}

/** `cost.minimum_profit`: a dollar text (the product's), null (inherit), or rule rows — the minimum profit only (C-4). */
function minimumProfitRules(raw: unknown): unknown[] {
  if (raw === null || typeof raw === 'string') return [{ kind: 'target_profit', scope: 'product', amount_usd: raw }];
  if (!Array.isArray(raw)) throw inputInvalid('minimum_profit');
  return raw.map((entry, i) => {
    const r = strictBody(entry, ['kind', 'scope', 'scope_id', 'amount_usd']);
    if (r.kind === 'direct_sale_extra') throw refusal(400, 'PRICING_V2_FEES_RETIRED', { field: `minimum_profit[${i}].kind` });
    if (r.kind !== undefined && r.kind !== 'target_profit') throw inputInvalid(`minimum_profit[${i}].kind`);
    return { kind: 'target_profit', scope: r.scope ?? 'product', ...(r.scope_id !== undefined ? { scope_id: r.scope_id } : {}), amount_usd: r.amount_usd };
  });
}

export interface DesiredOptions {
  viewer: V2Viewer;
  env: Env;
  user: CostSubject | null | undefined;
  now: string;
}

/**
 * The desired V2 set for one evaluation: the store with the request laid over
 * it, per role (see the file header). Refusals name fields, never values.
 *
 * A product with NO method yet (the clean start's «يحتاج تسعيرًا», addendum
 * A.7) has never had a V2 write: nothing stored seeds its dollar set, its
 * desired set is exactly what the request sends, and its 0186 purchase
 * overlay is folded into its ordinary cost inputs (`firstWriteInputs`).
 */
export function desiredFor(read: V2Read, wire: V2Wire, o: DesiredOptions): V2Desired {
  const stored = storedMethodOf(read);
  const ids = scopeIdsOf(read.loaded);
  // A stored row whose model, colour or SKU the (draft) product no longer has is dropped with it.
  const live = (r: { scope: V2Scope; scope_id: string }) => r.scope === 'product' || ids[r.scope].has(r.scope_id);
  const storedPoints = stored ? pointsOf(read.v2?.points ?? []).filter(live) : [];
  const storedDiscounts = stored ? discountsOf(read.v2?.discounts ?? []).filter(live) : [];
  // D1 (addendum A.10): the owner's prefill also carries a pending purchase review's cost inputs (newer than
  // the overlay, so laid over it); an editor's never does (an editor neither reads nor writes a cost).
  const fold = stored
    ? []
    : withFirstWriteInputs(firstWriteInputs(read.stored), o.viewer === 'owner' ? reviewFoldInputs(read.stored, read.review, (scope, id) => ids[scope].has(id)) : []);
  if (o.viewer === 'editor') {
    // Owner answer Q2: an editor prices in dollars — the points and the discounts — and never touches
    // the method or a cost field (refused by NAME, decided from the request alone). A product with no
    // method yet is priced by an editor as price-first.
    const method = stored ?? 'usd';
    const dollars = (k: string) => V2_STAFF_SEES_USD && (k === 'points' || k === 'discounts');
    const fields = wire.sent.filter((k) => !dollars(k) && !(k === 'method' && wire.method === method));
    if (fields.length) throw costRefusal(o.env, o.user, { fields });
    const money = wire.points !== undefined || wire.discounts !== undefined;
    // From cost, D is derived from R + T: a difference or a discount moved by an editor would be a cost oracle.
    if (money && method === 'cost') throw refusal(403, 'PRICING_V2_OWNER_ONLY');
    const points = wire.points ?? storedPoints;
    const discounts = wire.discounts ?? storedDiscounts;
    if (wire.points) checkScopes(points, ids);
    if (wire.discounts) checkScopes(discounts, ids);
    return { method, points, discounts, inputWrites: fold, ruleWrites: [], opaqueCost: true };
  }
  const method = wire.method ?? stored;
  if (!method) throw inputInvalid('method');
  const points = wire.points ?? storedPoints;
  const discounts = wire.discounts ?? storedDiscounts;
  // Only what the request names is judged: a stored row of a removed scope was dropped above.
  if (wire.points) checkScopes(points, ids);
  if (wire.discounts) checkScopes(discounts, ids);
  let inputWrites: InputWrite[] = [];
  let ruleWrites: RuleWrite[] = [];
  if (wire.cost) {
    const rules = wire.cost.minimum_profit === undefined ? [] : minimumProfitRules(wire.cost.minimum_profit);
    const draft = parseProductInputs({ inputs: wire.cost.inputs ?? [], rules: [] }, read.loaded, read.stored, { rates: read.rates, now: o.now });
    const ruleDraft = rules.length ? parseRuleWrites({ rules }, read.loaded.id, { option: ids.option, color: ids.color, sku: ids.sku }, read.stored) : [];
    ({ inputWrites, ruleWrites } = effectiveWrites({ inputs: draft.inputs, rules: ruleDraft, iqd: draft.iqd }));
    ruleWrites = withRuleIds(ruleWrites);
  }
  return { method, points, discounts, inputWrites: withFirstWriteInputs(fold, inputWrites), ruleWrites };
}

/**
 * The method a product with none yet is shown in (addendum A.7): from cost
 * when the owner's stored inputs price every sellable SKU from cost, else the
 * dollar price; an editor always the dollar price (Q2, Q9).
 */
export async function defaultMethodOf(read: V2Read, viewer: V2Viewer, o: DesiredOptions): Promise<V2Method> {
  if (viewer !== 'owner') return 'usd';
  const fromCost = await evaluateDesired(read, desiredFor(read, { method: 'cost', sent: ['method'] }, o));
  return fromCost.complete ? 'cost' : 'usd';
}

/* ------------------------------------------------------------- evaluate -- */

/** C-14: the sellable SKU set of what is priced (ids only), bound into the preview hash. */
export async function structureDigestOf(loaded: LoadedProduct): Promise<string> {
  const { skus, overflow } = sellableSkus(loaded.doc, loaded.view);
  return sha256Hex(canonical({ overflow, skus: skus.map((s) => s.combo_key).sort() }));
}

/** The V2 evaluation of a desired set (a preview, a write — always the same call). */
export async function evaluateDesired(read: V2Read, desired: V2Desired): Promise<V2Evaluation> {
  return evaluateV2Write({
    loaded: read.loaded,
    stored: read.stored,
    v2: read.v2,
    ctx: read.ctx,
    rates: read.rates,
    control: read.control,
    method: desired.method,
    points: desired.points,
    discounts: desired.discounts,
    inputWrites: desired.inputWrites,
    ruleWrites: desired.ruleWrites,
    image: read.image,
    // Row 244: the shelf as it is now (read with the product).
    shelf: read.shelf ?? null,
    // The answer lists every blocked route to the reader («متوقف: أقل من التكلفة»); the hash binds the set.
    acceptBlocked: true,
    structureDigest: await structureDigestOf(read.loaded),
    ...(desired.opaqueCost ? { opaqueCost: true } : {}),
  });
}

/* ---------------------------------------------------------------- answer -- */

export type V2Status =
  | { kind: 'current' }
  | { kind: 'review'; count: number }
  | { kind: 'missing'; first: V2Evaluation['missing'][number] | null }
  | { kind: 'held'; reason: 'FX_REVIEW_PENDING' | 'FX_RATE_MISSING' | 'ENGINE_PAUSED' };

export function statusOf(ev: V2Evaluation, rates: PricingRates | null): V2Status {
  if (ev.codes.includes('FX_RATE_MISSING')) return { kind: 'held', reason: 'FX_RATE_MISSING' };
  if (ev.codes.includes('PRICING_ENGINE_PAUSED')) return { kind: 'held', reason: 'ENGINE_PAUSED' };
  if (!ev.complete) return { kind: 'missing', first: ev.missing[0] ?? null };
  if (ev.changes.length && rates?.review_pending.USD_IQD) return { kind: 'held', reason: 'FX_REVIEW_PENDING' };
  if (ev.changes.length) return { kind: 'review', count: ev.changes.length };
  return { kind: 'current' };
}

/**
 * Where each SKU's price comes from (§4.2 `source`): a kind of point, never its value. `stock` (row 244: the
 * costliest batch on the shelf) is the owner's alone — to a price editor that row reads as any cost-first row.
 */
function sourceOf(ev: V2Evaluation, row: V2Evaluation['rows'][number], viewer: V2Viewer): string {
  const anchor = row.owner?.anchor ?? null;
  if (viewer === 'owner' && anchor === 'cost' && ev.rows.some((r) => r.combo_key === row.combo_key && r.channel === 'direct_sale' && r.owner?.shelf)) return 'stock';
  if (anchor === 'sku_fixed') return 'sku_fixed';
  const colour = row.color_id !== null && ev.points.some((p) => p.scope === 'color' && p.scope_id === row.color_id);
  if (colour) return 'colour_delta';
  if (anchor === 'model_fixed') return 'model_fixed';
  const model = row.option_value_ids[0] ?? null;
  if (anchor === 'product_fixed') return model && ev.points.some((p) => p.scope === 'option' && p.kind === 'delta' && row.option_value_ids.includes(p.scope_id)) ? 'model_delta' : 'product';
  if (anchor === 'cost') return model && ev.inputs.some((r) => r.scope === 'option' && r.scope_id === model) ? 'model_cost' : 'product';
  return 'product';
}

/** Which level's discount a route row inherits (§4.2 `discount_from`), or that its SKU is sold by pre-order only. */
function discountFromOf(ev: V2Evaluation, row: V2Evaluation['rows'][number]): string | undefined {
  if (row.channel === 'direct_sale') return undefined;
  const direct = ev.rows.some((r) => r.combo_key === row.combo_key && r.channel === 'direct_sale');
  if (!direct) return 'preorder_only';
  const from = row.owner?.discount_from?.scope ?? null;
  return from === null ? 'none' : from === 'option' ? 'model' : from === 'color' ? 'colour' : from;
}

export interface AnswerInput {
  viewer: V2Viewer;
  read: V2Read;
  ev: V2Evaluation;
  /** The product does not exist yet (add-product). */
  draft?: boolean;
  /** A product with no method yet: the method it is shown in (`defaultMethodOf`). */
  defaultMethod?: V2Method;
}

/**
 * The §4.2 answer, projected per role from EXPLICIT allow-lists (dto.ts): the
 * owner reads every private figure (`v2_*`); a price editor reads final dinars,
 * codes and names — plus, on a price-first product, the dollar set it may edit
 * (`editor_usd`, owner answer Q2; the owner's answer carries the same block,
 * so the form has one path).
 *
 * `needs_pricing` (the clean start, addendum A.4/A.7): the product is not
 * V2-published — no method, or a method and no complete write yet — so no
 * customer sees it.
 */
export function v2Answer(i: AnswerInput): Record<string, unknown> {
  const { ev, read, viewer } = i;
  const method = ev.method;
  const priceFirst = method === 'usd';
  const storedMethod = storedMethodOf(read);
  const dollars = viewer === 'owner' || V2_STAFF_SEES_USD;
  const base = viewer === 'owner' ? v2OwnerAnswer(ev) : v2EditorAnswer(ev);
  const table = (base.table as Array<Record<string, unknown>>).map((row, n) => {
    const r = ev.rows[n]!;
    const from = viewer === 'owner' || priceFirst ? discountFromOf(ev, r) : undefined;
    return {
      ...row,
      source: sourceOf(ev, r, viewer),
      ...(from ? { discount_from: from } : {}),
      ...(priceFirst && dollars && r.usd_exact !== null ? { editor_usd_price: r.usd_exact } : {}),
    };
  });
  const published = !!storedMethod && (read.v2?.results.length ?? 0) > 0;
  const answer: Record<string, unknown> = {
    ...base,
    product_id: i.draft ? null : ev.product_id,
    v2: !!storedMethod || i.draft === true,
    needs_pricing: !published,
    method,
    ...(storedMethod || i.draft ? {} : { default_method: i.defaultMethod ?? method }),
    seq: { inputs_seq: read.stored.state?.inputs_seq ?? 0, write_seq: read.stored.state?.write_seq ?? 0 },
    status: statusOf(ev, read.rates),
    can_edit: { money: viewer === 'owner' || (priceFirst && dollars), cost: viewer === 'owner', method: viewer === 'owner', structure: true },
    table,
    publishable: ev.complete,
  };
  if (priceFirst && dollars) {
    answer.editor_usd = {
      points: ev.points.map((p) => ({ scope: p.scope, id: p.scope_id, kind: p.kind, usd: p.usd })),
      discounts: ev.discounts.map((d) => ({ scope: d.scope, id: d.scope_id, usd: d.usd })),
    };
  }
  if (viewer === 'owner') {
    answer.v2_cost_inputs = {
      inputs: ev.inputs
        .filter((r) => !!r.scope)
        .map((r) => ({ scope: r.scope, scope_id: r.scope_id ?? '', ...Object.fromEntries(FORM_INPUT_FIELDS.map((k) => [k, (r as Record<string, unknown>)[k] ?? null])) })),
      minimum_profit: ev.stored.rules
        .filter((r) => r.product_id === ev.product_id && r.kind === 'target_profit')
        // amount_iqd: a legacy dinar rule the dollar field cannot draw — the form shows it kept, never «يتبع المنتج».
        .map((r) => ({ scope: r.scope, scope_id: r.scope_id, state: r.state, amount_usd: r.amount_usd ?? null, amount_iqd: r.amount_iqd ?? null })),
      // §2.1 rule 2: what the product's minimum profit inherits when its own field is empty (the owner's
      // placeholder «يرث ($40.00)»), resolved as the maths resolves it — never a guess.
      inherited_minimum_profit: inheritedMinimumProfit(ev.stored.rules, ev.product_id, read.rates?.usd_iqd ?? null),
      // D1: a needs-pricing product's prefill carries its pending purchase reviews (its first write applies them;
      // row 247: one per purchase, the newest named first for the older readers).
      ...(!storedMethod && read.review ? { purchase_review_id: read.review.id, purchase_review_ids: [...read.review.ids] } : {}),
    };
  }
  return answer;
}

/**
 * The minimum profit (T) the product's base SKU inherits from above its own product-scope rule (a category
 * or the store-wide rule): the product's own rows left out, the rest resolved by `resolveRuleAt` as the maths
 * does. Null when nothing above decides (the field is then required). Owner-only (`v2_cost_inputs`).
 */
export function inheritedMinimumProfit(
  rules: readonly PricingRuleRow[],
  productId: string,
  usdIqdRate: string | null
): { amount_usd: string | null; amount_iqd: number | null } | null {
  const above = rules.filter((r) => !(r.product_id === productId && r.scope === 'product' && r.kind === 'target_profit'));
  const got = resolveRuleAt(above, 'target_profit', unitRuleTarget(productId, { option_value_ids: [], color_id: null }), { usdIqdRate });
  if (got.status !== 'active') return null;
  return { amount_usd: got.amount_usd ?? null, amount_iqd: got.amount_usd ? null : got.amount_iqd };
}

/**
 * A database before 0189 (a deploy ahead of its migration): nothing can be
 * priced in V2 there, so the answer is the flag alone — never a figure.
 */
export function uninstalledAnswer(read: V2Read, viewer: V2Viewer): Record<string, unknown> {
  return {
    product_id: read.loaded.id,
    v2: false,
    needs_pricing: true,
    method: 'usd',
    default_method: 'usd',
    seq: { inputs_seq: read.stored.state?.inputs_seq ?? 0, write_seq: read.stored.state?.write_seq ?? 0 },
    status: { kind: 'missing', first: null },
    can_edit: { money: false, cost: viewer === 'owner', method: false, structure: true },
    codes: ['PRICING_NOT_INSTALLED'],
    table: [],
    missing: [{ code: 'PRICING_NOT_INSTALLED', field: null, level: null, count: 0, first_name: null }],
    publishable: false,
  };
}

/* ----------------------------------------------------------------- gates -- */

const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** The idempotency key of a V2 price write: the product and the preview's hash. */
export const v2PriceKey = (pid: string, hash: string) => `v2price:${pid}:${hash}`;

export async function v2Replayed(db: D1Database, pid: string, hash: unknown): Promise<boolean> {
  if (!isHash(hash)) return false;
  return !!(await db.prepare('SELECT 1 AS hit FROM pricing_audit WHERE idempotency_key = ?').bind(v2PriceKey(pid, hash)).first<{ hit: number }>());
}

/** A fresh sign-in, as `requireFreshSession` — the refusal names the section. */
export function requireFreshV2(c: Context<AppContext>): void {
  if (sessionAgeSeconds(c) > FRESH_SESSION_SECONDS) throw refusal(401, 'REAUTH_REQUIRED');
}

/** What a V2 save does once its gates pass. */
export type V2Verdict = 'already' | 'write' | 'data' | 'noop';

export interface GateInput {
  c: Context<AppContext>;
  ev: V2Evaluation;
  hash: unknown;
  confirm: unknown;
  /** The save changes a customer price or carries a price field: the preview's hash is needed. */
  priceChange: boolean;
  /** Publishing (`status: active`) needs a complete price. */
  publishing: boolean;
  /** A prices-only apply with nothing to write answers without a batch. */
  prices_only?: boolean;
  preview: () => Promise<unknown>;
}

/** The product is V2-published: it has a method and its last complete write's results (customers see it). */
export const v2Published = (ev: Pick<V2Evaluation, 'kind' | 'v2'>): boolean => ev.kind === 'v2_reprice' && (ev.v2?.results.length ?? 0) > 0;

/** §4.3 steps 1 and 3-6 (the sequence check is the caller's, before the evaluation). */
export async function gateV2(g: GateInput): Promise<V2Verdict> {
  const { c, ev } = g;
  // Both reads at once: a replay answers first, as before; the import stock gate is asked only of a complete write.
  const [replayed, stockMiss] = await Promise.all([
    v2Replayed(c.env.DB, ev.product_id, g.hash),
    ev.complete && !(g.prices_only && !ev.needs_write) ? importStockNotConfigured(c.env.DB, ev.product_id) : Promise.resolve(false),
  ]);
  if (replayed) return 'already';
  if (!ev.complete) {
    // A data-only save (no hash, no tick, no fresh sign-in) is for a product no customer sees yet. On a
    // V2-PUBLISHED product it would store an unreviewed price set that the next automatic repricing (FX-5)
    // publishes: refused, with the preview — its structure alone may still be saved.
    if (g.publishing || (v2Published(ev) && ev.drafts)) {
      throw refusal(409, 'PRICING_V2_PRICE_MISSING', { missing: ev.missing.map((m) => ({ code: m.code, field: m.field, level: m.level })), preview: await g.preview() });
    }
    return 'data';
  }
  if (g.prices_only && !ev.needs_write) return 'noop';
  // A complete write publishes (its results make the product SELLABLE): a product the catalogue import created is
  // refused until the owner chose its stock mode (Bambu import spec §B.10) — here, before any preview or review
  // sheet, and again by the batch's own fence (v2/write.ts step 0), which stays the authority.
  if (stockMiss) throw importStockRefusal();
  if (!g.priceChange) return 'write';
  if (!isHash(g.hash)) throw refusal(409, 'PRICING_PREVIEW_REQUIRED', { preview: await g.preview() });
  if (g.hash !== ev.hash) throw refusal(409, 'PRICING_PREVIEW_STALE', { preview: await g.preview() });
  if (ev.large_change || ev.drop_flag) {
    if (g.confirm !== true) throw refusal(409, 'PRICING_LARGE_CHANGE_CONFIRM', { preview: await g.preview() });
    requireFreshV2(c);
  }
  return 'write';
}

/** A V2 batch's database refusals, as the API answers them (a fence miss is a fresh look; a replay is `already`). */
export function v2BatchOutcome(e: unknown): 'already' | HttpError | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed: pricing_audit\.idempotency_key/i.test(msg)) return 'already';
  // The import stock gate's own fence (v2/write.ts step 0): the reason, not "look again".
  if (isImportStockMiss(e)) return importStockRefusal();
  if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(msg)) return refusal(409, 'PRICING_CHANGED');
  return null;
}
