/**
 * Sign-up no longer says whether an address has an account — the account is
 * not born until the inbox is proven, and the PASSWORD is chosen by the
 * confirming request (migration 0051, pending_signups).
 *
 * POST /api/auth/register was the last endpoint that told a stranger which
 * addresses have accounts (409 EMAIL_TAKEN). Two earlier fixes were reverted
 * by their own adversarial review: keeping the unconfirmed account in `users`
 * re-leaked the answer through the username, and holding a password in the
 * pending row let whoever submitted the sign-up fix the password the inbox
 * owner would later "confirm". So an email-first sign-up now writes NOTHING to
 * `users` and stores NO password; it waits in pending_signups until
 * POST /signup/complete, where the person holding the link types the password
 * and the account, its handle and its session are created together.
 *
 * These tests run the real routes against the real migrations with a stubbed
 * mail provider, and each one fails on the original 409 and on both rejected
 * designs.
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
const PW = 'Str0ng-passw0rd';

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
  const res = await a.request(`${ORIGIN}/api/auth/register`, json(body), undefined, ctx);
  await settle();
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function login(a: Hono<AppContext>, identifier: string, password: string) {
  const res = await a.request(`${ORIGIN}/api/auth/login`, json({ identifier, password }));
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function pending(a: Hono<AppContext>, token: string) {
  const res = await a.request(`${ORIGIN}/api/auth/signup/pending?token=${encodeURIComponent(token)}`);
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function complete(a: Hono<AppContext>, token: string, password: string, extra: Record<string, unknown> = {}) {
  const res = await a.request(`${ORIGIN}/api/auth/signup/complete`, json({ token, password, ...extra }));
  return { res, body: (await res.json()) as Record<string, unknown> };
}
async function usernameFree(a: Hono<AppContext>, u: string) {
  const res = await a.request(`${ORIGIN}/api/auth/username-available?u=${encodeURIComponent(u)}`);
  return ((await res.json()) as { available?: boolean }).available;
}
const users = (raw: DatabaseSync) => (raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
const pendingRow = (raw: DatabaseSync, email: string) =>
  raw.prepare('SELECT token_hash, username FROM pending_signups WHERE email = ?').get(email) as { token_hash: string; username: string | null } | undefined;
const linkTokenFor = (raw: DatabaseSync, email: string) => {
  const row = raw.prepare("SELECT payload FROM outbox WHERE recipient = ? AND payload LIKE '%auth?finish=%' ORDER BY rowid DESC LIMIT 1").get(email) as { payload: string } | undefined;
  return row ? (/auth\?finish=([A-Za-z0-9_-]+)/.exec(row.payload)?.[1] ?? null) : null;
};

// ------------------------------------------------------- nothing lands in users

test('an email sign-up writes nothing to users, stores no password, opens no session, and waits in pending_signups', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    // The old client still sends a password; the server in this mode ignores it.
    const { res, body } = await register(a, { email: 'new@example.com', username: 'newone', name: 'New', password: PW });
    assert.equal(res.status, 200);
    assert.equal(body.pending_email, true);
    assert.equal(body.user, undefined);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(users(raw), 0, 'no users row until the inbox is proven');
    const pend = pendingRow(raw, 'new@example.com');
    assert.ok(pend, 'the attempt is held in pending_signups');
    assert.equal(pend!.username, 'newone', 'the requested handle is held, not yet claimed');
    const cols = (raw.prepare('PRAGMA table_info(pending_signups)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!cols.some((c) => /password/i.test(c)), 'the pending row has NO password column at all');
    assert.ok(linkTokenFor(raw, 'new@example.com'), 'a finish link was mailed');
  } finally { mail.restore(); }
});

test('a sign-up without any password is accepted in email-first mode (the password comes at the link)', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    const { res } = await register(a, { email: 'nopw@example.com', name: 'No PW' });
    assert.equal(res.status, 200);
    assert.ok(linkTokenFor(raw, 'nopw@example.com'));
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
    assert.equal(pendingRow(raw, 'old@example.com'), undefined, 'no pending row for an address that has an account');
    // Only the inbox learns: the owner gets a notice (no finish link), deduped per day.
    const notice = raw.prepare("SELECT event_key, payload FROM outbox WHERE recipient = 'old@example.com'").all() as { event_key: string; payload: string }[];
    assert.equal(notice.length, 1);
    assert.match(notice[0].event_key, /^email_exists:/);
    assert.ok(!/auth\?finish=/.test(notice[0].payload), 'never a finish link for an account the sender does not own');
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

test('NO TAKEOVER: a planted sign-up carries no password, the latest link wins, and the owner sets their own', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    // Attacker plants a sign-up for the victim's address (sending a password
    // the server must ignore); the victim signs up afterwards.
    await register(a, { email: 'victim@example.com', username: 'attacker_h', name: 'Attacker', password: 'Attacker-pw-111' });
    const attackerToken = linkTokenFor(raw, 'victim@example.com')!;
    await register(a, { email: 'victim@example.com', username: 'victim_h', name: 'Victim' });
    const victimToken = linkTokenFor(raw, 'victim@example.com')!;
    assert.notEqual(attackerToken, victimToken, 'a fresh token per attempt');

    // The attacker's earlier link is dead — to read and to finish.
    assert.equal((await pending(a, attackerToken)).res.status, 400, 'the superseded token no longer opens the finish page');
    assert.equal((await complete(a, attackerToken, 'Attacker-pw-111')).res.status, 400, 'nor can it finish');
    // The victim finishes the latest link with THEIR password → the account is theirs.
    const done = await complete(a, victimToken, 'Victim-pw-2222');
    assert.equal(done.res.status, 200);
    assert.match(done.res.headers.get('set-cookie') ?? '', /levonis_session=/);
    const acct = raw.prepare("SELECT username, name, email_verified_at FROM users WHERE email = 'victim@example.com'").get() as { username: string; name: string; email_verified_at: string | null };
    assert.equal(acct.username, 'victim_h', 'the account carries the LATEST username');
    assert.equal(acct.name, 'Victim', 'and the LATEST name');
    assert.ok(acct.email_verified_at, 'and is born verified — the link proved the inbox');
    assert.equal((await login(a, 'victim@example.com', 'Victim-pw-2222')).res.status, 200, "the victim's password opens it");
    assert.equal((await login(a, 'victim@example.com', 'Attacker-pw-111')).res.status, 401, "the attacker's never existed");
  } finally { mail.restore(); }
});

// --------------------------------------------------------------- the finish link

test('the finish page reads the pending profile without spending the link; a bad token is one generic refusal', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'peek@example.com', username: 'peeker', name: 'Peek', country: 'iq' });
    const token = linkTokenFor(raw, 'peek@example.com')!;
    const first = await pending(a, token);
    assert.equal(first.res.status, 200);
    assert.equal(first.body.email, 'peek@example.com');
    assert.equal(first.body.username, 'peeker');
    assert.equal(first.body.name, 'Peek');
    assert.equal(first.body.country, 'IQ');
    assert.equal(first.res.headers.get('cache-control'), 'no-store');
    assert.equal((await pending(a, token)).res.status, 200, 'reading is repeatable — a mail scanner cannot burn the link');
    assert.equal(users(raw), 0, 'reading creates nothing');
    const bad = await pending(a, 'not-a-real-token-0123456789');
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.code, 'BAD_TOKEN');
  } finally { mail.restore(); }
});

test('completing creates the account, claims the free handle, signs in, and is single-use; a weak password never burns the link', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'link@example.com', username: 'linker', name: 'Linker', locale: 'ar' });
    const token = linkTokenFor(raw, 'link@example.com')!;

    const weak = await complete(a, token, 'short');
    assert.equal(weak.res.status, 400);
    assert.ok(pendingRow(raw, 'link@example.com'), 'a refused password leaves the link alive');
    assert.equal(users(raw), 0);

    const done = await complete(a, token, PW);
    assert.equal(done.res.status, 200);
    assert.equal(done.body.username_dropped, false);
    assert.match(done.res.headers.get('set-cookie') ?? '', /levonis_session=/);
    const user = done.body.user as { id: string; email: string; username: string | null };
    assert.equal(user.email, 'link@example.com');
    assert.equal(user.username, 'linker');
    const acct = raw.prepare("SELECT username, locale, email_verified_at FROM users WHERE email = 'link@example.com'").get() as { username: string; locale: string; email_verified_at: string | null };
    assert.equal(acct.username, 'linker');
    assert.equal(acct.locale, 'ar', 'the language chosen at sign-up follows the account');
    assert.ok(acct.email_verified_at);
    assert.equal(pendingRow(raw, 'link@example.com'), undefined, 'the pending row is consumed');
    assert.equal((await complete(a, token, PW)).res.status, 400, 'the link is single-use');
    assert.equal((await pending(a, token)).res.status, 400);
    assert.equal((await login(a, 'link@example.com', PW)).res.status, 200);
    assert.equal((await login(a, 'linker', PW)).res.status, 200, 'the handle signs in too');
  } finally { mail.restore(); }
});

test('the finish page may correct the handle: a free one is taken, a taken one is named without burning the link', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash) VALUES ('u1','one@example.com','claimed','One','x')").run();
    await register(a, { email: 'fix@example.com', username: 'typo_handle', name: 'Fix' });
    const token = linkTokenFor(raw, 'fix@example.com')!;
    const clash = await complete(a, token, PW, { username: 'claimed' });
    assert.equal(clash.res.status, 409);
    assert.equal(clash.body.code, 'USERNAME_TAKEN');
    assert.ok(pendingRow(raw, 'fix@example.com'), 'still finishable');
    const done = await complete(a, token, PW, { username: 'fixed_handle', name: 'Fixed' });
    assert.equal(done.res.status, 200);
    const acct = raw.prepare("SELECT username, name FROM users WHERE email = 'fix@example.com'").get() as { username: string; name: string };
    assert.equal(acct.username, 'fixed_handle');
    assert.equal(acct.name, 'Fixed');
  } finally { mail.restore(); }
});

test('if the handle was taken by a confirmed account while the link waited, the account is created without one', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'slow@example.com', username: 'contested' });
    const token = linkTokenFor(raw, 'slow@example.com')!;
    // Someone else creates that handle first.
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash) VALUES ('u_fast','fast@example.com','contested','Fast','x')").run();
    const done = await complete(a, token, PW);
    assert.equal(done.res.status, 200);
    assert.equal(done.body.username_dropped, true, 'the client is told so onboarding can ask again');
    const acct = raw.prepare("SELECT username FROM users WHERE email = 'slow@example.com'").get() as { username: string | null };
    assert.equal(acct.username, null, 'onboarding will ask for a new handle');
  } finally { mail.restore(); }
});

test('if the address got an account another way while the link waited, completing says so — it never makes a second', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'raced@example.com', username: 'racer' });
    const token = linkTokenFor(raw, 'raced@example.com')!;
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash, google_sub, email_verified_at) VALUES ('u_g','raced@example.com','viagoogle','G','', 'sub-1','2026-02-02T00:00:00.000Z')").run();
    const done = await complete(a, token, PW);
    assert.equal(done.res.status, 409);
    assert.equal(done.body.code, 'ALREADY_REGISTERED');
    assert.equal(done.res.headers.get('set-cookie'), null, 'and opens no session into the other account');
    assert.equal(users(raw), 1, 'no duplicate account');
  } finally { mail.restore(); }
});

test('an expired link is refused with the same generic message', async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'late@example.com', username: 'latecomer' });
    const token = linkTokenFor(raw, 'late@example.com')!;
    raw.prepare("UPDATE pending_signups SET expires_at = '2020-01-01T00:00:00.000Z' WHERE email = 'late@example.com'").run();
    const peek = await pending(a, token);
    assert.equal(peek.res.status, 400);
    assert.equal(peek.body.code, 'TOKEN_EXPIRED');
    const done = await complete(a, token, PW);
    assert.equal(done.res.status, 400);
    assert.equal(done.body.error, peek.body.error, 'one wording for every dead link');
    assert.equal(users(raw), 0);
  } finally { mail.restore(); }
});

// -------------------------------------------------- a member's own verification link

test("an existing account's verification link still only verifies — it opens NO session", async () => {
  const mail = captureMail();
  try {
    const { raw, d1 } = db();
    const a = app(d1, MAIL);
    raw.prepare("INSERT INTO users (id, email, username, name, password_hash) VALUES ('m1','member@example.com','member','Member','x')").run();
    const tokenHash = await (await import('node:crypto')).webcrypto.subtle
      .digest('SHA-256', new TextEncoder().encode('memtoken-0123456789abcdef'))
      .then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join(''));
    raw.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, new_email, expires_at) VALUES (?, 'm1', NULL, ?)")
      .run(tokenHash, new Date(Date.now() + 3600_000).toISOString());
    const res = await a.request(`${ORIGIN}/api/auth/verify-email/confirm`, json({ token: 'memtoken-0123456789abcdef' }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { verified: boolean }).verified, true);
    assert.equal(res.headers.get('set-cookie'), null, 'a verification token never signs anyone in');
    assert.ok((raw.prepare("SELECT email_verified_at FROM users WHERE id = 'm1'").get() as { email_verified_at: string | null }).email_verified_at);
  } finally { mail.restore(); }
});

// ------------------------------------------------------------------- locale & no-mail

test('a Kurdish sign-up gets a Kurdish finish-link subject, on the main origin', async () => {
  const mail = captureMail();
  try {
    const { d1 } = db();
    const a = app(d1, MAIL);
    await register(a, { email: 'ckb@example.com', username: 'kurduser', locale: 'ckb' });
    const link = mail.sent.find((m) => /auth\?finish=/.test(m.html));
    assert.ok(link, 'a finish mail went out');
    assert.match(link!.subject, /[؀-ۿ]/, 'a non-Latin (Arabic-script) subject');
    assert.ok(!/Finish creating/i.test(link!.subject), 'not the English subject');
    assert.ok(link!.html.includes('https://levonis-iq.com/auth?finish='), 'the link points at the trusted origin');
  } finally { mail.restore(); }
});

test('capabilities advertise the email-first sign-up exactly when mail is configured', async () => {
  const { d1 } = db();
  const on = (await (await app(d1, MAIL).request(`${ORIGIN}/api/auth/capabilities`)).json()) as { emailFirstSignup: boolean };
  const off = (await (await app(d1, { APP_ORIGIN: ORIGIN }).request(`${ORIGIN}/api/auth/capabilities`)).json()) as { emailFirstSignup: boolean };
  assert.equal(on.emailFirstSignup, true);
  assert.equal(off.emailFirstSignup, false);
});

test('without a mail service the old behaviour stays: immediate session, password required, and 409 for a taken address', async () => {
  const { d1 } = db();
  const a = app(d1, { APP_ORIGIN: ORIGIN });
  const noPw = await register(a, { email: 'plain@example.com', username: 'plainzero' });
  assert.equal(noPw.res.status, 400, 'no private channel to set the password later — it is required here');
  const first = await register(a, { email: 'plain@example.com', username: 'plainone', password: PW });
  assert.equal(first.res.status, 200);
  assert.ok((first.body.user as { id: string }).id);
  assert.match(first.res.headers.get('set-cookie') ?? '', /levonis_session=/);
  const second = await register(a, { email: 'plain@example.com', username: 'plaintwo', password: PW });
  assert.equal(second.res.status, 409);
  assert.equal(second.body.code, 'EMAIL_TAKEN');
  assert.equal((await login(a, 'plain@example.com', PW)).res.status, 200);
  // The finish endpoints have nothing to finish in this mode.
  assert.equal((await complete(a, 'not-a-real-token-0123456789', PW)).res.status, 400);
});
