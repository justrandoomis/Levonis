/**
 * AVAILABILITY IS THE SCARCEST COMPONENT — case 1 of the owner's seventeen,
 * docs/BUNDLES_MYSTERY.md §2.
 *
 * Two things are proved here, and the second is the one that bites:
 *
 *   - the owner's worked example (printer 5, filament needs 2 of 6, nozzle 20
 *     → 3 bundles), and
 *   - DEMAND IS AGGREGATED PER STOCK ROW, NEVER PER COMPONENT. The surrogate
 *     `bundle_components.id` exists so one product may appear twice in a
 *     bundle, and two components can also resolve to one row through different
 *     routes. Judged independently, a row with 3 units and two components
 *     needing 2 each answers "1 bundle" — while buying that one bundle needs 4
 *     units. Nothing oversells (the guards and the fence hold), but the
 *     customer gets a permanent, deterministic CONFLICT_RETRY on a cart nobody
 *     is racing, and no screen can tell them why.
 *
 * Plus the fail-closed rule of §2.4: `products.stock` is NULL on a bundle for
 * ever, and NULL means "untracked → sell 99" everywhere else in
 * `saleAvailability`. Every call site is walked with a composition row and
 * asserted to return `max_qty === 0`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveStock, type InventorySnapshot, type StockResolution } from '../worker/lib/inventory';
import { resolveUnitPrice, type ResolvedPrice } from '../worker/lib/pricing';
import { bundleAvailability, COMPOSITION_LOW_BUNDLES, type ResolvedComponent } from '../worker/lib/bundleComposition';
import type { OfferCheck } from '../worker/lib/offers';
import { saleAvailability } from '../worker/routes/products';

const OPEN: OfferCheck = { ok: true, reason: null, required_tiers: [], locked_preview: true };
const LOCKED: OfferCheck = { ok: false, reason: 'MEMBERSHIP_REQUIRED', required_tiers: ['plus'], locked_preview: true };
const ENTITLED: OfferCheck = { ok: true, reason: null, required_tiers: ['plus'], locked_preview: true };
const NO_WINDOW = { starts_at: null, ends_at: null, nowMs: Date.parse('2026-06-01T00:00:00Z') };

const unitPrice = (): ResolvedPrice =>
  resolveUnitPrice({
    product: {
      price_iqd: 30_000,
      prime_price_iqd: null,
      pro_price_iqd: null,
      product_cost_iqd: null,
      selling_type: 'direct_sale',
      sale_types: ['direct_sale'],
      options: [],
      colors: [],
      preorder_transports: [],
      warranty_plans: [],
    } as never,
    tier: 'free',
    tierActive: false,
  });

/** A BASE-stock member product, resolved through the real inventory engine. */
const baseSnapshot = (stock: number | null, reserved = 0, threshold: number | null = null): InventorySnapshot => ({
  inventory_mode: 'BASE',
  base: { stock, reserved, low_stock_threshold: threshold },
  option_values: [],
  colors: [],
  variants: [],
  group_ids: [],
});

interface ComponentOpts {
  id: string;
  product: string;
  qty: number;
  resolution: StockResolution;
  optional?: boolean;
  included?: boolean;
  saleTypes?: string[];
  shipping?: ResolvedComponent['shipping_type'];
}
const component = (o: ComponentOpts): ResolvedComponent => ({
  component_id: o.id,
  member_product_id: o.product,
  qty_per_bundle: o.qty,
  optional: o.optional ?? false,
  included: o.included ?? true,
  selection: { option_value_ids: [], color_id: null },
  resolution: o.resolution,
  unit: unitPrice(),
  sale_types: o.saleTypes ?? ['direct_sale'],
  shipping_type: o.shipping ?? 'direct',
});

const base = (stock: number | null, reserved = 0, threshold: number | null = null) =>
  resolveStock(baseSnapshot(stock, reserved, threshold), { option_value_ids: [], color_id: null });

// --------------------------------------------------------------- the rule

