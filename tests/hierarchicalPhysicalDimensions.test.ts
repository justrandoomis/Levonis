import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, dbThrough, asD1, row } from './fixtures/app';
import {
  loadRelationsSnapshot,
  planRelationsWriteFrom,
  planProductSave,
} from '../worker/lib/productPersistence';
import { loadRelationsView } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import {
  PHYSICAL_DIMENSION_FIELDS,
  resolveSelectionPhysicalDimensions,
} from '../worker/lib/physicalDimensions';

const base = {
  net_weight_g: 8000,
  width_mm: 430,
  depth_mm: 400,
  height_mm: 450,
  package_weight_g: 10000,
  package_width_mm: 500,
  package_depth_mm: 550,
  package_height_mm: 590,
};

const relations = () => ({
  inventory_mode: 'BASE',
  groups: [
    {
      id: 'g_model',
      name_en: 'Model',
      sort: 0,
      active: true,
      values: [
        {
          id: 'a1',
          name_en: 'A1',
          sort: 0,
          active: true,
          net_weight_g: 7900,
          package_weight_g: 9200,
          package_height_mm: 600,
        },
        {
          id: 'a1_combo',
          name_en: 'A1 Combo',
          sort: 1,
          active: true,
          net_weight_g: 8400,
          package_weight_g: 12000,
          package_height_mm: 650,
        },
      ],
    },
  ],
  colors: [
    {
      id: 'black',
      name_en: 'Black',
      hex: '#000000',
      active: true,
      option_value_ids: ['a1', 'a1_combo'],
      width_mm: 440,
      package_width_mm: 520,
    },
  ],
  variants: [
    {
      id: 'a1_black',
      option_value_ids: ['a1'],
      color_id: 'black',
      active: true,
      package_weight_g: 9500,
      package_depth_mm: 570,
    },
    {
      id: 'combo_black',
      option_value_ids: ['a1_combo'],
      color_id: 'black',
      active: true,
      package_depth_mm: 620,
    },
  ],
  images: [],
});

async function applyRelations(db: D1Database, productId: string, body: Record<string, unknown>) {
  const snap = await loadRelationsSnapshot(db, productId);
  const plan = await planRelationsWriteFrom(db, snap, body, { money: true });
  assert.ok(plan.stmts, 'relation payload should plan successfully');
  await db.batch(plan.stmts);
}

test('A1/A1 Combo dimensions resolve field-by-field through variant > color > option > product', async () => {
  const raw = freshDb();
  raw.prepare(
    `INSERT INTO products
       (id, slug, name, name_ar, price_iqd, images,
        net_weight_g, width_mm, depth_mm, height_mm,
        package_weight_g, package_width_mm, package_depth_mm, package_height_mm)
     VALUES ('p1','bambu-a1','Bambu A1','A1',100000,'[]',?,?,?,?,?,?,?,?)`
  ).run(...Object.values(base));
  const db = asD1(raw);
  await applyRelations(db, 'p1', relations());

  const productRow = row<Record<string, unknown>>(raw, "SELECT * FROM products WHERE id='p1'")!;
  const doc = parseProductRow(productRow);
  const view = await loadRelationsView(db, 'p1', 'BASE');

  assert.deepEqual(
    resolveSelectionPhysicalDimensions(doc, view, { optionValueIds: ['a1'], colorId: 'black' }),
    {
      net_weight_g: 7900,          // option
      width_mm: 440,               // color
      depth_mm: 400,               // product
      height_mm: 450,              // product
      package_weight_g: 9500,      // exact variant
      package_width_mm: 520,       // color
      package_depth_mm: 570,       // exact variant
      package_height_mm: 600,      // option
    }
  );
  assert.deepEqual(
    resolveSelectionPhysicalDimensions(doc, view, { optionValueIds: ['a1_combo'], colorId: 'black' }),
    {
      net_weight_g: 8400,
      width_mm: 440,
      depth_mm: 400,
      height_mm: 450,
      package_weight_g: 12000,     // variant is NULL, so Combo wins
      package_width_mm: 520,
      package_depth_mm: 620,
      package_height_mm: 650,
    }
  );
});

