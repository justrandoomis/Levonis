/**
 * THE STORE LAYOUT SCHEMA (packages/storeLayout) — merchant platform wave 2,
 * stream W2-C, docs/MERCHANT_PLATFORM.md §4.4.
 *
 * Every block type, every kind of setting and its bounds, the theme presets,
 * the default layout that reproduces the pre-builder storefront, the data a
 * layout asks the database for, and the lists this package mirrors from the
 * server. The refusals of hostile input are tests/storeLayoutMalicious.test.ts;
 * the draft / publish / restore contract is tests/storeLayoutRoutes.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { BLOCKS, BLOCK_TYPES, blockMax, WIDGET_ICON_NAMES, type BlockType, type FieldSpec } from '../packages/storeLayout/src/blocks';
import { applyTheme, emptyLayout, makeBlock, normalizeLayout, renderableBlocks } from '../packages/storeLayout/src/normalize';
import { defaultLayoutFromStore } from '../packages/storeLayout/src/defaults';
import { collectDataNeeds, MAX_PRODUCT_QUERIES } from '../packages/storeLayout/src/data';
import { collectLayoutRefs, dropLayoutRefs } from '../packages/storeLayout/src/verify';
import { cleanText, pickText } from '../packages/storeLayout/src/text';
import { mediaKey, mediaSrc, safeExternalUrl, socialHandle, socialHref, SOCIAL_PROVIDER_NAMES } from '../packages/storeLayout/src/refs';
import { STORE_ACCENTS, THEME_NAMES, THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES } from '../packages/storeLayout/src/tokens';
import { MAX_BLOCKS, MAX_LAYOUT_BYTES, type StoreLayout } from '../packages/storeLayout/src/schema';
import { safeLink } from '../worker/lib/homeContent';
import { WIDGET_ICONS } from '../worker/routes/merchant';

const OWNER = 'u_owner';
const key = (n: string, ext = 'webp') => `merchants/${OWNER}/public/${n}.${ext}`;
const layoutOf = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ schema_version: 1, blocks, ...extra });
const norm = (input: unknown) => normalizeLayout(input, { ownerUserId: OWNER });
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);
/** The first block's settings, read as the plain object they are. */
const set0 = (r: { layout: { blocks: Array<{ settings: unknown }> } }) => r.layout.blocks[0].settings as Record<string, unknown>;

function defaultOf(spec: FieldSpec): unknown {
  switch (spec.t) {
    case 'bool':
    case 'enum':
    case 'int':
      return spec.d;
    case 'text':
      return { ar: '', en: '', ckb: '' };
    case 'media':
    case 'date':
    case 'ref':
      return '';
    case 'link':
      return { kind: 'none' };
    case 'set':
      return [...spec.d];
    default:
      return [];
  }
}

// ------------------------------------------------------------- the registry

test('there are 27 block types, and every brief-named type is one of them', () => {
  const named = [
    'hero', 'banner', 'image_text', 'products_grid', 'products_carousel', 'featured_products', 'collections', 'deals',
    'coupon_banner', 'countdown', 'services', 'showcase', 'reviews', 'faq', 'text', 'gallery', 'video', 'social_links',
    'cta', 'contact', 'delivery_info', 'printers', 'custom_request_cta', 'stats', 'info_cards',
  ];
  for (const t of named) assert.ok((BLOCK_TYPES as string[]).includes(t), `${t} is missing from the registry`);
  assert.deepEqual([...BLOCK_TYPES].sort(), [...named, 'tabs', 'about'].sort());
});

test('every block type normalises from nothing to its declared defaults, with no issue', () => {
  for (const type of BLOCK_TYPES) {
    const r = norm(layoutOf([{ type, id: 'b1' }]));
    assert.deepEqual(r.issues, [], `${type}: ${JSON.stringify(r.issues)}`);
    const b = r.layout.blocks[0];
    assert.equal(b.type, type);
    assert.equal(b.variant, BLOCKS[type].variants[0], `${type}: the first variant is the default`);
    assert.deepEqual(b.visibility, { mobile: true, desktop: true });
    assert.equal(b.hidden, false);
    const specs = BLOCKS[type].settings as Record<string, FieldSpec>;
    assert.deepEqual(Object.keys(b.settings).sort(), Object.keys(specs).sort(), `${type}: exactly the declared settings`);
    for (const [k, spec] of Object.entries(specs)) {
      assert.deepEqual((b.settings as Record<string, unknown>)[k], defaultOf(spec), `${type}.${k}`);
    }
  }
});

