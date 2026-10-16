/**
 * WHAT THE HOT PUBLIC ROUTES COST D1 (P2a; plan §B.1 #4) — ceilings, measured.
 *
 * Each route runs on the real router against the real migrations through the
 * wave-counting adapter (tests/fixtures/wavesD1.ts): `prepares` is how many
 * statements it built, `waves` how many DEPENDENT round trips it took — the
 * number that becomes latency from a Worker whose D1 primary is in another
 * region. The ceilings below are the numbers measured after P2a; a change
 * that adds a wave to a first-screen route fails here, by name.
 *
 *   before → after (guest, warm isolate; member in brackets)
 *   /api/home              4 → 3  (7 → 6)      /api/products          3 → 2  (6 → 5)
 *   /api/home/sections     5 → 4  (8 → 6)      /api/products/:slug    6 → 2  (9 → 5)
 *   storefront resolve     9 → 5                 /:slug/reviews         3 → 2
 *
 * The category map (`/api/catalog/tree`, speed review 2026-10-16): under
 * TREE_AVAILABILITY_CAP every card is read for «متوفرة الآن» — 3 waves. Past
 * the cap it carries one photograph per section from a short list read in
 * its FIRST wave, beside the catalogs and the memberships: 2 waves (it was 4
 * — a dependent short list, its rows, then their cards; 1 before it carried
 * photographs at all). Built with the guest's pricing inputs (the answer is
 * cached for everyone), a member's miss no longer waits for their tier
 * (5 → 3 under the cap, 5 → 2 past it).
 *
 * Also proved: the pricing inputs are read in ONE wave on a cold isolate and
 * from memory on a warm one; an admin write forgets them at once; the
 * shopfront reads the owner's tier once, not twice.
 *
 * Run: node --import tsx --test tests/d1Waves.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, stubApp, get, type Mount, type StubUser } from './fixtures/app';
import { wavesD1 } from './fixtures/wavesD1';
import { seedLiveCatalog, LIVE_PRODUCTS, P } from './fixtures/liveCatalog';
import { seedLayoutStore, SLUG } from './fixtures/storeLayout';
import { homeRoutes, productRoutes, pricingCtxForUser } from '../worker/routes/products';
import { storefrontRoutes } from '../worker/routes/storefront';
import { miscRoutes } from '../worker/routes/misc';
import { communityRoutes } from '../worker/routes/community';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { PRICING_INPUTS_TTL_MS, forgetPricingInputs, pricingInputsFor } from '../worker/lib/membershipBenefits';
import { compareRoutes } from '../worker/routes/compare';
import { TREE_AVAILABILITY_CAP, catalogRoutes } from '../worker/routes/catalog';

const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const HOST = `${SLUG}.levonis-iq.com`;
const MEMBER: StubUser = { id: 'c1', role: 'customer', email: 'c1@x.co' };

const mount: Mount = (a) => {
  a.route('/api/home', homeRoutes);
  a.route('/api/products', productRoutes);
  a.route('/api/storefront', storefrontRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/compare', compareRoutes);
  a.route('/api/catalog', catalogRoutes);
  a.route('/api', miscRoutes);
};

function world() {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedLayoutStore(raw);
  const { waves, db } = wavesD1(raw);
  const app = (user: StubUser | null, host?: string) => stubApp(db, user, mount, { host, env: ENV });
  const measure = async (path: string, user: StubUser | null = null, host?: string) => {
    waves.reset();
    const res = await get(app(user, host), path);
    const body = await res.text();
    assert.equal(res.status, 200, `${path}: ${body}`);
    return { ...waves.counts };
  };
  return { raw, db, waves, measure };
}

/** The ceilings (guest warm / guest cold / member warm), the prepare ceiling, and where. */
const CEILINGS: Array<{ path: string; host?: string; waves: [warm: number, cold: number, member: number]; prepares: number }> = [
  // FX-7: the SKU rung (product_sku_prices) is read beside the relations, in the same wave — one statement, no wave.
  // The Bambu import (spec §G.5): the cards' knowledge line names the section from the memoised taxonomy,
  // read in the FIRST wave on a cold isolate (one statement, no wave; nothing warm) — 23 → 24.
  { path: '/api/home', waves: [3, 3, 6], prepares: 24 },
  { path: '/api/home/sections', waves: [4, 4, 6], prepares: 22 },
  { path: '/api/products', waves: [2, 2, 5], prepares: 17 },
  { path: `/api/products/${LIVE_PRODUCTS[0].slug}`, waves: [2, 2, 5], prepares: 23 },
  // FX-1: the display rate (pricing_fx_rates USD) is read beside the settings, in the same wave.
  { path: '/api/settings/public', waves: [1, 1, 1], prepares: 2 },
  { path: '/api/community/access', waves: [1, 1, 1], prepares: 1 },
  { path: '/api/storefront/resolve', host: HOST, waves: [5, 5, 5], prepares: 20 },
  { path: `/api/storefront/${SLUG}`, waves: [5, 5, 5], prepares: 20 },
  { path: `/api/storefront/${SLUG}/products`, waves: [2, 2, 2], prepares: 2 },
  { path: `/api/storefront/${SLUG}/reviews`, waves: [2, 2, 2], prepares: 3 },
  { path: '/api/print-quote/materials', waves: [1, 1, 1], prepares: 1 },
  { path: '/api/print-quote/printers', waves: [2, 2, 3], prepares: 3 },
  { path: '/api/print-quote/accessories', waves: [1, 1, 1], prepares: 1 },
  { path: '/api/marketplace/print/catalog', waves: [1, 1, 1], prepares: 3 },
  // The Bambu import (spec §G.1): the knowledge answer — the VISIBLE gate, then its seven reads in one wave
  // (the relation targets' pictures among them, and the translation memory, 0196 — I18N-DESIGN §A.5).
  // Measured 2 / 2 / 2; the relation path has its own test below.
  { path: `/api/products/${LIVE_PRODUCTS[0].slug}/knowledge`, waves: [2, 2, 2], prepares: 8 },
  // The category map under TREE_AVAILABILITY_CAP: catalogs, memberships (and the past-the-cap short list,
  // which answers nothing here) in one wave, then every product, then their cards. The same for a member:
  // the map is built without the viewer's tier (it was 5 for a member).
  { path: '/api/catalog/tree', waves: [3, 3, 3], prepares: 16 },
];

