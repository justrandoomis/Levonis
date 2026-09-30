/**
 * A PRODUCT MADE FOR ONE CUSTOMER — stage 5 of docs/COMMUNITY_COMMERCE_CHAT.md
 * (0152, worker/lib/privateProducts.ts, the custom-products doors in
 * worker/routes/chatCommerce.ts), bought through the store's OWN cart and
 * checkout — no chat checkout, no temporary public product.
 *
 * Pinned, mostly as attacks:
 *   · invisible to every public door — the storefront list, its product page,
 *     the community feed, the product picker, the merchant's own catalogue;
 *   · buyable by its customer alone — another customer, another store and the
 *     store itself get "not found";
 *   · what the customer was shown is what they pay: immutable in the routes
 *     AND in the database; the checkout re-prices it as any product;
 *   · one unit — bought once; expired or cancelled — not buyable;
 *   · a quote turned into a product is closed in the same batch — never both;
 *   · the order records the conversation and «تم إنشاء الطلب» lands there;
 *   · moderation's «unhide» cannot make it public.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, dbThrough, asD1, stubApp, post, patch, get, json, count, row, type StubUser, type Mount } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { storefrontRoutes } from '../worker/routes/storefront';
import { communityRoutes } from '../worker/routes/community';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { resetPrivateProductsMemo } from '../worker/lib/privateProducts';
import { resetProductFilesMemo } from '../worker/lib/fileOwnership';

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const ZAIN: StubUser = { id: 'zain', role: 'merchant', email: 'zain@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

const mount: Mount = (a) => {
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/store-orders', storeOrderRoutes);
  a.route('/api/storefront', storefrontRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/admin/community', adminCommunityRoutes);
};

function seed(raw: DatabaseSync = freshDb()) {
  resetPrivateProductsMemo();
  resetProductFilesMemo();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara'), ('ali','Ali','ali@x.co','h','merchant','ali'),
      ('zain','Zain','zain@x.co','h','merchant','zain'), ('eve','Eve','eve@x.co','h','customer','eve'),
      ('boss','Boss','boss@x.co','h','admin','boss');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_zain','zain','Zain Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active'), ('s_zain','m_zain','zain','zainprint','Zain Print','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,created_at) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','active','active',25000,5,1,'2026-09-01T00:00:00.000Z');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_zain','zain','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES
      ('a1','buyer','Sara','+964770','Street 1','basra'), ('a_eve','eve','Eve','+964772','Street 3','basra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}
const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);
const as = (raw: DatabaseSync, user: StubUser) => stubApp(asD1(raw), user, mount);

async function storeThread(raw: DatabaseSync, who: StubUser = BUYER, merchantId = 'm_ali'): Promise<string> {
  return (await json(await post(as(raw, who), '/api/chats/open', { merchantId }))).chatId;
}
const messages = async (raw: DatabaseSync, user: StubUser, chatId: string) =>
  (await json(await get(as(raw, user), `/api/chats/${chatId}/messages`))).messages as Array<Record<string, any>>;
const card = async (raw: DatabaseSync, user: StubUser, chatId: string, type: string) =>
  (await messages(raw, user, chatId)).filter((m) => m.card?.type === type).pop()!;

async function makePrivate(raw: DatabaseSync, chatId: string, body: Record<string, unknown> = {}) {
  const res = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, {
    name: 'Engraved lamp', description: 'With your name on the base', price_iqd: 60000, prep_days: 4, valid_days: 7, ...body,
  });
  return res;
}
/** Quote, then place with the fingerprint that quote returned — what the checkout page does. */
async function checkout(raw: DatabaseSync, who: StubUser, key: string) {
  const q = await json(await post(as(raw, who), '/api/store-orders/quote', { addressId: who.id === 'eve' ? 'a_eve' : 'a1' }));
  const res = await post(as(raw, who), '/api/store-orders', {
    idempotencyKey: key,
    addressId: who.id === 'eve' ? 'a_eve' : 'a1',
    quoteFingerprint: q.quote?.quote_fingerprint,
  });
  return { res, body: await json(res), quote: q };
}

