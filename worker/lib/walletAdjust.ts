/**
 * «المستخدمين لا يمكن التعديل على رصيده مثل خصم رصيد وإضافة رصيد يدوي أو خصم
 *  النقاط وإضافة نقاط» — and «صحّحها بتسوية مسجّلة».
 *
 * TWO ADMIN TOOLS THAT MOVE A MEMBER'S MONEY BY HAND, and the ledger arithmetic
 * they share. The routes are worker/routes/adminWalletAdjust.ts; everything
 * that decides WHAT is written lives here so it can be tested without HTTP.
 *
 * ---------------------------------------------------------------------------
 *  THE DINARS ARE THE SOURCE, THE CENTS ARE DERIVED (migration 0108)
 * ---------------------------------------------------------------------------
 * The ledger is USD cents and stays USD cents. A balance in dinars is
 *
 *     floor(available_cents × rate / 100) + the recorded remainders (≥ 0)
 *
 * where a row's remainder is `amount_iqd − floor(amount × snapshot / 100)`,
 * added for a credit and subtracted for a debit (`walletDustIqdSql`). So a row
 * that records `amount_iqd` beside its cents moves the reading by EXACTLY
 * `amount_iqd` dinars — that is the whole reason an admin credit of 50,000 د.ع
 * now reads 50,000 on the customer's wallet page instead of 49,994.
 *
 * WHAT ONE ROW CANNOT DO. At 1,400 a cent is 14 د.ع and `CHECK (amount > 0)`
 * forbids a zero-cent row, so a single credit moves the reading by at least 14
 * and a correction of «+6» is not one row. And the remainders are clamped at
 * zero on the WALLET (`walletIqdAvailable`), so a debit's negative remainder
 * only lands when the wallet has positive remainders to absorb it.
 *
 * `planDinarLegs` therefore expresses any whole-dinar change D as at most two
 * rows whose remainders are NEVER negative:
 *
 *   D > 0, D ≥ one cent   one credit:  ⌊D×100/R⌋ cents, amount_iqd D
 *   D > 0, D < one cent   credit 1 cent recording (cent + D), and a debit of
 *                         1 cent recording exactly its cent — net 0 cents, +D
 *   D < 0                 debit ⌈|D|×100/R⌉ cents; when that overshoots |D|
 *                         the overshoot is handed back as a credit row's
 *                         remainder (one more cent on each side, net cents
 *                         unchanged)
 *
 * Every leg's dinars add up to D at the rate recorded on it; at a rate that is
 * a multiple of 100 (1,400 is) the balance moves by exactly D. At any other
 * rate the wallet's single floor over the summed cents may differ by under one
 * dinar — a bound, not a leak, and the same bound every other wallet row has.
 *
 * THE WALLET'S OWN REMAINDER IS PART OF THE BEFORE. The reading clamps the
 * summed remainder at zero, and reads 0 whenever no cents are left. So a
 * wallet whose remainders sum below zero (dinar-less legacy credits followed
 * by a checkout spend that recorded its dinars), or one spent down to no
 * cents with a remainder left over, reads a figure that its raw remainder
 * does not add up to, and a new row's remainder lands on the raw sum rather
 * than on the reading: a credit of 50,000 on such a wallet moved it 49,994.
 * `withReadingCompensation` posts the difference between the remainder the
 * reading SHOWS and the raw one as one more net-zero-cent pair (ref suffixed
 * `:dust`), so after the plan the raw sum is exactly the shown remainder plus
 * the plan's own, and the reading moves by D. `predictReading` then states
 * the resulting figure before anything is written, and a plan that would
 * leave dinars with no cent behind them (they would read 0) is refused.
 *
 * NOTHING HERE WEAKENS A SPEND GUARD. Every debit leg is written with the same
 * `CASE WHEN available >= amount THEN amount ELSE -1 END` that
 * `usdSpendStatement` uses, so a debit the balance does not cover aborts the
 * whole batch on `CHECK (amount > 0)` and nothing half-lands.
 */
import type { Context } from 'hono';
import type { AppContext } from './types';
import { HttpError } from './http';
import { canViewFinancials } from './adminScope';
import { sha256Hex } from './crypto';
import { auditStatements } from './audit';
import {
  availableUsdSql,
  getAvailableBalances,
  isConstraintAbort,
  readWalletDust,
  walletDustIqdSql,
  walletIqdAvailable,
  walletLedgerDinarsReady,
  walletSpendCents,
} from './walletOps';
import type { Env } from './types';

/** The 403 every money-moving admin route answers an assistant-scope admin. */
export function assertFinancialScope(c: Context<AppContext>): void {
  if (!canViewFinancials(c.env, c.get('user'))) {
    throw new HttpError(
      403,
      'هذا الإجراء للمالك أو الدور المالي فقط / This action needs the owner or a financial admin',
      'FINANCIAL_SCOPE_REQUIRED'
    );
  }
}

