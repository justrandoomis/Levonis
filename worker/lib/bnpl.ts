/**
 * PRO Buy Now, Pay Later — server-side eligibility and ledger helpers.
 *
 * The browser can request `paymentMethodId: "bnpl"`; it cannot assert any of
 * the facts below. Membership, restrictions, approval, identity, address,
 * outstanding debt and the account limit are all loaded again by the Worker.
 * Migration 0066 repeats the critical checks in SQLite triggers so concurrent
 * checkouts cannot overdraw one credit line.
 */
import { benefits, defaultAddressOf, getTierStatus, isApprovedDefaultAddress } from './entitlements';
import { newId } from './crypto';
import { getSetting, type BnplPolicy } from './settings';
import { audit } from './audit';

export type BnplReason =
  | 'BNPL_DISABLED'
  | 'PRO_REQUIRED'
  | 'BNPL_RESTRICTED'
  | 'BNPL_NOT_APPROVED'
  | 'IDENTITY_VERIFICATION_REQUIRED'
  | 'APPROVED_ADDRESS_REQUIRED'
  | 'BNPL_AMOUNT_TOO_LOW'
  | 'BNPL_AMOUNT_TOO_HIGH'
  | 'BNPL_LIMIT_EXCEEDED';

export interface BnplEligibility {
  eligible: boolean;
  reason: BnplReason | null;
  account_state: string;
  credit_limit_iqd: number;
  outstanding_iqd: number;
  available_iqd: number;
  due_days: number;
  identity_verified: boolean;
  approved_address: boolean;
}

export interface BnplOverdueReport {
  scanned: number;
  overdue: number;
  suspended: number;
}

function policyOf(value: BnplPolicy): BnplPolicy {
  return {
    enabled: value.enabled === true,
    due_days: Number.isInteger(value.due_days) ? Math.min(365, Math.max(1, value.due_days)) : 30,
    min_order_iqd: Number.isInteger(value.min_order_iqd) ? Math.max(1, value.min_order_iqd) : 10000,
    max_order_iqd:
      value.max_order_iqd === null || value.max_order_iqd === undefined
        ? null
        : Math.max(1, Math.trunc(value.max_order_iqd)),
    require_verified_identity: value.require_verified_identity !== false,
    require_approved_address: value.require_approved_address !== false,
  };
}

export async function bnplOutstanding(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE
          WHEN kind = 'charge' THEN amount_iqd
          WHEN kind = 'repayment' THEN -amount_iqd
          ELSE amount_iqd END), 0) AS outstanding
         FROM bnpl_ledger WHERE user_id = ?`
    )
    .bind(userId)
    .first<{ outstanding: number }>();
  return Math.max(0, Number(row?.outstanding) || 0);
}

export async function bnplEligibility(
  db: D1Database,
  userId: string,
  address?: Record<string, unknown> | null,
  requestedIqd?: number
): Promise<BnplEligibility> {
  const [rawPolicy, status, account, identity, outstanding] = await Promise.all([
    getSetting(db, 'bnplPolicy'),
    getTierStatus(db, userId),
    db
      .prepare('SELECT state, credit_limit_iqd FROM bnpl_accounts WHERE user_id = ?')
      .bind(userId)
      .first<{ state: string; credit_limit_iqd: number }>(),
    db
      .prepare("SELECT id FROM kyc_cases WHERE user_id = ? AND state = 'verified' ORDER BY decided_at DESC LIMIT 1")
      .bind(userId)
      .first<{ id: string }>(),
    bnplOutstanding(db, userId),
  ]);
  const policy = policyOf(rawPolicy);
  const judgedAddress = address === undefined ? await defaultAddressOf(db, userId) : address;
  const approvedAddress = judgedAddress ? await isApprovedDefaultAddress(db, userId, judgedAddress) : false;
  const limit = Math.max(0, Number(account?.credit_limit_iqd) || 0);
  const available = Math.max(0, limit - outstanding);

  let reason: BnplReason | null = null;
  if (!policy.enabled) reason = 'BNPL_DISABLED';
  else if (!status.active || status.tier !== 'pro') reason = 'PRO_REQUIRED';
  else if (!benefits.bnpl(status)) reason = 'BNPL_RESTRICTED';
  else if (!account || account.state !== 'approved' || limit <= 0) reason = 'BNPL_NOT_APPROVED';
  else if (policy.require_verified_identity && !identity) reason = 'IDENTITY_VERIFICATION_REQUIRED';
  else if (policy.require_approved_address && !approvedAddress) reason = 'APPROVED_ADDRESS_REQUIRED';
  // Do not advertise BNPL at checkout when the whole approved line is
  // already consumed. Amount-specific enforcement below and the database
  // trigger still repeat the limit check for every actual purchase.
  else if (available <= 0) reason = 'BNPL_LIMIT_EXCEEDED';
  else if (requestedIqd !== undefined && requestedIqd < policy.min_order_iqd) reason = 'BNPL_AMOUNT_TOO_LOW';
  else if (requestedIqd !== undefined && policy.max_order_iqd !== null && requestedIqd > policy.max_order_iqd)
    reason = 'BNPL_AMOUNT_TOO_HIGH';
  else if (requestedIqd !== undefined && requestedIqd > available) reason = 'BNPL_LIMIT_EXCEEDED';

  return {
    eligible: reason === null,
    reason,
    account_state: account?.state ?? 'none',
    credit_limit_iqd: limit,
    outstanding_iqd: outstanding,
    available_iqd: available,
    due_days: policy.due_days,
    identity_verified: !!identity,
    approved_address: approvedAddress,
  };
}

export function bnplDueAt(nowIso: string, dueDays: number): string {
  return new Date(Date.parse(nowIso) + Math.max(1, dueDays) * 86_400_000).toISOString();
}

export function bnplChargeStatement(
  db: D1Database,
  input: { userId: string; orderId: string; amountIqd: number; dueAt: string; createdAt: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO bnpl_ledger (id, user_id, order_id, kind, amount_iqd, due_at, note, idempotency_key, created_at)
       VALUES (?, ?, ?, 'charge', ?, ?, ?, ?, ?)`
    )
    .bind(
      newId('bnl'),
      input.userId,
      input.orderId,
      input.amountIqd,
      input.dueAt,
      `BNPL purchase ${input.orderId}`,
      `charge:${input.orderId}`,
      input.createdAt
    );
}

