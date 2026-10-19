/**
 * ADMIN SCOPE FOR KYC AND DISPUTES (P1-02, DECISIONS row 261; spec acceptance
 * 07 and 48).
 *
 * Proves, on the real routes and a fully migrated database:
 *   - the scope matrix (C5 pattern): the owner and a full admin open every
 *     /api/kyc/admin/* route and every complaint route; an assistant opens the
 *     KYC desk only with KYC_REVIEW and the disputes desk only with DISPUTES —
 *     each grant opens its own desk and nothing else, MERCHANT_REVIEW opens
 *     neither — and a revoke counts on the next request;
 *   - a refused assistant hears 403 KYC_REVIEW_FORBIDDEN / DISPUTES_FORBIDDEN
 *     before any row is read: the same body for a real and an invented id, no
 *     name, address, document number or file key, no audit "view", no write;
 *   - a PREMIUM member and a merchant never reach either desk nor approve a
 *     merchant (403); a guest is asked to sign in (401) — acceptance 07;
 *   - the complaint files, the complaint upload door, the support badge and
 *     the community overview's complaints counter follow the disputes desk;
 *     DISPUTES opens no money (settling an escrow stays FINANCIAL_SCOPE);
 *   - the side doors to identity data follow the KYC desk: the support member
 *     console (list, `?kyc=` filter, detail) and the member window
 *     (/api/admin/users/:id/detail) carry no KYC state, case, reason or
 *     address request outside it — only the current approved address;
 *   - the owner issues and revokes KYC_REVIEW / DISPUTES through the existing
 *     grant routes (`grant_key`), an unknown key is refused, the list carries
 *     every key; the session hints follow the same rule;
 *   - a checkout address change leaves the merchant application, the
 *     membership and the KYC rows untouched — acceptance 48;
 *   - every new word is written in Arabic, English and real Sorani.
 *
 * Fixtures are anonymised: invented names and numbers, a key minted per run.
 *
 * Run: node --import tsx --test tests/adminScopeKycDisputes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, get, post, put, json, all, count, ctx, memoryBucket, type MemoryBucket, type StubUser } from './fixtures/app';
import { kycRoutes } from '../worker/routes/kyc';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { adminMerchantApplicationRoutes } from '../worker/routes/adminMerchantApplications';
import { adminChatRoutes } from '../worker/routes/adminChats';
import { addressRoutes } from '../worker/routes/addresses';
import { fileRoutes, uploadRoutes } from '../worker/routes/uploads';
import { supportRoutes } from '../worker/routes/support';
import { adminRoutes } from '../worker/routes/admin';
import { assertUploadEntity } from '../worker/lib/uploadEntity';
import { HttpError } from '../worker/lib/http';
import { CAPABILITY_GRANTS, canReviewMerchants, isCapabilityGrant } from '../worker/lib/merchantApproval';
import { canHandleDisputes, canReviewKyc } from '../worker/lib/staffCapabilities';
import { canMoveMoney, canViewCost } from '../worker/lib/adminScope';
import { publicUser, type Env, type SessionUser } from '../worker/lib/types';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { GRANT_STRINGS } from '../src/components/adminScope/grantStrings';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const OWNER: StubUser = { id: 'u_owner', role: 'admin', email: 'boss@x.co' };
const FULL: StubUser = { id: 'u_full', role: 'admin', email: 'full@example.test', admin_scope: 'full' };
const LEGACY: StubUser = { id: 'u_legacy', role: 'admin', email: 'legacy@example.test', admin_scope: null };
const ASSIST: StubUser = { id: 'u_assist', role: 'admin', email: 'assist@example.test', admin_scope: 'assistant' };
const KYC: StubUser = { id: 'u_kyc', role: 'admin', email: 'kyc@example.test', admin_scope: 'assistant' };
const DISP: StubUser = { id: 'u_disp', role: 'admin', email: 'disp@example.test', admin_scope: 'assistant' };
const MREV: StubUser = { id: 'u_mrev', role: 'admin', email: 'mrev@example.test', admin_scope: 'assistant' };
const PREMIUM: StubUser = { id: 'u_prime', role: 'customer', email: 'prime@example.test' };
const MERCHANT: StubUser = { id: 'u_merch', role: 'merchant', email: 'merch@example.test' };
const CUSTOMER: StubUser = { id: 'u_cust', role: 'customer', email: 'cust@example.test' };

// Distinctive values: any appearance in a refusal is a leak.
const SUBJECT_EMAIL = 'cust@example.test';
const SUBJECT_ADDRESS = 'Karrada street 7, house 12';
const EVIDENCE_KEY = 'kyc/u_cust/ev_qorvan01.jpg';
const COMPLAINT_TEXT = 'QORVAN-COMPLAINT-TEXT';
const COMPLAINT_FILE = 'complaints/ct_1/attachments/att_qorvan01.jpg';
const LEAKS = [SUBJECT_EMAIL, SUBJECT_ADDRESS, EVIDENCE_KEY, 'ev_qorvan01', COMPLAINT_TEXT, 'att_qorvan01', '+9647700000009'];

function world(opts: { through?: string } = {}) {
  const raw: DatabaseSync = opts.through ? dbThrough(opts.through) : freshDb();
  raw.exec(`
    INSERT INTO users (id,email,password_hash,role,admin_scope,username,name,membership_tier) VALUES
      ('u_owner','boss@x.co','h','admin',NULL,'owner','Owner','free'),
      ('u_full','full@example.test','h','admin','full','fulladmin','Full','free'),
      ('u_legacy','legacy@example.test','h','admin',NULL,'legacyadmin','Legacy','free'),
      ('u_assist','assist@example.test','h','admin','assistant','assist','Assist','free'),
      ('u_kyc','kyc@example.test','h','admin','assistant','kycdesk','Kyc Desk','free'),
      ('u_disp','disp@example.test','h','admin','assistant','dispdesk','Disp Desk','free'),
      ('u_mrev','mrev@example.test','h','admin','assistant','mrevdesk','Mrev Desk','free'),
      ('u_prime','prime@example.test','h','customer',NULL,'primemember','Prime Member','prime'),
      ('u_merch','merch@example.test','h','merchant',NULL,'merchant1','Merchant','free'),
      ('u_cust','${SUBJECT_EMAIL}','h','customer',NULL,'subject','Subject','pro');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('m_prime','u_prime','prime_12mo','prime','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_pro','u_cust','pro_12mo','pro','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('cm_1','u_merch','Merchant Prints');
    INSERT INTO kyc_cases (id,user_id,state,case_type,evidence_keys) VALUES
      ('kc_1','u_cust','submitted','identity','["${EVIDENCE_KEY}"]');
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,state) VALUES
      ('aa_1','u_cust',1,'Subject','+9647700000009','${SUBJECT_ADDRESS}','pending');
    INSERT INTO community_complaints (id,reporter_id,category,description,status) VALUES
      ('ct_1','u_cust','quality','${COMPLAINT_TEXT}','submitted');
    INSERT INTO admin_capability_grants (id,user_id,grant_key,granted_by,operation_id) VALUES
      ('acg_kyc','u_kyc','KYC_REVIEW','u_owner','op-seed-kyc-0001'),
      ('acg_disp','u_disp','DISPUTES','u_owner','op-seed-disp-0001'),
      ('acg_mrev','u_mrev','MERCHANT_REVIEW','u_owner','op-seed-mrev-0001');
  `);
  const bucket = memoryBucket();
  void bucket.put(EVIDENCE_KEY, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { httpMetadata: { contentType: 'image/jpeg' } });
  void bucket.put(COMPLAINT_FILE, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { httpMetadata: { contentType: 'image/jpeg' } });
  const env: Record<string, unknown> = { BUCKET: bucket, R2_PRIVATE: bucket, R2_PUBLIC: bucket, KYC_ENC_KEY: '' };
  const db = asD1(raw);
  const appAs = (user: StubUser | null, extra: { sessionAgeSeconds?: number } = {}) =>
    stubApp(
      db,
      user,
      (a) => {
        a.route('/api/kyc', kycRoutes);
        a.route('/api/admin/community', adminCommunityRoutes);
        a.route('/api/admin/merchant-applications', adminMerchantApplicationRoutes);
        a.route('/api/admin/chats', adminChatRoutes);
        a.route('/api/addresses', addressRoutes);
        a.route('/files', fileRoutes);
      },
      { env, ...extra }
    );
  return { raw, db, env, bucket, appAs };
}

/** Every KYC admin door, read and write. The writes carry a body a refused caller would want to land. */
const KYC_DOORS: Array<[method: 'GET' | 'POST', path: string, body?: unknown]> = [
  ['GET', '/api/kyc/admin/queue'],
  ['GET', '/api/kyc/admin/queue?case_type=phone_change'],
  ['GET', '/api/kyc/admin/cases/kc_1'],
  ['GET', '/api/kyc/admin/cases/kc_1/evidence/0'],
  ['POST', '/api/kyc/admin/cases/kc_1/decision', { decision: 'verified' }],
  ['GET', '/api/kyc/admin/address-queue'],
  ['POST', '/api/kyc/admin/address/aa_1/decision', { approve: true }],
];

