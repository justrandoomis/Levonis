import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { evaluateReviewQuality, reviewTextCounts, type ReviewQualityMedia } from '../worker/lib/reviewQuality';
import { LEVEL_COMPOSITION, reviewRoutes } from '../worker/routes/reviews';
import { GIFT_SCORE_PARTS } from '../packages/contracts/src/giftScore';
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

/**
 * THE TIER GATE, RESTATED (owner, 2026-11-05; DECISIONS row 301). A review used to
 * need a tier, at least 100 characters and a photo, to enter the queue. The owner's
 * own example is a 5, so a score of at least 1 and no severe abuse signal is the
 * whole gate now, and what the review earned is said by its score. `tier` stays
 * computed, as the old gate computed it, for the rows and screens that read it.
 */
test('the reward queue takes any printer review the team can read, however small; a severe signal, or another product, stays out', () => {
  const small = evaluateReviewQuality({ stars: 1, body: 'Good', media: [], hasEvidence: false, isPrinter: true });
  assert.equal(small.score, 5, 'the stars alone');
  assert.equal(small.tier, null, 'the old gate says no tier');
  assert.equal(small.rewardEligible, true, 'the owner’s «he eran 5»');
  assert.equal(small.textChars, 4);
  assert.equal(small.wordCount, 1);

  const other = evaluateReviewQuality({ stars: 5, body: detailedBody, media: [], hasEvidence: false, isPrinter: false });
  assert.equal(other.rewardEligible, false, 'another product takes its fallback points');

  const severe: ReadonlyArray<[string, { body: string; media?: ReviewQualityMedia[]; previousBodies?: string[]; previousMediaHashes?: string[] }]> = [
    ['duplicate_text', { body: detailedBody, previousBodies: [detailedBody] }],
    ['reused_media', { body: detailedBody, media: [media('old-hash', 'image', 200_000)], previousMediaHashes: ['old-hash'] }],
    // A video too: policy 8.3 says «media», and a reused one is worth up to 18, a whole extra level.
    ['reused_media', { body: detailedBody, media: [media('old-video', 'video', 900_000)], previousMediaHashes: ['old-video'] }],
    ['repetitive_text', { body: 'good good good good good good good good good good good good good good good good good good' }],
    ['padded_text', { body: 'abcabcabcabcabcabcabcabc' }],
  ];
  for (const [signal, input] of severe) {
    const r = evaluateReviewQuality({ stars: 5, media: [], hasEvidence: false, isPrinter: true, ...input });
    assert.ok(r.suspiciousSignals.includes(signal), signal);
    assert.equal(r.rewardEligible, false, signal);
    assert.equal(r.tier, null, signal);
  }
  // A signal that is not severe costs points and does not close the queue.
  const tiny = evaluateReviewQuality({ stars: 5, body: detailedBody, media: [media('small', 'image', 2_000)], hasEvidence: false, isPrinter: true });
  assert.ok(tiny.suspiciousSignals.includes('low_quality_image'));
  assert.equal(tiny.rewardEligible, true);
});

/**
 * THE FIGURES THE ANALYSIS SAYS ALOUD. A reward whose snapshot predates `textChars`
 * is counted again from the review's text (worker/lib/gifts/reviewCode.ts), and the
 * customer reads that number, so it has to be the one the score counted: letters
 * without the spaces, in any language, and an «s» is a letter like any other.
 */
test('the text counts of the analysis are the same figures the score counted, spaces out and every letter in', () => {
  for (const body of [detailedBody, 'sass is so ss', 'الطابعة ممتازة جدا وسهلة الاستخدام', 'چاپکەرەکە زۆر باشە', 'Good', '']) {
    const scored = evaluateReviewQuality({ stars: 5, body, media: [], hasEvidence: false, isPrinter: true });
    assert.deepEqual(reviewTextCounts(body), { chars: scored.textChars, words: scored.wordCount }, body);
  }
  assert.deepEqual(reviewTextCounts('sass is  so ss'), { chars: 10, words: 4 });
  assert.deepEqual(reviewTextCounts('الطابعة ممتازة'), { chars: 13, words: 2 });
});

