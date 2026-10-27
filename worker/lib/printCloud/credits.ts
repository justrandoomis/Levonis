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
 * HOLDS ARE RECORDED, PER LOT. A reservation names the lots it holds
 * (`pc_credit_reservation_lots`) and each lot carries the seconds held on it
 * (`seconds_held`, never more than it has left — ck_pc_credit_lot_held). A
 * lot's FREE part is `seconds_remaining - seconds_held`: the only seconds a
 * debit, a conversion or an expiry may take. So, always:
 *
 *   available = Σ free parts of the account's lots
 *   reserved  = Σ seconds held on them = Σ active reservations' hold rows
 *
 * and reconciliation proves each. A reservation spends only what it held, so
 * which seconds a job holds is never inferred from an order of lots.
 *
 * EXPIRY. A lot whose expiry has come is held by nobody new (a free reprint
 * inheriting what its failed parent held is the one exception) and drawn by
 * no debit; the sweep takes its free part, and a hold given back later
 * becomes free and goes on a later run.
 *
 * Every function here RETURNS statements; the caller composes them into the
 * one batch of its operation (a job confirmation reserves credits and
 * materials together, or neither).
 */
import { fence, many, one, type Stmt } from './db';
import { pcError } from './errors';
import { drawValue, type LotDraw, type LotState } from './lots';
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
  seconds_held: number;
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

/** A draw the batch fences on the lot's holds too: an expiry, which takes exactly the free part the plan read. */
type FencedDraw = LotDraw & { expectedHeld?: number };

