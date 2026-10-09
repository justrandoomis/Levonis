/**
 * THE DECISION — one pair, one provider outcome, pure (FX programme plan §5.2).
 *
 * Let a = the effective rate, anchor = the last OWNER-CONFIRMED rate (the
 * Confirmed Rate), r24 = the rate in force 24 hours ago (the anchor when
 * nothing is that old), W = every rate in force inside the last 24 hours, T
 * the anomaly threshold, D the drift threshold, M the dead band. The steps run
 * in order and the first that matches decides:
 *
 *    1  MANUAL — a refresh only OBSERVES (a log row); nothing owner-visible moves.
 *    2  the provider failed → FAILED / STALE / NOT_CONFIGURED; effective, last
 *       known good and any pending candidate untouched (§29).
 *    3  the figure is invalid → INVALID (FX_FUTURE, FX_UNIT_CHANGED, …).
 *    4  the publication went backwards → STALE (FX_NOT_MONOTONIC); the same
 *       publication with another figure → INVALID (FX_PUBLICATION_CONFLICT).
 *    5  the candidate c (USD: market sell + adjustment; EUR: the ECB USD; CNY:
 *       ceil10(USD ÷ CNY)) must lie within the pair's bounds — from here the
 *       fetch is validated.
 *    6  no applied rate yet → held, FIRST_VALUE.
 *    7  back to automatic beyond T → held, BACK_TO_AUTO.
 *    8  a HOLD (6, 7, 10–12) within T of a value the owner rejected in the
 *       last 24 h → DEFERRED instead: no hold, no bell. It never stops an
 *       apply or the dead band (FX-1 review C1, C2).
 *    9  inside the dead band → UNCHANGED (a pending candidate is cleared).
 *   10  beyond T of a → held, ANOMALY.
 *   11  beyond T of ANY rate in force during the last 24 hours → held,
 *       ANOMALY_24H (owner decision 11). The references are r24 — the anchor
 *       instead when the owner confirmed a rate inside the window (FX-1
 *       review C5) — and every rate of W after the window's start (after the
 *       confirmation when there is one: an approval restarts the measurement
 *       from the Confirmed Rate). A USD/IQD reference taken under another
 *       adjustment is re-based onto today's (rate − then + now), so an
 *       adjustment change is never a market jump. FAILS CLOSED: a window
 *       longer than one read takes ('overflow') is held ANOMALY_24H; a window
 *       or r24 the statement budget did not let us read, or whose read
 *       failed ('unread'), applies nothing this tick — DEFERRED /
 *       FX_GUARD_UNREAD, no bell. A window rate whose time does not parse is
 *       still measured.
 *   12  beyond D of the anchor → held, DRIFT.
 *   13  otherwise APPLIED (the anchor does not move).
 *
 * Every comparison is exact (rationals); exactly T (or D) is applied.
 * Nothing here reads a clock, the database or the network: the inputs are the
 * row, the outcome, the 24-hour reference and the clock passed in.
 */
import {
  changePpm,
  movesLessThanPct,
  movesMoreThanPct,
  rebaseOnAdjustment,
  sameRate,
  usdIqdCandidate,
  withinBounds,
} from '@levonis/pricing/fxChain';
import {
  HOUR_MS,
  iso,
  type FxCheckResult,
  type FxFetchStatus,
  type FxLogEvent,
  type FxPairId,
  type FxPairRow,
  type FxPendingReason,
  type FxTriggerKind,
  type FxEffectiveSource,
} from './pairs';

export type FxTrigger = 'cron' | 'refresh' | 'back_to_auto';

export interface FxClock {
  now: Date;
  /** The cron's `event.scheduledTime`: the due-logic phase (critique L1). */
  scheduledTime?: Date;
}

