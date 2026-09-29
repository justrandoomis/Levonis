/**
 * UNIFIED SEARCH AND DISCOVERY for the community (docs/COMMUNITY_ECOSYSTEM.md
 * §9.3, Phase 3) — one door that asks every community list the same question
 * and hands back each list's OWN card:
 *
 *   GET /search?q=&types=&limit=   the seven sections, each ≤ 12 rows + a bounded total
 *   GET /search/suggest?q=          ≤ 8 completions from NAMES only
 *   GET /trending                   projects, tags, stores, creators — from counters that exist
 *   GET /recommend?for=…            «قد يعجبك» beside a post, a store or a product
 *
 * WHAT IS NOT HERE, ON PURPOSE. No new table, no search log, no query
 * tracking (the brief: «no invasive tracking») — «recent searches» live in
 * the browser. And NO NEW VISIBILITY PREDICATE: every section is the SQL its
 * own list already publishes with — `POST_PUBLIC_SQL` + `postExclusionSql`,
 * `communityDirectoryVisible`, `creatorListSql`, `communityProductsVisible`,
 * `requestBoardVisible` — so a thing this door finds is a thing its list
 * shows, and a hidden post, a suspended shop, a private product, a draft
 * request or a closed creator page is absent here because it is absent
 * there. A private product is `status = 'hidden'` by 0152's trigger; a
 * suspended store is out of the directory rule; the exclusions for a
 * signed-in viewer are Phase 2's helpers, never a second copy — and the one
 * block predicate on a shop (`merchantBlockSql`) is the directory's own,
 * shared with GET /merchants and GET /products, so a blocked merchant is
 * gone from the list, the search, the suggestions and «قد يعجبك» alike.
 *
 * BOUNDED, EVERY ONE. A section reads at most 12 rows; its `total` is a
 * COUNT over a subquery that stops at 200 (`boundedCount`), so «+200» is the
 * most a badge ever says and no term can make a count walk a whole table;
 * every LIKE goes through `likePattern` (D1's 50-byte pattern limit,
 * wildcards literal); the catalogue index is used only where it is installed
 * and ready, with the catalogue route's own LIKE fallback otherwise;
 * `rateLimit('community-search', 120, 60)` per account or IP.
 *
 * THE EDGE CACHE. A guest's /search, /suggest and /recommend (60 s) and
 * everybody's /trending (5 min) go through `caches.default` under a CANONICAL
 * key — the origin, the path and the route's own parameters, sorted, as
 * worker/routes/publicApi.ts keys its answers — so an unknown or reordered
 * parameter cannot mint a second entry; the route's own `Cache-Control` is
 * re-stamped on a hit (the zone's browser TTL would otherwise inflate it —
 * worker/routes/catalog.ts saw four hours). A guest's answer is the same for
 * every guest (every viewer predicate collapses at ''), so it may be shared.
 * A signed-in /search, /suggest or /recommend answer carries the viewer's
 * block/mute exclusions, so it is `private, no-store` and never reaches the
 * shared cache. /trending is viewer-independent by construction (the client
 * hides blocked/muted authors itself, as Phase 2's rails do).
 *
 * A hit still pays `communityGate()`'s one `admin_settings` read (the gate is
 * mounted before every handler, and it is the wall): no row of the community
 * leaves while the owner keeps it closed, cached or not.
 *
 * ONE Promise.all runs the sections; a section whose query throws answers
 * `{ rows: [], total: null, error: true }` and is logged, so one bad column
 * on a fresh deploy does not blank the whole overlay.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { HttpError, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { rootDomainFrom } from '../lib/hosts';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { communityGate } from '../lib/communityGate';
import { membershipBadges } from '../lib/entitlements';
import { requestBoardVisible } from '../lib/requestBoard';
import { catalogSubtreeFilter } from '../lib/catalogMembership';
import { searchIndexInstalled, searchProducts } from '../lib/search/store';
import { suggestCompletion } from '../lib/search/complete';
import { canonicalProductMedia, upgradeMedia } from '../lib/productModel';
import {
  COMMUNITY_DIRECTORY_COLUMNS,
  COMMUNITY_DIRECTORY_FROM,
  COMMUNITY_PRODUCTS_FROM,
  communityDirectoryVisible,
  communityFeedProduct,
  communityProductsVisible,
  directoryCard,
  merchantBlockSql,
} from './community';
import {
  POST_COLUMNS,
  POST_FROM,
  POST_PUBLIC_SQL,
  POST_SEARCH,
  blockedEither,
  loadPost,
  mayRead,
  postCard,
  postExclusionSql,
  postHref,
  withViewerFlags,
} from './communityPosts';
import { creatorCard, creatorListSql } from './communitySocial';
import { publicRequest } from './marketplace';

export const communitySearchRoutes = new Hono<AppContext>();
communitySearchRoutes.use('*', communityGate());

// ----------------------------------------------------------------- limits

/** The most a person may type; the same bound every community search box keeps. */
export const SEARCH_QUERY_MAX = 60;
/** Below this a suggestion is noise: two letters, not one. */
export const SUGGEST_MIN = 2;
/** The most a section, a rail or a recommendation ever reads. */
export const SECTION_MAX = 12;
/** A `total` never counts past this — «+200» is the most a badge says. */
export const COUNT_BOUND = 200;
/** How many suggestions leave. */
const SUGGEST_MAX = 8;
/** The catalogue section whose products are «materials» (migration 0018). */
export const MATERIALS_CATALOG = 'cat_materials';
const THIRTY_DAYS_MS = 30 * 86_400_000;
/** How far back «قد يعجبك» looks for a post's neighbours: half a year, not the whole table. */
const RECOMMEND_WINDOW_MS = 180 * 86_400_000;

