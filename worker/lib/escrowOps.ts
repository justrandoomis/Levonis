/**
 * Escrow: money held by Levonis between accepting an offer and finishing the work.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE: money is never a mutable number.
 * Amounts are written once, at creation, and never updated. A correction is a
 * new EVENT — a release, a refund, a reversal — appended to
 * `community_escrow_events`. There is no merchant balance column for a retry
 * to double, and no way to "fix" a settlement by editing history (§29, §76).
 *
 * WHY A WALLET HOLD, NOT A DEBIT. Accepting an offer must not spend the
 * customer's money — the merchant has not done anything yet. It must also not
 * leave the money spendable, or the customer can accept three offers with one
 * balance. `wallet_holds` already solves exactly this for checkout, atomically:
 * the availability check lives inside the INSERT, so two racing acceptances on
 * one balance cannot both succeed. Reusing it rather than inventing a second
 * reservation mechanism is the whole point (§89).
 *
 * CURRENCY. Escrow is denominated in IQD, because that is what the customer
 * agreed and what the merchant is owed. The wallet holds USD cents, so the
 * hold is taken in USD at the authoritative rate and that rate is SNAPSHOT on
 * the escrow. A later rate change must not alter what either party owes for a
 * deal already struck (§31).
 *
 * IDEMPOTENCY. Every money-moving function takes an idempotency key and
 * writes it to a UNIQUE column. A retried request — a double tap, a network
 * retry, a client that gave up and re-sent — finds the key already present
 * and returns the ORIGINAL outcome rather than moving money twice (§65).
 */

import { newId } from './crypto';
import {
  assertHoldStateStatement,
  commitHoldStatements,
  createPurchaseHold,
  holdDebitTxId,
  holdSettledEventStatements,
  isConstraintAbort,
  releaseHoldStatement,
  type HoldState,
} from './walletOps';

export type EscrowState =
  | 'pending'
  | 'held'
  | 'released'
  | 'partially_refunded'
  | 'refunded'
  | 'disputed'
  | 'cancelled';

export interface EscrowRow {
  id: string;
  community_order_id: string;
  customer_id: string;
  merchant_id: string;
  gross_iqd: number;
  platform_fee_iqd: number;
  merchant_receivable_iqd: number;
  released_iqd: number;
  refunded_iqd: number;
  state: EscrowState;
  hold_id: string | null;
  held_at: string | null;
  released_at: string | null;
  refunded_at: string | null;
  disputed_at: string | null;
}

export type EscrowFailure =
  | 'INSUFFICIENT_FUNDS'
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'STATE_CONFLICT'
  | 'AMOUNT_EXCEEDS_HELD'
  | 'INVALID_AMOUNT'
  | 'WALLET_ERROR';

export type EscrowResult<T = { escrowId: string }> =
  | ({ ok: true; replayed: boolean } & T)
  | { ok: false; reason: EscrowFailure; detail?: string };

const NOW = () => new Date().toISOString();

/** IQD → USD cents, rounding UP so a hold never under-reserves. */
export function iqdToUsdCents(iqd: number, rate: number): number {
  return Math.ceil((iqd * 100) / Math.max(1, rate));
}

/**
 * USD cents → IQD, rounding DOWN — the mirror of the rule above.
 *
 * The pair has to lean the same way or a balance would be reported as
 * covering a total it cannot actually pay: `iqdToUsdCents` rounds UP, so a
 * spendable balance converted back must never round up too, or the last IQD
 * of a cart would be promised and then refused by the hold. This is the
 * number shown to a customer as "what your wallet can pay", so it is the
 * conservative one by construction.
 */
export function usdCentsToIqd(cents: number, rate: number): number {
  return Math.floor((cents * Math.max(1, rate)) / 100);
}

/** The authoritative rate, from the same setting the rest of checkout reads. */
export async function exchangeRate(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value FROM admin_settings WHERE key = 'exchangeRate'").first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : 1400;
}

/**
 * Has this exact business event already been recorded?
 * Returns the event row when it has, so the caller replays the original
 * outcome instead of performing a second one.
 */
async function findEvent(db: D1Database, key: string) {
  return db
    .prepare('SELECT id, escrow_id, kind, amount_iqd FROM community_escrow_events WHERE idempotency_key = ?')
    .bind(key)
    .first<{ id: string; escrow_id: string; kind: string; amount_iqd: number }>();
}

export function getEscrow(db: D1Database, id: string): Promise<EscrowRow | null> {
  return db.prepare('SELECT * FROM community_escrows WHERE id = ?').bind(id).first<EscrowRow>();
}

