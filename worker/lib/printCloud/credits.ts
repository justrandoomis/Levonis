/**
 * THE PRINTING CREDIT WALLET (docs/PRINT_CLOUD.md §3).
 *
 * Time is integer SECONDS. A customer holds one account per credit tier
 * (printer pricing category); hours bought for one tier are never spent on
 * another unless an enabled conversion rule moves them, at the customer's
 * request, as a visible ledger pair.
 *
 *   available — spendable now
 *   reserved  — held for confirmed jobs, not yet printed
 *   consumed  — printed and billed (lifetime)
 *
 * The account row is a CACHE of `pc_credit_ledger`: every change to it is
 * written in the same batch as the ledger row that explains it, both columns
 * carry named CHECKs (no negative balance can commit), and reconciliation
 * proves the cache equals the ledger sum. Lots record what each second was
 * bought for, so a consumed second is valued at its own purchase price.
 *
 * Every function here RETURNS statements; the caller composes them into the
 * one batch of its operation (a job confirmation reserves credits and
 * materials together, or neither).
 */
import { fence, many, one, type Stmt } from './db';
import { pcError } from './errors';
import { planDraws, type LotDraw, type LotState } from './lots';
import { addSeconds, iso, mulDivFloor, pcId } from './util';

export const creditAccountId = (userId: string, tierId: string): string => `pcca_${userId}__${tierId}`;

export interface CreditAccountRow {
  id: string;
  user_id: string;
  tier_id: string;
  available_seconds: number;
  reserved_seconds: number;
  consumed_seconds: number;
}

export interface CreditLotRow {
  id: string;
  account_id: string;
  source: string;
  seconds_total: number;
  seconds_remaining: number;
  paid_iqd: number;
  expires_at: string | null;
  created_at: string;
  order_line_id: string | null;
}

export interface CreditReservationRow {
  id: string;
  account_id: string;
  user_id: string;
  tier_id: string;
  job_id: string;
  seconds_reserved: number;
  seconds_consumed: number;
  seconds_released: number;
  state: 'active' | 'settled' | 'released';
}

export type CreditEntryType =
  | 'purchase'
  | 'reserve'
  | 'release'
  | 'consume'
  | 'refund'
  | 'adjust_credit'
  | 'adjust_debit'
  | 'conversion_in'
  | 'conversion_out'
  | 'expire'
  | 'compensation';

interface LedgerEntry {
  entryKey: string;
  accountId: string;
  userId: string;
  tierId: string;
  type: CreditEntryType;
  dAvailable: number;
  dReserved: number;
  dConsumed: number;
  lotId?: string | null;
  reservationId?: string | null;
  jobId?: string | null;
  orderId?: string | null;
  value?: number;
  actorId: string;
  note?: string;
  now: Date;
}

