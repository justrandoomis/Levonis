/**
 * THE OWNER BEFORE THE ADDRESS IS VERIFIED — DECISIONS row 185, amendment of
 * 2026-10-08. Asked how S1 should treat the owner's email verification, the
 * owner answered «The best one for security».
 *
 * So the rule stays: cost is honoured only for the INITIAL_ADMIN_EMAIL admin
 * row whose address is VERIFIED. What changed is that this is no longer a
 * lockout without a way out, and that the deploy no longer reads `users`:
 *
 *   - the owner's own session, unverified, is refused every cost surface with
 *     OWNER_EMAIL_UNVERIFIED (not the generic COST_ACCESS_DENIED) and carries
 *     the `owner_email_unverified` hint, and receives no cost value anywhere;
 *   - the session loader reads `email_verified_at` from `users` on every
 *     request (`SELECT u.* … JOIN users`), so the SAME session — the same
 *     cookie, no new sign-in, no redeploy — sees cost on the very next request
 *     after the stamp, whether the stamp comes from the email link
 *     (POST /api/auth/verify-email/confirm) or from Google.
 *
 * This file drives the real session loader, the real auth routes and the real
 * cost routers over one database; tests/costRouteClassification.test.ts and
 * tests/costRoleMatrix*.test.ts sweep every cost route for the same session.
 *
 * Run: node --import tsx --test tests/ownerEmailUnverified.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { loadSessionUser } from '../worker/lib/session';
import { sha256Hex } from '../worker/lib/crypto';
import { authRoutes, resolveGoogleIdentity } from '../worker/routes/auth';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminInventoryRoutes } from '../worker/routes/adminInventory';
import { asD1, row } from './fixtures/app';
import { leaks, seededCopyUnverifiedOwner } from './fixtures/roleMatrix';
import { codeOf } from './fixtures/source';
import { serverMessage } from '../packages/contracts/src/costRefusals';

const ORIGIN = 'https://levonis-iq.com';
const OWNER_EMAIL = 'boss@x.co';

/** worker/index.ts's order for what these routes need: env, host, the REAL session loader, the apex guard. */
function app(raw: DatabaseSync) {
  const d1 = asD1(raw);
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, INITIAL_ADMIN_EMAIL: OWNER_EMAIL, APP_ORIGIN: ORIGIN, EXTRA_ALLOWED_ORIGINS: '' } as unknown as Env;
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
    await loadSessionUser(c);
    await next();
  });
  a.use('/api/admin/*', requireMainHost);
  a.route('/api/auth', authRoutes);
  a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes);
  a.route('/api/admin/products-v2', adminProductsRoutes);
  a.route('/api/admin/products', adminPriceGridRoutes);
  a.route('/api/admin/inventory', adminInventoryRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) }, err.status as 400);
    }
    return c.json({ success: false, error: String(err) }, 500);
  });
  return a;
}

/** A live session row for `userId`, and the cookie that names it. */
async function sessionFor(raw: DatabaseSync, userId: string): Promise<string> {
  const token = `test-session-${userId}-${Math.random().toString(36).slice(2)}`;
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(await sha256Hex(token), userId, expires, 'test');
  return `levonis_session=${token}`;
}

