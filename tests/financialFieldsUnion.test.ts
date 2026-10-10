/**
 * THE NAMING CONTRACT FOR PRIVATE KEYS — master plan §2.3 (C17), critique A6,
 * step S1.
 *
 * `FINANCIAL_FIELDS` is the second net behind every allowlist DTO: whatever
 * key is in it is stripped from every non-owner answer that goes through
 * `projectForAdmin`, at any depth. S1 adds the whole programme's private key
 * names to it ONCE, before any table carries them, so a later step cannot ship
 * a private column under a name the net does not know. This file pins that
 * union, both byte-identical copies, and the names that must NEVER join it
 * because they are public or wallet fields elsewhere (F18).
 *
 * Run: node --import tsx --test tests/financialFieldsUnion.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FINANCIAL_FIELDS, stripFinancials } from '../worker/lib/adminScope';
import { FINANCIAL_FIELDS as KIT_FIELDS } from '../packages/platform-kit/src/scope';

const LIST = new Set<string>(FINANCIAL_FIELDS as readonly string[]);

/** Security spec §4.1, the reserved list. */
const SEC = [
  'supplier_cost', 'supplier_cost_original', 'supplier_currency', 'converted_supplier_cost_iqd', 'fx_rate', 'fx_rates',
  'fx_rate_snapshot', 'exchange_rate_at_purchase', 'shipping_profile', 'shipping_rate', 'shipping_rates', 'shipping_rate_snapshot',
  'shipping_rate_at_purchase', 'shipping_cost_iqd', 'actual_shipping_cost_iqd', 'additional_cost_iqd', 'actual_additional_cost_iqd',
  'pricing_weight_g', 'shipping_weight_g', 'shipping_length_mm', 'shipping_width_mm', 'shipping_height_mm', 'shipping_cbm',
  'manual_cbm', 'calculated_cbm', 'effective_cbm', 'cbm_used', 'weight_used_g', 'replacement_cost_iqd',
  'current_replacement_cost_iqd', 'current_replacement_cost_snapshot_iqd', 'target_profit_iqd', 'direct_sale_premium_iqd',
  'estimated_cost_iqd', 'estimated_profit_iqd', 'actual_profit_iqd', 'actual_unit_cost_iqd', 'actual_total_cost_iqd',
  'actual_landed_cost_per_unit_iqd', 'landed_cost_iqd', 'replacement_margin_iqd', 'net_profit_iqd', 'shipping_cost_allocated_iqd',
  'other_order_costs_allocated_iqd', 'store_borne_shipping_iqd', 'store_borne_cod_iqd', 'pricing_inputs', 'pricing_rules',
  'pricing_breakdown', 'cost_breakdown', 'pricing_missing', 'pricing_revision_detail', 'rounding_step_iqd', 'min_margin_percent',
  'min_profit_iqd',
];

