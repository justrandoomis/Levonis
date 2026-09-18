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
import { APEX, asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
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

test('1c. deletion still works during the deploy-before-media-migration window', async () => {
  const db = freshSchema();
  const built = buildFullProduct(db, 'p-no-job-table', 'no-job-table');
  db.exec('DROP TABLE media_cleanup_jobs');
  const bucket = new FakeBucket();
  for (const key of built.keys) bucket.put(key);

  const result = await deleteProductPermanently(sqlite(db), 'p-no-job-table', { newId: () => 'transient-job' });
  assert.equal(result.product_deleted, true);
  const cleanup = await runMediaCleanup(
    { DB: sqlite(db) as never, BUCKET: bucket as never, R2_PUBLIC: bucket as never, R2_PRIVATE: bucket as never },
    result.media_jobs
  );
  assert.deepEqual(cleanup.failed, []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE id = 'p-no-job-table'").get()!.n, 0);
  assert.equal(bucket.objects.size, 0);
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

/**
 * A DESTRUCTIVE ACTION THAT FAILS MUST SAY WHY.
 *
 * The owner pressed Delete on a live product three times and got
 * «Something went wrong. Please try again.» every time — a message that asks
 * somebody to repeat an action that will fail again, for a reason only the logs
 * hold, which the owner does not have.
 *
 * The database's own words are not a leak here: an admin is already authorised
 * to read every row the message could name, and the alternative is a shop whose
 * owner cannot delete a product and cannot find out why.
 */
test('a delete that fails names the reason instead of "something went wrong"', async () => {
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','A','a@x.co','h','admin')");
  const real = asD1(raw);

  // A database that answers every batch with a failure, the way a live D1
  // does when one statement in the batch is refused.
  const db = {
    ...real,
    prepare: (sql: string) => real.prepare(sql),
    batch: async () => {
      throw new Error('D1_ERROR: FOREIGN KEY constraint failed');
    },
  } as unknown as D1Database;

  raw.prepare(
    "INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1','s','N','ن',1000,'active')"
  ).run();

  const a = stubApp(db, { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' }, (x) =>
    x.route('/api/admin/products-v2', adminProductsRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' } });

  const res = await a.request('/api/admin/products-v2/p1', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const body = await json(res);
  assert.equal(res.status, 500);
  assert.equal(body.code, 'DELETE_FAILED');
  assert.match(String(body.error), /FOREIGN KEY constraint failed/, 'the real reason, not a shrug');
  assert.match(String(body.error), /تعذّر حذف المنتج/, 'and in the owner`s language too');
});

/**
 * AND A DELETE THAT SUCCEEDED MUST NEVER REPORT FAILURE.
 *
 * R2, the cache purge and the audit row all run AFTER the commit, when the rows
 * are already gone. One of them throwing used to surface as "delete failed" for
 * a product that no longer exists — so the owner presses the button again, on
 * an id that is not there any more.
 */
test('a bucket that throws after the commit does not turn a finished delete into an error', async () => {
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','A','a@x.co','h','admin')");
  raw.prepare(
    "INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1','s','N','ن',1000,'active')"
  ).run();
  raw.prepare(
    `INSERT INTO product_images (id, product_id, url, alt_en, alt_ar, alt_ckb, sort_order, is_primary, content_type, r2_key, source_url)
     VALUES ('pi1','p1','/files/products/catalog/gallery/a.webp','','','',0,1,'image/webp','products/catalog/gallery/a.webp','')`
  ).run();
  const db = asD1(raw);

  const angryBucket = {
    delete: async () => { throw new Error('R2 is having a day'); },
    put: async () => { throw new Error('R2 is having a day'); },
    get: async () => null,
    head: async () => null,
  } as unknown as R2Bucket;

  const a = stubApp(db, { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' }, (x) =>
    x.route('/api/admin/products-v2', adminProductsRoutes), {
    host: APEX,
    env: { DB: db, BUCKET: angryBucket, R2_PUBLIC: angryBucket, R2_PRIVATE: angryBucket, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });

  const res = await a.request('/api/admin/products-v2/p1?permanent=true', { method: 'DELETE', headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  const body = await json(res);
  assert.equal(res.status, 200, `the rows are gone, so the answer is success: ${JSON.stringify(body)}`);
  assert.equal(body.product_deleted, true);
  assert.ok(Number(body.r2_cleanup_pending) >= 1, 'and the file is reported as still pending, not as done');
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM products WHERE id='p1'").get() as { n: number }).n, 0);
});

/**
 * THE DELETE THAT COULD NOT RUN ON D1, AND THE WILDCARD BUG UNDERNEATH IT.
 *
 * The live shop answered every Delete with
 *
 *     D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR
 *
 * from one clause in `partitionSharedMedia`: `"col" LIKE '%' || ?2 || '%'`.
 * SQLite evaluates `X LIKE Y` as `like(Y, X)`, so the PATTERN is the built
 * string, and D1 caps pattern length far below SQLite's own default — low
 * enough that an ordinary R2 key went over it. Local SQLite has the generous
 * default, so no test against this fixture could ever have reproduced the
 * error; what it CAN prove is that the clause no longer uses a pattern at all.
 *
 * And the second half is a real behavioural bug that local SQLite does show:
 * `_` is a LIKE wildcard, R2 keys may contain one, and a key that matches
 * another product's key by wildcard is reported SHARED — which means its file
 * is left in the bucket forever on every delete.
 */
test('no LIKE pattern is built from a value — that is what D1 refused', () => {
  const src = readFileSync(join(ROOT, 'worker/lib/productDeletion.ts'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(
    code,
    /LIKE\s*'%'\s*\|\|/,
    "a LIKE pattern concatenated from a bound value is what produced 'pattern too complex' on D1"
  );
  assert.match(code, /instr\(/, 'the substring test is instr(), which takes no pattern and has no such limit');
});

test('AN UNDERSCORE IN A KEY IS A LETTER, NOT A WILDCARD', async () => {
  const raw = freshDb();
  // Two products. The second holds a key that differs from the first ONLY where
  // the first has an underscore — so `LIKE` would call them the same file and
  // `instr` does not.
  raw.prepare(
    "INSERT INTO products (id, slug, name, name_ar, price_iqd, status, images) VALUES ('p1','a','A','أ',1,'active', ?)"
  ).run(JSON.stringify(['/files/products/catalog/gallery/ab_cd.webp']));
  raw.prepare(
    "INSERT INTO products (id, slug, name, name_ar, price_iqd, status, images) VALUES ('p2','b','B','ب',1,'active', ?)"
  ).run(JSON.stringify(['/files/products/catalog/gallery/abXcd.webp']));

  const db = new SqliteD1(raw) as unknown as D1Database;
  const { partitionSharedMedia } = await import('../worker/lib/productDeletion');

  // p1's own key, asked of everything that is NOT p1. Only p2 holds anything,
  // and p2's key is a different file.
  const { shared, owned } = await partitionSharedMedia(db, 'p1', ['products/catalog/gallery/ab_cd.webp']);
  assert.deepEqual(shared, [], 'p2 holds a DIFFERENT file — the underscore must not match p2`s X');
  assert.deepEqual(owned, ['products/catalog/gallery/ab_cd.webp'], 'so the file is p1`s to delete');

  // And a genuinely shared key is still detected, which is the property the
  // whole function exists for: a false negative here destroys a live image.
  raw.prepare("UPDATE products SET images = ? WHERE id = 'p2'").run(
    JSON.stringify(['/files/products/catalog/gallery/ab_cd.webp'])
  );
  const second = await partitionSharedMedia(db, 'p1', ['products/catalog/gallery/ab_cd.webp']);
  assert.deepEqual(second.shared, ['products/catalog/gallery/ab_cd.webp'], 'a real share is still a share');
  assert.deepEqual(second.owned, []);
});

/**
 * A SENTENCE IS NOT A FILENAME.
 *
 * `mediaKeyFromRef` hands back whatever it was given when the value is not a
 * URL, and everything it returns is queued for a REAL R2 deletion. A `data:`
 * URI pasted into an image field, and a paragraph of usage-guide prose that
 * happens to mention `/files/`, both became "keys" — 223 characters and 130
 * bytes of Arabic respectively. Nothing downstream asked whether they could
 * possibly name an object this shop stored.
 *
 * They are gated on `isSafeMediaKey` now, the same validator every WRITE
 * already passes. Anything it refuses was never stored under that name, so it
 * cannot be a file to delete.
 */
test('a data: URI and a paragraph of prose never become keys to delete', async () => {
  const raw = freshDb();
  raw.prepare(
    "INSERT INTO products (id, slug, name, name_ar, price_iqd, status, usage_guide) VALUES ('p1','a','A','أ',1,'active', ?)"
  ).run(
    JSON.stringify([
      'افتح الصندوق ثم راجع الصور في /files/ قبل التركيب، وتأكد من محتويات العلبة بالكامل قبل البدء.',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    ])
  );
  raw.prepare(
    `INSERT INTO product_images (id, product_id, url, alt_en, alt_ar, alt_ckb, sort_order, is_primary, content_type, r2_key, source_url)
     VALUES ('pi1','p1','data:image/png;base64,iVBORw0KGgo=','','','',0,1,'image/png','products/catalog/gallery/real.webp','')`
  ).run();

  const db = new SqliteD1(raw) as unknown as D1Database;
  const { collectProductMediaKeys } = await import('../worker/lib/productDeletion');
  const keys = [...(await collectProductMediaKeys(db, 'p1'))];

  assert.deepEqual(
    keys,
    ['products/catalog/gallery/real.webp'],
    'only the real key — the prose and the data: URI are not files'
  );
  for (const k of keys) {
    assert.ok(k.length <= 500 && !k.includes(' '), `"${k.slice(0, 40)}…" is not a plausible R2 key`);
  }
});
