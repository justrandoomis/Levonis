/**
 * EVERY NEW ADMIN STARTS AS AN ASSISTANT — owner decision 2 (2026-10-07),
 * migration 0177, step S1.
 *
 * «أي Admin جديد يبدأ Assistant Admin بدون PRICING_PRIVATE_READ /
 * PRICING_PRIVATE_WRITE ولا يتم منح هذه الصلاحيات تلقائياً لأي شخص».
 *
 * Proved at both layers, because either alone has a hole:
 *   - the DATABASE (trigger `users_promotion_starts_assistant`) catches every
 *     writer, including one nobody has written yet;
 *   - the ROUTE writes 'assistant' too, so the rule holds on a database the
 *     migration has not reached (deploy ahead), refuses a promotion that asks
 *     for more, and reports the scope the row really holds (critique G-4).
 * Widening is the owner's act alone, with a sign-in younger than ten minutes;
 * the owner may promote and widen in one request (critique D5), written as two
 * statements so the trigger cannot overwrite it. The grant table is
 * append-only, revoke-once, and a demotion revokes every live grant.
 *
 * Run: node --import tsx --test tests/adminPromotionDefault.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, count, dbThrough, freshDb, json, patch, row, stubApp, type StubUser } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';

const FULL: StubUser = { id: 'usr_full', role: 'admin', email: 'full@x.co', admin_scope: 'full' };
const ASSISTANT: StubUser = { id: 'usr_asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

function seeded(raw: DatabaseSync = freshDb()) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope,is_investor,email_verified_at) VALUES
      ('usr_owner','Owner','boss@x.co','h','admin',NULL,0,'2026-01-01T00:00:00.000Z'),
      ('usr_full','Full','full@x.co','h','admin','full',0,NULL),
      ('usr_asst','Asst','asst@x.co','h','admin','assistant',0,NULL),
      ('u_c','Customer','c@x.co','h','customer',NULL,0,NULL),
      ('u_stale','Stale','stale@x.co','h','customer','full',0,NULL);
  `);
  return raw;
}

const app = (raw: DatabaseSync, user: StubUser, sessionAgeSeconds = 0) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/admin', adminRoutes), { sessionAgeSeconds });
const scopeOf = (raw: DatabaseSync, id: string) =>
  row<{ role: string; admin_scope: string | null }>(raw, 'SELECT role, admin_scope FROM users WHERE id = ?', id)!;

// ------------------------------------------------------------- the route

test('a full admin promotes a customer: the row says assistant, and so does the answer', async () => {
  const raw = seeded();
  const res = await patch(app(raw, FULL), '/api/admin/users/u_c', { role: 'admin' });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).admin_scope, 'assistant');
  assert.deepEqual(scopeOf(raw, 'u_c'), { role: 'admin', admin_scope: 'assistant' });
});

test("a promotion over a stale stored 'full' still lands as an assistant", async () => {
  const raw = seeded();
  await patch(app(raw, FULL), '/api/admin/users/u_stale', { role: 'admin' });
  assert.deepEqual(scopeOf(raw, 'u_stale'), { role: 'admin', admin_scope: 'assistant' });
});

test('a promotion that asks for a wider scope is refused for a full admin, and nothing is written', async () => {
  const raw = seeded();
  for (const admin_scope of ['full', null]) {
    const res = await patch(app(raw, FULL), '/api/admin/users/u_c', { role: 'admin', admin_scope });
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'PROMOTION_STARTS_ASSISTANT');
  }
  assert.deepEqual(scopeOf(raw, 'u_c'), { role: 'customer', admin_scope: null });
});

test('an assistant cannot promote at all; a full admin cannot widen; nor change investor status', async () => {
  const raw = seeded();
  const asst = await patch(app(raw, ASSISTANT), '/api/admin/users/u_c', { role: 'admin' });
  assert.equal(asst.status, 403);
  assert.equal((await json(asst)).code, 'ROLE_CHANGE_DENIED');

  const widen = await patch(app(raw, FULL), '/api/admin/users/usr_asst', { admin_scope: 'full' });
  assert.equal(widen.status, 403);
  assert.equal((await json(widen)).code, 'SCOPE_ELEVATION_OWNER_ONLY');

  const investor = await patch(app(raw, FULL), '/api/admin/users/u_c', { is_investor: true });
  assert.equal(investor.status, 403);
  assert.equal((await json(investor)).code, 'INVESTOR_FLAG_OWNER_ONLY');

  assert.deepEqual(scopeOf(raw, 'usr_asst'), { role: 'admin', admin_scope: 'assistant' });
  assert.equal(row<{ is_investor: number }>(raw, "SELECT is_investor FROM users WHERE id = 'u_c'")!.is_investor, 0);
});

test('the owner widens an assistant with a fresh sign-in; an 11-minute-old one is REAUTH_REQUIRED and changes nothing', async () => {
  const raw = seeded();
  const stale = await patch(app(raw, OWNER, 11 * 60), '/api/admin/users/usr_asst', { admin_scope: 'full' });
  assert.equal(stale.status, 401);
  assert.equal((await json(stale)).code, 'REAUTH_REQUIRED');
  assert.deepEqual(scopeOf(raw, 'usr_asst'), { role: 'admin', admin_scope: 'assistant' });

  const fresh = await patch(app(raw, OWNER, 60), '/api/admin/users/usr_asst', { admin_scope: 'full' });
  assert.equal(fresh.status, 200);
  assert.equal((await json(fresh)).admin_scope, 'full');
  assert.deepEqual(scopeOf(raw, 'usr_asst'), { role: 'admin', admin_scope: 'full' });
});

test('restricting needs no fresh sign-in: a full admin restricts another full admin', async () => {
  const raw = seeded();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('usr_f2','F2','f2@x.co','h','admin','full')");
  const res = await patch(app(raw, FULL, 3600), '/api/admin/users/usr_f2', { admin_scope: 'assistant' });
  assert.equal(res.status, 200);
  assert.deepEqual(scopeOf(raw, 'usr_f2'), { role: 'admin', admin_scope: 'assistant' });
});

test('critique D5: the owner promotes AND grants full in one request — the stored scope is full and the answer matches', async () => {
  const raw = seeded();
  const res = await patch(app(raw, OWNER, 30), '/api/admin/users/u_c', { role: 'admin', admin_scope: 'full' });
  assert.equal(res.status, 200);
  assert.equal((await json(res)).admin_scope, 'full');
  assert.deepEqual(scopeOf(raw, 'u_c'), { role: 'admin', admin_scope: 'full' });

  // …and with a stale sign-in, neither half lands.
  const raw2 = seeded();
  const stale = await patch(app(raw2, OWNER, 11 * 60), '/api/admin/users/u_c', { role: 'admin', admin_scope: 'full' });
  assert.equal(stale.status, 401);
  assert.deepEqual(scopeOf(raw2, 'u_c'), { role: 'customer', admin_scope: null });
});

test('critique G-4: the audit records the scope the ROW holds after the write, never the one requested', async () => {
  const raw = seeded();
  await patch(app(raw, FULL), '/api/admin/users/u_c', { role: 'admin' });
  const audits = all<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'admin.user_update' AND target = 'u_c'");
  assert.equal(audits.length, 1);
  const detail = JSON.parse(audits[0]!.detail) as Record<string, unknown>;
  assert.equal(detail.role, 'admin');
  assert.equal(detail.admin_scope, 'assistant');
  assert.ok((detail.fields as string[]).includes('admin_scope'), 'the scope column is named as written');
});

test('the user PATCH is rate limited: the 61st change in an hour is refused', async () => {
  const raw = seeded();
  const a = app(raw, FULL);
  for (let i = 0; i < 60; i++) {
    const res = await patch(a, '/api/admin/users/u_c', { membership_tier: i % 2 ? 'free' : 'plus' });
    assert.notEqual(res.status, 429, `call ${i + 1}`);
  }
  const over = await patch(a, '/api/admin/users/u_c', { membership_tier: 'free' });
  assert.equal(over.status, 429);
});

test('deploy ahead of 0177: the route alone still lands every promotion as an assistant', async () => {
  const raw = seeded(dbThrough('0176'));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'users_promotion_starts_assistant'"), 0);
  const res = await patch(app(raw, FULL), '/api/admin/users/u_stale', { role: 'admin' });
  assert.equal(res.status, 200);
  assert.deepEqual(scopeOf(raw, 'u_stale'), { role: 'admin', admin_scope: 'assistant' });
});

// ------------------------------------------------------------- the database

test('the trigger: a raw promotion stores assistant, even in the same statement that sets full (critique D5)', () => {
  const raw = seeded();
  raw.exec("UPDATE users SET role = 'admin' WHERE id = 'u_stale'");
  assert.deepEqual(scopeOf(raw, 'u_stale'), { role: 'admin', admin_scope: 'assistant' });

  raw.exec("UPDATE users SET role = 'admin', admin_scope = 'full' WHERE id = 'u_c'");
  assert.deepEqual(scopeOf(raw, 'u_c'), { role: 'admin', admin_scope: 'assistant' }, 'the AFTER trigger has the last word');

  // A scope-only UPDATE of an existing admin does not touch `role`: the trigger stays quiet.
  raw.exec("UPDATE users SET admin_scope = 'full' WHERE id = 'u_c'");
  assert.deepEqual(scopeOf(raw, 'u_c'), { role: 'admin', admin_scope: 'full' });
  // Nor does re-writing the same role.
  raw.exec("UPDATE users SET role = 'admin' WHERE id = 'u_c'");
  assert.deepEqual(scopeOf(raw, 'u_c'), { role: 'admin', admin_scope: 'full' });
});

function grants(raw: DatabaseSync) {
  raw.exec(`INSERT INTO admin_private_grants (id,user_id,grant_key,granted_by,operation_id) VALUES
    ('apg_r','usr_full','PRICING_PRIVATE_READ','usr_owner','op-grant-read'),
    ('apg_w','usr_full','PRICING_PRIVATE_WRITE','usr_owner','op-grant-write');`);
}

test('a demotion revokes every live grant, whoever writes it', async () => {
  const raw = seeded();
  grants(raw);
  const res = await patch(app(raw, OWNER), '/api/admin/users/usr_full', { role: 'customer' });
  assert.equal(res.status, 200);
  const rows = all<{ revoked_at: string | null; revoked_by: string | null; revoke_reason: string }>(
    raw,
    'SELECT revoked_at, revoked_by, revoke_reason FROM admin_private_grants ORDER BY id'
  );
  assert.equal(rows.length, 2, 'history is kept, not deleted');
  for (const r of rows) {
    assert.ok(r.revoked_at);
    assert.equal(r.revoked_by, 'system:role_change');
    assert.equal(r.revoke_reason, 'role_change');
  }
});

test('the grant table is append-only and revoke-once', () => {
  const raw = seeded();
  grants(raw);
  assert.throws(() => raw.exec("DELETE FROM admin_private_grants WHERE id = 'apg_r'"), /append-only/);
  assert.throws(() => raw.exec("UPDATE admin_private_grants SET grant_key = 'PRICING_PRIVATE_WRITE' WHERE id = 'apg_r'"), /revoked, once/);
  assert.throws(() => raw.exec("UPDATE admin_private_grants SET reason = 'edited' WHERE id = 'apg_r'"), /revoked, once/);
  raw.exec("UPDATE admin_private_grants SET revoked_at = '2026-10-07T00:00:00Z', revoked_by = 'usr_owner' WHERE id = 'apg_r'");
  assert.throws(
    () => raw.exec("UPDATE admin_private_grants SET revoked_at = '2026-10-08T00:00:00Z', revoked_by = 'usr_owner' WHERE id = 'apg_r'"),
    /revoked, once/,
    'a second revoke is refused'
  );
  assert.throws(() => raw.exec("UPDATE admin_private_grants SET revoked_at = NULL, revoked_by = NULL WHERE id = 'apg_r'"), /revoked, once/);
});

test('nobody grants themself; one live grant per key; only the two known keys exist', () => {
  const raw = seeded();
  assert.throws(() =>
    raw.exec("INSERT INTO admin_private_grants (id,user_id,grant_key,granted_by,operation_id) VALUES ('x','usr_owner','PRICING_PRIVATE_READ','usr_owner','op-self-grant')")
  );
  grants(raw);
  assert.throws(() =>
    raw.exec("INSERT INTO admin_private_grants (id,user_id,grant_key,granted_by,operation_id) VALUES ('y','usr_full','PRICING_PRIVATE_READ','usr_owner','op-second-read')")
  );
  assert.throws(() =>
    raw.exec("INSERT INTO admin_private_grants (id,user_id,grant_key,granted_by,operation_id) VALUES ('z','usr_full','FINANCE_ALL','usr_owner','op-unknown-key')")
  );
});
