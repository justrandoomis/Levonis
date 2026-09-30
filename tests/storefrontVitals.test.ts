/**
 * «سرعة متجري» — THE VITALS BEACON (merchant platform v2 §4.5 S2, migration
 * 0161): POST /api/storefront/events/vitals counts one real-user speed sample
 * per visitor per Baghdad day per device as BUCKETS at the Web Vitals
 * thresholds; never a crawler, never the store's owner, never an unknown or
 * suspended store; clamps a broken clock; writes the mark and the day's
 * counters in ONE batch; stores nothing that identifies anyone; and its
 * marks die with the traffic beacon's.
 *
 * Do Not Track / Global Privacy Control are the reporter's decision in the
 * browser (src/lib/storeVitals.ts sends nothing), so they are not a server
 * case here.
 *
 * Run: node --import tsx --test tests/storefrontVitals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, failingD1, post, row, send, stubApp } from './fixtures/app';
import { BUYER, OWNER, appOf, seedW2E } from './fixtures/merchantW2E';
import { storefrontEventRoutes, storefrontVitalsRoutes, MAX_EVENT_BYTES, VITALS_PER_MINUTE } from '../worker/routes/storefrontEvents';
import { pruneStorefrontAnalytics } from '../worker/lib/storefrontAnalytics';
import { baghdadDay } from '../worker/lib/baghdadTime';
import { wavesD1 } from './fixtures/wavesD1';
import {
  BUCKET_COLUMNS,
  VITALS_CLAMPS,
  VITALS_THRESHOLDS,
  VITAL_NAMES,
  bucketVital,
  clampVital,
  readVitalsSample,
  recordVitals,
  VITALS_ANON_PER_NETWORK,
} from '../worker/lib/storeSpeed';

const UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36';
const PATH = '/api/storefront/events/vitals';
const mount = (a: Parameters<Parameters<typeof appOf>[2]>[0]) => a.route('/api/storefront/events', storefrontEventRoutes);

function beacon(raw: DatabaseSync, body: Record<string, unknown>, opts: { user?: typeof BUYER | null; ip?: string; ua?: string } = {}) {
  return post(appOf(raw, opts.user ?? null, mount), PATH, body, {
    'User-Agent': opts.ua ?? UA,
    'CF-Connecting-IP': opts.ip ?? '10.0.0.1',
  });
}

const day = () => baghdadDay(Date.now());
const dayRow = (raw: DatabaseSync, device = 'phone', store = 's1') =>
  row<Record<string, number>>(raw, 'SELECT * FROM storefront_vitals_daily WHERE store_id = ? AND day = ? AND device = ?', store, day(), device);
const marks = (raw: DatabaseSync) => count(raw, 'SELECT COUNT(*) AS n FROM storefront_vitals_marks');
const sample = (over: Record<string, unknown> = {}) => ({ store: 's1', device: 'phone', lcp_ms: 1800, cls_x1000: 40, inp_ms: 120, ttfb_ms: 500, ...over });

test('one visitor is one sample per day per device: a reload, a retry and a second tab add nothing; another device is another sample', async () => {
  const raw = seedW2E();
  for (let i = 0; i < 3; i++) assert.equal((await beacon(raw, sample())).status, 204);
  let d = dayRow(raw)!;
  assert.equal(d.samples, 1);
  assert.deepEqual([d.lcp_good, d.cls_good, d.inp_good, d.ttfb_good], [1, 1, 1, 1]);
  assert.deepEqual([d.lcp_sum_ms, d.ttfb_sum_ms], [1800, 500]);
  // The same person on a desktop is the desktop's sample, not a second phone one.
  await beacon(raw, sample({ device: 'desktop', lcp_ms: 3000 }));
  await beacon(raw, sample({ device: 'desktop', lcp_ms: 3000 }));
  assert.equal(dayRow(raw)!.samples, 1);
  assert.deepEqual([dayRow(raw, 'desktop')!.samples, dayRow(raw, 'desktop')!.lcp_ok], [1, 1]);
  // Another network is another visitor; a different browser on the same network too.
  await beacon(raw, sample(), { ip: '10.0.0.2' });
  await beacon(raw, sample({ lcp_ms: 5000 }), { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' });
  d = dayRow(raw)!;
  assert.deepEqual([d.samples, d.lcp_good, d.lcp_poor], [3, 2, 1]);
  assert.equal(marks(raw), 4, 'one mark per (store, day, device, visitor)');
  // A signed-in shopper is one visitor on every network.
  await beacon(raw, sample(), { user: BUYER, ip: '1.1.1.1' });
  await beacon(raw, sample(), { user: BUYER, ip: '2.2.2.2' });
  assert.equal(dayRow(raw)!.samples, 4);
});

test('a beacon may carry only some vitals: the missing ones add to no bucket, so a vital\'s total is its own count', async () => {
  const raw = seedW2E();
  await beacon(raw, { store: 's1', device: 'phone', lcp_ms: 1000 });
  await beacon(raw, { store: 's1', device: 'phone', lcp_ms: 3000, ttfb_ms: 100 }, { ip: '10.0.0.2' });
  const d = dayRow(raw)!;
  assert.equal(d.samples, 2);
  assert.deepEqual([d.lcp_good, d.lcp_ok, d.lcp_poor], [1, 1, 0]);
  assert.deepEqual([d.inp_good + d.inp_ok + d.inp_poor, d.cls_good + d.cls_ok + d.cls_poor, d.ttfb_good], [0, 0, 1]);
  assert.deepEqual([d.lcp_sum_ms, d.ttfb_sum_ms], [4000, 100]);
});

test('the owner, a crawler, an unknown store and a suspended store count nothing — each a bare 204', async () => {
  const raw = seedW2E();
  assert.equal((await beacon(raw, sample(), { user: OWNER })).status, 204);
  assert.equal((await beacon(raw, sample(), { ua: 'Chrome-Lighthouse' })).status, 204);
  assert.equal((await beacon(raw, sample(), { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })).status, 204);
  assert.equal((await beacon(raw, sample({ store: 'nope' }))).status, 204);
  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's2'");
  assert.equal((await beacon(raw, sample({ store: 's2' }))).status, 204);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM storefront_vitals_daily'), 0);
  assert.equal(marks(raw), 0);
  // The owner of ANOTHER store is an ordinary visitor of this one.
  await beacon(raw, sample(), { user: { id: 'owner2', role: 'merchant', email: 'owner2@x.co' } });
  assert.equal(dayRow(raw)!.samples, 1);
});

test('clamps: a broken clock is the clamp, counted as poor; buckets sit exactly on the Web Vitals thresholds', async () => {
  // The pure rules first.
  for (const name of VITAL_NAMES) {
    const [good, ok] = VITALS_THRESHOLDS[name];
    assert.equal(bucketVital(name, good), 'good', `${name} at the good line`);
    assert.equal(bucketVital(name, good + 1), 'ok');
    assert.equal(bucketVital(name, ok), 'ok', `${name} at the ok line`);
    assert.equal(bucketVital(name, ok + 1), 'poor');
    assert.equal(clampVital(name, 10 ** 9), VITALS_CLAMPS[name]);
    assert.equal(clampVital(name, 12.6), 13, 'rounded');
    assert.equal(clampVital(name, undefined), null, 'absent');
    assert.equal(clampVital(name, null), null);
    assert.equal(clampVital(name, -1), undefined, 'refused');
    assert.equal(clampVital(name, '1200'), undefined, 'a string is not a reading');
    assert.equal(clampVital(name, Number.NaN), undefined);
  }
  assert.deepEqual(VITALS_THRESHOLDS, { lcp: [2500, 4000], inp: [200, 500], cls: [100, 250], ttfb: [800, 1800] });
  assert.equal(readVitalsSample({}), null, 'no reading at all is not a beacon');
  assert.deepEqual(readVitalsSample({ lcp_ms: 999_999, cls_x1000: 0 }), { lcp: 60_000, cls: 0 });
  assert.equal(readVitalsSample({ lcp_ms: 1000, inp_ms: 'fast' }), null);

  // Then through the route, one visitor per value.
  const raw = seedW2E();
  let ip = 0;
  const one = (body: Record<string, unknown>) => beacon(raw, { store: 's1', device: 'phone', ...body }, { ip: `10.1.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}` });
  await one({ lcp_ms: 999_999 });
  let d = dayRow(raw)!;
  assert.deepEqual([d.lcp_poor, d.lcp_sum_ms], [1, VITALS_CLAMPS.lcp], 'clamped, and still poor');
  await one({ lcp_ms: 2500 });
  await one({ lcp_ms: 2501 });
  await one({ lcp_ms: 4000 });
  await one({ lcp_ms: 4001 });
  await one({ inp_ms: 200 });
  await one({ inp_ms: 201 });
  await one({ inp_ms: 500 });
  await one({ inp_ms: 501 });
  await one({ cls_x1000: 100 });
  await one({ cls_x1000: 101 });
  await one({ cls_x1000: 250 });
  await one({ cls_x1000: 251 });
  await one({ ttfb_ms: 800 });
  await one({ ttfb_ms: 801 });
  await one({ ttfb_ms: 1800 });
  await one({ ttfb_ms: 1801 });
  d = dayRow(raw)!;
  assert.equal(d.samples, 17);
  assert.deepEqual(
    Object.fromEntries(BUCKET_COLUMNS.map((c) => [c, d[c]])),
    {
      lcp_good: 1, lcp_ok: 2, lcp_poor: 2,
      inp_good: 1, inp_ok: 2, inp_poor: 1,
      cls_good: 1, cls_ok: 2, cls_poor: 1,
      ttfb_good: 1, ttfb_ok: 2, ttfb_poor: 1,
    }
  );
  assert.equal(d.lcp_sum_ms, VITALS_CLAMPS.lcp + 2500 + 2501 + 4000 + 4001);
});

test('a malformed beacon is 400 VITALS_REJECTED (a code no screen shows); an oversized one never reaches the parser', async () => {
  const raw = seedW2E();
  const code = async (res: Response) => ((await res.json()) as { code: string }).code;
  for (const body of [
    { device: 'phone', lcp_ms: 1000 }, // no store
    { store: '../s1', device: 'phone', lcp_ms: 1000 },
    { store: 's1', device: 'tablet', lcp_ms: 1000 },
    { store: 's1', lcp_ms: 1000 }, // no device
    { store: 's1', device: 'phone' }, // no reading
    { store: 's1', device: 'phone', lcp_ms: -5 },
    { store: 's1', device: 'phone', lcp_ms: 'slow' },
    { store: 's1', device: 'phone', cls_x1000: Number.POSITIVE_INFINITY },
  ]) {
    const res = await beacon(raw, body);
    assert.deepEqual([res.status, await code(res)], [400, 'VITALS_REJECTED'], JSON.stringify(body));
  }
  const notJson = await appOf(raw, null, mount).request(PATH, { method: 'POST', body: 'not json', headers: { 'User-Agent': UA, 'CF-Connecting-IP': '3.3.3.3' } });
  assert.deepEqual([notJson.status, await code(notJson)], [400, 'VITALS_REJECTED']);
  const list = await appOf(raw, null, mount).request(PATH, { method: 'POST', body: '[1,2]', headers: { 'User-Agent': UA, 'CF-Connecting-IP': '3.3.3.3' } });
  assert.equal(list.status, 400);
  const big = await send(appOf(raw, null, mount), 'POST', PATH, { ...sample(), pad: 'x'.repeat(MAX_EVENT_BYTES) }, { 'User-Agent': UA });
  assert.deepEqual([big.status, await code(big)], [413, 'EVENT_TOO_LARGE']);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM storefront_vitals_daily'), 0);
  assert.equal(marks(raw), 0);
});

test('the mark and the counters are ONE batch: a failure in the second statement leaves no mark, and a batch that never ran leaves nothing', async () => {
  const raw = seedW2E();
  // The counters' table gone: the batch's second statement fails, the first must not survive.
  raw.exec('ALTER TABLE storefront_vitals_daily RENAME TO storefront_vitals_daily_gone');
  const res = await beacon(raw, sample());
  assert.equal(res.status, 500);
  assert.equal(marks(raw), 0, 'the mark was rolled back with the counters');
  raw.exec('ALTER TABLE storefront_vitals_daily_gone RENAME TO storefront_vitals_daily');
  // A transient D1 failure on the batch itself.
  const { failing, db } = failingD1(raw);
  failing.failWhen = (s) => s.some((st) => /storefront_vitals_marks/.test(st.sql));
  const app = stubApp(db, null, mount, { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } });
  const failed = await post(app, PATH, sample(), { 'User-Agent': UA, 'CF-Connecting-IP': '10.0.0.9' });
  assert.equal(failed.status, 500);
  assert.equal(marks(raw), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM storefront_vitals_daily'), 0);
  // The day's salt is read-or-inserted in a batch of its own; the RECORDING is one batch.
  const recording = failing.batches.filter((b) => b.some((sql) => /storefront_vitals_marks/.test(sql)));
  assert.equal(recording.length, 1, 'the ingest records in one batch');
  assert.equal(recording[0].length, 2, 'the mark, then the counters');
  // And the recorder's own answer: whether THIS request added a sample.
  const d1 = asD1(raw);
  assert.equal(await recordVitals(d1, { storeId: 's1', day: day(), device: 'phone', visitor: 'v1', nonce: 'n1', sample: { lcp: 1000 } }, { verify: true }), true);
  assert.equal(await recordVitals(d1, { storeId: 's1', day: day(), device: 'phone', visitor: 'v1', nonce: 'n2', sample: { lcp: 9000 } }, { verify: true }), false);
  assert.deepEqual([dayRow(raw)!.samples, dayRow(raw)!.lcp_good, dayRow(raw)!.lcp_poor], [1, 1, 0]);
});

test('nothing that identifies anyone is stored — only salted hashes — and the vitals marks are pruned with the event marks', async () => {
  const raw = seedW2E();
  await beacon(raw, sample(), { ip: '203.0.113.77' });
  await beacon(raw, sample(), { user: BUYER, ip: '203.0.113.78' });
  const dump = JSON.stringify(all(raw, 'SELECT * FROM storefront_vitals_marks')) + JSON.stringify(all(raw, 'SELECT * FROM storefront_vitals_daily'));
  for (const secret of ['203.0.113.77', '203.0.113.78', 'buyer', 'Android', 'SM-A546E']) assert.ok(!dump.includes(secret), `stored: ${secret}`);
  assert.ok(all<{ visitor: string }>(raw, 'SELECT visitor FROM storefront_vitals_marks').every((m) => /^[0-9a-f]{32}$/.test(m.visitor)));
  assert.equal(
    all<{ visitor: string }>(raw, 'SELECT visitor FROM storefront_vitals_marks').some((m) => all<{ visitor: string }>(raw, 'SELECT visitor FROM storefront_event_marks').some((e) => e.visitor === m.visitor)),
    false,
    'the vitals hash is not the traffic hash of the same visitor'
  );
  raw.exec(`INSERT INTO storefront_vitals_marks (store_id, day, device, visitor, nonce) VALUES ('s1','2020-01-01','phone','h','n')`);
  raw.exec(`INSERT INTO storefront_event_marks (store_id, day, event, product_id, visitor, nonce) VALUES ('s1','2020-01-01','visit','','h','n')`);
  raw.exec(`INSERT INTO storefront_salts (day, salt) VALUES ('2020-01-01','old')`);
  const pruned = await pruneStorefrontAnalytics(asD1(raw), day());
  assert.deepEqual(pruned, { marks: 2, salts: 1 }, 'the old vitals mark counts with the old event mark');
  assert.equal(marks(raw), 2, "today's vitals marks stay");
  // The day rows are the history and are never pruned.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM storefront_vitals_daily'), 1);
});

test('the same ingest answers on a router of its own (for a mount at /api/storefront/vitals)', async () => {
  const raw = seedW2E();
  const app = appOf(raw, null, (a) => a.route('/api/storefront/vitals', storefrontVitalsRoutes));
  const res = await post(app, '/api/storefront/vitals', sample(), { 'User-Agent': UA, 'CF-Connecting-IP': '10.0.0.1' });
  assert.equal(res.status, 204);
  assert.equal(dayRow(raw)!.samples, 1);
});

test('the per-minute limit answers 429 to a flood from one network', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 0, 0, 1) });
  const raw = seedW2E();
  let limited = 0;
  for (let i = 0; i < VITALS_PER_MINUTE + 5; i++) {
    const res = await beacon(raw, sample(), { ip: '6.6.6.6', ua: `${UA} build/${i}` });
    if (res.status === 429) limited += 1;
  }
  assert.ok(limited >= 5, `expected refusals past ${VITALS_PER_MINUTE}/min, got ${limited}`);
});

test('one network rotating its User-Agent is not N visitors: at most VITALS_ANON_PER_NETWORK samples a day, so no network sets a store\'s word alone (review 2026-09-30)', async () => {
  const raw = seedW2E();
  const uaN = (i: number) => `Mozilla/5.0 (Linux; Android 14; SM-A54${i % 10}E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.${i}.0 Mobile Safari/537.36`;
  for (let i = 0; i < 60; i++) {
    assert.equal((await beacon(raw, sample({ lcp_ms: 59_000, inp_ms: 9_000, cls_x1000: 4_000 }), { ip: '203.0.113.7', ua: uaN(i) })).status, 204);
  }
  assert.equal(dayRow(raw)!.samples, VITALS_ANON_PER_NETWORK, 'the rest of that network\'s «visitors» are not counted');
  const { summarizeVitals, readVitalsDays, MIN_SAMPLES, ATTENTION_MIN_SAMPLES } = await import('../worker/lib/storeSpeed');
  const rum = summarizeVitals(await readVitalsDays(asD1(raw), 's1', 'phone', day()), { days: 28, today: day(), device: 'phone' });
  assert.equal(rum.verdict, 'collecting', 'one script run cannot give a store its speed word');
  assert.ok(VITALS_ANON_PER_NETWORK * 5 <= MIN_SAMPLES && VITALS_ANON_PER_NETWORK * 3 <= ATTENTION_MIN_SAMPLES);
  // Another network is counted on its own; a signed-in account on the capped network is not capped.
  await beacon(raw, sample(), { ip: '198.51.100.9', ua: uaN(1) });
  await beacon(raw, sample(), { user: BUYER, ip: '203.0.113.7', ua: uaN(99) });
  assert.equal(dayRow(raw)!.samples, VITALS_ANON_PER_NETWORK + 2);
  // The network is stored only as a salted hash.
  assert.ok(!JSON.stringify(all(raw, 'SELECT * FROM storefront_vitals_marks')).includes('203.0.113'));
});

test('a beacon costs three dependent round trips: [the limit, the store], [the salt], [the mark and the counters] (perf review 2026-09-30)', async (t) => {
  // It was six or seven: the limit, the store, the salt's INSERT OR IGNORE, the salt's SELECT, the batch, and a
  // COUNT whose answer the route threw away.
  // rateLimit (worker/lib/ratelimit.ts) awaits one more statement — its stale-window DELETE — on 2 % of the hits
  // that open a window, and each beacon here opens one: the coin is held so the count is the route's own, every run.
  t.mock.method(Math, 'random', () => 0.5);
  const raw = seedW2E();
  const { waves, db } = wavesD1(raw);
  const app = stubApp(db, null, mount, { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } });
  const fire = (ip: string) => post(app, PATH, sample(), { 'User-Agent': UA, 'CF-Connecting-IP': ip });
  waves.reset();
  assert.equal((await fire('10.9.0.1')).status, 204);
  const first = waves.counts.waves;
  waves.reset();
  assert.equal((await fire('10.9.0.2')).status, 204);
  const salted = waves.counts.waves;
  console.log(`waves: first of the day ${first}, then ${salted} (${waves.counts.executions} executions)`);
  assert.ok(first <= 3 && salted <= 3, `waves ${first} / ${salted}`);
  assert.equal(waves.counts.sqls.some((q) => /^SELECT COUNT\(\*\)/i.test(q)), false, 'the route re-counts a mark it just wrote');
  assert.equal(dayRow(raw)!.samples, 2);
});
