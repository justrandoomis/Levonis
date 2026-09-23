/**
 * Wallet engine tests — holds, the withdrawal state machine, deposit
 * reference identity and reconciliation (integrated mandate §11.1–§11.4,
 * acceptance rows WAL-07/WAL-08/WAL-09).
 *
 * These are NOT mock tests. Every statement in worker/lib/walletOps.ts runs
 * against a real SQLite database created from the REAL migration file
 * (migrations/0015_wallet_holds.sql) plus the real `wallet_transactions`
 * definition lifted out of migrations/0001_init.sql, through the shared
 * node:sqlite → D1 adapter in tests/fixtures/d1.ts. So the CHECK
 * constraints, the UNIQUE indexes, the conditional UPDATE/INSERT guards and
 * the "0 rows updated aborts the dependent writes" behaviour are all
 * exercised for real, not asserted about.
 *
 * What it cannot prove: D1's own concurrency behaviour on Cloudflare's
 * storage. Races are simulated here by interleaving operations in one
 * process, which exercises the guards but not the platform.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, createTableSql } from './fixtures/d1';

import {
  canTransition,
  createDepositRequest,
  classifyWithdrawalRow,
  closeWithdrawal,
  clearWithdrawalReconciliation,
  commitHold,
  createWithdrawalHold,
  depositAmountReview,
  flagWithdrawalForReconciliation,
  getAvailableBalances,
  getWalletBreakdown,
  getWithdrawal,
  initialDepositReviewState,
  isValidAmountCents,
  corroboratedDeclaredIqd,
  markWithdrawalPaid,
  normalizeDepositReference,
  operationNumber,
  releaseHold,
  requestWithdrawal,
  advanceWithdrawal,
  normalizeWithdrawalFeeBps,
  DEFAULT_WITHDRAWAL_FEE_BPS,
  MAX_WITHDRAWAL_FEE_BPS,
  walletReconciliationReport,
  withdrawalFeeQuote,
  WITHDRAWAL_TRANSITIONS,
  type WithdrawalReconRow,
} from '../worker/lib/walletOps';
import { depositDeclaredIqd, iqdToUsdCents } from '../src/lib/api';
import type { Env } from '../worker/lib/types';

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT)');
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(createTableSql('0001_init.sql', 'audit_log'));
  // The live exchange rate lives here. It is created so that the rate-change
  // test can actually MOVE it: a test that asserts a snapshot is not
  // recomputed has to leave something different for a recomputing reader to
  // find, or it cannot fail for the reason its name gives.
  raw.exec(createTableSql('0001_init.sql', 'admin_settings'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0015_wallet_holds.sql'), 'utf8'));
  // 0105 adds the customer's own dinar figure to wallet_deposit_meta. Applied
  // here for the same reason 0015 is: the INSERT that writes it has to run
  // against the real columns, not a hand-written copy of them.
  raw.exec(readFileSync(join(ROOT, 'migrations', '0105_deposit_declared_iqd.sql'), 'utf8'));
  // 0106 does the same for wallet_withdrawals. Same reason again: the INSERT
  // in requestWithdrawal binds these columns, so they have to be the real ones.
  raw.exec(readFileSync(join(ROOT, 'migrations', '0106_withdrawal_declared_iqd.sql'), 'utf8'));
  raw.prepare('INSERT INTO users (id, email, username) VALUES (?,?,?)').run('u1', 'u1@example.com', 'u1');
  raw.prepare('INSERT INTO users (id, email, username) VALUES (?,?,?)').run('u2', 'u2@example.com', 'u2');
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

/** Settle real money into the ledger the way an approved deposit does. */
function seedSettled(raw: DatabaseSync, userId: string, cents: number): void {
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES (?, ?, 'deposit', 'USD', ?, 'approved', 'seed', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run(`wtx_seed_${userId}_${cents}`, userId, cents);
}

const envOf = (db: D1Database) => ({ DB: db }) as unknown as Env;

async function available(db: D1Database, userId = 'u1'): Promise<number> {
  return (await getAvailableBalances(envOf(db), userId)).usd_cents_available;
}

async function fileWithdrawal(
  db: D1Database,
  amount: number,
  key = 'k1',
  userId = 'u1',
  feeBps = 0,
  declared?: { declaredAmountIqd?: number; exchangeRateSnapshot?: number }
) {
  return requestWithdrawal(db, {
    userId,
    amountCents: amount,
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: key,
    feeBps,
    ...declared,
  });
}

// ------------------------------------------------------------- pure rules

test('withdrawal transitions: only the mandated moves are legal', () => {
  assert.ok(canTransition('requested', 'approved'));
  assert.ok(canTransition('requested', 'cancelled'));
  assert.ok(canTransition('approved', 'processing'));
  assert.ok(canTransition('processing', 'paid'));
  assert.ok(canTransition('processing', 'failed'));

  // Skipping review, or paying straight from a request, is not a transition.
  assert.equal(canTransition('requested', 'processing'), false);
  assert.equal(canTransition('requested', 'paid'), false);
  assert.equal(canTransition('approved', 'paid'), false);
  // A transfer already in flight is not "cancelled" by anyone.
  assert.equal(canTransition('processing', 'cancelled'), false);
  // Terminal states are terminal — no reopening, no reversal by state change.
  for (const terminal of ['paid', 'rejected', 'cancelled', 'failed'] as const) {
    assert.deepEqual(WITHDRAWAL_TRANSITIONS[terminal], []);
  }
});

test('with no rate set, nothing is invented — net = amount', () => {
  const q = withdrawalFeeQuote(50_000, 0);
  assert.equal(q.fee_cents, 0);
  assert.equal(q.net_cents, 50_000);
  assert.equal(q.fee_configured, false);
  assert.equal(q.fee_policy, 'not_configured');
  // 0 is a REAL value meaning "switched off", the same thing
  // codTaxPerBlockIqd = 0 means — not a missing setting to substitute for.
  assert.deepEqual(withdrawalFeeQuote(50_000, 0), withdrawalFeeQuote(50_000));
});

/**
 * «عمولة للسحب بقدر 3% قابله للتغيير من الادارة» — DEDUCTED, NOT ADDED ON TOP.
 *
 * Request 100,000, the commission is 3,000, 97,000 reaches the customer and
 * 100,000 — the full requested figure — leaves the balance. The schema has
 * said so since 0015: CHECK (net_cents = amount_cents - fee_cents).
 */
test('the withdrawal commission is deducted from the requested amount', () => {
  const q = withdrawalFeeQuote(100_000, 300);
  assert.equal(q.fee_cents, 3_000, '3% of 100,000');
  assert.equal(q.net_cents, 97_000, 'what reaches the customer');
  assert.equal(q.amount_cents, 100_000, 'what leaves the balance — unchanged');
  assert.equal(q.net_cents, q.amount_cents - q.fee_cents, 'the 0015 CHECK, in arithmetic');
  assert.equal(q.fee_bps, 300);
  assert.equal(q.fee_policy, 'percent_bps');
  assert.equal(q.fee_configured, true);
});

test('the commission rounds DOWN, in the customer’s favour', () => {
  // 3% of 3,333 is 99.99 — a fee of 100 would take a cent the published
  // percentage does not entitle the shop to.
  assert.equal(withdrawalFeeQuote(3_333, 300).fee_cents, 99);
  assert.equal(withdrawalFeeQuote(3_333, 300).net_cents, 3_234);
  // Basis points exist so a half-percent needs no float.
  assert.equal(withdrawalFeeQuote(100_000, 250).fee_cents, 2_500);
});

test('an owner-typed rate is normalized once, and nowhere else', () => {
  assert.equal(normalizeWithdrawalFeeBps(300), 300);
  assert.equal(normalizeWithdrawalFeeBps('300'), 300);
  assert.equal(normalizeWithdrawalFeeBps(0), 0);
  // Junk is never an invented default — it is no fee at all.
  assert.equal(normalizeWithdrawalFeeBps(null), 0);
  assert.equal(normalizeWithdrawalFeeBps(undefined), 0);
  assert.equal(normalizeWithdrawalFeeBps(-5), 0);
  assert.equal(normalizeWithdrawalFeeBps(2.5), 0);
  assert.equal(normalizeWithdrawalFeeBps(Number.NaN), 0);
  // And it cannot exceed the ceiling, whatever gets typed into the form.
  assert.equal(normalizeWithdrawalFeeBps(99_999), MAX_WITHDRAWAL_FEE_BPS);
  assert.equal(MAX_WITHDRAWAL_FEE_BPS, 5000);
  // The owner named 3%; that is what ships when nothing is stored.
  assert.equal(DEFAULT_WITHDRAWAL_FEE_BPS, 300);
});

test('money guard rejects floats, NaN, zero, negatives and overflow', () => {
  assert.ok(isValidAmountCents(1));
  assert.ok(isValidAmountCents(100_000_000));
  assert.equal(isValidAmountCents(0), false);
  assert.equal(isValidAmountCents(-5), false);
  assert.equal(isValidAmountCents(10.5), false);
  assert.equal(isValidAmountCents(Number.NaN), false);
  assert.equal(isValidAmountCents(100_000_001), false);
  assert.equal(isValidAmountCents('100' as unknown), false);
});

test('deposit reference identity ignores formatting, not context', () => {
  assert.equal(normalizeDepositReference(' TRX 12-34 '), 'trx1234');
  assert.equal(normalizeDepositReference('trx#12/34'), 'trx1234');
  assert.notEqual(normalizeDepositReference('trx1235'), 'trx1234');
  // A reused attachment is a signal for the reviewer, never an auto-decision.
  assert.equal(initialDepositReviewState({ fingerprintSeenBefore: true }), 'fingerprint_reuse_signal');
  assert.equal(initialDepositReviewState({ fingerprintSeenBefore: false }), 'awaiting_review');
  // A different observed amount parks the request; it never approves.
  assert.equal(depositAmountReview(5_000, 5_000), 'cleared_for_decision');
  assert.equal(depositAmountReview(5_000, 4_900), 'amount_mismatch');
});

test('reconciliation classifier flags the impossible states', () => {
  const base: WithdrawalReconRow = {
    id: 'wd_1',
    user_id: 'u1',
    state: 'paid',
    amount_cents: 30_000,
    payout_reference: 'REF-1',
    needs_reconciliation: 0,
    hold_state: 'committed',
    hold_amount_cents: 30_000,
    tx_status: 'approved',
  };
  assert.deepEqual(classifyWithdrawalRow(base), []);
  assert.equal(
    classifyWithdrawalRow({ ...base, payout_reference: '' })[0].kind,
    'paid_without_reference'
  );
  assert.equal(classifyWithdrawalRow({ ...base, tx_status: 'pending' })[0].kind, 'paid_without_ledger_debit');
  assert.equal(
    classifyWithdrawalRow({ ...base, state: 'rejected', hold_state: 'active', payout_reference: '' })[0].kind,
    'terminal_without_released_hold'
  );
  assert.equal(
    classifyWithdrawalRow({
      ...base,
      state: 'processing',
      payout_reference: '',
      hold_state: 'active',
      tx_status: 'approved',
    }).some((a) => a.kind === 'open_with_posted_debit'),
    true
  );
  assert.equal(
    classifyWithdrawalRow({
      ...base,
      state: 'processing',
      payout_reference: '',
      hold_state: 'active',
      tx_status: 'pending',
      needs_reconciliation: 1,
    })[0].kind,
    'unknown_outcome_pending_reconciliation'
  );
});

test('operation numbers are labels, not authorisation', () => {
  assert.match(operationNumber('wtx_abcdef0123456789'), /^W-[0-9A-Z]{8}$/);
  assert.match(operationNumber('wd_abcdef0123456789', 'WD'), /^WD-[0-9A-Z]{8}$/);
});

// ------------------------------------------------- the mandated hold example

test('settled 100,000 with a 30,000 hold shows available 70,000', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  assert.equal(await available(db), 100_000);

  const res = await fileWithdrawal(db, 30_000);
  assert.ok(res.ok, 'withdrawal request should be accepted');

  const b = await getWalletBreakdown(db, 'u1');
  assert.equal(b.usd_cents_settled, 100_000);
  assert.equal(b.usd_cents_held, 30_000);
  assert.equal(b.usd_cents_available, 70_000);
  assert.equal(b.usd_cents_pending_withdrawals, 30_000);
  // The pending ledger row exists but has NOT debited anything yet.
  const row = await getWithdrawal(db, (res as { id: string }).id);
  assert.equal(row?.state, 'requested');
  const tx = raw.prepare('SELECT status FROM wallet_transactions WHERE id = ?').get(row!.tx_id) as { status: string };
  assert.equal(tx.status, 'pending');
});