/**
 * THE COMPARISON (not first paint; the Bambu import spec §G.5): the knowledge model's facts for the
 * compare-flagged keys are ONE `IN` read in the wave that already reads the taxonomy and the pictures, and
 * so is the compared products' translation memory (0196, I18N-DESIGN §A.5).
 * Measured with 0194 and 0196 on the database: warm 5, cold 6, member 8 waves; 26 statements cold.
 */
const COMPARE = { path: `/api/compare?ids=${P.H2D},${P.X2D}`, waves: [5, 6, 8] as const, prepares: 26 };

test('every hot public route stays under its measured wave and prepare ceilings — cold isolate, warm isolate, signed in', async () => {
  const w = world();
  const report: string[] = [];
  for (const r of CEILINGS) {
    const cold = await w.measure(r.path, null, r.host);
    const warm = await w.measure(r.path, null, r.host);
    const member = await w.measure(r.path, MEMBER, r.host);
    report.push(`${r.path}: waves cold ${cold.waves} warm ${warm.waves} member ${member.waves}; prepares ${cold.prepares}/${warm.prepares}/${member.prepares}`);
    assert.ok(cold.waves <= r.waves[1], `${r.path} cold: ${cold.waves} waves > ${r.waves[1]}\n${cold.sqls.join('\n')}`);
    assert.ok(warm.waves <= r.waves[0], `${r.path} warm: ${warm.waves} waves > ${r.waves[0]}\n${warm.sqls.join('\n')}`);
    assert.ok(member.waves <= r.waves[2], `${r.path} member: ${member.waves} waves > ${r.waves[2]}\n${member.sqls.join('\n')}`);
    for (const c of [cold, warm, member]) assert.ok(c.prepares <= r.prepares + (c === member ? 5 : 0), `${r.path}: ${c.prepares} prepares > ${r.prepares}`);
  }
  console.log(report.join('\n'));
});

