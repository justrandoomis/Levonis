/**
 * Sale-mode / sellable-stock semantics (integrated mandate §7.2).
 * Run: npm run test:unit   (tsx --test tests/*.test.ts)
 *
 * These pin the rules the storefront defaults to:
 *   - stock > 0  → direct sale is the default,
 *   - stock = 0  → pre-order ONLY when an admin enabled it and it has a
 *     usable transport; otherwise honest "unavailable" + a machine reason,
 *   - 0 is never treated as unlimited, NULL (untracked) is a distinct state,
 *   - a required option/color must be chosen before any price/stock claim,
 *   - the reported stock scope is 'product' (the schema has no per-variant
 *     stock and no reservation ledger — nothing here may pretend otherwise).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saleAvailability, communityAvailability } from '../worker/routes/products';
import { LINE_QTY_MAX } from '../packages/pricing/src/quantity';
import type { OptionV2, ColorV2, TransportOffer } from '../worker/lib/pricing';

type Doc = Parameters<typeof saleAvailability>[0];

const option = (over: Partial<OptionV2> = {}): OptionV2 => ({
  id: 'opt1', name_ar: 'خيار', name_en: 'Option', name_ckb: '', image: '', order: 0, active: true,
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, ...over,
});

const color = (over: Partial<ColorV2> = {}): ColorV2 => ({
  id: 'col1', name_ar: 'أسود', name_en: 'Black', name_ckb: '', hex: '#000000', image: '',
  option_id: null, order: 0, active: true,
  regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null, ...over,
});

const transport = (over: Partial<TransportOffer> = {}): TransportOffer => ({
  method: 'air', commission_iqd: null, active: true, ...over,
});

const doc = (over: Partial<Doc> = {}): Doc => ({
  selling_type: 'direct_sale',
  stock: 5,
  options: [],
  colors: [],
  preorder_transports: [],
  ...over,
});

// ------------------------------------------------------------ direct sale

test('stock > 0 defaults to direct sale and caps qty at the sellable amount', () => {
  const a = saleAvailability(doc({ stock: 3 }));
  assert.equal(a.mode, 'direct_sale');
  assert.equal(a.reason, null);
  assert.equal(a.stock.tracked, true);
  assert.equal(a.stock.on_hand, 3);
  assert.equal(a.stock.available, 3);
  assert.equal(a.stock.max_qty, 3);
  assert.equal(a.stock.scope, 'product');
});

test('untracked direct stock (NULL) fails closed instead of becoming unlimited', () => {
  const untracked = saleAvailability(doc({ stock: null }));
  assert.equal(untracked.mode, 'unavailable');
  assert.equal(untracked.reason, 'OUT_OF_STOCK');
  assert.equal(untracked.stock.tracked, false);
  assert.equal(untracked.stock.on_hand, null);
  assert.equal(untracked.stock.available, null);
  assert.equal(untracked.stock.max_qty, 0);

  const zero = saleAvailability(doc({ stock: 0 }));
  assert.equal(zero.mode, 'unavailable');
  assert.equal(zero.reason, 'OUT_OF_STOCK');
  assert.equal(zero.stock.max_qty, 0);
});

test('available never goes negative and reserved is reported as 0 (no reservation ledger)', () => {
  const a = saleAvailability(doc({ stock: 0 }));
  assert.equal(a.stock.reserved, 0);
  assert.equal(a.stock.available, 0);
});

test('qty_ok rejects a quantity above the sellable amount (no silent split)', () => {
  assert.equal(saleAvailability(doc({ stock: 2 }), { qty: 2 }).qty_ok, true);
  assert.equal(saleAvailability(doc({ stock: 2 }), { qty: 3 }).qty_ok, false);
  assert.equal(saleAvailability(doc({ stock: 0 }), { qty: 1 }).qty_ok, false);
  assert.equal(saleAvailability(doc({ stock: 5 }), { qty: 0 }).qty_ok, false);
});

// -------------------------------------------------------------- pre-order

test('out of stock does NOT become a pre-order when the admin did not enable it', () => {
  const a = saleAvailability(doc({ stock: 0, preorder_transports: [transport({ commission_iqd: 5000 })] }));
  assert.equal(a.mode, 'unavailable');
  assert.equal(a.reason, 'OUT_OF_STOCK');
  assert.equal(a.preorder.enabled, false);
  assert.equal(a.preorder.usable, false);
  assert.equal(a.preorder.reason, 'PREORDER_NOT_ENABLED');
});

test('admin-enabled pre-order with a configured commission is the default and ignores stock', () => {
  const a = saleAvailability(
    doc({ selling_type: 'pre_order', stock: 0, preorder_transports: [transport({ commission_iqd: 7500 })] })
  );
  assert.equal(a.mode, 'preorder');
  assert.equal(a.reason, null);
  assert.equal(a.preorder.usable, true);
  assert.deepEqual(a.preorder.transports, [{ method: 'air', commission_iqd: 7500, configured: true }]);
  assert.equal(a.stock.max_qty, LINE_QTY_MAX);
});

test('pre-order inherits an unconfigured commission from the admin defaults', () => {
  const a = saleAvailability(
    doc({ selling_type: 'pre_order', stock: 0, preorder_transports: [transport({ method: 'sea', commission_iqd: null })] }),
    { transportDefaults: [{ method: 'sea', commission_iqd: 3000 }] }
  );
  assert.equal(a.mode, 'preorder');
  assert.deepEqual(a.preorder.transports, [{ method: 'sea', commission_iqd: 3000, configured: true }]);
});

test('pre-order with no configured increase remains available at zero increase', () => {
  const a = saleAvailability(
    doc({ selling_type: 'pre_order', stock: 0, preorder_transports: [transport({ commission_iqd: null })] })
  );
  assert.equal(a.mode, 'preorder');
  assert.equal(a.reason, null);
  assert.equal(a.preorder.enabled, true);
  assert.equal(a.preorder.usable, true);
  assert.equal(a.preorder.transports[0].commission_iqd, 0);
  assert.equal(a.stock.max_qty, LINE_QTY_MAX);
});

test('pre-order with no transport offer at all reports NO_TRANSPORT_OFFERED', () => {
  const a = saleAvailability(doc({ selling_type: 'pre_order', stock: 0, preorder_transports: [] }));
  assert.equal(a.mode, 'unavailable');
  assert.equal(a.reason, 'NO_TRANSPORT_OFFERED');
});

test('an inactive transport offer never makes a pre-order usable', () => {
  const a = saleAvailability(
    doc({
      selling_type: 'pre_order',
      stock: 0,
      preorder_transports: [transport({ commission_iqd: 4000, active: false })],
    })
  );
  assert.equal(a.mode, 'unavailable');
  assert.equal(a.reason, 'NO_TRANSPORT_OFFERED');
  assert.equal(a.preorder.transports.length, 0);
});

// -------------------------------------------------------------- selection

test('an active option must be chosen before the page may claim a price', () => {
  const p = doc({ options: [option({ id: 'o1' })] });
  const none = saleAvailability(p);
  assert.equal(none.selection.option_required, true);
  assert.equal(none.selection.complete, false);
  assert.ok(none.selection.errors.includes('OPTION_REQUIRED'));

  const chosen = saleAvailability(p, { optionId: 'o1' });
  assert.equal(chosen.selection.complete, true);
  assert.equal(chosen.selection.option_id, 'o1');
});

test('hidden options are not selectable and do not create a requirement', () => {
  const p = doc({ options: [option({ id: 'o1', active: false })] });
  const a = saleAvailability(p);
  assert.equal(a.selection.option_required, false);
  assert.equal(a.selection.complete, true);

  const picked = saleAvailability(p, { optionId: 'o1' });
  assert.ok(picked.selection.errors.includes('OPTION_INACTIVE'));
  assert.equal(picked.selection.complete, false);
});

test('an unknown option id is rejected rather than silently ignored', () => {
  const a = saleAvailability(doc({ options: [option({ id: 'o1' })] }), { optionId: 'nope' });
  assert.ok(a.selection.errors.includes('OPTION_NOT_FOUND'));
  assert.equal(a.selection.complete, false);
});

test('a color linked to another option is a mismatch, not a valid pick', () => {
  const p = doc({
    options: [option({ id: 'o1' }), option({ id: 'o2' })],
    colors: [color({ id: 'c1', option_id: 'o2' })],
  });
  const a = saleAvailability(p, { optionId: 'o1', colorId: 'c1' });
  assert.ok(a.selection.errors.includes('COLOR_OPTION_MISMATCH'));
  assert.equal(a.selection.complete, false);
});

test('colors linked to a different option stop being required once an option is chosen', () => {
  const p = doc({
    options: [option({ id: 'o1' }), option({ id: 'o2' })],
    colors: [color({ id: 'c2', option_id: 'o2' })],
  });
  const a = saleAvailability(p, { optionId: 'o1' });
  assert.equal(a.selection.color_required, false);
  assert.equal(a.selection.complete, true);
});

test('an unlinked color stays required for every option', () => {
  const p = doc({ options: [option({ id: 'o1' })], colors: [color({ id: 'c1', option_id: null })] });
  const a = saleAvailability(p, { optionId: 'o1' });
  assert.equal(a.selection.color_required, true);
  assert.ok(a.selection.errors.includes('COLOR_REQUIRED'));
  assert.equal(saleAvailability(p, { optionId: 'o1', colorId: 'c1' }).selection.complete, true);
});

test('selection state is independent of sale mode (out of stock still reports the requirement)', () => {
  const a = saleAvailability(doc({ stock: 0, options: [option({ id: 'o1' })] }));
  assert.equal(a.mode, 'unavailable');
  assert.equal(a.reason, 'OUT_OF_STOCK');
  assert.equal(a.selection.option_required, true);
});

// -------------------------------------------------------------- community

test('a community listing is never presented as buyable through the cart', () => {
  const a = communityAvailability();
  assert.equal(a.mode, 'unavailable');
  assert.equal(a.reason, 'COMMUNITY_LISTING_NOT_SELLABLE');
  assert.equal(a.stock.max_qty, 0);
  assert.equal(a.qty_ok, false);
});
