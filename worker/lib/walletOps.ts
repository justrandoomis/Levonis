import type { Env } from './types';
import { newId } from './crypto';
import { audit } from './audit';

/**
 * Wallet engine — holds, withdrawal state machine and reconciliation
 * (integrated mandate §11.1–§11.4).
 *
 * SOURCE OF TRUTH
 * ---------------
 * `wallet_transactions` stays the LEDGER: an approved row is money that has
 * moved (deposit = credit, withdrawal = debit). `wallet_holds` (migration
 * 0015) is the RESERVATION book: an active hold is money still sitting in
 * the settled balance that is no longer spendable.
 *
 *   settled   = SUM(approved deposits) − SUM(approved withdrawals)
 *   held      = SUM(active holds whose own ledger debit has NOT posted yet)
 *   available = settled − held
 *
 * The "whose own ledger debit has not posted yet" clause is the whole trick
 * behind the mandated example: when a payout completes, the SAME D1
 * transaction commits the hold and approves the ledger row, so the balance
 * moves 100,000 → 70,000 exactly once. It never dips to 40,000, and a
 * withdrawal approved through the legacy admin path (ledger row flipped
 * without touching the hold) cannot double-subtract either — it shows up in
 * `walletReconciliationReport` as an anomaly instead.
 *
 * ATOMICITY RULES FOLLOWED HERE (§11.4)
 * -------------------------------------
 *  - Every guard lives inside the WHERE of the writing statement — there is
 *    no read-then-write anywhere in this file.
 *  - Multi-row effects run in ONE `db.batch` (a single D1 transaction), and
 *    every dependent statement repeats the winner's predicate, so an UPDATE
 *    that touches 0 rows leaves its dependents at 0 rows too. Losing a state
 *    race can therefore never post a ledger row or release a hold.
 *  - Business-event identity is enforced by UNIQUE constraints, so rotating
 *    an idempotency key cannot buy a second hold, payout or credit.
 *  - Nothing here calls an external system; payouts are recorded by a human
 *    with a reference, never executed.
 */

// ---------------------------------------------------------------- SQL pieces

/** Settled USD ledger balance for the user bound at `u` (a placeholder). */
const settledUsdSql = (u: string) => `(SELECT COALESCE(SUM(CASE WHEN t.type='deposit' THEN t.amount ELSE -t.amount END),0)
       FROM wallet_transactions t
      WHERE t.user_id = ${u} AND t.currency = 'USD' AND t.status = 'approved')`;

/**
 * Active holds that still reserve money. A hold whose ledger row is already
 * approved has been paid out of `settled` — counting it again would subtract
 * the same money twice.
 */
export const effectiveHoldsUsdSql = (u: string) => `(SELECT COALESCE(SUM(h.amount_cents),0)
       FROM wallet_holds h
       LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
      WHERE h.user_id = ${u} AND h.state = 'active'
        AND (h.tx_id IS NULL OR ht.status <> 'approved'))`;

/** Spendable USD cents = settled − effective active holds. */
export const availableUsdSql = (u: string) => `(${settledUsdSql(u)} - ${effectiveHoldsUsdSql(u)})`;

const settledPointsSql = (u: string) => `(SELECT COALESCE(SUM(CASE WHEN t.type='deposit' THEN t.amount ELSE -t.amount END),0)
       FROM wallet_transactions t
      WHERE t.user_id = ${u} AND t.currency = 'POINT' AND t.status = 'approved')`;

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Largest amount any single wallet operation may carry (integer cents). */
export const MAX_AMOUNT_CENTS = 100_000_000;

/** Integer-cents money guard: no floats, no NaN, no negatives, no overflow. */
export function isValidAmountCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT_CENTS;
}

/**
 * THE ONE CONDITIONAL SPEND. Debits `amountCents` from a user's USD wallet as
 * an approved ledger row — but only if the SPENDABLE balance covers it, where
 * spendable is settled MINUS active holds, exactly what getAvailableBalances
 * reports and exactly what a hold's own INSERT checks.
 *
 * WHY THIS EXISTS. Checkout and the membership purchase each carried their own
 * copy of this statement, and both guarded on the SETTLED sum alone. The read
 * side subtracted holds; the write side did not. So a customer with 100,000
 * settled could file a withdrawal for all of it (hold created, available 0)
 * and, in the same instant, pay for an order with the same 100,000: the
 * checkout's guard saw settled ≥ amount and posted the debit. When the
 * withdrawal was later paid out, the ledger went negative — the same money
 * spent twice. Two concurrent requests from one browser were enough.
 *
 * The guard follows the file's atomicity rule: it lives inside the writing
 * statement. When the balance does not cover the amount, the row's amount
 * becomes -1, which violates CHECK (amount > 0) and aborts the whole batch,
 * so nothing dependent on the payment can persist either.
 */
