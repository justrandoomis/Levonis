/**
 * «سرعة متجري» — THE SPEED REPORT AND THE WEIGHT AUDIT (merchant platform v2
 * §4.5 S4–S6, workspace §4.8, worker/lib/storeSpeed.ts):
 *
 *   - the p75 is a WORD — the bucket holding the 75th sample — and null under
 *     fifty readings; the verdict is the worst core word, «collecting» under
 *     fifty samples;
 *   - the report reads exactly its window (7 or 28 Baghdad days), per device,
 *     this store only;
 *   - the attention row exists only for three consecutive poor phone days of
 *     thirty samples each, and is otherwise ABSENT, never zero;
 *   - the first-view audit names the files a phone downloads before the first
 *     product row and answers closed finding codes with numbers — no copy;
 *   - the routes are owner-only, `private, no-store`, and audit the published
 *     layout or the draft.
 *
 * Run: node --import tsx --test tests/storeSpeed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, put, stubApp, type App } from './fixtures/app';
import { MEDIA, OWNER, OTHER, STORE_ID, seedLayoutStore } from './fixtures/storeLayout';
import { OWNER as W2E_OWNER, appOf, seedW2E } from './fixtures/merchantW2E';
import { storeLayoutRoutes, storeSpeedRoutes } from '../worker/routes/storeLayout';
import { merchantAttentionRoutes } from '../worker/routes/merchantWorkspace';
import { merchantHref } from '../packages/contracts/src/merchantRoutes';
import { normalizeLayout } from '../packages/storeLayout/src/normalize';
import type { StoreLayout } from '../packages/storeLayout/src/schema';
import { addDays, baghdadDay } from '../worker/lib/baghdadTime';
import { wavesD1 } from './fixtures/wavesD1';
import {
  ABOVE_FOLD_MAX_BLOCKS,
  ATTENTION_MIN_SAMPLES,
  ATTENTION_POOR_DAYS,
  BUCKET_COLUMNS,
  FIRST_VIEW_MEDIA_PER_BLOCK,
  HERO_HEAVY_BYTES,
  MIN_SAMPLES,
  PRODUCT_IMAGE_LARGE_BYTES,
  SPEED_FINDING_CODES,
  STOREFRONT_FIXED_KB,
  STOREFRONT_FONT_KB,
  auditLayoutWeight,
  auditWeight,
  describeFirstView,
  p75Bucket,
  pageSpeedUrl,
  pickFirstProductRow,
  speedAttention,
  summarizeVitals,
  type FileSize,
  type VitalsDayRow,
} from '../worker/lib/storeSpeed';

const BASE = '/api/merchant/store/layout';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const today = baghdadDay(Date.now());
const T = (ar: string) => ({ ar, en: '', ckb: '' });

// ----------------------------------------------------------- pure: the words

/** A day row with the given LCP buckets; the other vitals mirror it unless given. */
function dayRow(day: string, samples: number, lcp: [number, number, number], over: Partial<VitalsDayRow> = {}): VitalsDayRow {
  const [good, ok, poor] = lcp;
  return {
    day, samples,
    lcp_good: good, lcp_ok: ok, lcp_poor: poor,
    inp_good: good, inp_ok: ok, inp_poor: poor,
    cls_good: good, cls_ok: ok, cls_poor: poor,
    ttfb_good: good, ttfb_ok: ok, ttfb_poor: poor,
    lcp_sum_ms: samples * 2000, ttfb_sum_ms: samples * 600,
    ...over,
  };
}

test('the p75 is the bucket holding the 75th sample laid out good → ok → poor — a word, never a number', () => {
  assert.equal(p75Bucket({ good: 75, ok: 20, poor: 5 }), 'good', 'the 75th of 100 is the last good one');
  assert.equal(p75Bucket({ good: 74, ok: 21, poor: 5 }), 'ok', 'one fewer good and the 75th sample is ok');
  assert.equal(p75Bucket({ good: 10, ok: 10, poor: 80 }), 'poor');
  assert.equal(p75Bucket({ good: 20, ok: 60, poor: 20 }), 'ok');
  assert.equal(p75Bucket({ good: 3, ok: 0, poor: 1 }), 'good', 'of 4 the 3rd sample decides');
  assert.equal(p75Bucket({ good: 2, ok: 0, poor: 2 }), 'poor');
  assert.equal(p75Bucket({ good: 0, ok: 0, poor: 1 }), 'poor');
  assert.equal(p75Bucket({ good: 0, ok: 0, poor: 0 }), null, 'no readings, no word');
  assert.equal(p75Bucket({ good: -1, ok: Number.NaN, poor: 0 } as never), null, 'garbage counts are no readings');
});

