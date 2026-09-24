/**
 * MERCHANT NOTIFICATIONS (W2-E, docs/MERCHANT_PLATFORM.md §4.8): each kind is
 * written by the real event, deep-links to its object's workspace address,
 * reads the merchant's switch for the OUTSIDE channels (in-app always), and
 * cannot be sent twice. Plus the store's notification centre API: its own
 * notices only, paged, counted and marked read — never another account's.
 *
 * Run: node --import tsx --test tests/merchantNotifications.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, get, json, post, row } from './fixtures/app';
import { ADMIN, BUYER, OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { chatRoutes } from '../worker/routes/chats';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import { supportRoutes } from '../worker/routes/support';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { merchantNotificationRoutes } from '../worker/routes/merchantNotifications';
import { merchantRoutes } from '../worker/routes/merchant';
import { notifyMerchantOfStoreOrder } from '../worker/lib/storeOrderOps';
import {
  KIND_PREF,
  MERCHANT_KINDS,
  WIRED_PREFS,
  lowStockCrossed,
  notifyLowStock,
  notifyPayoutAvailable,
  notifyPayoutPaid,
  preferenceShape,
} from '../worker/lib/merchantNotify';
import { runMerchantSweeps } from '../worker/lib/merchantSweeps';
import { notify } from '../worker/lib/notifications';
import type { Env } from '../worker/lib/types';

/** Telegram is configured and the owner has linked it: outside messages can be queued. */
const TG = { TELEGRAM_BOT_TOKEN: 'test-token', APP_ORIGIN: 'https://levonis-iq.com' };

function world() {
  const raw = seedW2E();
  raw.exec(`INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
            VALUES ('owner', 111, 111, '+9647700000001', '2026-01-01T00:00:00.000Z')`);
  return raw;
}
const envOf = (raw: DatabaseSync, extra: Record<string, unknown> = {}) =>
  ({ DB: asD1(raw), ...TG, ...extra }) as unknown as Env;

const notes = (raw: DatabaseSync, user = 'owner') =>
  all<{ kind: string; link: string; entity_type: string; entity_id: string; event_key: string }>(
    raw,
    'SELECT kind, link, entity_type, entity_id, event_key FROM user_notifications WHERE user_id = ? ORDER BY rowid',
    user
  );
const outboundFor = (raw: DatabaseSync, key: string) =>
  count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE event_key LIKE ?", `merchant:${key}:%`);

// --------------------------------------------------------------- the model

test('every merchant kind has a switch; the settings answer lists the new ones as wired', async () => {
  for (const k of MERCHANT_KINDS) assert.ok(KIND_PREF[k], `${k} has no switch`);
  for (const k of ['new_orders', 'request_opportunities', 'new_messages', 'new_reviews', 'low_stock', 'payouts', 'complaints', 'system_alerts', 'marketing']) {
    assert.ok(WIRED_PREFS.includes(k as never), `${k} should be wired`);
  }
  assert.ok(!WIRED_PREFS.includes('new_followers'), 'no sender reads new_followers: it must say «قريبًا»');
  // A column a database has not been migrated to yet reads ON, never off.
  assert.equal(preferenceShape({ new_orders: 0 }).low_stock, true);
  assert.equal(preferenceShape({ new_orders: 0 }).new_orders, false);
  assert.equal(preferenceShape({ complaints: 0 }).complaints, true, 'forced');

  const raw = world();
  const app = appOf(raw, OWNER, (a) => a.route('/api/merchant', merchantRoutes));
  const got = await json(await get(app, '/api/merchant/notifications'));
  assert.ok(got.wired.includes('low_stock') && got.wired.includes('payouts'));
  const patched = await json(await (await import('./fixtures/app')).patch(app, '/api/merchant/notifications', { low_stock: false, payouts: false }));
  assert.equal(patched.preferences.low_stock, false);
  assert.equal(patched.preferences.payouts, false);
});

// ------------------------------------------------------------- new order