/** Master plan §2.3, by area. */
const AREAS: Record<string, readonly string[]> = {
  ENG: ['supplier_cost_delta', 'supplier_amount', 'fx_version', 'shipping_version', 'supplier_cost_iqd', 'target_rule_id', 'premium_rule_id', 'pricing_costs'],
  RUN: ['breakdown_json'],
  IMP: ['pricing_private', 'pricing_token'],
  INV: [
    'supplier_line_total_original', 'weight_g_used', 'volume_mm3_used', 'freight_unit_iqd', 'additional_unit_iqd',
    'receipt_unit_cost_iqd', 'effective_unit_cost_iqd', 'next_unit_cost_iqd', 'next_free_unit_cost_iqd', 'expected_profit_iqd',
    'preorder_margin_iqd', 'owner_costs', 'remaining_amount_iqd', 'sold_amount_iqd', 'restated_amount_iqd', 'recognized_iqd',
    'unit_delta_iqd', 'period_corrections', 'inventory_cost_corrections_iqd', 'derived_snapshot', 'supplier_hint',
  ],
  ORD: [
    'estimated_unit_cost_iqd', 'estimated_net_revenue_iqd', 'replacement_unit_cost_iqd', 'target_profit_unit_iqd',
    'direct_premium_unit_iqd', 'fx_snapshot_json', 'shipping_rate_snapshot_json', 'supplier_cost_snapshot_json',
    'estimated_unit_cost', 'estimated_profit', 'actual_unit_cost', 'actual_total_cost', 'current_replacement_cost_snapshot',
    'target_profit_snapshot', 'direct_premium_snapshot', 'replacement_margin_at_sale', 'estimate_vs_actual_variance',
    'cost_variance', 'fx_snapshot', 'shipping_rate_snapshot', 'supplier_cost_snapshot', 'store_borne_delivery_expected',
    'recorded_catalogue_cost', 'gross_profit', 'net_profit', 'preorder_estimated_cogs_iqd', 'restored_cogs_iqd',
  ],
  // Critique A6: columns of 0179/0183 and of the run DTO the lists above missed.
  A6: [
    'supplier_cost', 'supplier_currency', 'pricing_weight_g', 'shipping_weight_g', 'shipping_length_mm', 'shipping_width_mm',
    'shipping_height_mm', 'manual_cbm', 'source_ref', 'fx_rate', 'shipping_rate', 'shipping_cost_iqd', 'additional_cost_iqd',
    'replacement_cost_iqd', 'target_profit_iqd', 'direct_premium_iqd', 'preorder_base_iqd', 'computed_price_iqd',
    'effective_weight_g', 'shipping_cbm', 'effective_cbm', 'rate_iqd', 'below_target', 'stored_iqd', 'computed_iqd',
  ],
  // Master plan v2 check (C2-A6): 0181's legacy columns, the engine's exact
  // intermediates, the run hashes (cost oracles) and the value JSON of
  // pricing_audit and pricing_previews. Added in S1 because L1 and R1 may not
  // edit adminScope.ts or scope.ts.
  V2CHECK: [
    'old_option_costs_json', 'old_color_costs_json', 'old_cells_json', 'old_routes_json', 'old_procurement_json',
    'old_physical_json', 'resolver_cost_iqd', 'variant_cost_iqd', 'target_iqd', 'premium_iqd', 'inherited_premium_iqd',
    'target_plan_json', 'premium_plan_json', 'legacy_hash', 'eval_fingerprint', 'result_hash', 'supplier_cost_exact',
    'shipping_cost_exact', 'replacement_exact', 'rounding_added_iqd', 'pricing_before_json', 'pricing_after_json',
    'summary_json', 'change_json', 'samples_json',
  ],
  // FX-0 (FX plan §11, §4.5): "Direct Sale Extra" replaces "premium" in the
  // pricing engine. The new names join the net…
  FX0: ['direct_sale_extra_iqd', 'extra_rule_id', 'extra_rule_version', 'direct_sale_extra_unit_iqd', 'direct_sale_extra_snapshot'],
  // …and every old name STAYS in it: a renamed field is private under both
  // names (defence in depth), so an older client, a stale cache or a missed
  // rename can never carry one unstripped.
  FX0_OLD_NAMES_KEPT: [
    'direct_sale_premium_iqd', 'direct_premium_iqd', 'premium_rule_id', 'direct_premium_unit_iqd', 'direct_premium_snapshot',
    'premium_iqd', 'inherited_premium_iqd', 'premium_plan_json',
  ],
  // FX-1 (FX plan §4.5): the whole programme's FX names join the net in the
  // first push, before most tables carry them — every exchange-rate figure of
  // 0179, the owner's rates DTO, the previews and their hash, the current
  // costs and the batch snapshot.
  FX1: [
    'supplier_cost_amount', 'supplier_cost_currency', 'supplier_input_mode', 'current_supplier_cost_usd_exact', 'current_supplier_cost_iqd',
    'original_input_amount', 'original_input_currency', 'conversion_rate_snapshot', 'conversion_fx_version', 'canonical_supplier_cost_usd',
    'converted_at', 'usd_iqd_rate', 'usd_fx_version', 'cross_rate', 'cross_fx_version', 'market_rate', 'market_buy', 'official_rate',
    'source_usd_per_eur', 'source_cny_per_eur', 'manual_rate', 'effective_rate', 'effective_rates_iqd', 'last_known_good_rate',
    'pending_market_rate', 'pending_effective_rate', 'adjustment_iqd_per_usd', 'drift_anchor_rate', 'rejected_rate', 'last_observed',
    // owner decision 5: the adjustment's own name (the old wire name above stays in the net); decision 10: the history's old → new
    'market_adjustment_iqd', 'settings_diff',
    'preview_hash', 'supplier_cost_view', 'current_usd', 'current_iqd', 'rate_used', 'iqd_snapshot', 'procurement_suggestion',
    'supplier_cost_mode', 'current_shipping_cost_iqd', 'current_additional_costs_iqd', 'supplier_cost_usd_at_purchase',
    'usd_iqd_rate_at_purchase', 'eur_usd_rate_at_purchase', 'cny_usd_rate_at_purchase', 'historical_usd_equivalent',
    'supplier_original_amount', 'supplier_original_currency', 'shipping_actual_unit_iqd', 'additional_cost_actual_unit_iqd',
    'shipping_actual_iqd', 'additional_cost_actual_iqd', 'actual_landed_cost_iqd', 'fx_usd_iqd_at_purchase', 'fx_eur_usd_at_purchase',
    'fx_cny_usd_at_purchase',
    // the FX history rows' rate columns: before, after and the held candidate
    'effective_before', 'effective_after', 'pending_rate',
  ],
  // USD-pricing design §9 (owner brief 2026-10-09). P-A: the profit page's USD
  // display block, the report-only deductions, the estimate apart, today's rate
  // and the promotion-rate suggestion; P-B..P-D names joined in the same push.
  USD_DESIGN: [
    'display_usd', 'price_protection_iqd', 'net_after_report_adjustments_iqd', 'owner_period_net_after_report_adjustments_iqd',
    'estimated_revenue_iqd', 'today_rate', 'rate_suggestion', 'fx_rate_snapshot',
    'minimum_target_profit_usd', 'target_profit_usd', 'target_profit_iqd_exact', 'amount_usd', 'current_total_cost_usd',
    'supplier_cost_usd', 'shipping_cost_usd', 'additional_cost_usd', 'final_price_usd', 'current_total_cost_cents',
    'final_price_cents', 'pricing_summary', 'legacy_amount_iqd', 'legacy_usd_iqd_rate', 'actual_purchase_cost_iqd',
    'actual_landed_cost_iqd', 'actual_additional_costs_iqd',
  ],
  // USD procurement pricing (USD design §9; migration 0181): the minimum profit in
  // USD, the USD chain's figures, the card's summary and the converted legacy minimum.
  // FX-6 (FX plan §4.3, §4.5; migration 0182): a batch's purchase snapshot beyond the FX-1 names —
  // the version of each rate, when and from where it was taken, the purchase snapshot's versions and
  // the lot's landed total in the owner's batch read model.
  FX6: [
    'usd_iqd_fx_version', 'eur_usd_fx_version', 'cny_usd_fx_version', 'fx_snapshot_at', 'fx_snapshot_source',
    'fx_usd_iqd_version_at_purchase', 'fx_eur_usd_version_at_purchase', 'fx_cny_usd_version_at_purchase', 'actual_landed_total_iqd',
  ],
  USD_PRICING: [
    'minimum_target_profit_usd', 'target_profit_usd', 'target_profit_iqd_exact', 'amount_usd', 'current_total_cost_usd',
    'supplier_cost_usd', 'shipping_cost_usd', 'additional_cost_usd', 'final_price_usd', 'current_total_cost_cents',
    'final_price_cents', 'pricing_summary', 'legacy_amount_iqd', 'legacy_usd_iqd_rate', 'actual_purchase_cost_iqd',
    'actual_additional_costs_iqd',
  ],
};

