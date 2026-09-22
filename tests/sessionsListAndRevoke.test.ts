/**
 * «بعض الإعدادات لا تعمل مثل تحقق من الجلسات» — AND NOW IT DOES.
 *
 * The settings page carried a row reading «لا يوفّر الخادم واجهة لعرض الجلسات
 * أو إنهائها فرديًا بعد», offering, as the real alternative, CHANGING YOUR
 * PASSWORD. That was honest and it had been true since the first commit —
 * while `sessions` has held one row per sign-in the whole time, carrying
 * `created_at`, `expires_at` and a `user_agent` nothing had ever read. The
 * data to answer «مَن داخل على حسابي؟» was in the table; only the door was
 * missing, and this file is about the door being safe.
 *
 * THE THREE THINGS THAT MATTER, and each is a test below:
 *
 *   1. THE LIST IS THE CALLER'S OWN. A route that answers "here are some
 *      sessions" is worthless if a second account's rows can reach it.
 *   2. THE PUBLISHED ID IS NOT THE STORED ID. `sessions.id` IS
 *      sha256(cookie token) — the value the session lookup matches on. It
 *      cannot be reversed into a usable cookie, but it is the shape of a
 *      credential, and a list of them in a browser is a list an XSS walks away
 *      with. The server publishes sha256 of it instead.
 *   3. REVOKE IS SCOPED BY CONSTRUCTION. The handle is only ever computed over
 *      the caller's own rows, so another account's id matches nothing — and
 *      the route answers 404 rather than confirming a session exists that the
 *      caller may not touch.
 *
 * The real routes run behind the real session loader, the way worker/index.ts
 * mounts them: the authorisation IS the feature, so a harness that stubs the
 * context user would prove nothing.
 *
 * Run: npx tsx --test tests/sessionsListAndRevoke.test.ts
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
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { sha256Hex } from '../worker/lib/crypto';
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

function app(d1: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, APP_ORIGIN: ORIGIN } as Env;
    // The same two lines worker/index.ts runs before any route sees a request.
    // These routes are behind `requireMainHost` — a merchant subdomain must
    // never be able to enumerate or end an account's sessions — so a harness
    // that skips the host classification is testing a different middleware
    // stack from the one that ships.
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
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

type Session = { id: string; created_at: string; expires_at: string; user_agent: string; current: boolean };

/** Sign the same account in from a named device, and keep its cookie. */
async function signIn(a: Hono<AppContext>, email: string, ua: string): Promise<string> {
  const res = await a.request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify({ identifier: email, password: PW }),
  });
  assert.equal(res.status, 200, `${ua} signs in`);
  const cookie = /levonis_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  assert.ok(cookie, 'a session cookie is set');
  return cookie as string;
}

const list = async (a: Hono<AppContext>, cookie: string) => {
  const res = await a.request(`${ORIGIN}/api/auth/sessions`, {
    headers: { Cookie: `levonis_session=${cookie}` },
  });
  return { status: res.status, body: (await res.json()) as { sessions?: Session[] } };
};

async function seed() {
  const { raw, d1 } = db();
  const a = app(d1);
  const mine = 'owner@example.com';
  const theirs = 'stranger@example.com';
  for (const email of [mine, theirs]) {
    raw.exec(
      identitySql({
        id: newUserId(),
        email,
        username: randomUsername(),
        passwordHash: await hashPasswordLikeWorker(PW),
      })
    );
  }
  return { a, raw, mine, theirs };
}