test('every declared variant is accepted; an unknown one falls back to the first, with an issue', () => {
  for (const type of BLOCK_TYPES) {
    for (const variant of BLOCKS[type].variants) {
      const r = norm(layoutOf([{ type, id: 'b', variant }]));
      assert.equal(r.layout.blocks[0].variant, variant);
      assert.deepEqual(r.issues, []);
    }
    const bad = norm(layoutOf([{ type, id: 'b', variant: 'fancy' }]));
    assert.equal(bad.layout.blocks[0].variant, BLOCKS[type].variants[0]);
    assert.deepEqual(codes(bad), ['invalid_value']);
  }
});

test('every block type has a cap, and one hero and one tab strip per page', () => {
  assert.equal(blockMax('hero'), 1);
  assert.equal(blockMax('tabs'), 1);
  assert.equal(blockMax('about'), 1);
  for (const type of BLOCK_TYPES) assert.ok(blockMax(type) >= 1 && blockMax(type) <= 10, type);
  const r = norm(layoutOf([{ type: 'hero' }, { type: 'hero' }, { type: 'tabs' }, { type: 'tabs' }]));
  assert.deepEqual(r.layout.blocks.map((b) => b.type), ['hero', 'tabs']);
  assert.deepEqual(codes(r), ['too_many', 'too_many']);
  const many = norm(layoutOf(Array.from({ length: MAX_BLOCKS + 5 }, (_, i) => ({ type: 'text', id: `t${i}` }))));
  // 40 kept — but at most 10 of one type.
  assert.equal(many.layout.blocks.length, 10);
  assert.ok(codes(many).includes('too_many'));
  const mixed = BLOCK_TYPES.flatMap((t) => [{ type: t }, { type: t }]);
  assert.ok(norm(layoutOf(mixed)).layout.blocks.length <= MAX_BLOCKS);
});

// ---------------------------------------------------------- field bounds

test('numbers are rounded and clamped into their bounds; anything else is the default', () => {
  const grid = (limit: unknown) => norm(layoutOf([{ type: 'products_grid', id: 'g', settings: { limit } }]));
  assert.equal(set0(grid(1000)).limit, 24);
  assert.equal(set0(grid(-5)).limit, 2);
  assert.equal(set0(grid(6.6)).limit, 7);
  for (const v of [1000, -5, 6.6]) assert.deepEqual(codes(grid(v)), ['clamped']);
  for (const v of ['12', NaN, Infinity, null, {}, [3]]) {
    const r = grid(v);
    assert.equal(set0(r).limit, 6, String(v));
    assert.deepEqual(codes(r), ['invalid_value'], String(v));
  }
});

test('booleans and enums accept only their own values', () => {
  const r = norm(layoutOf([{ type: 'hero', id: 'h', settings: { show_stats: 'yes', align: 'justify', show_bio: false } }]));
  const s = r.layout.blocks[0].settings as Record<string, unknown>;
  assert.equal(s.show_stats, true);
  assert.equal(s.align, 'center');
  assert.equal(s.show_bio, false);
  assert.deepEqual(codes(r).sort(), ['invalid_value', 'invalid_value']);
});

