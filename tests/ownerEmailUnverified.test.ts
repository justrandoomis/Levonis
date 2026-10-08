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
 *     request (`SELECT u.* … JOIN users`), so the session that confirms the
 *     emailed link (POST /api/auth/verify-email/confirm) sees cost on the very
 *     next request — the same cookie, no new sign-in, no redeploy. A sign-in
 *     with Google that proves the address opens a session of its own, and that
 *     one sees cost; the sessions opened BEFORE that first proof end with it
 *     (review finding C1, worker/lib/emailStamp.ts, tests/ownerFirstProof.test.ts).
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
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { toEditorDoc } from '../src/components/adminProducts/types';
import { hydrateRelations, relationsToWire } from '../src/components/adminProducts/form/model';
import { COST } from './fixtures/costlyProduct';
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
  a.route('/api/admin/products', adminProductRelationsRoutes);
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

const EXECUTION = { waitUntil() {}, passThroughOnException() {} } as never;

async function call(a: ReturnType<typeof app>, cookie: string, method: string, path: string, body?: unknown) {
  const res = await a.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        'CF-Connecting-IP': '1.2.3.4',
        ...(body !== undefined ? { 'content-type': 'application/json', origin: ORIGIN } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    undefined,
    EXECUTION
  );
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

/** A live verification token for `userId` (optionally an email-change token). */
async function tokenFor(raw: DatabaseSync, userId: string, token: string, newEmail: string | null = null) {
  raw
    .prepare('INSERT INTO email_verification_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, ?, ?, ?)')
    .run(await sha256Hex(token), userId, newEmail, new Date(Date.now() + 3_600_000).toISOString());
}
const tokenUsed = async (raw: DatabaseSync, token: string) =>
  row<{ used: number }>(raw, 'SELECT used FROM email_verification_tokens WHERE token_hash = ?', await sha256Hex(token))?.used;

test('the email link: the SAME session sees cost on the next request after POST /verify-email/confirm — no new sign-in, no redeploy', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  await assertShut(a, cookie);

  // The existing flow: the emailed link carries a one-use token; the button
  // POSTs it — for the owner's address, from the owner's own session.
  const token = 'verify-token-for-the-owner-0123456789abcdef';
  await tokenFor(raw, 'usr_owner', token);
  const confirmed = await call(a, cookie, 'POST', '/api/auth/verify-email/confirm', { token });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.ok(row<{ email_verified_at: string | null }>(raw, 'SELECT email_verified_at FROM users WHERE id = ?', 'usr_owner')?.email_verified_at);

  await assertOpen(a, cookie);
});

test('Google: a sign-in with the already-connected Google stamps the address, and the session it opens sees cost', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET google_sub = 'google-owner-sub' WHERE id = 'usr_owner'");
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  await assertShut(a, cookie);

  // worker/routes/auth.ts: Google's verified identity stamps THIS account's matching address.
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  await resolveGoogleIdentity(env, { sub: 'google-owner-sub', email: OWNER_EMAIL, name: 'Owner' });

  // The session opened before the first proof ended with it (review finding C1);
  // POST /google opens the sign-in's own session right after, and that one sees cost.
  assert.equal(await me(a, cookie), null, 'the older session ended');
  await assertOpen(a, await sessionFor(raw, 'usr_owner'));
});