// ------------------------------------------------------------------ the legs

export interface DinarLeg {
  type: 'deposit' | 'withdrawal';
  cents: number;
  /** The dinars this row records (0108); never below what its cents convert to. */
  amountIqd: number;
  /** A leg of the reading-compensation pair (`withReadingCompensation`): not
   *  part of the change the admin asked for, so its id and ref are its own. */
  comp?: boolean;
}

const centIqd = (cents: number, rate: number) => Math.floor((cents * rate) / 100);

/**
 * The rows that move a dinar balance by exactly `deltaIqd` at `rate`, credit
 * legs first (a debit leg's guard then sees the credit it is paired with).
 * Empty for a zero change or an unusable rate.
 */
export function planDinarLegs(deltaIqd: number, rate: number): DinarLeg[] {
  const R = Number.isInteger(rate) && rate > 0 ? rate : 0;
  const D = Number.isSafeInteger(deltaIqd) ? deltaIqd : 0;
  if (!R || D === 0) return [];
  if (D > 0) {
    const cents = Math.floor((D * 100) / R);
    if (cents >= 1) return [{ type: 'deposit', cents, amountIqd: D }];
    const one = centIqd(1, R);
    return [
      { type: 'deposit', cents: 1, amountIqd: one + D },
      { type: 'withdrawal', cents: 1, amountIqd: one },
    ];
  }
  const A = -D;
  const cents = Math.ceil((A * 100) / R);
  if (centIqd(cents, R) === A) return [{ type: 'withdrawal', cents, amountIqd: A }];
  const debitCents = cents + 1;
  const debitIqd = centIqd(debitCents, R);
  return [
    { type: 'deposit', cents: 1, amountIqd: debitIqd - A },
    { type: 'withdrawal', cents: debitCents, amountIqd: debitIqd },
  ];
}

/** Cents a plan takes out of the wallet in net (negative for a net credit). */
export function netDebitCents(legs: DinarLeg[]): number {
  return legs.reduce((n, l) => n + (l.type === 'withdrawal' ? l.cents : -l.cents), 0);
}

/**
 * A DEBIT OF |D| DINARS THAT FITS THE CENTS ON HAND. `planDinarLegs` rounds
 * the cents UP and hands the overshoot back as a remainder, so taking a whole
 * balance of 50,000 د.ع (3,571 cents + a six-dinar remainder) would ask for
 * 3,572 cents. When the exact plan needs more cents than the wallet holds,
 * the debit is the checkout's shape instead (`walletSpendCents`): the cents
 * floored and capped at what is there, recording |D| so its negative remainder
 * cancels the wallet's positive one. Null when not even one cent can move.
 */
export function planDinarDebit(amountIqd: number, rate: number, availableCents: number): DinarLeg[] | null {
  const exact = planDinarLegs(-amountIqd, rate);
  if (!exact.length) return null;
  if (netDebitCents(exact) <= availableCents) return exact;
  const cents = walletSpendCents(amountIqd, availableCents, rate);
  if (cents <= 0) return null;
  return [{ type: 'withdrawal', cents, amountIqd }];
}

/** The signed dinars a set of legs records — what the balance moves by. */
export const legsNetIqd = (legs: Array<{ type: string; amountIqd: number }>) =>
  legs.reduce((n, l) => n + (l.type === 'deposit' ? l.amountIqd : -l.amountIqd), 0);

/** The part of the before-reading that is remainder, as the reading shows it. */
const shownDust = (b: { available_cents: number; balance_iqd: number }, rate: number) =>
  b.available_cents > 0 ? b.balance_iqd - centIqd(b.available_cents, rate) : 0;

/** A leg's own signed remainder, exactly as `walletDustIqdSql` counts it. */
const legDust = (l: DinarLeg, rate: number) =>
  (l.type === 'deposit' ? 1 : -1) * Math.max(0, l.amountIqd - centIqd(l.cents, rate));

/**
 * The plan, bracketed by the pair that turns the wallet's RAW remainder into
 * the one its reading shows (see the header). Nothing is added when they
 * already agree — every wallet whose remainders sum to zero or more and still
 * holds cents. The pair is one cent in and the same cent out: the deposit
 * first, so the withdrawal's guard always sees it.
 */
export function withReadingCompensation(
  legs: DinarLeg[],
  before: { available_cents: number; dust_iqd: number; balance_iqd: number },
  rate: number
): DinarLeg[] {
  if (!legs.length) return legs;
  const comp = shownDust(before, rate) - before.dust_iqd;
  if (comp === 0) return legs;
  const one = centIqd(1, rate);
  return [
    { type: 'deposit', cents: 1, amountIqd: one + Math.max(comp, 0), comp: true },
    ...legs,
    { type: 'withdrawal', cents: 1, amountIqd: one + Math.max(-comp, 0), comp: true },
  ];
}

