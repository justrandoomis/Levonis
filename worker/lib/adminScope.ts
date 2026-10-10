/**
 * Who may see cost, and who may move money — owner decision 2 (2026-10-07):
 * «Main Admin / Owner فقط … حتى لو كان Assistant Admin يستطيع تعديل المنتجات
 * أو الطلبات، لا يستطيع رؤية أي Cost Data».
 *
 * TWO QUESTIONS, NEVER ONE AGAIN. Until S1 a single predicate answered both
 * "may this admin see a cost?" and "may this admin move money?", and every
 * NULL/'full' admin saw every cost. They are now separate predicates:
 *
 *   canViewCost / canWriteCost   COST: product, rung, lot, procurement, rate
 *                                and shipping data; profit, COGS, margins,
 *                                price history; finance, payroll, investors.
 *                                THE OWNER ONLY (INITIAL_ADMIN_EMAIL, with a
 *                                verified address; until it is verified the
 *                                owner is told so, OWNER_EMAIL_UNVERIFIED,
 *                                and sees no cost). A private grant
 *                                (0177 admin_private_grants) is honoured only
 *                                while PRIVATE_DELEGATION_ENABLED is true, and
 *                                it is false: decision 2 delegates nothing.
 *   canMoveMoney                 MONEY: wallet credits, refunds, payouts,
 *                                trade-in valuation, BNPL limits. The owner,
 *                                and admins whose scope is not 'assistant'.
 *   isOwner                      owner-only actions (scope elevation, investor
 *                                status, the security console).
 *
 * `users.admin_scope` (migration 0021):
 *   NULL / 'full'  money actions only — sees NO cost, no margin, no supplier
 *                  price, in the API, the HTML and every export
 *   'assistant'    catalogue and operations only; no money actions either
 *
 * Every new admin starts as an assistant (0177 trigger
 * `users_promotion_starts_assistant`, and the user PATCH route). The owner is
 * recognised by address in EVERY predicate before any stored scope is read,
 * so a stray 'assistant' on the owner row (the trigger sets one on the
 * bootstrap promotion) can never lock the owner out.
 *
 * This is an AUTHORIZATION rule, not a display preference. Every financial
 * field must be removed on the SERVER, before serialization, so that reading
 * the raw API response, the HTML or a downloaded file reveals nothing.
 */

import type { Env, SessionUser } from './types';
import { serverMessage } from '../../packages/contracts/src/costRefusals';

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

/** The bootstrap owner account named by INITIAL_ADMIN_EMAIL. Only the address
 *  is needed, so a stored user row qualifies as well as a session. */
export function isOwner(env: Env, user: Pick<SessionUser, 'email'> | null | undefined): boolean {
  const owner = (env.INITIAL_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!owner || !user || typeof user.email !== 'string') return false;
  return user.email.trim().toLowerCase() === owner;
}

/** The two private grants of 0177. Neither is ever handed out while delegation is off. */
export const PRIVATE_GRANTS = ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'] as const;
export type PrivateGrant = (typeof PRIVATE_GRANTS)[number];

/**
 * Owner decision 2 (2026-10-07): «في الوقت الحالي لا أريد تفويض بيانات التكلفة
 * لأي شخص غير Main Admin/Owner». While this is false a grant row is never read
 * and never honoured, so cost reaches the owner only. Turning it on is a
 * reviewed, owner-approved one-line commit; tests/costPredicateUsage.test.ts
 * pins it.
 */
export const PRIVATE_DELEGATION_ENABLED = false;

/** Tests pass `{ delegation: true }` to prove the grant path; production never does. */
export interface CostAccessOpts {
  delegation?: boolean;
}

/** The fields the predicates read. `private_grants` is set by the session loader only. */
export type CostSubject = Pick<SessionUser, 'role' | 'email'> & {
  admin_scope?: string | null;
  email_verified_at?: string | null;
  private_grants?: readonly string[] | null;
};

