/**
 * THE COMMIT: DERIVED RATES IN STEP WITH THE PAIRS (FX programme plan §5.3,
 * §9 §7–§10; critiques F2, M1; the owner's §35 tests 7–9 for FX-1).
 *
 * pricing_fx_rates holds the three effective IQD rates the engine reads:
 * USD = U, EUR = E×U, CNY = C×U — written ONLY in the batch that changed a
 * pair, ONLY for the rows whose value changed, and refused by the database
 * when stamped with anything but the current effective pairs. A USD change
 * uses the last trusted E and C even when those pairs are failing; two runs
 * or an owner write racing a fetch never leave a mixed cross rate.
 *
 * Run: node --import tsx --test tests/fxCommit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, fxEnv, logsOf, market, ownerCommit, pairOf } from './fixtures/fx';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { planManualSet } from '../worker/lib/fx/ownerActs';
import { planFxCommit } from '../worker/lib/fx/commit';
import { decide } from '../worker/lib/fx/decide';
import { loadPairs } from '../worker/lib/fx/pairs';
import { composeIqdRates } from '../packages/pricing/src/fxChain';
import { asD1 } from './fixtures/app';

const H = 3_600_000;
const T0 = new Date('2026-10-10T00:00:00.000Z');
const at = (h: number) => new Date(T0.getTime() + h * H);

/** All three pairs approved two days ago: U 1660, E 1.1186, C 0.1492023689. */
function allApproved(): DatabaseSync {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const when = at(-48).toISOString();
  const pub = at(-49).toISOString();
  applyRate(raw, 'USD_IQD', '1660', when, pub);
  raw.exec(`UPDATE fx_rate_pairs SET published_at = '2026-10-07T00:00:00.000Z' WHERE pair <> 'USD_IQD'`);
  applyRate(raw, 'EUR_USD', '1.1186', when);
  applyRate(raw, 'CNY_USD', '0.1492023689', when);
  // The ECB pairs' last market figures (their publication of 2026-10-07).
  raw.exec("UPDATE fx_rate_pairs SET market_rate = effective_rate WHERE pair <> 'USD_IQD'");
  return raw;
}

async function cronAt(raw: DatabaseSync, m: ReturnType<typeof market>, when: Date) {
  m.state.at = when;
  return runFxScheduler(fxEnv(raw), { now: new Date(when.getTime() + 60_000), scheduledTime: when }, { trigger: 'cron', fetchImpl: m.f.fetch });
}

function assertInStep(raw: DatabaseSync) {
  const u = pairOf(raw, 'USD_IQD');
  const e = pairOf(raw, 'EUR_USD');
  const c = pairOf(raw, 'CNY_USD');
  const want = composeIqdRates(u.effective_rate as string, e.effective_rate as string, c.effective_rate as string);
  const d = derivedOf(raw) as Record<string, Record<string, unknown>>;
  assert.equal(d.USD!.rate_iqd, want.USD);
  assert.equal(d.EUR!.rate_iqd, want.EUR);
  assert.equal(d.CNY!.rate_iqd, want.CNY);
  assert.equal(d.EUR!.usd_version, u.effective_version);
  assert.equal(d.EUR!.cross_version, e.effective_version);
  assert.equal(d.CNY!.cross_version, c.effective_version);
}

test('pricing_fx_rates EUR = E×U and CNY = C×U exactly after every apply', async () => {
  const raw = allApproved();
  assertInStep(raw);
  const m = market({ sell: 1670, usd: '1.1250', cny: '7.5000' });
  m.state.ecbDay = '2026-10-10';
  await cronAt(raw, m, at(0));
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1670');
  assert.equal(pairOf(raw, 'EUR_USD').effective_rate, '1.125');
  assert.equal(pairOf(raw, 'CNY_USD').effective_rate, '0.15');
  assertInStep(raw);
  assert.equal(derivedOf(raw).EUR!.rate_iqd, '1878.75');
  assert.equal(derivedOf(raw).CNY!.rate_iqd, '250.5');
});

