/**
 * THE ONE-TIME WALLET REBASE ONTO THE OFFICIAL RATE (owner 2026-10-18,
 * DECISIONS row 252: «keep the existing balances' value in dinars»).
 *
 * Wallet money is stored in US cents, and it was credited at the legacy rate
 * L (the `exchangeRate` setting, 1,400). The shop's one official rate is the
 * applied rate U (~1,680). Read at U, every balance would be worth U / L more
 * dinars: 50,000 د.ع deposited → $35.71 → 60,000 د.ع. So, once, every wallet's
 * cents are rescaled by L / U and its dinar reading stays EXACTLY what the
 * customer saw (50,000 stays 50,000). From then on every operation uses U.
 *
 * ONE D1 BATCH, ONE TRANSACTION, SET-BASED. The batch writes the marker row
 * (migration 0202) FIRST — a plain INSERT on a one-row table, so a second run,
 * concurrent or later, aborts on its primary key and changes nothing — then
 * every statement below as `INSERT … SELECT` / `UPDATE … SET`, so the batch is
 * the same thirteen statements whatever the number of wallets. Until the marker
 * exists `getOfficialUsdRate` returns L (worker/lib/fx/officialRate.ts): there
 * is never a moment when a balance is read at U before it was rescaled.
 *
 * WHAT IS RESCALED, per wallet that holds money:
 *   1. The SETTLED balance S, through two ledger rows (ref `RATE_REBASE`) so
 *      no historical row is rewritten: a debit of S cents recording its dinars
 *      at L, and a credit of S' = floor(S × L / U) cents (never below the
 *      rescaled holds it carries) recording its dinars at U. The credit records exactly the dinars that make the dinar
 *      reading (`walletIqdAvailable`: cents at U + the recorded remainders,
 *      migration 0108) equal the reading before the rebase, to the dinar.
 *   2. Every active hold that still reserves money, and what it reserves for:
 *      the open withdrawal request (amount, fee, net) and its pending ledger
 *      row, and a Quick Buy session's held cents and rate.
 *   3. Every pending deposit and its review record: at most the cents its
 *      typed dinars are worth at U (a deposit of those dinars filed today),
 *      never more than its cents rescaled and rounded up.
 * Recorded dinars (`amount_iqd`, declared and gross dinars, escrows, orders)
 * never change, and no order or settled transaction is rewritten.
 *
 * ROUNDING — NEVER CREATE MONEY, NEVER LOSE A DINAR OF THE BALANCE. The
 * settled balance is rounded DOWN to the cent (the shop never creates value);
 * the sub-cent remainder that loses (at most 16 د.ع at 1,680) is recorded as
 * the credit's dinars, the same remainder mechanism 0108 uses for every
 * deposit, so the balance the customer reads is unchanged to the dinar. A
 * reservation (a hold, a withdrawal request) is rounded UP to the cent so it
 * still covers the dinars it was placed for at U, and comes out of the
 * rounded-down settled balance, so released it gives back no more than was
 * there; a withdrawal's fee is rounded down. Only a wallet whose free balance
 * is smaller than its reservations' rounding keeps them whole (≤ 1 cent each). A wallet whose whole balance is under one cent at U (13 د.ع or
 * less) reads 0, as any such wallet always has.
 *
 * WHEN IT RUNS: automatically, on the every-minute tick (worker/index.ts),
 * guarded by the marker — so within a minute of the deploy that brings it,
 * and never again. It needs no person: the owner already decided, and an
 * admin button would only leave a window in which the code is live but the
 * wallet still waits on someone. Without an applied rate there is nothing to
 * move to and it waits; with U equal to L it only writes the marker.
 */
import type { Env } from '../types';
import { effectiveHoldsUsdSql, settledUsdSql, availableUsdSql, walletDustIqdSql } from '../walletOps';
import { getAppliedUsdRate, wholeDinarRate } from './displayRate';
import { legacyUsdRate, walletRateRebased } from './officialRate';
import { isSchemaMissing } from '../membershipBenefits';

