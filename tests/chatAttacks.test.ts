/**
 * EVERY AUTHORIZATION RULE OF THE COMMERCE CHAT, AS AN ATTACK
 * (stage 9 of docs/COMMUNITY_COMMERCE_CHAT.md; the owner's §8 and §17).
 *
 * The server is the authority on money and on who is who: a price, a total, a
 * delivery fee, a balance, a snapshot, a sender, a store, a customer — none is
 * ever taken from the body. Each test below sends what an attacker would send
 * and asserts both halves: the refusal (or the ignored field) AND that nothing
 * was written.
 *
 * The suites beside this one hold the rest of the matrix: forged and foreign
 * card ids (chatCards), accepting twice and editing after the customer saw it
 * (chatQuotes), buying a private product as anyone else or twice and editing it
 * after payment (chatPrivateProducts), naming another customer's thread for a
 * cart line (chatSystemCards).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, json, count, row, type StubUser, type Mount } from './fixtures/app';
import { chatRoutes } from '../worker/routes/chats';
import { chatCommerceRoutes } from '../worker/routes/chatCommerce';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { resetPrivateProductsMemo } from '../worker/lib/privateProducts';

const RATE = 1400;
const FUTURE = '2099-01-01T00:00:00.000Z';
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const OMAR: StubUser = { id: 'omar', role: 'merchant', email: 'omar@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

const mount: Mount = (a) => {
  a.route('/api/chats', chatRoutes);
  a.route('/api/chats', chatCommerceRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/cart', cartRoutes);
  a.route('/api/store-orders', storeOrderRoutes);
};

/** Just enough R2 for the request file doors. */
class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | ArrayBuffer) {
    this.objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async head(key: string) {
    const v = this.objects.get(key);
    return v ? ({ key, size: v.byteLength } as unknown as R2Object) : null;
  }
  async get(key: string) {
    const v = this.objects.get(key);
    if (!v) return null;
    return {
      body: new Blob([v as unknown as BlobPart]).stream(),
      httpEtag: `"${key}"`,
      arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

// The customer's contact, which no store may read before a deal.
const PHONE = '+9647700000009';
const STREET = 'Karrada street 12, house 4';

function seed() {
  resetPrivateProductsMemo();
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,phone_e164) VALUES
      ('buyer','Sara','buyer@x.co','h','customer','sara','${PHONE}'), ('eve','Eve','eve@x.co','h','customer','eve',NULL),
      ('ali','Ali','ali@x.co','h','merchant','ali',NULL), ('omar','Omar','omar@x.co','h','merchant','omar',NULL),
      ('boss','Boss','boss@x.co','h','admin','boss',NULL);
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active'), ('m_om','omar','Omar Print','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active'), ('s_om','m_om','omar','omarprint','Omar Print','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,created_at) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','active','active',25000,5,1,'2026-09-01T00:00:00.000Z'),
      ('cp_om','m_om','s_om','cup','Cup','active','active',9000,5,1,'2026-09-01T00:00:00.000Z');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem_ali','ali','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}'),
      ('mem_om','omar','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES
      ('a1','buyer','Sara','${PHONE}','${STREET}','basra'), ('a_eve','eve','Eve','+964772','Street 3','basra'),
      ('a_ali','ali','Ali','+964779','Street 9','basra');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('exchangeRate','${RATE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}
const fund = (raw: DatabaseSync, user: string, iqd: number) =>
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_${Math.random().toString(36).slice(2)}','${user}','deposit','USD',${Math.ceil((iqd * 100) / RATE)},'approved','test funding')`);
const as = (raw: DatabaseSync, user: StubUser, bucket?: MemoryBucket) =>
  stubApp(asD1(raw), user, mount, bucket ? { env: { BUCKET: bucket } } : {});
const openThread = async (raw: DatabaseSync, who: StubUser = BUYER, merchantId = 'm_ali') =>
  (await json(await post(as(raw, who), '/api/chats/open', { merchantId }))).chatId as string;
const cardsOf = (raw: DatabaseSync, chatId: string, type: string) =>
  count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND card_type = ?', chatId, type);

async function directRequest(raw: DatabaseSync, chatId: string, bucket?: MemoryBucket, files: Array<[string, Uint8Array]> = []) {
  const draft = await json(await post(as(raw, BUYER, bucket), `/api/chats/${chatId}/print-requests`, {
    title: 'Phone stand', description: 'A stand for my phone, matte black please', quantity: 1,
  }));
  const ids: string[] = [];
  for (const [name, bytes] of files) {
    const form = new FormData();
    form.append('file', new File([bytes as unknown as BlobPart], name));
    const up = await as(raw, BUYER, bucket).request(`/api/marketplace/requests/${draft.request.id}/files`, { method: 'POST', body: form });
    assert.equal(up.status, 201, JSON.stringify(await json(up.clone())));
    ids.push((await json(up)).file.id);
  }
  const sent = await post(as(raw, BUYER, bucket), `/api/chats/${chatId}/print-requests/${draft.request.id}/send`, {});
  assert.equal(sent.status, 201, JSON.stringify(await json(sent.clone())));
  return { requestId: draft.request.id as string, files: ids };
}

/** A real binary STL of a 20 mm cube (analyseModel measures it). */
function stl(): Uint8Array {
  const w = 20;
  const v: Array<[number, number, number]> = [[0, 0, 0], [w, 0, 0], [w, w, 0], [0, w, 0], [0, 0, w], [w, 0, w], [w, w, w], [0, w, w]];
  const tris: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let o = 84;
  for (const [a, b, c] of tris) {
    o += 12;
    for (const i of [a, b, c]) {
      dv.setFloat32(o, v[i][0], true);
      dv.setFloat32(o + 4, v[i][1], true);
      dv.setFloat32(o + 8, v[i][2], true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}
const png = () => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
};

// ============================================================ identity from the body

test('ATTACK: a card is an id and nothing else — a snapshot, price, sender, store or «system» flag in the body is ignored', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const res = await post(as(raw, ALI), `/api/chats/${chatId}/messages`, {
    card: { type: 'product', ref: 'cp_vase', snapshot: { price_iqd: 1, name: 'Free' }, original: { price_iqd: 1 }, current: { actions: ['add_to_cart'] } },
    sender_id: 'buyer', store_id: 's_om', price_iqd: 1, is_system: 1, card_snapshot: '{"price_iqd":1}', card_event_key: 'x',
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const stored = row<{ sender_id: string; is_system: number; card_snapshot: string; card_event_key: string | null }>(
    raw, "SELECT sender_id, is_system, card_snapshot, card_event_key FROM chat_messages WHERE chat_id = ? AND card_type = 'product'", chatId
  )!;
  assert.equal(stored.sender_id, 'ali', 'the session is the sender');
  assert.equal(stored.is_system, 0);
  assert.equal(stored.card_event_key, null);
  const snap = JSON.parse(stored.card_snapshot);
  assert.deepEqual([snap.price_iqd, snap.name, snap.store.id], [25000, 'Vase', 's_ali'], 'the database wrote the snapshot');
});

test('ATTACK: a private product is for THIS thread’s customer at THIS store — audience, store, merchant and stock in the body are ignored', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const res = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, {
    name: 'Engraved lamp', price_iqd: 60000, prep_days: 2, valid_days: 7,
    audience_user_id: 'eve', customer_id: 'eve', store_id: 's_om', merchant_id: 'm_om', stock: 99, status: 'active', publish_state: 'draft',
  });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const id = (await json(res)).product.id as string;
  const p = row<Record<string, unknown>>(raw, 'SELECT audience_user_id, store_id, merchant_id, stock, status, publish_state FROM community_products WHERE id = ?', id)!;
  assert.deepEqual(
    [p.audience_user_id, p.store_id, p.merchant_id, p.stock, p.status, p.publish_state],
    ['buyer', 's_ali', 'm_ali', 1, 'hidden', 'published']
  );
  // The customer the body named cannot even see it.
  const eve = await post(as(raw, EVE), '/api/cart/merchant-items', { productId: id, qty: 1 });
  assert.equal(eve.status, 404);
});

test('ATTACK: a quote names its store and customer from the session and the thread — never from the body', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const res = await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, {
    title: 'Logo keychains', price_iqd: 40000, completion_days: 2,
    merchant_id: 'm_om', store_id: 's_om', customer_id: 'eve', state: 'accepted', revision: 9,
  });
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  const { offer, request_id } = await json(res);
  const o = row<Record<string, unknown>>(raw, 'SELECT merchant_id, store_id, state, revision FROM community_offers WHERE id = ?', offer.id)!;
  assert.deepEqual([o.merchant_id, o.store_id, o.state, o.revision], ['m_ali', 's_ali', 'pending', 1]);
  const r = row<Record<string, unknown>>(raw, 'SELECT customer_id, target_merchant_id, visibility, created_by FROM community_requests WHERE id = ?', request_id)!;
  assert.deepEqual([r.customer_id, r.target_merchant_id, r.visibility, r.created_by], ['buyer', 'm_ali', 'direct', 'merchant']);
});

// ============================================================ replays

test('ATTACK: a replayed send — the same client_id is the same quote, the same revision, the same private product', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const quote = { title: 'Logo keychains', price_iqd: 40000, completion_days: 2, client_id: 'quote-send-0001' };
  const first = await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, quote);
  assert.equal(first.status, 201);
  const again = await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, quote);
  assert.equal(again.status, 200);
  const [a, b] = [await json(first), await json(again)];
  assert.equal(b.replayed, true);
  assert.equal(b.offer.id, a.offer.id);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_requests WHERE created_by = 'merchant'"), 1, 'no second request');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE merchant_id = 'm_ali'"), 1, 'no second offer');
  assert.equal(cardsOf(raw, chatId, 'quote'), 1);

  // An edit replayed is one new revision, not two.
  const edit = { price_iqd: 38000, client_id: 'quote-edit-0001' };
  assert.equal((await patch(as(raw, ALI), `/api/chats/${chatId}/quotes/${a.offer.id}`, edit)).status, 200);
  const edited = await patch(as(raw, ALI), `/api/chats/${chatId}/quotes/${a.offer.id}`, edit);
  assert.equal(edited.status, 200);
  assert.equal((await json(edited)).replayed, true);
  assert.equal(row<{ revision: number }>(raw, 'SELECT revision FROM community_offers WHERE id = ?', a.offer.id)!.revision, 2);
  assert.equal(cardsOf(raw, chatId, 'quote'), 2);

  // A private product replayed is one product.
  const product = { name: 'Engraved lamp', price_iqd: 60000, client_id: 'product-send-0001' };
  const p1 = await json(await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, product));
  const p2res = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, product);
  assert.equal(p2res.status, 200);
  const p2 = await json(p2res);
  assert.deepEqual([p2.replayed, p2.product.id], [true, p1.product.id]);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_products WHERE audience_user_id = 'buyer'"), 1);
  assert.equal(cardsOf(raw, chatId, 'custom_product'), 1);

  // A client id already used for a line of text makes nothing else.
  await post(as(raw, ALI), `/api/chats/${chatId}/messages`, { body: 'hello', client_id: 'text-send-00001' });
  const reused = await post(as(raw, ALI), `/api/chats/${chatId}/custom-products`, { ...product, client_id: 'text-send-00001' });
  assert.equal(reused.status, 409);
  assert.equal((await json(reused)).code, 'CLIENT_ID_REUSED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_products WHERE audience_user_id = 'buyer'"), 1, 'nothing written');
});

