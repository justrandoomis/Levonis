/**
 * POINTS & MISSIONS — the customer-facing half of the rewards ledger.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * THIS ROUTE NEVER READS A REQUEST BODY. Not once, in any handler. There is no
 * `await c.req.json()` in this file and there must never be one, because every
 * number a reward is worth, every period it belongs to and every instant it is
 * measured against is a server fact:
 *
 *   how many points   — worker/lib/pointsTasks.ts constants, multiplied by the
 *                       subscription multiplier resolved IN SQL at commit time
 *   which day          — baghdadDay() from the Worker's own Date.now()
 *   which streak day   — derived from the award history, in the database
 *   how long elapsed   — the server's own `started_at`, re-checked in SQL
 *
 * A customer with devtools open can call these endpoints with any payload they
 * like, at any rate, with any device clock, from any number of tabs. The only
 * thing they get to choose is WHICH endpoint. Everything else is decided here.
 *
 * WHAT CHANGED, AND WHY (the adversarial review this file came out of)
 *
 *  D1  "Watch Ad" paid on a bare POST. `curl -X POST /api/rewards/video` was
 *      twenty points, every day, for ever, with no browser involved. It is now
 *      two-phase: the server issues a timed ticket and the claim is refused
 *      until the server's own clock says the configured seconds have passed.
 *      That bounds it; it still does not PROVE a human watched — see the
 *      `verification` field this route returns, which says so out loud.
 *
 *  D2  The streak day was read from `users.checkin_streak` as loaded into the
 *      session BEFORE the request, then written back. It is now derived from
 *      the awarded check-in rows themselves and recorded on the row that is
 *      paid, so the history can be audited and a cache cannot drift.
 *
 *  D3  The points history rendered wallet_transactions.note — free text — and
 *      dated it by the UTC ledger clock while the award belongs to a Baghdad
 *      (UTC+3) day. Between 21:00 and 24:00 UTC those disagree, which is how
 *      "Daily Check-In (Day 1)" can appear against a date the customer did not
 *      expect. History now comes from the award rows, carrying BOTH the day it
 *      credited and the instant it happened.
 *
 *  D4  The browse claim was wrapped in `catch { }` and then reported
 *      `done: true` regardless. A real database failure was reported to the
 *      customer as a completed mission with no points. Only the "already
 *      claimed" collision is tolerated now, and it is reported as such.
 *
 *  D5  `browse/start` reset `started_at` on every call, so the wall-clock
 *      floor it could have enforced was worthless. It now keeps the first
 *      start of the day.
 *
 *  D6  No award recorded which multiplier produced it. A PREMIUM member who
 *      let their subscription lapse would have had no way — and neither would
 *      support — to see why yesterday's award was 8 and today's is 5.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, conflict, unavailable } from '../lib/http';
import { newId } from '../lib/crypto';
import { getBalances } from '../lib/wallet';
import { getSetting } from '../lib/settings';
import { rateLimit } from '../lib/ratelimit';
import { benefits, getTierStatus } from '../lib/entitlements';
import { applyMultiplierX100, multiplierLabel, rewardMultiplierX100 } from '../lib/pointsMultiplier';
import {
  BROWSE_REQUIRED_SECS,
  MISSIONS,
  MISSION_BASE_POINTS,
  type MissionId,
  baghdadDay,
  buildDirectAwardStatements,
  buildTicketStatement,
  buildTimedAwardStatements,
  checkinBasePoints,
  getRewardTaskConfig,
  isUniqueViolation,
  missionEnabled,
  missionPeriod,
  readRewardHistory,
  readStreak,
} from '../lib/pointsTasks';

export const rewardRoutes = new Hono<AppContext>();
rewardRoutes.use('*', requireAuth);

/** Re-exported so existing importers of this symbol keep working. */
export { baghdadDay, checkinBasePoints };

/**
 * The credit a check-in is worth. Kept exported with its original name and
 * shape: base ladder × multiplier, rounded by the one rounding rule.
 */
export function checkinPoints(streakDay: number, multiplierX100 = 100): number {
  return applyMultiplierX100(checkinBasePoints(streakDay), multiplierX100);
}

/**
 * Refuses a mission the owner has switched off, with an honest reason rather
 * than a silent zero. `push`/`video`/`browse` are the tasks whose completion
 * the server cannot prove; the switch is how the owner turns one off without a
 * deploy (migration 0076 documents the exact statement).
 */
