/**
 * BUNDLES AND MYSTERY OFFERS — the public read path.
 * docs/BUNDLES_MYSTERY.md §9 (eligibility), §10 (API), §13 (storefront),
 * §14 (payloads and caching).
 *
 * A bundle is a `products` row carrying `composition <> ''`. It has no stock
 * of its own (its availability is the scarcest component, computed live) and,
 * in the two derived price modes, no price of its own either. Everything this
 * file serves therefore comes out of ONE resolution pass
 * (`worker/lib/bundleRead.ts`) that the cart, the quote and the checkout will
 * run too — so the card, the detail page and the door cannot quote different
 * numbers.
 *
 * FOUR THINGS THIS FILE IS RESPONSIBLE FOR, AND EACH OF THEM IS A HAZARD IF
 * IT IS NOT HELD HERE.
 *
 * 1. THE RESPONSE KEYS OF MIGRATION 0034 SURVIVE: `{ entitled, signed_in,
 *    bundles[] }`. A client deployed before this feature keeps working, and
 *    `entitled` keeps its old meaning — "this viewer holds a paid membership"
 *    — so the page's lock panel and its subscribe path are unchanged. What
 *    changed is that the list is no longer EMPTY for a non-member: gating is
 *    now per offer (§9), and an ungated bundle is public, guests included.
 *
 * 2. A LOCKED CARD IS A 200 WITH AN ALLOW-LIST, NEVER A 403 AND NEVER A PRICE
 *    THE CALLER CANNOT PAY. `worker/lib/bundleRead.ts` BUILDS the locked
 *    payload from a fixed short list of keys rather than deleting fields from
 *    a full one, because deletion is how the next field added to the card
 *    leaks.
 *
 * 3. NO INVENTORY AND NO POOL DEFINITION REACHES THE BROWSER. The listing
 *    carries a coarse state and at most three main items; `blocking[]`, every
 *    per-row count, every weight and every pool row stay on the server.
 *
 * 4. THE COOKIE HAZARD IN THE EDGE CACHE (§14). The session cookie is scoped
 *    to `.levonis-iq.com`, so it rides EVERY request to this route. "Keyed
 *    without a cookie" alone would let a member and a stranger share one entry
 *    and serve whichever body landed there first to the other — an entitled
 *    member's tier prices and unlocked composition to anonymous visitors, or
 *    the locked anonymous body to members. So the presence of the cookie is
 *    read FIRST, and a request carrying one is never cacheable.
 *
 * The composition admin lives in its own router (`worker/routes/adminBundles.ts`).
 * The legacy `bundles` / `bundle_items` CRUD that used to sit at the bottom of
 * this file is GONE: §1.11 freezes those two tables as read-only history and
 * says nothing writes them after migration 0059, and its router was already
 * unmounted — `worker/index.ts` binds `/api/admin/bundles` to the composition
 * panel. Leaving it would have kept a second export named `adminBundlesRoutes`
 * in the tree and a live write path into the frozen tables.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, notFound, str, int } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { bumpMetric, bundleAnalytics, mysteryAnalytics } from '../lib/compositionAnalytics';
import { benefits } from '../lib/entitlements';
import { SESSION_COOKIE_NAME } from '../lib/session';
import { compositionSelect } from '../lib/bundleRead';
import {
  compositionCard,
  compositionDetail,
  pricingCtx,
  resolveCompositionPageWithMystery,
} from './products';

// ---------------------------------------------------------------- public

export const bundlesRoutes = new Hono<AppContext>();

/**
 * READ THE SESSION FIRST, THEN DECIDE WHETHER THIS BODY MAY BE SHARED (§14).
 *
 * The check is on the raw COOKIE, not on `c.get('user')`: an expired or
 * revoked session cookie still resolves to no user, but the response was still
 * computed for a request that carried one, and a cache keyed on the URL alone
 * would hand that body to the next caller. `Vary: Cookie` on the public
 * variant is what keeps a cache that does honour it from mixing the two.
 */
