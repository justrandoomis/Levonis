/**
 * ACCOUNT-TAKEOVER RACES INTO THE OWNER'S DATA — FX programme plan §14.2 S8,
 * push 1s (survey-security (f)1, 2, 6).
 *
 *   (1) POST /reset-password spends the link, hashes the new password, then
 *       writes it. The first proof of the owner's address (worker/lib/emailStamp.ts)
 *       can land in between: it spends every UNUSED reset link and clears the
 *       password — but this link is already spent, so an unconditional write
 *       put a password the proof never saw back on the row it just took back.
 *       The write now re-reads, in its own WHERE, the spent token naming this
 *       row and "no first owner proof since the token was read".
 *   (2) The Google link UPDATE in `resolveGoogleIdentity` re-reads the address
 *       and its verification stamp: a row that moved to another address (or
 *       lost a real stamp) between the read and the link is not handed to the
 *       Google account of an address it no longer holds.
 *   (6) `requireOwner` is verification-aware: the owner's address unproven is
 *       refused with OWNER_EMAIL_UNVERIFIED and never passes (and
 *       tests/costPredicateUsage.test.ts holds it off every cost route).
 *
 * The races are real interleavings on one database: a statement wrapper runs
 * the competing write right after the statement that opens the window.
 *
 * Run: node --import tsx --test tests/authRaces.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { loadSessionUser } from '../worker/lib/session';
import { sha256Hex, verifyPassword } from '../worker/lib/crypto';
import { authRoutes, resolveGoogleIdentity } from '../worker/routes/auth';
import { STAMP_ONCE, noOwnerProofSinceRead, runStamp } from '../worker/lib/emailStamp';
import { requireOwner } from '../worker/lib/costAccess';
import { serverMessage } from '../packages/contracts/src/costRefusals';
import { SqliteD1, type SqliteStatement } from './fixtures/d1';
import { asD1, ctx, freshDb, get, json, row, stubApp } from './fixtures/app';

const ORIGIN = 'https://levonis-iq.com';
const OWNER_EMAIL = 'boss@x.co';
const NEW_PASSWORD = 'a-brand-new-passphrase';

// ---------------------------------------------------------------------------
// A D1 whose statements can open a window: `after(match, fire)` runs `fire`
// once, right after the first statement whose SQL matches has run.

interface Hook {
  match: RegExp;
  fire: () => Promise<void> | void;
  done?: boolean;
}

function hookedD1(raw: DatabaseSync, hooks: Hook[]): D1Database {
  const inner = new SqliteD1(raw);
  const fire = async (sql: string) => {
    for (const h of hooks) {
      if (!h.done && h.match.test(sql)) {
        h.done = true;
        await h.fire();
      }
    }
  };
  const wrap = (s: SqliteStatement): unknown => ({
    inner: s,
    bind: (...v: unknown[]) => wrap(s.bind(...v)),
    run: async () => {
      const r = await s.run();
      await fire(s.sql);
      return r;
    },
    first: async () => {
      const r = await s.first();
      await fire(s.sql);
      return r;
    },
    all: async () => {
      const r = await s.all();
      await fire(s.sql);
      return r;
    },
  });
  return {
    prepare: (sql: string) => wrap(inner.prepare(sql)),
    batch: (ss: Array<{ inner: SqliteStatement }>) => inner.batch(ss.map((x) => x.inner)),
  } as unknown as D1Database;
}

function app(db: D1Database) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: OWNER_EMAIL, APP_ORIGIN: ORIGIN, EXTRA_ALLOWED_ORIGINS: '' } as unknown as Env;
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
    await loadSessionUser(c);
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    return c.json({ success: false, error: String(err) }, 500);
  });
  return a;
}

let ip = 0;
async function reset(db: D1Database, token: string) {
  const res = await app(db).request(
    `${ORIGIN}/api/auth/reset-password`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'CF-Connecting-IP': `7.7.7.${++ip % 250}` },
      body: JSON.stringify({ token, password: NEW_PASSWORD }),
    },
    undefined,
    ctx
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ENV = { INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as Env;
const passwordOf = (raw: DatabaseSync, id: string) => row<{ p: string | null }>(raw, 'SELECT password_hash AS p FROM users WHERE id = ?', id)?.p ?? null;
const stampOf = (raw: DatabaseSync, id: string) => row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', id)?.v ?? null;
const sessionCount = (raw: DatabaseSync, id: string) => row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', id)?.n ?? 0;
const resets = (raw: DatabaseSync, id: string) =>
  row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.password_reset' AND target = ?", id)?.n ?? 0;

async function resetTokenFor(raw: DatabaseSync, userId: string, token: string) {
  raw
    .prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(await sha256Hex(token), userId, new Date(Date.now() + 1_800_000).toISOString());
}
function sessionRow(raw: DatabaseSync, userId: string, id: string) {
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)').run(id, userId, new Date(Date.now() + 86_400_000).toISOString(), 'test');
}

/**
 * THE A10 WORLD: an admin row that took the owner's address while it was free,
 * never proven, with a password of its own and a reset link outstanding.
 */