test('under fifty readings a vital has no word and the verdict is «collecting»; at fifty the words appear', () => {
  const few = summarizeVitals([dayRow(today, 49, [40, 5, 4])], { days: 28, today, device: 'phone' });
  assert.equal(few.samples, 49);
  assert.deepEqual(few.p75_bucket, { lcp: null, inp: null, cls: null, ttfb: null });
  assert.equal(few.verdict, 'collecting');
  assert.equal(few.min_samples, MIN_SAMPLES);
  // Under the floor the mean IS those few visitors' readings (review 2026-09-30): none is given.
  assert.deepEqual(few.mean_ms, { lcp: null, ttfb: null }, 'no mean under fifty readings of that vital');

  // 50 readings: the 38th sample decides — 30 good, so the 38th is the 8th ok one.
  const enough = summarizeVitals([dayRow(today, 50, [30, 15, 5])], { days: 28, today, device: 'phone' });
  assert.deepEqual(enough.p75_bucket, { lcp: 'ok', inp: 'ok', cls: 'ok', ttfb: 'ok' });
  assert.equal(enough.mean_ms.lcp! % 100, 0, 'the mean is given to the nearest 100 ms, so one more reading cannot be read back out of it');
  assert.equal(enough.verdict, 'ok');
  assert.equal(summarizeVitals([dayRow(today, 50, [40, 6, 4])], { days: 28, today, device: 'phone' }).verdict, 'good', '40 good of 50 covers the 38th');

  // Fifty BEACONS but a vital with fewer readings of its own keeps its silence,
  // and the verdict is the worst of the CORE words that exist (TTFB is context).
  const partial = summarizeVitals(
    [dayRow(today, 60, [50, 5, 5], { inp_good: 3, inp_ok: 0, inp_poor: 0, ttfb_good: 0, ttfb_ok: 0, ttfb_poor: 60, cls_good: 0, cls_ok: 0, cls_poor: 60 })],
    { days: 28, today, device: 'phone' }
  );
  assert.deepEqual(partial.p75_bucket, { lcp: 'good', inp: null, cls: 'poor', ttfb: 'poor' });
  assert.equal(partial.verdict, 'poor', 'CLS is poor');
  const noCore = summarizeVitals([dayRow(today, 60, [0, 0, 0], { ttfb_good: 60 })], { days: 28, today, device: 'phone' });
  assert.equal(noCore.verdict, 'collecting', 'a TTFB word alone is no verdict');
});

test('the summary keeps exactly its window — 7 or 28 days ending today — and sums across the days it keeps', () => {
  const rows: VitalsDayRow[] = [];
  for (let back = 0; back < 40; back++) rows.push(dayRow(addDays(today, -back), 10, [8, 1, 1]));
  const week = summarizeVitals(rows, { days: 7, today, device: 'phone' });
  assert.equal(week.days.length, 7);
  assert.equal(week.from, addDays(today, -6));
  assert.deepEqual([week.days[0].day, week.days[6].day], [addDays(today, -6), today], 'oldest first, today last');
  assert.equal(week.samples, 70);
  assert.deepEqual(week.totals.lcp, { good: 56, ok: 7, poor: 7 });
  assert.equal(week.p75_bucket.lcp, 'good');
  const month = summarizeVitals(rows, { days: 28, today, device: 'desktop' });
  assert.deepEqual([month.days.length, month.samples, month.window_days, month.device], [28, 280, 28, 'desktop']);
  // A row from the future (a clock ahead) is not in the window either.
  const ahead = summarizeVitals([...rows, dayRow(addDays(today, 1), 500, [0, 0, 500])], { days: 7, today, device: 'phone' });
  assert.equal(ahead.samples, 70);
});

test('ATTENTION: three consecutive poor phone days of thirty samples each, reaching today or yesterday — else nothing', () => {
  const poor = (day: string, samples = 40) => dayRow(day, samples, [0, 0, samples]);
  const good = (day: string, samples = 40) => dayRow(day, samples, [samples, 0, 0]);
  const d = (back: number) => addDays(today, -back);

  assert.deepEqual(speedAttention([poor(d(0)), poor(d(1)), poor(d(2))], today), { grade: 'poor', samples: 120, poor_days: 3 });
  assert.deepEqual(speedAttention([poor(d(1)), poor(d(2)), poor(d(3))], today), { grade: 'poor', samples: 120, poor_days: 3 }, 'today may still be young');
  assert.equal(speedAttention([poor(d(0)), poor(d(1))], today), null, 'two days are not three');
  assert.equal(speedAttention([poor(d(2)), poor(d(3)), poor(d(4))], today), null, 'a streak that ended before yesterday is over');
  assert.equal(speedAttention([poor(d(0)), good(d(1)), poor(d(2)), poor(d(3))], today), null, 'a good day breaks the streak');
  assert.equal(speedAttention([poor(d(0)), poor(d(1), ATTENTION_MIN_SAMPLES - 1), poor(d(2))], today), null, 'a thin day does not count');
  assert.deepEqual(speedAttention([poor(d(0), ATTENTION_MIN_SAMPLES), poor(d(1), ATTENTION_MIN_SAMPLES), poor(d(2), ATTENTION_MIN_SAMPLES)], today)?.samples, 90);
  // The word is the p75 bucket, not «any poor sample»: 24 good + 16 poor of 40 → the 30th sample is poor.
  assert.deepEqual(speedAttention([dayRow(d(0), 40, [24, 0, 16]), poor(d(1)), poor(d(2))], today)?.poor_days, 3);
  assert.equal(speedAttention([dayRow(d(0), 40, [30, 0, 10]), poor(d(1)), poor(d(2))], today), null, '30 good of 40 → the 30th is good');
  // A longer streak reports its length; a day before it that was fine does not.
  assert.equal(speedAttention([good(d(6)), poor(d(5)), poor(d(4)), poor(d(3)), poor(d(2)), poor(d(1)), poor(d(0))], today)?.poor_days, 6);
  assert.equal(ATTENTION_POOR_DAYS, 3);
  assert.equal(speedAttention([], today), null);
});

