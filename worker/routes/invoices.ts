import { Hono } from 'hono';
import { asDocument } from '../lib/securityPolicy';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { localeToApi, safeParse } from '../lib/types';
import { requireAuth, requireAdmin, notFound, badRequest, conflict, str, int, oneOf } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { stripInventoryProvenance } from '../lib/inventoryProvenancePrivacy';
import { newId } from '../lib/crypto';
import { isStamped } from '../lib/emailStamp';
import { enqueue, processOutbox } from '../lib/outbox';
import {
  createInvoiceRevision,
  invoiceEmailData,
  type InvoiceSnapshotV1,
} from '../lib/invoices';
import {
  emailLang,
  renderInvoiceHtmlDocument,
  renderOrderInvoiceEmail,
  type InvoiceCancellation,
  type InvoicePaymentStatus,
} from '../lib/emailTemplates';

/**
 * Invoice access (final-phase §3): strictly owner-or-admin, JSON + printable
 * HTML, always Cache-Control: no-store — invoices are private financial
 * records with no public or permanent URLs. Corrections append revisions
 * (createInvoiceRevision) instead of mutating issued invoices, and admin
 * resend is a separate audited action.
 */

export const invoiceRoutes = new Hono<AppContext>();
invoiceRoutes.use('*', requireAuth);

interface InvoiceRow {
  id: string;
  invoice_no: string;
  order_id: string;
  revision: number;
  snapshot: string;
  amount_paid_iqd: number;
  amount_due_iqd: number;
  payment_status: InvoicePaymentStatus;
  issued_at: string;
  superseded_by: string | null;
  owner_user_id: string;
  order_status: string;
}

function invoicePublic(row: InvoiceRow, withSnapshot: boolean) {
  return {
    id: row.id,
    invoice_no: row.invoice_no,
    order_id: row.order_id,
    revision: row.revision,
    amount_paid_iqd: row.amount_paid_iqd,
    amount_due_iqd: row.amount_due_iqd,
    payment_status: row.payment_status,
    issued_at: row.issued_at,
    superseded_by: row.superseded_by,
    ...(withSnapshot ? { snapshot: stripInventoryProvenance(safeParse<InvoiceSnapshotV1 | null>(row.snapshot, null)) } : {}),
  };
}

/** Loads one invoice and enforces owner-or-admin — 404 either way (no leak). */
async function loadAuthorized(c: Context<AppContext>, id: string): Promise<InvoiceRow> {
  const user = c.get('user')!;
  const row = await c.env.DB.prepare(
    `SELECT i.*, o.user_id AS owner_user_id, o.status AS order_status FROM invoices i JOIN orders o ON o.id = i.order_id WHERE i.id = ?`
  )
    .bind(id)
    .first<InvoiceRow>();
  if (!row || (row.owner_user_id !== user.id && user.role !== 'admin')) throw notFound('Invoice not found');
  return row;
}

/**
 * WHAT A CANCELLED ORDER GAVE BACK, from the ledger's own refund rows (worker/lib/orderCancelOps.ts, one per order
 * by its deterministic id): the document says what happened, not what should have. A cancel that moved no money has
 * neither row, and the page still says it was cancelled. A row from before the dinar column reads the invoice's own
 * wallet figure, which is what that order took.
 */
async function cancellationOf(db: D1Database, row: InvoiceRow, snapshot: InvoiceSnapshotV1): Promise<InvoiceCancellation | null> {
  if (row.order_status !== 'cancelled') return null;
  const wallet = `wtx_refund_${row.order_id}_usd`;
  const points = `wtx_refund_${row.order_id}_pts`;
  const { results } = await db
    .prepare("SELECT * FROM wallet_transactions WHERE id IN (?, ?) AND status = 'approved'")
    .bind(wallet, points)
    .all<{ id: string; amount: number; amount_iqd?: number | null }>();
  const walletRow = results.find((r) => r.id === wallet);
  return {
    refunded_wallet_iqd: walletRow ? Math.max(0, Number(walletRow.amount_iqd) || Number(snapshot.totals.wallet_applied_iqd) || 0) : 0,
    refunded_points: Math.max(0, Number(results.find((r) => r.id === points)?.amount) || 0),
  };
}

