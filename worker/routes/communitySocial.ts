/**
 * THE SOCIAL GRAPH OF LEVO COMMUNITY — what people DO with what the community
 * makes (0154, 0155; docs/COMMUNITY_ECOSYSTEM.md Phase 2, decisions D8, D9).
 *
 * Like, save and comment on a post; follow a maker; block, mute and report;
 * the feed («لك» and «أتابع») and the creators list. Every one of these is a
 * small table where the ROW is the fact, so every write is idempotent by its
 * primary key: a replayed like answers the same numbers and changes nothing,
 * and the counters on `community_posts` are kept by 0154's triggers, never
 * read from a body.
 *
 * THE RULES, in the order a reader meets them:
 *
 *   · the client sends ids; the server decides. A body never names WHO acts
 *     (the session does) and never carries a count;
 *   · a post is liked, saved or commented on only by someone who may READ it
 *     (`mayRead`), and never across a block — a block is mutual silence on
 *     every door, and every community door answers it the SAME way: the words
 *     a missing thing gets (404). The creator page, the post page, its
 *     comments, a like, a save, a comment, a follow — none of them tells the
 *     blocked side that a block exists. The messaging doors (worker/routes/
 *     chats.ts) are the one place that says BLOCKED, because a thread that
 *     already exists cannot pretend not to;
 *   · a mute is the viewer's own affair: it hides, it tells nobody — and it
 *     keeps the bell quiet too (the muted person's likes, comments and follows
 *     are not announced to the one who muted them);
 *   · a burst of likes, comments or follows is ONE notification whose count is
 *     PEOPLE (`notifyGrouped`: one actor toggling is one person); a save is
 *     private and notifies nobody;
 *   · a comment names its send (`client_id`) and the database refuses the
 *     second landing (0155), so two taps in flight are one comment;
 *   · a report is about one thing, by one person, once — the second press is
 *     a replay, not a second report — and it confirms only what the reporter
 *     could already see.
 *
 * Everything sits inside the community's maintenance wall (communityGate).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, notFound, unauthorized, str, int, oneOf, jsonObject, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { notifyGrouped, peopleAr } from '../lib/notifications';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { feedCursor } from '../lib/feedCursor';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { communityGate } from '../lib/communityGate';
import { membershipBadges } from '../lib/entitlements';
import { isIndecent } from '../lib/nameGuard';
import { loadOwnerTerms } from '../lib/decency';
import { requestBoardVisible } from '../lib/requestBoard';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { COMMUNITY_PRODUCTS_FROM, communityProductsVisible } from './community';
import {
  POST_COLUMNS,
  POST_FROM,
  POST_PUBLIC_SQL,
  postCard,
  postHref,
  loadPostHead,
  mayRead,
  nextPostCursor,
  postExclusionSql,
  blockedEither,
  mutedBy,
  withViewerFlags,
  type PostHead,
} from './communityPosts';

export const communitySocialRoutes = new Hono<AppContext>();
communitySocialRoutes.use('*', communityGate());

// ------------------------------------------------------------------ shared

const fileUrl = (key: unknown) => (typeof key === 'string' && key ? `/files/${key}` : null);
const idParam = (c: Context<AppContext>, name = 'id') => str(c.req.param(name), name, { min: 1, max: 60 });

/**
 * The post a social write is about: readable by this viewer (`mayRead`'s
 * rule — the author and staff always, everyone else what is published), and
 * not across a block with its author. Either failure is the 404 a missing
 * post gets — the block is nobody's business, and the post page itself
 * answers the same. Only the HEAD of the post is read: a like does not need
 * the card's joins.
 */
async function interactablePost(c: Context<AppContext>, id: string): Promise<PostHead> {
  const user = c.get('user')!;
  const p = await loadPostHead(c.env, id);
  if (!p || !mayRead(p, user)) throw notFound('Project not found');
  if (await blockedEither(c.env.DB, user.id, p.author_id)) throw notFound('Project not found');
  return p;
}

async function postCounts(c: Context<AppContext>, id: string) {
  const row = await c.env.DB.prepare('SELECT like_count, save_count, comment_count FROM community_posts WHERE id = ?').bind(id).first<{ like_count: number; save_count: number; comment_count: number }>();
  return { likes: Number(row?.like_count ?? 0), saves: Number(row?.save_count ?? 0), comments: Number(row?.comment_count ?? 0) };
}

const quoteAr = (s: string) => `«${s}»`;
const quoteEn = (s: string) => `“${s}”`;

/** The page the community links a person to: their own when it exists, else the makers' directory. */
function personHref(u: { username: string | null; creator_public: number; merchant: number } | null): string {
  return u && u.username && (Number(u.creator_public) === 1 || Number(u.merchant) === 1) ? `/u/${encodeURIComponent(u.username)}` : '/community?tab=creators';
}