/** Every complaint door of the disputes desk. */
const DISPUTE_DOORS: Array<[method: 'GET' | 'POST', path: string, body?: unknown]> = [
  ['GET', '/api/admin/community/complaints'],
  ['GET', '/api/admin/community/complaints/ct_1'],
  ['POST', '/api/admin/community/complaints/ct_1/status', { status: 'resolved', resolution: 'closed by a stranger' }],
  ['POST', '/api/admin/community/complaints/ct_1/messages', { body: 'a reply that must not land', internal: false }],
];

type World = ReturnType<typeof world>;
const call = (w: World, who: StubUser | null, [method, path, body]: [string, string, unknown?]) =>
  method === 'GET' ? get(w.appAs(who), path) : post(w.appAs(who), path, body ?? {});

const kycState = (raw: DatabaseSync) =>
  JSON.stringify(all(raw, 'SELECT id, state, decided_by FROM kyc_cases UNION ALL SELECT id, state, approved_by FROM approved_addresses ORDER BY 1'));
const complaintState = (raw: DatabaseSync) =>
  JSON.stringify([
    all(raw, 'SELECT id, status, resolution, assigned_admin_id FROM community_complaints ORDER BY id'),
    count(raw, 'SELECT COUNT(*) AS n FROM community_complaint_messages'),
  ]);

