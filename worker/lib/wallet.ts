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

/**
 * An approved USD CREDIT that records the dinars it was worth (migration 0108)
 * — the shape a return refund and a price-protection credit write.
 *
 * WHY THE DINARS TRAVEL. A refund of 50,000 د.ع is 3,571 cents at 1,400, and
 * 3,571 cents read back as 49,994: the customer was shown «+49,994» for a
 * refund of 50,000, and — because the order's wallet debit had recorded its
 * dinars — ended the round trip six dinars poorer than before they ordered.
 * With `amount_iqd` beside the cents, 0108's remainder term restores the six,
 * and the row reads exactly what was refunded.
 *
 * `ledgerDinars` is `walletLedgerDinarsReady(db)`, asked by the caller: on a
 * database behind on 0108 the two columns are left out entirely rather than
 * aborting the insert. A plain VALUES insert with a deterministic id, so a
 * retried credit fails on the PRIMARY KEY and the caller reads that as the
 * replay it is. The pair travels together or not at all.
 */
export function walletCreditStatement(
  db: D1Database,
  ledgerDinars: boolean,
  p: {
    id: string;
    userId: string;
    cents: number;
    note: string;
    ref: string;
    nowIso: string;
    amountIqd: number;
    rate: number;
    createdBy?: 'admin' | 'system';
  }
): D1PreparedStatement {
  const withDinars =
    ledgerDinars && Number.isInteger(p.amountIqd) && p.amountIqd > 0 && Number.isInteger(p.rate) && p.rate > 0;
  const createdBy = p.createdBy ?? 'admin';
  if (!withDinars) {
    return db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, ?, ?)`
      )
      .bind(p.id, p.userId, p.cents, p.note, p.ref, createdBy, p.nowIso);
  }
  return db
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
       VALUES (?, ?, 'deposit', 'USD', ?, 'approved', ?, ?, ?, ?, ?, ?)`
    )
    .bind(p.id, p.userId, p.cents, p.note, p.ref, createdBy, p.nowIso, p.amountIqd, p.rate);
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
    /**
     * THE DINARS THIS ROW RECORDED (migration 0108) and the rate beside them,
     * or null for a row that recorded none — and on a database that has not
     * run 0108, where `SELECT *` simply has no such key.
     *
     * Every kind of row, not only the two the wallet list used to know about:
     * a 50,000 د.ع checkout debit, a return refund, a membership charge and an
     * admin credit all record their dinars now, and the list printed each of
     * them as its cents converted back — «−IQD 49,994» beside a header that
     * said 50,000. A reader prints this when it is present and converts the
     * cents only when it is not; the pair travels together or not at all.
     */
    amount_iqd: positiveInt(t.amount_iqd) !== null && positiveInt(t.exchange_rate_snapshot) !== null ? positiveInt(t.amount_iqd) : null,
    exchange_rate_snapshot:
      positiveInt(t.amount_iqd) !== null && positiveInt(t.exchange_rate_snapshot) !== null
        ? positiveInt(t.exchange_rate_snapshot)
        : null,
  };
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
