/**
 * PROJECTS, POSTS AND CREATORS — what the community MAKES (0153;
 * docs/COMMUNITY_ECOSYSTEM.md Phase 1).
 *
 * A project is a finished print with its facts (printer, material, colour,
 * settings, time, size) and its doors into the marketplace (the store that
 * made it, the product it became, the request it fulfilled). Any signed-in
 * account may publish one — the creator is often the customer — and a creator
 * page (/u/<username>) exists for whoever chose to be public.
 *
 * THE RULES THIS FILE KEEPS, in the order a reader meets them:
 *
 *   · a post is READ by everybody once published and public, by its author
 *     and staff in every state, and by nobody else; a post Levonis hid is
 *     served only to its author (who is told why) and staff;
 *   · every LINK is an id the server checks: a store the author owns, a
 *     product of that store, a request or custom order the author was party
 *     to, a catalogue printer/material that exists. A forged id is refused
 *     with the same words as a missing one;
 *   · every PICTURE is the author's own public media (`users/<uid>/posts/…`,
 *     or a store owner's `merchants/<uid>/public/…`), present in the media
 *     ledger; a URL typed by hand is never stored;
 *   · a PORTFOLIO piece made from another customer's request needs that
 *     customer's consent before it is public — the pictures are of their part;
 *   · counters are the server's (0154's triggers) and never read from a body.
 *
 * Everything sits inside Levo Community's maintenance wall (communityGate),
 * exactly like the feeds beside it.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext, Env } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, conflict, str, int, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { notify } from '../lib/notifications';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { feedCursor } from '../lib/feedCursor';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { communityGate } from '../lib/communityGate';
import { membershipBadges } from '../lib/entitlements';
import { storeForUser } from '../lib/merchantAuth';
import { isSafeMediaKey } from '../lib/mediaStorage';
import { COMMUNITY_DIRECTORY_COLUMNS, directoryCard } from './community';

export const communityPostRoutes = new Hono<AppContext>();
communityPostRoutes.use('*', communityGate());

// ------------------------------------------------------------------ shapes

export const POST_KINDS = ['project', 'post', 'tutorial', 'timelapse', 'before_after'] as const;
export type PostKind = (typeof POST_KINDS)[number];
const VISIBILITIES = ['public', 'unlisted', 'private'] as const;

/** The most pictures and clips one post carries — a project, not an album. */
export const POST_MEDIA_MAX = 12;
export const POST_TAGS_MAX = 10;

const fileUrl = (key: unknown) => (typeof key === 'string' && key ? `/files/${key}` : null);
const nowIso = () => new Date().toISOString();

/** The page a post is read on. */
export const postHref = (id: string) => `/community/projects/${encodeURIComponent(id)}`;

/**
 * The public words of an author: never the email, never the phone — and the
 * username only when their page exists (`creatorVisible`'s rule), so a card
 * never links to a 404 and a closed page is closed from every side.
 */
function authorPublic(row: Record<string, unknown>) {
  const pageExists = Number(row.a_public) === 1 || Number(row.a_merchant) === 1;
  return {
    id: String(row.author_id ?? row.id ?? ''),
    username: pageExists ? ((row.a_username as string | null) ?? null) : null,
    name: String(row.a_name ?? ''),
    avatarUrl: fileUrl(row.a_avatar),
  };
}

/** A card of the feed: what a list needs and nothing a page keeps to itself. */
export function postCard(p: Record<string, unknown>, root: string | null) {
  const storeOk = typeof p.store_id === 'string' && p.store_id && p.s_status !== 'suspended';
  const productOk = typeof p.product_id === 'string' && p.product_id && p.pr_lifecycle === 'active' && p.pr_status === 'active' && storeOk;
  const body = String(p.body ?? '');
  return {
    id: String(p.id),
    kind: String(p.kind),
    title: String(p.title ?? ''),
    excerpt: body.length > 180 ? `${body.slice(0, 179)}…` : body,
    cover: p.cover_key ? { url: fileUrl(p.cover_key), kind: String(p.cover_kind ?? 'image'), width: p.cover_w ?? null, height: p.cover_h ?? null } : null,
    media_count: Number(p.media_count ?? 0),
    author: authorPublic(p),
    store: storeOk
      ? { id: String(p.store_id), slug: String(p.s_slug ?? ''), name: String(p.s_name ?? ''), logoUrl: fileUrl(p.s_logo), url: storeUrl(String(p.s_slug ?? ''), root, String(p.store_id)) }
      : null,
    product: productOk
      ? {
          id: String(p.product_id),
          slug: String(p.pr_slug ?? ''),
          name: String(p.pr_name ?? ''),
          name_ar: String(p.pr_name_ar ?? ''),
          price_iqd: Number(p.pr_price ?? 0),
          url: `/community/store/${encodeURIComponent(String(p.s_slug ?? ''))}/p/${encodeURIComponent(String(p.pr_slug ?? ''))}`,
        }
      : null,
    printer: {
      name: String(p.printer_name ?? '') || String(p.printer_product_name ?? ''),
      product: p.printer_product_id && p.printer_slug
        ? { id: String(p.printer_product_id), slug: String(p.printer_slug), name: String(p.printer_product_name ?? ''), name_ar: String(p.printer_product_name_ar ?? ''), url: `/product/${encodeURIComponent(String(p.printer_slug))}` }
        : null,
    },
    material: {
      name: String(p.material ?? '') || String(p.mat_name ?? ''),
      product: p.material_product_id && p.mat_slug
        ? { id: String(p.material_product_id), slug: String(p.mat_slug), name: String(p.mat_name ?? ''), name_ar: String(p.mat_name_ar ?? ''), url: `/product/${encodeURIComponent(String(p.mat_slug))}` }
        : null,
    },
    color: String(p.color ?? ''),
    print_time_minutes: p.print_time_minutes === null || p.print_time_minutes === undefined ? null : Number(p.print_time_minutes),
    dimensions: safeParse<Record<string, number>>(p.dimensions, {}) ?? {},
    tags: (safeParse<unknown[]>(p.tags, []) ?? []).filter((t): t is string => typeof t === 'string'),
    counts: {
      likes: Number(p.like_count ?? 0),
      comments: Number(p.comment_count ?? 0),
      saves: Number(p.save_count ?? 0),
      views: Number(p.view_count ?? 0),
    },
    state: String(p.state),
    visibility: String(p.visibility),
    published_at: (p.published_at as string | null) ?? null,
    created_at: String(p.created_at ?? ''),
    url: postHref(String(p.id)),
  };
}

