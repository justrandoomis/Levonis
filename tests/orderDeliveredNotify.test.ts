/**
 * «تم توصيل طلبك» — THE MESSAGE THAT ASKS FOR SOMETHING BACK, and the button
 * that was being dropped on the floor.
 *
 * WHAT WAS BROKEN. The delivered notification was one sentence — «تم تسليم
 * طلبك. شكراً لثقتك بليفونيس.» — with no link, no review ask and no button,
 * plus a «رقم الطلب:» line restating a fact that fits inside the sentence. It
 * could not have carried a button anyway: `OutboxTelegram` had no
 * `reply_markup`, so `deliver()` hand-built `{chat_id, text,
 * disable_web_page_preview}` and anything else a caller attached vanished
 * between the enqueue and the wire.
 *
 * THE FOUR PROPERTIES PINNED HERE, each of which is a way this ships broken:
 *
 *   1. THE BUTTON REACHES TELEGRAM. Not just the payload column — the
 *      sendMessage body. The whole defect was a field that existed in the
 *      caller and not in the transport.
 *   2. EVERY CHANNEL CARRIES THE CTA AS MUCH AS IT HONESTLY CAN. WhatsApp
 *      posts `{to, text}` to a real linked account (lib/wasender.ts), so its
 *      "button" can only ever be a bare tappable URL; Telegram gets the real
 *      keyboard and must NOT also repeat the URL in its text.
 *   3. NO ORIGIN, NO LINK — ANYWHERE. `APP_ORIGIN` unset or not https omits
 *      the CTA from all three renderings rather than sending a relative path
 *      or an http downgrade. There is no request to fall back to: the courier
 *      sync runs in a cron.
 *   4. THE IN-APP ROW IS THE FLOOR, and the event key is the STATUS. A
 *      customer with no channel at all is still told, and an order reversed to
 *      shipped and delivered again is told ONCE — the property migration
 *      92c4adf's COALESCE protects on the other side (delivered_at does not
 *      move, so it could not mark a second event either).
 *
 * And the length rule, which is the owner's actual request («اجعلها رسالة
 * مرتبة وقصيرة»): every line is one fact with the order number inside it, no
 * thank-you, no promise of the next message, and no restated order number —
 * except CANCELLED, which was already right and is asserted unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb } from './fixtures/app';
import { notifyOrderDelivered, notifyOrderPlaced, notifyOrderStatus } from '../worker/lib/orderNotify';
import { processOutbox } from '../worker/lib/outbox';
import type { Env } from '../worker/lib/types';

const ADDRESS = 'customer@example.com';
const PHONE = '+9647701234567';
const ORIGIN = 'https://levonis-iq.com';
const REVIEW_URL = `${ORIGIN}/orders?status=review&needs_review=1`;

const env = (raw: DatabaseSync, over: Partial<Env> = {}): Env =>
  ({
    DB: asD1(raw),
    EMAIL_API_KEY: 're_k',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
    WASENDER_API_KEY: 'wa_k',
    TELEGRAM_BOT_TOKEN: '111:TOKEN',
    APP_ORIGIN: ORIGIN,
    ...over,
  }) as unknown as Env;

function seedUser(
  raw: DatabaseSync,
  o: {
    id?: string;
    locale?: string;
    email?: string | null;
    phone?: string | null;
    chat?: number | null;
    /**
     * Whether this customer has ever PICKED a language, as opposed to carrying
     * the column's `NOT NULL DEFAULT 'en'`.
     *
     * `users.locale` cannot tell those apart on its own, and for a
     * `@telegram.local` account — which is what `email: null` mints here — the
     * default is never an answer: the phone/Telegram signup binds no locale at
     * all. `notificationLang` (worker/lib/customerNotify.ts) therefore reads a
     * `profile.locale_change` line in `audit_log` as the statement, written by
     * PATCH /api/profile the moment somebody taps a language. A fixture that
     * wants «this customer reads English» has to say so the same way, or it is
     * describing an account that was never asked and will be answered in
     * Arabic — correctly.
     */
    stated?: boolean;
  } = {}
): string {
  const id = o.id ?? 'u_1';
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role, phone_e164, email_verified_at, locale)
     VALUES (?, 'Customer', ?, ?, 'h', 'customer', ?, ?, ?)`
  ).run(
    id,
    o.email === undefined ? ADDRESS : (o.email ?? `${id}@telegram.local`),
    id,
    o.phone === undefined ? PHONE : o.phone,
    o.email === null ? null : new Date().toISOString(),
    o.locale ?? 'ar'
  );
  if (o.stated) {
    raw.prepare(
      `INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, 'profile.locale_change', ?, ?)`
    ).run(id, id, JSON.stringify({ to: o.locale ?? 'ar' }));
  }
  if (o.chat != null) {
    raw.prepare(
      `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, Math.floor(Math.random() * 1_000_000) + 1, o.chat, PHONE, new Date().toISOString());
  }
  return id;
}

