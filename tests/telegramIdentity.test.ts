/**
 * TELEGRAM AS AN IDENTITY CHANNEL — the whole journey, end to end.
 *
 * This is the one flow in the shop that turns a stranger into an account, and
 * it was the least tested thing in the codebase: three trivial pure-function
 * tests and nothing at all touching the webhook. Every predicate that decides
 * whether somebody owns a phone number lived behind an HTTP handler no test
 * ever called.
 *
 * The journey, as a customer actually walks it:
 *
 *   POST /api/auth/telegram/start   → a deep link + a continuation token that
 *                                     stays in THIS browser
 *   POST /api/telegram/webhook      → "/start <nonce>" binds their private
 *                                     chat to the challenge
 *   POST /api/telegram/webhook      → they tap "share my phone number";
 *                                     Telegram sends a `contact`
 *   (server)                        → a 6-digit code into that same chat
 *   POST /api/auth/telegram/complete→ the code is typed back here, and only
 *                                     then does an account exist
 *
 * WHAT THIS SUITE IS REALLY DEFENDING — four predicates, each of which is the
 * only thing standing between a stranger and somebody else's account:
 *
 *   1. `contact.user_id === msg.from.id`. A contact CARD for another person
 *      carries their user_id, and a typed number carries none at all. Without
 *      this check, "share a contact" would let anyone claim any number.
 *   2. A FORWARDED message proves nothing about who sent it.
 *   3. `phonesMatch` is full E.164 equality, never a suffix match — +9647701
 *      and +19647701 are different people.
 *   4. The conversation is PRIVATE-chat only. A group is not an identity.
 *
 * Plus the two properties the whole design rests on: the deep-link nonce and
 * the continuation token are stored only as SHA-256 digests, and /start says
 * exactly the same thing whether or not the phone belongs to an account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { authRoutes } from '../worker/routes/auth';
import { telegramRoutes } from '../worker/routes/telegram';
import type { Env } from '../worker/lib/types';

const TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const HOOK_SECRET = 'customer-hook-secret';
const BOT = 'levonis_bot';
const PHONE_NATIONAL = '07701234567';
const PHONE_E164 = '+9647701234567';
const TG_USER = 5550001;
const CHAT = 9990001;

interface TgCall {
  method: string;
  body: Record<string, unknown>;
}

function stubTelegram(opts: { sendOk?: boolean } = {}) {
  const calls: TgCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = /api\.telegram\.org\/bot([^/]+)\/(\w+)/.exec(String(input));
    if (!m) return real(input as RequestInfo, init);
    const method = m[2];
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON */
    }
    calls.push({ method, body });
    if (method === 'getMe') {
      return new Response(JSON.stringify({ ok: true, result: { username: BOT } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'sendMessage' && opts.sendOk === false) {
      return new Response(JSON.stringify({ ok: false, description: 'bot was blocked by the user' }), { status: 403 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    /** The text of every message the bot sent into a chat. */
    texts: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.text ?? '')),
    /** The six digits, read the way the customer reads them: out of the chat. */
    code: () => {
      for (const t of [...calls].reverse()) {
        if (t.method !== 'sendMessage') continue;
        const m = /\b(\d{6})\b/.exec(String(t.body.text ?? ''));
        if (m) return m[1];
      }
      return null;
    },
    restore: () => { globalThis.fetch = real; },
  };
}

const env = (raw: DatabaseSync, over: Partial<Env> = {}): Record<string, unknown> => ({
  DB: asD1(raw),
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: HOOK_SECRET,
  INITIAL_ADMIN_EMAIL: 'boss@x.co',
  EXTRA_ALLOWED_ORIGINS: '',
  APP_ORIGIN: `https://${APEX}`,
  ...over,
});

const app = (raw: DatabaseSync, over: Partial<Env> = {}) =>
  stubApp(
    asD1(raw),
    null,
    (a) => {
      a.route('/api/auth', authRoutes);
      a.route('/api/telegram', telegramRoutes);
    },
    { host: APEX, env: env(raw, over) }
  );

let updateSeq = 1000;
const hook = (a: ReturnType<typeof app>, update: unknown, secret: string | null = HOOK_SECRET) =>
  post(a, '/api/telegram/webhook', update, secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret });

/** A private-chat message, shaped the way Telegram shapes it. */
const privateMsg = (p: {
  text?: string;
  contact?: Record<string, unknown>;
  from?: number;
  chat?: number;
  type?: string;
  forwarded?: boolean;
}) => ({
  update_id: ++updateSeq,
  message: {
    message_id: 7,
    chat: { id: p.chat ?? CHAT, type: p.type ?? 'private' },
    from: { id: p.from ?? TG_USER, username: 'customer' },
    ...(p.forwarded ? { forward_date: 1_700_000_000 } : {}),
    ...(p.text !== undefined ? { text: p.text } : {}),
    ...(p.contact ? { contact: p.contact } : {}),
  },
});

/** The customer's own contact card, as Telegram builds it on "share my number". */
const ownContact = (phone = PHONE_E164, userId = TG_USER) => ({
  phone_number: phone,
  first_name: 'Customer',
  user_id: userId,
});

/** Start a sign-up/sign-in flow and return what the browser holds. */
async function startFlow(a: ReturnType<typeof app>, purpose: 'signup' | 'login', phone = PHONE_NATIONAL) {
  const r = await post(a, '/api/auth/telegram/start', { purpose, phone });
  assert.equal(r.status, 200, 'start must succeed');
  const b = await json(r);
  const nonce = String(b.deep_link).split('start=')[1];
  return { token: String(b.continuation_token), nonce, body: b };
}

const challengeRow = (raw: DatabaseSync) =>
  row<{ id: string; state: string; chat_id: number | null; telegram_user_id: number | null; otp_sent_at: string | null }>(
    raw,
    'SELECT id, state, chat_id, telegram_user_id, otp_sent_at FROM link_challenges ORDER BY created_at DESC LIMIT 1'
  );

// =========================================================================
// THE WEBHOOK DOOR
// =========================================================================

test('WEBHOOK — the right secret is accepted, a wrong one is 403, a missing one is 403, an unset one is 503', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    assert.equal((await hook(a, privateMsg({ text: '/start' }))).status, 200);
    assert.equal((await hook(a, privateMsg({ text: '/start' }), 'wrong')).status, 403);
    assert.equal((await hook(a, privateMsg({ text: '/start' }), null)).status, 403);

    const off = app(raw, { TELEGRAM_WEBHOOK_SECRET: '' });
    assert.equal((await hook(off, privateMsg({ text: '/start' }))).status, 503, 'honestly unconfigured, not silently open');
  } finally {
    t.restore();
  }
});

