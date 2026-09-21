/**
 * WHAT A CRAWLER IS TOLD, AND ON WHICH HOST.
 *
 * The owner sent two PageSpeed reports and asked for the SEO problems fixed.
 * Three were structural and this file pins all three:
 *
 *   /robots.txt   fell through to the SPA shell — a crawler asking for robots
 *                 got an HTML document with a 200.
 *   /sitemap.xml  did not exist at all.
 *   description   `index.html` carried og:description and twitter:description
 *                 (what a CHAT CARD reads) and no `name="description"` (what a
 *                 SEARCH ENGINE reads), so Lighthouse reported «Document does
 *                 not have a meta description».
 *
 * THE CONSTRAINT THAT DECIDES THE SHAPE, and the thing these tests exist to
 * protect: ONE BUNDLE SERVES EVERY HOST. A static robots.txt would name the
 * platform's sitemap on a merchant's subdomain; a static sitemap would
 * advertise the whole catalogue as if it were every merchant's. Both are
 * therefore Worker routes that read the Host — the same answer
 * worker/routes/manifest.ts reached for the web manifest.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { APEX, asD1, ctx, freshDb } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import { classifyHost } from '../worker/lib/hosts';
import { robotsRoute, sitemapRoute } from '../worker/routes/seo';
import { injectSocialPreview } from '../worker/lib/socialPreview';

const ORIGIN = `https://${APEX}`;

function app(db: unknown, host: string) {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('host', classifyHost(host, APEX));
    c.env = { DB: db, APP_ORIGIN: ORIGIN, STORE_ROOT_DOMAIN: APEX } as never;
    await next();
  });
  a.get('/robots.txt', robotsRoute);
  a.get('/sitemap.xml', sitemapRoute);
  return a;
}

const fetchText = async (a: ReturnType<typeof app>, path: string, host: string) => {
  const res = await a.request(`https://${host}${path}`, { headers: { Host: host } }, undefined, ctx);
  return { res, body: await res.text() };
};

function seedProducts(raw: ReturnType<typeof freshDb>) {
  raw.exec(`
    INSERT INTO products (id,slug,name,description,price_iqd,status,updated_at)
      VALUES ('p1','bambu-a1','Bambu A1','',700000,'active','2026-09-01T10:00:00.000Z');
    INSERT INTO products (id,slug,name,description,price_iqd,status,updated_at)
      VALUES ('p2','pla-matte','PLA Matte','',21000,'active','2026-09-10T10:00:00.000Z');
    INSERT INTO products (id,slug,name,description,price_iqd,status,updated_at)
      VALUES ('p3','hidden','Hidden','',1000,'draft','2026-09-10T10:00:00.000Z');
  `);
}

// =========================================================================
// robots.txt
// =========================================================================

test('the apex serves a real robots.txt, not the app shell', async () => {
  const a = app(asD1(freshDb()), APEX);
  const { res, body } = await fetchText(a, '/robots.txt', APEX);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
  assert.doesNotMatch(body, /<html/i, 'a crawler must not be handed HTML here');
  assert.match(body, /^User-agent: \*/m);
  assert.match(body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
});

test('robots keeps crawlers off the surfaces that would only answer 401', () => {
  const a = app(asD1(freshDb()), APEX);
  return fetchText(a, '/robots.txt', APEX).then(({ body }) => {
    for (const path of ['/api/', '/admin', '/checkout', '/wallet', '/settings', '/orders']) {
      assert.match(body, new RegExp(`^Disallow: ${path.replace('/', '\\/')}`, 'm'), `${path} must be disallowed`);
    }
  });
});

/**
 * A preview URL or a workers.dev host serving an indexable copy of the whole
 * shop is how a staging site comes to outrank the real one.
 */
test('a host that is not a storefront is not indexed at all', async () => {
  for (const host of ['studio.levonis-iq.test', 'levonis-staging.workers.dev']) {
    const a = app(asD1(freshDb()), host);
    const { body } = await fetchText(a, '/robots.txt', host);
    assert.match(body, /^Disallow: \/$/m, `${host} must refuse the whole tree`);
    assert.doesNotMatch(body, /Sitemap:/, `${host} must not advertise a sitemap`);
  }
});

