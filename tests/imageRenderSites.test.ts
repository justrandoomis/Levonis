/**
 * EVERY PICTURE OF STORED MEDIA ASKS FOR A SMALL COPY (owner 2026-10-13: «أريد
 * تحويل الصور كلها وضغطها بتكون بحجم صغير وليس بحجمها الأصلي الكبير»).
 *
 * Measured before this change: of 67 `<SafeImage>` uses 9 asked for a sized
 * copy, and of ~140 raw `<img>` tags 4 did — every other picture downloaded
 * the stored original, up to 1600 × 1600 for a 36 px thumbnail. This scans
 * src/ and holds the rule from now on:
 *
 *  - a raw `<img>` either takes its `srcset` from the shared builder
 *    (`storeImgProps`, `variantSrcSet` through a local helper) or is on the
 *    list below with a reason — the zoom that must show the original, private
 *    evidence served whole after an access check, a blob preview, a static
 *    asset, an icon that is not a stored picture;
 *  - `<VariantImg>` always says how wide it is drawn (`sizes`);
 *  - an EAGER `<SafeImage>` — the page's largest paint — states its `sizes`
 *    (a lazy one may lean on `LAZY_AUTO_SIZES`);
 *  - a `<source>` carries the copies too.
 *
 * Adding an `<img>` of stored media without a copy now fails here, by name.
 *
 * Run: node --import tsx --test tests/imageRenderSites.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import VariantImg from '../src/components/ui/VariantImg';
import SafeImage, { LAZY_AUTO_SIZES } from '../src/components/ui/SafeImage';
import { LanguageProvider } from '../src/LanguageContext';
import { variantSrcSet } from '../packages/contracts/src/imageSizing';

/** Raw `<img>` tags that deliberately show their file as it is: file → the `src` expression → why. */
const ALLOWED_RAW: Record<string, Record<string, string>> = {
  'src/pages/Product.tsx': { 'activeMedia?.url': 'the zoom (lightbox) shows the stored original itself' },
  'src/components/AdminKyc.tsx': { '`/api/kyc/admin/cases/${shownCase.id}/evidence/${i}`': 'private KYC evidence through its own authorised route' },
  'src/components/merchantApplication/AdminMerchantApplications.tsx': {
    'reviewApi.photoUrl(shown.id)': 'the private merchant-review photo through its own audited reviewer route (no variants exist for it)',
  },
  'src/components/AdminSerials.tsx': { 'ev.url': 'private warranty evidence, served whole after the access check', 'm.file_url': 'a private claim-thread file' },
  'src/components/adminSupport/MessageMedia.tsx': { url: 'a private support attachment' },
  'src/components/adminTradeIn/TradeInDetail.tsx': { 'p.url': 'private trade-in photographs (inspection evidence)', photo: 'the trade-in photo viewer: the original, for inspection' },
  'src/components/adminTradeIn/IntakeSheet.tsx': { 'p.url': 'private intake photographs, admins only' },
  'src/components/chat/ChatAttachment.tsx': { url: 'a private chat attachment' },
  'src/components/chat/cards/DealCards.tsx': { 'fileUrl(f)': 'a print request file through the authorised marketplace route' },
  'src/components/community/requests/OrderTimeline.tsx': { 'e.file.url': 'a private community-order progress photo (its own file route)' },
  // Community V3 R12: a request picture asks its own authorised route for a sized copy (`?w=`,
  // requestImageSrcSet) — private, so no public variant exists for the shared builder to name.
  'src/components/community/requests/RequestFileThumbs.tsx': { 'requestImageSrc(url, 160)': 'a private request picture, sized by its authorised route (?w=)' },
  'src/components/community/requests/RequestWizard.tsx': { objectUrl: 'a blob preview of a picture still on the device (R4)' },
  // The request editor (P1-06, row 268): the same two kinds of picture — a device preview while it is
  // on its way, and the private authorised route asked for a sized copy (`?w=`) once stored.
  'src/components/community/requests/editor/SourceThumb.tsx': { preview: 'a blob preview of a picture still on the device (R4)' },
  'src/components/community/requests/editor/ImageGrid.tsx': {
    'p.preview': 'a blob preview of a picture still on the device (R4)',
    'requestImageSrc(p.url, 320)': 'a private request picture, sized by its authorised route (?w=, requestImageSrcSet)',
  },
  'src/components/community/requests/editor/ImageViewer.tsx': {
    src: 'the in-page viewer: a private request picture sized by its authorised route (?w=1280, requestViewerSrcSet), or its blob preview',
  },
  'src/components/merchant/share/ShareStore.tsx': { icon: 'the generated store icon (/store-icon/), not a stored picture' },
  'src/components/pwa/InstallAppSheet.tsx': { icon: 'a static app icon from /icons/' },
  'src/components/reviews/ReviewSection.tsx': { 'p.url': "the reviewer's own unpublished photos (private until published)", 'igShot.url': 'private evidence of an Instagram post' },
  'src/components/tradeIn/parts.tsx': { 'photo.url': 'private trade-in photographs being uploaded' },
  'src/components/warranty/ClaimForms.tsx': { 'a.url': 'a private warranty-claim attachment' },
  'src/components/warranty/ClaimThreadOverlay.tsx': { 'ev.url': 'private warranty evidence', 'msg.file_url': 'a private claim-thread file' },
  'src/pages/Chat.tsx': { fileUrl: 'a private chat attachment' },
  'src/pages/Support.tsx': { 'm.file_url': 'a private support attachment' },
  'src/components/LogoLoop.tsx': { 'item.src': 'the caller supplies srcSet and sizes with each item' },
  // The workspace frame measured 17 bytes under its own budget (tests/bundleBudget.test.ts,
  // 32 KB) before this change; a srcset here costs ~60. The merchant's own 36 px logo in
  // their back office, cached for a year after the first visit — a follow-up, not a customer page.
  'src/components/merchant/shell/MerchantShell.tsx': { 'store.logoUrl': 'the workspace frame has no budget left for it (17 bytes); back office only' },
};

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...tsxFiles(rel));
    else if (name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

function tagEnd(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0 && s.startsWith('/>', i)) return i + 2;
    else if (depth === 0 && ch === '>') return i + 1;
  }
  return s.length;
}

