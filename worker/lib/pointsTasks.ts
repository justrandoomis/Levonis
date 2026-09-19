/**
 * THE MISSIONS LEDGER — what a task is worth, when it may be claimed, and the
 * statements that award it.
 *
 * «قم بربط وتأمين وحماية صفحة النقاط والمهام وربطها بقاعدة البيانات الخاصة لا
 *  يمكن لأي مستخدم التعديل اليدوي ولا استغلال النظام»
 *
 * THE FIVE RULES THIS MODULE EXISTS TO ENFORCE
 *
 * 1. THE SERVER DECIDES THE AMOUNT. Every base value below is a module
 *    constant. `worker/routes/rewards.ts` never reads a request body — not a
 *    point count, not a mission id it did not already know, not a duration and
 *    not a timestamp. A client may only say WHICH endpoint it is calling.
 *
 * 2. THE CLOCK IS THE SERVER'S. `baghdadDay()` is computed from `Date.now()`
 *    on the Worker. Elapsed time for a timed task is re-checked IN SQL, from
 *    a `started_at` the server itself wrote. A device whose date is wrong, or
 *    a request replayed with a crafted timestamp, changes nothing: there is no
 *    input for it to change.
 *
 * 3. ONE AWARD PER PERIOD, ENFORCED BY THE DATABASE. `reward_claims` already
 *    carried UNIQUE (user_id, mission, day); 0076 adds `idempotency_key`
 *    ('reward:<user>:<mission>:<period>') with its own unique index, the
 *    `inventory_ledger.idempotency_key` idiom this codebase uses everywhere
 *    else, and the POINT ledger row's id is derived from the claim id so it
 *    collides on the PRIMARY KEY as well. Three independent guards; a replay
 *    has to defeat all three, and all three are in the same transaction.
 *
 * 4. A RACE TAKES THE AWARD ONCE. Awards are written as ONE D1 batch — one
 *    transaction. The claim row and its ledger entry are inserted together or
 *    not at all, and the ledger insert is conditioned on the claim row
 *    carrying THIS run's `awarded_at` token, so a losing concurrent run writes
 *    nothing rather than a second credit.
 *
 * 5. WHAT THE SERVER CANNOT PROVE IS MARKED, NOT HIDDEN. Every mission below
 *    declares `verification`. `server_timed` means the server can show its own
 *    evidence (a `started_at` it wrote, a Baghdad day it computed).
 *    `client_asserted` means it cannot, and says so — to the owner in the
 *    settings switch, and to the customer on the page.
 */

import type { Env } from './types';
import { safeParse } from './types';
import { multipliedPointsSql, multiplierSql, tierNameSql } from './pointsMultiplier';
import { baghdadDay as baghdadDayAt } from './baghdadTime';

export type MissionId = 'checkin' | 'push' | 'video' | 'browse';

/**
 * server_timed  — the server holds the evidence: an instant IT wrote, and a
 *                 day IT computed. The customer cannot shorten it.
 * client_asserted — the server has no evidence at all; the award rests on the
 *                 browser's claim that something happened.
 */
export type Verification = 'server_timed' | 'client_asserted';

export interface MissionSpec {
  id: MissionId;
  /** 'daily' = one per Baghdad day; 'once' = one per account, forever. */
  period: 'daily' | 'once';
  verification: Verification;
  /** Two-phase: the server issues a timed ticket before the claim is possible. */
  timed: boolean;
  /** Plain-language statement of exactly what the server can and cannot prove. */
  proof: string;
}

/** Browse mission length. Server-side constant; the client never sends it. */
export const BROWSE_REQUIRED_SECS = 180;

/**
 * Base points BEFORE the subscription multiplier. These are the shop's
 * existing values, unchanged — this work secures how they are awarded, it does
 * not re-price anything.
 */
export const MISSION_BASE_POINTS: Record<Exclude<MissionId, 'checkin'>, number> = {
  push: 50,
  video: 20,
  browse: 20,
};

