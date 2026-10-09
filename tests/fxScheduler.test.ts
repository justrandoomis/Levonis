/**
 * THE FX SCHEDULER, SCENARIO BY SCENARIO (FX programme plan §5, §9 §4–§6,
 * §28–§31; the owner's §35 tests 17–22).
 *
 * Every scenario runs the real scheduler on a real 0179 database, on a
 * simulated clock (the cron's scheduled time and the run's wall time), with
 * an injected provider fake — no network, ever. Owner acts go through the
 * same planner the routes use (tests/fixtures/fx.ts `ownerCommit`).
 *
 *   due logic     6h every tick; 12h skips at +6h and fetches at +12h; a late
 *                 run and an owner refresh never shift the phase; MANUAL is
 *                 never fetched by the cron; the ECB once a day for both pairs
 *   guards        >3% held, exactly 3% applied, a later normal value clears the
 *                 spike, −2.9% steps held at the second (24 h), drift >6% from
 *                 the owner's confirmation held, a rejected value not re-held
 *                 for 24 h, approval at the CURRENT adjustment, the bell every
 *                 24 h, a 25-hour-old candidate refused
 *   failure       FAILED keeps the last known good rate (never 0) and every
 *                 derived rate; a failure while a review is pending keeps
 *                 REVIEW_REQUIRED and still commits the other pairs (H1); a
 *                 trigger refusal is COMMIT_REFUSED in a minimal batch (M10)
 *   dead band     a 0.3% USD move is UNCHANGED (Q6)
 *
 * Run: node --import tsx --test tests/fxScheduler.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, count } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, fxEnv, logsOf, market, ownerCommit, pairOf } from './fixtures/fx';
import { runFxScheduler, isDue } from '../worker/lib/fx/scheduler';
import { planReview, planManualSet, planSettings } from '../worker/lib/fx/ownerActs';
import { getDisplayUsdRate } from '../worker/lib/fx/displayRate';
import type { FxPairId } from '../worker/lib/fx/pairs';

const H = 3_600_000;
const T0 = new Date('2026-10-08T00:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);

type Market = ReturnType<typeof market>;

/** One cron tick scheduled at `when`, executed `lateMin` minutes later. */
async function tick(raw: DatabaseSync, m: Market, when: Date, lateMin = 1) {
  m.state.at = when;
  return runFxScheduler(fxEnv(raw), { now: new Date(when.getTime() + lateMin * 60_000), scheduledTime: when }, { trigger: 'cron', fetchImpl: m.f.fetch });
}
async function refresh(raw: DatabaseSync, m: Market, when: Date, pairs: FxPairId[] = ['USD_IQD']) {
  m.state.at = when;
  return runFxScheduler(fxEnv(raw), { now: when }, { trigger: 'refresh', pairs, fetchImpl: m.f.fetch, actorId: 'usr_owner' });
}
const usdCalls = (m: Market) => m.f.calls.filter((c) => new URL(c.url).hostname === 'iraqsm.com').length;
const ecbCalls = (m: Market) => m.f.calls.filter((c) => new URL(c.url).hostname === 'www.ecb.europa.eu').length;
const bells = (raw: DatabaseSync, pair: FxPairId = 'USD_IQD') =>
  count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'fx_attention' AND json_extract(meta, '$.pair') = ?", pair);
const approve = (raw: DatabaseSync, pair: FxPairId, now: Date) =>
  ownerCommit(raw, (rows) => planReview(rows.find((r) => r.pair === pair)!, { owner_version: rows.find((r) => r.pair === pair)!.owner_version, decision: 'approve' }, { actor: 'usr_owner', now }), now);
const reject = (raw: DatabaseSync, pair: FxPairId, now: Date) =>
  ownerCommit(raw, (rows) => planReview(rows.find((r) => r.pair === pair)!, { owner_version: rows.find((r) => r.pair === pair)!.owner_version, decision: 'reject' }, { actor: 'usr_owner', now }), now);