// =========================================================================
// sitemap.xml
// =========================================================================

test('the sitemap lists the shop and its ACTIVE products, newest first', async () => {
  const raw = freshDb();
  seedProducts(raw);
  const a = app(asD1(raw), APEX);
  const { res, body } = await fetchText(a, '/sitemap.xml', APEX);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/xml/);
  assert.match(body, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(body, new RegExp(`<loc>${ORIGIN}/</loc>`));
  assert.match(body, new RegExp(`<loc>${ORIGIN}/product/pla-matte</loc>`));
  assert.match(body, new RegExp(`<loc>${ORIGIN}/product/bambu-a1</loc>`));
  assert.doesNotMatch(body, /hidden/, 'a draft product must never be advertised to a crawler');
  // A lastmod the row actually carries, in the date form the protocol wants.
  assert.match(body, /<lastmod>2026-09-10<\/lastmod>/);
});

/**
 * THE CROSS-SITE SITEMAP TRAP. `worker/lib/appOrigin.ts` answers the APEX for
 * a merchant host whenever APP_ORIGIN is set — correct for a token-bearing
 * link, and fatal here: the sitemap protocol requires every <loc> to share the
 * host the file was fetched from, and Google ignores every entry otherwise.
 */
test('a merchant subdomain names ITSELF, never the platform', async () => {
  const raw = freshDb();
  seedProducts(raw);
  const merchant = `ali3d.${APEX}`;
  const a = app(asD1(raw), merchant);

  const { body } = await fetchText(a, '/sitemap.xml', merchant);
  assert.match(body, new RegExp(`<loc>https://${merchant}/product/pla-matte</loc>`));
  assert.doesNotMatch(
    body,
    new RegExp(`<loc>${ORIGIN}/`),
    'listing the apex here makes it a cross-site sitemap and Google drops the lot'
  );

  const robots = await fetchText(a, '/robots.txt', merchant);
  assert.match(robots.body, new RegExp(`^Sitemap: https://${merchant}/sitemap\\.xml$`, 'm'));
});

/**
 * A sitemap that 500s is a Search Console error the owner has to go and
 * dismiss. Losing the products is survivable; losing the document is not.
 */
test('a database failure costs the products, never the document', async () => {
  const exploding = {
    prepare() {
      throw new Error('D1_ERROR: connection lost');
    },
  };
  const a = app(exploding, APEX);
  const { res, body } = await fetchText(a, '/sitemap.xml', APEX);
  assert.equal(res.status, 200, 'a 5xx here backs Google off the whole site');
  assert.match(body, new RegExp(`<loc>${ORIGIN}/</loc>`), 'the shop itself is still listed');
});

// =========================================================================
// the meta description
// =========================================================================

test('the shipped shell carries a meta description for a search engine', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /<meta\s+name="description"/,
    'Lighthouse reports «Document does not have a meta description» without it'
  );
  // og:description is a DIFFERENT tag read by a different consumer. Having one
  // never satisfied the other, which is how this went unnoticed.
  assert.match(html, /property="og:description"/, 'and the chat card keeps its own');
});

test('a product page overwrites the search description, not only the chat card', () => {
  const html = '<html><head><title>LEVONIS</title>\n  <meta name="description" content="shop" />\n</head></html>';
  const out = injectSocialPreview(html, {
    title: 'Bambu A1',
    description: 'A fast CoreXY printer.',
    image: '',
    url: 'https://levonis-iq.com/product/bambu-a1',
  });
  assert.match(out, /<meta name="description" content="A fast CoreXY printer\." \/>/);
  assert.match(out, /<meta property="og:description" content="A fast CoreXY printer\." \/>/);
  assert.doesNotMatch(out, /content="shop"/, 'the shop default must be replaced, not kept beside it');
});

test('a product with no description keeps the shop line rather than inventing one', () => {
  const html = '<html><head><title>LEVONIS</title>\n  <meta name="description" content="shop" />\n</head></html>';
  const out = injectSocialPreview(html, { title: 'X', description: '', image: '', url: 'https://x/y' });
  assert.match(out, /content="shop"/);
});
