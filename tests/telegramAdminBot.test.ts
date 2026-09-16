/**
 * THE ADMIN BOT — @alilevobot (migration 0080).
 *
 * The suite the mandate's §26 asks for, against the REAL route module, the
 * REAL migrations and the REAL wallet approval machinery. Telegram itself is
 * the only thing stubbed, and it is stubbed at `fetch` so the code under test
 * builds its own URLs, bodies and tokens exactly as it would in production —
 * which is what lets these tests assert WHICH BOT sent a message.
 *
 * What the suite is really defending:
 *   • the customer bot is untouched — a second bot cannot eat its updates,
 *     answer its callbacks, or leak its token;
 *   • a Telegram numeric id is the only identity that opens the bot door, and
 *     it does NOT by itself open the money door;
 *   • the group and its topics come from Telegram's own updates, and a second
 *     group cannot take them over;
 *   • a routing miss is reported, never a silent drop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, post, row, stubApp, type StubUser } from './fixtures/app';
import { telegramRoutes } from '../worker/routes/telegram';
import {
  adminTelegramIds,
  isBotAdmin,
  notifyAdminTopic,
  resolveAdminDestination,
  readAdminGroup,
  readTopics,
} from '../worker/lib/telegramAdmin';
import { parseCommand } from '../worker/lib/telegramAdminCommands';
import type { Env } from '../worker/lib/types';

const ADMIN_TG = 6404042791;
const OTHER_TG = 111222333;
const GROUP = -1002233445566;
const OTHER_GROUP = -1009988776655;
const SECRET = 'admin-hook-secret';
const ADMIN_TOKEN = '8888:ADMIN-BOT-TOKEN';
const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';

const ADMIN_USER: StubUser = { id: 'u_admin', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };

/** Every Telegram call the code made, with the bot it used decoded from the URL. */
interface TgCall {
  method: string;
  bot: 'customer' | 'admin' | 'unknown';
  body: Record<string, unknown>;
}

function stubTelegram(): { calls: TgCall[]; restore: () => void } {
  const calls: TgCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = /api\.telegram\.org\/bot([^/]+)\/(\w+)/.exec(url);
    if (!m) return real(input as RequestInfo, init);
    const [, token, method] = m;
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = { _nonJson: true };
    }
    calls.push({
      method,
      bot: token === ADMIN_TOKEN ? 'admin' : token === CUSTOMER_TOKEN ? 'customer' : 'unknown',
      body,
    });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 555, chat: { id: GROUP } } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function env(raw: DatabaseSync, over: Partial<Env> = {}): Record<string, unknown> {
  return {
    DB: asD1(raw),
    TELEGRAM_BOT_TOKEN: CUSTOMER_TOKEN,
    TELEGRAM_ADMIN_BOT_TOKEN: ADMIN_TOKEN,
    TELEGRAM_ADMIN_WEBHOOK_SECRET: SECRET,
    TELEGRAM_ADMIN_USER_IDS: String(ADMIN_TG),
    TELEGRAM_WEBHOOK_SECRET: 'customer-hook-secret',
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ...over,
  };
}

const app = (raw: DatabaseSync, over: Partial<Env> = {}, user: StubUser | null = null) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/telegram', telegramRoutes), { host: APEX, env: env(raw, over) });

/** One `message` update, shaped the way Telegram shapes it. */
const message = (
  p: { text: string; from?: number; chat?: number; type?: string; thread?: number | null; title?: string },
  updateId = Math.floor(Math.random() * 1_000_000) + 1
) => ({
  update_id: updateId,
  message: {
    message_id: 9,
    ...(p.thread === undefined || p.thread === null ? {} : { message_thread_id: p.thread }),
    chat: { id: p.chat ?? GROUP, type: p.type ?? 'supergroup', title: p.title ?? 'Levonis Ops', is_forum: true },
    from: { id: p.from ?? ADMIN_TG, username: 'ali' },
    text: p.text,
  },
});

const hook = (a: ReturnType<typeof app>, update: unknown, secret: string | null = SECRET) =>
  post(a, '/api/telegram/ops/webhook', update, secret === null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret });

// =========================================================================
// WEBHOOK
// =========================================================================

