/**
 * THE DOLLAR READING ON A RATE THE OWNER TYPES (owner, 2026-10-17; DECISIONS
 * row 246, amending row 220 for this one figure). AMENDED by DECISIONS row 252
 * (owner 2026-10-18): the reading is now always the rate in force — the one
 * official rate — so a typed rate is published beside a market figure too.
 *
 * Live: USD/IQD on MANUAL («إيقاف»), the provider never configured (no market
 * reading, no rate ever built from one), the owner typing the shop's rate in
 * «التسعير والشحن» — and `displayUsdRate` was null, so a customer who chose
 * USD read every price in dinars, silently. The owner's rule: with no market
 * figure, the dollar prices a customer reads are converted at THE RATE HE
 * TYPES — published as the shop's own (`displayUsdRateAttributed: false`,
 * never credited to IQWealth). With a market figure, nothing changes: the
 * public reading is the market sell the shop's rate was last built from.
 * Either way the adjustment, the manual/market split and every other FX field
 * stay private, and the rate he types reaches every cached copy at once.
 *
 * LOCAL ONLY: in-memory SQLite, the real admin pricing, misc and home routers,
 * the stub owner session of tests/fixtures/app.ts, a spy for `caches.default`.
 * Run: node --import tsx --test tests/fxManualDisplayRate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, get, json, put, stubApp } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, derivedOf, pairOf } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { miscRoutes } from '../worker/routes/misc';
import { homeRoutes } from '../worker/routes/products';
import { withCacheEpoch } from '../worker/lib/publicApi/cache';
import { getPublicDisplayRate } from '../worker/lib/fx/displayRate';
import { planPairBatch } from '../worker/lib/fx/commit';
import { loadPairs } from '../worker/lib/fx/pairs';

const BASE = '/api/admin/pricing';

/** A cache spy standing in for `caches.default`: every purge is a delete. */
function cacheSpy() {
  const deleted: string[] = [];
  const scope = globalThis as { caches?: unknown };
  const before = scope.caches;
  scope.caches = { default: { match: async () => undefined, put: async () => undefined, delete: async (r: Request) => (deleted.push(r.url), true) } };
  return { deleted, restore: () => (scope.caches = before) };
}

/**
 * The live shape before the owner's first act: the provider never configured, no market reading,
 * no rate. His typed rate (the «سعر يدوي» act) puts the pair on MANUAL — a MANUAL pair always
 * carries the rate it was typed at (the table's CHECK).
 */
function manualWorld(): DatabaseSync {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  const usd = pairOf(raw, 'USD_IQD');
  assert.deepEqual([usd.fetch_status, usd.market_rate, usd.effective_rate], ['NOT_CONFIGURED', null, null]);
  return raw;
}

function apps(raw: DatabaseSync) {
  const owner = stubApp(asD1(raw), OWNER, (a) => {
    a.route(BASE, adminPricingRoutes);
  });
  const visitor = stubApp(asD1(raw), null, (a) => {
    a.route('/api/home', homeRoutes);
    a.route('/api', miscRoutes);
  });
  /** Both public answers that carry the figure: the settings and the home page. */
  const publicSettings = async () => [
    (await json(await get(visitor, '/api/settings/public'))).settings,
    (await json(await get(visitor, '/api/home'))).settings,
  ];
  const typeRate = async (rate: string) => {
    const spy = cacheSpy();
    try {
      const res = await put(owner, `${BASE}/rates/fx/USD_IQD/manual`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), rate });
      assert.equal(res.status, 200, await res.clone().text());
    } finally {
      spy.restore();
    }
    return spy.deleted;
  };
  return { owner, visitor, publicSettings, typeRate };
}

const purged = (deleted: readonly string[], path: string) => deleted.some((u) => u.endsWith(withCacheEpoch(path)));