// ------------------------------------------------------- pure: the first view

const OWNER_KEY = (name: string) => `merchants/owner/public/${name}`;
const KEYS = {
  heroGif: OWNER_KEY('hero0009.gif'),
  heroPic: MEDIA.picture,
  clip: MEDIA.video,
  poster: MEDIA.picture2,
  bg: OWNER_KEY('bg000001.webp'),
  bgClip: OWNER_KEY('bgclip01.mp4'),
  gallery: (i: number) => OWNER_KEY(`gal${String(i).padStart(5, '0')}.webp`),
  product: (i: number) => OWNER_KEY(`prod${String(i).padStart(4, '0')}.webp`),
};
const MB = 1024 * 1024;
const KB = 1024;

function layoutOf(blocks: unknown[], extra: Record<string, unknown> = {}): StoreLayout {
  const { layout, ok, issues } = normalizeLayout({ schema_version: 1, theme: 'classic', blocks, ...extra }, { ownerUserId: OWNER });
  assert.ok(ok, `fixture layout refused: ${JSON.stringify(issues)}`);
  return layout;
}
const hero = (settings: Record<string, unknown> = {}) => ({ id: 'hero1', type: 'hero', settings });
const grid = (id = 'grid1') => ({ id, type: 'products_grid', settings: { title: T('المنتجات'), source: 'latest', limit: 6 } });
const text = (id: string) => ({ id, type: 'text', settings: { title: T('نص'), body: T('كلام') } });
const sizes = (entries: Array<[string, number, string]>): Map<string, FileSize> => new Map(entries.map(([k, bytes, mime]) => [k, { bytes, mime }]));
const store = { user_id: OWNER, logo_key: 'merchants/owner/public/logo0001.webp', banner_key: 'merchants/owner/public/bnr00001.webp' };
const codes = (a: { findings: Array<{ code: string }> }) => a.findings.map((f) => f.code);

test('the first view: background, logo, cover-or-hero picture, the first two blocks after the hero, the first product row — and nothing further down', () => {
  const layout = layoutOf([
    hero({ image: KEYS.heroPic }),
    { id: 'gal1', type: 'gallery', settings: { title: T('معرض'), images: Array.from({ length: 10 }, (_v, i) => ({ image: KEYS.gallery(i) })) } },
    grid(),
    { id: 'gal2', type: 'gallery', settings: { title: T('لاحقًا'), images: [{ image: KEYS.gallery(99) }] } },
  ]);
  const view = describeFirstView(store, layout, { block_id: 'grid1', items: [{ id: 'p1', images: [`/files/${KEYS.product(1)}`] }, { id: 'p2', images: [KEYS.product(2)] }] });
  const by = (label: string) => view.slots.filter((s) => s.label_key === label);
  assert.deepEqual(by('logo').map((s) => [s.block_id, s.key]), [['header', store.logo_key]]);
  assert.equal(by('banner').length, 0, 'a hero picture replaces the cover');
  assert.deepEqual(by('hero_image').map((s) => [s.block_id, s.key]), [['hero1', KEYS.heroPic]]);
  assert.equal(by('block_image').length, FIRST_VIEW_MEDIA_PER_BLOCK, 'a gallery is measured by its first pictures');
  assert.ok(by('block_image').every((s) => s.block_id === 'gal1'));
  assert.deepEqual(by('product_image').map((s) => [s.block_id, s.product_id, s.key]), [['grid1', 'p1', KEYS.product(1)], ['grid1', 'p2', KEYS.product(2)]]);
  assert.equal(view.slots.some((s) => s.key === KEYS.gallery(99)), false, 'the third block after the hero is below the first view');
  assert.equal(view.above_fold_blocks, 2, 'hero and gallery before the first product row');
  assert.equal(view.product_block_id, 'grid1');
  assert.deepEqual(view.posterless, []);

  // No hero picture: the store's cover is the hero family; a hidden or desktop-only block is not on a phone.
  const bare = layoutOf([hero(), { ...text('t1'), hidden: true }, { ...text('t2'), visibility: { mobile: false, desktop: true } }, grid()]);
  const bareView = describeFirstView(store, bare, null);
  assert.deepEqual(bareView.slots.filter((s) => s.label_key === 'banner').map((s) => [s.block_id, s.key]), [['hero1', store.banner_key]]);
  assert.equal(bareView.above_fold_blocks, 1);
  assert.equal(describeFirstView(store, layoutOf([hero(), text('t1')]), null).above_fold_blocks, null, 'no product row, no count');
  assert.equal(describeFirstView({ user_id: OWNER }, layoutOf([hero(), text('t1')]), null).slots.length, 0, 'a store without pictures has nothing to weigh');
});

