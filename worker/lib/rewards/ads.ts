/**
 * THE VIDEO ADS OF «اجمع النقاط» (owner, 2026-11-05; migration 0227;
 * docs/DECISIONS.md row 300).
 *
 *   «2 times he can see. one per day so the ads will run for 10 days so the
 *    user van watch it 2 times on whole 10 days but 1 per day ,ex he watch it on
 *    day 2 and the second time on day 9»
 *
 * WHICH RULE LIVES WHERE, so nobody writes a second copy of any of them:
 *
 *   one per day      `reward_claims` UNIQUE (user_id, mission, day): the Baghdad
 *                    day, as every other mission. Not a line of code here.
 *   N in the window  the count of this customer's awarded rows carrying this
 *                    `ad_id`, asked twice: here to choose the ad, and INSIDE the
 *                    award's own UPDATE (worker/lib/pointsTasks.ts), which is the
 *                    one that decides.
 *   how many points  MISSION_BASE_POINTS.video × the multiplier, as ever. An ad
 *                    row has no points column on purpose.
 *   how long         the ad's `required_seconds`, copied onto the ticket, checked
 *                    against the server's own `started_at` in SQL.
 *
 * Nothing here reads a request body except the admin's form, and nothing on a
 * customer's path ever takes a figure from one (the header of
 * worker/routes/rewards.ts).
 *
 * BEFORE 0227, AND WHILE THE TABLE IS EMPTY, the mission runs on the old
 * `adVideoUrl` setting exactly as it did: same fields, same statuses, no write to
 * a column that may not exist. An ad row of ANY state ends that fallback, so an
 * old URL left in the setting cannot start paying again the day the owner's ad
 * has run out.
 */
import { HttpError, badRequest, conflict, notFound, str } from '../http';
import { newId } from '../crypto';
import { isSchemaMissing } from '../membershipBenefits';
import { baghdadDay as baghdadDayAt } from '../baghdadTime';
import { isSafeMediaKey } from '../mediaStorage';

/** Where an ad's objects live (uploadEntity.ts `placementFor`, public: mediaStorage.ts). */
export const AD_VIDEO_PREFIX = 'rewards/ads/video/';
export const AD_POSTER_PREFIX = 'rewards/ads/poster/';

/** The owner's own number: two views of one ad. */
export const AD_DEFAULT_MAX_VIEWS = 2;
/** The same floor and ceiling the old setting's wait has (pointsTasks.ts `parseRewardTaskConfig`). */
export const AD_MIN_SECONDS = 5;
export const AD_MAX_SECONDS = 600;

export interface AdRow {
  id: string;
  title_ar: string;
  title_en: string;
  title_ckb: string;
  video_url: string;
  poster_url: string;
  width: number;
  height: number;
  duration_seconds: number;
  required_seconds: number;
  starts_at: string;
  ends_at: string;
  max_views: number;
  active: number;
  sort: number;
  created_by?: string;
  created_at?: string;
  updated_at?: string;
}

/** An ad with how many paid views THIS customer already has of it. */
export type AdForCustomer = AdRow & { views_used: number };

export interface AdState {
  /** False on a database that has not run 0227: nothing below may be touched. */
  installed: boolean;
  rows: AdForCustomer[];
  /** `ad_id` of this customer's video row today, when it carries one. */
  todayAdId: string | null;
}

const NOT_INSTALLED: AdState = { installed: false, rows: [], todayAdId: null };

/**
 * Every ad, in the owner's order, with this customer's paid views of each, and
 * which ad today's row names. Tolerates a database without 0227 — the same
 * statuses as the old mission, no error — and reports it as `installed: false`.
 */
export async function readAdState(db: D1Database, userId: string, day: string): Promise<AdState> {
  try {
    const [ads, todayAdId] = await Promise.all([
      db
        .prepare(
          `SELECT a.*,
                  (SELECT COUNT(*) FROM reward_claims rc
                    WHERE rc.user_id = ?1 AND rc.mission = 'video' AND rc.state = 'awarded' AND rc.ad_id = a.id) AS views_used
             FROM reward_ads a
            ORDER BY a.sort, a.created_at, a.id
            LIMIT 200`
        )
        .bind(userId)
        .all<AdForCustomer>(),
      readTodayAdId(db, userId, day),
    ]);
    return { installed: true, rows: ads.results ?? [], todayAdId };
  } catch (e) {
    if (isSchemaMissing(e)) return NOT_INSTALLED;
    throw e;
  }
}

