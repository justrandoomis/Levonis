/**
 * PRO, PAUSED — «إيقاف اشتراكات البرو وتعليق لمن لديه الاشتراك إلى إشعار آخر»
 * (migration 0145).
 *
 * TWO THINGS, AND ONLY TWO.
 *
 *   1. THE SALE STOPS. While `admin_settings.proPause.paused` is true no PRO
 *      card is quoted, bought or granted (`PRO_PAUSED`), and the storefront
 *      shows «قريبًا… يتم العمل على تطوير النظام» where the price and the
 *      button were — no PRO price anywhere, on the card or on a product.
 *
 *   2. THE CLOCK STOPS. Every running PRO membership carries `paused_at`, the
 *      moment it was frozen. A frozen row never expires (every expiry sweep
 *      skips it), and on resume its `expires_at` moves forward by exactly the
 *      time it spent frozen — the owner's promise to the member, «لا تقلق لم
 *      يتم استقطاع أيامك من الاشتراك», kept to the millisecond.
 *
 * WHILE FROZEN THE MEMBER IS NOT DEMOTED TO NOTHING. A PRO card included
 * everything PREMIUM and PLUS give — a merchant's store and identity in the
 * community above all — and switching those off would take a paying
 * merchant's store down for a maintenance they did not choose. So a frozen
 * PRO membership ACTS AS PREMIUM (`PAUSED_PRO_ACTS_AS`) in `getTierStatus`,
 * the one place every benefit question passes through: no PRO price, PRO
 * delivery, BNPL, 12-hour lane, PRO badge or ×2 points — until it resumes.
 *
 * Resuming is the admin's explicit, audited action (`resumeProMemberships`),
 * and `getTierStatus` finishes it lazily for any row the bulk update missed,
 * with a conditional UPDATE so a row can never be pushed forward twice.
 */

export interface ProPauseConfig {
  paused: boolean;
  /** When the current pause began (null when not paused). */
  since: string | null;
}

/**
 * A DATABASE BEHIND THE CODE. `memberships.paused_at` is 0145's, and a Worker
 * can reach a database that has not run it yet — the storefront outage
 * worker/lib/conditionProjection.ts is written about. Every statement that
 * names the column is tried FIRST (the fast path costs nothing); only a
 * refusal that names THIS column sends the caller to the pre-0145 statement,
 * where no membership can be frozen because none can have been. Any other
 * error is the caller's to throw.
 */
export function isPausedAtMissing(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cursor: unknown = e;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message = cursor instanceof Error ? cursor.message : typeof cursor === 'string' ? cursor : '';
    // SQLite's two sentences for an absent column: a read's, and a write's.
    if (/no such column:\s*(?:\w+\.)?paused_at\b|has no column named paused_at\b/i.test(message)) return true;
    cursor = cursor instanceof Error ? (cursor as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

/** A database without the row sells PRO as before: the pause is a decision, never a default. */
export const PRO_PAUSE_DEFAULT: ProPauseConfig = { paused: false, since: null };

/** The tier a frozen PRO membership counts as while it waits. */
export const PAUSED_PRO_ACTS_AS = 'prime' as const;

export const PRO_PAUSE_KEY = 'proPause';

/** The stored switch, tolerant of a hand-edited row (anything unreadable → not paused). */
export function parseProPause(raw: unknown): ProPauseConfig {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return PRO_PAUSE_DEFAULT;
    }
  }
  if (!v || typeof v !== 'object') return PRO_PAUSE_DEFAULT;
  const o = v as Record<string, unknown>;
  const paused = o.paused === true;
  const since = typeof o.since === 'string' && Number.isFinite(Date.parse(o.since)) ? o.since : null;
  return { paused, since: paused ? since : null };
}

export async function getProPause(db: D1Database): Promise<ProPauseConfig> {
  try {
    const row = await db.prepare(`SELECT value FROM admin_settings WHERE key = '${PRO_PAUSE_KEY}'`).first<{ value: string }>();
    return row ? parseProPause(row.value) : PRO_PAUSE_DEFAULT;
  } catch {
    return PRO_PAUSE_DEFAULT;
  }
}

/** Whole days left on a frozen membership: from the freeze to its expiry, never negative. */
export function frozenRemainingDays(pausedAt: string | null, expiresAt: string | null): number | null {
  if (!pausedAt || !expiresAt) return null;
  const left = Date.parse(expiresAt) - Date.parse(pausedAt);
  if (!Number.isFinite(left)) return null;
  return Math.max(0, Math.ceil(left / 86_400_000));
}

/**
 * The one statement that thaws a frozen row: its expiry moves forward by the
 * time it spent frozen, and `paused_at` is cleared in the same write.
 * `julianday` arithmetic keeps milliseconds; the format is the one every
 * membership timestamp is written in.
 */
const THAW_SET = `expires_at = CASE WHEN expires_at IS NULL THEN NULL
                     ELSE strftime('%Y-%m-%dT%H:%M:%fZ', julianday(expires_at) + (julianday(?1) - julianday(paused_at))) END,
                  paused_at = NULL`;

/** Freeze every running PRO membership now (the admin's «إيقاف PRO»). */
export async function pauseProMemberships(db: D1Database, nowIso: string): Promise<number> {
  const res = await db
    .prepare(
      `UPDATE memberships SET paused_at = ?1
        WHERE tier = 'pro' AND state = 'active' AND paused_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?1)`
    )
    .bind(nowIso)
    .run();
  return Number(res.meta?.changes ?? 0);
}

/** Thaw every frozen PRO membership now (the admin's «استئناف PRO»). */
export async function resumeProMemberships(db: D1Database, nowIso: string): Promise<number> {
  const res = await db
    .prepare(`UPDATE memberships SET ${THAW_SET} WHERE tier = 'pro' AND state = 'active' AND paused_at IS NOT NULL`)
    .bind(nowIso)
    .run();
  return Number(res.meta?.changes ?? 0);
}

/** Freeze ONE row (a PRO membership that became active while the pause was on). */
export async function freezeMembership(db: D1Database, id: string, nowIso: string): Promise<void> {
  await db.prepare(`UPDATE memberships SET paused_at = ?1 WHERE id = ?2 AND paused_at IS NULL AND state = 'active'`).bind(nowIso, id).run();
}

/** Thaw ONE row the bulk resume missed. Conditional on the freeze it read, so it runs once. */
export async function thawMembership(db: D1Database, id: string, pausedAt: string, nowIso: string): Promise<void> {
  await db.prepare(`UPDATE memberships SET ${THAW_SET} WHERE id = ?2 AND paused_at = ?3`).bind(nowIso, id, pausedAt).run();
}
