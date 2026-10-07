/**
 * THE OWNER'S ADDRESS IS THE OWNER — owner decision 2, security spec §2.5 and
 * §5.2 item 3, step S1.
 *
 * Every cost predicate recognises the owner by INITIAL_ADMIN_EMAIL. Moving the
 * owner account to another address would lock the owner out of every cost
 * screen (and, if the old address were then registered by someone else and
 * verified, hand it over). So the account page refuses the owner's change
 * (`OWNER_EMAIL_LOCKED`) before the body is read, and a change requested
 * before the lock existed cannot be confirmed either. Customers are unaffected.
 *
 * And §31 mass assignment: the profile PATCH ignores every privilege field a
 * caller appends — role, scope, investor status, grants.
 *
 * Run: node --import tsx --test tests/ownerEmailLock.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, asD1, freshDb, json, patch, post, row, stubApp, type StubUser } from './fixtures/app';
import { authRoutes } from '../worker/routes/auth';
import { profileRoutes } from '../worker/routes/profile';
import { sha256Hex } from '../worker/lib/crypto';

const CUSTOMER: StubUser = { id: 'u_c', role: 'customer', email: 'c@x.co' };

function seeded() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope,is_investor,email_verified_at) VALUES
      ('usr_owner','Owner','boss@x.co','h','admin',NULL,0,'2026-01-01T00:00:00.000Z'),
      ('u_c','Customer','c@x.co','h','customer',NULL,0,'2026-01-01T00:00:00.000Z');
  `);
  return raw;
}
const auth = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, (a) => a.route('/api/auth', authRoutes));

test('the owner cannot change the account email: 403 OWNER_EMAIL_LOCKED, nothing issued, nothing changed', async () => {
  const raw = seeded();
  const res = await post(auth(raw, OWNER), '/api/auth/change-email', { newEmail: 'new-owner@x.co', currentPassword: 'x' });
  assert.equal(res.status, 403);
  const body = await json(res);
  assert.equal(body.code, 'OWNER_EMAIL_LOCKED');
  assert.match(body.error, / \/ /, 'ar / en');
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM email_verification_tokens')!.n, 0);
  assert.equal(row<{ email: string }>(raw, "SELECT email FROM users WHERE id = 'usr_owner'")!.email, 'boss@x.co');
});

test('the lock is the ADDRESS, case-blind: an owner session with a mixed-case address is locked too', async () => {
  const raw = seeded();
  const res = await post(auth(raw, { ...OWNER, email: 'Boss@X.co' }), '/api/auth/change-email', { newEmail: 'n@x.co' });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'OWNER_EMAIL_LOCKED');
});

test('a customer is not affected by the lock (the request goes on to its own checks)', async () => {
  const raw = seeded();
  const res = await post(auth(raw, CUSTOMER), '/api/auth/change-email', { newEmail: 'c2@x.co', currentPassword: 'x' });
  assert.notEqual((await json(res)).code, 'OWNER_EMAIL_LOCKED');
  assert.notEqual(res.status, 403);
});

test('a change token issued for the owner before the lock existed cannot be confirmed', async () => {
  const raw = seeded();
  const token = 'owner-change-token-0123456789abcdef';
  raw
    .prepare('INSERT INTO email_verification_tokens (token_hash,user_id,new_email,expires_at,used) VALUES (?,?,?,?,0)')
    .run(await sha256Hex(token), 'usr_owner', 'taken-over@x.co', new Date(Date.now() + 3600_000).toISOString());
  const res = await post(stubApp(asD1(raw), null, (a) => a.route('/api/auth', authRoutes)), '/api/auth/verify-email/confirm', { token });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'OWNER_EMAIL_LOCKED');
  assert.equal(row<{ email: string }>(raw, "SELECT email FROM users WHERE id = 'usr_owner'")!.email, 'boss@x.co');
  assert.equal(row<{ used: number }>(raw, 'SELECT used FROM email_verification_tokens')!.used, 0, 'the token is not consumed');
});

test('a customer’s email-change token still confirms', async () => {
  const raw = seeded();
  const token = 'customer-change-token-0123456789abcdef';
  raw
    .prepare('INSERT INTO email_verification_tokens (token_hash,user_id,new_email,expires_at,used) VALUES (?,?,?,?,0)')
    .run(await sha256Hex(token), 'u_c', 'c-new@x.co', new Date(Date.now() + 3600_000).toISOString());
  const res = await post(stubApp(asD1(raw), null, (a) => a.route('/api/auth', authRoutes)), '/api/auth/verify-email/confirm', { token });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.equal(row<{ email: string }>(raw, "SELECT email FROM users WHERE id = 'u_c'")!.email, 'c-new@x.co');
});

test('§31 mass assignment: the profile PATCH ignores role, scope, investor status and grants', async () => {
  const raw = seeded();
  // The session user as the loader builds it: the whole row, minus the hash.
  const { password_hash: _hash, ...sessionRow } = row<Record<string, unknown>>(raw, "SELECT * FROM users WHERE id = 'u_c'")!;
  void _hash;
  const app = stubApp(asD1(raw), sessionRow as unknown as StubUser, (a) => a.route('/api/profile', profileRoutes));
  const before = row(raw, "SELECT role, admin_scope, is_investor, email FROM users WHERE id = 'u_c'");
  const res = await patch(app, '/api/profile', {
    name: 'Customer',
    role: 'admin',
    admin_scope: 'full',
    is_investor: true,
    email: 'boss@x.co',
    email_verified_at: '2026-01-01T00:00:00.000Z',
    private_grants: ['PRICING_PRIVATE_READ', 'PRICING_PRIVATE_WRITE'],
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  assert.deepEqual(row(raw, "SELECT role, admin_scope, is_investor, email FROM users WHERE id = 'u_c'"), before);
  assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM admin_private_grants')!.n, 0);
  const user = (await json(res)).user as Record<string, unknown> | undefined;
  if (user) {
    assert.equal(user.role, 'customer');
    assert.equal(user.can_view_cost, false);
    assert.equal(user.is_owner, false);
  }
});