// ================================================================ making it

test('the store makes a private product in the thread: one unit, published, and hidden from the public by the database', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const res = await makePrivate(raw, chatId);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const { product, message } = await json(res);
  assert.equal(message.kind, 'custom_product_card');
  assert.deepEqual(
    { name: message.card.original.name, price: message.card.original.price_iqd, prep: message.card.original.prep_days },
    { name: 'Engraved lamp', price: 60000, prep: 4 }
  );
  const p = row<Record<string, unknown>>(raw,
    'SELECT audience_user_id, origin_chat_id, publish_state, lifecycle, status, stock, track_stock FROM community_products WHERE id = ?', product.id)!;
  assert.deepEqual(p, { audience_user_id: 'buyer', origin_chat_id: chatId, publish_state: 'published', lifecycle: 'active', status: 'hidden', stock: 1, track_stock: 1 });

  const forBuyer = await card(raw, BUYER, chatId, 'custom_product');
  assert.equal(forBuyer.card.current.status, 'available');
  assert.deepEqual(forBuyer.card.current.actions, ['add_to_cart']);
  const forAli = await card(raw, ALI, chatId, 'custom_product');
  assert.deepEqual(forAli.card.current.actions, ['cancel']);
});

test('ATTACK: invisible to every public door — storefront, its product page, the feed, the picker, the catalogue', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  const pub = as(raw, EVE);
  const list = await json(await get(pub, '/api/storefront/ali3d/products'));
  assert.ok(!JSON.stringify(list).includes(product.id), 'the storefront list');
  assert.equal((await get(pub, `/api/storefront/ali3d/products/custom-${product.id}`)).status, 404, 'its would-be page');
  assert.equal((await get(as(raw, BUYER), `/api/storefront/ali3d/products/custom-${product.id}`)).status, 404, 'even for its customer: it has no public page');
  const feed = await json(await get(pub, '/api/community/products'));
  assert.ok(!JSON.stringify(feed).includes(product.id), 'the community feed');
  const picker = await json(await get(as(raw, ALI), `/api/chats/${chatId}/products`));
  assert.deepEqual(picker.products.map((p: { id: string }) => p.id), ['cp_vase'], 'the product picker');
  const catalogue = await json(await get(as(raw, ALI), '/api/merchant/products'));
  assert.deepEqual(catalogue.products.map((p: { id: string }) => p.id), ['cp_vase'], 'the merchant\'s own catalogue');
  assert.equal((await get(as(raw, ALI), `/api/merchant/products/${product.id}`)).status, 404);
});

test('ATTACK: another customer, another store and the store itself cannot buy it — it does not exist for them', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  for (const who of [EVE, ZAIN, ALI]) {
    const res = await post(as(raw, who), '/api/cart/merchant-items', { productId: product.id, qty: 1 });
    assert.equal(res.status, 404, `${who.id} → ${res.status}`);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items'), 0);
});

// ================================================================ buying it

test('the customer buys it through the store checkout — re-priced, the order linked to the thread, «تم إنشاء الطلب» posted', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  // A price in the body is ignored, as it is for every product.
  const add = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: product.id, qty: 1, price_iqd: 1 });
  assert.equal(add.status, 201, JSON.stringify(await json(add.clone())));
  const cart = await json(await get(as(raw, BUYER), '/api/cart/merchant'));
  const line = (cart.items ?? []).find((i: { product_id: string }) => i.product_id === product.id);
  assert.equal(line?.available, true, JSON.stringify(cart));
  assert.equal(line?.unit_price_iqd, 60000);

  fund(raw, 'buyer', 200_000);
  const { res, body, quote } = await checkout(raw, BUYER, 'key-private-0001');
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal(quote.quote.subtotal_iqd, 60000);
  const order = row<Record<string, unknown>>(raw, 'SELECT id, origin_chat_id, subtotal_iqd FROM orders WHERE id = ?', body.order.id)!;
  assert.equal(order.origin_chat_id, chatId);
  assert.equal(row<{ stock: number }>(raw, 'SELECT stock FROM community_products WHERE id = ?', product.id)!.stock, 0);

  const system = (await messages(raw, ALI, chatId)).filter((m) => m.system);
  assert.equal(system.length, 1);
  assert.equal(system[0].card.type, 'order');
  assert.equal(system[0].card.original.event, 'placed');
  assert.equal(system[0].card.original.total_iqd, body.order.total_iqd);

  const bought = await card(raw, BUYER, chatId, 'custom_product');
  assert.equal(bought.card.current.status, 'purchased');
  assert.equal(bought.card.current.order_id, body.order.id);
  assert.deepEqual(bought.card.current.actions, ['view_order']);
});

