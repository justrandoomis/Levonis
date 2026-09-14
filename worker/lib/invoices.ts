import type { Env } from './types';
import { localeToApi, safeParse } from './types';
import { newId } from './crypto';
import { enqueue, processOutbox } from './outbox';
import {
  renderOrderInvoiceEmail,
  type InvoiceEmailData,
  type InvoiceEmailLine,
  type InvoicePaymentStatus,
} from './emailTemplates';

/**
 * Invoice creation (table in migration 0003: invoices). Called from the
 * checkout path — MUST NEVER throw into it: any internal failure returns
 * null and the order itself stands (an invoice can be re-issued by an
 * admin retry; a lost invoice must not undo a valid purchase).
 *
 * Idempotent per (order_id, revision 1) — replaying the call returns the
 * existing invoice instead of issuing a duplicate, and the outbox event_key
 * `invoice:<orderId>:1` makes the email enqueue replay-safe too.
 *
 * The invoice email is the ONLY routine order email (final-phase §3D). It
 * goes exclusively to the order owner's account address, and only when that
 * address is verified (users.email_verified_at) — otherwise the event is
 * recorded in the outbox with state 'skipped' so nothing is silently lost.
 */

export interface InvoiceResult {
  invoiceId: string;
  invoiceNo: string;
  created: boolean;
}

interface OrderRow {
  id: string;
  user_id: string;
  status: string;
  address_snapshot: string;
  delivery_method_snapshot: string;
  payment_method_id: string;
  subtotal_iqd: number;
  shipping_iqd: number;
  cod_tax_iqd?: number | null;
  points_discount_iqd: number;
  wallet_applied_iqd: number;
  exchange_rate: number;
  total_iqd: number;
  due_on_delivery_iqd: number;
  bnpl_due_iqd?: number | null;
  bnpl_due_at?: string | null;
  delivery_waived: number | null;
  membership_tier_snapshot: string | null;
  coupon_snapshot: string | null;
  created_at: string;
}

interface OrderItemRow {
  id: string;
  product_id: string | null;
  /** Set on a bundle COMPONENT row: the priced parent it belongs under. */
  bundle_parent_item_id?: string | null;
  name_snapshot: string;
  option_snapshot: string;
  qty: number;
  unit_price_iqd: number;
  line_total_iqd: number;
  pricing_snapshot: string | null;
  warranty_snapshot: string | null;
  transport_snapshot: string | null;
}

interface OwnerRow {
  id: string;
  email: string;
  name: string;
  locale: string;
  email_verified_at: string | null;
}

/** Persisted snapshot shape (version 1). Parsed back by routes/invoices.ts. */
export interface InvoiceSnapshotV1 {
  version: 1;
  order: {
    id: string;
    status: string;
    created_at: string;
    payment_method_id: string;
    membership_tier: string;
    exchange_rate: number;
  };
  customer: { user_id: string; name: string; email: string };
  address: { name: string; phone: string; address: string; landmark: string };
  lines: Array<
    InvoiceEmailLine & { order_item_id: string; product_id: string | null }
  >;
  totals: {
    subtotal_iqd: number;
    delivery_fee_iqd: number;
    /** Added in migration 0067; absent on immutable older invoice snapshots. */
    cod_tax_iqd?: number;
    delivery_waived: boolean;
    coupon_code: string;
    coupon_discount_iqd: number;
    points_applied_iqd: number;
    wallet_applied_iqd: number;
    total_iqd: number;
    amount_paid_iqd: number;
    amount_due_iqd: number;
    payment_status: InvoicePaymentStatus;
  };
  correction?: { reason: string; corrected_by: string; supersedes_invoice_no: string };
}

/**
 * PRICED LINES ONLY, WITH A BUNDLE'S PARTS NESTED UNDER IT (§6.3).
 *
 * A bundle's component rows carry `unit_price_iqd = 0` by design — the money is
 * on the parent — so emitting them as invoice lines would print four 0 IQD rows
 * naming the member products on a document the customer downloads, and any
 * reader summing the lines would still get the right total for the wrong
 * reason. They become an `included[]` list under the parent instead.
 */
function invoiceLines(items: OrderItemRow[]): InvoiceSnapshotV1['lines'] {
  return items
    .filter((it) => !it.bundle_parent_item_id)
    .map((it) => {
      const kids = items.filter((k) => String(k.bundle_parent_item_id ?? '') === it.id);
      const line = lineFromItem(it);
      return kids.length
        ? {
            ...line,
            included: kids.map((k) => ({
              name: k.name_snapshot,
              variant: k.option_snapshot || '',
              qty: Number(k.qty) || 0,
            })),
          }
        : line;
    });
}

