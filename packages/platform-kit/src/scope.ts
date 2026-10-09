/**
 * Admin scope over the principal (`01-TARGET.md` §3.4, ADR-002 (a)): Identity
 * folds the owner rule into the signed `scope` claim (`owner | full |
 * assistant | null`), so no service needs `INITIAL_ADMIN_EMAIL` to decide who
 * may see cost (the owner only) or move money (owner or full). `normalizeAdminScope`, `FINANCIAL_FIELDS` and
 * `stripFinancials` are byte-identical copies of `worker/lib/adminScope.ts`
 * (pinned by `tests/edgeParity.test.ts`).
 */
import type { Principal, PrincipalScope } from '@levonis/contracts/rpc/common';

export type AdminScope = 'full' | 'assistant';

/**
 * UNSET IS UNRESTRICTED; UNRECOGNISED IS NOT.
 *
 * NULL meaning "full" is deliberate and documented above — migration 0021
 * could not be allowed to quietly demote every live admin. The defect was that
 * everything ELSE also meant full: `'assisstant'` with a typo, a value written
 * by an older build, a half-finished manual UPDATE, or anything a future
 * migration adds and this function has not learned yet all fell through the
 * same `return null`, and the scope predicate read that as "not an
 * assistant" — so a scope nobody recognised granted the cost, the margin and
 * the supplier price.
 *
 * The two cases are now told apart. Absent stays unrestricted, which is the
 * documented upgrade path. Present-but-unrecognised resolves to the LEAST
 * privilege, because the one thing certain about a value we cannot read is
 * that somebody meant to restrict something.
 */
export function normalizeAdminScope(v: unknown): AdminScope | null {
  if (v === 'assistant') return 'assistant';
  if (v === 'full') return 'full';
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  return 'assistant';
}

/** Every field name that carries financial information about a product. Used
 *  by the strippers below AND by the export/template paths, so a new financial
 *  field only has to be added in one place. */