export const MISSIONS: Record<MissionId, MissionSpec> = {
  checkin: {
    id: 'checkin',
    period: 'daily',
    verification: 'server_timed',
    timed: false,
    proof:
      'The server decides the Baghdad day and reads the streak out of the award history. Nothing about it comes from the device.',
  },
  push: {
    id: 'push',
    period: 'once',
    verification: 'client_asserted',
    timed: false,
    proof:
      'This database has no push-subscription table, so the server cannot check that notifications were really enabled. It is awarded once per account, ever.',
  },
  video: {
    id: 'video',
    period: 'daily',
    verification: 'client_asserted',
    timed: true,
    proof:
      'The server can prove its own ad ticket was issued and that the configured number of seconds passed before the claim. It cannot prove a person watched.',
  },
  browse: {
    id: 'browse',
    period: 'daily',
    verification: 'client_asserted',
    timed: true,
    proof:
      'The server can prove the required seconds of its own wall clock elapsed across authenticated pings. It cannot prove a person was browsing.',
  },
};

// ------------------------------------------------------------- server clock

/**
 * The Baghdad calendar day, from the SERVER clock only.
 *
 * THE ARITHMETIC NO LONGER LIVES HERE. It is `worker/lib/baghdadTime.ts`, the
 * one copy of the day boundary, so that this module and `farm/time.ts` and the
 * delivery board cannot drift apart about which day it is. Nothing else about
 * this function changed.
 *
 * THE ARGUMENT ORDER IS DELIBERATELY NOT THE LEAF'S. `baghdadTime.baghdadDay`
 * takes `(nowMs, offsetDays)`; this one keeps `(offsetDays, nowMs)` because
 * every existing caller — nine of them in `worker/routes/rewards.ts` alone —
 * is written `baghdadDay(0, nowMs)` and `baghdadDay(-1)`. Both parameters are
 * numbers, so swapping them is INVISIBLE to the type checker: `baghdadDay(0,
 * nowMs)` read in the leaf's order means "1.7 trillion days after the epoch",
 * which formats as a plausible-looking string and silently awards every
 * check-in against a day nobody will ever reach again. A re-export would have
 * been that swap. The delegation is the fix; the order stays.
 *
 * `nowMs` exists so a test can pin an instant; no request path ever passes it,
 * and nothing derived from a request can reach it.
 */
export function baghdadDay(offsetDays = 0, nowMs: number = Date.now()): string {
  return baghdadDayAt(nowMs, offsetDays);
}

/**
 * The existing check-in ladder, unchanged: 5, 5, 10, 10, 15, 15, then 20 from
 * the seventh consecutive day on. Note what this means for a "reset for
 * profit" attempt — breaking a streak sends the counter back to the CHEAPEST
 * rung, so there is no day count a customer can manufacture that pays more
 * than simply continuing. `tests/pointsIntegrity.test.ts` proves the ladder is
 * monotonic for exactly that reason.
 */
export function checkinBasePoints(streakDay: number): number {
  const day = Math.max(1, Math.trunc(Number(streakDay) || 1));
  if (day <= 2) return 5;
  if (day <= 4) return 10;
  if (day <= 6) return 15;
  return 20;
}

/** The period slot a mission occupies: the Baghdad day, or 'once' forever. */
export function missionPeriod(mission: MissionId, today: string): string {
  return MISSIONS[mission].period === 'once' ? 'once' : today;
}

/** The unique business event, in the `inventory_ledger.idempotency_key` shape. */
export function rewardIdempotencyKey(userId: string, mission: MissionId, period: string): string {
  return `reward:${userId}:${mission}:${period}`;
}

/** D1 reports a violated UNIQUE index or PRIMARY KEY in the message text. */
export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

// ------------------------------------------------------------- owner config

export interface RewardTaskConfig {
  video_enabled: boolean;
  video_min_seconds: number;
  browse_enabled: boolean;
  push_enabled: boolean;
}

export const REWARD_TASK_DEFAULTS: RewardTaskConfig = {
  video_enabled: true,
  video_min_seconds: 15,
  browse_enabled: true,
  push_enabled: true,
};

export function parseRewardTaskConfig(raw: unknown): RewardTaskConfig {
  const o = (typeof raw === 'string' ? safeParse<Record<string, unknown>>(raw, {}) : raw) as
    | Record<string, unknown>
    | null
    | undefined;
  const src = o && typeof o === 'object' ? o : {};
  const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  const secs = Number(src.video_min_seconds);
  return {
    video_enabled: bool(src.video_enabled, REWARD_TASK_DEFAULTS.video_enabled),
    // Clamped: a corrupt or absurd value can never make the wait zero (which
    // would restore the instant-claim defect) nor unreachably long.
    video_min_seconds: Number.isFinite(secs)
      ? Math.max(5, Math.min(600, Math.trunc(secs)))
      : REWARD_TASK_DEFAULTS.video_min_seconds,
    browse_enabled: bool(src.browse_enabled, REWARD_TASK_DEFAULTS.browse_enabled),
    push_enabled: bool(src.push_enabled, REWARD_TASK_DEFAULTS.push_enabled),
  };
}