export function bnplRepaymentStatement(
  db: D1Database,
  input: { userId: string; amountIqd: number; idempotencyKey: string; createdAt: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO bnpl_ledger (id, user_id, order_id, kind, amount_iqd, due_at, note, idempotency_key, created_at)
       VALUES (?, ?, NULL, 'repayment', ?, NULL, 'Wallet BNPL repayment', ?, ?)`
    )
    .bind(newId('bnl'), input.userId, input.amountIqd, `repayment:${input.userId}:${input.idempotencyKey}`, input.createdAt);
}

/** Releases a cancelled order's financed amount exactly once. */
export function bnplCancellationStatement(db: D1Database, userId: string, orderId: string, createdAt: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO bnpl_ledger
         (id, user_id, order_id, kind, amount_iqd, due_at, note, idempotency_key, created_at)
       SELECT ?, ?, ?, 'adjustment', -amount_iqd, NULL, 'Cancelled BNPL order', ?, ?
         FROM bnpl_ledger
        WHERE user_id = ? AND order_id = ? AND kind = 'charge'
        LIMIT 1`
    )
    .bind(newId('bnl'), userId, orderId, `cancel:${orderId}`, createdAt, userId, orderId);
}

/**
 * Suspends approved credit lines with an unpaid charge past its due date.
 *
 * Repayments are allocated oldest-charge-first. Cancelled orders are removed
 * from the financed principal before that allocation, so a cancellation can
 * neither create an overdue balance nor manufacture reusable credit. The
 * conditional account update makes overlapping/retried cron runs single
 * winner; only that winner writes the audit event. Reactivation is always an
 * explicit admin credit decision.
 */
export async function sweepBnplOverdue(
  db: D1Database,
  nowIso = new Date().toISOString(),
  limit = 100
): Promise<BnplOverdueReport> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const { results } = await db
    .prepare(
      `WITH repayments AS (
         SELECT user_id, COALESCE(SUM(amount_iqd), 0) AS repaid_iqd
           FROM bnpl_ledger
          WHERE kind = 'repayment'
          GROUP BY user_id
       ), net_charges AS (
         SELECT c.id, c.user_id, c.due_at, c.created_at,
                MAX(0, c.amount_iqd + COALESCE(SUM(a.amount_iqd), 0)) AS amount_iqd
           FROM bnpl_ledger c
           LEFT JOIN bnpl_ledger a
             ON a.order_id = c.order_id AND a.user_id = c.user_id AND a.kind = 'adjustment'
          WHERE c.kind = 'charge' AND c.due_at IS NOT NULL
          GROUP BY c.id, c.user_id, c.due_at, c.created_at, c.amount_iqd
       ), allocated AS (
         SELECT id, user_id, due_at, created_at, amount_iqd,
                SUM(amount_iqd) OVER (
                  PARTITION BY user_id
                  ORDER BY due_at, created_at, id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS cumulative_iqd
           FROM net_charges
          WHERE amount_iqd > 0
       )
       SELECT a.user_id, MIN(a.due_at) AS oldest_due_at
         FROM allocated a
         LEFT JOIN repayments r ON r.user_id = a.user_id
        WHERE a.due_at < ? AND a.cumulative_iqd > COALESCE(r.repaid_iqd, 0)
        GROUP BY a.user_id
        ORDER BY oldest_due_at, a.user_id
        LIMIT ?`
    )
    .bind(nowIso, boundedLimit)
    .all<{ user_id: string; oldest_due_at: string }>();

  let suspended = 0;
  for (const row of results) {
    const updated = await db
      .prepare("UPDATE bnpl_accounts SET state = 'suspended' WHERE user_id = ? AND state = 'approved'")
      .bind(row.user_id)
      .run();
    if ((updated.meta.changes ?? 0) < 1) continue;
    suspended += 1;
    await audit(db, null, 'bnpl.overdue_suspend', row.user_id, {
      oldest_due_at: row.oldest_due_at,
      checked_at: nowIso,
    });
  }

  return { scanned: results.length, overdue: results.length, suspended };
}