async function requireMissionEnabled(c: Context<AppContext>, mission: MissionId) {
  const cfg = await getRewardTaskConfig(c.env);
  if (!missionEnabled(mission, cfg)) {
    throw unavailable('This task is not available right now', 'TASK_DISABLED');
  }
  return cfg;
}

/**
 * Runs an award batch and turns the three idempotency guards into one honest
 * 409 instead of a 500. A replay must MOVE NOTHING and SAY SO.
 */
async function runAward(c: Context<AppContext>, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try {
    return await c.env.DB.batch(statements);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('You have already claimed this reward');
    throw e;
  }
}

/** The claim row this request just wrote, read back so the reply is the truth. */
async function awardedClaim(c: Context<AppContext>, mission: MissionId, period: string, nowIso: string) {
  const user = c.get('user')!;
  return c.env.DB.prepare(
    `SELECT points, base_points, multiplier_x100, tier_at_award, streak_day
       FROM reward_claims
      WHERE user_id = ? AND mission = ? AND day = ? AND state = 'awarded' AND awarded_at = ?`
  )
    .bind(user.id, mission, period, nowIso)
    .first<{
      points: number; base_points: number | null; multiplier_x100: number;
      tier_at_award: string; streak_day: number | null;
    }>();
}

// ------------------------------------------------------------------- read

rewardRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const nowMs = Date.now();
  const today = baghdadDay(0, nowMs);
  const yesterday = baghdadDay(-1, nowMs);
  const nowSecs = Math.floor(nowMs / 1000);

  const [balances, claims, adVideoUrl, browse, tierStatus, streak, history, taskCfg] = await Promise.all([
    getBalances(c.env.DB, user.id),
    c.env.DB.prepare(
      `SELECT mission, day, state, started_at, required_seconds, points
         FROM reward_claims
        WHERE user_id = ? AND (day = ? OR mission = 'push')`
    )
      .bind(user.id, today)
      .all<{ mission: string; day: string; state: string; started_at: string | null; required_seconds: number; points: number }>(),
    getSetting(c.env.DB, 'adVideoUrl'),
    c.env.DB.prepare('SELECT day, seconds FROM browse_sessions WHERE user_id = ?')
      .bind(user.id)
      .first<{ day: string; seconds: number }>(),
    getTierStatus(c.env.DB, user.id),
    readStreak(c.env.DB, user.id, today, yesterday),
    readRewardHistory(c.env.DB, user.id, 20),
    getRewardTaskConfig(c.env),
  ]);

  const multiplierX100 = rewardMultiplierX100(tierStatus);
  const rows = new Map(claims.results.map((r) => [r.mission, r]));
  const awarded = (m: MissionId) => rows.get(m)?.state === 'awarded';

  /** Seconds still to wait on a server-issued ticket; null when none is open. */
  const waitLeft = (m: MissionId): number | null => {
    const r = rows.get(m);
    if (!r || r.state !== 'started' || !r.started_at) return null;
    const startedSecs = Math.floor(Date.parse(r.started_at) / 1000);
    if (!Number.isFinite(startedSecs)) return null;
    return Math.max(0, (Number(r.required_seconds) || 0) - (nowSecs - startedSecs));
  };

  /** The SERVER's view of what a task pays this customer, base and credited. */
  const money = (base: number) => ({ base_points: base, points: applyMultiplierX100(base, multiplierX100) });

  const mission = (m: Exclude<MissionId, 'checkin'>, extra: Record<string, unknown> = {}) => ({
    ...money(MISSION_BASE_POINTS[m]),
    claimed: awarded(m),
    available: missionEnabled(m, taskCfg),
    verification: MISSIONS[m].verification,
    proof: MISSIONS[m].proof,
    ...extra,
  });

  // The ladder the page draws. Computed HERE so the page never guesses at an
  // amount: it used to multiply by 2 for any PRO, which was wrong for PREMIUM
  // and wrong again wherever rounding applied.
  const firstOfWeek = Math.max(1, Math.floor((Math.max(1, streak.nextDay) - 1) / 7) * 7 + 1);
  const ladder = Array.from({ length: 7 }, (_, i) => {
    const day = firstOfWeek + i;
    return {
      day,
      ...money(checkinBasePoints(day)),
      status: streak.todayDay !== null && day <= streak.current ? 'checked'
        : streak.todayDay === null && day === streak.nextDay ? 'today'
        : day < streak.nextDay ? 'checked'
        : 'upcoming',
    };
  });

  return c.json({
    success: true,
    today,
    /** The server's own instant, so the page never reasons from the device clock. */
    server_time: new Date(nowMs).toISOString(),
    streak: streak.current,
    checked_in_today: streak.todayDay !== null,
    point_balance: balances.points,
    checkin: {
      next_day: streak.nextDay,
      ...money(checkinBasePoints(streak.nextDay)),
      verification: MISSIONS.checkin.verification,
      proof: MISSIONS.checkin.proof,
      ladder,
    },
    missions: {
      push: mission('push'),
      video: mission('video', {
        available: missionEnabled('video', taskCfg) && !!adVideoUrl,
        videoUrl: adVideoUrl || null,
        required_seconds: taskCfg.video_min_seconds,
        /** Non-null once the server has issued the ticket for today. */
        seconds_remaining: waitLeft('video'),
        started: rows.get('video')?.state === 'started',
      }),
      browse: mission('browse', {
        required_seconds: BROWSE_REQUIRED_SECS,
        progress_seconds: browse && browse.day === today ? browse.seconds : 0,
        seconds_remaining: waitLeft('browse'),
      }),
    },
    /**
     * The multiplier, stated plainly. `applies_to` is the owner's list from
     * the brief: signing in, earning from tasks, purchases and reviews.
     */
    multiplier: {
      x100: multiplierX100,
      label: multiplierLabel(multiplierX100),
      tier: tierStatus.tier,
      active: tierStatus.active,
      expires_at: tierStatus.expires_at,
      applies_to: ['checkin', 'tasks', 'purchases', 'reviews'],
    },
    history,
    is_pro: benefits.priorityService(tierStatus),
    membership_reward_multiplier_x100: multiplierX100,
  });
});

