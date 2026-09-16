/**
 * WALLET TOP-UP, DECIDED FROM @alilevobot, END TO END.
 *
 * Nothing here re-implements a wallet decision and nothing here asserts about
 * a mock. The chain is the production one:
 *
 *   enqueueDepositAdminNotification   (routes by topic, stores bot + thread)
 *     → processWalletNotifications    (mints the tokens, sends as the ADMIN bot)
 *       → the RAW token off the button we actually sent
 *         → POST /api/telegram/ops/webhook with that callback
 *           → handleAdminActionCallback → walletOps.decideDeposit
 *
 * The raw action token exists in exactly one place — the `callback_data` of
 * the keyboard Telegram was handed — because only its SHA-256 digest is
 * stored. Reading it back out of the captured send is therefore the ONLY
 * honest way to press the button, and it is what makes these end-to-end
 * rather than a re-statement of the implementation.
 *
 * §15 CONCURRENCY and §16 IDEMPOTENCY are the point of half of them: the
 * database transaction is the authority, the Telegram message is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, freshDb, pending, post, row, stubApp } from './fixtures/app';
import { telegramRoutes } from '../worker/routes/telegram';
import { enqueueDepositAdminNotification, processWalletNotifications } from '../worker/lib/walletNotify';
import type { Env } from '../worker/lib/types';

const ADMIN_TG = 6404042791;
const SECOND_TG = 5550001111;
const GROUP = -1002233445566;
const WALLET_THREAD = 77;
const SECRET = 'admin-hook-secret';
const ADMIN_TOKEN = '8888:ADMIN-BOT-TOKEN';
const CUSTOMER_TOKEN = '1111:CUSTOMER-BOT-TOKEN';

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
    const raw = init?.body;
    if (typeof raw === 'string') {
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = {}; }
    } else if (raw instanceof FormData) {
      // sendPhoto is multipart; the keyboard rides as a JSON string field.
      // `forEach` rather than `entries()`: the Workers FormData lib type this
      // project compiles tests against does not declare an iterator.
      raw.forEach((v, k) => { if (typeof v === 'string') body[k] = v; });
    }
    calls.push({ method, bot: token === ADMIN_TOKEN ? 'admin' : token === CUSTOMER_TOKEN ? 'customer' : 'unknown', body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900, chat: { id: GROUP } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const envOf = (raw: DatabaseSync, over: Record<string, unknown> = {}) => ({
  DB: asD1(raw),
  TELEGRAM_BOT_TOKEN: CUSTOMER_TOKEN,
  TELEGRAM_ADMIN_BOT_TOKEN: ADMIN_TOKEN,
  TELEGRAM_ADMIN_WEBHOOK_SECRET: SECRET,
  TELEGRAM_ADMIN_USER_IDS: `${ADMIN_TG},${SECOND_TG}`,
  TELEGRAM_WEBHOOK_SECRET: 'customer-hook-secret',
  APP_ORIGIN: 'https://levonis-iq.com',
  INITIAL_ADMIN_EMAIL: 'boss@x.co',
  EXTRA_ALLOWED_ORIGINS: '',
  ...over,
});

const app = (raw: DatabaseSync, over: Record<string, unknown> = {}) =>
  stubApp(asD1(raw), null, (a) => a.route('/api/telegram', telegramRoutes), { host: APEX, env: envOf(raw, over) });

/**
 * A real pending deposit, a real site admin, and the Telegram identity that
 * carries financial authority — the mapping `resolveAdminActor` reads.
 *
 * `SECOND_TG` is deliberately on the BOT allow-list but given NO identity
 * row here unless a test asks: that is the difference between the two doors.
 */