/** True when delegation is on AND this admin holds the grant. False whenever delegation is off. */
export function hasPrivateGrant(
  user: CostSubject | null | undefined,
  grant: PrivateGrant,
  opts: CostAccessOpts = {}
): boolean {
  if (!(opts.delegation ?? PRIVATE_DELEGATION_ENABLED)) return false;
  return !!user && user.role === 'admin' && Array.isArray(user.private_grants) && user.private_grants.includes(grant);
}

/** A real verification stamp: a non-blank string. NULL, '' and '   ' are none. */
function hasVerifiedAddress(user: Pick<CostSubject, 'email_verified_at'>): boolean {
  return typeof user.email_verified_at === 'string' && user.email_verified_at.trim() !== '';
}

/**
 * THE OWNER, PROVEN. Owner status is the address (critique A10): it is honoured
 * for cost only on an admin row whose address has been verified, so an
 * address that is somehow freed and re-registered does not inherit the costs
 * before anyone has proved they hold the mailbox. The owner chose this, the
 * most secure option (DECISIONS row 185, amendment of 2026-10-08).
 *
 * NO LOCKOUT, A WAY OUT. The deploy does not check the owner row (it never
 * reads `users`). An owner whose address is not verified yet is refused every
 * cost surface with OWNER_EMAIL_UNVERIFIED instead of the generic refusal
 * (`isUnverifiedOwner`, `costRefusal` in costAccess.ts), and the admin
 * screens offer the existing verification email. That link, or a sign-in
 * code to this address, first proves it only once the person accepted what
 * the proof ends (OWNER_FIRST_PROOF_REQUIRED); a Google sign-in leaves it
 * unproven (worker/lib/emailStamp.ts). The emailed link for
 * this address is confirmed only from a session of the account it belongs to
 * (VERIFY_SIGN_IN_REQUIRED, worker/routes/auth.ts), so a row that took the
 * address while it was free cannot be verified by the real owner's click. A
 * blank stamp ('' or spaces) is no stamp here and in every auth writer. The
 * session loader reads the row on every request, so cost opens on the very
 * next request after the stamp — no redeploy, no new sign-in.
 */
function isVerifiedOwner(env: Env, user: CostSubject): boolean {
  return isOwner(env, user) && hasVerifiedAddress(user);
}

/**
 * The owner's address on an ADMIN row whose address is not verified yet — the
 * one caller who is told how to open cost (OWNER_EMAIL_UNVERIFIED) rather than
 * refused with COST_ACCESS_DENIED. Never true for a non-admin row holding the
 * address, for any other admin, or while INITIAL_ADMIN_EMAIL is blank; never
 * true once the address is verified (the owner then sees cost).
 */
export function isUnverifiedOwner(env: Env, user: CostSubject | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false;
  return isOwner(env, user) && !hasVerifiedAddress(user);
}

/** COST READ: owner only (decision 2). The owner is decided before anything else is read. */
export function canViewCost(env: Env, user: CostSubject | null | undefined, opts: CostAccessOpts = {}): boolean {
  if (!user || user.role !== 'admin') return false;
  if (isVerifiedOwner(env, user)) return true;
  return hasPrivateGrant(user, 'PRICING_PRIVATE_READ', opts);
}

/** COST WRITE: owner only. A grantee would need READ and WRITE both — never WRITE alone. */
export function canWriteCost(env: Env, user: CostSubject | null | undefined, opts: CostAccessOpts = {}): boolean {
  if (!user || user.role !== 'admin') return false;
  if (isVerifiedOwner(env, user)) return true;
  return hasPrivateGrant(user, 'PRICING_PRIVATE_READ', opts) && hasPrivateGrant(user, 'PRICING_PRIVATE_WRITE', opts);
}

/**
 * MONEY: moving money and seeing non-cost money figures (revenue, wallets,
 * payouts). The body of the old `canViewFinancials`, unchanged: the owner, and
 * any admin whose scope is not an assistant's (NULL or 'full'). It reveals no
 * cost — decision 2 restricts cost data, not refunds.
 */
