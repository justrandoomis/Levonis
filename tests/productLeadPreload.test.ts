/**
 * THE PRODUCT PAGE'S MAIN PHOTO IS PRELOADED IN BOTH THEMES, WHEN IT IS
 * CERTAIN (speed audit 2026-10-16, «the product's main photo is not preloaded
 * on 25 of 26 live product pages»; worker/lib/productOpeningLead.ts,
 * worker/lib/socialPreview.ts `leadImagePreloads`).
 *
 * The preload was suppressed whenever the product had a light-theme main
 * image (25 of 26 live) or a picture bound to an option or a colour (24 of
 * 26), although the page opened on its primary for 21 of them: the photo then
 * waited for all of the product's code and its first render. Now:
 *
 *   - the lead is written once per theme, each under the media query the theme
 *     boot script decides by, exactly as Product.tsx renders it in that theme;
 *   - with bound pictures, the document reads the guest's copy of the very
 *     answer the page will read (this colo's, never a build) and preloads only
 *     when the page's opening selection is provably EMPTY — the server's
 *     shelf, the import's defaults, a single option or colour, or a selection
 *     in the address each mean no preload;
 *   - that rule is Product.tsx's (its source is pinned here) and gives the
 *     lead the page's own gallery functions give.
 *
 * Run: node --import tsx --test tests/productLeadPreload.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { APEX, asD1, ctx, freshDb, pending } from './fixtures/app';
import { fetchPublished } from './fixtures/autoPublish';
import worker from '../worker/index';
import { openingLeadFromDetail, type OpeningLead } from '../worker/lib/productOpeningLead';
import { MANIFEST_PATH, THEME_MEDIA, leadImagePreloads, productImagePreload } from '../worker/lib/socialPreview';
import { PURGE_MARKER_CACHE } from '../worker/lib/edgePolicy';
import { DOCUMENT_CACHE_CONTROL } from '../worker/lib/securityPolicy';
import { dedupeByUrl, galleryForSelection, lightMainImageSize, mediaInStoredOrder, withLightMainImage } from '../src/lib/productGallery';
import { defaultSelection } from '../src/lib/productChooser';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const MAIN = '/files/products/filament-pla/main.webp';
const LIGHT = '/files/products/filament-pla/light.webp';
const RED = '/files/products/filament-pla/red.webp';

// ------------------------------------------------------------- the rule

const detailOf = (over: Record<string, unknown> = {}, product: Record<string, unknown> = {}) => ({
  success: true,
  initial_selection: null,
  relations: { option_groups: [], variants: [], images: [] },
  ...over,
  product: {
    media: [
      { url: RED, primary: false, order: 1, color_id: 'red', width: 900, height: 900 },
      { url: MAIN, primary: true, order: 0, width: 1254, height: 1254 },
    ],
    options: [],
    colors: [{ id: 'red', name_en: 'Red' }, { id: 'blue', name_en: 'Blue' }],
    light_image: LIGHT,
    ...product,
  },
});

test('an empty opening selection: the stored primary in the dark theme, the light main image (at the primary\'s size) in the light one', () => {
  assert.deepEqual(openingLeadFromDetail(detailOf()), {
    dark: { url: MAIN, width: 1254, height: 1254 },
    light: { url: LIGHT, width: 1254, height: 1254 },
  } satisfies OpeningLead);
  // Its own stored size, when the answer carries one, wins (src/lib/productGallery.ts lightMainImageSize).
  assert.deepEqual(openingLeadFromDetail(detailOf({}, { light_image_width: 900, light_image_height: 600 }))?.light, { url: LIGHT, width: 900, height: 600 });
  assert.deepEqual(openingLeadFromDetail(detailOf({}, { light_image: '' }))?.light, null);
  assert.deepEqual(openingLeadFromDetail(detailOf(), '?ref=ali'), openingLeadFromDetail(detailOf()), 'a referral changes nothing');
});

test('catalogue defaults, stocked SKUs and lone choices leave the opening photo unchanged', () => {
  const examples = [
    detailOf({ initial_selection: { fulfillment_type: 'direct_sale', option_value_ids: ['a'], color_id: 'red' } }),
    detailOf({ relations: { option_groups: [{ id: 'g', default_value_id: 'a', values: [{ id: 'a' }, { id: 'b' }] }] } }),
    detailOf({ relations: { option_groups: [{ id: 'g', kind: 'color', values: [{ id: 'a' }] }] } }),
    detailOf({}, { options: [{ id: 'only' }], colors: [{ id: 'red' }] }),
    detailOf({}, { colors: [{ id: 'red', option_id: 'a' }] }),
  ];
  for (const example of examples) assert.deepEqual(openingLeadFromDetail(example), openingLeadFromDetail(detailOf()));
  for (const search of ['?price_request=abc', '?alert=xyz', '?v=o:a|c:red']) assert.equal(openingLeadFromDetail(detailOf(), search), null);
  assert.equal(openingLeadFromDetail({ success: false }), null);
  assert.equal(openingLeadFromDetail(detailOf({}, { media: [], images: [] })), null);
});

test('the rule is Product.tsx\'s, and its lead is the one the page\'s own gallery functions give', () => {
  const page = read('src/pages/Product.tsx');
  // Empty ordinary arrivals and explicit deep links, as the page spells them.
  for (const pin of [
    'setOptionValueIds([]);',
    "setColorId('');",
    "location.search.indexOf(`${PRICE_REQUEST_PARAM}=`)",
    "location.search.indexOf('alert=')",
    "const light = theme === 'light' ? (product.light_image ?? '').trim() : '';",
    'const primary = dedupeByUrl(rows)[0];',
    '{ width: product.light_image_width, height: product.light_image_height },',
    'return withLightMainImage(ordered, primary.url, light, size);',
  ]) assert.ok(page.includes(pin), `Product.tsx no longer says: ${pin} — worker/lib/productOpeningLead.ts must follow it`);
  assert.match(read('src/lib/productGallery.ts'), /if \(!hasSelection\(selection\)\) return dedupeByUrl\(media\);/);
  assert.match(read('src/lib/productChooser.ts'), /\(g\.kind \?\? ''\) !== '' \|\| \(g\.default_value_id \?\? ''\) !== '' \|\| g\.values\.some\(\(v\) => !!v\.swatch && \(!!v\.swatch\.url \|\| !!v\.swatch\.published_hex\)\)/);
  // Where the worker answers, the page's own functions lead with the same picture, in each theme.
  for (const d of [detailOf(), detailOf({}, { media: [{ url: RED, color_id: 'red', order: 0 }, { url: MAIN, order: 1 }] })]) {
    const lead = openingLeadFromDetail(d)!;
    const product = d.product as { media: Array<{ url: string; width?: number; height?: number }>; light_image: string };
    const rows = mediaInStoredOrder(product.media);
    const ordered = galleryForSelection(rows, [], { groups: [], variants: [] } as never, {});
    assert.equal(lead.dark.url, ordered[0].url);
    assert.equal(lead.dark.width, ordered[0].width ?? null);
    const primary = dedupeByUrl(rows)[0];
    // The page's first render: nothing measured yet (observedAspect null).
    const lightLead = withLightMainImage(ordered, primary?.url, product.light_image, lightMainImageSize(primary, null, null))[0];
    assert.deepEqual(
      { url: lead.light!.url, width: lead.light!.width, height: lead.light!.height },
      { url: lightLead.url, width: lightLead.width ?? null, height: lightLead.height ?? null }
    );
    assert.deepEqual(defaultSelection([], []), [], 'and no import defaults for a product without its groups');
  }
});

test('the preload lines: once per theme under the boot script\'s media queries, as each theme renders it; one line when both are the same', () => {
  const pair = leadImagePreloads({ dark: { url: MAIN, width: 1254, height: 1254 }, light: { url: LIGHT, width: null, height: null } });
  assert.deepEqual(pair, [
    { href: MAIN, ...productImagePreload(MAIN, { width: 1254, height: 1254 }), media: '(prefers-color-scheme: dark)' },
    { href: LIGHT, ...productImagePreload(LIGHT, { width: null, height: null }), media: 'not all and (prefers-color-scheme: dark)' },
  ]);
  // The theme boot script: dark when the device prefers dark (unless saved), light otherwise.
  assert.match(read('worker/lib/securityPolicy.ts'), /matchMedia\('\(prefers-color-scheme: dark\)'\)\.matches\);t=d\?'dark':'light'/);
  assert.equal(THEME_MEDIA.dark, '(prefers-color-scheme: dark)');
  assert.deepEqual(leadImagePreloads({ dark: { url: MAIN, width: null, height: null }, light: { url: MAIN, width: null, height: null } }), [{ href: MAIN, ...productImagePreload(MAIN) }]);
  assert.deepEqual(leadImagePreloads({ dark: { url: MAIN, width: 800, height: 800 }, light: null }), [{ href: MAIN, ...productImagePreload(MAIN, { width: 800, height: 800 }) }]);
  assert.deepEqual(leadImagePreloads({ dark: { url: 'https://cdn.example/x.webp', width: null, height: null }, light: null }), [], 'never a foreign picture');
  assert.deepEqual(leadImagePreloads(null), []);
});

// ------------------------------------------------------- the document, in place

const SHELL = '<!doctype html><html><head><title>LEVONIS</title><meta property="og:title" content="LEVONIS" /><meta property="og:image" content="https://levonis-iq.com/x.webp" /></head><body></body></html>';

function liveWorker() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, price_iqd, status, light_image) VALUES ('p1', 'filament-pla', 'PLA', 'خيط PLA', 100000, 'active', '${LIGHT}');
    INSERT INTO product_images (id, product_id, url, r2_key, is_primary, sort_order, width, height)
      VALUES ('pi1','p1','${MAIN}','products/filament-pla/main.webp',1,0,1254,1254);
    INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g1','p1','Model');
    INSERT INTO product_option_values (id,product_id,group_id,name_en,sort,stock) VALUES
      ('first','p1','g1','First',0,0), ('second','p1','g1','Second',1,0);
    INSERT INTO product_images (id,product_id,url,r2_key,sort_order,option_value_id)
      VALUES ('bound','p1','/files/products/filament-pla/second.webp','products/filament-pla/second.webp',1,'second');
    UPDATE products SET inventory_mode = 'OPTION', stock = 0 WHERE id = 'p1';
  `);
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async (req: Request) => new URL(req.url).pathname === MANIFEST_PATH
        ? new Response('{}', { headers: { 'content-type': 'application/json' } })
        : new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': DOCUMENT_CACHE_CONTROL } }),
    },
  };
  const call = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetchPublished(worker, new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '9.9.9.9', ...headers } }), env as never, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { raw, call };
}

/** caches.default and the purge markers' named cache, as Map-backed stand-ins. */
async function withCaches(run: () => Promise<void>) {
  const store = () => {
    const m = new Map<string, Response>();
    return {
      async match(r: Request) { const x = m.get(r.url); return x ? x.clone() : undefined; },
      async put(r: Request, res: Response) { m.set(r.url, new Response(await res.arrayBuffer(), res)); },
      async delete(r: Request) { return m.delete(r.url); },
    };
  };
  const scope = globalThis as { caches?: unknown };
  const markers = store();
  scope.caches = { default: store(), open: async (name: string) => (name === PURGE_MARKER_CACHE ? markers : store()) };
  try {
    await run();
  } finally {
    delete scope.caches;
  }
}

