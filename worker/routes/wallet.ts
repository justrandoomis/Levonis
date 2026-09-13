import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, requireAdmin, badRequest, conflict, forbidden, notFound, int, str, oneOf } from '../lib/http';
import { newId } from '../lib/crypto';
import { walletTxPublic } from '../lib/wallet';
import { rateLimit } from '../lib/ratelimit';
import { notifyAdmins } from '../lib/telegram';
import {
  closeDepositNotification,
  enqueueUserDepositStatusNotification,
  notifyAdminsOfDeposit,
} from '../lib/walletNotify';
import { audit } from '../lib/audit';
import { headMediaObject } from '../lib/mediaStorage';
import {
  MAX_AMOUNT_CENTS,
  WITHDRAWAL_FEE_POLICY,
  WITHDRAWAL_STATES,
  WITHDRAWAL_TRANSITIONS,
  advanceWithdrawal,
  clearWithdrawalReconciliation,
  closeWithdrawal,
  createDepositRequest,
  decideDeposit,
  depositAmountReview,
  flagWithdrawalForReconciliation,
  getWalletBreakdown,
  getWithdrawal,
  markWithdrawalPaid,
  operationNumber,
  requestWithdrawal,
  walletReconciliationReport,
  withdrawalFeeQuote,
  type WithdrawalOpResult,
  type WithdrawalRow,
} from '../lib/walletOps';

/**
 * Wallet API (integrated mandate §11.1–§11.4).
 *
 * What changed versus the first wallet: money is now reported as THREE
 * separate numbers — available, held and pending — and a withdrawal reserves
 * its amount the moment it is filed, so the same balance cannot be both
 * withdrawn and spent. Deposit requests carry their transfer context
 * (provider/channel/reference) so the same transfer can never be credited
 * twice, and a payout is only ever recorded — never executed — by a human
 * with a written reference.
 *
 * The shape of GET /api/wallet is additive: `balance_usd_cents`,
 * `point_balance`, `transactions` and `point_transactions` still mean what
 * they meant, with `balance_usd_cents` now reporting the SPENDABLE balance
 * (identical to the old number whenever nothing is held).
 */

export const walletRoutes = new Hono<AppContext>();
walletRoutes.use('*', requireAuth);

const TX_STATUSES = ['pending', 'approved', 'rejected'] as const;
const TX_TYPES = ['deposit', 'withdrawal'] as const;

