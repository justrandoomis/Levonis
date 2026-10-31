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
import { approveMerchants, freshDb, asD1, stubApp, json, post, get, row, count, type App } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { ROOT } from './fixtures/d1';
import { walletRoutes } from '../worker/routes/wallet';
import { createDepositRequest, releaseHold } from '../worker/lib/walletOps';
import { getOfficialUsdRate } from '../worker/lib/fx/officialRate';
import { runWalletRateRebase } from '../worker/lib/walletRateRebase';
import { holdEscrow, refundEscrow, releaseEscrow } from '../worker/lib/escrowOps';
import { orderRoutes } from '../worker/routes/orders';
import { membershipsRoutes } from '../worker/routes/memberships';
import { proposePriceAdjustment, decidePriceAdjustment } from '../worker/lib/orderPriceAdjust';
import { repairCancelledOrderRefunds } from '../worker/lib/orderCancelRepair';
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
  const { walletRateRebaseSql } = await import('../worker/lib/walletRateRebase');
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
  assert.ok(
    released.balance_iqd - after.balance_iqd < heldIqdAtL + Math.ceil(U / 100),
    'at most one cent at U above it: the stated, bounded cost of rounding a reservation up'
  );

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

/** A community order of 50,000 د.ع whose escrow can be held from the buyer's wallet. */
function communityOrder(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('owner','Owner','o@x.co','h'), ('boss','Admin','ad@x.co','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Shop');
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','buyer','Print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',50000);
    INSERT INTO community_orders
      (id,request_id,offer_id,customer_id,merchant_id,price_iqd,commission_percent_x100,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','buyer','m1',50000,1000,5000,45000);
  `);
  approveMerchants(raw);
}

const holdCommunityOrder = (db: D1Database) =>
  holdEscrow(db, {
    communityOrderId: 'co1', customerId: 'buyer', merchantId: 'm1',
    grossIqd: 50_000, platformFeeIqd: 5_000, merchantReceivableIqd: 45_000, idempotencyKey: 'esc-1',
  });

test('an escrow held at 1,400 and settled after the rebase: its recorded rate and cents follow the rescaled hold, so a partial refund gives back its dinars and a release spends only its own', async () => {
  for (const settle of ['partial', 'release'] as const) {
    const { raw, db } = setup();
    communityOrder(raw);
    await topUp(db, raw, 'buyer', 100_000, 'esc');
    const held = await holdCommunityOrder(db);
    assert.equal(held.ok, true, JSON.stringify(held));
    const escrowId = (held as { escrowId: string }).escrowId;
    holdingMoneyAtU(raw);
    assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');

    const hold = row<{ amount_cents: number }>(raw, 'SELECT h.amount_cents FROM wallet_holds h JOIN community_escrows c ON c.hold_id = h.id')!;
    assert.equal(
      row<{ reason: string }>(raw, "SELECT reason FROM community_escrow_events WHERE kind = 'held'")!.reason,
      `rate=${U};cents=${hold.amount_cents};held_rate=${L};held_cents=${Math.floor((50_000 * 100) / L)};legacy_rate=${L}`,
      'the hold-time record moved with the hold, and keeps what it was'
    );
    const free = (await wallet(app(db))).balance_iqd as number;
    if (settle === 'partial') {
      const rf = await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', amountIqd: 20_000, idempotencyKey: 'prf' });
      assert.equal(rf.ok, true, JSON.stringify(rf));
      assert.deepEqual(
        row(raw, 'SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?', `wtx_escrow_refund_${escrowId}`),
        { amount: Math.floor((20_000 * 100) / U), amount_iqd: 20_000, exchange_rate_snapshot: U }
      );
      const after = (await wallet(app(db))).balance_iqd as number;
      assert.ok(after <= free + 20_000 && after >= free + 20_000 - Math.ceil(U / 100), `refunded 20,000, read ${after - free}`);
    } else {
      const rel = await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'rel' });
      assert.equal(rel.ok, true, JSON.stringify(rel));
      const after = (await wallet(app(db))).balance_iqd as number;
      assert.ok(after <= free && after >= free - Math.ceil(U / 100), `the free balance moved by ${after - free}`);
    }
  }
});

test('an order paid from the wallet before the rebase and cancelled after it gives back its dinars, not 20% more', async () => {
  const { raw, db } = setup();
  raw.exec(`
    INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,
      delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,
      wallet_applied_iqd,wallet_applied_usd_cents,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
    VALUES('ORD1','buyer','pending','received','preorder_land','{}','pickup','{}','cash',100000,0,0,50000,3572,${L},100000,50000,'ord1');
    INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot) VALUES
      ('wtx_ord_ORD1_usd','buyer','withdrawal','USD',3572,'approved','ORD1',50000,${L});
  `);
  await topUp(db, raw, 'buyer', 60_000, 'pay');
  await topUp(db, raw, 'buyer', 10_000, 'left');
  holdingMoneyAtU(raw);
  const before = (await wallet(app(db))).balance_iqd as number;
  assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');
  assert.equal((await wallet(app(db))).balance_iqd, before);

  const buyer = stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/orders', orderRoutes));
  const res = await post(buyer, '/api/orders/ORD1/cancel', {});
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  const refund = row<Record<string, number>>(raw, "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = 'wtx_refund_ORD1_usd'")!;
  assert.deepEqual([refund.amount, refund.amount_iqd, refund.exchange_rate_snapshot], [Math.floor((3572 * L) / U), 50_000, U]);
  const back = ((await wallet(app(db))).balance_iqd as number) - before;
  // The 50,000 paid, to the dinar the reading's own floor allows (one cent at U is 16.8 دينار).
  assert.ok(back >= 50_000 && back <= 50_001, `gave back ${back}`);
});

/**
 * THE SAME REFUND A MINUTE BEFORE OR A MINUTE AFTER THE REBASE. A payment taken while the legacy
 * setting stood at R = 1,450 (it moved to L = 1,400 later) took 3,448 cents for 50,000 د.ع: the
 * wallet gave up 48,272 at L plus a 4 دينار remainder. Refunded after the rebase it gives back those
 * 48,276, not the 50,000 its dinars say — that copy handed the customer 1,725 they never had.
 */
const R = 1450;
const PAID_AT_R = Math.floor((50_000 * 100) / R);
const balance = async (db: D1Database) => (await wallet(app(db))).balance_iqd as number;

/** Wallet money at L, U applied, no marker yet; 70,000 د.ع topped up, 50,000 of it paid at `rate` under `ref`. */
async function paidAt(rate: number, cents: number, ref: string, debitId: string, sql: string) {
  const { raw, db } = setup();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Boss','boss@x.co','h','admin')");
  holdingMoneyAtU(raw);
  await topUp(db, raw, 'buyer', 60_000, 'pay');
  await topUp(db, raw, 'buyer', 10_000, 'left');
  raw.exec(`${sql};
    INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,ref,amount_iqd,exchange_rate_snapshot)
      VALUES ('${debitId}','buyer','withdrawal','USD',${cents},'approved','${ref}',50000,${rate});`);
  return { raw, db };
}

const walletOrder = (rate: number, cents: number) =>
  paidAt(rate, cents, 'ORD1', 'wtx_ord_ORD1_usd', `INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,
      delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,points_discount_iqd,
      wallet_applied_iqd,wallet_applied_usd_cents,exchange_rate,total_iqd,due_on_delivery_iqd,idempotency_key)
    VALUES('ORD1','buyer','pending','received','preorder_land','{}','pickup','{}','wallet',50000,0,0,50000,${cents},${rate},50000,0,'ord1')`);

async function cutPrice(db: D1Database, newTotalIqd: number, key: string) {
  const env = { DB: db } as never;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"ok":true,"result":{"message_id":1,"chat":{"id":1}}}')) as typeof fetch;
  try {
    const p = await proposePriceAdjustment(env, { orderId: 'ORD1', adminId: 'boss', newTotalIqd, reason: 'supplier', note: '', idempotencyKey: key });
    const d = await decidePriceAdjustment(env, { adjustmentId: p.adjustment.id, decision: 'approve', actorUserId: 'buyer', via: 'web' });
    assert.equal(d.outcome, 'approved');
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function cancelOrder(db: D1Database) {
  const buyer = stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/orders', orderRoutes));
  const res = await post(buyer, '/api/orders/ORD1/cancel', {});
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
}

test('an order paid at a legacy rate above L, cancelled after the rebase, gives back what the same cancel gave just before it — and so does a price cut then a cancel', async () => {
  for (const cut of [null, 30_000]) {
    const gains: number[] = [];
    for (const rebaseFirst of [false, true]) {
      const { raw, db } = await walletOrder(R, PAID_AT_R);
      if (rebaseFirst) assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');
      const before = await balance(db);
      if (cut) await cutPrice(db, cut, 'cut');
      await cancelOrder(db);
      gains.push((await balance(db)) - before);
      if (rebaseFirst && !cut) {
        assert.deepEqual(
          row(raw, "SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = 'wtx_refund_ORD1_usd'"),
          { amount: Math.floor((PAID_AT_R * L) / U), amount_iqd: Math.floor((PAID_AT_R * L) / 100) + 50_000 - Math.floor((PAID_AT_R * R) / 100), exchange_rate_snapshot: U }
        );
      }
    }
    const [pre, after] = gains;
    assert.ok(pre! < 50_000, `before the rebase the cancel gave back ${pre}`);
    // The cut credits its own rounded cents, then the cancel the rest: one cent at U of rounding, never 1,700 دينار.
    assert.ok(Math.abs(after! - pre!) <= (cut ? Math.ceil(U / 100) : 1), `${cut ? 'cut then cancel' : 'cancel'}: ${pre} before, ${after} after`);
  }
});

test('a membership charged at a legacy rate above L and refunded after the rebase gives back what the same refund gave just before it', async () => {
  const gains: number[] = [];
  for (const rebaseFirst of [false, true]) {
    const { db } = await paidAt(R, PAID_AT_R, 'mem1', 'wtx_mem1', `INSERT INTO memberships
        (id, user_id, plan_id, tier, state, duration_months, price_paid_iqd, starts_at, expires_at, source, wallet_tx_id)
      VALUES ('mem1','buyer','plus_12mo','plus','active',12,50000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z','purchase','wtx_mem1')`);
    if (rebaseFirst) assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');
    const before = await balance(db);
    const boss = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/memberships', membershipsRoutes));
    const res = await post(boss, '/api/memberships/admin/mem1/cancel', { refund: true });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
    gains.push((await balance(db)) - before);
  }
  const [pre, after] = gains;
  assert.ok(pre! < 50_000 && Math.abs(after! - pre!) <= 1, `${pre} before, ${after} after`);
});

