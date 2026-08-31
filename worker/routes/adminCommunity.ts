/**
 * Platform administration of the community — /api/admin/community/*.
 *
 * Mounted under /api/admin, which worker/index.ts serves ONLY on the apex
 * host. A merchant storefront cannot reach these routes at all, whatever it
 * puts in a request — that host guard is what makes wildcard subdomains and a
 * shared session cookie safe together (§53).
 *
 * TWO PRINCIPLES RUN THROUGH EVERY HANDLER:
 *
 *   Suspending is not deleting (§46). An abusive merchant loses the ability
 *   to trade, and keeps every order, payout row, review and dispute they are
 *   party to. Their customers keep their history too — punishing a merchant
 *   must not erase what someone else bought.
 *
 *   A settlement decision is a RECORD, not an edit. Releasing or refunding a
 *   disputed escrow appends events and ledger rows; it never rewrites the
 *   amounts. An admin can be asked, months later, exactly what they decided
 *   and on what day, and the answer comes from the data (§45).
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, str, int, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { getSetting } from '../lib/settings';
import { releaseEscrow, refundEscrow, escrowForOrder, getEscrow, merchantBalance } from '../lib/escrowOps';
import { refreshMerchantRating } from './merchantReviews';

export const adminCommunityRoutes = new Hono<AppContext>();
adminCommunityRoutes.use('*', requireAdmin);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- overview

adminCommunityRoutes.get('/overview', async (c) => {
  const [merchants, stores, products, requests, offers, orders, escrows, complaints] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
         FROM community_merchants`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active
         FROM merchant_stores`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN lifecycle = 'active' THEN 1 ELSE 0 END) AS active
         FROM community_products`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN state IN ('open','receiving_offers') THEN 1 ELSE 0 END) AS open
         FROM community_requests`
    ).first<Record<string, number>>(),
    c.env.DB.prepare('SELECT COUNT(*) AS total FROM community_offers').first<{ total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(price_iqd), 0) AS gross,
              COALESCE(SUM(platform_fee_iqd), 0) AS fees,
              SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM community_orders`
    ).first<Record<string, number>>(),
    c.env.DB.prepare(
      `SELECT state, COUNT(*) AS n, COALESCE(SUM(gross_iqd), 0) AS total
         FROM community_escrows GROUP BY state`
    ).all<{ state: string; n: number; total: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('submitted','under_review') THEN 1 ELSE 0 END) AS open
         FROM community_complaints`
    ).first<Record<string, number>>(),
  ]);

  return c.json({
    success: true,
    merchants,
    stores,
    products,
    requests,
    offers,
    orders,
    escrows: escrows.results,
    complaints,
  });
});

// ---------------------------------------------------------------- settings

const FEE_KEYS = [
  'communityFeeRequestPercentX100',
  'communityFeeStorePercentX100',
  'communityFeeMinIqd',
  'communityAutoCompleteDays',
  'communityRequestExpiryDays',
] as const;

adminCommunityRoutes.get('/settings', async (c) => {
  const out: Record<string, string> = {};
  for (const k of FEE_KEYS) out[k] = String((await getSetting(c.env.DB, k)) ?? '');
  return c.json({ success: true, settings: out });
});

/**
 * Change the platform's commission and lifecycle timings.
 *
 * A change applies to FUTURE transactions only. Every order and escrow
 * already created carries its own snapshot, and nothing here touches them —
 * retroactively recalculating what a merchant was owed for a sale that
 * already happened would be indefensible (§30, §75).
 */