function cacheHeaders(c: Context<AppContext>): void {
  const cookie = c.req.header('Cookie') ?? '';
  const carriesSession = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=`).test(cookie);
  if (carriesSession) {
    c.header('Cache-Control', 'private, no-store');
    return;
  }
  c.header('Cache-Control', 'public, max-age=60');
  c.header('Vary', 'Cookie');
}

const LIST_LIMIT_MAX = 48;

/**
 * GET /api/bundles — the storefront grid, the featured rail and the search box.
 *
 * `search` and `category_id` mirror `GET /api/products` exactly, `family` reads
 * `template_family` and `featured=1` reads the `is_featured` column a
 * composition row already inherits, so the page gets search, a category facet
 * and a featured rail with no new machinery and no new index.
 *
 * ONE PAGE COSTS FOUR READS whatever its size (§14): this query, the
 * components with their allow-lists, the member products, and one relations
 * pass over those members.
 */
bundlesRoutes.get('/', async (c) => {
  const q = c.req.query();
  const kind = str(q.kind, 'kind', { max: 20, required: false });
  const search = str(q.search, 'search', { max: 100, required: false });
  const categoryId = str(q.category_id, 'category_id', { max: 60, required: false });
  const family = str(q.family, 'family', { max: 60, required: false });
  const featured = q.featured === '1' || q.featured === 'true';
  const limit = int(q.limit, 'limit', { min: 1, max: LIST_LIMIT_MAX, def: 24 });
  const offset = int(q.offset, 'offset', { min: 0, max: 10_000, def: 0 });

  const user = c.get('user');
  const params: unknown[] = [];
  let where = "p.status = 'active'";
  if (kind === 'bundle' || kind === 'mystery') {
    where += ' AND p.composition = ?';
    params.push(kind);
  } else {
    where += " AND p.composition <> ''";
  }
  if (search) {
    where += ' AND (p.name LIKE ? OR p.name_ar LIKE ? OR p.name_ku LIKE ? OR p.description LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (categoryId) {
    where += ' AND (p.subcategory_id = ? OR p.id IN (SELECT product_id FROM product_catalogs WHERE catalog_id = ?))';
    params.push(categoryId, categoryId);
  }
  if (family) {
    where += ' AND p.template_family = ?';
    params.push(family);
  }
  if (featured) where += ' AND p.is_featured = 1';

  const [results, ctx] = await Promise.all([
    compositionSelect(
      c.env.DB,
      (cols, from) => `SELECT ${cols} ${from}
        WHERE ${where}
        ORDER BY p.display_order ASC, p.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    pricingCtx(c),
  ]);

  cacheHeaders(c);
  // `entitled` keeps its 0034 meaning — the viewer holds a paid membership —
  // so the page's lock panel and its subscribe path read the same field they
  // always did. It no longer decides whether the LIST is populated.
  const entitled = !!ctx.tierStatus && benefits.exclusiveSections(ctx.tierStatus);
  if (results.length === 0) return c.json({ entitled, signed_in: !!user, bundles: [] });

  const { resolved } = await resolveCompositionPageWithMystery(c.env.DB, results, ctx);
  const bundles = results
    .map((r) => resolved.get(String(r.id)))
    .filter((b): b is NonNullable<typeof b> => !!b)
    // A composition row with no components advertises nothing anyone can buy;
    // the admin panel is where it is finished, not the storefront.
    .filter((b) => b.availability.state !== 'unconfigured')
    /**
     * AN OFFER THE OWNER SWITCHED OFF IS NOT A CARD (§2.1, and the comment
     * beside the state that produces it).
     *
     * `bundleAvailability` sets `state = 'ended'` for `offer_windows.active = 0`
     * and its own comment says "the listing filters it out entirely" — which
     * this filter did not do. The storefront rendered an "Offer ended" card,
     * WITH a price, for something the owner had explicitly turned off,
     * indefinitely. An offer whose WINDOW merely expired keeps its card and its
     * countdown: that is a fact about a real offer, and §13.3 lists `ended` as
     * one of the eight card states for exactly that case. So the test is
     * the offer WINDOW's own `active` flag — the one thing the owner toggled —
     * rather than a state that a derived price below its floor also produces
     * (§4.3 wants that one to stay on the grid showing its unavailable state).
     */
    .filter((b) => !b.window || b.window.active)
    .map((b) => compositionCard(b, ctx));

  return c.json({ entitled, signed_in: !!user, bundles });
});

