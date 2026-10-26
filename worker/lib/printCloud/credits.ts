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
 * A reservation names no lot: settlement draws the account's lots in spend
 * order (expiring first, then oldest), so the first `reserved` seconds of that
 * order are the ones the open reservations hold, and only the seconds beyond
 * them are FREE (`freeSeconds`) — to convert, debit or expire.
 *
 * Every function here RETURNS statements; the caller composes them into the
 * one batch of its operation (a job confirmation reserves credits and
 * materials together, or neither).
 */
import { HttpError } from '../http';
import { fence, many, one, runBatch, type Stmt } from './db';
import { pcError } from './errors';
import { drawValue, planDraws, type LotDraw, type LotState } from './lots';
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

/** A credit lot as a plan sees it: its draw state and the expiry it carries. */
export interface CreditLotState extends LotState {
  expiresAt: string | null;
}

/** One planned draw, with the expiry of the lot it comes from (a conversion carries it on). */
export interface CreditDraw extends LotDraw {
  expiresAt: string | null;
}

/** The account's lots with seconds left, in the order they are spent: expiring first, then oldest. */
export async function spendableLots(db: D1Database, accountId: string, onlyLotId?: string): Promise<CreditLotState[]> {
  const rows = await many<CreditLotRow>(
    db,
    `SELECT id, account_id, source, seconds_total, seconds_remaining, paid_iqd, expires_at, created_at, order_line_id
       FROM pc_credit_lots
      WHERE account_id = ? AND seconds_remaining > 0 ${onlyLotId ? 'AND id = ?' : ''}
      ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, created_at, id`,
    ...(onlyLotId ? [accountId, onlyLotId] : [accountId])
  );
  return rows.map((r) => ({ id: r.id, total: Number(r.seconds_total), remaining: Number(r.seconds_remaining), value: Number(r.paid_iqd), expiresAt: r.expires_at }));
}

/**
 * Each lot's FREE seconds, for lots in spend order: the open reservations hold
 * the first `reserved` seconds of that order (settlement draws them there), so
 * a lot is free only beyond them.
 */
function freeSeconds(lots: LotState[], reserved: number): number[] {
  let held = Math.max(0, reserved);
  return lots.map((lot) => {
    const h = Math.min(lot.remaining, held);
    held -= h;
    return lot.remaining - h;
  });
}

/**
 * Draw `qty` free seconds, in spend order, skipping the held ones — and, with
 * `notExpiredAt`, every lot whose expiry has passed by then. A draw is valued
 * on the lot's real remaining count (`drawValue`): a lot's seconds are
 * fungible, only how many of them may go is limited.
 */
function planFreeDraws(lots: CreditLotState[], reserved: number, qty: number, notExpiredAt?: Date): { draws: CreditDraw[]; shortfall: number; value: number } {
  const free = freeSeconds(lots, reserved);
  const cutoff = notExpiredAt ? iso(notExpiredAt) : null;
  const draws: CreditDraw[] = [];
  let left = qty;
  let value = 0;
  lots.forEach((lot, i) => {
    if (left <= 0 || free[i] <= 0) return;
    if (cutoff !== null && lot.expiresAt !== null && lot.expiresAt <= cutoff) return;
    const k = Math.min(free[i], left);
    const v = drawValue(lot, k);
    draws.push({ lotId: lot.id, qty: k, value: v, expectedRemaining: lot.remaining, expiresAt: lot.expiresAt });
    value += v;
    left -= k;
  });
  return { draws, shortfall: Math.max(0, left), value };
}

interface AccountBalance {
  available: number;
  reserved: number;
}

async function accountBalance(db: D1Database, accountId: string): Promise<AccountBalance> {
  const a = await one<{ available_seconds: number; reserved_seconds: number }>(db, 'SELECT available_seconds, reserved_seconds FROM pc_credit_accounts WHERE id = ?', accountId);
  return { available: Number(a?.available_seconds ?? 0), reserved: Number(a?.reserved_seconds ?? 0) };
}

/**
 * The balance a free-seconds plan read is still the balance. Every draw,
 * grant, reservation and settlement moves one of the two numbers, so an
 * unchanged pair means the held prefix — and so each lot's free part — is
 * what the plan saw: a job confirmed meanwhile aborts the batch instead of
 * having its hours taken.
 */
