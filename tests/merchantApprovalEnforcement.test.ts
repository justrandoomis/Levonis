/**
 * THE MERCHANT APPROVAL GATE, ENFORCED (Community V3 push 1.4, DECISIONS row
 * 259; gap analysis §3.4 E3–E12 and F, §3.5, §3.6, §3.10, §3.11).
 *
 * Owner decisions under test: C1 (every existing merchant applies — a merchant
 * row alone is NOT approval), C2 (the gate holds from this push), C9 (the
 * public sees one generic STORE_UNAVAILABLE / 404, never "under review" or
 * "rejected"), C10 (a merchant-PAUSED approved store stays listed and says it
 * is closed), C11 (a database without the approval column fails CLOSED, public
 * lists included). Finishing existing work stays open (F): nothing is frozen,
 * deleted or cancelled.
 *
 *   · table-driven: an unapproved merchant is refused at every E-row, and is
 *     absent from every public surface;
 *   · an approved but suspended merchant (or store) is still hidden;
 *   · an approved, merchant-paused store is listed with its paused status;
 *   · the finishing routes work for an unapproved merchant;
 *   · the public answer is generic and identical for every hidden reason;
 *   · on a database without 0204 the directory is empty and nothing sells;
 *   · no raw `<> 'suspended'` SQL literal outside the helpers (the guard).
 *
 * Real routes, every migration, only the session stubbed.
 *
 * Run: node --import tsx --test tests/merchantApprovalEnforcement.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  freshDb, dbThrough, hasColumn, asD1, stubApp, post, patch, put, get, json, row, count, type StubUser, type App,
} from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { merchantWorkshopRoutes } from '../worker/routes/merchantWorkshop';
import { merchantFinanceRoutes } from '../worker/routes/merchantFinance';
import { storeLayoutRoutes } from '../worker/routes/storeLayout';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { cartRoutes } from '../worker/routes/cart';
import { chatRoutes } from '../worker/routes/chats';
import { storefrontRoutes } from '../worker/routes/storefront';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { communitySearchRoutes } from '../worker/routes/communitySearch';
import { communityFavoriteRoutes } from '../worker/routes/communityFavorites';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import { productRoutes } from '../worker/routes/products';
import { orderRoutes } from '../worker/routes/orders';
import { publicApiRoutes } from '../worker/routes/publicApi';
import { webManifestRoute } from '../worker/routes/manifest';
import { sitemapRoute } from '../worker/routes/seo';
import { storeById, storeHiddenFromPublic, sellingVerdict } from '../worker/lib/merchantAuth';
import { storeTakesOrders } from '../worker/lib/storeOrderOps';
import { merchantTakesNewWork } from '../worker/lib/communityRequests';
import { loadCandidates } from '../worker/lib/printMatchingStore';
import { resolveProductPreview, resolveStorePreview } from '../worker/lib/socialPreview';
import { merchantPublicSql, withApprovalSchema } from '../worker/lib/merchantApproval';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { notifyRequestFiles } from '../worker/lib/requestFileHooks';
import { merchantAttentionRoutes } from '../worker/routes/merchantWorkspace';
import { storeStatus } from '../src/components/merchant/shell/status';
import { W } from '../src/components/merchant/shell/strings';
import type { MerchantMe } from '../src/lib/merchant';

const FUTURE = '2099-01-01T00:00:00.000Z';
const STAMP = '2026-10-18T09:00:00.000Z';
const STORE_HOST = 'ali3d.levonis-iq.com';
const OLD_HOST = 'ali-old.levonis-iq.com';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const STRANGER: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };

interface Opts {
  /** Did a reviewer approve m1? Default false — owner decision C1: a merchant row alone is not approval. */
  approved?: boolean;
  merchantStatus?: string;
  storeStatus?: string;
  sellsDirect?: 0 | 1;
  customRequests?: 0 | 1;
  /** Build the database only through this migration (the deploy-ahead case, C11). */
  through?: string;
}

/**
 * One shop and everything around it: a product, a finished work, a retired
 * slug, a store order, a review, a board request with the shop's pending
 * offer, a post the merchant wrote that tags the shop, a buyer's favourite,
 * and an active PLUS (so a refusal is approval's, never the plan's — C3).
 */