test('Google never merges into an unverified, unconnected account — the stamp comes from the email link or from a Google already connected', async () => {
  const raw = seededCopyUnverifiedOwner();
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  await assert.rejects(
    resolveGoogleIdentity(env, { sub: 'someone-elses-google', email: OWNER_EMAIL, name: 'Owner?' }),
    (e: unknown) => e instanceof HttpError && e.code === 'EMAIL_NOT_VERIFIED'
  );
  assert.equal(row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', 'usr_owner')?.v, null);
  // …which is why the refusal offers Google only when it is ALREADY connected,
  // and never a "connect Google in your settings" control that does not exist.
  assert.match(serverMessage('OWNER_EMAIL_UNVERIFIED'), /sign in with Google if Google is already connected to the same address/);
  assert.doesNotMatch(serverMessage('OWNER_EMAIL_UNVERIFIED'), /settings|إعدادات/i);
  // The link route stamps only the SAME address Google proved.
  const link = codeOf('worker/routes/auth.ts').slice(codeOf('worker/routes/auth.ts').indexOf("authRoutes.post('/google/link'"));
  assert.match(link.slice(0, 4000), /UPDATE users SET email_verified_at = \$\{STAMP_ONCE\} WHERE id = \? AND email = \?/);
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

// ---------------------------------------------------------------------------
// Review of the amendment (2026-10-08): the link for the owner's address is
// confirmed only from that account's own session.

test('the owner’s link is confirmed only from the owner’s own session — no session, or another account’s, is told to sign in and the link stays unused', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const token = 'owner-link-needs-its-session-0123456789';
  await tokenFor(raw, 'usr_owner', token);
  const expected = JSON.stringify({ success: false, error: serverMessage('VERIFY_SIGN_IN_REQUIRED'), code: 'VERIFY_SIGN_IN_REQUIRED' });

  for (const cookie of ['', await sessionFor(raw, 'usr_full'), await sessionFor(raw, 'u1')]) {
    const r = await call(a, cookie, 'POST', '/api/auth/verify-email/confirm', { token });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.text, expected);
    assert.equal(await tokenUsed(raw, token), 0, 'the link is not spent by a refused press');
    assert.equal(row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', 'usr_owner')?.v, null);
  }
  // A bad token still hears the generic answer first: the new refusal is said only to a holder of a live link.
  const bad = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'no-such-token-0123456789abcdef' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'BAD_TOKEN');

  // The owner's own session confirms it, and cost opens.
  const owner = await sessionFor(raw, 'usr_owner');
  const ok = await call(a, owner, 'POST', '/api/auth/verify-email/confirm', { token });
  assert.equal(ok.status, 200, ok.text);
  await assertOpen(a, owner);
});

test('a row that took the owner’s address while it was free cannot be verified by the real owner pressing the link — nor can a row moved onto it', async () => {
  const raw = seededCopyUnverifiedOwner();
  // The A10 case: the owner's row no longer holds the address; another admin row does, unverified.
  raw.exec(`
    UPDATE users SET email = 'owner-moved@x.co', email_verified_at = '2026-01-01T00:00:00.000Z' WHERE id = 'usr_owner';
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_squat','Squatter','boss@x.co','h','admin',NULL);
  `);
  const a = app(raw);
  const squatLink = 'squatter-asked-owner-mailbox-0123456789';
  await tokenFor(raw, 'usr_squat', squatLink);
  // The real owner, signed in to their own account (or to none), opens the mail and presses confirm.
  for (const cookie of ['', await sessionFor(raw, 'usr_owner')]) {
    const r = await call(a, cookie, 'POST', '/api/auth/verify-email/confirm', { token: squatLink });
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'VERIFY_SIGN_IN_REQUIRED');
  }
  assert.equal(row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', 'usr_squat')?.v, null);
  const squatter = await sessionFor(raw, 'usr_squat');
  assert.equal((await me(a, squatter)).can_view_cost, false, 'the squatting row never opens cost');

  // An email change moving another row ONTO the owner's address: the same rule.
  const moveLink = 'move-onto-owner-address-0123456789ab';
  raw.exec("DELETE FROM users WHERE id = 'usr_squat'");
  await tokenFor(raw, 'usr_full', moveLink, 'boss@x.co');
  const moved = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: moveLink });
  assert.equal(moved.status, 403);
  assert.equal(moved.json.code, 'VERIFY_SIGN_IN_REQUIRED');
  assert.equal(row<{ e: string }>(raw, 'SELECT email AS e FROM users WHERE id = ?', 'usr_full')?.e, 'full@x.co');
  assert.equal(await tokenUsed(raw, moveLink), 0);
});

test('every other address keeps the one-tap link with no session (the rule is the owner’s address only)', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'u1'");
  const a = app(raw);
  const token = 'customer-plain-verify-0123456789abcd';
  await tokenFor(raw, 'u1', token);
  const r = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token });
  assert.equal(r.status, 200, r.text);
  assert.ok(row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', 'u1')?.v);
});