/** The dinars the member's wallet page will read once `legs` are written. */
export function predictReading(
  before: { available_cents: number; dust_iqd: number },
  legs: DinarLeg[],
  rate: number
): { balance_iqd: number; available_cents: number } {
  const cents = before.available_cents - netDebitCents(legs);
  const dust = legs.reduce((n, l) => n + legDust(l, rate), before.dust_iqd);
  return { balance_iqd: walletIqdAvailable(cents, dust, rate), available_cents: cents };
}

/** Ids by kind: the change's own legs `_1`, `_2`; the compensation pair `_d1`, `_d2`. */
export function legIds(baseId: string, legs: DinarLeg[]): string[] {
  let own = 0;
  let comp = 0;
  return legs.map((l) => (l.comp ? `${baseId}_d${++comp}` : `${baseId}_${++own}`));
}

/**
 * One ledger row per leg, all approved, all carrying `amount_iqd` and the rate.
 * The ids are deterministic and PLAIN inserts: a second batch for the same
 * change — a retry, or two admins pressing at once — aborts whole on the
 * primary key, audit row included, and the caller answers it as a replay. A
 * debit leg carries the spendable-balance guard.
 */
export function legStatements(
  db: D1Database,
  p: { baseId: string; userId: string; legs: DinarLeg[]; rate: number; note: string; ref: string; actorId: string }
): D1PreparedStatement[] {
  const ids = legIds(p.baseId, p.legs);
  return p.legs.map((leg, i) =>
    db
      .prepare(
        `INSERT INTO wallet_transactions
           (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, decided_by, amount_iqd, exchange_rate_snapshot)
         SELECT ?1, ?2, ?3, 'USD',
           ${leg.type === 'withdrawal' ? `CASE WHEN ${availableUsdSql('?2')} >= ?4 THEN ?4 ELSE -1 END` : '?4'},
           'approved', ?5, ?6, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?7, ?8, ?9`
      )
      .bind(ids[i], p.userId, leg.type, leg.cents, p.note, leg.comp ? `${p.ref}:dust` : p.ref, p.actorId, leg.amountIqd, p.rate)
  );
}

// ------------------------------------------------------------ balances

export interface MemberBalance {
  available_cents: number;
  dust_iqd: number;
  balance_iqd: number;
  points: number;
  ledger_dinars: boolean;
}

export async function readMemberBalance(env: Env, userId: string, rate: number): Promise<MemberBalance> {
  const [bal, dust] = await Promise.all([getAvailableBalances(env, userId), readWalletDust(env.DB, userId)]);
  return {
    available_cents: bal.usd_cents_available,
    dust_iqd: dust.dust_iqd,
    balance_iqd: walletIqdAvailable(bal.usd_cents_available, dust.dust_iqd, rate),
    points: bal.points_available,
    ledger_dinars: dust.ledger_dinars,
  };
}

// ------------------------------------------------------- manual adjustment

export type AdjustKind = 'balance' | 'points';
export type AdjustDirection = 'credit' | 'debit';

export interface ManualAdjustInput {
  actorId: string;
  userId: string;
  kind: AdjustKind;
  direction: AdjustDirection;
  /** Whole dinars for `balance`, whole points for `points`. */
  amount: number;
  reason: string;
  idempotencyKey: string;
  rate: number;
}

export type ManualAdjustResult =
  | {
      ok: true;
      replayed: boolean;
      id: string;
      tx_ids: string[];
      before: { balance_iqd: number; points: number };
      after: { balance_iqd: number; points: number };
    }
  | {
      ok: false;
      reason:
        | 'INSUFFICIENT_BALANCE'
        | 'INSUFFICIENT_POINTS'
        | 'AMOUNT_TOO_SMALL'
        | 'UNREPRESENTABLE'
        | 'IDEMPOTENCY_KEY_REUSED'
        | 'NO_RATE'
        | 'SCHEMA_BEHIND';
      balance_iqd?: number;
      points?: number;
      /** UNREPRESENTABLE: the smallest balance a wallet with cents can hold (one cent). */
      min_iqd?: number;
    };

/** `wtx_madj_<32 hex>` — derived from (admin, key), as /wallet/credit derives its id. */
export async function manualAdjustBaseId(actorId: string, key: string): Promise<string> {
  return `wtx_madj_${(await sha256Hex(`${actorId}:${key}`)).slice(0, 32)}`;
}

