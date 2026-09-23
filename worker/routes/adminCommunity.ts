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

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAdmin, badRequest, conflict, notFound, str, int, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { getSetting } from '../lib/settings';
import { releaseEscrow, refundEscrow, escrowForOrder, getEscrow, merchantBalance } from '../lib/escrowOps';
import { badgeFor } from '../lib/merchantOps';
import {
  COMMUNITY_GATE_SETTING_KEY,
  readCommunityGate,
} from '../lib/communityGate';
import { canMoveOffer, type OfferState } from '../lib/communityStates';
import { chunk } from '../lib/inventory';
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

// ------------------------------------------------------------ the gate

/**
 * «ليفو كوميونيتي تحت الصيانة، واسمح بالأعضاء من قائمة في الادارة» — the one
 * switch that decides whether customers may enter the community, and the list
 * of people who may enter anyway.
 *
 * Read and written HERE and nowhere else, so every flip carries an audit row
 * naming who did it and which way it went. It is deliberately NOT one of the
 * FEE_KEYS above and not reachable through the generic settings PATCH: those
 * are numbers with bounds, this is a door, and a door that can be opened by a
 * handler that does not audit is a door nobody can account for afterwards.
 *
 * The allow-list is USER IDS (see worker/lib/communityGate.ts for why it can
 * never be usernames or emails), and every id is checked against `users`
 * before it is stored — a typo saved silently is an owner believing they let
 * somebody in who is still locked out.
 */
/**
 * D1 refuses more than 100 bound parameters in one statement, and this
 * codebase chunks id lists at 90 so a caller can add a bound value of its own
 * without discovering the ceiling in production (worker/lib/customerNotify.ts
 * states the rule; worker/lib/stockAlerts.ts and four other call sites obey
 * it). The allow-list is capped at 200 entries below, which is TWICE the
 * ceiling — so both the read and the write of it are chunked, not trusted to
 * stay small.
 *
 * The unit tests cannot see this: they run node:sqlite, whose variable limit
 * is 999. Only D1 refuses, and only in production.
 */
const GATE_ID_CHUNK = 90;

adminCommunityRoutes.get('/gate', async (c) => {
  const gate = await readCommunityGate(c.env.DB);
  // The names beside the ids, so the panel can show people rather than
  // opaque strings. An id whose user has since been deleted still comes back
  // — it is in the stored list and the owner should be able to see and remove
  // it — with nulls where the row used to be.
  const members: Array<Record<string, unknown>> = [];
  if (gate.allowed.length) {
    const byId = new Map<string, Record<string, unknown>>();
    // CHUNKED, because the list this reads back is the list the PUT below
    // allows: up to 200 ids, and D1 refuses more than 100 bound parameters in
    // one statement (worker/lib/customerNotify.ts states the rule; five call
    // sites already chunk for it). Unchunked, the one thing that would break
    // is RENDERING a large allow-list — the panel would 500 on exactly the
    // list the owner needs to see in order to shorten it.
    for (const part of chunk(gate.allowed, GATE_ID_CHUNK)) {
      const marks = part.map(() => '?').join(',');
      const { results } = await c.env.DB.prepare(
        `SELECT id, username, name, email FROM users WHERE id IN (${marks})`
      ).bind(...part).all<Record<string, unknown>>();
      for (const u of results) byId.set(String(u.id), u);
    }
    for (const id of gate.allowed) members.push(byId.get(id) ?? { id, username: null, name: null, email: null });
  }
  return c.json({
    success: true,
    open: gate.open,
    closed: !gate.open,
    allowed_user_ids: gate.allowed,
    members,
    key: COMMUNITY_GATE_SETTING_KEY,
  });
});

/**
 * One upsert, one audit row. `open` and `allowed_user_ids` are written
 * together because they are one decision — "shut, except these people" — and
 * writing them apart would leave a window where the community is closed with
 * yesterday's list, or open with tomorrow's.
 */
