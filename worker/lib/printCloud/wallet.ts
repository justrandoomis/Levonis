/**
 * THE LEVONIS WALLET, SEEN FROM PRINT CLOUD (docs/PRINT_CLOUD.md §4.4).
 *
 * The platform wallet (worker/lib/walletOps.ts) keeps USD CENTS — the money,
 * the only figure a spend guard compares — with the DINARS each row was worth
 * recorded beside them (migration 0108: `amount_iqd`, `exchange_rate_snapshot`).
 * Print Cloud prices in dinars. Every conversion below is one the platform
 * already makes, through the platform's own functions, so the wallet page, the
 * membership purchase and this door can never disagree about a balance:
 *
 *   balance  `walletIqdAvailable(spendable cents, recorded remainders, rate)` —
 *            the figure GET /api/wallet prints, to the dinar;
 *   charge   `walletSpendCents(total dinars, spendable cents, rate)`, at least
 *            one cent (`walletChargeCents`);
 *   debit    `usdSpendStatement`, the ONE conditional spend: when the spendable
 *            balance (settled minus active holds — a pending withdrawal's money
 *            is not spendable) does not cover it at the instant the batch runs,
 *            its amount becomes −1 and `CHECK (amount > 0)` aborts the whole
 *            batch, the order's confirmation and fulfilment with it;
 *   refund   an approved USD deposit (`walletCreditStatement`) recording the
 *            refund's dinars at the DEBIT's rate, in the refund's own batch.
 *
 * IDS ARE DERIVED, so a second copy of one money event collides on the
 * wallet's own PRIMARY KEY instead of moving money twice:
 *
 *   wtx_pc_<order id>   the one debit an order can ever have;
 *   wtx_pc_<refund id>  the one credit a refund can ever have.
 *
 * Both carry `ref` = the order id. The debit is written `created_by =
 * 'system'` (usdSpendStatement), which keeps it out of the platform
 * reconciliation's «user withdrawal without a paid request»
 * (`walletReconciliationReport`): it is a purchase, not a payout. The refund
 * credit is the admin's decision and says so (`created_by = 'admin'`).
 */
import { walletCreditStatement } from '../wallet';
import { availableUsdSql, isConstraintAbort, readWalletDust, usdSpendStatement, walletIqdAvailable, walletLedgerDinarsReady, walletSpendCents } from '../walletOps';
import { dinarsBeforeRebase, getOfficialUsdRate, refundCentsAcrossRebase } from '../fx/officialRate';
import { fence, one, type Stmt } from './db';
import { classifyDbError, pcError } from './errors';
import type { OrderRow } from './orders';
import type { PrintCloudConfig } from './settings';
import { iso, mulDivFloor } from './util';

export const WALLET_TX_PREFIX = 'wtx_pc_';
/** Every refund id is `pcrf_…` (orders.ts `planLineRefund`), so every refund credit starts with this. */
export const WALLET_REFUND_TX_PREFIX = `${WALLET_TX_PREFIX}pcrf_`;
export const walletDebitTxId = (orderId: string): string => `${WALLET_TX_PREFIX}${orderId}`;
export const walletRefundTxId = (refundId: string): string => `${WALLET_TX_PREFIX}${refundId}`;
/** The payment event of an order paid from the wallet: one per order, so a second wallet payment collides (pc_payment_events UNIQUE). */
export const walletPaymentEventId = (orderId: string): string => `wallet:${orderId}`;

const positiveInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export interface WalletPosition {
  /** Spendable cents: approved deposits − approved withdrawals − active holds not yet posted (walletOps `availableUsdSql`). */
  available_cents: number;
  /** The dinar figure the Levonis wallet page shows for the same cents. */
  available_iqd: number;
  /** The platform's one official IQD per USD (fx/officialRate.ts), never 0. */
  exchange_rate: number;
}

/**
 * The customer's spendable wallet, read exactly as GET /api/wallet reads it:
 * the same spendable cents, the same remainders (`readWalletDust`, which reads
 * a database behind on 0108 as «no remainders», like every balance before it),
 * the same rate, the same conversion. Platform tables only: it answers the
 * same on a database without Print Cloud's migration. An outage propagates.
 */
export async function walletPosition(db: D1Database, userId: string): Promise<WalletPosition> {
  const [cents, dust, rate] = await Promise.all([
    db.prepare(`SELECT ${availableUsdSql('?1')} AS cents`).bind(userId).first<{ cents: number }>(),
    readWalletDust(db, userId),
    getOfficialUsdRate(db),
  ]);
  const available = Math.trunc(Number(cents?.cents) || 0);
  return { available_cents: available, available_iqd: walletIqdAvailable(available, dust.dust_iqd, rate), exchange_rate: rate };
}

