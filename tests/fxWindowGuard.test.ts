/**
 * OWNER DECISION 11 (2026-10-09): LARGE MOVES WAIT FOR THE OWNER — more than
 * 3% within 24 hours, or more than 6% from the last rate the owner confirmed,
 * is REVIEW_REQUIRED; the last confirmed / last known good rate stays in use
 * and nothing is repriced until the owner approves; after approval the new
 * rate is the Confirmed Rate and the measurement starts from it.
 *
 *   window       the 24-hour guard measures the candidate against EVERY rate
 *                in force during the last 24 hours, not only the one in force
 *                24 hours ago: the staircase 1,680 → 1,632 → 1,680 → 1,728 is
 *                held at its third step (it applied on FX-1 as reviewed) —
 *                after an approval too
 *   confirmed    approving the held value makes it the Confirmed Rate: the
 *                next ordinary tick measures from it, not from the staircase
 *   adjustment   +20 → +60 is not a market jump: the window's rates are
 *                re-based onto today's adjustment
 *   fail closed  a window longer than one read is held; a window or r24 the
 *                budget did not let the scheduler read applies nothing
 *                (DEFERRED / FX_GUARD_UNREAD, no bell)
 *   drift        exactly 6% from the confirmed rate applies; 6.0001% is held
 *
 * Run: node --import tsx --test tests/fxWindowGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, freshDb } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, fxEnv, logsOf, market, ownerCommit, pairOf } from './fixtures/fx';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { planReview, planSettings } from '../worker/lib/fx/ownerActs';
import { decide, type DecisionContext, type PairOutcome } from '../worker/lib/fx/decide';
import { loadPairs } from '../worker/lib/fx/pairs';
import type { StatementBudget } from '../worker/lib/fx/budget';
import { FX_STRINGS, fxCodeText, fxErrorGroup } from '../src/components/adminPricing/fxStrings';
import { refreshMessage } from '../src/components/adminPricing/fxParts';

const H = 3_600_000;
const T0 = new Date('2026-10-08T00:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * H);
type Market = ReturnType<typeof market>;

/** USD/IQD approved at `rate` at `when` (the Confirmed Rate); the ECB pairs MANUAL, so every tick is USD/IQD alone. */
function world(rate = '1680', when = at(-48), adjustment = '0') {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec(`UPDATE fx_rate_pairs SET market_adjustment_iqd = '${adjustment}' WHERE pair = 'USD_IQD'`);
  applyRate(raw, 'USD_IQD', rate, when.toISOString(), new Date(when.getTime() - 10 * 60_000).toISOString());
  applyRate(raw, 'EUR_USD', '1.1186', at(-48).toISOString(), '2026-10-06T00:00:00.000Z');
  applyRate(raw, 'CNY_USD', '0.1492023689', at(-48).toISOString(), '2026-10-06T00:00:00.000Z');
  raw.exec("UPDATE fx_rate_pairs SET mode = 'MANUAL', manual_rate = effective_rate WHERE pair <> 'USD_IQD'");
  return raw;
}

async function tick(raw: DatabaseSync, m: Market, when: Date, budget?: StatementBudget) {
  m.state.at = when;
  return runFxScheduler(fxEnv(raw), { now: new Date(when.getTime() + 60_000), scheduledTime: when }, { trigger: 'cron', fetchImpl: m.f.fetch, budget });
}
const usd = (raw: DatabaseSync) => pairOf(raw, 'USD_IQD');
const bells = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) n FROM user_notifications WHERE kind = 'fx_attention'");
const approve = (raw: DatabaseSync, now: Date) =>
  ownerCommit(raw, (rows) => planReview(rows[0]!, { owner_version: rows[0]!.owner_version, decision: 'approve' }, { actor: 'usr_owner', now }), now);

/** 1,680 → 1,632 → 1,680 → 1,728, one step every six hours from `start`. */
async function staircase(raw: DatabaseSync, start: number) {
  const m = market();
  const results: string[] = [];
  for (const [i, sell] of [1632, 1680, 1728].entries()) {
    m.state.sell = sell;
    await tick(raw, m, at(start + i * 6));
    results.push(`${usd(raw).last_check_result}${usd(raw).pending_reason ? `/${usd(raw).pending_reason}` : ''}`);
  }
  return { m, results };
}

// ------------------------------------------------------------- the window

