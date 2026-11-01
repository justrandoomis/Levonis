/**
 * THE SUPPLIER PRICE FILE, levonis.supplier-prices.v1 (docs/SMART_PRICING.md
 * §3.2): the one strict parser every capture passes through.
 *
 *   - the real captures of 2026-10-31 parse: Tmall (CNY, prices as captured,
 *     优惠前 a label and never a figure) and the EU store (EUR, item_key = the
 *     store handle, sku_key = the JSON-LD variant id — 18 and 14 digits —,
 *     JSON-number prices with two decimals);
 *   - unknown keys are refused by name at every level; missing keys by name;
 *   - floats are refused (0.30000000000000004, 19.999, 1e21, unsafe integers);
 *     decimal text is kept exactly as captured; bad decimal text is refused;
 *   - the source pairs with its currency, and an item's url and page_host are
 *     the source's own host (an EU page served by the US store is refused);
 *   - ids follow the source's grammar; the caps (20,000 items, 200 SKUs per
 *     item, 200,000 SKUs, every column's length) hold; no duplicate item key
 *     and no duplicate SKU key in an item;
 *   - the error names its path and reason, in a trilingual sentence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOURCE_CURRENCY,
  SUPPLIER_PRICE_FORMAT,
  SUPPLIER_PRICE_FORMAT_MESSAGE,
  SUPPLIER_PRICE_LIMITS,
  SupplierPriceFormatError,
  isSupplierPriceText,
  parseSnapshotHeader,
  parseSupplierPriceFile,
  parseSupplierPriceItems,
  skuCountOf,
  supplierPriceText,
  type SupplierPriceFormatReason,
} from '../packages/catalog/src/supplierPrices/format';
import { euFile, euRecords, fixtureText, tmallFile, tmallRecords } from './fixtures/supplierPrices/load';

type Json = Record<string, unknown>;

const sku = (over: Json = {}): Json => ({ sku_key: '6264995743059', options: { 商品规格: '手捻钻钻头套装（1套）' }, price: '40', price_label: '优惠前', quantity: 59, ...over });
const item = (over: Json = {}): Json => ({ item_key: '1053109777521', url: 'https://detail.tmall.com/item.htm?id=1053109777521', page_host: 'detail.tmall.com', title: '拓竹 手捻钻 创客宝库-ZH121', skus: [sku()], ...over });
const file = (over: Json = {}): Json => ({
  format: SUPPLIER_PRICE_FORMAT,
  source: 'tmall_cn',
  currency: 'CNY',
  price_basis: 'list',
  capture: 'browser_sweep',
  captured_on: '2026-10-31',
  captured_by: 'browser sweep',
  items: [item()],
  ...over,
});
const euItem = (over: Json = {}): Json => ({
  item_key: 'filament-buffer',
  url: 'https://eu.store.bambulab.com/products/filament-buffer',
  page_host: 'eu.store.bambulab.com',
  title: 'Filament Buffer',
  skus: [{ sku_key: '43719762903259', options: { option1: 'X1 Series and P1 Series' }, price: 27.99 }],
  ...over,
});
const euWith = (over: Json = {}, it: Json = {}): Json => file({ source: 'bambu_eu', currency: 'EUR', items: [euItem(it)], ...over });

function refused(value: unknown, path: string, reason: SupplierPriceFormatReason): void {
  assert.throws(
    () => parseSupplierPriceFile(value),
    (e: unknown) => {
      assert.ok(e instanceof SupplierPriceFormatError, `a SupplierPriceFormatError, got ${String(e)}`);
      assert.equal(e.path, path);
      assert.equal(e.reason, reason);
      return true;
    }
  );
}

test('the real Tmall capture parses: ids, prices and labels exactly as captured', () => {
  const parsed = tmallFile();
  const raw = tmallRecords();
  assert.equal(parsed.source, 'tmall_cn');
  assert.equal(parsed.currency, 'CNY');
  assert.equal(parsed.items.length, raw.length);
  assert.equal(skuCountOf(parsed.items), raw.reduce((n, r) => n + r.skus.length, 0));
  for (const r of raw) {
    const it = parsed.items.find((i) => i.item_key === r.item_id)!;
    assert.ok(it, r.item_id);
    assert.equal(it.url, r.url);
    assert.equal(it.page_host, 'detail.tmall.com');
    for (const s of r.skus) {
      const p = it.skus.find((x) => x.sku_key === s.sku_id)!;
      assert.ok(p, s.sku_id);
      assert.equal(p.price, s.price_cny, 'the price is the captured decimal text');
      assert.equal(p.price_label, s.price_title ?? '', 'price_title becomes price_label, never a price');
      assert.doesNotMatch(p.price_label, /[0-9]/);
      assert.equal(p.quantity, s.quantity);
      assert.deepEqual(p.options, s.options);
    }
  }
  // Decimal prices stay text: 59.9 CNY glue, 166.8 CNY PA6-GF.
  const prices = parsed.items.flatMap((i) => i.skus.map((s) => s.price));
  assert.ok(prices.includes('59.9') && prices.includes('166.8'));
  // A real file read as text (the owner's browser posts text).
  assert.deepEqual(parseSupplierPriceFile(fixtureText('tmall-2026-10-31.v1.json')), parsed);
});

test('the real EU snapshot parses: bambu_eu in EUR, store handles, JSON-LD variant ids, two-decimal numbers', () => {
  const parsed = euFile();
  assert.equal(parsed.source, 'bambu_eu');
  assert.equal(parsed.currency, 'EUR');
  assert.equal(SOURCE_CURRENCY.bambu_eu, 'EUR');
  for (const r of euRecords()) {
    const it = parsed.items.find((i) => i.item_key === r.handle)!;
    assert.ok(it, r.handle);
    assert.equal(it.page_host, 'eu.store.bambulab.com');
    assert.deepEqual(
      it.skus.map((s) => s.sku_key),
      r.variants.map((v) => v.sku),
      'the store variant ids, digit for digit (many exceed 2^53)'
    );
    for (const v of r.variants) {
      const s = it.skus.find((x) => x.sku_key === v.sku)!;
      assert.equal(s.price, String(v.price_eur));
      assert.equal(v.currency, 'EUR');
    }
  }
  const buffer = parsed.items.find((i) => i.item_key === 'filament-buffer')!;
  assert.deepEqual(
    buffer.skus.map((s) => [s.sku_key, s.price]),
    [['43719762903259', '27.99']]
  );
  const h2d = parsed.items.find((i) => i.item_key === 'h2d')!;
  assert.equal(h2d.skus.find((s) => s.sku_key === '596571526982115329')!.price, '1599');
  assert.deepEqual(h2d.skus[0]!.options, { option1: 'H2D AMS Combo', option2: 'Standard' });
});

test('unknown keys are refused by name, at every level', () => {
  refused(file({ price_cny: '1' }), '$.price_cny', 'unknown_key');
  refused(file({ items: [item({ from_price_cny: '40' })] }), '$.items[0].from_price_cny', 'unknown_key');
  refused(file({ items: [item({ hidden_price: false })] }), '$.items[0].hidden_price', 'unknown_key');
  refused(file({ items: [item({ skus: [sku({ price_title: '优惠前' })] })] }), '$.items[0].skus[0].price_title', 'unknown_key');
  refused(file({ items: [item({ skus: [sku({ price_cny: '40' })] })] }), '$.items[0].skus[0].price_cny', 'unknown_key');
  refused(file({ items: [item({ skus: [sku({ cost: '40' })] })] }), '$.items[0].skus[0].cost', 'unknown_key');
});

test('missing keys are refused by name', () => {
  for (const k of ['format', 'source', 'currency', 'capture', 'captured_on', 'items']) {
    const f = file();
    delete f[k];
    refused(f, `$.${k}`, 'missing_key');
  }
  const noKey = item();
  delete noKey.item_key;
  refused(file({ items: [noKey] }), '$.items[0].item_key', 'missing_key');
  const noSkus = item();
  delete noSkus.skus;
  refused(file({ items: [noSkus] }), '$.items[0].skus', 'missing_key');
  const noPrice = sku();
  delete noPrice.price;
  refused(file({ items: [item({ skus: [noPrice] })] }), '$.items[0].skus[0].price', 'missing_key');
  // Optional keys default.
  const bare = file({ items: [{ item_key: '1', skus: [{ sku_key: '2', price: '9' }] }] });
  delete bare.price_basis;
  delete bare.captured_by;
  const minimal = parseSupplierPriceFile(bare);
  assert.equal(minimal.price_basis, 'list');
  assert.equal(minimal.captured_by, '');
  assert.deepEqual(minimal.items[0], {
    item_key: '1',
    url: '',
    page_host: '',
    title: '',
    name_en: '',
    category: '',
    sourcing: '',
    freight_route: '',
    codes: [],
    props: [],
    skus: [{ sku_key: '2', options: {}, options_en: {}, price: '9', price_label: '', quantity: null, sku_code: '', codes: [] }],
  });
});

test('floats are refused; JSON numbers with at most two decimals become text', () => {
  const at = '$.items[0].skus[0].price';
  refused(file({ items: [item({ skus: [sku({ price: 0.1 + 0.2 })] })] }), at, 'float_price');
  refused(file({ items: [item({ skus: [sku({ price: 19.999 })] })] }), at, 'float_price');
  refused(file({ items: [item({ skus: [sku({ price: 1e21 })] })] }), at, 'float_price');
  refused(file({ items: [item({ skus: [sku({ price: 2 ** 53 + 2 })] })] }), at, 'float_price');
  refused(file({ items: [item({ skus: [sku({ price: 0 })] })] }), at, 'bad_price');
  refused(file({ items: [item({ skus: [sku({ price: -5 })] })] }), at, 'bad_price');
  refused(file({ items: [item({ skus: [sku({ price: Number.NaN })] })] }), at, 'bad_price');
  refused(file({ items: [item({ skus: [sku({ price: true })] })] }), at, 'wrong_type');
  for (const [n, t] of [
    [27.99, '27.99'],
    [59.9, '59.9'],
    [1599, '1599'],
    [0.5, '0.5'],
  ] as const) {
    assert.equal(parseSupplierPriceFile(file({ items: [item({ skus: [sku({ price: n })] })] })).items[0]!.skus[0]!.price, t);
    assert.equal(supplierPriceText(n), t);
  }
});

test('decimal text is kept exactly as captured; anything else is refused', () => {
  for (const t of ['40', '59.90', '0.5', '007', '1299.00', '1'.repeat(24)]) {
    assert.equal(parseSupplierPriceFile(file({ items: [item({ skus: [sku({ price: t })] })] })).items[0]!.skus[0]!.price, t);
    assert.equal(isSupplierPriceText(t), true, t);
  }
  for (const t of ['', '0', '0.00', '-1', '+1', '1,299', '¥99', '99.', '.5', '1.2.3', '1e3', ' 40', '40 ', '四十', '1'.repeat(25), 'NaN']) {
    refused(file({ items: [item({ skus: [sku({ price: t })] })] }), '$.items[0].skus[0].price', 'bad_price');
    assert.equal(isSupplierPriceText(t), false, t);
  }
});

test('the source pairs with its currency', () => {
  refused(file({ currency: 'EUR' }), '$.currency', 'currency_mismatch');
  refused(file({ source: 'bambu_eu', currency: 'USD', items: [euItem()] }), '$.currency', 'currency_mismatch');
  refused(file({ source: 'bambu_us', currency: 'EUR' }), '$.currency', 'currency_mismatch');
  refused(file({ source: 'taobao' }), '$.source', 'not_allowed_value');
  refused(file({ currency: 'RMB' }), '$.currency', 'not_allowed_value');
  assert.deepEqual(SOURCE_CURRENCY, { tmall_cn: 'CNY', bambu_eu: 'EUR', bambu_us: 'USD' });
  const us = parseSupplierPriceFile(
    file({ source: 'bambu_us', currency: 'USD', items: [euItem({ url: 'https://us.store.bambulab.com/products/filament-buffer', page_host: 'us.store.bambulab.com' })] })
  );
  assert.equal(us.currency, 'USD');
});

test('an EU capture served by another store is refused: url and page_host must be the source’s own host', () => {
  refused(euWith({}, { page_host: 'us.store.bambulab.com' }), '$.items[0].page_host', 'bad_host');
  refused(euWith({}, { url: 'https://us.store.bambulab.com/products/filament-buffer' }), '$.items[0].url', 'bad_host');
  refused(euWith({}, { url: 'https://evil.example/products/filament-buffer' }), '$.items[0].url', 'bad_host');
  refused(euWith({}, { url: 'http://eu.store.bambulab.com/products/filament-buffer' }), '$.items[0].url', 'bad_url');
  refused(euWith({}, { url: 'javascript:alert(1)' }), '$.items[0].url', 'bad_url');
  refused(euWith({}, { url: 'https://user:pw@eu.store.bambulab.com/products/x' }), '$.items[0].url', 'bad_url');
  refused(euWith({}, { url: 'https://eu.store.bambulab.com:8443/products/x' }), '$.items[0].url', 'bad_url');
  refused(euWith({}, { url: 'https://eu.store.bambulab.com/products/a b' }), '$.items[0].url', 'bad_url');
  refused(file({ items: [item({ page_host: 'eu.store.bambulab.com' })] }), '$.items[0].page_host', 'bad_host');
  refused(file({ items: [item({ url: 'https://detail.tmall.com.evil.example/item.htm?id=1' })] }), '$.items[0].url', 'bad_host');
  // The Tmall hosts are Tmall's and Taobao's own.
  assert.equal(parseSupplierPriceFile(file({ items: [item({ url: 'https://detail.tmall.com/item.htm?id=1053109777521&skuId=6264995743059' })] })).items[0]!.url.startsWith('https://detail.tmall.com/'), true);
});

test('ids follow the source’s grammar', () => {
  refused(file({ items: [item({ item_key: 'ZH121' })] }), '$.items[0].item_key', 'bad_id');
  refused(file({ items: [item({ item_key: '' })] }), '$.items[0].item_key', 'bad_id');
  refused(file({ items: [item({ item_key: 1053109777521 })] }), '$.items[0].item_key', 'wrong_type');
  refused(file({ items: [item({ skus: [sku({ sku_key: '6264995743059a' })] })] }), '$.items[0].skus[0].sku_key', 'bad_id');
  for (const bad of ['H2D', 'h2d/x', 'h2d?x=1', 'h2d#x', 'garden-races-cyberbrick-4%C3%974-rc-truck', 'h2d x', '']) {
    refused(euWith({}, { item_key: bad }), '$.items[0].item_key', 'bad_id');
  }
  // A real Shopify handle may hold non-ASCII letters; a store SKU key may be the SKU code when the page has no variant id.
  const ok = parseSupplierPriceFile(
    euWith({}, { item_key: 'cyberbrick-mk20-1a4-waffenträger', skus: [{ sku_key: 'A00-W1-1.75-1000-SPLFREE', price: '24.99' }, { sku_key: '596571526982115329', price: '1599' }] })
  );
  assert.equal(ok.items[0]!.item_key, 'cyberbrick-mk20-1a4-waffenträger');
  assert.deepEqual(
    ok.items[0]!.skus.map((s) => s.sku_key),
    ['A00-W1-1.75-1000-SPLFREE', '596571526982115329']
  );
  refused(euWith({}, { skus: [{ sku_key: 'A00 W1', price: '1' }] }), '$.items[0].skus[0].sku_key', 'bad_id');
  // An id written as a JSON number has already been rounded by JSON.parse (596571526982115329 > 2^53).
  refused(euWith({}, { skus: [{ sku_key: Number('596571526982115329'), price: '1599' }] }), '$.items[0].skus[0].sku_key', 'wrong_type');
  // A value JSON cannot hold is a refusal, not a crash.
  refused(file({ items: [item({ props: [{ big: BigInt(1) }] })] }), '$.items[0].props', 'wrong_type');
});

test('caps: 20,000 items, 200 SKUs per item, 200,000 SKUs, every column’s length', () => {
  refused(file({ items: new Array(SUPPLIER_PRICE_LIMITS.items + 1).fill(null) }), '$.items', 'too_many');
  const skus = Array.from({ length: 200 }, (_, i) => sku({ sku_key: String(1000 + i) }));
  assert.equal(parseSupplierPriceFile(file({ items: [item({ skus })] })).items[0]!.skus.length, 200);
  refused(file({ items: [item({ skus: [...skus, sku({ sku_key: '9999' })] })] }), '$.items[0].skus', 'too_many');
  // 1,001 items × 200 SKUs = 200,200 SKUs: the 1,001st item crosses the snapshot's sku_count cap.
  const many = Array.from({ length: 1001 }, (_, i) => ({ item_key: String(5000 + i), skus }));
  refused(file({ items: many }), '$.items[1000].skus', 'too_many');

  refused(file({ items: [item({ title: 'x'.repeat(401) })] }), '$.items[0].title', 'too_long');
  refused(file({ items: [item({ name_en: 'x'.repeat(401) })] }), '$.items[0].name_en', 'too_long');
  refused(file({ items: [item({ url: `https://detail.tmall.com/item.htm?id=${'1'.repeat(600)}` })] }), '$.items[0].url', 'too_long');
  refused(file({ captured_by: 'x'.repeat(121) }), '$.captured_by', 'too_long');
  refused(file({ items: [item({ skus: [sku({ price_label: '优'.repeat(61) })] })] }), '$.items[0].skus[0].price_label', 'too_long');
  const wide = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`规格${i}`, 'x'.repeat(380)]));
  refused(file({ items: [item({ skus: [sku({ options: wide })] })] }), '$.items[0].skus[0].options', 'too_long');
  refused(file({ items: [item({ skus: [sku({ options: { 规格: 'x'.repeat(401) } })] })] }), '$.items[0].skus[0].options["规格"]', 'too_long');
  refused(file({ items: [item({ codes: Array.from({ length: 600 }, (_, i) => `ZH${100 + i}`) })] }), '$.items[0].codes', 'too_long');
  refused(file({ items: [item({ props: [{ name: 'x'.repeat(16001) }] })] }), '$.items[0].props', 'too_long');
  refused(file({ items: [item({ category: 'Tool' })] }), '$.items[0].category', 'not_allowed_value');
  refused(file({ items: [item({ codes: ['ZH 121'] })] }), '$.items[0].codes[0]', 'not_allowed_value');
  refused(file({ items: [item({ sourcing: 'EU' })] }), '$.items[0].sourcing', 'not_allowed_value');
  refused(file({ items: [item({ freight_route: 'CHINA_AIR' })] }), '$.items[0].freight_route', 'not_allowed_value');
  refused(file({ items: [item({ skus: [sku({ quantity: -1 })] })] }), '$.items[0].skus[0].quantity', 'wrong_type');
  refused(file({ items: [item({ skus: [sku({ quantity: 1.5 })] })] }), '$.items[0].skus[0].quantity', 'wrong_type');
});

test('duplicates are refused: an item key twice, a SKU key twice in one item', () => {
  refused(file({ items: [item(), item()] }), '$.items[1].item_key', 'duplicate');
  refused(file({ items: [item({ skus: [sku(), sku()] })] }), '$.items[0].skus[1].sku_key', 'duplicate');
  // One SKU key in two items is two SKUs.
  const two = parseSupplierPriceFile(file({ items: [item(), item({ item_key: '1053109777522' })] }));
  assert.equal(skuCountOf(two.items), 2);
  refused(file({ items: [] }), '$.items', 'empty');
  refused(file({ items: [item({ skus: [] })] }), '$.items[0].skus', 'empty');
});

test('price_label is words, never a figure', () => {
  for (const bad of ['99', '¥99', '￥99', '99元', '99.50', '€27,99', '$5']) {
    refused(file({ items: [item({ skus: [sku({ price_label: bad })] })] }), '$.items[0].skus[0].price_label', 'figure_in_label');
  }
  for (const ok of ['优惠前', '双11价', '券后价', '']) {
    assert.equal(parseSupplierPriceFile(file({ items: [item({ skus: [sku({ price_label: ok })] })] })).items[0]!.skus[0]!.price_label, ok);
  }
  assert.equal(parseSupplierPriceFile(file({ items: [item({ skus: [sku({ price_label: null })] })] })).items[0]!.skus[0]!.price_label, '');
});

test('dates, control characters, JSON text', () => {
  refused(file({ captured_on: '2026-02-30' }), '$.captured_on', 'bad_date');
  refused(file({ captured_on: '31/10/2026' }), '$.captured_on', 'bad_date');
  refused(file({ captured_on: '1999-12-31' }), '$.captured_on', 'bad_date');
  assert.equal(parseSupplierPriceFile(file({ captured_on: '2028-02-29' })).captured_on, '2028-02-29');
  refused(file({ items: [item({ title: `a${String.fromCharCode(0)}b` })] }), '$.items[0].title', 'control_character');
  refused(file({ items: [item({ title: `a${String.fromCharCode(0x202e)}b` })] }), '$.items[0].title', 'control_character');
  refused(file({ items: [item({ skus: [sku({ options: { [`a${String.fromCharCode(10)}`]: 'x' } })] })] }), '$.items[0].skus[0].options["a\\n"]', 'control_character');
  refused('{"format": ', '$', 'not_json');
  refused('[]', '$', 'wrong_type');
  refused(file({ format: 'levonis.supplier-prices.v2' }), '$.format', 'not_allowed_value');
  const withBom = `${String.fromCharCode(0xfeff)}${JSON.stringify(file())}`;
  assert.equal(parseSupplierPriceFile(withBom).items.length, 1);
});

test('a "__proto__" option group is a plain key, not a prototype', () => {
  const parsed = parseSupplierPriceFile(JSON.parse('{"format":"levonis.supplier-prices.v1","source":"tmall_cn","currency":"CNY","capture":"browser_sweep","captured_on":"2026-10-31","items":[{"item_key":"1","skus":[{"sku_key":"2","price":"3","options":{"__proto__":"x"}}]}]}'));
  const options = parsed.items[0]!.skus[0]!.options;
  assert.equal(Object.getPrototypeOf(options), Object.prototype);
  assert.deepEqual(Object.keys(options), ['__proto__']);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test('chunks: the upload door parses 50 items at a time and names the file position', () => {
  const items = Array.from({ length: 51 }, (_, i) => item({ item_key: String(100 + i) }));
  assert.throws(
    () => parseSupplierPriceItems(items, 'tmall_cn', { max: 50 }),
    (e: unknown) => e instanceof SupplierPriceFormatError && e.reason === 'too_many' && e.path === '$.items'
  );
  assert.throws(
    () => parseSupplierPriceItems([item({ item_key: 'x' })], 'tmall_cn', { offset: 150 }),
    (e: unknown) => e instanceof SupplierPriceFormatError && e.path === '$.items[150].item_key' && e.reason === 'bad_id'
  );
  assert.equal(parseSupplierPriceItems(items.slice(0, 50), 'tmall_cn', { max: 50 }).length, 50);
  // The same EU item is refused in a Tmall chunk: the chunk's source decides the grammar.
  assert.throws(() => parseSupplierPriceItems([euItem()], 'tmall_cn'), SupplierPriceFormatError);
  assert.equal(parseSupplierPriceItems([euItem()], 'bambu_eu')[0]!.skus[0]!.price, '27.99');
});

test('the header alone (the body that opens an upload)', () => {
  assert.deepEqual(parseSnapshotHeader({ source: 'bambu_eu', currency: 'EUR', capture: 'store_script', captured_on: '2026-10-31' }), {
    source: 'bambu_eu',
    currency: 'EUR',
    price_basis: 'list',
    capture: 'store_script',
    captured_on: '2026-10-31',
    captured_by: '',
  });
  assert.equal(parseSnapshotHeader({ source: 'bambu_eu', currency: 'EUR', price_basis: 'net_of_vat', capture: 'open_api', captured_on: '2026-10-31' }).price_basis, 'net_of_vat');
  assert.throws(() => parseSnapshotHeader({ source: 'bambu_eu', currency: 'USD', capture: 'store_script', captured_on: '2026-10-31' }), /currency_mismatch at \$\.currency/);
  assert.throws(() => parseSnapshotHeader({ source: 'tmall_cn', currency: 'CNY', capture: 'scrape', captured_on: '2026-10-31' }), /not_allowed_value at \$\.capture/);
});

test('the error: code, status, path, reason, and the owner’s sentence in three languages', () => {
  try {
    parseSupplierPriceFile(file({ currency: 'USD' }));
    assert.fail('refused');
  } catch (e) {
    assert.ok(e instanceof SupplierPriceFormatError);
    assert.equal(e.code, 'SUPPLIER_PRICE_FORMAT_INVALID');
    assert.equal(e.status, 400);
    assert.equal(e.path, '$.currency');
    assert.equal(e.reason, 'currency_mismatch');
    assert.match(e.message, /^The supplier price file is not valid/);
  }
  const m = SUPPLIER_PRICE_FORMAT_MESSAGE;
  for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(m[lang].trim().length > 10, lang);
  assert.notEqual(m.ckb, m.ar, 'the Sorani is not a copy of the Arabic (DECISIONS row 183)');
  assert.match(m.ckb, /[ێۆڕڵە]/, 'Sorani letters');
  assert.match(m.ar, /[ء-ي]/);
});