/** One pair's view of the provider answer. */
export type PairOutcome =
  | {
      kind: 'quote';
      /** The pair's own market figure: USD/IQD sell, USD per EUR, or C. */
      market: string;
      buy: string | null;
      official: string | null;
      sourceUsdPerEur: string | null;
      sourceCnyPerEur: string | null;
      publishedAtMs: number;
    }
  | { kind: 'error'; code: string }
  | { kind: 'invalid'; code: string };

/** The columns of `fx_rate_pairs` a decision or an owner act may write. */
export interface PairSet {
  mode?: 'AUTO' | 'MANUAL';
  interval_hours?: number;
  market_rate?: string | null;
  market_buy?: string | null;
  official_rate?: string | null;
  source_usd_per_eur?: string | null;
  source_cny_per_eur?: string | null;
  market_adjustment_iqd?: string;
  manual_rate?: string | null;
  effective_rate?: string | null;
  effective_version?: number;
  effective_source?: FxEffectiveSource | null;
  effective_applied_at?: string | null;
  effective_applied_by?: string | null;
  last_known_good_rate?: string | null;
  last_known_good_at?: string | null;
  drift_anchor_rate?: string | null;
  drift_anchor_at?: string | null;
  published_at?: string | null;
  last_checked_at?: string | null;
  last_check_result?: FxCheckResult | null;
  last_successful_at?: string | null;
  last_cron_success_at?: string | null;
  fetch_status?: FxFetchStatus;
  last_error_code?: string | null;
  failing_since?: string | null;
  pending_market_rate?: string | null;
  pending_effective_rate?: string | null;
  pending_published_at?: string | null;
  pending_observed_at?: string | null;
  pending_reason?: FxPendingReason | null;
  pending_notified_at?: string | null;
  rejected_rate?: string | null;
  rejected_at?: string | null;
  anomaly_threshold_pct?: string;
  drift_threshold_pct?: string;
  min_change_pct?: string;
  bound_min?: string;
  bound_max?: string;
}

/** One `fx_rate_log` row to write. Values live here, never in audit_log. */
export interface FxLogDraft {
  event: FxLogEvent;
  trigger_kind: FxTriggerKind;
  provider: 'iqwealth' | 'ecb' | 'owner' | null;
  market_rate: string | null;
  effective_before: string | null;
  effective_after: string | null;
  pending_rate: string | null;
  change_ppm: number | null;
  published_at: string | null;
  result: string;
  error_code: string | null;
  /**
   * USD/IQD: the adjustment this row's rate carries (owner decision 5); null on
   * the ECB pairs and on a manual rate — a manual rate is final and never
   * includes the adjustment.
   */
  market_adjustment_iqd: string | null;
  /** settings_change rows only: `[{field, before, after}]` as JSON text (owner decision 10). */
  settings_diff: string | null;
}

/**
 * The adjustment `row`'s rate in force carries — what a log row of it records:
 * USD/IQD's own while it tracks the market (AUTO); null on an ECB pair, and
 * null on a MANUAL pair, whose rate is the owner's final figure with no
 * adjustment in it («السعر اليدوي نهائي، ولا تُضاف إليه الزيادة»). So the
 * history never shows an adjustment under a manual rate, and the 24-hour
 * guard never re-bases a manual rate onto a later adjustment (FX-1A review #4).
 */
export const adjustmentOf = (row: Pick<FxPairRow, 'pair' | 'mode' | 'market_adjustment_iqd'>): string | null =>
  row.pair === 'USD_IQD' && row.mode === 'AUTO' ? row.market_adjustment_iqd : null;

/** Why the owner's bell rings — never a figure. */
export interface FxAttention {
  pair: FxPairId;
  kind: 'review' | 'failing' | 'guard_change';
  /** De-duplicates the notification (user_notifications event key). */
  key: string;
}

export interface FxDecision {
  pair: FxPairId;
  result: FxCheckResult;
  code: string | null;
  set: PairSet;
  logs: FxLogDraft[];
  effectiveBefore: string | null;
  effectiveAfter: string | null;
  effectiveChanged: boolean;
  /** Bumps owner_version: the effective rate or the pending candidate changed (critique L3). */
  ownerVisible: boolean;
  attention: FxAttention | null;
}