/** USD/IQD approved by the owner at `when` at `rate` (anchor too); ECB pairs left alone. */
function usdApproved(rate = '1660', when = at(-48)) {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', rate, when.toISOString(), new Date(when.getTime() - 10 * 60_000).toISOString());
  return raw;
}

// ------------------------------------------------------------- §4 due logic (§35 17, 18)

test('6h: due at every tick (scheduledTime)', async () => {
  const raw = usdApproved();
  const m = market();
  for (let h = 0; h < 24; h += 6) await tick(raw, m, at(h));
  assert.equal(usdCalls(m), 4);
  assert.equal(pairOf(raw, 'USD_IQD').last_cron_success_at, at(18).toISOString());
});

test('12h: skips at +6h, fetches at +12h', async () => {
  const raw = usdApproved();
  raw.exec("UPDATE fx_rate_pairs SET interval_hours = 12 WHERE pair = 'USD_IQD'");
  const m = market();
  await tick(raw, m, at(6));
  assert.equal(usdCalls(m), 1, 'never fetched: the first tick fetches');
  await tick(raw, m, at(12));
  assert.equal(usdCalls(m), 1, '+6h skips');
  await tick(raw, m, at(18));
  assert.equal(usdCalls(m), 2, '+12h fetches');
});

test('12h: a run executed 35 minutes late is stamped with its scheduledTime; the next 12-hour tick still fetches', async () => {
  const raw = usdApproved();
  raw.exec("UPDATE fx_rate_pairs SET interval_hours = 12 WHERE pair = 'USD_IQD'");
  const m = market();
  await tick(raw, m, at(6), 35);
  assert.equal(pairOf(raw, 'USD_IQD').last_cron_success_at, at(6).toISOString(), 'stamped 06:00, not 06:35');
  await tick(raw, m, at(18));
  assert.equal(usdCalls(m), 2);
});

test('12h: an owner refresh at +3h does not shift the cron phase', async () => {
  const raw = usdApproved();
  raw.exec("UPDATE fx_rate_pairs SET interval_hours = 12 WHERE pair = 'USD_IQD'");
  const m = market();
  await tick(raw, m, at(6));
  await refresh(raw, m, at(9));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_cron_success_at, at(6).toISOString());
  assert.equal(row.last_successful_at, at(9).toISOString(), 'the refresh still records its own success');
  await tick(raw, m, at(18));
  assert.equal(usdCalls(m), 3, 'the 18:00 tick fetches');
});

test('OFF (MANUAL): never fetched by the cron — and a MANUAL rate is never touched by it', async () => {
  const raw = usdApproved();
  await ownerCommit(raw, (rows) => planManualSet(rows[0]!, { owner_version: rows[0]!.owner_version, rate: '1700' }, { actor: 'usr_owner', now: at(-1) }), at(-1));
  const m = market({ sell: 1600 });
  for (let h = 0; h < 48; h += 6) await tick(raw, m, at(h));
  assert.equal(usdCalls(m), 0);
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.mode, 'MANUAL');
  assert.equal(row.effective_rate, '1700');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1700');
  assert.equal(isDue({ ...row, mode: 'MANUAL' } as never, at(100)), false);
});

test('24h: one ECB fetch updates both EUR_USD and CNY_USD, once a day', async () => {
  const raw = usdApproved();
  const m = market();
  for (let h = 0; h < 24; h += 6) await tick(raw, m, at(h));
  assert.equal(ecbCalls(m), 1, 'one file for both pairs, once in the day');
  for (const p of ['EUR_USD', 'CNY_USD'] as const) {
    assert.equal(pairOf(raw, p).last_cron_success_at, at(0).toISOString());
    assert.equal(pairOf(raw, p).pending_reason, 'FIRST_VALUE', 'the first value waits for the owner (the two ECB pairs are approved together)');
  }
  m.state.ecbDay = '2026-10-09';
  await tick(raw, m, at(24));
  assert.equal(ecbCalls(m), 2, 'due again 24 hours after its last cron success');
});

// ------------------------------------------------------------- §6 bookkeeping