// --------------------------------------------------------------- check-in

rewardRoutes.post('/checkin', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  const user = c.get('user')!;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = baghdadDay(0, nowMs);
  const yesterday = baghdadDay(-1, nowMs);

  const streak = await readStreak(c.env.DB, user.id, today, yesterday);
  if (streak.todayDay !== null) throw conflict('You have already checked in today');

  const day = streak.nextDay;
  const base = checkinBasePoints(day);
  const claimId = newId('rc');

  // The users.* counters are a CACHE the rest of the app still reads; the
  // award history above is the record. Updating it in the same batch keeps the
  // two agreeing, and the WHERE makes a re-run a no-op rather than a second
  // increment.
  const res = await runAward(c, [
    ...buildDirectAwardStatements(c.env.DB, {
      claimId,
      userId: user.id,
      mission: 'checkin',
      period: today,
      basePoints: base,
      streakDay: day,
      nowIso,
      label: `Daily check-in (day ${day})`,
    }),
    c.env.DB.prepare(
      `UPDATE users SET checkin_streak = ?, last_checkin_day = ?
        WHERE id = ? AND (last_checkin_day IS NULL OR last_checkin_day <> ?)`
    ).bind(day, today, user.id, today),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) throw conflict('You have already checked in today');

  const row = await awardedClaim(c, 'checkin', today, nowIso);
  return c.json({
    success: true,
    streak: day,
    day,
    points: row?.points ?? 0,
    base_points: row?.base_points ?? base,
    multiplier_x100: row?.multiplier_x100 ?? 100,
    tier: row?.tier_at_award ?? '',
  });
});

// ------------------------------------------------------------------- push

rewardRoutes.post('/push', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  await requireMissionEnabled(c, 'push');
  const user = c.get('user')!;
  const nowIso = new Date().toISOString();
  const period = missionPeriod('push', baghdadDay());

  // One-time mission: the period slot is the constant 'once', so the unique
  // key dedupes it for the life of the account, not just for today.
  const res = await runAward(
    c,
    buildDirectAwardStatements(c.env.DB, {
      claimId: newId('rc'),
      userId: user.id,
      mission: 'push',
      period,
      basePoints: MISSION_BASE_POINTS.push,
      streakDay: null,
      nowIso,
      label: 'Enabled push notifications',
    })
  );
  if ((res[0]?.meta.changes ?? 0) === 0) throw conflict('You have already claimed this reward');
  const row = await awardedClaim(c, 'push', period, nowIso);
  return c.json({
    success: true,
    points: row?.points ?? 0,
    base_points: row?.base_points ?? MISSION_BASE_POINTS.push,
    multiplier_x100: row?.multiplier_x100 ?? 100,
  });
});