function ledgerStmt(db: D1Database, e: LedgerEntry): Stmt {
  return db
    .prepare(
      `INSERT INTO pc_credit_ledger (id, entry_key, account_id, user_id, tier_id, entry_type, delta_available, delta_reserved,
         delta_consumed, lot_id, reservation_id, job_id, order_id, value_iqd, actor_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      pcId('pccl'),
      e.entryKey,
      e.accountId,
      e.userId,
      e.tierId,
      e.type,
      e.dAvailable,
      e.dReserved,
      e.dConsumed,
      e.lotId ?? null,
      e.reservationId ?? null,
      e.jobId ?? null,
      e.orderId ?? null,
      e.value ?? 0,
      e.actorId,
      (e.note ?? '').slice(0, 500),
      iso(e.now)
    );
}

function accountDelta(db: D1Database, accountId: string, dAvailable: number, dReserved: number, dConsumed: number, now: Date): Stmt {
  return db
    .prepare(
      `UPDATE pc_credit_accounts
          SET available_seconds = available_seconds + ?, reserved_seconds = reserved_seconds + ?,
              consumed_seconds = consumed_seconds + ?, updated_at = ?
        WHERE id = ?`
    )
    .bind(dAvailable, dReserved, dConsumed, iso(now), accountId);
}

/** Creates the account if it is missing; a no-op when it exists. */
export function ensureCreditAccount(db: D1Database, userId: string, tierId: string, now: Date): Stmt {
  return db
    .prepare('INSERT OR IGNORE INTO pc_credit_accounts (id, user_id, tier_id, updated_at) VALUES (?, ?, ?, ?)')
    .bind(creditAccountId(userId, tierId), userId, tierId, iso(now));
}

function drawStatements(db: D1Database, draws: LotDraw[], entryKey: string, now: Date): Stmt[] {
  const out: Stmt[] = [];
  for (const d of draws) {
    out.push(fence(db, 'STATE_CHANGED', '(SELECT seconds_remaining FROM pc_credit_lots WHERE id = ?) = ?', [d.lotId, d.expectedRemaining]));
    out.push(db.prepare('UPDATE pc_credit_lots SET seconds_remaining = seconds_remaining - ? WHERE id = ?').bind(d.qty, d.lotId));
    out.push(
      db
        .prepare('INSERT INTO pc_credit_lot_draws (id, lot_id, ledger_entry_key, seconds, value_iqd, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(pcId('pcld'), d.lotId, entryKey, d.qty, d.value, iso(now))
    );
  }
  return out;
}

/** The account's lots with seconds left, in the order they are spent: expiring first, then oldest. */
export async function spendableLots(db: D1Database, accountId: string, onlyLotId?: string): Promise<LotState[]> {
  const rows = await many<CreditLotRow>(
    db,
    `SELECT id, account_id, source, seconds_total, seconds_remaining, paid_iqd, expires_at, created_at, order_line_id
       FROM pc_credit_lots
      WHERE account_id = ? AND seconds_remaining > 0 ${onlyLotId ? 'AND id = ?' : ''}
      ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, created_at, id`,
    ...(onlyLotId ? [accountId, onlyLotId] : [accountId])
  );
  return rows.map((r) => ({ id: r.id, total: Number(r.seconds_total), remaining: Number(r.seconds_remaining), value: Number(r.paid_iqd) }));
}

// ------------------------------------------------------------------ grant

export interface GrantInput {
  userId: string;
  tierId: string;
  seconds: number;
  paidIqd: number;
  source: 'purchase' | 'adjustment' | 'compensation' | 'conversion';
  orderLineId?: string | null;
  orderId?: string | null;
  expiresAfterDays?: number | null;
  entryKey: string;
  actorId: string;
  note?: string;
  now: Date;
}

/** New seconds in a new lot. `entryKey` names the event (an order line, a compensation), so a replay collides. */
export function grantCredits(db: D1Database, g: GrantInput): { lotId: string; statements: Stmt[] } {
  if (!Number.isSafeInteger(g.seconds) || g.seconds <= 0) throw pcError('VALIDATION', { field: 'seconds' });
  const accountId = creditAccountId(g.userId, g.tierId);
  const lotId = pcId('pclot');
  const expiresAt = g.expiresAfterDays ? iso(addSeconds(g.now, g.expiresAfterDays * 86400)) : null;
  const type: CreditEntryType = g.source === 'purchase' ? 'purchase' : g.source === 'conversion' ? 'conversion_in' : g.source === 'compensation' ? 'compensation' : 'adjust_credit';
  return {
    lotId,
    statements: [
      ensureCreditAccount(db, g.userId, g.tierId, g.now),
      db
        .prepare(
          `INSERT INTO pc_credit_lots (id, account_id, user_id, tier_id, source, order_line_id, seconds_total, seconds_remaining,
             paid_iqd, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(lotId, accountId, g.userId, g.tierId, g.source, g.orderLineId ?? null, g.seconds, g.seconds, g.paidIqd, expiresAt, iso(g.now)),
      ledgerStmt(db, {
        entryKey: g.entryKey,
        accountId,
        userId: g.userId,
        tierId: g.tierId,
        type,
        dAvailable: g.seconds,
        dReserved: 0,
        dConsumed: 0,
        lotId,
        orderId: g.orderId ?? null,
        value: g.paidIqd,
        actorId: g.actorId,
        note: g.note,
        now: g.now,
      }),
      accountDelta(db, accountId, g.seconds, 0, 0, g.now),
    ],
  };
}

