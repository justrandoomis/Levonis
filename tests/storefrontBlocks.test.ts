/**
 * THE STORE PAGE'S BLOCKS — one component per block type, rendered for real.
 *
 *   - every block type in the schema has exactly one component, in the classic
 *     page's chunk or in the one lazy chunk;
 *   - blocks import only what a storefront may carry: never builder, dashboard
 *     or workspace code, never a chart library, never raw HTML;
 *   - every page that renders a store imports the store's stylesheet;
 *   - the classic page — the default layout, what every store that never
 *     published shows — has today's sections in today's order, in Arabic and
 *     English (the pixel comparison against the old page is the screenshot
 *     pass; this pins the structure in CI);
 *   - every block renders with real data in both languages;
 *   - the theme reaches the page only as data attributes carrying enum values,
 *     and changing it changes no text.
 *
 * Run: node --import tsx --test tests/storefrontBlocks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ROOT } from './fixtures/d1';
import { MEDIA, PRINTER_HOUR_IQD, STORE_NAME } from './fixtures/storeLayout';
import { attributeValues, fixtureData, fixtureStore, renderStore, visibleText } from './fixtures/storefrontRender';
import { CORE_BLOCKS, TAB_VIEW_BLOCKS } from '../src/components/storefront/StoreRenderer';
import { TAB_BLOCKS } from '../src/components/storefront/blocks/tabViews';
import { EXTRA_BLOCKS } from '../src/components/storefront/blocks/extra';
import { BLOCK_TYPES } from '../packages/storeLayout/src/blocks';
import { applyTheme, normalizeLayout } from '../packages/storeLayout/src/normalize';
import { defaultLayoutFromStore } from '../packages/storeLayout/src/defaults';
import { THEME_NAMES, TOKEN_VALUES, type ThemeTokens } from '../packages/storeLayout/src/tokens';
import type { StoreLayout } from '../packages/storeLayout/src/schema';

const STOREFRONT_DIR = 'src/components/storefront';

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const f of readdirSync(abs)) {
      const p = join(abs, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f)) out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, rel));
  return out.sort();
}
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const T = (ar: string, en: string) => ({ ar, en, ckb: '' });

/** One of every block, with the settings a merchant would give it. */
const EVERY_BLOCK = [
  { id: 'hero', type: 'hero', variant: 'profile' },
  {
    id: 'banner',
    type: 'banner',
    settings: {
      image: MEDIA.picture,
      title: T('تخفيضات الخريف', 'Autumn sale'),
      subtitle: T('خصم على المجسمات', 'Figures on sale'),
      cta_label: T('تسوّق العروض', 'Shop the deals'),
      link: { kind: 'route', route: 'deals' },
    },
  },
  {
    id: 'image-text',
    type: 'image_text',
    settings: {
      image: MEDIA.picture2,
      title: T('ورشتنا', 'Our workshop'),
      body: T('نطبع كل قطعة بعناية.', 'We print every part with care.'),
      cta_label: T('الخدمات', 'See services'),
      link: { kind: 'route', route: 'services' },
    },
  },
  { id: 'grid', type: 'products_grid', settings: { title: T('رف المجسمات', 'Figure shelf'), source: 'collection', collection_id: 'sec1', limit: 4 } },
  { id: 'carousel', type: 'products_carousel', settings: { title: T('وصل حديثًا', 'Just in'), source: 'latest', limit: 6 } },
  { id: 'featured', type: 'featured_products', settings: { title: T('اختياراتنا', 'Our picks'), product_ids: ['p3', 'p5'] } },
  { id: 'collections', type: 'collections', variant: 'cards', settings: { title: T('تصفح الأقسام', 'Browse sections') } },
  { id: 'deals', type: 'deals', settings: { title: T('أسعار مخفضة', 'Marked down') } },
  { id: 'coupon', type: 'coupon_banner', settings: { coupon_id: 'cp1', title: T('كوبون الافتتاح', 'Opening coupon') } },
  { id: 'countdown', type: 'countdown', settings: { title: T('ينتهي العرض', 'Offer ends'), ends_at: '2099-01-01T00:00:00.000Z' } },
  { id: 'services', type: 'services', settings: { title: T('ما نقدمه', 'What we do') } },
  { id: 'showcase', type: 'showcase', settings: { title: T('من أعمالنا', 'Our work') } },
  { id: 'reviews', type: 'reviews', settings: { title: T('آراء الزبائن', 'Customer reviews') } },
  { id: 'faq', type: 'faq', settings: { items: [{ q: T('كم مدة الطباعة؟', 'How long does printing take?'), a: T('يومان عادةً.', 'Usually two days.') }] } },
  { id: 'text', type: 'text', settings: { title: T('عن الخامات', 'About materials'), body: T('نستخدم خامات مضمونة.', 'We use trusted materials.') } },
  { id: 'gallery', type: 'gallery', settings: { images: [{ image: MEDIA.picture, caption: T('نموذج معماري', 'Architectural model') }] } },
  { id: 'video', type: 'video', settings: { video: MEDIA.video, poster: MEDIA.picture, title: T('جولة في الورشة', 'Workshop tour') } },
  { id: 'socials', type: 'social_links', settings: { source: 'custom', items: [{ provider: 'instagram', handle: 'raf3d' }] } },
  { id: 'cta', type: 'cta', settings: { title: T('عندك فكرة؟', 'Got an idea?'), label: T('راسلنا الآن', 'Message us now'), link: { kind: 'route', route: 'about' } } },
  { id: 'contact', type: 'contact' },
  { id: 'delivery', type: 'delivery_info' },
  { id: 'printers', type: 'printers' },
  { id: 'custom', type: 'custom_request_cta', settings: { title: T('طلب خاص', 'A custom job'), body: T('صف ما تريد.', 'Describe it.'), label: T('اطلب الآن', 'Ask now') } },
  { id: 'stats', type: 'stats' },
  { id: 'info', type: 'info_cards' },
  { id: 'tabs', type: 'tabs' },
  { id: 'about', type: 'about' },
];