/**
 * Which ad today's video row names, when the database knows ads at all. Null
 * before 0227, so the award then asks nothing of a column that is not there.
 */
export async function readTodayAdId(db: D1Database, userId: string, day: string): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT ad_id FROM reward_claims WHERE user_id = ?1 AND mission = 'video' AND day = ?2")
      .bind(userId, day)
      .first<{ ad_id: string | null }>();
    return row?.ad_id ?? null;
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
}

const liveAt = (ad: AdRow, iso: string) => Number(ad.active) === 1 && ad.starts_at <= iso && iso < ad.ends_at;
const viewsLeft = (ad: AdForCustomer) => ad.views_used < Number(ad.max_views);

/** The first running ad this customer still has a view of: the owner's rule, in one line. */
export const firstAdWithViews = (rows: readonly AdForCustomer[], nowIso: string): AdForCustomer | null =>
  rows.find((ad) => liveAt(ad, nowIso) && viewsLeft(ad)) ?? null;

/** The first midnight in Baghdad after this instant, as an instant: when «tomorrow» starts. */
export function nextBaghdadMidnight(nowMs: number): string {
  return new Date(`${baghdadDayAt(nowMs, 1)}T00:00:00.000+03:00`).toISOString();
}

export interface VideoClaim {
  state: string;
  started_at: string | null;
  required_seconds: number;
  ad_id: string | null;
}

export interface VideoPlan {
  /** The ad on the card; null when the old setting runs the mission or nothing is running. */
  ad: AdForCustomer | null;
  /** What a player may load now. Null when there is nothing left to watch. */
  videoUrl: string | null;
  requiredSeconds: number;
  /** Today's open ticket belongs to what this plan shows, so its clock counts. */
  ticketOpen: boolean;
  /** This ad is used up: every view it gives this customer has been paid. */
  done: boolean;
  /** When today's view is paid and another remains: the instant tomorrow starts. */
  nextAt: string | null;
}

const ticketRipe = (claim: VideoClaim, nowMs: number): boolean => {
  const started = claim.started_at ? Math.floor(Date.parse(claim.started_at) / 1000) : NaN;
  return Number.isFinite(started) && Math.floor(nowMs / 1000) - started >= (Number(claim.required_seconds) || 0);
};

/**
 * WHAT THE MISSION IS FOR THIS CUSTOMER RIGHT NOW. Pure: one answer for the page
 * and for `/video/start`, so the card can never promise an ad the start refuses.
 *
 *   1. no ad rows (or no table)  the old setting, as it was.
 *   2. today's view is paid      that ad's card: done for today; `nextAt` while a
 *                                view remains and the ad still runs tomorrow;
 *                                `done` when this one was the last.
 *   3. an open ticket            stays on its ad while the ad is running, and
 *                                also — A TICKET FOR AN AD THAT ENDED OR WAS
 *                                SWITCHED OFF MAY STILL BE CLAIMED THAT DAY IF
 *                                ITS TIME RAN — the customer did what was asked
 *                                before the ad went away.
 *   4. otherwise                 the first running ad with a view left.
 *   5. none left                 the first running ad they have used up (`done`),
 *                                else nothing today.
 */
export function planVideoMission(
  state: AdState,
  opts: { claim: VideoClaim | null; nowMs: number; legacyUrl: string | null | undefined; minSeconds: number }
): VideoPlan {
  const { claim, nowMs, legacyUrl, minSeconds } = opts;
  if (!state.installed || state.rows.length === 0) {
    return {
      ad: null,
      videoUrl: legacyUrl || null,
      requiredSeconds: minSeconds,
      ticketOpen: claim?.state === 'started',
      done: false,
      nextAt: null,
    };
  }
  const nowIso = new Date(nowMs).toISOString();
  const named = claim?.ad_id ? (state.rows.find((ad) => ad.id === claim.ad_id) ?? null) : null;

  if (claim?.state === 'awarded') {
    // A view paid before this ad existed names none: the next ad's card, still done for today.
    const ad = named ?? firstAdWithViews(state.rows, nowIso) ?? state.rows.find((a) => liveAt(a, nowIso)) ?? null;
    if (!ad) return { ad: null, videoUrl: null, requiredSeconds: minSeconds, ticketOpen: false, done: false, nextAt: null };
    const done = !viewsLeft(ad);
    const tomorrow = nextBaghdadMidnight(nowMs);
    return {
      ad,
      videoUrl: done ? null : ad.video_url,
      requiredSeconds: Number(ad.required_seconds),
      ticketOpen: false,
      done,
      nextAt: !done && liveAt(ad, tomorrow) ? tomorrow : null,
    };
  }

  if (claim?.state === 'started' && named && viewsLeft(named) && (liveAt(named, nowIso) || ticketRipe(claim, nowMs))) {
    return { ad: named, videoUrl: named.video_url, requiredSeconds: Number(named.required_seconds), ticketOpen: true, done: false, nextAt: null };
  }

  const next = firstAdWithViews(state.rows, nowIso);
  if (next) {
    return { ad: next, videoUrl: next.video_url, requiredSeconds: Number(next.required_seconds), ticketOpen: false, done: false, nextAt: null };
  }
  const spent = state.rows.find((ad) => liveAt(ad, nowIso) && !viewsLeft(ad)) ?? null;
  return {
    ad: spent,
    videoUrl: null,
    requiredSeconds: spent ? Number(spent.required_seconds) : minSeconds,
    ticketOpen: false,
    done: !!spent,
    nextAt: null,
  };
}