test('findings: a GIF or a picture over 1.5 MB in the hero family; heavy first-row product pictures; OK_IMAGES only when nothing is wrong', () => {
  const layout = layoutOf([hero({ image: KEYS.heroGif }), grid()]);
  const firstRow = { block_id: 'grid1', items: [1, 2, 3, 4].map((i) => ({ id: `p${i}`, images: [KEYS.product(i)] })) };
  const heavy = auditWeight(
    describeFirstView(store, layout, firstRow),
    sizes([
      [KEYS.heroGif, 6 * MB, 'image/gif'],
      [store.logo_key, 20 * KB, 'image/webp'],
      [KEYS.product(1), 900 * KB, 'image/jpeg'],
      [KEYS.product(2), 100 * KB, 'image/webp'],
      [KEYS.product(3), 700 * KB, 'image/jpeg'],
      // product 4 is not in the ledger: not measured, not averaged
    ])
  );
  assert.deepEqual(codes(heavy), ['HERO_GIF', 'HERO_HEAVY', 'PRODUCT_IMAGES_LARGE']);
  assert.deepEqual(heavy.findings[0], { code: 'HERO_GIF', block_id: 'hero1', params: { bytes: 6 * MB } });
  assert.deepEqual(heavy.findings[1], { code: 'HERO_HEAVY', block_id: 'hero1', params: { bytes: 6 * MB, max_bytes: HERO_HEAVY_BYTES } });
  assert.deepEqual(heavy.findings[2], {
    code: 'PRODUCT_IMAGES_LARGE',
    block_id: 'grid1',
    params: { avg_bytes: Math.round((900 * KB + 100 * KB + 700 * KB) / 3), count: 3, max_bytes: PRODUCT_IMAGE_LARGE_BYTES },
  });
  assert.deepEqual(heavy.fixed, { app_kb: STOREFRONT_FIXED_KB, font_kb: STOREFRONT_FONT_KB });
  const rows = Object.fromEntries(heavy.first_view.map((i) => [i.key, [i.bytes, i.mime]]));
  assert.deepEqual(rows[KEYS.heroGif], [6 * MB, 'image/gif']);
  assert.deepEqual(rows[KEYS.product(4)], [null, null], 'an unledgered key is shown, unmeasured');
  assert.equal(heavy.first_view.find((i) => i.key === KEYS.product(1))?.product_id, 'p1');

  const light = auditWeight(
    describeFirstView(store, layoutOf([hero({ image: KEYS.heroPic }), grid()]), firstRow),
    sizes([
      [KEYS.heroPic, 300 * KB, 'image/webp'],
      [store.logo_key, 20 * KB, 'image/webp'],
      [KEYS.product(1), 120 * KB, 'image/webp'],
      [KEYS.product(2), 80 * KB, 'image/webp'],
    ])
  );
  assert.deepEqual(light.findings, [{ code: 'OK_IMAGES', params: { bytes: 520 * KB, count: 4 } }]);

  // Exactly at the line is not over it.
  const atLine = auditWeight(describeFirstView(store, layoutOf([hero({ image: KEYS.heroPic })]), null), sizes([[KEYS.heroPic, HERO_HEAVY_BYTES, 'image/webp'], [store.logo_key, 1, 'image/webp']]));
  assert.deepEqual(codes(atLine), ['OK_IMAGES']);
  // Nothing measured at all: no OK either — the audit does not vouch for what it could not weigh.
  assert.deepEqual(auditWeight(describeFirstView(store, layoutOf([hero({ image: KEYS.heroPic })]), null), new Map()).findings, []);
  assert.deepEqual([...SPEED_FINDING_CODES], ['HERO_GIF', 'HERO_HEAVY', 'BACKGROUND_VIDEO_ON_PHONE', 'AUTOPLAY_VIDEO_COUNT', 'POSTER_MISSING', 'PRODUCT_IMAGES_LARGE', 'ABOVE_FOLD_BLOCKS', 'OK_IMAGES']);
});