test('text: every language capped on its own, invisible controls removed, visible characters kept', () => {
  const long = 'ب'.repeat(500);
  const r = norm(layoutOf([{ type: 'text', id: 't', settings: { title: { ar: long, en: 'Hello', ckb: 'سڵاو' } } }]));
  const title = (r.layout.blocks[0].settings as { title: { ar: string; en: string; ckb: string } }).title;
  assert.equal(title.ar.length, 80);
  assert.equal(title.en, 'Hello');
  assert.equal(title.ckb, 'سڵاو');
  assert.deepEqual(codes(r), ['truncated']);

  // Bidi embeddings/overrides/isolates, C0/C1 controls, BOM — gone. ZWJ,
  // ZWNJ and the directional MARKS stay: Kurdish, emoji and bilingual lines
  // need them.
  const cp = (...n: number[]) => String.fromCodePoint(...n);
  const dirty = `a${cp(0x202e)}b${cp(0x2066)}c${cp(0x0000)}d${cp(0x0085)}e${cp(0xfeff)}f`;
  assert.equal(cleanText(dirty, 100).value, 'abcdef');
  const kept = `ک${cp(0x200c)}ه ${cp(0x1f469, 0x200d, 0x1f4bb)} ${cp(0x200f)}x`;
  assert.equal(cleanText(kept, 100).value, kept);
  // A lone surrogate is dropped; a cap never splits a pair.
  assert.equal(cleanText(`a${String.fromCharCode(0xd83d)}b`, 10).value, 'ab');
  const emoji = cp(0x1f600).repeat(3);
  assert.equal(cleanText(emoji, 5).value, cp(0x1f600).repeat(2));
  // Single-line text folds newlines; multi-line keeps paragraphs, collapses runs.
  assert.equal(cleanText('a\n\nb', 10).value, 'a b');
  assert.equal(cleanText('a\r\n\n\n\nb', 10, true).value, 'a\n\nb');
});

test('pickText falls back to what the merchant wrote — Sorani to Arabic first — never to a placeholder', () => {
  assert.equal(pickText({ ar: 'مرحبا', en: 'Hello', ckb: '' }, 'ckb'), 'مرحبا');
  assert.equal(pickText({ ar: '', en: 'Hello', ckb: '' }, 'ar'), 'Hello');
  assert.equal(pickText({ ar: 'مرحبا', en: '', ckb: '' }, 'en'), 'مرحبا');
  assert.equal(pickText({ ar: '', en: '', ckb: '' }, 'en'), '');
});

test('lists are capped, and an item missing a required field is dropped', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ q: { ar: `س${i}` }, a: { ar: `ج${i}` } }));
  items[1] = { q: { ar: 'بلا جواب' }, a: { ar: '' } };
  const r = norm(layoutOf([{ type: 'faq', id: 'f', settings: { items } }]));
  const kept = (r.layout.blocks[0].settings as { items: unknown[] }).items;
  assert.equal(kept.length, 11, '12 read, 1 dropped');
  assert.deepEqual(codes(r).sort(), ['dropped_item', 'too_many']);
  const g = norm(layoutOf([{ type: 'gallery', id: 'g', settings: { images: [{ caption: { ar: 'بلا صورة' } }, { image: key('abcd1234') }] } }]));
  assert.equal((g.layout.blocks[0].settings as { images: unknown[] }).images.length, 1);
});

test('sets are ordered, deduplicated, bounded, and never empty', () => {
  const tabs = (items: unknown) => norm(layoutOf([{ type: 'tabs', id: 't', settings: { items } }]));
  const r = tabs(['about', 'products', 'about', 'bogus']);
  assert.deepEqual((r.layout.blocks[0].settings as { items: string[] }).items, ['about', 'products']);
  assert.deepEqual(codes(r), ['invalid_value']);
  const empty = tabs([]);
  assert.deepEqual((empty.layout.blocks[0].settings as { items: string[] }).items, ['products', 'collections', 'deals', 'services', 'showcase', 'about']);
  const stats = norm(layoutOf([{ type: 'stats', id: 's', settings: { metrics: ['rating', 'positive', 'products', 'followers', 'years'] } }]));
  assert.equal((stats.layout.blocks[0].settings as { metrics: string[] }).metrics.length, 4);
});

test('refs keep the id shape, drop the rest, and are unique and capped', () => {
  const r = norm(layoutOf([{ type: 'featured_products', id: 'f', settings: { product_ids: ['p1', 'p1', 'bad id', '', 7, ...Array.from({ length: 20 }, (_, i) => `x${i}`)] } }]));
  const ids = (r.layout.blocks[0].settings as { product_ids: string[] }).product_ids;
  assert.deepEqual(ids.slice(0, 2), ['p1', 'x0']);
  assert.ok(ids.length <= 12);
  assert.ok(codes(r).includes('invalid_ref'));
  assert.ok(codes(r).includes('too_many'));
});

