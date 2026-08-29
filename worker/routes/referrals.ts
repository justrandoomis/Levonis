import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, requireAdmin, badRequest, notFound, conflict, str, int, oneOf } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import {
  resolveSupportRef,
  normalizeSupportRef,
  inviteRefPath,
  productSupportPath,
  SUPPORT_REF_MAX,
} from '../lib/supportCode';
import {
  SUPPORT_GIFT_STATES,
  supportGiftTransitionAllowed,
  evaluateSupportGiftForOrder,
  reconcileSupportGifts,
  type SupportGiftState,
} from '../lib/membershipOps';

/**
 * Referrals & support codes (integrated mandate §3).
 *
 * TWO DIFFERENT THINGS LIVE HERE AND ARE NEVER MERGED (§3.2):
 *   1. SIGNUP INVITE — "who invited this account" (referral_attributions,
 *      bound exactly once at account creation, /auth?ref=<username>).
 *   2. PURCHASE SUPPORT CODE — "who this buyer is supporting on THIS order"
 *      (orders.support_snapshot, frozen at confirmation, zero price effect).
 * Opening a new product share link never re-points an existing account's
 * inviter, and a support code never turns into a discount.
 *
 * Nothing in this file touches pricing, and no endpoint here can change a
 * referrer after purchase — the snapshot is written once by checkout.
 */
export const referralRoutes = new Hono<AppContext>();

referralRoutes.use('*', requireAuth);
// Admin visibility (§3.4 "referral and gift admin shows the source, order,
// state, reason, date and actor"). Mounted before the member routes so an
// /admin/* path can never fall through to a member handler.
referralRoutes.use('/admin/*', requireAdmin);

// ------------------------------------------------------------------ member

/** Buyer identity is never exposed to a referrer — only a support handle. */
function maskOrderRef(orderId: string): string {
  const s = String(orderId || '');
  return s.length <= 4 ? s : `…${s.slice(-4)}`;
}

interface GiftRow {
  id: string;
  order_id: string;
  state: SupportGiftState;
  needs_review: number;
  review_reason: string;
  created_at: string;
  qualified_at: string | null;
  decided_at: string | null;
  spool_product_id: string | null;
  outcome_reason: string;
}

/**
 * GET /api/referrals/me — everything the /referrals page renders.
 *
 * Deliberate omissions: no buyer id, name, email, address or order total.
 * A referrer sees THEIR claim (its state, when it was created, when it
 * qualified) and a masked order reference for support conversations —
 * nothing that identifies the person who bought (§3.1).
 */
referralRoutes.get('/me', async (c) => {
  const user = c.get('user')!;
  const db = c.env.DB;

  const [legacy, giftRows, rewardRows, invites] = await Promise.all([
    db.prepare('SELECT code FROM referral_codes WHERE user_id = ?').bind(user.id).first<{ code: string }>(),
    db
      .prepare(
        `SELECT id, order_id, state, needs_review, review_reason, created_at, qualified_at,
                decided_at, spool_product_id, outcome_reason
           FROM support_gift_entitlements
          WHERE referrer_id = ?
          ORDER BY created_at DESC
          LIMIT 100`
      )
      .bind(user.id)
      .all<GiftRow>(),
    db
      .prepare(
        `SELECT id, campaign, state, eligible_at, created_at
           FROM referral_rewards
          WHERE referrer_id = ?
          ORDER BY created_at DESC
          LIMIT 100`
      )
      .bind(user.id)
      .all<{ id: string; campaign: string; state: string; eligible_at: string | null; created_at: string }>(),
    db
      .prepare('SELECT COUNT(DISTINCT referred_id) AS n FROM referral_attributions WHERE referrer_id = ?')
      .bind(user.id)
      .first<{ n: number }>(),
  ]);

  const handle = user.username || '';
  const gifts = giftRows.results.map((g) => ({
    id: g.id,
    order_ref: maskOrderRef(g.order_id),
    state: g.state,
    needs_review: !!g.needs_review,
    // The reason is shown so a held claim is never a silent denial; it
    // carries no buyer data (it names a program or a case id).
    review_reason: g.review_reason || '',
    outcome_reason: g.outcome_reason || '',
    created_at: g.created_at,
    qualified_at: g.qualified_at,
    decided_at: g.decided_at,
    fulfilled: g.state === 'paid',
  }));

  const counts = { pending_eligibility: 0, due: 0, reserved: 0, paid: 0, cancelled: 0 } as Record<SupportGiftState, number>;
  for (const g of giftRows.results) counts[g.state] = (counts[g.state] ?? 0) + 1;

  return c.json({
    success: true,
    // The public handle. NULL means the account has no username yet — the
    // page says so and links to the profile editor instead of inventing one.
    username: handle || null,
    /** Legacy code kept as a permanent alias (§3.1: renaming never steals invites). */
    legacy_code: legacy?.code ?? null,
    invite_path: handle ? inviteRefPath(handle) : '',
    /** Example only — the caller appends it to the REAL product path it has. */
    product_ref_param: handle ? `ref=${handle.toLowerCase()}` : '',
    signup_invites: invites?.n ?? 0,
    support_gifts: gifts,
    support_gift_counts: counts,
    /** The separate, older program (PRO subscription / signup printer). */
    signup_rewards: rewardRows.results,
  });
});

