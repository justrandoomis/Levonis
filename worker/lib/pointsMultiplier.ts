/**
 * THE SUBSCRIPTION REWARD MULTIPLIER — one policy, two evaluators that are
 * proven equal by test.
 *
 * «لاشتراك البريميوم يحصل المستخدم على 1.5x من النقاط والمستخدم البرو يحصل على
 * 2x أي ضعف النقاط من حيث التسجيل الدخول وربح النقاط وأثناء الشراء والتقييمات»
 *
 *   PREMIUM (tier id `prime`)  ×1.5
 *   PRO                        ×2
 *   everyone else              ×1
 *
 * WHO IS PRO IS NOT DECIDED HERE. The tier, its expiry and the admin
 * restriction cases that pause a benefit all come from worker/lib/
 * entitlements.ts — `getTierStatus` + `dailyRewardMultiplierX100`, the
 * entitlement lookup this codebase already has. This module adds no second
 * membership table, no second tier ladder and no second restriction list. It
 * adds exactly two things:
 *
 *   1. `applyMultiplierX100` — the ROUNDING decision, in one place.
 *   2. `multiplierSql` — the same answer as a SQL scalar, for the awards that
 *      must be written INSIDE a batch that is already open (a checkout, a
 *      claim) where an await is not available and, more importantly, where
 *      reading the tier before the batch would leave a window in which the
 *      membership could change between the read and the write.
 *
 * (2) reads the very tables (1) reads — `memberships` and `restriction_cases`
 * — at the instant the transaction commits. It is a second EVALUATOR, not a
 * second source of truth, and `tests/pointsIntegrity.test.ts` runs both over
 * every combination of tier × state × expiry × restriction flag against a real
 * database and fails if they ever disagree. That test is the contract; if you
 * change the ladder in entitlements.ts, that test will tell you to change the
 * SQL too.
 *
 * ---------------------------------------------------------------- ROUNDING
 *
 * 1.5 × a 5-point check-in is 7.5. THE DECISION IS ROUND HALF UP: 8.
 *
 * Why not floor. The multiplier is a promise printed on the subscription
 * page. Under floor the error is never zero-mean: a half point is lost on
 * EVERY odd base at ×1.5 and the loss always goes to the shop, so a PREMIUM
 * member who earns many small awards is quietly paid less than the 1.5 they
 * bought — 5→7 is ×1.4, and it is ×1.4 again tomorrow. That is the kind of
 * silent, one-directional shortfall a customer eventually notices and support
 * cannot explain.
 *
 * Why not bankers'. Round-half-to-even makes the answer depend on the parity
 * of the base (5→8 but 15→22, both ×1.5), which is indefensible at a support
 * desk and impossible for a customer to predict.
 *
 * Why half up is affordable. It costs the shop at most one point — one IQD,
 * since §4.4 redeems a point for exactly 1 IQD — per award, and only when the
 * base is odd and the tier is PREMIUM. ×2 and ×1 never round at all.
 *
 * The arithmetic is integer-only — `(base × x100 + 50) / 100` with a floor —
 * so it is exact, has no float drift, and is reproducible verbatim in SQLite,
 * whose integer division on two positive integers is that same floor. A
 * replayed computation cannot produce a different number.
 */

import type { TierStatus } from './entitlements';
import { dailyRewardMultiplierX100 } from './entitlements';

/** The only multipliers the ladder can produce. */
export const MULTIPLIER_X100 = { none: 100, premium: 150, pro: 200 } as const;

/**
 * The multiplier for a resolved tier status. A thin, deliberate alias for the
 * entitlements-module function so that every points surface imports the
 * multiplier from the points library while the ANSWER still comes from the one
 * membership authority.
 */
export function rewardMultiplierX100(status: TierStatus): number {
  return dailyRewardMultiplierX100(status);
}

/**
 * base × multiplier, ROUNDED HALF UP, in integer arithmetic. Clamped: a
 * multiplier below 1× can never reduce an award (a corrupt or missing value
 * degrades to 1×, never to a smaller payout), and a negative base is 0.
 */
export function applyMultiplierX100(basePoints: number, multiplierX100: number): number {
  const base = Math.max(0, Math.trunc(Number(basePoints) || 0));
  const mult = Math.max(100, Math.trunc(Number(multiplierX100) || 100));
  return Math.floor((base * mult + 50) / 100);
}