adminCommunityRoutes.patch('/settings', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const changed: Record<string, number> = {};

  for (const k of FEE_KEYS) {
    if (body[k] === undefined) continue;
    // A percentage over 100% would mean the platform takes more than the
    // customer paid. Bounded here, not just trusted from an admin form.
    const max = k.endsWith('PercentX100') ? 10_000 : 1_000_000;
    changed[k] = int(body[k], k, { min: 0, max });
  }
  if (!Object.keys(changed).length) throw badRequest('Nothing to update');

  await c.env.DB.batch(
    Object.entries(changed).map(([k, v]) =>
      c.env.DB.prepare(
        `INSERT INTO admin_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(k, String(v))
    )
  );

  await audit(c.env.DB, admin.id, 'admin.community_settings', 'community', changed);
  return c.json({ success: true, settings: changed, applies_to: 'future transactions only' });
});

// --------------------------------------------------------------- merchants

adminCommunityRoutes.get('/merchants', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const q = c.req.query('q') || '';
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, s.slug AS store_slug, s.status AS store_status, s.name AS store_name,
            u.email AS owner_email, u.name AS owner_name
       FROM community_merchants m
       LEFT JOIN merchant_stores s ON s.merchant_id = m.id
       JOIN users u ON u.id = m.user_id
      WHERE (? = '' OR m.name LIKE '%' || ? || '%' OR s.slug LIKE '%' || ? || '%')
      ORDER BY m.created_at DESC LIMIT ?`
  ).bind(q, q, q, limit).all();
  return c.json({ success: true, merchants: results });
});

/** Levonis verification — distinct from PLUS eligibility (§43). */
adminCommunityRoutes.post('/merchants/:id/verify', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const verified = body.verified !== false;

  const res = await c.env.DB.prepare('UPDATE community_merchants SET verified = ? WHERE id = ?')
    .bind(verified ? 1 : 0, id)
    .run();
  if (!res.meta.changes) throw notFound('Merchant not found');

  // Verification is an input to the badge, so recompute it now rather than
  // waiting for the next review to arrive.
  await refreshMerchantRating(c.env.DB, id);
  await audit(c.env.DB, admin.id, 'admin.merchant_verified', id, { verified });
  return c.json({ success: true, verified });
});

/**
 * Suspend or restore a merchant.
 *
 * NOTHING IS DELETED. Products come off the storefront and the store stops
 * taking orders; every order, payout row, review and dispute stays exactly
 * where it is, and both the merchant and their customers keep access to their
 * own history (§46, §47).
 */
adminCommunityRoutes.post('/merchants/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', ['active', 'restricted', 'suspended'] as const);
  const reason = str(body.reason, 'reason', { min: 0, max: 500, required: false });

  const m = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?').bind(id).first();
  if (!m) throw notFound('Merchant not found');

  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE community_merchants SET status = ?, status_reason = ?, status_changed_at = ? WHERE id = ?'
    ).bind(status, reason, ts, id),
    // The storefront follows the merchant, so a suspended merchant's shop is
    // shut too — and restoring them re-opens it rather than leaving the shop
    // silently closed with no way for them to notice.
    c.env.DB.prepare(
      `UPDATE merchant_stores SET status = ?, status_reason = ?, updated_at = ? WHERE merchant_id = ?`
    ).bind(status === 'suspended' ? 'suspended' : 'active', reason, ts, id),
  ]);

  await audit(c.env.DB, admin.id, 'admin.merchant_status', id, { status, reason });
  return c.json({ success: true, status });
});

/** Pin or clear a badge. A merchant can never set their own (§42). */
adminCommunityRoutes.post('/merchants/:id/badge', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const badge = str(body.badge, 'badge', { min: 0, max: 30, required: false });

  await c.env.DB.prepare('UPDATE community_merchants SET badge_override = ? WHERE id = ?')
    .bind(badge, id)
    .run();
  // Clearing the override returns the merchant to the earned badge.
  await refreshMerchantRating(c.env.DB, id);
  await audit(c.env.DB, admin.id, 'admin.merchant_badge', id, { badge: badge || '(earned)' });
  return c.json({ success: true });
});

// -------------------------------------------------------------- moderation

adminCommunityRoutes.post('/products/:id/hide', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const res = await c.env.DB.prepare(
    `UPDATE community_products SET lifecycle = 'hidden', status = 'hidden', updated_at = ? WHERE id = ?`
  ).bind(nowIso(), id).run();
  if (!res.meta.changes) throw notFound('Product not found');
  await audit(c.env.DB, admin.id, 'admin.product_hidden', id, {});
  return c.json({ success: true });
});

