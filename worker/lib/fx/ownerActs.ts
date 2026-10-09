/**
 * THE OWNER'S RATE ACTS — validation and planning (FX programme plan §5.2
 * "Owner acts", §7.8, §8). The routes are in worker/routes/adminPricing.ts;
 * every act here returns pair changes for the same planner the scheduler uses
 * (commit.ts), fenced on the pair's `owner_version` (critique L3) — a routine
 * check never moves it, so an open panel does not answer 409 after every
 * tick — and, whenever an effective rate moves, on all three pairs'
 * `effective_version` (critiques F2, M1). An owner write always clears the
 * lease, so it wins over a fetch in flight (that fetch's commit misses its
 * fence and is recorded SUPERSEDED).
 *
 *   manual set     mode MANUAL, manual = effective = v, the drift anchor = v
 *   adjustment     USD/IQD `market_adjustment_iqd`: a FIXED number of dinars
 *                  per dollar, never a percentage (owner decision 5: market
 *                  1,660 + 20 = 1,680). The effective rate moves by the
 *                  change of the adjustment (never onto a market figure held
 *                  for review),
 *                  the anchor moves with it, a pending candidate is re-based
 *                  to its own market figure + the new adjustment
 *   approve        USD/IQD: pending MARKET + the CURRENT adjustment
 *                  (critique M4.3); refused 409 FX_REVIEW_STALE when the
 *                  candidate was observed more than 24 h (USD) / 72 h (ECB) ago
 *   reject         the candidate is remembered for 24 hours (M4.2)
 *   keep manual    mode MANUAL at the current effective rate; its mode_change
 *                  row says old → new like a settings mode change
 *   confirm        «تأكيد السعر الحالي»: the anchor = the effective rate
 *   settings       thresholds, dead band, bounds, mode, interval; the
 *                  settings_change row keeps every changed field as
 *                  {field, before, after} (owner decision 10: the history
 *                  shows old → new)
 *
 * BODIES are allow-lists: an extra key is 400 UNKNOWN_FIELD; a bad value is
 * PRICING_INPUT_INVALID naming the field, never echoing the value. Decimals
 * are canonical text; Arabic-Indic and Extended digits are read as digits.
 */
import { addProcurementExact, parseProcurementDecimal, procurementExact, procurementExactText } from '@levonis/contracts/procurementCost';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { changePpm, ratioExceedsPct, sameRate, sumOfMoves, usdIqdCandidate, withinBounds } from '@levonis/pricing/fxChain';
import { HttpError } from '../http';
import { inputInvalid } from '../pricingEngine/whatIf';
import { FX_PAIRS, HOUR_MS, isFxPair, iso, type FxPairId, type FxPairRow } from './pairs';
import { PENDING_CLEARED, USD_IQD_SANITY, adjustmentOf, type FxAttention, type FxLogDraft, type PairSet } from './decide';
import type { PairChange } from './commit';

/** The MVP's large-change line (G17): an act, or the owner's acts of the last 24 hours, above 15% (§7.8). */
export const LARGE_CHANGE_PCT = '15';
/** How old a held candidate may be when it is approved (critique F15). */
export const REVIEW_MAX_AGE_MS: Readonly<Record<FxPairId, number>> = { USD_IQD: 24 * HOUR_MS, EUR_USD: 72 * HOUR_MS, CNY_USD: 72 * HOUR_MS };
/** Most decimals a rate of each pair may carry (plan §3). */
const RATE_PLACES: Readonly<Record<FxPairId, number>> = { USD_IQD: 4, EUR_USD: 6, CNY_USD: 10 };

export const fxRefusal = (status: number, code: Parameters<typeof serverMessage>[0], details?: Record<string, unknown>) =>
  new HttpError(status, serverMessage(code), code, details);

// ------------------------------------------------------------- input

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An extra key is refused by name (mass assignment, §14.1(4)) — `__proto__` and `constructor` included. */
export function strictBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = isRecord(raw) ? raw : {};
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpError(400, serverMessage('UNKNOWN_FIELD'), 'UNKNOWN_FIELD', { fields: extra.sort() });
  return body;
}