/** GET /me/wallet: whether this service may spend the wallet now, and what the wallet page shows. */
export async function walletView(db: D1Database, userId: string, config: Pick<PrintCloudConfig, 'wallet_payment_enabled'>) {
  const position = await walletPosition(db, userId);
  return {
    connected: config.wallet_payment_enabled,
    available_iqd: position.available_iqd,
    exchange_rate: position.exchange_rate > 0 ? position.exchange_rate : null,
  };
}

/**
 * THE CENTS AN ORDER COSTS THE WALLET.
 *
 * `walletSpendCents` floors the dinar total into cents and caps it at the
 * cents on hand — the platform's one spend-side conversion. A ceil would ask a
 * wallet whose page prints exactly the order's total for one cent more than it
 * holds, and refuse a customer who can pay; the cap turns the remainders a
 * dinar balance may carry above its cents (0108) into the shop's cost of at
 * most one cent, never into a failed batch.
 *
 * AT LEAST ONE CENT. A total below one cent's worth (13 IQD or less at 1,400)
 * floors to zero cents, and `CHECK (amount > 0)` on `wallet_transactions`
 * forbids a zero debit: with no ledger row the order would be fulfilled free.
 * As on the membership purchase (worker/routes/memberships.ts), the wallet is
 * the whole payment on this path, so such an order is charged one cent — the
 * dinar check before it proved a positive balance, which has at least one cent
 * behind it — and the customer pays at most one cent more than the quoted
 * dinars, once, on a price smaller than that. A ZERO total charges nothing:
 * there is nothing to collect, and the order is confirmed with no debit, as
 * `confirmPayment` confirms a zero amount for any adapter.
 */
export function walletChargeCents(totalIqd: number, availableCents: number, rate: number): number {
  if (!(totalIqd > 0)) return 0;
  return Math.max(1, walletSpendCents(totalIqd, availableCents, rate));
}

/** The order's one debit: the platform's conditional spend, with the dinars it was priced in when the ledger can hold them. */
export async function walletDebitStatement(
  db: D1Database,
  p: { orderId: string; userId: string; cents: number; totalIqd: number; rate: number; nowIso: string }
): Promise<Stmt> {
  // 0108's columns, only when the database has them: a Worker live ahead of
  // its migration writes the row exactly as before instead of aborting a
  // money batch on a column that is not there.
  const ledgerDinars = await walletLedgerDinarsReady(db);
  return usdSpendStatement(db, {
    txId: walletDebitTxId(p.orderId),
    userId: p.userId,
    amountCents: p.cents,
    note: `Levonis Print Cloud — payment for order ${p.orderId}`,
    ref: p.orderId,
    nowIso: p.nowIso,
    // The customer was shown dinars: recording them is what makes the wallet
    // page fall by the order's total rather than by its cents converted back.
    amountIqd: ledgerDinars ? p.totalIqd : null,
    exchangeRateSnapshot: ledgerDinars ? p.rate : null,
  });
}

export const insufficientBalance = (availableIqd: number, requiredIqd: number) =>
  pcError('INSUFFICIENT_BALANCE', { available_iqd: availableIqd, required_iqd: requiredIqd });

/**
 * Why this order cannot be paid from the wallet now, or null when it can:
 * it must still await payment, before its own deadline (past it the expiry
 * sweep closes it and puts its stock back), and a delivery fee only while its
 * shipment still waits for it.
 */
export async function walletPayability(db: D1Database, order: OrderRow, now: Date): Promise<Record<string, unknown> | null> {
  if (order.status !== 'awaiting_payment') return { status: order.status, reason: order.paid_at ? 'already_paid' : order.status };
  if (order.stock_hold_expires_at <= iso(now)) return { status: order.status, reason: 'expired' };
  if (order.kind === 'shipping') {
    const shipment = await one<{ status: string }>(db, 'SELECT status FROM pc_shipments WHERE fee_order_id = ?', order.id);
    if (shipment?.status !== 'awaiting_payment') return { status: order.status, reason: 'shipment_not_awaiting_payment', shipment_status: shipment?.status ?? null };
  }
  return null;
}

