/**
 * EVERY ADMIN NOTIFICATION LANDS IN ITS OWN TOPIC — and no notification can
 * cost a customer the thing they just did.
 *
 * THE BUG THIS PINS. Migration 0080 built the whole topic router — the group
 * binding, the `/topic_here` command, the fallback ladder — and then exactly
 * ONE feature used it. A grep for the topic argument across `worker/` found
 * two call sites, both in the wallet. Orders answered with the flat literal
 * `'orders'`, and support tickets, warranty tickets, product reviews and store
 * reviews told the shop's own staff nothing at all: they were events you
 * learned about by reloading an admin screen. The owner, reasonably, believed
 * a feature they had configured nine topics for was working.
 *
 * SO THESE TESTS DO NOT MOCK THE ROUTER. Each one runs the REAL route against
 * a real SQLite database built from the real migrations, with a real
 * `telegram_admin_config` row and real `telegram_admin_topics` bindings — one
 * per topic, each with a DIFFERENT `message_thread_id`. Only Telegram's HTTP
 * endpoint is stubbed. An assertion is therefore "this event arrived in the
 * thread the owner bound for it", which is the owner's actual question, rather
 * than "a function was called with a string".
 *
 * AND THE SECOND HALF, which matters more than the first: a notification is a
 * SIDE EFFECT of a write that has already committed. The last three tests
 * unplug Telegram, then unplug the database the router reads its bindings
 * from, and assert the customer still gets their 200. A shop that cannot
 * accept an order because a group chat is unreachable is worse off than a shop
 * with no group chat.
 *
 * Run: npx tsx --test tests/adminTopicRouting.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, pending } from './fixtures/app';
import {
  announceAfterResponse,
  announceToAdmins,
  orderTopic,
  ticketTopic,
} from '../worker/lib/adminTopicRouting';
import { supportRoutes } from '../worker/routes/support';
import { returnRoutes } from '../worker/routes/returns';
import { reviewRoutes } from '../worker/routes/reviews';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import type { Env } from '../worker/lib/types';

// =========================================================================
// THE GROUP, AS THE OWNER ACTUALLY BOUND IT
// =========================================================================

const GROUP = '-1001234567890';

/**
 * The nine topics of the owner's group, each with its own thread id. The
 * numbers are arbitrary and DELIBERATELY all different: a test whose topics
 * share a thread id would pass with every notification mis-filed.
 */
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

function bindGroup(raw: DatabaseSync, only?: readonly string[]): void {
  raw
    .prepare(
      `INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
       VALUES ('singleton', ?, 'Levonis', 'boss', 1)`
    )
    .run(GROUP);
  for (const [key, thread] of Object.entries(THREADS)) {
    if (only && !only.includes(key)) continue;
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

/**
 * Telegram's endpoint, and nothing else, replaced. `mode` decides what the
 * network does, because "the send failed" and "the network threw" are two
 * different failures and only one of them was ever handled.
 */
function stubTelegram(mode: 'ok' | 'refuse' | 'throw' = 'ok'): {
  sent: SentMessage[];
  restore: () => void;
} {
  const sent: SentMessage[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) return real(url as never, init as never);
    sent.push(JSON.parse(String(init?.body ?? '{}')) as SentMessage);
    if (mode === 'throw') throw new Error('network down');
    if (mode === 'refuse') {
      return new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: Number(GROUP) } } }),
      { status: 200 }
    );
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

/** Let every `waitUntil` promise the route registered settle before asserting. */
async function drain(): Promise<void> {
  while (pending.length) await Promise.all(pending.splice(0, pending.length));
  await new Promise((r) => setTimeout(r, 0));
}