/**
 * PRIVATE, BUT NOT IN THE NET (master plan v2 §2.3). Two kinds of entry, each
 * with its reason:
 *   - a private column whose name collides with a public or wallet field
 *     elsewhere: it stays out of FINANCIAL_FIELDS and is kept out of every
 *     non-owner DTO by allowlist instead (the entry says where the collision
 *     is). Later steps add here — not to adminScope.ts — when a grep of the
 *     public DTOs finds a collision;
 *   - an owner-only key that carries no amount (a code, a state, a count, a
 *     flag, a container), served only behind requireCostRead (P1 below).
 * Note: a few CODE keys can still name a fact about cost — `reason_codes` may
 * hold LEGACY_COST_ZERO, LEGACY_SALE_NOT_ABOVE_COST or
 * COST_LESS_SPECIFIC_THAN_PRICE. That is fine while only the verified owner is
 * answered; a DTO reused for anyone else must move those keys into
 * FINANCIAL_FIELDS first.
 */
const PRIVATE_NON_FINANCIAL: Readonly<Record<string, string>> = {
  // Pricing engine MVP P1 («التسعير والشحن», worker/lib/pricingEngine/dto.ts):
  // owner-only keys that carry no amount — a code, a state, a count, a flag or
  // a container — served only behind requireCostRead. Each is new to the code
  // base (no public DTO uses it); none needs the strip, and none may carry a
  // figure (the money keys of the same answers are in FINANCIAL_FIELDS).
  preview_only: 'a constant true: the answer is a preview and nothing was written',
  status_counts: 'how many products sit in each §2.3 status — counts, never amounts',
  migration_status: 'a §2.3 status code (CONFLICT … READY)',
  typed_member_price_products: 'how many products carry a typed PRIME/PRO price — a count',
  typed_member_prices: 'yes/no: the product carries a typed PRIME/PRO price',
  reason_codes: 'reason and readiness CODES only (labels in contracts), never a figure',
  info_codes: 'informational reason CODES only',
  issue_codes: 'E1 readiness CODES of one what-if channel',
  resolver_errors: "the resolver's refusal CODES for one channel",
  reason_figures: 'a container: a reason code with its route and its figure, the figure under legacy_reason_iqd (FINANCIAL_FIELDS)',
  channel_mix: 'BOTH / DIRECT_ONLY / PREORDER_ONLY / NOT_SELLABLE — how a model sells',
  model_count: 'how many models a product has — a count',
  base_route: 'the route name (air / sea / land) a Direct Sale Extra is measured from',
  direct_sale_extra: 'a container: one derived Direct Sale Extra with its state, reasons and candidates, the amount under direct_sale_extra_iqd (FINANCIAL_FIELDS)',
  migration_state: 'the state code of one derived value (MIGRATED, CONFLICT, …)',
  roundtrip_ok: 'yes/no: the derived values give the old prices back',
  suggested_measures: 'a container: the public package measures, each under a FINANCIAL_FIELDS key',
  weight_scope: "which level (base / option) a suggested weight comes from — a level name",
  box_scope: "which level (base / option) a suggested box comes from — a level name",
  cod_priced_as_direct: 'yes/no: cash on delivery re-prices the pre-order from the direct ladder',
  price_rung: "the resolver rung that set today's price (base, option, fulfillment, transport, color)",
  cost_rung: 'the resolver rung that set the old cost — a rung name, never the cost',
  rate_origin: 'where a rate came from (procurement_profiles / what_if) — never the rate',
};

/**
 * FX-1 (FX plan §8, worker/lib/fx/dto.ts): the owner's rates panel and its
 * history. Owner-only keys that carry no rate — a code, a state, a time, a
 * count, a flag, a percentage threshold or a container — served only behind
 * requireCostRead. Every rate of the same answers, the sanity bounds and the
 * moves (an oracle on a held candidate) are in FINANCIAL_FIELDS.
 */