test('each decision writes last_checked_at; only a validated figure writes last_successful_at and published_at', async () => {
  const raw = usdApproved();
  const m = market();
  await tick(raw, m, at(0));
  const ok = pairOf(raw, 'USD_IQD');
  assert.equal(ok.last_checked_at, new Date(at(0).getTime() + 60_000).toISOString());
  assert.equal(ok.last_successful_at, ok.last_checked_at);
  assert.equal(ok.published_at, new Date(at(0).getTime() - 5 * 60_000).toISOString());
  m.state.usdDown = true;
  await tick(raw, m, at(6));
  const failed = pairOf(raw, 'USD_IQD');
  assert.equal(failed.last_checked_at, new Date(at(6).getTime() + 60_000).toISOString());
  assert.equal(failed.last_successful_at, ok.last_successful_at, 'a failure never moves the last success');
  assert.equal(failed.published_at, ok.published_at);
  assert.equal(failed.last_cron_success_at, at(0).toISOString(), 'a failure does not move the phase: the next tick retries');
});

// ------------------------------------------------------------- §29 failures (§35 20, 22)

test('API failure: status FAILED, effective = last known good, prices and pricing_fx_rates unchanged, storefront answers unchanged', async () => {
  const raw = usdApproved();
  const before = { derived: derivedOf(raw), products: raw.prepare('SELECT * FROM products').all(), display: await getDisplayUsdRate(asD1(raw)) };
  const m = market();
  m.state.usdDown = true;
  m.state.ecbDown = true;
  await tick(raw, m, at(0));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.fetch_status, 'FAILED');
  assert.equal(row.last_error_code, 'HTTP_503');
  assert.equal(row.effective_rate, '1660');
  assert.equal(row.last_known_good_rate, '1660');
  assert.deepEqual(derivedOf(raw), before.derived);
  assert.deepEqual(raw.prepare('SELECT * FROM products').all(), before.products);
  assert.equal(await getDisplayUsdRate(asD1(raw)), before.display);
});

test('last known good: provider down for 8 ticks keeps the LKG; never 0; the owner hears of it once a day after 24 hours', async () => {
  const raw = usdApproved();
  const m = market();
  m.state.usdDown = true;
  for (let i = 0; i < 8; i++) await tick(raw, m, at(i * 6));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.effective_rate, '1660');
  assert.equal(row.last_known_good_rate, '1660');
  assert.equal(row.failing_since, new Date(at(0).getTime() + 60_000).toISOString());
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1660');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM fx_rate_pairs WHERE effective_rate = '0' OR CAST(effective_rate AS REAL) <= 0"), 0);
  const failing = count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'fx_attention' AND meta LIKE '%\"reason\":\"failing\"%'");
  assert.ok(failing >= 1 && failing <= 2, `${failing} failing notices over 42 hours`);
});

test('a fetch failure while a first value is pending: status stays REVIEW_REQUIRED, fetch_status FAILED, and a due ECB update in the same tick is still committed (H1)', async () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const m = market();
  await tick(raw, m, at(0));
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'FIRST_VALUE');
  await approve(raw, 'EUR_USD', at(1));
  await approve(raw, 'CNY_USD', at(1));
  m.state.usdDown = true;
  m.state.ecbDay = '2026-10-09';
  m.state.usd = '1.1300';
  await tick(raw, m, at(24));
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.status, 'REVIEW_REQUIRED');
  assert.equal(usd.fetch_status, 'FAILED');
  assert.equal(usd.pending_effective_rate, '1660', 'the held candidate is untouched');
  const eur = pairOf(raw, 'EUR_USD');
  assert.equal(eur.effective_rate, '1.13', 'the ECB update committed in the same tick');
  assert.equal(eur.last_check_result, 'APPLIED');
});

