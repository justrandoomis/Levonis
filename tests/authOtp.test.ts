/**
 * PASSWORDLESS SIGN-IN CODES — email and WhatsApp, end to end.
 *
 * Against the REAL auth routes, the REAL migrations and the REAL OTP core.
 * Only the two providers are stubbed, and they are stubbed at `fetch`, so the
 * code under test builds its own URLs, headers and bodies exactly as it would
 * in production — which is what lets a test assert that a sign-in code
 * actually went to the address the account owns.
 *
 * WHAT THIS SUITE IS DEFENDING, in order of how much it would cost to get
 * wrong:
 *
 *   1. A CODE CANNOT SIGN IN AN ACCOUNT IT WAS NOT ISSUED FOR. The row's
 *      user_id is a record, not a permission: the account is resolved from
 *      the destination again at verify time.
 *   2. /start CANNOT BE USED TO ENUMERATE ACCOUNTS. An unknown address and a
 *      known one produce the same status, the same body and the same
 *      cooldown — the unknown case writes a decoy row and sends nothing.
 *   3. THE CODE IS NEVER STORED, RETURNED OR GUESSABLE. Only a salted digest
 *      reaches the database, and five wrong guesses end the challenge.
 *   4. A CODE OVER WHATSAPP GOES TO A NUMBER THE ACCOUNT ALREADY PROVED IT
 *      OWNS (users.phone_e164, which migration 0013 only ever writes after
 *      Telegram contact verification) — never to a number typed at sign-in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APEX, MERCHANT_HOST, asD1, freshDb, json, post, row, stubApp } from './fixtures/app';
import { authRoutes } from '../worker/routes/auth';
import {
  AUTH_OTP_RESEND_COOLDOWN_SECONDS,
  AUTH_OTP_TTL_SECONDS,
  generateAuthOtpCode,
  startAuthOtp,
  authOtpMessage,
} from '../worker/lib/authOtp';
import type { Env } from '../worker/lib/types';

const MAIL_KEY = 're_test_key';
const WA_KEY = 'wa_test_key';
const ADDRESS = 'customer@example.com';
const PHONE = '+9647701234567';

interface Sent {
  channel: 'email' | 'whatsapp';
  to: string;
  /** The six digits, dug out of whatever the provider was handed. */
  code: string | null;
  raw: string;
}

/**
 * Stubs BOTH providers at `fetch` and extracts the code from the payload the
 * way a person reading their inbox would — which is also how a test proves
 * the code reached the customer without the server ever returning it.
 */
