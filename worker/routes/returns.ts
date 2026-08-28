/**
 * Returns (§6.2) and seven-day price protection (§6.8).
 *
 * Returns — return_cases (0003):
 *   requested → assessment → approved/rejected → collection → received →
 *   inspected → resolved(replacement/refund/repair/declined)
 *  - The 7-day window runs from the affected UNIT's delivered_at when a
 *    physical unit is selected, else the order's delivered_at, and is judged
 *    by the REQUEST time — late staff review never invalidates a timely
 *    request (within_window is snapshotted at creation).
 *  - Money/inventory move ONLY at the approved end of the pipeline
 *    (resolved after received+inspected), idempotently: the wallet refund
 *    uses the deterministic id wtx_ret_<caseId> (PK dedupes replays), the
 *    stock restore runs once behind the conditional state flip. Purchase
 *    points are reversed proportionally (worker/lib/pointsOps.ts).
 *  - Refund destination is the existing wallet pattern — flagged as a
 *    configurable default (decision register row 8: refund destination and
 *    shipping-refund policy await the owner). Shipping is NOT refunded here.
 *
 * Price protection — price_protection_claims + price_history (0003):
 *  - Claim on MY delivered order item within 7 days of delivered_at.
 *  - The drop is computed SERVER-SIDE for the same product/option/color and
 *    the price class the buyer actually had (pricing_snapshot.applied_tier):
 *    a regular buyer is never compared against a PRO-only price.
 *  - Cumulative cap: total credits for one item can never exceed the eligible
 *    difference; repeated drops/claims deduct prior credits.
 *  - NO automatic payout: an admin approves/rejects with a reason; approval
 *    credits the wallet idempotently (wtx_pp_<claimId>). The compensation
 *    channel (wallet) is flagged as a configurable default (row 22).
 */

import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, requireAdmin, badRequest, notFound, int, str, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit } from '../lib/audit';
import { rateLimit } from '../lib/ratelimit';
import { notifyAdmins } from '../lib/telegram';
import { getSettings } from '../lib/settings';
import { parseProductRow } from '../lib/productModel';
import { resolveUnitPrice, proPolicyFrom } from '../lib/pricing';
import { reversePointsForOrder, unitMerchandiseIqd } from '../lib/pointsOps';

const WINDOW_MS = 7 * 86_400_000;

// The DB CHECK constraint (0003) uses 'wrong_item'; the public API accepts
// the brief's 'wrong_product' as an alias.
const RETURN_REASONS = ['defective', 'manufacturing_fault', 'not_as_described', 'wrong_item', 'shipping_damage'] as const;
type ReturnReason = (typeof RETURN_REASONS)[number];

const RETURN_STATES = [
  'requested', 'assessment', 'approved', 'rejected', 'collection', 'received', 'inspected', 'resolved',
] as const;
type ReturnState = (typeof RETURN_STATES)[number];

/** Admin workflow graph — every transition is an explicit staff act. */
const RETURN_TRANSITIONS: Record<ReturnState, ReturnState[]> = {
  requested: ['assessment', 'approved', 'rejected'],
  assessment: ['approved', 'rejected'],
  approved: ['collection', 'received'],
  rejected: ['assessment'], // reopen for another look
  collection: ['received'],
  received: ['inspected'],
  inspected: ['resolved', 'rejected'],
  resolved: [],
};

const RESOLUTIONS = ['replacement', 'refund', 'repair', 'declined'] as const;

interface ReturnCaseRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  order_item_id: string;
  unit_id: string | null;
  user_id: string;
  qty: number;
  reason: string;
  description: string;
  evidence: string;
  requested_at: string;
  delivered_at_snapshot: string | null;
  within_window: number;
  state: ReturnState;
  resolution: string | null;
  admin_note: string;
  decided_by: string | null;
  decided_at: string | null;
}

