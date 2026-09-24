/**
 * STORE REVIEWS AND WHAT A STOREFRONT SAYS ABOUT A SHOP — wave 1, W1-C.
 *
 *   audit 04 B11 / audit 02 B17  the owner reviewed their own store: 201, 5★, +10
 *   audit 04 #15                 public reviews printed the buyer's full name
 *   audit 04 #16                 editing 5★ → 1★ kept the +10 reputation
 *   audit 04 #17                 `images` stored any string: 200 KB, trackers, javascript:
 *   audit 04 #20                 the exact sold count was public
 *   audit 04 #21                 every product GET was a view — refresh loops, the owner, bots
 *   audit 04 #24                 a badge earned by completed orders never appeared
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshDb, asD1, stubApp, post, get, send, json, row, all, count, pending, type StubUser,
} from './fixtures/app';
import { communityReviewRoutes, refreshStaleMerchantBadges } from '../worker/routes/merchantReviews';
import { storefrontRoutes } from '../worker/routes/storefront';
import { storefrontEventRoutes } from '../worker/routes/storefrontEvents';

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };

const ORDER_COLS = `(id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)`;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role) VALUES
      ('buyer','Ahmed Kareem','ahmedk','buyer@x.co','h','customer'),
      ('owner','Ali Hassan','ali','owner@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,sold_count,view_count)
      VALUES ('cp1','m1','s1','ali3d-widget','Widget','active','active',1000,237,0);
    INSERT INTO orders ${ORDER_COLS} VALUES
      ('od_buyer','buyer','delivered',1000,'m1','s1','merchant','store_product','{}','d','{}','wallet',1000,1500,0),
      ('od_self','owner','delivered',1000,'m1','s1','merchant','store_product','{}','d','{}','wallet',1000,1500,0);
  `);
  return raw;
}

const reviews = (raw: ReturnType<typeof freshDb>, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/community-reviews', communityReviewRoutes));
const storefront = (raw: ReturnType<typeof freshDb>, user: StubUser | null = null) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/storefront/events', storefrontEventRoutes);
    a.route('/api/storefront', storefrontRoutes);
  });

test('B11: the store owner cannot review their own store — refused with SELF_REVIEW, and nothing moves', async () => {
  const raw = seed();
  const res = await post(reviews(raw, OWNER), '/api/community-reviews', { order_id: 'od_self', rating: 5, body: 'best shop' });
  assert.equal(res.status, 403);
  assert.equal((await json(res)).code, 'SELF_REVIEW');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_reviews'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_reputation_events'), 0, 'no +10 farmed');
  assert.equal(row<{ rating_count: number }>(raw, "SELECT rating_count FROM community_merchants WHERE id = 'm1'")!.rating_count, 0);
  // …and their own order is not offered to them as reviewable.
  const eligible = await json(await get(reviews(raw, OWNER), '/api/community-reviews/eligible'));
  assert.deepEqual(eligible.eligible, []);
  await Promise.allSettled(pending.splice(0));
});

test('a real customer still reviews — the guard is about ownership, not about reviews', async () => {
  const raw = seed();
  const res = await post(reviews(raw, BUYER), '/api/community-reviews', { order_id: 'od_buyer', rating: 5, body: 'great' });
  assert.equal(res.status, 201);
  await Promise.allSettled(pending.splice(0));
});

test('#17: review pictures are the reviewer\'s own uploads or nothing', async () => {
  const raw = seed();
  const huge = 'x'.repeat(200_000);
  const res = await post(reviews(raw, BUYER), '/api/community-reviews', {
    order_id: 'od_buyer',
    rating: 4,
    images: [
      'https://tracker.example/pixel.gif?who=viewer',
      'javascript:alert(1)',
      huge,
      'merchants/owner/public/aaaa1111.webp', // somebody else's upload
      '/files/merchants/buyer/public/bbbb2222.webp', // the reviewer's own
    ],
  });
  assert.equal(res.status, 201);
  const { review_id } = await json(res);
  const images = JSON.parse(row<{ images: string }>(raw, 'SELECT images FROM merchant_reviews WHERE id = ?', review_id)!.images);
  assert.deepEqual(images, ['/files/merchants/buyer/public/bbbb2222.webp']);
  await Promise.allSettled(pending.splice(0));
});

test('#16: editing a review appends the reputation DIFFERENCE — 5★ → 1★ is +10 then −20', async () => {
  const raw = seed();
  const r = reviews(raw, BUYER);
  const { review_id } = await json(await post(r, '/api/community-reviews', { order_id: 'od_buyer', rating: 5, body: 'great' }));
  const edit = await send(r, 'PATCH', `/api/community-reviews/${review_id}`, { rating: 1, body: 'it broke' });
  assert.equal(edit.status, 200);
  const events = all<{ kind: string; points: number }>(
    raw, 'SELECT kind, points FROM merchant_reputation_events WHERE review_id = ? ORDER BY rowid', review_id
  );
  assert.deepEqual(events, [
    { kind: 'review_received', points: 10 },
    { kind: 'review_edited', points: -20 },
  ]);
  assert.equal(events.reduce((n, e) => n + e.points, 0), (1 - 3) * 5, 'the log sums to what a 1★ review is worth');
  // Editing the text alone moves no points.
  await send(r, 'PATCH', `/api/community-reviews/${review_id}`, { rating: 1, body: 'still broke' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_reputation_events WHERE review_id = ?', review_id), 2);
  await Promise.allSettled(pending.splice(0));
});

test('#15: a public store review names the buyer the way a platform review does — «Ahmed K.»', async () => {
  const raw = seed();
  await post(reviews(raw, BUYER), '/api/community-reviews', { order_id: 'od_buyer', rating: 5, body: 'great' });
  const res = await get(storefront(raw), '/api/storefront/ali3d/reviews');
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.reviews[0].customer_name, 'Ahmed K.');
  assert.ok(!text.includes('Kareem'), 'the full name never leaves the server');
  await Promise.allSettled(pending.splice(0));
});

test('#20: the storefront says «+200», never 237 — a rounded-down tier, and no exact count', async () => {
  const raw = seed();
  const list = await json(await get(storefront(raw), '/api/storefront/ali3d/products'));
  assert.equal(list.products[0].sales_tier, 200);
  assert.equal('sold_count' in list.products[0], false);
  const one = await json(await get(storefront(raw), '/api/storefront/ali3d/products/ali3d-widget'));
  assert.equal(one.product.sales_tier, 200);
  assert.equal('sold_count' in one.product, false);
});

test('#21: a visitor is one view per product per day; the owner and crawlers are none (the beacon, W2-E)', async () => {
  const raw = seed();
  const views = () => row<{ view_count: number }>(raw, "SELECT view_count FROM community_products WHERE id = 'cp1'")!.view_count;
  const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' };
  // Opening the product (the API GET) counts nothing any more: a request is not a visitor.
  for (let i = 0; i < 5; i++) await get(storefront(raw, BUYER), '/api/storefront/ali3d/products/ali3d-widget', UA);
  await Promise.allSettled(pending.splice(0));
  assert.equal(views(), 0, 'a GET is not a view');

  const beacon = (user: StubUser | null, headers: Record<string, string> = UA, visitor = 'anon-visitor-000001') =>
    post(storefront(raw, user), '/api/storefront/events', { event: 'product_view', store: 's1', product: 'cp1', visitor }, headers);
  for (let i = 0; i < 5; i++) assert.equal((await beacon(BUYER)).status, 204);
  assert.equal(views(), 1, 'five reloads are one visitor');

  await beacon(OWNER);
  await beacon(null, { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
  assert.equal(views(), 1, 'the owner checking their own page and a crawler are not views');

  // A second, anonymous visitor is a second view.
  await beacon(null, { ...UA, 'CF-Connecting-IP': '9.9.9.9' }, 'anon-visitor-000002');
  assert.equal(views(), 2);
});

test('#24: a badge earned by completed orders is written by the scheduled sweep, override still wins', async () => {
  const raw = seed();
  // Crossed the «trusted» line (10 done, 5 ratings ≥ 4.00) through a
  // completion, with no review event to recompute it.
  raw.exec(`UPDATE community_merchants SET completed_orders = 10, rating_count = 5, rating_avg_x100 = 450, badge = 'new' WHERE id = 'm1'`);
  raw.exec(`INSERT INTO users (id,name,email,password_hash) VALUES ('u2','Z','z@x.co','h');
            INSERT INTO community_merchants (id,user_id,name,badge,badge_override,completed_orders) VALUES ('m2','u2','Pinned','new','elite',0);`);
  const fixed = await refreshStaleMerchantBadges(asD1(raw));
  assert.equal(row<{ badge: string }>(raw, "SELECT badge FROM community_merchants WHERE id = 'm1'")!.badge, 'trusted');
  assert.equal(row<{ badge: string }>(raw, "SELECT badge FROM community_merchants WHERE id = 'm2'")!.badge, 'elite', 'an admin override wins');
  assert.equal(fixed, 2);
  assert.equal(await refreshStaleMerchantBadges(asD1(raw)), 0, 'a second run finds nothing stale');
});

test('#24: the sweep is registered in the scheduled jobs', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const jobs = readFileSync(join(ROOT, 'worker/lib/jobs.ts'), 'utf8');
  assert.match(jobs, /step\('merchant_badges', async \(\) => \{ await refreshStaleMerchantBadges\(env\.DB\); \}\)/);
});