// ------------------------------------------------------------------ reserve / release

export interface ReserveInput {
  userId: string;
  tierId: string;
  jobId: string;
  seconds: number;
  actorId: string;
  now: Date;
}

/**
 * Hold `seconds` for a job. The account UPDATE moves available → reserved;
 * ck_pc_credit_available aborts the batch when available would go negative,
 * so two jobs racing for the same last hours cannot both reserve them.
 */
export function reserveCredits(db: D1Database, r: ReserveInput): { reservationId: string; statements: Stmt[] } {
  if (!Number.isSafeInteger(r.seconds) || r.seconds <= 0) throw pcError('VALIDATION', { field: 'seconds' });
  const accountId = creditAccountId(r.userId, r.tierId);
  const reservationId = pcId('pccr');
  return {
    reservationId,
    statements: [
      ensureCreditAccount(db, r.userId, r.tierId, r.now),
      accountDelta(db, accountId, -r.seconds, r.seconds, 0, r.now),
      db
        .prepare(
          `INSERT INTO pc_credit_reservations (id, account_id, user_id, tier_id, job_id, seconds_reserved, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
        )
        .bind(reservationId, accountId, r.userId, r.tierId, r.jobId, r.seconds, iso(r.now)),
      ledgerStmt(db, {
        entryKey: `reserve:${reservationId}`,
        accountId,
        userId: r.userId,
        tierId: r.tierId,
        type: 'reserve',
        dAvailable: -r.seconds,
        dReserved: r.seconds,
        dConsumed: 0,
        reservationId,
        jobId: r.jobId,
        actorId: r.actorId,
        now: r.now,
      }),
    ],
  };
}

/** The flip every settlement and release starts with, and the fence that it really happened in THIS batch. */
function closeReservation(db: D1Database, res: CreditReservationRow, state: 'settled' | 'released', consumed: number, released: number, now: Date): Stmt[] {
  const token = pcId('tok');
  return [
    db
      .prepare(
        `UPDATE pc_credit_reservations
            SET state = ?, seconds_consumed = ?, seconds_released = ?, settled_at = ?, op_token = ?
          WHERE id = ? AND state = 'active'`
      )
      .bind(state, consumed, released, iso(now), token, res.id),
    fence(db, 'STATE_CHANGED', '(SELECT op_token FROM pc_credit_reservations WHERE id = ?) = ?', [res.id, token]),
  ];
}

/** Give a whole active reservation back (a cancelled job, a job that never ran). Exactly once: the flip is fenced. */
export function releaseCredits(db: D1Database, res: CreditReservationRow, actorId: string, now: Date, note = ''): Stmt[] {
  if (res.state !== 'active') throw pcError('STATE_CHANGED');
  return [
    ...closeReservation(db, res, 'released', 0, res.seconds_reserved, now),
    accountDelta(db, res.account_id, res.seconds_reserved, -res.seconds_reserved, 0, now),
    ledgerStmt(db, {
      entryKey: `release:${res.id}`,
      accountId: res.account_id,
      userId: res.user_id,
      tierId: res.tier_id,
      type: 'release',
      dAvailable: res.seconds_reserved,
      dReserved: -res.seconds_reserved,
      dConsumed: 0,
      reservationId: res.id,
      jobId: res.job_id,
      actorId,
      note,
      now,
    }),
  ];
}

export interface SettleOutcome {
  statements: Stmt[];
  /** Seconds billed out of the reservation. */
  consumedFromReservation: number;
  /** Seconds billed beyond it, from the available balance (policy 'charge_from_balance'). */
  overage: number;
  /** Seconds given back. */
  released: number;
  /** Seconds actually used that were not billed (policy cap, or no balance left). */
  unbilled: number;
  /** The purchase value of the billed seconds (revenue recognised). */
  value: number;
}

/**
 * Settle a reservation against what the job actually used.
 *
 *   billed from the reservation = min(actual, reserved)
 *   released                    = reserved − that
 *   overage                     = actual − reserved, billed from the
 *                                 available balance only under
 *                                 'charge_from_balance', and never beyond it
 *
 * The billed seconds are drawn from the account's lots (expiring first, then
 * oldest), and each draw records the value it carried.
 */
export async function settleCredits(
  db: D1Database,
  res: CreditReservationRow,
  actualSeconds: number,
  policy: 'cap_at_reserved' | 'charge_from_balance',
  actorId: string,
  now: Date,
  note = ''
): Promise<SettleOutcome> {
  if (res.state !== 'active') throw pcError('STATE_CHANGED');
  if (!Number.isSafeInteger(actualSeconds) || actualSeconds < 0) throw pcError('VALIDATION', { field: 'seconds' });
  const fromReservation = Math.min(actualSeconds, res.seconds_reserved);
  const released = res.seconds_reserved - fromReservation;
  let overage = 0;
  if (actualSeconds > res.seconds_reserved && policy === 'charge_from_balance') {
    const acct = await one<{ available_seconds: number }>(db, 'SELECT available_seconds FROM pc_credit_accounts WHERE id = ?', res.account_id);
    // The released remainder is zero here (actual > reserved), so what is
    // available is exactly the balance outside this job.
    overage = Math.min(actualSeconds - res.seconds_reserved, Number(acct?.available_seconds ?? 0));
  }
  const unbilled = actualSeconds - fromReservation - overage;
  const billed = fromReservation + overage;
  const statements: Stmt[] = [...closeReservation(db, res, 'settled', fromReservation, released, now)];
  let value = 0;
  if (billed > 0) {
    const plan = planDraws(await spendableLots(db, res.account_id), billed);
    if (plan.shortfall > 0) throw pcError('STATE_CHANGED', { reason: 'lots_do_not_cover_balance' });
    value = plan.value;
    const key = `consume:${res.id}`;
    statements.push(...drawStatements(db, plan.draws, key, now));
    statements.push(
      ledgerStmt(db, {
        entryKey: key,
        accountId: res.account_id,
        userId: res.user_id,
        tierId: res.tier_id,
        type: 'consume',
        dAvailable: -overage,
        dReserved: -fromReservation,
        dConsumed: billed,
        reservationId: res.id,
        jobId: res.job_id,
        value,
        actorId,
        note: overage ? `${note} (overage ${overage}s from balance)`.trim() : note,
        now,
      })
    );
  }
  if (released > 0) {
    statements.push(
      ledgerStmt(db, {
        entryKey: `release:${res.id}`,
        accountId: res.account_id,
        userId: res.user_id,
        tierId: res.tier_id,
        type: 'release',
        dAvailable: released,
        dReserved: -released,
        dConsumed: 0,
        reservationId: res.id,
        jobId: res.job_id,
        actorId,
        now,
      })
    );
  }
  statements.push(accountDelta(db, res.account_id, released - overage, -res.seconds_reserved, billed, now));
  return { statements, consumedFromReservation: fromReservation, overage, released, unbilled, value };
}

// ------------------------------------------------------------------ adjustments, refunds, conversion, expiry

/**
 * Take seconds out of the AVAILABLE balance, drawn from lots (FIFO, or one
 * named lot for a refund of that purchase). The account CHECK refuses taking
 * more than is available, so reserved hours can never be refunded away.
 */
export async function debitAvailable(
  db: D1Database,
  p: {
    userId: string;
    tierId: string;
    seconds: number;
    type: 'refund' | 'adjust_debit' | 'conversion_out' | 'expire';
    entryKey: string;
    lotId?: string;
    orderId?: string | null;
    actorId: string;
    note?: string;
    now: Date;
  }
): Promise<{ statements: Stmt[]; value: number }> {
  if (!Number.isSafeInteger(p.seconds) || p.seconds <= 0) throw pcError('VALIDATION', { field: 'seconds' });
  const accountId = creditAccountId(p.userId, p.tierId);
  const plan = planDraws(await spendableLots(db, accountId, p.lotId), p.seconds);
  if (plan.shortfall > 0) throw pcError('INSUFFICIENT_CREDIT');
  return {
    value: plan.value,
    statements: [
      ...drawStatements(db, plan.draws, p.entryKey, p.now),
      ledgerStmt(db, {
        entryKey: p.entryKey,
        accountId,
        userId: p.userId,
        tierId: p.tierId,
        type: p.type,
        dAvailable: -p.seconds,
        dReserved: 0,
        dConsumed: 0,
        lotId: p.lotId ?? null,
        orderId: p.orderId ?? null,
        value: plan.value,
        actorId: p.actorId,
        note: p.note,
        now: p.now,
      }),
      accountDelta(db, accountId, -p.seconds, 0, 0, p.now),
    ],
  };
}

export interface ConversionRule {
  id: string;
  from_tier_id: string;
  to_tier_id: string;
  ratio_num: number;
  ratio_den: number;
  enabled: number;
}

/**
 * Move hours between tiers under an ENABLED rule, at the customer's request.
 * The value of the seconds taken travels with them into the new lot, so the
 * converted hours are recognised at what the customer actually paid.
 */
export async function convertCredits(
  db: D1Database,
  p: { userId: string; rule: ConversionRule; seconds: number; opKey: string; actorId: string; now: Date }
): Promise<{ statements: Stmt[]; receivedSeconds: number; value: number }> {
  if (!p.rule.enabled) throw pcError('CONVERSION_DISABLED');
  const received = mulDivFloor(p.seconds, p.rule.ratio_num, p.rule.ratio_den);
  if (received <= 0) throw pcError('QUANTITY_NOT_ALLOWED', { field: 'seconds' });
  const out = await debitAvailable(db, {
    userId: p.userId,
    tierId: p.rule.from_tier_id,
    seconds: p.seconds,
    type: 'conversion_out',
    entryKey: `conversion_out:${p.opKey}`,
    actorId: p.actorId,
    note: `rule ${p.rule.id}`,
    now: p.now,
  });
  const into = grantCredits(db, {
    userId: p.userId,
    tierId: p.rule.to_tier_id,
    seconds: received,
    paidIqd: out.value,
    source: 'conversion',
    entryKey: `conversion_in:${p.opKey}`,
    actorId: p.actorId,
    note: `rule ${p.rule.id}`,
    now: p.now,
  });
  return { statements: [...out.statements, ...into.statements], receivedSeconds: received, value: out.value };
}

/** Lots whose configured expiry has passed and still hold seconds (only ever set by an explicit package rule). */
export async function expiredLots(db: D1Database, now: Date, limit = 50): Promise<Array<CreditLotRow & { user_id: string; tier_id: string }>> {
  return many(
    db,
    `SELECT id, account_id, user_id, tier_id, source, seconds_total, seconds_remaining, paid_iqd, expires_at, created_at, order_line_id
       FROM pc_credit_lots WHERE expires_at IS NOT NULL AND expires_at <= ? AND seconds_remaining > 0
      ORDER BY expires_at LIMIT ?`,
    iso(now),
    limit
  );
}

// ------------------------------------------------------------------ reads

export async function creditBalances(db: D1Database, userId: string) {
  const rows = await many<CreditAccountRow & { code: string; name_ar: string; name_en: string; name_ckb: string }>(
    db,
    `SELECT a.id, a.user_id, a.tier_id, a.available_seconds, a.reserved_seconds, a.consumed_seconds,
            t.code, t.name_ar, t.name_en, t.name_ckb
       FROM pc_credit_accounts a JOIN pc_credit_tiers t ON t.id = a.tier_id
      WHERE a.user_id = ? ORDER BY t.code`,
    userId
  );
  return rows;
}

export async function activeReservationForJob(db: D1Database, jobId: string): Promise<CreditReservationRow | null> {
  return one<CreditReservationRow>(
    db,
    `SELECT id, account_id, user_id, tier_id, job_id, seconds_reserved, seconds_consumed, seconds_released, state
       FROM pc_credit_reservations WHERE job_id = ? AND state = 'active'`,
    jobId
  );
}
