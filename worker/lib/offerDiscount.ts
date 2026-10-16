/**
 * THE PRODUCT FORM'S DISCOUNT CARD, SERVER SIDE (docs/ux/PRODUCT-DISCOUNT.md §5.1, §5.2, §5.3).
 *
 * Three things the admin door (worker/routes/offers.ts) asks of a product before and after a save:
 *
 *  - THE READ MODEL (`discountRead`): every published, LIVE V2 SKU × channel with its before price,
 *    which dollar scopes a sale price can take, and why not — for the viewer's role;
 *  - THE PREVIEW (`previewRows`): each of those lines priced EXACTLY as the cart prices it
 *    (`resolveCartLine`, the non-member tier) with the DRAFT window applied through the one
 *    resolver (`applyOfferToResolved`), the schedule forced live. It is not a second implementation;
 *  - THE DOLLAR SET'S RULES (`usdSetRefusal`): one scope, known models, and a single current price
 *    under each scope (a sale price can only replace ONE before price).
 *
 * ROLES (D7, §11): the owner reads every dollar and the below-cost flags; a price editor reads
 * dollars only on a price-first product (`V2_STAFF_SEES_USD`) and never a cost-derived figure. No
 * answer here carries the rate, an exact IQD, R, T or any `v2_*` key.
 */
import type { Env } from './types';
import type { CostSubject } from './costAccess';
import { procurementExact, compareProcurementExact, addProcurementExact, mulProcurementExact, type ProcurementExact } from '@levonis/contracts/procurementCost';
import type { OfferWindow } from './offers';
import { offerSavingPercent, offerUsdInstalled, usdCentsFor, usdTextOfCents, type OfferUsdPrice } from './offerUsd';
import { loadPreviewContext, loadProducts, type LoadedProduct } from './pricingEngine/load';
import { sellableSkus, unitNamesOf } from './pricingEngine/legacy';
import { v2ViewerOf, type V2Viewer } from './pricingEngine/v2/api';
import { isMissingV2Schema } from './productOverlay';
import { resolveCartLine, type PricingContext } from '../routes/cart';

export type DiscountChannel = 'direct_sale' | 'pre_order_land' | 'pre_order_sea' | 'pre_order_air';
const CHANNELS: readonly DiscountChannel[] = ['direct_sale', 'pre_order_land', 'pre_order_sea', 'pre_order_air'];

export type UsdReason = null | 'NOT_INSTALLED' | 'NOT_PUBLISHED' | 'OWNER_ONLY' | 'NOT_DIRECT' | 'MIXED_PRICES';

export interface DiscountRow {
  combo_key: string;
  model_id: string | null;
  names: { ar: string; en: string; ckb: string };
  channel: DiscountChannel;
  before_iqd: number;
  before_usd: string | null;
  before_usd_exact: boolean;
}

export interface DiscountRead {
  usd_supported: boolean;
  published: boolean;
  composition: boolean;
  viewer: V2Viewer;
  method: 'cost' | 'usd' | null;
  usd: { available: boolean; reason: UsdReason; scopes: Array<'product' | 'model'> };
  models: Array<{ model_id: string; names: { ar: string; en: string; ckb: string }; uniform: boolean; direct: boolean }>;
  rows: DiscountRow[];
  write_seq: number;
}

export interface PreviewRow extends DiscountRow {
  after_iqd: number | null;
  after_usd: string | null;
  offer_saving_percent: number | null;
  state: 'lowered' | 'not_lower' | 'not_covered' | 'below_floor';
  owner?: { below_cost: boolean; below_min_profit: boolean };
}

/** The private twin of one live row (`pricing_v2_sku_results`): read here, NEVER answered. */
interface ResultRow {
  combo_key: string;
  channel: string;
  method: string;
  final_price_iqd: number;
  direct_exact_iqd: string;
  usd_ceil6: string;
  replacement_cost_iqd: number | null;
  target_profit_usd: string | null;
  usd_iqd_rate: string;
  write_seq: number;
}

/** One SKU of the product: its selection, model, names and its live channels. */
interface SkuLine {
  combo_key: string;
  option_value_ids: string[];
  model_id: string | null;
  color_id: string | null;
  names: { ar: string; en: string; ckb: string };
  channels: Array<{ channel: DiscountChannel; before_iqd: number; result: ResultRow | null }>;
}

export interface DiscountContext {
  productId: string;
  composition: string;
  loaded: LoadedProduct | null;
  ctx: PricingContext | null;
  viewer: V2Viewer;
  method: 'cost' | 'usd' | null;
  usdSupported: boolean;
  skus: SkuLine[];
  models: Array<{ model_id: string; names: { ar: string; en: string; ckb: string } }>;
  writeSeq: number;
}

