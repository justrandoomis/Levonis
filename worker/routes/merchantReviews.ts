/**
 * Customer-side merchant reviews and follows — /api/community-reviews/*.
 *
 * A review is a claim about a real transaction, so the right to write one is
 * derived from the transaction rather than granted by a form (§39). The
 * eligibility query IS the authorisation: it looks for a completed order or
 * community order belonging to this customer and this merchant, and if it
 * finds none there is nothing to review.
 *
 * The database backs this up independently — unique indexes allow exactly one
 * review per order and per community order — so even a route written later
 * that forgot to check could not produce a second review for one purchase.
 * That matters more than usual here: fake reviews are the failure mode that
 * makes a marketplace's ratings worthless.
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, conflict, notFound, str, int } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { announceAfterResponse } from '../lib/adminTopicRouting';
import { badgeFor } from '../lib/merchantOps';
import { requireCommunityOpen } from '../lib/communityGate';

export const communityReviewRoutes = new Hono<AppContext>();

const nowIso = () => new Date().toISOString();

/**
 * Recomputes a merchant's rating and badge from their reviews.
 *
 * Recomputed from the rows rather than incremented, so a hidden review, a
 * deleted one or a moderation decision cannot leave the average permanently
 * wrong. An aggregate that drifts is worse than none: it makes a store look
 * better or worse than the reviews it actually has (§40).
 */
