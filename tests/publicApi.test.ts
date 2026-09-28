/**
 * THE PUBLIC READ-ONLY API — `/api/public/v1/*` (worker/routes/publicApi.ts).
 *
 * The owner's rule: «Public API يستطيع إرجاع فقط البيانات التي يستطيع الزائر
 * غير المسجل رؤيتها بالفعل … يُمنع تمامًا كشف cost prices, profits,
 * suppliers, internal notes, customer information, orders, private inventory
 * information, admin data, sessions, tokens, secrets, private IDs». Every test
 * here drives the REAL worker (worker/index.ts `fetch`), so the session
 * skip-list, the host guard, CORS and the error envelope are the production
 * ones.
 *
 *   NOTHING PRIVATE LEAVES. The database is seeded with a secret marker in
 *     every private place — cost prices, SKUs, supplier links on pictures, a
 *     customer's e-mail and phone, a password hash, a session, an order, bank
 *     details in the settings, drafts, hidden products, a pending review — and
 *     every endpoint is crawled; no marker, no internal id and no forbidden
 *     key may appear in any answer.
 *   THE SCHEMA IS THE ALLOWLIST. Every answer is validated against the schema
 *     /openapi.json publishes for it, with no extra property allowed.
 *   ANONYMOUS. An admin's session cookie changes nothing — no session is even
 *     read — and prices are the visitor's.
 *   READ-ONLY. Every other method is a 405 and nothing in the database moves.
 *   A GOOD CITIZEN. CORS for any origin, HEAD, ETag/304, a 429 with
 *     Retry-After, pagination that visits every item exactly once, the main
 *     host only, robots.txt allowing it.
 *
 * Run: node --import tsx --test tests/publicApi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, MERCHANT_HOST, asD1, ctx, freshDb, pending } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { validate } from './fixtures/jsonSchema';
import worker from '../worker/index';
import { sha256Hex } from '../worker/lib/crypto';
import { ALL_ROUTES } from '../worker/lib/publicApi/meta';
import type { PublicRoute } from '../worker/lib/publicApi/types';

const ORIGIN = `https://${APEX}`;
const IP = '203.0.113.7';
const ADMIN_TOKEN = 'public-api-admin-session-token-7Q';

/** A marker in every private place; none may appear in any public answer. */
const SECRETS = [
  '987654321', // product_cost_iqd
  'SKU-SECRET-7Q',
  'supplier-secret.example',
  'leak-check@example.com',
  '+9647700000099',
  'HASH-SECRET-7Q',
  'Leaky Customer',
  'IBAN-SECRET-7Q',
  'DRAFT-SECRET-NAME',
  'HIDDEN-SECRET-NAME',
  'PENDING-REVIEW-SECRET',
  'MODERATION-SECRET-7Q',
  'SECRET-SECTION',
  'SUPPLIER-SECRET-7Q',
  'ADMIN-NOTE-SECRET-7Q',
  ADMIN_TOKEN,
  // The community: a shop, its owner, its products, reviews, and the request board.
  'owner-secret@example.com',
  'Owner Person',
  '+9647800000077', // the shop's contact phone — published on its page, never through the API
  'MERCHANT-PHONE-SECRET',
  'MERCHANT-GOV-SECRET',
  'SANCTION-REASON-SECRET',
  'PICKUP-NOTE-SECRET',
  'CP-SKU-SECRET-7Q',
  'CP-DRAFT-SECRET',
  'CP-HIDDEN-SECRET',
  'tracker.example', // an off-platform picture a legacy listing carried
  'HIDDEN-STORE-REVIEW-SECRET',
  'SUSPENDED-SHOP-SECRET',
  'SUSPENDED-PRODUCT-SECRET',
  'REQUEST-NOTES-SECRET',
  'CUSTOMER-NOTES-SECRET',
  'PRIVATE-REQUEST-SECRET',
  'DRAFT-REQUEST-SECRET',
  'reviews/usr_leak7q', // a review photo's key names its author
  'VARIANT-SKU-SECRET',
  'INACTIVE-VARIANT-SECRET',
];

/** Keys no public answer may carry, at any depth. */
const FORBIDDEN_KEY =
  /^(id|.*_id|.*cost.*|.*profit.*|.*supplier.*|sku|sku_part|source_url|stock|stock_reserved|reserved|low_stock_threshold|capacity|email|phone.*|password.*|token|session.*|.*_note|moderation.*|admin.*|merged_into|group_en|.*_adjust_iqd|pro_price_iqd|prime_price_iqd|rule_id|.*_key|r2_key)$/i;

/**
 * Internal database ids (prd_…, cat_…, usr_…, str_…, cp_…); slugs are the
 * public identifiers. A print request's reference (req_…) is public — it is
 * in the request's web address — and is not in this list.
 */
const INTERNAL_ID = /\b(prd|cat|brd|usr|ord|mer|mch|cm|cp|str|svc|shw|mrv|sec|og|ov|pv|rev|ses)_[A-Za-z0-9]{2,}/;

/**
 * A merchant's picture is the site's own public file, `/files/merchants/<owner
 * account id>/public/…` — the one place an account id is part of a public
 * answer, exactly as on the shop's own pages. Masked before the id scan; the
 * owner here is a merchant, never a customer.
 */
const MERCHANT_FILE = /\/files\/merchants\/usr_owner7q\/(public|logos|covers)\//g;

const GALLERY_KEY = 'products/p1/gallery/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0.webp';