const everyLayout = (): StoreLayout => {
  const r = normalizeLayout({ schema_version: 1, theme: 'classic', blocks: EVERY_BLOCK }, { ownerUserId: 'owner' });
  assert.deepEqual(r.issues, [], 'the fixture layout is clean');
  return r.layout;
};

// ------------------------------------------------------------------ registry

const fileOfType = (t: string) => `${t.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}.tsx`;

/** Static imports only (`import … from`, `export … from`, bare `import '…'`), resolved to files. */
function staticImportFiles(rel: string): string[] {
  const out: string[] = [];
  for (const m of read(rel).matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s+)?'(\.[^']+)'/g)) {
    const base = relative(ROOT, resolve(dirname(join(ROOT, rel)), m[1])).replace(/\\/g, '/');
    for (const ext of ['.tsx', '.ts', '']) {
      try {
        if (statSync(join(ROOT, base + ext)).isFile()) {
          out.push(base + ext);
          break;
        }
      } catch {
        /* next extension */
      }
    }
  }
  return out;
}

function staticClosure(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !f.startsWith('src/')) continue;
    seen.add(f);
    queue.push(...staticImportFiles(f));
  }
  return seen;
}

test('every block type has exactly one component: in the storefront chunk, the tab-views chunk or the extra chunk', () => {
  const core = Object.keys(CORE_BLOCKS);
  const tabs = Object.keys(TAB_BLOCKS);
  const extra = Object.keys(EXTRA_BLOCKS);
  const all = [...core, ...tabs, ...extra];
  assert.equal(new Set(all).size, all.length, 'no type in two chunks');
  assert.deepEqual(all.sort(), [...BLOCK_TYPES].sort());
  assert.ok(BLOCK_TYPES.length >= 25);
  assert.deepEqual([...TAB_VIEW_BLOCKS].sort(), [...tabs].sort(), 'the renderer sends exactly the tab-views types to that chunk');
  // What a visitor sees first on the classic page ships with the storefront;
  // nothing else does.
  assert.deepEqual([...core].sort(), ['hero', 'products_grid', 'tabs']);

  // One file per block type.
  const helpers = new Set(['extra.tsx', 'tabViews.tsx', 'HeroVariants.tsx']);
  const blockFiles = readdirSync(join(ROOT, STOREFRONT_DIR, 'blocks')).filter((f) => f.endsWith('.tsx') && !helpers.has(f));
  assert.deepEqual(blockFiles.sort(), BLOCK_TYPES.map(fileOfType).sort());

  // The two lazy chunks are only ever imported dynamically.
  const renderer = read(`${STOREFRONT_DIR}/StoreRenderer.tsx`);
  assert.match(renderer, /lazy\(\(\) => import\('\.\/blocks\/extra'\)\)/);
  assert.match(renderer, /lazy\(\(\) => import\('\.\/blocks\/tabViews'\)\)/);
  const lazyFiles = new Set([
    ...[...tabs, ...extra].map((t) => `${STOREFRONT_DIR}/blocks/${fileOfType(t)}`),
    ...[...helpers].map((f) => `${STOREFRONT_DIR}/blocks/${f}`),
    `${STOREFRONT_DIR}/preview.tsx`,
  ]);
  for (const page of [`${STOREFRONT_DIR}/StoreRenderer.tsx`, 'src/pages/Storefront.tsx', 'src/pages/StorefrontProduct.tsx']) {
    const closure = staticClosure(page);
    const leaked = [...closure].filter((f) => lazyFiles.has(f));
    assert.deepEqual(leaked, [], `${page} statically reaches lazy code — it would ship with every store visit`);
    assert.ok(![...closure].some((f) => f.includes('/storeDesign/')), `${page} reaches the design panel`);
  }
  // …and each lazy block is reachable from its own chunk.
  const tabClosure = staticClosure(`${STOREFRONT_DIR}/blocks/tabViews.tsx`);
  for (const t of tabs) assert.ok(tabClosure.has(`${STOREFRONT_DIR}/blocks/${fileOfType(t)}`), t);
  const extraClosure = staticClosure(`${STOREFRONT_DIR}/blocks/extra.tsx`);
  for (const t of extra) assert.ok(extraClosure.has(`${STOREFRONT_DIR}/blocks/${fileOfType(t)}`), t);
  assert.ok(extraClosure.has(`${STOREFRONT_DIR}/blocks/HeroVariants.tsx`));
});