/**
 * GET /api/referrals/support/resolve?ref=… — who a support code belongs to.
 *
 * Used by the cart to show "this code supports @username" before checkout.
 * It resolves server-side (a client-sent referrer id is never trusted,
 * §3.2), refuses self-support with a distinct code so the UI can explain it,
 * and returns nothing beyond the handle and display name — the same
 * information the share link itself already carries.
 */
referralRoutes.get('/support/resolve', async (c) => {
  await rateLimit(c, 'support-resolve', 60, 300);
  const user = c.get('user')!;
  const raw = str(c.req.query('ref'), 'ref', { min: 1, max: SUPPORT_REF_MAX });
  const clean = normalizeSupportRef(raw);
  if (!clean) throw badRequest('كود دعم غير صالح / Invalid support code', 'INVALID_REF');

  const resolved = await resolveSupportRef(c.env, clean);
  c.header('Cache-Control', 'no-store');
  if (!resolved) throw notFound('لا يوجد مستخدم بهذا الكود / No user matches this support code');
  if (resolved.userId === user.id) {
    throw badRequest('لا يمكنك دعم نفسك / You cannot support your own account', 'SELF_SUPPORT');
  }
  return c.json({
    success: true,
    ref: clean,
    username: resolved.username || null,
    display_name: resolved.displayName,
    /** Stated on every surface so the code is never mistaken for a coupon. */
    price_effect_iqd: 0,
  });
});

/**
 * GET /api/referrals/support/link?path=/product/<slug> — the share link a
 * signed-in user should send. The REAL path comes from the caller (the app
 * knows its own routing); this endpoint only attaches the handle, so no
 * product path is ever guessed server-side.
 */
referralRoutes.get('/support/link', async (c) => {
  const user = c.get('user')!;
  const path = str(c.req.query('path'), 'path', { min: 1, max: 300 });
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw badRequest('path must be an app-relative path such as /product/<slug>', 'INVALID_PATH');
  }
  const handle = user.username || '';
  if (!handle) {
    return c.json({ success: true, path, ref: null, supported: false });
  }
  return c.json({ success: true, path: productSupportPath(path, handle), ref: handle.toLowerCase(), supported: true });
});

// ------------------------------------------------------------------- admin

interface AdminGiftRow extends GiftRow {
  referrer_id: string;
  buyer_id: string;
  support_ref: string;
  delivered_at: string | null;
  settled_at: string | null;
  updated_at: string;
  decided_by: string | null;
  admin_note: string;
  referrer_username: string | null;
  buyer_username: string | null;
}

/**
 * GET /api/referrals/admin/gifts?state=&needs_review=&limit=
 * The review queue: origin (order + support ref), both parties, state,
 * reason, dates and the deciding actor (§3.4).
 */