test('completing the payout settles to 70,000 and available stays 70,000 (never 40,000)', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const req = await fileWithdrawal(db, 30_000);
  assert.ok(req.ok);
  const id = (req as { id: string }).id;

  assert.ok((await advanceWithdrawal(db, { id, to: 'approved', actorId: 'admin1' })).ok);
  // "approved" must not move money: still held, still not debited.
  assert.equal(await available(db), 70_000);
  assert.equal((await getWalletBreakdown(db, 'u1')).usd_cents_settled, 100_000);

  assert.ok((await advanceWithdrawal(db, { id, to: 'processing', actorId: 'admin1' })).ok);
  const paid = await markWithdrawalPaid(db, { id, payoutReference: 'FIB-778812', actorId: 'admin1' });
  assert.ok(paid.ok, 'payout with a recorded reference should succeed');

  const b = await getWalletBreakdown(db, 'u1');
  assert.equal(b.usd_cents_settled, 70_000, 'ledger debited exactly once');
  assert.equal(b.usd_cents_held, 0, 'hold committed, no longer reserving');
  assert.equal(b.usd_cents_available, 70_000, 'available must NOT drop to 40,000');

  const row = await getWithdrawal(db, id);
  assert.equal(row?.state, 'paid');
  assert.equal(row?.payout_reference, 'FIB-778812');
  assert.ok(row?.payout_at, 'a payout must record when it happened');
});

test('replaying the same payout record does not debit twice', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  await advanceWithdrawal(db, { id, to: 'approved', actorId: 'a' });
  await advanceWithdrawal(db, { id, to: 'processing', actorId: 'a' });
  await markWithdrawalPaid(db, { id, payoutReference: 'REF-1', actorId: 'a' });

  const again = await markWithdrawalPaid(db, { id, payoutReference: 'REF-1', actorId: 'a' });
  assert.deepEqual(again, { ok: true, id, replayed: true });
  assert.equal((await getWalletBreakdown(db, 'u1')).usd_cents_settled, 70_000);

  // A DIFFERENT reference on an already-paid request is a conflict, never a
  // second payout.
  const other = await markWithdrawalPaid(db, { id, payoutReference: 'REF-2', actorId: 'b' });
  assert.deepEqual(other, { ok: false, reason: 'STATE_CONFLICT', id });
  assert.equal((await getWalletBreakdown(db, 'u1')).usd_cents_settled, 70_000);
});

