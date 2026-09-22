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
  const key = /const colorHasStock = \(id: string\): boolean => \{([\s\S]*?)\n {2}\};/.exec(page);
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

test('a disabled button always has a sentence beside it — and only one', () => {
  // The panel that ANSWERS the refusal carries the hint, beside the control.
  assert.match(page, /data-transport-required[\s\S]{0,200}reasonText\(s, 'TRANSPORT_REQUIRED'\)/);
  // Beside the BUTTON there must be exactly one copy, and it is the quote's
  // own: the page always states the order type now, so a routeless pre-order
  // makes the resolver raise TRANSPORT_REQUIRED and `blockingCodes` prints it
  // in the alert stack over the CTA. A second hand-written copy there put the
  // same sentence on screen twice, adjacent.
  assert.ok(!page.includes('data-transport-required-note'), 'no second copy in the alert stack');
  assert.match(page, /blockingCodes\.map\(\(code\) => \(/);

  // …and the code is translated in all three languages, never shown raw.
  for (const lang of ["'اختر وسيلة النقل.'", "'Choose a transport method.'", "'شێوازی گواستنەوە هەڵبژێرە.'"]) {
    assert.ok(page.includes(`TRANSPORT_REQUIRED: ${lang}`), `TRANSPORT_REQUIRED is missing ${lang}`);
  }
  // The cart door keeps that code rather than flattening it into 'VALIDATION',
  // so the refusal reaches the customer in their own language.
  const cart = readFileSync(join(ROOT, 'worker/routes/cart.ts'), 'utf8');
  assert.match(
    cart,
    /resolved\.errors\.length === 1 && resolved\.errors\[0\] === 'TRANSPORT_REQUIRED'/,
  );
});

test('a new option keeps the buyer\u2019s two answers and re-checks them', () => {
  // «عند اختيار طلب مسبق وتحديد شحن بحري ثم اختيار النسخة عند الضغط على النسخة
  //  يذهب خيار طريق الشحن … وعند تغيير الخيار يرجع يختفي.»
  //
  // THIS TEST USED TO PIN THE OPPOSITE, and the owner met the result. Each of
  // the three option handlers called `setOrderType('')` and
  // `setTransportMethod('')`, so answering «طلب مسبق» and «شحن بحري» and then
  // tapping a version threw both answers away — and tapping the next version
  // threw them away again.
  //
  // The clearing was standing in for a validity check that did not exist: a
  // new version may genuinely not offer sea freight. «Forget everything» is a
  // blunt instrument for «check it is still true», and it charged every
  // correct selection the price of the rare invalid one. Both presses are kept
  // and FILTERED now, which is the check the clearing was imitating.
  // Scoped to the render tree: the fourth `setLiveAvailability(null)` is the
  // loader's, which clears a previous PRODUCT's answer and is not a handler.
  const tree = page.slice(page.indexOf('data-fulfilment-chooser'));
  const handlers = tree.match(/setLiveAvailability\(null\);/g) ?? [];
  assert.equal(handlers.length, 3, 'all three option handlers still re-ask the server');
  assert.ok(
    !/setTransportMethod\(''\);\n\s*setLiveAvailability\(null\);/.test(page),
    'an option handler is dropping the route again'
  );

  // THE FILTER IS WHAT MAKES KEEPING THEM SAFE. A remembered route that this
  // combination does not offer, or whose quota has since filled, must never
  // reach the cart door — so nothing downstream may read the raw state.
  assert.match(
    page,
    /const effectiveTransport = resolveTransport\(transportMethod, requestedOrderType, availability\?\.preorder\);/,
    'the route is honoured only while this combination offers it'
  );
  // Below the filter, the raw press is not readable at all: every consumer —
  // the price key, the quote body, the add body, `routeReady`, the chip's own
  // pressed state — reads `effectiveTransport`. One read of the raw state down
  // here is a request that can carry a route this combination does not offer.
  // (`transportMethod:` and `body.transportMethod` are wire field names, not
  // this variable, so they are excluded by position rather than by name.)
  const derivedAt = page.indexOf('const effectiveTransport =');
  const afterDerivation = page.slice(page.indexOf(": '';", derivedAt));
  const rawReads = afterDerivation.match(/(?<![.\w])transportMethod(?!\s*:)/g) ?? [];
  assert.deepEqual(rawReads, [], 'the raw press is read below the filter that is supposed to replace it');

  // The chips read the SAME predicate the filter reads — one fact, not two
  // copies of it that can drift into showing a route pressed that no request
  // is allowed to carry.
  assert.match(page, /const transportUsable = \(method: string\): boolean => routeIsUsable\(availability\?\.preorder, method\);/);
  assert.match(page, /const routeUsable = \(t: TransportView\): boolean => transportUsable\(t\.method\);/);
});

test('the buy column can be scrolled on its own when it outgrows the screen', () => {
  // A `position: sticky` box taller than the viewport sticks at `top` and
  // hangs its bottom below the fold, unreachable: page scroll no longer moves
  // it, and it only rises once the page has passed the whole other column.
  // The owner's own panel reorder is what made this reachable — six panels
  // now stack in one column.
  const aside = /<aside\n\s+className="([^"]*lg:sticky[^"]*)"\n\s+style=\{\{([\s\S]*?)\}\}/.exec(page);
  assert.ok(aside, 'the desktop buy column still exists');
  assert.match(aside![1], /lg:overflow-y-auto/, 'it scrolls itself');
  assert.match(aside![2], /maxHeight:[\s\S]*?100dvh/, 'and its height is bounded by the viewport');
  // Bounded against the SAME header variable the `top` offset uses, or the
  // panel is either clipped early or runs past the bottom by the header's
  // height.
  const top = /top: '([^']*)'/.exec(aside![2]);
  const max = /maxHeight: '([^']*)'/.exec(aside![2]);
  assert.ok(top && max, 'both offsets are stated');
  assert.match(top![1], /var\(--app-header-height, 68px\)/);
  assert.match(max![1], /var\(--app-header-height, 68px\)/);

  // Same answer as the other sticky sidebar in this app, not a second one.
  const outline = readFileSync(join(ROOT, 'src/components/policies/PolicyOutline.tsx'), 'utf8');
  assert.match(outline, /max-h-\[calc\(100dvh-var\(--app-header-height,68px\)-3rem\)\][\s\S]{0,40}overflow-y-auto/);
});
