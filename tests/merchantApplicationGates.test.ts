/**
 * THE NEW-MERCHANT GATE AND THE TWO SECURITY HOLES (Community V3 push 1.1,
 * DECISIONS row 256; gap §3.4 rows E1/E2, §3.6 «old product link»).
 *
 *   E1  POST /api/merchant/onboard opens a store only for an APPROVED
 *       applicant (403 MERCHANT_APPLICATION_REQUIRED otherwise), and UPSERTS
 *       the merchant row the approval wrote. Selling still needs PLUS (C3).
 *       A merchant row that predates the gate keeps working until push 1.4.
 *   E2  POST /api/community/my-store no longer creates a store-less merchant;
 *       its update branch is untouched.
 *   GET /api/products/:slug serves a community product only under the feed's
 *       rule: a merchant and a store that are not suspended.
 *   BNPL reads only an IDENTITY case as a verified identity.
 *   KYC: nobody decides their own case or address request.
 *
 * Run: node --import tsx --test tests/merchantApplicationGates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, post, put, get, json, row, count, proOnSale, OWNER, type StubUser } from './fixtures/app';
import { merchantRoutes } from '../worker/routes/merchant';
import { communityRoutes } from '../worker/routes/community';
import { productRoutes } from '../worker/routes/products';
import { membershipsRoutes } from '../worker/routes/memberships';
import { kycRoutes } from '../worker/routes/kyc';
import { bnplEligibility } from '../worker/lib/bnpl';
import { applyTransition } from '../worker/lib/merchantApproval';

const FUTURE = '2099-01-01T00:00:00.000Z';
const ALI: StubUser = { id: 'ali', role: 'customer', email: 'ali@example.test' };

function seed(raw: DatabaseSync = freshDb(), plus = true) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('ali','Ali','ali@example.test','h','customer'),
      ('rev','Reviewer','rev@example.test','h','admin'),
      ('buyer','Buyer','buyer@example.test','h','customer');
    INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
  if (plus) {
    raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
              VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}')`);
  }
  return raw;
}

const merchantApp = (raw: DatabaseSync, user: StubUser = ALI) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/community', communityRoutes);
  });

const ONBOARD = { name: 'Orbit Prints', slug: 'orbit-prints', governorate: 'baghdad' };

/** Ali through the real approval machine: a submitted application a reviewer approves. */
async function approveAli(raw: DatabaseSync) {
  const db = asD1(raw);
  raw.exec(`INSERT INTO merchant_applications (id, user_id, state, revision, public_name, public_bio, governorate)
            VALUES ('mapp_ali', 'ali', 'submitted', 1, 'Orbit Prints', 'Prints to order.', 'baghdad')`);
  const at = () => row<{ id: string; user_id: string; state: string; revision: number }>(raw, "SELECT * FROM merchant_applications WHERE id = 'mapp_ali'")!;
  assert.equal((await applyTransition(db, { application: at(), action: 'start_review', actor: { id: 'rev', kind: 'reviewer' }, operationId: 'op-gate-start' })).ok, true);
  assert.equal((await applyTransition(db, { application: at(), action: 'approve', actor: { id: 'rev', kind: 'reviewer' }, operationId: 'op-gate-approve' })).ok, true);
}

// ------------------------------------------------------------------------ E1

test('E1: a new merchant without approval cannot open a store — PLUS or not', async () => {
  for (const plus of [true, false]) {
    const raw = seed(freshDb(), plus);
    const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
    assert.equal(res.status, 403);
    assert.equal((await json(res)).code, 'MERCHANT_APPLICATION_REQUIRED', 'subscribing is not approval');
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'), 0);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_stores'), 0);
  }
});

test('E1: an approved applicant opens a store, and /onboard UPSERTS the row the approval wrote', async () => {
  const raw = seed();
  await approveAli(raw);
  const approved = row<{ id: string; approved_at: string }>(raw, "SELECT id, approved_at FROM community_merchants WHERE user_id = 'ali'")!;
  assert.ok(approved.approved_at);

  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_merchants WHERE user_id = 'ali'"), 1, 'one merchant row, not two');
  const after = row<{ id: string; approved_at: string; approved_application_id: string; status: string }>(raw, "SELECT * FROM community_merchants WHERE user_id = 'ali'")!;
  assert.equal(after.id, approved.id, 'the store hangs off the approved row');
  assert.equal(after.approved_at, approved.approved_at, 'onboarding never touches the stamp');
  assert.equal(after.approved_application_id, 'mapp_ali');
  assert.equal(row<{ merchant_id: string }>(raw, "SELECT merchant_id FROM merchant_stores WHERE user_id = 'ali'")!.merchant_id, approved.id);
});

