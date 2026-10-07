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
};

/**
 * NEVER private names (F18, security spec §4.1, critique A6): each is a public
 * or wallet field elsewhere, so stripping it would break those screens — and a
 * private value under one of them would slip through. A private column must
 * be named by what it is (`direct_premium_iqd`, not `amount_iqd`).
 */
const FORBIDDEN = ['breakdown', 'rounding_iqd', 'pricing', 'valuation', 'exchange_rate', 'exchange_rate_snapshot', 'shipping_cost', 'amount_iqd'];

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
