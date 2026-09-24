/**
 * THE SETTLEMENT RULE — a committed purchase hold always posts its ledger
 * debit in the same transaction (walletOps.commitHoldStatements).
 *
 * Before the rule, `commitHold` only flipped `state`, and `effectiveHoldsUsdSql`
 * stops counting a hold the moment it leaves `active`, so the buyer's whole
 * spendable balance came back the instant a store order or an escrow release
 * "committed" — while the merchant was credited. A later cancel then refunded
 * money that had never been taken. These tests pin the correct behaviour on
 * the real routes and the real migrations:
 *
 *   - a wallet-paid store order debits the buyer EXACTLY once, at placement;
 *   - place → cancel returns the balance to exactly the deposit, never above;
 *   - an escrow release debits the customer once and pays the merchant in
 *     the same batch; a partial refund nets to what the merchant receives;
 *   - a merchant is never credited unless the buyer's debit posted in the
 *     same batch — a sabotaged hold refuses the whole settlement;
 *   - legacy committed-without-debit rows are REPORTED by reconciliation and
 *     never rewritten.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb, asD1, failingD1, stubApp, post, get, json, ledger, holds, spendable, count, row, pending,
} from './fixtures/app';
import { walletRoutes } from '../worker/routes/wallet';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { orderRoutes } from '../worker/routes/orders';
import { holdEscrow, releaseEscrow, refundEscrow, merchantBalance } from '../worker/lib/escrowOps';
import {
  commitHold, createPurchaseHold, createWithdrawalHold, holdDebitTxId, walletReconciliationReport,
} from '../worker/lib/walletOps';

const DEP = 100_000; // cents

function seedStore(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'),
      ('mowner','Ali','mo@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m1','mowner','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings)
      VALUES ('s1','m1','mowner','ali3d','Ali 3D','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock)
      VALUES ('cp1','m1','s1','widget','Widget','active','active',14000,100,0);
    INSERT INTO addresses (id,user_id,name,phone,address) VALUES ('a1','buyer','Sara','+964770','Baghdad');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed funding');
    INSERT INTO cart_items (id,user_id,seller_type,merchant_id,store_id,community_product_id,qty)
      VALUES ('ci1','buyer','merchant','m1','s1','cp1',1);
    -- A store sells only while its owner holds the store entitlement.
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem1','mowner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
}

const buyerApp = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/store-orders', storeOrderRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/wallet', walletRoutes);
  });

/** Place as the checkout page does: confirm the quote's fingerprint (B12). */
async function placeStore(app: ReturnType<typeof buyerApp>, body: Record<string, unknown>) {
  const q = await json(await post(app, '/api/store-orders/quote', {}));
  return post(app, '/api/store-orders', { quoteFingerprint: q.quote?.quote_fingerprint, ...body });
}

// ------------------------------------------------------------ store orders

test('a wallet-paid store order debits the buyer exactly once, at placement, inside the order batch', async () => {
  const raw = freshDb();
  seedStore(raw);
  const app = buyerApp(asD1(raw));

  const placed = await json(await placeStore(app, { idempotencyKey: 'store-key-0001', addressId: 'a1', payWithWallet: true }));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;

  // total 14,000 IQD at 1,400 IQD/USD = 1,000 cents: held, then settled.
  const h = holds(raw, 'buyer');
  assert.equal(h.length, 1);
  assert.equal(h[0].state, 'committed');
  assert.equal(h[0].tx_id, holdDebitTxId(h[0].id), 'the hold is linked to the debit it settled into');

  const debits = ledger(raw, 'buyer').filter((t) => t.type === 'withdrawal');
  assert.equal(debits.length, 1, 'exactly one debit');
  assert.equal(debits[0].id, holdDebitTxId(h[0].id));
  assert.equal(debits[0].amount, 1000);
  assert.equal(debits[0].status, 'approved');
  assert.equal(debits[0].ref, orderId);

  assert.equal(spendable(raw, 'buyer'), DEP - 1000, 'the buyer actually paid');
  const wallet = await json(await get(app, '/api/wallet'));
  assert.equal(wallet.balance_usd_cents, DEP - 1000, 'the wallet page shows the money gone');
  assert.equal(Number(placed.order.wallet_applied_usd_cents), 1000);

  // The merchant's share is pending, as before — and now backed by real money.
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_payout_ledger WHERE merchant_id='m1' AND kind='sale_credit' AND state='pending'"), 1);
  await Promise.allSettled(pending);
});

