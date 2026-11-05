/**
 * THE REWARDS HUB — everything the rewards page shows beyond the points and
 * missions of worker/routes/rewards.ts (owner, 2026-11-03; migration 0220;
 * docs/DECISIONS.md row 286). Mounted at /api/rewards/program.
 *
 *   GET  /                          the hub: my reward coupons (each live
 *                                   filament one with what it covers) and how
 *                                   many I hold, the printers I can rate and
 *                                   what rating earns, the points shop, the
 *                                   competitions and how many are open to me,
 *                                   my pending points
 *   GET  /competitions              the competitions page (DECISIONS row 290):
 *                                   ?view=current, or ?view=results[&mine=1]&cursor=…
 *   GET  /competitions/:id          one competition's own page
 *   POST /shop/:kind                swap points for a reward coupon
 *   POST /competitions/:id/enter    enter a competition
 *
 * EVERY FIGURE IS THE SERVER'S. The shop route reads no body at all: which
 * coupon is the path, and what it costs, how long it lasts and what it takes
 * off are the programme's settings (worker/lib/rewards/config.ts). The only
 * body read here is a competition entry's own answer and photo. The page
 * decides nothing either: whether a competition can be entered and why not
 * (`gate`), what a swap is short of, whether a shop coupon is held and what a
 * review outside the gift levels earns all come from here.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): on a database before 0220 the hub answers
 * `installed: false` with empty lists and zero counts, the competitions page
 * answers empty lists, and one competition is not found (404, as an unknown id
 * is) — the statuses a migrated database gives, never an error page.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, HttpError, oneOf, notFound } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { getBalances } from '../lib/wallet';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { safeParse } from '../lib/types';
import { getReviewPointsValue, noLevelReviewPoints } from './reviews';
import { FILAMENT_SECTION_ID, REWARD_COUPON_KINDS, getRewardConfig, type RewardCouponKind } from '../lib/rewards/config';
import {
  RewardShopError,
  buyShopCoupon,
  catalogSection,
  couponCounts,
  couponTargets,
  listUserRewardCoupons,
  shopHoldings,
} from '../lib/rewards/coupons';
import {
  competitionCounts,
  competitionForCustomer,
  competitionWindowCounts,
  enterCompetition,
  listCompetitionsForUser,
  listCompetitionsPage,
  withGates,
} from '../lib/rewards/competitions';
import { readPendingPoints } from '../lib/rewards/pending';

export const rewardProgramRoutes = new Hono<AppContext>();
rewardProgramRoutes.use('*', requireAuth);

/** A read of a table 0220 creates answers empty on a database without it. */
const tolerate = <T>(fallback: T) => (e: unknown): T => {
  if (isSchemaMissing(e)) return fallback;
  throw e;
};

interface PrinterLine {
  order_id: string;
  product_id: string;
  delivered_at: string | null;
  slug: string | null;
  name: string | null;
  name_ar: string | null;
  name_ku: string | null;
  images: string | null;
  image_snapshot: string | null;
  name_snapshot: string | null;
}

