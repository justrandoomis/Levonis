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
 * ROLES (§4.4, C-7), enforced per FIELD from the request alone:
 *   - the OWNER (the verified owner: cost read and write) edits the method, the
 *     dollar price points, the pre-order discounts and the cost inputs and
 *     minimum profit, and reads every private figure (`v2_*`);
 *   - a PRICE EDITOR (every other admin — whoever may edit products today) on
 *     a price-first product edits IQD INTENTS only: final dinar prices the
 *     server stores as dollars with the reproduce helpers at today's U, so the
 *     typed dinars ARE the published dinars and no dollar figure, rate, cost
 *     or floor ever reaches them; on a cost-first product they read the final
 *     prices and may change structure only (the save reprices from cost);
 *   - a dollar or cost field from an editor is refused with 403
 *     COST_ACCESS_DENIED naming the FIELDS (never a value); intents on a
 *     cost-first product are 403 PRICING_V2_OWNER_ONLY {section: 3}.
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
import { addProcurementExact, mulProcurementExact, procurementExact, procurementExactText, type ProcurementExact } from '@levonis/contracts/procurementCost';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { ceilStep } from '@levonis/pricing/costToPrice';
import { parseV2Usd, V2_MAX_USD, V2_SCOPES, type V2Discount, type V2Method, type V2PricePoint, type V2Scope } from '@levonis/pricing/priceV2';
import { discountReproducing, usdReproducing } from '@levonis/pricing/priceV2Migration';
import type { AppContext, Env } from '../../types';
import { HttpError } from '../../http';
import { canViewCost, canWriteCost, costRefusal, type CostSubject } from '../../costAccess';
import { FRESH_SESSION_SECONDS, sessionAgeSeconds } from '../../session';
import { sha256Hex } from '../../crypto';
import { strictBody } from '../../fx/ownerActs';
import type { PricingContext } from '../../../routes/cart';
import { loadPreviewContext, loadProducts, type LoadedProduct } from '../load';
import { loadPricingRates, type PricingRates } from '../rates';
import { loadProductsPricing, type InputWrite, type ProductPricingData, type RuleWrite } from '../store';
import { isFenceMiss } from '../../operations';
import { engineCoreInstalled } from '../../engineInstalled';
import { loadEngineControl, priceImageOf, withRuleIds, type EngineControl } from '../engineWrite';
import { effectiveWrites, FORM_INPUT_FIELDS, formOptionIds, parseProductInputs } from '../productInputs';
import { parseRuleWrites } from '../ownerRules';
import { canonical } from '../procurementPreview';
import { inputInvalid } from '../whatIf';
import { sellableSkus } from '../legacy';
import { evaluateV2Write, type V2Evaluation } from './evaluate';
import { discountsOf, loadV2Store, pointsOf, type V2Store } from './store';
import { v2EditorAnswer, v2OwnerAnswer } from './dto';

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
}

/**
 * The stored product (or, with `draft`, the document the request would save)
 * and its pricing store, the guest pricing context, the last confirmed central
 * rates, the control row and the price image. Null for an unknown product.
 */
