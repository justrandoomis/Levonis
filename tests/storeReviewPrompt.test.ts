/**
 * «قيّم من اشتريت منهم» — THE RATING NOBODY WAS ASKED FOR (review of Levo
 * Community, 2026-09-28).
 *
 * The server has always taken store reviews against a delivered store order or
 * a completed custom order (worker/routes/merchantReviews.ts; its integrity
 * rules are pinned in tests/storeReviewsIntegrity.test.ts). No page asked for
 * one, so every store page said «no reviews yet» however much it sold. Here:
 * the contract the prompt reads — what is waiting, of which kind, that the
 * words are optional, that a sent rating leaves the list — and where the
 * prompt is mounted: /orders for store orders, «تنفيذ طلباتي» for custom work.
 *
 * Run: node --import tsx --test tests/storeReviewPrompt.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, post, get, json, count, type StubUser } from './fixtures/app';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import { keyOf, ofKind, reviewTarget, type EligibleReview } from '../src/components/community/reviews/eligible';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const BUYER: StubUser = { id: 'buyer', role: 'customer', email: 'buyer@x.co' };
const ORDER_COLS = `(id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)`;

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role) VALUES
      ('buyer','Ahmed Kareem','ahmedk','buyer@x.co','h','customer'),
      ('owner','Ali Hassan','ali','owner@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO orders ${ORDER_COLS} VALUES
      ('od_done','buyer','delivered',1000,'m1','s1','merchant','store_product','{}','d','{}','wallet',1000,1500,0),
      ('od_road','buyer','shipped',1000,'m1','s1','merchant','store_product','{}','d','{}','wallet',1000,1500,0);
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility) VALUES
      ('rq1','buyer','t','d','delivered','closed','public'),
      ('rq2','buyer','t','d','delivered','closed','public');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('of1','rq1','m1','s1',5000,'accepted'),
      ('of2','rq2','m1','s1',5000,'accepted');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,merchant_receivable_iqd,completed_at)
      VALUES ('co_done','rq1','of1','buyer','m1','s1','completed',5000,5000,'2026-09-20T10:00:00.000Z'),
             ('co_wait','rq2','of2','buyer','m1','s1','merchant_marked_delivered',5000,5000,NULL);
  `);
  return raw;
}

const app = (raw: ReturnType<typeof freshDb>) => stubApp(asD1(raw), BUYER, (a) => a.route('/api/community-reviews', communityReviewRoutes));

test('what is waiting: the delivered store order and the completed custom work — each named once, by kind', async () => {
  const raw = seed();
  const res = await get(app(raw), '/api/community-reviews/eligible');
  assert.equal(res.status, 200);
  const rows = (await json(res)).eligible as EligibleReview[];
  assert.deepEqual(rows.map(keyOf).sort(), ['co_done', 'od_done'], 'nothing still on the road, nothing awaiting confirmation');
  for (const r of rows) assert.equal(r.merchant_name, 'Ali 3D', 'the card names the shop');
  assert.deepEqual(ofKind(rows, 'store').map(keyOf), ['od_done'], '/orders asks about the store order only');
  assert.deepEqual(ofKind(rows, 'custom').map(keyOf), ['co_done'], '«تنفيذ طلباتي» asks about the custom work only');
});

test('a rating with no words is a rating; once sent it leaves the list, and a second one is a 409', async () => {
  const raw = seed();
  const custom = ofKind((await json(await get(app(raw), '/api/community-reviews/eligible'))).eligible, 'custom')[0];
  // Exactly what the card sends: the stars, the (trimmed, maybe empty) words, the one transaction.
  const sent = await post(app(raw), '/api/community-reviews', { rating: 4, body: '', ...reviewTarget(custom) });
  assert.equal(sent.status, 201);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_reviews WHERE community_order_id = 'co_done' AND rating = 4"), 1);

  const after = (await json(await get(app(raw), '/api/community-reviews/eligible'))).eligible as EligibleReview[];
  assert.deepEqual(after.map(keyOf), ['od_done'], 'the rated work is no longer asked about');

  const again = await post(app(raw), '/api/community-reviews', { rating: 5, body: '', ...reviewTarget(custom) });
  assert.equal(again.status, 409, 'the card treats this as done, not as a failure');

  assert.deepEqual(reviewTarget(after[0]), { order_id: 'od_done' }, 'a store order is named by order_id alone');
  const store = await post(app(raw), '/api/community-reviews', { rating: 5, body: '  great  '.trim(), ...reviewTarget(after[0]) });
  assert.equal(store.status, 201);
});

test('the prompt is mounted where each kind of purchase is followed', () => {
  const prompt = code('src/components/community/reviews/StoreReviews.tsx');
  assert.match(prompt, /api\s*\.get<\{ eligible: EligibleReview\[\] \}>\('\/api\/community-reviews\/eligible'\)/);
  assert.match(prompt, /setRows\(ofKind\(d\.eligible \?\? \[\], kind\)\)/);
  assert.match(prompt, /\.catch\(\(\) => alive && setRows\(\[\]\)\)/, 'an unreadable list offers nothing rather than an error');
  assert.match(prompt, /api\.post\('\/api\/community-reviews', \{ rating, body: body\.trim\(\), images: photos, \.\.\.reviewTarget\(item\) \}\)/);
  assert.match(prompt, /if \(e instanceof ApiError && e\.status === 409\) onDone\(\);/);
  assert.match(prompt, /role="radiogroup"/);
  assert.match(prompt, /role="radio"\s+aria-checked=\{rating === n\}/);
  assert.match(prompt, /disabled=\{!rating \|\| busy\}/, 'no rating, nothing to send');
  assert.doesNotMatch(prompt, /24 ساعة|24 hours/, 'no promise of an edit no screen offers');

  assert.match(code('src/pages/Orders.tsx'), /\{filter !== 'returns' && <PendingStoreReviews kind="store" \/>\}/);
  const requests = code('src/pages/Requests.tsx');
  assert.match(requests, /<PendingStoreReviews kind="custom" refreshKey=\{reviewsKey\} \/>/);
  assert.match(
    requests,
    /await communityOrdersApi\.confirm\(action\.order\.id\);\s*setReviewsKey\(\(n\) => n \+ 1\);/,
    'confirming receipt asks for the rating at once — it used to answer review_available: true into the void'
  );
  // The same list said «(held by Levonis)» under work that was paid out or refunded long ago.
  assert.match(requests, /const HELD_STATES = \['funded', 'in_progress', 'merchant_marked_delivered', 'disputed'\];/);
  assert.match(requests, /\{HELD_STATES\.includes\(o\.state\) && \(\s*<> \{loc\('\(محجوز لدى Levonis\)'/);
});