adminCommunityRoutes.post('/reviews/:id/hide', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const hidden = body.hidden !== false;

  const r = await c.env.DB.prepare('SELECT merchant_id FROM merchant_reviews WHERE id = ?')
    .bind(id).first<{ merchant_id: string }>();
  if (!r) throw notFound('Review not found');

  await c.env.DB.prepare('UPDATE merchant_reviews SET hidden = ? WHERE id = ?').bind(hidden ? 1 : 0, id).run();
  // The rating must move with the moderation decision, or a hidden review
  // keeps counting toward a score nobody can see the basis for.
  await refreshMerchantRating(c.env.DB, r.merchant_id);
  await audit(c.env.DB, admin.id, 'admin.review_hidden', id, { hidden });
  return c.json({ success: true, hidden });
});

adminCommunityRoutes.post('/requests/:id/remove', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const reason = str((await c.req.json().catch(() => ({}))).reason, 'reason', { min: 0, max: 300, required: false });
  const res = await c.env.DB.prepare(
    `UPDATE community_requests SET state = 'cancelled', status = 'closed', updated_at = ?
      WHERE id = ? AND state NOT IN ('completed','in_progress','delivered')`
  ).bind(nowIso(), id).run();
  if (!res.meta.changes) {
    throw conflict('That request is already settled or has work under way — resolve it as a dispute instead');
  }
  await audit(c.env.DB, admin.id, 'admin.request_removed', id, { reason });
  return c.json({ success: true });
});

// -------------------------------------------------------------- complaints

adminCommunityRoutes.get('/complaints', async (c) => {
  const status = c.req.query('status') || '';
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const { results } = await c.env.DB.prepare(
    `SELECT ct.*, r.name AS reporter_name, m.name AS merchant_name
       FROM community_complaints ct
       JOIN users r ON r.id = ct.reporter_id
       LEFT JOIN community_merchants m ON m.id = ct.merchant_id
      WHERE (? = '' OR ct.status = ?)
      ORDER BY CASE ct.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               ct.created_at DESC
      LIMIT ?`
  ).bind(status, status, limit).all();
  return c.json({ success: true, complaints: results });
});

adminCommunityRoutes.get('/complaints/:id', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const complaint = await c.env.DB.prepare(
    `SELECT ct.*, r.name AS reporter_name, r.email AS reporter_email, m.name AS merchant_name
       FROM community_complaints ct
       JOIN users r ON r.id = ct.reporter_id
       LEFT JOIN community_merchants m ON m.id = ct.merchant_id
      WHERE ct.id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!complaint) throw notFound('Complaint not found');

  const messages = await c.env.DB.prepare(
    `SELECT cm.*, u.name AS sender_name FROM community_complaint_messages cm
       JOIN users u ON u.id = cm.sender_id
      WHERE cm.complaint_id = ? ORDER BY cm.created_at`
  ).bind(id).all();

  // The whole financial picture for the transaction under dispute, so a
  // decision is made against the record rather than against a summary.
  const escrow = complaint.community_order_id
    ? await escrowForOrder(c.env.DB, String(complaint.community_order_id))
    : null;
  const events = escrow
    ? await c.env.DB.prepare(
        'SELECT * FROM community_escrow_events WHERE escrow_id = ? ORDER BY created_at'
      ).bind(escrow.id).all()
    : { results: [] };

  return c.json({
    success: true,
    complaint,
    messages: messages.results,
    escrow,
    escrow_events: events.results,
  });
});

adminCommunityRoutes.post('/complaints/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', [
    'submitted', 'under_review', 'waiting_customer', 'waiting_merchant', 'resolved', 'rejected', 'closed',
  ] as const);
  const resolution = str(body.resolution, 'resolution', { min: 0, max: 2000, required: false });

  const res = await c.env.DB.prepare(
    `UPDATE community_complaints
        SET status = ?, resolution = ?, assigned_admin_id = ?,
            resolved_at = CASE WHEN ? IN ('resolved','rejected','closed') THEN ? ELSE resolved_at END,
            updated_at = ?
      WHERE id = ?`
  ).bind(status, resolution, admin.id, status, nowIso(), nowIso(), id).run();
  if (!res.meta.changes) throw notFound('Complaint not found');

  await audit(c.env.DB, admin.id, 'admin.complaint_status', id, { status });
  return c.json({ success: true, status });
});

// ------------------------------------------------------------- settlement

/**
 * Decide a disputed escrow.
 *
 * The four outcomes the mandate names (§45): pay the merchant in full, refund
 * the customer in full, or split it either way. All four go through the same
 * append-only escrow operations, so the decision, its amount, its reason and
 * the admin who made it are all on the record.
 *
 * The idempotency key is derived from the escrow and the decision, so a
 * double-submitted resolution settles once.
 */
adminCommunityRoutes.post('/escrows/:id/resolve', async (c) => {
  const admin = c.get('user')!;
  const escrowId = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.decision, 'decision', ['release', 'refund', 'partial_refund'] as const);
  const reason = str(body.reason, 'reason', { min: 3, max: 1000 });

  const esc = await getEscrow(c.env.DB, escrowId);
  if (!esc) throw notFound('Escrow not found');

  const key = `admin:${decision}:${escrowId}`;
  let result;
  if (decision === 'release') {
    result = await releaseEscrow(c.env.DB, {
      escrowId, actorId: admin.id, actorRole: 'admin', reason, idempotencyKey: key,
    });
  } else {
    const amount = decision === 'partial_refund'
      ? int(body.amount_iqd, 'amount_iqd', { min: 1, max: esc.gross_iqd })
      : undefined;
    result = await refundEscrow(c.env.DB, {
      escrowId, actorId: admin.id, actorRole: 'admin', reason, amountIqd: amount, idempotencyKey: key,
    });
  }
  if (!result.ok) throw conflict(`Could not settle (${(result as { reason: string }).reason})`);

  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE community_orders
          SET state = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END, updated_at = ?
        WHERE id = ?`
    ).bind(
      decision === 'release' ? 'completed' : 'refunded',
      decision === 'release' ? 'completed' : 'refunded',
      ts, ts, esc.community_order_id
    ),
    c.env.DB.prepare(
      `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, community_order_id, note)
       VALUES (?,?,?,?,?,?)`
    ).bind(
      newId('rep'), esc.merchant_id,
      decision === 'release' ? 'dispute_won' : 'dispute_lost',
      decision === 'release' ? 0 : -20,
      esc.community_order_id, reason.slice(0, 200)
    ),
  ]);

  await audit(c.env.DB, admin.id, 'admin.escrow_resolved', escrowId, {
    decision,
    reason,
    amount: body.amount_iqd ?? esc.gross_iqd,
  });
  return c.json({ success: true, decision, replayed: (result as { replayed: boolean }).replayed });
});