const FX_PRIVATE_NON_FINANCIAL: Readonly<Record<string, string>> = {
  pairs: 'a container: the three FX pairs, each rate under a FINANCIAL_FIELDS key',
  key_configured: 'yes/no: the IQWealth key binding is set — never the key',
  refresh_budget: 'a container: how many manual refreshes ran today and the daily limit — counts',
  provider_budget: "a container: today's provider calls per pair and the cap — counts",
  engine_products: 'how many products the engine prices — a count',
  reprice_blocked: 'how many products a repricing could not reach — a count',
  stale_products: 'how many products wait for a repricing — a count',
  used_today: 'a count of calls or refreshes today',
  cap: "the provider's daily call cap — a count",
  pair: 'the pair code (USD_IQD / EUR_USD / CNY_USD)',
  mode: 'AUTO / MANUAL — how a pair is kept',
  interval_hours: 'how often the scheduler checks a pair (6 / 12 / 24) — hours',
  fetch_status: "the last provider fetch's state code (OK / FAILED / STALE / INVALID)",
  last_check_result: "the last check's result code (APPLIED / NO_CHANGE / REVIEW_HELD …)",
  last_error_code: "the last refusal's CODE (TIMEOUT, KEY_REJECTED …) — never the provider's text",
  failing_since: 'when the provider started failing — a time',
  last_checked_at: 'when the pair was last checked — a time',
  last_successful_at: 'when the provider last answered well — a time',
  next_check_at: 'when the scheduler checks the pair next — a time',
  effective_source: 'who set the rate in force (provider / manual / review_approved …) — never the rate',
  effective_version: 'a version counter of the rate in force',
  effective_applied_at: 'when the rate in force was applied — a time',
  drift_anchor_at: 'when the drift anchor was last confirmed — a time',
  owner_version: 'the optimistic-concurrency token of the owner acts (L3) — a counter',
  anomaly_threshold_pct: "the owner's anomaly guard — a percentage, not a rate",
  drift_threshold_pct: "the owner's slow-drift guard — a percentage, not a rate",
  min_change_pct: "the owner's dead band — a percentage, not a rate",
  pending: 'a container: the held candidate, its rates under FINANCIAL_FIELDS keys',
  rejected: 'a container: the rejected candidate, its rate under rejected_rate (FINANCIAL_FIELDS)',
  attribution: "a container: the provider's name and site, as its terms require",
  basis: 'weight / volume — how a shipping profile is measured',
  trigger_kind: 'cron / refresh / owner / back_to_auto — what started a history row',
  rejected_at: 'when the owner rejected the held candidate — a time',
  observed_at: 'when a held or observed candidate was seen — a time',
  repriced_products: 'how many products a history row repriced — a count (FX-5 fills it)',
  USD: 'a container: the dinar rate of the dollar, under rate_iqd (FINANCIAL_FIELDS)',
  EUR: 'a container: the dinar rate of the euro, under rate_iqd (FINANCIAL_FIELDS)',
  CNY: 'a container: the dinar rate of the yuan, under rate_iqd (FINANCIAL_FIELDS)',
  USD_IQD: "a container: the USD/IQD provider's calls today and its cap — counts",
  formula_holds: 'yes/no: the USD/IQD in force is exactly the market sell plus market_adjustment_iqd (owner decision 5) — never a figure',
};

/**
 * P-A (design §8-§9): the profit page's USD display. Every key below sits
 * INSIDE `display_usd` (in the net, so the whole block is stripped from any
 * non-owner answer) or beside a stripped figure; none carries an amount.
 * `usd_basis` is named for what it is — `basis` is customer-visible in a
 * price-protection policy snapshot (worker/routes/returns.ts). `coupon_iqd`
 * stays out of the net on purpose: the order.create audit detail carries it
 * and it is no cost (the overlay's coupon is a deduction the customer saw).
 */
const PA_PRIVATE_NON_FINANCIAL: Readonly<Record<string, string>> = {
  usd_basis: "'at_time' / 'today' — which rate an order was shown at, never the rate",
  at_time_count: 'how many orders were converted at the rate of their own time — a count',
  today_count: "how many orders fell back to today's rate («≈») — a count",
  approximate: 'yes/no: some figure fell back to today\'s rate',
  batch_cost_lines: "how many lines' goods cost is at their batches' purchase-time rates (FX-6) — a count",
};

/**
 * FX-6 (FX plan §4.3, §8; worker/lib/batchSnapshot.ts): the owner's batch
 * read model, GET /api/admin/pricing/batches. Owner-only keys that carry no
 * figure — a container, a code, a flag, a version marker, a time or a lot id
 * — served only behind requireCostRead; every figure, rate, rate version and
 * the snapshot's source are in FINANCIAL_FIELDS. The generic column names
 * (snapshot_version, snapshot_source, calculated_at, split_from_lot_id) stay
 * out of the net and out of every assistant lot read by the explicit column
 * lists (tests/batchSnapshotPrivacy.test.ts).
 */
const FX6_PRIVATE_NON_FINANCIAL: Readonly<Record<string, string>> = {
  batches: 'a container: the batches of one product, lot or purchase',
  installed: 'yes/no: migration 0182 is on this database',
  batch_cost: 'a container: what the batch actually cost in IQD, each figure under a FINANCIAL_FIELDS key',
  snapshot_state: "'recorded' / 'derived' / 'iqd_only' — how much of the purchase-time snapshot is known",
  snapshot: 'a container: the purchase-time snapshot, each figure under a FINANCIAL_FIELDS key',
  derived: 'a container: an old batch\'s equivalent derived from its own purchase, under FINANCIAL_FIELDS keys',
  derived_from: "'purchase_document' / 'purchase_snapshot' — where a derived figure came from, never the figure",
  unknown_fields: 'the NAMES of the snapshot figures that are unknown («غير معروف») — never a value',
  snapshot_version: 'a constant 1 marking a recorded snapshot',
  snapshot_source: "'purchase' / 'legacy_incoming' — which receipt wrote the snapshot",
  calculated_at: 'when the snapshot was recorded at receipt — a time',
  split_from_lot_id: 'the parent batch id of a transfer split — an id',
};

