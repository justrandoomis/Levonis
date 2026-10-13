/**
 * THE BACKFILL: EVERY PICTURE ALREADY IN R2 GETS ITS SMALL COPIES
 * (worker/lib/imageVariants.ts `sweepImageVariants`, one bounded step of the
 * existing quarter-hour cron — no new cron, no D1, no GitHub workflow, nothing
 * for the owner to do).
 *
 * What these pin: it lists R2 itself — both buckets, every public prefix, the
 * legacy keys and the owner's hand uploads — and skips private keys, non-still
 * pictures and the copy store; a tick's budget (24 cuts, 150 operations, the
 * wall clock); the cursor kept in R2 and resumed; the `done` marker; the pause
 * after five failed cuts in a row; the next pass seven days later; the old
 * store version deleted; ZERO D1 statements; and the quarter-hour branch
 * handing it to `waitUntil` with its own `.catch`.
 *
 * Run: node --import tsx --test tests/imageVariantSweep.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { R2Double, imagesDouble, jpegBytes, pngBytes, webpBytes } from './fixtures/imageDoubles';
import { SWEEP_LIMITS, rungsFor, sweepImageVariants } from '../worker/lib/imageVariants';
import { VARIANT_SWEEP_STATE_KEY } from '../worker/lib/variantKeys';

/** A D1 that counts — and refuses — every statement: the sweep must never prepare one. */
function countingDb() {
  const seen = { statements: 0 };
  const db = new Proxy({}, {
    get(_t, prop) {
      return (..._args: unknown[]) => {
        seen.statements += 1;
        throw new Error(`the image sweep used D1 (${String(prop)})`);
      };
    },
  });
  return { db: db as unknown as D1Database, seen };
}

function world(opts: { images?: ReturnType<typeof imagesDouble> } = {}) {
  const pub = new R2Double();
  const legacy = new R2Double();
  const images = opts.images ?? imagesDouble();
  const { db, seen } = countingDb();
  const env = { DB: db, R2_PUBLIC: pub, BUCKET: legacy, R2_PRIVATE: new R2Double(), IMAGES: images.binding } as never;
  let clock = Date.parse('2026-10-13T12:00:00Z');
  const now = () => clock;
  const advance = (ms: number) => { clock += ms; };
  pub.now = () => new Date(clock);
  legacy.now = () => new Date(clock);
  return { pub, legacy, images, env, seen, now, advance };
}

const avif = (b: R2Double, key: string) => b.keys(`variants/v1/${key}/`).filter((k) => k.endsWith('.avif')).length;

test('one pass: both buckets, every public prefix, only public still pictures, a done marker each — and no D1', async () => {
  const w = world();
  w.pub.seed('products/catalog/gallery/a.webp', webpBytes(1254, 1254));
  w.pub.seed('UiUx/MainPage/Bamabulab.webp', webpBytes(1536, 1024));
  w.pub.seed('merchants/u1/public/cover.jpg', jpegBytes(1200, 800));
  w.pub.seed('users/u1/avatar/me.png', pngBytes(512, 512));
  // Not for copies: private keys, a GIF, a video, the copy store's own state.
  w.pub.seed('receipts/u1/evidence/scan.webp', webpBytes(1000, 1000));
  w.pub.seed('users/u1/private/x.webp', webpBytes(1000, 1000));
  w.pub.seed('products/banner.gif', new Uint8Array(40));
  w.pub.seed('merchants/u1/public/clip.mp4', new Uint8Array(40));
  // Legacy keys, in the old bucket, from before the dedicated buckets existed.
  w.legacy.seed('products/import/old.webp', webpBytes(1600, 1600));
  w.legacy.seed('chat/c1/attachments/p.webp', webpBytes(900, 900));

  const report = await sweepImageVariants(w.env, { now: w.now, limits: { transforms: 100, operations: 500 } });
  assert.equal(report.skipped, null);
  assert.equal(report.pass_done, true);
  assert.equal(w.seen.statements, 0, 'not one D1 statement: the quarter-hour budget is untouched');
  assert.equal(avif(w.pub, 'products/catalog/gallery/a.webp'), rungsFor(1254).length);
  assert.equal(avif(w.pub, 'UiUx/MainPage/Bamabulab.webp'), rungsFor(1536).length, 'the owner\'s hand uploads too');
  assert.equal(avif(w.pub, 'merchants/u1/public/cover.jpg'), rungsFor(1200).length);
  assert.equal(avif(w.pub, 'users/u1/avatar/me.png'), rungsFor(512).length);
  assert.equal(avif(w.pub, 'products/import/old.webp'), rungsFor(1600).length, 'legacy keys, copies stored in the public bucket');
  for (const key of ['receipts/u1/evidence/scan.webp', 'users/u1/private/x.webp', 'products/banner.gif', 'merchants/u1/public/clip.mp4', 'chat/c1/attachments/p.webp']) {
    assert.deepEqual(w.pub.keys(`variants/v1/${key}/`), [], key);
  }
  assert.ok(w.pub.objects.has('variants/v1/products/catalog/gallery/a.webp/done'));
  assert.deepEqual(w.legacy.keys('variants/'), [], 'copies never go to the legacy bucket');
  // Copies carry the original's own policy: a hand-named brand file revalidates.
  assert.equal(w.pub.objects.get('variants/v1/UiUx/MainPage/Bamabulab.webp/w320.avif')!.cacheControl, 'public, max-age=300, must-revalidate');
  assert.equal(w.pub.objects.get('variants/v1/products/catalog/gallery/a.webp/w320.avif')!.cacheControl, 'public, max-age=31536000, immutable');
  const state = JSON.parse(new TextDecoder().decode(w.pub.objects.get(VARIANT_SWEEP_STATE_KEY)!.bytes));
  assert.ok(state.pass_done);
});

