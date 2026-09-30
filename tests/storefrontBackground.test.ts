/**
 * MEDIA EVERYWHERE ON THE STORE PAGE (P5, docs/MERCHANT_PLATFORM_V2.md
 * storefront L3/L4/L6/L7/L8, §5, §8) — the renderer's half.
 *
 *   - a video (hero or background) NEVER mounts under reduced motion, under
 *     Save-Data, or on a phone by default; the background's may play on a
 *     phone only when the merchant ticked «phones», the hero's only with
 *     `video_on_phone`; the builder's preview never mounts one;
 *   - the still is ALWAYS there — the background's picture (or a video's
 *     poster) and the hero's cover are in the first markup, before any
 *     script has read the device; the video is its own tiny lazy chunk
 *     (./StoreVideo.tsx), never the non-classic blocks' chunk;
 *   - EXACTLY ONE <video> at a time: the hero's (after the visitor's tap)
 *     or the background's, never both;
 *   - over a background every block, the notice and the footer sit on the
 *     theme's own opaque ground — no text is ever read off a picture — and the
 *     glow is off; the dim is one of three overlay classes the app ships;
 *   - the notice line: after the first block (under the bar for `bar`), inside
 *     its window at the page's clock, hidable for the visit;
 *   - scheduled blocks: the live page shows a block only inside its window and
 *     falls back to the classic page when nothing is left; the preview shows
 *     every block, marked «مجدول»;
 *   - footer links: a label with a destination is a link, one without is text.
 *
 * The runtime behaviour (idle, a tap, the device) is driven in a real browser
 * by scripts/e2e-storefront-media.mjs; this file pins the rules and the markup.
 *
 * Run: node --import tsx --test tests/storefrontBackground.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { MEDIA } from './fixtures/storeLayout';
import { attributeValues, fixtureStore, renderStore, visibleText } from './fixtures/storefrontRender';
import { normalizeLayout } from '../packages/storeLayout/src/normalize';
import type { StoreLayout } from '../packages/storeLayout/src/schema';
import {
  CAREFUL_ENV,
  backgroundVideoAllowed,
  heroVideoAllowed,
  isAnimatedBackground,
  setHeroPlaying,
  videosToMount,
  type MediaEnv,
} from '../src/components/storefront/BackgroundMedia';
import { BACKGROUND_DIM, backgroundActive, dimClass } from '../src/components/storefront/theme';
import { noticeKey, noticeLive } from '../src/components/storefront/StoreHeader';
import StoreRenderer, { blocksNow } from '../src/components/storefront/StoreRenderer';
import { StorefrontRuntimeProvider } from '../src/components/storefront/runtime';
import { previewRuntime } from '../src/components/storefront/preview';
import type { StorefrontStore } from '../src/components/storefront/types';
import { LanguageProvider } from '../src/LanguageContext';
import { MemoryRouter } from 'react-router-dom';
import { prerender } from 'react-dom/static';
import StoreVideo from '../src/components/storefront/StoreVideo';
import { STOREFRONT_STRINGS } from '../src/components/storefront/strings';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const T = (ar: string, en = '') => ({ ar, en, ckb: '' });
const POSTER = MEDIA.picture;
const CLIP = MEDIA.video;
const NOW = '2026-10-01T12:00:00.000Z';

const env = (over: Partial<MediaEnv>): MediaEnv => ({ reduced: false, saveData: false, wide: false, ...over });

/** The renderer at a given clock (the fixture's renderStore, plus `now`). */
async function renderAt(store: StorefrontStore, l: StoreLayout, now: string): Promise<string> {
  await renderStore(store, { layout: l }); // loads the lazy chunks once, as the fixture does
  const tree = createElement(
    MemoryRouter,
    null,
    createElement(LanguageProvider, null, createElement(StorefrontRuntimeProvider, { value: previewRuntime() }, createElement(StoreRenderer, { store, layout: l, now })))
  );
  const { prelude } = await prerender(tree, { progressiveChunkSize: Number.MAX_SAFE_INTEGER });
  return new Response(prelude as unknown as ReadableStream).text();
}

