import type { Env } from './types';
import type { PayoutMethod } from './settings';
import { newId } from './crypto';
import { audit } from './audit';
import { busFor, emitEvent, outboxStatement } from './eventBus';
import { isSchemaMissing } from './membershipBenefits';
import { PaymentAuthorizedV1 } from '@levonis/contracts/events/v1/PaymentAuthorized';
import { PaymentCompletedV1 } from '@levonis/contracts/events/v1/PaymentCompleted';
import { PaymentFailedV1 } from '@levonis/contracts/events/v1/PaymentFailed';

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

/**
 * THE DINARS THE CENTS COULD NOT HOLD — «يضاف كما هو ولكن يحول الى الدولار
 * وليس العكس» (migration 0108, which carries the full contract).
 *
 * A customer typed 50,000 د.ع. `iqdToUsdCents` floors, so 3,571 cents were
 * credited, and every balance converted them back with floor(3,571 × 1,400 /
 * 100) = 49,994. The printer advance is 50,000 د.ع NATIVE — read straight out
 * of `printerHomeDeliveryNoteIqd`, never converted, never rounded — so the
 * shop refused a customer who had paid exactly enough. Ceil does not fix it
 * either: it credits 50,008, which is the defect 0106 was written to end. At
 * 1,400 a cent is 14 د.ع, only multiples of 14 are representable, and 50,000
 * is not one of them. The fault is not the direction of the rounding. It is
 * which of the two numbers is the SOURCE.
 *
 * THE ONE RULE FOR WHICH UNIT WINS, quoted from 0108 rather than restated:
 *
 *   A wallet row's dinars are the dinars RECORDED on it — `amount_iqd`, or
 *   `wallet_deposit_meta.declared_amount_iqd` (0105) for a deposit filed
 *   before that column existed — read at the rate recorded beside them. A row
 *   that recorded no dinars has none, and converts from its cents at today's
 *   rate exactly as it always has. Nothing is ever converted the other way.
 *
 * So this fragment sums, per user, only the REMAINDER each recorded row
 * carries above what its own cents convert to at its own snapshot rate:
 *
 *   dust(row) = MAX(0, recorded_iqd − floor(amount × snapshot_rate / 100))
 *
 * signed + for a credit and − for a debit. A row with no testimony
 * contributes nothing, which is why NO EXISTING BALANCE MOVES: at the instant
 * 0108 applies, `amount_iqd` is NULL on every row in the table.
 *
 * ---------------------------------------------------------------------------
 *  THE CEILING IS PER ROW. THIS IS THE CORRECTION, AND IT IS THE WHOLE FIX.
 * ---------------------------------------------------------------------------
 * The first draft of this file clamped the SUM into one cent's worth, and
 * `walletIqdAvailable` still carries the sentence that defended it. That clamp
 * reproduced the owner's exact complaint for anyone who reached 50,000 د.ع in
 * more than one transfer: two typed deposits of 25,000 lose 10 د.ع each to the
 * floor, the honest remainder is 20, the clamp cut it to 14, and the balance
 * read 49,994 — the owner's number — and the 50,000 د.ع printer advance was
 * refused again. Three and four transfers fail the same way.
 *
 * A PER-WALLET CEILING CANNOT TELL FORTY ORPHAN REMAINDERS FROM TWO
 * CORROBORATED ONES, because by the time the rows are summed the difference
 * is gone. A PER-ROW ceiling can: the widest a single floor() can miss by is
 * one dinar less than a cent — `ceil(rate/100) − 1`, 13 د.ع at 1,400 — so a
 * row claiming more than that is not a rounding remainder, it is a claim, and
 * it is cut to the largest remainder it could honestly have been. Forty
 * honest deposits then carry forty honest remainders, which is what the
 * customer actually paid in and was not credited.
 *
 * ONLY A CUSTOMER'S OWN TOP-UP IS CEILINGED, and the join decides it: a row
 * with a `wallet_deposit_meta` beside it is a DEPOSIT REQUEST, whose dinar
 * figure is unvalidated client input. Every other row's dinars were written by
 * this server — a checkout debit, a membership charge, a cancel refund copying
 * the debit it reverses — and a ceiling on those would be a bug, not a guard:
 *
 *   * A DEBIT MUST CANCEL EVERYTHING IT SPENT. One order that empties a wallet
 *     funded by four top-ups carries four remainders, and a debit ceilinged at
 *     one cent would strand three of them as dinars nothing backs.
 *   * A REFUND MUST RESTORE EVERYTHING IT GIVES BACK. The cancel refund copies
 *     the debit's dinars verbatim (worker/lib/orderCancelOps.ts); ceiling the
 *     copy and the round trip stops being one — 50,000 د.ع out, 49,993 back,
 *     which is the very shape this change exists to end.
 *
 * NOTHING IS TRUSTED THAT WAS NOT ALREADY TRUSTED. `corroboratedDeclaredIqd`
 * re-runs the conversion server-side before a deposit's testimony is stored at
 * all, so the ceiling is the SECOND guard, for the one case corroboration
 * cannot see: an admin approving a deposit for fewer cents than were declared.
 * And the sum is clamped at ZERO before it is read (`walletIqdAvailable`), so
 * the worst any over-large debit can do is take the reading back to the plain
 * cents conversion every screen printed before 0108.
 *
 * WHAT THE SHOP IS EXPOSED TO, stated so it is never mistaken for a leak: the
 * ceilinged sum is bounded by 13 د.ع per TESTIFIED DEPOSIT — about one US cent
 * each — and every dinar of it is money the shop received by bank transfer and
 * did not credit, because `iqdToUsdCents` floored it away. Honouring it is
 * repayment, not a discount.
 *
 * A HOLD ALREADY SPENT THE CENTS, SO IT MUST ALREADY SPEND THE DINARS. The
 * WHERE used to read `status = 'approved'` alone, and a withdrawal's cents
 * leave `available` the moment its hold goes active — while its ledger row is
 * still `pending`. The dinar reading therefore stayed high until the payout
 * was recorded and then dropped at an instant when no money moved. The row is
 * counted here under exactly the condition `effectiveHoldsUsdSql` uses to stop
 * counting its hold, so the two hand over between them and the reading is
 * continuous across the payout.
 *
 * IT NEVER REACHES A SPEND GUARD. `availableUsdSql` is untouched and is still
 * the only thing `usdSpendStatement`, `holdInsertStatement` and
 * `approvableWithdrawalSql` consult. This is read by display and by the
 * advance comparison; it moves no money and it appears in no WHERE clause
 * that does.
 */
export const walletDustIqdSql = (
  u: string,
  /**
   * `settledOnly` reads the remainders of APPROVED rows alone — the dinar
   * refinement of `settledUsdSql`, for the «الرصيد المسوّى» figure, which does
   * not subtract holds and so must not subtract a pending withdrawal's dinars
   * either. The default is the AVAILABLE reading every spend decision uses.
   */
  opts: { settledOnly?: boolean } = {}
) => `(SELECT COALESCE(SUM(
         (CASE WHEN t.type = 'deposit' THEN 1 ELSE -1 END) *
         CASE WHEN t.type = 'deposit' AND m.tx_id IS NOT NULL
              THEN MIN(
                     MAX(0, COALESCE(t.amount_iqd, m.declared_amount_iqd)
                            - (t.amount * COALESCE(t.exchange_rate_snapshot, m.exchange_rate_snapshot)) / 100),
                     (COALESCE(t.exchange_rate_snapshot, m.exchange_rate_snapshot) + 99) / 100 - 1
                   )
              ELSE MAX(0, COALESCE(t.amount_iqd, m.declared_amount_iqd)
                          - (t.amount * COALESCE(t.exchange_rate_snapshot, m.exchange_rate_snapshot)) / 100)
         END
       ),0)
       FROM wallet_transactions t
       LEFT JOIN wallet_deposit_meta m ON m.tx_id = t.id
      WHERE t.user_id = ${u} AND t.currency = 'USD'
        AND (t.status = 'approved'${
          opts.settledOnly
            ? ''
            : `
             OR EXISTS (SELECT 1 FROM wallet_holds h
                         WHERE h.tx_id = t.id AND h.user_id = t.user_id AND h.state = 'active')`
        })
        AND COALESCE(t.amount_iqd, m.declared_amount_iqd) > 0
        AND COALESCE(t.exchange_rate_snapshot, m.exchange_rate_snapshot) > 0)`;

export interface WalletDustReading {
  /** Signed sum of the per-row remainders above, in whole dinars. */
  dust_iqd: number;
  /**
   * Whether `wallet_transactions` actually has 0108's columns. False means the
   * Worker is live ahead of its database: the reading degraded to exactly the
   * pre-0108 behaviour, and callers must not try to WRITE those columns either.
   */
  ledger_dinars: boolean;
}

/** Set once 0108's columns are seen; see `walletLedgerDinarsReady`. */
let walletLedgerDinarsCache = false;