const ENV = { TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN' };

// =========================================================================
// THE TWO DECISIONS, ON THEIR OWN
// =========================================================================

test('ORDER SPLIT — a direct sale and a pre-order are two different topics', () => {
  // The owner's group has «📝 Orders direct» and «📝 Orders pre-order» and no
  // plain «Orders». One key could only ever address one of them.
  assert.equal(orderTopic('direct'), 'orders_direct');
  assert.equal(orderTopic('preorder_air'), 'orders_preorder');
  assert.equal(orderTopic('preorder_sea'), 'orders_preorder');
  assert.equal(orderTopic('preorder_land'), 'orders_preorder');
});

test('ORDER SPLIT — an unreadable shipping type reads as DIRECT, never as a pre-order', () => {
  // `typeForTransport`'s own documented rule ("anything unknown reads as
  // direct"), for the same reason: filing a same-day sale into the queue
  // watched weekly is the mistake somebody notices.
  for (const bad of [null, undefined, '', 'preorder', 'PREORDER_AIR', 0, {}]) {
    assert.equal(orderTopic(bad), 'orders_direct', `${String(bad)} must not become a pre-order`);
  }
});

test('WARRANTY SPLIT — a ticket that names a device is a warranty ticket', () => {
  assert.equal(ticketTopic('oiu_123'), 'warranty');
  assert.equal(ticketTopic(null), 'support');
  assert.equal(ticketTopic(''), 'support');
  assert.equal(ticketTopic(undefined), 'support');
});

// =========================================================================
// PER EVENT KIND — THE TOPIC THE ROUTE ACTUALLY REQUESTS
// =========================================================================

function seedCustomer(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
  `);
}

const BUYER = { id: 'buyer', role: 'customer' as const, email: 's@x.co' };

test('SUPPORT TICKET — an ordinary ticket goes to the Support topic', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets', {
      confirm: true,
      subject: 'My printer will not home',
      body: 'It grinds on the X axis every time.',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1, 'the support desk is told exactly once');
    assert.equal(tg.sent[0].chat_id, GROUP);
    assert.equal(tg.sent[0].message_thread_id, THREADS.support);
  } finally {
    tg.restore();
  }
});

test('WARRANTY TICKET — a ticket opened against a device goes to the Warranty topic', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p1','p1','Printer',500000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,shipping_type)
      VALUES ('ORD-D','buyer','delivered','{}','standard','{}','cash',500000,0,1400,500000,0,'2026-09-18T00:00:00.000Z','direct');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_1','ORD-D','p1','Printer','',1,500000,500000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at)
      VALUES ('oiu_1','ORD-D','oi_1','p1','buyer',1,'2026-09-18T00:00:00.000Z');
  `);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets', {
      confirm: true,
      subject: 'Nozzle failed inside warranty',
      body: 'The hotend stopped heating after two months.',
      unit_id: 'oiu_1',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(
      tg.sent[0].message_thread_id,
      THREADS.warranty,
      '«تذاكر الضمان» has its own topic precisely so it is not read in the general support pile'
    );
  } finally {
    tg.restore();
  }
});

test('SUPPORT REPLY — a customer reply reopens the ticket and says so in the same topic', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  raw
    .prepare(
      `INSERT INTO support_tickets (id,user_id,subject,order_id,unit_id,priority,state,source,created_at,updated_at)
       VALUES ('tkt_1','buyer','Where is my order?',NULL,NULL,0,'resolved','manual',?,?)`
    )
    .run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets/tkt_1/messages', { body: 'It still has not arrived.' });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0].message_thread_id, THREADS.support);
    assert.match(tg.sent[0].text, /reopens a resolved ticket/, 'the reopen is the part staff must not miss');
    assert.doesNotMatch(tg.sent[0].text, /still has not arrived/, 'the reply body belongs in the ticket, not in a group chat');
  } finally {
    tg.restore();
  }
});

