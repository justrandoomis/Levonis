/**
 * PRICING V2 IN THE PRODUCT FORM — THE PURE HALF (implementation spec §4.2,
 * §5.2 and its addendum of 2026-10-14; docs/PRICING-V2.md §2; DECISIONS row 222).
 *
 * The wire shapes of the V2 pricing API (worker/lib/pricingEngine/v2/api.ts,
 * dto.ts), the form's draft of what the reader typed, and the two
 * translations between them. NO PRICE IS COMPUTED HERE: every dinar the form
 * shows is the server's answer (`table`, `changes`), and every value the form
 * sends is what the reader typed. The server alone turns them into prices
 * (packages/pricing/src/priceV2.ts is server-only).
 *
 * ONE DRAFT FOR EVERY READER (the owner's answer Q2): the owner and the price
 * editors type DOLLARS — the direct price, a model's or a colour's
 * difference, a special price, the pre-order discounts. The owner alone also
 * types the method and the cost inputs and minimum profit; an editor's
 * request never carries them (the server refuses them by name), and on a
 * cost-first product an editor sends nothing at all (the prices are the
 * owner's: D = R + T).
 *
 * WHAT IS SENT. Only what the reader changed: the stored set is the server's,
 * and a field the request leaves out keeps it. The points and discounts go as
 * the FULL desired set once any of them changed (§4.2 «full desired set
 * (replace)»), rebuilt scope by scope from the stored rows so a row this form
 * cannot draw is never dropped by an edit elsewhere. A product with no method
 * yet (the clean start's «يحتاج تسعيرًا», add-product) always states its method.
 *
 * Pure: no React, no request.
 */
import type { ProductDimensionsV2 } from '../../../../lib/productTypes';
import { toAscii, typingUsd } from './usdTyping';

export type V2Method = 'cost' | 'usd';
export type V2Scope = 'product' | 'option' | 'color' | 'sku';
export type V2Channel = 'direct_sale' | 'pre_order_land' | 'pre_order_sea' | 'pre_order_air';
/** Q1 (DECISIONS row 222): a floored route sells at the direct price — never lifted to its cost. */
export type V2Floor = 'none' | 'discount_withdrawn' | 'direct_min_profit';
export type StockRoute = 'GERMANY_LAND' | 'CHINA_AIR' | 'CHINA_SEA';
export type SupplierCurrency = 'USD' | 'EUR' | 'CNY';
export type V2Lang = 'ar' | 'en' | 'ckb';

/** The order channels are shown in, everywhere. */
export const V2_CHANNELS: readonly V2Channel[] = ['direct_sale', 'pre_order_land', 'pre_order_sea', 'pre_order_air'];
export const STOCK_ROUTES: readonly StockRoute[] = ['GERMANY_LAND', 'CHINA_SEA', 'CHINA_AIR'];
export const SUPPLIER_CURRENCIES: readonly SupplierCurrency[] = ['USD', 'EUR', 'CNY'];

// ------------------------------------------------------------------- wire --

export interface WirePoint {
  scope: V2Scope;
  id: string;
  kind: 'fixed' | 'delta';
  usd: string;
}
export interface WireDiscount {
  scope: V2Scope;
  id: string;
  usd: string;
}
/** One scope's cost inputs (productInputs.ts `parseInputEntry`): absent keys are untouched, null clears. */
export interface WireInput {
  scope: 'base' | 'option';
  scope_id?: string;
  supplier_cost_amount?: string | null;
  supplier_cost_currency?: SupplierCurrency | null;
  shipping_profile?: StockRoute | null;
  shipping_weight_g?: number | null;
  shipping_length_mm?: number | null;
  shipping_width_mm?: number | null;
  shipping_height_mm?: number | null;
  additional_cost_iqd?: number | null;
}
/** The request's `pricing` block (§4.2 `V2DraftWire`). */
export interface V2DraftWire {
  method?: V2Method;
  points?: WirePoint[];
  discounts?: WireDiscount[];
  cost?: { inputs?: WireInput[]; minimum_profit?: string | null };
}

export type V2Source = 'product' | 'model_fixed' | 'model_delta' | 'model_cost' | 'colour_delta' | 'sku_fixed';
export type V2DiscountFrom = 'product' | 'model' | 'colour' | 'sku' | 'none' | 'preorder_only';

/** The owner's private figures of one row (every key `v2_*`; FINANCIAL_FIELDS — never on a price editor's answer). */
export interface V2OwnerExtras {
  v2_exact_iqd: string;
  v2_usd_ceil6: string;
  v2_delta_usd: string;
  v2_discount_usd: string | null;
  v2_discount_scope: { scope: V2Scope; id: string } | null;
  v2_floor: V2Floor;
  v2_replacement_iqd: number | null;
  v2_profit_usd: string | null;
  v2_below_cost: boolean;
  /** Q3 (owner only): the direct price is below cost + the minimum profit (absent until the server states it). */
  v2_below_min_profit?: boolean;
}