export function canMoveMoney(env: Env, user: CostSubject | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false;
  if (isOwner(env, user)) return true;
  return normalizeAdminScope(user.admin_scope) !== 'assistant';
}

/**
 * SERIAL VISIBILITY (owner decision 1, 2026-10-09; DECISIONS row 192): every
 * platform admin — the owner, full and legacy NULL scope, and assistants (the
 * preparer «المجهز», support) — sees the whole serial, because their work
 * needs it (scanning at preparation, device and warranty checks). A serial is
 * NOT cost: this never feeds canViewCost / canWriteCost / canMoveMoney or
 * projectForAdmin, and a customer, a merchant or a visitor is never an admin
 * here. Order numbers stay with canMoveMoney (the serial actor's `orderRefs`).
 */
export function canSeeFullSerial(env: Env, user: CostSubject | null | undefined): boolean {
  if (!user || user.role !== 'admin') return false;
  if (isOwner(env, user)) return true;
  const scope = normalizeAdminScope(user.admin_scope);
  switch (scope) {
    case null:
    case 'full':
    case 'assistant':
      return true;
  }
  // A scope added later must decide here, or this stops compiling.
  const exhaustive: never = scope;
  return exhaustive;
}

export type ViewerClass =
  | 'guest'
  | 'customer'
  | 'merchant'
  | 'assistant_admin'
  | 'full_admin'
  | 'cost_grantee'
  | 'owner';