function lineFromItem(it: OrderItemRow): InvoiceSnapshotV1['lines'][number] {
  const warranty = safeParse<{ title_ar?: string; title_en?: string; fee_iqd?: number } | null>(it.warranty_snapshot, null);
  // `waived` covers both reasons a commission is not charged — the PRO waiver
  // and a pre-order paid cash on delivery (transport.waived_by explains which
  // in the snapshot); the invoice only needs the effective figure.
  const transport = safeParse<{ method?: string; commission_iqd?: number; waived?: boolean } | null>(
    it.transport_snapshot,
    null
  );
  const effectiveCommission = transport && transport.waived !== true ? Number(transport.commission_iqd) || 0 : 0;
  // The direct-sale premium lives in the pricing snapshot (pricing.ts
  // `direct`); 0 when none applied or when an active PRO was exempt, so the
  // invoice for a cash-on-delivery pre-order can show WHY its unit price is
  // the direct-sale number. Rows written before the field existed have none.
  const pricing = safeParse<{ direct?: { surcharge_iqd?: number; waived?: boolean } | null } | null>(
    it.pricing_snapshot,
    null
  );
  const direct = pricing?.direct ?? null;
  const effectiveDirect = direct && direct.waived !== true ? Number(direct.surcharge_iqd) || 0 : 0;
  return {
    order_item_id: it.id,
    product_id: it.product_id,
    name: it.name_snapshot,
    variant: it.option_snapshot || '',
    qty: Number(it.qty) || 0,
    unit_price_iqd: Number(it.unit_price_iqd) || 0,
    line_total_iqd: Number(it.line_total_iqd) || 0,
    transport_commission_iqd: effectiveCommission,
    direct_surcharge_iqd: effectiveDirect,
    warranty_fee_iqd: warranty ? Number(warranty.fee_iqd) || 0 : 0,
    // The plan's own title, as frozen at checkout — Arabic first, the English
    // title when the plan was authored without one.
    warranty_label: warranty?.title_ar || warranty?.title_en || '',
  };
}

/**
 * Honest payment status from the persisted order money model:
 * total_iqd = payable total after discounts; due_on_delivery_iqd = what is
 * still owed at the door; the difference was actually settled from the
 * approved wallet/points ledgers at checkout. COD balances are NEVER 'paid'.
 */
function paymentFacts(order: OrderRow): { paid: number; due: number; status: InvoicePaymentStatus } {
  const total = Number(order.total_iqd) || 0;
  const financed = Math.max(0, Number(order.bnpl_due_iqd) || 0);
  if (financed > 0) {
    return { paid: Math.max(0, total - financed), due: financed, status: 'bnpl_due' };
  }
  const due = Math.max(0, Number(order.due_on_delivery_iqd) || 0);
  const paid = Math.max(0, total - due);
  const status: InvoicePaymentStatus = due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'cod_due';
  return { paid, due, status };
}

async function loadOrderData(
  env: Env,
  orderId: string
): Promise<{ order: OrderRow; items: OrderItemRow[]; owner: OwnerRow } | null> {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first<OrderRow>();
  if (!order) return null;
  const { results: items } = await env.DB.prepare(
    'SELECT id, product_id, name_snapshot, option_snapshot, qty, unit_price_iqd, line_total_iqd, pricing_snapshot, warranty_snapshot, transport_snapshot, bundle_parent_item_id FROM order_items WHERE order_id = ?'
  )
    .bind(orderId)
    .all<OrderItemRow>();
  const owner = await env.DB.prepare('SELECT id, email, name, locale, email_verified_at FROM users WHERE id = ?')
    .bind(order.user_id)
    .first<OwnerRow>();
  if (!owner) return null;
  return { order, items, owner };
}

function buildSnapshot(order: OrderRow, items: OrderItemRow[], owner: OwnerRow): InvoiceSnapshotV1 {
  const address = safeParse<Record<string, unknown>>(order.address_snapshot, {});
  const coupon = safeParse<{ code?: string; discount_iqd?: number } | null>(order.coupon_snapshot, null);
  const { paid, due, status } = paymentFacts(order);
  return {
    version: 1,
    order: {
      id: order.id,
      status: order.status,
      created_at: order.created_at,
      payment_method_id: order.payment_method_id,
      membership_tier: order.membership_tier_snapshot || 'free',
      exchange_rate: Number(order.exchange_rate) || 0,
    },
    customer: { user_id: owner.id, name: owner.name || '', email: owner.email },
    address: {
      name: String(address.name ?? ''),
      phone: String(address.phone ?? ''),
      address: String(address.address ?? ''),
      landmark: String(address.landmark ?? ''),
    },
    lines: invoiceLines(items),
    totals: {
      subtotal_iqd: Number(order.subtotal_iqd) || 0,
      delivery_fee_iqd: Number(order.shipping_iqd) || 0,
      cod_tax_iqd: Number(order.cod_tax_iqd) || 0,
      delivery_waived: !!order.delivery_waived,
      coupon_code: coupon?.code || '',
      coupon_discount_iqd: coupon ? Number(coupon.discount_iqd) || 0 : 0,
      points_applied_iqd: Number(order.points_discount_iqd) || 0,
      wallet_applied_iqd: Number(order.wallet_applied_iqd) || 0,
      total_iqd: Number(order.total_iqd) || 0,
      amount_paid_iqd: paid,
      amount_due_iqd: due,
      payment_status: status,
    },
  };
}