test('the list shows this account’s devices, and nobody else’s', async () => {
  const { a, mine, theirs } = await seed();
  const iPad = await signIn(a, mine, 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/605.1.15');
  const laptop = await signIn(a, mine, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0');
  await signIn(a, theirs, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0');

  const { status, body } = await list(a, iPad);
  assert.equal(status, 200);
  assert.equal(body.sessions?.length, 2, 'two of my devices, and none of the stranger’s');
  assert.ok(
    !body.sessions?.some((s) => /Windows/.test(s.user_agent)),
    'another account’s session reached this list'
  );

  // Exactly one row is THIS device, and it is the cookie that asked.
  assert.equal(body.sessions?.filter((s) => s.current).length, 1);
  const fromLaptop = await list(a, laptop);
  const currentUa = fromLaptop.body.sessions?.find((s) => s.current)?.user_agent ?? '';
  assert.match(currentUa, /Macintosh/, '«هذا الجهاز» follows the cookie that asked');
});

test('the published id is a hash OF the stored id, never the stored id itself', async () => {
  const { a, raw, mine } = await seed();
  const cookie = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const { body } = await list(a, cookie);
  const published = body.sessions?.[0]?.id ?? '';

  const stored = raw.prepare('SELECT id FROM sessions LIMIT 1').get() as { id: string };
  assert.ok(stored?.id, 'the row exists');
  assert.notEqual(published, stored.id, 'the session table’s own key was handed to the browser');
  assert.equal(published, await sha256Hex(stored.id), 'the handle is sha256 of the stored id');
  // And the stored id is itself sha256 of the cookie, so the published handle
  // is two hashes away from anything that could sign a request.
  assert.equal(stored.id, await sha256Hex(cookie), 'the stored id is still the token hash');
});

test('a guest gets nothing', async () => {
  const { a } = await seed();
  const res = await a.request(`${ORIGIN}/api/auth/sessions`);
  assert.equal(res.status, 401, 'an unauthenticated caller must not enumerate sessions');
});

test('ending one device ends that device, and leaves the others signed in', async () => {
  const { a, mine } = await seed();
  const iPad = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const laptop = await signIn(a, mine, 'Mozilla/5.0 (Macintosh) Chrome/130.0');

  const before = await list(a, iPad);
  const target = before.body.sessions?.find((s) => !s.current);
  assert.ok(target, 'the laptop is listed from the iPad');

  const res = await a.request(`${ORIGIN}/api/auth/sessions/${target!.id}`, {
    method: 'DELETE',
    headers: { Cookie: `levonis_session=${iPad}` },
  });
  assert.equal(res.status, 200);

  // The laptop is out…
  const dead = await list(a, laptop);
  assert.equal(dead.status, 401, 'the revoked cookie still works');
  // …and the iPad is still in.
  const alive = await list(a, iPad);
  assert.equal(alive.status, 200);
  assert.equal(alive.body.sessions?.length, 1);
});

test('the current session cannot be ended here — signing out is that control', async () => {
  const { a, mine } = await seed();
  const cookie = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const { body } = await list(a, cookie);
  const current = body.sessions?.find((s) => s.current);
  assert.ok(current);

  const res = await a.request(`${ORIGIN}/api/auth/sessions/${current!.id}`, {
    method: 'DELETE',
    headers: { Cookie: `levonis_session=${cookie}` },
  });
  assert.equal(res.status, 400, 'ending it here would leave the page holding a dead cookie');
  assert.equal(((await res.json()) as { error?: string }).error, 'CANNOT_REVOKE_CURRENT');
  // And it really is still alive.
  assert.equal((await list(a, cookie)).status, 200);
});

test('one account cannot end another account’s session', async () => {
  const { a, mine, theirs } = await seed();
  const attacker = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const victim = await signIn(a, theirs, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0');

  // The attacker somehow knows the victim's published handle — the strongest
  // form of this test, since the handle is exactly what the UI would hold.
  const victimHandle = (await list(a, victim)).body.sessions?.[0]?.id ?? '';
  assert.ok(victimHandle, 'the victim has a session');

  const res = await a.request(`${ORIGIN}/api/auth/sessions/${victimHandle}`, {
    method: 'DELETE',
    headers: { Cookie: `levonis_session=${attacker}` },
  });
  assert.equal(res.status, 404, 'a cross-account revoke must not be acknowledged, let alone performed');
  assert.equal((await list(a, victim)).status, 200, 'the victim is still signed in');
});

test('«إنهاء كل الجلسات الأخرى» ends every other device and keeps this one', async () => {
  const { a, mine, theirs } = await seed();
  const keep = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const phone = await signIn(a, mine, 'Mozilla/5.0 (Android 14) Chrome/130.0');
  const laptop = await signIn(a, mine, 'Mozilla/5.0 (Macintosh) Chrome/130.0');
  const stranger = await signIn(a, theirs, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0');

  const res = await a.request(`${ORIGIN}/api/auth/sessions/revoke-others`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: `levonis_session=${keep}` },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { revoked?: number }).revoked, 2, 'two of mine, and only mine');

  assert.equal((await list(a, keep)).status, 200, 'this device stays signed in');
  assert.equal((await list(a, phone)).status, 401);
  assert.equal((await list(a, laptop)).status, 401);
  assert.equal((await list(a, stranger)).status, 200, 'another account was signed out');
});

test('a merchant storefront cannot enumerate or end sessions', async () => {
  // The session cookie is scoped to the parent domain so one identity is
  // shared with every `*.levonis-iq.com` storefront — which means a merchant
  // page carries a real, signed-in cookie. `requireMainHost` is what keeps
  // that from becoming "any merchant can list your devices and sign you out
  // of your laptop", and 404 is deliberate: a wrong-host caller learns the
  // route is not here rather than that it exists elsewhere.
  const { a, mine } = await seed();
  const cookie = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const handle = (await list(a, cookie)).body.sessions?.[0]?.id ?? '';
  assert.ok(handle);

  const storefront = { Cookie: `levonis_session=${cookie}`, Host: 'someshop.levonis-iq.com' };
  assert.equal((await a.request(`${ORIGIN}/api/auth/sessions`, { headers: storefront })).status, 404);
  assert.equal(
    (await a.request(`${ORIGIN}/api/auth/sessions/${handle}`, { method: 'DELETE', headers: storefront })).status,
    404
  );
  assert.equal(
    (
      await a.request(`${ORIGIN}/api/auth/sessions/revoke-others`, {
        method: 'POST',
        headers: { ...storefront, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    404
  );
  // And nothing was actually done.
  assert.equal((await list(a, cookie)).status, 200);
});

test('an expired session is not listed, because it is not a device to worry about', async () => {
  const { a, raw, mine } = await seed();
  const cookie = await signIn(a, mine, 'Mozilla/5.0 (iPad) Safari/605.1.15');
  const old = await signIn(a, mine, 'Mozilla/5.0 (Macintosh) Chrome/130.0');
  raw
    .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 86_400_000).toISOString(), await sha256Hex(old));

  const { body } = await list(a, cookie);
  assert.equal(body.sessions?.length, 1, 'a session that can no longer sign anyone in is not a device');
});