export function usdSpendStatement(
  db: D1Database,
  p: { txId: string; userId: string; amountCents: number; note: string; ref: string; nowIso: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
       SELECT ?1, ?2, 'withdrawal', 'USD',
         CASE WHEN ${availableUsdSql('?2')} >= ?3 THEN ?3 ELSE -1 END,
         'approved', ?4, ?5, 'system', ?6`
    )
    .bind(p.txId, p.userId, p.amountCents, p.note, p.ref, p.nowIso);
}

/**
 * The overdraft predicate for approving a PENDING withdrawal row `txId` by the
 * legacy admin decision: spendable balance, but with this withdrawal's OWN hold
 * added back — that hold is the reservation for this very payout, so counting
 * it against itself would refuse every hold-backed withdrawal. Other users'
 * holds are irrelevant (per-user sums); this user's OTHER holds still count.
 *
 * `u` and `tx` are placeholders for the user id and the transaction id.
 */
export const approvableWithdrawalSql = (u: string, tx: string) =>
  `(${availableUsdSql(u)} + COALESCE((SELECT h.amount_cents FROM wallet_holds h
        WHERE h.state = 'active'
          AND h.id = (SELECT w.hold_id FROM wallet_withdrawals w WHERE w.tx_id = ${tx})), 0))`;

// ---------------------------------------------------------------- balances

export interface AvailableBalances {
  /** Spendable wallet money (settled minus active holds), USD cents. */
  usd_cents_available: number;
  /** Redeemable points (released accruals minus active reservations). */
  points_available: number;
}

/**
 * FROZEN SIGNATURE — checkout and the points engine consult this before
 * spending. Now returns settled MINUS active holds, so a withdrawal that is
 * waiting for payout can no longer be spent in the shop (§11.1).
 *
 * Points are deliberately NOT reduced by wallet holds: cash and points are
 * separate balances and points never convert to a cash payout (§11.1).
 */
export async function getAvailableBalances(env: Env, userId: string): Promise<AvailableBalances> {
  const row = await env.DB.prepare(
    `SELECT ${availableUsdSql('?1')} AS usd_cents_available, ${settledPointsSql('?1')} AS points_available`
  )
    .bind(userId)
    .first<{ usd_cents_available: number; points_available: number }>();
  return {
    usd_cents_available: row?.usd_cents_available ?? 0,
    points_available: row?.points_available ?? 0,
  };
}

export interface WalletBreakdown {
  usd_cents_settled: number;
  usd_cents_held: number;
  usd_cents_available: number;
  /** Deposits awaiting review — never spendable, shown separately (§11.1). */
  usd_cents_pending_deposits: number;
  /** Withdrawal requests that are still open (requested/approved/processing). */
  usd_cents_pending_withdrawals: number;
  points_settled: number;
  points_pending: number;
}

/** The three numbers the wallet page must show separately, plus points. */
export async function getWalletBreakdown(db: D1Database, userId: string): Promise<WalletBreakdown> {
  const row = await db
    .prepare(
      `SELECT
         ${settledUsdSql('?1')} AS usd_cents_settled,
         ${effectiveHoldsUsdSql('?1')} AS usd_cents_held,
         ${availableUsdSql('?1')} AS usd_cents_available,
         (SELECT COALESCE(SUM(t.amount),0) FROM wallet_transactions t
           WHERE t.user_id = ?1 AND t.currency='USD' AND t.type='deposit' AND t.status='pending')
           AS usd_cents_pending_deposits,
         (SELECT COALESCE(SUM(w.amount_cents),0) FROM wallet_withdrawals w
           WHERE w.user_id = ?1 AND w.state IN ('requested','approved','processing'))
           AS usd_cents_pending_withdrawals,
         ${settledPointsSql('?1')} AS points_settled,
         (SELECT COALESCE(SUM(t.amount),0) FROM wallet_transactions t
           WHERE t.user_id = ?1 AND t.currency='POINT' AND t.type='deposit' AND t.status='pending')
           AS points_pending`
    )
    .bind(userId)
    .first<WalletBreakdown>();
  return {
    usd_cents_settled: row?.usd_cents_settled ?? 0,
    usd_cents_held: row?.usd_cents_held ?? 0,
    usd_cents_available: row?.usd_cents_available ?? 0,
    usd_cents_pending_deposits: row?.usd_cents_pending_deposits ?? 0,
    usd_cents_pending_withdrawals: row?.usd_cents_pending_withdrawals ?? 0,
    points_settled: row?.points_settled ?? 0,
    points_pending: row?.points_pending ?? 0,
  };
}

// ---------------------------------------------------------------- holds

export type HoldKind = 'purchase' | 'withdrawal';
export type HoldState = 'active' | 'committed' | 'released';

export type HoldFailure =
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_AVAILABLE'
  /** Same business event, same inputs — the first hold still stands. */
  | 'DUPLICATE_EVENT'
  /** Same key, different amount: refused, never silently reused (§11.4). */
  | 'EVENT_KEY_REUSED'
  | 'MISSING_EVENT_KEY'
  | 'STATE_CONFLICT'
  | 'NOT_FOUND';

export type HoldResult =
  | { ok: true; holdId: string; replayed: boolean }
  | { ok: false; reason: HoldFailure; holdId?: string };

export interface CreateHoldInput {
  userId: string;
  amountCents: number;
  /** Business-event key: unique per (user, kind). */
  eventKey: string;
  refType?: string;
  refId?: string;
  note?: string;
}

function holdInsertStatement(
  db: D1Database,
  holdId: string,
  kind: HoldKind,
  p: CreateHoldInput
): D1PreparedStatement {
  // The availability guard and the uniqueness guard both live inside this
  // INSERT: it either reserves money that exists or writes nothing at all.
  return db
    .prepare(
      `INSERT INTO wallet_holds (id, user_id, kind, amount_cents, state, event_key, ref_type, ref_id, note, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'active', ?5, ?6, ?7, ?8, ${NOW_SQL}, ${NOW_SQL}
        WHERE ${availableUsdSql('?2')} >= ?4
          AND NOT EXISTS (SELECT 1 FROM wallet_holds x WHERE x.user_id = ?2 AND x.kind = ?3 AND x.event_key = ?5)`
    )
    .bind(
      holdId,
      p.userId,
      kind,
      p.amountCents,
      p.eventKey,
      p.refType ?? '',
      p.refId ?? '',
      (p.note ?? '').slice(0, 300)
    );
}

/** Why did a conditional hold insert write nothing? Read-only classification. */
async function classifyHoldFailure(
  db: D1Database,
  kind: HoldKind,
  p: CreateHoldInput
): Promise<HoldResult> {
  const existing = await db
    .prepare('SELECT id, amount_cents, state FROM wallet_holds WHERE user_id = ? AND kind = ? AND event_key = ?')
    .bind(p.userId, kind, p.eventKey)
    .first<{ id: string; amount_cents: number; state: HoldState }>();
  if (existing) {
    if (existing.amount_cents !== p.amountCents) {
      return { ok: false, reason: 'EVENT_KEY_REUSED', holdId: existing.id };
    }
    return existing.state === 'active'
      ? { ok: true, holdId: existing.id, replayed: true }
      : { ok: false, reason: 'DUPLICATE_EVENT', holdId: existing.id };
  }
  return { ok: false, reason: 'INSUFFICIENT_AVAILABLE' };
}

async function createHold(db: D1Database, kind: HoldKind, p: CreateHoldInput): Promise<HoldResult> {
  if (!isValidAmountCents(p.amountCents)) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (!p.eventKey) return { ok: false, reason: 'MISSING_EVENT_KEY' };
  const holdId = newId('whold');
  try {
    const res = await db.batch([holdInsertStatement(db, holdId, kind, p)]);
    if ((res[0]?.meta.changes ?? 0) > 0) return { ok: true, holdId, replayed: false };
  } catch {
    // A concurrent insert won the UNIQUE(user_id, kind, event_key) race; the
    // batch rolled back, so nothing partial was written.
  }
  return classifyHoldFailure(db, kind, p);
}

/**
 * Reserve money for a withdrawal request. Atomic against concurrent
 * purchases and concurrent withdrawal requests: the availability check is
 * part of the INSERT, so two racing requests on a 100,000 balance can never
 * both reserve 70,000.
 */
export function createWithdrawalHold(db: D1Database, p: CreateHoldInput): Promise<HoldResult> {
  return createHold(db, 'withdrawal', p);
}

/** Same guarantees for checkout reservations (kind='purchase'). */
export function createPurchaseHold(db: D1Database, p: CreateHoldInput): Promise<HoldResult> {
  return createHold(db, 'purchase', p);
}

/**
 * Settle a hold against a ledger debit: the reserved money leaves the
 * balance exactly once. `txId` links the approved ledger row that carries
 * the debit; the caller must post that row in the SAME batch (see
 * `markWithdrawalPaid`) or beforehand.
 */
export async function commitHold(
  db: D1Database,
  p: { holdId: string; txId?: string; note?: string }
): Promise<HoldResult> {
  const stmt = p.txId
    ? db
        .prepare(
          `UPDATE wallet_holds
              SET state='committed', committed_at=${NOW_SQL}, updated_at=${NOW_SQL}, tx_id=?2
            WHERE id = ?1 AND state = 'active' AND (tx_id IS NULL OR tx_id = ?2)`
        )
        .bind(p.holdId, p.txId)
    : db
        .prepare(
          `UPDATE wallet_holds
              SET state='committed', committed_at=${NOW_SQL}, updated_at=${NOW_SQL}
            WHERE id = ?1 AND state = 'active'`
        )
        .bind(p.holdId);
  const res = await stmt.run();
  if ((res.meta.changes ?? 0) > 0) return { ok: true, holdId: p.holdId, replayed: false };
  const row = await db
    .prepare('SELECT state FROM wallet_holds WHERE id = ?')
    .bind(p.holdId)
    .first<{ state: HoldState }>();
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.state === 'committed') return { ok: true, holdId: p.holdId, replayed: true };
  return { ok: false, reason: 'STATE_CONFLICT', holdId: p.holdId };
}

/**
 * Return reserved money to the available balance — EXACTLY once. The
 * `state='active'` guard is the only thing that decides; a second call (or a
 * second admin clicking at the same moment) updates 0 rows and reports a
 * replay instead of crediting anything.
 */
export async function releaseHold(
  db: D1Database,
  p: { holdId: string; reason: string }
): Promise<HoldResult> {
  const res = await db
    .prepare(
      `UPDATE wallet_holds
          SET state='released', released_at=${NOW_SQL}, updated_at=${NOW_SQL}, release_reason=?2
        WHERE id = ?1 AND state = 'active'`
    )
    .bind(p.holdId, p.reason.slice(0, 300))
    .run();
  if ((res.meta.changes ?? 0) > 0) return { ok: true, holdId: p.holdId, replayed: false };
  const row = await db
    .prepare('SELECT state FROM wallet_holds WHERE id = ?')
    .bind(p.holdId)
    .first<{ state: HoldState }>();
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.state === 'released') return { ok: true, holdId: p.holdId, replayed: true };
  return { ok: false, reason: 'STATE_CONFLICT', holdId: p.holdId };
}

// ------------------------------------------------------ withdrawal lifecycle

export const WITHDRAWAL_STATES = [
  'requested',
  'approved',
  'processing',
  'paid',
  'rejected',
  'cancelled',
  'failed',
] as const;
export type WithdrawalState = (typeof WITHDRAWAL_STATES)[number];

/**
 * The only legal moves (§11.3). Terminal states have no exits: a paid
 * withdrawal is never "re-approved", and a rejected one is never quietly
 * reopened — a new request is filed instead.
 *
 * `approved` means "approved FOR PROCESSING", not "money sent". Only
 * `markWithdrawalPaid` (which demands a payout reference) leaves the
 * balance.
 */
export const WITHDRAWAL_TRANSITIONS: Record<WithdrawalState, readonly WithdrawalState[]> = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved: ['processing', 'rejected', 'cancelled'],
  processing: ['paid', 'failed'],
  paid: [],
  rejected: [],
  cancelled: [],
  failed: [],
};

export function canTransition(from: WithdrawalState, to: WithdrawalState): boolean {
  return WITHDRAWAL_TRANSITIONS[from]?.includes(to) ?? false;
}

/** States in which the money is still reserved (hold active, no debit yet). */
export function isOpenWithdrawalState(s: WithdrawalState): boolean {
  return s === 'requested' || s === 'approved' || s === 'processing';
}

/** Terminal states that must have released the hold exactly once. */
export function isReleasingWithdrawalState(s: WithdrawalState): boolean {
  return s === 'rejected' || s === 'cancelled' || s === 'failed';
}

/**
 * Withdrawal fees and limits are an OWNER DECISION that has not been made
 * (mandate §11.3 + §13.1; the decision register has no wallet-payout row
 * yet). We refuse to invent a percentage or a cap: the quote is honest about
 * being unconfigured, the net equals the requested amount, and the whole
 * requested amount is what gets reserved.
 */
export const WITHDRAWAL_FEE_POLICY = {
  configured: false,
  policy: 'not_configured' as const,
  /** No live payout channel is wired; paid is recorded by a human. */
  live_payout: false,
};

export interface FeeQuote {
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  fee_policy: 'not_configured';
  fee_configured: false;
}

export function withdrawalFeeQuote(amountCents: number): FeeQuote {
  return {
    amount_cents: amountCents,
    fee_cents: 0,
    net_cents: amountCents,
    fee_policy: 'not_configured',
    fee_configured: false,
  };
}

export type WithdrawalFailure =
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_AVAILABLE'
  | 'DUPLICATE_EVENT'
  | 'EVENT_KEY_REUSED'
  | 'MISSING_EVENT_KEY'
  | 'ILLEGAL_TRANSITION'
  | 'STATE_CONFLICT'
  | 'NOT_FOUND'
  | 'MISSING_PAYOUT_REFERENCE'
  | 'NEEDS_RECONCILIATION';

export interface WithdrawalDestination {
  kind: string;
  account: string;
  holder?: string;
  note?: string;
}

export interface RequestWithdrawalInput {
  userId: string;
  amountCents: number;
  destination: WithdrawalDestination;
  /** Client idempotency key; the stored business key also pins the amount. */
  eventKey: string;
  note?: string;
}

export type WithdrawalOpResult =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; reason: WithdrawalFailure; id?: string };

/**
 * File a withdrawal request: reserve the money, open the pending ledger row
 * and freeze the destination — all in ONE D1 transaction. If the hold insert
 * writes nothing (insufficient available balance or a duplicate business
 * event) every dependent statement writes nothing either, so there is no
 * orphan ledger row and no request without a reservation.
 */
export async function requestWithdrawal(
  db: D1Database,
  p: RequestWithdrawalInput
): Promise<WithdrawalOpResult> {
  if (!isValidAmountCents(p.amountCents)) return { ok: false, reason: 'INVALID_AMOUNT' };
  const quote = withdrawalFeeQuote(p.amountCents);
  const holdId = newId('whold');
  const txId = newId('wtx');
  const wdId = newId('wd');
  const holdInput: CreateHoldInput = {
    userId: p.userId,
    amountCents: p.amountCents,
    eventKey: p.eventKey,
    refType: 'withdrawal',
    refId: wdId,
    note: (p.note ?? '').slice(0, 300),
  };

  const statements = [
    holdInsertStatement(db, holdId, 'withdrawal', holdInput),
    // Ledger row: pending until an actual payout is recorded. Dependent on
    // the hold having been created by the statement above.
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, account_number, ref, created_by)
         SELECT ?1, ?2, 'withdrawal', 'USD', ?3, 'pending', ?4, ?5, ?6, 'user'
          WHERE EXISTS (SELECT 1 FROM wallet_holds h WHERE h.id = ?7 AND h.state = 'active')`
      )
      .bind(
        txId,
        p.userId,
        p.amountCents,
        (p.note ?? '').slice(0, 500),
        p.destination.account.slice(0, 100),
        wdId,
        holdId
      ),
    // Request row with the destination frozen at confirmation.
    db
      .prepare(
        `INSERT INTO wallet_withdrawals
           (id, user_id, tx_id, hold_id, amount_cents, fee_cents, net_cents, fee_policy,
            destination_kind, destination_account, destination_holder, destination_note,
            destination_frozen_at, state, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ${NOW_SQL}, 'requested', ${NOW_SQL}, ${NOW_SQL}
          WHERE EXISTS (SELECT 1 FROM wallet_holds h WHERE h.id = ?4 AND h.state = 'active')
            AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?3)`
      )
      .bind(
        wdId,
        p.userId,
        txId,
        holdId,
        p.amountCents,
        quote.fee_cents,
        quote.net_cents,
        quote.fee_policy,
        p.destination.kind.slice(0, 40),
        p.destination.account.slice(0, 120),
        (p.destination.holder ?? '').slice(0, 120),
        (p.destination.note ?? '').slice(0, 300)
      ),
    // Link the hold to its ledger row, so committing the payout and posting
    // the debit can never be attributed to a different transaction.
    db
      .prepare(
        `UPDATE wallet_holds SET tx_id = ?2, updated_at = ${NOW_SQL}
          WHERE id = ?1 AND state = 'active' AND tx_id IS NULL
            AND EXISTS (SELECT 1 FROM wallet_withdrawals w WHERE w.id = ?3 AND w.hold_id = ?1)`
      )
      .bind(holdId, txId, wdId),
  ];

  try {
    const res = await db.batch(statements);
    if ((res[0]?.meta.changes ?? 0) > 0) return { ok: true, id: wdId, replayed: false };
  } catch {
    // UNIQUE race → whole batch rolled back; classify below.
  }
  const cls = await classifyHoldFailure(db, 'withdrawal', holdInput);
  if (cls.ok) {
    // The event already holds money: return the existing request rather than
    // filing a second one for the same business event.
    const existing = await db
      .prepare('SELECT id FROM wallet_withdrawals WHERE hold_id = ?')
      .bind(cls.holdId)
      .first<{ id: string }>();
    return existing
      ? { ok: true, id: existing.id, replayed: true }
      : { ok: false, reason: 'DUPLICATE_EVENT' };
  }
  return { ok: false, reason: cls.reason as WithdrawalFailure };
}