// -------------------------------------------------------------------- likes

communitySocialRoutes.put('/posts/:id/like', requireAuth, async (c) => {
  await rateLimit(c, 'social-like', 240, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  const p = await interactablePost(c, id);
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO community_likes (user_id, post_id) VALUES (?, ?)').bind(user.id, id).run();
  if (res.meta.changes > 0 && p.author_id !== user.id && !(await mutedBy(c.env.DB, p.author_id, user.id))) {
    const title = String(p.title ?? '');
    await notifyGrouped(c.env.DB, {
      userId: p.author_id,
      kind: 'post_liked',
      groupKey: `post_liked:${id}`,
      actor: { id: user.id, name: user.name || user.username || '' },
      title: (n, actor) => ({
        ar: n === 1 ? `أعجب ${actor} بمشروعك ${quoteAr(title)}` : `أعجب ${peopleAr(n)} بمشروعك ${quoteAr(title)}`,
        en: n === 1 ? `${actor} liked your project ${quoteEn(title)}` : `${n} people liked your project ${quoteEn(title)}`,
      }),
      link: postHref(id),
      entity_type: 'community_post',
      entity_id: id,
    });
  }
  const counts = await postCounts(c, id);
  return c.json({ success: true, liked: true, likes: counts.likes });
});

communitySocialRoutes.delete('/posts/:id/like', requireAuth, async (c) => {
  await rateLimit(c, 'social-like', 240, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  await interactablePost(c, id);
  await c.env.DB.prepare('DELETE FROM community_likes WHERE user_id = ? AND post_id = ?').bind(user.id, id).run();
  const counts = await postCounts(c, id);
  return c.json({ success: true, liked: false, likes: counts.likes });
});

// -------------------------------------------------------------------- saves

communitySocialRoutes.put('/posts/:id/save', requireAuth, async (c) => {
  await rateLimit(c, 'social-save', 240, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  const body = await jsonObject(c);
  const collection = str(body.collection, 'collection', { min: 0, max: 40, required: false });
  await interactablePost(c, id);
  // A second save with another collection name MOVES the save; the counter
  // (an INSERT trigger) is untouched by the update branch.
  await c.env.DB.prepare(
    'INSERT INTO community_saves (user_id, post_id, collection) VALUES (?, ?, ?) ON CONFLICT(user_id, post_id) DO UPDATE SET collection = excluded.collection'
  )
    .bind(user.id, id, collection)
    .run();
  const counts = await postCounts(c, id);
  return c.json({ success: true, saved: true, saves: counts.saves });
});

communitySocialRoutes.delete('/posts/:id/save', requireAuth, async (c) => {
  await rateLimit(c, 'social-save', 240, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  await interactablePost(c, id);
  await c.env.DB.prepare('DELETE FROM community_saves WHERE user_id = ? AND post_id = ?').bind(user.id, id).run();
  const counts = await postCounts(c, id);
  return c.json({ success: true, saved: false, saves: counts.saves });
});

/**
 * «المحفوظات»: newest saved first. A saved post that has since gone private,
 * been archived or hidden drops out (the author's own stay); one whose author
 * is now blocked either way drops out too.
 */
communitySocialRoutes.get('/saved', requireAuth, async (c) => {
  const user = c.get('user')!;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 18 });
  const cursor = feedCursor(c.req.query('cursor'));
  const root = rootDomainFrom(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_COLUMNS}, sv.created_at AS saved_at, sv.collection AS saved_collection
       ${POST_FROM}
       JOIN community_saves sv ON sv.post_id = p.id AND sv.user_id = ?1
      WHERE (p.author_id = ?1 OR (p.state = 'published' AND p.visibility IN ('public','unlisted') AND p.admin_hidden_at IS NULL AND p.consent_status IN ('not_needed','granted')))
        AND ${postExclusionSql('?1')}
        AND (?2 = '' OR sv.created_at < ?2 OR (sv.created_at = ?2 AND sv.post_id < ?3))
      ORDER BY sv.created_at DESC, sv.post_id DESC LIMIT ?4`
  )
    .bind(user.id, cursor.at, cursor.id, limit + 1)
    .all<Record<string, unknown>>();
  const next_cursor = nextPostCursor(results, limit, 'saved_at');
  const cards = await withViewerFlags(c.env.DB, user.id, results.map((p) => postCard(p, root)));
  return c.json({
    success: true,
    posts: cards.map((card, i) => ({ ...card, saved_at: String(results[i].saved_at), collection: String(results[i].saved_collection ?? '') })),
    next_cursor,
  });
});

// ----------------------------------------------------------------- comments

const COMMENT_MIN = 2;
const COMMENT_MAX = 2000;
/** Two comments by one person under one post are at least this far apart. */
const COMMENT_COOLDOWN_MS = 10_000;

const COMMENT_COLUMNS = `cm.id, cm.post_id, cm.parent_id, cm.body, cm.state, cm.created_at, cm.author_id,
       u.username AS a_username, u.name AS a_name, u.avatar_key AS a_avatar, u.creator_public AS a_public,
       EXISTS (SELECT 1 FROM community_merchants acm WHERE acm.user_id = u.id AND acm.status <> 'suspended') AS a_merchant`;
const COMMENT_FROM = 'FROM community_comments cm JOIN users u ON u.id = cm.author_id';

function commentPublic(r: Record<string, unknown>, viewer: { id: string; role: string } | null, postAuthorId: string) {
  const mine = !!viewer && viewer.id === r.author_id;
  if (r.state === 'removed') {
    // A stub keeps the replies' place; it says nothing about who wrote it.
    return {
      id: String(r.id),
      post_id: String(r.post_id),
      parent_id: (r.parent_id as string | null) ?? null,
      body: '',
      state: 'removed' as const,
      created_at: String(r.created_at),
      author: null,
      viewer: { mine: false, can_remove: false },
    };
  }
  const pageExists = Number(r.a_public) === 1 || Number(r.a_merchant) === 1;
  return {
    id: String(r.id),
    post_id: String(r.post_id),
    parent_id: (r.parent_id as string | null) ?? null,
    body: String(r.body ?? ''),
    state: String(r.state) as 'visible' | 'hidden',
    created_at: String(r.created_at),
    author: {
      id: String(r.author_id),
      username: pageExists ? ((r.a_username as string | null) ?? null) : null,
      name: String(r.a_name ?? ''),
      avatarUrl: fileUrl(r.a_avatar),
    },
    viewer: {
      mine,
      can_remove: mine || (!!viewer && viewer.id === postAuthorId),
    },
  };
}

/**
 * Nothing by an author blocked either way or muted by the viewer. `?v` is the
 * viewer's id or '' (a guest sees everyone). A `cm` alias must be in scope.
 */
const commentAuthorOkSql = (v: string) => `(${v} = '' OR (
      NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.user_id = ${v} AND b.blocked_id = cm.author_id) OR (b.user_id = cm.author_id AND b.blocked_id = ${v}))
  AND NOT EXISTS (SELECT 1 FROM user_mutes mu WHERE mu.user_id = ${v} AND mu.muted_id = cm.author_id)))`;

/**
 * Which comment rows THIS viewer is served: visible ones and removed stubs
 * for everybody; hidden ones only for staff and their own author; and never
 * an author the viewer must not meet (their replies stay, as replies to a
 * parent the client no longer has — it treats them as top-level). `?a` is 1
 * for staff.
 */
const commentVisibleSql = (v: string, admin: string) => `(
      cm.state IN ('visible','removed')
      OR (cm.state = 'hidden' AND (${admin} = 1 OR cm.author_id = ${v}))
  ) AND ${commentAuthorOkSql(v)}`;

communitySocialRoutes.get('/posts/:id/comments', async (c) => {
  const id = idParam(c);
  const viewer = c.get('user') ?? null;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 50, def: 20 });
  const cursor = feedCursor(c.req.query('cursor'));
  const p = await loadPostHead(c.env, id);
  if (!p || !mayRead(p, viewer)) throw notFound('Project not found');
  if (viewer && (await blockedEither(c.env.DB, viewer.id, p.author_id))) throw notFound('Project not found');
  const v = viewer?.id ?? '';
  const admin = viewer?.role === 'admin' ? 1 : 0;
  // `total` is what THIS viewer can be shown — the same author rule as the
  // page — so the sheet's title and its «عرض المزيد» agree with its rows. The
  // card's counter (a trigger value) stays the post's own number.
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM}
        WHERE cm.post_id = ?1 AND ${commentVisibleSql('?2', '?3')}
          AND (?4 = '' OR cm.created_at > ?4 OR (cm.created_at = ?4 AND cm.id > ?5))
        ORDER BY cm.created_at ASC, cm.id ASC LIMIT ?6`
    )
      .bind(id, v, admin, cursor.at, cursor.id, limit + 1)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM community_comments cm WHERE cm.post_id = ?1 AND cm.state = 'visible' AND ${commentAuthorOkSql('?2')}`)
      .bind(id, v)
      .first<{ n: number }>(),
  ]);
  const next_cursor = nextPostCursor(results, limit, 'created_at');
  return c.json({
    success: true,
    comments: results.map((r) => commentPublic(r, viewer, p.author_id)),
    next_cursor,
    total: Number(total?.n ?? 0),
  });
});

async function loadComment(c: Context<AppContext>, id: string) {
  return c.env.DB.prepare(`SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM} WHERE cm.id = ?`).bind(id).first<Record<string, unknown>>();
}

/** The comment this author already made under this post with this client id (0155) — a retry's answer. */
async function storedClientComment(c: Context<AppContext>, postId: string, authorId: string, clientId: string) {
  if (!clientId) return null;
  return c.env.DB.prepare(`SELECT ${COMMENT_COLUMNS} ${COMMENT_FROM} WHERE cm.post_id = ? AND cm.author_id = ? AND cm.client_id = ?`)
    .bind(postId, authorId, clientId)
    .first<Record<string, unknown>>();
}

const isClientIdClash = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE/i.test(msg) && /client_id/i.test(msg);
};

/**
 * WRITE A COMMENT. The body is bounded and checked for decency; the parent is
 * a visible comment of the same post (a reply to a reply is filed under the
 * thread's root — one level, 0154); nobody comments across a block; and one
 * person writes under one post at most every ten seconds.
 *
 * A RETRIED SEND IS THE SAME COMMENT. The client names each send
 * (`client_id`, ≤64); the name is stored (0155) under a unique key per
 * (post, author, name), so two taps in flight both reach the INSERT and the
 * database lets exactly one land — the other re-reads the row and answers it
 * as `replayed`. A check-then-insert could not do this: both checks pass
 * before either insert. A client that sends no name still has the older rule
 * — the same text to the same parent within the cooldown is the retry.
 */
communitySocialRoutes.post('/posts/:id/comments', requireAuth, async (c) => {
  await rateLimit(c, 'social-comment', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  const raw = await jsonObject(c);
  const body = str(raw.body, 'body', { min: COMMENT_MIN, max: COMMENT_MAX });
  const clientId = str(raw.client_id, 'client_id', { min: 0, max: 64, required: false });
  const parentAsked = raw.parent_id === undefined || raw.parent_id === null || raw.parent_id === '' ? null : str(raw.parent_id, 'parent_id', { min: 1, max: 60 });
  const p = await interactablePost(c, id);
  const postAuthor = p.author_id;

  const already = await storedClientComment(c, id, user.id, clientId);
  if (already) return c.json({ success: true, replayed: true, comment: commentPublic(already, user, postAuthor) });

  let parent: Record<string, unknown> | null = null;
  if (parentAsked) {
    parent = await loadComment(c, parentAsked);
    if (!parent || parent.post_id !== id || parent.state !== 'visible') throw notFound('Comment not found');
    if (await blockedEither(c.env.DB, user.id, String(parent.author_id))) throw notFound('Comment not found');
  }
  const parentId = parent ? String((parent.parent_id as string | null) ?? parent.id) : null;

  if (isIndecent(body, await loadOwnerTerms(c.env.DB))) throw badRequest('Please reword your comment', 'COMMENT_INDECENT');

  const last = await c.env.DB.prepare(
    'SELECT id, body, parent_id, created_at FROM community_comments WHERE post_id = ? AND author_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
  )
    .bind(id, user.id)
    .first<{ id: string; body: string; parent_id: string | null; created_at: string }>();
  if (last && Date.now() - Date.parse(last.created_at) < COMMENT_COOLDOWN_MS) {
    if (last.body === body && (last.parent_id ?? null) === parentId) {
      const same = await loadComment(c, last.id);
      return c.json({ success: true, replayed: true, comment: commentPublic(same!, user, postAuthor) });
    }
    throw new HttpError(429, 'Wait a few seconds before commenting again', 'COMMENT_TOO_FAST');
  }

  const commentId = newId('cmt');
  try {
    await c.env.DB.prepare('INSERT INTO community_comments (id, post_id, author_id, parent_id, body, client_id) VALUES (?,?,?,?,?,?)')
      .bind(commentId, id, user.id, parentId, body, clientId)
      .run();
  } catch (e) {
    if (!clientId || !isClientIdClash(e)) throw e;
    const again = await storedClientComment(c, id, user.id, clientId);
    if (!again) throw e;
    return c.json({ success: true, replayed: true, comment: commentPublic(again, user, postAuthor) });
  }

  const actor = { id: user.id, name: user.name || user.username || '' };
  const title = String(p.title ?? '');
  const excerpt = body.length > 120 ? `${body.slice(0, 119)}…` : body;
  const link = `${postHref(id)}#comments`;
  // The person replied to hears «ردّ على تعليقك»; the post's author hears
  // «علّق على مشروعك» — once, not twice when they are the same person — and
  // neither hears a person they muted.
  const replyTo = parent ? String(parent.author_id) : null;
  if (replyTo && replyTo !== user.id && !(await mutedBy(c.env.DB, replyTo, user.id))) {
    await notifyGrouped(c.env.DB, {
      userId: replyTo,
      kind: 'comment_replied',
      groupKey: `comment_replied:${String(parent!.id)}`,
      actor,
      title: (n, a) => ({
        ar: n === 1 ? `ردّ ${a} على تعليقك` : `ردّ ${peopleAr(n)} على تعليقك`,
        en: n === 1 ? `${a} replied to your comment` : `${n} people replied to your comment`,
      }),
      body: { ar: excerpt, en: excerpt },
      link,
      entity_type: 'community_comment',
      entity_id: String(parent!.id),
    });
  }
  if (postAuthor !== user.id && postAuthor !== replyTo && !(await mutedBy(c.env.DB, postAuthor, user.id))) {
    await notifyGrouped(c.env.DB, {
      userId: postAuthor,
      kind: 'post_commented',
      groupKey: `post_commented:${id}`,
      actor,
      title: (n, a) => ({
        ar: n === 1 ? `علّق ${a} على مشروعك ${quoteAr(title)}` : `علّق ${peopleAr(n)} على مشروعك ${quoteAr(title)}`,
        en: n === 1 ? `${a} commented on your project ${quoteEn(title)}` : `${n} people commented on your project ${quoteEn(title)}`,
      }),
      body: { ar: excerpt, en: excerpt },
      link,
      entity_type: 'community_post',
      entity_id: id,
    });
  }
  const made = await loadComment(c, commentId);
  return c.json({ success: true, comment: commentPublic(made!, user, postAuthor) }, 201);
});