export async function loadV2Read(db: D1Database, productId: string, draft?: LoadedProduct): Promise<V2Read | null> {
  const loaded = draft ?? (await loadProducts(db, [productId])).get(productId) ?? null;
  if (!loaded) return null;
  const { stored, v2, control } = await loadV2Stores(db, [productId]);
  const ctx = await loadPreviewContext(db);
  const rates = await loadPricingRates(db);
  const image = await priceImageOf(db, productId);
  return { loaded, stored: stored.get(productId)!, v2: v2.get(productId) ?? null, ctx, rates, control, image };
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
  const stored = await loadProductsPricing(db, ids);
  const v2 = await loadV2Store(db, ids);
  const control = await loadEngineControl(db);
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

/** A price editor's final dinar prices (price-first products only, C-7). */
export interface V2Intents {
  direct_iqd?: number;
  preorder_iqd?: number | null;
  models?: Array<{ id: string; mode: 'follow' | 'fixed' | 'delta'; iqd?: number; preorder_iqd?: number | null }>;
  colours?: Array<{ id: string; mode: 'follow' | 'delta'; iqd?: number }>;
}

/** The request's pricing block (§4.2 `V2DraftWire`), its shape checked; ids and values are checked against the product later. */
export interface V2Wire {
  method?: V2Method;
  points?: V2PricePoint[];
  discounts?: V2Discount[];
  cost?: { inputs?: unknown; minimum_profit?: unknown };
  intents?: V2Intents;
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

const wholeIqd = (v: unknown, field: string, { min = 1, signed = false }: { min?: number; signed?: boolean } = {}): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw inputInvalid(field);
  if (signed ? v === 0 || Math.abs(v) > 100_000_000_000 : v < min || v > 100_000_000_000) throw inputInvalid(field);
  return v;
};

function parseIntents(raw: unknown): V2Intents {
  const r = strictBody(raw, ['direct_iqd', 'preorder_iqd', 'models', 'colours']);
  const out: V2Intents = {};
  if (r.direct_iqd !== undefined) out.direct_iqd = wholeIqd(r.direct_iqd, 'intents.direct_iqd');
  if (r.preorder_iqd !== undefined) out.preorder_iqd = r.preorder_iqd === null ? null : wholeIqd(r.preorder_iqd, 'intents.preorder_iqd');
  if (r.models !== undefined) {
    if (!Array.isArray(r.models) || r.models.length > MAX_ROWS) throw inputInvalid('intents.models');
    const seen = new Set<string>();
    out.models = r.models.map((entry, i) => {
      const m = strictBody(entry, ['id', 'mode', 'iqd', 'preorder_iqd']);
      const field = `intents.models[${i}]`;
      if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) throw inputInvalid(`${field}.id`);
      seen.add(m.id);
      if (m.mode !== 'follow' && m.mode !== 'fixed' && m.mode !== 'delta') throw inputInvalid(`${field}.mode`);
      const model: NonNullable<V2Intents['models']>[number] = { id: m.id, mode: m.mode };
      if (m.mode === 'fixed') model.iqd = wholeIqd(m.iqd, `${field}.iqd`);
      else if (m.mode === 'delta') model.iqd = wholeIqd(m.iqd, `${field}.iqd`, { signed: true });
      else if (m.iqd !== undefined && m.iqd !== null) throw inputInvalid(`${field}.iqd`);
      if (m.preorder_iqd !== undefined) model.preorder_iqd = m.preorder_iqd === null ? null : wholeIqd(m.preorder_iqd, `${field}.preorder_iqd`);
      return model;
    });
  }
  if (r.colours !== undefined) {
    if (!Array.isArray(r.colours) || r.colours.length > MAX_ROWS) throw inputInvalid('intents.colours');
    const seen = new Set<string>();
    out.colours = r.colours.map((entry, i) => {
      const c = strictBody(entry, ['id', 'mode', 'iqd']);
      const field = `intents.colours[${i}]`;
      if (typeof c.id !== 'string' || !c.id || seen.has(c.id)) throw inputInvalid(`${field}.id`);
      seen.add(c.id);
      if (c.mode !== 'follow' && c.mode !== 'delta') throw inputInvalid(`${field}.mode`);
      if (c.mode === 'delta') return { id: c.id, mode: 'delta' as const, iqd: wholeIqd(c.iqd, `${field}.iqd`, { signed: true }) };
      if (c.iqd !== undefined && c.iqd !== null) throw inputInvalid(`${field}.iqd`);
      return { id: c.id, mode: 'follow' as const };
    });
  }
  return out;
}

