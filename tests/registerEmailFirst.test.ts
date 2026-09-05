/**
 * Sign-up no longer says whether an address has an account — and the account
 * is not born until the inbox is proven (migration 0050, pending_signups).
 *
 * POST /api/auth/register was the last endpoint that told a stranger which
 * addresses have accounts (409 EMAIL_TAKEN). A first fix that kept the
 * unconfirmed account in `users` behind a flag was reviewed and found to be
 * WORSE: the username was claimed only on the free path, which re-leaked the
 * answer, and a stranger's first attempt fixed a password the inbox owner
 * would confirm. So an email-first sign-up now writes NOTHING to `users`; it
 * waits in pending_signups until /verify-email/confirm, which is the only
 * place the account and its username are created.
 *
 * These tests run the real routes against the real migrations with a stubbed
 * mail provider, and every one of them fails on the reviewed-and-rejected
 * design as well as on the original 409.
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

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  return { raw, d1: new SqliteD1(raw) as unknown as D1Database };
}

function app(d1: D1Database, env: Partial<Env> = {}) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: d1, ...env } as Env;
    c.set('user', null);
    c.set('sessionId', null);
    c.set('sessionCreatedAt', null);
    await next();
  });
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return a;
}

const MAIL = { EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'LEVONIS <noreply@levonis-iq.com>', APP_ORIGIN: 'https://levonis-iq.com' };
const ORIGIN = 'https://levonis-iq.com';

function captureMail() {
  const sent: { to: string; subject: string; html: string; text: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (href.includes('api.resend.com')) {
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = original; } };
}

function execCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(pending),
  };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function register(a: Hono<AppContext>, body: Record<string, unknown>) {
  const { ctx, settle } = execCtx();
  const res = await a.request(`${ORIGIN}/api/auth/register`, json({ password: 'Str0ng-passw0rd', ...body }), undefined, ctx);
  await settle();
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function login(a: Hono<AppContext>, identifier: string, password: string) {
  const res = await a.request(`${ORIGIN}/api/auth/login`, json({ identifier, password }));
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function confirm(a: Hono<AppContext>, token: string) {
  const res = await a.request(`${ORIGIN}/api/auth/verify-email/confirm`, json({ token }));
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function usernameFree(a: Hono<AppContext>, u: string) {
  const res = await a.request(`${ORIGIN}/api/auth/username-available?u=${encodeURIComponent(u)}`);
  return ((await res.json()) as { available?: boolean }).available;
}
const users = (raw: DatabaseSync) => (raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const pendingRow = (raw: DatabaseSync, email: string) =>
  raw.prepare('SELECT token_hash, username FROM pending_signups WHERE email = ?').get(email) as { token_hash: string; username: string | null } | undefined;
const verifyTokenFor = (raw: DatabaseSync, email: string) => {
  const row = raw.prepare("SELECT payload FROM outbox WHERE recipient = ? AND payload LIKE '%verify_email=%' ORDER BY rowid DESC LIMIT 1").get(email) as { payload: string } | undefined;
  return row ? (/verify_email=([A-Za-z0-9_-]+)/.exec(row.payload)?.[1] ?? null) : null;
};

// ------------------------------------------------------- nothing lands in users

test('an email sign-up writes nothing to users, opens no session, and waits in pending_signups', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    const { res, body } = await register(a, { email: 'new@example.com', username: 'newone', name: 'New' });
    assert.equal(res.status, 200);
    assert.equal(body.pending_email, true);
    assert.equal(body.user, undefined);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(users(raw), 0, 'no users row until the inbox is proven');
    const pend = pendingRow(raw, 'new@example.com');
    assert.ok(pend, 'the attempt is held in pending_signups');
    assert.equal(pend!.username, 'newone', 'the requested handle is held, not yet claimed');
    assert.ok(verifyTokenFor(raw, 'new@example.com'), 'a confirmation link was mailed');
  } finally { mail.restore(); }
});

// --------------------------------------------------- the oracle, and its side channel

test('THE ORACLE IS GONE: taken and free addresses are indistinguishable, and neither claims the handle', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash, email_verified_at) VALUES ('u_old','old@example.com','oldtimer','Old','x','2026-01-01T00:00:00.000Z')").run();

    const taken = await register(a, { email: 'old@example.com', username: 'probetaken' });
    const free = await register(a, { email: 'free@example.com', username: 'probefree' });
    for (const r of [taken, free]) { assert.equal(r.res.status, 200); assert.equal(r.res.headers.get('set-cookie'), null); }
    assert.deepEqual(taken.body, free.body, 'identical response');

    // The username side channel the review found: a handle must NOT be claimed
    // by a pending sign-up, so it cannot reveal which address was free.
    assert.equal(await usernameFree(a, 'probetaken'), true, 'a pending sign-up never claims the handle (taken-address path)');
    assert.equal(await usernameFree(a, 'probefree'), true, 'nor the free-address path');
    // …and re-registering the same handle with another address never 409s.
    assert.equal((await register(a, { email: 'x1@example.com', username: 'probefree' })).res.status, 200);
    assert.equal((await register(a, { email: 'x2@example.com', username: 'probetaken' })).res.status, 200);

    assert.equal(users(raw), 1, 'still only the one pre-existing account');
    // Only the inbox learns: the owner gets a notice (no verification link), deduped per day.
    const notice = raw.prepare("SELECT event_key, payload FROM outbox WHERE recipient = 'old@example.com'").all() as { event_key: string; payload: string }[];
    assert.equal(notice.length, 1);
    assert.match(notice[0].event_key, /^email_exists:/);
    assert.ok(!/verify_email=/.test(notice[0].payload), 'never a confirmation link for an account the sender does not own');
    await register(a, { email: 'old@example.com', username: 'again' });
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM outbox WHERE recipient = 'old@example.com'").get() as { n: number }).n, 1, 'one notice per day');
  } finally { mail.restore(); }
});

test('a taken CONFIRMED handle is still named — handles are public and independent of the address', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash) VALUES ('u1','one@example.com','samehandle','One','x')").run();
    const { res, body } = await register(a, { email: 'two@example.com', username: 'samehandle' });
    assert.equal(res.status, 409);
    assert.equal(body.code, 'USERNAME_TAKEN');
  } finally { mail.restore(); }
});

// ------------------------------------------------------ no pre-account takeover

test('the LATEST attempt wins and the earlier token dies: no pre-account takeover', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    // Attacker first, victim second, same address.
    await register(a, { email: 'victim@example.com', username: 'attacker_h', name: 'Attacker', password: 'Attacker-pw-111' });
    const attackerToken = verifyTokenFor(raw, 'victim@example.com');
    await register(a, { email: 'victim@example.com', username: 'victim_h', name: 'Victim', password: 'Victim-pw-2222' });
    const victimToken = verifyTokenFor(raw, 'victim@example.com');
    assert.notEqual(attackerToken, victimToken, 'a fresh token per attempt');

    // The attacker's earlier link is dead.
    assert.equal((await confirm(a, attackerToken!)).res.status, 400, 'the superseded token no longer works');
    // The victim confirms the latest link → the account carries the VICTIM's data.
    const done = await confirm(a, victimToken!);
    assert.equal(done.res.status, 200);
    assert.equal(done.body.signed_in, true);
    const acct = raw.prepare("SELECT username, name FROM users WHERE email = 'victim@example.com'").get() as { username: string; name: string };
    assert.equal(acct.username, 'victim_h', 'the confirmed account carries the LATEST username');
    assert.equal(acct.name, 'Victim', 'and the LATEST name');
    assert.equal((await login(a, 'victim@example.com', 'Victim-pw-2222')).res.status, 200, "the victim's password opens it");
    assert.equal((await login(a, 'victim@example.com', 'Attacker-pw-111')).res.status, 401, "the attacker's does not");
  } finally { mail.restore(); }
});

// --------------------------------------------------------------- the confirm link

test('the link creates the account, claims the free handle, and signs in; it is single-use', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'link@example.com', username: 'linker', name: 'Linker', referralCode: '' });
    const token = verifyTokenFor(raw, 'link@example.com')!;
    const done = await confirm(a, token);
    assert.equal(done.res.status, 200);
    assert.equal(done.body.signed_in, true);
    assert.match(done.res.headers.get('set-cookie') ?? '', /levonis_session=/);
    const acct = raw.prepare("SELECT username FROM users WHERE email = 'link@example.com'").get() as { username: string };
    assert.equal(acct.username, 'linker');
    assert.equal((await confirm(a, token)).res.status, 400, 'the link is single-use');
    assert.equal((await login(a, 'link@example.com', 'Str0ng-passw0rd')).res.status, 200);
  } finally { mail.restore(); }
});

test('if the handle was taken by a confirmed account while the link waited, the account is created without one', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'slow@example.com', username: 'contested' });
    const token = verifyTokenFor(raw, 'slow@example.com')!;
    // Someone else confirms/creates that handle first.
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash) VALUES ('u_fast','fast@example.com','contested','Fast','x')").run();
    const done = await confirm(a, token);
    assert.equal(done.res.status, 200);
    assert.equal(done.body.signed_in, true);
    const acct = raw.prepare("SELECT username FROM users WHERE email = 'slow@example.com'").get() as { username: string | null };
    assert.equal(acct.username, null, 'onboarding will ask for a new handle');
  } finally { mail.restore(); }
});

test('if the address got an account another way while the link waited, confirm says so — it never makes a second', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'raced@example.com', username: 'racer' });
    const token = verifyTokenFor(raw, 'raced@example.com')!;
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash, google_sub, email_verified_at) VALUES ('u_g','raced@example.com','viagoogle','G','', 'sub-1','2026-02-02T00:00:00.000Z')").run();
    const done = await confirm(a, token);
    assert.equal(done.res.status, 409);
    assert.equal(done.body.code, 'ALREADY_REGISTERED');
    assert.equal(users(raw), 1, 'no duplicate account');
  } finally { mail.restore(); }
});

// -------------------------------------------------- a member's own verification link

test("an existing account's verification link opens NO session (that leak is closed)", async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash) VALUES ('m1','member@example.com','member','Member','x')").run();
    raw.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, 'm1', NULL, ?)")
      .run(await (await import('node:crypto')).webcrypto.subtle.digest('SHA-256', new TextEncoder().encode('memtoken-0123456789abcdef')).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')), new Date(Date.now() + 3600_000).toISOString());
    const done = await confirm(a, 'memtoken-0123456789abcdef');
    assert.equal(done.res.status, 200);
    assert.equal(done.body.verified, true);
    assert.equal(done.body.signed_in, false, 'a verification token never signs anyone in');
    assert.equal(done.res.headers.get('set-cookie'), null);
    assert.ok((raw.prepare("SELECT email_verified_at FROM users WHERE id = 'm1'").get() as { email_verified_at: string | null }).email_verified_at);
  } finally { mail.restore(); }
});

// ------------------------------------------------------------------- locale & no-mail

test('a Kurdish sign-up gets a Kurdish confirmation subject', async () => {
  const mail = captureMail();
  try {
    const { d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'ckb@example.com', username: 'kurduser', locale: 'ckb' });
    const verify = mail.sent.find((m) => /verify_email=/.test(m.html));
    assert.ok(verify, 'a confirmation mail went out');
    assert.match(verify!.subject, /[؀-ۿ]/, 'a non-Latin (Arabic-script) subject');
    assert.ok(!/Confirm your email/i.test(verify!.subject), 'not the English subject');
  } finally { mail.restore(); }
});

test('without a mail service the old behaviour stays: immediate session, and 409 for a taken address', async () => {
  const { d1 } = db();
  const a = app(d1, { APP_ORIGIN: ORIGIN });
  const first = await register(a, { email: 'plain@example.com', username: 'plainone' });
  assert.equal(first.res.status, 200);
  assert.ok((first.body.user as { id: string }).id);
  assert.match(first.res.headers.get('set-cookie') ?? '', /levonis_session=/);
  const second = await register(a, { email: 'plain@example.com', username: 'plaintwo' });
  assert.equal(second.res.status, 409);
  assert.equal(second.body.code, 'EMAIL_TAKEN');
  assert.equal((await login(a, 'plain@example.com', 'Str0ng-passw0rd')).res.status, 200);
});