async function world(opts: { communityOpen?: boolean } = {}) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const first = raw.prepare("SELECT id, slug FROM products WHERE status = 'active' AND composition = '' ORDER BY id LIMIT 1").get() as {
    id: string;
    slug: string;
  };
  // Internal columns, everywhere.
  raw.exec(`UPDATE products SET product_cost_iqd = 987654321, sku = 'SKU-SECRET-7Q-' || id, stock_reserved = 1, low_stock_threshold = 3`);
  // One product with a real gallery whose picture carries a supplier link.
  raw.prepare('UPDATE products SET images = ?, description = ?, name_ar = ? WHERE id = ?').run(
    JSON.stringify([
      {
        id: 'img1',
        url: `/files/${GALLERY_KEY}`,
        key: GALLERY_KEY,
        role: 'gallery',
        alt_ar: 'صورة',
        alt_en: 'Picture',
        alt_ckb: '',
        order: 0,
        primary: true,
        width: 1600,
        height: 1600,
        source_url: 'https://supplier-secret.example/original.jpg',
        option_value_id: '',
        color_id: '',
        variant_id: '',
      },
    ]),
    'A public description.',
    'منتج عام',
    first.id
  );
  // What a visitor must never see.
  raw.exec(`INSERT INTO products (id, slug, name, description, price_iqd, status, category_id)
            VALUES ('prd_draft7q', 'draft-secret-product', 'DRAFT-SECRET-NAME', '', 1000, 'draft', 'cat_printers'),
                   ('prd_hidden7q', 'hidden-secret-product', 'HIDDEN-SECRET-NAME', '', 1000, 'hidden', 'cat_printers')`);
  raw.exec(`INSERT INTO catalogs (id, slug, name_ar, name_en, name_ckb, active) VALUES ('cat_secret7q', 'secret-section', 'SECRET-SECTION', 'SECRET-SECTION', '', 0)`);
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, username, phone_e164)
            VALUES ('usr_leak7q', 'Leaky Customer', 'leak-check@example.com', 'HASH-SECRET-7Q', 'customer', 'leaky', '+9647700000099'),
                   ('usr_other7q', 'Other Buyer', 'other@x.co', 'HASH-SECRET-7Q', 'customer', 'other', NULL),
                   ('usr_boss7q', 'Boss', 'boss@x.co', 'HASH-SECRET-7Q', 'admin', 'boss', NULL)`);
  raw.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(
    await sha256Hex(ADMIN_TOKEN),
    'usr_boss7q',
    new Date(Date.now() + 86_400_000).toISOString()
  );
  raw.prepare(
    `INSERT INTO reviews (id, user_id, product_id, stars, body, status, moderation_note, created_at, source)
     VALUES ('rev_pub7q', 'usr_leak7q', ?, 4, 'Great nozzle.', 'published', 'MODERATION-SECRET-7Q', '2026-09-01T10:00:00.000Z', 'user'),
            ('rev_pen7q', 'usr_other7q', ?, 1, 'PENDING-REVIEW-SECRET', 'pending', '', '2026-09-02T10:00:00.000Z', 'user')`
  ).run(first.id, first.id);
  raw.prepare(`INSERT INTO admin_settings (key, value) VALUES ('paymentMethods', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify([{ id: 'zain', name: 'Zain Cash', details: 'IBAN-SECRET-7Q' }])
  );
  raw.exec(`INSERT INTO inventory_suppliers (id, name, notes) VALUES ('sup_7q', 'SUPPLIER-SECRET-7Q', 'ADMIN-NOTE-SECRET-7Q')`);

  // LEVO COMMUNITY: a shop (public on its own address), one a moderator
  // suspended, their products, reviews, services and work, and the board.
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
  raw.exec(`INSERT INTO users (id, name, email, password_hash, role, username, phone_e164)
            VALUES ('usr_owner7q', 'Owner Person', 'owner-secret@example.com', 'HASH-SECRET-7Q', 'customer', 'ownerp', NULL),
                   ('usr_ban7q', 'Banned Owner', 'ban@x.co', 'HASH-SECRET-7Q', 'customer', 'banned', NULL)`);
  raw.exec(`INSERT INTO community_merchants (id, user_id, name, bio, governorate, phone, status, status_reason, verified, badge, rating_avg_x100, rating_count, completed_orders, created_at)
            VALUES ('mch_ali7q', 'usr_owner7q', 'Ali Prints', 'Honest prints', 'MERCHANT-GOV-SECRET', 'MERCHANT-PHONE-SECRET', 'active', '', 1, 'trusted', 450, 2, 7, '2026-08-01T00:00:00.000Z'),
                   ('mch_ban7q', 'usr_ban7q', 'SUSPENDED-SHOP-SECRET', '', '', '', 'suspended', 'SANCTION-REASON-SECRET', 0, 'new', 0, 0, 0, '2026-08-02T00:00:00.000Z')`);
  raw.prepare(
    `INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name, tagline, description, logo_key, banner_key, governorate,
                                 categories, service_areas, contact_phone, contact_phone_public, business_hours, policies, social_links,
                                 accepts_custom_requests, sells_direct_products, status, created_at)
     VALUES ('str_ali7q', 'mch_ali7q', 'usr_owner7q', 'ali3d', 'Ali 3D', 'Prints that last', 'We print.', ?, ?, 'baghdad',
             '["figures"]', '["Karrada"]', '+9647800000077', 1, '[{"day":"Sat","open":"09:00","close":"18:00"},{"day":"Fri","open":"","close":"","closed":true}]',
             '{"returns":"Seven days."}', '{"instagram":"https://instagram.com/ali3d","bad":"javascript:alert(1)"}',
             1, 1, 'active', '2026-08-01T00:00:00.000Z')`
  ).run('merchants/usr_owner7q/logos/logo.webp', 'merchants/usr_owner7q/covers/banner.webp');
  raw.exec(`INSERT INTO merchant_stores (id, merchant_id, user_id, slug, name, status, created_at)
            VALUES ('str_ban7q', 'mch_ban7q', 'usr_ban7q', 'banned-shop', 'SUSPENDED-SHOP-SECRET', 'active', '2026-08-02T00:00:00.000Z')`);
  raw.exec(`INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('ali3d', 'str_ali7q', 1), ('banned-shop', 'str_ban7q', 1)`);
  raw.exec(`INSERT INTO merchant_delivery_profiles (store_id, default_mode, default_fee_iqd, pickup_enabled, pickup_governorate, pickup_note, prep_days, note)
            VALUES ('str_ali7q', 'fee', 5000, 1, 'baghdad', 'PICKUP-NOTE-SECRET', 2, 'Packed with care.')`);
  // `status` is not written directly: migration 0126's triggers derive it from
  // the lifecycle and an admin's hide, as every real write does.
  const cp = raw.prepare(
    `INSERT INTO community_products (id, merchant_id, store_id, slug, name, name_ar, description, images, price_iqd, original_price_iqd,
                                     sku, stock, track_stock, sold_count, category, lifecycle, admin_hidden_at, admin_hidden_reason, created_at)
     VALUES (?, ?, ?, ?, ?, '', 'A dragon.', ?, 25000, 30000, 'CP-SKU-SECRET-7Q', 5, 1, 57, 'figures', ?, ?, ?, ?)`
  );
  const dragonImages = JSON.stringify(['/files/merchants/usr_owner7q/public/dragon.webp', 'https://tracker.example/pixel.gif']);
  cp.run('cp_dragon7q', 'mch_ali7q', 'str_ali7q', 'ali3d-dragon', 'Dragon', dragonImages, 'active', null, '', '2026-08-03T00:00:00.000Z');
  cp.run('cp_draft7q', 'mch_ali7q', 'str_ali7q', 'ali3d-draft', 'CP-DRAFT-SECRET', '[]', 'draft', null, '', '2026-08-04T00:00:00.000Z');
  cp.run('cp_hidden7q', 'mch_ali7q', 'str_ali7q', 'ali3d-hidden', 'CP-HIDDEN-SECRET', '[]', 'hidden', null, '', '2026-08-05T00:00:00.000Z');
  cp.run('cp_mod7q', 'mch_ali7q', 'str_ali7q', 'ali3d-moderated', 'CP-HIDDEN-SECRET', '[]', 'active', '2026-08-05T00:00:00.000Z', 'MODERATION-SECRET-7Q', '2026-08-05T01:00:00.000Z');
  cp.run('cp_ban7q', 'mch_ban7q', 'str_ban7q', 'banned-thing', 'SUSPENDED-PRODUCT-SECRET', '[]', 'active', null, '', '2026-08-06T00:00:00.000Z');
  // A product sold in sizes: two live variants (one sold out), one switched off.
  cp.run('cp_vase7q', 'mch_ali7q', 'str_ali7q', 'ali3d-vase', 'Vase', '[]', 'active', null, '', '2026-08-02T00:00:00.000Z');
  raw.exec(`UPDATE community_products SET variant_mode = 'variants', material = 'pla', print_technology = 'fdm', color = 'white',
                   dim_x_mm = 100, dim_y_mm = 100, dim_z_mm = 250, weight_g = 180 WHERE id = 'cp_vase7q'`);
  raw.exec(`INSERT INTO community_product_options (id, product_id, store_id, name, name_ar, kind, position)
            VALUES ('og_size7q', 'cp_vase7q', 'str_ali7q', 'Size', 'الحجم', 'choice', 0)`);
  raw.exec(`INSERT INTO community_product_option_values (id, option_id, product_id, name, name_ar, position)
            VALUES ('ov_s7q', 'og_size7q', 'cp_vase7q', 'Small', 'صغير', 0),
                   ('ov_l7q', 'og_size7q', 'cp_vase7q', 'Large', 'كبير', 1),
                   ('ov_x7q', 'og_size7q', 'cp_vase7q', 'INACTIVE-VARIANT-SECRET', '', 2)`);
  raw.exec(`INSERT INTO community_product_variants (id, product_id, store_id, value1_id, price_iqd, compare_at_iqd, stock, sku, active, position)
            VALUES ('pv_s7q', 'cp_vase7q', 'str_ali7q', 'ov_s7q', 15000, NULL, 3, 'VARIANT-SKU-SECRET', 1, 0),
                   ('pv_l7q', 'cp_vase7q', 'str_ali7q', 'ov_l7q', 22000, 26000, 0, 'VARIANT-SKU-SECRET', 1, 1),
                   ('pv_x7q', 'cp_vase7q', 'str_ali7q', 'ov_x7q', 1, NULL, 9, 'VARIANT-SKU-SECRET', 0, 2)`);
  raw.exec(`INSERT INTO merchant_reviews (id, merchant_id, store_id, customer_id, order_id, rating, body, images, merchant_reply, hidden, created_at)
            VALUES ('mrv_pub7q', 'mch_ali7q', 'str_ali7q', 'usr_leak7q', 'sord_a7q', 5, 'Lovely print.', '["/files/reviews/usr_leak7q/photo.webp"]', 'Thank you!', 0, '2026-08-10T00:00:00.000Z'),
                   ('mrv_hid7q', 'mch_ali7q', 'str_ali7q', 'usr_other7q', 'sord_b7q', 1, 'HIDDEN-STORE-REVIEW-SECRET', '[]', '', 1, '2026-08-11T00:00:00.000Z')`);
  raw.exec(`INSERT INTO merchant_services (id, store_id, merchant_id, title, description, kind, price_from_iqd, price_unit, materials, image_key)
            VALUES ('svc_7q', 'str_ali7q', 'mch_ali7q', 'Custom prints', 'Send a model.', 'print_service', 5000, 'per piece', '["PLA","PETG"]', 'merchants/usr_owner7q/public/service.webp')`);
  raw.exec(`INSERT INTO merchant_showcase (id, store_id, kind, title, details, image_key, created_at)
            VALUES ('shw_7q', 'str_ali7q', 'work', 'A finished dragon', 'Painted by hand.', 'merchants/usr_owner7q/public/work.webp', '2026-08-12T00:00:00.000Z'),
                   ('shw_ban7q', 'str_ban7q', 'work', 'SUSPENDED-SHOP-SECRET', '', 'merchants/usr_ban7q/public/work.webp', '2026-08-13T00:00:00.000Z')`);
  const req = raw.prepare(
    `INSERT INTO community_requests (id, customer_id, title, description, status, state, visibility, category, quantity, material,
                                     governorate, budget_iqd, notes, customer_notes, expires_at, created_at)
     VALUES (?, 'usr_leak7q', ?, 'A tall vase.', 'open', ?, ?, 'decor', 2, 'PLA', 'baghdad', 40000, 'REQUEST-NOTES-SECRET', 'CUSTOMER-NOTES-SECRET', ?, ?)`
  );
  req.run('req_vase7q', 'Print me a vase', 'open', 'public', soon, '2026-08-20T00:00:00.000Z');
  req.run('req_private7q', 'PRIVATE-REQUEST-SECRET', 'open', 'private', soon, '2026-08-21T00:00:00.000Z');
  req.run('req_draft7q', 'DRAFT-REQUEST-SECRET', 'draft', 'public', soon, '2026-08-22T00:00:00.000Z');
  req.run('req_old7q', 'Expired request', 'open', 'public', '2020-01-01T00:00:00.000Z', '2019-12-01T00:00:00.000Z');
  if (opts.communityOpen) {
    raw.prepare(`INSERT INTO admin_settings (key, value) VALUES ('communityGate', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      JSON.stringify({ open: true, allowed_user_ids: [] })
    );
  }

  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: ORIGIN,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response('spa') },
  };
  const call = (path: string, init: { method?: string; headers?: Record<string, string>; host?: string } = {}) => {
    const host = init.host ?? APEX;
    return worker.fetch(
      new Request(`https://${host}${path}`, {
        method: init.method ?? 'GET',
        headers: { Host: host, 'CF-Connecting-IP': IP, ...(init.headers ?? {}) },
      }),
      env as never,
      ctx
    );
  };
  return { raw, env, call, first };
}