test('WEBHOOK — the correct secret is accepted, a wrong one is 403, a missing one is 403, an unset one is 503', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    assert.equal((await hook(app(raw), message({ text: '/topics' }), SECRET)).status, 200);
    assert.equal((await hook(app(raw), message({ text: '/topics' }), 'wrong')).status, 403);
    assert.equal((await hook(app(raw), message({ text: '/topics' }), null)).status, 403);
    // Unset secret is a 503, not a 403: "not configured" and "you are not
    // Telegram" are different diagnoses and the workflow asserts both.
    const unset = app(raw, { TELEGRAM_ADMIN_WEBHOOK_SECRET: undefined });
    assert.equal((await hook(unset, message({ text: '/topics' }), SECRET)).status, 503);
  } finally {
    tg.restore();
  }
});

test('WEBHOOK — the ADMIN bot has its own update-dedup table, so it cannot be starved by the customer bot', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    // A brand-new bot's update_id sequence starts near zero — squarely inside
    // the range the customer bot has been using. Seed the collision.
    raw.exec('INSERT INTO telegram_updates (update_id) VALUES (7), (8), (9)');
    const a = app(raw);
    assert.equal((await hook(a, message({ text: '/topics' }, 7))).status, 200);
    assert.ok(tg.calls.some((c) => c.method === 'sendMessage'), 'the update was PROCESSED, not swallowed as a duplicate');

    // …and a genuine redelivery of the admin bot's own update is a no-op (§16).
    const before = tg.calls.length;
    assert.equal((await hook(a, message({ text: '/topics' }, 7))).status, 200);
    assert.equal(tg.calls.length, before, 'a redelivered update did nothing a second time');
  } finally {
    tg.restore();
  }
});

// =========================================================================
// AUTH
// =========================================================================

test('AUTH — only a numeric id on the allow-list commands the bot; a username is not an identity', async () => {
  const e = { TELEGRAM_ADMIN_USER_IDS: ' 6404042791 , 123456789 ' } as unknown as Env;
  assert.deepEqual([...adminTelegramIds(e)].sort((x, y) => x - y), [123456789, 6404042791]);
  assert.equal(isBotAdmin(e, 6404042791), true);
  assert.equal(isBotAdmin(e, 999), false);
  // A username never opens this door — there is no overload that takes one.
  assert.equal(isBotAdmin(e, 'ali' as unknown as number), false);
  assert.equal(isBotAdmin(e, '6404042791' as unknown as number), false, 'a numeric STRING is not a numeric id');
  // Junk widens nothing and empties nothing.
  assert.deepEqual([...adminTelegramIds({ TELEGRAM_ADMIN_USER_IDS: 'ali,,-5,6404042791,0x1' } as unknown as Env)], [6404042791]);
  // An UNSET allow-list authorises nobody — the safe direction.
  assert.equal(isBotAdmin({} as Env, 6404042791), false);
});

test('AUTH — an unauthorized sender is told nothing about the platform, and never in a group', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    await hook(a, message({ text: '/topics', from: OTHER_TG, chat: OTHER_TG, type: 'private' }));
    const sent = tg.calls.filter((c) => c.method === 'sendMessage');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.text, 'غير مصرح باستخدام بوت الإدارة.');
    assert.equal(sent[0].bot, 'admin');

    // In a GROUP the bot stays silent: answering would announce to everyone
    // present that this bot exists and is listening.
    tg.calls.length = 0;
    await hook(a, message({ text: '/topics', from: OTHER_TG }));
    assert.deepEqual(tg.calls, []);
    assert.equal(await readAdminGroup(asD1(raw)), null, 'and it certainly did not bind their group');
  } finally {
    tg.restore();
  }
});

// =========================================================================
// GROUP SETUP + TOPIC BINDING
// =========================================================================

test('GROUP SETUP — the first authorized /topic_here adopts the group and stores the thread id', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    await hook(a, message({ text: '/topic_here wallet', thread: 42 }));
    const group = await readAdminGroup(asD1(raw));
    assert.equal(group?.groupChatId, String(GROUP));
    assert.equal(group?.groupTitle, 'Levonis Ops');
    assert.equal(group?.configuredByTg, ADMIN_TG);
    const topics = await readTopics(asD1(raw));
    assert.deepEqual(
      topics.map((t) => [t.topicKey, t.messageThreadId, t.enabled]),
      [['wallet', 42, true]]
    );
    // The audit trail names the site-admin identity and the Telegram one.
    const audited = row<{ action: string; detail: string }>(
      raw,
      "SELECT action, detail FROM audit_log WHERE action = 'telegram_admin.topic.bound'"
    );
    assert.ok(audited, 'the binding is audited');
    assert.match(audited!.detail, /"source":"telegram_admin"/);
    assert.match(audited!.detail, /"telegram_user_id":6404042791/);
  } finally {
    tg.restore();
  }
});