/**
 * NEVER private names (F18, security spec §4.1, critique A6): each is a public
 * or wallet field elsewhere, so stripping it would break those screens — and a
 * private value under one of them would slip through. A private column must
 * be named by what it is (`direct_sale_extra_iqd`, not `amount_iqd`).
 */
const FORBIDDEN = [
  'breakdown', 'rounding_iqd', 'pricing', 'valuation', 'exchange_rate', 'exchange_rate_snapshot', 'shipping_cost', 'amount_iqd',
  // membership_benefit_versions and the finance history tables: the benefit
  // editor's version list reads them (src/components/adminBenefits).
  'before_json', 'after_json',
];

/** The cost names that predate S1 and must stay. */
const LEGACY = ['cost_iqd', 'product_cost_iqd', 'margin_iqd', 'margin_percent', 'supplier_price_iqd', 'cost_adjust_iqd', 'profit_iqd', 'unit_cost_iqd', 'exchange_rate_used', 'source_currency'];

test('the security spec reserved list is in FINANCIAL_FIELDS, every name', () => {
  assert.deepEqual(SEC.filter((k) => !LIST.has(k)), []);
});

for (const [area, names] of Object.entries(AREAS)) {
  test(`the ${area} names of the §2.3 union are in FINANCIAL_FIELDS`, () => {
    assert.deepEqual(names.filter((k) => !LIST.has(k)), []);
  });
}

test('the names that predate S1 are still there', () => {
  assert.deepEqual(LEGACY.filter((k) => !LIST.has(k)), []);
});

test('none of the forbidden names is in the list (F18)', () => {
  assert.deepEqual(FORBIDDEN.filter((k) => LIST.has(k)), []);
});

test('a name is either in the net or registered as private-but-not-in-the-net, never both', () => {
  for (const dict of [PRIVATE_NON_FINANCIAL, FX_PRIVATE_NON_FINANCIAL, PA_PRIVATE_NON_FINANCIAL, FX6_PRIVATE_NON_FINANCIAL]) {
    assert.deepEqual(Object.keys(dict).filter((k) => LIST.has(k)), []);
    for (const [k, why] of Object.entries(dict)) assert.ok(why.trim().length > 0, `${k} needs its reason`);
  }
});

test('no duplicates, every name snake_case — the camelCase match is the stripper’s job', () => {
  assert.equal(LIST.size, FINANCIAL_FIELDS.length, 'a name listed twice');
  for (const k of FINANCIAL_FIELDS) assert.match(k, /^[a-z][a-z0-9_]*$/, k);
});

test('both byte-identical copies hold the same union (the core and the dark gateway)', () => {
  assert.deepEqual([...KIT_FIELDS], [...FINANCIAL_FIELDS]);
});