referralRoutes.get('/admin/gifts', async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 24, required: false });
  const needsReview = c.req.query('needs_review');
  const limit = int(c.req.query('limit') ?? 100, 'limit', { min: 1, max: 200, def: 100 });

  let sql = `SELECT g.*, ru.username AS referrer_username, bu.username AS buyer_username
               FROM support_gift_entitlements g
               JOIN users ru ON ru.id = g.referrer_id
               JOIN users bu ON bu.id = g.buyer_id`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (state) {
    where.push('g.state = ?');
    params.push(oneOf(state, 'state', SUPPORT_GIFT_STATES));
  }
  if (needsReview === '1' || needsReview === 'true') where.push('g.needs_review = 1');
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY g.created_at DESC LIMIT ?';
  params.push(limit);

  const { results } = await c.env.DB.prepare(sql).bind(...params).all<AdminGiftRow>();
  return c.json({ success: true, gifts: results });
});

/**
 * PATCH /api/referrals/admin/gifts/:id — the ONLY way a claim advances past
 * "due". Transitions are forward-only (pending_eligibility → due → reserved
 * → paid) plus "any live state → cancelled", and every write is a
 * conditional UPDATE keyed on the state the admin actually saw: losing a
 * concurrent decision aborts with 409 instead of overwriting the winner.
 *
 * A financial/handover record is never edited in place — a decision writes
 * its actor, moment and reason, and 'paid' additionally requires the real
 * product that was handed over.
 */
referralRoutes.patch('/admin/gifts/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));

  const gift = await db
    .prepare('SELECT * FROM support_gift_entitlements WHERE id = ?')
    .bind(id)
    .first<AdminGiftRow>();
  if (!gift) throw notFound('Support gift entitlement not found');

  const nextState =
    body.state !== undefined && body.state !== gift.state
      ? oneOf(body.state, 'state', SUPPORT_GIFT_STATES)
      : undefined;
  if (nextState && !supportGiftTransitionAllowed(gift.state, nextState)) {
    throw badRequest(
      `Invalid transition ${gift.state} → ${nextState} (allowed: pending_eligibility→due→reserved→paid, any live state→cancelled)`,
      'INVALID_TRANSITION'
    );
  }

  const note = body.admin_note !== undefined ? str(body.admin_note, 'admin_note', { max: 500, required: false }) : undefined;
  const reason = str(body.reason, 'reason', { max: 200, required: false });
  let spoolProductId: string | undefined;
  if (body.spool_product_id !== undefined) {
    spoolProductId = str(body.spool_product_id, 'spool_product_id', { min: 1, max: 60 });
  }
  if (nextState === 'paid') {
    const spool = spoolProductId ?? (gift.spool_product_id ? String(gift.spool_product_id) : '');
    if (!spool) throw badRequest('paid requires spool_product_id — the product actually handed over', 'SPOOL_REQUIRED');
    spoolProductId = spool;
  }
  if (spoolProductId !== undefined) {
    const product = await db
      .prepare("SELECT id FROM products WHERE id = ? AND status = 'active'")
      .bind(spoolProductId)
      .first();
    if (!product) throw badRequest('spool_product_id must reference an existing active product', 'SPOOL_INVALID');
  }
  if (nextState === 'cancelled' && !reason) {
    throw badRequest('cancelling requires a reason', 'REASON_REQUIRED');
  }

  // Resolving a review flag is an explicit, reasoned act — the flag can never
  // be cleared as a side effect of another edit.
  const clearReview = body.clear_review === true;
  if (clearReview && !reason) throw badRequest('clearing a review flag requires a reason', 'REASON_REQUIRED');

  // Advancing a claim re-verifies the business facts at the moment of the
  // decision: an order that was cancelled or returned after the claim became
  // due must not be paid out on stale state.
  if (nextState === 'reserved' || nextState === 'paid' || nextState === 'due') {
    const check = await evaluateSupportGiftForOrder(c.env, gift.order_id, {
      trigger: `admin_${nextState}`,
      actorId: admin.id,
    });
    if (check.state === 'cancelled' || check.blocker === 'order_cancelled' || check.blocker === 'self_support') {
      throw conflict('The order behind this claim is no longer eligible — it was cancelled or is self-support');
    }
    if (nextState === 'due' && check.blocker) {
      throw badRequest(
        `The order has not qualified yet (${check.blocker}) — approving anyway would fabricate eligibility`,
        'NOT_QUALIFIED'
      );
    }
    // Stock and payouts wait for a human to resolve the flag that stopped
    // the claim (a double-payout risk, or a return on the eligible line).
    if ((nextState === 'reserved' || nextState === 'paid') && (gift.needs_review || check.needs_review) && !clearReview) {
      throw conflict(
        `This claim is held for review (${check.review_reason || gift.review_reason || 'review'}) — resolve it with clear_review and a reason first`
      );
    }
  }

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];
  const changes: Record<string, unknown> = {};

  if (nextState !== undefined) {
    sets.push('state = ?', 'decided_at = ?', 'decided_by = ?');
    params.push(nextState, new Date().toISOString(), admin.id);
    changes.state = nextState;
    if (nextState === 'due') {
      // Approving a held claim clears the review flag and stamps the moment
      // it became due — the CHECK in migration 0016 requires it.
      sets.push('qualified_at = COALESCE(qualified_at, ?)', 'needs_review = 0');
      params.push(new Date().toISOString());
      changes.needs_review = false;
    }
    if (nextState === 'cancelled') {
      sets.push('outcome_reason = ?');
      params.push(reason);
      changes.outcome_reason = reason;
    }
  }
  if (spoolProductId !== undefined) {
    sets.push('spool_product_id = ?');
    params.push(spoolProductId);
    changes.spool_product_id = spoolProductId;
  }
  if (note !== undefined) {
    sets.push('admin_note = ?');
    params.push(note);
    changes.admin_note = note;
  }
  if (clearReview) {
    // The original reason is KEPT (prefixed as resolved), never erased — the
    // history of why a claim was held stays readable (§3.4).
    sets.push('needs_review = 0', 'review_reason = ?');
    params.push(`resolved(${gift.review_reason || 'review'}): ${reason}`.slice(0, 200));
    changes.needs_review = false;
    changes.review_resolved = reason;
  }
  if (Object.keys(changes).length === 0) throw badRequest('Nothing to update');

  params.push(id, gift.state);
  const res = await db
    .prepare(`UPDATE support_gift_entitlements SET ${sets.join(', ')} WHERE id = ? AND state = ?`)
    .bind(...params)
    .run();
  if ((res.meta.changes || 0) === 0) {
    throw conflict('This entitlement changed while you were deciding — reload and try again');
  }

  await audit(db, admin.id, 'support_gift.admin_update', id, {
    order_id: gift.order_id,
    referrer_id: gift.referrer_id,
    from: gift.state,
    ...changes,
    reason,
  });
  const updated = await db
    .prepare('SELECT * FROM support_gift_entitlements WHERE id = ?')
    .bind(id)
    .first<AdminGiftRow>();
  return c.json({ success: true, gift: updated });
});