async function call(a: ReturnType<typeof app>, cookie: string, method: string, path: string, body?: unknown) {
  const res = await a.request(`${ORIGIN}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      'CF-Connecting-IP': '1.2.3.4',
      ...(body !== undefined ? { 'content-type': 'application/json', origin: ORIGIN } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* a non-JSON answer stays empty */
  }
  return { status: res.status, text, json };
}

const me = async (a: ReturnType<typeof app>, cookie: string) =>
  (await call(a, cookie, 'GET', '/api/auth/me')).json.user as Record<string, unknown>;

/** The cost surfaces this file walks: a finance door, the price history, the profit preview, the product document. */
const COST_GETS = [
  '/api/admin/finance-workspace/summary',
  '/api/admin/products/p_a1/price-history',
  '/api/admin/inventory/incoming/inc1/profit-preview',
];

async function assertShut(a: ReturnType<typeof app>, cookie: string) {
  const user = await me(a, cookie);
  assert.equal(user.is_owner, true);
  assert.equal(user.can_view_cost, false);
  assert.equal(user.can_write_cost, false);
  assert.equal(user.owner_email_unverified, true, 'the session carries the way out');
  for (const path of COST_GETS) {
    const r = await call(a, cookie, 'GET', path);
    assert.equal(r.status, 403, path);
    assert.equal(r.json.code, 'OWNER_EMAIL_UNVERIFIED', path);
    assert.equal(r.json.error, serverMessage('OWNER_EMAIL_UNVERIFIED'));
    assert.deepEqual(leaks(r.json), [], `${path}: no cost in the refusal`);
  }
  // The product document is served (catalogue work goes on) with every cost removed.
  const doc = await call(a, cookie, 'GET', '/api/admin/products-v2/p_a1');
  assert.equal(doc.status, 200);
  assert.deepEqual(leaks(doc.json), [], 'the unverified owner reads the product without a cost');
  // A write that carries a cost is refused with the way out, by field NAME only.
  const save = await call(a, cookie, 'POST', '/api/admin/products/p_a1/price-grid/cost-change', { new_cost_iqd: 700_000 });
  assert.equal(save.status, 403);
  assert.equal(save.json.code, 'OWNER_EMAIL_UNVERIFIED');
  assert.deepEqual(leaks(save.json), []);
}

async function assertOpen(a: ReturnType<typeof app>, cookie: string) {
  const user = await me(a, cookie);
  assert.equal(user.can_view_cost, true, 'cost opens on the next request after the stamp');
  assert.equal(user.can_write_cost, true);
  assert.equal(user.owner_email_unverified, false, 'and the prompt is gone');
  const summary = await call(a, cookie, 'GET', '/api/admin/finance-workspace/summary');
  assert.equal(summary.status, 200, summary.text.slice(0, 200));
  const history = await call(a, cookie, 'GET', '/api/admin/products/p_a1/price-history');
  assert.equal(history.status, 200);
  const doc = await call(a, cookie, 'GET', '/api/admin/products-v2/p_a1');
  assert.notDeepEqual(leaks(doc.json), [], 'the owner now reads the seeded cost on the product document');
}

test('the email link: the SAME session sees cost on the next request after POST /verify-email/confirm — no new sign-in, no redeploy', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  await assertShut(a, cookie);

  // The existing flow: the emailed link carries a one-use token; the button POSTs it.
  const token = 'verify-token-for-the-owner-0123456789abcdef';
  raw
    .prepare('INSERT INTO email_verification_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, ?, NULL, ?)')
    .run(await sha256Hex(token), 'usr_owner', new Date(Date.now() + 3_600_000).toISOString());
  const confirmed = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.ok(row<{ email_verified_at: string | null }>(raw, 'SELECT email_verified_at FROM users WHERE id = ?', 'usr_owner')?.email_verified_at);

  await assertOpen(a, cookie);
});

test('Google: a sign-in with the already-connected Google stamps the address, and the same session then sees cost', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET google_sub = 'google-owner-sub' WHERE id = 'usr_owner'");
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  await assertShut(a, cookie);

  // worker/routes/auth.ts: Google's verified identity stamps THIS account's matching address.
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  await resolveGoogleIdentity(env, { sub: 'google-owner-sub', email: OWNER_EMAIL, name: 'Owner' });

  await assertOpen(a, cookie);
});

test('Google never merges into an unverified, unconnected account — the stamp comes from the email or from connecting Google while signed in', async () => {
  const raw = seededCopyUnverifiedOwner();
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  await assert.rejects(
    resolveGoogleIdentity(env, { sub: 'someone-elses-google', email: OWNER_EMAIL, name: 'Owner?' }),
    (e: unknown) => e instanceof HttpError && e.code === 'EMAIL_NOT_VERIFIED'
  );
  assert.equal(row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', 'usr_owner')?.v, null);
  // …which is why the refusal and the card name "connect Google in your account settings".
  assert.match(serverMessage('OWNER_EMAIL_UNVERIFIED'), /connect Google/);
  // The link route stamps only the SAME address Google proved.
  const link = codeOf('worker/routes/auth.ts').slice(codeOf('worker/routes/auth.ts').indexOf("authRoutes.post('/google/link'"));
  assert.match(link.slice(0, 4000), /UPDATE users SET email_verified_at = COALESCE\(email_verified_at, \?\) WHERE id = \? AND email = \?/);
});

test('the session loader reads the stamp fresh on every request (no cached user row)', () => {
  const src = codeOf('worker/lib/session.ts');
  const fn = src.slice(src.indexOf('export async function loadSessionUser'), src.indexOf('export const FRESH_SESSION_SECONDS'));
  assert.match(fn, /SELECT u\.\*, s\.id AS session_id[\s\S]*FROM sessions s JOIN users u ON u\.id = s\.user_id/);
  assert.doesNotMatch(fn, /caches\.|\bKV\b|Map<|memo/i, 'no cache stands between the users row and the session');
});

test('every other session keeps the exact COST_ACCESS_DENIED and never the hint — a full admin, an assistant, a lookalike-address admin, a customer', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec(`
    UPDATE users SET email_verified_at = NULL WHERE id IN ('usr_full','usr_asst');
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_lookalike','Lookalike','boss@x.co.evil','h','admin',NULL);
  `);
  const a = app(raw);
  const expected = JSON.stringify({ success: false, error: serverMessage('COST_ACCESS_DENIED'), code: 'COST_ACCESS_DENIED' });
  for (const id of ['usr_full', 'usr_asst', 'usr_lookalike']) {
    const cookie = await sessionFor(raw, id);
    const user = await me(a, cookie);
    assert.equal(user.owner_email_unverified, false, id);
    assert.equal(user.can_view_cost, false, id);
    for (const path of ['/api/admin/finance-workspace/summary', '/api/admin/products/p_a1/price-history', '/api/admin/products/zz-no-such/price-history']) {
      const r = await call(a, cookie, 'GET', path);
      assert.equal(r.text, expected, `${id} ${path}: the generic answer, byte for byte, for a real and an invented target`);
    }
  }
  // A customer row cannot even reach a cost door (requireAdmin) and gets no hint.
  const custCookie = await sessionFor(raw, 'u1');
  assert.equal((await me(a, custCookie)).owner_email_unverified, false);
  const r = await call(a, custCookie, 'GET', '/api/admin/finance-workspace/summary');
  assert.notEqual(r.json.code, 'OWNER_EMAIL_UNVERIFIED');
});