/**
 * Credit or debit a member's dinar balance, or add or deduct points, as ONE
 * audited batch. Refuses rather than caps: an admin who types «خصم 60,000»
 * from a 50,000 balance is told so, never silently handed a smaller debit.
 * The audit's `after` is the figure the member's page will read — predicted
 * from the same arithmetic as the page, and a plan whose result the ledger
 * cannot show (dinars left with no cent behind them) is refused, not written.
 */
export async function manualWalletAdjust(env: Env, p: ManualAdjustInput): Promise<ManualAdjustResult> {
  const db = env.DB;
  const baseId = await manualAdjustBaseId(p.actorId, p.idempotencyKey);
  const signed = p.direction === 'credit' ? p.amount : -p.amount;

  // A retried submit finds its own rows and changes nothing.
  const replay = async (): Promise<ManualAdjustResult | null> => {
    const prior = await db
      .prepare(
        `SELECT id, user_id, type, currency, amount, amount_iqd FROM wallet_transactions
          WHERE id IN (?1, ?2) ORDER BY id`
      )
      .bind(`${baseId}_1`, `${baseId}_2`)
      .all<{ id: string; user_id: string; type: string; currency: string; amount: number; amount_iqd: number | null }>();
    const priorRows = prior.results ?? [];
    if (!priorRows.length) return null;
    const currency = p.kind === 'points' ? 'POINT' : 'USD';
    const net =
      p.kind === 'points'
        ? priorRows.reduce((n, r) => n + (r.type === 'deposit' ? r.amount : -r.amount), 0)
        : legsNetIqd(priorRows.map((r) => ({ type: r.type, amountIqd: Number(r.amount_iqd) || 0 })));
    if (priorRows.some((r) => r.user_id !== p.userId || r.currency !== currency) || net !== signed) {
      return { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
    }
    const now = await readMemberBalance(env, p.userId, p.rate);
    const after = { balance_iqd: now.balance_iqd, points: now.points };
    return { ok: true, replayed: true, id: baseId, tx_ids: priorRows.map((r) => r.id), before: after, after };
  };
  const replayed = await replay();
  if (replayed) return replayed;

  const before = await readMemberBalance(env, p.userId, p.rate);
  const note = p.reason;
  const ref = `admin:${p.actorId}`;
  let statements: D1PreparedStatement[];
  let txIds: string[];
  let afterFigure: number;

  if (p.kind === 'points') {
    if (p.direction === 'debit' && p.amount > before.points) {
      return { ok: false, reason: 'INSUFFICIENT_POINTS', points: before.points };
    }
    const id = `${baseId}_1`;
    txIds = [id];
    afterFigure = before.points + signed;
    // A plain insert on the deterministic id: a concurrent second submit
    // aborts on the primary key, audit row and all, and is answered as a replay.
    statements = [
      db
        .prepare(
          `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, decided_by)
           SELECT ?1, ?2, ?3, 'POINT',
             ${
               p.direction === 'debit'
                 ? `CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                                 FROM wallet_transactions WHERE user_id = ?2 AND currency='POINT' AND status='approved') >= ?4
                         THEN ?4 ELSE -1 END`
                 : '?4'
             },
             'approved', ?5, ?6, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?7`
        )
        .bind(id, p.userId, p.direction === 'credit' ? 'deposit' : 'withdrawal', p.amount, note, ref, p.actorId),
    ];
  } else {
    if (!(Number.isInteger(p.rate) && p.rate > 0)) return { ok: false, reason: 'NO_RATE' };
    // A dinar-less row would read 49,994 for a typed 50,000 — the very defect
    // this exists to end — so a database behind on 0108 is refused, not served.
    if (!before.ledger_dinars) return { ok: false, reason: 'SCHEMA_BEHIND' };
    let legs: DinarLeg[] | null;
    if (p.direction === 'credit') {
      legs = planDinarLegs(p.amount, p.rate);
    } else {
      if (p.amount > before.balance_iqd) {
        return { ok: false, reason: 'INSUFFICIENT_BALANCE', balance_iqd: before.balance_iqd };
      }
      legs = planDinarDebit(p.amount, p.rate, before.available_cents);
    }
    if (!legs || !legs.length) return { ok: false, reason: 'AMOUNT_TOO_SMALL' };
    legs = withReadingCompensation(legs, before, p.rate);
    const predicted = predictReading(before, legs, p.rate);
    const target = before.balance_iqd + signed;
    // Dinars with no cent behind them read 0: a debit that would leave less
    // than a cent's worth, or a sub-cent credit to a wallet with no cents.
    if (predicted.balance_iqd !== target && predicted.available_cents <= 0 && target > 0) {
      return {
        ok: false,
        reason: 'UNREPRESENTABLE',
        balance_iqd: before.balance_iqd,
        min_iqd: Math.ceil(p.rate / 100),
      };
    }
    afterFigure = predicted.balance_iqd;
    txIds = legIds(baseId, legs);
    statements = legStatements(db, { baseId, userId: p.userId, legs, rate: p.rate, note, ref, actorId: p.actorId });
  }

  const auditDetail = {
    user_id: p.userId,
    kind: p.kind,
    direction: p.direction,
    ...(p.kind === 'points' ? { points: p.amount } : { amount_iqd: p.amount, exchange_rate: p.rate }),
    reason: p.reason,
    before: p.kind === 'points' ? before.points : before.balance_iqd,
    after: afterFigure,
    tx_ids: txIds,
    idempotency_key: p.idempotencyKey,
  };
  const { statements: auditStmts } = await auditStatements(db, p.actorId, 'wallet.manual_adjust', p.userId, auditDetail);
  try {
    await db.batch([...statements, ...auditStmts]);
  } catch (e) {
    if (!isConstraintAbort(e)) throw e;
    // Another submit with this key won the race: its rows are there, ours
    // (audit included) rolled back. Answer it as the replay it is.
    const raced = await replay();
    if (raced) return raced;
    // Otherwise the guard fired: the balance moved between the read and the write.
    const now = await readMemberBalance(env, p.userId, p.rate);
    return p.kind === 'points'
      ? { ok: false, reason: 'INSUFFICIENT_POINTS', points: now.points }
      : { ok: false, reason: 'INSUFFICIENT_BALANCE', balance_iqd: now.balance_iqd };
  }
  const after = await readMemberBalance(env, p.userId, p.rate);
  return {
    ok: true,
    replayed: false,
    id: baseId,
    tx_ids: txIds,
    before: { balance_iqd: before.balance_iqd, points: before.points },
    after: { balance_iqd: after.balance_iqd, points: after.points },
  };
}