function squatWorld(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, email_verified_at)
            VALUES ('usr_squat', 'Squatter', '${OWNER_EMAIL}', 'squat-hash', 'admin', NULL)`);
  return raw;
}

/** The owner's first proof of the address, exactly as the confirm route makes it (keeps one session). */
async function firstProof(raw: DatabaseSync, keepSessionId: string | null) {
  const d1 = asD1(raw);
  return runStamp(
    d1,
    ENV,
    { userId: 'usr_squat', kind: 'stamp', address: OWNER_EMAIL, keepSessionId },
    d1.prepare(`UPDATE users SET email_verified_at = ${STAMP_ONCE} WHERE id = ?`).bind(new Date().toISOString(), 'usr_squat')
  );
}

const SPEND = /UPDATE password_reset_tokens SET used = 1 WHERE token_hash = \? AND used = 0/;

// ------------------------------------------------------------- (1) the reset write

test('S8(1): the first owner proof lands between the spent link and the password write — no password lands, the proving session survives', async () => {
  const raw = squatWorld();
  const token = 'reset-token-squat-0123456789abcdef';
  await resetTokenFor(raw, 'usr_squat', token);
  sessionRow(raw, 'usr_squat', 'sess-proving-owner');
  sessionRow(raw, 'usr_squat', 'sess-squatter-old');

  const db = hookedD1(raw, [{ match: SPEND, fire: async () => void (await firstProof(raw, 'sess-proving-owner')) }]);
  const res = await reset(db, token);

  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TOKEN_USED', 'the same generic answer as a spent link');
  assert.equal(passwordOf(raw, 'usr_squat'), null, 'the purge cleared the password and nothing put one back');
  assert.ok(stampOf(raw, 'usr_squat'), 'the proof stands');
  assert.equal(sessionCount(raw, 'usr_squat'), 1, 'only the proving session is left: the refused reset ended no session');
  assert.ok(row(raw, "SELECT 1 AS x FROM sessions WHERE id = 'sess-proving-owner'"));
  assert.equal(resets(raw, 'usr_squat'), 0, 'no reset is audited');
});

test('S8(1): the proof landing BEFORE the link is spent is refused at the spend, as before', async () => {
  const raw = squatWorld();
  const token = 'reset-token-squat-before-0123456789';
  await resetTokenFor(raw, 'usr_squat', token);
  await firstProof(raw, null);
  const res = await reset(asD1(raw), token);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TOKEN_USED');
  assert.equal(passwordOf(raw, 'usr_squat'), null);
});

test('S8(1): a row moved to another address between the read and the write gets no password', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('usr_c', 'C', 'c@x.co', 'old-hash', 'customer')`);
  const token = 'reset-token-moved-0123456789abcdef';
  await resetTokenFor(raw, 'usr_c', token);
  const db = hookedD1(raw, [{ match: SPEND, fire: () => void raw.exec("UPDATE users SET email = 'moved@x.co' WHERE id = 'usr_c'") }]);
  const res = await reset(db, token);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'TOKEN_USED');
  assert.equal(passwordOf(raw, 'usr_c'), 'old-hash');
});