function casePublic(r: ReturnCaseRow, extra: Record<string, unknown> = {}) {
  const evidenceKeys = safeParse<string[]>(r.evidence, []);
  return {
    id: r.id,
    order_id: r.order_id,
    order_item_id: r.order_item_id,
    unit_id: r.unit_id,
    qty: r.qty,
    reason: r.reason,
    description: r.description,
    evidence: evidenceKeys.map((k) => ({ key: k, url: `/files/${k}` })),
    requested_at: r.requested_at,
    delivered_at: r.delivered_at_snapshot,
    within_window: !!r.within_window,
    state: r.state,
    resolution: r.resolution,
    admin_note: r.admin_note,
    decided_at: r.decided_at,
    ...extra,
  };
}

// ============================================================== RETURNS

export const returnRoutes = new Hono<AppContext>();
returnRoutes.use('*', requireAuth);

returnRoutes.post('/', async (c) => {
  await rateLimit(c, 'return_request', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));

  const orderItemId = str(body.orderItemId, 'orderItemId', { min: 1, max: 60 });
  const unitId = str(body.unitId, 'unitId', { max: 60, required: false });
  const qty = int(body.qty, 'qty', { min: 1, max: 500, def: 1 });
  const rawReason = str(body.reason, 'reason', { min: 1, max: 40 });
  const reason: ReturnReason | null =
    rawReason === 'wrong_product' ? 'wrong_item'
    : (RETURN_REASONS as readonly string[]).includes(rawReason) ? (rawReason as ReturnReason)
    : null;
  if (!reason) {
    throw badRequest(`reason must be one of: defective, manufacturing_fault, not_as_described, wrong_product, shipping_damage`);
  }
  const description = str(body.description, 'description', { max: 3000, required: false });

  // Private evidence: keys must live under the caller's OWN private receipts/
  // prefix (owner-or-admin access only — worker/routes/uploads.ts policy).
  const evidenceRaw = Array.isArray(body.evidence) ? body.evidence : [];
  if (evidenceRaw.length > 6) throw badRequest('evidence: at most 6 files');
  const evidence: string[] = [];
  for (const k of evidenceRaw) {
    if (typeof k !== 'string' || k.length > 400 || !k.startsWith(`receipts/${user.id}/`)) {
      throw badRequest('evidence: each entry must be a private upload key belonging to you');
    }
    evidence.push(k);
  }

  const item = await c.env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.qty AS item_qty, oi.name_snapshot,
            o.user_id, o.status, o.delivered_at
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ?`
  )
    .bind(orderItemId)
    .first<{ id: string; order_id: string; item_qty: number; name_snapshot: string; user_id: string; status: string; delivered_at: string | null }>();
  if (!item || item.user_id !== user.id) throw notFound('Order item not found');

  // Per-unit delivery time when a physical unit is selected; else the order's.
  let deliveredAt = item.delivered_at;
  if (unitId) {
    const unit = await c.env.DB.prepare(
      'SELECT id, order_item_id, owner_user_id, delivered_at FROM order_item_units WHERE id = ?'
    )
      .bind(unitId)
      .first<{ id: string; order_item_id: string; owner_user_id: string; delivered_at: string | null }>();
    if (!unit || unit.owner_user_id !== user.id || unit.order_item_id !== orderItemId) {
      throw notFound('Device unit not found on this order item');
    }
    deliveredAt = unit.delivered_at ?? deliveredAt;
    const dupe = await c.env.DB.prepare(
      "SELECT 1 AS x FROM return_cases WHERE unit_id = ? AND state <> 'rejected' LIMIT 1"
    )
      .bind(unitId)
      .first();
    if (dupe) throw badRequest('A return case for this device already exists', 'RETURN_EXISTS');
  }

  if (item.status !== 'delivered' || !deliveredAt) {
    throw badRequest('Returns are available after the item is delivered', 'NOT_DELIVERED');
  }

  // Timeliness is judged by the REQUEST time — now — against the delivery
  // time of the affected unit/item. Staff review time never matters.
  const now = Date.now();
  const deliveredMs = Date.parse(deliveredAt);
  if (!Number.isFinite(deliveredMs)) throw badRequest('Delivery time for this item could not be read — contact support');
  const withinWindow = now <= deliveredMs + WINDOW_MS;
  if (!withinWindow) {
    throw badRequest('The 7-day return window for this item has closed (counted from its delivery)', 'RETURN_WINDOW_CLOSED');
  }

  if (qty > Number(item.item_qty)) throw badRequest(`qty exceeds the ordered quantity (${item.item_qty})`);
  const used = await c.env.DB.prepare(
    "SELECT COALESCE(SUM(qty), 0) AS n FROM return_cases WHERE order_item_id = ? AND state <> 'rejected'"
  )
    .bind(orderItemId)
    .first<{ n: number }>();
  if ((used?.n ?? 0) + qty > Number(item.item_qty)) {
    throw badRequest('The requested quantity exceeds what remains returnable for this item', 'QTY_EXCEEDED');
  }

  const id = newId('ret');
  const nowIso = new Date(now).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, description,
       evidence, requested_at, delivered_at_snapshot, within_window, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'requested')`
  )
    .bind(id, item.order_id, orderItemId, unitId || null, user.id, qty, reason, description, JSON.stringify(evidence), nowIso, deliveredAt)
    .run();

  await audit(c.env.DB, user.id, 'return.request', id, { order_id: item.order_id, order_item_id: orderItemId, qty, reason });
  c.executionCtx.waitUntil(
    notifyAdmins(c.env, `↩️ Return request ${id}\nOrder: ${item.order_id}\nItem: ${item.name_snapshot} × ${qty}\nReason: ${reason}`)
  );

  const row = await c.env.DB.prepare('SELECT * FROM return_cases WHERE id = ?').bind(id).first<ReturnCaseRow>();
  return c.json({ success: true, case: casePublic(row!) });
});

