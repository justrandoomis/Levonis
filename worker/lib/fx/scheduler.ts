/**
 * THE FX SCHEDULER — ONE ENTRY FOR THE CRON, «تحديث الآن» AND «العودة إلى
 * التلقائي» (FX programme plan §5; owner brief 2026-10-08 §4–§10, §28–§31).
 *
 *   loadPairs → due (cron) or named (refresh / back to automatic)
 *   → claimLease: one UPDATE … RETURNING per pair takes a 120-second lease AND
 *     reserves the provider's day budget for the attempt and its retry BEFORE
 *     any request (critique F4); a pair over its cap makes no request and is
 *     recorded DEFERRED / PROVIDER_BUDGET
 *   → ONE 12-second AbortSignal bounds connect, body and retry of both
 *     providers together (critique F5); one IQWealth call for USD/IQD, one ECB
 *     file for EUR/USD and CNY/USD
 *   → decide (pure, decide.ts) → planFxCommit (pure, commit.ts) → one batch,
 *     with one re-plan after a fence miss (no second fetch) and, after any
 *     other refusal, each pair alone, then COMMIT_REFUSED (critiques H1, M10)
 *   → the public display rate's caches purged when the USD rate moved (L4)
 *   → the owner's bell for a review or a long failure (never a figure).
 *
 * NEVER THROWS: every failure is a recorded status, the last known good rate
 * stays in force, and a rate is never 0 (the CHECKs refuse it). NEVER IN THE
 * CUSTOMER PATH: imported only by worker/index.ts (the cron) and the owner's
 * routes (tests/fxNoCustomerPath.test.ts). FX-1 changes no product price: the
 * repricing statements arrive in FX-5, within the same statement budget.
 */
import type { Env } from '../types';
import { purgeCatalogueFromJob } from '../edgePolicy';
import { iqwealthKeyState, iqwealthRequest, type IqwealthQuote, type ProviderOutcome } from './providers/iqwealth';
import { CALLS_PER_CLAIM, PROVIDER_DAY_CAP, isDue } from './schedule';
import { fetchEcb, type EcbQuote } from './providers/ecb';
import { FX_INVOCATION_STATEMENT_BUDGET, statementBudget, type StatementBudget } from './budget';
import { PAIR_COLUMNS, iso, loadPairs, type FxCheckResult, type FxPairId, type FxPairRow } from './pairs';
import { R24_WINDOW_MS, WINDOW_MAX_ROWS, adjustmentOf, decideSafely, type DecisionContext, type FxAttention, type FxClock, type FxDecision, type FxTrigger, type PairOutcome } from './decide';
import { isFenceMiss, planFxCommit, refusalCodeOf } from './commit';
import { toStatements } from './write';
import { notifyOwnerFx } from './notify';

export type { FxClock, FxTrigger } from './decide';

export const FX_PROVIDER_DEADLINE_MS = 12_000;
export const FX_LEASE_MS = 120_000;
export { CALLS_PER_CLAIM, FX_DUE_TOLERANCE_MS, PROVIDER_DAY_CAP, isDue, nextCheckAt } from './schedule';

/** Whether the IQWealth key is set and well formed — a boolean for the owner's panel, never the key. */
export function fxKeyConfigured(env: Pick<Env, 'IRAQ_PARALLEL_FX_API_KEY'>): boolean {
  return iqwealthKeyState(env) === 'ok';
}

export interface FxRunOptions {
  trigger: FxTrigger;
  /** refresh / back_to_auto: which pairs (default all three). Cron: ignored — the due logic decides. */
  pairs?: readonly FxPairId[];
  /** The owner for a refresh; null for the cron (audited as the system). */
  actorId?: string | null;
  /** Tests only: the providers' fetch. Production uses the global one. */
  fetchImpl?: typeof fetch;
  /** Tests only: a shorter deadline than the 12 seconds. */
  deadlineMs?: number;
  /** Shared with FX-5's repricing and the sweep (§7.4). */
  budget?: StatementBudget;
}

export interface FxCheckedPair {
  pair: FxPairId;
  result: FxCheckResult;
  code: string | null;
}

