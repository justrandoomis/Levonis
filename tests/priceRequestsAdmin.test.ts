/**
 * «طلب السعر» FOR THE ADMIN (DECISIONS row 240; spec §5, §7.5): the needs-pricing
 * queue ordered by demand, its «الأكثر طلباً» filter and per-selection counts,
 * and the products list's column, sort and filter.
 *
 * 250 unpublished products beside the catalog-only H2D; a handful of them
 * requested, some edited long ago. Proves:
 *   - the queue's ORDER is in SQL (distinct requesters DESC, then the latest
 *     request DESC), so the requested products are first and inside the
 *     200-row cap whatever their edit date;
 *   - `filter=most_requested` lists exactly those, and its count says so;
 *   - the per-selection breakdown names each selection in ar / en / ckb;
 *   - the products list: `price_requests` column, `sort=requests`,
 *     `requested=1` — including a PUBLISHED product with an open per-SKU
 *     request (the queue keeps its semantics, default D9);
 *   - an editor (a full admin, not the owner) sees the counts and no cost;
 *   - a database without 0193: the column is null, the sort falls back, the
 *     filter answers nothing with `requests_unavailable`.
 *
 * Run: node --import tsx --test tests/priceRequestsAdmin.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, stubApp, type StubUser } from './fixtures/app';
import { P } from './fixtures/liveCatalog';
import { publishV2 } from './fixtures/v2Publish';
import { CAT, CAT_SEL, CUSTOMER_ROLES, catalogLeaks, catalogOnlyWorld, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { statsRecompute } from '../worker/lib/priceRequests';
import { adminProductsRoutes } from '../worker/routes/adminProducts';

const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const EDITOR = CUSTOMER_ROLES.full!;

async function ask(raw: DatabaseSync, user: string, productId: string, selection: string, at: string): Promise<void> {
  raw.prepare("INSERT OR IGNORE INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, 'h', 'customer')").run(user, user, `${user}@x.co`);
  raw
    .prepare(
      `INSERT INTO product_price_requests (id, user_id, product_id, selection, requested_at, last_clicked_at, first_requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`prq_${user}_${productId}_${selection.replace(/[^a-z0-9]/gi, '')}`, user, productId, selection, at, at, at);
  const db = asD1(raw);
  await db.batch([statsRecompute(db, productId, at)]);
}

let shared: Promise<CatalogOnlyWorld> | null = null;
async function build(): Promise<CatalogOnlyWorld> {
  const w = await catalogOnlyWorld();
  const ins = w.raw.prepare(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, updated_at) VALUES (?, ?, ?, ?, ?, 'active', 0, ?)`);
  for (let i = 0; i < 250; i++) {
    const n = String(i).padStart(3, '0');
    // Newest edits first in the old order: p_bulk_249 is the most recently edited.
    ins.run(`p_bulk_${n}`, `bulk-${n}`, `Bulk ${n}`, `منتج ${n}`, `بەرهەم ${n}`, `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`);
  }
  // Edited long ago, so the old order (updated_at DESC) would put them past the cap.
  w.raw.exec("UPDATE products SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id IN ('p_bulk_000', 'p_bulk_001', 'p_bulk_002')");
  // p_bulk_000: 3 people (latest 10:00); p_bulk_001: 3 people (latest 11:00, so first); p_bulk_002: 1; the H2D: 2 people on 2 selections.
  for (const u of ['a', 'b', 'c']) await ask(w.raw, `u_${u}`, 'p_bulk_000', '', `2026-10-15T0${u === 'c' ? 10 : 9}:00:00.000Z`.replace('T010', 'T10'));
  for (const u of ['a', 'b', 'd']) await ask(w.raw, `u_${u}`, 'p_bulk_001', '', `2026-10-15T${u === 'd' ? '11' : '08'}:00:00.000Z`);
  await ask(w.raw, 'u_e', 'p_bulk_002', '', '2026-10-15T07:00:00.000Z');
  await ask(w.raw, 'u_a', CAT.id, CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey), '2026-10-14T07:00:00.000Z');
  await ask(w.raw, 'u_b', CAT.id, CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey), '2026-10-14T08:00:00.000Z');
  await ask(w.raw, 'u_b', CAT.id, CAT_SEL.key(CAT_SEL.combo, CAT_SEL.white), '2026-10-14T09:00:00.000Z');
  return w;
}
const world = () => (shared ??= build());

const admin = (w: CatalogOnlyWorld, user: StubUser = OWNER) => stubApp(w.db, user, (a) => a.route('/api/admin/products-v2', adminProductsRoutes), { publishV2: false });

test('the queue: most requested first, inside the 200-row cap, whatever the edit date', async () => {
  const w = await world();
  const res = await get(admin(w), '/api/admin/products-v2/needs-pricing');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.truncated, true, '251 unpublished products: the cap applies');
  const ids = (body.products as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids.slice(0, 4), ['p_bulk_001', 'p_bulk_000', CAT.id, 'p_bulk_002'], 'requesters DESC, then the latest request DESC');
  const first = (body.products as Array<Record<string, any>>)[0]!;
  assert.deepEqual({ people: first.requests.people, last_at: first.requests.last_at }, { people: 3, last_at: '2026-10-15T11:00:00.000Z' });
  assert.equal(body.counts.most_requested, 4);
  // After the requested ones, the old order (the latest edit first).
  const unrequested = (body.products as Array<Record<string, any>>)[4]!;
  assert.deepEqual(unrequested.requests, { people: 0, last_at: null, selections: [] });
  assert.equal(body.products.length, 20, 'a page of 20');
});

test('«الأكثر طلباً»: exactly the requested products, with a per-selection breakdown in three languages', async () => {
  const w = await world();
  const body = await json(await get(admin(w), '/api/admin/products-v2/needs-pricing?filter=most_requested'));
  const rows = body.products as Array<Record<string, any>>;
  assert.deepEqual(rows.map((r) => r.id), ['p_bulk_001', 'p_bulk_000', CAT.id, 'p_bulk_002']);
  const h2d = rows.find((r) => r.id === CAT.id)!;
  assert.equal(h2d.requests.people, 2, 'distinct people across selections');
  assert.deepEqual(
    h2d.requests.selections.map((s: Record<string, any>) => [s.selection, s.people, s.label.ar, s.label.en, s.label.ckb]),
    [
      [CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey), 2, 'H2D العادية · رمادي', 'H2D · Grey', 'H2D ئاسایی · خۆڵەمێشی'],
      [CAT_SEL.key(CAT_SEL.combo, CAT_SEL.white), 1, 'H2D كومبو · أبيض', 'H2D Combo · White', 'H2D کۆمبۆ · سپی'],
    ]
  );
  const whole = rows.find((r) => r.id === 'p_bulk_001')!;
  assert.deepEqual(whole.requests.selections[0].label, { ar: 'المنتج نفسه', en: 'The product itself', ckb: 'خودی بەرهەمەکە' });
  assert.equal(JSON.stringify(body).includes('u_a'), false, 'never who');
});

test('the products list: column, sort and filter — a published product with an open per-SKU request included', async () => {
  const w = await world();
  // A published product with an open request for a selection added after publication.
  await publishV2(w.raw, P.H2C);
  w.raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active) VALUES ('c_h2c_new', '${P.H2C}', 'Jade', 'يشمي', 'یەشم', '#00a86b', 0, 1)`);
  await ask(w.raw, 'u_f', P.H2C, 'c:c_h2c_new', '2026-10-15T12:00:00.000Z');

  const sorted = await json(await get(admin(w), '/api/admin/products-v2?sort=requests&limit=6'));
  const top = (sorted.products as Array<Record<string, any>>).map((p) => [p.id, p.price_requests]);
  assert.deepEqual(top.slice(0, 5), [
    ['p_bulk_001', 3],
    ['p_bulk_000', 3],
    [CAT.id, 2],
    [P.H2C, 1],
    ['p_bulk_002', 1],
  ]);
  const filtered = await json(await get(admin(w), '/api/admin/products-v2?requested=1&limit=50'));
  assert.equal(filtered.total, 5);
  assert.ok((filtered.products as Array<{ id: string }>).some((p) => p.id === P.H2C), 'the published product with a per-SKU request is listed');
  const plain = await json(await get(admin(w), '/api/admin/products-v2?limit=50&search=Bulk%20249'));
  assert.equal((plain.products as Array<Record<string, unknown>>)[0]?.price_requests, 0);
});

test('an editor sees the counts and no cost; neither does a request answer carry one', async () => {
  const w = await world();
  for (const path of ['/api/admin/products-v2/needs-pricing?filter=most_requested', '/api/admin/products-v2?sort=requests&limit=20']) {
    const res = await get(admin(w, EDITOR), path);
    assert.equal(res.status, 200, path);
    const body = await json(res);
    assert.deepEqual(catalogLeaks(body), [], path);
    assert.ok(JSON.stringify(body).includes('"people":3') || JSON.stringify(body).includes('"price_requests":3'), `${path}: the count is there`);
  }
});

test('a database without 0193: the column is null, the sort falls back, the filter answers nothing', async () => {
  const w = await catalogOnlyWorld({ publish: false });
  w.raw.exec('DROP TABLE product_price_request_stats; DROP TABLE product_price_requests;');
  const list = await get(admin(w), '/api/admin/products-v2?sort=requests&limit=5');
  assert.equal(list.status, 200);
  const lb = await json(list);
  assert.ok((lb.products as Array<Record<string, unknown>>).every((p) => p.price_requests === null));
  const requested = await json(await get(admin(w), '/api/admin/products-v2?requested=1'));
  assert.equal(requested.total, 0);
  assert.equal(requested.requests_unavailable, true);
  const queue = await get(admin(w), '/api/admin/products-v2/needs-pricing');
  assert.equal(queue.status, 200);
  const qb = await json(queue);
  assert.ok((qb.products as Array<Record<string, unknown>>).every((r) => r.requests === null));
  const most = await json(await get(admin(w), '/api/admin/products-v2/needs-pricing?filter=most_requested'));
  assert.deepEqual(most.products, []);
  assert.equal(most.requests_unavailable, true);
});