test('the owner’s worked example: printer 5, filament needs 2 of 6, nozzle 20 → 3 bundles', () => {
  const out = bundleAvailability(
    [
      component({ id: 'bc_printer', product: 'prd_printer', qty: 1, resolution: base(5) }),
      component({ id: 'bc_filament', product: 'prd_filament', qty: 2, resolution: base(6) }),
      component({ id: 'bc_nozzle', product: 'prd_nozzle', qty: 1, resolution: base(20) }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(out.max_bundles, 3);
  assert.deepEqual(out.blocking, []);
  assert.equal(out.shipping_type, 'direct');
});

test('two components resolving to ONE stock row are SUMMED, not divided independently', () => {
  // The same product twice — "two spools of PLA, one black one white" is why
  // bundle_components has a surrogate key at all.
  const shared = base(3);
  const summed = bundleAvailability(
    [
      component({ id: 'bc_a', product: 'prd_pla', qty: 2, resolution: shared }),
      component({ id: 'bc_b', product: 'prd_pla', qty: 2, resolution: shared }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  // Judged independently each component reports floor(3/2) = 1. Summed, one
  // bundle needs 4 units of a row that has 3, so NO bundle can be assembled.
  assert.equal(summed.max_bundles, 0);
  assert.equal(summed.state, 'sold_out');
  assert.equal(summed.blocking[0].needed, 4, 'the blocker names the SUMMED demand');
  assert.equal(summed.blocking[0].available, 3);

  // With four units the same pair yields exactly one bundle — not two.
  const four = base(4);
  const ok = bundleAvailability(
    [
      component({ id: 'bc_a', product: 'prd_pla', qty: 2, resolution: four }),
      component({ id: 'bc_b', product: 'prd_pla', qty: 2, resolution: four }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(ok.max_bundles, 1);
});

test('an untracked required component bounds nothing; a tracked one still does', () => {
  const out = bundleAvailability(
    [
      component({ id: 'bc_untracked', product: 'prd_cable', qty: 1, resolution: base(null) }),
      component({ id: 'bc_tracked', product: 'prd_printer', qty: 1, resolution: base(4) }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(out.max_bundles, 4);

  const allUntracked = bundleAvailability(
    [component({ id: 'bc_untracked', product: 'prd_cable', qty: 1, resolution: base(null) })],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(allUntracked.max_bundles, null, 'null = nothing claims a limit');
  assert.equal(allUntracked.state, 'in_stock');
});

test('a VARIANT_NOT_MODELLED component contributes 0 with its code in blocking[]', () => {
  const unmodelled = resolveStock(
    {
      inventory_mode: 'VARIANT_COMBINATION',
      base: { stock: 50, reserved: 0, low_stock_threshold: null },
      option_values: [],
      colors: [],
      variants: [],
      group_ids: ['g1'],
    },
    { option_value_ids: ['ov_1'], color_id: null }
  );
  const out = bundleAvailability(
    [
      component({ id: 'bc_bad', product: 'prd_combo', qty: 1, resolution: unmodelled }),
      component({ id: 'bc_ok', product: 'prd_printer', qty: 1, resolution: base(9) }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(out.max_bundles, 0);
  assert.equal(out.blocking[0].reason, 'VARIANT_NOT_MODELLED');
  assert.ok(out.errors.includes('VARIANT_NOT_MODELLED'));
});

test('a DECLINED optional component lowers nothing; an opted-in one counts', () => {
  const declined = bundleAvailability(
    [
      component({ id: 'bc_main', product: 'prd_printer', qty: 1, resolution: base(9) }),
      component({ id: 'bc_extra', product: 'prd_out', qty: 1, resolution: base(0), optional: true, included: false }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(declined.max_bundles, 9);

  const optedIn = bundleAvailability(
    [
      component({ id: 'bc_main', product: 'prd_printer', qty: 1, resolution: base(9) }),
      component({ id: 'bc_extra', product: 'prd_out', qty: 1, resolution: base(0), optional: true, included: true }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(optedIn.max_bundles, 0, 'refused, never silently dropped');
});

test('reserved units are not available: a bundle cannot be built from someone else’s hold', () => {
  const out = bundleAvailability(
    [component({ id: 'bc_a', product: 'prd_printer', qty: 1, resolution: base(10, 8) })],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(out.max_bundles, 2);
});

// ------------------------------------------------------------- the states

test('all eight card states are producible by this one function', () => {
  const seen = new Set<string>();
  const stocked = (n: number) => [component({ id: 'bc_a', product: 'prd_a', qty: 1, resolution: base(n) })];
  const now = NO_WINDOW.nowMs;

  seen.add(bundleAvailability([], NO_WINDOW, true, OPEN).state); // unconfigured
  seen.add(bundleAvailability(stocked(5), { starts_at: null, ends_at: '2026-05-01T00:00:00Z', nowMs: now }, true, OPEN).state); // ended
  seen.add(bundleAvailability(stocked(5), { starts_at: '2026-07-01T00:00:00Z', ends_at: null, nowMs: now }, true, OPEN).state); // upcoming
  seen.add(bundleAvailability(stocked(5), NO_WINDOW, true, LOCKED).state); // locked
  seen.add(bundleAvailability(stocked(0), NO_WINDOW, true, OPEN).state); // sold_out
  seen.add(
    bundleAvailability(
      [component({ id: 'bc_p', product: 'prd_p', qty: 1, resolution: base(null), saleTypes: ['pre_order'], shipping: 'preorder_air' })],
      NO_WINDOW,
      true,
      OPEN
    ).state
  ); // preorder
  seen.add(
    bundleAvailability(stocked(50), { starts_at: null, ends_at: new Date(now + 3_600_000).toISOString(), nowMs: now }, true, OPEN).state
  ); // ending_soon
  seen.add(bundleAvailability(stocked(COMPOSITION_LOW_BUNDLES), NO_WINDOW, true, OPEN).state); // low
  seen.add(bundleAvailability(stocked(50), NO_WINDOW, true, OPEN).state); // in_stock
  seen.add(bundleAvailability(stocked(50), NO_WINDOW, true, ENTITLED).state); // member_exclusive

  assert.deepEqual(
    [...seen].sort(),
    ['ended', 'ending_soon', 'in_stock', 'locked', 'low', 'member_exclusive', 'preorder', 'sold_out', 'unconfigured', 'upcoming'].sort()
  );
});

test('`low` follows the documented rule, not a threshold invented in a panel', () => {
  // (a) few bundles left
  assert.equal(bundleAvailability([component({ id: 'bc', product: 'p', qty: 1, resolution: base(3) })], NO_WINDOW, true, OPEN).state, 'low');
  assert.equal(bundleAvailability([component({ id: 'bc', product: 'p', qty: 1, resolution: base(4) })], NO_WINDOW, true, OPEN).state, 'in_stock');
  // (b) a component that is itself low, even when many bundles are possible
  const lowComponent = base(50, 0, 60);
  assert.equal(
    bundleAvailability([component({ id: 'bc', product: 'p', qty: 1, resolution: lowComponent })], NO_WINDOW, true, OPEN).state,
    'low'
  );
});

test('an inactive subject is never `in_stock`, and says so in its errors', () => {
  const out = bundleAvailability(
    [component({ id: 'bc', product: 'p', qty: 1, resolution: base(50) })],
    NO_WINDOW,
    false,
    OPEN
  );
  assert.equal(out.state, 'ended');
  assert.ok(out.errors.includes('OFFER_INACTIVE'));
});

test('a locked card still reports its stock honestly to the server, but reads as locked', () => {
  const out = bundleAvailability([component({ id: 'bc', product: 'p', qty: 1, resolution: base(7) })], NO_WINDOW, true, LOCKED);
  assert.equal(out.state, 'locked');
  assert.equal(out.max_bundles, 7);
  assert.equal(out.member_exclusive, false);
});

test('mixed shipping types are reported as mixed, and refused by name', () => {
  const out = bundleAvailability(
    [
      component({ id: 'bc_direct', product: 'prd_a', qty: 1, resolution: base(5) }),
      component({ id: 'bc_air', product: 'prd_b', qty: 1, resolution: base(null), saleTypes: ['pre_order'], shipping: 'preorder_air' }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(out.shipping_type, 'mixed');
  assert.ok(out.errors.includes('BUNDLE_SHIPPING_MIXED'));
});

test('a bundle whose required components are ALL pre-order reports modes = [pre_order]', () => {
  const out = bundleAvailability(
    [
      component({ id: 'bc_a', product: 'prd_a', qty: 1, resolution: base(null), saleTypes: ['pre_order'], shipping: 'preorder_air' }),
      component({ id: 'bc_b', product: 'prd_b', qty: 1, resolution: base(null), saleTypes: ['pre_order'], shipping: 'preorder_air' }),
    ],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.deepEqual(out.modes, ['pre_order']);
  assert.equal(out.state, 'preorder');
  assert.equal(out.max_bundles, null, 'no stock gate on an untracked pre-order component');
});

test('a TRACKED pre-order component still bounds the bundle', () => {
  const out = bundleAvailability(
    [component({ id: 'bc_a', product: 'prd_a', qty: 2, resolution: base(5), saleTypes: ['pre_order'], shipping: 'preorder_air' })],
    NO_WINDOW,
    true,
    OPEN
  );
  assert.equal(out.max_bundles, 2);
});

// ------------------------------------------- §2.4: saleAvailability fails closed

const compositionDoc = (over: Record<string, unknown> = {}) =>
  ({
    composition: 'bundle',
    selling_type: 'bundle',
    sale_types: ['bundle'],
    stock: null, // ALWAYS — the single most important invariant in the design
    options: [],
    colors: [],
    preorder_transports: [],
    ...over,
  }) as never;

const ordinaryDoc = () =>
  ({
    composition: '',
    selling_type: 'direct_sale',
    sale_types: ['direct_sale'],
    stock: null,
    options: [],
    colors: [],
    preorder_transports: [],
  }) as never;

test('every saleAvailability call site returns max_qty 0 for a composition row with no compositionMax', () => {
  // The six shapes, transcribed from the call sites they belong to. A site that
  // forgets to thread the composition inputs gets 0, never an untracked 99.
  const sites: Array<[string, Record<string, unknown>]> = [
    ['worker/routes/cart.ts loadCart', { optionValueIds: [], colorId: null, qty: 1, transportDefaults: [] }],
    ['worker/routes/cart.ts add', { optionValueIds: [], colorId: null, qty: 2, transportDefaults: [] }],
    ['worker/routes/cart.ts patch', { optionValueIds: [], colorId: null, qty: 3, transportDefaults: [] }],
    ['worker/routes/orders.ts priceLines', { optionValueIds: [], colorId: null, qty: 1, transportDefaults: [], preferredType: null }],
    ['worker/routes/products.ts detail', { transportDefaults: [] }],
    ['worker/routes/products.ts quote', { optionId: null, colorId: null, qty: 1, transportDefaults: [] }],
  ];
  for (const [where, input] of sites) {
    const out = saleAvailability(compositionDoc(), input);
    assert.equal(out.mode, 'unavailable', where);
    assert.equal(out.reason, 'COMPOSITION_MAX_REQUIRED', where);
    assert.equal(out.stock.max_qty, 0, where);
    assert.equal(out.stock.scope, 'composition', where);
    if (input.qty !== undefined) assert.equal(out.qty_ok, false, where);
  }
});

test('the six call sites all hand saleAvailability the whole product document', () => {
  // The fail-closed branch reads `doc.composition`, so a call site that built a
  // partial object instead of passing the document would defeat it silently.
  for (const file of ['worker/routes/cart.ts', 'worker/routes/orders.ts', 'worker/routes/products.ts']) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/saleAvailability\(([^,\n]+),/g)) {
      if (m[1] === '\n  doc') continue;
      assert.equal(m[1].trim(), 'doc', `${file}: saleAvailability must be called with the product doc`);
    }
  }
});

test('a composition row WITH the inputs answers from its members and is clamped by max_qty_per_order', () => {
  const out = saleAvailability(compositionDoc(), {
    compositionMax: 7,
    compositionModes: ['direct_sale'],
    maxQtyPerOrder: 5,
    transportDefaults: [],
  });
  assert.equal(out.mode, 'direct_sale');
  assert.equal(out.stock.available, 7);
  assert.equal(out.stock.max_qty, 5, 'the offer’s own per-order cap');
  assert.equal(out.stock.scope, 'composition');
});

test('a PRE-ORDER composition row is clamped on the pre-order branch too, and offers no direct button', () => {
  const out = saleAvailability(compositionDoc({ sale_types: ['bundle', 'pre_order'] }), {
    compositionMax: 2,
    compositionModes: ['pre_order'],
    maxQtyPerOrder: 5,
    transportDefaults: [{ method: 'air', commission_iqd: 12_000 }],
  });
  assert.equal(out.mode, 'unavailable', 'no transport offer configured on the bundle row yet');
  // With a transport offer the mode is pre-order — and max_qty is 2, not 99.
  const withTransport = saleAvailability(
    compositionDoc({ sale_types: ['bundle', 'pre_order'], preorder_transports: [{ method: 'air', commission_iqd: 12_000, active: true }] }),
    {
      compositionMax: 2,
      compositionModes: ['pre_order'],
      maxQtyPerOrder: 5,
      transportDefaults: [],
    }
  );
  assert.equal(withTransport.mode, 'preorder');
  assert.equal(withTransport.stock.max_qty, 2, 'the pre-order branch no longer discards `available` for a bundle');
  assert.deepEqual(withTransport.modes.map((m) => m.type), ['pre_order'], 'the "bundle" token never turns direct sale on');
});

test('an ORDINARY product is byte-identical with and without the new inputs', () => {
  const before = saleAvailability(ordinaryDoc(), { transportDefaults: [], qty: 1 });
  const after = saleAvailability(ordinaryDoc(), {
    transportDefaults: [],
    qty: 1,
    compositionMax: undefined,
    compositionModes: undefined,
    maxQtyPerOrder: undefined,
  });
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.equal(before.stock.max_qty, 0, 'a direct-sale product without an explicit counter fails closed');
  assert.equal(before.stock.scope, 'product');
});