test('place → cancel returns the balance to EXACTLY the original deposit, never above it', async () => {
  const raw = freshDb();
  seedStore(raw);
  const app = buyerApp(asD1(raw));
  const placed = await json(await placeStore(app, { idempotencyKey: 'store-key-0002', addressId: 'a1', payWithWallet: true }));
  const orderId = placed.order.id as string;
  assert.equal(spendable(raw, 'buyer'), DEP - 1000);

  const cancelled = await json(await post(app, `/api/orders/${orderId}/cancel`, {}));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));

  const refund = row<{ amount: number; type: string }>(raw, 'SELECT amount, type FROM wallet_transactions WHERE id = ?', `wtx_refund_${orderId}_usd`);
  assert.ok(refund, 'the refund reverses the debit');
  assert.equal(refund.amount, 1000);
  assert.equal(spendable(raw, 'buyer'), DEP, 'back to the deposit — not a cent more');

  // Ledger: seed deposit, the purchase debit, the refund credit. Nothing else.
  assert.deepEqual(ledger(raw, 'buyer').map((t) => [t.type, t.amount]), [['deposit', DEP], ['withdrawal', 1000], ['deposit', 1000]]);
  await Promise.allSettled(pending);
});

test('a failed order batch leaves the hold active and nothing else written; the retry settles it once', async () => {
  const raw = freshDb();
  seedStore(raw);
  const { failing, db } = failingD1(raw);
  const app = buyerApp(db);

  failing.failWhen = (stmts) => stmts.some((s) => /INSERT INTO orders/i.test(s.sql));
  const first = await placeStore(app, { idempotencyKey: 'store-key-0003', addressId: 'a1', payWithWallet: true });
  assert.equal(first.status, 500);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger'), 0, 'no merchant share without an order');
  assert.equal(ledger(raw, 'buyer').filter((t) => t.type === 'withdrawal').length, 0, 'no debit without an order');
  assert.equal(holds(raw, 'buyer')[0].state, 'active', 'the reservation survives the failure');
  assert.equal(spendable(raw, 'buyer'), DEP - 1000, 'and still reserves the money');

  failing.failWhen = null;
  const retry = await json(await placeStore(app, { idempotencyKey: 'store-key-0003', addressId: 'a1', payWithWallet: true }));
  assert.equal(retry.success, true, JSON.stringify(retry));
  assert.equal(holds(raw, 'buyer').length, 1, 'the same hold was reused, not a second one');
  assert.equal(holds(raw, 'buyer')[0].state, 'committed');
  assert.equal(ledger(raw, 'buyer').filter((t) => t.type === 'withdrawal').length, 1, 'debited exactly once across the retry');
  assert.equal(spendable(raw, 'buyer'), DEP - 1000);
  await Promise.allSettled(pending);
});

// --------------------------------------------------------- hold primitives

test('commitHold posts the debit with the flip, replays without a second debit, and refuses non-purchase or spent holds', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u1','U','u1@x.co','h');
            INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
              VALUES ('dep','u1','deposit','USD',${DEP},'approved','seed');`);
  const db = asD1(raw);

  const created = await createPurchaseHold(db, { userId: 'u1', amountCents: 40_000, eventKey: 'p1' });
  assert.ok(created.ok);
  const holdId = (created as { holdId: string }).holdId;
  assert.equal(spendable(raw, 'u1'), DEP - 40_000, 'reserved');

  const first = await commitHold(db, { holdId, note: 'test purchase', ref: 'ORD-T' });
  assert.deepEqual(first, { ok: true, holdId, replayed: false, txId: holdDebitTxId(holdId) });
  assert.equal(spendable(raw, 'u1'), DEP - 40_000, 'the reservation turned into a debit — the balance moved once, not twice');
  const debit = row<{ amount: number; status: string; type: string; ref: string }>(raw, 'SELECT amount, status, type, ref FROM wallet_transactions WHERE id = ?', holdDebitTxId(holdId));
  assert.deepEqual(debit, { amount: 40_000, status: 'approved', type: 'withdrawal', ref: 'ORD-T' });

  const again = await commitHold(db, { holdId, note: 'test purchase', ref: 'ORD-T' });
  assert.deepEqual(again, { ok: true, holdId, replayed: true, txId: holdDebitTxId(holdId) });
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='u1' AND type='withdrawal'"), 1, 'a replay posts nothing');

  // A withdrawal hold settles through markWithdrawalPaid, never here.
  const wd = await createWithdrawalHold(db, { userId: 'u1', amountCents: 10_000, eventKey: 'w1' });
  assert.ok(wd.ok);
  const wdHold = (wd as { holdId: string }).holdId;
  assert.deepEqual(await commitHold(db, { holdId: wdHold }), { ok: false, reason: 'STATE_CONFLICT', holdId: wdHold });
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='u1' AND type='withdrawal'"), 1);
  assert.equal(holds(raw, 'u1').find((h) => h.id === wdHold)?.state, 'active');

  // An unfunded reservation (only reachable by a manual edit) cannot settle.
  raw.exec("UPDATE wallet_transactions SET status='rejected' WHERE id='dep'");
  const p2 = await createPurchaseHold(db, { userId: 'u1', amountCents: 500, eventKey: 'p2' });
  assert.equal(p2.ok, false, 'no money, no hold');
  raw.exec(`INSERT INTO wallet_holds (id,user_id,kind,amount_cents,state,event_key) VALUES ('whold_unfunded','u1','purchase',500,'active','manual')`);
  assert.deepEqual(await commitHold(db, { holdId: 'whold_unfunded' }), { ok: false, reason: 'STATE_CONFLICT', holdId: 'whold_unfunded' });
  assert.equal(row(raw, "SELECT id FROM wallet_transactions WHERE id = ?", holdDebitTxId('whold_unfunded')), undefined);
});

// ----------------------------------------------------------------- escrow

function seedEscrow(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('cust','Sara','c@x.co','h','customer'), ('mo','Ali','a@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','mo','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','mo','ali3d','Ali 3D');
    INSERT INTO community_requests (id,customer_id,title) VALUES ('r1','cust','Print');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('o1','r1','m1',70000);
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','cust','m1',70000,7000,63000);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','1400');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('dep_cust','cust','deposit','USD',${DEP},'approved','seed funding');
  `);
}
const escrowFor = (db: D1Database, key = 'accept:co1') =>
  holdEscrow(db, {
    communityOrderId: 'co1', customerId: 'cust', merchantId: 'm1',
    grossIqd: 70_000, platformFeeIqd: 7_000, merchantReceivableIqd: 63_000, idempotencyKey: key,
  });