test('the score’s parts are what the screens say: 42, 27, 18, 8 and 5 make 100', () => {
  const full = evaluateReviewQuality({
    stars: 3,
    body: `${detailedBody} 1, 2, 3.`,
    media: [media('a', 'image', 180_000), media('b', 'image', 210_000), media('c', 'image', 240_000), media('v', 'video', 900_000)],
    hasEvidence: true,
    isPrinter: true,
  });
  assert.deepEqual([full.textQuality, full.imageQuality, full.videoQuality], [GIFT_SCORE_PARTS.text, GIFT_SCORE_PARTS.images, GIFT_SCORE_PARTS.video]);
  assert.equal(GIFT_SCORE_PARTS.text + GIFT_SCORE_PARTS.images + GIFT_SCORE_PARTS.video + GIFT_SCORE_PARTS.story + GIFT_SCORE_PARTS.stars, 100);
  assert.equal(full.score, 100);
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

/**
 * WHAT THE SERVER RECORDED. The customer's own answers no longer carry it: the system's score belongs to the moment
 * the team's code is written (owner's brief, DECISIONS row 301; the integration run read it in POST /api/reviews), so
 * these tests read the columns the queue reads.
 */
const storedQuality = (raw: DatabaseSync, reviewId: string) =>
  JSON.parse((raw.prepare('SELECT quality_summary AS q FROM reviews WHERE id = ?').get(reviewId) as { q: string }).q);
const queuedQuality = (raw: DatabaseSync, reviewId: string) =>
  JSON.parse((raw.prepare('SELECT quality_snapshot AS q FROM review_rewards WHERE review_id = ?').get(reviewId) as { q: string }).q);

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
  assert.equal(queuedQuality(raw, created.review.id).tier, 5);
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

/**
 * ONE FILE IS ONE FILE, THROUGH THE REAL DOORS. Every upload gets a new key, so the
 * digest is the only thing that can say two uploads are the same file. The upload
 * route computed it and handed it to the browser, and the object never carried it:
 * `head.customMetadata.sha256` was empty on every real upload, and `reused_media`
 * and `duplicate_media` could fire only for a test's bucket that made one up. This
 * bucket keeps exactly what it is given, and the keys below are the ones the route answered.
 */
class KeepingBucket {
  readonly objects = new Map<string, { size: number; customMetadata?: Record<string, string>; httpMetadata?: unknown }>();
  async head(key: string) {
    const o = this.objects.get(key);
    return o ? ({ key, size: o.size, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata } as unknown as R2Object) : null;
  }
  async put(key: string, value: Uint8Array, options: { customMetadata?: Record<string, string>; httpMetadata?: unknown } = {}) {
    this.objects.set(key, { size: value.byteLength, customMetadata: options.customMetadata, httpMetadata: options.httpMetadata });
    return { key };
  }
}

function deliveredPrinter(raw: ReturnType<typeof freshDb>, id: string, position: number) {
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('${id}','slug-${id}','Printer ${id}',900000);
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('${id}','test-printers',${position});
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ord_${id}','buyer','delivered','{}','standard','{}','cash',900000,0,1400,900000,0,'2026-10-01T00:00:00.000Z');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,image_snapshot,option_snapshot,shipping_method_id,qty,unit_price_iqd,line_total_iqd)
      VALUES ('oi_${id}','ord_${id}','${id}','Printer','','','standard',1,900000,900000);`);
}

function uploadWorld() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,email,username,role) VALUES ('buyer','buyer@x.co','buyer','customer');
    INSERT INTO catalogs (id,slug,name_ar,is_printer_catalog) VALUES ('test-printers','test-printers','Printers',1);
    INSERT INTO admin_settings (key,value) VALUES ('reviewPointsConfig','{"enabled":true,"points":12}');`);
  deliveredPrinter(raw, 'p_one', 91);
  deliveredPrinter(raw, 'p_two', 92);
  const bucket = new KeepingBucket();
  const app = stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => a.route('/api/reviews', reviewRoutes), { env: { BUCKET: bucket, R2_PRIVATE: bucket } });
  const upload = async (bytes: Uint8Array, name: string, type: string) => {
    const form = new FormData();
    form.set('purpose', 'media');
    form.set('file', new File([bytes as BlobPart], name, { type }));
    const res = await app.request('/api/reviews/uploads', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
    const out = (await res.json()) as { key: string; sha256: string };
    assert.equal(res.status, 200, JSON.stringify(out));
    return out;
  };
  return { raw, bucket, app, upload };
}

const mp4Bytes = (seed: number) => {
  const b = new Uint8Array(900_000);
  b.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  for (let i = 12; i < b.length; i += 97) b[i] = (i + seed) % 251;
  return b;
};
const jpegBytes = (seed: number) => {
  const b = new Uint8Array(180_000);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1], 0);
  for (let i = 12; i < b.length; i += 89) b[i] = (i + seed) % 251;
  return b;
};