// ---------------------------------------------------------------------------
// A blank stamp is no stamp — for the cost rule AND for every way out.

for (const blank of ['', '   ']) {
  test(`a blank stamp (${JSON.stringify(blank)}) is unverified everywhere, and the link replaces it`, async () => {
    const raw = seededCopyUnverifiedOwner();
    raw.prepare("UPDATE users SET email_verified_at = ? WHERE id = 'usr_owner'").run(blank);
    const a = app(raw);
    const cookie = await sessionFor(raw, 'usr_owner');
    await assertShut(a, cookie);
    // The status route and the send route agree with the cost rule.
    const status = await call(a, cookie, 'GET', '/api/auth/verify-email/status');
    assert.equal(status.json.verified, false, 'status does not call a blank stamp verified');
    const token = `blank-stamp-link-${blank.length}-0123456789abcdef`;
    await tokenFor(raw, 'usr_owner', token);
    const confirmed = await call(a, cookie, 'POST', '/api/auth/verify-email/confirm', { token });
    assert.equal(confirmed.status, 200, confirmed.text);
    const stamp = row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', 'usr_owner')?.v;
    assert.ok(stamp && stamp.trim() !== '', `the blank was replaced (got ${JSON.stringify(stamp)})`);
    await assertOpen(a, cookie);
  });

  test(`a blank stamp (${JSON.stringify(blank)}) is replaced by a sign-in with the already-connected Google`, async () => {
    const raw = seededCopyUnverifiedOwner();
    raw.prepare("UPDATE users SET email_verified_at = ?, google_sub = 'google-owner-sub' WHERE id = 'usr_owner'").run(blank);
    const a = app(raw);
    const cookie = await sessionFor(raw, 'usr_owner');
    await assertShut(a, cookie);
    const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
    await resolveGoogleIdentity(env, { sub: 'google-owner-sub', email: OWNER_EMAIL, name: 'Owner' });
    // A blank stamp is no stamp, so this is the first proof: the older session
    // ends, and the session the sign-in opens sees cost.
    assert.equal(await me(a, cookie), null, 'the older session ended');
    await assertOpen(a, await sessionFor(raw, 'usr_owner'));
  });
}

test('the send route does not answer "verified" for a whitespace stamp (it would leave the card with nothing to do)', () => {
  const src = codeOf('worker/routes/auth.ts');
  const send = src.slice(src.indexOf("authRoutes.post('/verify-email/send'"), src.indexOf("authRoutes.post('/verify-email/confirm'"));
  assert.match(send, /if \(isStamped\(row\.email_verified_at\)\) return c\.json\(\{ success: true, verified: true \}\);/);
  const otp = src.slice(src.indexOf("authRoutes.post('/otp/verify'"));
  assert.match(otp, /AND \(email_verified_at IS NULL OR trim\(email_verified_at\) = ''\)/);
  // No writer is left that keeps a blank: every stamp goes through STAMP_ONCE or sets a fresh value.
  assert.doesNotMatch(src, /COALESCE\(email_verified_at, \?\)/);
});

// ---------------------------------------------------------------------------
// The product form read without cost, saved after the owner verified.

const productCosts = (raw: DatabaseSync) => ({
  product: row<{ c: number | null }>(raw, "SELECT product_cost_iqd AS c FROM products WHERE id = 'p_a1'")?.c,
  option: row<{ c: number | null }>(raw, "SELECT cost_iqd AS c FROM product_option_values WHERE id = 'v_a1'")?.c,
  color: row<{ c: number | null }>(raw, "SELECT cost_iqd AS c FROM product_colors WHERE id = 'c_blk'")?.c,
  preorderCell: row<{ c: number | null }>(raw, "SELECT cost_iqd AS c FROM product_option_fulfillment WHERE option_id = 'v_a1' AND fulfillment_type = 'pre_order'")?.c,
  route: row<{ c: number | null }>(raw, "SELECT t.cost_iqd AS c FROM product_option_transports t JOIN product_option_fulfillment f ON f.id = t.fulfillment_id WHERE f.option_id = 'v_a1' AND t.method = 'air'")?.c,
});