export interface V2Names {
  ar: string;
  en: string;
  ckb: string;
}

export interface V2TableRow {
  combo_key: string;
  option_value_ids: string[];
  color_id: string | null;
  names: V2Names;
  channel: V2Channel;
  price_iqd: number | null;
  old_iqd?: number | null;
  source: V2Source;
  discount_from?: V2DiscountFrom;
  blocked?: true;
  /** Price-first: this channel's exact dollars (owner and price editors — typed figures, never a cost). */
  editor_usd_price?: string;
  owner?: V2OwnerExtras | null;
}

export interface V2Change {
  combo_key: string;
  names: V2Names;
  channel: V2Channel;
  old_iqd: number | null;
  new_iqd: number | null;
  change_percent: string | null;
  large: boolean;
  drop_flag: boolean;
}

export interface V2Missing {
  code: string;
  field: string | null;
  level: 'product' | 'model' | 'colour' | 'sku' | null;
  count: number;
  first_name: V2Names | null;
}

export type V2Status =
  | { kind: 'current' }
  | { kind: 'review'; count: number }
  | { kind: 'missing'; first: V2Missing | null }
  | { kind: 'held'; reason: 'FX_REVIEW_PENDING' | 'FX_RATE_MISSING' | 'ENGINE_PAUSED' };

export interface V2CostInputRow {
  scope: 'base' | 'option' | 'color' | 'sku';
  scope_id: string;
  supplier_cost_amount: string | null;
  supplier_cost_currency: SupplierCurrency | null;
  shipping_profile: StockRoute | null;
  shipping_weight_g: number | null;
  shipping_length_mm: number | null;
  shipping_width_mm: number | null;
  shipping_height_mm: number | null;
  manual_cbm?: string | null;
  additional_cost_iqd: number | null;
}

/** GET /api/admin/products-v2/:id/pricing, the preview, and every 409's `details.preview` (§4.2). */
export interface V2Answer {
  product_id: string | null;
  /** The product has a V2 method (or is being created V2). */
  v2: boolean;
  /** The clean start: not V2-published yet (no method, or no complete write), so no customer sees it. */
  needs_pricing?: boolean;
  method: V2Method | null;
  /** A product with no method yet: the method it is shown in (the owner's from cost when the prefill prices it). */
  default_method?: V2Method;
  seq: { inputs_seq: number; write_seq: number };
  status: V2Status;
  can_edit: { money: boolean; cost: boolean; method?: boolean; structure: boolean };
  complete?: boolean;
  codes?: string[];
  table: V2TableRow[];
  changes?: V2Change[];
  missing: V2Missing[];
  large_change?: boolean;
  drop_flag?: boolean;
  needs_write?: boolean;
  /** C-14: binds versions and final prices only — the hash the apply sends back as `preview_hash`. */
  review_hash?: string | null;
  publishable?: boolean;
  /** Price-first: the dollar set every price editor (and the owner) edits — Q2; keys outside FINANCIAL_FIELDS. */
  editor_usd?: { points: WirePoint[]; discounts: WireDiscount[] };
  // the owner only:
  v2_rate?: { usd_iqd: string; version: number } | null;
  v2_points?: WirePoint[];
  v2_discounts?: WireDiscount[];
  v2_cost_inputs?: {
    inputs: V2CostInputRow[];
    minimum_profit: Array<{ scope: string; scope_id: string | null; state: string | null; amount_usd: string | null }>;
    /** §2.1 rule 2: what the product's minimum profit inherits (a category or the store-wide rule), or null. */
    inherited_minimum_profit?: { amount_usd: string | null; amount_iqd: number | null } | null;
    /** D1: a needs-pricing product's prefill carries this pending purchase review; its first complete write applies it. */
    purchase_review_id?: string;
  };
}

/** The product's pricing flag on `GET /api/admin/products-v2/:id` (a flag, never a figure). */
export interface V2ProductFlag {
  v2: boolean;
  method: V2Method | null;
  needs_pricing: boolean;
}

/** The dollar set an answer shows (the owner's private copy, or the block every price editor reads). */
export function dollarsOf(answer: V2Answer | null | undefined): { points: WirePoint[]; discounts: WireDiscount[] } {
  return {
    points: answer?.editor_usd?.points ?? answer?.v2_points ?? [],
    discounts: answer?.editor_usd?.discounts ?? answer?.v2_discounts ?? [],
  };
}

