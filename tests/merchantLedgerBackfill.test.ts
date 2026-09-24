/**
 * THE SWITCH TO THE APPEND-ONLY LEDGER LOSES NOT ONE DINAR (migration 0121).
 *
 *   · every shape the old `merchant_payout_ledger` can hold — a pending sale,
 *     a sale released by the pre-wave-1 merchant tap (no delivery credited), a
 *     reversed sale, a claw-back, an escrow credit with its commission row, a
 *     partial settlement, the B3 double payout that left «available» negative,
 *     a credit whose order was deleted, a manual row — is carried so that each
 *     merchant's pending, available and paid are IDENTICAL to the wave-1
 *     formulas over the old table;
 *   · the sale split (gross / commission / delivery) comes from the order's own
 *     snapshot only where it adds back exactly;
 *   · the backfill is deterministic and re-runnable;
 *   · during the deploy window the OLD code's writes (an insert, a release
 *     flip, a cancel flip, a payout) are mirrored as the moves they were.
 *
 * Run: node --import tsx --test tests/merchantLedgerBackfill.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dbThrough, asD1, all, count, row } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { financeSummary, legacyParity, merchantBuckets } from '../worker/lib/merchantLedger';

const MIGRATION = readFileSync(join(ROOT, 'migrations/0121_merchant_ledger.sql'), 'utf8');

function oldBalances(raw: DatabaseSync, m: string) {
  return row<{ pending: number; available: number; paid: number }>(
    raw,
    `SELECT COALESCE(SUM(CASE WHEN state = 'pending' THEN amount_iqd ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN state = 'available' OR kind = 'payout' THEN amount_iqd ELSE 0 END), 0) AS available,
            COALESCE(SUM(CASE WHEN kind = 'payout' THEN amount_iqd ELSE 0 END), 0) AS paid
       FROM merchant_payout_ledger WHERE merchant_id = ?`,
    m
  )!;
}

function storeOrder(raw: DatabaseSync, id: string, m: string, s: string, subtotal: number, discount: number, fee: number, ship: number) {
  raw.prepare(
    `INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
       subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,seller_type,merchant_id,store_id,origin,
       coupon_discount_iqd,platform_fee_iqd,shipping_iqd,merchant_receivable_iqd)
     VALUES (?, 'buyer','delivered','{}','merchant','{}','wallet',?,1400,?,0,'merchant',?,?,'store_product',?,?,?,?)`
  ).run(id, subtotal, subtotal - discount + ship, m, s, discount, fee, ship, subtotal - discount - fee + ship);
}

/** A database as production had it on the day 0121 shipped: through 0120, with every legacy shape. */
function legacyDb(): DatabaseSync {
  const raw = dbThrough('0120');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','b@x.co','h','customer'), ('ali','Ali','a@x.co','h','merchant'),
      ('zed','Zed','z@x.co','h','merchant'), ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','ali','Ali 3D'), ('m2','zed','Zed');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','ali','ali3d','Ali 3D'), ('s2','m2','zed','zed3d','Zed');
    INSERT INTO community_requests (id,customer_id,title,state) VALUES ('r1','buyer','Bracket','completed'), ('r2','buyer','Gear','completed');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('o1','r1','m1','s1',50000,'accepted'), ('o2','r2','m1','s1',20000,'accepted');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd) VALUES
      ('co1','r1','o1','buyer','m1','s1','completed',50000,2500,47500), ('co2','r2','o2','buyer','m1','s1','refunded',20000,1000,19000);
    INSERT INTO community_escrows (id,community_order_id,customer_id,merchant_id,gross_iqd,platform_fee_iqd,merchant_receivable_iqd,state) VALUES
      ('e1','co1','buyer','m1',50000,2500,47500,'released'), ('e2','co2','buyer','m1',20000,1000,19000,'partially_refunded');
  `);
  // 1 · wave-1 sale, pending: goods 18,000 (after a 2,000 coupon), 5% = 900, delivery 3,000 → 20,100.
  storeOrder(raw, 'ORD-1', 'm1', 's1', 20000, 2000, 900, 3000);
  // 2 · pre-wave-1 sale released by the merchant's tap, delivery NOT credited: 10,000 − 500 = 9,500.
  storeOrder(raw, 'ORD-2', 'm1', 's1', 10000, 0, 500, 2000);
  // 3 · reversed sale.
  storeOrder(raw, 'ORD-3', 'm1', 's1', 5000, 0, 250, 0);
  // 4 · released then clawed back.
  storeOrder(raw, 'ORD-4', 'm1', 's1', 8000, 0, 400, 1000);
  // 10 · a credit that does not match its order's figures.
  storeOrder(raw, 'ORD-10', 'm1', 's1', 7000, 0, 350, 0);
  storeOrder(raw, 'ORD-M2', 'm2', 's2', 4000, 0, 200, 0);
  raw.exec(`
    INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,community_order_id,escrow_id,note,admin_id,idempotency_key,created_at) VALUES
      ('p1','m1','sale_credit',20100,'pending','ORD-1',NULL,NULL,'store sale (incl. delivery)',NULL,'sale:ORD-1','2026-09-01T00:00:00.000Z'),
      ('p2','m1','sale_credit',9500,'available','ORD-2',NULL,NULL,'store sale',NULL,'sale:ORD-2','2026-09-02T00:00:00.000Z'),
      ('p3','m1','sale_credit',4750,'reversed','ORD-3',NULL,NULL,'store sale',NULL,'sale:ORD-3','2026-09-03T00:00:00.000Z'),
      ('p4','m1','sale_credit',8600,'available','ORD-4',NULL,NULL,'store sale',NULL,'sale:ORD-4','2026-09-04T00:00:00.000Z'),
      ('p4r','m1','reversal',-8600,'available','ORD-4',NULL,NULL,'cancelled after release',NULL,'reversal:ORD-4','2026-09-05T00:00:00.000Z'),
      ('p5','m1','community_order_credit',47500,'available',NULL,'co1','e1','',NULL,'credit:confirm:co1','2026-09-06T00:00:00.000Z'),
      ('p5f','m1','commission',-2500,'paid',NULL,'co1','e1','platform commission',NULL,'fee:confirm:co1','2026-09-06T00:00:00.000Z'),
      ('p6','m1','community_order_credit',10000,'available',NULL,'co2','e2','partial settlement',NULL,'partial:admin:x','2026-09-07T00:00:00.000Z'),
      ('p7','m1','payout',-30000,'paid',NULL,NULL,NULL,'Zain cash #1','boss','payout-key-1','2026-09-08T00:00:00.000Z'),
      ('p7b','m1','payout',-30000,'paid',NULL,NULL,NULL,'the B3 double payout','boss','payout-key-2','2026-09-08T01:00:00.000Z'),
      ('p8','m1','sale_credit',1234,'pending','ORD-GONE',NULL,NULL,'order since deleted',NULL,'sale:ORD-GONE','2026-09-09T00:00:00.000Z'),
      ('p9','m1','manual_adjustment',777,'available',NULL,NULL,NULL,'',NULL,'adj:1','2026-09-10T00:00:00.000Z'),
      ('p10','m1','sale_credit',6000,'pending','ORD-10',NULL,NULL,'odd',NULL,'sale:ORD-10','2026-09-11T00:00:00.000Z'),
      ('q1','m2','sale_credit',3800,'pending','ORD-M2',NULL,NULL,'store sale',NULL,'sale:ORD-M2','2026-09-12T00:00:00.000Z');
  `);
  return raw;
}

const lines = (raw: DatabaseSync, legacy: string) =>
  all<{ kind: string; bucket: string; amount_iqd: number }>(
    raw,
    'SELECT kind, bucket, amount_iqd FROM merchant_ledger_entries WHERE legacy_id = ? ORDER BY event_key',
    legacy
  );

async function assertParity(raw: DatabaseSync) {
  const db = asD1(raw);
  for (const m of ['m1', 'm2']) {
    const old = oldBalances(raw, m);
    const now = await merchantBuckets(db, m);
    assert.deepEqual(
      { pending: now.pending, available: now.available, paid: now.paid, reserved: now.reserved },
      { pending: old.pending, available: old.available, paid: 0 - old.paid || 0, reserved: 0 },
      `${m}: the new buckets equal the wave-1 balance of the old table`
    );
  }
  assert.deepEqual((await legacyParity(db)).mismatches, [], 'the parity report agrees');
}

test('backfill parity: every legacy shape carries across with every merchant’s balance unchanged', async () => {
  const raw = legacyDb();
  const before = { m1: oldBalances(raw, 'm1'), m2: oldBalances(raw, 'm2') };
  assert.equal(before.m1.available, 9500 + 47500 + 10000 - 60000 + 777, 'the B3 double payout left «available» negative in the old table');
  raw.exec(MIGRATION);
  await assertParity(raw);

  // The split, from the order's own snapshot, where it adds back exactly.
  assert.deepEqual(lines(raw, 'p1'), [
    { kind: 'commission', bucket: 'pending', amount_iqd: -900 },
    { kind: 'delivery_fee', bucket: 'pending', amount_iqd: 3000 },
    { kind: 'sale_gross', bucket: 'pending', amount_iqd: 18000 },
  ]);
  assert.deepEqual(lines(raw, 'p2'), [
    { kind: 'commission', bucket: 'available', amount_iqd: -500 },
    { kind: 'sale_gross', bucket: 'available', amount_iqd: 10000 },
  ], 'the pre-wave-1 sale credited no delivery, and none is invented');
  assert.equal(lines(raw, 'p3').reduce((a, l) => a + l.amount_iqd, 0), 0, 'a reversed sale nets to zero');
  assert.ok(lines(raw, 'p3').some((l) => l.kind === 'refund'));
  assert.deepEqual(lines(raw, 'p4r').map((l) => [l.kind, l.bucket, l.amount_iqd]), [
    ['commission_refund', 'available', 400],
    ['delivery_refund', 'available', -1000],
    ['refund', 'available', -8000],
  ]);
  assert.deepEqual(lines(raw, 'p5f').map((l) => l.kind).sort(), ['commission', 'escrow_release'], 'the commission row counted nowhere and still nets to zero');
  assert.deepEqual(lines(raw, 'p8'), [{ kind: 'sale_gross', bucket: 'pending', amount_iqd: 1234 }], 'no order: the whole credit is the gross');
  assert.deepEqual(lines(raw, 'p10'), [{ kind: 'sale_gross', bucket: 'pending', amount_iqd: 6000 }], 'figures that do not add up are not split');
  assert.deepEqual(lines(raw, 'p9'), [{ kind: 'adjustment', bucket: 'available', amount_iqd: 777 }]);

  // Legacy payouts are payout records too, with their legs.
  const payouts = all<{ id: string; state: string; amount_iqd: number; source: string }>(
    raw, "SELECT id, state, amount_iqd, source FROM merchant_payouts ORDER BY id"
  );
  assert.deepEqual(payouts, [
    { id: 'mpo_legacy_p7', state: 'paid', amount_iqd: 30000, source: 'legacy' },
    { id: 'mpo_legacy_p7b', state: 'paid', amount_iqd: 30000, source: 'legacy' },
  ]);

  // The summary is the ledger's own sums, and its identity holds.
  const s = await financeSummary(asD1(raw), 'm1');
  assert.equal(s.receivable, s.pending + s.available + s.reserved + s.paid_out);
  assert.equal(s.receivable, s.gross - s.commission + s.delivery_fees - s.refunds + s.adjustments);
  assert.equal(s.paid_out, 60000);
});

test('the backfill is deterministic and re-runnable: a second pass adds nothing', async () => {
  const raw = legacyDb();
  raw.exec(MIGRATION);
  const n = count(raw, 'SELECT COUNT(*) n FROM merchant_ledger_entries');
  const ids = all<{ id: string }>(raw, 'SELECT id FROM merchant_ledger_entries ORDER BY id');
  raw.exec(MIGRATION);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_ledger_entries'), n);
  assert.deepEqual(all<{ id: string }>(raw, 'SELECT id FROM merchant_ledger_entries ORDER BY id'), ids);
  assert.ok(ids.every((r) => r.id.startsWith('mle_legacy_')), 'ids derive from the old row ids');
  await assertParity(raw);
});

test('the deploy window: the OLD code’s inserts and flips after the migration are mirrored as the moves they were', async () => {
  const raw = legacyDb();
  raw.exec(MIGRATION);
  storeOrder(raw, 'ORD-W1', 'm2', 's2', 10000, 0, 500, 2000);
  storeOrder(raw, 'ORD-W2', 'm2', 's2', 6000, 0, 300, 0);
  raw.exec(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,idempotency_key)
            VALUES ('w1','m2','sale_credit',11500,'pending','ORD-W1','sale:ORD-W1'),
                   ('w2','m2','sale_credit',5700,'pending','ORD-W2','sale:ORD-W2')`);
  await assertParity(raw);
  // The old receipt / sweep: pending → available is a release.
  raw.exec("UPDATE merchant_payout_ledger SET state = 'available' WHERE id = 'w1'");
  assert.deepEqual(
    all(raw, "SELECT kind, bucket, amount_iqd FROM merchant_ledger_entries WHERE legacy_id = 'w1' AND kind = 'release' ORDER BY bucket"),
    [{ kind: 'release', bucket: 'available', amount_iqd: 11500 }, { kind: 'release', bucket: 'pending', amount_iqd: -11500 }]
  );
  // The old cancel: pending → reversed is the refund lines.
  raw.exec("UPDATE merchant_payout_ledger SET state = 'reversed' WHERE id = 'w2'");
  assert.deepEqual(
    all(raw, "SELECT kind, amount_iqd FROM merchant_ledger_entries WHERE legacy_id = 'w2' AND kind LIKE '%refund' ORDER BY kind"),
    [{ kind: 'commission_refund', amount_iqd: 300 }, { kind: 'refund', amount_iqd: -6000 }]
  );
  // The old admin payout.
  raw.exec(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,note,admin_id,idempotency_key)
            VALUES ('w3','m2','payout',-5000,'paid','cash','boss','payout-key-w3')`);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM merchant_payouts WHERE id = 'mpo_legacy_w3'")!.state, 'paid');
  // A flip that is no real move (a manual edit) is carried as adjustments, exactly.
  raw.exec("UPDATE merchant_payout_ledger SET state = 'pending' WHERE id = 'p9'");
  await assertParity(raw);
  // Unlinking a deleted order's id (worker/lib/orderDeletion.ts) is not a state change and moves nothing.
  const n = count(raw, 'SELECT COUNT(*) n FROM merchant_ledger_entries');
  raw.exec("UPDATE merchant_payout_ledger SET order_id = NULL WHERE id = 'w2'");
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM merchant_ledger_entries'), n);
});
