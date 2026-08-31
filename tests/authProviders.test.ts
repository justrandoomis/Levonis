/**
 * The three providers, and the questions the production screenshots asked.
 *
 * "Google sign-in is not enabled on this deployment." "Password reset is
 * unavailable because no mail service is configured." Both of those were TRUE
 * statements about configuration — and both were unanswerable from the code,
 * because whether a provider worked depended on values in two different
 * places with nothing comparing them. The capabilities endpoint is now the
 * one answer, and these tests are what keep it honest.
 *
 * The Google account rules are tested through `resolveGoogleIdentity`, which
 * exists as a separate function precisely so they CAN be tested: the route
 * around it first verifies an RS256 token against Google's live JWKS, so the
 * four cases that decide whether two people are one person were previously
 * unreachable without a real Google token.
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
import { authRoutes, resolveGoogleIdentity } from '../worker/routes/auth';

function db() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return { raw, d1: new SqliteD1(raw) as unknown as D1Database };
}

function app(env: Partial<Env>) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = env as Env;
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

const GOOGLE_ID = '1234567890-abc.apps.googleusercontent.com';

// =========================================================== capabilities

test('with nothing configured, the site says so instead of offering dead buttons', async () => {
  const { d1 } = db();
  const res = await app({ DB: d1 }).request('/api/auth/capabilities');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(body.google, false);
  assert.equal(body.googleClientId, '');
  assert.equal(body.passwordReset, false);
  assert.equal(body.emailVerification, false);
  assert.equal(body.telegram, false);
  // The platform's own sign-in never depends on an external provider.
  assert.equal(body.emailPassword, true);
  assert.equal(body.phoneSignIn, true);
});

test('a configured Google client id is reported, and it IS the client id', async () => {
  // The frontend used to read this from a build-time env var while the
  // Worker verified against its own copy. One value now, from the side that
  // has to verify the token.
  const { d1 } = db();
  const res = await app({ DB: d1, GOOGLE_CLIENT_ID: GOOGLE_ID }).request('/api/auth/capabilities');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.google, true);
  assert.equal(body.googleClientId, GOOGLE_ID);
});

test('mail turns on password reset AND verification together, because they are one provider', async () => {
  const { d1 } = db();
  const on = await app({ DB: d1, EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.co' }).request('/api/auth/capabilities');
  const body = (await on.json()) as Record<string, unknown>;
  assert.equal(body.passwordReset, true);
  assert.equal(body.emailVerification, true);

  // A key with no from-address cannot send: half-configured is off.
  const half = await app({ DB: d1, EMAIL_API_KEY: 'k' }).request('/api/auth/capabilities');
  assert.equal(((await half.json()) as Record<string, unknown>).passwordReset, false);
});

test('the response carries no secret — only whether one is present', async () => {
  const { d1 } = db();
  const res = await app({
    DB: d1,
    GOOGLE_CLIENT_ID: GOOGLE_ID,
    EMAIL_API_KEY: 'super-secret-resend-key',
    EMAIL_FROM: 'noreply@levonis-iq.com',
    TELEGRAM_BOT_TOKEN: '123:super-secret-bot-token',
  }).request('/api/auth/capabilities');
  const text = await res.text();
  assert.equal(text.includes('super-secret-resend-key'), false);
  assert.equal(text.includes('super-secret-bot-token'), false);
  assert.equal(text.includes('noreply@levonis-iq.com'), false);
  // The client id is public by construction and IS returned — the page needs it.
  assert.equal(text.includes(GOOGLE_ID), true);
});

test('SMS phone sign-up is reported OFF, because there is no SMS provider', async () => {
  // The honest half of removing the Phone tab: a phone number signs you IN,
  // and signing UP on one goes through Telegram, where ownership is proven.
  const { d1 } = db();
  const res = await app({ DB: d1 }).request('/api/auth/capabilities');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.phoneOtp, false);
  assert.equal(body.phoneSignIn, true);
});

// ==================================================== google: who is who

const identity = { sub: 'google-sub-1', email: 'sara@example.com', name: 'Sara' };

test('a NEW Google identity creates an account and signs it in', async () => {
  const { raw, d1 } = db();
  const user = await resolveGoogleIdentity({ DB: d1 } as Env, identity);
  assert.equal(user.email, 'sara@example.com');
  assert.equal(user.name, 'Sara');
  const row = raw.prepare('SELECT google_sub, email_verified_at FROM users WHERE id = ?').get(user.id) as
    { google_sub: string; email_verified_at: string | null };
  assert.equal(row.google_sub, 'google-sub-1');
  // Google only issues an identity whose address it has verified, so the
  // account's own matching address is stamped verified here and not again.
  assert.ok(row.email_verified_at);
});

test('signing in again matches the SAME account — no duplicate on every visit', async () => {
  const { raw, d1 } = db();
  const first = await resolveGoogleIdentity({ DB: d1 } as Env, identity);
  const second = await resolveGoogleIdentity({ DB: d1 } as Env, identity);
  assert.equal(first.id, second.id);
  const n = raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  assert.equal(Number(n.n), 1);
});

test('a changed Google display name does not fork the account', async () => {
  const { raw, d1 } = db();
  const a = await resolveGoogleIdentity({ DB: d1 } as Env, identity);
  const b = await resolveGoogleIdentity({ DB: d1 } as Env, { ...identity, name: 'Sara Ahmed' });
  assert.equal(a.id, b.id);
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n), 1);
});

test('an existing account that PROVED this address gets Google linked to it', async () => {
  const { raw, d1 } = db();
  raw.exec(`INSERT INTO users (id,email,name,password_hash,email_verified_at)
            VALUES ('u1','sara@example.com','Sara','h','2026-01-01T00:00:00Z')`);
  const user = await resolveGoogleIdentity({ DB: d1 } as Env, identity);
  assert.equal(user.id, 'u1', 'a second account was created instead of linking');
  const row = raw.prepare('SELECT google_sub FROM users WHERE id = ?').get('u1') as { google_sub: string };
  assert.equal(row.google_sub, 'google-sub-1');
  assert.equal(Number((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n), 1);
});

test('an UNVERIFIED account with the same address is NOT adopted — it is refused', async () => {
  // The dangerous case. Anyone can type an address into a signup form, so an
  // unverified local account is not proof that its owner and the Google
  // identity are the same person. Merging would hand that account — its
  // orders, its wallet — to whichever of the two signed up first.
  const { raw, d1 } = db();
  raw.exec("INSERT INTO users (id,email,name,password_hash) VALUES ('u1','sara@example.com','Sara','h')");
  await assert.rejects(
    () => resolveGoogleIdentity({ DB: d1 } as Env, identity),
    (e: unknown) => e instanceof HttpError && e.status === 409 && e.code === 'EMAIL_NOT_VERIFIED'
  );
  const row = raw.prepare('SELECT google_sub FROM users WHERE id = ?').get('u1') as { google_sub: string | null };
  assert.equal(row.google_sub, null, 'the refusal still linked the account');
});

test('a second Google account cannot take over an address the first one holds', async () => {
  const { d1 } = db();
  await resolveGoogleIdentity({ DB: d1 } as Env, identity);
  await assert.rejects(
    () => resolveGoogleIdentity({ DB: d1 } as Env, { ...identity, sub: 'google-sub-2' }),
    (e: unknown) => e instanceof HttpError && e.status === 409
  );
});

test('a derived username is never a reserved handle', async () => {
  // `admin@gmail.com` used to become the handle `admin`. A null username is
  // the correct outcome — the account works and onboarding asks for one.
  const { raw, d1 } = db();
  const user = await resolveGoogleIdentity({ DB: d1 } as Env, {
    sub: 'g-admin',
    email: 'admin@gmail.com',
    name: 'A',
  });
  const row = raw.prepare('SELECT username FROM users WHERE id = ?').get(user.id) as { username: string | null };
  assert.notEqual(row.username, 'admin');
  assert.equal(row.username, null);
});

test('two Google accounts wanting the same handle both get one, and they differ', async () => {
  const { raw, d1 } = db();
  const a = await resolveGoogleIdentity({ DB: d1 } as Env, { sub: 'g1', email: 'ali3d@gmail.com', name: 'A' });
  const b = await resolveGoogleIdentity({ DB: d1 } as Env, { sub: 'g2', email: 'ali3d@outlook.com', name: 'B' });
  const ua = raw.prepare('SELECT username FROM users WHERE id = ?').get(a.id) as { username: string | null };
  const ub = raw.prepare('SELECT username FROM users WHERE id = ?').get(b.id) as { username: string | null };
  assert.equal(ua.username, 'ali3d');
  assert.notEqual(ub.username, 'ali3d');
});

// ================================================= password reset, end to end

/** Captures what would have been sent, instead of sending it. */
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