/** My return cases (optionally for one order). */
returnRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const orderId = str(c.req.query('orderId'), 'orderId', { max: 60, required: false });
  let sql = `SELECT rc.*, oi.name_snapshot, oi.image_snapshot, oi.option_snapshot
               FROM return_cases rc JOIN order_items oi ON oi.id = rc.order_item_id
              WHERE rc.user_id = ?`;
  const params: unknown[] = [user.id];
  if (orderId) {
    sql += ' AND rc.order_id = ?';
    params.push(orderId);
  }
  sql += ' ORDER BY rc.requested_at DESC LIMIT 100';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<ReturnCaseRow>();
  return c.json({
    success: true,
    cases: results.map((r) =>
      casePublic(r, {
        item: { name: r.name_snapshot, image: r.image_snapshot, variant: r.option_snapshot },
      })
    ),
  });
});

// ------------------------------------------------------------- admin queue

returnRoutes.get('/admin/queue', requireAdmin, async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false });
  let sql = `SELECT rc.*, oi.name_snapshot, oi.image_snapshot, oi.option_snapshot, u.email, u.username
               FROM return_cases rc
               JOIN order_items oi ON oi.id = rc.order_item_id
               LEFT JOIN users u ON u.id = rc.user_id`;
  const params: unknown[] = [];
  if (state && (RETURN_STATES as readonly string[]).includes(state)) {
    sql += ' WHERE rc.state = ?';
    params.push(state);
  }
  sql += ' ORDER BY rc.requested_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<ReturnCaseRow>();
  return c.json({
    success: true,
    cases: results.map((r) =>
      casePublic(r, {
        item: { name: r.name_snapshot, image: r.image_snapshot, variant: r.option_snapshot },
        email: r.email,
        username: r.username,
        user_id: r.user_id,
      })
    ),
  });
});

/**
 * Admin state transition. Money/inventory only at the approved end:
 * resolved+refund credits the wallet (idempotent wtx_ret_<caseId>), reverses
 * the proportional purchase points and restores tracked stock once.
 */