/**
 * Read the dust term, and say whether the database can carry it at all.
 *
 * A DEPLOY MAY LAND BEFORE ITS MIGRATION — that is the whole reason
 * worker/lib/schemaVersion.ts exists, and `requestWithdrawal` below already
 * builds its batch twice for the same reason. A balance query that throws
 * because 0108 has not run yet would take the wallet page, the checkout quote
 * and every affordability decision down at once. So the absence of the
 * columns is an ANSWER: dust 0, which is precisely how every balance read
 * before this existed. Anything that is NOT a missing-schema error propagates,
 * because a D1 outage must not be reported as "you have no dinars".
 */
export async function readWalletDust(db: D1Database, userId: string): Promise<WalletDustReading> {
  try {
    const row = await db
      .prepare(`SELECT ${walletDustIqdSql('?1')} AS dust_iqd`)
      .bind(userId)
      .first<{ dust_iqd: number }>();
    walletLedgerDinarsCache = true;
    return { dust_iqd: Number(row?.dust_iqd ?? 0) || 0, ledger_dinars: true };
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    console.error(
      `wallet_transactions is behind the deployment (0108 not applied): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
    return { dust_iqd: 0, ledger_dinars: false };
  }
}

/**
 * DOES THIS DATABASE CARRY 0108's LEDGER DINAR COLUMNS AT ALL?
 *
 * WHY A SECOND PROBE EXISTS. `readWalletDust` above answers the same question
 * as a side effect, but only for a caller that has a user id and wants a
 * balance. The REFUND path has neither: `cancelledOrderRefundStatements`
 * builds statements for an order, in a sweep that may hold hundreds of them,
 * and it must know whether it may name `amount_iqd` in an INSERT before it
 * writes one. Naming a column that is not there does not degrade — it aborts
 * the D1 batch that is cancelling the order and returning the money.
 *
 * MEMOISED, AND ONLY IN ONE DIRECTION. The columns cannot be dropped, so a
 * `true` is true for the life of the isolate and is cached. A `false` is
 * re-probed every time, because it means the migration has not landed YET and
 * the next request may be after it has — a cached `false` would keep a whole
 * isolate writing dinar-less refunds long after the database could hold them.
 * The probe is a single indexed-free `LIMIT 0` read of one row's shape.
 *
 * ANYTHING THAT IS NOT A MISSING COLUMN PROPAGATES AS `false` here rather than
 * throwing, because this question is asked while a refund batch is being
 * BUILT: a D1 blip must not turn a cancel into an exception. The refund still
 * posts, in the shape this file wrote before 0108 existed.
 */
export async function walletLedgerDinarsReady(db: D1Database): Promise<boolean> {
  if (walletLedgerDinarsCache) return true;
  try {
    await db.prepare('SELECT amount_iqd, exchange_rate_snapshot FROM wallet_transactions LIMIT 0').all();
    walletLedgerDinarsCache = true;
    return true;
  } catch (e) {
    if (!isSchemaMissing(e)) {
      console.error(
        `could not probe wallet_transactions for 0108's columns: ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return false;
  }
}

/**
 * THE ONE PLACE A WALLET BALANCE BECOMES DINARS. Every screen and every
 * affordability test reads this number and no other; nothing recomputes it.
 *
 *   balance_iqd = floor(available_cents × rate / 100)   ← unchanged, as always
 *               + the recorded remainders, never below zero
 *
 * THE INVARIANT, in one line, because it is what makes the design checkable:
 * THE DINAR BALANCE IS NEVER BELOW WHAT THE CENTS ALONE CONVERT TO. That is
 * the lower clamp, and it is why NO EXISTING BALANCE CAN FALL: a wallet whose
 * rows recorded nothing, or whose debits recorded more remainder than its
 * credits, reads exactly the figure every screen printed before 0108.
 *
 * THE UPPER CLAMP IS GONE, AND ITS REMOVAL IS THE FIX. It read
 * `Math.min(dust, Math.ceil(rate / 100))` and it defended itself with the
 * sentence «a customer with forty testified deposits still carries at most one
 * cent of remainder». That sentence was true and the clamp was still wrong,
 * for two separate reasons:
 *
 *   * IT DISCARDED HONEST DINARS. Two typed deposits of 25,000 د.ع lose 10 د.ع
 *     each to the floor. The honest remainder is 20; the clamp cut it to 14;
 *     the balance read 49,994 — the owner's own number — and the 50,000 د.ع
 *     printer advance was refused for the second time. The owner's customer is
 *     not hypothetical and neither is their second transfer.
 *   * IT WAS ONE DINAR TOO WIDE ANYWAY. `ceil(rate / 100)` is 14 at 1,400,
 *     while the widest a single floor() can miss by is 13 — so on a wallet
 *     with a single remainder it handed out one dinar more than any honest
 *     row could have carried.
 *
 * THE CEILING MOVED TO WHERE IT CAN TELL THE CASES APART: `walletDustIqdSql`
 * bounds what EACH ROW may contribute, at `ceil(row_rate / 100) − 1`. Forty
 * honest deposits keep forty honest remainders; one forged or
 * admin-reduced claim is cut to the largest remainder it could have been.
 * Summing first and clamping afterwards cannot make that distinction, which
 * is the whole reason the clamp used to be in this function and no longer is.
 *
 * AN EMPTY WALLET READS EMPTY. Zero available cents returns 0 whatever the
 * remainders say — dinars with no cents behind them are not a balance, and
 * this is also what makes a wallet spent down to nothing read 0 rather than
 * the few dinars its last deposit's remainder left behind.
 *
 * THE DOLLAR IS THE DERIVED FIGURE NOW, not the source: $ = floor(dinars ×
 * 100 / rate) / 100, so 50,000 د.ع shows as $35.71 — the owner's own example,
 * and the same floor 0106 settled on. The floor did not change. Its subject
 * did.
 */
export function walletIqdAvailable(availableCents: number, dustIqd: number, exchangeRate: number): number {
  const rate = Number.isFinite(exchangeRate) && exchangeRate > 0 ? Math.trunc(exchangeRate) : 0;
  if (!rate) return 0;
  const cents = Number.isFinite(availableCents) ? Math.trunc(availableCents) : 0;
  if (cents <= 0) return 0;
  const converted = Math.floor((cents * rate) / 100);
  // The only clamp left, and the one that protects every live balance: a
  // negative net remainder (a debit that recorded more dinars than the credits
  // it spent) reads as the plain cents conversion, never as less than it.
  const dust = Math.max(Number.isFinite(dustIqd) ? Math.trunc(dustIqd) : 0, 0);
  return converted + dust;
}

/**
 * WHAT A DINAR-QUOTED WALLET PAYMENT COSTS IN CENTS — the one conversion on
 * the spend side, and the counterpart of `walletIqdAvailable` on the read side.
 *
 * «وليس العكس» applied to a spend: the order, the membership and the store
 * cart are all priced in DINARS, the ledger moves in CENTS, and this is the
 * single place that turns one into the other. It FLOORS, for the reason the
 * whole change exists — `iqdToUsdCents`'s ceil asks for 3,572 cents to pay a
 * 50,000 د.ع bill out of the 3,571 cents that same 50,000 د.ع put in, and that
 * one cent is every refusal in the owner's report.
 *
 * AND IT NEVER ASKS FOR MORE CENTS THAN ARE THERE. The dinar balance may sit
 * up to one cent per testified deposit above what its cents convert to —
 * money the shop was transferred and did not credit — so a customer spending
 * their whole balance can name more dinars than the cents can fund. Capping
 * here is what turns that into a settled debt instead of a CHECK violation:
 * `usdSpendStatement` writes −1 and aborts the entire D1 batch when the amount
 * exceeds the balance, so an uncapped figure would not refuse the order, it
 * would fail it.
 *
 * WHO PAYS THE DIFFERENCE, stated plainly: the shop, at most one cent per
 * order — about 13 د.ع at 1,400 — and only ever out of dinars it already
 * received by bank transfer and floored away at deposit time. The ceil this
 * replaces put the same cent on the CUSTOMER and refused sales while doing it.
 *
 * ZERO CENTS IS ZERO PAYMENT. A dinar figure below one cent's worth converts
 * to no cents at all, and no ledger row can carry it: `CHECK (amount > 0)` on
 * `wallet_transactions` forbids a zero debit, so a caller that applied such a
 * figure would grant the discount with nothing debited. Callers must treat 0
 * here as "the wallet pays nothing", never as "the wallet pays for free".
 */
export function walletSpendCents(
  iqd: number,
  /**
   * The cents on hand, or NULL for "this caller holds no balance to cap
   * against". `quotePurchase` (worker/routes/memberships.ts) states what a
   * membership costs without knowing whose wallet will pay it, and a caller
   * that cannot cap must say so rather than pass a stand-in figure that
   * silently becomes a cap of zero.
   */
  availableCents: number | null,
  exchangeRate: number
): number {
  const rate = Number.isFinite(exchangeRate) && exchangeRate > 0 ? Math.trunc(exchangeRate) : 0;
  const dinars = Number.isFinite(iqd) ? Math.trunc(iqd) : 0;
  if (!rate || dinars <= 0) return 0;
  const cost = Math.floor((dinars * 100) / rate);
  if (availableCents === null || availableCents === undefined) return cost;
  const available = Number.isFinite(availableCents) ? Math.trunc(availableCents) : 0;
  if (available <= 0) return 0;
  return Math.min(cost, available);
}

/**
 * WHAT A WITHDRAWAL OF THE DISPLAYED BALANCE RESERVES — the withdrawal-side
 * twin of `walletSpendCents`' cap.
 *
 * THE CASE. Two typed deposits of 25,000 د.ع are 1,785 cents each: 3,570
 * cents, carrying two ten-dinar remainders, so the wallet reads exactly 50,000
 * (0108). The customer types 50,000 to withdraw it. The browser floors that to
 * 3,571 cents — one cent MORE than the wallet holds — and the hold refused the
 * customer's whole balance with «المبلغ يتجاوز رصيدك المتاح». Checkout already
 * caps the same way (`walletSpendCents`); the withdrawal did not.
 *
 * So, when and only when:
 *   * the customer typed dinars and the claim corroborates the cents they sent
 *     (`corroboratedDeclaredIqd` — the same check the testimony must pass),
 *   * those cents exceed the cents on hand, and
 *   * the typed dinars are still within the DINAR balance the page showed
 *     (`walletIqdAvailable` over the same cents and remainders),
 * the reservation is the cents on hand. Anything else returns the requested
 * cents unchanged and the hold refuses it exactly as before — a withdrawal
 * that is genuinely over the balance is still over the balance.
 *
 * WHO CARRIES THE DIFFERENCE is the same answer 0108 gives for a spend: the
 * shop, bounded by the remainders it floored away when the deposits came in —
 * money it was transferred and never credited. The typed figure is still what
 * the request records and what the payout card states.
 */
export function withdrawalReserveCents(p: {
  requestedCents: number;
  declaredIqd: number | null | undefined;
  availableCents: number;
  dustIqd: number;
  exchangeRate: number;
}): number {
  const requested = p.requestedCents;
  const available = Number.isFinite(p.availableCents) ? Math.trunc(p.availableCents) : 0;
  if (!isValidAmountCents(requested) || requested <= available || available <= 0) return requested;
  const claim = corroboratedDeclaredIqd(p.declaredIqd, requested, p.exchangeRate);
  if (claim.declared_amount_iqd === null) return requested;
  if (claim.declared_amount_iqd > walletIqdAvailable(available, p.dustIqd, p.exchangeRate)) return requested;
  return available;
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/**
 * Did a batch abort because one of ITS OWN guards fired — a CHECK, NOT NULL,
 * UNIQUE or PRIMARY KEY constraint — as opposed to failing for an unrelated
 * reason (a D1 outage, a network error)? A guard abort is an answer and is
 * classified by re-reading; anything else must propagate so the caller (and
 * the person behind it) sees a failure to retry, not a made-up refusal.
 */
export function isConstraintAbort(e: unknown): boolean {
  return /constraint/i.test(e instanceof Error ? e.message : String(e));
}

/** Largest amount any single wallet operation may carry (integer cents). */
export const MAX_AMOUNT_CENTS = 100_000_000;

/** Integer-cents money guard: no floats, no NaN, no negatives, no overflow. */
export function isValidAmountCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_AMOUNT_CENTS;
}

/**
 * DOES THE CUSTOMER'S OWN DINAR FIGURE MATCH THE CENTS THEY SENT?
 *
 * `declared_amount_iqd` (migrations 0105 and 0106) is TESTIMONY — the figure
 * the customer typed — and it is unvalidated client input. 0105's header
 * answered the hazard of a forged claim with «display reads the dinars», and
 * that answer was enough while the dinars sat beside the money. It is not
 * enough now: the figure became the HEADLINE a human reads before making an
 * outbound transfer, and display-reading is precisely how a human is misled.
 * A crafted request declaring 50,000,000 د.ع beside 100 cents reserved 100
 * cents and printed «50,000,000 د.ع» in 20px bold with «$1.00» in grey under
 * it. A withdrawal has no observed-amount reconciliation and no receipt, so
 * that card is the only number the payer has.
 *
 * So the claim is CORROBORATED BEFORE IT IS STORED, against the rate the
 * SERVER read at submit time and the cents the request actually carries: the
 * client's own conversion is re-run here and has to land on the same cent.
 *
 * THE WINDOW IS THE FLOOR OR THE CEIL OF THAT CONVERSION, AND NOTHING ELSE.
 * `iqdToUsdCents` (src/lib/api.ts) floors since the owner's «وعند الدولار
 * يقرب الى عدد صحيح اقل»; a browser still holding the PREVIOUS bundle ceils.
 * Those two are the only cent values an honest client can produce for a given
 * dinar figure at a given rate, and they are one apart. So `amountCents` is
 * accepted at the floor or one above it — never one BELOW, which no client
 * computes and which would let a request under-reserve against its own claim.
 * That is the entire space of legitimate disagreement here: 14 د.ع at 1,400.
 * Anything outside it is not a rounding difference. It is a different rate (a
 * tab left open while the owner moved it: src/WalletContext.tsx reads
 * /api/settings/public once on mount and never repolls) or a different number
 * entirely, and neither may be printed as the amount to pay.
 *
 * IT REFUSES THE TESTIMONY, NEVER THE MONEY. A claim that does not corroborate
 * is dropped to NULL and the request files exactly as it would have before
 * 0105/0106 existed — every reader then converts the stored cents, which are
 * derived from the hold and cannot be forged. Refusing the whole request was
 * the other option and was not taken: it would turn the owner moving the rate
 * mid-session into a failed payout request, and it would need a refusal
 * sentence that does not exist in Sorani, which may never be machine written.
 */
export function corroboratedDeclaredIqd(
  declaredAmountIqd: unknown,
  amountCents: unknown,
  exchangeRate: unknown
): { declared_amount_iqd: number | null; exchange_rate_snapshot: number | null } {
  const none = { declared_amount_iqd: null, exchange_rate_snapshot: null };
  if (!Number.isInteger(declaredAmountIqd) || (declaredAmountIqd as number) <= 0) return none;
  if (!Number.isInteger(exchangeRate) || (exchangeRate as number) <= 0) return none;
  if (!isValidAmountCents(amountCents)) return none;
  // The client's rule, re-run on this side. Floor, because that is what
  // `iqdToUsdCents` has done since the owner's instruction; `converted + 1` is
  // the ceil a client that has not reloaded yet still sends.
  const converted = Math.floor(((declaredAmountIqd as number) * 100) / (exchangeRate as number));
  if (amountCents !== converted && amountCents !== converted + 1) return none;
  return {
    declared_amount_iqd: declaredAmountIqd as number,
    exchange_rate_snapshot: exchangeRate as number,
  };
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
  p: {
    txId: string;
    userId: string;
    amountCents: number;
    note: string;
    ref: string;
    nowIso: string;
    /**
     * THE DINARS THIS DEBIT WAS DENOMINATED IN (migration 0108), when it was
     * denominated in dinars at all — a checkout advance is, a membership
     * charge computed in cents is not. Recording it is what makes the dust
     * term cancel: a wallet credited 50,000 د.ع and then spent 50,000 د.ع
     * reads zero rather than the six-dinar remainder of its own credit.
     *
     * TESTIMONY, NOT MONEY, exactly as 0105 and 0106 have it: `amountCents`
     * above is still the only figure the CASE guard compares and the only
     * figure the row's `amount` carries. Omit it and the statement is the one
     * this file has always written, byte for byte.
     */
    amountIqd?: number | null;
    exchangeRateSnapshot?: number | null;
  }
): D1PreparedStatement {
  const iqd = Number.isInteger(p.amountIqd) && (p.amountIqd as number) > 0 ? (p.amountIqd as number) : null;
  const rate =
    iqd !== null && Number.isInteger(p.exchangeRateSnapshot) && (p.exchangeRateSnapshot as number) > 0
      ? (p.exchangeRateSnapshot as number)
      : null;
  // The dinars travel only WITH the rate they were typed at: a figure with no
  // rate beside it cannot be converted by any later reader and would be a
  // claim nothing backs (the rule `corroboratedDeclaredIqd` already applies).
  if (iqd === null || rate === null) {
    return db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at)
         SELECT ?1, ?2, 'withdrawal', 'USD',
           CASE WHEN ${availableUsdSql('?2')} >= ?3 THEN ?3 ELSE -1 END,
           'approved', ?4, ?5, 'system', ?6`
      )
      .bind(p.txId, p.userId, p.amountCents, p.note, p.ref, p.nowIso);
  }
  return db
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
       SELECT ?1, ?2, 'withdrawal', 'USD',
         CASE WHEN ${availableUsdSql('?2')} >= ?3 THEN ?3 ELSE -1 END,
         'approved', ?4, ?5, 'system', ?6, ?7, ?8`
    )
    .bind(p.txId, p.userId, p.amountCents, p.note, p.ref, p.nowIso, iqd, rate);
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

/**
 * THE OTHER FOUR FIGURES ON THE WALLET PAGE, IN THE CUSTOMER'S DINARS.
 *
 * «إيداعات قيد المراجعة» showed IQD 49,994 the moment a customer typed 50,000
 * and pressed send — and «الرصيد المسوّى» showed 49,994 after approval, right
 * under a header that (since 0108) said 50,000. The page ran each of these
 * aggregates through `usdCentsToIqd(cents, rate)`, which is the conversion
 * 0108 exists to stop being the source: at 1,400 a cent is 14 د.ع and 50,000
 * has no cent value that reads back as 50,000.
 *
 * So each figure is summed from what its rows RECORDED, by the one rule 0108
 * states («a row's dinars are the dinars recorded on it; a row that recorded
 * none converts from its cents»):
 *
 *   pending deposits    Σ COALESCE(amount_iqd, declared_amount_iqd (0105),
 *                                  floor(cents × rate / 100))
 *   open withdrawals    Σ COALESCE(declared_amount_iqd (0106), floor(cents × rate / 100))
 *   held                Σ over the holds `effectiveHoldsUsdSql` counts, each
 *                       as its withdrawal's declared dinars, or its escrow's
 *                       `gross_iqd` — what the customer agreed to — or its
 *                       cents converted
 *   settled             `walletIqdAvailable(settled cents, the remainders of
 *                       APPROVED rows, rate)` — the same function the header
 *                       uses, over the settled sum instead of the spendable one
 *
 * DISPLAY ONLY. Nothing here reaches a spend guard; every guard still runs on
 * `availableUsdSql` and cents. A database behind on 0108 (no `amount_iqd`) or
 * one without `community_escrows` answers with the pre-0108 reading — every
 * figure converted from its cents — rather than failing the wallet page.
 */
export interface WalletDinarBreakdown {
  iqd_settled: number;
  iqd_held: number;
  iqd_pending_deposits: number;
  iqd_pending_withdrawals: number;
}

export async function getWalletDinarBreakdown(
  db: D1Database,
  userId: string,
  exchangeRate: number
): Promise<WalletDinarBreakdown> {
  const rate = Number.isFinite(exchangeRate) && exchangeRate > 0 ? Math.trunc(exchangeRate) : 0;
  const converted = (cents: number) => (rate ? Math.floor((Math.max(0, Number(cents) || 0) * rate) / 100) : 0);
  // `?2` is the rate for rows that recorded no dinars. Every CASE below keeps
  // a recorded figure only when it is a whole positive number — a NULL or a 0
  // falls through to the conversion rather than reading as "nothing".
  const sql = `SELECT
      ${settledUsdSql('?1')} AS settled_cents,
      ${walletDustIqdSql('?1', { settledOnly: true })} AS settled_dust,
      (SELECT COALESCE(SUM(COALESCE(
                CASE WHEN t.amount_iqd > 0 AND t.exchange_rate_snapshot > 0 THEN t.amount_iqd END,
                CASE WHEN m.declared_amount_iqd > 0 THEN m.declared_amount_iqd END,
                (t.amount * ?2) / 100)), 0)
         FROM wallet_transactions t
         LEFT JOIN wallet_deposit_meta m ON m.tx_id = t.id
        WHERE t.user_id = ?1 AND t.currency = 'USD' AND t.type = 'deposit' AND t.status = 'pending')
        AS pending_deposits_iqd,
      (SELECT COALESCE(SUM(COALESCE(
                CASE WHEN w.declared_amount_iqd > 0 THEN w.declared_amount_iqd END,
                (w.amount_cents * ?2) / 100)), 0)
         FROM wallet_withdrawals w
        WHERE w.user_id = ?1 AND w.state IN ('requested','approved','processing'))
        AS pending_withdrawals_iqd,
      (SELECT COALESCE(SUM(COALESCE(
                (SELECT CASE WHEN w.declared_amount_iqd > 0 THEN w.declared_amount_iqd END
                   FROM wallet_withdrawals w WHERE w.hold_id = hx.id),
                (SELECT CASE WHEN e.gross_iqd > 0 THEN e.gross_iqd END
                   FROM community_escrows e WHERE e.hold_id = hx.id),
                (hx.amount_cents * ?2) / 100)), 0)
         FROM wallet_holds hx
         LEFT JOIN wallet_transactions htx ON htx.id = hx.tx_id
        WHERE hx.user_id = ?1 AND hx.state = 'active'
          AND (hx.tx_id IS NULL OR htx.status <> 'approved'))
        AS held_iqd`;
  try {
    const row = await db
      .prepare(sql)
      .bind(userId, rate)
      .first<{
        settled_cents: number;
        settled_dust: number;
        pending_deposits_iqd: number;
        pending_withdrawals_iqd: number;
        held_iqd: number;
      }>();
    return {
      iqd_settled: walletIqdAvailable(Number(row?.settled_cents) || 0, Number(row?.settled_dust) || 0, rate),
      iqd_held: Number(row?.held_iqd) || 0,
      iqd_pending_deposits: Number(row?.pending_deposits_iqd) || 0,
      iqd_pending_withdrawals: Number(row?.pending_withdrawals_iqd) || 0,
    };
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    console.error(
      `the wallet schema is behind the deployment (dinar breakdown degraded): ${e instanceof Error ? e.message : String(e)}`
    );
    const b = await getWalletBreakdown(db, userId);
    return {
      iqd_settled: converted(b.usd_cents_settled),
      iqd_held: converted(b.usd_cents_held),
      iqd_pending_deposits: converted(b.usd_cents_pending_deposits),
      iqd_pending_withdrawals: converted(b.usd_cents_pending_withdrawals),
    };
  }
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
  /** `txId` is set by `commitHold`: the approved ledger debit the hold settled into. */
  | { ok: true; holdId: string; replayed: boolean; txId?: string }
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
    // A purchase hold is a payment authorisation (§3.8), and the event commits
    // WITH the reservation rather than after it: a crash between the two would
    // otherwise lose the only record that the money was authorised.
    const res = await db.batch([
      holdInsertStatement(db, holdId, kind, p),
      ...(kind === 'purchase' ? await holdAuthorizedEventStatements(db, holdId, p) : []),
    ]);
    if ((res[0]?.meta.changes ?? 0) > 0) {
      return { ok: true, holdId, replayed: false };
    }
  } catch {
    // A concurrent insert won the UNIQUE(user_id, kind, event_key) race; the
    // batch rolled back, so nothing partial was written.
  }
  const outcome = await classifyHoldFailure(db, kind, p);
  // A purchase hold is a payment authorisation; a withdrawal hold is not
  // (§3.8), so only the purchase side reports one.
  if (kind === 'purchase') await emitHoldOutcome(db, p, outcome);
  return outcome;
}