// ---------------------------------------------------------------- typing --

/**
 * A dollar amount as typed, cleaned to the server's grammar (≤ 2 decimals,
 * ≤ 100,000): `null` when it is empty or not a number yet ('.', '-').
 * `signed` allows a sign (a difference); `zero` allows 0 (a discount's
 * explicit «no discount»). A difference of 0 is «none» (null).
 */
export function cleanUsd(text: string, opts: { signed?: boolean; zero?: boolean } = {}): string | null {
  const t = toAscii(text).trim().replace(/,/g, '');
  const m = /^([+-]?)(\d{1,6})(?:\.(\d{1,2}))?\.?$/.exec(t);
  if (!m) return null;
  if (m[1] && !opts.signed) return null;
  const whole = m[2].replace(/^0+(?=\d)/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  const body = frac ? `${whole}.${frac}` : whole;
  const zero = /^0(\.0*)?$/.test(body);
  if (zero) return opts.zero ? '0' : null;
  if (Number(body) > 100_000) return null;
  return m[1] === '-' ? `-${body}` : body;
}

/** What a dollar input lets through while typing (./usdTyping.ts, a leaf module `UsdInput` shares). */
export { typingUsd };

/** Whole dinars as typed (Arabic-Indic digits are digits; every separator is dropped): null when empty. */
export function wholeIqd(raw: string, signed = false): number | null {
  const t = toAscii(raw).trim();
  const neg = signed && /^-/.test(t);
  const digits = t.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isSafeInteger(n)) return null;
  return neg ? -n : n;
}


// ------------------------------------------------------------- the draft --

export type ModelPriceMode = 'follow' | 'own_cost' | 'delta' | 'fixed';

export interface ModelDraft {
  price: ModelPriceMode;
  /** The difference (signed) or the special price, as typed. */
  usd: string;
  discount: 'follow' | 'exception';
  discount_usd: string;
  /** «تكلفة مختلفة»: the model's own supplier price, its currency, its weight and its box (§1.4: weight OR box). */
  supplier_amount: string;
  supplier_currency: SupplierCurrency | '';
  weight_g: number | null;
  /** L × W × H in mm — one unit (a model shipped by sea is priced per CBM). */
  box: [number, number, number] | null;
}
export interface ColourDraft {
  price: 'follow' | 'delta';
  usd: string;
}
export interface SkuDraft {
  fixed_usd: string;
  discount_usd: string;
}
export interface CostDraft {
  supplier_amount: string;
  supplier_currency: SupplierCurrency | '';
  route: StockRoute | '';
  weight_g: number | null;
  box: [number, number, number] | null;
  extras_iqd: number | null;
}
/** What the reader typed in sections ٣ and ٥ (dollars for everyone; cost for the owner alone). */
export interface PriceDraft {
  method: V2Method;
  product_usd: string;
  discount_usd: string;
  min_profit_usd: string;
  cost: CostDraft;
  models: Record<string, ModelDraft>;
  colours: Record<string, ColourDraft>;
  skus: Record<string, SkuDraft>;
}

export const EMPTY_COST: CostDraft = { supplier_amount: '', supplier_currency: '', route: '', weight_g: null, box: null, extras_iqd: null };
export const FOLLOW_MODEL: ModelDraft = { price: 'follow', usd: '', discount: 'follow', discount_usd: '', supplier_amount: '', supplier_currency: '', weight_g: null, box: null };
export const FOLLOW_COLOUR: ColourDraft = { price: 'follow', usd: '' };
export const NO_SKU: SkuDraft = { fixed_usd: '', discount_usd: '' };

const boxOf = (r: Pick<V2CostInputRow, 'shipping_length_mm' | 'shipping_width_mm' | 'shipping_height_mm'> | undefined): [number, number, number] | null =>
  r && r.shipping_length_mm !== null && r.shipping_width_mm !== null && r.shipping_height_mm !== null
    ? [r.shipping_length_mm, r.shipping_width_mm, r.shipping_height_mm]
    : null;

/**
 * The draft as the server stores it (`null`: add-product, nothing stored).
 * Nothing is invented: an absent row is «follows». The cost fields stay empty
 * for a price editor (their answer carries none).
 */
