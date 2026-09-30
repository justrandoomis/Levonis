/**
 * AN ACCOUNT'S STANDING — Moderation V2 (0162; docs/COMMUNITY_ECOSYSTEM.md
 * §9.6 «Enforcement»).
 *
 * `users.status` is one of four words, and each one takes away a little more:
 *
 *   active      everything.
 *   restricted  reads stay; no new posts, comments, offers, requests or direct
 *               messages. Likes and follows stay — the account is quiet, not
 *               gone. The account's public content stays visible.
 *   suspended   the same, plus no likes and no follows — and the account's
 *               public content is hidden: its posts leave every list, its
 *               comments leave every thread, its creator page answers the
 *               same 404 a private page answers.
 *   banned      every write is refused (`refuseBannedWrites`, one middleware
 *               in worker/index.ts, before the routers) except signing out,
 *               the appeal door and marking a notification read; the public
 *               content is hidden exactly as for a suspension.
 *
 * TIME IS READ, NEVER SWEPT. A restriction or a suspension may carry
 * `status_until`; once that instant passes the account reads `active` again —
 * here in `effectiveStatus`, and in SQL through `AUTHOR_VISIBLE_SQL` — so no
 * cron has to run for a suspension to end, and no cron that failed to run can
 * keep one in force. A ban has no end date: it lasts until a `restore`.
 *
 * WHO DECIDES. Only the moderation desk writes `users.status`
 * (worker/routes/adminModeration.ts), and every decision is a
 * `moderation_actions` row, an `audit_log` row and a notice to the person
 * with the reason and the appeal door. The session row is `SELECT u.*`
 * (worker/lib/session.ts), so a decision is in force from the person's next
 * request — no session is revoked, because a banned person must still be able
 * to read why and to appeal.
 *
 * Refusals are codes the client words (src/lib/refusalStrings.ts):
 * USER_RESTRICTED, USER_SUSPENDED, USER_BANNED — each with the end date in
 * `details.until` when there is one, so the banner can say until when.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppContext } from './types';
import { HttpError } from './http';

export const USER_STATUSES = ['active', 'restricted', 'suspended', 'banned'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** The kinds of write a status can take away. */
export const WRITE_KINDS = ['post', 'comment', 'offer', 'request', 'dm', 'follow', 'like'] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];

/** What a restriction takes away; a suspension takes these and more. */
const RESTRICTED_KINDS: ReadonlySet<WriteKind> = new Set<WriteKind>(['post', 'comment', 'offer', 'request', 'dm']);
const SUSPENDED_KINDS: ReadonlySet<WriteKind> = new Set<WriteKind>([...RESTRICTED_KINDS, 'follow', 'like']);

/** The columns a standing is read from — the session user, a joined author row, a stored users row. */
export interface StandingFields {
  status?: unknown;
  status_until?: unknown;
}

/** The order of the ladder: a higher number takes away more. */
export const STATUS_LEVEL: Readonly<Record<UserStatus, number>> = { active: 0, restricted: 1, suspended: 2, banned: 3 };

const isStatus = (v: unknown): v is UserStatus => typeof v === 'string' && (USER_STATUSES as readonly string[]).includes(v);

/**
 * Has this end date passed? An unreadable or absent date never has — a
 * restriction with a garbled `status_until` stays in force rather than
 * silently lifting.
 */
export function untilPassed(until: unknown, now: number = Date.now()): boolean {
  if (typeof until !== 'string' || until === '') return false;
  const at = Date.parse(until);
  return Number.isFinite(at) && at <= now;
}

/**
 * THE STANDING IN FORCE NOW. A row the migration has not reached (no column,
 * a test double) reads `active`, which is what every account was before 0162.
 * A restriction or a suspension whose end date has passed reads `active`; a
 * ban never lapses.
 */
export function effectiveStatus(u: StandingFields | null | undefined, now: number = Date.now()): UserStatus {
  const s = u && isStatus(u.status) ? u.status : 'active';
  if ((s === 'restricted' || s === 'suspended') && untilPassed(u?.status_until, now)) return 'active';
  return s;
}

/** Is the account's public content hidden right now (suspended or banned)? */
export function authorHidden(u: StandingFields | null | undefined, now: number = Date.now()): boolean {
  const s = effectiveStatus(u, now);
  return s === 'suspended' || s === 'banned';
}