test('findings: videos — a poster missing, a background video on phones, autoplay counted with its bytes; too many blocks above the fold', () => {
  // A video block with autoplay and no poster inside the first view; a hero video without its still (its `image`).
  const layout = layoutOf([
    hero({ video: KEYS.clip, video_on_phone: true }),
    { id: 'vid1', type: 'video', settings: { title: T('فيديو'), video: KEYS.clip, autoplay: true } },
    grid(),
  ]);
  const view = describeFirstView(store, layout, null);
  const audit = auditWeight(view, sizes([[KEYS.clip, 9 * MB, 'video/mp4'], [store.logo_key, 10 * KB, 'image/webp']]));
  assert.deepEqual(codes(audit), ['AUTOPLAY_VIDEO_COUNT', 'POSTER_MISSING', 'POSTER_MISSING', 'OK_IMAGES']);
  assert.deepEqual(audit.findings[0], { code: 'AUTOPLAY_VIDEO_COUNT', params: { count: 2, bytes: 18 * MB } });
  assert.deepEqual(audit.findings.filter((f) => f.code === 'POSTER_MISSING').map((f) => f.block_id).sort(), ['hero1', 'vid1']);
  assert.equal(view.slots.some((s) => s.label_key === 'banner'), true, 'with no hero picture the cover still shows behind the video');

  // The hero video kept off phones is not a phone download; with its still it needs no poster; one autoplay names its block.
  const still = layoutOf([hero({ image: KEYS.heroPic, video: KEYS.clip }), { id: 'vid1', type: 'video', settings: { title: T('فيديو'), video: KEYS.clip, poster: KEYS.poster, autoplay: true } }]);
  const stillView = describeFirstView(store, still, null);
  assert.equal(stillView.slots.some((s) => s.label_key === 'hero_video'), false);
  assert.deepEqual(stillView.slots.filter((s) => s.block_id === 'hero1').map((s) => s.label_key), ['hero_poster']);
  assert.deepEqual(stillView.posterless, []);
  const one = auditWeight(stillView, sizes([[KEYS.clip, 9 * MB, 'video/mp4'], [KEYS.poster, 50 * KB, 'image/webp'], [KEYS.heroPic, 50 * KB, 'image/webp'], [store.logo_key, 1, 'image/webp']]));
  assert.deepEqual(one.findings[0], { code: 'AUTOPLAY_VIDEO_COUNT', block_id: 'vid1', params: { count: 1, bytes: 9 * MB } });
  assert.deepEqual(stillView.slots.filter((s) => s.block_id === 'vid1').map((s) => s.label_key).sort(), ['block_poster', 'block_video']);

  // The page background (L4 shape: kind / media / poster / phones), read from the normalised layout.
  const bgLayout = layoutOf([hero({ image: KEYS.heroPic })], { background: { kind: 'video', media: KEYS.bgClip, poster: '', dim: 'medium', phones: true } });
  const bgView = describeFirstView(store, bgLayout, null);
  assert.equal(bgView.background_video_on_phone, true);
  assert.deepEqual(bgView.posterless, [{ block_id: 'background', label_key: 'background' }]);
  const bgAudit = auditWeight(bgView, sizes([[KEYS.bgClip, 12 * MB, 'video/mp4'], [KEYS.heroPic, 1, 'image/webp'], [store.logo_key, 1, 'image/webp']]));
  assert.deepEqual(codes(bgAudit), ['BACKGROUND_VIDEO_ON_PHONE', 'AUTOPLAY_VIDEO_COUNT', 'POSTER_MISSING', 'OK_IMAGES']);
  assert.deepEqual(bgAudit.findings[0], { code: 'BACKGROUND_VIDEO_ON_PHONE', block_id: 'background', params: { bytes: 12 * MB } });
  const bgStill = describeFirstView(store, layoutOf([hero({ image: KEYS.heroPic })], { background: { kind: 'video', media: KEYS.bgClip, poster: KEYS.bg, dim: 'light', phones: false } }), null);
  assert.deepEqual(bgStill.slots.filter((s) => s.block_id === 'background').map((s) => s.label_key), ['background_poster'], 'phones see the still only');
  assert.equal(bgStill.background_video_on_phone, false);
  const bgImage = describeFirstView(store, layoutOf([hero({ image: KEYS.heroPic })], { background: { kind: 'image', media: KEYS.bg, poster: '', dim: 'heavy', phones: true } }), null);
  assert.deepEqual(bgImage.slots.filter((s) => s.block_id === 'background').map((s) => [s.label_key, s.key]), [['background', KEYS.bg]]);

  // Blocks above the fold: hero + four texts before the grid is five, over three.
  const tall = layoutOf([hero({ image: KEYS.heroPic }), text('t1'), text('t2'), text('t3'), text('t4'), grid()]);
  const tallAudit = auditWeight(describeFirstView(store, tall, null), new Map());
  assert.deepEqual(tallAudit.findings, [{ code: 'ABOVE_FOLD_BLOCKS', params: { count: 5, max: ABOVE_FOLD_MAX_BLOCKS } }]);
  assert.deepEqual(auditWeight(describeFirstView(store, layoutOf([hero({ image: KEYS.heroPic }), text('t1'), text('t2'), grid()]), null), new Map()).findings, [], 'three is allowed');
});

test('the first product row comes from the first product-bearing block the phone shows, from the rows the planner read', () => {
  const layout = layoutOf([hero(), text('t1'), { ...grid('hidden'), hidden: true }, grid('g1'), { id: 'deals1', type: 'deals', settings: { title: T('عروض'), limit: 4 } }]);
  const card = (id: string) => ({ id, slug: id, name: id, name_ar: id, images: [`/files/${KEYS.product(1)}`], image_2: null, has_video: false, price_iqd: 1, original_price_iqd: null, in_stock: true, featured: false, section_id: null, sales_tier: null });
  const data = {
    products: { latest: { items: ['a', 'b', 'c', 'd', 'e', 'f'].map(card), next_cursor: null }, deals: { items: [card('z')], next_cursor: null } },
    picked: [card('picked')],
    collections: null, services: null, showcase: null, reviews: null, printers: null, coupons: null,
  };
  const row = pickFirstProductRow(layout, data as never);
  assert.deepEqual(row?.block_id, 'g1');
  assert.deepEqual(row?.items.map((p) => p.id), ['a', 'b', 'c', 'd'], 'the first four cards — two at 360 px, four at 1280');
  const featured = layoutOf([{ id: 'f1', type: 'featured_products', settings: { title: T('مختارة'), product_ids: ['picked', 'p9'] } }]);
  assert.deepEqual(pickFirstProductRow(featured, data as never), { block_id: 'f1', items: [{ id: 'picked', images: [`/files/${KEYS.product(1)}`] }] });
  assert.equal(pickFirstProductRow(layoutOf([hero(), text('t1')]), data as never), null);
  assert.equal(pageSpeedUrl('https://raf3d.levonis-iq.com'), 'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fraf3d.levonis-iq.com');
  assert.equal(pageSpeedUrl('/community/store/s1'), null, 'no https address, no lab link');
});