export const RATE_REBASE_REF = 'RATE_REBASE';
const NOTE = 'Official exchange rate: balance kept in dinars';

export type WalletRateRebaseResult =
  | { status: 'already' | 'no_official_rate' | 'unavailable' }
  | { status: 'rebased'; legacyRate: number; officialRate: number; wallets: number };

const E = 'wallet_rate_rebase_entries';
/** H' — what this wallet's reservations hold once rescaled (read after step 3). */
const H_AFTER = effectiveHoldsUsdSql('e.user_id');
/** S' — the settled balance at U, rounded down; never below the reservations it carries. */
const S_AFTER = `MAX((e.settled_cents_before * ?1) / ?2, ${H_AFTER})`;
/** A reservation at U, rounded up so it still covers its dinars. */
const UP = (x: string) => `((${x} * ?1 + ?2 - 1) / ?2)`;
/** A pending deposit at U: what its typed dinars buy today, never more than its cents rescaled up; ≥ 1. */
const DEPOSIT = (cents: string, iqd: string) =>
  `(CASE WHEN COALESCE(${iqd}, 0) > 0 THEN MAX(1, MIN((${iqd} * 100) / ?2, ${UP(cents)})) ELSE MAX(1, (${cents} * ?1) / ?2) END)`;
/** The dinars a pending deposit row testifies to: its own, or its review record's (0105). */
const TX_IQD = `COALESCE(wallet_transactions.amount_iqd, (SELECT m.declared_amount_iqd FROM wallet_deposit_meta m WHERE m.tx_id = wallet_transactions.id))`;
/** Users whose settled balance is rescaled (holds can only reserve settled money). */
const SETTLED_USERS = `(SELECT user_id FROM ${E} WHERE settled_cents_before > 0)`;

/**
 * The batch, in order. ?1 = L, ?2 = U, ?3 = now, ?4 = the ledger note. The two
 * rates are CAST to INTEGER where they are used: a bound JavaScript number may
 * arrive as a REAL, and every division here must floor like the wallet does.
 */
export function walletRateRebaseSql(): string[] {
  return rebaseStatements().map((sql) => sql.replace(/\?([12])\b/g, 'CAST(?$1 AS INTEGER)'));
}

