/**
 * LEAK AUDIT — customer-api: the SUPPLIER SOURCE URL of every product picture
 * (`media[].source_url`) reaches anonymous visitors and every signed-in
 * non-owner role through the storefront JSON.
 *
 * `source_url` is where a picture was fetched FROM — the supplier listing or
 * CDN link the owner pasted into «fetch by URL» (worker/lib/productMediaIngest.ts
 * stores it; worker/lib/productModel.ts: "it records where a picture came
 * FROM. It is never what the page loads"). The code itself treats it as
 * private: the public API v1 says the storefront payload "still carries …
 * supplier source URLs … a visitor never sees on the page" and rebuilds its
 * answer field by field to drop them (worker/lib/publicApi/resources/products.ts),
 * and tests/publicApi.test.ts forbids the key `source_url` and the marker
 * `supplier-secret.example`. The storefront client never reads it
 * (src/ has no storefront reader of `media[].source_url`), so nothing the
 * page shows needs it.
 *
 * The owner's rule: anyone other than the main admin / super admin gets ONLY
 * the final price; supplier identity is private. These tests seed a supplier
 * link on a product picture — both ways the catalogue stores one (the
 * `products.images` JSON and a relational `product_images` row) — and look
 * for it in what the storefront answers:
 *
 *   1. the REAL worker (worker/index.ts `fetch`), signed out: GET
 *      /api/products/:slug, /api/products, /api/home, /api/home/sections,
 *      /api/catalog/:slug, /api/printer-finder — and, as the control,
 *      /api/public/v1/products/:slug, which must (and does) drop it;
 *   2. every non-owner role of tests/fixtures/roleMatrix.ts (guest, customer,
 *      merchant, every non-owner admin scope, employee, investor, support) on
 *      the role-matrix database, through the same mounts the matrix uses;
 *   3. the guard gap: the shared leak scanner (tests/fixtures/costlyProduct.ts
 *      `leaks`) does not recognise a supplier source URL at all, and the role
 *      matrix's costly product carries no picture, so no existing guard can
 *      see this.
 *
 * LOCAL ONLY: in-memory / temp-file SQLite with every migration, the real
 * route modules, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_customer-api_product_media_supplier_source_url.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, freshDb } from './fixtures/app';
import { seedLiveCatalog, P } from './fixtures/liveCatalog';
import { leaks } from './fixtures/costlyProduct';
import { ROLES, appFor, call, seededCopy, type RoleName } from './fixtures/roleMatrix';
import worker from '../worker/index';

/** Three distinct supplier links, one per way a picture is stored. */
const SUPPLIER_JSON = 'https://supplier-secret-json.example/listing/x2d/original.jpg';
const SUPPLIER_REL = 'https://supplier-secret-rel.example/cdn/h2d/main.png';
const SUPPLIER_ROLE = 'https://supplier-secret-role.example/item/a1.jpg';
/** Any of them, in any field, at any depth, in the raw bytes of the answer. */
const SUPPLIER_MARK = /supplier-secret-(json|rel|role)\.example/;

const KEY_X2D = `products/${P.X2D}/gallery/${'a1'.repeat(32)}.webp`;
const KEY_H2D = `products/${P.H2D}/gallery/${'b2'.repeat(32)}.webp`;
const KEY_A1 = `products/p_a1/gallery/${'c3'.repeat(32)}.webp`;

/** Every place the answer carries a supplier link: a non-empty `source_url` key, or the marker anywhere. */
function supplierLeaks(body: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'source_url' && typeof x === 'string' && x.trim() !== '') out.push(`${path}.${k} = ${x}`);
        else walk(x, `${path}.${k}`);
      }
    } else if (typeof v === 'string' && SUPPLIER_MARK.test(v)) out.push(`${path} ⊃ ${v.slice(0, 80)}`);
  };
  walk(body, '$');
  return out;
}

// ------------------------------------------------------------------ world 1: the real worker, signed out