/** Public shape of a withdrawal request (owner + admin safe). */
function withdrawalPublic(w: WithdrawalRow) {
  return {
    id: w.id,
    number: operationNumber(w.id, 'WD'),
    amount_usd_cents: w.amount_cents,
    fee_cents: w.fee_cents,
    net_cents: w.net_cents,
    fee_policy: w.fee_policy,
    fee_configured: WITHDRAWAL_FEE_POLICY.configured,
    state: w.state,
    // Explicitly NOT "paid": approving only authorises processing.
    money_sent: w.state === 'paid',
    needs_reconciliation: w.needs_reconciliation === 1,
    destination: {
      kind: w.destination_kind,
      account: w.destination_account,
      holder: w.destination_holder,
      note: w.destination_note,
      frozen_at: w.destination_frozen_at,
    },
    payout_reference: w.payout_reference || null,
    payout_at: w.payout_at,
    outcome_reason: w.outcome_reason || null,
    tx_id: w.tx_id,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

/** Maps an engine result to an honest HTTP error (no invented success). */
function throwForWithdrawalFailure(res: Extract<WithdrawalOpResult, { ok: false }>): never {
  switch (res.reason) {
    case 'INVALID_AMOUNT':
      throw badRequest('Amount must be a whole number of cents above zero', 'INVALID_AMOUNT');
    case 'INSUFFICIENT_AVAILABLE':
      throw badRequest(
        'Withdrawal exceeds your available balance (pending deposits and existing holds are not available)',
        'INSUFFICIENT_BALANCE'
      );
    case 'DUPLICATE_EVENT':
      throw conflict('This request was already filed');
    case 'EVENT_KEY_REUSED':
      throw conflict('That idempotency key was already used with different details');
    case 'MISSING_EVENT_KEY':
      throw badRequest('Missing idempotency key');
    case 'MISSING_PAYOUT_REFERENCE':
      throw badRequest('A payout reference is required before a withdrawal can be marked paid', 'PAYOUT_REFERENCE_REQUIRED');
    case 'NEEDS_RECONCILIATION':
      throw conflict('This withdrawal is awaiting reconciliation — resolve the unknown payout outcome first');
    case 'ILLEGAL_TRANSITION':
      throw conflict('That state change is not allowed from the current state');
    case 'STATE_CONFLICT':
      throw conflict('This request was already handled by someone else');
    case 'NOT_FOUND':
      throw notFound('Withdrawal request not found');
    default:
      throw conflict('Request could not be completed');
  }
}

// ---------------------------------------------------------------- overview

walletRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const q = c.req.query();
  const type = q.type && q.type !== 'all' ? oneOf(q.type, 'type', TX_TYPES) : null;
  const status = q.status && q.status !== 'all' ? oneOf(q.status, 'status', TX_STATUSES) : null;
  const search = str(q.q, 'q', { max: 60, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 200, def: 200 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });

  let sql = "SELECT * FROM wallet_transactions WHERE user_id = ? AND currency = 'USD'";
  const params: unknown[] = [user.id];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    // Operation numbers are the tail of the id; note/reference search stays
    // scoped to this user's own rows (never a global lookup).
    sql += ' AND (id LIKE ? OR note LIKE ? OR ref LIKE ?)';
    const like = `%${search.replace(/^[A-Za-z]+-/, '').toLowerCase()}%`;
    params.push(like, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [breakdown, usdRows, pointRows, withdrawals, reviews] = await Promise.all([
    getWalletBreakdown(c.env.DB, user.id),
    c.env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      "SELECT * FROM wallet_transactions WHERE user_id = ? AND currency = 'POINT' ORDER BY created_at DESC LIMIT 200"
    )
      .bind(user.id)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare('SELECT * FROM wallet_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100')
      .bind(user.id)
      .all<WithdrawalRow>(),
    c.env.DB.prepare(
      'SELECT tx_id, state FROM wallet_review_requests WHERE user_id = ? AND state = ? LIMIT 200'
    )
      .bind(user.id, 'open')
      .all<{ tx_id: string; state: string }>(),
  ]);

  const openReviews = new Set((reviews.results ?? []).map((r) => r.tx_id));
  const depositMeta = await c.env.DB.prepare(
    `SELECT tx_id, provider, channel, reference, review_state FROM wallet_deposit_meta WHERE user_id = ? LIMIT 300`
  )
    .bind(user.id)
    .all<{ tx_id: string; provider: string; channel: string; reference: string; review_state: string }>();
  const metaById = new Map((depositMeta.results ?? []).map((m) => [m.tx_id, m]));

  const decorate = (t: Record<string, unknown>) => {
    const meta = metaById.get(String(t.id));
    return {
      ...walletTxPublic(t),
      number: operationNumber(String(t.id)),
      reviewRequested: openReviews.has(String(t.id)),
      depositContext: meta
        ? { provider: meta.provider, channel: meta.channel, reference: meta.reference, review_state: meta.review_state }
        : null,
    };
  };

  return c.json({
    success: true,
    // Back-compatible key — now the SPENDABLE balance (settled minus holds).
    balance_usd_cents: breakdown.usd_cents_available,
    point_balance: breakdown.points_settled,
    transactions: (usdRows.results ?? []).map(decorate),
    point_transactions: (pointRows.results ?? []).map((t) => ({ ...walletTxPublic(t), number: operationNumber(String(t.id), 'P') })),
    balances: {
      usd_cents_settled: breakdown.usd_cents_settled,
      usd_cents_held: breakdown.usd_cents_held,
      usd_cents_available: breakdown.usd_cents_available,
      usd_cents_pending_deposits: breakdown.usd_cents_pending_deposits,
      usd_cents_pending_withdrawals: breakdown.usd_cents_pending_withdrawals,
      points_settled: breakdown.points_settled,
      points_pending: breakdown.points_pending,
    },
    withdrawals: (withdrawals.results ?? []).map(withdrawalPublic),
    paging: { limit, offset, returned: usdRows.results?.length ?? 0 },
  });
});

/**
 * Honest policy surface for the withdrawal form: no invented fee, no
 * invented limit, and no pretence that a live payout channel exists
 * (mandate §11.3 / §13.1 — an owner decision that has not been made).
 */
