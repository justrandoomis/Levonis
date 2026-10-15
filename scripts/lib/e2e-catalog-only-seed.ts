/**
 * THE CATALOGUE OF scripts/e2e-catalog-only.mjs (DECISIONS rows 239-240).
 *
 * Run once, before `wrangler dev` starts, against the fresh local D1 file the
 * e2e created (every migration already applied, the accounts already in):
 *
 *   node --import tsx scripts/lib/e2e-catalog-only-seed.ts <local-d1.sqlite>
 *
 * It writes the invented world the browser walks through, with the same
 * fixtures the server tests use, so the browser sees exactly what the suite
 * pins:
 *   - the live catalogue (tests/fixtures/liveCatalog.ts), every product but
 *     two published through the REAL V2 writer (tests/fixtures/v2Publish.ts);
 *   - «Levo E2E Catalog Printer», the catalog-only printer: 2 models × 2
 *     colours, never V2-published, every money column on a legacy SENTINEL
 *     (tests/fixtures/catalogOnly.ts) that must never reach the screen;
 *   - «Levo E2E Partial Printer»: published for 2 models × 2 colours, then a
 *     third colour (Jade) added by a structure-only save, so its two SKUs
 *     have no V2 price while the other four sell.
 * It prints one JSON line: the ids, slugs and selections the e2e needs.
 *
 *   node --import tsx scripts/lib/e2e-catalog-only-seed.ts <local-d1.sqlite> --publish <product id>
 *
 * is «the price arrives»: the same real V2 writer publishes that one product
 * (the e2e stops `wrangler dev` around it) and prints `{ published, v2 }`.
 * LOCAL ONLY: it opens the file it is given and nothing else.
 */
import { DatabaseSync } from 'node:sqlite';
import { CAT, CAT_SEL, LEGACY_NUMBERS, publishAllBut, seedCatalogOnlyPrinter } from '../../tests/fixtures/catalogOnly';
import { seedLiveCatalog } from '../../tests/fixtures/liveCatalog';
import { isV2Published, publishV2 } from '../../tests/fixtures/v2Publish';

const file = process.argv[2];
if (!file) throw new Error('usage: e2e-catalog-only-seed.ts <local-d1.sqlite> [--publish <product id>]');

export const PARTIAL = {
  id: 'e2e_partial',
  slug: 'levo-e2e-partial-printer',
  name: 'Levo E2E Partial Printer',
  values: { basic: 'e2e_pp_basic', combo: 'e2e_pp_combo' },
  colors: { black: 'e2e_pp_black', white: 'e2e_pp_white', jade: 'e2e_pp_jade' },
} as const;
const CATALOG_NAME = 'Levo E2E Catalog Printer';

const raw = new DatabaseSync(file);
raw.exec('PRAGMA foreign_keys = ON');

if (process.argv[3] === '--publish') {
  const id = process.argv[4] ?? '';
  // What the owner's «نشر» also brings: the package facts the live H2D row lacks (without them the owner's
  // switch holds it for sale), and the completeness verdict dropped so the next tick computes it afresh —
  // the save's own recompute hook, here.
  raw
    .prepare(
      `UPDATE products SET package_weight_g = COALESCE(package_weight_g, 31000), package_depth_mm = COALESCE(package_depth_mm, 700),
              package_width_mm = COALESCE(package_width_mm, 650), package_height_mm = COALESCE(package_height_mm, 720) WHERE id = ?`
    )
    .run(id);
  raw.prepare('DELETE FROM product_completeness WHERE product_id = ?').run(id);
  await publishV2(raw, id);
  console.log(JSON.stringify({ published: id, v2: isV2Published(raw, id) }));
  raw.close();
  process.exit(0);
}

seedLiveCatalog(raw);
seedCatalogOnlyPrinter(raw);
raw.exec(`UPDATE products SET name = '${CATALOG_NAME}', name_ar = '${CATALOG_NAME}', name_ku = '${CATALOG_NAME}' WHERE id = '${CAT.id}'`);

// The partially priced printer: priced for 2 × 2 by the real writer, Jade added after publication.
const sub = (raw.prepare('SELECT category_id AS c, sub_category_id AS s, brand_id AS b FROM products WHERE id = ?').get(CAT.id) ?? {}) as {
  c?: string;
  s?: string;
  b?: string;
};
raw
  .prepare(
    `INSERT INTO products (id, slug, name, name_ar, name_ku, description, status, price_iqd, stock, selling_type, sale_types, inventory_mode,
                           category_id, sub_category_id, brand_id, spec_fields, created_at)
     VALUES (?, ?, ?, ?, ?, 'An invented printer for the catalog-only browser run.', 'active', 500000, 9, 'direct_sale', '["direct_sale"]', 'BASE',
             ?, ?, ?, '{}', '2026-10-15T08:00:00.000Z')`
  )
  .run(PARTIAL.id, PARTIAL.slug, PARTIAL.name, PARTIAL.name, PARTIAL.name, sub.c ?? null, sub.s ?? null, sub.b ?? null);
raw.exec(`
  INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('e2e_pp_g', '${PARTIAL.id}', 'Model', 0, 1);
  INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, regular_price_iqd)
    VALUES ('${PARTIAL.values.basic}', '${PARTIAL.id}', 'e2e_pp_g', 'Basic', 'أساسي', 'بنەڕەتی', 0, 1, 500000),
           ('${PARTIAL.values.combo}', '${PARTIAL.id}', 'e2e_pp_g', 'Combo', 'كومبو', 'کۆمبۆ', 1, 1, 650000);
  INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active)
    VALUES ('${PARTIAL.colors.black}', '${PARTIAL.id}', 'Black', 'أسود', 'ڕەش', '#111111', 1, 1),
           ('${PARTIAL.colors.white}', '${PARTIAL.id}', 'White', 'أبيض', 'سپی', '#f5f5f5', 2, 1);
`);

const priced = await publishAllBut(raw, [CAT.id]);
// The structure-only save of a new colour: no product_sku_prices row for its SKUs.
raw.exec(`INSERT INTO product_colors (id, product_id, name_en, name_ar, name_ckb, hex, sort, active)
          VALUES ('${PARTIAL.colors.jade}', '${PARTIAL.id}', 'Jade', 'يشمي', 'یەشم', '#00a86b', 3, 1)`);

const slugOf = (id: string) => String((raw.prepare('SELECT slug FROM products WHERE id = ?').get(id) as { slug: string }).slug);
const categorySlug = (raw.prepare('SELECT slug FROM catalogs WHERE id = ?').get(sub.s ?? sub.c ?? '') as { slug?: string } | undefined)?.slug ?? '';
const printers = (raw.prepare('SELECT id FROM products WHERE sub_category_id = ? ORDER BY id').all(sub.s ?? '') as Array<{ id: string }>).map((r) => r.id);
const catalogSlug = slugOf(CAT.id);
raw.close();

console.log(
  JSON.stringify({
    catalog: { id: CAT.id, slug: catalogSlug, name: CATALOG_NAME, sel: { std: CAT_SEL.std, combo: CAT_SEL.combo, grey: CAT_SEL.grey, white: CAT_SEL.white } },
    partial: { ...PARTIAL, slug: PARTIAL.slug },
    category_slug: categorySlug,
    printers,
    priced: priced.length,
    legacy: LEGACY_NUMBERS,
  })
);
