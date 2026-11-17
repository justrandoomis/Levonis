/**
 * COMMUNITY DEMO DATA (worker/lib/communityDemo.ts, the admin card
 * «بيانات تجريبية»), against the real routes and every migration.
 *
 * Pinned here: only the owner or a full admin may seed, read or remove it;
 * the seed is refused while the community is open, and the community cannot
 * be opened while demo rows exist; one press writes the whole fixed set and a
 * second writes nothing; every demo row's id carries the `demo_` prefix and
 * nothing touching money is written; a demo account cannot be signed in to
 * or mailed; the removal deletes exactly the demo rows and the interactions
 * real accounts made with them, and leaves a real post, request, offer, user
 * and their counters exactly as they were; no demo row reaches the sitemap,
 * the price feed, the storefront, the public API or the matcher; the badge
 * and the admin card speak three languages.
 *
 * Run: npx tsx --test tests/communityDemo.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { APEX, approveMerchants, asD1, ctx, freshDb, get, json, post, put, stubApp, type StubUser } from './fixtures/app';
import { fetchPublished } from './fixtures/autoPublish';
import { ROOT } from './fixtures/d1';
import worker from '../worker/index';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { authRoutes } from '../worker/routes/auth';
import { chatRoutes } from '../worker/routes/chats';
import { DEMO_TABLES, demoId, demoSeedStatements, expectedDemoCounts } from '../worker/lib/communityDemo';
import { createSession } from '../worker/lib/session';
import { emailAllowsRecipient } from '../worker/lib/emailSend';
import { loadCandidates, matchRequest } from '../worker/lib/printMatchingStore';
import { HttpError } from '../worker/lib/http';
import type { AppContext } from '../worker/lib/types';
import { isDemoId } from '../packages/contracts/src/demoData';

const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const ASSISTANT = { id: 'asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' } as StubUser;
const CUSTOMER: StubUser = { id: 'rcu', role: 'customer', email: 'rcu@x.co' };

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,creator_public) VALUES
      ('boss','Owner','boss@x.co','h','admin','boss',0),
      ('asst','Helper','asst@x.co','h','admin','asst',0),
      ('rmk','Real Maker','rmk@x.co','h','customer','realmaker',1),
      ('rcu','Real Customer','rcu@x.co','h','customer','realcust',0);
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'asst';
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','rmk','Real Shop');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','rmk','realshop','Real Shop');
    INSERT INTO community_posts (id,author_id,kind,title,state,visibility,published_at) VALUES
      ('rp1','rmk','project','A real bracket','published','public','2026-11-01T00:00:00.000Z');
    INSERT INTO community_likes (user_id,post_id) VALUES ('rcu','rp1');
    INSERT INTO community_saves (user_id,post_id) VALUES ('rcu','rp1');
    INSERT INTO community_comments (id,post_id,author_id,body) VALUES ('rc1','rp1','rcu','Nice one');
    INSERT INTO user_follows (follower_id,user_id) VALUES ('rcu','rmk');
    INSERT INTO follows (user_id,merchant_id) VALUES ('rcu','m1');
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,expires_at) VALUES
      ('rr1','rcu','A real request','Print me a hook','receiving_offers','open','public','2099-01-01T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('ro1','rr1','m1','s1',20000,'pending');
    UPDATE community_requests SET offer_count = 1 WHERE id = 'rr1';
  `);
  approveMerchants(raw);
  return raw;
}

const mount = (a: Hono<AppContext>) => {
  a.route('/api/admin/community', adminCommunityRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
  a.route('/api/community', communitySocialRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/auth', authRoutes);
  a.route('/api/chats', chatRoutes);
};
const as = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, mount as never);
const n = (raw: DatabaseSync, sql: string, ...args: unknown[]) => Number((raw.prepare(sql).get(...(args as never[])) as { n: number }).n);
const openGate = (raw: DatabaseSync) =>
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true,"allowed_user_ids":[]}')`);

/** Everything about the real rows a removal must leave exactly as it found them. */
function realSnapshot(raw: DatabaseSync) {
  return {
    post: raw.prepare("SELECT like_count, comment_count, save_count, view_count, state FROM community_posts WHERE id = 'rp1'").get(),
    maker: raw.prepare("SELECT follower_count, creator_public FROM users WHERE id = 'rmk'").get(),
    customer: raw.prepare("SELECT follower_count FROM users WHERE id = 'rcu'").get(),
    request: raw.prepare("SELECT offer_count, state FROM community_requests WHERE id = 'rr1'").get(),
    offer: raw.prepare("SELECT state, price_iqd FROM community_offers WHERE id = 'ro1'").get(),
    users: n(raw, "SELECT COUNT(*) AS n FROM users WHERE substr(id,1,5) <> 'demo_'"),
    storeFollows: n(raw, "SELECT COUNT(*) AS n FROM follows WHERE merchant_id = 'm1'"),
    comments: n(raw, "SELECT COUNT(*) AS n FROM community_comments WHERE post_id = 'rp1'"),
  };
}

