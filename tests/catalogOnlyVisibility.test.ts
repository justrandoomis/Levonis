/**
 * CATALOG-ONLY: SHOWN EVERYWHERE A SHOPPER LOOKS, WITH NO NUMBER (DECISIONS
 * rows 239 (3) and 240; spec §7.2).
 *
 * The live catalogue with every product V2-published except the H2D, which
 * carries a LEGACY SENTINEL on every money column (tests/fixtures/catalogOnly.ts).
 * For every role that reaches a customer route — signed out, a customer, a
 * PRIME and a PRO member, an assistant and a full admin — the H2D:
 *   - is listed (after every priced product), searchable, on its section's
 *     page, its own page answers, the comparison and the printer finder take
 *     it, the home's new arrivals fill an empty slot with it, and «يناسب»
 *     names it on an accessory's page;
 *   - says `price_status: 'unpriced'` with every price null — never 0 — and
 *     carries no availability, stock or sale types;
 *   - and NO answer carries any legacy sentinel, cost, FINANCIAL_FIELDS key or
 *     price step anywhere (the `leaks` walk with the sentinels added).
 * The public API (list, detail, `/context`), the sitemap, the bot preview,
 * both favourites lists, the community suggestions and the RPC index feed say
 * the same.
 *
 * Run: node --import tsx --test tests/catalogOnlyVisibility.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, put } from './fixtures/app';
import { P } from './fixtures/liveCatalog';
import { CAT, CUSTOMER_ROLES, LEGACY_NUMBERS, catalogLeaks, catalogOnlyWorld, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { CatalogEntrypoint } from '../worker/entrypoints/CatalogEntrypoint';
import { priceSubtitle } from '../worker/routes/support';
import { toSearchDoc } from '../worker/lib/search/document';
import { planSearchIndex } from '../worker/lib/search/store';

let shared: Promise<CatalogOnlyWorld> | null = null;
const world = () => (shared ??= catalogOnlyWorld());

type Card = Record<string, unknown>;

/** The keys a catalog-only card never carries a value under (spec §3.1). */
const NEVER_ON_UNPRICED = [
  'display_regular_iqd',
  'display_prime_iqd',
  'display_pro_iqd',
  'display_applied_tier',
  'prime_price_iqd',
  'pro_price_iqd',
  'original_price_iqd',
  'membership_prices',
  'stock',
  'direct_stock_available',
  'sale_types',
  'selling_type',
  'offer',
  'payment_options',
] as const;

function assertUnpricedCard(card: Card | undefined, where: string): void {
  assert.ok(card, `${where}: the catalog-only printer is shown`);
  assert.equal(card.price_status, 'unpriced', `${where}: price_status`);
  assert.equal(card.price_iqd ?? null, null, `${where}: price_iqd is null, never 0`);
  assert.equal(card.display_price_iqd ?? null, null, `${where}: display_price_iqd is null, never 0`);
  for (const k of NEVER_ON_UNPRICED) {
    assert.ok(!(k in card) || card[k] === null, `${where}: ${k} = ${JSON.stringify(card[k])}`);
  }
}

function assertClean(body: unknown, where: string): void {
  const found = catalogLeaks(body);
  assert.deepEqual(found, [], `${where}: ${found.slice(0, 5).join('; ')}`);
}

const productsOf = (body: Record<string, unknown>): Card[] => (body.products ?? body.items ?? []) as Card[];

test('the listing: shown to every role, after every priced product, with no number and no sentinel', async () => {
  const w = await world();
  for (const [role, user] of Object.entries(CUSTOMER_ROLES)) {
    const res = await get(w.as(user), '/api/products');
    assert.equal(res.status, 200, role);
    const body = await json(res);
    assertClean(body, `${role} /api/products`);
    const list = productsOf(body);
    assert.equal(list.length, 14, `${role}: the 13 priced products and the catalog-only one`);
    assertUnpricedCard(
      list.find((p) => p.id === CAT.id),
      `${role} listing`
    );
    // R1: a stable partition — every priced card first, the catalog-only one after them.
    const firstUnpriced = list.findIndex((p) => p.price_status === 'unpriced');
    assert.equal(firstUnpriced, list.length - 1, `${role}: the catalog-only card comes after every priced card`);
    for (const p of list.slice(0, firstUnpriced)) {
      assert.equal(p.price_status, 'priced', `${role}: ${String(p.slug)}`);
      assert.ok(Number(p.display_price_iqd) > 0, `${role}: a priced card shows its number (${String(p.slug)})`);
    }
  }
});

