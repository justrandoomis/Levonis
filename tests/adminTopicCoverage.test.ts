/**
 * NO BOUND TOPIC IS DECORATIVE — and no promise the customer is shown is empty.
 *
 * THE FAILURE THIS SUITE EXISTS FOR. A half-routed feature that LOOKS whole is
 * worse than a missing one. The owner binds nine Telegram topics, the bot
 * answers «🎉 كل المواضيع مربوطة», and then «❗ Report» and «⚡ Merchants
 * verification» sit empty for ever because no code path ever addressed them.
 * Nothing errors, nothing logs, and the only symptom is an owner who concludes
 * the whole thing is broken and stops looking at any of the topics.
 *
 * The same shape of failure on the customer's side: a sheet appears after a
 * ticket is opened and offers to send support's answer to their phone, they
 * link Telegram, and no code path anywhere produces that message. They learn
 * that the channel does not work, and then ignore the order updates that DO
 * arrive.
 *
 * SO THE FIRST TEST IS A CENSUS, not a behaviour. It reads the real worker
 * sources and proves every bindable topic key has at least one producer. It
 * fails the day somebody adds a tenth topic to the checklist and forgets to
 * feed it — which is precisely how the two empty topics happened, and the one
 * defect no end-to-end test can catch, because you cannot write an end-to-end
 * test for a call site that does not exist.
 *
 * Run: npx tsx --test tests/adminTopicCoverage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, row, count, pending } from './fixtures/app';
import { BINDABLE_TOPIC_KEYS } from '../worker/lib/telegramAdmin';
import { deviceRoutes } from '../worker/routes/devices';
import { priceReportRoutes } from '../worker/routes/priceReports';
import { supportRoutes } from '../worker/routes/support';
import { notifyOfferReceived } from '../worker/lib/engagementNotify';
import type { Env } from '../worker/lib/types';

// =========================================================================
// THE CENSUS
// =========================================================================

const WORKER_DIRS = ['worker/routes', 'worker/lib'];

/** Every .ts under worker/routes and worker/lib, read once. */
function workerSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const dir of WORKER_DIRS) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith('.ts')) continue;
      const path = join(dir, name.name);
      out.push({ path, text: readFileSync(path, 'utf8') });
    }
  }
  return out;
}

/**
 * The two library files are excluded because they DEFINE the vocabulary — the
 * key appears in `TOPIC_KEYS`, in `TOPIC_LABELS` and in `TOPIC_FALLBACK`
 * without anything being sent anywhere. Counting those would make the census
 * pass for a topic nothing produces, which is the exact bug it is written to
 * catch.
 */
const VOCABULARY_FILES = [
  'worker/lib/telegramAdmin.ts',
  'worker/lib/telegramAdminCommands.ts',
  // And the policy module, for the same reason one rung up: it DEFINES
  // `orderTopic` and `ticketTopic`, so counting it would let the census pass on
  // the strength of a function nobody calls.
  'worker/lib/adminTopicRouting.ts',
];

/**
 * Producers, expressed as the SHAPE of a real call rather than the bare key:
 * `'report'` on its own would match a comment, a column name or an unrelated
 * string. A topic reached through `orderTopic()` or `ticketTopic()` counts for
 * the keys those functions can return, which is how the split topics and the
 * warranty topic are actually addressed.
 */
