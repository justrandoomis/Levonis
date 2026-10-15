/**
 * «طلب السعر» — TELLING THE PEOPLE WHO ASKED (DECISIONS row 240; spec §4.6,
 * §7.5; worker/lib/priceRequests.ts `sweepPriceRequests`).
 *
 * The sweep is the one authority for «open → notified / closed(priced)»,
 * because a product or a selection becomes sellable through many doors (the
 * first V2 write, a later one adding SKU rows, FX-5, the completeness hold
 * lifting, the owner's switch going off). Proves, on the catalog-only world:
 *   - while nothing is priced, a pass only moves the cursor;
 *   - once the product sells, a consenting request becomes `notified` with an
 *     in-app row (Arabic and English, its Sorani in `meta.title_ckb` /
 *     `meta.body_ckb`, never the Arabic pasted across) and an outbox row per
 *     reachable channel, all under `price_available:<id>:<cycle>`; a request
 *     without consent is `closed(priced)` and nobody is told; a second pass is
 *     a no-op;
 *   - per SKU: a colour added after publication waits while its siblings are
 *     told, and is told when its own price arrives;
 *   - a sale hold (the completeness switch) keeps a request waiting; lifting
 *     it lets the next pass tell;
 *   - the pass spends no statement its budget did not grant (counted on the
 *     D1 itself), takes ten products a pass, and the cursor carries the rest;
 *     the quarter-hour tick stays at or under 950 with the sweep last.
 *
 * Run: node --import tsx --test tests/priceRequestsSweep.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../worker/lib/types';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, freshDb, json, post, row } from './fixtures/app';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { P } from './fixtures/liveCatalog';
import { publishV2 } from './fixtures/v2Publish';
import { CAT, CAT_SEL, CUSTOMER_ROLES, catalogOnlyWorld, type CatalogOnlyWorld } from './fixtures/catalogOnly';
import { priceAvailableEventKey, sweepPriceRequests, type PriceRequestBudget } from '../worker/lib/priceRequests';
import { PRICE_REQUEST_TICK_BUDGET, QUARTER_HOUR_TICK_LIMIT, quarterHourPriceRequestBudget } from '../worker/lib/quarterHourBudget';
import { PRICE_AVAILABLE_TEXT } from '@levonis/contracts/priceRequests';

const U1 = P.U1;

const budget = (limit: number): PriceRequestBudget & { used: () => number } => {
  let used = 0;
  return {
    canSpend: (n) => used + n <= limit,
    spend: (n) => (used + n > limit ? false : ((used += n), true)),
    remaining: () => limit - used,
    used: () => used,
  };
};

const envOf = (w: { db: D1Database }) =>
  ({
    DB: w.db,
    APP_ORIGIN: 'https://levonis-iq.com',
    EMAIL_API_KEY: 're_k',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  }) as unknown as Env;

const request = (w: CatalogOnlyWorld, user: keyof typeof CUSTOMER_ROLES, body: Record<string, unknown>) =>
  post(w.as(CUSTOMER_ROLES[user]), '/api/price-requests', body);

const reqRow = (raw: DatabaseSync, user: string, productId: string, selection: string) =>
  row<Record<string, unknown>>(raw, 'SELECT * FROM product_price_requests WHERE user_id = ? AND product_id = ? AND selection = ?', user, productId, selection)!;

const statsEqualSource = (raw: DatabaseSync, productId: string) => {
  const stored = row<Record<string, unknown>>(raw, 'SELECT requesters, selections, clicks FROM product_price_request_stats WHERE product_id = ?', productId);
  const source = row<Record<string, unknown>>(
    raw,
    `SELECT COUNT(DISTINCT user_id) AS requesters, COUNT(DISTINCT selection) AS selections, COALESCE(SUM(click_count), 0) AS clicks
       FROM product_price_requests WHERE product_id = ? AND state = 'open'`,
    productId
  );
  assert.deepEqual(stored, source, `the stats of ${productId} are a recount of the source`);
};

let shared: Promise<CatalogOnlyWorld> | null = null;
async function build(): Promise<CatalogOnlyWorld> {
  const w = await catalogOnlyWorld({ alsoUnpriced: [U1] });
  const grey = { option_value_ids: [CAT_SEL.std], color_id: CAT_SEL.grey };
  for (const [user, body] of [
    ['customer', { product_id: CAT.id, ...grey, notify: true }],
    ['prime', { product_id: CAT.id, ...grey }],
    ['pro', { product_id: CAT.id, option_value_ids: [CAT_SEL.combo], color_id: CAT_SEL.white, notify: true }],
    ['customer', { product_id: U1, notify: true }],
  ] as const) {
    const res = await request(w, user, body);
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  }
  return w;
}
const world = () => (shared ??= build());

test('nothing priced yet: a pass only moves the cursor', async () => {
  const w = await world();
  const report = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(report.products, 2);
  assert.deepEqual([report.notified, report.closed, report.priced], [0, 0, 0]);
  const rows = all<{ state: string; checked_at: string }>(w.raw, 'SELECT state, checked_at FROM product_price_requests');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.state === 'open' && r.checked_at > ''), 'every row waits, its cursor moved');
  assert.equal(all(w.raw, "SELECT id FROM user_notifications WHERE kind = 'price_available'").length, 0);
});

test('the price arrives: the consenting customer is told (in-app with real Sorani, and by email), the rest closed; a second pass is a no-op', async () => {
  const w = await world();
  await publishV2(w.raw, U1);
  const report = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(report.notified, 1);
  const r = reqRow(w.raw, 'u_cust', U1, '');
  assert.equal(r.state, 'notified');
  assert.ok(String(r.priced_at) > '' && String(r.notified_at) > '');

  const key = priceAvailableEventKey(String(r.id), 1);
  const note = row<Record<string, unknown>>(w.raw, 'SELECT * FROM user_notifications WHERE user_id = ? AND event_key = ?', 'u_cust', key)!;
  assert.ok(note, 'one in-app row');
  assert.equal(note.kind, 'price_available');
  assert.equal(note.title_ar, PRICE_AVAILABLE_TEXT.title.ar);
  assert.equal(note.title_en, PRICE_AVAILABLE_TEXT.title.en);
  const slug = row<{ slug: string }>(w.raw, 'SELECT slug FROM products WHERE id = ?', U1)!.slug;
  assert.equal(note.link, `/product/${slug}`);
  assert.equal(note.entity_type, 'product');
  assert.equal(note.entity_id, U1);
  const meta = JSON.parse(String(note.meta)) as Record<string, string>;
  assert.equal(meta.title_ckb, PRICE_AVAILABLE_TEXT.title.ckb);
  assert.ok(meta.body_ckb.includes('ئێستا دەتوانیت نرخەکە ببینیت'), 'the Sorani body');
  assert.notEqual(meta.title_ckb, note.title_ar);
  assert.notEqual(meta.body_ckb, note.body_ar, 'the Sorani is never the Arabic pasted across');
  assert.ok(!JSON.stringify(note).includes('u_prime'), 'no one else');
  const outbox = all<{ event_key: string; kind: string }>(w.raw, 'SELECT event_key, kind FROM outbox WHERE event_key LIKE ?', `${key}:%`);
  assert.deepEqual(outbox.map((o) => o.event_key), [`${key}:email`], 'one outbox row for the one reachable channel');

  // The H2D is still unpriced: its three requests wait.
  assert.equal(reqRow(w.raw, 'u_cust', CAT.id, CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey)).state, 'open');

  // A second pass changes nothing.
  const counts = () => [
    all(w.raw, 'SELECT id FROM user_notifications').length,
    all(w.raw, 'SELECT id FROM outbox').length,
    JSON.stringify(all(w.raw, 'SELECT id, state FROM product_price_requests ORDER BY id')),
  ];
  const before = counts();
  const again = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(again.notified + again.closed + again.priced, 0);
  assert.deepEqual(counts(), before);
  statsEqualSource(w.raw, U1);
});

test('per SKU: a colour added after publication waits while its siblings are told, and is told when its own price arrives', async () => {
  const w = await world();
  await publishV2(w.raw, CAT.id);
  // The structure-only save of a new colour: no SKU price row for it.
  w.raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active)
              VALUES ('c_cat_blue', '${CAT.id}', 'Blue', 'أزرق', 'شین', '#0000ff', 3, 1)`);
  const blue = await request(w, 'customer', { product_id: CAT.id, option_value_ids: [CAT_SEL.std], color_id: 'c_cat_blue', notify: true });
  assert.equal(blue.status, 200, 'an unpriced SKU of a sellable product can be asked about');
  const priced = await request(w, 'prime', { product_id: CAT.id, option_value_ids: [CAT_SEL.combo], color_id: CAT_SEL.grey });
  assert.equal((await json(priced)).code, 'PRICE_REQUEST_ALREADY_PRICED', 'a priced SKU is bought, not asked about');

  const report = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(report.notified, 2, 'the customer (grey) and the PRO member (white)');
  assert.equal(report.closed, 1, 'the PRIME member did not ask to be told');
  assert.equal(reqRow(w.raw, 'u_cust', CAT.id, CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey)).state, 'notified');
  assert.equal(reqRow(w.raw, 'u_pro', CAT.id, CAT_SEL.key(CAT_SEL.combo, CAT_SEL.white)).state, 'notified');
  const closed = reqRow(w.raw, 'u_prime', CAT.id, CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey));
  assert.equal(closed.state, 'closed');
  assert.equal(closed.close_reason, 'priced');
  assert.equal(all(w.raw, "SELECT id FROM user_notifications WHERE user_id = 'u_prime'").length, 0, 'no notice without consent');
  const blueKey = CAT_SEL.key(CAT_SEL.std, 'c_cat_blue');
  assert.equal(reqRow(w.raw, 'u_cust', CAT.id, blueKey).state, 'open', 'the new colour has no price yet');
  // The notice names the selection: «name — model · colour».
  const pro = row<{ body_en: string; meta: string }>(w.raw, "SELECT body_en, meta FROM user_notifications WHERE user_id = 'u_pro' AND kind = 'price_available'")!;
  assert.match(pro.body_en, /Levo Catalog Printer H2D — H2D Combo/);
  assert.match(JSON.parse(pro.meta).body_ckb, /چاپکەری کەتەلۆگ H2D — H2D کۆمبۆ/);
  statsEqualSource(w.raw, CAT.id);

  // Its own price arrives (a later V2 write adds the SKU row).
  await publishV2(w.raw, CAT.id);
  const later = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(later.notified, 1);
  assert.equal(reqRow(w.raw, 'u_cust', CAT.id, blueKey).state, 'notified');
  assert.equal(all(w.raw, "SELECT id FROM user_notifications WHERE user_id = 'u_pro'").length, 1, 'the others were not told twice');
  statsEqualSource(w.raw, CAT.id);
});

test('a sale hold keeps a request waiting; lifting it (the owner’s switch off, or the gap filled) lets the next pass tell', async () => {
  const w = await world();
  // The P1S is V2-published but the owner's switch holds it for a commercial gap (its cost): shown, not sold.
  w.raw.exec(`INSERT INTO product_completeness (product_id, complete, held, missing_json, missing_count, computed_at)
              VALUES ('${P.P1S}', 0, 1, '[{"c":"COST","o":""}]', 1, '2026-10-15T00:00:00.000Z')`);
  const asked = await request(w, 'customer', { product_id: P.P1S, notify: true });
  assert.equal(asked.status, 200, JSON.stringify(await json(asked.clone())));
  await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(reqRow(w.raw, 'u_cust', P.P1S, '').state, 'open', 'held: not sellable, still waiting');
  w.raw.exec(`UPDATE product_completeness SET held = 0 WHERE product_id = '${P.P1S}'`);
  const report = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(report.notified, 1);
  assert.equal(reqRow(w.raw, 'u_cust', P.P1S, '').state, 'notified');
});

// ------------------------------------------------------------- the budget

/** A D1 that counts every statement it executes (a batch counts its statements). */
class CountingD1 {
  count = 0;
  constructor(private readonly inner: SqliteD1) {}
  prepare(sql: string) {
    return this.wrap(this.inner.prepare(sql));
  }
  private wrap(st: SqliteStatement): Record<string, unknown> {
    return {
      inner: st,
      bind: (...v: unknown[]) => this.wrap(st.bind(...v)),
      run: () => ((this.count += 1), st.run()),
      first: <T>() => ((this.count += 1), st.first<T>()),
      all: () => ((this.count += 1), st.all()),
    };
  }
  batch(stmts: Array<{ inner: SqliteStatement }>) {
    this.count += stmts.length;
    return this.inner.batch(stmts.map((s) => s.inner));
  }
}