export function escrowForOrder(db: D1Database, communityOrderId: string): Promise<EscrowRow | null> {
  return db
    .prepare('SELECT * FROM community_escrows WHERE community_order_id = ?')
    .bind(communityOrderId)
    .first<EscrowRow>();
}

// ---------------------------------------------------------------- create

export interface HoldEscrowInput {
  communityOrderId: string;
  customerId: string;
  merchantId: string;
  grossIqd: number;
  platformFeeIqd: number;
  merchantReceivableIqd: number;
  idempotencyKey: string;
}

/**
 * Reserve the customer's money against a community order.
 *
 * The wallet hold is taken FIRST. If the customer cannot cover it, nothing
 * is written at all — no escrow row in a half-funded state for someone to
 * find later and wonder about.
 */
export async function holdEscrow(db: D1Database, p: HoldEscrowInput): Promise<EscrowResult> {
  if (p.grossIqd <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (p.platformFeeIqd + p.merchantReceivableIqd !== p.grossIqd) {
    // The database CHECK would refuse this anyway; failing here names the
    // real problem instead of surfacing a constraint error.
    return { ok: false, reason: 'INVALID_AMOUNT', detail: 'fee + receivable must equal gross' };
  }

  const replay = await findEvent(db, p.idempotencyKey);
  if (replay) return { ok: true, replayed: true, escrowId: replay.escrow_id };

  const existing = await escrowForOrder(db, p.communityOrderId);
  if (existing) return { ok: false, reason: 'ALREADY_EXISTS', detail: existing.id };

  const rate = await exchangeRate(db);
  const cents = iqdToUsdCents(p.grossIqd, rate);

  // The hold's own event key is derived from the escrow's, so a retry of this
  // whole function re-finds the same hold instead of reserving twice.
  const hold = await createPurchaseHold(db, {
    userId: p.customerId,
    amountCents: cents,
    eventKey: `escrow:${p.idempotencyKey}`,
    refType: 'community_order',
    refId: p.communityOrderId,
    note: 'Community order escrow',
  });
  if (!hold.ok) {
    return {
      ok: false,
      reason: hold.reason === 'INSUFFICIENT_AVAILABLE' ? 'INSUFFICIENT_FUNDS' : 'WALLET_ERROR',
      detail: hold.reason,
    };
  }

  const escrowId = newId('esc');
  const ts = NOW();
  await db.batch([
    db
      .prepare(
        `INSERT INTO community_escrows
           (id, community_order_id, customer_id, merchant_id, gross_iqd, platform_fee_iqd,
            merchant_receivable_iqd, state, hold_id, held_at, created_at)
         VALUES (?,?,?,?,?,?,?,'held',?,?,?)`
      )
      .bind(
        escrowId, p.communityOrderId, p.customerId, p.merchantId,
        p.grossIqd, p.platformFeeIqd, p.merchantReceivableIqd, hold.holdId, ts, ts
      ),
    db
      .prepare(
        `INSERT INTO community_escrow_events
           (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
         VALUES (?,?,'held',?,?, 'customer', ?, ?, ?)`
      )
      .bind(newId('ese'), escrowId, p.grossIqd, p.customerId, `rate=${rate};cents=${cents}`, p.idempotencyKey, ts),
  ]);

  return { ok: true, replayed: false, escrowId };
}

// ---------------------------------------------------------------- release

export interface SettleInput {
  escrowId: string;
  actorId: string | null;
  actorRole: 'customer' | 'merchant' | 'admin' | 'system';
  reason?: string;
  idempotencyKey: string;
}

/**
 * "The customer's debit is posted and linked to this hold" — the predicate
 * every merchant credit below is conditional on. Money enters the merchant's
 * ledger ONLY in a batch where the customer's money left theirs.
 */
const FUNDED_BY_HOLD = `EXISTS (SELECT 1 FROM wallet_holds fh
   JOIN wallet_transactions ft ON ft.id = fh.tx_id
  WHERE fh.id = ?1 AND fh.state = 'committed' AND fh.tx_id = ?2
    AND ft.type = 'withdrawal' AND ft.status = 'approved')`;

/**
 * Why did a settlement batch write nothing? Read-only: the escrow that was
 * read before the batch, re-read now, and its hold.
 */
async function classifySettleFailure(
  db: D1Database,
  esc: EscrowRow,
  intended: EscrowState
): Promise<EscrowResult> {
  const again = await getEscrow(db, esc.id);
  if (!again) return { ok: false, reason: 'NOT_FOUND' };
  if (again.state === intended) return { ok: true, replayed: true, escrowId: esc.id };
  if (again.state !== esc.state) return { ok: false, reason: 'STATE_CONFLICT', detail: again.state };
  // The escrow did not move, so the hold refused: it is no longer active, or
  // the reservation is no longer covered by the customer's settled money.
  const hold = esc.hold_id
    ? await db.prepare('SELECT state FROM wallet_holds WHERE id = ?').bind(esc.hold_id).first<{ state: HoldState }>()
    : null;
  if (!hold) return { ok: false, reason: 'WALLET_ERROR', detail: 'escrow has no wallet hold' };
  if (hold.state !== 'active') return { ok: false, reason: 'WALLET_ERROR', detail: `hold is ${hold.state}` };
  return { ok: false, reason: 'INSUFFICIENT_FUNDS', detail: 'the reserved money is no longer covered' };
}

/**
 * Pay the merchant.
 *
 * Three things happen together, or none of them do: the customer's held money
 * is committed AND its ledger debit posts (it leaves their balance — see
 * `commitHoldStatements`), the merchant is credited in the payout ledger, and
 * the escrow is marked released. Splitting these across requests is how a
 * merchant ends up credited for money the customer still has — which is what
 * the first version of this function did: it committed the hold in a call of
 * its own, posted no debit, and credited the merchant from a batch that ran
 * afterwards.
 *
 * Everything is ONE `db.batch`. The escrow flip is conditional on the state
 * that was read; the debit aborts the batch unless the hold is still active;
 * and every merchant credit repeats "the debit is posted and linked", so a
 * lost race writes nothing on either side.
 *
 * A released escrow can NEVER return to held (§29).
 */
export async function releaseEscrow(db: D1Database, p: SettleInput): Promise<EscrowResult> {
  const replay = await findEvent(db, p.idempotencyKey);
  if (replay) return { ok: true, replayed: true, escrowId: replay.escrow_id };

  const esc = await getEscrow(db, p.escrowId);
  if (!esc) return { ok: false, reason: 'NOT_FOUND' };
  if (esc.state === 'released') return { ok: true, replayed: true, escrowId: esc.id };
  if (esc.state !== 'held' && esc.state !== 'disputed') {
    return { ok: false, reason: 'STATE_CONFLICT', detail: esc.state };
  }
  // No hold means no customer money to settle, so nothing may be paid out.
  if (!esc.hold_id) return { ok: false, reason: 'WALLET_ERROR', detail: 'escrow has no wallet hold' };

  const ts = NOW();
  const debitTx = holdDebitTxId(esc.hold_id);
  const statements = [
    db
      .prepare(
        `UPDATE community_escrows
            SET state = 'released', released_iqd = gross_iqd, released_at = ?
          WHERE id = ? AND state IN ('held','disputed')`
      )
      .bind(ts, esc.id),
    ...commitHoldStatements(db, {
      holdId: esc.hold_id,
      note: 'Community order payment',
      ref: esc.community_order_id,
    }),
    // §3.9's settlement event, guarded by the debit this batch posts. Nothing
    // at all while the bus is off.
    ...(await holdSettledEventStatements(db, esc.hold_id)),
    db
      .prepare(
        `INSERT INTO merchant_payout_ledger
           (id, merchant_id, kind, amount_iqd, state, community_order_id, escrow_id, note, idempotency_key)
         SELECT ?3, ?4, 'community_order_credit', ?5, 'available', ?6, ?7, ?8, ?9
          WHERE ${FUNDED_BY_HOLD}`
      )
      .bind(
        esc.hold_id, debitTx,
        newId('pay'), esc.merchant_id, esc.merchant_receivable_iqd,
        esc.community_order_id, esc.id, p.reason ?? '', `credit:${p.idempotencyKey}`
      ),
    db
      .prepare(
        `INSERT INTO merchant_payout_ledger
           (id, merchant_id, kind, amount_iqd, state, community_order_id, escrow_id, note, idempotency_key)
         SELECT ?3, ?4, 'commission', ?5, 'paid', ?6, ?7, 'platform commission', ?8
          WHERE ${FUNDED_BY_HOLD}`
      )
      .bind(
        esc.hold_id, debitTx,
        newId('pay'), esc.merchant_id, -esc.platform_fee_iqd,
        esc.community_order_id, esc.id, `fee:${p.idempotencyKey}`
      ),
    db
      .prepare(
        `INSERT INTO community_escrow_events
           (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
         SELECT ?3, ?4, 'release', ?5, ?6, ?7, ?8, ?9, ?10
          WHERE ${FUNDED_BY_HOLD}`
      )
      .bind(
        esc.hold_id, debitTx,
        newId('ese'), esc.id, esc.merchant_receivable_iqd, p.actorId, p.actorRole,
        p.reason ?? '', p.idempotencyKey, ts
      ),
  ];

  try {
    const res = await db.batch(statements);
    if (res[0]?.meta.changes) return { ok: true, replayed: false, escrowId: esc.id };
  } catch (e) {
    // The debit's CHECK guard fired — the batch rolled back whole and the
    // re-read below says why. A failure that is not a guard propagates.
    if (!isConstraintAbort(e)) throw e;
  }
  return classifySettleFailure(db, esc, 'released');
}

// ----------------------------------------------------------------- refund

export interface RefundInput extends SettleInput {
  /** Omit for a full refund. */
  amountIqd?: number;
}

/**
 * Give money back to the customer.
 *
 * A full refund simply releases the wallet hold: the money was never spent,
 * so it becomes available again and no ledger entry is needed on either side.
 *
 * A PARTIAL refund cannot work that way — part is kept and part returned — so
 * the hold is committed in full (its debit posts, see `commitHoldStatements`)
 * and the refunded part is credited back to the customer's wallet as a real
 * transaction. That leaves a visible pair of movements rather than a quietly
 * reduced hold, which is what an auditor needs to see, and the NET equals
 * exactly what the merchant is credited for. Before the settlement rule the
 * "commit" posted no debit, so the pair was a credit for money never taken.
 *
 * Either way it is ONE `db.batch`: the state flip, the hold's release or
 * settlement, the customer's credit and the merchant's credit commit
 * together or not at all, and a hold statement that matched zero rows aborts
 * the batch instead of leaving a refunded escrow over a still-active hold.
 */
export async function refundEscrow(db: D1Database, p: RefundInput): Promise<EscrowResult> {
  const replay = await findEvent(db, p.idempotencyKey);
  if (replay) return { ok: true, replayed: true, escrowId: replay.escrow_id };

  const esc = await getEscrow(db, p.escrowId);
  if (!esc) return { ok: false, reason: 'NOT_FOUND' };
  if (esc.state === 'refunded') return { ok: true, replayed: true, escrowId: esc.id };
  if (esc.state !== 'held' && esc.state !== 'disputed') {
    return { ok: false, reason: 'STATE_CONFLICT', detail: esc.state };
  }
  if (!esc.hold_id) return { ok: false, reason: 'WALLET_ERROR', detail: 'escrow has no wallet hold' };

  const amount = p.amountIqd === undefined ? esc.gross_iqd : Math.floor(p.amountIqd);
  if (amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (amount > esc.gross_iqd - esc.released_iqd - esc.refunded_iqd) {
    return { ok: false, reason: 'AMOUNT_EXCEEDS_HELD' };
  }

  const full = amount === esc.gross_iqd;
  const ts = NOW();
  const nextState: EscrowState = full ? 'refunded' : 'partially_refunded';

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE community_escrows
            SET state = ?, refunded_iqd = refunded_iqd + ?, refunded_at = ?
          WHERE id = ? AND state IN ('held','disputed')
            AND released_iqd + refunded_iqd + ? <= gross_iqd`
      )
      .bind(nextState, amount, ts, esc.id, amount),
  ];

  if (full) {
    // Nothing was ever spent: releasing the hold returns it to available.
    // The fence aborts the batch if the release matched no row (the hold was
    // no longer active), so a refunded escrow never sits over kept money.
    statements.push(
      releaseHoldStatement(db, { holdId: esc.hold_id, reason: 'Community order refunded' }),
      assertHoldStateStatement(db, esc.hold_id, 'released'),
      db
        .prepare(
          `INSERT INTO community_escrow_events
             (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
           VALUES (?,?,'refund',?,?,?,?,?,?)`
        )
        .bind(newId('ese'), esc.id, amount, p.actorId, p.actorRole, p.reason ?? '', p.idempotencyKey, ts)
    );
  } else {
    const rate = await exchangeRate(db);
    const debitTx = holdDebitTxId(esc.hold_id);
    const keptGross = esc.gross_iqd - amount;
    const keptReceivable = Math.max(0, Math.min(esc.merchant_receivable_iqd, keptGross));
    statements.push(
      ...commitHoldStatements(db, {
        holdId: esc.hold_id,
        note: 'Community order payment',
        ref: esc.community_order_id,
      }),
      ...(await holdSettledEventStatements(db, esc.hold_id)),
      // The returned part comes back as its own approved credit — only once
      // the full debit is posted, so the two movements always appear together.
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
           SELECT ?3, ?4, 'deposit', 'USD', ?5, 'approved', 'Community order partial refund', ?6, 'system', ?7
            WHERE ${FUNDED_BY_HOLD}`
        )
        .bind(
          esc.hold_id, debitTx,
          `wtx_escrow_refund_${esc.id}`, esc.customer_id, iqdToUsdCents(amount, rate), esc.community_order_id, ts
        ),
      db
        .prepare(
          `INSERT INTO community_escrow_events
             (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
           SELECT ?3, ?4, 'refund', ?5, ?6, ?7, ?8, ?9, ?10
            WHERE ${FUNDED_BY_HOLD}`
        )
        .bind(
          esc.hold_id, debitTx,
          newId('ese'), esc.id, amount, p.actorId, p.actorRole, p.reason ?? '', p.idempotencyKey, ts
        ),
      // The merchant still earns on the part that was kept — funded by the
      // same debit, in the same batch.
      db
        .prepare(
          `INSERT INTO merchant_payout_ledger
             (id, merchant_id, kind, amount_iqd, state, community_order_id, escrow_id, note, idempotency_key)
           SELECT ?3, ?4, 'community_order_credit', ?5, 'available', ?6, ?7, 'partial settlement', ?8
            WHERE ${FUNDED_BY_HOLD}`
        )
        .bind(
          esc.hold_id, debitTx,
          newId('pay'), esc.merchant_id, keptReceivable, esc.community_order_id, esc.id,
          `partial:${p.idempotencyKey}`
        )
    );
  }

  try {
    const res = await db.batch(statements);
    if (res[0]?.meta.changes) return { ok: true, replayed: false, escrowId: esc.id };
  } catch (e) {
    // A hold statement refused (fence or debit guard) — the whole batch
    // rolled back and the re-read below says why. Anything else propagates.
    if (!isConstraintAbort(e)) throw e;
  }
  return classifySettleFailure(db, esc, nextState);
}