export interface WithdrawalRow {
  id: string;
  user_id: string;
  tx_id: string;
  hold_id: string;
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  fee_policy: string;
  destination_kind: string;
  destination_account: string;
  destination_holder: string;
  destination_note: string;
  destination_frozen_at: string;
  state: WithdrawalState;
  needs_reconciliation: number;
  reconciliation_note: string;
  payout_reference: string;
  payout_actor: string;
  payout_at: string | null;
  outcome_reason: string;
  decided_by: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export function getWithdrawal(db: D1Database, id: string): Promise<WithdrawalRow | null> {
  return db.prepare('SELECT * FROM wallet_withdrawals WHERE id = ?').bind(id).first<WithdrawalRow>();
}

/**
 * requested → approved and approved → processing. Neither moves money:
 * "approve" authorises PROCESSING, and the mandate is explicit that it must
 * not read as "transferred" anywhere in the UI.
 */
export async function advanceWithdrawal(
  db: D1Database,
  p: { id: string; to: 'approved' | 'processing'; actorId: string; note?: string }
): Promise<WithdrawalOpResult> {
  const from: WithdrawalState = p.to === 'approved' ? 'requested' : 'approved';
  const res = await db
    .prepare(
      `UPDATE wallet_withdrawals
          SET state = ?2, decided_by = ?3, decided_at = ${NOW_SQL}, updated_at = ${NOW_SQL}
        WHERE id = ?1 AND state = ?4 AND needs_reconciliation = 0`
    )
    .bind(p.id, p.to, p.actorId, from)
    .run();
  if ((res.meta.changes ?? 0) > 0) return { ok: true, id: p.id, replayed: false };
  const row = await getWithdrawal(db, p.id);
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.state === p.to) return { ok: true, id: p.id, replayed: true };
  if (row.needs_reconciliation === 1) return { ok: false, reason: 'NEEDS_RECONCILIATION', id: p.id };
  return { ok: false, reason: canTransition(row.state, p.to) ? 'STATE_CONFLICT' : 'ILLEGAL_TRANSITION', id: p.id };
}

