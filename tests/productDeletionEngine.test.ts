/**
 * THE DELETE IS PROVED BY WHAT IS LEFT IN THE DATABASE AND THE BUCKET.
 *
 * "The product disappeared from the admin list" is not evidence and the owner
 * said so explicitly. Every test here builds a REAL product — two options,
 * three colours, images, facets, translations, ledger rows, price history, a
 * favourite, a cart line, a review, catalog placement — against the REAL schema
 * (every migration applied to node:sqlite), deletes it through the production
 * function, and then COUNTS ROWS and LISTS BUCKET KEYS.
 *
 * The five scenarios are the ones the owner named:
 *   1. full product        → every owned table 0, order history intact
 *   2. shared image        → A and B share a key; deleting A must not blank B
 *   3. R2 failure          → rows committed, job pending, retry finishes it
 *   4. old orphans         → the residue earlier deletes left, reported dry-run
 *   5. re-import           → the slug is free and the product can come back
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  collectProductMediaKeys,
  deleteProductPermanently,
  partitionSharedMedia,
  pendingMediaCleanup,
  runMediaCleanup,
  scanProductOrphans,
  type DeletionDb,
} from '../worker/lib/productDeletion';

// ---------------------------------------------------------------------------
//  HARNESS
// ---------------------------------------------------------------------------

/**
 * THE SCHEMA AS THE WORKER ACTUALLY MEETS IT.
 *
 * Foreign keys are OFF by default here, and that is not a shortcut — it is the
 * production condition. Nothing in the Worker issues `PRAGMA foreign_keys`
 * (`grep` finds it only in `scripts/migrate-check.mjs`), so on D1 the declared
 * cascades do not fire and NO ACTION references are never checked. A delete
 * that only passes with enforcement on would be a delete that leaks in
 * production. The last test in this file turns enforcement ON to prove the
 * ordering is ALSO valid there.
 */
function freshSchema(enforceForeignKeys = false): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: enforceForeignKeys });
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

/** A bucket that records what it holds, and can be told to fail on demand. */
class FakeBucket {
  objects = new Map<string, number>();
  failOn = new Set<string>();
  deleted: string[] = [];

  put(key: string, bytes = 1024) {
    this.objects.set(key, bytes);
  }
  async delete(key: string): Promise<void> {
    if (this.failOn.has(key)) throw new Error('R2 unavailable');
    this.objects.delete(key);
    this.deleted.push(key);
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.objects.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).sort();
    return {
      objects: keys.map((key) => ({ key, size: this.objects.get(key) ?? 0 })),
      truncated: false as const,
      cursor: undefined,
      delimitedPrefixes: [],
    };
  }
}

const sqlite = (db: DatabaseSync) => new SqliteD1(db) as unknown as DeletionDb;

/** Fill every NOT NULL column the caller did not name, so a test states only
 *  what it is actually about. */