// ------------------------------------------------------------------ routes

interface World {
  raw: DatabaseSync;
  owner: App;
  other: App;
  customer: App;
  anon: App;
}

function world(): World {
  const raw = freshDb();
  seedLayoutStore(raw);
  // The ledger's sizes for what the layouts below name: a heavy first row, a light hero.
  const rows: Array<[string, string, number]> = [
    [MEDIA.picture, 'image/webp', 200 * KB],
    ['merchants/owner/public/logo0001.webp', 'image/webp', 20 * KB],
    ['merchants/owner/public/bnr00001.webp', 'image/webp', 2 * MB],
  ];
  // seedLayoutStore's product pictures are /files/merchants/owner/public/aaaaaaa<n>.webp, unledgered until now.
  for (let n = 1; n <= 8; n++) rows.push([`merchants/owner/public/${n.toString(16).padStart(8, 'a')}.webp`, 'image/jpeg', 600 * KB]);
  raw.prepare('UPDATE file_objects SET byte_size = ? WHERE object_key = ?').run(200 * KB, MEDIA.picture);
  const insert = raw.prepare(`INSERT OR IGNORE INTO file_objects (object_key,visibility,domain,owner_id,mime_type,byte_size,deleted_at) VALUES (?,?,?,?,?,?,NULL)`);
  for (const [key, mime, bytes] of rows) insert.run(key, 'public', 'merchants', OWNER, mime, bytes);
  const db = asD1(raw);
  const mount = (a: App) => {
    a.route(BASE, storeLayoutRoutes);
    a.route('/api/merchant/store/speed', storeSpeedRoutes);
  };
  return {
    raw,
    owner: stubApp(db, { id: OWNER, role: 'merchant', email: 'owner@x.co' }, mount, { env: ENV }),
    other: stubApp(db, { id: OTHER, role: 'merchant', email: 'other@x.co' }, mount, { env: ENV }),
    customer: stubApp(db, { id: 'c1', role: 'customer', email: 'c1@x.co' }, mount, { env: ENV }),
    anon: stubApp(db, null, mount, { env: ENV }),
  };
}

async function ok(res: Response, status = 200) {
  const body = await json(res);
  assert.equal(res.status, status, JSON.stringify(body).slice(0, 600));
  return body;
}

/** Insert a phone (or desktop) day row with the given LCP buckets (other vitals mirror it). */
function seedDay(raw: DatabaseSync, store: string, day: string, samples: number, lcp: [number, number, number], device = 'phone') {
  const [g, o, p] = lcp;
  raw
    .prepare(
      `INSERT INTO storefront_vitals_daily (store_id, day, device, samples, ${BUCKET_COLUMNS.join(', ')}, lcp_sum_ms, ttfb_sum_ms)
       VALUES (?, ?, ?, ?, ${BUCKET_COLUMNS.map(() => '?').join(', ')}, ?, ?)`
    )
    .run(store, day, device, samples, g, o, p, g, o, p, g, o, p, g, o, p, samples * 2500, samples * 500);
}