/**
 * Record an ACTUAL payout: the hold is committed and the ledger debit posts
 * in the same transaction, so the money leaves once and the available
 * balance does not move a second time (100,000 → 70,000, never 40,000).
 *
 * `payoutReference` is mandatory — there is no live payout channel and
 * nothing here contacts one. This is a human recording a transfer that
 * already happened, with the reference, the actor and the time.
 */
export async function markWithdrawalPaid(
  db: D1Database,
  p: { id: string; payoutReference: string; actorId: string; note?: string }
): Promise<WithdrawalOpResult> {
  const reference = p.payoutReference.trim().slice(0, 120);
  if (!reference) return { ok: false, reason: 'MISSING_PAYOUT_REFERENCE' };

  const statements = [
    db
      .prepare(
        `UPDATE wallet_withdrawals
            SET state='paid', payout_reference=?2, payout_actor=?3, payout_at=${NOW_SQL},
                decided_by=?3, decided_at=${NOW_SQL}, updated_at=${NOW_SQL},
                reconciliation_note = CASE WHEN needs_reconciliation = 1
                  THEN substr(reconciliation_note || ' | resolved as paid', 1, 500) ELSE reconciliation_note END,
                needs_reconciliation = 0
          WHERE id = ?1 AND state = 'processing' AND payout_reference = ''`
      )
      .bind(p.id, reference, p.actorId),
    // Dependents repeat the winner's predicate (this id, paid, THIS payout
    // reference): a losing racer cannot commit the hold or post the debit.
    db
      .prepare(
        `UPDATE wallet_holds
            SET state='committed', committed_at=${NOW_SQL}, updated_at=${NOW_SQL}
          WHERE id = (SELECT hold_id FROM wallet_withdrawals WHERE id = ?1)
            AND state = 'active'
            AND EXISTS (SELECT 1 FROM wallet_withdrawals w
                         WHERE w.id = ?1 AND w.state = 'paid' AND w.payout_reference = ?2)`
      )
      .bind(p.id, reference),
    db
      .prepare(
        `UPDATE wallet_transactions
            SET status='approved', decided_at=${NOW_SQL}, decided_by=?3,
                admin_note = substr(?4, 1, 500)
          WHERE id = (SELECT tx_id FROM wallet_withdrawals WHERE id = ?1)
            AND status = 'pending'
            AND EXISTS (SELECT 1 FROM wallet_withdrawals w
                         WHERE w.id = ?1 AND w.state = 'paid' AND w.payout_reference = ?2)`
      )
      .bind(p.id, reference, p.actorId, `payout ref ${reference}${p.note ? ` — ${p.note}` : ''}`),
  ];

  const res = await db.batch(statements);
  if ((res[0]?.meta.changes ?? 0) > 0) return { ok: true, id: p.id, replayed: false };

  const row = await getWithdrawal(db, p.id);
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.state === 'paid') {
    // Same reference twice = a retry of one payout record, not a second one.
    return row.payout_reference === reference
      ? { ok: true, id: p.id, replayed: true }
      : { ok: false, reason: 'STATE_CONFLICT', id: p.id };
  }
  return { ok: false, reason: canTransition(row.state, 'paid') ? 'STATE_CONFLICT' : 'ILLEGAL_TRANSITION', id: p.id };
}