// -------------------------------------------------------------- source rules

/** Where a storefront file may import from, beyond its own directory. */
const ALLOWED_IMPORTS = [
  /^react$/,
  /^react-router-dom$/,
  /^lucide-react$/,
  /^packages\/storeLayout\/src\/[a-z]+$/,
  /^src\/LanguageContext$/,
  /^src\/lib\/merchant$/,
  /^src\/lib\/governorates$/,
  /^src\/components\/ui\/Tabs$/,
  /^src\/components\/merchant\/profileIcons$/,
  /^src\/components\/merchant\/ProMerchantBadge$/,
];

function importsOf(rel: string): string[] {
  const src = read(rel);
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'";]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)|(?:^|\n)\s*import\s+'([^']+)'/g)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    if (spec.startsWith('.')) {
      out.push(relative(ROOT, resolve(dirname(join(ROOT, rel)), spec)).replace(/\\/g, '/'));
    } else out.push(spec);
  }
  return out;
}

test('blocks import only what a storefront may carry — never builder, dashboard or workspace code', () => {
  const files = filesUnder(STOREFRONT_DIR);
  assert.ok(files.length >= 30, 'the renderer and its blocks are all checked');
  const offenders: string[] = [];
  for (const f of files) {
    for (const spec of importsOf(f)) {
      if (spec.startsWith(`${STOREFRONT_DIR}/`)) continue;
      if (!ALLOWED_IMPORTS.some((re) => re.test(spec))) offenders.push(`${f} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'a new import here must be added to ALLOWED_IMPORTS deliberately');
  // And the named things never sneak in through an allowed module.
  for (const f of files) {
    const src = read(f);
    for (const banned of [/merchant\/dashboard/, /storeDesign/, /\/builder/, /workspace/i, /recharts/, /\/pages\//, /\/admin/]) {
      assert.ok(!banned.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${f} mentions ${banned}`);
    }
  }
});