returnRoutes.post('/admin/:id/transition', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const to = oneOf(body.to, 'to', RETURN_STATES);
  const reason = str(body.reason, 'reason', { max: 1000, required: false });

  const kase = await c.env.DB.prepare('SELECT * FROM return_cases WHERE id = ?').bind(id).first<ReturnCaseRow>();
  if (!kase) throw notFound('Return case not found');
  const from = kase.state;
  if (!RETURN_TRANSITIONS[from]?.includes(to)) {
    throw badRequest(`Cannot move a return case from "${from}" to "${to}"`);
  }

  let resolution: (typeof RESOLUTIONS)[number] | null = null;
  if (to === 'resolved') {
    resolution = oneOf(body.resolution, 'resolution', RESOLUTIONS);
  }
  if ((to === 'rejected' || resolution === 'declined') && !reason) {
    throw badRequest('A reason is required when rejecting or declining a return');
  }

  const nowIso = new Date().toISOString();
  // Conditional flip: concurrent transitions cannot both pass (same pattern
  // as the order-cancel flow).
  const flip = await c.env.DB.prepare(
    `UPDATE return_cases SET state = ?, resolution = COALESCE(?, resolution),
        admin_note = CASE WHEN ? <> '' THEN ? ELSE admin_note END,
        decided_by = ?, decided_at = ?
      WHERE id = ? AND state = ?`
  )
    .bind(to, resolution, reason, reason, admin.id, nowIso, id, from)
    .run();
  if (flip.meta.changes === 0) throw badRequest('This case changed while you were editing — reload and retry');

  let refundResult: Record<string, unknown> | null = null;
  let pointsResult: Record<string, unknown> | null = null;

  if (to === 'resolved' && resolution === 'refund') {
    const item = await c.env.DB.prepare(
      'SELECT id, product_id, qty, unit_price_iqd, pricing_snapshot, warranty_snapshot, transport_snapshot FROM order_items WHERE id = ?'
    )
      .bind(kase.order_item_id)
      .first<Record<string, unknown>>();
    const order = await c.env.DB.prepare(
      'SELECT id, user_id, subtotal_iqd, shipping_iqd, points_discount_iqd, coupon_snapshot, exchange_rate FROM orders WHERE id = ?'
    )
      .bind(kase.order_id)
      .first<Record<string, unknown>>();
    if (item && order) {
      // Refund the paid amount for the returned qty, net of this line's
      // proportional share of order-level discounts. Shipping is NOT
      // refunded (owner decision pending — row 8).
      const lineGross = (Number(item.unit_price_iqd) || 0) * kase.qty;
      const coupon = safeParse<{ discount_iqd?: number } | null>(order.coupon_snapshot as string | null, null);
      const discounts = (coupon ? Number(coupon.discount_iqd) || 0 : 0) + (Number(order.points_discount_iqd) || 0);
      const base = (Number(order.subtotal_iqd) || 0) + (Number(order.shipping_iqd) || 0);
      const alloc = base > 0 ? Math.floor((discounts * lineGross) / base) : 0;
      const refundIqd = Math.max(0, lineGross - alloc);
      const rate = Number(order.exchange_rate) || 1400; // the ORDER's historical rate
      const cents = Math.round((refundIqd * 100) / rate);

      let credited = false;
      if (cents > 0) {
        try {
          await c.env.DB.prepare(
            `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
             VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'admin', ?)`
          )
            .bind(`wtx_ret_${id}`, kase.user_id, cents, `Refund for approved return ${id} (order ${kase.order_id})`, kase.order_id, nowIso)
            .run();
          credited = true;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!(msg.includes('UNIQUE') || msg.includes('PRIMARY KEY'))) throw e;
          // already credited by a previous attempt — idempotent replay
        }
      }
      refundResult = {
        amount_iqd: refundIqd,
        amount_usd_cents: cents,
        credited,
        wallet_tx: `wtx_ret_${id}`,
        channel: 'wallet',
        channel_note: 'Refund destination is a configurable default pending the owner decision (docs/DECISIONS.md row 8); shipping fees are not refunded here.',
      };

      // Proportional purchase-points reversal for the refunded merchandise
      // portion (idempotent per case; never double-reverses).
      const merchandisePortion = unitMerchandiseIqd({
        qty: Number(item.qty) || 0,
        unit_price_iqd: Number(item.unit_price_iqd) || 0,
        pricing_snapshot: (item.pricing_snapshot as string | null) ?? null,
        warranty_snapshot: (item.warranty_snapshot as string | null) ?? null,
        transport_snapshot: (item.transport_snapshot as string | null) ?? null,
      }) * kase.qty;
      pointsResult = await reversePointsForOrder(c.env, kase.order_id, `return ${id}`, {
        portionIqd: merchandisePortion,
        sourceRef: id,
      }) as unknown as Record<string, unknown>;

      // Inspected-and-approved refund puts the tracked stock back once (the
      // conditional flip above guarantees this branch runs a single time).
      if (item.product_id) {
        await c.env.DB.prepare('UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL')
          .bind(kase.qty, item.product_id)
          .run();
      }
    }
  }

  await audit(c.env.DB, admin.id, 'return.transition', id, {
    from, to, resolution, reason,
    refund: refundResult ? { amount_iqd: refundResult.amount_iqd, credited: refundResult.credited } : null,
  });

  const row = await c.env.DB.prepare('SELECT * FROM return_cases WHERE id = ?').bind(id).first<ReturnCaseRow>();
  return c.json({
    success: true,
    case: casePublic(row!),
    ...(refundResult ? { refund: refundResult } : {}),
    ...(pointsResult ? { points_reversal: pointsResult } : {}),
  });
});