// ============================================================ money

test('ATTACK: the checkout prices from the database — a forged total, fee, merchant share or balance in the body changes nothing', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const chatId = await openThread(raw);
  await post(as(raw, ALI), `/api/chats/${chatId}/messages`, { card: { type: 'product', ref: 'cp_vase' } });
  const add = await post(as(raw, BUYER), '/api/cart/merchant-items', { productId: 'cp_vase', qty: 1, price_iqd: 1, unit_price_iqd: 1, origin_chat_id: chatId });
  assert.ok([200, 201].includes(add.status), JSON.stringify(await json(add.clone())));
  const q = await json(await post(as(raw, BUYER), '/api/store-orders/quote', { addressId: 'a1', total_iqd: 1 }));
  const placed = await post(as(raw, BUYER), '/api/store-orders', {
    idempotencyKey: 'key-forged-0001', addressId: 'a1', quoteFingerprint: q.quote?.quote_fingerprint,
    total_iqd: 1, subtotal_iqd: 1, delivery_fee_iqd: 0, merchant_total_iqd: 1, balance_iqd: 99_999_999, price_iqd: 1,
  });
  assert.equal(placed.status, 201, JSON.stringify(await json(placed.clone())));
  const order = row<{ total_iqd: number; origin_chat_id: string | null }>(raw, "SELECT total_iqd, origin_chat_id FROM orders WHERE seller_type = 'merchant'")!;
  assert.ok(order.total_iqd >= 25000, `the order is priced by the server, not the body (${order.total_iqd})`);
  assert.equal(order.total_iqd, Number(q.quote.total_iqd), 'exactly what the server quoted');
  assert.equal(order.origin_chat_id, chatId);
});