/**
 * Reject / cancel / final failure: the hold is released EXACTLY once and the
 * pending ledger row is closed as rejected (no debit ever posts). A request
 * flagged for reconciliation is refused here — an unknown payout outcome may
 * not be turned into an instant release (§11.3).
 */
export async function closeWithdrawal(
  db: D1Database,
  p: {
    id: string;
    to: 'rejected' | 'cancelled' | 'failed';
    actorId: string;
    reason: string;
    /** Restrict which states may close (user cancel cannot touch processing). */
    allowedFrom?: readonly WithdrawalState[];
  }
): Promise<WithdrawalOpResult> {
  const reason = p.reason.trim().slice(0, 300);
  if (!reason) return { ok: false, reason: 'STATE_CONFLICT' };
  const froms = (p.allowedFrom ?? WITHDRAWAL_STATES.filter((s) => canTransition(s, p.to))) as readonly WithdrawalState[];
  const legalFroms = froms.filter((s) => canTransition(s, p.to));
  if (legalFroms.length === 0) return { ok: false, reason: 'ILLEGAL_TRANSITION' };
  const inList = legalFroms.map((_, i) => `?${i + 5}`).join(',');

  const statements = [
    db
      .prepare(
        `UPDATE wallet_withdrawals
            SET state = ?2, outcome_reason = ?3, decided_by = ?4, decided_at = ${NOW_SQL}, updated_at = ${NOW_SQL}
          WHERE id = ?1 AND state IN (${inList}) AND needs_reconciliation = 0`
      )
      .bind(p.id, p.to, reason, p.actorId, ...legalFroms),
    db
      .prepare(
        `UPDATE wallet_holds
            SET state='released', released_at=${NOW_SQL}, updated_at=${NOW_SQL},
                release_reason = substr(?3, 1, 300)
          WHERE id = (SELECT hold_id FROM wallet_withdrawals WHERE id = ?1)
            AND state = 'active'
            AND EXISTS (SELECT 1 FROM wallet_withdrawals w WHERE w.id = ?1 AND w.state = ?2)`
      )
      .bind(p.id, p.to, `${p.to}: ${reason}`),
    db
      .prepare(
        `UPDATE wallet_transactions
            SET status='rejected', decided_at=${NOW_SQL}, decided_by=?3, admin_note=substr(?4, 1, 500)
          WHERE id = (SELECT tx_id FROM wallet_withdrawals WHERE id = ?1)
            AND status = 'pending'
            AND EXISTS (SELECT 1 FROM wallet_withdrawals w WHERE w.id = ?1 AND w.state = ?2)`
      )
      .bind(p.id, p.to, p.actorId, `${p.to}: ${reason}`),
  ];

  const res = await db.batch(statements);
  if ((res[0]?.meta.changes ?? 0) > 0) return { ok: true, id: p.id, replayed: false };

  const row = await getWithdrawal(db, p.id);
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.state === p.to) return { ok: true, id: p.id, replayed: true };
  if (row.needs_reconciliation === 1) return { ok: false, reason: 'NEEDS_RECONCILIATION', id: p.id };
  return {
    ok: false,
    reason: legalFroms.includes(row.state) ? 'STATE_CONFLICT' : 'ILLEGAL_TRANSITION',
    id: p.id,
  };
}

/**
 * A payout attempt whose outcome is unknown (network failure at the transfer
 * channel). The request STAYS in processing with the hold intact: no second
 * transfer, no instant release, no "paid" claim. A human resolves it later
 * with `markWithdrawalPaid` (real reference) or `closeWithdrawal` after
 * clearing the flag with `clearWithdrawalReconciliation`.
 */
export async function flagWithdrawalForReconciliation(
  db: D1Database,
  p: { id: string; actorId: string; note: string }
): Promise<WithdrawalOpResult> {
  const note = p.note.trim().slice(0, 500);
  if (!note) return { ok: false, reason: 'STATE_CONFLICT' };
  const res = await db
    .prepare(
      `UPDATE wallet_withdrawals
          SET needs_reconciliation = 1,
              reconciliation_note = substr(?2, 1, 500),
              decided_by = ?3, updated_at = ${NOW_SQL}
        WHERE id = ?1 AND state = 'processing'`
    )
    .bind(p.id, note, p.actorId)
    .run();
  if ((res.meta.changes ?? 0) > 0) return { ok: true, id: p.id, replayed: false };
  const row = await getWithdrawal(db, p.id);
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.needs_reconciliation === 1) return { ok: true, id: p.id, replayed: true };
  return { ok: false, reason: 'STATE_CONFLICT', id: p.id };
}

/**
 * Clear the reconciliation flag after a human has established what actually
 * happened at the payout channel. Clearing does NOT decide the outcome and
 * does not touch money; it only re-opens the legal transitions.
 */
export async function clearWithdrawalReconciliation(
  db: D1Database,
  p: { id: string; actorId: string; finding: string }
): Promise<WithdrawalOpResult> {
  const finding = p.finding.trim().slice(0, 500);
  if (!finding) return { ok: false, reason: 'STATE_CONFLICT' };
  const res = await db
    .prepare(
      `UPDATE wallet_withdrawals
          SET needs_reconciliation = 0,
              reconciliation_note = substr(reconciliation_note || ' | finding: ' || ?2, 1, 500),
              decided_by = ?3, updated_at = ${NOW_SQL}
        WHERE id = ?1 AND needs_reconciliation = 1`
    )
    .bind(p.id, finding, p.actorId)
    .run();
  if ((res.meta.changes ?? 0) > 0) return { ok: true, id: p.id, replayed: false };
  const row = await getWithdrawal(db, p.id);
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  return { ok: true, id: p.id, replayed: true };
}