/** What the page is told about an ad: never its internal switches. */
export function adForPage(ad: AdForCustomer) {
  return {
    id: ad.id,
    title: { ar: ad.title_ar, en: ad.title_en, ckb: ad.title_ckb },
    poster_url: ad.poster_url || null,
    width: Number(ad.width) || 0,
    height: Number(ad.height) || 0,
    views_used: Number(ad.views_used) || 0,
    views_max: Number(ad.max_views) || 0,
    ends_at: ad.ends_at,
  };
}

/**
 * Why the award's guard refused an ad view: read back after it wrote nothing,
 * so the customer hears the database's own reason. Null: the ad allows it, so
 * the refusal was the clock.
 */
export async function adLimitRefusal(db: D1Database, userId: string, adId: string): Promise<'gone' | 'limit' | null> {
  const row = await db
    .prepare(
      `SELECT a.max_views,
              (SELECT COUNT(*) FROM reward_claims rc
                WHERE rc.user_id = ?1 AND rc.mission = 'video' AND rc.state = 'awarded' AND rc.ad_id = a.id) AS used
         FROM reward_ads a WHERE a.id = ?2`
    )
    .bind(userId, adId)
    .first<{ max_views: number; used: number }>();
  if (!row) return 'gone';
  return Number(row.used) >= Number(row.max_views) ? 'limit' : null;
}

// --------------------------------------------------------------- the admin's

const NOT_INSTALLED_REFUSAL = () =>
  new HttpError(503, 'The rewards tables are not installed on this database yet (migration 0227)', 'REWARDS_NOT_INSTALLED');

const installedOr503 = (e: unknown): never => {
  if (isSchemaMissing(e)) throw NOT_INSTALLED_REFUSAL();
  throw e;
};

export interface AdInput {
  title: { ar: string; en: string; ckb: string };
  video_url: string;
  poster_url: string;
  width: number;
  height: number;
  duration_seconds: number;
  required_seconds: number;
  starts_at: string;
  ends_at: string;
  max_views: number;
  active: boolean;
  sort: number;
}