test('WEBHOOK — a redelivered update is acknowledged once and processed once', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    const update = privateMsg({ text: '/start' });
    assert.equal((await hook(a, update)).status, 200);
    const after = t.calls.length;
    assert.equal((await hook(a, update)).status, 200, 'Telegram must be told to stop retrying');
    assert.equal(t.calls.length, after, 'and the bot must not answer the same update twice');
  } finally {
    t.restore();
  }
});

test('WEBHOOK — a GROUP message is ignored: a group is not an identity', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    await startFlow(a, 'signup');
    const before = t.calls.length;
    await hook(a, privateMsg({ text: '/start x'.repeat(4), type: 'supergroup', chat: -100123 }));
    await hook(a, privateMsg({ contact: ownContact(), type: 'supergroup', chat: -100123 }));
    assert.equal(t.calls.length, before, 'nothing was said, and nothing was bound');
    assert.equal(challengeRow(raw)?.state, 'pending');
  } finally {
    t.restore();
  }
});

// =========================================================================
// THE DEEP LINK
// =========================================================================

test('START — the nonce and the continuation token are stored only as digests', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    const f = await startFlow(a, 'signup');
    assert.match(String(f.body.deep_link), new RegExp(`^https://t\\.me/${BOT}\\?start=`));
    assert.ok(f.nonce.length >= 20);

    const stored = row<{ id: string; continuation_hash: string; phone_entered: string }>(
      raw, 'SELECT id, continuation_hash, phone_entered FROM link_challenges'
    );
    assert.notEqual(stored?.id, f.nonce, 'the challenge id is the DIGEST of the nonce, not the nonce');
    assert.equal(stored?.id.length, 64);
    assert.notEqual(stored?.continuation_hash, f.token);
    assert.equal(stored?.continuation_hash.length, 64);
    // The phone is normalized on the way in, so 07… and +964… are one identity.
    assert.equal(stored?.phone_entered, PHONE_E164);
    // And the response masks it rather than echoing it back.
    assert.equal(String(f.body.phone_masked).includes('1234567'), false);
  } finally {
    t.restore();
  }
});