// ------------------------------------------------- the rounding correction

/**
 * «صحّحها بتسوية مسجّلة» — BALANCES THAT DRIFTED A FEW DINARS UNDER THE OLD
 * ROUNDING, CORRECTED BY ONE RECORDED ADJUSTMENT PER MEMBER.
 *
 * Before 0108 the ledger could only hold what the cents convert to: a typed
 * 50,000 was credited 50,008 under the ceil (0105's window) and 49,994 under
 * the floor, and a typed withdrawal of 50,000 debited 50,008 under the ceil.
 * The customer's own figure is on the request — `declared_amount_iqd` on
 * `wallet_deposit_meta` (0105) and on `wallet_withdrawals` (0106) — so the
 * drift is knowable per row:
 *
 *   ledger_iqd(row) = floor(amount × r / 100) + the row's remainder,
 *
 * the remainder EXACTLY as `walletDustIqdSql` counts it (a deposit request's
 * capped at one cent less one dinar, none without a recorded rate), `r` the
 * rate recorded on the row, or today's rate for a row that recorded none —
 * which is what every screen has always converted it at. So a row 0108 already
 * reads exactly (typed 50,000, 3,571 cents, remainder 6) has NO drift and is
 * never corrected twice.
 *
 *   deposit     owed = typed − ledger_iqd      (+6 for the floor, −8 for the ceil)
 *   withdrawal  owed = ledger_iqd − typed      (+8 back for the ceil)
 *
 * ONLY ROUNDING. A row whose difference is wider than one cent at its rate is
 * not a rounding remainder — it is a different rate or an approval for other
 * cents — and is listed as skipped, never «corrected».
 *
 * ONE ROW OF BOOKKEEPING PER MEMBER, AND IT IS IDEMPOTENT BY CONSTRUCTION.
 * What is owed is the sum over the member's rows MINUS every correction
 * already posted (`ref = 'rounding_drift'`, whose recorded dinars are exactly
 * what they moved). A second run finds nothing outstanding. The rows' id is
 * derived from (member, total drift, already corrected), so two admins
 * pressing «تطبيق» at once compute the same id and the second writes nothing.
 *
 * NEVER BELOW ZERO. A debit correction larger than the member's balance is
 * capped at the balance and reported as capped; the remainder stays listed.
 */
export const ROUNDING_DRIFT_REF = 'rounding_drift';
export const ROUNDING_DRIFT_REASON = 'تسوية فروقات التقريب القديمة';
/** What the admin types to apply — either form. */
export const ROUNDING_DRIFT_CONFIRM = ['تطبيق التسوية', 'APPLY'] as const;

export interface DriftRowInput {
  kind: 'deposit' | 'withdrawal';
  cents: number;
  typedIqd: number;
  /** The dinars recorded on the ledger row (0108), or a deposit's declared figure. */
  recordedIqd: number | null;
  /** The rate recorded on the row (0108 column, else the request's snapshot). */
  rowRate: number | null;
  /** A deposit request's remainder is capped at one cent (walletDustIqdSql). */
  depositRequest: boolean;
  todayRate: number;
}