export function draftOf(answer: V2Answer | null, fallbackMethod: V2Method = 'cost'): PriceDraft {
  const { points, discounts } = dollarsOf(answer);
  const inputs = answer?.v2_cost_inputs?.inputs ?? [];
  const base = inputs.find((r) => r.scope === 'base');
  const models: Record<string, ModelDraft> = {};
  const model = (id: string) => (models[id] ??= { ...FOLLOW_MODEL });
  for (const r of inputs) {
    if (r.scope !== 'option' || !r.scope_id) continue;
    if (r.supplier_cost_amount === null && r.shipping_weight_g === null && boxOf(r) === null) continue;
    Object.assign(model(r.scope_id), {
      price: 'own_cost',
      supplier_amount: r.supplier_cost_amount ?? '',
      supplier_currency: r.supplier_cost_currency ?? '',
      weight_g: r.shipping_weight_g,
      box: boxOf(r),
    });
  }
  for (const p of points) if (p.scope === 'option') Object.assign(model(p.id), { price: p.kind, usd: p.usd });
  for (const d of discounts) if (d.scope === 'option') Object.assign(model(d.id), { discount: 'exception', discount_usd: d.usd });
  const colours: Record<string, ColourDraft> = {};
  for (const p of points) if (p.scope === 'color') colours[p.id] = { price: 'delta', usd: p.usd };
  const skus: Record<string, SkuDraft> = {};
  for (const p of points) if (p.scope === 'sku') skus[p.id] = { ...(skus[p.id] ?? NO_SKU), fixed_usd: p.usd };
  for (const d of discounts) if (d.scope === 'sku') skus[d.id] = { ...(skus[d.id] ?? NO_SKU), discount_usd: d.usd };
  const minimum = answer?.v2_cost_inputs?.minimum_profit.find((r) => r.scope === 'product');
  return {
    method: answer?.method ?? answer?.default_method ?? fallbackMethod,
    product_usd: points.find((p) => p.scope === 'product' && p.kind === 'fixed')?.usd ?? '',
    discount_usd: discounts.find((d) => d.scope === 'product')?.usd ?? '',
    min_profit_usd: minimum?.amount_usd ?? '',
    cost: {
      supplier_amount: base?.supplier_cost_amount ?? '',
      supplier_currency: base?.supplier_cost_currency ?? '',
      route: base?.shipping_profile ?? '',
      weight_g: base?.shipping_weight_g ?? null,
      box: boxOf(base),
      extras_iqd: base?.additional_cost_iqd ?? null,
    },
    models,
    colours,
    skus,
  };
}

/**
 * The form's package measure fills a cost-first product's EMPTY pricing
 * measure (docs/PRICING-V2.md §2.8, P4/P15): the weight and the box of
 * «الأبعاد والوزن» price the stock route until the owner types another. A
 * stored pricing measure is never overwritten silently.
 */
export function withPackageMeasure(cost: CostDraft, dims: ProductDimensionsV2 | null | undefined): CostDraft {
  if (!dims) return cost;
  const weight = cost.weight_g ?? (typeof dims.package_weight_g === 'number' && dims.package_weight_g > 0 ? dims.package_weight_g : null);
  const l = dims.package_depth_mm;
  const w = dims.package_width_mm;
  const h = dims.package_height_mm;
  const box = cost.box ?? (typeof l === 'number' && typeof w === 'number' && typeof h === 'number' && l > 0 && w > 0 && h > 0 ? ([l, w, h] as [number, number, number]) : null);
  return weight === cost.weight_g && box === cost.box ? cost : { ...cost, weight_g: weight, box };
}

/** The ids each scope may name on the product as the form holds it (the server's `scopeIdsOf`). */
export interface V2LiveIds {
  /** Every active option value. */
  options: ReadonlySet<string>;
  /** The values of the model group (the first group): a fixed price and a discount exception name a model only. */
  models: ReadonlySet<string>;
  colours: ReadonlySet<string>;
  /** The sellable SKUs of the last answer. */
  skus: ReadonlySet<string>;
}

