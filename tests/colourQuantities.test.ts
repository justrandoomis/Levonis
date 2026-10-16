/**
 * THE WORDS AND THE RULES OF COLOUR QUANTITIES (docs/ux/COLOUR-QUANTITIES.md).
 *
 * Pure: the button that names what it adds, the Arabic counted forms, the
 * reset that keeps a quantity on its own colour, each row's ceiling, and the
 * way rows enter and leave «عدة ألوان».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addLabel,
  addedLabel,
  coloursNom,
  isolate,
  leaveMulti,
  lineQtyIn,
  noticeText,
  piecesAcc,
  prefillRows,
  qtyAfterColourChange,
  rowCeilings,
  shortColourName,
} from '../src/lib/colourQuantities';
import { LINE_QTY_MAX } from '../packages/pricing/src/quantity';

const FSI = '⁨';
const PDI = '⁩';

// ------------------------------------------------------------------ addLabel

test('one colour: the count and the isolated name, in all three languages', () => {
  assert.equal(addLabel('ar', [{ name: 'Black', qty: 50 }]), `أضف 50 × ${FSI}Black${PDI}`);
  assert.equal(addLabel('en', [{ name: 'Black', qty: 50 }]), `Add 50 × ${FSI}Black${PDI}`);
  assert.equal(addLabel('ckb', [{ name: 'Black', qty: 50 }]), `زیادکردنی 50 × ${FSI}Black${PDI}`);
  assert.equal(addLabel('ar', [{ name: 'Black', qty: 1 }]), `أضف 1 × ${FSI}Black${PDI}`, 'at 1 too: never the bare «أضف إلى السلة»');
});

test('three colours: the pieces and the colours, never the colours one by one', () => {
  const lines = [
    { name: 'Black', qty: 50 },
    { name: 'Cold White', qty: 5 },
    { name: 'Beige', qty: 1 },
  ];
  assert.equal(addLabel('ar', lines), 'أضف 56 قطعة (3 ألوان)');
  assert.equal(addLabel('en', lines), 'Add 56 pieces (3 colours)');
  assert.equal(addLabel('ckb', lines), 'زیادکردنی 56 پارچە (3 ڕەنگ)');
  assert.equal(addLabel('ar', [...lines.slice(0, 1), { name: 'White', qty: 0 }]), `أضف 50 × ${FSI}Black${PDI}`, 'a row at 0 is not a line');
  assert.equal(addLabel('ar', []), 'حدّد كمية لون واحد على الأقل');
});

test('the Arabic counted forms (§8.2)', () => {
  assert.equal(piecesAcc(1), 'قطعة واحدة');
  assert.equal(piecesAcc(2), 'قطعتين');
  assert.equal(piecesAcc(7), '7 قطع');
  assert.equal(piecesAcc(10), '10 قطع');
  assert.equal(piecesAcc(11), '11 قطعة');
  assert.equal(piecesAcc(56), '56 قطعة');
  assert.equal(piecesAcc(100), '100 قطعة');
  assert.equal(piecesAcc(120), '120 قطعة');
  assert.equal(coloursNom(2), 'لونان');
  assert.equal(coloursNom(3), '3 ألوان');
  assert.equal(coloursNom(10), '10 ألوان');
  assert.equal(coloursNom(11), '11 لونًا');
  assert.equal(coloursNom(12), '12 لونًا');
  assert.equal(coloursNom(100), '100 لون');
  assert.equal(addLabel('ar', [{ name: 'A', qty: 1 }, { name: 'B', qty: 1 }]), 'أضف قطعتين (لونان)');
  assert.equal(addLabel('ar', Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, qty: 10 }))), 'أضف 120 قطعة (12 لونًا)');
});

test('a label with a colour is never «أضف إلى السلة»', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const qty of [1, 2, 50, 9999]) {
      const label = addLabel(lang, [{ name: 'Black', qty }]);
      assert.ok(!['أضف إلى السلة', 'Add to cart', 'زیادکردن بۆ سەبەتە'].includes(label));
      assert.ok(label.includes(isolate('Black')));
    }
  }
});

test('the short label shortens the name only, inside the isolate; the full label keeps it', () => {
  const lines = [{ name: 'Jade White (10100)', qty: 50 }];
  assert.equal(addLabel('ar', lines, { short: true }), `أضف 50 × ${FSI}Jade White (10100)${PDI}`, '18 characters fit whole');
  const long = [{ name: 'Charcoal Grey (11102)', qty: 3 }];
  assert.equal(addLabel('en', long, { short: true }), `Add 3 × ${FSI}Charcoal Grey${PDI}`, 'the code goes first');
  assert.equal(addLabel('en', long), `Add 3 × ${FSI}Charcoal Grey (11102)${PDI}`);
});

test('shortColourName drops «(code)» first, then ellipsizes, and is never empty', () => {
  assert.equal(shortColourName('Black'), 'Black');
  assert.equal(shortColourName('Charcoal Grey (11102)'), 'Charcoal Grey');
  assert.equal(shortColourName('An Extraordinarily Long Colour Name'), 'An Extraordinaril…');
  assert.equal(shortColourName('(1234567890123456789012)'), '(1234567890123456…', 'a name that is all code keeps itself, ellipsized');
  assert.ok(shortColourName('X'.repeat(40)).length > 0);
});

test('the added label and the notice are built from what was added, and a capped merge says so', () => {
  assert.equal(addedLabel('ar', { name: 'Black', qty: 50 }), `أُضيف 50 × ${FSI}Black${PDI}`);
  assert.equal(noticeText('ar', { name: 'Black', qty: 50 }), `أُضيف إلى السلة: 50 × ${FSI}Black${PDI}`);
  assert.equal(noticeText('en', { name: 'Black', qty: 50 }, { after: 150 }), `Your cart now holds 150 × ${FSI}Black${PDI} — the most available`);
  assert.equal(noticeText('ckb', { name: 'Black', qty: 50 }), `زیادکرا بۆ سەبەتەکەت: 50 × ${FSI}Black${PDI}`);
});

test('counts are grouped Latin digits, the stepper\'s own', () => {
  assert.equal(addLabel('ar', [{ name: 'Black', qty: 1200 }]), `أضف 1,200 × ${FSI}Black${PDI}`);
});

// ------------------------------------------------------- qtyAfterColourChange

test('D4: black → white at 50 returns to 1 and remembers «black: 50»', () => {
  assert.deepEqual(qtyAfterColourChange({ from: 'c_black', to: 'c_white', qty: 50 }), {
    qty: 1,
    hint: { kind: 'reset', previous: { colour: 'c_black', qty: 50 }, to: 'c_white' },
  });
});

test('D4: no colour → black keeps 50 (it was typed for black); black → none keeps 50; at 1 nothing is said', () => {
  assert.deepEqual(qtyAfterColourChange({ from: '', to: 'c_black', qty: 50 }), { qty: 50, hint: null });
  assert.deepEqual(qtyAfterColourChange({ from: 'c_black', to: '', qty: 50 }), { qty: 50, hint: null });
  assert.deepEqual(qtyAfterColourChange({ from: 'c_black', to: 'c_white', qty: 1 }), { qty: 1, hint: null });
  assert.deepEqual(qtyAfterColourChange({ from: 'c_black', to: 'c_black', qty: 9 }), { qty: 9, hint: null });
});

// ----------------------------------------------------------------- ceilings

test('rowCeilings: a counter per colour is independent; untracked is the per-line ceiling', () => {
  const c = rowCeilings([
    { id: 'black', qty: 50, max: 206 },
    { id: 'white', qty: 5, max: 4 },
    { id: 'beige', qty: 0, max: null },
  ]);
  assert.equal(c.get('black'), 206);
  assert.equal(c.get('white'), 4);
  assert.equal(c.get('beige'), LINE_QTY_MAX);
});

test('rowCeilings: a SHARED shelf gives each row what the others leave', () => {
  const rows = [
    { id: 'black', qty: 50, max: null },
    { id: 'white', qty: 5, max: null },
    { id: 'beige', qty: 0, max: null },
  ];
  const c = rowCeilings(rows, { pool: 52 });
  assert.equal(c.get('black'), 47, '52 − 5');
  assert.equal(c.get('white'), 2, '52 − 50');
  assert.equal(c.get('beige'), 0, '52 − 55, never below 0');
});

test('rowCeilings: never above the per-line ceiling, and a tracked pre-order quota is shared like a shelf', () => {
  const c = rowCeilings([{ id: 'a', qty: 0, max: 50_000 }]);
  assert.equal(c.get('a'), LINE_QTY_MAX);
  const shared = rowCeilings([{ id: 'a', qty: 3, max: null }, { id: 'b', qty: 0, max: null }], { pool: 100_000 });
  assert.equal(shared.get('b'), LINE_QTY_MAX);
  const quota = rowCeilings([{ id: 'a', qty: 3, max: null }, { id: 'b', qty: 0, max: null }], { pool: 10 });
  assert.equal(quota.get('b'), 7);
});

// ------------------------------------------------------ entering and leaving

test('prefillRows: the single colour brings the number typed for it, onto a row still at 0', () => {
  assert.deepEqual(prefillRows({}, { colour: 'black', qty: 50 }), { black: 50 });
  assert.deepEqual(prefillRows({ black: 7, white: 2 }, { colour: 'black', qty: 50 }), { black: 7, white: 2 }, 'a remembered row is not overwritten');
  assert.deepEqual(prefillRows({ white: 2, beige: 0 }, { colour: 'black', qty: 3 }), { white: 2, black: 3 });
  assert.deepEqual(prefillRows({ black: 50 }, null), { black: 50 }, 'a hint\'s seed, with nothing carried');
});

test('leaveMulti: one row with a quantity becomes the single selection; none or several wait in memory', () => {
  assert.deepEqual(leaveMulti({ black: 50 }, 'white'), { colour: 'black', qty: 50, remembered: {} });
  assert.deepEqual(leaveMulti({}, 'white'), { colour: 'white', qty: 1, remembered: {} });
  assert.deepEqual(leaveMulti({ black: 50, white: 5, beige: 0 }, 'beige'), { colour: 'beige', qty: 1, remembered: { black: 50, white: 5 } });
});

test('lineQtyIn: the identity the server upserts on — the selection sorted, the colour, never a gift line', () => {
  const lines = [
    { productId: 'p', option_id: 'a', option_value_ids: ['b', 'a'], color_id: 'black', qty: 10 },
    { productId: 'p', option_id: 'a', option_value_ids: ['a', 'b'], color_id: 'white', qty: 3 },
    { productId: 'p', option_id: 'a', option_value_ids: ['a', 'b'], color_id: 'black', qty: 1, kind: 'gift' },
    { productId: 'q', option_id: 'a', option_value_ids: ['a', 'b'], color_id: 'black', qty: 99 },
  ];
  assert.equal(lineQtyIn(lines, 'p', ['a', 'b'], 'a', 'black'), 10);
  assert.equal(lineQtyIn(lines, 'p', ['a', 'b'], 'a', 'white'), 3);
  assert.equal(lineQtyIn(lines, 'p', ['a', 'b'], 'a', 'beige'), 0);
});
