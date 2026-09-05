/**
 * Sign-up no longer says whether an address has an account.
 *
 * POST /api/auth/register used to answer 409 EMAIL_TAKEN — the one place left
 * that told a stranger which addresses have accounts, after sign-in, forgot
 * and reset had been made uniform. With a mail service configured, a sign-up
 * now always answers "check your inbox", opens no session, and does the same
 * password work; the address's owner is the only one who learns anything.
 * Because a stranger could otherwise "register, then sign in with my own
 * password" to get the answer, an unconfirmed sign-up is refused at sign-in
 * exactly like a wrong password until the emailed link (or a reset) proves the
 * inbox. Accounts that existed before this rule are untouched.
 *
 * Real routes, real migrations, a stubbed mail provider.
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

/** The provider never sees the network: every mail is captured here. */
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

/** A Workers execution context whose background work the test can wait for. */
function execCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(pending),
  };
}

const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ORIGIN = 'https://levonis-iq.com';

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
const outboxTo = (raw: DatabaseSync, to: string) =>
  raw.prepare("SELECT event_key, payload FROM outbox WHERE kind = 'email' AND recipient = ? ORDER BY rowid").all(to) as { event_key: string; payload: string }[];
const linkToken = (payload: string, param: string) => new RegExp(`${param}=([A-Za-z0-9_-]+)`).exec(payload)?.[1] ?? null;

// ------------------------------------------------------------- the uniform answer

test('a sign-up answers "check your inbox": no session, an account waiting on its address', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    const { res, body } = await register(a, { email: 'new@example.com', username: 'newone', name: 'New' });
    assert.equal(res.status, 200);
    assert.equal(body.pending_email, true);
    assert.equal(body.user, undefined, 'no account object comes back');
    assert.equal(res.headers.get('set-cookie'), null, 'no session is opened');
    const row = raw.prepare('SELECT signup_verification_required AS r, email_verified_at AS v FROM users WHERE email = ?').get('new@example.com') as { r: number; v: string | null };
    assert.equal(row.r, 1, 'marked as waiting on its address');
    assert.equal(row.v, null, 'not confirmed yet');
    const mails = outboxTo(raw, 'new@example.com');
    assert.equal(mails.length, 1);
    assert.ok(linkToken(mails[0].payload, 'verify_email'), 'the verification link is in the mail');
  } finally {
    mail.restore();
  }
});

test('THE ORACLE IS GONE: a taken address answers exactly like a free one', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    // A real, confirmed account that existed before the rule.
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash, email_verified_at) VALUES ('u_old','old@example.com','oldtimer','Old','x','2026-01-01T00:00:00.000Z')").run();

    const free = await register(a, { email: 'fresh@example.com', username: 'fresh1' });
    const taken = await register(a, { email: 'old@example.com', username: 'fresh2' });
    const pending = await register(a, { email: 'fresh@example.com', username: 'fresh3' });
    for (const r of [free, taken, pending]) {
      assert.equal(r.res.status, 200);
      assert.equal(r.res.headers.get('set-cookie'), null);
    }
    assert.deepEqual(taken.body, free.body, 'a taken address and a free one are indistinguishable');
    assert.deepEqual(pending.body, free.body, 'an unfinished sign-up for the address is indistinguishable too');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 2, 'no second account for the same address');

    // Only the inbox learns the difference: the owner gets a notice…
    const old = outboxTo(raw, 'old@example.com');
    assert.equal(old.length, 1);
    assert.match(old[0].event_key, /^email_exists:/);
    assert.ok(!linkToken(old[0].payload, 'verify_email'), 'and never a verification link for an account that is not theirs to verify');
    // …once a day, however many attempts.
    await register(a, { email: 'old@example.com', username: 'fresh4' });
    assert.equal(outboxTo(raw, 'old@example.com').length, 1);
    // …while the unfinished sign-up simply gets its link again.
    assert.equal(outboxTo(raw, 'fresh@example.com').length, 2);
  } finally {
    mail.restore();
  }
});