test('search, the section page, the product page, the comparison and the finder take it, for every role', async () => {
  const w = await world();
  for (const [role, user] of Object.entries(CUSTOMER_ROLES)) {
    const app = w.as(user);

    const search = await json(await get(app, '/api/products?search=Catalog'));
    assertClean(search, `${role} search`);
    assertUnpricedCard(
      productsOf(search).find((p) => p.id === CAT.id),
      `${role} search`
    );

    const section = await get(app, '/api/catalog/fdm-printers');
    assert.equal(section.status, 200, role);
    const sectionBody = await json(section);
    assertClean(sectionBody, `${role} section page`);
    assert.ok(JSON.stringify(sectionBody).includes(CAT.id), `${role}: the section page lists it`);

    const page = await get(app, `/api/products/${CAT.slug}`);
    assert.equal(page.status, 200, `${role}: its page answers`);
    const pageBody = await json(page);
    assertClean(pageBody, `${role} product page`);
    assert.equal(pageBody.price_status, 'unpriced');
    assertUnpricedCard(pageBody.product as Card, `${role} product page card`);
    for (const k of ['pricing', 'membership_preview', 'price_levels', 'pricing_modes', 'availability', 'initial_selection', 'condition_reference']) {
      assert.equal(pageBody[k] ?? null, null, `${role}: page.${k} is null`);
    }
    assert.deepEqual(pageBody.warranty_plans ?? [], [], `${role}: no priced warranty plan`);
    // The catalogue itself is there: options, colours and the spec sheet.
    const product = pageBody.product as { options: Array<Record<string, unknown>>; colors: Array<Record<string, unknown>>; spec_fields: Record<string, string> };
    assert.deepEqual(product.options.map((o) => o.id), ['v_cat_std', 'v_cat_combo']);
    assert.deepEqual(product.colors.map((c) => c.id), ['c_cat_grey', 'c_cat_white']);
    for (const o of [...product.options, ...product.colors]) {
      for (const k of Object.keys(o)) assert.ok(!/price|stock|_iqd$/.test(k), `${role}: an option or colour carries ${k}`);
    }
    assert.equal(product.spec_fields.technology, 'FDM');
    const relations = JSON.stringify(pageBody.relations ?? {});
    assert.ok(!/"available"|"stock_state"|"stock"/.test(relations), `${role}: the relations carry no stock claim`);

    const compare = await get(app, `/api/compare?ids=${CAT.id},${P.H2C}`);
    assert.equal(compare.status, 200, `${role}: the comparison takes it`);
    const compareBody = await json(compare);
    assertClean(compareBody, `${role} compare`);
    const column = (compareBody.products as Card[]).find((p) => p.id === CAT.id);
    assert.equal(column?.price_status, 'unpriced');
    assert.equal(column?.price_iqd, null);

    const finder = await get(app, '/api/printer-finder?use=unsure&tech=any&budget=any&sale=any&prio=none&level=beginner');
    assert.equal(finder.status, 200);
    const finderBody = await json(finder);
    assertClean(finderBody, `${role} finder`);
    assert.ok(JSON.stringify(finderBody).includes(CAT.id), `${role}: the finder offers it with no budget`);
    // With a budget it cannot be in it: it has no price.
    const budgeted = await json(await get(app, '/api/printer-finder?use=unsure&tech=any&budget=2500000-&sale=any&prio=none&level=beginner'));
    assertClean(budgeted, `${role} finder with a budget`);
    const inResults = ((budgeted.results ?? []) as Array<{ card: Card }>).some((r) => r.card.id === CAT.id);
    assert.equal(inResults, false, `${role}: a budget excludes a product with no price`);
  }
});

