/**
 * LEAK AUDIT — search-seo-html: the SERVER-REWRITTEN DOCUMENTS and the
 * crawler files were never swept for cost.
 *
 * THE CANDIDATE (guard gap). The cost sweeps never request a document:
 *   - tests/fixtures/roleMatrix.ts builds its app with stubApp(), which mounts
 *     BASE_MOUNTS only — not the worker's top-level `app.get` routes
 *     (/manifest.webmanifest, /store-icon/:name, /robots.txt, /sitemap.xml)
 *     and not `app.notFound` → `assetWithPreview`, the share-card rewrite;
 *   - tests/securityPricingLeak.test.ts fetches '/' and '/p/a1' through the
 *     real worker but looks only for the FX and batch sentinels — never the
 *     costlyProduct COST sentinels or a FINANCIAL_FIELDS key;
 *   - tests/socialPreview, storeShareCards, documentPreloads and seoRoutes
 *     seed only price_iqd and assert tag shape.
 * Those documents are sent `public, s-maxage=60` (the card) or with an hour /
 * fifteen-minute public lifetime (robots, sitemap) and are held by chat-app
 * unfurlers and crawlers for days, so a cost written into one would travel
 * far and fail no test.
 *
 * THE TEST. The role-matrix world (the costly product `a1` with a different
 * sentinel cost on every level, a received lot, an open purchase, a delivered
 * order) plus the FX and batch sentinels, plus the pricing engine's private
 * inputs for `a1` (supplier cost in USD, extra per-piece cost, minimum target
 * profit) seeded with values of their own, plus a merchant store `ali3d` with
 * one published product. The REAL worker (worker/index.ts `fetch`) is called
 * with a fake asset layer that serves a realistic shell (title, description,
 * og:*, twitter:*) and Vite's manifest, on BOTH hosts:
 *
 *   apex   /  /products  /products?search=…  /product/a1  /bundles/a1  /p/a1
 *          /community/store/ali3d  /community/store/ali3d/p/ali3d-bracket
 *          /sitemap.xml  /robots.txt  /manifest.webmanifest  /store-icon/*
 *          /orders (an SPA path that loads the session)
 *   store  /  /p/ali3d-bracket  /p/a1  /sitemap.xml  /robots.txt
 *          /manifest.webmanifest  /store-icon/*
 *
 * as a guest AND with a real session cookie of every non-owner role of the
 * matrix (and the owner — a shared-cache document must not differ for the
 * owner either). Each answer — body, every header but the ETag, the parsed
 * lv-resolve JSON block, the share-card tags, a JSON body — is walked with
 * `leaks()` (cost-named numbers, FINANCIAL_FIELDS keys, every sentinel as a
 * number or as digits in text) and with a scan for every extra private figure
 * this file seeds, and for any FINANCIAL_FIELDS key NAME written into the
 * markup.
 *
 * Positive controls: the private figures are IN the database; the card for
 * `a1` really is the costly product's card (og:title, og:url); the resolve
 * block is present (and names the store on the store host); the sitemaps list
 * `a1` and the store's product; the store manifest names the store; and the
 * scanner catches a sentinel written the way a future share card would write
 * it (`product:price:amount`, JSON-LD Offer, a SELECT * row in the block).
 *
 * RESULT ON THE AUDITED TREE: green (15/15). No private value reaches any
 * caller through these documents today: the card reads an explicit column
 * list, the main-host block is the static resolve answer, the sitemap reads
 * slug and updated_at. The GAP was real — no committed guard requested these
 * documents with the cost scanner — and this file is that guard. Not vacuous:
 * a cost written into the product's text (a mutation run, not kept) fails
 * the guest sweep on /product/a1, /bundles/a1 and /p/a1 in the body, the
 * description, og:description and twitter:description.
 *
 * LOCAL ONLY. Run:
 *   node --import tsx --test tests/leakAudit_search-seo-html_seo_html_documents_unswept.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { APEX, asD1, ctx, row } from './fixtures/app';
import { COST, SENTINELS, leaks } from './fixtures/costlyProduct';
import { OWNER, ROLES, seededCopy } from './fixtures/roleMatrix';
import { BATCH_SENTINELS, FX_SENTINELS, seedBatchSentinels, seedFxSentinels } from './fixtures/fxSentinels';
import { FINANCIAL_FIELDS } from '../worker/lib/adminScope';
import { INLINE_RESOLVE_ID, MANIFEST_PATH, type ViteManifest } from '../worker/lib/socialPreview';
import { SESSION_COOKIE_NAME } from '../worker/lib/session';

// ---------------------------------------------------------------- the private figures this file adds

/** The pricing engine's private inputs for `a1` (0181 pricing_inputs / pricing_rules). */
const ENGINE = {
  supplierUsd: '377.4321', // supplier cost, USD
  targetProfitUsd: '83.17', // minimum target profit, USD
  extraCostIqd: 641_234, // additional (per-piece) cost, IQD
  shippingWeightG: 45_679, // private shipping measure
} as const;