export interface DriftRowResult {
  ledger_iqd: number;
  /** Dinars owed TO the member (negative: owed by them). */
  owed_iqd: number;
  rate: number;
  /** False when the difference is wider than one cent — not rounding. */
  rounding: boolean;
}

export function rowDrift(p: DriftRowInput): DriftRowResult | null {
  const recordedRate = Number.isInteger(p.rowRate) && (p.rowRate as number) > 0 ? (p.rowRate as number) : null;
  const rate = recordedRate ?? (Number.isInteger(p.todayRate) && p.todayRate > 0 ? p.todayRate : 0);
  if (!rate || !(Number.isInteger(p.typedIqd) && p.typedIqd > 0) || !(p.cents > 0)) return null;
  const base = centIqd(p.cents, rate);
  let dust = 0;
  if (recordedRate !== null && Number.isInteger(p.recordedIqd) && (p.recordedIqd as number) > 0) {
    dust = Math.max(0, (p.recordedIqd as number) - base);
    if (p.depositRequest) dust = Math.min(dust, Math.floor((rate + 99) / 100) - 1);
  }
  const ledger = base + dust;
  const owed = p.kind === 'deposit' ? p.typedIqd - ledger : ledger - p.typedIqd;
  return { ledger_iqd: ledger, owed_iqd: owed, rate, rounding: Math.abs(owed) <= Math.ceil(rate / 100) };
}

export interface DriftRowView {
  tx_id: string;
  kind: 'deposit' | 'withdrawal';
  typed_iqd: number;
  ledger_iqd: number;
  owed_iqd: number;
}

export interface DriftMember {
  user_id: string;
  name: string;
  email: string;
  rows: DriftRowView[];
  /** Σ owed over the rounding rows. */
  drift_iqd: number;
  /** Σ of the corrections already posted for this member. */
  corrected_iqd: number;
  /** drift − corrected: what is still owed (+) or over-credited (−). */
  outstanding_iqd: number;
  balance_iqd: number;
  /** The cents and raw remainder behind `balance_iqd`, read in the same query. */
  available_cents: number;
  dust_iqd: number;
  /** What «تطبيق» would write: outstanding, a debit capped at the balance. */
  apply_iqd: number;
  capped: boolean;
  /** Rows whose difference is wider than rounding — listed, never corrected. */
  skipped_rows: number;
}

export interface DriftScan {
  rate: number;
  members: DriftMember[];
  total_credit_iqd: number;
  total_debit_iqd: number;
  fingerprint: string;
}