test('ATTACK: bought once — a second add, or two in one line, is refused', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  const two = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: product.id, qty: 2 });
  assert.equal(two.status, 400);
  assert.equal((await json(two)).code, 'OUT_OF_STOCK');
  await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: product.id, qty: 1 });
  fund(raw, 'buyer', 200_000);
  assert.equal((await checkout(raw, BUYER, 'key-private-0002')).res.status, 201);
  const again = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: product.id, qty: 1 });
  assert.equal(again.status, 400);
  assert.equal((await json(again)).code, 'OUT_OF_STOCK');
});

test('ATTACK: what the customer was shown is what they pay — no door, and not the database, edits it', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  const edit = await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, { price_iqd: 90000 });
  assert.equal(edit.status, 409);
  assert.equal((await json(edit)).code, 'CUSTOM_PRODUCT_LOCKED');
  const bulk = await json(await post(as(raw, ALI), '/api/merchant/products/bulk', { action: 'set_price', ids: [product.id], price_iqd: 90000 }));
  assert.deepEqual(bulk.results, [{ id: product.id, ok: false, code: 'CUSTOM_PRODUCT_LOCKED' }]);
  assert.equal((await post(as(raw, ALI), `/api/merchant/products/${product.id}/duplicate`, {})).status, 409, 'no public copy of a customer\'s item');
  assert.throws(() => raw.exec(`UPDATE community_products SET price_iqd = 1 WHERE id = '${product.id}'`), /CUSTOM_PRODUCT_LOCKED/);
  assert.throws(() => raw.exec(`UPDATE community_products SET audience_user_id = 'eve' WHERE id = '${product.id}'`), /CUSTOM_PRODUCT_LOCKED/);
  assert.throws(() => raw.exec(`UPDATE community_products SET audience_user_id = NULL WHERE id = '${product.id}'`), /CUSTOM_PRODUCT_LOCKED/, 'it can never be made public');
  assert.throws(() => raw.exec(`UPDATE community_products SET audience_user_id = 'buyer' WHERE id = 'cp_vase'`), /CUSTOM_PRODUCT_LOCKED/, 'nor a public product made private');
  assert.equal(row<{ price_iqd: number }>(raw, 'SELECT price_iqd FROM community_products WHERE id = ?', product.id)!.price_iqd, 60000);
});

test('moderation\'s «unhide» cannot make a private product public', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  await post(as(raw, BOSS), `/api/admin/community/products/${product.id}/hide`, { hidden: true, reason: 'check' });
  await post(as(raw, BOSS), `/api/admin/community/products/${product.id}/hide`, { hidden: false });
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM community_products WHERE id = ?', product.id)!.status, 'hidden');
});