export interface FxRunReport {
  skipped?: 'NOT_INSTALLED' | 'NOTHING_DUE' | 'LEASE_HELD_OR_BUDGET' | 'ERROR';
  checked: FxCheckedPair[];
  /** Pairs another run was already checking (a refresh answers FX_REFRESH_IN_PROGRESS). */
  leaseHeld: FxPairId[];
  /** Pairs over their provider day budget: no request was made. */
  budgetDeferred: FxPairId[];
  displayRateChanged: boolean;
}

const emptyReport = (skipped?: FxRunReport['skipped']): FxRunReport => ({
  ...(skipped ? { skipped } : {}),
  checked: [],
  leaseHeld: [],
  budgetDeferred: [],
  displayRateChanged: false,
});

const providerOf = (p: FxPairId) => (p === 'USD_IQD' ? 'iqwealth' : 'ecb') as 'iqwealth' | 'ecb';

/**
 * Take the lease and reserve the provider budget, one statement per pair. A
 * pair whose lease another run holds is skipped; a pair over its cap is
 * recorded DEFERRED / PROVIDER_BUDGET and makes no request.
 */
async function claimLease(
  db: D1Database,
  wanted: readonly FxPairRow[],
  token: string,
  now: Date,
  trigger: FxTrigger,
  budget: StatementBudget,
  report: FxRunReport,
  actorId: string | null
): Promise<FxPairRow[]> {
  const nowIso = iso(now);
  const until = iso(now.getTime() + FX_LEASE_MS);
  const day = nowIso.slice(0, 10);
  const claimed: FxPairRow[] = [];
  for (const row of wanted) {
    if (!budget.spend(1)) break;
    const caps = PROVIDER_DAY_CAP[providerOf(row.pair)];
    const cap = trigger === 'cron' ? caps.total : caps.nonCron;
    const got = await db
      .prepare(
        `UPDATE fx_rate_pairs
            SET lease_token = ?1, lease_until = ?2,
                provider_calls_count = CASE WHEN provider_calls_day = ?3 THEN provider_calls_count + ?4 ELSE ?4 END,
                provider_calls_day = ?3,
                version = version + 1
          WHERE pair = ?5 AND (lease_token IS NULL OR lease_until < ?6)
            AND (CASE WHEN provider_calls_day = ?3 THEN provider_calls_count ELSE 0 END) + ?4 <= ?7
        RETURNING ${PAIR_COLUMNS.join(', ')}`
      )
      .bind(token, until, day, CALLS_PER_CLAIM, row.pair, nowIso, cap)
      .first<FxPairRow>();
    if (got) {
      claimed.push({ ...got });
      continue;
    }
    // Not claimed: another run's live lease, or the day budget. Read again —
    // a run that claimed after our first read holds a lease we have not seen.
    if (!budget.spend(1)) break;
    const now2 = await db
      .prepare('SELECT lease_token, lease_until FROM fx_rate_pairs WHERE pair = ?')
      .bind(row.pair)
      .first<{ lease_token: string | null; lease_until: string | null }>();
    const leased = !!now2 && now2.lease_token !== null && now2.lease_until !== null && now2.lease_until >= nowIso;
    if (leased) {
      report.leaseHeld.push(row.pair);
      continue;
    }
    if (!budget.spend(4)) continue;
    report.budgetDeferred.push(row.pair);
    report.checked.push({ pair: row.pair, result: 'DEFERRED', code: 'PROVIDER_BUDGET' });
    try {
      await db.batch([
        db
          .prepare(
            `UPDATE fx_rate_pairs SET last_checked_at = ?, last_check_result = 'DEFERRED', last_error_code = 'PROVIDER_BUDGET',
                    version = version + 1, updated_by = ?, updated_at = ?
              WHERE pair = ? AND (lease_token IS NULL OR lease_until < ?)`
          )
          .bind(nowIso, actorId ?? 'system:fx', nowIso, row.pair, nowIso),
        db
          .prepare(
            `INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, error_code, actor_id, created_at, market_adjustment_iqd)
             VALUES (?, ?, 'deferred', ?, ?, ?, ?, 'DEFERRED', 'PROVIDER_BUDGET', ?, ?, ?)`
          )
          .bind(`fxl_${crypto.randomUUID()}`, row.pair, trigger, providerOf(row.pair), row.effective_rate, row.effective_rate, actorId, nowIso, adjustmentOf(row)),
      ]);
    } catch (e) {
      console.error('fx: budget deferral not recorded:', e instanceof Error ? e.name : 'unknown');
    }
  }
  return claimed;
}