/**
 * WHAT A REFUSED WALLET-PAYMENT BATCH MEANT — decided from the facts, read
 * again, never from an error's wording alone, and never for an outage.
 *
 * Only a batch the database REFUSED is classified: one of its own guards fired
 * (a CHECK — the wallet's −1 among them —, a UNIQUE or PRIMARY KEY, a Print
 * Cloud fence). Anything else — a D1 outage, a dropped connection — returns
 * undefined and `idempotent` rethrows it: a 500 to retry, never «your balance
 * is short» or «this order is paid» invented for a failure to answer.
 *
 * In order of precedence:
 *   1. the order is no longer payable: another request paid it (a wallet
 *      payment with another key hit the debit's PRIMARY KEY or the event's
 *      UNIQUE; a manual receipt or a gateway webhook took the order's state,
 *      so this batch's fence failed), or it was cancelled or expired —
 *      ORDER_NOT_PAYABLE;
 *   2. the wallet no longer covers it: a withdrawal hold or another spend
 *      landed between the plan and the batch — INSUFFICIENT_BALANCE, with the
 *      figures read now;
 *   3. neither: plan again (a concurrent write the next plan sees); on the
 *      last attempt, the refusal the database expressed when it names one
 *      (a stock deficit), else STATE_CHANGED. Nothing was charged in any case.
 */
export async function walletPaymentRefusal(
  db: D1Database,
  e: unknown,
  p: { orderId: string; userId: string; now: Date; lastAttempt: boolean }
): Promise<'retry' | undefined> {
  const message = e instanceof Error ? e.message : String(e);
  if (!isConstraintAbort(e) && !/PC_FENCE:/.test(message)) return undefined;
  const order = await one<OrderRow>(db, 'SELECT * FROM pc_orders WHERE id = ?', p.orderId);
  if (!order || order.user_id !== p.userId) throw pcError('NOT_FOUND');
  const notPayable = await walletPayability(db, order, p.now);
  if (notPayable) throw pcError('ORDER_NOT_PAYABLE', notPayable);
  const position = await walletPosition(db, p.userId);
  if (order.total_iqd > position.available_iqd) throw insufficientBalance(position.available_iqd, order.total_iqd);
  if (!p.lastAttempt) return 'retry';
  const mapped = classifyDbError(e);
  if (mapped && mapped.code !== 'VALIDATION' && mapped.code !== 'STATE_CHANGED') throw mapped;
  throw pcError('STATE_CHANGED');
}

export interface WalletRefundCredit {
  statements: Stmt[];
  tx_id: string;
  usd_cents: number;
  /** The refund's dinars recorded on the credit (0108), or null when the debit recorded none. */
  amount_iqd: number | null;
  /** The rate recorded beside them: the debit's own (or today's official rate for a debit taken before the wallet rebase). */
  exchange_rate: number | null;
}

/**
 * THE WALLET CREDIT OF A REFUND OF AN ORDER PAID FROM THE WALLET, planned
 * inside the refund's own batch (orders.ts `planLineRefund`), against the
 * order snapshot that batch is fenced on.
 *
 * CUMULATIVE, SO THE CENTS ADD UP EXACTLY. The debit took D cents for P
 * dinars. After refunds totalling R dinars the wallet has had back
 * floor(D × R / P) cents — this refund's cents are the step from the order's
 * refunded dinars before it to after it. So:
 *   - the refunded cents never exceed the debited cents (R ≤ P, which
 *     `ck_pc_order_refund` guards, and a fence below re-proves in the batch);
 *   - refunding the whole paid amount, in one refund or in many, returns
 *     EXACTLY the D cents taken — floor(D × P / P) = D;
 *   - the order's refunded dinars move with every refund, and the refund batch
 *     is fenced on them, so two refunds can never both credit the same step.
 * A refund too small to move the floor (under one cent's worth) is refused
 * with the smallest amount that would: the wallet cannot hold a fraction of a
 * cent, and a refund recorded as returned that returned nothing would not be
 * true (the platform's return refund refuses the same case).
 *
 * THE DINARS RIDE AT THE DEBIT'S RATE. The credit records the refund's dinars
 * beside its cents at the rate the debit recorded, so the wallet page rises by
 * the refunded amount. One full refund is the exact mirror of the debit (the
 * same cents, the same dinars, the same rate) and leaves the page where it was
 * before the order. A refund in parts whose floor step happens to be worth a
 * little more than its own dinars reads that little more — at most one cent's
 * worth, never less than the refund — because a credit records no negative
 * remainder (walletOps `walletDustIqdSql`); the cents themselves stay exact. A
 * debit that recorded no dinars is mirrored by a credit that records none. A
 * debit taken before the one-time wallet rebase is given back rescaled, as
 * every pre-rebase refund is (fx/officialRate.ts).
 */