test('relation save/reload preserves omitted dimension keys and null clears one override', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('p1','p1','P','P',1,'[]')`);
  const db = asD1(raw);
  await applyRelations(db, 'p1', relations());

  const next = relations();
  const a1 = next.groups[0].values[0] as Record<string, unknown>;
  delete a1.package_weight_g;       // preserve 9200
  a1.package_height_mm = null;      // clear/inherit
  const black = next.colors[0] as Record<string, unknown>;
  delete black.package_width_mm;    // preserve 520
  const exact = next.variants[0] as Record<string, unknown>;
  delete exact.package_depth_mm;    // preserve 570
  await applyRelations(db, 'p1', next);

  const option = row<Record<string, unknown>>(raw, "SELECT * FROM product_option_values WHERE id='a1'")!;
  const color = row<Record<string, unknown>>(raw, "SELECT * FROM product_colors WHERE id='black'")!;
  const variant = row<Record<string, unknown>>(raw, "SELECT * FROM product_variants WHERE id='a1_black'")!;
  assert.equal(option.package_weight_g, 9200);
  assert.equal(option.package_height_mm, null);
  assert.equal(color.package_width_mm, 520);
  assert.equal(variant.package_depth_mm, 570);
});

test('0099 exposes the exact eight positive nullable fields at every selector and order snapshot level', () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('pcheck','pcheck','P','P',1,'[]')`);
  for (const table of ['product_option_values', 'product_colors', 'product_variants', 'order_items']) {
    const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    for (const field of PHYSICAL_DIMENSION_FIELDS) assert.ok(names.has(field), `${table}.${field}`);
  }
  assert.throws(() => {
    raw.exec(`INSERT INTO product_variants (id,product_id,combo_key,package_weight_g)
              VALUES ('bad','pcheck','o:x',0)`);
  }, /CHECK constraint failed/);
});