/** One delivered order per shipping type, so the return split has both sides. */
function seedDeliveredOrders(raw: DatabaseSync): void {
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p1','p1','Spool',25000,'active',20,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,shipping_type)
      VALUES ('ORD-D','buyer','delivered','{}','standard','{}','cash',25000,0,1400,25000,0,?,'direct'),
             ('ORD-P','buyer','delivered','{}','standard','{}','cash',25000,0,1400,25000,0,?,'preorder_air');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_d','ORD-D','p1','Spool','',1,25000,25000),
             ('oi_p','ORD-P','p1','Spool','',1,25000,25000);
  `.replace(/\?/g, `'${new Date().toISOString()}'`));
}

test('RETURN — a return against a DIRECT order lands in Orders direct', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  seedDeliveredOrders(raw);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/returns', returnRoutes), { env: ENV });
    const res = await post(app, '/api/returns', { orderItemId: 'oi_d', qty: 1, reason: 'defective' });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0].message_thread_id, THREADS.orders_direct);
  } finally {
    tg.restore();
  }
});

test('RETURN — a return against a PRE-ORDER lands in Orders pre-order, not beside today’s shipments', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  seedDeliveredOrders(raw);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/returns', returnRoutes), { env: ENV });
    const res = await post(app, '/api/returns', { orderItemId: 'oi_p', qty: 1, reason: 'defective' });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(
      tg.sent[0].message_thread_id,
      THREADS.orders_preorder,
      'the flat `orders` key sent every pre-order into the direct queue'
    );
  } finally {
    tg.restore();
  }
});

test('PRODUCT REVIEW — a published review reaches the Review topic', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  seedDeliveredOrders(raw);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/reviews', reviewRoutes), { env: ENV });
    const res = await post(app, '/api/reviews', {
      productId: 'p1',
      orderId: 'ORD-D',
      stars: 1,
      body: 'The spool arrived tangled and the colour is not the one on the page at all.',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1, 'a one-star review is live on the product page the moment it is written');
    assert.equal(tg.sent[0].message_thread_id, THREADS.review);
    assert.match(tg.sent[0].text, /1\/5/);
  } finally {
    tg.restore();
  }
});

test('STORE REVIEW — a merchant review reaches the same Review topic', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('seller','Ali','a@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('mer_1','seller','Ali Prints');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,merchant_id)
      VALUES ('ORD-M','buyer','delivered','{}','standard','{}','cash',25000,0,1400,25000,0,'2026-09-18T00:00:00.000Z','mer_1');
  `);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/community/reviews', communityReviewRoutes), { env: ENV });
    const res = await post(app, '/api/community/reviews', { rating: 2, body: 'Late and badly packed.', order_id: 'ORD-M' });
    assert.equal(res.status, 201, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1);
    assert.equal(tg.sent[0].message_thread_id, THREADS.review);
    assert.match(tg.sent[0].text, /mer_1/, 'the merchant id is what opens the record');
  } finally {
    tg.restore();
  }
});

// =========================================================================
// ONE EVENT, ONE MESSAGE
// =========================================================================

test('NO DOUBLE POST — an event that now has a topic does not also go to the flat admin chat', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  bindGroup(raw);
  const tg = stubTelegram();
  try {
    // `TELEGRAM_ADMIN_CHAT_ID` is the pre-0080 destination and it is still set
    // on the live deployment. The ladder must treat it as a FALLBACK, not as a
    // second recipient — two copies of every ticket is how a group gets muted.
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), {
      env: { ...ENV, TELEGRAM_ADMIN_CHAT_ID: '-100999', TELEGRAM_BOT_TOKEN: '111:CUSTOMER' },
    });
    const res = await post(app, '/api/support/tickets', { confirm: true, subject: 'Hello there', body: 'Just one message please.' });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1, 'exactly one message, to the topic');
    assert.equal(tg.sent[0].chat_id, GROUP, 'and not to the legacy chat as well');
  } finally {
    tg.restore();
  }
});