/**
 * The money events of 03-EVENTS.md §3.8-§3.10, published from the ONE place
 * that actually places, settles and refuses a purchase hold. Every one of
 * them starts with `busFor(db)`: with no bus configured — the live Worker
 * today — they return before doing anything at all, so the wallet path costs
 * exactly what it costs now.
 */
/**
 * Which refusals are a PAYMENT FAILURE, and which are not.
 *
 * `DUPLICATE_EVENT` is deliberately absent. It means "same (user, kind,
 * event_key), and the hold is no longer active" — i.e. the ordinary idempotent
 * replay of a request whose payment already SETTLED: a double tap, a client
 * retry, a proxy retry. Reporting that as `PaymentFailed{HOLD_CONFLICT}` would
 * feed every consumer counting payment failures a false negative about a
 * payment that succeeded, on the one path where being wrong about money is
 * least acceptable. The replay is silent, exactly as the successful-replay
 * branch above it is.
 *
 * `INVALID_AMOUNT` / `MISSING_EVENT_KEY` are absent too: nothing was attempted.
 */
const HOLD_FAILURE_REASON: Partial<Record<HoldFailure, 'INSUFFICIENT_FUNDS' | 'HOLD_CONFLICT' | 'STATE_CONFLICT'>> = {
  INSUFFICIENT_AVAILABLE: 'INSUFFICIENT_FUNDS',
  EVENT_KEY_REUSED: 'HOLD_CONFLICT',
  STATE_CONFLICT: 'STATE_CONFLICT',
};

