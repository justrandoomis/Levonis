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
};

/**
 * PRIVATE, BUT NOT IN THE NET (master plan v2 §2.3). A private column whose
 * name collides with a public or wallet field elsewhere stays out of
 * FINANCIAL_FIELDS and is kept out of every non-owner DTO by allowlist
 * instead. Each entry says where the collision is. Later steps add here — not
 * to adminScope.ts — when a grep of the public DTOs finds a collision.
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
  base_route: 'the route name (air / sea / land) a premium is measured from',
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
 * NEVER private names (F18, security spec §4.1, critique A6): each is a public
 * or wallet field elsewhere, so stripping it would break those screens — and a
 * private value under one of them would slip through. A private column must
 * be named by what it is (`direct_premium_iqd`, not `amount_iqd`).
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
  assert.deepEqual(Object.keys(PRIVATE_NON_FINANCIAL).filter((k) => LIST.has(k)), []);
  for (const [k, why] of Object.entries(PRIVATE_NON_FINANCIAL)) assert.ok(why.trim().length > 0, `${k} needs its reason`);
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
        if (name !== 'pricingEngine') collect(p);
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
