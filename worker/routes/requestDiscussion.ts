/**
 * THE DISCUSSION UNDER A REQUEST — /api/marketplace/requests/:id/comments
 * (docs/COMMUNITY_ECOSYSTEM.md §9.5, migration 0160).
 *
 * One thread, four kinds of row, and the server decides who may write which:
 *
 *   public_comment    anyone signed in, while the request is ON THE BOARD
 *                     (public, taking offers, not expired — `onPublicBoard`,
 *                     the same question every other door asks);
 *   merchant_question a workshop whose LIVE verdict says it can make the job
 *                     (`liveVerdictForUser`, the authority behind an offer),
 *                     or the one store a direct request was addressed to;
 *   customer_answer   the customer, naming the question it answers
 *                     (`parent_id` → a visible merchant_question of this
 *                     request);
 *   system_update     never a client's: the server writes «تغيّر الطلب»,
 *                     «قُبل عرض», «أُلغي» beside the comments
 *                     (`writeRequestSystemUpdate`), so the page reads as one
 *                     conversation rather than a comment list next to a log.
 *
 * WHO READS is who may see the request: its customer, staff, the engaged
 * merchant, the direct store, and — while it is on the board — everyone
 * (`discussionAccess`). Removed rows are omitted; hidden rows reach staff only.
 * Every list reads one row more than asked, so `next_cursor` exists exactly
 * when a next page does (D8).
 *
 * A report of a comment rides the EXISTING `community_reports` table under
 * target_type 'comment' — its 0154 CHECK is not rebuilt — and the side table
 * `community_report_targets` (kind request_comment) says which row is meant,
 * written in the same batch so the moderation queue resolves the real target.
 *
 * Refusals are codes the client words (src/lib/refusalStrings.ts):
 * COMMENT_KIND_NOT_ALLOWED, COMMENT_TOO_LONG, COMMENT_PARENT_INVALID,
 * COMMENT_NOT_FOUND, plus the social door's COMMENT_INDECENT, BLOCKED and
 * REPORT_TARGET_NOT_FOUND.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env, SessionUser } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, badRequest, notFound, requireAuth, str, int, oneOf, jsonObject } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { requireCommunityOpen } from '../lib/communityGate';
import { feedCursor } from '../lib/feedCursor';
import { isIndecent } from '../lib/nameGuard';
import { loadOwnerTerms } from '../lib/decency';
import { blockedEither } from '../lib/userBlocks';
import { isDirectMerchant, isEngagedMerchant, onPublicBoard, type RequestForAccess } from '../lib/communityRequests';
import { liveVerdictForUser } from '../lib/printMatchingStore';
import { notifyGrouped, peopleAr, stampGroupedCkb } from '../lib/notifications';
import { customOrderCustomerLink } from '../lib/customOrderNotify';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { merchantHref } from '@levonis/contracts/merchantRoutes';

export const requestDiscussionRoutes = new Hono<AppContext>();

const nowIso = () => new Date().toISOString();

// ----------------------------------------------------------------- shapes

export const COMMENT_KINDS = ['public_comment', 'merchant_question', 'customer_answer', 'system_update'] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];
/** The kinds a client may send; `system_update` is the server's alone. */
const CLIENT_KINDS = ['public_comment', 'merchant_question', 'customer_answer'] as const;

/** The most a comment carries (§9.5: «body ≤ 1000»). */
export const COMMENT_MAX = 1000;

/** The codes a system row may carry — what happened to the request, not prose. */
export const SYSTEM_UPDATE_CODES = ['revised', 'accepted', 'cancelled', 'completed', 'expired', 'disputed', 'republished'] as const;
export type SystemUpdateCode = (typeof SYSTEM_UPDATE_CODES)[number];

const REPORT_REASONS = ['spam', 'abuse', 'nudity', 'fraud', 'copyright', 'offtopic', 'other'] as const;

interface RequestRow extends RequestForAccess {
  title: string;
  /** For the viewer the row was loaded for: an engaged merchant of it, the store a direct request names, a workshop at all. */
  v_engaged?: number;
  v_direct?: number;
  v_merchant?: number;
}

type Access = 'owner' | 'admin' | 'engaged' | 'direct' | 'board';

const idParam = (c: Context<AppContext>, name = 'id') => str(c.req.param(name), name, { min: 1, max: 60 });