test('dates are canonical ISO instants between 2020 and 2100', () => {
  const at = (ends_at: unknown) => norm(layoutOf([{ type: 'countdown', id: 'c', settings: { ends_at } }]));
  assert.equal(set0(at('2026-10-01T18:00:00+03:00')).ends_at, '2026-10-01T15:00:00.000Z');
  for (const v of ['1999-01-01', '2200-01-01', 'soon', 1234567890000]) {
    assert.equal(set0(at(v)).ends_at, '', String(v));
    assert.deepEqual(codes(at(v)), ['invalid_value']);
  }
});

test('block ids: missing ones are generated, bad ones replaced, duplicates renamed — deterministically', () => {
  const r = norm(layoutOf([{ type: 'text' }, { type: 'text', id: 'text' }, { type: 'cta', id: 'NOT VALID' }, { type: 'faq', id: 'x'.repeat(40) }]));
  const ids = r.layout.blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 3), ['text', 'text-2', 'cta']);
  assert.deepEqual(codes(r).sort(), ['duplicate_id', 'invalid_value', 'invalid_value']);
  assert.deepEqual(norm(layoutOf([{ type: 'text' }, { type: 'text', id: 'text' }])).layout, norm(layoutOf([{ type: 'text' }, { type: 'text', id: 'text' }])).layout);
});

test('a grid on a collection needs the collection, else it shows the newest', () => {
  const r = norm(layoutOf([{ type: 'products_grid', id: 'g', settings: { source: 'collection' } }]));
  assert.equal(set0(r).source, 'latest');
  const ok = norm(layoutOf([{ type: 'products_grid', id: 'g', settings: { source: 'collection', collection_id: 'sec1' } }]));
  assert.equal(set0(ok).collection_id, 'sec1');
  assert.deepEqual(ok.issues, []);
  const stray = norm(layoutOf([{ type: 'products_grid', id: 'g', settings: { source: 'deals', collection_id: 'sec1' } }]));
  assert.equal(set0(stray).collection_id, '');
});

// ------------------------------------------------------------------ themes

test('the seven presets are complete token sets, every value from its closed list', () => {
  assert.deepEqual([...THEME_NAMES], ['classic', 'minimal', 'modern', 'premium_dark', 'workshop', 'portfolio', 'product_focused']);
  for (const name of THEME_NAMES) {
    const preset = THEME_PRESETS[name] as unknown as Record<string, unknown>;
    assert.deepEqual(Object.keys(preset).sort(), [...TOKEN_KEYS].sort(), name);
    for (const k of TOKEN_KEYS) assert.ok((TOKEN_VALUES[k] as readonly unknown[]).includes(preset[k]), `${name}.${k}`);
    // The brand accent follows store settings unless the merchant sets one.
    assert.equal(preset.accent, 'store', name);
  }
  // They are genuinely different looks, not seven names for one.
  assert.equal(new Set(THEME_NAMES.map((n) => JSON.stringify(THEME_PRESETS[n]))).size, THEME_NAMES.length);
});

test('a theme starts from its preset and the merchant adjusts single tokens', () => {
  const r = norm(layoutOf([], { theme: 'modern', tokens: { radius: 'sharp', accent: 'teal' } }));
  assert.equal(r.layout.theme, 'modern');
  assert.deepEqual(r.layout.tokens, { ...THEME_PRESETS.modern, radius: 'sharp', accent: 'teal' });
  assert.deepEqual(r.issues, []);
});