test('C3: approval does not replace PLUS — an approved applicant without PLUS still cannot sell', async () => {
  const raw = seed(freshDb(), false);
  await approveAli(raw);
  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 403);
  assert.notEqual((await json(res)).code, 'MERCHANT_APPLICATION_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_stores'), 0);
});

test('E1 is for NEW merchants: a merchant row from before the gate keeps working until push 1.4', async () => {
  const raw = seed();
  raw.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile')");
  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
});

test('E1 on a database without 0204: a new merchant is refused (fails closed), an existing row still onboards', async () => {
  const fresh = seed(dbThrough('0203'));
  const refused = await post(merchantApp(fresh), '/api/merchant/onboard', ONBOARD);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'MERCHANT_APPLICATION_REQUIRED');

  const legacy = seed(dbThrough('0203'));
  legacy.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile')");
  assert.equal((await post(merchantApp(legacy), '/api/merchant/onboard', ONBOARD)).status, 201);
});

// ------------------------------------------------------------------------ E2

test('E2: /my-store creates no merchant any more; an existing merchant keeps editing', async () => {
  const raw = seed();
  const refused = await post(merchantApp(raw), '/api/community/my-store', { name: 'Orbit Prints', bio: '' });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'MERCHANT_APPLICATION_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'), 0);

  await approveAli(raw);
  const kept = await post(merchantApp(raw), '/api/community/my-store', { name: 'Orbit Prints 2', bio: 'New bio' });
  assert.equal(kept.status, 200);
  assert.equal(row<{ name: string }>(raw, "SELECT name FROM community_merchants WHERE user_id = 'ali'")!.name, 'Orbit Prints 2');
});

// ------------------------------------------------------- the old product link

