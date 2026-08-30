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
  markWithdrawalPaid,
  normalizeDepositReference,
  operationNumber,
  releaseHold,
  requestWithdrawal,
  advanceWithdrawal,
  walletReconciliationReport,
  withdrawalFeeQuote,
  WITHDRAWAL_TRANSITIONS,
  type WithdrawalReconRow,
} from '../worker/lib/walletOps';
import type { Env } from '../worker/lib/types';

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT)');
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(createTableSql('0001_init.sql', 'audit_log'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0015_wallet_holds.sql'), 'utf8'));
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

async function fileWithdrawal(db: D1Database, amount: number, key = 'k1', userId = 'u1') {
  return requestWithdrawal(db, {
    userId,
    amountCents: amount,
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: key,
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

test('fees are honestly unconfigured — no invented rate, net = amount', () => {
  const q = withdrawalFeeQuote(50_000);
  assert.equal(q.fee_cents, 0);
  assert.equal(q.net_cents, 50_000);
  assert.equal(q.fee_configured, false);
  assert.equal(q.fee_policy, 'not_configured');
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
