/**
 * QUOTES, ORDERS, PAYMENT FULFILMENT AND REFUNDS (docs/PRINT_CLOUD.md §4).
 *
 *   quote  → priced on the server, stored with an expiry; reserves nothing.
 *   order  → created ONCE from an open quote (pc_orders.quote_id is UNIQUE).
 *            Its batch holds the workshop stock every material line needs,
 *            fenced so the same last grams can never be held twice, counts
 *            promotion redemptions against their cap and checks per-customer
 *            limits AFTER its own lines are written.
 *   paid   → `confirmPayment` records the provider's event once per
 *            (provider, event id) and fulfils the order once: the status flip
 *            is fenced, every grant carries an entry key named after its
 *            order line, a second confirmed payment collides on a unique
 *            index. Credits, inventory lots, stock allocations, the delivery
 *            shipment, the notification, the audit row and the integration
 *            events all land in that one batch — or none of them do.
 *   cancel/expire → holds released, redemptions returned, exactly once.
 *   wallet → `planWalletPayment`: the Levonis wallet debit, the confirmation
 *            and the fulfilment in ONE batch, under the customer's key.
 *   refund → only what the customer still holds unused: unconsumed seconds of
 *            that purchase's lot, ungranted grams of that purchase's lot. An
 *            order paid from the wallet is refunded INTO the wallet, in the
 *            refund's batch (wallet.ts `planWalletRefundCredit`).
 */
import { sha256Hex } from '../crypto';
import { many, one, fence, idempotent, runBatch, type Outcome, type Planned, type Stmt } from './db';
import { classifyDbError, invalid, pcError } from './errors';
import { integrationEvent, membershipTier } from './adapters';
import { pcAudit } from './audit';
import { grantCredits, debitAvailable, freeSecondsAt } from './credits';
import { grantInventory, reserveInventory, debitInventory } from './inventory';
import { pcNotify } from './notify';
import { assertPaymentAvailable, paymentInstructions, type PaymentProvider } from './payments';
import { priceQuote, type PricedLine, type PricedQuote, type QuoteLineInput } from './pricing';
import type { PrintCloudConfig } from './settings';
import { createShipment, deliveryFee, parseAddress, shipmentCancelStatements, shipmentInventoryItem, type DeliveryAddress } from './shipments';
import { activeHolds, convertHoldToAllocation, deallocate, holdStock, releaseHold } from './warehouse';
import { addSeconds, canonicalJson, iso, mulDivRound, parseJson, pcId } from './util';
import {
  insufficientBalance,
  planWalletRefundCredit,
  walletChargeCents,
  walletDebitStatement,
  walletDebitTxId,
  walletPayability,
  walletPaymentEventId,
  walletPaymentRefusal,
  walletPosition,
  type WalletRefundCredit,
} from './wallet';

export interface StoredQuote extends PricedQuote {
  quote_id: string;
  expires_at: string;
  created_at: string;
}

/** Price and store a quote. Nothing is reserved. */
export async function createQuote(
  db: D1Database,
  p: { userId: string; inputs: QuoteLineInput[]; coupon: string | null; config: PrintCloudConfig; now: Date }
): Promise<StoredQuote> {
  const priced = await priceQuote(db, p.inputs, {
    userId: p.userId,
    config: p.config,
    now: p.now,
    coupon: p.coupon,
    membership: await membershipTier(db, p.userId),
  });
  const quoteId = pcId('pcq');
  const expiresAt = iso(addSeconds(p.now, p.config.quote_ttl_minutes * 60));
  const stored: StoredQuote = { ...priced, quote_id: quoteId, expires_at: expiresAt, created_at: iso(p.now) };
  const statements: Stmt[] = [
    db
      .prepare(
        `INSERT INTO pc_quotes (id, user_id, status, subtotal_iqd, discount_iqd, total_iqd, promotion_ids_json, snapshot_json, expires_at, created_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        quoteId,
        p.userId,
        priced.subtotal_iqd,
        priced.discount_iqd,
        priced.total_iqd,
        JSON.stringify(priced.promotions.map((x) => x.id)),
        JSON.stringify(stored),
        expiresAt,
        iso(p.now)
      ),
  ];
  for (const l of priced.lines) {
    statements.push(
      db
        .prepare(
          `INSERT INTO pc_quote_lines (id, quote_id, line_no, kind, tier_id, package_id, variant_id, quantity, seconds, base_price_iqd,
             discount_iqd, final_price_iqd, fulfillment, project_id, breakdown_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          pcId('pcql'),
          quoteId,
          l.line_no,
          l.kind,
          l.tier_id,
          l.package_id,
          l.variant_id,
          l.quantity,
          l.seconds,
          l.base_price_iqd,
          l.discount_iqd,
          l.final_price_iqd,
          l.fulfillment,
          l.project_id,
          JSON.stringify({ ...l.breakdown, bundle: l.bundle })
        )
    );
  }
  await runBatch(db, statements);
  return stored;
}

export interface OrderLineRow {
  id: string;
  order_id: string;
  line_no: number;
  kind: 'credit_package' | 'credit_hours' | 'material' | 'shipping_fee';
  tier_id: string | null;
  package_id: string | null;
  variant_id: string | null;
  quantity: number;
  seconds: number;
  final_price_iqd: number;
  refunded_iqd: number;
  fulfillment: 'credits' | 'inventory' | 'delivery' | 'project' | 'fee';
  project_id: string | null;
  expires_after_days: number | null;
  breakdown_json: string;
}

