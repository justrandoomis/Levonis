/**
 * «يظهر في الربط أن جوجل غير مرتبط بالرغم في الأمان يوضح أن البريد مرتبط».
 *
 * The owner read the two badges as a contradiction, and they were half right.
 * A verified email and a linked Google identity are genuinely DIFFERENT facts —
 * an address can be verified through the emailed link with no Google identity
 * anywhere — so the page is right to draw them separately. But «غير مرتبط» was
 * not an answer about their account: it was the only answer the server could
 * give about ANY account.
 *
 * THE MECHANISM. `publicUser()` derives `has_google: !!u.google_sub`, and
 * `loadSessionUser` deleted `google_sub` from the object it puts on the request
 * context. The destructure was written as password-hash hygiene in the first
 * worker commit, years before anything reported a Google link; `has_google` was
 * added later and built on a column production had already removed.
 *
 * So the fact had two answers. Every route that RE-READS the row — login,
 * /auth/google, /auth/google/link, PATCH /profile — ran `SELECT *` and answered
 * correctly. `GET /api/auth/me` serialises the SESSION user and answered false
 * for everyone. And `/auth/me` is the only one the Settings page sees after a
 * page load, so the badge could never read «مرتبط».
 *
 * WHY NOTHING CAUGHT IT. The one existing assertion on this field runs against
 * a harness that stubs the context user with a RAW ROW, so `google_sub` is
 * present in the test exactly where production had dropped it. These tests
 * therefore mount the REAL `loadSessionUser` in front of the REAL routes, the
 * way worker/index.ts does — the middleware IS the defect, so a test that
 * skips it proves nothing.
 *
 * Run: npx tsx --test tests/googleLinkSurvivesSession.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { authRoutes } from '../worker/routes/auth';
import { loadSessionUser } from '../worker/lib/session';
// @ts-expect-error - plain ESM helper shared with workflow 15, no types
import { hashPasswordLikeWorker, identitySql, newUserId, randomUsername } from '../scripts/live-auth-identity.mjs';

const PW = 'Lv-c0rrect-h0rse-e2e';
const ORIGIN = 'https://levonis-iq.com';

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return { raw, d1: new SqliteD1(raw) as unknown as D1Database };
}

/** The real auth routes behind the real session loader, as worker/index.ts mounts them. */
function app(d1: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, APP_ORIGIN: ORIGIN } as Env;
    await loadSessionUser(c);
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    }
    throw err;
  });
  return a;
}

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function signedIn(linkGoogle: boolean) {
  const { raw, d1 } = db();
  const a = app(d1);
  const email = `owner+google-${linkGoogle ? 'yes' : 'no'}@example.com`;
  const id = newUserId();
  raw.exec(identitySql({ id, email, username: randomUsername(), passwordHash: await hashPasswordLikeWorker(PW) }));
  if (linkGoogle) {
    raw.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run('google-subject-1234567890', id);
  }
  const login = await a.request(`${ORIGIN}/api/auth/login`, json({ identifier: email, password: PW }));
  assert.equal(login.status, 200, 'the seeded identity signs in');
  const cookie = /levonis_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(cookie, 'a session cookie is set');
  return { a, raw, id, cookie: cookie as string, login };
}

test('a linked Google identity survives the session loader — GET /api/auth/me says so', async () => {
  const { a, cookie, login } = await signedIn(true);

  // The route that RE-READS the row was always right. It is asserted first so
  // a failure below can only be the session path.
  const loginBody = (await login.json()) as { user?: { has_google?: boolean } };
  assert.equal(loginBody.user?.has_google, true, 'login reads the row and sees the link');

  // THE DEFECT. Same account, same request, one page load later.
  const me = await a.request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `levonis_session=${cookie}` } });
  assert.equal(me.status, 200);
  const body = (await me.json()) as { user?: { has_google?: boolean } };
  assert.equal(
    body.user?.has_google,
    true,
    'the badge on /settings reads THIS, and it answered false for every account that has ever existed'
  );
});

test('an account with no Google identity still reads false, from the same route', async () => {
  const { a, cookie } = await signedIn(false);
  const me = await a.request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `levonis_session=${cookie}` } });
  const body = (await me.json()) as { user?: { has_google?: boolean } };
  assert.equal(body.user?.has_google, false, 'the fix must not turn the flag into "always true"');
});

/**
 * THE FIX MUST NOT BE "LEAK THE SUBJECT".
 *
 * Keeping `google_sub` on the server-side user is only safe because
 * `publicUser` is the single place a user becomes JSON and it emits the
 * boolean alone. If some later change starts spreading the context user into a
 * response, this is where that is caught — the Google subject is an identifier
 * for a person at Google and has no business leaving the server.
 */
test('and the subject itself never reaches the browser, on either route', async () => {
  const { a, cookie, login } = await signedIn(true);
  for (const [what, res] of [
    ['login', login],
    ['me', await a.request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `levonis_session=${cookie}` } })],
  ] as const) {
    const text = await res.text();
    assert.ok(!text.includes('google-subject-1234567890'), `${what} must not carry the Google subject`);
    assert.ok(!text.includes('google_sub'), `${what} must not carry the field name either`);
    assert.ok(!text.includes('password_hash'), `${what} must not carry the password hash`);
    assert.ok(!text.includes('pbkdf2$'), `${what} must not carry a hash value`);
  }
});

test('the session loader still strips everything it was written to strip', () => {
  const src = readFileSync(join(ROOT, 'worker/lib/session.ts'), 'utf8');
  const line = /const \{ ([^}]*) \} = row;/.exec(src)?.[1] ?? '';
  assert.ok(line.includes('password_hash'), 'the hash is still discarded');
  assert.ok(line.includes('session_id'), 'the session columns are still discarded');
  assert.ok(
    !/\bgoogle_sub\b/.test(line),
    'and google_sub is deliberately NOT — publicUser needs it to answer has_google'
  );
  // The reason is written down where the next reader will look, so nobody
  // "tidies" the column back out and silently restores the bug.
  assert.match(src, /google_sub` STAYS ON THE SERVER-SIDE USER/);
});