async function assertRefused(res: Response, code: string, label: string) {
  const text = await res.text();
  assert.equal(res.status, 403, `${label}: ${text}`);
  const body = JSON.parse(text) as { code?: string };
  assert.equal(body.code, code, label);
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${label}: the refusal carries «${leak}»`);
  return text;
}

// ------------------------------------------------------------ scope matrix

test('07 — KYC: owner, full and legacy admins open every door; an assistant only with KYC_REVIEW', async () => {
  const w = world();
  for (const who of [OWNER, FULL, LEGACY, KYC]) {
    const app = w.appAs(who);
    assert.equal((await get(app, '/api/kyc/admin/queue')).status, 200, `${who.id} queue`);
    assert.equal((await get(app, '/api/kyc/admin/address-queue')).status, 200, `${who.id} address queue`);
    const opened = await get(app, '/api/kyc/admin/cases/kc_1');
    assert.equal(opened.status, 200, `${who.id} case`);
    assert.equal((await json(opened)).case.user_email, SUBJECT_EMAIL);
    const evidence = await get(app, '/api/kyc/admin/cases/kc_1/evidence/0');
    assert.equal(evidence.status, 200, `${who.id} evidence`);
    assert.equal(evidence.headers.get('Cache-Control'), 'no-store');
    // The decision doors are reached (their own validation answers), and nothing moves.
    assert.equal((await post(app, '/api/kyc/admin/cases/kc_1/decision', { decision: 'nope' })).status, 400, `${who.id} decision`);
    assert.equal((await post(app, '/api/kyc/admin/address/aa_1/decision', {})).status, 400, `${who.id} address decision`);
  }
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'kyc.case.view' AND actor_id = 'u_kyc'"), 1, 'the granted assistant is audited like anyone');
});

test('07 — KYC: an assistant without the grant, or with another desk\'s grant, is refused at every door before any row is read', async () => {
  const w = world();
  const before = kycState(w.raw);
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log');
  for (const who of [ASSIST, DISP, MREV]) {
    for (const door of KYC_DOORS) await assertRefused(await call(w, who, door), 'KYC_REVIEW_FORBIDDEN', `${who.id} ${door[1]}`);
    // A real id and an invented one answer the same body: no existence oracle.
    const real = await (await get(w.appAs(who), '/api/kyc/admin/cases/kc_1')).text();
    const invented = await (await get(w.appAs(who), '/api/kyc/admin/cases/kc_nosuchcase')).text();
    assert.equal(real, invented, `${who.id}: real and invented ids answer alike`);
  }
  assert.equal(kycState(w.raw), before, 'no decision landed');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM audit_log'), audits, 'nothing was opened, so nothing was audited');
});

test('07 — disputes: owner, full admins and an assistant with DISPUTES open every complaint door', async () => {
  const w = world();
  for (const who of [OWNER, FULL, LEGACY, DISP]) {
    const app = w.appAs(who);
    const list = await get(app, '/api/admin/community/complaints');
    assert.equal(list.status, 200, `${who.id} list`);
    assert.equal((await json(list)).complaints.length, 1);
    assert.equal((await get(app, '/api/admin/community/complaints/ct_1')).status, 200, `${who.id} detail`);
    assert.equal((await post(app, '/api/admin/community/complaints/ct_1/status', { status: 'nope' })).status, 400, `${who.id} status`);
    assert.equal((await post(app, '/api/admin/community/complaints/ct_1/messages', {})).status, 400, `${who.id} reply`);
  }
  const replied = await post(w.appAs(DISP), '/api/admin/community/complaints/ct_1/messages', { body: 'نراجع الشكوى الآن.' });
  assert.equal(replied.status, 200, await replied.clone().text());
});

test('07 — disputes: an assistant without DISPUTES is refused at every complaint door, and nothing lands', async () => {
  const w = world();
  const before = complaintState(w.raw);
  for (const who of [ASSIST, KYC, MREV]) {
    for (const door of DISPUTE_DOORS) await assertRefused(await call(w, who, door), 'DISPUTES_FORBIDDEN', `${who.id} ${door[1]}`);
    const real = await (await get(w.appAs(who), '/api/admin/community/complaints/ct_1')).text();
    const invented = await (await get(w.appAs(who), '/api/admin/community/complaints/ct_nosuch')).text();
    assert.equal(real, invented, `${who.id}: real and invented ids answer alike`);
  }
  assert.equal(complaintState(w.raw), before);
});

test('07 — a PREMIUM member and a merchant never reach KYC, disputes or merchant approval; a guest signs in first', async () => {
  const w = world();
  const doors = [...KYC_DOORS, ...DISPUTE_DOORS, ['GET', '/api/admin/merchant-applications'] as [string, string]];
  for (const who of [PREMIUM, MERCHANT, CUSTOMER]) {
    for (const door of doors) {
      const res = await call(w, who, door as [string, string, unknown?]);
      const text = await res.text();
      assert.equal(res.status, 403, `${who.id} ${door[1]}`);
      for (const leak of LEAKS) assert.ok(!text.includes(leak), `${who.id} ${door[1]} carries «${leak}»`);
    }
  }
  for (const door of doors) assert.equal((await call(w, null, door as [string, string, unknown?])).status, 401, `guest ${door[1]}`);
  // A merchant decides no application either (acceptance 07's «cannot approve a merchant»).
  assert.equal((await post(w.appAs(MERCHANT), '/api/admin/merchant-applications/mapp_anything01/approve', { revision: 1, operation_id: 'op-merchant-approve-1' })).status, 403);
});

test('a revoke counts on the next request; the grant is read from the table, never from the session', async () => {
  const w = world();
  assert.equal((await get(w.appAs(KYC), '/api/kyc/admin/queue')).status, 200);
  const revoked = await post(w.appAs(OWNER), `/api/admin/merchant-applications/reviewers/${KYC.id}/revoke`, { grant_key: 'KYC_REVIEW' });
  assert.deepEqual(await json(revoked), { success: true, granted: false, already: false });
  await assertRefused(await get(w.appAs(KYC), '/api/kyc/admin/queue'), 'KYC_REVIEW_FORBIDDEN', 'after revoke');

  // A session that still lists the grant opens nothing: the routes ask the table.
  const env = { DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' };
  const stale = { ...KYC, capability_grants: ['KYC_REVIEW', 'DISPUTES'] } as unknown as SessionUser;
  assert.equal(await canReviewKyc(env, stale), false);
  assert.equal(await canHandleDisputes(env, stale), false);
});

// ------------------------------------------------- files, badge and money

/** A minimal WebP and an Images binding that hands it back, so an upload that passes its door lands. */
function webp(): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  b.set([0x7f, 0x02, 0x00], 24);
  b.set([0xdf, 0x01, 0x00], 27);
  return b;
}
const IMAGES = {
  async info() {
    return { format: 'image/webp', fileSize: 30, width: 640, height: 480 };
  },
  input() {
    return { async output() { return { response: () => new Response(webp()) }; } };
  },
};
const complaintKeys = (bucket: unknown) => [...(bucket as MemoryBucket).objects.keys()].filter((k) => k.startsWith('complaints/')).sort();

test('the complaint upload door follows the disputes desk: a refused admin hears the reporter\'s answer and nothing lands', async () => {
  const w = world();
  const env = { ...w.env, DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co', IMAGES };
  const uploadAs = (who: StubUser, entityId: string) => {
    const form = new FormData();
    form.set('purpose', 'complaint');
    form.set('entity_id', entityId);
    form.set('file', new File([webp() as unknown as BlobPart], 'evidence.webp', { type: 'image/webp' }));
    const app = stubApp(w.db, who, (a) => a.route('/api/uploads', uploadRoutes), { env });
    return app.request('/api/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  };
  const before = complaintKeys(w.bucket);
  for (const who of [ASSIST, KYC, MREV]) {
    const real = await uploadAs(who, 'ct_1');
    const invented = await uploadAs(who, 'ct_nosuch');
    assert.equal(real.status, 403, `${who.id} files nothing under a complaint`);
    assert.equal(await real.text(), await invented.text(), `${who.id}: a real and an invented complaint answer alike`);
    await assert.rejects(assertUploadEntity(w.db, who, 'complaint', 'ct_1', env), (e: unknown) => e instanceof HttpError && e.status === 403);
  }
  assert.deepEqual(complaintKeys(w.bucket), before, 'nothing landed in the complaint\'s folder');
  // Without the scope env the helper fails closed: an admin is asked the reporter's question.
  await assert.rejects(assertUploadEntity(w.db, OWNER, 'complaint', 'ct_1'), (e: unknown) => e instanceof HttpError && e.status === 403);
  for (const who of [OWNER, FULL, LEGACY, DISP]) {
    assert.equal(await assertUploadEntity(w.db, who, 'complaint', 'ct_1', env), 'ct_1', `${who.id} files under the complaint`);
  }
  const desk = await uploadAs(DISP, 'ct_1');
  assert.equal(desk.status, 200, await desk.clone().text());
  assert.match((await json(desk)).key, /^complaints\/ct_1\/attachments\//);
  // The reporter still files under their own complaint.
  assert.equal(await assertUploadEntity(w.db, CUSTOMER, 'complaint', 'ct_1', env), 'ct_1');
});

test('the community overview\'s complaints counter is the disputes desk\'s', async () => {
  const w = world();
  for (const who of [OWNER, FULL, DISP]) {
    const body = await json(await get(w.appAs(who), '/api/admin/community/overview'));
    assert.deepEqual({ total: Number(body.complaints.total), open: Number(body.complaints.open) }, { total: 1, open: 1 }, `${who.id} counts the complaint`);
  }
  for (const who of [ASSIST, KYC, MREV]) {
    const res = await get(w.appAs(who), '/api/admin/community/overview');
    assert.equal(res.status, 200, `${who.id} still opens the overview`);
    assert.equal((await json(res)).complaints, null, `${who.id} counts no complaint it cannot open`);
  }
  const community = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(community, /\{canHandleDisputes && d\.complaints && d\.complaints\.open > 0 && \(/, 'the banner is the desk\'s too');
});

// --------------------------------------- the side doors to identity data

const KYC_REASON = 'QORVAN-KYC-REASON';
const ADDRESS_REASON = 'QORVAN-ADDRESS-REASON';
const APPROVED_ADDRESS = 'Mansour street 3, house 4';
const REJECTED_ADDRESS = 'Adhamiya street 9';

/** The member console and the member window, over the world's database, plus a history worth hiding. */
function identityWorld() {
  const w = world();
  w.raw.exec(`
    UPDATE approved_addresses SET version = 3 WHERE id = 'aa_1';
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,state,reason,approved_at) VALUES
      ('aa_0','u_cust',1,'Subject','+9647700000009','${APPROVED_ADDRESS}','approved','','2026-02-01T00:00:00.000Z'),
      ('aa_r','u_cust',2,'Subject','+9647700000009','${REJECTED_ADDRESS}','rejected','${ADDRESS_REASON}',NULL);
    INSERT INTO kyc_cases (id,user_id,state,case_type,doc_type,reason,created_at) VALUES
      ('kc_0','u_cust','rejected','identity','passport','${KYC_REASON}','2026-01-01T00:00:00.000Z');
  `);
  const consoleAs = (who: StubUser) =>
    stubApp(w.db, who, (a) => {
      a.route('/api/support', supportRoutes);
      a.route('/api/admin', adminRoutes);
    });
  return { ...w, consoleAs };
}

const HIDDEN = [KYC_REASON, ADDRESS_REASON, SUBJECT_ADDRESS, REJECTED_ADDRESS, EVIDENCE_KEY, 'passport', 'kc_0', 'kc_1'];

test('07 — the member console and the member window read no KYC outside the KYC desk: no state, case, reason, filter or address request', async () => {
  const w = identityWorld();
  for (const who of [ASSIST, DISP, MREV]) {
    const app = w.consoleAs(who);
    const list = await get(app, '/api/support/admin/members');
    const listText = await list.text();
    assert.equal(list.status, 200, `${who.id} list: ${listText}`);
    const listed = JSON.parse(listText) as { can_review_kyc: boolean; members: Array<Record<string, unknown>> };
    assert.equal(listed.can_review_kyc, false);
    assert.ok(listed.members.some((m) => m.id === 'u_cust'), `${who.id} still finds the member`);
    for (const m of listed.members) assert.equal('kyc_state' in m, false, `${who.id}: ${String(m.id)} carries a KYC state`);
    // The filter would rebuild the queue the desk's door closes.
    for (const state of ['submitted', 'rejected', 'verified']) {
      await assertRefused(await get(app, `/api/support/admin/members?kyc=${state}`), 'KYC_REVIEW_FORBIDDEN', `${who.id} ?kyc=${state}`);
    }

    const detail = await get(app, '/api/support/admin/members/u_cust');
    const detailText = await detail.text();
    assert.equal(detail.status, 200, `${who.id} detail: ${detailText}`);
    const member = (JSON.parse(detailText) as { can_review_kyc: boolean; member: Record<string, unknown> }).member;
    assert.equal('kyc_cases' in member, false, `${who.id}: the detail carries KYC cases`);
    const addresses = member.approved_addresses as Array<Record<string, unknown>>;
    assert.deepEqual(addresses.map((a) => [a.id, a.state, a.address]), [['aa_0', 'approved', APPROVED_ADDRESS]], `${who.id}: only the current approved address`);
    assert.equal('reason' in addresses[0], false);
    for (const leak of HIDDEN) assert.ok(!detailText.includes(leak), `${who.id} detail carries «${leak}»`);

    const window = await get(app, '/api/admin/users/u_cust/detail');
    const windowText = await window.text();
    assert.equal(window.status, 200, `${who.id} member window: ${windowText}`);
    const card = (JSON.parse(windowText) as { member: Record<string, unknown> }).member;
    assert.equal('kyc' in card, false, `${who.id}: the member window carries a KYC state`);
    assert.deepEqual(card.approved_address && (card.approved_address as Record<string, unknown>).state, 'approved', `${who.id}: no pending request on the card`);
    for (const leak of HIDDEN) assert.ok(!windowText.includes(leak), `${who.id} member window carries «${leak}»`);
  }
  // Nothing was opened, so nothing was audited as a KYC view.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'kyc.%'"), 0);
});

test('07 — the KYC desk still reads the member\'s identity state, cases and every address version in the console', async () => {
  const w = identityWorld();
  for (const who of [OWNER, FULL, LEGACY, KYC]) {
    const app = w.consoleAs(who);
    const listed = await json(await get(app, '/api/support/admin/members'));
    assert.equal(listed.can_review_kyc, true);
    const row = (listed.members as Array<Record<string, unknown>>).find((m) => m.id === 'u_cust');
    assert.ok(row && 'kyc_state' in row && row.kyc_state, `${who.id} sees the KYC state`);
    const filtered = await get(app, '/api/support/admin/members?kyc=submitted');
    assert.equal(filtered.status, 200, `${who.id} filters by KYC state`);

    const detail = await json(await get(app, '/api/support/admin/members/u_cust'));
    assert.equal(detail.can_review_kyc, true);
    assert.deepEqual((detail.member.kyc_cases as Array<{ id: string }>).map((k) => k.id).sort(), ['kc_0', 'kc_1']);
    assert.deepEqual((detail.member.approved_addresses as Array<{ id: string }>).map((a) => a.id), ['aa_1', 'aa_r', 'aa_0']);
    assert.ok(JSON.stringify(detail).includes(KYC_REASON));

    const card = (await json(await get(app, '/api/admin/users/u_cust/detail'))).member;
    assert.ok(card.kyc && card.kyc.state, `${who.id} sees the latest KYC state on the member window`);
    assert.equal(card.approved_address.state, 'pending', `${who.id} sees the pending request`);
  }
});

test('the member screens hide the KYC filter, column and sections without the hint or the payload', () => {
  const list = code('src/components/AdminMemberships.tsx');
  assert.match(list, /const canReviewKyc = useAuth\(\)\.user\?\.can_review_kyc === true;/);
  assert.match(list, /if \(kyc && canReviewKyc\) params\.set\('kyc', kyc\);/);
  assert.match(list, /\{canReviewKyc && \(\s*<select[^>]*value=\{kyc\}/);
  assert.match(list, /\.\.\.\(canReviewKyc \? \[s\.colKyc\] : \[\]\)/);
  assert.match(list, /\{canReviewKyc && <td[^>]*>\{m\.kyc_state \?\? '—'\}<\/td>\}/);
  const detail = code('src/components/adminMemberships/MemberDetailModal.tsx');
  assert.match(detail, /\{view\.kyc_cases && \(\s*<Section\s+title=\{s\.secIdentity\}/);
  // The header pill and the decision tile read the same optional list, and never crash on its absence.
  assert.match(detail, /const latestKyc = view\?\.kyc_cases\?\.\[0\] \?\? null;/);
  assert.match(detail, /\{view\.kyc_cases && \(\s*<Stat\s+label=\{s\.fKyc\}/);
  const window = code('src/components/adminUsers/MemberDetailModal.tsx');
  assert.match(window, /\{m\.kyc !== undefined && \(\s*<Section title=\{s\.secKyc\}/);
  assert.match(code('src/components/adminMemberships/types.ts'), /kyc_cases\?: KycCaseRow\[\];/);
  assert.match(code('src/components/adminUsers/types.ts'), /kyc\?: \{ state: string;/);
});

test('complaint files and the support badge follow the disputes desk', async () => {
  const w = world();
  for (const who of [OWNER, FULL, DISP]) {
    assert.equal((await get(w.appAs(who), `/files/${COMPLAINT_FILE}`)).status, 200, `${who.id} reads the attachment`);
    assert.equal((await json(await get(w.appAs(who), '/api/admin/chats/summary'))).complaints_open, 1, `${who.id} badge`);
  }
  for (const who of [ASSIST, KYC]) {
    const res = await get(w.appAs(who), `/files/${COMPLAINT_FILE}`);
    assert.equal(res.status, 403, `${who.id} reads no attachment`);
    assert.equal((await json(await get(w.appAs(who), '/api/admin/chats/summary'))).complaints_open, 0, `${who.id} counts no complaint it cannot open`);
  }
  // The reporter still reads their own file.
  assert.equal((await get(w.appAs(CUSTOMER), `/files/${COMPLAINT_FILE}`)).status, 200);
});

test('DISPUTES opens no money: settling an escrow is still refused, and the money hints stay shut', async () => {
  const w = world();
  const resolve = await post(w.appAs(DISP), '/api/admin/community/escrows/esc_any/resolve', {});
  assert.equal(resolve.status, 403);
  assert.equal((await json(resolve)).code, 'FINANCIAL_SCOPE_REQUIRED');
  const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
  const session = { ...DISP, capability_grants: ['DISPUTES', 'KYC_REVIEW'] } as unknown as SessionUser;
  assert.equal(canMoveMoney(env, session), false);
  assert.equal(canViewCost(env, session), false);
  const hints = publicUser(session, env);
  assert.equal(hints.can_handle_disputes, true);
  assert.equal(hints.can_review_kyc, true);
  assert.equal(hints.can_move_money, false);
  assert.equal(hints.can_review_merchants, false, 'one desk\'s grant opens no other desk');
});

// ------------------------------------------------------- the owner's grants

test('the owner issues KYC_REVIEW and DISPUTES through the grant routes; an unknown key is refused; the list carries every key', async () => {
  const w = world();
  assert.deepEqual([...CAPABILITY_GRANTS], ['MERCHANT_REVIEW', 'KYC_REVIEW', 'DISPUTES']);
  assert.equal(isCapabilityGrant('PRICING_PRIVATE_READ'), false);

  const base = '/api/admin/merchant-applications/reviewers';
  for (const key of ['KYC_REVIEW', 'DISPUTES'] as const) {
    const ok = await post(w.appAs(OWNER), `${base}/${ASSIST.id}/grant`, { grant_key: key, operation_id: `op-grant-${key}-01` });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(await json(ok), { success: true, granted: true, already: false });
    assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.capability_grant.issued' AND target = ? AND detail LIKE ?", ASSIST.id, `%${key}%`), 1);
  }
  assert.equal((await get(w.appAs(ASSIST), '/api/kyc/admin/queue')).status, 200, 'KYC_REVIEW opens the KYC desk');
  assert.equal((await get(w.appAs(ASSIST), '/api/admin/community/complaints')).status, 200, 'DISPUTES opens the complaints desk');
  assert.equal((await get(w.appAs(ASSIST), '/api/admin/merchant-applications')).status, 403, 'and neither opens merchant review');

  const unknown = await post(w.appAs(OWNER), `${base}/${ASSIST.id}/grant`, { grant_key: 'PRICING_PRIVATE_READ' });
  assert.equal(unknown.status, 400);
  assert.equal((await json(unknown)).code, 'CAPABILITY_GRANT_KEY_INVALID');
  const full = await post(w.appAs(OWNER), `${base}/${FULL.id}/grant`, { grant_key: 'DISPUTES' });
  assert.equal((await json(full)).code, 'CAPABILITY_GRANT_NOT_NEEDED');
  for (const who of [FULL, KYC, DISP]) {
    assert.equal((await post(w.appAs(who), `${base}/${ASSIST.id}/grant`, { grant_key: 'KYC_REVIEW' })).status, 403, `${who.id} grants nothing`);
  }

  const list = await json(await get(w.appAs(OWNER), base));
  const byId = new Map((list.reviewers as Array<{ id: string; granted: boolean; by_default: boolean; grants: Record<string, boolean> }>).map((r) => [r.id, r]));
  assert.deepEqual(byId.get(ASSIST.id)!.grants, { MERCHANT_REVIEW: false, KYC_REVIEW: true, DISPUTES: true });
  assert.deepEqual(byId.get(KYC.id)!.grants, { MERCHANT_REVIEW: false, KYC_REVIEW: true, DISPUTES: false });
  assert.deepEqual(byId.get(MREV.id)!.grants, { MERCHANT_REVIEW: true, KYC_REVIEW: false, DISPUTES: false });
  assert.equal(byId.get(MREV.id)!.granted, true, 'the first client\'s MERCHANT_REVIEW flag is kept');
  assert.equal(byId.get(KYC.id)!.granted, false);
  assert.deepEqual(byId.get(FULL.id)!.grants, { MERCHANT_REVIEW: false, KYC_REVIEW: false, DISPUTES: false });
  assert.equal(byId.get(FULL.id)!.by_default, true);
  assert.ok(!JSON.stringify(list).includes('@example.test'), 'no admin address in the answer');
});

test('the session hints are the same rule: owner and full yes; an assistant per grant; a customer never', async () => {
  const env = { INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
  const w = world();
  const cases: Array<[StubUser, string[], boolean, boolean]> = [
    [OWNER, [], true, true],
    [FULL, [], true, true],
    [LEGACY, [], true, true],
    [KYC, ['KYC_REVIEW'], true, false],
    [DISP, ['DISPUTES'], false, true],
    [MREV, ['MERCHANT_REVIEW'], false, false],
    [ASSIST, [], false, false],
    [PREMIUM, [], false, false],
    [MERCHANT, [], false, false],
  ];
  for (const [u, grants, kyc, disputes] of cases) {
    const session = { ...u, capability_grants: grants } as unknown as SessionUser;
    const hints = publicUser(session, env);
    assert.equal(hints.can_review_kyc, kyc, `${u.id} kyc hint`);
    assert.equal(hints.can_handle_disputes, disputes, `${u.id} disputes hint`);
    assert.equal(await canReviewKyc({ DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' }, u as unknown as SessionUser), kyc, `${u.id} kyc rule`);
    assert.equal(await canHandleDisputes({ DB: w.db, INITIAL_ADMIN_EMAIL: 'boss@x.co' }, u as unknown as SessionUser), disputes, `${u.id} disputes rule`);
  }
  // A grant listed on a customer's session widens nothing.
  const forged = publicUser({ ...PREMIUM, capability_grants: ['KYC_REVIEW', 'DISPUTES'] } as unknown as SessionUser, env);
  assert.equal(forged.can_review_kyc, false);
  assert.equal(forged.can_handle_disputes, false);
});

test('a database without 0204 fails closed for an assistant and still opens the desks to the owner and full admins', async () => {
  const raw = dbThrough('0203');
  raw.exec(`INSERT INTO users (id,email,password_hash,role,admin_scope) VALUES
    ('u_owner','boss@x.co','h','admin',NULL), ('u_full','full@example.test','h','admin','full'), ('u_kyc','kyc@example.test','h','admin','assistant')`);
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' };
  assert.equal(await canReviewKyc(env, OWNER as unknown as SessionUser), true);
  assert.equal(await canHandleDisputes(env, FULL as unknown as SessionUser), true);
  assert.equal(await canReviewKyc(env, KYC as unknown as SessionUser), false);
  assert.equal(await canHandleDisputes(env, KYC as unknown as SessionUser), false);
  assert.equal(await canReviewMerchants(env, KYC as unknown as SessionUser), false);
});

// --------------------------------------------- 48: checkout address change

test('48 — a checkout address change leaves the merchant application, the membership and the KYC rows untouched', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO merchant_applications (id,user_id,state,revision,public_name,activity_kind,submitted_at)
      VALUES ('mapp_subject0001','u_cust','submitted',2,'Subject Prints','print_services','2026-10-01T00:00:00.000Z');
    UPDATE kyc_cases SET state = 'verified', decided_by = 'u_full', decided_at = '2026-10-02T00:00:00.000Z' WHERE id = 'kc_1';
    INSERT INTO addresses (id,user_id,label,name,phone,address,is_default,governorate)
      VALUES ('addr_home','u_cust','home','Subject','+9647700000009','${SUBJECT_ADDRESS}',1,'baghdad');
    UPDATE approved_addresses SET state = 'approved', approved_by = 'u_full', approved_at = '2026-10-02T00:00:00.000Z',
      source_address_id = 'addr_home' WHERE id = 'aa_1';
  `);
  const snapshot = () =>
    JSON.stringify({
      applications: all(w.raw, 'SELECT * FROM merchant_applications ORDER BY id'),
      applicationEvents: all(w.raw, 'SELECT id FROM merchant_application_events ORDER BY id'),
      merchants: all(w.raw, 'SELECT * FROM community_merchants ORDER BY id'),
      memberships: all(w.raw, 'SELECT * FROM memberships ORDER BY id'),
      membershipColumns: all(w.raw, 'SELECT id, membership_tier, subscription_plan, subscription_expiry, subscription_days FROM users ORDER BY id'),
      kyc: all(w.raw, 'SELECT * FROM kyc_cases ORDER BY id'),
      approvedAddresses: all(w.raw, 'SELECT * FROM approved_addresses ORDER BY id'),
      restrictions: all(w.raw, 'SELECT * FROM restriction_cases ORDER BY id'),
    });
  const before = snapshot();

  // What the checkout's address sheet sends (src/components/address/AddressForm.tsx): edit, add, choose, remove.
  const app = w.appAs(CUSTOMER);
  const address = { label: 'home', name: 'Subject', phone: '07700000010', address: 'Mansour street 3, flat 4', governorate: 'baghdad' };
  const edited = await put(app, '/api/addresses/addr_home', address);
  assert.equal(edited.status, 200, await edited.clone().text());
  const added = await post(app, '/api/addresses', { ...address, label: 'work', address: 'Arasat street 9, office 2' });
  assert.equal(added.status, 200, await added.clone().text());
  const newId = (await json(added)).id as string;
  assert.equal((await post(app, `/api/addresses/${newId}/default`, {})).status, 200);
  const listed = await json(await get(app, '/api/addresses'));
  const home = (listed.addresses as Array<{ id: string; backs_approved_snapshot: boolean; matches_approved_snapshot: boolean | null }>).find((a) => a.id === 'addr_home')!;
  assert.equal(home.backs_approved_snapshot, true, 'the approved snapshot still names the saved row');
  assert.equal(home.matches_approved_snapshot, false, 'and is told apart from the edit, not rewritten by it');

  assert.equal(snapshot(), before, 'no application, membership or KYC row moved');
});