/**
 * GET /api/bundles/:slug — one offer, resolved by the same pass.
 *
 * A locked viewer gets the §9 allow-list with a 200, not a 403: the page
 * renders an honest lock and the purchase doors refuse independently.
 */
bundlesRoutes.get('/:slug', async (c) => {
  const slug = c.req.param('slug');
  const ctx = await pricingCtx(c);
  const bundle = await compositionDetail(c.env.DB, slug, ctx);
  cacheHeaders(c);
  if (!bundle) throw notFound('bundle');
  return c.json({ success: true, bundle });
});

/**
 * POST /api/bundles/:productId/view — the ONE counter §12 keeps, because
 * nothing else records that a detail page was looked at.
 *
 * SESSION-REQUIRED, deliberately. An anonymous caller falls back to an IP
 * bucket that Iraqi carriers NAT heavily, which would both undercount real
 * customers and let anyone inflate the denominator of the only conversion
 * figure the owner reads. So `views` counts SIGNED-IN views, the conversion
 * figure is labelled as being over signed-in views, and neither is ever an
 * input to a price, a limit or an eligibility decision.
 *
 * The subject is VALIDATED to be a real `composition <> ''` row before the
 * upsert, so arbitrary product ids — or arbitrary strings — cannot be seeded
 * into `composition_daily_metrics`.
 */
bundlesRoutes.post('/:productId/view', async (c) => {
  const user = c.get('user');
  if (!user) throw notFound('bundle');
  await rateLimit(c, 'bundle_view', 60, 300);
  const productId = str(c.req.param('productId'), 'productId', { min: 1, max: 60 });
  const row = await c.env.DB
    .prepare("SELECT id FROM products WHERE id = ? AND status = 'active' AND composition <> ''")
    .bind(productId)
    .first<{ id: string }>();
  if (!row) throw notFound('bundle');
  await bumpMetric(c.env.DB, String(row.id), 'views');
  // Fire-and-forget by contract: the body says nothing the page needs, and a
  // counter must never be something a page waits on.
  return c.json({ success: true });
});

// ---------------------------------------------------------------- admin

/**
 * §12's two screens, under `/api/admin/analytics`, with THEIR OWN
 * `requireAdmin`. `requireMainHost` is a HOST check and never a role check, so
 * a router mounted without its own guard is an open admin API guarded only by
 * hostname (§10, §15.1 rule 10).
 */
export const adminCompositionAnalyticsRoutes = new Hono<AppContext>();
adminCompositionAnalyticsRoutes.use('*', requireAdmin);

const range = (c: Context<AppContext>) => ({
  from: str(c.req.query('from'), 'from', { max: 10, required: false }) || undefined,
  to: str(c.req.query('to'), 'to', { max: 10, required: false }) || undefined,
});

adminCompositionAnalyticsRoutes.get('/bundles', async (c) => {
  const { rows, totals } = await bundleAnalytics(c.env.DB, range(c));
  return c.json({
    success: true,
    rows,
    totals,
    // The label travels with the figure so no screen can present it as a
    // conversion over all traffic (§12).
    conversion_basis: 'signed_in_views',
  });
});

adminCompositionAnalyticsRoutes.get('/mystery', async (c) => {
  // Read entirely through `mystery_allocation_stats`, whose projection carries
  // no order id and no user id — the guarantee is structural, not a promise
  // that every future reader will omit the right columns.
  return c.json({ success: true, ...(await mysteryAnalytics(c.env.DB, range(c))) });
});