/** Arabic-Indic (٠-٩) and Extended (۰-۹) digits → ASCII; nothing else is touched. */
export const asciiDigits = (s: string): string =>
  s.replace(/[٠-٩۰-۹]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String((c >= 0x06f0 ? c - 0x06f0 : c - 0x0660) % 10);
  });

/** A positive canonical decimal (text only; never a JSON float). */
export function positiveDecimal(raw: unknown, field: string, maxInt: number, maxFraction: number): string {
  if (typeof raw !== 'string') throw inputInvalid(field);
  try {
    return parseProcurementDecimal(asciiDigits(raw), { maxIntDigits: maxInt, maxFractionDigits: maxFraction, min: 'positive' });
  } catch {
    throw inputInvalid(field);
  }
}

function signedDecimal(raw: unknown, field: string, maxInt: number, maxFraction: number): string {
  if (typeof raw !== 'string') throw inputInvalid(field);
  try {
    return parseProcurementDecimal(asciiDigits(raw), { signed: true, maxIntDigits: maxInt, maxFractionDigits: maxFraction });
  } catch {
    throw inputInvalid(field);
  }
}

/** A percentage threshold: '0' allowed only where `zero` says so. */
function pct(raw: unknown, field: string, max: number, zero: boolean): string {
  if (typeof raw !== 'string') throw inputInvalid(field);
  let text: string;
  try {
    text = parseProcurementDecimal(asciiDigits(raw), { maxIntDigits: 2, maxFractionDigits: 3, min: zero ? 'nonnegative' : 'positive' });
  } catch {
    throw inputInvalid(field);
  }
  if (Number(text) > max || text.length > 6) throw inputInvalid(field);
  return text;
}

export function ownerVersionOf(raw: unknown, field = 'owner_version'): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1) throw inputInvalid(field);
  return raw;
}

function optionalBool(raw: unknown, field: string): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') throw inputInvalid(field);
  return raw;
}

/** `preview_hash` is accepted (FX-5 makes it required once a product is engine-priced) and never stored. */
function previewHash(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'string' || raw.length > 128 || !/^[A-Za-z0-9_-]*$/.test(raw)) throw inputInvalid('preview_hash');
}

export function pairParam(raw: string | undefined): FxPairId {
  if (!isFxPair(raw)) throw inputInvalid('pair');
  return raw;
}

/** The rate of a pair, as typed: positive, at most its decimals, within its bounds (and USD/IQD within 500–10,000). */
export function rateFor(row: FxPairRow, raw: unknown, field: string): string {
  const v = positiveDecimal(raw, field, 6, RATE_PLACES[row.pair]);
  assertInBounds(row, v);
  return v;
}

function assertInBounds(row: Pick<FxPairRow, 'pair' | 'bound_min' | 'bound_max'>, v: string): void {
  const ok = withinBounds(v, row.bound_min, row.bound_max) && (row.pair !== 'USD_IQD' || withinBounds(v, USD_IQD_SANITY.min, USD_IQD_SANITY.max));
  if (!ok) throw fxRefusal(400, 'FX_RATE_OUT_OF_BOUNDS');
}

// ------------------------------------------------------------- the 24-hour owner budget (§7.8, critique F3)

export interface LargeChange {
  /** This act alone moves the effective rate by more than 15%. */
  act: boolean;
  /** The owner's acts of the last 24 hours already moved USD/IQD by more than 15% in total. */
  cumulative: boolean;
}

/**
 * The owner's acts on USD/IQD in the last 24 hours — the earlier ones from the
 * private log (`idx_fx_rate_log_owner`) PLUS THE ACT BEING MADE — compared
 * with 15% (§7.8: "the sum of |change| … over the owner's acts in the last 24
 * hours … is compared with large_change_pct"). Summing only the earlier acts
 * let two acts of 14% move the rate 30% in an hour with neither the
 * confirmation nor a fresh sign-in (FX-1 correctness review C3); with the act
 * included, a stolen session moves the rate at most 15% in a day. Shipping
 * rates and the ECB pairs are held to the per-act rule only: their history
 * carries no value outside FX-2's pricing_audit.
 */