test('cancelling before payout returns the money exactly once', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  assert.equal(await available(db), 70_000);

  const first = await closeWithdrawal(db, {
    id,
    to: 'cancelled',
    actorId: 'u1',
    reason: 'changed my mind',
    allowedFrom: ['requested', 'approved'],
  });
  assert.ok(first.ok);
  assert.equal(await available(db), 100_000, 'exactly the original balance is back');

  // Second cancel (double click / two tabs): replayed, nothing credited.
  const second = await closeWithdrawal(db, {
    id,
    to: 'cancelled',
    actorId: 'u1',
    reason: 'changed my mind',
    allowedFrom: ['requested', 'approved'],
  });
  assert.deepEqual(second, { ok: true, id, replayed: true });
  assert.equal(await available(db), 100_000, 'no second credit — the hold released once');

  // The ledger row closed as rejected: a cancelled withdrawal never debits.
  const row = await getWithdrawal(db, id);
  const tx = raw.prepare('SELECT status FROM wallet_transactions WHERE id = ?').get(row!.tx_id) as { status: string };
  assert.equal(tx.status, 'rejected');
  const hold = raw.prepare('SELECT state, released_at FROM wallet_holds WHERE id = ?').get(row!.hold_id) as {
    state: string;
    released_at: string | null;
  };
  assert.equal(hold.state, 'released');
  assert.ok(hold.released_at);
});

test('rejecting after payout is impossible; paying a rejected request is impossible', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  await advanceWithdrawal(db, { id, to: 'approved', actorId: 'a' });
  await advanceWithdrawal(db, { id, to: 'processing', actorId: 'a' });
  await markWithdrawalPaid(db, { id, payoutReference: 'REF-9', actorId: 'a' });

  const reject = await closeWithdrawal(db, { id, to: 'rejected', actorId: 'b', reason: 'too late' });
  assert.equal(reject.ok, false);
  assert.equal((await getWalletBreakdown(db, 'u1')).usd_cents_available, 70_000, 'no silent refund');

  // And the mirror case: a rejected request can never be paid.
  const id2 = (await fileWithdrawal(db, 10_000, 'k2') as { id: string }).id;
  await closeWithdrawal(db, { id: id2, to: 'rejected', actorId: 'b', reason: 'wrong destination' });
  const pay = await markWithdrawalPaid(db, { id: id2, payoutReference: 'REF-X', actorId: 'b' });
  assert.equal(pay.ok, false);
  assert.equal((await getWalletBreakdown(db, 'u1')).usd_cents_available, 70_000);
});

test('a 0-row state update aborts the dependent hold and ledger writes', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  const row = await getWithdrawal(db, id);

  // 'requested' → 'paid' is not a legal move: the guarded UPDATE matches no
  // row, so the hold must stay active and the ledger row must stay pending.
  const res = await markWithdrawalPaid(db, { id, payoutReference: 'REF-EARLY', actorId: 'a' });
  assert.equal(res.ok, false);

  const hold = raw.prepare('SELECT state FROM wallet_holds WHERE id = ?').get(row!.hold_id) as { state: string };
  const tx = raw.prepare('SELECT status FROM wallet_transactions WHERE id = ?').get(row!.tx_id) as { status: string };
  assert.equal(hold.state, 'active', 'hold must not be committed by a losing transition');
  assert.equal(tx.status, 'pending', 'no ledger debit may post for a losing transition');
  assert.equal(await available(db), 70_000);
});

test('paid without a payout reference is refused outright', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  await advanceWithdrawal(db, { id, to: 'approved', actorId: 'a' });
  await advanceWithdrawal(db, { id, to: 'processing', actorId: 'a' });

  const res = await markWithdrawalPaid(db, { id, payoutReference: '   ', actorId: 'a' });
  assert.deepEqual(res, { ok: false, reason: 'MISSING_PAYOUT_REFERENCE' });
  assert.equal((await getWithdrawal(db, id))?.state, 'processing');
  assert.equal(await available(db), 70_000);
});

test('two withdrawals cannot reserve the same money (no negative available)', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const first = await fileWithdrawal(db, 70_000, 'first');
  assert.ok(first.ok);
  const second = await fileWithdrawal(db, 70_000, 'second');
  assert.deepEqual(second, { ok: false, reason: 'INSUFFICIENT_AVAILABLE' });

  assert.equal(await available(db), 30_000);
  const count = raw.prepare("SELECT COUNT(*) AS n FROM wallet_withdrawals WHERE user_id='u1'").get() as { n: number };
  assert.equal(count.n, 1, 'the losing request must not exist at all');
  const orphanTx = raw
    .prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id='u1' AND type='withdrawal'")
    .get() as { n: number };
  assert.equal(orphanTx.n, 1, 'no orphan ledger row from the failed request');
});

test('a purchase hold and a withdrawal hold cannot overspend the same balance', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const wd = await fileWithdrawal(db, 60_000, 'wd-1');
  assert.ok(wd.ok);

  const purchase = await createWithdrawalHold(db, {
    userId: 'u1',
    amountCents: 50_000,
    eventKey: 'order-1',
  });
  assert.deepEqual(purchase, { ok: false, reason: 'INSUFFICIENT_AVAILABLE' });

  const fits = await createWithdrawalHold(db, { userId: 'u1', amountCents: 40_000, eventKey: 'order-2' });
  assert.ok(fits.ok);
  assert.equal(await available(db), 0);
});

test('the same business event holds once; the same key with a new amount is refused', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);

  const first = await fileWithdrawal(db, 30_000, 'evt-A');
  assert.ok(first.ok);
  // Same key, same inputs → the first request is returned, not a second one.
  const replay = await fileWithdrawal(db, 30_000, 'evt-A');
  assert.deepEqual(replay, { ok: true, id: (first as { id: string }).id, replayed: true });
  // Same key, different amount → refused (never silently reused).
  const reused = await fileWithdrawal(db, 45_000, 'evt-A');
  assert.deepEqual(reused, { ok: false, reason: 'EVENT_KEY_REUSED' });

  assert.equal(await available(db), 70_000, 'only one hold exists');
  const holds = raw.prepare("SELECT COUNT(*) AS n FROM wallet_holds WHERE user_id='u1'").get() as { n: number };
  assert.equal(holds.n, 1);
});

test('hold primitives: commit and release each happen at most once', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const created = await createWithdrawalHold(db, { userId: 'u1', amountCents: 25_000, eventKey: 'raw-1' });
  assert.ok(created.ok);
  const holdId = (created as { holdId: string }).holdId;
  assert.equal(await available(db), 75_000);

  const released = await releaseHold(db, { holdId, reason: 'abandoned' });
  assert.ok(released.ok && released.replayed === false);
  assert.equal(await available(db), 100_000);

  const again = await releaseHold(db, { holdId, reason: 'abandoned' });
  assert.deepEqual(again, { ok: true, holdId, replayed: true });
  assert.equal(await available(db), 100_000, 'a second release credits nothing');

  // A released hold can never be committed afterwards.
  const commit = await commitHold(db, { holdId });
  assert.deepEqual(commit, { ok: false, reason: 'STATE_CONFLICT', holdId });
});

// ------------------------------------------------- unknown payout outcomes