function seedOrder(raw: DatabaseSync, id = 'ORD-1', userId = 'u_1'): string {
  raw.prepare(
    `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
     VALUES (?, ?, '{}', 'dm', '{}', 'cod', 100000, 1400, 105000, 0)`
  ).run(id, userId);
  return id;
}

interface Payloads {
  email?: { subject: string; text: string; html: string };
  whatsapp?: { to: string; text: string };
  telegram?: { chat_id: number; text: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; url: string }>> } };
}

/** The outbox payloads, parsed and keyed by channel. */
function payloads(raw: DatabaseSync): Payloads {
  const out: Payloads = {};
  for (const r of raw.prepare('SELECT kind, payload FROM outbox').all() as Array<{ kind: string; payload: string }>) {
    (out as Record<string, unknown>)[r.kind] = JSON.parse(r.payload);
  }
  return out;
}

const notifications = (raw: DatabaseSync) =>
  raw.prepare('SELECT * FROM user_notifications ORDER BY id').all() as Array<{
    user_id: string; kind: string; title_ar: string; title_en: string; body_ar: string;
    link: string; entity_type: string; entity_id: string; event_key: string;
  }>;

const outboxKeys = (raw: DatabaseSync) =>
  (raw.prepare('SELECT event_key FROM outbox ORDER BY event_key').all() as Array<{ event_key: string }>).map(
    (r) => r.event_key
  );

// =========================================================================
// 1. THE BUTTON
// =========================================================================

test('THE BUTTON — Telegram gets a real inline_keyboard, and its text does NOT repeat the URL', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');

  const tg = payloads(raw).telegram!;
  assert.deepEqual(tg.reply_markup, {
    inline_keyboard: [[{ text: 'قيّم منتجاتك', url: REVIEW_URL }]],
  });
  assert.equal(
    tg.text.includes(REVIEW_URL),
    false,
    'the address is on the button — printing it again is padding on a lock screen'
  );
  assert.match(tg.text, /^LEVONIS\n/);
});

test('THE BUTTON — WhatsApp and the mail text get the bare URL as their LAST line, because a button is not a thing this account can send', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');
  const p = payloads(raw);

  for (const text of [p.whatsapp!.text, p.email!.text]) {
    const lines = text.split('\n');
    assert.equal(lines[lines.length - 1], REVIEW_URL, 'a URL alone on a line is what a client turns into a link');
    assert.equal(lines.length, 3, 'LEVONIS, the sentence, the link — nothing else');
  }
  // `sendWhatsAppText` posts {to, text}: there is no field a button could
  // ride in, and inventing one would be a payload the provider refuses.
  assert.equal(Object.keys(p.whatsapp!).sort().join(','), 'kind,text,to');
});

test('THE BUTTON — the HTML mail carries exactly one anchor, escaped, at the same address', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: null, phone: null });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');

  const html = payloads(raw).email!.html;
  const anchors = html.match(/<a /g) ?? [];
  assert.equal(anchors.length, 1, 'one message, one thing to do');
  assert.ok(html.includes(`href="${ORIGIN}/orders?status=review&amp;needs_review=1"`), 'the & is escaped in the href');
  assert.ok(html.includes('>قيّم منتجاتك</a>'));
});

test('THE BUTTON — it reaches the WIRE, not just the payload column', async () => {
  // The defect this whole change exists for: `deliver()` hand-built the
  // sendMessage body, so a field the caller attached died between the enqueue
  // and Telegram. Asserting the stored payload alone would have passed then.
  const raw = freshDb();
  seedUser(raw, { email: null, phone: null, chat: 555 });
  seedOrder(raw);
  const bodies: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('api.telegram.org')) return real(input as RequestInfo, init);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const e = env(raw);
    await notifyOrderDelivered(e, 'ORD-1');
    const res = await processOutbox(e, 10);
    assert.deepEqual(res, { sent: 1, failed: 0 });
    assert.equal(bodies.length, 1);
    assert.deepEqual(bodies[0].reply_markup, {
      inline_keyboard: [[{ text: 'قيّم منتجاتك', url: REVIEW_URL }]],
    });
    assert.equal(bodies[0].chat_id, 555);
  } finally {
    globalThis.fetch = real;
  }
});