test('GROUP SETUP — the General topic has NO thread id, and none is invented', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    // Telegram sends no message_thread_id at all for a forum's General topic.
    await hook(app(raw), message({ text: '/topic_here general', thread: null }));
    const topics = await readTopics(asD1(raw));
    assert.deepEqual(topics.map((t) => [t.topicKey, t.messageThreadId]), [['general', null]]);
  } finally {
    tg.restore();
  }
});

test('GROUP SETUP — a SECOND group is refused, and its refusal is audited', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    await hook(a, message({ text: '/topic_here wallet', thread: 42 }));
    tg.calls.length = 0;
    await hook(a, message({ text: '/topic_here orders', chat: OTHER_GROUP, thread: 7 }));

    const group = await readAdminGroup(asD1(raw));
    assert.equal(group?.groupChatId, String(GROUP), 'the original group still owns the notifications');
    const topics = await readTopics(asD1(raw));
    assert.deepEqual(topics.map((t) => t.topicKey), ['wallet'], 'and the other group bound nothing');
    const sent = tg.calls.find((c) => c.method === 'sendMessage');
    assert.match(String(sent?.body.text ?? ''), /مجموعة إدارة أخرى مربوطة/);
    assert.ok(
      row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'telegram_admin.group.refused'"),
      'the attempt is on the record'
    );
  } finally {
    tg.restore();
  }
});

test('GROUP SETUP — a private chat can never become the admin group', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    await hook(app(raw), message({ text: '/topic_here wallet', chat: ADMIN_TG, type: 'private' }));
    assert.equal(await readAdminGroup(asD1(raw)), null);
    assert.deepEqual(await readTopics(asD1(raw)), []);
    const sent = tg.calls.find((c) => c.method === 'sendMessage');
    assert.match(String(sent?.body.text ?? ''), /من داخل مجموعة الإدارة/);
  } finally {
    tg.restore();
  }
});

test('TOPIC BINDING — re-running /topic_here in another topic MOVES it, it does not duplicate', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    await hook(a, message({ text: '/topic_here wallet', thread: 42 }));
    await hook(a, message({ text: '/topic_here wallet', thread: 99 }));
    const topics = await readTopics(asD1(raw));
    assert.deepEqual(topics.map((t) => [t.topicKey, t.messageThreadId]), [['wallet', 99]]);
  } finally {
    tg.restore();
  }
});

test('TOPIC BINDING — an unknown topic name is refused WITH the list, and binds nothing', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    await hook(app(raw), message({ text: '/topic_here refunds', thread: 42 }));
    assert.deepEqual(await readTopics(asD1(raw)), []);
    const sent = tg.calls.find((c) => c.method === 'sendMessage');
    assert.match(String(sent?.body.text ?? ''), /wallet/);
  } finally {
    tg.restore();
  }
});

test('/topics reports each topic and whether THIS chat is the configured group', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    await hook(a, message({ text: '/topic_here wallet', thread: 42 }));
    tg.calls.length = 0;
    await hook(a, message({ text: '/topics', thread: 42 }));
    const text = String(tg.calls.find((c) => c.method === 'sendMessage')?.body.text ?? '');
    assert.match(text, /✅ المحفظة/);
    assert.match(text, /❌ الدعم — غير مربوط/);
    assert.match(text, /هذه هي مجموعة الإدارة المعتمدة/);

    // …and from a DIFFERENT group it says so plainly rather than looking fine.
    tg.calls.length = 0;
    await hook(a, message({ text: '/topics', chat: OTHER_GROUP, from: ADMIN_TG }));
    assert.match(
      String(tg.calls.find((c) => c.method === 'sendMessage')?.body.text ?? ''),
      /ليست مجموعة الإدارة المعتمدة/
    );
  } finally {
    tg.restore();
  }
});

test('the bot replies INSIDE the topic the command came from', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    await hook(app(raw), message({ text: '/start', thread: 42 }));
    const sent = tg.calls.find((c) => c.method === 'sendMessage');
    assert.equal(sent?.body.message_thread_id, 42);
    assert.match(String(sent?.body.text ?? ''), /مرحباً بك في بوت إدارة Levonis/);
  } finally {
    tg.restore();
  }
});