test('FALLBACK — a topic the owner has not bound yet lands in its sibling, never nowhere', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES ('p1','p1','Printer',500000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,shipping_type)
      VALUES ('ORD-D','buyer','delivered','{}','standard','{}','cash',500000,0,1400,500000,0,'2026-09-18T00:00:00.000Z','direct');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_1','ORD-D','p1','Printer','',1,500000,500000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at)
      VALUES ('oiu_1','ORD-D','oi_1','p1','buyer',1,'2026-09-18T00:00:00.000Z');
  `);
  // The owner has bound General and Support and has NOT got to «🔥 Warranty
  // support» yet. This is the state of the group between the deploy and the
  // afternoon somebody types `/topic_here warranty`, and it must not be a hole:
  // the warranty ticket lands in Support, which is where the owner is already
  // looking for it, rather than in a mixed General feed or nowhere at all.
  bindGroup(raw, ['general', 'support']);
  const tg = stubTelegram();
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets', {
      confirm: true,
      subject: 'Nozzle failed inside warranty',
      body: 'The hotend stopped heating after two months.',
      unit_id: 'oiu_1',
    });
    assert.equal(res.status, 200, await res.text());
    await drain();
    assert.equal(tg.sent.length, 1, 'an unbound topic is never a dropped notification');
    assert.equal(tg.sent[0].message_thread_id, THREADS.support);
  } finally {
    tg.restore();
  }
});

// =========================================================================
// NOTIFYING STAFF NEVER BREAKS THE CUSTOMER
// =========================================================================

test('CONTAINMENT — Telegram refusing the send does not fail the customer’s ticket', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  bindGroup(raw);
  const tg = stubTelegram('refuse');
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets', { confirm: true, subject: 'Still opens', body: 'Telegram is refusing us.' });
    assert.equal(res.status, 200);
    await drain();
    assert.equal(
      raw.prepare('SELECT COUNT(*) AS n FROM support_tickets').get()!.n,
      1,
      'the ticket exists whatever Telegram said'
    );
  } finally {
    tg.restore();
  }
});

test('CONTAINMENT — Telegram being unreachable does not fail the customer’s ticket', async () => {
  const raw = freshDb();
  seedCustomer(raw);
  bindGroup(raw);
  const tg = stubTelegram('throw');
  try {
    const app = stubApp(asD1(raw), BUYER, (a) => a.route('/api/support', supportRoutes), { env: ENV });
    const res = await post(app, '/api/support/tickets', { confirm: true, subject: 'Still opens', body: 'The network is down.' });
    assert.equal(res.status, 200);
    await drain();
  } finally {
    tg.restore();
  }
});

test('CONTAINMENT — a database failure while RESOLVING the topic is returned, never thrown', async () => {
  // The two reads that pick the destination (`readAdminGroup`, `readTopics`)
  // happen before Telegram is touched at all, and a D1 error there is a
  // REJECTED promise — not one of the misses `notifyAdminTopic` returns. Bare
  // `waitUntil(notifyAdminTopic(...))`, which is what every call site used to
  // be, turns that into an unhandled rejection on the customer's request.
  const env = {
    TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN',
    DB: { prepare() { throw new Error('D1_ERROR: no such table'); } },
  } as unknown as Env;
  const out = await announceToAdmins(env, 'support', 'anything');
  assert.equal(out.ok, false);
  assert.equal(out.ok === false ? out.reason : '', 'threw');
});

test('CONTAINMENT — announcing with no ExecutionContext is a no-op, not a crash', () => {
  // Hono THROWS on `c.executionCtx` when there is none. A route whose
  // notification crashes off the request path is a route whose notification
  // gets deleted by the next person who touches it.
  const env = {
    TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN',
    DB: { prepare() { throw new Error('D1_ERROR'); } },
  } as unknown as Env;
  assert.doesNotThrow(() => {
    announceAfterResponse(
      { env, get executionCtx(): never { throw new Error('no ExecutionContext'); } } as unknown as { env: Env },
      'general',
      'anything'
    );
  });
});