test('the staircase 1,680 → 1,632 → 1,680 → 1,728 at six-hour ticks: the third step is held ANOMALY_24H (+5.9% on the 1,632 in force that morning); 1,680 stays in force; pricing_fx_rates is frozen; the owner is told', async () => {
  const raw = world();
  const { results } = await staircase(raw, 0);
  assert.deepEqual(results, ['APPLIED', 'APPLIED', 'REVIEW_HELD/ANOMALY_24H']);
  const row = usd(raw);
  assert.equal(row.effective_rate, '1680', 'the last known good rate stays in force');
  assert.equal(row.last_known_good_rate, '1680');
  assert.equal(row.pending_effective_rate, '1728');
  assert.equal(row.status, 'REVIEW_REQUIRED');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1680', 'no revision to the held rate');
  assert.ok(bells(raw) >= 1);
});

test('the same staircase right after the owner approved 1,680: still held at the third step — an approval starts the window, it does not blind it', async () => {
  const raw = world('1680', at(-1));
  const { results } = await staircase(raw, 0);
  assert.deepEqual(results, ['APPLIED', 'APPLIED', 'REVIEW_HELD/ANOMALY_24H']);
  assert.equal(usd(raw).effective_rate, '1680');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1680');
});

test('approving the held 1,728 makes it the Confirmed Rate: the next ordinary tick measures from it, not from the 1,632 of the morning', async () => {
  const raw = world();
  const { m } = await staircase(raw, 0);
  await approve(raw, at(13));
  let row = usd(raw);
  assert.equal(row.effective_rate, '1728');
  assert.equal(row.drift_anchor_rate, '1728', 'the Confirmed Rate');
  assert.equal(row.drift_anchor_at, at(13).toISOString());
  m.state.sell = 1740;
  await tick(raw, m, at(18));
  row = usd(raw);
  assert.equal(row.last_check_result, 'APPLIED', '1,740 is 0.7% from the Confirmed Rate; the 1,632 before the approval no longer counts');
  assert.equal(row.effective_rate, '1740');
  assert.equal(row.drift_anchor_rate, '1728', 'an automatic apply never moves the Confirmed Rate');
});

test('a rejected staircase keeps the Confirmed Rate, its time and the last known good; the rejected value is not offered again for 24 hours', async () => {
  const raw = world();
  const { m } = await staircase(raw, 0);
  const before = usd(raw);
  await ownerCommit(raw, (rows) => planReview(rows[0]!, { owner_version: rows[0]!.owner_version, decision: 'reject' }, { actor: 'usr_owner', now: at(13) }), at(13));
  const row = usd(raw);
  for (const k of ['effective_rate', 'drift_anchor_rate', 'drift_anchor_at', 'last_known_good_rate', 'last_known_good_at']) assert.deepEqual(row[k], before[k], k);
  assert.equal(row.rejected_rate, '1728');
  const rung = bells(raw);
  await tick(raw, m, at(18));
  assert.equal(usd(raw).last_check_result, 'DEFERRED');
  assert.equal(usd(raw).last_error_code, 'FX_REJECTED_RECENTLY');
  assert.equal(bells(raw), rung);
});

// ------------------------------------------------------------- the adjustment

test('the owner moves the adjustment +20 → +60, then the market stays at 1,680: APPLIED at 1,740 — the window re-bases yesterday onto +60, so it is not a 3.6% jump', async () => {
  const raw = world('1680', at(-48), '20'); // market 1,660 + 20
  await ownerCommit(raw, (rows) => planSettings(rows[0]!, { owner_version: rows[0]!.owner_version, market_adjustment_iqd: '60' }, { actor: 'usr_owner', now: at(-1) })!, at(-1));
  assert.equal(usd(raw).effective_rate, '1720');
  const m = market({ sell: 1680 });
  await tick(raw, m, at(0));
  const row = usd(raw);
  assert.equal(row.last_check_result, 'APPLIED', 'not ANOMALY_24H');
  assert.equal(row.effective_rate, '1740', '1,680 + 60');
  const applied = logsOf(raw, 'USD_IQD').at(-1)!;
  assert.equal(applied.event, 'apply');
  assert.equal(applied.market_adjustment_iqd, '60');
});