export async function refreshMerchantRating(db: D1Database, merchantId: string): Promise<void> {
  const agg = await db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(AVG(rating), 0) AS avg
         FROM merchant_reviews WHERE merchant_id = ? AND hidden = 0`
    )
    .bind(merchantId)
    .first<{ n: number; avg: number }>();

  const count = Number(agg?.n ?? 0);
  const avgX100 = count ? Math.round(Number(agg?.avg ?? 0) * 100) : 0;

  const m = await db
    .prepare('SELECT completed_orders, verified, badge_override FROM community_merchants WHERE id = ?')
    .bind(merchantId)
    .first<{ completed_orders: number; verified: number; badge_override: string }>();

  const badge = m?.badge_override
    ? m.badge_override
    : badgeFor({
        completed_orders: Number(m?.completed_orders ?? 0),
        rating_avg_x100: avgX100,
        rating_count: count,
        verified: Number(m?.verified ?? 0),
      });

  await db
    .prepare(
      'UPDATE community_merchants SET rating_avg_x100 = ?, rating_count = ?, badge = ? WHERE id = ?'
    )
    .bind(avgX100, count, badge, merchantId)
    .run();
}

/**
 * What this customer may review right now.
 *
 * Returned as a list so the UI can offer "review your order from Ali 3D"
 * rather than showing a review form that will be refused on submit.
 */
communityReviewRoutes.get('/eligible', requireAuth, async (c) => {
  const user = c.get('user')!;

  const { results: storeOrders } = await c.env.DB.prepare(
    `SELECT o.id AS order_id, NULL AS community_order_id, o.merchant_id, o.store_id,
            m.name AS merchant_name, o.created_at
       FROM orders o JOIN community_merchants m ON m.id = o.merchant_id
      WHERE o.user_id = ? AND o.merchant_id IS NOT NULL AND o.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM merchant_reviews r WHERE r.order_id = o.id)
      ORDER BY o.created_at DESC LIMIT 20`
  ).bind(user.id).all();

  const { results: communityOrders } = await c.env.DB.prepare(
    `SELECT NULL AS order_id, o.id AS community_order_id, o.merchant_id, o.store_id,
            m.name AS merchant_name, o.completed_at AS created_at
       FROM community_orders o JOIN community_merchants m ON m.id = o.merchant_id
      WHERE o.customer_id = ? AND o.state = 'completed'
        AND NOT EXISTS (SELECT 1 FROM merchant_reviews r WHERE r.community_order_id = o.id)
      ORDER BY o.completed_at DESC LIMIT 20`
  ).bind(user.id).all();

  return c.json({ success: true, eligible: [...storeOrders, ...communityOrders] });
});

/**
 * Write a review.
 *
 * The transaction is verified against the database FIRST, and everything the
 * review is attached to — merchant, store — is taken from that row rather
 * than from the request. A client cannot review merchant A on the strength of
 * an order with merchant B by naming the wrong id.
 */
communityReviewRoutes.post('/', requireAuth, async (c) => {
  await rateLimit(c, 'review-create', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const rating = int(body.rating, 'rating', { min: 1, max: 5 });
  const text = str(body.body, 'body', { min: 0, max: 3000, required: false });
  const orderId = str(body.order_id, 'order_id', { min: 0, max: 60, required: false });
  const communityOrderId = str(body.community_order_id, 'community_order_id', { min: 0, max: 60, required: false });

  if (!orderId && !communityOrderId) throw badRequest('Name the order you are reviewing');
  if (orderId && communityOrderId) throw badRequest('A review belongs to one transaction');

  let merchantId: string;
  let storeId: string | null;

  if (orderId) {
    const o = await c.env.DB.prepare(
      `SELECT merchant_id, store_id FROM orders
        WHERE id = ? AND user_id = ? AND status = 'delivered' AND merchant_id IS NOT NULL`
    ).bind(orderId, user.id).first<{ merchant_id: string; store_id: string | null }>();
    // One message for "no such order", "not yours" and "not delivered yet".
    // Distinguishing them would let someone probe for other people's orders.
    if (!o) throw badRequest('You can only review an order you have received', 'NOT_ELIGIBLE');
    merchantId = o.merchant_id;
    storeId = o.store_id;
  } else {
    const o = await c.env.DB.prepare(
      `SELECT merchant_id, store_id FROM community_orders
        WHERE id = ? AND customer_id = ? AND state = 'completed'`
    ).bind(communityOrderId, user.id).first<{ merchant_id: string; store_id: string | null }>();
    if (!o) throw badRequest('You can only review work that has been completed', 'NOT_ELIGIBLE');
    merchantId = o.merchant_id;
    storeId = o.store_id;
  }

  const id = newId('rev');
  const ts = nowIso();
  try {
    await c.env.DB.prepare(
      `INSERT INTO merchant_reviews
         (id, merchant_id, store_id, customer_id, order_id, community_order_id, rating, body, images, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, merchantId, storeId, user.id,
      orderId || null, communityOrderId || null,
      rating, text,
      JSON.stringify(Array.isArray(body.images) ? body.images.filter((x: unknown) => typeof x === 'string').slice(0, 6) : []),
      ts, ts
    ).run();
  } catch {
    // The unique index. Someone already reviewed this exact transaction —
    // which, since the transaction is theirs, means they did.
    throw conflict('You have already reviewed this order');
  }

  await c.env.DB.prepare(
    `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, review_id, order_id, community_order_id)
     VALUES (?,?,'review_received',?,?,?,?)`
  ).bind(newId('rep'), merchantId, (rating - 3) * 5, id, orderId || null, communityOrderId || null).run();

  await refreshMerchantRating(c.env.DB, merchantId);
  await audit(c.env.DB, user.id, 'community.review_created', id, { merchant: merchantId, rating });

  /**
   * THE SAME «📢 Review» TOPIC, because a review is a review.
   *
   * A store review is not a catalogue review, but it is read by the same
   * person for the same reason, and splitting them across two topics would ask
   * the owner to watch two places for one job. What makes this one worth a
   * message at all is the side effect two statements up: it has ALREADY moved
   * the merchant's reputation (`merchant_reputation_events`, ±points by star)
   * and already changed the rating shown on their storefront. A one-star that
   * silently drops a merchant's public score is the exact event the shop needs
   * to see the same day, not at the end of the month.
   *
   * The merchant id, not the merchant's name, and no customer identity: the
   * id is what opens the record, and every name in a group message is a name
   * that gets screenshotted.
   */
  announceAfterResponse(
    c,
    'review',
    `📢 ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5) store review` +
      `\nMerchant: ${merchantId}` +
      `\nReview: ${id}` +
      `\nTransaction: ${orderId || communityOrderId}`
  );

  return c.json({ success: true, review_id: id }, 201);
});

/**
 * Edit a review, within a short window.
 *
 * A customer who changes their mind an hour later should be able to say so.
 * A customer who rewrites a review a year later, perhaps after a merchant
 * offered something for it, is a different thing — so the window is short and
 * the edit count is recorded on the row.
 */