// ---------------------------------------------------------------- dispute

/**
 * Freeze settlement while a complaint is open (§45).
 * Neither party can be paid and nothing can be refunded until an admin
 * decides — which is the entire purpose of holding the money in the first
 * place.
 */
export async function disputeEscrow(db: D1Database, p: SettleInput): Promise<EscrowResult> {
  const replay = await findEvent(db, p.idempotencyKey);
  if (replay) return { ok: true, replayed: true, escrowId: replay.escrow_id };

  const esc = await getEscrow(db, p.escrowId);
  if (!esc) return { ok: false, reason: 'NOT_FOUND' };
  if (esc.state === 'disputed') return { ok: true, replayed: true, escrowId: esc.id };
  // A settled escrow is finished. Opening a dispute cannot claw money back
  // out of a merchant's ledger — that is a reversal, an admin decision with
  // its own record, not a state flip.
  if (esc.state !== 'held') return { ok: false, reason: 'STATE_CONFLICT', detail: esc.state };

  const ts = NOW();
  const guard = await db
    .prepare(`UPDATE community_escrows SET state = 'disputed', disputed_at = ? WHERE id = ? AND state = 'held'`)
    .bind(ts, esc.id)
    .run();
  if (!guard.meta.changes) return { ok: false, reason: 'STATE_CONFLICT' };

  await db
    .prepare(
      `INSERT INTO community_escrow_events
         (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
       VALUES (?,?,'dispute_open',0,?,?,?,?,?)`
    )
    .bind(newId('ese'), esc.id, p.actorId, p.actorRole, p.reason ?? '', p.idempotencyKey, ts)
    .run();

  return { ok: true, replayed: false, escrowId: esc.id };
}

/** A merchant's settled balance: a SUM over the ledger, never a stored column. */
export async function merchantBalance(
  db: D1Database,
  merchantId: string
): Promise<{ available_iqd: number; pending_iqd: number; paid_iqd: number }> {
  const { results } = await db
    .prepare(
      `SELECT state, COALESCE(SUM(amount_iqd), 0) AS total
         FROM merchant_payout_ledger WHERE merchant_id = ? GROUP BY state`
    )
    .bind(merchantId)
    .all<{ state: string; total: number }>();
  const by = new Map(results.map((r) => [r.state, Number(r.total)]));
  return {
    available_iqd: by.get('available') ?? 0,
    pending_iqd: by.get('pending') ?? 0,
    paid_iqd: by.get('paid') ?? 0,
  };
}
