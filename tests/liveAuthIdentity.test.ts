/**
 * `15 - Verify Live Auth` creates its throwaway account IN THE DATABASE and
 * signs in, instead of registering it — because since the email-first sign-up
 * (migration 0051) POST /register opens no account, and the link that would is
 * in an inbox the workflow must never read.
 *
 * That rests on two claims made by scripts/live-auth-identity.mjs, and on the
 * scenario's assumptions about the routes it then calls. These tests are what
 * make each of them true rather than asserted:
 *   - the hash the script produces opens under the Worker's OWN verifyPassword
 *     (same PBKDF2 parameters, same stored format), and is not mistaken for a
 *     legacy hash that login would re-hash;
 *   - the INSERT fits the real migrated schema — unverified, default role (the
 *     CHECK from 0001 admits no 'user'), lowercased address, one row per
 *     address;
 *   - against the real routes, /login opens the inserted identity,
 *     /verify-email/send has a real message to send, /register for a second
 *     address answers the email-first body with no cookie — and the workflow's
 *     SQL predicates, in the shape it runs them, read all of that as counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { authRoutes } from '../worker/routes/auth';
import { loadSessionUser } from '../worker/lib/session';
import { isLegacyHash, verifyPassword } from '../worker/lib/crypto';
import { usernameRejection } from '../worker/lib/usernames';
// @ts-expect-error - plain ESM helper shared with the workflow, no types
import { PBKDF2_ITERATIONS, hashPasswordLikeWorker, identitySql, newUserId, randomUsername } from '../scripts/live-auth-identity.mjs';

const PW = 'Lv-c0rrect-h0rse-e2e';
const ORIGIN = 'https://levonis-iq.com';
const MAIL = { EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'LEVONIS <noreply@levonis-iq.com>', APP_ORIGIN: ORIGIN };
const HASH_SHAPE = /^pbkdf2\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  return { raw, d1: new SqliteD1(raw) as unknown as D1Database };
}

/** The real auth routes behind the real session loader, as worker/index.ts mounts them. */
function app(d1: D1Database, env: Partial<Env> = {}) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, ...env } as Env;
    await loadSessionUser(c);
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

function captureMail() {
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (href.includes('api.resend.com')) {
      sends += 1;
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { sends: () => sends, restore: () => { globalThis.fetch = original; } };
}

function execCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(pending),
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
});

// ------------------------------------------------------------------ the hash

test('the hash opens under the Worker\'s own verifyPassword and carries its exact parameters', async () => {
  const hash = await hashPasswordLikeWorker(PW);
  assert.match(hash, HASH_SHAPE, 'pbkdf2$<iterations>$<16-byte salt>$<32-byte hash>, b64url');
  assert.equal(PBKDF2_ITERATIONS, 100_000, 'worker/lib/crypto.ts PBKDF2_ITERATIONS');
  assert.equal(await verifyPassword(PW, hash), true, 'the Worker accepts it');
  assert.equal(await verifyPassword(`${PW}x`, hash), false, 'and only for the right password');
  assert.equal(isLegacyHash(hash), false, 'login must not treat it as bcrypt and re-hash it');
  assert.notEqual(await hashPasswordLikeWorker(PW), hash, 'a fresh salt every time');
  await assert.rejects(() => hashPasswordLikeWorker('short'), /at least 8/, 'a password the Worker would refuse is refused here too');
});

// ---------------------------------------------------------------- the INSERT

test('the INSERT fits the migrated schema: unverified, default role, lowercased address, one row per address', async () => {
  const { raw } = db();
  const id = newUserId();
  const hash = await hashPasswordLikeWorker(PW);
  const sql = identitySql({ id, email: 'Owner+Levo-E2E-1@Example.com', username: 'e2e-abcdefghijkl', passwordHash: hash, name: "LEVO live check 'quoted'" });
  raw.exec(sql);
  const row = raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
  assert.equal(row.email, 'owner+levo-e2e-1@example.com', 'stored lowercased, as the Worker stores every address');
  assert.equal(row.email_verified_at, null, 'unverified, so the scenario\'s verification mail is a real send');
  assert.equal(row.role, 'customer', 'the schema default — the only role a person may hold');
  assert.equal(row.onboarding_state, 'new', 'exactly what /register used to leave behind');
  assert.equal(row.password_hash, hash);
  assert.equal(row.username, 'e2e-abcdefghijkl');
  assert.equal(row.name, "LEVO live check 'quoted'", 'quotes are escaped, never interpreted');

  // The workflow asserts COUNT(*) = 1 for the run's tag; the schema guarantees it.
  assert.throws(
    () => raw.exec(identitySql({ id: newUserId(), email: 'owner+levo-e2e-1@example.com', username: 'e2e-mnopqrstuvwx', passwordHash: hash })),
    /UNIQUE/
  );

  // Nothing malformed reaches SQL.
  assert.throws(() => identitySql({ id, email: 'nonsense', username: 'e2e-abcdefghijkl', passwordHash: hash }), /valid address/);
  assert.throws(() => identitySql({ id, email: 'a@b.co', username: 'e2e-abcdefghijkl', passwordHash: 'plain' }), /pbkdf2/);
  assert.throws(() => identitySql({ id: 'u1', email: 'a@b.co', username: 'e2e-abcdefghijkl', passwordHash: hash }), /usr_/);
  assert.throws(() => identitySql({ id, email: 'a@b.co', username: 'Bad Handle!', passwordHash: hash }), /username/);

  // The role is never written: the value 'user' the task sheet named would be
  // refused by the CHECK constraint, so the default is the honest choice.
  assert.ok(!/\brole\b/i.test(sql), 'the INSERT leaves role to the schema');
  assert.throws(() => raw.prepare("INSERT INTO users (id, email, role) VALUES ('usr_x', 'x@y.co', 'user')").run(), /CHECK/);
});