function whole(v: unknown, name: string, code: string, min: number, max: number, def?: number): number {
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def;
    throw badRequest(`${name} is required`, code);
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`, code);
  return n;
}

const instant = (v: unknown, name: string): string => {
  const t = Date.parse(str(v, name, { max: 40, required: false }));
  if (!Number.isFinite(t)) throw badRequest(`${name} must be a date and time`, 'REWARD_AD_WINDOW_INVALID');
  return new Date(t).toISOString();
};

/** `/files/<key>` under the one folder this door files ads in, or nothing. */
function adFile(v: unknown, prefix: string): string | null {
  if (typeof v !== 'string') return null;
  const raw = v.trim();
  if (!raw.startsWith('/files/')) return null;
  const key = raw.slice('/files/'.length);
  return isSafeMediaKey(key) && key.startsWith(prefix) ? raw : null;
}

/** The form, validated field by field. Every figure stays the server's to refuse. */
export function parseAdInput(body: Record<string, unknown>): AdInput {
  const title = {
    ar: str(body.title_ar, 'title_ar', { max: 120, required: false }),
    en: str(body.title_en, 'title_en', { max: 120, required: false }),
    ckb: str(body.title_ckb, 'title_ckb', { max: 120, required: false }),
  };
  if (!title.ar || !title.en || !title.ckb) throw badRequest('Write the title in all three languages', 'REWARD_AD_TITLE_REQUIRED');
  // DECISIONS row 183: a Sorani slot is never the Arabic copied.
  if (title.ckb === title.ar) throw badRequest('The Sorani title must be Sorani, not a copy of the Arabic', 'REWARD_AD_SORANI_COPY');
  const video_url = adFile(body.video_url, AD_VIDEO_PREFIX);
  if (!video_url || !video_url.endsWith('.mp4')) throw badRequest('Upload the ad as an MP4 here first', 'REWARD_AD_VIDEO_REQUIRED');
  const posterRaw = body.poster_url === null || body.poster_url === undefined ? '' : String(body.poster_url).trim();
  const poster_url = posterRaw ? adFile(posterRaw, AD_POSTER_PREFIX) : '';
  if (poster_url === null) throw badRequest('Upload the poster here first', 'REWARD_AD_POSTER_INVALID');
  const width = whole(body.width, 'width', 'REWARD_AD_SIZE_INVALID', 1, 8192);
  const height = whole(body.height, 'height', 'REWARD_AD_SIZE_INVALID', 1, 8192);
  const duration_seconds = whole(body.duration_seconds, 'duration_seconds', 'REWARD_AD_DURATION_INVALID', AD_MIN_SECONDS, 3600);
  // «Minimum seconds (default duration − 2)»: a view is one the customer stayed for.
  const fallback = Math.min(AD_MAX_SECONDS, Math.max(AD_MIN_SECONDS, duration_seconds - 2));
  const required_seconds = whole(
    body.required_seconds,
    'required_seconds',
    'REWARD_AD_SECONDS_INVALID',
    AD_MIN_SECONDS,
    Math.min(AD_MAX_SECONDS, duration_seconds),
    fallback
  );
  const starts_at = instant(body.starts_at, 'starts_at');
  const ends_at = instant(body.ends_at, 'ends_at');
  if (Date.parse(ends_at) <= Date.parse(starts_at)) throw badRequest('The end must be after the start', 'REWARD_AD_WINDOW_INVALID');
  if (Date.parse(ends_at) - Date.parse(starts_at) > 366 * 86_400_000) throw badRequest('An ad runs at most a year', 'REWARD_AD_WINDOW_INVALID');
  return {
    title,
    video_url,
    poster_url,
    width,
    height,
    duration_seconds,
    required_seconds,
    starts_at,
    ends_at,
    max_views: whole(body.max_views, 'max_views', 'REWARD_AD_VIEWS_INVALID', 1, 50, AD_DEFAULT_MAX_VIEWS),
    active: body.active === true,
    sort: whole(body.sort, 'sort', 'REWARD_AD_SORT_INVALID', -1000, 1000, 0),
  };
}

/**
 * A typo cannot be published: each file must be one this shop stored and still
 * holds, of the kind it is used as. The ledger is asked, so the bucket is not.
 */
export async function assertAdFiles(db: D1Database, input: Pick<AdInput, 'video_url' | 'poster_url'>): Promise<void> {
  const held = async (url: string) =>
    db
      .prepare('SELECT mime_type FROM file_objects WHERE object_key = ? AND deleted_at IS NULL')
      .bind(url.slice('/files/'.length))
      .first<{ mime_type: string }>();
  const video = await held(input.video_url);
  if (video?.mime_type !== 'video/mp4') throw badRequest('This video is not stored here; upload it again', 'REWARD_AD_VIDEO_REQUIRED');
  if (input.poster_url) {
    const poster = await held(input.poster_url);
    if (!poster?.mime_type.startsWith('image/')) throw badRequest('This poster is not stored here; upload it again', 'REWARD_AD_POSTER_INVALID');
  }
}

export async function createAd(db: D1Database, adminId: string, input: AdInput, nowIso: string): Promise<string> {
  const id = newId('rad');
  await db
    .prepare(
      `INSERT INTO reward_ads
         (id, title_ar, title_en, title_ckb, video_url, poster_url, width, height, duration_seconds, required_seconds,
          starts_at, ends_at, max_views, active, sort, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id, input.title.ar, input.title.en, input.title.ckb, input.video_url, input.poster_url, input.width, input.height,
      input.duration_seconds, input.required_seconds, input.starts_at, input.ends_at, input.max_views, input.active ? 1 : 0,
      input.sort, adminId, nowIso, nowIso
    )
    .run()
    .catch(installedOr503);
  return id;
}