/**
 * REMOVE A COMMENT: its author may, and the post's author may under their own
 * post. The row stays as a stub («حُذف التعليق») so replies keep their
 * place; the counter follows the state through 0154's trigger. Anyone else
 * gets the 404 a missing comment gets.
 */
communitySocialRoutes.delete('/comments/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = idParam(c);
  const row = await c.env.DB.prepare(
    'SELECT cm.id, cm.author_id, cm.state, cm.post_id, p.author_id AS post_author_id FROM community_comments cm JOIN community_posts p ON p.id = cm.post_id WHERE cm.id = ?'
  )
    .bind(id)
    .first<{ id: string; author_id: string; state: string; post_id: string; post_author_id: string }>();
  if (!row || (row.author_id !== user.id && row.post_author_id !== user.id)) throw notFound('Comment not found');
  if (row.state === 'visible') {
    await c.env.DB.prepare("UPDATE community_comments SET state = 'removed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND state = 'visible'").bind(id).run();
    if (row.author_id !== user.id) await audit(c.env.DB, user.id, 'community.comment_removed', id, { post_id: row.post_id, by: 'post_author' });
  }
  return c.json({ success: true });
});

// ------------------------------------------------------------------ follows

/** An account that exists, with the columns the follow doors decide on. */
async function personRow(c: Context<AppContext>, id: string) {
  return c.env.DB.prepare(
    `SELECT u.id, u.username, u.creator_public, u.follower_count,
            EXISTS (SELECT 1 FROM community_merchants cm WHERE cm.user_id = u.id AND cm.status <> 'suspended') AS merchant
       FROM users u WHERE u.id = ?`
  )
    .bind(id)
    .first<{ id: string; username: string | null; creator_public: number; follower_count: number; merchant: number }>();
}

