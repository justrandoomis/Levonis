/**
 * The customer's bell in Sorani. The notifiers that write Sorani stamp it into
 * `meta.title_ckb` / `meta.body_ckb` (the columns hold Arabic and English
 * only); GET /api/notifications hands those two strings on — the same keys the
 * merchant feed reads — and nothing else from meta. A row without Sorani has
 * neither key, so the client falls back to the Arabic.
 *
 * Run: node --import tsx --test tests/notificationInboxSorani.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { notificationRoutes } from '../worker/routes/notifications';

test('the inbox carries the Sorani a notifier wrote, and only that from meta', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('other','Omar','o@x.co','h','customer');
    INSERT INTO user_notifications (id,user_id,kind,title_ar,title_en,body_ar,body_en,link,meta,created_at) VALUES
      ('n_ckb','buyer','gift_granted','وصلتك هدية','You got a gift','افتح الهدايا','Open your gifts','/gifts',
        '{"level":2,"title_ckb":"دیارییەکت پێگەیشت","body_ckb":"دیارییەکانت بکەرەوە"}','2026-10-06T10:00:03Z'),
      ('n_grouped','buyer','chat_message','رسالة جديدة','New message','','','/chats/c1',
        '{"count":3,"actors":["u1","u2"],"title_ckb":"نامەیەکی نوێ"}','2026-10-06T10:00:02Z'),
      ('n_plain','buyer','order_status','تم شحن طلبك','Your order shipped','','','/orders/ORD-1','{}','2026-10-06T10:00:01Z'),
      ('n_odd','buyer','order_status','قديم','Old','','','/orders','not json','2026-10-06T10:00:00Z'),
      ('n_null','buyer','order_status','أقدم','Older','','','/orders','null','2026-10-06T09:59:59Z'),
      ('n_theirs','other','gift_granted','وصلتك هدية','You got a gift','','','/gifts','{"title_ckb":"x"}','2026-10-06T10:00:04Z');`);
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/notifications', notificationRoutes));

  const res = await get(app, '/api/notifications');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const byId = Object.fromEntries(body.notifications.map((n: { id: string }) => [n.id, n]));
  assert.deepEqual(Object.keys(byId), ['n_ckb', 'n_grouped', 'n_plain', 'n_odd', 'n_null'], 'mine only, newest first');

  assert.equal(byId.n_ckb.title_ckb, 'دیارییەکت پێگەیشت');
  assert.equal(byId.n_ckb.body_ckb, 'دیارییەکانت بکەرەوە');
  assert.equal(byId.n_ckb.title_ar, 'وصلتك هدية', 'the Arabic and English stay as they were');
  assert.equal(byId.n_grouped.title_ckb, 'نامەیەکی نوێ');
  assert.equal('body_ckb' in byId.n_grouped, false, 'an empty Sorani body is absent, not ""');
  for (const id of ['n_plain', 'n_odd', 'n_null']) {
    assert.equal('title_ckb' in byId[id], false, `${id}: no Sorani, no key — the client shows the Arabic`);
    assert.equal('body_ckb' in byId[id], false);
  }
  for (const n of body.notifications) {
    for (const k of ['meta', 'count', 'actors', 'level']) assert.equal(k in n, false, `${n.id}: meta's ${k} stays on the server`);
  }
});