/** Everything the card, the preview and the checks read about one product — one load per request. */
export async function loadDiscountContext(env: Env, productId: string, user: CostSubject | null | undefined): Promise<DiscountContext> {
  const db = env.DB;
  const viewer = v2ViewerOf(env, user);
  const usdSupported = await offerUsdInstalled(db);
  const loaded = (await loadProducts(db, [productId])).get(productId) ?? null;
  const composition = String(loaded?.row.composition ?? '');
  const base: DiscountContext = { productId, composition, loaded, ctx: null, viewer, method: null, usdSupported, skus: [], models: [], writeSeq: 0 };
  if (!loaded || composition !== '') return base;

  let method: 'cost' | 'usd' | null = null;
  let results: ResultRow[] = [];
  try {
    const state = await db
      .prepare("SELECT pricing_method FROM product_pricing_state WHERE product_id = ? AND mode = 'engine'")
      .bind(productId)
      .first<{ pricing_method: string | null }>();
    method = state?.pricing_method === 'cost' || state?.pricing_method === 'usd' ? state.pricing_method : null;
    if (method) {
      results =
        (
          await db
            .prepare(
              `SELECT combo_key, channel, method, final_price_iqd, direct_exact_iqd, usd_ceil6, replacement_cost_iqd,
                      target_profit_usd, usd_iqd_rate, write_seq
                 FROM pricing_v2_sku_results WHERE product_id = ? ORDER BY combo_key, channel`
            )
            .bind(productId)
            .all<ResultRow>()
        ).results ?? [];
    }
  } catch (e) {
    // A database without 0189 (or without the engine tables): no V2 product, nothing published.
    if (!isMissingV2Schema(e) && !/no such table/i.test(String((e as Error)?.message ?? e))) throw e;
    method = null;
    results = [];
  }

  const doc = loaded.doc;
  const live = (doc.sku_prices ?? []).filter((r) => r.v2 === true);
  const skus: SkuLine[] = [];
  for (const sku of sellableSkus(doc, loaded.view).skus) {
    const channels: SkuLine['channels'] = [];
    for (const channel of CHANNELS) {
      const row = live.find((r) => r.combo_key === sku.combo_key && r.channel === channel);
      if (!row) continue;
      // The row's private twin (canonical key, '' = the product itself): the one SKU_ROW_LIVE_V2 matched.
      const result = results.find((r) => r.combo_key === sku.combo_key && r.channel === channel && Number(r.final_price_iqd) === row.regular_price_iqd) ?? null;
      channels.push({ channel, before_iqd: row.regular_price_iqd, result });
    }
    if (!channels.length) continue;
    const names = unitNamesOf(doc, sku.option_value_ids, sku.color);
    skus.push({
      combo_key: sku.combo_key,
      option_value_ids: sku.option_value_ids,
      model_id: sku.option_value_ids[0] ?? null,
      color_id: sku.color?.id ?? null,
      names: { ar: names.name_ar, en: names.name_en, ckb: names.name_ckb },
      channels,
    });
  }
  const models: DiscountContext['models'] = [];
  for (const s of skus) {
    if (!s.model_id || models.some((m) => m.model_id === s.model_id)) continue;
    const names = unitNamesOf(doc, [s.model_id], null);
    models.push({ model_id: s.model_id, names: { ar: names.name_ar, en: names.name_en, ckb: names.name_ckb } });
  }
  return {
    ...base,
    ctx: await loadPreviewContext(db),
    method,
    skus,
    models,
    writeSeq: results.reduce((m, r) => Math.max(m, Number(r.write_seq) || 0), 0),
  };
}

/** Published: a V2 method and at least one live V2 row (not «يحتاج تسعيرًا»). */
export const discountPublished = (d: DiscountContext): boolean => d.method !== null && d.skus.length > 0;

/** May this viewer see dollars on this product? The owner always; an editor only price-first. */
export const viewerSeesUsd = (d: DiscountContext): boolean => d.viewer === 'owner' || d.method === 'usd';

/** One model's (or the whole product's) direct rows: all SKUs sell direct, and the one shared exact D. */
function directUniform(skus: readonly SkuLine[]): { direct: boolean; uniform: boolean } {
  const direct = skus.length > 0 && skus.every((s) => s.channels.some((c) => c.channel === 'direct_sale'));
  const exacts = new Set(
    skus.flatMap((s) => s.channels.filter((c) => c.channel === 'direct_sale').map((c) => c.result?.direct_exact_iqd ?? `iqd:${c.before_iqd}`))
  );
  return { direct, uniform: exacts.size <= 1 };
}

/** Are this model's colours one price? (`direct_exact_iqd` per model.) */
function modelUniform(skus: readonly SkuLine[], modelId: string): { direct: boolean; uniform: boolean } {
  return directUniform(skus.filter((s) => s.model_id === modelId));
}

