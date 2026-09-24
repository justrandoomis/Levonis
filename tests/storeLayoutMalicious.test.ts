/**
 * A STORE LAYOUT IS DATA FROM A MERCHANT, SO EVERY FIELD OF IT IS TRIED AS AN
 * ATTACK: markup in text, scripts in links, other people's files and other
 * sites' pictures as media, block types and setting names the schema does not
 * have, prototype keys, CSS through theme tokens, bidi overrides, social links
 * that lead elsewhere, and payloads built to make the checker do unbounded
 * work.
 *
 * Two layers are tested, because both exist on purpose:
 *   - the schema (packages/storeLayout) the server runs on every write and
 *     every public read — what it refuses, what it cleans;
 *   - the renderer, handed hostile layouts DIRECTLY (as if the server had been
 *     bypassed) — it normalises again, and what reaches the markup is checked
 *     attribute by attribute.
 *
 * The route-level refusals (LAYOUT_REJECTED, 413) are in
 * tests/storeLayoutRoutes.test.ts.
 *
 * Run: node --import tsx --test tests/storeLayoutMalicious.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEDIA, OWNER } from './fixtures/storeLayout';
import { attributeValues, fixtureData, fixtureStore, renderStore, visibleText } from './fixtures/storefrontRender';
import { BLOCKS, BLOCK_TYPES, type BlockType, type FieldSpec } from '../packages/storeLayout/src/blocks';
import { MAX_ISSUES, normalizeLayout } from '../packages/storeLayout/src/normalize';
import { cleanText } from '../packages/storeLayout/src/text';
import { mediaKey, socialHref } from '../packages/storeLayout/src/refs';
import { THEME_PRESETS, TOKEN_KEYS, TOKEN_VALUES } from '../packages/storeLayout/src/tokens';
import { MAX_BLOCKS } from '../packages/storeLayout/src/schema';
import { themeAttributes, safeTokens } from '../src/components/storefront/theme';
import { safeLink } from '../worker/lib/homeContent';

const norm = (input: unknown) => normalizeLayout(input, { ownerUserId: OWNER });
const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);
/** The first block's settings, read as the plain object they are. */
const set0 = (r: { layout: { blocks: Array<{ settings: unknown }> } }) => r.layout.blocks[0].settings as Record<string, unknown>;
const layoutOf = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ schema_version: 1, blocks, ...extra });
const T = (s: string) => ({ ar: s, en: s, ckb: s });

const MARK = 'EVILTXT';
const HOSTILE = `<script>alert("${MARK}")</script><img src=x onerror=alert(1)><style>body{display:none}</style>`;

/** A block of `type` with every text field hostile and every reference pointing at the fixture's own rows. */
function hostileBlock(type: BlockType, index: number) {
  const settings: Record<string, unknown> = {};
  const scalar = (key: string, spec: FieldSpec): unknown => {
    switch (spec.t) {
      case 'text':
        return T(HOSTILE);
      case 'media':
        return spec.kind === 'video' ? MEDIA.video : MEDIA.picture;
      case 'link':
        return { kind: 'route', route: 'about' };
      case 'date':
        return '2099-01-01T00:00:00.000Z';
      case 'ref':
        return spec.ref === 'coupon' ? 'cp1' : spec.ref === 'collection' ? 'sec1' : 'p1';
      case 'refs':
        return spec.ref === 'product' ? ['p1', 'p3'] : ['sec1', 'sec2'];
      case 'socials':
        return [{ provider: 'instagram', handle: 'raf3d' }];
      case 'enum':
        // «custom» where a block can take its content from the layout instead of the store.
        return key === 'source' && spec.values.includes('custom') ? 'custom' : spec.d;
      default:
        return undefined;
    }
  };
  for (const [key, spec] of Object.entries(BLOCKS[type].settings as Record<string, FieldSpec>)) {
    if (spec.t === 'list') {
      const item: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(spec.item)) item[k] = s.t === 'enum' ? s.d : scalar(k, s as FieldSpec);
      settings[key] = [item, item];
    } else {
      const v = scalar(key, spec);
      if (v !== undefined) settings[key] = v;
    }
  }
  if (type === 'products_grid' || type === 'products_carousel') settings.source = 'collection';
  return { id: `b${index}`, type, settings };
}

// -------------------------------------------------------------------- markup

/**
 * Every element and attribute NAME in the markup. Attribute values are quoted
 * and React escapes quotes inside them, so a value is skipped whole — an
 * «onerror=» that is part of a caption's text is text, not an attribute.
 */
