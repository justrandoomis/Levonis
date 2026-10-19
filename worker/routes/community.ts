import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, badRequest, notFound, str, int, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { membershipBadges } from '../lib/entitlements';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { feedCursor, nextFeedCursor } from '../lib/feedCursor';
import { requestBoardVisible } from '../lib/requestBoard';
import { communityAdminDoor, communityClosedRefusal, communityGate, communityMayEnter, readCommunityGate } from '../lib/communityGate';
import { audit } from '../lib/audit';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { anonymousCached } from '../lib/edgePolicy';
import { publishRequest } from './printRequests';
import { publicRequest } from './marketplace';
// Workshop facts on the store page, and the merchant's own board (0159, §9.5).
import { eligibleVerdictSql, publicWorkshopFacts } from '../lib/printMatchingStore';
import { storeForUser } from '../lib/merchantAuth';
import { merchantTakesNewWork } from '../lib/communityRequests';
import { approvedProvider, approvedProviderSql } from '../lib/merchantOps';
import {
  applicationRequiredRefusal,
  merchantApproved,
  merchantIsPublic,
  merchantPublicSql,
  publicMerchantById,
  publicStoreUnavailable,
  storeIsPublic,
  storePublicSql,
  withApprovalSchema,
} from '../lib/merchantApproval';

export const communityRoutes = new Hono<AppContext>();

/**
 * PRO STATUS BADGE — deliberately separate from verification.
 *
 * `community_merchants.verified` remains an administrator's independent
 * moderation mark. `pro_badge` is an ACTIVE PRO membership status and is
 * never described as identity/KYC verification. PRO lapses → only the PRO
 * badge disappears; the admin mark is unchanged.
 *
 * Resolved for a whole page of merchants in two queries rather than one
 * getTierStatus per row, but through the SAME `benefits.proMerchantBadge`
 * check so the rule cannot drift from entitlements.ts. `premium_badge` is
 * PREMIUM's own mark («شارة مميزة في مجتمع ليفو», migration 0145), resolved in
 * the same pass (`membershipBadges`): one badge per person, the highest held.
 */
function merchantPublic(m: Record<string, unknown>, badges: { pro: Set<string>; premium: Set<string> }) {
  return {
    id: m.id,
    // The account behind the store, so a customer can open a conversation
    // with them. It is an opaque id — no email, no phone, nothing that
    // identifies the person beyond what the store page already shows — and
    // POST /api/chats/open is the only thing that accepts it.
    user_id: m.user_id,
    name: m.name,
    bio: m.bio,
    avatarUrl: m.avatar_key ? `/files/${m.avatar_key}` : null,
    verified: !!m.verified,
    /**
     * «مزوّد معتمد» (owner decision C4): a reviewer approved this merchant and
     * they are not suspended — `approvedProvider`, the public predicate on the
     * row's own `status` and `approved_at`. Separate from `verified` above.
     */
    approved_provider: approvedProvider(m),
    pro_badge: badges.pro.has(String(m.user_id)),
    /** PREMIUM's own mark in the community (0145) — never beside a PRO badge. */
    premium_badge: badges.premium.has(String(m.user_id)),
    created_at: m.created_at,
  };
}

function communityProductPublic(p: Record<string, unknown>) {
  return {
    id: p.id,
    slug: p.slug,
    merchant_id: p.merchant_id,
    name: p.name,
    name_ar: p.name_ar,
    description: p.description,
    description_ar: p.description_ar,
    images: safeParse(p.images, []),
    price_iqd: p.price_iqd,
    original_price_iqd: p.original_price_iqd,
    created_at: p.created_at,
  };
}

/** A media key as the address `/files/*` serves it, or null. */
const fileUrl = (key: unknown) => (typeof key === 'string' && key ? `/files/${key}` : null);

// The feeds page by (created_at, id): worker/lib/feedCursor.ts.

/**
 * A card in the community's product feed: the product, WHERE IT CAN BE BOUGHT,
 * and the shop that sells it.
 *
 * `url` is the store's product page on THIS site — `/community/store/<store
 * slug>/p/<product slug>`, the route StorefrontProduct resolves by the store's
 * slug and sells from (its own cart door), and the address the storefront
 * itself links a product by on the main site. It stays in-site even when the
 * shop has its own subdomain: a feed tap should not open a tab per product.
 * The SHOP is its own site (`store.url`), and the store cards go there.
 *
 * A card used to open /product/:slug for every row, which is the platform
 * catalogue's page: it renders a community listing as «not sold through the
 * store cart» (COMMUNITY_LISTING_NOT_SELLABLE) — a dead end for a product its
 * own store sells. /product/:slug is kept only for a pre-store listing, which
 * has no store to be bought from.
 *
 * `in_stock` is the storefront's own boolean (`!track_stock || stock > 0`),
 * never the count — and null for a pre-store listing, which has no cart path
 * for the question to be about.
 */
