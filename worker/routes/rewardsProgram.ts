/**
 * THE REWARDS HUB — everything the rewards page shows beyond the points and
 * missions of worker/routes/rewards.ts (owner, 2026-11-03; migration 0220;
 * docs/DECISIONS.md row 286). Mounted at /api/rewards/program.
 *
 *   GET  /                          the hub: my reward coupons, the printers I
 *                                   can rate and what rating earns, the points
 *                                   shop, the competitions, my pending points
 *   POST /shop/:kind                swap points for a reward coupon
 *   POST /competitions/:id/enter    enter a competition
 *
 * EVERY FIGURE IS THE SERVER'S. The shop route reads no body at all: which
 * coupon is the path, and what it costs, how long it lasts and what it takes
 * off are the programme's settings (worker/lib/rewards/config.ts). The only
 * body read here is a competition entry's own answer and photo.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): on a database before 0220 the hub answers
 * `installed: false` with empty lists, never an error page.
 */
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, HttpError, oneOf, notFound } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { getBalances } from '../lib/wallet';
import { isSchemaMissing } from '../lib/membershipBenefits';
import { safeParse } from '../lib/types';
import { getReviewPointsValue } from './reviews';
import { FILAMENT_SECTION_ID, REWARD_COUPON_KINDS, getRewardConfig } from '../lib/rewards/config';
import { RewardShopError, buyShopCoupon, listUserRewardCoupons } from '../lib/rewards/coupons';
import { enterCompetition, listCompetitionsForUser } from '../lib/rewards/competitions';

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

/** The filaments a filament coupon names, for the page to list. */
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
  const s = await db
    .prepare(
      `SELECT c.id, c.slug, c.name_ar, c.name_en, c.name_ckb, p.slug AS parent_slug
         FROM catalogs c LEFT JOIN catalogs p ON p.id = c.parent_id WHERE c.id = ?`
    )
    .bind(FILAMENT_SECTION_ID)
    .first<{ id: string; slug: string; name_ar: string; name_en: string; name_ckb: string; parent_slug: string | null }>();
  return {
    products: [],
    section: s
      ? {
          id: s.id,
          slug: s.slug,
          // The storefront's own address for a section: /categories/<parent>/<child>, or /categories/<top>.
          path: s.parent_slug ? `/categories/${encodeURIComponent(s.parent_slug)}/${encodeURIComponent(s.slug)}` : `/categories/${encodeURIComponent(s.slug)}`,
          name: { ar: s.name_ar, en: s.name_en || s.name_ar, ckb: s.name_ckb || s.name_en || s.name_ar },
        }
      : null,
  };
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

  const [balances, pending, coupons, printers, levels, reviewPoints, filament, competitions] = await Promise.all([
    getBalances(db, user.id),
    db
      .prepare(
        `SELECT COALESCE(SUM(points), 0) AS points,
                MIN(CASE WHEN kind = 'purchase' THEN available_at END) AS next_available_at
           FROM points_accruals WHERE user_id = ? AND state = 'pending'`
      )
      .bind(user.id)
      .first<{ points: number; next_available_at: string | null }>(),
    listUserRewardCoupons(db, user.id, nowIso).catch(missing([] as Awaited<ReturnType<typeof listUserRewardCoupons>>)),
    printersToRate(db, user.id).catch(tolerate([] as Awaited<ReturnType<typeof printersToRate>>)),
    giftLevels(db).catch(tolerate([] as Awaited<ReturnType<typeof giftLevels>>)),
    getReviewPointsValue(db).catch(() => null),
    filamentTargets(db, config.filament.product_ids),
    listCompetitionsForUser(db, user.id, nowIso).catch(missing([] as Awaited<ReturnType<typeof listCompetitionsForUser>>)),
  ]);

  return c.json({
    success: true,
    installed,
    server_time: nowIso,
    point_balance: balances.points,
    pending_points: { points: Math.max(0, Number(pending?.points) || 0), next_available_at: pending?.next_available_at ?? null },
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
    coupons,
    printers,
    rating: { gift_levels: levels, review_points: reviewPoints },
    shop: REWARD_COUPON_KINDS.filter((k) => config.shop[k].enabled && config.shop[k].points !== null).map((k) => ({
      kind: k,
      points: config.shop[k].points as number,
      affordable: balances.points >= (config.shop[k].points as number),
    })),
    competitions,
  });
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