const scopeKey = (scope: V2Scope, id: string) => `${scope}\u0000${id}`;
const sortRows = <T extends { scope: V2Scope; id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (scopeKey(a.scope, a.id) < scopeKey(b.scope, b.id) ? -1 : 1));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The point and discount rows ONE scope of the draft asks for. */
function draftRows(d: PriceDraft, scope: V2Scope, id: string): { points: WirePoint[]; discounts: WireDiscount[] } {
  const points: WirePoint[] = [];
  const discounts: WireDiscount[] = [];
  if (scope === 'product') {
    const fixed = d.method === 'usd' ? cleanUsd(d.product_usd) : null;
    if (fixed) points.push({ scope, id: '', kind: 'fixed', usd: fixed });
    const off = cleanUsd(d.discount_usd, { zero: true });
    if (off !== null && off !== '0') discounts.push({ scope, id: '', usd: off });
  } else if (scope === 'option') {
    const m = d.models[id] ?? FOLLOW_MODEL;
    if (m.price === 'delta') {
      const usd = cleanUsd(m.usd, { signed: true });
      if (usd) points.push({ scope, id, kind: 'delta', usd });
    } else if (m.price === 'fixed') {
      const usd = cleanUsd(m.usd);
      if (usd) points.push({ scope, id, kind: 'fixed', usd });
    }
    if (m.discount === 'exception') {
      const off = cleanUsd(m.discount_usd, { zero: true });
      if (off !== null) discounts.push({ scope, id, usd: off });
    }
  } else if (scope === 'color') {
    const c = d.colours[id] ?? FOLLOW_COLOUR;
    const usd = c.price === 'delta' ? cleanUsd(c.usd, { signed: true }) : null;
    if (usd) points.push({ scope, id, kind: 'delta', usd });
  } else {
    const s = d.skus[id] ?? NO_SKU;
    const fixed = cleanUsd(s.fixed_usd);
    if (fixed) points.push({ scope, id, kind: 'fixed', usd: fixed });
    const off = cleanUsd(s.discount_usd, { zero: true });
    if (off !== null) discounts.push({ scope, id, usd: off });
  }
  return { points, discounts };
}

/** Is this stored row's scope one the product (as the form holds it) still has? */
const liveRow = (live: V2LiveIds, scope: V2Scope, id: string, kind?: 'fixed' | 'delta' | 'discount'): boolean => {
  if (scope === 'product') return true;
  if (scope === 'option') return kind === 'delta' ? live.options.has(id) : live.models.has(id);
  if (scope === 'color') return live.colours.has(id);
  return live.skus.has(id);
};

/** The cost entry of one scope: the fields that differ from the stored ones, or null. */
function costEntry(scope: 'base' | 'option', id: string, now: Partial<WireInput>, was: Partial<WireInput>): WireInput | null {
  const out: WireInput = { scope, ...(scope === 'option' ? { scope_id: id } : {}) };
  let any = false;
  for (const k of Object.keys(now) as Array<keyof WireInput>) {
    if (k === 'scope' || k === 'scope_id') continue;
    if (!same(now[k] ?? null, was[k] ?? null)) {
      (out as unknown as Record<string, unknown>)[k] = now[k] ?? null;
      any = true;
    }
  }
  // The box is one unit: its three axes travel together.
  if (any && ['shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm'].some((k) => k in out)) {
    out.shipping_length_mm = now.shipping_length_mm ?? null;
    out.shipping_width_mm = now.shipping_width_mm ?? null;
    out.shipping_height_mm = now.shipping_height_mm ?? null;
  }
  return any ? out : null;
}

const baseFields = (c: CostDraft): Partial<WireInput> => ({
  supplier_cost_amount: cleanUsdAmount(c.supplier_amount),
  supplier_cost_currency: c.supplier_currency || null,
  shipping_profile: c.route || null,
  shipping_weight_g: c.weight_g,
  shipping_length_mm: c.box?.[0] ?? null,
  shipping_width_mm: c.box?.[1] ?? null,
  shipping_height_mm: c.box?.[2] ?? null,
  additional_cost_iqd: c.extras_iqd,
});

/** A supplier amount (any currency, up to 6 decimals as the inputs table holds it): null when empty or unreadable. */
export function cleanUsdAmount(text: string): string | null {
  const t = toAscii(text).trim().replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(t) || Number(t) <= 0) return null;
  return t;
}

const modelCostFields = (m: ModelDraft | undefined): Partial<WireInput> =>
  m && m.price === 'own_cost'
    ? {
        supplier_cost_amount: cleanUsdAmount(m.supplier_amount),
        supplier_cost_currency: m.supplier_currency || null,
        shipping_weight_g: m.weight_g,
        shipping_length_mm: m.box?.[0] ?? null,
        shipping_width_mm: m.box?.[1] ?? null,
        shipping_height_mm: m.box?.[2] ?? null,
      }
    : { supplier_cost_amount: null, shipping_weight_g: null, shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null };

/**
 * The request block: what differs from the stored draft (`base`), the stored
 * rows (`stored`) kept for every scope the reader did not touch.
 *   - `needsMethod` (add-product, or a product with no method yet) always
 *     states the method, which such a product needs;
 *   - `cost: false` (a price editor) never sends a cost field — and a price
 *     editor never sends the method unless the product has none (then the
 *     dollar price: Q9);
 *   - `money: false` (a price editor on a cost-first product) sends nothing.
 */
