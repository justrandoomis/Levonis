/**
 * The procurement card's pricing — the client side of
 * `POST /api/admin/pricing/procurement/preview` and
 * `POST /api/admin/pricing/products/:id/apply-purchase` (USD design §6.3).
 *
 * Every figure here is the server's: whole cents, whole dinars, exact decimal
 * text. The screen formats them; it never computes a price (BRIEF §9).
 */
import { api } from '../../lib/api';

export const PRICING = '/api/admin/pricing';

export interface PricingSummary {
  state: 'ok' | 'blocked';
  issue_codes: string[];
  shipping_profile: string | null;
  profile_source: 'default' | 'proposed' | 'first_route' | null;
  engine_priced: boolean;
  /** The bar's model sells direct today (absent from an older server). */
  sells_direct?: boolean;
  option_id: string;
  rule_level: string | null;
  minimum_target_profit_usd: string | null;
  target_profit_iqd: number | null;
  target_profit_cents: number | null;
  current_total_cost_cents: number | null;
  final_price_cents: number | null;
  preorder_base_iqd: number | null;
  direct_sale_extra_iqd: number | null;
  direct_sale_price_iqd: number | null;
  rounding_added_iqd: number | null;
  supplier_original_amount: string | null;
  supplier_original_currency: string | null;
  iqd_converted: { original_input_amount: string; conversion_rate_snapshot: string; converted_at: string | null } | null;
  cross_rate: string | null;
  supplier_cost_usd: string | null;
  supplier_cost_cents: number | null;
  basis: 'weight' | 'volume' | null;
  effective_weight_g: number | null;
  effective_cbm: string | null;
  shipping_rate: string | null;
  shipping_cost_iqd: number | null;
  shipping_cost_usd: string | null;
  shipping_cost_cents: number | null;
  additional_cost_iqd: number | null;
  additional_cost_usd: string | null;
  additional_cost_cents: number | null;
  excluded_charges: string[];
  current_total_cost_usd: string | null;
  final_price_usd: string | null;
  usd_iqd_rate: string | null;
  document_rate: string | null;
  store_price_iqd: number | null;
}

export interface PricingLine {
  index: number;
  line_id: string | null;
  key: string;
  product_id: string;
  pricing_summary: PricingSummary;
}

export interface PricingPreviewRow {
  option_id: string;
  /** FX-7: priced per colour or variant, the row's SKU key and colour (absent on a model's row). */
  combo_key?: string;
  color_id?: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  channel: string;
  today_prepaid_iqd: number | null;
  today_cod_iqd: number | null;
  cod_priced_as_direct: boolean;
  computed_price_iqd: number | null;
  change_iqd: number | null;
  replacement_cost_iqd: number | null;
  target_profit_usd: string | null;
  target_profit_iqd: number | null;
  direct_sale_extra_iqd: number | null;
  preorder_base_iqd: number | null;
  issue_codes: string[];
}

/** One model × channel of the writer's preview (owner decision 8): the six figures and the flags. */
export interface EngineAdoptionRow {
  option_id: string;
  /** FX-7: the row's SKU key and colour (a model's own key when priced per model). */
  combo_key?: string;
  color_id?: string | null;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  channel: string;
  today_prepaid_iqd: number | null;
  computed_price_iqd: number;
  change_iqd: number | null;
  change_pct: string | null;
  large: boolean;
  drop_flag: boolean;
  replacement_cost_iqd: number;
  target_profit_usd: string | null;
  target_profit_iqd: number;
  preorder_base_iqd: number;
  direct_sale_extra_iqd: number | null;
  final_price_usd: string | null;
  route_fee_removed: boolean;
  pro_before_iqd: number | null;
  pro_after_iqd: number | null;
  prime_before_iqd: number | null;
  prime_after_iqd: number | null;
}

/** What a save would do to a product's prices: adopt (a manual product it completes), reprice (an engine product), or data only (kind null). */
export interface EngineAdoption {
  kind: 'adopt' | 'reprice' | null;
  mode: 'manual' | 'engine';
  complete: boolean;
  missing_codes: string[];
  needs_write: boolean;
  preview_hash: string | null;
  large_change: boolean;
  drop_flag: boolean;
  legacy_step: boolean;
  cod_priced_as_direct: boolean;
  review_pending: boolean;
  usd_iqd_rate: string | null;
  rows: EngineAdoptionRow[];
}