async function loadRequest(db: D1Database, id: string): Promise<RequestRow | null> {
  return db
    .prepare('SELECT id, customer_id, state, visibility, expires_at, title FROM community_requests WHERE id = ?')
    .bind(id)
    .first<RequestRow>();
}

/**
 * THE REQUEST AND WHO THE VIEWER IS TO IT, IN ONE READ (review 2026-09-30):
 * the engaged-merchant and direct-store questions (`isEngagedMerchant`,
 * `isDirectMerchant` — the same SQL, folded in) and «owns a workshop» ride
 * the request's own SELECT, so a signed-in reader pays one wave before the
 * list instead of three.
 */
async function loadRequestFor(db: D1Database, id: string, viewerId: string): Promise<RequestRow | null> {
  return db
    .prepare(
      `SELECT r.id, r.customer_id, r.state, r.visibility, r.expires_at, r.title,
              CASE WHEN ?2 = '' THEN 0 ELSE EXISTS (
                SELECT 1 FROM community_offers o JOIN community_merchants m ON m.id = o.merchant_id
                 WHERE o.request_id = r.id AND m.user_id = ?2 AND o.state = 'accepted'
                   AND (EXISTS (SELECT 1 FROM community_orders co WHERE co.offer_id = o.id AND co.state NOT IN ('cancelled','refunded'))
                        OR NOT EXISTS (SELECT 1 FROM community_orders co WHERE co.offer_id = o.id))) END AS v_engaged,
              CASE WHEN ?2 = '' OR r.visibility <> 'direct' THEN 0 ELSE EXISTS (
                SELECT 1 FROM community_merchants dm WHERE dm.id = r.target_merchant_id AND dm.user_id = ?2) END AS v_direct,
              CASE WHEN ?2 = '' THEN 0 ELSE EXISTS (SELECT 1 FROM community_merchants wm WHERE wm.user_id = ?2) END AS v_merchant
         FROM community_requests r WHERE r.id = ?1`
    )
    .bind(id, viewerId)
    .first<RequestRow>();
}

/**
 * WHO THIS CALLER IS TO THE DISCUSSION — the request page's own rule
 * (worker/routes/marketplace.ts GET /requests/:id): the customer always, staff
 * (hidden rows are theirs to review), the engaged merchant and the direct
 * store whatever the state, and everyone — a guest included — while the
 * request is on the board. Null is the 404 a stranger gets. A row loaded by
 * `loadRequestFor` already carries the engaged / direct answers.
 */
async function discussionAccess(env: Env, r: RequestRow, user: SessionUser | null | undefined): Promise<Access | null> {
  if (user && user.id === r.customer_id) return 'owner';
  if (user?.role === 'admin') return 'admin';
  const engaged = r.v_engaged !== undefined ? Number(r.v_engaged) === 1 : !!user && (await isEngagedMerchant(env.DB, r.id, user.id));
  if (user && engaged) return 'engaged';
  if (r.visibility === 'direct') {
    const direct = r.v_direct !== undefined ? Number(r.v_direct) === 1 : !!user && (await isDirectMerchant(env.DB, r.id, user.id));
    return user && direct ? 'direct' : null;
  }
  return onPublicBoard(r) ? 'board' : null;
}

const COMMENT_COLUMNS = `c.id, c.request_id, c.parent_id, c.kind, c.body, c.state, c.admin_hidden_reason, c.created_at, c.author_id,
       u.name AS a_name, u.username AS a_username, u.creator_public AS a_public,
       CASE WHEN c.author_id = r.customer_id THEN 1 ELSE 0 END AS a_customer,
       EXISTS (SELECT 1 FROM community_merchants am WHERE am.user_id = c.author_id AND am.status <> 'suspended') AS a_merchant`;
const COMMENT_FROM = `FROM community_request_comments c
       JOIN community_requests r ON r.id = c.request_id
       LEFT JOIN users u ON u.id = c.author_id`;