export async function largeChange(db: D1Database, pair: FxPairId, before: string | null, after: string | null, now: Date): Promise<LargeChange> {
  const moving = before !== null && after !== null && !sameRate(before, after);
  const act = moving && ratioExceedsPct(sumOfMoves([{ before: before!, after: after! }]), LARGE_CHANGE_PCT);
  if (pair !== 'USD_IQD' || !moving) return { act, cumulative: false };
  const { results } = await db
    .prepare(
      `SELECT effective_before, effective_after FROM fx_rate_log
        WHERE trigger_kind = 'owner' AND created_at >= ? AND pair = 'USD_IQD'
          AND event IN ('manual_set', 'settings_change', 'review_approved')
          AND effective_before IS NOT NULL AND effective_after IS NOT NULL`
    )
    .bind(iso(now.getTime() - 24 * HOUR_MS))
    .all<{ effective_before: string; effective_after: string }>();
  const moves = (results ?? []).filter((r) => !sameRate(r.effective_before, r.effective_after)).map((r) => ({ before: r.effective_before, after: r.effective_after }));
  return { act, cumulative: moves.length > 0 && ratioExceedsPct(sumOfMoves([...moves, { before: before!, after: after! }]), LARGE_CHANGE_PCT) };
}

// ------------------------------------------------------------- planning helpers

interface ActContext {
  actor: string;
  now: Date;
}

const ownerLog = (row: FxPairRow, partial: Partial<FxLogDraft> & Pick<FxLogDraft, 'event' | 'result'>): FxLogDraft => ({
  trigger_kind: 'owner',
  provider: 'owner',
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
});

/** The columns that move the effective rate to `v` — only when its VALUE changes (the version trigger, §31). */
function effectiveTo(row: FxPairRow, v: string, ctx: ActContext, source: 'manual' | 'review_approved' | 'provider'): PairSet {
  if (row.effective_rate !== null && sameRate(row.effective_rate, v)) return { effective_source: source };
  return {
    effective_rate: v,
    effective_version: row.effective_version + 1,
    effective_source: source,
    effective_applied_at: iso(ctx.now),
    effective_applied_by: ctx.actor,
  };
}

const anchorTo = (v: string, ctx: ActContext): PairSet => ({ drift_anchor_rate: v, drift_anchor_at: iso(ctx.now) });

/** `rate + (newAdj − oldAdj)`, exact; refused (out of bounds) when it would not stay positive. */
function shiftedBy(rate: string, oldAdj: string, newAdj: string): string {
  const v = addProcurementExact(procurementExact(rate), procurementExact(newAdj, { signed: true }), negate(procurementExact(oldAdj, { signed: true })));
  if (v.num <= 0n) throw fxRefusal(400, 'FX_RATE_OUT_OF_BOUNDS');
  return procurementExactText(v);
}
const negate = (x: { num: bigint; den: bigint }) => ({ num: -x.num, den: x.den });

export interface PlannedAct {
  changes: PairChange[];
  attention: FxAttention[];
  /** The effective USD/IQD before and after, when this act moves it (the large-change rule). */
  move: { before: string | null; after: string | null } | null;
  /** The act changes a guard setting, the mode or the interval: a fresh sign-in, always (§7.8). */
  guard: boolean;
  /** After the commit, return this pair to automatic through the scheduler (§28). */
  backToAuto: boolean;
}

const act = (row: FxPairRow, set: PairSet, logs: FxLogDraft[], audit: PairChange['audit'], extra: Partial<PlannedAct> = {}): PlannedAct => ({
  changes: [{ pair: row.pair, row, set, ownerVisible: true, logs, audit }],
  attention: [],
  move: null,
  guard: false,
  backToAuto: false,
  ...extra,
});