test('the generated handle and id are ones the Worker itself would produce', () => {
  /**
   * 20,000 DRAWS, NOT 200, AND THE COUNT IS THE POINT.
   *
   * This test used to draw 200 and pass 96% of the time. The generator drew
   * from `[a-z0-9]`, twelve random letters and digits spell words, and the
   * indecency filter caught 0.019% of them — `e2e-0hd884sh1tx9`,
   * `e2e-fuqj2opwe9qc`. At 200 draws that is a 3.7% chance of red per run:
   * frequent enough to be seen, rare enough to be re-run and forgotten, which
   * is the worst failure rate a test can have.
   *
   * The generator now draws DIGITS, so the property is structural rather than
   * probable (scripts/live-auth-identity.mjs says why). A sample this size is
   * what turns that claim into a measurement: if the alphabet ever goes back
   * to letters, the old 0.019% becomes a ~98% chance of failing HERE, on the
   * line that names the reason — instead of one run in twenty-seven somewhere
   * downstream.
   *
   * It is not a slow test: 20,000 draws of a 16-character string and a regex
   * pass take well under a second.
   */
  const rejected: string[] = [];
  for (let i = 0; i < 20_000; i++) {
    const u = randomUsername();
    if (usernameRejection(u) !== null) rejected.push(u);
    assert.match(newUserId(), /^usr_[0-9a-f]{20}$/, 'newId(\'usr\') shape');
  }
  assert.deepEqual(
    rejected.slice(0, 5),
    [],
    `${rejected.length} of 20,000 generated handles would be rejected by worker/lib/usernames.ts`
  );
});

// ---------------------------------------------- the scenario, on the real routes