test('expired or cancelled — not buyable, and the card says which', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const first = await json(await makePrivate(raw, chatId));
  raw.exec(`DROP TRIGGER trg_private_product_locked;
            UPDATE community_products SET custom_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = '${first.product.id}'`);
  const expired = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: first.product.id, qty: 1 });
  assert.equal(expired.status, 404);
  assert.equal((await card(raw, BUYER, chatId, 'custom_product')).card.current.status, 'expired');

  const second = await json(await makePrivate(raw, chatId, { name: 'Second lamp' }));
  assert.equal((await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: second.product.id, qty: 1 })).status, 201);
  const cancel = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products/${second.product.id}/cancel`, {});
  assert.equal(cancel.status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM cart_items WHERE community_product_id = ?', second.product.id), 0, 'it left the cart with it');
  assert.equal((await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: second.product.id, qty: 1 })).status, 404);
  const cancelled = (await messages(raw, BUYER, chatId)).filter((m) => m.card?.ref === second.product.id).pop()!;
  assert.equal(cancelled.card.current.status, 'cancelled');
  assert.deepEqual(cancelled.card.current.actions, []);
  // Another store cannot cancel it, and the customer cannot either.
  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/custom-products/${first.product.id}/cancel`, {})).status, 403);
});

test('ATTACK: a bought private product cannot be cancelled from the conversation — its order is cancelled instead', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const { product } = await json(await makePrivate(raw, chatId));
  await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: product.id, qty: 1 });
  fund(raw, 'buyer', 200_000);
  await checkout(raw, BUYER, 'key-private-0003');
  const res = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products/${product.id}/cancel`, {});
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'CUSTOM_PRODUCT_LOCKED');
});

// ================================================================ one deal, one flow

test('a quote turned into a private product is closed in the same batch — never both', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { title: 'Desk sign', price_iqd: 30000, completion_days: 2 }));
  const res = await makePrivate(raw, chatId, { name: 'Desk sign', price_iqd: 30000, quote_id: q.offer.id });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', q.offer.id)!.state, 'withdrawn');
  fund(raw, 'buyer', 200_000);
  const accept = await post(as(raw, BUYER), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 30000, offer_revision: 1 });
  assert.equal(accept.status, 409, 'the quote cannot also be accepted');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_holds'), 0);

  // …and the other way round: an accepted quote cannot become a product.
  const q2 = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { title: 'Name plate', price_iqd: 20000 }));
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/offers/${q2.offer.id}/accept`, { expected_price_iqd: 20000, offer_revision: 1 })).status, 201);
  const late = await makePrivate(raw, chatId, { name: 'Name plate', price_iqd: 20000, quote_id: q2.offer.id });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'QUOTE_ALREADY_ACCEPTED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_products WHERE origin_offer_id = ?', q2.offer.id), 0);
});

test('ATTACK: only the store makes one, for its own thread; a picture must be the store\'s own', async () => {
  const raw = seed();
  const chatId = await storeThread(raw);
  assert.equal((await post(as(raw, BUYER), `/api/chats/${chatId}/custom-products`, { name: 'Free', price_iqd: 1 })).status, 403);
  assert.equal((await post(as(raw, ZAIN), `/api/chats/${chatId}/custom-products`, { name: 'Undercut', price_iqd: 1 })).status, 403);
  const foreign = await makePrivate(raw, chatId, { image: 'https://evil.example/pixel.png' });
  assert.equal(foreign.status, 400);
  assert.equal((await json(foreign)).code, 'IMAGE_NOT_OWNED');
  const others = await makePrivate(raw, chatId, { image: '/files/merchants/zain/public/abcd1234.webp' });
  assert.equal(others.status, 400);
  const own = await makePrivate(raw, chatId, { image: '/files/merchants/ali/public/abcd1234.webp' });
  assert.equal(own.status, 201);
  assert.equal((await json(own)).message.card.original.image, '/files/merchants/ali/public/abcd1234.webp');
});

// ================================================================ deploy window

test('a Worker ahead of 0152 still sells an ordinary product end to end', async () => {
  const raw = seed(dbThrough('0151'));
  assert.equal((await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: 'cp_vase', qty: 1 })).status, 201);
  const cart = await json(await get(as(raw, BUYER), '/api/cart/merchant'));
  assert.equal(cart.items[0].available, true);
  fund(raw, 'buyer', 200_000);
  const { res, body } = await checkout(raw, BUYER, 'key-behind-0001');
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.equal((await get(as(raw, ALI), '/api/merchant/products')).status, 200);
});