const DECIMALS = [...FX_SENTINELS, ...BATCH_SENTINELS, ENGINE.supplierUsd, ENGINE.targetProfitUsd];
const EXTRA = { decimals: DECIMALS, numbers: [...DECIMALS.map(Number), ENGINE.extraCostIqd, ENGINE.shippingWeightG] };
/** Whole-number private figures as text: `leaks()` matches only COST inside strings. */
const INTEGER_TEXT = [...SENTINELS, ENGINE.extraCostIqd, ENGINE.shippingWeightG];

const STORE_HOST = `ali3d.${APEX}`;

// ---------------------------------------------------------------- the world

function world(): DatabaseSync {
  const raw = seededCopy();
  seedFxSentinels(raw);
  seedBatchSentinels(raw);
  const at = '2026-10-08T12:00:00.000Z';
  raw.exec(`
    UPDATE products SET description = 'Bambu Lab A1 printer', description_ar = 'طابعة بامبو A1', updated_at = '${at}' WHERE id = 'p_a1';
    INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, supplier_input_mode,
                                shipping_profile, shipping_weight_g, additional_cost_iqd, updated_by, updated_at)
      VALUES ('p_a1', 'base', '', 'MANUAL_OVERRIDE', '${ENGINE.supplierUsd}', 'USD', 'SOURCE_CURRENCY',
              'CHINA_AIR', ${ENGINE.shippingWeightG}, ${ENGINE.extraCostIqd}, 'usr_owner', '${at}');
    INSERT INTO pricing_rules (id, kind, scope, product_id, scope_id, state, amount_usd, source, updated_by, updated_at)
      VALUES ('pr_tp_a1', 'target_profit', 'product', 'p_a1', '', 'ACTIVE', '${ENGINE.targetProfitUsd}', 'OWNER', 'usr_owner', '${at}');
    -- The role-matrix seed gives u_m a store of its own (DECISIONS row 220); this world brings its own.
    DELETE FROM merchant_printers WHERE merchant_id = 'cm_um';
    DELETE FROM merchant_stores WHERE id = 'st_um';
    DELETE FROM community_merchants WHERE id = 'cm_um';
    INSERT INTO community_merchants (id, user_id, name) VALUES ('m1', 'u_m', 'Ali 3D');
    INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name, tagline)
      VALUES ('s1', 'm1', 'u_m', 'ali3d', 'Ali 3D', 'طباعة ثلاثية الأبعاد');
    INSERT INTO community_products (id, merchant_id, store_id, slug, name, name_ar, description_ar, images, status, lifecycle, price_iqd)
      VALUES ('cp1', 'm1', 's1', 'ali3d-bracket', 'Bracket', 'حامل رف', 'حامل متين',
              '["/files/merchants/u_m/public/aaaa1111.webp"]', 'active', 'active', 7000);
  `);
  return raw;
}

// ---------------------------------------------------------------- sessions: one real cookie per role

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const CALLERS: Record<string, string | null> = { guest: null };
function seedSessions(raw: DatabaseSync) {
  const users = { ...ROLES, owner: OWNER };
  for (const [name, user] of Object.entries(users)) {
    if (!user) continue;
    const token = `tok-${name}-0123456789abcdef0123456789abcdef`;
    raw.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, '2099-01-01T00:00:00.000Z');
    CALLERS[name] = token;
  }
}

// ---------------------------------------------------------------- the asset layer