test('the comparison stays under its measured ceiling with the knowledge read, which rides an existing wave', async () => {
  const w = world();
  const random = Math.random;
  Math.random = () => 0.5; // the rate limiter's 2 % sweep is its own statement, not the comparison's
  try {
    const cold = await w.measure(COMPARE.path);
    const warm = await w.measure(COMPARE.path);
    const member = await w.measure(COMPARE.path, MEMBER);
    assert.ok(warm.waves <= COMPARE.waves[0], `warm ${warm.waves}\n${warm.sqls.join('\n')}`);
    assert.ok(cold.waves <= COMPARE.waves[1], `cold ${cold.waves}\n${cold.sqls.join('\n')}`);
    assert.ok(member.waves <= COMPARE.waves[2], `member ${member.waves}\n${member.sqls.join('\n')}`);
    assert.ok(cold.prepares <= COMPARE.prepares, `${cold.prepares} prepares`);
    // (the adapter keeps a statement's first 90 characters)
    assert.ok(cold.sqls.some((q) => q.startsWith('SELECT product_id, canonical_key, scope_kind')), `the knowledge read is sent\n${cold.sqls.join('\n')}`);
    assert.ok(cold.sqls.some((q) => q.startsWith('SELECT r.product_id, t.en, t.ar, t.ckb FROM catalog_translation_refs')), `the translation read is sent\n${cold.sqls.join('\n')}`);
  } finally {
    Math.random = random;
  }
});