/** One row as the page reads it. A system row has no author and a decoded `system`. */
function commentPublic(row: Record<string, unknown>, viewer: SessionUser | null | undefined) {
  const kind = String(row.kind) as CommentKind;
  const mine = !!viewer && viewer.id === row.author_id;
  if (kind === 'system_update') {
    const decoded = safeParse<{ code?: string; meta?: Record<string, unknown> }>(row.body, {}) ?? {};
    return {
      id: String(row.id),
      request_id: String(row.request_id),
      parent_id: null,
      kind,
      body: '',
      state: String(row.state) as 'visible' | 'hidden',
      created_at: String(row.created_at),
      author: null,
      system: { code: String(decoded.code ?? ''), meta: decoded.meta && typeof decoded.meta === 'object' ? decoded.meta : {} },
      viewer: { mine: false, can_remove: false },
    };
  }
  return {
    id: String(row.id),
    request_id: String(row.request_id),
    parent_id: (row.parent_id as string | null) ?? null,
    kind,
    body: String(row.body ?? ''),
    state: String(row.state) as 'visible' | 'hidden',
    created_at: String(row.created_at),
    author: {
      id: String(row.author_id ?? ''),
      name: String(row.a_name ?? ''),
      /**
       * CLOSED PAGES ARE CLOSED FROM EVERY SIDE (D4; the comment door's own
       * rule, communitySocial.ts `commentPublic`): the handle is a way to a
       * page, so it is sent only when that page exists — the member made
       * their creator page public, or they are a workshop, whose store is.
       * Everyone else is their name alone, to every reader, a guest included.
       */
      username:
        Number(row.a_public ?? 0) === 1 || Number(row.a_merchant ?? 0) === 1 ? ((row.a_username as string | null) ?? null) : null,
      /** The customer of this request, a workshop, or a member of the community. */
      role: Number(row.a_customer) === 1 ? ('customer' as const) : Number(row.a_merchant) === 1 ? ('merchant' as const) : ('member' as const),
    },
    system: null,
    viewer: { mine, can_remove: mine },
    ...(viewer?.role === 'admin' && row.state === 'hidden' ? { admin_hidden_reason: String(row.admin_hidden_reason ?? '') } : {}),
  };
}

/**
 * The page is read ONE row longer than asked, so the cursor exists only when
 * a next page really does (D8). `rows` is trimmed in place.
 */
function nextCursor(rows: Array<Record<string, unknown>>, limit: number): string | null {
  if (rows.length <= limit) return null;
  rows.length = limit;
  const last = rows[rows.length - 1];
  return `${String(last.created_at)}|${String(last.id)}`;
}

async function loadComment(db: D1Database, id: string): Promise<Record<string, unknown> | null> {
  return db.prepare(`SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM} WHERE c.id = ?`).bind(id).first<Record<string, unknown>>();
}

// ---------------------------------------------------------- system rows

/**
 * THE SERVER'S OWN ROW IN THE THREAD, as a statement for a caller's batch:
 * «تغيّر الطلب» on a revision, «قُبل عرض» on the acceptance, «أُلغي» /
 * «انتهى» on a close. The body is `{code, meta}` as JSON; the page decodes it
 * and words it in the reader's language. `meta` must never carry a person's
 * contact or a cost line — it is read by everyone who may see the request.
 */