/** Single case — owner or admin. */
returnRoutes.get('/:id', async (c) => {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT rc.*, oi.name_snapshot, oi.image_snapshot, oi.option_snapshot
       FROM return_cases rc JOIN order_items oi ON oi.id = rc.order_item_id
      WHERE rc.id = ?`
  )
    .bind(c.req.param('id'))
    .first<ReturnCaseRow>();
  if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw notFound('Return case not found');
  return c.json({
    success: true,
    case: casePublic(row, { item: { name: row.name_snapshot, image: row.image_snapshot, variant: row.option_snapshot } }),
  });
});

// ====================================================== PRICE PROTECTION

export const priceProtectionRoutes = new Hono<AppContext>();
priceProtectionRoutes.use('*', requireAuth);

interface ClaimRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  order_id: string;
  order_item_id: string;
  original_unit_iqd: number;
  observed_unit_iqd: number;
  qty: number;
  credited_iqd: number;
  state: string;
  policy_snapshot: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

function claimPublic(r: ClaimRow, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    order_id: r.order_id,
    order_item_id: r.order_item_id,
    original_unit_iqd: r.original_unit_iqd,
    observed_unit_iqd: r.observed_unit_iqd,
    qty: r.qty,
    credited_iqd: r.credited_iqd,
    state: r.state,
    policy: safeParse(r.policy_snapshot, {}),
    requested_at: r.requested_at,
    decided_at: r.decided_at,
    ...extra,
  };
}

/** Prior protection credits already granted for the same order item. */
async function priorCreditedIqd(db: D1Database, orderItemId: string, excludeClaimId?: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(credited_iqd), 0) AS n FROM price_protection_claims
        WHERE order_item_id = ? AND state IN ('approved','credited') AND id <> ?`
    )
    .bind(orderItemId, excludeClaimId ?? '')
    .first<{ n: number }>();
  return row?.n ?? 0;
}