// ------------------------------------------------------------ the words

test('every new word is written in Arabic, English and real Sorani', () => {
  const SORANI_ONLY = /[ڕڵێۆەڤگچژپ]/;
  for (const c of ['KYC_REVIEW_FORBIDDEN', 'DISPUTES_FORBIDDEN', 'CAPABILITY_GRANT_KEY_INVALID', 'CAPABILITY_GRANT_TARGET_INVALID', 'CAPABILITY_GRANT_NOT_NEEDED']) {
    const s = REFUSAL_STRINGS[c]!;
    assert.ok(s && s.ar.trim() && s.en.trim() && s.ckb.trim(), c);
    assert.notEqual(s.ckb, s.ar, `${c}: the Sorani is a copy of the Arabic`);
    assert.notEqual(s.en, s.ar, c);
    assert.match(s.ckb, SORANI_ONLY, c);
  }
  type Tree = { [k: string]: string | Tree };
  const leaves = (t: Tree, prefix = ''): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(t)) {
      if (typeof v === 'string') out.set(`${prefix}${k}`, v);
      else for (const [kk, vv] of leaves(v, `${prefix}${k}.`)) out.set(kk, vv);
    }
    return out;
  };
  const ar = leaves(GRANT_STRINGS.ar as unknown as Tree);
  const en = leaves(GRANT_STRINGS.en as unknown as Tree);
  const ckb = leaves(GRANT_STRINGS.ckb as unknown as Tree);
  assert.deepEqual([...en.keys()].sort(), [...ar.keys()].sort());
  assert.deepEqual([...ckb.keys()].sort(), [...ar.keys()].sort());
  for (const [k, a] of ar) {
    assert.notEqual(ckb.get(k), a, `${k}: the Sorani is a copy of the Arabic`);
    assert.notEqual(en.get(k), a, `${k}: the English is the Arabic`);
    if (ckb.get(k)!.length > 12) assert.match(ckb.get(k)!, SORANI_ONLY, `${k}: «${ckb.get(k)}» does not read as Sorani`);
  }
  for (const key of CAPABILITY_GRANTS) assert.ok(GRANT_STRINGS.ckb.desks[key].title, key);
});