/**
 * `PaymentAuthorized` (03-EVENTS.md §3.8) for the batch that is about to place
 * the hold, guarded by the hold row itself.
 *
 * `holdInsertStatement` is conditional — it reserves money that exists or
 * writes nothing — so the event has to carry the same condition, or a refused
 * reservation would still announce an authorisation. Append AFTER the insert;
 * returns `[]` while the bus is off.
 */
async function holdAuthorizedEventStatements(db: D1Database, holdId: string, p: CreateHoldInput): Promise<D1PreparedStatement[]> {
  if (!busFor(db)) return [];
  const pending = await outboxStatement(
    db,
    PaymentAuthorizedV1,
    {
      order_id: p.refType === 'order' ? (p.refId ?? null) : null,
      user_id: p.userId,
      kind: 'wallet_hold',
      currency: 'USD',
      amount: p.amountCents,
      hold_id: holdId,
      event_key: p.eventKey,
    },
    {
      aggregateId: p.userId,
      actorId: p.userId,
      guard: { sql: 'EXISTS (SELECT 1 FROM wallet_holds WHERE id = ?)', args: [holdId] },
    }
  );
  return pending ? [pending.statement] : [];
}

/** The REFUSAL half: a hold that was placed publishes its event from the batch, not from here. */
async function emitHoldOutcome(db: D1Database, p: CreateHoldInput, result: HoldResult): Promise<void> {
  if (!busFor(db)) return;
  const orderId = p.refType === 'order' ? (p.refId ?? null) : null;
  if (result.ok) return; // placed (in the batch) or replayed (already said once)
  const reason = HOLD_FAILURE_REASON[result.reason];
  if (!reason) return; // a replay, or a refusal that never reached the money
  await emitEvent(
    db,
    PaymentFailedV1,
    { order_id: orderId, user_id: p.userId, kind: 'wallet_hold', currency: 'USD', amount: p.amountCents, reason, event_key: p.eventKey },
    { aggregateId: p.userId, actorId: p.userId }
  );
}