/**
 * Read straight from admin_settings, for the same reason `getPointsRuleConfig`
 * does: worker/lib/settings.ts' typed defaults map is owned by another slice,
 * and this switch must not wait on a change landing there.
 */
export async function getRewardTaskConfig(env: Env): Promise<RewardTaskConfig> {
  const row = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = 'rewardTaskConfig'")
    .first<{ value: string }>();
  return parseRewardTaskConfig(row?.value);
}

export function missionEnabled(mission: MissionId, cfg: RewardTaskConfig): boolean {
  if (mission === 'video') return cfg.video_enabled;
  if (mission === 'browse') return cfg.browse_enabled;
  if (mission === 'push') return cfg.push_enabled;
  return true; // the check-in is server-timed end to end; it has no switch.
}

// ------------------------------------------------------------------ streak

export interface StreakState {
  /** The day number the NEXT check-in would pay for (1 when the streak broke). */
  nextDay: number;
  /** The day number already credited today, or null when today is unclaimed. */
  todayDay: number | null;
  /** The streak as it stands right now, for display. */
  current: number;
}

/**
 * The streak, derived from the AWARD HISTORY rather than from the mutable
 * `users.checkin_streak` cache — and never from the session snapshot the
 * request middleware loaded, which is a read from before this request began.
 *
 * Why this is race-proof: the only fact it reads is "was there an awarded
 * check-in yesterday, and for which day number". Yesterday is over; that row
 * cannot change while this request runs. Two concurrent check-ins therefore
 * compute the SAME number, and the unique index decides which one of them gets
 * to write it.
 *
 * Rows written before migration 0076 have no `streak_day`. For those the
 * `users.checkin_streak` counter is read fresh from the database and used —
 * the pre-0076 streaks are carried over rather than reset, and nothing is
 * invented for a row that never recorded one.
 */
export async function readStreak(db: D1Database, userId: string, today: string, yesterday: string): Promise<StreakState> {
  const [last, cached] = await Promise.all([
    db
      .prepare(
        `SELECT day, streak_day FROM reward_claims
          WHERE user_id = ? AND mission = 'checkin' AND state = 'awarded'
          ORDER BY day DESC LIMIT 1`
      )
      .bind(userId)
      .first<{ day: string; streak_day: number | null }>(),
    db.prepare('SELECT checkin_streak FROM users WHERE id = ?').bind(userId).first<{ checkin_streak: number }>(),
  ]);

  const fallback = Math.max(0, Math.trunc(Number(cached?.checkin_streak) || 0));
  if (!last) return { nextDay: 1, todayDay: null, current: 0 };

  const recorded = Number.isFinite(Number(last.streak_day)) && last.streak_day !== null
    ? Math.max(1, Math.trunc(Number(last.streak_day)))
    : Math.max(1, fallback);

  if (last.day === today) return { nextDay: recorded, todayDay: recorded, current: recorded };
  if (last.day === yesterday) return { nextDay: recorded + 1, todayDay: null, current: recorded };
  return { nextDay: 1, todayDay: null, current: 0 };
}

// ------------------------------------------------------- award statements

/**
 * The POINT ledger row for a claim. Built from the CLAIM ROW, inside the same
 * transaction, so the credited amount is by construction the amount the claim
 * row records, and the note cannot describe a multiplier the row did not use.
 *
 * `rc.awarded_at = ?3` is the token that makes a concurrent loser write
 * nothing: only the run whose own write stamped that instant matches.
 */
