import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { requireAuth, badRequest, int, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { getBalances, walletTxPublic } from '../lib/wallet';
import { rateLimit } from '../lib/ratelimit';

export const walletRoutes = new Hono<AppContext>();
walletRoutes.use('*', requireAuth);

walletRoutes.get('/', async (c) => {
  const user = c.get('user')!;
  const balances = await getBalances(c.env.DB, user.id);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 200'
  )
    .bind(user.id)
    .all<Record<string, unknown>>();
  return c.json({
    success: true,
    balance_usd_cents: balances.usd_cents,
    point_balance: balances.points,
    transactions: results.filter((t) => t.currency === 'USD').map(walletTxPublic),
    point_transactions: results.filter((t) => t.currency === 'POINT').map(walletTxPublic),
  });
});

/**
 * Deposit request: amount in USD cents plus the R2 key of an uploaded
 * receipt (uploaded first via /api/uploads with purpose=receipt). Stays
 * `pending` until an admin reviews it — a receipt never means "paid".
 */
walletRoutes.post('/deposits', async (c) => {
  await rateLimit(c, 'wallet-deposit', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_usd_cents, 'amount_usd_cents', { min: 100, max: 100_000_000 });
  const note = str(body.note, 'note', { max: 500, required: false });
  const paymentMethod = str(body.paymentMethod, 'paymentMethod', { max: 60, required: false });
  const receiptKey = str(body.receiptKey, 'receiptKey', { min: 5, max: 300 });

  if (!receiptKey.startsWith(`receipts/${user.id}/`)) {
    throw badRequest('Receipt upload is required for deposits');
  }
  const obj = await c.env.BUCKET.head(receiptKey);
  if (!obj) throw badRequest('Receipt upload not found — please upload it again');

  const id = newId('wtx');
  await c.env.DB.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, payment_method, receipt_key, created_by)
     VALUES (?, ?, 'deposit', 'USD', ?, 'pending', ?, ?, ?, 'user')`
  )
    .bind(id, user.id, amount, note, paymentMethod, receiptKey)
    .run();
  return c.json({ success: true, id, status: 'pending' });
});

/** Withdrawal request: pending until an admin approves and pays it out. */
walletRoutes.post('/withdrawals', async (c) => {
  await rateLimit(c, 'wallet-withdraw', 10, 3600);
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const amount = int(body.amount_usd_cents, 'amount_usd_cents', { min: 100, max: 100_000_000 });
  const note = str(body.note, 'note', { max: 500, required: false });
  const accountNumber = str(body.accountNumber, 'accountNumber', { max: 100, required: false });

  // The pending request must fit inside the available balance minus other
  // pending withdrawals, so approvals cannot overdraw.
  const balances = await getBalances(c.env.DB, user.id);
  const pending = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_transactions
      WHERE user_id = ? AND currency='USD' AND type='withdrawal' AND status='pending'`
  )
    .bind(user.id)
    .first<{ n: number }>();
  if (amount > balances.usd_cents - (pending?.n ?? 0)) {
    throw badRequest('Withdrawal exceeds your available balance', 'INSUFFICIENT_BALANCE');
  }

  const id = newId('wtx');
  await c.env.DB.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, account_number, created_by)
     VALUES (?, ?, 'withdrawal', 'USD', ?, 'pending', ?, ?, 'user')`
  )
    .bind(id, user.id, amount, note, accountNumber)
    .run();
  return c.json({ success: true, id, status: 'pending' });
});