test('parseCommand strips the @botname Telegram appends in groups', () => {
  assert.deepEqual(parseCommand('/topic_here wallet'), { name: 'topic_here', args: ['wallet'] });
  assert.deepEqual(parseCommand('/topics@alilevobot'), { name: 'topics', args: [] });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand(undefined), null);
});

// =========================================================================
// ROUTING
// =========================================================================

async function bind(raw: DatabaseSync, pairs: Array<[string, number | null]>) {
  const tg = stubTelegram();
  try {
    const a = app(raw);
    for (const [key, thread] of pairs) await hook(a, message({ text: `/topic_here ${key}`, thread }));
  } finally {
    tg.restore();
  }
}

test('ROUTING — each topic goes to its own thread in the bound group, on the ADMIN bot', async () => {
  const raw = freshDb();
  await bind(raw, [
    ['wallet', 10],
    ['orders', 20],
    ['review', 30],
    ['report', 40],
    ['merchant_verification', 50],
    ['support', 60],
    ['general', null],
  ]);
  const e = env(raw) as unknown as Env;
  for (const [topic, thread] of [
    ['wallet', 10],
    ['orders', 20],
    ['review', 30],
    ['report', 40],
    ['merchant_verification', 50],
    ['support', 60],
  ] as const) {
    const res = await resolveAdminDestination(e, topic);
    assert.ok(res.ok, topic);
    assert.deepEqual(
      [res.destination.bot, res.destination.chatId, res.destination.messageThreadId, res.destination.via],
      ['admin', String(GROUP), thread, 'topic'],
      topic
    );
  }
  const general = await resolveAdminDestination(e, 'general');
  assert.ok(general.ok && general.destination.messageThreadId === null, 'General carries no thread id');
});

test('ROUTING — a missing topic falls back to GENERAL, and says it did', async () => {
  const raw = freshDb();
  await bind(raw, [['general', null], ['wallet', 10]]);
  const e = env(raw) as unknown as Env;
  const res = await resolveAdminDestination(e, 'support');
  assert.ok(res.ok);
  assert.equal(res.destination.via, 'general');
  assert.equal(res.destination.topicKey, 'general', 'the row records where it ACTUALLY went');
});

test('ROUTING — with no group bound at all the legacy chat carries it on the CUSTOMER bot', async () => {
  const raw = freshDb();
  const e = env(raw, { TELEGRAM_ADMIN_CHAT_ID: '-100777' }) as unknown as Env;
  const res = await resolveAdminDestination(e, 'wallet');
  assert.ok(res.ok);
  assert.deepEqual(
    [res.destination.bot, res.destination.chatId, res.destination.via],
    ['customer', '-100777', 'legacy'],
    'nothing goes dark during the migration'
  );
});

test('ROUTING — no destination at all is REPORTED, never silently dropped', async () => {
  const raw = freshDb();
  const e = env(raw, { TELEGRAM_ADMIN_BOT_TOKEN: undefined, TELEGRAM_ADMIN_CHAT_ID: undefined }) as unknown as Env;
  const res = await resolveAdminDestination(e, 'wallet');
  assert.deepEqual(res, { ok: false, miss: 'no_group_bound' });

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    const out = await notifyAdminTopic(e, 'wallet', 'x');
    assert.deepEqual(out, { ok: false, reason: 'no_group_bound' });
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1, 'exactly one structured line, not silence');
  const logged = JSON.parse(errors[0]) as Record<string, unknown>;
  assert.equal(logged.event, 'telegram_admin_routing_error');
  assert.equal(logged.topic, 'wallet');
  assert.equal(logged.reason, 'no_group_bound');
});

test('ROUTING — the message really is sent by the ADMIN bot into the bound thread', async () => {
  const raw = freshDb();
  await bind(raw, [['orders', 20]]);
  const tg = stubTelegram();
  try {
    const out = await notifyAdminTopic(env(raw) as unknown as Env, 'orders', 'order X');
    assert.ok(out.ok);
    const sent = tg.calls.find((c) => c.method === 'sendMessage')!;
    assert.equal(sent.bot, 'admin');
    assert.equal(sent.body.chat_id, String(GROUP));
    assert.equal(sent.body.message_thread_id, 20);
    assert.equal(sent.body.text, 'order X');
  } finally {
    tg.restore();
  }
});

// =========================================================================
// SECURITY
// =========================================================================

