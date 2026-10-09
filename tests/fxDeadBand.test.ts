/**
 * OWNER DECISION 10 (2026-10-09): IGNORE SMALL MOVES — USD 0.5%, EUR 0.3%,
 * CNY 0.3% — EDITABLE BY THE OWNER, AND THE HISTORY SHOWS OLD → NEW.
 *
 *   below        a USD move of 0.4% and an EUR move of 0.25% are UNCHANGED:
 *                one `check` row and one `fx.check` audit each, the
 *                pricing_fx_rates version unchanged, no cache purge, products
 *                and price_history byte for byte the same (the FX-5 lock:
 *                repricing must never start below the band)
 *   edge         exactly 0.5% is a move (not UNCHANGED); 0.4999% is not
 *   editable     PUT settings {min_change_pct: '0.8'} by the owner keeps
 *                [{field, before, after}] on its history row and the history
 *                answers it; «5.001» and «-0.1» → 400 and nothing is written
 *   screen       the history says each change in words, in ar, en and ckb
 *
 * Run: node --import tsx --test tests/fxDeadBand.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, count, freshDb, get, json, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, fxEnv, logsOf, market, pairOf } from './fixtures/fx';
import { codeOf } from './fixtures/source';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { FX_STRINGS } from '../src/components/adminPricing/fxStrings';
import { settingsDiffLine } from '../src/components/adminPricing/FxHistorySheet';

const BASE = '/api/admin/pricing';
const H = 3_600_000;
const T0 = new Date('2026-10-08T06:00:00.000Z');

/** USD/IQD, EUR/USD and CNY/USD approved two days ago; the pairs a scenario does not test are MANUAL (never due). */
function world(auto: 'USD_IQD' | 'EUR_USD', usd = '1660') {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const at = new Date(T0.getTime() - 48 * H).toISOString();
  applyRate(raw, 'USD_IQD', usd, at, new Date(T0.getTime() - 49 * H).toISOString());
  applyRate(raw, 'EUR_USD', '1.1186', at, '2026-10-06T00:00:00.000Z');
  applyRate(raw, 'CNY_USD', '0.1492023689', at, '2026-10-06T00:00:00.000Z');
  for (const p of ['USD_IQD', 'EUR_USD', 'CNY_USD']) {
    if (p !== auto) raw.exec(`UPDATE fx_rate_pairs SET mode = 'MANUAL', manual_rate = effective_rate WHERE pair = '${p}'`);
  }
  return raw;
}

/** A cache spy standing in for `caches.default`: every purge is a delete. */
function cacheSpy() {
  const deleted: string[] = [];
  const scope = globalThis as { caches?: unknown };
  const before = scope.caches;
  scope.caches = { default: { match: async () => undefined, put: async () => undefined, delete: async (r: Request) => (deleted.push(r.url), true) } };
  return { deleted, restore: () => (scope.caches = before) };
}

const snapshot = (raw: DatabaseSync) => JSON.stringify({ products: all(raw, 'SELECT * FROM products ORDER BY id'), history: all(raw, 'SELECT * FROM price_history ORDER BY rowid') });

async function tick(raw: DatabaseSync, m: ReturnType<typeof market>) {
  m.state.at = T0;
  return runFxScheduler(fxEnv(raw, { STORE_ROOT_DOMAIN: 'levonis-iq.com' } as never), { now: new Date(T0.getTime() + 60_000), scheduledTime: T0 }, { trigger: 'cron', fetchImpl: m.f.fetch });
}