/** A rate in force at some moment, with the USD/IQD adjustment it carried (null: an ECB pair, or not known). */
export interface RateInForce {
  rate: string;
  adj: string | null;
}

/** One rate in force inside the 24-hour window: a history row's `effective_after`, when it was written. */
export interface WindowRate extends RateInForce {
  at: string;
}

/**
 * The window as read: its rates (newest first), 'overflow' when it holds more
 * rows than one read takes (WINDOW_MAX_ROWS), or 'unread' when the statement
 * budget refused the read or the read failed.
 */
export type WindowRead = readonly WindowRate[] | 'overflow' | 'unread';

/**
 * What step 11 measures against, per claimed AUTO pair (owner decision 11):
 *   r24     the rate in force 24 h ago; null when nothing is that old (the
 *           anchor stands in); ABSENT when it was not read;
 *   window  every rate in force inside the last 24 hours; absent = 'unread'.
 * Absent is never "nothing moved": the guard then applies nothing (fail closed).
 */
export interface DecisionContext {
  r24: Partial<Record<FxPairId, RateInForce | null>>;
  window: Partial<Record<FxPairId, WindowRead>>;
}

/** The most window rows one read takes; one more is 'overflow' — held, never guessed (owner decision 11). */
export const WINDOW_MAX_ROWS = 200;

export const FUTURE_TOLERANCE_MS = 5 * 60_000;
export const REJECT_MEMORY_MS = 24 * HOUR_MS;
export const BELL_EVERY_MS = 24 * HOUR_MS;
/** The 24-hour guard's window (step 11). */
export const R24_WINDOW_MS = 24 * HOUR_MS;
/** The fixed sanity band on USD/IQD, as the pricing_fx_rates CHECK has it (critique F1). */
export const USD_IQD_SANITY = { min: '500', max: '10000' } as const;

const KEY_CODES = new Set(['KEY_MISSING', 'KEY_MALFORMED']);
const isEcb = (p: FxPairId) => p !== 'USD_IQD';
const providerOf = (p: FxPairId): 'iqwealth' | 'ecb' => (p === 'USD_IQD' ? 'iqwealth' : 'ecb');
const triggerKindOf = (t: FxTrigger): FxTriggerKind => t;

/** The candidate a quote gives this pair. */
export function candidateOf(row: Pick<FxPairRow, 'pair' | 'market_adjustment_iqd'>, market: string): string {
  return row.pair === 'USD_IQD' ? usdIqdCandidate(market, row.market_adjustment_iqd) : market;
}

/** Re-ring the bell for a candidate still waiting, at most every 24 hours (critique M4.4). */
function reRing(row: FxPairRow, nowMs: number, nowIso: string): { set: PairSet; attention: FxAttention | null } {
  if (row.pending_effective_rate === null) return { set: {}, attention: null };
  const last = row.pending_notified_at ? Date.parse(row.pending_notified_at) : NaN;
  if (Number.isFinite(last) && nowMs - last < BELL_EVERY_MS) return { set: {}, attention: null };
  return { set: { pending_notified_at: nowIso }, attention: { pair: row.pair, kind: 'review', key: `fx:${row.pair}:review:${nowIso}` } };
}

function log(row: FxPairRow, trigger: FxTrigger, partial: Partial<FxLogDraft> & Pick<FxLogDraft, 'event' | 'result'>): FxLogDraft {
  return {
    trigger_kind: triggerKindOf(trigger),
    provider: providerOf(row.pair),
    market_rate: null,
    effective_before: row.effective_rate,
    effective_after: row.effective_rate,
    pending_rate: null,
    change_ppm: null,
    published_at: null,
    error_code: null,
    market_adjustment_iqd: adjustmentOf(row),
    settings_diff: null,
    ...partial,
  };
}

