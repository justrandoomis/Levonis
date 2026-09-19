/**
 * THE TOPIC VOCABULARY — nine destinations, one group, two bots.
 *
 * The owner's group has nine forum topics («🔥 Warranty support · 📝 Orders
 * pre-order · 📝 Orders direct · # General · 💲 Wallet · 📢 Review · ❗ Report ·
 * ⚡ Merchants verification · ‼️ Support») and the vocabulary used to have seven
 * keys. This suite defends the four things that could quietly go wrong while
 * closing that gap — each test names the production change that would break it,
 * because a test whose failure nobody can interpret is a test that gets deleted.
 *
 * Telegram is stubbed at `fetch`, exactly as tests/telegramAdminBot.test.ts does
 * it, so the code under test builds its own URLs and picks its own token — which
 * is what lets the last test assert WHICH BOT was used rather than trust a flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, post, stubApp, type StubUser } from './fixtures/app';
import { telegramRoutes } from '../worker/routes/telegram';
import {
  BINDABLE_TOPIC_KEYS,
  TOPIC_KEYS,
  bindAdminGroup,
  bindTopic,
  isGroupChatId,
  isTopicKey,
  notifyAdminTopic,
  readAdminGroup,
  resolveAdminDestination,
  topicLabel,
  type TopicKey,
} from '../worker/lib/telegramAdmin';
import type { Env } from '../worker/lib/types';

const ADMIN_TG = 6404042791;
const GROUP = -1002233445566;
const SECRET = 'admin-hook-secret';
const ADMIN_TOKEN = '8888:ADMIN-BOT-TOKEN';
const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const ADMIN_USER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'full' };

interface TgCall { method: string; bot: 'customer' | 'admin' | 'unknown'; body: Record<string, unknown> }

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
    calls.push({ method, bot: token === ADMIN_TOKEN ? 'admin' : token === CUSTOMER_TOKEN ? 'customer' : 'unknown', body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 555, chat: { id: GROUP } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function env(raw: DatabaseSync, over: Partial<Env> = {}): Env {
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
  } as unknown as Env;
}

/** Binds the group and the given topics DIRECTLY, without going through the
 *  command parser — this suite is about the vocabulary and the ladder, and a
 *  parser change must not be able to make these tests pass or fail. */
async function seed(raw: DatabaseSync, pairs: Array<[string, number | null]>, chatId = String(GROUP)) {
  const db = asD1(raw);
  const bound = await bindAdminGroup(db, { chatId, title: 'Levonis Ops', userId: 'boss', telegramUserId: ADMIN_TG });
  assert.ok(bound.ok, 'the fixture group was accepted');
  for (const [topicKey, messageThreadId] of pairs) {
    const wrote = await bindTopic(db, {
      topicKey: topicKey as TopicKey,
      messageThreadId,
      userId: 'boss',
      telegramUserId: ADMIN_TG,
      groupChatId: chatId,
    });
    assert.ok(wrote, `fixture bound ${topicKey}`);
  }
}

// =========================================================================
// 1. THE VOCABULARY
// =========================================================================

/**
 * WHAT WOULD BREAK THIS: adding a key to TOPIC_KEYS and forgetting its label.
 * `topicLabel` falls back to the raw key rather than throwing, so the failure
 * is invisible in code review and shows up as a bare English `orders_preorder`
 * sitting in the owner's Arabic `/topics` list. TypeScript catches a missing
 * entry in TOPIC_LABELS because the Record is keyed by TopicKey — this catches
 * the other half: an entry that exists but was never translated.
 */
test('VOCABULARY — every key has a real Arabic label, and no two keys share one', () => {
  const labels = TOPIC_KEYS.map((k) => topicLabel(k));
  for (const [i, key] of TOPIC_KEYS.entries()) {
    assert.notEqual(labels[i], key, `${key} fell through to its raw key instead of a label`);
    assert.ok(labels[i].trim().length > 0, `${key} has an empty label`);
    assert.ok(/[؀-ۿ]/.test(labels[i]), `${key}'s label is not Arabic — the owner reads this list`);
  }
  assert.equal(new Set(labels).size, labels.length, 'two destinations cannot share a label — /topics would be unreadable');
});