/** Every member whose testified rows drifted, and what applying would write. */
export async function scanRoundingDrift(env: Env, todayRate: number): Promise<DriftScan> {
  const db = env.DB;
  const [deposits, withdrawals, corrections] = await Promise.all([
    db
      .prepare(
        `SELECT t.id, t.user_id, t.amount, t.amount_iqd, t.exchange_rate_snapshot AS t_rate,
                m.declared_amount_iqd AS typed, m.exchange_rate_snapshot AS m_rate
           FROM wallet_transactions t
           JOIN wallet_deposit_meta m ON m.tx_id = t.id
          WHERE t.type = 'deposit' AND t.currency = 'USD' AND t.status = 'approved'
            AND m.declared_amount_iqd > 0`
      )
      .all<{ id: string; user_id: string; amount: number; amount_iqd: number | null; t_rate: number | null; typed: number; m_rate: number | null }>(),
    db
      .prepare(
        `SELECT t.id, t.user_id, t.amount, t.amount_iqd, t.exchange_rate_snapshot AS t_rate,
                w.declared_amount_iqd AS typed, w.exchange_rate_snapshot AS w_rate
           FROM wallet_withdrawals w
           JOIN wallet_transactions t ON t.id = w.tx_id
          WHERE t.type = 'withdrawal' AND t.currency = 'USD' AND t.status = 'approved'
            AND w.declared_amount_iqd > 0`
      )
      .all<{ id: string; user_id: string; amount: number; amount_iqd: number | null; t_rate: number | null; typed: number; w_rate: number | null }>(),
    db
      .prepare(
        `SELECT user_id, COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount_iqd ELSE -amount_iqd END), 0) AS net
           FROM wallet_transactions
          WHERE ref = ?1 AND currency = 'USD' AND status = 'approved'
          GROUP BY user_id`
      )
      .bind(ROUNDING_DRIFT_REF)
      .all<{ user_id: string; net: number }>(),
  ]);

  const byUser = new Map<string, { rows: DriftRowView[]; skipped: number }>();
  const add = (userId: string, view: DriftRowView | null) => {
    const entry = byUser.get(userId) ?? { rows: [], skipped: 0 };
    if (view) entry.rows.push(view);
    else entry.skipped++;
    byUser.set(userId, entry);
  };
  for (const r of deposits.results ?? []) {
    const d = rowDrift({
      kind: 'deposit',
      cents: r.amount,
      typedIqd: r.typed,
      recordedIqd: r.amount_iqd ?? r.typed,
      rowRate: r.t_rate ?? r.m_rate,
      depositRequest: true,
      todayRate,
    });
    if (!d || d.owed_iqd === 0) continue;
    add(r.user_id, d.rounding ? { tx_id: r.id, kind: 'deposit', typed_iqd: r.typed, ledger_iqd: d.ledger_iqd, owed_iqd: d.owed_iqd } : null);
  }
  for (const r of withdrawals.results ?? []) {
    // The ledger row's remainder counts only with the ledger row's own rate
    // (walletDustIqdSql joins no withdrawal table); the request's snapshot is
    // the conversion rate when the ledger row recorded none.
    const d = rowDrift({
      kind: 'withdrawal',
      cents: r.amount,
      typedIqd: r.typed,
      recordedIqd: r.t_rate ? r.amount_iqd : null,
      rowRate: r.t_rate ?? r.w_rate,
      depositRequest: false,
      todayRate,
    });
    if (!d || d.owed_iqd === 0) continue;
    add(r.user_id, d.rounding ? { tx_id: r.id, kind: 'withdrawal', typed_iqd: r.typed, ledger_iqd: d.ledger_iqd, owed_iqd: d.owed_iqd } : null);
  }
  const corrected = new Map((corrections.results ?? []).map((r) => [r.user_id, Number(r.net) || 0]));
  for (const userId of corrected.keys()) if (!byUser.has(userId)) byUser.set(userId, { rows: [], skipped: 0 });

  const listed: Array<{ userId: string; entry: { rows: DriftRowView[]; skipped: number }; drift: number; done: number }> = [];
  for (const [userId, entry] of byUser) {
    const drift = entry.rows.reduce((n, r) => n + r.owed_iqd, 0);
    const done = corrected.get(userId) ?? 0;
    if (drift - done === 0 && entry.skipped === 0) continue;
    listed.push({ userId, entry, drift, done });
  }
  // ONE query for every listed member's name and balance — a per-member read
  // would spend a Worker's D1 query budget on a long list before applying any.
  const who = new Map<string, { name: string | null; email: string | null; cents: number; dust: number }>();
  if (listed.length) {
    const res = await db
      .prepare(
        `SELECT uu.id, uu.name, uu.email,
                ${availableUsdSql('uu.id')} AS cents,
                ${walletDustIqdSql('uu.id')} AS dust
           FROM users uu
          WHERE uu.id IN (SELECT value FROM json_each(?1))`
      )
      .bind(JSON.stringify(listed.map((l) => l.userId)))
      .all<{ id: string; name: string | null; email: string | null; cents: number; dust: number }>();
    for (const r of res.results ?? []) {
      who.set(r.id, { name: r.name, email: r.email, cents: Number(r.cents) || 0, dust: Number(r.dust) || 0 });
    }
  }

  const members: DriftMember[] = [];
  for (const { userId, entry, drift, done } of listed) {
    const outstanding = drift - done;
    const w = who.get(userId);
    const cents = w?.cents ?? 0;
    const dust = w?.dust ?? 0;
    const balance = walletIqdAvailable(cents, dust, todayRate);
    let apply = outstanding;
    let capped = false;
    if (outstanding < 0 && -outstanding > balance) {
      apply = -balance;
      capped = true;
    }
    members.push({
      user_id: userId,
      name: w?.name ?? '',
      email: w?.email ?? '',
      rows: entry.rows,
      drift_iqd: drift,
      corrected_iqd: done,
      outstanding_iqd: outstanding,
      balance_iqd: balance,
      available_cents: cents,
      dust_iqd: dust,
      apply_iqd: apply,
      capped,
      skipped_rows: entry.skipped,
    });
  }
  members.sort((a, b) => Math.abs(b.apply_iqd) - Math.abs(a.apply_iqd) || a.user_id.localeCompare(b.user_id));
  const plan = members.filter((m) => m.apply_iqd !== 0).map((m) => [m.user_id, m.drift_iqd, m.corrected_iqd, m.apply_iqd]);
  return {
    rate: todayRate,
    members,
    total_credit_iqd: members.reduce((n, m) => n + Math.max(0, m.apply_iqd), 0),
    total_debit_iqd: members.reduce((n, m) => n + Math.max(0, -m.apply_iqd), 0),
    fingerprint: (await sha256Hex(JSON.stringify([todayRate, plan]))).slice(0, 24),
  };
}

