/**
 * REPUTATION V2 (docs/COMMUNITY_ECOSYSTEM.md §9.6, migration 0163).
 *
 *   · the rules, pure: each badge appears only with its evidence and
 *     disappears without — at every boundary the spec names;
 *   · a Baghdad day of real rows becomes ONE `merchant_metrics_daily` row per
 *     merchant: first replies by the turn rule and `chat_participants.role`,
 *     completions, the merchant's own cancellations, lost disputes; pending
 *     replies wait for the re-run; running a night twice changes nothing;
 *   · the night: once per Baghdad day; badges stored WITH evidence and a
 *     `since` that survives while the badge is held; `responds_within_minutes`
 *     NULL under ten samples;
 *   · the public reads carry `{key, since}` and never the evidence; the
 *     catalogue is served to guests from the colo; the merchant's own page
 *     has the evidence, `private, no-store`;
 *   · the matcher reads response time and trouble rate from the metrics;
 *   · an admin's release / partial refund of a dispute counts the completion
 *     once — `completed_orders` and `order_completed` — and a refund does not.
 *
 * Run: node --import tsx --test tests/reputationV2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, all, type StubUser, type Mount } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import {
  BADGE_KEYS,
  MIN_REPLY_SAMPLES,
  aggregateMerchantMetrics,
  badgeCatalogue,
  computeBadges,
  dayWindow,
  emptySums,
  medianReplyWithin,
  parseStoredBadges,
  publicBadges,
  rankSignalsFromMetrics,
  replyGapMinutes,
  runReputationJobs,
  type MetricSums,
} from '../worker/lib/reputation';
import { cancelAnchorId } from '../worker/lib/storeOrderOps';
import { loadCandidates } from '../worker/lib/printMatchingStore';
import { rankScore, DEFAULT_MATCH_WEIGHTS } from '../worker/lib/printMatchingScore';
import type { EligibilityRequest } from '../worker/lib/eligibility';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { merchantReputationRoutes } from '../worker/routes/merchantReputation';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { ANONYMOUS_CACHE_CONTROL } from '../worker/lib/edgePolicy';
import type { Env } from '../worker/lib/types';

const FUTURE = '2099-01-01T00:00:00.000Z';
const RATE = 1400;
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'owner', role: 'customer', email: 'owner@x.co' };
const NOUR: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw) }) as unknown as Env;
const sums = (over: Partial<MetricSums>): MetricSums => ({ ...emptySums(), ...over });
/** `n` replies, each counted in every bound from `within` up (cumulative, like the table). */
const replies = (n: number, within: number): Partial<MetricSums> => {
  const out: Partial<MetricSums> = { first_reply_count: n, first_reply_minutes_sum: n * within };
  for (const b of [15, 30, 60, 120, 240, 480, 1440]) if (within <= b) (out as Record<string, number>)[`first_reply_within_${b}`] = n;
  return out;
};
const keys = (b: Array<{ key: string }>) => b.map((x) => x.key);
const TODAY = '2026-10-01';
const M = { verified: false, accepts_custom_requests: false };

// ================================================================ the rules

test('the median is the ⌈n/2⌉-th reply in order, counted against the bounds — and none is claimed under ten', () => {
  assert.equal(medianReplyWithin(sums(replies(9, 10))), null, 'nine replies claim nothing');
  assert.equal(medianReplyWithin(sums(replies(10, 10))), 15);
  // Ten replies: five within 15 minutes, five after two hours — the 5th is within 15.
  const split = sums({ first_reply_count: 10, first_reply_within_15: 5, first_reply_within_30: 5, first_reply_within_60: 5, first_reply_within_120: 5, first_reply_within_240: 10, first_reply_within_480: 10, first_reply_within_1440: 10 });
  assert.equal(medianReplyWithin(split), 15);
  // …four within 15: the median sits in the four-hour bound.
  assert.equal(medianReplyWithin({ ...split, first_reply_within_15: 4, first_reply_within_30: 4, first_reply_within_60: 4, first_reply_within_120: 4 }), 240);
  // Mostly unanswered within a day: no «يرد خلال يوم» for a store that does not answer.
  assert.equal(medianReplyWithin(sums({ first_reply_count: 10, first_reply_within_1440: 4 })), null);
  assert.equal(MIN_REPLY_SAMPLES, 10);
});

