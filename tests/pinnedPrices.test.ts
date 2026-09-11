/**
 * The rows that do not follow the base price, and what happens when the owner
 * asks them to. The failure this pins is the one the owner reported: the base
 * price moves, an option keeps its own number, and the cart charges the old
 * amount while the storefront shows the new one.
 *
 * The end-to-end half — that the cart actually follows once the rows move —
 * lives in scripts/e2e-price-change.mjs against a running worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pinnedRows,
  payableRange,
  repriceOne,
  repriceRow,
  repricePreview,
  type PinnedPriceRow,
} from '../worker/lib/pinnedPrices';

test('a row with no price of its own is not pinned — it already follows the base', () => {
  const rows = pinnedRows({
    options: [
      { id: 'a', name_en: 'Small', regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null },
      { id: 'b', name_en: 'Large', regular_price_iqd: 260000 },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'b');
  assert.equal(rows[0].label, 'Large');
});

test('a member price alone pins the row, because it too replaces the base', () => {
  const rows = pinnedRows({ options: [{ id: 'a', name_en: 'One', regular_price_iqd: null, pro_price_iqd: 90000 }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].regular_price_iqd, null);
  assert.equal(rows[0].pro_price_iqd, 90000);
});

test('an INACTIVE row still counts — it is one click from being sold again', () => {
  const rows = pinnedRows({ options: [{ id: 'a', name_en: 'Retired', active: false, regular_price_iqd: 120000 }] });
  assert.equal(rows.length, 1);
});

test('options, colours and variants are all counted, and each says which it is', () => {
  const rows = pinnedRows({
    options: [{ id: 'o', name_en: 'O', regular_price_iqd: 1 }],
    colors: [{ id: 'c', name_en: 'C', regular_price_iqd: 2 }],
    variants: [{ id: 'v', name_en: 'V', regular_price_iqd: 3 }],
  });
  assert.deepEqual(rows.map((r) => r.kind), ['option', 'color', 'variant']);
});

test('a zero price is a price — it pins the row rather than reading as empty', () => {
  assert.equal(pinnedRows({ options: [{ id: 'a', name_en: 'Free', regular_price_iqd: 0 }] }).length, 1);
});

// ------------------------------------------------------------- the arithmetic

test('the same difference: every pinned price moves by what the base moved', () => {
  assert.equal(repriceOne(200000, 'delta', 200000, 350000), 350000);
  assert.equal(repriceOne(260000, 'delta', 200000, 350000), 410000);
  // A cut moves them down by the same amount, and never below zero.
  assert.equal(repriceOne(260000, 'delta', 200000, 100000), 160000);
  assert.equal(repriceOne(50000, 'delta', 200000, 100000), 0);
});

test('the same percentage: every pinned price keeps its ratio to the base', () => {
  assert.equal(repriceOne(200000, 'percent', 200000, 300000), 300000);
  assert.equal(repriceOne(260000, 'percent', 200000, 300000), 390000);
  // Rounding lands on a whole dinar, never a fraction.
  assert.equal(repriceOne(33333, 'percent', 100000, 150000), 50000);
});

test('a percentage move against a base of zero leaves the price exactly as it was', () => {
  // There is no ratio to preserve, and inventing one would rewrite a number
  // the owner typed with an answer nobody asked for.
  assert.equal(repriceOne(75000, 'percent', 0, 300000), 75000);
});

test('inherit clears the price, which is what makes the NEXT change work', () => {
  assert.equal(repriceOne(260000, 'inherit', 200000, 350000), null);
  const row: PinnedPriceRow = {
    kind: 'option', id: 'a', label: 'Large',
    regular_price_iqd: 260000, prime_price_iqd: 250000, pro_price_iqd: 240000,
  };
  const next = repriceRow(row, 'inherit', 200000, 350000);
  assert.deepEqual(
    [next.regular_price_iqd, next.prime_price_iqd, next.pro_price_iqd],
    [null, null, null]
  );
});

test('the ladder survives the move: PRO stays under PRIME, PRIME under regular', () => {
  const row: PinnedPriceRow = {
    kind: 'option', id: 'a', label: 'Large',
    regular_price_iqd: 300000, prime_price_iqd: 290000, pro_price_iqd: 280000,
  };
  for (const mode of ['delta', 'percent'] as const) {
    const n = repriceRow(row, mode, 200000, 333333);
    assert.ok(n.pro_price_iqd! <= n.prime_price_iqd!, `${mode}: pro above prime`);
    assert.ok(n.prime_price_iqd! <= n.regular_price_iqd!, `${mode}: prime above regular`);
  }
});

test('a member price is clamped to the regular price even when only it is pinned', () => {
  const row: PinnedPriceRow = {
    kind: 'option', id: 'a', label: 'A',
    regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: 900000,
  };
  const n = repriceRow(row, 'delta', 100000, 120000);
  // With no regular price of its own the row falls back to the NEW base, and
  // a PRO price above it would be a discount that costs more.
  assert.equal(n.pro_price_iqd, 120000);
});

test('the preview names every row and where it lands, for the dialog to show', () => {
  const rows = pinnedRows({ options: [{ id: 'a', name_en: 'Small', regular_price_iqd: 200000 }] });
  const p = repricePreview(rows, 'delta', 200000, 350000);
  assert.equal(p.mode, 'delta');
  assert.deepEqual(p.rows, [{ id: 'a', kind: 'option', label: 'Small', from: 200000, to: 350000 }]);
});

// ------------------------------------------------------ what a customer pays

test('the payable range is what a customer can actually be charged, not the base alone', () => {
  const r = payableRange({
    base_price_iqd: 200000,
    options: [
      { id: 'a', name_en: 'Small', regular_price_iqd: 240000 },
      { id: 'b', name_en: 'Large', regular_price_iqd: 300000 },
    ],
  });
  // The base is reachable today: the cart accepts a line with no option.
  assert.deepEqual(r, { min: 200000, max: 300000, levels: 3 });
});

test('an option with no price of its own is priced at the base, not skipped', () => {
  const r = payableRange({ base_price_iqd: 200000, options: [{ id: 'a', name_en: 'One', regular_price_iqd: null }] });
  assert.deepEqual(r, { min: 200000, max: 200000, levels: 2 });
});

test('an inactive option is not part of the range — nobody can select it', () => {
  const r = payableRange({
    base_price_iqd: 200000,
    options: [{ id: 'a', name_en: 'Gone', active: false, regular_price_iqd: 900000 }],
  });
  assert.equal(r!.max, 200000);
});

test('a product with no price at all reports no range rather than zero', () => {
  assert.equal(payableRange({ base_price_iqd: null }), null);
});