/** Every GET the API has, with real values for its path parameters. */
function concrete(route: PublicRoute, first: { slug: string }): string[] {
  const base = `/api/public/v1${route.path === '/' ? '' : route.path}`;
  if (!route.path.includes('{')) {
    const extra = route.example && route.example.includes('?') && !route.example.includes('{') ? `/api/public/v1${route.example}` : null;
    const needsQuery = (route.params ?? []).some((p) => p.in === 'query' && p.required);
    if (needsQuery) return [extra ?? base];
    return extra ? [base, extra] : [base];
  }
  if (route.path.startsWith('/products/')) return [base.replace('{slug}', first.slug)];
  if (route.path === '/sections/{slug}') return [base.replace('{slug}', 'printers')];
  if (route.path === '/brands/{slug}') return [base.replace('{slug}', 'snapmaker')];
  if (route.path === '/policies/{key}') return [base.replace('{key}', 'returns'), base.replace('{key}', 'privacy')];
  if (route.path.startsWith('/stores/{slug}')) return [base.replace('{slug}', 'ali3d').replace('{product}', 'ali3d-dragon')];
  if (route.path === '/community/requests/{reference}') return [base.replace('{reference}', 'req_vase7q')];
  return [];
}

function scanKeys(value: unknown, path: string, out: string[]) {
  if (Array.isArray(value)) value.forEach((v, i) => scanKeys(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(`${path}.${k}`);
      scanKeys(v, `${path}.${k}`, out);
    }
  }
}