export function communityFeedProduct(p: Record<string, unknown>, root: string | null) {
  const storeId = typeof p.store_id === 'string' && p.store_id ? p.store_id : null;
  const storeSlug = typeof p.s_slug === 'string' && p.s_slug ? p.s_slug : null;
  const productSlug = encodeURIComponent(String(p.slug ?? ''));
  if (!storeId || !storeSlug) {
    return { ...communityProductPublic(p), in_stock: null, url: `/product/${productSlug}`, store: null };
  }
  return {
    ...communityProductPublic(p),
    in_stock: !Number(p.track_stock) || Number(p.stock) > 0,
    url: `/community/store/${encodeURIComponent(storeSlug)}/p/${productSlug}`,
    store: {
      id: storeId,
      slug: storeSlug,
      name: p.s_name ?? '',
      logoUrl: fileUrl(p.s_logo_key),
      url: storeUrl(storeSlug, root, storeId),
      /** «مزوّد معتمد» (C4), read as `COMMUNITY_FEED_COLUMNS` selects it; a row read without it carries no mark. */
      approved_provider: Number(p.m_approved_provider ?? 0) === 1,
    },
  };
}

// ------------------------------------------------- the maintenance gate

/**
 * PUBLIC, AND ALWAYS ANSWERS. Registered BEFORE the gate — and named in
 * COMMUNITY_GATE_OPEN_PATHS so the order can never be the only thing keeping
 * it alive — so the app can ask "is the community open to me?" without being
 * refused, and can then say «تحت الصيانة» because the SERVER said so. That is
 * what lets the owner open the community, or add one member to the list, with
 * one settings write and no deploy.
 *
 * `may_enter` folds the admin door and the allow-list in, so an admin's own
 * phone shows the working community while a customer's shows the notice, and
 * an allow-listed member's shows the community without being told they are on
 * a list. `closed` is what the CARD says; `may_enter` is what this viewer may
 * do about it. They differ for exactly those two people.
 */
communityRoutes.get('/access', (c) =>
  // A GUEST'S verdict is every guest's verdict — `admin: false`, `may_enter`
  // iff the switch is open — so it is served from the colo's cache (P2a) and
  // the gate PUT purges it. A request that carries a session is answered for
  // that person and never cached: a shared entry would hand one member's
  // verdict to the next visitor through it.
  anonymousCached(c, { perViewer: true }, async () => {
    const gate = await readCommunityGate(c.env.DB);
    const user = c.get('user');
    c.header('Cache-Control', 'no-store');
    return c.json({
      success: true,
      closed: !gate.open,
      admin: communityAdminDoor(user),
      may_enter: communityMayEnter(gate, user),
    });
  })
);

/**
 * The wall. See worker/lib/communityGate.ts for which handlers sit inside it
 * and which few answer with it up — that enumeration was traced to its
 * callers, because closing a merchant out of their own live shop is the one
 * way this change could cost somebody real money.
 */
communityRoutes.use('*', communityGate());

/**
 * THE COMMUNITY'S PRODUCTS — what the stores have PUBLISHED, newest first, a
 * page at a time, searchable on the server (`q`), with the shop that sells
 * each one and the page it can be bought on (`communityFeedProduct`).
 *
 * "Published" is the storefront's own predicate, `lifecycle = 'active' AND
 * status = 'active'` (worker/routes/storefront.ts, and the 0126 mirrors keep
 * the two in step). Nothing of a SANCTIONED shop — a suspended merchant, or a
 * suspended store — is served anywhere (owner decision 2026-09-24). The
 * merchant suspension no longer rewrites the store row, so both are asked.
 * Since Community V3 push 1.4 the merchant must also be APPROVED, and the
 * product must sit in a store (an inner join): one public predicate,
 * `merchantPublicSql` / `storePublicSql` (worker/lib/merchantApproval.ts).
 *
 * Search used to be the page filtering the twenty rows it happened to hold,
 * which answered «لا توجد نتائج» for a product that was simply on page two.
 * The term goes through `likePattern`, which escapes the wildcards a person
 * types and keeps the pattern inside D1's 50-byte limit (worker/lib/sqlLike.ts
 * — Arabic is two bytes a letter). `total` is counted on the first page only,
 * so «عرض المزيد» can say how many are left.
 */
const PRODUCT_SEARCH = ['p.name', 'p.name_ar', 'p.description', 'p.description_ar'] as const;

/**
 * The feed's rows and its visibility rule, shared with the public API
 * (worker/lib/publicApi/resources/community.ts) so both publish exactly the
 * same products. `q` is the placeholder holding the `likePattern` term.
 */
export const COMMUNITY_PRODUCTS_FROM = `FROM community_products p
       JOIN community_merchants m ON m.id = p.merchant_id
       JOIN merchant_stores s ON s.id = p.store_id`;