function ledgerStatement(
  db: D1Database,
  where: string,
  label: string,
  nowIso: string,
  binds: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO wallet_transactions
         (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
       SELECT rc.wallet_tx_id, rc.user_id, 'deposit', 'POINT', rc.points, 'approved',
              ?1 || CASE WHEN rc.multiplier_x100 > 100
                         THEN ' · ' || CAST(rc.base_points AS TEXT) || ' × '
                              || RTRIM(RTRIM(printf('%.2f', rc.multiplier_x100 / 100.0), '0'), '.')
                              || ' (' || UPPER(rc.tier_at_award) || ')'
                         ELSE '' END,
              rc.idempotency_key, 'system', rc.awarded_at
         FROM reward_claims rc
        WHERE ${where} AND rc.state = 'awarded' AND rc.awarded_at = ?2 AND rc.points > 0`
    )
    .bind(label, nowIso, ...binds);
}

export interface DirectAwardInput {
  claimId: string;
  userId: string;
  mission: MissionId;
  period: string;
  /** Decided by the server from the constants above. Never from a request. */
  basePoints: number;
  streakDay: number | null;
  nowIso: string;
  label: string;
}

/**
 * A task with nothing to wait for (the daily check-in, the one-time push
 * mission): claim row and ledger credit, one batch, one transaction.
 *
 * The multiplier, the tier it came from and the multiplied total are all
 * resolved BY THIS STATEMENT, from `memberships` and `restriction_cases`, at
 * the instant the transaction commits — so there is no window between reading
 * a membership and paying on it, and the number that lands on the row is the
 * number the award is made at, for ever.
 */
export function buildDirectAwardStatements(db: D1Database, i: DirectAwardInput): D1PreparedStatement[] {
  const idem = rewardIdempotencyKey(i.userId, i.mission, i.period);
  return [
    db
      .prepare(
        `INSERT INTO reward_claims
           (id, user_id, mission, day, points, base_points, multiplier_x100, tier_at_award,
            streak_day, state, required_seconds, started_at, awarded_at, idempotency_key, wallet_tx_id)
         SELECT ?1, ?2, ?3, ?4, ${multipliedPointsSql('?5', 'm.mult')}, ?5, m.mult, m.tier,
                ?6, 'awarded', 0, ?7, ?7, ?8, 'wtx_rc_' || ?1
           FROM (SELECT ${multiplierSql('?2', '?7')} AS mult, ${tierNameSql('?2', '?7')} AS tier) m`
      )
      .bind(i.claimId, i.userId, i.mission, i.period, i.basePoints, i.streakDay, i.nowIso, idem),
    ledgerStatement(db, 'rc.id = ?3', i.label, i.nowIso, [i.claimId]),
  ];
}

export interface TicketInput {
  claimId: string;
  userId: string;
  mission: MissionId;
  period: string;
  basePoints: number;
  requiredSeconds: number;
  nowIso: string;
}

/**
 * Opens a SERVER-TIMED ticket: a `state='started'` claim row carrying the
 * instant the server issued it and the seconds that must pass. It holds the
 * period's unique slot, so a customer cannot mint a second ticket to race the
 * first, and it is NOT an award — nothing reads a 'started' row as points, and
 * no ledger entry exists for it.
 *
 * `points`/`base_points` on a started row are the provisional server base (the
 * CHECK on the table requires a positive number); the multiplier column keeps
 * its 1× default. All four are overwritten atomically by the award below.
 *
 * Re-opening keeps the EARLIEST `started_at` (a customer who reloads is not
 * punished, and a customer who restarts gains nothing), and refuses to touch a
 * row that is already awarded.
 */
export function buildTicketStatement(db: D1Database, i: TicketInput): D1PreparedStatement {
  const idem = rewardIdempotencyKey(i.userId, i.mission, i.period);
  return db
    .prepare(
      `INSERT INTO reward_claims
         (id, user_id, mission, day, points, base_points, state, required_seconds, started_at, idempotency_key, wallet_tx_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'started', ?6, ?7, ?8, 'wtx_rc_' || ?1)
       ON CONFLICT(user_id, mission, day) DO UPDATE SET
         started_at = COALESCE(reward_claims.started_at, excluded.started_at),
         required_seconds = excluded.required_seconds,
         base_points = excluded.base_points
        WHERE reward_claims.state = 'started'`
    )
    .bind(i.claimId, i.userId, i.mission, i.period, i.basePoints, i.requiredSeconds, i.nowIso, idem);
}

export interface TimedAwardInput {
  userId: string;
  mission: MissionId;
  period: string;
  basePoints: number;
  nowIso: string;
  nowSecs: number;
  label: string;
}

/**
 * Redeems a server-timed ticket. The UPDATE is the whole guard, and every
 * clause of it is the server's own data:
 *
 *   state = 'started'   — an awarded row is never awarded twice, and a row
 *                         that does not exist cannot be claimed at all.
 *   started_at          — written by the server when it issued the ticket.
 *   required_seconds    — written by the server from its own configuration.
 *   ?nowSecs            — the server's clock, at this request.
 *
 * There is no field in this statement a browser can influence. A device whose
 * date is moved forward, a replayed request, a fabricated "I watched it"
 * payload: none of them appear here, so none of them can shorten the wait.
 *
 * `meta.changes` on the first statement is the honest answer to "did this
 * request award anything" — 0 means it did not, and the caller says so
 * instead of reporting a success it did not have.
 */
export function buildTimedAwardStatements(db: D1Database, i: TimedAwardInput): D1PreparedStatement[] {
  const mult = multiplierSql('?1', '?2');
  return [
    db
      .prepare(
        `UPDATE reward_claims
            SET state = 'awarded',
                awarded_at = ?2,
                base_points = ?3,
                multiplier_x100 = ${mult},
                tier_at_award = ${tierNameSql('?1', '?2')},
                points = ${multipliedPointsSql('?3', mult)}
          WHERE user_id = ?1 AND mission = ?4 AND day = ?5 AND state = 'started'
            AND started_at IS NOT NULL
            AND ?6 - CAST(strftime('%s', started_at) AS INTEGER) >= required_seconds`
      )
      .bind(i.userId, i.nowIso, i.basePoints, i.mission, i.period, i.nowSecs),
    ledgerStatement(db, 'rc.user_id = ?3 AND rc.mission = ?4 AND rc.day = ?5', i.label, i.nowIso, [
      i.userId,
      i.mission,
      i.period,
    ]),
  ];
}

// -------------------------------------------------------------- read model

export interface RewardHistoryRow {
  mission: string;
  day: string;
  points: number;
  base_points: number | null;
  multiplier_x100: number;
  tier_at_award: string;
  streak_day: number | null;
  awarded_at: string | null;
  /** 'earn' adds to the balance, 'spend' takes from it. */
  direction: 'earn' | 'spend';
  /** The ledger's own wording, for a movement that is not a mission. */
  note: string;
}

/**
 * THE WHOLE POINT BALANCE, ACCOUNTED FOR.
 *
 * A mission award is read from the AWARD ITSELF rather than from the ledger's
 * free-text note — which is why it can show the Baghdad day the award belongs
 * to next to the UTC instant it happened, instead of the ledger's UTC date
 * standing in for both. (Those two disagree for every award made between
 * 21:00 and 24:00 UTC, which is why a check-in could appear on the "wrong"
 * calendar date.)
 *
 * BUT MISSIONS ARE NOT THE ONLY THING THAT MOVES POINTS, and reading only
 * `reward_claims` made purchase releases, review awards, the points a
 * customer SPENDS at checkout and return clawbacks vanish from the only
 * screen in the app that lists POINT movements at all (the wallet page is
 * scoped to USD). A member could watch 900 points leave their balance with no
 * line anywhere saying where they went — the single worst thing a points
 * ledger can do, because it looks exactly like theft.
 *
 * So the ledger is UNIONed in, minus the rows a reward_claim already
 * describes — `wallet_tx_id` is the join, so a check-in appears once, as the
 * richer of the two. A withdrawal is marked `spend` and the page renders it
 * as a subtraction; nothing here invents a mission name for it, the ledger's
 * own note is carried through instead.
 */
export async function readRewardHistory(db: D1Database, userId: string, limit = 20): Promise<RewardHistoryRow[]> {
  const n = Math.max(1, Math.min(100, Math.trunc(limit)));
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT mission, day, points, base_points, multiplier_x100, tier_at_award, streak_day,
                COALESCE(awarded_at, created_at) AS awarded_at, 'earn' AS direction, '' AS note
           FROM reward_claims
          WHERE user_id = ?1 AND state = 'awarded'
         UNION ALL
         SELECT 'ledger' AS mission, '' AS day, amount AS points, NULL AS base_points,
                100 AS multiplier_x100, '' AS tier_at_award, NULL AS streak_day,
                COALESCE(decided_at, created_at) AS awarded_at,
                CASE WHEN type = 'withdrawal' THEN 'spend' ELSE 'earn' END AS direction,
                note
           FROM wallet_transactions
          WHERE user_id = ?1 AND currency = 'POINT' AND status = 'approved'
            AND id NOT IN (
              SELECT wallet_tx_id FROM reward_claims
               WHERE user_id = ?1 AND wallet_tx_id IS NOT NULL AND wallet_tx_id != ''
            )
       )
       ORDER BY awarded_at DESC
       LIMIT ?2`
    )
    .bind(userId, n)
    .all<RewardHistoryRow>();
  return results;
}