export interface OrderRow {
  id: string;
  user_id: string;
  quote_id: string | null;
  kind: 'purchase' | 'shipping';
  status: string;
  subtotal_iqd: number;
  discount_iqd: number;
  total_iqd: number;
  paid_iqd: number;
  refunded_iqd: number;
  payment_method: PaymentProvider;
  promotion_ids_json: string;
  delivery_address_json: string | null;
  shipment_id: string | null;
  stock_hold_expires_at: string;
  created_at: string;
  paid_at: string | null;
  fulfilled_at: string | null;
}

export interface OrderSummary {
  order_id: string;
  status: string;
  total_iqd: number;
  subtotal_iqd: number;
  discount_iqd: number;
  shipping_fee_iqd: number;
  payment_method: PaymentProvider;
  stock_hold_expires_at: string;
  lines: Array<{ line_no: number; kind: string; quantity: number; seconds: number; final_price_iqd: number; fulfillment: string; variant_id: string | null; package_id: string | null; tier_id: string | null }>;
  payment: ReturnType<typeof paymentInstructions>;
}

/**
 * Plan the order a quote becomes. Read-only until its batch runs; the caller
 * runs it under the customer's idempotency key (db.ts `idempotent`).
 */
export async function planOrderFromQuote(
  db: D1Database,
  env: Record<string, unknown>,
  p: { userId: string; quoteId: string; provider: PaymentProvider; deliveryAddress: unknown; config: PrintCloudConfig; now: Date }
): Promise<Planned<OrderSummary>> {
  assertPaymentAvailable(env, p.provider, p.config);
  const quote = await one<{ id: string; user_id: string; status: string; expires_at: string; snapshot_json: string; promotion_ids_json: string }>(
    db,
    'SELECT id, user_id, status, expires_at, snapshot_json, promotion_ids_json FROM pc_quotes WHERE id = ?',
    p.quoteId
  );
  if (!quote || quote.user_id !== p.userId) throw pcError('NOT_FOUND');
  if (quote.status === 'ordered') throw pcError('QUOTE_ALREADY_ORDERED');
  if (quote.status !== 'open' || quote.expires_at <= iso(p.now)) throw pcError('QUOTE_EXPIRED');
  const snapshot = JSON.parse(quote.snapshot_json) as StoredQuote;
  const lines = snapshot.lines;
  const needsDelivery = lines.some((l) => l.fulfillment === 'delivery');
  let address: DeliveryAddress | null = null;
  let fee = 0;
  if (needsDelivery) {
    if (!p.config.delivery.enabled) throw pcError('DELIVERY_NOT_AVAILABLE');
    address = parseAddress(p.deliveryAddress);
    fee = deliveryFee(p.config, address.governorate);
  }
  const orderId = pcId('pco');
  const holdExpires = addSeconds(p.now, p.config.stock_hold_minutes * 60);
  const total = snapshot.total_iqd + fee;
  const statements: Stmt[] = [
    db.prepare("UPDATE pc_quotes SET status = 'ordered' WHERE id = ? AND status = 'open'").bind(quote.id),
    db
      .prepare(
        `INSERT INTO pc_orders (id, user_id, quote_id, kind, status, subtotal_iqd, discount_iqd, total_iqd, payment_method, promotion_ids_json,
           delivery_address_json, stock_hold_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'purchase', 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        orderId,
        p.userId,
        quote.id,
        snapshot.subtotal_iqd + fee,
        snapshot.discount_iqd,
        total,
        p.provider,
        quote.promotion_ids_json,
        address ? JSON.stringify(address) : null,
        iso(holdExpires),
        iso(p.now),
        iso(p.now)
      ),
  ];
  const summaryLines: OrderSummary['lines'] = [];
  const holdQty = new Map<string, number>();
  const addHold = (variantId: string, qty: number) => holdQty.set(variantId, (holdQty.get(variantId) ?? 0) + qty);
  const lineInsert = (l: {
    no: number;
    kind: OrderLineRow['kind'];
    tier: string | null;
    pkg: string | null;
    variant: string | null;
    quantity: number;
    seconds: number;
    price: number;
    fulfillment: OrderLineRow['fulfillment'];
    project: string | null;
    expires: number | null;
    breakdown: Record<string, unknown>;
  }) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO pc_order_lines (id, order_id, line_no, kind, tier_id, package_id, variant_id, quantity, seconds, final_price_iqd,
             fulfillment, project_id, expires_after_days, breakdown_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(pcId('pcol'), orderId, l.no, l.kind, l.tier, l.pkg, l.variant, l.quantity, l.seconds, l.price, l.fulfillment, l.project, l.expires, JSON.stringify(l.breakdown))
    );
    summaryLines.push({ line_no: l.no, kind: l.kind, quantity: l.quantity, seconds: l.seconds, final_price_iqd: l.price, fulfillment: l.fulfillment, variant_id: l.variant, package_id: l.pkg, tier_id: l.tier });
  };
  for (const l of lines) {
    lineInsert({
      no: l.line_no,
      kind: l.kind,
      tier: l.tier_id,
      pkg: l.package_id,
      variant: l.variant_id,
      quantity: l.quantity,
      seconds: l.seconds,
      price: l.final_price_iqd,
      fulfillment: l.fulfillment,
      project: l.project_id,
      expires: l.expires_after_days,
      breakdown: { ...l.breakdown, base_price_iqd: l.base_price_iqd, discount_iqd: l.discount_iqd, bundle: l.bundle },
    });
    if (l.kind === 'material' && l.variant_id) addHold(l.variant_id, l.quantity);
    for (const b of l.bundle) addHold(b.variant_id, b.qty);
  }
  if (fee > 0 || needsDelivery) {
    lineInsert({
      no: lines.length + 1,
      kind: 'shipping_fee',
      tier: null,
      pkg: null,
      variant: null,
      quantity: 1,
      seconds: 0,
      price: fee,
      fulfillment: 'fee',
      project: null,
      expires: null,
      breakdown: { governorate: address?.governorate ?? '' },
    });
  }
  for (const [variantId, qty] of holdQty) {
    statements.push(...holdStock(db, { orderId, variantId, qty, expiresAt: holdExpires, actorId: p.userId, now: p.now }));
  }
  // Per-customer caps, checked AFTER this order's own lines exist, inside the
  // same transaction: two concurrent orders cannot both squeeze under a cap.
  for (const pkgId of new Set(lines.filter((l) => l.package_id).map((l) => l.package_id as string))) {
    const pkg = await one<{ max_per_customer: number | null }>(db, 'SELECT max_per_customer FROM pc_credit_packages WHERE id = ?', pkgId);
    if (pkg?.max_per_customer !== null && pkg?.max_per_customer !== undefined) {
      statements.push(
        fence(
          db,
          'LIMIT_REACHED',
          `(SELECT COALESCE(SUM(l.quantity), 0) FROM pc_order_lines l JOIN pc_orders o ON o.id = l.order_id
             WHERE o.user_id = ? AND l.package_id = ? AND o.status IN ('awaiting_payment', 'fulfilled', 'partially_refunded')) <= ?`,
          [p.userId, pkgId, pkg.max_per_customer]
        )
      );
    }
  }
  for (const variantId of new Set(lines.filter((l) => l.kind === 'material' && l.variant_id).map((l) => l.variant_id as string))) {
    const v = await one<{ max_per_customer_qty: number | null }>(db, 'SELECT max_per_customer_qty FROM pc_variants WHERE id = ?', variantId);
    if (v?.max_per_customer_qty !== null && v?.max_per_customer_qty !== undefined) {
      statements.push(
        fence(
          db,
          'LIMIT_REACHED',
          `(SELECT COALESCE(SUM(l.quantity), 0) FROM pc_order_lines l JOIN pc_orders o ON o.id = l.order_id
             WHERE o.user_id = ? AND l.variant_id = ? AND l.kind = 'material' AND o.status IN ('awaiting_payment', 'fulfilled', 'partially_refunded')) <= ?`,
          [p.userId, variantId, v.max_per_customer_qty]
        )
      );
    }
  }
  for (const promoId of parseJson<string[]>(quote.promotion_ids_json, [])) {
    statements.push(db.prepare('UPDATE pc_promotions SET redemptions = redemptions + 1, updated_at = ? WHERE id = ?').bind(iso(p.now), promoId));
  }
  statements.push(
    db
      .prepare("INSERT INTO pc_payments (id, order_id, provider, amount_iqd, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .bind(pcId('pcpay'), orderId, p.provider, total, iso(p.now))
  );
  statements.push(...(await pcAudit(db, p.userId, 'order.create', orderId, { quote_id: quote.id, total_iqd: total, provider: p.provider })));
  return {
    statements,
    result: {
      order_id: orderId,
      status: 'awaiting_payment',
      total_iqd: total,
      subtotal_iqd: snapshot.subtotal_iqd + fee,
      discount_iqd: snapshot.discount_iqd,
      shipping_fee_iqd: fee,
      payment_method: p.provider,
      stock_hold_expires_at: iso(holdExpires),
      lines: summaryLines,
      payment: paymentInstructions(p.provider, { id: orderId, total_iqd: total }),
    },
  };
}

// ------------------------------------------------------------------ payment confirmation

export type PaymentOutcome = 'applied' | 'duplicate_event' | 'duplicate_order' | 'amount_mismatch' | 'order_not_payable' | 'unknown_order';

export interface ConfirmInput {
  provider: PaymentProvider;
  eventId: string;
  orderId: string;
  amountIqd: number;
  actorId: string;
  payloadHash: string;
  now: Date;
}

function eventInsert(db: D1Database, p: ConfirmInput, outcome: Exclude<PaymentOutcome, 'duplicate_event'>, orderKnown: boolean): Stmt {
  return db
    .prepare(
      `INSERT INTO pc_payment_events (id, provider, provider_event_id, order_id, amount_iqd, outcome, payload_hash, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(pcId('pcpe'), p.provider, p.eventId, orderKnown ? p.orderId : null, p.amountIqd, outcome, p.payloadHash, iso(p.now));
}

/** The credit and material shares of a (possibly discounted) bundle line, exact to the dinar. */
function bundleShares(line: OrderLineRow): { creditsPaid: number; items: Array<{ variant_id: string; qty: number; paid: number }> } {
  const breakdown = parseJson<{ bundle?: Array<{ variant_id: string; qty: number; value_iqd: number }>; base_price_iqd?: number }>(line.breakdown_json, {});
  const bundle = breakdown.bundle ?? [];
  if (!bundle.length) return { creditsPaid: line.final_price_iqd, items: [] };
  const base = Math.max(1, Number(breakdown.base_price_iqd ?? line.final_price_iqd));
  const items = bundle.map((b) => ({ variant_id: b.variant_id, qty: b.qty, paid: mulDivRound(b.value_iqd, line.final_price_iqd, base) }));
  const materials = items.reduce((s, i) => s + i.paid, 0);
  return { creditsPaid: Math.max(0, line.final_price_iqd - materials), items };
}

/**
 * Every statement that turns a paid order into the customer's balances, the
 * payment event and the confirmed payment row first — fenced on the order
 * still awaiting payment, so a batch that carries them lands only for an
 * order nobody else confirmed, cancelled or expired meanwhile.
 * `confirmPayment` runs them alone; the wallet adapter runs them in the same
 * batch as its debit (`planWalletPayment`).
 */
async function fulfillmentStatements(db: D1Database, order: OrderRow, p: ConfirmInput): Promise<Stmt[]> {
  const lines = await many<OrderLineRow>(db, 'SELECT * FROM pc_order_lines WHERE order_id = ? ORDER BY line_no', order.id);
  const holds = await activeHolds(db, order.id);
  const token = pcId('tok');
  const s: Stmt[] = [
    eventInsert(db, p, 'applied', true),
    db
      .prepare(
        `UPDATE pc_orders SET status = 'fulfilled', paid_iqd = total_iqd, paid_at = ?, fulfilled_at = ?, updated_at = ?, op_token = ?
          WHERE id = ? AND status = 'awaiting_payment'`
      )
      .bind(iso(p.now), iso(p.now), iso(p.now), token, order.id),
    fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_orders WHERE id = ?) = ?', [order.id, token]),
    db.prepare("UPDATE pc_payments SET status = 'rejected' WHERE order_id = ? AND status = 'pending'").bind(order.id),
    db
      .prepare(
        "INSERT INTO pc_payments (id, order_id, provider, provider_ref, amount_iqd, status, created_at, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)"
      )
      .bind(pcId('pcpay'), order.id, p.provider, p.eventId.slice(0, 200), p.amountIqd, iso(p.now), iso(p.now), p.actorId),
  ];
  for (const hold of holds) s.push(...convertHoldToAllocation(db, hold, order.user_id, p.actorId, p.now));
  if (order.kind === 'shipping') {
    // A delivery fee paid: its shipment may now be prepared — only one still
    // waiting for this fee. A shipment cancelled meanwhile fails the fence;
    // confirmPayment re-reads and records the payment for the refund desk.
    s.push(
      db
        .prepare("UPDATE pc_shipments SET status = 'preparing', updated_at = ? WHERE fee_order_id = ? AND status = 'awaiting_payment'")
        .bind(iso(p.now), order.id),
      fence(db, 'STATE_CHANGED', "EXISTS (SELECT 1 FROM pc_shipments WHERE fee_order_id = ? AND status = 'preparing')", [order.id])
    );
  }
  const deliveryLines: OrderLineRow[] = [];
  for (const line of lines) {
    const key = `order_line:${line.id}`;
    if (line.kind === 'credit_package' || line.kind === 'credit_hours') {
      const shares = bundleShares(line);
      s.push(
        ...grantCredits(db, {
          userId: order.user_id,
          tierId: line.tier_id as string,
          seconds: line.seconds,
          paidIqd: shares.creditsPaid,
          source: 'purchase',
          orderLineId: line.id,
          orderId: order.id,
          expiresAfterDays: line.expires_after_days,
          entryKey: key,
          actorId: p.actorId,
          now: p.now,
        }).statements
      );
      shares.items.forEach((item, idx) => {
        s.push(
          ...grantInventory(db, {
            userId: order.user_id,
            variantId: item.variant_id,
            qty: item.qty,
            paidIqd: item.paid,
            source: 'purchase',
            orderLineId: line.id,
            entryKey: `${key}:bundle:${idx}`,
            actorId: p.actorId,
            now: p.now,
          }).statements
        );
      });
    } else if (line.kind === 'material') {
      s.push(
        ...grantInventory(db, {
          userId: order.user_id,
          variantId: line.variant_id as string,
          qty: line.quantity,
          paidIqd: line.final_price_iqd,
          source: 'purchase',
          orderLineId: line.id,
          projectId: line.fulfillment === 'project' ? line.project_id : null,
          entryKey: key,
          actorId: p.actorId,
          now: p.now,
        }).statements
      );
      if (line.fulfillment === 'delivery') deliveryLines.push(line);
    }
  }
  if (deliveryLines.length) {
    const fee = lines.find((l) => l.kind === 'shipping_fee')?.final_price_iqd ?? 0;
    const shipment = createShipment(db, {
      userId: order.user_id,
      kind: 'delivery',
      status: 'preparing',
      address: parseJson<DeliveryAddress | null>(order.delivery_address_json, null),
      feeIqd: fee,
      feeOrderId: order.id,
      now: p.now,
    });
    s.push(shipment.statement);
    s.push(db.prepare('UPDATE pc_orders SET shipment_id = ? WHERE id = ?').bind(shipment.id, order.id));
    // One reservation and one item per variant: a shipment holds at most one
    // active reservation per account (uq_pc_inventory_reservations_active),
    // and an order may carry a variant on several delivery lines — its stock
    // hold was merged the same way.
    const perVariant = new Map<string, number>();
    for (const line of deliveryLines) perVariant.set(line.variant_id as string, (perVariant.get(line.variant_id as string) ?? 0) + line.quantity);
    for (const [variantId, qty] of perVariant) {
      const r = reserveInventory(db, { userId: order.user_id, variantId, qty, purpose: 'delivery', refId: shipment.id, actorId: p.actorId, now: p.now });
      s.push(...r.statements, shipmentInventoryItem(db, shipment.id, r.reservationId, variantId, qty));
    }
  }
  s.push(
    pcNotify(db, {
      userId: order.user_id,
      notice: 'order_fulfilled',
      entity: 'print_cloud_order',
      entityId: order.id,
      link: `/print-cloud/orders/${order.id}`,
      eventKey: `order_fulfilled:${order.id}`,
    })
  );
  s.push(integrationEvent(db, { adapter: 'orders', kind: 'order.fulfilled', refId: order.id, payload: { user_id: order.user_id, total_iqd: order.total_iqd }, now: p.now }));
  s.push(
    integrationEvent(db, {
      adapter: 'accounting',
      kind: 'cash.collected',
      refId: order.id,
      payload: { amount_iqd: p.amountIqd, provider: p.provider, deferred: true },
      now: p.now,
    })
  );
  s.push(...(await pcAudit(db, p.actorId, 'order.paid', order.id, { provider: p.provider, event_id: p.eventId, amount_iqd: p.amountIqd })));
  return s;
}

export interface PaymentResult {
  outcome: PaymentOutcome;
  order_id: string;
  /** On 'duplicate_event': what the first copy of that event was recorded as. */
  previous_outcome?: string;
}

/**
 * The ONE door every payment confirmation goes through, whatever the adapter.
 *
 *   - an event already recorded for (provider, event id) changes nothing and
 *     answers 'duplicate_event' with the outcome first recorded — a webhook
 *     delivered twice grants once;
 *   - a different event for an order already paid is recorded as
 *     'duplicate_order' (for the refund desk) and grants nothing;
 *   - a wrong amount is recorded and grants nothing;
 *   - a delivery fee whose shipment no longer waits for it, and an order
 *     whose fulfilment the database keeps refusing (a CHECK, a unique key —
 *     never an outage), are recorded as 'order_not_payable' and grant
 *     nothing: the money is listed for the refund desk instead of a 500 the
 *     provider retries forever;
 *   - otherwise the order is fulfilled, once.
 */
export async function confirmPayment(db: D1Database, p: ConfirmInput): Promise<PaymentResult> {
  const seen = await one<{ outcome: string }>(
    db,
    'SELECT outcome FROM pc_payment_events WHERE provider = ? AND provider_event_id = ?',
    p.provider,
    p.eventId
  );
  if (seen) return { outcome: 'duplicate_event', order_id: p.orderId, previous_outcome: seen.outcome };
  const record = async (outcome: Exclude<PaymentOutcome, 'duplicate_event' | 'applied'>, known: boolean, detail: Record<string, unknown> = {}): Promise<PaymentResult> => {
    try {
      await db.batch([
        eventInsert(db, p, outcome, known),
        ...(await pcAudit(db, p.actorId, `payment.${outcome}`, p.orderId, { provider: p.provider, event_id: p.eventId, amount_iqd: p.amountIqd, ...detail })),
      ]);
    } catch (e) {
      if (!/UNIQUE constraint failed: pc_payment_events/.test(String(e instanceof Error ? e.message : e))) throw e;
      return { outcome: 'duplicate_event', order_id: p.orderId };
    }
    return { outcome, order_id: p.orderId };
  };
  let refused: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const order = await one<OrderRow>(db, 'SELECT * FROM pc_orders WHERE id = ?', p.orderId);
    if (!order) return record('unknown_order', false);
    if (order.status !== 'awaiting_payment') return record(order.paid_at ? 'duplicate_order' : 'order_not_payable', true);
    if (order.total_iqd !== p.amountIqd) return record('amount_mismatch', true);
    if (order.kind === 'shipping') {
      const shipment = await one<{ status: string }>(db, 'SELECT status FROM pc_shipments WHERE fee_order_id = ?', order.id);
      if (shipment?.status !== 'awaiting_payment') return record('order_not_payable', true, { reason: 'shipment_not_awaiting_payment', shipment_status: shipment?.status ?? null });
    }
    try {
      await db.batch(await fulfillmentStatements(db, order, p));
      return { outcome: 'applied', order_id: order.id };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE constraint failed: pc_payment_events/.test(msg)) return { outcome: 'duplicate_event', order_id: p.orderId };
      refused = null;
      if (/PC_FENCE:STATE_CHANGED|UNIQUE constraint failed: pc_payments/.test(msg)) continue;
      // Any other refusal the database expressed is not an outage: the same
      // event retried would meet it again. Re-plan in case a concurrent write
      // caused it; if it persists, record it below. Anything unrecognised is
      // an outage — a 500, nothing recorded, so a retry can still apply it.
      if (!classifyDbError(e)) throw e;
      refused = msg.slice(0, 300);
    }
  }
  if (refused) return record('order_not_payable', true, { reason: 'fulfilment_refused', error: refused });
  throw pcError('STATE_CHANGED');
}