function markupOf(html: string): { tags: Set<string>; attributes: Set<string> } {
  const tags = new Set<string>();
  const attributes = new Set<string>();
  for (const tag of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    tags.add(tag[1].toLowerCase());
    for (const a of tag[2].matchAll(/\s+([^\s=>/]+)(?:="[^"]*")?/g)) attributes.add(a[1]);
  }
  return { tags, attributes };
}

test('markup in every text field of every block renders as text — no tag, no handler, no style element', async () => {
  const store = await fixtureStore();
  const input = layoutOf(BLOCK_TYPES.map((t, i) => hostileBlock(t, i)));
  const r = norm(input);
  assert.ok(r.ok, JSON.stringify(r.issues.filter((i) => i.fatal)));
  assert.equal(r.layout.blocks.length, BLOCK_TYPES.length);
  const data = await fixtureData(r.layout);
  const hostileStore = { ...store, name: HOSTILE, description: HOSTILE, tagline: HOSTILE };
  for (const lang of ['ar', 'en'] as const) {
    const html = await renderStore({ ...hostileStore, layout: r.layout, blocks_data: data }, { layout: r.layout, data, lang });
    const { tags, attributes } = markupOf(html);
    for (const banned of ['script', 'style', 'iframe', 'object', 'embed', 'base', 'meta', 'form']) {
      assert.ok(!tags.has(banned), `no <${banned}> element`);
    }
    // The only <link> is React hoisting a preload for the store's own pictures.
    for (const m of html.matchAll(/<link[^>]*>/g)) {
      assert.match(m[0], /^<link rel="preload" as="image" href="\/files\/merchants\/owner\/public\/[a-z0-9]+\.webp"( fetchPriority="high")?\/>$/, m[0]);
    }
    assert.deepEqual([...attributes].filter((a) => /^on/i.test(a)), [], 'no inline event handler of any kind');
    assert.ok(!/javascript:/i.test(html));
    // The words are there, as words.
    const text = visibleText(html);
    assert.ok(text.includes(`<script>alert("${MARK}")</script>`), `${lang}: the hostile text shows as text`);
    assert.ok(html.includes('&lt;script&gt;'), 'escaped by React');
    // Never inside a class, a style or a data attribute.
    for (const name of ['class', 'style', 'data-block', 'data-block-id', 'data-store-theme', 'id', 'href', 'src']) {
      for (const v of attributeValues(html, name)) assert.ok(!v.includes(MARK), `${name}="${v.slice(0, 80)}"`);
    }
  }
});

test('an id that tries to be markup is replaced by a generated one', () => {
  const r = norm(layoutOf([{ id: '"><script>x</script>', type: 'text' }, { id: 'ok-id', type: 'text' }, { id: 'ok-id', type: 'text' }]));
  assert.deepEqual(r.layout.blocks.map((b) => b.id), ['text', 'ok-id', 'ok-id-2']);
  assert.ok(codes(r).includes('invalid_value') || codes(r).includes('duplicate_id'));
});

// --------------------------------------------------------------------- links

const C = (n: number) => String.fromCharCode(n);

test('links: every scheme but https, and every trick to spell another one, refuses the layout', () => {
  const fatal: unknown[] = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    `java${C(9)}script:alert(1)`,
    `java${C(10)}script:alert(1)`,
    `${C(0)}javascript:alert(1)`,
    `${C(0x1f)}javascript:alert(1)`,
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'http://example.com',
    '//evil.example/x',
    '\\\\evil.example\\x',
    'https://user:pw@example.com',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://example.com:8080/',
    'https:\\\\evil.example',
    { kind: 'external', url: 'javascript:alert(1)' },
    { kind: 'external', url: 'http://example.com' },
    { kind: 'external', url: `https://exa${C(0x202e)}mple.com` },
  ];
  for (const link of fatal) {
    const r = norm(layoutOf([{ id: 'c', type: 'cta', settings: { link } }]));
    assert.equal(r.ok, false, JSON.stringify(link));
    assert.ok(codes(r).includes('unsafe_link'), `${JSON.stringify(link)}: ${codes(r)}`);
    assert.deepEqual(set0(r).link, { kind: 'none' }, 'and the cleaned layout links nowhere');
  }
  // Not an address at all: cleaned (no link), not refused.
  for (const link of ['/admin', 'about', { kind: 'route', route: 'admin' }, { kind: 'script' }, { kind: 'product', id: '../x' }, 42, ['https://example.com']]) {
    const r = norm(layoutOf([{ id: 'c', type: 'cta', settings: { link } }]));
    assert.equal(r.ok, true, JSON.stringify(link));
    assert.deepEqual(set0(r).link, { kind: 'none' });
  }
  // What is accepted is normalised by the URL parser — quotes and brackets encoded.
  const ok = norm(layoutOf([{ id: 'c', type: 'cta', settings: { link: 'https://example.com/"><b>x' } }]));
  assert.ok(ok.ok);
  const url = (set0(ok).link as { url: string }).url;
  assert.equal(url, 'https://example.com/%22%3E%3Cb%3Ex');
  assert.equal(safeLink(url), url);
});

test('links handed straight to the renderer: every href is an internal route, this store\'s file, or a checked https address', async () => {
  const store = await fixtureStore();
  const blocks = [
    { id: 'a', type: 'cta', settings: { label: T('a'), link: { kind: 'external', url: 'javascript:alert(1)' } } },
    { id: 'b', type: 'cta', settings: { label: T('b'), link: { kind: 'external', url: 'https://ok.example/path' } } },
    { id: 'c', type: 'banner', settings: { title: T('c'), cta_label: T('c'), link: 'data:text/html,x' } },
    { id: 'd', type: 'cta', settings: { label: T('d'), link: { kind: 'route', route: 'reviews' } } },
    { id: 'e', type: 'cta', settings: { label: T('e'), link: { kind: 'collection', id: 'sec2' } } },
    { id: 'f', type: 'social_links', settings: { source: 'custom', items: [{ provider: 'instagram', handle: 'javascript:alert(1)' }, { provider: 'x', handle: 'raf3d' }] } },
  ];
  const runtime = {
    routeHref: (r: string) => `/s/raf3d/${r}`,
    collectionHref: (id: string) => `/s/raf3d?section=${id}`,
    productHref: (slug: string) => `/s/raf3d/p/${slug}`,
    requestsHref: '/community/requests',
  };
  const html = await renderStore(store, { layout: layoutOf(blocks), runtime });
  const hrefs = attributeValues(html, 'href');
  assert.ok(hrefs.includes('https://ok.example/path'));
  assert.ok(hrefs.includes('/s/raf3d/reviews'));
  assert.ok(hrefs.includes('/s/raf3d?section=sec2'));
  assert.ok(hrefs.includes('https://x.com/raf3d'));
  for (const h of hrefs) {
    const internal = h === '#' || h.startsWith('/s/raf3d') || h.startsWith('/community/') || h.startsWith('/files/');
    assert.ok(internal || (h.startsWith('https://') && safeLink(h) === h), `href="${h}"`);
  }
  assert.ok(!/javascript:|data:text/i.test(html));
  // External links open in a new tab that cannot reach back.
  for (const m of html.matchAll(/<a [^>]*href="https:\/\/[^"]*"[^>]*>/g)) {
    assert.match(m[0], /target="_blank"/);
    assert.match(m[0], /rel="noopener noreferrer nofollow"/);
  }
});

// --------------------------------------------------------------------- media

test('media: only a storage key of this owner, never a URL, a path trick or a script-capable type', () => {
  const refused: Array<[unknown, string]> = [
    ['https://evil.example/pixel.png', 'invalid_media'],
    ['http://evil.example/pixel.png', 'invalid_media'],
    ['//evil.example/pixel.png', 'invalid_media'],
    ['data:image/png;base64,iVBORw0KGgo=', 'invalid_media'],
    ['javascript:alert(1)', 'invalid_media'],
    ['merchants/owner/public/../../secrets/key.webp', 'invalid_media'],
    ['merchants/owner/public/%2e%2e/x.webp', 'invalid_media'],
    ['merchants\\owner\\public\\x1234.webp', 'invalid_media'],
    ['merchants/owner/public/logo.svg', 'invalid_media'],
    ['merchants/owner/public/page.html', 'invalid_media'],
    ['merchants/owner/private/abcd1234.webp', 'invalid_media'],
    ['merchants/owner/public/abcd1234.webp?x=1', 'invalid_media'],
    ['/files/../admin/abcd1234.webp', 'invalid_media'],
    ['merchants/owner/public/ABCD1234.WEBP', 'invalid_media'],
    [{ key: MEDIA.picture }, 'invalid_media'],
    [MEDIA.foreign, 'foreign_media'],
    ['community/other/abcd1234.webp', 'foreign_media'],
  ];
  for (const [image, code] of refused) {
    const r = norm(layoutOf([{ id: 'b', type: 'banner', settings: { image } }]));
    assert.equal(r.ok, false, JSON.stringify(image));
    assert.deepEqual(codes(r), [code], JSON.stringify(image));
    assert.equal(set0(r).image, '');
  }
  // A picture slot does not take a video, nor a video slot a picture.
  assert.deepEqual(codes(norm(layoutOf([{ id: 'b', type: 'banner', settings: { image: MEDIA.video } }]))), ['invalid_media']);
  assert.deepEqual(codes(norm(layoutOf([{ id: 'v', type: 'video', settings: { video: MEDIA.picture } }]))), ['invalid_media']);
  // The two spellings of the same key are one key.
  assert.deepEqual(mediaKey(`/files/${MEDIA.picture}`, 'image', OWNER), { ok: true, key: MEDIA.picture });
});

test('media handed straight to the renderer: every src is a same-origin /files/ key', async () => {
  const store = await fixtureStore();
  const html = await renderStore(store, {
    layout: layoutOf([
      { id: 'a', type: 'banner', settings: { title: T('a'), image: 'https://evil.example/pixel.png' } },
      { id: 'b', type: 'gallery', settings: { images: [{ image: '//evil.example/x.png' }, { image: MEDIA.picture }, { image: 'data:image/png;base64,AAAA' }] } },
      { id: 'c', type: 'video', settings: { video: 'https://evil.example/v.mp4', poster: 'https://evil.example/p.png' } },
      { id: 'd', type: 'image_text', settings: { title: T('d'), image: 'merchants/owner/public/../../x/abcd1234.webp' } },
    ]),
  });
  const srcs = [...attributeValues(html, 'src'), ...attributeValues(html, 'poster'), ...attributeValues(html, 'srcset')];
  assert.ok(srcs.includes(`/files/${MEDIA.picture}`));
  for (const s of srcs) assert.match(s, /^\/files\/(merchants\/[A-Za-z0-9_-]+\/public|community\/[A-Za-z0-9_-]+)\/[a-z0-9]{4,40}\.[a-z0-9]+$/, s);
  assert.ok(!html.includes('evil.example'));
});

// ------------------------------------------------------ types and settings

test('block types and setting names outside the schema never reach the page, prototype names included', async () => {
  const types = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'iframe', 'script', 'embed', 'object', 'html', 'style', 'Hero', 'hero ', ''];
  const r = norm(layoutOf([...types.map((type, i) => ({ id: `x${i}`, type, settings: {} })), { id: 'ok', type: 'text' }]));
  assert.deepEqual(r.layout.blocks.map((b) => b.type), ['text']);
  assert.ok(r.ok, 'unknown types are cleaned, not refused');
  assert.equal(codes(r).filter((c) => c === 'unknown_block_type').length, types.length);

  const settings = {
    body: T('kept'),
    html: '<b>x</b>',
    css: 'body{}',
    style: { color: 'red' },
    className: 'fixed inset-0',
    onClick: 'alert(1)',
    dangerouslySetInnerHTML: { __html: '<script>' },
    href: 'javascript:alert(1)',
    src: 'https://evil.example/x.js',
  };
  const s = norm(layoutOf([{ id: 't', type: 'text', settings, extra: 'x', props: { onClick: 'x' } }]));
  assert.deepEqual(Object.keys(s.layout.blocks[0].settings).sort(), ['align', 'body', 'title']);
  assert.deepEqual(Object.keys(s.layout.blocks[0]).sort(), ['hidden', 'id', 'settings', 'type', 'variant', 'visibility']);
  assert.ok(s.ok, 'an unknown setting is dropped, never interpreted — even one named like a link');
  const store = await fixtureStore();
  const html = await renderStore(store, { layout: layoutOf([{ id: 't', type: 'text', settings }]) });
  assert.ok(!/fixed inset-0|evil\.example|__html|onclick/i.test(html));
});