/** Snapshot JSON -> the shape templates render. Exported for routes/invoices.ts. */
export function invoiceEmailData(
  snapshot: InvoiceSnapshotV1,
  invoiceNo: string,
  revision: number,
  issuedAt: string
): InvoiceEmailData {
  return {
    invoice_no: invoiceNo,
    order_id: snapshot.order.id,
    revision,
    issued_at: issuedAt,
    customer_name: snapshot.customer.name,
    lines: snapshot.lines,
    subtotal_iqd: snapshot.totals.subtotal_iqd,
    delivery_fee_iqd: snapshot.totals.delivery_fee_iqd,
    cod_tax_iqd: snapshot.totals.cod_tax_iqd ?? 0,
    delivery_waived: snapshot.totals.delivery_waived,
    coupon_discount_iqd: snapshot.totals.coupon_discount_iqd,
    points_applied_iqd: snapshot.totals.points_applied_iqd,
    wallet_applied_iqd: snapshot.totals.wallet_applied_iqd,
    total_iqd: snapshot.totals.total_iqd,
    amount_paid_iqd: snapshot.totals.amount_paid_iqd,
    amount_due_iqd: snapshot.totals.amount_due_iqd,
    payment_status: snapshot.totals.payment_status,
  };
}

/** Existing invoice-number pattern: INV-<year>-<id tail>. */
function makeInvoiceNo(id: string): string {
  return `INV-${new Date().getUTCFullYear()}-${id.slice(-8).toUpperCase()}`;
}