const RATE = ['community-search', 120, 60] as const;
const limitRate = (c: Context<AppContext>) => rateLimit(c, RATE[0], RATE[1], RATE[2]);

/** The trimmed term, refused past `SEARCH_QUERY_MAX` characters (code points, like the boxes count). */
function readQuery(c: Context<AppContext>): string {
  const raw = String(c.req.query('q') ?? '').trim();
  if ([...raw].length > SEARCH_QUERY_MAX) {
    throw new HttpError(400, `At most ${SEARCH_QUERY_MAX} characters`, 'SEARCH_QUERY_TOO_LONG');
  }
  return raw;
}

const enc = encodeURIComponent;
/** A JSON array column read by `json_each` without a malformed cell failing the whole statement. */
const jsonArr = (col: string) => `CASE WHEN json_valid(${col}) THEN ${col} ELSE '[]' END`;

// ------------------------------------------------------------- edge cache

function edgeCache(): Cache | null {
  return typeof caches !== 'undefined' ? ((caches as unknown as { default?: Cache }).default ?? null) : null;
}

/**
 * The cache key: the origin, the path and ONLY the parameters this route
 * declares, sorted — never the URL as sent, so `?x=1` or a reordered query
 * cannot mint a new shared entry (worker/routes/publicApi.ts `canonicalUrl`).
 */
export function cacheKeyUrl(url: string, params: readonly string[]): string {
  const u = new URL(url);
  const qs = [...params]
    .sort()
    .filter((k) => u.searchParams.has(k))
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(u.searchParams.get(k) ?? '')}`)
    .join('&');
  return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`;
}

/**
 * Serve from `caches.default` under this route's canonical key, or build and
 * store a 200. A hit leaves with THIS route's `Cache-Control`, not the
 * zone's. Only ever called for an answer that is the same for every visitor.
 */
async function cached(c: Context<AppContext>, cacheControl: string, params: readonly string[], build: () => Promise<Response>): Promise<Response> {
  const cache = edgeCache();
  const key = new Request(cacheKeyUrl(c.req.url, params), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key).catch(() => undefined);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set('Cache-Control', cacheControl);
      return res;
    }
  }
  const res = await build();
  if (res.status === 200) {
    res.headers.set('Cache-Control', cacheControl);
    if (cache) {
      const put = cache.put(key, res.clone()).catch(() => undefined);
      try {
        c.executionCtx.waitUntil(put);
      } catch {
        await put;
      }
    }
  }
  return res;
}

/** A signed-in answer carries the viewer's exclusions: it never reaches a shared cache. */
const privateAnswer = (c: Context<AppContext>) => c.header('Cache-Control', 'private, no-store');

// --------------------------------------------------------------- sections

export const SEARCH_SECTIONS = ['projects', 'stores', 'creators', 'products', 'requests', 'materials', 'brands'] as const;
export type SearchSection = (typeof SEARCH_SECTIONS)[number];

interface Section<T> {
  rows: T[];
  /** A bounded count (≤ COUNT_BOUND), or null when the section did not run. */
  total: number | null;
  /** The in-app page that lists the rest of this section with the term. */
  more: string;
  error?: true;
}

/** Where «الكل» goes for each section — the page or tab that already lists it, with the term. */
export const sectionMoreHref: Record<SearchSection, (q: string) => string> = {
  projects: (q) => `/community/projects?q=${enc(q)}`,
  stores: (q) => `/community?tab=stores&q=${enc(q)}`,
  creators: (q) => `/community?tab=creators&q=${enc(q)}`,
  products: (q) => `/community?tab=foryou&list=products&q=${enc(q)}`,
  // The board page keeps its own term in local state; the community's
  // requests tab is the list that reads `?q=` (src/pages/Community.tsx).
  requests: (q) => `/community?tab=requests&q=${enc(q)}`,
  materials: (q) => `/products?search=${enc(q)}&category=${MATERIALS_CATALOG}`,
  brands: (q) => `/products?search=${enc(q)}`,
};

const emptySection = <T>(name: SearchSection, q: string): Section<T> => ({ rows: [], total: null, more: sectionMoreHref[name](q) });