test('the live scenario on the real routes: login opens the inserted identity, verification is a real send, /register for a second address is email-first — and the workflow\'s SQL reads it all as counts', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    const TAG = 'levo-e2e-424242';
    const SIGNUP_TAG = `${TAG}-signup`;
    const email = `owner+${TAG}@example.com`;
    const signupEmail = `owner+${SIGNUP_TAG}@example.com`;
    const id = newUserId();
    raw.exec(identitySql({ id, email, username: randomUsername(), passwordHash: await hashPasswordLikeWorker(PW) }));

    // B. sign in — typed in a different case, as a person might.
    const login = await a.request(`${ORIGIN}/api/auth/login`, json({ identifier: email.toUpperCase(), password: PW }));
    assert.equal(login.status, 200);
    const loginBody = (await login.json()) as { user?: { id: string; email: string } };
    assert.equal(loginBody.user?.id, id, 'the session belongs to the inserted row');
    assert.equal(loginBody.user?.email, email);
    const cookie = /levonis_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
    assert.ok(cookie, 'a session cookie is set');
    assert.equal((await a.request(`${ORIGIN}/api/auth/login`, json({ identifier: email, password: 'Wr0ng-passw0rd' }))).status, 401);

    // C. the email-first sign-up for a SECOND address, sent without the session.
    const reg = execCtx();
    const res = await a.request(`${ORIGIN}/api/auth/register`, json({ email: signupEmail, name: 'LEVO live check', locale: 'en' }), undefined, reg.ctx);
    await reg.settle();
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.success, true);
    assert.equal(body.pending_email, true, 'the uniform email-first body');
    assert.equal(body.user, undefined, 'no user');
    assert.equal(res.headers.get('set-cookie'), null, 'no cookie of any kind');
    assert.ok(!Object.keys(body).some((k) => /id|token/i.test(k)), `no id and no token among ${Object.keys(body).join(',')}`);

    // D. the verification mail for the signed-in, still unverified identity.
    const ver = execCtx();
    const sent = await a.request(`${ORIGIN}/api/auth/verify-email/send`, json({}, { Cookie: `levonis_session=${cookie}` }), undefined, ver.ctx);
    await ver.settle();
    assert.equal(sent.status, 200);
    assert.notEqual(((await sent.json()) as { verified?: boolean }).verified, true, 'unverified, so a message was actually queued');
    assert.equal(mail.sends(), 2, 'two provider calls: the sign-up link and the verification');

    // THE WORKFLOW'S QUERIES, in the shape it runs them, against the real tables.
    const n = (sql: string) => (raw.prepare(sql).get() as { n: number }).n;
    const APEX = ORIGIN;
    assert.equal(n(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%+${TAG}@%' AND email_verified_at IS NULL AND password_hash LIKE 'pbkdf2%'`), 1, 'account step');
    assert.equal(n(`SELECT COUNT(*) AS n FROM pending_signups WHERE email LIKE '%+${SIGNUP_TAG}@%'`), 1, 'one pending sign-up');
    assert.equal(n(`SELECT COUNT(*) AS n FROM users WHERE email LIKE '%+${SIGNUP_TAG}@%'`), 0, 'register opened no account');
    assert.equal(n(`SELECT COUNT(*) AS n FROM outbox WHERE recipient LIKE '%+${SIGNUP_TAG}@%' AND state='sent' AND payload LIKE '%${APEX}/auth?finish=%'`), 1, 'the sign-up link, sent, on APEX');
    assert.equal(n(`SELECT COUNT(*) AS n FROM outbox WHERE recipient LIKE '%+${TAG}@%' AND state='sent' AND payload LIKE '%${APEX}/%verify_email=%'`), 1, 'the verification, sent, on APEX');
    assert.equal(n(`SELECT COUNT(*) AS n FROM outbox WHERE (recipient LIKE '%+${TAG}@%' OR recipient LIKE '%+${SIGNUP_TAG}@%') AND payload LIKE '%https://%' AND payload NOT LIKE '%${APEX}%'`), 0, 'nothing points off APEX');
    // The two tags never count each other's rows: +<tag>@ is anchored on both sides.
    assert.equal(n(`SELECT COUNT(*) AS n FROM outbox WHERE recipient LIKE '%+${TAG}@%'`), 1);
    assert.equal(n(`SELECT COUNT(*) AS n FROM outbox WHERE recipient LIKE '%+${SIGNUP_TAG}@%'`), 1);
  } finally {
    mail.restore();
  }
});

// -------------------------------------------------------------------- the CLI

test('the CLI prints the hash alone and writes an INSERT that carries no password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levo-live-auth-identity-'));
  try {
    const out = join(dir, 'identity.sql');
    const stdout = execFileSync('node', ['scripts/live-auth-identity.mjs', '--sql', out], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, TEST_EMAIL: 'Owner+levo-e2e-7@example.com', TEST_PASSWORD: PW },
    });
    assert.match(stdout, /^pbkdf2\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}\n$/, 'stdout is the hash and nothing else');
    const sql = readFileSync(out, 'utf8');
    assert.ok(!sql.includes(PW), 'the password never reaches the SQL');
    assert.ok(sql.includes(stdout.trim()), 'the SQL carries the printed hash, so masking the output masks the file too');
    assert.match(sql, /'owner\+levo-e2e-7@example\.com'/, 'lowercased');
    assert.match(sql, /email_verified_at\)\nVALUES \(.*, NULL\);/, 'unverified');
    assert.match(sql, /'usr_[0-9a-f]{20}'/);
    assert.match(sql, /'e2e-[a-z0-9]{12}'/);

    // Without a password it refuses — and the refusal names neither value.
    assert.throws(
      () => execFileSync('node', ['scripts/live-auth-identity.mjs', '--sql', out], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, TEST_EMAIL: 'Owner+levo-e2e-7@example.com', TEST_PASSWORD: '' },
      }),
      (e: { stderr?: string }) => /TEST_PASSWORD/.test(e.stderr ?? '') && !/levo-e2e-7/.test(e.stderr ?? '')
    );
    // Without --sql there is nowhere safe to put the INSERT, so nothing is produced.
    assert.throws(
      () => execFileSync('node', ['scripts/live-auth-identity.mjs'], {
        cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, TEST_EMAIL: 'Owner+levo-e2e-7@example.com', TEST_PASSWORD: PW },
      }),
      (e: { stderr?: string; stdout?: string }) => /usage/.test(e.stderr ?? '') && (e.stdout ?? '') === ''
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
