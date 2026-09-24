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
 *    A GINI ORDER IS THE EXCEPTION AND IT IS NOT A POLICY CHOICE: its goods
 *    were settled inside the bank's app and never reached Levonis, so no Levo
 *    wallet credit is posted. The amount the customer is still owed is
 *    reported as `gini_refund_due_iqd` and written onto the case's note, for
 *    staff to reverse with Gini/Rafidain — that side is settled outside this
 *    system.
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
import { emitFromRequest, eventsEnabled } from '../lib/eventBus';
import { RefundCompletedV1 } from '@levonis/contracts/events/v1/RefundCompleted';
import { rateLimit } from '../lib/ratelimit';
import { getSettings } from '../lib/settings';
import { parseProductRow } from '../lib/productModel';
import { resolveUnitPrice, proPolicyFrom } from '../lib/pricing';
import { applyRelations, loadRelationsView } from '../lib/productOverlay';
import { reversePointsForOrder, unitMerchandiseIqd } from '../lib/pointsOps';
import { walletCreditStatement } from '../lib/wallet';
import { walletLedgerDinarsReady } from '../lib/walletOps';
import { planInventory, planReservationFence, chunk, IN_CHUNK } from '../lib/inventory';
import { restoreMovesForItem } from '../lib/orderInventory';
import { isRevealed, loadAllocations, paidOrderIds } from '../lib/mysteryReveal';
import { mysteryRefusal } from '../lib/mystery/issues';
import { typeForTransport } from '../lib/shippingType';
import { pumpAfter, waitUntilFrom } from '../lib/eventBus';
import { announceAfterResponse, orderTopic } from '../lib/adminTopicRouting';
import { parseConditionDoc, returnRefusal } from '../lib/condition';
import { CONDITION_DOC_DEFAULT_SQL, isConditionColumnMissing } from '../lib/conditionProjection';

const WINDOW_MS = 7 * 86_400_000;

// The DB CHECK constraint (0003) uses 'wrong_item'; the public API accepts
// the brief's 'wrong_product' as an alias.
const RETURN_REASONS = ['defective', 'manufacturing_fault', 'not_as_described', 'wrong_item', 'shipping_damage'] as const;
type ReturnReason = (typeof RETURN_REASONS)[number];

/**
 * THE TWO KINDS OF RETURN, AND WHY ONE COMPONENT OF A BUNDLE CAN ONLY BE ONE
 * OF THEM (owner decision 3).
 *
 * COMMERCIAL — "not as described", "wrong item" — is a change of mind about a
 * purchase. The owner ruled that a bundle is returned whole or not at all:
 * returning the expensive half of a discounted bundle and keeping the cheap
 * half at the bundle price is a discount nobody offered.
 *
 * A DEFECT is not a purchase decision. The owner's words: a warranty or fault
 * claim on one component must stay possible and must NOT be treated as a
 * partial bundle return. The remedies this pipeline offers for a defect —
 * `repair` and `replacement` — move no money at all, so nothing about the
 * bundle's price is reopened by one; and where staff do choose `refund`, the
 * arithmetic already prices a component from `component_alloc_iqd`, its own
 * share of what was actually paid.
 */