// ------------------------------------------------------------------ the Levonis wallet

export interface WalletPaymentResult {
  order_id: string;
  status: 'paid';
  provider: 'levonis_wallet';
  amount_iqd: number;
  /** The cents the wallet gave up; 0 for a zero-total order (nothing to collect, no debit). */
  charged_usd_cents: number;
  exchange_rate: number;
  /** The one debit this order can ever have (`wtx_pc_<order id>`), or null when nothing was charged. */
  wallet_tx_id: string | null;
}

/**
 * Plan paying an own order from the customer's Levonis wallet. Read-only until
 * its batch runs (`payOrderFromWallet`): the wallet debit, then
 * `fulfillmentStatements` — the payment event, the order's fenced flip to
 * fulfilled, the confirmed payment row, the grants, the stock allocations,
 * the shipment, the notice, the outbox and the audit — so the money moves
 * exactly when the order is confirmed, or not at all.
 *
 * Asked in dinars first, as the price is quoted: an order whose total is above
 * the balance the wallet page prints is refused INSUFFICIENT_BALANCE before
 * anything is written. The debit's own guard is not replaced, only preceded —
 * `usdSpendStatement` still decides, at the instant the batch runs, whether
 * the spendable cents cover it.
 */
export async function planWalletPayment(
  db: D1Database,
  p: { userId: string; orderId: string; config: PrintCloudConfig; now: Date }
): Promise<Planned<WalletPaymentResult>> {
  if (!p.config.wallet_payment_enabled) throw pcError('PAYMENT_ADAPTER_DISABLED', { provider: 'levonis_wallet' });
  const order = await one<OrderRow>(db, 'SELECT * FROM pc_orders WHERE id = ?', p.orderId);
  if (!order || order.user_id !== p.userId) throw pcError('NOT_FOUND');
  const notPayable = await walletPayability(db, order, p.now);
  if (notPayable) throw pcError('ORDER_NOT_PAYABLE', notPayable);
  const position = await walletPosition(db, p.userId);
  if (order.total_iqd > position.available_iqd) throw insufficientBalance(position.available_iqd, order.total_iqd);
  const cents = walletChargeCents(order.total_iqd, position.available_cents, position.exchange_rate);
  const txId = cents > 0 ? walletDebitTxId(order.id) : null;
  const result: WalletPaymentResult = {
    order_id: order.id,
    status: 'paid',
    provider: 'levonis_wallet',
    amount_iqd: order.total_iqd,
    charged_usd_cents: cents,
    exchange_rate: position.exchange_rate,
    wallet_tx_id: txId,
  };
  const statements: Stmt[] = [];
  if (txId) {
    statements.push(
      await walletDebitStatement(db, { orderId: order.id, userId: p.userId, cents, totalIqd: order.total_iqd, rate: position.exchange_rate, nowIso: iso(p.now) })
    );
  }
  statements.push(
    ...(await fulfillmentStatements(db, order, {
      provider: 'levonis_wallet',
      // One event per order: a second wallet payment of it collides here as well as on the debit's id.
      eventId: walletPaymentEventId(order.id),
      orderId: order.id,
      amountIqd: order.total_iqd,
      actorId: p.userId,
      payloadHash: await sha256Hex(canonicalJson({ order_id: order.id, charged_usd_cents: cents, exchange_rate: position.exchange_rate, wallet_tx_id: txId })),
      now: p.now,
    })),
    // The order was placed for one method and paid with this one: its record says how it was paid.
    db.prepare("UPDATE pc_orders SET payment_method = 'levonis_wallet' WHERE id = ? AND payment_method <> 'levonis_wallet'").bind(order.id)
  );
  return { statements, result };
}