test('changing the theme changes tokens only — every block, setting and position is untouched', () => {
  const start = norm(
    layoutOf([
      { type: 'hero', id: 'h', variant: 'cover', settings: { headline: { ar: 'متجري' } } },
      { type: 'products_grid', id: 'g', settings: { limit: 8 } },
      { type: 'faq', id: 'f', settings: { items: [{ q: { ar: 'س' }, a: { ar: 'ج' } }] } },
    ])
  ).layout;
  for (const theme of THEME_NAMES) {
    const next = applyTheme(start, theme);
    assert.equal(next.theme, theme);
    assert.deepEqual(next.tokens, THEME_PRESETS[theme]);
    assert.deepEqual(next.blocks, start.blocks);
    assert.deepEqual(next.header, start.header);
    assert.deepEqual(next.footer, start.footer);
    assert.deepEqual(norm(next).issues, []);
  }
});

// ----------------------------------------------------------- idempotency

function everyBlockLayout(): unknown {
  return layoutOf(
    BLOCK_TYPES.map((type, i) => ({
      type,
      id: `b${i}`,
      variant: BLOCKS[type].variants[BLOCKS[type].variants.length - 1],
      visibility: { mobile: i % 2 === 0, desktop: true },
      settings: {
        title: { ar: 'عنوان', en: 'Title' },
        headline: { ar: 'متجر', ckb: 'فرۆشگا' },
        image: key('abcd1234'),
        video: key('vid12345', 'mp4'),
        link: { kind: 'external', url: 'https://example.com/a?b=1' },
        cta_link: { kind: 'route', route: 'products' },
        items: type === 'faq' ? [{ q: { ar: 'س' }, a: { ar: 'ج' } }] : type === 'social_links' ? [{ provider: 'instagram', handle: '@raf3d' }] : [],
        images: [{ image: key('abcd1235'), caption: { ar: 'تعليق' } }],
        ends_at: '2027-01-01T00:00:00Z',
        product_ids: ['p1', 'p2'],
        collection_ids: ['sec1'],
        coupon_id: 'cp1',
      },
    })),
    { theme: 'premium_dark', header: { variant: 'bar' }, footer: { variant: 'standard' } }
  );
}

test('normalising is idempotent: its own output comes back unchanged, with nothing to report', () => {
  for (const input of [defaultLayoutFromStore({ accent: 'teal' }), everyBlockLayout()]) {
    const once = norm(input);
    const twice = norm(JSON.parse(JSON.stringify(once.layout)));
    assert.deepEqual(twice.issues, [], JSON.stringify(twice.issues));
    assert.deepEqual(twice.layout, once.layout);
    assert.ok(once.ok);
  }
});

test('a normalised layout of every block type fits the size cap', () => {
  const r = norm(everyBlockLayout());
  assert.ok(new TextEncoder().encode(JSON.stringify(r.layout)).length < MAX_LAYOUT_BYTES);
  assert.equal(r.layout.blocks.length, BLOCK_TYPES.length);
});

// ---------------------------------------------------------- the default

test('the default layout IS the classic storefront: overlay header, profile hero, the six tabs, the install card', () => {
  const d = defaultLayoutFromStore({ accent: 'plum', sells_direct_products: 1 });
  assert.equal(d.schema_version, 1);
  assert.equal(d.theme, 'classic');
  assert.deepEqual(d.tokens, THEME_PRESETS.classic);
  assert.equal(d.tokens.surface, 'glow', 'the accent glow of the old page');
  assert.equal(d.tokens.grid_columns, 3, 'three products per row, four when wider');
  assert.equal(d.tokens.accent, 'store', 'the accent from store settings keeps applying');
  assert.deepEqual(d.header, { variant: 'overlay' });
  assert.deepEqual(d.footer, { variant: 'minimal' });
  assert.deepEqual(d.blocks.map((b) => [b.type, b.variant]), [['hero', 'profile'], ['tabs', 'underline']]);
  const hero = d.blocks[0].settings as Record<string, unknown>;
  for (const row of ['show_cover', 'show_stats', 'show_bio', 'show_links', 'show_info_cards', 'show_actions']) assert.equal(hero[row], true, row);
  assert.equal(hero.image, '', 'the store banner, read live — never copied');
  assert.deepEqual(hero.headline, { ar: '', en: '', ckb: '' }, 'the store name, read live');
  const tabs = d.blocks[1].settings as { items: string[]; about_reviews: boolean; products_preview: number };
  assert.deepEqual(tabs.items, ['products', 'collections', 'deals', 'services', 'showcase', 'about']);
  assert.equal(tabs.about_reviews, true);
  assert.equal(tabs.products_preview, 6);
  assert.deepEqual(norm(d).issues, []);
  assert.equal(renderableBlocks(d).length, 2);
});