adminCommunityRoutes.put('/gate', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.open !== 'boolean') throw badRequest('open must be true or false', 'COMMUNITY_OPEN_REQUIRED');
  const open = body.open;

  const raw = body.allowed_user_ids;
  if (raw !== undefined && !Array.isArray(raw)) throw badRequest('allowed_user_ids must be an array of user ids');
  const asked = Array.isArray(raw) ? raw : [];
  // A list is a list of people, not a payload: 200 is far past any plausible
  // testing cohort and keeps the existence check to one bounded statement.
  if (asked.length > 200) throw badRequest('allowed_user_ids may not exceed 200 entries');
  const ids: string[] = [];
  for (const [i, v] of asked.entries()) {
    const id = str(v, `allowed_user_ids[${i}]`, { min: 1, max: 80 });
    if (!ids.includes(id)) ids.push(id);
  }

  if (ids.length) {
    const known = new Set<string>();
    // The same chunking, for the same ceiling: 200 ids is TWO HUNDRED bound
    // parameters in one `IN (…)`, and D1 stops at 100. Unchunked, an owner
    // allow-listing 101 beta members gets a 500, the gate is never written,
    // and the members stay locked out of a community the owner believes he
    // just let them into.
    for (const part of chunk(ids, GATE_ID_CHUNK)) {
      const marks = part.map(() => '?').join(',');
      const { results } = await c.env.DB.prepare(`SELECT id FROM users WHERE id IN (${marks})`)
        .bind(...part)
        .all<{ id: string }>();
      for (const r of results) known.add(String(r.id));
    }
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      throw badRequest(
        `لا يوجد مستخدم بهذا المعرف / No such user: ${missing.slice(0, 5).join(', ')}`,
        'COMMUNITY_ALLOW_UNKNOWN_USER'
      );
    }
  }

  const before = await readCommunityGate(c.env.DB);
  const nowIso = new Date().toISOString();
  // The same upsert `setSetting` uses; the key is not a typed SETTING_DEFAULTS
  // entry because the generic settings PUT must not be able to open the
  // community without an audit row naming who opened it.
  await c.env.DB.prepare(
    'INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
    .bind(
      COMMUNITY_GATE_SETTING_KEY,
      JSON.stringify({ open, allowed_user_ids: ids, updated_at: nowIso, by: admin.id })
    )
    .run();
  await audit(c.env.DB, admin.id, 'community.gate_update', COMMUNITY_GATE_SETTING_KEY, {
    before_open: before.open,
    after_open: open,
    before_allowed: before.allowed.length,
    after_allowed: ids.length,
  });
  return c.json({ success: true, open, closed: !open, allowed_user_ids: ids, changed: before.open !== open });
});

// --------------------------------------------------------------- merchants

adminCommunityRoutes.get('/merchants', async (c) => {
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });
  const q = c.req.query('q') || '';
  const { results } = await c.env.DB.prepare(
    `SELECT m.*, s.id AS store_id, s.slug AS store_slug, s.status AS store_status,
            s.name AS store_name, s.status_reason AS store_status_reason,
            u.email AS owner_email, u.name AS owner_name
       FROM community_merchants m
       LEFT JOIN merchant_stores s ON s.merchant_id = m.id
       JOIN users u ON u.id = m.user_id
      WHERE (?1 = '' OR ${sqlLikeClause(['m.name', 's.slug'], '?2')})
      ORDER BY m.created_at DESC LIMIT ?3`
  ).bind(q, likePattern(q), limit).all();
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

/**
 * Suspend or restore a STORE, without touching the merchant.
 *
 * The two are different sanctions and the mandate names them separately.
 * A storefront can be the problem on its own — a banner, a description, a
 * product listing — while the merchant is still fulfilling accepted work and
 * bidding honestly on the request board. Shutting the whole merchant for a
 * bad banner would cancel the work they owe other customers.
 *
 * `paused` is the merchant's own switch and is NOT reachable from here: an
 * admin decision must be distinguishable from a shopkeeper closing for the
 * afternoon, or "only an admin can lift an admin suspension" (§50) becomes
 * unenforceable the moment the merchant re-opens.
 */