export function requestSystemUpdateStatement(
  db: D1Database,
  requestId: string,
  code: SystemUpdateCode,
  meta: Record<string, unknown> = {},
  ts: string = nowIso()
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO community_request_comments (id, request_id, author_id, parent_id, kind, body, state, created_at, updated_at)
       VALUES (?1, ?2, NULL, NULL, 'system_update', ?3, 'visible', ?4, ?4)`
    )
    .bind(newId('rqc'), requestId, JSON.stringify({ code, meta }), ts);
}

/**
 * The same row, written on its own AFTER a transition committed. Never
 * throws: a discussion that could not be told must not undo a cancellation
 * or an acceptance (the pattern of every notifier here). Returns whether the
 * row landed — false on a database behind 0160 as well.
 */
export async function writeRequestSystemUpdate(
  db: D1Database,
  requestId: string,
  code: SystemUpdateCode,
  meta: Record<string, unknown> = {}
): Promise<boolean> {
  try {
    const res = await requestSystemUpdateStatement(db, requestId, code, meta).run();
    return Number(res.meta.changes ?? 0) > 0;
  } catch (e) {
    console.error(`request system update not written (${code})`, requestId, e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ---------------------------------------------------------------- reading

requestDiscussionRoutes.get('/requests/:id/comments', requireCommunityOpen, async (c) => {
  const id = idParam(c);
  const viewer = c.get('user') ?? null;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = feedCursor(c.req.query('cursor'));
  const r = await loadRequestFor(c.env.DB, id, viewer?.id ?? '');
  if (!r) throw notFound('Request not found');
  const access = await discussionAccess(c.env, r, viewer);
  if (!access) throw notFound('Request not found');
  const admin = access === 'admin' ? 1 : 0;

  /**
   * THE THREAD IN THE ORDER IT WAS WRITTEN. Two rows of one millisecond (a
   * comment and the system row a revision writes beside it) are ordered by
   * insertion — `rowid` — not by their random ids, which put «تغيّر الطلب»
   * before the comment that preceded it about one read in five (review
   * 2026-09-30). The cursor stays `created_at|id`; the tie is resolved on the
   * cursor row's own rowid. `total` is the first page's business alone.
   */
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM}
        WHERE c.request_id = ?1 AND (c.state = 'visible' OR (c.state = 'hidden' AND ?2 = 1))
          AND (?3 = '' OR c.created_at > ?3
               OR (c.created_at = ?3 AND c.rowid > (SELECT k.rowid FROM community_request_comments k WHERE k.id = ?4)))
        ORDER BY c.created_at ASC, c.rowid ASC LIMIT ?5`
    )
      .bind(id, admin, cursor.at, cursor.id, limit + 1)
      .all<Record<string, unknown>>(),
    cursor.at === ''
      ? c.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM community_request_comments c WHERE c.request_id = ?1 AND c.state = 'visible' AND c.kind <> 'system_update'`
        )
          .bind(id)
          .first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  const merchant = viewer && access !== 'owner' ? Number(r.v_merchant ?? 0) === 1 : false;
  const next_cursor = nextCursor(results, limit);
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    success: true,
    comments: results.map((row) => commentPublic(row, viewer)),
    next_cursor,
    /** The first page carries the count; a later page null (it is the same thread). */
    total: total ? Number(total.n ?? 0) : null,
    /**
     * What this viewer may do here — a hint for the composer, never the
     * authority: the POST decides again, and `ask` is only «you own a
     * workshop and the request still takes questions» (the live verdict is
     * asked when the question is sent, so a page read writes no verdict).
     */
    can: {
      comment: !!viewer && onPublicBoard(r),
      ask: !!viewer && !!merchant && (access === 'direct' || onPublicBoard(r)),
      answer: access === 'owner',
    },
  });
});

// ---------------------------------------------------------------- writing

const excerptOf = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

/** The actor as the bell names them: the row's name (a session may carry none), then the handle. */
async function displayNameOf(db: D1Database, user: SessionUser): Promise<string> {
  const r = await db.prepare('SELECT name, username FROM users WHERE id = ?').bind(user.id).first<{ name: string | null; username: string | null }>();
  return r?.name || user.name || r?.username || user.username || '';
}
const quoteAr = (s: string) => `«${s}»`;
const quoteEn = (s: string) => `“${s}”`;
const questionsAr = (n: number) => (n === 2 ? 'سؤالان جديدان' : n >= 3 && n <= 10 ? `${n} أسئلة جديدة` : `${n} سؤالًا جديدًا`);
const answersAr = (n: number) => (n === 2 ? 'ردّان' : n >= 3 && n <= 10 ? `${n} ردود` : `${n} ردًّا`);

/**
 * WHO IS TOLD, AND HOW (§9.5): a public comment reaches the customer as ONE
 * row per request whose count is PEOPLE; a question reaches the customer and
 * an answer reaches the workshop that asked, each as one row per thread that
 * comes back unread on every new message (`repeatActor: 'bump'`) — the same
 * person asking twice is two questions. Sorani is stamped after the upsert,
 * the way every grouped notice does it. Never throws.
 */
async function tellAboutComment(
  env: Env,
  p: { r: RequestRow; kind: Exclude<CommentKind, 'system_update'>; actor: SessionUser; body: string; parentAuthorId: string | null; parentId: string | null }
): Promise<void> {
  const { r, actor } = p;
  const title = String(r.title ?? '');
  const excerpt = excerptOf(p.body);
  const customerLink = `${customOrderCustomerLink(r.id)}#discussion`;
  try {
    const name = await displayNameOf(env.DB, actor);
    if (p.kind === 'public_comment' && r.customer_id !== actor.id) {
      const written = await notifyGrouped(env.DB, {
        userId: r.customer_id,
        kind: 'request_comment',
        groupKey: `request_comment:${r.id}`,
        actor: { id: actor.id, name },
        title: (n, a) => ({
          ar: n === 1 ? `علّق ${a} على طلبك ${quoteAr(title)}` : `علّق ${peopleAr(n)} على طلبك ${quoteAr(title)}`,
          en: n === 1 ? `${a} commented on your request ${quoteEn(title)}` : `${n} people commented on your request ${quoteEn(title)}`,
        }),
        body: { ar: excerpt, en: excerpt },
        link: customerLink,
        entity_type: 'request',
        entity_id: r.id,
      });
      if (written) {
        await stampGroupedCkb(env.DB, written.id, {
          title_ckb:
            written.count === 1
              ? `${name} کۆمێنتی لەسەر داواکارییەکەت نووسی ${quoteAr(title)}`
              : `${written.count} کەس کۆمێنتیان لەسەر داواکارییەکەت نووسی ${quoteAr(title)}`,
          body_ckb: excerpt,
        });
      }
    } else if (p.kind === 'merchant_question' && r.customer_id !== actor.id) {
      const written = await notifyGrouped(env.DB, {
        userId: r.customer_id,
        kind: 'request_question',
        groupKey: `request_question:${r.id}`,
        actor: { id: actor.id, name },
        repeatActor: 'bump',
        title: (n, a) => ({
          ar: n === 1 ? `سأل ${a} عن طلبك ${quoteAr(title)}` : `${questionsAr(n)} عن طلبك ${quoteAr(title)}`,
          en: n === 1 ? `${a} asked about your request ${quoteEn(title)}` : `${n} new questions about your request ${quoteEn(title)}`,
        }),
        body: { ar: excerpt, en: excerpt },
        link: customerLink,
        entity_type: 'request',
        entity_id: r.id,
      });
      if (written) {
        await stampGroupedCkb(env.DB, written.id, {
          title_ckb:
            written.count === 1
              ? `${name} پرسیارێکی لەسەر داواکارییەکەت کرد ${quoteAr(title)}`
              : `${written.count} پرسیاری نوێ لەسەر داواکارییەکەت ${quoteAr(title)}`,
          body_ckb: excerpt,
        });
      }
    } else if (p.kind === 'customer_answer' && p.parentAuthorId && p.parentId && p.parentAuthorId !== actor.id) {
      const written = await notifyGrouped(env.DB, {
        userId: p.parentAuthorId,
        kind: 'request_answer',
        groupKey: `request_answer:${p.parentId}`,
        actor: { id: actor.id, name },
        repeatActor: 'bump',
        title: (n) => ({
          ar: n === 1 ? `أجاب الزبون عن سؤالك في ${quoteAr(title)}` : `${answersAr(n)} من الزبون على سؤالك في ${quoteAr(title)}`,
          en: n === 1 ? `The customer answered your question on ${quoteEn(title)}` : `${n} replies from the customer to your question on ${quoteEn(title)}`,
        }),
        body: { ar: excerpt, en: excerpt },
        link: merchantHref.request(r.id),
        entity_type: 'request',
        entity_id: r.id,
      });
      if (written) {
        await stampGroupedCkb(env.DB, written.id, {
          title_ckb:
            written.count === 1
              ? `کڕیارەکە وەڵامی پرسیارەکەتی دایەوە لە ${quoteAr(title)}`
              : `${written.count} وەڵام لە کڕیارەکەوە بۆ پرسیارەکەت لە ${quoteAr(title)}`,
          body_ckb: excerpt,
        });
      }
    }
  } catch (e) {
    console.error('discussion notice failed', r.id, p.kind, e instanceof Error ? e.message : String(e));
  }
}