export function draftWire(
  base: PriceDraft,
  draft: PriceDraft,
  stored: { points: readonly WirePoint[]; discounts: readonly WireDiscount[] },
  live: V2LiveIds,
  opts: { needsMethod: boolean; cost: boolean; money: boolean }
): V2DraftWire {
  if (!opts.money) return {};
  const isNew = opts.needsMethod;
  const wire: V2DraftWire = {};
  if (isNew || (opts.cost && draft.method !== base.method)) wire.method = opts.cost ? draft.method : 'usd';
  // Points and discounts: the stored set, with every TOUCHED scope rebuilt from the draft.
  const scopes = new Map<string, { scope: V2Scope; id: string }>();
  const touch = (scope: V2Scope, id: string) => scopes.set(scopeKey(scope, id), { scope, id });
  if (draft.method !== base.method || draft.product_usd !== base.product_usd || draft.discount_usd !== base.discount_usd) touch('product', '');
  for (const id of new Set([...Object.keys(draft.models), ...Object.keys(base.models)])) {
    const a = draft.models[id] ?? FOLLOW_MODEL;
    const b = base.models[id] ?? FOLLOW_MODEL;
    if (a.price !== b.price || a.usd !== b.usd || a.discount !== b.discount || a.discount_usd !== b.discount_usd) touch('option', id);
  }
  for (const id of new Set([...Object.keys(draft.colours), ...Object.keys(base.colours)])) {
    if (!same(draft.colours[id] ?? FOLLOW_COLOUR, base.colours[id] ?? FOLLOW_COLOUR)) touch('color', id);
  }
  for (const id of new Set([...Object.keys(draft.skus), ...Object.keys(base.skus)])) {
    if (!same(draft.skus[id] ?? NO_SKU, base.skus[id] ?? NO_SKU)) touch('sku', id);
  }
  // A stored row of a scope the form no longer has is dropped by the server itself when nothing is sent
  // (`desiredFor`), so it never makes a request on its own; a SENT set must leave it out (PRICING_V2_SCOPE_INVALID).
  const storedPoints = stored.points.filter((p) => liveRow(live, p.scope, p.id, p.kind));
  const storedDiscounts = stored.discounts.filter((d) => liveRow(live, d.scope, d.id, 'discount'));
  let points = storedPoints.filter((p) => !scopes.has(scopeKey(p.scope, p.id)));
  let discounts = storedDiscounts.filter((d) => !scopes.has(scopeKey(d.scope, d.id)));
  for (const { scope, id } of scopes.values()) {
    if (!liveRow(live, scope, id, 'delta')) continue;
    const rows = draftRows(draft, scope, id);
    points = points.concat(rows.points);
    discounts = discounts.concat(rows.discounts);
  }
  // A product's own dollar price is the price-first anchor only: from cost it is refused (V2_SCOPE_INVALID).
  points = points.filter((p) => liveRow(live, p.scope, p.id, p.kind) && !(draft.method === 'cost' && p.scope === 'product'));
  discounts = discounts.filter((d) => liveRow(live, d.scope, d.id, 'discount'));
  const pointsChanged = !same(sortRows(points), sortRows(storedPoints));
  const discountsChanged = !same(sortRows(discounts), sortRows(storedDiscounts));
  if (isNew ? points.length > 0 : pointsChanged) wire.points = sortRows(points);
  if (isNew ? discounts.length > 0 : discountsChanged) wire.discounts = sortRows(discounts);
  if (!opts.cost) return wire;
  // The cost inputs (the owner's): the fields that differ, per scope.
  const inputs: WireInput[] = [];
  const baseEntry = costEntry('base', '', baseFields(draft.cost), baseFields(base.cost));
  if (baseEntry) inputs.push(baseEntry);
  for (const id of new Set([...Object.keys(draft.models), ...Object.keys(base.models)])) {
    if (!live.models.has(id)) continue;
    // «تكلفة مختلفة» is a cost-first choice: a price-first save never touches a model's own cost.
    const now = draft.method === 'cost' ? modelCostFields(draft.models[id]) : modelCostFields(base.models[id]);
    const entry = costEntry('option', id, now, modelCostFields(base.models[id]));
    if (entry) inputs.push(entry);
  }
  const minimum = draft.min_profit_usd !== base.min_profit_usd;
  if (inputs.length || minimum) {
    wire.cost = {};
    if (inputs.length) wire.cost.inputs = inputs;
    if (minimum) wire.cost.minimum_profit = cleanUsd(draft.min_profit_usd);
  }
  return wire;
}

/**
 * The old dinar money keys of a product document or its relations (the clean
 * start, DECISIONS row 222): kept by the save round-trip until the server
 * retires them (addendum A.6), and NEVER shown — the form's «البيانات
 * المرسلة» view drops them, at every depth.
 */