// =========================================================================
// NOTHING PRIVATE LEAVES
// =========================================================================

test('every endpoint answers, and no answer carries a secret, an internal id or a forbidden key', async () => {
  // The community open, so its lists are crawled too.
  const { call, first } = await world({ communityOpen: true });
  const openapi = (await (await call('/api/public/v1/openapi.json')).json()) as { paths: Record<string, unknown> };
  let crawled = 0;
  for (const route of ALL_ROUTES) {
    for (const path of concrete(route, first)) {
      const res = await call(path);
      assert.equal(res.status, 200, `${path} → ${res.status}: ${await res.clone().text()}`);
      const text = await res.text();
      crawled++;
      for (const s of SECRETS) assert.ok(!text.includes(s), `${path} leaks «${s}»`);
      // The OpenAPI document and /context describe fields by name; only data is scanned for keys and ids.
      if (route.path === '/openapi.json') continue;
      const m = INTERNAL_ID.exec(text.replace(MERCHANT_FILE, '/files/merchants/<owner>/$1/'));
      assert.equal(m, null, `${path} carries an internal id: ${m?.[0]}`);
      if (route.path === '/context') continue;
      const bad: string[] = [];
      scanKeys(JSON.parse(text), '$', bad);
      assert.deepEqual(bad, [], `${path} carries forbidden keys`);
    }
  }
  assert.ok(crawled >= Object.keys(openapi.paths).length, 'every documented path was crawled');
});

test('drafts, hidden products and inactive sections are not public, even by slug', async () => {
  const { call } = await world();
  for (const path of [
    '/api/public/v1/products/draft-secret-product',
    '/api/public/v1/products/hidden-secret-product',
    '/api/public/v1/products/draft-secret-product/reviews',
    '/api/public/v1/sections/secret-section',
  ]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    const body = (await res.json()) as { success: boolean; code?: string };
    assert.equal(body.success, false);
  }
  const search = await (await call('/api/public/v1/search?q=DRAFT-SECRET-NAME')).text();
  assert.ok(!search.includes('draft-secret-product'));
});

test('a review is public only once published, with the reviewer masked and no photo URLs', async () => {
  const { call, first } = await world();
  const body = (await (await call(`/api/public/v1/products/${first.slug}/reviews`)).json()) as {
    data: { count: number; reviews: Array<{ reviewer: string; text: string; photo_count: number }> };
  };
  assert.equal(body.data.count, 1, 'the pending review is not counted');
  assert.equal(body.data.reviews[0].text, 'Great nozzle.');
  assert.equal(body.data.reviews[0].reviewer, 'Leaky C.', 'the site\'s own mask (maskName), never the full name');
  assert.equal(body.data.reviews[0].photo_count, 0);
  assert.ok(!/Leaky Customer/.test(JSON.stringify(body)));
});

// =========================================================================
// THE SCHEMA IS THE ALLOWLIST
// =========================================================================