test('MANUAL with no market figure: the dollar reading is the rate the owner types, the shop’s own (attributed false), on both answers', async () => {
  const raw = manualWorld();
  const { publicSettings, typeRate } = apps(raw);
  // Nothing typed yet: no rate, nothing to read dollars at.
  for (const s of await publicSettings()) {
    assert.equal(s.displayUsdRate, null);
    assert.equal(s.displayUsdRateAttributed, null);
  }

  await typeRate('1660');
  assert.equal(pairOf(raw, 'USD_IQD').mode, 'MANUAL');
  assert.equal(pairOf(raw, 'USD_IQD').market_rate, null, 'control: still no market figure');
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1660', 'control: every dinar price is applied at 1,660');
  for (const s of await publicSettings()) {
    assert.equal(s.displayUsdRate, '1660', 'the customer reads dollars at the rate the owner typed');
    assert.equal(s.displayUsdRateAttributed, false, 'the shop’s own rate — never credited to IQWealth');
  }

  // He types a new one: the reading follows it.
  await typeRate('1675.5');
  for (const s of await publicSettings()) assert.equal(s.displayUsdRate, '1675.5');
});

test('MANUAL with no market figure: the adjustment and every other FX field stay private', async () => {
  const raw = manualWorld();
  const { owner, publicSettings, typeRate } = apps(raw);
  await typeRate('1660');
  // An adjustment saved on MANUAL is no part of the rate in force: the reading does not move, and
  // the figure is nowhere in the public answers.
  const adj = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: Number(pairOf(raw, 'USD_IQD').owner_version), market_adjustment_iqd: '37.2501' });
  assert.equal(adj.status, 200, await adj.clone().text());
  assert.equal(pairOf(raw, 'USD_IQD').market_adjustment_iqd, '37.2501', 'control: the adjustment was saved');
  for (const s of await publicSettings()) {
    assert.equal(s.displayUsdRate, '1660');
    assert.equal(s.displayUsdRateAttributed, false);
    const fx = Object.keys(s).filter((k) => /fx|adjust|market|manual|cost|effective|applied|pending/i.test(k));
    assert.deepEqual(fx, [], 'no FX key beside the reading and its flag');
    assert.equal(JSON.stringify(s).includes('37.2501'), false, 'the adjustment is never public');
  }
});

test('a typed rate purges /api/settings/public and the home answers that carry the reading', async () => {
  const raw = manualWorld();
  const { typeRate } = apps(raw);
  for (const rate of ['1660', '1670']) {
    const deleted = await typeRate(rate);
    for (const path of ['/api/settings/public', '/api/home', '/api/home/sections']) assert.ok(purged(deleted, path), `${rate}: ${path} purged (${deleted.join(', ')})`);
  }
});

test('with a market figure: the reading is the rate in force (DECISIONS row 252) — 1,680 built from the market, credited; then the typed 1,700, the shop\'s own', async () => {
  // A rate built from the provider (market 1,660 + the owner's 20 = 1,680 in force), then a typed 1,700.
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '20' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1680');
  raw.exec("UPDATE fx_rate_pairs SET market_rate = '1660' WHERE pair = 'USD_IQD'");
  const { publicSettings, typeRate } = apps(raw);
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed, s.exchangeRate], ['1680', true, 1680]);
  await typeRate('1700');
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed, s.exchangeRate], ['1700', false, 1700], 'the rate he typed is the one in force');

  // The provider's last validated reading alone (a typed rate, a reading never applied): the typed rate, uncredited.
  const lone = manualWorld();
  const t = apps(lone);
  await t.typeRate('1700');
  lone.exec("UPDATE fx_rate_pairs SET market_rate = '1655' WHERE pair = 'USD_IQD'");
  assert.deepEqual(await getPublicDisplayRate(asD1(lone) as unknown as D1Database), { displayUsdRate: '1700', displayUsdRateAttributed: false, exchangeRate: 1700 });
});