/** '1x' | '1.5x' | '2x' — what the customer is shown, derived, never stored as text. */
export function multiplierLabel(multiplierX100: number): string {
  const mult = Math.max(100, Math.trunc(Number(multiplierX100) || 100));
  const whole = Math.trunc(mult / 100);
  const frac = mult % 100;
  return frac === 0 ? `${whole}x` : `${whole}.${String(frac).padStart(2, '0').replace(/0+$/, '')}x`;
}

/**
 * The tier id whose multiplier applies, as a SQL scalar. Mirrors
 * `getTierStatus`'s precedence (PRO > PREMIUM > PLUS) and its expiry filter.
 * Note it does NOT perform getTierStatus's lazy `state='expired'` write: it
 * filters on the expiry itself, so a membership that is overdue but not yet
 * lazily marked still yields the correct (lower) multiplier.
 */
function tierSql(user: string, now: string): string {
  return `(SELECT COALESCE(
             MAX(CASE m.tier WHEN 'pro' THEN 3 WHEN 'prime' THEN 2 WHEN 'plus' THEN 1 ELSE 0 END), 0)
             FROM memberships m
            WHERE m.user_id = ${user} AND m.state = 'active'
              AND (m.expires_at IS NULL OR m.expires_at >= ${now}))`;
}

/**
 * 1 when an ACTIVE restriction case pauses `flag` for this user. Mirrors
 * `TierStatus.gated_benefits`, which is the union of every active case's
 * benefit_flags JSON array. json_each is used rather than a LIKE so a flag
 * name that is a prefix of another can never match by accident.
 */
function gatedSql(user: string, flag: string): string {
  return `EXISTS (SELECT 1 FROM restriction_cases rc, json_each(rc.benefit_flags) f
                   WHERE rc.user_id = ${user} AND rc.state = 'active' AND f.value = '${flag}')`;
}

/**
 * The multiplier (100 / 150 / 200) as a SQL scalar expression, for use inside
 * a statement that is part of a batch that must commit atomically.
 *
 * `user` and `now` are SQL PLACEHOLDERS the caller supplies (e.g. '?2', '?7')
 * — never values. Nothing from a request is ever interpolated here; the only
 * literals in the produced SQL are the two entitlement names below, which are
 * module constants.
 *
 * The ladder is `dailyRewardMultiplierX100`'s, term for term:
 *   inactive, or `premiumRewards` paused            → 100
 *   PRO rank and `priorityService` not paused       → 200
 *   PREMIUM rank or higher                          → 150
 */
export function multiplierSql(user: string, now: string): string {
  const rank = tierSql(user, now);
  return `(SELECT CASE
             WHEN ${gatedSql(user, 'premiumRewards')} THEN 100
             WHEN r.rank >= 3 AND NOT ${gatedSql(user, 'priorityService')} THEN 200
             WHEN r.rank >= 2 THEN 150
             ELSE 100 END
           FROM (SELECT ${rank} AS rank) r)`;
}

/** The tier id that multiplier came from ('free' when no active membership). */
export function tierNameSql(user: string, now: string): string {
  return `(SELECT CASE r.rank WHEN 3 THEN 'pro' WHEN 2 THEN 'prime' WHEN 1 THEN 'plus' ELSE 'free' END
             FROM (SELECT ${tierSql(user, now)} AS rank) r)`;
}

/**
 * base × multiplier, ROUND HALF UP, as SQL — the same arithmetic as
 * `applyMultiplierX100`: SQLite integer division of two positive integers
 * truncates toward zero, which for a positive numerator is that same floor.
 *
 * THE CASTS ARE LOAD-BEARING, not decoration. `/` in SQLite is integer
 * division only when BOTH operands are integers; if either is REAL it is
 * floating-point division, and `(5 × 200 + 50) / 100` becomes 10.5 instead of
 * 10. A bound parameter's storage class comes from the driver, and drivers
 * disagree: node:sqlite binds every JavaScript number as REAL. Without these
 * casts a points column would quietly acquire a fraction, the ledger row would
 * carry it, and a balance would stop being a whole number of points.
 */
export function multipliedPointsSql(baseExpr: string, multiplierExpr: string): string {
  return `((CAST((${baseExpr}) AS INTEGER) * CAST((${multiplierExpr}) AS INTEGER)) + 50) / 100`;
}
