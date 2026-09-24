/**
 * MIGRATIONS 0124 AND 0125 on a database that already has rows (W2-E): the
 * store threads that exist get their store, context and roles; the merchant's
 * old notices get their workspace kind and link; nothing else is touched; and
 * a Worker one migration behind still sends and opens chats.
 *
 * Run: node --import tsx --test tests/merchantW2EMigrations.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, dbThrough, row, asD1, post, json, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { chatRoutes } from '../worker/routes/chats';

const file = (n: string) => readFileSync(join(ROOT, 'migrations', n), 'utf8');

function legacy() {
  const raw = dbThrough('0123');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('owner','A','a@x','h'), ('buyer','B','b@x','h'), ('boss','C','c@x','h');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','A');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','A');
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('ORD-S','buyer','pending',1,'m1','s1','merchant','{}','d','{}','wallet',1,1500,0),
             ('ORD-L','buyer','pending',1,NULL,NULL,'levonis','{}','d','{}','cod',1,1500,0);
    INSERT INTO chats (id, order_id) VALUES ('chat_s','ORD-S'), ('chat_l','ORD-L'), ('chat_dm', NULL);
    INSERT INTO chat_participants (chat_id, user_id) VALUES ('chat_s','buyer'), ('chat_s','owner'),
      ('chat_l','buyer'), ('chat_l','boss'), ('chat_dm','buyer'), ('chat_dm','owner');
    INSERT INTO chat_messages (id, chat_id, sender_id, kind, body, created_at) VALUES
      ('m1','chat_s','buyer','text','hi','2026-09-01T10:00:00.000Z'), ('m2','chat_s','owner','text','yo','2026-09-01T11:00:00.000Z');
    INSERT INTO user_notifications (id, user_id, kind, title_ar, title_en, link, entity_type, entity_id, event_key) VALUES
      ('n1','owner','order_update','x','x','/merchant','order','ORD-S','store_order.new:ORD-S'),
      ('n2','owner','order_update','x','x','/merchant','order','ORD-S','store_order.cancelled:ORD-S'),
      ('n3','owner','chat_message','x','x','/chat/chat_s','chat','chat_s','chat_msg:m1'),
      ('n4','buyer','chat_message','x','x','/chat/chat_s','chat','chat_s','chat_msg:m2'),
      ('n5','buyer','order_update','x','x','/orders/ORD-L','order','ORD-L','order.placed:ORD-L');
  `);
  return raw;
}

test('0124 gives existing store threads their store, context, roles and last activity; leaves the rest alone', () => {
  const raw = legacy();
  raw.exec(file('0124_merchant_notifications_and_threads.sql'));
  assert.deepEqual(
    all(raw, 'SELECT id, context_type, context_id, store_id, merchant_id, last_message_at FROM chats ORDER BY id'),
    [
      { id: 'chat_dm', context_type: '', context_id: '', store_id: null, merchant_id: null, last_message_at: null },
      { id: 'chat_l', context_type: '', context_id: '', store_id: null, merchant_id: null, last_message_at: null },
      { id: 'chat_s', context_type: 'store_order', context_id: 'ORD-S', store_id: 's1', merchant_id: 'm1', last_message_at: '2026-09-01T11:00:00.000Z' },
    ]
  );
  assert.deepEqual(
    all(raw, "SELECT chat_id, user_id, role FROM chat_participants ORDER BY chat_id, user_id"),
    [
      { chat_id: 'chat_dm', user_id: 'buyer', role: '' },
      { chat_id: 'chat_dm', user_id: 'owner', role: '' },
      { chat_id: 'chat_l', user_id: 'boss', role: 'support' },
      { chat_id: 'chat_l', user_id: 'buyer', role: 'customer' },
      { chat_id: 'chat_s', user_id: 'buyer', role: 'customer' },
      { chat_id: 'chat_s', user_id: 'owner', role: 'merchant' },
    ]
  );
  assert.deepEqual(
    all(raw, 'SELECT id, kind, link FROM user_notifications ORDER BY id'),
    [
      { id: 'n1', kind: 'new_order', link: '/merchant/orders/ORD-S' },
      { id: 'n2', kind: 'order_needs_action', link: '/merchant/orders/ORD-S' },
      { id: 'n3', kind: 'new_message', link: '/merchant/inbox/chat_s' },
      { id: 'n4', kind: 'chat_message', link: '/chat/chat_s' },
      { id: 'n5', kind: 'order_update', link: '/orders/ORD-L' },
    ],
    'the customer\'s own notices are not the store\'s'
  );
  assert.equal(row<{ low_stock: number }>(raw, "SELECT 1 AS low_stock FROM pragma_table_info('merchant_notification_preferences') WHERE name = 'low_stock'")!.low_stock, 1);
  raw.exec(file('0125_storefront_analytics.sql'));
  assert.equal(all(raw, "SELECT name FROM sqlite_master WHERE name IN ('storefront_event_marks','storefront_salts','merchant_product_analytics_daily')").length, 3);
});

test('a Worker deployed ahead of 0124 still opens a store thread and sends in it (roles and activity are best-effort)', async () => {
  const raw = legacy();
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'b@x' }, (a) => a.route('/api/chats', chatRoutes));
  const opened = await json(await post(app, '/api/chats/open', { orderId: 'ORD-S' }));
  assert.equal(opened.chatId, 'chat_s');
  const res = await post(app, '/api/chats/chat_s/messages', { body: 'still works' });
  assert.equal(res.status, 200);
});