/** Parse the pricing block's SHAPE (absent block = nothing sent). Values are judged per role in `desiredFor`. */
export function parseV2Wire(raw: unknown): V2Wire {
  if (raw === undefined || raw === null) return { sent: [] };
  if (!isRecord(raw)) throw inputInvalid('pricing');
  const r = strictBody(raw, ['method', 'points', 'discounts', 'cost', 'intents']);
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
  if (r.intents !== undefined) out.intents = parseIntents(r.intents);
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

const exactUsd = (text: string): ProcurementExact => parseV2Usd(text, { signed: true, zero: true })!;
const iqdAt = (usd: ProcurementExact, u: string): number => ceilStep(mulProcurementExact(usd, procurementExact(u)));
const minus = (a: ProcurementExact, b: ProcurementExact): ProcurementExact => addProcurementExact(a, { num: -b.num, den: b.den });

/** A signed dollar difference the 0189 CHECK can hold (|x| ≤ 100,000, never 0), or null for «none». */
function deltaText(d: ProcurementExact, field: string): string | null {
  if (d.num === 0n) return null;
  const magnitude = d.num < 0n ? { num: -d.num, den: d.den } : d;
  if (magnitude.num > BigInt(V2_MAX_USD) * magnitude.den) throw inputInvalid(field);
  return usdText(d);
}

const reproducing = (iqd: number, u: string, field: string): string => {
  const usd = usdReproducing(iqd, u);
  const exact = procurementExact(usd);
  if (exact.num <= 0n || exact.num > BigInt(V2_MAX_USD) * exact.den) throw inputInvalid(field);
  return usd;
};

/**
 * C-7: a price editor's dinar intents laid over the stored dollar set. The
 * product's price, a model's own price or difference, a colour's difference
 * and the pre-order prices (the product's discount, a model's exception) are
 * stored in dollars with the reproduce helpers at today's U — so the dinars
 * typed are the dinars published. SKU-level points and discounts (set by the
 * owner or the migration) are never touched by an intent.
 */
function applyIntents(points: V2PricePoint[], discounts: V2Discount[], intents: V2Intents, u: string, ids: ReturnType<typeof scopeIdsOf>): { points: V2PricePoint[]; discounts: V2Discount[] } {
  const key = (scope: V2Scope, id: string): string => `${scope}\u0000${id}`;
  const P = new Map<string, V2PricePoint>(points.map((p) => [key(p.scope, p.scope_id), p]));
  const D = new Map<string, V2Discount>(discounts.map((d) => [key(d.scope, d.scope_id), d]));
  if (intents.direct_iqd !== undefined) P.set(key('product', ''), { scope: 'product', scope_id: '', kind: 'fixed', usd: reproducing(intents.direct_iqd, u, 'intents.direct_iqd') });
  const productPoint = P.get(key('product', ''));
  const productUsd = productPoint ? exactUsd(productPoint.usd) : null;
  const needProduct = (field: string): ProcurementExact => {
    if (!productUsd) throw refusal(409, 'PRICING_V2_PRICE_MISSING', { field });
    return productUsd;
  };
  const discountAt = (directUsd: ProcurementExact, preorderIqd: number): string => discountReproducing(usdText(directUsd), preorderIqd, u);
  if (intents.preorder_iqd !== undefined) {
    if (intents.preorder_iqd === null) D.delete(key('product', ''));
    else {
      const delta = discountAt(needProduct('intents.preorder_iqd'), intents.preorder_iqd);
      if (procurementExact(delta).num === 0n) D.delete(key('product', ''));
      else D.set(key('product', ''), { scope: 'product', scope_id: '', usd: delta });
    }
  }
  for (const [i, m] of (intents.models ?? []).entries()) {
    const field = `intents.models[${i}]`;
    if (!ids.option.has(m.id)) throw refusal(400, 'PRICING_V2_SCOPE_INVALID', { section: 5, scope: 'option', id: m.id });
    const k = key('option', m.id);
    if (m.mode === 'follow') P.delete(k);
    else if (m.mode === 'fixed') P.set(k, { scope: 'option', scope_id: m.id, kind: 'fixed', usd: reproducing(m.iqd!, u, `${field}.iqd`) });
    else {
      const base = needProduct(`${field}.iqd`);
      const target = iqdAt(base, u) + m.iqd!;
      if (target < 1) throw inputInvalid(`${field}.iqd`);
      const d = deltaText(minus(procurementExact(usdReproducing(target, u)), base), `${field}.iqd`);
      if (d === null) P.delete(k);
      else P.set(k, { scope: 'option', scope_id: m.id, kind: 'delta', usd: d });
    }
    if (m.preorder_iqd !== undefined) {
      const dk = key('option', m.id);
      if (m.preorder_iqd === null) D.delete(dk);
      else {
        const own = P.get(k);
        const direct = own?.kind === 'fixed' ? exactUsd(own.usd) : own ? addProcurementExact(needProduct(`${field}.preorder_iqd`), exactUsd(own.usd)) : needProduct(`${field}.preorder_iqd`);
        D.set(dk, { scope: 'option', scope_id: m.id, usd: discountAt(direct, m.preorder_iqd) });
      }
    }
  }
  for (const [i, c] of (intents.colours ?? []).entries()) {
    const field = `intents.colours[${i}]`;
    if (!ids.color.has(c.id)) throw refusal(400, 'PRICING_V2_SCOPE_INVALID', { section: 5, scope: 'color', id: c.id });
    const k = key('color', c.id);
    if (c.mode === 'follow') {
      P.delete(k);
      continue;
    }
    const base = needProduct(`${field}.iqd`);
    const target = iqdAt(base, u) + c.iqd!;
    if (target < 1) throw inputInvalid(`${field}.iqd`);
    const d = deltaText(minus(procurementExact(usdReproducing(target, u)), base), `${field}.iqd`);
    if (d === null) P.delete(k);
    else P.set(k, { scope: 'color', scope_id: c.id, kind: 'delta', usd: d });
  }
  return { points: [...P.values()], discounts: [...D.values()] };
}

/** The current intents of a price-first product, in dinars — the final prices themselves (C-7: never a dollar). */
export function intentsOf(points: readonly V2PricePoint[], discounts: readonly V2Discount[], u: string | null): V2Intents | null {
  if (!u) return null;
  const product = points.find((p) => p.scope === 'product' && p.kind === 'fixed');
  const productUsd = product ? exactUsd(product.usd) : null;
  const productIqd = productUsd ? iqdAt(productUsd, u) : null;
  const preorderOf = (direct: ProcurementExact, d: V2Discount | undefined) => (d ? iqdAt(minus(direct, exactUsd(d.usd)), u) : null);
  const out: V2Intents = {};
  if (productUsd && productIqd !== null) {
    out.direct_iqd = productIqd;
    out.preorder_iqd = preorderOf(productUsd, discounts.find((d) => d.scope === 'product'));
  }
  const models = new Set([...points.filter((p) => p.scope === 'option').map((p) => p.scope_id), ...discounts.filter((d) => d.scope === 'option').map((d) => d.scope_id)]);
  out.models = [...models].sort().map((id) => {
    const p = points.find((x) => x.scope === 'option' && x.scope_id === id);
    const d = discounts.find((x) => x.scope === 'option' && x.scope_id === id);
    const direct = p?.kind === 'fixed' ? exactUsd(p.usd) : p && productUsd ? addProcurementExact(productUsd, exactUsd(p.usd)) : productUsd;
    const entry: NonNullable<V2Intents['models']>[number] = { id, mode: p ? p.kind : 'follow' };
    if (p?.kind === 'fixed') entry.iqd = iqdAt(exactUsd(p.usd), u);
    else if (p && productIqd !== null && direct) entry.iqd = iqdAt(direct, u) - productIqd;
    if (d && direct) entry.preorder_iqd = preorderOf(direct, d);
    return entry;
  });
  out.colours = points
    .filter((p) => p.scope === 'color')
    .map((p) => ({ id: p.scope_id, mode: 'delta' as const, ...(productUsd && productIqd !== null ? { iqd: iqdAt(addProcurementExact(productUsd, exactUsd(p.usd)), u) - productIqd } : {}) }));
  return out;
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
 */
export function desiredFor(read: V2Read, wire: V2Wire, o: DesiredOptions): V2Desired {
  const stored = storedMethodOf(read);
  const ids = scopeIdsOf(read.loaded);
  // A stored row whose model, colour or SKU the (draft) product no longer has is dropped with it.
  const live = (r: { scope: V2Scope; scope_id: string }) => r.scope === 'product' || ids[r.scope].has(r.scope_id);
  const storedPoints = pointsOf(read.v2?.points ?? []).filter(live);
  const storedDiscounts = discountsOf(read.v2?.discounts ?? []).filter(live);
  if (o.viewer === 'editor') {
    // Every dollar, rate and cost field is the owner's: refused by NAME, decided from the request alone.
    const method = stored ?? 'usd';
    const fields = wire.sent.filter((k) => k !== 'intents' && !(k === 'method' && wire.method === method));
    if (fields.length) throw costRefusal(o.env, o.user, { fields });
    if (!wire.intents) return { method, points: storedPoints, discounts: storedDiscounts, inputWrites: [], ruleWrites: [] };
    if (method === 'cost') throw refusal(403, 'PRICING_V2_OWNER_ONLY');
    const u = read.rates?.usd_iqd ?? null;
    if (!u) throw refusal(409, 'PRICING_FX_RATE_MISSING');
    const next = applyIntents(storedPoints, storedDiscounts, wire.intents, u, ids);
    return { method, points: next.points, discounts: next.discounts, inputWrites: [], ruleWrites: [] };
  }
  if (wire.intents) throw inputInvalid('intents');
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
  return { method, points, discounts, inputWrites, ruleWrites };
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
    // The answer lists every blocked route to the reader («متوقف: أقل من التكلفة»); the hash binds the set.
    acceptBlocked: true,
    structureDigest: await structureDigestOf(read.loaded),
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

/** Where each SKU's price comes from (§4.2 `source`): a kind of point, never its value. */
function sourceOf(ev: V2Evaluation, row: V2Evaluation['rows'][number]): string {
  const anchor = row.owner?.anchor ?? null;
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
}

/**
 * The §4.2 answer, projected per role from EXPLICIT allow-lists (dto.ts): the
 * owner reads every private figure (`v2_*`); a price editor reads final dinars,
 * codes and names — plus, on a price-first product, its intents in dinars.
 */
export function v2Answer(i: AnswerInput): Record<string, unknown> {
  const { ev, read, viewer } = i;
  const method = ev.method;
  const priceFirst = method === 'usd';
  const base = viewer === 'owner' ? v2OwnerAnswer(ev) : v2EditorAnswer(ev);
  const table = (base.table as Array<Record<string, unknown>>).map((row, n) => {
    const r = ev.rows[n]!;
    const from = viewer === 'owner' || priceFirst ? discountFromOf(ev, r) : undefined;
    return { ...row, source: sourceOf(ev, r), ...(from ? { discount_from: from } : {}) };
  });
  const answer: Record<string, unknown> = {
    ...base,
    product_id: i.draft ? null : ev.product_id,
    v2: true,
    method,
    seq: { inputs_seq: read.stored.state?.inputs_seq ?? 0, write_seq: read.stored.state?.write_seq ?? 0 },
    status: statusOf(ev, read.rates),
    can_edit: { money: viewer === 'owner' || priceFirst, cost: viewer === 'owner', structure: true },
    table,
    publishable: ev.complete,
  };
  if (viewer === 'owner') {
    answer.v2_cost_inputs = {
      inputs: ev.inputs
        .filter((r) => !!r.scope)
        .map((r) => ({ scope: r.scope, scope_id: r.scope_id ?? '', ...Object.fromEntries(FORM_INPUT_FIELDS.map((k) => [k, (r as Record<string, unknown>)[k] ?? null])) })),
      minimum_profit: ev.stored.rules
        .filter((r) => r.product_id === ev.product_id && r.kind === 'target_profit')
        .map((r) => ({ scope: r.scope, scope_id: r.scope_id, state: r.state, amount_usd: r.amount_usd ?? null })),
    };
  } else if (priceFirst) {
    answer.intents = intentsOf(ev.points, ev.discounts, read.rates?.usd_iqd ?? null);
  }
  return answer;
}

/** The answer for a product that is not V2 yet (unmigrated): a flag, never a figure. */
export function notMigratedAnswer(read: V2Read, viewer: V2Viewer): Record<string, unknown> {
  return {
    product_id: read.loaded.id,
    v2: false,
    not_migrated: true,
    method: null,
    seq: { inputs_seq: read.stored.state?.inputs_seq ?? 0, write_seq: read.stored.state?.write_seq ?? 0 },
    status: { kind: 'current' },
    can_edit: { money: false, cost: viewer === 'owner', structure: true },
    table: [],
    missing: [],
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

/** §4.3 steps 1 and 3-6 (the sequence check is the caller's, before the evaluation). */
export async function gateV2(g: GateInput): Promise<V2Verdict> {
  const { c, ev } = g;
  if (await v2Replayed(c.env.DB, ev.product_id, g.hash)) return 'already';
  if (!ev.complete) {
    if (g.publishing) throw refusal(409, 'PRICING_V2_PRICE_MISSING', { missing: ev.missing.map((m) => ({ code: m.code, field: m.field, level: m.level })), preview: await g.preview() });
    return 'data';
  }
  if (g.prices_only && !ev.needs_write) return 'noop';
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
  if (isFenceMiss(e) || /UNIQUE constraint failed: ops_guards/i.test(msg)) return refusal(409, 'PRICING_CHANGED');
  return null;
}
