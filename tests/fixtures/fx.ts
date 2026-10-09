/**
 * FX TEST FIXTURES (FX programme plan §15): provider bodies, a fake fetch that
 * answers them (no test ever reaches a real provider), and helpers to read and
 * shape the 0179 rows. Every test that drives the scheduler injects its own
 * `fetchImpl`; route tests go through `providerFetch` (tests/fixtures/app.ts).
 */
import type { DatabaseSync } from 'node:sqlite';
import { asD1, row, all } from './app';
import type { Env } from '../../worker/lib/types';
import type { FxPairId } from '../../worker/lib/fx/pairs';
import { planPairBatch } from '../../worker/lib/fx/commit';
import { toStatements } from '../../worker/lib/fx/write';
import { loadPairs } from '../../worker/lib/fx/pairs';
import type { PlannedAct } from '../../worker/lib/fx/ownerActs';

export const GOOD_KEY = 'iqw_live_0123456789abcdef';

/** An IQWealth answer as plan §6 reads it. */
export function iqwealthBody(o: { sell?: unknown; buy?: unknown; cbi?: unknown; publishedAt?: unknown; stale?: unknown; unit?: unknown } = {}) {
  return JSON.stringify({
    unit: 'unit' in o ? o.unit : 'IQD per 1 USD',
    parallel: {
      sell: 'sell' in o ? o.sell : 1660,
      buy: 'buy' in o ? o.buy : 1650,
      stale: 'stale' in o ? o.stale : false,
      publishedAt: 'publishedAt' in o ? o.publishedAt : '2026-10-08T12:41:58Z',
    },
    official: { cbi: 'cbi' in o ? o.cbi : 1310 },
  });
}