adminCommunityRoutes.post('/stores/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const status = oneOf(body.status, 'status', ['active', 'suspended'] as const);
  const reason = str(body.reason, 'reason', { min: 0, max: 500, required: false });

  const store = await c.env.DB.prepare(
    'SELECT s.id, s.merchant_id, m.status AS merchant_status FROM merchant_stores s ' +
    'JOIN community_merchants m ON m.id = s.merchant_id WHERE s.id = ?'
  ).bind(id).first<{ id: string; merchant_id: string; merchant_status: string }>();
  if (!store) throw notFound('Store not found');

  // Re-opening a shop whose OWNER is suspended would contradict the merchant
  // sanction that is still in force, and the storefront would then have to
  // decide which of two admin decisions wins. Lift the merchant suspension
  // first, deliberately.
  if (status === 'active' && store.merchant_status === 'suspended') {
    throw conflict('That merchant is suspended — restore the merchant first');
  }

  await c.env.DB.prepare(
    'UPDATE merchant_stores SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?'
  ).bind(status, reason, nowIso(), id).run();

  await audit(c.env.DB, admin.id, 'admin.store_status', id, {
    status, reason, merchant: store.merchant_id,
  });
  return c.json({ success: true, status });
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

// ------------------------------------------------------ requests & offers

/**
 * The request board as an admin sees it.
 *
 * The PUBLIC board deliberately withholds who is asking (§24) — a merchant
 * learns how to reach a customer when their offer is accepted, and not
 * before. That rule protects a customer from merchants; it was never a rule
 * against Levonis itself, which has to answer "who posted this and what
 * became of it" when a dispute lands on the desk. So the customer is named
 * here, in a route the host guard keeps on the apex, and nowhere else.
 */
adminCommunityRoutes.get('/requests', async (c) => {
  const state = c.req.query('state') || '';
  const q = c.req.query('q') || '';
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });

  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.title, r.state, r.status, r.category, r.quantity, r.budget_iqd,
            r.governorate, r.visibility, r.deadline, r.expires_at,
            r.accepted_offer_id, r.community_order_id, r.created_at,
            r.customer_id, u.name AS customer_name, u.email AS customer_email,
            (SELECT COUNT(*) FROM community_offers o WHERE o.request_id = r.id) AS offers_total,
            (SELECT COUNT(*) FROM community_offers o
              WHERE o.request_id = r.id AND o.state = 'pending') AS offers_pending
       FROM community_requests r
       JOIN users u ON u.id = r.customer_id
      WHERE (?1 = '' OR r.state = ?2)
        AND (?3 = '' OR r.title LIKE ?4 ESCAPE '\\' OR r.id = ?3)
      ORDER BY r.created_at DESC
      LIMIT ?5`
  ).bind(state, state, q, likePattern(q), limit).all();

  return c.json({ success: true, requests: results });
});

/**
 * One request with every offer on it.
 *
 * A merchant cannot read a rival's price (§25). An admin moderating the board
 * must be able to, or "this offer is abusive" is a claim they have no way to
 * check. Same table, different question, different caller.
 *
 * Attachments are listed WITHOUT their R2 keys (§22, §67). An admin sees that
 * three files exist and what they are; the key stays server-side so no
 * response anywhere in the platform teaches a reader how to address the
 * bucket directly.
 */
adminCommunityRoutes.get('/requests/:id', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const request = await c.env.DB.prepare(
    `SELECT r.*, u.name AS customer_name, u.email AS customer_email
       FROM community_requests r
       JOIN users u ON u.id = r.customer_id
      WHERE r.id = ?`
  ).bind(id).first<Record<string, unknown>>();
  if (!request) throw notFound('Request not found');

  const [offers, files, order] = await Promise.all([
    c.env.DB.prepare(
      `SELECT o.*, m.name AS merchant_name, m.status AS merchant_status,
              m.badge, m.verified, s.slug AS store_slug
         FROM community_offers o
         JOIN community_merchants m ON m.id = o.merchant_id
         LEFT JOIN merchant_stores s ON s.id = o.store_id
        WHERE o.request_id = ?
        ORDER BY o.created_at`
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT id, file_name, content_type, size_bytes, kind, created_at
         FROM community_request_files WHERE request_id = ? ORDER BY created_at`
    ).bind(id).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT o.*, m.name AS merchant_name
         FROM community_orders o
         JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.request_id = ? ORDER BY o.created_at DESC LIMIT 1`
    ).bind(id).first<Record<string, unknown>>(),
  ]);

  // The money for this request, if it got that far — so the admin reading a
  // reported request sees immediately whether anything is at stake.
  const escrow = order ? await escrowForOrder(c.env.DB, String(order.id)) : null;

  return c.json({
    success: true,
    request,
    offers: offers.results,
    // A route, not a key. The marketplace download handler already grants
    // an admin access and re-checks it on every read, so moderation reuses
    // that one authorisation instead of adding a second way in.
    files: files.results.map((f) => ({
      ...f,
      url: `/api/marketplace/requests/${id}/files/${f.id}`,
    })),
    order: order ?? null,
    escrow,
  });
});

/**
 * Reject one abusive offer without touching the request.
 *
 * Only while it is PENDING. An accepted offer is the contract behind a
 * community order and an escrow (§26) — pulling it out from underneath them
 * would leave money held against a promise that no longer exists. Once work
 * is under way the answer is a dispute resolution, which moves the money
 * deliberately and leaves a record; `canMoveOffer` is what says so here
 * rather than a hand-written condition that could drift from the table.
 */
adminCommunityRoutes.post('/offers/:id/reject', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const reason = str((await c.req.json().catch(() => ({}))).reason, 'reason', { min: 3, max: 300 });

  const offer = await c.env.DB.prepare(
    'SELECT id, request_id, merchant_id, state FROM community_offers WHERE id = ?'
  ).bind(id).first<{ id: string; request_id: string; merchant_id: string; state: OfferState }>();
  if (!offer) throw notFound('Offer not found');

  if (!canMoveOffer(offer.state, 'rejected')) {
    throw conflict(
      offer.state === 'accepted'
        ? 'That offer has been accepted — settle it as a dispute instead of removing it'
        : `An offer that is ${offer.state} cannot be rejected`
    );
  }

  const res = await c.env.DB.prepare(
    `UPDATE community_offers SET state = 'rejected', updated_at = ? WHERE id = ? AND state = 'pending'`
  ).bind(nowIso(), id).run();
  if (!res.meta.changes) throw conflict('That offer changed while you were deciding — reload it');

  // offer_count is what the board shows; leaving it stale advertises offers
  // that are no longer there.
  await c.env.DB.prepare(
    `UPDATE community_requests
        SET offer_count = (SELECT COUNT(*) FROM community_offers
                            WHERE request_id = ? AND state IN ('pending','accepted')),
            updated_at = ?
      WHERE id = ?`
  ).bind(offer.request_id, nowIso(), offer.request_id).run();

  await audit(c.env.DB, admin.id, 'admin.offer_rejected', id, { reason, merchant: offer.merchant_id });
  return c.json({ success: true, state: 'rejected' });
});

// --------------------------------------------------- reviews & reputation

/**
 * Every review, for moderation.
 *
 * Hidden ones are included by default and marked, not filtered away: an admin
 * reviewing a moderation decision needs to see what was hidden as readily as
 * what is live, and a merchant appealing "you hid my review" cannot be
 * answered from a list that no longer contains it.
 */
adminCommunityRoutes.get('/reviews', async (c) => {
  const merchantId = c.req.query('merchant') || '';
  const hidden = c.req.query('hidden') || '';        // '' | '0' | '1'
  const maxRating = int(c.req.query('maxRating'), 'maxRating', { min: 1, max: 5, def: 5 });
  const limit = int(c.req.query('limit'), 'limit', { min: 1, max: 100, def: 50 });

  const { results } = await c.env.DB.prepare(
    `SELECT rv.id, rv.merchant_id, rv.rating, rv.body, rv.hidden, rv.merchant_reply,
            rv.merchant_replied_at, rv.edited_count, rv.order_id, rv.community_order_id,
            rv.created_at, rv.updated_at,
            m.name AS merchant_name, m.rating_avg_x100, m.rating_count,
            u.name AS customer_name, u.email AS customer_email
       FROM merchant_reviews rv
       JOIN community_merchants m ON m.id = rv.merchant_id
       JOIN users u ON u.id = rv.customer_id
      WHERE (? = '' OR rv.merchant_id = ?)
        AND (? = '' OR rv.hidden = CAST(? AS INTEGER))
        AND rv.rating <= ?
      ORDER BY rv.created_at DESC
      LIMIT ?`
  ).bind(merchantId, merchantId, hidden, hidden, maxRating, limit).all();

  return c.json({ success: true, reviews: results });
});

/**
 * Why this merchant has the standing they have.
 *
 * The score and the badge are DERIVED (§41, §42), so this returns the inputs
 * rather than a number to be trusted: the raw events, the rating breakdown by
 * star, and — importantly — the badge the criteria actually earn alongside
 * any admin override. An admin about to pin a badge can see what they are
 * overriding, and an admin clearing an override can see what the merchant
 * will fall back to.
 */
adminCommunityRoutes.get('/merchants/:id/reputation', async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });

  const merchant = await c.env.DB.prepare(
    `SELECT id, name, verified, status, status_reason, badge, badge_override,
            rating_avg_x100, rating_count, completed_orders, reputation_score, created_at
       FROM community_merchants WHERE id = ?`
  ).bind(id).first<Record<string, number | string>>();
  if (!merchant) throw notFound('Merchant not found');

  const [events, breakdown, points] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, kind, points, note, order_id, community_order_id, review_id, created_at
         FROM merchant_reputation_events WHERE merchant_id = ?
        ORDER BY created_at DESC LIMIT 200`
    ).bind(id).all(),
    c.env.DB.prepare(
      `SELECT rating, COUNT(*) AS n FROM merchant_reviews
        WHERE merchant_id = ? AND hidden = 0 GROUP BY rating ORDER BY rating DESC`
    ).bind(id).all<{ rating: number; n: number }>(),
    c.env.DB.prepare(
      'SELECT COALESCE(SUM(points), 0) AS total FROM merchant_reputation_events WHERE merchant_id = ?'
    ).bind(id).first<{ total: number }>(),
  ]);

  const earned = badgeFor({
    completed_orders: Number(merchant.completed_orders ?? 0),
    rating_avg_x100: Number(merchant.rating_avg_x100 ?? 0),
    rating_count: Number(merchant.rating_count ?? 0),
    verified: Number(merchant.verified ?? 0),
  });

  return c.json({
    success: true,
    merchant,
    earned_badge: earned,
    badge_override: String(merchant.badge_override || ''),
    reputation_points: Number(points?.total ?? 0),
    breakdown: breakdown.results,
    events: events.results,
  });
});