test('SECURITY — a button press from someone NOT on the allow-list moves nothing', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    await post(
      app(raw),
      '/api/telegram/ops/webhook',
      {
        update_id: 501,
        callback_query: { id: 'cb1', from: { id: OTHER_TG }, data: 'wa:sometoken1234567890', message: { message_id: 5, chat: { id: GROUP } } },
      },
      { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
    );
    const answered = tg.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.equal(answered?.bot, 'admin', 'answered by the bot that owns the conversation');
    assert.equal(answered?.body.text, 'غير مصرح لك بهذا الإجراء.');
    assert.equal(tg.calls.filter((c) => c.method.startsWith('edit')).length, 0, 'and nothing was edited');
    assert.ok(row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'telegram_admin.callback.denied'"));
  } finally {
    tg.restore();
  }
});

test('SECURITY — being on the bot allow-list does NOT grant financial authority', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    // ADMIN_TG passes door 1 but has no admin_tg_identities row, so the wallet
    // machinery's own authority check must still refuse the decision.
    await post(
      app(raw),
      '/api/telegram/ops/webhook',
      {
        update_id: 502,
        callback_query: { id: 'cb2', from: { id: ADMIN_TG }, data: 'wa:sometoken1234567890', message: { message_id: 5, chat: { id: GROUP } } },
      },
      { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
    );
    const answered = tg.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.match(String(answered?.body.text ?? ''), /لا تملك صلاحية اعتماد مالي/);
    assert.equal(
      row(raw, "SELECT COUNT(*) AS n FROM wallet_transactions")?.n ?? 0,
      0,
      'no ledger row was created by a button press'
    );
  } finally {
    tg.restore();
  }
});

test('SECURITY — the admin token never appears in a webhook-info response', async () => {
  const raw = freshDb();
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ ok: true, result: { url: `https://x/bot${ADMIN_TOKEN}/hook`, pending_update_count: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;
  try {
    const a = app(raw, {}, ADMIN_USER);
    const res = await a.request('/api/telegram/admin/admin-webhook-info', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    const body = await res.text();
    assert.ok(!body.includes(ADMIN_TOKEN), 'the admin bot token is masked');
    assert.ok(!body.includes(CUSTOMER_TOKEN), 'and so is the customer one');
    assert.match(body, /\*\*\*/);
  } finally {
    globalThis.fetch = real;
  }
});

test('SECURITY — bot-status reports what is CONFIGURED, never a secret value', async () => {
  const raw = freshDb();
  await bind(raw, [['wallet', 10]]);
  const a = app(raw, {}, ADMIN_USER);
  const res = await a.request('/api/telegram/admin/bot-status', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!body.includes(ADMIN_TOKEN) && !body.includes(SECRET) && !body.includes(String(ADMIN_TG)));
  const parsed = JSON.parse(body) as { configured: Record<string, unknown>; topics: Array<Record<string, unknown>> };
  assert.equal(parsed.configured.bot_token, true);
  assert.equal(parsed.configured.admin_user_ids, 1, 'a COUNT, not the ids');
  assert.deepEqual(
    parsed.topics.find((t) => t.key === 'wallet'),
    { key: 'wallet', label: 'المحفظة', bound: true, message_thread_id: 10 }
  );
});

// =========================================================================
// CUSTOMER-BOT REGRESSION
// =========================================================================

test('REGRESSION — the customer webhook still works, and the two bots do not share a secret', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    // The customer webhook accepts ONLY its own secret…
    const ok = await post(a, '/api/telegram/webhook', { update_id: 1 }, { 'X-Telegram-Bot-Api-Secret-Token': 'customer-hook-secret' });
    assert.equal(ok.status, 200);
    // …and rejects the admin bot's.
    const cross = await post(a, '/api/telegram/webhook', { update_id: 2 }, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    assert.equal(cross.status, 403);
    // And the reverse: the admin webhook rejects the customer secret.
    const back = await hook(a, message({ text: '/topics' }), 'customer-hook-secret');
    assert.equal(back.status, 403);
  } finally {
    tg.restore();
  }
});

test('REGRESSION — the two bots keep separate dedup ledgers', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    await post(a, '/api/telegram/webhook', { update_id: 4242 }, { 'X-Telegram-Bot-Api-Secret-Token': 'customer-hook-secret' });
    await hook(a, message({ text: '/topics' }, 4242));
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM telegram_updates')?.n, 1);
    assert.equal(row<{ n: number }>(raw, 'SELECT COUNT(*) AS n FROM telegram_admin_updates')?.n, 1);
    assert.ok(tg.calls.some((c) => c.method === 'sendMessage' && c.bot === 'admin'), 'the admin update was processed');
  } finally {
    tg.restore();
  }
});