function insert(db: DatabaseSync, table: string, values: Record<string, unknown>) {
  const cols = db.prepare(`SELECT * FROM pragma_table_info('${table}')`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const row: Record<string, unknown> = { ...values };
  for (const col of cols) {
    if (col.name in row) continue;
    if (col.notnull !== 1 || col.dflt_value !== null) continue;
    row[col.name] = /INT|REAL|NUM/i.test(col.type) ? 0 : `auto-${col.name}`;
  }
  const names = Object.keys(row);
  try {
    db.prepare(
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`
    ).run(...(names.map((n) => row[n]) as never[]));
  } catch (e) {
    throw new Error(`insert into ${table} failed: ${(e as Error).message}`);
  }
}

const count = (db: DatabaseSync, sql: string, ...args: unknown[]) =>
  Number((db.prepare(sql).get(...(args as never[])) as { n: number }).n);

/** Distinguishes fixtures that are rebuilt inside one test (the re-import case). */
let fixtureSeq = 0;

interface Built {
  productId: string;
  orderId: string;
  cartItemId: string;
  keys: string[];
}

/** A product with something in every owned table, plus one past order. */
function buildFullProduct(db: DatabaseSync, id: string, slug: string, extraKey?: string): Built {
  const seq = ++fixtureSeq;
  const gallery = `products/catalog/gallery/${id}-a.webp`;
  const optionImg = `products/catalog/gallery/${id}-opt.webp`;
  const colorImg = `products/catalog/gallery/${id}-col.webp`;
  const jsonImg = extraKey ?? `products/catalog/gallery/${id}-json.webp`;

  insert(db, 'products', {
    id,
    slug,
    name: `Product ${id}`,
    status: 'active',
    images: JSON.stringify([`/files/${jsonImg}`, 'https://bambulab.com/vendor.jpg']),
    usage_guide: JSON.stringify({ steps: [{ image: `/files/${gallery}` }] }),
  });

  insert(db, 'product_option_groups', { id: `${id}-g1`, product_id: id, name_en: 'Model' });
  for (const n of [1, 2]) {
    insert(db, 'product_option_values', {
      id: `${id}-o${n}`,
      product_id: id,
      group_id: `${id}-g1`,
      name_en: `Option ${n}`,
      image: n === 1 ? `/files/${optionImg}` : '',
    });
  }
  for (const n of [1, 2, 3]) {
    insert(db, 'product_colors', {
      id: `${id}-c${n}`,
      product_id: id,
      name_en: `Colour ${n}`,
      hex: '#000000',
      image: n === 1 ? `/files/${colorImg}` : '',
    });
  }
  insert(db, 'product_color_option_links', {
    color_id: `${id}-c1`,
    option_value_id: `${id}-o1`,
    group_id: `${id}-g1`,
  });
  for (const n of [1, 2, 3, 4, 5]) {
    insert(db, 'product_images', {
      id: `${id}-img${n}`,
      product_id: id,
      url: `/files/${gallery}`,
      r2_key: n === 1 ? gallery : '',
    });
  }
  insert(db, 'product_variants', { id: `${id}-v1`, product_id: id, combo_key: 'a|b' });
  insert(db, 'product_catalogs', { product_id: id, catalog_id: 'cat-1', position: seq });
  insert(db, 'product_facets', { product_id: id, facet_id: `facet-${seq}` });
  insert(db, 'product_translations', { product_id: id, field: 'name', source_en: 'x', source_hash: 'h' });
  insert(db, 'inventory_ledger', {
    id: `${id}-led1`,
    product_id: id,
    scope: 'base',
    kind: 'adjust',
    qty: 5,
    idempotency_key: `${id}-idem-${seq}`,
  });
  insert(db, 'price_history', { product_id: id, field: 'regular' });
  insert(db, 'favorites', { user_id: 'user-1', product_id: id });
  insert(db, 'cart_items', { id: `${id}-cart1-${seq}`, user_id: 'user-1', product_id: id, qty: 1 });
  insert(db, 'cart_bundle_choices', { cart_item_id: `${id}-cart1-${seq}`, component_id: 'comp-1', color_id: `${id}-c1` });
  insert(db, 'reviews', { id: `${id}-rev1-${seq}`, user_id: 'user-1', product_id: id, stars: 5 });

  const orderId = `order-${id}-${seq}`;
  insert(db, 'orders', {
    id: orderId,
    user_id: 'user-1',
    address_snapshot: '{}',
    delivery_method_id: 'dm',
    delivery_method_snapshot: '{}',
    payment_method_id: 'cod',
    subtotal_iqd: 1000,
    exchange_rate: 1,
    total_iqd: 1000,
    due_on_delivery_iqd: 1000,
  });
  insert(db, 'order_items', {
    id: `${orderId}-i1`,
    order_id: orderId,
    product_id: id,
    option_id: `${id}-o1`,
    color_id: `${id}-c1`,
    name_snapshot: `Product ${id}`,
    qty: 1,
    unit_price_iqd: 1000,
    line_total_iqd: 1000,
  });

  return { productId: id, orderId, cartItemId: `${id}-cart1-${seq}`, keys: [gallery, optionImg, colorImg, jsonImg] };
}

// ---------------------------------------------------------------------------
//  1 — THE FULL PRODUCT
// ---------------------------------------------------------------------------

test('1. a full product leaves zero owned rows, and its order history survives', async () => {
  const db = freshSchema();
  const built = buildFullProduct(db, 'p-full', 'full-product');
  const bucket = new FakeBucket();
  for (const k of built.keys) bucket.put(k);

  const before = count(db, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', 'p-full');
  assert.equal(before, 5, 'fixture should have five images');

  const result = await deleteProductPermanently(sqlite(db), 'p-full', { newId: () => `job-${Math.random()}` });
  assert.equal(result.product_deleted, true);
  assert.equal(result.already_deleted, false);

  // THE PRODUCT AND EVERY OWNED ROW ARE GONE.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', 'p-full'), 0);
  for (const [table, col] of [
    ['product_images', 'product_id'],
    ['product_option_values', 'product_id'],
    ['product_option_groups', 'product_id'],
    ['product_colors', 'product_id'],
    ['product_variants', 'product_id'],
    ['product_catalogs', 'product_id'],
    ['product_facets', 'product_id'],
    ['product_translations', 'product_id'],
    ['inventory_ledger', 'product_id'],
    ['price_history', 'product_id'],
    ['favorites', 'product_id'],
    ['cart_items', 'product_id'],
    ['reviews', 'product_id'],
  ] as const) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, 'p-full'), 0, `${table} not emptied`);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_color_option_links WHERE color_id = ?', 'p-full-c1'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM cart_bundle_choices WHERE cart_item_id = ?', built.cartItemId), 0);

  // ORDER HISTORY IS NOT TOUCHED. The line stays; only the product link goes.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM orders WHERE id = ?', built.orderId), 1);
  const item = db.prepare('SELECT product_id, option_id, name_snapshot FROM order_items WHERE order_id = ?').get(
    built.orderId
  ) as { product_id: unknown; option_id: unknown; name_snapshot: string };
  assert.equal(item.product_id, null, 'the product link must be nulled');
  assert.equal(item.option_id, 'p-full-o1', 'the frozen option id stays — it describes what was bought');
  assert.equal(item.name_snapshot, 'Product p-full', 'the snapshot is what a receipt reads');
  assert.equal(result.rows_unlinked_by_table.order_items, 1);

  // R2: every owned object removed, the vendor URL never queued.
  const cleanup = await runMediaCleanup(
    { DB: sqlite(db) as never, BUCKET: bucket as never, R2_PUBLIC: bucket as never, R2_PRIVATE: bucket as never },
    result.media_jobs
  );
  assert.deepEqual(cleanup.failed, []);
  assert.equal(bucket.objects.size, 0, 'every owned object should be gone from the bucket');
  assert.ok(!result.media_keys_found.some((k) => k.includes('bambulab.com')), 'a vendor URL is never ours to delete');
  assert.ok(result.rows_deleted_by_table.product_images >= 5);
});

test('1b. pressing Delete a second time is a quiet success, not a 500', async () => {
  const db = freshSchema();
  buildFullProduct(db, 'p-twice', 'twice');
  await deleteProductPermanently(sqlite(db), 'p-twice', { newId: () => 'job-1' });
  const again = await deleteProductPermanently(sqlite(db), 'p-twice', { newId: () => 'job-2' });
  assert.equal(again.already_deleted, true);
  assert.equal(again.product_deleted, false);
  assert.deepEqual(again.rows_deleted_by_table, {});
});

// ---------------------------------------------------------------------------
//  2 — A SHARED IMAGE
// ---------------------------------------------------------------------------

test('2. an image two products share survives the first delete and goes with the second', async () => {
  const db = freshSchema();
  const shared = 'products/catalog/gallery/shared-hero.webp';
  buildFullProduct(db, 'p-a', 'product-a', shared);
  buildFullProduct(db, 'p-b', 'product-b', shared);
  const bucket = new FakeBucket();
  bucket.put(shared);

  const env = { DB: sqlite(db) as never, BUCKET: bucket as never, R2_PUBLIC: bucket as never, R2_PRIVATE: bucket as never };

  const first = await deleteProductPermanently(sqlite(db), 'p-a', { newId: () => `j-a-${Math.random()}` });
  assert.ok(first.r2_objects_shared_skipped.includes(shared), 'the shared key must be reported as skipped');
  assert.ok(!first.media_jobs.some((j) => j.key === shared), 'a shared key is never queued for deletion');
  await runMediaCleanup(env, first.media_jobs);
  assert.ok(bucket.objects.has(shared), 'B still uses this object — it must still exist');

  // B still resolves it.
  const bRow = db.prepare('SELECT images FROM products WHERE id = ?').get('p-b') as { images: string };
  assert.ok(bRow.images.includes(shared));

  const second = await deleteProductPermanently(sqlite(db), 'p-b', { newId: () => `j-b-${Math.random()}` });
  assert.deepEqual(second.r2_objects_shared_skipped, [], 'nothing else references it now');
  assert.ok(second.media_jobs.some((j) => j.key === shared));
  await runMediaCleanup(env, second.media_jobs);
  assert.ok(!bucket.objects.has(shared), 'the last reference is gone, so the object goes');
});

// ---------------------------------------------------------------------------
//  3 — R2 FAILS AFTER THE COMMIT
// ---------------------------------------------------------------------------

test('3. a bucket failure leaves a pending job, never a resurrected product', async () => {
  const db = freshSchema();
  const built = buildFullProduct(db, 'p-r2', 'product-r2');
  const bucket = new FakeBucket();
  for (const k of built.keys) bucket.put(k);
  const doomed = built.keys[0]!;
  bucket.failOn.add(doomed);
  const env = { DB: sqlite(db) as never, BUCKET: bucket as never, R2_PUBLIC: bucket as never, R2_PRIVATE: bucket as never };

  const result = await deleteProductPermanently(sqlite(db), 'p-r2', { newId: () => `j-${Math.random()}` });
  const cleanup = await runMediaCleanup(env, result.media_jobs);

  assert.equal(cleanup.failed.length, 1, 'the failing key is reported, not swallowed');
  assert.equal(cleanup.failed[0]!.key, doomed);

  // THE PRODUCT DOES NOT COME BACK. That is the whole point of committing first.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', 'p-r2'), 0);

  const pending = await pendingMediaCleanup(sqlite(db));
  assert.deepEqual(pending.map((j) => j.key), [doomed]);
  assert.equal(pending[0]!.attempts, 1, 'the attempt was counted');

  // The retry finishes it, and finishing closes the job.
  bucket.failOn.clear();
  const retry = await runMediaCleanup(env, pending);
  assert.deepEqual(retry.failed, []);
  assert.ok(!bucket.objects.has(doomed));
  assert.deepEqual(await pendingMediaCleanup(sqlite(db)), []);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', 'p-r2'), 0);
});

test('3b. a key the bucket never held is a completed job, not a permanent failure', async () => {
  const db = freshSchema();
  const built = buildFullProduct(db, 'p-missing', 'product-missing');
  const bucket = new FakeBucket(); // deliberately empty: the uploads never landed
  const env = { DB: sqlite(db) as never, BUCKET: bucket as never, R2_PUBLIC: bucket as never, R2_PRIVATE: bucket as never };
  const result = await deleteProductPermanently(sqlite(db), 'p-missing', { newId: () => `j-${Math.random()}` });
  const cleanup = await runMediaCleanup(env, result.media_jobs);
  assert.deepEqual(cleanup.failed, []);
  assert.equal(built.keys.length > 0, true);
  assert.deepEqual(await pendingMediaCleanup(sqlite(db)), []);
});

// ---------------------------------------------------------------------------
//  4 — THE RESIDUE EARLIER DELETES LEFT
// ---------------------------------------------------------------------------

test('4. the scanner finds old orphans and, in dry run, removes nothing', async () => {
  const db = freshSchema();
  buildFullProduct(db, 'p-live', 'product-live');

  // Exactly what the old two-statement delete produced: the product row gone,
  // every child still sitting there.
  buildFullProduct(db, 'p-ghost', 'product-ghost');
  db.prepare('DELETE FROM product_catalogs WHERE product_id = ?').run('p-ghost');
  db.prepare('DELETE FROM products WHERE id = ?').run('p-ghost');

  const bucket = new FakeBucket();
  bucket.put('products/catalog/gallery/p-live-a.webp');
  bucket.put('products/catalog/gallery/nobody-references-this.webp', 4096);

  const dry = await scanProductOrphans(sqlite(db), bucket as never, { dryRun: true });
  assert.equal(dry.dry_run, true);
  assert.equal(dry.removed, undefined, 'a dry run must not report removals');

  const tables = new Set(dry.dangling_rows.map((g) => g.table));
  for (const t of ['product_images', 'product_option_values', 'product_colors', 'reviews', 'favorites']) {
    assert.ok(tables.has(t), `${t} orphans should be reported`);
  }
  assert.ok(dry.totals.orphan_rows > 0);
  assert.ok(
    dry.orphan_r2_objects.some((o) => o.key.endsWith('nobody-references-this.webp')),
    'an unreferenced object should be listed'
  );
  assert.ok(
    !dry.orphan_r2_objects.some((o) => o.key.includes('p-live-a')),
    'an object a live product still uses is NOT an orphan'
  );
  assert.equal(dry.totals.orphan_bytes >= 4096, true, 'bytes are reported so the owner can size the cleanup');

  // NOTHING MOVED.
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', 'p-ghost'), 5);
  assert.equal(bucket.objects.size, 2);

  // Only an explicit destructive run clears them — and the live product is untouched.
  const wet = await scanProductOrphans(sqlite(db), bucket as never, { dryRun: false });
  assert.ok(wet.removed);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', 'p-ghost'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', 'p-live'), 5);
  assert.ok(bucket.objects.has('products/catalog/gallery/p-live-a.webp'));
  assert.ok(!bucket.objects.has('products/catalog/gallery/nobody-references-this.webp'));
});

// ---------------------------------------------------------------------------
//  5 — THE PRODUCT CAN COME BACK
// ---------------------------------------------------------------------------

test('5. after a permanent delete the slug is free and the product re-imports cleanly', async () => {
  const db = freshSchema();
  buildFullProduct(db, 'p-reimport', 'a1-mini');
  await deleteProductPermanently(sqlite(db), 'p-reimport', { newId: () => `j-${Math.random()}` });

  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE slug = ?', 'a1-mini'), 0);

  // A NEW id — the importer is not forced to reuse the old UUID — and the old
  // child ids must not collide with the new ones.
  buildFullProduct(db, 'p-reimport-2', 'a1-mini');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE slug = ?', 'a1-mini'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = ?', 'p-reimport-2'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_colors WHERE product_id = ?', 'p-reimport-2'), 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', 'p-reimport-2'), 5);

  // And re-importing under the ORIGINAL id is equally free.
  await deleteProductPermanently(sqlite(db), 'p-reimport-2', { newId: () => `j2-${Math.random()}` });
  buildFullProduct(db, 'p-reimport', 'a1-mini');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', 'p-reimport'), 1);
});

// ---------------------------------------------------------------------------
//  THE MEDIA COLLECTOR ITSELF
// ---------------------------------------------------------------------------

test('media collection reads relations and JSON, and never claims a vendor URL', async () => {
  const db = freshSchema();
  const built = buildFullProduct(db, 'p-media', 'product-media');
  const keys = await collectProductMediaKeys(sqlite(db), 'p-media');
  for (const k of built.keys) assert.ok(keys.has(k), `${k} should be collected`);
  for (const k of keys) {
    assert.ok(!k.startsWith('http'), 'a collected key is never an absolute URL');
    assert.ok(!k.includes('bambulab'), 'a vendor image is not ours to delete');
  }

  const { shared, owned } = await partitionSharedMedia(sqlite(db), 'p-media', keys);
  assert.deepEqual(shared, [], 'nothing else references these');
  assert.equal(owned.length, keys.size);
});

test('a blocked product is refused with a reason, and nothing is deleted', async () => {
  const db = freshSchema();
  buildFullProduct(db, 'p-pooled', 'product-pooled');
  insert(db, 'mystery_pool_entries', { id: 'pool-1', product_id: 'p-pooled' });

  const result = await deleteProductPermanently(sqlite(db), 'p-pooled', { newId: () => 'j' });
  assert.equal(result.blocked?.code, 'PRODUCT_IN_MYSTERY_POOL');
  assert.equal(result.product_deleted, false);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', 'p-pooled'), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?', 'p-pooled'), 5);
});

// ---------------------------------------------------------------------------
//  THE ORDER IS VALID WITH ENFORCEMENT ON TOO
// ---------------------------------------------------------------------------

test('the delete order satisfies the declared foreign keys when they ARE enforced', async () => {
  // D1 does not enforce them, which is why this module deletes explicitly. But
  // "children before parents" has to be true either way, or the same code would
  // fail the day the runtime starts checking — or on any other SQLite.
  const db = freshSchema(true);
  insert(db, 'products', { id: 'p-fk', slug: 'fk', name: 'FK' });
  insert(db, 'product_option_groups', { id: 'p-fk-g', product_id: 'p-fk', name_en: 'G' });
  insert(db, 'product_option_values', { id: 'p-fk-o', product_id: 'p-fk', group_id: 'p-fk-g', name_en: 'O' });
  insert(db, 'product_colors', { id: 'p-fk-c', product_id: 'p-fk', name_en: 'C', hex: '#fff' });
  insert(db, 'product_color_option_links', { color_id: 'p-fk-c', option_value_id: 'p-fk-o', group_id: 'p-fk-g' });
  insert(db, 'product_images', { id: 'p-fk-i', product_id: 'p-fk', url: '/files/products/catalog/gallery/fk.webp' });
  insert(db, 'product_variants', { id: 'p-fk-v', product_id: 'p-fk', combo_key: 'k' });

  const result = await deleteProductPermanently(sqlite(db), 'p-fk', { newId: () => 'job-fk' });
  assert.equal(result.product_deleted, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM products WHERE id = ?', 'p-fk'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_color_option_links WHERE color_id = ?', 'p-fk-c'), 0);
});
