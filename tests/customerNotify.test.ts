/**
 * TELLING A CUSTOMER SOMETHING HAPPENED — the fan-out, and the outbox row it
 * becomes.
 *
 * The shop notified its ADMIN group about every order and the customer about
 * almost nothing. These tests pin the three rules that make the new fan-out
 * safe to run beside a business write:
 *
 *   1. A CHANNEL IS USED ONLY WHEN IT CAN REALLY REACH THE PERSON. An
 *      unverified address is whatever somebody typed at sign-up;
 *      `@telegram.local` is not a mailbox; a revoked Telegram link is not a
 *      chat. None of those may be sent to, and none of them is an error.
 *   2. ONE BUSINESS EVENT NOTIFIES ONCE PER CHANNEL, however many times the
 *      calling route runs — the outbox's UNIQUE event key, with the channel
 *      appended so email and WhatsApp can both exist for the same order.
 *   3. IT NEVER THROWS AND NEVER BLOCKS. An order must not fail to be placed
 *      because a notification could not be queued.
 *
 * And the delivery half: a WhatsApp row is a REAL WasenderAPI request, a
 * terminal refusal kills the row instead of burning five attempts (and five
 * slots out of a quota as small as one message per five seconds), and a
 * rate-limit answer stays retryable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { asD1, freshDb } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { profileRoutes } from '../worker/routes/profile';
import { notifyCustomer, plainNotification, reachFor, reachForMany } from '../worker/lib/customerNotify';
import { notifyOrderPlaced, notifyOrderStatus, isNotifiedOrderStatus } from '../worker/lib/orderNotify';
import { processOutbox } from '../worker/lib/outbox';
import type { Env } from '../worker/lib/types';

const ADDRESS = 'customer@example.com';
const PHONE = '+9647701234567';

const env = (raw: DatabaseSync, over: Partial<Env> = {}): Env =>
  ({
    DB: asD1(raw),
    EMAIL_API_KEY: 're_k',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
    WASENDER_API_KEY: 'wa_k',
    TELEGRAM_BOT_TOKEN: '111:TOKEN',
    ...over,
  }) as unknown as Env;

function seedUser(
  raw: DatabaseSync,
  o: {
    id?: string;
    email?: string;
    verified?: boolean;
    phone?: string | null;
    chat?: number | null;
    revoked?: boolean;
    locale?: string;
    /** A verified Google sign-in — the other path that inserts no locale. */
    google?: string | null;
  } = {}
) {
  const id = o.id ?? 'u_1';
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164, email_verified_at, locale, google_sub)
     VALUES (?, 'Customer', ?, ?, 'h', 'customer', ?, ?, ?, ?)`
  ).run(
    id,
    o.email ?? ADDRESS,
    id,
    o.phone === undefined ? PHONE : o.phone,
    o.verified === false ? null : new Date().toISOString(),
    o.locale ?? 'ar',
    o.google ?? null
  );
  if (o.chat !== null && o.chat !== undefined) {
    raw.prepare(
      `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      Math.floor(Math.random() * 1_000_000) + 1,
      o.chat,
      o.phone === undefined ? PHONE : (o.phone ?? PHONE),
      new Date().toISOString(),
      o.revoked ? new Date().toISOString() : null
    );
  }
  return id;
}

const MSG = { subject: 'Order update', body: 'Your order shipped.', details: [{ label: 'Order', value: 'ORD-1' }] };

const rows = (raw: DatabaseSync) =>
  raw.prepare('SELECT id, kind, event_key, recipient, state, last_error, attempts FROM outbox ORDER BY kind').all() as Array<{
    id: string; kind: string; event_key: string; recipient: string; state: string; last_error: string; attempts: number;
  }>;

// =========================================================================
// REACH
// =========================================================================

test('REACH — a customer with all three channels is reachable on all three', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  const r = await reachFor(env(raw), 'u_1');
  assert.equal(r.email, ADDRESS);
  assert.equal(r.phone, PHONE);
  assert.equal(r.telegram_chat_id, 555);
  assert.equal(r.lang, 'ar');
});

test('REACH — an UNVERIFIED address is not a channel', async () => {
  const raw = freshDb();
  seedUser(raw, { verified: false });
  const r = await reachFor(env(raw), 'u_1');
  assert.equal(r.email, null, 'an unverified address may belong to somebody else entirely');
  assert.equal(r.phone, PHONE, 'the phone is unaffected');
});