const MANIFEST: ViteManifest = {
  'index.html': { file: 'assets/index-abc.js', isEntry: true, imports: ['_vendor-react-r1.js'], css: ['assets/index-abc.css'] },
  '_vendor-react-r1.js': { file: 'assets/vendor-react-r1.js' },
  'src/pages/Product.tsx': { file: 'assets/Product-p1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'], css: ['assets/Product-p1.css'] },
  'src/pages/Products.tsx': { file: 'assets/Products-ps1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'] },
  'src/pages/BundleDetail.tsx': { file: 'assets/BundleDetail-b1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'] },
  'src/pages/Storefront.tsx': { file: 'assets/Storefront-s1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'] },
  'src/pages/StorefrontProduct.tsx': { file: 'assets/StorefrontProduct-sp1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'] },
  'src/pages/CommunityStorePage.tsx': { file: 'assets/CommunityStorePage-c1.js', isDynamicEntry: true, imports: ['_vendor-react-r1.js'] },
};

const SHELL = [
  '<!doctype html><html lang="ar" dir="rtl"><head>',
  '<meta charset="utf-8" />',
  '<title>LEVONIS</title>',
  '<meta name="description" content="shop" />',
  '<meta property="og:site_name" content="LEVONIS" />',
  '<meta property="og:title" content="LEVONIS" />',
  '<meta property="og:description" content="shop" />',
  '<meta property="og:image" content="https://levonis-iq.com/files/UiUx/Logo/Logo.webp" />',
  '<meta property="og:url" content="https://levonis-iq.com/" />',
  '<meta name="twitter:card" content="summary_large_image" />',
  '<meta name="twitter:title" content="LEVONIS" />',
  '<meta name="twitter:description" content="shop" />',
  '<meta name="twitter:image" content="https://levonis-iq.com/files/UiUx/Logo/Logo.webp" />',
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>',
  '<link rel="modulepreload" crossorigin href="/assets/vendor-react-r1.js">',
  '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">',
  '</head><body><div id="root"></div></body></html>',
].join('\n');

function env(raw: DatabaseSync) {
  return {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        if (path === MANIFEST_PATH) return new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/json' } });
        if (/\.png$/i.test(path)) return new Response('PNG', { headers: { 'content-type': 'image/png' } });
        return new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8', etag: 'W/"asset"' } });
      },
    },
  };
}

// ---------------------------------------------------------------- what is fetched

const DOCS: ReadonlyArray<readonly [host: string, path: string]> = [
  [APEX, '/'],
  [APEX, '/products'],
  [APEX, '/products?search=a1&category=printers'],
  [APEX, '/product/a1'],
  [APEX, '/product/a1?ref=sara'],
  [APEX, '/bundles/a1'],
  [APEX, '/p/a1'],
  [APEX, '/community/store/ali3d'],
  [APEX, '/community/store/ali3d/p/ali3d-bracket'],
  [APEX, '/sitemap.xml'],
  [APEX, '/robots.txt'],
  [APEX, '/manifest.webmanifest'],
  [APEX, '/store-icon/192.png'],
  [APEX, '/orders'],
  [STORE_HOST, '/'],
  [STORE_HOST, '/p/ali3d-bracket'],
  [STORE_HOST, '/p/a1'],
  [STORE_HOST, '/sitemap.xml'],
  [STORE_HOST, '/robots.txt'],
  [STORE_HOST, '/manifest.webmanifest'],
  [STORE_HOST, '/store-icon/512.png'],
];

interface Doc {
  status: number;
  type: string;
  text: string;
  headers: Record<string, string>;
}

async function fetchDoc(e: ReturnType<typeof env>, host: string, path: string, token: string | null): Promise<Doc> {
  const headers: Record<string, string> = { Host: host, 'CF-Connecting-IP': '9.9.9.9', 'Accept-Language': 'ar' };
  if (token) headers.Cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const res = await worker.fetch(new Request(`https://${host}${path}`, { headers }), e as never, ctx);
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => (out[k] = v));
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text(), headers: out };
}

const inlineResolve = (html: string): Record<string, unknown> | null => {
  const m = new RegExp(`<script type="application/json" id="${INLINE_RESOLVE_ID}">([\\s\\S]*?)</script>`).exec(html);
  return m ? (JSON.parse(m[1]) as Record<string, unknown>) : null;
};
const meta = (html: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) out[m[1]] = m[2];
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (title) out.title = title[1];
  return out;
};

const FINANCIAL_NAMES = [...new Set((FINANCIAL_FIELDS as readonly string[]).flatMap((k) => [k, k.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase())]))];
const NAME_RE = new RegExp(`(?<![A-Za-z0-9_])(${FINANCIAL_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z0-9_])`);