test('every answer matches the schema /openapi.json publishes for it — no field more, none missing', async () => {
  const { call, first } = await world({ communityOpen: true });
  const doc = (await (await call('/api/public/v1/openapi.json')).json()) as {
    paths: Record<string, { get: { responses: { '200': { content: { 'application/json': { schema: Record<string, unknown> } } } } } }>;
    components: { schemas: Record<string, Record<string, unknown>> };
  };
  for (const route of ALL_ROUTES) {
    if (route.path === '/openapi.json' || route.path === '/context') continue;
    const schema = doc.paths[route.path].get.responses['200'].content['application/json'].schema;
    for (const path of concrete(route, first)) {
      const body = await (await call(path)).json();
      const errors = validate(body, schema, doc.components.schemas);
      assert.deepEqual(errors.slice(0, 5), [], `${path} does not match its schema`);
    }
  }
});

test('/openapi.json is a complete OpenAPI 3.1 document of exactly the served endpoints', async () => {
  const { call } = await world();
  interface Param { name: string; in: string; required?: boolean }
  interface OpenApiDoc {
    openapi: string;
    servers: Array<{ url: string }>;
    paths: Record<string, { get: { operationId: string; parameters: Param[] } }>;
    components: Record<string, Record<string, unknown>>;
  }
  const doc = (await (await call('/api/public/v1/openapi.json')).json()) as OpenApiDoc;
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.servers[0].url, `${ORIGIN}/api/public/v1`);
  assert.deepEqual(Object.keys(doc.paths).sort(), ALL_ROUTES.map((r) => r.path).sort());
  const ids = Object.values(doc.paths).map((p) => p.get.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  for (const [path, item] of Object.entries(doc.paths)) {
    assert.deepEqual(Object.keys(item), ['get'], `${path}: GET only`);
    for (const name of [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])) {
      assert.ok(item.get.parameters.some((p) => p.name === name && p.in === 'path' && p.required), `${path} documents {${name}}`);
    }
  }
  // Every $ref resolves.
  const refs = new Set<string>();
  JSON.stringify(doc, (k, v) => (k === '$ref' && typeof v === 'string' ? (refs.add(v), v) : v));
  for (const r of refs) {
    const [, section, name] = /^#\/components\/(schemas|responses)\/(.+)$/.exec(r) ?? [];
    assert.ok(section && doc.components[section][name], `unresolvable ${r}`);
  }
});

test('/context introduces the API to an agent: conventions, where to start, every endpoint', async () => {
  const { call } = await world();
  const res = await call('/api/public/v1/context');
  assert.equal(res.status, 200);
  interface ContextDoc {
    base_url: string;
    openapi_url: string;
    access: { authentication: string; methods: string[] };
    conventions: Record<string, string>;
    resources: Array<{ endpoints: Array<{ path: string }> }>;
    content: { products: number; community_open_to_visitors: boolean };
  }
  const doc = (await res.json()) as ContextDoc;
  assert.equal(doc.base_url, `${ORIGIN}/api/public/v1`);
  assert.equal(doc.openapi_url, `${ORIGIN}/api/public/v1/openapi.json`);
  assert.equal(doc.access.authentication, 'none');
  assert.deepEqual(doc.access.methods, ['GET', 'HEAD']);
  for (const k of ['envelope', 'languages', 'currency', 'prices', 'identifiers', 'pagination', 'images', 'errors', 'caching', 'rate_limits']) {
    assert.ok(typeof doc.conventions[k] === 'string' && doc.conventions[k].length > 20, `conventions.${k}`);
  }
  const listed = doc.resources.flatMap((r) => r.endpoints.map((e) => e.path)).sort();
  assert.deepEqual(listed, ALL_ROUTES.map((r) => r.path).sort());
  assert.ok(doc.content.products > 0);
  assert.equal(doc.content.community_open_to_visitors, false, 'the community is closed by default');
});

// =========================================================================
// ANONYMOUS
// =========================================================================

test('an admin session cookie changes nothing, and no session is even read', async () => {
  const { call, first, env } = await world();
  const counted = { sessions: 0 };
  const db = env.DB as D1Database;
  (env as { DB: unknown }).DB = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (/\bsessions\b/i.test(sql)) counted.sessions += 1;
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  for (const path of ['/api/public/v1/products?limit=5', `/api/public/v1/products/${first.slug}`, '/api/public/v1/home', '/api/public/v1/site']) {
    const anon = await (await call(path)).text();
    const admin = await (await call(path, { headers: { Cookie: `levonis_session=${ADMIN_TOKEN}` } })).text();
    assert.equal(admin, anon, `${path}: the same answer with and without a session`);
  }
  assert.equal(counted.sessions, 0, 'no session lookup on the public API');
});

// =========================================================================
// READ-ONLY
// =========================================================================

test('every write method is refused with 405 and changes nothing', async () => {
  const { call, raw, first } = await world();
  const before = JSON.stringify(raw.prepare('SELECT COUNT(*) AS n, SUM(price_iqd) AS s FROM products').get());
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const path of ['/api/public/v1/products', `/api/public/v1/products/${first.slug}`, '/api/public/v1/anything']) {
      const res = await call(path, { method });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.get('Allow'), 'GET, HEAD, OPTIONS');
      assert.equal(((await res.json()) as { code: string }).code, 'METHOD_NOT_ALLOWED');
    }
  }
  // A cross-origin write never even gets that far.
  const cross = await call('/api/public/v1/products', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(JSON.stringify(raw.prepare('SELECT COUNT(*) AS n, SUM(price_iqd) AS s FROM products').get()), before);
});

// =========================================================================
// A GOOD CITIZEN
// =========================================================================