test('REACH — a @telegram.local placeholder is not a mailbox', async () => {
  const raw = freshDb();
  seedUser(raw, { email: 'tg-u_1@telegram.local' });
  const r = await reachFor(env(raw), 'u_1');
  assert.equal(r.email, null);
});

test('REACH — a REVOKED Telegram link is not a chat', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555, revoked: true });
  const r = await reachFor(env(raw), 'u_1');
  assert.equal(r.telegram_chat_id, null);
});

test('REACH — a phone that is not E.164 is refused rather than handed to the provider', async () => {
  const raw = freshDb();
  seedUser(raw, { phone: '07701234567' });
  const r = await reachFor(env(raw), 'u_1');
  assert.equal(r.phone, null, 'the transport would refuse it anyway — do not queue a row that must die');
});

test('REACH — a deleted user is silence, not an exception', async () => {
  const raw = freshDb();
  const r = await reachFor(env(raw), 'u_missing');
  assert.deepEqual(
    { e: r.email, p: r.phone, t: r.telegram_chat_id },
    { e: null, p: null, t: null }
  );
});

test('REACH — the language comes from the account, so async delivery is in the customer\'s own language', async () => {
  const raw = freshDb();
  seedUser(raw, { id: 'u_en', email: 'en@example.com', locale: 'en', phone: null });
  seedUser(raw, { id: 'u_ku', email: 'ku@example.com', locale: 'ku', phone: null });
  assert.equal((await reachFor(env(raw), 'u_en')).lang, 'en');
  assert.equal((await reachFor(env(raw), 'u_ku')).lang, 'ckb', "the db's 'ku' is the templates' 'ckb'");
});

// =========================================================================
// THE FAN-OUT
// =========================================================================

test('FAN-OUT — one call queues one row per reachable channel, each with its own event key', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  const out = await notifyCustomer(env(raw), 'u_1', 'order.placed:ORD-1', MSG);
  assert.deepEqual(out, { email: true, whatsapp: true, telegram: true });

  const q = rows(raw);
  assert.equal(q.length, 3);
  assert.deepEqual(
    q.map((r) => r.event_key).sort(),
    ['order.placed:ORD-1:email', 'order.placed:ORD-1:telegram', 'order.placed:ORD-1:whatsapp']
  );
  const wa = q.find((r) => r.kind === 'whatsapp')!;
  assert.equal(wa.recipient, PHONE);
  assert.equal(q.find((r) => r.kind === 'email')!.recipient, ADDRESS);
});

test('FAN-OUT — calling twice for the same event queues nothing the second time', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  const e = env(raw);
  await notifyCustomer(e, 'u_1', 'order.placed:ORD-1', MSG);
  const second = await notifyCustomer(e, 'u_1', 'order.placed:ORD-1', MSG);
  assert.deepEqual(second, { email: false, whatsapp: false, telegram: false }, 'a replay is a no-op, not a duplicate');
  assert.equal(rows(raw).length, 3);
});

test('FAN-OUT — a customer with only one channel gets exactly one row', async () => {
  const raw = freshDb();
  seedUser(raw, { phone: null, chat: null });
  const out = await notifyCustomer(env(raw), 'u_1', 'order.placed:ORD-2', MSG);
  assert.deepEqual(out, { email: true, whatsapp: false, telegram: false });
  assert.equal(rows(raw).length, 1);
});

test('FAN-OUT — an unreachable customer produces no rows and no error', async () => {
  const raw = freshDb();
  seedUser(raw, { verified: false, phone: null, chat: null });
  const out = await notifyCustomer(env(raw), 'u_1', 'order.placed:ORD-3', MSG);
  assert.deepEqual(out, { email: false, whatsapp: false, telegram: false });
  assert.equal(rows(raw).length, 0);
});