// ------------------------------------------------------------ the screens

test('the admin screens hide the KYC tab and the disputes desk without the hint, and say why if reached', () => {
  const admin = code('src/pages/Admin.tsx');
  assert.match(admin, /const canReviewKyc = user\?\.can_review_kyc === true;/);
  assert.match(admin, /\.\.\.\(canReviewKyc\s*\?\s*\[\{ id: 'kyc'/);
  const kyc = code('src/components/AdminKyc.tsx');
  assert.match(kyc, /if \(user\?\.can_review_kyc !== true\) return <CapabilityRefusal code="KYC_REVIEW_FORBIDDEN" \/>;/);
  assert.match(kyc, /\{isOwner && <ReviewerGrants grantKey="KYC_REVIEW" \/>\}/);
  const queue = code('src/components/adminSupport/SupportQueue.tsx');
  assert.match(queue, /const canHandleDisputes = user\?\.can_handle_disputes === true;/);
  assert.match(queue, /\.\.\.\(canHandleDisputes\s*\?\s*\[\{ id: 'complaints'/);
  assert.match(queue, /<CapabilityRefusal code="DISPUTES_FORBIDDEN" \/>/);
  assert.match(queue, /user\?\.is_owner === true && <ReviewerGrants grantKey="DISPUTES" \/>/);
  const community = code('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(community, /const canHandleDisputes = useAuth\(\)\.user\?\.can_handle_disputes === true;/);
  assert.match(community, /\.\.\.\(canHandleDisputes \? \[\{ id: 'disputes'/);
  assert.match(community, /section === 'disputes' && \(canHandleDisputes \? <Disputes t=\{t\} \/> : <CapabilityRefusal code="DISPUTES_FORBIDDEN" \/>\)/);
  const grants = code('src/components/adminScope/CapabilityGrants.tsx');
  assert.match(grants, /reviewApi\.grant\(row\.id, newOperationId\(\), grantKey\)/);
  assert.match(grants, /reviewApi\.revoke\(row\.id, grantKey\)/);
  assert.match(grants, /refusalText\(code, refusalLang\(lang\)\)/);
});
