/**
 * CREATING AN ACCOUNT ON A PHONE NUMBER, AND THE DECENCY RULE ON NAMES.
 *
 * Both came from the same screenshot: an owner looking at their own sign-in
 * page holding a phone the shop can reach, told «لا يوجد حساب موثّق بهذا الرقم»
 * with nothing to do about it.
 *
 * WHAT THIS SUITE IS DEFENDING, in order of what it would cost to get wrong:
 *
 *   1. A TICKET AUTHORISES ONE ACCOUNT ON ONE DESTINATION. The destination is
 *      read from the ticket and never from the request body — a ticket earned
 *      on one number creating an account on another is the whole attack.
 *   2. A TICKET IS SPENT ONCE. Two submissions make one account, not two.
 *   3. THE SIGN-IN PATH IS UNCHANGED. A code for an address with no account is
 *      still a failure there; the decoy that keeps /start from answering "does
 *      this address exist" is still a decoy.
 *   4. A REAL NAME IS NOT REJECTED. «مكسور», `Cassandra` and `Scunthorpe` are
 *      the cost of a careless filter, and they are pinned here because the
 *      person who pays it is a customer who cannot open an account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, dbThrough, freshDb, json, post, stubApp } from './fixtures/app';
import { authRoutes } from '../worker/routes/auth';
import type { Env } from '../worker/lib/types';

const WA_KEY = 'wa_test_key';
const NEW_PHONE = '+9647701112222';

/** The WhatsApp provider, stubbed at `fetch` so the route builds its own
 *  request exactly as it would in production. */
function stubWhatsApp() {
  const sent: Array<{ to: string; code: string | null }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('wasenderapi.com')) {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { to: string; text: string };
      sent.push({ to: parsed.to, code: /\b(\d{6})\b/.exec(parsed.text)?.[1] ?? null });
      return new Response(JSON.stringify({ success: true, data: { msgId: 1, jid: parsed.to, status: 'in_progress' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const env = (raw: DatabaseSync, over: Partial<Env> = {}): Record<string, unknown> => ({
  DB: asD1(raw),
  WASENDER_API_KEY: WA_KEY,
  INITIAL_ADMIN_EMAIL: 'boss@x.co',
  EXTRA_ALLOWED_ORIGINS: '',
  APP_ORIGIN: `https://${APEX}`,
  ...over,
});

const app = (raw: DatabaseSync, over: Partial<Env> = {}) =>
  stubApp(asD1(raw), null, (a) => a.route('/api/auth', authRoutes), { host: APEX, env: env(raw, over) });

let ipSeq = 0;
const ip = () => ({ 'CF-Connecting-IP': `10.9.${Math.floor(ipSeq / 250) % 250}.${++ipSeq % 250}` });
const start = (a: ReturnType<typeof app>, body: unknown) => post(a, '/api/auth/otp/start', body, ip());
const verify = (a: ReturnType<typeof app>, body: unknown) => post(a, '/api/auth/otp/verify', body, ip());
const complete = (a: ReturnType<typeof app>, body: unknown) => post(a, '/api/auth/signup/otp-complete', body, ip());

/** start → read the code out of the WhatsApp message → verify → the ticket. */
async function ticketFor(a: ReturnType<typeof app>, wa: ReturnType<typeof stubWhatsApp>, phone = NEW_PHONE) {
  const r1 = await start(a, { channel: 'whatsapp', identifier: phone, intent: 'signup' });
  assert.equal(r1.status, 200, JSON.stringify(await json(r1)));
  const code = wa.sent[wa.sent.length - 1]?.code;
  assert.ok(code, 'the code must have reached the number');
  const r2 = await verify(a, { channel: 'whatsapp', identifier: phone, code, allow_signup: true });
  const b2 = await json(r2);
  assert.equal(r2.status, 200, JSON.stringify(b2));
  assert.equal(b2.signup, true);
  assert.ok(typeof b2.ticket === 'string' && b2.ticket.length > 20);
  return String(b2.ticket);
}

// =========================================================================
// THE FLOW
// =========================================================================

test('a number with NO account receives a code and the code becomes an account', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    const ticket = await ticketFor(a, wa);
    // The code really left, to the number that was typed — this is the half
    // the sign-in path deliberately does NOT do for an unknown destination.
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0].to, NEW_PHONE);

    const r = await complete(a, { ticket, name: 'علي حسن', username: 'ali3d' });
    const b = await json(r);
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(b.created, true);
    assert.equal(b.email_placeholder, true, 'a phone is not an address — the email column takes the placeholder');

    const stored = raw.prepare('SELECT phone_e164, username, name, email, email_verified_at, password_hash FROM users').get() as {
      phone_e164: string; username: string; name: string; email: string; email_verified_at: string | null; password_hash: string | null;
    };
    assert.equal(stored.phone_e164, NEW_PHONE);
    assert.equal(stored.username, 'ali3d');
    assert.equal(stored.name, 'علي حسن');
    assert.ok(stored.email.endsWith('@telegram.local'), 'the non-routable placeholder, never a fabricated address');
    assert.equal(stored.email_verified_at, null, 'proving a phone says nothing about a mailbox');
    assert.equal(stored.password_hash, null, 'a password is optional — the account lives on codes');
  } finally {
    wa.restore();
  }
});

test('THE DESTINATION COMES FROM THE TICKET, never from the body', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    const ticket = await ticketFor(a, wa);
    // Every field a caller could hope reaches the insert, pointed somewhere else.
    const r = await complete(a, {
      ticket,
      name: 'Someone',
      phone: '+9647709999999',
      identifier: '+9647709999999',
      destination: '+9647709999999',
      phone_e164: '+9647709999999',
    });
    assert.equal(r.status, 200, JSON.stringify(await json(r)));
    const stored = raw.prepare('SELECT phone_e164 FROM users').get() as { phone_e164: string };
    assert.equal(stored.phone_e164, NEW_PHONE, 'the proven number, not the one asked for');
  } finally {
    wa.restore();
  }
});

