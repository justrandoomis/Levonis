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
 *  - The drop is computed SERVER-SIDE for the same product/option/color, the
 *    channel the line was priced on and the price class the buyer actually
 *    had (pricing_snapshot.applied_tier), from the price rows of the rung
 *    that prices the line (worker/lib/protectionClaims.ts; Services V2
 *    PP-B2/B3/B4): a regular buyer is never compared against a member price,
 *    a member is compared with their own class's price, a pre-order with its
 *    own route, and a model with its own price never with the base price.
 *  - Cumulative cap: total credits for one item can never exceed the eligible
 *    difference; repeated drops/claims deduct prior credits.
 *  - NO automatic payout: a financial-scope admin approves or declines (with
 *    a reason the customer reads); approval credits the Levo wallet
 *    idempotently (wtx_pp_<claimId>; the wallet is the owner's choice, row
 *    223). The customer's bell row is written in the decision's own batch.
 */

import { listing } from '../lib/listing';
import { applyReturnSerials, returnedUnits, serialAssignmentsInstalled } from '../lib/serialAssignments';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { safeParse } from '../lib/types';
import { requireAuth, requireAdmin, badRequest, conflict, notFound, int, str, oneOf, HttpError } from '../lib/http';
import { newId } from '../lib/crypto';
import { audit, auditStatements } from '../lib/audit';
import { emitFromRequest, eventsEnabled } from '../lib/eventBus';
import { RefundCompletedV1 } from '@levonis/contracts/events/v1/RefundCompleted';
import { rateLimit } from '../lib/ratelimit';
import { parseProductRow } from '../lib/productModel';
import { resolveUnitPrice } from '../lib/pricing';
import { applyRelations, loadRelationsView } from '../lib/productOverlay';
import { reversePointsForOrder, unitMerchandiseIqd } from '../lib/pointsOps';
import { walletCreditStatement } from '../lib/wallet';
import { walletLedgerDinarsReady } from '../lib/walletOps';
import { planInventory, planReservationFence, chunk, IN_CHUNK } from '../lib/inventory';
import { restoreMovesForItem } from '../lib/orderInventory';
import { planLotRestore } from '../lib/inventoryLots';
import { resolveReturnedOriginIds, planUnsellableOriginReturn, type ReturnedOriginSelection, unitOriginsInstalled } from '../lib/inventoryUnitOrigins';
import { operationsInstalled, baghdadDay } from '../lib/operations';
import { recordReturnFinancials, recordFinancialFailure } from '../lib/orderFinance';
import { calculateGoods, spread, type GoodsLine } from '../lib/orderProfit';
import { paidNetUnit } from '../lib/paidNet';
import { validateInvestorReturnEvidence } from '../lib/investorFinance';
import { isRevealed, loadAllocations, paidOrderIds } from '../lib/mysteryReveal';
import { mysteryRefusal } from '../lib/mystery/issues';
import { typeForTransport } from '../lib/shippingType';
import { pumpAfter, waitUntilFrom } from '../lib/eventBus';
import { announceAfterResponse, orderTopic } from '../lib/adminTopicRouting';
import { parseConditionDoc, returnRefusal } from '../lib/condition';
import { channelOfLine } from '../lib/pricingEngine/orderBasis';
import { claimBasis, engineCombosOf, engineObservations, takesUsdBaseRule, usdIqdInForceAt } from '../lib/pricingEngine/protectionBasis';
import { CONDITION_DOC_DEFAULT_SQL, isConditionColumnMissing } from '../lib/conditionProjection';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { PRICE_PROTECTION_OWNER_LINE_IQD } from '../../packages/contracts/src/moneyAuthority';
import { assertMoneyAuthority, requireMoneyAuthority } from '../lib/moneyAuthority';
import { canMoveMoney, isOwner } from '../lib/adminScope';
import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { closedClaimSql } from '../lib/deviceOps';
import { returnWinsStatements, tradedUnitsSql, tradeInInstalled, tradeInsOnLine } from '../lib/tradeIn';
import { tradeInV2Installed } from '../lib/tradeInSchema';
import { completeTradeInsForOrder } from '../lib/tradeInStock';
import { reissueEndsAt, returnReissueStatements, tradeInCreditOf } from '../lib/tradeInReissue';
import { inShopOnLine, inShopSlotsSql } from '../lib/services/myDevices';
import { loadPricingContext, memberFallbackFor } from './cart';
import {
  CHANNEL_CLOSED_ERRORS,
  buyerClassOf,
  claimForCustomer,
  claimForStaff,
  creditedNotice,
  historyFieldsOf,
  historyKeysOf,
  itemLabel,
  lineChannelOf,
  rejectedNotice,
  tierOfClass,
} from '../lib/protectionClaims';
import { PRICE_PROTECTION_NOTICES, PRICE_PROTECTION_REASON_CODES } from '../../packages/contracts/src/priceProtection';
import { notifyCustomer } from '../lib/customerNotify';
import type { EmailLang } from '../lib/emailTemplates';

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

/**
 * An OPEN warranty claim on what a NEW return case covers: the device it
 * names (`?1` = the unit id), or every device of its lines and a legacy claim
 * filed on one of them (`?1` = the line ids, JSON). One predicate for the
 * read, the in-batch fence and the honest refusal after an abort.
 */
function openClaimOnCaseSql(byUnit: boolean): string {
  return byUnit
    ? `EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.unit_id = ?1 AND NOT ${closedClaimSql('wc')})`
    : `EXISTS (SELECT 1 FROM warranty_claims wc
         WHERE (wc.unit_id IN (SELECT id FROM order_item_units WHERE order_item_id IN (SELECT value FROM json_each(?1)))
                OR (wc.unit_id IS NULL AND wc.order_item_id IN (SELECT value FROM json_each(?1))))
           AND NOT ${closedClaimSql('wc')})`;
}

/**
 * ONE DOOR PER DEFECT, COUNTED (review R2). A case that names NO device (the
 * customer's return screen never names one) collides with the repair desk
 * only when it cannot be another device of the line: a legacy claim filed on
 * the line itself, or the devices on the repair desk (one per slot), the
 * units the line's cases already hold or were refunded (this case included
 * once it is written) and `?` more together exceeding the line — the same
 * count the door applies to trade-ins. Positional binds, in order: the line
 * id four times, then the extra units.
 */
function lineCaseClaimSql(): string {
  const open = `NOT ${closedClaimSql('wc')}`;
  return `(EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.unit_id IS NULL AND wc.order_item_id = ? AND ${open})
    OR (SELECT COUNT(DISTINCT u.unit_index) FROM warranty_claims wc JOIN order_item_units u ON u.id = wc.unit_id
         WHERE u.order_item_id = ? AND ${open})
       + (SELECT COALESCE(SUM(rc.qty), 0) FROM return_cases rc
           WHERE rc.order_item_id = ? AND rc.state <> 'rejected' AND (rc.resolution IS NULL OR rc.resolution = 'refund'))
       + ? > (SELECT qty FROM order_items WHERE id = ?))`;
}
const lineCaseClaimBinds = (line: string, extra: number): unknown[] => [line, line, line, extra, line];

/**
 * An open warranty claim a case's REFUND would collide with: the device it
 * names, or — for a case naming none — the count rule above (the case itself
 * already counted). Positional binds.
 */
function refundClaimSql(kase: { unit_id?: string | null; order_item_id: string }): { sql: string; binds: unknown[] } {
  return kase.unit_id
    ? { sql: `EXISTS (SELECT 1 FROM warranty_claims wc WHERE wc.unit_id = ? AND NOT ${closedClaimSql('wc')})`, binds: [kase.unit_id] }
    : { sql: lineCaseClaimSql(), binds: lineCaseClaimBinds(kase.order_item_id, 0) };
}

/**
 * Would refunding this case take back a device a trade-in holds? A case that
 * names its device: is it in a traded slot. One that does not: do the traded
 * slots, the units already refunded and this case add up to more than the
 * line holds.
 */