/** Who is asking, in the vocabulary of refusals and security events. */
export function viewerClass(env: Env, user: CostSubject | null | undefined, opts: CostAccessOpts = {}): ViewerClass {
  if (!user) return 'guest';
  if (user.role === 'customer') return 'customer';
  if (user.role === 'merchant') return 'merchant';
  if (user.role !== 'admin') return 'customer';
  if (isOwner(env, user)) return 'owner';
  if (canViewCost(env, user, opts)) return 'cost_grantee';
  return canMoveMoney(env, user) ? 'full_admin' : 'assistant_admin';
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
  // -- USD procurement pricing (owner brief 2026-10-09, USD design §9; migration 0181): the minimum
  // -- profit in USD, the USD chain's figures, the procurement card's summary and the converted
  // -- legacy minimum. Private pricing values; none collides with a public name.
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
  // -- the procurement card's pricing (USD design §5): the summary's cents, the direct-sale
  // -- price beside it, the store price it is compared with, the document's own rate, the
  // -- IQD-converted supplier cost's provenance and the card's current minimum profits.
  'target_profit_cents',
  'supplier_cost_cents',
  'shipping_cost_cents',
  'additional_cost_cents',
  'direct_sale_price_iqd',
  'store_price_iqd',
  'document_rate',
  'iqd_converted',
  'minimum_profits',
  // -- the writer's preview (owner decision 8): what a PRO and a PRIME member pay before and after
  // -- the engine writes the product's prices (the fee waivers and typed member prices it removes).
  'pro_before_iqd',
  'pro_after_iqd',
  'prime_before_iqd',
  'prime_after_iqd',
  // -- FX-5 (FX plan §7.8, §8): the preview before an owner rate act — how far today's price lies
  // -- below the new replacement cost + minimum profit (a cost oracle).
  'deficit_iqd',
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

/**
 * Applies the COST rule in one call at a route boundary: the owner gets the
 * payload, everyone else gets it with every FINANCIAL_FIELDS key removed —
 * full and NULL-scope admins included (decision 2). This is the second net;
 * new private surfaces answer through allowlist DTOs.
 */
export function projectForAdmin<T>(env: Env, user: CostSubject | null | undefined, payload: T): T {
  return canViewCost(env, user) ? payload : stripFinancials(payload);
}

// ------------------------------------------------- who may change whom

/** The stored row an administrator is editing. */
export interface UserPatchTarget {
  id: string;
  role: string;
  email: string;
  is_investor: number | boolean | null;
  /** The stored scope. Absent on a caller that predates S1 — read as NULL. */
  admin_scope?: string | null;
}

/** What the request asks to set. Absent means "not sent". */
export interface UserPatchChanges {
  role?: 'customer' | 'merchant' | 'admin';
  is_investor?: boolean;
  admin_scope?: AdminScope | null;
}

/** A refusal the route throws as `new HttpError(status, message, code)`. */
export interface UserPatchRefusal {
  status: 400 | 403;
  code:
    | 'SELF_DEMOTE'
    | 'OWNER_LOCKED'
    | 'ROLE_CHANGE_DENIED'
    | 'PROMOTION_STARTS_ASSISTANT'
    | 'SCOPE_ELEVATION_OWNER_ONLY'
    | 'INVESTOR_FLAG_OWNER_ONLY';
  message: string;
}

const patchRefusal = (code: UserPatchRefusal['code'], status: 400 | 403 = 403): UserPatchRefusal => ({
  status,
  code,
  message: serverMessage(code),
});

/**
 * The scope this account will hold once the role part of the PATCH has been
 * written: a promotion always lands on 'assistant' (decision 2, the 0177
 * trigger), an existing admin keeps the scope stored on the row.
 */
function scopeAfterRole(target: UserPatchTarget, changes: UserPatchChanges): AdminScope | null {
  if (target.role !== 'admin' && changes.role === 'admin') return 'assistant';
  return normalizeAdminScope(target.admin_scope);
}

/**
 * True when this PATCH widens an admin's scope ('assistant' → 'full'/NULL).
 * That is an owner-only act the route also gates on a fresh sign-in.
 */
export function userPatchElevates(target: UserPatchTarget, changes: UserPatchChanges): boolean {
  const resultingRole = changes.role ?? target.role;
  if (resultingRole !== 'admin' || changes.admin_scope === undefined) return false;
  if (changes.admin_scope === 'assistant') return false;
  return scopeAfterRole(target, changes) !== changes.admin_scope;
}

/**
 * Why an administrator's PATCH of an account must be refused, or null when
 * it may proceed (owner decision 2; security spec §4.3).
 *
 *   - Nobody removes their own admin role (SELF_DEMOTE); the owner is never
 *     demoted or restricted (OWNER_LOCKED).
 *   - Minting or revoking an administrator needs money scope
 *     (ROLE_CHANGE_DENIED): an assistant cannot promote a second account of
 *     their own and sign in to wider access.
 *   - EVERY NEW ADMIN STARTS AS AN ASSISTANT. A promotion that asks for a
 *     wider scope is refused (PROMOTION_STARTS_ASSISTANT) unless the owner
 *     asks, in which case it is an elevation in the same request (critique D5).
 *   - Widening a scope to 'full' or NULL is the owner's alone
 *     (SCOPE_ELEVATION_OWNER_ONLY). Restricting to 'assistant' needs money
 *     scope. Neither scope grants a single cost: cost is the owner's.
 *   - Investor status is changed by the owner only (INVESTOR_FLAG_OWNER_ONLY).
 *
 * ONLY A CHANGE IS AN ATTEMPT. The admin panel echoes the whole row on every
 * save, so an assistant editing a membership tier sends role: 'admin' for an
 * admin it never touched. A value equal to what is stored is not a request to
 * change it. (Role and scope are no secret from the admin who sends them, so
 * comparing with the stored value leaks nothing here — unlike cost, which
 * `attemptedFinancialWrites` decides from the request alone.)
 */
export function userPatchRefusal(
  env: Env,
  actor: SessionUser,
  target: UserPatchTarget,
  changes: UserPatchChanges
): UserPatchRefusal | null {
  const owner = isOwner(env, actor) && actor.role === 'admin';
  const money = canMoveMoney(env, actor);
  const roleChanges = changes.role !== undefined && changes.role !== target.role;
  if (roleChanges) {
    if (target.id === actor.id && changes.role !== 'admin') return patchRefusal('SELF_DEMOTE');
    if (isOwner(env, target) && changes.role !== 'admin') return patchRefusal('OWNER_LOCKED');
    if ((changes.role === 'admin' || target.role === 'admin') && !money) return patchRefusal('ROLE_CHANGE_DENIED');
  }
  const promotion = target.role !== 'admin' && changes.role === 'admin';
  if (promotion && changes.admin_scope !== undefined && changes.admin_scope !== 'assistant' && !owner) {
    return patchRefusal('PROMOTION_STARTS_ASSISTANT', 400);
  }
  const resultingRole = changes.role ?? target.role;
  if (resultingRole === 'admin' && changes.admin_scope !== undefined && changes.admin_scope !== scopeAfterRole(target, changes)) {
    if (changes.admin_scope === 'assistant') {
      if (isOwner(env, target)) return patchRefusal('OWNER_LOCKED');
      if (!money) return patchRefusal('ROLE_CHANGE_DENIED');
    } else if (!owner) {
      return patchRefusal('SCOPE_ELEVATION_OWNER_ONLY');
    }
  }
  if (changes.is_investor !== undefined && changes.is_investor !== Boolean(target.is_investor) && !owner) {
    return patchRefusal('INVESTOR_FLAG_OWNER_ONLY');
  }
  return null;
}

// ------------------------------------------------- the write side of §11

/** The shape the cost rules care about — product doc, or the stored previous. */
export interface CostBearing {
  product_cost_iqd: number | null;
  options: Array<{ id: string; cost_iqd: number | null }>;
  colors: Array<{ id: string; cost_iqd: number | null }>;
}

/**
 * Which cost fields this request CARRIED — names only, decided from the
 * request alone (owner decision 2).
 *
 * NEVER FROM THE STORED VALUE. This used to compare what was sent with what
 * was stored and refuse only a DIFFERENT number, so a non-owner could send a
 * guess and read the answer: 200 for the stored cost, 403 for anything else —
 * an equality oracle on a number they may not see. Now any cost key that
 * carries a value is refused, whatever is stored, and the answer is the same
 * for a right guess and a wrong one.
 *
 * ABSENT OR NULL IS NOT AN ATTEMPT. A non-owner's own GET returns the
 * document with every cost removed, and the product form fills a missing
 * field from its blank document — so it posts `product_cost_iqd: null` back.
 * Reading that as "blank the stored cost" refused every save of a priced
 * product; reading it by comparing with the stored value leaked whether a
 * cost exists. Null and absent are carried forward silently
 * (`carryStoredCostForward`), the same whatever is stored.
 *
 * @param raw the request body exactly as it arrived, before validation
 */
export function attemptedFinancialWrites(raw: Record<string, unknown>): string[] {
  const given = (v: unknown) => v !== null && v !== undefined && v !== '';
  const attempted: string[] = [];
  if (given(raw.product_cost_iqd)) attempted.push('product_cost_iqd');
  for (const [kind, list] of [
    ['option', raw.options],
    ['color', raw.colors],
  ] as const) {
    if (!Array.isArray(list)) continue;
    list.forEach((x, i) => {
      if (!x || typeof x !== 'object') return;
      const row = x as Record<string, unknown>;
      const id = typeof row.id === 'string' && row.id ? row.id : `#${i}`;
      for (const field of ['cost_iqd', 'cost_adjust_iqd'] as const) {
        if (given(row[field])) attempted.push(`${kind}:${id}.${field}`);
      }
    });
  }
  return attempted;
}

/**
 * Puts the stored costs back on a document an assistant saved, so a save that
 * never carried a cost cannot blank one. Mutates `doc` and returns it.
 */
export function carryStoredCostForward<T extends CostBearing>(doc: T, prev: CostBearing | null): T {
  doc.product_cost_iqd = prev?.product_cost_iqd ?? null;
  const prevOption = new Map((prev?.options ?? []).map((o) => [o.id, o.cost_iqd]));
  for (const o of doc.options) o.cost_iqd = prevOption.get(o.id) ?? null;
  const prevColor = new Map((prev?.colors ?? []).map((x) => [x.id, x.cost_iqd]));
  for (const col of doc.colors) col.cost_iqd = prevColor.get(col.id) ?? null;
  return doc;
}
