/**
 * «عند اختيار طلب مسبق وتحديد شحن بحري ثم اختيار النسخة عند الضغط على النسخة
 *  يذهب خيار طريق الشحن مثل البحري أو يختفي ويجب النقر على الشحن البري مرة
 *  ثانية حتى يحدد وعند تغيير الخيار يرجع يختفي — حل المشكلة.»
 *
 * The owner reported this twice. The product page asked two questions — how it
 * is fulfilled, and by which route — and threw BOTH answers away on every
 * version tap, so a buyer who had answered them had to answer them again, and
 * again after the next tap.
 *
 * WHY THIS FILE IS EXECUTABLE AND NOT A SOURCE-TEXT ASSERTION. The sibling
 * tests pin where these rules are called from; this one runs them. That split
 * is deliberate: this repository has already shipped a dead feature under a
 * green suite made entirely of assertions that the code was the code. A rule
 * about what the page REMEMBERS has to be exercised as a sequence of presses,
 * which is what every case below is.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOrderType,
  resolveTransport,
  routeIsUsable,
  type ModeFact,
  type RouteFacts,
} from '../src/lib/productSelection.ts';

/** A product that can be bought now or pre-ordered — the owner's case. */
const BOTH: ModeFact[] = [
  { type: 'direct_sale', usable: true },
  { type: 'pre_order', usable: true },
];
const PREORDER_ONLY: ModeFact[] = [
  { type: 'direct_sale', usable: false },
  { type: 'pre_order', usable: true },
];
const DIRECT_ONLY: ModeFact[] = [
  { type: 'direct_sale', usable: true },
  { type: 'pre_order', usable: false },
];
const NOTHING: ModeFact[] = [
  { type: 'direct_sale', usable: false },
  { type: 'pre_order', usable: false },
];

const THREE_ROUTES: RouteFacts = {
  transports: [
    { method: 'sea', configured: true },
    { method: 'land', configured: true },
    { method: 'air', configured: true },
  ],
};
/** A version whose sea freight nobody priced. */
const NO_SEA: RouteFacts = {
  transports: [
    { method: 'sea', configured: false },
    { method: 'land', configured: true },
  ],
};
/** Sea is priced, and its own import quota is full. */
const SEA_FULL: RouteFacts = {
  transports: [
    { method: 'sea', configured: true },
    { method: 'land', configured: true },
  ],
  routes: [
    { method: 'sea', usable: false },
    { method: 'land', usable: true },
  ],
};

/** One press of a version button: the answers stay, the facts change. */
const afterVersionTap = (
  press: { order: '' | 'direct_sale' | 'pre_order'; route: string },
  modes: ModeFact[],
  facts: RouteFacts
) => {
  const order = resolveOrderType(press.order, modes);
  return { order, route: resolveTransport(press.route, order, facts) };
};

test('THE OWNER’S SEQUENCE: pre-order, sea freight, then a version tap', () => {
  // The two answers, given once.
  const press = { order: 'pre_order' as const, route: 'sea' };
  assert.deepEqual(afterVersionTap(press, BOTH, THREE_ROUTES), { order: 'pre_order', route: 'sea' });

  // «ثم اختيار النسخة» — the version changes, and the new version still
  // pre-orders by sea. Both answers survive; nothing has to be re-tapped.
  const tap1 = afterVersionTap(press, BOTH, THREE_ROUTES);
  assert.deepEqual(tap1, { order: 'pre_order', route: 'sea' }, 'the route was thrown away again');

  // «وعند تغيير الخيار يرجع يختفي» — and again on the next version, and the
  // one after that. The answers are not consumed by being used.
  const tap2 = afterVersionTap(press, BOTH, THREE_ROUTES);
  const tap3 = afterVersionTap(press, BOTH, THREE_ROUTES);
  assert.deepEqual(tap2, tap1);
  assert.deepEqual(tap3, tap1);
});

test('a version that does not offer the chosen route drops it — and only it', () => {
  const press = { order: 'pre_order' as const, route: 'sea' };
  // Nobody priced sea on this version, so the route cannot be sent…
  const tapped = afterVersionTap(press, BOTH, NO_SEA);
  assert.equal(tapped.route, '', 'a route this version does not offer must not reach the door');
  // …but the buyer's PRE-ORDER answer is still theirs. Dropping that too is
  // what the old code did, and it is why the fulfilment card un-ticked itself.
  assert.equal(tapped.order, 'pre_order', 'the fulfilment answer went with the route again');
});

test('a route whose own quota is full is dropped; its siblings are not', () => {
  const press = { order: 'pre_order' as const, route: 'sea' };
  assert.equal(afterVersionTap(press, BOTH, SEA_FULL).route, '');
  assert.equal(afterVersionTap({ ...press, route: 'land' }, BOTH, SEA_FULL).route, 'land');
  // A route with no quota row at all is unlimited — `null` is not `false`.
  assert.equal(routeIsUsable(THREE_ROUTES, 'sea'), true);
  assert.equal(routeIsUsable(SEA_FULL, 'sea'), false);
  assert.equal(routeIsUsable(NO_SEA, 'sea'), false, 'an unpriced route is not offered');
  assert.equal(routeIsUsable(THREE_ROUTES, 'rail'), false, 'a route the product never declared');
  assert.equal(routeIsUsable(null, 'sea'), false, 'no answer yet is not an offer');
});

test('the route comes back by itself when a later version offers it again', () => {
  // This is what "remembered, not cleared" buys, and it cannot be had any
  // other way: the buyer never re-tapped sea, and sea is chosen again.
  const press = { order: 'pre_order' as const, route: 'sea' };
  assert.equal(afterVersionTap(press, BOTH, NO_SEA).route, '');
  assert.equal(afterVersionTap(press, BOTH, THREE_ROUTES).route, 'sea', 'the memory was consumed');
});