test('every union name is stripped at depth, snake and camel alike; the forbidden names survive', () => {
  const nested = Object.fromEntries([...LIST].map((k) => [k, 1]));
  const camel = Object.fromEntries([...LIST].map((k) => [k.replace(/_([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase()), 1]));
  const publicFields = Object.fromEntries(FORBIDDEN.map((k) => [k, 7]));
  const out = stripFinancials({ a: [{ b: { ...nested, ...camel, ...publicFields } }] });
  assert.deepEqual(out, { a: [{ b: publicFields }] });
});

// ------------------------------------------------------------- the pricing DTOs (MVP P1)

/**
 * EVERY KEY THE «التسعير والشحن» ROUTER ANSWERS IS CLASSIFIED (MVP plan §6 P1):
 * a key new to the code base is in FINANCIAL_FIELDS or in
 * PRIVATE_NON_FINANCIAL with its reason; a key the code base already uses
 * elsewhere (`id`, `slug`, `channel`, `page`…) is shared vocabulary; and every
 * key that names money, a rate or a measure is in FINANCIAL_FIELDS, whatever
 * else it is. The answers are walked to their last leaf: the overview, the
 * detail of products of every shape, the what-if and its refusals.
 */
test('MVP P1: every key the pricing router answers is in FINANCIAL_FIELDS, in PRIVATE_NON_FINANCIAL, or shared vocabulary — and every money key is in the net', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const { OWNER, asD1, freshDb, stubApp } = await import('./fixtures/app');
  const { call } = await import('./fixtures/roleMatrix');
  const { seedLegacyCatalogue, seedProfileRates } = await import('./fixtures/legacyCatalogue');
  const { adminPricingRoutes } = await import('../worker/routes/adminPricing');

  const raw = freshDb();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  raw.exec("UPDATE products SET prime_price_iqd = 1 WHERE id = 'lp_08'");
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/pricing', adminPricingRoutes));
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  walk((await call(app, 'GET', '/api/admin/pricing/overview')).body);
  for (const id of ['lp_01', 'lp_04', 'lp_07', 'lp_08', 'lp_10', 'lp_15', 'lp_31', 'lp_35', 'lp_41']) walk((await call(app, 'GET', `/api/admin/pricing/products/${id}`)).body);
  for (const body of [
    { supplier_cost: '500', currency: 'EUR' },
    { supplier_cost: '500', currency: 'USD' },
    { supplier_cost: '500', currency: 'CNY', option_id: 'lp_08_o0', additional_cost_iqd: 1, measures: { manual_cbm: '0.5' }, rates: { shipping: { CHINA_SEA: '1' } } },
    { supplier_cost: '500', currency: 'EUR', nope: 1 },
    { supplier_cost: 'x', currency: 'EUR' },
  ]) {
    walk((await call(app, 'POST', '/api/admin/pricing/products/lp_08/what-if', body)).body);
  }
  assert.ok(keys.size > 60, `only ${keys.size} keys walked`);

  // Shared vocabulary: the key is already written as an object key somewhere
  // in the Worker outside the pricing router and its modules.
  const files: string[] = [];
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'pricingEngine' && name !== 'fx') collect(p);
      } else if (p.endsWith('.ts') && name !== 'adminPricing.ts') files.push(p);
    }
  };
  collect(join(ROOT, 'worker'));
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const shared = (k: string) => new RegExp(`(^|[^\\w$])${k}\\s*\\??:`, 'm').test(corpus) || new RegExp(`['"]${k}['"]\\s*:`).test(corpus);

  // Not vacuous: the router's own new names are not "shared", the old ones are.
  assert.equal(shared('preview_only'), false);
  assert.equal(shared('migration_status'), false);
  assert.equal(shared('slug'), true);
  const unclassified = [...keys].filter((k) => !LIST.has(k) && !(k in PRIVATE_NON_FINANCIAL) && !shared(k)).sort();
  assert.deepEqual(unclassified, [], 'add each to FINANCIAL_FIELDS (both copies) or to PRIVATE_NON_FINANCIAL with its reason');
  const MONEY = /_iqd$|_mm$|_g$|cbm|^fx_|_rate$|_rates$|^supplier_|^replacement_|^shipping_|^landed_/;
  const unnetted = [...keys].filter((k) => MONEY.test(k) && !LIST.has(k)).sort();
  assert.deepEqual(unnetted, [], 'a money, rate or measure key outside FINANCIAL_FIELDS');
  // Rules are named by kind, never amount_iqd (C2-A6).
  assert.equal(keys.has('amount_iqd'), false);
  // Every PRIVATE_NON_FINANCIAL name is really answered (no stale reason).
  assert.deepEqual(Object.keys(PRIVATE_NON_FINANCIAL).filter((k) => !keys.has(k)), []);
});

// ------------------------------------------------------------- the rates DTOs (FX-1)

/**
 * EVERY KEY THE RATES ROUTES ANSWER IS CLASSIFIED (FX plan §4.5, §8, §14.2
 * S1): `GET /rates` with every container filled — a held candidate, a
 * rejected one, a MANUAL pair with what a refresh observed — and the history
 * of every event kind. A key new to the code base is in FINANCIAL_FIELDS or in
 * FX_PRIVATE_NON_FINANCIAL with its reason; every money, rate or measure key
 * is in the net; and the strip leaves no seeded figure in the answer.
 */