export function decide(row: FxPairRow, outcome: PairOutcome, ctx: DecisionContext, clock: FxClock, trigger: FxTrigger): FxDecision {
  const nowMs = clock.now.getTime();
  const nowIso = iso(clock.now);
  const a = row.effective_rate;
  const base = (result: FxCheckResult, code: string | null, set: PairSet, logs: FxLogDraft[], extra: Partial<FxDecision> = {}): FxDecision => ({
    pair: row.pair,
    result,
    code,
    set: { last_checked_at: nowIso, last_check_result: result, ...set },
    logs,
    effectiveBefore: a,
    effectiveAfter: a,
    effectiveChanged: false,
    ownerVisible: false,
    attention: null,
    ...extra,
  });

  /** A failure (steps 2–4): the fetch health moves; nothing applied, nothing pending touched. */
  const failure = (result: FxCheckResult, fetchStatus: FxFetchStatus, code: string): FxDecision => {
    const failing = fetchStatus === 'FAILED' || fetchStatus === 'STALE';
    const since = failing ? row.failing_since ?? nowIso : row.failing_since;
    const ring = reRing(row, nowMs, nowIso);
    let attention = ring.attention;
    if (!attention && failing && since) {
      const sinceMs = Date.parse(since);
      if (Number.isFinite(sinceMs) && nowMs - sinceMs >= BELL_EVERY_MS) {
        attention = { pair: row.pair, kind: 'failing', key: `fx:${row.pair}:failing:${nowIso.slice(0, 10)}` };
      }
    }
    return base(
      result,
      code,
      { fetch_status: fetchStatus, last_error_code: code, failing_since: since, ...ring.set },
      [log(row, trigger, { event: 'failure', result, error_code: code })],
      { attention }
    );
  };

  // 1. MANUAL: a refresh observes; the cron never selects it.
  if (row.mode === 'MANUAL') {
    if (outcome.kind !== 'quote') {
      const result: FxCheckResult = outcome.kind === 'invalid' ? 'INVALID' : KEY_CODES.has(outcome.code) ? 'NOT_CONFIGURED' : outcome.code === 'STALE' ? 'STALE' : 'FAILED';
      return base(result, outcome.code, { last_error_code: outcome.code }, [log(row, trigger, { event: 'observed', result, error_code: outcome.code })]);
    }
    const bad = validityProblem(row, outcome, nowMs);
    const c = candidateOf(row, outcome.market);
    const outOfBounds = !withinBounds(c, row.bound_min, row.bound_max) || (row.pair === 'USD_IQD' && !withinBounds(c, USD_IQD_SANITY.min, USD_IQD_SANITY.max));
    if (bad || outOfBounds) {
      const code = bad?.code ?? 'FX_RATE_OUT_OF_BOUNDS';
      const result: FxCheckResult = bad?.result ?? 'INVALID';
      return base(result, code, { last_error_code: code }, [log(row, trigger, { event: 'observed', result, error_code: code, market_rate: outcome.market })]);
    }
    return base('OBSERVED', null, {}, [
      log(row, trigger, { event: 'observed', result: 'OBSERVED', market_rate: outcome.market, pending_rate: c, published_at: iso(outcome.publishedAtMs) }),
    ]);
  }

  // 2. The provider returned an error.
  if (outcome.kind === 'error') {
    if (KEY_CODES.has(outcome.code)) return failure('NOT_CONFIGURED', 'NOT_CONFIGURED', outcome.code);
    if (outcome.code === 'STALE') return failure('STALE', 'STALE', 'STALE');
    return failure('FAILED', 'FAILED', outcome.code);
  }
  // 3. Validation (§6).
  if (outcome.kind === 'invalid') return failure('INVALID', 'FAILED', outcome.code);
  const problem = validityProblem(row, outcome, nowMs);
  if (problem) return failure(problem.result, problem.result === 'STALE' ? 'STALE' : 'FAILED', problem.code);

  // 4. The publication never goes backwards (critiques F7, M5).
  const pub = iso(outcome.publishedAtMs);
  if (row.published_at !== null) {
    if (pub < row.published_at) return failure('STALE', 'STALE', 'FX_NOT_MONOTONIC');
    if (pub === row.published_at && (row.market_rate === null || !sameRate(row.market_rate, outcome.market))) {
      return failure('INVALID', 'FAILED', 'FX_PUBLICATION_CONFLICT');
    }
  }

  // 5. The candidate, within bounds.
  const c = candidateOf(row, outcome.market);
  const inBounds =
    withinBounds(c, row.bound_min, row.bound_max) &&
    (row.pair !== 'USD_IQD' || (withinBounds(outcome.market, row.bound_min, row.bound_max) && withinBounds(c, USD_IQD_SANITY.min, USD_IQD_SANITY.max)));
  if (!inBounds) return failure('INVALID', 'FAILED', 'FX_RATE_OUT_OF_BOUNDS');

  const validated: PairSet = {
    fetch_status: 'OK',
    failing_since: null,
    last_error_code: null,
    last_successful_at: nowIso,
    published_at: pub,
    market_rate: outcome.market,
    ...(isEcb(row.pair)
      ? { source_usd_per_eur: outcome.sourceUsdPerEur, source_cny_per_eur: outcome.sourceCnyPerEur }
      : { market_buy: outcome.buy, official_rate: outcome.official }),
    ...(trigger === 'cron' ? { last_cron_success_at: iso(clock.scheduledTime ?? clock.now) } : {}),
  };
  const quoteLog = { market_rate: outcome.market, published_at: pub };

  const hold = (reason: FxPendingReason): FxDecision => {
    const entering = row.pending_effective_rate === null;
    const changed = entering || !sameRate(row.pending_effective_rate!, c) || row.pending_reason !== reason;
    const ring = entering
      ? { set: { pending_notified_at: nowIso } as PairSet, attention: { pair: row.pair, kind: 'review' as const, key: `fx:${row.pair}:review:${nowIso}` } }
      : reRing(row, nowMs, nowIso);
    return base(
      'REVIEW_HELD',
      reason,
      {
        ...validated,
        pending_market_rate: outcome.market,
        pending_effective_rate: c,
        pending_published_at: pub,
        pending_observed_at: nowIso,
        pending_reason: reason,
        ...ring.set,
      },
      [log(row, trigger, { event: 'review_held', result: 'REVIEW_HELD', error_code: reason, pending_rate: c, change_ppm: a ? changePpm(a, c) : null, ...quoteLog })],
      { ownerVisible: changed, attention: ring.attention }
    );
  };

  const T = row.anomaly_threshold_pct;
  /**
   * 8. A value the owner rejected in the last 24 hours is not HELD again — no
   * hold, no bell (critique M4.2). The memory turns a would-be hold (steps 6,
   * 7, 10–12) into DEFERRED and nothing else: an ordinary move every guard
   * would apply still applies, and the dead band still clears. Checked before
   * step 9 it froze every move near the rejected value for a day; checked
   * after step 6 a rejected FIRST value was re-held and re-rung at the next
   * tick (FX-1 correctness review C1, C2).
   */
  const rejectedRecently = (): boolean => {
    if (row.rejected_rate === null || row.rejected_at === null) return false;
    const at = Date.parse(row.rejected_at);
    return Number.isFinite(at) && nowMs - at < REJECT_MEMORY_MS && !movesMoreThanPct(c, row.rejected_rate, T);
  };
  const holdUnlessRejected = (reason: FxPendingReason): FxDecision =>
    rejectedRecently()
      ? base('DEFERRED', 'FX_REJECTED_RECENTLY', { ...validated, last_error_code: 'FX_REJECTED_RECENTLY' }, [
          log(row, trigger, { event: 'deferred', result: 'DEFERRED', error_code: 'FX_REJECTED_RECENTLY', pending_rate: c, ...quoteLog }),
        ])
      : hold(reason);

  // 6. No applied rate yet.
  if (a === null) return holdUnlessRejected('FIRST_VALUE');
  // 7. Back to automatic beyond the step threshold.
  if (trigger === 'back_to_auto' && movesMoreThanPct(c, a, T)) return holdUnlessRejected('BACK_TO_AUTO');
  // 9. The dead band (Q6): only a check is recorded; a pending candidate is cleared.
  if (sameRate(c, a) || movesLessThanPct(c, a, row.min_change_pct)) {
    const logs = [log(row, trigger, { event: 'check', result: 'UNCHANGED', ...quoteLog })];
    const clear: PairSet = {};
    if (row.pending_effective_rate !== null) {
      Object.assign(clear, PENDING_CLEARED);
      logs.push(log(row, trigger, { event: 'review_cleared', result: 'UNCHANGED', pending_rate: row.pending_effective_rate }));
    }
    return base('UNCHANGED', null, { ...validated, ...clear }, logs, { ownerVisible: row.pending_effective_rate !== null });
  }
  // 10. One-step guard.
  if (movesMoreThanPct(c, a, T)) return holdUnlessRejected('ANOMALY');
  // 11. 24-hour guard (owner decision 11; critiques F1, M4.1). It bounds
  // AUTOMATIC movement in a day: more than T against ANY rate in force during
  // the last 24 hours waits for the owner. Measured against r24 alone, a
  // staircase 1,680 → 1,632 → 1,680 → 1,728 (each step under 3%, each within
  // 3% of 1,680) applied a 5.9% move inside one day.
  // A rate the owner confirmed inside the window (an approval, a manual rate,
  // «تأكيد السعر الحالي») replaces r24 and starts the window: measured from the
  // rate in force 24 hours ago, the next ordinary tick after an approved jump
  // was held again in the same direction (FX-1 correctness review C5). The
  // anchor moves only by the owner's confirmations (an adjustment shifts it by
  // its own change and keeps its time), so a stale session cannot reset the
  // window with a no-op save.
  const anchor = row.drift_anchor_rate ?? a;
  const anchorAt = row.drift_anchor_at ? Date.parse(row.drift_anchor_at) : NaN;
  const confirmedInWindow = row.drift_anchor_rate !== null && Number.isFinite(anchorAt) && nowMs - anchorAt < R24_WINDOW_MS;
  const window = ctx.window[row.pair];
  const r24 = ctx.r24[row.pair];
  // FAIL CLOSED: a window (or an r24 it needs) that could not be read applies nothing this tick.
  if (window === undefined || window === 'unread' || (!confirmedInWindow && r24 === undefined)) {
    return base('DEFERRED', 'FX_GUARD_UNREAD', { ...validated, last_error_code: 'FX_GUARD_UNREAD' }, [
      log(row, trigger, { event: 'deferred', result: 'DEFERRED', error_code: 'FX_GUARD_UNREAD', pending_rate: c, ...quoteLog }),
    ]);
  }
  // More rates in a day than one read takes is itself abnormal: held, never guessed.
  if (window === 'overflow') return holdUnlessRejected('ANOMALY_24H');
  // USD/IQD: a reference taken under another adjustment is re-based onto today's.
  const adjNow = adjustmentOf(row);
  const rebased = (ref: RateInForce): string | null =>
    adjNow === null || ref.adj === null ? ref.rate : rebaseOnAdjustment(ref.rate, ref.adj, adjNow);
  const since = confirmedInWindow ? anchorAt : nowMs - R24_WINDOW_MS;
  const references: (string | null)[] = [confirmedInWindow || !r24 ? anchor : rebased(r24)];
  for (const w of window) {
    const at = Date.parse(w.at);
    // A time that does not parse is still a rate of the window (the read only
    // takes the last 24 hours): measured, never skipped — skipping would
    // loosen the guard (fail closed; FX-1A review #8).
    if (!Number.isFinite(at) || at > since) references.push(rebased(w));
  }
  // A reference that cannot be re-based (it would not stay above zero) is a hold too.
  if (references.some((ref) => ref === null || movesMoreThanPct(c, ref, T))) return holdUnlessRejected('ANOMALY_24H');
  // 12. Drift from the owner's last confirmation (critique F1).
  if (movesMoreThanPct(c, anchor, row.drift_threshold_pct)) return holdUnlessRejected('DRIFT');
  // 13. Applied.
  const logs = [
    log(row, trigger, { event: 'apply', result: 'APPLIED', effective_after: c, change_ppm: changePpm(a, c), ...quoteLog }),
  ];
  if (row.pending_effective_rate !== null) {
    logs.push(log(row, trigger, { event: 'review_cleared', result: 'APPLIED', effective_after: c, pending_rate: row.pending_effective_rate }));
  }
  return base(
    'APPLIED',
    null,
    {
      ...validated,
      effective_rate: c,
      effective_version: row.effective_version + 1,
      effective_source: 'provider',
      effective_applied_at: nowIso,
      effective_applied_by: 'system:fx',
      last_known_good_rate: c,
      last_known_good_at: nowIso,
      ...(row.pending_effective_rate !== null ? PENDING_CLEARED : {}),
    },
    logs,
    { effectiveAfter: c, effectiveChanged: true, ownerVisible: true }
  );
}