/** `SELECT COUNT(*)` over the first COUNT_BOUND matches — never the whole table. */
async function boundedCount(db: D1Database, inner: string, binds: unknown[]): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM (${inner} LIMIT ${COUNT_BOUND})`).bind(...binds).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

/** One section, guarded: a failing query answers empty and is logged; the others still land. */
async function guarded<T>(name: SearchSection, q: string, run: () => Promise<{ rows: T[]; total: number | null }>): Promise<Section<T>> {
  const more = sectionMoreHref[name](q);
  try {
    return { ...(await run()), more };
  } catch (e) {
    console.error(`community search: section "${name}" failed:`, e instanceof Error ? e.message : String(e));
    return { rows: [], total: null, more, error: true };
  }
}

interface SearchInput {
  db: D1Database;
  /** The term as typed (for the catalogue index). */
  raw: string;
  /** The term as a bound `likePattern`. */
  like: string;
  /** The viewer's id, or '' for a guest. */
  viewer: string;
  limit: number;
  root: string | null;
}

/** A catalogue product's first canonical picture, or null — never an external URL. */
function catalogueImage(images: unknown): string | null {
  try {
    return canonicalProductMedia(upgradeMedia(images))[0]?.url ?? null;
  } catch {
    return null;
  }
}

/** A catalogue material or a brand as the overlay draws it. */
function catalogueRow(r: Record<string, unknown>) {
  const slug = String(r.slug ?? '');
  return {
    id: String(r.id),
    slug,
    name: String(r.name ?? ''),
    name_ar: String(r.name_ar ?? ''),
    imageUrl: catalogueImage(r.images),
    href: `/product/${enc(slug)}`,
  };
}

async function searchProjects({ db, like, viewer, limit, root }: SearchInput) {
  const where = `${POST_PUBLIC_SQL} AND ${postExclusionSql('?2')} AND (${sqlLikeClause(POST_SEARCH, '?1')})`;
  const [{ results }, total] = await Promise.all([
    db.prepare(
      `SELECT ${POST_COLUMNS} ${POST_FROM}
        WHERE ${where}
        ORDER BY (p.title LIKE ?1 ESCAPE '\\') DESC, p.published_at DESC, p.id DESC LIMIT ?3`
    ).bind(like, viewer, limit).all<Record<string, unknown>>(),
    boundedCount(db, `SELECT p.id FROM community_posts p WHERE ${where}`, [like, viewer]),
  ]);
  return { rows: await withViewerFlags(db, viewer || null, results.map((p) => postCard(p, root))), total };
}

async function searchStores({ db, like, viewer, limit, root }: SearchInput) {
  const [{ results }, total] = await Promise.all([
    db.prepare(
      `SELECT ${COMMUNITY_DIRECTORY_COLUMNS},
              EXISTS (SELECT 1 FROM follows f WHERE f.merchant_id = cm.id AND f.user_id = ?3) AS viewer_follows
         ${COMMUNITY_DIRECTORY_FROM}
        WHERE ${communityDirectoryVisible('?1')} AND ${merchantBlockSql('?3')}
        ORDER BY (COALESCE(NULLIF(s.name, ''), cm.name) LIKE ?1 ESCAPE '\\') DESC,
                 cm.completed_orders DESC, cm.created_at DESC, cm.id DESC LIMIT ?2`
    ).bind(like, limit, viewer).all<Record<string, unknown>>(),
    boundedCount(db, `SELECT cm.id ${COMMUNITY_DIRECTORY_FROM} WHERE ${communityDirectoryVisible('?1')} AND ${merchantBlockSql('?2')}`, [like, viewer]),
  ]);
  const badges = await membershipBadges(db, results.map((m) => m.user_id));
  return { rows: results.map((m) => ({ ...directoryCard(m, badges, root), following: !!m.viewer_follows })), total };
}

async function searchCreators({ db, like, viewer, limit, root }: SearchInput) {
  const { where, from, withCounts, columns } = creatorListSql('?1', '?2');
  const [{ results }, total] = await Promise.all([
    db.prepare(
      `SELECT ${columns} ${withCounts}
        WHERE ${where}
        ORDER BY (u.name LIKE ?1 ESCAPE '\\' OR u.username LIKE ?1 ESCAPE '\\') DESC,
                 projects DESC, u.follower_count DESC, u.id DESC LIMIT ?3`
    ).bind(like, viewer, limit).all<Record<string, unknown>>(),
    boundedCount(db, `SELECT u.id ${from} WHERE ${where}`, [like, viewer]),
  ]);
  const badges = await membershipBadges(db, results.map((r) => r.id));
  return { rows: results.map((r) => creatorCard(r, badges, root)), total };
}

async function searchCommunityProducts({ db, like, viewer, limit, root }: SearchInput) {
  const [{ results }, total] = await Promise.all([
    db.prepare(
      `SELECT p.*, s.slug AS s_slug, s.name AS s_name, s.logo_key AS s_logo_key
         ${COMMUNITY_PRODUCTS_FROM}
        WHERE ${communityProductsVisible('?1')} AND ${merchantBlockSql('?3', 'm')}
        ORDER BY (p.name LIKE ?1 ESCAPE '\\' OR p.name_ar LIKE ?1 ESCAPE '\\') DESC, p.created_at DESC, p.id DESC LIMIT ?2`
    ).bind(like, limit, viewer).all<Record<string, unknown>>(),
    boundedCount(db, `SELECT p.id ${COMMUNITY_PRODUCTS_FROM} WHERE ${communityProductsVisible('?1')} AND ${merchantBlockSql('?2', 'm')}`, [like, viewer]),
  ]);
  return { rows: results.map((p) => communityFeedProduct(p, root)), total };
}

/**
 * Requests have no author to follow or mute; a block still closes the door
 * both ways — the same `user_blocks` question `blockedEither` asks, in SQL
 * against the request's customer.
 */
const requestBlockSql = (v: string) =>
  `(${v} = '' OR NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.user_id = ${v} AND b.blocked_id = r.customer_id) OR (b.user_id = r.customer_id AND b.blocked_id = ${v})))`;

async function searchRequests({ db, like, viewer, limit }: SearchInput) {
  const now = new Date().toISOString();
  const where = `${requestBoardVisible('?1', '?2')} AND ${requestBlockSql('?3')}`;
  const [{ results }, total] = await Promise.all([
    db.prepare(
      `SELECT r.*, u.name AS customer_name, u.username AS customer_username,
              (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count
         FROM community_requests r LEFT JOIN users u ON u.id = r.customer_id
        WHERE ${where}
        ORDER BY (r.title LIKE ?2 ESCAPE '\\') DESC, r.created_at DESC, r.id DESC LIMIT ?4`
    ).bind(now, like, viewer, limit).all<Record<string, unknown>>(),
    boundedCount(db, `SELECT r.id FROM community_requests r WHERE ${where}`, [now, like, viewer]),
  ]);
  return {
    rows: results.map((r) => ({ ...publicRequest(r), status: r.status, customer_username: r.customer_username ?? null })),
    total,
  };
}

/** The catalogue's columns every LIKE fallback reads (worker/routes/products.ts). */
const CATALOGUE_LIKE = ['name', 'name_ar', 'name_ku', 'description'] as const;

/**
 * The token index's answer for a term, or null when the index is not
 * installed or not yet built — the catalogue route's own two reasons to fall
 * back to LIKE rather than say the shop is empty.
 */
async function indexHits(db: D1Database, raw: string, limit: number): Promise<string[] | null> {
  if (!(await searchIndexInstalled(db))) return null;
  // A word still being typed is completed, as the catalogue completes it;
  // a trailing space says the word is finished.
  const hits = await searchProducts(db, raw, { limit, completeLast: !/\s$/u.test(raw) });
  return hits.indexReady ? hits.ids : null;
}

async function searchMaterials({ db, raw, like, limit }: SearchInput) {
  const subtree = catalogSubtreeFilter(MATERIALS_CATALOG, 'products');
  const hits = await indexHits(db, raw, COUNT_BOUND);
  if (hits) {
    if (hits.length === 0) return { rows: [], total: 0 };
    const { results } = await db.prepare(
      `SELECT id, slug, name, name_ar, images FROM products
        WHERE status = 'active' AND id IN (SELECT value FROM json_each(?)) AND ${subtree.sql}`
    ).bind(JSON.stringify(hits), ...subtree.params).all<Record<string, unknown>>();
    const rank = new Map(hits.map((id, i) => [id, i]));
    results.sort((a, b) => (rank.get(String(a.id)) ?? 0) - (rank.get(String(b.id)) ?? 0));
    return { rows: results.slice(0, limit).map(catalogueRow), total: Math.min(results.length, COUNT_BOUND) };
  }
  const where = `status = 'active' AND (${sqlLikeClause(CATALOGUE_LIKE)}) AND ${subtree.sql}`;
  const likes = CATALOGUE_LIKE.map(() => like);
  const [{ results }, total] = await Promise.all([
    db.prepare(`SELECT id, slug, name, name_ar, images FROM products WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(...likes, ...subtree.params, limit)
      .all<Record<string, unknown>>(),
    boundedCount(db, `SELECT id FROM products WHERE ${where}`, [...likes, ...subtree.params]),
  ]);
  return { rows: results.map(catalogueRow), total };
}