/** The columns every post read joins — one query, one shape. */
export const POST_COLUMNS = `p.*,
       u.username AS a_username, u.name AS a_name, u.avatar_key AS a_avatar, u.creator_public AS a_public,
       EXISTS (SELECT 1 FROM community_merchants acm WHERE acm.user_id = u.id AND acm.status <> 'suspended') AS a_merchant,
       s.slug AS s_slug, s.name AS s_name, s.logo_key AS s_logo, s.status AS s_status,
       cp.slug AS pr_slug, cp.name AS pr_name, cp.name_ar AS pr_name_ar, cp.price_iqd AS pr_price,
       cp.lifecycle AS pr_lifecycle, cp.status AS pr_status,
       pp.slug AS printer_slug, pp.name AS printer_product_name, pp.name_ar AS printer_product_name_ar,
       mp.slug AS mat_slug, mp.name AS mat_name, mp.name_ar AS mat_name_ar,
       (SELECT m.media_key FROM community_post_media m WHERE m.post_id = p.id ORDER BY m.sort_order, m.id LIMIT 1) AS cover_key,
       (SELECT m.kind FROM community_post_media m WHERE m.post_id = p.id ORDER BY m.sort_order, m.id LIMIT 1) AS cover_kind,
       (SELECT m.width FROM community_post_media m WHERE m.post_id = p.id ORDER BY m.sort_order, m.id LIMIT 1) AS cover_w,
       (SELECT m.height FROM community_post_media m WHERE m.post_id = p.id ORDER BY m.sort_order, m.id LIMIT 1) AS cover_h,
       (SELECT COUNT(*) FROM community_post_media m WHERE m.post_id = p.id) AS media_count`;
export const POST_FROM = `FROM community_posts p
       JOIN users u ON u.id = p.author_id
       LEFT JOIN merchant_stores s ON s.id = p.store_id
       LEFT JOIN community_products cp ON cp.id = p.product_id
       LEFT JOIN products pp ON pp.id = p.printer_product_id
       LEFT JOIN products mp ON mp.id = p.material_product_id`;

/** What everybody may see: published, public, not hidden by Levonis. */
export const POST_PUBLIC_SQL = `p.state = 'published' AND p.visibility = 'public' AND p.admin_hidden_at IS NULL
  AND p.consent_status IN ('not_needed','granted')`;

export const POST_SEARCH = ['p.title', 'p.body', 'p.tags', 'p.material', 'p.printer_name'] as const;

/**
 * WHAT A SIGNED-IN VIEWER NEVER MEETS IN A LIST (0154): posts by an author
 * they blocked or who blocked them, and posts by an author they muted. Bound
 * to the viewer's id, or '' for a guest, who sees the public rule alone.
 * A `p` alias must be in scope.
 */
export const postExclusionSql = (viewer: string) => `(${viewer} = '' OR (
      NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.user_id = ${viewer} AND b.blocked_id = p.author_id) OR (b.user_id = p.author_id AND b.blocked_id = ${viewer}))
  AND NOT EXISTS (SELECT 1 FROM user_mutes mu WHERE mu.user_id = ${viewer} AND mu.muted_id = p.author_id)))`;

/** Has either of these two accounts blocked the other? The one question every social door asks first. */
export async function blockedEither(db: D1Database, a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const row = await db
    .prepare('SELECT 1 AS x FROM user_blocks WHERE (user_id = ?1 AND blocked_id = ?2) OR (user_id = ?2 AND blocked_id = ?1) LIMIT 1')
    .bind(a, b)
    .first();
  return !!row;
}

/** Has `recipient` muted `actor`? A mute is the viewer's own affair — it hides, and it keeps the bell quiet too. */
export async function mutedBy(db: D1Database, recipient: string, actor: string): Promise<boolean> {
  if (!recipient || !actor || recipient === actor) return false;
  const row = await db.prepare('SELECT 1 AS x FROM user_mutes WHERE user_id = ? AND muted_id = ? LIMIT 1').bind(recipient, actor).first();
  return !!row;
}

export interface PostViewerFlags {
  liked: boolean;
  saved: boolean;
}

/**
 * THE VIEWER'S OWN MARKS on a page of cards — liked, saved — in two queries
 * for the whole page, never one per card. A guest's flags are all false, so
 * a card always carries the key and a client never branches on its absence.
 */
export async function viewerFlagsFor(db: D1Database, viewerId: string | null, postIds: string[]): Promise<Map<string, PostViewerFlags>> {
  const flags = new Map<string, PostViewerFlags>(postIds.map((id) => [id, { liked: false, saved: false }]));
  if (!viewerId || postIds.length === 0) return flags;
  const marks = postIds.map(() => '?').join(',');
  const [likes, saves] = await Promise.all([
    db.prepare(`SELECT post_id FROM community_likes WHERE user_id = ? AND post_id IN (${marks})`).bind(viewerId, ...postIds).all<{ post_id: string }>(),
    db.prepare(`SELECT post_id FROM community_saves WHERE user_id = ? AND post_id IN (${marks})`).bind(viewerId, ...postIds).all<{ post_id: string }>(),
  ]);
  for (const r of likes.results) flags.get(r.post_id)!.liked = true;
  for (const r of saves.results) flags.get(r.post_id)!.saved = true;
  return flags;
}

type Card = ReturnType<typeof postCard>;
export async function withViewerFlags<T extends Card>(db: D1Database, viewerId: string | null, cards: T[]): Promise<Array<T & { viewer: PostViewerFlags }>> {
  const flags = await viewerFlagsFor(db, viewerId, cards.map((c) => c.id));
  return cards.map((c) => ({ ...c, viewer: flags.get(c.id) ?? { liked: false, saved: false } }));
}

/** Pages by (published_at, id): `<published_at>|<id>`. */
/**
 * A page is read one row longer than asked, so the cursor exists only when a
 * next page really does — an infinite-scroll list never fetches an empty tail.
 * `rows` is trimmed in place to the asked length.
 */