test('the Bambu import adds no wave: the page body carries swatches and source variants, the cards their knowledge line', async () => {
  const w = world();
  const slug = LIVE_PRODUCTS.find((p) => p.id === P.H2D)!.slug;
  w.raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active, kind, default_value_id) VALUES ('g_w_ver', '${P.H2D}', 'Version', 0, 1, 'color', 'v_w_a');
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES
      ('v_w_a', '${P.H2D}', 'g_w_ver', 'Jade White', 0, 1), ('v_w_b', '${P.H2D}', 'g_w_ver', 'Black', 1, 1);
    INSERT INTO product_option_value_swatches (option_value_id, product_id, url, r2_key, width, height, published_hex, hex_source_ref, source_url)
      VALUES ('v_w_a', '${P.H2D}', '/files/products/import/swatch/${'aa'.repeat(32)}.webp', 'products/import/swatch/${'aa'.repeat(32)}.webp', 128, 128, '', '', 'https://store.example/s.png');
  `);
  const page = await w.measure(`/api/products/${slug}`);
  assert.ok(page.waves <= 2, `the product page: ${page.waves} waves\n${page.sqls.join('\n')}`);
  // (the adapter keeps a statement's first 90 characters)
  assert.ok(page.sqls.some((q) => q.startsWith('SELECT v.*, s.url AS swatch_url')), `the swatch is joined in the values statement\n${page.sqls.join('\n')}`);
  assert.ok(page.sqls.some((q) => q.startsWith('SELECT i.*, (SELECT r.via_variant_id FROM product_option_source_refs')), 'the source variant rides the images statement');
  assert.equal(page.sqls.filter((q) => q.includes('product_option_source_refs')).length, 1, 'and has no statement of its own');
  const body = await (await get(stubApp(w.db, null, mount, { env: ENV }), `/api/products/${slug}`)).json() as { relations: { option_groups: Array<{ id: string; kind?: string; values: Array<{ id: string; swatch?: unknown }> }> } };
  const group = body.relations.option_groups.find((g) => g.id === 'g_w_ver')!;
  assert.equal(group.kind, 'color');
  assert.ok(group.values.find((v) => v.id === 'v_w_a')?.swatch, 'the swatch rides the page body');
  const list = await w.measure('/api/products');
  assert.ok(list.waves <= 2, `the listing: ${list.waves} waves`);
  const cards = (await (await get(stubApp(w.db, null, mount, { env: ENV }), '/api/products')).json() as { products: Array<Record<string, unknown>> }).products;
  assert.ok(cards.some((c) => Array.isArray(c.key_specs) && c.section_name), 'the cards carry key_specs and section_name from the row and the taxonomy already read');
});

/**
 * THE KNOWLEDGE ANSWER OF AN IMPORTED PRODUCT, measured on the path it really takes: a relation resolved to
 * a VISIBLE product links it with its picture (nearly every imported printer, AMS, hotend, plate and filament).
 * The picture rides the first wave — 2 / 2 / 2 and 8 statements (the translation memory's read among them),
 * the same as a product with no relation.
 * (It was a third, dependent wave; the ceiling above was measured on a product with no knowledge row.)
 */
test('the knowledge answer with a relation to a VISIBLE target: its picture rides the first wave — no third round trip', async () => {
  const w = world();
  w.raw.exec(`
    INSERT INTO product_relations (id, product_id, relation, target_kind, target_product_id, target_source, target_source_handle, target_label, state, evidence_kind) VALUES
      ('rel_w_a1', '${P.H2D}', 'compatible_with', 'printer', '${P.A1}', 'bambu_us', 'a1', 'Bambu Lab A1', 'resolved', 'compat_section'),
      ('rel_w_x2d', '${P.H2D}', 'compatible_with', 'printer', '${P.X2D}', 'bambu_us', 'x2d', 'Bambu Lab X2D', 'resolved', 'compat_section'),
      ('rel_w_ams', '${P.H2D}', 'requires', 'ams', NULL, 'bambu_us', 'ams-2-pro', 'AMS 2 Pro', 'pending', 'feature_bullet');
    INSERT INTO product_images (id, product_id, url, r2_key, content_type, sort_order, is_primary) VALUES
      ('img_w_a1', '${P.A1}', '/files/products/a1/a1-front.webp', 'products/a1/a1-front.webp', 'image/webp', 0, 1),
      ('img_w_a1_side', '${P.A1}', '/files/products/a1/a1-side.webp', 'products/a1/a1-side.webp', 'image/webp', 1, 0);
  `);
  const path = `/api/products/${LIVE_PRODUCTS.find((p) => p.id === P.H2D)!.slug}/knowledge`;
  const cold = await w.measure(path);
  const warm = await w.measure(path);
  const member = await w.measure(path, MEMBER);
  for (const [name, c] of [['cold', cold], ['warm', warm], ['member', member]] as const) {
    assert.ok(c.waves <= 2, `${name}: ${c.waves} waves\n${c.sqls.join('\n')}`);
    assert.ok(c.prepares <= 8, `${name}: ${c.prepares} prepares\n${c.sqls.join('\n')}`);
  }
  const body = (await (await get(stubApp(w.db, null, mount, { env: ENV }), path)).json()) as {
    compatibility: { compatible: Array<{ label: string; product?: { slug: string; image: string } }> };
  };
  const a1 = body.compatibility.compatible.find((c) => c.label === 'Bambu Lab A1')!;
  assert.equal(a1.product?.image, '/files/products/a1/a1-front.webp', 'the visible target is linked with its own primary picture');
  assert.equal(body.compatibility.compatible.length, 2);
});

/**
 * PAST TREE_AVAILABILITY_CAP (the Bambu import takes the shop to ~1,142 products): no card is read for the
 * counts, and each section's photograph comes from a short list read in the map's FIRST wave — so a miss of
 * the map's edge entry costs one wave more than the bare map, not three (speed review 2026-10-16).
 */
const TREE_PAST_CAP = { waves: [2, 2, 2] as const, prepares: 19 };

test('the category map past the availability cap: photographs from a short list in the first wave, cards in the second', async () => {
  const w = world();
  const ins = w.raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id, selling_type, stock, display_order, created_at)
     VALUES (?, ?, ?, '', 1000, 'active', 'cat_printers', 'cat_printers_fdm', 'direct_sale', 0, 100, '2026-01-01T00:00:00.000Z')`
  );
  for (let i = 0; i <= TREE_AVAILABILITY_CAP; i++) ins.run(`prd_fill_${i}`, `fill-${i}`, `Filler ${i}`);
  for (const p of LIVE_PRODUCTS) w.raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([`/files/products/${p.slug}.webp`]), p.id);
  const cold = await w.measure('/api/catalog/tree');
  const warm = await w.measure('/api/catalog/tree');
  const member = await w.measure('/api/catalog/tree', MEMBER);
  for (const [name, c, ceiling] of [['warm', warm, TREE_PAST_CAP.waves[0]], ['cold', cold, TREE_PAST_CAP.waves[1]], ['member', member, TREE_PAST_CAP.waves[2]]] as const) {
    assert.ok(c.waves <= ceiling, `${name}: ${c.waves} waves > ${ceiling}\n${c.sqls.join('\n')}`);
    assert.ok(c.prepares <= TREE_PAST_CAP.prepares + (name === 'member' ? 5 : 0), `${name}: ${c.prepares} prepares\n${c.sqls.join('\n')}`);
  }
  // Not by leaving the photographs off: every section that holds a photographed product still carries one.
  const body = (await (await get(stubApp(w.db, null, mount, { env: ENV }), '/api/catalog/tree')).json()) as {
    roots: Array<{ slug: string; available_count: number | null; photo?: { src: string } }>;
  };
  assert.ok(body.roots.every((r) => r.available_count === null), 'past the cap');
  assert.ok(body.roots.every((r) => r.photo?.src.startsWith('/files/products/')), JSON.stringify(body.roots.map((r) => [r.slug, r.photo])));
});