function manyProducts(n: number): DatabaseSync {
  const raw = freshDb();
  raw.exec("INSERT INTO users (id, name, email, password_hash, role) VALUES ('u1', 'A', 'a@x.co', 'h', 'customer')");
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const id = `p_many_${String(i).padStart(2, '0')}`;
    raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd) VALUES ('${id}', 'many-${i}', 'Many ${i}', 'active', 0)`);
    raw
      .prepare(`INSERT INTO product_price_requests (id, user_id, product_id, selection, notify, requested_at, last_clicked_at, first_requested_at)
                VALUES (?, 'u1', ?, '', 1, ?, ?, ?)`)
      .run(`prq_many_${i}`, id, now, now, now);
  }
  return raw;
}

test('the pass spends no statement its budget did not grant; ten products a pass, the cursor carries the rest', async () => {
  const raw = manyProducts(12);
  const d1 = new CountingD1(new SqliteD1(raw));
  const env = { DB: d1 as unknown as D1Database } as unknown as Env;
  const b = budget(40);
  const first = await sweepPriceRequests(env, b);
  assert.equal(first.products, 10);
  assert.ok(d1.count <= b.used() && b.used() <= 40, `executed ${d1.count}, charged ${b.used()}`);
  const checked = all<{ product_id: string }>(raw, "SELECT product_id FROM product_price_requests WHERE checked_at <> '' ORDER BY product_id");
  assert.equal(checked.length, 10);
  // The next pass starts with the two the cursor left.
  const before = d1.count;
  const second = await sweepPriceRequests(env, budget(40));
  assert.ok(second.products >= 2);
  assert.ok(row<{ checked_at: string }>(raw, "SELECT checked_at FROM product_price_requests WHERE product_id = 'p_many_11'")!.checked_at > '');
  assert.ok(d1.count - before <= 40);

  // A budget too small for a whole step stops before it, and never overspends.
  for (const limit of [0, 1, 2, 3, 5, 8]) {
    const small = budget(limit);
    const at = d1.count;
    const r = await sweepPriceRequests(env, small);
    assert.ok(d1.count - at <= limit, `budget ${limit}: executed ${d1.count - at}`);
    assert.ok(r.statements <= limit);
  }
});

/** `n` signed-in people (email verified) asking about `productId`, all wanting to be told. */
function crowd(raw: DatabaseSync, productId: string, n: number, prefix: string, selection = ''): void {
  const at = '2026-10-15T00:00:00.000Z';
  for (let i = 0; i < n; i++) {
    const user = `u_${prefix}_${i}`;
    raw
      .prepare("INSERT OR IGNORE INTO users (id, name, email, password_hash, role, email_verified_at) VALUES (?, ?, ?, 'h', 'customer', ?)")
      .run(user, `Crowd ${i}`, `${user}@x.co`, at);
    raw
      .prepare(
        `INSERT INTO product_price_requests (id, user_id, product_id, selection, notify, requested_at, last_clicked_at, first_requested_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(`prq_${prefix}_${i}`, user, productId, selection, at, at, at);
  }
}

