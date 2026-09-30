/**
 * «WE HAVE YOUR ORDER» FOR A STORE ORDER (merchant platform V2, storefront A8).
 *
 * `notifyOrderPlaced` (worker/lib/orderNotify.ts) was called from the platform
 * checkout only; a community-store sale told the merchant and nobody else.
 * `POST /api/store-orders` now queues the customer's notice after the
 * response — through the same event key, `order.placed:<id>`, so:
 *
 *   - one placed order is ONE outbox row per reachable channel;
 *   - a replayed checkout (the same idempotency key) re-notifies nobody;
 *   - a second order is its own notice.
 *
 * The real cart and store-order routes run against every migration; the
 * buyer's e-mail is verified so the e-mail channel can reach them, and the
 * environment carries the channel keys (tests/customerNotify.test.ts).
 *
 * Run: node --import tsx --test tests/orderNotify.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, freshDb, json, pending, post, stubApp } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';

/** 100,000 cents at 1,400 IQD/USD — 1,400,000 IQD of spendable balance. */
const DEP = 100_000;
const FUTURE = '2099-01-01T00:00:00.000Z';
const ENV = {
  EMAIL_API_KEY: 're_k',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
  WASENDER_API_KEY: 'wa_k',
  TELEGRAM_BOT_TOKEN: '111:TOKEN',
};

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES
      ('buyer','Sara','buyer@example.com','h','customer','2026-01-01T00:00:00.000Z'),
      ('ali','Ali','ali@x.co','h','merchant',NULL);
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,options,colors) VALUES
      ('cp_ali','m_ali','s_ali','ali-spool','Ali spool','active','active',14000,100,0,'[]','[]');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+964770','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES
      ('dep_buyer','buyer','deposit','USD',${DEP},'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
}

const buyerApp = (db: D1Database) =>
  stubApp(
    db,
    { id: 'buyer', role: 'customer', email: 'buyer@example.com' },
    (a) => {
      a.route('/api/cart', cartRoutes);
      a.route('/api/store-orders', storeOrderRoutes);
    },
    { env: ENV }
  );
type App = ReturnType<typeof buyerApp>;

/** Quote, then place with the fingerprint that quote returned — what the checkout page does. */
async function place(app: App, key: string) {
  const q = await json(await post(app, '/api/store-orders/quote', {}));
  const res = await post(app, '/api/store-orders', { idempotencyKey: key, addressId: 'a1', quoteFingerprint: q.quote?.quote_fingerprint });
  return { res, body: await json(res) };
}

const placedRows = (raw: DatabaseSync, orderId: string) =>
  all<{ event_key: string; kind: string; recipient: string }>(
    raw,
    "SELECT event_key, kind, recipient FROM outbox WHERE event_key LIKE ? ORDER BY event_key",
    `order.placed:${orderId}:%`
  );

test('a store order queues the customer’s «placed» notice once — and a replayed checkout re-notifies nobody', async () => {
  const raw = freshDb();
  seed(raw);
  const app = buyerApp(asD1(raw));
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 2 })).status, 201);

  const first = await place(app, 'idem-order-notify-000001');
  assert.equal(first.res.status, 201, JSON.stringify(first.body));
  const orderId = String(first.body.order.id);
  await Promise.all(pending);

  const rows = placedRows(raw, orderId);
  assert.ok(rows.length >= 1, `the customer's notice is in the outbox: ${JSON.stringify(rows)}`);
  const email = rows.find((r) => r.event_key === `order.placed:${orderId}:email`);
  assert.ok(email, 'the verified e-mail is one of the channels');
  assert.equal(email!.recipient, 'buyer@example.com');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE event_key = ?", `order.placed:${orderId}:email`), 1);

  // THE REPLAY: the same idempotency key answers the same order and queues nothing new.
  const again = await place(app, 'idem-order-notify-000001');
  assert.ok(again.res.status === 200 || again.res.status === 201, JSON.stringify(again.body));
  assert.equal(String(again.body.order.id), orderId, 'the same order');
  await Promise.all(pending);
  assert.deepEqual(placedRows(raw, orderId), rows, 'not a row more');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), 1);

  // A second order is its own notice.
  assert.equal((await post(app, '/api/cart/merchant-items', { productId: 'cp_ali', qty: 1 })).status, 201);
  const second = await place(app, 'idem-order-notify-000002');
  assert.equal(second.res.status, 201, JSON.stringify(second.body));
  const secondId = String(second.body.order.id);
  assert.notEqual(secondId, orderId);
  await Promise.all(pending);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE event_key = ?", `order.placed:${secondId}:email`), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE event_key LIKE 'order.placed:%:email'"), 2);
});