function balanceUnchanged(db: D1Database, accountId: string, b: AccountBalance): Stmt {
  return fence(db, 'STATE_CHANGED', '(SELECT available_seconds = ? AND reserved_seconds = ? FROM pc_credit_accounts WHERE id = ?)', [b.available, b.reserved, accountId]);
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
  /** An expiry already fixed — the one converted seconds were bought under. Wins over `expiresAfterDays`. */
  expiresAt?: string | null;
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
  const expiresAt = g.expiresAt !== undefined ? g.expiresAt : g.expiresAfterDays ? iso(addSeconds(g.now, g.expiresAfterDays * 86400)) : null;
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

interface DebitInput {
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

/** The lot draws, the ledger row and the account change of one debit of the available balance. */
function debitStatements(db: D1Database, accountId: string, p: DebitInput, plan: { draws: LotDraw[]; value: number }): Stmt[] {
  return [
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
  ];
}

/**
 * Take seconds out of the AVAILABLE balance. Without `lotId` they are FREE
 * seconds, drawn in spend order past the ones confirmed jobs hold, under a
 * fence on the balance the plan read; `notExpiredAt` also leaves out every lot
 * already past its expiry. With `lotId` (a refund of that purchase) they come
 * from that lot. Either way the account CHECK refuses taking more than is
 * available, so reserved hours can never be refunded away.
 */
export async function debitAvailable(
  db: D1Database,
  p: Omit<DebitInput, 'type'> & { type: 'refund' | 'adjust_debit' | 'conversion_out'; notExpiredAt?: Date }
): Promise<{ statements: Stmt[]; value: number; draws: CreditDraw[] }> {
  if (!Number.isSafeInteger(p.seconds) || p.seconds <= 0) throw pcError('VALIDATION', { field: 'seconds' });
  const accountId = creditAccountId(p.userId, p.tierId);
  if (p.lotId) {
    const plan = planFreeDraws(await spendableLots(db, accountId, p.lotId), 0, p.seconds);
    if (plan.shortfall > 0) throw pcError('INSUFFICIENT_CREDIT');
    return { value: plan.value, draws: plan.draws, statements: debitStatements(db, accountId, p, plan) };
  }
  const balance = await accountBalance(db, accountId);
  const plan = planFreeDraws(await spendableLots(db, accountId), balance.reserved, p.seconds, p.notExpiredAt);
  if (plan.shortfall > 0) throw pcError('INSUFFICIENT_CREDIT');
  return { value: plan.value, draws: plan.draws, statements: [balanceUnchanged(db, accountId, balance), ...debitStatements(db, accountId, p, plan)] };
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
 * Only free hours not yet past their expiry move. The value of the seconds
 * taken travels with them, so the converted hours are recognised at what the
 * customer actually paid — and so does their EXPIRY: an hour bought under a
 * package that expires still expires, on the same date, in the new tier.
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
    notExpiredAt: p.now,
  });
  // One new lot per expiry among the drawn lots (spend order keeps equal
  // expiries together), with that absolute date and the value of its draws.
  const groups: Array<{ expiresAt: string | null; drawn: number; value: number }> = [];
  for (const d of out.draws) {
    const last = groups[groups.length - 1];
    if (last && last.expiresAt === d.expiresAt) {
      last.drawn += d.qty;
      last.value += d.value;
    } else groups.push({ expiresAt: d.expiresAt, drawn: d.qty, value: d.value });
  }
  // The received seconds are shared cumulatively, so the lots sum to exactly
  // `received`; a group too small for a whole second hands its value on.
  const lots: Array<{ expiresAt: string | null; seconds: number; value: number }> = [];
  let drawn = 0;
  let given = 0;
  let pending = 0;
  for (const g of groups) {
    drawn += g.drawn;
    const seconds = mulDivFloor(drawn, p.rule.ratio_num, p.rule.ratio_den) - given;
    given += seconds;
    if (seconds > 0) {
      lots.push({ expiresAt: g.expiresAt, seconds, value: g.value + pending });
      pending = 0;
    } else if (lots.length) lots[lots.length - 1].value += g.value;
    else pending += g.value;
  }
  const statements = [...out.statements];
  lots.forEach((l, i) => {
    statements.push(
      ...grantCredits(db, {
        userId: p.userId,
        tierId: p.rule.to_tier_id,
        seconds: l.seconds,
        paidIqd: l.value,
        source: 'conversion',
        expiresAt: l.expiresAt,
        // '#' cannot occur in an Idempotency-Key (db.ts KEY_RE), so a group's key never equals another conversion's.
        entryKey: i === 0 ? `conversion_in:${p.opKey}` : `conversion_in:${p.opKey}#${i}`,
        actorId: p.actorId,
        note: `rule ${p.rule.id}`,
        now: p.now,
      }).statements
    );
  });
  return { statements, receivedSeconds: received, value: out.value };
}