test('START — the answer is byte-identical whether or not the phone has an account', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    raw.prepare(
      `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
       VALUES ('u_known','K','k@example.com','k','h','customer', ?)`
    ).run(PHONE_E164);

    const known = await post(a, '/api/auth/telegram/start', { purpose: 'login', phone: PHONE_NATIONAL });
    const unknown = await post(a, '/api/auth/telegram/start', { purpose: 'login', phone: '07709999999' });
    const [bk, bu] = [await json(known), await json(unknown)];
    assert.equal(known.status, unknown.status);
    assert.deepEqual(Object.keys(bk).sort(), Object.keys(bu).sort());
    // Only the per-request secrets and the mask differ; nothing derived from
    // whether the account exists.
    for (const k of ['success', 'bot_username', 'purpose', 'referral_captured']) {
      assert.deepEqual(bk[k], bu[k], `${k} must not depend on the account existing`);
    }
  } finally {
    t.restore();
  }
});

test('START — an unreachable bot is an honest 503, never a fabricated deep link', async () => {
  const raw = freshDb();
  const a = app(raw, { TELEGRAM_BOT_TOKEN: '' });
  const r = await post(a, '/api/auth/telegram/start', { purpose: 'signup', phone: PHONE_NATIONAL });
  assert.equal(r.status, 503);
});

test('/start WITH THE NONCE binds the private chat and asks for the contact', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    const f = await startFlow(a, 'signup');
    await hook(a, privateMsg({ text: `/start ${f.nonce}` }));

    const ch = challengeRow(raw);
    assert.equal(ch?.chat_id, CHAT, 'the chat is now bound to the challenge');
    assert.equal(ch?.telegram_user_id, TG_USER);

    const last = t.calls.filter((c) => c.method === 'sendMessage').at(-1)!;
    const keyboard = last.body.reply_markup as { keyboard?: Array<Array<{ request_contact?: boolean }>> };
    assert.equal(keyboard?.keyboard?.[0]?.[0]?.request_contact, true, 'the contact button is the whole point');
  } finally {
    t.restore();
  }
});

test('/start WITH A JUNK OR STALE NONCE says one generic thing and binds nothing', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    const f = await startFlow(a, 'signup');
    // Expired: the same shape as a nonce that never existed, deliberately.
    raw.exec("UPDATE link_challenges SET expires_at = '2020-01-01T00:00:00.000Z'");

    await hook(a, privateMsg({ text: `/start ${f.nonce}` }));
    const expired = t.texts().at(-1);
    await hook(a, privateMsg({ text: '/start 0000000000000000zzzz' }));
    const junk = t.texts().at(-1);

    assert.equal(expired, junk, 'the two cases must not be distinguishable from the chat');
    assert.equal(challengeRow(raw)?.chat_id, null, 'an expired challenge is never revived');
  } finally {
    t.restore();
  }
});