const LEGACY_MONEY_KEY = /(^|_)(price_iqd|adjust_iqd|cost_iqd|surcharge_iqd|commission_iqd)$|^membership_prices$|^direct_surcharge_iqd$/;
export function withoutLegacyMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLegacyMoney);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !LEGACY_MONEY_KEY.test(k)).map(([k, v]) => [k, withoutLegacyMoney(v)]));
}

/**
 * THE SAVE NEVER CARRIES A DINAR PRICE (the clean start, addendum A.6): the
 * document's own legacy money keys and the route commissions are left out, so
 * the server keeps every stored value (a key the request does not carry keeps
 * the stored one; a differing one is 409 PRICING_V2_MANAGED). Top-level keys
 * only — the document's other nested objects are not money.
 */
export function docWithoutLegacyMoney<T extends Record<string, unknown>>(doc: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (LEGACY_MONEY_KEY.test(k)) continue;
    out[k] = k === 'preorder_transports' && Array.isArray(v) ? v.map((t) => (t && typeof t === 'object' ? withoutLegacyMoney(t) : t)) : v;
  }
  return out as Partial<T>;
}

/** Is there anything to send? */
export const wireIsEmpty = (w: V2DraftWire): boolean => Object.keys(w).length === 0;

// ---------------------------------------------------------- the table view --

export interface SkuLine {
  combo_key: string;
  model_id: string | null;
  option_value_ids: string[];
  color_id: string | null;
  names: V2Names;
  source: V2Source;
  /** Per channel: the row the server answered. */
  channels: Partial<Record<V2Channel, V2TableRow>>;
}

export interface ModelBlock {
  model_id: string | null;
  names: V2Names;
  lead: SkuLine;
  /** SKUs that differ from their model (a colour's difference, an SKU's own price, a blocked route). */
  shown: SkuLine[];
  /** SKUs that follow their model, folded under «▸ n صفوف أخرى تتبع موديلها». */
  folded: SkuLine[];
}

/** The server's rows as one line per SKU, in the server's order. */
export function skuLines(table: readonly V2TableRow[]): SkuLine[] {
  const out = new Map<string, SkuLine>();
  for (const r of table) {
    let line = out.get(r.combo_key);
    if (!line) {
      line = { combo_key: r.combo_key, model_id: r.option_value_ids[0] ?? null, option_value_ids: [...r.option_value_ids], color_id: r.color_id, names: r.names, source: r.source, channels: {} };
      out.set(r.combo_key, line);
    }
    line.channels[r.channel] = r;
    if (r.channel === 'direct_sale') line.source = r.source;
  }
  return [...out.values()];
}

/** The channels any row of the table sells on, in display order. */
export function channelsOf(table: readonly V2TableRow[]): V2Channel[] {
  const seen = new Set(table.map((r) => r.channel));
  return V2_CHANNELS.filter((c) => seen.has(c));
}

const differs = (l: SkuLine) => l.source === 'colour_delta' || l.source === 'sku_fixed' || Object.values(l.channels).some((r) => r?.blocked);

/** One block per model: its first SKU leads, the SKUs that differ are shown, the rest fold (§2.2). */
export function modelBlocks(table: readonly V2TableRow[], modelNames: (id: string) => V2Names | null): ModelBlock[] {
  const blocks = new Map<string, ModelBlock>();
  for (const line of skuLines(table)) {
    const key = line.model_id ?? '';
    const block = blocks.get(key);
    if (!block) {
      blocks.set(key, { model_id: line.model_id, names: (line.model_id && modelNames(line.model_id)) || line.names, lead: line, shown: [], folded: [] });
    } else if (differs(line)) block.shown.push(line);
    else block.folded.push(line);
  }
  return [...blocks.values()];
}

/** The server's canonical SKU key of a selection (options sorted, the colour last) — packages/pricing skuComboKey's shape. */
export function comboKeyOf(optionIds: readonly string[], colorId: string | null): string {
  const parts = [...optionIds].filter(Boolean).sort().map((id) => `o:${id}`);
  if (colorId) parts.push(`c:${colorId}`);
  return parts.join('|');
}

/** The lowest final price of the table (section ٨ «السعر» → «من … د.ع»), or null. */
export function lowestPrice(table: readonly V2TableRow[]): number | null {
  let low: number | null = null;
  for (const r of table) if (r.price_iqd !== null && !r.blocked && (low === null || r.price_iqd < low)) low = r.price_iqd;
  return low;
}

/** The first SKU of a model (its result line in section ٥): the model alone, else its first colour. */
export function firstLineOf(table: readonly V2TableRow[], modelId: string | null): SkuLine | null {
  return skuLines(table).find((l) => (l.model_id ?? null) === modelId) ?? null;
}