test('THE BUTTON — a message with no CTA sends no reply_markup key at all', async () => {
  const raw = freshDb();
  seedUser(raw, { email: null, phone: null, chat: 555 });
  seedOrder(raw);
  const bodies: Array<Record<string, unknown>> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('api.telegram.org')) return real(input as RequestInfo, init);
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const e = env(raw);
    await notifyOrderStatus(e, 'ORD-1', 'shipped');
    await processOutbox(e, 10);
    assert.equal('reply_markup' in bodies[0], false, 'a keyboard is not something to send half of');
  } finally {
    globalThis.fetch = real;
  }
});

// =========================================================================
// 2. NO ORIGIN, NO LINK
// =========================================================================

for (const [label, origin] of [
  ['unset', ''],
  ['whitespace', '   '],
  ['an http:// downgrade', 'http://levonis-iq.com'],
] as const) {
  test(`NO ORIGIN — ${label} omits the CTA from ALL THREE renderings rather than half-building one`, async () => {
    const raw = freshDb();
    seedUser(raw, { chat: 555 });
    seedOrder(raw);
    await notifyOrderDelivered(env(raw, { APP_ORIGIN: origin }), 'ORD-1');

    const p = payloads(raw);
    assert.equal('reply_markup' in p.telegram!, false);
    assert.equal(p.whatsapp!.text.includes('://'), false, 'never a bare path where a link was promised');
    assert.equal(p.email!.text.includes('://'), false);
    assert.equal(p.email!.html.includes('<a '), false);
    // The message itself still goes out — the ask survives, the link does not.
    assert.match(p.whatsapp!.text, /تم تسليم طلبك ORD-1\./);
  });
}

// =========================================================================
// 3. THE FLOOR, AND THE EVENT KEY
// =========================================================================

test('THE FLOOR — a customer with no channel at all is still told, in the app', async () => {
  const raw = freshDb();
  seedUser(raw, { email: null, phone: null, chat: null });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');

  assert.equal(outboxKeys(raw).length, 0, 'nothing can be sent');
  const rows = notifications(raw);
  assert.equal(rows.length, 1, 'and yet the customer is owed points for a review');
  assert.equal(rows[0].kind, 'order_update');
  assert.equal(rows[0].entity_type, 'order');
  assert.equal(rows[0].entity_id, 'ORD-1');
  assert.equal(rows[0].event_key, 'order.status.delivered:ORD-1');
  // A PATH, never an absolute URL: a stored origin is a stored mistake
  // waiting for the day the domain changes (lib/notifications.ts).
  assert.equal(rows[0].link, '/orders?status=review&needs_review=1');
  assert.equal(rows[0].link.includes('://'), false);
});

test('THE FLOOR — the in-app row is written even when the deployment can carry no channel', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  seedOrder(raw);
  const e = env(raw, { EMAIL_API_KEY: '', WASENDER_API_KEY: '', TELEGRAM_BOT_TOKEN: '' });
  await notifyOrderDelivered(e, 'ORD-1');

  assert.equal(notifications(raw).length, 1);
  const states = (raw.prepare('SELECT state FROM outbox').all() as Array<{ state: string }>).map((r) => r.state);
  assert.deepEqual(states.sort(), ['skipped', 'skipped', 'skipped'], 'recorded honestly, never queued');
});

