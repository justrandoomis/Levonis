/**
 * TWO SIGN-INS AT ONCE ON AN OLD BCRYPT PASSWORD BOTH SIGN IN.
 *
 * Commit f07b07a9 made /login's session require the password hash it checked
 * (or the PBKDF2 hash its own rehash wrote) to still be on the row, and made
 * that rehash replace only the exact hash it checked — so a password the
 * owner's first proof took away while a sign-in was checking it is neither put
 * back nor signed into (worker/lib/emailStamp.ts, rule 2).
 *
 * Its review found the cost for ordinary users: when two sign-ins with the
 * same correct password run together on an account still holding the bcrypt
 * hash of the old server, the first rehash wins, the second changes no row,
 * and its session then required the bcrypt hash that was no longer there —
 * 401 REAUTH_REQUIRED for a correct password, where the parent commit signed
 * both in. /login now checks the password again against what the row holds
 * when its rehash lost, and opens the session on that hash.
 *
 * Kept, in the same cases: a purge (NULL) or a different password landing in
 * that window still refuses the sign-in, and nothing is written back.
 *
 * Drives the real session loader and the real /login over a fresh database
 * with every migration applied. The windows are made deterministic by a D1
 * whose `prepare` runs the competing write just before the rehash statement.
 *
 * Run: node --import tsx --test tests/legacyLoginConcurrentRehash.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { loadSessionUser } from '../worker/lib/session';
import { hashPassword, isLegacyHash, verifyPassword } from '../worker/lib/crypto';
import { authRoutes } from '../worker/routes/auth';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { count, freshDb, row } from './fixtures/app';

const ORIGIN = 'https://levonis-iq.com';
const EMAIL = 'legacy@x.co';
const PW = 'LegacyPass1';
const USER = 'usr_legacy';
const REHASH_SQL = 'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?';

/** A D1 that runs `beforeRehash` once, just before /login prepares its conditional rehash. */
class WindowD1 extends SqliteD1 {
  beforeRehash: (() => void) | null = null;
  prepare(sql: string): SqliteStatement {
    if (this.beforeRehash && sql === REHASH_SQL) {
      const run = this.beforeRehash;
      this.beforeRehash = null;
      run();
    }
    return super.prepare(sql);
  }
}

function setup() {
  const raw = freshDb();
  raw
    .prepare("INSERT INTO users (id, name, email, username, password_hash, role) VALUES (?, 'L', ?, 'legacy', ?, 'customer')")
    .run(USER, EMAIL, bcrypt.hashSync(PW, 4));
  const d1 = new WindowD1(raw);
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = {
      DB: d1 as unknown as D1Database,
      INITIAL_ADMIN_EMAIL: 'boss@x.co',
      APP_ORIGIN: ORIGIN,
      EXTRA_ALLOWED_ORIGINS: '',
    } as unknown as Env;
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
    await loadSessionUser(c);
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    return c.json({ success: false, error: String(err) }, 500);
  });
  return { raw, d1, a };
}

let ip = 0;
async function login(a: Hono<AppContext>, password = PW) {
  const res = await a.request(`${ORIGIN}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'CF-Connecting-IP': `7.7.7.${++ip}` },
    body: JSON.stringify({ identifier: EMAIL, password }),
  });
  const body = (await res.json()) as { code?: string; user?: { id: string } };
  const cookie = /levonis_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? null;
  return { status: res.status, code: body.code ?? null, cookie };
}

async function me(a: Hono<AppContext>, cookie: string) {
  const res = await a.request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `levonis_session=${cookie}` } });
  return ((await res.json()) as { user: { id: string } | null }).user?.id ?? null;
}

const storedHash = (raw: DatabaseSync) =>
  row<{ password_hash: string | null }>(raw, 'SELECT password_hash FROM users WHERE id = ?', USER)!.password_hash;
const sessions = (raw: DatabaseSync) => count(raw, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', USER);

test('one sign-in on a bcrypt password signs in and upgrades the hash (control)', async () => {
  const { raw, a } = setup();
  const r = await login(a);
  assert.equal(r.status, 200);
  assert.equal(await me(a, r.cookie!), USER);
  const h = storedHash(raw)!;
  assert.equal(isLegacyHash(h), false, 'rehashed to PBKDF2');
  assert.equal(await verifyPassword(PW, h), true);
  assert.equal((await login(a)).status, 200, 'and signs in again on the new hash');
});

test('two sign-ins at the same moment on a bcrypt password: both sign in, one rehash', async () => {
  for (let round = 0; round < 5; round++) {
    const { raw, a } = setup();
    const out = await Promise.all([login(a), login(a)]);
    assert.deepEqual(
      out.map((r) => `${r.status} ${r.code ?? ''}`.trim()),
      ['200', '200'],
      `round ${round}: the parent commit answered 200 | 200`
    );
    for (const r of out) assert.equal(await me(a, r.cookie!), USER, `round ${round}: each cookie opens the account`);
    assert.equal(sessions(raw), 2);
    const h = storedHash(raw)!;
    assert.equal(isLegacyHash(h), false);
    assert.equal(await verifyPassword(PW, h), true);
  }
});

test('the other sign-in rehashes between this one’s check and its rehash: this one still signs in', async () => {
  const { raw, d1, a } = setup();
  const winner = await hashPassword(PW);
  d1.beforeRehash = () => {
    raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(winner, USER);
  };
  const r = await login(a);
  assert.equal(r.status, 200, `was ${r.status} ${r.code}`);
  assert.equal(await me(a, r.cookie!), USER);
  assert.equal(storedHash(raw), winner, 'the winning rehash stays; this one wrote nothing');
  assert.equal(sessions(raw), 1);
});

test('the owner’s first proof clears the password in that window: refused, and the password is not put back', async () => {
  const { raw, d1, a } = setup();
  d1.beforeRehash = () => {
    raw.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(USER);
  };
  const r = await login(a);
  assert.equal(r.status, 401);
  assert.equal(r.code, 'REAUTH_REQUIRED');
  assert.equal(r.cookie, null, 'no session cookie');
  assert.equal(sessions(raw), 0, 'no session written');
  assert.equal(storedHash(raw), null, 'the rehash did not write the password back');
});

test('a different password is set in that window: refused, and the new password stays', async () => {
  const { raw, d1, a } = setup();
  const other = await hashPassword('SomethingElse9');
  d1.beforeRehash = () => {
    raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(other, USER);
  };
  const r = await login(a);
  assert.equal(r.status, 401);
  assert.equal(r.code, 'REAUTH_REQUIRED');
  assert.equal(r.cookie, null);
  assert.equal(sessions(raw), 0);
  assert.equal(storedHash(raw), other);
  assert.equal((await login(a)).status, 401, 'the old password no longer signs in');
  assert.equal((await login(a, 'SomethingElse9')).status, 200, 'the new one does');
});