test('FAN-OUT — the same words go out on every channel', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  await notifyCustomer(env(raw), 'u_1', 'order.placed:ORD-4', MSG);
  const payloads = (raw.prepare('SELECT kind, payload FROM outbox').all() as Array<{ kind: string; payload: string }>)
    .map((r) => ({ kind: r.kind, p: JSON.parse(r.payload) as Record<string, string> }));
  const expected = plainNotification(MSG);
  assert.equal(payloads.find((x) => x.kind === 'whatsapp')!.p.text, expected);
  assert.equal(payloads.find((x) => x.kind === 'telegram')!.p.text, expected);
  // The email carries the same words as its text alternative, plus a card.
  const mail = payloads.find((x) => x.kind === 'email')!.p;
  assert.equal(mail.text, expected);
  assert.match(mail.html, /Your order shipped\./);
  assert.match(mail.html, /LEVONIS/);
});

// =========================================================================
// ORDER EVENTS
// =========================================================================

function seedOrder(raw: DatabaseSync, id = 'ORD-1', userId = 'u_1', due = 0) {
  raw.prepare(
    `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
     VALUES (?, ?, '{}', 'dm', '{}', 'cod', 100000, 1400, 105000, ?)`
  ).run(id, userId, due);
}

test('ORDER PLACED — the customer is told, with the order number and the total', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: null, phone: null });
  seedOrder(raw, 'ORD-1', 'u_1', 25000);
  await notifyOrderPlaced(env(raw), 'ORD-1');
  const q = rows(raw);
  assert.equal(q.length, 1);
  assert.equal(q[0].event_key, 'order.placed:ORD-1:email');
  const p = JSON.parse((raw.prepare('SELECT payload FROM outbox').get() as { payload: string }).payload) as {
    text: string; subject: string;
  };
  assert.match(p.subject, /ORD-1/);
  assert.match(p.text, /105,000 IQD/);
  assert.match(p.text, /25,000 IQD/, 'a real amount due on the door is named');
});

test('ORDER PLACED — a zero due-on-delivery line is left out rather than shown as 0', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: null, phone: null });
  seedOrder(raw, 'ORD-2', 'u_1', 0);
  await notifyOrderPlaced(env(raw), 'ORD-2');
  const p = JSON.parse((raw.prepare('SELECT payload FROM outbox').get() as { payload: string }).payload) as {
    text: string;
  };
  // The LABEL must be absent, not merely the digits: "0 IQD" is also a
  // substring of "105,000 IQD", so matching on the amount proves nothing.
  assert.equal(
    p.text.includes('المستحق عند الاستلام'),
    false,
    'a zero due-on-delivery line reads as a charge nobody expected'
  );
  assert.match(p.text, /105,000 IQD/, 'the total is still there');
});

test('ORDER STATUS — only the transitions a customer can act on are sent', async () => {
  assert.equal(isNotifiedOrderStatus('confirmed'), true);
  assert.equal(isNotifiedOrderStatus('shipped'), true);
  assert.equal(isNotifiedOrderStatus('delivered'), true);
  assert.equal(isNotifiedOrderStatus('cancelled'), true);
  assert.equal(isNotifiedOrderStatus('processing'), false, 'a warehouse fact is not news');
  assert.equal(isNotifiedOrderStatus('pending'), false);

  const raw = freshDb();
  seedUser(raw, { chat: null, phone: null });
  seedOrder(raw);
  const e = env(raw);
  await notifyOrderStatus(e, 'ORD-1', 'processing');
  assert.equal(rows(raw).length, 0);
  await notifyOrderStatus(e, 'ORD-1', 'shipped');
  assert.equal(rows(raw).length, 1);
  await notifyOrderStatus(e, 'ORD-1', 'shipped');
  assert.equal(rows(raw).length, 1, 'the same transition notifies once');
  await notifyOrderStatus(e, 'ORD-1', 'delivered');
  assert.equal(rows(raw).length, 2, 'a DIFFERENT transition is its own event');
});

test('ORDER — a missing order is silence, and neither helper ever throws', async () => {
  const raw = freshDb();
  const e = env(raw);
  await notifyOrderPlaced(e, 'ORD-nope');
  await notifyOrderStatus(e, 'ORD-nope', 'shipped');
  assert.equal(rows(raw).length, 0);
});

// =========================================================================
// THE LANGUAGE OF THE MESSAGE
// =========================================================================
//
// «اللغة في رسالة إشعار التليكرام لا تطابق اللغة الافتراضية للموقع».
//
// The template picking was never the defect. `users.locale` is
// `NOT NULL DEFAULT 'en'` and the Telegram/phone signup binds no locale, so
// the customers who HAVE Telegram are precisely the ones whose column says
// English without anybody ever having been asked — and an Arabic shop sent
// them English. These tests pin the two halves of the answer: an unasked
// account is read as Arabic, and an account that ANSWERED is never
// second-guessed.
//
// The narrowness is asserted as hard as the fix: a stored 'en' that somebody
// really typed must survive, or this would just be the old bug pointing the
// other way.