/**
 * WHAT WOULD BREAK THIS: someone "tidying up" by deleting the legacy `orders`
 * key, or by adding the tenth key to the owner's checklist. The group has nine
 * topics; a checklist of ten can never reach «كل المواضيع مربوطة» and the owner
 * would keep hunting for a topic that does not exist in their group.
 */
test('VOCABULARY — nine bindable destinations, and the legacy `orders` key is not one of them', () => {
  assert.equal(BINDABLE_TOPIC_KEYS.length, 9, 'one line per topic in the owner’s group');
  assert.equal(BINDABLE_TOPIC_KEYS.includes('orders' as TopicKey), false, '`orders` still resolves but is not advertised');
  for (const k of ['warranty', 'orders_preorder', 'orders_direct', 'wallet', 'review', 'report', 'merchant_verification', 'support', 'general'] as const) {
    assert.ok(BINDABLE_TOPIC_KEYS.includes(k), `${k} is one of the nine`);
  }
  // …and the command still ACCEPTS the retired name, so an owner following the
  // old instructions is not told their own binding is a typo.
  assert.equal(isTopicKey('orders'), true);
  assert.equal(isTopicKey('orders_typo'), false);
});

// =========================================================================
// 2. THE FALLBACK — nothing is ever dropped
// =========================================================================

/**
 * WHAT WOULD BREAK THIS: making `resolveAdminDestination` throw, or return
 * `ok: false`, for a key with no row. Every new key ships unbound on the day it
 * deploys — that is the NORMAL state, not an error — and a throw here would be
 * an unhandled rejection inside a `waitUntil` on the order-placed path.
 */
test('FALLBACK — an unbound key never throws and never goes nowhere', async () => {
  const raw = freshDb();
  await seed(raw, [['general', null], ['wallet', 10]]);
  const e = env(raw);
  for (const key of BINDABLE_TOPIC_KEYS) {
    const res = await resolveAdminDestination(e, key);
    assert.ok(res.ok, `${key} resolved to somewhere`);
    assert.equal(res.destination.chatId, String(GROUP), `${key} stayed in the admin group`);
  }
  // The brand-new key, specifically: General carried it and the row SAYS so.
  const warranty = await resolveAdminDestination(e, 'warranty');
  assert.ok(warranty.ok);
  assert.equal(warranty.destination.via, 'general');
  assert.equal(warranty.destination.topicKey, 'general', 'the audit records where it ACTUALLY went');
});

/**
 * WHAT WOULD BREAK THIS: dropping the `warranty → support` chain. Warranty
 * tickets would then land in General, mixed in with everything else — which is
 * the pile the owner opened «Warranty support» to stop reading.
 */
test('FALLBACK — warranty rests on Support before it rests on General', async () => {
  const raw = freshDb();
  await seed(raw, [['general', null], ['support', 60]]);
  const res = await resolveAdminDestination(env(raw), 'warranty');
  assert.ok(res.ok);
  assert.deepEqual([res.destination.messageThreadId, res.destination.topicKey, res.destination.via], [60, 'support', 'fallback']);
});

/**
 * WHAT WOULD BREAK THIS: removing the fallback chain when the orders key was
 * split. The owner's EXISTING `/topic_here orders` row would stop carrying new
 * orders the moment this deployed, and every order notification would land in
 * General while the owner watched an Orders topic that had gone quiet. This is
 * the backward-compatibility guarantee, stated as a test.
 */
