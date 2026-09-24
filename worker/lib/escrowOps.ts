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
 * deal already struck (§31). Since «الدينار هو الأساس» the customer is asked
 * whether their DINAR balance covers the offer, the cents are floored and
 * capped exactly as a checkout's are (`walletSpendCents`), and the settlement
 * debit records the dinars it spent (migration 0108) — so a wallet that read
 * 50,000 د.ع accepts a 50,000 د.ع offer and then reads zero, not six.
 *
 * IDEMPOTENCY. Every money-moving function takes an idempotency key and
 * writes it to a UNIQUE column. A retried request — a double tap, a network
 * retry, a client that gave up and re-sent — finds the key already present
 * and returns the ORIGINAL outcome rather than moving money twice (§65).
 */

import { newId } from './crypto';
import {
  assertHoldStateStatement,
  availableUsdSql,
  commitHoldStatements,
  createPurchaseHold,
  holdDebitTxId,
  holdSettledEventStatements,
  isConstraintAbort,
  readWalletDust,
  releaseHold,
  releaseHoldStatement,
  walletIqdAvailable,
  walletLedgerDinarsReady,
  walletSpendCents,
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

/**
 * USD cents → IQD, rounding DOWN — what a row that recorded no dinars reads as.
 *
 * ITS PARTNER IS GONE, AND WHY. `iqdToUsdCents` stood above this and rounded
 * UP «so a hold never under-reserves». It was the last ceil on a wallet path,
 * and it refused the owner's rule on the community board: a wallet showing
 * 50,000 د.ع — 3,571 cents plus the remainder its deposit recorded (0108) —
 * accepting a 50,000 د.ع offer was asked for ceil(5,000,000 / 1,400) = 3,572
 * cents and told «Your wallet balance does not cover this offer». The hold now
 * asks the dinar question and pays with `walletSpendCents` (floored, capped at
 * the cents on hand), exactly as checkout does — see `holdEscrow`.
 */
export function usdCentsToIqd(cents: number, rate: number): number {
  return Math.floor((cents * Math.max(1, rate)) / 100);
}

/**
 * The dinar pair a settlement debit records (see `commitHoldStatements`), or
 * nothing at all: only on a database that carries 0108's columns, and only
 * beside the rate the hold was actually taken at.
 */
async function settlementDinars(
  db: D1Database,
  esc: EscrowRow,
  iqd: number
): Promise<{ amountIqd: number | null; exchangeRateSnapshot: number | null }> {
  const none = { amountIqd: null, exchangeRateSnapshot: null };
  if (!(Number.isInteger(iqd) && iqd > 0) || !(await walletLedgerDinarsReady(db))) return none;
  const rate = await heldAtRate(db, esc.id);
  return rate ? { amountIqd: iqd, exchangeRateSnapshot: rate } : none;
}

/**
 * The rate an escrow's hold was taken at, read back off its own `held` event.
 *
 * `holdEscrow` has written `rate=<n>;cents=<n>` into that event's reason since
 * the first escrow, and it is the only place the hold-time rate is recorded —
 * `community_escrows` has no rate column. The settlement debit needs it to
 * record its dinars against the SAME rate its cents were computed at (0108's
 * remainder is `amount_iqd − floor(cents × rate / 100)`; today's rate would be
 * the wrong rate the day the owner moves it). No recognisable rate → null, and
 * the debit is written without dinars, exactly as before.
 */
async function heldAtRate(db: D1Database, escrowId: string): Promise<number | null> {
  const ev = await db
    .prepare("SELECT reason FROM community_escrow_events WHERE escrow_id = ? AND kind = 'held' ORDER BY created_at LIMIT 1")
    .bind(escrowId)
    .first<{ reason: string | null }>();
  const m = /(?:^|;)rate=(\d+)(?:;|$)/.exec(ev?.reason ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
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
 * The amounts every hold path checks before it touches the database. The
 * CHECK constraints would refuse a bad split anyway; failing here names the
 * real problem instead of surfacing a constraint error.
 */
function invalidHoldInput(p: HoldEscrowInput): EscrowResult | null {
  if (!(Number.isSafeInteger(p.grossIqd) && p.grossIqd > 0)) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (p.platformFeeIqd + p.merchantReceivableIqd !== p.grossIqd) {
    return { ok: false, reason: 'INVALID_AMOUNT', detail: 'fee + receivable must equal gross' };
  }
  return null;
}

/** A wallet reservation taken for an escrow that has not been recorded yet. */
export interface EscrowReservation {
  holdId: string;
  cents: number;
  rate: number;
}

export type EscrowReservationResult =
  | { ok: true; reservation: EscrowReservation }
  | { ok: false; reason: EscrowFailure; detail?: string };

/**
 * STEP ONE OF A HOLD: reserve the customer's money, and write nothing else.
 *
 * WHY IT IS ITS OWN STEP. The acceptance (worker/routes/marketplace.ts) used to
 * move the request, freeze the offer and create the order FIRST, and only then
 * ask whether the customer could pay — so a customer who could not left a
 * cancelled order behind that locked the offer for ever (audit 03 §10 A), and a
 * crash between the writes left the request in `offer_selected` with nobody to
 * move it back. Reserving first means a refusal has nothing to undo, and the
 * offer, the order and the escrow are then written together in ONE batch
 * (`escrowRecordStatements`) or not at all. A reservation whose batch never
 * commits is given back by `releaseEscrowReservation`, and one orphaned by a
 * crash is found by the community reconciliation sweep, which releases any
 * active `community_order` hold that no escrow row points at.
 */
export async function reserveEscrowFunds(db: D1Database, p: HoldEscrowInput): Promise<EscrowReservationResult> {
  const invalid = invalidHoldInput(p);
  if (invalid && !invalid.ok) return invalid;

  const rate = Math.trunc(await exchangeRate(db));
  /**
   * THE DINAR QUESTION FIRST, THEN THE CENTS — the order checkout, the store
   * cart and the membership purchase already ask it in.
   *
   * «الدينار هو الأساس»: a wallet that reads 50,000 د.ع must be able to accept a
   * 50,000 د.ع offer. The affordability test is therefore made in dinars,
   * against `walletIqdAvailable` — the one function every balance screen
   * reads — and the reservation is `walletSpendCents`: floored, and capped at
   * the cents on hand, so the hold can never ask for the cent the dinar
   * balance holds as a recorded remainder rather than as money. At least one
   * cent, because `wallet_holds` refuses a zero reservation and an escrow
   * with nothing held behind it is not an escrow.
   *
   * WHO CARRIES THE DIFFERENCE is what 0108 says for every spend: the shop, at
   * most one cent per order, out of remainders it was transferred and floored
   * away. The merchant is unaffected — they are paid `merchant_receivable_iqd`
   * in dinars from `merchant_payout_ledger`, never from these cents.
   */
  //
  // A RETRY AFTER THE HOLD BUT BEFORE THE ESCROW ROW (a crash between the two
  // writes) finds its own reservation already subtracted from the balance, so
  // it must not be re-asked the dinar question — it re-asks for the SAME cents
  // and `createPurchaseHold` replays the hold it placed.
  const holdKey = `escrow:${p.idempotencyKey}`;
  const priorHold = await db
    .prepare("SELECT amount_cents FROM wallet_holds WHERE user_id = ? AND kind = 'purchase' AND event_key = ?")
    .bind(p.customerId, holdKey)
    .first<{ amount_cents: number }>();
  let cents: number;
  if (priorHold) {
    cents = priorHold.amount_cents;
  } else {
    const [availableRow, dust] = await Promise.all([
      db.prepare(`SELECT ${availableUsdSql('?1')} AS cents`).bind(p.customerId).first<{ cents: number }>(),
      readWalletDust(db, p.customerId),
    ]);
    const availableCents = Number(availableRow?.cents) || 0;
    if (walletIqdAvailable(availableCents, dust.dust_iqd, rate) < p.grossIqd) {
      return { ok: false, reason: 'INSUFFICIENT_FUNDS', detail: 'INSUFFICIENT_AVAILABLE' };
    }
    cents = Math.max(1, walletSpendCents(p.grossIqd, availableCents, rate));
  }

  // The hold's own event key is derived from the escrow's, so a retry of this
  // whole function re-finds the same hold instead of reserving twice.
  const hold = await createPurchaseHold(db, {
    userId: p.customerId,
    amountCents: cents,
    eventKey: holdKey,
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
  return { ok: true, reservation: { holdId: hold.holdId, cents, rate } };
}

/**
 * STEP TWO: the rows that turn a reservation into an escrow — returned, not
 * run, so a caller commits them in the SAME batch as the community order they
 * belong to (`community_escrows.community_order_id` references it, so they go
 * AFTER the order's INSERT). The `held` event carries the hold-time rate and
 * cents (`rate=…;cents=…`), which is the only place that rate is recorded and
 * what every settlement reads back (`heldAtRate`).
 */
export function escrowRecordStatements(
  db: D1Database,
  p: HoldEscrowInput,
  r: EscrowReservation,
  escrowId: string,
  ts: string
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO community_escrows
           (id, community_order_id, customer_id, merchant_id, gross_iqd, platform_fee_iqd,
            merchant_receivable_iqd, state, hold_id, held_at, created_at)
         VALUES (?,?,?,?,?,?,?,'held',?,?,?)`
      )
      .bind(
        escrowId, p.communityOrderId, p.customerId, p.merchantId,
        p.grossIqd, p.platformFeeIqd, p.merchantReceivableIqd, r.holdId, ts, ts
      ),
    db
      .prepare(
        `INSERT INTO community_escrow_events
           (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
         VALUES (?,?,'held',?,?, 'customer', ?, ?, ?)`
      )
      .bind(newId('ese'), escrowId, p.grossIqd, p.customerId, `rate=${r.rate};cents=${r.cents}`, p.idempotencyKey, ts),
  ];
}

/**
 * Give back a reservation whose escrow was never recorded — a lost acceptance
 * race, an offer that changed, a batch that refused. `releaseHold` flips only
 * an ACTIVE hold, so a second call (or the reconciliation sweep reaching the
 * same hold) changes nothing.
 */
export async function releaseEscrowReservation(db: D1Database, holdId: string, reason: string) {
  return releaseHold(db, { holdId, reason });
}

/**
 * Reserve the customer's money against a community order, and record the
 * escrow over it.
 *
 * The wallet hold is taken FIRST. If the customer cannot cover it, nothing
 * is written at all — no escrow row in a half-funded state for someone to
 * find later and wonder about.
 */
export async function holdEscrow(db: D1Database, p: HoldEscrowInput): Promise<EscrowResult> {
  const invalid = invalidHoldInput(p);
  if (invalid) return invalid;

  const replay = await findEvent(db, p.idempotencyKey);
  if (replay) return { ok: true, replayed: true, escrowId: replay.escrow_id };

  const existing = await escrowForOrder(db, p.communityOrderId);
  if (existing) return { ok: false, reason: 'ALREADY_EXISTS', detail: existing.id };

  const reserved = await reserveEscrowFunds(db, p);
  if (!reserved.ok) return reserved;

  const escrowId = newId('esc');
  await db.batch(escrowRecordStatements(db, p, reserved.reservation, escrowId, NOW()));
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
  const debitDinars = await settlementDinars(db, esc, esc.gross_iqd);
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
      ...debitDinars,
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
    const debitTx = holdDebitTxId(esc.hold_id);
    const keptGross = esc.gross_iqd - amount;
    const keptReceivable = Math.max(0, Math.min(esc.merchant_receivable_iqd, keptGross));
    const debitDinars = await settlementDinars(db, esc, esc.gross_iqd);
    /**
     * THE RETURNED PART, IN THE DINARS THAT WERE RETURNED.
     *
     * It used to be `iqdToUsdCents(amount, today's rate)` — a CEIL, at a rate
     * the hold was not taken at, recording no dinars — so a customer refunded
     * 20,000 د.ع read the credit as its cents converted back (20,006 at 1,400).
     * Now the cents are floored at the HOLD's rate and the dinars ride beside
     * them (0108), so the credit reads exactly `amount`. Two bounds: at least
     * one cent (`CHECK (amount > 0)` would abort the whole refund batch on a
     * zero), and never more than the hold itself — a PARTIAL refund can never
     * give back more cents than were taken.
     */
    const rate = debitDinars.exchangeRateSnapshot ?? Math.trunc(await exchangeRate(db));
    const holdRow = await db
      .prepare('SELECT amount_cents FROM wallet_holds WHERE id = ?')
      .bind(esc.hold_id)
      .first<{ amount_cents: number }>();
    const holdCents = Number(holdRow?.amount_cents) || 0;
    const refundCents = Math.max(1, Math.min(Math.floor((amount * 100) / Math.max(1, rate)), holdCents || Number.MAX_SAFE_INTEGER));
    const refundDinars = debitDinars.exchangeRateSnapshot !== null;
    statements.push(
      ...commitHoldStatements(db, {
        holdId: esc.hold_id,
        note: 'Community order payment',
        ref: esc.community_order_id,
        ...debitDinars,
      }),
      ...(await holdSettledEventStatements(db, esc.hold_id)),
      // The returned part comes back as its own approved credit — only once
      // the full debit is posted, so the two movements always appear together.
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at${
            refundDinars ? ', amount_iqd, exchange_rate_snapshot' : ''
          })
           SELECT ?3, ?4, 'deposit', 'USD', ?5, 'approved', 'Community order partial refund', ?6, 'system', ?7${
             refundDinars ? ', ?8, ?9' : ''
           }
            WHERE ${FUNDED_BY_HOLD}`
        )
        .bind(
          ...[
            esc.hold_id, debitTx,
            `wtx_escrow_refund_${esc.id}`, esc.customer_id, refundCents, esc.community_order_id, ts,
            ...(refundDinars ? [amount, rate] : []),
          ]
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

/**
 * WHAT A MERCHANT MAY BE PAID OUT NOW, as SQL — the ONE definition, read by
 * `merchantBalance` below AND inside the payout route's conditional INSERT
 * (worker/routes/adminCommunity.ts), so the figure an admin is shown and the
 * figure the database enforces cannot drift apart. `m` is the SQL placeholder
 * (or expression) for the merchant id.
 *
 * Every `available` row PLUS every payout row, which is negative. A payout is
 * written `state = 'paid'`, so the old `SUM(state = 'available')` never went
 * down after one: the same 10,000 could be paid out again and again
 * (audit 02 B3, audit 04 B1). A reversal of a released sale is its own
 * negative `available` row, so it lowers this figure too.
 */
export const merchantAvailableSql = (m: string) =>
  `(SELECT COALESCE(SUM(CASE WHEN state = 'available' OR kind = 'payout' THEN amount_iqd ELSE 0 END), 0)
      FROM merchant_payout_ledger WHERE merchant_id = ${m})`;

/**
 * A merchant's balance: SUMs over the ledger, never a stored column.
 *
 *   · available — `merchantAvailableSql`: what may be paid out now;
 *   · pending   — sale credits waiting for the customer (or three days);
 *   · paid      — PAYOUT rows only, negative. It used to be every `paid` row,
 *     and escrow writes the platform's COMMISSION as a `paid` row, so a
 *     merchant's «Paid out» tile showed money Levonis kept (B20).
 */
export async function merchantBalance(
  db: D1Database,
  merchantId: string
): Promise<{ available_iqd: number; pending_iqd: number; paid_iqd: number }> {
  const row = await db
    .prepare(
      `SELECT ${merchantAvailableSql('?1')} AS available,
              COALESCE(SUM(CASE WHEN state = 'pending' THEN amount_iqd ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN kind = 'payout' THEN amount_iqd ELSE 0 END), 0) AS paid
         FROM merchant_payout_ledger WHERE merchant_id = ?1`
    )
    .bind(merchantId)
    .first<{ available: number; pending: number; paid: number }>();
  return {
    available_iqd: Number(row?.available) || 0,
    pending_iqd: Number(row?.pending) || 0,
    paid_iqd: Number(row?.paid) || 0,
  };
}