/** Everything private this answer carries, empty when clean. */
function scan(doc: Doc): string[] {
  const found: string[] = [];
  const headerText = Object.entries(doc.headers)
    .filter(([k]) => k !== 'etag')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  for (const [where, text] of [['body', doc.text], ['headers', headerText]] as const) {
    found.push(...leaks(text, EXTRA).map((l) => `${where} ${l}`));
    for (const run of text.match(/\d[\d,]{3,}/g) ?? []) {
      const n = Number(run.replace(/,/g, ''));
      if (INTEGER_TEXT.includes(n)) found.push(`${where} ⊃ "${run}"`);
    }
    for (const d of text.match(/\d+\.\d+/g) ?? []) if ((DECIMALS as readonly string[]).includes(d)) found.push(`${where} ⊃ "${d}"`);
    const name = NAME_RE.exec(text);
    if (name) found.push(`${where} names the private field ${name[1]}`);
  }
  if (/^text\/html/i.test(doc.type)) {
    const block = inlineResolve(doc.text);
    if (block) found.push(...leaks(block, EXTRA).map((l) => `lv-resolve ${l}`));
    found.push(...leaks(meta(doc.text), EXTRA).map((l) => `card ${l}`));
  }
  if (/json/i.test(doc.type)) {
    try {
      found.push(...leaks(JSON.parse(doc.text), EXTRA).map((l) => `json ${l}`));
    } catch {
      /* not JSON after all; the text scan above stands */
    }
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------- one run, shared by the assertions

interface Run {
  raw: DatabaseSync;
  docs: Record<string, Record<string, Doc>>; // caller → "host path" → answer
}
let run: Promise<Run> | null = null;
const all = () =>
  (run ??= (async () => {
    const raw = world();
    seedSessions(raw);
    const e = env(raw);
    const docs: Run['docs'] = {};
    for (const [caller, token] of Object.entries(CALLERS)) {
      docs[caller] = {};
      for (const [host, path] of DOCS) docs[caller][`${host} ${path}`] = await fetchDoc(e, host, path, token);
    }
    return { raw, docs };
  })());

// ---------------------------------------------------------------- positive controls

test('control: the private figures are in the database, so there is something to leak', async () => {
  const { raw } = await all();
  assert.equal(row<{ v: number }>(raw, "SELECT product_cost_iqd AS v FROM products WHERE id = 'p_a1'")?.v, COST.product);
  assert.equal(row<{ v: number }>(raw, "SELECT cost_iqd AS v FROM product_option_values WHERE id = 'v_a1'")?.v, COST.option);
  assert.equal(row<{ v: number }>(raw, "SELECT cost_iqd AS v FROM product_colors WHERE id = 'c_blk'")?.v, COST.color);
  assert.equal(row<{ v: number }>(raw, "SELECT unit_cost_iqd AS v FROM inventory_lots WHERE id = 'lot1'")?.v, COST.lotUnit);
  assert.equal(row<{ v: string }>(raw, "SELECT supplier_cost_amount AS v FROM pricing_inputs WHERE product_id = 'p_a1'")?.v, ENGINE.supplierUsd);
  assert.equal(row<{ v: number }>(raw, "SELECT additional_cost_iqd AS v FROM pricing_inputs WHERE product_id = 'p_a1'")?.v, ENGINE.extraCostIqd);
  assert.equal(row<{ v: string }>(raw, "SELECT amount_usd AS v FROM pricing_rules WHERE id = 'pr_tp_a1'")?.v, ENGINE.targetProfitUsd);
  assert.equal(row<{ v: string }>(raw, "SELECT market_rate AS v FROM fx_rate_pairs WHERE pair = 'USD_IQD'")?.v, '1666.6666');
});

test('control: the documents are the real rewritten ones, not the untouched shell', async () => {
  const d = (await all()).docs.guest;
  for (const path of ['/product/a1', '/bundles/a1', '/p/a1']) {
    const doc = d[`${APEX} ${path}`]!;
    assert.equal(doc.status, 200, path);
    const m = meta(doc.text);
    assert.equal(m['og:title'], 'بامبو A1', `${path}: the costly product's own card`);
    assert.equal(m['og:url'], `https://${APEX}${path}`, path);
    assert.ok(inlineResolve(doc.text), `${path}: carries the lv-resolve block`);
  }
  assert.match(d[`${APEX} /product/a1`]!.text, /assets\/Product-p1\.js/, 'the route chunk is preloaded');
  assert.match(d[`${APEX} /product/a1`]!.headers['cache-control'] ?? '', /public/, 'shared-cacheable, which is why it matters');
  for (const path of ['/', '/products', '/products?search=a1&category=printers']) {
    const block = inlineResolve(d[`${APEX} ${path}`]!.text);
    assert.equal(block?.kind, 'main', `${path}: the main-host block`);
  }
  assert.equal(meta(d[`${APEX} /community/store/ali3d`]!.text)['og:title'], 'Ali 3D');
  assert.equal(meta(d[`${APEX} /community/store/ali3d/p/ali3d-bracket`]!.text)['og:title'], 'حامل رف');
  const storeHome = d[`${STORE_HOST} /`]!;
  assert.equal(meta(storeHome.text)['og:title'], 'Ali 3D');
  assert.equal((inlineResolve(storeHome.text)?.store as { slug?: string } | null)?.slug, 'ali3d', 'the store host inlines the store answer');
  assert.equal(meta(d[`${STORE_HOST} /p/ali3d-bracket`]!.text)['og:title'], 'حامل رف');
  assert.match(d[`${APEX} /sitemap.xml`]!.text, /<loc>https:\/\/levonis-iq\.com\/product\/a1<\/loc>/, 'the apex sitemap lists the costly product');
  assert.match(d[`${STORE_HOST} /sitemap.xml`]!.text, /\/p\/ali3d-bracket<\/loc>/, 'the store sitemap lists its product');
  assert.match(d[`${APEX} /robots.txt`]!.text, /^Sitemap: /m);
  assert.match(d[`${STORE_HOST} /manifest.webmanifest`]!.text, /Ali 3D/, 'the store manifest names the store');
  assert.match(d[`${APEX} /manifest.webmanifest`]!.type, /manifest\+json|json/);
});

test('control: the scanner catches a private figure written the way a future card or block would write it', () => {
  const doc = (text: string, type = 'text/html; charset=utf-8'): Doc => ({ status: 200, type, text, headers: {} });
  const html = (head: string) => SHELL.replace('</head>', `${head}</head>`);
  assert.notDeepEqual(scan(doc(html(`<meta property="product:price:amount" content="${COST.product}" />`))), []);
  assert.notDeepEqual(scan(doc(html(`<meta name="description" content="التكلفة 611,111 د.ع" />`))), []);
  assert.notDeepEqual(scan(doc(html(`<script type="application/ld+json">{"@type":"Offer","price":"${ENGINE.supplierUsd}"}</script>`))), []);
  assert.notDeepEqual(
    scan(doc(html(`<script type="application/json" id="${INLINE_RESOLVE_ID}">{"success":true,"store":{"product_cost_iqd":1}}</script>`))),
    [],
    'a SELECT * row in the block'
  );
  assert.notDeepEqual(scan(doc(`<url><loc>https://x/p/a</loc><lastmod>2026</lastmod><priority>${ENGINE.extraCostIqd}</priority></url>`, 'application/xml')), []);
  assert.notDeepEqual(scan(doc(JSON.stringify({ name: 'x', fx_rate: 1 }), 'application/manifest+json')), []);
  assert.deepEqual(scan(doc(SHELL)), [], 'the bare shell is clean');
});

// ---------------------------------------------------------------- the sweep

for (const caller of ['guest', ...Object.keys(ROLES).filter((r) => r !== 'guest'), 'owner']) {
  test(`no document, share card, resolve block, sitemap, robots, manifest or icon answer to ${caller} carries a private value`, async () => {
    const docs = (await all()).docs[caller]!;
    assert.equal(Object.keys(docs).length, DOCS.length);
    const found: string[] = [];
    for (const [key, doc] of Object.entries(docs)) {
      assert.ok(doc.status < 500, `${key}: ${doc.status}`);
      for (const l of scan(doc)) found.push(`${key}: ${l}`);
    }
    assert.deepEqual(found, []);
  });
}

test('the documents do not depend on who asks: every role is served the guest\'s bytes', async () => {
  const { docs } = await all();
  for (const caller of Object.keys(docs)) {
    if (caller === 'guest') continue;
    for (const [key, doc] of Object.entries(docs[caller]!)) {
      if (key.endsWith(' /orders')) continue; // an SPA path that loads the session; its body is the untouched shell
      assert.equal(doc.text, docs.guest![key]!.text, `${caller} ${key}`);
    }
  }
});
