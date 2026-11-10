/**
 * WHAT THE CUSTOMER AND THE ADMIN SEE OF THE COUPONS (owner, 2026-11-05: «from user side
 * with apply on cart product and every thing to admin side»; DECISIONS row 298): the
 * card's rows and its one press, the line and summary marks, the checkout's quiet row,
 * «طابعاتك», the admin's tabs and the words of all of it in three languages, the Sorani
 * its own (DECISIONS row 183).
 *
 * Run: node --import tsx --test tests/cartCouponsUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';
import { AuthContext } from '../src/AuthContext';
import { ApiError } from '../src/lib/api';
import { CurrencyProvider } from '../src/CurrencyContext';
import { LanguageProvider } from '../src/LanguageContext';
import { WalletProvider } from '../src/WalletContext';
import {
  CART_COUPON_WORDS,
  CartCoupons,
  cartCouponRows,
  cartCouponText,
  cartCouponsPath,
  checkoutCouponsText,
  couponTargetLink,
  isRateLimited,
  previewSaving,
  type CartCoupon,
  type CartRewardCoupons,
} from '../src/components/rewards/CartCoupons';
import { COPY, copyText } from '../src/components/rewards/copy';
import { doorLines, doorText } from '../src/components/rewards/model';
import type { RewardsHubData } from '../src/components/rewards/types';
import { weeklyEarnSummary } from '../src/components/adminRewards/AdminRewards';
import { PrintersBlock } from '../src/components/rewards/PrintersBlock';
import type { Read } from '../src/components/rewards/useRewardsData';
import type { RewardPrintersData } from '../src/components/rewards/types';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const ARABIC_ONLY = /[ةىيك]/;

type Lang = 'ar' | 'en' | 'ckb';
let LANG: Lang = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };

const auth = {
  isAuthenticated: true,
  user: null,
  login: async () => {},
  loginWithGoogle: async () => 'ok' as const,
  register: async () => {},
  refreshUser: async () => {},
  adoptSession: async () => 'ok' as const,
  logout: async () => {},
  isLoaded: true,
};

function render(el: ReactElement, lang: Lang = 'ar'): string {
  LANG = lang;
  return renderToStaticMarkup(
    createElement(AuthContext.Provider, {
      value: auth,
      children: createElement(LanguageProvider, {
        children: createElement(WalletProvider, {
          children: createElement(CurrencyProvider, { children: createElement(MemoryRouter, { children: el }) }),
        }),
      }),
    })
  );
}

const coupon = (over: Partial<CartCoupon>): CartCoupon => ({
  id: 'g',
  code: 'RWS1',
  kind: 'free_shipping',
  percent: 0,
  amount_iqd: 5_000,
  min_total_iqd: 100_000,
  max_discount_iqd: null,
  max_quantity: null,
  expires_at: '2026-11-12T00:00:00.000Z',
  take_iqd: 0,
  lines: [],
  state: 'applies',
  short_of_iqd: 0,
  ...over,
});
const filament = (over: Partial<CartCoupon>): CartCoupon =>
  coupon({ kind: 'filament_discount', code: 'RWF1', percent: 15, amount_iqd: null, min_total_iqd: 0, max_discount_iqd: 25_000, max_quantity: 1, ...over });

const read = (coupons: CartCoupon[], preview: Partial<NonNullable<CartRewardCoupons['preview']>> | null): CartRewardCoupons => ({
  installed: true,
  server_time: '2026-11-05T00:00:00.000Z',
  coupons,
  preview: preview
    ? { code: 'RWS1', count: 1, merchandise_iqd: 0, delivery_iqd: 0, total_iqd: 0, lines: [], goods_after_discount_iqd: 0, blocked_min_total_iqd: null, short_of_iqd: 0, delivery_waiting: false, ...preview }
    : null,
});

const card = (r: CartRewardCoupons, mode: 'none' | 'pool' | 'promo', lang: Lang = 'ar', promoCode = '') =>
  render(createElement(CartCoupons, { read: r, mode, promoCode, lineName: () => 'eSUN PLA+', onApply: () => {}, onRemove: () => {} }), lang);

// ------------------------------------------------------------ the words

test('every word of the card has three languages, the Sorani its own, and the same marks', () => {
  const marks = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const [key, row] of Object.entries(CART_COUPON_WORDS)) {
    const [ar, en, ckb] = row as readonly [string, string, string];
    assert.ok(ar && en && ckb, key);
    assert.notEqual(ckb, ar, `${key}: DECISIONS row 183`);
    assert.notEqual(ckb, en, key);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in «${ckb}»`);
    assert.equal(marks(ar), marks(en), key);
    assert.equal(marks(ar), marks(ckb), key);
  }
  assert.equal(cartCouponText('applySave', 'ar', { money: 'X' }), 'طبّق كوبوناتي · وفّر X');
  assert.equal(cartCouponText('apply', 'ar'), 'طبّق كوبوناتي');
  assert.equal(cartCouponText('applied', 'ar'), 'مطبّق');
  assert.equal(cartCouponText('remove', 'ar'), 'إزالة');
  assert.equal(cartCouponText('addFor', 'ar', { money: 'X' }), 'أضف X ليعمل كوبون التوصيل');
  // Not «no filament in your cart»: the cart can hold another filament, or this one as a gift.
  assert.equal(cartCouponText('noFilament', 'ar'), 'ليس في سلتك فلامنت يشمله');
  assert.equal(cartCouponText('onOffer', 'ar'), 'لا يعمل على قطعة عليها عرض');
  assert.equal(cartCouponText('nextOrder', 'ar'), 'يبقى لطلبك القادم');
  assert.equal(cartCouponText('finalAtCheckout', 'ar'), 'يُحسب نهائيًا عند الدفع');
  assert.equal(cartCouponText('summaryGoods', 'ar'), 'كوبونات المكافأة');
  assert.equal(cartCouponText('summaryPromo', 'ar'), 'كود الخصم');
  assert.equal(cartCouponText('summaryDelivery', 'ar'), 'كوبون التوصيل');
});

test('the new keys of the rewards area have three languages, and «طابعاتك» says each thing the server can say', () => {
  const keys = Object.keys(COPY).filter((k) => k.startsWith('printers.') || k === 'coupon.fromPrinterNamed') as Array<keyof typeof COPY>;
  assert.ok(keys.length >= 11);
  for (const k of keys) {
    const [ar, en, ckb] = COPY[k];
    assert.ok(ar && en && ckb, k);
    assert.notEqual(ckb, ar, k);
    assert.doesNotMatch(ckb, ARABIC_ONLY, k);
  }
  for (const why of ['warranty_closed', 'warranty_over', 'returned', 'traded_in', 'in_shop', 'programme_off']) {
    assert.ok(`printers.stopped.${why}` in COPY, why);
  }
  // The shop's own names carry the word: «طابعة Bambu Lab A1 mini», and the line doubled it.
  assert.equal(copyText('coupon.fromPrinterNamed', 'ar', { name: 'طابعة A1', week: 3 }), 'من طابعة A1 · الأسبوع 3');
});

test('every string the admin’s new screens hold is written in three languages, and no Sorani slot copies the Arabic', () => {
  for (const file of ['src/components/adminRewards/RewardsOverview.tsx', 'src/components/adminRewards/RewardsPrinters.tsx', 'src/components/adminRewards/RewardsCoupons.tsx']) {
    const sf = ts.createSourceFile(file, src(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let calls = 0;
    const walk = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'loc') {
        calls += 1;
        assert.equal(n.arguments.length, 3, `${file}: ${n.getText().slice(0, 80)}`);
        const [ar, , ckb] = n.arguments.map((a) => a.getText());
        assert.notEqual(ckb, ar, `${file}: ${n.getText().slice(0, 80)}`);
        assert.doesNotMatch(ckb.replace(/\$\{[^}]*\}/g, ''), ARABIC_ONLY, `${file}: an Arabic-only letter in ${ckb}`);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    assert.ok(calls > 10, `${file}: its words were not found (${calls})`);
  }
});

// ------------------------------------------------------------ the rows

test('identical coupons are one row with «×2»; the rows that take something come first', () => {
  const rows = cartCouponRows([
    coupon({ state: 'no_fee', code: 'A' }),
    filament({ state: 'no_target', code: 'B', targets: { products: [], products_total: 0, section: { path: '/categories/x' } } }),
    coupon({ state: 'applies', take_iqd: 5_000, code: 'C' }),
    coupon({ state: 'applies', take_iqd: 5_000, code: 'D' }),
    filament({ state: 'applies', take_iqd: 2_250, code: 'E', lines: [{ line_id: 'l1', amount_iqd: 2_250 }] }),
    filament({ state: 'applies', take_iqd: 2_250, code: 'F', lines: [{ line_id: 'l1', amount_iqd: 2_250 }] }),
    filament({ state: 'applies', take_iqd: 1_500, code: 'G', lines: [{ line_id: 'l2', amount_iqd: 1_500 }] }),
    coupon({ state: 'min_not_met', short_of_iqd: 30_000, code: 'H' }),
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.state, r.count, r.take_iqd]), [
    ['free_shipping', 'applies', 2, 10_000],
    ['filament_discount', 'applies', 2, 4_500],
    ['filament_discount', 'applies', 1, 1_500],
    ['free_shipping', 'min_not_met', 1, 0],
    ['free_shipping', 'no_fee', 1, 0],
    ['filament_discount', 'no_target', 1, 0],
  ]);
  assert.deepEqual(rows[1].line_ids, ['l1']);
});

test('a coupon with no line links to what it covers: its one product, its section, or its own page for a list', () => {
  assert.equal(couponTargetLink({ products: [{ id: 'p', slug: 'esun pla' }], products_total: 1, section: null }), '/product/esun%20pla');
  assert.equal(couponTargetLink({ products: [{ id: 'p', slug: 'a' }, { id: 'q', slug: 'b' }], products_total: 2, section: null }), '/rewards/coupons');
  assert.equal(couponTargetLink({ products: [], products_total: 0, section: { path: '/categories/fdm' } }), '/categories/fdm');
  assert.equal(couponTargetLink({ products: [], products_total: 0, section: null }), null);
  assert.equal(couponTargetLink(null), null);
});

test('not applied: the rows of what it would take, and one primary button that says the saving', () => {
  const html = card(
    read(
      [coupon({ take_iqd: 5_000 }), filament({ take_iqd: 2_250, lines: [{ line_id: 'l1', amount_iqd: 2_250 }] })],
      { total_iqd: 7_250, merchandise_iqd: 2_250, delivery_iqd: 5_000, count: 2 }
    ),
    'none'
  );
  assert.match(html, /data-cart-coupons="none"/);
  assert.match(html, /كوبوناتك/);
  assert.match(html, /طبّق كوبوناتي · وفّر/);
  assert.match(html, /eSUN PLA\+/, 'on what product');
  assert.match(html, /يُحسب نهائيًا عند الدفع/, 'the delivery in it is an estimate');
  assert.doesNotMatch(html, /مطبّق/);
  assert.doesNotMatch(html, /data-cart-coupons-remove/);
  assert.equal(html.split('lv-button-primary').length - 1, 1, 'one primary');
});

test('a waiting delivery coupon alone: the button says no figure it does not have', () => {
  const html = card(read([coupon({ state: 'waiting' })], { total_iqd: 0, delivery_waiting: true }), 'none');
  assert.match(html, /طبّق كوبوناتي/);
  assert.doesNotMatch(html, /وفّر/);
  assert.match(html, /يُخصم من التوصيل عند الدفع/);
  assert.doesNotMatch(html, /data-cart-coupons-estimate/, 'no figure for a note to qualify');
});

test('applied: the same rows with a tick and «مطبّق», and the button becomes «إزالة»', () => {
  const html = card(read([coupon({ take_iqd: 5_000 })], { total_iqd: 5_000, delivery_iqd: 5_000 }), 'pool');
  assert.match(html, /data-cart-coupons="pool"/);
  assert.match(html, /data-cart-coupon-applied/);
  assert.match(html, /مطبّق/);
  assert.match(html, /data-cart-coupons-remove/);
  assert.match(html, /إزالة/);
  assert.doesNotMatch(html, /طبّق كوبوناتي/);
});

test('a typed code in force: the card says so, the coupons do not join it, and «طبّق كوبوناتي» replaces it', () => {
  const html = card(read([coupon({ take_iqd: 5_000 })], { total_iqd: 5_000, delivery_iqd: 5_000 }), 'promo', 'ar', 'PROMO10');
  assert.match(html, /data-cart-coupons-promo/);
  assert.match(html, /PROMO10/);
  assert.match(html, /لا تجتمع معه/);
  assert.match(html, /طبّق كوبوناتي/);
  assert.doesNotMatch(html, /مطبّق<|data-cart-coupon-applied/);
});

test('coupons that do not apply are muted rows that say why, and offer no button', () => {
  const html = card(
    read(
      [
        coupon({ state: 'min_not_met', short_of_iqd: 57_250 }),
        coupon({ state: 'no_fee', code: 'S2', min_total_iqd: 50_000 }),
        filament({ state: 'no_target', targets: { products: [], products_total: 0, section: { path: '/categories/fdm' } } }),
        filament({ state: 'no_piece', code: 'F2' }),
      ],
      null
    ),
    'none'
  );
  assert.match(html, /أضف .*ليعمل كوبون التوصيل/);
  assert.match(html, /يبقى لطلبك القادم/);
  assert.match(html, /ليس في سلتك فلامنت يشمله/);
  assert.match(html, /href="\/categories\/fdm"/);
  assert.match(html, /تصفّح الفلامنت/);
  assert.doesNotMatch(html, /data-cart-coupons-apply/);
  assert.doesNotMatch(html, /data-cart-coupons-estimate/, 'nothing estimated: no note');
});

test('the card exists in all three languages, with no Arabic left in the English', () => {
  const r = read([coupon({ take_iqd: 5_000 }), filament({ state: 'no_target' })], { total_iqd: 5_000, delivery_iqd: 5_000 });
  const en = card(r, 'none', 'en');
  assert.match(en, /Your coupons/);
  assert.match(en, /Apply my coupons/);
  // The money is `useMoney()`, as on every other figure of the cart; this tree has no language above the currency, so it writes «د.ع».
  assert.doesNotMatch(en.replace(/<[^>]+>/g, '').replace(/د\.ع/g, ''), /[؀-ۿ]/);
  const ckb = card(r, 'none', 'ckb');
  assert.match(ckb, /کۆپۆنەکانت/);
  assert.doesNotMatch(ckb.replace(/<[^>]+>/g, ''), /كوبون|طبّق/);
});

test('the read’s address carries the ticks and the estimate, and only a real estimate', () => {
  assert.equal(cartCouponsPath(['a', 'b'], 5_000), '/api/cart/reward-coupons?item_ids=a%2Cb&delivery_iqd=5000');
  assert.equal(cartCouponsPath(['a'], null), '/api/cart/reward-coupons?item_ids=a');
  assert.equal(cartCouponsPath(['a'], 0), '/api/cart/reward-coupons?item_ids=a&delivery_iqd=0');
});

test('the checkout’s row counts as Arabic counts', () => {
  const money = (n: number) => `${n}`;
  assert.equal(checkoutCouponsText({ count: 1, total_iqd: 5 }, 'ar', money), 'لديك كوبون — وفّر 5');
  assert.equal(checkoutCouponsText({ count: 2, total_iqd: 5 }, 'ar', money), 'لديك كوبونان — وفّر 5');
  assert.match(checkoutCouponsText({ count: 4, total_iqd: 5 }, 'ar', money), /كوبونات — وفّر 5$/);
  assert.match(checkoutCouponsText({ count: 12, total_iqd: 5 }, 'ar', money), /كوبونًا — وفّر 5$/);
  assert.match(checkoutCouponsText({ count: 3, total_iqd: 5 }, 'en', money), /You have .* coupons — save 5/);
  assert.match(checkoutCouponsText({ count: 3, total_iqd: 5 }, 'ckb', money), /کۆپۆنت هەیە — 5 پاشەکەوت بکە$/);
});

// ------------------------------------------------------------ the pages

test('the cart: the card sits between the lines and the deals, and the coupon reaches the line, the summary and the sums', () => {
  const page = src('src/pages/Cart.tsx');
  const lines = page.indexOf('groupCartLines(items).map');
  const cardAt = page.indexOf('<CartCoupons');
  const deals = page.indexOf("'العروض والخصومات'");
  assert.ok(lines > 0 && lines < cardAt && cardAt < deals, 'between the lines and «العروض والخصومات»');
  assert.match(page, /\{coupons\.read && selectedCount > 0 && \(\s*<CartCoupons/, 'only for a customer the read found coupons for');
  assert.match(page, /data-cart-line-coupon=\{item\.id\}/);
  assert.match(page, /data-cart-coupon-goods/);
  assert.match(page, /data-cart-coupon-delivery/);
  assert.match(page, /const pointsDiscount = usePoints \? Math\.min\(pointBalance, Math\.max\(0, merchandise - couponGoods\)\) : 0;/, 'points on the goods after the coupon, the checkout’s order');
  assert.match(page, /const total = merchandise - couponGoods \+ \(shipping \?\? 0\) - couponDelivery - pointsDiscount;/);
  assert.match(page, /const savedTotal = otherDiscounts \+ memberNamedSaving \+ Math\.max\(0, couponGoods \+ couponDelivery - coupons\.feeBack\);/, 'what it saves, not what it takes: the fee it brings back is no saving');
  assert.match(page, /const totalUsd = usdTotal\(total, /, 'the dollars follow the same total');
  assert.match(page, /\{money\(total, totalUsd\)\}/, 'and so does the sticky bar');
  // With no coupon every new figure is 0, and every new row is behind one of them.
  assert.match(page, /\{couponGoods > 0 && \(/);
  assert.match(page, /\{couponDelivery > 0 && \(/);
  assert.doesNotMatch(page, /readStoredPromo/, 'the hook remembers the code; a reward code never waits in the box');
  assert.match(page, /initialCode=\{coupons\.boxCode\}/);
  assert.match(page, /key=\{coupons\.boxKey\}/, 'the page clears the box when the coupons replace its code');
});

test('the card’s read is quiet: no skeleton, aborted on change, debounced, and silent to the mascot', () => {
  const file = src('src/components/rewards/CartCoupons.tsx');
  assert.match(file, /CART_COUPONS_DEBOUNCE_MS = 300/);
  assert.match(file, /ac\.abort\(\)/);
  assert.match(file, /mascot: 'silent'/);
  assert.doesNotMatch(file, /Skeleton/);
  assert.match(file, /holdsNone\.current = answer\.coupons\.length === 0;/, 'an empty answer ends the reads');
  assert.match(file, /if \(res\.reward_code\) \{\s*storePromo\(''\);/, 'a reward code of theirs that opens nothing is forgotten');
  // Nothing of the rewards area rides in the chunk every visitor prefetches.
  assert.doesNotMatch(file, /from '\.\/copy'|from '\.\/model'|from '\.\/AreaChrome'/);
  assert.doesNotMatch(file, /lv-surface-raised/);
});

test('the checkout: one quiet row beside the code’s, only with no code on the order, and its press does what the box does', () => {
  const page = src('src/pages/Checkout.tsx');
  const row = page.indexOf('<CheckoutCouponsRow');
  const box = page.indexOf('<PromoCodeField');
  assert.ok(row > 0 && row < box);
  const block = page.slice(row, box);
  assert.match(block, /enabled=\{!couponCode && !quoteLoading\}/, 'a settled quote, to compare with');
  assert.match(block, /deliveryIqd=\{shippingIqd\}/);
  assert.match(block, /signature=\{\[itemIdsKey, selectedAddressId, deliveryMethod, paymentMethod, usePoints, useWalletBalance, protectedDelivery, supportRef\]\.join/, 'whatever prices the order');
  assert.match(block, /plainTotalIqd=\{quote\.total_iqd\}/);
  assert.match(block, /quoteWith=\{quoteWithCoupon\}/);
  assert.match(block, /storePromo\(code\);\s*applyCouponCode\(code\);/);
  assert.match(page, /onApplied=\{applyCouponCode\}/, 'the box and the row are one path');
  assert.match(page, /const applyCouponCode = \(code: string\) => \{[\s\S]*?customerQuote\.mark\(\);\s*setCouponCode\(code\);/, 'the customer asked for that quote');
});

test('«كوبوناتي»: the printers above the coupons, only this page asks, and each coupon names its printer and week', () => {
  const screen = src('src/components/rewards/CouponsScreen.tsx');
  assert.ok(screen.indexOf('<PrintersBlock') < screen.indexOf('<CouponCard'), 'above the coupons');
  assert.match(screen, /t\('coupon\.fromPrinterNamed', \{ name: .*week: formatFigure\(c\.printer\.week \+ 1, lang\) \}\)/, 'the week counts from 1');
  assert.match(src('src/pages/RewardsArea.tsx'), /useRewardPrinters\(authed && section === 'coupons'\)/);
});

const printersRead = (printers: RewardPrintersData['printers']): Read<RewardPrintersData> => ({
  status: 'ready',
  data: { installed: true, server_time: '2026-11-05T00:00:00.000Z', printers },
  error: null,
  stale: false,
  skewMs: 0,
  reload: async () => {},
  invalidate: () => {},
});
const printer = (over: Partial<RewardPrintersData['printers'][number]>): RewardPrintersData['printers'][number] => ({
  order_item_id: 'oi',
  unit_index: 1,
  product_slug: 'a1',
  name: { ar: 'طابعة', en: 'A1 mini', ckb: 'چاپکەر' },
  image: '',
  delivered_at: '2026-10-01T00:00:00.000Z',
  warranty_start_at: '2026-10-01T00:00:00.000Z',
  earning: true,
  stopped: null,
  week: 4,
  weeks_total: 53,
  next_at: '2026-11-12T00:00:00.000Z',
  ends_at: '2027-10-01T00:00:00.000Z',
  this_week: [],
  ...over,
});

test('«طابعاتك»: until when and the next coupons, or why it stopped; folded past three; nothing with no printer', () => {
  const html = render(createElement(PrintersBlock, { read: printersRead([printer({}), printer({ unit_index: 2, earning: false, stopped: 'traded_in', next_at: null })]) }));
  assert.match(html, /طابعاتك/);
  assert.match(html, /تكسب كوبونات حتى/);
  assert.match(html, /الدفعة القادمة/);
  assert.match(html, /توقفت كوبوناتها: استُبدلت الطابعة/);
  assert.doesNotMatch(html, /عرض الكل/);

  const four = render(createElement(PrintersBlock, { read: printersRead([1, 2, 3, 4].map((u) => printer({ unit_index: u }))) }));
  assert.match(four, /عرض الكل/);
  assert.equal(four.split('data-rewards-printer="earning"').length - 1, 3, 'folded to three');

  assert.equal(render(createElement(PrintersBlock, { read: printersRead([]) })), '');
});

test('the hub’s tile says weekly plainly while weekly is on, on a live-like hub with printers and no coupon', () => {
  const hub = (weekly: { enabled: boolean; months: number } | undefined) =>
    ({
      installed: true,
      server_time: '2026-11-05T00:00:00.000Z',
      point_balance: 0,
      pending_points: { points: 0, next_available_at: null },
      program: { enabled: true, valid_days: 7, weekly, free_shipping: { enabled: true }, filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, products: [], section: null } },
      coupons: [],
      coupon_counts: { active: 0, past: 2 },
      printers: [{ order_id: 'o', product_id: 'p', slug: 'a1', name: { ar: 'a', en: 'a', ckb: 'a' }, image: '', delivered_at: null, state: 'rated', stars: 5, reward_level: null }],
      rating: { gift_levels: [], review_points: null },
      shop: [],
      competitions: [],
    }) as unknown as RewardsHubData;
  const line = (h: RewardsHubData | null, lang: Lang) => doorText(doorLines(h).coupons.lines[0], lang, '2026-11-05T00:00:00.000Z');
  assert.equal(line(hub({ enabled: true, months: 12 }), 'ar'), 'تصلك كل أسبوع مع كل طابعة تستلمها من Levonis');
  assert.match(line(hub({ enabled: true, months: 12 }), 'en'), /every week/);
  assert.match(line(hub({ enabled: true, months: 12 }), 'ckb'), /هەموو هەفتەیەک/);
  assert.equal(line(hub({ enabled: false, months: 12 }), 'ar'), 'تصلك مع كل طابعة تستلمها من Levonis', 'the old line only while the weeks are off');
  assert.equal(line(null, 'ar'), 'تصلك كل أسبوع مع كل طابعة تستلمها من Levonis', 'and with no answer to read, the owner’s programme');
});

// ------------------------------------------------------------ the admin

test('the admin’s tabs, in the owner’s order, overview first, and no native prompt left', () => {
  const page = src('src/components/adminRewards/AdminRewards.tsx');
  const order = ['overview', 'printers', 'coupons', 'competitions', 'settings'].map((id) => page.indexOf(`{ id: '${id}', label:`));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), JSON.stringify(order));
  assert.match(page, /useState<RewardsView>\('overview'\)/);
  assert.match(page, /تصدر كل أسبوع لكل طابعة تحت الضمان/);
  for (const file of ['AdminRewards.tsx', 'RewardsCoupons.tsx', 'RewardsPrinters.tsx', 'RewardsOverview.tsx']) {
    assert.doesNotMatch(src(`src/components/adminRewards/${file}`), /window\.(prompt|confirm|alert)/, file);
  }
  const coupons = src('src/components/adminRewards/RewardsCoupons.tsx');
  assert.match(coupons, /usePrompt\(\)/);
  assert.match(coupons, /newIdempotencyKey\(\)/, 'one key per opening of the dialog');
  assert.match(coupons, /\/api\/gifts\/admin\/users\?q=/, 'the lookup the gifts’ grant sheet uses');
  assert.match(coupons, /\/admin\?tab=orders&order=/);
  const printers = src('src/components/adminRewards/RewardsPrinters.tsx');
  assert.match(printers, /\/admin\?tab=orders&order=/);
  assert.match(printers, /order_item_id=\$\{encodeURIComponent\(id\)\}&unit_index=\$\{unit\}/);
  assert.match(src('src/components/adminRewards/RewardsOverview.tsx'), /href="\/admin\?tab=reviews"/);
  assert.match(src('src/pages/Admin.tsx'), /DEEP_LINK_TABS[^;]*'reviews'/, 'the link has somewhere to land');
});

test('the settings’ one line sums the fields on screen, in three languages', () => {
  const cfg = {
    enabled: true,
    valid_days: 7,
    weekly: { enabled: true, months: 12 },
    free_shipping: { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 },
    filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, product_ids: [], max_pieces: 1 },
  };
  const money = (n: number) => n.toLocaleString('en-US');
  const ar = weeklyEarnSummary(cfg, 'ar', money);
  assert.match(ar, /كل طابعة تكسب كل أسبوع/);
  assert.match(ar, /5,000/);
  assert.match(ar, /100,000/);
  assert.match(ar, /15%/);
  assert.match(ar, /25,000/);
  assert.match(ar, /قطعة واحدة/);
  const ckb = weeklyEarnSummary(cfg, 'ckb', money);
  assert.notEqual(ckb, ar);
  assert.match(ckb, /هەموو هەفتەیەک/);
  assert.doesNotMatch(ckb.replace(/[\d,%]/g, ''), ARABIC_ONLY);
  assert.match(weeklyEarnSummary(cfg, 'en', money), /Each printer earns every week/);

  assert.match(weeklyEarnSummary({ ...cfg, weekly: { enabled: false, months: 12 } }, 'ar', money), /عند تسليمها فقط/);
  assert.match(weeklyEarnSummary({ ...cfg, enabled: false }, 'ar', money), /لا تصدر كوبونات/);
  assert.doesNotMatch(weeklyEarnSummary({ ...cfg, free_shipping: { ...cfg.free_shipping, enabled: false } }, 'ar', money), /توصيل/);
  assert.match(weeklyEarnSummary({ ...cfg, filament: { ...cfg.filament, enabled: false } }, 'ar', money), /توصيل/);
  assert.match(weeklyEarnSummary({ ...cfg, filament: { ...cfg.filament, max_pieces: 3 } }, 'ar', money), /3 قطع/);
});

// ------------------------------------------------------------ what the page must not promise

test('a coupon kept off by an offer says so, with no link back to the same product', () => {
  const html = card(read([filament({ state: 'on_offer' })], null), 'none');
  assert.match(html, /data-cart-coupon-row="on_offer"/);
  assert.match(html, /لا يعمل على قطعة عليها عرض/);
  assert.doesNotMatch(html, /تصفّح الفلامنت/);
  assert.match(card(read([filament({ state: 'on_offer' })], null), 'none', 'en'), /Does not work on a piece with an offer/);
  assert.match(card(read([filament({ state: 'on_offer' })], null), 'none', 'ckb'), /ئۆفەری لەسەرە/);
});

test('a coupon that would save nothing: a muted row that says why, no figure and no button', () => {
  const html = card(read([filament({ state: 'no_gain' })], null), 'none');
  assert.match(html, /data-cart-coupon-row="no_gain"/);
  assert.match(html, /يعيد أجرة التوصيل/);
  assert.doesNotMatch(html, /data-cart-coupons-apply/);
  assert.doesNotMatch(html, /−/, 'it takes nothing here');
});

test('the button says what the customer saves, not what the coupons take, and the card says where the rest went', () => {
  const r = read(
    [filament({ take_iqd: 3_600, lines: [{ line_id: 'l1', amount_iqd: 3_600 }] }), filament({ code: 'RWF2', take_iqd: 3_600, lines: [{ line_id: 'l1', amount_iqd: 3_600 }] })],
    { code: 'RWF1', count: 2, merchandise_iqd: 7_200, total_iqd: 7_200, fee_back_iqd: 5_000, net_iqd: 2_200 }
  );
  const html = card(r, 'none');
  const button = /data-cart-coupons-apply[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1] ?? '';
  assert.match(button, /2,200/, 'the saving');
  assert.doesNotMatch(button, /7,200/);
  assert.match(html, /data-cart-coupons-fee-back/);
  assert.match(html, /تعود أجرة التوصيل \(5,000/);
  assert.match(html, /data-cart-coupons-estimate/, 'and it is an estimate');
  assert.doesNotMatch(card(read([filament({ take_iqd: 3_600 })], { merchandise_iqd: 3_600, total_iqd: 3_600, net_iqd: 3_600, fee_back_iqd: 0 }), 'none'), /data-cart-coupons-fee-back/);
});

test('an older server sends no net: the button falls back to what it takes', () => {
  assert.equal(previewSaving({ total_iqd: 900 }), 900);
  assert.equal(previewSaving({ total_iqd: 900, net_iqd: 100 }), 100);
});

test('a ticked line that re-prices on cash: the goods figure is an estimate too, and the note says so', () => {
  const r = read([filament({ take_iqd: 2_700 })], { merchandise_iqd: 2_700, total_iqd: 2_700 });
  assert.doesNotMatch(card(r, 'none'), /data-cart-coupons-estimate/, 'no fee and no pre-order: nothing to qualify');
  const html = render(createElement(CartCoupons, { read: r, mode: 'none', promoCode: '', lineName: () => 'eSUN', repricesAtCheckout: true, onApply: () => {}, onRemove: () => {} }));
  assert.match(html, /data-cart-coupons-estimate/);
  assert.match(src('src/pages/Cart.tsx'), /repricesAtCheckout=\{selectedItems\.some\(\(i\) => i\.cod_reprices === true\)\}/, 'the server’s own flag');
});

test('a wrong code typed while the coupons are applied takes nothing away, and stays on screen', () => {
  const box = src('src/components/PromoCodeField.tsx');
  assert.match(box, /setApplied\(null\);\s*if \(!holdOnRefusal\) \{\s*storePromo\(''\);\s*onApplied\?\.\(''\);\s*\}/, 'the refusal touches neither the store nor the page');
  assert.match(src('src/pages/Cart.tsx'), /holdOnRefusal=\{coupons\.holdsPool\}/);
  const file = src('src/components/rewards/CartCoupons.tsx');
  assert.match(file, /holdsPool: poolAsked,/, 'for as long as the customer asked for the pool');
  assert.match(file, /boxKey: poolAsked \? 'pool' : `box-\$\{boxTurn\}`/, 'the box is not remounted by a refusal: nothing it holds changes');
  // The checkout has no such thing in force: its box behaves as it always did.
  assert.doesNotMatch(src('src/pages/Checkout.tsx'), /holdOnRefusal/);
});

test('a coupon on the lines lowers what the free-delivery line is tested on, so the member line tells the truth', () => {
  const page = src('src/pages/Cart.tsx');
  const basis = page.slice(page.indexOf('const deliveryBasis = Math.max('), page.indexOf('FREE DELIVERY — ONLY WHAT'));
  assert.match(basis, /memberOffTheOrder -[\s\S]{0,200}?couponGoods/);
});

test('out of re-checks: the last accepted figures stay rather than leaving the cart without a word', () => {
  assert.equal(isRateLimited(new ApiError(429, 'slow down', 'RATE_LIMITED')), true);
  assert.equal(isRateLimited(new ApiError(500, 'broken')), false);
  assert.equal(isRateLimited(new Error('network')), false);
  assert.match(src('src/components/rewards/CartCoupons.tsx'), /if \(ac\.signal\.aborted \|\| isAborted\(e\) \|\| isRateLimited\(e\)\) return;\s*setPromo\(null\);/);
});

test('the checkout’s row promises the quote’s own difference, and only when the order comes out cheaper', () => {
  assert.equal(cartCouponsPath(['a'], 5_000, true), '/api/cart/reward-coupons?item_ids=a&delivery_iqd=5000&delivery_final=1');
  assert.equal(cartCouponsPath(['a'], 5_000, false, 3_000), '/api/cart/reward-coupons?item_ids=a&delivery_iqd=5000&points_iqd=3000', 'the points the customer switched on');
  assert.match(src('src/pages/Cart.tsx'), /pointsIqd: usePoints \? pointBalance : 0,/);
  const file = src('src/components/rewards/CartCoupons.tsx');
  const row = file.slice(file.indexOf('export function CheckoutCouponsRow'));
  assert.match(row, /cartCouponsPath\(itemIds, deliveryIqd, true\)/, 'a quote’s fee has every waiver in it');
  assert.match(row, /const saved = plainTotalIqd - quoted\.total_iqd;\s*setOffer\(saved > 0 \?/);
  assert.match(row, /offer\.asked !== asked\) return null/, 'an answer about another order stops showing');
  const page = src('src/pages/Checkout.tsx');
  assert.match(page, /const quoteWithCoupon = async \(code: string, signal: AbortSignal\)/);
  assert.match(page, /couponCode: code,\s*\},\s*\{ signal, mascot: 'silent' \}/, 'asked aside, silently');
  const asked = page.slice(page.indexOf('const quoteWithCoupon'), page.indexOf('const isPrepaidMethod'));
  for (const field of ['addressId', 'deliveryMethodId', 'paymentMethodId', 'itemIds', 'usePoints', 'useWallet', 'protectedDelivery', 'supportCode', 'couponCode']) assert.match(asked, new RegExp(field), `the page’s own question: ${field}`);
  assert.doesNotMatch(asked.slice(0, asked.indexOf('const applyCouponCode')), /customerQuote|setQuote\(/, 'and it moves nothing on the page');
});

test('the shop’s real names: no doubled word in any line, and two lines rather than a cut', () => {
  const coupons = src('src/components/adminRewards/RewardsCoupons.tsx');
  assert.doesNotMatch(coupons, /طابعة \$\{shown\}|Printer \$\{shown\}|چاپکەری \$\{shown\}/, 'the admin’s source line');
  assert.match(coupons, /\$\{shown\} · الأسبوع \$\{week\}/);
  const printers = src('src/components/adminRewards/RewardsPrinters.tsx');
  assert.doesNotMatch(printers, /كوبونات الطابعة \$\{/, 'nor the row’s label');
  assert.match(printers, /line-clamp-2 text-\[16px\]/, 'the sheet’s title');
  // The customer's own printer row prints the whole name, more than the two lines this asked for: two models differ at their end (integration run).
  assert.doesNotMatch(src('src/components/rewards/PrintersBlock.tsx'), /line-clamp/);
  for (const key of ['ar', 'en', 'ckb'] as const) {
    assert.doesNotMatch(copyText('coupon.fromPrinterNamed', key, { name: 'N', week: 1 }), /طابعتك|your printer|چاپکەرەکەت/);
  }
});

test('a printer’s sheet pages like the coupons tab: past fifty, one more press', () => {
  const printers = src('src/components/adminRewards/RewardsPrinters.tsx');
  const sheet = printers.slice(printers.indexOf('function PrinterCouponsDialog'));
  assert.match(sheet, /next_cursor/);
  assert.match(sheet, /&cursor=\$\{encodeURIComponent\(cursor\)\}/);
  assert.match(sheet, /data-printer-coupons-more/);
  assert.match(sheet, /setRows\(\(prev\) => \[\.\.\.\(prev \?\? \[\]\), \.\.\.r\.grants\]\)/, 'added to what is there');
});

test('the grant dialog: a field put right stops saying what was wrong with it', () => {
  const file = src('src/components/adminRewards/RewardsCoupons.tsx');
  assert.match(file, /const corrected = \(field: 'user' \| 'days' \| 'reason'\) =>/);
  for (const change of [/setUser\(u\); corrected\('user'\);/, /setQuery\(e\.target\.value\); corrected\('user'\);/, /setDays\(e\.target\.value\); corrected\('days'\);/, /setReason\(e\.target\.value\); corrected\('reason'\);/]) {
    assert.match(file, change);
  }
});

test('an assistant’s refused save is worded in the reader’s language, like every refusal of this tab', () => {
  const file = src('src/components/adminRewards/AdminRewards.tsx');
  assert.match(file, /const refusal = useRewardsRefusal\(\);/);
  const save = file.slice(file.indexOf('const save = async'), file.indexOf('const issued ='));
  assert.match(save, /: refusal\(err\)/);
  assert.doesNotMatch(save, /err instanceof Error \? err\.message/);
});

test('the owner’s switch: on the settings beside the percentage, in three languages, with the filaments it holds named', () => {
  const file = src('src/components/adminRewards/AdminRewards.tsx');
  assert.match(file, /data-rewards-filament-on-offer/);
  assert.match(file, /data-rewards-filament-offer-warning/);
  assert.match(file, /يعمل أيضًا على القطع التي عليها عرض/);
  assert.match(file, /Also works on items with an offer/);
  assert.match(file, /لەسەر ئەو پارچانەش کار دەکات کە ئۆفەریان لەسەرە/);
  const overview = src('src/components/adminRewards/RewardsOverview.tsx');
  assert.match(overview, /data-attention="filament-offer"/);
  assert.match(src('src/components/rewards/CouponsScreen.tsx'), /c\.on_offer \? 'coupon\.ruleOnOffer' : 'coupon\.ruleNoOffer'/, 'and the customer’s card says the coupon’s own term');
  const [ar, en, ckb] = COPY['coupon.ruleOnOffer'];
  assert.ok(ar && en && ckb);
  assert.notEqual(ckb, ar);
  assert.doesNotMatch(ckb, ARABIC_ONLY);
});

test('the settings tab’s product row uses the tab’s own checkbox, not the product editor’s violet switch', () => {
  const file = src('src/components/adminRewards/RewardsShopProducts.tsx');
  assert.doesNotMatch(file, /<Toggle|formUi/);
  assert.match(file, /data-admin-shop-on-sale/);
});

test('a typed code in force: the page offers only the better of the two, and never promises a saving it would take back', () => {
  const r = read([coupon({ take_iqd: 5_000 })], { total_iqd: 5_000, delivery_iqd: 5_000 });
  const with_ = (promoSaving: number) => render(createElement(CartCoupons, { read: r, mode: 'promo', promoCode: 'PROMO10', promoSaving, lineName: () => 'eSUN PLA+', onApply: () => {}, onRemove: () => {} }), 'ar');
  const codeBetter = with_(74_400);
  assert.doesNotMatch(codeBetter, /data-cart-coupons-apply/, 'pressing would cost the customer money');
  assert.match(codeBetter, /لا تجتمع معه/);
  const couponsBetter = with_(1_000);
  assert.match(couponsBetter, /data-cart-coupons-apply/);
  assert.match(couponsBetter, /توفّر أكثر من هذا الكود/);
  assert.doesNotMatch(couponsBetter, /· وفّر/, 'the press replaces the code: the figure would not be what it saves');
});