export function nextPostCursor(rows: Array<Record<string, unknown>>, limit: number, at: 'published_at' | 'created_at' | 'saved_at' = 'published_at'): string | null {
  if (rows.length <= limit) return null;
  rows.length = limit;
  const last = rows[rows.length - 1];
  return `${String(last[at])}|${String(last.id)}`;
}

// -------------------------------------------------------------- reading

/**
 * THE PROJECTS FEED — published public posts, newest first, a page at a time,
 * narrowed by kind, author, store, product, tag or a search term (all on the
 * server, like every other community list).
 */
communityPostRoutes.get('/posts', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 18 });
  const cursor = feedCursor(c.req.query('cursor'));
  const q = likePattern(c.req.query('q'));
  const kindRaw = (c.req.query('kind') ?? '').trim();
  const kind = (POST_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : '';
  // `not_kind=project` is the creator page's «المنشورات»: everything but the
  // projects, filtered here so `total` and the empty state are exact.
  const notKindRaw = (c.req.query('not_kind') ?? '').trim();
  const notKind = (POST_KINDS as readonly string[]).includes(notKindRaw) ? notKindRaw : '';
  const author = str(c.req.query('author'), 'author', { max: 40, required: false });
  const store = str(c.req.query('store'), 'store', { max: 60, required: false });
  const product = str(c.req.query('product'), 'product', { max: 60, required: false });
  const tag = str(c.req.query('tag'), 'tag', { max: 30, required: false }).toLowerCase();
  const root = rootDomainFrom(c.env);
  const viewerId = c.get('user')?.id ?? '';
  const where = `${POST_PUBLIC_SQL}
          AND ${postExclusionSql('?10')}
          AND (?1 = '' OR ${sqlLikeClause(POST_SEARCH, '?1')})
          AND (?2 = '' OR p.kind = ?2)
          AND (?11 = '' OR p.kind <> ?11)
          AND (?3 = '' OR u.username = ?3)
          AND (?4 = '' OR p.store_id = ?4)
          AND (?5 = '' OR p.product_id = ?5)
          AND (?6 = '' OR EXISTS (SELECT 1 FROM json_each(p.tags) t WHERE lower(t.value) = ?6))`;
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT ${POST_COLUMNS} ${POST_FROM}
        WHERE ${where}
          AND (?7 = '' OR p.published_at < ?7 OR (p.published_at = ?7 AND p.id < ?8))
        ORDER BY p.published_at DESC, p.id DESC LIMIT ?9`
    )
      .bind(q, kind, author, store, product, tag, cursor.at, cursor.id, limit + 1, viewerId, notKind)
      .all<Record<string, unknown>>(),
    cursor.at === ''
      ? c.env.DB.prepare(`SELECT COUNT(*) AS n ${POST_FROM} WHERE ${where}`).bind(q, kind, author, store, product, tag, '', '', 0, viewerId, notKind).first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  const next_cursor = nextPostCursor(results, limit);
  return c.json({
    success: true,
    posts: await withViewerFlags(c.env.DB, viewerId || null, results.map((p) => postCard(p, root))),
    next_cursor,
    total: total ? Number(total.n) : null,
  });
});

/** Trending: the most engaged public posts of the last 30 days — a rail, not a page. */
communityPostRoutes.get('/posts/trending', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 24, def: 12 });
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const root = rootDomainFrom(c.env);
  const viewerId = c.get('user')?.id ?? '';
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_COLUMNS} ${POST_FROM}
      WHERE ${POST_PUBLIC_SQL} AND p.published_at >= ?1 AND ${postExclusionSql('?3')}
      ORDER BY (p.like_count * 3 + p.comment_count * 4 + p.save_count * 5 + p.view_count) DESC, p.published_at DESC, p.id DESC
      LIMIT ?2`
  )
    .bind(since, limit, viewerId)
    .all<Record<string, unknown>>();
  return c.json({ success: true, posts: await withViewerFlags(c.env.DB, viewerId || null, results.map((p) => postCard(p, root))) });
});

