import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, post, row, stubApp, type StubUser } from './fixtures/app';
import { telegramRoutes } from '../worker/routes/telegram';
import { readAdminGroup, readTopics, resolveAdminDestination } from '../worker/lib/telegramAdmin';
import type { Env } from '../worker/lib/types';

const ADMIN_TG = 6404042791;
const SECRET = 'admin-hook-secret';
const ADMIN_TOKEN = '8888:ADMIN-BOT-TOKEN';
const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const ATTACKER_GROUP = -1005555555555;

function stubTelegram() {
  const calls: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const m = /api\.telegram\.org\/bot([^/]+)\/(\w+)/.exec(url);
    if (!m) return real(input, init);
    let body: any = {};
    try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
    calls.push({ method: m[2], token: m[1], body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
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
    ...over,
  };
}
const app = (raw: DatabaseSync, over: Partial<Env> = {}, user: StubUser | null = null) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/telegram', telegramRoutes), { host: APEX, env: env(raw, over) });

test('PROBE A — a PLAIN NON-FORUM group is adopted as the admin group', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    const res = await post(a, '/api/telegram/ops/webhook', {
      update_id: 900,
      message: {
        message_id: 1,
        // NOTE: no message_thread_id, chat.type = 'group', is_forum ABSENT/false
        chat: { id: ATTACKER_GROUP, type: 'group', title: 'Random staff chat', is_forum: false },
        from: { id: ADMIN_TG, username: 'ali' },
        text: '/topic_here wallet',
      },
    }, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    assert.equal(res.status, 200);
    const group = await readAdminGroup(asD1(raw));
    console.log('  bound group ->', JSON.stringify(group));
    console.log('  topics      ->', JSON.stringify(await readTopics(asD1(raw))));
    const dest = await resolveAdminDestination(env(raw) as unknown as Env, 'wallet');
    console.log('  wallet dest ->', JSON.stringify(dest));
    const reply = tg.calls.find((c) => c.method === 'sendMessage');
    console.log('  bot replied ->', JSON.stringify(reply?.body?.text));
    assert.equal(group?.groupChatId, String(ATTACKER_GROUP), 'NON-FORUM group was adopted');
  } finally { tg.restore(); }
});

test('PROBE B — the binder needs NO site admin role (door 2) at all', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    // prove there is no admin_tg_identities row for ADMIN_TG
    const ident = row(raw, 'SELECT COUNT(*) AS n FROM admin_tg_identities');
    console.log('  admin_tg_identities rows:', JSON.stringify(ident));
    const a = app(raw);
    await post(a, '/api/telegram/ops/webhook', {
      update_id: 901,
      message: {
        message_id: 1, message_thread_id: 77,
        chat: { id: ATTACKER_GROUP, type: 'supergroup', title: 'Attacker forum', is_forum: true },
        from: { id: ADMIN_TG }, text: '/topic_here wallet',
      },
    }, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    const cfg = row(raw, "SELECT group_chat_id, configured_by, configured_by_tg FROM telegram_admin_config");
    console.log('  config row  ->', JSON.stringify(cfg));
    const aud = row(raw, "SELECT actor_id, action, detail FROM audit_log WHERE action='telegram_admin.topic.bound'");
    console.log('  audit row   ->', JSON.stringify(aud));
    assert.ok(cfg, 'a door-1-only identity bound the group');
  } finally { tg.restore(); }
});

test('PROBE C — unauthorized user writes audit rows + dedup rows, unbounded', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    for (let i = 0; i < 25; i++) {
      await post(a, '/api/telegram/ops/webhook', {
        update_id: 2000 + i,
        callback_query: { id: 'cb' + i, from: { id: 999888777 }, data: 'wa:xyz', message: { message_id: 5, chat: { id: -100123 } } },
      }, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    }
    console.log('  audit_log denied rows      :', JSON.stringify(row(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action='telegram_admin.callback.denied'")));
    console.log('  telegram_admin_updates rows:', JSON.stringify(row(raw, 'SELECT COUNT(*) AS n FROM telegram_admin_updates')));
    console.log('  outbound telegram calls    :', tg.calls.length);
  } finally { tg.restore(); }
});

test('PROBE D — reset races /topic_here leaving an orphan topic row', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = app(raw);
    // group A binds
    await post(a, '/api/telegram/ops/webhook', {
      update_id: 3000,
      message: { message_id: 1, message_thread_id: 42, chat: { id: -100111, type: 'supergroup', title: 'A', is_forum: true }, from: { id: ADMIN_TG }, text: '/topic_here wallet' },
    }, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    // simulate the reset landing between bindAdminGroup's read and bindTopic:
    // delete config+topics, then let bindTopic finish (emulated by a 2nd bind
    // whose group read happened before the delete — here approximated by
    // deleting config only and running bindTopic directly).
    raw.exec("DELETE FROM telegram_admin_topics; DELETE FROM telegram_admin_config;");
    const { bindTopic } = await import('../worker/lib/telegramAdmin');
    await bindTopic(asD1(raw), { topicKey: 'wallet', messageThreadId: 42, userId: 'tg:x', telegramUserId: ADMIN_TG });
    // now group B adopts
    await post(a, '/api/telegram/ops/webhook', {
      update_id: 3001,
      message: { message_id: 1, message_thread_id: 9, chat: { id: -100222, type: 'supergroup', title: 'B', is_forum: true }, from: { id: ADMIN_TG }, text: '/topic_here orders' },
    }, { 'X-Telegram-Bot-Api-Secret-Token': SECRET });
    const dest = await resolveAdminDestination(env(raw) as unknown as Env, 'wallet');
    console.log('  topics now  ->', JSON.stringify(await readTopics(asD1(raw))));
    console.log('  wallet dest ->', JSON.stringify(dest));
  } finally { tg.restore(); }
});