test('CORS: any origin may read, without credentials; the preflight is answered', async () => {
  const { call } = await world();
  const res = await call('/api/public/v1/site', { headers: { Origin: 'https://agent.example' } });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  const pre = await call('/api/public/v1/products', { method: 'OPTIONS', headers: { Origin: 'https://agent.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(pre.headers.get('Access-Control-Allow-Methods') ?? '', /GET, HEAD, OPTIONS/);
  const err = await call('/api/public/v1/products/no-such-product');
  assert.equal(err.status, 404);
  assert.equal(err.headers.get('Access-Control-Allow-Origin'), '*', 'errors are readable too');
});

test('HEAD answers without a body; ETag + If-None-Match answer 304; Cache-Control is public', async () => {
  const { call } = await world();
  const get = await call('/api/public/v1/sections');
  const etag = get.headers.get('ETag');
  assert.match(etag ?? '', /^W\/"[0-9a-f]{32}"$/);
  assert.match(get.headers.get('Cache-Control') ?? '', /^public, max-age=\d+, s-maxage=\d+$/);
  const head = await call('/api/public/v1/sections', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.equal(head.headers.get('ETag'), etag);
  const again = await call('/api/public/v1/sections', { headers: { 'If-None-Match': etag! } });
  assert.equal(again.status, 304);
  assert.equal((await again.text()).length, 0);
});

test('an answer from the edge cache keeps this API\'s own lifetime — Cloudflare\'s four-hour rewrite is undone', async () => {
  // A stand-in for `caches.default` that does what the live zone does to a
  // hit (seen 2026-09-28): the stored `max-age=60` comes back as the zone's
  // Browser Cache TTL, `max-age=14400`, with CF-Cache-Status: HIT.
  const store = new Map<string, Response>();
  const edge = {
    async match(req: Request) {
      const stored = store.get(req.url);
      if (!stored) return undefined;
      const copy = stored.clone();
      const headers = new Headers(copy.headers);
      headers.set('Cache-Control', (headers.get('Cache-Control') ?? '').replace(/max-age=\d+/, 'max-age=14400'));
      headers.set('CF-Cache-Status', 'HIT');
      return new Response(copy.body, { status: copy.status, headers });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, res);
    },
  };
  const scope = globalThis as { caches?: unknown };
  scope.caches = { default: edge };
  try {
    const { call } = await world();
    const miss = await call('/api/public/v1/sections?utm=x');
    assert.equal(miss.status, 200);
    await Promise.all(pending);
    assert.equal(store.size, 1, 'the answer was stored under its canonical URL');
    const own = miss.headers.get('Cache-Control');
    assert.match(own ?? '', /^public, max-age=60, s-maxage=\d+$/);

    const hit = await call('/api/public/v1/sections');
    assert.equal(hit.headers.get('CF-Cache-Status'), 'HIT', 'served from the cache');
    assert.equal(hit.headers.get('Cache-Control'), own, 'not the zone\'s four hours');
    assert.equal(await hit.text(), await miss.text());

    const revalidated = await call('/api/public/v1/sections', { headers: { 'If-None-Match': miss.headers.get('ETag')! } });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.headers.get('Cache-Control'), own, 'a 304 from the cache says the same');
  } finally {
    delete scope.caches;
  }
});

test('over the limit: 429 with Retry-After; the limit counts per IP', async () => {
  const { call, raw } = await world();
  const now = Math.floor(Date.now() / 1000);
  raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)').run(`public-v1:${IP}`, now - (now % 60), 240);
  const res = await call('/api/public/v1/site');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.equal(((await res.json()) as { code: string }).code, 'RATE_LIMITED');
  const other = await call('/api/public/v1/site', { headers: { 'CF-Connecting-IP': '198.51.100.9' } });
  assert.equal(other.status, 200, 'another address is not affected');
});

test('pagination visits every product exactly once, and the total agrees', async () => {
  const { call } = await world();
  const seen: string[] = [];
  let url: string | null = '/api/public/v1/products?limit=4';
  let total: number | null = null;
  for (let guard = 0; url && guard < 20; guard++) {
    const body = (await (await call(url)).json()) as {
      data: Array<{ slug: string }>;
      meta: { pagination: { total: number | null; next_cursor: string | null } };
      links: { next: string | null };
    };
    total = body.meta.pagination.total;
    seen.push(...body.data.map((p) => p.slug));
    url = body.links.next ? body.links.next.replace(ORIGIN, '') : null;
  }
  assert.equal(new Set(seen).size, seen.length, 'no product twice');
  assert.equal(seen.length, total);
  assert.ok(!seen.includes('draft-secret-product'));
});

test('parameters are validated; an unknown one is ignored; a forged cursor is refused', async () => {
  const { call } = await world();
  const bad = await call('/api/public/v1/products?min_price=cheap');
  assert.equal(bad.status, 400);
  assert.deepEqual(((await bad.json()) as { code: string; details: unknown }).code, 'BAD_PARAM');
  const sort = await call('/api/public/v1/products?sort=random');
  assert.equal(sort.status, 400);
  const cursor = await call('/api/public/v1/products?cursor=not-a-cursor');
  assert.equal(cursor.status, 400);
  assert.equal(((await cursor.json()) as { code: string }).code, 'INVALID_CURSOR');
  const ignored = (await (await call('/api/public/v1/brands?utm_source=agent')).json()) as { links: { self: string } };
  assert.equal(ignored.links.self, `${ORIGIN}/api/public/v1/brands`, 'an undeclared parameter never reaches the query or the cache key');
  const big = (await (await call('/api/public/v1/products?limit=1000')).json()) as { meta: { pagination: { limit: number } } };
  assert.equal(big.meta.pagination.limit, 50, 'a large limit is clamped, not refused');
  const search = await call('/api/public/v1/search');
  assert.equal(search.status, 400, 'q is required');
});

test('pictures are absolute URLs to the original public files — never a supplier link', async () => {
  const { call, first } = await world();
  const body = (await (await call(`/api/public/v1/products/${first.slug}`)).json()) as {
    data: { images: Array<{ url: string; width: number; height: number; alt: { en: string } }>; name: { ar: string } };
  };
  assert.deepEqual(body.data.images, [
    { url: `${ORIGIN}/files/${GALLERY_KEY}`, width: 1600, height: 1600, alt: { ar: 'صورة', en: 'Picture', ckb: '' } },
  ]);
  assert.equal(body.data.name.ar, 'منتج عام');
  const list = (await (await call('/api/public/v1/products?limit=50')).json()) as { data: Array<{ slug: string; image: { url: string } | null }> };
  assert.equal(list.data.find((p) => p.slug === first.slug)?.image?.url, `${ORIGIN}/files/${GALLERY_KEY}`);
});

test('the main site only: a store\'s subdomain does not serve the platform API', async () => {
  const { call } = await world();
  const res = await call('/api/public/v1/site', { host: MERCHANT_HOST });
  assert.equal(res.status, 404);
});

test('the index answers at /api/public/v1 and /api/public/v1/', async () => {
  const { call } = await world();
  for (const path of ['/api/public/v1', '/api/public/v1/']) {
    const res = await call(path);
    assert.equal(res.status, 200, path);
    const body = (await res.json()) as { context_url: string; read_only: boolean };
    assert.equal(body.context_url, `${ORIGIN}/api/public/v1/context`);
    assert.equal(body.read_only, true);
  }
});

test('robots.txt lets agents fetch the public API while /api/ stays disallowed', async () => {
  const { call } = await world();
  const robots = await (await call('/robots.txt')).text();
  assert.match(robots, /^Allow: \/api\/public\/v1\/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.ok(robots.indexOf('Allow: /api/public/v1/') < robots.indexOf('Disallow: /api/'));
});

// =========================================================================
// LEVO COMMUNITY AND ITS SHOPS
// =========================================================================

test('the community follows its door: closed to visitors by default (503 COMMUNITY_CLOSED), a shop stays public on its own address', async () => {
  const { call } = await world();
  const status = (await (await call('/api/public/v1/community')).json()) as { data: { open: boolean } };
  assert.equal(status.data.open, false);
  for (const path of [
    '/api/public/v1/community/products',
    '/api/public/v1/community/stores',
    '/api/public/v1/community/requests',
    '/api/public/v1/community/requests/req_vase7q',
    '/api/public/v1/community/works',
  ]) {
    const res = await call(path);
    assert.equal(res.status, 503, path);
    assert.equal(((await res.json()) as { code: string }).code, 'COMMUNITY_CLOSED', path);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*', `${path}: the refusal is readable too`);
  }
  // «A shop with its own address is not the directory» (worker/lib/communityGate.ts).
  const shop = await call('/api/public/v1/stores/ali3d');
  assert.equal(shop.status, 200);
  const product = await call('/api/public/v1/stores/ali3d/products/ali3d-dragon');
  assert.equal(product.status, 200);
  // Once the owner opens it, the lists are served — no deploy.
  const open = await world({ communityOpen: true });
  assert.equal(((await (await open.call('/api/public/v1/community')).json()) as { data: { open: boolean } }).data.open, true);
  assert.equal((await open.call('/api/public/v1/community/products')).status, 200);
});

test('a shop: its public face only — no phone, no pickup address, only real links, pictures as the site\'s own files', async () => {
  const { call } = await world();
  interface Shop {
    slug: string;
    logo: { url: string } | null;
    banner: { url: string } | null;
    governorate: { code: string; name: { ar: string; en: string } } | null;
    social_links: Array<{ network: string; url: string }>;
    business_hours: Array<{ day: string; open: string; close: string; closed: boolean }>;
    delivery: { pickup: { governorate: { code: string } | null } | null; note: string };
    merchant: { name: string; verified: boolean; rating: number | null };
    services: Array<{ title: string; materials: string[]; image: { url: string } | null }>;
    showcase: Array<{ kind: string; title: string }>;
    url: string;
  }
  const shop = ((await (await call('/api/public/v1/stores/ali3d')).json()) as { data: Shop }).data;
  assert.equal(shop.slug, 'ali3d');
  assert.equal(shop.url, `https://ali3d.${APEX}`);
  assert.equal(shop.logo?.url, `${ORIGIN}/files/merchants/usr_owner7q/logos/logo.webp`);
  assert.equal(shop.banner?.url, `${ORIGIN}/files/merchants/usr_owner7q/covers/banner.webp`);
  assert.equal(shop.governorate?.code, 'baghdad');
  assert.equal(shop.governorate?.name.en, 'Baghdad');
  assert.deepEqual(shop.social_links, [{ network: 'instagram', url: 'https://instagram.com/ali3d' }], 'a javascript: link is never published');
  assert.deepEqual(
    shop.business_hours,
    [
      { day: 'Sat', open: '09:00', close: '18:00', closed: false },
      { day: 'Fri', open: '', close: '', closed: true },
    ],
    'a day the merchant marked closed says so'
  );
  assert.deepEqual(shop.delivery.pickup, { governorate: { code: 'baghdad', name: { ar: 'بغداد', en: 'Baghdad', ckb: 'بەغدا' } } });
  assert.equal(shop.delivery.note, 'Packed with care.');
  assert.equal(shop.merchant.name, 'Ali Prints');
  assert.equal(shop.merchant.verified, true);
  assert.equal(shop.merchant.rating, 4.5);
  assert.deepEqual(shop.services[0].materials, ['PLA', 'PETG']);
  assert.equal(shop.services[0].image?.url, `${ORIGIN}/files/merchants/usr_owner7q/public/service.webp`);
  assert.deepEqual(shop.showcase.map((s) => [s.kind, s.title]), [['work', 'A finished dragon']]);
});

test('a shop\'s products: published only; availability, never a count; the rounded sales tier; no off-site picture', async () => {
  const { call } = await world();
  const list = (await (await call('/api/public/v1/stores/ali3d/products')).json()) as {
    data: Array<{ slug: string }>;
    meta: { pagination: { total: number } };
  };
  assert.deepEqual(list.data.map((p) => p.slug), ['ali3d-dragon', 'ali3d-vase'], 'drafts, hidden and moderated products are not listed');
  assert.equal(list.meta.pagination.total, 2);
  for (const slug of ['ali3d-draft', 'ali3d-hidden', 'ali3d-moderated', 'banned-thing']) {
    assert.equal((await call(`/api/public/v1/stores/ali3d/products/${slug}`)).status, 404, slug);
  }
  const product = ((await (await call('/api/public/v1/stores/ali3d/products/ali3d-dragon')).json()) as {
    data: {
      images: Array<{ url: string }>;
      media: Array<{ kind: string; url: string }>;
      in_stock: boolean;
      sales_tier: number | null;
      price_iqd: number;
      original_price_iqd: number | null;
      on_sale: boolean;
      store: { slug: string };
      url: string;
    };
  }).data;
  assert.deepEqual(product.images.map((i) => i.url), [`${ORIGIN}/files/merchants/usr_owner7q/public/dragon.webp`]);
  assert.deepEqual(product.media.map((m) => [m.kind, m.url]), [['image', `${ORIGIN}/files/merchants/usr_owner7q/public/dragon.webp`]]);
  assert.equal(product.in_stock, true);
  assert.notEqual(product.sales_tier, 57, 'never the exact sales count');
  assert.equal(product.price_iqd, 25000);
  assert.equal(product.original_price_iqd, 30000);
  assert.equal(product.on_sale, true);
  assert.equal(product.store.slug, 'ali3d');
  assert.equal(product.url, `https://ali3d.${APEX}/p/ali3d-dragon`);
});

test('a suspended shop answers nothing of itself, and appears nowhere in the community', async () => {
  const { call } = await world({ communityOpen: true });
  for (const path of ['/api/public/v1/stores/banned-shop', '/api/public/v1/stores/banned-shop/products', '/api/public/v1/stores/banned-shop/reviews']) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    assert.equal(((await res.json()) as { code: string }).code, 'STORE_UNAVAILABLE', path);
  }
  const stores = (await (await call('/api/public/v1/community/stores')).json()) as { data: Array<{ slug: string }> };
  assert.deepEqual(stores.data.map((s) => s.slug), ['ali3d']);
  const products = (await (await call('/api/public/v1/community/products')).json()) as { data: Array<{ slug: string; store: { slug: string } }> };
  assert.deepEqual(products.data.map((p) => [p.store.slug, p.slug]), [['ali3d', 'ali3d-dragon'], ['ali3d', 'ali3d-vase']]);
  const works = (await (await call('/api/public/v1/community/works')).json()) as { data: Array<{ title: string; store: { slug: string } }> };
  assert.deepEqual(works.data.map((w) => [w.store.slug, w.title]), [['ali3d', 'A finished dragon']]);
});

test('a shop\'s reviews: visible ones only, the reviewer masked, photos counted not linked, the merchant\'s reply', async () => {
  const { call } = await world();
  const body = (await (await call('/api/public/v1/stores/ali3d/reviews')).json()) as {
    data: {
      count: number;
      average: number | null;
      distribution: Record<string, number>;
      reviews: Array<{ reviewer: string; text: string; photo_count: number; merchant_reply: string | null }>;
    };
  };
  assert.equal(body.data.count, 1, 'a review moderation hid is not counted');
  assert.equal(body.data.average, 5);
  assert.deepEqual(body.data.distribution, { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 });
  assert.deepEqual(body.data.reviews, [
    {
      rating: 5,
      text: 'Lovely print.',
      reviewer: 'Leaky C.',
      verified_purchase: true,
      photo_count: 1,
      merchant_reply: 'Thank you!',
      merchant_replied_at: null,
      created_at: '2026-08-10T00:00:00.000Z',
    },
  ]);
});

test('the request board: only requests on the public board, never the customer, never their notes', async () => {
  const { call } = await world({ communityOpen: true });
  const list = (await (await call('/api/public/v1/community/requests')).json()) as {
    data: Array<{ reference: string; title: string; governorate: { code: string } | null; url: string }>;
  };
  assert.deepEqual(list.data.map((r) => r.title), ['Print me a vase'], 'private, draft and expired requests are not on the board');
  assert.equal(list.data[0].reference, 'req_vase7q');
  assert.equal(list.data[0].url, `${ORIGIN}/requests?request=req_vase7q`);
  assert.equal(list.data[0].governorate?.code, 'baghdad');
  const text = JSON.stringify(list);
  assert.ok(!/Leaky/.test(text), 'the customer is never named, not even masked');
  for (const ref of ['req_private7q', 'req_draft7q', 'req_old7q']) {
    assert.equal((await call(`/api/public/v1/community/requests/${ref}`)).status, 404, ref);
  }
  const filtered = (await (await call('/api/public/v1/community/requests?governorate=basra')).json()) as { data: unknown[] };
  assert.equal(filtered.data.length, 0);
  const searched = (await (await call('/api/public/v1/community/requests?q=vase')).json()) as { data: unknown[] };
  assert.equal(searched.data.length, 1);
});

test('a shop product sold in variants: every live combination with its own price and availability, named by its values', async () => {
  const { call } = await world();
  const body = (await (await call('/api/public/v1/stores/ali3d/products/ali3d-vase')).json()) as {
    data: {
      options: Array<{ name: { ar: string; en: string }; kind: string; values: Array<{ name: { en: string } }> }>;
      variants: Array<{ choices: Array<{ option: string; value: string }>; price_iqd: number; compare_at_iqd: number | null; in_stock: boolean }>;
      attributes: { material: string | null; technology: string | null; color: string | null; dimensions_mm: { x: number | null; y: number | null; z: number | null } | null; weight_g: number | null };
    };
  };
  const { options, variants, attributes } = body.data;
  assert.deepEqual(options.map((o) => [o.name.en, o.name.ar, o.kind]), [['Size', 'الحجم', 'choice']]);
  assert.deepEqual(options[0].values.map((v) => v.name.en), ['Small', 'Large'], 'a value no live variant uses is not offered');
  assert.deepEqual(
    variants.map((v) => [v.choices.map((c) => `${c.option}=${c.value}`).join(','), v.price_iqd, v.compare_at_iqd, v.in_stock]),
    [
      ['Size=Small', 15000, null, true],
      ['Size=Large', 22000, 26000, false],
    ],
    'a switched-off variant is not published'
  );
  assert.deepEqual(attributes, { material: 'pla', technology: 'fdm', color: 'white', finish: null, dimensions_mm: { x: 100, y: 100, z: 250 }, weight_g: 180 });
});
