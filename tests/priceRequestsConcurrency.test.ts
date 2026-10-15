/**
 * «طلب السعر» UNDER CONCURRENCY (DECISIONS row 240; spec §4.9, §7.5).
 *
 * The requests run through the real route on a SERIALISED D1 (tests/fixtures/
 * serialD1.ts: one writer, each call to completion — D1's own model), with the
 * requests themselves interleaving between calls exactly as live ones do.
 * Proves:
 *   - twenty taps at once by one person on one selection: ONE row, its click
 *     counter 20, one requester;
 *   - ten people × three selections at once: ten requesters, three selections,
 *     ten people on each selection — the stats a recount of the source;
 *   - withdrawals and reopenings interleaved: the stats still equal a recount;
 *   - a withdrawal racing the sweep's flip: exactly one terminal state wins
 *     (the other answers 404 / changes nothing), never both.
 *
 * Run: node --import tsx --test tests/priceRequestsConcurrency.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Env } from '../worker/lib/types';
import type { DatabaseSync } from 'node:sqlite';
import { all, json, post, row, send, stubApp, type StubUser } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { publishV2 } from './fixtures/v2Publish';
import { CAT, CAT_SEL, catalogOnlyWorld, mountCustomer } from './fixtures/catalogOnly';
import { sweepPriceRequests } from '../worker/lib/priceRequests';

const SELECTIONS = [
  { option_value_ids: [CAT_SEL.std], color_id: CAT_SEL.grey },
  { option_value_ids: [CAT_SEL.std], color_id: CAT_SEL.white },
  { option_value_ids: [CAT_SEL.combo], color_id: CAT_SEL.grey },
] as const;

async function race() {
  const w = await catalogOnlyWorld();
  const db = serialD1(w.raw);
  const people: StubUser[] = Array.from({ length: 10 }, (_, i) => ({ id: `u_race_${i}`, role: 'customer', email: `race${i}@x.co` }));
  for (const p of people) {
    w.raw.prepare("INSERT INTO users (id, name, email, password_hash, role) VALUES (?, ?, ?, 'h', 'customer')").run(p.id, p.id, p.email);
  }
  const as = (user: StubUser) => stubApp(db, user, mountCustomer, { publishV2: false });
  return { w, db, people, as };
}

const recount = (raw: DatabaseSync) =>
  row<Record<string, unknown>>(
    raw,
    `SELECT COUNT(DISTINCT user_id) AS requesters, COUNT(DISTINCT selection) AS selections, COALESCE(SUM(click_count), 0) AS clicks
       FROM product_price_requests WHERE product_id = ? AND state = 'open'`,
    CAT.id
  );
const stored = (raw: DatabaseSync) =>
  row<Record<string, unknown>>(raw, 'SELECT requesters, selections, clicks FROM product_price_request_stats WHERE product_id = ?', CAT.id);

test('twenty taps at once by one person: one row, twenty clicks, one requester', async () => {
  const { w, people, as } = await race();
  const app = as(people[0]!);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => post(app, '/api/price-requests', { product_id: CAT.id, ...SELECTIONS[0], notify: true }))
  );
  assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
  const bodies = await Promise.all(results.map((r) => json(r)));
  assert.equal(new Set(bodies.map((b) => b.request.id)).size, 1, 'one request id for every tap');
  const rows = all<{ click_count: number }>(w.raw, 'SELECT click_count FROM product_price_requests WHERE user_id = ?', people[0]!.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.click_count, 20);
  assert.deepEqual(stored(w.raw), { requesters: 1, selections: 1, clicks: 20 });
});

test('ten people × three selections at once: ten requesters, three selections, ten on each', async () => {
  const { w, people, as } = await race();
  const calls = people.flatMap((p) => SELECTIONS.map((s) => post(as(p), '/api/price-requests', { product_id: CAT.id, ...s })));
  const results = await Promise.all(calls);
  assert.deepEqual([...new Set(results.map((r) => r.status))], [200]);
  assert.deepEqual(stored(w.raw), { requesters: 10, selections: 3, clicks: 30 });
  assert.deepEqual(stored(w.raw), recount(w.raw));
  const perSelection = all<{ selection: string; people: number }>(
    w.raw,
    "SELECT selection, COUNT(*) AS people FROM product_price_requests WHERE product_id = ? AND state = 'open' GROUP BY selection ORDER BY selection",
    CAT.id
  );
  assert.deepEqual(perSelection.map((r) => r.people), [10, 10, 10]);

  // Interleaved withdrawals and reopenings: the stats follow the source.
  const ids = all<{ id: string; user_id: string }>(w.raw, 'SELECT id, user_id FROM product_price_requests ORDER BY id');
  const byUser = new Map(people.map((p) => [p.id, p]));
  const mixed = ids.flatMap((r, i) => {
    const app = as(byUser.get(r.user_id)!);
    if (i % 3 === 0) return [send(app, 'DELETE', `/api/price-requests/${r.id}`)];
    if (i % 3 === 1) return [send(app, 'DELETE', `/api/price-requests/${r.id}`), post(app, '/api/price-requests', { product_id: CAT.id, ...SELECTIONS[i % 3] })];
    return [post(app, '/api/price-requests', { product_id: CAT.id, ...SELECTIONS[i % 3] })];
  });
  const mixedResults = await Promise.all(mixed);
  assert.ok(mixedResults.every((r) => r.status === 200 || r.status === 404), 'a lost race is a 404, never a 500');
  assert.deepEqual(stored(w.raw), recount(w.raw), 'the stats equal a recount of the source');
});

test('a withdrawal racing the sweep: exactly one terminal state wins', async () => {
  const { w, db, people, as } = await race();
  const app = as(people[0]!);
  const asked = await json(await post(app, '/api/price-requests', { product_id: CAT.id, ...SELECTIONS[0], notify: true }));
  await publishV2(w.raw, CAT.id);
  let used = 0;
  const budget = { canSpend: (n: number) => used + n <= 40, spend: (n: number) => (used + n > 40 ? false : ((used += n), true)), remaining: () => 40 - used };
  const [withdraw, report] = await Promise.all([
    send(app, 'DELETE', `/api/price-requests/${asked.request.id}`),
    sweepPriceRequests({ DB: db, APP_ORIGIN: 'https://levonis-iq.com' } as unknown as Env, budget),
  ]);
  const final = row<{ state: string; close_reason: string }>(w.raw, 'SELECT state, close_reason FROM product_price_requests WHERE id = ?', asked.request.id)!;
  const notices = all(w.raw, "SELECT id FROM user_notifications WHERE kind = 'price_available'").length;
  if (withdraw.status === 200) {
    assert.deepEqual(final, { state: 'closed', close_reason: 'withdrawn' });
    assert.equal(report.notified, 0);
    assert.equal(notices, 0, 'a withdrawn request is never told');
  } else {
    assert.equal(withdraw.status, 404, 'the sweep won: the withdrawal changes nothing');
    assert.equal(final.state, 'notified');
    assert.equal(notices, 1);
  }
  assert.deepEqual(stored(w.raw), recount(w.raw));
});
