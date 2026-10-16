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

// ============================================================ review fixes
// docs/ux/COLOUR-QUANTITIES.md, after the review of feat/colour-qty: each of
// these was a way the page could still say one thing and do another.

import {
  buyLabelKind,
  closeMultiForOption,
  COLOUR_STRINGS,
  expectedAfterMerge,
  groupSummaryText,
  heldOnSharedCounter,
  lostAnswerVerdict,
  multiAddButton,
  quickBuyLabel,
  rememberAfterTap,
  pressKey,
  tapWindow,
} from '../src/lib/colourQuantities';

test('lost answer: a CAPPED merge counts as landed — the server ends at min(before + want, max(want, max_qty)), never before + max_qty', () => {
  // The cart held Black 10 on a shelf of 55; the lost press asked Black 50 and White 5.
  assert.equal(expectedAfterMerge(10, 50, 55), 55);
  assert.equal(expectedAfterMerge(0, 5, 55), 5);
  assert.equal(expectedAfterMerge(60, 5, 55), 55, 'a line already above the shelf is held there');
  assert.equal(expectedAfterMerge(0, 70, 55), 70, 'never below the add itself (the single door judged the add)');
  assert.equal(expectedAfterMerge(9990, 50, null), LINE_QTY_MAX, 'untracked: the per-line ceiling');
  const v = lostAnswerVerdict([
    { id: 'black', before: 10, want: 50, after: 55, maxQty: 55 },
    { id: 'white', before: 0, want: 5, after: 5, maxQty: 185 },
  ]);
  assert.deepEqual(v, { landed: ['black', 'white'], missing: [] }, 'the whole batch landed: the page opens the sheet, not «nothing was added»');
});

test('lost answer: an «empty the cart and add» press starts every line from 0; a line that does not match is named, never claimed', () => {
  assert.deepEqual(
    lostAnswerVerdict([{ id: 'black', before: 3, want: 5, after: 5, maxQty: 100, replaced: true }]),
    { landed: ['black'], missing: [] }
  );
  assert.deepEqual(
    lostAnswerVerdict([
      { id: 'black', before: 0, want: 50, after: 50, maxQty: 100 },
      { id: 'white', before: 0, want: 5, after: 2, maxQty: 100 },
    ]),
    { landed: ['black'], missing: ['white'] }
  );
  assert.deepEqual(lostAnswerVerdict([{ id: 'black', before: 0, want: 50, after: 0, maxQty: 100 }]), { landed: [], missing: ['black'] });
});

test('an option that leaves fewer than two colours closes «عدة ألوان» the way the switch does: removed rows are named, one row left becomes the single selection', () => {
  // Black 2, White 5, Beige 3; «Refill» offers only Black.
  assert.deepEqual(closeMultiForOption({ black: 2, white: 5, beige: 3 }, new Set(['black']), 'black', 'black'), {
    colour: 'black',
    qty: 2,
    dropped: ['white', 'beige'],
    remembered: {},
  });
  // No row left on the offered colour: the colour the page holds (an offered one), at 1 — never the old single quantity.
  assert.deepEqual(closeMultiForOption({ white: 5, beige: 3 }, new Set(['black']), 'white', 'black'), {
    colour: 'black',
    qty: 1,
    dropped: ['white', 'beige'],
    remembered: {},
  });
  // The colour held before «عدة ألوان» is still offered: it comes back at 1.
  assert.deepEqual(closeMultiForOption({}, new Set(['black']), 'black', 'black'), { colour: 'black', qty: 1, dropped: [], remembered: {} });
});

test('a shared shelf counts what the cart already holds on it (the whole product for a product/base shelf, the same options for an option shelf)', () => {
  const lines = [
    { productId: 'p', option_id: '', option_value_ids: ['o1'], color_id: 'black', qty: 30 },
    { productId: 'p', option_id: '', option_value_ids: ['o2'], color_id: 'white', qty: 4 },
    { productId: 'p', option_id: '', option_value_ids: ['o1'], color_id: 'beige', qty: 2, kind: 'gift' },
    { productId: 'q', option_id: '', option_value_ids: ['o1'], color_id: 'black', qty: 9 },
  ];
  assert.equal(heldOnSharedCounter(lines, 'p', 'base', ['o1']), 34);
  assert.equal(heldOnSharedCounter(lines, 'p', 'product', ['o1']), 34);
  assert.equal(heldOnSharedCounter(lines, 'p', 'option', ['o1']), 30);
  assert.equal(heldOnSharedCounter(lines, 'p', 'color', ['o1']), 0, 'a counter per colour shares nothing');
});

