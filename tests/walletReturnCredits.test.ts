/**
 * A RETURN AND A PRICE-PROTECTION CREDIT GIVE BACK THE DINARS, NOT THEIR CENTS.
 *
 * worker/routes/returns.ts credited an approved return with
 * `Math.round(iqd × 100 / rate)` cents and nothing else, so a 50,000 د.ع
 * return came back as 3,571 cents — «+49,994» on the operations list — and a
 * customer who paid 50,000 from the wallet was left six dinars short of never
 * having ordered. Both credits now floor the cents and record the dinars beside
 * them at the ORDER's rate (`walletCreditStatement`, migration 0108).
 *
 * These run the REAL routes (the return transition and the claim decision)
 * over every migration, with only the session stubbed, and read the ledger row
 * and the customer's own GET /api/wallet — so dropping `amountIqd` from either
 * call, or putting `Math.round` back, fails here whatever the source looks like.
 *
 * Run: node --import tsx --test tests/walletReturnCredits.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, json, post, get, row } from './fixtures/app';
import { returnRoutes, priceProtectionRoutes } from '../worker/routes/returns';
import { walletRoutes } from '../worker/routes/wallet';
import { createDepositRequest, usdSpendStatement, walletSpendCents } from '../worker/lib/walletOps';
import { iqdToUsdCents } from '../src/lib/api';

const RATE = 1400;

/**
 * A customer who topped up 50,000 د.ع and spent all of it on one 50,000 order,
 * exactly as checkout debits it (`walletSpendCents`, dinars on the debit).
 */
async function seed(): Promise<{ raw: DatabaseSync; db: D1Database }> {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('boss','Admin','a@x.co','h','admin');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types) VALUES
      ('p1','p1','Printer',50000,'active',10,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-W','buyer','delivered','{}','standard','{}','wallet',50000,0,${RATE},50000,0,'2026-06-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd,option_id,option_value_ids,color_id)
      VALUES ('oi_1','ORD-W','p1','Printer','',1,50000,50000,'','[]','');
  `);
  const db = asD1(raw);
  const dep = await createDepositRequest(db, {
    userId: 'buyer',
    amountCents: iqdToUsdCents(50_000, RATE),
    receiptKey: 'receipts/buyer/r.png',
    provider: 'zaincash',
    channel: 'app',
    reference: 'TOPUP',
    declaredAmountIqd: 50_000,
    exchangeRateSnapshot: RATE,
    txId: 'wtx_topup',
  });
  assert.equal(dep.ok, true, JSON.stringify(dep));
  raw.prepare("UPDATE wallet_transactions SET status = 'approved' WHERE id = 'wtx_topup'").run();
  const cents = walletSpendCents(50_000, 3571, RATE);
  await db.batch([
    usdSpendStatement(db, {
      txId: 'wtx_ord_W_usd',
      userId: 'buyer',
      amountCents: cents,
      note: 'Wallet payment on order ORD-W',
      ref: 'ORD-W',
      nowIso: '2026-06-01T00:00:00.000Z',
      amountIqd: 50_000,
      exchangeRateSnapshot: RATE,
    }),
  ]);
  return { raw, db };
}

const customer = (db: D1Database) =>
  stubApp(db, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/wallet', walletRoutes));
const admin = (db: D1Database) =>
  stubApp(db, { id: 'boss', role: 'admin', email: 'a@x.co' }, (a) => {
    a.route('/api/returns', returnRoutes);
    a.route('/api/price-protection', priceProtectionRoutes);
  });
const balanceIqd = async (db: D1Database) => (await json(await get(customer(db), '/api/wallet'))).balance_iqd;

const creditRow = (raw: DatabaseSync, id: string) =>
  row<{ amount: number; amount_iqd: number | null; exchange_rate_snapshot: number | null }>(
    raw,
    'SELECT amount, amount_iqd, exchange_rate_snapshot FROM wallet_transactions WHERE id = ?',
    id
  );

test('an approved return of a 50,000 wallet-paid order puts the wallet back at 50,000', async () => {
  const { raw, db } = await seed();
  assert.equal(await balanceIqd(db), 0, 'the order spent the whole balance');

  raw
    .prepare(
      `INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,within_window,delivered_at_snapshot)
       VALUES ('rc1','ORD-W','oi_1','buyer',1,'defective','inspected',1,'2026-06-01T00:00:00.000Z')`
    )
    .run();
  const res = await json(await post(admin(db), '/api/returns/admin/rc1/transition', { to: 'resolved', resolution: 'refund' }));
  assert.equal(res.success, true, JSON.stringify(res));

  assert.deepEqual(creditRow(raw, 'wtx_ret_rc1'), { amount: 3571, amount_iqd: 50_000, exchange_rate_snapshot: RATE });
  assert.equal(await balanceIqd(db), 50_000, 'not 49,994: the customer is no poorer than before ordering');
  const tx = (await json(await get(customer(db), '/api/wallet'))).transactions.find(
    (t: { id: string }) => t.id === 'wtx_ret_rc1'
  );
  assert.equal(tx.amount_iqd, 50_000, 'the operations list reads «+50,000»');
});

test('an approved price-protection claim credits exactly the approved dinars', async () => {
  const { raw, db } = await seed();
  // The price fell from 50,000 to 44,993 after the order: 5,007 د.ع owed —
  // 357.64 cents, where rounding (358 → 5,012) and flooring part ways.
  raw
    .prepare(
      `INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
       VALUES ('ppc1','buyer','ORD-W','oi_1',50000,44993,1,'requested')`
    )
    .run();
  const res = await json(await post(admin(db), '/api/price-protection/admin/claims/ppc1/decide', { decision: 'approved' }));
  assert.equal(res.success, true, JSON.stringify(res));

  // Floored to 357 cents, which on their own read 4,998.
  assert.deepEqual(creditRow(raw, 'wtx_pp_ppc1'), { amount: 357, amount_iqd: 5_007, exchange_rate_snapshot: RATE });
  assert.equal(await balanceIqd(db), 5_007, 'the approved 5,007, not its cents converted back');
});