test('a ticket is spent ONCE — a replay creates no second account', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    const ticket = await ticketFor(a, wa);
    assert.equal((await complete(a, { ticket, name: 'First' })).status, 200);

    const again = await complete(a, { ticket, name: 'Second' });
    const b = await json(again);
    assert.equal(again.status, 400, JSON.stringify(b));
    assert.equal(b.code, 'TICKET_INVALID');
    const count = raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    wa.restore();
  }
});

test('an account on a number that got taken in between is a conflict, not a duplicate', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    const ticket = await ticketFor(a, wa);
    // Somebody else claims the number between the code and the submit.
    raw.prepare(
      `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
       VALUES ('u_other','Other','other@x.co','other','h','customer', ?)`
    ).run(NEW_PHONE);

    const r = await complete(a, { ticket, name: 'Late' });
    const b = await json(r);
    assert.equal(r.status, 409, JSON.stringify(b));
    const count = raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.equal(count.n, 1, 'no half-made account');
  } finally {
    wa.restore();
  }
});

test('a password and a real address are both accepted, and the address stays UNVERIFIED', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    const ticket = await ticketFor(a, wa);
    const r = await complete(a, { ticket, name: 'Ali', password: 'a-long-enough-password-1', email: 'ali@example.com' });
    assert.equal(r.status, 200, JSON.stringify(await json(r)));
    const stored = raw.prepare('SELECT email, email_verified_at, password_hash FROM users').get() as {
      email: string; email_verified_at: string | null; password_hash: string | null;
    };
    assert.equal(stored.email, 'ali@example.com');
    assert.equal(stored.email_verified_at, null, 'a WhatsApp code proves the phone and nothing else');
    assert.ok(stored.password_hash && stored.password_hash.length > 20);
  } finally {
    wa.restore();
  }
});

// =========================================================================
// WHAT MUST NOT HAVE CHANGED
// =========================================================================

