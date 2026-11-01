/**
 * DEPLOY AHEAD: THE ROUTES WHOSE DESIGNED ANSWER ON AN OLDER DATABASE IS A
 * SPECIFIC REFUSAL (CLAUDE.md rule 2).
 *
 * The deploy-ahead sweeps (tests/costDeployAhead.test.ts on 0176,
 * tests/fxDeployAhead.test.ts on 0178) ask every GET the same question: does
 * this Worker answer one or more migrations behind EXACTLY as it does on the
 * migrated database? For almost every route the answer must be yes. A route
 * that reads ONLY tables a later migration creates cannot answer the same; its
 * designed behaviour there is one refusal, with one code, in three languages.
 *
 * Such a route is listed here BY NAME, with the status and code it must give
 * and the migration whose absence it reports. It is never skipped: the sweep
 * asserts that it answers on the migrated database, that it gives exactly this
 * status and code on the older one, and that the refusal is not cached. Every
 * route not listed stays held to strict equality, and a listed route the sweep
 * never reaches fails it (a stale entry hides nothing).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './d1';
import type { CallResult } from './roleMatrix';

export type SweepUser = 'owner' | 'full';

export interface DesignedRefusal {
  /** The concrete GET path, as `getPaths()` prints it. */
  readonly path: string;
  /** Who gets the refusal; everyone else is compared strictly. */
  readonly who: readonly SweepUser[];
  readonly status: number;
  readonly code: string;
  /** The migration whose tables the route reads; the refusal applies on any database before it. */
  readonly migration: string;
  /**
   * What the MIGRATED database answers when that is not a 2xx: a read by id whose sweep id (`p_a1`) names
   * nothing there answers 404. Absent: the migrated database must answer 2xx.
   */
  readonly ahead?: number;
}

export const DESIGNED_ON_OLDER_DB: readonly DesignedRefusal[] = [
  // FX-1 (FX programme plan §8, §15.2): the owner's central rates read only
  // fx_rate_pairs / pricing_fx_rates / fx_rate_log. A non-owner gets the
  // same 403 on both databases (the cost door comes first) and stays strict.
  { path: '/api/admin/pricing/rates', who: ['owner'], status: 503, code: 'PRICING_NOT_INSTALLED', migration: '0179_fx_rates.sql' },
  { path: '/api/admin/pricing/rates/history', who: ['owner'], status: 503, code: 'PRICING_NOT_INSTALLED', migration: '0179_fx_rates.sql' },
  // «طلب السعر» (DECISIONS row 240): the caller's own requests live only in 0193's table. Every signed-in
  // caller gets the same designed 503 there (the doors probe the table first); no listing or page reads it.
  { path: '/api/price-requests/mine', who: ['owner', 'full'], status: 503, code: 'PRICE_REQUESTS_UNAVAILABLE', migration: '0193_price_requests.sql' },
  // The Inputs stage's /products/:id/rules and /inputs were listed here (0181);
  // the clean start (spec addendum A.6) closed both: 409 PRICING_V2_MANAGED on
  // every database, so they are held to strict equality like any other route.
  // Services S-P2 (DECISIONS row 238): the owner's component references read
  // only trade_in_component_refs, which 0192 creates. A non-owner gets the same
  // 403 on both databases (the cost door comes first) and stays strict; every
  // other S-P2 door answers an older database as it answers the migrated one.
  { path: '/api/admin/trade-in/component-refs', who: ['owner'], status: 503, code: 'TRADE_IN_V2_NOT_INSTALLED', migration: '0192_trade_in_v2.sql' },
  // Smart pricing (docs/SMART_PRICING.md §2.4, §3.4, §4): the owner's supplier catalogue and the estimator read
  // only 0218's tables, so an older database hears 503 PRICE_ESTIMATES_NOT_INSTALLED — the shape of
  // PRICING_NOT_INSTALLED. Non-owners (403 on both, the cost door comes first) and the two supplier-link reads
  // (an empty list on both) stay strict. The two by-id reads name the sweep's `p_a1`, which is no type key and
  // has no stored estimate on the migrated database: 404 there.
  { path: '/api/admin/pricing/supplier-prices/snapshots', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql' },
  { path: '/api/admin/pricing/supplier-prices/matches', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql' },
  { path: '/api/admin/pricing/supplier-prices/lookup', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql' },
  { path: '/api/admin/pricing/estimates/control', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql' },
  { path: '/api/admin/pricing/estimates/types', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql' },
  { path: '/api/admin/pricing/estimates/products', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql' },
  { path: '/api/admin/pricing/estimates/types/p_a1/suggest', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql', ahead: 404 },
  { path: '/api/admin/pricing/estimates/products/p_a1', who: ['owner'], status: 503, code: 'PRICE_ESTIMATES_NOT_INSTALLED', migration: '0218_price_estimates.sql', ahead: 404 },
];

/** The listed refusal for this user and path on a database migrated through `through` (e.g. '0176'), if any. */
export function designedRefusal(who: SweepUser, path: string, through: string): DesignedRefusal | undefined {
  return DESIGNED_ON_OLDER_DB.find((d) => d.path === path && d.who.includes(who) && through < d.migration.slice(0, 4));
}

/** Every entry names a real migration file. */
export function unknownMigrations(): string[] {
  return DESIGNED_ON_OLDER_DB.filter((d) => !existsSync(join(ROOT, 'migrations', d.migration))).map((d) => `${d.path}: ${d.migration}`);
}

/**
 * Judge one GET: strict equality, or the listed refusal exactly. Returns the
 * differences found (none means the route behaves as designed), and marks a
 * listed route as reached in `reached`.
 */
export function judge(
  who: SweepUser,
  path: string,
  through: string,
  ahead: CallResult,
  behind: CallResult,
  reached: Set<string>
): string[] {
  const out: string[] = [];
  // A designed 503 (R2 or a closed community, the same on both) is an answer;
  // a crash or a hang is not.
  if (behind.status === 500 || behind.status === 599) out.push(`${who} ${path}: ${behind.status} on ${through}`);
  const designed = designedRefusal(who, path, through);
  if (!designed) {
    if (ahead.status !== behind.status) out.push(`${who} ${path}: ${ahead.status} on the migrated database, ${behind.status} on ${through}`);
    return out;
  }
  reached.add(`${who} ${path}`);
  if (designed.ahead === undefined ? ahead.status < 200 || ahead.status >= 300 : ahead.status !== designed.ahead) {
    out.push(`${who} ${path}: ${ahead.status} on the migrated database, where it must answer${designed.ahead === undefined ? '' : ` ${designed.ahead}`}`);
  }
  const code = behind.body && typeof behind.body === 'object' ? (behind.body as { code?: unknown }).code : undefined;
  if (behind.status !== designed.status || code !== designed.code) {
    out.push(`${who} ${path}: ${behind.status} ${String(code)} on ${through}, designed ${designed.status} ${designed.code}`);
  }
  if (behind.headers.get('cache-control') !== 'private, no-store') {
    out.push(`${who} ${path}: the refusal on ${through} is cacheable (${String(behind.headers.get('cache-control'))})`);
  }
  return out;
}

/** The listed refusals for these users on `through` that a sweep did not reach. */
export function unreached(users: readonly SweepUser[], through: string, reached: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const d of DESIGNED_ON_OLDER_DB) {
    if (through >= d.migration.slice(0, 4)) continue;
    for (const who of d.who) if (users.includes(who) && !reached.has(`${who} ${d.path}`)) out.push(`${who} ${d.path}`);
  }
  return out;
}