test('re-basing is what makes it pass: the same candidate measured against yesterday\'s 1,680 as written (no adjustment known) is held', async () => {
  const raw = world('1720', at(-48), '60');
  const rows = (await loadPairs(asD1(raw)))!;
  const quote: PairOutcome = { kind: 'quote', market: '1680', buy: null, official: null, sourceUsdPerEur: null, sourceCnyPerEur: null, publishedAtMs: at(0).getTime() - 5 * 60_000 };
  const clock = { now: new Date(at(0).getTime() + 60_000), scheduledTime: at(0) };
  const ctx = (adj: string | null): DecisionContext => ({ r24: { USD_IQD: { rate: '1680', adj } }, window: { USD_IQD: [] } });
  const row = { ...rows[0]!, drift_anchor_rate: '1720' };
  assert.equal(decide(row, quote, ctx('20'), clock, 'cron').result, 'APPLIED', '1,680 under +20 reads 1,720 under +60');
  const raw24 = decide(row, quote, ctx(null), clock, 'cron');
  assert.equal(raw24.result, 'REVIEW_HELD');
  assert.equal(raw24.code, 'ANOMALY_24H', 'measured as written, 1,740 vs 1,680 is +3.6%');
});

// ------------------------------------------------------------- fail closed

function seedWindow(raw: DatabaseSync, n: number, rate = '1680') {
  const ins = raw.prepare(
    `INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, created_at, market_adjustment_iqd)
     VALUES (?, 'USD_IQD', 'check', 'refresh', 'iqwealth', ?, ?, 'UNCHANGED', ?, '0')`
  );
  for (let i = 0; i < n; i++) ins.run(`fxl_w${i}`, rate, rate, new Date(at(0).getTime() - (i + 1) * 5 * 60_000).toISOString());
}

test('more rates in a day than one read takes is held, never guessed: 201 window rows → ANOMALY_24H; 200 → an ordinary apply', async () => {
  for (const [rows, expected] of [
    [201, 'REVIEW_HELD'],
    [200, 'APPLIED'],
  ] as const) {
    const raw = world();
    seedWindow(raw, rows);
    await tick(raw, market({ sell: 1690 }), at(0));
    const row = usd(raw);
    assert.equal(row.last_check_result, expected, `${rows} rows`);
    if (expected === 'REVIEW_HELD') {
      assert.equal(row.pending_reason, 'ANOMALY_24H');
      assert.equal(row.effective_rate, '1680');
    }
  }
});

/** A budget that refuses its `refuse`-th charge and allows every other. */
function refusingBudget(refuse: number): StatementBudget {
  let used = 0;
  let calls = 0;
  return {
    limit: 600,
    get used() {
      return used;
    },
    remaining: () => 600 - used,
    canSpend: (n) => used + n <= 600,
    spend(n) {
      calls += 1;
      if (calls === refuse) return false;
      used += n;
      return true;
    },
  };
}

test('a window or r24 the budget did not let the scheduler read applies nothing: DEFERRED / FX_GUARD_UNREAD, one log row, no bell, the rate and pricing_fx_rates unchanged', async () => {
  // The charges of a USD-only cron run: 1 the pairs, 2 the lease, 3 r24, 4 the window, 5 the commit.
  for (const [refuse, what] of [
    [4, 'the window'],
    [3, 'r24'],
  ] as const) {
    const raw = world();
    const before = { derived: derivedOf(raw), logs: logsOf(raw, 'USD_IQD').length, bells: bells(raw) };
    const report = await tick(raw, market({ sell: 1690 }), at(0), refusingBudget(refuse));
    assert.deepEqual(report.checked, [{ pair: 'USD_IQD', result: 'DEFERRED', code: 'FX_GUARD_UNREAD' }], what);
    const row = usd(raw);
    assert.equal(row.last_check_result, 'DEFERRED', what);
    assert.equal(row.last_error_code, 'FX_GUARD_UNREAD');
    assert.equal(row.effective_rate, '1680', `${what}: no automatic apply`);
    assert.equal(row.pending_effective_rate, null, `${what}: nothing held, nothing rung`);
    assert.equal(row.lease_token, null, 'the lease is released');
    assert.deepEqual(derivedOf(raw), before.derived);
    const added = logsOf(raw, 'USD_IQD').slice(before.logs);
    assert.deepEqual(added.map((l) => [l.event, l.result, l.error_code]), [['deferred', 'DEFERRED', 'FX_GUARD_UNREAD']], what);
    assert.equal(bells(raw), before.bells);
  }
});

