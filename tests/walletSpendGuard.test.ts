/**
 * The spend guard must see what the balance sheet sees.
 *
 * `getAvailableBalances` reports settled MINUS active holds; a withdrawal that
 * is waiting for payout is money the customer can no longer spend. Checkout
 * and the membership purchase each read that number and then debited with a
 * statement guarded on the SETTLED sum alone — so the same 100,000 could be
 * reserved for a withdrawal and spent on an order within one instant, and the
 * ledger went negative when the payout was recorded.
 *
 * This runs the real statement against the real schema (node:sqlite over the
 * migrations, the way tests/walletOps.test.ts does).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1, createTableSql } from './fixtures/d1';
import {
  approvableWithdrawalSql,
  getAvailableBalances,
  requestWithdrawal,
  usdSpendStatement,
} from '../worker/lib/walletOps';
import { spend as libSpend } from '../worker/lib/wallet';
import type { Env } from '../worker/lib/types';

function freshDb(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT)');
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(createTableSql('0001_init.sql', 'audit_log'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0015_wallet_holds.sql'), 'utf8'));
  // 0106 IS DELIBERATELY NOT APPLIED HERE. This fixture builds
  // `wallet_withdrawals` from 0015 alone, which is exactly the shape a
  // database has during the window between a Worker going live and its
  // migration being run. `requestWithdrawal` names the 0106 columns, so if it
  // could not survive their absence every test below would go red — and in
  // production every customer would be told their balance was insufficient.
  // Applying 0106 here would hide that, so it stays out and this whole file
  // doubles as the deploy-order pin.
  raw.prepare('INSERT INTO users (id, email, username) VALUES (?,?,?)').run('u1', 'u1@example.com', 'u1');
  return { db: new SqliteD1(raw) as unknown as D1Database, raw };
}

function seedSettled(raw: DatabaseSync, userId: string, cents: number): void {
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES (?, ?, 'deposit', 'USD', ?, 'approved', 'seed', 'admin', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run(`wtx_seed_${userId}_${cents}`, userId, cents);
}

const envOf = (db: D1Database) => ({ DB: db }) as unknown as Env;
const NOW = '2026-09-05T10:00:00.000Z';

const spend = (db: D1Database, cents: number, txId = 'wtx_ord_1_usd') =>
  db.batch([usdSpendStatement(db, { txId, userId: 'u1', amountCents: cents, note: 'order', ref: 'ORD-1', nowIso: NOW })]);

async function withdraw(db: D1Database, cents: number, key = 'k1') {
  return requestWithdrawal(db, {
    userId: 'u1',
    amountCents: cents,
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'Test User' },
    eventKey: key,
  });
}

// ------------------------------------------------------------ THE DOUBLE SPEND

test('money reserved for a withdrawal cannot also be spent on an order', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);

  const w = await withdraw(db, 100_000);
  assert.equal(w.ok, true, 'the withdrawal reserved the whole balance');
  assert.equal((await getAvailableBalances(envOf(db), 'u1')).usd_cents_available, 0);

  // Before the fix this INSERT succeeded: settled (100,000) >= 100,000, and
  // the balance sheet went to -100,000 the moment the payout was recorded.
  await assert.rejects(spend(db, 100_000), /CHECK/, 'the spend must abort on the CHECK, not post');
  const posted = raw.prepare("SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = 'wtx_ord_1_usd'").get() as { n: number };
  assert.equal(posted.n, 0, 'nothing was written');
  assert.equal((await getAvailableBalances(envOf(db), 'u1')).usd_cents_available, 0);
});

test('the same spend goes through when nothing is held, and exactly once', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  await spend(db, 60_000);
  assert.equal((await getAvailableBalances(envOf(db), 'u1')).usd_cents_available, 40_000);
  // A second spend that no longer fits fails the same way.
  await assert.rejects(spend(db, 50_000, 'wtx_ord_2_usd'), /CHECK/);
  assert.equal((await getAvailableBalances(envOf(db), 'u1')).usd_cents_available, 40_000);
});

test('a partial hold leaves exactly the unreserved remainder spendable', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  assert.equal((await withdraw(db, 30_000)).ok, true);
  await assert.rejects(spend(db, 70_001), /CHECK/);
  await spend(db, 70_000, 'wtx_ord_3_usd');
  assert.equal((await getAvailableBalances(envOf(db), 'u1')).usd_cents_available, 0);
});

// -------------------------------------------- the legacy admin approval

test('approving a hold-backed withdrawal counts its own hold as covering it — but not another one', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  const a = await withdraw(db, 60_000, 'ka');
  const b = await withdraw(db, 40_000, 'kb');
  assert.equal(a.ok && b.ok, true);
  const txA = (raw.prepare("SELECT tx_id FROM wallet_withdrawals WHERE hold_id = (SELECT id FROM wallet_holds WHERE event_key='ka')").get() as { tx_id: string }).tx_id;

  // The predicate the legacy /decide route uses: spendable + this request's own hold.
  const ok = raw
    .prepare(`SELECT ${approvableWithdrawalSql('?1', '?2')} >= (SELECT amount FROM wallet_transactions WHERE id = ?2) AS ok`)
    .get('u1', txA) as { ok: number };
  assert.equal(ok.ok, 1, 'its own 60,000 hold is what reserves it; the other 40,000 is not counted twice');

  // Take the money away underneath it (an approved payout of another kind) —
  // now settled 100,000 - 60,000 = 40,000 spendable-with-own-hold, below 60,000.
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES ('wtx_other', 'u1', 'withdrawal', 'USD', 60000, 'approved', 'other', 'admin', ?)`
    )
    .run(NOW);
  const no = raw
    .prepare(`SELECT ${approvableWithdrawalSql('?1', '?2')} >= (SELECT amount FROM wallet_transactions WHERE id = ?2) AS ok`)
    .get('u1', txA) as { ok: number };
  assert.equal(no.ok, 0, 'once the balance no longer covers it, approval is refused');
});

// ------------------------------------------------- the older lib/wallet spend()

test('lib/wallet spend() honours holds for USD and leaves points alone', async () => {
  const { db, raw } = freshDb();
  seedSettled(raw, 'u1', 100_000);
  assert.equal((await withdraw(db, 100_000)).ok, true);
  assert.equal(await libSpend(db, 'u1', 'USD', 1, 'x', 'r'), null, 'nothing spendable while the hold is active');
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
       VALUES ('pts', 'u1', 'deposit', 'POINT', 500, 'approved', 'seed', 'admin', ?)`
    )
    .run(NOW);
  assert.ok(await libSpend(db, 'u1', 'POINT', 200, 'x', 'r2'), 'points are a separate balance');
});