/**
 * POST /orders/{id}/pay/wallet: `planWalletPayment` under the customer's
 * Idempotency-Key. The key's operation row is the batch's first statement, so
 * the first answer is stored exactly when the money moves and a replay returns
 * it; a refusal stores nothing (top up, retry with the same key). A batch the
 * database refused is classified from the facts (wallet.ts
 * `walletPaymentRefusal`); an outage is a 500.
 */
export function payOrderFromWallet(
  db: D1Database,
  p: { userId: string; orderId: string; key: string; config: PrintCloudConfig; now: Date }
): Promise<Outcome<WalletPaymentResult>> {
  return idempotent(
    db,
    { actorId: p.userId, scope: 'order.pay.wallet', key: p.key, request: { orderId: p.orderId }, now: p.now },
    () => planWalletPayment(db, p),
    { refusal: (e, lastAttempt) => walletPaymentRefusal(db, e, { orderId: p.orderId, userId: p.userId, now: p.now, lastAttempt }) }
  );
}

// ------------------------------------------------------------------ cancel / expire

/** Statements that close an unpaid order: holds back on the shelf, redemptions returned, payments rejected. */
export async function closeUnpaidOrder(
  db: D1Database,
  order: OrderRow,
  to: 'cancelled' | 'expired',
  actorId: string,
  now: Date,
  reason: string
): Promise<Stmt[]> {
  if (order.status !== 'awaiting_payment') throw pcError('ORDER_NOT_PAYABLE');
  const token = pcId('tok');
  const s: Stmt[] = [
    db
      .prepare(`UPDATE pc_orders SET status = ?, cancelled_at = ?, updated_at = ?, op_token = ? WHERE id = ? AND status = 'awaiting_payment'`)
      .bind(to, iso(now), iso(now), token, order.id),
    fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_orders WHERE id = ?) = ?', [order.id, token]),
    db.prepare("UPDATE pc_payments SET status = 'rejected' WHERE order_id = ? AND status = 'pending'").bind(order.id),
  ];
  for (const hold of await activeHolds(db, order.id)) s.push(...releaseHold(db, hold, actorId, now, reason));
  if (order.kind === 'shipping' && order.shipment_id) {
    // An unpaid delivery fee takes its shipment with it, and frees what it
    // held — fenced, so a shipment that moved on is never stripped.
    s.push(
      db
        .prepare("UPDATE pc_shipments SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'")
        .bind(iso(now), iso(now), order.shipment_id),
      fence(db, 'STATE_CHANGED', '(SELECT status FROM pc_shipments WHERE id = ?) = ?', [order.shipment_id, 'cancelled']),
      ...(await shipmentCancelStatements(db, order.shipment_id, actorId, now))
    );
  }
  for (const promoId of parseJson<string[]>(order.promotion_ids_json, [])) {
    s.push(db.prepare('UPDATE pc_promotions SET redemptions = redemptions - 1, updated_at = ? WHERE id = ? AND redemptions > 0').bind(iso(now), promoId));
  }
  s.push(...(await pcAudit(db, actorId, `order.${to}`, order.id, { reason })));
  return s;
}