function seed(o: Opts = {}): DatabaseSync {
  const raw = o.through ? dbThrough(o.through) : freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,creator_public) VALUES
      ('owner','Ali','owner@x.co','h','merchant','alimaker',0),
      ('buyer','Sara','buyer@x.co','h','customer','sara',0),
      ('stranger','Omar','stranger@x.co','h','customer','omar',0),
      ('boss','Boss','boss@x.co','h','admin','boss',0);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m1','owner','Ali Dragon Prints','${o.merchantStatus ?? 'active'}');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,description,status,delivery_settings,sells_direct_products,accepts_custom_requests,categories,governorate)
      VALUES ('s1','m1','owner','ali3d','Dragon Forge','Prints for everyone','Our long bio','${o.storeStatus ?? 'active'}','{}',${o.sellsDirect ?? 1},${o.customRequests ?? 1},'["toys"]','baghdad');
    INSERT INTO merchant_store_slugs (slug,store_id,active) VALUES ('ali3d','s1',1),('ali-old','s1',0);
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,category,material)
      VALUES ('cp1','m1','s1','dragon-widget','Dragon widget','active','active',14000,5,1,'toys','PLA');
    INSERT INTO merchant_showcase (id,store_id,kind,title,details,image_key,active) VALUES ('w1','s1','work','A dragon','', 'merchants/owner/showcase/w1.webp',1);
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('od1','buyer','pending',14000,'m1','s1','merchant','store_product','{}','d','{}','wallet',14000,1500,0);
    INSERT INTO merchant_reviews (id,merchant_id,customer_id,order_id,rating,body) VALUES ('rv1','m1','buyer','od1',5,'great');
    INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility)
      VALUES ('r1','buyer','A dragon stand','A stand for a dragon','open','open','public');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,completion_days,state)
      VALUES ('o1','r1','m1','s1',20000,3,'pending');
    INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,store_id,tags,published_at)
      VALUES ('po1','owner','project','Dragon print','Printed slowly.','published','public','s1','["dragon"]','${new Date(Date.now() - 86_400_000).toISOString()}');
    INSERT INTO community_product_favorites (user_id,product_id) VALUES ('buyer','cp1');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
  `);
  if (o.approved && hasColumn(raw, 'community_merchants', 'approved_at')) {
    raw.prepare("UPDATE community_merchants SET approved_at = ? WHERE id = 'm1'").run(STAMP);
  }
  return raw;
}

const merchantApp = (raw: DatabaseSync) =>
  stubApp(asD1(raw), OWNER, (a) => {
    a.route('/api/merchant/workshop', merchantWorkshopRoutes);
    a.route('/api/merchant/store/layout', storeLayoutRoutes);
    a.route('/api/merchant/finance', merchantFinanceRoutes);
    a.route('/api/merchant', merchantRoutes);
    a.route('/api/merchant', merchantCatalogRoutes);
    a.route('/api/marketplace', marketplaceRoutes);
    a.route('/api/community', communityRoutes);
  }, { env: ENV });

const customerApp = (raw: DatabaseSync, user: StubUser = BUYER) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/marketplace', marketplaceRoutes);
    a.route('/api/chats', chatRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/community-favorites', communityFavoriteRoutes);
    a.route('/api/community-reviews', communityReviewRoutes);
    a.route('/api/community', communityRoutes);
  }, { env: ENV });

/** A signed-out visitor, on the apex or on a store's own host. */
const visitorApp = (raw: DatabaseSync, host?: string) =>
  stubApp(asD1(raw), null, (a) => {
    a.route('/api/storefront', storefrontRoutes);
    a.route('/api/community', communityRoutes);
    a.route('/api/community', communityPostRoutes);
    a.route('/api/community', communitySocialRoutes);
    a.route('/api/community', communitySearchRoutes);
    a.route('/api/products', productRoutes);
    a.route('/api/public/v1', publicApiRoutes);
    a.get('/manifest.webmanifest', webManifestRoute);
    a.get('/sitemap.xml', sitemapRoute);
  }, { env: ENV, ...(host ? { host } : {}) });

async function code(res: Response): Promise<string | undefined> {
  return (await json(res)).code as string | undefined;
}

// =========================================================== E3–E12: the gates

/** Every new commitment an unapproved merchant might try, and what it must answer. */
const MERCHANT_GATES: Array<[string, (m: App) => Response | Promise<Response>]> = [
  ['E3 publish a product', (m) => post(m, '/api/merchant/products', { name: 'New thing', price_iqd: 1000 })],
  ['E3 import products', (m) => post(m, '/api/merchant/products/import', { rows: [] })],
  ['E3 duplicate a product', (m) => post(m, '/api/merchant/products/cp1/duplicate', {})],
  ['E3 add a service', (m) => post(m, '/api/merchant/services', { title: 'Printing' })],
  ['E3 add a coupon', (m) => post(m, '/api/merchant/coupons', { code: 'DRAGON10', percent_off: 10 })],
  ['E3 rename the slug', (m) => post(m, '/api/merchant/store/slug', { slug: 'dragon-forge' })],
  ['E4 make a board offer', (m) => post(m, '/api/marketplace/requests/r1/offers', { price_iqd: 21000, completion_days: 3 })],
  ['E4 edit an offer', (m) => patch(m, '/api/marketplace/offers/o1', { price_iqd: 19000 })],
  ['E4 send a drafted offer', (m) => post(m, '/api/marketplace/offers/o1/send', {})],
  ['E4 re-confirm an offer', (m) => post(m, '/api/marketplace/offers/o1/reconfirm', {})],
  ['E10 publish the store page', (m) => post(m, '/api/merchant/store/layout/publish', { version: 1 })],
  ['E10 restore a revision AND publish it', (m) => post(m, '/api/merchant/store/layout/restore/1', { version: 0, publish: true })],
];

test('E3/E4/E10: every new commitment from an unapproved merchant is refused with MERCHANT_NOT_APPROVED — PLUS is active', async () => {
  const raw = seed();
  const m = merchantApp(raw);
  for (const [name, call] of MERCHANT_GATES) {
    const res = await call(m);
    assert.equal(res.status, 403, name);
    assert.equal(await code(res), 'MERCHANT_NOT_APPROVED', name);
  }
  // Nothing was written by any of them.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_products'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_offers WHERE id <> 'o1'"), 0);
  assert.equal(row<{ slug: string }>(raw, "SELECT slug FROM merchant_stores WHERE id = 's1'")!.slug, 'ali3d');
});

test('E3/E4/E10 positive control: the same doors never say MERCHANT_NOT_APPROVED to an approved merchant', async () => {
  const m = merchantApp(seed({ approved: true }));
  for (const [name, call] of MERCHANT_GATES) assert.notEqual(await code(await call(m)), 'MERCHANT_NOT_APPROVED', name);
});

test('E3: a sanction still answers as itself first — the approval line does not mask MERCHANT_SUSPENDED', async () => {
  const res = await post(merchantApp(seed({ merchantStatus: 'suspended' })), '/api/merchant/products', { name: 'x' });
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'MERCHANT_SUSPENDED');
});

test('E5: the store of an unapproved merchant takes no new order — the buyer hears only STORE_CLOSED', async () => {
  const raw = seed();
  const db = asD1(raw);
  const ctx = (await storeById(db, 's1'))!;
  assert.equal(ctx.merchant.approved_at, null, 'no permissive default: a merchant row is not approval');
  assert.deepEqual(await sellingVerdict(db, ctx, 'owner'), { canSell: false, reason: 'not_approved' });
  assert.deepEqual(await storeTakesOrders(db, ctx), { ok: false, reason: 'not_approved' });

  const add = await post(customerApp(raw), '/api/cart/merchant-items', { productId: 'cp1', qty: 1 });
  assert.equal(add.status, 400);
  const body = await json(add);
  assert.equal(body.code, 'STORE_CLOSED');
  assert.doesNotMatch(String(body.error), /approv|review|reject/i, 'the buyer is never told why');

  const approved = seed({ approved: true });
  assert.deepEqual(await storeTakesOrders(asD1(approved), (await storeById(asD1(approved), 's1'))!), { ok: true });
});

test('E6: merchantTakesNewWork asks approval (a required field), and a customer cannot accept an unapproved merchant\'s offer', async () => {
  const raw = seed();
  const db = asD1(raw);
  const base = { merchantStatus: 'active', storeStatus: 'active', ownerUserId: 'owner' };
  assert.equal(await merchantTakesNewWork(db, { ...base, merchantApproved: false }), false);
  assert.equal(await merchantTakesNewWork(db, { ...base, merchantApproved: true }), true);

  const res = await post(customerApp(raw), '/api/marketplace/offers/o1/accept', { expected_total_iqd: 20000, offer_revision: 1 });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'MERCHANT_UNAVAILABLE');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o1'")!.state, 'pending', 'nothing is cancelled automatically');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_orders'), 0, 'no order, no escrow hold');
});

test('E7: matching, the workshop board and the «for me» rail leave an unapproved workshop out', async () => {
  const raw = seed();
  const db = asD1(raw);
  assert.deepEqual((await loadCandidates(db)).map((m) => m.merchant_id), [], 'the publish-time re-match never meets it');
  const named = await loadCandidates(db, ['m1']);
  assert.equal(named.length, 1);
  assert.equal(named[0]!.approved, false, 'a live verdict can still say why');

  const m = merchantApp(raw);
  const board = await json(await get(m, '/api/merchant/workshop/board'));
  // Approval has its own code (review finding 8): the board says the gate, not «open / renew».
  assert.equal(board.blocked, 'MERCHANT_NOT_APPROVED');
  assert.deepEqual(board.requests, []);
  const paused = await json(await get(merchantApp(seed({ approved: true, storeStatus: 'paused' })), '/api/merchant/workshop/board'));
  assert.equal(paused.blocked, 'CANNOT_TAKE_WORK', 'an approved, paused workshop keeps its own code');
  const forMe = await json(await get(m, '/api/community/requests?for=me'));
  assert.equal(forMe.blocked, 'CANNOT_TAKE_WORK');

  const approved = seed({ approved: true });
  assert.deepEqual((await loadCandidates(asD1(approved))).map((c) => c.merchant_id), ['m1']);
});

test('E8: re-opening a paused store asks the shared predicate — MERCHANT_NOT_APPROVED, and the store stays paused', async () => {
  const raw = seed({ storeStatus: 'paused' });
  const res = await patch(merchantApp(raw), '/api/merchant/store', { open: true });
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'MERCHANT_NOT_APPROVED');
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM merchant_stores WHERE id = 's1'")!.status, 'paused');
  // Pausing and editing stay the merchant's own.
  const edit = await patch(merchantApp(raw), '/api/merchant/store', { tagline: 'Back soon', open: false });
  assert.equal(edit.status, 200, JSON.stringify(await json(edit.clone())));
});

test('E9: switching direct sales or custom requests ON is refused plainly; OFF and an unchanged echo save', async () => {
  const off = seed({ sellsDirect: 0, customRequests: 0 });
  for (const body of [{ sells_direct_products: true }, { accepts_custom_requests: true }]) {
    const res = await patch(merchantApp(off), '/api/merchant/store', { ...body, tagline: 'x' });
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.equal(await code(res), 'MERCHANT_NOT_APPROVED');
  }
  assert.equal(row<{ tagline: string }>(off, "SELECT tagline FROM merchant_stores WHERE id = 's1'")!.tagline, 'Prints for everyone', 'a refused save writes nothing');

  const on = seed();
  // What the settings form sends on every save: the values the store already has.
  const echo = await patch(merchantApp(on), '/api/merchant/store', { sells_direct_products: true, accepts_custom_requests: true, open: true, tagline: 'New tagline' });
  assert.equal(echo.status, 200, JSON.stringify(await json(echo.clone())));
  assert.equal(row<{ tagline: string }>(on, "SELECT tagline FROM merchant_stores WHERE id = 's1'")!.tagline, 'New tagline');
  const switchOff = await patch(merchantApp(on), '/api/merchant/store', { sells_direct_products: false });
  assert.equal(switchOff.status, 200);
});

test('E10: an unapproved merchant still designs — a draft saves and a restore into the draft is open', async () => {
  const raw = seed();
  const layout = { schema_version: 1, theme: 'classic', blocks: [{ id: 'a', type: 'text', settings: { title: { ar: 'ملاحظة', en: '', ckb: '' }, body: { ar: 'مرحبا', en: '', ckb: '' } } }] };
  const saved = await put(merchantApp(raw), '/api/merchant/store/layout/draft', { layout, version: 0 });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())));
  const publish = await post(merchantApp(raw), '/api/merchant/store/layout/publish', { version: 1 });
  assert.equal(await code(publish), 'MERCHANT_NOT_APPROVED');
  assert.equal(row<{ published_revision_id: string | null }>(raw, "SELECT published_revision_id FROM merchant_stores WHERE id = 's1'")!.published_revision_id, null);
});

test('E11: a finished work may be created before approval, but the public works rail shows it only through the predicate', async () => {
  const raw = seed();
  const create = await post(merchantApp(raw), '/api/merchant/showcase', { kind: 'work', title: 'Another dragon' });
  assert.notEqual(await code(create), 'MERCHANT_NOT_APPROVED', 'creation stays open');
  assert.deepEqual((await json(await get(visitorApp(raw), '/api/community/works'))).works, []);
  const approved = seed({ approved: true });
  assert.deepEqual((await json(await get(visitorApp(approved), '/api/community/works'))).works.map((w: { id: string }) => w.id), ['w1']);
});

test('E12: a NEW chat by merchant id to a merchant the public may not see is the generic refusal — unless business already exists', async () => {
  const raw = seed();
  const refused = await post(customerApp(raw, STRANGER), '/api/chats/open', { merchantId: 'm1' });
  assert.equal(refused.status, 404);
  assert.equal(await code(refused), 'STORE_UNAVAILABLE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM chats WHERE merchant_id = 'm1'"), 0, 'no thread was opened');

  // The buyer has an order with this store: the conversation opens (finishing work).
  const known = await post(customerApp(raw), '/api/chats/open', { merchantId: 'm1' });
  assert.equal(known.status, 200, JSON.stringify(await json(known.clone())));
  assert.equal((await json(known)).context, 'store');

  // An approved store opens a new conversation for anyone.
  const open = await post(customerApp(seed({ approved: true }), STRANGER), '/api/chats/open', { merchantId: 'm1' });
  assert.equal(open.status, 200);
});

/**
 * REVIEW FINDING 3: the E12 guard counted ANY conversation both accounts
 * share — and `{userId}` opens a personal DM with anyone on demand. Only
 * commerce threads (a store, request or order thread, or an order chat) are
 * existing business now.
 */
test('E12: a personal DM opened first is not business — the hidden store\'s thread is still the generic refusal', async () => {
  const raw = seed();
  const dm = await post(customerApp(raw, STRANGER), '/api/chats/open', { userId: 'owner' });
  assert.equal(dm.status, 200, JSON.stringify(await json(dm.clone())));
  const refused = await post(customerApp(raw, STRANGER), '/api/chats/open', { merchantId: 'm1' });
  assert.equal(refused.status, 404);
  assert.equal(await code(refused), 'STORE_UNAVAILABLE');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM chats WHERE merchant_id = 'm1'"), 0, 'no store thread was opened');
  // A real commerce thread is business: the buyer's order still opens it (finishing work).
  assert.equal((await post(customerApp(raw), '/api/chats/open', { merchantId: 'm1' })).status, 200);
});

/**
 * REVIEW FINDING 2 (C9): the favourites door saved a hidden store's product
 * and its list returned that store's name, pictures and price. A save is
 * refused like a missing id; a saved row becomes neutral — removable, and
 * not one field the merchant wrote.
 */
test('C9: favourites — a hidden store\'s product cannot be saved, and an existing save is a neutral row with nothing the merchant wrote', async () => {
  const raw = seed();
  const save = await put(customerApp(raw, STRANGER), '/api/community-favorites/cp1', {});
  assert.equal(save.status, 404);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_product_favorites WHERE user_id = 'stranger'"), 0);

  const res = await get(customerApp(raw), '/api/community-favorites');
  assert.equal(res.status, 200);
  const body = await res.clone().text();
  for (const leak of ['Dragon', 'dragon-widget', 'ali3d', '14000']) assert.ok(!body.includes(leak), `the list leaks «${leak}»: ${body}`);
  const item = ((await json(res)).items as Array<Record<string, unknown>>).find((i) => i.product_id === 'cp1');
  assert.ok(item, 'the save stays, so the customer can remove it');
  assert.equal(item.unavailable, true);
  for (const k of ['image', 'price_iqd', 'original_price_iqd', 'store_slug', 'store_name', 'store_url', 'name_ar', 'in_stock']) assert.equal(item[k], null, k);
  assert.equal(item.name, '');
  // Removing it still works.
  assert.equal((await customerApp(raw).request('/api/community-favorites/cp1', { method: 'DELETE' })).status, 200);

  // Approved: the door and the row are the shop's, as before.
  const approved = seed({ approved: true });
  assert.equal((await put(customerApp(approved, STRANGER), '/api/community-favorites/cp1', {})).status, 200);
  const shown = ((await json(await get(customerApp(approved), '/api/community-favorites'))).items as Array<Record<string, unknown>>).find((i) => i.product_id === 'cp1')!;
  assert.equal(shown.name, 'Dragon widget');
  assert.equal(shown.store_name, 'Dragon Forge');
  assert.equal(shown.unavailable, undefined);
  // A sanction hides it the same way.
  const suspended = seed({ approved: true, storeStatus: 'suspended' });
  assert.equal((await put(customerApp(suspended, STRANGER), '/api/community-favorites/cp1', {})).status, 404);
});

/**
 * REVIEW FINDING 4 (E7): verdict rows written before the gate still read
 * «eligible» for a merchant no reviewer approved — the re-match never
 * rewrites them. The file notice and the workspace count no longer trust
 * them; an OFFER is existing work and its merchant is still told.
 */
test('E7: a pre-gate «eligible» match row tells an unapproved workshop nothing — no file notice, no matching count; an offer still hears', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,creator_public) VALUES
      ('owner2','Zain','owner2@x.co','h','merchant','zain',0), ('owner3','Huda','owner3@x.co','h','merchant','huda',0);
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m2','owner2','Zain Prints','active'), ('m3','owner3','Huda Prints','active');
    INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,revision) VALUES
      ('mt1','r1','m1',1,1), ('mt2','r1','m2',1,1), ('mt3','r1','m3',1,1);
  `);
  raw.prepare("UPDATE community_merchants SET approved_at = ? WHERE id = 'm3'").run(STAMP);
  await notifyRequestFiles(asD1(raw), 'r1', { id: 'buyer', name: 'Sara' });
  const told = (raw.prepare("SELECT user_id FROM user_notifications WHERE kind = 'request_files' ORDER BY user_id").all() as Array<{ user_id: string }>).map((r) => r.user_id);
  assert.deepEqual(told, ['owner', 'owner3'], 'm1 through its pending offer (existing work), m3 approved; never the unapproved m2');

  // The workspace count: a match on an open request the merchant has not offered on.
  const attentionOf = async (db: DatabaseSync) => {
    db.exec(`
      INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility)
        VALUES ('r2','buyer','A dragon lamp','A lamp for a dragon','open','receiving_offers','public');
      INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,revision) VALUES ('mt9','r2','m1',1,1);
    `);
    const app = stubApp(asD1(db), OWNER, (a) => a.route('/api/merchant/attention', merchantAttentionRoutes), { env: ENV });
    const res = await get(app, '/api/merchant/attention');
    assert.equal(res.status, 200);
    return (await json(res)).attention as Record<string, { matching?: number } | undefined>;
  };
  assert.equal((await attentionOf(seed())).requests, undefined, 'unapproved: the field is absent, as the board is empty');
  assert.equal((await attentionOf(seed({ approved: true }))).requests?.matching, 1, 'approved: r2 counts (r1 already has the offer)');
});