// =========================================================================
// THE FOUR PREDICATES
// =========================================================================

async function reachContactStep(raw: DatabaseSync, purpose: 'signup' | 'login' = 'signup') {
  const t = stubTelegram();
  const a = app(raw);
  const f = await startFlow(a, purpose);
  await hook(a, privateMsg({ text: `/start ${f.nonce}` }));
  return { a, f, t };
}

test('CONTACT — a FORWARDED contact is refused: it proves nothing about who sent it', async () => {
  const raw = freshDb();
  const { a, t } = await reachContactStep(raw);
  try {
    await hook(a, privateMsg({ contact: ownContact(), forwarded: true }));
    assert.notEqual(challengeRow(raw)?.state, 'phone_verified');
    assert.equal(t.code(), null, 'no code goes out to an unproven chat');
  } finally {
    t.restore();
  }
});

test("CONTACT — somebody ELSE's contact card is refused (contact.user_id !== from.id)", async () => {
  const raw = freshDb();
  const { a, t } = await reachContactStep(raw);
  try {
    // The right number, shared by the wrong person. This is the attack the
    // predicate exists for: a contact card carries its OWNER's user_id.
    await hook(a, privateMsg({ contact: ownContact(PHONE_E164, TG_USER + 1) }));
    const ch = challengeRow(raw);
    assert.equal(ch?.state, 'contact_received', 'seen, but not proven');
    assert.notEqual(ch?.state, 'phone_verified');
    assert.equal(t.code(), null);
  } finally {
    t.restore();
  }
});

test('CONTACT — a TYPED number carries no user_id at all, and is refused', async () => {
  const raw = freshDb();
  const { a, t } = await reachContactStep(raw);
  try {
    await hook(a, privateMsg({ contact: { phone_number: PHONE_E164, first_name: 'Customer' } }));
    assert.notEqual(challengeRow(raw)?.state, 'phone_verified');
    assert.equal(t.code(), null);
  } finally {
    t.restore();
  }
});

test('CONTACT — a DIFFERENT number is refused, and the match is full E.164 equality', async () => {
  const raw = freshDb();
  const { a, t } = await reachContactStep(raw);
  try {
    // Shares the last seven digits with the expected number. A suffix match —
    // the shortcut this check exists to forbid — would accept it.
    await hook(a, privateMsg({ contact: ownContact('+19991234567') }));
    const ch = challengeRow(raw);
    assert.notEqual(ch?.state, 'phone_verified');
    assert.equal(t.code(), null);
    // And the refusal never names the expected number.
    assert.equal(t.texts().at(-1)!.includes('770'), false);
  } finally {
    t.restore();
  }
});

test('CONTACT — a contact with no live challenge for this chat is answered, not crashed into', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    await hook(a, privateMsg({ contact: ownContact() }));
    assert.ok(t.texts().length > 0, 'the customer is told something rather than met with silence');
    assert.equal(t.code(), null);
  } finally {
    t.restore();
  }
});

test('CONTACT — the customer\'s OWN contact for the RIGHT number proves ownership and sends the code', async () => {
  const raw = freshDb();
  const { a, t } = await reachContactStep(raw);
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const ch = challengeRow(raw);
    assert.equal(ch?.state, 'phone_verified');
    assert.ok(ch?.otp_sent_at, 'the code was dispatched, once, and the claim is recorded');
    const code = t.code();
    assert.ok(code && /^\d{6}$/.test(code), 'a six-digit code reached the private chat');

    // Stored as a salted digest, never as the code.
    const otp = row<{ verifier: string; chat_id: number; challenge_id: string }>(
      raw, 'SELECT verifier, chat_id, challenge_id FROM otp_challenges'
    );
    assert.equal(otp?.chat_id, CHAT);
    assert.equal(otp?.verifier.includes(code!), false);
    assert.equal(otp?.verifier.length, 64);
  } finally {
    t.restore();
  }
});