/** The sweep: unpaid orders whose stock hold has run out. Bounded; each order its own batch. */
export async function expireUnpaidOrders(db: D1Database, now: Date, limit = 25, unitFits?: () => boolean): Promise<{ expired: number; failed: number; more: boolean }> {
  const due = await many<OrderRow>(
    db,
    "SELECT * FROM pc_orders WHERE status = 'awaiting_payment' AND stock_hold_expires_at <= ? ORDER BY stock_hold_expires_at LIMIT ?",
    iso(now),
    limit
  );
  let expired = 0;
  let failed = 0;
  for (const order of due) {
    // Out of room for one more order: the rest wait for the next run.
    if (unitFits && !unitFits()) return { expired, failed, more: true };
    try {
      await runBatch(db, await closeUnpaidOrder(db, order, 'expired', 'system', now, 'stock hold expired'));
      expired++;
    } catch {
      failed++;
    }
  }
  return { expired, failed, more: due.length === limit };
}

// ------------------------------------------------------------------ refunds

export type RefundMethod = 'manual' | 'gateway' | 'dev' | 'levonis_wallet';
export const REFUND_METHODS: readonly RefundMethod[] = ['manual', 'gateway', 'dev', 'levonis_wallet'];

export interface RefundResult {
  refund_id: string;
  amount_iqd: number;
  quantity: number;
  method: RefundMethod;
  /** The credit an order paid from the Levonis wallet got back, in this refund's batch; null for every other method. */
  wallet_credit: { tx_id: string; usd_cents: number; amount_iqd: number | null; exchange_rate: number | null } | null;
}

