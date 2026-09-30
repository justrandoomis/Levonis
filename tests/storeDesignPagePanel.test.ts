/**
 * THE BUILDER'S MEDIA-EVERYWHERE CONTROLS (P5, docs/MERCHANT_PLATFORM_V2.md
 * storefront B1/B2/L3–L8).
 *
 *   - the Page panel's controls write exactly the schema's keys — the notice,
 *     its link and window, the footer links (≤ 6, reorder, remove), the
 *     background (kind, file, poster, dim, phones) — and what they write
 *     round-trips through the SAME normaliser the server runs, issue-free;
 *   - a draft whose only change is its notice, links or background is
 *     publishable (the change summary counts the page's own keys);
 *   - the slot's weight cap is checked BEFORE an upload: a file over
 *     `max_bytes` is refused with the server's own sentence, figures filled
 *     in, in ar/en/ckb — what travels is what is weighed (PNG/JPEG are
 *     re-encoded first, a GIF / WebP / video goes as picked);
 *   - MEDIA_IN_USE is rendered with its `where`, in the merchant's language,
 *     straight from the real route's refusal; the library grid shows bytes,
 *     «مستخدم في …», a delete only for an unused file, and marks a file too
 *     heavy for the slot;
 *   - the hero's video field shows only where the variant draws a picture,
 *     with the poster rule said next to the picture; a block's schedule is
 *     written and cleared as the schema wants it;
 *   - «معاينة على هاتفي»: the QR's address is the builder's own preview view;
 *   - every new builder word exists in ar, en and hand-written Sorani, and the
 *     four refusal sentences are the refusal table's, verbatim.
 *
 * Run: node --import tsx --test tests/storeDesignPagePanel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, json, put, send, stubApp } from './fixtures/app';
import { MEDIA, OWNER, STORE_ID, seedLayoutStore } from './fixtures/storeLayout';
import { storeLayoutRoutes } from '../worker/routes/storeLayout';
import { LanguageProvider } from '../src/LanguageContext';
import { MEDIA_CAPS, MAX_FOOTER_LINKS } from '../packages/storeLayout/src/blocks';
import { makeBlock, normalizeLayout } from '../packages/storeLayout/src/normalize';
import { starterLayout } from '../packages/storeLayout/src/starters';
import type { StoreLayout } from '../packages/storeLayout/src/schema';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { summarizeChanges } from '../src/components/merchant/storeDesign/editorModel';
import { ownWords, setSchedule, shownSettings, windowOutOfOrder } from '../src/components/merchant/storeDesign/BlockInspector';
import {
  MediaLibraryGrid,
  asLibraryItem,
  libraryRefusal,
  overCap,
  tooHeavyText,
  whereText,
  type LibraryItem,
} from '../src/components/merchant/storeDesign/MediaLibrary';
import { preparedBeforeUpload } from '../src/components/merchant/storeDesign/pickers';
import { fitEdge, posterMoment } from '../src/components/merchant/storeDesign/MediaLibraryPoster';
import { previewAddress } from '../src/components/merchant/storeDesign/PreviewQr';
import { MEDIA_STRINGS, fillSpeed } from '../src/components/merchant/storeDesign/strings';
import { formatBytes } from '../src/components/merchant/storeDesign/refusal';

// panels.tsx brings the storefront's stylesheet (for its theme swatches): a CSS import is stubbed for this file's dynamic imports.
register('data:text/javascript,' + encodeURIComponent('export async function load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true }; return nextLoad(url, context); }'));
const { PagePanel, addFooterLink, moveFooterLink, pageIssues, removeFooterLink, setBackground, setFooterLinks, setNotice, setNoticeLink, setNoticeWindow, withPageChanges } = await import(
  '../src/components/merchant/storeDesign/panels'
);

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const LANGS = ['ar', 'en', 'ckb'] as const;
const T = (ar: string, en = '', ckb = '') => ({ ar, en, ckb });

const base = (): StoreLayout => starterLayout('classic');
function clean(l: StoreLayout): StoreLayout {
  const r = normalizeLayout(l, { ownerUserId: OWNER });
  assert.deepEqual(r.issues, [], JSON.stringify(r.issues));
  return r.layout;
}

function setLanguage(lang: string) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? lang : null), setItem: () => {}, removeItem: () => {} };
}
const inLang = (lang: string, el: ReturnType<typeof createElement>) => {
  setLanguage(lang);
  return renderToStaticMarkup(createElement(LanguageProvider, null, el));
};

// ------------------------------------------------------------ the page's keys

test('the notice controls write header.notice / notice_link / notice_from / notice_until, and nothing else', () => {
  let l = setNotice(base(), T('توصيل مجاني هذا الأسبوع', 'Free delivery this week', 'گەیاندنی بێ بەرامبەر ئەم هەفتەیە'));
  l = setNoticeLink(l, { kind: 'route', route: 'deals' });
  l = setNoticeWindow(l, { from: '2026-10-01T09:00:00.000Z', until: '2026-10-08T21:00:00.000Z' });
  const out = clean(l);
  assert.deepEqual(out.header, {
    variant: 'overlay',
    notice: T('توصيل مجاني هذا الأسبوع', 'Free delivery this week', 'گەیاندنی بێ بەرامبەر ئەم هەفتەیە'),
    notice_link: { kind: 'route', route: 'deals' },
    notice_from: '2026-10-01T09:00:00.000Z',
    notice_until: '2026-10-08T21:00:00.000Z',
  });
  assert.deepEqual(out.blocks, base().blocks, 'no block moved');
  assert.deepEqual(out.tokens, base().tokens);
  // A bound set to '' is taken away, as the normaliser writes it.
  const open = setNoticeWindow(l, { until: '' });
  assert.equal('notice_until' in open.header, false);
  assert.deepEqual(clean(open).header.notice_from, '2026-10-01T09:00:00.000Z');
});

test('footer links: add up to six, reorder, remove — each round-trips; a label-less link is the only one the gate drops', () => {
  let l = base();
  for (let i = 0; i < MAX_FOOTER_LINKS + 2; i++) l = addFooterLink(l);
  assert.equal(l.footer.links.length, MAX_FOOTER_LINKS, 'never more than the schema keeps');
  l = setFooterLinks(
    l,
    l.footer.links.map((x, i) => ({ ...x, label: T(`رابط ${i + 1}`), link: i === 0 ? { kind: 'route', route: 'about' } : { kind: 'none' } }))
  );
  l = moveFooterLink(l, 0, 1);
  assert.deepEqual(l.footer.links.map((x) => x.label.ar), ['رابط 2', 'رابط 1', 'رابط 3', 'رابط 4', 'رابط 5', 'رابط 6']);
  assert.equal(moveFooterLink(l, 0, -1), l, 'the first cannot go up');
  l = removeFooterLink(l, 5);
  const out = clean(l);
  assert.equal(out.footer.links.length, 5);
  assert.deepEqual(out.footer.links[1], { label: T('رابط 1'), link: { kind: 'route', route: 'about' } });
  const blank = normalizeLayout(addFooterLink(base()), { ownerUserId: OWNER });
  assert.equal(blank.layout.footer.links.length, 0);
  assert.deepEqual(blank.issues.map((i) => [i.path, i.code]), [['footer.links[0]', 'dropped_item']]);
});

test('the background: kind, file, poster, dim and phones — a kind change clears the file, a poster lives only beside a video', () => {
  let l = setBackground(base(), { kind: 'image' });
  l = setBackground(l, { media: MEDIA.picture, dim: 'heavy' });
  assert.deepEqual(clean(l).background, { kind: 'image', media: MEDIA.picture, poster: '', dim: 'heavy', phones: false });
  l = setBackground(l, { kind: 'video' });
  assert.equal(l.background.media, '', 'a picture\'s key is no video: the file is cleared with the kind');
  l = setBackground(l, { media: MEDIA.video, poster: MEDIA.picture2, phones: true });
  assert.deepEqual(clean(l).background, { kind: 'video', media: MEDIA.video, poster: MEDIA.picture2, dim: 'heavy', phones: true });
  const none = setBackground(l, { kind: 'none' });
  assert.deepEqual({ media: none.background.media, poster: none.background.poster }, { media: '', poster: '' });
  assert.deepEqual(clean(none).background.kind, 'none');
  assert.equal(setBackground(l, { kind: 'sepia' as never }).background.kind, 'video', 'a kind outside the list changes nothing');
});

test('page-only changes are publishable: the summary counts the notice, the links and the background', () => {
  const live = clean(base());
  const same = withPageChanges(summarizeChanges(live, live), live, live);
  assert.equal(same?.none, true);
  const notice = clean(setNotice(live, T('عرض')));
  assert.equal(summarizeChanges(live, notice).none, true, 'editorModel alone would call it nothing');
  const n = withPageChanges(summarizeChanges(live, notice), live, notice)!;
  assert.deepEqual([n.none, n.header, n.footer], [false, true, false]);
  const links = clean(setFooterLinks(live, [{ label: T('الأسئلة'), link: { kind: 'none' } }]));
  const f = withPageChanges(summarizeChanges(live, links), live, links)!;
  assert.deepEqual([f.none, f.header, f.footer], [false, false, true]);
  const bg = clean(setBackground(setBackground(live, { kind: 'image' }), { media: MEDIA.picture }));
  const b = withPageChanges(summarizeChanges(live, bg), live, bg)!;
  assert.equal(b.none, false);
  assert.equal(b.header, true, 'shown in the dialog until ChangeList has a background row');
  // The builder hands the panel the gate's page issues, per part.
  const issues = normalizeLayout({ ...live, header: { ...live.header, notice_link: { kind: 'external', url: 'javascript:alert(1)' } } }, { ownerUserId: OWNER }).issues;
  assert.deepEqual(pageIssues(issues, 'header').map((i) => [i.field, i.code, i.fatal]), [['notice_link', 'unsafe_link', true]]);
  assert.deepEqual(pageIssues(issues, 'footer'), []);
});

test('the Page panel draws every control, marks a background video without its poster, and says links do not show without a footer', () => {
  let l = setNotice(base(), T('عرض الأسبوع'));
  l = setFooterLinks({ ...l, footer: { ...l.footer, variant: 'none' } }, [{ label: T('الأسئلة'), link: { kind: 'none' } }, { label: T('السياسات'), link: { kind: 'route', route: 'about' } }]);
  l = setBackground(setBackground(l, { kind: 'video' }), { media: MEDIA.video });
  for (const lang of LANGS) {
    const t = MEDIA_STRINGS[lang];
    const html = inLang(lang, createElement(PagePanel, { layout: l, onChange: () => {} }));
    for (const hook of ['data-sd-notice', 'data-sd-footer-links', 'data-sd-background="video"', 'data-sd-poster-required', 'data-sd-add-footer-link']) assert.ok(html.includes(hook), `${lang}: ${hook}`);
    assert.equal((html.match(/data-sd-footer-link="/g) ?? []).length, 2);
    for (const word of [t.page.notice, t.page.links, t.page.background, t.page.phones, t.page.linksNone, t.library.posterRequired]) assert.ok(html.includes(word.replace(/'/g, '&#x27;')), `${lang}: «${word}»`);
    assert.ok(html.includes(fillSpeed(t.library.cap, { max: formatBytes(MEDIA_CAPS.video) })), `${lang}: the video slot's cap is said`);
  }
});

// ------------------------------------------------------------ the weight rule

test('max_bytes BEFORE the upload: over the cap is refused with the server\'s sentence and figures; what travels is what is weighed', () => {
  assert.equal(overCap(1.6 * 1024 * 1024, MEDIA_CAPS.cover), true);
  assert.equal(overCap(MEDIA_CAPS.cover, MEDIA_CAPS.cover), false, 'exactly at the cap is fine');
  assert.equal(overCap(9e9, undefined), false, 'a slot without a cap');
  assert.equal(overCap(undefined, MEDIA_CAPS.poster), false, 'an unmeasured legacy file is never too heavy');
  for (const lang of LANGS) {
    const said = tooHeavyText(MEDIA_STRINGS[lang], 6.2 * 1024 * 1024, MEDIA_CAPS.cover);
    const want = REFUSAL_STRINGS.LAYOUT_MEDIA_TOO_HEAVY[lang].replace('{size}', '6.2 MB').replace('{max}', '1.5 MB');
    assert.equal(said, want, lang);
    // The server's refusal, rendered the same way from its details.
    assert.equal(libraryRefusal({ code: 'LAYOUT_MEDIA_TOO_HEAVY', details: { size: 6.2 * 1024 * 1024, max: MEDIA_CAPS.cover } }, MEDIA_STRINGS[lang], lang), want);
  }
  assert.equal(preparedBeforeUpload({ type: 'image/png' }), true);
  assert.equal(preparedBeforeUpload({ type: 'image/jpeg' }), true);
  for (const type of ['image/gif', 'image/webp', 'image/avif', 'video/mp4']) assert.equal(preparedBeforeUpload({ type }), false, `${type} travels as picked, so its own size is weighed`);
  const picker = read('src/components/merchant/storeDesign/pickers.tsx');
  assert.match(picker, /if \(maxBytes && overCap\(ready\.size, maxBytes\)\)/, 'the weighed size is the prepared one');
  assert.ok(picker.indexOf('overCap(ready.size, maxBytes)') < picker.indexOf("await uploadFile(ready, 'community')"), 'weighed before the upload starts');
  assert.match(picker, /pickUpload\(ready\) === 'session'/, 'above 8 MiB the resumable session (UploadTile) carries it');
  assert.match(picker, /<UploadTile\s+file=\{large\}\s+purpose="community"/);
});

test('MEDIA_IN_USE from the real route is rendered with where, in the merchant\'s language', async () => {
  const raw = freshDb();
  seedLayoutStore(raw);
  const owner = stubApp(asD1(raw), { id: OWNER, role: 'merchant', email: 'owner@x.co' }, (a) => a.route('/api/merchant/store/layout', storeLayoutRoutes));
  const l = { schema_version: 1, theme: 'classic', blocks: [{ id: 'g', type: 'gallery', settings: { images: [{ image: MEDIA.picture }] } }] };
  assert.equal((await put(owner, '/api/merchant/store/layout/draft', { layout: l, version: 0 })).status, 200);
  raw.prepare('UPDATE merchant_stores SET banner_key = ? WHERE id = ?').run(MEDIA.picture, STORE_ID);
  const res = await send(owner, 'DELETE', `/api/merchant/store/layout/media/${MEDIA.picture}`);
  assert.equal(res.status, 409);
  const body = await json(res);
  const refusal = { code: body.code, details: body.details };
  for (const lang of LANGS) {
    const t = MEDIA_STRINGS[lang];
    const where = [t.library.where.layout, t.library.where.store].join(lang === 'en' ? ', ' : '، ');
    assert.equal(libraryRefusal(refusal, t, lang), REFUSAL_STRINGS.MEDIA_IN_USE[lang].replace('{where}', where), lang);
  }
  assert.equal(whereText(MEDIA_STRINGS.ar, ['mystery'], 'ar'), MEDIA_STRINGS.ar.library.where.other, 'an unknown place is still said, never as a code');
  assert.equal(libraryRefusal({ code: 'MEDIA_NOT_FOUND' }, MEDIA_STRINGS.ckb, 'ckb'), REFUSAL_STRINGS.MEDIA_NOT_FOUND.ckb);
  assert.equal(libraryRefusal(new Error('boom'), MEDIA_STRINGS.en, 'en'), MEDIA_STRINGS.en.library.deleteFailed, 'never the raw sentence');
});

test('the library grid: bytes, «مستخدم في …», a delete only for an unused file, a too-heavy file marked and not picked', () => {
  const item = (key: string, bytes: number, used: LibraryItem['used_in']): LibraryItem =>
    asLibraryItem({ key, kind: 'image', mime: 'image/webp', width: 800, height: 600, created_at: '2026-09-30T00:00:00.000Z', byte_size: bytes, used_in: used });
  const list = [
    item(MEDIA.picture, 1_258_291, [{ kind: 'layout', id: 'draft', block_id: 'hero' }, { kind: 'product', id: 'p1' }]),
    item(MEDIA.picture2, 120_000, []),
    item('merchants/owner/public/heavy001.webp', 2_400_000, []),
  ];
  for (const lang of LANGS) {
    const t = MEDIA_STRINGS[lang];
    const html = inLang(lang, createElement(MediaLibraryGrid, { list, kind: 'image', value: MEDIA.picture2, maxBytes: MEDIA_CAPS.cover, t, lang, label: 'lib', onPick: () => {}, onHeavy: () => {}, onDelete: () => {} }));
    assert.ok(html.includes('1.2 MB') && html.includes('117 KB') && html.includes('2.3 MB'), `${lang}: bytes`);
    const used = fillSpeed(t.library.usedIn, { where: whereText(t, ['layout', 'product'], lang) });
    assert.ok(html.includes(used.replace(/'/g, '&#x27;')), `${lang}: «${used}»`);
    assert.equal((html.match(/data-media-delete=/g) ?? []).length, 2, `${lang}: a delete for the two unused files only`);
    assert.doesNotMatch(html, new RegExp(`data-media-delete="${MEDIA.picture}"`));
    assert.match(html, /aria-disabled="true"/, 'the heavy file is not pickable');
    assert.ok(html.includes(t.library.tooHeavyShort.replace(/'/g, '&#x27;')));
    // A plain list of buttons, each named by its place (review 2026-09-30); the chosen one is pressed.
    assert.match(html, /aria-pressed="true"/);
    assert.doesNotMatch(html, /role="listbox"|role="option"/, 'no listbox that owns delete buttons and walks no arrow keys');
    assert.ok(html.includes(fillSpeed(t.library.itemImage, { n: 2, total: 3 }).replace(/'/g, '&#x27;')), `${lang}: a positional name`);
  }
});

// ------------------------------------------------------------ inspector

test('the hero\'s video: offered where the variant draws a picture, «phones» once there is a video, its words from the builder\'s table', () => {
  const names = (variant: string, settings: Record<string, unknown> = {}) => shownSettings({ ...makeBlock('hero', 'h', { variant }), settings: { ...makeBlock('hero', 'h').settings, ...settings } } as never).map(([k]) => k);
  for (const v of ['profile', 'cover', 'split']) {
    assert.ok(names(v).includes('video'), v);
    assert.ok(!names(v).includes('video_on_phone'), `${v}: no video yet`);
    assert.ok(names(v, { video: MEDIA.video }).includes('video_on_phone'), v);
  }
  assert.ok(!names('minimal', { video: MEDIA.video }).includes('video'), 'the minimal hero has no picture to play over');
  const t = MEDIA_STRINGS.ckb;
  assert.deepEqual(ownWords(t, 'hero', 'video', {}), { label: t.hero.video, hint: t.hero.videoHint });
  assert.deepEqual(ownWords(t, 'hero', 'image', { video: MEDIA.video }), { hint: t.hero.posterNote });
  assert.deepEqual(ownWords(t, 'video', 'video', {}), {});
  const inspector = read('src/components/merchant/storeDesign/BlockInspector.tsx');
  assert.match(inspector, /data-sd-poster-required/, 'the poster rule is said next to the picture');
  assert.match(inspector, /setBoth: \(video, poster\) => onChange\(setSetting\(setSetting\(layout, block\.id, 'video', video\), block\.id, slot, poster\)\)/, 'a captured poster lands with its video in ONE change');
});

test('a block\'s schedule is written, ordered and cleared as the schema keeps it', () => {
  const l = base();
  const id = l.blocks[0].id;
  const on = setSchedule(l, id, { from: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual(clean(setSchedule(on, id, { until: '2026-11-01T00:00:00.000Z' })).blocks[0].schedule, { from: '2026-10-01T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' });
  const off = setSchedule(on, id, null);
  assert.equal('schedule' in off.blocks[0], false, 'no bound, no key');
  assert.deepEqual(clean(off), clean(l));
  assert.equal(windowOutOfOrder('2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z'), true);
  assert.equal(windowOutOfOrder('2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'), true, 'an empty window');
  assert.equal(windowOutOfOrder('2026-10-01T00:00:00.000Z', ''), false);
  const bad = normalizeLayout(setSchedule(on, id, { until: '2026-09-01T00:00:00.000Z' }), { ownerUserId: OWNER });
  assert.deepEqual(bad.issues.map((i) => [i.path, i.code]), [['blocks[0].schedule.until', 'invalid_value']], 'the gate would drop the end — the inspector says so first');
});

// ------------------------------------------------------------ poster, QR

test('poster capture takes the frame at 0.5 s (halfway for a shorter clip), scaled down, never up; the QR opens the builder\'s own preview', () => {
  assert.equal(posterMoment(14), 0.5);
  assert.equal(posterMoment(0.6), 0.3);
  assert.equal(posterMoment(Number.NaN), 0.5);
  assert.deepEqual(fitEdge(1920, 1080, 1280), { width: 1280, height: 720 });
  assert.deepEqual(fitEdge(1080, 1920, 1280), { width: 720, height: 1280 });
  assert.deepEqual(fitEdge(640, 360, 1280), { width: 640, height: 360 });
  assert.equal(previewAddress({ origin: 'https://levonis-iq.com', pathname: '/merchant/store/design' }), 'https://levonis-iq.com/merchant/store/design?view=preview');
  assert.equal(previewAddress({ origin: 'https://raf3d.levonis-iq.com', pathname: '/admin/store/design' }), 'https://raf3d.levonis-iq.com/admin/store/design?view=preview');
  const panel = read('src/components/merchant/storeDesign/StoreDesignPanel.tsx');
  assert.match(panel, /const PreviewQr = lazy\(\(\) => import\('\.\/PreviewQr'\)\);/, 'the QR sheet is its own chunk');
  assert.match(panel, /get\('view'\) === 'preview'\) setPhoneView\('preview'\)/, 'the scanned address opens the Preview view');
  assert.match(panel, /<PagePanel layout=\{layout\} onChange=\{\(l, k\) => ed\.change\(l, k \?\? null\)\} page=\{validation\.page\} \/>/);
  assert.match(panel, /withPageChanges\(ed\.changes, ed\.live, validation\.result\.layout\)/);
  assert.match(read('src/components/merchant/storeDesign/pickers.tsx'), /await import\('\.\/MediaLibraryPoster'\)/, 'poster capture is loaded on demand');
});

// ------------------------------------------------------------ words

test('every new builder word is in ar, en and hand-written Sorani; the four refusal sentences are the table\'s verbatim', () => {
  const flat = (o: unknown, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) Object.assign(out, flat(v, `${prefix}${k}.`));
    else out[prefix.replace(/\.$/, '')] = String(o);
    return out;
  };
  const [ar, en, ckb] = LANGS.map((l) => flat(MEDIA_STRINGS[l]));
  const keys = Object.keys(ar);
  assert.ok(keys.length >= 80, `${keys.length} keys`);
  assert.deepEqual(Object.keys(en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ckb).sort(), [...keys].sort());
  const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
  let kurdish = 0;
  for (const k of keys) {
    assert.ok(ar[k].trim() && en[k].trim() && ckb[k].trim(), k);
    assert.notEqual(ckb[k], ar[k], `ckb.${k} is the Arabic`);
    assert.notEqual(ckb[k], en[k], `ckb.${k} is the English`);
    assert.equal(vars(en[k]), vars(ar[k]), `${k}: placeholders`);
    assert.equal(vars(ckb[k]), vars(ar[k]), `${k}: placeholders`);
    if (/[ەۆێڕڵڤگچپژیک]/.test(ckb[k])) kurdish += 1;
  }
  assert.ok(kurdish / keys.length >= 0.95, `only ${kurdish} of ${keys.length} Sorani strings use a Kurdish letter`);
  for (const lang of LANGS) {
    const t = MEDIA_STRINGS[lang].library;
    assert.equal(t.tooHeavy, REFUSAL_STRINGS.LAYOUT_MEDIA_TOO_HEAVY[lang], `${lang}: tooHeavy`);
    assert.equal(t.inUse, REFUSAL_STRINGS.MEDIA_IN_USE[lang], `${lang}: inUse`);
    assert.equal(t.notFound, REFUSAL_STRINGS.MEDIA_NOT_FOUND[lang], `${lang}: notFound`);
    assert.equal(t.posterRequired, REFUSAL_STRINGS.LAYOUT_POSTER_REQUIRED[lang], `${lang}: posterRequired`);
  }
});

test('the builder\'s own refusal line speaks Sorani for the P5 media codes, with the figures and the video it means (review 2026-09-30)', async () => {
  const { builderRefusal } = await import('../src/components/merchant/storeDesign/refusal');
  const locFor = (lang: (typeof LANGS)[number]) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb || ar : ar);
  for (const lang of LANGS) {
    const t = MEDIA_STRINGS[lang];
    const loc = locFor(lang);
    assert.equal(
      builderRefusal({ code: 'LAYOUT_MEDIA_TOO_HEAVY', details: { size: 6_500_000, max: MEDIA_CAPS.cover } }, loc),
      tooHeavyText(t, 6_500_000, MEDIA_CAPS.cover),
      `${lang}: the figures`
    );
    assert.equal(builderRefusal({ code: 'LAYOUT_MEDIA_TOO_HEAVY' }, loc), t.library.tooHeavyShort, `${lang}: no «1 KB over 1 KB» without the figures`);
    assert.equal(
      builderRefusal({ code: 'LAYOUT_POSTER_REQUIRED', details: { paths: ['background.poster', 'blocks[0].settings.image'] } }, loc),
      `${t.library.posterRequired} (${[t.page.video, t.hero.video].join(lang === 'en' ? ', ' : '، ')})`,
      `${lang}: which video lacks its poster`
    );
    assert.equal(
      builderRefusal({ code: 'MEDIA_IN_USE', details: { where: ['post'] } }, loc),
      fillSpeed(t.library.inUse, { where: t.library.where.post }),
      `${lang}: a community post is a place too`
    );
    assert.equal(builderRefusal({ code: 'MEDIA_NOT_FOUND' }, loc), t.library.notFound);
  }
  assert.equal(builderRefusal({ code: 'LAYOUT_POSTER_REQUIRED' }, locFor('ckb')), REFUSAL_STRINGS.LAYOUT_POSTER_REQUIRED.ckb);
  // The autosave keeps the refusal's details, so the status line can say the figures.
  const autosave = read('src/components/merchant/storeDesign/autosave.ts');
  assert.match(autosave, /this\.set\(\{ status: 'error', errorCode: code, errorDetails: details \}\)/);
  assert.match(read('src/components/merchant/storeDesign/StoreDesignPanel.tsx'), /details: ed\.save\.errorDetails/);
});