async function searchBrands({ db, like, limit }: SearchInput) {
  const where = `active = 1 AND (${sqlLikeClause(['name_en', 'name_ar', 'name_ckb', 'slug'], '?1')})`;
  const [{ results }, total] = await Promise.all([
    db.prepare(`SELECT id, slug, name_en, name_ar FROM brands WHERE ${where} ORDER BY name_en, id LIMIT ?2`).bind(like, limit).all<Record<string, unknown>>(),
    boundedCount(db, `SELECT id FROM brands WHERE ${where}`, [like]),
  ]);
  return {
    rows: results.map((b) => ({
      id: String(b.id),
      slug: String(b.slug ?? ''),
      name: String(b.name_en || b.name_ar || ''),
      name_ar: String(b.name_ar ?? ''),
      imageUrl: null as string | null,
      href: `/products?brand=${enc(String(b.slug ?? ''))}`,
    })),
    total,
  };
}

/** Which sections a `types=` list asks for; unknown names are ignored, none means all. */
export function readSections(types: unknown): SearchSection[] {
  const asked = String(types ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SearchSection => (SEARCH_SECTIONS as readonly string[]).includes(t));
  return asked.length ? SEARCH_SECTIONS.filter((s) => asked.includes(s)) : [...SEARCH_SECTIONS];
}

communitySearchRoutes.get('/search', async (c) => {
  const raw = readQuery(c);
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: SECTION_MAX, def: 5 });
  const asked = readSections(c.req.query('types'));
  const viewer = c.get('user')?.id ?? '';
  const build = async () => {
    await limitRate(c);
    return c.json(await runSearch(c, raw, asked, limit, viewer));
  };
  // A member's answer is per viewer: nothing shared may hold it. A guest's is
  // the same for every guest — two people typing the same word within a
  // minute share one answer at the edge, as they do for /suggest.
  if (viewer) {
    privateAnswer(c);
    return build();
  }
  return cached(c, 'public, max-age=60', ['q', 'types', 'limit'], build);
});