invoiceRoutes.get('/mine', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, o.user_id AS owner_user_id
       FROM invoices i JOIN orders o ON o.id = i.order_id
      WHERE o.user_id = ? ORDER BY i.issued_at DESC LIMIT 100`
  )
    .bind(user.id)
    .all<InvoiceRow>();
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, invoices: results.map((r) => invoicePublic(r, false)) });
});

invoiceRoutes.get('/:id', async (c) => {
  const row = await loadAuthorized(c, c.req.param('id'));
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, invoice: invoicePublic(row, true) });
});

invoiceRoutes.get('/:id/html', async (c) => {
  const user = c.get('user')!;
  const row = await loadAuthorized(c, c.req.param('id'));
  const snapshot = safeParse<InvoiceSnapshotV1 | null>(row.snapshot, null);
  if (!snapshot) throw notFound('Invoice snapshot is unreadable');
  const lang = emailLang(c.req.query('lang') || localeToApi(user.locale));
  const doc = renderInvoiceHtmlDocument(lang, invoiceEmailData(snapshot, row.invoice_no, row.revision, row.issued_at), await cancellationOf(c.env.DB, row, snapshot));
  c.header('Cache-Control', 'no-store');
  asDocument(c);
  return c.html(doc);
});

// Admin: append a correction revision (revision N+1, previous row linked via
// superseded_by). Never mutates the issued invoice; audited.
invoiceRoutes.post('/:id/revise', requireAdmin, async (c) => {
  await rateLimit(c, 'invoice-revise', 30, 3600);
  const user = c.get('user')!;
  const invoiceId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 500 });
  const input: Parameters<typeof createInvoiceRevision>[2] = { reason };
  if (body.amountPaidIqd !== undefined) input.amount_paid_iqd = int(body.amountPaidIqd, 'amountPaidIqd', { min: 0, max: 2_000_000_000 });
  if (body.amountDueIqd !== undefined) input.amount_due_iqd = int(body.amountDueIqd, 'amountDueIqd', { min: 0, max: 2_000_000_000 });
  if (body.paymentStatus !== undefined) {
    input.payment_status = oneOf(body.paymentStatus, 'paymentStatus', ['unpaid', 'partial', 'paid', 'cod_due', 'bnpl_due'] as const);
  }

  const res = await createInvoiceRevision(c.env, invoiceId, input, user.id);
  if (!res.ok) {
    if (res.code === 'NOT_FOUND') throw notFound(res.error);
    if (res.code === 'SUPERSEDED' || res.code === 'CONFLICT') throw conflict(res.error);
    throw badRequest(res.error, res.code);
  }
  await audit(c.env.DB, user.id, 'invoice.revise', res.invoiceId, {
    from_invoice: invoiceId,
    revision: res.revision,
    reason,
    paid: input.amount_paid_iqd,
    due: input.amount_due_iqd,
    status: input.payment_status,
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, invoiceId: res.invoiceId, invoiceNo: res.invoiceNo, revision: res.revision });
});

// Admin: controlled, audited resend of one invoice email to the order owner.
// Still requires a VERIFIED owner address and respects the staging allowlist;
// each resend is its own outbox row with a fresh unique event key.
invoiceRoutes.post('/:id/resend', requireAdmin, async (c) => {
  await rateLimit(c, 'invoice-resend', 30, 3600);
  const user = c.get('user')!;
  const row = await loadAuthorized(c, c.req.param('id') ?? '');
  const snapshot = safeParse<InvoiceSnapshotV1 | null>(row.snapshot, null);
  if (!snapshot) throw badRequest('Invoice snapshot is unreadable', 'BAD_SNAPSHOT');

  const owner = await c.env.DB.prepare('SELECT id, email, name, locale, email_verified_at FROM users WHERE id = ?')
    .bind(row.owner_user_id)
    .first<{ id: string; email: string; name: string; locale: string; email_verified_at: string | null }>();
  if (!owner) throw notFound('Order owner not found');
  // A blank stamp ('' or spaces) is no stamp (worker/lib/emailStamp.ts).
  if (!isStamped(owner.email_verified_at)) {
    throw badRequest('The customer has not verified their email address — invoice email cannot be sent', 'RECIPIENT_UNVERIFIED');
  }

  const lang = localeToApi(owner.locale);
  const origin = (c.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  const msg = renderOrderInvoiceEmail(
    lang,
    invoiceEmailData(snapshot, row.invoice_no, row.revision, row.issued_at),
    origin ? `${origin}/orders` : ''
  );
  const eventKey = `invoice:${row.order_id}:${row.revision}:resend:${newId('')}`;
  const enqueued = await enqueue(c.env, eventKey, {
    kind: 'email',
    to: owner.email,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
  if (!enqueued) throw conflict('This resend was already enqueued');
  await audit(c.env.DB, user.id, 'invoice.resend', row.id, { order_id: row.order_id, revision: row.revision });
  c.executionCtx.waitUntil(processOutbox(c.env, 3));
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, enqueued: true });
});