test('GET /speed audits the PUBLISHED layout by default and the draft on request; owner-only; private, no-store', async () => {
  const w = world();
  const publishedLayout = layoutOf([hero({ image: MEDIA.picture }), grid()]);
  await ok(await put(w.owner, `${BASE}/draft`, { layout: publishedLayout, version: 0 }));
  await ok(await post(w.owner, `${BASE}/publish`, { version: 1 }));
  const res = await get(w.owner, `${BASE}/speed`);
  const body = await ok(res);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(body.source, 'published');
  const audit = body.audit;
  assert.deepEqual(audit.fixed, { app_kb: STOREFRONT_FIXED_KB, font_kb: STOREFRONT_FONT_KB });
  const labels = audit.first_view.map((i: { label_key: string }) => i.label_key);
  assert.deepEqual(labels.filter((l: string) => l !== 'product_image'), ['logo', 'hero_image']);
  assert.equal(labels.filter((l: string) => l === 'product_image').length, 4, 'the first row of the latest products');
  const heroRow = audit.first_view.find((i: { label_key: string }) => i.label_key === 'hero_image');
  assert.deepEqual([heroRow.block_id, heroRow.key, heroRow.bytes, heroRow.mime], ['hero1', MEDIA.picture, 200 * KB, 'image/webp']);
  assert.deepEqual(codes(audit), ['PRODUCT_IMAGES_LARGE']);
  assert.deepEqual(audit.findings[0].params, { avg_bytes: 600 * KB, count: 4, max_bytes: PRODUCT_IMAGE_LARGE_BYTES });
  assert.equal(audit.findings[0].block_id, 'grid1');
  // The product ids ride with their pictures (the door to the product editor).
  assert.deepEqual(
    audit.first_view.filter((i: { label_key: string }) => i.label_key === 'product_image').map((i: { product_id: string }) => i.product_id),
    ['p8', 'p7', 'p6', 'p5'],
    'latest first, as the storefront lists them'
  );

  // The draft: a bare hero shows the store's 2 MB cover — HERO_HEAVY, not yet what visitors see.
  await ok(await put(w.owner, `${BASE}/draft`, { layout: layoutOf([hero(), text('t1'), text('t2'), text('t3'), grid()]), version: 2 }));
  const draft = await ok(await get(w.owner, `${BASE}/speed?source=draft`));
  assert.equal(draft.source, 'draft');
  assert.deepEqual(codes(draft.audit), ['HERO_HEAVY', 'PRODUCT_IMAGES_LARGE', 'ABOVE_FOLD_BLOCKS']);
  assert.deepEqual(draft.audit.findings[0], { code: 'HERO_HEAVY', block_id: 'hero1', params: { bytes: 2 * MB, max_bytes: HERO_HEAVY_BYTES } });
  assert.deepEqual(draft.audit.findings[2].params, { count: 4, max: ABOVE_FOLD_MAX_BLOCKS });
  assert.deepEqual(codes((await ok(await get(w.owner, `${BASE}/speed`))).audit), ['PRODUCT_IMAGES_LARGE'], 'the published audit did not move');
  // The library entry point the route calls, straight against the ledger: the
  // sizes come from THIS owner's live rows only, and a row of another owner's
  // key weighs nothing here.
  const direct = await auditLayoutWeight(asD1(w.raw), { user_id: OWNER, logo_key: 'merchants/owner/public/logo0001.webp', banner_key: null }, publishedLayout, null);
  assert.deepEqual(direct.findings, [{ code: 'OK_IMAGES', params: { bytes: 220 * KB, count: 2 } }]);
  assert.deepEqual(direct.first_view.map((i) => [i.label_key, i.bytes]), [['logo', 20 * KB], ['hero_image', 200 * KB]]);
  const foreign = await auditLayoutWeight(asD1(w.raw), { user_id: OTHER, logo_key: MEDIA.foreign, banner_key: null }, layoutOf([hero({ image: MEDIA.picture })]), null);
  assert.deepEqual(foreign.first_view.map((i) => [i.label_key, i.bytes]), [['logo', 1000], ['hero_image', null]], "the first owner's picture is not weighed for the second");

  // Owner-only, and the audit is of the caller's OWN store whatever they ask.
  assert.equal((await get(w.anon, `${BASE}/speed`)).status, 401);
  assert.equal((await get(w.customer, `${BASE}/speed`)).status, 404);
  const others = await ok(await get(w.other, `${BASE}/speed`));
  assert.equal(others.source, 'default');
  assert.equal(others.audit.first_view.length, 0, 'the other merchant has no pictures of their own — and none of ours');
  // The other merchant's store never published: the default page, no keys of the first store leak into it.
  assert.equal(JSON.stringify(others).includes('merchants/owner/'), false);
});

test('GET /speed/report: the window per device, this store only, the p75 words, the verdict, the published audit and the PageSpeed link', async () => {
  const w = world();
  await ok(await put(w.owner, `${BASE}/draft`, { layout: layoutOf([hero({ image: MEDIA.picture }), grid()]), version: 0 }));
  await ok(await post(w.owner, `${BASE}/publish`, { version: 1 }));
  for (let back = 0; back < 35; back++) {
    seedDay(w.raw, STORE_ID, addDays(today, -back), 10, [8, 1, 1]);
    seedDay(w.raw, STORE_ID, addDays(today, -back), 4, [0, 0, 4], 'desktop');
    seedDay(w.raw, 's2', addDays(today, -back), 100, [0, 0, 100]);
  }
  const res = await get(w.owner, `${BASE}/speed/report?days=7&device=phone`);
  const week = await ok(res);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual([week.rum.window_days, week.rum.device, week.rum.days.length, week.rum.samples], [7, 'phone', 7, 70]);
  assert.deepEqual(week.rum.p75_bucket, { lcp: 'good', inp: 'good', cls: 'good', ttfb: 'good' });
  assert.equal(week.rum.verdict, 'good');
  assert.deepEqual(week.rum.days[0], { day: addDays(today, -6), samples: 10, lcp: { good: 8, ok: 1, poor: 1 }, inp: { good: 8, ok: 1, poor: 1 }, cls: { good: 8, ok: 1, poor: 1 }, ttfb: { good: 8, ok: 1, poor: 1 } });
  assert.equal(week.rum.mean_ms.lcp, 2500);
  assert.equal(week.psi_url, 'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fraf3d.levonis-iq.com');
  assert.deepEqual(codes(week.weight), ['PRODUCT_IMAGES_LARGE']);
  assert.equal(week.weight_source, 'published');

  const month = await ok(await get(w.owner, `${BASE}/speed/report?days=28`));
  assert.deepEqual([month.rum.window_days, month.rum.days.length, month.rum.samples], [28, 28, 280]);
  const anyOther = await ok(await get(w.owner, `${BASE}/speed/report?days=9999`));
  assert.equal(anyOther.rum.window_days, 28, 'only 7 or 28');

  const desktop = await ok(await get(w.owner, `${BASE}/speed/report?days=28&device=desktop`));
  assert.deepEqual([desktop.rum.device, desktop.rum.samples, desktop.rum.verdict], ['desktop', 112, 'poor']);
  assert.deepEqual(desktop.rum.p75_bucket, { lcp: 'poor', inp: 'poor', cls: 'poor', ttfb: 'poor' });

  // Under fifty samples the words are withheld: a young store.
  const young = await ok(await get(w.owner, `${BASE}/speed/report?days=7&device=phone`));
  assert.equal(young.rum.samples, 70);
  w.raw.exec(`DELETE FROM storefront_vitals_daily WHERE store_id = '${STORE_ID}' AND device = 'phone' AND day < '${addDays(today, -3)}'`);
  const collecting = await ok(await get(w.owner, `${BASE}/speed/report?days=7&device=phone`));
  assert.deepEqual([collecting.rum.samples, collecting.rum.verdict, collecting.rum.p75_bucket.lcp], [40, 'collecting', null]);

  // Each owner reads their OWN store: the other merchant sees their 100-a-day
  // rows (28 × 100) and none of this store's, whatever else the table holds.
  const others = await ok(await get(w.other, `${BASE}/speed/report`));
  assert.deepEqual([others.rum.samples, others.rum.verdict, others.psi_url], [2800, 'poor', 'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fothershop.levonis-iq.com']);
  assert.equal(others.weight.first_view.length, 0, 'and none of this store\'s pictures');
  assert.equal((await get(w.anon, `${BASE}/speed/report`)).status, 401);
  assert.equal((await get(w.customer, `${BASE}/speed/report`)).status, 404);

  // The same report on its own router (for a mount at /api/merchant/store/speed).
  const alias = await ok(await get(w.owner, '/api/merchant/store/speed?days=28&device=desktop'));
  assert.deepEqual([alias.rum.device, alias.rum.samples], ['desktop', 112]);
});