// =========================================================================
// THE WHOLE JOURNEY
// =========================================================================

test('SIGN-UP — an account exists only after the code typed in the browser is accepted', async () => {
  const raw = freshDb();
  const { a, f, t } = await reachContactStep(raw, 'signup');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    assert.equal(
      (raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n,
      0,
      'proving the phone is not the same as creating an account'
    );

    const status = await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`);
    assert.equal((await json(status)).state, 'otp_sent');

    const wrong = await post(a, '/api/auth/telegram/complete', {
      token: f.token, code: '000000', username: 'newcustomer',
    });
    assert.equal(wrong.status >= 400, true, 'a wrong code creates nothing');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0);

    const done = await post(a, '/api/auth/telegram/complete', {
      token: f.token, code: t.code(), username: 'newcustomer',
    });
    assert.equal(done.status, 200);
    const b = await json(done);
    assert.equal(b.created, true);

    const u = row<{ id: string; phone_e164: string; email: string }>(raw, 'SELECT id, phone_e164, email FROM users');
    assert.equal(u?.phone_e164, PHONE_E164, 'the proven number is the account identity');
    assert.match(u!.email, /@telegram\.local$/, 'a phone account gets a non-routable placeholder, not a fake address');

    const link = row<{ chat_id: number; telegram_user_id: number }>(
      raw, 'SELECT chat_id, telegram_user_id FROM telegram_links'
    );
    assert.equal(link?.chat_id, CHAT);
    assert.equal(link?.telegram_user_id, TG_USER);
  } finally {
    t.restore();
  }
});

test('SIGN-UP — the code works exactly once, so a replayed request creates no second account', async () => {
  const raw = freshDb();
  const { a, f, t } = await reachContactStep(raw, 'signup');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const code = t.code();
    assert.equal((await post(a, '/api/auth/telegram/complete', { token: f.token, code, username: 'once' })).status, 200);
    const replay = await post(a, '/api/auth/telegram/complete', { token: f.token, code, username: 'twice' });
    assert.equal(replay.status >= 400, true);
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
  } finally {
    t.restore();
  }
});

test('SIGN-IN — a proven number signs into the account that already holds it', async () => {
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
     VALUES ('u_me','Me','me@example.com','me','h','customer', ?)`
  ).run(PHONE_E164);
  raw.prepare(
    `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
     VALUES ('u_me', ?, ?, ?, ?)`
  ).run(TG_USER, CHAT, PHONE_E164, new Date().toISOString());

  const { a, f, t } = await reachContactStep(raw, 'login');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const done = await post(a, '/api/auth/telegram/complete', { token: f.token, code: t.code() });
    assert.equal(done.status, 200);
    const b = await json(done);
    assert.equal(b.created, false);
    assert.equal(b.user.id, 'u_me');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
  } finally {
    t.restore();
  }
});

test('SIGN-IN — a number nobody holds is guided to sign up, and only AFTER ownership is proven', async () => {
  const raw = freshDb();
  const { a, f, t } = await reachContactStep(raw, 'login');
  try {
    // Before the proof, the flow says nothing about whether an account exists.
    const early = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(early.hint, null);
    assert.notEqual(early.state, 'not_linkable');

    await hook(a, privateMsg({ contact: ownContact() }));
    const after = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(after.state, 'not_linkable');
    assert.equal(after.hint, 'use_signup');
    assert.equal(t.code(), null, 'no code is sent for a sign-in that cannot succeed');
  } finally {
    t.restore();
  }
});