test('back on AUTO before the market rebuilds the rate: a typed rate stays the shop’s own, uncredited; a paused market rate is credited again', async () => {
  // Market 1,660 + the owner's 20 = 1,680 in force, built from the market.
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec("UPDATE fx_rate_pairs SET market_adjustment_iqd = '20' WHERE pair = 'USD_IQD'");
  applyRate(raw, 'USD_IQD', '1680');
  raw.exec("UPDATE fx_rate_pairs SET market_rate = '1660' WHERE pair = 'USD_IQD'");
  const { owner, publicSettings, typeRate } = apps(raw);
  const ov = () => Number(pairOf(raw, 'USD_IQD').owner_version);
  const setMode = async (mode: 'AUTO' | 'MANUAL') => {
    const spy = cacheSpy();
    try {
      const res = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ov(), mode });
      assert.equal(res.status, 200, await res.clone().text());
    } finally {
      spy.restore();
    }
  };
  // «إيقاف» then back to AUTO with no fetch: U is still the market-built 1,680 — credited again.
  await setMode('MANUAL');
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed], ['1680', false]);
  await setMode('AUTO');
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed, s.exchangeRate], ['1680', true, 1680]);
  // The owner types 1,700, then goes back to AUTO; the market has not rebuilt U (no fetch, held, or the dead band).
  await typeRate('1700');
  await setMode('AUTO');
  const usd = pairOf(raw, 'USD_IQD');
  assert.deepEqual([usd.mode, usd.manual_rate, usd.effective_rate], ['AUTO', null, '1700'], 'control: AUTO, the typed rate still in force');
  for (const s of await publicSettings())
    assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed, s.exchangeRate], ['1700', false, 1700], 'the owner-typed 1,700 is never credited to IQWealth');
  // An adjustment on AUTO shifts the typed rate; it is still the shop's own.
  const adj = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ov(), market_adjustment_iqd: '25' });
  assert.equal(adj.status, 200, await adj.clone().text());
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed], ['1705', false]);
});

test('back on AUTO with still no market figure: the rate in force is still the reading (DECISIONS row 252) — an adjustment there moves it, purged, uncredited', async () => {
  const raw = manualWorld();
  const { owner, publicSettings, typeRate } = apps(raw);
  await typeRate('1660');
  const ov = () => Number(pairOf(raw, 'USD_IQD').owner_version);
  const spy = cacheSpy();
  try {
    const auto = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ov(), mode: 'AUTO' });
    assert.equal(auto.status, 200, await auto.clone().text());
  } finally {
    spy.restore();
  }
  assert.ok(purged(spy.deleted, '/api/settings/public'), 'the mode change is purged');
  assert.deepEqual([pairOf(raw, 'USD_IQD').mode, pairOf(raw, 'USD_IQD').market_rate], ['AUTO', null], 'control: AUTO, the provider still silent');
  const adj = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ov(), market_adjustment_iqd: '20' });
  assert.equal(adj.status, 200, await adj.clone().text());
  assert.equal(derivedOf(raw).USD!.rate_iqd, '1680', 'control: the adjustment shifted the rate in force');
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed, s.exchangeRate], ['1680', false, 1680], 'the one official rate');
  // «إيقاف» again: the rate in force becomes the typed rate, and is the reading once more.
  const off = await put(owner, `${BASE}/rates/fx/USD_IQD/settings`, { owner_version: ov(), mode: 'MANUAL' });
  assert.equal(off.status, 200, await off.clone().text());
  for (const s of await publicSettings()) assert.deepEqual([s.displayUsdRate, s.displayUsdRateAttributed], ['1680', false]);
});

test('the provider’s first validated USD reading purges the public answers, with or without a rate moving (the reading turns from typed to market)', async () => {
  const rows = (await loadPairs(asD1(freshDb())))!;
  const usd = rows.find((r) => r.pair === 'USD_IQD')!;
  const plan = (row: typeof usd) =>
    planPairBatch([{ pair: 'USD_IQD', row, set: { market_rate: '1650', fetch_status: 'OK' }, ownerVisible: false, logs: [], audit: null }], rows, {
      fence: 'lease',
      token: 't',
      actor: null,
      nowIso: '2026-10-17T00:00:00.000Z',
      newLogId: () => 'x',
    });
  assert.equal(plan({ ...usd, market_rate: null }).displayRateChanged, true, 'first reading');
  assert.equal(plan({ ...usd, market_rate: '1640' }).displayRateChanged, false, 'a later reading that moves no rate purges nothing');
});