test('ATTENTION source: `speed` is present only for three consecutive poor phone days of thirty samples, and links to the builder', async () => {
  const raw = seedW2E();
  const mount = (a: App) => a.route('/api/merchant/attention', merchantAttentionRoutes);
  const attention = async () => {
    const res = await get(appOf(raw, W2E_OWNER, mount), '/api/merchant/attention');
    assert.equal(res.status, 200);
    return (await json(res)).attention as Record<string, unknown>;
  };
  assert.equal('speed' in (await attention()), false, 'no rows, no field');
  seedDay(raw, 's1', today, 40, [0, 0, 40]);
  seedDay(raw, 's1', addDays(today, -1), 40, [0, 0, 40]);
  assert.equal('speed' in (await attention()), false, 'two days');
  seedDay(raw, 's1', addDays(today, -2), 40, [0, 0, 40], 'desktop');
  assert.equal('speed' in (await attention()), false, 'a desktop day is not a phone day');
  seedDay(raw, 's1', addDays(today, -2), 40, [0, 0, 40]);
  assert.deepEqual((await attention()).speed, { grade: 'poor', samples: 120, poor_days: 3, link: merchantHref.storeDesign() });
  // The other store's poor days are not this owner's.
  raw.exec("DELETE FROM storefront_vitals_daily WHERE store_id = 's1'");
  for (let back = 0; back < 3; back++) seedDay(raw, 's2', addDays(today, -back), 40, [0, 0, 40]);
  assert.equal('speed' in (await attention()), false);
  // Thin days do not count even when poor.
  for (let back = 0; back < 3; back++) seedDay(raw, 's1', addDays(today, -back), ATTENTION_MIN_SAMPLES - 1, [0, 0, ATTENTION_MIN_SAMPLES - 1]);
  assert.equal('speed' in (await attention()), false);
});

test('the speed audit and the speed report take no more than four dependent round trips each (perf review 2026-09-30)', async (t) => {
  // Five each before: the store, the rate limit, [the vitals days, the published layout], the block data, the sizes.
  // The rate limit now starts with the first read.
  const w = world();
  await ok(await put(w.owner, `${BASE}/draft`, { layout: layoutOf([hero({ image: MEDIA.picture }), grid()]), version: 0 }));
  await ok(await post(w.owner, `${BASE}/publish`, { version: 1 }));
  // rateLimit (worker/lib/ratelimit.ts) awaits one more statement — its stale-window DELETE — on 2 % of the hits
  // that open a window (the audit's first read here): the coin is held so the count is the route's own, every run.
  t.mock.method(Math, 'random', () => 0.5);
  const { waves, db } = wavesD1(w.raw);
  const mount = (a: App) => {
    a.route(BASE, storeLayoutRoutes);
    a.route('/api/merchant/store/speed', storeSpeedRoutes);
  };
  const owner = stubApp(db, { id: OWNER, role: 'merchant', email: 'owner@x.co' }, mount, { env: ENV });
  const figures: Record<string, number> = {};
  for (const path of [`${BASE}/speed`, `${BASE}/speed/report?days=7&device=phone`]) {
    waves.reset();
    await ok(await get(owner, path));
    figures[path] = waves.counts.waves;
  }
  console.log(`waves: ${JSON.stringify(figures)}`);
  for (const [path, n] of Object.entries(figures)) assert.ok(n <= 4, `${path} takes ${n} waves`);
});