test('FX-1: every key the rates routes answer is in FINANCIAL_FIELDS, in FX_PRIVATE_NON_FINANCIAL, or shared vocabulary — and the strip leaves no rate', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const { OWNER, asD1, freshDb, stubApp } = await import('./fixtures/app');
  const { call } = await import('./fixtures/roleMatrix');
  const { seedFxSentinels, FX_SENTINELS, FX_PUBLIC_RATE } = await import('./fixtures/fxSentinels');
  const { adminPricingRoutes } = await import('../worker/routes/adminPricing');

  const raw = freshDb();
  seedFxSentinels(raw);
  // CNY/USD kept by hand, with what a refresh observed (L14): last_observed is filled.
  raw.exec(`UPDATE fx_rate_pairs SET mode='MANUAL', manual_rate='0.1412698', effective_source='manual' WHERE pair='CNY_USD';
    INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, market_rate, pending_rate, result, error_code, created_at)
      VALUES ('fxl_s4', 'CNY_USD', 'observed', 'refresh', 'ecb', '0.1412698', '0.1412698', 'OBSERVED', NULL, '2026-10-08T12:30:00.000Z'),
             ('fxl_s5', 'EUR_USD', 'failure', 'cron', 'ecb', NULL, NULL, 'FAILED', 'TIMEOUT', '2026-10-08T12:40:00.000Z');`);
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/pricing', adminPricingRoutes));
  const keys = new Set<string>();
  const answers: unknown[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
    }
  };
  for (const path of ['/api/admin/pricing/rates', '/api/admin/pricing/rates/history', '/api/admin/pricing/rates/history?pair=USD_IQD&limit=2']) {
    const res = await call(app, 'GET', path);
    assert.equal(res.status, 200, path);
    answers.push(res.body);
    walk(res.body);
  }
  const rates = answers[0] as { pairs: { pair: string; pending: unknown; rejected: unknown; last_observed: unknown }[] };
  assert.ok(rates.pairs.find((p) => p.pair === 'USD_IQD')!.pending, 'the walk reached a held candidate');
  assert.ok(rates.pairs.find((p) => p.pair === 'USD_IQD')!.rejected, 'the walk reached a rejected candidate');
  assert.ok(rates.pairs.find((p) => p.pair === 'CNY_USD')!.last_observed, 'the walk reached what a refresh observed');
  assert.ok(keys.size > 50, `only ${keys.size} keys walked`);

  const files: string[] = [];
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== 'pricingEngine' && name !== 'fx') collect(p);
      } else if (p.endsWith('.ts') && name !== 'adminPricing.ts') files.push(p);
    }
  };
  collect(join(ROOT, 'worker'));
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const shared = (k: string) => new RegExp(`(^|[^\\w$])${k}\\s*\\??:`, 'm').test(corpus) || new RegExp(`['"]${k}['"]\\s*:`).test(corpus);
  // Not vacuous: the FX modules' own names are not "shared".
  assert.equal(shared('key_configured'), false);
  assert.equal(shared('effective_rates_iqd'), false);
  const unclassified = [...keys].filter((k) => !LIST.has(k) && !(k in FX_PRIVATE_NON_FINANCIAL) && !shared(k)).sort();
  assert.deepEqual(unclassified, [], 'add each to FINANCIAL_FIELDS (both copies) or to FX_PRIVATE_NON_FINANCIAL with its reason');
  const MONEY = /_iqd$|_mm$|_g$|cbm|^fx_|_rate$|_rates$|_rates_iqd$|^supplier_|^replacement_|^shipping_|^landed_|^market_|^effective_rate|_before$|_after$|_pct$|_ppm$|^bound_/;
  const PCT_SETTINGS = new Set(['anomaly_threshold_pct', 'drift_threshold_pct', 'min_change_pct']);
  const unnetted = [...keys].filter((k) => MONEY.test(k) && !LIST.has(k) && !PCT_SETTINGS.has(k)).sort();
  assert.deepEqual(unnetted, [], 'a money, rate or measure key outside FINANCIAL_FIELDS');
  assert.equal(keys.has('effective_iqd'), false, 'never the staff-wage name (F14c)');
  // Every FX_PRIVATE_NON_FINANCIAL name is really answered (no stale reason).
  assert.deepEqual(Object.keys(FX_PRIVATE_NON_FINANCIAL).filter((k) => !keys.has(k)), []);
  // The net, applied to the whole answer, leaves no seeded figure behind (S1):
  // a figure under a generic key would survive the strip.
  const stripped = JSON.stringify(stripFinancials(answers));
  for (const v of [...FX_SENTINELS, FX_PUBLIC_RATE]) assert.equal(stripped.includes(v), false, `${v} survives the strip`);
});

// ------------------------------------------------------------- the profit page's USD display (P-A)

/**
 * `display=USD` on «الأرباح والتكاليف» adds ONE block, `display_usd`, and the
 * net strips it whole: a stripped answer carries no cent figure, no rate and
 * none of the report-only deduction amounts — the same answer an IQD read
 * gives once stripped. Every P-A key that is not in the net is registered and
 * really answered.
 */