test('0099 admits owned media, quarantines provenance and never merges a stale mirror into relations', () => {
  // Run the final migration over a database stopped immediately before it.
  const raw = dbThrough('0098');
  raw.exec(`INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('p1','p1','P','P',1,'[]')`);
  const mirrorOne = '/files/products/late/gallery/one.webp';
  const mirrorTwo = '/files/products/late/gallery/two.webp';
  const curatedImage = '/files/products/curated/gallery/approved.webp';
  const staleCuratedMirror = '/files/products/curated/gallery/stale.webp';
  const authoredFirst = '/files/products/mirror-primary/gallery/first.webp';
  const authoredPrimary = '/files/products/mirror-primary/gallery/primary.webp';
  const duplicatePrimary = '/files/products/mirror-primary/gallery/duplicate-primary.webp';
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,images)
     VALUES ('late_mirror','late-mirror','Late mirror','متأخر',1,?)`
  ).run(JSON.stringify([
    'https://bad.example/string.jpg',
    mirrorOne,
    { url: 'https://bad.example/object.webp', source_url: 'https://origin.example/object.webp', primary: true },
    { url: mirrorTwo, key: 'products/late/gallery/two.webp', order: 5, content_type: 'image/webp' },
    '/files/products/late/gallery/legacy.png',
  ]));
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,images)
     VALUES ('mirror_primary','mirror-primary','Mirror primary','رئيسي',1,?)`
  ).run(JSON.stringify([
    { url: authoredFirst, order: 0, content_type: 'image/webp' },
    { url: authoredPrimary, order: 50, content_type: 'image/webp', primary: true },
    { url: duplicatePrimary, order: -10, content_type: 'image/webp', primary: true },
  ]));
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,images)
     VALUES ('curated','curated','Curated','منسق',1,?)`
  ).run(JSON.stringify([staleCuratedMirror]));
  raw.prepare(
    `INSERT INTO product_images (id,product_id,url,is_primary,r2_key,content_type)
     VALUES ('curated_primary','curated',?,1,?,'image/webp')`
  ).run(curatedImage, curatedImage.slice('/files/'.length));
  raw.exec(`INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g','p1','Model')`);
  raw.exec(`INSERT INTO product_option_values (id,product_id,group_id,name_en,image)
            VALUES ('owned','p1','g','Owned','/files/products/p1/gallery/owned.webp'),
                   ('external','p1','g','External','https://vendor.example/a.webp'),
                   ('external_existing','p1','g','External existing','https://vendor.example/b.webp'),
                   ('external_active','p1','g','External active','https://vendor.example/c.webp')`);
  raw.exec(`INSERT INTO product_images (id,product_id,url,is_primary)
            VALUES ('hotlink','p1','https://vendor.example/product.jpg',0)`);
  raw.exec(`INSERT INTO product_images (id,product_id,url,is_primary,r2_key,source_url)
            VALUES ('legacy_jpg','p1','/files/products/p1/gallery/legacy.jpg',0,'',''),
                   ('mismatched_webp','p1','/files/products/p1/gallery/canonical.webp',0,'products/p1/gallery/wrong.webp','')`);
  raw.exec(`INSERT INTO product_images (id,product_id,url,is_primary,r2_key,content_type)
            VALUES ('wrong_mime','p1','/files/products/p1/gallery/wrong-mime.webp',0,'products/p1/gallery/wrong-mime.webp','image/png'),
                   ('stray_key','p1','',1,'products/p1/gallery/stray.webp','image/webp'),
                   ('existing_bound','p1','',0,'',''),
                   ('active_different','p1','/files/products/p1/gallery/active.webp',0,'products/p1/gallery/active.webp','image/webp')`);
  raw.exec("UPDATE product_images SET option_value_id='external_existing' WHERE id='existing_bound'");
  raw.exec("UPDATE product_images SET option_value_id='external_active' WHERE id='active_different'");
  applyMigration0099(raw);
  assert.ok(
    (raw.prepare('PRAGMA table_info(media_cleanup_jobs)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'not_before'
    ),
    '0099 installs the durable product-media cleanup grace column'
  );
  assert.ok(
    (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='media_object_guards'").get()),
    '0099 installs the global per-key attach/delete guard'
  );
  assert.ok(
    (raw.prepare('PRAGMA table_info(product_images)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'quarantined'
    ),
    '0099 installs an explicit quarantine state instead of overloading an empty URL'
  );
  assert.equal((row(raw, "SELECT COUNT(*) AS n FROM product_images WHERE option_value_id='owned'")!.n), 1);
  assert.equal((row(raw, "SELECT r2_key FROM product_images WHERE option_value_id='owned'")!.r2_key), 'products/p1/gallery/owned.webp');
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,is_primary FROM product_images WHERE option_value_id='external'"),
    { url: '', r2_key: '', source_url: 'https://vendor.example/a.webp', is_primary: 0 },
    'external selector media is quarantined as provenance instead of hotlinked or discarded'
  );
  assert.equal((row(raw, "SELECT image FROM product_option_values WHERE id='owned'")!.image), '');
  assert.equal((row(raw, "SELECT image FROM product_option_values WHERE id='external'")!.image), '');
  assert.equal(
    row(raw, "SELECT COUNT(*) AS n FROM product_images WHERE option_value_id='external_existing'")!.n,
    1,
    'selector quarantine does not duplicate an existing bound row under another id'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url FROM product_images WHERE id='existing_bound'"),
    { url: '', r2_key: '', source_url: 'https://vendor.example/b.webp' },
    'suppressing a duplicate quarantine row still preserves the drained scalar as provenance'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url FROM product_images WHERE id='active_different'"),
    {
      url: '/files/products/p1/gallery/active.webp',
      r2_key: 'products/p1/gallery/active.webp',
      source_url: '',
    },
    'an active different image must not claim the legacy scalar as its provenance'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,is_primary,option_value_id FROM product_images WHERE id='pi_legacy_option_source_external_active'"),
    {
      url: '',
      r2_key: '',
      source_url: 'https://vendor.example/c.webp',
      is_primary: 0,
      option_value_id: 'external_active',
    },
    'the different external scalar survives in its own inactive provenance row'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,is_primary FROM product_images WHERE id='hotlink'"),
    { url: '', r2_key: '', source_url: 'https://vendor.example/product.jpg', is_primary: 0 }
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,is_primary FROM product_images WHERE id='legacy_jpg'"),
    {
      url: '',
      r2_key: '',
      source_url: '/files/products/p1/gallery/legacy.jpg',
      is_primary: 0,
    },
    'safe local non-WebP media is quarantined until guarded ingest converts it'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key FROM product_images WHERE id='mismatched_webp'"),
    {
      url: '/files/products/p1/gallery/canonical.webp',
      r2_key: 'products/p1/gallery/canonical.webp',
    },
    'a safe local WebP has one canonical key even when the legacy row disagreed'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,source_url,is_primary FROM product_images WHERE id='wrong_mime'"),
    { url: '', r2_key: '', source_url: '/files/products/p1/gallery/wrong-mime.webp', is_primary: 0 },
    'explicit non-WebP metadata quarantines even a local .webp spelling'
  );
  assert.deepEqual(
    row(raw, "SELECT url,r2_key,is_primary FROM product_images WHERE id='stray_key'"),
    { url: '', r2_key: '', is_primary: 0 },
    'the final drain clears key-only rows so they cannot pin primary selection'
  );
  assert.equal(
    row(raw, `SELECT COUNT(*) AS n FROM product_images
               WHERE quarantined = 1
                 AND (trim(url) <> '' OR trim(r2_key) <> '' OR trim(source_url) = '')`)!.n,
    0,
    'every quarantine row is inert and carries non-empty repair provenance'
  );
  assert.equal(
    row(raw, "SELECT quarantined FROM product_images WHERE id='mismatched_webp'")!.quarantined,
    0,
    'a canonical local WebP remains active rather than inheriting quarantine by association'
  );
  assert.deepEqual(
    JSON.parse(String(row(raw, "SELECT images FROM products WHERE id='late_mirror'")!.images)),
    [mirrorOne, mirrorTwo],
    '0099 rebuilds the compatibility mirror from canonical relation rows only'
  );
  assert.deepEqual(
    raw.prepare(
      `SELECT source_url FROM product_images
        WHERE product_id = 'late_mirror' AND quarantined = 1
        ORDER BY source_url`
    ).all().map((entry) => (entry as { source_url: string }).source_url),
    [
      '/files/products/late/gallery/legacy.png',
      'https://bad.example/string.jpg',
      'https://origin.example/object.webp',
    ],
    'mirror-only external/non-WebP entries survive solely as repair provenance'
  );
  assert.equal(
    row(raw, `SELECT COUNT(*) AS n FROM product_images
               WHERE product_id = 'late_mirror' AND quarantined = 0`)!.n,
    2,
    'both string and MediaV2-object local WebP spellings become authoritative rows'
  );
  assert.equal(
    String(row(raw, "SELECT images FROM products WHERE id='late_mirror'")!.images).includes('bad.example'),
    false,
    'the late legacy mirror cannot retain an external hotlink after 0099'
  );
  assert.deepEqual(
    row(raw, `SELECT url, is_primary FROM product_images
               WHERE product_id = 'late_mirror' AND quarantined = 0 AND is_primary = 1`),
    { url: mirrorOne, is_primary: 1 },
    'when an authored primary is quarantined the first canonical image becomes the lead'
  );
  assert.deepEqual(
    JSON.parse(String(row(raw, "SELECT images FROM products WHERE id='mirror_primary'")!.images))[0],
    authoredPrimary,
    'a safe second MediaV2 object keeps its authored primary position'
  );
  assert.deepEqual(
    row(raw, `SELECT url, is_primary FROM product_images
               WHERE product_id = 'mirror_primary' AND is_primary = 1`),
    { url: authoredPrimary, is_primary: 1 },
    'multiple authored primary flags resolve deterministically to the first true entry'
  );
  assert.equal(
    row(raw, `SELECT COUNT(*) AS n FROM product_images
               WHERE product_id = 'mirror_primary' AND is_primary = 1`)!.n,
    1
  );
  assert.deepEqual(
    JSON.parse(String(row(raw, "SELECT images FROM products WHERE id='curated'")!.images)),
    [curatedImage],
    'an existing relation gallery replaces rather than merges a stale compatibility mirror'
  );
  assert.equal(
    (raw.prepare(
      `SELECT COUNT(*) AS n FROM product_images
        WHERE product_id = 'curated' AND (url = ? OR source_url = ?)`
    ).get(staleCuratedMirror, staleCuratedMirror) as { n: number }).n,
    0,
    'a local WebP mirror cannot be resurrected when any authoritative relation row already exists'
  );
});

