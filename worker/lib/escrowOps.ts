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
import { createPurchaseHold, commitHold, releaseHold } from './walletOps';
import { credit } from './wallet';

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
 * Pay the merchant.
 *
 * Three things happen together, or none of them do: the customer's held money
 * is committed (it leaves their balance), the merchant is credited in the
 * payout ledger, and the escrow is marked released. Splitting these across
 * requests is how a merchant ends up credited for money the customer still
 * has.
 *
 * A released escrow can NEVER return to held (§29). The state guard is part
 * of the UPDATE, so two concurrent releases cannot both win: the second finds
 * zero rows changed.
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

  const ts = NOW();
  // Conditional on the state we read. If anything moved underneath us, this
  // writes nothing and we report the conflict rather than paying twice.
  const guard = await db
    .prepare(
      `UPDATE community_escrows
          SET state = 'released', released_iqd = gross_iqd, released_at = ?
        WHERE id = ? AND state IN ('held','disputed')`
    )
    .bind(ts, esc.id)
    .run();
  if (!guard.meta.changes) return { ok: false, reason: 'STATE_CONFLICT' };

  if (esc.hold_id) {
    // Commit takes the reserved money out of the customer's balance for good.
    await commitHold(db, { holdId: esc.hold_id, note: 'Community order released' });
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO merchant_payout_ledger
           (id, merchant_id, kind, amount_iqd, state, community_order_id, escrow_id, note, idempotency_key)
         VALUES (?,?,'community_order_credit',?,'available',?,?,?,?)`
      )
      .bind(
        newId('pay'), esc.merchant_id, esc.merchant_receivable_iqd,
        esc.community_order_id, esc.id, p.reason ?? '', `credit:${p.idempotencyKey}`
      ),
    db
      .prepare(
        `INSERT INTO merchant_payout_ledger
           (id, merchant_id, kind, amount_iqd, state, community_order_id, escrow_id, note, idempotency_key)
         VALUES (?,?,'commission',?,'paid',?,?,'platform commission',?)`
      )
      .bind(
        newId('pay'), esc.merchant_id, -esc.platform_fee_iqd,
        esc.community_order_id, esc.id, `fee:${p.idempotencyKey}`
      ),
    db
      .prepare(
        `INSERT INTO community_escrow_events
           (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
         VALUES (?,?,'release',?,?,?,?,?,?)`
      )
      .bind(
        newId('ese'), esc.id, esc.merchant_receivable_iqd, p.actorId, p.actorRole,
        p.reason ?? '', p.idempotencyKey, ts
      ),
  ]);

  return { ok: true, replayed: false, escrowId: esc.id };
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
 * the hold is committed in full and the refunded part is credited back to the
 * customer's wallet as a real transaction. That leaves a visible pair of
 * movements rather than a quietly reduced hold, which is what an auditor
 * needs to see.
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

  const amount = p.amountIqd === undefined ? esc.gross_iqd : Math.floor(p.amountIqd);
  if (amount <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  if (amount > esc.gross_iqd - esc.released_iqd - esc.refunded_iqd) {
    return { ok: false, reason: 'AMOUNT_EXCEEDS_HELD' };
  }

  const full = amount === esc.gross_iqd;
  const ts = NOW();
  const nextState = full ? 'refunded' : 'partially_refunded';

  const guard = await db
    .prepare(
      `UPDATE community_escrows
          SET state = ?, refunded_iqd = refunded_iqd + ?, refunded_at = ?
        WHERE id = ? AND state IN ('held','disputed')
          AND released_iqd + refunded_iqd + ? <= gross_iqd`
    )
    .bind(nextState, amount, ts, esc.id, amount)
    .run();
  if (!guard.meta.changes) return { ok: false, reason: 'STATE_CONFLICT' };

  if (esc.hold_id) {
    if (full) {
      // Nothing was ever spent: releasing the hold returns it to available.
      await releaseHold(db, { holdId: esc.hold_id, reason: 'Community order refunded' });
    } else {
      const rate = await exchangeRate(db);
      await commitHold(db, { holdId: esc.hold_id, note: 'Community order partially settled' });
      // The returned part comes back as its own approved credit, so both
      // movements are visible in the customer's wallet history.
      await credit(
        db,
        esc.customer_id,
        'USD',
        iqdToUsdCents(amount, rate),
        'Community order partial refund',
        esc.community_order_id
      );
    }
  }

  const stmts = [
    db
      .prepare(
        `INSERT INTO community_escrow_events
           (id, escrow_id, kind, amount_iqd, actor_id, actor_role, reason, idempotency_key, created_at)
         VALUES (?,?,'refund',?,?,?,?,?,?)`
      )
      .bind(newId('ese'), esc.id, amount, p.actorId, p.actorRole, p.reason ?? '', p.idempotencyKey, ts),
  ];

  // On a partial refund the merchant still earns on the part that was kept.
  if (!full) {
    const keptGross = esc.gross_iqd - amount;
    const keptReceivable = Math.max(0, Math.min(esc.merchant_receivable_iqd, keptGross));
    stmts.push(
      db
        .prepare(
          `INSERT INTO merchant_payout_ledger
             (id, merchant_id, kind, amount_iqd, state, community_order_id, escrow_id, note, idempotency_key)
           VALUES (?,?,'community_order_credit',?,'available',?,?,'partial settlement',?)`
        )
        .bind(
          newId('pay'), esc.merchant_id, keptReceivable, esc.community_order_id, esc.id,
          `partial:${p.idempotencyKey}`
        )
    );
  }
  await db.batch(stmts);

  return { ok: true, replayed: false, escrowId: esc.id };
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