const hasPage = (u: { creator_public: number; merchant: number } | null | undefined) => !!u && (Number(u.creator_public) === 1 || Number(u.merchant) === 1);

const followersOf = async (c: Context<AppContext>, id: string) =>
  Number((await c.env.DB.prepare('SELECT follower_count FROM users WHERE id = ?').bind(id).first<{ follower_count: number }>())?.follower_count ?? 0);

communitySocialRoutes.put('/users/:id/follow', requireAuth, async (c) => {
  await rateLimit(c, 'follow-user', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  if (id === user.id) throw badRequest('You cannot follow yourself', 'CANNOT_FOLLOW_SELF');
  const target = await personRow(c, id);
  // A page is the thing one follows (D4): no page, no follow — same words as
  // no account; and across a block the page does not exist either.
  if (!hasPage(target)) throw notFound('Creator not found');
  if (await blockedEither(c.env.DB, user.id, id)) throw notFound('Creator not found');
  const res = await c.env.DB.prepare('INSERT OR IGNORE INTO user_follows (follower_id, user_id) VALUES (?, ?)').bind(user.id, id).run();
  if (res.meta.changes > 0 && !(await mutedBy(c.env.DB, id, user.id))) {
    // The link is the follower's page only when that page exists (a customer
    // with a username has none) — never a link that lands on a 404.
    const me = personHref(await personRow(c, user.id));
    await notifyGrouped(c.env.DB, {
      userId: id,
      kind: 'new_follower',
      groupKey: `new_follower:${id}`,
      actor: { id: user.id, name: user.name || user.username || '' },
      title: (n, a) => ({
        ar: n === 1 ? `بدأ ${a} بمتابعتك` : `بدأ ${peopleAr(n)} بمتابعتك`,
        en: n === 1 ? `${a} started following you` : `${n} people started following you`,
      }),
      link: me,
      entity_type: 'user',
      entity_id: user.id,
    });
  }
  return c.json({ success: true, following: true, followers: await followersOf(c, id) });
});

communitySocialRoutes.delete('/users/:id/follow', requireAuth, async (c) => {
  await rateLimit(c, 'follow-user', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  if (id === user.id) throw badRequest('You cannot follow yourself', 'CANNOT_FOLLOW_SELF');
  const target = await personRow(c, id);
  if (!target) throw notFound('Creator not found');
  await c.env.DB.prepare('DELETE FROM user_follows WHERE follower_id = ? AND user_id = ?').bind(user.id, id).run();
  return c.json({ success: true, following: false, followers: await followersOf(c, id) });
});

// ------------------------------------------------------------- block & mute

/**
 * BLOCK: mutual silence. The follows between the two go both ways at once,
 * in the same batch as the block, so a blocked account is not still counted
 * among the blocker's followers.
 */
communitySocialRoutes.put('/users/:id/block', requireAuth, async (c) => {
  await rateLimit(c, 'social-block', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  if (id === user.id) throw badRequest('You cannot block yourself', 'CANNOT_BLOCK_SELF');
  if (!(await personRow(c, id))) throw notFound('User not found');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO user_blocks (user_id, blocked_id) VALUES (?, ?)').bind(user.id, id),
    c.env.DB.prepare('DELETE FROM user_follows WHERE (follower_id = ?1 AND user_id = ?2) OR (follower_id = ?2 AND user_id = ?1)').bind(user.id, id),
  ]);
  return c.json({ success: true, blocked: true });
});

communitySocialRoutes.delete('/users/:id/block', requireAuth, async (c) => {
  await rateLimit(c, 'social-block', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  await c.env.DB.prepare('DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?').bind(user.id, id).run();
  return c.json({ success: true, blocked: false });
});

communitySocialRoutes.put('/users/:id/mute', requireAuth, async (c) => {
  await rateLimit(c, 'social-block', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  if (id === user.id) throw badRequest('You cannot mute yourself', 'CANNOT_BLOCK_SELF');
  if (!(await personRow(c, id))) throw notFound('User not found');
  await c.env.DB.prepare('INSERT OR IGNORE INTO user_mutes (user_id, muted_id) VALUES (?, ?)').bind(user.id, id).run();
  return c.json({ success: true, muted: true });
});

communitySocialRoutes.delete('/users/:id/mute', requireAuth, async (c) => {
  await rateLimit(c, 'social-block', 60, 3600);
  const user = c.get('user')!;
  const id = idParam(c);
  await c.env.DB.prepare('DELETE FROM user_mutes WHERE user_id = ? AND muted_id = ?').bind(user.id, id).run();
  return c.json({ success: true, muted: false });
});

/** The viewer's own graph, for the client's session state — ids only, each list capped. */
communitySocialRoutes.get('/me/social', requireAuth, async (c) => {
  const user = c.get('user')!;
  const ids = async (sql: string) => (await c.env.DB.prepare(sql).bind(user.id).all<{ id: string }>()).results.map((r) => String(r.id));
  const [following_users, following_stores, blockedIds, muted] = await Promise.all([
    ids('SELECT user_id AS id FROM user_follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 500'),
    ids('SELECT merchant_id AS id FROM follows WHERE user_id = ? ORDER BY created_at DESC LIMIT 500'),
    ids('SELECT blocked_id AS id FROM user_blocks WHERE user_id = ? ORDER BY created_at DESC LIMIT 500'),
    ids('SELECT muted_id AS id FROM user_mutes WHERE user_id = ? ORDER BY created_at DESC LIMIT 500'),
  ]);
  return c.json({ success: true, following_users, following_stores, blocked: blockedIds, muted });
});

// ------------------------------------------------------------------ reports

const REPORT_TARGETS = ['post', 'comment', 'user', 'store', 'product', 'request'] as const;
const REPORT_REASONS = ['spam', 'abuse', 'nudity', 'fraud', 'copyright', 'offtopic', 'other'] as const;

/**
 * Does the reported thing exist, AS FAR AS THE REPORTER MAY KNOW? Each kind
 * answers with the rule its own page answers with — a post the reporter may
 * read, a visible comment under such a post, a person with a page, a live
 * store, a listed product, a request on the board — so this door confirms
 * nothing a leaked id could not already open.
 */
async function reportTargetExists(c: Context<AppContext>, type: (typeof REPORT_TARGETS)[number], id: string): Promise<boolean> {
  const user = c.get('user')!;
  const db = c.env.DB;
  switch (type) {
    case 'post': {
      const p = await loadPostHead(c.env, id);
      return !!p && mayRead(p, user);
    }
    case 'comment': {
      const r = await db
        .prepare("SELECT cm.post_id FROM community_comments cm WHERE cm.id = ? AND cm.state = 'visible'")
        .bind(id)
        .first<{ post_id: string }>();
      if (!r) return false;
      const p = await loadPostHead(c.env, r.post_id);
      return !!p && mayRead(p, user);
    }
    case 'user':
      return hasPage(await personRow(c, id));
    case 'store':
      return !!(await db
        .prepare("SELECT 1 AS x FROM merchant_stores s JOIN community_merchants cm ON cm.id = s.merchant_id WHERE s.id = ? AND s.status <> 'suspended' AND cm.status <> 'suspended'")
        .bind(id)
        .first());
    case 'product':
      return !!(await db.prepare(`SELECT 1 AS x ${COMMUNITY_PRODUCTS_FROM} WHERE p.id = ? AND ${communityProductsVisible("''")}`).bind(id).first());
    case 'request':
      return !!(await db.prepare(`SELECT 1 AS x FROM community_requests r WHERE r.id = ?1 AND ${requestBoardVisible('?2', "''")}`).bind(id, new Date().toISOString()).first());
  }
}

communitySocialRoutes.post('/reports', requireAuth, async (c) => {
  await rateLimit(c, 'report', 20, 3600);
  const user = c.get('user')!;
  const raw = await jsonObject(c);
  const target_type = oneOf(raw.target_type, 'target_type', REPORT_TARGETS);
  const target_id = str(raw.target_id, 'target_id', { min: 1, max: 60 });
  const reason = oneOf(raw.reason, 'reason', REPORT_REASONS);
  const details = str(raw.details, 'details', { min: 0, max: 1000, required: false });
  if (!(await reportTargetExists(c, target_type, target_id))) throw new HttpError(404, 'We could not find what you are reporting', 'REPORT_TARGET_NOT_FOUND');

  const id = newId('rpt');
  const res = await c.env.DB.prepare(
    `INSERT INTO community_reports (id, reporter_id, target_type, target_id, reason, details) VALUES (?,?,?,?,?,?)
     ON CONFLICT(reporter_id, target_type, target_id) DO NOTHING`
  )
    .bind(id, user.id, target_type, target_id, reason, details)
    .run();
  if (res.meta.changes === 0) {
    const existing = await c.env.DB.prepare('SELECT id FROM community_reports WHERE reporter_id = ? AND target_type = ? AND target_id = ?')
      .bind(user.id, target_type, target_id)
      .first<{ id: string }>();
    return c.json({ success: true, report_id: existing?.id ?? null, replayed: true });
  }
  await audit(c.env.DB, user.id, 'community.report', id, { target_type, target_id, reason });
  announceAfterResponse(
    c,
    'report',
    `🚩 بلاغ جديد في المجتمع` +
      `\nType: ${target_type}` +
      `\nTarget: ${target_id}` +
      `\nReason: ${reason}` +
      `\nReport: ${id}`
  );
  return c.json({ success: true, report_id: id }, 201);
});

// --------------------------------------------------------------------- feed

/**
 * THE FEED. «لك»: public posts newest first, minus the people the viewer
 * muted or blocked (and who blocked them). «أتابع»: by the makers the viewer
 * follows, and by the owners of the stores they follow — one follow of a
 * store is a follow of its maker's posts too (Q3's proposal, the reading side).
 */
communitySocialRoutes.get('/feed', async (c) => {
  const scope = oneOf(c.req.query('scope') ?? 'foryou', 'scope', ['foryou', 'following'] as const);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 30, def: 12 });
  const cursor = feedCursor(c.req.query('cursor'));
  const viewer = c.get('user') ?? null;
  if (scope === 'following' && !viewer) throw unauthorized();
  const v = viewer?.id ?? '';
  const root = rootDomainFrom(c.env);
  const scopeSql =
    scope === 'following'
      ? `AND p.author_id IN (SELECT uf.user_id FROM user_follows uf WHERE uf.follower_id = ?1
                            UNION SELECT cm.user_id FROM follows f JOIN community_merchants cm ON cm.id = f.merchant_id WHERE f.user_id = ?1)`
      : '';
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_COLUMNS} ${POST_FROM}
      WHERE ${POST_PUBLIC_SQL} AND ${postExclusionSql('?1')} ${scopeSql}
        AND (?2 = '' OR p.published_at < ?2 OR (p.published_at = ?2 AND p.id < ?3))
      ORDER BY p.published_at DESC, p.id DESC LIMIT ?4`
  )
    .bind(v, cursor.at, cursor.id, limit + 1)
    .all<Record<string, unknown>>();
  const next_cursor = nextPostCursor(results, limit);
  return c.json({
    success: true,
    scope,
    posts: await withViewerFlags(c.env.DB, v || null, results.map((p) => postCard(p, root))),
    next_cursor,
  });
});

// ----------------------------------------------------------------- creators

const CREATOR_SEARCH = ['u.name', 'u.username', 'u.bio'] as const;

/**
 * THE CREATORS LIST — accounts with a page (D4), never across a block.
 * Featured (`featured=1`) orders by published projects then followers; the
 * default by the newest published project. The cursor is an opaque offset:
 * the list is short and its two orders are composite, so an exact
 * `(key, id)` cursor would buy nothing a client could see.
 *
 * THE CANDIDATES COME FIRST. The list starts from the accounts that HAVE a
 * page — `creator_public = 1` (0155's partial index) ∪ live merchants — and
 * joins the rest onto those, instead of ranging over every user with a
 * username and asking each row whether it qualifies. The project count and
 * the last publication are ONE grouped read over the public posts, joined by
 * author, not two correlated subqueries evaluated per candidate before the
 * sort. The home asks this on every first paint, guests included.
 */
communitySocialRoutes.get('/creators', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 18 });
  const offset = int(c.req.query('cursor'), 'cursor', { min: 0, max: 100_000, def: 0 });
  const q = likePattern(c.req.query('q'));
  const featured = c.req.query('featured') === '1';
  const viewer = c.get('user') ?? null;
  const v = viewer?.id ?? '';
  const root = rootDomainFrom(c.env);
  const candidates = `(SELECT id FROM users WHERE creator_public = 1
                       UNION SELECT user_id FROM community_merchants WHERE status <> 'suspended') cand`;
  const where = `u.username IS NOT NULL AND u.username <> ''
          AND (?1 = '' OR ${sqlLikeClause(CREATOR_SEARCH, '?1')})
          AND (?2 = '' OR NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.user_id = ?2 AND b.blocked_id = u.id) OR (b.user_id = u.id AND b.blocked_id = ?2)))`;
  const from = `FROM ${candidates}
          JOIN users u ON u.id = cand.id
          LEFT JOIN community_merchants cm ON cm.user_id = u.id
          LEFT JOIN merchant_stores s ON s.merchant_id = cm.id`;
  const withCounts = `${from}
          LEFT JOIN (SELECT p.author_id, COUNT(*) AS n, MAX(p.published_at) AS last
                       FROM community_posts p WHERE ${POST_PUBLIC_SQL} GROUP BY p.author_id) pc ON pc.author_id = u.id`;
  const order = featured ? 'projects DESC, u.follower_count DESC, u.id DESC' : 'last_published DESC NULLS LAST, u.follower_count DESC, u.id DESC';
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT u.id, u.username, u.name, u.avatar_key, u.bio, u.follower_count,
              cm.id AS merchant_id, cm.status AS merchant_status, cm.verified AS merchant_verified,
              s.id AS store_id, s.slug AS store_slug, s.name AS store_name, s.status AS store_status,
              COALESCE(pc.n, 0) AS projects,
              pc.last AS last_published,
              EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_id = ?2 AND f.user_id = u.id) AS viewer_follows
         ${withCounts}
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ?3 OFFSET ?4`
    )
      .bind(q, v, limit + 1, offset)
      .all<Record<string, unknown>>(),
    offset === 0 ? c.env.DB.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${where}`).bind(q, v).first<{ n: number }>() : Promise.resolve(null),
  ]);
  const more = results.length > limit;
  if (more) results.length = limit;
  const badges = await membershipBadges(c.env.DB, results.map((r) => r.id));
  const creators = results.map((r) => {
    const merchantOk = !!r.merchant_id && r.merchant_status !== 'suspended';
    const storeOk = merchantOk && !!r.store_id && r.store_status !== 'suspended';
    const bio = String(r.bio ?? '');
    return {
      id: String(r.id),
      username: String(r.username),
      name: String(r.name ?? ''),
      avatarUrl: fileUrl(r.avatar_key),
      bio: bio.length > 160 ? `${bio.slice(0, 159)}…` : bio,
      badges: {
        pro: badges.pro.has(String(r.id)),
        premium: badges.premium.has(String(r.id)),
        verified_merchant: merchantOk && !!r.merchant_verified,
      },
      stats: { projects: Number(r.projects ?? 0), followers: Number(r.follower_count ?? 0) },
      store: storeOk
        ? { id: String(r.store_id), slug: String(r.store_slug ?? ''), name: String(r.store_name ?? ''), url: storeUrl(String(r.store_slug ?? ''), root, String(r.store_id)) }
        : null,
      url: `/u/${encodeURIComponent(String(r.username))}`,
      viewer: { following: !!r.viewer_follows },
    };
  });
  return c.json({
    success: true,
    creators,
    next_cursor: more ? String(offset + limit) : null,
    total: total ? Number(total.n) : null,
  });
});