/** Which dollar scopes the set may take, and the reason none can (§5.1 `usd`). */
export function usdScopes(d: DiscountContext): { available: boolean; reason: UsdReason; scopes: Array<'product' | 'model'> } {
  if (!d.usdSupported) return { available: false, reason: 'NOT_INSTALLED', scopes: [] };
  if (!discountPublished(d)) return { available: false, reason: 'NOT_PUBLISHED', scopes: [] };
  if (d.method === 'cost' && d.viewer === 'editor') return { available: false, reason: 'OWNER_ONLY', scopes: [] };
  const scopes: Array<'product' | 'model'> = [];
  const whole = directUniform(d.skus);
  if (whole.direct && whole.uniform) scopes.push('product');
  const perModel = d.models.map((m) => modelUniform(d.skus, m.model_id));
  if (d.models.length > 1 && perModel.some((m) => m.direct && m.uniform)) scopes.push('model');
  if (scopes.length) return { available: true, reason: null, scopes };
  const anyDirect = d.skus.some((s) => s.channels.some((c) => c.channel === 'direct_sale'));
  const notDirect = !whole.direct && (d.models.length < 2 || perModel.every((m) => !m.direct));
  return { available: false, reason: notDirect || !anyDirect ? 'NOT_DIRECT' : 'MIXED_PRICES', scopes: [] };
}

/** A dollar figure (2 decimals), rounded UP to the cent, exact. */
function usdCeilCents(exact: ProcurementExact): string {
  const scaled = exact.num * 100n;
  const cents = scaled / exact.den + (scaled % exact.den > 0n ? 1n : 0n);
  return usdTextOfCents(Number(cents));
}

/** The row's own published dollars (its `usd_ceil6`, the writer's display figure) as 2 decimals. */
function beforeUsdOf(result: ResultRow | null): string | null {
  if (!result || typeof result.usd_ceil6 !== 'string') return null;
  try {
    return usdCeilCents(procurementExact(result.usd_ceil6));
  } catch {
    return null;
  }
}

/** The base rows of the read model (every live SKU × channel), for this viewer. */
export function discountRows(d: DiscountContext): DiscountRow[] {
  const usd = viewerSeesUsd(d);
  const rows: DiscountRow[] = [];
  for (const s of d.skus) {
    for (const c of s.channels) {
      rows.push({
        combo_key: s.combo_key,
        model_id: s.model_id,
        names: s.names,
        channel: c.channel,
        before_iqd: c.before_iqd,
        before_usd: usd ? beforeUsdOf(c.result) : null,
        before_usd_exact: d.method === 'usd',
      });
    }
  }
  return rows;
}

/** THE CARD'S READ MODEL (§5.1). */
export function discountRead(d: DiscountContext): DiscountRead {
  return {
    usd_supported: d.usdSupported,
    published: discountPublished(d),
    composition: d.composition !== '',
    viewer: d.viewer,
    method: d.method,
    usd: usdScopes(d),
    models: d.models.map((m) => ({ model_id: m.model_id, names: m.names, ...modelUniform(d.skus, m.model_id) })),
    rows: discountRows(d),
    write_seq: d.writeSeq,
  };
}

/* ------------------------------------------------------------ the checks -- */

export type UsdSetRefusal =
  | 'OFFER_USD_SCOPE_MIXED'
  | 'OFFER_USD_MODEL_UNKNOWN'
  | 'OFFER_USD_PER_MODEL'
  | 'OFFER_USD_MIXED_PRICES'
  | 'OFFER_USD_NOT_DIRECT';

/**
 * §5.3 step 4, after the shape: ONE scope (a '' row alone, or model rows only), every model a live
 * model of the product, and under each scope a single current direct price for the sale to replace.
 */
export function usdSetRefusal(d: DiscountContext, set: readonly OfferUsdPrice[]): UsdSetRefusal | null {
  const whole = set.filter((p) => p.model_id === '');
  const perModel = set.filter((p) => p.model_id !== '');
  if ((whole.length && perModel.length) || whole.length > 1 || new Set(perModel.map((p) => p.model_id)).size !== perModel.length) {
    return 'OFFER_USD_SCOPE_MIXED';
  }
  if (perModel.some((p) => !d.models.some((m) => m.model_id === p.model_id))) return 'OFFER_USD_MODEL_UNKNOWN';
  if (whole.length) {
    if (!d.skus.every((s) => s.channels.some((c) => c.channel === 'direct_sale'))) return 'OFFER_USD_NOT_DIRECT';
    for (const m of d.models) if (!modelUniform(d.skus, m.model_id).uniform) return 'OFFER_USD_MIXED_PRICES';
    if (!directUniform(d.skus).uniform) return d.models.length > 1 ? 'OFFER_USD_PER_MODEL' : 'OFFER_USD_MIXED_PRICES';
    return null;
  }
  for (const p of perModel) {
    const m = modelUniform(d.skus, p.model_id);
    if (!m.direct) return 'OFFER_USD_NOT_DIRECT';
    if (!m.uniform) return 'OFFER_USD_MIXED_PRICES';
  }
  return null;
}