export interface DriftApplyOutcome {
  user_id: string;
  applied_iqd: number;
  status: 'applied' | 'already_applied' | 'refused' | 'unrepresentable';
  capped: boolean;
  before_iqd: number;
  after_iqd: number;
}

/**
 * Members one «تطبيق» request corrects at most. Each member is one batch of
 * up to five statements, so fifty stay far inside a Worker's D1 query budget;
 * the rest are reported as `remaining` and the screen applies again.
 */
export const ROUNDING_DRIFT_PAGE = 50;

/**
 * Write the scan's corrections, one audited batch per member, for at most
 * `ROUNDING_DRIFT_PAGE` members. The balances are the ones the scan read in
 * this same request; every debit leg still carries its guard, so a balance
 * that moved since is refused by the batch, never overdrawn.
 */
export async function applyRoundingDrift(
  env: Env,
  actorId: string,
  scan: DriftScan,
  opts: { limit?: number } = {}
): Promise<{ results: DriftApplyOutcome[]; remaining: number }> {
  const db = env.DB;
  const out: DriftApplyOutcome[] = [];
  const due = scan.members.filter((m) => m.apply_iqd !== 0);
  const page = due.slice(0, Math.max(1, opts.limit ?? ROUNDING_DRIFT_PAGE));
  const ledgerDinars = page.length ? await walletLedgerDinarsReady(db) : true;
  for (const m of page) {
    const before = { available_cents: m.available_cents, dust_iqd: m.dust_iqd, balance_iqd: m.balance_iqd };
    const unmoved = (status: DriftApplyOutcome['status']): DriftApplyOutcome => ({
      user_id: m.user_id,
      applied_iqd: 0,
      status,
      capped: m.capped,
      before_iqd: before.balance_iqd,
      after_iqd: before.balance_iqd,
    });
    const planned =
      m.apply_iqd > 0
        ? planDinarLegs(m.apply_iqd, scan.rate)
        : planDinarDebit(Math.min(-m.apply_iqd, before.balance_iqd), scan.rate, before.available_cents);
    if (!planned || !planned.length || !ledgerDinars) {
      out.push(unmoved('unrepresentable'));
      continue;
    }
    const applied = legsNetIqd(planned);
    const legs = withReadingCompensation(planned, before, scan.rate);
    const predicted = predictReading(before, legs, scan.rate);
    // A correction the reading would not show (dinars with no cent behind
    // them) is not written: it would count as corrected and never be listed
    // again while the member's page did not move.
    if (predicted.balance_iqd !== before.balance_iqd + applied && predicted.available_cents <= 0) {
      out.push(unmoved('unrepresentable'));
      continue;
    }
    const baseId = `wtx_rdrift_${(await sha256Hex(`${m.user_id}:${m.drift_iqd}:${m.corrected_iqd}`)).slice(0, 32)}`;
    const txIds = legIds(baseId, legs);
    const { statements: auditStmts } = await auditStatements(db, actorId, 'wallet.rounding_drift', m.user_id, {
      reason: ROUNDING_DRIFT_REASON,
      drift_iqd: m.drift_iqd,
      corrected_before_iqd: m.corrected_iqd,
      applied_iqd: applied,
      capped: m.capped || applied !== m.outstanding_iqd,
      before: before.balance_iqd,
      after: predicted.balance_iqd,
      exchange_rate: scan.rate,
      rows: m.rows.map((r) => [r.tx_id, r.typed_iqd, r.ledger_iqd, r.owed_iqd]),
      tx_ids: txIds,
    });
    try {
      // Plain inserts on deterministic ids: a second admin applying the same
      // list at once aborts on the primary key, its audit row with it.
      await db.batch([
        ...legStatements(db, {
          baseId,
          userId: m.user_id,
          legs,
          rate: scan.rate,
          note: ROUNDING_DRIFT_REASON,
          ref: ROUNDING_DRIFT_REF,
          actorId,
        }),
        ...auditStmts,
      ]);
    } catch (e) {
      if (!isConstraintAbort(e)) throw e;
      const exists = await db.prepare('SELECT 1 AS x FROM wallet_transactions WHERE id = ?').bind(txIds[legs.findIndex((l) => !l.comp)]).first();
      out.push(unmoved(exists ? 'already_applied' : 'refused'));
      continue;
    }
    out.push({
      user_id: m.user_id,
      applied_iqd: applied,
      status: 'applied',
      capped: m.capped || applied !== m.outstanding_iqd,
      before_iqd: before.balance_iqd,
      after_iqd: predicted.balance_iqd,
    });
  }
  return { results: out, remaining: due.length - page.length };
}