test('the same video uploaded again, for another printer, is reused media: it stays out of the queue and takes its fallback points', async () => {
  const { raw, bucket, app, upload } = uploadWorld();
  const first = await upload(mp4Bytes(1), 'v.mp4', 'video/mp4');
  const again = await upload(mp4Bytes(1), 'copy-of-v.mp4', 'video/mp4');
  assert.notEqual(first.key, again.key, 'every upload gets a key of its own');
  assert.equal(first.sha256, again.sha256);
  // The object carries the digest of what the customer sent, and HEAD gives it back.
  assert.equal((await bucket.head(first.key))?.customMetadata?.sha256, first.sha256);

  const a = await json(await post(app, '/api/reviews', { productId: 'p_one', orderId: 'ord_p_one', stars: 4, body: 'A full review of the first printer, its noise and its first layer.', videoKey: first.key }));
  assert.deepEqual(storedQuality(raw, a.review.id).suspiciousSignals, []);
  assert.equal(storedQuality(raw, a.review.id).videoQuality, GIFT_SCORE_PARTS.video);
  assert.equal(a.review.reward.state, 'submitted');

  const b = await json(await post(app, '/api/reviews', { productId: 'p_two', orderId: 'ord_p_two', stars: 4, body: 'Different words about the second one: quiet at night, quick to print.', videoKey: again.key }));
  assert.ok(storedQuality(raw, b.review.id).suspiciousSignals.includes('reused_media'), JSON.stringify(storedQuality(raw, b.review.id).suspiciousSignals));
  assert.equal(storedQuality(raw, b.review.id).rewardEligible, false);
  assert.equal(b.review.reward, null, 'no reward row: the queue never sees it');
  assert.equal(b.review.status, 'published', 'the review stays public');
  assert.equal(b.review.fallback_points_awarded, 24, 'the configured fallback, as policy 7.5 says');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM review_rewards'), 1);
});

test('another video is another video, and editing a review never counts its own video against it', async () => {
  const { raw, app, upload } = uploadWorld();
  const one = await upload(mp4Bytes(1), 'one.mp4', 'video/mp4');
  const two = await upload(mp4Bytes(2), 'two.mp4', 'video/mp4');
  assert.notEqual(one.sha256, two.sha256);
  const a = await json(await post(app, '/api/reviews', { productId: 'p_one', orderId: 'ord_p_one', stars: 4, body: 'A full review of the first printer, its noise and its first layer.', videoKey: one.key }));
  const b = await json(await post(app, '/api/reviews', { productId: 'p_two', orderId: 'ord_p_two', stars: 4, body: 'Different words about the second one: quiet at night, quick to print.', videoKey: two.key }));
  assert.deepEqual(storedQuality(raw, b.review.id).suspiciousSignals, []);
  assert.equal(b.review.reward.state, 'submitted');
  const edited = await app.request(`/api/reviews/${a.review.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ stars: 5, body: 'A fuller review of the first printer, its noise, its first layer and its speed.' }),
  });
  assert.equal(edited.status, 200);
  const after = (await edited.json()) as { review: { reward: { state: string } } };
  assert.equal(after.review.reward.state, 'submitted');
  assert.deepEqual(queuedQuality(raw, a.review.id).suspiciousSignals, []);
});

test('the same photo uploaded twice into one review counts once, however many keys it has: «distinct images», policy 7.4', async () => {
  const { raw, app, upload } = uploadWorld();
  const a = await upload(jpegBytes(1), 'a.jpg', 'image/jpeg');
  const copy = await upload(jpegBytes(1), 'a-copy.jpg', 'image/jpeg');
  const other = await upload(jpegBytes(2), 'b.jpg', 'image/jpeg');
  const res = await json(await post(app, '/api/reviews', { productId: 'p_one', orderId: 'ord_p_one', stars: 4, body: 'A full review of the first printer, its noise and its first layer.', photoKeys: [a.key, copy.key, other.key] }));
  assert.ok(storedQuality(raw, res.review.id).suspiciousSignals.includes('duplicate_media'), JSON.stringify(storedQuality(raw, res.review.id).suspiciousSignals));
  assert.equal(storedQuality(raw, res.review.id).imageCount, 2);
  assert.equal(res.review.reward.state, 'submitted', 'a copy inside one review is not the severe signal');
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
