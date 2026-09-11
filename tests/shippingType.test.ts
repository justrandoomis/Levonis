/**
 * §1 — four shipping types, and a cart that holds exactly one.
 *
 * The rule is not cosmetic. Direct, air, sea and land are four different
 * journeys: a direct order ships from LEVO's own shelf in days, an air
 * pre-order is bought abroad, cleared and forwarded over weeks, and sea and
 * land move on their own consolidated shipments again. A basket holding two of
 * them has no single delivery date and no single tracking path — half of it
 * would be in a warehouse in another country while the other half is on a
 * motorbike in Baghdad.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHIPPING_TYPES,
  SHIPPING_TYPE_LABELS,
  cartShippingType,
  distinctShippingTypes,
  isPreorder,
  transportForType,
  typeForTransport,
} from '../worker/lib/shippingType';
import {
  SHIPPING_TYPES as CLIENT_TYPES,
  SHIPPING_TYPE_LABELS as CLIENT_LABELS,
  shippingTypeLabel,
} from '../src/lib/shippingType';

test('there are exactly four types', () => {
  assert.equal(SHIPPING_TYPES.length, 4);
  assert.deepEqual(SHIPPING_TYPES, ['direct', 'preorder_air', 'preorder_sea', 'preorder_land']);
});

test('every type round-trips through the transport method it is stored as', () => {
  for (const t of SHIPPING_TYPES) {
    assert.equal(typeForTransport(transportForType(t)), t, t);
  }
});

test("direct is stored as the empty transport method it has always been", () => {
  // cart_items.transport_method has held '' for direct since migration 0002.
  // The vocabulary is new; the storage is not, so old rows keep their meaning.
  assert.equal(transportForType('direct'), '');
  assert.equal(typeForTransport(''), 'direct');
  assert.equal(typeForTransport(null), 'direct');
  assert.equal(typeForTransport(undefined), 'direct');
});

test('an unknown transport method reads as direct, never as a fabricated type', () => {
  assert.equal(typeForTransport('rocket'), 'direct');
  assert.equal(typeForTransport(42), 'direct');
});

test('isPreorder is true for the three pre-order types only', () => {
  assert.equal(isPreorder('direct'), false);
  assert.equal(isPreorder('preorder_air'), true);
  assert.equal(isPreorder('preorder_sea'), true);
  assert.equal(isPreorder('preorder_land'), true);
});

test('every type has all three names, and none is left as its id', () => {
  for (const t of SHIPPING_TYPES) {
    const l = SHIPPING_TYPE_LABELS[t];
    assert.ok(l.ar && l.en && l.ckb, `${t} is missing a name`);
    assert.notEqual(l.ar, t);
  }
});

// --------------------------------------------------------------- the cart

test('an empty cart has no type, so any type may still be started', () => {
  assert.equal(cartShippingType([]), null);
});

test("the cart's type is the FIRST line's — the first item decides", () => {
  assert.equal(cartShippingType([{ transport_method: '' }]), 'direct');
  assert.equal(cartShippingType([{ transport_method: 'air' }]), 'preorder_air');
  assert.equal(cartShippingType([{ transport_method: 'sea' }, { transport_method: 'sea' }]), 'preorder_sea');
});

test('the type is read from the LINES, never from a stored flag', () => {
  // A flag drifts: a line removed or edited leaves it claiming a type the
  // cart no longer holds. Reading the rows cannot disagree with the rows.
  assert.equal(cartShippingType([{ transport_method: 'land' }]), 'preorder_land');
  assert.equal(cartShippingType([]), null);
});

test('distinctShippingTypes names every type present', () => {
  assert.deepEqual(distinctShippingTypes([]), []);
  assert.deepEqual(distinctShippingTypes([{ transport_method: '' }, { transport_method: '' }]), ['direct']);
  assert.deepEqual(
    distinctShippingTypes([{ transport_method: '' }, { transport_method: 'air' }]),
    ['direct', 'preorder_air']
  );
});

test('every forbidden mix is detectable as more than one type', () => {
  // The four combinations the mandate names explicitly.
  const mixes: Array<[string, string]> = [
    ['', 'air'],   // direct + pre-order
    ['air', 'sea'],
    ['air', 'land'],
    ['sea', 'land'],
  ];
  for (const [a, b] of mixes) {
    const types = distinctShippingTypes([{ transport_method: a }, { transport_method: b }]);
    assert.equal(types.length, 2, `${a || 'direct'} + ${b} was not seen as a mix`);
  }
});

test('a cart of one type is never reported as mixed', () => {
  for (const m of ['', 'air', 'sea', 'land']) {
    const types = distinctShippingTypes([{ transport_method: m }, { transport_method: m }, { transport_method: m }]);
    assert.equal(types.length, 1, m || 'direct');
  }
});

test('the Worker and the SPA agree on the types and their labels', () => {
  // Two copies of the same data drift. The customer-facing labels are the
  // half that matters here: a cart refused as "preorder_air" and a dialog
  // that calls it something else is a support ticket, not a bug report.
  assert.deepEqual(CLIENT_TYPES, SHIPPING_TYPES);
  assert.deepEqual(CLIENT_LABELS, SHIPPING_TYPE_LABELS);
});

test('shippingTypeLabel answers in the asked-for language, and stays silent on junk', () => {
  assert.equal(shippingTypeLabel('preorder_sea', 'ar'), 'طلب مسبق — بحري');
  assert.equal(shippingTypeLabel('preorder_sea', 'en'), 'Pre-order — sea');
  assert.equal(shippingTypeLabel('direct', 'ckb'), 'گەیاندنی ڕاستەوخۆ');
  // An unknown language falls back to Arabic, the shop's default.
  assert.equal(shippingTypeLabel('direct', 'fr'), 'شحن مباشر');
  // A type the server did not send must render as nothing, not as "undefined".
  assert.equal(shippingTypeLabel(undefined, 'ar'), '');
  assert.equal(shippingTypeLabel('preorder_rocket', 'ar'), '');
});
