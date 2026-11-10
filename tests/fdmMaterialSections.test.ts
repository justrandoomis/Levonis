/**
 * THE FILAMENTS FILED ON «مواد FDM» GO TO THEIR OWN SECTION (owner, 2026-11-10: «أقسام مواد FDM» showed PLA
 * with «منتج واحد»; docs/DECISIONS.md row 309).
 *
 * On live, seventeen filaments sat on «مواد FDM» itself — the section that holds PLA, PETG and the rest — so
 * no section listed them: PLA showed PLA Metal alone, while the shop holds seventeen PLA filaments, eSUN PLA+
 * among them. Here:
 *   - migration 0231 moves exactly those products, on a database shaped like live, and nothing else;
 *   - the storefront's own GET /api/catalog/tree counts them in PLA and PETG afterwards, with every ancestor's
 *     total unchanged;
 *   - the product form offers every section under the main one (subSectionOptions), so a filament can be
 *     filed under PLA by hand. The import's half is in tests/catalogImportWriter.test.ts.
 *
 * Run: node --import tsx --test tests/fdmMaterialSections.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { all, asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { catalogRoutes } from '../worker/routes/catalog';
import { subSectionOptions } from '../src/components/adminProducts/subSectionOptions';

const MIGRATION = readFileSync(join(ROOT, 'migrations', '0231_fdm_material_sections.sql'), 'utf8');

/** The live products on «مواد FDM» on 2026-11-10 (GET /api/products?category=cat_materials_fdm). */
const PLA = [
  'esun-pla-plus',
  'bambu-lab-pla-basic-filament',
  'bambu-lab-pla-matte-1kg',
  'bambu-lab-pla-basic-gradient',
  'bambu-lab-pla-silk-plus',
  'bambu-lab-pla-silk-multi-color',
  'bambu-lab-pla-translucent',
  'bambu-lab-pla-galaxy',
  'bambu-lab-pla-marble',
  'bambu-lab-pla-sparkle',
  'bambu-lab-pla-glow',
  'bambu-lab-pla-wood',
  'bambu-lab-pla-tough-plus',
  'bambu-lab-pla-pure',
  'bambu-lab-pla-aero',
  'bambu-lab-pla-cf',
] as const;
const PETG = 'bambu-lab-petg-basic';