test('no raw HTML, no frames, no code from strings, no inline style but one computed width', () => {
  const files = [...filesUnder(STOREFRONT_DIR), 'src/pages/Storefront.tsx'];
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const banned of [/dangerouslySetInnerHTML/, /<iframe/i, /<embed/i, /<object/i, /\beval\(/, /new Function\(/, /\.innerHTML/, /document\.write/, /srcDoc/]) {
      assert.ok(!banned.test(src), `${f}: ${banned}`);
    }
    const styles = src.match(/style=\{\{[^}]*\}\}/g) ?? [];
    for (const s of styles) {
      assert.ok(
        f.endsWith('blocks/Reviews.tsx') && s === 'style={{ width: `${pct}%` }}',
        `${f}: inline style ${s} — theme values are data attributes, never inline CSS`
      );
    }
    // Every new-tab link cuts the opener.
    for (const m of src.matchAll(/target="_blank"[^>]*/g)) {
      assert.match(m[0], /rel="noopener noreferrer(?: nofollow)?"/, `${f}: ${m[0].slice(0, 80)}`);
    }
  }
});

test('every page that renders a store imports the store stylesheet, and the renderer itself does not', () => {
  const pages: string[] = [];
  for (const f of filesUnder('src')) {
    if (f.startsWith(STOREFRONT_DIR)) continue;
    const src = read(f);
    if (/from '[^']*storefront\/(StoreRenderer|StoreTheme)'/.test(src)) {
      pages.push(f);
      assert.match(src, /import '[^']*storefront\/styles';/, `${f} renders a store without its stylesheet`);
    }
  }
  assert.ok(pages.includes('src/pages/Storefront.tsx'));
  assert.ok(pages.includes('src/pages/StorefrontProduct.tsx'));
  // The renderer stays importable in Node (these tests) and in the builder's
  // preview: the stylesheet is the page's to bring.
  for (const f of filesUnder(STOREFRONT_DIR)) {
    if (f.endsWith('styles.ts')) continue;
    assert.ok(!/\.css'/.test(read(f)), `${f} imports CSS`);
  }
  assert.match(read(`${STOREFRONT_DIR}/styles.ts`), /import '\.\/theme\.css';/);
});

// ------------------------------------------------------------ the classic page

test('the classic page (default layout) has today\'s sections in today\'s order — Arabic', async () => {
  const store = await fixtureStore();
  assert.equal(store.layout_source, 'default');
  const html = await renderStore(store);
  const text = visibleText(html);
  const order = [
    STORE_NAME,
    '@raf3d',
    'تقييم إيجابي',
    'منتجات',
    'متابعون',
    'ورشة طباعة ثلاثية الأبعاد في بغداد',
    'instagram.com/raf3d',
    'موقعنا',
    '4 طابعات',
    'شحن سريع',
    'تواصل مع المتجر',
    'المنتجات',
    'الأقسام',
    'العروض',
    'الخدمات',
    'المعرض',
    'عن المتجر',
    'أحدث المنتجات',
  ];
  let at = -1;
  for (const s of order) {
    const i = text.indexOf(s, at + 1);
    assert.ok(i > at, `«${s}» appears after the previous section (${text.slice(Math.max(0, at - 40), at + 80)})`);
    at = i;
  }
  // The Products tab as it always was: the merchant's featured picks first,
  // then newest first, six of them, and «View all» for the rest.
  const names = ['مصباح بالاسم', 'مجسم تنين مفصلي', 'ميدالية مفاتيح بالشعار', 'أصيص نباتات هندسي', 'هيكل درون 250', 'طقم شطرنج كامل'];
  let p = at;
  for (const n of names) {
    const i = text.indexOf(n, p + 1);
    assert.ok(i > p, `product «${n}» in order`);
    p = i;
  }
  assert.ok(!text.includes('حامل هاتف قابل للطي'), 'the seventh product waits for «View all»');
  assert.ok(text.includes('عرض الكل'));
  // The blocks and their order.
  assert.deepEqual(attributeValues(html, 'data-block'), ['hero', 'tabs']);
  // The theme element carries the classic tokens.
  assert.match(html, /data-store-theme=""/);
  assert.match(html, /data-sf-surface="glow"/);
});