function seed(raw: DatabaseSync, opts: { secondAdmin?: boolean } = {}) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Ali','boss@x.co','h','admin'),
      ('boss2','Sara','sara@x.co','h','admin'),
      ('u1','Customer','u1@x.co','h','customer');
    UPDATE users SET email_verified_at = '2026-01-01T00:00:00.000Z' WHERE id = 'u1';
    -- Linked to the CUSTOMER bot: §18 says the customer is reached through the
    -- existing architecture, and @alilevobot never DMs them.
    INSERT INTO telegram_links (user_id,chat_id,telegram_user_id,phone_e164,verified_at)
      VALUES ('u1',424242,424242,'+9647700000000','2026-01-01T00:00:00.000Z');
    INSERT INTO admin_tg_identities (telegram_user_id,user_id,created_by)
      VALUES (${ADMIN_TG},'boss','boss');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,created_by)
      VALUES ('dep1','u1','deposit','USD',5000,'pending','bank transfer','user');
    INSERT INTO wallet_deposit_meta (tx_id,user_id,provider,channel,reference,reference_norm,declared_amount_cents,review_state)
      VALUES ('dep1','u1','zaincash','app','REF-9','ref9',5000,'awaiting_review');
    INSERT INTO telegram_admin_config (id,group_chat_id,group_title,configured_by,configured_by_tg)
      VALUES ('singleton','${GROUP}','Levonis Ops','boss',${ADMIN_TG});
    INSERT INTO telegram_admin_topics (topic_key,message_thread_id,configured_by,configured_by_tg)
      VALUES ('wallet',${WALLET_THREAD},'boss',${ADMIN_TG});
  `);
  if (opts.secondAdmin) {
    raw.exec(`INSERT INTO admin_tg_identities (telegram_user_id,user_id,created_by)
                VALUES (${SECOND_TG},'boss2','boss');`);
  }
}

/**
 * The tokens off a keyboard we actually sent, as {label → raw token}.
 *
 * `reply_markup` arrives as a JSON STRING from sendMessage/sendPhoto and as an
 * OBJECT from editMessageReplyMarkup, because one is a multipart field and the
 * other a JSON body field. Both shapes are read here rather than asserted
 * about, since which one it is says nothing about correctness.
 */
function keyboardOf(call: TgCall | undefined): Map<string, string> {
  assert.ok(call, 'nothing was sent');
  const markup = call!.body.reply_markup;
  const parsed = (typeof markup === 'string' ? JSON.parse(markup) : markup) as {
    inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
  };
  const out = new Map<string, string>();
  for (const rowBtns of parsed.inline_keyboard ?? []) {
    for (const b of rowBtns) if (b.callback_data?.startsWith('wa:')) out.set(b.text, b.callback_data.slice(3));
  }
  return out;
}

const buttonsOf = (calls: TgCall[]) =>
  keyboardOf([...calls].reverse().find((c) => c.method === 'sendPhoto' || c.method === 'sendMessage'));

/** The ✅ and ❌ buttons, selected by the emoji the keyboard actually uses. */
const approveToken = (b: Map<string, string>) => {
  const hit = [...b.entries()].find(([l]) => l.startsWith('✅'));
  assert.ok(hit, `no approve button among: ${[...b.keys()].join(' | ')}`);
  return hit![1];
};
const rejectMenuToken = (b: Map<string, string>) => {
  const hit = [...b.entries()].find(([l]) => l.startsWith('❌'));
  assert.ok(hit, `no reject button among: ${[...b.keys()].join(' | ')}`);
  return hit![1];
};

/** Enqueue + deliver for real, and hand back the live buttons. */
async function deliver(raw: DatabaseSync, calls: TgCall[]) {
  const env = envOf(raw) as unknown as Env;
  const enq = await enqueueDepositAdminNotification(env, 'dep1');
  assert.ok(enq.enqueued, `enqueue failed: ${enq.reason}`);
  await processWalletNotifications(env, 5);
  return buttonsOf(calls);
}

const press = (
  a: ReturnType<typeof app>,
  token: string,
  from: number,
  updateId: number,
  cbId = `cb${updateId}`
) =>
  post(
    a,
    '/api/telegram/ops/webhook',
    {
      update_id: updateId,
      callback_query: { id: cbId, from: { id: from }, data: `wa:${token}`, message: { message_id: 900, chat: { id: GROUP } } },
    },
    { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
  );

const status = (raw: DatabaseSync) =>
  row<{ status: string; decided_by: string | null }>(
    raw,
    'SELECT status, decided_by FROM wallet_transactions WHERE id = ?',
    'dep1'
  )!;

const approved = (raw: DatabaseSync) =>
  row<{ n: number }>(
    raw,
    "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id='u1' AND type='deposit' AND status='approved'"
  )!.n;

// =========================================================================

test('the wallet notification goes to the WALLET topic, on the ADMIN bot, with the proof attached', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    await deliver(raw, tg.calls);
    const send = tg.calls.find((c) => c.method === 'sendPhoto' || c.method === 'sendMessage')!;
    assert.equal(send.bot, 'admin');
    assert.equal(String(send.body.chat_id), String(GROUP));
    assert.equal(String(send.body.message_thread_id), String(WALLET_THREAD));
    // The row records where it was addressed, for the routing audit.
    const stored = row<{ bot: string; message_thread_id: number; topic_key: string }>(
      raw,
      'SELECT bot, message_thread_id, topic_key FROM tg_admin_notifications LIMIT 1'
    )!;
    assert.deepEqual(stored, { bot: 'admin', message_thread_id: WALLET_THREAD, topic_key: 'wallet' });
  } finally {
    tg.restore();
  }
});

test('APPROVE — the shared service credits once, the message is stamped, the customer is queued', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    const approve = approveToken(buttons);
    tg.calls.length = 0;

    const res = await press(app(raw), approve, ADMIN_TG, 1001);
    assert.equal(res.status, 200);
    await Promise.allSettled(pending);

    // 1. The MONEY — one transition, by the site identity behind the Telegram one.
    assert.deepEqual(status(raw), { status: 'approved', decided_by: 'boss' });
    assert.equal(approved(raw), 1, 'exactly one approved deposit row');

    // 2. The ANSWER came first and is honest about what committed (§14).
    const answered = tg.calls.find((c) => c.method === 'answerCallbackQuery')!;
    assert.equal(answered.bot, 'admin', 'answered by the bot that delivered the button');
    assert.match(String(answered.body.text), /تمت الموافقة وأُضيف الرصيد/);

    // 3. The MESSAGE was edited by the admin bot and its buttons are gone.
    const edit = tg.calls.find((c) => c.method.startsWith('editMessage'))!;
    assert.equal(edit.bot, 'admin');
    assert.match(String(edit.body.caption ?? edit.body.text), /تمت الموافقة/);
    assert.equal(keyboardOf(edit).size, 0, 'no decision button survives the decision');

    // 4. AUDIT — the existing trail, with the Telegram source named (§17).
    assert.ok(row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'telegram.deposit.approved'"));
    assert.ok(row(raw, "SELECT 1 AS x FROM audit_log WHERE action = 'wallet.deposit.approved'"), 'the service audited it too');

    // 5. CUSTOMER NOTIFICATION — through the existing outbox, not a new path.
    assert.ok(
      row(raw, "SELECT 1 AS x FROM outbox WHERE event_key LIKE 'wallet.deposit.approved:dep1%'"),
      'the customer status notification is queued'
    );
  } finally {
    tg.restore();
  }
});

test('APPROVE TWICE — the second press changes nothing and says so', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    const approve = approveToken(buttons);
    const a = app(raw);
    await press(a, approve, ADMIN_TG, 2001);
    await Promise.allSettled(pending);
    tg.calls.length = 0;

    // A DIFFERENT update id, so the webhook dedup is not what saves us — the
    // single-use token claim and the ledger guard are.
    await press(a, approve, ADMIN_TG, 2002);
    await Promise.allSettled(pending);

    assert.equal(approved(raw), 1, 'still exactly one credit');
    const answered = tg.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.match(String(answered?.body.text ?? ''), /عولج|لم يعد صالح/, 'the second reviewer is told');
  } finally {
    tg.restore();
  }
});

test('REJECT — the reason menu is required, and the rejection carries the chosen reason', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    const rejectMenu = rejectMenuToken(buttons);
    const a = app(raw);

    // The ✖ button opens a REASON PICKER; it does not reject on its own.
    tg.calls.length = 0;
    await press(a, rejectMenu, ADMIN_TG, 3001);
    assert.equal(status(raw).status, 'pending', 'opening the menu decided nothing');
    const menuEdit = tg.calls.find((c) => c.method === 'editMessageReplyMarkup')!;
    assert.equal(menuEdit.bot, 'admin');
    const reasons = keyboardOf(menuEdit);
    assert.ok(reasons.size >= 2, 'the picker offers real reasons');

    // Picking one finalizes the rejection.
    const [label, token] = [...reasons.entries()].find(([l]) => l.startsWith('❌'))!;
    tg.calls.length = 0;
    await press(a, token, ADMIN_TG, 3002);
    await Promise.allSettled(pending);

    assert.deepEqual(status(raw), { status: 'rejected', decided_by: 'boss' });
    assert.equal(approved(raw), 0, 'a rejection credits nothing');
    const edit = tg.calls.find((c) => c.method.startsWith('editMessage'))!;
    const finalText = String(edit.body.caption ?? edit.body.text);
    assert.match(finalText, /تم الرفض/);
    // The label carries the ❌ prefix the button had; the stamp carries the
    // reason text itself.
    assert.match(finalText, new RegExp(label.replace(/^❌\s*/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the stamp names the reason');
  } finally {
    tg.restore();
  }
});

test('REJECT AFTER APPROVE — the loser writes nothing and is told who decided', async () => {
  const raw = freshDb();
  seed(raw, { secondAdmin: true });
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    const approve = approveToken(buttons);
    const rejectMenu = rejectMenuToken(buttons);
    const a = app(raw);

    await press(a, approve, ADMIN_TG, 4001);
    await Promise.allSettled(pending);
    tg.calls.length = 0;

    // 300 ms later, in the real world. A second admin presses Reject.
    await press(a, rejectMenu, SECOND_TG, 4002);
    await Promise.allSettled(pending);

    assert.deepEqual(status(raw), { status: 'approved', decided_by: 'boss' }, 'no second mutation');
    assert.equal(approved(raw), 1);
    const answered = tg.calls.find((c) => c.method === 'answerCallbackQuery');
    assert.match(String(answered?.body.text ?? ''), /عولج|لم يعد صالح/);
  } finally {
    tg.restore();
  }
});

test('IDEMPOTENCY — a redelivered webhook update is a no-op, not a second decision', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    const approve = approveToken(buttons);
    const a = app(raw);

    await press(a, approve, ADMIN_TG, 5001);
    await Promise.allSettled(pending);
    tg.calls.length = 0;

    // Telegram resends THE SAME update_id after a lost response.
    const again = await press(a, approve, ADMIN_TG, 5001);
    assert.equal(again.status, 200, 'acknowledged so Telegram stops retrying');
    assert.deepEqual(tg.calls, [], 'and nothing at all happened a second time');
    assert.equal(approved(raw), 1);
  } finally {
    tg.restore();
  }
});

test('SECURITY — the callback carries no amount, and a forged one changes nothing', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    // Not one button leaks a number, a user id or a request id.
    for (const [, token] of buttons) {
      assert.match(token, /^[A-Za-z0-9_-]{16,60}$/, 'an opaque token and nothing else');
      assert.ok(!token.includes('5000') && !token.includes('dep1') && !token.includes('u1'));
    }
    const a = app(raw);

    // A token that was never minted decides nothing…
    await press(a, 'AAAAAAAAAAAAAAAAAAAAAAAA', ADMIN_TG, 6001);
    assert.equal(status(raw).status, 'pending');
    // …and neither does malformed callback_data.
    tg.calls.length = 0;
    await post(
      a,
      '/api/telegram/ops/webhook',
      { update_id: 6002, callback_query: { id: 'cbX', from: { id: ADMIN_TG }, data: 'not-ours', message: { message_id: 900, chat: { id: GROUP } } } },
      { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
    );
    assert.equal(status(raw).status, 'pending');
    assert.equal(approved(raw), 0);
    // The spinner is always released (§14).
    assert.ok(tg.calls.some((c) => c.method === 'answerCallbackQuery'));
  } finally {
    tg.restore();
  }
});

test('SECURITY — a real token pressed from a DIFFERENT chat is refused', async () => {
  const raw = freshDb();
  seed(raw);
  const tg = stubTelegram();
  try {
    const buttons = await deliver(raw, tg.calls);
    const approve = approveToken(buttons);
    await post(
      app(raw),
      '/api/telegram/ops/webhook',
      {
        update_id: 7001,
        // A forwarded button: the same token, another chat.
        callback_query: { id: 'cbF', from: { id: ADMIN_TG }, data: `wa:${approve}`, message: { message_id: 900, chat: { id: -1009999999 } } },
      },
      { 'X-Telegram-Bot-Api-Secret-Token': SECRET }
    );
    await Promise.allSettled(pending);
    assert.equal(status(raw).status, 'pending', 'a copied button is bound to no message');
    assert.equal(approved(raw), 0);
  } finally {
    tg.restore();
  }
});

test('REGRESSION — with no admin group bound the deposit still reaches the legacy chat on the customer bot', async () => {
  const raw = freshDb();
  seed(raw);
  raw.exec("DELETE FROM telegram_admin_topics; DELETE FROM telegram_admin_config;");
  const tg = stubTelegram();
  try {
    const env = envOf(raw, { TELEGRAM_ADMIN_BOT_TOKEN: undefined, TELEGRAM_ADMIN_CHAT_ID: '-100555' }) as unknown as Env;
    const enq = await enqueueDepositAdminNotification(env, 'dep1');
    assert.ok(enq.enqueued);
    await processWalletNotifications(env, 5);
    const send = tg.calls.find((c) => c.method === 'sendPhoto' || c.method === 'sendMessage')!;
    assert.equal(send.bot, 'customer', 'the pre-0080 path is intact');
    assert.equal(String(send.body.chat_id), '-100555');
    assert.equal(send.body.message_thread_id, undefined, 'and carries no thread id');
  } finally {
    tg.restore();
  }
});