// ---------------------------------------------------------------- deposits

/**
 * Reference identity for dedup: casefolded, with separators and spaces
 * removed, so "TRX 12-34" and "trx1234" are recognised as one transfer. The
 * PROVIDER/CHANNEL context is part of the key (see migration 0015) — the
 * same digits at two different providers are two different transfers.
 */
export function normalizeDepositReference(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.,/\\#*()]+/g, '')
    .slice(0, 120);
}

export type DepositReviewState =
  | 'awaiting_review'
  | 'amount_mismatch'
  | 'duplicate_reference_signal'
  | 'fingerprint_reuse_signal'
  | 'cleared_for_decision';

/**
 * Decide the review state a NEW deposit should start in. A reused attachment
 * fingerprint is a SIGNAL for the reviewer (§11.2) — never an auto-reject
 * and never proof, because a fingerprint says nothing about whether money
 * arrived.
 */
export function initialDepositReviewState(signals: { fingerprintSeenBefore: boolean }): DepositReviewState {
  return signals.fingerprintSeenBefore ? 'fingerprint_reuse_signal' : 'awaiting_review';
}

export type DepositFailure = 'INVALID_AMOUNT' | 'DUPLICATE_REFERENCE';

export type DepositResult =
  | { ok: true; txId: string; reviewState: DepositReviewState }
  | { ok: false; reason: DepositFailure };

export interface CreateDepositInput {
  userId: string;
  amountCents: number;
  receiptKey: string;
  note?: string;
  paymentMethod?: string;
  provider?: string;
  channel?: string;
  reference?: string;
  /** Weak attachment fingerprint (R2 md5/etag) — a review signal only. */
  fingerprint?: string;
  /** Test seam; production callers let this default. */
  txId?: string;
}

/**
 * File a deposit request. It is created PENDING — a receipt is not a payment
 * (§11.2) — and its transfer context is what gives one transfer one credit:
 *
 *  - the INSERT is conditional on no ACTIVE deposit already owning this
 *    (provider, channel, reference) slot, and the UNIQUE index behind it
 *    settles any race, so a rotated idempotency key or a renamed screenshot
 *    cannot buy a second credit;
 *  - a REJECTED deposit releases its slot in the same batch, so an honest
 *    correction can be filed, while an approved one holds it forever;
 *  - the attachment fingerprint only sets a review SIGNAL. It never blocks
 *    and never approves: an image proves nothing about money arriving.
 */