/** Shared between the act and the version check: the owner's view must be the current one. */
export function assertOwnerVersion(row: FxPairRow, version: number): void {
  if (row.owner_version !== version) throw fxRefusal(409, 'PRICING_CHANGED');
}

// ------------------------------------------------------------- the acts

export const MANUAL_KEYS = ['owner_version', 'rate', 'preview_hash', 'confirm_large_change'] as const;

export function planManualSet(row: FxPairRow, raw: unknown, ctx: ActContext): PlannedAct & { confirm: boolean } {
  const b = strictBody(raw, MANUAL_KEYS);
  assertOwnerVersion(row, ownerVersionOf(b.owner_version));
  previewHash(b.preview_hash);
  const confirm = optionalBool(b.confirm_large_change, 'confirm_large_change');
  const v = rateFor(row, b.rate, 'rate');
  const set: PairSet = { mode: 'MANUAL', manual_rate: v, ...effectiveTo(row, v, ctx, 'manual'), ...anchorTo(v, ctx), ...PENDING_CLEARED };
  const changed = row.effective_rate === null || !sameRate(row.effective_rate, v);
  return {
    ...act(
      row,
      set,
      // A manual rate is final: its row carries no adjustment (FX-1A review #4).
      [ownerLog(row, { event: 'manual_set', result: 'APPLIED', effective_after: v, change_ppm: row.effective_rate && changed ? changePpm(row.effective_rate, v) : null, market_adjustment_iqd: null })],
      { action: 'fx.manual.set', target: row.pair, detail: { pair: row.pair } },
      { move: { before: row.effective_rate, after: v } }
    ),
    confirm,
  };
}

export const CONFIRM_KEYS = ['owner_version'] as const;

export function planConfirm(row: FxPairRow, raw: unknown, ctx: ActContext): PlannedAct {
  const b = strictBody(raw, CONFIRM_KEYS);
  assertOwnerVersion(row, ownerVersionOf(b.owner_version));
  if (row.effective_rate === null) throw fxRefusal(409, 'FX_RATE_NOT_SET');
  return act(row, anchorTo(row.effective_rate, ctx), [ownerLog(row, { event: 'anchor_confirmed', result: 'APPLIED' })], {
    action: 'fx.anchor.confirm',
    target: row.pair,
    detail: { pair: row.pair },
  }, {
    guard: true,
    attention: [{ pair: row.pair, kind: 'guard_change', key: `fx:${row.pair}:guard:${iso(ctx.now)}` }],
  });
}

export const REVIEW_KEYS = ['owner_version', 'decision', 'preview_hash', 'confirm_large_change'] as const;

