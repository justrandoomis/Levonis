/**
 * THE NEW-MERCHANT GATE AND THE TWO SECURITY HOLES (Community V3 push 1.1,
 * DECISIONS row 256; gap §3.4 rows E1/E2, §3.6 «old product link»).
 *
 *   E1  POST /api/merchant/onboard opens a store only for an APPROVED
 *       applicant (403 MERCHANT_APPLICATION_REQUIRED otherwise), and creates
 *       the merchant row WITH the store, stamped from the approved
 *       application — approval itself publishes no card in «المتاجر». Selling
 *       still needs PLUS (C3). A store-less profile row from the old door is
 *       no approval (C2); an existing STORE stays its merchant's to run, and
 *       since push 1.4 (DECISIONS row 259) sells nothing until approved.
 *   E2  POST /api/community/my-store no longer creates a store-less merchant;
 *       its update branch is untouched.
 *   GET /api/products/:slug serves a community product only under the feed's
 *       rule: a merchant and a store that are not suspended (and, since push
 *       1.4, an approved merchant).
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

test('E1: an approved applicant opens a store, and the merchant row is born WITH it, stamped from the application', async () => {
  const raw = seed();
  await approveAli(raw);
  // Approval writes no public row: nothing to show in «المتاجر» before there is a store.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_merchants WHERE user_id = 'ali'"), 0);
  const decidedAt = row<{ decided_at: string }>(raw, "SELECT decided_at FROM merchant_applications WHERE id = 'mapp_ali'")!.decided_at;

  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_merchants WHERE user_id = 'ali'"), 1, 'one merchant row');
  const after = row<{ id: string; approved_at: string; approved_application_id: string; status: string; name: string }>(raw, "SELECT * FROM community_merchants WHERE user_id = 'ali'")!;
  assert.equal(after.approved_at, decidedAt, 'stamped with the approval, never by the client');
  assert.equal(after.approved_application_id, 'mapp_ali');
  assert.equal(after.status, 'active');
  assert.equal(row<{ merchant_id: string }>(raw, "SELECT merchant_id FROM merchant_stores WHERE user_id = 'ali'")!.merchant_id, after.id);
});

test('a guest sees no card for an approved applicant until the store exists — and then exactly one', async () => {
  const raw = seed();
  const guest = stubApp(asD1(raw), null, (a) => a.route('/api/community', communityRoutes));
  const names = async () => ((await json(await get(guest, '/api/community/merchants'))).merchants as Array<{ name: string; store_slug: string | null }>);
  await approveAli(raw);
  assert.deepEqual(await names(), [], 'approved, no store: no store-less card in «المتاجر»');
  assert.equal((await json(await get(guest, '/api/community/merchants'))).total, 0);
  assert.equal((await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD)).status, 201);
  const listed = await names();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.store_slug, 'orbit-prints');
});

test('approving a merchant from before the gate stamps THEIR row; «المتاجر» lists them once they have a store (push 1.4)', async () => {
  const raw = seed();
  raw.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile')");
  const guest = stubApp(asD1(raw), null, (a) => a.route('/api/community', communityRoutes));
  const listed = async () => ((await json(await get(guest, '/api/community/merchants'))).merchants as Array<{ name: string }>).map((m) => m.name);
  // Push 1.4 (DECISIONS row 259): the directory lists approved merchants' STORES — a
  // profile from the old door is no card, before approval or after it, until a store exists.
  assert.deepEqual(await listed(), [], 'unapproved and store-less: not listed');
  await approveAli(raw);
  const stamped = row<{ id: string; approved_at: string | null; approved_application_id: string | null; name: string }>(raw, "SELECT * FROM community_merchants WHERE user_id = 'ali'")!;
  assert.equal(stamped.id, 'cm_old', 'no second row');
  assert.ok(stamped.approved_at);
  assert.equal(stamped.approved_application_id, 'mapp_ali');
  assert.deepEqual(await listed(), [], 'approved, still no store: no card yet');
  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  assert.deepEqual(await listed(), ['Orbit Prints'], 'the approved merchant\'s store is listed (onboarding names the row)');
  const after = row<{ id: string; approved_at: string }>(raw, "SELECT id, approved_at FROM community_merchants WHERE user_id = 'ali'")!;
  assert.equal(after.id, 'cm_old', 'the store hangs off the existing row');
  assert.equal(after.approved_at, stamped.approved_at, 'onboarding never moves a stamp');
});

test('C3: approval does not replace PLUS — an approved applicant without PLUS still cannot sell', async () => {
  const raw = seed(freshDb(), false);
  await approveAli(raw);
  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 403);
  assert.notEqual((await json(res)).code, 'MERCHANT_APPLICATION_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_stores'), 0);
});

test('C2: a store-less profile row from the old /my-store door opens no store without review', async () => {
  const raw = seed();
  raw.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile')");
  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'MERCHANT_APPLICATION_REQUIRED', 'a profile is not a store: it applies like everyone else');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_stores'), 0);
});

test('an existing unapproved STORE stays its merchant\'s to run (finishing work, push 1.4): onboarding again is STORE_EXISTS, never the application refusal', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile');
            INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('str_old', 'cm_old', 'ali', 'old-shop', 'Old Shop');`);
  const res = await post(merchantApp(raw), '/api/merchant/onboard', ONBOARD);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'STORE_EXISTS');
  const me = await json(await get(merchantApp(raw), '/api/merchant/me'));
  assert.equal(me.store?.slug, 'old-shop', 'the store is still theirs to run');
  assert.equal(me.approved, false);
});

test('E1 on a database without 0204: a new merchant and a store-less row are refused (fails closed), an existing store is STORE_EXISTS', async () => {
  const fresh = seed(dbThrough('0203'));
  const refused = await post(merchantApp(fresh), '/api/merchant/onboard', ONBOARD);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'MERCHANT_APPLICATION_REQUIRED');

  const legacy = seed(dbThrough('0203'));
  legacy.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile')");
  const profileOnly = await post(merchantApp(legacy), '/api/merchant/onboard', ONBOARD);
  assert.equal(profileOnly.status, 403);
  assert.equal((await json(profileOnly)).code, 'MERCHANT_APPLICATION_REQUIRED');

  legacy.exec("INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name) VALUES ('str_old', 'cm_old', 'ali', 'old-shop', 'Old Shop')");
  const store = await post(merchantApp(legacy), '/api/merchant/onboard', ONBOARD);
  assert.equal(store.status, 409);
  assert.equal((await json(store)).code, 'STORE_EXISTS');
});

// ------------------------------------------------------------------------ E2

test('E2: /my-store creates no merchant any more — not even for an approved applicant; an existing merchant keeps editing', async () => {
  const raw = seed();
  const refused = await post(merchantApp(raw), '/api/community/my-store', { name: 'Orbit Prints', bio: '' });
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'MERCHANT_APPLICATION_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'), 0);

  // Approval does not reopen this door: the row is born with the store, at /onboard.
  await approveAli(raw);
  assert.equal((await post(merchantApp(raw), '/api/community/my-store', { name: 'Orbit Prints', bio: '' })).status, 403);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'), 0);

  raw.exec("INSERT INTO community_merchants (id, user_id, name) VALUES ('cm_old', 'ali', 'Old Profile')");
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
  // Push 1.4 (DECISIONS row 259): the merchant must also be APPROVED.
  assert.equal(await read(), 404, 'an unapproved merchant\'s listing is not served');
  raw.exec("UPDATE community_merchants SET approved_at = '2026-10-18T00:00:00.000Z' WHERE id = 'cm1'");
  assert.equal(await read(), 200, 'a live listing of an approved merchant is served');

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