export const FINANCIAL_FIELDS = [
  'cost_iqd',
  'product_cost_iqd',
  'margin_iqd',
  'margin_percent',
  'supplier_price_iqd',
  // 0044/§12: a cost adjustment is a cost, and a profit figure IS the margin
  // detail §11 restricts — leaking either would defeat stripping the cost.
  'cost_adjust_iqd',
  'profit_iqd',
  // 0098 — THE INVENTORY ACQUISITION COSTS. A lot's unit cost IS the cost of
  // goods sold for the units in it, so §11 covers it exactly as it covers
  // cost_iqd. The three components are the same fact broken into its parts,
  // and the totals are it summed — leaking any one would defeat stripping the
  // others.
  //
  // QUANTITIES ARE NOT HERE, and that is the line this list draws. An
  // assistant admin needs to see that twenty units are on the shelf and four
  // are reserved; §52 restricts what those units COST, not how many.
  //
  // Line comments and not a block: tests/edgeParity.test.ts extracts this
  // declaration by scanning balanced brackets and skips // but not /* */, so a
  // JSDoc here with a parenthesis in it reads as an unclosed declaration.
  'unit_cost_iqd',
  'purchase_unit_iqd',
  'purchase_total_iqd',
  'shipping_total_iqd',
  'shipping_share_iqd',
  'internal_delivery_total_iqd',
  'internal_share_iqd',
  'total_cost_iqd',
  'cogs_iqd',
  'inventory_value_iqd',
  'oldest_unit_cost_iqd',
  'newest_unit_cost_iqd',
  'gross_profit_iqd',
  'procurement_defaults',
  'cost_profiles',
  'source_unit_amount',
  'source_total_amount',
  'shipping_rate_iqd',
  'auto_shipping_iqd',
  // What a purchase cost in total, and the currency and rate it was bought
  // at — the supplier price in all but name. The incoming list and the
  // inventory overview served these to assistants because none was named.
  'incoming_purchase_total_iqd',
  'exchange_rate_used',
  'source_currency',
  // Whether, and when, a confirmed purchase priced a selection.
  'cost_source',
  'cost_date',
  // S1 (owner decision 2, master plan §2.3 C17): THE NAMING CONTRACT for every
  // private pricing, batch and profit key the programme adds. A private key
  // that is not in this list fails review. Reserved here before any table
  // carries them, so a later step cannot ship one unstripped. Never add
  // breakdown, rounding_iqd, pricing, valuation, exchange_rate,
  // exchange_rate_snapshot, shipping_cost or amount_iqd: each is a public or
  // wallet field elsewhere, and stripping it would break those screens.
  // -- supplier, rates and private shipping measures (security spec 4.1)
  'supplier_cost',
  'supplier_cost_original',
  'supplier_currency',
  'converted_supplier_cost_iqd',
  'fx_rate',
  'fx_rates',
  'fx_rate_snapshot',
  'exchange_rate_at_purchase',
  'shipping_profile',
  'shipping_rate',
  'shipping_rates',
  'shipping_rate_snapshot',
  'shipping_rate_at_purchase',
  'shipping_cost_iqd',
  'actual_shipping_cost_iqd',
  'additional_cost_iqd',
  'actual_additional_cost_iqd',
  'pricing_weight_g',
  'shipping_weight_g',
  'shipping_length_mm',
  'shipping_width_mm',
  'shipping_height_mm',
  'shipping_cbm',
  'manual_cbm',
  'calculated_cbm',
  'effective_cbm',
  'cbm_used',
  'weight_used_g',
  // -- replacement cost, target profit and the profit figures
  'replacement_cost_iqd',
  'current_replacement_cost_iqd',
  'current_replacement_cost_snapshot_iqd',
  'target_profit_iqd',
  'direct_sale_premium_iqd',
  // FX-0 (FX plan §11): "Direct Sale Extra" replaces "premium". Each new
  // name sits beside its old one, and the old one STAYS: a renamed field is
  // private under both names (defence in depth).
  'direct_sale_extra_iqd',
  'estimated_cost_iqd',
  'estimated_profit_iqd',
  'actual_profit_iqd',
  'actual_unit_cost_iqd',
  'actual_total_cost_iqd',
  'actual_landed_cost_per_unit_iqd',
  'landed_cost_iqd',
  'replacement_margin_iqd',
  'net_profit_iqd',
  'shipping_cost_allocated_iqd',
  'other_order_costs_allocated_iqd',
  'store_borne_shipping_iqd',
  'store_borne_cod_iqd',
  'pricing_inputs',
  'pricing_rules',
  'pricing_breakdown',
  'cost_breakdown',
  'pricing_missing',
  'pricing_revision_detail',
  'rounding_step_iqd',
  'min_margin_percent',
  'min_profit_iqd',
  // -- engine model
  'supplier_cost_delta',
  'supplier_amount',
  'fx_version',
  'shipping_version',
  'supplier_cost_iqd',
  'target_rule_id',
  'premium_rule_id',
  'extra_rule_id',
  'extra_rule_version',
  'pricing_costs',
  // -- engine runs
  'breakdown_json',
  // -- import and template
  'pricing_private',
  'pricing_token',
  // -- inventory and batches
  'supplier_line_total_original',
  'weight_g_used',
  'volume_mm3_used',
  'freight_unit_iqd',
  'additional_unit_iqd',
  'receipt_unit_cost_iqd',
  'effective_unit_cost_iqd',
  'next_unit_cost_iqd',
  'next_free_unit_cost_iqd',
  'expected_profit_iqd',
  'preorder_margin_iqd',
  'owner_costs',
  'remaining_amount_iqd',
  'sold_amount_iqd',
  'restated_amount_iqd',
  'recognized_iqd',
  'unit_delta_iqd',
  'period_corrections',
  'inventory_cost_corrections_iqd',
  'derived_snapshot',
  'supplier_hint',
  // -- orders and profit
  'estimated_unit_cost_iqd',
  'estimated_net_revenue_iqd',
  'replacement_unit_cost_iqd',
  'target_profit_unit_iqd',
  'direct_premium_unit_iqd',
  'direct_sale_extra_unit_iqd',
  'fx_snapshot_json',
  'shipping_rate_snapshot_json',
  'supplier_cost_snapshot_json',
  'estimated_unit_cost',
  'estimated_profit',
  'actual_unit_cost',
  'actual_total_cost',
  'current_replacement_cost_snapshot',
  'target_profit_snapshot',
  'direct_premium_snapshot',
  'direct_sale_extra_snapshot',
  'replacement_margin_at_sale',
  'estimate_vs_actual_variance',
  'cost_variance',
  'fx_snapshot',
  'supplier_cost_snapshot',
  'store_borne_delivery_expected',
  'recorded_catalogue_cost',
  'gross_profit',
  'net_profit',
  'preorder_estimated_cogs_iqd',
  'restored_cogs_iqd',
  // -- critique A6: columns of the engine tables and the run DTO that the
  // -- lists above did not name
  'source_ref',
  'direct_premium_iqd',
  'preorder_base_iqd',
  'computed_price_iqd',
  'effective_weight_g',
  'rate_iqd',
  'below_target',
  'stored_iqd',
  'computed_iqd',
  // -- master plan v2 check (C2-A6, 2026-10-07): the legacy migration's 0181
  // -- columns, the engine's exact intermediates, the run hashes (each one is
  // -- a cost oracle: a hash over cost answers "is it still X?") and the
  // -- value JSON of pricing_audit and pricing_previews. pricing_audit names
  // -- its before/after columns pricing_before_json / pricing_after_json:
  // -- plain before_json / after_json are membership-benefit and finance
  // -- history fields elsewhere and must never join this list (F18).
  'old_option_costs_json',
  'old_color_costs_json',
  'old_cells_json',
  'old_routes_json',
  'old_procurement_json',
  'old_physical_json',
  'resolver_cost_iqd',
  'variant_cost_iqd',
  'target_iqd',
  'premium_iqd',
  'inherited_premium_iqd',
  'target_plan_json',
  'premium_plan_json',
  'legacy_hash',
  'eval_fingerprint',
  'result_hash',
  'supplier_cost_exact',
  'shipping_cost_exact',
  'replacement_exact',
  'rounding_added_iqd',
  'pricing_before_json',
  'pricing_after_json',
  'summary_json',
  'change_json',
  'samples_json',
  // -- pricing engine MVP P1 («التسعير والشحن», owner-only router): what a
  // -- guest pays today per channel next to the old landed cost — paid minus a
  // -- derived profit IS the cost, so each figure is private — the placed
  // -- legacy rules, a reason's figure, and a what-if's change against today.
  'today_item_iqd',
  'today_fee_iqd',
  'today_prepaid_iqd',
  'today_cod_iqd',
  'change_iqd',
  'legacy_rules',
  'legacy_reason_iqd',
  // -- FX programme plan §4.5 (FX-1 adds them all, before any table carries
  // -- most of them): supplier cost and the IQD snapshot, every exchange-rate
  // -- figure of the 0179 tables and the owner's rates DTO, the previews and
  // -- their hash (a hash over private values is an oracle), the current
  // -- costs, the Direct Sale Extra and the batch snapshot. NOT effective_iqd:
  // -- it is a staff-wage name (financeWageCalculation.ts); the rates DTO says
  // -- effective_rates_iqd (critique F14c).
  'supplier_cost_amount',
  'supplier_cost_currency',
  'supplier_input_mode',
  'current_supplier_cost_usd_exact',
  'current_supplier_cost_iqd',
  'original_input_amount',
  'original_input_currency',
  'conversion_rate_snapshot',
  'conversion_fx_version',
  'canonical_supplier_cost_usd',
  'converted_at',
  'usd_iqd_rate',
  'usd_fx_version',
  'cross_rate',
  'cross_fx_version',
  'market_rate',
  'market_buy',
  'official_rate',
  'source_usd_per_eur',
  'source_cny_per_eur',
  'manual_rate',
  'effective_rate',
  'effective_rates_iqd',
  'last_known_good_rate',
  'pending_market_rate',
  'pending_effective_rate',
  'adjustment_iqd_per_usd', // the retired wire name of market_adjustment_iqd, kept in the net
  'market_adjustment_iqd',
  // -- the settings_change rows of the FX history: old → new of every setting, the adjustment and bounds included
  'settings_diff',
  'drift_anchor_rate',
  'rejected_rate',
  'last_observed',
  // -- the FX history rows' rate columns: before, after and the held candidate
  'effective_before',
  'effective_after',
  'pending_rate',
  // -- beyond §4.5: the owner's sanity bounds are rates, and a move measured
  // -- against the public display rate gives the held candidate back (an
  // -- oracle, like preview_hash)
  'bound_min',
  'bound_max',
  'change_pct',
  'change_ppm',
  'preview_hash',
  'supplier_cost_view',
  'current_usd',
  'current_iqd',
  'rate_used',
  'iqd_snapshot',
  'procurement_suggestion',
  'supplier_cost_mode',
  'current_shipping_cost_iqd',
  'current_additional_costs_iqd',
  'supplier_cost_usd_at_purchase',
  'usd_iqd_rate_at_purchase',
  'eur_usd_rate_at_purchase',
  'cny_usd_rate_at_purchase',
  'historical_usd_equivalent',
  'supplier_original_amount',
  'supplier_original_currency',
  'shipping_actual_unit_iqd',
  'additional_cost_actual_unit_iqd',
  'shipping_actual_iqd',
  'additional_cost_actual_iqd',
  'actual_landed_cost_iqd',
  'fx_usd_iqd_at_purchase',
  'fx_eur_usd_at_purchase',
  'fx_cny_usd_at_purchase',
  // -- USD-pricing design (owner brief 2026-10-09) §9. P-A (accounting stays
  // -- IQD): the profit page's USD display block (every cent figure, rate and
  // -- basis under it), the report-only deductions, the estimate kept apart
  // -- (F1), today's rate and the promotion rate suggestion. P-B..P-D: the
  // -- minimum profit in USD and the engine's USD figures, the 4-cell summary
  // -- of the procurement card, the migrated dinar target and the actual
  // -- landed parts — named now so no later push ships one outside the net.
  // -- NOT coupon_iqd: the order.create audit detail carries it (worker/routes
  // -- /orders.ts) and it is no cost; the report's coupon column stays as is.
  'display_usd',
  'price_protection_iqd',
  'net_after_report_adjustments_iqd',
  'owner_period_net_after_report_adjustments_iqd',
  'estimated_revenue_iqd',
  'today_rate',
  'rate_suggestion',
  'minimum_target_profit_usd',
  'target_profit_usd',
  'target_profit_iqd_exact',
  'amount_usd',
  'current_total_cost_usd',
  'supplier_cost_usd',
  'shipping_cost_usd',
  'additional_cost_usd',
  'final_price_usd',
  'current_total_cost_cents',
  'final_price_cents',
  'pricing_summary',
  'legacy_amount_iqd',
  'legacy_usd_iqd_rate',
  'actual_purchase_cost_iqd',
  'actual_additional_costs_iqd',
] as const;