const DEFECT_REASONS: readonly ReturnReason[] = ['defective', 'manufacturing_fault', 'shipping_damage'];

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

  /**
   * `condition_doc` is migration 0085's column, and a deploy that lands ahead
   * of its database once turned this whole route into a 500 — a customer with
   * a faulty printer could not open a return at all. The retry substitutes the
   * column's own declared DEFAULT `'{}'`, which `parseConditionDoc` reads as
   * "not graded", so the refusal below simply does not apply: exactly the
   * behaviour this route had before open-box existed, which is the correct
   * behaviour on a database where open-box cannot exist yet.
   * (worker/lib/conditionProjection.ts explains why this is a substitution
   * rather than a forbidden degrade.)
   */
  const itemSql = (conditionExpr: string) =>
    `SELECT oi.id, oi.order_id, oi.qty AS item_qty, oi.name_snapshot, oi.bundle_parent_item_id,
            o.user_id, o.status, o.delivered_at, o.stage, o.shipping_type, o.seller_type,
            ${conditionExpr} AS product_condition_doc
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.id = ?`;
  const readItem = (conditionExpr: string) =>
    c.env.DB.prepare(itemSql(conditionExpr))
    .bind(orderItemId)
    .first<{
      id: string;
      order_id: string;
      item_qty: number;
      name_snapshot: string;
      bundle_parent_item_id: string | null;
      user_id: string;
      status: string;
      delivered_at: string | null;
      stage: string | null;
      shipping_type: string | null;
      seller_type: string | null;
      product_condition_doc: string | null;
    }>();
  let item: Awaited<ReturnType<typeof readItem>>;
  try {
    item = await readItem('p.condition_doc');
  } catch (e) {
    if (!(await isConditionColumnMissing(c.env.DB, e))) throw e;
    item = await readItem(CONDITION_DOC_DEFAULT_SQL);
  }
  if (!item || item.user_id !== user.id) throw notFound('Order item not found');

  /**
   * A COMMUNITY-STORE ORDER IS NOT RETURNED THROUGH LEVONIS'S RETURNS DESK.
   *
   * The goods are the merchant's and the money is the merchant's credit; a
   * case resolved here as `refund` would credit the customer's wallet from
   * Levonis while the store kept its sale. Store orders could never reach this
   * door before — nothing on their path wrote `delivered_at` — and now that
   * the store's «تم التسليم» does, the rule is stated instead of accidental:
   * a problem with a store order is a support ticket or complaint on it, which
   * also FREEZES the merchant's money until a human decides
   * (worker/lib/storeOrderOps.ts).
   */
  if (String(item.seller_type ?? '') === 'merchant') {
    throw badRequest(
      'Returns for a community store order go through support — open a ticket on the order and the store is paid nothing until it is resolved.',
      'STORE_ORDER_RETURN_VIA_SUPPORT'
    );
  }

  /**
   * AN OPEN-BOX UNIT IS SOLD AS IMPERFECT, SO "not as described" IS NOT A CASE.
   *
   * Its grade, its running hours and its repair history are printed on the
   * product page before anybody pays, which is exactly what makes the
   * change-of-mind return unavailable — that is the owner's «غير قابل
   * للإرجاع». It is ALSO why the block stops there: a unit that arrives dead,
   * arrives damaged, or is the wrong box was never described at all, and
   * refusing those would cost far more trust than the unit is worth.
   *
   * LEFT JOIN, so an order line whose product has since been deleted still
   * returns normally rather than being refused by a NULL.
   */
  const conditionRefusal = returnRefusal(parseConditionDoc(item.product_condition_doc), reason);
  if (conditionRefusal) {
    throw badRequest(
      'هذا المنتج مستعمل/مجدد ولا يقبل الإرجاع لتغيير الرأي — يبقى مشمولاً إذا وصل تالفاً أو كان الجهاز خاطئاً. / This is a used or refurbished unit and cannot be returned for change of mind. A claim is still accepted if it arrived faulty, damaged, or is the wrong item.',
      conditionRefusal
    );
  }

  // WHOLE-BUNDLE RETURNS ONLY, v1 (§6.4, §17 decision 3). A case names ONE
  // `order_items` row, and for a bundle that row is a COMPONENT — the row that
  // carries the real product, the real stock movement and the warranty clock.
  // A customer returning one part of a bundle they paid one price for is a
  // policy question the owner has not answered, so it is refused by name
  // rather than answered here: the screen offers "return the whole bundle",
  // which posts the PARENT and opens one case per component below.
  const componentDefectClaim = !!item.bundle_parent_item_id && DEFECT_REASONS.includes(reason);
  if (item.bundle_parent_item_id && !componentDefectClaim) {
    throw badRequest(
      'This item was bought as part of a bundle — return the whole bundle instead. A faulty part can be claimed on its own.',
      'BUNDLE_PARTIAL_RETURN_NOT_ALLOWED',
      { bundle_parent_item_id: item.bundle_parent_item_id }
    );
  }
  const { results: bundleChildren } = await c.env.DB.prepare(
    'SELECT id, qty, name_snapshot FROM order_items WHERE bundle_parent_item_id = ? ORDER BY rowid'
  )
    .bind(orderItemId)
    .all<{ id: string; qty: number; name_snapshot: string }>();

  /** One component's share of a whole-bundle return of `qty` parents. The same
   *  ratio decides the quota check and the case that is written, so the two can
   *  never disagree. */
  const childCaseQty = (k: { qty: number }): number =>
    Math.max(
      1,
      Math.min(
        Number(k.qty) || 1,
        Math.round(((Number(k.qty) || 1) * qty) / Math.max(1, Number(item.item_qty) || 1))
      )
    );

  /**
   * A RETURN BEFORE THE REVEAL IS REFUSED, NOT LEAKED (§8.2 row 15).
   *
   * The return flow lists what is being sent back — for a mystery line that is
   * the drawn filament — so opening a case before the milestone would publish
   * the pick through the returns screen, an unauthenticated-looking corner
   * nobody thinks of as a reveal surface. `MYSTERY_NOT_REVEALED` says so and
   * names nothing.
   */
  //
  // BOTH SHAPES, not only the parent. Before the defect carve-out below, every
  // mystery row was reachable only through its parent, so gating on
  // `bundleChildren.length > 0` was complete. A directly-posted component can
  // now be a mystery spool, and it would have walked straight past this.
  {
    const allocations = await loadAllocations(c.env.DB, [item.order_id]);
    const mine =
      bundleChildren.length > 0
        ? bundleChildren.flatMap((k) => allocations.get(String(k.id)) ?? [])
        : (allocations.get(orderItemId) ?? []);
    if (mine.length > 0) {
      const paid = (await paidOrderIds(c.env.DB, [item.order_id])).has(item.order_id);
      const facts = {
        stage: String(item.stage || 'received'),
        status: String(item.status ?? ''),
        shipping_type: typeForTransport(
          String(item.shipping_type ?? '').startsWith('preorder_')
            ? String(item.shipping_type).slice('preorder_'.length)
            : ''
        ),
      };
      if (!mine.every((a) => isRevealed(a, facts, paid))) throw mysteryRefusal('MYSTERY_NOT_REVEALED');
    }
  }

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

  /**
   * THE RETURNABLE QUOTA IS JUDGED ON THE ROWS THE CASES ARE ACTUALLY OPENED
   * AGAINST (§6.4, §17 decision 3).
   *
   * A whole-bundle return opens one case per COMPONENT, never against the
   * parent, so a quota read keyed on the parent counted zero for ever and the
   * same delivered bundle could be refunded — and its stock restored — once per
   * request for the whole return window: each round priced off
   * `component_alloc_iqd`, credited under a fresh `wtx_ret_<caseId>` the wallet
   * idempotency guard never saw before, and restored under a fresh
   * `operationId = caseId` the ledger's UNIQUE key never saw either. The fence
   * cannot help: every round is a legitimately planned restore whose expected
   * equals its actual.
   *
   * So the quota is checked per child, against the very ids `caseFor` will
   * bind, BEFORE the batch — the fan-out stays all-or-nothing. It is also the
   * shape a later per-component-return flag needs.
   */
  const quotaTargets: Array<{ id: string; qty: number }> =
    bundleChildren.length > 0
      ? bundleChildren.map((k) => ({ id: String(k.id), qty: childCaseQty(k) }))
      : [{ id: orderItemId, qty }];
  const orderedQty = new Map<string, number>(
    bundleChildren.length > 0
      ? bundleChildren.map((k) => [String(k.id), Number(k.qty) || 1])
      : [[orderItemId, Number(item.item_qty)]]
  );
  /**
   * WHAT ACTUALLY SPENDS A ROW'S RETURN QUOTA.
   *
   * A case that ended in a REFUND consumed the row: the goods went back and
   * the money came back, so that unit is not returnable again. A case resolved
   * as `repair` or `replacement` — the two warranty remedies the component
   * defect carve-out of decision 3 exists to reach — moved no money and
   * returned no goods; the customer still owns the unit. `declined` returned
   * nothing either. Counting those would let ONE fault report spend the
   * bundle's return right for ever: report a crushed spool on day 2, have it
   * replaced on day 3, and the whole-bundle return on day 4 is refused because
   * that child's quota reads as spent.
   *
   * An OPEN case (resolution IS NULL) still holds its quota, because it may
   * yet end in a refund — that is a reservation, not a consumption.
   */
  const usedByItem = new Map<string, number>();
  // Chunked: a legal bundle may carry ~249 components (§3.1), which is more
  // bound parameters than D1 accepts in one query.
  for (const part of chunk(quotaTargets.map((t) => t.id), IN_CHUNK)) {
    const { results } = await c.env.DB.prepare(
      `SELECT order_item_id AS id, COALESCE(SUM(qty), 0) AS n
         FROM return_cases
        WHERE state <> 'rejected'
          AND (resolution IS NULL OR resolution = 'refund')
          AND order_item_id IN (${part.map(() => '?').join(',')})
        GROUP BY order_item_id`
    )
      .bind(...part)
      .all<{ id: string; n: number }>();
    for (const r of results) usedByItem.set(String(r.id), Number(r.n) || 0);
  }
  const overCap = quotaTargets.filter((t) => (usedByItem.get(t.id) ?? 0) + t.qty > (orderedQty.get(t.id) ?? 0));
  if (overCap.length > 0) {
    // WHICH ROWS ARE FULL DECIDES WHICH ANSWER IS TRUE. On a whole-bundle
    // return the quota targets are the CHILDREN, so there are two very
    // different situations behind one failure:
    //
    //   every child full  → this bundle has already been returned. QTY_EXCEEDED
    //                       is exactly right and stays.
    //   only some full    → a part was claimed on its own (the defect carve-out
    //                       of decision 3), and the customer is being told the
    //                       quantity of a bundle they have not returned is
    //                       exceeded. Name the part instead.
    if (bundleChildren.length > 0 && overCap.length < quotaTargets.length) {
      const part = bundleChildren.find((k) => String(k.id) === overCap[0].id);
      // Say what is true and nothing more. The old sentence promised the rest
      // "can still be returned individually", which the reason gate refuses
      // for a commercial return — the carve-out is for FAULTS only.
      throw badRequest(
        `One part of this bundle (${part?.name_snapshot ?? overCap[0].id}) has already been claimed, so the bundle can no longer be returned as a whole. A fault on any remaining part can still be reported on its own.`,
        'BUNDLE_COMPONENT_ALREADY_CLAIMED',
        { order_item_id: overCap[0].id }
      );
    }
    throw badRequest('The requested quantity exceeds what remains returnable for this item', 'QTY_EXCEEDED');
  }

  const nowIso = new Date(now).toISOString();
  const caseFor = (targetItemId: string, caseQty: number) => {
    const caseId = newId('ret');
    return {
      id: caseId,
      statement: c.env.DB.prepare(
        `INSERT INTO return_cases (id, order_id, order_item_id, unit_id, user_id, qty, reason, description,
           evidence, requested_at, delivered_at_snapshot, within_window, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'requested')`
      ).bind(
        caseId,
        item.order_id,
        targetItemId,
        targetItemId === orderItemId ? unitId || null : null,
        user.id,
        caseQty,
        reason,
        description,
        JSON.stringify(evidence),
        nowIso,
        deliveredAt
      ),
    };
  };

  // A BUNDLE OPENS ONE CASE PER COMPONENT, IN ONE BATCH. The parent row is
  // priced but holds nothing physical, so a case against it could restore no
  // stock and refund from no allocation; the components are what came in the
  // box. All of them commit together, so a bundle can never end up half
  // returned because the second insert failed.
  const bundleReturn = bundleChildren.length > 0;
  const cases = bundleReturn
    ? bundleChildren.map((k) => caseFor(k.id, childCaseQty(k)))
    : [caseFor(orderItemId, qty)];
  const id = cases[0].id;
  await c.env.DB.batch(cases.map((k) => k.statement));

  await audit(c.env.DB, user.id, 'return.request', id, { order_id: item.order_id, order_item_id: orderItemId, qty, reason });
  /**
   * THE GROUP HEARS ABOUT IT IN THE QUEUE THE ORDER BELONGS TO.
   *
   * This said `'orders'`, a key the owner's group has no topic for: it has
   * «Orders pre-order» and «Orders direct». A return against a pre-order is a
   * supplier conversation weeks long; a return against a direct sale is a
   * courier collection this week. `item.shipping_type` is the order's own
   * column, already selected above for the open-box rules, so the split costs
   * no extra read and cannot disagree with how the order was priced.
   *
   * `announceToAdmins` rather than the bare router: this is handed to
   * `waitUntil`, and a D1 blip while resolving the topic would otherwise be an
   * unhandled rejection on a return the customer successfully opened.
   */
  announceAfterResponse(
    c,
    orderTopic(item.shipping_type),
    `↩️ Return request ${id}\nOrder: ${item.order_id}\nItem: ${item.name_snapshot} × ${qty}\nReason: ${reason}`
  );

  const row = await c.env.DB.prepare('SELECT * FROM return_cases WHERE id = ?').bind(id).first<ReturnCaseRow>();
  // A whole-bundle return answers with every case it opened, so the screen can
  // say "3 cases opened for Bundle X" instead of showing one and hiding two.
  if (bundleReturn) {
    // Chunked (§3.1): one placeholder per component, and a legal bundle may
    // carry ~249 of them — more bound parameters than D1 accepts per query.
    const rows: ReturnCaseRow[] = [];
    for (const part of chunk(cases.map((k) => k.id), IN_CHUNK)) {
      const { results } = await c.env.DB.prepare(
        // Ordered by insertion, so the cases come back in the order the box was
        // packed rather than in whatever order the index answered.
        `SELECT * FROM return_cases WHERE id IN (${part.map(() => '?').join(',')}) ORDER BY rowid`
      )
        .bind(...part)
        .all<ReturnCaseRow>();
      rows.push(...results);
    }
    return c.json({
      success: true,
      case: casePublic(row!),
      bundle: { parent_item_id: orderItemId, name: item.name_snapshot },
      cases: rows.map((r) => casePublic(r)),
    });
  }
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
      `SELECT id, product_id, qty, unit_price_iqd, pricing_snapshot, warranty_snapshot, transport_snapshot,
              bundle_parent_item_id, component_value_iqd, component_alloc_iqd
         FROM order_items WHERE id = ?`
    )
      .bind(kase.order_item_id)
      .first<Record<string, unknown>>();
    const order = await c.env.DB.prepare(
      'SELECT id, user_id, subtotal_iqd, shipping_iqd, points_discount_iqd, coupon_snapshot, exchange_rate, gini_paid_iqd FROM orders WHERE id = ?'
    )
      .bind(kase.order_id)
      .first<Record<string, unknown>>();
    if (item && order) {
      // Refund the paid amount for the returned qty, net of this line's
      // proportional share of order-level discounts. Shipping is NOT
      // refunded (owner decision pending — row 8).
      //
      // A BUNDLE COMPONENT IS PRICED OFF ITS STORED ALLOCATION, NOT OFF
      // `unit_price_iqd` (§6.4). §6.2 pins a component's `unit_price_iqd` to 0
      // — the money is on the parent — so the old formula would refund 0 IQD
      // for every component case and reverse no points beside it. Substituting
      // `component_alloc_iqd` naively would OVER-refund instead, because the
      // formula still has to subtract this line's proportional share of coupon
      // and points and `Σ component_alloc_iqd` is the parent's GROSS line
      // total. So the allocation becomes the gross, scaled by the returned
      // fraction of the row, and everything after it is unchanged.
      const itemQty = Math.max(1, Number(item.qty) || 1);
      const storedAlloc = item.component_alloc_iqd === null || item.component_alloc_iqd === undefined
        ? null
        : Number(item.component_alloc_iqd) || 0;
      const caseGross =
        storedAlloc !== null
          ? Math.floor((storedAlloc * kase.qty) / itemQty)
          : (Number(item.unit_price_iqd) || 0) * kase.qty;
      const coupon = safeParse<{ discount_iqd?: number } | null>(order.coupon_snapshot as string | null, null);
      const discounts = (coupon ? Number(coupon.discount_iqd) || 0 : 0) + (Number(order.points_discount_iqd) || 0);
      const base = (Number(order.subtotal_iqd) || 0) + (Number(order.shipping_iqd) || 0);
      const alloc = base > 0 ? Math.floor((discounts * caseGross) / base) : 0;
      const refundIqd = Math.max(0, caseGross - alloc);

      // WE MAY ONLY GIVE BACK MONEY WE ACTUALLY TOOK.
      //
      // On a Gini order the goods were settled inside the bank's app before
      // this order existed and `gini_paid_iqd` is the record of it; the only
      // dinar that ever reached Levonis is the delivery fee at the door, and
      // shipping is not refunded here anyway. Crediting `refundIqd` to the
      // Levo wallet would therefore mint spendable balance out of nothing —
      // ~894,000 IQD on the 899,000 printer — while the customer's
      // instalments to Rafidain carry on untouched.
      //
      // This is the same invariant `levonisCollectibleSql` (worker/lib/gini.ts)
      // and `sweepGiniHolds` already state: the correction is on OUR side of
      // the split, never on Gini's, and «the cancellation of an order we never
      // collected for is not ours to reverse».
      //
      // The customer is still owed the money — they really did pay the bank —
      // so the amount is not clamped away silently. `refundIqd` stays in
      // `refundResult`, in the audit row and on the case's own note as
      // `gini_refund_due_iqd`, so the admin resolving the case can see that a
      // Gini-side reversal has to be arranged with the bank. There is no
      // integration to do it for us and inventing one here would be a lie.
      const giniPaidIqd = Math.max(0, Math.trunc(Number(order.gini_paid_iqd) || 0));
      const settledByGini = giniPaidIqd > 0;
      const walletRefundIqd = settledByGini ? 0 : refundIqd;
      const rate = Math.trunc(Number(order.exchange_rate)) || 1400; // the ORDER's historical rate
      // THE REFUNDED DINARS ARE THE DINARS THE CUSTOMER SEES (migration 0108).
      // `Math.round` over the order's rate turned a 50,000 د.ع return into
      // 3,571 cents and recorded nothing else, so the wallet showed «+49,994»
      // for a refund of 50,000. The cents are floored — never more cents than
      // the dinars are worth — and the dinars ride beside them at the rate
      // they were converted at, so the credit reads exactly `walletRefundIqd`.
      const cents = Math.floor((walletRefundIqd * 100) / rate);

      let credited = false;
      if (cents > 0) {
        const ledgerDinars = await walletLedgerDinarsReady(c.env.DB);
        try {
          await walletCreditStatement(c.env.DB, ledgerDinars, {
            id: `wtx_ret_${id}`,
            userId: kase.user_id,
            cents,
            note: `Refund for approved return ${id} (order ${kase.order_id})`,
            ref: kase.order_id,
            nowIso,
            amountIqd: walletRefundIqd,
            rate,
          }).run();
          credited = true;
          // `RefundCompleted` (03-EVENTS.md §3.11) — keyed on the same
          // deterministic ledger id, so a redelivery is a replay everywhere.
          if (eventsEnabled(c.env)) {
            await emitFromRequest(
              c,
              RefundCompletedV1,
              {
                ref_type: 'return',
                ref_id: id,
                user_id: kase.user_id,
                usd_cents: cents,
                points: 0,
                ledger_tx_ids: [`wtx_ret_${id}`],
                event_key: `wtx_ret_${id}`,
              },
              { aggregateId: kase.user_id, actorId: admin.id }
            );
          }
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
        channel: settledByGini ? 'gini' : 'wallet',
        ...(settledByGini
          ? { gini_paid_iqd: giniPaidIqd, gini_refund_due_iqd: refundIqd }
          : {}),
        channel_note: settledByGini
          ? `This order's goods were settled inside the Gini app (${giniPaidIqd} IQD), not collected by Levonis, so no Levo wallet credit was posted. The customer is owed ${refundIqd} IQD on the Gini/Rafidain side — arrange the instalment reversal with the bank; Levonis has no integration that can do it. Shipping fees are not refunded here.`
          : 'Refund destination is a configurable default pending the owner decision (docs/DECISIONS.md row 8); shipping fees are not refunded here.',
      };

      // The case itself has to carry it too, not just this one response: the
      // queue is where a second member of staff picks the case up, and a
      // pending bank-side refund that lives only in an HTTP response nobody
      // kept is a customer left out of pocket.
      if (settledByGini && refundIqd > 0) {
        const giniNote = `[GINI] No wallet credit — goods settled in the Gini app. ${refundIqd} IQD is owed to the customer through Gini/Rafidain and must be arranged with the bank.`;
        await c.env.DB.prepare(
          `UPDATE return_cases
              SET admin_note = CASE WHEN COALESCE(admin_note, '') = '' THEN ?1 ELSE admin_note || char(10) || ?1 END
            WHERE id = ?2 AND COALESCE(admin_note, '') NOT LIKE '%[GINI]%'`
        )
          .bind(giniNote, id)
          .run();
      }

      // Proportional purchase-points reversal for the refunded merchandise
      // portion (idempotent per case; never double-reverses).
      //
      // A component is fed THE SAME `caseGross`: `unitMerchandiseIqd` prefers
      // `pricing_snapshot.applied_iqd`, which §6.2 pins to 0 on a component, so
      // reading it here would reverse nothing at all for a returned bundle
      // while the wallet was credited in full.
      const merchandisePortion =
        storedAlloc !== null
          ? caseGross
          : unitMerchandiseIqd({
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
      // conditional flip above guarantees this branch runs a single time) —
      // THROUGH THE LEDGER, onto the rows the units were actually deducted
      // from. The raw `UPDATE products SET stock = stock + ?` this replaces
      // wrote no ledger row, emitted no InventoryChanged, and always credited
      // the BASE row: already wrong for every OPTION / COLOR /
      // VARIANT_COMBINATION product. The restore carries its own fence row
      // (§3.3), so a guard that matched nothing rolls the credit back with it
      // instead of recording a movement that never happened.
      const restoreMoves = await restoreMovesForItem(c.env.DB, kase.order_id, kase.order_item_id, kase.qty);
      if (restoreMoves.length) {
        const restorePlan = await planInventory(c.env.DB, restoreMoves, {
          kind: 'restore',
          operationId: id,
          orderId: kase.order_id,
          actorUserId: admin.id,
          reason: 'return',
        });
        restorePlan.statements.push(
          await planReservationFence(c.env.DB, kase.order_id, 'restore', restorePlan.plannedLedgerRows)
        );
        if (restorePlan.statements.length) await c.env.DB.batch(restorePlan.statements);
        pumpAfter(c.env.DB, restorePlan.eventIds, waitUntilFrom(c));
      }
    }
  }

  await audit(c.env.DB, admin.id, 'return.transition', id, {
    from, to, resolution, reason,
    refund: refundResult
      ? {
          amount_iqd: refundResult.amount_iqd,
          credited: refundResult.credited,
          channel: refundResult.channel,
          // Stamped in the audit trail as well: this is the number staff need
          // months later when the bank asks what Levonis reversed and what it
          // did not.
          gini_refund_due_iqd: refundResult.gini_refund_due_iqd ?? 0,
        }
      : null,
  });

  const row = await c.env.DB.prepare('SELECT * FROM return_cases WHERE id = ?').bind(id).first<ReturnCaseRow>();
  return c.json({
    success: true,
    case: casePublic(row!),
    ...(refundResult ? { refund: refundResult } : {}),
    ...(pointsResult ? { points_reversal: pointsResult } : {}),
  });
});