/* ----------------------------------------------------------- the preview -- */

/**
 * The rows of the preview, each priced by the cart's own resolution with the DRAFT window, forced live.
 * Every row carries the owner's flags; the door strips them from any other viewer's answer.
 */
export function previewRows(d: DiscountContext, draft: OfferWindow): PreviewRow[] {
  if (!d.loaded || !d.ctx) return [];
  const usd = viewerSeesUsd(d);
  const forced: OfferWindow = { ...draft, starts_at: null, ends_at: null, active: true };
  delete (forced as { suspended?: true }).suspended;
  const view = { window: forced, limits: null };
  const out: PreviewRow[] = [];
  for (const s of d.skus) {
    const directResult = s.channels.find((c) => c.channel === 'direct_sale')?.result ?? null;
    for (const c of s.channels) {
      const route = c.channel === 'direct_sale' ? '' : c.channel.slice('pre_order_'.length);
      const line = resolveCartLine(
        d.loaded.row,
        {
          optionId: s.option_value_ids[0] ?? '',
          optionValueIds: s.option_value_ids,
          colorId: s.color_id ?? '',
          transportMethod: route,
          fulfillmentType: c.channel === 'direct_sale' ? 'direct_sale' : 'pre_order',
          warrantyPlanId: '',
        },
        'free',
        false,
        d.ctx,
        d.loaded.view,
        'prepaid',
        false,
        { view, eligible: true, nowMs: Date.now() }
      );
      const r = line.resolved;
      const lowered = typeof r.offer_before_iqd === 'number';
      const belowFloor = !lowered && r.errors.includes('DERIVED_PRICE_BELOW_FLOOR');
      const covered =
        forced.offer_price_mode === 'fixed_usd'
          ? usdCentsFor(forced.usd_prices ?? [], s.model_id) !== null && !!directResult
          : forced.offer_price_mode !== '';
      const state: PreviewRow['state'] = lowered ? 'lowered' : belowFloor ? 'below_floor' : covered ? 'not_lower' : 'not_covered';
      const after = lowered ? r.regular_iqd : null;
      const rate = c.result?.usd_iqd_rate ?? null;
      let afterUsd: string | null = null;
      if (usd && after !== null) {
        const cents = usdCentsFor(forced.usd_prices ?? [], s.model_id);
        if (forced.offer_price_mode === 'fixed_usd' && c.channel === 'direct_sale' && cents !== null) afterUsd = usdTextOfCents(cents);
        else if (rate) {
          try {
            afterUsd = usdCeilCents({ num: BigInt(after) * procurementExact(rate).den, den: procurementExact(rate).num });
          } catch {
            afterUsd = null;
          }
        }
      }
      const row: PreviewRow = {
        combo_key: s.combo_key,
        model_id: s.model_id,
        names: s.names,
        channel: c.channel,
        before_iqd: c.before_iqd,
        before_usd: usd ? beforeUsdOf(c.result) : null,
        before_usd_exact: d.method === 'usd',
        after_iqd: after,
        after_usd: afterUsd,
        offer_saving_percent: lowered ? offerSavingPercent(c.before_iqd, r.regular_iqd) : null,
        state,
      };
      // Always computed — an editor's save rings the owner's bell from them (D6) — and stripped from every
      // answer but the owner's by the door (`rowsFor`).
      row.owner = ownerFlags(c.result, c.channel, after);
      out.push(row);
    }
  }
  return out;
}

/**
 * D6: below this channel's cost (R, where one is known), and — cost-first direct rows only — below
 * cost + the minimum profit (R + T × U of the same row). The OWNER's answer only; never a figure.
 */
function ownerFlags(result: ResultRow | null, channel: DiscountChannel, after: number | null): { below_cost: boolean; below_min_profit: boolean } {
  if (after === null || !result) return { below_cost: false, below_min_profit: false };
  const r = result.replacement_cost_iqd;
  const belowCost = typeof r === 'number' && after < r;
  let belowMin = false;
  if (result.method === 'cost' && channel === 'direct_sale' && typeof r === 'number' && result.target_profit_usd && result.usd_iqd_rate) {
    try {
      const floor = addProcurementExact(procurementExact(r), mulProcurementExact(procurementExact(result.target_profit_usd), procurementExact(result.usd_iqd_rate)));
      belowMin = compareProcurementExact(procurementExact(after), floor) < 0;
    } catch {
      belowMin = false;
    }
  }
  return { below_cost: belowCost, below_min_profit: belowMin };
}
