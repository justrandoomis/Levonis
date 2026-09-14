import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateReviewQuality, type ReviewQualityMedia } from '../worker/lib/reviewQuality';
import { LEVEL_COMPOSITION, reviewRoutes } from '../worker/routes/reviews';
import { sweepAutomaticReviews } from '../worker/lib/reviewAutoSweep';
import { asD1, count, freshDb, get, json, post, row, stubApp } from './fixtures/app';

const detailedBody = [
  'I installed this printer in a small workshop and tested dimensional accuracy, first-layer consistency, noise,',
  'material changes, calibration, networking, and long jobs. The photos show the actual finish and setup from',
  'different angles. Bed adhesion remained consistent, the controls were clear, and maintenance access was practical.',
].join(' ');

const media = (hash: string, kind: 'image' | 'video', bytes: number): ReviewQualityMedia => ({
  key: `reviews/buyer/${hash}.${kind === 'image' ? 'jpg' : 'mp4'}`,
  sha256: hash,
  kind,
  bytes,
  mime: kind === 'image' ? 'image/jpeg' : 'video/mp4',
});

test('quality scoring rewards substance and duplicate media cannot inflate a tier', () => {
  const richMedia = [
    media('image-a', 'image', 180_000),
    media('image-b', 'image', 210_000),
    media('image-c', 'image', 240_000),
    media('video-a', 'video', 900_000),
  ];
  const rich = evaluateReviewQuality({
    stars: 4,
    body: detailedBody,
    media: richMedia,
    hasEvidence: true,
    isPrinter: true,
  });
  assert.equal(rich.tier, 5);
  assert.equal(rich.rewardEligible, true);
  assert.equal(rich.imageCount, 3);
  assert.equal(rich.videoPresent, true);

  const duplicate = evaluateReviewQuality({
    stars: 4,
    body: detailedBody,
    media: [
      media('same-image', 'image', 250_000),
      media('same-image', 'image', 250_000),
      media('same-image', 'image', 250_000),
      media('video-a', 'video', 900_000),
    ],
    hasEvidence: true,
    isPrinter: true,
  });
  assert.equal(duplicate.imageCount, 1);
  assert.ok(duplicate.suspiciousSignals.includes('duplicate_media'));
  assert.notEqual(duplicate.tier, 5);
});

test('the five established gift levels and their contents remain unchanged', () => {
  assert.deepEqual(Object.keys(LEVEL_COMPOSITION), ['1', '2', '3', '4', '5']);
  assert.deepEqual(LEVEL_COMPOSITION, {
    1: ['accessory'],
    2: ['filament'],
    3: ['filament', 'accessory'],
    4: ['nozzle'],
    5: ['nozzle', 'plate'],
  });
});

function seedPurchase(raw: ReturnType<typeof freshDb>, productId = 'p1', deliveredAt = '2026-09-01T00:00:00.000Z') {
  raw.prepare("INSERT INTO users (id,email,username,role) VALUES ('buyer','buyer@x.co','buyer','customer')").run();
  raw.prepare("INSERT INTO users (id,email,username,role) VALUES ('boss','boss@x.co','boss','admin')").run();
  raw.prepare('INSERT INTO products (id,slug,name,price_iqd) VALUES (?,?,?,?)')
    .run(productId, `slug-${productId}`, `Product ${productId}`, 100_000);
  raw.prepare(
    `INSERT INTO orders
       (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,shipping_iqd,points_discount_iqd,wallet_applied_iqd,wallet_applied_usd_cents,
        exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at,created_at,updated_at)
     VALUES ('ord1','buyer','delivered','{}','standard','{}','wallet',100000,0,0,0,0,1300,100000,0,?,?,?)`
  ).run(deliveredAt, deliveredAt, deliveredAt);
  raw.prepare(
    `INSERT INTO order_items
       (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
     VALUES ('oi1','ord1',?,'Product','','','standard',1,100000,100000)`
  ).run(productId);
}

test('a seven-day system review is published, labelled, and never rewarded', async () => {
  const raw = freshDb();
  seedPurchase(raw);
  const report = await sweepAutomaticReviews(asD1(raw), '2026-09-13T00:00:00.000Z');
  assert.deepEqual(report, { scanned: 1, created: 1, skipped: 0 });
  const review = row<{ id: string; source: string; status: string }>(raw, 'SELECT id,source,status FROM reviews');
  assert.equal(review?.source, 'system');
  assert.equal(review?.status, 'published');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM review_rewards'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM points_awards'), 0);

  const app = stubApp(asD1(raw), null, (a) => a.route('/api/reviews', reviewRoutes));
  const response = await get(app, '/api/reviews/product/p1');
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.reviews[0].system_generated, true);
  assert.equal(body.reviews[0].reviewer, 'Levonis');
});