// ------------------------------------------------------------- watch an ad

/**
 * Issues the ad ticket. This is the ONLY way a `video` claim can become
 * possible, and the instant it records is the server's — a customer cannot
 * pre-date it, cannot hold several, and cannot claim without one.
 */
rewardRoutes.post('/video/start', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  const cfg = await requireMissionEnabled(c, 'video');
  const user = c.get('user')!;
  const adVideoUrl = await getSetting(c.env.DB, 'adVideoUrl');
  if (!adVideoUrl) throw unavailable('No ad video is configured today', 'NO_VIDEO');

  const today = baghdadDay();
  const existing = await c.env.DB.prepare(
    "SELECT state FROM reward_claims WHERE user_id = ? AND mission = 'video' AND day = ?"
  )
    .bind(user.id, today)
    .first<{ state: string }>();
  if (existing?.state === 'awarded') throw conflict('You have already claimed this reward');

  await c.env.DB.batch([
    buildTicketStatement(c.env.DB, {
      claimId: newId('rc'),
      userId: user.id,
      mission: 'video',
      period: today,
      basePoints: MISSION_BASE_POINTS.video,
      requiredSeconds: cfg.video_min_seconds,
      nowIso: new Date().toISOString(),
    }),
  ]);

  const row = await c.env.DB.prepare(
    "SELECT started_at, required_seconds FROM reward_claims WHERE user_id = ? AND mission = 'video' AND day = ?"
  )
    .bind(user.id, today)
    .first<{ started_at: string | null; required_seconds: number }>();
  const startedSecs = row?.started_at ? Math.floor(Date.parse(row.started_at) / 1000) : null;
  const remaining =
    startedSecs === null ? cfg.video_min_seconds
      : Math.max(0, (Number(row?.required_seconds) || 0) - (Math.floor(Date.now() / 1000) - startedSecs));
  return c.json({ success: true, required_seconds: cfg.video_min_seconds, seconds_remaining: remaining });
});

rewardRoutes.post('/video', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  await requireMissionEnabled(c, 'video');
  const user = c.get('user')!;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = baghdadDay(0, nowMs);

  const res = await runAward(
    c,
    buildTimedAwardStatements(c.env.DB, {
      userId: user.id,
      mission: 'video',
      period: today,
      basePoints: MISSION_BASE_POINTS.video,
      nowIso,
      nowSecs: Math.floor(nowMs / 1000),
      label: 'Watched ad',
    })
  );

  // 0 rows changed is the honest answer, and the reason for it is read back
  // from the database rather than guessed.
  if ((res[0]?.meta.changes ?? 0) === 0) {
    const row = await c.env.DB.prepare(
      "SELECT state, started_at, required_seconds FROM reward_claims WHERE user_id = ? AND mission = 'video' AND day = ?"
    )
      .bind(user.id, today)
      .first<{ state: string; started_at: string | null; required_seconds: number }>();
    if (!row) throw badRequest('Start the ad first', 'NO_TICKET');
    if (row.state === 'awarded') throw conflict('You have already claimed this reward');
    const startedSecs = row.started_at ? Math.floor(Date.parse(row.started_at) / 1000) : null;
    const remaining =
      startedSecs === null ? Number(row.required_seconds) || 0
        : Math.max(0, (Number(row.required_seconds) || 0) - (Math.floor(nowMs / 1000) - startedSecs));
    throw conflict(`The ad is not finished yet — ${remaining}s left`, 'TOO_SOON');
  }

  const row = await awardedClaim(c, 'video', today, nowIso);
  return c.json({
    success: true,
    points: row?.points ?? 0,
    base_points: row?.base_points ?? MISSION_BASE_POINTS.video,
    multiplier_x100: row?.multiplier_x100 ?? 100,
  });
});

// -------------------------------------------------------------- browse N min