/**
 * A feed card's columns over `COMMUNITY_PRODUCTS_FROM`: the product, its
 * store, and the merchant's «مزوّد معتمد» mark (C4) through the one public
 * predicate. `schema` as `communityProductsVisible`'s.
 */
export const COMMUNITY_FEED_COLUMNS = (schema = true) =>
  `p.*, s.slug AS s_slug, s.name AS s_name, s.logo_key AS s_logo_key, ${approvedProviderSql('m', schema)} AS m_approved_provider`;

/**
 * `schema` is false only on `withApprovalSchema`'s second try, on a database
 * without 0204: the merchant predicate is then FALSE, so the list is empty
 * (owner decision C11) instead of a 500 — or, worse, open.
 */
export const communityProductsVisible = (q: string, schema = true) => `p.lifecycle = 'active' AND p.status = 'active'
        AND ${merchantPublicSql('m', schema)} AND ${storePublicSql('s')}
        AND (${q} = '' OR ${sqlLikeClause(PRODUCT_SEARCH, q)})`;

/**
 * THE VIEWER'S BLOCK, ON A SHOP (Phase 3 review): a signed-in viewer never
 * meets a merchant they blocked or who blocked them — not in the directory,
 * not among the products, not as a suggestion or a «قد يعجبك» row — the same
 * `user_blocks` question `postExclusionSql` asks of a post's author, here of
 * the merchant's account. `v` is the placeholder holding the viewer's id ('' for
 * a guest, who sees the list's rule alone); `alias` names the
 * `community_merchants` row in scope (`cm` in the directory, `m` in the feed).
 * A mute is a matter between makers and their posts; a shop knows no mute.
 */
export const merchantBlockSql = (v: string, alias: 'cm' | 'm' = 'cm') =>
  `(${v} = '' OR NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.user_id = ${v} AND b.blocked_id = ${alias}.user_id) OR (b.user_id = ${alias}.user_id AND b.blocked_id = ${v})))`;