export async function createInvoiceForOrder(env: Env, orderId: string): Promise<InvoiceResult | null> {
  try {
    const existing = await env.DB.prepare(
      'SELECT id, invoice_no FROM invoices WHERE order_id = ? AND revision = 1'
    )
      .bind(orderId)
      .first<{ id: string; invoice_no: string }>();
    if (existing) return { invoiceId: existing.id, invoiceNo: existing.invoice_no, created: false };

    const data = await loadOrderData(env, orderId);
    if (!data) return null;
    // No invoice for a cancelled order — nothing was sold.
    if (data.order.status === 'cancelled') return null;

    const snapshot = buildSnapshot(data.order, data.items, data.owner);
    const { paid, due, status } = paymentFacts(data.order);

    const id = newId('inv');
    const invoiceNo = makeInvoiceNo(id);
    const issuedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO invoices (id, invoice_no, order_id, revision, snapshot, amount_paid_iqd, amount_due_iqd, payment_status, issued_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`
    )
      .bind(id, invoiceNo, orderId, JSON.stringify(snapshot), paid, due, status, issuedAt)
      .run();

    // Enqueue the ONE routine order email (event_key dedups replays). Any
    // failure here never fails invoice creation.
    try {
      await enqueueInvoiceEmail(env, orderId, 1, invoiceNo, issuedAt, snapshot, data.owner);
    } catch (e) {
      console.error('invoice email enqueue failed for order', orderId, e instanceof Error ? e.message : String(e));
    }

    return { invoiceId: id, invoiceNo, created: true };
  } catch {
    // A concurrent insert can lose the race on UNIQUE(order_id, revision);
    // re-read so the caller still gets the winner's invoice.
    try {
      const row = await env.DB.prepare(
        'SELECT id, invoice_no FROM invoices WHERE order_id = ? AND revision = 1'
      )
        .bind(orderId)
        .first<{ id: string; invoice_no: string }>();
      if (row) return { invoiceId: row.id, invoiceNo: row.invoice_no, created: false };
    } catch {
      /* fall through */
    }
    return null;
  }
}

/**
 * Enqueues the invoice email for the order owner. Sends ONLY to a verified
 * account address; otherwise records the event with state 'skipped' (honest,
 * replay-safe — same unique event_key either way).
 */
async function enqueueInvoiceEmail(
  env: Env,
  orderId: string,
  revision: number,
  invoiceNo: string,
  issuedAt: string,
  snapshot: InvoiceSnapshotV1,
  owner: OwnerRow
): Promise<void> {
  const eventKey = `invoice:${orderId}:${revision}`;
  const lang = localeToApi(owner.locale);
  const origin = (env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  const ordersUrl = origin ? `${origin}/orders` : '';
  const msg = renderOrderInvoiceEmail(lang, invoiceEmailData(snapshot, invoiceNo, revision, issuedAt), ordersUrl);
  const message = { kind: 'email' as const, to: owner.email, subject: msg.subject, html: msg.html, text: msg.text };

  if (!owner.email_verified_at) {
    await enqueue(env, eventKey, message, {
      state: 'skipped',
      note: 'recipient email not verified — invoice email skipped',
    });
    return;
  }
  const enqueued = await enqueue(env, eventKey, message);
  if (enqueued) {
    // Prompt best-effort delivery; the durable jobs runner retries the rest.
    try {
      await processOutbox(env, 3);
    } catch (e) {
      console.error('invoice outbox processing failed', e instanceof Error ? e.message : String(e));
    }
  }
}

export type InvoiceRevisionInput = {
  reason: string;
  amount_paid_iqd?: number;
  amount_due_iqd?: number;
  payment_status?: InvoicePaymentStatus;
};

export type InvoiceRevisionResult =
  | { ok: true; invoiceId: string; invoiceNo: string; revision: number }
  | { ok: false; error: string; code: string };

/**
 * Admin correction: appends revision N+1 for the order and links the previous
 * revision via superseded_by — issued invoices are NEVER mutated in place.
 * The snapshot is rebuilt from current order data; explicitly provided
 * paid/due/status corrections override the derived values (e.g. a verified
 * cash payment recorded after delivery). UNIQUE(order_id, revision) rejects
 * concurrent duplicate revisions. Does NOT auto-send any email — admin
 * resend is a separate audited action.
 */
export async function createInvoiceRevision(
  env: Env,
  invoiceId: string,
  input: InvoiceRevisionInput,
  actorId: string
): Promise<InvoiceRevisionResult> {
  const prev = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?')
    .bind(invoiceId)
    .first<{ id: string; invoice_no: string; order_id: string; revision: number; superseded_by: string | null }>();
  if (!prev) return { ok: false, error: 'Invoice not found', code: 'NOT_FOUND' };
  if (prev.superseded_by) {
    return { ok: false, error: 'This invoice was already superseded — revise the latest revision instead', code: 'SUPERSEDED' };
  }

  const data = await loadOrderData(env, prev.order_id);
  if (!data) return { ok: false, error: 'Order for this invoice no longer loads', code: 'ORDER_MISSING' };

  const snapshot = buildSnapshot(data.order, data.items, data.owner);
  const derived = paymentFacts(data.order);
  const paid = input.amount_paid_iqd !== undefined ? input.amount_paid_iqd : derived.paid;
  const due = input.amount_due_iqd !== undefined ? input.amount_due_iqd : derived.due;
  let status: InvoicePaymentStatus;
  if (input.payment_status !== undefined) {
    status = input.payment_status;
  } else {
    status = due <= 0 ? (paid > 0 ? 'paid' : derived.status) : paid > 0 ? 'partial' : derived.status;
  }
  // Honesty guard: an outstanding balance can never be labeled 'paid'.
  if (status === 'paid' && due > 0) {
    return { ok: false, error: 'An invoice with an amount due cannot be marked paid', code: 'INCONSISTENT_STATUS' };
  }
  snapshot.totals.amount_paid_iqd = paid;
  snapshot.totals.amount_due_iqd = due;
  snapshot.totals.payment_status = status;
  snapshot.correction = { reason: input.reason, corrected_by: actorId, supersedes_invoice_no: prev.invoice_no };

  const id = newId('inv');
  const invoiceNo = makeInvoiceNo(id);
  const issuedAt = new Date().toISOString();
  const revision = prev.revision + 1;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO invoices (id, invoice_no, order_id, revision, snapshot, amount_paid_iqd, amount_due_iqd, payment_status, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, invoiceNo, prev.order_id, revision, JSON.stringify(snapshot), paid, due, status, issuedAt),
      env.DB.prepare('UPDATE invoices SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').bind(id, prev.id),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE')) {
      return { ok: false, error: 'A concurrent revision was just created — reload and retry', code: 'CONFLICT' };
    }
    console.error('invoice revision failed', msg);
    return { ok: false, error: 'Invoice revision could not be saved', code: 'INTERNAL' };
  }
  return { ok: true, invoiceId: id, invoiceNo, revision };
}