test('the home: new arrivals fill an empty slot with it, after the priced ones; no commercial shelf shows it', async () => {
  const w = await world();
  for (const [role, user] of Object.entries(CUSTOMER_ROLES)) {
    const res = await get(w.as(user), '/api/home');
    assert.equal(res.status, 200);
    const body = await json(res);
    assertClean(body, `${role} home`);
    const latest = (body.latest ?? body.products ?? []) as Card[];
    const at = latest.findIndex((p) => p.id === CAT.id);
    assert.ok(at >= 0, `${role}: 13 priced products leave a slot of 20 free`);
    assertUnpricedCard(latest[at], `${role} home latest`);
    assert.ok(latest.slice(0, at).every((p) => p.price_status === 'priced'), `${role}: priced first`);
    for (const [shelf, items] of Object.entries(body)) {
      if (shelf === 'latest' || shelf === 'products' || !Array.isArray(items)) continue;
      assert.ok(!JSON.stringify(items).includes(CAT.id), `${role}: the ${shelf} shelf is for priced products only`);
    }
  }
});

test('the public API: listed and detailed as unpriced, purchase null, no combination, no number', async () => {
  const w = await world();
  const app = w.as(null);
  const list = await json(await get(app, '/api/public/v1/products?limit=50'));
  assertClean(list, 'public list');
  const row = (list.data as Array<Record<string, any>>).find((p) => p.slug === CAT.slug);
  assert.ok(row, 'the public list names it');
  assert.equal(row.price.status, 'unpriced');
  assert.equal(row.price.amount, null);

  const detail = await get(app, `/api/public/v1/products/${CAT.slug}`);
  assert.equal(detail.status, 200);
  const d = (await json(detail)).data as Record<string, any>;
  assertClean(d, 'public detail');
  assert.equal(d.price.status, 'unpriced');
  assert.equal(d.price.amount, null);
  assert.equal(d.purchase, null);
  assert.deepEqual(d.combinations, []);
  assert.deepEqual(d.availability, { state: 'unknown', quantity: null, low_stock: false, sale_modes: [] });
  for (const o of [...d.options, ...d.colors]) {
    assert.equal(o.price, null);
    assert.equal(o.regular_price, null);
    assert.equal(o.from, false);
  }
  assert.equal(d.options.length, 2, 'its options are public');

  const context = await json(await get(app, '/api/public/v1/context'));
  assertClean(context, 'public context');
  const counts = JSON.stringify(context);
  assert.match(counts, /"products_priced":13\b/, 'the context says how many are priced');
});