async function refundTakesTradedUnit(db: D1Database, kase: Pick<ReturnCaseRow, 'id' | 'order_item_id' | 'unit_id' | 'qty'>): Promise<boolean> {
  const tradeIns = await tradeInsOnLine(db, kase.order_item_id);
  if (!tradeIns.length) return false;
  if (kase.unit_id) return tradeIns.some((t) => t.unitIds.includes(kase.unit_id!));
  const [line, refunded] = await Promise.all([
    db.prepare('SELECT qty FROM order_items WHERE id = ?').bind(kase.order_item_id).first<{ qty: number }>(),
    db
      .prepare("SELECT COALESCE(SUM(qty), 0) AS n FROM return_cases WHERE order_item_id = ? AND id <> ? AND state = 'resolved' AND resolution = 'refund'")
      .bind(kase.order_item_id, kase.id)
      .first<{ n: number }>(),
  ]);
  const traded = tradeIns.reduce((n, t) => n + t.units, 0);
  return traded + (Number(refunded?.n) || 0) + (Number(kase.qty) || 1) > (Number(line?.qty) || 1);
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

  // ---- ONE MONEY PROCESS PER UNIT (Services V2 plan §1.3) -----------------
  // A device on the repair desk is handled there — one door per defect: an
  // open warranty request refuses a return of the same device (the team
  // turns it into a return when that is the remedy).
  // The device the case names, or every device of the lines it covers.
  const claimScope = { unitId: unitId || null, lineIds: JSON.stringify(quotaTargets.map((t) => t.id)) };
  // A single line's case that names no device is judged by the count rule
  // (review R2): a return of one printer while the other is on the repair
  // desk is not the same device. A bundle keeps the whole-line rule.
  const countedLine = !claimScope.unitId && bundleChildren.length === 0;
  const warrantyClaimOpen = () =>
    conflict('This device has an open warranty request. Follow it from Warranty & maintenance; our team turns it into a return if needed.', 'WARRANTY_CLAIM_OPEN');
  const claimOpenNow = countedLine
    ? await c.env.DB.prepare(`SELECT ${lineCaseClaimSql()} AS open`).bind(...lineCaseClaimBinds(orderItemId, qty)).first<{ open: number }>()
    : await c.env.DB.prepare(`SELECT ${openClaimOnCaseSql(!!claimScope.unitId)} AS open`)
        .bind(claimScope.unitId ?? claimScope.lineIds)
        .first<{ open: number }>();
  if (claimOpenNow?.open) throw warrantyClaimOpen();
  // A trade-in of the same device: before its credit is spent, THE RETURN
  // WINS and the trade-in is cancelled in the same batch as the case; once a
  // live order holds the credit, or the exchange is complete, the return is
  // refused here (support decides). Trade-ins never take a bundle line.
  const tradeInCancels: Array<Awaited<ReturnType<typeof tradeInsOnLine>>[number]> = [];
  if (!bundleChildren.length) {
    const tradeIns = await tradeInsOnLine(c.env.DB, orderItemId);
    const traded = tradeIns.reduce((n, t) => n + t.units, 0);
    const affected = unitId
      ? tradeIns.filter((t) => t.unitIds.includes(unitId))
      : traded + (usedByItem.get(orderItemId) ?? 0) + qty > Number(item.item_qty)
        ? tradeIns
        : [];
    if (affected.some((t) => t.committed)) {
      throw conflict('This device is part of a trade-in whose credit is in use or which is complete, so it cannot be returned here. Contact support.', 'TRADE_IN_ACTIVE');
    }
    tradeInCancels.push(...affected);
  }
  // S-P2 (§1.3, §6.14): a device a trade-in RECEIVED is with the shop until it is handed back —
  // even after that request was cancelled or declined. Asked again inside the batch (below).
  const inShop = bundleChildren.length ? { unitIds: [], slots: 0 } : await inShopOnLine(c.env.DB, orderItemId);
  if (inShop.slots > 0) {
    const held = unitId ? inShop.unitIds.includes(unitId) : inShop.slots + (usedByItem.get(orderItemId) ?? 0) + qty > Number(item.item_qty);
    if (held) throw conflict('This device is part of a trade-in whose credit is in use or which is complete, so it cannot be returned here. Contact support.', 'TRADE_IN_ACTIVE');
  }

  const nowIso = new Date(now).toISOString();
  const caseFor = (targetItemId: string, caseQty: number) => {
    const caseId = newId('ret');
    const caseUnit = targetItemId === orderItemId ? unitId || null : null;
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
        caseUnit,
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
  const cancels = (await Promise.all(tradeInCancels.map((t) => returnWinsStatements(c.env.DB, t.request, user.id, id, nowIso)))).flat();
  /**
   * ONE DOOR PER DEFECT, INSIDE THE BATCH (plan §1.3): the read above asked
   * again after the case is written — a warranty request opened in between
   * turns the first case's quantity negative, the table's CHECK (qty > 0)
   * aborts the whole batch, and nothing is written; otherwise it touches no
   * row. One statement whatever the bundle's size.
   */
  const claimFence = countedLine
    ? c.env.DB.prepare(`UPDATE return_cases SET qty = -1 WHERE id = ? AND ${lineCaseClaimSql()}`).bind(id, ...lineCaseClaimBinds(orderItemId, 0))
    : c.env.DB.prepare(
        `UPDATE return_cases SET qty = -1 WHERE id = ?2 AND ${openClaimOnCaseSql(!!claimScope.unitId)}`
      ).bind(claimScope.unitId ?? claimScope.lineIds, id);
  // An intake recorded between the read above and this batch turns the case's quantity negative.
  const inShopFence = !bundleChildren.length && (await tradeInV2Installed(c.env.DB))
    ? [c.env.DB.prepare(`UPDATE return_cases SET qty = -1 WHERE id = ? AND ${inShopSlotsSql} <> ?`).bind(id, orderItemId, inShop.slots)]
    : [];
  try {
    await c.env.DB.batch([...cases.map((k) => k.statement), claimFence, ...inShopFence, ...cancels]);
  } catch (e) {
    if (!/NOT NULL|constraint/i.test(e instanceof Error ? e.message : String(e))) throw e;
    // Nothing was written. A warranty request opened on the device meanwhile:
    // the repair desk has it. Otherwise a trade-in moved (its credit spent, or
    // cancelled by its owner): try again.
    const open = countedLine
      ? await c.env.DB.prepare(`SELECT ${lineCaseClaimSql()} AS open`).bind(...lineCaseClaimBinds(orderItemId, qty)).first<{ open: number }>()
      : await c.env.DB.prepare(`SELECT ${openClaimOnCaseSql(!!claimScope.unitId)} AS open`)
          .bind(claimScope.unitId ?? claimScope.lineIds)
          .first<{ open: number }>();
    if (open?.open) throw warrantyClaimOpen();
    if (cancels.length) {
      throw conflict('The trade-in on this device changed while the return was being opened. Refresh and try again.', 'TRADE_IN_STALE');
    }
    throw e;
  }

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
  // A REFUND MOVES MONEY (owner decision 3, PP-B1): an assistant moves the
  // case through collection and inspection, never to a refund. The amount is
  // the server's own (what was paid), so a financial admin refunds it in full.
  // Never the approver's own refund (a conflict of interest: the owner, with a reason).
  const refundGrant = to === 'resolved' && resolution === 'refund'
    ? assertMoneyAuthority(c, { act: 'return_refund', beneficiaryUserId: kase.user_id, reason })
    : null;

  const nowIso = new Date().toISOString();
  let returnedOrigins: ReturnedOriginSelection | undefined;
  // Conditional flip: concurrent transitions cannot both pass (same pattern
  // as the order-cancel flow).
  if (to === 'resolved' && resolution === 'refund') {
    await validateInvestorReturnEvidence(c.env.DB, id);
    await refuseProtectedReturn(c.env.DB, kase.order_item_id);
    // ONE MONEY PROCESS PER UNIT (plan §1.3): no refund for a device that is
    // on the repair desk, or that a trade-in still holds (its credit spent or
    // the exchange done) — the same questions the refund batch asks again.
    const refundClaim = refundClaimSql(kase);
    if ((await c.env.DB.prepare(`SELECT ${refundClaim.sql} AS open`).bind(...refundClaim.binds).first<{ open: number }>())?.open) {
      throw badRequest('This device has an open warranty request. Close it before refunding the return.', 'WARRANTY_CLAIM_OPEN');
    }
    if (await refundTakesTradedUnit(c.env.DB, kase)) {
      throw badRequest('This device is part of a trade-in whose credit is in use or which is complete, so it cannot be refunded.', 'TRADE_IN_ACTIVE');
    }
    // 0178 §14: serials scanned at inspection (or explicit unit ids) must be
    // devices of THIS line and THIS buyer — refused before any money moves
    // (critique M6: the customer's own unit pick is never trusted alone).
    if (body.unit_ids === undefined && body.serials === undefined && await unitOriginsInstalled(c.env.DB)) {
      const storedUnits=(await c.env.DB.prepare('SELECT unit_id FROM stock_return_order_unit_evidence WHERE return_case_id=?').bind(id).all<{unit_id:string}>()).results??[];
      if(storedUnits.length) body.unit_ids=storedUnits.map(r=>r.unit_id);
    }
    let verifiedUnits: string[] = [];
    if ((body.serials !== undefined || body.unit_ids !== undefined) && (await serialAssignmentsInstalled(c.env.DB))) {
      verifiedUnits = (await returnedUnits(c.env.DB, kase, { serials: body.serials, unit_ids: body.unit_ids })).units;
    }
    returnedOrigins = await resolveReturnedOriginIds(c.env.DB,{orderId:kase.order_id,itemId:kase.order_item_id,qty:kase.qty,returnCaseId:id,originIds:body.inventory_origin_ids,unitIds:verifiedUnits});
  }
  const flipStatement = c.env.DB.prepare(
    `UPDATE return_cases SET state = ?, resolution = COALESCE(?, resolution),
        admin_note = CASE WHEN ? <> '' THEN ? ELSE admin_note END,
        decided_by = ?, decided_at = ?
      WHERE id = ? AND state = ?`
  )
    .bind(to, resolution, reason, reason, admin.id, nowIso, id, from);
  const refundTransition = to === 'resolved' && resolution === 'refund';
  if (!refundTransition) {
    const flip = await flipStatement.run();
    if (flip.meta.changes === 0) throw badRequest('This case changed while you were editing — reload and retry');
  }

  let refundResult: Record<string, unknown> | null = null;
  let pointsResult: Record<string, unknown> | null = null;
  const operationalReturns = await operationsInstalled(c.env.DB);
  const inspection = operationalReturns ? await c.env.DB.prepare('SELECT disposition FROM stock_return_inspections WHERE return_case_id=?').bind(id).first<{ disposition: string }>() : null;
  const restock = !inspection || inspection.disposition === 'restock';
  let restoredCost: number | null | undefined;

  if (to === 'resolved' && resolution === 'refund') {
    // S-P2 §6.9: a trade-in this order's credit paid for is completed first (idempotent — normally
    // it already was, on delivery), so the credit it gives back below is a completed request's.
    if (await tradeInV2Installed(c.env.DB)) await completeTradeInsForOrder(c.env, kase.order_id, { id: null, role: 'system' });
    // Read immutable invoice rows, including bundle parents. The finance
    // workspace's later cost/revenue edits never change customer refunds.
    const { results: orderItems } = await c.env.DB.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id')
      .bind(kase.order_id).all<GoodsLine>();
    const item = orderItems.find((line) => line.id === kase.order_item_id);
    const order = await c.env.DB.prepare('SELECT * FROM orders WHERE id=?')
      .bind(kase.order_id).first<Record<string, unknown>>();
    if (!item || !order) throw notFound('Return invoice not found');
    // THE TRADE-IN CREDIT IS THE NEW DEVICE'S, NOT THE ORDER'S (plan §1.2): attributed to the line
    // it paid for, never spread as a residual over the other lines; given back, never paid as cash.
    const tradeInCredit = (await tradeInV2Installed(c.env.DB)) ? await tradeInCreditOf(c.env.DB, order, orderItems as never) : null;
    const creditLine = tradeInCredit?.lineId ?? null;
    // THE CREDIT COMES BACK OR THE REFUND WAITS (review F-5/F-10). The netting below and the re-issue
    // that gives the credit back go together: the re-issue needs a COMPLETED request. A request whose
    // completion did not happen (it is retried; the desk sees it as overdue) is not refunded netted of
    // a credit that would then be lost — the desk completes it first. A request that died otherwise
    // (cancelled before S-P2) keeps the old rule: its credit is not cash, and does not come back.
    const creditRequestStatus = tradeInCredit && creditLine === item.id
      ? ((await c.env.DB.prepare('SELECT status FROM trade_in_requests WHERE id = ?').bind(tradeInCredit.requestId).first<{ status: string }>())?.status ?? null)
      : null;
    if (creditRequestStatus === 'awaiting_payment') {
      throw new HttpError(409, 'The trade-in this order paid with is not complete yet. Complete it first, then refund the return.', 'TRADE_IN_COMPLETION_PENDING', { request_id: tradeInCredit!.requestId });
    }
    {
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
      // Points reversal below retains its existing gross-merchandise basis.
      const caseGross = storedAlloc !== null
        ? Math.floor(storedAlloc * kase.qty / itemQty)
        : (Number(item.unit_price_iqd) || 0) * kase.qty;
      // WHAT WAS PAID FOR THE LINE (offers B6, Services V2 correction 2): the
      // coupon's goods part is frozen on the lines it named
      // (`order_items.coupon_discount_iqd`) and comes off THAT line only; the
      // order-level split carries just the residual — an older order's whole
      // coupon, a trade-in credit — and never a delivery discount, which is
      // no line's price. A line discount is therefore never refunded as if
      // it had not been given, and never subtracted twice.
      const coupon = safeParse<{ discount_iqd?: number; delivery_iqd?: number } | null>(order.coupon_snapshot as string | null, null);
      const couponTotal = coupon ? Math.max(0, Math.trunc(Number(coupon.discount_iqd) || 0)) : 0;
      const couponDelivery = coupon ? Math.min(couponTotal, Math.max(0, Math.trunc(Number(coupon.delivery_iqd) || 0))) : 0;
      const lineCoupons = orderItems.reduce((sum, line) => sum + Math.max(0, Math.trunc(Number(line.coupon_discount_iqd) || 0)), 0);
      const couponResidual = Math.max(0, couponTotal - couponDelivery - lineCoupons - (creditLine ? tradeInCredit!.amount : 0));
      const discounts = couponResidual + (Number(order.points_discount_iqd) || 0);
      const base = (Number(order.subtotal_iqd) || 0) + (Number(order.shipping_iqd) || 0);
      // Unit-level savings are already inside the frozen price. The shared
      // goods calculation subtracts only line-level membership savings and
      // distributes a parent's savings over bundle components. Report-only
      // finance adjustments never enter these immutable invoice rows.
      const goodsOnly = { ...order, points_discount_iqd: 0, price_adjustment_iqd: 0 };
      const membershipBasis = calculateGoods(goodsOnly, orderItems.map((line) => ({ ...line, coupon_discount_iqd: 0 })), []);
      // The same, with each line's own coupon discount taken off it (a
      // bundle parent's spread over its components, like its membership).
      const lineCouponBasis = calculateGoods(goodsOnly, orderItems, []);
      const acceptedBasis = calculateGoods(order, orderItems, []);
      // Preserve the established residual/points split including its shipping
      // share, then apply the membership, line-coupon and accepted-price adjustments.
      const fullRefunds = acceptedBasis.lines.map((line) => {
        const gross = Number(line.component_alloc_iqd ?? (Number(line.unit_price_iqd) || 0) * line.qty);
        const memberNet = membershipBasis.lines.find((v) => v.id === line.id)?.net_goods_iqd ?? gross;
        const memberReduction = Math.max(0, gross - memberNet);
        const couponNet = lineCouponBasis.lines.find((v) => v.id === line.id)?.net_goods_iqd ?? memberNet;
        const lineCouponReduction = Math.max(0, memberNet - couponNet);
        const discount = base > 0 ? Math.floor((discounts * gross) / base) : 0;
        return Math.max(0, gross - discount - memberReduction - lineCouponReduction + line.price_adjustment_iqd);
      });
      // A final-price cut can exhaust the goods and then reduce delivery.
      // The old discount split must not resurrect goods that were fully cut,
      // or refund more than the entire accepted invoice. Ordinary splits stay
      // unchanged below this ceiling; any necessary cap is exact across lines.
      const acceptedGoods = acceptedBasis.lines.reduce((sum, line) => sum + line.net_goods_iqd, 0);
      const ceiling = acceptedGoods === 0 ? 0 : Math.max(0, Number(order.total_iqd) || 0);
      const cappedRefunds = Number(order.price_adjustment_iqd) < 0 && fullRefunds.reduce((sum, value) => sum + value, 0) > ceiling
        ? spread(ceiling, fullRefunds) : fullRefunds;
      const fullRefund = cappedRefunds[acceptedBasis.lines.findIndex((line) => line.id === item.id)] ?? 0;
      const ledgerDinars = await walletLedgerDinarsReady(c.env.DB);
      const historicRate = Number(order.exchange_rate);
      const oldCreditValue = Number.isSafeInteger(historicRate) && historicRate > 0
        ? `CAST(w.amount * ${historicRate} / 100 AS INTEGER)` : 'NULL';
      const priorAmount = `COALESCE(
        (SELECT json_extract(a.detail,'$.refund.amount_iqd') FROM audit_log a
          WHERE a.action IN ('return.refund_decided','return.transition') AND a.target=r.id AND json_valid(a.detail)
            AND json_extract(a.detail,'$.refund.amount_iqd') IS NOT NULL ORDER BY a.id DESC LIMIT 1),
        (SELECT ${ledgerDinars ? `COALESCE(w.amount_iqd,${oldCreditValue})` : oldCreditValue}
          FROM wallet_transactions w WHERE w.id='wtx_ret_'||r.id AND w.status='approved'))`;
      const priorWhere = "r.order_item_id=? AND r.id<>? AND r.state='resolved' AND r.resolution='refund'";
      const priorSql = `SELECT COALESCE(SUM(r.qty),0) qty,COALESCE(SUM(${priorAmount}),0) amount,COALESCE(SUM(CASE WHEN ${priorAmount} IS NULL THEN 1 ELSE 0 END),0) unknown
        FROM return_cases r WHERE ${priorWhere}`;
      const prior = (await c.env.DB.prepare(priorSql).bind(item.id, id).first<{ qty: number; amount: number; unknown: number }>())!;
      if (prior.unknown > 0) throw badRequest(serverMessage('RETURN_REFUND_REVIEW_REQUIRED'), 'RETURN_REFUND_REVIEW_REQUIRED');
      // Cumulative floors give the final returned unit the exact remainder.
      // Existing recorded credits count towards the cap without being edited.
      const endQty = Math.min(itemQty, prior.qty + kase.qty);
      // The line the trade-in credit paid for (§16 D-13; review F-8): its CASH comes back net of the
      // credit, CUMULATIVELY — after q of its n units the cash refunded is floor(F·q/n) − the credit,
      // never below 0 — so however the line is split into cases its cash refunds sum to exactly
      // F − the credit, even when one unit's share is smaller than the credit (points, a member
      // price). The credit itself comes back as the same coupon with the FIRST case (below).
      const creditNetted = !!tradeInCredit && creditLine === item.id;
      const creditAmount = creditNetted ? tradeInCredit!.amount : 0;
      const cashTarget = (q: number) => Math.max(0, Math.floor(fullRefund * q / itemQty) - creditAmount);
      const refundIqd = creditNetted
        ? Math.max(0, Math.min(Math.max(0, fullRefund - creditAmount) - prior.amount, cashTarget(endQty) - prior.amount))
        : Math.max(0, Math.min(fullRefund - prior.amount,
          Math.floor(fullRefund * endQty / itemQty) - Math.floor(fullRefund * Math.min(itemQty, prior.qty) / itemQty)));
      const givesCreditBack = creditNetted && creditRequestStatus === 'completed' && Number(prior.qty) === 0;
      const reissueEnds = givesCreditBack ? await reissueEndsAt(c.env.DB, tradeInCredit!.requestId, kase.order_id, nowIso) : null;
      // Lots/returns predate ops_guards: the return table's own positive-qty
      // CHECK supplies the transaction fence without a newer schema dependency.
      // No row is inserted on success. A concurrent refund must replan while
      // its case remains inspected, rather than spending this interval twice.
      const refundFence = c.env.DB.prepare(`INSERT INTO return_cases
        (id,order_id,order_item_id,user_id,qty,reason,state)
        SELECT ?,?,?,?,-1,'defective','inspected' WHERE
          NOT EXISTS(SELECT 1 FROM return_cases WHERE id=? AND state=?)
          OR (SELECT qty FROM (${priorSql}))<>?
          OR (SELECT amount FROM (${priorSql}))<>?
          OR ?>?
          OR EXISTS(SELECT 1 FROM price_protection_claims ppc WHERE ppc.order_item_id=? AND ppc.state IN ('approved','credited'))
          OR ${refundClaimSql(kase).sql}
          OR ${tradedUnitsSql(await tradeInInstalled(c.env.DB))}+?>?`)
        .bind(newId('return_guard'), kase.order_id, item.id, kase.user_id, id, from,
          item.id, id, prior.qty, item.id, id, prior.amount, prior.qty + kase.qty, itemQty, item.id,
          ...refundClaimSql(kase).binds, item.id, prior.qty + kase.qty, itemQty);

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
      // The wallet stores positive whole cents. Do not resolve a positive
      // dinar refund that it cannot credit, or round it up into extra money.
      if (walletRefundIqd > 0 && cents === 0) {
        throw badRequest(serverMessage('RETURN_REFUND_REVIEW_REQUIRED'), 'RETURN_REFUND_REVIEW_REQUIRED');
      }

      const credit = cents > 0 ? walletCreditStatement(c.env.DB, ledgerDinars, {
        id: `wtx_ret_${id}`, userId: kase.user_id, cents,
        note: `Refund for approved return ${id} (order ${kase.order_id})`,
        ref: kase.order_id, nowIso, amountIqd: walletRefundIqd, rate,
      }) : null;
      // Stock, exact physical origins and the refund decision share one commit.
      // A stale piece selection must fail before a customer's refund is posted.
      const restoreMoves = restock ? await restoreMovesForItem(c.env.DB,kase.order_id,kase.order_item_id,kase.qty) : [];
      const restorePlan = restock && restoreMoves.length ? await planInventory(c.env.DB,restoreMoves,{kind:'restore',operationId:id,orderId:kase.order_id,actorUserId:admin.id,reason:'return'}) : null;
      const originStatements: D1PreparedStatement[] = [];
      if (restorePlan) {
        restorePlan.statements.push(await planReservationFence(c.env.DB,kase.order_id,'restore',restorePlan.plannedLedgerRows));
        const lots = await planLotRestore(c.env.DB,kase.order_id,{lineIds:[kase.order_item_id],qtyByLine:{[kase.order_item_id]:kase.qty},operation:`return:${id}`,originIds:returnedOrigins?.originIds,allocationQty:returnedOrigins?.allocationQty});
        restorePlan.statements.push(...lots.statements);
        if(lots.allocations.length)restoredCost=lots.allocations.some(a=>a.cogs_iqd===null)?null:lots.allocations.reduce((n,a)=>n+(a.cogs_iqd??0),0);
      } else if (!restock) {
        originStatements.push(...await planUnsellableOriginReturn(c.env.DB,{orderId:kase.order_id,itemId:kase.order_item_id,qty:kase.qty,reason:`return_unsellable:${id}`,originIds:returnedOrigins?.originIds}));
      }
      // The refund amount is the cap's evidence for every later refund of this
      // line. Gini and 0 IQD refunds have no wallet row, so the evidence is
      // written IN the decision batch (review 2026-10-13, CF-2): the trailing
      // audit() below runs after other hooks and swallows its own failure.
      const evidence = await auditStatements(c.env.DB, admin.id, 'return.refund_decided', id, {
        order_id: kase.order_id, order_item_id: kase.order_item_id, qty: kase.qty,
        refund: { amount_iqd: refundIqd, credited: credit !== null, channel: settledByGini ? 'gini' : 'wallet' },
        ...(givesCreditBack ? { trade_in_credit_back: { request_id: tradeInCredit!.requestId, amount_iqd: tradeInCredit!.amount } } : {}),
      });
      try {
        await c.env.DB.batch([
          refundFence, flipStatement, ...(credit ? [credit] : []),
          // S-P2 §6.9: the same coupon comes back for 30 days on any direct-sale device (completed requests only).
          ...(givesCreditBack ? returnReissueStatements(c.env.DB, tradeInCredit!, { orderId: kase.order_id, returnCaseId: id, userId: kase.user_id, now: nowIso, endsAt: reissueEnds! }) : []),
          ...(restorePlan?.statements??[]), ...originStatements, ...evidence.statements,
        ]);
      } catch (e) {
        if (/CHECK constraint failed:\s*qty\s*>\s*0/.test(String(e))) {
          throw badRequest(serverMessage('RETURN_RESOLUTION_RETRY'), 'RETURN_RESOLUTION_RETRY');
        }
        throw e;
      }
      const credited = credit !== null;
      pumpAfter(c.env.DB,[...(restorePlan?.eventIds??[]),evidence.eventId],waitUntilFrom(c));
      // Points and finance hooks retain their existing follow-up behavior.
      if (credited && eventsEnabled(c.env)) {
        await emitFromRequest(c, RefundCompletedV1, {
          ref_type: 'return', ref_id: id, user_id: kase.user_id,
          usd_cents: cents, points: 0, ledger_tx_ids: [`wtx_ret_${id}`], event_key: `wtx_ret_${id}`,
        }, { aggregateId: kase.user_id, actorId: admin.id });
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
    }
  }

  if (refundResult && operationalReturns) {
    try { await recordReturnFinancials(c.env,{caseId:id,orderId:kase.order_id,itemId:kase.order_item_id,refundIqd:Number(refundResult.amount_iqd),qty:kase.qty,restocked:restock,actor:admin.id,day:baghdadDay(new Date(nowIso)),cogsIqd:restoredCost,channel:String(refundResult.channel)}); }
    catch(e) { await recordFinancialFailure(c.env.DB,kase.order_id,'refund',e).catch(()=>undefined); }
  }

  // §14 THE DEVICE CAME BACK: its warranty unit closes (dates kept), the live
  // receipt is voided, the account link revoked, the serial's assignment
  // released 'returned' — one batch (worker/lib/serialAssignments.ts). The
  // route is not one transaction, so `sweepReturnedSerials` retries it.
  let serialsResult: { closed: string[]; unattributed: boolean } | null = null;
  if (to === 'resolved' && resolution === 'refund') {
    try {
      serialsResult = await applyReturnSerials(c.env, kase, { serials: body.serials, unit_ids: body.unit_ids }, admin.id, restock);
    } catch (e) {
      console.error('return serial hook failed', id, e instanceof Error ? e.message : String(e));
    }
  }

  await audit(c.env.DB, admin.id, 'return.transition', id, {
    from, to, resolution, reason,
    ...(refundGrant ? { authority: refundGrant.audit } : {}),
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
    ...(serialsResult ? { serials: serialsResult } : {}),
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
  /** Migration 0181 (owner decision 6): what a v5 claim covers per unit; NULL on every older claim. */
  eligible_unit_iqd?: number | null;
}

/** Migration 0181's claim columns (owner decision 6), detected once per isolate; only "present" is remembered. */
let claimColumnsPresent = false;
async function claimBasisColumns(db: D1Database): Promise<boolean> {
  if (claimColumnsPresent) return true;
  try {
    await db.prepare('SELECT eligible_unit_iqd, basis FROM price_protection_claims LIMIT 0').all();
    claimColumnsPresent = true;
  } catch {
    return false;
  }
  return true;
}

/** The published policy forbids paying both a return and price protection on
 * the same unit. Old claims do not identify individual units, so an overlap on
 * a partially returned line needs review; other order lines stay independent. */
async function refuseProtectedReturn(db: D1Database, itemId: string): Promise<void> {
  const overlap = await db.prepare("SELECT 1 FROM price_protection_claims WHERE order_item_id=? AND state IN ('approved','credited') LIMIT 1")
    .bind(itemId).first();
  if (overlap) throw badRequest(serverMessage('PRICE_PROTECTION_RETURN_REVIEW'), 'PRICE_PROTECTION_RETURN_REVIEW');
}
/** A return of the line that is still being worked (requested … inspected),
 * or already refunded, decides the line first (review 2026-10-13, PF-1):
 * paying the smaller price difference while the unit is on its way back or
 * already at the store would leave that return unrefundable for good. A
 * rejected return, or one resolved without a refund, does not block. */
const RETURN_BLOCKS_PROTECTION_SQL = "(state NOT IN ('rejected','resolved') OR (state='resolved' AND resolution='refund'))";
async function refuseReturnedProtection(db: D1Database, itemId: string, opts: { openReturns?: boolean } = {}): Promise<void> {
  // A customer may still file a claim while a return is open; only the
  // approval (and its in-batch guard) waits for the return to be decided.
  const blocking = opts.openReturns ? RETURN_BLOCKS_PROTECTION_SQL : "(state='resolved' AND resolution='refund')";
  const overlap = await db.prepare(`SELECT 1 FROM return_cases WHERE order_item_id=? AND ${blocking} LIMIT 1`)
    .bind(itemId).first();
  if (overlap) throw badRequest(serverMessage('PRICE_PROTECTION_RETURN_REVIEW'), 'PRICE_PROTECTION_RETURN_REVIEW');
}

/** WHAT WAS PAID FOR ONE UNIT — the shared paid-net rule (Services V2 plan
 * §3.2, packages/pricing/src/paidNet.ts; worker/lib/paidNet.ts reads the
 * facts): the unit merchandise without warranty or transport fees, less the
 * frozen membership, the line's own discount and its share of the order
 * coupon and points, plus the accepted price adjustment; never above what
 * the order charged. A trade-in credit counts as paid (owner decision 5).
 * Trade-in reads the very same figure. Current membership rules and finance
 * report overrides are not customer payment facts and never enter it. */
async function protectionPaidUnit(db: D1Database, orderId: string, itemId: string): Promise<{ unit: number; orderTotal: number }> {
  const paid = await paidNetUnit(db, orderId, itemId);
  if (!paid) throw badRequest(serverMessage('PRICE_PROTECTION_REVIEW_REQUIRED'), 'PRICE_PROTECTION_REVIEW_REQUIRED');
  return paid;
}

/** Units of a line held by a trade-in (draft to complete): each slot counts once, whatever part was claimed. */
/** The slots (unit indexes) of a line a trade-in holds. */
async function tradedSlotsOnLine(db: D1Database, orderItemId: string): Promise<number[]> {
  if (!(await tradeInInstalled(db))) return [];
  const { results } = await db
    .prepare('SELECT DISTINCT unit_index FROM trade_in_claims WHERE order_item_id = ?')
    .bind(orderItemId)
    .all<{ unit_index: number }>();
  return (results ?? []).map((r) => Number(r.unit_index)).filter((n) => Number.isSafeInteger(n) && n > 0);
}

/** Slots 1..lineQty no trade-in holds. */
function untradedSlots(lineQty: number, traded: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i <= Math.min(Math.max(0, lineQty), 500); i++) if (!traded.includes(i)) out.push(i);
  return out;
}

async function tradedUnitsOnLine(db: D1Database, orderItemId: string): Promise<number> {
  const row = await db.prepare(`SELECT ${tradedUnitsSql(await tradeInInstalled(db))} AS n`).bind(orderItemId).first<{ n: number }>();
  return Number(row?.n) || 0;
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
    `SELECT oi.*, o.user_id AS owner_id, o.status, o.delivered_at, o.shipping_type, o.created_at AS order_created_at
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
  await refuseReturnedProtection(c.env.DB, orderItemId);

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

  // A UNIT HANDED IN FOR A TRADE-IN IS NOT PRICE-PROTECTED (PP-B8; plan §1.3).
  // The trade-in valued it on what was paid; protecting it as well pays the
  // same fall twice. Its claim rows exist from the draft until it is
  // cancelled, so a live or completed trade-in takes its units out of the
  // claim; a line all of whose units are traded in is refused.
  const tradedUnits = await tradedUnitsOnLine(c.env.DB, orderItemId);
  const coveredQty = Math.max(0, (Number(item.qty) || 1) - tradedUnits);
  if (coveredQty <= 0) throw badRequest('This device is part of a trade-in, so price protection does not cover it.', 'TRADE_IN_UNIT');

  // The price CLASS the buyer actually had, from the checkout snapshot — a
  // regular buyer is never compared against a member price, and a PRIME or
  // PRO buyer is compared with today's price of their own class (PP-B4).
  const pricing = safeParse<{
    applied_tier?: string;
    applied_iqd?: number;
    pricing_basis?: string;
    price_source?: string;
    fulfillment?: { type?: string } | null;
  } | null>(item.pricing_snapshot as string | null, null);
  const buyerClass = buyerClassOf(pricing);
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
  const componentAlloc =
    item.component_alloc_iqd === null || item.component_alloc_iqd === undefined
      ? null
      : Math.max(0, Number(item.component_alloc_iqd) || 0);
  const componentValue =
    item.component_value_iqd === null || item.component_value_iqd === undefined
      ? null
      : Number(item.component_value_iqd) || 0;
  const originalUnit = (await protectionPaidUnit(c.env.DB, String(item.order_id), orderItemId)).unit;

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

  // The clean start (DECISIONS row 222, spec addendum A.5): a product a customer cannot buy today (hidden,
  // held, or not yet priced in dollars) has no "price a buyer would pay today" — never its old dinar
  // figure. The window's recorded prices are read as always; placed orders and claims never change.
  const listingNow = await listing(c.env.DB);
  const listedNow = listingNow.isSellableRow(productRow, await listingNow.unsellableIds([String(productRow.id)]));
  // THE COMPARISON PRICE IS THE ONE A BUYER WOULD PAY TODAY, so the product is
  // read the way the cart reads it: the relational option/colour rows win over
  // the JSON mirrors on `products`. This claim decides a real credit — reading
  // the other store would compare the customer's paid price against a number
  // nobody is charged, and refuse or grant money on it.
  const relations = await loadRelationsView(c.env.DB, String(productRow.id), productRow.inventory_mode);
  const doc = relations ? applyRelations(parseProductRow(productRow), relations) : parseProductRow(productRow);
  // The line's whole selection (0018), so a per-SKU engine price (0183) is the one compared.
  const storedValueIds = safeParse<unknown[]>(String(item.option_value_ids ?? '[]'), []).filter((x): x is string => typeof x === 'string' && x !== '');
  const optionValueIds = storedValueIds.length ? storedValueIds : optionId ? [optionId] : [];
  const transportSnap = safeParse<{ method?: unknown; waived_by?: unknown } | null>(item.transport_snapshot as string | null, null);
  // LIKE WITH LIKE (worker/lib/protectionClaims.ts): the line's own channel
  // (PP-B3) and the buyer's own class through the cart's membership rules
  // (PP-B4), so «today's price» is what this buyer would be charged for this
  // line today — never another channel's, never another class's.
  const channel = lineChannelOf(pricing, transportSnap);
  const ctx = await loadPricingContext(
    c.env.DB,
    buyerClass === 'regular' ? null : { tier: tierOfClass(buyerClass), active: true, expires_at: null, pending_launch: null, gated_benefits: [] }
  );
  const resolved = resolveUnitPrice({
    product: doc,
    optionId: optionId || null,
    optionValueIds,
    colorId: colorId || null,
    transportMethod: channel.transportMethod,
    fulfillmentType: channel.fulfillmentType,
    preorderPricing: channel.preorderPricing,
    warrantyPlanId: null,
    tier: tierOfClass(buyerClass),
    tierActive: buyerClass !== 'regular',
    proPolicy: ctx.proPolicy,
    memberFallback: memberFallbackFor(ctx, doc),
    transportDefaults: ctx.transportDefaults,
  });
  // A channel the shop no longer sells has no price today; the window's history still counts.
  const channelClosed = resolved.errors.some((e) => CHANNEL_CLOSED_ERRORS.has(e));
  if (listedNow && resolved.errors.some((e) => e !== 'TRANSPORT_REQUIRED' && !CHANNEL_CLOSED_ERRORS.has(e))) {
    throw badRequest(
      'The purchased variant no longer resolves on the current product — please contact support',
      'VARIANT_UNRESOLVED'
    );
  }
  // Unlisted: no candidate today (the paid price itself, which is no drop). A closed channel: no price today.
  const currentApplied = !listedNow ? originalUnit : channelClosed ? null : resolved.applied_iqd;

  // Lowest price WITHIN the window from the persisted price history — a drop
  // that has since been raised back remains inspectable (§6.8). Only the rows
  // of the rung that prices this line (PP-B2: a model with its own price is
  // never compared with the base price), and only its class's fields: a
  // member's own field and the regular one beside it, a regular buyer regular.
  const variantKeys = historyKeysOf({ todaySource: resolved.price_source, purchaseSource: pricing?.price_source, optionId, colorId });
  const fields = historyFieldsOf(buyerClass);
  const windowFrom = new Date(deliveredMs).toISOString();
  const windowTo = new Date(Math.min(now, deliveredMs + WINDOW_MS)).toISOString();
  const hist = variantKeys.length
    ? await c.env.DB.prepare(
        `SELECT MIN(new_iqd) AS m FROM price_history
          WHERE product_id = ? AND variant_key IN (${variantKeys.map(() => '?').join(',')})
            AND field IN (${fields.map(() => '?').join(',')})
            AND new_iqd IS NOT NULL AND changed_at >= ? AND changed_at <= ?`
      )
        .bind(item.product_id, ...variantKeys, ...fields, windowFrom, windowTo)
        .first<{ m: number | null }>()
    : null;

  /**
   * OWNER DECISION 6: AN FX-ONLY DROP IS NOT PRICE PROTECTION (policy v5
   * §10.4, §11.8; worker/lib/pricingEngine/protectionBasis.ts). The engine's
   * own observations of this line's model × channel (`sku:` history, with the
   * USD/IQD each was computed at, and today's engine price) join the
   * comparison: for an order created before v5 as plain dinars (the old rule,
   * never missing a real engine drop); from v5 on restated at the rate the
   * line was bought at, so a fall that is only the exchange rate pays nothing,
   * and what is paid never exceeds the actual dinar drop.
   */
  const transportMethod = transportSnap?.method;
  const engineSnapshot =
    item.price_basis === 'engine' && typeof item.usd_iqd_at_purchase === 'string' && Number.isSafeInteger(Number(item.engine_regular_iqd))
      ? { regular_iqd: Number(item.engine_regular_iqd), usd_iqd_at_purchase: item.usd_iqd_at_purchase, base_usd_at_purchase: (item.base_usd_at_purchase as string | null) ?? null }
      : null;
  const lineChannel =
    (engineSnapshot && typeof item.engine_channel === 'string' ? item.engine_channel : null) ??
    channelOfLine({ pricing_basis: (pricing as { pricing_basis?: string } | null)?.pricing_basis === 'preorder' ? 'preorder' : 'direct', route: typeof transportMethod === 'string' ? transportMethod : null });
  // The line's SKU (0183: a product priced per colour or variant) and its model (priced per model).
  const lineCombos = engineCombosOf({
    snapshot: typeof item.engine_combo_key === 'string' ? item.engine_combo_key : null,
    optionId,
    optionValueIds,
    colorId: colorId || null,
  });
  const observations = lineChannel
    ? await engineObservations(c.env.DB, String(item.product_id), lineCombos, lineChannel as Parameters<typeof engineObservations>[3], { from: windowFrom, to: windowTo })
    : { history: [], today: null };
  const v5 = takesUsdBaseRule(item.order_created_at as string | null);
  const decision = claimBasis({
    v5,
    engine: engineSnapshot,
    orderUsdIqd: v5 && !engineSnapshot ? await usdIqdInForceAt(c.env.DB, String(item.order_created_at)) : null,
    paidUnit: originalUnit,
    // A channel closed today quotes nothing today (the window's history still counts).
    todayApplied: currentApplied,
    manualMin: hist && hist.m !== null && Number.isInteger(hist.m) && hist.m >= 0 ? hist.m : null,
    engineHistory: observations.history,
    engineToday: listedNow && !channelClosed ? observations.today : null,
  });
  if (!decision.ok && decision.code === 'FX_ONLY_DROP') {
    throw badRequest('The dinar price fell only because the dollar exchange rate moved — price protection does not cover exchange-rate moves', 'FX_ONLY_DROP');
  }
  if (!decision.ok) {
    throw badRequest('No eligible price drop was found for this item within the window', 'NO_ELIGIBLE_DROP');
  }
  const observedUnit = decision.observed_unit;
  const perUnitDrop = decision.eligible_unit ?? Math.max(0, originalUnit - observedUnit);
  if (perUnitDrop <= 0) {
    throw badRequest('No eligible price drop was found for this item within the window', 'NO_ELIGIBLE_DROP');
  }

  const qty = coveredQty;
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
    // What was compared, for the staff's evidence view (never the customer's — PP-B7).
    sale_channel: lineChannel ?? 'direct_sale',
    today_closed: channelClosed,
    today_rung: resolved.price_source,
    history_keys: variantKeys,
    history_fields: fields,
    // The Levo wallet (owner decision, DECISIONS row 223: «الرصيد للمحفظة»).
    compensation_channel: 'wallet',
  });
  // A v5 claim stores what it covers and its basis in their own columns (0181), never in the snapshot
  // the customer reads; every older claim — and every claim on a database without 0181 — is the exact
  // INSERT it always was.
  //
  // G3 (row 237): ONE «requested» CLAIM PER LINE, asked inside the insert. The read above is the fast
  // path; between it and here are many awaits, and two presses at once both passed it and both wrote.
  // The conditional insert holds on any database; 0191's ppc_one_open refuses the same from the
  // database itself (CLAIM_PENDING), and both answer the same 400.
  const pendingRefusal = () => badRequest('A claim for this item is already awaiting review', 'CLAIM_PENDING');
  const noneRequested = `WHERE NOT EXISTS (SELECT 1 FROM price_protection_claims p WHERE p.order_item_id = ?4 AND p.state = 'requested')`;
  let inserted: { meta: { changes?: number } };
  try {
    inserted =
      decision.eligible_unit !== null && (await claimBasisColumns(c.env.DB))
        ? await c.env.DB.prepare(
            `INSERT INTO price_protection_claims (id, user_id, order_id, order_item_id, original_unit_iqd,
               observed_unit_iqd, qty, credited_iqd, state, policy_snapshot,
               eligible_unit_iqd, basis, usd_iqd_at_purchase, base_usd_at_purchase, base_usd_observed)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'requested', ?8, ?9, ?10, ?11, ?12, ?13
              ${noneRequested}`
          )
            .bind(
              id, user.id, String(item.order_id), orderItemId, originalUnit, observedUnit, qty, policySnapshot,
              decision.eligible_unit, decision.basis, engineSnapshot?.usd_iqd_at_purchase ?? null, engineSnapshot?.base_usd_at_purchase ?? null, decision.base_usd_observed
            )
            .run()
        : await c.env.DB.prepare(
            `INSERT INTO price_protection_claims (id, user_id, order_id, order_item_id, original_unit_iqd,
               observed_unit_iqd, qty, credited_iqd, state, policy_snapshot)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 'requested', ?8
              ${noneRequested}`
          )
            .bind(id, user.id, String(item.order_id), orderItemId, originalUnit, observedUnit, qty, policySnapshot)
            .run();
  } catch (e) {
    if (/CLAIM_PENDING/.test(e instanceof Error ? e.message : String(e))) throw pendingRefusal();
    throw e;
  }
  if ((inserted.meta.changes ?? 0) === 0) throw pendingRefusal();

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
  return c.json({ success: true, claim: claimForCustomer(row!) });
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
    claims: results.map((r) => claimForCustomer(r, { item: { name: r.name_snapshot, variant: r.option_snapshot } })),
  });
});

const CLAIM_STATES = ['requested', 'approved', 'rejected', 'credited'] as const;

/**
 * THE QUEUE (Services V2 S-P0a, «حماية السعر» in Admin → التشغيل). Any admin
 * reads it — an assistant answers the customer — and only the financial scope
 * decides (below). Search by claim, order, customer name, phone or email, or
 * product; the counts per state feed the chips.
 */
priceProtectionRoutes.get('/admin/claims', requireAdmin, async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false });
  const q = str(c.req.query('q'), 'q', { max: 80, required: false });
  let sql = `SELECT ppc.*, oi.name_snapshot, oi.option_snapshot, u.email, u.username, u.name AS customer_name, u.phone_e164 AS customer_phone
               FROM price_protection_claims ppc
               JOIN order_items oi ON oi.id = ppc.order_item_id
               LEFT JOIN users u ON u.id = ppc.user_id`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (state && (CLAIM_STATES as readonly string[]).includes(state)) {
    where.push('ppc.state = ?');
    params.push(state);
  }
  // A bound pattern (D1 refuses a LIKE pattern over 50 bytes; Arabic is two a letter).
  const like = likePattern(q);
  if (like) {
    where.push(`(ppc.id = ? OR ${sqlLikeClause(['ppc.order_id', 'u.email', 'u.phone_e164', 'u.name', 'oi.name_snapshot'])})`);
    params.push(q, like, like, like, like, like);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY ppc.requested_at DESC LIMIT 200';
  const [{ results }, counts] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all<ClaimRow>(),
    c.env.DB.prepare(`SELECT state, COUNT(*) AS n FROM price_protection_claims WHERE state IN ('requested','approved','rejected','credited') GROUP BY state`).all<{ state: string; n: number }>(),
  ]);
  return c.json({
    success: true,
    counts: Object.fromEntries((counts.results ?? []).map((r) => [r.state, Number(r.n) || 0])),
    claims: results.map((r) =>
      claimForStaff(r, {
        item: { name: r.name_snapshot, variant: r.option_snapshot },
        email: r.email, username: r.username, user_id: r.user_id,
        customer_name: r.customer_name ?? null, customer_phone: r.customer_phone ?? null,
      })
    ),
  });
});

/** What deciding this claim would credit NOW, and every reason it would be refused (the decide route's own checks). */
interface DecisionFigures {
  coveredQty: number;
  tradedUnits: number;
  paid: { unit: number; orderTotal: number };
  perUnit: number;
  eligibleTotal: number;
  prior: number;
  credit: number;
}
async function decisionFigures(db: D1Database, claim: ClaimRow, id: string): Promise<DecisionFigures> {
  if (claim.state !== 'requested') throw badRequest('This claim was already decided');
  await refuseReturnedProtection(db, claim.order_item_id, { openReturns: true });
  // A unit that went into a trade-in since the claim was filed is no longer covered (PP-B8).
  const lineQty = Number((await db.prepare('SELECT qty FROM order_items WHERE id = ?').bind(claim.order_item_id).first<{ qty: number }>())?.qty) || 1;
  const tradedUnits = await tradedUnitsOnLine(db, claim.order_item_id);
  const coveredQty = Math.min(Number(claim.qty) || 1, Math.max(0, lineQty - tradedUnits));
  if (coveredQty <= 0) throw badRequest('This device is part of a trade-in, so price protection does not cover it.', 'TRADE_IN_UNIT');
  // Owner decision 6: v5 claims credit their eligible USD-base reduction.
  // Both this cumulative amount and the absence of a return are checked again
  // in the same transaction as the decision and actual wallet credit.
  const paid = await protectionPaidUnit(db, claim.order_id, claim.order_item_id);
  const actualDrop = Math.max(0, Math.min(claim.original_unit_iqd, paid.unit) - claim.observed_unit_iqd);
  const perUnit = Math.min(claim.eligible_unit_iqd ?? actualDrop, actualDrop);
  if (perUnit <= 0) throw badRequest('No eligible price drop remains against the amount paid for this item', 'NO_ELIGIBLE_DROP');
  const eligibleTotal = Math.max(0, perUnit * coveredQty);
  const unresolvedPrior = await db.prepare("SELECT 1 FROM price_protection_claims WHERE order_item_id=? AND state='approved' AND id<>? LIMIT 1")
    .bind(claim.order_item_id, id).first();
  if (unresolvedPrior) throw badRequest(serverMessage('PRICE_PROTECTION_REVIEW_REQUIRED'), 'PRICE_PROTECTION_REVIEW_REQUIRED');
  const prior = await priorCreditedIqd(db, claim.order_item_id, id);
  const credit = Math.max(0, Math.min(eligibleTotal - prior, eligibleTotal));
  if (credit <= 0) {
    throw badRequest('Earlier credits already cover the eligible difference — nothing left to credit', 'ALREADY_COMPENSATED');
  }
  return { coveredQty, tradedUnits, paid, perUnit, eligibleTotal, prior, credit };
}

/** The claim's comparison window, as filed (every claim's snapshot carries it). */
function claimWindow(claim: Pick<ClaimRow, 'policy_snapshot'>): { from: string; to: string } | null {
  const w = safeParse<{ window?: { from?: unknown; to?: unknown } }>(claim.policy_snapshot, {}).window;
  return typeof w?.from === 'string' && typeof w?.to === 'string' ? { from: w.from, to: w.to } : null;
}

/**
 * A MEMBER PRICE RULE THAT COULD PRICE THIS PRODUCT, as a version row's
 * before or after image (`membership_benefit_versions`, every writer: the
 * rules editor, a product save, an import). A product rule counts for its own
 * product only; a section or global rule counts for every product (it may
 * cover this one). A row that is not a rule object counts too — unread is
 * never «unrelated». `img` the JSON column, `?P` the product id marker.
 */
const ruleImageTouches = (img: string, product: string) =>
  `(${img} IS NOT NULL AND NOT (json_valid(${img}) AND json_type(${img}) = 'object'
      AND (json_extract(${img}, '$.benefit_type') <> 'product_discount'
           OR (json_extract(${img}, '$.scope') = 'product' AND json_extract(${img}, '$.product_id') IS NOT ${product}))))`;

/**
 * THE PRICES OUTSIDE `price_history` THAT A CLAIM COMPARES (PP-B4): a PRO or
 * PREMIUM buyer is compared with today's member price, made by the member
 * price rules and the PRO pricing policy. Their changes inside the claim's
 * window, newest first: who wrote each, and what kind. The four-eyes test and
 * the evidence sheet read the same rows. Times are compared as instants and
 * answered as ISO (the version table stores «YYYY-MM-DD HH:MM:SS»).
 */
async function memberPriceWrites(
  db: D1Database,
  claim: Pick<ClaimRow, 'order_item_id' | 'policy_snapshot'>,
  authorId: string | null
): Promise<Array<{ at: string; kind: 'member_rule' | 'pro_policy'; author_id: string | null; author: string | null; author_email: string | null }>> {
  const window = claimWindow(claim);
  if (!window) return [];
  // A regular buyer is compared with the regular price only: member prices are
  // not this claim's evidence. A claim that does not say its class may be a
  // member's, so it counts.
  if (safeParse<{ buyer_class?: unknown }>(claim.policy_snapshot, {}).buyer_class === 'regular') return [];
  const product = await db.prepare('SELECT product_id FROM order_items WHERE id = ?').bind(claim.order_item_id).first<{ product_id: string }>();
  if (!product) return [];
  const { results } = await db
    .prepare(
      `SELECT at, kind, author_id, u.name AS author, u.email AS author_email FROM (
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ', v.created_at) AS at, 'member_rule' AS kind, v.actor_user_id AS author_id FROM membership_benefit_versions v
           WHERE julianday(v.created_at) BETWEEN julianday(?1) AND julianday(?2)
             AND (?3 IS NULL OR v.actor_user_id = ?3)
             AND (${ruleImageTouches('v.before_json', '?4')} OR ${ruleImageTouches('v.after_json', '?4')})
          UNION ALL
          SELECT strftime('%Y-%m-%dT%H:%M:%fZ', a.created_at), 'pro_policy', a.actor_id FROM audit_log a
           WHERE a.action = 'settings.update' AND a.target = 'proPricingPolicy'
             AND julianday(a.created_at) BETWEEN julianday(?1) AND julianday(?2)
             AND (?3 IS NULL OR a.actor_id = ?3)
        ) w LEFT JOIN users u ON u.id = w.author_id
        ORDER BY julianday(at) DESC LIMIT 50`
    )
    .bind(window.from, window.to, authorId, product.product_id)
    .all<{ at: string; kind: 'member_rule' | 'pro_policy'; author_id: string | null; author: string | null; author_email: string | null }>();
  return results ?? [];
}

/**
 * Four eyes: a non-owner who wrote a price of this product inside the claim's
 * window — a price row, a member price rule that could price it, or the PRO
 * pricing policy (review F6: a PRO buyer is compared with the member price
 * those make, and they leave no `price_history` row).
 */
async function approverWrotePrice(c: Context<AppContext>, claim: ClaimRow): Promise<boolean> {
  const admin = c.get('user')!;
  const window = claimWindow(claim);
  if (isOwner(c.env, admin) || !window) return false;
  const priceRow = await c.env.DB.prepare(
    `SELECT 1 FROM price_history WHERE changed_by = ?
        AND product_id = (SELECT product_id FROM order_items WHERE id = ?)
        AND changed_at >= ? AND changed_at <= ? LIMIT 1`
  ).bind(admin.id, claim.order_item_id, window.from, window.to).first();
  if (priceRow) return true;
  return (await memberPriceWrites(c.env.DB, claim, admin.id)).length > 0;
}

const EVIDENCE_FIELDS = ['regular', 'prime', 'pro'] as const;

/**
 * ONE CLAIM, WITH ITS EVIDENCE (design B.4, the minimal sheet). The facts the
 * decision rests on — what was paid per unit, the price compared, the units —
 * the price rows of the product inside the claim's window (who wrote each, and
 * whether it is a row this claim compares: the rung, the class), and what an
 * approval would credit now or why it would be refused. Price fields only:
 * never a cost row, a cost or a profit (owner decision 2), never a rate.
 */
priceProtectionRoutes.get('/admin/claims/:id', requireAdmin, async (c) => {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const db = c.env.DB;
  const claim = await db.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
  if (!claim) throw notFound('Claim not found');
  const [line, order, customer] = await Promise.all([
    db.prepare('SELECT product_id, name_snapshot, option_snapshot, qty, option_id, color_id FROM order_items WHERE id = ?').bind(claim.order_item_id).first<Record<string, unknown>>(),
    db.prepare('SELECT id, status, created_at, delivered_at, shipping_type FROM orders WHERE id = ?').bind(claim.order_id).first<Record<string, unknown>>(),
    db.prepare('SELECT id, name, email, phone_e164 FROM users WHERE id = ?').bind(claim.user_id).first<Record<string, unknown>>(),
  ]);
  const policy = safeParse<Record<string, unknown>>(claim.policy_snapshot, {});
  const window = claimWindow(claim);
  const keys = Array.isArray(policy.history_keys)
    ? (policy.history_keys as unknown[]).filter((k): k is string => typeof k === 'string')
    : ['', ...(line?.option_id ? [`option:${String(line.option_id)}`] : []), ...(line?.color_id ? [`color:${String(line.color_id)}`] : [])];
  const fields = Array.isArray(policy.history_fields)
    ? (policy.history_fields as unknown[]).filter((k): k is string => typeof k === 'string')
    : policy.buyer_class === 'pro' ? ['pro', 'regular'] : ['regular'];
  const history = line?.product_id && window
    ? ((await db
        .prepare(
          `SELECT h.variant_key, h.field, h.old_iqd, h.new_iqd, h.changed_at, u.name AS author_name, u.email AS author_email
             FROM price_history h LEFT JOIN users u ON u.id = h.changed_by
            WHERE h.product_id = ? AND h.field IN ('regular','prime','pro') AND h.changed_at >= ? AND h.changed_at <= ?
            ORDER BY h.changed_at ASC LIMIT 200`
        )
        .bind(line.product_id, window.from, window.to)
        .all<Record<string, unknown>>()).results ?? [])
    : [];
  const evidence = history
    .filter((h) => (EVIDENCE_FIELDS as readonly string[]).includes(String(h.field)))
    .map((h) => {
      const key = String(h.variant_key ?? '');
      return {
        at: String(h.changed_at),
        key,
        field: String(h.field),
        old_iqd: h.old_iqd === null || h.old_iqd === undefined ? null : Number(h.old_iqd),
        new_iqd: h.new_iqd === null || h.new_iqd === undefined ? null : Number(h.new_iqd),
        author: h.author_name ? String(h.author_name) : null,
        by_owner: isOwner(c.env, { email: String(h.author_email ?? '') }),
        counted: (keys.includes(key) || key.startsWith('sku:')) && fields.includes(String(h.field)),
      };
    });

  const admin = c.get('user')!;
  const financial = canMoveMoney(c.env, admin);
  const owner = isOwner(c.env, admin);
  let figures: DecisionFigures | null = null;
  let blocked: string | null = null;
  try {
    figures = await decisionFigures(db, claim, id);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    blocked = e.code ?? 'DECIDED';
  }
  const priceAuthor = figures ? await approverWrotePrice(c, claim) : false;
  const aboveLine = !!figures && figures.credit > PRICE_PROTECTION_OWNER_LINE_IQD;
  // The approver's own claim (review F5): the owner decides it.
  const beneficiary = claim.user_id === admin.id;
  const ruleChanges = (await memberPriceWrites(db, claim, null)).map((w) => ({
    at: w.at,
    kind: w.kind,
    author: w.author ?? null,
    by_owner: isOwner(c.env, { email: String(w.author_email ?? '') }),
  }));
  return c.json({
    success: true,
    claim: claimForStaff(claim),
    item: line ? { name: line.name_snapshot, variant: line.option_snapshot, qty: Number(line.qty) || 1, product_id: line.product_id } : null,
    order: order ?? null,
    customer: customer ? { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone_e164 ?? null } : null,
    evidence,
    // Member price rules and the PRO pricing policy changed inside the window
    // (who, when, which kind) — the member prices this claim may compare.
    rule_changes: ruleChanges,
    now: figures
      ? { paid_unit_iqd: figures.paid.unit, per_unit_iqd: figures.perUnit, units: figures.coveredQty, prior_credited_iqd: figures.prior, credit_iqd: figures.credit }
      : null,
    blocked,
    // Who may approve THIS claim, for the screen; the decide route judges again.
    approval: {
      financial_scope: financial,
      owner_scope: owner,
      needs_owner: aboveLine || priceAuthor || beneficiary,
      why: beneficiary ? 'beneficiary' : aboveLine ? 'above_line' : priceAuthor ? 'price_author' : null,
    },
    reasons: PRICE_PROTECTION_REASON_CODES,
  });
});

/**
 * Admin decision. Approval credits the wallet idempotently
 * (wtx_pp_<claimId>) and re-applies the cumulative cap at decision time so
 * concurrent claims can never overcompensate the same item.
 */
/**
 * WHO DECIDES (owner decision 3, worker/lib/moneyAuthority.ts; PP-B1). An
 * assistant decides nothing — approving credits a wallet and rejecting ends
 * the customer's claim. A financial admin approves up to the owner line
 * (`PRICE_PROTECTION_OWNER_LINE_IQD`, computed credit); above it, or when the
 * approver wrote a price row of this product inside the claim's window (four
 * eyes), the owner approves, with a reason.
 *
 * THE CUSTOMER IS TOLD (PP-B6): the bell row (ar/en/ckb) is written in the
 * decision's own batch — credited with the amount, or declined with the
 * reason the admin chose from the list (and the note, which the customer also
 * reads). WhatsApp, Telegram and email carry the event and where to read it.
 */
priceProtectionRoutes.post('/admin/claims/:id/decide', requireAdmin, requireMoneyAuthority('price_protection_decide'), async (c) => {
  const admin = c.get('user')!;
  const id = str(c.req.param('id'), 'id', { min: 1, max: 60 });
  const body = await c.req.json().catch(() => ({}));
  const decision = oneOf(body.decision, 'decision', ['approved', 'rejected'] as const);
  const reasonCode =
    decision === 'rejected' && body.reason_code !== undefined && body.reason_code !== null && body.reason_code !== ''
      ? oneOf(body.reason_code, 'reason_code', PRICE_PROTECTION_REASON_CODES)
      : null;
  // A declined claim names its reason: a code from the list, or a note of its own («other» needs the note).
  const noteRequired = decision === 'rejected' && (reasonCode === null || reasonCode === 'other');
  const reason = str(body.reason, 'reason', { min: noteRequired ? 3 : 0, max: 1000, required: noteRequired });

  const claim = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
  if (!claim) throw notFound('Claim not found');
  const nowIso = new Date().toISOString();
  const db = c.env.DB;
  const itemName = itemLabel(
    (await db.prepare('SELECT name_snapshot FROM order_items WHERE id = ?').bind(claim.order_item_id).first<{ name_snapshot: string }>())?.name_snapshot
  );
  // Claims predate ops_guards. Their own state CHECK gives an old-schema-safe
  // transactional fence: this row trips it when the claim is no longer
  // `requested`, and no guard row survives a successful transaction.
  const stillRequested = (extra = '', binds: unknown[] = []) =>
    db.prepare(`INSERT INTO price_protection_claims
      (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
      SELECT ?,?,?,?,0,0,1,'financial_guard' WHERE
        NOT EXISTS(SELECT 1 FROM price_protection_claims WHERE id=? AND state='requested')${extra}`)
      .bind(newId('pp_guard'), claim.user_id, claim.order_id, claim.order_item_id, id, ...binds);

  if (decision === 'rejected') {
    if (claim.state !== 'requested') throw badRequest('This claim was already decided');
    // The decline and the customer's notice land together, or neither (the fence trips on a decided claim).
    const declineBatch = [
      stillRequested(),
      db.prepare(
        `UPDATE price_protection_claims SET state = 'rejected', decided_by = ?, decided_at = ?,
            policy_snapshot = json_set(COALESCE(policy_snapshot, '{}'), '$.decision_reason', ?, '$.decision_reason_code', ?)
          WHERE id = ? AND state = 'requested'`
      ).bind(admin.id, nowIso, reason, reasonCode, id),
      rejectedNotice(db, { userId: claim.user_id, claimId: id, orderId: claim.order_id, item: itemName, reasonCode, note: reason }),
    ];
    try {
      await db.batch(declineBatch);
    } catch (e) {
      if (/CHECK constraint failed:.*state/s.test(String(e))) throw badRequest('This claim was already decided');
      throw e;
    }
    await audit(c.env.DB, admin.id, 'price_protection.reject', id, { reason, reason_code: reasonCode });
    afterResponse(c, tellCustomerOutside(c.env, claim.user_id, id, itemName));
    const row = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
    return c.json({ success: true, claim: claimForStaff(row!) });
  }

  const { coveredQty, tradedUnits, paid, prior, credit } = await decisionFigures(db, claim, id);
  // Which units this credit is FOR (review F7): a unit in a trade-in now
  // received none of it, and its trade-in value must not give back a share.
  const tradedSlots = tradedUnits > 0 ? await tradedSlotsOnLine(db, claim.order_item_id) : [];
  const coveredSlots = tradedSlots.length
    ? untradedSlots(Number((await db.prepare('SELECT qty FROM order_items WHERE id = ?').bind(claim.order_item_id).first<{ qty: number }>())?.qty) || 1, tradedSlots)
    : null;
  const grant = assertMoneyAuthority(c, {
    act: 'price_protection_decide',
    amountIqd: credit,
    ceilingIqd: PRICE_PROTECTION_OWNER_LINE_IQD,
    conflictOfInterest: await approverWrotePrice(c, claim),
    beneficiaryUserId: claim.user_id,
    reason,
  });
  const order = await c.env.DB.prepare('SELECT exchange_rate FROM orders WHERE id = ?')
    .bind(claim.order_id).first<{ exchange_rate: number }>();
  const rate = Math.trunc(Number(order?.exchange_rate)) || 1400;
  const cents = Math.floor((credit * 100) / rate);
  if (!Number.isSafeInteger(credit) || !Number.isSafeInteger(cents) || cents <= 0) {
    throw badRequest(serverMessage('PRICE_PROTECTION_REVIEW_REQUIRED'), 'PRICE_PROTECTION_REVIEW_REQUIRED');
  }
  const ledgerDinars = await walletLedgerDinarsReady(db);
  const guard = stillRequested(
    `
      OR (SELECT COALESCE(SUM(credited_iqd),0) FROM price_protection_claims
        WHERE order_item_id=? AND state IN ('approved','credited') AND id<>?)<>?
      OR EXISTS(SELECT 1 FROM return_cases WHERE order_item_id=? AND ${RETURN_BLOCKS_PROTECTION_SQL})
      OR EXISTS(SELECT 1 FROM price_protection_claims WHERE order_item_id=? AND state='approved' AND id<>?)
      OR (SELECT total_iqd FROM orders WHERE id=?) IS NOT ?
      OR ${tradedUnitsSql(await tradeInInstalled(db))}<>?`,
    [claim.order_item_id, id, prior, claim.order_item_id, claim.order_item_id, id, claim.order_id, paid.orderTotal, claim.order_item_id, tradedUnits]
  );
  try {
    await db.batch([
      guard,
      db.prepare(`UPDATE price_protection_claims SET state='credited', credited_iqd=?, decided_by=?, decided_at=?,
          policy_snapshot = json_set(CASE WHEN json_valid(policy_snapshot) THEN policy_snapshot ELSE '{}' END,
            '$.covered_qty', ?, '$.covered_unit_indexes', json(?))
        WHERE id=? AND state='requested'`).bind(
        credit, admin.id, nowIso, coveredQty,
        coveredSlots ? JSON.stringify(coveredSlots) : 'null',
        id
      ),
      walletCreditStatement(db, ledgerDinars, {
        id: `wtx_pp_${id}`, userId: claim.user_id, cents,
        note: `Price-protection credit for claim ${id} (order ${claim.order_id})`,
        ref: claim.order_id, nowIso, amountIqd: credit, rate,
      }),
      // The customer is told in the same batch: the credit and its notice land together, or neither.
      creditedNotice(db, { userId: claim.user_id, claimId: id, orderId: claim.order_id, item: itemName, creditIqd: credit }),
    ]);
  } catch (e) {
    const message = String(e);
    if (/CHECK constraint failed:.*state/s.test(message)) {
      throw badRequest(serverMessage('PRICE_PROTECTION_RETRY'), 'PRICE_PROTECTION_RETRY');
    }
    if (/UNIQUE constraint|PRIMARY KEY/.test(message)) {
      throw badRequest(serverMessage('PRICE_PROTECTION_REVIEW_REQUIRED'), 'PRICE_PROTECTION_REVIEW_REQUIRED');
    }
    throw e;
  }
  const credited = true;
  if (eventsEnabled(c.env)) {
    await emitFromRequest(c, RefundCompletedV1, {
      ref_type: 'price_protection', ref_id: id, user_id: claim.user_id,
      usd_cents: cents, points: 0, ledger_tx_ids: [`wtx_pp_${id}`], event_key: `wtx_pp_${id}`,
    }, { aggregateId: claim.user_id, actorId: admin.id });
  }

  await audit(c.env.DB, admin.id, 'price_protection.approve', id, { credited_iqd: credit, usd_cents: cents, reason, units: coveredQty, authority: grant.audit });
  afterResponse(c, tellCustomerOutside(c.env, claim.user_id, id, itemName));
  const row = await c.env.DB.prepare('SELECT * FROM price_protection_claims WHERE id = ?').bind(id).first<ClaimRow>();
  return c.json({
    success: true,
    claim: claimForStaff(row!),
    credit: {
      amount_iqd: credit,
      amount_usd_cents: cents,
      credited,
      wallet_tx: `wtx_pp_${id}`,
      channel: 'wallet',
    },
  });
});

/** Best effort after the response; the in-app row is already written in the decision batch. */
function afterResponse(c: Context<AppContext>, work: Promise<void>): void {
  try {
    c.executionCtx.waitUntil(work);
  } catch {
    // No ExecutionContext on this path. The work is already in flight and never rejects.
  }
}

/**
 * WhatsApp, Telegram and email: the event and where to read it, in the
 * customer's language — never the amount or the reason (third-party carriers;
 * the in-app row carries both). Never throws.
 */
async function tellCustomerOutside(env: AppContext['Bindings'], userId: string, claimId: string, item: string): Promise<void> {
  try {
    const row = await env.DB.prepare('SELECT locale FROM users WHERE id = ?').bind(userId).first<{ locale: string | null }>();
    const lang: EmailLang = row?.locale === 'en' ? 'en' : row?.locale === 'ku' || row?.locale === 'ckb' ? 'ckb' : 'ar';
    const t = PRICE_PROTECTION_NOTICES.outbound;
    await notifyCustomer(env, userId, `pp:${claimId}:decided`, { subject: t.subject[lang], body: t.body(item)[lang] });
  } catch (e) {
    console.error('price-protection outbound notice failed for', claimId, e instanceof Error ? e.message : String(e));
  }
}
