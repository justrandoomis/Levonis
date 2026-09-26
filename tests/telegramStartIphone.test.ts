/**
 * «هناك مشكلة عند التسجيل عبر التليجرام من الايفون عند الضغط على start up او
 *  start boot لا يفتح ولا يضغط الزر، هذا في الايفون»
 *
 * What these pin, against the REAL routes (auth /telegram/* and the customer
 * bot's /webhook) with a real database and the Telegram API stubbed at fetch:
 *  - the start parameter the site hands to Telegram obeys Telegram's rule
 *    (A–Z a–z 0–9 _ -, ≤ 64) and the three links the page builds from it
 *    (tg://, https://t.me, "/start <code>") carry the same payload;
 *  - the bot answers /start <payload> with the share-contact keyboard, and
 *    answers AGAIN when START is pressed again or a bare /start arrives from a
 *    chat that already has a live request (an existing chat on iPhone);
 *  - the iPhone fallbacks bind the same challenge: the pasted command, the
 *    pasted t.me link, and the bare code;
 *  - a chat with no request is never met with silence or «link invalid» for a
 *    bare /start — it gets instructions and a button back to the site;
 *  - the whole sign-up completes through the fallback path.
 *
 * Run: node --import tsx --test tests/telegramStartIphone.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, get, json, post, row, stubApp } from './fixtures/app';
import { authRoutes } from '../worker/routes/auth';
import { telegramRoutes } from '../worker/routes/telegram';
import { extractStartPayload, startDeepLink, START_PAYLOAD_RE } from '../worker/lib/telegram';
import { telegramOpenLinks, prefersAppScheme, START_PARAM_RE } from '../src/lib/telegramDeepLink';

const TOKEN = '1111:CUSTOMER-BOT-TOKEN';
const HOOK = 'customer-hook-secret';
const BOT = 'LevonisBot';
const PHONE = '+9647701234567';
const TG_USER = 700100200;
const CHAT = 700100200;

interface Sent {
  method: string;
  body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function stubTelegram() {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(String(input));
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body) as Record<string, unknown>; } catch { body = {}; }
    }
    const method = m ? m[1] : 'other';
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 1, is_bot: true, username: BOT } : { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const env = {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_WEBHOOK_SECRET: HOOK,
  APP_ORIGIN: `https://${APEX}`,
};
const appOf = (raw: DatabaseSync) =>
  stubApp(asD1(raw), null, (a) => {
    a.route('/api/auth', authRoutes);
    a.route('/api/telegram', telegramRoutes);
  }, { host: APEX, env });

let updateSeq = 5000;
let ipSeq = 0;
const ip = () => ({ 'CF-Connecting-IP': `10.77.${Math.floor(ipSeq / 250) % 250}.${++ipSeq % 250}` });

function hook(a: ReturnType<typeof appOf>, message: Record<string, unknown>) {
  return post(a, '/api/telegram/webhook', { update_id: ++updateSeq, message }, { 'X-Telegram-Bot-Api-Secret-Token': HOOK });
}
const text = (t: string, chat = CHAT, type = 'private') => ({
  message_id: updateSeq,
  from: { id: chat },
  chat: { id: chat, type },
  text: t,
});
const replies = (sent: Sent[]) => sent.filter((c) => c.method === 'sendMessage');
const last = (sent: Sent[]) => replies(sent)[replies(sent).length - 1];
const hasContactKeyboard = (s: Sent | undefined) =>
  !!s?.body.reply_markup?.keyboard?.[0]?.[0]?.request_contact;

async function startFlow(a: ReturnType<typeof appOf>, purpose: 'signup' | 'login' = 'signup') {
  const r = await post(a, '/api/auth/telegram/start', { phone: PHONE, purpose }, ip());
  const b = await json(r);
  assert.equal(r.status, 200, JSON.stringify(b));
  return b as { deep_link: string; continuation_token: string };
}
const payloadOf = (deepLink: string) => new URL(deepLink).searchParams.get('start') ?? '';
const status = async (a: ReturnType<typeof appOf>, token: string) =>
  (await json(await get(a, `/api/auth/telegram/status?token=${encodeURIComponent(token)}`, ip()))).state as string;

// ------------------------------------------------------------ the link

test('the start parameter the site issues obeys Telegram: [A-Za-z0-9_-], ≤ 64, on every issue', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    for (let i = 0; i < 5; i++) {
      const { deep_link } = await startFlow(a, i % 2 ? 'login' : 'signup');
      const u = new URL(deep_link);
      assert.equal(u.origin, 'https://t.me');
      assert.equal(u.pathname, `/${BOT}`);
      const p = payloadOf(deep_link);
      assert.match(p, /^[A-Za-z0-9_-]+$/);
      assert.ok(p.length <= 64 && p.length >= 32, `length ${p.length}`);
      assert.ok(START_PARAM_RE.test(p) && START_PAYLOAD_RE.test(p));
    }
  } finally {
    tg.restore();
  }
});

test('startDeepLink refuses a payload Telegram would drop, and a bad bot name', () => {
  assert.equal(startDeepLink(BOT, 'A'.repeat(43)), `https://t.me/${BOT}?start=${'A'.repeat(43)}`);
  assert.throws(() => startDeepLink(BOT, 'A'.repeat(65)));
  assert.throws(() => startDeepLink(BOT, 'abc+def/ghi=jklmnopq'));
  assert.throws(() => startDeepLink(BOT, 'short'));
  assert.throws(() => startDeepLink('bad name', 'A'.repeat(43)));
});

test('the page builds tg://, https and the /start command from ONE link, same payload', () => {
  const p = 'Zx9_-abcdefghijklmnopqrstuvwxyzABCDEFGHIJK';
  const l = telegramOpenLinks(`https://t.me/${BOT}?start=${p}`);
  assert.ok(l);
  assert.equal(l.app, `tg://resolve?domain=${BOT}&start=${p}`);
  assert.equal(l.web, `https://t.me/${BOT}?start=${p}`);
  assert.equal(l.command, `/start ${p}`);
  assert.equal(l.chat, `https://t.me/${BOT}`);
  // Anything else is not turned into a link.
  assert.equal(telegramOpenLinks(`https://evil.example/${BOT}?start=${p}`), null);
  assert.equal(telegramOpenLinks(`http://t.me/${BOT}?start=${p}`), null);
  assert.equal(telegramOpenLinks(`https://t.me/${BOT}?start=${'a'.repeat(65)}`), null);
  assert.equal(telegramOpenLinks(`https://t.me/${BOT}?start=a%20b`), null);
  assert.equal(telegramOpenLinks(`https://t.me/${BOT}`), null);
  assert.equal(telegramOpenLinks('javascript:alert(1)'), null);
});

test('phones get the app link; desktops keep the https link', () => {
  assert.equal(prefersAppScheme('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), true);
  assert.equal(prefersAppScheme('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36'), true);
  assert.equal(prefersAppScheme('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5), true, 'iPadOS desktop UA');
  assert.equal(prefersAppScheme('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 0), false);
  assert.equal(prefersAppScheme('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'), false);
});

test('extractStartPayload reads every way a person can hand the code to the bot', () => {
  const p = 'Q'.repeat(20) + '_-' + 'z'.repeat(21);
  assert.deepEqual(extractStartPayload(`/start ${p}`), { kind: 'start', payload: p });
  assert.deepEqual(extractStartPayload(`/start@${BOT} ${p}`), { kind: 'start', payload: p });
  assert.deepEqual(extractStartPayload(`  /start   ${p}  `), { kind: 'start', payload: p });
  assert.deepEqual(extractStartPayload('/start'), { kind: 'start', payload: null });
  assert.deepEqual(extractStartPayload('/START'), { kind: 'start', payload: null });
  assert.deepEqual(extractStartPayload('/start bad!payload'), { kind: 'start', payload: null });
  assert.deepEqual(extractStartPayload(`https://t.me/${BOT}?start=${p}`), { kind: 'link', payload: p });
  assert.deepEqual(extractStartPayload(`افتح t.me/${BOT}?start=${p} شكرا`), { kind: 'link', payload: p });
  assert.deepEqual(extractStartPayload(p), { kind: 'bare', payload: p });
  assert.deepEqual(extractStartPayload('مرحبا'), { kind: 'none', payload: null });
  assert.deepEqual(extractStartPayload('/startx'), { kind: 'none', payload: null });
  assert.deepEqual(extractStartPayload('hello_world'), { kind: 'none', payload: null }, 'short words are not codes');
  assert.deepEqual(extractStartPayload(''), { kind: 'none', payload: null });
});

// ------------------------------------------------------------ the bot

test('/start <payload> binds the chat and replies with the share-contact keyboard', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    const { deep_link, continuation_token } = await startFlow(a);
    const res = await hook(a, text(`/start ${payloadOf(deep_link)}`));
    assert.equal(res.status, 200);
    const reply = last(tg.sent);
    assert.equal(reply.body.chat_id, CHAT);
    assert.ok(hasContactKeyboard(reply), 'share-contact keyboard');
    const ch = row<{ chat_id: number }>(raw, 'SELECT chat_id FROM link_challenges WHERE purpose = ?', 'signup');
    assert.equal(ch?.chat_id, CHAT);
    assert.equal(await status(a, continuation_token), 'pending');
  } finally {
    tg.restore();
  }
});

test('an EXISTING chat: START pressed again, or a bare /start, re-shows the keyboard', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    const { deep_link } = await startFlow(a);
    await hook(a, text(`/start ${payloadOf(deep_link)}`));
    const before = replies(tg.sent).length;
    await hook(a, text(`/start ${payloadOf(deep_link)}`));
    assert.ok(hasContactKeyboard(last(tg.sent)), 'second START with the same payload');
    await hook(a, text('/start'));
    assert.ok(hasContactKeyboard(last(tg.sent)), 'bare /start from a chat with a live request');
    await hook(a, text('ما ظهر الزر'));
    assert.ok(hasContactKeyboard(last(tg.sent)), 'any text from a chat with a live request');
    assert.equal(replies(tg.sent).length, before + 3, 'one reply per message, never silence');
  } finally {
    tg.restore();
  }
});

for (const [name, make] of [
  ['the pasted command', (p: string) => `/start ${p}`],
  ['the pasted t.me link', (p: string) => `https://t.me/${BOT}?start=${p}`],
  ['the bare code', (p: string) => p],
] as const) {
  test(`iPhone fallback — ${name} binds the same challenge`, async () => {
    const raw = freshDb();
    const tg = stubTelegram();
    try {
      const a = appOf(raw);
      const { deep_link } = await startFlow(a);
      await hook(a, text(make(payloadOf(deep_link))));
      assert.ok(hasContactKeyboard(last(tg.sent)));
      const ch = row<{ chat_id: number }>(raw, 'SELECT chat_id FROM link_challenges WHERE purpose = ?', 'signup');
      assert.equal(ch?.chat_id, CHAT);
    } finally {
      tg.restore();
    }
  });
}

test('a chat with NO request: bare /start and plain text get instructions + a button to the site', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    for (const t of ['/start', 'hello']) {
      await hook(a, text(t, 424242));
      const reply = last(tg.sent);
      assert.equal(reply.body.chat_id, 424242);
      assert.match(String(reply.body.text), /\/start/);
      assert.doesNotMatch(String(reply.body.text), /غير صالح/);
      assert.equal(reply.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url, `https://${APEX}/auth`);
      assert.ok(!hasContactKeyboard(reply));
    }
  } finally {
    tg.restore();
  }
});

test('an unknown or expired code is refused (no binding), with the way back to the site', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    await startFlow(a);
    await hook(a, text(`/start ${'N'.repeat(43)}`, 515151));
    const reply = last(tg.sent);
    assert.match(String(reply.body.text), /غير صالح|invalid/);
    assert.ok(!hasContactKeyboard(reply));
    assert.equal(reply.body.reply_markup?.inline_keyboard?.[0]?.[0]?.url, `https://${APEX}/auth`);
    const ch = row<{ chat_id: number | null }>(raw, 'SELECT chat_id FROM link_challenges WHERE purpose = ?', 'signup');
    assert.equal(ch?.chat_id, null);
  } finally {
    tg.restore();
  }
});

test('group traffic is still ignored', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    const { deep_link } = await startFlow(a);
    await hook(a, text(`/start ${payloadOf(deep_link)}`, -100123, 'supergroup'));
    assert.equal(replies(tg.sent).length, 0);
  } finally {
    tg.restore();
  }
});

test('END TO END through the fallback: pasted command → own contact → code → account', async () => {
  const raw = freshDb();
  const tg = stubTelegram();
  try {
    const a = appOf(raw);
    const { deep_link, continuation_token } = await startFlow(a);
    await hook(a, text(`/start ${payloadOf(deep_link)}`));
    await hook(a, {
      message_id: 2,
      from: { id: TG_USER },
      chat: { id: CHAT, type: 'private' },
      contact: { phone_number: PHONE.slice(1), user_id: TG_USER },
    });
    const code = replies(tg.sent)
      .map((c) => /\b(\d{6})\b/.exec(String(c.body.text))?.[1])
      .filter(Boolean)
      .pop();
    assert.ok(code, 'the code went to the chat');
    assert.equal(await status(a, continuation_token), 'otp_sent');
    const r = await post(a, '/api/auth/telegram/complete', { token: continuation_token, code, lang: 'ar' }, ip());
    const b = await json(r);
    assert.equal(r.status, 200, JSON.stringify(b));
    assert.equal(await status(a, continuation_token), 'completed');
  } finally {
    tg.restore();
  }
});