async function runSearch(c: Context<AppContext>, raw: string, asked: SearchSection[], limit: number, viewer: string) {
  const started = Date.now();
  const like = likePattern(raw);
  const sections: Record<SearchSection, Section<unknown>> = {
    projects: emptySection('projects', raw),
    stores: emptySection('stores', raw),
    creators: emptySection('creators', raw),
    products: emptySection('products', raw),
    requests: emptySection('requests', raw),
    materials: emptySection('materials', raw),
    brands: emptySection('brands', raw),
  };
  if (like) {
    const input: SearchInput = { db: c.env.DB, raw, like, viewer, limit, root: rootDomainFrom(c.env) };
    const runners: Record<SearchSection, (i: SearchInput) => Promise<{ rows: unknown[]; total: number | null }>> = {
      projects: searchProjects,
      stores: searchStores,
      creators: searchCreators,
      products: searchCommunityProducts,
      requests: searchRequests,
      materials: searchMaterials,
      brands: searchBrands,
    };
    const answers = await Promise.all(asked.map((name) => guarded(name, raw, () => runners[name](input))));
    asked.forEach((name, i) => {
      sections[name] = answers[i];
    });
  }
  return { success: true, q: raw, sections, took_ms: Date.now() - started };
}

// ------------------------------------------------------------ suggestions

type SuggestionType = 'project' | 'store' | 'creator' | 'product' | 'tag';
interface Suggestion {
  text: string;
  type: SuggestionType;
  href: string;
}

const hasArabic = (s: string) => /\p{Script=Arabic}/u.test(s);

/**
 * ≤ 8 completions, from NAMES ONLY: a store's name, a creator's name or
 * handle, a project's title, a catalogue product's name, a tag. Never a bio,
 * a description, a request — nothing a person wrote in prose, and nothing
 * (an email, a phone) that is not a name. The visibility is each list's
 * own rule with an empty term, and the match is a second LIKE on the name
 * columns alone, so a bio that mentions «dragon» cannot suggest its owner.
 */
async function suggestions(db: D1Database, raw: string, viewer: string): Promise<{ suggestions: Suggestion[]; completion: string | null }> {
  const like = likePattern(raw);
  const prefix = likePattern(raw, 'prefix');
  const tagPrefix = likePattern(raw.toLowerCase(), 'prefix');
  const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const creators = creatorListSql("''", '?3');
  const [projects, stores, makers, products, tags] = await Promise.all([
    db.prepare(
      `SELECT p.id, p.title FROM community_posts p
        WHERE ${POST_PUBLIC_SQL} AND ${postExclusionSql('?3')} AND p.title LIKE ?1 ESCAPE '\\'
        ORDER BY (p.title LIKE ?2 ESCAPE '\\') DESC, p.like_count DESC, p.published_at DESC, p.id DESC LIMIT ${SUGGEST_MAX}`
    ).bind(like, prefix, viewer).all<{ id: string; title: string }>(),
    db.prepare(
      `SELECT cm.id, COALESCE(NULLIF(s.name, ''), cm.name) AS text
         ${COMMUNITY_DIRECTORY_FROM}
        WHERE ${communityDirectoryVisible("''")} AND ${merchantBlockSql('?3')} AND (cm.name LIKE ?1 ESCAPE '\\' OR s.name LIKE ?1 ESCAPE '\\')
        ORDER BY (COALESCE(NULLIF(s.name, ''), cm.name) LIKE ?2 ESCAPE '\\') DESC, cm.completed_orders DESC, cm.created_at DESC LIMIT ${SUGGEST_MAX}`
    ).bind(like, prefix, viewer).all<{ id: string; text: string }>(),
    db.prepare(
      `SELECT u.name, u.username ${creators.from}
        WHERE ${creators.where} AND (u.name LIKE ?1 ESCAPE '\\' OR u.username LIKE ?1 ESCAPE '\\')
        ORDER BY (u.name LIKE ?2 ESCAPE '\\' OR u.username LIKE ?2 ESCAPE '\\') DESC, u.follower_count DESC, u.id LIMIT ${SUGGEST_MAX}`
    ).bind(like, prefix, viewer).all<{ name: string; username: string }>(),
    catalogueSuggestions(db, raw, like, prefix),
    // The tags of the last 30 days' public posts the viewer may see — the
    // trending window, so the walk over `json_each` is bounded by time, and
    // Phase 2's exclusion, so a tag unique to a blocked author's post is not
    // offered and then found to lead nowhere.
    db.prepare(
      `SELECT lower(t.value) AS tag, COUNT(*) AS n
         FROM community_posts p, json_each(${jsonArr('p.tags')}) t
        WHERE ${POST_PUBLIC_SQL} AND ${postExclusionSql('?2')} AND p.published_at >= ?3
          AND typeof(t.value) = 'text' AND lower(t.value) LIKE ?1 ESCAPE '\\'
        GROUP BY lower(t.value) ORDER BY n DESC, tag LIMIT ${SUGGEST_MAX}`
    ).bind(tagPrefix, viewer, since).all<{ tag: string; n: number }>(),
  ]);
  const lanes: Suggestion[][] = [
    projects.results.map((p) => ({ text: String(p.title), type: 'project' as const, href: postHref(String(p.id)) })),
    stores.results.map((s) => ({ text: String(s.text), type: 'store' as const, href: `/community/store/${enc(String(s.id))}` })),
    makers.results.map((u) => ({ text: String(u.name || u.username), type: 'creator' as const, href: `/u/${enc(String(u.username))}` })),
    products,
    tags.results.map((t) => ({ text: String(t.tag), type: 'tag' as const, href: `/community/projects?tag=${enc(String(t.tag))}` })),
  ];
  // Round-robin across the lanes, so eight suggestions are never eight stores.
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < SUGGEST_MAX && lanes.some((l) => i < l.length); i += 1) {
    for (const lane of lanes) {
      const s = lane[i];
      if (!s || !s.text) continue;
      const key = `${s.type}:${s.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
      if (out.length >= SUGGEST_MAX) break;
    }
  }
  // The grey word for the box: the catalogue's names first (they are ranked), then the rest.
  const completion = suggestCompletion(raw, [...products.map((p) => p.text), ...out.filter((s) => s.type !== 'product').map((s) => s.text)]);
  return { suggestions: out, completion };
}

/** Catalogue product names: the index's top hits where it answers, the LIKE fallback otherwise. */
async function catalogueSuggestions(db: D1Database, raw: string, like: string, prefix: string): Promise<Suggestion[]> {
  const hits = await indexHits(db, raw, SUGGEST_MAX);
  let rows: Array<{ id: string; slug: string; name: string; name_ar: string }>;
  if (hits) {
    if (hits.length === 0) return [];
    const { results } = await db.prepare(
      `SELECT id, slug, name, name_ar FROM products WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify(hits)).all<{ id: string; slug: string; name: string; name_ar: string }>();
    const rank = new Map(hits.map((id, i) => [id, i]));
    rows = results.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  } else {
    const { results } = await db.prepare(
      `SELECT id, slug, name, name_ar FROM products
        WHERE status = 'active' AND (name LIKE ?1 ESCAPE '\\' OR name_ar LIKE ?1 ESCAPE '\\' OR name_ku LIKE ?1 ESCAPE '\\')
        ORDER BY (name LIKE ?2 ESCAPE '\\' OR name_ar LIKE ?2 ESCAPE '\\') DESC, created_at DESC, id DESC LIMIT ${SUGGEST_MAX}`
    ).bind(like, prefix).all<{ id: string; slug: string; name: string; name_ar: string }>();
    rows = results;
  }
  const arabic = hasArabic(raw);
  return rows.map((p) => ({
    text: String((arabic && p.name_ar) || p.name || p.name_ar || ''),
    type: 'product' as const,
    href: `/product/${enc(String(p.slug))}`,
  }));
}