/**
 * REVIEW FINDING 6: `/me` says the store's OWN state beside the approval
 * axis, and the pill reads it — an OPEN store of an unapproved merchant
 * reads «open», never «paused»; a merchant pause reads «paused» and says
 * re-opening waits for approval.
 */
test('the pill stays on the operational axis: /me sends `operational`, and an unapproved OPEN store reads open', async () => {
  const open = await json(await get(merchantApp(seed()), '/api/merchant/me'));
  assert.deepEqual(open.selling, { canSell: false, reason: 'not_approved', canDraft: true, operational: '' });
  const pill = storeStatus(open as MerchantMe);
  assert.equal(pill.key, 'open');
  assert.deepEqual(pill.label, W.open);
  assert.equal(pill.tone, 'success');
  assert.ok(pill.approval, 'approval rides beside it');

  const paused = await json(await get(merchantApp(seed({ storeStatus: 'paused' })), '/api/merchant/me'));
  assert.deepEqual(paused.selling, { canSell: false, reason: 'not_approved', canDraft: false, operational: 'store_paused' });
  const pausedPill = storeStatus(paused as MerchantMe);
  assert.equal(pausedPill.key, 'paused');
  assert.deepEqual(pausedPill.label, W.paused);
  const loc = (ar: string, en: string) => en || ar;
  assert.match(pausedPill.reason(loc), /once your store is approved/);
  assert.doesNotMatch(pausedPill.reason(loc), /from store settings/);

  const approved = await json(await get(merchantApp(seed({ approved: true })), '/api/merchant/me'));
  assert.deepEqual(approved.selling, { canSell: true, reason: '', canDraft: true, operational: '' });
});