const imagePreloads = (html: string) => [...html.matchAll(/<link rel="preload" as="image"[^>]*>/g)].map((m) => m[0]);

test('a bound gallery that opens on its primary: preloaded once per theme from the page\'s own answer this colo holds', async () => {
  await withCaches(async () => {
    const { call } = liveWorker();
    // Before any guest asked for the answer, the document knows nothing more than the rows: no preload (as before).
    assert.deepEqual(imagePreloads(await (await call('/product/filament-pla')).text()), []);
    const detail = await call('/api/products/filament-pla');
    assert.equal(detail.status, 200);
    assert.equal(((await detail.json()) as { initial_selection: unknown }).initial_selection, null);
    const html = await (await call('/product/filament-pla')).text();
    const lines = imagePreloads(html);
    assert.equal(lines.length, 2, html);
    assert.ok(lines[0].includes(`href="${MAIN}"`) && lines[0].includes(`media="${THEME_MEDIA.dark}"`) && lines[0].includes('?w=1280 1254w'), lines[0]);
    assert.ok(lines[1].includes(`href="${LIGHT}"`) && lines[1].includes(`media="${THEME_MEDIA.light}"`), lines[1]);
    assert.ok(!html.includes('second.webp'), 'never the bound picture');
    // A selection in the address: the page restores it, so nothing is preloaded.
    assert.deepEqual(imagePreloads(await (await call('/product/filament-pla?price_request=x')).text()), []);
  });
});

test('a stocked suggested SKU does not replace the main photo on an ordinary arrival', async () => {
  await withCaches(async () => {
    const { call, raw } = liveWorker();
    raw.prepare("UPDATE product_option_values SET stock = 3 WHERE id = 'second'").run();
    const detail = (await (await call('/api/products/filament-pla')).json()) as { initial_selection: { option_value_ids: string[] } | null };
    assert.deepEqual(detail.initial_selection?.option_value_ids, ['second'], 'the real server-selected shelf');
    const preloads = imagePreloads(await (await call('/product/filament-pla')).text());
    assert.equal(preloads.length, 2);
    assert.ok(preloads[0].includes(`href="${MAIN}"`));
  });
});