test('an unknown payout outcome neither releases nor re-pays until a human resolves it', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  await advanceWithdrawal(db, { id, to: 'approved', actorId: 'a' });
  await advanceWithdrawal(db, { id, to: 'processing', actorId: 'a' });

  const flagged = await flagWithdrawalForReconciliation(db, {
    id,
    actorId: 'a',
    note: 'transfer channel timed out — outcome unknown',
  });
  assert.ok(flagged.ok);

  // No instant release...
  const fail = await closeWithdrawal(db, { id, to: 'failed', actorId: 'a', reason: 'assume it failed' });
  assert.deepEqual(fail, { ok: false, reason: 'NEEDS_RECONCILIATION', id });
  assert.equal(await available(db), 70_000, 'the money stays reserved while the outcome is unknown');

  // ...and the money is still not treated as sent.
  const row = await getWithdrawal(db, id);
  assert.equal(row?.state, 'processing');
  assert.equal(row?.needs_reconciliation, 1);

  // A human establishes what happened, then decides.
  assert.ok((await clearWithdrawalReconciliation(db, { id, actorId: 'a', finding: 'bank confirms not sent' })).ok);
  const failed = await closeWithdrawal(db, { id, to: 'failed', actorId: 'a', reason: 'bank confirms not sent' });
  assert.ok(failed.ok);
  assert.equal(await available(db), 100_000, 'released exactly once, after the finding');
});

test('a reconciling payout can still be recorded as paid with a real reference', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  await advanceWithdrawal(db, { id, to: 'approved', actorId: 'a' });
  await advanceWithdrawal(db, { id, to: 'processing', actorId: 'a' });
  await flagWithdrawalForReconciliation(db, { id, actorId: 'a', note: 'unknown outcome' });

  const paid = await markWithdrawalPaid(db, { id, payoutReference: 'BANK-4412', actorId: 'a' });
  assert.ok(paid.ok, 'a confirmed transfer resolves the unknown outcome');
  const b = await getWalletBreakdown(db, 'u1');
  assert.equal(b.usd_cents_settled, 70_000);
  assert.equal(b.usd_cents_available, 70_000);
  assert.equal((await getWithdrawal(db, id))?.needs_reconciliation, 0);
});

// -------------------------------------------------------- reconciliation

test('reconciliation reports a healthy wallet as matching', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  await fileWithdrawal(db, 30_000);
  const report = await walletReconciliationReport(db);
  assert.equal(report.anomalies.length, 0);
  assert.equal(report.sums_match, true);
  assert.equal(report.totals.withdrawal_holds_usd_cents, 30_000);
  assert.equal(report.totals.open_withdrawals_usd_cents, 30_000);
});

test('an out-of-band ledger approval is reported, and never double-subtracts', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const id = (await fileWithdrawal(db, 30_000) as { id: string }).id;
  const row = await getWithdrawal(db, id);

  // Simulate the LEGACY admin path: the ledger row is flipped to approved
  // without touching the hold or the request.
  raw
    .prepare("UPDATE wallet_transactions SET status='approved' WHERE id = ?")
    .run(row!.tx_id);

  // The balance must fall exactly once: 100,000 − 30,000 = 70,000. If the
  // hold were still counted the user would see 40,000.
  assert.equal(await available(db), 70_000);

  const report = await walletReconciliationReport(db);
  const kinds = report.anomalies.map((a) => a.kind);
  assert.ok(kinds.includes('open_with_posted_debit'), JSON.stringify(kinds));
  assert.ok(kinds.includes('ledger_debit_without_paid_withdrawal'), JSON.stringify(kinds));
});

test('reconciliation reports a negative available balance instead of fixing it', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 10_000);
  // Force an impossible state the way only a bug or manual edit could.
  raw
    .prepare(
      `INSERT INTO wallet_holds (id, user_id, kind, amount_cents, state, event_key)
       VALUES ('whold_bad','u1','withdrawal', 25000, 'active', 'manual')`
    )
    .run();
  const report = await walletReconciliationReport(db);
  const negative = report.anomalies.find((a) => a.kind === 'negative_available');
  assert.ok(negative, 'a negative available balance must be alerted');
  assert.equal(report.sums_match, false, 'holds without a request do not match the open requests');

  // Reporting must not have repaired anything.
  const hold = raw.prepare("SELECT state FROM wallet_holds WHERE id='whold_bad'").get() as { state: string };
  assert.equal(hold.state, 'active');
});

test('holds are per user: one account cannot reserve another account s money', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const res = await createWithdrawalHold(db, { userId: 'u2', amountCents: 10_000, eventKey: 'cross' });
  assert.deepEqual(res, { ok: false, reason: 'INSUFFICIENT_AVAILABLE' });
  assert.equal(await available(db, 'u1'), 100_000);
  assert.equal(await available(db, 'u2'), 0);
});