/**
 * POST /api/referrals/admin/gifts/evaluate { order_id } — run the idempotent
 * engine for one order. This is the catch-up hook for events that do not
 * call it directly yet (a COD collected by a job, a legacy cancel path).
 * Replays are safe: the engine creates at most one claim per order.
 */
referralRoutes.post('/admin/gifts/evaluate', async (c) => {
  const admin = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const orderId = str(body.order_id ?? body.orderId, 'order_id', { min: 1, max: 60 });
  const result = await evaluateSupportGiftForOrder(c.env, orderId, {
    trigger: 'admin_evaluate',
    actorId: admin.id,
  });
  return c.json({ success: true, result });
});

/**
 * POST /api/referrals/admin/gifts/reconcile { limit } — sweep live claims and
 * re-apply the same rules (cancel the ones whose order died, promote the
 * ones whose payment landed, flag the ones a return touched).
 */
referralRoutes.post('/admin/gifts/reconcile', async (c) => {
  const admin = c.get('user')!;
  await rateLimit(c, 'support-gift-reconcile', 10, 300);
  const body = await c.req.json().catch(() => ({}));
  const limit = int(body.limit ?? 200, 'limit', { min: 1, max: 500, def: 200 });
  const report = await reconcileSupportGifts(c.env, limit);
  await audit(c.env.DB, admin.id, 'support_gift.reconcile', 'sweep', report as unknown as Record<string, unknown>);
  return c.json({ success: true, report });
});