/**
 * decide(), but ONE PAIR'S PROBLEM NEVER COSTS ANOTHER ITS UPDATE (critique
 * H1): a decision that throws — an arithmetic refusal no validation caught —
 * becomes a recorded INVALID / FX_DECIDE_FAILED for that pair alone (fetch
 * health, failing_since, a log row, the lease released), instead of aborting
 * the whole run unrecorded with every claimed pair's lease left held (FX-1
 * review: security #1, correctness C6). Only the error's NAME is logged.
 */
export function decideSafely(row: FxPairRow, outcome: PairOutcome, ctx: DecisionContext, clock: FxClock, trigger: FxTrigger): FxDecision {
  try {
    return decide(row, outcome, ctx, clock, trigger);
  } catch (e) {
    console.error('fx: decision failed:', row.pair, e instanceof Error ? e.name : 'unknown');
    return decide(row, { kind: 'invalid', code: 'FX_DECIDE_FAILED' }, ctx, clock, trigger);
  }
}

export const PENDING_CLEARED: PairSet = {
  pending_market_rate: null,
  pending_effective_rate: null,
  pending_published_at: null,
  pending_observed_at: null,
  pending_reason: null,
  pending_notified_at: null,
};

/**
 * The age and future checks of a validated-for-shape quote (§6): more than 5
 * minutes ahead (IQWealth) or a day after today (ECB) → INVALID FX_FUTURE;
 * older than the pair's `max_age_hours` (72 h / 7 days) → STALE FX_TOO_OLD.
 */
export function validityProblem(
  row: Pick<FxPairRow, 'pair' | 'max_age_hours'>,
  quote: { publishedAtMs: number },
  nowMs: number
): { result: 'INVALID' | 'STALE'; code: string } | null {
  if (isEcb(row.pair)) {
    const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
    if (quote.publishedAtMs > today) return { result: 'INVALID', code: 'FX_FUTURE' };
  } else if (quote.publishedAtMs > nowMs + FUTURE_TOLERANCE_MS) {
    return { result: 'INVALID', code: 'FX_FUTURE' };
  }
  if (nowMs - quote.publishedAtMs > row.max_age_hours * HOUR_MS) return { result: 'STALE', code: 'FX_TOO_OLD' };
  return null;
}