test('USD change recomputes USD/EUR/CNY rows with the last trusted E and C — even while EUR_USD is FAILED (§35 9, §8)', async () => {
  const raw = allApproved();
  const m = market({ sell: 1670 });
  m.state.ecbDown = true;
  await cronAt(raw, m, at(0));
  assert.equal(pairOf(raw, 'EUR_USD').fetch_status, 'FAILED');
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1670');
  const d = derivedOf(raw);
  assert.equal(d.USD!.rate_iqd, '1670');
  assert.equal(d.EUR!.rate_iqd, '1868.062', '1.1186 (the last trusted E) × 1670');
  assert.equal(d.CNY!.rate_iqd, '249.167956063', '0.1492023689 × 1670');
  assertInStep(raw);
});

test('EUR-only change writes only the EUR row (§35 7): USD and CNY rows keep their value and version', async () => {
  const raw = allApproved();
  const before = derivedOf(raw);
  const m = market({ usd: '1.1300', cny: '7.4972' });
  m.state.usdDown = true; // USD/IQD fails this tick; its rate stays
  m.state.ecbDay = '2026-10-10';
  // C = ceil10(1.13 / 7.4972) moves too unless CNY per EUR moves with it; keep C put:
  m.state.cny = String((1.13 / 0.1492023689).toFixed(4));
  await cronAt(raw, m, at(0));
  const after = derivedOf(raw);
  assert.equal(pairOf(raw, 'EUR_USD').effective_rate, '1.13');
  assert.notEqual(after.EUR!.rate_iqd, before.EUR!.rate_iqd);
  assert.equal(after.EUR!.version, before.EUR!.version + 1);
  assert.deepEqual(after.USD, before.USD);
  assert.equal(pairOf(raw, 'CNY_USD').last_check_result, 'UNCHANGED', 'C moved less than the dead band');
  assert.deepEqual(after.CNY, before.CNY);
  assertInStep(raw);
});

test('CNY-only change writes only the CNY row (§35 8)', async () => {
  const raw = allApproved();
  const before = derivedOf(raw);
  const m = market({ usd: '1.1186', cny: '7.4000' });
  m.state.usdDown = true;
  m.state.ecbDay = '2026-10-10';
  await cronAt(raw, m, at(0));
  assert.equal(pairOf(raw, 'EUR_USD').last_check_result, 'UNCHANGED');
  assert.equal(pairOf(raw, 'CNY_USD').last_check_result, 'APPLIED');
  const after = derivedOf(raw);
  assert.deepEqual(after.USD, before.USD);
  assert.deepEqual(after.EUR, before.EUR);
  assert.equal(after.CNY!.version, before.CNY!.version + 1);
  assertInStep(raw);
});

test('an unchanged effective rate writes no derived row and no history row beyond the check (§31)', async () => {
  const raw = allApproved();
  const before = derivedOf(raw);
  const m = market({ sell: 1660 });
  await cronAt(raw, m, at(0));
  assert.deepEqual(derivedOf(raw), before);
  const events = logsOf(raw).filter((l) => String(l.created_at) > at(0).toISOString()).map((l) => l.event);
  assert.ok(events.every((e) => e === 'check'), events.join(','));
});

test('owner EUR manual set during a USD fetch: the cron misses the all-pair fence, re-plans with the same quote, EUR row = E_new × U_new (F2, M1)', async () => {
  const raw = allApproved();
  const m = market({ sell: 1670 });
  let raced = false;
  const inner = m.f.fetch;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!raced) {
      raced = true;
      // The owner sets EUR/USD by hand while IQWealth is being asked.
      await ownerCommit(raw, (rows) => planManualSet(rows[1]!, { owner_version: rows[1]!.owner_version, rate: '1.15' }, { actor: 'usr_owner', now: at(0) }), at(0));
    }
    return inner(input, init);
  }) as typeof fetch;
  m.state.at = at(0);
  const report = await runFxScheduler(fxEnv(raw), { now: new Date(at(0).getTime() + 60_000) }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl });
  assert.equal(report.checked.find((c) => c.pair === 'USD_IQD')!.result, 'APPLIED', 're-planned and committed');
  assert.equal(m.f.calls.length, 1, 'no second request');
  assert.equal(pairOf(raw, 'EUR_USD').effective_rate, '1.15');
  assert.equal(derivedOf(raw).EUR!.rate_iqd, '1920.5', '1.15 × 1670');
  assertInStep(raw);
});

