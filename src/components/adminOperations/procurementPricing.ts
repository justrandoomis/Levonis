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

export interface PricingMinimumProfit {
  scope: 'product' | 'option';
  scope_id: string;
  state: string;
  source: string;
  minimum_target_profit_usd: string | null;
  target_profit_iqd: number | null;
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

export interface PricingChoices {
  minimums: TypedMinimum[];
  optIn: string[];
  usePurchase: Record<string, boolean>;
  prefer: Record<string, boolean>;
}

const pricingBody = (c: PricingChoices) => ({
  minimum_profits: c.minimums.map((m) => ({ product_id: m.product_id, scope: m.scope, scope_id: m.scope === 'product' ? '' : m.scope_id, amount_usd: m.amount_usd.trim() === '' ? null : m.amount_usd.trim() })),
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

/** Apply one product (inputs and the typed minimum profits) from a saved purchase. */
export function applyPurchase(productId: string, purchaseId: string, previewHash: string, choices: PricingChoices) {
  const body = pricingBody(choices);
  return api.post<{ success: boolean; already: boolean; rows_changed: number }>(`${PRICING}/products/${encodeURIComponent(productId)}/apply-purchase`, {
    purchase_id: purchaseId,
    preview_hash: previewHash,
    use_purchase: choices.usePurchase[productId] !== false,
    prefer_purchase_values: choices.prefer[productId] === true,
    manual_line_opt_in: choices.optIn.filter((k) => k.startsWith(`${productId}:`)),
    minimum_profits: body.minimum_profits.filter((m) => m.product_id === productId).map(({ scope, scope_id, amount_usd }) => ({ scope, scope_id, amount_usd })),
  });
}

/** Whether a product has something an apply would write (its purchase values, or a typed minimum). */
export function hasSomethingToApply(p: PricingProduct, choices: PricingChoices): boolean {
  const typed = choices.minimums.some((m) => m.product_id === p.product_id);
  const values = p.use_purchase && p.eligible && p.entries.some((e) => Object.keys(e.changes).length > 0);
  return typed || values;
}
