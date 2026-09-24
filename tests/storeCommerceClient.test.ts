/**
 * THE CLIENT HALF OF THE COMMUNITY-STORE FIXES (merchant platform wave 1) —
 * what the screens do with what the server now says.
 *
 *   B1   the badge counted `items` — the Levonis half only — and read 0 over a
 *        full store cart; `GET /api/cart` sends `item_count` and the badge
 *        prefers it;
 *   B12  the checkout sends the quote's fingerprint, shows the fresh quote a
 *        409 QUOTE_CHANGED carries, and mints a new key per new agreement;
 *   B25  a blocked cart line says WHY, from the server's reason;
 *   B26  the merchant's orders tab pages through `next_cursor`, and asks
 *        before cancelling in a sheet — never `confirm()` / `alert()`;
 *   owner rule — the customer's «استلمت طلبي» is on the order page.
 *
 * The routes behind all of this are pinned by tests/storeCheckoutIntegrity,
 * storeOrderCancel, storeOrderRelease and merchantPayouts; this file keeps
 * the screens from quietly drifting back to what those routes no longer do.
 *
 * Run: node --import tsx --test tests/storeCommerceClient.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { cartCountStore, cartResponseCount, noteCartResponse, setCartCount } from '../src/lib/cartCount';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Code without its comments — an explanation must never satisfy an assertion about code. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// ============================================================================ B1

test('B1 the badge counts BOTH sellers: `item_count` wins over the Levonis-only `items`', () => {
  assert.equal(cartResponseCount({ items: [], item_count: 3 }), 3, 'a store-only cart is not empty');
  assert.equal(cartResponseCount({ items: [{ qty: 2 }, { qty: 1 }] }), 3, 'the merchant cart’s own lines are the whole cart');
  assert.equal(cartResponseCount({ success: true }), null, 'a body with no cart in it says nothing');
  assert.equal(cartResponseCount({ items: [{ qty: 1 }], item_count: -1 }), 1, 'a nonsense count is not believed');

  setCartCount(null);
  noteCartResponse('/api/cart', { items: [], item_count: 2 });
  assert.equal(cartCountStore.snapshot(), 2);
  noteCartResponse('/api/orders', { items: [], item_count: 9 });
  assert.equal(cartCountStore.snapshot(), 2, 'only a cart path moves the badge');
  setCartCount(null);

  const nav = code('src/components/BottomNav.tsx');
  assert.match(nav, /setCartCount\(cartResponseCount\(d\) \?\? 0\)/, 'the bottom bar’s own fetch uses the same rule');
});

// =========================================================================== B12

test('B12 the checkout places THE QUOTE ON SCREEN: its fingerprint, its coupon, its key', () => {
  const src = code('src/pages/StoreCheckout.tsx');
  assert.match(src, /idempotencyKey: keyFor\(agreed\.quote_fingerprint\)/);
  assert.match(src, /quoteFingerprint: agreed\.quote_fingerprint/);
  assert.match(src, /agreed\.coupon_code \? \{ couponCode: agreed\.coupon_code \} : \{\}/);
  // A new agreement is a new key; the same one is the same key.
  assert.match(src, /if \(attempt\.current\?\.fingerprint !== fingerprint\) attempt\.current = \{ fingerprint, key: newCheckoutKey\(\) \};/);
});

test('B12 a 409 QUOTE_CHANGED shows the fresh quote and names both totals — nothing is placed silently', () => {
  const src = code('src/pages/StoreCheckout.tsx');
  const branch = /if \(code === 'QUOTE_CHANGED'\) \{[\s\S]*?\n {6}\}/.exec(src)?.[0] ?? '';
  assert.ok(branch, 'the QUOTE_CHANGED branch exists');
  assert.match(branch, /e\.details\?\.quote as StoreQuote/);
  assert.match(branch, /setQuote\(fresh\)/);
  assert.match(branch, /setPriceMoved\(\{ from: agreed\.total_iqd, to: fresh\.total_iqd \}\)/);
  assert.ok(!/storeCheckoutApi\.place/.test(branch), 'it never re-places on its own');
  // The customer is asked to confirm the NEW total, beside the button.
  assert.match(src, /data-quote-changed/);
  assert.match(src, /priceMoved\s*\?\s*loc\('تأكيد الإجمالي الجديد', 'Confirm the new total'\)/);
});

test('B12 a spent key is replaced, never retried: IDEMPOTENCY_KEY_REUSED clears the attempt and re-quotes', () => {
  const src = code('src/pages/StoreCheckout.tsx');
  const branch = /if \(code === 'IDEMPOTENCY_KEY_REUSED'\) \{[\s\S]*?\n {6}\}/.exec(src)?.[0] ?? '';
  assert.ok(branch);
  assert.match(branch, /attempt\.current = null;/);
  assert.match(branch, /loadQuote\(coupon\)/);
  assert.ok(!/storeCheckoutApi\.place/.test(branch));
});

test('the store checkout and cart decode refusal CODES — no server sentence reaches the customer', () => {
  for (const rel of ['src/pages/StoreCheckout.tsx', 'src/components/merchant/MerchantCartView.tsx']) {
    const src = code(rel);
    assert.ok(!/e instanceof ApiError \? e\.message/.test(src), `${rel} renders the server's sentence`);
    assert.match(src, /apiRefusal\(e, lang,/);
  }
  // The top-up link belongs to a wallet shortfall, not to every refusal.
  assert.match(code('src/pages/StoreCheckout.tsx'), /placeRemedy === 'topup' && topUpLink\(/);
});

// =========================================================================== B25

test('B25 a blocked store cart line says why, for every reason the server gives', () => {
  const src = code('src/components/merchant/MerchantCartView.tsx');
  for (const reason of ['out_of_stock', 'option_gone', 'store_closed', 'own_store', 'other_store']) {
    assert.match(src, new RegExp(`case '${reason}':`), `no sentence for ${reason}`);
  }
  assert.match(src, /\{blockedText\(l\)\}/);
  // A failed first read is a failure with a retry, never «your cart is empty».
  assert.ok(!/setCart\(\{ scope: null, store: null, items: \[\], subtotal_iqd: 0 \}\)/.test(src));
});

// =========================================================================== B26

test('B26 the merchant orders tab pages through next_cursor and never uses a native dialog', () => {
  const all = code('src/components/merchant/dashboard/SalesTabs.tsx');
  const tab = /export function OrdersTab\([^)]*\)[^{]*\{[\s\S]*?\n\}\n/.exec(all)?.[0] ?? '';
  assert.ok(tab, 'OrdersTab is findable');
  assert.match(tab, /setNextCursor\(d\.next_cursor \?\? null\)/);
  assert.match(tab, /merchantApi\.orders\(query\(nextCursor\)\)/);
  assert.ok(!/\bconfirm\(|\balert\(/.test(tab), 'no window.confirm / window.alert in the orders tab');
  assert.match(tab, /<Sheet/);
  assert.match(tab, /apiRefusal\(e, lang,/);
});

// ================================================================ owner's rule

test('the customer’s «استلمت طلبي» is on the order page and posts to confirm-receipt', () => {
  const receipt = code('src/components/orders/StoreReceipt.tsx');
  assert.match(receipt, /api\.post\(`\/api\/orders\/\$\{encodeURIComponent\(order\.id\)\}\/confirm-receipt`\)/);
  assert.match(receipt, /receipt\.auto_confirms_at/, 'the date it happens on its own is shown');
  assert.match(receipt, /<Sheet/, 'asked in a sheet — it pays the store and cannot be undone');
  assert.match(code('src/pages/OrderDetail.tsx'), /<StoreReceipt\s/);
});

test('the seller-conflict dialog offers the owner’s two answers', () => {
  const src = read('src/components/merchant/SellerConflictDialog.tsx');
  assert.match(src, /العودة إلى السلة الحالية/);
  assert.match(src, /إفراغ السلة والتحول للبائع الجديد/);
});