/** A Telegram/phone signup exactly as worker/routes/auth.ts creates one:
 *  the `@telegram.local` placeholder, no verified address, and the locale
 *  column left to its default. */
const seedTelegramSignup = (raw: DatabaseSync, id = 'u_tg', chat: number | null = 555) =>
  seedUser(raw, { id, email: `tg-${id}@telegram.local`, verified: false, locale: 'en', chat });

test('LANGUAGE — an account that was never asked is not an English speaker', async () => {
  const raw = freshDb();
  seedTelegramSignup(raw);
  const r = await reachFor(env(raw), 'u_tg');
  assert.equal(r.telegram_chat_id, 555, 'this is the population that actually has Telegram');
  assert.equal(r.lang, 'ar', "the column's default is not an answer, and the shop's own default is Arabic");
});

test('LANGUAGE — a Google sign-in was not asked either', async () => {
  const raw = freshDb();
  seedUser(raw, { id: 'u_g', email: 'g@example.com', locale: 'en', google: 'google-sub-1', chat: null });
  assert.equal((await reachFor(env(raw), 'u_g')).lang, 'ar');
});

test('LANGUAGE — English that somebody actually typed at sign-up survives', async () => {
  // The narrow predicate IS the fix. A rule over every 'en' row would
  // overrule everyone who chose English on purpose — a worse failure than
  // the bug.
  const raw = freshDb();
  seedUser(raw, { id: 'u_typed', email: 'typed@example.com', locale: 'en', chat: null });
  assert.equal((await reachFor(env(raw), 'u_typed')).lang, 'en');
});

test('LANGUAGE — once the customer picks a language, the answer is honoured for ever', async () => {
  const raw = freshDb();
  seedTelegramSignup(raw);
  raw.prepare(
    "INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'profile.locale_change', ?, '{\"to\":\"en\"}')"
  ).run('u_tg', 'u_tg');
  assert.equal((await reachFor(env(raw), 'u_tg')).lang, 'en', 'a stated preference outranks the fallback');
});

test('LANGUAGE — the bulk lookup gives the same answer as the single one', async () => {
  // Two readers of one column is how a shop ends up sending one message in
  // two languages; `reachForMany` feeds the stock-alert sweep.
  const raw = freshDb();
  seedTelegramSignup(raw, 'u_tg');
  seedUser(raw, { id: 'u_typed', email: 'typed@example.com', locale: 'en', phone: null, chat: null });
  const many = await reachForMany(env(raw), ['u_tg', 'u_typed']);
  assert.equal(many.get('u_tg')!.lang, 'ar');
  assert.equal(many.get('u_typed')!.lang, 'en');
});

test('LANGUAGE — THE REPORTED MESSAGE: the Telegram order notification is in Arabic', async () => {
  // End to end, through the composer that picks the COPY block: this is the
  // message the owner was holding.
  const raw = freshDb();
  seedTelegramSignup(raw, 'u_tg');
  seedOrder(raw, 'ORD-TG', 'u_tg', 0);
  await notifyOrderPlaced(env(raw), 'ORD-TG');

  const tg = raw
    .prepare("SELECT payload FROM outbox WHERE kind = 'telegram'")
    .get() as { payload: string } | undefined;
  assert.ok(tg, 'the Telegram row is queued');
  const text = (JSON.parse(tg!.payload) as { text: string }).text;
  assert.match(text, /استلمنا طلبك ORD-TG/, 'the sentence is the Arabic one');
  assert.equal(text.includes('reached us'), false, 'and not the English one');
  assert.equal(text.includes('الإجمالي'), true, 'the labels are Arabic too, not a half-translated message');
});

/** The real PATCH /api/profile route, with the stored user row as the caller —
 *  the one place in the codebase where a customer states a language. */
function profileApp(raw: DatabaseSync, userId: string) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.env = { DB: asD1(raw) } as never;
    c.set('user', raw.prepare('SELECT * FROM users WHERE id = ?').get(userId) as never);
    await next();
  });
  a.route('/api/profile', profileRoutes);
  return a;
}