test('releasing an escrow debits the customer once and credits the merchant in the same batch', async () => {
  const raw = freshDb();
  seedEscrow(raw);
  const db = asD1(raw);
  const held = await escrowFor(db);
  assert.equal(held.ok, true, JSON.stringify(held));
  const escrowId = (held as { escrowId: string }).escrowId;
  assert.equal(spendable(raw, 'cust'), DEP - 5000, '70,000 IQD / 1,400 = 5,000 cents reserved');

  const rel = await releaseEscrow(db, { escrowId, actorId: 'cust', actorRole: 'customer', idempotencyKey: 'confirm:co1' });
  assert.deepEqual(rel, { ok: true, replayed: false, escrowId });

  const h = holds(raw, 'cust')[0];
  assert.equal(h.state, 'committed');
  assert.equal(h.tx_id, holdDebitTxId(h.id));
  const debits = ledger(raw, 'cust').filter((t) => t.type === 'withdrawal');
  assert.equal(debits.length, 1);
  assert.equal(debits[0].amount, 5000);
  assert.equal(spendable(raw, 'cust'), DEP - 5000, 'the customer paid — the balance did not spring back');
  // `paid` is PAYOUTS only: the platform's 7,000 commission row is not money
  // paid out to the merchant (audit 02 B20).
  assert.deepEqual(await merchantBalance(db, 'm1'), { available_iqd: 63_000, pending_iqd: 0, paid_iqd: 0 });

  // A second release (any key) pays and debits nothing more.
  const again = await releaseEscrow(db, { escrowId, actorId: 'cust', actorRole: 'customer', idempotencyKey: 'confirm:co1:again' });
  assert.equal(again.ok, true);
  assert.equal(ledger(raw, 'cust').filter((t) => t.type === 'withdrawal').length, 1);
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 63_000);
});

test('a partial refund nets to exactly what the merchant receives: full debit, then the refunded part credited back', async () => {
  const raw = freshDb();
  seedEscrow(raw);
  const db = asD1(raw);
  const escrowId = ((await escrowFor(db)) as { escrowId: string }).escrowId;

  const ref = await refundEscrow(db, { escrowId, actorId: 'cust', actorRole: 'customer', amountIqd: 35_000, idempotencyKey: 'partial:co1' });
  assert.deepEqual(ref, { ok: true, replayed: false, escrowId });

  assert.equal(holds(raw, 'cust')[0].state, 'committed');
  const debits = ledger(raw, 'cust').filter((t) => t.type === 'withdrawal');
  const credits = ledger(raw, 'cust').filter((t) => t.type === 'deposit' && t.id !== 'dep_cust');
  assert.equal(debits.length, 1);
  assert.equal(debits[0].amount, 5000, 'the whole hold is settled');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, 2500, '35,000 IQD / 1,400 = 2,500 cents comes back');
  assert.equal(spendable(raw, 'cust'), DEP - 2500, 'net: the customer paid for the kept half only');
  // The merchant earns on the kept half — 35,000 IQD, capped by the receivable.
  assert.equal((await merchantBalance(db, 'm1')).available_iqd, 35_000);
});

