/**
 * THE ORDER OF THE PURCHASE DECISION ON THE PRODUCT PAGE, and the two refusals
 * that keep an incomplete one out of the cart.
 *
 * The owner stated the sequence: «أولا يختار طريقة التوفر بيع مباشر أو طلب
 * مسبق، إذا كان طلب مسبق ثانيا يختار وسيلة النقل للطلب المسبق، ثم ثالثا يختار
 * النسخة اختيار الخيار، ورابعا يختار اللون إن وجد» — and separately, for the
 * colours: «أريد أن الألوان المتوفرة تظهر أولا والألوان التي لا تتوفر تظهر
 * آخرا».
 *
 * These are SOURCE-ORDER assertions on purpose. The five panels are siblings
 * of one fragment with no wrapper to query, so the order they are written in
 * IS the order the buyer reads. A structural test would need a DOM; this
 * catches the one thing that can regress — someone moving a block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');

const at = (needle: string): number => {
  const i = page.indexOf(needle);
  assert.ok(i > 0, `the page no longer contains ${needle}`);
  return i;
};

test('the panels run availability → transport → option → colour', () => {
  const blocks = at('const selectionBlocks = (');
  const availability = page.indexOf('data-fulfilment-chooser', blocks);
  const notify = page.indexOf('<StockAlertPanel', blocks);
  const transport = page.indexOf('{showTransports ? (', blocks);
  const option = page.indexOf('{hasMultipleOptionGroups ? (', blocks);
  const colour = page.indexOf('{orderedColors.length > 0 ? (', blocks);
  const warranty = page.indexOf('data-extended-warranty', blocks);
  for (const [name, i] of Object.entries({ availability, notify, transport, option, colour, warranty })) {
    assert.ok(i > blocks, `${name} is no longer inside selectionBlocks`);
  }

  assert.ok(availability < notify, '«طريقة التوفر» comes first');
  // The notify-me panel stays welded to the chooser: it answers «and then
  // what?» beside the disabled «بيع مباشر / نفد المخزون» card, and its own
  // comment says so.
  assert.ok(notify < transport, 'the notify-me panel stays between them');
  assert.ok(transport < option, 'the pre-order route is chosen before the version');
  assert.ok(option < colour, 'the version before the colour');
  assert.ok(colour < warranty, 'and the warranty stays last');
});

test('the colours in stock come first, and only where stock means anything', () => {
  const src = /const orderedColors =([\s\S]*?);\n/.exec(page);
  assert.ok(src, 'the page still derives an ordered colour list');
  // ONLY a direct sale: `available` is the SHELF, and a pre-order draws on an
  // import quota the colour rows do not carry. Sorting a pre-order by a shelf
  // count would demote a colour for being out of something the buyer was never
  // going to be handed from stock.
  assert.match(src![1], /requestedOrderType === 'direct_sale'/);
  assert.match(src![1], /: colorsForOption/, 'every other case keeps the admin order');
  // A COPY is sorted, never `colorsForOption` itself — that array is a useMemo
  // and an in-place sort would mutate a memoised value other reads share.
  assert.match(src![1], /\[\.\.\.colorsForOption\]\.sort\(/);

  // The sort key is the SAME number the chip prints, so the row can never
  // claim one thing and order by another…
  const key = /const colorHasStock = \(id: string\): boolean => \{([\s\S]*?)\n  \};/.exec(page);
  assert.ok(key, 'the availability predicate still exists');
  assert.match(key![1], /invMode === 'COLOR'[\s\S]{0,120}availByColor\.get\(id\)/);
  assert.match(key![1], /invMode === 'VARIANT_COMBINATION'[\s\S]{0,140}variantAvailable\.get\(comboKey\)/);
  // …and `null` is UNTRACKED, which this codebase is emphatic is not zero.
  assert.match(key![1], /n === null \|\| n === undefined \? true : n > 0/);

  // The render reads the ordered list, not the raw one.
  assert.match(page, /\{orderedColors\.map\(\(col\) => \{/);
  assert.ok(!/\{colorsForOption\.map\(/.test(page), 'nothing paints the unordered list');
});

test('picking a colour does not undo the two panels above it', () => {
  // A colour never decides HOW a product is sold — `option_availability` is
  // per option — so clearing the order type and the route on a colour tap sent
  // the buyer back two steps for answering step four.
  const tap = /setColorId\(selected \? '' : col\.id\);([\s\S]{0,200}?)\}\}/.exec(page);
  assert.ok(tap, 'the colour button still sets the colour');
  assert.ok(!/setOrderType\(''\)/.test(tap![1]), 'and no longer clears the order type');
  assert.ok(!/setTransportMethod\(''\)/.test(tap![1]), 'nor the chosen route');
});

test('a disabled button always has a sentence beside it', () => {
  // The route refusal is the one gate `selection.errors` cannot carry, so it
  // needs its own two sentences: one at the panel that answers it, and one
  // beside the button it disables.
  assert.match(page, /data-transport-required[\s\S]{0,160}reasonText\(s, 'TRANSPORT_REQUIRED'\)/);
  assert.match(page, /data-transport-required-note[\s\S]{0,160}reasonText\(s, 'TRANSPORT_REQUIRED'\)/);
  // …and the code it prints is translated in all three languages, not shown raw.
  for (const lang of ["'اختر وسيلة النقل.'", "'Choose a transport method.'", "'شێوازی گواستنەوە هەڵبژێرە.'"]) {
    assert.ok(page.includes(`TRANSPORT_REQUIRED: ${lang}`), `TRANSPORT_REQUIRED is missing ${lang}`);
  }
});
