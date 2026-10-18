/**
 * THE ONE-TIME WALLET REBASE ONTO THE OFFICIAL RATE (owner 2026-10-18, DECISIONS row 252):
 * «keep the existing balances' value in dinars». Wallet cents credited at the legacy 1,400 are
 * rescaled by 1,400 / U in one batch so each balance reads the same dinars at U = 1,680; until the
 * batch has run the wallet keeps converting at 1,400, and after it every operation uses 1,680.
 *
 * A database that held wallet money when migration 0202 applied has no marker; the tests below
 * recreate that by deleting the marker the fresh (empty) test database was born with.
 *
 * Run: node --import tsx --test tests/walletRateRebase.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, json, post, get, row, count, type App } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { ROOT } from './fixtures/d1';
import { walletRoutes } from '../worker/routes/wallet';
import { createDepositRequest, releaseHold } from '../worker/lib/walletOps';
import { getOfficialUsdRate } from '../worker/lib/fx/officialRate';
import { runWalletRateRebase } from '../worker/lib/fx/walletRateRebase';
import { iqdToUsdCents } from '../src/lib/api';

const L = 1400;
const U = 1680;

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('other','Ali','a@x.co','h','customer');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${L}');
  `);
  return { raw, db: asD1(raw) };
}

const app = (db: D1Database, id = 'buyer') =>
  stubApp(db, { id, role: 'customer', email: `${id}@x.co` }, (a) => a.route('/api/wallet', walletRoutes));
const wallet = async (a: App) => json(await get(a, '/api/wallet'));

/** A top-up filed the way the browser files it at `rate`, approved unless told otherwise. */
async function topUp(db: D1Database, raw: DatabaseSync, userId: string, typedIqd: number, ref: string, approve = true, rate = L) {
  const txId = `wtx_${ref}`;
  const res = await createDepositRequest(db, {
    userId,
    amountCents: iqdToUsdCents(typedIqd, rate),
    receiptKey: `receipts/${userId}/${ref}.png`,
    provider: 'zaincash',
    channel: 'app',
    reference: ref,
    declaredAmountIqd: typedIqd,
    exchangeRateSnapshot: rate,
    txId,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  if (approve) raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = ?").run(txId);
  return txId;
}

/** The production state 0202 meets: wallet money, no marker, and the applied rate 1,680 in force. */
function holdingMoneyAtU(raw: DatabaseSync) {
  raw.exec('DELETE FROM wallet_rate_rebase');
  applyRate(raw, 'USD_IQD', String(U));
}

const ledger = (raw: DatabaseSync) =>
  JSON.stringify([
    raw.prepare('SELECT id, amount, amount_iqd, exchange_rate_snapshot, status FROM wallet_transactions ORDER BY id').all(),
    raw.prepare('SELECT id, amount_cents, state FROM wallet_holds ORDER BY id').all(),
    raw.prepare('SELECT id, amount_cents, fee_cents, net_cents FROM wallet_withdrawals ORDER BY id').all(),
    raw.prepare('SELECT * FROM wallet_rate_rebase_entries ORDER BY user_id').all(),
    raw.prepare('SELECT * FROM wallet_rate_rebase').all(),
  ]);

test('a 50,000 د.ع balance credited at 1,400 reads 50,000 before and after the rebase at 1,680; one audit entry per wallet; a second run changes nothing', async () => {
  const { raw, db } = setup();
  await topUp(db, raw, 'buyer', 50_000, 'b1');
  await topUp(db, raw, 'other', 25_000, 'o1');
  await topUp(db, raw, 'other', 25_000, 'o2');
  holdingMoneyAtU(raw);

  // Deployed, not yet rebased: the wallet still converts at 1,400 — nothing has moved.
  assert.equal(await getOfficialUsdRate(db), L);
  const before = await wallet(app(db));
  assert.equal(before.balance_usd_cents, 3571);
  assert.equal(before.balance_iqd, 50_000);
  assert.equal((await wallet(app(db, 'other'))).balance_iqd, 50_000);

  const done = await runWalletRateRebase({ DB: db });
  assert.deepEqual(done, { status: 'rebased', legacyRate: L, officialRate: U, wallets: 2 });
  assert.equal(await getOfficialUsdRate(db), U, 'after the marker: the one official rate');

  const after = await wallet(app(db));
  assert.equal(after.balance_iqd, 50_000, '50,000 stays 50,000, to the dinar');
  assert.equal(after.balance_usd_cents, Math.floor((3571 * L) / U), 'the cents rounded down: no money created');
  assert.equal(after.balances.iqd_settled, 50_000);
  assert.equal((await wallet(app(db, 'other'))).balance_iqd, 50_000, 'two typed deposits keep both remainders');

  // The audit: one entry per wallet, both rates, the cents and the dinars before and after.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_rate_rebase_entries'), 2);
  const e = row<Record<string, number | string>>(raw, "SELECT * FROM wallet_rate_rebase_entries WHERE user_id = 'buyer'")!;
  assert.deepEqual(
    [e.reason, e.legacy_rate, e.official_rate, e.settled_cents_before, e.available_cents_before, e.available_iqd_before, e.available_cents_after, e.available_iqd_after],
    ['RATE_REBASE', L, U, 3571, 3571, 50_000, 2975, 50_000]
  );
  // The ledger shows it as two entries (no historical row rewritten): out at 1,400, in at 1,680.
  const pair = raw
    .prepare("SELECT id, type, amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE user_id = 'buyer' AND ref = 'RATE_REBASE' ORDER BY type")
    .all() as Array<Record<string, unknown>>;
  assert.deepEqual(
    pair.map((t) => [t.type, t.amount, t.exchange_rate_snapshot]),
    [['deposit', 2975, U], ['withdrawal', 3571, L]]
  );
  assert.deepEqual(
    row(raw, "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = 'wtx_b1'"),
    { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: L },
    'the original deposit stays as recorded'
  );

  // Twice: nothing changes, and the cached check costs no statement.
  const snapshot = ledger(raw);
  assert.deepEqual(await runWalletRateRebase({ DB: db }), { status: 'already' });
  assert.deepEqual(await runWalletRateRebase({ DB: asD1(raw) }), { status: 'already' }, 'a fresh handle reads the marker');
  assert.equal(ledger(raw), snapshot);
  // The batch itself cannot run twice either: its marker INSERT aborts it whole.
  raw.exec('DELETE FROM wallet_rate_rebase_entries');
  await assert.rejects(runWalletRateRebaseBypassingCache(raw));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_rate_rebase_entries'), 0, 'rolled back whole');
});

/** Run the batch directly, as a racing tick that did not see the marker would. */
async function runWalletRateRebaseBypassingCache(raw: DatabaseSync) {
  const { walletRateRebaseSql } = await import('../worker/lib/fx/walletRateRebase');
  const db = asD1(raw);
  const values = [L, U, new Date().toISOString(), 'x'];
  const maxParam = (sql: string) => Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
  await db.batch(walletRateRebaseSql().map((sql) => db.prepare(sql).bind(...values.slice(0, maxParam(sql)))));
}

test('a wallet with an open withdrawal, a purchase hold and a deposit under review stays consistent: the free balance reads the same dinars, every reservation and request is rescaled with it', async () => {
  const { raw, db } = setup();
  const a = app(db);
  await topUp(db, raw, 'buyer', 200_000, 'big');
  await topUp(db, raw, 'buyer', 10_000, 'review', false);
  const wd = await json(
    await post(a, '/api/wallet/withdrawals', {
      amount_usd_cents: iqdToUsdCents(50_000, L),
      declared_amount_iqd: 50_000,
      destinationKind: 'zaincash',
      destinationAccount: '07701234567',
      idempotencyKey: 'wd-rebase-1',
    })
  );
  assert.equal(wd.success, true, JSON.stringify(wd));
  raw.exec(`INSERT INTO wallet_holds (id, user_id, kind, amount_cents, event_key) VALUES ('h_buy', 'buyer', 'purchase', 1000, 'test:buy')`);
  holdingMoneyAtU(raw);

  const before = await wallet(a);
  const settledBefore = before.balances.usd_cents_settled as number;
  const done = await runWalletRateRebase({ DB: db });
  assert.equal(done.status, 'rebased');
  const after = await wallet(a);

  // The figure the customer spends from: unchanged to the dinar.
  assert.equal(after.balance_iqd, before.balance_iqd);
  // What the rows recorded in dinars is not touched.
  assert.equal(after.balances.iqd_pending_withdrawals, 50_000);
  assert.equal(after.balances.iqd_pending_deposits, 10_000);
  // Cents: settled = available + held, and nothing grew.
  assert.equal(after.balances.usd_cents_settled, after.balances.usd_cents_available + after.balances.usd_cents_held);
  assert.ok(after.balances.usd_cents_settled <= Math.floor((settledBefore * L) / U), 'the settled cents never exceed their value at U');

  // The withdrawal request, its hold and its pending ledger row move together; its dinars stay.
  const w = row<Record<string, number>>(raw, 'SELECT amount_cents, fee_cents, net_cents, declared_amount_iqd, exchange_rate_snapshot, hold_id, tx_id FROM wallet_withdrawals')!;
  const wHold = row<{ amount_cents: number }>(raw, 'SELECT amount_cents FROM wallet_holds WHERE id = ?', w.hold_id)!;
  const wTx = row<{ amount: number; exchange_rate_snapshot: number }>(raw, 'SELECT amount, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?', w.tx_id)!;
  assert.equal(w.amount_cents, Math.ceil((iqdToUsdCents(50_000, L) * L) / U), 'a reservation rounds up: it still covers its dinars at U');
  assert.ok(w.amount_cents >= Math.floor((50_000 * 100) / U));
  assert.deepEqual([wHold.amount_cents, wTx.amount], [w.amount_cents, w.amount_cents]);
  assert.equal(w.net_cents, w.amount_cents - w.fee_cents);
  assert.deepEqual([w.declared_amount_iqd, w.exchange_rate_snapshot, wTx.exchange_rate_snapshot], [50_000, U, U]);
  assert.equal(row<{ amount_cents: number }>(raw, "SELECT amount_cents FROM wallet_holds WHERE id = 'h_buy'")!.amount_cents, Math.ceil((1000 * L) / U));

  // The deposit under review: what its 10,000 typed dinars are worth at U, as if filed today.
  const dep = row<Record<string, number>>(
    raw,
    "SELECT t.amount, t.exchange_rate_snapshot AS tr, m.declared_amount_cents, m.exchange_rate_snapshot AS mr FROM wallet_transactions t JOIN wallet_deposit_meta m ON m.tx_id = t.id WHERE t.id = 'wtx_review'"
  )!;
  assert.deepEqual([dep.amount, dep.declared_amount_cents, dep.tr, dep.mr], [Math.floor((10_000 * 100) / U), Math.floor((10_000 * 100) / U), U, U]);
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = 'wtx_review'").run();
  assert.equal((await wallet(a)).balance_iqd, before.balance_iqd + 10_000, 'approved after the rebase: exactly the 10,000 typed');
  raw.prepare("UPDATE wallet_transactions SET status = 'pending' WHERE id = 'wtx_review'").run();

  // Released after the rebase, the purchase hold gives back its dinars — not 20% more.
  await releaseHold(db, { holdId: 'h_buy', reason: 'test' });
  const released = await wallet(a);
  const heldIqdAtL = Math.floor((1000 * L) / 100);
  assert.ok(released.balance_iqd - after.balance_iqd >= heldIqdAtL, 'not less than it held');
  assert.ok(released.balance_iqd - after.balance_iqd < heldIqdAtL + Math.ceil(U / 100), 'not more than a cent above it');

  // A withdrawal filed after the rebase converts at the official rate.
  const late = await json(
    await post(a, '/api/wallet/withdrawals', {
      amount_usd_cents: iqdToUsdCents(20_000, U),
      declared_amount_iqd: 20_000,
      destinationKind: 'zaincash',
      destinationAccount: '07701234567',
      idempotencyKey: 'wd-rebase-2',
    })
  );
  assert.equal(late.success, true, JSON.stringify(late));
  const lw = row<Record<string, number>>(raw, 'SELECT amount_cents, exchange_rate_snapshot FROM wallet_withdrawals WHERE id = ?', late.withdrawal.id)!;
  assert.deepEqual([lw.amount_cents, lw.exchange_rate_snapshot], [iqdToUsdCents(20_000, U), U]);
});

test('no applied rate: nothing to move to, the wallet waits at the legacy rate; equal rates: the marker alone', async () => {
  const { raw, db } = setup();
  await topUp(db, raw, 'buyer', 50_000, 'b1');
  raw.exec('DELETE FROM wallet_rate_rebase');
  assert.deepEqual(await runWalletRateRebase({ DB: db }), { status: 'no_official_rate' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_rate_rebase'), 0);
  applyRate(raw, 'USD_IQD', String(L));
  const snapshot = raw.prepare('SELECT * FROM wallet_transactions ORDER BY id').all();
  assert.deepEqual(await runWalletRateRebase({ DB: db }), { status: 'rebased', legacyRate: L, officialRate: L, wallets: 0 });
  assert.deepEqual(raw.prepare('SELECT * FROM wallet_transactions ORDER BY id').all(), snapshot);
  assert.equal((await wallet(app(db))).balance_iqd, 50_000);
});

test('migration 0202: a database already holding wallet money gets no marker, and re-applying it changes nothing', () => {
  const { raw } = setup();
  raw.exec("INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status) VALUES ('d','buyer','deposit','USD',100,'approved')");
  raw.exec('DELETE FROM wallet_rate_rebase');
  raw.exec(readFileSync(join(ROOT, 'migrations/0202_wallet_rate_rebase.sql'), 'utf8'));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_rate_rebase'), 0, 'held money waits for the rebase');
  const fresh = freshDb();
  assert.equal(count(fresh, 'SELECT COUNT(*) AS n FROM wallet_rate_rebase'), 1, 'an empty shop is born on the official rate');
  fresh.exec(readFileSync(join(ROOT, 'migrations/0202_wallet_rate_rebase.sql'), 'utf8'));
  assert.equal(count(fresh, 'SELECT COUNT(*) AS n FROM wallet_rate_rebase'), 1);
});