test('ATTACK: accepting at a price the customer was not shown, or beyond the wallet — refused, nothing held', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const chatId = await openThread(raw);
  const a = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { title: 'Big job one', price_iqd: 300_000, completion_days: 2 }));
  const b = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { title: 'Big job two', price_iqd: 300_000, completion_days: 2 }));

  // A lower price than the offer's, or a missing one, is OFFER_CHANGED.
  for (const body of [{ expected_price_iqd: 1, offer_revision: 1 }, { offer_revision: 1 }, { expected_price_iqd: 300_000 }]) {
    const r = await post(as(raw, BUYER), `/api/marketplace/offers/${a.offer.id}/accept`, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal((await json(r)).code, 'OFFER_CHANGED');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_escrows'), 0);

  // DOUBLE SPEND: two acceptances that together exceed the wallet — one wins.
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/offers/${a.offer.id}/accept`, { expected_price_iqd: 300_000, offer_revision: 1 })).status, 201);
  const second = await post(as(raw, BUYER), `/api/marketplace/offers/${b.offer.id}/accept`, { expected_price_iqd: 300_000, offer_revision: 1 });
  assert.equal(second.status, 400, JSON.stringify(await json(second.clone())));
  assert.equal((await json(second)).code, 'INSUFFICIENT_FUNDS');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_escrows'), 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 1);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_offers WHERE id = ?', b.offer.id)!.state, 'pending', 'the refused one is untouched');
});

test('ATTACK: only the customer the quote was made for may accept it; a store never buys from itself', async () => {
  const raw = seed();
  fund(raw, 'eve', 500_000);
  fund(raw, 'ali', 500_000);
  const chatId = await openThread(raw);
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { title: 'Logo keychains', price_iqd: 40000, completion_days: 2 }));
  for (const who of [EVE, ALI, OMAR]) {
    const r = await post(as(raw, who), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 40000, offer_revision: 1 });
    assert.ok([403, 404].includes(r.status), `${who.id}: ${r.status}`);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0);
  // The store adding its own product — from a card or from anywhere — is refused.
  const own = await post(as(raw, ALI), '/api/cart/merchant-items', { productId: 'cp_vase', qty: 1 });
  assert.equal(own.status, 403);
  assert.equal((await json(own)).code, 'OWN_STORE_PURCHASE');
});

// ============================================================ privacy

test('ATTACK: before a deal the store learns a name — never the customer’s phone, email or address', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Hello, can you print this?' });
  const { requestId } = await directRequest(raw, chatId);
  const reads = [
    `/api/chats/${chatId}`,
    `/api/chats/${chatId}/messages`,
    `/api/chats/${chatId}/orders`,
    `/api/marketplace/requests/${requestId}`,
    '/api/chats',
  ];
  for (const path of reads) {
    const r = await get(as(raw, ALI), path);
    assert.equal(r.status, 200, path);
    const text = await r.text();
    for (const secret of [PHONE, 'buyer@x.co', STREET]) {
      assert.ok(!text.includes(secret), `${path} leaks ${secret}`);
    }
  }
});

test('ATTACK: print files — no storage key leaves the server; the store sees the picture, never the model, until the deal; other stores nothing', async () => {
  const raw = seed();
  fund(raw, 'buyer', 500_000);
  const bucket = new MemoryBucket();
  const chatId = await openThread(raw);
  const { requestId, files } = await directRequest(raw, chatId, bucket, [['Sara_bracket.stl', stl()], ['photo.png', png()]]);
  const [model, picture] = files;
  const keys = (raw.prepare('SELECT file_key FROM community_request_files WHERE request_id = ?').all(requestId) as Array<{ file_key: string }>).map((f) => f.file_key);
  assert.equal(keys.length, 2);

  // Every response the two sides read carries file IDS, never keys.
  for (const [who, path] of [[BUYER, `/api/chats/${chatId}/messages`], [ALI, `/api/chats/${chatId}/messages`], [ALI, `/api/marketplace/requests/${requestId}`]] as const) {
    const text = await (await get(as(raw, who, bucket), path)).text();
    for (const key of keys) assert.ok(!text.includes(key), `${who.id} ${path} leaks a storage key`);
  }

  const fileOf = (who: StubUser, id: string) => get(as(raw, who, bucket), `/api/marketplace/requests/${requestId}/files/${id}`);
  assert.equal((await fileOf(ALI, picture)).status, 200, 'the store sees the picture');
  const original = await fileOf(ALI, model);
  assert.equal(original.status, 403);
  assert.equal((await json(original)).code, 'FILE_ORIGINAL_RESTRICTED');
  for (const who of [OMAR, EVE]) {
    assert.equal((await fileOf(who, picture)).status, 404, `${who.id} sees nothing of a request sent to another store`);
    assert.equal((await fileOf(who, model)).status, 404);
  }

  // A renamed executable is refused by its bytes, whatever its name says.
  const exe = new Uint8Array(512);
  exe.set([0x4d, 0x5a, 0x90, 0x00], 0);
  const draft = await json(await post(as(raw, BUYER, bucket), `/api/chats/${chatId}/print-requests`, { title: 'Another job', description: 'Another job to print, please' }));
  const form = new FormData();
  form.append('file', new File([exe as unknown as BlobPart], 'model.stl'));
  const up = await as(raw, BUYER, bucket).request(`/api/marketplace/requests/${draft.request.id}/files`, { method: 'POST', body: form });
  assert.ok(up.status >= 400 && up.status < 500, `a renamed executable answered ${up.status}`);

  // The deal is the relationship: the accepted store now reads the original.
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { request_id: requestId, price_iqd: 40000, completion_days: 2 }));
  assert.equal((await post(as(raw, BUYER), `/api/marketplace/offers/${q.offer.id}/accept`, { expected_price_iqd: 40000, offer_revision: 1 })).status, 201);
  assert.equal((await fileOf(ALI, model)).status, 200, 'after acceptance the store downloads the model');
  assert.equal((await fileOf(OMAR, model)).status, 404, 'and nobody else');
});

test('ATTACK: another store cannot read the conversation, the request or the quote — nor make one of its own there', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const { requestId } = await directRequest(raw, chatId);
  const q = await json(await post(as(raw, ALI), `/api/chats/${chatId}/quotes`, { request_id: requestId, price_iqd: 40000, completion_days: 2 }));
  for (const path of [
    `/api/chats/${chatId}`,
    `/api/chats/${chatId}/messages`,
    `/api/chats/${chatId}/orders`,
    `/api/marketplace/requests/${requestId}`,
  ]) {
    const r = await get(as(raw, OMAR), path);
    assert.ok([403, 404].includes(r.status), `${path}: ${r.status}`);
    assert.ok(!(await r.text()).includes('40000'), `${path} leaks the quote`);
  }
  const offers = await get(as(raw, OMAR), `/api/marketplace/requests/${requestId}/offers`);
  if (offers.status === 200) assert.deepEqual((await json(offers)).offers ?? [], [], 'no private quote is listed to a rival');
  else assert.ok([403, 404].includes(offers.status));
  // Writing into it is refused too, and nothing lands.
  const before = count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?', chatId);
  for (const [path, body] of [
    [`/api/chats/${chatId}/messages`, { body: 'cheaper here!' }],
    [`/api/chats/${chatId}/quotes`, { request_id: requestId, price_iqd: 1000, completion_days: 1 }],
    [`/api/chats/${chatId}/custom-products`, { name: 'Undercut', price_iqd: 1000 }],
  ] as const) {
    const r = await post(as(raw, OMAR), path, body);
    assert.ok([403, 404].includes(r.status), `${path}: ${r.status}`);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?', chatId), before);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE merchant_id = 'm_om'"), 0);
  // …and cannot edit or withdraw ALI's quote through its own door.
  assert.ok([403, 404].includes((await patch(as(raw, OMAR), `/api/chats/${chatId}/quotes/${q.offer.id}`, { price_iqd: 1 })).status));
  assert.equal(row<{ price_iqd: number }>(raw, 'SELECT price_iqd FROM community_offers WHERE id = ?', q.offer.id)!.price_iqd, 40000);
});

test('ATTACK: a customer cannot act as the store — no quote, no private product, no store card of anyone', async () => {
  const raw = seed();
  const chatId = await openThread(raw);
  const { requestId } = await directRequest(raw, chatId);
  for (const [path, body] of [
    [`/api/chats/${chatId}/quotes`, { request_id: requestId, price_iqd: 1, completion_days: 1 }],
    [`/api/chats/${chatId}/custom-products`, { name: 'My own price', price_iqd: 1 }],
  ] as const) {
    const r = await post(as(raw, BUYER), path, body);
    assert.equal(r.status, 403, path);
  }
  const rival = await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { card: { type: 'store', ref: 's_om' } });
  assert.equal(rival.status, 404);
  assert.equal((await json(rival)).code, 'CARD_NOT_IN_THREAD');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_products WHERE audience_user_id IS NOT NULL"), 0);
});

// ============================================================ staff

test('staff cannot read a store’s conversation before it is an order’s — no read, no join, nothing recorded', async () => {
  // docs/COMMUNITY_COMMERCE_CHAT.md §17: the support desk reads a store's
  // ORDER thread read-only and every read is audited (tests/storeOrderChats);
  // the conversation a customer has with a store before any order is theirs.
  const raw = seed();
  const chatId = await openThread(raw);
  await post(as(raw, BUYER), `/api/chats/${chatId}/messages`, { body: 'Hello' });
  for (const path of [`/api/chats/${chatId}/messages`, `/api/chats/${chatId}`]) {
    const r = await get(as(raw, BOSS), path);
    assert.equal(r.status, 403, path);
  }
  const write = await post(as(raw, BOSS), `/api/chats/${chatId}/messages`, { body: 'hi from staff' });
  assert.ok([403, 404].includes(write.status));
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM chat_participants WHERE chat_id = ? AND user_id = 'boss'", chatId), 0);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ? AND sender_id = 'boss'", chatId), 0);
});