/** One post with its media, for its page. */
export async function loadPost(env: Env, id: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT ${POST_COLUMNS} ${POST_FROM} WHERE p.id = ?`).bind(id).first<Record<string, unknown>>();
}

/**
 * THE HEAD OF A POST — the columns a social write decides on (`mayRead`'s
 * inputs, the author, the title for a notification), without the card's five
 * joins and five media subqueries. A like is the hottest write of the phase
 * (240 an hour per account); it does not need the cover's height.
 */
export interface PostHead {
  id: string;
  author_id: string;
  title: string;
  state: string;
  visibility: string;
  admin_hidden_at: string | null;
  consent_status: string;
}
export async function loadPostHead(env: Env, id: string): Promise<PostHead | null> {
  return env.DB.prepare('SELECT id, author_id, title, state, visibility, admin_hidden_at, consent_status FROM community_posts WHERE id = ?').bind(id).first<PostHead>();
}

/** The columns `mayRead` decides on — a full card row or a `PostHead` both carry them. */
export interface PostReadable {
  author_id?: unknown;
  admin_hidden_at?: unknown;
  state?: unknown;
  visibility?: unknown;
}

/** May this viewer read this post at all? The author and staff always; everybody else what is public. */
export function mayRead(p: PostReadable, viewer: { id: string; role: string } | null, consentParty: string | null = null): boolean {
  if (viewer && (viewer.id === p.author_id || viewer.role === 'admin')) return true;
  // The customer a workshop asked («صور من قطعتك») may read the piece they
  // are asked about, whatever its state — they cannot decide about a page
  // they cannot open. Levonis's hide still wins.
  if (viewer && consentParty && viewer.id === consentParty && !p.admin_hidden_at) return true;
  if (p.admin_hidden_at) return false;
  if (p.state !== 'published') return false;
  return p.visibility === 'public' || p.visibility === 'unlisted';
}

/** The customer whose part a portfolio piece shows — the linked job's customer, when consent is in play. */
async function consentPartyOf(env: Env, p: Record<string, unknown>): Promise<string | null> {
  if (p.consent_status === 'not_needed') return null;
  if (typeof p.request_id === 'string' && p.request_id) {
    const r = await env.DB.prepare('SELECT customer_id FROM community_requests WHERE id = ?').bind(p.request_id).first<{ customer_id: string }>();
    if (r) return r.customer_id;
  }
  if (typeof p.community_order_id === 'string' && p.community_order_id) {
    const o = await env.DB.prepare('SELECT customer_id FROM community_orders WHERE id = ?').bind(p.community_order_id).first<{ customer_id: string }>();
    if (o) return o.customer_id;
  }
  return null;
}

async function postMedia(env: Env, id: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, kind, media_key, width, height, duration_s, sort_order FROM community_post_media WHERE post_id = ? ORDER BY sort_order, id'
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return results.map((m) => ({
    id: String(m.id),
    kind: String(m.kind),
    url: fileUrl(m.media_key),
    key: String(m.media_key),
    width: (m.width as number | null) ?? null,
    height: (m.height as number | null) ?? null,
    duration_s: (m.duration_s as number | null) ?? null,
  }));
}

communityPostRoutes.get('/posts/:id', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const viewer = c.get('user') ?? null;
  const p = await loadPost(c.env, id);
  const consentParty = p && viewer ? await consentPartyOf(c.env, p) : null;
  if (!p || !mayRead(p, viewer, consentParty)) throw notFound('Project not found');
  // A block closes the page from both sides with the words a missing page
  // gets (0154) — the same answer the creator page gives, so no door tells
  // the blocked side more than the other.
  if (viewer && (await blockedEither(c.env.DB, viewer.id, String(p.author_id)))) throw notFound('Project not found');
  const mine = !!viewer && viewer.id === p.author_id;
  const asked = !!viewer && !!consentParty && viewer.id === consentParty && !mine;
  const root = rootDomainFrom(c.env);
  const [media, flags, follows] = await Promise.all([
    postMedia(c.env, id),
    viewerFlagsFor(c.env.DB, viewer?.id ?? null, [id]),
    viewer && !mine
      ? c.env.DB.prepare('SELECT 1 AS x FROM user_follows WHERE follower_id = ? AND user_id = ?').bind(viewer.id, String(p.author_id)).first()
      : Promise.resolve(null),
  ]);
  const marks = flags.get(id) ?? { liked: false, saved: false };
  return c.json({
    success: true,
    post: {
      ...postCard(p, root),
      body: String(p.body ?? ''),
      media: mine || viewer?.role === 'admin' ? media : media.map(({ key: _key, ...m }) => m),
      print_settings: safeParse<Record<string, unknown>>(p.print_settings, {}) ?? {},
      request_id: mine ? ((p.request_id as string | null) ?? null) : null,
      community_order_id: mine ? ((p.community_order_id as string | null) ?? null) : null,
      consent_status: mine || asked ? String(p.consent_status) : undefined,
      hidden: p.admin_hidden_at ? { at: p.admin_hidden_at, reason: mine || viewer?.role === 'admin' ? String(p.admin_hidden_reason ?? '') : '' } : null,
      viewer: {
        mine,
        liked: marks.liked,
        saved: marks.saved,
        /** The viewer already follows the author — the byline's pill starts right without waiting for the session graph. */
        following_author: !!follows,
        /** The viewer is the customer whose part this is: their decision is due, or was given. */
        consent: asked ? (String(p.consent_status) as 'pending' | 'granted' | 'declined') : null,
        can: {
          edit: mine && p.state !== 'archived',
          publish: mine && p.state === 'draft',
          archive: mine && p.state === 'published',
          delete: mine && p.state !== 'published',
        },
      },
    },
  });
});

// -------------------------------------------------------------- writing

interface PostInput {
  title: string;
  body: string;
  kind: PostKind;
  visibility: (typeof VISIBILITIES)[number];
  printer_product_id: string | null;
  printer_name: string;
  material_product_id: string | null;
  material: string;
  color: string;
  print_settings: Record<string, unknown>;
  print_time_minutes: number | null;
  dimensions: Record<string, number>;
  tags: string[];
  store_id: string | null;
  product_id: string | null;
  request_id: string | null;
  community_order_id: string | null;
  media: Array<{ key: string; kind: 'image' | 'video'; width: number | null; height: number | null; duration_s: number | null }>;
}

const optionalId = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null || v === '') return null;
  return str(v, name, { min: 1, max: 60 });
};

/** A number in a JSON settings object, or nothing. */
const numberIn = (v: unknown, min: number, max: number): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest('A print setting is out of range', 'POST_SETTING_INVALID');
  return Math.round(n * 1000) / 1000;
};

/**
 * Read a post's fields from a body — every string bounded, every number
 * ranged, every list capped. Ids are checked against the database by
 * `checkLinks`; keys by `checkMedia`.
 */
function readPost(body: Record<string, unknown>, partial: boolean): Partial<PostInput> {
  const out: Partial<PostInput> = {};
  const has = (k: string) => !partial || body[k] !== undefined;
  if (has('title')) out.title = str(body.title, 'title', { min: 3, max: 140 });
  if (has('body')) out.body = str(body.body, 'body', { min: 0, max: 4000, required: false });
  if (has('kind')) out.kind = body.kind === undefined ? 'project' : oneOf(body.kind, 'kind', POST_KINDS);
  if (has('visibility')) out.visibility = body.visibility === undefined ? 'public' : oneOf(body.visibility, 'visibility', VISIBILITIES);
  if (has('printer_product_id')) out.printer_product_id = optionalId(body.printer_product_id, 'printer_product_id');
  if (has('printer_name')) out.printer_name = str(body.printer_name, 'printer_name', { min: 0, max: 80, required: false });
  if (has('material_product_id')) out.material_product_id = optionalId(body.material_product_id, 'material_product_id');
  if (has('material')) out.material = str(body.material, 'material', { min: 0, max: 60, required: false });
  if (has('color')) out.color = str(body.color, 'color', { min: 0, max: 40, required: false });
  if (has('print_settings')) {
    const s = body.print_settings && typeof body.print_settings === 'object' ? (body.print_settings as Record<string, unknown>) : {};
    const settings: Record<string, unknown> = {};
    const layer = numberIn(s.layer_height_mm, 0.01, 2);
    const infill = numberIn(s.infill_percent, 0, 100);
    const nozzle = numberIn(s.nozzle_mm, 0.1, 2);
    const walls = numberIn(s.walls, 0, 20);
    if (layer !== undefined) settings.layer_height_mm = layer;
    if (infill !== undefined) settings.infill_percent = infill;
    if (nozzle !== undefined) settings.nozzle_mm = nozzle;
    if (walls !== undefined) settings.walls = walls;
    if (s.supports !== undefined) settings.supports = !!s.supports;
    if (typeof s.profile === 'string') settings.profile = s.profile.trim().slice(0, 60);
    out.print_settings = settings;
  }
  if (has('print_time_minutes')) {
    out.print_time_minutes =
      body.print_time_minutes === null || body.print_time_minutes === undefined || body.print_time_minutes === ''
        ? null
        : int(body.print_time_minutes, 'print_time_minutes', { min: 0, max: 100_000 });
  }
  if (has('dimensions')) {
    const d = body.dimensions && typeof body.dimensions === 'object' ? (body.dimensions as Record<string, unknown>) : {};
    const dims: Record<string, number> = {};
    for (const axis of ['x_mm', 'y_mm', 'z_mm'] as const) {
      const n = numberIn(d[axis], 0, 5000);
      if (n !== undefined) dims[axis] = n;
    }
    out.dimensions = dims;
  }
  if (has('tags')) {
    const raw = Array.isArray(body.tags) ? body.tags : [];
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const t of raw) {
      if (typeof t !== 'string') continue;
      const v = t.trim().replace(/^#/, '').slice(0, 30).toLowerCase();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      tags.push(v);
      if (tags.length >= POST_TAGS_MAX) break;
    }
    out.tags = tags;
  }
  if (has('store_id')) out.store_id = optionalId(body.store_id, 'store_id');
  if (has('product_id')) out.product_id = optionalId(body.product_id, 'product_id');
  if (has('request_id')) out.request_id = optionalId(body.request_id, 'request_id');
  if (has('community_order_id')) out.community_order_id = optionalId(body.community_order_id, 'community_order_id');
  if (has('media')) {
    const raw = Array.isArray(body.media) ? body.media : [];
    if (raw.length > POST_MEDIA_MAX) throw badRequest(`At most ${POST_MEDIA_MAX} pictures or videos`, 'POST_MEDIA_TOO_MANY');
    out.media = raw.map((m, i) => {
      const item = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
      const key = str(item.key, `media[${i}].key`, { min: 5, max: 200 }).replace(/^\/files\//, '');
      if (!isSafeMediaKey(key)) throw badRequest('That picture is not one of yours', 'POST_MEDIA_NOT_OWNED');
      return {
        key,
        kind: item.kind === 'video' ? ('video' as const) : ('image' as const),
        width: numberIn(item.width, 1, 20_000) ?? null,
        height: numberIn(item.height, 1, 20_000) ?? null,
        duration_s: numberIn(item.duration_s, 0, 36_000) ?? null,
      };
    });
  }
  return out;
}

/**
 * THE LINKS ARE THE AUTHOR'S OWN. Each is looked up; a row that exists but is
 * somebody else's is refused with the words a missing one gets, so the door
 * says nothing about what exists.
 */
async function checkLinks(env: Env, userId: string, input: Partial<PostInput>, current: Record<string, unknown> | null) {
  const storeId = input.store_id !== undefined ? input.store_id : ((current?.store_id as string | null) ?? null);
  if (input.store_id) {
    const own = await storeForUser(env.DB, userId);
    if (!own || own.store.id !== input.store_id) throw badRequest('That store is not yours', 'POST_LINK_NOT_OWNED');
  }
  if (input.product_id) {
    const p = await env.DB.prepare('SELECT store_id, audience_user_id FROM community_products WHERE id = ?').bind(input.product_id).first<{ store_id: string | null; audience_user_id: string | null }>();
    if (!p || !storeId || p.store_id !== storeId || p.audience_user_id) throw badRequest('That product is not one of your store\'s', 'POST_LINK_NOT_OWNED');
  }
  if (input.printer_product_id) {
    const row = await env.DB.prepare('SELECT 1 AS x FROM products WHERE id = ?').bind(input.printer_product_id).first();
    if (!row) throw badRequest('That printer is not in the catalogue', 'POST_LINK_NOT_FOUND');
  }
  if (input.material_product_id) {
    const row = await env.DB.prepare('SELECT 1 AS x FROM products WHERE id = ?').bind(input.material_product_id).first();
    if (!row) throw badRequest('That material is not in the catalogue', 'POST_LINK_NOT_FOUND');
  }
  /**
   * A REQUEST OR A CUSTOM ORDER: the author was a party — the customer, or the
   * workshop that made it (through its store's merchant). The customer's own
   * job needs nobody's consent; a workshop's portfolio piece needs the
   * customer's, because the photographs are of the customer's part.
   */
  let consent: 'not_needed' | 'pending' | null = null;
  let customerToAsk: string | null = null;
  const orderId = input.community_order_id;
  const requestId = input.request_id;
  if (orderId || requestId) {
    const own = await storeForUser(env.DB, userId);
    const merchantId = own?.merchant.id ?? '';
    const job = orderId
      ? await env.DB.prepare('SELECT customer_id, merchant_id, request_id FROM community_orders WHERE id = ?').bind(orderId).first<{ customer_id: string; merchant_id: string; request_id: string }>()
      : await env.DB.prepare('SELECT customer_id, accepted_offer_id FROM community_requests WHERE id = ?').bind(requestId).first<{ customer_id: string; accepted_offer_id: string | null }>();
    if (!job) throw badRequest('That job is not one of yours', 'POST_LINK_NOT_OWNED');
    if (job.customer_id === userId) {
      consent = 'not_needed';
    } else {
      // The workshop that made it: the order's merchant, or the request's accepted offer's merchant.
      let maker = false;
      if (orderId) maker = !!merchantId && (job as { merchant_id: string }).merchant_id === merchantId;
      else if ((job as { accepted_offer_id: string | null }).accepted_offer_id && merchantId) {
        const o = await env.DB.prepare('SELECT merchant_id FROM community_offers WHERE id = ?').bind((job as { accepted_offer_id: string }).accepted_offer_id).first<{ merchant_id: string }>();
        maker = !!o && o.merchant_id === merchantId;
      }
      if (!maker) throw badRequest('That job is not one of yours', 'POST_LINK_NOT_OWNED');
      consent = 'pending';
      customerToAsk = job.customer_id;
    }
    if (orderId && !requestId) input.request_id = (job as { request_id?: string }).request_id ?? null;
  }
  return { consent, customerToAsk };
}

/**
 * THE PICTURES ARE THE AUTHOR'S OWN: under their `users/<uid>/posts/` prefix
 * (purpose=post) or their store's `merchants/<uid>/public/` prefix, AND in
 * the media ledger as theirs. A key that merely looks right is refused.
 */
async function checkMedia(env: Env, userId: string, media: PostInput['media']) {
  for (const m of media) {
    const owned = m.key.startsWith(`users/${userId}/posts/`) || m.key.startsWith(`merchants/${userId}/public/`);
    if (!owned) throw badRequest('That picture is not one of yours', 'POST_MEDIA_NOT_OWNED');
    const row = await env.DB.prepare('SELECT mime_type FROM file_objects WHERE object_key = ? AND owner_id = ? AND deleted_at IS NULL')
      .bind(m.key, userId)
      .first<{ mime_type: string }>();
    if (!row) throw badRequest('That picture is not one of yours', 'POST_MEDIA_NOT_OWNED');
    const isVideo = String(row.mime_type ?? '').startsWith('video/');
    if (isVideo !== (m.kind === 'video')) throw badRequest('A picture was sent as a video, or the other way round', 'POST_MEDIA_KIND');
  }
}

function mediaStatements(env: Env, postId: string, media: PostInput['media']) {
  const stmts = [env.DB.prepare('DELETE FROM community_post_media WHERE post_id = ?').bind(postId)];
  media.forEach((m, i) => {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO community_post_media (id, post_id, kind, media_key, width, height, duration_s, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(newId('pm'), postId, m.kind, m.key, m.width, m.height, m.duration_s, i)
    );
  });
  return stmts;
}

/** «صور من قطعتك»: the customer is asked before a workshop shows their part. */
async function askConsent(env: Env, postId: string, customerId: string, authorName: string, title: string) {
  await notify(env.DB, {
    userId: customerId,
    kind: 'portfolio_consent',
    title_ar: 'ورشة تريد عرض قطعتك في معرض أعمالها',
    title_en: 'A workshop wants to show your part in its portfolio',
    body_ar: `${authorName}: «${title}» — افتح لتوافق أو ترفض.`,
    body_en: `${authorName}: “${title}” — open to allow or decline.`,
    link: postHref(postId),
    entity_type: 'community_post',
    entity_id: postId,
    eventKey: `portfolio_consent:${postId}`,
  });
}

communityPostRoutes.post('/posts', requireAuth, async (c) => {
  await rateLimit(c, 'post-create', 20, 3600);
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = readPost(body, false) as PostInput;
  const { consent, customerToAsk } = await checkLinks(c.env, user.id, input, null);
  await checkMedia(c.env, user.id, input.media);
  const id = newId('prj');
  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO community_posts
         (id, author_id, kind, title, body, state, visibility, printer_product_id, printer_name, material_product_id, material, color,
          print_settings, print_time_minutes, dimensions, tags, store_id, product_id, request_id, community_order_id, consent_status,
          created_at, updated_at)
       VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, user.id, input.kind, input.title, input.body, input.visibility, input.printer_product_id, input.printer_name,
      input.material_product_id, input.material, input.color, JSON.stringify(input.print_settings), input.print_time_minutes,
      JSON.stringify(input.dimensions), JSON.stringify(input.tags), input.store_id, input.product_id, input.request_id,
      input.community_order_id, consent ?? 'not_needed', ts, ts
    ),
    ...mediaStatements(c.env, id, input.media),
  ]);
  if (customerToAsk) await askConsent(c.env, id, customerToAsk, user.name || user.username || '', input.title);
  await audit(c.env.DB, user.id, 'community.post_created', id, { kind: input.kind, media: input.media.length });
  const p = await loadPost(c.env, id);
  return c.json({ success: true, post: postCard(p!, rootDomainFrom(c.env)) }, 201);
});

async function ownPost(c: Context<AppContext>, id: string): Promise<Record<string, unknown>> {
  const user = c.get('user')!;
  const p = await c.env.DB.prepare('SELECT * FROM community_posts WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!p || p.author_id !== user.id) throw notFound('Project not found');
  return p;
}

communityPostRoutes.patch('/posts/:id', requireAuth, async (c) => {
  await rateLimit(c, 'post-edit', 120, 3600);
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const current = await ownPost(c, id);
  if (current.state === 'archived') throw conflict('An archived project cannot be edited — restore it first', 'POST_ARCHIVED');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const input = readPost(body, true);
  const { consent, customerToAsk } = await checkLinks(c.env, user.id, input, current);
  if (input.media) await checkMedia(c.env, user.id, input.media);
  // A PUBLISHED piece keeps the promises publishing made: it cannot lose its
  // last picture, and it cannot take on a customer's part without their
  // answer — link the job on a draft, or archive first.
  if (current.state === 'published') {
    if (input.media && input.media.length === 0) throw badRequest('A published project keeps at least one picture', 'POST_NEEDS_MEDIA');
    if (consent === 'pending') throw conflict('Ask the customer from a draft: archive the project, link the job, and publish once they allow it', 'CONSENT_REQUIRED');
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (input.title !== undefined) put('title', input.title);
  if (input.body !== undefined) put('body', input.body);
  if (input.kind !== undefined) put('kind', input.kind);
  if (input.visibility !== undefined) put('visibility', input.visibility);
  if (input.printer_product_id !== undefined) put('printer_product_id', input.printer_product_id);
  if (input.printer_name !== undefined) put('printer_name', input.printer_name);
  if (input.material_product_id !== undefined) put('material_product_id', input.material_product_id);
  if (input.material !== undefined) put('material', input.material);
  if (input.color !== undefined) put('color', input.color);
  if (input.print_settings !== undefined) put('print_settings', JSON.stringify(input.print_settings));
  if (input.print_time_minutes !== undefined) put('print_time_minutes', input.print_time_minutes);
  if (input.dimensions !== undefined) put('dimensions', JSON.stringify(input.dimensions));
  if (input.tags !== undefined) put('tags', JSON.stringify(input.tags));
  if (input.store_id !== undefined) put('store_id', input.store_id);
  if (input.product_id !== undefined) put('product_id', input.product_id);
  if (input.request_id !== undefined) put('request_id', input.request_id);
  if (input.community_order_id !== undefined) put('community_order_id', input.community_order_id);
  // A job link that changed resets the consent question to what the new link needs.
  if (consent !== null) put('consent_status', consent);
  else if (input.request_id === null && input.community_order_id === null && (current.request_id || current.community_order_id)) put('consent_status', 'not_needed');
  put('updated_at', nowIso());
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE community_posts SET ${sets.join(', ')} WHERE id = ? AND author_id = ?`).bind(...vals, id, user.id),
    ...(input.media ? mediaStatements(c.env, id, input.media) : []),
  ]);
  if (customerToAsk && consent === 'pending' && current.consent_status !== 'pending') {
    await askConsent(c.env, id, customerToAsk, user.name || user.username || '', input.title ?? String(current.title));
  }
  await audit(c.env.DB, user.id, 'community.post_edited', id, { fields: sets.map((s) => s.split(' ')[0]) });
  const p = await loadPost(c.env, id);
  return c.json({ success: true, post: postCard(p!, rootDomainFrom(c.env)) });
});