test('P-A: the USD display block and the report deductions are stripped whole; the registered keys are answered', async () => {
  const { asD1, freshDb, stubApp, get, json } = await import('./fixtures/app');
  const { adminFinanceWorkspaceRoutes } = await import('../worker/routes/adminFinanceWorkspace');
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('boss','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','union-usd-printer',99000,1);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at,coupon_snapshot)
      VALUES ('o','buyer','delivered','{}','standard','{}','cash',320000,1400,320000,320000,0,'2026-03-04T09:00:00.000Z','2026-03-05T10:00:00.000Z','{"code":"S","discount_iqd":7777}');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('o:1','o','p','Printer',1,320000,320000,111111,'snapshot');
    INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state) VALUES ('c','buyer','o','o:1',320000,316543,1,3457,'credited');
    UPDATE fx_rate_pairs SET effective_rate='1612.5', effective_version=1, drift_anchor_rate='1612.5', effective_source='provider' WHERE pair='USD_IQD';
    INSERT INTO fx_rate_log(id,pair,event,trigger_kind,effective_before,effective_after,result,created_at) VALUES ('l1','USD_IQD','apply','cron',NULL,'1587.25','APPLIED','2026-03-01T00:00:00.000Z');`);
  const app = stubApp(asD1(raw), { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  };
  const answers: unknown[] = [];
  for (const path of ['/f/summary?from=2026-03-01&to=2026-03-31&display=USD', '/f/orders?from=2026-03-01&to=2026-03-31&display=USD', '/f/orders/o?display=USD']) {
    const res = await get(app, path);
    assert.equal(res.status, 200, path);
    const body = await json(res);
    assert.equal(body.display_usd.available, true, path);
    answers.push(body);
    walk(body.display_usd);
  }
  assert.deepEqual(Object.keys(PA_PRIVATE_NON_FINANCIAL).filter((k) => !keys.has(k)), [], 'every registered P-A key is answered');
  const stripped = JSON.stringify(stripFinancials(answers));
  assert.equal(stripped.includes('display_usd'), false);
  // (`wallet_applied_usd_cents` is an orders column the wallet owns, not this block's.)
  assert.doesNotMatch(stripped, /"(net_goods|cogs|gross_profit|owner_net|owner_period_net|coupon|price_protection)_cents"|1587\.25|1612\.5|"price_protection_iqd"|net_after_report_adjustments/, 'no cent figure, rate or deduction survives the strip');
});


// ------------------------------------------------------------- the batch read model (FX-6)

/**
 * EVERY KEY GET /api/admin/pricing/batches ANSWERS IS CLASSIFIED (FX plan
 * §4.3, §4.5, §14.2 S1): a recorded snapshot, a split child, a derived old
 * batch and one known only in IQD are walked to their last leaf. A key new to
 * the code base is in FINANCIAL_FIELDS or in FX6_PRIVATE_NON_FINANCIAL with
 * its reason; every money, rate or measure key is in the net; and the strip
 * leaves no seeded figure.
 */
test('FX-6: every key the batch read model answers is in FINANCIAL_FIELDS, in FX6_PRIVATE_NON_FINANCIAL, or shared vocabulary — and the strip leaves no figure', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const { OWNER, asD1, freshDb, stubApp } = await import('./fixtures/app');
  const { call } = await import('./fixtures/roleMatrix');
  const { BATCH_SENTINELS, BATCH_SENTINEL_LOT, seedBatchSentinels } = await import('./fixtures/fxSentinels');
  const { adminPricingRoutes } = await import('../worker/routes/adminPricing');

  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('usr_owner','boss@x.co','admin');
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('p_a1','A','fx6-keys-a',1000,0,'BASE');
    INSERT INTO purchase_orders(id,currency,exchange_rate,purchase_day,status,cost_state,created_by,created_at,updated_at)
      VALUES ('po_usd','USD',1500,'2026-09-01','received','final','usr_owner','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,status)
      VALUES ('inc_usd','p_a1','base','',1,1,300000,0,0,'received');
    INSERT INTO purchase_lines(id,purchase_id,incoming_id,label,source_unit_amount) VALUES ('pl_usd','po_usd','inc_usd','A',200);
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,incoming_id,received_at)
      VALUES ('lot_derived','p_a1','base','',1,1,300000,300000,0,0,300000,'received','inc_usd','2026-09-02T00:00:00.000Z'),
             ('lot_iqd','p_a1','base','',1,1,1000,1000,0,0,1000,'opening',NULL,'2026-01-01T00:00:00.000Z');`);
  seedBatchSentinels(raw);
  raw.exec(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,
      snapshot_version,snapshot_source,purchase_id,supplier_original_currency,supplier_original_amount,supplier_cost_mode,exchange_rate_at_purchase,usd_iqd_rate_at_purchase,fx_snapshot_source,historical_usd_equivalent,calculated_at,split_from_lot_id)
    SELECT 'lot_child',product_id,scope,scope_id,1,1,unit_cost_iqd,purchase_unit_iqd,0,0,unit_cost_iqd,cost_basis,received_at,1,snapshot_source,purchase_id,supplier_original_currency,supplier_original_amount,supplier_cost_mode,exchange_rate_at_purchase,usd_iqd_rate_at_purchase,fx_snapshot_source,historical_usd_equivalent,calculated_at,'${BATCH_SENTINEL_LOT}'
      FROM inventory_lots WHERE id = '${BATCH_SENTINEL_LOT}'`);
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/pricing', adminPricingRoutes));
  const res = await call(app, 'GET', '/api/admin/pricing/batches?product_id=p_a1');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const states = ((res.body as { batches: Array<{ snapshot_state: string }> }).batches).map((b) => b.snapshot_state).sort();
  assert.deepEqual(states, ['derived', 'iqd_only', 'recorded', 'recorded']);
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
  };
  walk(res.body);
  assert.ok(keys.size > 30, `only ${keys.size} keys walked`);

  const files: string[] = [];
  const collect = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) collect(p);
      else if (p.endsWith('.ts') && name !== 'adminPricing.ts' && name !== 'batchSnapshot.ts') files.push(p);
    }
  };
  collect(join(ROOT, 'worker'));
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const shared = (k: string) => new RegExp(`(^|[^\\w$])${k}\\s*\\??:`, 'm').test(corpus) || new RegExp(`['"]${k}['"]\\s*:`).test(corpus);
  assert.equal(shared('snapshot_state'), false, 'not vacuous');
  const unclassified = [...keys].filter((k) => !LIST.has(k) && !(k in FX6_PRIVATE_NON_FINANCIAL) && !shared(k)).sort();
  assert.deepEqual(unclassified, [], 'add each to FINANCIAL_FIELDS (both copies) or to FX6_PRIVATE_NON_FINANCIAL with its reason');
  const MONEY = /_iqd$|_mm$|_g$|cbm|^fx_|_rate$|_rates$|^supplier_|^replacement_|^shipping_|^landed_|_at_purchase$|_usd$|equivalent/;
  assert.deepEqual([...keys].filter((k) => MONEY.test(k) && !LIST.has(k)).sort(), [], 'a money, rate or measure key outside FINANCIAL_FIELDS');
  assert.deepEqual(Object.keys(FX6_PRIVATE_NON_FINANCIAL).filter((k) => !keys.has(k) && k !== 'installed'), [], 'a stale reason');
  // The strip leaves no figure: every sentinel is gone once the net has run.
  const stripped = JSON.stringify(stripFinancials(res.body));
  for (const s of BATCH_SENTINELS) assert.equal(stripped.includes(s), false, s);
});
