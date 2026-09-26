/**
 * «كل الفئات» — GET /api/catalog/tree (catalog discovery S1).
 *
 * Over the live catalogue of 2026-09-25: four roots hold products, in the
 * owner's sort order, each with its non-empty children — no caps (the home
 * strip's 12/8 do not apply to the whole map), nothing empty, roll-up counts
 * through the one membership relation, and «متوفرة الآن» from the card's own
 * direct-sale count.
 *
 * Run: node --import tsx --test tests/catalogTreeRoute.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { catalogRoutes } from '../worker/routes/catalog';

function world(extra = '') {
  const raw = freshDb();
  seedLiveCatalog(raw);
  if (extra) raw.exec(extra);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/catalog', catalogRoutes));
  return { raw, app };
}

interface Node {
  id: string;
  slug: string;
  path: string;
  product_count: number;
  available_count: number | null;
  description_ar: string;
  description_en: string;
  description_ckb: string;
  hero_image_url: string;
  image_url: string;
  is_printer_catalog: boolean;
  product_type: string | null;
  children: Node[];
}

test('the live map: four roots in the owner\'s order, counts rolled up, children nested', async () => {
  const { app } = world();
  const res = await get(app, '/api/catalog/tree');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /public.*s-maxage=300/, 'viewer-independent, so cached for everyone');
  const body = await json(res);
  const roots = body.roots as Node[];
  assert.deepEqual(
    roots.map((r) => [r.slug, r.product_count, r.available_count]),
    [
      ['printers', 10, 4],
      ['printer-accessories', 1, 1],
      ['printing-materials', 1, 1],
      ['makers-supply', 2, 2],
    ]
  );
  assert.deepEqual(body.totals, { products: 14, available: 8 });
  const printers = roots[0];
  assert.equal(printers.path, '/categories/printers');
  assert.equal(printers.is_printer_catalog, true);
  assert.equal(printers.product_type, 'printer');
  assert.deepEqual(printers.children.map((c) => [c.slug, c.product_count, c.path]), [['fdm-printers', 10, '/categories/printers/fdm-printers']]);
  assert.deepEqual(
    roots[3].children.map((c) => c.slug),
    ['new-products', 'maker-tools'],
    'both non-empty children, in sort order'
  );
});

test('nothing empty is drawn: no Resin, no Laser, no empty accessories root', async () => {
  const { app } = world();
  const body = await json(await get(app, '/api/catalog/tree'));
  const all = (body.roots as Node[]).flatMap((r) => [r, ...r.children]);
  for (const slug of ['resin-printers', 'laser-crafting', 'laser-machines', 'accessories']) {
    assert.equal(all.some((n) => n.slug === slug), false, slug);
  }
});

test('descriptions come from the admin columns (0136 drafts: ar/en, Sorani left for the owner)', async () => {
  const { app } = world();
  const printers = ((await json(await get(app, '/api/catalog/tree'))).roots as Node[])[0];
  assert.equal(printers.description_ar, 'للبيت والعمل، من أول طابعة إلى خط إنتاج صغير.');
  assert.match(printers.description_en, /^For home and work/);
  assert.equal(printers.description_ckb, '', 'never machine-written');
  assert.equal(printers.hero_image_url, '');
  assert.equal(printers.image_url, '');
});

test('no caps: thirteen non-empty roots are all returned', async () => {
  const inserts = Array.from({ length: 13 }, (_, i) => {
    const id = `cat_x${i}`;
    return `INSERT INTO catalogs (id, slug, name_ar, name_en, sort) VALUES ('${id}', 'x-${i}', 'قسم ${i}', 'X ${i}', ${100 + i});
            INSERT INTO products (id, slug, name, description, price_iqd, status, category_id) VALUES ('px${i}', 'px-${i}', 'P ${i}', '', 1000, 'active', '${id}');`;
  }).join('\n');
  const { app } = world(inserts);
  const roots = (await json(await get(app, '/api/catalog/tree'))).roots as Node[];
  assert.equal(roots.length, 17);
});

test('an inactive middle branch lifts its children; an inactive root is not on the map', async () => {
  const { app } = world(`
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort, active) VALUES ('cat_mid', 'cat_makers', 'mid', 'وسط', 'Mid', 70, 0);
    INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, sort) VALUES ('cat_leaf', 'cat_mid', 'deep-leaf', 'ورقة', 'Leaf', 71);
    INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id) VALUES ('p_deep', 'deep', 'Deep', '', 1000, 'active', 'cat_makers', 'cat_leaf');
    UPDATE catalogs SET active = 0 WHERE id = 'cat_pacc';
  `);
  const roots = (await json(await get(app, '/api/catalog/tree'))).roots as Node[];
  assert.equal(roots.some((r) => r.id === 'cat_pacc'), false);
  const makers = roots.find((r) => r.id === 'cat_makers')!;
  assert.equal(makers.product_count, 3, 'the deep product rolls up through the inactive middle');
  assert.ok(makers.children.some((c) => c.slug === 'deep-leaf'), 'and its leaf is lifted to the nearest active ancestor');
});

test('drafts and compositions are never counted', async () => {
  const { app } = world(`
    INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id) VALUES ('p_draft', 'draft', 'Draft', '', 1, 'draft', 'cat_printers', 'cat_printers_fdm');
  `);
  const roots = (await json(await get(app, '/api/catalog/tree'))).roots as Node[];
  assert.equal(roots[0].product_count, 10);
});
