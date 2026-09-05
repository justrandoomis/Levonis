/**
 * QUICK EDIT PRICING, pinned.
 *
 * The owner's ask was speed: change any product's price or cost in seconds,
 * on a product that carries Options x Colors x Availability. Speed is only
 * worth anything if the number the admin sees is the number the customer is
 * charged, so most of what is pinned here is agreement:
 *
 *  1. ADJUSTMENT joins the INHERIT/FIXED mechanism that already existed, and
 *     the mode is READ from the row rather than stored beside it.
 *  2. The grid's `effective` is what worker/lib/pricing.ts resolves. One
 *     resolver, one answer — the admin preview, the product page, the cart and
 *     the checkout cannot diverge.
 *  3. A base price change now REACHES an adjusted option, which is the whole
 *     point: a pinned option is the failure worker/lib/pinnedPrices.ts exists
 *     to describe, and an adjustment is the fix.
 *  4. Amount shorthand is accepted where it is exact (950K, 1.25M) and REFUSED
 *     where it would be a guess.
 *  5. Bulk and copy compute a preview and the preview is what gets written.
 *  6. The profit guard warns and does not veto.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUnitPrice, priceMode, type PricingProduct, type OptionV2, type ColorV2 } from '../worker/lib/pricing';
import {
  buildGrid,
  parseAmount,
  profitOf,
  guardsFor,
  previewBulk,
  previewCopy,
  inScope,
  type GridProductInput,
} from '../worker/lib/priceGrid';

// --------------------------------------------------------------- fixtures

const option = (o: Partial<OptionV2> & { id: string }): OptionV2 => ({
  name_ar: o.id,
  name_en: o.id,
  name_ckb: o.id,
  image: '',
  order: 0,
  active: true,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  ...o,
});

const color = (c: Partial<ColorV2> & { id: string }): ColorV2 => ({
  name_ar: c.id,
  name_en: c.id,
  name_ckb: c.id,
  hex: '#000000',
  image: '',
  option_id: null,
  order: 0,
  active: true,
  regular_price_iqd: null,
  prime_price_iqd: null,
  pro_price_iqd: null,
  cost_iqd: null,
  ...c,
});

const product = (p: Partial<PricingProduct> = {}): PricingProduct => ({
  price_iqd: 500_000,
  prime_price_iqd: null,
  pro_price_iqd: null,
  product_cost_iqd: 400_000,
  selling_type: 'direct_sale',
  sale_types: ['direct_sale'],
  options: [],
  colors: [],
  preorder_transports: [],
  warranty_plans: [],
  ...p,
});

const gridInput = (p: PricingProduct): GridProductInput => ({
  price_iqd: p.price_iqd,
  prime_price_iqd: p.prime_price_iqd,
  pro_price_iqd: p.pro_price_iqd,
  product_cost_iqd: p.product_cost_iqd,
  selling_type: p.selling_type,
  sale_types: p.sale_types,
  options: p.options as GridProductInput['options'],
  colors: p.colors as GridProductInput['colors'],
});

// ------------------------------------------------------- 1. the three modes

test('the mode is derived from the row, never stored', () => {
  assert.equal(priceMode({}, 'regular_price_iqd'), 'inherit');
  assert.equal(priceMode({ regular_adjust_iqd: 60_000 }, 'regular_price_iqd'), 'adjust');
  assert.equal(priceMode({ regular_price_iqd: 560_000 }, 'regular_price_iqd'), 'fixed');
  // A fixed price beside a leftover adjustment is still fixed: a typed number
  // is an answer.
  assert.equal(priceMode({ regular_price_iqd: 560_000, regular_adjust_iqd: 60_000 }, 'regular_price_iqd'), 'fixed');
  // Zero is a value, not a blank.
  assert.equal(priceMode({ regular_price_iqd: 0 }, 'regular_price_iqd'), 'fixed');
  assert.equal(priceMode({ regular_adjust_iqd: 0 }, 'regular_price_iqd'), 'adjust');
});

test('an option with no adjustment resolves exactly as it did before 0044', () => {
  const p = product({ options: [option({ id: 'o1', regular_price_iqd: 620_000 })] });
  const r = resolveUnitPrice({ product: p, optionId: 'o1', tier: 'free', tierActive: false });
  assert.equal(r.applied_iqd, 620_000);
  assert.equal(r.price_source, 'option');
});

test('an adjustment moves the inherited price and follows the base afterwards', () => {
  const withAdjust = (base: number) =>
    resolveUnitPrice({
      product: product({ price_iqd: base, options: [option({ id: 'o1', regular_adjust_iqd: 60_000 })] }),
      optionId: 'o1',
      tier: 'free',
      tierActive: false,
    }).applied_iqd;

  assert.equal(withAdjust(500_000), 560_000);
  // The failure this feature exists to end: raising the base used to leave a
  // pinned option behind. An adjusted option comes with it.
  assert.equal(withAdjust(700_000), 760_000);
});

test('an adjustment never drives a price below zero', () => {
  const r = resolveUnitPrice({
    product: product({ price_iqd: 10_000, options: [option({ id: 'o1', regular_adjust_iqd: -50_000 })] }),
    optionId: 'o1',
    tier: 'free',
    tierActive: false,
  });
  assert.equal(r.applied_iqd, 0);
});

test('a colour adjustment stacks on top of its option', () => {
  const p = product({
    price_iqd: 500_000,
    options: [option({ id: 'o1', regular_adjust_iqd: 60_000 })],
    colors: [color({ id: 'c1', option_id: 'o1', regular_adjust_iqd: 15_000 })],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'o1', colorId: 'c1', tier: 'free', tierActive: false });
  assert.equal(r.applied_iqd, 575_000);
  assert.equal(r.price_source, 'color');
});

test('a fixed colour price still replaces everything below it', () => {
  const p = product({
    options: [option({ id: 'o1', regular_adjust_iqd: 60_000 })],
    colors: [color({ id: 'c1', option_id: 'o1', regular_price_iqd: 999_000 })],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'o1', colorId: 'c1', tier: 'free', tierActive: false });
  assert.equal(r.applied_iqd, 999_000);
});

test('a PRO adjustment with no PRO price to inherit anchors on the regular price', () => {
  const p = product({
    price_iqd: 500_000,
    pro_price_iqd: null,
    options: [option({ id: 'o1', pro_adjust_iqd: -50_000 })],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'o1', tier: 'pro', tierActive: true });
  assert.equal(r.pro_iqd, 450_000);
  assert.equal(r.applied_iqd, 450_000);
  assert.equal(r.applied_tier, 'pro');
});

test('a PRO adjustment prefers an inherited PRO price over the regular one', () => {
  const p = product({
    price_iqd: 500_000,
    pro_price_iqd: 460_000,
    options: [option({ id: 'o1', pro_adjust_iqd: -10_000 })],
  });
  const r = resolveUnitPrice({ product: p, optionId: 'o1', tier: 'pro', tierActive: true });
  assert.equal(r.pro_iqd, 450_000);
});

test('a cost adjustment with no cost beneath it stays unknown rather than inventing one', () => {
  const p = product({ product_cost_iqd: null, options: [option({ id: 'o1', cost_adjust_iqd: 20_000 })] });
  const r = resolveUnitPrice({ product: p, optionId: 'o1', tier: 'free', tierActive: false });
  assert.equal(r.cost_iqd, null);
});

// ------------------------------------------------- 2. the grid agrees with it

test('every effective cell in the grid equals what the resolver charges', () => {
  const p = product({
    price_iqd: 500_000,
    prime_price_iqd: 480_000,
    pro_price_iqd: 460_000,
    product_cost_iqd: 400_000,
    options: [
      option({ id: 'a1-pre', regular_adjust_iqd: 0, variant_key: 'a1', availability_type: 'pre_order' }),
      option({ id: 'a1-dir', regular_adjust_iqd: 50_000, variant_key: 'a1', availability_type: 'direct_sale' }),
      option({ id: 'combo-pre', regular_price_iqd: 700_000, variant_key: 'a1-combo', availability_type: 'pre_order' }),
    ],
    colors: [color({ id: 'blue', option_id: 'a1-dir', regular_adjust_iqd: 10_000 })],
    sale_types: ['direct_sale', 'pre_order'],
  });
  const rows = buildGrid(gridInput(p));

  for (const row of rows) {
    if (row.level === 'product') continue;
    const optionId = row.level === 'option' ? row.id : row.option_id;
    const colorId = row.level === 'color' ? row.id : null;
    const r = resolveUnitPrice({
      product: p,
      optionId,
      colorId,
      // A pre-order option demands a transport; the item price is what is
      // being compared, so applied_iqd is read regardless of the fee errors.
      tier: 'free',
      tierActive: false,
    });
    assert.equal(row.cells.regular.effective, r.applied_iqd, `regular for ${row.id}`);
    assert.equal(row.cells.cost.effective, r.cost_iqd, `cost for ${row.id}`);
    // The member cells too — including the surcharge the owner's rule carries
    // onto them (+50,000 direct option → PRIME 530,000, PRO 510,000). The
    // resolver clamps PRO ≤ PRIME ≤ regular; the grid does not, so compare
    // the unclamped explicit values with the same clamp applied here.
    const clampPro = r.pro_iqd;
    const clampPrime = r.prime_iqd;
    assert.equal(row.cells.pro.effective, clampPro, `pro for ${row.id}`);
    assert.equal(row.cells.prime.effective, clampPrime, `prime for ${row.id}`);
  }
});

test('OWNER: an inheriting member cell lands on the value beneath PLUS this row\'s surcharge', () => {
  const rows = buildGrid(
    gridInput(product({ price_iqd: 150_000, prime_price_iqd: 125_000, pro_price_iqd: 100_000, options: [option({ id: 'o1', regular_adjust_iqd: 25_000 })] }))
  );
  const row = rows.find((r) => r.id === 'o1')!;
  assert.equal(row.cells.regular.effective, 175_000);
  assert.equal(row.cells.prime.effective, 150_000);
  assert.equal(row.cells.pro.effective, 125_000);
  assert.equal(row.cells.pro.inherited, 125_000, 'the placeholder says what inheriting lands on');
  assert.equal(row.cells.pro.mode, 'inherit');
});

test('the grid names each option model and fulfilment route without parsing names', () => {
  const p = product({
    sale_types: ['direct_sale', 'pre_order'],
    options: [
      option({ id: 'x', variant_key: 'a1-combo', variant_label: 'A1 Combo', availability_type: 'pre_order' }),
    ],
  });
  const row = buildGrid(gridInput(p)).find((r) => r.id === 'x')!;
  assert.equal(row.variant_key, 'a1-combo');
  assert.equal(row.variant_label, 'A1 Combo');
  assert.equal(row.availability_type, 'pre_order');
});

test('an option with no availability of its own inherits the product route', () => {
  const rows = buildGrid(
    gridInput(product({ sale_types: ['pre_order'], options: [option({ id: 'x' })] }))
  );
  assert.equal(rows.find((r) => r.id === 'x')!.availability_type, 'pre_order');
});

test('the grid shows what an inheriting cell would land on', () => {
  const rows = buildGrid(
    gridInput(product({ price_iqd: 500_000, options: [option({ id: 'o1', regular_price_iqd: 620_000 })] }))
  );
  const cell = rows.find((r) => r.id === 'o1')!.cells.regular;
  assert.equal(cell.mode, 'fixed');
  assert.equal(cell.effective, 620_000);
  assert.equal(cell.inherited, 500_000, 'clicking inherit lands here');
});

test('an inactive option still appears in the admin grid', () => {
  const rows = buildGrid(gridInput(product({ options: [option({ id: 'off', active: false })] })));
  const row = rows.find((r) => r.id === 'off');
  assert.ok(row, 'a deactivated row is one click from being sold again');
  assert.equal(row!.active, false);
});

// ------------------------------------------------------ 3. amount shorthand

test('shorthand is accepted where it is exact', () => {
  assert.equal(parseAmount('950000').value, 950_000);
  assert.equal(parseAmount('950,000').value, 950_000);
  assert.equal(parseAmount('950K').value, 950_000);
  assert.equal(parseAmount('950k').value, 950_000);
  assert.equal(parseAmount('1.25M').value, 1_250_000);
  assert.equal(parseAmount('1m').value, 1_000_000);
  assert.equal(parseAmount('-15000').value, -15_000);
  assert.equal(parseAmount('+15000').value, 15_000);
  assert.equal(parseAmount(0).value, 0);
  assert.equal(parseAmount('').value, null, 'an empty cell is not an error');
  assert.equal(parseAmount('').error, null);
  assert.equal(parseAmount(null).value, null);
});

test('shorthand reads Arabic digits and Arabic multipliers', () => {
  assert.equal(parseAmount('٩٥٠٠٠٠').value, 950_000);
  assert.equal(parseAmount('٩٥٠ك').value, 950_000);
  assert.equal(parseAmount('1.25 مليون').value, 1_250_000);
});

test('shorthand refuses to guess rather than inventing a price', () => {
  assert.equal(parseAmount('950.5').error, 'AMOUNT_NOT_WHOLE_DINARS');
  assert.equal(parseAmount('1.0005K').error, 'AMOUNT_NOT_WHOLE_DINARS');
  assert.equal(parseAmount('950KK').error, 'AMOUNT_UNPARSEABLE');
  assert.equal(parseAmount('9K50').error, 'AMOUNT_UNPARSEABLE');
  assert.equal(parseAmount('abc').error, 'AMOUNT_UNPARSEABLE');
  assert.equal(parseAmount('950 dinars').error, 'AMOUNT_UNPARSEABLE');
  assert.equal(parseAmount(1.5).error, 'AMOUNT_NOT_WHOLE_DINARS');
  assert.equal(parseAmount('99999999999').error, 'AMOUNT_OUT_OF_RANGE');
});

// -------------------------------------------------------- 4. profit and guard

test('margin is profit over the selling price, not over the cost', () => {
  const p = profitOf(500_000, 400_000);
  assert.equal(p.profit_iqd, 100_000);
  assert.equal(p.margin_percent, 20, 'markup would say 25 — reporting that as margin lets a 20% floor pass at 16%');
});

test('an unknown cost yields an unknown profit, never a zero', () => {
  const p = profitOf(500_000, null);
  assert.equal(p.profit_iqd, null);
  assert.equal(p.margin_percent, null);
});

test('the guard warns below cost and below the configured floor', () => {
  assert.equal(guardsFor('x', 'regular', 300_000, 400_000, null)[0].code, 'BELOW_COST');
  assert.equal(guardsFor('x', 'regular', 410_000, 400_000, 20)[0].code, 'THIN_MARGIN');
  assert.deepEqual(guardsFor('x', 'regular', 500_000, 400_000, 20), [], 'a healthy margin is silent');
  assert.deepEqual(guardsFor('x', 'regular', 410_000, 400_000, null), [], 'no floor configured means no floor warning');
  assert.deepEqual(guardsFor('x', 'regular', 410_000, null, 20), [], 'an unknown cost cannot breach a floor');
});

// ------------------------------------------------------------- 5. bulk edits

const bambu = () =>
  product({
    price_iqd: 500_000,
    prime_price_iqd: 480_000,
    pro_price_iqd: 460_000,
    product_cost_iqd: 400_000,
    sale_types: ['direct_sale', 'pre_order'],
    options: [
      option({ id: 'a1-pre', variant_key: 'a1', variant_label: 'A1', availability_type: 'pre_order', regular_price_iqd: 500_000 }),
      option({ id: 'a1-dir', variant_key: 'a1', variant_label: 'A1', availability_type: 'direct_sale', regular_price_iqd: 550_000 }),
      option({ id: 'combo-pre', variant_key: 'a1-combo', variant_label: 'A1 Combo', availability_type: 'pre_order', regular_price_iqd: 700_000 }),
      option({ id: 'combo-dir', variant_key: 'a1-combo', variant_label: 'A1 Combo', availability_type: 'direct_sale', regular_price_iqd: 760_000 }),
    ],
  });

test('a bulk add moves only the rows in scope', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'add', fields: ['regular'], value: 25_000, scope: { availability: ['direct_sale'] } }, null);
  assert.deepEqual(
    p.changes.map((c) => [c.id, c.from_iqd, c.to_iqd]),
    [
      ['a1-dir', 550_000, 575_000],
      ['combo-dir', 760_000, 785_000],
    ]
  );
});

test('an availability scope never moves the base price along with the variants', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'add', fields: ['regular'], value: 25_000, scope: { availability: ['pre_order'] } }, null);
  assert.equal(p.changes.some((c) => c.level === 'product'), false);
});

test('a percentage move rounds to whole dinars', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'add_percent', fields: ['regular'], value: 7, scope: { variant_keys: ['a1'] } }, null);
  assert.deepEqual(
    p.changes.map((c) => [c.id, c.to_iqd]),
    [
      ['a1-pre', 535_000],
      ['a1-dir', 588_500],
    ]
  );
  for (const c of p.changes) assert.ok(Number.isInteger(c.to_iqd!));
});

test('an inherit bulk clears the pins so the next base change reaches them', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'inherit', fields: ['regular'], value: null, scope: { levels: ['option'] } }, null);
  assert.equal(p.changes.length, 4);
  for (const c of p.changes) {
    assert.equal(c.to_mode, 'inherit');
    assert.equal(c.write_value, null);
    assert.equal(c.write_adjust, null);
    assert.equal(c.to_iqd, 500_000, 'they all fall back to the base');
  }
});

test('the base regular price is refused by an inherit bulk rather than blanked', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'inherit', fields: ['regular'], value: null, scope: { levels: ['product'] } }, null);
  assert.equal(p.changes.length, 0);
  assert.equal(p.skipped[0].reason, 'BASE_PRICE_REQUIRED');
});

test('an adjust bulk writes the adjustment, not a frozen number', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'adjust', fields: ['regular'], value: 60_000, scope: { variant_keys: ['a1-combo'] } }, null);
  assert.equal(p.changes.length, 2);
  for (const c of p.changes) {
    assert.equal(c.to_mode, 'adjust');
    assert.equal(c.write_adjust, 60_000);
    assert.equal(c.write_value, null);
    assert.equal(c.to_iqd, 560_000);
  }
});

test('moving a value that does not exist is reported, not invented', () => {
  const p = previewBulk(
    buildGrid(gridInput(product({ product_cost_iqd: null, options: [option({ id: 'o1' })] }))),
    { op: 'add', fields: ['cost'], value: 10_000, scope: {} },
    null
  );
  assert.equal(p.changes.length, 0);
  assert.ok(p.skipped.every((s) => s.reason === 'NO_CURRENT_VALUE'));
});

test('an explicit row selection beats every other scope filter', () => {
  const rows = buildGrid(gridInput(bambu()));
  const chosen = rows.filter((r) => r.level === 'option');
  assert.equal(inScope(chosen[0], { row_ids: ['option:a1-pre'] }), true);
  assert.equal(inScope(chosen[1], { row_ids: ['option:a1-pre'] }), false);
  // The row list wins even when the other filters would have excluded it.
  assert.equal(inScope(chosen[1], { row_ids: ['option:a1-dir'], availability: ['pre_order'] }), true);
});

test('the guard speaks about the fields that changed, not the whole row', () => {
  // The row already sells PRIME below its cost. Changing its PRO price is not
  // the moment to warn about that: a warning that is always on screen is one
  // that is always clicked through.
  const p = product({
    price_iqd: 1_000_000,
    prime_price_iqd: 800_000,
    product_cost_iqd: 900_000,
    options: [option({ id: 'o1', pro_price_iqd: 950_000 })],
  });
  const rows = buildGrid(gridInput(p));
  const only = previewBulk(rows, { op: 'set', fields: ['pro'], value: 960_000, scope: { row_ids: ['option:o1'] } }, null);
  assert.deepEqual(only.guards, [], 'the PRO price is healthy, and PRIME was not touched');

  // A COST change is the exception: it can put every selling price under water
  // at once, so all three are re-checked.
  const costMove = previewBulk(rows, { op: 'set', fields: ['cost'], value: 990_000, scope: { row_ids: ['option:o1'] } }, null);
  assert.deepEqual(
    costMove.guards.map((g) => g.field).sort(),
    ['prime', 'pro'],
    'the regular price is still above the new cost; the two member prices are not'
  );
});

test('the guard fires on the result of the bulk, including a cost it just raised', () => {
  const rows = buildGrid(gridInput(product({ price_iqd: 500_000, product_cost_iqd: 400_000 })));
  const p = previewBulk(rows, { op: 'set', fields: ['cost'], value: 600_000, scope: { levels: ['product'] } }, null);
  assert.equal(p.guards.length, 1);
  assert.equal(p.guards[0].code, 'BELOW_COST');
  assert.equal(p.guards[0].cost_iqd, 600_000, 'against the NEW cost, not the old one');
});

test('a bulk that changes nothing produces no writes', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewBulk(rows, { op: 'set', fields: ['regular'], value: 500_000, scope: { row_ids: ['option:a1-pre'] } }, null);
  assert.equal(p.changes.length, 0);
  assert.equal(p.skipped[0].reason, 'NO_CHANGE');
});

// -------------------------------------------------------------- 6. quick copy

test('copying pre-order onto direct pairs the rows by model', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewCopy(rows, { from: { availability: 'pre_order' }, to: { availability: 'direct_sale' }, fields: ['regular'] }, null);
  assert.deepEqual(
    p.changes.map((c) => [c.id, c.from_iqd, c.to_iqd]),
    [
      ['a1-dir', 550_000, 500_000],
      ['combo-dir', 760_000, 700_000],
    ]
  );
});

test('copying one model onto another pairs the rows by fulfilment route', () => {
  const rows = buildGrid(gridInput(bambu()));
  const p = previewCopy(rows, { from: { variant_key: 'a1' }, to: { variant_key: 'a1-combo' }, fields: ['regular'] }, null);
  assert.deepEqual(
    p.changes.map((c) => [c.id, c.to_iqd]),
    [
      ['combo-pre', 500_000],
      ['combo-dir', 550_000],
    ]
  );
});

test('copying the PRO price alone leaves every other field where it was', () => {
  const p = bambu();
  p.options[0].pro_price_iqd = 430_000;
  const rows = buildGrid(gridInput(p));
  const preview = previewCopy(rows, { from: { availability: 'pre_order' }, to: { availability: 'direct_sale' }, fields: ['pro'] }, null);
  assert.ok(preview.changes.every((c) => c.field === 'pro'));
  assert.equal(preview.changes.find((c) => c.id === 'a1-dir')!.to_iqd, 430_000);
});

test('a copy carries the mode, so an adjustment stays an adjustment', () => {
  const p = bambu();
  p.options[0].regular_price_iqd = null;
  p.options[0].regular_adjust_iqd = 30_000;
  const rows = buildGrid(gridInput(p));
  const preview = previewCopy(rows, { from: { availability: 'pre_order' }, to: { availability: 'direct_sale' }, fields: ['regular'] }, null);
  const onto = preview.changes.find((c) => c.id === 'a1-dir')!;
  assert.equal(onto.to_mode, 'adjust');
  assert.equal(onto.write_adjust, 30_000);
  assert.equal(onto.write_value, null);
  assert.equal(onto.to_iqd, 530_000);
});

test('a source with no counterpart is reported rather than guessed at', () => {
  const p = product({
    sale_types: ['direct_sale', 'pre_order'],
    options: [
      option({ id: 'only-pre', variant_key: 'solo', availability_type: 'pre_order', regular_price_iqd: 100_000 }),
    ],
  });
  const preview = previewCopy(
    buildGrid(gridInput(p)),
    { from: { availability: 'pre_order' }, to: { availability: 'direct_sale' }, fields: ['regular'] },
    null
  );
  assert.equal(preview.changes.length, 0);
  assert.deepEqual(preview.unmatched.map((u) => u.id), ['only-pre']);
});