test('THE SIGN-IN PATH IS UNTOUCHED: no account, no message, and no ticket', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    // Default intent. The decoy: a row is written, the response is the usual
    // one, and nothing leaves — which is what stops /start answering "does
    // this number have an account".
    const r1 = await start(a, { channel: 'whatsapp', identifier: NEW_PHONE });
    assert.equal(r1.status, 200);
    assert.equal((await json(r1)).success, true);
    assert.equal(wa.sent.length, 0, 'a stranger is not messaged on the sign-in path');

    // And a verify without allow_signup is still a plain failure, whatever
    // code is offered.
    const r2 = await verify(a, { channel: 'whatsapp', identifier: NEW_PHONE, code: '000000' });
    assert.equal(r2.status, 401);
    assert.equal((await json(r2)).code, 'OTP_FAILED');
  } finally {
    wa.restore();
  }
});

test('an EXISTING account signs in through the sign-up screen rather than being duplicated', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    raw.prepare(
      `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164)
       VALUES ('u_1','Customer','c@x.co','c','h','customer', ?)`
    ).run(NEW_PHONE);
    const a = app(raw);
    const r1 = await start(a, { channel: 'whatsapp', identifier: NEW_PHONE, intent: 'signup' });
    assert.equal(r1.status, 200);
    const code = wa.sent[0]?.code;
    assert.ok(code);
    const r2 = await verify(a, { channel: 'whatsapp', identifier: NEW_PHONE, code, allow_signup: true });
    const b2 = await json(r2);
    assert.equal(r2.status, 200, JSON.stringify(b2));
    assert.equal(b2.signup, undefined, 'the person owns this number AND an account — that is a sign-in');
    assert.equal((b2.user as { id: string }).id, 'u_1');
  } finally {
    wa.restore();
  }
});

test('WITHOUT the signup_tickets table the route says so, and does not 500', async () => {
  const raw = dbThrough('0089'); // everything except signup_tickets
  assert.equal(
    (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signup_tickets'").get() as unknown) ?? null,
    null,
    'the table must be absent for this test to mean anything'
  );
  const a = app(raw);
  const r = await complete(a, { ticket: 'x'.repeat(40), name: 'Ali' });
  const b = await json(r);
  assert.equal(r.status, 400, JSON.stringify(b));
  assert.equal(b.code, 'TICKET_INVALID');
});

// =========================================================================
// THE DECENCY RULE
// =========================================================================

test('an indecent NAME is refused at sign-up, and the message never repeats it', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    const ticket = await ticketFor(a, wa);
    const r = await complete(a, { ticket, name: 'fuck you' });
    const b = await json(r);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(b.code, 'NAME_NOT_ALLOWED');
    assert.equal(/fuck/i.test(JSON.stringify(b)), false, 'a filter that quotes the word back teaches the workaround');
    // And the proof is NOT spent: the person fixes the name and continues.
    const ok = await complete(a, { ticket, name: 'علي حسن' });
    assert.equal(ok.status, 200, JSON.stringify(await json(ok)));
  } finally {
    wa.restore();
  }
});

test('an indecent USERNAME is refused, and /username-available says which rule', async () => {
  const raw = freshDb();
  const a = app(raw);
  const r = await a.request('/api/auth/username-available?u=f.u.c.k.er', undefined, undefined, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext);
  const b = await json(r);
  assert.equal(r.status, 200);
  assert.equal(b.available, false);
  assert.equal(b.reason, 'indecent');
});

test('AN ORDINARY NAME IS NOT REJECTED — the cost of a careless filter', async () => {
  const raw = freshDb();
  const wa = stubWhatsApp();
  try {
    const a = app(raw);
    // One account per name, each on its own number: these are the words a
    // naive substring filter rejects, and every one of them is somebody real.
    const names = ['مكسور', 'كسرى', 'خولة', 'زبير', 'زبيدة', 'Cassandra', 'Scunthorpe', 'Fukuda', 'therapist', 'نيجيريا'];
    for (let i = 0; i < names.length; i++) {
      const phone = `+96477011133${String(i).padStart(2, '0')}`;
      const ticket = await ticketFor(a, wa, phone);
      const r = await complete(a, { ticket, name: names[i] });
      assert.equal(r.status, 200, `${names[i]} must be allowed: ${JSON.stringify(await json(r))}`);
    }
  } finally {
    wa.restore();
  }
});