walletRoutes.get('/policy', (c) =>
  c.json({
    success: true,
    withdrawal: {
      fee_configured: WITHDRAWAL_FEE_POLICY.configured,
      fee_policy: WITHDRAWAL_FEE_POLICY.policy,
      live_payout: WITHDRAWAL_FEE_POLICY.live_payout,
      min_amount_usd_cents: 100,
      max_amount_usd_cents: MAX_AMOUNT_CENTS,
      states: WITHDRAWAL_STATES,
      transitions: WITHDRAWAL_TRANSITIONS,
    },
  })
);

// ---------------------------------------------------------------- deposits

/**
 * Deposit request: amount in USD cents plus the R2 key of an uploaded
 * receipt (uploaded first via /api/uploads with purpose=receipt). Stays
 * `pending` until an admin reviews it — a receipt never means "paid".
 *
 * The transfer context (provider/channel/reference) is what makes one
 * transfer one credit: the reference is deduplicated inside its own context
 * by a UNIQUE index (migration 0015), so re-sending with a fresh idempotency
 * key or a renamed screenshot cannot buy a second credit (§11.2/§11.4). The
 * attachment fingerprint is recorded as a REVIEW SIGNAL only.
 */
walletRoutes.post('/deposits', async (c) => {
  await rateLimit(c, 'wallet-deposit', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_usd_cents, 'amount_usd_cents', { min: 100, max: MAX_AMOUNT_CENTS });
  const note = str(body.note, 'note', { max: 500, required: false });
  const paymentMethod = str(body.paymentMethod, 'paymentMethod', { max: 60, required: false });
  const receiptKey = str(body.receiptKey, 'receiptKey', { min: 5, max: 300 });
  const provider = str(body.provider, 'provider', { max: 60, required: false }) || paymentMethod;
  const channel = str(body.channel, 'channel', { max: 60, required: false });
  const reference = str(body.reference, 'reference', { max: 120, required: false });

  if (!receiptKey.startsWith(`receipts/${user.id}/`)) {
    throw badRequest('Receipt upload is required for deposits');
  }
  const obj = await headMediaObject(c.env, 'private', receiptKey);
  if (!obj) throw badRequest('Receipt upload not found — please upload it again');

  // Weak content fingerprint from the stored object (md5/etag). It flags a
  // re-used receipt image for the reviewer; it is NOT anti-forgery proof.
  const fingerprint = (obj.checksums?.md5 ? bytesToHex(obj.checksums.md5) : obj.etag || '').slice(0, 80);

  const created = await createDepositRequest(c.env.DB, {
    userId: user.id,
    amountCents: amount,
    receiptKey,
    note,
    paymentMethod,
    provider,
    channel,
    reference,
    fingerprint,
  });
  if (!created.ok) {
    if (created.reason === 'INVALID_AMOUNT') throw badRequest('Amount must be a whole number of cents above zero', 'INVALID_AMOUNT');
    throw conflict(
      'A deposit with this transfer reference was already submitted for this payment method — ask support to review it instead of sending it again'
    );
  }
  const id = created.txId;
  const reviewState = created.reviewState;

  await audit(c.env.DB, user.id, 'wallet.deposit.requested', id, {
    amount_usd_cents: amount,
    provider,
    channel,
    has_reference: !!reference,
    review_state: reviewState,
  });
  // §12.1 — the admin group gets the operation WITH its proof attached, its
  // buttons and its retry row (tg_admin_notifications). The plain text line is
  // the fallback for the one case the rich path cannot cover: the request row
  // could not be read back, so nothing describes it. A delivery failure is
  // never silent — the row stays pending and the durable job retries it.
  c.executionCtx.waitUntil(
    notifyAdminsOfDeposit(c.env, id)
      .then(async (res) => {
        if (res.enqueued || res.reason === 'already_enqueued') return;
        await notifyAdmins(
          c.env,
          `💰 New deposit request (pending review)\nOperation: ${operationNumber(id)}\nUser: ${user.username || user.email}\nAmount: $${(amount / 100).toFixed(2)}${provider ? `\nMethod: ${provider}` : ''}${reference ? `\nReference: ${reference}` : ''}${reviewState !== 'awaiting_review' ? `\nSignal: ${reviewState}` : ''}`
        );
      })
      .catch((e) => console.error('deposit admin notification failed', e instanceof Error ? e.message : e))
  );
  return c.json({ success: true, id, number: operationNumber(id), status: 'pending', review_state: reviewState });
});

function bytesToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// -------------------------------------------------------------- withdrawals

/**
 * Withdrawal request: reserves the amount from the AVAILABLE balance in the
 * same transaction that opens the request, freezes the destination, and
 * leaves the ledger row pending. Nothing is transferred here and approval
 * later means "approved for processing", not "sent" (§11.3).
 */
walletRoutes.post('/withdrawals', async (c) => {
  await rateLimit(c, 'wallet-withdraw', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_usd_cents, 'amount_usd_cents', { min: 100, max: MAX_AMOUNT_CENTS });
  const note = str(body.note, 'note', { max: 500, required: false });
  // `accountNumber` is the pre-existing field name; it is accepted as the
  // destination account of a manual transfer so older clients keep working.
  const account = str(body.destinationAccount ?? body.accountNumber, 'destinationAccount', { min: 3, max: 120 });
  const kind = str(body.destinationKind, 'destinationKind', { max: 40, required: false }) || 'manual_transfer';
  const holder = str(body.destinationHolder, 'destinationHolder', { max: 120, required: false });
  const destinationNote = str(body.destinationNote, 'destinationNote', { max: 300, required: false });
  const idempotencyKey = str(body.idempotencyKey, 'idempotencyKey', { max: 80, required: false });

  const res = await requestWithdrawal(c.env.DB, {
    userId: user.id,
    amountCents: amount,
    destination: { kind, account, holder, note: destinationNote },
    eventKey: idempotencyKey ? `wd:${idempotencyKey}` : `wd:${newId('evt')}`,
    note,
  });
  if (!res.ok) throwForWithdrawalFailure(res);

  const row = await getWithdrawal(c.env.DB, res.id);
  await audit(c.env.DB, user.id, 'wallet.withdrawal.requested', res.id, {
    amount_usd_cents: amount,
    destination_kind: kind,
    replayed: res.replayed,
  });
  if (!res.replayed) {
    c.executionCtx.waitUntil(
      notifyAdmins(
        c.env,
        `🏧 New withdrawal request (pending review — no transfer made)\nOperation: ${operationNumber(res.id, 'WD')}\nUser: ${user.username || user.email}\nAmount: $${(amount / 100).toFixed(2)}\nDestination: ${kind}`
      )
    );
  }
  return c.json({
    success: true,
    id: res.id,
    number: operationNumber(res.id, 'WD'),
    status: row?.state ?? 'requested',
    replayed: res.replayed,
    quote: withdrawalFeeQuote(amount),
    withdrawal: row ? withdrawalPublic(row) : null,
  });
});

walletRoutes.get('/withdrawals', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM wallet_withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(user.id)
    .all<WithdrawalRow>();
  return c.json({ success: true, withdrawals: (results ?? []).map(withdrawalPublic) });
});

/** The user may cancel only BEFORE processing starts; the hold is released once. */
walletRoutes.post('/withdrawals/:id/cancel', async (c) => {
  await rateLimit(c, 'wallet-withdraw-cancel', 20, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const row = await getWithdrawal(c.env.DB, id);
  if (!row) throw notFound('Withdrawal request not found');
  if (row.user_id !== user.id) throw forbidden('This request belongs to another account');

  const res = await closeWithdrawal(c.env.DB, {
    id,
    to: 'cancelled',
    actorId: user.id,
    reason: 'cancelled by the account owner',
    allowedFrom: ['requested', 'approved'],
  });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, user.id, 'wallet.withdrawal.cancelled', id, { replayed: res.replayed });
  const after = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: after ? withdrawalPublic(after) : null });
});

// ------------------------------------------------------------ review request