priceProtectionRoutes.post('/claims', async (c) => {
  await rateLimit(c, 'pp_claim', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const orderItemId = str(body.orderItemId, 'orderItemId', { min: 1, max: 60 });

  const item = await c.env.DB.prepare(
    `SELECT oi.*, o.user_id AS owner_id, o.status, o.delivered_at
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.id = ?`
  )
    .bind(orderItemId)
    .first<Record<string, unknown>>();
  if (!item || item.owner_id !== user.id) throw notFound('Order item not found');
  if (item.status !== 'delivered' || !item.delivered_at) {
    throw badRequest('Price protection applies after delivery', 'NOT_DELIVERED');
  }

  const deliveredMs = Date.parse(String(item.delivered_at));
  const now = Date.now();
  if (!Number.isFinite(deliveredMs)) throw badRequest('Delivery time could not be read — contact support');
  if (now > deliveredMs + WINDOW_MS) {
    throw badRequest('The 7-day price-protection window for this item has closed', 'WINDOW_CLOSED');
  }

  if (!item.product_id) throw badRequest('This item no longer maps to a product', 'PRODUCT_MISSING');

  const pending = await c.env.DB.prepare(
    "SELECT 1 AS x FROM price_protection_claims WHERE order_item_id = ? AND state = 'requested' LIMIT 1"
  )
    .bind(orderItemId)
    .first();
  if (pending) throw badRequest('A claim for this item is already awaiting review', 'CLAIM_PENDING');

  // The price CLASS the buyer actually had, from the checkout snapshot — a
  // regular buyer is never compared against a PRO-only price.
  const pricing = safeParse<{ applied_tier?: string; applied_iqd?: number } | null>(
    item.pricing_snapshot as string | null,
    null
  );
  const buyerClass: 'pro' | 'regular' = pricing?.applied_tier === 'pro' ? 'pro' : 'regular';
  const originalUnit =
    pricing && Number.isInteger(pricing.applied_iqd)
      ? (pricing.applied_iqd as number)
      : unitMerchandiseIqd({
          qty: Number(item.qty) || 0,
          unit_price_iqd: Number(item.unit_price_iqd) || 0,
          pricing_snapshot: (item.pricing_snapshot as string | null) ?? null,
          warranty_snapshot: (item.warranty_snapshot as string | null) ?? null,
          transport_snapshot: (item.transport_snapshot as string | null) ?? null,
        });

  // Exact variant: ids persisted at checkout (migration 0008). Legacy items
  // with only a display label cannot be matched reliably → honest support route.
  const optionId = String(item.option_id ?? '');
  const colorId = String(item.color_id ?? '');
  if (!optionId && !colorId && String(item.option_snapshot ?? '') !== '') {
    throw badRequest(
      'This order predates exact variant tracking — please contact support to review this claim manually',
      'VARIANT_UNRESOLVED'
    );
  }

  const productRow = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
    .bind(item.product_id)
    .first<Record<string, unknown>>();
  if (!productRow) throw badRequest('The product is no longer available for comparison', 'PRODUCT_MISSING');

  const settings = await getSettings(c.env.DB, ['proPricingPolicy']);
  const doc = parseProductRow(productRow);
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: optionId || null,
    colorId: colorId || null,
    transportMethod: null,
    warrantyPlanId: null,
    tier: buyerClass === 'pro' ? 'pro' : 'free',
    tierActive: buyerClass === 'pro',
    proPolicy: proPolicyFrom(settings.proPricingPolicy),
  });
  if (resolved.errors.some((e) => e !== 'TRANSPORT_REQUIRED')) {
    throw badRequest(
      'The purchased variant no longer resolves on the current product — please contact support',
      'VARIANT_UNRESOLVED'
    );
  }
  const currentApplied = resolved.applied_iqd;

  // Lowest price WITHIN the window from the persisted price history — a drop
  // that has since been raised back remains inspectable (§6.8). For a PRO
  // buyer both pro and regular price rows count; a regular buyer only regular.
  const variantKeys = [''];
  if (optionId) variantKeys.push(`option:${optionId}`);
  if (colorId) variantKeys.push(`color:${colorId}`);
  const fields = buyerClass === 'pro' ? ['pro', 'regular'] : ['regular'];
  const windowFrom = new Date(deliveredMs).toISOString();
  const windowTo = new Date(Math.min(now, deliveredMs + WINDOW_MS)).toISOString();
  const hist = await c.env.DB.prepare(
    `SELECT MIN(new_iqd) AS m FROM price_history
      WHERE product_id = ? AND variant_key IN (${variantKeys.map(() => '?').join(',')})
        AND field IN (${fields.map(() => '?').join(',')})
        AND new_iqd IS NOT NULL AND changed_at >= ? AND changed_at <= ?`
  )
    .bind(item.product_id, ...variantKeys, ...fields, windowFrom, windowTo)
    .first<{ m: number | null }>();

  const candidates = [currentApplied];
  if (hist && hist.m !== null && Number.isInteger(hist.m) && hist.m >= 0) candidates.push(hist.m);
  const observedUnit = Math.min(...candidates);

  const perUnitDrop = Math.max(0, originalUnit - observedUnit);
  if (perUnitDrop <= 0) {
    throw badRequest('No eligible price drop was found for this item within the window', 'NO_ELIGIBLE_DROP');
  }

  const qty = Number(item.qty) || 1;
  const eligibleTotal = perUnitDrop * qty;
  const prior = await priorCreditedIqd(c.env.DB, orderItemId);
  const computed = Math.max(0, eligibleTotal - prior);
  if (computed <= 0) {
    throw badRequest('Earlier price-protection credits already cover the full eligible difference', 'ALREADY_COMPENSATED');
  }

  const id = newId('ppc');
  const policySnapshot = JSON.stringify({
    buyer_class: buyerClass,
    basis: 'min(current_applied, price_history window minimum)',
    window: { from: windowFrom, to: windowTo },
    current_applied_iqd: currentApplied,
    history_min_iqd: hist?.m ?? null,
    eligible_total_iqd: eligibleTotal,
    prior_credited_iqd: prior,
    computed_eligible_iqd: computed,
    compensation_channel: 'wallet (configurable default — owner decision pending, docs/DECISIONS.md row 22)',
  });
  await c.env.DB.prepare(
    `INSERT INTO price_protection_claims (id, user_id, order_id, order_item_id, original_unit_iqd,
       observed_unit_iqd, qty, credited_iqd, state, policy_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'requested', ?)`
  )
    .bind(id, user.id, String(item.order_id), orderItemId, originalUnit, observedUnit, qty, policySnapshot)
    .run();

  await audit(c.env.DB, user.id, 'price_protection.claim', id, {
    order_item_id: orderItemId, original: originalUnit, observed: observedUnit, computed_iqd: computed,
  });
  c.executionCtx.waitUntil(
    notifyAdmins(c.env, `🛡️ Price-protection claim ${id}\nItem: ${String(item.name_snapshot)}\nDrop: ${perUnitDrop.toLocaleString()} IQD × ${qty}`)
  );

  const row = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
  return c.json({ success: true, claim: claimPublic(row!) });
});