test('an owner write on the pair being fetched wins: the fetch is SUPERSEDED (a log row only)', async () => {
  const raw = allApproved();
  const m = market({ sell: 1670 });
  let raced = false;
  const inner = m.f.fetch;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!raced) {
      raced = true;
      await ownerCommit(raw, (rows) => planManualSet(rows[0]!, { owner_version: rows[0]!.owner_version, rate: '1650' }, { actor: 'usr_owner', now: at(0) }), at(0));
    }
    return inner(input, init);
  }) as typeof fetch;
  const report = await runFxScheduler(fxEnv(raw), { now: at(0) }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl });
  assert.equal(report.checked[0]!.result, 'SUPERSEDED');
  const row = pairOf(raw, 'USD_IQD');
  assert.equal(row.mode, 'MANUAL');
  assert.equal(row.effective_rate, '1650');
  assert.equal(logsOf(raw, 'USD_IQD').at(-1)!.event, 'superseded');
  assertInStep(raw);
});

test('two runs on different pairs never leave a mixed cross rate (F2, M1)', async () => {
  const raw = allApproved();
  const usd = market({ sell: 1670 });
  const ecb = market({ usd: '1.1300', cny: '7.5000' });
  ecb.state.ecbDay = '2026-10-10';
  usd.state.at = at(0);
  ecb.state.at = at(0);
  await Promise.all([
    runFxScheduler(fxEnv(raw), { now: at(0) }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: usd.f.fetch }),
    runFxScheduler(fxEnv(raw), { now: at(0) }, { trigger: 'refresh', pairs: ['EUR_USD', 'CNY_USD'], fetchImpl: ecb.f.fetch }),
  ]);
  assert.equal(pairOf(raw, 'USD_IQD').effective_rate, '1670');
  assert.equal(pairOf(raw, 'EUR_USD').effective_rate, '1.13');
  assertInStep(raw);
});

test('planFxCommit is pure and ordered: fences first (claimed pairs, then all three effective versions), then the pair, its log, the derived rows', async () => {
  const raw = allApproved();
  const rows = (await loadPairs(asD1(raw)))!;
  const usd = { ...rows[0]!, lease_token: 'tok', version: rows[0]!.version };
  const d = decide(usd, { kind: 'quote', market: '1670', buy: null, official: null, sourceUsdPerEur: null, sourceCnyPerEur: null, publishedAtMs: at(-1).getTime() }, { r24: { USD_IQD: null } }, { now: at(0) }, 'refresh');
  let n = 0;
  const plan = planFxCommit([d], [usd], rows, { fence: 'lease', token: 'tok', actor: null, nowIso: at(0).toISOString(), newLogId: () => `id${++n}`, trigger: 'refresh' });
  const kinds = plan.statements.map((s) => (s.kind === 'fence' ? `fence:${/effective_version/.test(s.condition) ? 'all' : 'pair'}` : s.sql.trim().split(/\s+/).slice(0, 3).join(' ')));
  assert.deepEqual(kinds, ['fence:pair', 'fence:all', 'UPDATE fx_rate_pairs SET', 'INSERT INTO fx_rate_log', 'UPDATE pricing_fx_rates SET', 'UPDATE pricing_fx_rates SET', 'UPDATE pricing_fx_rates SET']);
  assert.equal(plan.displayRateChanged, true);
  assert.deepEqual(plan.audits, [{ action: 'fx.refresh', target: 'USD_IQD', detail: { pair: 'USD_IQD', result: 'APPLIED', code: null, trigger: 'refresh' } }]);
  assert.doesNotMatch(JSON.stringify(plan.audits), /1670|1660/, 'the audit rows carry no rate');
  const again = planFxCommit([d], [usd], rows, { fence: 'lease', token: 'tok', actor: null, nowIso: at(0).toISOString(), newLogId: () => 'x', trigger: 'refresh' });
  assert.equal(again.statements.length, plan.statements.length);
});