function liveWorld() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  // (a) the products.images JSON — exactly the shape tests/publicApi.test.ts seeds.
  raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(
    JSON.stringify([
      {
        id: 'img_x2d',
        url: `/files/${KEY_X2D}`,
        key: KEY_X2D,
        role: 'gallery',
        alt_ar: 'صورة',
        alt_en: 'Picture',
        alt_ckb: 'وێنە',
        order: 0,
        primary: true,
        width: 1600,
        height: 1600,
        source_url: SUPPLIER_JSON,
        option_value_id: '',
        color_id: '',
        variant_id: '',
      },
    ]),
    P.X2D
  );
  // (b) a relational product_images row — what «fetch by URL» writes today.
  raw
    .prepare(
      `INSERT INTO product_images (id, product_id, url, r2_key, source_url, content_type, sort_order, is_primary,
                                   width, height, bytes, alt_en, quarantined, quarantine_reason)
       VALUES ('img_h2d', ?, ?, ?, ?, 'image/webp', 0, 1, 1600, 1600, 12345, 'Picture', 0, '')`
    )
    .run(P.H2D, `/files/${KEY_H2D}`, KEY_H2D, SUPPLIER_REL);

  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  const fetchAnon = (path: string) =>
    worker.fetch(
      new Request(`https://${APEX}${path}`, { headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.9' } }),
      env as never,
      ctx
    );
  return { raw, fetchAnon };
}

/** Storefront routes a signed-out visitor reaches; `shows` = an owned picture key that proves the media was served. */
const ANON_ROUTES: Array<{ path: string; shows: string[] }> = [
  { path: '/api/products/bambu-lab-x2d', shows: [KEY_X2D] },
  { path: '/api/products/bambu-lab-h2d', shows: [KEY_H2D] },
  { path: '/api/products?limit=50', shows: [KEY_X2D, KEY_H2D] },
  { path: '/api/home', shows: [KEY_X2D, KEY_H2D] },
  { path: '/api/home/sections', shows: [] },
  { path: '/api/catalog/printers', shows: [] },
  { path: '/api/printer-finder', shows: [] },
];

test('control: the public API v1 drops the supplier link (the seeded value is private by the code’s own rule)', async () => {
  const { fetchAnon } = liveWorld();
  for (const slug of ['bambu-lab-x2d', 'bambu-lab-h2d']) {
    const res = await fetchAnon(`/api/public/v1/products/${slug}`);
    const text = await res.text();
    assert.equal(res.status, 200, `${slug} → ${res.status}: ${text.slice(0, 300)}`);
    // The picture really is there — so the supplier link was reachable and was removed.
    assert.ok(text.includes(slug === 'bambu-lab-x2d' ? KEY_X2D : KEY_H2D), `v1 ${slug} did not serve the seeded picture: ${text.slice(0, 400)}`);
    assert.doesNotMatch(text, SUPPLIER_MARK, `v1 ${slug} carries the supplier link`);
  }
});

test('anonymous storefront JSON (real worker) carries no supplier source URL of any product picture', async () => {
  const { fetchAnon } = liveWorld();
  const found: string[] = [];
  let served = 0;
  for (const { path, shows } of ANON_ROUTES) {
    const res = await fetchAnon(path);
    const text = await res.text();
    if (res.status !== 200) {
      // Only the optional sweep routes may be absent in a fixture; the three named ones must answer.
      assert.ok(shows.length === 0, `${path} → ${res.status}: ${text.slice(0, 300)}`);
      continue;
    }
    // The route really served the seeded pictures — otherwise this test proves nothing.
    for (const key of shows) assert.ok(text.includes(key), `${path} did not serve the seeded picture ${key}`);
    served += 1;
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* scanned as text */
    }
    const hits = supplierLeaks(body);
    if (hits.length) {
      found.push(
        `anonymous GET ${path} (Cache-Control: ${res.headers.get('Cache-Control') ?? '—'}) → ${hits.length} hit(s): ${hits
          .slice(0, 3)
          .join('; ')}`
      );
    }
  }
  assert.ok(served >= 4, `only ${served} storefront routes answered 200`);
  assert.deepEqual(found, [], `the storefront publishes the SUPPLIER source URL of product pictures:\n  ${found.join('\n  ')}`);
});

// ------------------------------------------------------------------ world 2: every non-owner role

function roleWorld(): DatabaseSync {
  const raw = seededCopy();
  raw
    .prepare(
      `INSERT INTO product_images (id, product_id, url, r2_key, source_url, content_type, sort_order, is_primary,
                                   width, height, bytes, alt_en, quarantined, quarantine_reason)
       VALUES ('img_a1', 'p_a1', ?, ?, ?, 'image/webp', 0, 1, 1200, 1200, 4321, 'A1', 0, '')`
    )
    .run(`/files/${KEY_A1}`, KEY_A1, SUPPLIER_ROLE);
  return raw;
}

const NON_OWNER: RoleName[] = Object.keys(ROLES) as RoleName[];
const ROLE_PATHS = ['/api/products/a1', '/api/products?limit=50', '/api/home'];

test('no non-owner role (tests/fixtures/roleMatrix.ts ROLES) receives a picture’s supplier source URL', async () => {
  const raw = roleWorld();
  const found: string[] = [];
  for (const role of NON_OWNER) {
    const app = appFor(raw, ROLES[role]);
    for (const path of ROLE_PATHS) {
      const res = await call(app, 'GET', path);
      assert.equal(res.status, 200, `${role} GET ${path} → ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
      assert.ok(JSON.stringify(res.body).includes(KEY_A1), `${role} GET ${path} did not serve the seeded picture`);
      const hits = supplierLeaks(res.body);
      if (hits.length) found.push(`${role} GET ${path} → ${hits[0]}`);
    }
  }
  assert.deepEqual(found, [], `non-owner roles receive the SUPPLIER source URL:\n  ${found.join('\n  ')}`);
});

// ------------------------------------------------------------------ 3: the guard gap

test('guard gap: the shared leak scanner recognises a supplier source URL', () => {
  const payload = { product: { media: [{ url: `/files/${KEY_A1}`, source_url: SUPPLIER_ROLE }] } };
  // The walk the role matrix and every cost suite run over every answer.
  const seen = leaks(payload);
  assert.ok(
    seen.length > 0,
    'tests/fixtures/costlyProduct.ts leaks() reports nothing for media[].source_url (not in FINANCIAL_FIELDS, not a cost key, ' +
      'not a numeric sentinel) and the role matrix’s costly product has no picture — no existing guard can catch this leak'
  );
});