const EDIT_WINDOW_MS = 24 * 3600 * 1000;

communityReviewRoutes.patch('/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const rating = int(body.rating, 'rating', { min: 1, max: 5 });
  const text = str(body.body, 'body', { min: 0, max: 3000, required: false });

  const existing = await c.env.DB.prepare(
    'SELECT merchant_id, created_at FROM merchant_reviews WHERE id = ? AND customer_id = ?'
  ).bind(id, user.id).first<{ merchant_id: string; created_at: string }>();
  if (!existing) throw notFound('Review not found');
  if (Date.now() - new Date(existing.created_at).getTime() > EDIT_WINDOW_MS) {
    throw conflict('Reviews can only be edited within 24 hours');
  }

  await c.env.DB.prepare(
    `UPDATE merchant_reviews SET rating = ?, body = ?, edited_count = edited_count + 1, updated_at = ?
      WHERE id = ? AND customer_id = ?`
  ).bind(rating, text, nowIso(), id, user.id).run();

  await refreshMerchantRating(c.env.DB, existing.merchant_id);
  return c.json({ success: true });
});

// ---------------------------------------------------------------- follows

// Behind Levo Community's maintenance switch (worker/lib/communityGate.ts):
// these are the twins of the walled /api/community/store/:id/follow, and a
// follow while the community is shut went around the wall. Reviews of a
// DELIVERED order above stay open — they finish trade already done.

communityReviewRoutes.post('/follow/:merchantId', requireCommunityOpen, requireAuth, async (c) => {
  await rateLimit(c, 'follow', 60, 3600);
  const user = c.get('user')!;
  const merchantId = str(c.req.param('merchantId'), 'merchantId', { min: 1, max: 60 });

  const m = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?').bind(merchantId).first();
  if (!m) throw notFound('Store not found');

  await c.env.DB.prepare(
    'INSERT INTO follows (user_id, merchant_id) VALUES (?, ?) ON CONFLICT DO NOTHING'
  ).bind(user.id, merchantId).run();
  return c.json({ success: true, following: true });
});

communityReviewRoutes.delete('/follow/:merchantId', requireCommunityOpen, requireAuth, async (c) => {
  const user = c.get('user')!;
  await c.env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND merchant_id = ?')
    .bind(user.id, str(c.req.param('merchantId'), 'merchantId', { min: 1, max: 60 }))
    .run();
  return c.json({ success: true, following: false });
});

/** Notification preferences per followed store (§38). */
communityReviewRoutes.patch('/follow/:merchantId', requireCommunityOpen, requireAuth, async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ['notify_products', 'notify_offers', 'notify_updates']) {
    if (body[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(body[k] ? 1 : 0);
  }
  if (!sets.length) throw badRequest('Nothing to update');
  vals.push(user.id, str(c.req.param('merchantId'), 'merchantId', { min: 1, max: 60 }));
  await c.env.DB.prepare(`UPDATE follows SET ${sets.join(', ')} WHERE user_id = ? AND merchant_id = ?`)
    .bind(...vals)
    .run();
  return c.json({ success: true });
});

communityReviewRoutes.get('/following', requireCommunityOpen, requireAuth, async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.name, m.verified, m.badge, m.badge_override, m.rating_avg_x100, m.rating_count,
            s.slug AS store_slug, s.logo_key, s.tagline,
            f.notify_products, f.notify_offers, f.notify_updates, f.created_at
       FROM follows f
       JOIN community_merchants m ON m.id = f.merchant_id
       LEFT JOIN merchant_stores s ON s.merchant_id = m.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC`
  ).bind(user.id).all<Record<string, unknown>>();

  return c.json({
    success: true,
    following: results.map((r) => ({
      merchant_id: r.id,
      name: r.name,
      verified: !!r.verified,
      badge: r.badge_override || r.badge,
      rating: r.rating_count ? Number(r.rating_avg_x100) / 100 : null,
      rating_count: r.rating_count,
      store_slug: r.store_slug,
      logoUrl: r.logo_key ? `/files/${r.logo_key}` : null,
      tagline: r.tagline,
      notify: {
        products: !!r.notify_products,
        offers: !!r.notify_offers,
        updates: !!r.notify_updates,
      },
      since: r.created_at,
    })),
  });
});
