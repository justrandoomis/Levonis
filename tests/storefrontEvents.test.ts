/**
 * THE STOREFRONT'S ANALYTICS BEACON (W2-E, audit 04 §5, audit 01 B22):
 * POST /api/storefront/events counts a visitor once per event, product and
 * Baghdad day; never a crawler, never the store's owner, never a product of
 * another store; caps what one network can add; stores nothing that
 * identifies anyone; and the daily counters always equal the distinct marks.
 *
 * Run: node --import tsx --test tests/storefrontEvents.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, post, row, send } from './fixtures/app';
import { BUYER, OWNER, appOf, seedW2E } from './fixtures/merchantW2E';
import { storefrontEventRoutes, MAX_EVENT_BYTES } from '../worker/routes/storefrontEvents';
import {
  ANON_VISITORS_PER_NETWORK,
  classifyReferrer,
  isBotUserAgent,
  pruneStorefrontAnalytics,
  recordStorefrontEvent,
} from '../worker/lib/storefrontAnalytics';
import { baghdadDay } from '../worker/lib/baghdadTime';

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const mount = (a: Parameters<Parameters<typeof appOf>[2]>[0]) => a.route('/api/storefront/events', storefrontEventRoutes);

function beacon(raw: DatabaseSync, body: Record<string, unknown>, opts: { user?: typeof BUYER | null; ip?: string; ua?: string } = {}) {
  return post(appOf(raw, opts.user ?? null, mount), '/api/storefront/events', body, {
    'User-Agent': opts.ua ?? UA,
    'CF-Connecting-IP': opts.ip ?? '10.0.0.1',
  });
}

const day = () => baghdadDay(Date.now());
const storeDay = (raw: DatabaseSync, store = 's1') =>
  row<Record<string, number>>(raw, 'SELECT * FROM merchant_store_analytics_daily WHERE store_id = ? AND day = ?', store, day());
const productDay = (raw: DatabaseSync, product: string) =>
  row<{ views: number; add_to_cart: number }>(raw, 'SELECT views, add_to_cart FROM merchant_product_analytics_daily WHERE product_id = ? AND day = ?', product, day());

test('a visitor is counted once per event and product per day — reloads, retries and the same product twice add nothing', async () => {
  const raw = seedW2E();
  const v = 'visitor-aaaaaaaaaaaa01';
  for (let i = 0; i < 4; i++) assert.equal((await beacon(raw, { event: 'store_view', store: 's1', visitor: v })).status, 204);
  for (let i = 0; i < 3; i++) await beacon(raw, { event: 'product_view', store: 's1', product: 'cp1', visitor: v });
  await beacon(raw, { event: 'product_view', store: 's1', product: 'cp2', visitor: v });
  await beacon(raw, { event: 'add_to_cart', store: 's1', product: 'cp1', visitor: v });
  await beacon(raw, { event: 'add_to_cart', store: 's1', product: 'cp1', visitor: v });
  await beacon(raw, { event: 'checkout_started', store: 's1', visitor: v });
  const d = storeDay(raw)!;
  assert.deepEqual(
    [d.visitors, d.store_views, d.product_views, d.add_to_cart, d.checkout_started],
    [1, 1, 2, 1, 1]
  );
  assert.deepEqual(productDay(raw, 'cp1'), { views: 1, add_to_cart: 1 });
  assert.deepEqual(productDay(raw, 'cp2'), { views: 1, add_to_cart: 0 });
  assert.equal(row<{ view_count: number }>(raw, "SELECT view_count FROM community_products WHERE id = 'cp1'")!.view_count, 1, 'the lifetime figure is the deduped one');
  // A second visitor is a second count.
  await beacon(raw, { event: 'store_view', store: 's1', visitor: 'visitor-aaaaaaaaaaaa02' }, { ip: '10.0.0.2' });
  assert.equal(storeDay(raw)!.visitors, 2);
});

test('a signed-in shopper is one visitor on every device; the store\'s owner is never counted', async () => {
  const raw = seedW2E();
  await beacon(raw, { event: 'store_view', store: 's1', visitor: 'device-one-aaaaaaaaa' }, { user: BUYER, ip: '1.1.1.1' });
  await beacon(raw, { event: 'store_view', store: 's1', visitor: 'device-two-bbbbbbbbb' }, { user: BUYER, ip: '2.2.2.2' });
  assert.equal(storeDay(raw)!.visitors, 1);
  await beacon(raw, { event: 'store_view', store: 's1' }, { user: OWNER });
  await beacon(raw, { event: 'product_view', store: 's1', product: 'cp1' }, { user: OWNER });
  assert.equal(storeDay(raw)!.visitors, 1, 'the owner looking at their own shop is not traffic');
  assert.equal(productDay(raw, 'cp1'), undefined);
});

test('crawlers, link previews, headless browsers and HTTP libraries are not counted; in-app browsers are', async () => {
  for (const ua of [
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'facebookexternalhit/1.1',
    'WhatsApp/2.23.20.0 A',
    'TelegramBot (like TwitterBot)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36',
    'curl/8.4.0',
    'python-requests/2.31',
    'node-fetch/1.0',
    '',
    'x',
  ]) {
    assert.equal(isBotUserAgent(ua), true, ua);
  }
  for (const ua of [
    UA,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
    'Mozilla/5.0 (Linux; Android 13; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0',
  ]) {
    assert.equal(isBotUserAgent(ua), false, ua);
  }
  const raw = seedW2E();
  await beacon(raw, { event: 'store_view', store: 's1', visitor: 'bot-visitor-aaaaaaaa' }, { ua: 'Googlebot/2.1' });
  assert.equal(storeDay(raw), undefined);
});

test('a product of another store, an unpublished product, a suspended store and an unknown store count nothing', async () => {
  const raw = seedW2E();
  const v = 'visitor-cccccccccccc01';
  await beacon(raw, { event: 'product_view', store: 's1', product: 'cp9', visitor: v });
  await beacon(raw, { event: 'product_view', store: 's1', product: 'cp3', visitor: v });
  await beacon(raw, { event: 'store_view', store: 'nope', visitor: v });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_product_analytics_daily'), 0);
  assert.equal(row<{ view_count: number }>(raw, "SELECT view_count FROM community_products WHERE id = 'cp9'")!.view_count, 0);
  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's2'");
  await beacon(raw, { event: 'store_view', store: 's2', visitor: v });
  assert.equal(storeDay(raw, 's2'), undefined);
});

test('malformed beacons are refused with stable codes; an oversized one never reaches the parser', async () => {
  const raw = seedW2E();
  const code = async (res: Response) => ((await res.json()) as { code: string }).code;
  let res = await beacon(raw, { event: 'order_placed', store: 's1' });
  assert.deepEqual([res.status, await code(res)], [400, 'BAD_EVENT']);
  res = await beacon(raw, { event: 'product_view', store: 's1' });
  assert.deepEqual([res.status, await code(res)], [400, 'BAD_EVENT'], 'a product event names its product');
  res = await beacon(raw, { event: 'store_view', store: '../s1' });
  assert.equal(res.status, 400);
  res = await send(appOf(raw, null, mount), 'POST', '/api/storefront/events', { event: 'store_view', store: 's1', pad: 'x'.repeat(MAX_EVENT_BYTES) }, { 'User-Agent': UA });
  assert.deepEqual([res.status, await code(res)], [413, 'EVENT_TOO_LARGE']);
  const text = await appOf(raw, null, mount).request('/api/storefront/events', {
    method: 'POST', body: 'not json', headers: { 'User-Agent': UA, 'CF-Connecting-IP': '3.3.3.3' },
  });
  assert.equal(text.status, 400);
});

test('one network cannot mint visitors without limit: at most the cap of anonymous visitors per store per day', async () => {
  const raw = seedW2E();
  const db = asD1(raw);
  // Straight through the recorder (the route's per-minute limit is its own test below).
  for (let i = 0; i < ANON_VISITORS_PER_NETWORK + 10; i++) {
    await recordStorefrontEvent(db, { storeId: 's1', day: day(), event: 'store_view', productId: '', visitor: `v${i}`, net: 'net-a', source: 'direct', nonce: `n${i}` });
  }
  await recordStorefrontEvent(db, { storeId: 's1', day: day(), event: 'store_view', productId: '', visitor: 'other', net: 'net-b', source: 'direct', nonce: 'nb' });
  await recordStorefrontEvent(db, { storeId: 's1', day: day(), event: 'store_view', productId: '', visitor: 'signed', net: '', source: 'direct', nonce: 'ns' });
  assert.equal(storeDay(raw)!.visitors, ANON_VISITORS_PER_NETWORK + 2, 'the capped network, another network, a signed-in account');
});

test('the per-minute limit answers 429 to a flood from one network', async () => {
  const raw = seedW2E();
  let limited = 0;
  for (let i = 0; i < 245; i++) {
    const res = await beacon(raw, { event: 'store_view', store: 's1', visitor: `flood-${String(i).padStart(14, '0')}` }, { ip: '6.6.6.6' });
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited >= 5, `expected refusals past 240/min, got ${limited}`);
});

test('nothing that identifies anyone is stored: no id, no address, no user agent — only salted hashes', async () => {
  const raw = seedW2E();
  const v = 'my-secret-visitor-id-123';
  await beacon(raw, { event: 'store_view', store: 's1', visitor: v, ref: 'www.google.com' }, { user: null, ip: '203.0.113.77' });
  await beacon(raw, { event: 'store_view', store: 's1' }, { user: BUYER, ip: '203.0.113.78' });
  const dump = JSON.stringify(all(raw, 'SELECT * FROM storefront_event_marks')) + JSON.stringify(all(raw, 'SELECT * FROM merchant_store_analytics_daily'));
  for (const secret of [v, '203.0.113.77', 'buyer', 'Android', 'google']) assert.ok(!dump.includes(secret), `stored: ${secret}`);
  assert.ok(all<{ visitor: string }>(raw, 'SELECT visitor FROM storefront_event_marks').every((m) => /^[0-9a-f]{32}$/.test(m.visitor)));
  // A new day's salt makes the same visitor a different hash; old salts and marks are pruned.
  raw.exec(`INSERT INTO storefront_salts (day, salt) VALUES ('2020-01-01','old')`);
  raw.exec(`INSERT INTO storefront_event_marks (store_id, day, event, product_id, visitor, nonce) VALUES ('s1','2020-01-01','visit','','h','n')`);
  const pruned = await pruneStorefrontAnalytics(asD1(raw), day());
  assert.deepEqual(pruned, { marks: 1, salts: 1 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM storefront_salts WHERE day = ?', day()), 1, 'today\'s salt stays');
});

test('the source of a visit is coarse and taken from the referrer\'s host only, on the visitor\'s first event of the day', async () => {
  assert.equal(classifyReferrer(''), 'direct');
  assert.equal(classifyReferrer('ali3d.levonis-iq.com', 'ali3d.levonis-iq.com'), 'direct');
  assert.equal(classifyReferrer('www.google.iq'), 'search');
  assert.equal(classifyReferrer('duckduckgo.com'), 'search');
  assert.equal(classifyReferrer('l.facebook.com'), 'social');
  assert.equal(classifyReferrer('t.co'), 'social');
  assert.equal(classifyReferrer('levonis-iq.com'), 'other');
  assert.equal(classifyReferrer('notgoogle.example'), 'other');
  assert.equal(classifyReferrer('https://evil/path?q=1'), 'direct', 'anything but a bare host is ignored');
  const raw = seedW2E();
  await beacon(raw, { event: 'store_view', store: 's1', visitor: 'src-visitor-aaaaaaa1', ref: 'www.instagram.com' });
  await beacon(raw, { event: 'product_view', store: 's1', product: 'cp1', visitor: 'src-visitor-aaaaaaa1', ref: 'www.google.com' });
  await beacon(raw, { event: 'store_view', store: 's1', visitor: 'src-visitor-aaaaaaa2' }, { ip: '10.9.9.9' });
  const d = storeDay(raw)!;
  assert.deepEqual([d.source_social, d.source_search, d.source_direct, d.source_other], [1, 0, 1, 0]);
});

test('ROLLUP CORRECTNESS: after a random storm of events, every counter equals its count of distinct marks', async () => {
  const raw = seedW2E();
  const db = asD1(raw);
  const events = ['store_view', 'product_view', 'add_to_cart', 'checkout_started'] as const;
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), (seed >>> 16) % n);
  for (let i = 0; i < 400; i++) {
    const event = events[rnd(4)];
    const product = event === 'product_view' || event === 'add_to_cart' ? ['cp1', 'cp2'][rnd(2)] : '';
    await recordStorefrontEvent(db, {
      storeId: 's1', day: day(), event, productId: product, visitor: `v${rnd(25)}`, net: `net${rnd(3)}`,
      source: (['direct', 'search', 'social', 'other'] as const)[rnd(4)], nonce: `n${i}`,
    });
  }
  const marks = (event: string, product?: string) =>
    count(raw, `SELECT COUNT(*) AS n FROM storefront_event_marks WHERE store_id = 's1' AND day = ? AND event = ?${product ? ' AND product_id = ?' : ''}`, day(), event, ...(product ? [product] : []));
  const d = storeDay(raw)!;
  assert.equal(d.visitors, marks('visit'));
  assert.equal(d.source_direct + d.source_search + d.source_social + d.source_other, d.visitors);
  assert.equal(d.store_views, marks('store_view'));
  assert.equal(d.product_views, marks('product_view'));
  assert.equal(d.add_to_cart, marks('add_to_cart'));
  assert.equal(d.checkout_started, marks('checkout_started'));
  for (const p of ['cp1', 'cp2']) {
    assert.deepEqual(productDay(raw, p), { views: marks('product_view', p), add_to_cart: marks('add_to_cart', p) });
  }
});
