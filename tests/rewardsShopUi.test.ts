/**
 * THE POINTS SHOP'S PRODUCTS ON THE SCREEN (DECISIONS row 299): what the door says, that the
 * screen decides nothing and reads no figure of its own, that «هداياي» and the shop add a gift
 * through one door, and that every word exists in three languages, the Sorani its own.
 *
 * The flows themselves were driven in a real browser over a stubbed API (the PNGs of the
 * lane); the money is proved through the real routers in tests/rewardsShopItems.test.ts.
 *
 * Run: node --import tsx --test tests/rewardsShopUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { COPY, copyText, countText, pointsForm, POINTS_OBJ_KEYS, type CopyKey } from '../src/components/rewards/copy';
import { doorLines, doorText } from '../src/components/rewards/model';
import type { RewardsHubData, ShopItem, ShopProductItem } from '../src/components/rewards/types';
import { giftText } from '../src/components/reviews/gifts/giftStrings';
import { adminText } from '../src/components/adminGifts/strings';
import { formatFigure } from '../src/lib/localeNumber';
import { MAX_SHOP_ROWS, shopProductRefusal, shopRowWarning } from '../src/components/adminRewards/shopProductWords';
import { MAX_SHOP_PRODUCTS } from '../worker/lib/rewards/config';

const src = (file: string) => readFileSync(file, 'utf8');
const SHOP = 'src/components/rewards/ShopScreen.tsx';
const PRODUCTS = 'src/components/rewards/ShopProducts.tsx';
const DOOR = 'src/components/reviews/gifts/useGiftCartAdd.tsx';
const GIFTS = 'src/components/reviews/MyGifts.tsx';
const ADMIN = 'src/components/adminRewards/RewardsShopProducts.tsx';

const product = (id: string, points: number, over: Partial<ShopProductItem> = {}): ShopProductItem => ({
  id,
  points,
  affordable: true,
  points_short: 0,
  holding: false,
  available: true,
  product: { id: 'p', slug: 'p', name: { ar: 'م', en: 'P', ckb: 'پ' }, image: '', option: null, color: null },
  ...over,
});
const coupon = (points: number): ShopItem => ({ kind: 'free_shipping', points, affordable: true });
const hub = (shop: ShopItem[], items?: ShopProductItem[]) => ({ shop, shop_items: items, coupons: [], printers: [], competitions: [], server_time: '2026-11-06T00:00:00.000Z' }) as unknown as RewardsHubData;

// ------------------------------------------------------------------ the door

test('the shop’s door reads right whatever is on sale: coupons, products, both, or nothing', () => {
  const line = (h: RewardsHubData) => doorLines(h).shop.lines;
  assert.deepEqual(line(hub([], [])), [{ key: 'door.shop.checkout' }]);
  assert.deepEqual(line(hub([])), [{ key: 'door.shop.checkout' }], 'an older server sends no products');
  assert.deepEqual(line(hub([coupon(3_000)], [])), [{ key: 'door.shop.from', points: 3_000 }], 'as before');
  assert.deepEqual(line(hub([], [product('a', 23_100), product('b', 23_000)])), [{ key: 'door.shop.fromProducts', points: 23_000 }], 'no word of a coupon when only products are on sale');
  assert.deepEqual(line(hub([coupon(3_000)], [product('a', 23_000)])), [{ key: 'door.shop.fromBoth', points: 3_000 }]);
  assert.deepEqual(line(hub([coupon(30_000)], [product('a', 23_000)])), [{ key: 'door.shop.fromBoth', points: 23_000 }], 'the cheapest of both');
  assert.deepEqual(line(hub([], [product('a', 23_000, { available: false })])), [{ key: 'door.shop.checkout' }], 'an empty shelf is not what the door promises');
  assert.deepEqual(line(hub([coupon(3_000)], [product('a', 2, { available: false })])), [{ key: 'door.shop.from', points: 3_000 }]);
  assert.equal(doorLines(hub([], [product('a', 23_000)])).shop.badge, 0, 'and it draws no badge');
});

test('the door’s words in three languages, with the oblique dual after «من»', () => {
  const at = '2026-11-06T00:00:00.000Z';
  const say = (key: 'door.shop.fromBoth' | 'door.shop.fromProducts', points: number, lang: 'ar' | 'en' | 'ckb') => doorText({ key, points }, lang, at);
  assert.equal(say('door.shop.fromProducts', 2, 'ar'), 'منتجات تبدأ من نقطتين');
  assert.equal(say('door.shop.fromBoth', 2, 'ar'), 'كوبونات ومنتجات تبدأ من نقطتين');
  assert.match(say('door.shop.fromProducts', 23_000, 'ar'), /^منتجات تبدأ من .*23.000 نقطة$/u);
  assert.match(say('door.shop.fromProducts', 23_000, 'en'), /^Products from 23,000 points$/);
  assert.match(say('door.shop.fromBoth', 3_000, 'en'), /^Coupons and products from 3,000 points$/);
  assert.match(say('door.shop.fromProducts', 23_000, 'ckb'), /^بەرهەم لە .*خاڵەوە$/u);
  assert.equal(pointsForm('shop.product.confirm.title'), 'pointsObj');
  assert.ok(POINTS_OBJ_KEYS.has('door.shop.fromBoth') && POINTS_OBJ_KEYS.has('door.shop.fromProducts'));
});

// ------------------------------------------------------------------ the words the owner asked for

test('the confirmation states the price and «تدفع أجرة التوصيل فقط», in three languages', () => {
  const points = countText('pointsObj', 23_000, 'ar');
  assert.ok(copyText('shop.product.confirm.title', 'ar', { points }).includes(points));
  assert.ok(copyText('shop.product.confirm.body', 'ar', { item: 'X' }).includes('تدفع أجرة التوصيل فقط'));
  assert.ok(copyText('shop.product.confirm.body', 'en', { item: 'X' }).includes('You pay for delivery only'));
  assert.ok(copyText('shop.product.confirm.body', 'ckb', { item: 'X' }).includes('تەنها کرێی گەیاندن دەدەیت'));
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.ok(copyText('shop.product.confirm.body', lang, { item: 'eSUN' }).startsWith('eSUN'), 'it names the product');
    assert.ok(/(أجرة التوصيل|delivery|گەیاندن)/.test(copyText('shop.products.lead', lang)), lang);
    assert.ok(/(أجرة التوصيل|delivery|گەیاندن)/.test(copyText('shop.product.done', lang, { item: 'X' })), lang);
    assert.ok(/(أجرة التوصيل|delivery|گەیاندن)/.test(copyText('shop.product.added', lang)), lang);
  }
});

test('every new word is its own in Sorani: the customer’s, the gift card’s, the admin’s', () => {
  const keys = (Object.keys(COPY) as CopyKey[]).filter((k) => k.startsWith('shop.product') || k.startsWith('door.shop.from'));
  assert.ok(keys.length >= 12, `${keys.length}`);
  for (const k of keys) {
    const [ar, en, ckb] = COPY[k];
    assert.ok(ar && en && ckb, k);
    assert.notEqual(ckb, ar, k);
    assert.notEqual(ckb, en, k);
  }
  for (const [ar, en, ckb] of [
    [giftText('ar', 'reasonShop', { points: '1' }), giftText('en', 'reasonShop', { points: '1' }), giftText('ckb', 'reasonShop', { points: '1' })],
    [giftText('ar', 'reasonShopBack', { points: '1' }), giftText('en', 'reasonShopBack', { points: '1' }), giftText('ckb', 'reasonShopBack', { points: '1' })],
    [adminText('ar', 'cancelPointsBack', { points: 1 }), adminText('en', 'cancelPointsBack', { points: 1 }), adminText('ckb', 'cancelPointsBack', { points: 1 })],
    [adminText('ar', 'shopPaid', { points: 1 }), adminText('en', 'shopPaid', { points: 1 }), adminText('ckb', 'shopPaid', { points: 1 })],
    [adminText('ar', 'shopReturned'), adminText('en', 'shopReturned'), adminText('ckb', 'shopReturned')],
    [adminText('ar', 'shopFact'), adminText('en', 'shopFact'), adminText('ckb', 'shopFact')],
  ]) {
    assert.ok(ar && en && ckb);
    assert.notEqual(ckb, ar);
    assert.notEqual(ckb, en);
  }
});

test('the admin screen words every refusal PUT /config can send, in three languages, and never the bare code', () => {
  const pick = (i: number) => (ar: string, en: string, ckb: string) => [ar, en, ckb][i];
  const codes = [
    'REWARD_SHOP_PRICE_REQUIRED',
    'REWARD_SHOP_ITEM_INVALID',
    'REWARD_SHOP_ITEM_DUPLICATE',
    'REWARD_SHOP_ITEMS_TOO_MANY',
    // What `checkGiftSelection(…, { requireSellable: false })` can answer.
    'GIFT_PRODUCT_NOT_FOUND',
    'GIFT_PRODUCT_INACTIVE',
    'GIFT_COMPOSITION_UNSUPPORTED',
    'GIFT_SALE_TYPE_UNAVAILABLE',
    'GIFT_TRANSPORT_REQUIRED',
    'GIFT_SELECTION_INVALID',
    'GIFT_QTY_INVALID',
    'GIFT_PRICE_ESTIMATE',
  ];
  for (const code of codes) {
    const [ar, en, ckb] = [0, 1, 2].map((i) => shopProductRefusal(code, pick(i)));
    assert.ok(ar && en && ckb, code);
    assert.notEqual(ckb, ar, code);
    assert.notEqual(ckb, en, code);
    for (const said of [ar, en, ckb]) assert.ok(!said!.includes(code), code);
  }
  assert.equal(shopProductRefusal('OWNER_REQUIRED', pick(0)), null, 'a code that is not about the products keeps its own words');
  assert.match(shopRowWarning('OUT_OF_STOCK', pick(1)), /Out of stock/);
  assert.equal(MAX_SHOP_ROWS, MAX_SHOP_PRODUCTS, 'the screen’s limit is the server’s');
});

// ------------------------------------------------------------------ the screen decides nothing

test('the row is drawn from the server’s fields alone, and the swap sends no body', () => {
  const page = src(PRODUCTS);
  assert.match(page, /api\.post<[^>]*>\(`\/api\/rewards\/program\/shop\/items\/\$\{encodeURIComponent\(item\.id\)\}`\)/, 'the id is the path, and nothing else travels');
  assert.match(page, /const held = item\.holding;/);
  assert.match(page, /const off = !held && !item\.available;/);
  assert.match(page, /const short = !held && !off && !item\.affordable;/);
  assert.match(page, /disabled=\{held \|\| off \|\| short\}/);
  assert.match(page, /count\('pointsShort', item\.points_short\)/, 'what is short is the server’s figure');
  assert.doesNotMatch(page, /point_balance|pointBalance|balance\s*[-<>]/, 'the page never sums points itself');
  assert.doesNotMatch(page, /cost/i, 'no cost on this screen');
  assert.match(page, /testId="shop-product-confirm"/);
  assert.match(page, /error=\{refusal \? t\(refusal\) : undefined\}/, 'a refusal stays in the dialog, in words');
  assert.match(page, /\/gifts/, 'and «هداياي» is where the gift waits');
});

test('the shop screen keeps its coupons and adds the products, and shows the empty state only when nothing at all is on sale', () => {
  const page = src(SHOP);
  assert.match(page, /shop\.length === 0 && products\.length === 0 \? \(\s*<EmptyState/);
  assert.match(page, /products\.length > 0 && <ShopProducts items=\{products\} reload=\{reload\} onSwapped=\{onSwapped\} \/>/);
  assert.match(page, /shop\.length > 0 && <p className="[^"]*">\{t\('shop\.oneEach'\)\}<\/p>/, 'the coupons’ note only with coupons');
});

test('one door adds a gift to the cart: «هداياي» and the shop share it, conflicts and all, and no copy of it is left', () => {
  const door = src(DOOR);
  assert.match(door, /api\.post\('\/api\/cart\/gift-items', replaceCart \? \{ giftId, replaceCart: true \} : \{ giftId \}\)/, 'nothing but the gift travels');
  assert.match(door, /CART_SHIPPING_CONFLICT/);
  assert.match(door, /CART_SELLER_CONFLICT/);
  assert.match(door, /gift-seller-conflict/);
  assert.match(door, /gift-shipping-conflict/);
  for (const file of [GIFTS, PRODUCTS]) {
    const page = src(file);
    assert.match(page, /useGiftCartAdd\(/, file);
    assert.doesNotMatch(page, /\/api\/cart\/gift-items['"`]/, `${file} posts the gift itself`);
    assert.doesNotMatch(page, /CART_SHIPPING_CONFLICT/, `${file} handles the conflict itself`);
  }
  assert.match(src(GIFTS), /\{cart\.dialog\}/);
  assert.match(src(PRODUCTS), /\{cart\.dialog\}/);
});

test('a colour dot draws its ring with a colour that exists, so a black dot shows on a dark card and a white one on a light card', () => {
  for (const file of [PRODUCTS, ADMIN]) assert.match(src(file), /rounded-full border border-text-muted\/70/, file);
});

test('the gift card says what was paid, and a cancelled one says it came back', () => {
  const card = src('src/components/reviews/gifts/GiftCard.tsx');
  assert.match(card, /status === 'CANCELLED' \? 'reasonShopBack' : 'reasonShop'/);
  assert.match(card, /gift\.points_spent && gift\.points_spent > 0/, 'an older server sends no figure, and the card keeps its old line');
});

test('the points history names the new movements in three languages, before the coupon’s words can claim them', () => {
  const page = src('src/pages/Rewards.tsx');
  const product = page.indexOf('/^Points shop product/');
  const refund = page.indexOf('/^Points shop refund/');
  const coupon = page.indexOf('/^Points shop/.test');
  assert.ok(product > 0 && refund > 0 && coupon > 0);
  assert.ok(product < coupon && refund < coupon, 'the general rule comes last');
  assert.match(src('worker/lib/rewards/shopItems.ts'), /`Points shop product: /, 'the server writes the note the page reads');
  assert.match(src('worker/lib/rewards/shopItems.ts'), /'Points shop refund: gift cancelled'/);
});

// ------------------------------------------------------------------ the admin's rows

test('the admin rows use the gift editor’s own pieces, in a lazy chunk, and leave the judgement to the server', () => {
  const rows = src(ADMIN);
  assert.match(rows, /import ItemFields, \{ blankItem \} from '\.\.\/adminGifts\/ItemFields';/);
  assert.match(rows, /<ItemFields lang=\{l\} value=\{inputOf\(row\)\}/);
  assert.match(rows, /import '\.\.\/adminProducts\/theme\.css';/, 'its controls need their own stylesheet');
  assert.doesNotMatch(rows, /window\.(prompt|confirm|alert)/);
  assert.match(rows, /countText\('swappedTimes', view\.swapped, l\)/, 'how many times is a counted sentence, not «3 مرة»');
  assert.equal(countText('swappedTimes', 3, 'ar'), `استُبدل ${formatFigure(3, 'ar')} مرات`);
  assert.equal(countText('swappedTimes', 1, 'en'), 'Swapped once');
  const page = src('src/components/adminRewards/AdminRewards.tsx');
  assert.match(page, /lazy\(\(\) => import\('\.\/RewardsShopProducts'\)\)/);
  assert.doesNotMatch(page, /from '\.\/RewardsShopProducts'/, 'a static import would pull the editor and its stylesheet into every reader of this file');
  assert.match(page, /shopProductRefusal\(code, loc\)/, 'a refusal is worded, and');
  assert.match(page, /err\.details\?\.item_index/, 'it names the row');
  assert.ok(existsSync('src/components/adminRewards/shopProductWords.ts'));
  assert.ok(page.indexOf('role="alert"') > page.indexOf('<RewardsShopProducts'), 'what a save answered stands beside the button that saved, not a phone’s length above it');
});
