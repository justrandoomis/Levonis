/**
 * THE COMMIT — pure planning of one `db.batch` (FX programme plan §5.3).
 *
 * In this order, in ONE batch (a D1 batch is one transaction):
 *   1. fences (`ops_guards`, two statements each): each pair this batch writes,
 *      on the scheduler's lease (`version` + `lease_token`) or on the owner's
 *      `owner_version` (critique L3); and ONE fence over all three pairs'
 *      `effective_version` as read, whatever was claimed (critiques F2, M1);
 *   2. one `UPDATE fx_rate_pairs` per pair: `version + 1`, `owner_version + 1`
 *      only for an owner-visible change, the lease released, and `status`
 *      DERIVED in SQL from the pending candidate and the fetch health
 *      (critique H1) so an owner act never contradicts a check that landed
 *      between its read and its write;
 *   3. the `fx_rate_log` rows — THE VALUES LIVE HERE, a private table;
 *   4. only if an effective rate changed: the derived IQD rates
 *      (USD = U, EUR = E×U, CNY = C×U) from the POST-commit effective values
 *      of all three pairs, written only where `rate_iqd` changed
 *      (`WHERE rate_iqd IS NOT ?`, §31) — the `pricing_fx_rates_in_step`
 *      trigger refuses any row stamped with a version that is not current;
 *   5. `audit_log` rows (built by the caller): ids and codes only, never a rate.
 * FX-5: once this batch has committed a rate move, the engine's writer
 * reprices the products it left stale — one fenced batch per product, within
 * the same statement budget (fx/reprice.ts) — never inside this batch.
 */
import { composeIqdRates } from '@levonis/pricing/fxChain';
import { FX_PAIRS, PAIR_CURRENCY, type FxPairId, type FxPairRow } from './pairs';
import type { FxDecision, FxLogDraft, PairSet } from './decide';

export type PlannedStatement =
  | { kind: 'sql'; sql: string; params: unknown[] }
  | { kind: 'fence'; condition: string; params: unknown[] };