/**
 * Refund (part of) one paid order line — only what the customer has NOT
 * used. Credits: the FREE part of the lot that line bought — never seconds a
 * confirmed job holds on it, and nothing once the lot's expiry has come.
 * Materials: unused, unreserved units of the lot that line bought, which go
 * back to the workshop's sellable stock.
 *
 * WHERE THE MONEY GOES follows how it came. An order paid from the Levonis
 * wallet is refunded INTO the wallet, in this batch (wallet.ts
 * `planWalletRefundCredit`): `method` may be left out or say
 * 'levonis_wallet'; naming another method for it is refused, because cash
 * handed back as well as a wallet credit would refund it twice. For every
 * other order the money leaves through `method` ('manual' when left out):
 * this records it, never moves it — and 'levonis_wallet' is refused, because
 * crediting a wallet the order never debited would mint money.
 */
export async function planLineRefund(
  db: D1Database,
  p: { orderId: string; lineId: string; quantity: number | null; amountIqd: number | null; reason: string; method: RefundMethod | null; actorId: string; now: Date }
): Promise<Planned<RefundResult>> {
  const order = await one<OrderRow>(db, 'SELECT * FROM pc_orders WHERE id = ?', p.orderId);
  if (!order) throw pcError('NOT_FOUND');
  if (!['fulfilled', 'partially_refunded'].includes(order.status)) throw pcError('INVALID_TRANSITION', { status: order.status });
  const line = await one<OrderLineRow>(db, 'SELECT * FROM pc_order_lines WHERE id = ? AND order_id = ?', p.lineId, p.orderId);
  if (!line) throw pcError('NOT_FOUND');
  if (!p.reason.trim()) throw invalid('reason', 'required');
  const paidWith = await one<{ provider: string }>(db, "SELECT provider FROM pc_payments WHERE order_id = ? AND status = 'confirmed'", order.id);
  const fromWallet = paidWith?.provider === 'levonis_wallet';
  if (fromWallet && p.method !== null && p.method !== 'levonis_wallet') throw invalid('method', 'order_paid_from_wallet');
  if (!fromWallet && p.method === 'levonis_wallet') throw invalid('method', 'order_not_paid_from_wallet');
  const method: RefundMethod = fromWallet ? 'levonis_wallet' : (p.method ?? 'manual');
  const s: Stmt[] = [];
  let qty = 0;
  let defaultAmount = 0;
  const refundId = pcId('pcrf');
  if (line.kind === 'credit_package' || line.kind === 'credit_hours') {
    const lot = await one<{ id: string; seconds_remaining: number; seconds_held: number; expires_at: string | null }>(
      db,
      'SELECT id, seconds_remaining, seconds_held, expires_at FROM pc_credit_lots WHERE order_line_id = ?',
      line.id
    );
    if (!lot) throw pcError('NOT_FOUND', { reason: 'lot_missing' });
    const refundable = freeSecondsAt(lot, p.now);
    qty = p.quantity ?? refundable;
    if (qty <= 0 || qty > refundable) throw pcError('INSUFFICIENT_CREDIT', { refundable_seconds: refundable });
    const debit = await debitAvailable(db, {
      userId: order.user_id,
      tierId: line.tier_id as string,
      seconds: qty,
      type: 'refund',
      entryKey: `refund:${refundId}`,
      lotId: lot.id,
      orderId: order.id,
      actorId: p.actorId,
      note: p.reason,
      now: p.now,
    });
    s.push(...debit.statements);
    defaultAmount = debit.value;
  } else if (line.kind === 'material') {
    const lot = await one<{ id: string; qty_total: number; qty_remaining: number; paid_iqd: number }>(
      db,
      'SELECT id, qty_total, qty_remaining, paid_iqd FROM pc_inventory_lots WHERE order_line_id = ?',
      line.id
    );
    if (!lot) throw pcError('NOT_FOUND', { reason: 'lot_missing' });
    const acct = await one<{ available_qty: number }>(
      db,
      'SELECT available_qty FROM pc_inventory_accounts WHERE user_id = ? AND variant_id = ?',
      order.user_id,
      line.variant_id
    );
    const refundable = Math.min(Number(lot.qty_remaining), Number(acct?.available_qty ?? 0));
    qty = p.quantity ?? refundable;
    if (qty <= 0 || qty > refundable) throw pcError('INSUFFICIENT_INVENTORY', { refundable_qty: refundable });
    const debit = await debitInventory(db, {
      userId: order.user_id,
      variantId: line.variant_id as string,
      qty,
      type: 'refund',
      entryKey: `refund:${refundId}`,
      lotId: lot.id,
      refType: 'order',
      refId: order.id,
      actorId: p.actorId,
      note: p.reason,
      now: p.now,
    });
    s.push(...debit.statements);
    s.push(
      ...deallocate(db, {
        variantId: line.variant_id as string,
        qty,
        type: 'deallocate',
        userId: order.user_id,
        refType: 'refund',
        refId: refundId,
        entryKey: `deallocate:${refundId}`,
        actorId: p.actorId,
        now: p.now,
      })
    );
    defaultAmount = debit.value;
  } else {
    defaultAmount = line.final_price_iqd - line.refunded_iqd;
  }
  const remainingOnLine = line.final_price_iqd - line.refunded_iqd;
  const amount = p.amountIqd ?? Math.min(defaultAmount, remainingOnLine);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remainingOnLine) throw invalid('amount_iqd', 'out_of_range');
  // The wallet's share of this refund, computed against the same order snapshot the fence below holds the batch to.
  const credit: WalletRefundCredit | null = fromWallet
    ? await planWalletRefundCredit(db, { order, refundId, amountIqd: amount, nowIso: iso(p.now) })
    : null;
  const walletCredit = credit ? { tx_id: credit.tx_id, usd_cents: credit.usd_cents, amount_iqd: credit.amount_iqd, exchange_rate: credit.exchange_rate } : null;
  // Fenced on a fresh op_token, not on the resulting total: a concurrent
  // refund of the same amount reaches the same total, and only the token
  // tells that this batch's UPDATE is the one that matched.
  const token = pcId('tok');
  s.push(
    db
      .prepare(
        "INSERT INTO pc_refunds (id, order_id, order_line_id, amount_iqd, quantity, reason, method, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      // A wallet refund is paid out by this very batch; every other method is recorded for the money desk.
      .bind(refundId, order.id, line.id, amount, qty, p.reason.slice(0, 500), method, credit ? 'paid_out' : 'recorded', p.actorId, iso(p.now)),
    db.prepare('UPDATE pc_order_lines SET refunded_iqd = refunded_iqd + ? WHERE id = ?').bind(amount, line.id),
    db
      .prepare(
        `UPDATE pc_orders SET refunded_iqd = refunded_iqd + ?,
                status = CASE WHEN refunded_iqd + ? >= paid_iqd THEN 'refunded' ELSE 'partially_refunded' END, updated_at = ?, op_token = ?
          WHERE id = ? AND refunded_iqd = ? AND status IN ('fulfilled', 'partially_refunded')`
      )
      .bind(amount, amount, iso(p.now), token, order.id, order.refunded_iqd),
    fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_orders WHERE id = ?) = ?', [order.id, token]),
    ...(credit?.statements ?? []),
    integrationEvent(db, {
      adapter: 'accounting',
      kind: 'refund.recorded',
      refId: refundId,
      payload: { order_id: order.id, amount_iqd: amount, method, ...(walletCredit ? { wallet_tx_id: walletCredit.tx_id, wallet_usd_cents: walletCredit.usd_cents } : {}) },
      now: p.now,
    }),
    ...(await pcAudit(db, p.actorId, 'order.refund', order.id, {
      refund_id: refundId,
      line_id: line.id,
      amount_iqd: amount,
      quantity: qty,
      reason: p.reason,
      method,
      ...(walletCredit ? { wallet_tx_id: walletCredit.tx_id, wallet_usd_cents: walletCredit.usd_cents } : {}),
    })),
  );
  return { statements: s, result: { refund_id: refundId, amount_iqd: amount, quantity: qty, method, wallet_credit: walletCredit } };
}

// ------------------------------------------------------------------ reads

export async function orderDetail(db: D1Database, orderId: string) {
  const order = await one<OrderRow>(db, 'SELECT * FROM pc_orders WHERE id = ?', orderId);
  if (!order) return null;
  const lines = await many<OrderLineRow>(db, 'SELECT * FROM pc_order_lines WHERE order_id = ? ORDER BY line_no', orderId);
  const payments = await many<Record<string, unknown>>(
    db,
    'SELECT id, provider, amount_iqd, status, created_at, confirmed_at FROM pc_payments WHERE order_id = ? ORDER BY created_at',
    orderId
  );
  const refunds = await many<Record<string, unknown>>(db, 'SELECT id, order_line_id, amount_iqd, quantity, reason, method, status, created_at FROM pc_refunds WHERE order_id = ?', orderId);
  return {
    ...order,
    promotion_ids: parseJson<string[]>(order.promotion_ids_json, []),
    delivery_address: parseJson(order.delivery_address_json, null),
    lines: lines.map((l) => ({ ...l, breakdown: parseJson(l.breakdown_json, {}) })),
    payments,
    refunds,
  };
}

export type { PricedLine };