test('a commit refused by a trigger records COMMIT_REFUSED in a minimal batch; pricing_fx_rates unchanged; the other pairs still commit (M10)', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1670 });
  // A guard of a later push (the FX-2 rate guard after a rollback) refusing the USD row.
  raw.exec("CREATE TRIGGER test_rate_guard BEFORE UPDATE OF rate_iqd ON pricing_fx_rates WHEN NEW.currency = 'USD' BEGIN SELECT RAISE(ABORT, 'ROLLBACK_GUARD'); END;");
  const before = derivedOf(raw);
  await tick(raw, m, at(0));
  const usd = pairOf(raw, 'USD_IQD');
  assert.equal(usd.last_check_result, 'FAILED');
  assert.equal(usd.last_error_code, 'COMMIT_REFUSED');
  assert.equal(usd.fetch_status, 'FAILED');
  assert.equal(usd.effective_rate, '1660', 'not applied');
  assert.equal(usd.lease_token, null, 'the lease is released');
  assert.deepEqual(derivedOf(raw), before, 'pricing_fx_rates is never written by the refusal batch');
  assert.equal(logsOf(raw, 'USD_IQD').at(-1)!.event, 'commit_refused');
  assert.equal(pairOf(raw, 'EUR_USD').pending_reason, 'FIRST_VALUE', 'the ECB pairs, retried alone, still committed');
});

// ------------------------------------------------------------- §30 guards (§35 21)

test('anomaly: 1,660 → 1,720 (+3.6%) held; pricing_fx_rates unchanged; approve applies 1,720; reject keeps 1,660', async () => {
  for (const decision of ['approve', 'reject'] as const) {
    const raw = usdApproved();
    const m = market({ sell: 1720 });
    await tick(raw, m, at(0));
    let row = pairOf(raw, 'USD_IQD');
    assert.equal(row.status, 'REVIEW_REQUIRED');
    assert.equal(row.pending_reason, 'ANOMALY');
    assert.equal(row.pending_effective_rate, '1720');
    assert.equal(row.effective_rate, '1660');
    assert.equal(derivedOf(raw).USD!.rate_iqd, '1660');
    if (decision === 'approve') await approve(raw, 'USD_IQD', at(1));
    else await reject(raw, 'USD_IQD', at(1));
    row = pairOf(raw, 'USD_IQD');
    assert.equal(row.effective_rate, decision === 'approve' ? '1720' : '1660');
    assert.equal(derivedOf(raw).USD!.rate_iqd, decision === 'approve' ? '1720' : '1660');
    assert.equal(row.status, 'OK');
    if (decision === 'approve') assert.equal(row.drift_anchor_rate, '1720', 'an approval re-anchors');
    else assert.equal(row.rejected_rate, '1720');
  }
});

test('exactly 3% applies (1,660 → 1,709.8)', async () => {
  const raw = usdApproved();
  await tick(raw, market({ sell: 1709.8 }), at(0));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'APPLIED');
  assert.equal(row.effective_rate, '1709.8');
  assert.equal(row.drift_anchor_rate, '1660', 'an automatic apply never moves the anchor');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1709.8');
});

test('a later in-threshold value clears the held spike', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1720 });
  await tick(raw, m, at(0));
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'ANOMALY');
  m.state.sell = 1670;
  await tick(raw, m, at(6));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.pending_effective_rate, null);
  assert.equal(row.status, 'OK');
  assert.equal(row.effective_rate, '1670');
  assert.ok(logsOf(raw, 'USD_IQD').some((l) => l.event === 'review_cleared'));
});

test('ten consecutive −2.9% candidates on the 6-hour setting: the first applies, the second is held (ANOMALY_24H); pricing_fx_rates frozen; owner bell (F1)', async () => {
  const raw = usdApproved();
  const m = market();
  let sell = 1660;
  const results: string[] = [];
  for (let i = 1; i <= 10; i++) {
    sell = Number((sell * 0.971).toFixed(4));
    m.state.sell = sell;
    await tick(raw, m, at(i * 6));
    results.push(String(pairOf(raw, 'USD_IQD').last_check_result));
    if (i === 2) assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'ANOMALY_24H');
  }
  assert.equal(results[0], 'APPLIED');
  assert.deepEqual(results.slice(1), Array(9).fill('REVIEW_HELD'));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.effective_rate, '1611.86');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1611.86', 'frozen after the first step');
  assert.ok(bells(raw) >= 1, 'the owner is told');
  const texts = raw.prepare("SELECT title_ar, title_en, body_ar, body_en, meta FROM user_notifications WHERE kind = 'fx_attention'").all();
  assert.doesNotMatch(JSON.stringify(texts.map((t) => ({ ...t }))), /[0-9٠-٩]/, 'the bell carries no figure');
});