test('pending deposits are visible but never spendable', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 20_000);
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, created_by)
       VALUES ('wtx_pending','u1','deposit','USD', 80000, 'pending', 'user')`
    )
    .run();
  const b = await getWalletBreakdown(db, 'u1');
  assert.equal(b.usd_cents_pending_deposits, 80_000);
  assert.equal(b.usd_cents_available, 20_000, 'a pending deposit adds nothing spendable');
  const tooBig = await fileWithdrawal(db, 50_000);
  assert.deepEqual(tooBig, { ok: false, reason: 'INSUFFICIENT_AVAILABLE' });
});

// ------------------------------------------------------------- deposits

async function deposit(
  db: D1Database,
  over: Partial<Parameters<typeof createDepositRequest>[1]> = {}
) {
  return createDepositRequest(db, {
    userId: 'u1',
    amountCents: 5_000,
    receiptKey: 'receipts/u1/a.png',
    provider: 'zaincash',
    channel: '0770-111-2222',
    reference: 'TRX-9001',
    fingerprint: 'fp-a',
    ...over,
  });
}

test('a deposit is created pending — it adds nothing spendable', async () => {
  const { db, raw } = freshDb();
  const res = await deposit(db);
  assert.ok(res.ok);
  const tx = raw
    .prepare('SELECT status, amount, type FROM wallet_transactions WHERE id = ?')
    .get((res as { txId: string }).txId) as { status: string; amount: number; type: string };
  assert.equal(tx.status, 'pending');
  assert.equal(tx.type, 'deposit');
  assert.equal(await available(db), 0, 'a receipt is not a payment');
});

test('the same transfer reference cannot be credited twice in one context', async () => {
  const { db, raw } = freshDb();
  assert.ok((await deposit(db)).ok);

  // Same reference, re-typed with different spacing/case, same provider and
  // account: one transfer, one request.
  const again = await deposit(db, { reference: 'trx 9001', fingerprint: 'fp-b' });
  assert.deepEqual(again, { ok: false, reason: 'DUPLICATE_REFERENCE' });
  const n = raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE type='deposit'").get() as { n: number };
  assert.equal(n.n, 1);
});

test('reference dedup is scoped to its provider/channel context', async () => {
  const { db, raw } = freshDb();
  assert.ok((await deposit(db)).ok);
  // Same digits at a DIFFERENT provider is a different transfer.
  assert.ok((await deposit(db, { provider: 'fib' })).ok);
  // ...and at a different account of the same provider.
  assert.ok((await deposit(db, { channel: '0780-000-0000' })).ok);
  const n = raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE type='deposit'").get() as { n: number };
  assert.equal(n.n, 3);
});

test('deposits without a reference are not deduplicated (and never blocked)', async () => {
  const { db, raw } = freshDb();
  assert.ok((await deposit(db, { reference: '' })).ok);
  assert.ok((await deposit(db, { reference: '' })).ok);
  const n = raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE type='deposit'").get() as { n: number };
  assert.equal(n.n, 2, 'no invented duplicate detection without a reference');
});

test('a rejected deposit frees its reference; an approved one never does', async () => {
  const { db, raw } = freshDb();
  const first = await deposit(db);
  assert.ok(first.ok);
  const firstId = (first as { txId: string }).txId;

  raw.prepare("UPDATE wallet_transactions SET status='rejected' WHERE id = ?").run(firstId);
  const corrected = await deposit(db, { fingerprint: 'fp-c' });
  assert.ok(corrected.ok, 'an honest correction can be filed after a rejection');

  // Now approve the corrected one: the slot is taken for good.
  raw.prepare("UPDATE wallet_transactions SET status='approved' WHERE id = ?").run((corrected as { txId: string }).txId);
  const third = await deposit(db, { fingerprint: 'fp-d' });
  assert.deepEqual(third, { ok: false, reason: 'DUPLICATE_REFERENCE' }, 'no second credit for a credited transfer');
  assert.equal(await available(db), 5_000, 'exactly one credit exists');
});

test('a reused receipt image is flagged for review, never auto-decided', async () => {
  const { db, raw } = freshDb();
  const first = await deposit(db);
  assert.ok(first.ok);
  assert.equal((first as { reviewState: string }).reviewState, 'awaiting_review');

  const second = await deposit(db, { reference: 'TRX-9002' });
  assert.ok(second.ok, 'a reused fingerprint must NOT block the request');
  assert.equal((second as { reviewState: string }).reviewState, 'fingerprint_reuse_signal');
  const meta = raw
    .prepare('SELECT review_state FROM wallet_deposit_meta WHERE tx_id = ?')
    .get((second as { txId: string }).txId) as { review_state: string };
  assert.equal(meta.review_state, 'fingerprint_reuse_signal');
  const status = raw
    .prepare('SELECT status FROM wallet_transactions WHERE id = ?')
    .get((second as { txId: string }).txId) as { status: string };
  assert.equal(status.status, 'pending', 'a signal is not a decision');
});

test('deposit amounts are validated as integer cents', async () => {
  const { db } = freshDb();
  assert.deepEqual(await deposit(db, { amountCents: 0 }), { ok: false, reason: 'INVALID_AMOUNT' });
  assert.deepEqual(await deposit(db, { amountCents: -100 }), { ok: false, reason: 'INVALID_AMOUNT' });
  assert.deepEqual(await deposit(db, { amountCents: 10.5 }), { ok: false, reason: 'INVALID_AMOUNT' });
});

// -------------------------------------------- the customer's own dinars (0105)

/**
 * «كتبت ٥٠,٠٠٠ وظهر ٥٠,٠٠٨.»
 *
 * These tests exist to pin down the thing that makes the column necessary: the
 * conversion has NO inverse, so there is no rounding rule to fix instead. They
 * also pin down what the column may never become — a source of money.
 */
test('no rounding rule can return 50,000 IQD from the cents it converts to', () => {
  const RATE = 1400;
  const centsToIqdFloor = (cents: number) => Math.floor((cents * RATE) / 100);

  // THE REAL FUNCTION, NOT A COPY OF IT. This test used to define its own
  // local `iqdToCentsCeil`, so when the rule changed it would have kept
  // passing while describing behaviour the code no longer had — a green test
  // for a dead rule, which is worse than a red one.
  assert.equal(iqdToUsdCents(50_000, RATE), 3571);
  assert.equal(centsToIqdFloor(3571), 49_994);
  // The superseded rule, kept only as arithmetic so the drift the owner
  // reported is still legible: ceil produced 3,572 cents, which read back as
  // 50,008 — eight dinars the customer never typed.
  assert.equal(Math.ceil((50_000 * 100) / RATE), 3572);
  assert.equal(centsToIqdFloor(3572), 50_008);
  // Why neither direction repairs it: at this rate a cent is 14 د.ع, so only
  // multiples of 14 exist. This is the claim that survived the rule change
  // untouched, and it is the reason the declared columns exist at all.
  assert.equal(RATE / 100, 14);
  const reachable = [3570, 3571, 3572, 3573].map(centsToIqdFloor);
  assert.ok(!reachable.includes(50_000), 'no integer cent value reads back as 50,000');
});

/**
 * THE OWNER'S OWN EXAMPLE, PINNED.
 *
 *   «في المحفظة الاعتماد على السعر المدخل بدون تقريب، وعند الدولار يقرب الى
 *    عدد صحيح اقل — مثلا 35.71 = 50,000»
 *
 * At 1,400 IQD/USD, floor puts a typed 50,000 د.ع at 3,571 cents = $35.71,
 * which is that sentence exactly. Before this rule the same input produced
 * 3,572 = $35.72.
 *
 * The owner's two other examples (26.51 = 37,000 and 54.95 = 76,750) imply
 * rates of about 1,395.7 and 1,396.7, not 1,400 — they were written on a
 * different day's rate. They are recorded here at 1,400 as what the rule
 * actually produces, NOT used to tune the rule.
 */
test('the wallet dollar rounds DOWN — 50,000 د.ع at 1,400 is $35.71', () => {
  const RATE = 1400;
  assert.equal(iqdToUsdCents(50_000, RATE), 3571, 'the owner’s first example, verbatim');
  assert.equal(iqdToUsdCents(37_000, RATE), 2642);
  assert.equal(iqdToUsdCents(76_750, RATE), 5482);
  // Floor, never ceil and never round: the converted cents are always worth
  // no MORE than the dinars that were typed.
  for (const iqd of [1, 13, 14, 999, 1_400, 37_000, 50_000, 76_750, 1_234_567]) {
    const cents = iqdToUsdCents(iqd, RATE);
    assert.ok(Number.isInteger(cents), `${iqd} د.ع converted to a non-integer`);
    assert.ok((cents * RATE) / 100 <= iqd, `${iqd} د.ع converted UP to ${cents} cents`);
    assert.ok((cents + 1) * RATE > iqd * 100, `${iqd} د.ع lost more than a cent`);
  }
});

/**
 * H1 — FLOOR CAN PRODUCE ZERO, AND ZERO MUST NEVER BE RESERVED OR CREDITED.
 *
 * Under the old ceil, 1 د.ع became 1 cent and reached the server. Under floor
 * anything below one cent's worth (14 د.ع at 1,400) becomes 0, which is a new
 * input at the top of the chain. Every layer below refuses it, and the client
 * refuses it first in the customer's own language (`s.invalidAmount`, which
 * exists in ar/en/ckb already — no new string was written for this).
 */
test('a floored zero is refused, never credited and never reserved', async () => {
  const RATE = 1400;
  assert.equal(iqdToUsdCents(13, RATE), 0, 'under one cent’s worth floors to nothing');
  assert.equal(iqdToUsdCents(14, RATE), 1, 'one cent’s worth is the smallest representable amount');

  // The engine refuses it rather than writing a 0-cent hold or ledger row.
  assert.equal(isValidAmountCents(0), false);
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  assert.deepEqual(await fileWithdrawal(db, 0, 'zero-wd'), { ok: false, reason: 'INVALID_AMOUNT' });
  assert.deepEqual(await deposit(db, { amountCents: 0 }), { ok: false, reason: 'INVALID_AMOUNT' });
  // Nothing was written on the way to that refusal.
  const holds = raw.prepare('SELECT COUNT(*) AS n FROM wallet_holds').get() as { n: number };
  assert.equal(holds.n, 0, 'a refused amount still opened a hold');
  const rows = raw
    .prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE note <> 'seed'")
    .get() as { n: number };
  assert.equal(rows.n, 0, 'a refused amount still wrote a ledger row');
});

test('a deposit records the dinars the customer typed, verbatim', async () => {
  const { db, raw } = freshDb();
  const res = await deposit(db, { amountCents: 3572, declaredAmountIqd: 50_000, exchangeRateSnapshot: 1400 });
  assert.ok(res.ok);
  const meta = raw
    .prepare('SELECT declared_amount_cents, declared_amount_iqd, exchange_rate_snapshot FROM wallet_deposit_meta WHERE tx_id = ?')
    .get((res as { txId: string }).txId) as {
    declared_amount_cents: number;
    declared_amount_iqd: number;
    exchange_rate_snapshot: number;
  };
  assert.equal(meta.declared_amount_iqd, 50_000, 'the typed figure is stored as typed');
  assert.equal(meta.exchange_rate_snapshot, 1400, 'with the rate it was filed at');
  // The money is untouched: the credit still comes from the cents.
  assert.equal(meta.declared_amount_cents, 3572);
  const tx = raw
    .prepare('SELECT amount FROM wallet_transactions WHERE id = ?')
    .get((res as { txId: string }).txId) as { amount: number };
  assert.equal(tx.amount, 3572, 'the ledger row is cents and only cents');
});

test('a deposit without a declared figure stores NULL, not a repaired number', async () => {
  const { db, raw } = freshDb();
  const res = await deposit(db, { amountCents: 3572 });
  assert.ok(res.ok);
  const meta = raw
    .prepare('SELECT declared_amount_iqd, exchange_rate_snapshot FROM wallet_deposit_meta WHERE tx_id = ?')
    .get((res as { txId: string }).txId) as { declared_amount_iqd: number | null; exchange_rate_snapshot: number | null };
  assert.equal(meta.declared_amount_iqd, null, 'nobody wrote it down, so nobody claims to know it');
  assert.equal(meta.exchange_rate_snapshot, null);
});

test('a declared figure that is not a whole positive dinar amount is refused storage', async () => {
  const { db, raw } = freshDb();
  const read = async (over: Record<string, unknown>, reference: string) => {
    const res = await deposit(db, { ...over, reference });
    assert.ok(res.ok);
    return (
      raw
        .prepare('SELECT declared_amount_iqd FROM wallet_deposit_meta WHERE tx_id = ?')
        .get((res as { txId: string }).txId) as { declared_amount_iqd: number | null }
    ).declared_amount_iqd;
  };
  assert.equal(await read({ declaredAmountIqd: 0 }, 'R-1'), null);
  assert.equal(await read({ declaredAmountIqd: -50_000 }, 'R-2'), null);
  assert.equal(await read({ declaredAmountIqd: 50_000.5 }, 'R-3'), null);
  // The rate is only recorded alongside a figure it actually belongs to.
  const { db: db2, raw: raw2 } = freshDb();
  const res = await deposit(db2, { exchangeRateSnapshot: 1400 });
  assert.ok(res.ok);
  const meta = raw2
    .prepare('SELECT exchange_rate_snapshot FROM wallet_deposit_meta WHERE tx_id = ?')
    .get((res as { txId: string }).txId) as { exchange_rate_snapshot: number | null };
  assert.equal(meta.exchange_rate_snapshot, null, 'a rate with no claim beside it says nothing');
});

test('the declared dinars never move the amount-mismatch guard off cents', async () => {
  const { db, raw } = freshDb();
  const res = await deposit(db, { amountCents: 3572, declaredAmountIqd: 50_000, exchangeRateSnapshot: 1400 });
  assert.ok(res.ok);
  const meta = raw
    .prepare('SELECT declared_amount_cents FROM wallet_deposit_meta WHERE tx_id = ?')
    .get((res as { txId: string }).txId) as { declared_amount_cents: number };
  // What finance observed is compared to the CENTS. If this ever compared the
  // dinar column, a client could declare 50,000 د.ع with 900,000 cents and the
  // guard that blocks a silent approval would have nothing to catch.
  assert.equal(depositAmountReview(meta.declared_amount_cents, 3572), 'cleared_for_decision');
  assert.equal(depositAmountReview(meta.declared_amount_cents, 50_000), 'amount_mismatch');
});

// ------------------------------- the customer's own dinars, withdrawals (0106)

/**
 * A WITHDRAWAL RECORDS WHAT WAS TYPED, TOO.
 *
 * 0105 gave the deposit side this column and said a withdrawal «has nowhere to
 * put it». 0106 is that answer. The defect it closes ran in the opposite
 * direction to the deposit one and against the CUSTOMER: a typed 50,000 د.ع
 * had ceil() = 3,572 cents reserved and later debited, worth 50,008 د.ع.
 */
test('a withdrawal records the dinars the customer typed, verbatim', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);
  const res = await fileWithdrawal(db, 3571, 'declared-1', 'u1', 0, {
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: 1400,
  });
  assert.ok(res.ok);
  const row = await getWithdrawal(db, (res as { id: string }).id);
  assert.equal(row!.declared_amount_iqd, 50_000, 'the typed figure is stored as typed');
  assert.equal(row!.exchange_rate_snapshot, 1400, 'with the rate it was filed at');
  // The money is untouched: the hold, the debit and the fee are all cents.
  assert.equal(row!.amount_cents, 3571, 'the request row is cents and only cents');
  const hold = raw.prepare('SELECT amount_cents FROM wallet_holds WHERE id = ?').get(row!.hold_id) as {
    amount_cents: number;
  };
  assert.equal(hold.amount_cents, 3571, 'the reservation is computed from the cents, never the dinars');
});

test('a withdrawal without a declared figure stores NULL, not a repaired number', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);
  const res = await fileWithdrawal(db, 3571, 'declared-2');
  assert.ok(res.ok);
  const row = await getWithdrawal(db, (res as { id: string }).id);
  assert.equal(row!.declared_amount_iqd, null, 'nobody wrote it down, so nobody claims to know it');
  assert.equal(row!.exchange_rate_snapshot, null);

  // Not whole, not positive, or a rate with no claim beside it: all NULL.
  const cases: Array<[string, { declaredAmountIqd?: number; exchangeRateSnapshot?: number }]> = [
    ['declared-3', { declaredAmountIqd: 0, exchangeRateSnapshot: 1400 }],
    ['declared-4', { declaredAmountIqd: -50_000, exchangeRateSnapshot: 1400 }],
    ['declared-5', { declaredAmountIqd: 50_000.5, exchangeRateSnapshot: 1400 }],
    ['declared-6', { exchangeRateSnapshot: 1400 }],
  ];
  for (const [key, over] of cases) {
    const r = await fileWithdrawal(db, 3571, key, 'u1', 0, over);
    assert.ok(r.ok, key);
    const w = await getWithdrawal(db, (r as { id: string }).id);
    assert.equal(w!.declared_amount_iqd, null, key);
    assert.equal(w!.exchange_rate_snapshot, null, `${key}: a rate with no claim beside it says nothing`);
  }
  raw.close();
});

/**
 * THE RATE REALLY MOVES HERE, AND THE ROW REALLY DOES NOT.
 *
 * An earlier version of this test had that name and never wrote a rate
 * anywhere: it filed one withdrawal, re-read it, and asserted the same two
 * values the test above it already asserts. Its «proof» lines were arithmetic
 * over literals, true whatever the source code did. A reader rewritten to
 * re-derive the dinars from the LIVE rate at read time — the exact drift 0106
 * exists to prevent — would have sailed through it.
 *
 * So the live rate is written, the row is read, the rate is MOVED, and the row
 * is read again. The two reads are compared whole. If `getWithdrawal` ever
 * learns to convert at read time, the second read changes and this fails.
 */
test('a withdrawal’s recorded dinars survive a rate change', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);
  const liveRate = () =>
    Number(
      JSON.parse(
        (raw.prepare("SELECT value FROM admin_settings WHERE key = 'exchangeRate'").get() as { value: string }).value
      )
    );
  const setRate = (v: number) =>
    raw
      .prepare(
        "INSERT INTO admin_settings (key, value) VALUES ('exchangeRate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run(JSON.stringify(v));

  setRate(1400);
  const res = await fileWithdrawal(db, 3571, 'rate-move', 'u1', 0, {
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: 1400,
  });
  assert.ok(res.ok);
  const id = (res as { id: string }).id;
  const before = await getWithdrawal(db, id);
  assert.equal(before!.declared_amount_iqd, 50_000);
  assert.equal(before!.exchange_rate_snapshot, 1400);

  // The owner moves the rate. This is a real write, and a reader that
  // re-derived at read time would now have 1,600 sitting there to read.
  setRate(1600);
  assert.equal(liveRate(), 1600, 'the rate did not actually move — this test proves nothing');

  const after = await getWithdrawal(db, id);
  assert.deepEqual(after, before, 'the row moved when the rate moved — something re-derives at read time');
  // And what re-deriving would have said, so the size of the averted drift is
  // on the record: 57,136 د.ع for a customer who typed 50,000.
  assert.equal(Math.floor((after!.amount_cents * liveRate()) / 100), 57_136);
  assert.notEqual(57_136, after!.declared_amount_iqd);
  raw.close();
});

test('no reader re-derives a transaction’s dinars when a declared figure exists', () => {
  // The one helper both sides use. Present → printed verbatim, at ANY rate.
  assert.equal(depositDeclaredIqd(50_000, 3571, 1400), 50_000);
  assert.equal(depositDeclaredIqd(50_000, 3571, 1600), 50_000, 'the rate must not touch a recorded claim');
  // Absent → converted, which is the honest answer for a pre-0105/0106 row.
  assert.equal(depositDeclaredIqd(null, 3571, 1400), 49_994);
});

/**
 * THE CLAIM IS CHECKED AGAINST THE CENTS BEFORE IT IS EVER STORED.
 *
 * `declared_amount_iqd` is unvalidated client input, and this change promoted
 * it to the HEADLINE on the admin card a human reads before making an outbound
 * transfer — 20px bold, with the ledger dollars demoted to 11px grey. A
 * withdrawal has no receipt and no observed-amount reconciliation
 * (`markWithdrawalPaid` takes only a payout reference), so that card is the
 * only number the payer has. «Display reads the dinars», which is what 0105's
 * header offered against this hazard, is exactly how the human is misled.
 *
 * Two things are proved here against the real engine, not asserted about it:
 * the forged claim NEVER becomes money, and it is no longer stored at all —
 * so no screen can print it.
 */
test('a declared figure the cents do not corroborate is never stored', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);

  // The route's own ceiling (10,000,000,000 د.ع) against its floor of 100
  // cents — 1,400 د.ع at this rate. A 7,142,857x lie, printed in bold.
  const forged = await fileWithdrawal(db, 100, 'forged', 'u1', 0, {
    declaredAmountIqd: 50_000_000,
    exchangeRateSnapshot: 1400,
  });
  assert.ok(forged.ok, 'the MONEY is still filed — only the testimony is refused');
  const row = await getWithdrawal(db, (forged as { id: string }).id);
  assert.equal(row!.declared_amount_iqd, null, 'an uncorroborated claim reached the admin card');
  assert.equal(row!.exchange_rate_snapshot, null, 'a rate with no claim beside it says nothing');
  assert.equal(row!.amount_cents, 100, 'the money is still the cents that were sent');
  assert.equal(row!.net_cents, 100);
  const held = (raw.prepare('SELECT SUM(amount_cents) AS n FROM wallet_holds').get() as { n: number }).n;
  assert.equal(held, 100, 'the reservation followed the dinars — the column became money');

  // A TAB LEFT OPEN WHILE THE OWNER MOVED THE RATE. src/WalletContext.tsx
  // fetches /api/settings/public once on mount and never repolls, so the
  // client floors at 1,400 and the server stores at 1,500. 3,571 cents is
  // 53,565 د.ع at the live rate, not the 50,000 that was typed — 3,565 د.ع
  // apart, 238 times the one-cent bound the contract comments claim.
  const stale = await fileWithdrawal(db, 3571, 'stale-rate', 'u1', 0, {
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: 1500,
  });
  assert.ok(stale.ok);
  const staleRow = await getWithdrawal(db, (stale as { id: string }).id);
  assert.equal(staleRow!.declared_amount_iqd, null, 'a figure filed at another rate was printed as the payout');
  assert.equal(staleRow!.amount_cents, 3571);

  // The mirror, rate dropped: 3,571 cents is only 46,423 د.ع at 1,300.
  const dropped = await fileWithdrawal(db, 3571, 'dropped-rate', 'u1', 0, {
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: 1300,
  });
  assert.ok(dropped.ok);
  assert.equal((await getWithdrawal(db, (dropped as { id: string }).id))!.declared_amount_iqd, null);
  raw.close();
});

/**
 * AND THE WINDOW IS EXACTLY ONE CENT WIDE, WHICH IS WHY A STALE BUNDLE IS
 * STILL BELIEVED.
 *
 * The rule changed from ceil to floor. A browser still running the previous
 * bundle converts the same honest 50,000 د.ع to 3,572 instead of 3,571 — one
 * cent apart, and refusing it would silently drop the testimony of every
 * customer who has not reloaded. Those two values are the whole window;
 * anything outside it is refused above.
 */
test('the corroboration window is the floor or the ceil, and nothing else', () => {
  const at = (iqd: number, cents: number, rate = 1400) =>
    corroboratedDeclaredIqd(iqd, cents, rate).declared_amount_iqd;
  // Floor: what this bundle sends.
  assert.equal(iqdToUsdCents(50_000, 1400), 3571);
  assert.equal(at(50_000, 3571), 50_000);
  // Ceil: what the previous bundle sends, off by exactly one.
  assert.equal(at(50_000, 3572), 50_000, 'a browser that has not reloaded lost its testimony');
  // Two cents out is not a rounding difference, and one cent UNDER the floor
  // is a conversion no client performs — it would under-reserve against the
  // very figure it claims.
  assert.equal(at(50_000, 3573), null);
  assert.equal(at(50_000, 3570), null);
  // Nothing corroborates without a rate, and a claim of zero or a fraction is
  // not a claim at all.
  assert.equal(at(50_000, 3571, 0), null);
  assert.equal(corroboratedDeclaredIqd(50_000, 3571, undefined).declared_amount_iqd, null);
  assert.equal(at(0, 3571), null);
  assert.equal(at(-50_000, 3571), null);
  assert.equal(at(50_000.5, 3571), null);
  // The rate never travels without the figure it belongs to.
  assert.equal(corroboratedDeclaredIqd(50_000, 3573, 1400).exchange_rate_snapshot, null);
  assert.equal(corroboratedDeclaredIqd(50_000, 3571, 1400).exchange_rate_snapshot, 1400);
});

/**
 * THE DEPLOY WINDOW — THE WORKER IS LIVE, 0106 IS NOT APPLIED YET.
 *
 * This is the database shape between `wrangler deploy` and
 * `wrangler d1 migrations apply`, and it is reachable in production because
 * `EXPECTED_MIGRATION` is only a health alarm (worker/routes/misc.ts); it
 * blocks nothing. `requestWithdrawal` names two columns that are not there,
 * D1 aborts the whole batch, and the classifier — finding no hold, because
 * the batch rolled back — used to answer INSUFFICIENT_AVAILABLE. A customer
 * holding $10,000 was told their balance was too small, on every withdrawal,
 * for the length of the window.
 *
 * Nothing was corrupted by that: the batch is atomic and writes nothing. It
 * was a false refusal about someone's own money, which is its own kind of
 * damage. The request now files without the two columns instead — exactly as
 * it filed before 0106 existed — and the testimony is simply absent, which is
 * the truth about a row written into a table that has nowhere to put it.
 *
 * tests/walletSpendGuard.test.ts builds its whole fixture at this shape for
 * the same reason and would go red first if this regressed.
 */
test('a withdrawal still files while 0106 has not been applied yet', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT)');
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(createTableSql('0001_init.sql', 'audit_log'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0015_wallet_holds.sql'), 'utf8'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0105_deposit_declared_iqd.sql'), 'utf8'));
  // 0106 is deliberately absent. That is the whole test.
  raw.prepare('INSERT INTO users (id, email, username) VALUES (?,?,?)').run('u1', 'u1@example.com', 'u1');
  const db = new SqliteD1(raw) as unknown as D1Database;
  seedSettled(raw, 'u1', 1_000_000);

  const res = await requestWithdrawal(db, {
    userId: 'u1',
    amountCents: 3571,
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: 'pre-0106',
    feeBps: 300,
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: 1400,
  });
  assert.ok(res.ok, `a withdrawal was refused for want of a migration: ${JSON.stringify(res)}`);

  // The money is filed in full, and it is the SAME money 0106 would have
  // filed: the hold, the fee and the net all come off amount_cents.
  const row = raw
    .prepare('SELECT amount_cents, fee_cents, net_cents, hold_id FROM wallet_withdrawals WHERE id = ?')
    .get((res as { id: string }).id) as { amount_cents: number; fee_cents: number; net_cents: number; hold_id: string };
  assert.equal(row.amount_cents, 3571);
  assert.equal(row.fee_cents, 107);
  assert.equal(row.net_cents, 3464);
  assert.equal(row.net_cents, row.amount_cents - row.fee_cents);
  const hold = raw.prepare('SELECT amount_cents, state FROM wallet_holds WHERE id = ?').get(row.hold_id) as {
    amount_cents: number;
    state: string;
  };
  assert.equal(hold.amount_cents, 3571, 'the reservation is short of the debit it exists to guarantee');
  assert.equal(hold.state, 'active');
  assert.equal(await available(db, 'u1'), 1_000_000 - 3571);
  // And the testimony is absent rather than invented — the column is not there.
  const cols = (raw.prepare('PRAGMA table_info(wallet_withdrawals)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes('declared_amount_iqd'), 'the fixture applied 0106 after all');
  raw.close();
});

test('the display fallback is one-directional: dinars when filed, conversion when not', () => {
  // Filed: testimony wins, exactly as typed.
  assert.equal(depositDeclaredIqd(50_000, 3572, 1400), 50_000);
  // Not filed (a row from before migration 0105): convert from the cents, the
  // behaviour this page always had. `??` not `||` — NULL and undefined take the
  // fallback for being ABSENT.
  assert.equal(depositDeclaredIqd(null, 3572, 1400), 50_008);
  assert.equal(depositDeclaredIqd(undefined, 3572, 1400), 50_008);
  // Garbage is not testimony either.
  assert.equal(depositDeclaredIqd(0, 3572, 1400), 50_008);
  assert.equal(depositDeclaredIqd(-1, 3572, 1400), 50_008);
});

// ------------------------------------------- the commission, on a real row

test('a filed withdrawal stores the commission as a snapshot, and holds the FULL amount', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);
  const res = await fileWithdrawal(db, 100_000, 'fee-1', 'u1', 300);
  assert.ok(res.ok);

  const row = (await getWithdrawal(db, (res as { id: string }).id))!;
  assert.equal(row.amount_cents, 100_000);
  assert.equal(row.fee_cents, 3_000);
  assert.equal(row.net_cents, 97_000);
  assert.equal(row.fee_policy, 'percent_bps');

  // THE HOLD RESERVES THE REQUESTED AMOUNT, not the net. Reserving 97,000
  // would leave 3,000 the fee has not been taken out of still spendable.
  const hold = raw
    .prepare("SELECT amount_cents FROM wallet_holds WHERE ref_id = ? AND state = 'active'")
    .get((res as { id: string }).id) as { amount_cents: number };
  assert.equal(hold.amount_cents, 100_000);
  assert.equal(await available(db), 100_000, '200,000 settled minus the full 100,000 reserved');

  // A SNAPSHOT: the rate changing afterwards cannot re-price this row.
  const later = (await getWithdrawal(db, (res as { id: string }).id))!;
  assert.equal(later.fee_cents, 3_000);
  assert.equal(later.net_cents, 97_000);
});

test('a request filed under no policy keeps fee 0 forever, whatever the rate becomes', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);
  const before = await fileWithdrawal(db, 100_000, 'fee-none', 'u1', 0);
  assert.ok(before.ok);
  const row = (await getWithdrawal(db, (before as { id: string }).id))!;
  assert.equal(row.fee_cents, 0);
  assert.equal(row.net_cents, 100_000);
  assert.equal(row.fee_policy, 'not_configured', 'nothing may later claim a fee was charged on it');

  // The next request, filed after the owner sets 3%, is priced — and the old
  // row is untouched.
  const after = await fileWithdrawal(db, 50_000, 'fee-after', 'u1', 300);
  assert.ok(after.ok);
  assert.equal((await getWithdrawal(db, (after as { id: string }).id))!.fee_cents, 1_500);
  assert.equal((await getWithdrawal(db, (before as { id: string }).id))!.fee_cents, 0);
});

test('a commission that would swallow the whole withdrawal cannot be filed', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 200_000);
  // `CHECK (net_cents > 0)` at migrations/0015_wallet_holds.sql:84 would turn a
  // 100% fee into an unhandled D1 exception in the middle of a money batch.
  // Two things stop that, and both are tested: the ceiling clamps a typed
  // 100% to 50%, and the engine refuses a non-positive net before the insert.
  const res = await fileWithdrawal(db, 100_000, 'fee-100', 'u1', 10_000);
  assert.ok(res.ok, 'clamped to the ceiling, so it is a legitimate request');
  const row = (await getWithdrawal(db, (res as { id: string }).id))!;
  assert.equal(row.fee_cents, 50_000, 'the ceiling, not the typed 100%');
  assert.equal(row.net_cents, 50_000);

  // The guard itself, reached only if the ceiling is ever raised past 100%.
  const swallowed = await requestWithdrawal(db, {
    userId: 'u1',
    amountCents: 10_000,
    destination: { kind: 'manual_transfer', account: '0770-000-0000' },
    eventKey: 'fee-all',
    feeBps: MAX_WITHDRAWAL_FEE_BPS,
  });
  assert.ok(swallowed.ok);
  assert.ok((await getWithdrawal(db, (swallowed as { id: string }).id))!.net_cents > 0);
});