/**
 * `PaymentCompleted` (03-EVENTS.md §3.9) FOR A BATCH THAT IS ABOUT TO POST THE
 * DEBIT — the settlement event, as statements to append rather than a write
 * that happens afterwards.
 *
 * Why statements and not `emitEvent`. The two paths that actually settle money
 * in production — `routes/storeOrders.ts` and `lib/escrowOps.ts` — call
 * `commitHoldStatements()` directly, because the debit has to ride in the
 * order's own batch. A settlement event published after that batch would be
 * lost by any crash in between, with no reconciliation path, and an event
 * emitted only from `commitHold()` would never be published by the paths that
 * really settle. So the event goes where the debit goes.
 *
 * The guard is the debit row itself: `commitHoldStatements` posts
 * `wallet_transactions.id = holdDebitTxId(holdId)` under a CHECK that aborts
 * the batch unless the hold is an active, still-funded reservation, so a row
 * with that id is the proof the money moved. Statement order matters — append
 * these AFTER `commitHoldStatements(...)`.
 *
 * Returns `[]` while the bus is off, which is every deployment until G2: no
 * read, no statement, no cost on the checkout path.
 */
export async function holdSettledEventStatements(db: D1Database, holdId: string): Promise<D1PreparedStatement[]> {
  if (!busFor(db)) return [];
  const txId = holdDebitTxId(holdId);
  const hold = await db
    .prepare('SELECT user_id, amount_cents, event_key, ref_type, ref_id FROM wallet_holds WHERE id = ?')
    .bind(holdId)
    .first<{ user_id: string; amount_cents: number; event_key: string; ref_type: string; ref_id: string }>();
  if (!hold) return [];
  const pending = await outboxStatement(
    db,
    PaymentCompletedV1,
    {
      order_id: hold.ref_type === 'order' ? (hold.ref_id || null) : null,
      user_id: hold.user_id,
      kind: 'wallet_debit',
      currency: 'USD',
      amount: hold.amount_cents,
      ledger_tx_ids: [txId],
      event_key: hold.event_key || txId,
    },
    {
      aggregateId: hold.user_id,
      actorId: null,
      guard: { sql: "EXISTS (SELECT 1 FROM wallet_transactions WHERE id = ? AND status = 'approved')", args: [txId] },
    }
  );
  return pending ? [pending.statement] : [];
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

/** The ledger row that carries a purchase hold's debit — one per hold, by construction. */
export const holdDebitTxId = (holdId: string) => `wtx_hold_${holdId}`;

/**
 * THE SETTLEMENT RULE: a committed purchase hold posts its ledger debit in
 * the same transaction, or it does not commit at all.
 *
 * WHY. A hold only RESERVES money: `effectiveHoldsUsdSql` subtracts active
 * holds from the spendable balance, and stops counting a hold the moment it
 * leaves `active`. Committing a hold without posting the debit therefore
 * hands the reserved money straight back to the buyer — the balance is
 * restored to what it was before the purchase while the merchant is credited
 * for it. That is exactly what the store checkout and the escrow release did
 * before this function existed: `commitHold` flipped the state and nothing
 * ever wrote the withdrawal row.
 *
 * The two statements are returned rather than executed so a caller with a
 * transaction of its own (the store order batch, the escrow settlement) can
 * append them and get order + payout + debit as one all-or-nothing write.
 *
 *  1. The debit. Its amount is the hold's own amount when the hold is still
 *     an ACTIVE, UNLINKED purchase hold and the reservation is still funded —
 *     settled minus the user's OTHER active holds covers it (this hold is
 *     added back because it is the very reservation being settled). In every
 *     other case the amount becomes -1, which violates CHECK (amount > 0)
 *     and aborts the whole batch: a released hold, an already-committed hold,
 *     a withdrawal hold (those settle through `markWithdrawalPaid`) and a
 *     hold whose money has somehow gone can none of them produce a debit.
 *  2. The flip, dependent on that debit existing, and linking the hold to it
 *     through `tx_id` so reconciliation can prove every committed hold paid.
 */
export function commitHoldStatements(
  db: D1Database,
  p: {
    holdId: string;
    note: string;
    ref: string;
    /**
     * THE DINARS THIS SETTLEMENT WAS DENOMINATED IN (migration 0108), and the
     * rate the hold's cents were computed at — the same pair `usdSpendStatement`
     * records on a checkout debit, for the same reason: a debit that records
     * the dinars it spent cancels the remainders of the credits that funded it,
     * so a wallet reads exactly its dinars after a community offer is paid.
     *
     * Pass them ONLY when the caller knows the database carries 0108's columns
     * (`walletLedgerDinarsReady`) — naming a column that is not there aborts
     * the whole settlement batch. Omit them and the statement is the one this
     * file has always written, byte for byte. Testimony, never money: the
     * debit's `amount` is still the hold's own cents.
     */
    amountIqd?: number | null;
    exchangeRateSnapshot?: number | null;
  }
): D1PreparedStatement[] {
  const txId = holdDebitTxId(p.holdId);
  const iqd = Number.isInteger(p.amountIqd) && (p.amountIqd as number) > 0 ? (p.amountIqd as number) : null;
  const rate =
    iqd !== null && Number.isInteger(p.exchangeRateSnapshot) && (p.exchangeRateSnapshot as number) > 0
      ? (p.exchangeRateSnapshot as number)
      : null;
  const dinars = iqd !== null && rate !== null;
  return [
    // `hh` — never `h`: the balance fragments alias wallet_holds as `h`
    // internally, and a same-named outer alias would make their correlation
    // bind to the inner table and sum every user's holds.
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at${
          dinars ? ', amount_iqd, exchange_rate_snapshot' : ''
        })
         SELECT ?1, hh.user_id, 'withdrawal', 'USD',
                CASE WHEN hh.state = 'active' AND hh.tx_id IS NULL AND hh.kind = 'purchase'
                          AND ${availableUsdSql('hh.user_id')} + hh.amount_cents >= hh.amount_cents
                     THEN hh.amount_cents ELSE -1 END,
                'approved', ?3, ?4, 'system', ${NOW_SQL}${dinars ? ', ?5, ?6' : ''}
           FROM wallet_holds hh
          WHERE hh.id = ?2`
      )
      .bind(...[txId, p.holdId, p.note.slice(0, 500), p.ref.slice(0, 120), ...(dinars ? [iqd, rate] : [])]),
    db
      .prepare(
        `UPDATE wallet_holds
            SET state='committed', committed_at=${NOW_SQL}, updated_at=${NOW_SQL}, tx_id=?2
          WHERE id = ?1 AND state = 'active' AND tx_id IS NULL
            AND EXISTS (SELECT 1 FROM wallet_transactions t
                         WHERE t.id = ?2 AND t.type = 'withdrawal' AND t.status = 'approved')`
      )
      .bind(p.holdId, txId),
  ];
}

/**
 * A batch fence on a hold's state: a no-op write when the hold is in
 * `state`, a NOT NULL violation (which aborts the enclosing batch) when it is
 * not. Lets a caller that released or committed a hold a statement earlier
 * refuse to continue when that statement quietly matched zero rows.
 */
export function assertHoldStateStatement(db: D1Database, holdId: string, state: HoldState): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE wallet_holds
          SET updated_at = CASE WHEN state = ?2 THEN updated_at ELSE NULL END
        WHERE id = ?1`
    )
    .bind(holdId, state);
}

/**
 * Settle a purchase hold: the reserved money leaves the balance exactly once,
 * as an approved `withdrawal` ledger row posted in the SAME transaction as
 * the state flip (see `commitHoldStatements`). Callers that already run a
 * batch append the statements instead of calling this.
 */