function layout(raw: Record<string, unknown>): StoreLayout {
  const r = normalizeLayout({ schema_version: 1, theme: 'classic', ...raw }, { ownerUserId: 'owner' });
  assert.deepEqual(r.issues.filter((i) => i.fatal), [], JSON.stringify(r.issues));
  return r.layout;
}

const HERO_WITH_VIDEO = { id: 'hero', type: 'hero', variant: 'profile', settings: { image: POSTER, video: CLIP } };
const VIDEO_BG = { kind: 'video', media: CLIP, poster: MEDIA.picture2, dim: 'medium', phones: false };

// ------------------------------------------------------------------ the rules

test('a video never plays under reduced motion or Save-Data; on a phone only when the merchant allowed it', () => {
  for (const phones of [false, true]) {
    assert.equal(backgroundVideoAllowed(env({ reduced: true, wide: true }), phones), false, 'reduced motion, wide');
    assert.equal(backgroundVideoAllowed(env({ saveData: true, wide: true }), phones), false, 'Save-Data, wide');
    assert.equal(heroVideoAllowed(env({ reduced: true, wide: true }), phones), false);
    assert.equal(heroVideoAllowed(env({ saveData: true, wide: true }), phones), false);
  }
  assert.equal(backgroundVideoAllowed(env({ wide: false }), false), false, 'a phone, by default, sees the still');
  assert.equal(backgroundVideoAllowed(env({ wide: false }), true), true, '«phones» ticked');
  assert.equal(backgroundVideoAllowed(env({ wide: true }), false), true, 'a wide page');
  assert.equal(heroVideoAllowed(env({ wide: false }), false), false, 'the hero on a phone, by default: the cover only');
  assert.equal(heroVideoAllowed(env({ wide: false }), true), true, 'video_on_phone');
  assert.equal(heroVideoAllowed(env({ wide: true }), false), true);
  // Before the client has read the device (and on the server), nothing moves.
  assert.equal(backgroundVideoAllowed(CAREFUL_ENV, true), false);
  assert.equal(heroVideoAllowed(CAREFUL_ENV, true), false);
});

test('exactly one <video> at a time: the hero\'s once started, else the background\'s — never both', () => {
  for (const heroOffered of [false, true])
    for (const heroPlaying of [false, true])
      for (const backgroundAllowed of [false, true])
        for (const backgroundStopped of [false, true]) {
          const m = videosToMount({ heroOffered, heroPlaying, backgroundAllowed, backgroundStopped });
          assert.ok(!(m.hero && m.background), JSON.stringify({ heroOffered, heroPlaying, backgroundAllowed, backgroundStopped }));
          if (m.hero) assert.ok(heroOffered && heroPlaying);
          if (m.background) assert.ok(backgroundAllowed && !backgroundStopped && !heroPlaying);
        }
  assert.deepEqual(videosToMount({ heroOffered: true, heroPlaying: true, backgroundAllowed: true, backgroundStopped: false }), { hero: true, background: false });
  assert.deepEqual(videosToMount({ heroOffered: true, heroPlaying: false, backgroundAllowed: true, backgroundStopped: false }), { hero: false, background: true });
  assert.deepEqual(videosToMount({ heroOffered: true, heroPlaying: false, backgroundAllowed: true, backgroundStopped: true }), { hero: false, background: false }, 'the visitor stopped it');
});

test('the dim is a closed table of overlay classes; only a background with a file is painted', () => {
  assert.deepEqual(BACKGROUND_DIM, { light: 'bg-black/45', medium: 'bg-black/60', heavy: 'bg-black/75' });
  assert.equal(dimClass('heavy'), 'bg-black/75');
  for (const junk of ['constructor', '__proto__', 'toString', 'bg-red-500', '', null, 3]) assert.equal(dimClass(junk), 'bg-black/60', String(junk));
  assert.equal(backgroundActive({ kind: 'none', media: POSTER }), false);
  assert.equal(backgroundActive({ kind: 'image', media: '' }), false);
  assert.equal(backgroundActive({ kind: 'video', media: CLIP }), true);
  assert.equal(backgroundActive({ kind: 'sepia', media: POSTER }), false);
  assert.equal(backgroundActive(null), false);
});