test('new_order: in-app always, deep link to the order; Telegram queued while the switch is on, not when off; replay-proof', async () => {
  const raw = world();
  const env = envOf(raw);
  await notifyMerchantOfStoreOrder(env, { merchantId: 'm1', orderId: 'ORD-AAA111', event: 'new', totalIqd: 12500 });
  await notifyMerchantOfStoreOrder(env, { merchantId: 'm1', orderId: 'ORD-AAA111', event: 'new', totalIqd: 12500 });
  assert.deepEqual(notes(raw), [
    { kind: 'new_order', link: '/merchant/orders/ORD-AAA111', entity_type: 'order', entity_id: 'ORD-AAA111', event_key: 'store_order.new:ORD-AAA111' },
  ]);
  assert.equal(outboundFor(raw, 'store_order.new:ORD-AAA111'), 1, 'one Telegram row, even for a replay');
  const tg = row<{ payload: string }>(raw, "SELECT payload FROM outbox WHERE event_key LIKE 'merchant:store_order.new:ORD-AAA111:%'")!;
  assert.match(tg.payload, /https:\/\/levonis-iq\.com\/merchant\/orders\/ORD-AAA111/, 'the button opens the order');

  raw.exec(`INSERT INTO merchant_notification_preferences (merchant_id, new_orders) VALUES ('m1', 0)`);
  await notifyMerchantOfStoreOrder(env, { merchantId: 'm1', orderId: 'ORD-BBB222', event: 'new', totalIqd: 1 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = 'store_order.new:ORD-BBB222'"), 1, 'in-app always');
  assert.equal(outboundFor(raw, 'store_order.new:ORD-BBB222'), 0, 'switched off: nothing goes out');

  // A cancellation is `order_needs_action`, to the same order.
  await notifyMerchantOfStoreOrder(env, { merchantId: 'm1', orderId: 'ORD-BBB222', event: 'cancelled_by_customer' });
  const cancelled = notes(raw).find((n) => n.event_key === 'store_order.cancelled:ORD-BBB222')!;
  assert.equal(cancelled.kind, 'order_needs_action');
  assert.equal(cancelled.link, '/merchant/orders/ORD-BBB222');
});

test('a channel the owner switched off is never used, whatever the merchant switch says', async () => {
  const raw = world();
  raw.exec(`INSERT INTO user_notification_channels (user_id, channel, enabled) VALUES ('owner', 'telegram', 0)`);
  await notifyMerchantOfStoreOrder(envOf(raw), { merchantId: 'm1', orderId: 'ORD-CCC333', event: 'new', totalIqd: 1 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = 'store_order.new:ORD-CCC333'"), 1);
  assert.equal(outboundFor(raw, 'store_order.new:ORD-CCC333'), 0);
});

// ------------------------------------------------------------- messages

test('new_message: a customer writing to the STORE reaches its owner as the store\'s notice, opening the thread in the inbox', async () => {
  const raw = world();
  const buyer = appOf(raw, BUYER, (a) => a.route('/api/chats', chatRoutes), TG);
  const opened = await json(await post(buyer, '/api/chats/open', { merchantId: 'm1' }));
  assert.equal(opened.context, 'store');
  const again = await json(await post(buyer, '/api/chats/open', { merchantId: 'm1' }));
  assert.equal(again.chatId, opened.chatId, 'one thread per store and customer');
  assert.equal((await post(buyer, `/api/chats/${opened.chatId}/messages`, { body: 'Do you print in PETG?' })).status, 200);
  assert.deepEqual(notes(raw), [
    { kind: 'new_message', link: `/merchant/inbox/${opened.chatId}`, entity_type: 'chat', entity_id: opened.chatId, event_key: notes(raw)[0].event_key },
  ]);
  // The customer's words never ride on an outside channel.
  const payload = row<{ payload: string }>(raw, "SELECT payload FROM outbox WHERE event_key LIKE 'merchant:chat_msg:%'")!.payload;
  assert.doesNotMatch(payload, /PETG/);
  // The owner answering tells the customer, as the CUSTOMER's own notice.
  const owner = appOf(raw, OWNER, (a) => a.route('/api/chats', chatRoutes), TG);
  await post(owner, `/api/chats/${opened.chatId}/messages`, { body: 'Yes' });
  assert.deepEqual(notes(raw, 'buyer').map((n) => [n.kind, n.link]), [['chat_message', `/chat/${opened.chatId}`]]);
});

// --------------------------------------------------------------- reviews

test('new_review: the review a customer leaves reaches the store, linked to its reviews', async () => {
  const raw = world();
  addOrder(raw, { id: 'ORD-REV001', status: 'delivered' });
  const res = await post(appOf(raw, BUYER, (a) => a.route('/api/community-reviews', communityReviewRoutes), TG), '/api/community-reviews', {
    order_id: 'ORD-REV001', rating: 4, body: 'Lovely vase, well packed.',
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const n = notes(raw).find((x) => x.kind === 'new_review')!;
  assert.equal(n.link, '/merchant/reviews');
  assert.equal(n.entity_type, 'review');
});

// ---------------------------------------------------------------- disputes

test('dispute_opened: a support ticket on a STORE order tells its merchant the money waits — forced on, even with every switch off', async () => {
  const raw = world();
  raw.exec(`INSERT INTO merchant_notification_preferences (merchant_id, complaints, new_orders) VALUES ('m1', 0, 0)`);
  addOrder(raw, { id: 'ORD-TKT001', status: 'delivered' });
  const support = appOf(raw, BUYER, (a) => a.route('/api/support', supportRoutes), TG);
  const res = await post(support, '/api/support/tickets', { confirm: true, subject: 'Broken item', body: 'The vase arrived broken.', order_id: 'ORD-TKT001' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const n = notes(raw).find((x) => x.kind === 'dispute_opened')!;
  assert.equal(n.link, '/merchant/orders/ORD-TKT001');
  assert.equal(outboundFor(raw, n.event_key), 1, 'forced: the outside channel is used');
  const out = row<{ payload: string }>(raw, 'SELECT payload FROM outbox WHERE event_key LIKE ?', `merchant:${n.event_key}:%`)!;
  assert.doesNotMatch(out.payload, /arrived broken/, 'the ticket text stays between the customer and support');
  // A ticket on the shop's own order tells no merchant.
  raw.exec(`INSERT INTO orders (id,user_id,status,total_iqd,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
            VALUES ('ORD-LEV001','buyer','delivered',1,'{}','d','{}','cod',1,1500,0)`);
  await post(support, '/api/support/tickets', { confirm: true, subject: 'Question', body: 'About my order please.', order_id: 'ORD-LEV001' });
  assert.equal(notes(raw).filter((x) => x.kind === 'dispute_opened').length, 1);
});

test('dispute_opened: a customer disputing a custom order tells its merchant, linked to the job', async () => {
  const raw = world();
  raw.exec(`
    INSERT INTO community_requests (id, customer_id, title, state, status) VALUES ('req1','buyer','A bracket','in_progress','closed');
    INSERT INTO community_offers (id, request_id, merchant_id, store_id, price_iqd, state) VALUES ('off1','req1','m1','s1',30000,'accepted');
    INSERT INTO community_orders (id, request_id, offer_id, customer_id, merchant_id, store_id, state, price_iqd, platform_fee_iqd, merchant_receivable_iqd)
      VALUES ('cord1','req1','off1','buyer','m1','s1','in_progress',30000,1500,28500);
  `);
  const res = await post(appOf(raw, BUYER, (a) => a.route('/api/marketplace', marketplaceRoutes), TG), '/api/marketplace/orders/cord1/dispute', {
    description: 'The part does not fit the mount at all.',
  });
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const n = notes(raw).find((x) => x.kind === 'dispute_opened')!;
  assert.equal(n.link, '/merchant/requests/orders/cord1');
  assert.equal(n.entity_type, 'custom_order');
});

// ------------------------------------------------------------------ money

test('payout_available: one notice per credit, whichever door released it (confirm route, sweep, ledger hook)', async () => {
  const raw = world();
  const env = envOf(raw);
  await notifyPayoutAvailable(env, { merchantId: 'm1', amountIqd: 9500, sourceKey: 'store_order:ORD-PAY001', orderId: 'ORD-PAY001' });
  // The three-day sweep released credits: its audit rows say WHICH orders, the
  // ledger (W2-B) says how much is now available for each.
  raw.exec(`INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key) VALUES
    ('le1','m1','s1','ORD-PAY001','sale_gross','available',9500,'t:le1'),
    ('le2','m1','s1','ORD-PAY002','sale_gross','available',4750,'t:le2')`);
  raw.exec(`INSERT INTO audit_log (actor_id, action, target, detail) VALUES
    (NULL, 'store_order.credit_released', 'ORD-PAY001', '{"merchant_id":"m1","amount_iqd":9500}'),
    (NULL, 'store_order.credit_released', 'ORD-PAY002', '{"merchant_id":"m1","amount_iqd":4750}')`);
  const r = await runMerchantSweeps(env, new Date().toISOString());
  assert.equal(r.payouts_available, 1, 'only the credit not already announced');
  const money = notes(raw).filter((n) => n.kind === 'payout_available');
  assert.deepEqual(money.map((n) => [n.entity_id, n.link]), [['ORD-PAY001', '/merchant/money'], ['ORD-PAY002', '/merchant/money']]);
  assert.equal((await runMerchantSweeps(env, new Date().toISOString())).payouts_available, 0, 'a second tick finds nothing new');
  assert.match(
    row<{ title_en: string }>(raw, "SELECT title_en FROM user_notifications WHERE entity_id = 'ORD-PAY002' AND kind = 'payout_available'")!.title_en,
    /4,750 IQD/,
    'the amount is the ledger\'s'
  );

  // The `payouts` switch off: in-app still, nothing outside.
  raw.exec(`INSERT INTO merchant_notification_preferences (merchant_id, payouts) VALUES ('m1', 0)`);
  await notifyPayoutPaid(env, { merchantId: 'm1', payoutId: 'mpo_1', amountIqd: 14250, reference: 'ZC-99' });
  const paid = notes(raw).find((n) => n.kind === 'payout_paid')!;
  assert.equal(paid.link, '/merchant/money');
  assert.equal(outboundFor(raw, paid.event_key), 0);
});

test('payout_available: a custom order\'s escrow released by the sweep or an admin is announced once, from the escrow event', async () => {
  const raw = world();
  raw.exec(`
    INSERT INTO community_requests (id, customer_id, title) VALUES ('req2','buyer','Gears');
    INSERT INTO community_offers (id, request_id, merchant_id, store_id, price_iqd, state) VALUES ('off2','req2','m1','s1',20000,'accepted');
    INSERT INTO community_orders (id, request_id, offer_id, customer_id, merchant_id, store_id, state, price_iqd, platform_fee_iqd, merchant_receivable_iqd)
      VALUES ('cord2','req2','off2','buyer','m1','s1','completed',20000,1000,19000);
    INSERT INTO community_escrows (id, community_order_id, customer_id, merchant_id, gross_iqd, platform_fee_iqd, merchant_receivable_iqd, state)
      VALUES ('esc2','cord2','buyer','m1',20000,1000,19000,'released');
    INSERT INTO community_escrow_events (id, escrow_id, kind, amount_iqd) VALUES ('ev2','esc2','release',19000);
  `);
  await runMerchantSweeps(envOf(raw), new Date().toISOString());
  await runMerchantSweeps(envOf(raw), new Date().toISOString());
  const n = notes(raw).filter((x) => x.kind === 'payout_available');
  assert.equal(n.length, 1);
  assert.equal(n[0].event_key, 'payout_available:community_order:cord2', 'the same key the customer\'s confirm route uses');
});

test('payout_paid: the admin recording a paid transfer tells the merchant once, from the ledger\'s payout row', async () => {
  const raw = world();
  raw.exec(`INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key)
            VALUES ('le9','m1','s1','ORD-PAID9','sale_gross','available',20000,'t:le9')`);
  const admin = appOf(raw, ADMIN, (a) => a.route('/api/admin/community', adminCommunityRoutes), TG);
  const body = { amount_iqd: 15000, note: 'ZainCash 7788', idempotencyKey: 'payout-key-0001' };
  const res = await post(admin, '/api/admin/community/merchants/m1/payout', body);
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  await post(admin, '/api/admin/community/merchants/m1/payout', body); // a replay
  const paid = notes(raw).filter((n) => n.kind === 'payout_paid');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].link, '/merchant/money');
  assert.match(row<{ body_ar: string }>(raw, "SELECT body_ar FROM user_notifications WHERE kind = 'payout_paid'")!.body_ar, /ZainCash 7788/);
});

// --------------------------------------------------------------- the rest

test('low_stock: the catalogue\'s hook sends only when THIS write crossed the product\'s threshold', async () => {
  assert.equal(lowStockCrossed(6, 5, 5), true);
  assert.equal(lowStockCrossed(5, 4, 5), false, 'already under: not a crossing');
  assert.equal(lowStockCrossed(9, 7, 5), false);
  assert.equal(lowStockCrossed(3, 0, -1), false);
  const raw = world();
  const env = envOf(raw);
  const r1 = await notifyLowStock(env, { merchantId: 'm1', productId: 'cp1', productName: 'Vase', before: 6, after: 2, threshold: 3, cause: 'ORD-1' });
  const r2 = await notifyLowStock(env, { merchantId: 'm1', productId: 'cp1', productName: 'Vase', before: 2, after: 1, threshold: 3, cause: 'ORD-2' });
  assert.equal(r1.written, true);
  assert.equal(r2.written, false);
  assert.deepEqual(notes(raw).map((n) => [n.kind, n.link]), [['low_stock', '/merchant/products/cp1']]);
});

test('coupon_ending and a store order left unconfirmed: the daily sweep, once each, from 09:00 Baghdad', async () => {
  const raw = world();
  const now = Date.parse('2026-09-20T07:00:00.000Z'); // 10:00 in Baghdad
  const iso = (ms: number) => new Date(ms).toISOString();
  raw.exec(`
    INSERT INTO merchant_coupons (id, store_id, merchant_id, code, kind, value, active, ends_at, used_count, max_uses) VALUES
      ('cpn_soon','s1','m1','SUMMER','percent',10,1,'${iso(now + 2 * 86_400_000)}',3,NULL),
      ('cpn_far','s1','m1','LATER','percent',10,1,'${iso(now + 9 * 86_400_000)}',0,NULL),
      ('cpn_done','s1','m1','USEDUP','percent',10,1,'${iso(now + 86_400_000)}',5,5),
      ('cpn_off','s1','m1','PAUSED','percent',10,0,'${iso(now + 86_400_000)}',0,NULL);
  `);
  addOrder(raw, { id: 'ORD-PEND01', status: 'pending', at: iso(now - 30 * 3_600_000) });
  addOrder(raw, { id: 'ORD-PEND02', status: 'pending', at: iso(now - 2 * 3_600_000) });
  const early = await runMerchantSweeps(envOf(raw), iso(now - 5 * 3_600_000)); // 05:00 Baghdad
  assert.equal(early.daily_ran, false, 'nobody is buzzed before nine');
  const r = await runMerchantSweeps(envOf(raw), iso(now));
  assert.equal(r.daily_ran, true);
  assert.equal(r.coupons_ending, 1);
  assert.equal(r.pending_orders, 1);
  assert.deepEqual(
    notes(raw).map((n) => [n.kind, n.link]),
    [['coupon_ending', '/merchant/marketing/coupons/cpn_soon'], ['order_needs_action', '/merchant/orders/ORD-PEND01']]
  );
  const again = await runMerchantSweeps(envOf(raw), iso(now + 3_600_000));
  assert.equal(again.daily_ran, false, 'once a day');
  await runMerchantSweeps(envOf(raw), iso(now), { forceDaily: true });
  assert.equal(notes(raw).length, 2, 'and replay-proof even when forced');
});

test('store_status_changed: an admin sanction on the store or the merchant reaches the owner, forced on', async () => {
  const raw = world();
  const admin = appOf(raw, ADMIN, (a) => a.route('/api/admin/community', adminCommunityRoutes), TG);
  const res = await post(admin, '/api/admin/community/stores/s1/status', { status: 'suspended', reason: 'Copied banner' });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const n = notes(raw).find((x) => x.kind === 'store_status_changed')!;
  assert.equal(n.link, '/merchant/store/settings');
  const body = row<{ body_ar: string }>(raw, "SELECT body_ar FROM user_notifications WHERE kind = 'store_status_changed'")!.body_ar;
  assert.match(body, /Copied banner/, 'the reason is owed to the merchant, in-app');
  const out = row<{ payload: string }>(raw, "SELECT payload FROM outbox WHERE event_key LIKE 'merchant:store_status:%'")!;
  assert.doesNotMatch(out.payload, /Copied banner/, 'and kept off the outside channels');
  await post(admin, '/api/admin/community/merchants/m2/status', { status: 'restricted', reason: '' });
  assert.equal(notes(raw, 'owner2').filter((x) => x.kind === 'store_status_changed').length, 1);
  await post(admin, '/api/admin/community/merchants/m2/status', { status: 'restricted', reason: '' });
  assert.equal(notes(raw, 'owner2').filter((x) => x.kind === 'store_status_changed').length, 1, 'no change, no notice');
});

// ----------------------------------------------------- the centre's API

async function seedFeed(raw: DatabaseSync) {
  const db = asD1(raw);
  const at = (i: number) => `2026-09-2${Math.floor(i / 10)}T10:00:0${i % 10}.000Z`;
  for (let i = 0; i < 7; i++) {
    await notify(db, { userId: 'owner', kind: 'new_order', title_ar: `ط${i}`, title_en: `o${i}`, link: `/merchant/orders/O${i}`, entity_type: 'order', entity_id: `O${i}`, eventKey: `t:${i}` });
    raw.prepare('UPDATE user_notifications SET created_at = ? WHERE event_key = ?').run(i < 4 ? '2026-09-21T10:00:00.000Z' : at(i), `t:${i}`);
  }
  // The owner's PERSONAL notices, and another merchant's.
  await notify(db, { userId: 'owner', kind: 'order_update', title_ar: 'طلبك', title_en: 'your order', link: '/orders/X', eventKey: 'p:1' });
  await notify(db, { userId: 'owner2', kind: 'new_order', title_ar: 'x', title_en: 'x', link: '/merchant/orders/Z', eventKey: 'z:1' });
}

test('the centre lists the STORE\'s notices only, pages by cursor without skipping ties, and counts unread', async () => {
  const raw = world();
  await seedFeed(raw);
  const app = appOf(raw, OWNER, (a) => a.route('/api/merchant/notifications', merchantNotificationRoutes));
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON page
    const page: Record<string, any> = await json(await get(app, `/api/merchant/notifications/feed?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    assert.equal(page.unread, 7);
    seen.push(...page.notifications.map((n: { entity_id: string }) => n.entity_id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 7, 'four notices share one timestamp and every one is served');
  assert.equal(new Set(seen).size, 7);
  assert.ok(!seen.includes('X') && !seen.includes('Z'), 'no personal notice, nobody else\'s');
});

test('mark read: one, then all — the store\'s only; another account\'s id marks nothing; a customer is refused', async () => {
  const raw = world();
  await seedFeed(raw);
  const app = appOf(raw, OWNER, (a) => a.route('/api/merchant/notifications', merchantNotificationRoutes));
  const theirs = row<{ id: string }>(raw, "SELECT id FROM user_notifications WHERE user_id = 'owner2'")!.id;
  assert.equal((await json(await post(app, '/api/merchant/notifications/read', { id: theirs }))).marked, 0);
  const first = row<{ id: string }>(raw, "SELECT id FROM user_notifications WHERE user_id = 'owner' AND kind = 'new_order' LIMIT 1")!.id;
  const one = await json(await post(app, '/api/merchant/notifications/read', { id: first }));
  assert.deepEqual([one.marked, one.unread], [1, 6]);
  const allRead = await json(await post(app, '/api/merchant/notifications/read', {}));
  assert.deepEqual([allRead.marked, allRead.unread], [6, 0]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner' AND kind = 'order_update' AND read_at IS NULL"), 1, 'the personal notice is untouched');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'owner2' AND read_at IS NULL"), 1);
  const unreadFeed = await json(await get(app, '/api/merchant/notifications/feed?unread=1'));
  assert.deepEqual(unreadFeed.notifications, []);
  const customer = appOf(raw, BUYER, (a) => a.route('/api/merchant/notifications', merchantNotificationRoutes));
  assert.equal((await get(customer, '/api/merchant/notifications/feed')).status, 404, 'no store, no store notices');
  const owner2 = appOf(raw, OWNER2, (a) => a.route('/api/merchant/notifications', merchantNotificationRoutes));
  assert.deepEqual((await json(await get(owner2, '/api/merchant/notifications/unread-count'))).unread, 1);
});
