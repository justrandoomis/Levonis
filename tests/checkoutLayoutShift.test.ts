/**
 * THE CHECKOUT DOES NOT GROW UNDER THE READER WHEN THE QUOTE ARRIVES.
 *
 * The Release A browser walk measured a layout shift of 0.12 on /checkout at
 * 390 px with a direct-sale line (0.115 at 1280), and none with a pre-order
 * line. Measured again locally (scratchpad tools/cls-checkout.mjs): one part,
 * 0.05, was the delivery-day picker and the chosen card's fee line, both drawn
 * only once `quote.shipping_type` came back (~150 ms after the page), pushing
 * the payment section and the phone's action bar down. After this change that
 * part measures 0.005 (the action bar's refusal line). The other part, 0.07,
 * is the focused shell's reserved Home slot giving way to the page's own
 * header — the deliberate trade-off src/components/bloub/MotionCharacterAnchor.tsx
 * documents («IT MOUNTS EVEN WHILE A ROUTE IS STILL LOADING») — and is not
 * touched here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { cartShippingType } from '../worker/lib/shippingType';

const CHECKOUT = readFileSync(join(ROOT, 'src/pages/Checkout.tsx'), 'utf8');

test('before the first quote the cart’s own first line decides whether the day picker is drawn', () => {
  assert.match(
    CHECKOUT,
    /const dayChoiceOffered =\s*settings !== null && endsAtTheDoor && offeredDays\.length > 0 &&\s*\(quote \? quote\.shipping_type === 'direct' : cartLooksDirect\);/,
    'once a quote exists its shipping_type is the only answer; before it, the lines'
  );
  // The screen reads the lines the way the server types the cart: by the first
  // line's transport, '' (or unknown) direct and air/sea/land a pre-order.
  assert.match(CHECKOUT, /const firstLineTransport = String\(items\[0\]\?\.transport_method \?\? ''\);/);
  assert.match(CHECKOUT, /const cartLooksDirect = items\.length > 0 && firstLineTransport !== 'air' && firstLineTransport !== 'sea' && firstLineTransport !== 'land';/);
  for (const [transport, direct] of [['', true], ['air', false], ['sea', false], ['land', false], ['unknown', true]] as const) {
    assert.equal(cartShippingType([{ transport_method: transport }]) === 'direct', direct, `server and screen agree on «${transport}»`);
  }
  // A pick the quote then refuses never survives to the POST.
  assert.match(CHECKOUT, /if \(!dayChoiceOffered\) \{\s*setRequestedDay\(null\);/);
});

test('the chosen home-delivery card holds its fee line’s height until the quote fills it', () => {
  assert.match(
    CHECKOUT,
    /\) : selected && !isPickupMethod && !quoteError \? \(\s*\/\*[\s\S]*?\*\/\s*<p aria-hidden="true" data-fee-line-placeholder className="mt-1 text-\[11px\] font-medium">&nbsp;<\/p>/,
    'the placeholder has the fee line’s own size and says nothing to a screen reader'
  );
});