// ========================================================== F: finishing work

test('F: finishing existing work stays open for an unapproved merchant — orders, reviews, money, offer withdraw', async () => {
  const raw = seed();
  const m = merchantApp(raw);
  const move = await post(m, '/api/merchant/orders/od1/status', { status: 'confirmed' });
  assert.equal(move.status, 200, JSON.stringify(await json(move.clone())));
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM orders WHERE id = 'od1'")!.status, 'confirmed');

  const reply = await post(m, '/api/merchant/reviews/rv1/reply', { reply: 'Thank you!' });
  assert.equal(reply.status, 200, JSON.stringify(await json(reply.clone())));

  assert.equal((await get(m, '/api/merchant/orders')).status, 200);
  assert.equal((await get(m, '/api/merchant/finance/summary')).status, 200);
  assert.equal((await get(m, '/api/merchant/me')).status, 200);

  const withdraw = await post(m, '/api/marketplace/offers/o1/withdraw', {});
  assert.equal(withdraw.status, 200, JSON.stringify(await json(withdraw.clone())));
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_offers WHERE id = 'o1'")!.state, 'withdrawn');
});

test('F: the customer keeps seeing their own order with an unapproved store', async () => {
  const raw = seed();
  const list = await json(await get(customerApp(raw), '/api/orders'));
  const ids = ((list.orders ?? list.data ?? []) as Array<{ id: string }>).map((o) => o.id);
  assert.ok(ids.includes('od1'), JSON.stringify(list).slice(0, 400));
});