export interface PlannedAudit {
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

export interface PairChange {
  pair: FxPairId;
  /** The row as read: its `version` / `owner_version` / `lease_token` are the fence. */
  row: FxPairRow;
  set: PairSet;
  ownerVisible: boolean;
  logs: FxLogDraft[];
  audit: PlannedAudit | null;
}

export interface PlannedBatch {
  statements: PlannedStatement[];
  audits: PlannedAudit[];
  /** The currencies of `pricing_fx_rates` this batch may rewrite (USD carries the public display rate). */
  derived: { currency: 'USD' | 'EUR' | 'CNY'; rate_iqd: string }[];
  displayRateChanged: boolean;
  /** Statements the batch costs (a fence counts two). */
  cost: number;
}

export interface PlanOptions {
  /** 'lease': the scheduler's claim; 'owner': an owner act's `owner_version`. */
  fence: 'lease' | 'owner';
  token?: string;
  actor: string | null;
  nowIso: string;
  /** Unique ids for the log rows (injected so a plan is reproducible in tests). */
  newLogId: () => string;
}

const WRITABLE = new Set<keyof PairSet>([
  'mode', 'interval_hours', 'market_rate', 'market_buy', 'official_rate', 'source_usd_per_eur', 'source_cny_per_eur',
  'market_adjustment_iqd', 'manual_rate', 'effective_rate', 'effective_version', 'effective_source', 'effective_applied_at',
  'effective_applied_by', 'last_known_good_rate', 'last_known_good_at', 'drift_anchor_rate', 'drift_anchor_at',
  'published_at', 'last_checked_at', 'last_check_result', 'last_successful_at', 'last_cron_success_at', 'fetch_status',
  'last_error_code', 'failing_since', 'pending_market_rate', 'pending_effective_rate', 'pending_published_at',
  'pending_observed_at', 'pending_reason', 'pending_notified_at', 'rejected_rate', 'rejected_at', 'anomaly_threshold_pct',
  'drift_threshold_pct', 'min_change_pct', 'bound_min', 'bound_max',
]);

const LOG_INSERT = `INSERT INTO fx_rate_log
  (id, pair, event, trigger_kind, provider, market_rate, effective_before, effective_after, pending_rate, change_ppm,
   published_at, result, error_code, repriced_products, actor_id, created_at, market_adjustment_iqd, settings_diff)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`;

const DERIVED_UPDATE = `UPDATE pricing_fx_rates
   SET rate_iqd = ?, usd_iqd_rate = ?, cross_rate = ?, usd_version = ?, cross_version = ?,
       version = version + 1, updated_by = ?, updated_at = ?
 WHERE currency = ? AND rate_iqd IS NOT ?`;

/** The one fence over all three pairs' effective versions (critiques F2, M1). */
export const ALL_PAIR_FENCE = `(SELECT effective_version FROM fx_rate_pairs WHERE pair='USD_IQD')=?
        AND (SELECT effective_version FROM fx_rate_pairs WHERE pair='EUR_USD')=?
        AND (SELECT effective_version FROM fx_rate_pairs WHERE pair='CNY_USD')=?`;

const has = (set: PairSet, k: keyof PairSet) => Object.prototype.hasOwnProperty.call(set, k);

/** The `UPDATE fx_rate_pairs` of one change. */
function pairUpdate(change: PairChange, opts: PlanOptions): PlannedStatement {
  const cols = (Object.keys(change.set) as (keyof PairSet)[]).filter((k) => WRITABLE.has(k));
  const assign = cols.map((k) => `${k} = ?`);
  const params: unknown[] = cols.map((k) => change.set[k] ?? null);
  // H1: status is DERIVED from the values this row will hold after the write.
  const pendingAfter = has(change.set, 'pending_effective_rate') ? change.set.pending_effective_rate ?? null : undefined;
  const fetchAfter = has(change.set, 'fetch_status') ? change.set.fetch_status : undefined;
  const pendingExpr = pendingAfter === undefined ? 'pending_effective_rate' : '?';
  const fetchExpr = fetchAfter === undefined ? 'fetch_status' : '?';
  assign.push(`status = CASE WHEN ${pendingExpr} IS NOT NULL THEN 'REVIEW_REQUIRED' ELSE ${fetchExpr} END`);
  if (pendingAfter !== undefined) params.push(pendingAfter);
  if (fetchAfter !== undefined) params.push(fetchAfter);
  assign.push('version = version + 1', 'owner_version = owner_version + ?', 'lease_token = NULL', 'lease_until = NULL', 'updated_by = ?', 'updated_at = ?');
  params.push(change.ownerVisible ? 1 : 0, opts.actor ?? 'system:fx', opts.nowIso);
  const where =
    opts.fence === 'lease'
      ? 'pair = ? AND version = ? AND lease_token = ?'
      : 'pair = ? AND owner_version = ?';
  params.push(change.pair, ...(opts.fence === 'lease' ? [change.row.version, opts.token ?? ''] : [change.row.owner_version]));
  return { kind: 'sql', sql: `UPDATE fx_rate_pairs SET ${assign.join(', ')} WHERE ${where}`, params };
}

function logInsert(pair: FxPairId, draft: FxLogDraft, opts: PlanOptions): PlannedStatement {
  return {
    kind: 'sql',
    sql: LOG_INSERT,
    params: [
      opts.newLogId(), pair, draft.event, draft.trigger_kind, draft.provider, draft.market_rate, draft.effective_before,
      draft.effective_after, draft.pending_rate, draft.change_ppm, draft.published_at, draft.result.slice(0, 20),
      draft.error_code, opts.actor, opts.nowIso, pair === 'USD_IQD' ? draft.market_adjustment_iqd : null, draft.settings_diff,
    ],
  };
}

/**
 * The batch for a set of pair changes. `allRows` are the three pairs as read
 * at the start: their `effective_version`s are the all-pair fence, and the
 * effective values of the pairs NOT changed here feed the derived rates (for
 * a USD change, the last trusted E and C even when those pairs are failing or
 * in review — §8).
 */
export function planPairBatch(changes: readonly PairChange[], allRows: readonly FxPairRow[], opts: PlanOptions): PlannedBatch {
  const statements: PlannedStatement[] = [];
  const audits: PlannedAudit[] = [];
  const byPair = new Map(allRows.map((r) => [r.pair, r]));
  for (const ch of changes) {
    statements.push(
      opts.fence === 'lease'
        ? { kind: 'fence', condition: 'EXISTS(SELECT 1 FROM fx_rate_pairs WHERE pair=? AND version=? AND lease_token=?)', params: [ch.pair, ch.row.version, opts.token ?? ''] }
        : { kind: 'fence', condition: 'EXISTS(SELECT 1 FROM fx_rate_pairs WHERE pair=? AND owner_version=?)', params: [ch.pair, ch.row.owner_version] }
    );
  }
  const effectiveChanged = changes.some((ch) => has(ch.set, 'effective_rate') && ch.set.effective_rate !== ch.row.effective_rate);
  if (opts.fence === 'lease' || effectiveChanged) {
    statements.push({ kind: 'fence', condition: ALL_PAIR_FENCE, params: FX_PAIRS.map((p) => byPair.get(p)?.effective_version ?? 0) });
  }
  for (const ch of changes) {
    statements.push(pairUpdate(ch, opts));
    for (const l of ch.logs) statements.push(logInsert(ch.pair, l, opts));
    if (ch.audit) audits.push(ch.audit);
  }
  const derived: PlannedBatch['derived'] = [];
  let displayRateChanged = false;
  if (effectiveChanged) {
    const after = new Map<FxPairId, { rate: string | null; version: number }>();
    for (const p of FX_PAIRS) {
      const r = byPair.get(p);
      after.set(p, { rate: r?.effective_rate ?? null, version: r?.effective_version ?? 0 });
    }
    for (const ch of changes) {
      if (has(ch.set, 'effective_rate')) {
        after.set(ch.pair, { rate: ch.set.effective_rate ?? null, version: ch.set.effective_version ?? ch.row.effective_version });
      }
    }
    const u = after.get('USD_IQD')!;
    const e = after.get('EUR_USD')!;
    const cn = after.get('CNY_USD')!;
    const rates = composeIqdRates(u.rate, e.rate, cn.rate);
    for (const pair of FX_PAIRS) {
      const currency = PAIR_CURRENCY[pair];
      const rate = rates[currency];
      if (rate === null) continue;
      const cross = pair === 'USD_IQD' ? null : after.get(pair)!;
      statements.push({
        kind: 'sql',
        sql: DERIVED_UPDATE,
        params: [rate, u.rate, cross?.rate ?? null, u.version, cross ? cross.version : null, opts.actor ?? 'system:fx', opts.nowIso, currency, rate],
      });
      derived.push({ currency, rate_iqd: rate });
    }
    const usdChange = changes.find((ch) => ch.pair === 'USD_IQD');
    displayRateChanged = !!usdChange && has(usdChange.set, 'effective_rate') && usdChange.set.effective_rate !== usdChange.row.effective_rate;
  }
  const cost = statements.reduce((n, s) => n + (s.kind === 'fence' ? 2 : 1), 0) + audits.length;
  return { statements, audits, derived, displayRateChanged, cost };
}

/** The scheduler's decisions as pair changes, with their audit rows (ids and codes only). */
export function planFxCommit(
  decisions: readonly FxDecision[],
  claimed: readonly FxPairRow[],
  allRows: readonly FxPairRow[],
  opts: PlanOptions & { trigger: 'cron' | 'refresh' | 'back_to_auto' }
): PlannedBatch {
  const claimedBy = new Map(claimed.map((r) => [r.pair, r]));
  const changes: PairChange[] = decisions.map((d) => ({
    pair: d.pair,
    row: claimedBy.get(d.pair)!,
    set: d.set,
    ownerVisible: d.ownerVisible,
    logs: d.logs,
    audit: { action: auditAction(d, opts.trigger), target: d.pair, detail: { pair: d.pair, result: d.result, code: d.code, trigger: opts.trigger } },
  }));
  return planPairBatch(changes, allRows, opts);
}

/** fx.apply / fx.review_held / fx.failed / fx.check — or fx.refresh for an owner's refresh (§14.1(10)). */
export function auditAction(d: Pick<FxDecision, 'result'>, trigger: 'cron' | 'refresh' | 'back_to_auto'): string {
  if (trigger === 'refresh') return 'fx.refresh';
  switch (d.result) {
    case 'APPLIED':
      return 'fx.apply';
    case 'REVIEW_HELD':
      return 'fx.review_held';
    case 'FAILED':
    case 'INVALID':
    case 'STALE':
    case 'NOT_CONFIGURED':
      return 'fx.failed';
    default:
      return 'fx.check';
  }
}

// ------------------------------------------------------------- errors

/** A fence (`ops_guards`, CHECK ok=1) refused the batch: someone wrote between the read and the write. */
export const isFenceMiss = (e: unknown): boolean =>
  /CHECK constraint failed:\s*ok\s*=\s*1\b/i.test(e instanceof Error ? e.message : String(e));

/** The trigger codes a batch may be refused with; anything else is COMMIT_REFUSED (critique M10). */
const KNOWN_CODES = ['FX_DERIVED_STALE', 'FX_VERSION_DISCIPLINE', 'FX_PAIR_PERMANENT', 'FX_LOG_IMMUTABLE', 'PRICING_RATE_PERMANENT', 'ENGINE_MANAGED'];
export function refusalCodeOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  for (const code of KNOWN_CODES) if (text.includes(code)) return code;
  const guard = /\b(PRICING_[A-Z_]{3,30}|FX_[A-Z_]{3,30})\b/.exec(text);
  return guard ? guard[1]! : 'COMMIT_REFUSED';
}
