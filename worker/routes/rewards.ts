import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, conflict, unavailable } from '../lib/http';
import { newId } from '../lib/crypto';
import { getBalances } from '../lib/wallet';
import { getSetting } from '../lib/settings';
import { rateLimit } from '../lib/ratelimit';
import { benefits, dailyRewardMultiplierX100, getTierStatus } from '../lib/entitlements';

export const rewardRoutes = new Hono<AppContext>();
rewardRoutes.use('*', requireAuth);

/** Iraq is UTC+3 year-round (no DST since 2007). */
export function baghdadDay(offsetDays = 0): string {
  const d = new Date(Date.now() + 3 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const BROWSE_REQUIRED_SECS = 180;
const MISSION_POINTS = { push: 50, video: 20, browse: 20 } as const;

export function checkinPoints(streakDay: number, multiplierX100 = 100): number {
  let pts = 20;
  if (streakDay <= 2) pts = 5;
  else if (streakDay <= 4) pts = 10;
  else if (streakDay <= 6) pts = 15;
  return Math.floor((pts * Math.max(100, multiplierX100)) / 100);
}

/**
 * Awards points for a mission exactly once per (user, mission, day):
 * the UNIQUE constraint on reward_claims makes double claims abort the
 * whole batch, including the points credit.
 */
async function claim(
  c: Context<AppContext>,
  mission: string,
  day: string,
  points: number,
  note: string,
  extraStatements: D1PreparedStatement[] = []
): Promise<void> {
  const user = c.get('user')!;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO reward_claims (id, user_id, mission, day, points) VALUES (?, ?, ?, ?, ?)').bind(
        newId('rc'), user.id, mission, day, points
      ),
      c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'POINT', ?, 'approved', ?, ?, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      ).bind(newId('wtx'), user.id, points, note, `mission:${mission}:${day}`),
      ...extraStatements,
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) throw conflict('You have already claimed this reward');
    throw e;
  }
}

rewardRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const today = baghdadDay();
  const [balances, claims, adVideoUrl, browse, tierStatus] = await Promise.all([
    getBalances(c.env.DB, user.id),
    c.env.DB.prepare("SELECT mission, day FROM reward_claims WHERE user_id = ? AND (day = ? OR mission = 'push')")
      .bind(user.id, today)
      .all<{ mission: string; day: string }>(),
    getSetting(c.env.DB, 'adVideoUrl'),
    c.env.DB.prepare('SELECT day, seconds FROM browse_sessions WHERE user_id = ?').bind(user.id).first<{ day: string; seconds: number }>(),
    getTierStatus(c.env.DB, user.id),
  ]);
  const claimed = new Set(claims.results.map((r) => r.mission));
  return c.json({
    success: true,
    today,
    streak: user.last_checkin_day === today || user.last_checkin_day === baghdadDay(-1) ? user.checkin_streak : 0,
    checked_in_today: user.last_checkin_day === today,
    point_balance: balances.points,
    missions: {
      push: { points: MISSION_POINTS.push, claimed: claimed.has('push') },
      video: { points: MISSION_POINTS.video, claimed: claimed.has('video'), available: !!adVideoUrl, videoUrl: adVideoUrl || null },
      browse: {
        points: MISSION_POINTS.browse,
        claimed: claimed.has('browse'),
        required_seconds: BROWSE_REQUIRED_SECS,
        progress_seconds: browse && browse.day === today ? browse.seconds : 0,
      },
    },
    is_pro: benefits.priorityService(tierStatus),
    membership_reward_multiplier_x100: dailyRewardMultiplierX100(tierStatus),
  });
});

rewardRoutes.post('/checkin', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  const user = c.get('user')!;
  const today = baghdadDay();
  if (user.last_checkin_day === today) throw conflict('You have already checked in today');
  const streak = user.last_checkin_day === baghdadDay(-1) ? user.checkin_streak + 1 : 1;
  const tierStatus = await getTierStatus(c.env.DB, user.id);
  const points = checkinPoints(streak, dailyRewardMultiplierX100(tierStatus));
  await claim(c, 'checkin', today, points, `Daily Check-in (Day ${streak})`, [
    c.env.DB.prepare('UPDATE users SET checkin_streak = ?, last_checkin_day = ? WHERE id = ? AND (last_checkin_day IS NULL OR last_checkin_day <> ?)').bind(
      streak, today, user.id, today
    ),
  ]);
  return c.json({ success: true, streak, points });
});

rewardRoutes.post('/push', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  // One-time mission; day slot holds a constant so the UNIQUE key dedupes forever.
  await claim(c, 'push', 'once', MISSION_POINTS.push, 'Enabled Push Notifications');
  return c.json({ success: true, points: MISSION_POINTS.push });
});

rewardRoutes.post('/video', async (c) => {
  await rateLimit(c, 'rewards', 60, 3600);
  const adVideoUrl = await getSetting(c.env.DB, 'adVideoUrl');
  if (!adVideoUrl) throw unavailable('No ad video is configured today', 'NO_VIDEO');
  // Limitation (documented): the server cannot verify the video was really
  // watched; the claim is capped at once per day per account.
  await claim(c, 'video', baghdadDay(), MISSION_POINTS.video, 'Watched Ad');
  return c.json({ success: true, points: MISSION_POINTS.video });
});

rewardRoutes.post('/browse/start', async (c) => {
  await rateLimit(c, 'rewards', 120, 3600);
  const user = c.get('user')!;
  const today = baghdadDay();
  const claimed = await c.env.DB.prepare(
    "SELECT id FROM reward_claims WHERE user_id = ? AND mission = 'browse' AND day = ?"
  )
    .bind(user.id, today)
    .first();
  if (claimed) throw conflict('You have already claimed the browse reward today');
  const now = Math.floor(Date.now() / 1000);
  await c.env.DB.prepare(
    `INSERT INTO browse_sessions (user_id, day, started_at, seconds, last_ping) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       day = excluded.day,
       started_at = excluded.started_at,
       seconds = CASE WHEN browse_sessions.day = excluded.day THEN browse_sessions.seconds ELSE 0 END,
       last_ping = excluded.last_ping`
  )
    .bind(user.id, today, now, now)
    .run();
  return c.json({ success: true, required_seconds: BROWSE_REQUIRED_SECS });
});

rewardRoutes.post('/browse/ping', async (c) => {
  await rateLimit(c, 'browse-ping', 400, 3600);
  const user = c.get('user')!;
  const today = baghdadDay();
  const session = await c.env.DB.prepare('SELECT * FROM browse_sessions WHERE user_id = ? AND day = ?')
    .bind(user.id, today)
    .first<{ seconds: number; last_ping: number }>();
  if (!session) throw badRequest('Start the browse mission first');
  const now = Math.floor(Date.now() / 1000);
  // Credit only wall-clock time actually elapsed since the last ping
  // (capped), so fabricated rapid pings cannot fast-forward the timer.
  const delta = Math.max(0, Math.min(now - session.last_ping, 30));
  const seconds = Math.min(session.seconds + delta, BROWSE_REQUIRED_SECS);
  await c.env.DB.prepare('UPDATE browse_sessions SET seconds = ?, last_ping = ? WHERE user_id = ?')
    .bind(seconds, now, user.id)
    .run();

  if (seconds >= BROWSE_REQUIRED_SECS) {
    try {
      await claim(c, 'browse', today, MISSION_POINTS.browse, 'Browsed Products for 3 Mins');
    } catch {
      // Already claimed via a parallel tab — treat as done.
    }
    return c.json({ success: true, done: true, seconds });
  }
  return c.json({ success: true, done: false, seconds });
});