test('LEGACY — an existing `orders` binding still carries BOTH kinds of order after the split', async () => {
  const raw = freshDb();
  await seed(raw, [['general', null], ['orders', 20]]);
  const e = env(raw);
  for (const key of ['orders', 'orders_preorder', 'orders_direct'] as const) {
    const res = await resolveAdminDestination(e, key);
    assert.ok(res.ok, key);
    assert.equal(res.destination.messageThreadId, 20, `${key} still lands in the owner's Orders topic`);
  }
  // The literal key still hits its own row directly, not via the chain.
  const direct = await resolveAdminDestination(e, 'orders');
  assert.ok(direct.ok && direct.destination.via === 'topic');
});

/**
 * WHAT WOULD BREAK THIS: binding the two new topics and deleting the old
 * `orders` row while worker/routes/orders.ts and worker/routes/returns.ts still
 * pass the literal 'orders'. Without the mirror chain those live call sites
 * would fall all the way to General.
 */
test('LEGACY — once the split topics exist, the literal `orders` key follows them', async () => {
  const raw = freshDb();
  await seed(raw, [['general', null], ['orders_direct', 21], ['orders_preorder', 22]]);
  const res = await resolveAdminDestination(env(raw), 'orders');
  assert.ok(res.ok);
  assert.deepEqual([res.destination.messageThreadId, res.destination.topicKey, res.destination.via], [21, 'orders_direct', 'fallback']);
});

/**
 * WHAT WOULD BREAK THIS: a future edit that follows a fallback chain RECURSIVELY.
 * `orders_preorder → orders` and `orders → orders_preorder` name each other, and
 * a recursive walk over that pair loops forever — inside a `waitUntil`, with a
 * customer waiting. The flat lookup is what makes the pair safe; this test fails
 * (by timing out or by stack overflow) the moment it stops being flat.
 */
test('FALLBACK — mutually-referencing chains terminate', async () => {
  const raw = freshDb();
  await seed(raw, [['general', null]]);
  const e = env(raw);
  for (const key of ['orders', 'orders_preorder', 'orders_direct'] as const) {
    const res = await resolveAdminDestination(e, key);
    assert.ok(res.ok && res.destination.via === 'general', `${key} landed in General rather than looping`);
  }
});

// =========================================================================
// 3. THE TWO BOTS NEVER CROSS
// =========================================================================

/**
 * WHAT WOULD BREAK THIS: a `group/reset` replacement, an import script, or any
 * future writer storing a PRIVATE chat id as the admin group. Every admin
 * notification — including the wallet ones that carry a customer's payment-proof
 * photo — is addressed with that stored id on the ADMIN bot's token, so the
 * failure would be @alilevobot DMing those photos to one person. A group id is
 * negative and a private chat id is the user's own positive id; that sign is the
 * one structural line between the two bots, checked at the write and at the read.
 */