test('ONCE — an order reversed and re-delivered notifies exactly once, on every surface', async () => {
  const raw = freshDb();
  seedUser(raw, { chat: 555 });
  seedOrder(raw);
  const e = env(raw);

  await notifyOrderDelivered(e, 'ORD-1');
  // Reversed to shipped (a mis-tap corrected), then delivered again — through
  // the OTHER door this time.
  await notifyOrderStatus(e, 'ORD-1', 'shipped');
  await notifyOrderDelivered(e, 'ORD-1');
  await notifyOrderStatus(e, 'ORD-1', 'delivered');

  assert.deepEqual(outboxKeys(raw), [
    'order.status.delivered:ORD-1:email',
    'order.status.delivered:ORD-1:telegram',
    'order.status.delivered:ORD-1:whatsapp',
    'order.status.shipped:ORD-1:email',
    'order.status.shipped:ORD-1:telegram',
    'order.status.shipped:ORD-1:whatsapp',
  ]);
  // Every notified status now writes its own in-app row (the floor for a
  // customer with no channel), so the bell holds the one «shipped» line too —
  // but the DELIVERED ask is still there exactly once.
  const bell = notifications(raw).map((n) => n.event_key).sort();
  assert.deepEqual(
    bell,
    ['order.status.delivered:ORD-1', 'order.status.shipped:ORD-1'],
    'and the bell does not fill up with the same ask'
  );
});

test('ONCE — the legacy status door and the delivered door are the SAME event, with the same words', async () => {
  // Two databases, two doors, one message: if `notifyOrderStatus` built its
  // own delivered copy, which door ran first would decide whether the
  // customer got the button — the loser's enqueue is a silent no-op.
  const a = freshDb();
  seedUser(a, { chat: 555 });
  seedOrder(a);
  await notifyOrderStatus(env(a), 'ORD-1', 'delivered');

  const b = freshDb();
  seedUser(b, { chat: 555 });
  seedOrder(b);
  await notifyOrderDelivered(env(b), 'ORD-1');

  assert.deepEqual(payloads(a), payloads(b));
  assert.equal(notifications(a).length, 1, 'including the in-app floor');
});

test('A MISSING ORDER is silence, and notifyOrderDelivered never throws', async () => {
  const raw = freshDb();
  await notifyOrderDelivered(env(raw), 'ORD-nope');
  assert.equal(outboxKeys(raw).length, 0);
  assert.equal(notifications(raw).length, 0);
});

// =========================================================================
// 4. THE COPY — «اجعلها رسالة مرتبة وقصيرة»
// =========================================================================

/**
 * The plain text one channel carried, for one language.
 *
 * `stated` defaults TRUE because these cases are about the COPY, not about
 * which language gets chosen: each one names the language it wants and then
 * asserts the sentence. Without it the English case would describe a Telegram
 * account that never picked anything, and `notificationLang` would answer it
 * in Arabic — which is the right answer to a different question. The choosing
 * itself is pinned separately, below.
 */
async function deliveredText(locale: string, stated = true): Promise<string> {
  const raw = freshDb();
  seedUser(raw, { locale, email: null, phone: PHONE, chat: null, stated });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');
  return payloads(raw).whatsapp!.text;
}

test('THE COPY — the delivered message is the fact, the number inline, and one reason to act', async () => {
  const ar = await deliveredText('ar');
  assert.equal(ar, 'LEVONIS\nتم تسليم طلبك ORD-1. قيّم منتجاته لتحصل على نقاط.\n' + REVIEW_URL);

  // The three things that were wrong with it, named one by one.
  assert.equal(ar.includes('شكراً لثقتك بليفونيس'), false, 'a thank-you nobody asked for was 22 of 36 characters');
  assert.equal(ar.includes('رقم الطلب:'), false, 'the number fits inside the sentence; a line for it is a line on a lock screen');
  assert.equal(ar.includes('هدية'), false, 'the gift is a separate decision by the store — /orders already says so');
  assert.ok(ar.includes('نقاط'), 'review points are the automatic part, and the only part safe to promise');
});

test('THE COPY — all three languages, each one line plus the link', async () => {
  const en = await deliveredText('en');
  assert.equal(en, 'LEVONIS\nOrder ORD-1 has been delivered. Rate its products to earn points.\n' + REVIEW_URL);
  assert.equal(en.includes('Thank you for choosing'), false);
  assert.equal(en.includes('gift'), false);

  const ckb = await deliveredText('ku');
  assert.equal(ckb, 'LEVONIS\nداواکاری ORD-1 گەیەندرا. کاڵاکانی هەڵبسەنگێنە بۆ وەرگرتنی خاڵ.\n' + REVIEW_URL);
  assert.equal(ckb.includes('سوپاس بۆ متمانەت'), false);
});