function drawStatements(db: D1Database, draws: FencedDraw[], entryKey: string, now: Date): Stmt[] {
  const out: Stmt[] = [];
  for (const d of draws) {
    out.push(
      d.expectedHeld === undefined
        ? fence(db, 'STATE_CHANGED', '(SELECT seconds_remaining FROM pc_credit_lots WHERE id = ?) = ?', [d.lotId, d.expectedRemaining])
        : fence(db, 'STATE_CHANGED', '(SELECT seconds_remaining = ? AND seconds_held = ? FROM pc_credit_lots WHERE id = ?)', [d.expectedRemaining, d.expectedHeld, d.lotId])
    );
    out.push(db.prepare('UPDATE pc_credit_lots SET seconds_remaining = seconds_remaining - ? WHERE id = ?').bind(d.qty, d.lotId));
    out.push(
      db
        .prepare('INSERT INTO pc_credit_lot_draws (id, lot_id, ledger_entry_key, seconds, value_iqd, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(pcId('pcld'), d.lotId, entryKey, d.qty, d.value, iso(now))
    );
  }
  return out;
}

/** A credit lot as a plan sees it: its draw state, the seconds held on it and the expiry it carries. */
export interface CreditLotState extends LotState {
  held: number;
  expiresAt: string | null;
}

/** One planned draw, with the expiry of the lot it comes from (a conversion carries it on). */
export interface CreditDraw extends LotDraw {
  expiresAt: string | null;
}

/** Seconds of one lot: a reservation's hold on it, or a reprint's inheritance of one. */
export interface LotShare {
  lotId: string;
  seconds: number;
}

/** The account's lots with seconds left (or only `onlyLotId`), in the order they are spent: expiring first, then oldest. */
async function accountLots(db: D1Database, accountId: string, onlyLotId?: string): Promise<CreditLotState[]> {
  const rows = await many<CreditLotRow>(
    db,
    `SELECT id, account_id, source, seconds_total, seconds_remaining, seconds_held, paid_iqd, expires_at, created_at, order_line_id
       FROM pc_credit_lots
      WHERE account_id = ? AND seconds_remaining > 0 ${onlyLotId ? 'AND id = ?' : ''}
      ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, created_at, id`,
    ...(onlyLotId ? [accountId, onlyLotId] : [accountId])
  );
  return rows.map((r) => ({
    id: r.id,
    total: Number(r.seconds_total),
    remaining: Number(r.seconds_remaining),
    held: Number(r.seconds_held),
    value: Number(r.paid_iqd),
    expiresAt: r.expires_at,
  }));
}

/** A lot's FREE part: what it has left beyond the seconds confirmed jobs hold on it. */
const freePart = (lot: CreditLotState): number => lot.remaining - lot.held;

/** Not yet past its expiry at `cutoff` (an ISO instant). */
const goodAt = (lot: { expiresAt: string | null }, cutoff: string): boolean => lot.expiresAt === null || lot.expiresAt > cutoff;

/**
 * The seconds of one lot a debit may take at `now` (a refund of the purchase
 * that bought it): its free part, and nothing once its expiry has come — what
 * is left of it then is the sweep's, or the jobs' that hold it.
 */
export function freeSecondsAt(lot: Pick<CreditLotRow, 'seconds_remaining' | 'seconds_held' | 'expires_at'>, now: Date): number {
  if (!goodAt({ expiresAt: lot.expires_at }, iso(now))) return 0;
  return Math.max(0, Number(lot.seconds_remaining) - Number(lot.seconds_held));
}

/**
 * Draw `qty` FREE seconds of lots not yet past their expiry at `now`, in the
 * order given. A draw is valued on the lot's real remaining count
 * (`drawValue`): a lot's seconds are fungible, only how many of them may go
 * is limited.
 */
function planFreeDraws(lots: CreditLotState[], qty: number, now: Date): { draws: CreditDraw[]; shortfall: number; value: number } {
  const cutoff = iso(now);
  const draws: CreditDraw[] = [];
  let left = qty;
  let value = 0;
  for (const lot of lots) {
    if (left <= 0) break;
    if (freePart(lot) <= 0 || !goodAt(lot, cutoff)) continue;
    const k = Math.min(freePart(lot), left);
    const v = drawValue(lot, k);
    draws.push({ lotId: lot.id, qty: k, value: v, expectedRemaining: lot.remaining, expiresAt: lot.expiresAt });
    value += v;
    left -= k;
  }
  return { draws, shortfall: Math.max(0, left), value };
}

/** A reservation's holds, in the order it took them: the order its settlement consumes them in. */
async function reservationHolds(db: D1Database, reservationId: string): Promise<LotShare[]> {
  const rows = await many<{ lot_id: string; seconds: number }>(db, 'SELECT lot_id, seconds FROM pc_credit_reservation_lots WHERE reservation_id = ? ORDER BY rowid', reservationId);
  return rows.map((r) => ({ lotId: r.lot_id, seconds: Number(r.seconds) }));
}

/** A hold given back to its lot's free part. The lot's CHECK refuses taking back more than is held. */
function unhold(db: D1Database, h: LotShare): Stmt {
  return db.prepare('UPDATE pc_credit_lots SET seconds_held = seconds_held - ? WHERE id = ?').bind(h.seconds, h.lotId);
}

/**
 * What a job's last reservation held and gave back, per lot, in hold order:
 * each hold less what its settlement consumed from that lot. A free reprint
 * inherits it (jobs.ts `autoConfirmReprint`), so hours its failed parent
 * legitimately held carry over — even once their package has expired — and
 * no more than that: the rest of an expired lot was never the parent's.
 */
export async function releasedHolds(db: D1Database, jobId: string): Promise<LotShare[]> {
  const rows = await many<{ lot_id: string; seconds: number }>(
    db,
    `SELECT h.lot_id,
            h.seconds - COALESCE((SELECT SUM(d.seconds) FROM pc_credit_lot_draws d
                                   WHERE d.lot_id = h.lot_id AND d.ledger_entry_key = 'consume:' || h.reservation_id), 0) AS seconds
       FROM pc_credit_reservation_lots h
      WHERE h.reservation_id = (SELECT id FROM pc_credit_reservations WHERE job_id = ? AND state <> 'active' ORDER BY created_at DESC LIMIT 1)
      ORDER BY h.rowid`,
    jobId
  );
  return rows.filter((r) => Number(r.seconds) > 0).map((r) => ({ lotId: r.lot_id, seconds: Number(r.seconds) }));
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
  /** Lots taken first, each up to the seconds given and even past its expiry: a free reprint's inheritance (`releasedHolds`). */
  entitled?: LotShare[];
}

/**
 * Hold `seconds` for a job, lot by lot: first what it is entitled to, then
 * the free part of every lot not yet past its expiry, in spend order. Seconds
 * whose expiry has come are never held — even before the sweep takes them,
 * while the available balance still counts them — so a shortfall is
 * INSUFFICIENT_CREDIT. Each hold raises its lot's seconds_held, which
 * ck_pc_credit_lot_held keeps within what the lot has left: two jobs racing
 * for the same last hours cannot both hold them (the loser re-plans), and the
 * account UPDATE moves available → reserved.
 */
export async function reserveCredits(db: D1Database, r: ReserveInput): Promise<{ reservationId: string; statements: Stmt[] }> {
  if (!Number.isSafeInteger(r.seconds) || r.seconds <= 0) throw pcError('VALIDATION', { field: 'seconds' });
  const accountId = creditAccountId(r.userId, r.tierId);
  const reservationId = pcId('pccr');
  const lots = await accountLots(db, accountId);
  const cutoff = iso(r.now);
  const holds = new Map<string, number>();
  let left = r.seconds;
  const hold = (lot: CreditLotState, cap: number) => {
    const taken = holds.get(lot.id) ?? 0;
    const k = Math.min(freePart(lot) - taken, cap, left);
    if (k <= 0) return;
    holds.set(lot.id, taken + k);
    left -= k;
  };
  for (const share of r.entitled ?? []) {
    const lot = lots.find((l) => l.id === share.lotId);
    if (lot) hold(lot, share.seconds);
  }
  for (const lot of lots) if (goodAt(lot, cutoff)) hold(lot, left);
  if (left > 0) throw pcError('INSUFFICIENT_CREDIT', { shortfall_seconds: left });
  const statements: Stmt[] = [
    ensureCreditAccount(db, r.userId, r.tierId, r.now),
    accountDelta(db, accountId, -r.seconds, r.seconds, 0, r.now),
    db
      .prepare(
        `INSERT INTO pc_credit_reservations (id, account_id, user_id, tier_id, job_id, seconds_reserved, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .bind(reservationId, accountId, r.userId, r.tierId, r.jobId, r.seconds, iso(r.now)),
  ];
  for (const [lotId, seconds] of holds) {
    statements.push(
      db.prepare('UPDATE pc_credit_lots SET seconds_held = seconds_held + ? WHERE id = ?').bind(seconds, lotId),
      db.prepare('INSERT INTO pc_credit_reservation_lots (reservation_id, lot_id, seconds, created_at) VALUES (?, ?, ?, ?)').bind(reservationId, lotId, seconds, iso(r.now))
    );
  }
  statements.push(
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
    })
  );
  return { reservationId, statements };
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

/**
 * Give a whole active reservation back (a cancelled job, a job that never
 * ran): each hold returns to its lot's free part. Exactly once: the flip is
 * fenced. What returns to a lot past its expiry is free there, so the next
 * sweep takes it.
 */
export async function releaseCredits(db: D1Database, res: CreditReservationRow, actorId: string, now: Date, note = ''): Promise<Stmt[]> {
  if (res.state !== 'active') throw pcError('STATE_CHANGED');
  const holds = await reservationHolds(db, res.id);
  return [
    ...closeReservation(db, res, 'released', 0, res.seconds_reserved, now),
    ...holds.map((h) => unhold(db, h)),
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
 *   billed from the reservation = min(actual, reserved), consumed from the
 *                                 lots it held, in the order it took them
 *   released                    = reserved − that: the rest of each hold
 *                                 returns to its lot's free part
 *   overage                     = actual − reserved, billed only under
 *                                 'charge_from_balance', from free seconds
 *                                 not yet past their expiry, and never
 *                                 beyond them
 *
 * Each lot drawn gives one draw, valued cumulatively (lots.ts `drawValue`).
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
  const holds = await reservationHolds(db, res.id);
  const lots = await accountLots(db, res.account_id);
  const take = new Map<string, number>();
  let left = fromReservation;
  for (const h of holds) {
    const k = Math.min(h.seconds, left);
    if (k > 0) take.set(h.lotId, k);
    left -= k;
  }
  if (left > 0) throw pcError('STATE_CHANGED', { reason: 'holds_do_not_cover_reservation' });
  let overage = 0;
  if (actualSeconds > res.seconds_reserved && policy === 'charge_from_balance') {
    // Every hold is consumed whole here, so each lot's free part is exactly
    // what lies outside this job.
    const want = actualSeconds - res.seconds_reserved;
    const cutoff = iso(now);
    for (const lot of lots) {
      if (overage >= want) break;
      if (!goodAt(lot, cutoff)) continue;
      const k = Math.min(freePart(lot), want - overage);
      if (k <= 0) continue;
      take.set(lot.id, (take.get(lot.id) ?? 0) + k);
      overage += k;
    }
  }
  const unbilled = actualSeconds - fromReservation - overage;
  const billed = fromReservation + overage;
  // The holds go back first, so the draws below never leave a lot holding more than it has.
  const statements: Stmt[] = [...closeReservation(db, res, 'settled', fromReservation, released, now), ...holds.map((h) => unhold(db, h))];
  let value = 0;
  if (billed > 0) {
    const draws: LotDraw[] = [];
    for (const [lotId, qty] of take) {
      const lot = lots.find((l) => l.id === lotId);
      if (!lot || lot.remaining < qty) throw pcError('STATE_CHANGED', { reason: 'lots_do_not_cover_balance' });
      const v = drawValue(lot, qty);
      draws.push({ lotId, qty, value: v, expectedRemaining: lot.remaining });
      value += v;
    }
    const key = `consume:${res.id}`;
    statements.push(...drawStatements(db, draws, key, now));
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
function debitStatements(db: D1Database, accountId: string, p: DebitInput, plan: { draws: FencedDraw[]; value: number }): Stmt[] {
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
 * Take FREE seconds out of the available balance: never a second a confirmed
 * job holds, never one whose expiry has come (that is the sweep's). Without
 * `lotId` they are drawn in spend order; with `lotId` (a refund of that
 * purchase) only from that lot. Each draw is fenced on the lot's remainder,
 * and ck_pc_credit_lot_held refuses a debit that a hold landing meanwhile
 * would leave short — the caller re-plans — so held hours can never be
 * debited away.
 */
export async function debitAvailable(
  db: D1Database,
  p: Omit<DebitInput, 'type'> & { type: 'refund' | 'adjust_debit' | 'conversion_out' }
): Promise<{ statements: Stmt[]; value: number; draws: CreditDraw[] }> {
  if (!Number.isSafeInteger(p.seconds) || p.seconds <= 0) throw pcError('VALIDATION', { field: 'seconds' });
  const accountId = creditAccountId(p.userId, p.tierId);
  const plan = planFreeDraws(await accountLots(db, accountId, p.lotId), p.seconds, p.now);
  if (plan.shortfall > 0) throw pcError('INSUFFICIENT_CREDIT');
  return { value: plan.value, draws: plan.draws, statements: debitStatements(db, accountId, p, plan) };
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
 * Lots whose configured expiry has passed (only ever set by an explicit
 * package rule) and that still have a FREE part, earliest expiry first. The
 * filter is per lot: a lot wholly held for jobs has nothing to expire now and
 * is never read, so it cannot fill the page ahead of lots that do.
 */
export async function expiredLots(db: D1Database, now: Date, limit = 50): Promise<Array<CreditLotRow & { user_id: string; tier_id: string }>> {
  return many(
    db,
    `SELECT id, account_id, user_id, tier_id, source, seconds_total, seconds_remaining, seconds_held, paid_iqd, expires_at, created_at, order_line_id
       FROM pc_credit_lots
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND seconds_remaining > seconds_held
      ORDER BY expires_at, id LIMIT ?`,
    iso(now),
    limit
  );
}

/**
 * Expire the FREE part of one lot whose expiry has passed (§3.2): the seconds
 * jobs hold on it stay for them, and a hold given back later is free and
 * expires on a later run (unless a free reprint inherits it). Null when
 * nothing of the lot is free now. The batch is fenced on the lot's remainder
 * AND its holds as the plan read them, so it takes exactly that free part.
 *
 * A lot can therefore expire in several passes. Each is keyed by the seconds
 * the lot held before it — they only ever go down — so a later pass has a key
 * of its own, while two runners planning the same pass still collide.
 */
export async function planLotExpiry(
  db: D1Database,
  lot: Pick<CreditLotRow, 'id' | 'account_id'> & { user_id: string; tier_id: string },
  now: Date
): Promise<{ seconds: number; statements: Stmt[] } | null> {
  const [target] = await accountLots(db, lot.account_id, lot.id);
  if (!target || target.expiresAt === null || goodAt(target, iso(now))) return null;
  const seconds = freePart(target);
  if (seconds <= 0) return null;
  const draw: FencedDraw = { lotId: target.id, qty: seconds, value: drawValue(target, seconds), expectedRemaining: target.remaining, expectedHeld: target.held };
  const p: DebitInput = {
    userId: lot.user_id,
    tierId: lot.tier_id,
    seconds,
    type: 'expire',
    entryKey: `expire:${target.id}:${target.remaining}`,
    lotId: target.id,
    actorId: 'system',
    note: `package expiry ${target.expiresAt}`,
    now,
  };
  return { seconds, statements: debitStatements(db, lot.account_id, p, { draws: [draw], value: draw.value }) };
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