/** A merchant's full financial timeline, for an admin answering a question. */
adminCommunityRoutes.get('/merchants/:id/finance', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const balance = await merchantBalance(c.env.DB, id);
  const { results: ledger } = await c.env.DB.prepare(
    `SELECT * FROM merchant_payout_ledger WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 200`
  ).bind(id).all();
  const { results: escrows } = await c.env.DB.prepare(
    `SELECT * FROM community_escrows WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(id).all();
  return c.json({ success: true, balance, ledger, escrows });
});

/**
 * Record a payout to a merchant, or an adjustment.
 *
 * Append-only: paying a merchant writes a NEGATIVE ledger row rather than
 * reducing a balance, so the balance stays a SUM and the payment itself is
 * visible in the history (§76).
 */
adminCommunityRoutes.post('/merchants/:id/payout', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_iqd, 'amount_iqd', { min: 1, max: 1_000_000_000 });
  const note = str(body.note, 'note', { min: 0, max: 300, required: false });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { min: 8, max: 80 });

  const balance = await merchantBalance(c.env.DB, id);
  if (amount > balance.available_iqd) {
    throw badRequest('That is more than the merchant has available', 'INSUFFICIENT_BALANCE', {
      available_iqd: balance.available_iqd,
    });
  }

  try {
    await c.env.DB.prepare(
      `INSERT INTO merchant_payout_ledger (id, merchant_id, kind, amount_iqd, state, note, admin_id, idempotency_key)
       VALUES (?,?,'payout',?,'paid',?,?,?)`
    ).bind(newId('pay'), id, -amount, note, admin.id, idempotencyKey).run();
  } catch {
    return c.json({ success: true, replayed: true, balance: await merchantBalance(c.env.DB, id) });
  }

  await audit(c.env.DB, admin.id, 'admin.merchant_payout', id, { amount, note });
  return c.json({ success: true, replayed: false, balance: await merchantBalance(c.env.DB, id) });
});
