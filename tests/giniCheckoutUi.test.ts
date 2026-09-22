/**
 * «تريدها اقساط ؟» AND «خيار ناعم وبسيط ليس ضخما» — THE CUSTOMER'S HALF.
 *
 * The server half of Gini is pinned executably in giniInstalments.test.ts: the
 * split, the clamp, the frozen hold, the wallet that may not part-pay, the
 * sweep. Nothing here re-tests any of that. What this file pins is the set of
 * client decisions that no type and no arithmetic can catch, and each of which
 * is a real defect if it drifts:
 *
 *   1. THE NOTE IS NOT DRAWN WITHOUT A LINK. «تريدها أقساط؟» under a product
 *      that is not listed in the Gini app is an offer the shop cannot keep.
 *   2. THE LINK GOES THROUGH A DOOR. `safeLink` drops `javascript:`/`data:`
 *      on the way in; the page repeats the test on the way out, because the
 *      value lands in an `href` under a customer's finger.
 *   3. THE SIX DIGITS BLOCK THE BUTTON THROUGH `blockReason`, not through a
 *      silent early return in `placeOrder` — the exact defect the ordered
 *      expression was built to end («عند الضغط على تأكيد الطلب لا يحدث شيء»).
 *   4. THE TWO GINI FIGURES ARE THE SERVER'S. A local fallback would be this
 *      screen's second opinion about money owed at a door.
 *   5. EVERY NEW SENTENCE EXISTS IN ar, en AND ckb.
 *
 * Run: node --import tsx --test tests/giniCheckoutUi.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { giniLinkOf } from '../src/components/product/GiniInstalmentsSheet';
import { asciiDigits } from '../src/components/checkout/GiniCheckoutOption';
import { GINI_ORDER_NO_RE } from '../packages/pricing/src/paymentPolicy';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const product = read('src/pages/Product.tsx');
const productSheet = read('src/components/product/GiniInstalmentsSheet.tsx');
const checkout = read('src/pages/Checkout.tsx');
const checkoutRow = read('src/components/checkout/GiniCheckoutOption.tsx');
const api = read('src/lib/api.ts');

// ───────────────────────────────────────────────── A. the product page note

test('the note renders nothing at all when there is no Gini link', () => {
  assert.ok(
    /\{giniLink \? \(/.test(product),
    'the «تريدها أقساط؟» line is guarded on the resolved link, not on the policy alone'
  );
  assert.ok(
    /\{giniLink \? \(\s*<GiniInstalmentsSheet/.test(product),
    'and the sheet is not even mounted, so stale state cannot open it onto an empty promise'
  );
});

test('the link is a real http(s) URL or it is not offered', () => {
  assert.equal(giniLinkOf('https://gini.example/p/1'), 'https://gini.example/p/1');
  assert.equal(giniLinkOf('  http://gini.example/p/1  '), 'http://gini.example/p/1');
  // The three the server's safeLink also refuses, repeated on the way out.
  assert.equal(giniLinkOf('javascript:alert(1)'), '');
  assert.equal(giniLinkOf('data:text/html,<script>'), '');
  assert.equal(giniLinkOf(''), '');
  assert.equal(giniLinkOf(undefined), '');
  // Stricter than safeLink on purpose: a relative path would open OUR site
  // under a button promising the Gini app.
  assert.equal(giniLinkOf('/products/x1'), '');
});

test('the note is a note, not a third button competing with Add to cart', () => {
  const at = product.indexOf('data-product-gini');
  assert.ok(at > 0, 'the note exists');
  const around = product.slice(at - 600, at + 400);
  assert.ok(!around.includes('lv-button'), 'it never takes the button styling the two CTAs above it use');
  assert.ok(/text-\[12\.5px\]/.test(around), 'it is the smallest type on the page, in the muted foreground');
  // Placement: after the compare/cheaper pair, before the reviews.
  const pair = product.indexOf('data-product-cheaper');
  const reviews = product.indexOf('<ReviewSection productId={product.id} />');
  assert.ok(pair > 0 && reviews > 0);
  assert.ok(pair < at && at < reviews, 'it sits under the two buttons and above the reviews');
});

test('the sheet opens the product in a new tab with the opener severed', () => {
  const at = productSheet.indexOf('href={url}');
  assert.ok(at > 0, 'the one button is a real anchor to the stored URL');
  const around = productSheet.slice(at, at + 260);
  assert.ok(around.includes('target="_blank"'), 'it opens in a new tab');
  assert.ok(
    around.includes('rel="noopener noreferrer"'),
    'and the opened page gets neither our window.opener nor our referrer'
  );
});

test('the sheet states the bank condition, and prefers the owner’s wording', () => {
  assert.ok(
    productSheet.includes('conditionFallback'),
    'a compiled sentence exists for a worker that predates the setting'
  );
  assert.ok(
    /const conditionText = \(condition \?\? ''\)\.trim\(\) \|\| s\.conditionFallback;/.test(productSheet),
    'but the owner’s own `giniPolicy.conditions` wins whenever it has anything in it'
  );
  assert.ok(
    product.includes('condition={pickText(giniPolicy?.conditions, lang)}'),
    'and it arrives through pickText, so a language the owner left empty falls back to one they wrote'
  );
});

// ─────────────────────────────────────────────────────────── B. the checkout

test('Gini is offered from the server’s list but never drawn as a fourth card', () => {
  assert.ok(
    /method\.id === 'gini' \? null : \(/.test(checkout),
    'the payment-method map skips it — «خيار ناعم وبسيط ليس ضخما»'
  );
  assert.ok(
    checkout.includes("giniOffered && method.id === giniAnchorId"),
    'it is drawn under the anchor row instead'
  );
  assert.ok(
    /giniAnchorId = filteredPaymentMethods\.some\(\(m\) => m\.id === 'cash'\)/.test(checkout),
    'and the anchor is cash on delivery, which is where the owner asked for it'
  );
  assert.ok(
    !/className=("|\{`)[^"`]*lv-choice/.test(checkoutRow),
    'the row itself never borrows the card styling of the methods above it'
  );
});

test('choosing the row is a real payment selection, exactly like the radios', () => {
  const at = checkout.indexOf('<GiniCheckoutOption');
  assert.ok(at > 0);
  const around = checkout.slice(at, at + 900);
  assert.ok(around.includes("setPaymentMethod('gini')"), 'it sets the payment method');
  assert.ok(
    around.includes('paymentPickedRef.current = true;'),
    'and ends the wallet-first default’s opinion, as touching a radio does'
  );
});

test('the field unfolds with the repo’s one recipe, and respects reduced motion', () => {
  assert.ok(
    /grid-rows-\[1fr\]/.test(checkoutRow) && /grid-rows-\[0fr\]/.test(checkoutRow),
    'grid-template-rows 0fr → 1fr — the only CSS-only animation to an unknown height'
  );
  assert.ok(
    checkoutRow.includes('min-h-0') && checkoutRow.includes('overflow-hidden'),
    'over the min-h-0 overflow-hidden child the recipe requires'
  );
  const reduced = checkoutRow.match(/motion-reduce:transition-none/g) ?? [];
  assert.ok(
    reduced.length >= 3,
    'every transition on the path is clamped — index.css’s reduce block leaves transitions running'
  );
  assert.ok(
    /invisible opacity-0/.test(checkoutRow),
    'and the folded panel is invisible, so the hidden field is out of the tab order'
  );
});

test('the field asks for six digits the way a phone should be asked', () => {
  assert.ok(checkoutRow.includes('inputMode="numeric"'), 'the digit pad, without type=number’s spinner');
  assert.ok(checkoutRow.includes('maxLength={6}'), 'six and no more');
  assert.ok(checkoutRow.includes('dir="ltr"'), 'LTR digits inside the RTL page');
  assert.ok(/text-\[16px\]/.test(checkoutRow), 'the 16px Mobile Safari floor, so focus does not zoom the viewport');
});

test('Arabic-Indic digits are folded, never stripped', () => {
  assert.equal(asciiDigits('١٢٣٤٥٦'), '123456');
  assert.equal(asciiDigits('۱۲۳۴۵۶'), '123456');
  assert.equal(asciiDigits('123456'), '123456');
  // What the field actually stores, and what the server will test it with.
  const typed = asciiDigits('١٢٣٤٥٦').replace(/[^0-9]/g, '').slice(0, 6);
  assert.ok(GINI_ORDER_NO_RE.test(typed), 'an Arabic keyboard produces a number the door accepts');
});

test('the missing number is a blockReason conjunct, never a silent early return', () => {
  const open = checkout.indexOf('const blockReason: string | null = (() => {');
  const close = checkout.indexOf('const canCompleteOrder = blockReason === null');
  assert.ok(open > 0 && close > open);
  const expression = checkout.slice(open, close);
  assert.ok(
    expression.includes('if (isGiniMethod && !giniOrderNoValid) return S.giniOrderNoBlock;'),
    'the sentence is produced by the ordered expression that owns the button'
  );
  // Soonest-fixable first: the field is on screen the moment Gini is picked.
  assert.ok(
    expression.indexOf('S.blockPayment') < expression.indexOf('S.giniOrderNoBlock'),
    'after the payment choice it belongs to'
  );
  assert.ok(
    expression.indexOf('S.giniOrderNoBlock') < expression.indexOf('S.needsConfig'),
    'and before the refusals the customer cannot act on'
  );

  const place = checkout.indexOf('const placeOrder = async () => {');
  const body = checkout.slice(place, place + 1200);
  assert.ok(
    !/if \(.*gini.*\) return;/i.test(body),
    'placeOrder adds no second, silent verdict — that is how a button comes to do nothing'
  );
});

test('the number is sent only on a Gini order', () => {
  assert.ok(
    checkout.includes('giniOrderNo: isGiniMethod ? giniOrderNoTrimmed : undefined,'),
    'no stray number on an order Gini knows nothing about'
  );
  assert.ok(
    checkout.includes("const giniOrderNoValid = GINI_ORDER_NO_RE.test(giniOrderNoTrimmed);"),
    'and the client tests the SAME expression the server does'
  );
  assert.ok(
    checkout.includes("import { GINI_ORDER_NO_RE } from '../../packages/pricing/src/paymentPolicy';"),
    'imported rather than retyped, so the two verdicts cannot drift'
  );
});

test('the two Gini amounts are the server’s, with no local fallback', () => {
  assert.ok(
    checkout.includes('const giniPaidIqd = isGiniMethod ? quote?.gini?.paid_iqd ?? 0 : 0;'),
    'paid comes off the quote'
  );
  assert.ok(
    checkout.includes('const giniDeliveryDueIqd = isGiniMethod ? quote?.gini?.delivery_due_iqd ?? 0 : 0;'),
    'and so does the door amount'
  );
  // The BNPL row beside it legitimately falls back to local arithmetic; this
  // one must not, because the split is carved out of a payable the delivery
  // fee is already inside.
  assert.ok(
    !/gini.*Math\.max\(0, orderTotal/.test(checkout),
    'nothing here re-derives a figure from the screen’s own totals'
  );
  assert.ok(
    checkout.includes('data-testid="checkout-gini-door"'),
    'and «ويظهر المبلغ الذي يدفع عند التوصيل فقط» has a row of its own'
  );
});

test('the wallet is not offered on a Gini order', () => {
  assert.ok(
    checkout.includes('{isGiniMethod ? null : ('),
    'the wallet block is suppressed — the server forces the applied balance to 0, '
      + 'so a live toggle would offer a deduction that never appears'
  );
});

test('the customer is told the order is not confirmed until the barcode is scanned', () => {
  assert.ok(checkoutRow.includes('data-gini-warning'), 'said where the customer is choosing');
  assert.ok(
    checkout.includes("placedOrder.gini?.state === 'awaiting_receipt'"),
    'and again after the order is placed, off the SERVER’s state rather than the selected method'
  );
  assert.ok(
    /hold_hours/.test(checkout),
    'the hours in the sentence come from the policy the sweep actually uses'
  );
});

// ───────────────────────────────────────────────────────── C. three languages

test('every new customer-facing string exists in ar, en and ckb', () => {
  const keys = [
    'giniRow',
    'giniRowHint',
    'giniOrderNoLabel',
    'giniOrderNoHelp',
    'giniOrderNoBlock',
    'giniPaidRow',
    'giniDoorRow',
    'giniPickupRow',
    'giniWarning',
    'giniPlacedTitle',
  ];
  for (const key of keys) {
    const hits = checkout.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(hits.length, 3, `${key} is written in all three languages, by hand`);
  }
  for (const key of ['giniCta']) {
    const hits = product.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(hits.length, 3, `${key} is written in all three languages, by hand`);
  }
  for (const key of ['title', 'intro', 'conditionLabel', 'conditionFallback', 'cta', 'close']) {
    const hits = productSheet.match(new RegExp(`\\b${key}:`, 'g')) ?? [];
    assert.equal(hits.length, 3, `${key} is written in all three languages, by hand`);
  }
});

test('the DTOs carry the new server fields', () => {
  assert.ok(/gini_url\?: string;/.test(api), 'the product link');
  assert.ok(/giniPolicy\?: \{/.test(api), 'the public policy the popup states');
  assert.ok(/state: '' \| 'awaiting_receipt' \| 'received' \| 'expired';/.test(api), 'and the order’s Gini state');
  assert.ok(
    /gini\?: \{\s*\n\s*available: boolean;/.test(checkout),
    'the quote block the checkout prices from'
  );
});