function producersFor(key: string): RegExp[] {
  const direct = [
    new RegExp(`announceAfterResponse\\(\\s*c\\s*,\\s*'${key}'`),
    new RegExp(`announceToAdmins\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*'${key}'`),
    new RegExp(`notifyAdminTopic\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*\\n?\\s*'${key}'`),
    new RegExp(`notifyAdminTopic\\(\\s*\\n\\s*[A-Za-z0-9_.]+,\\s*\\n\\s*'${key}'`),
    new RegExp(`resolveAdminDestination\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*'${key}'`),
  ];
  if (key === 'orders_preorder' || key === 'orders_direct') direct.push(/orderTopic\(/);
  if (key === 'support' || key === 'warranty') direct.push(/ticketTopic\(/);
  return direct;
}

test('CENSUS — every topic the owner is asked to bind has something that sends to it', () => {
  const sources = workerSources().filter((s) => !VOCABULARY_FILES.includes(s.path));
  const unfed: string[] = [];
  for (const key of BINDABLE_TOPIC_KEYS) {
    const patterns = producersFor(key);
    const fed = sources.some((s) => patterns.some((re) => re.test(s.text)));
    if (!fed) unfed.push(key);
  }
  assert.deepEqual(
    unfed,
    [],
    `these topics are on the /topics checklist and nothing sends to them: ${unfed.join(', ')}`
  );
});

test('CENSUS — nothing passes the flat legacy `orders` key any more', () => {
  /**
   * While ANY live call site passed `'orders'`, the split was theatre: the
   * exact-key rung of `resolveAdminDestination` matched the owner's old
   * binding and won for ever, and once that row was deleted the fallback chain
   * filed every pre-order under «📝 Orders direct». Either way the highest
   * volume notification on the platform was the one event the owner's split
   * never applied to.
   *
   * The key itself stays in the vocabulary — an existing binding must keep
   * working — so the assertion is about CALL SITES, not about the constant.
   */
  const offenders = workerSources()
    .filter((s) => !VOCABULARY_FILES.includes(s.path))
    .filter((s) => /(announceAfterResponse|announceToAdmins|notifyAdminTopic|resolveAdminDestination)\(\s*\n?\s*[A-Za-z0-9_.]+\s*,\s*\n?\s*'orders'/.test(s.text))
    .map((s) => s.path);
  assert.deepEqual(offenders, [], `these still address the pre-split key: ${offenders.join(', ')}`);
});

test('CENSUS — the order path uses the split, and takes it from the priced shipping type', () => {
  const orders = readFileSync('worker/routes/orders.ts', 'utf8');
  assert.match(
    orders,
    /announceAfterResponse\(\s*\n\s*c,\s*\n\s*orderTopic\(orderShippingType\)/,
    'a new order is filed by the same shipping type the cart was priced with'
  );
  // And it is contained: the old form handed a promise that CAN reject straight
  // to waitUntil on the request of a customer who had just paid. The import is
  // the assertion, because it is the thing that cannot be true by accident —
  // matching on the call text alone also matches the comment that explains it.
  assert.doesNotMatch(
    orders,
    /^import .*notifyAdminTopic.*$/m,
    'the checkout path no longer reaches the bare router at all'
  );
});

test('CENSUS — the customer email is no longer broadcast into the staff group', () => {
  // walletNotify.ts masks a phone even in the wallet caption, where the
  // reviewer genuinely needs to call. An email in a line whose whole job is to
  // say "something arrived" is not defensible, and these are group chats that
  // get screenshotted.
  for (const path of ['worker/routes/orders.ts', 'worker/routes/wallet.ts']) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /username \|\| user\.email/,
      `${path} still puts a customer's email in an admin broadcast`
    );
  }
});

// =========================================================================
// END TO END — THE TOPICS THAT HAD NO CALL SITE AT ALL
// =========================================================================

const GROUP = '-1001234567890';
const THREADS: Record<string, number> = {
  general: 1,
  wallet: 11,
  review: 22,
  report: 33,
  merchant_verification: 44,
  support: 55,
  warranty: 66,
  orders_preorder: 77,
  orders_direct: 88,
};

function bindGroup(raw: DatabaseSync): void {
  raw
    .prepare(
      `INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
       VALUES ('singleton', ?, 'Levonis', 'boss', 1)`
    )
    .run(GROUP);
  for (const [key, thread] of Object.entries(THREADS)) {
    raw
      .prepare(
        `INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg)
         VALUES (?, ?, 1, 'boss', 1)`
      )
      .run(key, thread);
  }
}

interface SentMessage {
  chat_id: string;
  message_thread_id?: number;
  text: string;
}

function stubTelegram(): { sent: SentMessage[]; restore: () => void } {
  const sent: SentMessage[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) return real(url as never, init as never);
    sent.push(JSON.parse(String(init?.body ?? '{}')) as SentMessage);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

async function drain(): Promise<void> {
  while (pending.length) await Promise.all(pending.splice(0, pending.length));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const ENV = { TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN' };
const BUYER = { id: 'buyer', role: 'customer' as const, email: 's@x.co' };

function seedCustomer(raw: DatabaseSync): void {
  raw.exec(
    "INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');"
  );
}

/** A delivered, registered unit — the only state a warranty claim may be opened from. */
function seedRegisteredDevice(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p1','p1','Printer',500000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,shipping_type)
      VALUES ('ORD-D','buyer','delivered','{}','standard','{}','cash',500000,0,1400,500000,0,'2026-09-18T00:00:00.000Z','direct');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_1','ORD-D','p1','Printer','',1,500000,500000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_end_at)
      VALUES ('oiu_1','ORD-D','oi_1','p1','buyer',1,'2026-09-18T00:00:00.000Z','2027-09-18T00:00:00.000Z');
  `);
}

test('WARRANTY CLAIM — «تذاكر الضمان» reaches the topic the owner named it for', async () => {
  /**
   * THE CLEAREST GAP BETWEEN WHAT WAS ASKED FOR AND WHAT SHIPPED. Support
   * tickets that happened to carry a `unit_id` reached «🔥 Warranty support»;
   * the FORMAL claim — the `warranty_claims` row with its stages and its
   * private evidence, which is the thing the owner named — reached the group
   * by no path at all. `grep -c notify worker/routes/devices.ts` returned 0.
   */
  const raw = freshDb();
  seedCustomer(raw);
  seedRegisteredDevice(raw);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/devices', deviceRoutes), { env: ENV });
    const reg = await post(app, '/api/devices/units/oiu_1/register', {});
    assert.equal(reg.status, 200, await reg.text());
    tg.sent.length = 0;
    const res = await post(app, '/api/devices/units/oiu_1/claims', {
      subject: 'Hotend stopped heating',
      description: 'It fails to reach temperature after two months of light use.',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1, 'the claim is announced exactly once');
    assert.equal(tg.sent[0].chat_id, GROUP);
    assert.equal(tg.sent[0].message_thread_id, THREADS.warranty);
    assert.match(tg.sent[0].text, /oiu_1/, 'the device is named so staff can open it');
    assert.doesNotMatch(
      tg.sent[0].text,
      /fails to reach temperature/,
      'the 5000-character description stays in the claim, not in a group chat'
    );
  } finally {
    tg.restore();
  }
});

test('PRICE REPORT — «❗ Report» stops being a topic nothing sends to', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p9','p9','Spool',25000,'active',20,'BASE','direct_sale','["direct_sale"]');
  `);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/price-reports', priceReportRoutes), { env: ENV });
    const res = await post(app, '/api/price-reports', {
      productId: 'p9',
      priceIqd: 19000,
      sellerName: 'Some shop on Karrada',
      note: 'my cousin runs it',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0].message_thread_id, THREADS.report);
    // The two prices are the whole signal and neither is personal data.
    assert.match(tg.sent[0].text, /19,000/);
    assert.match(tg.sent[0].text, /25,000/);
    // Unvalidated customer prose is not pasted into a staff group.
    assert.doesNotMatch(tg.sent[0].text, /Karrada|cousin/);
  } finally {
    tg.restore();
  }
});

// =========================================================================
// THE NOISE GUARD
// =========================================================================

/** A verified, un-revoked Telegram link — what `reachFor` reads as "reachable". */
function linkTelegram(raw: DatabaseSync, userId: string, chatId: number): void {
  raw
    .prepare(
      `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, chatId, chatId, '+9647700000001', '2026-09-01T00:00:00.000Z');
}

function seedTicket(raw: DatabaseSync, state: string): void {
  raw
    .prepare(
      `INSERT INTO support_tickets (id,user_id,subject,order_id,unit_id,priority,state,source,created_at,updated_at)
       VALUES ('tkt_1','buyer','Where is my order?',NULL,NULL,0,?,'manual',?,?)`
    )
    .run(state, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
}

test('NOISE — a second customer message on a ticket already waiting on staff says nothing new', async () => {
  /**
   * The rate limit here is thirty messages per customer per hour. Announcing
   * every one of them put four identical «Customer replied» lines into
   * «‼️ Support» for one person typing four lines, none of them telling staff
   * anything the first had not — and a topic that fills with noise is a topic
   * the owner mutes, which is the failure the topics were opened to end.
   */
  const raw = freshDb();
  seedCustomer(raw);
  seedTicket(raw, 'waiting_staff');
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets/tkt_1/messages', { body: 'Any update?' });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 0, 'the ticket was already on the staff side; nothing changed');
  } finally {
    tg.restore();
  }
});

test('NOISE — but the two transitions that DO move the ticket are still announced', async () => {
  for (const [state, expect] of [['open', 1], ['resolved', 1]] as const) {
    const raw = freshDb();
    seedCustomer(raw);
    seedTicket(raw, state);
    bindGroup(raw);
    const tg = stubTelegram();
    try {
      const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
      const res = await post(app, '/api/support/tickets/tkt_1/messages', { body: 'Still waiting.' });
      assert.equal(res.status, 200, await res.text());
      await drain();
      assert.equal(tg.sent.length, expect, `a reply on a '${state}' ticket is news`);
      // And the customer-typed subject is not repeated on every reply: it went
      // out with the opening message and this is a group chat.
      assert.doesNotMatch(tg.sent[0].text, /Where is my order\?/);
    } finally {
      tg.restore();
    }
  }
});

// =========================================================================
// THE PROMISE THE NUDGE MAKES
// =========================================================================

test('TICKET PROMISE — a staff reply actually reaches the customer, in-app and outbound', async () => {
  /**
   * WHAT THIS PINS. `notifyCustomer` — the only fan-out to Telegram, WhatsApp
   * and email — had exactly three callers, all of them about orders. A staff
   * reply on a support ticket reached the customer through NOTHING: no
   * outbound channel and not even a `user_notifications` row. Meanwhile the
   * site showed a sheet, right after the ticket was opened, offering to send
   * them support's answer on WhatsApp or Telegram. That offer was a promise no
   * code path could keep, and the closing reassurance «ستجد التحديثات داخل
   * التطبيق» was false for the same reason.
   */
  const raw = freshDb();
  seedCustomer(raw);
  seedTicket(raw, 'waiting_customer');
  const ADMIN = { id: 'boss', role: 'admin' as const, email: 'boss@x.co' };
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Ali','boss@x.co','h','admin');");
  // A customer who DID link Telegram — the outcome the nudge is asking for. If
  // the promise is real, this is the account it pays off for.
  linkTelegram(raw, 'buyer', 55501);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), ADMIN, (a) => a.route('/api/support', supportRoutes), {
      env: { ...ENV, TELEGRAM_BOT_TOKEN: '111:CUSTOMERTOKEN' },
    });
    const res = await post(app, '/api/support/admin/tickets/tkt_1/messages', {
      body: 'We have shipped a replacement nozzle today.',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    const n = row<{ user_id: string; kind: string; link: string; body_ar: string }>(
      raw,
      "SELECT user_id, kind, link, body_ar FROM user_notifications WHERE kind = 'support_reply'"
    );
    assert.ok(n, 'the in-app row exists — it is the floor the nudge rests on');
    assert.equal(n!.user_id, 'buyer', 'it goes to the person who opened the ticket, not the staff member');
    // The ticket itself, not the page: /support opens on the assistant, and
    // «افتح «تذاكري»» used to land the customer in the bot.
    assert.equal(n!.link, '/support?tab=tickets&ticket=tkt_1');
    assert.match(n!.body_ar, /tkt_1/);
    assert.doesNotMatch(
      n!.body_ar,
      /replacement nozzle/,
      'the answer stays on the site behind the customer’s own login'
    );
    // AND THE OUTBOUND HALF, which is the half the sheet is actually selling.
    // The customer above has a verified Telegram link and this deployment has a
    // customer-bot token, so the fan-out has somewhere to go; the assertion is
    // that a real `outbox` row was queued for it, keyed per staff message.
    const queued = count(
      raw,
      "SELECT COUNT(*) AS n FROM outbox WHERE event_key LIKE 'support.reply:%' AND state = 'pending'"
    );
    assert.ok(queued > 0, 'the reply was queued on a channel that can actually reach them');
  } finally {
    tg.restore();
  }
});

test('TICKET PROMISE — a second staff reply is a second message, not a swallowed duplicate', async () => {
  // The event key carries the MESSAGE id, not the ticket id: a ticket is a
  // conversation, and keying on the ticket would deliver the first answer and
  // silently drop every one after it.
  const raw = freshDb();
  seedCustomer(raw);
  seedTicket(raw, 'waiting_customer');
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Ali','boss@x.co','h','admin');");
  const ADMIN = { id: 'boss', role: 'admin' as const, email: 'boss@x.co' };
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), ADMIN, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    await post(app, '/api/support/admin/tickets/tkt_1/messages', { body: 'Looking into it.' });
    await drain();
    await post(app, '/api/support/admin/tickets/tkt_1/messages', { body: 'Shipped today.' });
    await drain();
    assert.equal(
      count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'support_reply'"),
      2,
      'two answers, two notifications'
    );
  } finally {
    tg.restore();
  }
});


test('REQUEST PROMISE — an offer on a community request reaches the customer', async () => {
  /**
   * WHAT THIS PINS. `'offer_received'` has been a declared `NotificationKind`
   * since 0045 and was NEVER WRITTEN by anything — a repo-wide grep found the
   * declaration and no sender. So the community flow told MERCHANTS that a
   * request matched them and told the CUSTOMER nothing when the answers came
   * back, while the site offered, on the screen right after publishing, to send
   * exactly those offers to their phone.
   *
   * The notifier is exercised directly against a real database rather than
   * through `POST /requests/:id/offers`, because reaching that route means
   * seeding a membership tier, selling privileges and a verified store — none
   * of which is what this test is about. That the ROUTE calls it is pinned by
   * the census below, which reads the real source.
   */
  const raw = freshDb();
  seedCustomer(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('seller','Omar','o@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('cm_1','seller','Omar Prints');
    INSERT INTO community_requests (id,customer_id,title,description) VALUES ('req_1','buyer','A gear for my mill','');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('off_1','req_1','cm_1',42000);
  `);
  const env = { DB: asD1(raw) } as unknown as Env;
  await notifyOfferReceived(env, 'off_1');

  const n = row<{ user_id: string; kind: string; link: string; entity_id: string; body_ar: string }>(
    raw,
    "SELECT user_id, kind, link, entity_id, body_ar FROM user_notifications WHERE kind = 'offer_received'"
  );
  assert.ok(n, 'the customer is told an offer arrived');
  assert.equal(n!.user_id, 'buyer', 'the person whose request it is — not the merchant who bid');
  assert.equal(n!.entity_id, 'off_1');
  // The link is the REQUEST, because the customer is being sent somewhere to
  // COMPARE, and one offer on its own is the screen that cannot do that.
  assert.equal(n!.link, '/requests?request=req_1');
  assert.match(n!.body_ar, /req_1/);
});

test('REQUEST PROMISE — a second merchant bidding is a second message, and a retry is not', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('seller','Omar','o@x.co','h','customer');
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('seller2','Zaid','z@x.co','h','customer');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('cm_1','seller','Omar Prints');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('cm_2','seller2','Zaid Prints');
    INSERT INTO community_requests (id,customer_id,title,description) VALUES ('req_1','buyer','A gear','');
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('off_1','req_1','cm_1',42000);
    INSERT INTO community_offers (id,request_id,merchant_id,price_iqd) VALUES ('off_2','req_1','cm_2',39000);
  `);
  const env = { DB: asD1(raw) } as unknown as Env;
  await notifyOfferReceived(env, 'off_1');
  await notifyOfferReceived(env, 'off_2');
  // The replay key is per OFFER, so the same offer announced twice is one row.
  await notifyOfferReceived(env, 'off_1');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'offer_received'"),
    2,
    'two merchants, two messages, and no duplicate for the retry'
  );
});

test('CENSUS — the two contexts the nudge promises actually have senders', () => {
  /**
   * The sheet in src/components/notify/ChannelNudge.tsx offers three reasons to
   * turn a channel on, one per context. Two of them named events that NO code
   * path produced. This is the census for that: the route that answers a ticket
   * and the route that creates an offer must each reach the customer notifier.
   * It fails the day either call site is deleted, which is the only way the
   * copy can silently become a lie again.
   */
  const support = readFileSync('worker/routes/support.ts', 'utf8');
  assert.match(support, /notifySupportReply\(c\.env, ticket\.id, msgId\)/, 'a staff reply tells the customer');
  const marketplace = readFileSync('worker/routes/marketplace.ts', 'utf8');
  assert.match(marketplace, /notifyOfferReceived\(c\.env, id\)/, 'a new offer tells the customer');
  // And the nudge still only claims the three it can keep.
  const nudge = readFileSync('src/components/notify/ChannelNudge.tsx', 'utf8');
  for (const context of ['order', 'request', 'ticket']) {
    assert.match(nudge, new RegExp(`\\b${context}: \\{`), `${context} copy is still present`);
  }
});