/** The writer's rows as the six-figure table reads them. */
export const adoptionRows = (a: EngineAdoption): PricingPreviewRow[] =>
  a.rows.map((r) => ({ ...r, today_cod_iqd: null, cod_priced_as_direct: false, issue_codes: [] }));

/** Whether an apply writes prices (the purchase completes the product, or it is engine-priced). */
export const writesPrices = (a: EngineAdoption | null | undefined): a is EngineAdoption => !!a?.kind && a.complete && a.needs_write;

/**
 * The prices two previews would write are the same (model × channel → price). A refused apply's fresh
 * preview is taken without a second look only then — new prices are never written unseen.
 */
export function samePrices(a: EngineAdoption | null | undefined, b: EngineAdoption | null | undefined): boolean {
  const key = (x: EngineAdoption | null | undefined) =>
    writesPrices(x) ? x.rows.map((r) => `${r.combo_key ?? r.option_id}|${r.channel}|${r.computed_price_iqd}`).sort().join(',') : '';
  return key(a) === key(b);
}

export interface PricingMinimumProfit {
  scope: 'product' | 'option';
  scope_id: string;
  state: string;
  source: string;
  minimum_target_profit_usd: string | null;
  target_profit_iqd: number | null;
}

/** A stored Direct Sale Extra at the card's levels (product, option); the amount only when ACTIVE. */
export interface PricingDirectSaleExtra {
  scope: 'product' | 'option';
  scope_id: string;
  state: string;
  source: string;
  direct_sale_extra_iqd: number | null;
}

export interface PricingProduct {
  product_id: string;
  label: string;
  mode: 'manual' | 'engine';
  feeds: boolean;
  eligible: boolean;
  reason: 'status' | 'estimated' | 'no_lines' | null;
  use_purchase: boolean;
  prefer_purchase_values: boolean;
  preview_hash: string;
  applied: boolean;
  cancelled_source: boolean;
  entries: Array<{ scope: string; scope_id: string; narrow: boolean; line_ids: string[]; kept_higher: string[]; changes: Record<string, { before: unknown; after: unknown }> }>;
  proposals: Array<{ scope: string; scope_id: string; shipping_profile: string }>;
  shadowed: Array<{ scope: string; scope_id: string; field: string }>;
  rows: PricingPreviewRow[];
  missing_codes: string[];
  cod_priced_as_direct: boolean;
  minimum_profits: PricingMinimumProfit[];
  /** The stored Direct Sale Extras (absent from an older server). */
  direct_sale_extras?: PricingDirectSaleExtra[];
  /** Today's Direct Sale Extra per direct-selling model where the old prices give one clean answer (answer B). */
  extra_suggestions?: Array<{ option_id: string; direct_sale_extra_iqd: number }>;
  /** What applying this purchase does to the product's prices (owner decision 8). */
  adoption?: EngineAdoption | null;
}

export interface PricingPreview {
  rates: { usd_iqd_rate: string | null; review_pending: boolean; derived_stale: boolean };
  lines: PricingLine[];
  products: PricingProduct[];
}

/** The owner's typed minimum profit of one target; `amount_usd` '' = inherit. */
export interface TypedMinimum {
  product_id: string;
  scope: 'product' | 'option';
  scope_id: string;
  amount_usd: string;
}

/**
 * The owner's typed Direct Sale Extra of one target, in dinars as typed ('' =
 * inherit). The review of a stock purchase asks for it in place (owner request
 * 2026-10-10: the stock is for direct sale); the server validates and decides.
 */
export interface TypedExtra {
  product_id: string;
  scope: 'product' | 'option';
  scope_id: string;
  amount_iqd: string;
}

export interface PricingChoices {
  minimums: TypedMinimum[];
  /** Typed Direct Sale Extras (absent = none typed). */
  extras?: TypedExtra[];
  optIn: string[];
  usePurchase: Record<string, boolean>;
  prefer: Record<string, boolean>;
}