function rebaseStatements(): string[] {
  return [
    // 0. The marker FIRST: a second run aborts here, on the primary key, before anything moves.
    `INSERT INTO wallet_rate_rebase (id, legacy_rate, official_rate, wallets, rebased_at) VALUES (1, ?1, ?2, 0, ?3)`,
    // 1. What every wallet held and showed, at L — read once, before anything is written.
    `INSERT INTO ${E} (user_id, legacy_rate, official_rate, settled_cents_before, held_cents_before,
        available_cents_before, settled_dust_iqd_before, available_iqd_before, pending_deposit_cents_before, created_at)
     SELECT w.user_id, ?1, ?2, w.s, w.h, w.s - w.h, w.ds,
            CASE WHEN w.s - w.h > 0 THEN ((w.s - w.h) * ?1) / 100 + MAX(w.da, 0) ELSE 0 END, w.p, ?3
       FROM (SELECT x.user_id,
                    ${settledUsdSql('x.user_id')} AS s,
                    ${effectiveHoldsUsdSql('x.user_id')} AS h,
                    ${walletDustIqdSql('x.user_id', { settledOnly: true })} AS ds,
                    ${walletDustIqdSql('x.user_id')} AS da,
                    (SELECT COALESCE(SUM(pt.amount), 0) FROM wallet_transactions pt
                      WHERE pt.user_id = x.user_id AND pt.currency = 'USD' AND pt.type = 'deposit' AND pt.status = 'pending') AS p
               FROM (SELECT user_id FROM wallet_transactions WHERE currency = 'USD'
                     UNION SELECT user_id FROM wallet_holds WHERE state = 'active') x) w
      WHERE w.s > 0 OR w.p > 0`,
    // 2. Close: the whole settled balance leaves at L, with its dinars (cancelling its remainders).
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
     SELECT 'wtx_rebase_close_' || e.user_id, e.user_id, 'withdrawal', 'USD', e.settled_cents_before, 'approved', ?4,
            '${RATE_REBASE_REF}', 'system', ?3, (e.settled_cents_before * ?1) / 100 + MAX(e.settled_dust_iqd_before, 0), ?1
       FROM ${E} e WHERE e.settled_cents_before > 0`,
    // 3. Holds that still reserve money (exactly the ones `effectiveHoldsUsdSql` counts), rounded up.
    `UPDATE wallet_holds SET amount_cents = ${UP('amount_cents')}, updated_at = ?3
      WHERE state = 'active'
        AND (tx_id IS NULL OR EXISTS (SELECT 1 FROM wallet_transactions ht WHERE ht.id = wallet_holds.tx_id AND ht.status <> 'approved'))
        AND user_id IN ${SETTLED_USERS}`,
    // 4. Open withdrawal requests: amount up (as its hold), fee down, net = amount − fee; dinars kept.
    `UPDATE wallet_withdrawals
        SET amount_cents = ${UP('amount_cents')},
            fee_cents = MIN((fee_cents * ?1) / ?2, ${UP('amount_cents')} - 1),
            net_cents = ${UP('amount_cents')} - MIN((fee_cents * ?1) / ?2, ${UP('amount_cents')} - 1),
            exchange_rate_snapshot = CASE WHEN exchange_rate_snapshot IS NULL THEN NULL ELSE ?2 END,
            updated_at = ?3
      WHERE state IN ('requested', 'approved', 'processing') AND user_id IN ${SETTLED_USERS}`,
    // 5. Their pending ledger rows (and any legacy pending withdrawal): the same rounding as the request.
    `UPDATE wallet_transactions
        SET amount = ${UP('amount')},
            exchange_rate_snapshot = CASE WHEN exchange_rate_snapshot IS NULL THEN NULL ELSE ?2 END
      WHERE currency = 'USD' AND type = 'withdrawal' AND status = 'pending' AND user_id IN ${SETTLED_USERS}`,
    // 6. Pending deposits' review records first (they read the row's dinars), then the rows.
    `UPDATE wallet_deposit_meta
        SET observed_amount_cents = CASE
              WHEN observed_amount_cents IS NULL OR observed_amount_cents <= 0 THEN observed_amount_cents
              WHEN observed_amount_cents = declared_amount_cents
                THEN ${DEPOSIT('declared_amount_cents', `COALESCE((SELECT t.amount_iqd FROM wallet_transactions t WHERE t.id = wallet_deposit_meta.tx_id), declared_amount_iqd)`)}
              ELSE MAX(1, (observed_amount_cents * ?1) / ?2) END,
            declared_amount_cents = ${DEPOSIT('declared_amount_cents', `COALESCE((SELECT t.amount_iqd FROM wallet_transactions t WHERE t.id = wallet_deposit_meta.tx_id), declared_amount_iqd)`)},
            exchange_rate_snapshot = CASE WHEN exchange_rate_snapshot IS NULL THEN NULL ELSE ?2 END
      WHERE tx_id IN (SELECT t.id FROM wallet_transactions t
                       WHERE t.currency = 'USD' AND t.type = 'deposit' AND t.status = 'pending'
                         AND t.user_id IN (SELECT user_id FROM ${E}))`,
    `UPDATE wallet_transactions
        SET amount = ${DEPOSIT('amount', TX_IQD)},
            exchange_rate_snapshot = CASE WHEN exchange_rate_snapshot IS NULL THEN NULL ELSE ?2 END
      WHERE currency = 'USD' AND type = 'deposit' AND status = 'pending' AND user_id IN (SELECT user_id FROM ${E})`,
    // 7. A Quick Buy session pays at its own rate with its hold's cents: both follow the hold.
    `UPDATE quick_buy_sessions
        SET held_cents = (SELECT h.amount_cents FROM wallet_holds h WHERE h.id = quick_buy_sessions.hold_id), exchange_rate = ?2
      WHERE hold_id IN (SELECT h.id FROM wallet_holds h WHERE h.state = 'active' AND h.user_id IN ${SETTLED_USERS})`,
    // 8. The reopening credit: S' cents, and the dinars that make the reading exactly what it was.
    //    Read after 2–6, so the remainders it compensates are the ones the wallet now carries.
    `UPDATE ${E} AS e
        SET settled_cents_after = ${S_AFTER},
            open_amount_iqd = (${S_AFTER} * ?2) / 100
              + MAX(0, e.available_iqd_before - ((${S_AFTER} - ${H_AFTER}) * ?2) / 100 - ${walletDustIqdSql('e.user_id')})
      WHERE e.settled_cents_before > 0`,
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, ref, created_by, decided_at, amount_iqd, exchange_rate_snapshot)
     SELECT 'wtx_rebase_open_' || e.user_id, e.user_id, 'deposit', 'USD', e.settled_cents_after, 'approved', ?4,
            '${RATE_REBASE_REF}', 'system', ?3, e.open_amount_iqd, ?2
       FROM ${E} e WHERE e.settled_cents_before > 0 AND e.settled_cents_after > 0`,
    // 9. The audit row's after-figures, read back from the ledger itself.
    `UPDATE ${E} AS e
        SET settled_cents_after = ${settledUsdSql('e.user_id')},
            held_cents_after = ${effectiveHoldsUsdSql('e.user_id')},
            available_cents_after = ${availableUsdSql('e.user_id')},
            available_iqd_after = CASE WHEN ${availableUsdSql('e.user_id')} > 0
              THEN (${availableUsdSql('e.user_id')} * ?2) / 100 + MAX(${walletDustIqdSql('e.user_id')}, 0) ELSE 0 END,
            close_tx_id = CASE WHEN e.settled_cents_before > 0 THEN 'wtx_rebase_close_' || e.user_id END,
            open_tx_id = (SELECT t.id FROM wallet_transactions t WHERE t.id = 'wtx_rebase_open_' || e.user_id)`,
    `UPDATE wallet_rate_rebase SET wallets = (SELECT COUNT(*) FROM ${E}) WHERE id = 1`,
  ];
}

