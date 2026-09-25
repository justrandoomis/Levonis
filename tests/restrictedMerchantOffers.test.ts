/**
 * A RESTRICTED MERCHANT MAKES NO NEW PROMISES — audit 03 V, audit 04 #23
 * (handed over from W1-B: worker/lib/merchantAuth.ts).
 *
 * `restricted` is Levonis's sanction short of a suspension: the store stays
 * visible and accepted work goes on, but no new orders (storeTakesOrders) and
 * no new offers. The matcher already stopped notifying a restricted merchant,
 * but `requireSellingPrivileges` refused only `suspended`, so they could bid
 * on any request they found, re-confirm a stale offer, or re-price one. And a
 * standing offer from a merchant sanctioned after bidding could still be
 * accepted — a new contract with someone Levonis had just stopped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, json, row, count, pending, type Mount } from './fixtures/app';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';

const mount: Mount = (a) => {
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

const RATE = 1400;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('owner','Ali','a@x.co','h','customer'),
      ('owner2','Omar','o@x.co','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('mem2','owner2','plus_12mo','plus','active',12,29000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    -- Since W5-B an offer needs a workshop that can make the job.
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm) VALUES
      ('p1','m1','s1','P1S','fdm',256,256,250), ('p2','m2','s2','P1S','fdm',256,256,250);
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at) VALUES
      ('r1','buyer','Print a bracket','I need a bracket printed','receiving_offers','open','public',2,'2099-01-01T00:00:00.000Z'),
      ('r2','buyer','Print a vase','A tall vase','open','open','public',0,'2099-01-01T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('o1','r1','m1','s1',50000,'pending'), ('o2','r1','m2','s2',60000,'pending');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const as = (raw: DatabaseSync, id: string) => stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount);

const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);

test('a restricted merchant cannot make an offer — 403 MERCHANT_RESTRICTED, and nothing is written', async () => {
  const raw = seed();
  raw.exec("UPDATE community_merchants SET status = 'restricted' WHERE id = 'm1'");
  const res = await post(as(raw, 'owner'), '/api/marketplace/requests/r2/offers', { price_iqd: 1000 });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'MERCHANT_RESTRICTED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r2'"), 0);
  assert.deepEqual(row(raw, "SELECT state, offer_count FROM community_requests WHERE id = 'r2'"), { state: 'open', offer_count: 0 });

  // An allow-list: a status nobody taught the gate stops bids too.
  raw.exec("UPDATE community_merchants SET status = 'probation' WHERE id = 'm1'");
  const odd = await post(as(raw, 'owner'), '/api/marketplace/requests/r2/offers', { price_iqd: 1000 });
  assert.equal((await json(odd)).code, 'MERCHANT_RESTRICTED');

  // Restored: the same bid goes through.
  raw.exec("UPDATE community_merchants SET status = 'active' WHERE id = 'm1'");
  const ok = await post(as(raw, 'owner'), '/api/marketplace/requests/r2/offers', { price_iqd: 1000 });
  assert.equal(ok.status, 201, JSON.stringify(await ok.clone().json()));
  await Promise.allSettled(pending.splice(0));
});

test('each sanction refuses a bid with its OWN stable code', async () => {
  const cases: Array<[string, string, string]> = [
    ['merchant suspended', "UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'", 'MERCHANT_SUSPENDED'],
    ['store suspended', "UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'", 'STORE_SUSPENDED'],
    ['store paused', "UPDATE merchant_stores SET status = 'paused' WHERE id = 's1'", 'STORE_PAUSED'],
    ['PLUS lapsed', "UPDATE memberships SET expires_at = '2026-02-01T00:00:00.000Z' WHERE id = 'mem1'", 'SUBSCRIPTION_INACTIVE'],
  ];
  for (const [label, sql, code] of cases) {
    const raw = seed();
    raw.exec(sql);
    const res = await post(as(raw, 'owner'), '/api/marketplace/requests/r2/offers', { price_iqd: 1000 });
    assert.equal(res.status, 403, label);
    assert.equal((await json(res)).code, code, label);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE request_id = 'r2'"), 0, label);
  }
});

test('a restricted merchant cannot re-confirm or re-price a stale offer — but can still take it back', async () => {
  const raw = seed();
  // The customer changed the job after both offers priced it: both are stale.
  raw.exec("UPDATE community_requests SET revision = 2 WHERE id = 'r1'");
  raw.exec("UPDATE community_merchants SET status = 'restricted' WHERE id = 'm1'");
  const owner = as(raw, 'owner');

  const reconfirm = await post(owner, '/api/marketplace/offers/o1/reconfirm');
  assert.equal(reconfirm.status, 403);
  assert.equal((await json(reconfirm)).code, 'MERCHANT_RESTRICTED');
  const edit = await patch(owner, '/api/marketplace/offers/o1', { price_iqd: 40000 });
  assert.equal(edit.status, 403);
  assert.equal((await json(edit)).code, 'MERCHANT_RESTRICTED');
  assert.deepEqual(
    row(raw, "SELECT price_iqd, revision, request_revision FROM community_offers WHERE id = 'o1'"),
    { price_iqd: 50000, revision: 1, request_revision: 1 },
    'the stale offer stays stale — nobody can accept it'
  );

  // Withdrawing is never refused to a restricted merchant.
  const withdraw = await post(owner, '/api/marketplace/offers/o1/withdraw');
  assert.equal(withdraw.status, 200);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o1'")!.state, 'withdrawn');

  // A merchant in good standing re-confirms exactly as before.
  const other = await post(as(raw, 'owner2'), '/api/marketplace/offers/o2/reconfirm');
  assert.equal(other.status, 200, JSON.stringify(await other.clone().json()));
});

test('a standing offer from a merchant Levonis has since restricted or suspended cannot be accepted — MERCHANT_UNAVAILABLE, no money moves', async () => {
  const raw = seed();
  fund(raw, 'buyer', 200_000);
  const buyer = as(raw, 'buyer');

  raw.exec("UPDATE community_merchants SET status = 'restricted' WHERE id = 'm1'");
  const refused = await post(buyer, '/api/marketplace/offers/o1/accept', { expected_price_iqd: 50_000, offer_revision: 1 });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'MERCHANT_UNAVAILABLE');

  // …nor one whose STORE Levonis suspended.
  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 's2'");
  const storeRefused = await post(buyer, '/api/marketplace/offers/o2/accept', { expected_price_iqd: 60_000, offer_revision: 1 });
  assert.equal(storeRefused.status, 409);
  assert.equal((await json(storeRefused)).code, 'MERCHANT_UNAVAILABLE');

  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_holds WHERE user_id = 'buyer'"), 0, 'nothing was reserved');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_requests WHERE id = 'r1'")!.state, 'receiving_offers');

  // The sanction lifted, the customer's choice goes through.
  raw.exec("UPDATE merchant_stores SET status = 'active' WHERE id = 's2'");
  const ok = await post(buyer, '/api/marketplace/offers/o2/accept', { expected_price_iqd: 60_000, offer_revision: 1 });
  assert.ok(ok.status === 200 || ok.status === 201, JSON.stringify(await ok.clone().json()));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 1);
  await Promise.allSettled(pending.splice(0));
});