/** The printers this customer received, one per product, newest first. */
async function printersToRate(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT oi.order_id, oi.product_id, MAX(o.delivered_at) AS delivered_at,
              p.slug, p.name, p.name_ar, p.name_ku, p.images, oi.image_snapshot, oi.name_snapshot
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
        WHERE o.user_id = ?1 AND o.status = 'delivered'
          AND oi.gift_entitlement_id IS NULL
          AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
          AND EXISTS (SELECT 1 FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                       WHERE pc.product_id = oi.product_id)
        GROUP BY oi.product_id
        ORDER BY delivered_at DESC
        LIMIT 20`
    )
    .bind(userId)
    .all<PrinterLine>();
  const lines = results ?? [];
  if (!lines.length) return [];
  const { results: reviews } = await db
    .prepare(
      `SELECT r.id, r.product_id, r.stars, r.source, rr.state AS reward_state, rr.quality_score AS reward_level
         FROM reviews r LEFT JOIN review_rewards rr ON rr.review_id = r.id
        WHERE r.user_id = ?1 AND r.product_id IN (SELECT value FROM json_each(?2))`
    )
    .bind(userId, JSON.stringify(lines.map((l) => l.product_id)))
    .all<{ id: string; product_id: string; stars: number; source: string | null; reward_state: string | null; reward_level: number | null }>();
  const byProduct = new Map((reviews ?? []).map((r) => [r.product_id, r]));
  return lines.map((l) => {
    const review = byProduct.get(l.product_id);
    const own = review && (review.source ?? 'user') !== 'system' ? review : null;
    const images = safeParse<unknown>(l.images ?? '[]', []);
    const firstImage = Array.isArray(images) && typeof images[0] === 'string' ? (images[0] as string) : '';
    return {
      order_id: l.order_id,
      product_id: l.product_id,
      slug: l.slug ?? '',
      name: { ar: l.name_ar || l.name || l.name_snapshot || '', en: l.name || l.name_snapshot || '', ckb: l.name_ku || l.name || l.name_snapshot || '' },
      image: firstImage || l.image_snapshot || '',
      delivered_at: l.delivered_at,
      /**
       * to_rate          no review of theirs yet (a system rating is replaceable);
       * reward_pending   their review waits for the shop's gift decision;
       * reward_approved  a gift was granted — it waits under /gifts;
       * rated            reviewed, outside the gift levels or not approved.
       */
      state: !own
        ? 'to_rate'
        : own.reward_state === 'submitted' || own.reward_state === 'revision_needed'
          ? 'reward_pending'
          : own.reward_state === 'approved'
            ? 'reward_approved'
            : 'rated',
      stars: own ? Number(own.stars) || null : null,
      reward_level: own && own.reward_state === 'approved' ? Number(own.reward_level) || null : null,
    };
  });
}

async function giftLevels(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT level, name_ar, name_en, name_ckb, description_ar, description_en, description_ckb, active
         FROM gift_pools WHERE id LIKE 'gift_level_%' ORDER BY level`
    )
    .all<{ level: number; name_ar: string; name_en: string; name_ckb: string; description_ar: string; description_en: string; description_ckb: string; active: number }>();
  return (results ?? []).map((g) => ({
    level: Number(g.level),
    name: { ar: g.name_ar, en: g.name_en, ckb: g.name_ckb },
    description: { ar: g.description_ar ?? '', en: g.description_en ?? '', ckb: g.description_ckb ?? '' },
    active: Number(g.active) === 1,
  }));
}

/**
 * The filaments the programme's CURRENT settings name. Kept for one release
 * for the pages still open on the old stacked /points; each coupon now carries
 * its own frozen `targets` (couponTargets).
 */
async function filamentTargets(db: D1Database, productIds: string[]) {
  if (productIds.length) {
    const { results } = await db
      .prepare('SELECT id, slug, name, name_ar, name_ku, status FROM products WHERE id IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(productIds))
      .all<{ id: string; slug: string; name: string; name_ar: string; name_ku: string; status: string }>();
    const rows = new Map((results ?? []).map((p) => [p.id, p]));
    return {
      products: productIds
        .map((id) => rows.get(id))
        .filter((p): p is NonNullable<typeof p> => !!p && p.status === 'active')
        .map((p) => ({ id: p.id, slug: p.slug, name: { ar: p.name_ar || p.name, en: p.name, ckb: p.name_ku || p.name } })),
      section: null,
    };
  }
  return { products: [], section: await catalogSection(db, FILAMENT_SECTION_ID) };
}

rewardProgramRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const nowIso = new Date().toISOString();
  const config = await getRewardConfig(db);

  let installed = true;
  const missing = <T>(fallback: T) => (e: unknown): T => {
    if (isSchemaMissing(e)) {
      installed = false;
      return fallback;
    }
    throw e;
  };

  const [balances, pending, coupons, printers, levels, reviewPoints, filament, competitions, couponTotals, windowCounts, holdings] =
    await Promise.all([
      getBalances(db, user.id),
      readPendingPoints(db, user.id),
      listUserRewardCoupons(db, user.id, nowIso).catch(missing([] as Awaited<ReturnType<typeof listUserRewardCoupons>>)),
      printersToRate(db, user.id).catch(tolerate([] as Awaited<ReturnType<typeof printersToRate>>)),
      giftLevels(db).catch(tolerate([] as Awaited<ReturnType<typeof giftLevels>>)),
      getReviewPointsValue(db).catch(() => null),
      filamentTargets(db, config.filament.product_ids),
      listCompetitionsForUser(db, user.id, nowIso).catch(missing([] as Awaited<ReturnType<typeof listCompetitionsForUser>>)),
      couponCounts(db, user.id, nowIso).catch(missing({ active: 0, past: 0 })),
      competitionWindowCounts(db, user.id, nowIso).catch(missing({ open: 0, upcoming: 0, closed: 0, open_to_enter: 0 })),
      shopHoldings(db, user.id, nowIso).catch(tolerate(new Set<RewardCouponKind>())),
    ]);
  // What each live filament coupon can be spent on, from its own frozen terms (none before 0220: no coupons).
  const targets = await couponTargets(db, coupons);

  return c.json({
    success: true,
    installed,
    server_time: nowIso,
    point_balance: balances.points,
    pending_points: pending,
    program: {
      enabled: config.enabled,
      valid_days: config.valid_days,
      free_shipping: { enabled: config.free_shipping.enabled },
      filament: {
        enabled: config.filament.enabled,
        percent: config.filament.percent,
        max_discount_iqd: config.filament.max_discount_iqd,
        ...filament,
      },
    },
    coupons: coupons.map((x) => ({ ...x, targets: targets.get(x.id) ?? null })),
    // Counted over every grant, so the page can say how many the 40-row list leaves out.
    coupon_counts: couponTotals,
    printers,
    rating: { gift_levels: levels, review_points: reviewPoints, no_level_points: noLevelReviewPoints(reviewPoints) },
    shop: REWARD_COUPON_KINDS.filter((k) => config.shop[k].enabled && config.shop[k].points !== null).map((k) => {
      const price = config.shop[k].points as number;
      return {
        kind: k,
        points: price,
        affordable: balances.points >= price,
        // The swap's own one-each guard, read the same way (HOLDING_WHERE).
        holding: holdings.has(k),
        points_short: Math.max(0, price - balances.points),
      };
    }),
    competitions: withGates(competitions, balances.points),
    competition_counts: windowCounts,
  });
});