/** The same question for a joined author row whose columns are prefixed `a_` (worker/routes/communityPosts.ts). */
export function authorRowHidden(row: { a_status?: unknown; a_status_until?: unknown } | null | undefined): boolean {
  return !!row && authorHidden({ status: row.a_status, status_until: row.a_status_until });
}

/** The end date the person is told about, or null (a ban, an open-ended restriction, an active account). */
export function standingUntil(u: StandingFields | null | undefined): string | null {
  const s = effectiveStatus(u);
  if (s !== 'restricted' && s !== 'suspended') return null;
  return typeof u?.status_until === 'string' && u.status_until ? u.status_until : null;
}

const ISO_NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/**
 * THE ONE SQL FRAGMENT FOR «may this author's content be shown» — `alias`
 * names a `users` row in scope. Suspended and banned authors are hidden; a
 * suspension whose `status_until` has passed is not (read at query time, the
 * same rule as `effectiveStatus`). `status_until` is stored as ISO 8601 with
 * milliseconds and a `Z`, the shape `strftime('%Y-%m-%dT%H:%M:%fZ','now')`
 * writes, so the two compare as strings.
 */
export const AUTHOR_VISIBLE_SQL = (alias: string): string =>
  `(${alias}.status NOT IN ('suspended','banned') OR (${alias}.status = 'suspended' AND ${alias}.status_until IS NOT NULL AND ${alias}.status_until <= ${ISO_NOW}))`;

/**
 * The accounts whose public content is hidden right now, as a subquery for
 * `<author column> NOT IN (${HIDDEN_AUTHORS_SQL})` where no `users` row is
 * joined (a COUNT, a `json_each` over tags, a grouped subquery). Evaluated
 * once per statement; the leading `status <> 'active'` term is the partial
 * index's own condition (idx_users_moderated, 0162), so it reads only the few
 * moderated accounts, never the whole users table.
 */
// (`hu.id IS NOT NULL`: a NULL in a NOT IN list makes the whole test NULL —
// every row would drop out — and SQLite lets a TEXT primary key hold one.)
export const HIDDEN_AUTHORS_SQL = `SELECT hu.id FROM users hu WHERE hu.status <> 'active' AND hu.id IS NOT NULL AND NOT ${AUTHOR_VISIBLE_SQL('hu')}`;

/**
 * REFUSE A WRITE THIS STANDING TAKES AWAY. Called at each write door with the
 * session user and the kind of write, after `requireAuth`. Synchronous: the
 * session row already carries the status.
 */
export function assertMayWrite(user: StandingFields | null | undefined, kind: WriteKind): void {
  const s = effectiveStatus(user);
  if (s === 'active') return;
  if (s === 'banned') throw new HttpError(403, 'This account is banned', 'USER_BANNED');
  const until = standingUntil(user);
  if (s === 'suspended' && SUSPENDED_KINDS.has(kind)) {
    throw new HttpError(403, 'This account is suspended', 'USER_SUSPENDED', until ? { until } : undefined);
  }
  if (s === 'restricted' && RESTRICTED_KINDS.has(kind)) {
    throw new HttpError(403, 'This account is restricted', 'USER_RESTRICTED', until ? { until } : undefined);
  }
}

/** Is this account under any sanction now? A cheap question a door asks before paying a read to classify its write. */
export function isModerated(user: StandingFields | null | undefined): boolean {
  return effectiveStatus(user) !== 'active';
}

/**
 * The writes a BANNED account keeps: signing out and its own account's
 * security (the auth router), the appeal door, and marking a notification
 * read. Everything else that is not a read is refused.
 */
export function bannedMayWrite(path: string): boolean {
  if (path.startsWith('/api/auth/')) return true;
  if (path === '/api/moderation/appeals' || path.startsWith('/api/moderation/appeals/')) return true;
  if (path === '/api/notifications/read') return true;
  return false;
}

/**
 * ONE MIDDLEWARE, BEFORE THE API ROUTERS (worker/index.ts): a banned account's
 * non-read request is answered 403 USER_BANNED, whatever door it knocks on.
 * Reads stay, so the person can see why and appeal; `bannedMayWrite` lists
 * the three writes that stay with them.
 */
export const refuseBannedWrites: MiddlewareHandler<AppContext> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const path = c.req.path;
  if (!path.startsWith('/api/')) return next();
  const user = c.get('user');
  if (!user || effectiveStatus(user) !== 'banned' || bannedMayWrite(path)) return next();
  throw new HttpError(403, 'This account is banned', 'USER_BANNED');
};
