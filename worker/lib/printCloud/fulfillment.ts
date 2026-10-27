/**
 * FULFILMENT (docs/PRINT_CLOUD.md §8.1): finished prints and owned material
 * leave the workshop — collected, or delivered home, several jobs in one
 * shipment if the customer likes.
 *
 * The delivery fee is its OWN order (kind 'shipping') through the same
 * payment door as everything else: printing hours never pay for delivery and
 * a delivery fee never touches printing hours. A shipment waits in
 * 'awaiting_payment' until that order is paid; if it expires unpaid, the
 * shipment is cancelled and any material held for it is released, and a
 * shipment cancelled while it waits closes that order in the same batch.
 *
 * Material shipped home is RESERVED when the request is made (so a print
 * cannot use it meanwhile) and leaves the customer's inventory and the
 * workshop shelf when the shipment is handed over — once, fenced.
 */
import { many, one, fence, runBatch, type Planned, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { pcAudit } from './audit';
import { inventoryAccountId, reserveInventory, settleInventory, type InventoryReservationRow } from './inventory';
import { pcNotify } from './notify';
import { closeUnpaidOrder, type OrderRow } from './orders';
import { assertPaymentAvailable, paymentInstructions, type PaymentProvider } from './payments';
import type { PrintCloudConfig } from './settings';
import {
  createShipment,
  deliveryFeeRule,
  LIVE_SHIPMENT_OF_JOB_SQL,
  parseAddress,
  shipmentCancelStatements,
  shipmentInventoryItem,
  shipmentJobItem,
  type DeliveryAddress,
  type ShipmentStatus,
} from './shipments';
import { removePhysical } from './warehouse';
import { addSeconds, iso, pcId, reqInt, reqString } from './util';

function feeOrderStatements(
  db: D1Database,
  p: { userId: string; shipmentId: string; fee: number; provider: PaymentProvider; address: DeliveryAddress; config: PrintCloudConfig; now: Date }
): { orderId: string; statements: Stmt[] } {
  const orderId = pcId('pco');
  const expires = iso(addSeconds(p.now, p.config.stock_hold_minutes * 60));
  return {
    orderId,
    statements: [
      db
        .prepare(
          `INSERT INTO pc_orders (id, user_id, quote_id, kind, status, subtotal_iqd, discount_iqd, total_iqd, payment_method, delivery_address_json, shipment_id,
             stock_hold_expires_at, created_at, updated_at)
           VALUES (?, ?, NULL, 'shipping', 'awaiting_payment', ?, 0, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(orderId, p.userId, p.fee, p.fee, p.provider, JSON.stringify(p.address), p.shipmentId, expires, iso(p.now), iso(p.now)),
      db
        .prepare(
          `INSERT INTO pc_order_lines (id, order_id, line_no, kind, quantity, seconds, final_price_iqd, fulfillment, breakdown_json)
           VALUES (?, ?, 1, 'shipping_fee', 1, 0, ?, 'fee', ?)`
        )
        .bind(pcId('pcol'), orderId, p.fee, JSON.stringify({ governorate: p.address.governorate, shipment_id: p.shipmentId })),
      db
        .prepare("INSERT INTO pc_payments (id, order_id, provider, amount_iqd, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
        .bind(pcId('pcpay'), orderId, p.provider, p.fee, iso(p.now)),
    ],
  };
}

export interface DeliveryRequest {
  kind: 'pickup' | 'delivery';
  job_ids: string[];
  items: Array<{ variant_id: string; qty: number }>;
  address: unknown;
  packaging: string;
  provider: PaymentProvider;
}

export function parseDeliveryRequest(body: Record<string, unknown>): DeliveryRequest {
  const kind = body.kind;
  if (kind !== 'pickup' && kind !== 'delivery') throw invalid('kind', 'not_allowed');
  const jobIds = body.job_ids === undefined ? [] : body.job_ids;
  if (!Array.isArray(jobIds) || jobIds.length > 50 || jobIds.some((j) => typeof j !== 'string')) throw invalid('job_ids', 'array_required');
  const rawItems = body.items === undefined ? [] : body.items;
  if (!Array.isArray(rawItems) || rawItems.length > 30) throw invalid('items', 'array_required');
  const items = rawItems.map((it, i) => {
    const o = (it ?? {}) as Record<string, unknown>;
    return { variant_id: reqString(o.variant_id, `items[${i}].variant_id`, { max: 120 }), qty: reqInt(o.qty, `items[${i}].qty`, { min: 1, max: 100_000_000 }) };
  });
  if (!jobIds.length && !items.length) throw invalid('job_ids', 'nothing_to_ship');
  if (new Set(items.map((i) => i.variant_id)).size !== items.length) throw invalid('items', 'duplicate_variant');
  const packaging = typeof body.packaging === 'string' && /^[a-z_]{1,30}$/.test(body.packaging) ? body.packaging : 'standard';
  const provider = (body.payment_method ?? 'manual') as PaymentProvider;
  return { kind, job_ids: [...new Set(jobIds as string[])], items, address: body.delivery_address, packaging, provider };
}

/**
 * What a pickup or delivery request IS, read and judged the one way both doors
 * use: POST /shipments plans its batch from it, POST /shipments/quote answers
 * it — so a quote states exactly the fee, the start and the items the request
 * would get, and refuses exactly what the request would refuse. Reads only.
 *
 *   - the kind must be one the workshop offers now (`delivery.enabled`,
 *     `delivery.pickup_enabled`);
 *   - a print must be the customer's, completed, and on NO live shipment — a
 *     second request for it is refused ALREADY_IN_SHIPMENT naming the one it
 *     is on (a print handed over stays on its shipment; a cancelled shipment
 *     frees it). The batch re-checks it (`planShipmentRequest`), so a race
 *     cannot put it on two;
 *   - material must be of a variant that may leave the workshop, and the
 *     customer must have that much free (the reservation's CHECK re-checks it
 *     in the batch);
 *   - a delivery's fee is the governorate's own when the owner set one, else
 *     the flat fee (`deliveryFeeRule`), and a fee needs its payment method to
 *     be available.
 */
export interface ShipmentAssessment {
  kind: 'pickup' | 'delivery';
  address: DeliveryAddress | null;
  fee: number;
  /** What set the fee: a pickup is free; a delivery pays its governorate's own fee, or the flat one. */
  feeRule: 'pickup' | 'governorate' | 'flat';
  /** Where the shipment would start: waiting for its fee, or being prepared. */
  status: ShipmentStatus;
  jobs: Array<{ job_id: string; title: string }>;
  items: Array<{ variant_id: string; qty: number; unit_code: string; available_qty: number }>;
}

export async function assessShipmentRequest(
  db: D1Database,
  env: Record<string, unknown>,
  userId: string,
  req: DeliveryRequest,
  config: PrintCloudConfig
): Promise<ShipmentAssessment> {
  if (req.kind === 'pickup' && !config.delivery.pickup_enabled) throw pcError('DELIVERY_NOT_AVAILABLE', { reason: 'pickup_disabled' });
  if (req.kind === 'delivery' && !config.delivery.enabled) throw pcError('DELIVERY_NOT_AVAILABLE', { reason: 'delivery_disabled' });
  const jobs: ShipmentAssessment['jobs'] = [];
  for (const id of req.job_ids) {
    const j = await one<{ status: string; title: string; on_shipment: string | null }>(
      db,
      `SELECT j.status, j.title, ${LIVE_SHIPMENT_OF_JOB_SQL} AS on_shipment FROM pc_print_jobs j WHERE j.id = ? AND j.user_id = ?`,
      id,
      userId
    );
    if (!j) throw pcError('NOT_FOUND', { field: 'job_ids', job_id: id });
    if (j.status !== 'completed') throw pcError('INVALID_TRANSITION', { job_id: id, status: j.status, reason: 'only_completed_prints_ship' });
    if (j.on_shipment) throw pcError('ALREADY_IN_SHIPMENT', { job_id: id, shipment_id: j.on_shipment });
    jobs.push({ job_id: id, title: j.title });
  }
  const items: ShipmentAssessment['items'] = [];
  for (const it of req.items) {
    const v = await one<{ fulfillment_modes_json: string; unit_code: string; available_qty: number | null }>(
      db,
      `SELECT v.fulfillment_modes_json, v.unit_code, a.available_qty
         FROM pc_variants v JOIN pc_products p ON p.id = v.product_id JOIN pc_product_categories c ON c.code = p.category_code
         LEFT JOIN pc_inventory_accounts a ON a.id = ?
        WHERE v.id = ?`,
      inventoryAccountId(userId, it.variant_id),
      it.variant_id
    );
    if (!v) throw pcError('NOT_FOUND', { field: 'items', variant_id: it.variant_id });
    if (!(JSON.parse(v.fulfillment_modes_json) as string[]).includes('delivery')) throw pcError('DELIVERY_NOT_AVAILABLE', { variant_id: it.variant_id });
    const available = Number(v.available_qty ?? 0);
    if (it.qty > available) throw pcError('INSUFFICIENT_INVENTORY', { variant_id: it.variant_id, available });
    items.push({ variant_id: it.variant_id, qty: it.qty, unit_code: v.unit_code, available_qty: available });
  }
  const address = req.kind === 'delivery' ? parseAddress(req.address) : null;
  const priced = address ? deliveryFeeRule(config, address.governorate) : { fee: 0, rule: 'pickup' as const };
  if (priced.fee > 0) assertPaymentAvailable(env, req.provider, config);
  return { kind: req.kind, address, fee: priced.fee, feeRule: priced.rule, status: priced.fee > 0 ? 'awaiting_payment' : 'preparing', jobs, items };
}

/**
 * POST /shipments/quote: the assessment above, as the customer reads it before
 * confirming — nothing is written, reserved or ordered.
 */
export async function quoteShipmentRequest(db: D1Database, env: Record<string, unknown>, userId: string, req: DeliveryRequest, config: PrintCloudConfig) {
  const a = await assessShipmentRequest(db, env, userId, req, config);
  return {
    kind: a.kind,
    fee_iqd: a.fee,
    fee_rule: a.feeRule,
    governorate: a.address?.governorate ?? null,
    // Where the request would start: `awaiting_payment` (a fee order of its own comes with it) or `preparing`.
    status: a.status,
    payment_method: a.fee > 0 ? req.provider : null,
    packaging: req.packaging,
    jobs: a.jobs,
    items: a.items,
    available: { pickup: config.delivery.pickup_enabled, delivery: config.delivery.enabled },
  };
}

/**
 * One shipment for some finished prints and/or some owned material.
 * Pickup is free; delivery carries its fee as a separate shipping order.
 *
 * Planned from the assessment, and fenced in its batch: each print is taken
 * only while it is completed and on no shipment (the job's CAS, then a fence
 * that it now names THIS shipment), and its live item collides with any other
 * live item of it (`uq_pc_shipment_items_job`). Two requests racing for one
 * print therefore make one shipment: the loser's batch fails, `idempotent`
 * plans it again, and the re-plan refuses ALREADY_IN_SHIPMENT.
 */
export async function planShipmentRequest(
  db: D1Database,
  env: Record<string, unknown>,
  userId: string,
  req: DeliveryRequest,
  config: PrintCloudConfig,
  now: Date
): Promise<Planned<{ shipment_id: string; status: ShipmentStatus; fee_iqd: number; fee_order_id: string | null; payment: unknown }>> {
  const a = await assessShipmentRequest(db, env, userId, req, config);
  const { address, fee, status } = a;
  const shipment = createShipment(db, { userId, kind: a.kind, status, address, feeIqd: fee, feeOrderId: null, packaging: req.packaging, now });
  const s: Stmt[] = [shipment.statement];
  let feeOrderId: string | null = null;
  if (fee > 0 && address) {
    const fo = feeOrderStatements(db, { userId, shipmentId: shipment.id, fee, provider: req.provider, address, config, now });
    feeOrderId = fo.orderId;
    s.push(...fo.statements, db.prepare('UPDATE pc_shipments SET fee_order_id = ? WHERE id = ?').bind(fo.orderId, shipment.id));
  }
  for (const { job_id: id } of a.jobs) {
    s.push(
      db
        .prepare("UPDATE pc_print_jobs SET shipment_id = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'completed' AND shipment_id IS NULL")
        .bind(shipment.id, iso(now), id, userId),
      fence(db, 'STATE_CHANGED', '(SELECT shipment_id FROM pc_print_jobs WHERE id = ?) = ?', [id, shipment.id]),
      shipmentJobItem(db, shipment.id, id)
    );
  }
  for (const it of a.items) {
    const r = reserveInventory(db, { userId, variantId: it.variant_id, qty: it.qty, purpose: 'delivery', refId: shipment.id, actorId: userId, now });
    s.push(...r.statements, shipmentInventoryItem(db, shipment.id, r.reservationId, it.variant_id, it.qty));
  }
  s.push(...(await pcAudit(db, userId, 'shipment.request', shipment.id, { kind: a.kind, jobs: req.job_ids, items: req.items, fee_iqd: fee })));
  return {
    statements: s,
    result: {
      shipment_id: shipment.id,
      status,
      fee_iqd: fee,
      fee_order_id: feeOrderId,
      payment: feeOrderId ? paymentInstructions(req.provider, { id: feeOrderId, total_iqd: fee }) : null,
    },
  };
}

const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, readonly ShipmentStatus[]> = {
  awaiting_payment: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'shipped', 'cancelled'],
  ready_for_pickup: ['picked_up', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  picked_up: [],
  cancelled: [],
};

interface ShipmentRow {
  id: string;
  user_id: string;
  kind: string;
  status: ShipmentStatus;
  fee_order_id: string | null;
}

const SHIPMENT_SELECT = 'SELECT id, user_id, kind, status, fee_order_id FROM pc_shipments WHERE id = ?';

interface AdvanceInput {
  carrier?: string;
  tracking_ref?: string;
  note?: string;
  actorId: string;
  now: Date;
}

/**
 * Move a shipment along. Handing it over (shipped, picked up) settles every
 * material item — out of the customer's inventory and off the workshop
 * shelf — in the same batch as the status flip.
 */
export async function advanceShipment(db: D1Database, shipmentId: string, to: ShipmentStatus, p: AdvanceInput) {
  const sh = await one<ShipmentRow>(db, SHIPMENT_SELECT, shipmentId);
  if (!sh) throw pcError('NOT_FOUND');
  return advanceFrom(db, sh, to, p);
}

/** One transition, planned from ONE read of the shipment and fenced on it. */
async function advanceFrom(db: D1Database, sh: ShipmentRow, to: ShipmentStatus, p: AdvanceInput) {
  if (!SHIPMENT_TRANSITIONS[sh.status].includes(to)) throw pcError('INVALID_TRANSITION', { from: sh.status, to });
  if (to === 'awaiting_payment' || (sh.status === 'awaiting_payment' && to === 'preparing')) throw pcError('INVALID_TRANSITION', { reason: 'paid_through_the_fee_order' });
  if (to === 'ready_for_pickup' && sh.kind !== 'pickup') throw pcError('INVALID_TRANSITION', { reason: 'not_a_pickup' });
  if (to === 'shipped' && sh.kind !== 'delivery') throw pcError('INVALID_TRANSITION', { reason: 'not_a_delivery' });
  const feeOrder = sh.status === 'awaiting_payment' && to === 'cancelled' && sh.fee_order_id ? await one<OrderRow>(db, 'SELECT * FROM pc_orders WHERE id = ?', sh.fee_order_id) : null;
  // A fee order that was paid moved (or is moving) the shipment on: refuse. One already closed unpaid —
  // a state an older two-step cancellation could leave — has nothing left to close: the plain path below cancels.
  if (feeOrder && !['awaiting_payment', 'cancelled', 'expired'].includes(feeOrder.status)) throw pcError('STATE_CHANGED');
  if (feeOrder && feeOrder.status === 'awaiting_payment') {
    // Still waiting for its fee: the fee order is closed in the SAME batch,
    // and closing it cancels this shipment and releases what it held
    // (closeUnpaidOrder). Cancelling the shipment alone would leave the fee
    // payable for a delivery that will never happen. The order flip is
    // op_token fenced, so a payment that lands first makes this refuse.
    const order = feeOrder;
    await runBatch(db, [
      ...(await closeUnpaidOrder(db, order, 'cancelled', p.actorId, p.now, p.note ?? 'shipment cancelled')),
      fence(db, 'STATE_CHANGED', '(SELECT status FROM pc_shipments WHERE id = ?) = ?', [sh.id, 'cancelled']),
      db
        .prepare('UPDATE pc_shipments SET carrier = COALESCE(?, carrier), tracking_ref = COALESCE(?, tracking_ref), notes = COALESCE(?, notes) WHERE id = ?')
        .bind(p.carrier ?? null, p.tracking_ref ?? null, p.note ?? null, sh.id),
      ...(await pcAudit(db, p.actorId, 'shipment.advance', sh.id, { from: sh.status, to, tracking_ref: p.tracking_ref ?? null, fee_order_id: order.id })),
    ]);
    return { shipment_id: sh.id, status: to };
  }
  const s: Stmt[] = [
    db
      .prepare(
        `UPDATE pc_shipments SET status = ?, carrier = COALESCE(?, carrier), tracking_ref = COALESCE(?, tracking_ref), notes = COALESCE(?, notes),
                updated_at = ?, closed_at = CASE WHEN ? IN ('delivered', 'picked_up', 'cancelled') THEN ? ELSE closed_at END
          WHERE id = ? AND status = ?`
      )
      .bind(to, p.carrier ?? null, p.tracking_ref ?? null, p.note ?? null, iso(p.now), to, iso(p.now), sh.id, sh.status),
    fence(db, 'STATE_CHANGED', '(SELECT status FROM pc_shipments WHERE id = ?) = ?', [sh.id, to]),
  ];
  if (to === 'shipped' || to === 'picked_up') {
    const holds = await many<InventoryReservationRow>(
      db,
      "SELECT id, account_id, user_id, variant_id, purpose, ref_id, qty_reserved, qty_consumed, qty_released, state FROM pc_inventory_reservations WHERE purpose = 'delivery' AND ref_id = ? AND state = 'active'",
      sh.id
    );
    for (const r of holds) {
      const out = await settleInventory(db, r, r.qty_reserved, { type: 'deliver', policy: 'cap_at_reserved', actorId: p.actorId, now: p.now, note: `shipment ${sh.id}` });
      s.push(...out.statements);
      s.push(
        ...(
          await removePhysical(db, {
            variantId: r.variant_id,
            qty: r.qty_reserved,
            type: 'ship_out',
            fromAllocated: true,
            userId: r.user_id,
            refType: 'shipment',
            refId: sh.id,
            entryKey: `ship_out:${sh.id}:${r.variant_id}`,
            actorId: p.actorId,
            now: p.now,
          })
        ).statements
      );
    }
  }
  if (to === 'cancelled') s.push(...(await shipmentCancelStatements(db, sh.id, p.actorId, p.now)));
  if (to === 'ready_for_pickup' || to === 'shipped') {
    s.push(
      pcNotify(db, {
        userId: sh.user_id,
        notice: to === 'shipped' ? 'shipment_shipped' : 'shipment_ready',
        entity: 'print_cloud_shipment',
        entityId: sh.id,
        link: `/account/shipments/${sh.id}`,
        eventKey: `${to}:${sh.id}`,
      })
    );
  }
  s.push(...(await pcAudit(db, p.actorId, 'shipment.advance', sh.id, { from: sh.status, to, tracking_ref: p.tracking_ref ?? null })));
  await runBatch(db, s);
  return { shipment_id: sh.id, status: to };
}

/**
 * The customer cancels a shipment before it leaves the workshop (materials
 * released). One batch, planned from the state the customer saw: an unpaid
 * fee order is closed with it, and a fee paid meanwhile makes it refuse.
 *
 * A shipment whose delivery fee is PAID (preparing with a fee — paid through
 * its fee order, or as a line of the store order that bought it) is not the
 * customer's to cancel: cancelling would keep the fee without a word. The
 * workshop cancels it and decides the fee's refund (admin advance + refund).
 */
export async function cancelShipmentByCustomer(db: D1Database, userId: string, shipmentId: string, now: Date) {
  const sh = await one<ShipmentRow & { fee_iqd: number }>(db, 'SELECT id, user_id, kind, status, fee_order_id, fee_iqd FROM pc_shipments WHERE id = ? AND user_id = ?', shipmentId, userId);
  if (!sh) throw pcError('NOT_FOUND');
  if (sh.status !== 'awaiting_payment' && sh.status !== 'preparing') throw pcError('INVALID_TRANSITION', { from: sh.status, to: 'cancelled' });
  if (sh.status === 'preparing' && Number(sh.fee_iqd) > 0) throw pcError('INVALID_TRANSITION', { from: sh.status, to: 'cancelled', reason: 'delivery_fee_paid', action: 'ask_workshop' });
  // The batch is fenced on the status read here: a fee paid meanwhile moves it to preparing, and the batch refuses.
  return advanceFrom(db, sh, 'cancelled', { actorId: userId, now, note: 'cancelled by customer' });
}

export async function shipmentView(db: D1Database, shipmentId: string, userId?: string) {
  const sh = await one<Record<string, unknown>>(db, `SELECT * FROM pc_shipments WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`, ...(userId ? [shipmentId, userId] : [shipmentId]));
  if (!sh) throw pcError('NOT_FOUND');
  const items = await many<Record<string, unknown>>(db, 'SELECT id, item_type, job_id, variant_id, qty, live FROM pc_shipment_items WHERE shipment_id = ?', shipmentId);
  return { ...sh, address: sh.address_json ? JSON.parse(String(sh.address_json)) : null, address_json: undefined, items };
}

