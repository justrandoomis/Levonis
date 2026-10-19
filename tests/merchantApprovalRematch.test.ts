/**
 * A DECISION THAT RESTORES ELIGIBILITY RE-MATCHES THE WORKSHOP (Community V3
 * push 1.4 review, task B).
 *
 * Since the approval gate is enforced, the publish-time match reads ACTIVE,
 * APPROVED workshops only (`loadCandidates(db)`), so a request published
 * while an existing merchant waits for review writes no verdict for them. The
 * board re-matches on its own only when nothing was ever decided for the
 * workshop or a re-match is queued — and a workshop from before the gate
 * always has old verdicts. So:
 *
 *   · APPROVE queues the existing merchant row in its own batch
 *     (`community_match_queue`, kind 'merchant'), and the board, which drains
 *     that queue, then lists the request published during review;
 *   · approving a brand-new applicant (no merchant row) queues nothing and
 *     still succeeds — their first board visit matches them in full;
 *   · the reviewer's route runs the re-match after the response, so «for me»
 *     knows the request without a board visit;
 *   · lifting a merchant sanction, or restoring an admin-suspended store,
 *     re-matches the same way.
 *
 * Real routes, every migration, only the session stubbed.
 *
 * Run: node --import tsx --test tests/merchantApprovalRematch.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, json, row, count, pending, type StubUser } from './fixtures/app';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { communityRoutes } from '../worker/routes/community';
import { adminMerchantApplicationRoutes } from '../worker/routes/adminMerchantApplications';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { applyTransition } from '../worker/lib/merchantApproval';
import { MATCH_ENGINE, matchRequest } from '../worker/lib/printMatchingStore';
import type { Env } from '../worker/lib/types';

const FUTURE = '2099-01-01T00:00:00.000Z';
const STAMP = '2026-10-18T09:00:00.000Z';
const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

interface Opts {
  approved?: boolean;
  merchantStatus?: string;
  storeStatus?: string;
}

/**
 * An existing workshop from before the gate: an FDM printer, an active PLUS,
 * a store in Baghdad, an application IN REVIEW, and an engine-current
 * «eligible» verdict for a request published before the gate (r1).
 */
