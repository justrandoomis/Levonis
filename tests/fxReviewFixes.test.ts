/**
 * THE FX-1 REVIEW'S SERVER FINDINGS, ONE TEST EACH (security #1, #2;
 * correctness C1–C5, C7, #9, #10). Each failed on the FX-1 commits as they
 * were reviewed and passes now. Real 0179 database, simulated clock, injected
 * provider fake — no network, ever.
 *
 *   negative     an adjustment that makes the candidate zero or negative is a
 *                400 at the owner's door, in every mode (no 500); and a
 *                candidate that is out of bounds anyway is RECORDED by the
 *                scheduler (INVALID, failing_since, lease released, the other
 *                pairs committed) instead of aborting the run unrecorded
 *   fresh        an adjustment never re-bases the drift guard (the anchor
 *                moves by the same change and keeps its time); «أبقِ سعري
 *                الحالي يدويًا» is a mode change and needs a fresh sign-in
 *   rejection    a rejected FIRST value is not re-held nor re-rung; a
 *                rejection never freezes an in-guard move
 *   24 h         the act being made counts toward the owner's 24-hour budget;
 *                an approval is the 24-hour guard's reference
 *   history      paging never drops a row of a batch that shares one time
 *   purchase     an order placed before 0179 does not take the edit day's rates
 *   panel        a rejection is shown only while it is remembered (24 h)
 *   public       a rate the owner typed is not credited to IQWealth
 *
 * Run: node --import tsx --test tests/fxReviewFixes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, count, freshDb, get, json, post, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, fxEnv, logsOf, market, ownerCommit, pairOf } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { miscRoutes } from '../worker/routes/misc';
import { homeRoutes } from '../worker/routes/products';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { planReview } from '../worker/lib/fx/ownerActs';
import { decide } from '../worker/lib/fx/decide';
import { loadPairs, type FxPairId } from '../worker/lib/fx/pairs';
import { withinBounds } from '../packages/pricing/src/fxChain';
import { baghdadDay } from '../worker/lib/operations';

const BASE = '/api/admin/pricing';
const STALE = 11 * 60;
const H = 3_600_000;
const T0 = new Date('2026-10-08T00:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);
type Market = ReturnType<typeof market>;

function world(opts: { sessionAgeSeconds?: number; raw?: DatabaseSync } = {}) {
  const raw = opts.raw ?? freshDb();
  if (!opts.raw) raw.exec(OWNER_ROW_SQL);
  const app = stubApp(asD1(raw), OWNER, (a) => a.route(BASE, adminPricingRoutes), { sessionAgeSeconds: opts.sessionAgeSeconds ?? 0 });
  return { raw, app };
}
const ownerVersion = (raw: DatabaseSync, pair: FxPairId = 'USD_IQD') => Number(pairOf(raw, pair).owner_version);
async function tick(raw: DatabaseSync, m: Market, when: Date, lateMin = 1) {
  m.state.at = when;
  return runFxScheduler(fxEnv(raw), { now: new Date(when.getTime() + lateMin * 60_000), scheduledTime: when }, { trigger: 'cron', fetchImpl: m.f.fetch });
}
const bells = (raw: DatabaseSync, pair: FxPairId = 'USD_IQD') =>
  count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'fx_attention' AND json_extract(meta, '$.pair') = ?", pair);
const review = (raw: DatabaseSync, pair: FxPairId, decision: 'approve' | 'reject', now: Date) =>
  ownerCommit(raw, (rows) => planReview(rows.find((r) => r.pair === pair)!, { owner_version: rows.find((r) => r.pair === pair)!.owner_version, decision }, { actor: 'usr_owner', now }), now);
function usdApproved(rate = '1660', when = at(-48)) {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', rate, when.toISOString(), new Date(when.getTime() - 10 * 60_000).toISOString());
  return raw;
}

// ------------------------------------------------------------- security #1 / correctness C6

test('a negative or zero candidate is out of bounds, never a RangeError', () => {
  assert.equal(withinBounds('-340', '1000', '3000'), false);
  assert.equal(withinBounds('0', '1000', '3000'), false);
  assert.equal(withinBounds('1660', '1000', '3000'), true);
});

test('the owner\'s door: an adjustment that would make the rate implausible is 400 FX_RATE_OUT_OF_BOUNDS — before any value, while MANUAL, and with a first value pending (never a 500)', async () => {
  // No value yet, no market figure: the adjustment must stay above −bound_min.
  const none = world({ sessionAgeSeconds: STALE });
  let res = await put(none.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(none.raw), market_adjustment_iqd: '-2000' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'FX_RATE_OUT_OF_BOUNDS');
  assert.equal(pairOf(none.raw, 'USD_IQD').market_adjustment_iqd, '0', 'nothing stored');
  // −20 (what was meant) is a valid value: on this stale session it asks for a fresh sign-in (an
  // adjustment always does), and a fresh one stores it.
  res = await put(none.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(none.raw), market_adjustment_iqd: '-20' });
  assert.equal((await json(res)).code, 'REAUTH_REQUIRED');
  res = await put(world({ raw: none.raw }).app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(none.raw), market_adjustment_iqd: '-20' });
  assert.equal(res.status, 200);
  assert.equal(pairOf(none.raw, 'USD_IQD').market_adjustment_iqd, '-20');

  // A first value pending (the cron held 1,660): −2000 is a 400, not an unhandled RangeError.
  const pend = world({ sessionAgeSeconds: STALE });
  const m = market({ sell: 1660 });
  await tick(pend.raw, m, at(0));
  assert.equal(pairOf(pend.raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');
  res = await put(pend.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(pend.raw), market_adjustment_iqd: '-2000' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'FX_RATE_OUT_OF_BOUNDS');

  // MANUAL with a known market figure: market + adjustment must lie within the bounds.
  const man = world();
  applyRate(man.raw, 'USD_IQD', '1660');
  assert.equal((await put(man.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(man.raw), mode: 'MANUAL' })).status, 200);
  res = await put(man.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(man.raw), market_adjustment_iqd: '-1700' });
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'FX_RATE_OUT_OF_BOUNDS');
});

test('a candidate out of bounds is RECORDED: INVALID / FX_RATE_OUT_OF_BOUNDS, failing_since set, the lease released — and the ECB pairs of the same run still commit', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  // An adjustment the door now refuses, as a row written before this fix could carry it.
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '-2000' WHERE pair = 'USD_IQD'");
  const m = market({ sell: 1660 });
  const report = await tick(raw, m, at(0));
  assert.equal(report.skipped, undefined, `the run completed: ${JSON.stringify(report)}`);
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.last_check_result, 'INVALID');
  assert.equal(usd.last_error_code, 'FX_RATE_OUT_OF_BOUNDS');
  assert.equal(usd.fetch_status, 'FAILED');
  assert.ok(usd.failing_since, 'the 24-hour failing bell can ring');
  assert.equal(usd.lease_token, null, 'the lease is released');
  assert.equal(usd.effective_rate, null, 'nothing applied');
  assert.ok(logsOf(raw, 'USD_IQD').some((l) => l.error_code === 'FX_RATE_OUT_OF_BOUNDS'), 'a history row');
  for (const p of ['EUR_USD', 'CNY_USD'] as const) {
    assert.equal(pairOf(raw, p).last_check_result, 'REVIEW_HELD', `${p} committed in the same run`);
    assert.equal(pairOf(raw, p).lease_token, null);
  }
  // A MANUAL pair's refresh observes the same way: recorded, not thrown.
  raw.exec("UPDATE fx_rate_pairs SET mode = 'MANUAL', manual_rate = '1660', effective_rate = '1660', effective_version = 1, drift_anchor_rate = '1660', drift_anchor_at = '2026-10-01T00:00:00.000Z' WHERE pair = 'USD_IQD'");
  m.state.at = at(1);
  const r = await runFxScheduler(fxEnv(raw), { now: at(1) }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: m.f.fetch, actorId: 'usr_owner' });
  assert.equal(r.skipped, undefined);
  assert.equal(pairOf(raw, 'USD_IQD').last_check_result, 'INVALID');
  assert.equal(pairOf(raw, 'USD_IQD').lease_token, null);
});

test('decideSafely: a decision that throws is recorded INVALID / FX_DECIDE_FAILED for that pair alone', async () => {
  // Imported here so every other test of this file runs (and fails) on a commit without it.
  const { decideSafely } = await import('../worker/lib/fx/decide');
  const raw = usdApproved();
  const row = (await loadPairs(asD1(raw)))!.find((r) => r.pair === 'USD_IQD')!;
  const broken = { ...row, anomaly_threshold_pct: 'not-a-number' };
  const quote = { kind: 'quote' as const, market: '1700', buy: null, official: null, sourceUsdPerEur: null, sourceCnyPerEur: null, publishedAtMs: Date.parse('2026-10-08T05:55:00Z') };
  const clock = { now: new Date('2026-10-08T06:00:30Z'), scheduledTime: new Date('2026-10-08T06:00:00Z') };
  assert.throws(() => decide(broken, quote, { r24: {}, window: {} }, clock, 'cron'));
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  let d;
  try {
    d = decideSafely(broken, quote, { r24: {}, window: {} }, clock, 'cron');
  } finally {
    console.error = orig;
  }
  assert.equal(d.result, 'INVALID');
  assert.equal(d.code, 'FX_DECIDE_FAILED');
  assert.equal(d.set.fetch_status, 'FAILED');
  assert.doesNotMatch(JSON.stringify(errors), /1700|1660/, 'the log carries no rate');
});

// ------------------------------------------------------------- security #2

test('an adjustment never re-bases the drift guard: a stale session cannot save one at all, and two saves (+0.0001, back to 0) leave the anchor at the owner\'s confirmation, and a DRIFT hold stays a hold', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1660');
  raw.prepare(`UPDATE fx_rate_pairs SET effective_rate='1750', effective_version=effective_version+1, effective_source='provider',
                 last_known_good_rate='1750', market_rate='1750' WHERE pair='USD_IQD'`).run();
  const stale = world({ raw, sessionAgeSeconds: STALE });
  const refused = await put(stale.app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '0.0001' });
  assert.equal((await json(refused)).code, 'REAUTH_REQUIRED', 'an adjustment always asks for a fresh sign-in');
  // Even with one, an adjustment is not «تأكيد السعر الحالي».
  const { app } = world({ raw });
  const anchorAt = pairOf(raw, 'USD_IQD').drift_anchor_at;
  assert.equal((await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '0.0001' })).status, 200);
  let row = pairOf(raw, 'USD_IQD');
  assert.equal(row.effective_rate, '1750.0001');
  assert.equal(row.drift_anchor_rate, '1660.0001', 'the anchor moves by the same change');
  assert.equal(row.drift_anchor_at, anchorAt, 'and keeps its time');
  assert.equal((await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ownerVersion(raw), market_adjustment_iqd: '0' })).status, 200);
  row = pairOf(raw, 'USD_IQD');
  assert.equal(row.effective_rate, '1750');
  assert.equal(row.drift_anchor_rate, '1660', 'not the effective rate: only «تأكيد السعر الحالي» (fresh sign-in) does that');
  // 1,770 is 1.1% from the rate in force but 6.6% from the owner's confirmation: still DRIFT.
  const usd = (await loadPairs(asD1(raw)))!.find((r) => r.pair === 'USD_IQD')!;
  const quote = { kind: 'quote' as const, market: '1770', buy: null, official: null, sourceUsdPerEur: null, sourceCnyPerEur: null, publishedAtMs: Date.parse('2026-10-09T05:55:00Z') };
  const d = decide(usd, quote, { r24: { USD_IQD: { rate: '1750', adj: '0' } }, window: { USD_IQD: [] } }, { now: new Date('2026-10-09T06:00:30Z'), scheduledTime: new Date('2026-10-09T06:00:00Z') }, 'cron');
  assert.equal(d.result, 'REVIEW_HELD');
  assert.equal(d.code, 'DRIFT');
});

test('«أبقِ سعري الحالي يدويًا» is a mode change: a stale session is refused 401 REAUTH_REQUIRED; a fresh one turns tracking off and rings the guard notice', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1660');
  raw.prepare(`UPDATE fx_rate_pairs SET pending_market_rate='1720', pending_effective_rate='1720', pending_reason='ANOMALY',
                 pending_observed_at=?, status='REVIEW_REQUIRED' WHERE pair='USD_IQD'`).run(new Date().toISOString());
  const stale = world({ raw, sessionAgeSeconds: STALE });
  const refused = await post(stale.app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'keep_manual' });
  assert.equal(refused.status, 401);
  assert.equal((await json(refused)).code, 'REAUTH_REQUIRED');
  assert.equal(pairOf(raw, 'USD_IQD').mode, 'AUTO');
  const fresh = world({ raw });
  const ok = await post(fresh.app, `${BASE}/rates/fx/USD_IQD/review`, { owner_version: ownerVersion(raw), decision: 'keep_manual' });
  assert.equal(ok.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').mode, 'MANUAL');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'fx_attention'"), 1, 'the guard-change notice');
});

// ------------------------------------------------------------- correctness C1, C2, C5

test('C1: a rejected FIRST value is not re-held nor re-rung within 24 hours', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const m = market({ sell: 1660 });
  await tick(raw, m, at(0));
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');
  const rung = bells(raw);
  await review(raw, 'USD_IQD', 'reject', at(1));
  await tick(raw, m, at(6));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.pending_effective_rate, null, `re-held: ${row.pending_reason}`);
  assert.equal(row.last_check_result, 'DEFERRED');
  assert.equal(row.last_error_code, 'FX_REJECTED_RECENTLY');
  assert.equal(bells(raw), rung, 'no second bell for the value just rejected');
  // After 24 hours it is judged afresh.
  await tick(raw, m, at(30));
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');
});

test('C2: a rejection never freezes an in-guard move — 1,660 → 1,690 (+1.8%) applies after 1,720 was rejected', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1720 });
  await tick(raw, m, at(0));
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'ANOMALY');
  await review(raw, 'USD_IQD', 'reject', at(1));
  m.state.sell = 1690;
  await tick(raw, m, at(6));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'APPLIED', `${row.last_check_result} / ${row.last_error_code}`);
  assert.equal(row.effective_rate, '1690');
  // The rejected value itself, back again within 24 h, is still not held.
  m.state.sell = 1745;
  await tick(raw, m, at(12));
  assert.equal(pairOf(raw, 'USD_IQD').last_check_result, 'DEFERRED');
});

test('C5: after the owner approves 1,660 → 1,720, an ordinary +0.9% tick (1,735) applies — the approval is the 24-hour reference', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1720 });
  await tick(raw, m, at(0));
  await review(raw, 'USD_IQD', 'approve', at(1));
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1720');
  const rung = bells(raw);
  m.state.sell = 1735;
  await tick(raw, m, at(6));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'APPLIED', `${row.last_check_result} ${row.pending_reason}`);
  assert.equal(bells(raw), rung);
  // The 24-hour guard still stops a staircase measured from the approved rate.
  m.state.sell = 1769.8; // +2.9% from the approval
  await tick(raw, m, at(12));
  assert.equal(pairOf(raw, 'USD_IQD').last_check_result, 'APPLIED');
  m.state.sell = 1820; // +2.8% from the rate in force, +5.8% from the approval in the same day
  await tick(raw, m, at(18));
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'ANOMALY_24H');
});

// ------------------------------------------------------------- correctness C3

test('C3: the act being made counts — two 14% manual sets within 24 hours: the second needs confirm_large_change and a fresh sign-in', async () => {
  const stale = world({ sessionAgeSeconds: STALE });
  applyRate(stale.raw, 'USD_IQD', '1000');
  const set = (rate: string, extra: Record<string, unknown> = {}, app = stale.app) =>
    put(app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(stale.raw), rate, ...extra });
  assert.equal((await set('1140')).status, 200, 'act 1: 14%');
  const second = await set('1299.6');
  assert.equal(second.status, 409, '14% + 14% = 28% in an hour');
  assert.equal((await json(second)).code, 'PRICING_LARGE_CHANGE_CONFIRM');
  const confirmedButStale = await set('1299.6', { confirm_large_change: true });
  assert.equal((await json(confirmedButStale)).code, 'REAUTH_REQUIRED');
  assert.equal(pairOf(stale.raw, 'USD_IQD').effective_rate, '1140');
  const fresh = world({ raw: stale.raw });
  assert.equal((await set('1299.6', { confirm_large_change: true }, fresh.app)).status, 200);
});

// ------------------------------------------------------------- correctness C4

test('C4: paging the history with the (time, id) cursor never drops a row of a batch that shares one time', async () => {
  const { raw, app } = world();
  const m = market();
  await tick(raw, m, at(0)); // three rows, one per pair, one created_at
  await tick(raw, m, at(24)); // three more
  const total = count(raw, 'SELECT COUNT(*) n FROM fx_rate_log');
  assert.ok(total >= 6);
  const seen: string[] = [];
  let cursor: { before: string; id: string } | null = null;
  for (let i = 0; i < 20; i++) {
    const q = cursor ? `&before=${encodeURIComponent(cursor.before)}&before_id=${encodeURIComponent(cursor.id)}` : '';
    const b = await json(await get(app, `${BASE}/rates/history?limit=2${q}`));
    for (const it of b.items) seen.push(it.id);
    if (b.items.length < 2) break;
    const last = b.items[b.items.length - 1];
    cursor = { before: last.created_at, id: last.id };
  }
  assert.equal(new Set(seen).size, total, `history has ${total} rows, paging returned ${new Set(seen).size}`);
  assert.equal(seen.length, total, 'no row twice');
  // A malformed id is refused; an id without a time is refused.
  assert.equal((await get(app, `${BASE}/rates/history?before=2026-10-08T00:00:00.000Z&before_id=${encodeURIComponent('x y')}`)).status, 400);
  assert.equal((await get(app, `${BASE}/rates/history?before_id=fxl_1`)).status, 400);
});

// ------------------------------------------------------------- correctness C7

test('C7: a purchase ordered before 0179 (NULL rates) keeps NULL when it is edited after — only an ordering save snapshots', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,role) VALUES ('admin','boss@x.co','admin');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO products(id,name,slug,sku,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('part','Part','fx-snapshot-part','FXSNAP',20000,10000,0,'BASE');`);
  const app = stubApp(asD1(raw), { id: 'admin', email: 'boss@x.co', role: 'admin' }, (a) => a.route('/p', adminProcurementRoutes));
  const body = {
    operation_id: crypto.randomUUID(),
    supplier_id: 'supplier',
    currency: 'IQD',
    purchase_day: baghdadDay(),
    status: 'ordered',
    cost_state: 'final',
    note: '',
    lines: [{ product_id: 'part', scope: 'base', scope_id: '', qty_ordered: 1, source_unit_amount: 10000 }],
    charges: [],
  };
  const created = await json(await post(app, '/p/documents', body));
  // As 0179's ALTER leaves a document ordered before it: the four columns NULL.
  raw.prepare('UPDATE purchase_orders SET fx_usd_iqd_at_purchase=NULL, fx_eur_usd_at_purchase=NULL, fx_cny_usd_at_purchase=NULL, fx_snapshot_at=NULL WHERE id=?').run(created.id);
  applyRate(raw, 'USD_IQD', '1700');
  const detail = await json(await get(app, `/p/documents/${created.id}`));
  const res = await put(app, `/p/documents/${created.id}`, { ...body, operation_id: crypto.randomUUID(), note: 'invoice corrected', version: detail.purchase.version });
  assert.equal(res.status, 200);
  const s = raw.prepare('SELECT fx_usd_iqd_at_purchase u, fx_snapshot_at at FROM purchase_orders WHERE id=?').get(created.id) as Record<string, unknown>;
  assert.equal(s.u, null, 'the edit day\'s rate is not the purchase-time rate');
  assert.equal(s.at, null);
});

// ------------------------------------------------------------- correctness #9

test('#9: the panel shows a rejection only while it is remembered — 24 hours', async () => {
  const { raw, app } = world();
  applyRate(raw, 'USD_IQD', '1660');
  raw.prepare("UPDATE fx_rate_pairs SET rejected_rate = '1720', rejected_at = ? WHERE pair = 'USD_IQD'").run(new Date(Date.now() - 2 * H).toISOString());
  let usd = (await json(await get(app, `${BASE}/rates`))).pairs.find((p: { pair: string }) => p.pair === 'USD_IQD');
  assert.deepEqual(usd.rejected?.rejected_rate, '1720');
  raw.prepare("UPDATE fx_rate_pairs SET rejected_at = ? WHERE pair = 'USD_IQD'").run(new Date(Date.now() - 25 * H).toISOString());
  usd = (await json(await get(app, `${BASE}/rates`))).pairs.find((p: { pair: string }) => p.pair === 'USD_IQD');
  assert.equal(usd.rejected, null, 'a day-old rejection is no longer «not offered again for 24 hours»');
});

// ------------------------------------------------------------- correctness #10

test('#10: the public settings say whether the USD rate is the provider\'s (credited to IQWealth) or one the owner typed', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const pub = stubApp(asD1(raw), null, (a) => {
    a.route('/api/home', homeRoutes);
    a.route('/api', miscRoutes);
  });
  const settings = async () => [(await json(await get(pub, '/api/settings/public'))).settings, (await json(await get(pub, '/api/home'))).settings];
  for (const s of await settings()) {
    assert.equal(s.displayUsdRate, null);
    assert.equal(s.displayUsdRateAttributed, null);
  }
  applyRate(raw, 'USD_IQD', '1660'); // approved from the provider
  for (const s of await settings()) {
    assert.equal(s.displayUsdRate, '1660');
    assert.equal(s.displayUsdRateAttributed, true);
  }
  const owner = world({ raw });
  assert.equal((await put(owner.app, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: ownerVersion(raw), rate: '1650' })).status, 200);
  for (const s of await settings()) {
    assert.equal(s.displayUsdRate, '1650');
    assert.equal(s.displayUsdRateAttributed, false, 'a typed rate is not IQWealth data');
  }
});