test('slow drift of +1% a day: held (DRIFT) once 6% from the anchor; approval re-anchors', async () => {
  const raw = usdApproved();
  const m = market();
  const results: string[] = [];
  for (let d = 1; d <= 6; d++) {
    m.state.sell = Number((1660 * 1.01 ** d).toFixed(4));
    await tick(raw, m, at(d * 24));
    results.push(String(pairOf(raw, 'USD_IQD').last_check_result));
  }
  assert.deepEqual(results, ['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'APPLIED', 'REVIEW_HELD']);
  assert.equal(pairOf(raw, 'USD_IQD').pending_reason, 'DRIFT');
  await approve(raw, 'USD_IQD', at(6 * 24 + 1));
  const anchored = pairOf(raw, 'USD_IQD');
  assert.equal(anchored.drift_anchor_rate, anchored.effective_rate, 'the approval re-anchors');
  m.state.sell = Number((1660 * 1.01 ** 7).toFixed(4));
  await tick(raw, m, at(7 * 24));
  assert.equal(pairOf(raw, 'USD_IQD').last_check_result, 'APPLIED');
});

test('a rejected value is not re-held or re-rung for 24 hours; after 24 hours it is held again (M4.2)', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1720 });
  await tick(raw, m, at(0));
  await reject(raw, 'USD_IQD', at(1));
  const rung = bells(raw);
  await tick(raw, m, at(6));
  let row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'DEFERRED');
  assert.equal(row.last_error_code, 'FX_REJECTED_RECENTLY');
  assert.equal(row.pending_effective_rate, null);
  assert.equal(bells(raw), rung, 'no bell');
  await tick(raw, m, at(30));
  row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'REVIEW_HELD');
  assert.equal(bells(raw), rung + 1);
});

test('approve after an adjustment change applies pending market + the current adjustment (M4.3) — and the change never applies the held figure', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1720 });
  await tick(raw, m, at(0));
  await ownerCommit(
    raw,
    (rows) => planSettings(rows[0]!, { owner_version: rows[0]!.owner_version, market_adjustment_iqd: '20' }, { actor: 'usr_owner', now: at(1) })!,
    at(1)
  );
  let row = pairOf(raw, 'USD_IQD');
  assert.equal(row.effective_rate, '1680', 'the effective rate moves by the adjustment, not onto the held market figure');
  assert.equal(row.pending_effective_rate, '1740', 'the held candidate is re-based');
  await approve(raw, 'USD_IQD', at(2));
  row = pairOf(raw, 'USD_IQD');
  assert.equal(row.effective_rate, '1740');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1740');
});

test('a pending review re-rings the bell every 24 hours; approval of a 25-hour-old candidate → FX_REVIEW_STALE (M4.4, F15)', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1720 });
  await tick(raw, m, at(0));
  assert.equal(bells(raw), 1);
  m.state.usdDown = true;
  for (let h = 6; h <= 24; h += 6) await tick(raw, m, at(h));
  assert.equal(bells(raw), 2, 'rung again at +24 h while the source fails and the candidate waits');
  assert.equal(pairOf(raw, 'USD_IQD').status, 'REVIEW_REQUIRED');
  await assert.rejects(() => approve(raw, 'USD_IQD', at(25 + 0.1)), (e: Error & { code?: string }) => e.code === 'FX_REVIEW_STALE');
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1660');
});

// ------------------------------------------------------------- §28 manual and back to automatic

