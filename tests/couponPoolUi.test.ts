/**
 * WHAT THE CUSTOMER'S SCREENS DO WITH A POOL OF REWARD COUPONS (0225; DECISIONS
 * row 295): the box shows the code in force with its way out, a placed order
 * forgets its code, a pool that shrank is redrawn and never charged quietly, and
 * every word exists in the three languages.
 *
 * Run: node --import tsx --test tests/couponPoolUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PromoCodeField from '../src/components/PromoCodeField';
import { AuthContext } from '../src/AuthContext';
import { WalletProvider } from '../src/WalletContext';
import { CurrencyProvider } from '../src/CurrencyContext';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { COPY } from '../src/components/rewards/copy';
import { couponPoolLabel } from '../packages/contracts/src/couponPool';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const box = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: {
        isAuthenticated: false,
        user: null,
        login: async () => {},
        loginWithGoogle: async () => 'ok' as const,
        register: async () => {},
        refreshUser: async () => {},
        adoptSession: async () => 'ok' as const,
        logout: async () => {},
        isLoaded: true,
      },
      children: createElement(WalletProvider, {
        children: createElement(CurrencyProvider, { children: createElement(PromoCodeField, { lang: 'ar', ...props }) }),
      }),
    })
  );

test('the checkout’s box shows the code the quote is priced with, and how to take it off', () => {
  const on = box({ appliedCode: 'RWS-1234' });
  assert.match(on, /RWS-1234/);
  assert.match(on, /إزالة/, 'a code that came from the cart or the rewards area can be removed where it is spent');
  assert.doesNotMatch(on, /<input/);

  const off = box({ appliedCode: '' });
  assert.doesNotMatch(off, /إزالة/, 'a code the quote refused stops showing');
  assert.match(off, /<input/);

  // Restated for the owner's «apply on cart product» (DECISIONS row 298): a REWARD code no longer waits in
  // this box, the cart's own card applies it (tests/cartCouponsUi.test.ts). A TYPED code still does: in the
  // cart, nothing in the box is applied until the customer asks.
  const cart = box({ initialCode: 'PROMO10' });
  assert.doesNotMatch(cart, /إزالة/, 'in the cart a typed code is not applied until the customer asks');
  assert.match(cart, /value="PROMO10"/);
  assert.match(src('src/pages/Checkout.tsx'), /appliedCode=\{couponCode\}/);
});

test('a placed order forgets its code, so a spent reward code opens nothing on the next checkout', () => {
  const page = src('src/pages/Checkout.tsx');
  assert.match(page, /setPlacedOrder\(data\.order\);[\s\S]{0,400}?storePromo\(''\);/);
});

test('a pool that shrank is redrawn from the server’s fresh quote, in the reader’s language', () => {
  const page = src('src/pages/Checkout.tsx');
  assert.match(page, /couponDiscountSeen: quote\?\.coupon \? Number\(quote\.coupon\.discount_iqd\) \|\| 0 : undefined,/);
  const branch = /else if \(err instanceof ApiError && err\.code === 'COUPON_POOL_CHANGED'\) \{[\s\S]*?setSubmitError\(msg\);/.exec(page)?.[0] ?? '';
  assert.ok(branch, 'the refusal has its own branch');
  assert.match(branch, /const fresh = err\.details\?\.quote as CheckoutQuoteDto \| undefined;/);
  assert.match(branch, /setQuote\(fresh\);/);
  assert.match(branch, /const sig = quoteSignature\(fresh\);/, 'a total that moved resets the consent');
  const words = REFUSAL_STRINGS.COUPON_POOL_CHANGED;
  assert.ok(words.ar && words.en && words.ckb);
  assert.notEqual(words.ckb, words.ar, 'DECISIONS row 183');
});

test('the empty state’s new terms exist in three languages, and a pool’s label says how many', () => {
  for (const key of ['coupons.what.bothTerms', 'coupons.what.bothAmount', 'coupons.what.shipTerms', 'coupons.what.shipAmount'] as const) {
    const [ar, en, ckb] = COPY[key];
    assert.ok(ar && en && ckb, key);
    assert.notEqual(ckb, ar, `${key}: DECISIONS row 183`);
    if (key.includes('Amount')) for (const words of COPY[key]) assert.doesNotMatch(words, /\{min\}/, `${key} names no minimum`);
  }
  for (const key of ['coupons.what.bothTerms', 'coupons.what.bothAmount'] as const) {
    for (const words of COPY[key]) assert.match(words, /\{pieces\}/, 'the pieces are the owner’s setting');
  }
  assert.equal(couponPoolLabel(2, 'ar'), 'خصم كوبونين');
  assert.equal(couponPoolLabel(4, 'ar'), 'خصم 4 كوبونات');
  assert.equal(couponPoolLabel(12, 'ar'), 'خصم 12 كوبونًا');
  assert.equal(couponPoolLabel(4, 'en'), '4 coupons');
  assert.equal(couponPoolLabel(4, 'ckb'), 'داشکاندنی 4 کۆپۆن');
});

test('the printed receipt and the admin’s order say how many coupons, not one code beside the pool’s total', () => {
  assert.match(src('worker/routes/admin.ts'), /label_ar: couponPoolSize > 1 \? couponPoolLabel\(couponPoolSize, 'ar'\)/);
  assert.match(src('worker/routes/admin.ts'), /label_en: couponPoolSize > 1 \? couponPoolLabel\(couponPoolSize, 'en'\)/);
  assert.match(src('src/components/adminOrders/OrderDetailModal.tsx'), /\(detail\.coupon\?\.pool\?\.length \?\? 0\) > 1/);
});