communityRoutes.get('/products', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 24 });
  const cursor = feedCursor(c.req.query('cursor'));
  const q = likePattern(c.req.query('q'));
  const root = rootDomainFrom(c.env);
  const from = COMMUNITY_PRODUCTS_FROM;
  const viewer = c.get('user')?.id ?? '';
  const [{ results }, total] = await withApprovalSchema((schema) => {
    const visible = `${communityProductsVisible('?1', schema)} AND ${merchantBlockSql('?5', 'm')}`;
    const visibleCount = `${communityProductsVisible('?1', schema)} AND ${merchantBlockSql('?2', 'm')}`;
    return Promise.all([
      c.env.DB.prepare(
        `SELECT ${COMMUNITY_FEED_COLUMNS(schema)}
           ${from}
          WHERE ${visible}
            AND (?2 = '' OR p.created_at < ?2 OR (p.created_at = ?2 AND p.id < ?3))
          ORDER BY p.created_at DESC, p.id DESC LIMIT ?4`
      ).bind(q, cursor.at, cursor.id, limit, viewer).all<Record<string, unknown>>(),
      cursor.at === ''
        ? c.env.DB.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${visibleCount}`).bind(q, viewer).first<{ n: number }>()
        : Promise.resolve(null),
    ]);
  });
  return c.json({
    success: true,
    products: results.map((p) => communityFeedProduct(p, root)),
    next_cursor: nextFeedCursor(results, limit),
    total: total ? Number(total.n) : null,
  });
});

/**
 * THE STORES OF THE COMMUNITY — the directory, newest first, a page at a time,
 * searchable on the server.
 *
 * A card shows the shop the visitor will LAND ON: the store's name, logo,
 * tagline and governorate where there is a store; a profile-only merchant from
 * the pre-store era keeps its community name and avatar. Beside it, the trust
 * signals its storefront already publishes (worker/routes/storefront.ts):
 * rating, completed orders, followers and published products. None of this is
 * new information about a merchant — it is each shop's own header, read for a
 * page of shops at once. The merchant row's own governorate is NOT served: the
 * store's is published on its page, the merchant's never was.
 *
 * `following` answers for the signed-in viewer (false for a guest), so a card
 * can offer «متابعة» or «تتابعه» without a request per card.
 *
 * NOTHING OF A SANCTIONED SHOP (review S5, owner decision 2026-09-24): a
 * suspended merchant or a suspended store is not in the directory at all —
 * its name, bio and avatar are exactly what the storefront no longer serves,
 * and a card linking to the in-site page would advertise them anyway.
 *
 * NOTHING OF AN UNAPPROVED ONE EITHER (Community V3 push 1.4; owner decisions
 * C1/C2): the directory lists STORES of approved merchants — an inner join to
 * the store, so a profile-only merchant from the pre-store era is not a card
 * until a reviewer approved them and they opened a store. A merchant-PAUSED
 * store stays listed and says it is closed (C10).
 */
const MERCHANT_SEARCH = ['cm.name', 'cm.bio', 's.name', 's.tagline'] as const;

/** The directory's rows, columns and visibility rule — shared with the public API, like the feed's. */
export const COMMUNITY_DIRECTORY_FROM = 'FROM community_merchants cm JOIN merchant_stores s ON s.merchant_id = cm.id';

/** `schema` as `communityProductsVisible`'s: false only on a database without 0204 — an empty directory (C11). */
export const communityDirectoryVisible = (q: string, schema = true) => `${merchantPublicSql('cm', schema)} AND ${storePublicSql('s')}
        AND (${q} = '' OR ${sqlLikeClause(MERCHANT_SEARCH, q)})`;

export const COMMUNITY_DIRECTORY_COLUMNS = `cm.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status,
              s.name AS store_name, s.tagline AS store_tagline, s.logo_key AS store_logo_key,
              s.governorate AS store_governorate, s.accepts_custom_requests AS store_custom,
              (SELECT COUNT(*) FROM follows f WHERE f.merchant_id = cm.id) AS followers,
              (SELECT COUNT(*) FROM community_products p
                WHERE p.merchant_id = cm.id AND p.lifecycle = 'active' AND p.status = 'active'
                  AND (s.id IS NULL OR p.store_id = s.id)) AS product_count`;

/**
 * One store as the directory draws it — and «متاجر أتابعها» too, so a shop
 * looks the same wherever the customer meets it: the store's own name, logo
 * and tagline (the community profile's only where there is no store), its
 * rating, finished orders, products and place.
 */
export function directoryCard(m: Record<string, unknown>, badges: { pro: Set<string>; premium: Set<string> }, root: string | null) {
  const hasStore = typeof m.store_id === 'string' && m.store_id !== '';
  const ratingCount = Number(m.rating_count ?? 0);
  return {
    ...merchantPublic(m, badges),
    store_slug: m.store_slug ?? null,
    // A store the public may not see — suspended, or its merchant suspended
    // or not approved — is not advertised as a destination; the card falls
    // back to the in-site page. Paused shops keep their address — the page
    // itself says they are closed (C10).
    store_url:
      m.store_slug && storeIsPublic({ status: m.store_status }) && merchantIsPublic(m)
        ? storeUrl(String(m.store_slug), root, String(m.store_id))
        : null,
    store_name: hasStore ? String(m.store_name ?? '') : null,
    tagline: hasStore ? String(m.store_tagline ?? '') : '',
    /** The store's logo, else the community avatar. */
    logoUrl: fileUrl(m.store_logo_key) ?? fileUrl(m.avatar_key),
    governorate: hasStore ? String(m.store_governorate ?? '') : '',
    accepts_custom_requests: hasStore && !!m.store_custom,
    badge: m.badge_override || m.badge || 'new',
    rating: ratingCount ? Number(m.rating_avg_x100) / 100 : null,
    rating_count: ratingCount,
    completed_orders: Number(m.completed_orders ?? 0),
    followers: Number(m.followers ?? 0),
    product_count: Number(m.product_count ?? 0),
  };
}

communityRoutes.get('/merchants', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 24 });
  const cursor = feedCursor(c.req.query('cursor'));
  const q = likePattern(c.req.query('q'));
  const root = rootDomainFrom(c.env);
  const viewer = c.get('user')?.id ?? '';
  const from = COMMUNITY_DIRECTORY_FROM;
  const [{ results }, total] = await withApprovalSchema((schema) => {
    const visible = `${communityDirectoryVisible('?1', schema)} AND ${merchantBlockSql('?5')}`;
    const visibleCount = `${communityDirectoryVisible('?1', schema)} AND ${merchantBlockSql('?2')}`;
    return Promise.all([
      c.env.DB.prepare(
        `SELECT ${COMMUNITY_DIRECTORY_COLUMNS},
                EXISTS (SELECT 1 FROM follows f WHERE f.merchant_id = cm.id AND f.user_id = ?5) AS viewer_follows
           ${from}
          WHERE ${visible}
            AND (?2 = '' OR cm.created_at < ?2 OR (cm.created_at = ?2 AND cm.id < ?3))
          ORDER BY cm.created_at DESC, cm.id DESC LIMIT ?4`
      ).bind(q, cursor.at, cursor.id, limit, viewer).all<Record<string, unknown>>(),
      cursor.at === ''
        ? c.env.DB.prepare(`SELECT COUNT(*) AS n ${from} WHERE ${visibleCount}`).bind(q, viewer).first<{ n: number }>()
        : Promise.resolve(null),
    ]);
  });
  const badges = await membershipBadges(c.env.DB, results.map((m) => m.user_id));
  return c.json({
    success: true,
    merchants: results.map((m) => ({ ...directoryCard(m, badges, root), following: !!m.viewer_follows })),
    next_cursor: nextFeedCursor(results, limit),
    total: total ? Number(total.n) : null,
  });
});

/**
 * The community page's list of requests — the SAME rows the board shows
 * (`GET /api/marketplace/requests`): published, still taking offers, public
 * and not expired. The coarse `status = 'open'` alone also listed a request
 * its customer had made PRIVATE, and one whose expiry had passed.
 *
 * And the same FIELDS: the board's own whitelist (`publicRequest`), so a card
 * can say what the job is — quantity, material, budget, governorate, how many
 * offers — instead of «بانتظار العروض» over a request that already had three.
 * `status` stays for a client that still reads it.
 *
 * NOBODY'S NAME (acceptance 34, GAP-MAP conflict 62): the list — and the
 * workshop's own `?for=me` board, which is another account's read too —
 * carries the job and never the person who posted it: no name, no username,
 * no id, no avatar, no contact. `users` is not even joined. The customer and
 * the workshop they deal with meet on their own authorised reads (the
 * request page's party view, the order, the conversation).
 */
// The board's visibility rule — shared with the request board and the public
// API — is worker/lib/requestBoard.ts; re-exported for the public API's import.
export { requestBoardVisible } from '../lib/requestBoard';

communityRoutes.get('/requests', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 48, def: 20 });
  const cursor = feedCursor(c.req.query('cursor'));
  const q = likePattern(c.req.query('q'));
  const visible = requestBoardVisible('?1', '?2');
  const now = new Date().toISOString();
  /**
   * `?for=me` — THE WORKSHOP'S OWN BOARD (0159, §9.5): the home's «طلبات
   * تناسبك». A signed-in merchant reads the requests the eligibility engine
   * marked eligible for THEIR workshop at the request's CURRENT revision
   * (`community_request_matches.eligible = 1 AND revision = r.revision`), on
   * the board's own visibility rule, never their own requests. Guests are
   * asked to sign in; an account without a workshop has an empty board. One
   * row more than asked is read, so the cursor is present exactly when a
   * next page exists (D8). The answer is per viewer — a session request
   * bypasses the anonymous edge cache — so `for` needs declaring only if
   * this route is ever wrapped in `anonymousCached`.
   */
  if (c.req.query('for') === 'me') {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'Sign in to see the requests that fit your workshop', 'UNAUTHORIZED');
    const mine = await storeForUser(c.env.DB, user.id);
    if (!mine) return c.json({ success: true, requests: [], next_cursor: null, total: 0, for: 'me' });
    /**
     * THE SAME BAR AS THE WORKSHOP'S OWN BOARD (worker/routes/merchantWorkshop.ts
     * `/board`, review 2026-09-30): a workshop that cannot take new work — its
     * store or account suspended, the plan lapsed — or that is not taking
     * custom requests is shown nothing, with the same `blocked` reason. An
     * admin suspension queues no re-match, so the stored verdicts alone would
     * go on saying «fits you» about jobs it can offer on none of.
     */
    const open = await merchantTakesNewWork(c.env.DB, {
      merchantStatus: mine.merchant.status,
      storeStatus: mine.store.status,
      merchantApproved: merchantApproved(mine.merchant),
      ownerUserId: user.id,
    });
    const accepts = Number(mine.store.accepts_custom_requests ?? 1) === 1;
    if (!open || !accepts) {
      return c.json({
        success: true, requests: [], next_cursor: null, total: 0, for: 'me',
        blocked: !open ? 'CANNOT_TAKE_WORK' : 'NOT_TAKING_REQUESTS',
      });
    }
    /**
     * Only an ENGINE-2 verdict for the request's CURRENT revision counts —
     * the offer fence's own rule (`eligibleVerdictSql`); a pre-W5-B engine-1
     * «eligible» is no promise the offer route would keep. The query is driven
     * from the open board (the state index) with the verdict as an EXISTS on
     * the (request, merchant) pair index, so the rows read are bounded by what
     * is on the board today, not by every job this workshop was ever matched
     * to; the count asks the same way.
     */
    const fits = eligibleVerdictSql('r', '?6');
    const [{ results: rows }, total] = await Promise.all([
      c.env.DB.prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count,
                (SELECT sm.score FROM community_request_matches sm WHERE sm.request_id = r.id AND sm.merchant_id = ?6) AS match_score
           FROM community_requests r
          WHERE ${visible}
            AND r.customer_id <> ?7
            AND ${fits}
            AND (?3 = '' OR r.created_at < ?3 OR (r.created_at = ?3 AND r.id < ?4))
          ORDER BY r.created_at DESC, r.id DESC LIMIT ?5`
      ).bind(now, q, cursor.at, cursor.id, limit + 1, mine.merchant.id, user.id).all<Record<string, unknown>>(),
      cursor.at === ''
        ? c.env.DB.prepare(
            `SELECT COUNT(*) AS n FROM community_requests r
              WHERE ${visible} AND r.customer_id <> ?4 AND ${eligibleVerdictSql('r', '?3')}`
          ).bind(now, q, mine.merchant.id, user.id).first<{ n: number }>()
        : Promise.resolve(null),
    ]);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      success: true,
      requests: page.map((r) => ({
        ...publicRequest(r),
        status: r.status,
        /** The engine's ranking of this job for THIS workshop — the reader's own number, nobody else's. */
        match_score: Number(r.match_score ?? 0) || 0,
      })),
      next_cursor: rows.length > limit && last ? `${String(last.created_at)}|${String(last.id)}` : null,
      total: total ? Number(total.n) : null,
      for: 'me',
    });
  }
  const [{ results }, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM community_request_files f WHERE f.request_id = r.id) AS file_count
         FROM community_requests r
        WHERE ${visible}
          AND (?3 = '' OR r.created_at < ?3 OR (r.created_at = ?3 AND r.id < ?4))
        ORDER BY r.created_at DESC, r.id DESC LIMIT ?5`
    ).bind(now, q, cursor.at, cursor.id, limit).all<Record<string, unknown>>(),
    cursor.at === ''
      ? c.env.DB.prepare(`SELECT COUNT(*) AS n FROM community_requests r WHERE ${visible}`).bind(now, q).first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  return c.json({
    success: true,
    requests: results.map((r) => ({ ...publicRequest(r), status: r.status })),
    next_cursor: nextFeedCursor(results, limit),
    total: total ? Number(total.n) : null,
  });
});

/**
 * FROM THE WORKSHOPS — finished work the stores show on their own pages
 * (`merchant_showcase`, kind 'work': «finished works it is proud of», 0036),
 * newest first across the community. It is the row a store's showcase already
 * serves in public (GET /api/storefront/:slug/showcase); nothing here is new
 * about any shop. At most three per store, so one prolific workshop cannot be
 * the whole rail; only works with a picture; nothing of a shop the public may
 * not see — sanctioned, or its merchant not approved (E11, push 1.4: a work
 * may still be CREATED before approval; it is shown only through the public
 * predicate).
 */
export async function communityWorks(db: D1Database, limit: number): Promise<Array<Record<string, unknown>>> {
  const { results } = await withApprovalSchema((schema) =>
    db.prepare(
      `SELECT * FROM (
         SELECT w.id, w.title, w.details, w.image_key, w.created_at,
                s.id AS store_id, s.slug AS store_slug, s.name AS store_name, s.logo_key AS store_logo_key,
                ROW_NUMBER() OVER (PARTITION BY w.store_id ORDER BY w.created_at DESC, w.id DESC) AS nth
           FROM merchant_showcase w
           JOIN merchant_stores s ON s.id = w.store_id
           JOIN community_merchants cm ON cm.id = s.merchant_id
          WHERE w.kind = 'work' AND w.active = 1 AND COALESCE(w.image_key, '') <> ''
            AND ${storePublicSql('s')} AND ${merchantPublicSql('cm', schema)}
       ) WHERE nth <= 3
       ORDER BY created_at DESC, id DESC LIMIT ?1`
    ).bind(limit).all<Record<string, unknown>>()
  );
  return results;
}

communityRoutes.get('/works', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 24, def: 12 });
  const root = rootDomainFrom(c.env);
  const results = await communityWorks(c.env.DB, limit);
  return c.json({
    success: true,
    works: results.map((w) => ({
      id: w.id,
      title: w.title,
      details: w.details,
      imageUrl: fileUrl(w.image_key),
      store: {
        id: w.store_id,
        slug: w.store_slug,
        name: w.store_name,
        logoUrl: fileUrl(w.store_logo_key),
        url: storeUrl(String(w.store_slug), root, String(w.store_id)),
      },
    })),
  });
});

/**
 * A REQUEST FROM THE COMMUNITY PAGE TAKES THE ONE ROAD ONTO THE BOARD
 * (audit 03 §10 E).
 *
 * This used to INSERT with the table's defaults — `open` (0031), public, no
 * expiry — so the request was live on the board at once: no draft, no
 * estimate, no matching, no merchant told, and an expiry sweep with nothing to
 * expire. It is now born a DRAFT exactly as `POST /api/marketplace/requests`
 * makes one, and made public by `publishRequest` (worker/routes/printRequests.ts),
 * the only transition to `open`: it starts the expiry clock, prices what it
 * can and runs the matching. The answer keeps the shape the page that sends
 * it reads (`{ success, id }`, src/pages/Community.tsx), plus what the publish
 * decided. A publish that fails leaves an invisible draft in the customer's
 * own «طلباتي» and answers with the publish's own stable code.
 */
communityRoutes.post('/requests', requireAuth, async (c) => {
  await rateLimit(c, 'community-request', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const title = str(body.title, 'title', { min: 3, max: 150 });
  const description = str(body.description, 'description', { max: 2000, required: false });
  const id = newId('req');
  const ts = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO community_requests (id, customer_id, title, description, status, state, visibility, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'closed', 'draft', 'public', ?, ?)`
  )
    .bind(id, user.id, title, description, ts, ts)
    .run();
  await audit(c.env.DB, user.id, 'community.request_created', id, { title, state: 'draft', via: 'community' });

  const out = await publishRequest(c.env, user.id, id, {});
  return c.json({ success: true, id, published: true, completeness: out.completeness, matching: out.matching });
});