// ------------------------------------------------------------ data needs

test('a layout asks only for what its VISIBLE blocks show, each product list once at its largest size', () => {
  const l = norm(
    layoutOf([
      { type: 'products_grid', id: 'a', settings: { limit: 4 } },
      { type: 'products_carousel', id: 'b', settings: { limit: 10 } },
      { type: 'deals', id: 'c', settings: { limit: 3 } },
      { type: 'products_grid', id: 'd', settings: { source: 'collection', collection_id: 'sec1', limit: 8 } },
      { type: 'featured_products', id: 'e', settings: { product_ids: ['p1', 'p2'] } },
      { type: 'coupon_banner', id: 'f', settings: { coupon_id: 'cp1' } },
      { type: 'reviews', id: 'g', settings: { limit: 5 } },
      { type: 'printers', id: 'h' },
      { type: 'services', id: 'i', hidden: true },
      { type: 'showcase', id: 'j', visibility: { mobile: false, desktop: false } },
    ])
  ).layout;
  const n = collectDataNeeds(l);
  assert.deepEqual(n.products, [
    { key: 'latest', source: 'latest', collection_id: '', limit: 10 },
    { key: 'deals', source: 'deals', collection_id: '', limit: 3 },
    { key: 'collection:sec1', source: 'collection', collection_id: 'sec1', limit: 8 },
  ]);
  assert.deepEqual(n.productIds, ['p1', 'p2']);
  assert.deepEqual(n.couponIds, ['cp1']);
  assert.equal(n.reviews, 5);
  assert.equal(n.printers, true);
  assert.equal(n.services, false, 'a hidden block costs nothing');
  assert.equal(n.showcase, false, 'a block visible nowhere costs nothing');
  assert.equal(n.collections, false);
});

test('a block that links to a product asks for that product, so its link can be drawn; a hidden block asks for nothing', () => {
  const l = norm(
    layoutOf([
      { id: 'b', type: 'banner', settings: { cta_label: { ar: 'اذهب' }, link: { kind: 'product', id: 'p9' } } },
      { id: 'c', type: 'cta', hidden: true, settings: { link: { kind: 'product', id: 'hidden1' } } },
      { id: 'f', type: 'featured_products', settings: { product_ids: ['p1', 'p9'] } },
      { id: 'i', type: 'image_text', settings: { link: { kind: 'collection', id: 'sec1' } } },
    ])
  ).layout;
  assert.deepEqual(collectDataNeeds(l).productIds, ['p9', 'p1']);
});

test('the classic page asks for its first pages exactly as the old page loaded them', () => {
  const n = collectDataNeeds(defaultLayoutFromStore(null));
  assert.deepEqual(n.products.map((q) => [q.key, q.limit]), [['latest', 24], ['deals', 24]]);
  assert.equal(n.collections, true);
  assert.equal(n.services, true);
  assert.equal(n.showcase, true);
  assert.equal(n.reviews, 20);
});

test('distinct product lists are capped, so the one statement that reads them stays far under 100 parameters', () => {
  const blocks = Array.from({ length: 10 }, (_, i) => ({ type: 'products_grid', id: `g${i}`, settings: { source: 'collection', collection_id: `c${i}` } }));
  blocks.push(...Array.from({ length: 10 }, (_, i) => ({ type: 'products_carousel', id: `k${i}`, settings: { source: 'collection', collection_id: `d${i}` } })));
  const n = collectDataNeeds(norm(layoutOf(blocks)).layout);
  assert.equal(n.products.length, MAX_PRODUCT_QUERIES);
  assert.ok(1 + MAX_PRODUCT_QUERIES * 3 < 100);
});

// ------------------------------------------------------------ references

