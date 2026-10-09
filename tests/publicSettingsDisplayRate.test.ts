/**
 * THE ONE PUBLIC FX FIGURE (FX programme plan §8 "Public", §13, §14.4 risk 1).
 *
 * `/api/settings/public` and the settings block of `/api/home` carry
 * `displayUsdRate` — the effective USD/IQD as decimal text, the shop's rate the
 * top bar divides by — and NOTHING else of the exchange rates: no market
 * figure, adjustment, provider, pending or held value, threshold, history or
 * derived EUR/CNY rate. Null until the owner approves the first value, and
 * null on a database without migration 0179 (the client then keeps the wallet
 * `exchangeRate`). The anonymous cache policy is unchanged.
 *
 * Run: node --import tsx --test tests/publicSettingsDisplayRate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, freshDb, get, json, stubApp } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { miscRoutes } from '../worker/routes/misc';
import { homeRoutes } from '../worker/routes/products';
import { ANONYMOUS_CACHE_CONTROL } from '../worker/lib/edgePolicy';

const FORBIDDEN_KEY = /market|adjust|provider|pending|last_known|anomaly|iqwealth|fx_|rate_iqd|eur|cny/i;

function app(raw: DatabaseSync) {
  return stubApp(asD1(raw), null, (a) => {
    a.route('/api/home', homeRoutes);
    a.route('/api', miscRoutes);
  });
}

function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
}

async function settingsOf(raw: DatabaseSync) {
  const a = app(raw);
  const pub = await get(a, '/api/settings/public');
  const home = await get(a, '/api/home');
  return { pub, home, pubBody: await json(pub), homeBody: await json(home) };
}

test('displayUsdRate equals the effective USD/IQD, on both answers — and no other FX key is public', async () => {
  const raw = freshDb();
  applyRate(raw, 'USD_IQD', '1703.9167');
  applyRate(raw, 'EUR_USD', '1.1186');
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '37.2501', market_rate = '1666.6666', pending_market_rate = '1777.7777', pending_effective_rate = '1815.0278', pending_reason = 'ANOMALY', pending_observed_at = '2026-10-08T00:00:00.000Z', status = 'REVIEW_REQUIRED' WHERE pair = 'USD_IQD'");
  const { pubBody, homeBody } = await settingsOf(raw);
  assert.equal(pubBody.settings.displayUsdRate, '1703.9167');
  assert.equal(homeBody.settings.displayUsdRate, '1703.9167');
  for (const body of [pubBody, homeBody]) {
    const bad = keysOf(body.settings).filter((k) => FORBIDDEN_KEY.test(k));
    assert.deepEqual(bad, []);
    const text = JSON.stringify(body);
    for (const sentinel of ['1666.6666', '37.2501', '1777.7777', '1815.0278', '1906.']) assert.equal(text.includes(sentinel), false, sentinel);
  }
});

test('null until the owner approves a first value; null on a database without 0179', async () => {
  let { pubBody, homeBody } = await settingsOf(freshDb());
  assert.equal(pubBody.settings.displayUsdRate, null);
  assert.equal(homeBody.settings.displayUsdRate, null);
  ({ pubBody, homeBody } = await settingsOf(dbThrough('0177')));
  assert.equal(pubBody.success, true);
  assert.equal(pubBody.settings.displayUsdRate, null);
  assert.equal(homeBody.settings.displayUsdRate, null);
  assert.ok('exchangeRate' in pubBody.settings, 'the wallet rate the client falls back to is still there');
});

test('the anonymous cache headers are unchanged', async () => {
  const raw = freshDb();
  applyRate(raw, 'USD_IQD', '1660');
  const { pub, home } = await settingsOf(raw);
  assert.equal(pub.headers.get('cache-control'), ANONYMOUS_CACHE_CONTROL);
  assert.equal(home.headers.get('cache-control'), ANONYMOUS_CACHE_CONTROL);
});