test('the pricing inputs: one wave cold, no statement warm, forgotten at once by the seam, re-read after the TTL', async () => {
  const w = world();
  w.waves.reset();
  await pricingCtxForUser(w.db, null);
  assert.equal(w.waves.counts.waves, 1, 'settings, rules, ancestry and the pause go out together');
  assert.equal(w.waves.counts.executions, 4);
  w.waves.reset();
  await pricingCtxForUser(w.db, null);
  assert.equal(w.waves.counts.executions, 0, 'a warm isolate prices from memory');
  // A member still pays their own tier, and nothing else.
  w.waves.reset();
  await pricingCtxForUser(w.db, 'c1');
  assert.ok(w.waves.counts.sqls.every((s) => !/admin_settings|membership_benefit_rules|FROM catalogs/.test(s)), w.waves.counts.sqls.join('\n'));
  forgetPricingInputs(w.db);
  w.waves.reset();
  await pricingCtxForUser(w.db, null);
  assert.equal(w.waves.counts.executions, 4, 'the seam forgets them in this isolate');
  // The TTL, on the memo's own clock: filled at t0, it answers until the
  // window closes and re-reads past it.
  forgetPricingInputs(w.db);
  const t0 = 1_700_000_000_000;
  await pricingInputsFor(w.db, t0);
  w.waves.reset();
  await pricingInputsFor(w.db, t0 + PRICING_INPUTS_TTL_MS - 1);
  assert.equal(w.waves.counts.executions, 0);
  await pricingInputsFor(w.db, t0 + PRICING_INPUTS_TTL_MS + 1);
  assert.equal(w.waves.counts.executions, 4);
  // A second database never sees the first one's memo (keyed by the binding).
  const other = world();
  other.waves.reset();
  await pricingCtxForUser(other.db, null);
  assert.equal(other.waves.counts.executions, 4);
});

test('the shopfront reads the owner\'s tier ONCE, and its stats in one batch', async () => {
  const w = world();
  const c = await w.measure('/api/storefront/resolve', null, HOST);
  const sweeps = c.sqls.filter((s) => s.startsWith("UPDATE memberships SET state = 'expired'"));
  assert.equal(sweeps.length, 1, `getTierStatus ran ${sweeps.length} times:\n${c.sqls.join('\n')}`);
  assert.equal(c.batches, 1, 'the four stat counts are one D1 call');
  assert.ok(c.sqls.some((s) => s.startsWith('BATCH(4)')));
  // The product page: everything that needs only the row's id leaves in the second wave.
  const p = await w.measure(`/api/products/${LIVE_PRODUCTS[0].slug}`);
  assert.equal(p.waves, 2, p.sqls.join('\n'));
  const home = await w.measure('/api/home');
  assert.equal(home.waves, 3, home.sqls.join('\n'));
});