/** §11.1: the user can ask for a review of an operation that belongs to them. */
walletRoutes.post('/transactions/:id/review-request', async (c) => {
  await rateLimit(c, 'wallet-review-request', 10, 3600);
  const user = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 5, max: 500 });

  const tx = await c.env.DB.prepare('SELECT id, user_id FROM wallet_transactions WHERE id = ?')
    .bind(id)
    .first<{ id: string; user_id: string }>();
  if (!tx) throw notFound('Operation not found');
  if (tx.user_id !== user.id) throw forbidden('This operation belongs to another account');

  const reviewId = newId('wrev');
  let created = 0;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO wallet_review_requests (id, tx_id, user_id, reason, state, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE NOT EXISTS (SELECT 1 FROM wallet_review_requests r WHERE r.tx_id = ?2 AND r.user_id = ?3 AND r.state = 'open')`
    )
      .bind(reviewId, id, user.id, reason)
      .run();
    created = res.meta.changes ?? 0;
  } catch {
    created = 0;
  }
  if (created === 0) throw conflict('A review request for this operation is already open');

  await audit(c.env.DB, user.id, 'wallet.review.requested', id, { review_id: reviewId });
  return c.json({ success: true, id: reviewId, state: 'open' });
});

walletRoutes.get('/review-requests', async (c) => {
  const user = c.get('user')!;
  const { results } = await c.env.DB.prepare(
    'SELECT id, tx_id, reason, state, admin_note, created_at, updated_at FROM wallet_review_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
  )
    .bind(user.id)
    .all();
  return c.json({ success: true, requests: results ?? [] });
});

// ---------------------------------------------------------------- admin

/**
 * Read-only reconciliation: does the ledger match the holds and the requests?
 * It reports, it never repairs — an automatic "fix" here would be inventing
 * money (§11.4).
 */
walletRoutes.get('/admin/reconciliation', requireAdmin, async (c) => {
  const report = await walletReconciliationReport(c.env.DB);
  return c.json({ success: true, report });
});

walletRoutes.get('/admin/withdrawals', requireAdmin, async (c) => {
  const state = c.req.query('state');
  let sql = `SELECT w.*, u.email, u.username FROM wallet_withdrawals w
               LEFT JOIN users u ON u.id = w.user_id`;
  const params: unknown[] = [];
  if (state && (WITHDRAWAL_STATES as readonly string[]).includes(state)) {
    sql += ' WHERE w.state = ?';
    params.push(state);
  }
  sql += ' ORDER BY w.created_at DESC LIMIT 300';
  const { results } = await c.env.DB.prepare(sql)
    .bind(...params)
    .all<WithdrawalRow & { email: string; username: string }>();
  return c.json({
    success: true,
    withdrawals: (results ?? []).map((w) => ({ ...withdrawalPublic(w), email: w.email, username: w.username, userId: w.user_id })),
  });
});

/** requested → approved. Authorises PROCESSING only; no money moves. */
walletRoutes.post('/admin/withdrawals/:id/approve', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const res = await advanceWithdrawal(c.env.DB, { id, to: 'approved', actorId: admin.id });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.approved_for_processing', id, { replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({
    success: true,
    replayed: res.replayed,
    note: 'Approved for processing — this is not a payout confirmation',
    withdrawal: row ? withdrawalPublic(row) : null,
  });
});

/** approved → processing (a human is now working the transfer). */
walletRoutes.post('/admin/withdrawals/:id/processing', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const res = await advanceWithdrawal(c.env.DB, { id, to: 'processing', actorId: admin.id });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.processing', id, { replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * processing → paid. Requires the reference of a transfer that ALREADY
 * happened; the hold is committed and the ledger debit posts in the same
 * transaction, so the balance drops exactly once.
 */
walletRoutes.post('/admin/withdrawals/:id/paid', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const payoutReference = str(body.payoutReference, 'payoutReference', { min: 3, max: 120 });
  const note = str(body.note, 'note', { max: 300, required: false });

  const res = await markWithdrawalPaid(c.env.DB, { id, payoutReference, actorId: admin.id, note });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.paid', id, {
    payout_reference: payoutReference,
    replayed: res.replayed,
  });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/** Reject: releases the hold exactly once, with a recorded reason. */
walletRoutes.post('/admin/withdrawals/:id/reject', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });
  const res = await closeWithdrawal(c.env.DB, { id, to: 'rejected', actorId: admin.id, reason });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.rejected', id, { reason, replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * Final failure of a transfer whose outcome IS known (the channel refused
 * it). The hold is released exactly once. A transfer with an UNKNOWN outcome
 * must go through /reconcile instead — never straight to failed.
 */
walletRoutes.post('/admin/withdrawals/:id/fail', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });
  const res = await closeWithdrawal(c.env.DB, { id, to: 'failed', actorId: admin.id, reason });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.failed', id, { reason, replayed: res.replayed });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, replayed: res.replayed, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * The payout attempt returned an unknown outcome (network failure at the
 * transfer channel). The request stays in processing with the money still
 * held: no second transfer, no instant release (§11.3).
 */
walletRoutes.post('/admin/withdrawals/:id/reconcile', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const note = str(body.note, 'note', { min: 3, max: 500 });
  const res = await flagWithdrawalForReconciliation(c.env.DB, { id, actorId: admin.id, note });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.reconciliation_flagged', id, { note });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({
    success: true,
    note: 'Held for reconciliation — no second payout and no release until the outcome is established',
    withdrawal: row ? withdrawalPublic(row) : null,
  });
});

/** Records what the channel actually did; the outcome is decided separately. */
walletRoutes.post('/admin/withdrawals/:id/reconcile/clear', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const finding = str(body.finding, 'finding', { min: 3, max: 500 });
  const res = await clearWithdrawalReconciliation(c.env.DB, { id, actorId: admin.id, finding });
  if (!res.ok) throwForWithdrawalFailure(res);
  await audit(c.env.DB, admin.id, 'wallet.withdrawal.reconciliation_cleared', id, { finding });
  const row = await getWithdrawal(c.env.DB, id);
  return c.json({ success: true, withdrawal: row ? withdrawalPublic(row) : null });
});

/**
 * Finance records what actually arrived. A mismatch parks the request in
 * `amount_mismatch`, which the approval path below refuses — a difference is
 * never approved silently (§11.2).
 */
walletRoutes.post('/admin/deposits/:id/observe', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const observed = int(body.observedAmountCents, 'observedAmountCents', { min: 1, max: MAX_AMOUNT_CENTS });
  const note = str(body.note, 'note', { max: 300, required: false });

  const meta = await c.env.DB.prepare('SELECT declared_amount_cents FROM wallet_deposit_meta WHERE tx_id = ?')
    .bind(id)
    .first<{ declared_amount_cents: number }>();
  if (!meta) throw notFound('Deposit context not found for this operation');
  const reviewState = depositAmountReview(meta.declared_amount_cents, observed);

  const res = await c.env.DB.prepare(
    `UPDATE wallet_deposit_meta
        SET observed_amount_cents = ?2, review_state = ?3, review_note = substr(?4, 1, 300),
            reviewed_by = ?5, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE tx_id = ?1
        AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1 AND t.status = 'pending')`
  )
    .bind(id, observed, reviewState, note, admin.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    throw conflict('This deposit is no longer pending — a decided deposit is corrected with a linked adjustment');
  }
  await audit(c.env.DB, admin.id, 'wallet.deposit.observed', id, {
    declared: meta.declared_amount_cents,
    observed,
    review_state: reviewState,
  });
  return c.json({ success: true, review_state: reviewState, matches: reviewState === 'cleared_for_decision' });
});

/**
 * Deposit approval that credits ONCE, atomically, and refuses to approve a
 * request whose observed amount does not match what the user declared. (The
 * legacy generic admin decide endpoint still exists; the integration note in
 * this slice's report asks for it to be pointed here.)
 */
walletRoutes.post('/admin/deposits/:id/approve', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const adminNote = str(body.adminNote, 'adminNote', { max: 500, required: false });

  // §12.2 — the SAME service the Telegram inline button calls. One conditional
  // UPDATE decides; the loser of a race is told it was already processed.
  const res = await decideDeposit(c.env, {
    requestId: id,
    action: 'approve',
    actorUserId: admin.id,
    reason: adminNote,
    source: 'site',
  });
  if (!res.ok) {
    if (res.reason === 'AMOUNT_MISMATCH') {
      throw conflict(
        'The observed amount does not match the requested amount — reject this request and file a linked adjustment for the amount that actually arrived'
      );
    }
    throw conflict('This deposit is not pending (it may already be decided)');
  }
  // Message updates and customer notifications only — never the ledger.
  c.executionCtx.waitUntil(
    Promise.allSettled([closeDepositNotification(c.env, id), enqueueUserDepositStatusNotification(c.env, id)]).then(
      () => undefined
    )
  );
  return c.json({ success: true });
});

/** Rejection records a reason and frees the reference for an honest resubmission. */
walletRoutes.post('/admin/deposits/:id/reject', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const reason = str(body.reason, 'reason', { min: 3, max: 300 });

  const res = await decideDeposit(c.env, {
    requestId: id,
    action: 'reject',
    actorUserId: admin.id,
    reason,
    source: 'site',
  });
  if (!res.ok) {
    if (res.reason === 'REASON_REQUIRED') throw badRequest('A rejection reason is required', 'REASON_REQUIRED');
    throw conflict('This deposit is not pending (it may already be decided)');
  }
  c.executionCtx.waitUntil(
    Promise.allSettled([closeDepositNotification(c.env, id), enqueueUserDepositStatusNotification(c.env, id)]).then(
      () => undefined
    )
  );
  return c.json({ success: true });
});

/**
 * Correction of a FINAL operation: a new linked ledger row, never an edit of
 * the original (§11.2/§11.1). Idempotent per (original, eventKey), so a
 * double click cannot credit twice.
 */
walletRoutes.post('/admin/transactions/:id/adjustment', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const originalId = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const direction = oneOf(body.direction, 'direction', ['credit', 'debit'] as const);
  const amount = int(body.amountCents, 'amountCents', { min: 1, max: MAX_AMOUNT_CENTS });
  const reason = str(body.reason, 'reason', { min: 5, max: 300 });
  const eventKey = str(body.eventKey, 'eventKey', { min: 4, max: 80 });

  const original = await c.env.DB.prepare(
    "SELECT id, user_id, status, currency FROM wallet_transactions WHERE id = ? AND currency = 'USD'"
  )
    .bind(originalId)
    .first<{ id: string; user_id: string; status: string; currency: string }>();
  if (!original) throw notFound('Original operation not found');
  if (original.status === 'pending') {
    throw badRequest('Decide the original request first — a pending row is not corrected with an adjustment');
  }

  const existing = await c.env.DB.prepare(
    'SELECT id, adjustment_tx_id FROM wallet_adjustments WHERE original_tx_id = ? AND event_key = ?'
  )
    .bind(originalId, eventKey)
    .first<{ id: string; adjustment_tx_id: string }>();
  if (existing) {
    return c.json({ success: true, id: existing.id, tx_id: existing.adjustment_tx_id, replayed: true });
  }

  const adjId = newId('wadj');
  const txId = newId('wtx');
  const statements = [
    c.env.DB.prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, decided_by)
       VALUES (?1, ?2, ?3, 'USD', ?4, 'approved', ?5, ?6, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?7)`
    ).bind(
      txId,
      original.user_id,
      direction === 'credit' ? 'deposit' : 'withdrawal',
      amount,
      `adjustment for ${operationNumber(originalId)}: ${reason}`,
      originalId,
      admin.id
    ),
    c.env.DB.prepare(
      `INSERT INTO wallet_adjustments (id, original_tx_id, adjustment_tx_id, user_id, direction, amount_cents, reason, actor_id, event_key)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?3)`
    ).bind(adjId, originalId, txId, original.user_id, direction, amount, reason, admin.id, eventKey),
  ];
  try {
    await c.env.DB.batch(statements);
  } catch {
    throw conflict('This adjustment key was already used for this operation');
  }
  await audit(c.env.DB, admin.id, 'wallet.adjustment', originalId, { direction, amount, reason, tx_id: txId });
  return c.json({ success: true, id: adjId, tx_id: txId, replayed: false });
});

walletRoutes.get('/admin/review-requests', requireAdmin, async (c) => {
  const state = str(c.req.query('state'), 'state', { max: 20, required: false }) || 'open';
  const { results } = await c.env.DB.prepare(
    `SELECT r.*, u.email, u.username FROM wallet_review_requests r
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.state = ? ORDER BY r.created_at DESC LIMIT 200`
  )
    .bind(state)
    .all();
  return c.json({ success: true, requests: results ?? [] });
});

walletRoutes.post('/admin/review-requests/:id/close', requireAdmin, async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id') ?? '';
  const body = await c.req.json().catch(() => ({}));
  const adminNote = str(body.adminNote, 'adminNote', { min: 3, max: 500 });
  const state = oneOf(body.state ?? 'answered', 'state', ['answered', 'closed'] as const);
  const res = await c.env.DB.prepare(
    `UPDATE wallet_review_requests
        SET state = ?2, admin_note = ?3, handled_by = ?4, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?1 AND state = 'open'`
  )
    .bind(id, state, adminNote, admin.id)
    .run();
  if ((res.meta.changes ?? 0) === 0) throw conflict('This review request is no longer open');
  await audit(c.env.DB, admin.id, 'wallet.review.closed', id, { state });
  return c.json({ success: true });
});
