/**
 * worker/lib/homeContent.ts — the owner-authored home page.
 *
 * WHY THESE MATTER. `homeBanners` and `homeSectionItems` were stored with no
 * validation beyond "an object under 100KB", and the storefront put their
 * values straight into an <img src> and an <a href>. This file pins the two
 * things that protects: what a link is allowed to be, and that copy written
 * before hero text existed still renders.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlank,
  normalizeBanner,
  normalizeHomeBanners,
  normalizeSectionItems,
  pickText,
  safeLink,
  MAX_BANNERS_PER_SLOT,
  MAX_SECTION_ITEMS,
} from '../worker/lib/homeContent';

// ------------------------------------------------------------------ links

test('an internal path and an http(s) URL are kept', () => {
  assert.equal(safeLink('/products'), '/products');
  assert.equal(safeLink('/products?category=cat_printers'), '/products?category=cat_printers');
  assert.equal(safeLink('https://levonis-iq.com/x'), 'https://levonis-iq.com/x');
  assert.equal(safeLink('http://example.com'), 'http://example.com');
  assert.equal(safeLink('  /products  '), '/products', 'surrounding space is trimmed');
});

test('a script URL is DROPPED, not escaped', () => {
  // There is no banner that legitimately needs one, so the value never gets
  // stored at all — nothing downstream has to remember to filter it.
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    assert.equal(safeLink(bad), '', `${bad} survived`);
  }
});

test('a protocol-relative URL is dropped — it is not an internal path', () => {
  // '//evil.example' starts with a slash but navigates off-site.
  assert.equal(safeLink('//evil.example/x'), '');
});

test('a non-string, an empty string and an over-long URL are dropped', () => {
  assert.equal(safeLink(null), '');
  assert.equal(safeLink(42), '');
  assert.equal(safeLink({}), '');
  assert.equal(safeLink(''), '');
  assert.equal(safeLink('/' + 'a'.repeat(2000)), '');
});

// ------------------------------------------------------------------ text

test('pickText prefers the requested language', () => {
  const t = { ar: 'مرحبا', en: 'Hello', ckb: 'سڵاو' };
  assert.equal(pickText(t, 'ar'), 'مرحبا');
  assert.equal(pickText(t, 'en'), 'Hello');
  assert.equal(pickText(t, 'ckb'), 'سڵاو');
});

test('pickText falls back to a language the owner ACTUALLY wrote', () => {
  // No machine translation anywhere in this project — an unfilled language
  // shows a real string the owner typed, never a generated one.
  assert.equal(pickText({ ar: '', en: 'Hello', ckb: '' }, 'ar'), 'Hello');
  assert.equal(pickText({ ar: 'مرحبا', en: '', ckb: '' }, 'en'), 'مرحبا');
  assert.equal(pickText({ ar: '', en: '', ckb: 'سڵاو' }, 'en'), 'سڵاو');
});

test('pickText on an empty or missing field is an empty string, never a placeholder', () => {
  assert.equal(pickText({ ar: '', en: '', ckb: '' }, 'ar'), '');
  assert.equal(pickText(undefined, 'ar'), '');
});

test('isBlank is true only when every language is empty', () => {
  assert.equal(isBlank({ ar: '', en: '', ckb: '' }), true);
  assert.equal(isBlank({ ar: '', en: 'x', ckb: '' }), false);
});

// --------------------------------------------------------------- banners

test('a pre-hero {id,image,link} banner still normalizes and still renders', () => {
  // The upgrade must not blank a banner the owner uploaded months ago.
  const b = normalizeBanner({ id: 'bn_1', image: '/a.png', link: '/products' });
  assert.ok(b);
  assert.equal(b.id, 'bn_1');
  assert.equal(b.image, '/a.png');
  assert.equal(b.link, '/products');
  assert.deepEqual(b.title, { ar: '', en: '', ckb: '' });
  assert.equal(isBlank(b.title), true, 'an old banner is picture-only, as it always was');
});

test('a hero banner keeps its per-language copy', () => {
  const b = normalizeBanner({
    id: 'bn_2',
    image: '/a.png',
    link: '/products',
    title: { ar: 'عنوان', en: 'Title', ckb: 'ناونیشان' },
    subtitle: { ar: 'وصف', en: 'Sub', ckb: '' },
    cta: { ar: 'تسوق', en: 'Shop', ckb: '' },
  });
  assert.ok(b);
  assert.equal(pickText(b.title, 'en'), 'Title');
  assert.equal(pickText(b.subtitle, 'ckb'), 'وصف', 'falls back to Arabic, not to a translation');
  assert.equal(pickText(b.cta, 'ar'), 'تسوق');
});

test('a banner with a headline but no picture is kept — the hero renders the gradient', () => {
  const b = normalizeBanner({ title: { ar: 'عنوان', en: '', ckb: '' } });
  assert.ok(b);
  assert.equal(b.image, '');
  assert.ok(b.id.startsWith('bn_'), 'an id is generated when the client sent none');
});

test('a banner with neither a picture nor a headline is dropped', () => {
  // It would render as an empty slide the customer has to swipe past.
  assert.equal(normalizeBanner({ id: 'x', link: '/products' }), null);
  assert.equal(normalizeBanner({}), null);
  assert.equal(normalizeBanner(null), null);
  assert.equal(normalizeBanner('a string'), null);
});

test("a banner's javascript: link is stripped while the banner itself survives", () => {
  const b = normalizeBanner({ image: '/a.png', link: 'javascript:alert(1)' });
  assert.ok(b);
  assert.equal(b.link, '', 'the link is gone');
  assert.equal(b.image, '/a.png', 'the picture is not thrown away with it');
});

test('a javascript: IMAGE is stripped too', () => {
  assert.equal(normalizeBanner({ image: 'javascript:alert(1)', title: { ar: 'x', en: '', ckb: '' } })?.image, '');
});

test('text is length-capped rather than rejected', () => {
  const b = normalizeBanner({ image: '/a.png', title: { ar: 'x'.repeat(5000), en: '', ckb: '' } });
  assert.ok(b);
  assert.ok(b.title.ar.length <= 200, `title was ${b.title.ar.length}`);
});

test('normalizeHomeBanners keeps slots, drops junk and caps the count', () => {
  const out = normalizeHomeBanners({
    first_banner: [{ image: '/a.png' }, { id: 'bad' }, { image: '/b.png' }],
    second_banner: 'not an array',
    empty_slot: [{ id: 'nothing-here' }],
    overflow: Array.from({ length: 40 }, (_, i) => ({ image: `/x${i}.png` })),
  });
  assert.equal(out.first_banner.length, 2, 'the entry with no image and no title was dropped');
  assert.equal('second_banner' in out, false, 'a non-array slot is dropped');
  assert.equal('empty_slot' in out, false, 'a slot left with nothing is dropped, not left empty');
  assert.equal(out.overflow.length, MAX_BANNERS_PER_SLOT);
});

test('normalizeHomeBanners on garbage returns an empty object, never throws', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    assert.deepEqual(normalizeHomeBanners(bad), {});
  }
});

// --------------------------------------------------------- section items

test('a section item keeps its label, sub-line, picture and link', () => {
  const out = normalizeSectionItems({
    top_brands: [{ id: 'si_1', title: 'Bambu Lab', subtitle: 'Printers', image: '/b.png', link: '/products?search=Bambu' }],
  });
  assert.deepEqual(out.top_brands[0], {
    id: 'si_1',
    title: 'Bambu Lab',
    subtitle: 'Printers',
    image: '/b.png',
    link: '/products?search=Bambu',
  });
});

test('a section item with neither a label nor a picture is dropped', () => {
  const out = normalizeSectionItems({ top_brands: [{ id: 'si_1', link: '/x' }] });
  assert.equal('top_brands' in out, false);
});

test('a section item keeps its picture when its link is a script URL', () => {
  const out = normalizeSectionItems({ coupons_offers: [{ title: 'Offer', link: 'javascript:alert(1)' }] });
  assert.equal(out.coupons_offers[0].link, '');
  assert.equal(out.coupons_offers[0].title, 'Offer');
});

test('section items are capped', () => {
  const out = normalizeSectionItems({
    categories: Array.from({ length: 100 }, (_, i) => ({ title: `c${i}` })),
  });
  assert.equal(out.categories.length, MAX_SECTION_ITEMS);
});

test('normalizing is idempotent — a stored value re-read stays identical', () => {
  // The value is normalized on write AND on read, so the second pass must be
  // a no-op or the two would disagree about what is stored.
  const once = normalizeHomeBanners({
    first_banner: [
      { id: 'bn_1', image: '/a.png', link: '/products', title: { ar: 'ع', en: 'E', ckb: '' } },
    ],
  });
  assert.deepEqual(normalizeHomeBanners(once), once);

  const items = normalizeSectionItems({ top_brands: [{ id: 'si_1', title: 'B', image: '/b.png' }] });
  assert.deepEqual(normalizeSectionItems(items), items);
});