communitySearchRoutes.get('/search/suggest', async (c) => {
  const raw = readQuery(c);
  const viewer = c.get('user')?.id ?? '';
  const build = async () => {
    if ([...raw].length < SUGGEST_MIN) return c.json({ success: true, suggestions: [], completion: null });
    await limitRate(c);
    return c.json({ success: true, ...(await suggestions(c.env.DB, raw, viewer)) });
  };
  if (viewer) {
    privateAnswer(c);
    return build();
  }
  return cached(c, 'public, max-age=60', ['q'], build);
});

// --------------------------------------------------------------- trending

const TRENDING_PROJECTS = 8;
const TRENDING_TAGS = 12;
const TRENDING_STORES = 6;
const TRENDING_CREATORS = 6;

async function trendingProjects(db: D1Database, since: string, root: string | null) {
  // The existing /posts/trending, for a guest — the same score, the same window.
  const { results } = await db.prepare(
    `SELECT ${POST_COLUMNS} ${POST_FROM}
      WHERE ${POST_PUBLIC_SQL} AND p.published_at >= ?1
      ORDER BY (p.like_count * 3 + p.comment_count * 4 + p.save_count * 5 + p.view_count) DESC, p.published_at DESC, p.id DESC
      LIMIT ?2`
  ).bind(since, TRENDING_PROJECTS).all<Record<string, unknown>>();
  return withViewerFlags(db, null, results.map((p) => postCard(p, root)));
}

async function trendingTags(db: D1Database, since: string) {
  const { results } = await db.prepare(
    `SELECT lower(t.value) AS tag, COUNT(*) AS count
       FROM community_posts p, json_each(${jsonArr('p.tags')}) t
      WHERE ${POST_PUBLIC_SQL} AND p.published_at >= ?1 AND typeof(t.value) = 'text' AND t.value <> ''
      GROUP BY lower(t.value) ORDER BY count DESC, tag LIMIT ?2`
  ).bind(since, TRENDING_TAGS).all<{ tag: string; count: number }>();
  return results.map((r) => ({ tag: String(r.tag), count: Number(r.count) }));
}

async function trendingStores(db: D1Database, since: string, root: string | null) {
  const { results } = await db.prepare(
    `SELECT * FROM (
       SELECT ${COMMUNITY_DIRECTORY_COLUMNS},
              (SELECT COUNT(*) FROM community_orders o
                WHERE o.merchant_id = cm.id AND o.state = 'completed' AND COALESCE(o.completed_at, o.created_at) >= ?1) AS orders_30d,
              (SELECT COUNT(*) FROM follows f WHERE f.merchant_id = cm.id AND f.created_at >= ?1) AS follows_30d
         ${COMMUNITY_DIRECTORY_FROM}
        WHERE ${communityDirectoryVisible("''")}
     ) ORDER BY (orders_30d + follows_30d) DESC, rating_avg_x100 DESC, completed_orders DESC, id LIMIT ?2`
  ).bind(since, TRENDING_STORES).all<Record<string, unknown>>();
  const badges = await membershipBadges(db, results.map((m) => m.user_id));
  // Viewer-independent by construction: `following` is the client's to overlay from /me/social.
  return results.map((m) => ({ ...directoryCard(m, badges, root), following: false }));
}