/**
 * Correct the record by adding to it.
 *
 * A mistaken reputation event is answered by another event, never by editing
 * or deleting the first (§41). That is why this route only inserts: a
 * merchant can always be shown the full sequence of what happened to their
 * standing, including the correction and who made it.
 */
adminCommunityRoutes.post('/merchants/:id/reputation', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const points = int(body.points, 'points', { min: -500, max: 500 });
  const note = str(body.note, 'note', { min: 3, max: 300 });

  const m = await c.env.DB.prepare('SELECT id FROM community_merchants WHERE id = ?').bind(id).first();
  if (!m) throw notFound('Merchant not found');

  await c.env.DB.prepare(
    `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, note)
     VALUES (?,?,'admin_adjustment',?,?)`
  ).bind(newId('rep'), id, points, note).run();

  await audit(c.env.DB, admin.id, 'admin.merchant_reputation', id, { points, note });
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

/**
 * ANSWER THE PERSON. «الشكاوى» — the owner's own word for what was missing.
 *
 * WHAT WAS BROKEN. `GET /complaints/:id` has selected the thread from
 * `community_complaint_messages` since migration 0031, and the admin panel
 * could set a STATUS on a complaint — but there was no INSERT anywhere in the
 * repository, in any route, for that table. An admin could read a customer's
 * complaint, move it to «waiting_customer», and the customer would be waiting
 * on a reply the product had no way to send. A status is not an answer.
 *
 * `internal` IS THE HALF THAT MAKES THIS SAFE. The column has been on the
 * table since 0031 with the comment "admin-only note, never shown to parties",
 * and a dispute desk that cannot write a note to itself writes the note in the
 * reply instead — to the person it is about. Both kinds go in the same ordered
 * thread so the sequence of the case is one list, and the flag is what decides
 * who may read a row. It is explicit on every write: a note that becomes a
 * reply by omission is the failure mode worth designing against, so an absent
 * or unparseable `internal` means a PUBLIC reply, which is the thing the admin
 * meant to type, and a note has to say so.
 *
 * IT DOES NOT MOVE THE STATUS. Replying and deciding are two acts by two
 * different rules — `/status` writes `resolved_at` and the resolution text —
 * and fusing them would make every typed sentence a state transition. The
 * panel calls both when it means both.
 *
 * THE COMPLAINT MUST EXIST, checked before the insert rather than left to the
 * foreign key: a 404 naming the complaint is an answer an admin can act on,
 * and a raw FK violation is a 500.
 */
adminCommunityRoutes.post('/complaints/:id/messages', async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = str(body.body, 'body', { min: 1, max: 4000 });
  const internal = body.internal === true;

  const complaint = await c.env.DB.prepare('SELECT id, status FROM community_complaints WHERE id = ?')
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!complaint) throw notFound('Complaint not found');

  const messageId = newId('cmsg');
  await c.env.DB.prepare(
    `INSERT INTO community_complaint_messages (id, complaint_id, sender_id, sender_role, body, internal)
     VALUES (?,?,?,'admin',?,?)`
  )
    .bind(messageId, id, admin.id, text, internal ? 1 : 0)
    .run();

  // The complaint itself moved in the sense that matters to a queue sorted by
  // activity: somebody worked it. `status` is deliberately untouched.
  await c.env.DB.prepare('UPDATE community_complaints SET updated_at = ? WHERE id = ?')
    .bind(nowIso(), id)
    .run();

  await audit(c.env.DB, admin.id, 'admin.complaint_message', id, { internal, length: text.length });

  const message = await c.env.DB.prepare(
    `SELECT cm.*, u.name AS sender_name FROM community_complaint_messages cm
       JOIN users u ON u.id = cm.sender_id
      WHERE cm.id = ?`
  )
    .bind(messageId)
    .first<Record<string, unknown>>();

  return c.json({ success: true, message });
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