test('media keys: this owner\'s canonical and legacy keys, as keys; anything else is refused', () => {
  assert.deepEqual(mediaKey(key('abcd1234'), 'image', OWNER), { ok: true, key: key('abcd1234') });
  assert.deepEqual(mediaKey(`/files/${key('abcd1234')}`, 'image', OWNER), { ok: true, key: key('abcd1234') });
  assert.deepEqual(mediaKey(`community/${OWNER}/abcd1234.jpg`, 'image', OWNER), { ok: true, key: `community/${OWNER}/abcd1234.jpg` });
  assert.deepEqual(mediaKey(key('abcd1234'), 'image', 'someone_else'), { ok: false, code: 'foreign_media' });
  assert.deepEqual(mediaKey(key('abcd1234'), 'image', ''), { ok: false, code: 'foreign_media' }, 'an empty owner matches nothing');
  assert.deepEqual(mediaKey(key('abcd1234', 'mp4'), 'image', OWNER), { ok: false, code: 'invalid_media' });
  assert.deepEqual(mediaKey(key('abcd1234', 'mp4'), 'video', OWNER), { ok: true, key: key('abcd1234', 'mp4') });
  assert.equal(mediaKey('', 'image', OWNER), null);
  assert.equal(mediaSrc(key('abcd1234')), `/files/${key('abcd1234')}`);
  assert.equal(mediaSrc('https://evil.example/x.png'), '');
});

test('every external address the schema accepts, the server\'s safeLink accepts too — the schema is the narrower rule', () => {
  const corpus = [
    'https://example.com', 'https://example.com/a/b?c=d#e', 'HTTPS://EXAMPLE.COM/x', 'https://sub.example.co.uk/%D8%A7',
    'https://مثال.العراق/صفحة', 'https://example.com:443/x', 'http://example.com', 'https://example.com:8443/x',
    'https://user:pass@example.com', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://localhost/x', '//example.com/x',
    'javascript:alert(1)', 'data:text/html,<b>x</b>', ' https://example.com ', 'https://exa mple.com', 'https:/example.com',
    `https://example.com/${'a'.repeat(600)}`,
  ];
  let accepted = 0;
  for (const raw of corpus) {
    const url = safeExternalUrl(raw);
    if (!url) continue;
    accepted++;
    assert.equal(safeLink(url), url, `${raw} passed the schema but not safeLink`);
    assert.ok(url.startsWith('https://'), raw);
  }
  assert.ok(accepted >= 5, 'the corpus exercises real acceptances');
  for (const bad of ['http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1/x', 'https://localhost/x', 'https://example.com:8443/x']) {
    assert.equal(safeExternalUrl(bad), null, bad);
  }
});

test('a social link is a provider and a handle; the address is built from the provider\'s own template', () => {
  assert.equal(socialHandle('instagram', '@raf3d'), 'raf3d');
  assert.equal(socialHandle('instagram', 'https://www.instagram.com/raf3d/'), 'raf3d');
  assert.equal(socialHandle('instagram', 'https://evil.example/raf3d'), null);
  assert.equal(socialHandle('instagram', 'raf 3d'), null);
  assert.equal(socialHandle('whatsapp', '+964 770 123 4567'), '9647701234567');
  assert.equal(socialHandle('tiktok', 'https://www.tiktok.com/@raf3d'), 'raf3d');
  assert.equal(socialHandle('snapchat', 'https://www.snapchat.com/add/raf3d'), 'raf3d');
  assert.equal(socialHandle('youtube', 'https://m.youtube.com/@raf3d'), 'raf3d');
  for (const provider of SOCIAL_PROVIDER_NAMES) {
    const href = socialHref({ provider, handle: provider === 'whatsapp' ? '9647701234567' : 'raf3dx' });
    assert.ok(href.startsWith('https://'), provider);
    assert.equal(safeLink(href), href);
  }
  assert.equal(socialHref({ provider: 'instagram', handle: '../../evil' }), '');
});

