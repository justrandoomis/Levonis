/**
 * SEVERAL COLOURS OF ONE PRODUCT ARE ONE GROUP (docs/ux/COLOUR-QUANTITIES.md §5.2, §6).
 *
 * The cart and the checkout drew «50 black, 5 white, 1 beige» as three
 * unrelated products with the same photo; grouped, the product is said once
 * and each colour is a line under it. These hold the rule both screens share
 * (src/lib/cartGroups.ts) and that both screens use it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupCartLines, type GroupableLine } from '../src/lib/cartGroups';
import { ROOT } from './fixtures/d1';

const COLOURS = [{ id: 'black' }, { id: 'white' }, { id: 'beige' }];
const line = (id: string, productId: string, over: Partial<GroupableLine> = {}): GroupableLine => ({
  id,
  productId,
  colors: COLOURS,
  ...over,
});

const shape = (entries: ReturnType<typeof groupCartLines>) =>
  entries.map((e) => (e.kind === 'line' ? e.item.id : `[${e.items.map((i) => i.id).join(',')}]`));

test('a group sits where its first line sits, and lines follow the product\'s colour order', () => {
  // The server's order is newest first; beige was added last.
  const items = [
    line('beige', 'pla', { color_id: 'beige' }),
    line('nozzle', 'noz', { colors: [] }),
    line('black', 'pla', { color_id: 'black' }),
    line('white', 'pla', { color_id: 'white' }),
  ];
  assert.deepEqual(shape(groupCartLines(items)), ['[black,white,beige]', 'nozzle']);
});

test('a new add never reshuffles the other groups', () => {
  const before = [line('a1', 'a', { color_id: 'black' }), line('b1', 'b', { color_id: 'black' }), line('a2', 'a', { color_id: 'white' }), line('b2', 'b', { color_id: 'white' })];
  const after = [line('c1', 'c', { color_id: 'black' }), ...before];
  assert.deepEqual(shape(groupCartLines(before)), ['[a1,a2]', '[b1,b2]']);
  assert.deepEqual(shape(groupCartLines(after)), ['c1', '[a1,a2]', '[b1,b2]']);
});

test('gifts, bundles, mystery lines and store lines are never grouped; a single line is not a group', () => {
  const items = [
    line('gift', 'pla', { kind: 'gift', color_id: 'black' }),
    line('bundle', 'pla', { kind: 'bundle' }),
    line('mystery', 'pla', { kind: 'mystery' }),
    line('store', 'pla', { seller_type: 'merchant', color_id: 'white' }),
    line('only', 'pla', { color_id: 'beige' }),
  ];
  assert.deepEqual(shape(groupCartLines(items)), ['gift', 'bundle', 'mystery', 'store', 'only']);
});

test('lines of one colour with several options keep their options label order', () => {
  const items = [
    line('w2', 'pla', { color_id: 'white', options_label: 'Refill' }),
    line('w1', 'pla', { color_id: 'white', options_label: 'With spool' }),
    line('b1', 'pla', { color_id: 'black', options_label: 'With spool' }),
  ];
  assert.deepEqual(shape(groupCartLines(items)), ['[b1,w2,w1]']);
});

test('the cart and the checkout both group through it, and the checkout total is the server\'s line totals', () => {
  const cart = readFileSync(join(ROOT, 'src/pages/Cart.tsx'), 'utf8');
  const checkout = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');
  assert.match(cart, /groupCartLines\(items\)\.map\(\(entry\) => \(entry\.kind === 'line' \? renderLine\(entry\.item\) : renderColourGroup\(/);
  assert.match(cart, /role="checkbox"\s+aria-checked=\{state\}/, 'the group header is a tri-state checkbox');
  assert.match(cart, /aria-label=\{colourWords\.groupSelect\(name\)\}/);
  assert.match(checkout, /groupCartLines\(\s*summaryLines\.map/);
  // …and, in dollars, the lines' own dollar prices (DECISIONS row 248).
  assert.match(checkout, /money\(entry\.items\.reduce\(\(n, l\) => n \+ l\.lineTotal, 0\), groupUsd\(entry\.items\)\)/, 'the group total sums the server\'s line totals');
  // The colour is a tag at body size, not the last word of the grey label.
  assert.match(cart, /data-cart-colour-tag/);
  assert.match(checkout, /data-checkout-colour=\{line\.key\}/);
  assert.match(checkout, /× \{line\.qty\}/);
});

test('review: the group header counts colours (not lines), and every control of a coloured line names its colour', () => {
  const cart = readFileSync(join(ROOT, 'src/pages/Cart.tsx'), 'utf8');
  const checkout = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');
  // «الألوان: 2» over two Black lines was a false colour count.
  assert.doesNotMatch(cart, /groupSummary\(String\(lines\.length\)/);
  assert.doesNotMatch(checkout, /groupSummary\(String\(entry\.items\.length\)/);
  assert.match(cart, /groupSummaryText\(colourLang\(lang\), lines\.map\(\(l\) => \(\{ colourId: l\.color_tag\?\.id \?\? l\.color_id \?\? '', qty: l\.qty \}\)\)\)/);
  assert.match(checkout, /groupSummaryText\(colourLang\(lang\), entry\.items\.map\(\(l\) => \(\{ colourId: l\.colourTag\?\.id \?\? '', qty: l\.qty \}\)\)\)/);
  // Tabbing through «50 Black, 5 White, 1 Beige» says which colour each control changes.
  assert.match(cart, /aria-label=\{item\.color_tag \? colourWords\.lineSelect\(itemName\(item\), isolate\(item\.color_tag\.name\)\) : itemName\(item\)\}/);
  assert.match(cart, /label=\{item\.color_tag \? colourWords\.rowQty\(isolate\(item\.color_tag\.name\)\) : undefined\}/);
  assert.match(cart, /aria-label=\{item\.color_tag \? colourWords\.lineDelete\(isolate\(item\.color_tag\.name\)\) : undefined\}/);
});