/** Live's shape: the import's sections inside «مواد FDM», PLA Metal already in PLA, the rest on the parent. */
function liveShaped(opts: { plaActive?: 0 | 1 } = {}): DatabaseSync {
  const raw = freshDb();
  raw
    .prepare(
      `INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, active) VALUES
        ('cat_bi_pla', 'cat_materials_fdm', 'pla', 'PLA', 'PLA', 'PLA', 1, ?),
        ('cat_bi_petg', 'cat_materials_fdm', 'petg', 'PETG', 'PETG', 'PETG', 2, 1),
        ('cat_bi_fiber', 'cat_materials_fdm', 'fibre-reinforced', 'مواد مقوّاة بالألياف', 'Fibre-reinforced', 'کەرەستەی بەهێزکراو بە ڕیشاڵ', 8, 1)`
    )
    .run(opts.plaActive ?? 1);
  const put = raw.prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, price_iqd, status, stock, options, colors, selling_type, sale_types,
       preorder_transports, images, inventory_mode, category_id, sub_category_id)
     VALUES (?, ?, ?, ?, ?, 24000, 'active', 5, '[]', '[]', 'direct_sale', '["direct_sale"]', '[]', '["https://cdn/x.png"]',
       'VARIANT_COMBINATION', 'cat_materials', ?)`
  );
  const add = (slug: string, sub: string) => put.run(`p_${slug.replace(/-/g, '_')}`, slug, slug, slug, slug, sub);
  for (const slug of PLA) add(slug, 'cat_materials_fdm');
  add(PETG, 'cat_materials_fdm');
  add('pla-metal', 'cat_bi_pla');
  // Not named by 0231: stays where it is.
  add('some-other-filament', 'cat_materials_fdm');
  // PLA-CF is also placed on «مواد مقوّاة بالألياف» (product_catalogs), as on live.
  raw.prepare("INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_bambu_lab_pla_cf', 'cat_bi_fiber', 0)").run();
  return raw;
}

const subOf = (raw: DatabaseSync) =>
  Object.fromEntries(all<{ slug: string; sub_category_id: string }>(raw, 'SELECT slug, sub_category_id FROM products ORDER BY slug').map((r) => [r.slug, r.sub_category_id]));

async function counts(raw: DatabaseSync): Promise<Record<string, number>> {
  const app = stubApp(asD1(raw) as never, null, (a) => a.route('/api/catalog', catalogRoutes));
  const body = await json(await get(app, '/api/catalog/tree'));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 300));
  const out: Record<string, number> = {};
  const walk = (n: { slug: string; product_count: number; children?: unknown[] }) => {
    out[n.slug] = n.product_count;
    for (const c of (n.children ?? []) as Array<typeof n>) walk(c);
  };
  for (const r of body.roots as Array<{ slug: string; product_count: number; children?: unknown[] }>) walk(r);
  return out;
}

test('0231 moves the sixteen PLA filaments and PETG Basic off «مواد FDM», and nothing else', async () => {
  const raw = liveShaped();
  // The owner filed one of them elsewhere after the snapshot: 0231 leaves it there.
  raw.exec("UPDATE products SET sub_category_id = 'cat_bi_fiber' WHERE slug = 'bambu-lab-pla-wood'");
  const before = await counts(raw);
  assert.equal(before.pla, 1, 'the bug: PLA lists PLA Metal alone');
  assert.equal(before.petg ?? 0, 0);

  raw.exec(MIGRATION);
  const after = subOf(raw);
  for (const slug of PLA) {
    if (slug === 'bambu-lab-pla-wood') assert.equal(after[slug], 'cat_bi_fiber', 'a filing the owner changed is the owner’s');
    else assert.equal(after[slug], 'cat_bi_pla', slug);
  }
  assert.equal(after[PETG], 'cat_bi_petg');
  assert.equal(after['pla-metal'], 'cat_bi_pla');
  assert.equal(after['some-other-filament'], 'cat_materials_fdm', 'a product 0231 does not name stays where it is');
  assert.deepEqual(
    all(raw, "SELECT product_id, catalog_id FROM product_catalogs WHERE product_id = 'p_bambu_lab_pla_cf'"),
    [{ product_id: 'p_bambu_lab_pla_cf', catalog_id: 'cat_bi_fiber' }],
    'PLA-CF keeps its fibre placement'
  );

  const now = await counts(raw);
  assert.equal(now.pla, 16, 'PLA Metal and the fifteen moved (Wood went to fibre)');
  assert.equal(now.petg, 1);
  assert.equal(now['fibre-reinforced'], 2, 'PLA-CF by placement, PLA Wood by the owner’s filing');
  assert.equal(now['fdm-materials'], before['fdm-materials'], '«مواد FDM» still counts every one of them');
  assert.equal(now['printing-materials'], before['printing-materials'], '«مواد الطباعة» too');

  // Re-runnable: a second run changes nothing.
  const once = subOf(raw);
  raw.exec(MIGRATION);
  assert.deepEqual(subOf(raw), once);
});

test('0231 moves nothing when its section is missing or switched off', () => {
  const raw = liveShaped({ plaActive: 0 });
  raw.exec(MIGRATION);
  const after = subOf(raw);
  for (const slug of PLA) assert.equal(after[slug], 'cat_materials_fdm', `${slug}: PLA is switched off`);
  assert.equal(after[PETG], 'cat_bi_petg', 'PETG is on, so PETG Basic moves');

  const bare = freshDb();
  bare.exec(MIGRATION);
  assert.equal(all(bare, "SELECT id FROM products WHERE sub_category_id IN ('cat_bi_pla','cat_bi_petg')").length, 0);
});

test('the product form offers every section under the main one, a deeper one with its path', () => {
  const catalogs = [
    { id: 'cat_materials', parent_id: null, active: true, sort: 1, name_ar: 'مواد الطباعة', name_en: 'Printing materials' },
    { id: 'cat_materials_resin', parent_id: 'cat_materials', active: true, sort: 2, name_ar: 'مواد Resin', name_en: 'Resin materials' },
    { id: 'cat_materials_fdm', parent_id: 'cat_materials', active: true, sort: 1, name_ar: 'مواد FDM', name_en: 'FDM Materials' },
    { id: 'cat_bi_petg', parent_id: 'cat_materials_fdm', active: true, sort: 2, name_ar: 'PETG', name_en: 'PETG' },
    { id: 'cat_bi_pla', parent_id: 'cat_materials_fdm', active: true, sort: 1, name_ar: 'PLA', name_en: 'PLA' },
    { id: 'cat_off', parent_id: 'cat_materials_fdm', active: false, sort: 0, name_ar: 'قديم', name_en: 'Old' },
    { id: 'cat_printers', parent_id: null, active: true, sort: 0, name_ar: 'الطابعات', name_en: 'Printers' },
    { id: 'cat_printers_fdm', parent_id: 'cat_printers', active: true, sort: 0, name_ar: 'طابعات FDM', name_en: 'FDM Printers' },
  ];
  const opts = subSectionOptions(catalogs, 'cat_materials', null);
  assert.deepEqual(
    opts.map((o) => [o.id, o.depth, o.label_ar]),
    [
      ['cat_materials_fdm', 1, 'مواد FDM'],
      ['cat_bi_pla', 2, 'مواد FDM ← PLA'],
      ['cat_bi_petg', 2, 'مواد FDM ← PETG'],
      ['cat_materials_resin', 1, 'مواد Resin'],
    ],
    'depth first, in each level’s own order; an inactive section is not offered; another tree is not offered'
  );
  assert.equal(opts.find((o) => o.id === 'cat_bi_pla')?.label_en, 'FDM Materials › PLA');

  // The section a product already carries stays, even inactive or outside this tree, so a save never drops it.
  const kept = subSectionOptions(catalogs, 'cat_materials', 'cat_off');
  assert.deepEqual(kept.at(-1), { id: 'cat_off', depth: 1, label_ar: 'قديم', label_en: 'Old', kept: true });
  assert.equal(subSectionOptions(catalogs, 'cat_materials', 'cat_bi_pla').filter((o) => o.id === 'cat_bi_pla').length, 1);
  // No main section: nothing to offer but what the product carries.
  assert.deepEqual(subSectionOptions(catalogs, null, null), []);
});