async function trendingCreators(db: D1Database, since: string, root: string | null) {
  const { where, withCounts, columns } = creatorListSql("''", "''");
  const { results } = await db.prepare(
    `SELECT ${columns}, COALESCE(lk.n, 0) AS likes_30d
       ${withCounts}
       LEFT JOIN (SELECT p.author_id, COUNT(*) AS n
                    FROM community_likes l JOIN community_posts p ON p.id = l.post_id
                   WHERE ${POST_PUBLIC_SQL} AND l.created_at >= ?1 GROUP BY p.author_id) lk ON lk.author_id = u.id
      WHERE ${where} AND (COALESCE(pc.n, 0) > 0 OR u.follower_count > 0)
      ORDER BY likes_30d DESC, u.follower_count DESC, projects DESC, u.id LIMIT ?2`
  ).bind(since, TRENDING_CREATORS).all<Record<string, unknown>>();
  const badges = await membershipBadges(db, results.map((r) => r.id));
  return results.map((r) => creatorCard(r, badges, root));
}

/** How many shops the directory lists for a guest — the home's colophon, read once for everybody instead of once per visit. */
async function directoryCount(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n ${COMMUNITY_DIRECTORY_FROM} WHERE ${communityDirectoryVisible("''")}`).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

communitySearchRoutes.get('/trending', (c) =>
  cached(c, 'public, max-age=300', [], async () => {
    await limitRate(c);
    const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
    const root = rootDomainFrom(c.env);
    const db = c.env.DB;
    const [projects, tags, stores, creators, merchants] = await Promise.all([
      trendingProjects(db, since, root),
      trendingTags(db, since),
      trendingStores(db, since, root),
      trendingCreators(db, since, root),
      directoryCount(db),
    ]);
    return c.json({ success: true, projects, tags, stores, creators, totals: { merchants } });
  })
);

// -------------------------------------------------------------- recommend

const ANCHOR = /^(post|store|product):([A-Za-z0-9_-]{1,60})$/;
const anchorMissing = (what: string) => new HttpError(404, `${what} not found`, 'NOT_FOUND');

const stringList = (raw: unknown): string[] =>
  (safeParse<unknown[]>(raw, []) ?? []).filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim().toLowerCase());

/**
 * Other public posts sharing a tag, the material or the printer: 3 a tag,
 * 2 the material, 1 the printer, newest first among equals. Never the post
 * itself; never an author the viewer blocked, was blocked by, or muted.
 *
 * The anchor must be a post the viewer could find in a list — public, not
 * merely unlisted (a link-only piece may be read by whoever holds the link,
 * but it is in no list, and a guest's answer is stored in the shared cache);
 * the author and staff may stand beside any of their own. The candidates are
 * pre-filtered — the last 180 days, and only posts that share something with
 * the anchor — BEFORE the card projection, so the walk over `json_each` runs
 * over a window of neighbours, never over the whole published table.
 */
async function recommendForPost(c: Context<AppContext>, id: string, limit: number) {
  const viewer = c.get('user') ?? null;
  const p = await loadPost(c.env, id);
  const own = !!viewer && (viewer.id === p?.author_id || viewer.role === 'admin');
  const consentOk = p?.consent_status === 'not_needed' || p?.consent_status === 'granted';
  if (!p || !(own || (mayRead(p, viewer) && p.visibility === 'public' && consentOk))) throw anchorMissing('Project');
  if (viewer && (await blockedEither(c.env.DB, viewer.id, String(p.author_id)))) throw anchorMissing('Project');
  const tags = stringList(p.tags);
  const material = typeof p.material_product_id === 'string' ? p.material_product_id : '';
  const printer = typeof p.printer_product_id === 'string' ? p.printer_product_id : '';
  const v = viewer?.id ?? '';
  const root = rootDomainFrom(c.env);
  const since = new Date(Date.now() - RECOMMEND_WINDOW_MS).toISOString();
  const sharesTag = `EXISTS (SELECT 1 FROM json_each(${jsonArr('p.tags')}) t
                      WHERE typeof(t.value) = 'text' AND lower(t.value) IN (SELECT value FROM json_each(?2)))`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM (
       SELECT ${POST_COLUMNS},
              3 * (SELECT COUNT(*) FROM json_each(${jsonArr('p.tags')}) t
                    WHERE typeof(t.value) = 'text' AND lower(t.value) IN (SELECT value FROM json_each(?2)))
              + 2 * (CASE WHEN ?3 <> '' AND p.material_product_id = ?3 THEN 1 ELSE 0 END)
              + (CASE WHEN ?4 <> '' AND p.printer_product_id = ?4 THEN 1 ELSE 0 END) AS score
         ${POST_FROM}
        WHERE ${POST_PUBLIC_SQL} AND p.id <> ?1 AND p.published_at >= ?7 AND ${postExclusionSql('?5')}
          AND ((?3 <> '' AND p.material_product_id = ?3) OR (?4 <> '' AND p.printer_product_id = ?4) OR ${sharesTag})
     ) WHERE score > 0
     ORDER BY score DESC, published_at DESC, id DESC LIMIT ?6`
  ).bind(id, JSON.stringify(tags), material, printer, v, limit, since).all<Record<string, unknown>>();
  return { kind: 'projects' as const, rows: await withViewerFlags(c.env.DB, v || null, results.map((r) => postCard(r, root))) };
}