test('references are collected once each, and the rejected ones removed with an issue at their place', () => {
  const l = norm(
    layoutOf([
      { type: 'featured_products', id: 'f', settings: { product_ids: ['p1', 'p2'] } },
      { type: 'products_grid', id: 'g', settings: { source: 'collection', collection_id: 'sec9' } },
      { type: 'banner', id: 'b', settings: { image: key('abcd1234'), link: { kind: 'product', id: 'p2' } } },
      { type: 'gallery', id: 'y', settings: { images: [{ image: key('abcd1234') }, { image: key('gone1234') }] } },
      { type: 'coupon_banner', id: 'c', settings: { coupon_id: 'cp1' } },
    ])
  ).layout;
  const refs = collectLayoutRefs(l);
  assert.deepEqual(refs.product, ['p1', 'p2']);
  assert.deepEqual(refs.collection, ['sec9']);
  assert.deepEqual(refs.coupon, ['cp1']);
  assert.deepEqual(refs.media.map((m) => m.key), [key('abcd1234'), key('gone1234')]);
  const { layout, issues } = dropLayoutRefs(l, { product: new Set(['p2']), collection: new Set(['sec9']), media: new Set([key('gone1234')]) }, { ownerUserId: OWNER });
  const byType = (t: BlockType) => layout.blocks.find((b) => b.type === t)!.settings as Record<string, unknown>;
  assert.deepEqual(byType('featured_products').product_ids, ['p1']);
  assert.equal(byType('products_grid').source, 'latest', 'a grid whose collection is gone shows the newest');
  assert.deepEqual(byType('banner').link, { kind: 'none' });
  assert.equal((byType('gallery').images as unknown[]).length, 1);
  assert.deepEqual(issues.filter((i) => i.code === 'unknown_ref').map((i) => i.path).sort(), [
    'blocks[0].settings.product_ids[1]', 'blocks[1].settings.collection_id', 'blocks[2].settings.link',
  ]);
  assert.ok(issues.some((i) => i.code === 'media_not_found' && i.path === 'blocks[3].settings.images[1].image'));
});

// ------------------------------------------------------- mirrored lists

test('the icon names and the accents are the server\'s own lists', () => {
  assert.deepEqual([...WIDGET_ICON_NAMES], [...WIDGET_ICONS]);
  const client = readFileSync(join(ROOT, 'src/components/merchant/profileIcons.tsx'), 'utf8');
  const clientIds = [...client.matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(clientIds, [...WIDGET_ICON_NAMES]);
  const merchant = readFileSync(join(ROOT, 'worker/routes/merchant.ts'), 'utf8');
  const accents = /const ACCENTS = \[([^\]]+)\]/.exec(merchant)?.[1] ?? '';
  assert.deepEqual([...accents.matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...STORE_ACCENTS]);
});

test('an unknown or future schema version is not guessed at', () => {
  assert.deepEqual(codes(norm({ schema_version: 2, blocks: [] })), ['unsupported_schema_version']);
  assert.equal(norm({ schema_version: 2 }).ok, false);
  // Not half-understood with this version's rules: nothing of it is kept.
  const future = norm({ schema_version: 2, theme: 'modern', blocks: [{ type: 'text', settings: { body: { ar: 'x' } } }] });
  assert.deepEqual(future.layout, emptyLayout());
  assert.deepEqual(norm({ schema_version: '1', blocks: [] }).issues.map((i) => i.code), ['unsupported_schema_version']);
  assert.deepEqual(codes(norm({ blocks: [] })), ['missing_schema_version']);
  assert.equal(norm({ blocks: [] }).ok, true);
  for (const junk of [null, 'layout', 42, [], true]) {
    const r = norm(junk);
    assert.equal(r.ok, false);
    assert.deepEqual(r.layout.blocks, []);
  }
});

test('every layout the defaults and the presets produce is a valid StoreLayout the renderer can show', () => {
  const layouts: StoreLayout[] = [defaultLayoutFromStore(null), ...THEME_NAMES.map((t) => applyTheme(defaultLayoutFromStore(null), t))];
  for (const l of layouts) {
    assert.deepEqual(norm(l).issues, []);
    assert.ok(renderableBlocks(l).length > 0);
  }
  assert.throws(() => makeBlock('products_grid', 'x', { settings: { limit: 99 } }), /makeBlock/);
});
