/**
 * Which lines the customer must be told about when the cart re-reads itself.
 *
 * The refresh itself is a browser behaviour and is pinned by the browser probe
 * (a real tab is hidden, the price is changed, the tab is shown again). What
 * is pure and testable here is the comparison that decides whether anything is
 * said at all — and the rule that a first look never claims a price "changed".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedPrices } from '../src/lib/useFreshOnReturn';

const line = (id: string, unit_price_iqd: number) => ({ id, unit_price_iqd });

test('a price that rose is reported with both numbers', () => {
  const moved = changedPrices([line('a', 100000)], [line('a', 150000)]);
  assert.deepEqual([...moved.entries()], [['a', { from: 100000, to: 150000 }]]);
});

test('a price that fell is reported too — the customer should know they gained', () => {
  const moved = changedPrices([line('a', 150000)], [line('a', 100000)]);
  assert.deepEqual(moved.get('a'), { from: 150000, to: 100000 });
});

test('an unchanged price says nothing', () => {
  assert.equal(changedPrices([line('a', 100000)], [line('a', 100000)]).size, 0);
});

test('a line the page has never seen is not a change', () => {
  // The first read of the cart, or a line just added, has nothing to compare
  // against. Calling that "the price changed" would be a lie on first sight.
  assert.equal(changedPrices([], [line('a', 100000)]).size, 0);
  assert.equal(changedPrices([line('a', 100000)], [line('a', 100000), line('b', 50000)]).size, 0);
});

test('a line that disappeared is not reported as a price change', () => {
  assert.equal(changedPrices([line('a', 100000), line('b', 50000)], [line('a', 100000)]).size, 0);
});

test('several lines moving are all reported', () => {
  const moved = changedPrices(
    [line('a', 100000), line('b', 50000), line('c', 70000)],
    [line('a', 150000), line('b', 50000), line('c', 60000)]
  );
  assert.deepEqual([...moved.keys()].sort(), ['a', 'c']);
});

test('a line with no price on either side is never called a change', () => {
  // "The price went up from 0 IQD" is a sentence no shop should ever show a
  // customer, so a missing price is treated as "nothing to compare", not zero.
  assert.equal(changedPrices([{ id: 'a', unit_price_iqd: null }], [{ id: 'a', unit_price_iqd: 120000 }]).size, 0);
  assert.equal(changedPrices([{ id: 'a', unit_price_iqd: 120000 }], [{ id: 'a', unit_price_iqd: null }]).size, 0);
  assert.equal(changedPrices([{ id: 'a' }], [{ id: 'a', unit_price_iqd: 5 }]).size, 0);
});