export function planReview(row: FxPairRow, raw: unknown, ctx: ActContext): PlannedAct & { confirm: boolean; decision: 'approve' | 'reject' | 'keep_manual' } {
  const b = strictBody(raw, REVIEW_KEYS);
  assertOwnerVersion(row, ownerVersionOf(b.owner_version));
  previewHash(b.preview_hash);
  const confirm = optionalBool(b.confirm_large_change, 'confirm_large_change');
  const decision = b.decision;
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'keep_manual') throw inputInvalid('decision');
  if (row.pending_effective_rate === null) throw fxRefusal(409, 'FX_REVIEW_NOT_PENDING');
  const pending = row.pending_effective_rate;
  if (decision === 'reject') {
    return {
      ...act(
        row,
        { ...PENDING_CLEARED, rejected_rate: pending, rejected_at: iso(ctx.now) },
        [ownerLog(row, { event: 'review_rejected', result: 'REJECTED', pending_rate: pending })],
        { action: 'fx.review.reject', target: row.pair, detail: { pair: row.pair } }
      ),
      confirm,
      decision,
    };
  }
  if (decision === 'keep_manual') {
    if (row.effective_rate === null) throw fxRefusal(409, 'FX_RATE_NOT_SET');
    const a = row.effective_rate;
    // A MODE CHANGE, whichever door it comes through: §7.8 puts `mode` among
    // the settings that always need a fresh sign-in, and `PUT /settings
    // {mode:'MANUAL'}` asks for one — so this does too, and rings the same
    // guard-change notice (FX-1 security review #2).
    return {
      ...act(
        row,
        { mode: 'MANUAL', manual_rate: a, ...anchorTo(a, ctx), ...PENDING_CLEARED },
        // Old → new like every mode change (owner decision 10; FX-1A review #3); the rate is manual from here, so no adjustment.
        [
          ownerLog(row, {
            event: 'mode_change',
            result: 'MANUAL',
            pending_rate: pending,
            market_adjustment_iqd: null,
            settings_diff: JSON.stringify([{ field: 'mode', before: row.mode, after: 'MANUAL' } satisfies SettingsDiffEntry]),
          }),
        ],
        { action: 'fx.review.keep_manual', target: row.pair, detail: { pair: row.pair } },
        { guard: true, attention: [{ pair: row.pair, kind: 'guard_change', key: `fx:${row.pair}:guard:${iso(ctx.now)}` }] }
      ),
      confirm,
      decision,
    };
  }
  // approve
  const observed = row.pending_observed_at ? Date.parse(row.pending_observed_at) : NaN;
  if (!Number.isFinite(observed) || ctx.now.getTime() - observed > REVIEW_MAX_AGE_MS[row.pair]) throw fxRefusal(409, 'FX_REVIEW_STALE');
  // M4.3: USD/IQD applies the pending MARKET figure plus the adjustment in force NOW.
  const v = row.pair === 'USD_IQD' && row.pending_market_rate !== null ? usdIqdCandidate(row.pending_market_rate, row.market_adjustment_iqd) : pending;
  assertInBounds(row, v);
  const nowIso = iso(ctx.now);
  return {
    ...act(
      row,
      {
        ...effectiveTo(row, v, ctx, 'review_approved'),
        last_known_good_rate: v,
        last_known_good_at: nowIso,
        ...anchorTo(v, ctx),
        ...PENDING_CLEARED,
      },
      [
        ownerLog(row, {
          event: 'review_approved',
          result: 'APPLIED',
          effective_after: v,
          pending_rate: pending,
          change_ppm: row.effective_rate ? changePpm(row.effective_rate, v) : null,
        }),
      ],
      { action: 'fx.review.approve', target: row.pair, detail: { pair: row.pair } },
      { move: { before: row.effective_rate, after: v } }
    ),
    confirm,
    decision,
  };
}

export const SETTINGS_KEYS = [
  'owner_version',
  'mode',
  'interval_hours',
  'market_adjustment_iqd',
  'anomaly_threshold_pct',
  'drift_threshold_pct',
  'min_change_pct',
  'bound_min',
  'bound_max',
  'preview_hash',
  'confirm_large_change',
] as const;
const GUARD_FIELDS = ['mode', 'interval_hours', 'anomaly_threshold_pct', 'drift_threshold_pct', 'min_change_pct', 'bound_min', 'bound_max'] as const;
/** The fields a settings_change row's diff may name, in the order it lists them. */
export const SETTINGS_DIFF_FIELDS = [
  'mode',
  'interval_hours',
  'market_adjustment_iqd',
  'anomaly_threshold_pct',
  'drift_threshold_pct',
  'min_change_pct',
  'bound_min',
  'bound_max',
] as const;
export type SettingsDiffField = (typeof SETTINGS_DIFF_FIELDS)[number];
export interface SettingsDiffEntry {
  field: SettingsDiffField;
  before: string;
  after: string;
}