/** What the product form holds after reading p_a1 with this session, as it would post it back. */
async function formBodyFor(a: ReturnType<typeof app>, cookie: string, raw: DatabaseSync) {
  // A direct-sale model needs a stock figure to save at all (a rule of the form, not of cost).
  raw.exec("UPDATE product_option_values SET stock = 2 WHERE id = 'v_a1'");
  const got = await call(a, cookie, 'GET', '/api/admin/products-v2/p_a1');
  assert.equal(got.status, 200, got.text.slice(0, 300));
  const rel = await call(a, cookie, 'GET', '/api/admin/products/p_a1/relations');
  assert.equal(rel.status, 200, rel.text.slice(0, 300));
  const product = got.json.product as Record<string, unknown>;
  const doc = toEditorDoc(product as never) as unknown as Record<string, unknown>;
  const { options: _o, colors: _c, media: _m, ...docFields } = doc;
  void _o; void _c; void _m;
  const relations = relationsToWire(hydrateRelations(rel.json as never, product as never));
  return { product, body: { ...docFields, relations } as Record<string, unknown> };
}

test('a form read while unverified and saved after verifying keeps EVERY stored cost (cost_loaded: false)', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const before = productCosts(raw);
  assert.deepEqual(before, { product: COST.product, option: COST.option, color: COST.color, preorderCell: COST.cell, route: COST.route });

  const { product, body } = await formBodyFor(a, cookie, raw);
  assert.equal('product_cost_iqd' in product, false, 'read without cost');
  // The owner verifies in another tab; the same form, now cost-capable, saves.
  raw.exec("UPDATE users SET email_verified_at = '2026-10-08T00:00:00.000Z' WHERE id = 'usr_owner'");
  assert.equal((await me(a, cookie)).can_write_cost, true);
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', { ...body, cost_loaded: false });
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assert.deepEqual(productCosts(raw), before, 'nothing the form never showed was written');
  // The read-back carries the cost, so the form now shows it.
  assert.equal(((save.json.product as Record<string, unknown>) ?? {}).product_cost_iqd, COST.product);
});

test('a form that DID read the cost still clears it with an explicit blank — the flag is what tells the two apart', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email_verified_at = '2026-10-08T00:00:00.000Z' WHERE id = 'usr_owner'");
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const { product, body } = await formBodyFor(a, cookie, raw);
  assert.equal(product.product_cost_iqd, COST.product, 'read with cost');
  const save = await call(a, cookie, 'POST', '/api/admin/products-v2', { ...body, product_cost_iqd: null });
  assert.equal(save.status, 200, save.text.slice(0, 400));
  assert.equal(productCosts(raw).product, null, 'the owner blanked it on purpose');
});

test('the quick panel’s fulfilment save read without cost keeps the order-type and route costs (cost_loaded: false)', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const cookie = await sessionFor(raw, 'usr_owner');
  const grid = await call(a, cookie, 'GET', '/api/admin/products/p_a1/price-grid');
  assert.equal(grid.status, 200, grid.text.slice(0, 300));
  assert.equal(grid.json.can_view_cost, false, 'the panel read the product without cost');
  raw.exec("UPDATE users SET email_verified_at = '2026-10-08T00:00:00.000Z' WHERE id = 'usr_owner'");
  // As the panel sends them: the cells it read, their stripped costs as explicit blanks.
  const fulfillments = [
    {
      option_id: 'v_a1',
      fulfillment_type: 'pre_order',
      enabled: true,
      sort: 0,
      capacity: 5,
      cost_iqd: null,
      cost_adjust_iqd: null,
      transports: [{ method: 'air', enabled: true, sort: 0, surcharge_iqd: 25000, capacity: 3, cost_iqd: null, cost_adjust_iqd: null }],
    },
  ];
  const put = await call(a, cookie, 'PUT', '/api/admin/products/p_a1/fulfillment', { fulfillments, cost_loaded: false });
  assert.equal(put.status, 200, put.text.slice(0, 400));
  const after = productCosts(raw);
  assert.equal(after.preorderCell, COST.cell);
  assert.equal(after.route, COST.route);
});