/** The ECB daily file, shaped like the real 2026-10-08 one. */
export function ecbBody(o: { day?: string; usd?: string; cny?: string; extra?: string } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<gesmes:Sender>
		<gesmes:name>European Central Bank</gesmes:name>
	</gesmes:Sender>
	<Cube>
		<Cube time='${o.day ?? '2026-10-08'}'>
			<Cube currency='USD' rate='${o.usd ?? '1.1186'}'/>
			<Cube currency='JPY' rate='170.21'/>
			<Cube currency='GBP' rate='0.86855'/>
			${o.cny === '' ? '' : `<Cube currency='CNY' rate='${o.cny ?? '7.4972'}'/>`}
			${o.extra ?? ''}
		</Cube>
	</Cube>
</gesmes:Envelope>`;
}

export interface FakeProviders {
  fetch: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }>;
  usd: () => Response | Promise<Response>;
  ecb: () => Response | Promise<Response>;
}

/** A fake fetch for the two providers; anything else is a test bug. */
export function fakeProviders(opts: { usd?: () => Response | Promise<Response>; ecb?: () => Response | Promise<Response> } = {}): FakeProviders {
  const f: FakeProviders = {
    calls: [],
    usd: opts.usd ?? (() => new Response(iqwealthBody(), { status: 200, headers: { 'content-type': 'application/json' } })),
    ecb: opts.ecb ?? (() => new Response(ecbBody(), { status: 200, headers: { 'content-type': 'text/xml' } })),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      f.calls.push({ url, headers, redirect: init?.redirect });
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const host = new URL(url).hostname;
      if (host === 'iraqsm.com') return f.usd();
      if (host === 'www.ecb.europa.eu') return f.ecb();
      throw new Error(`unexpected fetch to ${host}`);
    }) as typeof fetch,
  };
  return f;
}

export const json200 = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
export const xml200 = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });

export function fxEnv(raw: DatabaseSync, extra: Partial<Env> = {}): Env {
  return { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co', IRAQ_PARALLEL_FX_API_KEY: GOOD_KEY, ...extra } as Env;
}

export const pairOf = (raw: DatabaseSync, pair: FxPairId) => row<Record<string, unknown>>(raw, 'SELECT * FROM fx_rate_pairs WHERE pair = ?', pair)!;
export const derivedOf = (raw: DatabaseSync) =>
  Object.fromEntries(all<{ currency: string; rate_iqd: string | null; version: number }>(raw, 'SELECT currency, rate_iqd, version, usd_version, cross_version FROM pricing_fx_rates').map((r) => [r.currency, r]));
export const logsOf = (raw: DatabaseSync, pair?: FxPairId) =>
  pair
    ? all<Record<string, unknown>>(raw, 'SELECT * FROM fx_rate_log WHERE pair = ? ORDER BY created_at, rowid', pair)
    : all<Record<string, unknown>>(raw, 'SELECT * FROM fx_rate_log ORDER BY created_at, rowid');

/**
 * Put a pair in an applied state directly (the owner approved `rate` at `at`,
 * the anchor with it), as if by the approval route, with its log row — the
 * starting point of most scheduler scenarios. The derived IQD rates follow.
 */
export function applyRate(raw: DatabaseSync, pair: FxPairId, rate: string, at = '2026-10-01T00:00:00.000Z', publishedAt: string | null = null) {
  const r = pairOf(raw, pair);
  raw
    .prepare(
      `UPDATE fx_rate_pairs SET effective_rate = ?, effective_version = effective_version + 1, effective_source = 'review_approved',
              effective_applied_at = ?, last_known_good_rate = ?, last_known_good_at = ?, drift_anchor_rate = ?, drift_anchor_at = ?,
              market_rate = ?, fetch_status = 'OK', status = 'OK', published_at = COALESCE(?, published_at)
        WHERE pair = ?`
    )
    .run(rate, at, rate, at, rate, at, pair === 'USD_IQD' ? rate : rate, publishedAt, pair);
  raw
    .prepare(
      `INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, created_at, market_adjustment_iqd)
       VALUES (?, ?, 'review_approved', 'owner', 'owner', ?, ?, 'APPLIED', ?, ?)`
    )
    .run(
      `fxl_seed_${pair}_${Math.random().toString(36).slice(2)}`,
      pair,
      (r.effective_rate as string | null) ?? null,
      rate,
      at,
      pair === 'USD_IQD' ? (r.market_adjustment_iqd as string) : null
    );
  syncDerived(raw);
}

/** Recompute pricing_fx_rates from the pairs exactly as the commit does (a fixture shortcut). */
export function syncDerived(raw: DatabaseSync) {
  const p = (x: FxPairId) => pairOf(raw, x);
  const u = p('USD_IQD');
  if (u.effective_rate === null) return;
  const mul = (a: string, b: string) => {
    // exact product of two decimals as text
    const [ai, af = ''] = a.split('.');
    const [bi, bf = ''] = b.split('.');
    const n = BigInt(ai + af) * BigInt(bi + bf);
    const places = af.length + bf.length;
    const s = n.toString().padStart(places + 1, '0');
    const whole = s.slice(0, s.length - places);
    const frac = s.slice(s.length - places).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  };
  raw.prepare('UPDATE pricing_fx_rates SET rate_iqd = ?, usd_iqd_rate = ?, usd_version = ?, version = version + 1 WHERE currency = ? AND rate_iqd IS NOT ?')
    .run(u.effective_rate as string, u.effective_rate as string, u.effective_version as number, 'USD', u.effective_rate as string);
  for (const [pair, cur] of [['EUR_USD', 'EUR'], ['CNY_USD', 'CNY']] as const) {
    const x = p(pair);
    if (x.effective_rate === null) continue;
    const rate = mul(x.effective_rate as string, u.effective_rate as string);
    raw.prepare('UPDATE pricing_fx_rates SET rate_iqd = ?, usd_iqd_rate = ?, cross_rate = ?, usd_version = ?, cross_version = ?, version = version + 1 WHERE currency = ? AND rate_iqd IS NOT ?')
      .run(rate, u.effective_rate as string, x.effective_rate as string, u.effective_version as number, x.effective_version as number, cur, rate);
  }
}

// ------------------------------------------------------------- owner acts on a simulated clock


/**
 * Commit one owner act exactly as the route does (the same planner, fenced on
 * owner_version), on the test's own clock — the scheduler scenarios run on
 * simulated time, and the routes read the wall clock.
 */
export async function ownerCommit(raw: DatabaseSync, plan: (rows: NonNullable<Awaited<ReturnType<typeof loadPairs>>>) => PlannedAct, now: Date, actor = 'usr_owner') {
  const db = asD1(raw);
  const rows = (await loadPairs(db))!;
  const planned = plan(rows);
  const batch = planPairBatch(planned.changes, rows, { fence: 'owner', actor, nowIso: now.toISOString(), newLogId: () => `fxl_${Math.random().toString(36).slice(2)}${Date.now()}` });
  await db.batch(await toStatements(db, batch, actor));
  return { planned, batch };
}

export const OWNER_ROW_SQL =
  "INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_owner','Owner','boss@x.co','h','admin','2026-01-01T00:00:00.000Z')";

/** A provider whose figures a scenario moves tick by tick; its publication follows the tick. */
export function market(initial: { sell?: number; usd?: string; cny?: string } = {}) {
  const state = {
    sell: initial.sell ?? 1660,
    usd: initial.usd ?? '1.1186',
    cny: initial.cny ?? '7.4972',
    at: new Date('2026-10-08T12:00:00.000Z'),
    usdDown: false,
    ecbDown: false,
    /** ECB days advance only when a scenario says so (the same Cube date is the same publication). */
    ecbDay: '2026-10-08',
  };
  const f = fakeProviders({
    usd: () =>
      state.usdDown
        ? new Response('down', { status: 503 })
        : json200(iqwealthBody({ sell: state.sell, publishedAt: new Date(state.at.getTime() - 5 * 60_000).toISOString() })),
    ecb: () => (state.ecbDown ? new Response('down', { status: 503 }) : xml200(ecbBody({ day: state.ecbDay, usd: state.usd, cny: state.cny }))),
  });
  return { state, f };
}