// -------------------------------------------------------- sign-in until confirmed

test('an unconfirmed sign-up is refused at sign-in EXACTLY like a wrong password', async () => {
  const mail = captureMail();
  try {
    const { d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'wait@example.com', username: 'waiting' });
    const right = await login(a, 'wait@example.com', 'Str0ng-passw0rd');
    const wrong = await login(a, 'wait@example.com', 'not-the-password');
    const nobody = await login(a, 'nobody@example.com', 'Str0ng-passw0rd');
    assert.equal(right.res.status, 401);
    assert.deepEqual(right.body, wrong.body, 'the correct password answers like a wrong one');
    assert.deepEqual(right.body, nobody.body, '…and like an address with no account at all');
    assert.equal(right.res.headers.get('set-cookie'), null);
  } finally {
    mail.restore();
  }
});

test('the emailed link confirms the address AND opens the account; sign-in then works', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'link@example.com', username: 'linker' });
    const token = linkToken(outboxTo(raw, 'link@example.com')[0].payload, 'verify_email');
    assert.ok(token);

    const res = await a.request(`${ORIGIN}/api/auth/verify-email/confirm`, json({ token }));
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.verified, true);
    assert.equal(body.signed_in, true, 'the link is the sign-in for an email-first account');
    assert.match(res.headers.get('set-cookie') ?? '', /levonis_session=/);

    const again = await a.request(`${ORIGIN}/api/auth/verify-email/confirm`, json({ token }));
    assert.equal(again.status, 400, 'the link is single-use');

    const signin = await login(a, 'link@example.com', 'Str0ng-passw0rd');
    assert.equal(signin.res.status, 200);
    assert.equal((signin.body.user as { email: string }).email, 'link@example.com');
  } finally {
    mail.restore();
  }
});

test('a password reset proves the inbox as well, so it also confirms the account', async () => {
  const mail = captureMail();
  try {
    const { d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'forgot@example.com', username: 'forgetful' });
    await a.request(`${ORIGIN}/api/auth/forgot-password`, json({ email: 'forgot@example.com' }));
    const reset = mail.sent.find((m) => /reset=/.test(m.html));
    assert.ok(reset, 'a reset mail went out');
    const token = /reset=([A-Za-z0-9_-]+)/.exec(reset.html)?.[1];
    const res = await a.request(`${ORIGIN}/api/auth/reset-password`, json({ token, password: 'An0ther-passw0rd' }));
    assert.equal(res.status, 200);
    const signin = await login(a, 'forgot@example.com', 'An0ther-passw0rd');
    assert.equal(signin.res.status, 200, 'the reset link proved the address');
  } finally {
    mail.restore();
  }
});

// ------------------------------------------------------------------ what stays

test('a taken username is still named — handles are public', async () => {
  const mail = captureMail();
  try {
    const { d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'one@example.com', username: 'samehandle' });
    const { res, body } = await register(a, { email: 'two@example.com', username: 'samehandle' });
    assert.equal(res.status, 409);
    assert.equal(body.code, 'USERNAME_TAKEN');
  } finally {
    mail.restore();
  }
});

test('without a mail service the old behaviour stays: immediate session, and 409 for a taken address', async () => {
  const { d1 } = db();
  const a = app(d1, { APP_ORIGIN: 'https://levonis-iq.com' });
  const first = await register(a, { email: 'plain@example.com', username: 'plainone' });
  assert.equal(first.res.status, 200);
  assert.ok((first.body.user as { id: string }).id, 'the account object comes back');
  assert.match(first.res.headers.get('set-cookie') ?? '', /levonis_session=/);
  const second = await register(a, { email: 'plain@example.com', username: 'plaintwo' });
  assert.equal(second.res.status, 409);
  assert.equal(second.body.code, 'EMAIL_TAKEN');
  // …and such an account signs in at once: nothing was asked of it.
  const signin = await login(a, 'plain@example.com', 'Str0ng-passw0rd');
  assert.equal(signin.res.status, 200);
});