test('below the band: 0.4% on USD/IQD and 0.25% on EUR/USD → UNCHANGED — one check row and one fx.check audit, no revision, no final_price write, no purge', async () => {
  for (const [pair, move] of [
    ['USD_IQD', (m: ReturnType<typeof market>) => (m.state.sell = 1666.64)], // +0.4% of 1,660
    ['EUR_USD', (m: ReturnType<typeof market>) => (m.state.usd = '1.121397')], // +0.25% of 1.1186
  ] as const) {
    const raw = world(pair);
    const m = market();
    m.state.ecbDay = '2026-10-07';
    move(m);
    const before = { derived: derivedOf(raw), logs: count(raw, 'SELECT COUNT(*) n FROM fx_rate_log'), data: snapshot(raw), effective: pairOf(raw, pair).effective_rate };
    const spy = cacheSpy();
    let report;
    try {
      report = await tick(raw, m);
    } finally {
      spy.restore();
    }
    assert.deepEqual(report.checked, [{ pair, result: 'UNCHANGED', code: null }], pair);
    assert.equal(pairOf(raw, pair).last_check_result, 'UNCHANGED');
    assert.equal(pairOf(raw, pair).effective_rate, before.effective, `${pair}: the rate in force is untouched`);
    const rows = logsOf(raw).slice(before.logs);
    assert.deepEqual(rows.map((r) => [r.pair, r.event, r.result]), [[pair, 'check', 'UNCHANGED']], `${pair}: exactly one check row`);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'fx.%'"), 1);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action = 'fx.check'"), 1, `${pair}: one fx.check audit`);
    assert.deepEqual(derivedOf(raw), before.derived, `${pair}: pricing_fx_rates and its version unchanged`);
    assert.equal(report.displayRateChanged, false);
    assert.deepEqual(spy.deleted, [], `${pair}: no cache purge`);
    assert.equal(snapshot(raw), before.data, `${pair}: products and price_history byte for byte`);
  }
});

test('the edge of the band: exactly 0.5% is a move (APPLIED); 0.4999% is UNCHANGED', async () => {
  for (const [sell, expected] of [
    [2010, 'APPLIED'], // exactly +0.5% of 2,000
    [2009.998, 'UNCHANGED'], // +0.4999%
  ] as const) {
    const raw = world('USD_IQD', '2000');
    const m = market({ sell });
    const spy = cacheSpy();
    let report;
    try {
      report = await tick(raw, m);
    } finally {
      spy.restore();
    }
    assert.equal(report.checked[0]!.result, expected, String(sell));
    assert.equal(pairOf(raw, 'USD_IQD').effective_rate, expected === 'APPLIED' ? String(sell) : '2000');
    // The spy is not vacuous: a real move purges the public settings' cached copies.
    assert.equal(spy.deleted.some((u) => u.endsWith('/api/settings/public')), expected === 'APPLIED', `${sell}: purge`);
  }
});

// ------------------------------------------------------------- editable, with old → new

function owner(raw: DatabaseSync) {
  return stubApp(asD1(raw), OWNER, (a) => a.route(BASE, adminPricingRoutes));
}

test("the owner edits the band: PUT {min_change_pct: '0.8'} → the settings_change row keeps [{field, before, after}] and the history answers it; the seeds are 0.5 / 0.3 / 0.3", async () => {
  const raw = world('USD_IQD');
  const seeds = all<{ pair: string; min_change_pct: string }>(raw, 'SELECT pair, min_change_pct FROM fx_rate_pairs ORDER BY pair');
  assert.deepEqual(seeds.map((r) => [r.pair, r.min_change_pct]), [['CNY_USD', '0.3'], ['EUR_USD', '0.3'], ['USD_IQD', '0.5']]);
  const app = owner(raw);
  const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), min_change_pct: '0.8' });
  assert.equal(res.status, 200);
  assert.equal(pairOf(raw, 'USD_IQD').min_change_pct, '0.8');
  const row = logsOf(raw, 'USD_IQD').at(-1)!;
  assert.equal(row.event, 'settings_change');
  assert.deepEqual(JSON.parse(String(row.settings_diff)), [{ field: 'min_change_pct', before: '0.5', after: '0.8' }]);
  const audit = all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'fx.settings.update'");
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0]!.detail, /0\.8|0\.5/, 'the values live in the private log, never in audit_log');
  const history = await json(await get(app, `${BASE}/rates/history?pair=USD_IQD`));
  const item = history.items.find((i: { event: string }) => i.event === 'settings_change');
  assert.deepEqual(item.settings_diff, [{ field: 'min_change_pct', before: '0.5', after: '0.8' }]);

  // Several fields in one act, the mode among them: one row, every field, in a fixed order.
  const two = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), anomaly_threshold_pct: '4', market_adjustment_iqd: '15', mode: 'MANUAL' });
  assert.equal(two.status, 200);
  const settings = logsOf(raw, 'USD_IQD').filter((l) => l.event === 'settings_change').at(-1)!;
  assert.deepEqual(JSON.parse(String(settings.settings_diff)), [
    { field: 'mode', before: 'AUTO', after: 'MANUAL' },
    { field: 'market_adjustment_iqd', before: '0', after: '15' },
    { field: 'anomaly_threshold_pct', before: '3', after: '4' },
  ]);
  const mode = logsOf(raw, 'USD_IQD').at(-1)!;
  assert.equal(mode.event, 'mode_change');
  assert.equal(mode.settings_diff, null, 'beside a settings_change row the mode is in that row');
  // A mode-only act carries its own old → new.
  raw.exec("UPDATE fx_rate_pairs SET mode = 'AUTO', manual_rate = NULL WHERE pair = 'EUR_USD'");
  await put(app, `${BASE}/rates/fx/EUR_USD/settings`, { owner_version: Number(pairOf(raw, 'EUR_USD').owner_version), mode: 'MANUAL' });
  const eur = logsOf(raw, 'EUR_USD').at(-1)!;
  assert.equal(eur.event, 'mode_change');
  assert.deepEqual(JSON.parse(String(eur.settings_diff)), [{ field: 'mode', before: 'AUTO', after: 'MANUAL' }]);
  assert.equal(eur.market_adjustment_iqd, null);
});