test('manual ordinary review publishes immediately and receives configured double base points', async () => {
  const raw = freshDb();
  seedPurchase(raw);
  raw.prepare("INSERT INTO admin_settings (key,value) VALUES ('reviewPointsConfig','{\"enabled\":true,\"points\":12}')").run();
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/reviews', reviewRoutes);
  });

  const response = await post(app, '/api/reviews', {
    productId: 'p1',
    orderId: 'ord1',
    stars: 4,
    body: 'Useful and valid review, but without media for a gift level.',
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await json(response);
  assert.equal(body.published, true);
  assert.equal(body.review.status, 'published');
  assert.equal(body.review.reward, null);
  assert.equal(body.review.fallback_points_awarded, 24);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM review_rewards'), 0);
  assert.equal(row<{ points: number }>(raw, 'SELECT points FROM points_awards')?.points, 24);
  assert.equal(row<{ amount: number }>(raw, "SELECT amount FROM wallet_transactions WHERE currency='POINT'")?.amount, 24);
});

class ReviewBucket {
  constructor(private readonly heads: Record<string, { size: number; hash: string; type: string }>) {}
  async head(key: string) {
    const value = this.heads[key];
    return value
      ? ({ key, size: value.size, customMetadata: { sha256: value.hash }, httpMetadata: { contentType: value.type } } as unknown as R2Object)
      : null;
  }
}

test('qualified manual review enters reward queue; rejecting reward leaves publication intact', async () => {
  const raw = freshDb();
  seedPurchase(raw);
  raw.prepare("INSERT INTO catalogs (id,slug,name_ar,is_printer_catalog) VALUES ('test-printers','test-printers','Printers',1)").run();
  raw.prepare("INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p1','test-printers',91)").run();
  const heads: Record<string, { size: number; hash: string; type: string }> = {};
  for (const [name, size, type] of [
    ['a.jpg', 180_000, 'image/jpeg'],
    ['b.jpg', 210_000, 'image/jpeg'],
    ['c.jpg', 240_000, 'image/jpeg'],
    ['demo.mp4', 900_000, 'video/mp4'],
  ] as const) heads[`reviews/buyer/${name}`] = { size, hash: name, type };
  const bucket = new ReviewBucket(heads);
  const env = { BUCKET: bucket, R2_PRIVATE: bucket };
  const buyer = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/reviews', reviewRoutes);
  }, { env });

  const response = await post(buyer, '/api/reviews', {
    productId: 'p1',
    orderId: 'ord1',
    stars: 4,
    body: detailedBody,
    photoKeys: ['reviews/buyer/a.jpg', 'reviews/buyer/b.jpg', 'reviews/buyer/c.jpg'],
    videoKey: 'reviews/buyer/demo.mp4',
    instagram: { link: 'https://instagram.com/p/example' },
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const created = await json(response);
  assert.equal(created.review.status, 'published');
  assert.equal(created.review.reward.state, 'submitted');
  assert.equal(created.review.reward.quality.tier, 5);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind='review_reward_pending'"), 1);

  const admin = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => {
    a.route('/api/reviews', reviewRoutes);
  }, { env });
  const rejected = await post(admin, `/api/reviews/admin/${created.review.id}/reward`, {
    action: 'reject',
    reason: 'Evidence does not meet the reward policy after review.',
  });
  assert.equal(rejected.status, 200, JSON.stringify(await rejected.clone().json()));
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM reviews WHERE id = ?', created.review.id)?.status, 'published');
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM review_rewards WHERE review_id = ?', created.review.id)?.state, 'rejected');
});

test('historical rows default safely to user source', () => {
  const raw = freshDb();
  seedPurchase(raw);
  raw.prepare(
    "INSERT INTO reviews (id,user_id,product_id,order_item_id,order_id,stars,body,status) VALUES ('old','buyer','p1','oi1','ord1',4,'Historical review','published')"
  ).run();
  assert.deepEqual(row(raw, "SELECT source,quality_summary,fallback_points_awarded FROM reviews WHERE id='old'"), {
    source: 'user',
    quality_summary: '{}',
    fallback_points_awarded: 0,
  });
});
