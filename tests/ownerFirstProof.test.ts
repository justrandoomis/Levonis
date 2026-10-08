/**
 * THE FIRST PROOF OF THE OWNER'S ADDRESS — review findings C1 and C2 of the S1
 * amendment (DECISIONS row 185, amendment of 2026-10-08), with the scratch
 * probes of that review (verifyConfirm P1–P6) kept as regression cases.
 *
 * C1 — the A10 case: some admin row holds the owner's address (INITIAL_ADMIN_EMAIL)
 * unverified, because it took the address while it was free. The real owner
 * receives a verification link nobody of theirs asked for; the 403 said "sign
 * in to that account", and the way to sign in to it is a code sent to the
 * owner's own mailbox — which stamps the SQUATTER's row, while the squatter's
 * own older session then reads cost.
 *
 *   (a) the owner-address verification email and VERIFY_SIGN_IN_REQUIRED say,
 *       in ar, en and real Sorani: if you did not ask for this, ignore it and
 *       do not sign in. OWNER_EMAIL_UNVERIFIED — read only by someone already
 *       signed in to that row — says instead what the first proof will end;
 *   (b) whichever path FIRST stamps a row holding the owner's address — a code
 *       sign-in, the emailed link (plain or an email change), a Google sign-in
 *       or a Google link — ends, in the same batch, every other way into that
 *       row: its other sessions (only the session doing the stamping stays),
 *       its password, phone and Telegram link, any Google account that is not
 *       the proof, and its outstanding reset and verification links.
 *
 *       The review of the first version of (b) proved why the credentials go
 *       too: it ended the squatter's sessions only, and the squatter signed
 *       straight back in with the password (and the Google account) the squat
 *       row had all along — and saw cost. Its probe is kept here
 *       (squatReentry), now as the assertion that every one of those doors is
 *       shut. The routes that prove return `owner_first_proof` so the page can
 *       say what ended.
 *
 * C2 — the session rule of /verify-email/confirm applies only when the token
 * would change something (an email change, or a holder not stamped yet). An
 * already-verified owner who opens an old plain link gets the ordinary
 * "verified" answer, from any browser.
 *
 * Drives the real session loader and the real auth routes over one database;
 * the Google routes run against a locally signed RS256 token and a JWKS served
 * by a fetch mock (the no-network guard stays on for every other URL).
 *
 * Run: node --import tsx --test tests/ownerFirstProof.test.ts
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import { Hono } from 'hono';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost, rootDomainFrom } from '../worker/lib/hosts';
import { loadSessionUser } from '../worker/lib/session';
import { hashPassword, sha256Hex } from '../worker/lib/crypto';
import { authRoutes, resolveGoogleIdentity } from '../worker/routes/auth';
import { renderVerifyEmail } from '../worker/lib/emailTemplates';
import { COST_REFUSALS, serverMessage } from '../packages/contracts/src/costRefusals';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { asD1, row } from './fixtures/app';
import { seededCopyUnverifiedOwner } from './fixtures/roleMatrix';
import { codeOf } from './fixtures/source';
import { ownerFirstProofPurge } from '../worker/lib/emailStamp';
import { OWNER_FIRST_PROOF_STRINGS, ownerFirstProofOf } from '../src/lib/ownerFirstProof';

const ORIGIN = 'https://levonis-iq.com';
const OWNER_EMAIL = 'boss@x.co';
const CLIENT_ID = 'levonis-test-client.apps.googleusercontent.com';
const MAIL = { EMAIL_API_KEY: 're_test', EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>' };

// ---------------------------------------------------------------------------
// Harness: worker/index.ts's order for these routes.

function app(raw: DatabaseSync, over: Record<string, unknown> = {}) {
  const d1 = asD1(raw);
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = {
      DB: d1,
      INITIAL_ADMIN_EMAIL: OWNER_EMAIL,
      APP_ORIGIN: ORIGIN,
      EXTRA_ALLOWED_ORIGINS: '',
      GOOGLE_CLIENT_ID: CLIENT_ID,
      ...over,
    } as unknown as Env;
    c.set('host', classifyHost(c.req.header('Host'), rootDomainFrom(c.env)));
    await loadSessionUser(c);
    await next();
  });
  a.use('/api/admin/*', requireMainHost);
  a.route('/api/auth', authRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    return c.json({ success: false, error: String(err) }, 500);
  });
  return a;
}
type App = ReturnType<typeof app>;

/** A live session row for `userId`; returns its cookie and its stored id. */
async function sessionFor(raw: DatabaseSync, userId: string): Promise<{ cookie: string; id: string }> {
  const token = `s-${userId}-${Math.random().toString(36).slice(2)}-0123456789`;
  const id = await sha256Hex(token);
  raw
    .prepare('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .run(id, userId, new Date(Date.now() + 86_400_000).toISOString(), 'test');
  return { cookie: `levonis_session=${token}`, id };
}

let ip = 0;
const background: Promise<unknown>[] = [];
const EXECUTION = {
  waitUntil(p: Promise<unknown>) {
    background.push(p.catch(() => undefined));
  },
  passThroughOnException() {},
} as never;

async function call(a: App, cookie: string, method: string, path: string, body?: unknown) {
  const res = await a.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers: {
        Cookie: cookie,
        'CF-Connecting-IP': `9.9.${Math.floor(++ip / 250) % 250}.${ip % 250}`,
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
  const set = /levonis_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
  return { status: res.status, text, json, newCookie: set ? `levonis_session=${set}` : null };
}

const me = async (a: App, cookie: string) => (await call(a, cookie, 'GET', '/api/auth/me')).json.user as Record<string, unknown> | null;
const stamp = (raw: DatabaseSync, id: string) =>
  row<{ v: string | null }>(raw, 'SELECT email_verified_at AS v FROM users WHERE id = ?', id)?.v ?? null;
const sessionIds = (raw: DatabaseSync, userId: string) =>
  (raw.prepare('SELECT id FROM sessions WHERE user_id = ? ORDER BY id').all(userId) as Array<{ id: string }>).map((r) => r.id);
const ended = (raw: DatabaseSync, userId: string) =>
  row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.owner_first_proof' AND target = ?", userId)?.n ?? 0;
/** Every way into a row other than its mailbox, as the database holds it. */
const waysIn = (raw: DatabaseSync, id: string) => {
  const u = row<{ p: string | null; g: string | null; ph: string | null }>(
    raw,
    'SELECT password_hash AS p, google_sub AS g, phone_e164 AS ph FROM users WHERE id = ?',
    id
  );
  const tg = row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM telegram_links WHERE user_id = ? AND revoked_at IS NULL', id)?.n ?? 0;
  const resets = row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ? AND used = 0', id)?.n ?? 0;
  return { password: u?.p ?? null, google: u?.g ?? null, phone: u?.ph ?? null, telegram: tg, resets };
};
/** A Telegram link and a phone on the row, as /telegram/link/confirm leaves them. */
const linkTelegram = (raw: DatabaseSync, id: string, phone: string, tgUser: number) => {
  raw.prepare('UPDATE users SET phone_e164 = ? WHERE id = ?').run(phone, id);
  raw
    .prepare('INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, tgUser, tgUser, phone, '2026-01-01T00:00:00.000Z');
};
async function resetTokenFor(raw: DatabaseSync, userId: string, token: string) {
  raw
    .prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(await sha256Hex(token), userId, new Date(Date.now() + 1_800_000).toISOString());
}
const passwordOf = (raw: DatabaseSync, id: string) =>
  row<{ p: string | null }>(raw, 'SELECT password_hash AS p FROM users WHERE id = ?', id)?.p ?? null;

async function tokenFor(raw: DatabaseSync, userId: string, token: string, newEmail: string | null = null, expiresMs = 3_600_000, used = 0) {
  raw
    .prepare('INSERT INTO email_verification_tokens (token_hash, user_id, new_email, expires_at, used) VALUES (?, ?, ?, ?, ?)')
    .run(await sha256Hex(token), userId, newEmail, new Date(Date.now() + expiresMs).toISOString(), used);
}
const tokenUsed = async (raw: DatabaseSync, token: string) =>
  row<{ used: number }>(raw, 'SELECT used FROM email_verification_tokens WHERE token_hash = ?', await sha256Hex(token))?.used;

/** A sign-in code for `destination` as /otp/start would store it (verifier = sha256(id:code)). */
async function codeFor(raw: DatabaseSync, userId: string, destination: string, code: string) {
  const id = `aotp_${Math.random().toString(36).slice(2)}`;
  raw
    .prepare(
      'INSERT INTO auth_otp (id, channel, destination, purpose, user_id, verifier, max_attempts, expires_at) VALUES (?,?,?,?,?,?,?,?)'
    )
    .run(id, 'email', destination, 'signin', userId, await sha256Hex(`${id}:${code}`), 5, new Date(Date.now() + 600_000).toISOString());
}

/**
 * The A10 world: the real owner's account moved to another, verified address,
 * and an admin row "usr_squat" registered the owner's address while it was
 * free — never verified.
 */
function squatWorld(): DatabaseSync {
  const raw = seededCopyUnverifiedOwner();
  raw.exec(`
    UPDATE users SET email = 'owner-moved@x.co', email_verified_at = '2026-01-01T00:00:00.000Z' WHERE id = 'usr_owner';
    INSERT INTO users (id, name, email, password_hash, role, email_verified_at) VALUES ('usr_squat', 'Squatter', '${OWNER_EMAIL}', 'squat-hash', 'admin', NULL);
  `);
  return raw;
}

// ---------------------------------------------------------------------------
// Google, offline: an RS256 key of our own and its JWKS behind a fetch mock.

const KID = 'test-kid-1';
const keyPair = (await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
)) as CryptoKeyPair;
const publicJwk = { ...(await webcrypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes).toString('base64url');

async function googleCredential(sub: string, email: string): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 3600,
      email_verified: true,
      sub,
      email,
      name: 'Owner',
    })
  );
  const sig = new Uint8Array(
    await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

// ===========================================================================
// C1 (a) — the words.

const IGNORE = {
  ar: /فتجاهله[ا]? ولا تسجّل الدخول/,
  en: /ignore it and do not sign in\./,
  ckb: /پشتگوێی بخە و مەچۆ ژوورەوە\./,
};
const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;

test('C1a: VERIFY_SIGN_IN_REQUIRED tells whoever did not ask to ignore it and not sign in — ar, en and real Sorani', () => {
  for (const code of ['VERIFY_SIGN_IN_REQUIRED'] as const) {
    const { ar, en, ckb } = COST_REFUSALS[code];
    assert.match(ar, IGNORE.ar, `${code} ar`);
    assert.match(en, IGNORE.en, `${code} en`);
    assert.match(ckb, IGNORE.ckb, `${code} ckb`);
    assert.match(en, /did not ask for/);
    assert.match(ckb, /داوا/, 'Sorani "asked for"');
    assert.match(ckb, SORANI_ONLY);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${code}: Sorani writes ی and ک`);
    assert.notEqual(ckb, ar);
    assert.notEqual(ckb, en);
    // The server sentence carries it too, and the client renders the same three.
    assert.match(serverMessage(code), IGNORE.en);
    assert.match(serverMessage(code), IGNORE.ar);
    assert.deepEqual(REFUSAL_STRINGS[code], COST_REFUSALS[code]);
  }
  // The sign-in advice is still there for the owner who DID ask.
  assert.match(COST_REFUSALS.VERIFY_SIGN_IN_REQUIRED.en, /Sign in to it in this browser/);
});

test('C1a (review copy finding): OWNER_EMAIL_UNVERIFIED, read only inside the owner row, says what the first proof ends — not "do not sign in"', () => {
  const { ar, en, ckb } = COST_REFUSALS.OWNER_EMAIL_UNVERIFIED;
  // The "ignore it" advice is for a stranger to the row; this reader is in it.
  assert.doesNotMatch(ar, IGNORE.ar);
  assert.doesNotMatch(en, IGNORE.en);
  assert.doesNotMatch(ckb, IGNORE.ckb);
  assert.doesNotMatch(en, /do not sign in/i);
  // Before the owner presses send: the first verification ends the other
  // sessions and removes the password, Telegram, phone and any other Google.
  assert.match(en, /The first verification ends this account's sessions on other devices and removes its password, Telegram link, phone sign-in and any other Google account/);
  assert.match(en, /sign in with a code sent to this email, and you can set a new password\./);
  assert.match(ar, /أول تأكيد يُنهي جلسات هذا الحساب على الأجهزة الأخرى ويزيل كلمة مروره وربط تيليغرام والدخول بالهاتف/);
  assert.match(ckb, /یەکەم پشتڕاستکردنەوە/);
  assert.match(ckb, /وشەی نهێنی/);
  assert.match(ckb, /تێلێگرام/);
  assert.match(ckb, SORANI_ONLY);
  assert.doesNotMatch(ckb, ARABIC_ONLY, 'Sorani writes ی and ک');
  assert.notEqual(ckb, ar);
  assert.deepEqual(REFUSAL_STRINGS.OWNER_EMAIL_UNVERIFIED, COST_REFUSALS.OWNER_EMAIL_UNVERIFIED);
});

test('C1a: the verification email for the owner’s address carries the warning in all three languages — no other address does', () => {
  const LINK = 'https://levonis-iq.com/?verify_email=abc123';
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const owner = renderVerifyEmail(lang, LINK, { ownerAddress: true });
    const plain = renderVerifyEmail(lang, LINK);
    assert.match(owner.text, IGNORE[lang], `${lang} text`);
    assert.match(owner.html, IGNORE[lang], `${lang} html`);
    assert.doesNotMatch(plain.text, IGNORE[lang], `${lang}: an ordinary address is not warned`);
    assert.doesNotMatch(plain.html, IGNORE[lang]);
    // The warning sits under the button, before the small print.
    assert.ok(owner.text.indexOf(LINK) < owner.text.search(IGNORE[lang]), lang);
    assert.ok(owner.html.includes(LINK) && owner.text.includes(LINK));
    assert.equal(owner.subject, plain.subject);
  }
  const ckb = renderVerifyEmail('ckb', LINK, { ownerAddress: true }).text;
  const ar = renderVerifyEmail('ar', LINK, { ownerAddress: true }).text;
  assert.notEqual(ckb, ar);
  const ckbLine = ckb.split('\n').find((l) => IGNORE.ckb.test(l))!;
  assert.doesNotMatch(ckbLine, ARABIC_ONLY);
});

test('C1a: /verify-email/send queues the warned email for the owner’s address and the plain one for any other', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET locale = 'en' WHERE id IN ('usr_owner', 'usr_full'); UPDATE users SET email_verified_at = NULL WHERE id = 'usr_full'");
  const a = app(raw, MAIL);
  const owner = await sessionFor(raw, 'usr_owner');
  const full = await sessionFor(raw, 'usr_full');
  assert.equal((await call(a, owner.cookie, 'POST', '/api/auth/verify-email/send', {})).status, 200);
  assert.equal((await call(a, full.cookie, 'POST', '/api/auth/verify-email/send', {})).status, 200);
  await Promise.all(background);
  const payload = (to: string) =>
    JSON.parse(String(row<{ p: string }>(raw, "SELECT payload AS p FROM outbox WHERE recipient = ? AND event_key LIKE 'email_verify:%'", to)?.p)) as {
      text: string;
      html: string;
    };
  assert.match(payload(OWNER_EMAIL).text, IGNORE.en);
  assert.match(payload(OWNER_EMAIL).html, IGNORE.en);
  assert.doesNotMatch(payload('full@x.co').text, IGNORE.en);
});

test('C1a: the confirm card renders the refusal by code, so the new sentence reaches the page', () => {
  const banner = codeOf('src/components/auth/EmailVerifyBanner.tsx');
  assert.match(banner, /refusalText\('VERIFY_SIGN_IN_REQUIRED', lang\)/);
  const card = codeOf('src/components/auth/OwnerCostVerifyCard.tsx');
  assert.match(card, /refusalText\('OWNER_EMAIL_UNVERIFIED', lang\)/);
});

// ===========================================================================
// C1 (b) — the first proof ends every older session of that row.

test('C1b (probe P3): the real owner’s code sign-in proves the squat row — the squatter’s older session ends and never sees cost', async () => {
  const raw = squatWorld();
  const a = app(raw);
  const squatter = await sessionFor(raw, 'usr_squat');
  const squatter2 = await sessionFor(raw, 'usr_squat');
  const bystander = await sessionFor(raw, 'usr_full');
  assert.equal((await me(a, squatter.cookie))?.can_view_cost, false);

  await codeFor(raw, 'usr_squat', OWNER_EMAIL, '123456');
  const v = await call(a, '', 'POST', '/api/auth/otp/verify', { channel: 'email', identifier: OWNER_EMAIL, code: '123456' });
  assert.equal(v.status, 200, v.text);
  assert.ok(stamp(raw, 'usr_squat'), 'the code proved the mailbox and stamped the row');

  // Every session that existed before the proof is gone…
  assert.equal(await me(a, squatter.cookie), null, 'the squatter’s session ended');
  assert.equal(await me(a, squatter2.cookie), null);
  // …and only the session the code opened remains — it is the mailbox holder’s.
  assert.ok(v.newCookie);
  assert.deepEqual(sessionIds(raw, 'usr_squat').length, 1);
  assert.equal((await me(a, v.newCookie!))?.can_view_cost, true);
  // The squat row's password went with its sessions (see squatReentry below);
  // no other account is signed out or touched.
  assert.equal(passwordOf(raw, 'usr_squat'), null);
  assert.equal(passwordOf(raw, 'usr_full'), 'h');
  assert.equal((await me(a, bystander.cookie))?.id, 'usr_full');
  assert.equal(ended(raw, 'usr_squat'), 1, 'audited');
  assert.deepEqual(v.json.owner_first_proof, { sessions_ended: 2 }, 'the answer says what ended');
});

test('C1b (probe squatReentry): after the owner’s first proof, no way the squatter put on the row opens a session — password, Google, Telegram, phone, a reset link', async () => {
  const raw = squatWorld();
  const a = app(raw, MAIL);
  // The squatter's own ways in, all set up before the owner ever proved the mailbox.
  raw.prepare("UPDATE users SET password_hash = ?, google_sub = 'squatter-own-google-sub' WHERE id = 'usr_squat'").run(await hashPassword('squatter-pass-123'));
  linkTelegram(raw, 'usr_squat', '+9647700000001', 777001);
  await resetTokenFor(raw, 'usr_squat', 'squatter-reset-token-0123456789abcdef');
  const squatterOld = await sessionFor(raw, 'usr_squat');

  // Before: each of them signs in (the password, as the probe found it).
  const before = await call(a, '', 'POST', '/api/auth/login', { identifier: OWNER_EMAIL, password: 'squatter-pass-123' });
  assert.equal(before.status, 200, before.text);
  assert.equal((await me(a, before.newCookie!))?.can_view_cost, false, 'no cost before the proof');

  // The real owner signs in by code: the mailbox is proven for the first time.
  await codeFor(raw, 'usr_squat', OWNER_EMAIL, '123456');
  const v = await call(a, '', 'POST', '/api/auth/otp/verify', { channel: 'email', identifier: OWNER_EMAIL, code: '123456' });
  assert.equal(v.status, 200, v.text);
  assert.deepEqual(v.json.owner_first_proof, { sessions_ended: 2 });
  assert.equal((await me(a, v.newCookie!))?.can_view_cost, true, 'the mailbox holder sees cost');
  assert.equal(await me(a, squatterOld.cookie), null);
  assert.equal(await me(a, before.newCookie!), null);
  assert.deepEqual(waysIn(raw, 'usr_squat'), { password: null, google: null, phone: null, telegram: 0, resets: 0 });

  // The password: the same uniform refusal as any wrong password.
  for (const identifier of [OWNER_EMAIL, '+9647700000001']) {
    const login = await call(a, '', 'POST', '/api/auth/login', { identifier, password: 'squatter-pass-123' });
    assert.equal(login.status, 401, `${identifier}: ${login.text}`);
    assert.equal(login.json.code, 'LOGIN_FAILED');
  }
  // The squatter's own Google (a different address) no longer resolves to the row.
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  const g = await resolveGoogleIdentity(env, { sub: 'squatter-own-google-sub', email: 'squatter@gmail.com', name: 'S' });
  assert.notEqual(g.id, 'usr_squat', 'a fresh account of its own, with no cost');
  assert.equal((await me(a, (await sessionFor(raw, g.id)).cookie))?.can_view_cost, false);
  // Telegram sign-in resolves through a live link: there is none.
  const tg = row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM telegram_links WHERE phone_e164 = '+9647700000001' AND revoked_at IS NULL");
  assert.equal(tg?.n, 0);
  // A WhatsApp code to the squatter's phone finds no account.
  const id = `aotp_${Math.random().toString(36).slice(2)}`;
  raw
    .prepare('INSERT INTO auth_otp (id, channel, destination, purpose, user_id, verifier, max_attempts, expires_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, 'whatsapp', '+9647700000001', 'signin', 'usr_squat', await sha256Hex(`${id}:111222`), 5, new Date(Date.now() + 600_000).toISOString());
  const wa = await call(a, '', 'POST', '/api/auth/otp/verify', { channel: 'whatsapp', identifier: '+9647700000001', code: '111222' });
  assert.equal(wa.status, 401, wa.text);
  // The reset link mailed before the proof is spent.
  const reset = await call(a, '', 'POST', '/api/auth/reset-password', { token: 'squatter-reset-token-0123456789abcdef', password: 'new-squatter-pass-1' });
  assert.equal(reset.status, 400, reset.text);
  assert.equal(reset.json.code, 'TOKEN_USED');
  // Only the mailbox holder's session is left on the row.
  assert.deepEqual(sessionIds(raw, 'usr_squat').length, 1);
});

test('C1b: a code sign-in that is NOT a first proof of the owner’s address ends nothing', async () => {
  // The owner, already proven, signs in by code again: the old session stays.
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email_verified_at = '2026-10-01T00:00:00.000Z' WHERE id = 'usr_owner'");
  const a = app(raw);
  const old = await sessionFor(raw, 'usr_owner');
  await codeFor(raw, 'usr_owner', OWNER_EMAIL, '222222');
  assert.equal((await call(a, '', 'POST', '/api/auth/otp/verify', { channel: 'email', identifier: OWNER_EMAIL, code: '222222' })).status, 200);
  assert.equal((await me(a, old.cookie))?.id, 'usr_owner');
  assert.equal(ended(raw, 'usr_owner'), 0);
  assert.equal(passwordOf(raw, 'usr_owner'), 'h', 'a proven row keeps its password');

  // Any other address's first proof ends nothing either.
  raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'usr_full'");
  const fullOld = await sessionFor(raw, 'usr_full');
  await codeFor(raw, 'usr_full', 'full@x.co', '333333');
  assert.equal((await call(a, '', 'POST', '/api/auth/otp/verify', { channel: 'email', identifier: 'full@x.co', code: '333333' })).status, 200);
  assert.ok(stamp(raw, 'usr_full'));
  assert.equal((await me(a, fullOld.cookie))?.id, 'usr_full');
  assert.equal(passwordOf(raw, 'usr_full'), 'h', 'an ordinary address keeps every way in');
});

test('C1b: the emailed link — the confirming session keeps cost, every other session of the owner row ends', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const confirming = await sessionFor(raw, 'usr_owner');
  const older = await sessionFor(raw, 'usr_owner');
  const bystander = await sessionFor(raw, 'usr_full');
  await tokenFor(raw, 'usr_owner', 'c1b-link-owner-0123456789abcdef');
  const r = await call(a, confirming.cookie, 'POST', '/api/auth/verify-email/confirm', { token: 'c1b-link-owner-0123456789abcdef' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await me(a, confirming.cookie))?.can_view_cost, true, 'the same session opens cost');
  assert.equal(await me(a, older.cookie), null, 'the older session ended');
  assert.deepEqual(sessionIds(raw, 'usr_owner'), [confirming.id]);
  assert.equal((await me(a, bystander.cookie))?.id, 'usr_full');
  // The confirming session stays; the row's password goes with the other ways in.
  assert.equal(passwordOf(raw, 'usr_owner'), null);
  assert.equal(passwordOf(raw, 'usr_full'), 'h');
  assert.equal(ended(raw, 'usr_owner'), 1);
  assert.deepEqual(r.json.owner_first_proof, { sessions_ended: 1 });
});

test('C1b: an email change onto the owner’s address ends the row’s other sessions — and a move refused by UNIQUE ends none', async () => {
  // The address is free: usr_full moves onto it from its own session.
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email = 'owner-moved@x.co' WHERE id = 'usr_owner'");
  const a = app(raw);
  const confirming = await sessionFor(raw, 'usr_full');
  const older = await sessionFor(raw, 'usr_full');
  await tokenFor(raw, 'usr_full', 'c1b-move-0123456789abcdefghij', OWNER_EMAIL);
  // A reset link mailed to the OLD address before the move would otherwise set
  // a password on the row that now holds the owner's address.
  await resetTokenFor(raw, 'usr_full', 'c1b-move-old-reset-0123456789abcdef');
  const r = await call(a, confirming.cookie, 'POST', '/api/auth/verify-email/confirm', { token: 'c1b-move-0123456789abcdefghij' });
  assert.equal(r.status, 200, r.text);
  assert.equal(row<{ e: string }>(raw, 'SELECT email AS e FROM users WHERE id = ?', 'usr_full')?.e, OWNER_EMAIL);
  assert.equal(await me(a, older.cookie), null, 'the session from before the move ended');
  assert.deepEqual(sessionIds(raw, 'usr_full'), [confirming.id]);
  assert.equal(waysIn(raw, 'usr_full').resets, 0, 'the old address’s reset link is spent');
  assert.equal(passwordOf(raw, 'usr_full'), null);
  assert.deepEqual(r.json.owner_first_proof, { sessions_ended: 1 });

  // The address is taken: the move fails, and the purge in its batch is undone.
  const raw2 = seededCopyUnverifiedOwner();
  const b = app(raw2);
  const c2 = await sessionFor(raw2, 'usr_full');
  const o2 = await sessionFor(raw2, 'usr_full');
  await tokenFor(raw2, 'usr_full', 'c1b-move-taken-0123456789abcdef', OWNER_EMAIL);
  const refused = await call(b, c2.cookie, 'POST', '/api/auth/verify-email/confirm', { token: 'c1b-move-taken-0123456789abcdef' });
  assert.equal(refused.status, 409, refused.text);
  assert.equal((await me(b, o2.cookie))?.id, 'usr_full', 'nothing ended: the batch rolled back');
  assert.equal(row<{ e: string }>(raw2, 'SELECT email AS e FROM users WHERE id = ?', 'usr_full')?.e, 'full@x.co');
  assert.equal(passwordOf(raw2, 'usr_full'), 'h', 'and nothing was taken away');
});

for (const blank of [null, '', '   '] as const) {
  test(`C1b: a Google sign-in with the already-connected Google (stamp ${JSON.stringify(blank)}) ends the older session; the sign-in’s own session sees cost`, async () => {
    const raw = seededCopyUnverifiedOwner();
    raw.prepare("UPDATE users SET email_verified_at = ?, google_sub = 'google-owner-sub' WHERE id = 'usr_owner'").run(blank);
    const a = app(raw);
    const older = await sessionFor(raw, 'usr_owner');
    assert.equal((await me(a, older.cookie))?.owner_email_unverified, true);

    const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
    await resolveGoogleIdentity(env, { sub: 'google-owner-sub', email: OWNER_EMAIL, name: 'Owner' });
    const s = stamp(raw, 'usr_owner');
    assert.ok(s && s.trim() !== '', 'stamped');
    assert.equal(await me(a, older.cookie), null, 'the session from before the proof ended');
    // POST /google opens the sign-in's session right after resolving: it sees cost.
    const fresh = await sessionFor(raw, 'usr_owner');
    const user = await me(a, fresh.cookie);
    assert.equal(user?.can_view_cost, true);
    assert.equal(user?.owner_email_unverified, false);
    // The Google account is the proof and stays; the password goes.
    assert.equal(passwordOf(raw, 'usr_owner'), null);
    assert.equal(waysIn(raw, 'usr_owner').google, 'google-owner-sub');
  });
}

test('C1b: POST /google end to end — the older session ends, the response’s cookie sees cost; a second Google sign-in ends nothing', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET google_sub = 'google-owner-sub' WHERE id = 'usr_owner'");
  const a = app(raw);
  const older = await sessionFor(raw, 'usr_owner');
  const r = await call(a, '', 'POST', '/api/auth/google', { credential: await googleCredential('google-owner-sub', OWNER_EMAIL) });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.newCookie);
  assert.equal(await me(a, older.cookie), null);
  assert.equal((await me(a, r.newCookie!))?.can_view_cost, true);
  assert.deepEqual(r.json.owner_first_proof, { sessions_ended: 1 });

  const again = await call(a, '', 'POST', '/api/auth/google', { credential: await googleCredential('google-owner-sub', OWNER_EMAIL) });
  assert.equal(again.status, 200, again.text);
  assert.equal((await me(a, r.newCookie!))?.can_view_cost, true, 'a proven row is not signed out by the next sign-in');
  assert.equal(again.json.owner_first_proof, undefined, 'only the first proof says so');
  assert.equal(ended(raw, 'usr_owner'), 1);
});

test('C1b: POST /google/link — the linking session is kept, every other session of the owner row ends', async () => {
  const raw = seededCopyUnverifiedOwner();
  // An account without a password links on its session alone (the route's rule).
  raw.exec("UPDATE users SET password_hash = NULL WHERE id = 'usr_owner'");
  const a = app(raw);
  const linking = await sessionFor(raw, 'usr_owner');
  const older = await sessionFor(raw, 'usr_owner');
  const r = await call(a, linking.cookie, 'POST', '/api/auth/google/link', { credential: await googleCredential('google-link-sub', OWNER_EMAIL) });
  assert.equal(r.status, 200, r.text);
  assert.equal((await me(a, linking.cookie))?.can_view_cost, true);
  assert.equal(await me(a, older.cookie), null);
  assert.deepEqual(sessionIds(raw, 'usr_owner'), [linking.id]);
  // The Google account just linked is the proof and stays.
  assert.equal(waysIn(raw, 'usr_owner').google, 'google-link-sub');
  assert.deepEqual(r.json.owner_first_proof, { sessions_ended: 1 });
});

test('C1b: every stamping path goes through the one purge, in a batch with the stamp', () => {
  const src = codeOf('worker/routes/auth.ts');
  for (const via of ['google', 'google_link', 'email_change', 'email_link', 'otp']) {
    assert.match(src, new RegExp(`stampAndRecord\\([\\s\\S]{0,600}?'${via}'\\s*\\)`), via);
  }
  // No stamp is written outside it (the sign-up INSERTs create rows with no sessions yet).
  const writes = src.match(/UPDATE users SET (email = \?, )?email_verified_at/g) ?? [];
  const wrapped = src.match(/stampAndRecord\(/g) ?? [];
  assert.equal(writes.length, 5);
  assert.equal(wrapped.length, 6, 'five calls and the definition');
  const lib = codeOf('worker/lib/emailStamp.ts');
  assert.match(lib, /db\.batch\(\[\.\.\.purge, stamp\]\)/);
});

// ===========================================================================
// C2 — the session rule only when the token would change something.

test('C2 (probe P6): an already-verified owner opening an old plain link gets the ordinary "verified" — from any browser', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email_verified_at = '2026-10-01T00:00:00.000Z' WHERE id = 'usr_owner'");
  const a = app(raw);
  const ownerSession = await sessionFor(raw, 'usr_owner');
  await tokenFor(raw, 'usr_owner', 'p6-stale-0123456789abcdefghij');
  const r = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p6-stale-0123456789abcdefghij' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verified, true);
  assert.equal(await tokenUsed(raw, 'p6-stale-0123456789abcdefghij'), 1);
  assert.equal(stamp(raw, 'usr_owner'), '2026-10-01T00:00:00.000Z', 'the stamp is not rewritten');
  assert.equal((await me(a, ownerSession.cookie))?.can_view_cost, true, 'nobody is signed out by a no-op');

  // From another account's session, too.
  await tokenFor(raw, 'usr_owner', 'p6-stale-other-0123456789abcdef');
  const other = await sessionFor(raw, 'usr_full');
  const r2 = await call(a, other.cookie, 'POST', '/api/auth/verify-email/confirm', { token: 'p6-stale-other-0123456789abcdef' });
  assert.equal(r2.status, 200, r2.text);
});

test('C2: the rule still holds whenever the token WOULD change something', async () => {
  // An unverified owner row, no session: the link stays unused.
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  await tokenFor(raw, 'usr_owner', 'c2-unverified-0123456789abcdef');
  const r = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'c2-unverified-0123456789abcdef' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'VERIFY_SIGN_IN_REQUIRED');
  assert.equal(await tokenUsed(raw, 'c2-unverified-0123456789abcdef'), 0);

  // A blank stamp is not a stamp: still the rule.
  raw.exec("UPDATE users SET email_verified_at = '   ' WHERE id = 'usr_owner'");
  const blank = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'c2-unverified-0123456789abcdef' });
  assert.equal(blank.status, 403);

  // An ALREADY-verified row moving onto the free owner address: new_email always changes the row.
  const raw2 = seededCopyUnverifiedOwner();
  raw2.exec("UPDATE users SET email = 'owner-moved@x.co' WHERE id = 'usr_owner'");
  const b = app(raw2);
  await tokenFor(raw2, 'usr_full', 'c2-move-verified-0123456789abc', OWNER_EMAIL);
  const move = await call(b, '', 'POST', '/api/auth/verify-email/confirm', { token: 'c2-move-verified-0123456789abc' });
  assert.equal(move.status, 403);
  assert.equal(move.json.code, 'VERIFY_SIGN_IN_REQUIRED');
  assert.equal(await tokenUsed(raw2, 'c2-move-verified-0123456789abc'), 0);
});

// ===========================================================================
// The review's other probes, kept as regression cases.

test('probe P1: INITIAL_ADMIN_EMAIL and the stored address in any case or spacing still require the session', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw, { INITIAL_ADMIN_EMAIL: '  BOSS@X.CO ' });
  await tokenFor(raw, 'usr_owner', 'p1-owner-token-0123456789abcdef');
  assert.equal((await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p1-owner-token-0123456789abcdef' })).status, 403);
  raw.exec("UPDATE users SET email = 'Boss@X.co' WHERE id = 'usr_owner'");
  assert.equal((await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p1-owner-token-0123456789abcdef' })).status, 403);
  await tokenFor(raw, 'usr_full', 'p1-move-token-0123456789abcdef', 'BOSS@x.co ');
  const r3 = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p1-move-token-0123456789abcdef' });
  assert.equal(r3.status, 403, 'a move onto the owner address in another spelling is the owner address');
  assert.equal(r3.json.code, 'VERIFY_SIGN_IN_REQUIRED');
});

test('probe P2: expired and used owner links answer exactly like any other — no 403 oracle', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  await tokenFor(raw, 'usr_owner', 'p2-expired-0123456789abcdefgh', null, -1000);
  await tokenFor(raw, 'usr_full', 'p2-expired-full-0123456789abcd', null, -1000);
  const e1 = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p2-expired-0123456789abcdefgh' });
  const e2 = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p2-expired-full-0123456789abcd' });
  assert.equal(e1.status, 400);
  assert.equal(e1.text, e2.text);
  raw.exec('UPDATE email_verification_tokens SET used = 1');
  const u1 = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p2-expired-0123456789abcdefgh' });
  assert.equal(u1.status, 400);
  assert.equal(u1.json.code, 'TOKEN_USED');
});

test('probe P4: an ordinary email change confirms without a session; the link is then used', async () => {
  const raw = seededCopyUnverifiedOwner();
  const a = app(raw);
  const older = await sessionFor(raw, 'u1');
  await tokenFor(raw, 'u1', 'p4-change-0123456789abcdefghij', 'new-u1@x.co');
  const r = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p4-change-0123456789abcdefghij' });
  assert.equal(r.status, 200, r.text);
  assert.equal(row<{ e: string }>(raw, 'SELECT email AS e FROM users WHERE id = ?', 'u1')?.e, 'new-u1@x.co');
  assert.equal((await me(a, older.cookie))?.id, 'u1', 'an ordinary address signs nobody out');
  const again = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p4-change-0123456789abcdefghij' });
  assert.equal(again.status, 400);
  assert.equal(again.json.code, 'TOKEN_USED');
});

test('probe P5: a blank stamp is replaced by a code sign-in; a blank INITIAL_ADMIN_EMAIL means no owner rule at all', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email_verified_at = '   ' WHERE id = 'usr_owner'");
  const a = app(raw);
  await codeFor(raw, 'usr_owner', OWNER_EMAIL, '654321');
  const v = await call(a, '', 'POST', '/api/auth/otp/verify', { channel: 'email', identifier: OWNER_EMAIL, code: '654321' });
  assert.equal(v.status, 200, v.text);
  const s = stamp(raw, 'usr_owner');
  assert.ok(s && s.trim() !== '', JSON.stringify(s));

  const raw2 = seededCopyUnverifiedOwner();
  const b = app(raw2, { INITIAL_ADMIN_EMAIL: '' });
  const older = await sessionFor(raw2, 'usr_owner');
  await tokenFor(raw2, 'usr_owner', 'p5-blank-env-0123456789abcdef');
  const r = await call(b, '', 'POST', '/api/auth/verify-email/confirm', { token: 'p5-blank-env-0123456789abcdef' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await me(b, older.cookie))?.id, 'usr_owner', 'with no owner address configured, nothing is purged');
});

// ===========================================================================
// The purge's statements, as D1 will see them.

test('C1b: every purge statement binds exactly the parameters it names — D1 refuses any other count', () => {
  const seen: Array<{ sql: string; args: unknown[] }> = [];
  const fakeDb = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          seen.push({ sql, args });
          return {} as D1PreparedStatement;
        },
      };
    },
  } as unknown as D1Database;
  const env = { INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  for (const target of [
    { userId: 'u', kind: 'stamp', address: OWNER_EMAIL, keepSessionId: null },
    { userId: 'u', kind: 'stamp', address: OWNER_EMAIL, keepSessionId: 'sid', keepGoogleSub: 'sub' },
    { userId: 'u', kind: 'move', address: OWNER_EMAIL, keepSessionId: 'sid' },
  ] as const) {
    seen.length = 0;
    const stmts = ownerFirstProofPurge(fakeDb, env, target);
    assert.equal(stmts.length, 5, target.kind);
    for (const { sql, args } of seen) {
      const named = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
      assert.equal(Math.max(...named), args.length, `${target.kind}: ${sql.replace(/\s+/g, ' ').slice(0, 60)}`);
      assert.ok(!/\?(?!\d)/.test(sql), 'numbered parameters only');
    }
  }
  // Any other address: no statement at all.
  assert.deepEqual(ownerFirstProofPurge(fakeDb, env, { userId: 'u', kind: 'stamp', address: 'full@x.co', keepSessionId: null }), []);
  assert.deepEqual(
    ownerFirstProofPurge(fakeDb, { INITIAL_ADMIN_EMAIL: '' } as unknown as Env, { userId: 'u', kind: 'stamp', address: OWNER_EMAIL, keepSessionId: null }),
    []
  );
});

// ===========================================================================
// What the page says afterwards (review finding 5): ar, en and real Sorani.

test('the first proof is told to the person who made it — the confirm card in place, every sign-in in a toast', () => {
  // The words.
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const t = OWNER_FIRST_PROOF_STRINGS[lang];
    assert.ok(t.title.length > 5, lang);
    assert.match(t.body(3), /\(3\)/, `${lang}: the count of ended sessions`);
  }
  assert.match(OWNER_FIRST_PROOF_STRINGS.en.body(2), /the password, the Telegram link, phone sign-in and any other Google account/);
  const ckb = OWNER_FIRST_PROOF_STRINGS.ckb;
  assert.match(ckb.title + ckb.body(1), SORANI_ONLY);
  assert.doesNotMatch(ckb.title + ckb.body(1), ARABIC_ONLY, 'Sorani writes ی and ک');
  assert.notEqual(ckb.body(1), OWNER_FIRST_PROOF_STRINGS.ar.body(1));
  // Before the press, on the confirm card of the owner's own unverified session.
  assert.match(OWNER_FIRST_PROOF_STRINGS.en.before, /Confirming ends this account's sessions on other devices and removes its password, Telegram link, phone sign-in and any other Google account/);
  assert.match(OWNER_FIRST_PROOF_STRINGS.ar.before, /التأكيد يُنهي جلسات هذا الحساب/);
  assert.match(ckb.before, SORANI_ONLY);
  assert.doesNotMatch(ckb.before, ARABIC_ONLY);
  assert.notEqual(ckb.before, OWNER_FIRST_PROOF_STRINGS.ar.before);
  // The field is read only when the server sent it.
  assert.deepEqual(ownerFirstProofOf({ owner_first_proof: { sessions_ended: 2 } }), { sessions_ended: 2 });
  assert.deepEqual(ownerFirstProofOf({ owner_first_proof: { sessions_ended: 'x' } }), { sessions_ended: 0 });
  for (const none of [null, undefined, {}, { user: {} }, { owner_first_proof: null }]) assert.equal(ownerFirstProofOf(none), null);

  // Where it is said.
  const banner = codeOf('src/components/auth/EmailVerifyBanner.tsx');
  assert.match(banner, /setFirstProof\(ownerFirstProofOf\(res\)\);/);
  assert.match(banner, /OWNER_FIRST_PROOF_STRINGS\[lang\] \?\? OWNER_FIRST_PROOF_STRINGS\.ar\)\.body\(firstProof\.sessions_ended\)/);
  assert.match(banner, /\{user\?\.owner_email_unverified === true && \(\s*<p data-owner-first-proof="before"[^>]*>\s*\{\(OWNER_FIRST_PROOF_STRINGS\[lang\] \?\? OWNER_FIRST_PROOF_STRINGS\.ar\)\.before\}/);
  const code = codeOf('src/components/auth/CodeAuth.tsx');
  assert.match(code, /await refreshUser\(\);\s*announceOwnerFirstProof\(res\);/);
  const ctx = codeOf('src/AuthContext.tsx');
  assert.match(ctx, /if \(data\.owner_first_proof\) void import\('\.\/lib\/ownerFirstProof'\)\.then\(\(m\) => m\.announceOwnerFirstProof\(data\)\);/);
  const authPage = codeOf('src/pages/Auth.tsx');
  assert.match(authPage, /const res = await api\.post\('\/api\/auth\/google', \{ credential, referralCode: referral \}\);\s*await refreshUser\(\);\s*announceOwnerFirstProof\(res\);/);
});

// ===========================================================================
// Every other address keeps every way in (the review's probes R1–R3, now with
// the credentials the purge takes from the owner row).

test('probes R1–R3: a first proof of any other address ends no session and takes no password, Google, phone or Telegram', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET google_sub = 'g-full', email_verified_at = NULL WHERE id = 'usr_full'");
  linkTelegram(raw, 'usr_full', '+9647700000002', 777002);
  await resetTokenFor(raw, 'usr_full', 'full-reset-token-0123456789abcdef');
  const a = app(raw);

  // R1: a Google sign-in proves full@x.co.
  const fullOld = await sessionFor(raw, 'usr_full');
  const g = await call(a, '', 'POST', '/api/auth/google', { credential: await googleCredential('g-full', 'full@x.co') });
  assert.equal(g.status, 200, g.text);
  assert.ok(stamp(raw, 'usr_full'));
  assert.equal(g.json.owner_first_proof, undefined);
  assert.equal((await me(a, fullOld.cookie))?.id, 'usr_full', 'the older session survives');
  assert.deepEqual(waysIn(raw, 'usr_full'), { password: 'h', google: 'g-full', phone: '+9647700000002', telegram: 1, resets: 1 });

  // R2: a Google link and a plain link opened while signed out.
  raw.exec("UPDATE users SET password_hash = NULL, email_verified_at = NULL WHERE id = 'usr_asst'");
  const linking = await sessionFor(raw, 'usr_asst');
  const asstOld = await sessionFor(raw, 'usr_asst');
  const l = await call(a, linking.cookie, 'POST', '/api/auth/google/link', { credential: await googleCredential('g-asst', 'asst@x.co') });
  assert.equal(l.status, 200, l.text);
  assert.equal(l.json.owner_first_proof, undefined);
  assert.equal((await me(a, asstOld.cookie))?.id, 'usr_asst');
  raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'u_m'");
  const m1 = await sessionFor(raw, 'u_m');
  await tokenFor(raw, 'u_m', 'merchant-plain-0123456789abcdef');
  const c = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'merchant-plain-0123456789abcdef' });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.owner_first_proof, undefined);
  assert.equal((await me(a, m1.cookie))?.id, 'u_m');
  assert.equal(passwordOf(raw, 'u_m'), 'h');

  // R3: an email change onto a taken address is still 409; onto a free one, nothing ends.
  await tokenFor(raw, 'u_m', 'merchant-move-taken-0123456789ab', 'asst@x.co');
  assert.equal((await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'merchant-move-taken-0123456789ab' })).status, 409);
  await tokenFor(raw, 'u_m', 'merchant-move-free-0123456789abc', 'new-m@x.co');
  const f = await call(a, '', 'POST', '/api/auth/verify-email/confirm', { token: 'merchant-move-free-0123456789abc' });
  assert.equal(f.status, 200, f.text);
  assert.equal((await me(a, m1.cookie))?.email, 'new-m@x.co');
  assert.equal(passwordOf(raw, 'u_m'), 'h');
  assert.equal(ended(raw, 'usr_full') + ended(raw, 'usr_asst') + ended(raw, 'u_m'), 0, 'no first-proof audit for any of them');
});

test('C1b: an owner account Google has just created had no other way in — nothing is reported or audited', async () => {
  const raw = seededCopyUnverifiedOwner();
  raw.exec("UPDATE users SET email = 'owner-moved@x.co', email_verified_at = '2026-01-01T00:00:00.000Z' WHERE id = 'usr_owner'");
  const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: OWNER_EMAIL } as unknown as Env;
  const out: { ownerFirstProof?: unknown } = {};
  const created = await resolveGoogleIdentity(env, { sub: 'brand-new-owner-sub', email: OWNER_EMAIL, name: 'Owner' }, '', out as never);
  assert.notEqual(created.id, 'usr_owner');
  assert.ok(stamp(raw, created.id), 'stamped by the sign-in');
  assert.equal(out.ownerFirstProof, null, 'no toast saying a password was removed from an account that never had one');
  assert.equal(ended(raw, created.id), 0);
  assert.equal(waysIn(raw, created.id).google, 'brand-new-owner-sub', 'the proving Google account stays');
});