test("the band's own limits: «5.001» and «-0.1» → 400 PRICING_INPUT_INVALID; nothing is written", async () => {
  const raw = world('USD_IQD');
  const app = owner(raw);
  const logs = count(raw, 'SELECT COUNT(*) n FROM fx_rate_log');
  for (const bad of ['5.001', '-0.1', '0.5%%', '1e-1']) {
    const res = await put(app, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), min_change_pct: bad });
    assert.equal(res.status, 400, bad);
    const b = await json(res);
    assert.equal(b.code, 'PRICING_INPUT_INVALID');
    assert.deepEqual(b.details, { field: 'min_change_pct' });
  }
  assert.equal(pairOf(raw, 'USD_IQD').min_change_pct, '0.5');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM fx_rate_log'), logs);
});

test('the history says each change in words, in ar, en and ckb: the setting by its own label, old → new in Latin digits, the mode and the interval in words', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = FX_STRINGS[lang];
    assert.deepEqual(settingsDiffLine(s, { field: 'min_change_pct', before: '0.5', after: '0.8' }), { label: s.minChange, before: '0.5', after: '0.8' });
    assert.deepEqual(settingsDiffLine(s, { field: 'market_adjustment_iqd', before: '20', after: '-1250.5' }), { label: s.adjustment, before: '20', after: '−1,250.5' });
    assert.deepEqual(settingsDiffLine(s, { field: 'mode', before: 'AUTO', after: 'MANUAL' }), { label: s.fieldMode, before: s.modeAuto, after: s.modeManual });
    assert.deepEqual(settingsDiffLine(s, { field: 'interval_hours', before: '6', after: '12' }), { label: s.fieldInterval, before: s.int6Short('6'), after: s.int12Short('12') });
    assert.deepEqual(settingsDiffLine(s, { field: 'bound_max', before: '3000', after: '3500' }), { label: s.boundMax, before: '3,000', after: '3,500' });
    assert.equal(settingsDiffLine(s, { field: 'later_field', before: 'a', after: 'b' }).label, 'later_field', 'an unknown setting by its name, never dropped');
  }
  assert.notEqual(FX_STRINGS.ckb.fieldMode, FX_STRINGS.ar.fieldMode);
  assert.notEqual(FX_STRINGS.ckb.fieldInterval, FX_STRINGS.ar.fieldInterval);
  const sheet = codeOf('src/components/adminPricing/FxHistorySheet.tsx');
  assert.match(sheet, /it\.settings_diff\.map\(/, 'the sheet renders every entry');
  assert.match(sheet, /settingsDiffLine\(s, d\)/);
  assert.match(sheet, /s\.events\b|fxEventLabel\(s, it\.event\)/, '«تغيّرت الإعدادات» stays the heading');
});