test('SIGN-UP — a number that ALREADY has an account is guided to sign in, after the proof', async () => {
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
     VALUES ('u_me','Me','me@example.com','me','h','customer', ?)`
  ).run(PHONE_E164);
  const { a, f, t } = await reachContactStep(raw, 'signup');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const after = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(after.state, 'not_linkable');
    assert.equal(after.hint, 'use_login');
  } finally {
    t.restore();
  }
});

test('SIGN-IN — a RECYCLED number whose Telegram account changed hands is sent to support, not signed in', async () => {
  // The account-takeover case: a mobile operator reissues a number, and its
  // new owner's Telegram is a different user_id. Matching on the number alone
  // would hand them the previous owner's account.
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
     VALUES ('u_old','Old','old@example.com','old','h','customer', ?)`
  ).run(PHONE_E164);
  raw.prepare(
    `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
     VALUES ('u_old', ?, ?, ?, ?)`
  ).run(TG_USER + 42, 111, PHONE_E164, new Date().toISOString());

  const { a, f, t } = await reachContactStep(raw, 'login');
  try {
    await hook(a, privateMsg({ contact: ownContact() })); // the NEW owner's user_id
    const after = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(after.state, 'not_linkable');
    assert.equal(after.hint, 'support', 'a human decides who this number belongs to');
    assert.equal(t.code(), null);
  } finally {
    t.restore();
  }
});

test('OTP — five wrong codes end the challenge, and the right one then fails too', async () => {
  const raw = freshDb();
  const { a, f, t } = await reachContactStep(raw, 'signup');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const real = t.code()!;
    const wrong = real === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await post(a, '/api/auth/telegram/complete', { token: f.token, code: wrong, username: 'x' });
      assert.equal(r.status >= 400, true, `guess ${i + 1}`);
    }
    const after = await post(a, '/api/auth/telegram/complete', { token: f.token, code: real, username: 'x' });
    assert.equal(after.status >= 400, true, 'the budget is spent');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 0);
  } finally {
    t.restore();
  }
});

test('OTP — a failed Telegram delivery is reported, and no phantom "sent" state is left behind', async () => {
  const raw = freshDb();
  // sendOk:false — the customer blocked the bot between /start and sharing.
  const t = stubTelegram({ sendOk: false });
  try {
    const a = app(raw);
    const f = await startFlow(a, 'signup');
    await hook(a, privateMsg({ text: `/start ${f.nonce}` }));
    await hook(a, privateMsg({ contact: ownContact() }));

    const s = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(s.state, 'send_failed', 'the browser learns the honest outcome');
    const otp = row<{ consumed_at: string | null }>(raw, 'SELECT consumed_at FROM otp_challenges');
    if (otp) assert.ok(otp.consumed_at, 'an undelivered code is voided, not left pending');
  } finally {
    t.restore();
  }
});

test('STATUS and COMPLETE refuse an unknown continuation token', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    const bogus = 'z'.repeat(64);
    assert.equal((await get(a, `/api/auth/telegram/status?token=${bogus}`)).status, 400);
    assert.equal((await post(a, '/api/auth/telegram/complete', { token: bogus, code: '123456' })).status, 400);
  } finally {
    t.restore();
  }
});

test('START — a newer attempt on the same phone retires the older one', async () => {
  const raw = freshDb();
  const t = stubTelegram();
  try {
    const a = app(raw);
    const first = await startFlow(a, 'signup');
    await startFlow(a, 'signup');
    const stale = await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(first.token)}`);
    const b = await json(stale);
    assert.equal(b.state, 'expired', 'a stale deep link cannot race a newer one');
  } finally {
    t.restore();
  }
});

// =========================================================================
// A REVOKED LINK — where "taken" used to mean two different things
// =========================================================================

/**
 * An account keeps `users.phone_e164` when its Telegram link is revoked, so
 * the links table and the users table disagree about whether the number is
 * taken. The linkability check read only the links; the account-creating
 * batch in routes/auth.ts guards on the users column as well. The customer
 * therefore reached the end of the flow and got a generic failure instead of
 * the one sentence that would have helped them.
 */
function seedRevokedLink(raw: DatabaseSync) {
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
     VALUES ('u_had','Had','had@example.com','had','h','customer', ?)`
  ).run(PHONE_E164);
  raw.prepare(
    `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at, revoked_at)
     VALUES ('u_had', ?, ?, ?, ?, ?)`
  ).run(TG_USER, CHAT, PHONE_E164, new Date().toISOString(), new Date().toISOString());
}