test('the buy button: «اختر لونًا أولًا» only when the CURRENT selection has a colour to choose — and before «غير متوفر»', () => {
  const base = { signedIn: true, adding: false, justAdded: false, lastAdded: null, unavailable: false, colourToChoose: true, chosen: null };
  // Model B is intentionally colourless: the product has colours, this selection has none.
  assert.equal(buyLabelKind({ ...base, colourToChoose: false }), 'addToCart');
  // The selected chip tapped off on a colour-stock filament: the quote is «unavailable» only because no colour is chosen.
  assert.equal(buyLabelKind({ ...base, unavailable: true }), 'chooseColour');
  assert.equal(buyLabelKind({ ...base, chosen: { name: 'Black', qty: 5 } }), 'addColour');
  assert.equal(buyLabelKind({ ...base, chosen: { name: 'Black', qty: 5 }, unavailable: true }), 'unavailable', 'a sold-out colour says so');
  assert.equal(buyLabelKind({ ...base, colourToChoose: false, unavailable: true }), 'unavailable');
  assert.equal(buyLabelKind({ ...base, signedIn: false }), 'signIn');
  assert.equal(buyLabelKind({ ...base, adding: true }), 'adding');
  assert.equal(buyLabelKind({ ...base, justAdded: true, lastAdded: { name: 'Black', qty: 50 } }), 'addedColour');
  assert.equal(buyLabelKind({ ...base, justAdded: true }), 'added');
});

test('the «added» label lasts only while the selection and the quantity are still what was added', () => {
  const added = pressKey({ colour: 'black', optionValueIds: ['b', 'a'], qty: 1, orderType: 'direct_sale', route: '', warranty: '' });
  assert.equal(pressKey({ colour: 'black', optionValueIds: ['a', 'b'], qty: 1, orderType: 'direct_sale', route: '', warranty: '' }), added, 'option order is not a change');
  assert.notEqual(pressKey({ colour: 'white', optionValueIds: ['a', 'b'], qty: 1, orderType: 'direct_sale', route: '', warranty: '' }), added, 'another colour');
  assert.notEqual(pressKey({ colour: 'black', optionValueIds: ['a', 'b'], qty: 5, orderType: 'direct_sale', route: '', warranty: '' }), added, 'another quantity');
});

test('quantities typed for colours the customer moved away from are remembered, so «حدّد كمية لكل لون» at the THIRD colour still carries the first', () => {
  // Black 50 → Cold White (reset) → type 5 → Beige (reset).
  let mem = rememberAfterTap({}, { from: 'black', to: 'white', qty: 50 });
  assert.deepEqual(mem, { black: 50 });
  mem = rememberAfterTap(mem, { from: 'white', to: 'beige', qty: 5 });
  assert.deepEqual(mem, { black: 50, white: 5 });
  // Coming back to a colour: its number is the stepper's again.
  assert.deepEqual(rememberAfterTap(mem, { from: 'beige', to: 'black', qty: 1 }), { white: 5 });
  // At 1, or from no colour, nothing is remembered.
  assert.deepEqual(rememberAfterTap({}, { from: 'black', to: 'white', qty: 1 }), {});
  assert.deepEqual(rememberAfterTap({}, { from: '', to: 'white', qty: 50 }), {});
});

test('the discovery hint counts the colour the page opened on: two taps away from it are three colours', () => {
  const t0 = 1_000_000;
  let w = tapWindow([], 'white', 'black', t0);
  assert.deepEqual(w.distinct, ['white', 'black']);
  w = tapWindow(w.taps, 'black', 'beige', t0 + 2000);
  assert.deepEqual(w.distinct, ['white', 'black', 'beige']);
  // Comparing two colours back and forth is never three.
  let ab = tapWindow([], 'white', 'black', t0);
  ab = tapWindow(ab.taps, 'black', 'white', t0 + 1000);
  ab = tapWindow(ab.taps, 'white', 'black', t0 + 2000);
  assert.equal(ab.distinct.length, 2);
  // Older than 30 s is forgotten.
  assert.deepEqual(tapWindow([{ id: 'grey', at: t0 - 31_000 }], 'white', 'black', t0).distinct, ['white', 'black']);
});

test('⚡ names what it buys, in all three languages; the full name is for assistive tech', () => {
  assert.equal(quickBuyLabel('ar', { name: 'Beige', qty: 56 }), `شراء سريع: 56 × ${FSI}Beige${PDI}`);
  assert.equal(quickBuyLabel('en', { name: 'Beige', qty: 56 }), `Quick Buy: 56 × ${FSI}Beige${PDI}`);
  assert.equal(quickBuyLabel('ckb', { name: 'Beige', qty: 56 }), `کڕینی خێرا: 56 × ${FSI}Beige${PDI}`);
  assert.equal(quickBuyLabel('en', { name: 'Jade White (10100)', qty: 2 }, { short: true }), `Quick Buy: 2 × ${FSI}Jade White (10100)${PDI}`);
  assert.equal(
    quickBuyLabel('en', { name: 'Translucent Teal Blue (10600)', qty: 2 }, { short: true }),
    `Quick Buy: 2 × ${FSI}Translucent Teal…${PDI}`
  );
});