test('prototype keys are data, never assignments', () => {
  const input = JSON.parse(`{
    "schema_version": 1,
    "__proto__": { "polluted": "layout" },
    "constructor": { "prototype": { "polluted": "ctor" } },
    "tokens": { "__proto__": { "polluted": "tokens" }, "radius": "round" },
    "blocks": [
      { "id": "f", "type": "faq", "__proto__": { "hidden": true },
        "settings": { "__proto__": { "polluted": "settings" },
          "items": [ { "__proto__": { "q": { "ar": "inherited" } }, "q": { "ar": "س" }, "a": { "ar": "ج" } } ] } },
      { "id": "t", "type": "text", "visibility": { "__proto__": { "mobile": false } } }
    ]
  }`);
  const r = norm(input);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  assert.equal(r.layout.tokens.radius, 'round');
  assert.equal(Object.getPrototypeOf(r.layout), Object.prototype);
  assert.ok(!Object.hasOwn(r.layout, '__proto__'));
  const faq = r.layout.blocks[0];
  assert.equal(faq.hidden, false, 'an inherited «hidden» is not read');
  assert.ok(!Object.hasOwn(faq.settings, '__proto__'));
  assert.equal((faq.settings as { items: Array<{ q: { ar: string } }> }).items[0].q.ar, 'س');
  assert.deepEqual(r.layout.blocks[1].visibility, { mobile: true, desktop: true });
  assert.ok(!JSON.stringify(r.layout).includes('polluted'));
});