export async function createDepositRequest(db: D1Database, p: CreateDepositInput): Promise<DepositResult> {
  if (!isValidAmountCents(p.amountCents)) return { ok: false, reason: 'INVALID_AMOUNT' };
  const provider = (p.provider ?? '').slice(0, 60);
  const channel = (p.channel ?? '').slice(0, 60);
  const reference = (p.reference ?? '').slice(0, 120);
  const referenceNorm = normalizeDepositReference(reference);
  const fingerprint = (p.fingerprint ?? '').slice(0, 80);

  // Signal lookup only — it decides which flag the reviewer sees, never
  // whether the row may be written, so it is not a check-then-write guard.
  const seen = fingerprint
    ? await db
        .prepare('SELECT tx_id FROM wallet_deposit_meta WHERE attachment_fingerprint = ? LIMIT 1')
        .bind(fingerprint)
        .first<{ tx_id: string }>()
    : null;
  const reviewState = initialDepositReviewState({ fingerprintSeenBefore: !!seen });

  const txId = p.txId ?? newId('wtx');
  const statements = [
    db
      .prepare(
        `UPDATE wallet_deposit_meta
            SET dedup_active = 0, updated_at = ${NOW_SQL}
          WHERE provider = ?1 AND channel = ?2 AND reference_norm = ?3 AND reference_norm <> '' AND dedup_active = 1
            AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = wallet_deposit_meta.tx_id AND t.status = 'rejected')`
      )
      .bind(provider, channel, referenceNorm),
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, payment_method, receipt_key, ref, created_by)
         SELECT ?1, ?2, 'deposit', 'USD', ?3, 'pending', ?4, ?5, ?6, ?7, 'user'
          WHERE NOT EXISTS (
            SELECT 1 FROM wallet_deposit_meta m
             WHERE m.provider = ?8 AND m.channel = ?9 AND m.reference_norm = ?10
               AND m.reference_norm <> '' AND m.dedup_active = 1)`
      )
      .bind(
        txId,
        p.userId,
        p.amountCents,
        (p.note ?? '').slice(0, 500),
        (p.paymentMethod ?? '').slice(0, 60),
        p.receiptKey,
        reference,
        provider,
        channel,
        referenceNorm
      ),
    db
      .prepare(
        `INSERT INTO wallet_deposit_meta
           (tx_id, user_id, provider, channel, reference, reference_norm, attachment_fingerprint,
            declared_amount_cents, review_state, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ${NOW_SQL}, ${NOW_SQL}
          WHERE EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1)`
      )
      .bind(txId, p.userId, provider, channel, reference, referenceNorm, fingerprint, p.amountCents, reviewState),
  ];

  try {
    const res = await db.batch(statements);
    if ((res[1]?.meta.changes ?? 0) > 0) return { ok: true, txId, reviewState };
  } catch {
    // UNIQUE(provider, channel, reference_norm) race — batch rolled back.
  }
  return { ok: false, reason: 'DUPLICATE_REFERENCE' };
}

/**
 * Compare what the user declared with what finance actually observed. A
 * mismatch NEVER approves silently: it parks the request in a review state
 * that the admin path refuses to approve (§11.2).
 */
export function depositAmountReview(declaredCents: number, observedCents: number): DepositReviewState {
  return declaredCents === observedCents ? 'cleared_for_decision' : 'amount_mismatch';
}

/**
 * FROZEN CROSS-SLICE CONTRACT (see worker/lib/walletNotify.ts): the request
 * shape the Telegram approval buttons hand to this service.
 */
export interface DepositDecisionRequest {
  requestId: string;
  action: 'approve' | 'reject';
  actorUserId: string;
  /** Rejection reason / approval note. Required (>=3 chars) on a rejection. */
  reason: string;
  source: 'telegram' | 'site';
}

export type DepositDecisionFailure =
  | 'NOT_PENDING'
  | 'AMOUNT_MISMATCH'
  | 'REASON_REQUIRED';

export type DepositDecisionResult =
  | { ok: true; action: 'approve' | 'reject'; requestId: string }
  | { ok: false; reason: DepositDecisionFailure };

/**
 * THE deposit decision service (§12.2). The site admin route and the Telegram
 * inline buttons both call THIS function — the bot writes no SQL of its own,
 * so both channels carry identical guards and leave an identical record:
 *
 *  - the transition is one conditional UPDATE (`status = 'pending'` inside the
 *    WHERE), so of two concurrent decisions exactly ONE changes a row; the
 *    loser is told the request was already processed and credits nothing;
 *  - an amount whose observed value does not match what the user declared is
 *    refused, never approved silently — the caller is told to reject it and
 *    file a linked adjustment for the amount that actually arrived;
 *  - a rejection frees the (provider, channel, reference) dedup slot in the
 *    SAME batch, and only when the rejection itself won, so an honest
 *    resubmission is possible while an approved transfer holds its slot
 *    forever;
 *  - the audit row records WHO decided and from WHICH channel.
 *
 * The credit itself is the ledger row flipping to `approved` — this function
 * never writes a second money row.
 */
export async function decideDeposit(env: Env, p: DepositDecisionRequest): Promise<DepositDecisionResult> {
  const db = env.DB;
  const reason = (p.reason ?? '').trim().slice(0, 500);
  if (p.action === 'reject' && reason.length < 3) return { ok: false, reason: 'REASON_REQUIRED' };

  if (p.action === 'approve') {
    const res = await db
      .prepare(
        `UPDATE wallet_transactions
            SET status = 'approved', admin_note = ?2, decided_by = ?3, decided_at = ${NOW_SQL}
          WHERE id = ?1 AND status = 'pending' AND type = 'deposit' AND currency = 'USD'
            AND NOT EXISTS (SELECT 1 FROM wallet_deposit_meta m
                             WHERE m.tx_id = ?1 AND m.review_state = 'amount_mismatch')`
      )
      .bind(p.requestId, reason, p.actorUserId)
      .run();
    if ((res.meta.changes ?? 0) === 0) {
      const meta = await db
        .prepare('SELECT review_state FROM wallet_deposit_meta WHERE tx_id = ?')
        .bind(p.requestId)
        .first<{ review_state: string }>();
      const still = await db
        .prepare("SELECT status FROM wallet_transactions WHERE id = ? AND type = 'deposit'")
        .bind(p.requestId)
        .first<{ status: string }>();
      if (meta?.review_state === 'amount_mismatch' && still?.status === 'pending') {
        return { ok: false, reason: 'AMOUNT_MISMATCH' };
      }
      return { ok: false, reason: 'NOT_PENDING' };
    }
    await audit(db, p.actorUserId, 'wallet.deposit.approved', p.requestId, { note: reason, source: p.source });
    return { ok: true, action: 'approve', requestId: p.requestId };
  }

  const res = await db.batch([
    db
      .prepare(
        `UPDATE wallet_transactions
            SET status = 'rejected', admin_note = ?2, decided_by = ?3, decided_at = ${NOW_SQL}
          WHERE id = ?1 AND status = 'pending' AND type = 'deposit'`
      )
      .bind(p.requestId, reason, p.actorUserId),
    db
      .prepare(
        `UPDATE wallet_deposit_meta
            SET dedup_active = 0, review_note = substr(?2, 1, 300), reviewed_by = ?3,
                reviewed_at = ${NOW_SQL}, updated_at = ${NOW_SQL}
          WHERE tx_id = ?1
            AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1 AND t.status = 'rejected')`
      )
      .bind(p.requestId, reason, p.actorUserId),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 0) return { ok: false, reason: 'NOT_PENDING' };
  await audit(db, p.actorUserId, 'wallet.deposit.rejected', p.requestId, { reason, source: p.source });
  return { ok: true, action: 'reject', requestId: p.requestId };
}

// ------------------------------------------------------------ reconciliation

export type ReconciliationAnomalyKind =
  | 'negative_available'
  | 'holds_exceed_settled'
  | 'paid_without_committed_hold'
  | 'paid_without_ledger_debit'
  | 'paid_without_reference'
  | 'terminal_without_released_hold'
  | 'terminal_with_posted_debit'
  | 'open_without_active_hold'
  | 'open_with_posted_debit'
  | 'unknown_outcome_pending_reconciliation'
  | 'ledger_debit_without_paid_withdrawal';

export interface ReconciliationAnomaly {
  kind: ReconciliationAnomalyKind;
  user_id: string;
  ref: string;
  detail: string;
}

export interface ReconciliationReport {
  ran_at: string;
  checked_withdrawals: number;
  checked_users: number;
  totals: {
    settled_usd_cents: number;
    active_holds_usd_cents: number;
    withdrawal_holds_usd_cents: number;
    open_withdrawals_usd_cents: number;
    pending_deposits_usd_cents: number;
  };
  /** Reserved money must equal the open withdrawal requests it belongs to. */
  sums_match: boolean;
  anomalies: ReconciliationAnomaly[];
}

export interface WithdrawalReconRow {
  id: string;
  user_id: string;
  state: WithdrawalState;
  amount_cents: number;
  payout_reference: string;
  needs_reconciliation: number;
  hold_state: HoldState | null;
  hold_amount_cents: number | null;
  tx_status: 'pending' | 'approved' | 'rejected' | null;
}

/**
 * Pure classifier: given one withdrawal joined to its hold and ledger row,
 * which invariant (if any) is broken? Kept pure so the rules are unit-tested
 * without a database, and so reconciliation NEVER "repairs" anything — it
 * only reports (§11.4: alert an admin, never invent money).
 */
export function classifyWithdrawalRow(row: WithdrawalReconRow): ReconciliationAnomaly[] {
  const out: ReconciliationAnomaly[] = [];
  const add = (kind: ReconciliationAnomalyKind, detail: string) =>
    out.push({ kind, user_id: row.user_id, ref: row.id, detail });

  if (row.hold_state === null || row.tx_status === null) {
    add('open_without_active_hold', 'withdrawal is missing its hold or ledger row');
    return out;
  }
  if (row.hold_amount_cents !== null && row.hold_amount_cents !== row.amount_cents) {
    add('holds_exceed_settled', `hold ${row.hold_amount_cents} ≠ request ${row.amount_cents}`);
  }

  if (row.state === 'paid') {
    if (!row.payout_reference) add('paid_without_reference', 'paid state without a payout reference');
    if (row.hold_state !== 'committed') add('paid_without_committed_hold', `hold is ${row.hold_state}`);
    if (row.tx_status !== 'approved') add('paid_without_ledger_debit', `ledger row is ${row.tx_status}`);
    return out;
  }

  if (isReleasingWithdrawalState(row.state)) {
    if (row.hold_state !== 'released') add('terminal_without_released_hold', `hold is ${row.hold_state}`);
    if (row.tx_status === 'approved') add('terminal_with_posted_debit', `${row.state} but the ledger debit posted`);
    return out;
  }

  // Open states: money must still be reserved and undebited.
  if (row.hold_state !== 'active') add('open_without_active_hold', `hold is ${row.hold_state}`);
  if (row.tx_status === 'approved') add('open_with_posted_debit', `${row.state} but the ledger debit posted`);
  if (row.needs_reconciliation === 1) {
    add('unknown_outcome_pending_reconciliation', 'payout outcome unknown — awaiting a human finding');
  }
  return out;
}

/**
 * Read-only ledger/hold/request match (§11.4). Writes nothing, fixes
 * nothing: every discrepancy is reported for an admin to resolve.
 */
export async function walletReconciliationReport(db: D1Database): Promise<ReconciliationReport> {
  const ranAt = new Date().toISOString();

  const [totalsRow, negatives, withdrawals, orphanDebits, userCount] = await Promise.all([
    db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(CASE WHEN currency='USD' AND status='approved'
                                     THEN (CASE WHEN type='deposit' THEN amount ELSE -amount END) ELSE 0 END),0)
              FROM wallet_transactions) AS settled_usd_cents,
           (SELECT COALESCE(SUM(h.amount_cents),0) FROM wallet_holds h
             LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
            WHERE h.state='active' AND (h.tx_id IS NULL OR ht.status <> 'approved')) AS active_holds_usd_cents,
           (SELECT COALESCE(SUM(h.amount_cents),0) FROM wallet_holds h
             LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
            WHERE h.state='active' AND h.kind='withdrawal' AND (h.tx_id IS NULL OR ht.status <> 'approved'))
             AS withdrawal_holds_usd_cents,
           (SELECT COALESCE(SUM(amount_cents),0) FROM wallet_withdrawals
             WHERE state IN ('requested','approved','processing')) AS open_withdrawals_usd_cents,
           (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
             WHERE currency='USD' AND type='deposit' AND status='pending') AS pending_deposits_usd_cents`
      )
      .first<ReconciliationReport['totals']>(),
    db
      .prepare(
        `WITH ledger AS (
           SELECT user_id,
                  COALESCE(SUM(CASE WHEN currency='USD' AND status='approved'
                                    THEN (CASE WHEN type='deposit' THEN amount ELSE -amount END) ELSE 0 END),0) AS settled
             FROM wallet_transactions GROUP BY user_id),
         held AS (
           SELECT h.user_id,
                  COALESCE(SUM(CASE WHEN h.state='active' AND (h.tx_id IS NULL OR ht.status <> 'approved')
                                    THEN h.amount_cents ELSE 0 END),0) AS held
             FROM wallet_holds h LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
            GROUP BY h.user_id)
         SELECT l.user_id, l.settled, COALESCE(hd.held,0) AS held
           FROM ledger l LEFT JOIN held hd ON hd.user_id = l.user_id
          WHERE (l.settled - COALESCE(hd.held,0)) < 0
          LIMIT 200`
      )
      .all<{ user_id: string; settled: number; held: number }>(),
    db
      .prepare(
        `SELECT w.id, w.user_id, w.state, w.amount_cents, w.payout_reference, w.needs_reconciliation,
                h.state AS hold_state, h.amount_cents AS hold_amount_cents, t.status AS tx_status
           FROM wallet_withdrawals w
           LEFT JOIN wallet_holds h ON h.id = w.hold_id
           LEFT JOIN wallet_transactions t ON t.id = w.tx_id
          ORDER BY w.created_at DESC
          LIMIT 1000`
      )
      .all<WithdrawalReconRow>(),
    db
      .prepare(
        `SELECT t.id, t.user_id, t.amount
           FROM wallet_transactions t
          WHERE t.currency='USD' AND t.type='withdrawal' AND t.status='approved' AND t.created_by='user'
            AND NOT EXISTS (SELECT 1 FROM wallet_withdrawals w WHERE w.tx_id = t.id AND w.state = 'paid')
          LIMIT 200`
      )
      .all<{ id: string; user_id: string; amount: number }>(),
    db
      .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM wallet_transactions').first<{ n: number }>(),
  ]);

  const anomalies: ReconciliationAnomaly[] = [];
  for (const n of negatives.results ?? []) {
    anomalies.push({
      kind: 'negative_available',
      user_id: n.user_id,
      ref: n.user_id,
      detail: `settled ${n.settled} − held ${n.held} is negative`,
    });
  }
  for (const w of withdrawals.results ?? []) anomalies.push(...classifyWithdrawalRow(w));
  for (const t of orphanDebits.results ?? []) {
    anomalies.push({
      kind: 'ledger_debit_without_paid_withdrawal',
      user_id: t.user_id,
      ref: t.id,
      detail: `approved user withdrawal debit ${t.amount} with no paid request (legacy or out-of-band approval)`,
    });
  }

  const totals = totalsRow ?? {
    settled_usd_cents: 0,
    active_holds_usd_cents: 0,
    withdrawal_holds_usd_cents: 0,
    open_withdrawals_usd_cents: 0,
    pending_deposits_usd_cents: 0,
  };

  return {
    ran_at: ranAt,
    checked_withdrawals: withdrawals.results?.length ?? 0,
    checked_users: userCount?.n ?? 0,
    totals,
    sums_match: totals.withdrawal_holds_usd_cents === totals.open_withdrawals_usd_cents,
    anomalies,
  };
}

