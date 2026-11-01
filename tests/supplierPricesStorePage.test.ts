/**
 * POST /api/admin/pricing/supplier-prices/read-store-page — ONE OWNER-INITIATED
 * READ OF ONE STORE PAGE (docs/SMART_PRICING.md §3.6, §3.9; WP5).
 *
 * With a stubbed fetch (the unit-test process has no network):
 *   - the owner's address is never fetched as typed: the host must be one of
 *     the two stores, the handle and `?id=` are taken from it, and the address
 *     is rebuilt — an EU read always carries `skr=yes`, a US read never does;
 *   - the host allow-list holds on EVERY hop: a redirect off the two stores,
 *     or to http, is refused before it is requested;
 *   - the stored currency is the page's own and the source the final host's:
 *     an EU address the store sends to the US store is stored as USD;
 *   - a refused or challenged read, or a page without JSON-LD offers, saves
 *     nothing and answers 502 PRICE_ESTIMATE_STORE_PAGE_UNREADABLE;
 *   - a sale page saves the regular (struck-through) price, and answers the
 *     sale price beside it, never saved;
 *   - a variant repeated across JSON-LD nodes: copies of one value are one
 *     offer, and a plain copy at another copy's sale price is that sale; any
 *     other disagreement keeps every copy and saves nothing (502 with
 *     details.reason 'copies_disagree' with ?id=, 400 without); within one
 *     node the offers are only deduplicated;
 *   - only the owner reaches it, and a refused caller causes no fetch.
 *
 * Run: node --import tsx --test tests/supplierPricesStorePage.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, count, ctx, freshDb, stubApp, type StubUser } from './fixtures/app';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminSupplierPricesRoutes } from '../worker/routes/adminSupplierPrices';
import { STORE_PAGE_UNREADABLE_TEXT, extractStoreOffers, storePageTarget } from '../worker/lib/supplierPrices/storePage';
import { ApiError } from '../src/lib/api';
import { isStoreCopiesDisagree } from '../src/components/adminEstimates/api';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type App = ReturnType<typeof stubApp>;

const BASE = '/api/admin/pricing/supplier-prices';
const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };

const appAs = (raw: DatabaseSync, user: StubUser | null): App =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/admin/pricing', adminPricingRoutes);
    a.route(BASE, adminSupplierPricesRoutes);
  });

async function read(app: App, body: unknown) {
  const res = await app.request(
    `${BASE}/read-store-page`,
    { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', origin: 'https://levonis-iq.com' }, body: JSON.stringify(body) },
    undefined,
    ctx
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Json, text };
}

// ------------------------------------------------------------------ the stubbed network

const calls: Array<{ url: string; headers: Record<string, string> }> = [];
let answer: (url: string) => Response = () => {
  throw new TypeError('no page');
};
const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
  calls.push({ url, headers });
  return answer(url);
}) as typeof fetch;
afterEach(() => {
  calls.length = 0;
});
process.on('exit', () => {
  globalThis.fetch = previousFetch;
});

const html = (ld: unknown) => new Response(`<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
/** A page carrying several JSON-LD blocks (a theme's and an app's, say), in this order. */
const blocksHtml = (...lds: unknown[]) => lds.map((ld) => `<script type="application/ld+json">${JSON.stringify(ld)}</script>`).join('\n');
const blocks = (...lds: unknown[]) => new Response(`<!doctype html><html><head>${blocksHtml(...lds)}</head><body></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
const group = (
  host: string,
  handle: string,
  variants: Array<{ id: string; name: string; price: string | number; currency: string; availability?: string; regular?: string | number }>
) => ({
  '@context': 'https://schema.org/',
  '@type': 'ProductGroup',
  name: handle,
  url: `https://${host}/products/${handle}`,
  hasVariant: variants.map((v) => ({
    '@type': 'Product',
    sku: v.id,
    name: v.name,
    offers: {
      '@type': 'Offer',
      url: `https://${host}/products/${handle}?id=${v.id}`,
      priceCurrency: v.currency,
      price: v.price,
      availability: v.availability ?? 'https://schema.org/InStock',
      // On sale: the regular price, struck through on the page.
      ...(v.regular === undefined ? {} : { priceSpecification: { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: v.regular, priceCurrency: v.currency } }),
    },
  })),
});
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
/** The stored store pages of the capture tools' tests (tests/fixtures/supplierPricePages). */
const storeFixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'supplierPricePages', name), 'utf8');
const fixtureResponse = (name: string) => new Response(storeFixture(name), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

const EU_H2D = group('eu.store.bambulab.com', 'h2d', [
  { id: '596571526982115329', name: 'H2D AMS Combo / Standard', price: '1599.00', currency: 'EUR' },
  { id: '596571526990503947', name: 'H2D / Standard', price: '1399.00', currency: 'EUR', availability: 'https://schema.org/OutOfStock' },
]);

function seed(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id, slug, name) VALUES ('p_h2d', 'h2d', 'Bambu Lab H2D');
    INSERT INTO product_option_groups (id, product_id, name_en, kind, sort, active) VALUES ('g_b', 'p_h2d', 'Bundle', 'version', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES
      ('v_combo', 'p_h2d', 'g_b', 'H2D AMS Combo', 0, 1), ('v_base', 'p_h2d', 'g_b', 'H2D', 1, 1);
    INSERT INTO products (id, slug, name) VALUES ('p_buf', 'filament-buffer', 'Filament Buffer');
  `);
}

const manual = (raw: DatabaseSync) =>
  all<Json>(raw, 'SELECT product_id, combo_key, amount, currency, origin, evidence_url, evidence_host FROM supplier_price_manual ORDER BY product_id, combo_key');

// ------------------------------------------------------------------ the address

test('the owner’s address is rebuilt, never fetched as typed: EU links carry skr=yes, US links never; anything else is refused', () => {
  assert.deepEqual(storePageTarget('https://eu.store.bambulab.com/products/h2d'), {
    source: 'bambu_eu',
    handle: 'h2d',
    variant_id: null,
    url: 'https://eu.store.bambulab.com/products/h2d?skr=yes',
  });
  assert.equal(storePageTarget('eu.store.bambulab.com/products/h2d?id=596571526982115329').url, 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes');
  assert.equal(
    storePageTarget('https://eu.store.bambulab.com/en/products/H2D?id=596571526982115329&utm_source=x&skr=yes#reviews').url,
    'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes',
    'the locale, the tracking and the fragment are dropped'
  );
  const us = storePageTarget('https://us.store.bambulab.com/products/filament-buffer?id=40922942079112&skr=yes');
  assert.deepEqual([us.source, us.url], ['bambu_us', 'https://us.store.bambulab.com/products/filament-buffer?id=40922942079112']);
  for (const bad of [
    'https://evil.example/products/h2d',
    'https://eu.store.bambulab.com.evil.example/products/h2d',
    'https://store.bambulab.com/products/h2d',
    'https://eu.store.bambulab.com:8443/products/h2d',
    'https://owner:pw@eu.store.bambulab.com/products/h2d',
    'https://eu.store.bambulab.com/products/h2d?id=12a',
    'https://eu.store.bambulab.com/products/usb%E2%80%91c-soldering-iron-kit',
    'https://eu.store.bambulab.com/collections/all',
    'https://eu.store.bambulab.com/products/../admin',
    'https://detail.tmall.com/item.htm?id=1036834158903',
    'javascript:alert(1)',
    'ftp://eu.store.bambulab.com/products/h2d',
    '',
    42,
  ]) {
    assert.throws(
      () => storePageTarget(bad),
      (e: unknown) => (e as { code?: string; details?: unknown }).code === 'PRICING_INPUT_INVALID',
      String(bad)
    );
  }
});

test('the JSON-LD walk: every variant offer with its own currency; a binary float or a lost id is never a price or an id', () => {
  const page = `<script type="application/ld+json">${JSON.stringify(EU_H2D)}</script>
    <script type="application/ld+json">{ "broken": </script>
    <script type="application/ld+json">{"@type":"ProductGroup","hasVariant":[{"@type":"Product","sku":596571526990503947,"name":"Lost id","offers":{"price":"10","priceCurrency":"EUR"}},
      {"@type":"Product","sku":"1","name":"Float","offers":{"price":12.345,"priceCurrency":"EUR"}},
      {"@type":"Product","sku":"2","name":"No currency","offers":{"price":"12"}}]}</script>`;
  assert.deepEqual(extractStoreOffers(page), [
    { sku_key: '596571526982115329', name: 'H2D AMS Combo / Standard', price: '1599.00', currency: 'EUR', availability: 'in_stock' },
    { sku_key: '596571526990503947', name: 'H2D / Standard', price: '1399.00', currency: 'EUR', availability: 'out_of_stock' },
    { sku_key: '', name: 'Lost id', price: '10', currency: 'EUR', availability: 'unknown' },
  ]);
  assert.deepEqual(extractStoreOffers('<html><title>Just a moment...</title></html>'), []);
});

test('a sale page: each offer’s price is its regular (struck-through) price, the sale price told beside it — a list or one object, the schema.org URL or the bare name', () => {
  // The A1 as the EU store showed it on 2026-10-31: the offer 239, its StrikethroughPrice 259 (a list, the URL).
  assert.deepEqual(extractStoreOffers(storeFixture('eu-a1-sale.page.html')), [
    { sku_key: '599117150694776840', name: 'Bambu Lab A1 3D Printer - A1', price: '259', sale_price: '239', currency: 'EUR', availability: 'in_stock' },
    { sku_key: '599117150694776844', name: 'Bambu Lab A1 3D Printer - A1 Combo', price: '369', sale_price: '339', currency: 'EUR', availability: 'in_stock' },
  ]);
  // The H2C: one object, the bare name.
  assert.deepEqual(
    extractStoreOffers(storeFixture('eu-h2c-sale.page.html')).map((o) => [o.sku_key, o.price, o.sale_price, o.availability]),
    [
      ['666136020008767488', '2149', '1799', 'in_stock'],
      ['666136020008767498', '2549', '2149', 'out_of_stock'],
      ['666136020008767503', '2949', '2499', 'out_of_stock'],
      ['761060179809759232', '2449', '2019', 'in_stock'],
    ]
  );
  // A page that names no regular price is no sale: its offer price, and no sale price at all.
  assert.deepEqual(
    extractStoreOffers(storeFixture('eu-h2c.page.html')).map((o) => [o.price, 'sale_price' in o]),
    [
      ['1799', false],
      ['2149', false],
      ['2499', false],
      ['2019', false],
    ]
  );
});

// The A1 in two JSON-LD blocks: one shows only the sale price, the other states the regular price beside it.
const A1_ID = '599117150694776840';
const A1_PLAIN = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 239, currency: 'EUR' }]);
const A1_SALE = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 239, regular: 259, currency: 'EUR' }]);
const A1_OTHER = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 259, currency: 'EUR' }]);
const A1_SALE_279 = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 249, regular: 279, currency: 'EUR' }]);
/** One JSON-LD Product (no ProductGroup) whose own digits-only sku names every offer of it. */
const STANDALONE_SKU = '123456789';
const standalone = (offers: Array<{ price: number | string; regular?: number }>) => ({
  '@type': 'Product',
  name: 'Standalone',
  sku: STANDALONE_SKU,
  offers: offers.map((o) => ({
    '@type': 'Offer',
    price: o.price,
    priceCurrency: 'EUR',
    ...(o.regular === undefined ? {} : { priceSpecification: { '@type': 'UnitPriceSpecification', priceType: 'https://schema.org/StrikethroughPrice', price: o.regular, priceCurrency: 'EUR' } }),
  })),
});

test('a variant repeated across JSON-LD blocks: copies of one value are one offer, a plain copy at another copy’s sale price is that sale, and any other disagreement keeps every copy', () => {
  const one = [{ sku_key: A1_ID, name: 'A1', price: '259', sale_price: '239', currency: 'EUR', availability: 'in_stock' }];
  assert.deepEqual(extractStoreOffers(blocksHtml(A1_PLAIN, A1_SALE)), one, 'the plain block first');
  assert.deepEqual(extractStoreOffers(blocksHtml(A1_SALE, A1_PLAIN)), one, 'the plain block last');
  // A plain copy of the regular price, written as other text: one value, and the copy that states the sale is kept.
  const regularText = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: '259.00', currency: 'EUR' }]);
  assert.deepEqual(extractStoreOffers(blocksHtml(regularText, A1_SALE)), one);
  // Any other disagreement: every copy kept, in page order (a save then refuses).
  const prices = (...lds: unknown[]) => extractStoreOffers(blocksHtml(...lds)).map((o) => [o.price, o.sale_price ?? null]);
  assert.deepEqual(prices(A1_PLAIN, A1_OTHER), [
    ['239', null],
    ['259', null],
  ]);
  const higher = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 299, currency: 'EUR' }]);
  assert.deepEqual(prices(A1_SALE, higher), [
    ['259', '239'],
    ['299', null],
  ]);
  // Two copies that each state a regular price, and differ: neither is taken over the other.
  assert.deepEqual(prices(A1_SALE, A1_SALE_279), [
    ['259', '239'],
    ['279', '249'],
  ]);
  // A plain copy below a stated one that is not its sale price is no sale: the stated copy is not taken.
  const stated299 = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 279, regular: 299, currency: 'EUR' }]);
  assert.deepEqual(prices(stated299, A1_OTHER), [
    ['299', '279'],
    ['259', null],
  ]);
  // Only the repeated variant is touched: another variant, another currency or an offer without an id stays as it was.
  const combo = group('eu.store.bambulab.com', 'a1', [{ id: '599117150694776844', name: 'A1 Combo', price: 339, currency: 'EUR' }]);
  const usd = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 279, currency: 'USD' }]);
  const noId = { '@type': 'Product', name: 'No id', offers: [{ price: '5', priceCurrency: 'EUR' }, { price: '5', priceCurrency: 'EUR' }, { price: '6', priceCurrency: 'EUR' }] };
  assert.deepEqual(
    extractStoreOffers(blocksHtml(A1_PLAIN, combo, usd, A1_SALE, noId)).map((o) => [o.sku_key, o.price, o.currency]),
    [
      ['599117150694776844', '339', 'EUR'],
      [A1_ID, '279', 'USD'],
      [A1_ID, '259', 'EUR'],
      ['', '5', 'EUR'],
      ['', '6', 'EUR'],
    ]
  );
});

test('offers are copies only across JSON-LD nodes: within one Product they are only deduplicated, as before, and its two prices are never merged', () => {
  const read = (...lds: unknown[]) => extractStoreOffers(blocksHtml(...lds)).map((o) => [o.sku_key, o.price, o.sale_price ?? null]);
  // One Product whose own sku names both offers: two prices of the variant (a save refuses), the highest never taken.
  assert.deepEqual(read(standalone([{ price: 279, regular: 299 }, { price: 259 }])), [
    [STANDALONE_SKU, '299', '279'],
    [STANDALONE_SKU, '259', null],
  ]);
  // Within one node not even the sale pattern merges.
  assert.deepEqual(read(standalone([{ price: 239 }, { price: 239, regular: 259 }])), [
    [STANDALONE_SKU, '239', null],
    [STANDALONE_SKU, '259', '239'],
  ]);
  // The old de-duplication within one node: one offer per price text, the first.
  assert.deepEqual(read(standalone([{ price: 259 }, { price: 259 }, { price: 249 }])), [
    [STANDALONE_SKU, '259', null],
    [STANDALONE_SKU, '249', null],
  ]);
  // The same Product in two blocks: two nodes, so copies, and the rule merges them.
  assert.deepEqual(read(standalone([{ price: 239 }]), standalone([{ price: 239, regular: 259 }])), [[STANDALONE_SKU, '259', '239']]);
  // Two prices in one node beside a copy in another: still refused, every price kept once.
  assert.deepEqual(read(standalone([{ price: 259 }, { price: 249 }]), standalone([{ price: 259 }])), [
    [STANDALONE_SKU, '259', null],
    [STANDALONE_SKU, '249', null],
  ]);
});

// ------------------------------------------------------------------ the route

test('an EU variant read: fetched with skr=yes, the page’s EUR saved as the owner’s price of the SKUs named, with its evidence', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  answer = () => html(EU_H2D);
  const r = await read(app, { url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329', save: { product_id: 'p_h2d', combo_keys: ['o:v_combo'] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes']
  );
  assert.match(calls[0]!.headers['user-agent'] ?? '', /LevonisBot/);
  const sp = r.body.supplier_prices;
  assert.deepEqual(
    [sp.requested_source, sp.source, sp.host, sp.redirected, sp.chosen_sku_key, sp.sku_url],
    ['bambu_eu', 'bambu_eu', 'eu.store.bambulab.com', false, '596571526982115329', 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes']
  );
  assert.equal(sp.offers.length, 2);
  assert.equal(r.body.saved, 1);
  assert.deepEqual(manual(raw), [
    {
      product_id: 'p_h2d',
      combo_key: 'o:v_combo',
      amount: '1599.00',
      currency: 'EUR',
      origin: 'store_page',
      evidence_url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329&skr=yes',
      evidence_host: 'eu.store.bambulab.com',
    },
  ]);
  // Read again later: the row's version moves, the price follows the page.
  answer = () => html(group('eu.store.bambulab.com', 'h2d', [{ id: '596571526982115329', name: 'H2D AMS Combo / Standard', price: '1549.00', currency: 'EUR' }]));
  assert.equal((await read(app, { url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329', save: { product_id: 'p_h2d', combo_keys: ['o:v_combo', 'o:v_base'] } })).status, 200);
  assert.deepEqual(
    all<Json>(raw, 'SELECT combo_key, amount, version FROM supplier_price_manual ORDER BY combo_key'),
    [
      { combo_key: 'o:v_base', amount: '1549.00', version: 1 },
      { combo_key: 'o:v_combo', amount: '1549.00', version: 2 },
    ]
  );
  // A read without save stores nothing and lists every offer.
  answer = () => html(EU_H2D);
  const look = await read(app, { url: 'https://eu.store.bambulab.com/products/h2d' });
  assert.deepEqual([look.status, look.body.saved, look.body.supplier_prices.chosen_sku_key], [200, 0, null]);
  assert.equal(look.body.supplier_prices.item_url, 'https://eu.store.bambulab.com/products/h2d?skr=yes');
});

test('an EU sale page: the regular price is saved as the owner’s price; the sale price is answered beside it and never saved', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO products (id, slug, name) VALUES ('p_a1', 'a1', 'Bambu Lab A1');`);
  const app = appAs(raw, OWNER);
  answer = () => fixtureResponse('eu-a1-sale.page.html');
  const r = await read(app, { url: 'https://eu.store.bambulab.com/products/a1?id=599117150694776840', save: { product_id: 'p_a1', combo_keys: [''] } });
  assert.equal(r.status, 200, r.text);
  const sp = r.body.supplier_prices;
  assert.equal(sp.chosen_sku_key, '599117150694776840');
  assert.deepEqual(sp.offers[0], { sku_key: '599117150694776840', name: 'Bambu Lab A1 3D Printer - A1', price: '259', sale_price: '239', currency: 'EUR', availability: 'in_stock' });
  assert.equal(r.body.saved, 1);
  assert.deepEqual(
    manual(raw).map((m) => [m.product_id, m.combo_key, m.amount, m.currency, m.origin]),
    [['p_a1', '', '259', 'EUR', 'store_page']],
    'the regular price, never the sale price 239'
  );
  const audits = () => all<Json>(raw, "SELECT detail FROM audit_log WHERE action = 'supplier_prices.store_page_save' ORDER BY id").map((a) => JSON.parse(String(a.detail)) as Json);
  assert.deepEqual(audits(), [{ skus: 1, host: 'eu.store.bambulab.com', redirected: false, on_sale: true }]);

  // The H2C page (one object, the bare name), the variant named: its regular price.
  answer = () => fixtureResponse('eu-h2c-sale.page.html');
  const h2c = await read(app, { url: 'https://eu.store.bambulab.com/products/h2c?id=761060179809759232', save: { product_id: 'p_h2d', combo_keys: ['o:v_combo'] } });
  assert.equal(h2c.status, 200, h2c.text);
  assert.deepEqual(
    all<Json>(raw, "SELECT amount FROM supplier_price_manual WHERE product_id = 'p_h2d'").map((m) => m.amount),
    ['2449']
  );

  // A page that is no sale: no sale price answered, and the audit says so.
  answer = () => html(EU_H2D);
  const plain = await read(app, { url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329', save: { product_id: 'p_h2d', combo_keys: ['o:v_combo'] } });
  assert.equal(plain.status, 200, plain.text);
  assert.ok(plain.body.supplier_prices.offers.every((o: Json) => !('sale_price' in o)));
  assert.deepEqual(audits().map((a) => a.on_sale), [true, true, false]);
});

test('a two-block sale page: the variant’s regular price is saved, never the sale price a plain block shows; any other disagreement saves nothing (502 copies_disagree with ?id=, 400 without)', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec(`INSERT INTO products (id, slug, name) VALUES ('p_a1', 'a1', 'Bambu Lab A1');`);
  const app = appAs(raw, OWNER);
  const save = { product_id: 'p_a1', combo_keys: [''] };
  const stored = () => all<Json>(raw, 'SELECT amount, version FROM supplier_price_manual');

  answer = () => blocks(A1_PLAIN, A1_SALE);
  const r = await read(app, { url: `https://eu.store.bambulab.com/products/a1?id=${A1_ID}`, save });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.supplier_prices.offers, [{ sku_key: A1_ID, name: 'A1', price: '259', sale_price: '239', currency: 'EUR', availability: 'in_stock' }]);
  assert.equal(r.body.supplier_prices.chosen_sku_key, A1_ID);
  assert.deepEqual(stored(), [{ amount: '259', version: 1 }], 'the regular price, never the sale price 239');
  // The product page without a variant reads the same: one variant, one price.
  answer = () => blocks(A1_SALE, A1_PLAIN);
  const noId = await read(app, { url: 'https://eu.store.bambulab.com/products/a1', save });
  assert.equal(noId.status, 200, noId.text);
  assert.deepEqual(stored(), [{ amount: '259', version: 2 }]);

  // Any other disagreement: nothing is guessed, nothing saved, and the 502 says why.
  const stated299 = group('eu.store.bambulab.com', 'a1', [{ id: A1_ID, name: 'A1', price: 279, regular: 299, currency: 'EUR' }]);
  for (const [label, lds] of [
    ['two plain prices', [A1_PLAIN, A1_OTHER]],
    ['two stated prices that differ', [A1_SALE, A1_SALE_279]],
    ['a plain price that is not the stated copy’s sale price', [stated299, A1_OTHER]],
  ] as const) {
    answer = () => blocks(...lds);
    const refused = await read(app, { url: `https://eu.store.bambulab.com/products/a1?id=${A1_ID}`, save });
    assert.deepEqual([refused.status, refused.body.code, refused.body.details], [502, 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE', { reason: 'copies_disagree' }], `${label}: ${refused.text}`);
    assert.equal(refused.body.error, `${STORE_PAGE_UNREADABLE_TEXT.ar} / ${STORE_PAGE_UNREADABLE_TEXT.en}`, label);
    // The owner's sheet reads the reason off the refusal as the client receives it.
    assert.ok(isStoreCopiesDisagree(new ApiError(refused.status, refused.body.error, refused.body.code, refused.body.details)), label);
    const many = await read(app, { url: 'https://eu.store.bambulab.com/products/a1', save });
    assert.deepEqual([many.status, many.body.details], [400, { field: 'url' }], label);
    assert.deepEqual(stored(), [{ amount: '259', version: 2 }], `${label}: nothing saved`);
  }
  // Read only: both copies are answered, and none is chosen.
  answer = () => blocks(A1_PLAIN, A1_OTHER);
  const look = await read(app, { url: `https://eu.store.bambulab.com/products/a1?id=${A1_ID}` });
  assert.deepEqual([look.status, look.body.saved, look.body.supplier_prices.chosen_sku_key], [200, 0, null]);
  assert.deepEqual(look.body.supplier_prices.offers.map((o: Json) => o.price), ['239', '259']);

  // One Product whose own sku names its two prices (one node, no copies): never saved, with an id or without.
  answer = () => blocks(standalone([{ price: 279, regular: 299 }, { price: 259 }]));
  const lone = await read(app, { url: 'https://eu.store.bambulab.com/products/a1', save });
  assert.deepEqual([lone.status, lone.body.details], [400, { field: 'url' }], lone.text);
  const loneId = await read(app, { url: `https://eu.store.bambulab.com/products/a1?id=${STANDALONE_SKU}`, save });
  assert.deepEqual([loneId.status, loneId.body.details], [502, { reason: 'copies_disagree' }], loneId.text);
  assert.deepEqual(stored(), [{ amount: '259', version: 2 }], 'nothing saved');
});

test('an EU address the store sends to the US store comes back as USD and is stored as USD, never as EUR', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  answer = (url) =>
    new URL(url).hostname === 'eu.store.bambulab.com'
      ? redirect('https://us.store.bambulab.com/products/filament-buffer?ref=region-tracker-9f')
      : html(group('us.store.bambulab.com', 'filament-buffer', [{ id: '40922942079112', name: 'Filament Buffer', price: '19.99', currency: 'USD' }]));
  const r = await read(app, { url: 'https://eu.store.bambulab.com/products/filament-buffer', save: { product_id: 'p_buf', combo_keys: [''] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    calls.map((c) => c.url),
    ['https://eu.store.bambulab.com/products/filament-buffer?skr=yes', 'https://us.store.bambulab.com/products/filament-buffer?ref=region-tracker-9f']
  );
  assert.deepEqual([r.body.supplier_prices.source, r.body.supplier_prices.redirected, r.body.supplier_prices.host], ['bambu_us', true, 'us.store.bambulab.com']);
  const [saved] = manual(raw);
  assert.deepEqual([saved!.currency, saved!.amount, saved!.evidence_host], ['USD', '19.99', 'us.store.bambulab.com']);
  assert.ok(!r.text.includes('region-tracker'), 'the final address is evidence only, never answered');
});

test('the allow-list holds on every hop; a refused or challenged read, a page without offers or a currency the catalogue does not keep saves nothing (502)', async () => {
  const raw = freshDb();
  seed(raw);
  const app = appAs(raw, OWNER);
  const save = { product_id: 'p_h2d', combo_keys: ['o:v_combo'] };
  const unreadable = async (label: string, url = 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329') => {
    const r = await read(app, { url, save });
    assert.equal(r.status, 502, `${label}: ${r.text}`);
    assert.equal(r.body.code, 'PRICE_ESTIMATE_STORE_PAGE_UNREADABLE');
    assert.equal(r.body.error, `${STORE_PAGE_UNREADABLE_TEXT.ar} / ${STORE_PAGE_UNREADABLE_TEXT.en}`);
    assert.equal(r.body.details, undefined, `${label}: no reason, as before`);
    assert.ok(!isStoreCopiesDisagree(new ApiError(r.status, r.body.error, r.body.code, r.body.details)), label);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 0, `${label}: nothing saved`);
    return r;
  };

  answer = (url) => (new URL(url).hostname === 'eu.store.bambulab.com' ? redirect('https://evil.example/steal?x=1') : html(EU_H2D));
  await unreadable('off the stores');
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname), ['eu.store.bambulab.com'], 'the off-list hop is never requested');
  calls.length = 0;

  answer = (url) => (new URL(url).protocol === 'https:' && !url.includes('plain') ? redirect('http://eu.store.bambulab.com/products/h2d?plain=1') : html(EU_H2D));
  await unreadable('to http');
  assert.equal(calls.length, 1, 'the http hop is never requested');
  calls.length = 0;

  answer = () => new Response('<html>Just a moment...</html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
  await unreadable('a challenge (403)');
  answer = () => new Response('<html><title>Just a moment...</title><body>Checking your browser</body></html>', { status: 200 });
  await unreadable('a challenge page (200, no offers)');
  answer = () => {
    throw new TypeError('fetch failed');
  };
  await unreadable('a dead network');
  answer = () => html(group('eu.store.bambulab.com', 'h2d', [{ id: '111', name: 'Other', price: '1', currency: 'EUR' }]));
  await unreadable('the variant is not on the page');
  answer = () => html(group('eu.store.bambulab.com', 'h2d', [{ id: '596571526982115329', name: 'H2D', price: '1299.00', currency: 'GBP' }]));
  await unreadable('a currency the catalogue does not keep');

  // Several prices and no variant named: the owner opens a variant link instead (nothing saved, nothing guessed).
  answer = () => html(EU_H2D);
  const many = await read(app, { url: 'https://eu.store.bambulab.com/products/h2d', save });
  assert.deepEqual([many.status, many.body.details], [400, { field: 'url' }]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 0);
});

test('only the owner reads a store page; a refused caller, a bad address or a bad SKU list causes no fetch at all', async () => {
  const raw = freshDb();
  seed(raw);
  answer = () => html(EU_H2D);
  const body = { url: 'https://eu.store.bambulab.com/products/h2d?id=596571526982115329', save: { product_id: 'p_h2d', combo_keys: ['o:v_combo'] } };
  const refused = await read(appAs(raw, FULL), body);
  assert.deepEqual([refused.status, refused.body.code], [403, 'COST_ACCESS_DENIED']);
  const owner = appAs(raw, OWNER);
  const tmall = await read(owner, { url: 'https://detail.tmall.com/item.htm?id=1036834158903' });
  assert.deepEqual([tmall.status, tmall.body.details], [400, { field: 'url' }], 'Tmall is never fetched by the Worker');
  assert.equal((await read(owner, { ...body, save: { product_id: 'zz-no-such-id', combo_keys: [''] } })).status, 404);
  const badSku = await read(owner, { ...body, save: { product_id: 'p_h2d', combo_keys: ['o:v_nope'] } });
  assert.deepEqual([badSku.status, badSku.body.details], [400, { field: 'combo_keys' }]);
  const extra = await read(owner, { ...body, price: '1' });
  assert.deepEqual([extra.status, extra.body.code], [400, 'UNKNOWN_FIELD']);
  assert.equal(calls.length, 0, 'no request reached the network');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 0);
});