/**
 * A typed Direct Sale Extra as whole dinars: Arabic-Indic and Extended digits
 * read as digits, thousands separators and spaces dropped. '' → null (inherit);
 * anything else that is not whole dinars → NaN (the screen refuses it; the
 * server would too). The 1,000 step is the caller's check (`extraOnStep`).
 */
export function extraAmount(typed: string): number | null {
  const t = typed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)).replace(/[\s,،٬']/g, '');
  if (t === '') return null;
  return /^[0-9]{1,10}$/.test(t) ? Number(t) : NaN;
}

/** A typed Direct Sale Extra the server accepts: empty, or whole dinars on the 1,000 step up to 1,000,000,000. */
export const extraOnStep = (typed: string): boolean => {
  const n = extraAmount(typed);
  return n === null || (Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000 && n % 1000 === 0);
};

export const pricingBody = (c: PricingChoices) => ({
  minimum_profits: c.minimums.map((m) => ({ product_id: m.product_id, scope: m.scope, scope_id: m.scope === 'product' ? '' : m.scope_id, amount_usd: m.amount_usd.trim() === '' ? null : m.amount_usd.trim() })),
  ...(c.extras?.length
    ? { direct_sale_extras: c.extras.map((x) => ({ product_id: x.product_id, scope: x.scope, scope_id: x.scope === 'product' ? '' : x.scope_id, amount_iqd: extraAmount(x.amount_iqd) })) }
    : {}),
  manual_line_opt_in: c.optIn,
  use_purchase: c.usePurchase,
  prefer_purchase_values: c.prefer,
});

export function previewDraft(draft: Record<string, unknown>, choices: PricingChoices, purchaseId: string | null, signal?: AbortSignal) {
  return api.post<PricingPreview>(`${PRICING}/procurement/preview`, { draft, ...(purchaseId ? { purchase_id: purchaseId } : {}), pricing: pricingBody(choices) }, { signal, mascot: 'silent' });
}

export function previewSaved(purchaseId: string, choices: PricingChoices, signal?: AbortSignal) {
  return api.post<PricingPreview>(`${PRICING}/procurement/preview`, { purchase_id: purchaseId, pricing: pricingBody(choices) }, { signal, mascot: 'silent' });
}

/**
 * Apply one product (inputs and the typed minimum profits) from a saved purchase — and, when that leaves
 * the product complete, its new prices in the same batch (owner decision 8); a change above 15% needs the
 * owner's tick (`confirmLarge`) and a fresh sign-in.
 */
export function applyPurchase(productId: string, purchaseId: string, previewHash: string, choices: PricingChoices, confirmLarge = false) {
  const body = pricingBody(choices);
  return api.post<{ success: boolean; already: boolean; rows_changed: number; priced?: boolean; entered?: boolean }>(`${PRICING}/products/${encodeURIComponent(productId)}/apply-purchase`, {
    purchase_id: purchaseId,
    preview_hash: previewHash,
    ...(confirmLarge ? { confirm_large_change: true } : {}),
    use_purchase: choices.usePurchase[productId] !== false,
    prefer_purchase_values: choices.prefer[productId] === true,
    manual_line_opt_in: choices.optIn.filter((k) => k.startsWith(`${productId}:`)),
    minimum_profits: body.minimum_profits.filter((m) => m.product_id === productId).map(({ scope, scope_id, amount_usd }) => ({ scope, scope_id, amount_usd })),
    ...(body.direct_sale_extras?.some((x) => x.product_id === productId)
      ? { direct_sale_extras: body.direct_sale_extras.filter((x) => x.product_id === productId).map(({ scope, scope_id, amount_iqd }) => ({ scope, scope_id, amount_iqd })) }
      : {}),
  });
}

/** The owner typed a minimum profit or a Direct Sale Extra for this product. */
export const typedFor = (productId: string, choices: PricingChoices): boolean =>
  choices.minimums.some((m) => m.product_id === productId) || (choices.extras ?? []).some((x) => x.product_id === productId);

/** Whether a product has something an apply would write (its purchase values, or a typed minimum or Direct Sale Extra). */
export function hasSomethingToApply(p: PricingProduct, choices: PricingChoices): boolean {
  const typed = typedFor(p.product_id, choices);
  const values = p.use_purchase && p.eligible && p.entries.some((e) => Object.keys(e.changes).length > 0);
  return typed || values;
}