// ----------------------------------------------------------------------- CSS

test('CSS: a token is an enum or its preset, the page gets only enum values, and no merchant string reaches a class or a style', async () => {
  const hostile = {
    accent: 'url(javascript:alert(1))',
    surface: 'ink;background:url(https://evil.example/x)',
    radius: '999px',
    density: { toString: 'x' },
    typography: `"><style>${MARK}</style>`,
    card: 'raised',
    grid_columns: 4,
    width: 'expression(alert(1))',
    extra: MARK,
  };
  const r = norm(layoutOf([{ id: 't', type: 'text', settings: { body: T('x') } }], { tokens: hostile }));
  assert.ok(r.ok, 'hostile tokens are cleaned, not refused');
  for (const k of TOKEN_KEYS) {
    const allowed = (TOKEN_VALUES as Record<string, readonly unknown[]>)[k];
    assert.ok(allowed.includes(r.layout.tokens[k]), `${k}: ${String(r.layout.tokens[k])}`);
  }
  assert.equal(r.layout.tokens.card, 'raised', 'a valid token beside invalid ones is kept');
  assert.equal(r.layout.tokens.radius, THEME_PRESETS.classic.radius);

  // The theme element's attributes, from tokens that never went through normalise.
  const attrs = themeAttributes(safeTokens(hostile as never));
  for (const [name, value] of Object.entries(attrs)) {
    assert.ok(name === 'data-store-theme' || name.startsWith('data-sf-'), name);
    assert.match(String(value), /^[a-z0-9_]*$/, `${name}="${String(value)}"`);
  }

  const store = await fixtureStore();
  const html = await renderStore({ ...store, accent: `teal"><script>${MARK}` }, {
    layout: { schema_version: 1, tokens: hostile, blocks: [{ id: 't', type: 'text', settings: { body: T(MARK) } }] },
  });
  for (const name of ['class', 'style']) {
    for (const v of attributeValues(html, name)) {
      assert.ok(!/javascript|expression|url\(|evil|EVILTXT|</i.test(v), `${name}="${v.slice(0, 100)}"`);
    }
  }
  for (const v of attributeValues(html, 'style')) assert.match(v, /^width:\d+(\.\d+)?%;?$/, `style="${v}"`);
  assert.ok(!/<style/i.test(html));
  assert.ok(visibleText(html).includes(MARK), 'the merchant\'s words are still shown, as text');
});

// ---------------------------------------------------------------- characters

test('bidi overrides, isolates and control characters are removed from every text; Arabic marks stay', () => {
  const bad = [0x202e, 0x202d, 0x202a, 0x202b, 0x202c, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff, 0x0000, 0x0007, 0x001b, 0x0085, 0x009b, 0xfff9, 0xfffb];
  const raw = `abc${bad.map(C).join('')}def${C(0xd800)}ghi`;
  const cleaned = cleanText(raw, 200).value;
  assert.equal(cleaned, 'abcdefghi');
  // Right-to-left and left-to-right marks and the Arabic letters are text, not tricks.
  const arabic = `مرحبا${C(0x200f)} ABC${C(0x200e)}`;
  assert.equal(cleanText(arabic, 200).value, arabic);
  const r = norm(layoutOf([{ id: 't', type: 'text', settings: { title: { ar: `عنوان${C(0x202e)}موقع`, en: `a${C(0x2067)}b` }, body: { ar: raw } } }]));
  const s = r.layout.blocks[0].settings as { title: { ar: string; en: string }; body: { ar: string } };
  assert.equal(s.title.ar, 'عنوانموقع');
  assert.equal(s.title.en, 'ab');
  assert.equal(s.body.ar, 'abcdefghi');
  // Line breaks: kept in a multi-line field, folded in a one-line one.
  const lines = norm(layoutOf([{ id: 't', type: 'text', settings: { title: T('a\nb'), body: T(`a${C(0x2028)}b\n\n\n\nc`) } }]));
  const ls = lines.layout.blocks[0].settings as { title: { ar: string }; body: { ar: string } };
  assert.equal(ls.title.ar, 'a b');
  assert.equal(ls.body.ar, 'a\nb\n\nc');
});

// -------------------------------------------------------------------- social

test('a social link cannot lead anywhere but its provider', () => {
  const r = norm(
    layoutOf([
      {
        id: 's',
        type: 'social_links',
        settings: {
          source: 'custom',
          items: [
            { provider: 'instagram', handle: 'https://evil.example/raf3d' },
            { provider: 'instagram', handle: 'https://instagram.com.evil.example/raf3d' },
            { provider: 'javascript', handle: 'alert(1)' },
            { provider: '__proto__', handle: 'x' },
            { provider: 'telegram', handle: 'raf3d/../../x' },
            { provider: 'whatsapp', handle: '+964 770 123 4567' },
            { provider: 'instagram', handle: 'https://www.instagram.com/raf3d/' },
            { provider: 'youtube', handle: 'raf3d', url: 'https://evil.example' },
          ],
        },
      },
    ])
  );
  const items = (r.layout.blocks[0].settings as { items: Array<{ provider: string; handle: string }> }).items;
  assert.deepEqual(items, [
    { provider: 'whatsapp', handle: '9647701234567' },
    { provider: 'instagram', handle: 'raf3d' },
    { provider: 'youtube', handle: 'raf3d' },
  ]);
  assert.deepEqual(items.map(socialHref as (i: { provider: string; handle: string }) => string), [
    'https://wa.me/9647701234567',
    'https://www.instagram.com/raf3d',
    'https://www.youtube.com/@raf3d',
  ]);
});

// -------------------------------------------------------------- bounded work

test('the checker\'s work is bounded whatever it is sent: huge arrays, huge objects, huge strings', () => {
  const started = Date.now();
  const manyKeys: Record<string, number> = {};
  for (let i = 0; i < 60_000; i++) manyKeys[`k${i}`] = i;
  const huge = {
    schema_version: 1,
    ...manyKeys,
    blocks: [
      ...Array.from({ length: 5 }, () => ({
        type: 'showcase',
        settings: { kinds: Array.from({ length: 50_000 }, (_, i) => (i % 2 ? 'work' : 'nope')) },
      })),
      { type: 'gallery', settings: { images: Array.from({ length: 100_000 }, () => ({ image: MEDIA.picture })) } },
      { type: 'featured_products', settings: { product_ids: Array.from({ length: 100_000 }, (_, i) => `p${i}`) } },
      { type: 'text', settings: { body: { ar: 'x'.repeat(1_000_000) } } },
      ...Array.from({ length: 100_000 }, () => ({ type: 'text' })),
    ],
  };
  const r = norm(huge);
  const ms = Date.now() - started;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.ok(r.issues.length <= MAX_ISSUES, `${r.issues.length} issues`);
  assert.ok(r.layout.blocks.length <= MAX_BLOCKS);
  const gallery = r.layout.blocks.find((b) => b.type === 'gallery')!;
  assert.equal((gallery.settings as { images: unknown[] }).images.length, BLOCKS.gallery.settings.images.max);
  const text = r.layout.blocks.find((b) => b.type === 'text')!;
  assert.equal((text.settings as { body: { ar: string } }).body.ar.length, 2000);
  // A fatal issue found after the list is full is still listed, and still refuses.
  const late = norm({ schema_version: 1, blocks: [{ type: 'text', settings: manyKeys }, { type: 'cta', settings: { link: 'javascript:alert(1)' } }] });
  assert.equal(late.issues.length, MAX_ISSUES, 'the list filled before the link was read');
  assert.equal(late.ok, false);
  assert.ok(late.issues.some((i) => i.fatal && i.code === 'unsafe_link'));
  assert.ok(late.issues.length <= MAX_ISSUES);
});