// ================================================= §3.6: every public surface

/**
 * Each public surface, and whether the shop (m1/s1/cp1) appears on it. The
 * PERSON surfaces (marked) are about the merchant, not the store: a STORE
 * suspension hides the store but leaves its approved owner a maker page —
 * with no store on it (asserted separately below).
 */
const PERSON = new Set(['creators list', 'creator page', 'author mark on a post']);
const SURFACES: Array<[string, (raw: DatabaseSync) => Promise<boolean>]> = [
  ['directory', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/merchants'))).merchants as unknown[]).length > 0],
  ['directory count', async (raw) => Number((await json(await get(visitorApp(raw), '/api/community/merchants'))).total) > 0],
  ['product feed', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/products'))).products as unknown[]).length > 0],
  ['works rail', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/works'))).works as unknown[]).length > 0],
  ['in-site store page', async (raw) => (await get(visitorApp(raw), '/api/community/store/m1')).status === 200],
  ['storefront by slug', async (raw) => (await get(visitorApp(raw), '/api/storefront/ali3d')).status === 200],
  ['storefront products', async (raw) => (await get(visitorApp(raw), '/api/storefront/ali3d/products')).status === 200],
  ['storefront by id', async (raw) => (await get(visitorApp(raw), '/api/storefront/by-id/s1')).status === 200],
  ['subdomain resolve', async (raw) => (await get(visitorApp(raw, STORE_HOST), '/api/storefront/resolve')).status === 200],
  ['old slug redirect', async (raw) => (await code(await get(visitorApp(raw, OLD_HOST), '/api/storefront/resolve'))) === 'STORE_MOVED'],
  ['old product link', async (raw) => (await get(visitorApp(raw), '/api/products/dragon-widget')).status === 200],
  ['search: stores', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/search?q=dragon'))).sections.stores.rows as unknown[]).length > 0],
  ['search: products', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/search?q=dragon'))).sections.products.rows as unknown[]).length > 0],
  ['suggest', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/search/suggest?q=dragon'))).suggestions as Array<{ type: string }>).some((s) => s.type === 'store')],
  ['trending stores', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/trending'))).stores as unknown[]).length > 0],
  ['trending count', async (raw) => Number((await json(await get(visitorApp(raw), '/api/community/trending'))).totals.merchants) > 0],
  ['recommend for the store', async (raw) => (await get(visitorApp(raw), '/api/community/recommend?for=store:s1')).status === 200],
  ['recommend for the product', async (raw) => (await get(visitorApp(raw), '/api/community/recommend?for=product:cp1')).status === 200],
  ['creators list', async (raw) => ((await json(await get(visitorApp(raw), '/api/community/creators'))).creators as Array<{ id: string }>).some((c) => c.id === 'owner')],
  ['creator page', async (raw) => (await get(visitorApp(raw), '/api/community/creators/alimaker')).status === 200],
  ['author mark on a post', async (raw) => {
    const posts = (await json(await get(visitorApp(raw), '/api/community/posts'))).posts as Array<{ id: string; author: { username: string | null } }>;
    return posts.find((p) => p.id === 'po1')?.author.username === 'alimaker';
  }],
  ['tagged store on a post', async (raw) => {
    const posts = (await json(await get(visitorApp(raw), '/api/community/posts'))).posts as Array<{ id: string; store: unknown }>;
    return !!posts.find((p) => p.id === 'po1')?.store;
  }],
  ['favourites store link', async (raw) => {
    const items = (await json(await get(customerApp(raw), '/api/community-favorites'))).items as Array<{ product_id: string; store_url: string | null }>;
    return !!items?.find((i) => i.product_id === 'cp1')?.store_url;
  }],
  ['follow', async (raw) => (await post(customerApp(raw), '/api/community/store/m1/follow', {})).status === 200],
  ['public API: stores', async (raw) => ((await json(await get(visitorApp(raw), '/api/public/v1/community/stores'))).data as unknown[]).length > 0],
  ['public API: products', async (raw) => ((await json(await get(visitorApp(raw), '/api/public/v1/community/products'))).data as unknown[]).length > 0],
  ['public API: the shop', async (raw) => (await get(visitorApp(raw), '/api/public/v1/stores/ali3d')).status === 200],
  ['PWA manifest', async (raw) => String((await json(await get(visitorApp(raw, STORE_HOST), '/manifest.webmanifest'))).name) === 'Dragon Forge'],
  ['store-host sitemap', async (raw) => (await (await get(visitorApp(raw, STORE_HOST), '/sitemap.xml')).text()).includes('dragon-widget')],
  ['OG store card', async (raw) => !!(await resolveStorePreview(asD1(raw), `https://${STORE_HOST}`, { storeSlug: 'ali3d' }))],
  ['OG product card', async (raw) => {
    const p = await resolveProductPreview(asD1(raw), 'dragon-widget', `https://${STORE_HOST}`, { storeSlug: 'ali3d' });
    return !!p && /Dragon widget/.test(String(p.title));
  }],
];

/** What every surface answers for one world (one database: the surfaces only read, but «follow», which is last but three). */
async function surfaces(raw: DatabaseSync): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const [name, seen] of SURFACES) out[name] = await seen(raw);
  return out;
}

test('§3.6 positive control: an APPROVED shop is on every public surface', async () => {
  for (const [name, shown] of Object.entries(await surfaces(seed({ approved: true })))) assert.equal(shown, true, name);
});

test('§3.6: an UNAPPROVED shop is absent from every public surface', async () => {
  for (const [name, shown] of Object.entries(await surfaces(seed()))) assert.equal(shown, false, name);
});

test('§3.6: an approved but SUSPENDED merchant is still hidden everywhere', async () => {
  for (const [name, shown] of Object.entries(await surfaces(seed({ approved: true, merchantStatus: 'suspended' })))) assert.equal(shown, false, name);
});

test('§3.6: an approved merchant\'s SUSPENDED store is hidden everywhere — its owner keeps a maker page with no store on it', async () => {
  const raw = seed({ approved: true, storeStatus: 'suspended' });
  for (const [name, shown] of Object.entries(await surfaces(raw))) assert.equal(shown, !!PERSON.has(name), name);
  const creator = await json(await get(visitorApp(raw), '/api/community/creators/alimaker'));
  assert.equal(creator.creator.store, null);
  const listed = ((await json(await get(visitorApp(raw), '/api/community/creators'))).creators as Array<{ id: string; store: unknown }>).find((c) => c.id === 'owner');
  assert.equal(listed?.store, null);
});

test('C10: an approved store its merchant PAUSED stays listed, and says it is closed', async () => {
  const raw = seed({ approved: true, storeStatus: 'paused' });
  const dir = await json(await get(visitorApp(raw), '/api/community/merchants'));
  assert.equal(dir.merchants.length, 1);
  assert.ok(dir.merchants[0].store_url, 'a paused shop keeps its address');
  const page = await get(visitorApp(raw), '/api/storefront/ali3d');
  assert.equal(page.status, 200);
  const store = (await json(page)).store;
  assert.equal(store.status, 'closed', 'its page renders and says it is closed — never why');
  assert.equal(storeHiddenFromPublic((await storeById(asD1(raw), 's1'))!), false);
});

// ============================================================ §3.5: one answer

test('C9: the public answer is ONE generic STORE_UNAVAILABLE, identical for an unapproved and a suspended store — never a state', async () => {
  const answers = [];
  for (const raw of [seed(), seed({ approved: true, storeStatus: 'suspended' }), seed({ approved: true, merchantStatus: 'suspended' })]) {
    for (const [app, path] of [[visitorApp(raw), '/api/storefront/ali3d'], [visitorApp(raw), '/api/community/store/m1'], [visitorApp(raw, STORE_HOST), '/api/storefront/resolve']] as const) {
      const res = await get(app, path);
      assert.equal(res.status, 404, path);
      const body = await json(res);
      assert.equal(body.code, 'STORE_UNAVAILABLE', path);
      const text = JSON.stringify(body);
      assert.doesNotMatch(text, /review|approv|reject|apply|application|Dragon Forge|Ali Dragon/i, `${path}: nothing of the state or the shop`);
      answers.push(`${path} ${body.error}`);
    }
  }
  // The same words, whatever the reason.
  assert.equal(new Set(answers).size, 3);
});

test('the merchant alone hears MERCHANT_NOT_APPROVED, in all three languages, with a real Sorani', () => {
  const s = REFUSAL_STRINGS.MERCHANT_NOT_APPROVED;
  assert.ok(s && s.ar && s.en && s.ckb);
  assert.notEqual(s.ckb, s.ar);
  assert.match(s.ckb, /[ەێۆڕڵ]/u, 'Sorani letters, not the Arabic pasted across');
});

// ========================================================= C11: schema absence

test('C11: on a database without 0204 everything fails CLOSED — an empty directory, a hidden store, no selling; finishing still works', async () => {
  const raw = seed({ through: '0203', approved: true });
  assert.equal(hasColumn(raw, 'community_merchants', 'approved_at'), false);
  const dir = await get(visitorApp(raw), '/api/community/merchants');
  assert.equal(dir.status, 200);
  const body = await json(dir);
  assert.deepEqual(body.merchants, []);
  assert.equal(body.total, 0);
  assert.deepEqual((await json(await get(visitorApp(raw), '/api/community/products'))).products, []);
  assert.equal(await code(await get(visitorApp(raw), '/api/storefront/ali3d')), 'STORE_UNAVAILABLE');
  // A post still reads; its author is simply not marked as a merchant.
  const posts = (await json(await get(visitorApp(raw), '/api/community/posts'))).posts as Array<{ id: string; author: { username: string | null }; store: unknown }>;
  const po1 = posts.find((p) => p.id === 'po1');
  assert.ok(po1, 'the community still reads');
  assert.equal(po1!.author.username, null);
  assert.equal(po1!.store, null);
  // Nothing new is sold or promised…
  assert.equal(await code(await post(merchantApp(raw), '/api/merchant/products', { name: 'x' })), 'MERCHANT_NOT_APPROVED');
  assert.deepEqual(await loadCandidates(asD1(raw)), []);
  // …and the merchant still finishes their work.
  assert.equal((await post(merchantApp(raw), '/api/merchant/orders/od1/status', { status: 'confirmed' })).status, 200);
});

test('withApprovalSchema retries only a missing column: the second try names no column and reads as closed', async () => {
  const raw = dbThrough('0203');
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u','U','u@x.co','h','customer'); INSERT INTO community_merchants (id,user_id,name) VALUES ('m','u','M')");
  const db = asD1(raw);
  const tries: boolean[] = [];
  const n = await withApprovalSchema(async (schema) => {
    tries.push(schema);
    return (await db.prepare(`SELECT COUNT(*) AS n FROM community_merchants m WHERE ${merchantPublicSql('m', schema)}`).first<{ n: number }>())!.n;
  });
  assert.deepEqual(tries, [true, false]);
  assert.equal(n, 0);
  await assert.rejects(withApprovalSchema(async () => { throw new Error('D1_ERROR: something else'); }), /something else/, 'any other error is not swallowed');
});

// ============================================================ the guard test

/** Every worker source file. */
function workerFiles(dir = join(ROOT, 'worker')): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...workerFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('GUARD: no raw `<> \'suspended\'` / `!= \'suspended\'` SQL deny-list outside the visibility helpers', () => {
  const HELPERS = new Set(['worker/lib/merchantApproval.ts']);
  const offenders: string[] = [];
  for (const file of workerFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (HELPERS.has(rel)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/(<>|!=)\s*'suspended'/.test(line) || /NOT\s+IN\s*\([^)]*'suspended'/i.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'a public surface asks merchantPublicSql / storePublicSql (or the sanction helpers), never its own copy');
});