test('THE LANGUAGE — a Telegram account that never picked one is answered in Arabic, column be damned', async () => {
  /**
   * «اللغة في رسالة إشعار التليكرام لا تطابق اللغة الافتراضية للموقع.»
   *
   * THIS IS THE OWNER'S BUG, pinned on the real notification path rather than
   * on `notificationLang` alone — because the language is chosen in TWO places
   * and a fix in one of them changes no word of the message. `customerNotify`
   * picks the ENVELOPE language; `orderNotify` independently picks the COPY
   * block. This asserts the sentence that actually arrives.
   *
   * The account here is the reported population exactly: a `@telegram.local`
   * placeholder address, minted only by the phone/Telegram signup, whose very
   * next statement writes the `telegram_links` row and which binds NO locale —
   * so the row carries `NOT NULL DEFAULT 'en'` and has never been an answer.
   * On an Arabic-first, Iraq-only shop it must not be read as one.
   */
  const raw = freshDb();
  seedUser(raw, { locale: 'en', email: null, phone: PHONE, chat: null });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');
  assert.equal(
    payloads(raw).whatsapp!.text,
    'LEVONIS\nتم تسليم طلبك ORD-1. قيّم منتجاته لتحصل على نقاط.\n' + REVIEW_URL,
    'a defaulted en on a telegram.local account is not a choice of English'
  );
});

test('THE LANGUAGE — and one tap on English is honoured for ever afterwards', async () => {
  /**
   * The other half, and the reason the fallback is scoped rather than blanket:
   * a Telegram customer who genuinely wants English taps it once and is never
   * second-guessed again. Without this the fix would have overruled everybody
   * who chose English deliberately — a worse failure than the bug it removes.
   *
   * The statement is a `profile.locale_change` line, which PATCH /api/profile
   * writes even when the value does not change: for these accounts that press
   * IS the first answer, and it changes no column.
   */
  const raw = freshDb();
  seedUser(raw, { locale: 'en', email: null, phone: PHONE, chat: null, stated: true });
  seedOrder(raw);
  await notifyOrderDelivered(env(raw), 'ORD-1');
  assert.equal(
    payloads(raw).whatsapp!.text,
    'LEVONIS\nOrder ORD-1 has been delivered. Rate its products to earn points.\n' + REVIEW_URL
  );
});

test('THE COPY — placed, confirmed and shipped name the order INSIDE the sentence and add no line for it', async () => {
  const raw = freshDb();
  seedUser(raw, { email: null, phone: PHONE, chat: null });
  seedOrder(raw);
  const e = env(raw);

  await notifyOrderPlaced(e, 'ORD-1');
  await notifyOrderStatus(e, 'ORD-1', 'confirmed');
  await notifyOrderStatus(e, 'ORD-1', 'shipped');

  const texts = (raw.prepare('SELECT event_key, payload FROM outbox ORDER BY event_key').all() as Array<{
    event_key: string; payload: string;
  }>).map((r) => ({ key: r.event_key, text: (JSON.parse(r.payload) as { text: string }).text }));

  const placed = texts.find((t) => t.key.startsWith('order.placed'))!.text;
  // The money still earns its line. The order number does not: it is in the
  // sentence, and the subject the mail carries has it too.
  assert.equal(placed, 'LEVONIS\nاستلمنا طلبك ORD-1 وهو قيد المراجعة.\nالإجمالي: 105,000 IQD');
  assert.equal(placed.includes('سنخبرك عند تأكيده'), false, 'the next notification announces itself');

  assert.equal(
    texts.find((t) => t.key.includes('confirmed'))!.text,
    'LEVONIS\nتم تأكيد طلبك ORD-1 ويجري تجهيزه.'
  );
  assert.equal(
    texts.find((t) => t.key.includes('shipped'))!.text,
    'LEVONIS\nتم شحن طلبك ORD-1 وهو في الطريق إليك.'
  );
});

test('THE COPY — CANCELLED is untouched, and keeps the ONE detail line it needs', async () => {
  // It states the fact and gives an action to the one reader who needs it —
  // the model the other lines were rewritten against. Its sentence never
  // carried the order number, so its number stays on a line of its own: the
  // email subject is no substitute, because WhatsApp never sees a subject.
  const raw = freshDb();
  seedUser(raw, { email: null, phone: PHONE, chat: null });
  seedOrder(raw);
  await notifyOrderStatus(env(raw), 'ORD-1', 'cancelled');
  assert.equal(
    payloads(raw).whatsapp!.text,
    'LEVONIS\nتم إلغاء طلبك. إن لم تطلب ذلك، تواصل معنا فوراً.\nرقم الطلب: ORD-1'
  );
});
