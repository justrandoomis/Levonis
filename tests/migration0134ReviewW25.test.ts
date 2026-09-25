/**
 * MIGRATION 0134 (review W2-5, stream W5-C) over rows written before it:
 *   · p6 — the platform's cost lines, cost, floor and margin leave every stored
 *     request revision and every order's copy of one (json_remove, no compound
 *     SELECT); the customer-facing figures stay;
 *   · #7 — an order's merchant contact that is the account's PRIVATE phone is
 *     cleared; a store's published phone is kept;
 *   · #9 — the old `merchant_payout_ledger` refuses inserts and updates (the
 *     0121 deploy-window mirror is gone), except orderDeletion's unlink.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbThrough, freshDb, asD1, row, count } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { deleteCancelledOrder } from '../worker/lib/orderDeletion';

const M0134 = readFileSync(join(ROOT, 'migrations/0134_review_w25_confidential_estimate_old_ledger.sql'), 'utf8');
const RAW_ESTIMATE = JSON.stringify({
  price_iqd: 30000, min_iqd: 25000, max_iqd: 35000, currency: 'IQD',
  cost_lines: [{ label: 'filament', iqd: 4000 }], cost_iqd: 9000, floor_iqd: 12000, margin_percent: 35,
});

function seed() {
  const raw = dbThrough('0133');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','b@x.co','h','customer'), ('ali','Ali','a@x.co','h','merchant'),
      ('omar','Omar','o@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,phone) VALUES ('m1','ali','Ali 3D','+9647511111111'), ('m2','omar','Omar','+9647533333333');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,contact_phone) VALUES
      ('s1','m1','ali','ali3d','Ali 3D',''), ('s2','m2','omar','omar3d','Omar','+9647533333333');
    INSERT INTO community_requests (id,customer_id,title,state) VALUES ('r1','buyer','Stand','in_progress'), ('r2','buyer','Gear','in_progress');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o1','r1','m1','s1',40000,'accepted'), ('o2','r2','m2','s2',40000,'accepted');
  `);
  raw.prepare(`INSERT INTO community_request_revisions (id,request_id,revision,estimate,reason) VALUES ('crv_r1_1','r1',1,?,'backfill')`).run(RAW_ESTIMATE);
  raw.prepare(`INSERT INTO community_request_revisions (id,request_id,revision,estimate,reason) VALUES ('crv_r2_1','r2',1,'{"price_iqd":1}','publish')`).run();
  const contact = (phone: string) => JSON.stringify({ customer: { name: 'Sara', phone: '0770' }, merchant: { name: 'x', phone }, delivery_method: 'merchant_delivery' });
  raw.prepare(
    `INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd,request_snapshot,contact_snapshot)
     VALUES ('co1','r1','o1','buyer','m1','s1','funded',40000,2000,38000,?,?), ('co2','r2','o2','buyer','m2','s2','funded',40000,2000,38000,'{}',?)`
  ).run(JSON.stringify({ revision: 1, spec: { title: 'Stand' }, estimate: JSON.parse(RAW_ESTIMATE) }), contact('+9647511111111'), contact('+9647533333333'));
  return raw;
}

test('0134 strips the cost breakdown from stored revisions and order snapshots — and keeps the rest', () => {
  const raw = seed();
  raw.exec(M0134);
  const rev = JSON.parse(row<{ estimate: string }>(raw, "SELECT estimate FROM community_request_revisions WHERE id = 'crv_r1_1'")!.estimate);
  assert.deepEqual(Object.keys(rev).sort(), ['currency', 'max_iqd', 'min_iqd', 'price_iqd']);
  const snap = JSON.parse(row<{ request_snapshot: string }>(raw, "SELECT request_snapshot FROM community_orders WHERE id = 'co1'")!.request_snapshot);
  assert.deepEqual(Object.keys(snap.estimate).sort(), ['currency', 'max_iqd', 'min_iqd', 'price_iqd']);
  assert.equal(snap.spec.title, 'Stand');
  assert.equal(row<{ estimate: string }>(raw, "SELECT estimate FROM community_request_revisions WHERE id = 'crv_r2_1'")!.estimate, '{"price_iqd":1}');
  // Idempotent: a re-run changes nothing (the seal's CREATEs are IF NOT EXISTS).
  raw.exec(M0134);
  assert.deepEqual(JSON.parse(row<{ estimate: string }>(raw, "SELECT estimate FROM community_request_revisions WHERE id = 'crv_r1_1'")!.estimate), rev);
});

test('0134 clears a merchant contact that is the account’s private phone, keeps a published store phone', () => {
  const raw = seed();
  raw.exec(M0134);
  const c1 = JSON.parse(row<{ contact_snapshot: string }>(raw, "SELECT contact_snapshot FROM community_orders WHERE id = 'co1'")!.contact_snapshot);
  assert.equal(c1.merchant.phone, '', 'm1 published no phone: its private one is gone');
  assert.equal(c1.customer.phone, '0770');
  const c2 = JSON.parse(row<{ contact_snapshot: string }>(raw, "SELECT contact_snapshot FROM community_orders WHERE id = 'co2'")!.contact_snapshot);
  assert.equal(c2.merchant.phone, '+9647533333333', 'm2 published this number on its store');
});

test('0134 seals the old payout ledger: no insert, no update — only orderDeletion’s unlink', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','b@x.co','h','customer'), ('ali','Ali','a@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','ali','Ali 3D');
  `);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_mpl_mirror_%'"), 0);
  assert.throws(
    () => raw.exec(`INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state) VALUES ('x','m1','sale_credit',100,'pending')`),
    /MERCHANT_PAYOUT_LEDGER_READ_ONLY/
  );
  // A row as history holds it (written before 0134: the seal lifted for the seed only).
  raw.exec('DROP TRIGGER trg_mpl_no_insert');
  raw.exec(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
              subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('ORD-1','buyer','cancelled','{}','x','{}','wallet',100,1400,100,0);
            INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id) VALUES ('h1','m1','sale_credit',100,'reversed','ORD-1');`);
  raw.exec(M0134.slice(M0134.indexOf('CREATE TRIGGER IF NOT EXISTS trg_mpl_no_insert')));
  assert.throws(() => raw.exec("UPDATE merchant_payout_ledger SET state = 'available' WHERE id = 'h1'"), /MERCHANT_PAYOUT_LEDGER_READ_ONLY/);
  assert.throws(() => raw.exec("UPDATE merchant_payout_ledger SET amount_iqd = 1, order_id = NULL WHERE id = 'h1'"), /MERCHANT_PAYOUT_LEDGER_READ_ONLY/);
  // Deleting the order unlinks its id — the one write still allowed — and moves nothing.
  const res = await deleteCancelledOrder(asD1(raw), 'ORD-1');
  assert.equal(res.deleted, true);
  const h1 = row<{ order_id: string | null; amount_iqd: number; state: string }>(raw, "SELECT order_id, amount_iqd, state FROM merchant_payout_ledger WHERE id = 'h1'")!;
  assert.deepEqual({ ...h1 }, { order_id: null, amount_iqd: 100, state: 'reversed' });
});