test('verified_merchant and fast_response appear only with their evidence', () => {
  assert.deepEqual(computeBadges(emptySums(), emptySums(), { ...M, verified: true }, { today: TODAY }), [
    { key: 'verified_merchant', since: TODAY, evidence: { verified: true } },
  ]);
  assert.deepEqual(computeBadges(emptySums(), emptySums(), M, { today: TODAY }), []);

  const fast = computeBadges(sums(replies(10, 60)), emptySums(), M, { today: TODAY });
  assert.deepEqual(fast, [{ key: 'fast_response', since: TODAY, evidence: { median_within_minutes: 60, threads: 10, window_days: 30 } }]);
  assert.deepEqual(keys(computeBadges(sums(replies(9, 10)), emptySums(), M, { today: TODAY })), [], 'nine threads are not ten');
  assert.deepEqual(keys(computeBadges(sums(replies(20, 120)), emptySums(), M, { today: TODAY })), [], 'a two-hour median is not fast');
});

test('reliable_seller: ≥ 20 completed in 90 days, merchant cancels ≤ 3 %, no dispute lost — each boundary', () => {
  const at = (o: Partial<MetricSums>) => keys(computeBadges(emptySums(), sums(o), M, { today: TODAY })).includes('reliable_seller');
  assert.equal(at({ orders_completed: 20 }), true);
  assert.equal(at({ orders_completed: 19 }), false, '19 completed');
  assert.equal(at({ orders_completed: 97, orders_cancelled_by_merchant: 3 }), true, 'exactly 3 %');
  assert.equal(at({ orders_completed: 32, orders_cancelled_by_merchant: 1 }), false, '1 of 33 is 3.03 %');
  assert.equal(at({ orders_completed: 40, disputes_lost: 1 }), false, 'one lost dispute');
  const [b] = computeBadges(emptySums(), sums({ orders_completed: 97, orders_cancelled_by_merchant: 3 }), M, { today: TODAY }).filter((x) => x.key === 'reliable_seller');
  assert.deepEqual(b.evidence, { completed: 97, merchant_cancel_percent: 3, disputes_lost: 0, window_days: 90 });
});

test('custom_specialist needs ten custom jobs AND a store that takes custom work; high_completion ≥ 95 % of ≥ 20', () => {
  const custom = (n: number, accepts: boolean) =>
    keys(computeBadges(emptySums(), sums({ custom_orders_completed: n, orders_completed: n }), { ...M, accepts_custom_requests: accepts }, { today: TODAY })).includes('custom_specialist');
  assert.equal(custom(10, true), true);
  assert.equal(custom(10, false), false, 'a store that takes no custom work');
  assert.equal(custom(9, true), false);

  const high = (done: number, cancelled: number) =>
    computeBadges(emptySums(), sums({ orders_completed: done, orders_cancelled_by_merchant: cancelled }), M, { today: TODAY }).find((x) => x.key === 'high_completion');
  assert.deepEqual(high(19, 1)?.evidence, { completion_percent: 95, orders: 20, window_days: 90 });
  assert.equal(high(18, 2), undefined, '90 %');
  assert.equal(high(18, 1), undefined, 'nineteen orders are not twenty');
});

test('`since` holds while the badge is held, and restarts when it was lost', () => {
  const previous = [{ key: 'verified_merchant' as const, since: '2026-08-01', evidence: { verified: true } }];
  const kept = computeBadges(sums(replies(10, 15)), emptySums(), { ...M, verified: true }, { today: TODAY, previous });
  assert.deepEqual(kept.map((b) => [b.key, b.since]), [['verified_merchant', '2026-08-01'], ['fast_response', TODAY]]);
  // Lost (not in `previous`) then earned again: since is today.
  assert.equal(computeBadges(emptySums(), emptySums(), { ...M, verified: true }, { today: TODAY, previous: [] })[0].since, TODAY);
});

test('the public badge is {key, since}: no evidence, unknown keys dropped, a revoked verification gone at once', () => {
  const stored = JSON.stringify([
    { key: 'verified_merchant', since: '2026-09-01', evidence: { verified: true } },
    { key: 'fast_response', since: '2026-09-02', evidence: { median_within_minutes: 15, threads: 12, window_days: 30 } },
    { key: 'invented_badge', since: '2026-09-02', evidence: {} },
    { key: 'fast_response', since: '2026-09-09', evidence: {} },
  ]);
  assert.deepEqual(publicBadges({ verified: 1, badges_json: stored }), [
    { key: 'verified_merchant', since: '2026-09-01' },
    { key: 'fast_response', since: '2026-09-02' },
  ]);
  assert.deepEqual(keys(publicBadges({ verified: 0, badges_json: stored })), ['fast_response']);
  assert.deepEqual(publicBadges({ verified: 1, badges_json: 'not json' }), []);
  assert.deepEqual(publicBadges({ verified: 1 }), [], 'a database behind 0163 has no column');
  assert.deepEqual(parseStoredBadges(stored).length, 2);
});