const MAIL_ENV = { EMAIL_API_KEY: 'test-key', EMAIL_FROM: 'LEVONIS <noreply@levonis-iq.com>' };

async function seedUser(raw: DatabaseSync) {
  raw.exec("INSERT INTO users (id,email,name,password_hash) VALUES ('u1','sara@example.com','Sara','h')");
}

test('a reset request answers the same whether or not the account exists', async () => {
  // Anything else turns this endpoint into a way to ask "does this person
  // shop here", which is a question about somebody's private life.
  const { raw, d1 } = db();
  await seedUser(raw);
  const mail = captureMail();
  try {
    const a = await app({ DB: d1, ...MAIL_ENV, APP_ORIGIN: 'https://levonis-iq.com' }).request(
      '/api/auth/forgot-password',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sara@example.com' }) }
    );
    const b = await app({ DB: d1, ...MAIL_ENV, APP_ORIGIN: 'https://levonis-iq.com' }).request(
      '/api/auth/forgot-password',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }) }
    );
    assert.equal(a.status, b.status);
    assert.deepEqual(await a.json(), await b.json());
    // One email was sent — to the account that exists, and only that one.
    assert.equal(mail.sent.length, 1);
    assert.equal(mail.sent[0].to, 'sara@example.com');
  } finally {
    mail.restore();
  }
});