requestDiscussionRoutes.post('/requests/:id/comments', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'request-comment', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  const raw = await jsonObject(c);

  // The kind first: a client naming the server's own kind is refused with the
  // code, not with a validation sentence about a list it was never offered.
  if (raw.kind === 'system_update') {
    throw new HttpError(403, 'Only Levonis writes system updates', 'COMMENT_KIND_NOT_ALLOWED', { kind: 'system_update' });
  }
  const kind = oneOf(raw.kind, 'kind', CLIENT_KINDS);
  // The length before anything else, with its own code (§9.5 «body ≤ 1000»).
  if (typeof raw.body === 'string' && raw.body.trim().length > COMMENT_MAX) {
    throw badRequest(`A comment holds at most ${COMMENT_MAX} characters`, 'COMMENT_TOO_LONG', { max: COMMENT_MAX });
  }
  const body = str(raw.body, 'body', { min: 1, max: COMMENT_MAX });
  const parentAsked =
    raw.parent_id === undefined || raw.parent_id === null || raw.parent_id === '' ? null : str(raw.parent_id, 'parent_id', { min: 1, max: 60 });

  const r = await loadRequest(c.env.DB, id);
  if (!r) throw notFound('Request not found');
  const access = await discussionAccess(c.env, r, user);
  if (!access) throw notFound('Request not found');
  // A block is mutual silence on every door (0154): nobody comments on a
  // request across one, in either direction.
  if (access !== 'owner' && (await blockedEither(c.env.DB, user.id, r.customer_id))) {
    throw new HttpError(403, 'You cannot interact with this account', 'BLOCKED');
  }

  // ---- may THIS caller write THIS kind, now --------------------------------
  let parent: Record<string, unknown> | null = null;
  if (parentAsked) {
    parent = await loadComment(c.env.DB, parentAsked);
    if (!parent || parent.request_id !== id || parent.state !== 'visible' || parent.kind === 'system_update') {
      throw badRequest('The comment you are replying to is not in this discussion', 'COMMENT_PARENT_INVALID');
    }
  }
  let parentId: string | null = null;
  switch (kind) {
    case 'public_comment': {
      if (!onPublicBoard(r)) {
        throw new HttpError(403, 'This request no longer takes comments', 'COMMENT_KIND_NOT_ALLOWED', { kind, reason: 'REQUEST_CLOSED' });
      }
      // One level of replies: a reply to a reply files under the thread's root.
      parentId = parent ? String((parent.parent_id as string | null) ?? parent.id) : null;
      break;
    }
    case 'merchant_question': {
      if (access === 'owner') {
        throw new HttpError(403, 'You cannot ask a question on your own request', 'COMMENT_KIND_NOT_ALLOWED', { kind, reason: 'OWN_REQUEST' });
      }
      // The direct store may ask about the job it was sent; a board request
      // takes questions from a workshop whose LIVE verdict can make it — the
      // same authority that admits its offer (worker/lib/printMatchingStore.ts).
      let reason = 'NOT_ELIGIBLE';
      let eligible = false;
      if (r.visibility === 'direct') {
        eligible = access === 'direct' || access === 'engaged';
      } else if (!onPublicBoard(r)) {
        reason = 'REQUEST_CLOSED';
      } else {
        const live = await liveVerdictForUser(c.env, r.id, user.id);
        eligible = !!live?.verdict.eligible;
        reason = live?.verdict.reason || (live ? 'NOT_ELIGIBLE' : 'NOT_A_WORKSHOP');
      }
      if (!eligible) {
        throw new HttpError(403, 'Your workshop cannot take this request, so it cannot ask about it', 'COMMENT_KIND_NOT_ALLOWED', { kind, reason });
      }
      parentId = parent ? String((parent.parent_id as string | null) ?? parent.id) : null;
      break;
    }
    case 'customer_answer': {
      if (access !== 'owner') {
        throw new HttpError(403, 'Only the customer answers questions on their request', 'COMMENT_KIND_NOT_ALLOWED', { kind, reason: 'NOT_CUSTOMER' });
      }
      // An answer answers a question of THIS request — never a comment, never
      // another answer, never a question from somewhere else.
      if (!parent || parent.kind !== 'merchant_question') {
        throw badRequest('An answer must name the question it answers', 'COMMENT_PARENT_INVALID');
      }
      parentId = String(parent.id);
      break;
    }
  }

  // The decency filter the post comments use: the owner's terms on top of the
  // seed. The message never names what was found.
  if (isIndecent(body, await loadOwnerTerms(c.env.DB))) throw badRequest('Please reword your comment', 'COMMENT_INDECENT');

  const commentId = newId('rqc');
  const ts = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO community_request_comments (id, request_id, author_id, parent_id, kind, body, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'visible', ?, ?)`
  )
    .bind(commentId, id, user.id, parentId, kind, body, ts, ts)
    .run();

  await tellAboutComment(c.env, {
    r,
    kind,
    actor: user,
    body,
    parentAuthorId: parent ? String(parent.author_id ?? '') || null : null,
    parentId: parent ? String(parent.id) : null,
  });

  const made = await loadComment(c.env.DB, commentId);
  return c.json({ success: true, comment: commentPublic(made!, user) }, 201);
});

/**
 * REMOVE A COMMENT — its author's own, and nobody else's here (staff hide
 * through moderation, with a reason). The row stays as `removed` and leaves
 * the thread; a second press, or a press on a row that is not the caller's,
 * is the same 404 a missing comment gets.
 */
requestDiscussionRoutes.delete('/requests/:id/comments/:cid', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idParam(c);
  const cid = idParam(c, 'cid');
  const row = await c.env.DB.prepare(
    `SELECT id, state, kind FROM community_request_comments WHERE id = ? AND request_id = ? AND author_id = ? AND kind <> 'system_update'`
  )
    .bind(cid, id, user.id)
    .first<{ id: string; state: string; kind: string }>();
  if (!row) throw new HttpError(404, 'Comment not found', 'COMMENT_NOT_FOUND');
  if (row.state === 'visible') {
    await c.env.DB.prepare(`UPDATE community_request_comments SET state = 'removed', updated_at = ? WHERE id = ? AND state = 'visible'`)
      .bind(nowIso(), cid)
      .run();
  }
  return c.json({ success: true });
});

// --------------------------------------------------------------- reporting

/**
 * «إبلاغ» ON A COMMENT. Filed in `community_reports` as target_type 'comment'
 * (the 0154 CHECK is kept), once per reporter per row, and the side table
 * names the real target in the SAME batch — a report whose target row did not
 * land is impossible, and a replay files nothing twice. The comment must be
 * one the reporter may read: a visible, human-written row of a request they
 * may see; anything else is the door's usual «we could not find it».
 */
requestDiscussionRoutes.post('/requests/:id/comments/:cid/report', requireAuth, async (c) => {
  await rateLimit(c, 'report', 20, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  const cid = idParam(c, 'cid');
  const raw = await jsonObject(c);
  const reason = oneOf(raw.reason, 'reason', REPORT_REASONS);
  const details = str(raw.details, 'details', { min: 0, max: 1000, required: false });

  const r = await loadRequest(c.env.DB, id);
  const access = r ? await discussionAccess(c.env, r, user) : null;
  const target = access
    ? await c.env.DB.prepare(
        `SELECT id FROM community_request_comments WHERE id = ? AND request_id = ? AND state = 'visible' AND kind <> 'system_update'`
      )
        .bind(cid, id)
        .first<{ id: string }>()
    : null;
  if (!target) throw new HttpError(404, 'We could not find what you are reporting', 'REPORT_TARGET_NOT_FOUND');

  const reportId = newId('rpt');
  const [ins] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO community_reports (id, reporter_id, target_type, target_id, reason, details) VALUES (?, ?, 'comment', ?, ?, ?)
       ON CONFLICT(reporter_id, target_type, target_id) DO NOTHING`
    ).bind(reportId, user.id, cid, reason, details),
    // Only for the report THIS batch filed: a replay's report id was never
    // written, so the side row is not either.
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO community_report_targets (report_id, kind, target_id)
       SELECT ?1, 'request_comment', ?2 WHERE EXISTS (SELECT 1 FROM community_reports WHERE id = ?1)`
    ).bind(reportId, cid),
  ]);
  if (!Number(ins.meta.changes ?? 0)) {
    const existing = await c.env.DB.prepare(`SELECT id FROM community_reports WHERE reporter_id = ? AND target_type = 'comment' AND target_id = ?`)
      .bind(user.id, cid)
      .first<{ id: string }>();
    return c.json({ success: true, report_id: existing?.id ?? null, replayed: true });
  }
  await audit(c.env.DB, user.id, 'community.report', reportId, { target_type: 'comment', target_id: cid, real: 'request_comment', request_id: id, reason });
  announceAfterResponse(
    c,
    'report',
    `🚩 بلاغ جديد في المجتمع` + `\nType: request_comment` + `\nTarget: ${cid}` + `\nRequest: ${id}` + `\nReason: ${reason}` + `\nReport: ${reportId}`
  );
  return c.json({ success: true, report_id: reportId }, 201);
});