priceProtectionRoutes.get('/claims', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT ppc.*, oi.name_snapshot, oi.option_snapshot
       FROM price_protection_claims ppc JOIN order_items oi ON oi.id = ppc.order_item_id
      WHERE ppc.user_id = ? ORDER BY ppc.requested_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all<ClaimRow>();
  return c.json({
    success: true,
    claims: results.map((r) => claimPublic(r, { item: { name: r.name_snapshot, variant: r.option_snapshot } })),
  });
});

priceProtectionRoutes.get('/admin/claims', requireAdmin, async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false });
  let sql = `SELECT ppc.*, oi.name_snapshot, oi.option_snapshot, u.email, u.username
               FROM price_protection_claims ppc
               JOIN order_items oi ON oi.id = ppc.order_item_id
               LEFT JOIN users u ON u.id = ppc.user_id`;
  const params: unknown[] = [];
  if (state && ['requested', 'approved', 'rejected', 'credited'].includes(state)) {
    sql += ' WHERE ppc.state = ?';
    params.push(state);
  }
  sql += ' ORDER BY ppc.requested_at DESC LIMIT 200';
  const { results } = await c.env.DB.prepare(sql).bind(...params).all<ClaimRow>();
  return c.json({
    success: true,
    claims: results.map((r) =>
      claimPublic(r, {
        item: { name: r.name_snapshot, variant: r.option_snapshot },
        email: r.email, username: r.username, user_id: r.user_id,
      })
    ),
  });
});

