/**
 * THE STORE CONNECTOR AND THE CATALOGUE WATCH — read-only, through the public
 * card path (spec §9, §10; acceptance 2; docs/CREATIVE_STUDIO.md §5).
 *
 *   - unpriced is never 0, a pre-order is never 'available', a membership
 *     teaser is never the public price;
 *   - an option's snapshot carries ITS price, ITS availability and ITS
 *     pictures — never a sibling's (the Combo picture never rides with the
 *     single printer's price);
 *   - no cost, profit, supplier, stock-count or sales key or value leaves;
 *   - the first catalogue sync is a baseline and announces nothing; arrivals
 *     and back-in-stock need a documented transition;
 *   - a full studio flow writes no store table.
 *
 * Run: node --import tsx --test tests/creativeStudioStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, get, json as body, post } from './fixtures/app';
import { publishSeededV2 } from './fixtures/autoPublish';
import { BASE, deepStrings, studioApp, studioDb } from './fixtures/creativeStudio';
import { availabilityOfCard, priceOfCard } from '../worker/lib/creative/store';

const COST_WORDS = /cost|profit|margin|supplier|purchase|stock|reserved|sold|investor|landed|fx_rate|_usd_cents/i;

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); keysDeep(v, out); }
  return out;
}

test('the product list and detail: guest prices through the card, unpriced never 0, a pre-order never available', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const list = await body(await get(app, `${BASE}/products?limit=50`));
  const byId = new Map(list.products.map((p: { id: string }) => [p.id, p]));
  const printer = byId.get('p_print') as Record<string, unknown>;
  const unpriced = byId.get('p_unpriced') as Record<string, unknown>;
  const pre = byId.get('p_pre') as Record<string, unknown>;
  assert.ok(printer && unpriced && pre, 'the three visible products are listed');
  assert.equal(printer.price_status, 'priced');
  assert.ok((printer.display_price_iqd as number) > 0);
  assert.equal(printer.has_variants, true);
  assert.equal(unpriced.price_status, 'unpriced');
  assert.equal(unpriced.display_price_iqd, null, 'never 0');
  assert.equal(unpriced.availability, 'unknown');
  assert.equal(pre.availability, 'preorder', 'a pre-order is never available');

  const detail = await body(await get(app, `${BASE}/products/p_print`));
  assert.equal(detail.path, '/product/a1-printer');
  assert.deepEqual(detail.brand, { ar: 'بامبو لاب', en: 'Bambu Lab', ckb: 'بامبو لاب' });
  assert.equal(detail.images.length, 3);
  assert.deepEqual(detail.images.map((i: { variant_key: string | null }) => i.variant_key), [null, 'ov:ov_a1', 'ov:ov_combo']);
  assert.ok(detail.images.every((i: { same_origin: boolean }) => i.same_origin));
  const [a1, combo] = detail.variants;
  assert.equal(a1.key, 'ov:ov_a1');
  assert.deepEqual(a1.images.map((i: { url: string }) => i.url), ['/files/products/p_print/main.webp', '/files/products/p_print/a1.webp']);
  assert.deepEqual(combo.images.map((i: { url: string }) => i.url), ['/files/products/p_print/main.webp', '/files/products/p_print/combo.webp']);
  assert.equal(a1.price.status, 'priced');
  assert.ok(combo.price.amount_iqd > a1.price.amount_iqd, 'each option carries its own price');
  assert.equal(a1.availability, 'available', 'its own stock');
  assert.equal(combo.availability, 'unavailable', 'a sibling\'s stock is never this option\'s');
  assert.equal(detail.availability, 'available', 'the product as a whole has stock');

  const missing = await get(app, `${BASE}/products/p_nope`);
  assert.equal(missing.status, 404);
  assert.equal((await body(missing)).code, 'NOT_FOUND');
});

test('an option snapshot: its own price and pictures; the product snapshot: product-wide pictures only; a hash over canonical JSON', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const combo = await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: 'ov:ov_combo' }));
  assert.equal(combo.source, 'live');
  assert.match(combo.hash, /^[0-9a-f]{64}$/);
  assert.equal(combo.data.variant_key, 'ov:ov_combo');
  assert.deepEqual(combo.data.variant_label, { ar: 'A1 كومبو', en: 'A1 Combo', ckb: 'A1 کۆمبۆ' });
  assert.deepEqual(combo.data.images.map((i: { url: string }) => i.url), ['/files/products/p_print/main.webp', '/files/products/p_print/combo.webp']);
  const whole = await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: null }));
  assert.deepEqual(whole.data.images.map((i: { url: string }) => i.url), ['/files/products/p_print/main.webp'], 'a bound picture needs its option');
  assert.ok(combo.data.price.amount_iqd > whole.data.price.amount_iqd || whole.data.price.from === true);
  const wrong = await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: 'ov:ov_ghost' });
  assert.equal(wrong.status, 404);
  const malformed = await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: 'c:c_blk' });
  assert.equal(malformed.status, 400);
  // Read back, unchanged.
  const again = await body(await get(app, `${BASE}/snapshots/${combo.id}`));
  assert.equal(again.hash, combo.hash);
  const unpriced = await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_unpriced', variant_key: null }));
  assert.deepEqual(unpriced.data.price, { status: 'unpriced', amount_iqd: null, regular_iqd: null, from: false, offer: null, member_price_iqd: null });
  assert.equal(unpriced.data.availability, 'unknown');
});

test('no cost, profit, supplier, stock-count or sales key — and no cost value — leaves the studio', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const answers = [
    await body(await get(app, `${BASE}/products?limit=50`)),
    await body(await get(app, `${BASE}/products/p_print`)),
    await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: 'ov:ov_a1' })),
    await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_unpriced', variant_key: null })),
  ];
  for (const a of answers) {
    const bad = keysDeep(a).filter((k) => COST_WORDS.test(k));
    assert.deepEqual(bad, [], 'a private key in a studio answer');
    for (const cost of ['777777', '111111', '222222']) assert.ok(!deepStrings(a).includes(cost), `the seeded cost ${cost} leaked`);
  }
  for (const r of all(raw, 'SELECT data_json FROM creative_product_snapshots')) {
    assert.deepEqual(keysDeep(JSON.parse(String(r.data_json))).filter((k) => COST_WORDS.test(k)), []);
  }
});

test('the card mapping: members-only, membership teasers and offers are kept apart (unit)', () => {
  assert.deepEqual(priceOfCard({ price_status: 'unpriced', display_price_iqd: null }), { status: 'unpriced', amount_iqd: null, regular_iqd: null, from: false, offer: null, member_price_iqd: null });
  assert.equal(priceOfCard({ price_status: 'priced', display_price_iqd: 0 }).status, 'unpriced', 'a zero is not a price');
  assert.equal(priceOfCard({ locked: true, display_price_iqd: 500000 }).status, 'members_only');
  assert.equal(priceOfCard({ locked: true, display_price_iqd: 500000 }).amount_iqd, null);
  const teaser = priceOfCard({ price_status: 'priced', display_price_iqd: 900000, display_regular_iqd: 900000, display_pro_iqd: 850000, display_prime_iqd: 870000 });
  assert.equal(teaser.amount_iqd, 900000, 'the public price is the guest price');
  assert.equal(teaser.member_price_iqd, 850000, 'the teaser lives apart');
  const live = { schedule_state: 'live', price_source: 'offer', locked: false, required_tiers: [], starts_at: null, ends_at: '2026-12-01T00:00:00Z' };
  const offer = priceOfCard({ price_status: 'priced', display_price_iqd: 800000, display_offer_before_iqd: 900000, offer: live });
  assert.deepEqual(offer.offer, { starts_at: null, ends_at: '2026-12-01T00:00:00.000Z' });
  assert.equal(offer.regular_iqd, 900000);
  const members = priceOfCard({ price_status: 'priced', display_price_iqd: 900000, display_offer_before_iqd: 950000, offer: { ...live, locked: true, required_tiers: ['plus'] } });
  assert.equal(members.offer, null, 'a members-only window is not an offer to a guest');
  assert.equal(members.regular_iqd, null);
  assert.equal(availabilityOfCard({ sale_types: ['pre_order'], direct_stock_available: null }, { composition: '' }), 'preorder');
  assert.equal(availabilityOfCard({ sale_types: ['direct_sale', 'pre_order'], direct_stock_available: 0 }, { composition: '' }), 'preorder');
  assert.equal(availabilityOfCard({ price_status: 'unpriced', sale_types: ['direct_sale'], direct_stock_available: 4 }, { composition: '' }), 'unknown');
  assert.equal(availabilityOfCard({ availability_state: 'preorder' }, { composition: 'bundle' }), 'preorder');
});

async function sync(app: ReturnType<typeof studioApp>) {
  const res = await post(app, `${BASE}/watch/sync`, {});
  assert.equal(res.status, 200);
  return body(res);
}

function addProduct(raw: DatabaseSync, id: string, stock: number) {
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,inventory_mode,ops_policy)
     VALUES (?, ?, ?, ?, 50000, 'active', ?, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', 'BASE', '{}')`
  ).run(id, id.replace(/_/g, '-'), `Product ${id}`, `منتج ${id}`, stock);
}

test('acceptance 2: the first catalogue sync is a baseline that announces nothing; then arrivals and back-in-stock need a documented transition', async () => {
  const raw = await studioDb(true);
  addProduct(raw, 'p_empty', 0);
  await publishSeededV2(raw);
  const app = studioApp(raw, OWNER);
  const first = await sync(app);
  assert.equal(first.baseline, true);
  assert.equal(first.baseline_complete, true);
  assert.equal(first.arrivals, 0, 'the first sync never says everything arrived today');
  assert.equal(first.back_in_stock, 0);
  assert.ok(first.processed >= 4);
  assert.equal(all(raw, 'SELECT * FROM creative_events').length, 0);
  assert.ok(all(raw, 'SELECT * FROM creative_catalog_watch').every((r) => r.baseline === 1));
  const before = await body(await get(app, `${BASE}/opportunities`));
  assert.ok(!before.opportunities.some((o: { kind: string }) => o.kind === 'arrival' || o.kind === 'back_in_stock'));

  // A description change is not an arrival.
  raw.exec(`UPDATE products SET description = 'new words' WHERE id = 'p_print'`);
  // A new product, and the empty one restocked.
  addProduct(raw, 'p_new', 3);
  raw.exec(`UPDATE products SET stock = 4 WHERE id = 'p_empty'`);
  await publishSeededV2(raw);
  const second = await sync(app);
  assert.equal(second.baseline, false);
  assert.equal(second.arrivals, 1);
  assert.equal(second.back_in_stock, 1);
  const events = all(raw, 'SELECT product_id, kind FROM creative_events ORDER BY kind');
  assert.deepEqual(events.map((e) => `${e.kind}:${e.product_id}`), ['arrival:p_new', 'back_in_stock:p_empty']);
  const after = await body(await get(app, `${BASE}/opportunities`));
  const kinds = after.opportunities.map((o: { id: string }) => o.id);
  assert.ok(kinds.includes('arrival:p_new') && kinds.includes('back_in_stock:p_empty'));
  assert.ok(kinds.includes('education_topic:first_print'));
  // A third sync with nothing new announces nothing again.
  const third = await sync(app);
  assert.equal(third.arrivals + third.back_in_stock, 0);
});

test('a pre-order product turning available through stock is back in stock only from a recorded unavailable state', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  await sync(app);
  // p_pre was 'preorder' at the baseline: preorder → available is not a documented unavailable → available transition.
  raw.exec(`UPDATE products SET sale_types = '["direct_sale","pre_order"]', stock = 2 WHERE id = 'p_pre'`);
  const next = await sync(app);
  assert.equal(next.back_in_stock, 0);
});

const STORE_TABLES = ['products', 'product_images', 'product_option_values', 'product_option_groups', 'product_pricing_state', 'pricing_v2_sku_results', 'product_sku_prices', 'offer_windows', 'brands', 'catalogs'];

function storeFingerprint(raw: DatabaseSync): string {
  return STORE_TABLES.map((t) => {
    try {
      return `${t}:${JSON.stringify(all(raw, `SELECT * FROM ${t} ORDER BY rowid`))}`;
    } catch {
      return `${t}:absent`;
    }
  }).join('\n');
}

test('a full studio flow writes no store table', async () => {
  const raw = await studioDb(true);
  const app = studioApp(raw, OWNER);
  const before = storeFingerprint(raw);
  await get(app, `${BASE}/products?limit=50`);
  await get(app, `${BASE}/products/p_print`);
  const snap = await body(await post(app, `${BASE}/snapshots`, { product_id: 'p_print', variant_key: 'ov:ov_a1' }));
  await post(app, `${BASE}/snapshots/${snap.id}/verify`, {});
  await sync(app);
  await get(app, `${BASE}/opportunities`);
  await post(app, `${BASE}/documents`, { title: 'x', content: { schema_version: 1, format: { id: 'square', width: 1080, height: 1080 } } });
  assert.equal(storeFingerprint(raw), before, 'the studio changed a store table');
});