type AnyRecord = Record<string, unknown>;

/**
 * Recursively removes financial fields from a serializable value. Recursive
 * on purpose: cost lives at product, option, colour AND variant level, and a
 * shallow delete would leak every nested one.
 */
export function stripFinancials<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripFinancials(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const [k, v] of Object.entries(value as AnyRecord)) {
      // camelCase too: the lot receipt answered unitCostIqd, shippingShareIqd
      // and totalCostIqd, and a list of snake_case names matched none of them.
      const snake = k.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
      if ((FINANCIAL_FIELDS as readonly string[]).includes(k) || (FINANCIAL_FIELDS as readonly string[]).includes(snake)) continue;
      out[k] = stripFinancials(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** The signed claim Identity computes: owner > full > assistant; null for non-admins. */
export function scopeFor(input: { role: string; admin_scope: unknown; isOwner: boolean }): PrincipalScope {
  if (input.role !== 'admin') return null;
  if (input.isOwner) return 'owner';
  return normalizeAdminScope(input.admin_scope) === 'assistant' ? 'assistant' : 'full';
}

/**
 * MONEY scope over the principal (owner decision 2, S1): the owner or a 'full'
 * admin may move money (refunds, wallet credits, payouts). It reveals no cost.
 * The old name `canViewFinancials` is gone so nobody reads it as "may see cost".
 */
export function hasMoneyScopePrincipal(p: Principal | null | undefined): boolean {
  if (!p || p.role !== 'admin') return false;
  return p.scope === 'owner' || p.scope === 'full';
}

export const isOwnerPrincipal = (p: Principal | null | undefined): boolean => !!p && p.role === 'admin' && p.scope === 'owner';

/** COST over the principal: the owner only (decision 2; delegation is off). */
export const canViewCostPrincipal = (p: Principal | null | undefined): boolean => isOwnerPrincipal(p);

/** Applies the COST rule in one call at a route boundary: everyone but the owner gets the payload stripped. */
export function projectForPrincipal<T>(p: Principal | null | undefined, payload: T): T {
  return canViewCostPrincipal(p) ? payload : stripFinancials(payload);
}

/**
 * `admin:full` in the capability table = an admin with money scope (owner or
 * 'full'); `admin:owner` = the owner alone — every cost surface.
 */
export function meetsRequirement(
  p: Principal | null | undefined,
  requires: 'none' | 'auth' | 'investor' | 'admin' | 'admin:full' | 'admin:owner'
): boolean {
  switch (requires) {
    case 'none':
      return true;
    case 'auth':
      return !!p && p.role !== 'anonymous' && p.role !== 'system';
    case 'investor':
      return !!p && (p.investor || p.role === 'admin');
    case 'admin':
      return !!p && p.role === 'admin';
    case 'admin:full':
      return hasMoneyScopePrincipal(p);
    case 'admin:owner':
      return isOwnerPrincipal(p);
  }
}