const pickLanguage = (raw: DatabaseSync, userId: string, locale: string) =>
  profileApp(raw, userId).request('/api/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ locale }),
  });

const localeStatements = (raw: DatabaseSync, userId: string) =>
  (raw
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE target = ? AND action = 'profile.locale_change'")
    .get(userId) as { n: number }).n;

test('LANGUAGE — pressing English on a defaulted account IS the answer, and it sticks', async () => {
  // The one customer the fallback gets wrong is the Telegram signup who
  // really does read English. Their column already says 'en', so the press
  // changes no value — if the route only recorded CHANGES, they could never
  // correct it.
  const raw = freshDb();
  seedTelegramSignup(raw);
  assert.equal((await reachFor(env(raw), 'u_tg')).lang, 'ar', 'before: unasked');

  const res = await pickLanguage(raw, 'u_tg', 'en');
  assert.equal(res.status, 200);
  assert.equal(localeStatements(raw, 'u_tg'), 1, 'the press is written down');
  assert.equal((await reachFor(env(raw), 'u_tg')).lang, 'en', 'after: answered, and honoured');

  // A profile saved again is not a second decision.
  await pickLanguage(raw, 'u_tg', 'en');
  assert.equal(localeStatements(raw, 'u_tg'), 1, 'the trail records decisions, not saves');

  // A real change is.
  await pickLanguage(raw, 'u_tg', 'ckb');
  assert.equal(localeStatements(raw, 'u_tg'), 2);
  assert.equal((await reachFor(env(raw), 'u_tg')).lang, 'ckb', "the API's 'ckb' is stored as the column's 'ku'");
});

// =========================================================================
// DELIVERY
// =========================================================================