test('a tick is bounded — 24 cuts by default — and the next tick resumes from the kept cursor until the pass is done', async () => {
  const w = world();
  for (let i = 0; i < 10; i++) w.pub.seed(`products/catalog/gallery/p${i}.webp`, webpBytes(1254, 1254));
  const first = await sweepImageVariants(w.env, { now: w.now, limits: { pageSize: 3 } });
  assert.equal(first.transforms, SWEEP_LIMITS.transforms);
  assert.ok(first.operations <= SWEEP_LIMITS.operations);
  assert.equal(first.pass_done, false);
  let ticks = 1;
  let report = first;
  while (!report.pass_done && ticks < 20) {
    w.advance(15 * 60 * 1000);
    report = await sweepImageVariants(w.env, { now: w.now, limits: { pageSize: 3 } });
    assert.ok(report.transforms <= SWEEP_LIMITS.transforms, `tick ${ticks}`);
    ticks += 1;
  }
  assert.equal(report.pass_done, true);
  for (let i = 0; i < 10; i++) assert.equal(avif(w.pub, `products/catalog/gallery/p${i}.webp`), 7, `p${i}`);
  assert.equal(w.images.calls.length, 70, 'each copy cut exactly once across the ticks');
  assert.ok(ticks <= 4, `ten 1254 px photos take ${ticks} ticks`);
});

test('the operation budget and the wall clock end a tick, never mid-write', async () => {
  const w = world();
  for (let i = 0; i < 6; i++) w.pub.seed(`products/catalog/gallery/q${i}.webp`, webpBytes(800, 800));
  const ops = await sweepImageVariants(w.env, { now: w.now, limits: { operations: 12, transforms: 100 } });
  assert.ok(ops.operations <= 12, `${ops.operations} operations`);
  assert.equal(ops.pass_done, false);
  // A clock that runs out after the first picture.
  const w2 = world();
  for (let i = 0; i < 4; i++) w2.pub.seed(`products/catalog/gallery/r${i}.webp`, webpBytes(800, 800));
  let calls = 0;
  const slow = () => { calls += 1; return Date.parse('2026-10-13T12:00:00Z') + (calls > 6 ? 60_000 : 0); };
  const timed = await sweepImageVariants(w2.env, { now: slow });
  assert.equal(timed.pass_done, false);
  assert.ok(w2.pub.objects.has(VARIANT_SWEEP_STATE_KEY), 'the cursor is kept for the next tick');
});

test('a picture already marked is skipped for a listing; copies made lazily are not cut again', async () => {
  const w = world();
  w.pub.seed('products/catalog/gallery/done.webp', webpBytes(1254, 1254));
  w.pub.seed('products/catalog/gallery/half.webp', webpBytes(1254, 1254));
  w.pub.seed('variants/v1/products/catalog/gallery/done.webp/done', new Uint8Array(0), { custom: { src: 'products/catalog/gallery/done.webp' } });
  w.pub.seed('variants/v1/products/catalog/gallery/half.webp/w640.avif', new Uint8Array(4));
  await sweepImageVariants(w.env, { now: w.now, limits: { transforms: 100, operations: 500 } });
  assert.ok(!w.pub.ops.includes('get products/catalog/gallery/done.webp'), 'a marked picture is not even read');
  assert.deepEqual(w.images.calls.map((c) => c.width).sort((a, b) => a! - b!), [160, 320, 480, 800, 1080, 1280], 'the lazy 640 copy is kept, the rest cut');
});