const seedDemo = (raw: DatabaseSync) => post(as(raw, OWNER), '/api/admin/community/demo/seed', {});

// ------------------------------------------------------------------ scope

test('only the owner or a full admin: an assistant admin and a customer are refused all three doors', async () => {
  const raw = seed();
  for (const [method, path] of [['GET', '/api/admin/community/demo'], ['POST', '/api/admin/community/demo/seed'], ['POST', '/api/admin/community/demo/remove']] as const) {
    const res = method === 'GET' ? await get(as(raw, ASSISTANT), path) : await post(as(raw, ASSISTANT), path, {});
    assert.equal(res.status, 403, `${path} for an assistant`);
    assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED');
    const cust = method === 'GET' ? await get(as(raw, CUSTOMER), path) : await post(as(raw, CUSTOMER), path, {});
    assert.ok(cust.status === 401 || cust.status === 403, `${path} for a customer: ${cust.status}`);
  }
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM users WHERE substr(id,1,5) = 'demo_'"), 0);
});

test('the seed is refused while the community is open to the public, and writes nothing', async () => {
  const raw = seed();
  openGate(raw);
  const res = await seedDemo(raw);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'COMMUNITY_OPEN');
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM users WHERE substr(id,1,5) = 'demo_'"), 0);
  const status = await json(await get(as(raw, OWNER), '/api/admin/community/demo'));
  assert.equal(status.community_open, true);
  assert.equal(status.present, false);
});

// ------------------------------------------------------------------ seeding