/**
 * Hourly reconciliation entry point for the durable-jobs pipeline
 * (worker/lib/jobs.ts wires this; see the integration note in the slice
 * report). It reads, reports and — when something does not add up — writes
 * ONE audit row so an admin is alerted. It never moves money, never releases
 * a hold and never "fixes" a balance.
 */
export async function reconcileWallets(env: Env): Promise<ReconciliationReport> {
  const report = await walletReconciliationReport(env.DB);
  if (report.anomalies.length > 0 || !report.sums_match) {
    const counts: Record<string, number> = {};
    for (const a of report.anomalies) counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    await audit(env.DB, null, 'wallet.reconciliation.anomalies', 'wallet', {
      ran_at: report.ran_at,
      sums_match: report.sums_match,
      totals: report.totals,
      counts,
      sample: report.anomalies.slice(0, 10),
    });
  }
  return report;
}

// ---------------------------------------------------------------- display

/**
 * Human-readable operation number for support and the user's own records.
 * Derived from the id — it is a LABEL, never an authorisation: knowing an
 * operation number grants no ability to act on it (§11.1).
 */
export function operationNumber(id: string, prefix = 'W'): string {
  const tail = id.replace(/^[a-z]+_/i, '').slice(-8).toUpperCase();
  return `${prefix}-${tail || 'UNKNOWN'}`;
}