rewardRoutes.post('/browse/start', async (c) => {
  await rateLimit(c, 'browse-start', 120, 3600);
  await requireMissionEnabled(c, 'browse');
  const user = c.get('user')!;
  const nowMs = Date.now();
  const today = baghdadDay(0, nowMs);

  const existing = await c.env.DB.prepare(
    "SELECT state FROM reward_claims WHERE user_id = ? AND mission = 'browse' AND day = ?"
  )
    .bind(user.id, today)
    .first<{ state: string }>();
  if (existing?.state === 'awarded') throw conflict('You have already claimed the browse reward today');

  const now = Math.floor(nowMs / 1000);
  await c.env.DB.batch([
    // D5: `started_at` is the FIRST start of the day and is not reset by a
    // reload — otherwise the wall-clock floor it exists to impose would be
    // pushed forward every time the customer pressed the button, which is the
    // opposite of a floor.
    c.env.DB.prepare(
      `INSERT INTO browse_sessions (user_id, day, started_at, seconds, last_ping) VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         day = excluded.day,
         started_at = CASE WHEN browse_sessions.day = excluded.day THEN browse_sessions.started_at ELSE excluded.started_at END,
         seconds = CASE WHEN browse_sessions.day = excluded.day THEN browse_sessions.seconds ELSE 0 END,
         last_ping = excluded.last_ping`
    ).bind(user.id, today, now, now),
    buildTicketStatement(c.env.DB, {
      claimId: newId('rc'),
      userId: user.id,
      mission: 'browse',
      period: today,
      basePoints: MISSION_BASE_POINTS.browse,
      requiredSeconds: BROWSE_REQUIRED_SECS,
      nowIso: new Date(nowMs).toISOString(),
    }),
  ]);
  return c.json({ success: true, required_seconds: BROWSE_REQUIRED_SECS });
});

rewardRoutes.post('/browse/ping', async (c) => {
  await rateLimit(c, 'browse-ping', 400, 3600);
  await requireMissionEnabled(c, 'browse');
  const user = c.get('user')!;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = baghdadDay(0, nowMs);

  const session = await c.env.DB.prepare('SELECT * FROM browse_sessions WHERE user_id = ? AND day = ?')
    .bind(user.id, today)
    .first<{ seconds: number; last_ping: number }>();
  if (!session) throw badRequest('Start the browse mission first');

  const now = Math.floor(nowMs / 1000);
  // Credit only wall-clock time actually elapsed since the last ping (capped),
  // so fabricated rapid pings cannot fast-forward the timer — and clamp at 0
  // so a `last_ping` in the future (clock skew, a restored backup) cannot
  // produce a negative delta that would rewind someone else's progress.
  const delta = Math.max(0, Math.min(now - session.last_ping, 30));
  const seconds = Math.min(session.seconds + delta, BROWSE_REQUIRED_SECS);
  await c.env.DB.prepare(
    'UPDATE browse_sessions SET seconds = ?, last_ping = ? WHERE user_id = ? AND day = ?'
  )
    .bind(seconds, now, user.id, today)
    .run();

  if (seconds < BROWSE_REQUIRED_SECS) return c.json({ success: true, done: false, seconds });

  // The accumulated counter says the time is up; the ticket's own `started_at`
  // is checked INDEPENDENTLY inside the UPDATE. Both are the server's clock,
  // and both have to agree before a point is paid.
  let res: D1Result[];
  try {
    res = await c.env.DB.batch(
      buildTimedAwardStatements(c.env.DB, {
        userId: user.id,
        mission: 'browse',
        period: today,
        basePoints: MISSION_BASE_POINTS.browse,
        nowIso,
        nowSecs: now,
        label: 'Browsed products',
      })
    );
  } catch (e) {
    // D4: ONLY the already-claimed collision is tolerated. Anything else is a
    // real failure and is reported as one — never as a finished mission.
    if (!isUniqueViolation(e)) throw e;
    return c.json({ success: true, done: true, seconds, awarded: false, reason: 'already_claimed' });
  }

  const awarded = (res[0]?.meta.changes ?? 0) > 0;
  const row = awarded ? await awardedClaim(c, 'browse', today, nowIso) : null;
  return c.json({
    success: true,
    done: true,
    seconds,
    awarded,
    points: row?.points ?? 0,
    base_points: row?.base_points ?? MISSION_BASE_POINTS.browse,
    multiplier_x100: row?.multiplier_x100 ?? 100,
    ...(awarded ? {} : { reason: 'already_claimed' }),
  });
});