test('S8(1): the write requires the spent token to still name the row', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role) VALUES ('usr_c', 'C', 'c@x.co', 'old-hash', 'customer')`);
  const token = 'reset-token-gone-0123456789abcdefgh';
  await resetTokenFor(raw, 'usr_c', token);
  const hash = await sha256Hex(token);
  const db = hookedD1(raw, [{ match: SPEND, fire: () => void raw.prepare('DELETE FROM password_reset_tokens WHERE token_hash = ?').run(hash) }]);
  const res = await reset(db, token);
  assert.equal(res.status, 400);
  assert.equal(passwordOf(raw, 'usr_c'), 'old-hash');
});

test('S8(1): with no race the reset works exactly as before — any account, and the owner already proven', async () => {
  for (const [id, email, stamp, role] of [
    ['usr_c', 'c@x.co', null, 'customer'],
    ['usr_owner', OWNER_EMAIL, '2026-01-01T00:00:00.000Z', 'admin'],
    ['usr_squat', OWNER_EMAIL, null, 'admin'],
  ] as const) {
    const raw = freshDb();
    raw.prepare('INSERT INTO users (id, name, email, password_hash, role, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'N', email, 'old-hash', role, stamp);
    sessionRow(raw, id, `sess-${id}`);
    const token = `reset-token-${id}-0123456789abcdef`;
    await resetTokenFor(raw, id, token);
    const res = await reset(asD1(raw), token);
    assert.equal(res.status, 200, id);
    assert.ok(await verifyPassword(NEW_PASSWORD, passwordOf(raw, id)!), `${id}: the new password is on the row`);
    assert.equal(sessionCount(raw, id), 0, `${id}: every session ended`);
    assert.equal(resets(raw, id), 1);
    assert.equal(stampOf(raw, id), stamp, 'a reset never stamps');
    assert.equal((await reset(asD1(raw), token)).body.code, 'TOKEN_USED', 'one use');
  }
});

test('S8(1): the condition itself — the owner address unproven at the read and proven now refuses; every other case passes', () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, role, email_verified_at) VALUES
    ('u_owner_now', 'O', '${OWNER_EMAIL}', 'admin', '2026-10-10T00:00:00.000Z'),
    ('u_other', 'X', 'x@x.co', 'customer', '2026-10-10T00:00:00.000Z')`);
  const holds = (id: string, email: string | null, stamp: string | null) => {
    const cond = noOwnerProofSinceRead(ENV, email, stamp);
    return !!raw.prepare(`SELECT 1 AS x FROM users WHERE id = ? AND ${cond.sql}`).get(id, ...(cond.binds as never[]));
  };
  assert.equal(holds('u_owner_now', OWNER_EMAIL, null), false, 'proven since the read: refused');
  assert.equal(holds('u_owner_now', OWNER_EMAIL, '   '), false, 'a blank stamp is no stamp');
  assert.equal(holds('u_owner_now', OWNER_EMAIL, '2026-10-10T00:00:00.000Z'), true, 'already proven at the read: passes');
  assert.equal(holds('u_other', 'x@x.co', null), true, 'any other address: a stamp since the read is no reason to refuse');
  assert.equal(holds('u_other', 'moved@x.co', null), false, 'the address changed since the read');
  const noOwner = noOwnerProofSinceRead({ INITIAL_ADMIN_EMAIL: '' } as Env, OWNER_EMAIL, null);
  assert.ok(raw.prepare(`SELECT 1 AS x FROM users WHERE id = 'u_owner_now' AND ${noOwner.sql}`).get(...(noOwner.binds as never[])), 'no owner configured: no owner rule');
});

// ------------------------------------------------------------- (2) the Google link

const BY_EMAIL = /SELECT \* FROM users WHERE email = \?/;