test('the several-colours button: a guest is told sign-in comes first; with no rows it stays focusable (aria-disabled), never a dead end for focus', () => {
  const lines = [
    { name: 'Black', qty: 50 },
    { name: 'White', qty: 5 },
  ];
  const guest = multiAddButton({ lang: 'ar', signedIn: false, signInLabel: 'سجّل الدخول للشراء', busy: false, gateOpen: false, lines });
  assert.equal(guest.label, 'سجّل الدخول للشراء');
  assert.equal(guest.disabled, false);
  assert.ok(guest.ariaLabel?.startsWith('سجّل الدخول للشراء'), guest.ariaLabel);
  const empty = multiAddButton({ lang: 'en', signedIn: true, signInLabel: '', busy: false, gateOpen: false, lines: [] });
  assert.deepEqual([empty.label, empty.disabled, empty.ariaDisabled], ['Set a quantity for at least one colour', false, true]);
  const pending = multiAddButton({ lang: 'en', signedIn: true, signInLabel: '', busy: false, gateOpen: false, lines });
  assert.deepEqual([pending.disabled, pending.ariaDisabled], [true, false]);
  const ready = multiAddButton({ lang: 'en', signedIn: true, signInLabel: '', busy: false, gateOpen: true, lines });
  assert.deepEqual([ready.label, ready.disabled, ready.ariaDisabled], ['Add 55 pieces (2 colours)', false, false]);
  assert.equal(multiAddButton({ lang: 'en', signedIn: true, signInLabel: '', busy: true, gateOpen: true, lines }).disabled, true);
});

test('a group header counts COLOURS, not lines: two Black lines (spool and refill) are one colour', () => {
  const black = { colourId: 'black', qty: 1 };
  assert.equal(groupSummaryText('ar', [black, { colourId: 'black', qty: 1 }]), 'الألوان: 1 · القطع: 2');
  assert.equal(groupSummaryText('en', [black, { colourId: 'black', qty: 1 }]), '1 colour · 2 pieces');
  assert.equal(groupSummaryText('ckb', [black, { colourId: 'black', qty: 1 }]), '1 ڕەنگ · 2 پارچە');
  assert.equal(groupSummaryText('en', [{ colourId: 'black', qty: 50 }, { colourId: 'white', qty: 5 }, { colourId: 'beige', qty: 1 }]), '3 colours · 56 pieces');
  // No colour at all (two option lines of a colourless product): no colour count.
  assert.equal(groupSummaryText('ar', [{ colourId: '', qty: 1 }, { colourId: '', qty: 2 }]), 'القطع: 3');
  assert.equal(groupSummaryText('en', [{ colourId: '', qty: 1 }]), '1 piece');
});

test('English counts agree with their nouns: «1 piece in 1 colour», «5 pieces in 1 colour»', () => {
  const en = COLOUR_STRINGS.en;
  assert.equal(en.totalLine(1, 1), '1 piece in 1 colour');
  assert.equal(en.totalLine(5, 1), '5 pieces in 1 colour');
  assert.equal(en.totalLine(56, 3), '56 pieces in 3 colours');
  assert.equal(en.announceTotal(1, 1, '24,000 IQD'), '1 piece in 1 colour, total 24,000 IQD');
  assert.equal(en.groupSummary(1, 1), '1 colour · 1 piece');
  assert.equal(COLOUR_STRINGS.ar.totalLine(1, 1), 'مجموع القطع: 1 — الألوان: 1');
  assert.equal(COLOUR_STRINGS.ckb.totalLine(1, 1), 'کۆی پارچەکان: 1 — ڕەنگەکان: 1');
});

test('the confirmation sheet\'s line names use each language\'s own comma', () => {
  assert.equal(COLOUR_STRINGS.en.sheetLine(isolate('Black'), '50'), `${FSI}Black${PDI}, 50`);
  assert.equal(COLOUR_STRINGS.ar.sheetLine(isolate('Black'), '50'), `${FSI}Black${PDI}، 50`);
  assert.equal(COLOUR_STRINGS.ckb.sheetLine(isolate('Black'), '50'), `${FSI}Black${PDI}، 50 پارچە`);
});