test('an escrow held at a legacy rate above L and settled after the rebase spends what the same settlement spent just before it', async () => {
  for (const settle of ['partial', 'release'] as const) {
    const moved: number[] = [];
    for (const rebaseFirst of [false, true]) {
      const { raw, db } = setup();
      communityOrder(raw);
      holdingMoneyAtU(raw);
      await topUp(db, raw, 'buyer', 100_000, 'esc');
      raw.exec(`UPDATE admin_settings SET value = '${R}' WHERE key = 'exchangeRate'`);
      const held = await holdCommunityOrder(db);
      assert.equal(held.ok, true, JSON.stringify(held));
      const escrowId = (held as { escrowId: string }).escrowId;
      raw.exec(`UPDATE admin_settings SET value = '${L}' WHERE key = 'exchangeRate'`);
      if (rebaseFirst) assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');
      const before = await balance(db);
      const done = settle === 'partial'
        ? await refundEscrow(db, { escrowId, actorId: 'boss', actorRole: 'admin', amountIqd: 20_000, idempotencyKey: 'prf' })
        : await releaseEscrow(db, { escrowId, actorId: 'buyer', actorRole: 'customer', idempotencyKey: 'rel' });
      assert.equal(done.ok, true, JSON.stringify(done));
      moved.push((await balance(db)) - before);
    }
    const [pre, after] = moved;
    // Within the stated cost of releasing a rounded-up hold: one cent at U (DECISIONS row 252).
    assert.ok(Math.abs(after! - pre!) <= Math.ceil(U / 100), `${settle}: ${pre} before, ${after} after`);
  }
});