function seed(o: Opts = {}): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('owner','Ali','owner@x.co','h','merchant','alimaker'),
      ('buyer','Sara','buyer@x.co','h','customer','sara'),
      ('newbie','Huda','newbie@x.co','h','customer','huda'),
      ('boss','Boss','boss@x.co','h','admin','boss');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m1','owner','Ali Dragon Prints','${o.merchantStatus ?? 'active'}');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings,governorate)
      VALUES ('s1','m1','owner','ali3d','Dragon Forge','${o.storeStatus ?? 'active'}','{}','baghdad');
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max)
      VALUES ('p1','m1','s1','A1','fdm',256,256,256,'[]','fine');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility,revision,published_at,created_at,governorate)
      VALUES ('r1','buyer','Before the gate','A stand','open','open','public',1,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','baghdad');
    INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,revision,engine)
      VALUES ('mt1','r1','m1',1,1,${MATCH_ENGINE});
    INSERT INTO merchant_applications (id,user_id,state,revision,public_name) VALUES
      ('mapp_a1b2c3d4e5f6','owner','in_review',1,'Ali Dragon Prints'),
      ('mapp_0f1e2d3c4b5a','newbie','in_review',1,'Huda Prints');
  `);
  if (o.approved) raw.prepare("UPDATE community_merchants SET approved_at = ? WHERE id = 'm1'").run(STAMP);
  return raw;
}

/** A buyer publishes `id` now: the real publish-time match runs over every eligible workshop. */
async function publish(raw: DatabaseSync, id: string, at: string): Promise<void> {
  raw.prepare(
    `INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility,revision,published_at,created_at,governorate)
     VALUES (?, 'buyer', 'Published meanwhile', 'A bracket', 'open', 'open', 'public', 1, ?, ?, 'baghdad')`
  ).run(id, at, at);
  await matchRequest({ DB: asD1(raw) } as unknown as Env, id, { notify: true });
}

const verdict = (raw: DatabaseSync, requestId: string) =>
  row<{ eligible: number; reject_reason: string }>(
    raw,
    "SELECT eligible, reject_reason FROM community_request_matches WHERE request_id = ? AND merchant_id = 'm1'",
    requestId
  );
const queued = (raw: DatabaseSync) =>
  row<{ reason: string; attempts: number; last_error: string }>(
    raw,
    "SELECT reason, attempts, last_error FROM community_match_queue WHERE kind = 'merchant' AND subject_id = 'm1'"
  );

const merchantApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/merchant/workshop', merchantWorkshopRoutes);
    a.route('/api/community', communityRoutes);
  });
const adminApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), BOSS, (a) => {
    a.route('/api/admin/merchant-applications', adminMerchantApplicationRoutes);
    a.route('/api/admin/community', adminCommunityRoutes);
  });

const boardIds = async (raw: DatabaseSync): Promise<string[]> => {
  const body = await json(await get(merchantApp(raw), '/api/merchant/workshop/board'));
  assert.equal(body.success, true, JSON.stringify(body));
  assert.equal(body.blocked, undefined, `the board is open: ${body.blocked}`);
  return (body.requests as Array<{ id: string }>).map((r) => r.id).sort();
};
const forMeIds = async (raw: DatabaseSync): Promise<string[]> => {
  const body = await json(await get(merchantApp(raw), '/api/community/requests?for=me'));
  assert.equal(body.success, true, JSON.stringify(body));
  return (body.requests as Array<{ id: string }>).map((r) => r.id).sort();
};

const approve = (raw: DatabaseSync, applicationId: string, userId: string, operationId: string) =>
  applyTransition(asD1(raw), {
    application: { id: applicationId, user_id: userId, state: 'in_review', revision: 1 },
    action: 'approve',
    actor: { id: 'boss', kind: 'reviewer' },
    operationId,
  });

test('approve queues an existing workshop in its own batch, and the board then lists the request published during review', async () => {
  const raw = seed();
  await publish(raw, 'r2', '2026-10-19T00:00:00.000Z');
  assert.equal(verdict(raw, 'r2'), undefined, 'published during review: the match passed the unapproved workshop by');
  const blocked = await json(await get(merchantApp(raw), '/api/merchant/workshop/board'));
  assert.equal(blocked.blocked, 'MERCHANT_NOT_APPROVED');

  const out = await approve(raw, 'mapp_a1b2c3d4e5f6', 'owner', 'op-approve-owner-1');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(row<{ approved_at: string | null }>(raw, "SELECT approved_at FROM community_merchants WHERE id = 'm1'")?.approved_at);
  assert.deepEqual(queued(raw), { reason: 'approved', attempts: 0, last_error: '' }, 'the approval queued the re-match');

  assert.deepEqual(await boardIds(raw), ['r1', 'r2'], 'the board drained the queue: the request from the review period is there');
  assert.equal(queued(raw), undefined, 'and the queue row is gone');
  assert.equal(verdict(raw, 'r2')?.eligible, 1);
  assert.deepEqual(await forMeIds(raw), ['r1', 'r2']);

  // A replay of the same operation writes nothing — no second queue row.
  const replay = await approve(raw, 'mapp_a1b2c3d4e5f6', 'owner', 'op-approve-owner-1');
  assert.equal(replay.ok && replay.replay, true);
  assert.equal(queued(raw), undefined);
});

test('control: without that queue row the old verdicts keep the board from re-matching — the request stays missing', async () => {
  const raw = seed();
  await publish(raw, 'r2', '2026-10-19T00:00:00.000Z');
  assert.equal((await approve(raw, 'mapp_a1b2c3d4e5f6', 'owner', 'op-approve-owner-2')).ok, true);
  raw.exec("DELETE FROM community_match_queue WHERE kind = 'merchant'");
  assert.deepEqual(await boardIds(raw), ['r1'], 'what every pre-gate workshop saw before the fix');
});

test('approving a brand-new applicant without a merchant row queues nothing and does not fail', async () => {
  const raw = seed();
  const out = await approve(raw, 'mapp_0f1e2d3c4b5a', 'newbie', 'op-approve-newbie-1');
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.ok && out.state, 'approved');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_merchants WHERE user_id = 'newbie'"), 0, 'approval creates no merchant row');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_match_queue'), 0, 'and queues no re-match');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM merchant_applications WHERE id = 'mapp_0f1e2d3c4b5a'")?.state, 'approved');
});

test('the reviewer\'s approve route re-matches after the response: «for me» lists the request without a board visit', async () => {
  const raw = seed();
  await publish(raw, 'r2', '2026-10-19T00:00:00.000Z');
  const res = await post(adminApp(raw), '/api/admin/merchant-applications/mapp_a1b2c3d4e5f6/approve', { revision: 1, operation_id: 'op-route-approve-1' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  await Promise.all(pending);
  assert.equal(verdict(raw, 'r2')?.eligible, 1, 'the pass after the response wrote the verdict');
  assert.equal(queued(raw), undefined, 'and cleared its queue row');
  assert.deepEqual(await forMeIds(raw), ['r1', 'r2']);

  // A new applicant through the same route: no merchant row, nothing to re-match, a 200.
  const fresh = await post(adminApp(raw), '/api/admin/merchant-applications/mapp_0f1e2d3c4b5a/approve', { revision: 1, operation_id: 'op-route-approve-2' });
  assert.equal(fresh.status, 200);
  await Promise.all(pending);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_match_queue'), 0);
});

test('lifting a merchant sanction re-matches: the request published while suspended reaches the board', async () => {
  const raw = seed({ approved: true, merchantStatus: 'suspended' });
  await publish(raw, 'r3', '2026-10-19T00:00:00.000Z');
  assert.equal(verdict(raw, 'r3'), undefined, 'a suspended workshop is never a publish-time candidate');

  const res = await post(adminApp(raw), '/api/admin/community/merchants/m1/status', { status: 'active', reason: '' });
  assert.equal(res.status, 200);
  await Promise.all(pending);
  assert.equal(verdict(raw, 'r3')?.eligible, 1);
  assert.equal(queued(raw), undefined);
  assert.deepEqual(await boardIds(raw), ['r1', 'r3']);
});

test('restoring an admin-suspended store re-matches: its STORE_UNAVAILABLE verdicts do not outlive the suspension', async () => {
  const raw = seed({ approved: true, storeStatus: 'suspended' });
  await publish(raw, 'r4', '2026-10-19T00:00:00.000Z');
  assert.deepEqual(verdict(raw, 'r4'), { eligible: 0, reject_reason: 'STORE_UNAVAILABLE' });

  const res = await post(adminApp(raw), '/api/admin/community/stores/s1/status', { status: 'active', reason: '' });
  assert.equal(res.status, 200);
  await Promise.all(pending);
  assert.equal(verdict(raw, 'r4')?.eligible, 1);
  assert.equal(queued(raw), undefined);
  assert.deepEqual(await boardIds(raw), ['r1', 'r4']);
});