/**
 * Lots whose configured expiry has passed and still hold seconds (only ever
 * set by an explicit package rule), earliest expiry first — only from accounts
 * where some of those seconds are FREE. Expired lots come first in spend
 * order, so the open reservations hold them first: an account has expired
 * seconds to take exactly when they add up to more than it has reserved (and
 * it has any available). A lot wholly held for jobs therefore never fills the
 * page ahead of lots that can expire.
 */
export async function expiredLots(
  db: D1Database,
  now: Date,
  limit = 50,
  accountId?: string
): Promise<Array<CreditLotRow & { user_id: string; tier_id: string }>> {
  return many(
    db,
    `SELECT l.id, l.account_id, l.user_id, l.tier_id, l.source, l.seconds_total, l.seconds_remaining, l.paid_iqd, l.expires_at, l.created_at, l.order_line_id
       FROM pc_credit_lots l JOIN pc_credit_accounts a ON a.id = l.account_id
      WHERE l.expires_at IS NOT NULL AND l.expires_at <= ?1 AND l.seconds_remaining > 0 AND a.available_seconds > 0
        ${accountId ? 'AND a.id = ?3' : ''}
        AND (SELECT COALESCE(SUM(x.seconds_remaining), 0) FROM pc_credit_lots x
              WHERE x.account_id = a.id AND x.expires_at IS NOT NULL AND x.expires_at <= ?1 AND x.seconds_remaining > 0) > a.reserved_seconds
      ORDER BY l.expires_at, l.id LIMIT ?2`,
    ...(accountId ? [iso(now), limit, accountId] : [iso(now), limit])
  );
}

/**
 * Expire, now, every free expired second of one customer's tier — before a
 * confirmation reserves hours. Reservations hold the expiring lots first, so
 * a job confirmed after a lot's expiry but before the sweep would otherwise
 * shield the seconds that should have gone and spend them. Each lot is its
 * own batch, exactly as the sweep would run it; a pass a concurrent runner
 * already made is simply skipped.
 */
export async function expireDueCredits(db: D1Database, userId: string, tierId: string, now: Date): Promise<number> {
  let expired = 0;
  for (const lot of await expiredLots(db, now, 50, creditAccountId(userId, tierId))) {
    const planned = await planLotExpiry(db, lot, now);
    if (!planned) continue;
    try {
      await runBatch(db, planned.statements);
      expired += planned.seconds;
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'STATE_CHANGED')) throw e;
    }
  }
  return expired;
}

/**
 * Expire the FREE part of one lot whose expiry has passed (§3.2): seconds the
 * open reservations hold stay for their jobs, and what a job gives back later
 * expires on a later run. Null when nothing of the lot is free now.
 *
 * A lot can therefore expire in several passes. Each is keyed by the seconds
 * the lot held before it — they only ever go down — so a later pass has a key
 * of its own, while two runners planning the same pass still collide.
 */
export async function planLotExpiry(
  db: D1Database,
  lot: Pick<CreditLotRow, 'id' | 'account_id' | 'expires_at'> & { user_id: string; tier_id: string },
  now: Date
): Promise<{ seconds: number; statements: Stmt[] } | null> {
  const balance = await accountBalance(db, lot.account_id);
  const lots = await spendableLots(db, lot.account_id);
  const at = lots.findIndex((l) => l.id === lot.id);
  if (at < 0) return null;
  const seconds = Math.min(freeSeconds(lots, balance.reserved)[at], balance.available);
  if (seconds <= 0) return null;
  const target = lots[at];
  const draw: LotDraw = { lotId: target.id, qty: seconds, value: drawValue(target, seconds), expectedRemaining: target.remaining };
  const p: DebitInput = {
    userId: lot.user_id,
    tierId: lot.tier_id,
    seconds,
    type: 'expire',
    entryKey: `expire:${target.id}:${target.remaining}`,
    lotId: target.id,
    actorId: 'system',
    note: `package expiry ${lot.expires_at}`,
    now,
  };
  return { seconds, statements: [balanceUnchanged(db, lot.account_id, balance), ...debitStatements(db, lot.account_id, p, { draws: [draw], value: draw.value })] };
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