export function planSettings(row: FxPairRow, raw: unknown, ctx: ActContext): (PlannedAct & { confirm: boolean; fields: string[] }) | null {
  const b = strictBody(raw, SETTINGS_KEYS);
  assertOwnerVersion(row, ownerVersionOf(b.owner_version));
  previewHash(b.preview_hash);
  const confirm = optionalBool(b.confirm_large_change, 'confirm_large_change');
  const usd = row.pair === 'USD_IQD';
  const set: PairSet = {};
  const fields: string[] = [];
  const logs: FxLogDraft[] = [];

  // ---- mode and interval
  let mode = row.mode;
  if (b.mode !== undefined) {
    if (b.mode !== 'AUTO' && b.mode !== 'MANUAL') throw inputInvalid('mode');
    mode = b.mode;
  }
  if (b.interval_hours !== undefined) {
    if (!usd || (b.interval_hours !== 6 && b.interval_hours !== 12)) throw inputInvalid('interval_hours');
    if (mode === 'MANUAL') throw fxRefusal(409, 'FX_PAIR_MANUAL');
    if (b.interval_hours !== row.interval_hours) {
      set.interval_hours = b.interval_hours;
      fields.push('interval_hours');
    }
  }

  // ---- thresholds and bounds: the merged values hold the row's CHECKs
  const anomaly = b.anomaly_threshold_pct !== undefined ? pct(b.anomaly_threshold_pct, 'anomaly_threshold_pct', 50, false) : row.anomaly_threshold_pct;
  const drift = b.drift_threshold_pct !== undefined ? pct(b.drift_threshold_pct, 'drift_threshold_pct', 25, false) : row.drift_threshold_pct;
  const dead = b.min_change_pct !== undefined ? pct(b.min_change_pct, 'min_change_pct', 5, true) : row.min_change_pct;
  if (Number(dead) >= Number(anomaly)) throw inputInvalid(b.min_change_pct !== undefined ? 'min_change_pct' : 'anomaly_threshold_pct');
  if (Number(drift) < Number(anomaly)) throw inputInvalid(b.drift_threshold_pct !== undefined ? 'drift_threshold_pct' : 'anomaly_threshold_pct');
  for (const [k, v, old] of [
    ['anomaly_threshold_pct', anomaly, row.anomaly_threshold_pct],
    ['drift_threshold_pct', drift, row.drift_threshold_pct],
    ['min_change_pct', dead, row.min_change_pct],
  ] as const) {
    if (v !== old) {
      set[k] = v;
      fields.push(k);
    }
  }
  const boundMin = b.bound_min !== undefined ? positiveDecimal(b.bound_min, 'bound_min', 6, RATE_PLACES[row.pair]) : row.bound_min;
  const boundMax = b.bound_max !== undefined ? positiveDecimal(b.bound_max, 'bound_max', 6, RATE_PLACES[row.pair]) : row.bound_max;
  if (!(Number(boundMin) < Number(boundMax))) throw inputInvalid(b.bound_min !== undefined ? 'bound_min' : 'bound_max');
  if (boundMin !== row.bound_min) {
    set.bound_min = boundMin;
    fields.push('bound_min');
  }
  if (boundMax !== row.bound_max) {
    set.bound_max = boundMax;
    fields.push('bound_max');
  }

  // ---- the adjustment (USD/IQD only): a FIXED number of dinars per dollar,
  // signed, never a percentage (owner decision 5) — '0.5%' or '2e1' is 400
  // PRICING_INPUT_INVALID naming the field.
  let effective = row.effective_rate;
  let pendingEffective = row.pending_effective_rate;
  let adjustmentAfter = row.market_adjustment_iqd;
  if (b.market_adjustment_iqd !== undefined) {
    if (!usd) throw inputInvalid('market_adjustment_iqd');
    const adj = signedDecimal(b.market_adjustment_iqd, 'market_adjustment_iqd', 5, 4);
    if (adj !== row.market_adjustment_iqd) {
      const bounds = { pair: row.pair, bound_min: boundMin, bound_max: boundMax };
      // THE CANDIDATE STAYS A PLAUSIBLE RATE, in every mode and before the
      // first approval too (FX-1 review: security #1, correctness C6 — a −2000
      // typed for −20 was stored, then every scheduler run threw on a
      // negative candidate). With a validated market figure, market + the
      // new adjustment must lie within the bounds; with none yet, the
      // adjustment must stay above −bound_min, so no market the bounds accept
      // can give a rate of zero or below.
      if (row.market_rate !== null) assertInBounds(bounds, usdIqdCandidate(row.market_rate, adj));
      else if (addProcurementExact(procurementExact(boundMin), procurementExact(adj, { signed: true })).num <= 0n) throw fxRefusal(400, 'FX_RATE_OUT_OF_BOUNDS');
      set.market_adjustment_iqd = adj;
      adjustmentAfter = adj;
      fields.push('market_adjustment_iqd');
      // The effective rate moves BY the change of the adjustment: effective + (new − old).
      // Not «latest market + new adjustment»: the latest validated market figure
      // may be a candidate held for review, and an adjustment must never apply
      // a jump the guard is holding (that would walk around §30).
      if (row.mode === 'AUTO' && mode === 'AUTO' && row.effective_rate !== null) {
        effective = shiftedBy(row.effective_rate, row.market_adjustment_iqd, adj);
        assertInBounds(bounds, effective);
        // THE ANCHOR MOVES BY THE SAME CHANGE, AND KEEPS ITS TIME: the drift
        // guard keeps measuring the MARKET's move since the owner's last
        // confirmation. Setting it to the new effective rate (as before) made
        // two adjustment saves (+0.0001, then back) do what «تأكيد السعر
        // الحالي» does — re-base the drift guard — without the fresh sign-in
        // that act always needs (FX-1 security review #2).
        const anchor = row.drift_anchor_rate !== null ? shiftedBy(row.drift_anchor_rate, row.market_adjustment_iqd, adj) : effective;
        Object.assign(set, effectiveTo(row, effective, ctx, row.effective_source ?? 'provider'), {
          drift_anchor_rate: anchor,
          ...(row.drift_anchor_at === null ? { drift_anchor_at: iso(ctx.now) } : {}),
        });
      }
      if (row.pending_effective_rate !== null && row.pending_market_rate !== null) {
        pendingEffective = usdIqdCandidate(row.pending_market_rate, adj);
        assertInBounds({ pair: row.pair, bound_min: boundMin, bound_max: boundMax }, pendingEffective);
        set.pending_effective_rate = pendingEffective;
      }
    }
  }
  // The new bounds must hold the effective and the pending rate (the row CHECK would refuse it anyway).
  for (const v of [effective, pendingEffective]) {
    if (v !== null && !withinBounds(v, boundMin, boundMax)) throw fxRefusal(400, 'FX_BOUNDS_EXCLUDE_EFFECTIVE');
  }

  // ---- the mode change itself
  let backToAuto = false;
  if (mode !== row.mode) {
    fields.push('mode');
    if (mode === 'MANUAL') {
      // «إيقاف»: the effective rate becomes the manual one, so prices stay where they are.
      if (effective === null) throw fxRefusal(409, 'FX_RATE_NOT_SET');
      Object.assign(set, { mode: 'MANUAL', manual_rate: effective, ...anchorTo(effective, ctx), ...PENDING_CLEARED });
    } else {
      Object.assign(set, { mode: 'AUTO', manual_rate: null });
      backToAuto = true;
    }
  }
  if (fields.length === 0) return null;
  // THE HISTORY SAYS OLD → NEW (owner decision 10): every changed field, as
  // the exact text before and after, on the act's own row of the private log.
  const before: Record<SettingsDiffField, string> = {
    mode: row.mode,
    interval_hours: String(row.interval_hours),
    market_adjustment_iqd: row.market_adjustment_iqd,
    anomaly_threshold_pct: row.anomaly_threshold_pct,
    drift_threshold_pct: row.drift_threshold_pct,
    min_change_pct: row.min_change_pct,
    bound_min: row.bound_min,
    bound_max: row.bound_max,
  };
  const after: Record<SettingsDiffField, string> = {
    mode,
    interval_hours: String(set.interval_hours ?? row.interval_hours),
    market_adjustment_iqd: adjustmentAfter,
    anomaly_threshold_pct: anomaly,
    drift_threshold_pct: drift,
    min_change_pct: dead,
    bound_min: boundMin,
    bound_max: boundMax,
  };
  const diff = (only?: SettingsDiffField): string =>
    JSON.stringify(
      SETTINGS_DIFF_FIELDS.filter((f) => (only ? f === only : fields.includes(f))).map((f): SettingsDiffEntry => ({ field: f, before: before[f], after: after[f] }))
    );
  const settingsRow = fields.some((f) => f !== 'mode');
  if (settingsRow) {
    logs.push(
      ownerLog(row, {
        event: 'settings_change',
        result: 'APPLIED',
        effective_after: effective,
        change_ppm: row.effective_rate && effective && !sameRate(row.effective_rate, effective) ? changePpm(row.effective_rate, effective) : null,
        // The adjustment the rate in force carries: none on a manual rate, before or after this act (FX-1A review #4).
        market_adjustment_iqd: usd && row.mode === 'AUTO' && mode === 'AUTO' ? adjustmentAfter : null,
        settings_diff: diff(),
      })
    );
  }
  if (mode !== row.mode) {
    // A mode-only act carries its own old → new; beside a settings_change row the mode is already in that row's diff.
    logs.push(
      ownerLog(row, {
        event: 'mode_change',
        result: mode,
        effective_after: effective,
        // Either side of a mode change is a manual rate: no adjustment in it.
        market_adjustment_iqd: null,
        settings_diff: settingsRow ? null : diff('mode'),
      })
    );
  }
  const guard = fields.some((f) => (GUARD_FIELDS as readonly string[]).includes(f));
  return {
    ...act(row, set, logs, { action: 'fx.settings.update', target: row.pair, detail: { pair: row.pair, fields: [...fields].sort() } }, {
      guard,
      backToAuto,
      move: effective !== row.effective_rate ? { before: row.effective_rate, after: effective } : null,
      attention: guard ? [{ pair: row.pair, kind: 'guard_change', key: `fx:${row.pair}:guard:${iso(ctx.now)}` }] : [],
    }),
    confirm,
    fields: [...fields].sort(),
  };
}