/**
 * Other visible stores in the same governorate or with a category in common;
 * the ones taking custom work first. Across a block the anchor does not
 * exist (404, as a blocked author's post), and no blocked shop is offered.
 */
async function recommendForStore(c: Context<AppContext>, id: string, limit: number) {
  const db = c.env.DB;
  const viewer = c.get('user')?.id ?? '';
  const anchor = await db.prepare(
    `SELECT cm.id, s.governorate, s.categories ${COMMUNITY_DIRECTORY_FROM}
      WHERE (cm.id = ?1 OR s.id = ?1) AND ${communityDirectoryVisible("''")} AND ${merchantBlockSql('?2')} LIMIT 1`
  ).bind(id, viewer).first<{ id: string; governorate: string | null; categories: string | null }>();
  if (!anchor) throw anchorMissing('Store');
  const gov = String(anchor.governorate ?? '').trim();
  const cats = JSON.stringify(stringList(anchor.categories));
  const root = rootDomainFrom(c.env);
  const shared = `(SELECT COUNT(*) FROM json_each(${jsonArr('s.categories')}) a
                    WHERE typeof(a.value) = 'text' AND lower(a.value) IN (SELECT value FROM json_each(?3)))`;
  const { results } = await db.prepare(
    `SELECT ${COMMUNITY_DIRECTORY_COLUMNS},
            EXISTS (SELECT 1 FROM follows f WHERE f.merchant_id = cm.id AND f.user_id = ?4) AS viewer_follows,
            (CASE WHEN ?2 <> '' AND s.governorate = ?2 THEN 1 ELSE 0 END) AS same_gov,
            ${shared} AS shared
       ${COMMUNITY_DIRECTORY_FROM}
      WHERE ${communityDirectoryVisible("''")} AND ${merchantBlockSql('?4')} AND cm.id <> ?1 AND s.id IS NOT NULL
        AND ((?2 <> '' AND s.governorate = ?2) OR ${shared} > 0)
      ORDER BY s.accepts_custom_requests DESC, shared DESC, same_gov DESC, cm.completed_orders DESC, cm.id LIMIT ?5`
  ).bind(anchor.id, gov, cats, viewer, limit).all<Record<string, unknown>>();
  const badges = await membershipBadges(db, results.map((m) => m.user_id));
  return { kind: 'stores' as const, rows: results.map((m) => ({ ...directoryCard(m, badges, root), following: !!m.viewer_follows })) };
}

/** Other stores' visible products with the same category or material word; never a blocked shop's, never one as anchor. */
async function recommendForProduct(c: Context<AppContext>, id: string, limit: number) {
  const db = c.env.DB;
  const viewer = c.get('user')?.id ?? '';
  const anchor = await db.prepare(
    `SELECT p.id, p.merchant_id, p.category, p.material ${COMMUNITY_PRODUCTS_FROM}
      WHERE p.id = ?1 AND ${communityProductsVisible("''")} AND ${merchantBlockSql('?2', 'm')} LIMIT 1`
  ).bind(id, viewer).first<{ id: string; merchant_id: string; category: string | null; material: string | null }>();
  if (!anchor) throw anchorMissing('Product');
  const cat = String(anchor.category ?? '').trim().toLowerCase();
  const mat = String(anchor.material ?? '').trim().toLowerCase();
  const root = rootDomainFrom(c.env);
  const { results } = await db.prepare(
    `SELECT p.*, s.slug AS s_slug, s.name AS s_name, s.logo_key AS s_logo_key,
            (CASE WHEN ?2 <> '' AND lower(COALESCE(p.category, '')) = ?2 THEN 1 ELSE 0 END)
            + (CASE WHEN ?3 <> '' AND lower(COALESCE(p.material, '')) = ?3 THEN 1 ELSE 0 END) AS score
       ${COMMUNITY_PRODUCTS_FROM}
      WHERE ${communityProductsVisible("''")} AND ${merchantBlockSql('?5', 'm')} AND p.merchant_id <> ?1
        AND ((?2 <> '' AND lower(COALESCE(p.category, '')) = ?2) OR (?3 <> '' AND lower(COALESCE(p.material, '')) = ?3))
      ORDER BY score DESC, p.created_at DESC, p.id DESC LIMIT ?4`
  ).bind(anchor.merchant_id, cat, mat, limit, viewer).all<Record<string, unknown>>();
  return { kind: 'products' as const, rows: results.map((p) => communityFeedProduct(p, root)) };
}

communitySearchRoutes.get('/recommend', async (c) => {
  const forRaw = String(c.req.query('for') ?? '').trim();
  const m = ANCHOR.exec(forRaw);
  if (!m) throw new HttpError(400, 'for must be post:<id>, store:<id> or product:<id>', 'RECOMMEND_ANCHOR_INVALID');
  const [, kind, id] = m;
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: SECTION_MAX, def: 6 });
  const viewer = c.get('user')?.id ?? '';
  const build = async () => {
    await limitRate(c);
    const answer =
      kind === 'post' ? await recommendForPost(c, id, limit) : kind === 'store' ? await recommendForStore(c, id, limit) : await recommendForProduct(c, id, limit);
    return c.json({ success: true, for: forRaw, kind: answer.kind, rows: answer.rows });
  };
  if (viewer) {
    privateAnswer(c);
    return build();
  }
  return cached(c, 'public, max-age=60', ['for', 'limit'], build);
});