test('a reply gap is whole minutes rounded up; unanswered is final only after a day', () => {
  const now = Date.parse('2026-09-21T03:00:00.000Z');
  assert.equal(replyGapMinutes({ opened_at: '2026-09-20T06:00:00.000Z', replied_at: '2026-09-20T06:10:00.000Z' }, now), 10);
  assert.equal(replyGapMinutes({ opened_at: '2026-09-20T06:00:00.000Z', replied_at: '2026-09-20T06:10:00.500Z' }, now), 11);
  assert.equal(replyGapMinutes({ opened_at: '2026-09-19T01:00:00.000Z', replied_at: '2026-09-20T06:00:00.000Z' }, now), Infinity);
  assert.equal(replyGapMinutes({ opened_at: '2026-09-20T20:00:00.000Z', replied_at: null }, now), null, 'seven hours: still pending');
  assert.equal(replyGapMinutes({ opened_at: '2026-09-20T01:00:00.000Z', replied_at: null }, now), Infinity, 'twenty-six hours: a late sample');
  // The Baghdad day: 2026-09-20 runs from 21:00 UTC on the 19th.
  assert.deepEqual(dayWindow('2026-09-20'), { start: '2026-09-19T21:00:00.000Z', end: '2026-09-20T21:00:00.000Z' });
  assert.equal(dayWindow('2026-02-31'), null);
});

// ================================================================= the day

function seedMerchants(raw = freshDb()) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('owner','Ali','owner@x.co','h','customer','ali'), ('owner2','Omar','owner2@x.co','h','customer','omar'),
      ('stranger','Nour','stranger@x.co','h','customer','nour'), ('boss','Boss','boss@x.co','h','admin','boss');
    INSERT INTO community_merchants (id,user_id,name,verified) VALUES ('m1','owner','Ali 3D',1), ('m2','owner2','Omar 3D',0);
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,accepts_custom_requests) VALUES
      ('s1','m1','owner','ali3d','Ali 3D',1), ('s2','m2','owner2','omar3d','Omar 3D',0);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

/** A store or request thread between customer `cust` and m1's store, with roles written as the chat door writes them. */
function thread(raw: DatabaseSync, id: string, cust: string, kind: 'store' | 'request' | '' = 'store', role = 'customer') {
  raw.prepare('INSERT OR IGNORE INTO users (id,name,email,password_hash,role) VALUES (?,?,?,?,?)').run(cust, cust, `${cust}@x.co`, 'h', 'customer');
  raw.prepare("INSERT INTO chats (id, context_type, context_id, store_id, merchant_id, last_message_at) VALUES (?, ?, ?, 's1', 'm1', '2026-09-30T00:00:00.000Z')")
    .run(id, kind, kind === 'request' ? 'r_x' : cust);
  raw.prepare("INSERT INTO chat_participants (chat_id, user_id, role) VALUES (?, ?, ?), (?, 'owner', 'merchant')").run(id, cust, role, id);
}
let seq = 0;
function say(raw: DatabaseSync, chatId: string, sender: string, at: string, system = 0) {
  raw.prepare('INSERT INTO chat_messages (id, chat_id, sender_id, body, created_at, is_system) VALUES (?, ?, ?, ?, ?, ?)').run(`msg${String(++seq).padStart(4, '0')}`, chatId, sender, 'x', at, system);
}

function communityOrder(raw: DatabaseSync, id: string, merchant: string, state: string, completedAt: string | null) {
  raw.prepare("INSERT OR IGNORE INTO community_requests (id,customer_id,title,description,state,status,visibility) VALUES (?, 'owner2', 't', 'd', 'completed', 'closed', 'public')").run(`r_${id}`);
  raw.prepare("INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES (?, ?, ?, 's1', 10000, 'accepted')").run(`o_${id}`, `r_${id}`, merchant);
  raw.prepare(
    `INSERT INTO community_orders (id, request_id, offer_id, customer_id, merchant_id, store_id, state, price_iqd, platform_fee_iqd, merchant_receivable_iqd, completed_at)
     VALUES (?, ?, ?, 'stranger', ?, 's1', ?, 10000, 500, 9500, ?)`
  ).run(id, `r_${id}`, `o_${id}`, merchant, state, completedAt);
}
function storeOrder(raw: DatabaseSync, id: string, status: string, deliveredAt: string | null) {
  raw.prepare(
    `INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd,delivered_at,created_at)
     VALUES (?, 'stranger', ?, 25000, 'm1', 's1', 'merchant', 'store_product', '{}', 'd', '{}', 'wallet', 25000, ${RATE}, 0, ?, '2026-09-15T10:00:00.000Z')`
  ).run(id, status, deliveredAt);
}