export async function commitHold(
  db: D1Database,
  p: { holdId: string; note?: string; ref?: string }
): Promise<HoldResult> {
  const txId = holdDebitTxId(p.holdId);
  try {
    // The settlement event rides in this batch too, guarded by the debit row,
    // so it commits with the money or not at all.
    const res = await db.batch([
      ...commitHoldStatements(db, { holdId: p.holdId, note: p.note ?? 'Purchase settled', ref: p.ref ?? '' }),
      ...(await holdSettledEventStatements(db, p.holdId)),
    ]);
    if ((res[1]?.meta.changes ?? 0) > 0) {
      return { ok: true, holdId: p.holdId, replayed: false, txId };
    }
  } catch (e) {
    // CHECK abort (not an active purchase hold) or a PRIMARY KEY replay of
    // the debit row: the batch rolled back, nothing partial was written.
    // Anything else is a real failure and is not a refusal.
    if (!isConstraintAbort(e)) throw e;
  }
  const row = await db
    .prepare('SELECT state, tx_id FROM wallet_holds WHERE id = ?')
    .bind(p.holdId)
    .first<{ state: HoldState; tx_id: string | null }>();
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.state === 'committed') {
    return row.tx_id
      ? { ok: true, holdId: p.holdId, replayed: true, txId: row.tx_id }
      : { ok: true, holdId: p.holdId, replayed: true };
  }
  return { ok: false, reason: 'STATE_CONFLICT', holdId: p.holdId };
}