/**
 * THE PAGE OF AN IMPORTED PRODUCT (I18N-DESIGN §A.5): its translation memory is ONE statement in the wave
 * the page already spends — 2 / 2 / 5 waves and 24 statements cold, one more than an ordinary product,
 * which reads nothing (the ceiling above: 23). The read binds one parameter.
 */
test('an imported product page reads its translation memory in the existing wave: 2 / 2 / 5, 24 statements', async () => {
  const w = world();
  const live = LIVE_PRODUCTS.find((p) => p.id === P.H2D)!;
  const en = 'The buffer smooths the filament path.';
  const h = 'a'.repeat(64);
  w.raw.prepare(`UPDATE products SET description = ?, translation_meta = ? WHERE id = ?`).run(
    en,
    JSON.stringify({ description: { ar: { status: 'imported', src_rev: 1 }, ckb: { status: 'imported', src_rev: 1 } } }),
    P.H2D
  );
  w.raw.prepare(`INSERT INTO catalog_translations (h, en, ar, ckb, kind, status, part) VALUES (?, ?, ?, ?, 'short_description', 'reviewed', 'p001')`).run(
    h,
    en,
    'يُنعّم المخزن المؤقت مسار الخيط.',
    'بافەرەکە ڕێڕەوی فیلامێنتەکە نەرم دەکات.'
  );
  w.raw.prepare('INSERT INTO catalog_translation_refs (product_id, h) VALUES (?, ?)').run(P.H2D, h);
  const path = `/api/products/${live.slug}`;
  const cold = await w.measure(path);
  const warm = await w.measure(path);
  const member = await w.measure(path, MEMBER);
  assert.ok(cold.waves <= 2 && warm.waves <= 2 && member.waves <= 5, `waves ${cold.waves}/${warm.waves}/${member.waves}\n${cold.sqls.join('\n')}`);
  assert.ok(cold.prepares <= 24, `${cold.prepares} prepares\n${cold.sqls.join('\n')}`);
  assert.ok(member.prepares <= 24 + 5, `${member.prepares} prepares`);
  assert.equal(cold.sqls.filter((q) => q.includes('catalog_translation_refs')).length, 1, 'one translation read');
  const body = (await (await get(stubApp(w.db, null, mount, { env: ENV }), path)).json()) as { product: Record<string, unknown> };
  assert.equal(body.product.description_ar, 'يُنعّم المخزن المؤقت مسار الخيط.');
  assert.equal(body.product.description_ckb, 'بافەرەکە ڕێڕەوی فیلامێنتەکە نەرم دەکات.');
  // An ordinary product reads no memory at all…
  const plain = await w.measure(`/api/products/${LIVE_PRODUCTS.find((p) => p.id === P.A1)!.slug}`);
  assert.equal(plain.sqls.filter((q) => q.includes('catalog_translation')).length, 0, 'an ordinary product pays nothing');
  // …nor does one the admin form saved: the form marks name and description `imported` with `en` beside them
  // (worker/routes/adminProducts.ts), which is not the import's mark.
  const formMark = { en: { status: 'imported', src_rev: 1 }, ar: { status: 'imported', src_rev: 1 }, ckb: { status: 'imported', src_rev: 1 } };
  w.raw.prepare('UPDATE products SET translation_meta = ? WHERE id = ?').run(JSON.stringify({ name: formMark, description: formMark }), P.A1);
  const saved = await w.measure(`/api/products/${LIVE_PRODUCTS.find((p) => p.id === P.A1)!.slug}`);
  assert.equal(saved.sqls.filter((q) => q.includes('catalog_translation')).length, 0, 'a product saved in the admin form pays nothing');
  assert.ok(saved.prepares <= 23, `${saved.prepares} prepares`);
});