test('one Baghdad day of real rows becomes one row per merchant — replies by the turn rule, completions, own cancellations, lost disputes', async () => {
  const raw = seedMerchants();
  // Day 2026-09-20 (Baghdad) = 2026-09-19T21:00Z … 2026-09-20T21:00Z.
  for (let i = 1; i <= 8; i++) {
    thread(raw, `t${i}`, `c${i}`);
    say(raw, `t${i}`, `c${i}`, '2026-09-20T06:00:00.000Z');
    say(raw, `t${i}`, 'owner', '2026-09-20T06:10:00.000Z');
  }
  // A customer writing twice is ONE question waiting: measured from the first line.
  thread(raw, 't9', 'c9');
  say(raw, 't9', 'c9', '2026-09-20T06:00:00.000Z');
  say(raw, 't9', 'c9', '2026-09-20T06:05:00.000Z');
  say(raw, 't9', 'owner', '2026-09-20T06:40:00.000Z');
  thread(raw, 't10', 'c10');
  say(raw, 't10', 'c10', '2026-09-20T06:00:00.000Z');
  say(raw, 't10', 'owner', '2026-09-20T08:00:00.000Z');
  // Unanswered for 26 hours at the run: a late sample (1440 in the sum, in no bound).
  thread(raw, 't11', 'c11');
  say(raw, 't11', 'c11', '2026-09-20T01:00:00.000Z');
  // Unanswered for seven hours: pending — left for the re-run.
  thread(raw, 't12', 'c12');
  say(raw, 't12', 'c12', '2026-09-20T20:00:00.000Z');
  // The store spoke first; the customer's answer opens a turn; a system card is nobody speaking.
  thread(raw, 't13', 'c13');
  say(raw, 't13', 'owner', '2026-09-20T05:00:00.000Z');
  say(raw, 't13', 'c13', '2026-09-20T06:00:00.000Z');
  say(raw, 't13', 'owner', '2026-09-20T06:19:00.000Z', 1);
  say(raw, 't13', 'owner', '2026-09-20T06:20:00.000Z');
  // Still waiting from the day before: no new turn on the 20th.
  thread(raw, 't14', 'c14');
  say(raw, 't14', 'c14', '2026-09-19T17:00:00.000Z');
  say(raw, 't14', 'c14', '2026-09-20T06:00:00.000Z');
  say(raw, 't14', 'owner', '2026-09-20T07:00:00.000Z');
  // A request's thread counts; a personal DM and a thread whose roles were never written do not.
  thread(raw, 't15', 'c15', 'request');
  say(raw, 't15', 'c15', '2026-09-20T06:00:00.000Z');
  say(raw, 't15', 'owner', '2026-09-20T06:05:00.000Z');
  thread(raw, 't16', 'c16', '');
  say(raw, 't16', 'c16', '2026-09-20T06:00:00.000Z');
  say(raw, 't16', 'owner', '2026-09-20T06:01:00.000Z');
  thread(raw, 't17', 'c17', 'store', '');
  say(raw, 't17', 'c17', '2026-09-20T06:00:00.000Z');
  say(raw, 't17', 'owner', '2026-09-20T06:01:00.000Z');

  // Orders: two custom jobs completed on the day (one at its first Baghdad second), one the day before.
  communityOrder(raw, 'co_done', 'm1', 'completed', '2026-09-20T10:00:00.000Z');
  communityOrder(raw, 'co_edge', 'm1', 'completed', '2026-09-19T21:00:00.000Z');
  communityOrder(raw, 'co_before', 'm1', 'completed', '2026-09-19T20:59:59.999Z');
  storeOrder(raw, 'ord_deliv', 'delivered', '2026-09-20T12:00:00.000Z');
  // Cancelled by the merchant (the store door's own row) and by the customer (not the merchant's).
  storeOrder(raw, 'ord_cxl_m', 'cancelled', null);
  storeOrder(raw, 'ord_cxl_c', 'cancelled', null);
  raw.exec(`
    INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note) VALUES
      ('${cancelAnchorId('ord_cxl_m')}', 'ord_cxl_m', 'cancelled', 'cancelled', 'manual', '2026-09-20T09:00:00.000Z', 'owner', 'Cancelled by the merchant: out of stock'),
      ('${cancelAnchorId('ord_cxl_c')}', 'ord_cxl_c', 'cancelled', 'cancelled', 'manual', '2026-09-20T09:00:00.000Z', 'stranger', 'Cancelled by the customer');
  `);
  communityOrder(raw, 'co_cxl', 'm1', 'cancelled', null);
  communityOrder(raw, 'co_cxl_c', 'm1', 'cancelled', null);
  raw.exec(`
    INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES
      ('owner', 'community.order_cancelled', 'co_cxl', '{"by":"merchant","state":"funded"}', '2026-09-20T11:00:00.000Z'),
      ('stranger', 'community.order_cancelled', 'co_cxl_c', '{"by":"customer","state":"funded"}', '2026-09-20T11:00:00.000Z'),
      ('boss', 'something.else', 'x', '{"truncated', '2026-09-20T11:00:00.000Z');
    INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, created_at) VALUES
      ('rep1', 'm1', 'dispute_lost', -20, '2026-09-20T13:00:00.000Z'), ('rep2', 'm1', 'dispute_won', 0, '2026-09-20T13:00:00.000Z');
  `);
  // Omar finished one job that day; nothing else.
  communityOrder(raw, 'co_omar', 'm2', 'completed', '2026-09-20T10:00:00.000Z');

  const now = Date.parse('2026-09-21T03:00:00.000Z');
  const report = await aggregateMerchantMetrics(envOf(raw), '2026-09-20', now);
  assert.deepEqual(report, { day: '2026-09-20', merchants: 2, samples: 13, pending: 1 });
  const cols = 'first_reply_minutes_sum, first_reply_count, first_reply_within_15, first_reply_within_30, first_reply_within_60, first_reply_within_120, first_reply_within_240, first_reply_within_480, first_reply_within_1440, orders_completed, custom_orders_completed, orders_cancelled_by_merchant, disputes_lost';
  const m1 = () => row(raw, `SELECT ${cols} FROM merchant_metrics_daily WHERE merchant_id = 'm1' AND day = '2026-09-20'`);
  // 8×10 + 40 + 120 + 1440 (late) + 20 + 5 = 1705 over 13 samples.
  const expected = {
    first_reply_minutes_sum: 1705, first_reply_count: 13,
    first_reply_within_15: 9, first_reply_within_30: 10, first_reply_within_60: 11, first_reply_within_120: 12,
    first_reply_within_240: 12, first_reply_within_480: 12, first_reply_within_1440: 12,
    orders_completed: 3, custom_orders_completed: 2, orders_cancelled_by_merchant: 2, disputes_lost: 1,
  };
  assert.deepEqual(m1(), expected);
  assert.deepEqual(row(raw, "SELECT orders_completed, custom_orders_completed, first_reply_count FROM merchant_metrics_daily WHERE merchant_id = 'm2'"), {
    orders_completed: 1, custom_orders_completed: 1, first_reply_count: 0,
  });

  // The same night again: nothing moves.
  await aggregateMerchantMetrics(envOf(raw), '2026-09-20', now);
  assert.deepEqual(m1(), expected);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_metrics_daily'), 2);

  // The next night re-runs the day: the pending turn has become late; Omar's
  // job was moved off the day, so his row for it is gone.
  raw.exec("UPDATE community_orders SET completed_at = '2026-09-22T10:00:00.000Z' WHERE id = 'co_omar'");
  const later = await aggregateMerchantMetrics(envOf(raw), '2026-09-20', Date.parse('2026-09-22T03:00:00.000Z'));
  assert.equal(later.pending, 0);
  assert.deepEqual(m1(), { ...expected, first_reply_minutes_sum: 1705 + 1440, first_reply_count: 14 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_metrics_daily WHERE merchant_id = 'm2'"), 0);
  // The store's cancel anchor is the id the SQL above joins on.
  assert.equal(cancelAnchorId('x'), 'osh_cancel_x');
});

// ================================================================ the night

const NIGHT = Date.parse('2026-09-30T21:30:00.000Z'); // 00:30 on 2026-10-01, Baghdad
function metricsRow(raw: DatabaseSync, merchant: string, day: string, over: Partial<MetricSums>) {
  const s = sums(over);
  const cols = Object.keys(s);
  raw.prepare(`INSERT INTO merchant_metrics_daily (merchant_id, day, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
    .run(merchant, day, ...cols.map((k) => (s as unknown as Record<string, number>)[k]));
}
function earnedWorld() {
  const raw = seedMerchants();
  // Ali: twelve fast replies inside 30 days; 25 completed (12 custom) inside 90.
  metricsRow(raw, 'm1', '2026-09-10', replies(12, 10));
  metricsRow(raw, 'm1', '2026-08-15', { orders_completed: 25, custom_orders_completed: 12 });
  // Omar: five replies — under ten — and three jobs.
  metricsRow(raw, 'm2', '2026-09-12', { ...replies(5, 10), orders_completed: 3 });
  return raw;
}

test('the night runs once per Baghdad day and stores each badge WITH its evidence; responds_within_minutes is NULL under ten samples', async () => {
  const raw = earnedWorld();
  const first = await runReputationJobs(envOf(raw), NIGHT);
  assert.equal(first.ran, true);
  assert.equal(first.day, '2026-10-01');
  assert.deepEqual(first.aggregated.map((a) => a.day), ['2026-09-29', '2026-09-30']);
  assert.equal((await runReputationJobs(envOf(raw), NIGHT + 14 * 60_000)).ran, false, 'the next tick of the same day does nothing');

  const stored = JSON.parse(row<{ badges_json: string }>(raw, "SELECT badges_json FROM community_merchants WHERE id = 'm1'")!.badges_json);
  assert.deepEqual(stored, [
    { key: 'verified_merchant', since: '2026-10-01', evidence: { verified: true } },
    { key: 'fast_response', since: '2026-10-01', evidence: { median_within_minutes: 15, threads: 12, window_days: 30 } },
    { key: 'reliable_seller', since: '2026-10-01', evidence: { completed: 25, merchant_cancel_percent: 0, disputes_lost: 0, window_days: 90 } },
    { key: 'custom_specialist', since: '2026-10-01', evidence: { custom_completed: 12, window_days: 90 } },
    { key: 'high_completion', since: '2026-10-01', evidence: { completion_percent: 100, orders: 25, window_days: 90 } },
  ]);
  assert.equal(row<{ badges_json: string }>(raw, "SELECT badges_json FROM community_merchants WHERE id = 'm2'")!.badges_json, '[]');
  assert.deepEqual(all(raw, 'SELECT id, responds_within_minutes FROM merchant_stores ORDER BY id'), [
    { id: 's1', responds_within_minutes: 15 },
    { id: 's2', responds_within_minutes: null },
  ]);

  // The next night: a lost dispute inside the 90-day window takes
  // reliable_seller away; every badge still held keeps its `since`.
  metricsRow(raw, 'm1', '2026-09-27', { disputes_lost: 1 });
  assert.equal((await runReputationJobs(envOf(raw), NIGHT + 86_400_000)).ran, true);
  const next = parseStoredBadges(row<{ badges_json: string }>(raw, "SELECT badges_json FROM community_merchants WHERE id = 'm1'")!.badges_json);
  assert.deepEqual(next.map((b) => [b.key, b.since]), [
    ['verified_merchant', '2026-10-01'],
    ['fast_response', '2026-10-01'],
    ['custom_specialist', '2026-10-01'],
    ['high_completion', '2026-10-01'],
  ]);

  // The replies gone (a merchant who stopped answering): the badge and the line go with them.
  raw.exec("DELETE FROM merchant_metrics_daily WHERE merchant_id = 'm1' AND day = '2026-09-10'");
  assert.equal((await runReputationJobs(envOf(raw), NIGHT + 2 * 86_400_000)).ran, true);
  assert.ok(!keys(parseStoredBadges(row<{ badges_json: string }>(raw, "SELECT badges_json FROM community_merchants WHERE id = 'm1'")!.badges_json)).includes('fast_response'));
  assert.equal(row<{ r: number | null }>(raw, "SELECT responds_within_minutes AS r FROM merchant_stores WHERE id = 's1'")!.r, null);
});

test('the scheduled handler registers the night beside the durable jobs, contained', () => {
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  assert.match(index, /runReputationJobs\(env\)\.catch\(/);
});

// ============================================================ the reads

const readMount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
  a.route('/api/merchant/reputation', merchantReputationRoutes);
};
const reader = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, readMount);

test('the public reads carry {key, since} — the store read, the directory card, the creator page — and never the evidence', async () => {
  const raw = earnedWorld();
  await runReputationJobs(envOf(raw), NIGHT);
  const expected = BADGE_KEYS.map((key) => ({ key, since: '2026-10-01' }));

  const store = await get(reader(raw, null), '/api/community/store/m1');
  assert.equal(store.status, 200);
  const storeBody = await json(store);
  assert.deepEqual(storeBody.merchant.badges, expected);
  const directory = await json(await get(reader(raw, NOUR), '/api/community/merchants'));
  assert.deepEqual((directory.merchants as Array<{ id: string; badges: unknown }>).find((m) => m.id === 'm1')!.badges, expected);
  assert.deepEqual((directory.merchants as Array<{ id: string; badges: unknown }>).find((m) => m.id === 'm2')!.badges, []);
  const creator = await get(reader(raw, null), '/api/community/creators/ali');
  assert.equal(creator.status, 200);
  assert.deepEqual((await json(creator)).creator.store.badges, expected);
  for (const body of [JSON.stringify(storeBody), JSON.stringify(directory)]) {
    assert.ok(!body.includes('evidence') && !body.includes('badges_json') && !body.includes('median_within'), 'no evidence in a public read');
  }

  // An admin revokes the verification: the badge is gone from the next read, not the next night.
  raw.exec("UPDATE community_merchants SET verified = 0 WHERE id = 'm1'");
  assert.deepEqual(keys((await json(await get(reader(raw, null), '/api/community/store/m1'))).merchant.badges), BADGE_KEYS.filter((k) => k !== 'verified_merchant'));
});

test('the catalogue: every key and its rule numbers, served to guests from the colo and privately to members', async () => {
  const raw = seedMerchants();
  const guest = await get(reader(raw, null), '/api/community/badges');
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get('Cache-Control'), ANONYMOUS_CACHE_CONTROL);
  const body = await json(guest);
  assert.deepEqual(body.badges, badgeCatalogue());
  assert.deepEqual(body.badges.map((b: { key: string }) => b.key), [...BADGE_KEYS]);
  const fast = (body.badges as Array<{ key: string; rule_params: unknown }>).find((b) => b.key === 'fast_response');
  assert.deepEqual(fast?.rule_params, { window_days: 30, median_within_minutes: 60, min_threads: 10 });
  const member = await get(reader(raw, NOUR), '/api/community/badges');
  assert.equal(member.headers.get('Cache-Control'), 'private, no-store');
  // Inside the community's wall like the cards that show them.
  raw.exec(`UPDATE admin_settings SET value = '{"open":false}' WHERE key = 'communityGate'`);
  assert.notEqual((await get(reader(raw, null), '/api/community/badges')).status, 200);
});

test('the merchant\'s own page has the evidence and the windows, private — and nobody else\'s', async () => {
  const raw = earnedWorld();
  await runReputationJobs(envOf(raw), NIGHT);
  const res = await get(reader(raw, ALI), '/api/merchant/reputation');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { reputation } = await json(res);
  const fast = (reputation.badges as Array<{ key: string; evidence: unknown }>).find((b) => b.key === 'fast_response');
  assert.deepEqual(fast?.evidence, { median_within_minutes: 15, threads: 12, window_days: 30 });
  assert.equal(reputation.responds_within_minutes, 15);
  assert.equal(reputation.metrics.window_30.first_reply_count, 12);
  assert.equal(reputation.metrics.window_30.median_within_minutes, 15);
  assert.equal(reputation.metrics.window_90.orders_completed, 25);
  assert.equal(reputation.metrics.window_90.completion_percent, 100);
  assert.equal(reputation.rules.reliable_seller.min_completed, 20);
  assert.equal((await get(reader(raw, NOUR), '/api/merchant/reputation')).status, 404, 'no store, nothing to read');
  assert.equal((await get(reader(raw, null), '/api/merchant/reputation')).status, 401);
});

// ============================================================ the matcher

test('the matcher reads response time and trouble rate from the metrics — and «no history» stays mid-table', async () => {
  const raw = seedMerchants();
  raw.exec(`
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250), ('p2','m2','s2','P1S','fdm',256,256,250);
  `);
  const today = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - n * 86_400_000).toISOString().slice(0, 10);
  metricsRow(raw, 'm1', day(3), { ...replies(12, 10), orders_completed: 9, orders_cancelled_by_merchant: 1 });
  const [ali, omar] = await loadCandidates(asD1(raw), ['m1', 'm2']).then((c) => ['m1', 'm2'].map((id) => c.find((x) => x.merchant_id === id)!));
  assert.equal(ali.response_minutes, 15);
  assert.equal(ali.trouble_rate, 0.1);
  assert.equal(omar.response_minutes, null);
  assert.equal(omar.trouble_rate, 0);
  assert.deepEqual(rankSignalsFromMetrics(sums({ ...replies(12, 10), orders_completed: 9, orders_cancelled_by_merchant: 1 }), sums({ orders_completed: 9, orders_cancelled_by_merchant: 1 })), {
    response_minutes: 15,
    trouble_rate: 0.1,
  });

  const req: EligibilityRequest = {
    id: 'r', customer_id: 'c', revision: 1, on_board: true, process: 'fdm', material_id: null, color_hex: '', quality: 'standard',
    colors_count: 1, dims_mm: null, grams: null, governorate: '', delivery_pref: '', estimate_iqd: null, quantity: 1,
  };
  const scoreOf = (m: typeof ali) => rankScore(req, m.printers[0], m, null, DEFAULT_MATCH_WEIGHTS).detail;
  assert.ok(scoreOf(ali).response_time > scoreOf(omar).response_time, 'a fast replier ranks above «no history»');
  assert.ok(scoreOf(ali).reliability < scoreOf(omar).reliability, 'a cancelling merchant ranks below a clean record');
});

// ====================================================== the admin's decision

function disputeWorld() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','owner@x.co','h','customer'), ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep','buyer','deposit','USD',${Math.ceil((500_000 * 100) / RATE)},'approved','seed');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}
const deskMount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};
const desk = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, deskMount);

/** A request, Ali's accepted offer, the work delivered, and Sara's dispute. */
async function disputedJob(raw: DatabaseSync, n: number) {
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r${n}','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',1,'${FUTURE}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o${n}','r${n}','m1','s1',20000,'pending');
  `);
  const list = await json(await get(desk(raw, BUYER), `/api/marketplace/requests/r${n}/offers`));
  const o = (list.offers as Array<{ id: string; price_iqd: number; revision: number }>).find((x) => x.id === `o${n}`)!;
  const acc = await post(desk(raw, BUYER), `/api/marketplace/offers/o${n}/accept`, { expected_price_iqd: o.price_iqd, offer_revision: o.revision });
  assert.equal(acc.status, 201, JSON.stringify(await json(acc.clone())));
  const orderId = (await json(acc)).order.id as string;
  assert.equal((await post(desk(raw, ALI), `/api/marketplace/orders/${orderId}/start`)).status, 200);
  assert.equal((await post(desk(raw, ALI), `/api/marketplace/orders/${orderId}/delivered`)).status, 200);
  assert.equal((await post(desk(raw, BUYER), `/api/marketplace/orders/${orderId}/dispute`, { description: 'It arrived cracked in two pieces' })).status, 201);
  const escrowId = row<{ id: string }>(raw, 'SELECT id FROM community_escrows WHERE community_order_id = ?', orderId)!.id;
  return { orderId, escrowId };
}
const completed = (raw: DatabaseSync) => row<{ n: number }>(raw, "SELECT completed_orders AS n FROM community_merchants WHERE id = 'm1'")!.n;
const completionEvents = (raw: DatabaseSync, orderId: string) =>
  count(raw, "SELECT COUNT(*) AS n FROM merchant_reputation_events WHERE community_order_id = ? AND kind = 'order_completed'", orderId);

test('an admin\'s release counts the completion once — completed_orders and order_completed — and a replay adds nothing', async () => {
  const raw = disputeWorld();
  const { orderId, escrowId } = await disputedJob(raw, 1);
  assert.equal(completed(raw), 0);
  const r = await post(desk(raw, BOSS), `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'release', reason: 'the work was fine' });
  assert.equal(r.status, 200, JSON.stringify(await json(r.clone())));
  assert.equal(completed(raw), 1);
  assert.equal(completionEvents(raw, orderId), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_reputation_events WHERE community_order_id = ? AND kind = 'dispute_won'", orderId), 1);
  const again = await json(await post(desk(raw, BOSS), `/api/admin/community/escrows/${escrowId}/resolve`, { decision: 'release', reason: 'the work was fine' }));
  assert.equal(again.replayed, true);
  assert.equal(completed(raw), 1, 'a replayed decision counts nothing twice');
  assert.equal(completionEvents(raw, orderId), 1);
  // And the night counts it on its day, as a custom job.
  const day = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  await aggregateMerchantMetrics(envOf(raw), day);
  assert.deepEqual(row(raw, 'SELECT orders_completed, custom_orders_completed, disputes_lost FROM merchant_metrics_daily WHERE merchant_id = ? AND day = ?', 'm1', day), {
    orders_completed: 1, custom_orders_completed: 1, disputes_lost: 0,
  });
});

test('a partial refund is a completed job too; a full refund is not', async () => {
  const raw = disputeWorld();
  const partial = await disputedJob(raw, 1);
  const p = await post(desk(raw, BOSS), `/api/admin/community/escrows/${partial.escrowId}/resolve`, { decision: 'partial_refund', amount_iqd: 5_000, reason: 'half the parts were wrong' });
  assert.equal(p.status, 200, JSON.stringify(await json(p.clone())));
  assert.equal(completed(raw), 1);
  assert.equal(completionEvents(raw, partial.orderId), 1);

  const full = await disputedJob(raw, 2);
  const f = await post(desk(raw, BOSS), `/api/admin/community/escrows/${full.escrowId}/resolve`, { decision: 'refund', reason: 'nothing usable arrived' });
  assert.equal(f.status, 200);
  assert.equal(completed(raw), 1, 'a refunded order is not a finished job');
  assert.equal(completionEvents(raw, full.orderId), 0);
  // Both decisions went against the merchant: two lost disputes on the day.
  const day = new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
  await aggregateMerchantMetrics(envOf(raw), day);
  assert.deepEqual(row(raw, 'SELECT orders_completed, disputes_lost FROM merchant_metrics_daily WHERE merchant_id = ? AND day = ?', 'm1', day), {
    orders_completed: 1, disputes_lost: 2,
  });
});