/**
 * RETIRED onto the request state machine. This set `status = 'closed'` on any
 * of the customer's requests in any state — a paid `in_progress` one included —
 * without touching `state`, so the request stayed on the board and its pending
 * offers were never told. `POST /api/marketplace/requests/:id/cancel` is the
 * customer's one cancel (a draft or a request still taking offers; a paid one
 * is `REQUEST_HAS_ORDER`), and a 307 hands it the same request.
 */
communityRoutes.post('/requests/:id/close', requireAuth, (c) =>
  c.redirect(`/api/marketplace/requests/${encodeURIComponent(c.req.param('id') ?? '')}/cancel`, 307)
);

// Merchant storefront ---------------------------------------------------------

communityRoutes.get('/store/:id', async (c) => {
  const id = c.req.param('id');
  const merchant = await c.env.DB.prepare(
    `SELECT m.*, s.id AS store_id, s.status AS store_status
       FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id WHERE m.id = ?`
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!merchant) throw notFound('Store not found');
  // The in-site profile of a shop the public may not see answers what its
  // storefront does: «المتجر غير متاح حاليًا», and nothing of the shop
  // (worker/routes/storefront.ts) — sanctioned, not approved, or with no store
  // to show yet (push 1.4; one generic answer, C9). `m.*` carries the
  // approval stamp; a database without 0204 has none, so the page is closed.
  if (!merchant.store_id || !storeIsPublic({ status: merchant.store_status }) || !merchantIsPublic(merchant)) {
    throw publicStoreUnavailable();
  }
  const user = c.get('user');
  // ONE WAVE after the merchant (review 2026-09-30): the products, the
  // followers, the viewer's own follow, the badges and the workshop's facts
  // depend on nothing but the merchant row, so they are read side by side.
  // THE WORKSHOP'S FACTS (0159, §9.5): what it can make and how it works —
  // public facts only (technologies, materials, the largest bed, the usual
  // turnaround, where it delivers, whether it takes custom work, its intro).
  // Never a printer's economics, never a verdict on anybody's job.
  const [{ results: products }, followers, followRow, badges, workshop] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM community_products WHERE merchant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 100"
    )
      .bind(id)
      .all(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM follows WHERE merchant_id = ?').bind(id).first<{ n: number }>(),
    user
      ? c.env.DB.prepare('SELECT 1 AS x FROM follows WHERE user_id = ? AND merchant_id = ?').bind(user.id, id).first()
      : Promise.resolve(null),
    membershipBadges(c.env.DB, [merchant.user_id]),
    publicWorkshopFacts(c.env.DB, String(merchant.id)).catch((e) => {
      console.error('workshop facts not read', merchant.id, e instanceof Error ? e.message : String(e));
      return null;
    }),
  ]);
  const following = !!followRow;
  return c.json({
    success: true,
    merchant: merchantPublic(merchant, badges),
    products: products.map(communityProductPublic),
    followers: followers?.n ?? 0,
    following,
    workshop,
  });
});