/**
 * Admin decision. Approval credits the wallet idempotently
 * (wtx_pp_<claimId>) and re-applies the cumulative cap at decision time so
 * concurrent claims can never overcompensate the same item.
 */
priceProtectionRoutes.post('/admin/claims/:id/decide', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.decision, 'decision', ['approved', 'rejected'] as const);
  const reason = str(body.reason, 'reason', {
    min: decision === 'rejected' ? 3 : 0,
    max: 1000,
    required: decision === 'rejected',
  });

  const claim = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
  if (!claim) throw notFound('Claim not found');
  const nowIso = new Date().toISOString();

  if (decision === 'rejected') {
    const res = await c.env.DB.prepare(
      `UPDATE price_protection_claims SET state = 'rejected', decided_by = ?, decided_at = ?,
          policy_snapshot = json_set(policy_snapshot, '$.decision_reason', ?)
        WHERE id = ? AND state = 'requested'`
    )
      .bind(admin.id, nowIso, reason, id)
      .run();
    if (res.meta.changes === 0) throw badRequest('This claim was already decided');
    await audit(c.env.DB, admin.id, 'price_protection.reject', id, { reason });
    const row = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
    return c.json({ success: true, claim: claimPublic(row!) });
  }

  // Approve: re-derive the credit under the cumulative cap NOW.
  const eligibleTotal = Math.max(0, (claim.original_unit_iqd - claim.observed_unit_iqd) * claim.qty);
  const prior = await priorCreditedIqd(c.env.DB, claim.order_item_id, id);
  const credit = Math.max(0, Math.min(eligibleTotal - prior, eligibleTotal));
  if (credit <= 0) {
    throw badRequest('Earlier credits already cover the eligible difference — nothing left to credit', 'ALREADY_COMPENSATED');
  }

  const flip = await c.env.DB.prepare(
    `UPDATE price_protection_claims SET state = 'approved', decided_by = ?, decided_at = ?
      WHERE id = ? AND state = 'requested'`
  )
    .bind(admin.id, nowIso, id)
    .run();
  if (flip.meta.changes === 0) throw badRequest('This claim was already decided');

  const order = await c.env.DB.prepare('SELECT exchange_rate FROM orders WHERE id = ?')
    .bind(claim.order_id)
    .first<{ exchange_rate: number }>();
  const rate = Number(order?.exchange_rate) || 1400;
  const cents = Math.round((credit * 100) / rate);

  let credited = false;
  if (cents > 0) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, 'admin', ?)`
      )
        .bind(`wtx_pp_${id}`, claim.user_id, cents, `Price-protection credit for claim ${id} (order ${claim.order_id})`, claim.order_id, nowIso)
        .run();
      credited = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(msg.includes('UNIQUE') || msg.includes('PRIMARY KEY'))) throw e;
    }
  }
  await c.env.DB.prepare(
    "UPDATE price_protection_claims SET state = 'credited', credited_iqd = ? WHERE id = ? AND state = 'approved'"
  )
    .bind(credit, id)
    .run();

  await audit(c.env.DB, admin.id, 'price_protection.approve', id, { credited_iqd: credit, usd_cents: cents, reason });
  const row = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
  return c.json({
    success: true,
    claim: claimPublic(row!),
    credit: {
      amount_iqd: credit,
      amount_usd_cents: cents,
      credited,
      wallet_tx: `wtx_pp_${id}`,
      channel: 'wallet',
      channel_note: 'Compensation channel is a configurable default pending the owner decision (docs/DECISIONS.md row 22).',
    },
  });
});