test('the sitemap names it and the bot preview carries no offer, no price and no sentinel', async () => {
  const w = await world();
  const sitemap = await (await w.guest('/sitemap.xml')).text();
  assert.ok(sitemap.includes(`/product/${CAT.slug}`), 'the sitemap names a VISIBLE product');
  const preview = await w.guest(`/product/${CAT.slug}`, { headers: { 'user-agent': 'facebookexternalhit/1.1' } });
  const html = await preview.text();
  assert.match(html, /og:title" content="طابعة الكتالوج H2D"/);
  assert.doesNotMatch(html, /Offer|product:price|og:price/);
  for (const n of LEGACY_NUMBERS) {
    assert.ok(!html.includes(String(n)) && !html.includes(n.toLocaleString('en-US')), `the preview carries ${n}`);
  }
});

test('both favourites lists show it unpriced; the community suggestions find it', async () => {
  const w = await world();
  const customer = w.as(CUSTOMER_ROLES.customer);
  assert.equal((await put(customer, `/api/profile/favorites/${CAT.id}`, {})).status, 200);
  const favourites = await json(await get(customer, '/api/profile/favorites'));
  assertClean(favourites, 'profile favourites');
  assertUnpricedCard(
    (favourites.favorites as Card[]).find((p) => p.id === CAT.id),
    'profile favourites'
  );
  const community = await json(await get(customer, '/api/community-favorites'));
  assertClean(community, 'community favourites');
  const item = (community.items as Card[]).find((p) => p.product_id === CAT.id);
  assert.ok(item, 'the community list unions the catalogue favourites');
  assert.equal(item.price_status, 'unpriced');
  assert.equal(item.price_iqd, null);
  assert.equal(item.original_price_iqd, null);
  assert.equal(item.in_stock, null, 'no stock claim');

  w.raw.exec(`INSERT OR REPLACE INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}')`);
  await w.db.batch(planSearchIndex(w.db, toSearchDoc({ id: CAT.id, name: CAT.name, name_ar: 'طابعة الكتالوج H2D' })));
  const suggest = await get(w.as(null), '/api/community/search/suggest?q=Catalog');
  assert.equal(suggest.status, 200);
  const suggestBody = await json(suggest);
  assertClean(suggestBody, 'community suggest');
  assert.ok(JSON.stringify(suggestBody).includes(CAT.slug), 'the community suggestions name a VISIBLE product');
});

test('«يناسب»: an accessory’s page names the catalog-only printer it fits', async () => {
  const w = await world();
  w.raw.exec(`INSERT OR IGNORE INTO product_printer_fits (product_id, printer_id, position) VALUES ('${P.PLA}', '${CAT.id}', 0)`);
  const slug = (w.raw.prepare('SELECT slug FROM products WHERE id = ?').get(P.PLA) as { slug: string }).slug;
  for (const [role, user] of Object.entries(CUSTOMER_ROLES)) {
    const body = await json(await get(w.as(user), `/api/products/${slug}`));
    assertClean(body, `${role} accessory page`);
    assert.deepEqual(
      ((body.fits_printers ?? []) as Card[]).map((p) => p.id),
      [CAT.id],
      `${role}: «يناسب» names it`
    );
    assert.equal(body.price_status, 'priced', 'the accessory itself is priced');
  }
});

test('the RPC index feed: listed, unpriced, no price', async () => {
  const w = await world();
  const rpc = new CatalogEntrypoint({ waitUntil() {}, passThroughOnException() {} } as never, { DB: w.db } as never);
  const { rows } = await rpc.listForIndex(null);
  assertClean(rows, 'rpc feed');
  const row = rows.find((r) => r.product_id === CAT.id);
  assert.ok(row);
  assert.equal(row.listed, true);
  assert.equal(row.price_status, 'unpriced');
  assert.equal(row.price_iqd, null);
  const priced = rows.filter((r) => r.price_status === 'priced');
  assert.equal(priced.length, 13);
  assert.ok(priced.every((r) => Number(r.price_iqd) > 0));
});

test('the quote refuses it at the door: 409 PRICE_NOT_AVAILABLE, no number', async () => {
  const w = await world();
  for (const [role, user] of Object.entries(CUSTOMER_ROLES)) {
    const res = await w.as(user).request(`/api/products/${CAT.slug}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
      body: JSON.stringify({ qty: 1, option_value_ids: ['v_cat_std'], color_id: 'c_cat_grey' }),
    });
    assert.equal(res.status, 409, role);
    const body = await json(res);
    assertClean(body, `${role} quote`);
    assert.equal(body.code, 'PRICE_NOT_AVAILABLE');
  }
});

test('the assistant card of an unpriced product says the sentence once — never «السعر: السعر غير متوفر»', () => {
  const words = { ar: 'السعر', en: 'Price', ckb: 'نرخ' } as const;
  for (const loc of ['ar', 'en', 'ckb'] as const) {
    const none = priceSubtitle(loc, null);
    assert.equal(none.split(words[loc]).length - 1, 1, `${loc}: «${none}»`);
    assert.doesNotMatch(none, /[0-9٠-٩]/);
    assert.equal(priceSubtitle(loc, 0), none, 'never a 0');
    assert.match(priceSubtitle(loc, 1_250_000), /1,250,000/);
  }
  assert.equal(priceSubtitle('en', null), 'Price not available yet');
});
