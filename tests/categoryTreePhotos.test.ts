/**
 * THE MAP CARRIES ONE PHOTOGRAPH PER SECTION (speed audit 2026-10-16: on
 * /categories the first banner's picture — the page's largest paint — could
 * only be chosen once a 50-product pool had arrived, 27 KB on the wire and
 * 160 KB of JSON after the 3 KB map; a section the pool missed then asked for
 * its own four products).
 *
 *  - worker/routes/catalog.ts: `GET /api/catalog/tree` gives each section the
 *    lead picture of a product in its subtree — available now first, then
 *    priced, then the shop's order; never a sibling's while another exists —
 *    read off the CARD the storefront draws; past TREE_AVAILABILITY_CAP from
 *    a shortlist of three per section; the public API's sections never;
 *  - src/lib/catalog/explorerModel.ts `bannerRows`: the admin's banner, then
 *    the map's pick, then the pool — which never lends a product the map
 *    already put on screen;
 *  - the explorer asks for the pool only when the map brought a section no
 *    photograph.
 *
 * Run: node --import tsx --test tests/categoryTreePhotos.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { LIVE_PRODUCTS, P, seedLiveCatalog } from './fixtures/liveCatalog';
import { TREE_AVAILABILITY_CAP, assignTreePhotos, buildCatalogTree, cardLeadPhoto, catalogRoutes } from '../worker/routes/catalog';
import { pricingCtxForUser } from '../worker/routes/products';
import { bannerRows, treePhoto } from '../src/lib/catalog/explorerModel';
import type { CatalogTreeNode } from '../src/lib/catalog/types';

interface Node {
  id: string;
  slug: string;
  photo?: { src: string; light_src?: string; product_id: string };
  children: Node[];
  available_count: number | null;
}

const pic = (slug: string) => `/files/products/${slug}.webp`;

function world(prepare: (raw: DatabaseSync) => void = () => {}) {
  const raw = freshDb();
  seedLiveCatalog(raw);
  for (const p of LIVE_PRODUCTS) raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify([pic(p.slug)]), p.id);
  prepare(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/catalog', catalogRoutes));
  return { raw, app };
}
const tree = async (app: ReturnType<typeof world>['app']) => (await json(await get(app, '/api/catalog/tree'))).roots as Node[];
const bySlug = (nodes: Node[], slug: string): Node => {
  for (const n of nodes) {
    if (n.slug === slug) return n;
    const hit = n.children.length ? bySlug(n.children, slug) : null;
    if (hit) return hit;
  }
  return null as unknown as Node;
};
const slugOf = (id: string) => LIVE_PRODUCTS.find((p) => p.id === id)!.slug;

test('every section that holds a photographed product carries one on the map: available now first, off the card', async () => {
  const { app } = world();
  const roots = await tree(app);
  assert.deepEqual(roots.map((r) => [r.slug, slugOf(r.photo!.product_id)]), [
    ['printers', 'bambu-lab-h2s'], // the newest printer with units in stock (H2D, H2C are newer but sold out)
    ['printer-accessories', 'snapmaker-u1-hot-end-nozzle-hardened-steel'],
    ['printing-materials', 'bambu-lab-pla-matte-1kg'],
    ['makers-supply', 'levo-switch-blue-3pin'],
  ]);
  for (const r of roots) assert.equal(r.photo!.src, pic(slugOf(r.photo!.product_id)), r.slug);
  const supply = bySlug(roots, 'makers-supply');
  assert.deepEqual(supply.children.map((c) => slugOf(c.photo!.product_id)), ['levo-switch-blue-3pin', 'levo-metal-key-ring-25-30mm']);
});

test('siblings never share a photograph while another exists; a section with none photographed carries none', async () => {
  // Both makers' products sit in both makers' sections: each section still gets its own.
  const { app } = world((raw) => {
    const place = raw.prepare('INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES (?, ?, ?)');
    place.run('prd_0ce55586ba5e4751bc84', 'cat_makers_tools', 100); // the switch, also among the tools
    place.run('prd_94dedaeb082243efb43a', 'cat_makers_new', 101); // the key ring, also among the new
    raw.prepare(`UPDATE products SET images = '[]' WHERE category_id = 'cat_materials'`).run();
  });
  const roots = await tree(app);
  const kids = bySlug(roots, 'makers-supply').children.map((c) => c.photo?.product_id);
  assert.equal(new Set(kids).size, kids.length, `distinct: ${kids.join(', ')}`);
  assert.equal(bySlug(roots, 'printing-materials').photo, undefined, 'no photograph is invented');
});

test('the light-theme main image rides along; a product\'s non-canonical picture never does', async () => {
  const { app } = world((raw) => {
    raw.prepare('UPDATE products SET light_image = ? WHERE id = ?').run('/files/products/h2s-light.webp', P.H2S);
    raw.prepare('UPDATE products SET images = ? WHERE id = ?').run(JSON.stringify(['https://store.example/h2s.jpg']), P.A1);
  });
  const printers = bySlug(await tree(app), 'printers');
  assert.deepEqual(printers.photo, { src: pic('bambu-lab-h2s'), light_src: '/files/products/h2s-light.webp', product_id: P.H2S });
});

test('past the availability cap the map still has its photographs, from a short list per section', async () => {
  const { app } = world((raw) => {
    const ins = raw.prepare(
      `INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id, selling_type, stock, display_order, created_at)
       VALUES (?, ?, ?, '', 1000, 'active', 'cat_printers', 'cat_printers_fdm', 'direct_sale', 0, 100, '2026-01-01T00:00:00.000Z')`
    );
    for (let i = 0; i <= TREE_AVAILABILITY_CAP; i++) ins.run(`prd_fill_${i}`, `fill-${i}`, `Filler ${i}`);
  });
  const roots = await tree(app);
  assert.equal(bySlug(roots, 'printers').available_count, null, 'the counts are unknown past the cap');
  assert.ok(roots.every((r) => r.photo?.src.startsWith('/files/products/')), JSON.stringify(roots.map((r) => r.photo)));
  // Priced first, then the shop's order: the newest printer, stock unknown.
  assert.equal(slugOf(bySlug(roots, 'printers').photo!.product_id), 'bambu-lab-h2d');
});

test('the public API\'s sections are described without them', async () => {
  const { raw } = world();
  const { roots } = await buildCatalogTree(asD1(raw), pricingCtxForUser(asD1(raw), null));
  assert.ok(roots.every((r) => r.photo === undefined));
});

test('assignTreePhotos: in order, a fresh product per sibling, a taken one only when there is no other, groups apart', () => {
  const node = (id: string, children: CatalogTreeNode[] = []) => ({ id, children }) as unknown as CatalogTreeNode;
  const roots = [node('a', [node('a1'), node('a2'), node('a3')]), node('b')];
  const member: Record<string, string[]> = { p1: ['a', 'a1', 'a2', 'b'], p2: ['a', 'a1'], p3: ['a', 'a3'], p4: ['b'] };
  const photo = (id: string) => (id === 'p2' ? null : { src: `/files/${id}.webp` });
  assignTreePhotos(roots, ['p1', 'p2', 'p3', 'p4'], (id) => new Set(member[id]), photo);
  const got = (n: CatalogTreeNode) => n.photo?.product_id;
  assert.equal(got(roots[0]), 'p1');
  assert.equal(got(roots[1]), 'p4', 'b does not repeat a\'s p1');
  assert.deepEqual(roots[0].children!.map(got), ['p1', 'p1', 'p3'], 'a2 has only p1 (taken by a1): used rather than bare; p2 has no photograph');
});

test('cardLeadPhoto: the explicit primary, else the first published image, else the first by order; the light twin when it differs', () => {
  assert.deepEqual(cardLeadPhoto({ media: [{ url: '/files/a.webp', order: 0 }, { url: '/files/b.webp', primary: true, order: 1 }], images: ['/files/a.webp'] }), { src: '/files/b.webp' });
  assert.deepEqual(cardLeadPhoto({ images: ['', '/files/c.webp'] }), { src: '/files/c.webp' });
  assert.deepEqual(cardLeadPhoto({ media: [{ url: '/files/z.webp', order: 2 }, { url: '/files/y.webp', order: 1 }] }), { src: '/files/y.webp' });
  assert.deepEqual(cardLeadPhoto({ images: ['/files/c.webp'], light_image: ' /files/c-light.webp ' }), { src: '/files/c.webp', light: '/files/c-light.webp' });
  assert.equal(cardLeadPhoto({ images: [], media: [] }), null);
});

test('bannerRows: the admin\'s banner, then the map\'s pick, then the pool — which never lends what the map put on screen', () => {
  const n = (id: string, extra: Partial<CatalogTreeNode> = {}) =>
    ({ id, slug: id, product_count: 2, children: [], hero_image_url: '', image_url: '', hero_light_image_url: '', ...extra }) as unknown as CatalogTreeNode;
  const pool = [
    { id: 'p1', category_id: 'c', images: ['/files/p1.webp'], direct_stock_available: 1 },
    { id: 'p2', category_id: 'c', images: ['/files/p2.webp'], direct_stock_available: 1 },
  ];
  const rows = bannerRows(
    [
      n('a', { hero_image_url: '/files/banner-a.webp', photo: { src: '/files/x.webp', product_id: 'x' } }),
      n('b', { photo: { src: '/files/p1.webp', light_src: '/files/p1-light.webp', product_id: 'p1' } }),
      n('c'),
    ],
    pool
  );
  assert.equal(rows[0].photo?.productPhoto, false, 'the admin\'s banner wins');
  assert.deepEqual(rows[1].photo, { src: '/files/p1.webp', lightSrc: '/files/p1-light.webp', productPhoto: true, productId: 'p1' });
  assert.equal(rows[2].photo?.productId, 'p2', 'the pool skips p1, which the map already put on b');
  assert.equal(treePhoto({ photo: undefined }), null, 'an answer cached before the field: the old way');
});

test('the explorer asks for the pool only when the map brought a section no photograph', () => {
  const page = readFileSync(join(ROOT, 'src/pages/CategoriesExplorer.tsx'), 'utf8');
  assert.match(page, /const needsPool = useMemo\(\(\) => bannerRows\(roots, \[\]\)\.some\(\(r\) => !r\.photo\), \[roots\]\);/);
  assert.match(page, /if \(!needsPool\) return;\s+let alive = true;\s+loadPhotoPool\(\)/);
  assert.match(page, /useBannerPhotos\(baseRows, !needsPool \|\| poolSettled\)/);
  assert.match(readFileSync(join(ROOT, 'worker/routes/catalog.ts'), 'utf8'), /buildCatalogTree\(c\.env\.DB, pricingCtx\(c\), \{ photos: true \}\)/);
});
