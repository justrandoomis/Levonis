/**
 * S3 — NO RATE, COST OR KEY EVER REACHES A LOG (FX programme plan §14.1(12),
 * §14.2 S3; critiques F6, F9).
 *
 * A console spy runs across every scheduler path — an apply, a hold, each
 * provider failure (refused key, quota, redirect, 5xx, timeout, oversize body,
 * bad JSON, changed unit, stale flag, future time, malformed key with a CR/LF),
 * a fence miss raced by the owner, a trigger refusal — and across every owner
 * rates route, their refusals included. Nothing written to the console may
 * carry the key, a rate, a market figure or a cost; and no refusal's
 * `details` carries a value (`onError` sends `details` to the client as is):
 * at most a field NAME.
 *
 * Run: node --import tsx --test tests/fxLogsNoValues.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, stubApp, OWNER } from './fixtures/app';
import { OWNER_ROW_SQL, applyRate, fakeProviders, fxEnv, iqwealthBody, json200, ownerCommit } from './fixtures/fx';
import { runFxScheduler } from '../worker/lib/fx/scheduler';
import { planManualSet } from '../worker/lib/fx/ownerActs';
import { adminPricingRoutes } from '../worker/routes/adminPricing';

const KEY = 'iqw_live_LOGSENTINEL_77aa99';
const VALUES = ['1666.6666', '1777.7777', '1703.9167', '1660', '37.2501', '12345.678', 'LOGSENTINEL'];

async function captured(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const spy = (...a: unknown[]) => lines.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  Object.assign(console, { log: spy, info: spy, warn: spy, error: spy, debug: spy });
  try {
    await run();
  } finally {
    Object.assign(console, keep);
  }
  return lines.join('\n');
}

function assertClean(text: string, label: string) {
  for (const v of VALUES) assert.equal(text.includes(v), false, `${label}: the console carries ${v}\n${text.slice(0, 400)}`);
}

const usdApproved = () => {
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  applyRate(raw, 'USD_IQD', '1660');
  return raw;
};
const refresh = (raw: DatabaseSync, f: ReturnType<typeof fakeProviders>, key = KEY) =>
  runFxScheduler(fxEnv(raw, { IRAQ_PARALLEL_FX_API_KEY: key }), { now: new Date() }, { trigger: 'refresh', pairs: ['USD_IQD'], fetchImpl: f.fetch, deadlineMs: 200 });
const fresh = (sell: number) => json200(iqwealthBody({ sell, publishedAt: new Date(Date.now() - 60_000).toISOString() }));

test('S3: every scheduler path logs no key, no rate and no value', async () => {
  const scenarios: Array<[string, () => Response | Promise<Response>]> = [
    ['apply', () => fresh(1666.6666)],
    ['hold', () => fresh(1777.7777)],
    ['401', () => new Response('{"error":"bad key LOGSENTINEL"}', { status: 401 })],
    ['429', () => new Response('quota', { status: 429 })],
    ['302', () => new Response('', { status: 302, headers: { location: `https://evil.example/?k=${KEY}` } })],
    ['503', () => new Response('down 1666.6666', { status: 503 })],
    ['timeout', () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }), { status: 200 })],
    ['too large', () => new Response('x'.repeat(40_000), { status: 200 })],
    ['bad JSON', () => new Response('{1666.6666', { status: 200 })],
    ['unit', () => json200(iqwealthBody({ unit: 'IQD per 1 EUR', sell: 1666.6666 }))],
    ['stale', () => json200(iqwealthBody({ stale: true, sell: 1666.6666 }))],
    ['future', () => json200(iqwealthBody({ sell: 1666.6666, publishedAt: '2099-01-01T00:00:00Z' }))],
    ['network', () => Promise.reject(new TypeError(`connect failed for ${KEY} 1666.6666`))],
  ];
  for (const [label, usd] of scenarios) {
    const raw = usdApproved();
    const text = await captured(async () => void (await refresh(raw, fakeProviders({ usd }))));
    assertClean(text, label);
  }
  // A malformed key with a CR/LF: never sent, never logged.
  const raw = usdApproved();
  assertClean(await captured(async () => void (await refresh(raw, fakeProviders(), `${KEY}\r\nX: 1`))), 'malformed key');
});

test('S3: a fence miss raced by the owner and a trigger refusal log no value', async () => {
  const raw = usdApproved();
  let raced = false;
  const f = fakeProviders({ usd: () => fresh(1666.6666) });
  const inner = f.fetch;
  f.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!raced) {
      raced = true;
      await ownerCommit(raw, (rows) => planManualSet(rows[0]!, { owner_version: rows[0]!.owner_version, rate: '1703.9167' }, { actor: 'usr_owner', now: new Date() }), new Date());
    }
    return inner(input, init);
  }) as typeof fetch;
  assertClean(await captured(async () => void (await refresh(raw, f))), 'fence miss');
  const refused = usdApproved();
  refused.exec("CREATE TRIGGER t_guard BEFORE UPDATE OF rate_iqd ON pricing_fx_rates BEGIN SELECT RAISE(ABORT, 'GUARD 1666.6666'); END;");
  assertClean(await captured(async () => void (await refresh(refused, fakeProviders({ usd: () => fresh(1666.6666) })))), 'trigger refusal');
});

test('S3: every owner rates route — answers and refusals — logs no value, and no refusal details carry one', async () => {
  const raw = usdApproved();
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/api/admin/pricing', adminPricingRoutes), { env: { IRAQ_PARALLEL_FX_API_KEY: KEY } });
  const details: unknown[] = [];
  const codes: string[] = [];
  const text = await captured(async () => {
    const calls = [
      () => get(app, '/api/admin/pricing/rates'),
      () => get(app, '/api/admin/pricing/rates/history?limit=5'),
      () => get(app, '/api/admin/pricing/rates/history?pair=1666.6666'),
      () => put(app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: 999, rate: '1703.9167' }),
      () => put(app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: 1, rate: '1666.6666x' }),
      () => put(app, '/api/admin/pricing/rates/fx/USD_IQD/manual', { owner_version: 1, rate: '12345.678' }),
      () => put(app, '/api/admin/pricing/rates/fx/USD_IQD/settings', { owner_version: 1, market_adjustment_iqd: '37.2501x' }),
      () => put(app, '/api/admin/pricing/rates/fx/USD_IQD/settings', { owner_version: 1, bound_min: '1777.7777' }),
      () => post(app, '/api/admin/pricing/rates/fx/USD_IQD/review', { owner_version: 1, decision: 'approve' }),
      () => post(app, '/api/admin/pricing/rates/fx/refresh', { pairs: ['USD_IQD'] }),
      () => put(app, '/api/admin/pricing/rates/shipping/CHINA_AIR', { version: 1, rate_iqd: '12345.678x' }),
      () => put(app, '/api/admin/pricing/rates/shipping/CHINA_AIR', { version: 1, rate_iqd: '12345.678' }),
    ];
    for (const call of calls) {
      const res = await call();
      const b = await json(res);
      if (res.status >= 400) {
        codes.push(String(b.code));
        details.push(b.details ?? null);
      }
    }
  });
  assertClean(text, 'routes');
  assert.ok(details.length >= 6, `${details.length} refusals walked`);
  for (const code of ['PRICING_CHANGED', 'PRICING_INPUT_INVALID', 'FX_RATE_OUT_OF_BOUNDS', 'FX_BOUNDS_EXCLUDE_EFFECTIVE', 'FX_REVIEW_NOT_PENDING']) {
    assert.ok(codes.includes(code), `${code} was walked (${codes.join(', ')})`);
  }
  for (const d of details) {
    if (d === null) continue;
    assert.deepEqual(Object.keys(d as object).filter((k) => k !== 'field' && k !== 'fields'), [], JSON.stringify(d));
    for (const v of VALUES) assert.equal(JSON.stringify(d).includes(v), false, JSON.stringify(d));
  }
});
