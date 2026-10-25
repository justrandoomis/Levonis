import test from 'node:test';
import assert from 'node:assert/strict';
import { browsingAvailability } from '../src/lib/productSelection';

const stocked = { mode: 'direct_sale', stock: 12, selection: { option_required: true, color_required: false } };
const emptyQuote = { ...stocked, mode: 'unavailable', stock: 0 };

test('the Blue Switch remains available when its untouched quote has no stock target', () => {
  assert.equal(browsingAvailability(stocked, null, false), stocked);
  assert.equal(browsingAvailability(stocked, emptyQuote, false), stocked);
});

test('explicit choices always retain the server verdict, including genuine stockouts', () => {
  assert.equal(browsingAvailability(stocked, emptyQuote, true), emptyQuote);
  assert.equal(browsingAvailability(stocked, stocked, true), stocked);
  const color = { ...stocked, selection: { option_required: false, color_required: true } };
  assert.equal(browsingAvailability(color, emptyQuote, false), color);
  assert.equal(browsingAvailability(color, emptyQuote, true), emptyQuote);
  // Clearing a previously sold-out choice restores the product-level fact.
  assert.equal(browsingAvailability(color, emptyQuote, false), color);
});

test('products without required choices never hide fresh stock changes behind opening data', () => {
  const base = { ...stocked, selection: { option_required: false, color_required: false } };
  const soldOut = { ...base, mode: 'unavailable', stock: 0 };
  assert.equal(browsingAvailability(base, soldOut, false), soldOut);
  assert.equal(browsingAvailability(soldOut, base, false), base);
  assert.equal(browsingAvailability(null, soldOut, false), soldOut);
  assert.equal(browsingAvailability(null, null, false), null);
});