test('the classic page in English', async () => {
  const store = await fixtureStore();
  const text = visibleText(await renderStore(store, { lang: 'en' }));
  for (const s of ['Positive rating', 'Products', 'Followers', 'Contact the store', 'Sections', 'Deals', 'Services', 'Showcase', 'About', 'Latest products']) {
    assert.ok(text.includes(s), `«${s}»`);
  }
  assert.ok(!text.includes('أحدث المنتجات'));
});

test('a published layout the renderer cannot show anything of falls back to the classic page', async () => {
  const store = await fixtureStore();
  const classic = await renderStore(store);
  for (const layout of [null, {}, { schema_version: 1, blocks: [] }, { schema_version: 1, blocks: [{ type: 'text', hidden: true }] }, { schema_version: 7 }]) {
    assert.equal(await renderStore({ ...store, layout: layout as never }), classic, JSON.stringify(layout));
  }
  assert.equal(await renderStore(store, { layout: defaultLayoutFromStore(store) }), classic);
});

// ------------------------------------------------------------- every block

test('every block renders with real data, in Arabic and in English', async () => {
  const store = await fixtureStore();
  const layout = everyLayout();
  const data = await fixtureData(layout);
  assert.ok(!JSON.stringify(data.printers).includes(String(PRINTER_HOUR_IQD)), 'a printer\'s cost never reaches the page');
  for (const lang of ['ar', 'en'] as const) {
    const html = await renderStore({ ...store, layout, blocks_data: data }, { lang, layout, data });
    assert.deepEqual(attributeValues(html, 'data-block'), EVERY_BLOCK.map((b) => b.type), `${lang}: every block, in order`);
    const text = visibleText(html);
    const expect =
      lang === 'ar'
        ? ['تخفيضات الخريف', 'ورشتنا', 'رف المجسمات', 'وصل حديثًا', 'اختياراتنا', 'تصفح الأقسام', 'أسعار مخفضة', 'RAF10', 'ينتهي العرض', 'ما نقدمه', 'من أعمالنا', 'آراء الزبائن', 'كم مدة الطباعة؟', 'نستخدم خامات مضمونة.', 'نموذج معماري', 'جولة في الورشة', 'عندك فكرة؟', 'X1C', 'طلب خاص', 'طباعة حسب الطلب', 'مجسم معماري']
        : ['Autumn sale', 'Our workshop', 'Figure shelf', 'Just in', 'Our picks', 'Browse sections', 'Marked down', 'RAF10', 'Offer ends', 'What we do', 'Our work', 'Customer reviews', 'How long does printing take?', 'We use trusted materials.', 'Architectural model', 'Workshop tour', 'Got an idea?', 'X1C', 'A custom job'];
    for (const s of expect) assert.ok(text.includes(s), `${lang}: «${s}»`);
    // Pictures and video are this store's files, by key.
    const srcs = attributeValues(html, 'src');
    assert.ok(srcs.includes(`/files/${MEDIA.picture}`));
    assert.ok(srcs.includes(`/files/${MEDIA.video}`));
    for (const s of srcs) assert.match(s, /^\/files\/(merchants|community)\/[A-Za-z0-9_-]+\//, s);
    // The social link was built from the provider's template.
    assert.ok(attributeValues(html, 'href').includes('https://www.instagram.com/raf3d'));
    // The collection shelf shows that collection's products only.
    const shelf = html.slice(html.indexOf('data-block-id="grid"'), html.indexOf('data-block-id="carousel"'));
    assert.ok(visibleText(shelf).includes('مجسم تنين مفصلي'), 'the fixture names its products in Arabic in both columns');
    assert.ok(!visibleText(shelf).includes('طقم تروس صناعية'), 'a product of another collection is not on the shelf');
  }
});

test('a link to one of the store\'s products goes to that product\'s own address; a link to one that is gone is not drawn', async () => {
  const store = await fixtureStore();
  const layout = normalizeLayout(
    {
      schema_version: 1,
      blocks: [
        { id: 'go', type: 'cta', settings: { title: T('المصباح', 'The lamp'), label: T('إلى المصباح', 'To the lamp'), link: { kind: 'product', id: 'p3' } } },
        { id: 'gone', type: 'cta', settings: { title: T('قديم', 'Old'), label: T('منتج محذوف', 'A removed product'), link: { kind: 'product', id: 'zz9' } } },
      ],
    },
    { ownerUserId: 'owner' }
  ).layout;
  const data = await fixtureData(layout);
  const html = await renderStore({ ...store, layout, blocks_data: data }, { layout, data, runtime: { productHref: (slug: string) => `/p/${slug}` } });
  assert.ok(attributeValues(html, 'href').includes('/p/raf3d-p3'));
  assert.ok(visibleText(html).includes('إلى المصباح'));
  assert.ok(!visibleText(html).includes('منتج محذوف'), 'no button to nowhere');
});

test('a block the visitor should not see is not rendered, and per-width visibility is a container query', async () => {
  const store = await fixtureStore();
  const layout = normalizeLayout(
    {
      schema_version: 1,
      blocks: [
        { id: 'shown', type: 'text', settings: { body: T('مرئي', 'Shown') } },
        { id: 'gone', type: 'text', hidden: true, settings: { body: T('مخفي', 'Hidden') } },
        { id: 'wide', type: 'text', visibility: { mobile: false, desktop: true }, settings: { body: T('للشاشات الكبيرة', 'Wide only') } },
        { id: 'narrow', type: 'text', visibility: { mobile: true, desktop: false }, settings: { body: T('للهاتف', 'Phone only') } },
      ],
    },
    { ownerUserId: 'owner' }
  ).layout;
  const html = await renderStore(store, { layout });
  assert.deepEqual(attributeValues(html, 'data-block-id'), ['shown', 'wide', 'narrow']);
  assert.ok(!visibleText(html).includes('مخفي'));
  const classOf = (id: string) => html.match(new RegExp(`data-block-id="${id}" class="([^"]*)"`))?.[1] ?? '';
  assert.equal(classOf('wide'), 'hidden @min-[48rem]:block');
  assert.equal(classOf('narrow'), '@min-[48rem]:hidden');
  assert.match(html, /class="@container relative z-0"/, 'the page is a container, so a preview frame lays out like a device');
});

// -------------------------------------------------------------------- theme

test('the theme reaches the page only as data attributes with enum values, and changing it changes no text', async () => {
  const store = await fixtureStore();
  // Without the countdown, whose remaining time moves between two renders.
  const base = { ...everyLayout(), blocks: everyLayout().blocks.filter((b) => b.type !== 'countdown') };
  const data = await fixtureData(base);
  let reference = '';
  for (const theme of THEME_NAMES) {
    const layout = applyTheme(base, theme);
    const html = await renderStore({ ...store, layout, blocks_data: data }, { layout, data });
    const root = html.match(/<div data-store-theme=""([^>]*)>/);
    assert.ok(root, `${theme}: the theme element`);
    const attrs = [...root[1].matchAll(/data-sf-([a-z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]] as const);
    assert.ok(attrs.length >= 8, `${theme}: tokens as attributes`);
    for (const [name, value] of attrs) {
      const key = name.replace(/-/g, '_') as keyof ThemeTokens;
      const allowed = (TOKEN_VALUES as Record<string, readonly unknown[]>)[key];
      if (allowed) assert.ok(allowed.map(String).includes(value), `${theme}: data-sf-${name}="${value}"`);
      else assert.match(value, /^[a-z0-9_]+$/, `${theme}: data-sf-${name}`);
    }
    const text = visibleText(html);
    if (!reference) reference = text;
    else assert.equal(text, reference, `${theme}: the same words, in the same order`);
  }
});