/**
 * PUBLISH. A title and at least one picture; a portfolio piece only with its
 * customer's consent. Publishing a first project makes the author's creator
 * page public (the composer says so before the tap).
 */
communityPostRoutes.post('/posts/:id/publish', requireAuth, async (c) => {
  await rateLimit(c, 'post-publish', 30, 3600);
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const current = await ownPost(c, id);
  if (current.state === 'published') return c.json({ success: true, replayed: true, published_at: current.published_at, post: postCard(current, rootDomainFrom(c.env)) });
  if (current.admin_hidden_at) throw conflict('Levonis hid this project — it cannot be published until the review is lifted', 'POST_HIDDEN_BY_ADMIN');
  if (current.consent_status === 'pending') throw conflict('Waiting for the customer\'s permission to show their part', 'CONSENT_REQUIRED');
  if (current.consent_status === 'declined') throw conflict('The customer declined to have their part shown', 'CONSENT_DECLINED');
  const media = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM community_post_media WHERE post_id = ?').bind(id).first<{ n: number }>();
  if (!Number(media?.n)) throw badRequest('Add at least one picture before publishing', 'POST_NEEDS_MEDIA');
  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_posts SET state = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
        WHERE id = ? AND author_id = ? AND state <> 'published'`
    ).bind(ts, ts, id, user.id),
    c.env.DB.prepare('UPDATE users SET creator_public = 1 WHERE id = ? AND creator_public = 0').bind(user.id),
  ]);
  await audit(c.env.DB, user.id, 'community.post_published', id, {});
  const p = await loadPost(c.env, id);
  return c.json({ success: true, post: postCard(p!, rootDomainFrom(c.env)) });
});

communityPostRoutes.post('/posts/:id/archive', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  await ownPost(c, id);
  await c.env.DB.prepare("UPDATE community_posts SET state = 'archived', updated_at = ? WHERE id = ? AND author_id = ?").bind(nowIso(), id, user.id).run();
  await audit(c.env.DB, user.id, 'community.post_archived', id, {});
  const p = await loadPost(c.env, id);
  return c.json({ success: true, post: postCard(p!, rootDomainFrom(c.env)) });
});

communityPostRoutes.post('/posts/:id/restore', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const current = await ownPost(c, id);
  if (current.state !== 'archived') return c.json({ success: true, replayed: true, post: postCard(current, rootDomainFrom(c.env)) });
  // Back to a draft: the author republishes deliberately (the date is kept).
  await c.env.DB.prepare("UPDATE community_posts SET state = 'draft', updated_at = ? WHERE id = ? AND author_id = ?").bind(nowIso(), id, user.id).run();
  const p = await loadPost(c.env, id);
  return c.json({ success: true, post: postCard(p!, rootDomainFrom(c.env)) });
});

/** A draft or an archived post may be deleted outright; a published one is archived first. */
communityPostRoutes.delete('/posts/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const current = await ownPost(c, id);
  if (current.state === 'published') throw conflict('Archive the project first', 'POST_PUBLISHED');
  await c.env.DB.prepare('DELETE FROM community_posts WHERE id = ? AND author_id = ?').bind(id, user.id).run();
  await audit(c.env.DB, user.id, 'community.post_deleted', id, {});
  return c.json({ success: true });
});

/** The customer answers a workshop's request to show their part. */
communityPostRoutes.post('/posts/:id/consent', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const decision = oneOf(body.decision, 'decision', ['granted', 'declined'] as const);
  const p = await c.env.DB.prepare(
    `SELECT p.id, p.author_id, p.consent_status, p.request_id, p.community_order_id,
            COALESCE(o.customer_id, r.customer_id) AS customer_id
       FROM community_posts p
       LEFT JOIN community_orders o ON o.id = p.community_order_id
       LEFT JOIN community_requests r ON r.id = p.request_id
      WHERE p.id = ?`
  )
    .bind(id)
    .first<{ author_id: string; consent_status: string; customer_id: string | null }>();
  if (!p || p.customer_id !== user.id) throw notFound('Project not found');
  if (p.consent_status === 'not_needed') throw conflict('This project needs no permission of yours', 'CONSENT_NOT_NEEDED');
  await c.env.DB.prepare('UPDATE community_posts SET consent_status = ?, updated_at = ? WHERE id = ?').bind(decision, nowIso(), id).run();
  await audit(c.env.DB, user.id, 'community.post_consent', id, { decision });
  await notify(c.env.DB, {
    userId: p.author_id,
    kind: 'portfolio_consent',
    title_ar: decision === 'granted' ? 'وافق الزبون على عرض قطعته' : 'رفض الزبون عرض قطعته',
    title_en: decision === 'granted' ? 'The customer allowed showing their part' : 'The customer declined to have their part shown',
    body_ar: decision === 'granted' ? 'يمكنك نشر المشروع الآن.' : 'أزل ربط الطلب أو الصور لتنشر المشروع.',
    body_en: decision === 'granted' ? 'You can publish the project now.' : 'Unlink the job or its pictures to publish.',
    link: postHref(id),
    entity_type: 'community_post',
    entity_id: id,
    eventKey: `portfolio_consent:${id}:${decision}`,
  });
  return c.json({ success: true, consent_status: decision });
});

/** «مشاريعي»: the author's own list, every state, newest first. */
communityPostRoutes.get('/my-posts', requireAuth, async (c) => {
  const user = c.get('user')!;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 24 });
  const cursor = feedCursor(c.req.query('cursor'));
  const root = rootDomainFrom(c.env);
  const { results } = await c.env.DB.prepare(
    `SELECT ${POST_COLUMNS} ${POST_FROM}
      WHERE p.author_id = ?1
        AND (?2 = '' OR p.created_at < ?2 OR (p.created_at = ?2 AND p.id < ?3))
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?4`
  )
    .bind(user.id, cursor.at, cursor.id, limit + 1)
    .all<Record<string, unknown>>();
  const next_cursor = nextPostCursor(results, limit, 'created_at');
  return c.json({
    success: true,
    posts: (await withViewerFlags(c.env.DB, user.id, results.map((p) => postCard(p, root)))).map((card, i) => ({
      ...card,
      consent_status: String(results[i].consent_status),
      hidden: !!results[i].admin_hidden_at,
    })),
    next_cursor,
  });
});

// -------------------------------------------------------------- creators

/**
 * A CREATOR PAGE (/u/<username>) — public for an account that chose to be:
 * it published a project (which set `creator_public`), switched it on in its
 * profile, or owns a store (public already through the store). Everyone else's
 * page is a 404, as their bio has always been the account's own. The socials
 * are handles the account typed to be shown; the email and the phone never.
 */
/**
 * The socials a creator page shows, by allow-list: the public name → the key
 * the profile editor stores it under (src/pages/EditProfile.tsx writes
 * `xAccount`; older accounts may hold `x`). Nothing else in profile_json is
 * ever returned.
 */
const SOCIAL_KEYS: ReadonlyArray<readonly [name: string, ...keys: string[]]> = [
  ['instagram', 'instagram'],
  ['x', 'x', 'xAccount'],
  ['tiktok', 'tiktok'],
  ['facebook', 'facebook'],
  ['youtube', 'youtube'],
];

async function creatorRow(env: Env, username: string) {
  return env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.avatar_key, u.bio, u.website, u.profile_json, u.country, u.created_at, u.creator_public,
            u.follower_count, cm.id AS merchant_id, cm.status AS merchant_status
       FROM users u LEFT JOIN community_merchants cm ON cm.user_id = u.id
      WHERE u.username = ?`
  )
    .bind(username.trim().toLowerCase())
    .first<Record<string, unknown>>();
}