test('the cancel repair still finds an order paid before the rebase, price-cut after it and cancelled without its refund — and gives back its dinars once', async () => {
  const { raw, db } = await walletOrder(L, 3572);
  const before = await balance(db);
  assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');
  // The repair reads a cut as "after the rebase" only when its created_at is
  // STRICTLY later than rebased_at. Both come from SQLite's own clock, and on
  // Windows that clock moves in steps of about 15.6 ms: the cut was stamped
  // with the rebase's own instant about one run in three, and the order then
  // read as never cut. Live, the one-time rebase is long past; only this test
  // can tie, so it waits past one clock step.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await cutPrice(db, 30_000, 'cut');
  // The historical shape the repair exists for: cancelled with no refund posted.
  raw.exec("UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ORD1'");
  assert.deepEqual(await repairCancelledOrderRefunds({ DB: db } as never), { scanned: 1, repaired: 1, skipped: 0, errors: 0 });
  assert.equal((await repairCancelledOrderRefunds({ DB: db } as never)).scanned, 0);
  const back = (await balance(db)) - before;
  assert.ok(back >= 50_000 && back <= 50_001, `gave back ${back}`);
});

test('after the rebase an unreadable applied rate keeps the wallet on U, never back on the legacy rate', async () => {
  const { raw, db } = setup();
  await topUp(db, raw, 'buyer', 50_000, 'b1');
  holdingMoneyAtU(raw);
  assert.equal((await runWalletRateRebase({ DB: db })).status, 'rebased');
  assert.equal(await getOfficialUsdRate(db), U);
  raw.exec('ALTER TABLE pricing_fx_rates RENAME TO pricing_fx_rates_unreadable');
  assert.equal(await getOfficialUsdRate(db), U, 'the last U this isolate read');
  assert.equal(await getOfficialUsdRate(asD1(raw)), U, 'a fresh handle: the U the rebase moved to');
  assert.equal((await wallet(app(asD1(raw)))).balance_iqd, 50_000);
});