test('one press writes the whole fixed set, a second press writes nothing, and nothing touching money is written', async () => {
  const raw = seed();
  const before = realSnapshot(raw);
  const money = () => ({
    products: n(raw, 'SELECT COUNT(*) AS n FROM community_products'),
    orders: n(raw, 'SELECT COUNT(*) AS n FROM community_orders') + n(raw, 'SELECT COUNT(*) AS n FROM orders'),
    escrows: n(raw, 'SELECT COUNT(*) AS n FROM community_escrows'),
    wallet: n(raw, 'SELECT COUNT(*) AS n FROM wallet_transactions'),
    ledger: n(raw, 'SELECT COUNT(*) AS n FROM merchant_ledger_entries'),
    chats: n(raw, 'SELECT COUNT(*) AS n FROM chats'),
    notices: n(raw, 'SELECT COUNT(*) AS n FROM user_notifications'),
    outbox: n(raw, 'SELECT COUNT(*) AS n FROM outbox'),
    sessions: n(raw, 'SELECT COUNT(*) AS n FROM sessions'),
  });
  const quiet = money();

  const res = await seedDemo(raw);
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  const body = await json(res);
  assert.equal(body.created, true);
  assert.deepEqual(body.counts, expectedDemoCounts());
  const expected = expectedDemoCounts();
  assert.equal(expected.users, 10);
  assert.equal(expected.merchant_stores, 3);
  assert.equal(expected.community_posts, 15);
  assert.equal(expected.community_requests, 6);
  assert.ok(expected.community_offers >= 4 && expected.community_likes > 10 && expected.community_comments >= 10);

  // Every id-bearing row is demo-prefixed; every join row names a demo row.
  for (const t of ['users', 'community_merchants', 'merchant_stores', 'merchant_printers', 'community_posts', 'community_comments', 'community_requests', 'community_offers']) {
    assert.equal(n(raw, `SELECT COUNT(*) AS n FROM ${t} WHERE substr(id,1,5) = 'demo_'`), (expected as Record<string, number>)[t], t);
  }
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM community_likes WHERE substr(user_id,1,5) = 'demo_' AND substr(post_id,1,5) <> 'demo_'"), 0, 'demo users like demo posts only');
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM user_follows WHERE substr(follower_id,1,5) = 'demo_' AND substr(user_id,1,5) <> 'demo_'"), 0);
  assert.deepEqual(money(), quiet, 'no product, order, escrow, wallet, ledger, chat, notification, outbox or session');
  assert.deepEqual(realSnapshot(raw), before, 'the seed moves no real counter');

  // Offers: pending only, a fee on some and pickup on others; the board's count matches.
  const offers = raw.prepare("SELECT state, delivery_fee_iqd, delivery_method FROM community_offers WHERE substr(id,1,5) = 'demo_'").all() as Array<{ state: string; delivery_fee_iqd: number; delivery_method: string }>;
  assert.ok(offers.every((o) => o.state === 'pending'));
  assert.ok(offers.some((o) => o.delivery_fee_iqd > 0) && offers.some((o) => o.delivery_method === 'pickup'));
  assert.equal(n(raw, `SELECT COUNT(*) AS n FROM community_requests r WHERE substr(r.id,1,5) = 'demo_'
                        AND r.offer_count <> (SELECT COUNT(*) FROM community_offers o WHERE o.request_id = r.id)`), 0);
  // Counters the triggers keep agree with the rows.
  assert.equal(n(raw, `SELECT COUNT(*) AS n FROM community_posts p WHERE substr(p.id,1,5) = 'demo_'
                        AND p.like_count <> (SELECT COUNT(*) FROM community_likes l WHERE l.post_id = p.id)`), 0);

  const audit = raw.prepare("SELECT actor_id FROM audit_log WHERE action = 'community.demo_seeded'").all() as Array<{ actor_id: string }>;
  assert.deepEqual(audit.map((a) => a.actor_id), ['boss']);

  // A second press: already present, nothing written, nothing audited.
  const again = await seedDemo(raw);
  assert.equal(again.status, 200);
  const second = await json(again);
  assert.equal(second.already_present, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.counts, expected);
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.demo_seeded'"), 1);

  const status = await json(await get(as(raw, OWNER), '/api/admin/community/demo'));
  assert.equal(status.present, true);
  assert.deepEqual(Object.keys(status.counts), [...DEMO_TABLES]);
});

test('the community cannot be opened while demo rows exist; once removed it can', async () => {
  const raw = seed();
  await seedDemo(raw);
  const refused = await put(as(raw, OWNER), '/api/admin/community/gate', { open: true, allowed_user_ids: [] });
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'COMMUNITY_DEMO_PRESENT');
  // Closing (or editing the list while closed) is never refused.
  assert.equal((await put(as(raw, OWNER), '/api/admin/community/gate', { open: false, allowed_user_ids: ['rcu'] })).status, 200);
  assert.equal((await post(as(raw, OWNER), '/api/admin/community/demo/remove', {})).status, 200);
  assert.equal((await put(as(raw, OWNER), '/api/admin/community/gate', { open: true, allowed_user_ids: [] })).status, 200);
});

// ------------------------------------------------------------------ the accounts