/** The first SKU line a model (or any option value) sells in: its own line, else its first combination. */
export function lineWithOption(table: readonly V2TableRow[], optionId: string): SkuLine | null {
  const lines = skuLines(table);
  return lines.find((l) => l.model_id === optionId && l.color_id === null) ?? lines.find((l) => l.option_value_ids.includes(optionId)) ?? null;
}

/** The SKU lines a colour takes, one per model it shows with. */
export function colourLines(table: readonly V2TableRow[], colourId: string): SkuLine[] {
  return skuLines(table).filter((l) => l.color_id === colourId);
}

/** The first pre-order channel a line sells on (the 2×2 bar's «مسبق»), or null. */
export function firstPreorder(line: SkuLine | null): V2TableRow | null {
  if (!line) return null;
  for (const c of V2_CHANNELS) if (c !== 'direct_sale' && line.channels[c]) return line.channels[c]!;
  return null;
}

/** A name in the reader's language (English, then Arabic, when a slot is empty). */
export const nameIn = (n: V2Names | null | undefined, lang: V2Lang): string => (n ? n[lang] || n.en || n.ar || '' : '');

/** Whole dinars, grouped («1,500,000»). */
export const iqdText = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US').format(n));

/** A dollar figure as the server stated it, at most 2 decimals shown («$1,000.00»). Display only. */
/**
 * §2.1 rule 2: the discount an SKU inherits when its own field is empty — its model's exception when the model
 * has one, else the product's. The SKU field shows it («الموديل: $25.00» / «المنتج: $40.00»).
 */
export function inheritedSkuDiscount(draft: Pick<PriceDraft, 'discount_usd' | 'models'>, modelId: string | null): { from: 'model' | 'product'; usd: string } {
  const m = modelId ? draft.models[modelId] : undefined;
  if (m?.discount === 'exception' && m.discount_usd) return { from: 'model', usd: m.discount_usd };
  return { from: 'product', usd: draft.discount_usd || '0' };
}

/** The owner's minimum-profit placeholder: «يرث ($40.00)» when something above decides, «يرث» alone otherwise. */
export function inheritPlaceholder(inherit: string, inherited: { amount_usd: string | null; amount_iqd: number | null } | null | undefined): string {
  if (inherited?.amount_usd) return `${inherit} (${usdText(inherited.amount_usd)})`;
  if (inherited && inherited.amount_iqd !== null) return `${inherit} (${iqdText(inherited.amount_iqd)})`;
  return inherit;
}

export function usdText(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return '—';
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A signed dollar difference as typed («+2», «−25»). Display only. */
export const signedUsd = (text: string): string => (text.startsWith('-') ? `−$${text.slice(1)}` : `+$${text.replace(/^\+/, '')}`);

/** The rows of a 409's `details.preview` (the review sheet's answer), or null. */
export function previewOf(details: unknown): V2Answer | null {
  const d = details && typeof details === 'object' ? (details as Record<string, unknown>).preview : null;
  return d && typeof d === 'object' && Array.isArray((d as V2Answer).table) ? (d as V2Answer) : null;
}

/** The section a refusal names (3 «الأسعار» or 5 «الخيارات والألوان»), or null. */
export function sectionOf(details: unknown): 3 | 5 | null {
  const s = details && typeof details === 'object' ? (details as Record<string, unknown>).section : null;
  return s === 3 || s === 5 ? s : null;
}

/**
 * A CONTENT SAVE OF A VISIBLE, UNPRICED PRODUCT (catalog-only, DECISIONS rows
 * 239–240; Bambu import spec §B.10): the product is stored ACTIVE, has no V2
 * method yet, is saved ACTIVE again («نشر») and no price was typed. Such a save
 * publishes nothing — the product stays visible and unpriced — so it sends no
 * `pricing_v2` block and the server takes its structure-only save. With a block
 * (the prefilled method alone) the server read it as publishing a price and
 * refused it (409 PRICING_V2_PRICE_MISSING), so the only save that landed was
 * «مسودة», which takes the product off the storefront: every translation fix
 * and every stock entry of the imported catalogue went through hiding it. A
 * hidden or draft product saved «نشر» keeps today's rule (its publish is
 * refused until it is priced); a typed price, or the review sheet's answer,
 * always travels.
 */
export function isContentOnlySave(o: {
  status: 'draft' | 'active';
  storedStatus: string;
  needsMethod: boolean;
  touched: boolean;
  confirming: boolean;
}): boolean {
  return o.status === 'active' && o.storedStatus === 'active' && o.needsMethod && !o.touched && !o.confirming;
}