test('refresh on MANUAL logs observed, changes nothing owner-visible; "use observed as manual" goes through the owner-act path (L14)', async () => {
  const raw = usdApproved();
  await ownerCommit(raw, (rows) => planManualSet(rows[0]!, { owner_version: rows[0]!.owner_version, rate: '1700' }, { actor: 'usr_owner', now: at(-1) }), at(-1));
  const before = pairOf(raw, 'USD_IQD');
  const m = market({ sell: 1650 });
  await refresh(raw, m, at(0));
  const after = pairOf(raw, 'USD_IQD');
  assert.equal(after.last_check_result, 'OBSERVED');
  for (const k of ['mode', 'effective_rate', 'manual_rate', 'owner_version', 'market_rate', 'published_at', 'fetch_status', 'pending_effective_rate']) {
    assert.deepEqual(after[k], before[k], k);
  }
  const observed = logsOf(raw, 'USD_IQD').at(-1)!;
  assert.equal(observed.event, 'observed');
  assert.equal(observed.pending_rate, '1650', 'the candidate it would give');
  await ownerCommit(raw, (rows) => planManualSet(rows[0]!, { owner_version: rows[0]!.owner_version, rate: String(observed.pending_rate) }, { actor: 'usr_owner', now: at(1) }), at(1));
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1650');
});

test('back to AUTO within 3% applies; beyond 3% → REVIEW_REQUIRED (BACK_TO_AUTO)', async () => {
  for (const [sell, expect] of [[1690, 'APPLIED'], [1760, 'REVIEW_HELD']] as const) {
    const raw = usdApproved();
    await ownerCommit(raw, (rows) => planManualSet(rows[0]!, { owner_version: rows[0]!.owner_version, rate: '1660' }, { actor: 'usr_owner', now: at(-1) }), at(-1));
    await ownerCommit(raw, (rows) => planSettings(rows[0]!, { owner_version: rows[0]!.owner_version, mode: 'AUTO' }, { actor: 'usr_owner', now: at(0) })!, at(0));
    const m = market({ sell });
    m.state.at = at(0);
    await runFxScheduler(fxEnv(raw), { now: at(0) }, { trigger: 'back_to_auto', pairs: ['USD_IQD'], fetchImpl: m.f.fetch });
    const row = pairOf(raw, 'USD_IQD');
    assert.equal(row.mode, 'AUTO');
    assert.equal(row.last_check_result, expect, String(sell));
    if (expect === 'REVIEW_HELD') assert.equal(row.pending_reason, 'BACK_TO_AUTO');
  }
});

// ------------------------------------------------------------- §31 dead band and S6 concurrency

test('a 0.3% USD move is UNCHANGED under the 0.5% dead band: no derived write, no history, no purge', async () => {
  const raw = usdApproved();
  const before = derivedOf(raw);
  const report = await tick(raw, market({ sell: 1664.98 }), at(0));
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.last_check_result, 'UNCHANGED');
  assert.equal(row.effective_rate, '1660');
  assert.deepEqual(derivedOf(raw), before);
  assert.equal(report.displayRateChanged, false);
});

test('two schedulers at once: the second finds the lease held — one fetch, one commit (S6)', async () => {
  const raw = usdApproved();
  const m = market({ sell: 1670 });
  const [a, b] = await Promise.all([tick(raw, m, at(0)), tick(raw, m, at(0))]);
  assert.equal(usdCalls(m), 1);
  const skipped = [a, b].filter((r) => r.skipped === 'LEASE_HELD_OR_BUDGET');
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0]!.leaseHeld.includes('USD_IQD'));
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1670');
});

test('a database without migration 0179: the scheduler is a no-op', async () => {
  const { dbThrough } = await import('./fixtures/app');
  const raw = dbThrough('0177');
  const m = market();
  const report = await runFxScheduler(fxEnv(raw), { now: at(0), scheduledTime: at(0) }, { trigger: 'cron', fetchImpl: m.f.fetch });
  assert.equal(report.skipped, 'NOT_INSTALLED');
  assert.equal(m.f.calls.length, 0);
});