test('GET /api/products/:slug hides a community product of a suspended merchant or a suspended store', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_merchants (id, user_id, name) VALUES ('cm1', 'ali', 'Orbit Prints');
    INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('st1', 'cm1', 'ali', 'orbit', 'Orbit Prints');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, price_iqd) VALUES ('cp1', 'cm1', 'st1', 'orbit-vase', 'Vase', 9000);
  `);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  const read = async () => (await app.request('/api/products/orbit-vase')).status;
  assert.equal(await read(), 200, 'a live listing is served');

  raw.exec("UPDATE community_merchants SET status = 'suspended' WHERE id = 'cm1'");
  assert.equal(await read(), 404, 'a suspended merchant\'s old product link no longer serves it');
  raw.exec("UPDATE community_merchants SET status = 'active' WHERE id = 'cm1'");

  raw.exec("UPDATE merchant_stores SET status = 'suspended' WHERE id = 'st1'");
  assert.equal(await read(), 404, 'nor a suspended store\'s');
  raw.exec("UPDATE merchant_stores SET status = 'paused' WHERE id = 'st1'");
  assert.equal(await read(), 200, 'a merchant-paused store stays readable (C10)');
  raw.exec("UPDATE merchant_stores SET status = 'active' WHERE id = 'st1'");

  raw.exec("UPDATE community_products SET lifecycle = 'archived' WHERE id = 'cp1'");
  assert.equal(await read(), 404, 'an archived listing is not served either');
  // The refusal is the plain one an unknown slug gets: it says nothing about why.
  const body = await json(await app.request('/api/products/orbit-vase'));
  const unknown = await json(await app.request('/api/products/no-such-slug-at-all'));
  assert.deepEqual(body, unknown);
});

// ---------------------------------------------------------------------- BNPL

test('BNPL reads only an IDENTITY case: a verified phone change is not a verified identity', async () => {
  const raw = proOnSale(freshDb());
  raw.exec(`
    INSERT INTO users (id,email,password_hash,role) VALUES ('pro','pro@example.test','h','customer');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('m_pro','pro','pro_12mo','pro','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,label,name,phone,address,is_default)
      VALUES ('addr_pro','pro','Home','Customer','+9647700000001','Baghdad',1);
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,state,source_address_id,approved_by,approved_at)
      VALUES ('ap_pro','pro',1,'Customer','+9647700000001','Baghdad','approved','addr_pro','admin','2026-01-01T00:00:00.000Z');
    INSERT INTO bnpl_accounts (user_id,state,credit_limit_iqd,approved_by) VALUES ('pro','approved',100000,'admin');
    INSERT INTO kyc_cases (id,user_id,state,case_type,decided_at) VALUES ('kyc_phone','pro','verified','phone_change','2026-01-01T00:00:00.000Z');
  `);
  const db = asD1(raw);
  assert.equal((await bnplEligibility(db, 'pro', undefined, 40_000)).reason, 'IDENTITY_VERIFICATION_REQUIRED');

  const member = stubApp(db, { id: 'pro', role: 'customer', email: 'pro@example.test' }, (a) => a.route('/api/memberships', membershipsRoutes));
  const request = await post(member, '/api/memberships/bnpl/request', {});
  assert.equal(request.status, 400);
  assert.equal((await json(request)).code, 'IDENTITY_VERIFICATION_REQUIRED');

  const admin = stubApp(db, OWNER, (a) => a.route('/api/memberships', membershipsRoutes));
  raw.exec("INSERT INTO users (id,email,password_hash,role) VALUES ('usr_owner','boss@x.co','h','admin')");
  const limit = await put(admin, '/api/memberships/admin/bnpl/pro', { state: 'approved', credit_limit_iqd: 50000 });
  assert.equal(limit.status, 400);
  assert.equal((await json(limit)).code, 'IDENTITY_VERIFICATION_REQUIRED');

  // The identity case itself still counts.
  raw.exec("INSERT INTO kyc_cases (id,user_id,state,decided_at) VALUES ('kyc_id','pro','verified','2026-01-02T00:00:00.000Z')");
  assert.equal((await bnplEligibility(db, 'pro', undefined, 40_000)).eligible, true);
  assert.equal((await put(admin, '/api/memberships/admin/bnpl/pro', { state: 'approved', credit_limit_iqd: 50000 })).status, 200);
});

// ----------------------------------------------------------------------- KYC

test('KYC: an admin never decides their own identity case or address request', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,email,password_hash,role) VALUES
      ('adm1','adm1@example.test','h','admin'), ('adm2','adm2@example.test','h','admin');
    INSERT INTO kyc_cases (id,user_id,state) VALUES ('kc_self','adm1','submitted');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,state)
      VALUES ('aa_self','adm1',1,'Admin','+9647700000002','Baghdad','pending');
  `);
  const db = asD1(raw);
  const as = (id: string) => stubApp(db, { id, role: 'admin', email: `${id}@example.test` }, (a) => a.route('/api/kyc', kycRoutes), { env: { KYC_ENC_KEY: '' } });

  const self = await post(as('adm1'), '/api/kyc/admin/cases/kc_self/decision', { decision: 'verified' });
  assert.equal(self.status, 403);
  assert.equal((await json(self)).code, 'SELF_DECISION_FORBIDDEN');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM kyc_cases WHERE id='kc_self'")!.state, 'submitted');

  const selfAddress = await post(as('adm1'), '/api/kyc/admin/address/aa_self/decision', { approve: true });
  assert.equal(selfAddress.status, 403);
  assert.equal((await json(selfAddress)).code, 'SELF_DECISION_FORBIDDEN');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM approved_addresses WHERE id='aa_self'")!.state, 'pending');

  const other = await post(as('adm2'), '/api/kyc/admin/cases/kc_self/decision', { decision: 'reviewing' });
  assert.equal(other.status, 200, 'another admin decides');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM kyc_cases WHERE id='kc_self'")!.state, 'reviewing');
  assert.equal((await post(as('adm2'), '/api/kyc/admin/address/aa_self/decision', { approve: true })).status, 200);
});

test('GET /api/merchant/me still answers for an applicant with no store', async () => {
  const raw = seed();
  const res = await get(merchantApp(raw), '/api/merchant/me');
  assert.equal(res.status, 200);
});