/** The conditional release, for a caller that runs it inside its own batch. */
export function releaseHoldStatement(db: D1Database, p: { holdId: string; reason: string }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE wallet_holds
          SET state='released', released_at=${NOW_SQL}, updated_at=${NOW_SQL}, release_reason=?2
        WHERE id = ?1 AND state = 'active'`
    )
    .bind(p.holdId, p.reason.slice(0, 300));
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
  const res = await releaseHoldStatement(db, p).run();
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
 * THE WITHDRAWAL COMMISSION — «عمولة للسحب بقدر 3% قابله للتغيير من الادارة».
 *
 * THE DECISION §11.3 SAID HAD NOT BEEN MADE HAS NOW BEEN MADE. This block used
 * to be a frozen object declaring the opposite, and that was the right thing to
 * say while nobody had chosen a number: we refused to invent a percentage. The
 * owner has now named one, so the refusal is replaced rather than deleted, and
 * the two things it protected are kept.
 *
 * DEDUCTED, NOT ADDED ON TOP. A commission is ON the withdrawal, and the
 * schema settled the arithmetic years ago: `CHECK (net_cents = amount_cents -
 * fee_cents)` in migrations/0015_wallet_holds.sql. Request 100,000 د.ع at 3%
 * and 3,000 د.ع is the commission, 97,000 د.ع reaches the customer, and
 * 100,000 د.ع — the full requested figure — is what leaves the balance and what
 * the hold reserves. Adding on top would mean reserving amount+fee, which that
 * CHECK forbids and which would let the customer's available balance be
 * overdrawn by the fee.
 *
 * ONE COMPUTATION SITE. This function is the only place in the codebase that
 * multiplies money by a percentage. The form, the admin panel and the Telegram
 * card all READ what it produced — the form from GET /api/wallet/policy before
 * a request exists, everyone else from the columns stored on the row — because
 * a form doing its own 3% would show the customer one number while the ledger
 * wrote another, and the CHECK above would not catch it: the server's own
 * arithmetic would still be self-consistent.
 *
 * THE STORED QUOTE IS A SNAPSHOT, exactly like `orders.cod_tax_iqd`. The rate
 * is read once, at the moment the request is filed, and written into
 * fee_cents/net_cents/fee_policy. Changing the rate tomorrow must never alter
 * a request that is already on the books — and a request filed before any rate
 * existed keeps fee_cents = 0 and fee_policy 'not_configured', which is why
 * every customer-facing sentence about a fee is driven off the ROW'S OWN
 * fee_policy and never off today's setting.
 *
 * FLOOR, NOT CEIL. The rounding error goes to the customer, the mirror of the
 * deposit rule: a fee is rounded down, so the shop never takes a dinar more
 * than the percentage it published.
 */
export const DEFAULT_WITHDRAWAL_FEE_BPS = 300;

/** Basis points, so 2.5% is expressible without a float. 5000 = 50% is the
 *  ceiling: past that the "commission" is most of the money. */
export const MAX_WITHDRAWAL_FEE_BPS = 5000;

/** An owner-typed rate, reduced to something this engine will multiply by. A
 *  missing or nonsensical value is 0 — no fee — never an invented default. */
export function normalizeWithdrawalFeeBps(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, MAX_WITHDRAWAL_FEE_BPS);
}

/** No live payout channel is wired; paid is still recorded by a human. */
export const WITHDRAWAL_LIVE_PAYOUT = false;

export type WithdrawalFeePolicy = 'not_configured' | 'percent_bps';

export interface FeeQuote {
  amount_cents: number;
  fee_cents: number;
  net_cents: number;
  fee_bps: number;
  fee_policy: WithdrawalFeePolicy;
  fee_configured: boolean;
}

export function withdrawalFeeQuote(amountCents: number, feeBps: unknown = 0): FeeQuote {
  const bps = normalizeWithdrawalFeeBps(feeBps);
  if (bps === 0) {
    // 0 is a real setting and means the commission is switched off — the same
    // thing codTaxPerBlockIqd = 0 means. The row records that it was filed
    // under no policy, so no later screen can claim a fee was charged on it.
    return {
      amount_cents: amountCents,
      fee_cents: 0,
      net_cents: amountCents,
      fee_bps: 0,
      fee_policy: 'not_configured',
      fee_configured: false,
    };
  }
  const fee = Math.floor((amountCents * bps) / 10_000);
  return {
    amount_cents: amountCents,
    fee_cents: fee,
    net_cents: amountCents - fee,
    fee_bps: bps,
    fee_policy: 'percent_bps',
    fee_configured: true,
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
  /**
   * The channel's NAME as the owner configured it at the moment of filing
   * («زين كاش», «استلام كاش» …), resolved server-side from `payoutMethods` —
   * never from the request body. Frozen with the rest of the destination
   * (migration 0112) so a renamed channel cannot rewrite an open request.
   */
  label?: string;
}

export interface RequestWithdrawalInput {
  userId: string;
  amountCents: number;
  destination: WithdrawalDestination;
  /** Client idempotency key; the stored business key also pins the amount. */
  eventKey: string;
  note?: string;
  /**
   * The commission rate in basis points, read from the setting by the route
   * and passed in ONCE. It is quoted here and written onto the row as a
   * snapshot, so changing the rate tomorrow cannot alter a filed request.
   */
  feeBps?: number;
  /**
   * WHAT THE CUSTOMER TYPED, WHEN THEY TYPED DINARS (migration 0106).
   *
   * `amountCents` above stays the authoritative figure and the only one the
   * hold, the debit and the fee quote are ever computed from. This is the
   * customer's own claim about the amount they asked for, recorded verbatim
   * because the cents cannot be converted back to it: at 1,400 IQD/USD a cent
   * is 14 د.ع, so 50,000 has no cent value that reads back as 50,000.
   * Optional — an older client that does not send it files exactly as before
   * and the column reads NULL, which is the truth about that row.
   */
  declaredAmountIqd?: number;
  /** The rate the cents were computed at — the SERVER's rate at submit time,
   *  which is also what the declared figure is checked against. Stored only
   *  beside a figure it corroborates. Written once here, never recomputed at
   *  display time. */
  exchangeRateSnapshot?: number;
  /**
   * The cents the customer's OWN conversion produced, when the route reserved
   * fewer (`withdrawalReserveCents` — the whole-balance cap). The typed claim
   * is corroborated against THESE, because that is the number the browser
   * derived from it; `amountCents` stays what is held and debited. Never
   * below `amountCents`: a claim may only ever be reserved at or under what
   * it asked for. Absent means "the same as `amountCents`".
   */
  claimCents?: number;
}

export type WithdrawalOpResult =
  | { ok: true; id: string; replayed: boolean }
  | { ok: false; reason: WithdrawalFailure; id?: string };

export interface PayoutChannel {
  id: string;
  /** The name to freeze onto the request as `destination_label`. */
  label: string;
  /** False only for a channel the owner marked as needing no account (cash pickup). */
  requires_account: boolean;
}

/**
 * WHICH CHANNEL A WITHDRAWAL IS PAID THROUGH, resolved on the SERVER from the
 * owner's own settings — the request body names an id and nothing else, so a
 * client can neither invent a channel name nor waive the account number of a
 * channel that needs one.
 *
 * ONLY the owner's `payoutMethods`. This used to fall back to the deposit
 * `paymentMethods` and to four legacy ids (manual_transfer, zaincash, fib,
 * bank_account), so a channel the owner DELETED in the admin editor — or FIB,
 * which the shop never offered — could still be filed from a stale tab or a
 * hand-made request. `normalizePayoutMethods` never returns an empty list, so
 * there is always something to choose. Old requests keep the name frozen on
 * them (`destination_label`) and the pages name older ones by id for display
 * only; that lookup never decides what may be FILED.
 *
 * An id not on the list is `null`, and the route refuses it: a transfer
 * through a channel the owner no longer pays through is not a request a human
 * can pay.
 */
export function resolvePayoutChannel(kind: string, payoutMethods: ReadonlyArray<PayoutMethod>): PayoutChannel | null {
  const id = (kind ?? '').trim();
  if (!id) return null;
  const payout = payoutMethods.find((m) => m.id === id);
  return payout ? { id, label: payout.name, requires_account: payout.requires_account !== false } : null;
}

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
  const quote = withdrawalFeeQuote(p.amountCents, p.feeBps);
  /**
   * `CHECK (net_cents > 0)` lives in migrations/0015_wallet_holds.sql, and a
   * fee configured at or near 100% would hit it as an unhandled D1 exception
   * in the middle of a money batch. It is caught here instead and refused
   * cleanly: a withdrawal whose whole value is commission is not a withdrawal.
   */
  if (quote.net_cents <= 0) return { ok: false, reason: 'INVALID_AMOUNT' };
  /**
   * Recorded only when it is a whole, positive dinar figure AND the rate it
   * arrived with converts it back onto the cents this request actually
   * carries — `corroboratedDeclaredIqd` above says why that second half is
   * not optional now that the figure is the headline on a payout card.
   * Anything else is stored as NULL rather than as a repaired number: a
   * column whose whole job is to say what the customer typed must not contain
   * something nobody typed, and must not carry a claim nothing backs. The
   * rate follows the figure and never travels alone.
   */
  const claimCents =
    isValidAmountCents(p.claimCents) && (p.claimCents as number) >= p.amountCents ? (p.claimCents as number) : p.amountCents;
  const { declared_amount_iqd: declaredIqd, exchange_rate_snapshot: rateSnapshot } = corroboratedDeclaredIqd(
    p.declaredAmountIqd,
    claimCents,
    p.exchangeRateSnapshot
  );
  /**
   * WHAT THE CUSTOMER WAS PROMISED, IN THE DINARS THEY TYPED (migration 0112).
   *
   * The form shows «commission 1,500 · net 48,500» for a typed 50,000 at 3% —
   * arithmetic over the typed figure at the same basis points this quote used.
   * The admin «Transfer» box converted `net_cents` back at TODAY's rate and
   * read 48,496. The payout is now written down in the customer's own terms,
   * once, here, beside the cents: fee = floor(declared × bps / 10000), the
   * same floor `withdrawalFeeQuote` applies to the cents, so the rounding
   * still goes to the customer. Only beside a corroborated figure — a request
   * with no testimony has no dinar promise to record.
   */
  const feeIqd =
    declaredIqd === null ? null : quote.fee_policy === 'percent_bps' ? Math.floor((declaredIqd * quote.fee_bps) / 10_000) : 0;
  const netIqd = declaredIqd === null || feeIqd === null ? null : declaredIqd - feeIqd;
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

  /**
   * THE BATCH, BUILT TWICE-ABLE.
   *
   * TWO FLAGS, AND THEY DEGRADE IN ORDER. `withLedgerDinars` false rebuilds
   * the LEDGER insert without the two columns migration 0108 adds to
   * `wallet_transactions`; `withDeclared` false rebuilds the REQUEST insert
   * without the two migration 0106 adds to `wallet_withdrawals`. It is not a
   * style choice — see `runMoneyBatch` below.
   *
   * SEPARATE, BECAUSE A DATABASE IS BEHIND BY MIGRATIONS AND NOT BY ERAS. D1
   * says «no such column» without saying which table it meant, so the retry
   * ladder drops the NEWEST testimony first and only then the older one. One
   * shared flag would have thrown away a withdrawal's 0106 record — already
   * applied, already populated, and the only number on the payout card a human
   * reads before making a transfer — because an unrelated migration was a
   * deploy late.
   */
  const buildStatements = (withDeclared: boolean, withLedgerDinars: boolean, withPayoutChannel: boolean) => [
    holdInsertStatement(db, holdId, 'withdrawal', holdInput),
    // Ledger row: pending until an actual payout is recorded. Dependent on
    // the hold having been created by the statement above.
    db
      .prepare(
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, account_number, ref, created_by${
          withLedgerDinars ? ', amount_iqd, exchange_rate_snapshot' : ''
        })
         SELECT ?1, ?2, 'withdrawal', 'USD', ?3, 'pending', ?4, ?5, ?6, 'user'${
           withLedgerDinars ? ', ?8, ?9' : ''
         }
          WHERE EXISTS (SELECT 1 FROM wallet_holds h WHERE h.id = ?7 AND h.state = 'active')`
      )
      .bind(
        ...[
          txId,
          p.userId,
          p.amountCents,
          (p.note ?? '').slice(0, 500),
          p.destination.account.slice(0, 100),
          wdId,
          holdId,
          /**
           * THE DINARS ON THE LEDGER ROW TOO (migration 0108), not only on the
           * request row 0106 gave them. The request row is the payout card;
           * the LEDGER row is what a balance is summed from, and a withdrawal
           * whose dinars are not on it leaves the deposit's remainder behind
           * as orphan dinars when a customer empties their wallet. Same
           * corroborated pair, written once, read by `walletDustIqdSql`.
           */
          ...(withLedgerDinars ? [declaredIqd, rateSnapshot] : []),
        ]
      ),
    // Request row with the destination frozen at confirmation.
    db
      .prepare(
        `INSERT INTO wallet_withdrawals
           (id, user_id, tx_id, hold_id, amount_cents, fee_cents, net_cents, fee_policy,
            destination_kind, destination_account, destination_holder, destination_note,
            ${withDeclared ? 'declared_amount_iqd, exchange_rate_snapshot,' : ''}
            ${withPayoutChannel ? 'destination_label, fee_iqd, net_iqd,' : ''}
            destination_frozen_at, state, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ${
           withDeclared ? '?13, ?14, ' : ''
         }${withPayoutChannel ? (withDeclared ? '?15, ?16, ?17, ' : '?13, ?14, ?15, ') : ''}${NOW_SQL}, 'requested', ${NOW_SQL}, ${NOW_SQL}
          WHERE EXISTS (SELECT 1 FROM wallet_holds h WHERE h.id = ?4 AND h.state = 'active')
            AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?3)`
      )
      .bind(
        ...[
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
          (p.destination.note ?? '').slice(0, 300),
          ...(withDeclared ? [declaredIqd, rateSnapshot] : []),
          ...(withPayoutChannel
            ? [(p.destination.label ?? '').trim().slice(0, 60) || null, feeIqd, netIqd]
            : []),
        ]
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

  /**
   * THE DEPLOY WINDOW, WHICH THIS FUNCTION MUST SURVIVE RATHER THAN BLAME THE
   * CUSTOMER FOR.
   *
   * Between a Worker going live and `0106_withdrawal_declared_iqd.sql` being
   * applied, this INSERT names two columns the database does not have. D1
   * aborts the WHOLE batch, the `catch` below sees an exception it was written
   * to read as a UNIQUE race, `classifyHoldFailure` finds no hold — because
   * the batch rolled back — and answers INSUFFICIENT_AVAILABLE. The customer
   * is told «Withdrawal exceeds your available balance» while holding $10,000,
   * on every withdrawal, for the length of the window. Nothing is corrupted;
   * the batch is atomic and writes nothing. It is a false refusal, and a false
   * refusal about someone's own money is not an acceptable deploy cost.
   *
   * `EXPECTED_MIGRATION` (worker/lib/schemaVersion.ts) does not prevent this:
   * it is surfaced as a health alarm in worker/routes/misc.ts and blocks
   * nothing. So the batch is retried ONCE without the two columns, and only
   * for the one error that means exactly this — `isSchemaMissing` matches
   * SQLite's INSERT wording, «table … has no column named …». Every other
   * failure falls through to the classifier untouched.
   *
   * The retry files the request the way it filed before 0106 existed: the
   * testimony is lost (the column is not there to hold it), the MONEY is
   * identical, and once the migration lands the next request records it again.
   * This mirrors `cartLineSelect` in worker/lib/cartLineProjection.ts, which
   * is the same answer to the same deploy ordering on the read side.
   */
  const runMoneyBatch = async (): Promise<D1Result[] | null> => {
    /**
     * THE LADDER: full testimony, then without 0112's channel name and dinar
     * payout, then without 0108's ledger columns, then without 0106's request
     * columns either — newest first, always. Each rung is tried only when the
     * one above failed for a MISSING COLUMN — a UNIQUE race or a D1 outage
     * stops the ladder immediately, because retrying a money batch that failed
     * for any other reason is how one request becomes two payouts.
     */
    const rungs: Array<[boolean, boolean, boolean]> = [
      [true, true, true],
      [true, true, false],
      [true, false, false],
      [false, false, false],
    ];
    for (let i = 0; i < rungs.length; i += 1) {
      try {
        return await db.batch(buildStatements(rungs[i][0], rungs[i][1], rungs[i][2]));
      } catch (e) {
        if (!isSchemaMissing(e)) return null; // UNIQUE race → classify below.
        console.error(
          `the wallet schema is behind the deployment (0106/0108/0112 not applied): ${
            e instanceof Error ? e.message : String(e)
          }`
        );
      }
    }
    return null;
  };
  const res = await runMoneyBatch();
  if (res && (res[0]?.meta.changes ?? 0) > 0) return { ok: true, id: wdId, replayed: false };
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
  /** Migration 0106 — the typed dinars, or NULL for a row filed before it,
   *  filed during the window before it was applied, or filed with a claim the
   *  server's own rate did not corroborate. Testimony: read for display,
   *  never converted back into money. */
  declared_amount_iqd: number | null;
  exchange_rate_snapshot: number | null;
  /** Migration 0112 — the channel's name at filing, and the dinar commission
   *  and payout the customer was quoted. NULL on a row filed before 0112, or
   *  (the two figures) beside no corroborated dinar claim; `undefined` on a
   *  database that has not run 0112 at all. */
  destination_label?: string | null;
  fee_iqd?: number | null;
  net_iqd?: number | null;
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
  /**
   * THE DINARS THE CUSTOMER ACTUALLY TYPED (migration 0105), or undefined when
   * they typed dollars. It is TESTIMONY, not money: nothing here derives a
   * cent figure from it, `amountCents` stays the only thing a credit is
   * computed from, and `depositAmountReview` keeps comparing cents to cents.
   * It exists because the cent value cannot be converted back — at a rate of
   * 1,400 only multiples of 14 د.ع are representable, so a customer who typed
   * 50,000 was shown 50,008 everywhere.
   */
  declaredAmountIqd?: number;
  /** The rate the cents above were computed at; stored beside the dinars so a
   *  reviewer never has to guess what the setting was that week. */
  exchangeRateSnapshot?: number;
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
  /**
   * Recorded only when it is a whole, positive dinar figure that the filed
   * rate converts back onto these cents — the SAME corroboration the
   * withdrawal side applies, because the same crafted claim reaches the same
   * admin card. Anything else is stored as NULL rather than as a repaired
   * number: a column whose whole job is to say what the customer typed must
   * not contain something nobody typed.
   */
  const { declared_amount_iqd: declaredIqd, exchange_rate_snapshot: rateSnapshot } = corroboratedDeclaredIqd(
    p.declaredAmountIqd,
    p.amountCents,
    p.exchangeRateSnapshot
  );

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
  /**
   * BUILT TWICE-ABLE, for the same reason `requestWithdrawal` is below: a
   * Worker can reach production ahead of its migration. `withLedgerDinars`
   * false rebuilds the ledger INSERT without the two columns 0108 adds, and
   * the request then files exactly as it did before 0108 existed — the meta
   * row still records the typed dinars (0105), so nothing is lost but the
   * dust term, which reads 0 on that database anyway.
   */
  const buildStatements = (withLedgerDinars: boolean) => [
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
        `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, payment_method, receipt_key, ref, created_by${
          withLedgerDinars ? ', amount_iqd, exchange_rate_snapshot' : ''
        })
         SELECT ?1, ?2, 'deposit', 'USD', ?3, 'pending', ?4, ?5, ?6, ?7, 'user'${
           withLedgerDinars ? ', ?11, ?12' : ''
         }
          WHERE NOT EXISTS (
            SELECT 1 FROM wallet_deposit_meta m
             WHERE m.provider = ?8 AND m.channel = ?9 AND m.reference_norm = ?10
               AND m.reference_norm <> '' AND m.dedup_active = 1)`
      )
      .bind(
        ...[
          txId,
          p.userId,
          p.amountCents,
          (p.note ?? '').slice(0, 500),
          (p.paymentMethod ?? '').slice(0, 60),
          p.receiptKey,
          reference,
          provider,
          channel,
          referenceNorm,
          // The SAME corroborated pair the meta row below records — never a
          // second, differently-filtered copy of the customer's claim.
          ...(withLedgerDinars ? [declaredIqd, rateSnapshot] : []),
        ]
      ),
    db
      .prepare(
        `INSERT INTO wallet_deposit_meta
           (tx_id, user_id, provider, channel, reference, reference_norm, attachment_fingerprint,
            declared_amount_cents, review_state, declared_amount_iqd, exchange_rate_snapshot,
            created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ${NOW_SQL}, ${NOW_SQL}
          WHERE EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.id = ?1)`
      )
      .bind(
        txId,
        p.userId,
        provider,
        channel,
        reference,
        referenceNorm,
        fingerprint,
        p.amountCents,
        reviewState,
        declaredIqd,
        rateSnapshot
      ),
  ];

  try {
    const res = await db.batch(buildStatements(true));
    if ((res[1]?.meta.changes ?? 0) > 0) return { ok: true, txId, reviewState };
  } catch (e) {
    // UNIQUE(provider, channel, reference_norm) race — batch rolled back.
    // A database behind on 0108 is a different thing entirely, and answering
    // it with «this reference was already submitted» would tell the customer
    // their transfer was a duplicate when the deploy is simply early.
    if (isSchemaMissing(e)) {
      console.error(
        `wallet_transactions is behind the deployment (0108 not applied): ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      try {
        const res = await db.batch(buildStatements(false));
        if ((res[1]?.meta.changes ?? 0) > 0) return { ok: true, txId, reviewState };
      } catch {
        // Fall through to the duplicate answer below.
      }
    }
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
  | 'ledger_debit_without_paid_withdrawal'
  /**
   * A hold that left `active` as committed but never posted (or never
   * linked) its approved debit: the reserved money went back to the buyer's
   * spendable balance while the other side of the sale was still paid. Rows
   * like this were written by the pre-settlement-rule store checkout and
   * escrow release; they are REPORTED here for the owner to decide on, never
   * rewritten.
   */
  | 'committed_hold_without_debit';

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
    /** Money committed out of holds that never reached the ledger (legacy leak). */
    committed_without_debit_usd_cents: number;
  };
  /** Reserved money must equal the open withdrawal requests it belongs to. */
  sums_match: boolean;
  /** How many committed holds carry no approved debit (the `committed_hold_without_debit` rows). */
  committed_holds_without_debit: number;
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

  const [totalsRow, negatives, withdrawals, orphanDebits, unpaidCommits, userCount] = await Promise.all([
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
             WHERE currency='USD' AND type='deposit' AND status='pending') AS pending_deposits_usd_cents,
           (SELECT COALESCE(SUM(h.amount_cents),0) FROM wallet_holds h
             LEFT JOIN wallet_transactions ht ON ht.id = h.tx_id
            WHERE h.state='committed' AND (h.tx_id IS NULL OR ht.status IS NULL OR ht.status <> 'approved'))
             AS committed_without_debit_usd_cents`
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
    // The settlement rule's own invariant: a committed hold carries an
    // approved debit. Rows that do not are the legacy leak (store orders and
    // escrow releases committed before the rule) — reported, never repaired.
    db
      .prepare(
        `SELECT h.id, h.user_id, h.kind, h.amount_cents, h.ref_type, h.ref_id, h.tx_id, t.status AS tx_status
           FROM wallet_holds h
           LEFT JOIN wallet_transactions t ON t.id = h.tx_id
          WHERE h.state = 'committed' AND (h.tx_id IS NULL OR t.status IS NULL OR t.status <> 'approved')
          ORDER BY h.committed_at DESC
          LIMIT 200`
      )
      .all<{
        id: string;
        user_id: string;
        kind: HoldKind;
        amount_cents: number;
        ref_type: string;
        ref_id: string;
        tx_id: string | null;
        tx_status: string | null;
      }>(),
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
  for (const h of unpaidCommits.results ?? []) {
    anomalies.push({
      kind: 'committed_hold_without_debit',
      user_id: h.user_id,
      ref: h.id,
      detail: `${h.kind} hold of ${h.amount_cents} (${h.ref_type || 'no ref'} ${h.ref_id}) committed with ${
        h.tx_id ? `ledger row ${h.tx_id} in status ${h.tx_status ?? 'missing'}` : 'no ledger debit'
      } — the reserved money returned to the buyer's spendable balance`,
    });
  }

  const totals = totalsRow ?? {
    settled_usd_cents: 0,
    active_holds_usd_cents: 0,
    withdrawal_holds_usd_cents: 0,
    open_withdrawals_usd_cents: 0,
    pending_deposits_usd_cents: 0,
    committed_without_debit_usd_cents: 0,
  };

  return {
    ran_at: ranAt,
    checked_withdrawals: withdrawals.results?.length ?? 0,
    checked_users: userCount?.n ?? 0,
    totals,
    sums_match: totals.withdrawal_holds_usd_cents === totals.open_withdrawals_usd_cents,
    committed_holds_without_debit: unpaidCommits.results?.length ?? 0,
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