test('decide() fails closed on its own: an absent or unread window, or an absent r24 outside a confirmation, never applies', async () => {
  const raw = world();
  const row = (await loadPairs(asD1(raw)))!.find((r) => r.pair === 'USD_IQD')!;
  const quote: PairOutcome = { kind: 'quote', market: '1690', buy: null, official: null, sourceUsdPerEur: null, sourceCnyPerEur: null, publishedAtMs: at(0).getTime() - 5 * 60_000 };
  const clock = { now: new Date(at(0).getTime() + 60_000), scheduledTime: at(0) };
  const r24 = { USD_IQD: { rate: '1680', adj: '0' } };
  const cases: Array<[DecisionContext, string]> = [
    [{ r24, window: {} }, 'DEFERRED'],
    [{ r24, window: { USD_IQD: 'unread' } }, 'DEFERRED'],
    [{ r24: {}, window: { USD_IQD: [] } }, 'DEFERRED'],
    [{ r24, window: { USD_IQD: 'overflow' } }, 'REVIEW_HELD'],
    [{ r24, window: { USD_IQD: [] } }, 'APPLIED'],
    [{ r24: { USD_IQD: null }, window: { USD_IQD: [] } }, 'APPLIED'],
  ];
  for (const [ctx, expected] of cases) {
    const d = decide(row, quote, ctx, clock, 'cron');
    assert.equal(d.result, expected, JSON.stringify(ctx));
    if (expected === 'DEFERRED') {
      assert.equal(d.code, 'FX_GUARD_UNREAD');
      assert.equal(d.effectiveChanged, false);
      assert.equal(d.attention, null, 'no bell');
    }
  }
  // Confirmed inside the window: r24 is not needed (the Confirmed Rate replaces it); the window still is.
  const confirmed = { ...row, drift_anchor_at: at(-2).toISOString() };
  assert.equal(decide(confirmed, quote, { r24: {}, window: { USD_IQD: [] } }, clock, 'cron').result, 'APPLIED');
  assert.equal(decide(confirmed, quote, { r24: {}, window: {} }, clock, 'cron').result, 'DEFERRED');
});

// ------------------------------------------------------------- the 6% drift

test('drift from the Confirmed Rate: three +2% days to exactly 6% apply; 6.0001% is held DRIFT', async () => {
  for (const [last, expected] of [
    [2120, 'APPLIED'], // exactly 6% of 2,000
    [2120.002, 'REVIEW_HELD'], // 6.0001%
  ] as const) {
    const raw = world('2000', at(-100));
    const m = market();
    const results: string[] = [];
    for (const [i, sell] of [2040, 2080, last].entries()) {
      m.state.sell = sell;
      await tick(raw, m, at(i * 25));
      results.push(String(usd(raw).last_check_result));
    }
    assert.deepEqual(results, ['APPLIED', 'APPLIED', expected], String(last));
    if (expected === 'REVIEW_HELD') {
      assert.equal(usd(raw).pending_reason, 'DRIFT');
      assert.equal(usd(raw).effective_rate, '2080');
    } else {
      assert.equal(usd(raw).effective_rate, '2120');
    }
    assert.equal(usd(raw).drift_anchor_rate, '2000', 'automatic applies never move the Confirmed Rate');
  }
});

test('the owner panel says FX_GUARD_UNREAD in words — ar, en, ckb — and a refresh that met it is a warning, never «unchanged»', () => {
  assert.equal(fxErrorGroup('FX_GUARD_UNREAD'), 'unverified');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = FX_STRINGS[lang];
    assert.equal(fxCodeText(s, 'FX_GUARD_UNREAD'), s.errorText.unverified, lang);
    const msg = refreshMessage({ checked: [{ pair: 'USD_IQD', result: 'DEFERRED', code: 'FX_GUARD_UNREAD' }], lease_held: [], budget_deferred: [] }, s);
    assert.equal(msg.tone, 'warning', lang);
    assert.equal(msg.text, s.refreshOutcome.unverified, lang);
    assert.notEqual(msg.text, s.refreshOutcome.unchanged, lang);
  }
  assert.notEqual(FX_STRINGS.ckb.errorText.unverified, FX_STRINGS.ar.errorText.unverified);
  assert.notEqual(FX_STRINGS.ckb.refreshOutcome.unverified, FX_STRINGS.ar.refreshOutcome.unverified);
});