export const REFRESH_KEYS = ['pairs'] as const;

export function parseRefresh(raw: unknown): FxPairId[] {
  const b = strictBody(raw, REFRESH_KEYS);
  if (b.pairs === undefined || b.pairs === null) return [...FX_PAIRS];
  if (!Array.isArray(b.pairs) || b.pairs.length === 0 || b.pairs.length > 3 || !b.pairs.every(isFxPair)) throw inputInvalid('pairs');
  return [...new Set(b.pairs as FxPairId[])];
}

export const SHIPPING_KEYS = ['version', 'rate_iqd', 'preview_hash', 'confirm_large_change'] as const;
export const SHIPPING_PROFILES = ['GERMANY_LAND', 'CHINA_AIR', 'CHINA_SEA'] as const;
export type ShippingProfileId = (typeof SHIPPING_PROFILES)[number];

export function parseShipping(profileRaw: string | undefined, raw: unknown): { profile: ShippingProfileId; version: number; rate: string; confirm: boolean } {
  if (!(SHIPPING_PROFILES as readonly string[]).includes(profileRaw ?? '')) throw inputInvalid('profile');
  const b = strictBody(raw, SHIPPING_KEYS);
  const version = ownerVersionOf(b.version, 'version');
  previewHash(b.preview_hash);
  const confirm = optionalBool(b.confirm_large_change, 'confirm_large_change');
  // IQD per kg or per CBM, decimal text > 0 — never multiplied by any exchange rate (§21).
  const rate = positiveDecimal(b.rate_iqd, 'rate_iqd', 9, 6);
  if (rate.length > 20) throw inputInvalid('rate_iqd');
  return { profile: profileRaw as ShippingProfileId, version, rate, confirm };
}