export async function planWalletRefundCredit(
  db: D1Database,
  p: { order: Pick<OrderRow, 'id' | 'user_id' | 'paid_iqd' | 'refunded_iqd'>; refundId: string; amountIqd: number; nowIso: string }
): Promise<WalletRefundCredit> {
  const ledgerDinars = await walletLedgerDinarsReady(db);
  const debitId = walletDebitTxId(p.order.id);
  const debit = await db
    .prepare(
      ledgerDinars
        ? "SELECT user_id, amount, amount_iqd, exchange_rate_snapshot, created_at FROM wallet_transactions WHERE id = ? AND type = 'withdrawal' AND currency = 'USD' AND status = 'approved'"
        : "SELECT user_id, amount, created_at FROM wallet_transactions WHERE id = ? AND type = 'withdrawal' AND currency = 'USD' AND status = 'approved'"
    )
    .bind(debitId)
    .first<{ user_id: string; amount: number; amount_iqd?: number | null; exchange_rate_snapshot?: number | null; created_at: string | null }>();
  const debited = positiveInt(debit?.amount);
  // A wallet-paid order with money to refund has its debit, written in its payment's batch. Without it there is
  // nothing proven to give back: refused, never a credit invented from the order's figures.
  if (!debit || debited === null || debit.user_id !== p.order.user_id) throw pcError('INVALID_TRANSITION', { reason: 'wallet_debit_missing', wallet_tx_id: debitId });
  const paid = Math.trunc(Number(p.order.paid_iqd));
  const before = Math.trunc(Number(p.order.refunded_iqd));
  const after = before + p.amountIqd;
  if (!(paid > 0) || before < 0 || after > paid) throw pcError('STATE_CHANGED');
  const share = (refunded: number) => mulDivFloor(debited, refunded, paid);
  const cents = share(after) - share(before);
  if (cents <= 0) {
    // The smallest refund that moves the floor by a cent: R + a ≥ ceil((share(R) + 1) × P / D).
    const next = BigInt(share(before) + 1) * BigInt(paid);
    const reach = Number((next + BigInt(debited) - 1n) / BigInt(debited)) - before;
    throw pcError('VALIDATION', { field: 'amount_iqd', reason: 'below_one_cent', min_amount_iqd: Math.min(reach, paid - before) });
  }
  const debitIqd = ledgerDinars ? positiveInt(debit.amount_iqd) : null;
  const debitRate = ledgerDinars ? positiveInt(debit.exchange_rate_snapshot) : null;
  let amountIqd: number | null = debitIqd !== null && debitRate !== null ? p.amountIqd : null;
  let rate: number | null = amountIqd !== null ? debitRate : null;
  const back = await refundCentsAcrossRebase(db, cents, debit.created_at, rate);
  if (back.rescaled && amountIqd !== null && rate !== null && back.legacyRate !== null) {
    amountIqd = dinarsBeforeRebase(amountIqd, cents, rate, back.legacyRate);
    rate = back.rate;
  }
  const txId = walletRefundTxId(p.refundId);
  const statements: Stmt[] = [
    walletCreditStatement(db, ledgerDinars, {
      id: txId,
      userId: p.order.user_id,
      cents: back.cents,
      note: `Levonis Print Cloud — refund ${p.refundId} for order ${p.order.id}`,
      ref: p.order.id,
      nowIso: p.nowIso,
      amountIqd: amountIqd ?? 0,
      rate: rate ?? 0,
      createdBy: 'admin',
    }),
    // Proven again by the database, in this batch: everything this order's refunds credited (this one included)
    // is at most what its debit took.
    fence(
      db,
      'STATE_CHANGED',
      `(SELECT COALESCE(SUM(c.amount), 0) FROM wallet_transactions c
         WHERE c.user_id = ? AND c.ref = ? AND c.type = 'deposit' AND c.currency = 'USD' AND c.status = 'approved'
           AND substr(c.id, 1, ${WALLET_REFUND_TX_PREFIX.length}) = ?)
       <= (SELECT d.amount FROM wallet_transactions d WHERE d.id = ? AND d.status = 'approved')`,
      [p.order.user_id, p.order.id, WALLET_REFUND_TX_PREFIX, debitId]
    ),
  ];
  return { statements, tx_id: txId, usd_cents: back.cents, amount_iqd: amountIqd, exchange_rate: rate };
}