interface Site { file: string; line: number; tag: string; kind: string }
function sites(): Site[] {
  const out: Site[] = [];
  for (const file of tsxFiles('src')) {
    const s = code(file);
    for (const m of s.matchAll(/<(img|VariantImg|SafeImage|source)\b/g)) {
      const end = tagEnd(s, m.index! + m[0].length);
      out.push({ file, line: s.slice(0, m.index).split('\n').length, tag: s.slice(m.index, end).replace(/\s+/g, ' '), kind: m[1] });
    }
  }
  return out;
}
const srcOf = (tag: string) => /\bsrc=\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(tag)?.[1]?.trim() ?? /\bsrc="([^"]*)"/.exec(tag)?.[1] ?? '';

test('every raw <img> takes its srcset from the shared builder, or is listed here with the reason it shows the file itself', () => {
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const site of sites().filter((x) => x.kind === 'img')) {
    if (site.file === 'src/components/ui/VariantImg.tsx' || site.file === 'src/components/ui/SafeImage.tsx') continue;
    const file = readFileSync(join(ROOT, site.file), 'utf8');
    const shared = /\{\.\.\.storeImgProps\(/.test(site.tag) || (/\bsrcSet=\{/.test(site.tag) && /\bvariantSrcSet\b/.test(file));
    if (shared) continue;
    const reason = ALLOWED_RAW[site.file]?.[srcOf(site.tag)];
    if (reason) {
      used.add(`${site.file}|${srcOf(site.tag)}`);
      continue;
    }
    offenders.push(`${site.file}:${site.line} src={${srcOf(site.tag)}}`);
  }
  assert.deepEqual(offenders, [], 'an <img> of stored media downloads the original: use ui/VariantImg (or storeImgProps on a store page)');
  // A stale entry is a reason nobody needs any more.
  const stale = Object.entries(ALLOWED_RAW).flatMap(([file, srcs]) => Object.keys(srcs).filter((src) => !used.has(`${file}|${src}`)).map((src) => `${file} ${src}`));
  assert.deepEqual(stale, [], 'remove allow-list entries that no longer match a tag');
});

test('every <VariantImg> says how wide it is drawn, and every eager <SafeImage> states its sizes', () => {
  const all = sites();
  const variant = all.filter((x) => x.kind === 'VariantImg' && x.file !== 'src/components/ui/VariantImg.tsx');
  assert.ok(variant.length >= 70, `the raw sites moved onto VariantImg (${variant.length})`);
  assert.deepEqual(variant.filter((x) => !/\bsizes=/.test(x.tag)).map((x) => `${x.file}:${x.line}`), []);
  const eager = all.filter((x) => x.kind === 'SafeImage' && /\beager\b/.test(x.tag));
  assert.ok(eager.length >= 8);
  assert.deepEqual(eager.filter((x) => !/\bsizes=/.test(x.tag)).map((x) => `${x.file}:${x.line}`), [], 'the largest paint must say its size');
  const sources = all.filter((x) => x.kind === 'source');
  assert.deepEqual(sources.filter((x) => !/srcSet=\{phoneSet \?\? phone\}/.test(x.tag)).map((x) => `${x.file}:${x.line}`), []);
});

test('the customer pages the owner measured name a size at every picture', () => {
  for (const rel of [
    'src/components/home/Hero.tsx', 'src/components/listing/ProductList.tsx', 'src/components/search/LiveSearch.tsx',
    'src/pages/UsedPrinters.tsx', 'src/components/finder/ResultCards.tsx', 'src/pages/Cart.tsx', 'src/pages/OrderDetail.tsx',
    'src/components/bundles/BundleTile.tsx', 'src/pages/BundleDetail.tsx', 'src/components/community/feed/PostCard.tsx',
  ]) {
    const tags = sites().filter((x) => x.file === rel && (x.kind === 'SafeImage' || x.kind === 'VariantImg'));
    assert.ok(tags.length > 0, rel);
    for (const t of tags) assert.match(t.tag, /\bsizes=/, `${rel}:${t.line}`);
  }
});

const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(LanguageProvider, { children: el }));

test('VariantImg: copies for a public /files/ still, the caller\'s sizes, lazy and async — and any other source untouched', () => {
  const html = renderToStaticMarkup(createElement(VariantImg, { src: '/files/users/u1/avatar/me.webp', sizes: '32px', alt: '', className: 'w-8 h-8' }));
  assert.ok(html.includes(`srcSet="${variantSrcSet('/files/users/u1/avatar/me.webp')}"`));
  assert.match(html, /sizes="32px"/);
  assert.match(html, /loading="lazy"/);
  assert.match(html, /decoding="async"/);
  assert.match(html, /class="w-8 h-8"/);
  const trimmed = renderToStaticMarkup(createElement(VariantImg, { src: '/files/products/a.webp', sizes: '64px', naturalWidth: 500 }));
  assert.ok(trimmed.includes('?w=640 500w') && !trimmed.includes('?w=800'));
  const priority = renderToStaticMarkup(createElement(VariantImg, { src: '/files/products/a.webp', sizes: '100vw', priority: true }));
  assert.match(priority, /loading="eager"/);
  assert.match(priority, /fetchPriority="high"/);
  for (const src of ['blob:https://levonis-iq.com/1', '/files/chat/c1/attachments/a.webp', 'https://api.dicebear.com/9.x/initials/svg?seed=A', '/files/products/a.gif']) {
    const plain = renderToStaticMarkup(createElement(VariantImg, { src, sizes: '32px' }));
    assert.doesNotMatch(plain, /srcSet=|sizes=/, src);
  }
});

test('SafeImage: copies by default; a lazy picture without sizes leans on `auto`; an eager one without sizes keeps its one file', () => {
  const lazy = render(createElement(SafeImage, { src: '/files/products/a.webp', alt: '' }));
  assert.ok(lazy.includes(`srcSet="${variantSrcSet('/files/products/a.webp')}"`));
  assert.ok(lazy.includes(`sizes="${LAZY_AUTO_SIZES}"`));
  const sized = render(createElement(SafeImage, { src: '/files/products/a.webp', alt: '', sizes: '64px', naturalWidth: 1254 }));
  assert.match(sized, /sizes="64px"/);
  assert.ok(sized.includes('?w=1280 1254w'));
  const eager = render(createElement(SafeImage, { src: '/files/products/a.webp', alt: '', eager: true }));
  assert.doesNotMatch(eager, /srcSet=/, 'an eager picture must state its size to get copies');
  const chat = render(createElement(SafeImage, { src: '/files/chat/c1/attachments/a.webp', alt: '', sizes: '64px' }));
  assert.doesNotMatch(chat, /srcSet=/, 'a private key keeps its one address');
});

test('the scan sees the whole tree (a guard against a scanner that silently finds nothing)', () => {
  const all = sites();
  assert.ok(all.length > 180, `${all.length} picture sites`);
  assert.ok(relative(ROOT, join(ROOT, 'src')) === 'src');
});