test('looking at the direct price does not forget the journey', () => {
  // The «بيع مباشر» card used to call setTransportMethod(''). A buyer who
  // compared the two prices and went back to «طلب مسبق» lost their sea freight
  // for having looked.
  const route = 'sea';
  assert.equal(resolveTransport(route, 'direct_sale', THREE_ROUTES), '', 'a direct sale carries no route');
  assert.equal(resolveTransport(route, 'pre_order', THREE_ROUTES), 'sea', 'and coming back finds it still chosen');
});

test('a press the server has closed stops being sent, and returns when it reopens', () => {
  // Nothing raises a pricing error for a closed type, so a page that kept
  // SENDING it would leave «أضف إلى السلة» live for an add the door refuses.
  assert.equal(resolveOrderType('direct_sale', PREORDER_ONLY), 'pre_order', 'the shelf emptied');
  assert.equal(resolveOrderType('pre_order', DIRECT_ONLY), 'direct_sale', 'the quota filled');
  // The press is remembered, so it wins again the moment the shelf refills.
  assert.equal(resolveOrderType('direct_sale', BOTH), 'direct_sale');
  assert.equal(resolveOrderType('pre_order', BOTH), 'pre_order');
});

test('with no press, the fallback is the cart door’s own order and never a server echo', () => {
  // direct, then pre-order — `lineOrderType`'s fallback, so an untouched
  // selection resolves to the same type on the page and at the door.
  assert.equal(resolveOrderType('', BOTH), 'direct_sale');
  assert.equal(resolveOrderType('', PREORDER_ONLY), 'pre_order');
  assert.equal(resolveOrderType('', DIRECT_ONLY), 'direct_sale');
  assert.equal(resolveOrderType('', NOTHING), '', 'no usable mode is still no answer');
  assert.equal(resolveOrderType('', []), '', 'and neither is no answer from the server');
});

test('the rules are total: no input leaves a request carrying a half-answer', () => {
  // A pre-order with no route is the one state the buy button must refuse, and
  // it must be reachable — never papered over with somebody else's route.
  assert.equal(resolveTransport('', 'pre_order', THREE_ROUTES), '');
  assert.equal(resolveTransport('sea', '', THREE_ROUTES), '', 'no fulfilment answer carries no route');
  assert.equal(resolveTransport('sea', 'pre_order', undefined), '', 'no facts yet carries no route');
  assert.equal(resolveTransport('sea', 'pre_order', { transports: [] }), '');
});

/**
 * THE SECOND HALF OF THE SAME REPORT, which is about the SCREEN rather than
 * the state: «الوضع في الاختيار يسبب أرباك للعميل ولا يعرف وغير clean».
 *
 * These two are source assertions, deliberately. The first is about which
 * panels EXIST together — a rendering question with no runtime state to drive
 * — and the second is about a presentation rule that is easy to drop from one
 * panel in a later edit and impossible to notice from the other five.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src/pages/Product.tsx'),
  'utf8'
);

test('«طريقة التوفر» is asked once, never twice on the same screen', () => {
  // Two panels can ask how the thing is fulfilled: the cards at the top, gated
  // on `offersBoth`, and the row inside the version chooser, which exists for
  // LEGACY data where one version is several option rows each declaring its
  // own route. On legacy data both were true at once, so the customer met the
  // question twice — with two different sets of buttons that are not the same
  // control, so answering one left the other looking unanswered.
  assert.match(
    PRODUCT,
    /\{offersBoth && !routeAskedPerVersion \? \(\n\s*<fieldset className="lv-section" data-fulfilment-chooser>/,
    'the top fulfilment cards can appear beside the per-version row again'
  );
  // Read from `models` as a whole, not the SELECTED model: a gate on the
  // active model flips a whole panel in and out as the buyer moves between
  // versions, which is a worse confusion than the one it fixes.
  assert.match(
    PRODUCT,
    /const routeAskedPerVersion = \(models \?\? \[\]\)\.some\(\(m\) => m\.options\.length > 1\);/
  );
  // The per-version row is the one that stays, because it is the only control
  // that can answer the question on that shape of data.
  assert.ok(PRODUCT.includes('data-availability-chooser'), 'the per-version row is still there');
});

test('every choice panel shows its own answer, so the column reads as a summary', () => {
  // Until now an answered panel carried nothing and an unanswered one carried
  // amber, so the only way to read the column was to open every panel and look
  // for the ticked chip inside it.
  const uses = PRODUCT.match(/<Chosen\b/g) ?? [];
  assert.ok(uses.length >= 6, `only ${uses.length} panels state their answer`);
  // One quiet cue, in the house's secondary type — never a second accent
  // competing with the price.
  assert.match(PRODUCT, /const Chosen = \(\{ value \}: \{ value: string \| null \| undefined \}\) =>/);
  assert.match(PRODUCT, /className="ms-2 font-medium text-\[12px\] text-zinc-400" data-chosen/);
  // The two the owner named by hand read the value IN FORCE, not the raw
  // press: a header quoting a press the server has closed would contradict the
  // tick in the panel underneath it.
  assert.match(PRODUCT, /<Chosen value=\{effectivePreorder \? s\.preorderMode : directUsable \? s\.directSale : null\} \/>/);
  assert.match(PRODUCT, /<Chosen value=\{effectiveTransport \? transportLabel\(s, effectiveTransport\) : null\} \/>/);
});