export async function updateAd(db: D1Database, id: string, input: AdInput, nowIso: string): Promise<void> {
  const res = await db
    .prepare(
      `UPDATE reward_ads
          SET title_ar = ?, title_en = ?, title_ckb = ?, video_url = ?, poster_url = ?, width = ?, height = ?,
              duration_seconds = ?, required_seconds = ?, starts_at = ?, ends_at = ?, max_views = ?, active = ?, sort = ?,
              updated_at = ?
        WHERE id = ?`
    )
    .bind(
      input.title.ar, input.title.en, input.title.ckb, input.video_url, input.poster_url, input.width, input.height,
      input.duration_seconds, input.required_seconds, input.starts_at, input.ends_at, input.max_views, input.active ? 1 : 0,
      input.sort, nowIso, id
    )
    .run()
    .catch(installedOr503);
  if ((res.meta?.changes ?? 0) === 0) throw notFound('Ad not found');
}

/**
 * On or off, as asked: never a blind flip, so a double press or two open tabs
 * land where the admin meant. Switching ON asks whether what it would publish is
 * still whole (the caller has already asked who is switching).
 */
export async function setAdActive(db: D1Database, id: string, active: boolean, nowIso: string): Promise<{ changed: boolean }> {
  const row = await db
    .prepare('SELECT active, video_url, poster_url FROM reward_ads WHERE id = ?')
    .bind(id)
    .first<{ active: number; video_url: string; poster_url: string }>()
    .catch(installedOr503);
  if (!row) throw notFound('Ad not found');
  if (active) await assertAdFiles(db, row);
  if ((Number(row.active) === 1) === active) return { changed: false };
  await db.prepare('UPDATE reward_ads SET active = ?, updated_at = ? WHERE id = ?').bind(active ? 1 : 0, nowIso, id).run();
  return { changed: true };
}

export const adActiveFrom = (body: Record<string, unknown>): boolean => {
  if (typeof body.active !== 'boolean') throw badRequest('active must be true or false', 'REWARD_AD_ACTIVE_REQUIRED');
  return body.active;
};

export type AdPhase = 'off' | 'upcoming' | 'live' | 'ended';

/** The owner's list, with what each ad has paid: views, distinct viewers, points. */
export async function listAdsForAdmin(db: D1Database, nowIso: string) {
  const { results } = await db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM reward_claims rc WHERE rc.ad_id = a.id AND rc.state = 'awarded') AS views,
              (SELECT COUNT(DISTINCT rc.user_id) FROM reward_claims rc WHERE rc.ad_id = a.id AND rc.state = 'awarded') AS viewers,
              (SELECT COALESCE(SUM(rc.points), 0) FROM reward_claims rc WHERE rc.ad_id = a.id AND rc.state = 'awarded') AS points_paid
         FROM reward_ads a
        ORDER BY a.sort, a.created_at DESC, a.id
        LIMIT 200`
    )
    .all<AdRow & { views: number; viewers: number; points_paid: number }>();
  return (results ?? []).map((a) => {
    const phase: AdPhase =
      Number(a.active) !== 1 ? 'off' : nowIso < a.starts_at ? 'upcoming' : nowIso >= a.ends_at ? 'ended' : 'live';
    return {
      id: a.id,
      title: { ar: a.title_ar, en: a.title_en, ckb: a.title_ckb },
      video_url: a.video_url,
      poster_url: a.poster_url || null,
      width: Number(a.width) || 0,
      height: Number(a.height) || 0,
      duration_seconds: Number(a.duration_seconds) || 0,
      required_seconds: Number(a.required_seconds) || 0,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      max_views: Number(a.max_views) || 0,
      active: Number(a.active) === 1,
      sort: Number(a.sort) || 0,
      phase,
      views: Number(a.views) || 0,
      viewers: Number(a.viewers) || 0,
      points_paid: Number(a.points_paid) || 0,
    };
  });
}

/** The refusal `/video/start` gives when the plan has nothing to play. */
export function noAdRefusal(plan: Pick<VideoPlan, 'done'>): HttpError {
  return plan.done
    ? conflict('You have used every view of this ad', 'AD_LIMIT_REACHED')
    : new HttpError(503, 'No ad video is configured today', 'NO_VIDEO');
}