export function creatorVisible(u: Record<string, unknown>, viewer: { id: string; role: string } | null): boolean {
  if (viewer && (viewer.id === u.id || viewer.role === 'admin')) return true;
  if (Number(u.creator_public) === 1) return true;
  return !!u.merchant_id && u.merchant_status !== 'suspended';
}

communityPostRoutes.get('/creators/:username', async (c) => {
  const username = str(c.req.param('username'), 'username', { min: 1, max: 40 });
  const viewer = c.get('user') ?? null;
  const u = await creatorRow(c.env, username);
  if (!u || !creatorVisible(u, viewer)) throw notFound('Creator not found');
  // A block closes the page from both sides, with the words a missing page gets (0154).
  if (viewer && (await blockedEither(c.env.DB, viewer.id, String(u.id)))) throw notFound('Creator not found');
  const root = rootDomainFrom(c.env);
  const profile = safeParse<Record<string, unknown>>(u.profile_json, {}) ?? {};
  const socials: Record<string, string> = {};
  for (const [name, ...keys] of SOCIAL_KEYS) {
    const v = keys.map((k) => profile[k]).find((x) => typeof x === 'string' && x.trim());
    if (typeof v === 'string') socials[name] = v.trim().slice(0, 80);
  }
  const [projects, badges, store, following] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM community_posts p WHERE p.author_id = ? AND ${POST_PUBLIC_SQL}`).bind(u.id).first<{ n: number }>(),
    membershipBadges(c.env.DB, [u.id]),
    u.merchant_id && u.merchant_status !== 'suspended'
      ? c.env.DB.prepare(`SELECT ${COMMUNITY_DIRECTORY_COLUMNS} FROM community_merchants cm LEFT JOIN merchant_stores s ON s.merchant_id = cm.id WHERE cm.id = ?`)
          .bind(u.merchant_id)
          .first<Record<string, unknown>>()
      : Promise.resolve(null),
    viewer
      ? c.env.DB.prepare('SELECT 1 AS x FROM user_follows WHERE follower_id = ? AND user_id = ?').bind(viewer.id, u.id).first()
      : Promise.resolve(null),
  ]);
  const printers = Array.isArray(profile.printers) ? (profile.printers as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
  const materials = Array.isArray(profile.materials) ? (profile.materials as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
  return c.json({
    success: true,
    creator: {
      id: u.id,
      username: u.username,
      name: u.name,
      avatarUrl: fileUrl(u.avatar_key),
      bio: String(u.bio ?? ''),
      website: String(u.website ?? ''),
      socials,
      country: (u.country as string | null) ?? null,
      member_since: u.created_at,
      printers,
      materials,
      badges: {
        pro: badges.pro.has(String(u.id)),
        premium: badges.premium.has(String(u.id)),
        verified_merchant: !!(store && store.verified),
      },
      stats: {
        projects: Number(projects?.n ?? 0),
        completed_jobs: store ? Number(store.completed_orders ?? 0) : 0,
        followers: Number(u.follower_count ?? 0),
      },
      store: store && store.store_status !== 'suspended' ? directoryCard(store, badges, root) : null,
      viewer: {
        mine: !!viewer && viewer.id === u.id,
        following: !!following,
        // Only the VIEWER's own block is told: whether the other side blocked them is nobody's business (it reads as 404).
        blocked: false,
      },
    },
  });
});