test('REVOKED LINK — a SIGN-UP on a number an account still holds is guided to sign in', async () => {
  const raw = freshDb();
  seedRevokedLink(raw);
  const { a, f, t } = await reachContactStep(raw, 'signup');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const s = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(s.state, 'not_linkable');
    assert.equal(s.hint, 'use_login', 'the hint agrees with the guard that would refuse the insert');
    assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1);
  } finally {
    t.restore();
  }
});

test('REVOKED LINK — a SIGN-IN on that number goes to support, not into a loop with sign-up', async () => {
  const raw = freshDb();
  seedRevokedLink(raw);
  const { a, f, t } = await reachContactStep(raw, 'login');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const s = await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(f.token)}`));
    assert.equal(s.state, 'not_linkable');
    // 'use_signup' would send them to a screen that now says 'use_login'.
    // Re-linking on the number alone is the takeover this design refuses, so
    // a human decides.
    assert.equal(s.hint, 'support');
  } finally {
    t.restore();
  }
});

// =========================================================================
// THE LANGUAGE THE ACCOUNT IS CREATED IN
// =========================================================================
//
// «لغة إشعار التليغرام إنجليزية رغم أن لغة المستخدم عربية». The signup INSERT
// named no locale, so every phone account took the column's English default
// and its order notices arrived in English. The form now sends the language
// the page was read in, and nothing sent means ARABIC.

async function signUpWith(extra: Record<string, unknown>): Promise<{ raw: DatabaseSync; id: string }> {
  const raw = freshDb();
  const { a, f, t } = await reachContactStep(raw, 'signup');
  try {
    await hook(a, privateMsg({ contact: ownContact() }));
    const done = await post(a, '/api/auth/telegram/complete', { token: f.token, code: t.code(), username: 'langcase', ...extra });
    assert.equal(done.status, 200, JSON.stringify(await json(done)));
  } finally {
    t.restore();
  }
  const u = row<{ id: string }>(raw, 'SELECT id FROM users');
  return { raw, id: u!.id };
}

const localeOf = (raw: DatabaseSync, id: string) => row<{ locale: string }>(raw, 'SELECT locale FROM users WHERE id = ?', id)!.locale;
const stated = (raw: DatabaseSync, id: string) =>
  (raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile.locale_change' AND target = ?").get(id) as { n: number }).n;

test('SIGN-UP LANGUAGE — an Arabic reader gets an Arabic account', async () => {
  const { raw, id } = await signUpWith({ lang: 'ar' });
  assert.equal(localeOf(raw, id), 'ar');
});

test('SIGN-UP LANGUAGE — English chosen on the page is an ANSWER, and is recorded as one', async () => {
  // Recorded as stated, so the placeholder fallback in `notificationLang`
  // cannot overrule a person who really reads English.
  const { raw, id } = await signUpWith({ lang: 'en' });
  assert.equal(localeOf(raw, id), 'en');
  assert.equal(stated(raw, id), 1);
});

test('SIGN-UP LANGUAGE — Sorani is stored as the column spells it', async () => {
  const { raw, id } = await signUpWith({ lang: 'ckb' });
  assert.equal(localeOf(raw, id), 'ku');
});

test('SIGN-UP LANGUAGE — a client that sends nothing gets the SHOP\'s default, Arabic, and states nothing', async () => {
  const { raw, id } = await signUpWith({});
  assert.equal(localeOf(raw, id), 'ar', 'never the column\'s English');
  assert.equal(stated(raw, id), 0, 'the shop chose, not the person');
  const junk = await signUpWith({ lang: 'fr' });
  assert.equal(localeOf(junk.raw, junk.id), 'ar', 'a value that is not one of the three counts as nothing sent');
});