/**
 * WHICH BUNDLE THIS CASE BELONGS TO, and what else came in the same box (§6.4).
 *
 * Staff assessing a returned component need to see "1 of 3 items in Bundle X"
 * and its siblings, or they are looking at a spool with no idea it arrived as
 * part of a printer bundle whose other parts may be on their way back too.
 * Three independent answers to "which physical components belong to this
 * bundle" are stored; this is the cheapest — one indexed read on
 * `idx_order_items_bundle_parent`.
 */
async function bundleGroupFor(db: D1Database, orderItemId: string) {
  const parent = await db
    .prepare(
      `SELECT p.id, p.name_snapshot, p.qty, p.line_total_iqd
         FROM order_items c JOIN order_items p ON p.id = c.bundle_parent_item_id
        WHERE c.id = ?`
    )
    .bind(orderItemId)
    .first<{ id: string; name_snapshot: string; qty: number; line_total_iqd: number }>();
  if (!parent) return null;
  const { results: siblings } = await db
    .prepare(
      `SELECT id, name_snapshot, option_snapshot, qty, component_alloc_iqd
         FROM order_items WHERE bundle_parent_item_id = ? ORDER BY rowid`
    )
    .bind(parent.id)
    .all<Record<string, unknown>>();
  return {
    parent_item_id: parent.id,
    name: parent.name_snapshot,
    qty: parent.qty,
    line_total_iqd: parent.line_total_iqd,
    position: siblings.findIndex((k) => String(k.id) === orderItemId) + 1,
    of: siblings.length,
    components: siblings.map((k) => ({
      order_item_id: k.id,
      name: k.name_snapshot,
      variant: k.option_snapshot,
      qty: k.qty,
      alloc_iqd: k.component_alloc_iqd ?? null,
    })),
  };
}

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
  const bundle = await bundleGroupFor(c.env.DB, row.order_item_id);
  return c.json({
    success: true,
    case: casePublic(row, {
      item: { name: row.name_snapshot, image: row.image_snapshot, variant: row.option_snapshot },
      ...(bundle ? { bundle } : {}),
    }),
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
    // `o.shipping_type` is read for ONE reason: the admin notification below
    // has to land in the pre-order queue or the direct queue, and it must use
    // the order's own stored type rather than guess from the claim.
    `SELECT oi.*, o.user_id AS owner_id, o.status, o.delivered_at, o.shipping_type
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

  // A BUNDLE PARENT IS NOT PRICE-PROTECTED, AND IS TOLD SO (§6.4).
  // `order_items.option_id` on a parent is the `bx_…` composition key, which
  // matches no `price_history.variant_key`, so a claim on it could only ever
  // end in a misleading `NO_ELIGIBLE_DROP` — "we looked and found nothing" for
  // a comparison that was never possible. The parts ARE covered, individually,
  // off their own stored `component_value_iqd`.
  const isBundleParent = await c.env.DB
    .prepare('SELECT 1 AS x FROM order_items WHERE bundle_parent_item_id = ? LIMIT 1')
    .bind(orderItemId)
    .first<{ x: number }>();
  if (isBundleParent) {
    throw badRequest(
      "A bundle is not price-protected as a whole — the bundle's parts are covered individually",
      'COMPOSITION_NOT_ELIGIBLE'
    );
  }
  // A MYSTERY SPOOL IS NOT PRICE-PROTECTED EITHER, and for a sharper reason:
  // its `component_value_iqd` is an OFFER-DERIVED share, not the drawn item's
  // ladder (§6.2), so a comparison against `price_history` is not merely
  // impossible — answering it at all would reveal what the spool actually is
  // (§8.2 row 19).
  const isMysterySpool = await c.env.DB
    .prepare('SELECT 1 AS x FROM mystery_allocations WHERE order_item_id = ? LIMIT 1')
    .bind(orderItemId)
    .first<{ x: number }>();
  if (isMysterySpool) {
    throw badRequest(
      'A mystery offer is not price-protected — its price is the offer price, not the item drawn',
      'COMPOSITION_NOT_ELIGIBLE'
    );
  }

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
  // A BUNDLE COMPONENT'S ORIGINAL UNIT PRICE IS ITS SHARE OF WHAT WAS PAID.
  //
  // §6.2 pins a component's `pricing_snapshot.applied_iqd` to 0 — the money is
  // on the parent — so reading that would make `perUnitDrop` 0 and every claim
  // a misleading `NO_ELIGIBLE_DROP`. But the obvious substitute,
  // `component_value_iqd`, is the UNDISCOUNTED standalone catalogue value, a
  // number the customer never paid: on a bundle whose parts are worth 425,000
  // and which sold for 200,000, a component pinned at 400,000 could be credited
  // 380,000 — 1.9× what was paid for it and 1.9× the price of the whole order,
  // with the goods kept. Every other price-protection path compares against
  // what was actually charged (`pricing_snapshot.applied_iqd`), and this one now
  // does too: `component_alloc_iqd` is the component's share of the bundle
  // price, the same stored figure §6.4 already designates as the refund basis,
  // so a refund and a price-protection credit cannot disagree about what one
  // component cost. `component_value_iqd` stays in `policy_snapshot` as the
  // provenance of the comparison, never as its ceiling.
  const componentQty = Math.max(1, Number(item.qty) || 1);
  const componentAlloc =
    item.component_alloc_iqd === null || item.component_alloc_iqd === undefined
      ? null
      : Math.max(0, Number(item.component_alloc_iqd) || 0);
  const componentValue =
    item.component_value_iqd === null || item.component_value_iqd === undefined
      ? null
      : Number(item.component_value_iqd) || 0;
  const componentPaidUnit =
    componentAlloc !== null ? Math.floor(componentAlloc / componentQty) : componentValue;
  const originalUnit =
    componentPaidUnit !== null
      ? componentPaidUnit
      : pricing && Number.isInteger(pricing.applied_iqd)
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
  // THE COMPARISON PRICE IS THE ONE A BUYER WOULD PAY TODAY, so the product is
  // read the way the cart reads it: the relational option/colour rows win over
  // the JSON mirrors on `products`. This claim decides a real credit — reading
  // the other store would compare the customer's paid price against a number
  // nobody is charged, and refuse or grant money on it.
  const relations = await loadRelationsView(c.env.DB, String(productRow.id), productRow.inventory_mode);
  const doc = relations ? applyRelations(parseProductRow(productRow), relations) : parseProductRow(productRow);
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
    component_value_iqd: componentValue,
    component_alloc_iqd: componentAlloc,
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
  // Same split, same reason as the return above: a claim belongs beside the
  // order it is about, not in a mixed feed the owner has already stopped
  // reading. Contained, because it runs after the claim row has committed.
  announceAfterResponse(
    c,
    orderTopic(item.shipping_type),
    `🛡️ Price-protection claim ${id}\nItem: ${String(item.name_snapshot)}\nDrop: ${perUnitDrop.toLocaleString()} IQD × ${qty}`
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
  const rate = Math.trunc(Number(order?.exchange_rate)) || 1400;
  // Floored, with the credited dinars recorded beside the cents (0108) — the
  // same rule as the return refund above, so the customer reads exactly the
  // compensation that was approved, not its cents converted back.
  const cents = Math.floor((credit * 100) / rate);

  let credited = false;
  if (cents > 0) {
    const ledgerDinars = await walletLedgerDinarsReady(c.env.DB);
    try {
      await walletCreditStatement(c.env.DB, ledgerDinars, {
        id: `wtx_pp_${id}`,
        userId: claim.user_id,
        cents,
        note: `Price-protection credit for claim ${id} (order ${claim.order_id})`,
        ref: claim.order_id,
        nowIso,
        amountIqd: credit,
        rate,
      }).run();
      credited = true;
      if (eventsEnabled(c.env)) {
        await emitFromRequest(
          c,
          RefundCompletedV1,
          {
            ref_type: 'price_protection',
            ref_id: id,
            user_id: claim.user_id,
            usd_cents: cents,
            points: 0,
            ledger_tx_ids: [`wtx_pp_${id}`],
            event_key: `wtx_pp_${id}`,
          },
          { aggregateId: claim.user_id, actorId: admin.id }
        );
      }
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