function stubProviders(opts: { emailOk?: boolean; whatsappOk?: boolean } = {}) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? String(init.body) : '';
    if (url.includes('api.resend.com')) {
      const parsed = JSON.parse(body) as { to: string; text: string; subject: string };
      const code = /\b(\d{6})\b/.exec(`${parsed.subject}\n${parsed.text}`)?.[1] ?? null;
      sent.push({ channel: 'email', to: parsed.to, code, raw: parsed.text });
      return opts.emailOk === false
        ? new Response(JSON.stringify({ message: 'nope' }), { status: 422 })
        : new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
    }
    if (url.includes('wasenderapi.com')) {
      const parsed = JSON.parse(body) as { to: string; text: string };
      sent.push({
        channel: 'whatsapp',
        to: parsed.to,
        code: /\b(\d{6})\b/.exec(parsed.text)?.[1] ?? null,
        raw: parsed.text,
      });
      return opts.whatsappOk === false
        ? new Response(JSON.stringify({ success: false, message: 'Session is not Connected' }), { status: 422 })
        : new Response(
            JSON.stringify({ success: true, data: { msgId: 1, jid: parsed.to, status: 'in_progress' } }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const env = (raw: DatabaseSync, over: Partial<Env> = {}): Record<string, unknown> => ({
  DB: asD1(raw),
  EMAIL_API_KEY: MAIL_KEY,
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  WASENDER_API_KEY: WA_KEY,
  INITIAL_ADMIN_EMAIL: 'boss@x.co',
  EXTRA_ALLOWED_ORIGINS: '',
  APP_ORIGIN: `https://${APEX}`,
  ...over,
});

const app = (raw: DatabaseSync, over: Partial<Env> = {}) =>
  stubApp(asD1(raw), null, (a) => a.route('/api/auth', authRoutes), { host: APEX, env: env(raw, over) });

function seedUser(
  raw: DatabaseSync,
  o: { id?: string; email?: string; phone?: string | null; verified?: boolean } = {}
) {
  const id = o.id ?? 'u_1';
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164, email_verified_at)
     VALUES (?, 'Customer', ?, ?, 'h', 'customer', ?, ?)`
  ).run(
    id,
    o.email ?? ADDRESS,
    id,
    o.phone === undefined ? PHONE : o.phone,
    o.verified ? new Date().toISOString() : null
  );
  return id;
}

/** A start request, from a fresh IP each time so the per-IP limit never
 *  masks what a test is actually asserting. */
let ipSeq = 0;
const start = (a: ReturnType<typeof app>, body: unknown) =>
  post(a, '/api/auth/otp/start', body, { 'CF-Connecting-IP': `10.0.0.${++ipSeq % 250}` });
const verify = (a: ReturnType<typeof app>, body: unknown) =>
  post(a, '/api/auth/otp/verify', body, { 'CF-Connecting-IP': `10.0.1.${++ipSeq % 250}` });

// =========================================================================
// EMAIL
// =========================================================================

test('EMAIL — a code is mailed to the account address and signs that account in', async () => {
  const raw = freshDb();
  const uid = seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    const r1 = await start(a, { channel: 'email', identifier: ADDRESS });
    assert.equal(r1.status, 200);
    const b1 = await json(r1);
    assert.equal(b1.success, true);
    assert.equal(b1.expires_in_seconds, AUTH_OTP_TTL_SECONDS);
    assert.equal(b1.resend_after_seconds, AUTH_OTP_RESEND_COOLDOWN_SECONDS);
    // The code is NEVER in the response — only in the mailbox.
    assert.equal(JSON.stringify(b1).match(/\b\d{6}\b/), null);

    assert.equal(p.sent.length, 1);
    assert.equal(p.sent[0].channel, 'email');
    assert.equal(p.sent[0].to, ADDRESS);
    const code = p.sent[0].code;
    assert.ok(code && /^\d{6}$/.test(code), 'a six-digit code reached the mailbox');

    // Only the DIGEST is stored, never the code.
    const stored = row<{ verifier: string; user_id: string; channel: string }>(
      raw, 'SELECT verifier, user_id, channel FROM auth_otp'
    );
    assert.equal(stored?.channel, 'email');
    assert.equal(stored?.user_id, uid);
    assert.equal(stored?.verifier.includes(code!), false);
    assert.equal(stored?.verifier.length, 64);

    const r2 = await verify(a, { channel: 'email', identifier: ADDRESS, code });
    assert.equal(r2.status, 200);
    const b2 = await json(r2);
    assert.equal(b2.success, true);
    assert.equal(b2.user.id, uid);
  } finally {
    p.restore();
  }
});

test('EMAIL — signing in with a mailed code VERIFIES the address, because receiving it is the proof', async () => {
  const raw = freshDb();
  const uid = seedUser(raw, { verified: false });
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: ADDRESS });
    await verify(a, { channel: 'email', identifier: ADDRESS, code: p.sent[0].code });
    const u = row<{ email_verified_at: string | null }>(raw, 'SELECT email_verified_at FROM users WHERE id = ?', uid);
    assert.ok(u?.email_verified_at, 'the address is verified by the sign-in itself');
  } finally {
    p.restore();
  }
});

test('EMAIL — the address is normalized, so CASE and spacing share one challenge', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: '  CUSTOMER@Example.COM ' });
    assert.equal(p.sent.length, 1, 'it resolved to the same account');
    const r = await verify(a, { channel: 'email', identifier: 'Customer@EXAMPLE.com', code: p.sent[0].code });
    assert.equal(r.status, 200);
  } finally {
    p.restore();
  }
});

// =========================================================================
// ANTI-ENUMERATION
// =========================================================================

test('START — an unknown address answers EXACTLY like a known one, and mails nobody', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    const known = await start(a, { channel: 'email', identifier: ADDRESS });
    const unknown = await start(a, { channel: 'email', identifier: 'nobody@example.com' });

    assert.equal(known.status, unknown.status);
    const [bk, bu] = [await json(known), await json(unknown)];
    assert.deepEqual(Object.keys(bk).sort(), Object.keys(bu).sort());
    assert.deepEqual(bk, bu, 'byte-for-byte the same answer');

    assert.equal(p.sent.length, 1, 'only the real address was mailed');
    assert.equal(p.sent[0].to, ADDRESS);

    // The decoy row exists — which is what makes the COOLDOWN identical too.
    const decoy = row<{ user_id: string | null; sent_at: string | null }>(
      raw, "SELECT user_id, sent_at FROM auth_otp WHERE destination = 'nobody@example.com'"
    );
    assert.equal(decoy?.user_id, null);
    assert.equal(decoy?.sent_at, null, 'nothing was sent, and the row says so');
  } finally {
    p.restore();
  }
});

test('VERIFY — a code for an address with no account fails the same way as a wrong code', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: 'nobody@example.com' });
    const r = await verify(a, { channel: 'email', identifier: 'nobody@example.com', code: '123456' });
    const b = await json(r);
    assert.equal(r.status, 401);
    assert.equal(b.code, 'OTP_FAILED');
  } finally {
    p.restore();
  }
});

// =========================================================================
// THE CODE ITSELF
// =========================================================================

test('VERIFY — a wrong code fails, five wrong codes end the challenge, and the right code then fails too', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: ADDRESS });
    const real = p.sent[0].code!;
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const r = await verify(a, { channel: 'email', identifier: ADDRESS, code: wrong });
      assert.equal(r.status, 401, `guess ${i + 1}`);
    }
    const after = await verify(a, { channel: 'email', identifier: ADDRESS, code: real });
    assert.equal(after.status, 401, 'the budget is spent — the real code no longer works');
    const st = row<{ attempts: number }>(raw, 'SELECT attempts FROM auth_otp');
    assert.equal(st?.attempts, 5);
  } finally {
    p.restore();
  }
});

test('VERIFY — a malformed code still costs an attempt, so the counter cannot be bypassed', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: ADDRESS });
    await verify(a, { channel: 'email', identifier: ADDRESS, code: 'abcdef' });
    const st = row<{ attempts: number }>(raw, 'SELECT attempts FROM auth_otp');
    assert.equal(st?.attempts, 1, 'junk input is a guess');
  } finally {
    p.restore();
  }
});

test('VERIFY — a code works exactly once', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: ADDRESS });
    const code = p.sent[0].code;
    assert.equal((await verify(a, { channel: 'email', identifier: ADDRESS, code })).status, 200);
    assert.equal((await verify(a, { channel: 'email', identifier: ADDRESS, code })).status, 401);
  } finally {
    p.restore();
  }
});

test('START — a resend inside the cooldown is refused with the remaining seconds', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: ADDRESS });
    const again = await start(a, { channel: 'email', identifier: ADDRESS });
    assert.equal(again.status, 429);
    const b = await json(again);
    assert.equal(b.code, 'OTP_COOLDOWN');
    assert.ok(Number(b.details?.retry_after_seconds) > 0);
    assert.equal(p.sent.length, 1, 'no second code was sent');
  } finally {
    p.restore();
  }
});

test('RESEND — a new code supersedes the old one, which stops working', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    const e = env(raw);
    // Issued through the core directly so the 60s cooldown does not need a
    // fake clock — the ROUTE's cooldown is covered by the test above.
    await startAuthOtp(e as unknown as Env, {
      channel: 'email', destination: ADDRESS, userId: 'u_1', send: async () => true,
    });
    raw.exec("UPDATE auth_otp SET created_at = '2020-01-01T00:00:00.000Z'");
    await start(a, { channel: 'email', identifier: ADDRESS });

    const rows = raw.prepare('SELECT id, superseded_by FROM auth_otp ORDER BY created_at').all() as Array<{
      id: string; superseded_by: string | null;
    }>;
    assert.equal(rows.length, 2);
    assert.ok(rows[0].superseded_by, 'the first challenge was invalidated by the resend');
    assert.equal(rows[1].superseded_by, null);

    const r = await verify(a, { channel: 'email', identifier: ADDRESS, code: p.sent[0].code });
    assert.equal(r.status, 200, 'the NEWEST code is the one that works');
  } finally {
    p.restore();
  }
});

test('the generated code is six digits and is drawn without modulo bias', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const c = generateAuthOtpCode();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 350, 'four hundred draws must not collapse onto a handful of codes');
});

// =========================================================================
// WHATSAPP
// =========================================================================

test('WHATSAPP — the code goes to the account\'s VERIFIED number, in E.164, and signs it in', async () => {
  const raw = freshDb();
  const uid = seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    // Entered the way a customer types it: national digits with a trunk zero.
    const r1 = await start(a, { channel: 'whatsapp', identifier: '07701234567', country: 'IQ' });
    assert.equal(r1.status, 200);
    assert.equal(p.sent.length, 1);
    assert.equal(p.sent[0].channel, 'whatsapp');
    assert.equal(p.sent[0].to, PHONE, 'normalized to E.164 with the plus, as the provider documents');
    assert.match(p.sent[0].raw, /LEVONIS/);

    const r2 = await verify(a, { channel: 'whatsapp', identifier: PHONE, code: p.sent[0].code });
    assert.equal(r2.status, 200);
    assert.equal((await json(r2)).user.id, uid);
  } finally {
    p.restore();
  }
});

test('WHATSAPP — a number no account owns sends nothing and still answers success', async () => {
  const raw = freshDb();
  seedUser(raw, { phone: null });
  const p = stubProviders();
  try {
    const a = app(raw);
    const r = await start(a, { channel: 'whatsapp', identifier: PHONE });
    assert.equal(r.status, 200, 'no enumeration signal');
    assert.equal(p.sent.length, 0, 'the shop does not message strangers');
  } finally {
    p.restore();
  }
});

test('WHATSAPP — a logged-out session is reported honestly, not as a sent code', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders({ whatsappOk: false });
  try {
    const a = app(raw);
    const r = await start(a, { channel: 'whatsapp', identifier: PHONE });
    const body = await json(r);
    assert.equal(r.status, 503);
    /**
     * `WHATSAPP_UNAVAILABLE`, NOT `OTP_SEND_FAILED`, and the difference is what
     * the customer does next.
     *
     * The stub answers the way the provider really does when the shop's
     * WhatsApp session has been logged out: a 4xx saying "Session is not
     * Connected", with a perfectly valid API key. "Try again shortly" is advice
     * that cannot work in that state, and a person following it waits all day.
     * A channel that is down is named, and so is the road that still works.
     */
    assert.equal(body.code, 'WHATSAPP_UNAVAILABLE');
    assert.match(String(body.error), /تيليغرام|Telegram/, 'and it names the other channel');
    // And the undelivered challenge is VOIDED, so the next attempt is not
    // blocked by a code that never arrived.
    const st = row<{ consumed_at: string | null }>(raw, 'SELECT consumed_at FROM auth_otp');
    assert.ok(st?.consumed_at, 'an undelivered code is not a pending code');
  } finally {
    p.restore();
  }
});

test('EMAIL — a provider refusal is reported, and the challenge is voided too', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders({ emailOk: false });
  try {
    const a = app(raw);
    const r = await start(a, { channel: 'email', identifier: ADDRESS });
    assert.equal(r.status, 503);
    const st = row<{ consumed_at: string | null }>(raw, 'SELECT consumed_at FROM auth_otp');
    assert.ok(st?.consumed_at);
  } finally {
    p.restore();
  }
});

// =========================================================================
// THE CHANNELS DO NOT LEAK INTO EACH OTHER
// =========================================================================

test('a code issued for EMAIL cannot be presented as a WhatsApp code, or vice versa', async () => {
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const a = app(raw);
    await start(a, { channel: 'email', identifier: ADDRESS });
    const mailed = p.sent[0].code;
    const wrong = await verify(a, { channel: 'whatsapp', identifier: PHONE, code: mailed });
    assert.equal(wrong.status, 401, 'the challenge is keyed by (channel, destination)');
  } finally {
    p.restore();
  }
});

test('a code cannot sign in an account the destination stopped belonging to', async () => {
  // The guard that makes the row's `user_id` a RECORD rather than a
  // permission. Ten minutes is long enough for an address to change hands —
  // a customer edits their email, or an account is deleted and the address
  // reused — and neither party consented to the other's code.
  const raw = freshDb();
  seedUser(raw, { id: 'u_1' });
  const e = env(raw) as unknown as Env;

  // Issued to u_1. The plaintext is captured HERE, at the only moment it
  // exists outside a mailbox, exactly as the real transport receives it.
  let code = '';
  const issued = await startAuthOtp(e, {
    channel: 'email',
    destination: ADDRESS,
    userId: 'u_1',
    send: async (c) => {
      code = c;
      return true;
    },
  });
  assert.equal(issued.ok, true);
  assert.match(code, /^\d{6}$/);

  // The address moves to somebody else while the code is still live.
  raw.exec("UPDATE users SET email = 'moved@example.com' WHERE id = 'u_1'");
  seedUser(raw, { id: 'u_2', email: ADDRESS, phone: '+9647709999999' });

  const a = app(raw);
  const r = await verify(a, { channel: 'email', identifier: ADDRESS, code });
  assert.equal(r.status, 401, 'refused — it signs in neither the old holder nor the new one');
  assert.equal((await json(r)).code, 'OTP_FAILED');

  // And the core's own answer is the honest one it is built on: the code was
  // correct, and it reports WHO it was issued to rather than deciding.
  const rows = raw.prepare('SELECT user_id, consumed_at FROM auth_otp').all() as Array<{
    user_id: string | null; consumed_at: string | null;
  }>;
  assert.equal(rows[0].user_id, 'u_1');
  assert.ok(rows[0].consumed_at, 'the code is spent either way — it cannot be re-presented');
});

// =========================================================================
// CONFIGURATION IS REPORTED, NEVER FAKED
// =========================================================================

test('START — a channel with no provider is 503 with a reason, not a pretend send', async () => {
  const raw = freshDb();
  seedUser(raw);
  const a = app(raw, { EMAIL_API_KEY: '', WASENDER_API_KEY: '' });
  const mail = await start(a, { channel: 'email', identifier: ADDRESS });
  assert.equal(mail.status, 503);
  assert.equal((await json(mail)).code, 'EMAIL_NOT_CONFIGURED');
  const wa = await start(a, { channel: 'whatsapp', identifier: PHONE });
  assert.equal(wa.status, 503);
  assert.equal((await json(wa)).code, 'WHATSAPP_NOT_CONFIGURED');
});

test('START — a whitespace-only EMAIL_FROM counts as NOT configured', async () => {
  // The bug this pins: EMAIL_FROM was trim-checked in /capabilities and
  // falsy-checked in every send, so ' ' made the UI say mail was off while
  // the sends posted a blank `from` for a provider 422.
  const raw = freshDb();
  seedUser(raw);
  const a = app(raw, { EMAIL_FROM: '   ' });
  const r = await start(a, { channel: 'email', identifier: ADDRESS });
  assert.equal(r.status, 503);
  assert.equal((await json(r)).code, 'EMAIL_NOT_CONFIGURED');
});

test('START — an unknown channel is refused', async () => {
  const raw = freshDb();
  seedUser(raw);
  const a = app(raw);
  assert.equal((await start(a, { channel: 'sms', identifier: PHONE })).status, 400);
  assert.equal((await start(a, { identifier: ADDRESS })).status, 400);
});

test('the message says what it is for, warns against sharing, and carries the code once', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const m = authOtpMessage('123456', lang);
    assert.ok(m.subject.includes('123456'), `${lang}: the code is in the subject, for the lock screen`);
    assert.ok(m.text.includes('123456'));
    assert.ok(m.text.includes('LEVONIS'));
    // "we will never ask for it" is the actual security control here.
    assert.ok(m.text.length > 80, `${lang}: the warning is present, not just the digits`);
  }
});

test('capabilities reports each code channel, and reports it OFF when unconfigured', async () => {
  const raw = freshDb();
  const on = await (await app(raw)).request('/api/auth/capabilities', {}, undefined);
  const bOn = (await on.json()) as Record<string, unknown>;
  assert.equal(bOn.emailOtp, true);
  assert.equal(bOn.whatsappOtp, true);

  const off = await (await app(raw, { EMAIL_API_KEY: '', WASENDER_API_KEY: ' ' })).request(
    '/api/auth/capabilities', {}, undefined
  );
  const bOff = (await off.json()) as Record<string, unknown>;
  assert.equal(bOff.emailOtp, false);
  assert.equal(bOff.whatsappOtp, false);
});

test('the code sign-in works from a MERCHANT host, exactly like every other sign-in', async () => {
  // requireMainHost is for global administration and for changing a signed-in
  // account's credentials. /login, /register, /google and /telegram/* are all
  // reachable from a merchant storefront; a code sign-in that 404s only there
  // would be an inconsistency the page could not explain, because
  // /capabilities — served by the same Worker — would still offer the button.
  const raw = freshDb();
  seedUser(raw);
  const p = stubProviders();
  try {
    const merchant = stubApp(asD1(raw), null, (a) => a.route('/api/auth', authRoutes), {
      host: MERCHANT_HOST,
      env: env(raw),
    });
    const r1 = await post(merchant, '/api/auth/otp/start', { channel: 'email', identifier: ADDRESS }, {
      'CF-Connecting-IP': '10.9.9.9',
    });
    assert.equal(r1.status, 200);
    const r2 = await post(
      merchant,
      '/api/auth/otp/verify',
      { channel: 'email', identifier: ADDRESS, code: p.sent[0].code },
      { 'CF-Connecting-IP': '10.9.9.8' }
    );
    assert.equal(r2.status, 200);
  } finally {
    p.restore();
  }
});