/**
 * THE COMPETITIONS PAGE. `current` (open, upcoming, awaiting the verdict) and
 * `results` (finished, newest first, a page at a time) are separate lists, so
 * neither grows into the other; `results&mine=1` is only the ones this customer
 * entered (finished or cancelled). `counts` stays the two global tabs either
 * way. Before 0220 every list is empty with installed:false.
 */
rewardProgramRoutes.get('/competitions', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;
  const nowIso = new Date().toISOString();
  const view = c.req.query('view') === 'results' ? 'results' : 'current';
  const mine = view === 'results' && c.req.query('mine') === '1';
  let installed = true;
  const missing = <T>(fallback: T) => (e: unknown): T => {
    if (isSchemaMissing(e)) {
      installed = false;
      return fallback;
    }
    throw e;
  };
  const [balances, page, counts] = await Promise.all([
    getBalances(db, user.id),
    listCompetitionsPage(db, user.id, view, c.req.query('cursor') ?? null, nowIso, { mine }).catch(
      missing({ competitions: [], next_cursor: null } as Awaited<ReturnType<typeof listCompetitionsPage>>)
    ),
    competitionCounts(db).catch(missing({ current: 0, results: 0 })),
  ]);
  return c.json({
    success: true,
    installed,
    server_time: nowIso,
    point_balance: balances.points,
    view,
    mine,
    counts,
    competitions: withGates(page.competitions, balances.points),
    next_cursor: page.next_cursor,
  });
});

/** One competition — the address a «you won» or «your points came back» notice opens. */
rewardProgramRoutes.get('/competitions/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound('Competition not found');
  const nowIso = new Date().toISOString();
  const [balances, competition] = await Promise.all([
    getBalances(c.env.DB, user.id),
    // Before 0220 there is no competition to find: the same 404 as an unknown id.
    competitionForCustomer(c.env.DB, user.id, id, nowIso).catch((e: unknown) => {
      if (isSchemaMissing(e)) return null;
      throw e;
    }),
  ]);
  if (!competition) throw notFound('Competition not found');
  return c.json({ success: true, server_time: nowIso, point_balance: balances.points, competition: withGates([competition], balances.points)[0] });
});

rewardProgramRoutes.post('/shop/:kind', async (c) => {
  await rateLimit(c, 'reward_shop', 20, 3600);
  const user = c.get('user')!;
  const kind = oneOf(c.req.param('kind'), 'kind', REWARD_COUPON_KINDS);
  try {
    const coupon = await buyShopCoupon(c.env, user.id, kind);
    return c.json({ success: true, coupon });
  } catch (e) {
    if (e instanceof RewardShopError) throw new HttpError(409, e.message, e.code);
    if (isSchemaMissing(e)) throw new HttpError(503, 'Rewards are being set up', 'REWARDS_NOT_INSTALLED');
    throw e;
  }
});

rewardProgramRoutes.post('/competitions/:id/enter', async (c) => {
  await rateLimit(c, 'competition_entry', 20, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound('Competition not found');
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  try {
    const entry = await enterCompetition(c.env, user.id, id, body);
    return c.json({ success: true, entry });
  } catch (e) {
    if (isSchemaMissing(e)) throw new HttpError(503, 'Rewards are being set up', 'REWARDS_NOT_INSTALLED');
    throw e;
  }
});