function linkWorld(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, email_verified_at)
            VALUES ('usr_a', 'A', 'a@x.co', 'h', 'customer', '2026-01-01T00:00:00.000Z')`);
  return raw;
}
const subOf = (raw: DatabaseSync, id: string) => row<{ g: string | null }>(raw, 'SELECT google_sub AS g FROM users WHERE id = ?', id)?.g ?? null;
const resolve = (db: D1Database, sub: string, email: string) =>
  resolveGoogleIdentity({ DB: db, INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env, { sub, email, name: 'A' });

test('S8(2): with no race a verified address links its Google account, as before', async () => {
  const raw = linkWorld();
  const user = await resolve(asD1(raw), 'g-a', 'a@x.co');
  assert.equal(user.id, 'usr_a');
  assert.equal(subOf(raw, 'usr_a'), 'g-a');
});

test('S8(2): the row moved to another address between the read and the link — not linked (409 EMAIL_NOT_VERIFIED)', async () => {
  const raw = linkWorld();
  const db = hookedD1(raw, [{ match: BY_EMAIL, fire: () => void raw.exec("UPDATE users SET email = 'a2@x.co' WHERE id = 'usr_a'") }]);
  await assert.rejects(resolve(db, 'g-a', 'a@x.co'), (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === 'EMAIL_NOT_VERIFIED');
  assert.equal(subOf(raw, 'usr_a'), null, 'the Google account of an address the row no longer holds is not on it');
});

test('S8(2): a stamp that is no stamp by the time of the link — not linked', async () => {
  const raw = linkWorld();
  const db = hookedD1(raw, [{ match: BY_EMAIL, fire: () => void raw.exec("UPDATE users SET email_verified_at = '  ' WHERE id = 'usr_a'") }]);
  await assert.rejects(resolve(db, 'g-a', 'a@x.co'), (e: unknown) => e instanceof HttpError && e.code === 'EMAIL_NOT_VERIFIED');
  assert.equal(subOf(raw, 'usr_a'), null);
});

test('S8(2): the same Google account linked in between proceeds; a different one is the conflict, as before', async () => {
  const same = linkWorld();
  const db1 = hookedD1(same, [{ match: BY_EMAIL, fire: () => void same.exec("UPDATE users SET google_sub = 'g-a' WHERE id = 'usr_a'") }]);
  assert.equal((await resolve(db1, 'g-a', 'a@x.co')).id, 'usr_a');
  const other = linkWorld();
  const db2 = hookedD1(other, [{ match: BY_EMAIL, fire: () => void other.exec("UPDATE users SET google_sub = 'g-other' WHERE id = 'usr_a'") }]);
  await assert.rejects(resolve(db2, 'g-a', 'a@x.co'), (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === 'CONFLICT');
  assert.equal(subOf(other, 'usr_a'), 'g-other');
});

// ------------------------------------------------------------- (6) requireOwner

test('S8(6): requireOwner — the proven owner passes; the owner address unproven hears OWNER_EMAIL_UNVERIFIED; everyone else OWNER_ONLY', async () => {
  const at = (user: Parameters<typeof stubApp>[1]) =>
    stubApp(asD1(freshDb()), user, (a) => {
      const r = new Hono<AppContext>();
      r.get('/owner', requireOwner, (c) => c.json({ ok: true }));
      a.route('/t', r);
    });
  const owner = { id: 'usr_owner', role: 'admin' as const, email: OWNER_EMAIL, admin_scope: 'assistant' };
  assert.equal((await get(at(owner), '/t/owner')).status, 200);
  const unproven = await get(at({ ...owner, email_verified_at: null }), '/t/owner');
  assert.equal(unproven.status, 403);
  const body = await json(unproven);
  assert.equal(body.code, 'OWNER_EMAIL_UNVERIFIED');
  assert.equal(body.error, serverMessage('OWNER_EMAIL_UNVERIFIED'));
  assert.equal((await json(await get(at({ ...owner, email_verified_at: '   ' }), '/t/owner'))).code, 'OWNER_EMAIL_UNVERIFIED', 'a blank stamp is no stamp');
  for (const u of [null, { id: 'f', role: 'admin' as const, email: 'f@x.co', admin_scope: 'full' }, { ...owner, role: 'customer' as const }]) {
    const res = await get(at(u), '/t/owner');
    assert.equal(res.status, 403);
    assert.equal((await json(res)).code, 'OWNER_ONLY');
  }
});