test('a demo account cannot be signed in to, by any door, and is never mailed', async () => {
  const raw = seed();
  await seedDemo(raw);
  const users = raw.prepare("SELECT id, email, password_hash, google_sub, phone_e164, username FROM users WHERE substr(id,1,5) = 'demo_'").all() as Array<Record<string, string | null>>;
  assert.equal(users.length, 10);
  for (const u of users) {
    assert.equal(u.password_hash, null);
    assert.equal(u.google_sub, null);
    assert.equal(u.phone_e164, null);
    assert.match(String(u.email), /^demo\+\d+@demo\.levonis\.invalid$/);
    assert.equal(emailAllowsRecipient({} as never, String(u.email)), false);
  }
  // Sign-in by email and by username with any password: refused, no session.
  for (const identifier of [String(users[0].email), String(users[0].username)]) {
    const res = await post(as(raw, null), '/api/auth/login', { identifier, password: 'anything-at-all' });
    assert.ok(res.status >= 400, `login as ${identifier}: ${res.status}`);
  }
  assert.equal(n(raw, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  // And the session door itself refuses a demo id, whatever opened it.
  const app = new Hono<AppContext>();
  app.get('/x', async (c) => {
    c.env = { DB: asD1(raw) } as never;
    await createSession(c, String(users[0].id));
    return c.text('opened');
  });
  app.onError((err, c) => c.json({ code: err instanceof HttpError ? err.code : 'x' }, 403));
  const res = await app.request('/x');
  assert.equal((await res.json() as { code: string }).code, 'DEMO_ACCOUNT');
  assert.equal(n(raw, 'SELECT COUNT(*) AS n FROM sessions'), 0);
  assert.equal(emailAllowsRecipient({} as never, 'someone@example.com'), true, 'a real address is unchanged');
});

// ------------------------------------------------------------------ inside the wall

test('the demo set fills the closed community the admin walks through', async () => {
  const raw = seed();
  await seedDemo(raw);
  const admin = as(raw, OWNER);
  const posts = await json(await get(admin, '/api/community/posts?limit=48'));
  const ids = (posts.posts as Array<{ id: string }>).map((p) => p.id);
  assert.equal(ids.filter(isDemoId).length, 15, JSON.stringify(posts).slice(0, 300));
  assert.ok(ids.includes('rp1'));
  const creator = await get(admin, '/api/community/creators/demo_noor_prints');
  assert.equal(creator.status, 200);
  const c = (await json(creator)).creator;
  assert.ok(c.store, 'the maker page shows the demo workshop');
  assert.ok(Number(c.stats.followers) > 0);
  const merchants = await json(await get(admin, '/api/community/merchants'));
  assert.equal((merchants.merchants as Array<{ id: string }>).filter((m) => isDemoId(m.id)).length, 3);
  const store = await get(admin, `/api/community/store/${demoId('mch', 1)}`);
  assert.equal(store.status, 200);
  assert.ok((await json(store)).workshop, 'the workshop facts read from the demo printers');
  const board = await json(await get(admin, '/api/marketplace/requests?limit=24'));
  assert.equal((board.requests as Array<{ id: string }>).filter((r) => isDemoId(r.id)).length, 6);
  const adminReq = await json(await get(admin, `/api/admin/community/requests/${demoId('req', 1)}`));
  assert.equal((adminReq.offers as unknown[]).length, 2, 'the owner sees the demo offers as admin');
  // A guest outside the list still meets the wall.
  assert.equal((await get(as(raw, CUSTOMER), '/api/community/posts')).status, 503);
});

// ------------------------------------------------------------------ removal

test('removal deletes exactly the demo rows and the interactions with them, and leaves every real row and counter as it was', async () => {
  const raw = seed();
  const before = realSnapshot(raw);
  await seedDemo(raw);
  // A real tester plays with the demo content…
  const dp = demoId('prj', 1);
  raw.exec(`
    INSERT INTO community_likes (user_id,post_id) VALUES ('rcu','${dp}');
    INSERT INTO community_saves (user_id,post_id) VALUES ('rcu','${dp}');
    INSERT INTO community_comments (id,post_id,author_id,body) VALUES ('rc2','${dp}','rcu','Testing');
    INSERT INTO user_follows (follower_id,user_id) VALUES ('rcu','${demoId('usr', 1)}');
    INSERT INTO follows (user_id,merchant_id) VALUES ('rcu','${demoId('mch', 2)}');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('ro2','${demoId('req', 5)}','m1','s1',30000,'pending');
    INSERT INTO user_notifications (id,user_id,kind,title_ar,title_en,link,entity_type,entity_id) VALUES
      ('ntf_x','${demoId('usr', 1)}','like','a','b','/x','post','${dp}');
  `);
  // …and a demo workshop's offer on a REAL request (the seed never does it).
  raw.exec(`INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('${demoId('off', 99)}','rr1','${demoId('mch', 3)}','${demoId('str', 3)}',15000,'pending');
            UPDATE community_requests SET offer_count = 2 WHERE id = 'rr1';`);

  const res = await post(as(raw, OWNER), '/api/admin/community/demo/remove', {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const body = await json(res);
  const removed = body.removed as Record<string, number>;
  const expected = expectedDemoCounts();
  assert.equal(removed.users, expected.users);
  assert.equal(removed.community_posts, expected.community_posts);
  assert.equal(removed.community_requests, expected.community_requests);
  assert.equal(removed.community_merchants, 3);
  assert.equal(removed.merchant_stores, 3);
  assert.equal(removed.community_likes, expected.community_likes + 1, 'the real tester\'s like went with the demo post');
  assert.equal(removed.community_comments, expected.community_comments + 1);
  assert.equal(removed.user_follows, expected.user_follows + 1);
  assert.equal(removed.follows, expected.follows + 1);
  assert.equal(removed.community_offers, expected.community_offers + 2);
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE id = 'ntf_x'"), 0, 'the bell of a demo account goes with it');
  assert.equal(body.total, Object.values(removed).reduce((a, b) => a + b, 0));

  // Nothing demo is left, anywhere it could be.
  const status = await json(await get(as(raw, OWNER), '/api/admin/community/demo'));
  assert.equal(status.total, 0);
  assert.equal(status.present, false);
  // Every real row and every counter is as it was before the seed.
  assert.deepEqual(realSnapshot(raw), before);
  assert.ok(raw.prepare("SELECT 1 FROM community_posts WHERE id = 'rp1'").get());
  assert.ok(raw.prepare("SELECT 1 FROM community_requests WHERE id = 'rr1'").get());
  assert.ok(raw.prepare("SELECT 1 FROM users WHERE id = 'rcu'").get());
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.demo_removed'"), 1);

  // A second removal is a no-op, and a seed after it works again.
  const again = await json(await post(as(raw, OWNER), '/api/admin/community/demo/remove', {}));
  assert.equal(again.total, 0);
  assert.equal((await seedDemo(raw)).status, 201);
});

test('a trade record naming a demo row stops the removal, which then deletes nothing', async () => {
  const raw = seed();
  await seedDemo(raw);
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES ('wt1','${demoId('usr', 7)}','deposit','USD',100,'approved','x')`);
  const res = await post(as(raw, OWNER), '/api/admin/community/demo/remove', {});
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.code, 'DEMO_REMOVE_BLOCKED');
  assert.equal(body.details.blockers.wallet_transactions, 1);
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM users WHERE substr(id,1,5) = 'demo_'"), 10);
});

test('a direct chat a real tester opened with a demo maker goes whole with the removal', async () => {
  const raw = seed();
  await seedDemo(raw);
  const tester = as(raw, CUSTOMER);
  const opened = await json(await post(tester, '/api/chats/open', { userId: demoId('usr', 1) }));
  assert.ok(opened.chatId, JSON.stringify(opened));
  const sent = await post(tester, `/api/chats/${opened.chatId}/messages`, { body: 'Hello maker', client_id: 'demo-chat-00001' });
  assert.ok(sent.status < 300, `send: ${sent.status}`);
  assert.equal(n(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?', opened.chatId), 1);
  assert.equal(((await json(await get(tester, '/api/chats'))).chats as unknown[]).length, 1);

  const res = await post(as(raw, OWNER), '/api/admin/community/demo/remove', {});
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const removed = (await json(res)).removed as Record<string, number>;
  assert.equal(removed.chats, 1);
  assert.equal(removed.chat_messages, 1);
  for (const t of ['chats WHERE id = ?', 'chat_participants WHERE chat_id = ?', 'chat_messages WHERE chat_id = ?']) {
    assert.equal(n(raw, `SELECT COUNT(*) AS n FROM ${t}`, opened.chatId), 0, t);
  }
  assert.deepEqual((await json(await get(tester, '/api/chats'))).chats, []);
});

test('inside the community a demo shop links to its in-site page, which answers by merchant id, store id and slug', async () => {
  const raw = seed();
  await seedDemo(raw);
  const admin = stubApp(asD1(raw), OWNER, mount as never, { env: { STORE_ROOT_DOMAIN: APEX } });
  const merchants = (await json(await get(admin, '/api/community/merchants'))).merchants as Array<{ id: string; store_url: string | null }>;
  const shop = merchants.find((m) => m.id === demoId('mch', 1))!;
  assert.equal(shop.store_url, `/community/store/${demoId('str', 1)}`, 'never the subdomain the storefront refuses');
  assert.match(String(merchants.find((m) => m.id === 'm1')?.store_url), /^https:\/\/realshop\./, 'a real shop keeps its own address');
  const posts = (await json(await get(admin, '/api/community/posts?limit=48'))).posts as Array<{ id: string; store: { url: string } | null }>;
  assert.equal(posts.find((p) => p.id === demoId('prj', 1))?.store?.url, `/community/store/${demoId('str', 1)}`);
  for (const ref of [demoId('mch', 1), demoId('str', 1), 'demo-noor-prints']) {
    const page = await get(admin, `/api/community/store/${ref}`);
    assert.equal(page.status, 200, ref);
    assert.equal((await json(page)).merchant.id, demoId('mch', 1), ref);
  }
  // A real shop is still found by its merchant id only on this route, as before.
  assert.equal((await get(admin, '/api/community/store/realshop')).status, 404);
});

test('the seed batch writes nothing if the gate opened after the route read it', async () => {
  const raw = seed();
  openGate(raw);
  const db = asD1(raw);
  await assert.rejects(db.batch(demoSeedStatements(db)), /NOT NULL/);
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM users WHERE substr(id,1,5) = 'demo_'"), 0);
  assert.equal(n(raw, "SELECT COUNT(*) AS n FROM community_posts WHERE substr(id,1,5) = 'demo_'"), 0);
});

test('no money is recorded on a demo merchant or account, and the matcher never loads a demo workshop by id', async () => {
  const raw = seed();
  await seedDemo(raw);
  const owner = as(raw, OWNER);
  for (const path of [`/api/admin/community/merchants/${demoId('mch', 1)}/adjustment`, `/api/admin/community/merchants/${demoId('mch', 1)}/payout`]) {
    const res = await post(owner, path, { amount_iqd: 1000, reason: 'a test', note: 'x', idempotencyKey: 'demo-key-0001' });
    assert.equal(res.status, 409, path);
    assert.equal((await json(res)).code, 'DEMO_NO_MONEY', path);
  }
  assert.equal(n(raw, 'SELECT COUNT(*) AS n FROM merchant_ledger_entries'), 0);
  assert.equal(n(raw, 'SELECT COUNT(*) AS n FROM merchant_payouts'), 0);
  assert.deepEqual(await loadCandidates(asD1(raw) as never, [demoId('mch', 1)]), []);
  assert.equal((await post(owner, '/api/admin/community/demo/remove', {})).status, 200, 'the removal is never blocked by a refused write');
});

// ------------------------------------------------------------------ outside the wall

test('no demo row reaches the sitemap, the price feed, the storefront, the share card, the public API or the matcher', async () => {
  const raw = seed();
  await seedDemo(raw);
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('<html><head></head><body>spa</body></html>', { headers: { 'content-type': 'text/html' } }) },
  };
  const call = (path: string, host = APEX, headers: Record<string, string> = {}) =>
    fetchPublished(worker, new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': '203.0.113.9', ...headers } }), env as never, ctx);
  const demoHost = `demo-noor-prints.${APEX}`;
  const clean = async (res: Response, what: string) => {
    const text = await res.text();
    assert.doesNotMatch(text, /demo_|demo-noor|demo-karwan|demo-basra|ورشة نور|بصرة ميكر|کارگەی کاروان/, `${what} carries demo data`);
    return text;
  };

  await clean(await call('/sitemap.xml'), 'the main sitemap');
  // A store host's sitemap names the host's own paths whatever the host; it names no product of a demo store.
  assert.doesNotMatch(await (await call('/sitemap.xml', demoHost)).text(), /\/p\/|ورشة نور/, 'the demo store\'s sitemap');
  await clean(await call('/api/products/price-feed.csv'), 'the price feed');
  const sf = await call('/api/storefront/demo-noor-prints');
  assert.equal(sf.status, 404, 'the demo storefront by slug');
  await clean(sf, 'the storefront refusal');
  const resolved = await call('/api/storefront/resolve', demoHost);
  await clean(resolved, 'the demo subdomain');
  await clean(await call('/community/store/demo-noor-prints', APEX, { 'user-agent': 'facebookexternalhit/1.1' }), 'the share card');
  await clean(await call('/manifest.webmanifest', demoHost), 'the demo store\'s app manifest');

  // The public API, even in the case the gate forbids: the community open with demo rows in it.
  openGate(raw);
  for (const path of ['/api/public/v1/community/stores', '/api/public/v1/community/requests', `/api/public/v1/community/requests/${demoId('req', 1)}`]) {
    await clean(await call(path), path);
  }
  const apiStore = await call('/api/public/v1/stores/demo-noor-prints');
  assert.equal(apiStore.status, 404);

  // The matcher pairs no real job with a demo workshop, and no demo job with anybody.
  const candidates = await loadCandidates(asD1(raw) as never);
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.every((m) => !isDemoId(m.merchant_id)));
  assert.ok(candidates.some((m) => m.merchant_id === 'm1'), 'the real workshop is still a candidate');
  const outcome = await matchRequest({ DB: asD1(raw) } as never, demoId('req', 1), { notify: true });
  assert.deepEqual(outcome, { considered: 0, eligible: 0, notified: 0 });
});

// ------------------------------------------------------------------ the UI

const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('the «تجريبي» badge is one kit part driven by the id prefix, on every community card', async () => {
  const kit = src('src/components/community/kit/display.tsx');
  assert.match(kit, /export function DemoPill/);
  assert.match(kit, /\bisDemoId\b/);
  for (const f of [
    'src/components/community/feed/PostCard.tsx',
    'src/components/community/projects/ProjectCard.tsx',
    'src/components/community/projects/ProjectGridCard.tsx',
    'src/components/community/directory/StoreDirectoryCard.tsx',
    'src/components/community/directory/MakerDirectoryCard.tsx',
    'src/components/community/hub/StoreCard.tsx',
    'src/components/community/hub/RequestCard.tsx',
    'src/components/community/requests/RequestListCard.tsx',
    'src/components/community/requests/OfferCard.tsx',
    'src/pages/community/Creator.tsx',
  ]) {
    assert.match(src(f), /<DemoPill\b/, `${f} draws the demo badge`);
  }
  // The main-site store page (outside the community kit) falls back to the in-community profile for a refused storefront.
  assert.match(src('src/pages/CommunityStorePage.tsx'), /storefrontRefused \|\| refused\(legacy\)/);
  const { KIT_STRINGS } = await import('../src/components/community/kit/strings');
  assert.equal(KIT_STRINGS.ar.demo, 'تجريبي');
  assert.equal(KIT_STRINGS.en.demo, 'Demo');
  assert.equal(KIT_STRINGS.ckb.demo, 'تاقیکاری');

  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanguageProvider } = await import('../src/LanguageContext');
  const { DemoPill } = await import('../src/components/community/kit/display');
  const draw = (id: string) => renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(DemoPill, { id }) }));
  assert.match(draw(demoId('prj', 1)), /data-demo-badge/);
  assert.equal(draw('prj_abc'), '', 'a real id draws nothing');
});

test('the admin card «بيانات تجريبية» says everything in Arabic, English and Sorani', async () => {
  const card = src('src/components/adminCommunity/AdminCommunity.tsx');
  assert.match(card, /\/api\/admin\/community\/demo/);
  assert.doesNotMatch(card.slice(card.indexOf('DemoDataCard')), /window\.confirm\(/);
  const { DEMO_CARD_STRINGS } = await import('../src/components/adminCommunity/demoStrings');
  const keys = Object.keys(DEMO_CARD_STRINGS.ar).sort();
  assert.deepEqual(Object.keys(DEMO_CARD_STRINGS.en).sort(), keys);
  assert.deepEqual(Object.keys(DEMO_CARD_STRINGS.ckb).sort(), keys);
  assert.equal(DEMO_CARD_STRINGS.ar.title, 'بيانات تجريبية');
  assert.equal(DEMO_CARD_STRINGS.ar.seed, 'إضافة بيانات تجريبية');
  assert.equal(DEMO_CARD_STRINGS.ar.remove, 'حذف كل البيانات التجريبية');
  for (const k of keys) {
    const ar = String((DEMO_CARD_STRINGS.ar as unknown as Record<string, unknown>)[k]);
    const ckb = String((DEMO_CARD_STRINGS.ckb as unknown as Record<string, unknown>)[k]);
    if (typeof (DEMO_CARD_STRINGS.ar as unknown as Record<string, unknown>)[k] === 'string') assert.notEqual(ckb, ar, `ckb.${k} is not the Arabic copied`);
  }
});