test('a deploy ahead of the dimension migrations reports stated fields instead of dropping them', async () => {
  const preProductDimensions = dbThrough('0097');
  preProductDimensions.exec(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('p1','p1','P','P',1,'[]')`
  );
  const oldDb = asD1(preProductDimensions);
  const doc = parseProductRow(
    row<Record<string, unknown>>(preProductDimensions, "SELECT * FROM products WHERE id='p1'")!
  );
  doc.dimensions.package_weight_g = 9000;
  await assert.rejects(
    () =>
      planProductSave(oldDb, {
        mode: 'update',
        doc,
        prev: parseProductRow(
          row<Record<string, unknown>>(preProductDimensions, "SELECT * FROM products WHERE id='p1'")!
        ),
        relations: null,
        actor: { adminId: 'admin', money: true },
      }),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'PHYSICAL_DIMENSIONS_MIGRATION_REQUIRED'
  );

  const preHierarchy = dbThrough('0098');
  preHierarchy.exec(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,images) VALUES ('p2','p2','P','P',1,'[]')`
  );
  const hierarchyDb = asD1(preHierarchy);
  const snap = await loadRelationsSnapshot(hierarchyDb, 'p2');
  await assert.rejects(
    () =>
      planRelationsWriteFrom(
        hierarchyDb,
        snap,
        {
          groups: [
            {
              id: 'g',
              name_en: 'Model',
              values: [{ id: 'a1', name_en: 'A1', package_weight_g: 9000 }],
            },
          ],
          colors: [],
          variants: [],
          images: [],
        },
        { money: true }
      ),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      (error as { code?: string }).code === 'PHYSICAL_DIMENSIONS_MIGRATION_REQUIRED'
  );
});

// Kept at the bottom so the ordinary tests above remain pure ESM imports while
// this one can apply exactly one migration file without duplicating the harness.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
function applyMigration0099(raw: ReturnType<typeof freshDb>) {
  raw.exec(readFileSync(join(ROOT, 'migrations/0099_product_media_dimensions.sql'), 'utf8'));
}
