/**
 * The owner's availability-pricing round, pinned:
 *
 *  1. The DIRECT premium (products.direct_surcharge_iqd) — immediacy priced
 *     like a transport journey. It lands in unit_subtotal on direct lines
 *     only and NEVER stacks with a pre-order commission (the customer pays
 *     the journey they picked, not both).
 *  2. The card price is the CHEAPEST way to buy the product: display_* on
 *     listings is the minimum tier-resolved price across base/options/
 *     colours, with each tier's cheapest teaser price alongside.
 *  3. The inventory source is DERIVED, not hand-picked: the most specific
 *     level with numbers wins; combinations survive as a legacy island.
 *  4. Bundles are visible to every ACTIVE paid tier — PLUS, PRIME and PRO
 *     («هذه الميزه تظهر لمشتركين فقط البلس والبريميوم والبرو») and no one
 *     else; a support restriction still switches the section off.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice } from '../worker/lib/pricing';
import type { PricingProduct } from '../worker/lib/pricing';
import { benefits } from '../worker/lib/entitlements';
import type { TierStatus } from '../worker/lib/entitlements';
import { deriveInventoryMode } from '../src/components/adminProducts/form/model';
import type { RelationsState } from '../src/components/adminProducts/form/model';

const product = (over: Partial<PricingProduct> = {}): PricingProduct => {
  const selling_type = over.selling_type ?? 'direct_sale';
  return {
    price_iqd: 100_000, pro_price_iqd: null, prime_price_iqd: null, product_cost_iqd: 60_000,
    options: [], colors: [], preorder_transports: [], warranty_plans: [],
    ...over,
    selling_type,
    sale_types: over.sale_types ?? [selling_type as 'direct_sale' | 'pre_order' | 'bundle'],
  };
};

const free = { tier: 'free' as const, tierActive: false };
const pro = { tier: 'pro' as const, tierActive: true };

// ------------------------------------------------------- 1. direct premium

test('direct premium: added to unit_subtotal on a direct line, reported in `direct`', () => {
  const r = resolveUnitPrice({ product: product({ direct_surcharge_iqd: 50_000 }), ...free });
  assert.equal(r.applied_iqd, 100_000); // the item price itself is untouched
  assert.deepEqual(r.direct, { surcharge_iqd: 50_000 });
  assert.equal(r.unit_subtotal_iqd, 150_000); // the FINAL number the customer sees
});

test('direct premium: never stacks with a pre-order commission', () => {
  const p = product({
    sale_types: ['direct_sale', 'pre_order'],
    direct_surcharge_iqd: 50_000,
    preorder_transports: [{ method: 'sea', commission_iqd: 0, active: true }, { method: 'land', commission_iqd: 15_000, active: true }],
  });
  // The buyer picked the land journey: its commission applies, the direct
  // premium does not.
  const landLine = resolveUnitPrice({ product: p, transportMethod: 'land', ...free });
  assert.equal(landLine.direct, null);
  assert.equal(landLine.unit_subtotal_iqd, 115_000);
  // The buyer picked immediacy: the premium applies, no commission.
  const directLine = resolveUnitPrice({ product: p, ...free });
  assert.equal(directLine.transport, null);
  assert.equal(directLine.unit_subtotal_iqd, 150_000);
});

test('direct premium: sea at zero commission still beats direct at +50k (the owner\'s example)', () => {
  const p = product({
    sale_types: ['direct_sale', 'pre_order'],
    direct_surcharge_iqd: 50_000,
    preorder_transports: [{ method: 'sea', commission_iqd: 0, active: true }],
  });
  const sea = resolveUnitPrice({ product: p, transportMethod: 'sea', ...free });
  assert.equal(sea.unit_subtotal_iqd, 100_000);
});

test('direct premium: never invented — null/0 add nothing, a pre-order-only product cannot carry it', () => {
  assert.equal(resolveUnitPrice({ product: product({ direct_surcharge_iqd: null }), ...free }).direct, null);
  assert.equal(resolveUnitPrice({ product: product({ direct_surcharge_iqd: 0 }), ...free }).direct, null);
  const preorderOnly = product({
    selling_type: 'pre_order',
    direct_surcharge_iqd: 50_000,
    preorder_transports: [{ method: 'air', commission_iqd: 25_000, active: true }],
  });
  const r = resolveUnitPrice({ product: preorderOnly, transportMethod: 'air', ...free });
  assert.equal(r.direct, null);
  assert.equal(r.unit_subtotal_iqd, 125_000);
});

test('direct premium: not waived by PRO (only the pre-order commission waiver is PRO\'s)', () => {
  const r = resolveUnitPrice({ product: product({ direct_surcharge_iqd: 50_000 }), ...pro });
  assert.equal(r.unit_subtotal_iqd, 150_000);
});

// -------------------------------------- 2. card price = cheapest variant

import { publicWithDisplayPrice } from '../worker/routes/products';
import { DEFAULT_PRO_POLICY } from '../worker/lib/pricing';

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'p1', slug: 'p1', status: 'active', name: 'Printer', price_iqd: 100_000,
  selling_type: 'direct_sale', sale_types: JSON.stringify(['direct_sale']),
  options: JSON.stringify([
    { id: 'o1', name_en: 'A1', regular_price_iqd: 80_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, active: true, order: 0, image: '', name_ar: '', name_ckb: '' },
    { id: 'o2', name_en: 'A2', regular_price_iqd: 120_000, prime_price_iqd: 90_000, pro_price_iqd: null, cost_iqd: null, active: true, order: 1, image: '', name_ar: '', name_ckb: '' },
  ]),
  colors: JSON.stringify([]),
  images: '[]', specifications: '[]', labels: '[]', hashtags: '[]', warranty_plans: '[]',
  preorder_transports: '[]', content_blocks: '[]', payment_options: '[]',
  ...over,
});

const freeCtx = { tier: 'free' as const, tierActive: false, proPolicy: DEFAULT_PRO_POLICY, transportDefaults: [] };
const primeCtx = { tier: 'prime' as const, tierActive: true, proPolicy: DEFAULT_PRO_POLICY, transportDefaults: [] };

test('card price: the CHEAPEST variant wins, honestly labelled «يبدأ من»', () => {
  const out = publicWithDisplayPrice(row(), freeCtx);
  assert.equal(out.display_price_iqd, 80_000); // option A1, not the 100k base
  assert.equal(out.display_regular_iqd, 80_000); // the SAME level's regular
  assert.equal(out.display_from, true); // 80k..120k genuinely differ
  // The cheapest explicit PRIME anywhere feeds the faint teaser line.
  assert.equal(out.display_prime_iqd, 90_000);
  assert.equal(out.display_pro_iqd, null); // no PRO price exists → no teaser
});

test('card price: a PRIME viewer\'s minimum uses their tier level by level', () => {
  const out = publicWithDisplayPrice(row(), primeCtx);
  // A1 has no prime price → its applied stays 80k; A2's prime is 90k; the
  // base row has none → 100k. Cheapest is still A1 at 80k, with its own
  // regular beside it — never a cross-variant comparison.
  assert.equal(out.display_price_iqd, 80_000);
  assert.equal(out.display_applied_tier, 'regular');
  assert.equal(out.display_regular_iqd, 80_000);
});

test('card price: a flat product (no variants) keeps its plain base numbers', () => {
  const out = publicWithDisplayPrice(row({ options: '[]' }), freeCtx);
  assert.equal(out.display_price_iqd, 100_000);
  assert.equal(out.display_from, false);
});

// -------------------------------------------- 3. derived inventory source

const rel = (over: Partial<RelationsState> = {}): RelationsState => ({
  inventory_mode: 'BASE',
  groups: [],
  colors: [],
  variants: [],
  images: [],
  facet_ids: [],
  ...over,
});

const valueWith = (stock: number | null) => ({
  id: 'v1', name_en: 'A1', sku_part: '', image: '', sort: 0, active: true,
  stock, low_stock_threshold: null,
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
});

const colorWith = (stock: number | null) => ({
  id: 'c1', name_en: 'Black', hex: '#000000', image: '', sku_part: '', sort: 0, active: true,
  stock, low_stock_threshold: null, option_value_ids: [],
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
});

test('derived mode: no level numbers → BASE', () => {
  assert.equal(deriveInventoryMode(rel()), 'BASE');
  // Untracked (null) rows do not claim the level.
  assert.equal(
    deriveInventoryMode(
      rel({ groups: [{ id: 'g', name_en: 'G', sort: 0, active: true, values: [valueWith(null)] }], colors: [colorWith(null)] })
    ),
    'BASE'
  );
});

test('derived mode: option numbers → OPTION; a colour number (more specific) wins → COLOR', () => {
  const withOption = rel({ groups: [{ id: 'g', name_en: 'G', sort: 0, active: true, values: [valueWith(7)] }] });
  assert.equal(deriveInventoryMode(withOption), 'OPTION');
  const withBoth = rel({
    groups: [{ id: 'g', name_en: 'G', sort: 0, active: true, values: [valueWith(7)] }],
    colors: [colorWith(0)], // zero is a real number, not "untracked"
  });
  assert.equal(deriveInventoryMode(withBoth), 'COLOR');
});

test('derived mode: an existing combinations product keeps VARIANT_COMBINATION; an empty one derives away', () => {
  const variant = {
    id: 'pv1', option_value_ids: ['v1'], color_id: null, sku: '', active: true,
    stock: 3, low_stock_threshold: null,
    regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
  };
  assert.equal(deriveInventoryMode(rel({ inventory_mode: 'VARIANT_COMBINATION', variants: [variant] })), 'VARIANT_COMBINATION');
  assert.equal(deriveInventoryMode(rel({ inventory_mode: 'VARIANT_COMBINATION', variants: [] })), 'BASE');
});

// ------------------------------------------------- 4. bundles entitlement

const status = (tier: TierStatus['tier'], active = true, gated: string[] = []): TierStatus => ({
  tier,
  active,
  expires_at: null,
  pending_launch: null,
  gated_benefits: gated,
});

test('bundles gate: every ACTIVE paid tier is in — PLUS, PRIME and PRO', () => {
  assert.equal(benefits.exclusiveSections(status('plus')), true);
  assert.equal(benefits.exclusiveSections(status('prime')), true);
  assert.equal(benefits.exclusiveSections(status('pro')), true);
});

test('bundles gate: free, expired, and support-restricted members are out', () => {
  assert.equal(benefits.exclusiveSections(status('free')), false);
  assert.equal(benefits.exclusiveSections(status('prime', false)), false);
  assert.equal(benefits.exclusiveSections(status('pro', true, ['exclusiveSections'])), false);
});
