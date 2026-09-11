import { newId } from './crypto';
import { effectiveHoldsUsdSql } from './walletOps';

/**
 * Wallet helpers. Balances are always derived server-side from approved
 * transactions; spending uses a conditional INSERT so that concurrent
 * requests cannot overdraw (the guard and the insert run atomically in
 * SQLite).
 */

export async function getBalances(db: D1Database, userId: string): Promise<{ usd_cents: number; points: number }> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN currency='USD' AND status='approved' THEN (CASE WHEN type='deposit' THEN amount ELSE -amount END) ELSE 0 END), 0) AS usd_cents,
         COALESCE(SUM(CASE WHEN currency='POINT' AND status='approved' THEN (CASE WHEN type='deposit' THEN amount ELSE -amount END) ELSE 0 END), 0) AS points
       FROM wallet_transactions WHERE user_id = ?`
    )
    .bind(userId)
    .first<{ usd_cents: number; points: number }>();
  return { usd_cents: row?.usd_cents ?? 0, points: row?.points ?? 0 };
}

/**
 * Atomically spend from a balance: inserts an approved withdrawal only if the
 * SPENDABLE balance covers it — for USD that is the approved sum minus active
 * withdrawal holds (walletOps), the same number the wallet page shows. Points
 * have no holds. Returns the transaction id, or null if insufficient.
 */
export async function spend(
  db: D1Database,
  userId: string,
  currency: 'USD' | 'POINT',
  amount: number,
  note: string,
  ref: string
): Promise<string | null> {
  if (!Number.isInteger(amount) || amount <= 0) return null;
  const id = newId('wtx');
  const res = await db
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
       SELECT ?1, ?2, 'withdrawal', ?3, ?4, 'approved', ?5, ?6, 'system', strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE (
         SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END), 0)
           FROM wallet_transactions
          WHERE user_id = ?2 AND currency = ?3 AND status = 'approved'
       ) - (CASE WHEN ?3 = 'USD' THEN ${effectiveHoldsUsdSql('?2')} ELSE 0 END) >= ?4`
    )
    .bind(id, userId, currency, amount, note, ref)
    .run();
  return res.meta.changes > 0 ? id : null;
}

/** Credit a balance (system-approved deposit), e.g. refunds and rewards. */
export async function credit(
  db: D1Database,
  userId: string,
  currency: 'USD' | 'POINT',
  amount: number,
  note: string,
  ref: string,
  createdBy: 'admin' | 'system' = 'system'
): Promise<string> {
  const id = newId('wtx');
  await db
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
       VALUES (?, ?, 'deposit', ?, ?, 'approved', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .bind(id, userId, currency, amount, note, ref, createdBy)
    .run();
  return id;
}

export function walletTxPublic(t: Record<string, unknown>) {
  return {
    id: t.id,
    type: t.type,
    currency: t.currency,
    amount: t.amount,
    status: t.status,
    date: t.created_at,
    note: t.note,
    adminNote: t.admin_note,
    accountNumber: t.account_number,
    paymentMethod: t.payment_method,
    hasReceipt: !!t.receipt_key,
    receiptUrl: t.receipt_key ? `/files/${t.receipt_key}` : null,
    ref: t.ref,
  };
}