communityRoutes.post('/store/:id/follow', requireAuth, async (c) => {
  await rateLimit(c, 'follow', 60, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id');
  // A shop the public may not see takes no new followers (push 1.4).
  const merchant = await publicMerchantById(c.env.DB, id ?? '');
  if (!merchant) throw notFound('Store not found');
  if (merchant.user_id === user.id) throw badRequest('You cannot follow your own store', 'CANNOT_FOLLOW_OWN_STORE');
  await c.env.DB.prepare(
    'INSERT INTO follows (user_id, merchant_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  )
    .bind(user.id, id)
    .run();
  return c.json({ success: true, following: true });
});

communityRoutes.delete('/store/:id/follow', requireAuth, async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND merchant_id = ?')
    .bind(user.id, c.req.param('id'))
    .run();
  return c.json({ success: true, following: false });
});

/** «متاجر أتابعها» has no pages; the follow route's rate limit is what keeps a list short. */
export const FOLLOWED_LIMIT = 500;

communityRoutes.get('/followed', requireAuth, async (c) => {
  const user = c.get('user')!;
  const root = rootDomainFrom(c.env);
  // The directory's own columns, so a followed shop is drawn with the same
  // card. Bounded: a follow is rate-limited, not capped, and this list has no
  // pages — FOLLOWED_LIMIT is far past any real customer's list.
  const { results } = await c.env.DB.prepare(
    `SELECT ${COMMUNITY_DIRECTORY_COLUMNS}
       FROM follows f
       JOIN community_merchants cm ON cm.id = f.merchant_id
       LEFT JOIN merchant_stores s ON s.merchant_id = cm.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ${FOLLOWED_LIMIT}`
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  const badges = await membershipBadges(c.env.DB, results.map((m) => m.user_id));
  return c.json({
    success: true,
    merchants: results.map((m) =>
      // A shop the customer follows that the public may no longer see —
      // SANCTIONED, or (push 1.4) its merchant not approved — stays in their
      // list, so they can unfollow it, as a neutral card (review S5): its id
      // and `unavailable`, and not one field the merchant wrote. An approved
      // merchant without a store keeps their profile card, as before.
      !merchantIsPublic(m) || (!!m.store_id && !storeIsPublic({ status: m.store_status }))
        ? {
            id: m.id,
            unavailable: true,
            name: null,
            bio: null,
            avatarUrl: null,
            verified: false,
            pro_badge: false,
            premium_badge: false,
            created_at: m.created_at,
            store_slug: null,
            store_url: null,
          }
        : { ...directoryCard(m, badges, root), unavailable: false, following: true }
    ),
  });
});

// Merchant self-service -------------------------------------------------------

/** The signed-in user's merchant profile (creates none; explicit setup). */
communityRoutes.get('/my-store', requireAuth, async (c) => {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT * FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<Record<string, unknown>>();
  if (!merchant) return c.json({ success: true, merchant: null, products: [] });
  const { results: products } = await c.env.DB.prepare(
    'SELECT * FROM community_products WHERE merchant_id = ? ORDER BY created_at DESC'
  )
    .bind(merchant.id)
    .all();
  const badges = await membershipBadges(c.env.DB, [user.id]);
  return c.json({ success: true, merchant: merchantPublic(merchant, badges), products: products.map(communityProductPublic) });
});

communityRoutes.post('/my-store', requireAuth, async (c) => {
  await rateLimit(c, 'store-save', 30, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const name = str(body.name, 'name', { min: 2, max: 100 });
  const bio = str(body.bio, 'bio', { max: 500, required: false });

  const existing = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare('UPDATE community_merchants SET name = ?, bio = ? WHERE id = ?')
      .bind(name, bio, existing.id)
      .run();
    return c.json({ success: true, id: existing.id });
  }
  /**
   * E2 — NO NEW MERCHANT FROM THIS DOOR (Community V3 push 1.1, DECISIONS row 256).
   *
   * This branch inserted a store-less community merchant for any PLUS member:
   * a public profile in «المتاجر» that no human had approved. A merchant row is
   * now created only by /api/merchant/onboard, WITH its store, for someone a
   * reviewer approved (worker/lib/merchantApproval.ts; approval itself writes
   * no public row — DECISIONS row 257), so a user without one is refused here
   * with the same code as /api/merchant/onboard. The update branch above is untouched:
   * an existing merchant keeps editing their profile. The community gate
   * still answers first, as it does at /onboard: a closed community is the
   * same 503 for everyone.
   */
  if (!communityMayEnter(await readCommunityGate(c.env.DB), user)) throw communityClosedRefusal();
  throw applicationRequiredRefusal();
});

/**
 * RETIRED — the store API is the one door for a merchant's products (audit 01
 * B10).
 *
 * These two wrote products with none of the store rules: no store (the row had
 * `store_id` NULL), no selling entitlement or suspension check, any image URL
 * at all (an off-platform tracking pixel on the community pages), and a hard
 * DELETE that took ordered products out from under their order lines. They
 * stay reachable while the community is closed, so they were the way around
 * every rule `/api/merchant/products` enforces.
 *
 * A 307 hands the SAME request — method and body — to the store route, so an
 * old client still works, under the rules: `requireSellingPrivileges`, owned
 * media only, archive-not-delete for anything ever ordered. The legacy editor
 * in /edit-profile now sends merchants to /merchant.
 */
communityRoutes.post('/my-store/products', requireAuth, (c) => c.redirect('/api/merchant/products', 307));

communityRoutes.delete('/my-store/products/:id', requireAuth, (c) =>
  c.redirect(`/api/merchant/products/${encodeURIComponent(c.req.param('id') ?? '')}`, 307)
);

// Community profile completeness (used by the /community route guard).
communityRoutes.get('/profile-status', requireAuth, async (c) => {
  const user = c.get('user')!;
  const merchant = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE user_id = ?')
    .bind(user.id)
    .first();
  // merchant_allowed: an existing merchant keeps editing their profile. A NEW
  // merchant is created only by an approved merchant application (DECISIONS
  // row 256), never from this profile, so a membership no longer allows it.
  return c.json({
    success: true,
    complete: !!(user.username && user.name),
    hasStore: !!merchant,
    merchant_allowed: !!merchant,
  });
});