test('a full refund releases the hold: no debit, no credit, no merchant row, balance untouched', async () => {
  const raw = freshDb();
  seedEscrow(raw);
  const db = asD1(raw);
  const escrowId = ((await escrowFor(db)) as { escrowId: string }).escrowId;
  const ref = await refundEscrow(db, { escrowId, actorId: 'mo', actorRole: 'merchant', idempotencyKey: 'cancel:co1' });
  assert.deepEqual(ref, { ok: true, replayed: false, escrowId });
  assert.equal(holds(raw, 'cust')[0].state, 'released');
  assert.equal(ledger(raw, 'cust').length, 1, 'only the seed deposit');
  assert.equal(spendable(raw, 'cust'), DEP);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger'), 0);
});

test('a merchant is never credited without the buyer debit: a hold that cannot settle refuses the whole release', async () => {
  const raw = freshDb();
  seedEscrow(raw);
  const db = asD1(raw);
  const escrowId = ((await escrowFor(db)) as { escrowId: string }).escrowId;
  const holdId = holds(raw, 'cust')[0].id;

  // Sabotage: the hold is released out-of-band while the escrow still says held.
  raw.prepare("UPDATE wallet_holds SET state='released', released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(holdId);

  const rel = await releaseEscrow(db, { escrowId, actorId: 'cust', actorRole: 'customer', idempotencyKey: 'confirm:co1' });
  assert.deepEqual(rel, { ok: false, reason: 'WALLET_ERROR', detail: 'hold is released' });
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger'), 0, 'not a dinar for the merchant');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM community_escrow_events WHERE kind='release'"), 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', escrowId)?.state, 'held', 'the escrow did not move either');
  assert.equal(ledger(raw, 'cust').filter((t) => t.type === 'withdrawal').length, 0);

  // Same for the partial refund path.
  const part = await refundEscrow(db, { escrowId, actorId: 'cust', actorRole: 'customer', amountIqd: 35_000, idempotencyKey: 'partial:co1' });
  assert.equal(part.ok, false);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger'), 0);
  assert.equal(ledger(raw, 'cust').length, 1, 'no credit for a refund of money never debited');
});

test('a transient failure inside the settlement batch writes nothing on either side', async () => {
  const raw = freshDb();
  seedEscrow(raw);
  const { failing, db } = failingD1(raw);
  const escrowId = ((await escrowFor(db)) as { escrowId: string }).escrowId;
  failing.failWhen = (stmts) => stmts.some((s) => /merchant_payout_ledger/i.test(s.sql));
  await assert.rejects(releaseEscrow(db, { escrowId, actorId: 'cust', actorRole: 'customer', idempotencyKey: 'confirm:co1' }));
  assert.equal(holds(raw, 'cust')[0].state, 'active');
  assert.equal(ledger(raw, 'cust').length, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_payout_ledger'), 0);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_escrows WHERE id = ?', escrowId)?.state, 'held');
});

// --------------------------------------------------------- reconciliation

test('reconciliation REPORTS a legacy committed hold without a debit and never rewrites it', async () => {
  const raw = freshDb();
  seedStore(raw);
  const db = asD1(raw);
  // A row exactly as the pre-rule store checkout left it: committed, unlinked.
  raw.exec(`INSERT INTO wallet_holds (id,user_id,kind,amount_cents,state,event_key,ref_type,ref_id,committed_at)
            VALUES ('whold_legacy','buyer','purchase',1000,'committed','store-order:old','store_order','old',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);

  const report = await walletReconciliationReport(db);
  const leak = report.anomalies.filter((a) => a.kind === 'committed_hold_without_debit');
  assert.equal(leak.length, 1);
  assert.equal(leak[0].ref, 'whold_legacy');
  assert.equal(leak[0].user_id, 'buyer');
  assert.match(leak[0].detail, /no ledger debit/);
  assert.equal(report.committed_holds_without_debit, 1);
  assert.equal(report.totals.committed_without_debit_usd_cents, 1000);

  // Not repaired: the row is exactly as it was.
  assert.deepEqual(
    row(raw, 'SELECT state, tx_id FROM wallet_holds WHERE id = ?', 'whold_legacy'),
    { state: 'committed', tx_id: null }
  );
  assert.equal(count(raw, "SELECT COUNT(*) n FROM wallet_transactions WHERE user_id='buyer' AND type='withdrawal'"), 0);

  // A hold settled under the rule is clean, and the admin route exposes the count.
  const app = buyerApp(db);
  await placeStore(app, { idempotencyKey: 'store-key-0009', addressId: 'a1', payWithWallet: true });
  const after = await walletReconciliationReport(db);
  assert.equal(after.committed_holds_without_debit, 1, 'still only the legacy row');
  const adminApp = stubApp(db, { id: 'mowner', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/wallet', walletRoutes));
  const viaRoute = await json(await get(adminApp, '/api/wallet/admin/reconciliation'));
  assert.equal(viaRoute.report.committed_holds_without_debit, 1);
  await Promise.allSettled(pending);
});