test('five failed cuts in a row pause the sweep for six hours; nothing breaks meanwhile', async () => {
  const images = imagesDouble('throw9422');
  const w = world({ images });
  for (let i = 0; i < 8; i++) w.pub.seed(`products/catalog/gallery/f${i}.webp`, webpBytes(1254, 1254));
  const report = await sweepImageVariants(w.env, { now: w.now });
  assert.equal(report.paused, true);
  assert.equal(report.failures, 5);
  const state = JSON.parse(new TextDecoder().decode(w.pub.objects.get(VARIANT_SWEEP_STATE_KEY)!.bytes));
  assert.equal(Date.parse(state.paused_until), w.now() + SWEEP_LIMITS.pauseMs);
  // While paused a tick costs one read and nothing else.
  w.advance(60 * 60 * 1000);
  w.pub.ops.length = 0;
  const paused = await sweepImageVariants(w.env, { now: w.now });
  assert.equal(paused.paused, true);
  assert.deepEqual(w.pub.ops, [`get ${VARIANT_SWEEP_STATE_KEY}`]);
  // The failed pictures are marked partial: retried in the next pass, not before.
  assert.equal(w.pub.objects.get('variants/v1/products/catalog/gallery/f0.webp/done')!.custom!.partial, '1');
  // Six hours later the binding works again and the sweep carries on.
  images.state.mode = 'ok';
  w.advance(SWEEP_LIMITS.pauseMs);
  const resumed = await sweepImageVariants(w.env, { now: w.now, limits: { transforms: 100, operations: 500 } });
  assert.equal(resumed.paused, false);
  assert.ok(resumed.stored > 0);
  assert.equal(avif(w.pub, 'products/catalog/gallery/f7.webp'), 7, 'a picture after the failures');
});

test('a finished pass rests seven days; the next is cheap (a listing and a marker each) and deletes an old store version', async () => {
  const w = world();
  w.pub.seed('products/catalog/gallery/a.webp', webpBytes(640, 640));
  const done = await sweepImageVariants(w.env, { now: w.now });
  assert.equal(done.pass_done, true);
  w.advance(24 * 60 * 60 * 1000);
  w.pub.ops.length = 0;
  const resting = await sweepImageVariants(w.env, { now: w.now });
  assert.deepEqual(w.pub.ops, [`get ${VARIANT_SWEEP_STATE_KEY}`], 'one read a tick while resting');
  assert.equal(resting.transforms, 0);
  w.advance(SWEEP_LIMITS.passGapMs);
  const before = w.images.calls.length;
  const again = await sweepImageVariants(w.env, { now: w.now });
  assert.equal(again.pass_done, true);
  assert.equal(w.images.calls.length, before, 'nothing cut twice');
  // A raised store version: the old prefix is deleted when its pass ends.
  const v2 = await sweepImageVariants(w.env, { now: () => w.now() + 2 * SWEEP_LIMITS.passGapMs, version: 2 });
  assert.equal(v2.pass_done, true);
  assert.ok(v2.removed_old > 0);
  assert.deepEqual(w.pub.keys('variants/v1/'), []);
  assert.ok(w.pub.keys('variants/v2/products/catalog/gallery/a.webp/').length > 0);
});

test('an animated WebP is marked and never cut; without the binding the sweep does nothing at all', async () => {
  const w = world();
  w.pub.seed('merchants/u1/public/moving.webp', webpBytes(600, 600, { animated: true }));
  await sweepImageVariants(w.env, { now: w.now });
  assert.equal(w.images.calls.length, 0);
  assert.equal(w.pub.objects.get('variants/v1/merchants/u1/public/moving.webp/done')!.custom!.skip, 'animated');
  const bare = new R2Double();
  const none = await sweepImageVariants({ R2_PUBLIC: bare, BUCKET: bare } as never, {});
  assert.equal(none.skipped, 'unavailable');
  assert.deepEqual(bare.ops, []);
});

test('the quarter-hour tick hands the sweep to waitUntil with its own .catch, beside the upload sweep — no new cron', () => {
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  const quarter = index.slice(index.indexOf("if (jobs !== 'quarter_hour')"));
  assert.match(quarter, /ctx\.waitUntil\(\s*sweepImageVariants\(env\)\.catch\(/);
  const otherCrons = index.slice(index.indexOf('scheduled(_event: ScheduledEvent'), index.indexOf("if (jobs !== 'quarter_hour')"));
  assert.doesNotMatch(otherCrons, /sweepImageVariants/, 'not on the minute or the FX cron');
  const crons = readFileSync(join(ROOT, 'worker/lib/cronSchedules.ts'), 'utf8');
  assert.doesNotMatch(crons, /image/i, 'no cron string of its own');
});
