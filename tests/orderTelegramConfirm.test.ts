/**
 * «تم تأكيد الطلب» — THE BUTTON ON THE ORDER MESSAGE, PRESSED THROUGH THE REAL
 * WEBHOOK.
 *
 * The owner asked for the «📝 Orders» message to carry an inline button that
 * confirms the order. A commit once claimed it and nothing existed: the send
 * carried no keyboard, and the admin bot handed EVERY callback to the wallet
 * handler, which answers anything it cannot parse with «زر غير صالح».
 *
 * So every test here goes through `POST /api/telegram/ops/webhook` (or the
 * customer bot's `/webhook` for the legacy ladder), with the Telegram API
 * stubbed at `fetch` and the database real, and asserts on what the owner and
 * the customer would actually see: the order's status, the customer's message
 * in the outbox (SENT, not merely queued), the answer the button gave, and the
 * rewritten group message.
 *
 * Run: node --import tsx --test tests/orderTelegramConfirm.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, post, stubApp } from './fixtures/app';
import { telegramRoutes } from '../worker/routes/telegram';
import { orderConfirmKeyboard, stampedText } from '../worker/lib/orderTelegramConfirm';
import type { Env } from '../worker/lib/types';

const ADMIN_TG = 6404042791;
const OUTSIDER_TG = 5550001111;
const GROUP = -1002233445566;
const SECRET = 'admin-hook-secret';
const CUSTOMER_SECRET = 'customer-hook-secret';
const ADMIN_TOKEN = '8888:ADMIN-BOT-TOKEN';
const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const ORIGINAL = '🛒 طلب جديد — ORD-TG1\nالزبون: سارة\nالإجمالي: 100,000 د.ع';

interface Call {
  method: string;
  bot: 'admin' | 'customer' | 'other';
  body: Record<string, unknown>;
}

function stubFetch(): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = /api\.telegram\.org\/bot([^/]+)\/(\w+)/.exec(url);
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = {}; }
    }
    if (!m) {
      // The customer's e-mail leaving the outbox. Nothing here reaches the
      // network.
      calls.push({ method: 'email', bot: 'other', body });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }
    calls.push({ method: m[2], bot: m[1] === ADMIN_TOKEN ? 'admin' : m[1] === CUSTOMER_TOKEN ? 'customer' : 'other', body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900, chat: { id: GROUP } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const envOf = (over: Record<string, unknown> = {}) => ({
  TELEGRAM_BOT_TOKEN: CUSTOMER_TOKEN,
  TELEGRAM_ADMIN_BOT_TOKEN: ADMIN_TOKEN,
  TELEGRAM_ADMIN_WEBHOOK_SECRET: SECRET,
  TELEGRAM_WEBHOOK_SECRET: CUSTOMER_SECRET,
  TELEGRAM_ADMIN_USER_IDS: `${ADMIN_TG},${OUTSIDER_TG}`,
  APP_ORIGIN: 'https://levonis-iq.com',
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  INITIAL_ADMIN_EMAIL: 'boss@x.co',
  ...over,
});

const appOf = (raw: DatabaseSync, over: Record<string, unknown> = {}) =>
  stubApp(asD1(raw), null, (a) => a.route('/api/telegram', telegramRoutes), { host: APEX, env: envOf(over) });

function seed(opts: { status?: string; payment?: string; gini?: string; identity?: boolean } = {}): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale) VALUES
      ('boss','Ali','boss@x.co','h','admin',NULL,'ar'),
      ('cust','سارة','sara@x.co','h','customer','2026-01-01T00:00:00.000Z','ar');
    INSERT INTO telegram_admin_config (id,group_chat_id,group_title,configured_by,configured_by_tg)
      VALUES ('singleton','${GROUP}','Levonis Ops','boss',${ADMIN_TG});
  `);
  if (opts.identity !== false) {
    raw.exec(`INSERT INTO admin_tg_identities (telegram_user_id,user_id,created_by) VALUES (${ADMIN_TG},'boss','boss');`);
  }
  raw
    .prepare(
      `INSERT INTO orders
         (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
          subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,gini_state)
       VALUES ('ORD-TG1','cust',?, '{}','home','{}',?,100000,1400,100000,0,'direct',?,?)`
    )
    .run(
      opts.status ?? 'pending',
      opts.payment ?? 'cash',
      opts.status === 'cancelled' ? 'cancelled' : opts.status === 'confirmed' ? 'confirmed' : 'received',
      opts.gini ?? ''
    );
  return raw;
}

let updateSeq = 7000;
const press = (
  raw: DatabaseSync,
  from: number,
  opts: { chat?: number; data?: string; over?: Record<string, unknown> } = {}
) =>
  post(
    appOf(raw, opts.over),
    '/api/telegram/ops/webhook',
    {
      update_id: ++updateSeq,
      callback_query: {
        id: `cb${updateSeq}`,
        from: { id: from },
        data: opts.data ?? 'oc:ORD-TG1',
        message: { message_id: 900, chat: { id: opts.chat ?? GROUP }, text: ORIGINAL },
      },
    },
    { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
  );

const orderOf = (raw: DatabaseSync) =>
  ({ ...(raw.prepare("SELECT status, stage FROM orders WHERE id = 'ORD-TG1'").get() as object) }) as {
    status: string;
    stage: string;
  };
const answers = (calls: Call[]) => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body.text));

// =========================================================================
// THE BUTTON THAT IS SENT
// =========================================================================

test('THE KEYBOARD — the owner\'s words on the button, the order in the callback, the panel under it', () => {
  const kb = orderConfirmKeyboard({ APP_ORIGIN: 'https://levonis-iq.com' } as Env, 'ORD-TG1') as {
    inline_keyboard: Array<Array<Record<string, string>>>;
  };
  assert.deepEqual(kb.inline_keyboard[0], [{ text: '✅ تم تأكيد الطلب', callback_data: 'oc:ORD-TG1' }]);
  assert.deepEqual(kb.inline_keyboard[1], [
    { text: '🔗 فتح في لوحة الإدارة', url: 'https://levonis-iq.com/admin?tab=orders&order=ORD-TG1' },
  ]);
  // No https origin: no link (an unlinked button is honest, a half-built one
  // is not) — the confirm button stands alone.
  const bare = orderConfirmKeyboard({ APP_ORIGIN: '' } as Env, 'ORD-TG1') as { inline_keyboard: unknown[][] };
  assert.equal(bare.inline_keyboard.length, 1);
  // An id Telegram could not carry in 64 bytes gets NO callback button rather
  // than a keyboard Telegram would refuse along with the whole message.
  const long = orderConfirmKeyboard({ APP_ORIGIN: '' } as Env, 'x'.repeat(62));
  assert.equal(long, null);
});

test('THE STAMP survives the length limit — the body is trimmed, never the record of who confirmed', () => {
  const out = stampedText('x'.repeat(5000), '✅ تم التأكيد — Ali');
  assert.ok(out.length <= 4000);
  assert.ok(out.endsWith('✅ تم التأكيد — Ali'));
});

// =========================================================================
// WHO MAY PRESS IT
// =========================================================================

test('A TELEGRAM ID OFF THE ALLOW-LIST is refused and the order does not move', async () => {
  const raw = seed();
  const tg = stubFetch();
  try {
    const res = await press(raw, 123456789);
    assert.equal(res.status, 200);
    assert.deepEqual(orderOf(raw), { status: 'pending', stage: 'received' });
    assert.match(answers(tg.calls).join('|'), /غير مصرح/);
    assert.equal(tg.calls.filter((c) => c.method === 'editMessageText').length, 0);
  } finally {
    tg.restore();
  }
});

test('ON THE ALLOW-LIST BUT NO SITE ADMIN BEHIND IT — door 2 refuses', async () => {
  const raw = seed({ identity: false });
  const tg = stubFetch();
  try {
    await press(raw, ADMIN_TG);
    assert.deepEqual(orderOf(raw), { status: 'pending', stage: 'received' });
    assert.match(answers(tg.calls).join('|'), /لا تملك صلاحية تأكيد الطلبات/);
    const denied = raw.prepare("SELECT action FROM audit_log WHERE action = 'telegram.order_confirm.denied'").get();
    assert.ok(denied, 'the refusal is audited');
  } finally {
    tg.restore();
  }
});

test('A FORWARDED COPY in another chat carries a dead button', async () => {
  const raw = seed();
  const tg = stubFetch();
  try {
    await press(raw, ADMIN_TG, { chat: -1009999999999 });
    assert.deepEqual(orderOf(raw), { status: 'pending', stage: 'received' });
    assert.match(answers(tg.calls).join('|'), /مجموعة الإدارة فقط/);
  } finally {
    tg.restore();
  }
});

// =========================================================================
// THE PRESS
// =========================================================================

test('THE SYMPTOM — an admin press CONFIRMS the order, tells the customer, and rewrites the message', async () => {
  const raw = seed();
  const tg = stubFetch();
  try {
    const res = await press(raw, ADMIN_TG);
    assert.equal(res.status, 200);
    // The order moved through the stage door: status AND stage.
    assert.deepEqual(orderOf(raw), { status: 'confirmed', stage: 'confirmed' });
    const history = raw.prepare("SELECT stage, changed_by, note FROM order_status_history WHERE order_id = 'ORD-TG1'").all();
    assert.deepEqual(history.map((h) => ({ ...(h as object) })), [{ stage: 'confirmed', changed_by: 'boss', note: 'Telegram' }]);

    // The customer was told — and the message LEFT, it did not wait for a cron.
    const mail = raw.prepare("SELECT state FROM outbox WHERE event_key = 'order.status.confirmed:ORD-TG1:email'").get() as { state: string };
    assert.equal(mail.state, 'sent');
    assert.ok(raw.prepare("SELECT 1 FROM user_notifications WHERE event_key = 'order.status.confirmed:ORD-TG1'").get());

    // The button answered with what was committed…
    assert.deepEqual(answers(tg.calls), ['تم تأكيد الطلب ✅']);
    // …and the group message now says who confirmed it, with the confirm
    // button gone and the panel link kept.
    const edit = tg.calls.find((c) => c.method === 'editMessageText');
    assert.ok(edit, 'the message was rewritten');
    assert.equal(edit!.bot, 'admin');
    assert.match(String(edit!.body.text), /^🛒 طلب جديد — ORD-TG1/);
    assert.match(String(edit!.body.text), /✅ تم التأكيد — Ali — \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const kb = edit!.body.reply_markup as { inline_keyboard: Array<Array<Record<string, string>>> };
    assert.deepEqual(kb.inline_keyboard, [
      [{ text: '🔗 فتح في لوحة الإدارة', url: 'https://levonis-iq.com/admin?tab=orders&order=ORD-TG1' }],
    ]);

    // The same audit line the panel's stage door writes, with the Telegram id.
    const a = raw.prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'order.stage'").get() as { actor_id: string; detail: string };
    assert.equal(a.actor_id, 'boss');
    assert.equal(JSON.parse(a.detail).source, 'telegram_admin');
    assert.equal(JSON.parse(a.detail).telegram_user_id, ADMIN_TG);
  } finally {
    tg.restore();
  }
});

test('THE SECOND PRESS is a no-op that says so, and takes the button away', async () => {
  const raw = seed();
  const tg = stubFetch();
  try {
    await press(raw, ADMIN_TG);
    tg.calls.length = 0;
    await press(raw, ADMIN_TG);
    assert.deepEqual(answers(tg.calls), ['الطلب مؤكد مسبقاً.']);
    assert.equal(
      (raw.prepare("SELECT COUNT(*) AS n FROM order_status_history WHERE order_id = 'ORD-TG1'").get() as { n: number }).n,
      1,
      'one confirmation, however many presses'
    );
    const edit = tg.calls.find((c) => c.method === 'editMessageText');
    assert.match(String(edit!.body.text), /الطلب مؤكد مسبقاً/);
  } finally {
    tg.restore();
  }
});

test('AN UNSCANNED GINI ORDER is refused exactly as the panel refuses it — and the button stays', async () => {
  const raw = seed({ payment: 'gini', gini: 'awaiting_receipt' });
  const tg = stubFetch();
  try {
    await press(raw, ADMIN_TG);
    assert.deepEqual(orderOf(raw), { status: 'pending', stage: 'received' });
    assert.match(answers(tg.calls).join('|'), /باركود الاستلام في تطبيق جني/);
    assert.equal(tg.calls.filter((c) => c.method.startsWith('edit')).length, 0, 'scan it, then the same press is right');
  } finally {
    tg.restore();
  }
});

test('A CANCELLED ORDER is not resurrected from the group', async () => {
  const raw = seed({ status: 'cancelled' });
  const tg = stubFetch();
  try {
    await press(raw, ADMIN_TG);
    assert.equal(orderOf(raw).status, 'cancelled');
    assert.match(answers(tg.calls).join('|'), /الطلب ملغى/);
  } finally {
    tg.restore();
  }
});

test('A WALLET BUTTON is still the wallet\'s — the order dispatch takes only its own namespace', async () => {
  const raw = seed();
  const tg = stubFetch();
  try {
    await press(raw, ADMIN_TG, { data: 'wa:not-a-real-token' });
    assert.equal(orderOf(raw).status, 'pending');
    assert.doesNotMatch(answers(tg.calls).join('|'), /تم تأكيد الطلب/);
  } finally {
    tg.restore();
  }
});

test('THE LEGACY LADDER — before a group is bound, the CUSTOMER bot carries the message, and its button works too', async () => {
  const raw = seed();
  raw.exec("DELETE FROM telegram_admin_config");
  const LEGACY_CHAT = -1001112223334;
  const tg = stubFetch();
  try {
    const res = await post(
      appOf(raw, { TELEGRAM_ADMIN_CHAT_ID: String(LEGACY_CHAT) }),
      '/api/telegram/webhook',
      {
        update_id: 99001,
        callback_query: {
          id: 'cbL',
          from: { id: ADMIN_TG },
          data: 'oc:ORD-TG1',
          message: { message_id: 901, chat: { id: LEGACY_CHAT }, text: ORIGINAL },
        },
      },
      { 'X-Telegram-Bot-Api-Secret-Token': CUSTOMER_SECRET }
    );
    assert.equal(res.status, 200);
    assert.equal(orderOf(raw).status, 'confirmed');
    const edit = tg.calls.find((c) => c.method === 'editMessageText');
    assert.equal(edit?.bot, 'customer', 'edited by the bot that sent it');
  } finally {
    tg.restore();
  }
});