test('the video element: muted, inline, looping, preload only once mounted, hidden from assistive tech, fading in by opacity', () => {
  const html = renderToStaticMarkup(createElement(StoreVideo, { src: `/files/${CLIP}`, poster: `/files/${POSTER}` }));
  assert.equal((html.match(/<video/g) ?? []).length, 1);
  for (const a of ['muted=""', 'playsInline=""', 'loop=""', 'autoPlay=""', 'preload="auto"', 'aria-hidden="true"', `poster="/files/${POSTER}"`]) assert.ok(html.includes(a), a);
  assert.match(html, /opacity-0/, 'invisible until frames play');
  assert.match(html, /motion-reduce:transition-none/);
  assert.doesNotMatch(html, /controls/);
});

// ------------------------------------------------------------------ the markup

test('live page, background video + hero video: the stills are in the first markup, no <video> is, and nothing is read off the picture', async () => {
  setHeroPlaying(false);
  const store = await fixtureStore();
  const l = layout({ background: VIDEO_BG, blocks: [HERO_WITH_VIDEO, { id: 'tabs', type: 'tabs' }] });
  const html = await renderStore({ ...store, layout: l }, { layout: l, runtime: { mode: 'live' } });
  assert.equal((html.match(/<video/g) ?? []).length, 0, 'no video before the client has read the device and gone idle');
  assert.doesNotMatch(html, /<script|<template/, 'the lazy pieces render in place, as plain markup');
  const srcs = attributeValues(html, 'src');
  assert.ok(srcs.includes(`/files/${MEDIA.picture2}`), 'the background\'s poster paints');
  assert.ok(srcs.includes(`/files/${POSTER}`), 'the hero\'s cover — its video\'s poster — paints');
  assert.match(html, /data-sf-background="video"[^>]*class="fixed inset-0 z-0 pointer-events-none"/, 'the layer is fixed to the viewport on the live page');
  assert.match(html, /class="absolute inset-0 bg-black\/60"/, 'the medium dim');
  assert.match(html, /class="@container relative z-0" data-sf-bg="video"/);
  assert.doesNotMatch(html, /sf-glow/, 'no glow over a picture');
  // Every block sits in a column card on the theme's own opaque ground.
  for (const id of ['hero', 'tabs']) {
    const at = html.indexOf(`data-block-id="${id}"`);
    assert.ok(at > 0, id);
    assert.match(html.slice(at, at + 400), /class="sf-col sf-bg sf-r-lg overflow-hidden border border-white\/10 empty:hidden/, `${id} is carded`);
  }
  assert.doesNotMatch(html, /data-hero-video=/, 'the hero\'s play control waits for the device reading too');
});

test('the builder\'s preview: the layer is absolute with a sticky still, no video ever, and the hero\'s play control drawn inert', async () => {
  const store = await fixtureStore();
  const l = layout({ background: { ...VIDEO_BG, phones: true }, blocks: [HERO_WITH_VIDEO, { id: 'tabs', type: 'tabs' }] });
  const html = await renderStore({ ...store, layout: l }, { layout: l });
  assert.equal((html.match(/<video/g) ?? []).length, 0);
  assert.match(html, /data-sf-background="video"[^>]*class="absolute inset-0 z-0 pointer-events-none"/);
  assert.match(html, /class="sticky top-0 h-dvh max-h-full w-full"/);
  assert.match(html, /data-hero-video="preview"/, 'the merchant sees where the play control sits');
});

test('an image background paints the picture itself; a GIF is MOVING media — its still first, never an animated <img> before the device says it may move', async () => {
  const store = await fixtureStore();
  const pic = MEDIA.picture;
  const still = layout({ background: { kind: 'image', media: pic, dim: 'heavy', phones: false }, blocks: [{ id: 'text', type: 'text', settings: { body: T('مرحبًا') } }] });
  const picHtml = await renderStore({ ...store, layout: still }, { layout: still, runtime: { mode: 'live' } });
  assert.ok(attributeValues(picHtml, 'src').includes(`/files/${pic}`), 'phones included — a picture is its own still');
  assert.match(picHtml, /bg-black\/75/);
  assert.match(picHtml, /data-sf-bg="image"/);
  // A GIF (review 2026-09-30): under the video's own rule. The first markup is the careful answer
  // (no motion until the device is read), so the animated file is not an <img> there.
  const gif = 'merchants/owner/public/bgloop01.gif';
  const l = layout({ background: { kind: 'image', media: gif, dim: 'heavy', phones: false }, blocks: [{ id: 'text', type: 'text', settings: { body: T('مرحبًا') } }] });
  const html = await renderStore({ ...store, layout: l }, { layout: l, runtime: { mode: 'live' } });
  assert.ok(!attributeValues(html, 'src').includes(`/files/${gif}`), 'no moving GIF in the careful first paint');
  assert.match(html, /data-sf-bg="image"/);
  assert.equal(isAnimatedBackground({ kind: 'image', media: gif }), true);
  assert.equal(isAnimatedBackground({ kind: 'image', media: pic }), false);
  assert.equal(isAnimatedBackground({ kind: 'video', media: CLIP }), false, 'a video is moving media by its own kind');
  // It moves exactly where a video may, and it has the same «stop».
  assert.equal(backgroundVideoAllowed(env({ reduced: true, wide: true }), true), false);
  const media = read('src/components/storefront/BackgroundMedia.tsx');
  assert.match(media, /const animates = background\.kind === 'video' \|\| isAnimatedBackground\(background\);/);
  assert.match(read('src/components/storefront/BackgroundLayer.tsx'), /props\.background\.kind === 'image' && \/\\\.gif\$\/i\.test/, 'the door draws the «stop» for a GIF');
  assert.doesNotMatch(media, /aria-pressed=\{/, 'the play/stop controls say their action in words, not beside a pressed state');
  const plain = layout({ blocks: [{ id: 'text', type: 'text', settings: { body: T('مرحبًا') } }] });
  const bare = await renderStore({ ...store, layout: plain }, { layout: plain, runtime: { mode: 'live' } });
  assert.match(bare, /sf-glow/);
  assert.doesNotMatch(bare, /data-sf-bg|data-sf-background|sf-col sf-bg sf-r-lg/);
});

// ------------------------------------------------------------------ notice

test('the notice line: after the first block, under the bar for `bar`, only inside its window, keyed on itself', async () => {
  const store = await fixtureStore();
  const blocks = [{ id: 'hero', type: 'hero' }, { id: 'text', type: 'text', settings: { body: T('نص') } }];
  const notice = { notice: T('توصيل مجاني هذا الأسبوع', 'Free delivery this week'), notice_link: { kind: 'route', route: 'products' } };
  const over = layout({ header: { variant: 'overlay', ...notice }, blocks });
  const html = await renderStore({ ...store, layout: over }, { layout: over });
  const at = html.indexOf('data-store-notice');
  assert.ok(at > html.indexOf('data-block-id="hero"') && at < html.indexOf('data-block-id="text"'), 'between the first and second block');
  assert.ok(visibleText(html).includes('توصيل مجاني هذا الأسبوع'));
  assert.match(html, /role="note"/);
  assert.match(html, new RegExp(`aria-label="${STOREFRONT_STRINGS.ar.media.hideNotice}"`), 'the hide control is named');
  const bar = layout({ header: { variant: 'bar', ...notice }, blocks });
  const barHtml = await renderStore({ ...store, layout: bar }, { layout: bar });
  assert.ok(barHtml.indexOf('data-store-notice') < barHtml.indexOf('data-block-id="hero"'), 'under the bar, before the blocks');
  // The window, judged at the page's clock.
  assert.equal(noticeLive({ notice_from: '2026-10-02T00:00:00.000Z' }, NOW), false, 'not yet');
  assert.equal(noticeLive({ notice_until: '2026-10-01T12:00:00.000Z' }, NOW), false, 'the end is exclusive');
  assert.equal(noticeLive({ notice_from: '2026-09-01T00:00:00.000Z', notice_until: '2026-11-01T00:00:00.000Z' }, NOW), true);
  assert.equal(noticeLive({}, 'not a date'), true);
  // `now` is the page's clock — the host's, when it passes one: the same notice is hidden before its window and shown inside it.
  const later = layout({ header: { variant: 'overlay', ...notice, notice_from: '2026-12-01T00:00:00.000Z' }, blocks });
  assert.doesNotMatch(await renderAt({ ...store, layout: later }, later, NOW), /data-store-notice/);
  assert.match(await renderAt({ ...store, layout: later }, later, '2026-12-02T00:00:00.000Z'), /data-store-notice/);
  assert.notEqual(noticeKey('s1', over.header), noticeKey('s1', { ...over.header, notice: T('نص آخر') }), 'a new notice shows again after a «hide»');
  assert.equal(noticeKey('s1', over.header), noticeKey('s1', { ...over.header }));
  assert.match(noticeKey('s1', over.header), /^lv_notice_s1_[0-9a-z]+$/);
});

// ------------------------------------------------------------------ schedule

test('scheduled blocks: live shows a block only inside its window (else the classic page), the preview shows every one, marked', async () => {
  const store = await fixtureStore();
  const l = layout({
    blocks: [
      { id: 'always', type: 'text', settings: { body: T('دائم') } },
      { id: 'past', type: 'text', settings: { body: T('انتهى') }, schedule: { from: '2026-01-01T00:00:00.000Z', until: '2026-02-01T00:00:00.000Z' } },
      { id: 'soon', type: 'text', settings: { body: T('قريبًا') }, schedule: { from: '2027-01-01T00:00:00.000Z', until: '' } },
      { id: 'now', type: 'text', settings: { body: T('الآن') }, schedule: { from: '2026-09-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z' } },
    ],
  });
  assert.deepEqual(blocksNow(l, store, NOW, true).map((b) => b.id), ['always', 'now']);
  assert.deepEqual(blocksNow(l, store, NOW, false).map((b) => b.id), ['always', 'past', 'soon', 'now']);
  const allLater = layout({ blocks: [{ id: 'soon', type: 'text', settings: { body: T('قريبًا') }, schedule: { from: '2027-01-01T00:00:00.000Z', until: '' } }] });
  assert.deepEqual(blocksNow(allLater, store, NOW, true).map((b) => b.type), ['hero', 'tabs'], 'nothing left: the classic page, never an empty one');
  const preview = await renderStore({ ...store, layout: l }, { layout: l });
  assert.deepEqual(attributeValues(preview, 'data-block-id'), ['always', 'past', 'soon', 'now']);
  assert.equal((preview.match(/data-scheduled-mark=""/g) ?? []).length, 3, 'the three scheduled blocks are marked');
  assert.ok(visibleText(preview).includes(STOREFRONT_STRINGS.ar.media.scheduled));
  assert.match(preview, /data-block-id="past" data-scheduled="" class=""><div class="sf-col relative rounded-xl border border-dashed border-white\/30" data-scheduled-frame="">/);
});

// ------------------------------------------------------------------ footer

test('footer links: a label with a destination is a link, one without is text, and `none` draws nothing', async () => {
  const store = await fixtureStore();
  const footer = {
    variant: 'standard',
    links: [
      { label: T('الأسئلة الشائعة', 'FAQ'), link: { kind: 'route', route: 'about' } },
      { label: T('ساعات العمل'), link: { kind: 'none' } },
      { label: T('إنستغرام'), link: { kind: 'external', url: 'https://instagram.com/raf3d' } },
    ],
  };
  const l = layout({ footer, blocks: [{ id: 'text', type: 'text', settings: { body: T('نص') } }] });
  const html = await renderStore({ ...store, layout: l }, { layout: l });
  const nav = html.slice(html.indexOf('data-store-footer-links'));
  assert.match(html, new RegExp(`aria-label="${STOREFRONT_STRINGS.ar.media.footerLinks}"[^>]*data-store-footer-links`));
  assert.ok(visibleText(nav).includes('الأسئلة الشائعة') && visibleText(nav).includes('ساعات العمل'));
  assert.ok(attributeValues(nav, 'href').includes('https://instagram.com/raf3d'));
  assert.match(nav, /target="_blank" rel="noopener noreferrer nofollow"/);
  const none = layout({ footer: { ...footer, variant: 'none' }, blocks: [{ id: 'text', type: 'text', settings: { body: T('نص') } }] });
  assert.doesNotMatch(await renderStore({ ...store, layout: none }, { layout: none }), /data-store-footer-links/);
});

// ------------------------------------------------------------------ source rules

test('the video is lazy, the renderer spends no new CSS, and every new word exists in three languages', () => {
  const layer = read('src/components/storefront/BackgroundMedia.tsx');
  assert.match(layer, /const StoreVideo = lazy\(\(\) => import\('\.\/StoreVideo'\)\);/);
  assert.doesNotMatch(layer, /^import[^;]*from '\.\/StoreVideo'/m, 'the video element is imported statically');
  assert.doesNotMatch(layer, /^import[^;]*from '\.\/blocks\//m, 'the video is imported statically');
  // The storefront chunk carries only the door's lazy wrappers (47 KB budget): the layer, the rules and the
  // hero's pieces are one lazy chunk, fetched by a page that has a background or a hero video.
  const door = read('src/components/storefront/BackgroundLayer.tsx');
  assert.match(door, /const media = \(\) => import\('\.\/BackgroundMedia'\);/);
  assert.doesNotMatch(door, /^import[^;]*from '\.\/BackgroundMedia'/m, 'the door imports the pieces statically');
  for (const f of ['StoreRenderer.tsx', 'blocks/Hero.tsx', 'blocks/HeroVariants.tsx']) {
    assert.doesNotMatch(read(`src/components/storefront/${f}`), /from '\.{1,2}\/BackgroundMedia'/, `${f} imports the pieces statically`);
  }
  // A classic page with a background video fetches the tiny video chunk, never the 9 KB of non-classic blocks (review 2026-09-30).
  for (const f of ['blocks/extra.tsx', 'blocks/HeroVariants.tsx']) {
    assert.doesNotMatch(read(`src/components/storefront/${f}`), /StoreVideo/, `${f} carries the video element`);
  }
  // theme.css is untouched by P5: the dims are shipped utilities and the cards the theme's own ground.
  assert.doesNotMatch(read('src/components/storefront/theme.css'), /data-sf-bg|data-sf-dim/);
  const keys = Object.keys(STOREFRONT_STRINGS.ar.media);
  for (const lang of ['en', 'ckb'] as const) assert.deepEqual(Object.keys(STOREFRONT_STRINGS[lang].media), keys, lang);
  for (const k of keys) {
    const [ar, en, ckb] = (['ar', 'en', 'ckb'] as const).map((l) => (STOREFRONT_STRINGS[l].media as Record<string, string>)[k]);
    assert.ok(ar && en && ckb, k);
    assert.notEqual(ckb, ar, `${k}: the Sorani is the Arabic`);
    assert.notEqual(ckb, en, `${k}: the Sorani is the English`);
    assert.match(ckb, /[ەۆێڕڵڤگچپژیک]/, `${k}: not written in Sorani`);
  }
});