test('progress per row: a priced product with 20 people to tell never blocks the product after it, and all are told within a few ticks', async () => {
  // U1 sorts before the PLA: the old all-or-nothing batch for U1 (20 × 3 statements) never fit the tick, froze the
  // cursor on U1 and stopped the PLA too, tick after tick.
  assert.ok(U1 < P.PLA);
  const w = await catalogOnlyWorld({ alsoUnpriced: [U1, P.PLA] });
  crowd(w.raw, U1, 20, 'many');
  crowd(w.raw, P.PLA, 1, 'one');
  await publishV2(w.raw, U1);
  await publishV2(w.raw, P.PLA);
  const d1 = new CountingD1(new SqliteD1(w.raw));
  const env = { ...envOf(w), DB: d1 as unknown as D1Database } as unknown as Env;
  const state = (id: string) => row<{ state: string }>(w.raw, 'SELECT state FROM product_price_requests WHERE id = ?', id)!.state;

  const b = budget(PRICE_REQUEST_TICK_BUDGET);
  const first = await sweepPriceRequests(env, b);
  assert.ok(d1.count <= b.used() && b.used() <= PRICE_REQUEST_TICK_BUDGET, `executed ${d1.count}, charged ${b.used()}`);
  assert.equal(state('prq_one_0'), 'notified', 'the PLA is told on the first tick, beside the crowded U1');
  assert.ok(first.notified >= 2, 'the U1 progresses too');
  statsEqualSource(w.raw, U1);

  let ticks = 1;
  while (all(w.raw, "SELECT id FROM product_price_requests WHERE state <> 'notified'").length && ticks < 8) {
    const at = d1.count;
    const tick = budget(PRICE_REQUEST_TICK_BUDGET);
    const r = await sweepPriceRequests(env, tick);
    assert.ok(r.notified > 0, `tick ${ticks} makes progress`);
    assert.ok(d1.count - at <= tick.used(), 'never a statement the budget did not grant');
    ticks += 1;
  }
  assert.equal(all(w.raw, "SELECT id FROM product_price_requests WHERE state <> 'notified'").length, 0, `all 21 told within ${ticks} ticks`);
  assert.ok(ticks <= 5, `${ticks} ticks`);
  assert.equal(all(w.raw, "SELECT id FROM user_notifications WHERE kind = 'price_available'").length, 21, 'one notice each, never twice');
  assert.equal(all(w.raw, "SELECT id FROM outbox WHERE event_key LIKE 'price_available:%'").length, 21, 'one email each');
  statsEqualSource(w.raw, U1);
  statsEqualSource(w.raw, P.PLA);
});