test('BOUNDARY — a private chat id can never become the admin group', async () => {
  assert.equal(isGroupChatId(String(GROUP)), true);
  assert.equal(isGroupChatId(String(ADMIN_TG)), false, 'a positive id is a PERSON');
  assert.equal(isGroupChatId(''), false);
  assert.equal(isGroupChatId('-'), false);

  const raw = freshDb();
  const refused = await bindAdminGroup(asD1(raw), {
    chatId: String(ADMIN_TG),
    title: 'Ali',
    userId: 'boss',
    telegramUserId: ADMIN_TG,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, 'not_a_group');
  assert.equal(await readAdminGroup(asD1(raw)), null, 'nothing was stored');
});

/**
 * WHAT WOULD BREAK THIS: trusting a row that predates the write-side check.
 * The read-side guard is what makes the boundary hold for data already on disk,
 * so this test writes the bad row the way a stale deployment would have — going
 * around `bindAdminGroup` entirely — and proves the router still refuses to put
 * the ADMIN bot's token on a private chat.
 */
test('BOUNDARY — the admin bot is never used on a customer-facing chat, even from a bad row', async () => {
  const raw = freshDb();
  raw.exec(
    `INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
       VALUES ('singleton', '${ADMIN_TG}', 'a DM, not a group', 'boss', ${ADMIN_TG})`
  );
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let res;
  try {
    res = await resolveAdminDestination(env(raw, { TELEGRAM_ADMIN_CHAT_ID: '-100777' } as Partial<Env>), 'wallet');
  } finally {
    console.error = realError;
  }
  assert.ok(res.ok);
  assert.notEqual(res.destination.bot, 'admin', 'the admin token never addresses a private chat');
  assert.deepEqual([res.destination.chatId, res.destination.via], ['-100777', 'legacy'], 'it degraded to the legacy chat');
  assert.ok(errors.length === 1 && errors[0].includes('telegram_admin_group_not_a_group'), 'and said so, once');
});

/**
 * WHAT WOULD BREAK THIS: a notifier passing 'admin' to a customer-facing send,
 * or the router handing an admin chat id to the customer bot. The token is
 * decoded from the URL the code itself built, so nothing here can be faked by a
 * flag: `sendMessage` for an admin topic must carry the ADMIN token and the
 * GROUP chat id, and no customer-token call may be made at all.
 */
test('BOUNDARY — a routed admin notification is sent by @alilevobot, into the group thread', async () => {
  const raw = freshDb();
  await seed(raw, [['general', null], ['warranty', 70]]);
  const tg = stubTelegram();
  try {
    const out = await notifyAdminTopic(env(raw), 'warranty', 'ticket W-1');
    assert.ok(out.ok);
    const sent = tg.calls.filter((c) => c.method === 'sendMessage');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bot, 'admin');
    assert.equal(sent[0].body.chat_id, String(GROUP));
    assert.equal(sent[0].body.message_thread_id, 70);
    assert.equal(tg.calls.some((c) => c.bot === 'customer'), false, 'the member bot carried nothing');
  } finally {
    tg.restore();
  }
});

// =========================================================================
// 4. /topics — the owner's checklist
// =========================================================================

/**
 * WHAT WOULD BREAK THIS: `/topics` listing the seven old keys, or printing
 * «غير مربوط» without naming the command. The owner binds these from a phone,
 * inside Telegram, with no access to the code — if the reply does not spell out
 * the exact command, the only way to learn `orders_preorder` is to ask.
 */
test('/topics — lists the nine, marks the unbound ones, and spells out the command for each', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT OR IGNORE INTO users (id,name,email,password_hash,role) VALUES ('boss','Ali','boss@x.co','h','admin');
    INSERT OR IGNORE INTO admin_tg_identities (telegram_user_id,user_id,created_by) VALUES (${ADMIN_TG},'boss','boss');
  `);
  await seed(raw, [['wallet', 10], ['orders', 20]]);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), ADMIN_USER, (a) => a.route('/api/telegram', telegramRoutes), {
      host: APEX,
      env: env(raw) as unknown as Partial<Env>,
    });
    const res = await post(
      app,
      '/api/telegram/ops/webhook',
      {
        update_id: 4242,
        message: {
          message_id: 9,
          chat: { id: GROUP, type: 'supergroup', title: 'Levonis Ops', is_forum: true },
          from: { id: ADMIN_TG, username: 'ali' },
          text: '/topics',
        },
      },
      { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
    );
    assert.equal(res.status, 200);
    const text = String(tg.calls.find((c) => c.method === 'sendMessage')?.body.text ?? '');
    assert.ok(text.includes('(9)'), 'the checklist is nine long');
    assert.ok(text.includes(`✅ ${topicLabel('wallet')}`), 'a bound topic is ticked');
    for (const key of BINDABLE_TOPIC_KEYS) {
      if (key === 'wallet') continue;
      assert.ok(text.includes(`❌ ${topicLabel(key)}`), `${key} is shown as unbound`);
      assert.ok(text.includes(`/topic_here ${key}`), `${key}'s exact command is printed`);
    }
    // The legacy row is explained rather than left to look like a lost message.
    assert.ok(text.includes('orders'), 'the legacy orders binding is named');
    assert.ok(text.includes(topicLabel('orders_preorder')), 'and the split topics appear by their Arabic names');
  } finally {
    tg.restore();
  }
});