/**
 * What the 24-hour guard measures against, per claimed AUTO pair (owner
 * decision 11), in two indexed reads (idx_fx_rate_log_pair), each charged to
 * the budget:
 *   r24     the `effective_after` of the newest log row at or before now − 24 h,
 *           with the adjustment it carried;
 *   window  every `effective_after` written after now − 24 h — at most
 *           WINDOW_MAX_ROWS; one more is 'overflow'.
 * FAIL CLOSED: a read the budget refuses, OR A READ THAT THROWS, leaves that
 * pair 'unread' and its decision applies nothing — a recorded DEFERRED /
 * FX_GUARD_UNREAD for that pair alone. (A budget refusal used to fall back to
 * the anchor silently; a database error used to end the whole run unrecorded,
 * every claimed pair's tick lost and the leases held — FX-1A review #1.) Only
 * the error's NAME is logged.
 */
async function loadDecisionContext(db: D1Database, claimed: readonly FxPairRow[], now: Date, budget: StatementBudget): Promise<DecisionContext> {
  const cutoff = iso(now.getTime() - R24_WINDOW_MS);
  const r24: DecisionContext['r24'] = {};
  const window: DecisionContext['window'] = {};
  for (const row of claimed) {
    if (row.mode !== 'AUTO') continue;
    if (!budget.spend(1)) {
      window[row.pair] = 'unread';
      continue;
    }
    try {
      const hit = await db
        .prepare(
          `SELECT effective_after, market_adjustment_iqd FROM fx_rate_log
            WHERE pair = ? AND created_at <= ? AND effective_after IS NOT NULL
            ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .bind(row.pair, cutoff)
        .first<{ effective_after: string; market_adjustment_iqd: string | null }>();
      r24[row.pair] = hit ? { rate: hit.effective_after, adj: hit.market_adjustment_iqd } : null;
    } catch (e) {
      console.error('fx: 24-hour reference not read:', row.pair, e instanceof Error ? e.name : 'unknown');
      window[row.pair] = 'unread';
      continue;
    }
    if (!budget.spend(1)) {
      window[row.pair] = 'unread';
      continue;
    }
    try {
      const { results } = await db
        .prepare(
          `SELECT effective_after, market_adjustment_iqd, created_at FROM fx_rate_log
            WHERE pair = ? AND created_at > ? AND effective_after IS NOT NULL
            ORDER BY created_at DESC, rowid DESC LIMIT ?`
        )
        .bind(row.pair, cutoff, WINDOW_MAX_ROWS + 1)
        .all<{ effective_after: string; market_adjustment_iqd: string | null; created_at: string }>();
      const rows = results ?? [];
      window[row.pair] =
        rows.length > WINDOW_MAX_ROWS ? 'overflow' : rows.map((r) => ({ rate: r.effective_after, adj: r.market_adjustment_iqd, at: r.created_at }));
    } catch (e) {
      console.error('fx: 24-hour window not read:', row.pair, e instanceof Error ? e.name : 'unknown');
      window[row.pair] = 'unread';
    }
  }
  return { r24, window };
}

/** One pair's view of the two provider answers. A rejected promise is a NETWORK failure. */
export function quoteFor(
  pair: FxPairId,
  usd: PromiseSettledResult<ProviderOutcome<IqwealthQuote> | null>,
  ecb: PromiseSettledResult<ProviderOutcome<EcbQuote> | null>
): PairOutcome {
  if (pair === 'USD_IQD') {
    if (usd.status !== 'fulfilled' || !usd.value) return { kind: 'error', code: 'NETWORK' };
    const o = usd.value;
    if (o.kind !== 'quote') return o;
    return { kind: 'quote', market: o.quote.market, buy: o.quote.buy, official: o.quote.official, sourceUsdPerEur: null, sourceCnyPerEur: null, publishedAtMs: o.quote.publishedAtMs };
  }
  if (ecb.status !== 'fulfilled' || !ecb.value) return { kind: 'error', code: 'NETWORK' };
  const o = ecb.value;
  if (o.kind !== 'quote') return o;
  return {
    kind: 'quote',
    market: pair === 'EUR_USD' ? o.quote.usdPerEur : o.quote.cnyUsd,
    buy: null,
    official: null,
    sourceUsdPerEur: o.quote.usdPerEur,
    sourceCnyPerEur: o.quote.cnyPerEur,
    publishedAtMs: o.quote.publishedAtMs,
  };
}

const newLogId = () => `fxl_${crypto.randomUUID()}`;

/** A raw log insert's adjustment, as adjustmentOf(): USD/IQD's own while AUTO; NULL on the ECB pairs (the log CHECK) and on a manual rate. */
const ADJUSTMENT_IN_FORCE = "CASE WHEN pair = 'USD_IQD' AND mode = 'AUTO' THEN market_adjustment_iqd ELSE NULL END";

interface CommitDone {
  report: FxRunReport;
  attention: FxAttention[];
}

/** The minimal record of a pair whose batch was refused twice: lease released, FAILED, a commit_refused row (M10). */
async function recordRefused(db: D1Database, row: FxPairRow, token: string, code: string, nowIso: string, trigger: FxTrigger, actorId: string | null, budget: StatementBudget, deferred: boolean) {
  if (!budget.spend(2)) return;
  const result = deferred ? 'DEFERRED' : 'FAILED';
  try {
    await db.batch([
      db
        .prepare(
          deferred
            ? `UPDATE fx_rate_pairs SET last_checked_at = ?, last_check_result = 'DEFERRED', last_error_code = ?,
                      version = version + 1, lease_token = NULL, lease_until = NULL, updated_by = ?, updated_at = ?
                WHERE pair = ? AND lease_token = ?`
            : `UPDATE fx_rate_pairs SET last_checked_at = ?, last_check_result = 'FAILED', last_error_code = ?,
                      fetch_status = 'FAILED', failing_since = COALESCE(failing_since, ?1),
                      status = CASE WHEN pending_effective_rate IS NOT NULL THEN 'REVIEW_REQUIRED' ELSE 'FAILED' END,
                      version = version + 1, lease_token = NULL, lease_until = NULL, updated_by = ?, updated_at = ?
                WHERE pair = ? AND lease_token = ?`
        )
        .bind(nowIso, code, actorId ?? 'system:fx', nowIso, row.pair, token),
      db
        .prepare(
          `INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, error_code, actor_id, created_at, market_adjustment_iqd)
           SELECT ?, ?, ?, ?, ?, effective_rate, effective_rate, ?, ?, ?, ?, ${ADJUSTMENT_IN_FORCE} FROM fx_rate_pairs WHERE pair = ?`
        )
        .bind(newLogId(), row.pair, deferred ? 'deferred' : 'commit_refused', trigger, providerOf(row.pair), result, code, actorId, nowIso, row.pair),
    ]);
  } catch (e) {
    console.error('fx: refusal not recorded:', e instanceof Error ? e.name : 'unknown');
  }
}

/** SUPERSEDED: the owner wrote this pair while it was being fetched; the owner wins (a log row only). */
async function recordSuperseded(db: D1Database, pair: FxPairId, nowIso: string, trigger: FxTrigger, actorId: string | null, budget: StatementBudget) {
  if (!budget.spend(1)) return;
  try {
    await db
      .prepare(
        `INSERT INTO fx_rate_log (id, pair, event, trigger_kind, provider, effective_before, effective_after, result, actor_id, created_at, market_adjustment_iqd)
         SELECT ?, ?, 'superseded', ?, ?, effective_rate, effective_rate, 'SUPERSEDED', ?, ?, ${ADJUSTMENT_IN_FORCE} FROM fx_rate_pairs WHERE pair = ?`
      )
      .bind(newLogId(), pair, trigger, providerOf(pair), actorId, nowIso, pair)
      .run();
  } catch (e) {
    console.error('fx: supersession not recorded:', e instanceof Error ? e.name : 'unknown');
  }
}

/** Commit, with one re-plan after a fence miss and per-pair retries after any other refusal (§5.3). */
async function commitWithOneRetry(
  db: D1Database,
  outcomes: Map<FxPairId, PairOutcome>,
  ctx: DecisionContext,
  claimed: FxPairRow[],
  allRows: FxPairRow[],
  clock: FxClock,
  opts: FxRunOptions,
  token: string,
  budget: StatementBudget
): Promise<CommitDone> {
  const nowIso = iso(clock.now);
  const actorId = opts.actorId ?? null;
  const report = emptyReport();
  const attention: FxAttention[] = [];
  const planOf = (decisions: FxDecision[], rows: FxPairRow[], all: FxPairRow[]) =>
    planFxCommit(decisions, rows, all, { fence: 'lease', token, actor: actorId, nowIso, newLogId, trigger: opts.trigger });
  // decideSafely: a pair whose decision throws is recorded INVALID alone; the run and the other pairs go on (H1).
  const decideAll = (rows: FxPairRow[]) => rows.map((r) => decideSafely(r, outcomes.get(r.pair)!, ctx, clock, opts.trigger));

  const tryBatch = async (decisions: FxDecision[], rows: FxPairRow[], all: FxPairRow[]): Promise<'ok' | 'fence' | 'error' | 'budget' | { error: unknown }> => {
    const plan = planOf(decisions, rows, all);
    if (!budget.spend(plan.cost)) return 'budget';
    try {
      await db.batch(await toStatements(db, plan, actorId));
    } catch (e) {
      return isFenceMiss(e) ? 'fence' : { error: e };
    }
    for (const d of decisions) {
      report.checked.push({ pair: d.pair, result: d.result, code: d.code });
      if (d.attention) attention.push(d.attention);
    }
    if (plan.displayRateChanged) report.displayRateChanged = true;
    return 'ok';
  };

  /** The pairs of `rows` still leased to this run, re-read. */
  const reload = async () => {
    budget.spend(1);
    return (await loadPairs(db)) ?? [];
  };

  let decisions = decideAll(claimed);
  const first = await tryBatch(decisions, claimed, allRows);
  if (first === 'ok') return { report, attention };

  if (first === 'fence') {
    // The owner (or another run) wrote meanwhile. Pairs no longer leased to us: SUPERSEDED.
    const fresh = await reload();
    const ours = fresh.filter((r) => claimed.some((c) => c.pair === r.pair) && r.lease_token === token);
    for (const c of claimed) if (!ours.some((r) => r.pair === c.pair)) {
      await recordSuperseded(db, c.pair, nowIso, opts.trigger, actorId, budget);
      report.checked.push({ pair: c.pair, result: 'SUPERSEDED', code: null });
    }
    if (ours.length === 0) return { report, attention };
    decisions = decideAll(ours);
    const second = await tryBatch(decisions, ours, fresh);
    if (second === 'ok') return { report, attention };
    for (const r of ours) {
      await recordRefused(db, r, token, 'FX_COMMIT_CONFLICT', nowIso, opts.trigger, actorId, budget, true);
      report.checked.push({ pair: r.pair, result: 'DEFERRED', code: 'FX_COMMIT_CONFLICT' });
    }
    return { report, attention };
  }

  if (first === 'budget') {
    for (const r of claimed) {
      await recordRefused(db, r, token, 'FX_STATEMENT_BUDGET', nowIso, opts.trigger, actorId, budget, true);
      report.checked.push({ pair: r.pair, result: 'DEFERRED', code: 'FX_STATEMENT_BUDGET' });
    }
    return { report, attention };
  }

  // Any other refusal: one pair's problem must not cost another its update (H1).
  let lastError: unknown = (first as { error: unknown }).error;
  const pending = claimed.length > 1 ? [...claimed] : [];
  if (pending.length === 0) {
    const code = refusalCodeOf(lastError);
    await recordRefused(db, claimed[0]!, token, code, nowIso, opts.trigger, actorId, budget, false);
    report.checked.push({ pair: claimed[0]!.pair, result: 'FAILED', code });
    return { report, attention };
  }
  for (const c of pending) {
    const fresh = await reload();
    const row = fresh.find((r) => r.pair === c.pair && r.lease_token === token);
    if (!row) {
      await recordSuperseded(db, c.pair, nowIso, opts.trigger, actorId, budget);
      report.checked.push({ pair: c.pair, result: 'SUPERSEDED', code: null });
      continue;
    }
    const alone = await tryBatch(decideAll([row]), [row], fresh);
    if (alone === 'ok') continue;
    if (typeof alone === 'object') lastError = alone.error;
    const code = alone === 'fence' ? 'FX_COMMIT_CONFLICT' : alone === 'budget' ? 'FX_STATEMENT_BUDGET' : refusalCodeOf(lastError);
    const deferred = alone === 'fence' || alone === 'budget';
    await recordRefused(db, row, token, code, nowIso, opts.trigger, actorId, budget, deferred);
    report.checked.push({ pair: row.pair, result: deferred ? 'DEFERRED' : 'FAILED', code });
  }
  return { report, attention };
}

/** THE ONE ENTRY (§5). Never throws. */
export async function runFxScheduler(env: Env, clock: FxClock, opts: FxRunOptions): Promise<FxRunReport> {
  const db = env.DB;
  const budget = opts.budget ?? statementBudget(FX_INVOCATION_STATEMENT_BUDGET);
  try {
    if (!budget.spend(1)) return emptyReport('ERROR');
    const rows = await loadPairs(db);
    if (rows === null) return emptyReport('NOT_INSTALLED');
    const named = opts.pairs && opts.pairs.length ? opts.pairs : (['USD_IQD', 'EUR_USD', 'CNY_USD'] as const);
    const wanted =
      opts.trigger === 'cron'
        ? rows.filter((p) => isDue(p, clock.scheduledTime ?? clock.now))
        : rows.filter((p) => named.includes(p.pair));
    if (wanted.length === 0) return emptyReport('NOTHING_DUE');
    const token = crypto.randomUUID();
    const pre = emptyReport();
    const claimed = await claimLease(db, wanted, token, clock.now, opts.trigger, budget, pre, opts.actorId ?? null);
    if (claimed.length === 0) return { ...pre, skipped: 'LEASE_HELD_OR_BUDGET' };

    // ONE deadline for both providers: connect, body and the retry (critique F5).
    // An explicit controller and timer — cleared when both answers are in —
    // rather than AbortSignal.timeout, so the deadline also holds where an
    // idle timer would not keep the process alive.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException('FX provider deadline', 'TimeoutError')), opts.deadlineMs ?? FX_PROVIDER_DEADLINE_MS);
    let usd: PromiseSettledResult<ProviderOutcome<IqwealthQuote> | null>;
    let ecb: PromiseSettledResult<ProviderOutcome<EcbQuote> | null>;
    try {
      [usd, ecb] = await Promise.allSettled([
        claimed.some((p) => p.pair === 'USD_IQD') ? iqwealthRequest(env, deadline.signal, opts.fetchImpl) : Promise.resolve(null),
        claimed.some((p) => p.pair !== 'USD_IQD') ? fetchEcb(deadline.signal, opts.fetchImpl) : Promise.resolve(null),
      ]);
    } finally {
      clearTimeout(timer);
    }
    const outcomes = new Map<FxPairId, PairOutcome>(claimed.map((p) => [p.pair, quoteFor(p.pair, usd, ecb)]));
    const ctx = await loadDecisionContext(db, claimed, clock.now, budget);
    // FX-5 appends the repricing statements of the affected engine products to the commit, within `budget` (§7.4).
    const done = await commitWithOneRetry(db, outcomes, ctx, claimed, rows, clock, opts, token, budget);
    const report: FxRunReport = {
      checked: [...pre.checked, ...done.report.checked],
      leaseHeld: pre.leaseHeld,
      budgetDeferred: pre.budgetDeferred,
      displayRateChanged: done.report.displayRateChanged,
    };
    if (report.displayRateChanged) await purgeCatalogueFromJob(env, [], { settings: true });
    if (done.attention.length) await notifyOwnerFx(env, done.attention);
    // FX-5: await sweepStaleEnginePrices(env, budget) with whatever budget is left (§7.4).
    return report;
  } catch (e) {
    // A database error outside every recorded path: the lease expires in 120 s and the next tick retries.
    console.error('fx scheduler: run failed:', e instanceof Error ? e.name : 'unknown');
    return emptyReport('ERROR');
  }
}