test('the rows read is bounded per product: 205 waiting rows on one product never hide a priced request on another', async () => {
  assert.ok(CAT.id < P.PLA, 'the crowded product sorts first');
  const w = await catalogOnlyWorld({ alsoUnpriced: [P.PLA] });
  crowd(w.raw, CAT.id, 205, 'wait', CAT_SEL.key(CAT_SEL.std, CAT_SEL.grey));
  crowd(w.raw, P.PLA, 1, 'pla');
  await publishV2(w.raw, P.PLA);
  const report = await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(report.notified, 1);
  assert.equal(row<{ state: string }>(w.raw, "SELECT state FROM product_price_requests WHERE id = 'prq_pla_0'")!.state, 'notified');
  // The cursor moved only for the rows the pass read (20 of the H2D's 205); the rest are first next time.
  const moved = all(w.raw, "SELECT id FROM product_price_requests WHERE product_id = ? AND checked_at <> ''", CAT.id).length;
  assert.equal(moved, 20);
  await sweepPriceRequests(envOf(w), budget(40));
  assert.equal(all(w.raw, "SELECT id FROM product_price_requests WHERE product_id = ? AND checked_at <> ''", CAT.id).length, 40, 'the next pass reads the next 20');
  assert.equal(all(w.raw, "SELECT id FROM product_price_requests WHERE product_id = ? AND state <> 'open'", CAT.id).length, 0, 'still unpriced: all wait');
});

test('the quarter-hour tick: the price-request share is its own 40 cut to what was left, so the tick stays at or under 950', () => {
  assert.equal(PRICE_REQUEST_TICK_BUDGET, 40);
  assert.equal(QUARTER_HOUR_TICK_LIMIT, 950);
  assert.equal(quarterHourPriceRequestBudget(0), 40);
  assert.equal(quarterHourPriceRequestBudget(930), 20);
  assert.equal(quarterHourPriceRequestBudget(950), 0);
  assert.equal(quarterHourPriceRequestBudget(5000), 0);
  for (let used = 0; used <= 1200; used += 7) {
    const share = quarterHourPriceRequestBudget(used);
    assert.ok(share >= 0 && share <= 40);
    assert.ok(used + share <= Math.max(used, QUARTER_HOUR_TICK_LIMIT), `used ${used}: share ${share}`);
  }
});

test('a database without 0193: the sweep returns at once', async () => {
  const raw = freshDb();
  raw.exec('DROP TABLE product_price_request_stats; DROP TABLE product_price_requests;');
  const report = await sweepPriceRequests({ DB: asD1(raw) } as unknown as Env, budget(40));
  assert.deepEqual([report.products, report.notified], [0, 0]);
});