function stubWasender(reply: () => Response) {
  const calls: Array<{ to: string; text: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('wasenderapi.com')) return real(input as RequestInfo, init);
    calls.push(JSON.parse(String(init?.body)) as { to: string; text: string });
    return reply();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('DELIVERY — a queued WhatsApp row becomes a real WasenderAPI request and is marked sent', async () => {
  const raw = freshDb();
  seedUser(raw, { verified: false, chat: null });
  const w = stubWasender(() =>
    new Response(JSON.stringify({ success: true, data: { msgId: 7, jid: PHONE, status: 'in_progress' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  );
  try {
    const e = env(raw);
    await notifyCustomer(e, 'u_1', 'order.placed:ORD-9', MSG);
    const res = await processOutbox(e, 10);
    assert.deepEqual(res, { sent: 1, failed: 0 });
    assert.equal(w.calls.length, 1);
    assert.equal(w.calls[0].to, PHONE);
    assert.equal(w.calls[0].text, plainNotification(MSG));
    assert.equal(rows(raw)[0].state, 'sent');
  } finally {
    w.restore();
  }
});

test('DELIVERY — a TERMINAL WhatsApp refusal kills the row instead of burning five sends', async () => {
  const raw = freshDb();
  seedUser(raw, { verified: false, chat: null });
  const w = stubWasender(() =>
    new Response(JSON.stringify({ success: false, message: 'Validation failed' }), { status: 422 })
  );
  try {
    const e = env(raw);
    await notifyCustomer(e, 'u_1', 'order.placed:ORD-10', MSG);
    await processOutbox(e, 10);
    const r = rows(raw)[0];
    assert.equal(r.state, 'dead', 'retrying cannot help, and each retry costs a rate-limit slot');
    assert.equal(r.attempts, 1);
    assert.match(r.last_error, /TERMINAL whatsapp REJECTED/);
  } finally {
    w.restore();
  }
});

test('DELIVERY — a 429 stays RETRYABLE, because a burst is the ordinary case on this provider', async () => {
  const raw = freshDb();
  seedUser(raw, { verified: false, chat: null });
  const w = stubWasender(() =>
    new Response(JSON.stringify({ success: false, message: 'Too many' }), {
      status: 429, headers: { 'X-RateLimit-Reset': '5' },
    })
  );
  try {
    const e = env(raw);
    await notifyCustomer(e, 'u_1', 'order.placed:ORD-11', MSG);
    await processOutbox(e, 10);
    const r = rows(raw)[0];
    assert.equal(r.state, 'failed', 'failed = will be retried by the next cron');
    assert.match(r.last_error, /RATE_LIMITED/);
    assert.equal(r.last_error.startsWith('TERMINAL'), false);
  } finally {
    w.restore();
  }
});

test('DELIVERY — with no WASENDER_API_KEY the row is refused BEFORE it is queued, naming why', async () => {
  // THIS USED TO ASSERT 'dead', AND THE CHANGE IS THE POINT.
  //
  // The old shape enqueued a pending row on a deployment that has no WhatsApp
  // at all, let processOutbox discover that at send time, and only then marked
  // it dead. For fifteen minutes the row read as queued, and the shop had told
  // the customer something it could never do — which is exactly the lie the
  // «أبلغني عند التوفر» sheet must not repeat when it names a channel.
  //
  // notifyCustomer now consults the DEPLOYMENT half before enqueuing, so the
  // row is born 'skipped': recorded, never queued, never retried. What did not
  // change is the sentence. `last_error` still carries the same bare code the
  // send path would have written, so ONE query over the outbox answers «ليش ما
  // وصلت؟» whichever path noticed.
  const raw = freshDb();
  seedUser(raw, { verified: false, chat: null });
  const e = env(raw, { WASENDER_API_KEY: '' });
  await notifyCustomer(e, 'u_1', 'order.placed:ORD-12', MSG);
  const before = rows(raw)[0];
  assert.equal(before.state, 'skipped', 'refused at the door, not queued and then killed');
  assert.equal(before.last_error, 'WHATSAPP_NOT_CONFIGURED');

  // And a drain does not resurrect it or spend an attempt on it.
  await processOutbox(e, 10);
  const after = rows(raw)[0];
  assert.equal(after.state, 'skipped');
  assert.equal(after.attempts, 0, 'a channel the deployment does not have costs no attempts');
});

test('DELIVERY — the email staging allowlist does not silence WhatsApp', async () => {
  // The allowlist exists to stop a staging deploy MAILING a real customer.
  // Applying it to a channel it was never written for would look like a
  // WhatsApp outage nobody could explain.
  const raw = freshDb();
  seedUser(raw, { chat: null });
  const w = stubWasender(() =>
    new Response(JSON.stringify({ success: true, data: { msgId: 1, status: 'in_progress' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  );
  try {
    const e = env(raw, { EMAIL_ALLOWED_RECIPIENTS: 'someone-else@example.com' });
    await notifyCustomer(e, 'u_1', 'order.placed:ORD-13', MSG);
    await processOutbox(e, 10);
    const q = rows(raw);
    assert.equal(q.find((r) => r.kind === 'email')!.state, 'skipped', 'the mail is held by the guard');
    assert.equal(q.find((r) => r.kind === 'whatsapp')!.state, 'sent', 'the WhatsApp message is not');
  } finally {
    w.restore();
  }
});

// =========================================================================
// WALLET — the third channel joins the two that were already there
// =========================================================================

test('WALLET — a deposit decision now reaches WhatsApp too, on the proven number', async () => {
  const { enqueueUserDepositStatusNotification } = await import('../worker/lib/walletNotify');
  const raw = freshDb();
  seedUser(raw, { chat: 777 });
  raw.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
     VALUES ('wtx_1', 'u_1', 'deposit', 5000, 'approved', 'top-up')`
  ).run();

  const out = await enqueueUserDepositStatusNotification(env(raw), 'wtx_1');
  assert.deepEqual(out, { telegram: true, email: true, whatsapp: true });

  const wa = rows(raw).find((r) => r.kind === 'whatsapp')!;
  assert.equal(wa.recipient, PHONE);
  assert.equal(wa.event_key, 'wallet.deposit.approved:wtx_1:whatsapp');
});

test('WALLET — an account with no proven number simply does not get the WhatsApp row', async () => {
  const { enqueueUserDepositStatusNotification } = await import('../worker/lib/walletNotify');
  const raw = freshDb();
  seedUser(raw, { phone: null, chat: null });
  raw.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, amount, status, note)
     VALUES ('wtx_2', 'u_1', 'deposit', 5000, 'rejected', 'top-up')`
  ).run();

  const out = await enqueueUserDepositStatusNotification(env(raw), 'wtx_2');
  assert.equal(out.whatsapp, false);
  assert.equal(rows(raw).some((r) => r.kind === 'whatsapp'), false);
});