test('the reset link is built on the canonical origin, never on a merchant host', async () => {
  // A merchant controls the CONTENT of their storefront. A reset link built
  // from the request host would deliver the token to a page they wrote.
  const { raw, d1 } = db();
  await seedUser(raw);
  const mail = captureMail();
  try {
    await app({ DB: d1, ...MAIL_ENV, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' }).request(
      'https://ali3d.levonis-iq.com/api/auth/forgot-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', Host: 'ali3d.levonis-iq.com' },
        body: JSON.stringify({ email: 'sara@example.com' }),
      }
    );
    assert.equal(mail.sent.length, 1);
    const link = /https:\/\/[^\s"'<]+\/auth\?reset=[A-Za-z0-9_-]+/.exec(mail.sent[0].text + mail.sent[0].html);
    assert.ok(link, 'no reset link was found in the email');
    assert.ok(link[0].startsWith('https://levonis-iq.com/auth?reset='), `link was ${link[0]}`);
    assert.equal(link[0].includes('ali3d.'), false);
  } finally {
    mail.restore();
  }
});

test('the token is stored HASHED — the database never holds the link', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const mail = captureMail();
  try {
    await app({ DB: d1, ...MAIL_ENV, APP_ORIGIN: 'https://levonis-iq.com' }).request('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sara@example.com' }),
    });
    const token = /reset=([A-Za-z0-9_-]+)/.exec(mail.sent[0].text)![1];
    const row = raw.prepare('SELECT token_hash FROM password_reset_tokens').get() as { token_hash: string };
    assert.notEqual(row.token_hash, token);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  } finally {
    mail.restore();
  }
});

test('a reset consumes the token ONCE — a replay is refused', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const mail = captureMail();
  try {
    const a = app({ DB: d1, ...MAIL_ENV, APP_ORIGIN: 'https://levonis-iq.com' });
    await a.request('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sara@example.com' }),
    });
    const token = /reset=([A-Za-z0-9_-]+)/.exec(mail.sent[0].text)![1];

    const reset = (t: string) =>
      a.request('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t, password: 'a-new-password-1' }),
      });

    const first = await reset(token);
    assert.equal(first.status, 200);
    const second = await reset(token);
    assert.equal(second.status, 400);
    assert.equal(((await second.json()) as Record<string, unknown>).code, 'TOKEN_USED');
  } finally {
    mail.restore();
  }
});

test('an expired token is refused, and says nothing about the account', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const past = new Date(Date.now() - 60_000).toISOString();
  // A real token row, hashed the way the endpoint hashes it.
  const { createHash } = await import('node:crypto');
  const token = 'expired-token-value-0123456789abcdef';
  const hash = createHash('sha256').update(token).digest('hex');
  raw.prepare('INSERT INTO password_reset_tokens (token_hash,user_id,expires_at) VALUES (?,?,?)').run(hash, 'u1', past);

  const res = await app({ DB: d1, ...MAIL_ENV }).request('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password: 'a-new-password-1' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 400);
  assert.equal(body.code, 'TOKEN_EXPIRED');
  assert.match(String(body.error), /invalid or has expired/i);
  assert.equal(String(body.error).includes('sara@example.com'), false);
});

test('an unknown token is refused with the SAME wording as an expired one', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app({ DB: d1, ...MAIL_ENV }).request('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'no-such-token-000000000000000000', password: 'a-new-password-1' }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 400);
  assert.match(String(body.error), /invalid or has expired/i);
});

test('with no mail provider the request refuses HONESTLY instead of pretending', async () => {
  // A cheerful "check your inbox" for mail that cannot be sent is the one
  // thing worse than saying it is unavailable.
  const { raw, d1 } = db();
  await seedUser(raw);
  const res = await app({ DB: d1 }).request('/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sara@example.com' }),
  });
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as Record<string, unknown>).code, 'EMAIL_NOT_CONFIGURED');
});

test('a successful reset ends every existing session', async () => {
  const { raw, d1 } = db();
  await seedUser(raw);
  raw.prepare("INSERT INTO sessions (id,user_id,expires_at) VALUES ('s1','u1',?)").run(
    new Date(Date.now() + 86_400_000).toISOString()
  );
  const mail = captureMail();
  try {
    const a = app({ DB: d1, ...MAIL_ENV, APP_ORIGIN: 'https://levonis-iq.com' });
    await a.request('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sara@example.com' }),
    });
    const token = /reset=([A-Za-z0-9_-]+)/.exec(mail.sent[0].text)![1];
    await a.request('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'a-new-password-1' }),
    });
    const n = raw.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('u1') as { n: number };
    assert.equal(Number(n.n), 0, 'old sessions survived a password reset');
  } finally {
    mail.restore();
  }
});