/** The highest ?N a statement names, so each binds exactly the values it uses. */
const maxParam = (sql: string) => Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));

/**
 * Run the rebase once. Safe to call on every tick: after the marker exists it
 * is one cached check (no statement at all once this isolate has seen it).
 */
export async function runWalletRateRebase(env: Pick<Env, 'DB'>, now = new Date()): Promise<WalletRateRebaseResult> {
  const db = env.DB;
  if (await walletRateRebased(db)) return { status: 'already' };
  const official = wholeDinarRate(await getAppliedUsdRate(db));
  if (official === null) return { status: 'no_official_rate' };
  const legacy = await legacyUsdRate(db);
  const values = [legacy, official, now.toISOString(), NOTE];
  const statements =
    legacy === official
      ? [walletRateRebaseSql()[0]] // nothing changes value: the marker alone
      : walletRateRebaseSql();
  try {
    await db.batch(statements.map((sql) => db.prepare(sql).bind(...values.slice(0, maxParam(sql)))));
  } catch (e) {
    if (isSchemaMissing(e)) return { status: 'unavailable' };
    // Lost a race to another tick: its batch rebased, this one rolled back whole.
    if (await walletRateRebased(db)) return { status: 'already' };
    throw e;
  }
  const marker = await db.prepare('SELECT wallets FROM wallet_rate_rebase WHERE id = 1').first<{ wallets: number }>();
  return { status: 'rebased', legacyRate: legacy, officialRate: official, wallets: Number(marker?.wallets) || 0 };
}
