/**
 * DELETING ONE IMAGE FROM A SAVED PRODUCT MUST NOT LEAVE ITS BYTES IN R2.
 *
 * `worker/lib/productPersistence.ts` removed the `product_images` row whenever
 * the payload stopped naming it, and contained no reference to R2,
 * `deleteMediaObject`, `media_cleanup_jobs` or `file_objects` — a grep count of
 * zero. The object stayed in the bucket for ever and the owner paid for it
 * every month.
 *
 * The owner chose a QUEUE over an immediate delete, and their reasoning is the
 * specification these tests check:
 *
 *   «with a queue an object may survive a few minutes after the save, but an
 *    image that is still displayed can never be deleted; with an immediate
 *    delete, any error means a broken image on a live page»
 *
 * So the properties under test are: queued only AFTER the save commits;
 * re-checked at the moment the worker runs rather than the moment it was
 * queued; a bounded retry with a dead-letter a human can read; the
 * `file_objects` row dated rather than dropped; and an external hotlink never
 * queued at all.
 *
 * Run: node --import tsx --test tests/imageDeleteCleanup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  MEDIA_CLEANUP_MAX_ATTEMPTS,
  MEDIA_DETACH_REASON,
  detachedMediaKey,
  enqueueMediaDetach,
  runGuardedMediaCleanup,
  type DetachDb,
} from '../worker/lib/mediaRefs';
import {
  loadRelationsSnapshot,
  planRelationsWriteFrom,
  saveProductAtomic,
  type ProductSavePlan,
} from '../worker/lib/productPersistence';

function freshSchema(): DatabaseSync {
  // Foreign keys off — the production condition; see mediaReferences.test.ts.
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

/** A bucket that records what it holds and can be told to refuse a key. */
class FakeBucket {
  objects = new Map<string, number>();
  failOn = new Set<string>();
  put(key: string, bytes = 1024) {
    this.objects.set(key, bytes);
  }
  async delete(key: string): Promise<void> {
    if (this.failOn.has(key)) throw new Error('R2 unavailable');
    this.objects.delete(key);
  }
}

const d1 = (db: DatabaseSync) => new SqliteD1(db) as unknown as DetachDb;
const envOf = (db: DatabaseSync, bucket: FakeBucket) =>
  ({ DB: d1(db), BUCKET: bucket } as never);

const jobsOf = (db: DatabaseSync) =>
  db.prepare('SELECT object_key, state, attempts, reason, last_error FROM media_cleanup_jobs ORDER BY object_key').all() as Array<{
    object_key: string;
    state: string;
    attempts: number;
    reason: string;
    last_error: string;
  }>;

const KEY_A = 'products/catalog/gallery/detachedone01.webp';
const KEY_B = 'products/catalog/gallery/detachedtwo02.webp';

// ---------------------------------------------------------------------------
//  WHAT MAY BE QUEUED AT ALL
// ---------------------------------------------------------------------------

/**
 * THE THREE HOTLINKS THAT ARE NOT OURS.
 *
 * The live catalogue holds image rows whose `url` is an absolute link to
 * another server with an empty `r2_key`. Deleting somebody else's file is not
 * something we can do; queueing it would put a job in the table that can never
 * succeed and would dead-letter for no reason at all.
 */
test('an external hotlink is never a key we may delete', () => {
  /**
   * These three are not invented. They are the `media` entries with an empty
   * `key` on the one live product, read from
   * `GET https://levonis-iq.com/api/products` (anonymous, public) while this
   * was written. Each one is a file on somebody else's CDN.
   */
  for (const url of [
    'https://static.insales-cdn.com/images/products/1/8093/899432349/bambu-lab-a1-1-pc-700543-en.png',
    'https://3d.nice-cdn.com/upload/image/product/large/default/47083_59cd2505.768x768.png',
    'https://cdn-reichelt.de/bilder/web/xxl_ws/I200/BAMBU_LAB_A1_COMBO_ANW_01.png',
  ]) {
    assert.equal(detachedMediaKey({ r2_key: '', url }), null, `${url} is not ours to delete`);
  }

  assert.equal(detachedMediaKey({ r2_key: null, url: 'http://images.vendor.iq/x.png' }), null);
  assert.equal(detachedMediaKey({ r2_key: '', url: '//evil.example/x.jpg' }), null);
  assert.equal(detachedMediaKey({ r2_key: '', url: '' }), null);

  // Ours, in each of the shapes the columns actually hold.
  assert.equal(detachedMediaKey({ r2_key: KEY_A, url: '' }), KEY_A);
  assert.equal(detachedMediaKey({ r2_key: '', url: `/files/${KEY_A}` }), KEY_A);
  assert.equal(detachedMediaKey({ r2_key: '', url: `https://levonis-iq.com/files/${KEY_A}` }), KEY_A);
});

test('enqueue writes one pending job per key, and is idempotent', async () => {
  const db = freshSchema();
  const queued = await enqueueMediaDetach(d1(db), [KEY_A, KEY_B, KEY_A], 'p1');
  assert.deepEqual(queued, [KEY_A, KEY_B], 'a repeated key is queued once');

  // The partial unique index on (object_key) WHERE state = 'pending' is what
  // makes a second save of the same product harmless.
  await enqueueMediaDetach(d1(db), [KEY_A], 'p1');
  const jobs = jobsOf(db);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.state), ['pending', 'pending']);
  assert.deepEqual(jobs.map((j) => j.reason), [MEDIA_DETACH_REASON, MEDIA_DETACH_REASON]);
});

test('enqueue refuses a value that is not a safe object key', async () => {
  const db = freshSchema();
  const queued = await enqueueMediaDetach(d1(db), ['../../etc/passwd', '', 'https://x.example/a.jpg'], 'p1');
  assert.deepEqual(queued, []);
  assert.equal(jobsOf(db).length, 0);
});

// ---------------------------------------------------------------------------
//  THE RE-CHECK — THE WHOLE REASON THE OWNER CHOSE A QUEUE
// ---------------------------------------------------------------------------

/**
 * Between the save and the sweep, the same picture was attached somewhere
 * else — moved onto another product, or pasted into a home banner. "It was
 * unreferenced when we queued it" is not the question the bucket delete
 * answers. The bytes must survive, and the job must close rather than linger.
 */
test('a key that was re-attached before the sweep is NOT deleted', async () => {
  const db = freshSchema();
  const bucket = new FakeBucket();
  bucket.put(KEY_A);
  bucket.put(KEY_B);
  await enqueueMediaDetach(d1(db), [KEY_A, KEY_B], 'p1');

  // KEY_A came back: an admin dropped it into the home page after the save.
  db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
    'homeBanners',
    JSON.stringify({ hero: [{ id: 'b1', image: `/files/${KEY_A}`, link: '' }] })
  );

  const out = await runGuardedMediaCleanup(envOf(db, bucket));
  assert.equal(out.ran, true, out.refusals.join(' | '));
  assert.deepEqual(out.still_referenced, [KEY_A]);
  assert.deepEqual(out.deleted, [KEY_B]);
  assert.ok(bucket.objects.has(KEY_A), 'an image a live page still shows must survive its own queued job');
  assert.ok(!bucket.objects.has(KEY_B));

  const jobs = Object.fromEntries(jobsOf(db).map((j) => [j.object_key, j.state]));
  assert.equal(jobs[KEY_A], 'skipped_shared', 'the job closes; it must not linger and retry for ever');
  assert.equal(jobs[KEY_B], 'done');
});

test('nothing is deleted while the reference set is unprovable', async () => {
  const db = freshSchema();
  const bucket = new FakeBucket();
  bucket.put(KEY_A);
  await enqueueMediaDetach(d1(db), [KEY_A], 'p1');
  db.exec(`CREATE TABLE promo_banners (id TEXT PRIMARY KEY, image_key TEXT NOT NULL DEFAULT '')`);

  const out = await runGuardedMediaCleanup(envOf(db, bucket));
  assert.equal(out.ran, false);
  assert.deepEqual(out.deleted, []);
  assert.ok(out.refusals.join(' ').includes('promo_banners.image_key'));
  assert.ok(bucket.objects.has(KEY_A), 'an unprovable reference set may not authorise a delete');
  assert.equal(jobsOf(db)[0]?.state, 'pending', 'the job waits; it is not lost and not a silent no-op');
});

// ---------------------------------------------------------------------------
//  THE BOUND AND THE DEAD LETTER
// ---------------------------------------------------------------------------

test('a failing job retries, then dead-letters instead of retrying for ever', async () => {
  const db = freshSchema();
  const bucket = new FakeBucket();
  bucket.put(KEY_A);
  bucket.failOn.add(KEY_A);
  await enqueueMediaDetach(d1(db), [KEY_A], 'p1');

  for (let i = 1; i < MEDIA_CLEANUP_MAX_ATTEMPTS; i += 1) {
    const out = await runGuardedMediaCleanup(envOf(db, bucket));
    assert.equal(out.retrying.length, 1, `attempt ${i} should stay retryable`);
    assert.equal(out.dead_lettered.length, 0);
    assert.equal(jobsOf(db)[0]?.state, 'pending');
    assert.equal(jobsOf(db)[0]?.attempts, i);
  }

  const final = await runGuardedMediaCleanup(envOf(db, bucket));
  assert.equal(final.dead_lettered.length, 1);
  assert.equal(final.dead_lettered[0]?.key, KEY_A);
  const job = jobsOf(db)[0]!;
  assert.equal(job.state, 'failed', 'a human has to be able to find it');
  assert.equal(job.attempts, MEDIA_CLEANUP_MAX_ATTEMPTS);
  assert.ok(job.last_error.includes('R2 unavailable'), 'the reason is kept, not swallowed');

  // And it is out of the queue: the next sweep does not pick it up again.
  const after = await runGuardedMediaCleanup(envOf(db, bucket));
  assert.equal(after.attempted, 0);
});

// ---------------------------------------------------------------------------
//  THE AUDIT TRAIL SURVIVES THE BYTES
// ---------------------------------------------------------------------------

test('the file_objects row is dated, not dropped', async () => {
  const db = freshSchema();
  const bucket = new FakeBucket();
  bucket.put(KEY_A);
  db.prepare(
    `INSERT INTO file_objects (object_key, visibility, domain, owner_id, mime_type, byte_size, original_name)
     VALUES (?, 'public', 'products', 'admin-1', 'image/webp', 1024, 'hero.webp')`
  ).run(KEY_A);
  await enqueueMediaDetach(d1(db), [KEY_A], 'p1');

  const out = await runGuardedMediaCleanup(envOf(db, bucket));
  assert.deepEqual(out.deleted, [KEY_A]);

  const row = db.prepare('SELECT owner_id, original_name, deleted_at FROM file_objects WHERE object_key = ?').get(KEY_A) as
    | { owner_id: string; original_name: string; deleted_at: string | null }
    | undefined;
  assert.ok(row, 'the ledger row must survive — who uploaded what and when stays auditable');
  assert.equal(row!.owner_id, 'admin-1');
  assert.equal(row!.original_name, 'hero.webp');
  assert.ok(row!.deleted_at, 'and it must carry the date the object went');
});

// ---------------------------------------------------------------------------
//  THE ORDERING: A ROLLED-BACK SAVE MUST NOT HAVE QUEUED ANYTHING
// ---------------------------------------------------------------------------

/**
 * The plan carries the keys; `saveProductAtomic` queues them ONLY after
 * `db.batch` has returned. Both halves are driven through the real function:
 * a batch that commits must leave the jobs behind it, and a batch that throws
 * must leave nothing at all — because a rolled-back save leaves the
 * `product_images` row in place and the product still showing the picture.
 */
function planOf(statements: D1PreparedStatement[], detachedMedia: string[]): ProductSavePlan {
  return {
    productId: 'p1',
    mode: 'update',
    statements,
    doc: null,
    relations: null,
    cells: null,
    catalogIds: null,
    priceHistory: [],
    hashtagsRegistered: 0,
    hashtagsAdded: [],
    detachedMedia,
    searchTokens: 0,
    translations: null,
    costRefused: [],
    warnings: [],
    money: false,
    actorId: 'admin-1',
  };
}

test('saveProductAtomic queues the detached keys once the batch has committed', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;
  db.prepare("INSERT INTO products (id, name, slug, price_iqd) VALUES ('p1','n','s',1000)").run();

  await saveProductAtomic(
    dbx,
    planOf([dbx.prepare("UPDATE products SET name = 'n2' WHERE id = 'p1'")], [KEY_A])
  );

  const jobs = jobsOf(db);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.object_key, KEY_A);
  assert.equal(jobs[0]?.state, 'pending');
  assert.equal(jobs[0]?.reason, MEDIA_DETACH_REASON);
});

test('post-commit audit failures never turn a committed product save into a rejection', async () => {
  const db = freshSchema();
  const real = new SqliteD1(db);
  db.prepare("INSERT INTO products (id, name, slug, price_iqd) VALUES ('p1','before','s',1000)").run();

  let refusedAudits = 0;
  const auditFailingDb = {
    prepare(sql: string) {
      if (/INSERT\s+INTO\s+audit_log/i.test(sql)) {
        refusedAudits += 1;
        throw new Error('audit storage unavailable');
      }
      return real.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      return real.batch(statements as never);
    },
  } as unknown as D1Database;

  const plan = planOf(
    [real.prepare("UPDATE products SET name = 'committed' WHERE id = 'p1'") as unknown as D1PreparedStatement],
    []
  );
  // Exercise both caller-supplied audit rows and the automatic relations row.
  plan.relations = {
    mode: 'BASE',
    summary: {
      inventory_mode: 'BASE', groups: 0, values: 0, colors: 0, links: 0,
      variants: 0, images: 0, primary_image: null, facets: 'preserved', cost_written: false,
    },
    requested: {} as never,
  };

  await saveProductAtomic(auditFailingDb, plan, [{ action: 'product.test', detail: { source: 'test' } }]);

  assert.equal((db.prepare("SELECT name FROM products WHERE id='p1'").get() as { name: string }).name, 'committed');
  assert.equal(refusedAudits, 2, 'both post-commit audit attempts were best-effort');
});

test('a save that rolls back queues nothing', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;

  await assert.rejects(
    saveProductAtomic(
      dbx,
      // A statement the schema refuses: the batch rolls back, so the image row
      // the payload dropped is still there and still on the product's page.
      planOf([dbx.prepare('INSERT INTO products (id) VALUES (?)').bind('p1')], [KEY_A])
    )
  );

  assert.equal(jobsOf(db).length, 0, 'a rolled-back save must not have queued a deletion');
});

// ---------------------------------------------------------------------------
//  THE DEFECT SITE ITSELF — where a dropped row's key is collected
// ---------------------------------------------------------------------------

/**
 * THE TWO TESTS ABOVE PROVE THE ENQUEUE, NOT THE COLLECTION.
 *
 * `planOf` hands `saveProductAtomic` a plan whose `detachedMedia` is already
 * populated by hand, so both of them would keep passing if the loop in
 * `planRelationsWriteFrom` that FILLS that array were deleted outright — the
 * R2 leak would come back with a green build and nothing to read it off. This
 * drives the real planner against the real schema instead, and it is also the
 * only place that proves the hotlink exclusion where it actually matters: not
 * that `detachedMediaKey` returns null in isolation, but that the planner
 * never puts somebody else's file into the queue.
 */
test('the planner collects the keys of the image rows a save drops — and only ours', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;

  db.prepare("INSERT INTO products (id, slug, name, price_iqd) VALUES ('p1', 'p1', 'P', 1000)").run();
  const rows: Array<[string, string, string]> = [
    // ours, named by the canonical column (0048)
    ['pi_one', KEY_A, `/files/${KEY_A}`],
    // ours, but an older row that carries only the delivery path
    ['pi_two', '', `/files/${KEY_B}`],
    // NOT ours: the live catalogue's hotlink shape — absolute url, empty key
    ['pi_three', '', 'https://static.insales-cdn.com/images/products/1/8093/899432349/bambu-lab-a1-1-pc-700543-en.png'],
  ];
  for (const [id, key, url] of rows) {
    db.prepare(
      "INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES (?, 'p1', ?, ?, 0)"
    ).run(id, key, url);
  }

  const snap = await loadRelationsSnapshot(dbx, 'p1');
  assert.equal(snap.existingImages.length, 3, 'the snapshot must see all three rows');

  // The payload keeps NONE of them — the admin deleted every picture and saved.
  const plan = await planRelationsWriteFrom(dbx, snap, { images: [] }, { money: true });
  assert.deepEqual(plan.errors, [], 'the plan must be valid');
  assert.deepEqual(
    [...(plan.stmts ? plan.detachedMedia : [])].sort(),
    [KEY_A, KEY_B].sort(),
    'exactly the two keys we own — the external hotlink is not ours to delete'
  );
});

test('an image the payload KEEPS is never queued for deletion', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;

  db.prepare("INSERT INTO products (id, slug, name, price_iqd) VALUES ('p1', 'p1', 'P', 1000)").run();
  db.prepare("INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES ('pi_one', 'p1', ?, ?, 0)")
    .run(KEY_A, `/files/${KEY_A}`);
  db.prepare("INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES ('pi_two', 'p1', ?, ?, 1)")
    .run(KEY_B, `/files/${KEY_B}`);

  const snap = await loadRelationsSnapshot(dbx, 'p1');
  const plan = await planRelationsWriteFrom(
    dbx,
    snap,
    { images: [{ id: 'pi_one', url: `/files/${KEY_A}`, r2_key: KEY_A, is_primary: 1 }] },
    { money: true }
  );
  assert.deepEqual(plan.errors, [], 'the plan must be valid');
  assert.deepEqual(plan.stmts ? plan.detachedMedia : ['unplanned'], [KEY_B], 'only the dropped row\'s key');
});

test('replacing an image object under the same relation id detaches and queues the old key', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;

  db.prepare("INSERT INTO products (id, slug, name, price_iqd) VALUES ('p1', 'p1', 'P', 1000)").run();
  db.prepare("INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES ('pi_one', 'p1', ?, ?, 0)")
    .run(KEY_A, `/files/${KEY_A}`);

  const snap = await loadRelationsSnapshot(dbx, 'p1');
  const relationPlan = await planRelationsWriteFrom(
    dbx,
    snap,
    { images: [{ id: 'pi_one', url: `/files/${KEY_B}`, r2_key: KEY_B, is_primary: 1 }] },
    { money: true }
  );
  assert.deepEqual(relationPlan.errors, [], 'the replacement must be valid');
  assert.deepEqual(
    relationPlan.stmts ? relationPlan.detachedMedia : ['unplanned'],
    [KEY_A],
    'preserving the row id must not hide the object it stopped referencing'
  );

  if (!relationPlan.stmts) assert.fail('the replacement was not planned');
  await saveProductAtomic(dbx, planOf(relationPlan.stmts, relationPlan.detachedMedia));

  assert.deepEqual(jobsOf(db).map((job) => job.object_key), [KEY_A]);
  const stored = db.prepare("SELECT r2_key, url FROM product_images WHERE id = 'pi_one'").get() as {
    r2_key: string;
    url: string;
  };
  assert.equal(stored.r2_key, KEY_B);
  assert.equal(stored.url, `/files/${KEY_B}`);
});

test('saving the same canonical image key under the same id detaches nothing', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;

  db.prepare("INSERT INTO products (id, slug, name, price_iqd) VALUES ('p1', 'p1', 'P', 1000)").run();
  db.prepare("INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES ('pi_one', 'p1', ?, ?, 0)")
    .run(KEY_A, `/files/${KEY_A}`);

  const snap = await loadRelationsSnapshot(dbx, 'p1');
  const relationPlan = await planRelationsWriteFrom(
    dbx,
    snap,
    { images: [{ id: 'pi_one', url: `/files/${KEY_A}`, r2_key: KEY_A, is_primary: 1 }] },
    { money: true }
  );
  assert.deepEqual(relationPlan.errors, []);
  assert.deepEqual(relationPlan.stmts ? relationPlan.detachedMedia : ['unplanned'], []);

  if (!relationPlan.stmts) assert.fail('the unchanged image was not planned');
  await saveProductAtomic(dbx, planOf(relationPlan.stmts, relationPlan.detachedMedia));
  assert.deepEqual(jobsOf(db), [], 'an unchanged object must never enter the cleanup queue');
});

test('a replaced key shared by another product survives the guarded drain', async () => {
  const db = freshSchema();
  const dbx = d1(db) as unknown as D1Database;
  const bucket = new FakeBucket();
  bucket.put(KEY_A);

  db.prepare("INSERT INTO products (id, slug, name, price_iqd) VALUES ('p1', 'p1', 'P1', 1000)").run();
  db.prepare("INSERT INTO products (id, slug, name, price_iqd) VALUES ('p2', 'p2', 'P2', 1000)").run();
  db.prepare("INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES ('pi_one', 'p1', ?, ?, 0)")
    .run(KEY_A, `/files/${KEY_A}`);
  db.prepare("INSERT INTO product_images (id, product_id, r2_key, url, sort_order) VALUES ('pi_shared', 'p2', ?, ?, 0)")
    .run(KEY_A, `/files/${KEY_A}`);

  const snap = await loadRelationsSnapshot(dbx, 'p1');
  const relationPlan = await planRelationsWriteFrom(
    dbx,
    snap,
    { images: [{ id: 'pi_one', url: `/files/${KEY_B}`, r2_key: KEY_B, is_primary: 1 }] },
    { money: true }
  );
  if (!relationPlan.stmts) assert.fail(relationPlan.errors.join(' | '));
  await saveProductAtomic(dbx, planOf(relationPlan.stmts, relationPlan.detachedMedia));

  const out = await runGuardedMediaCleanup(envOf(db, bucket));
  assert.deepEqual(out.still_referenced, [KEY_A]);
  assert.deepEqual(out.deleted, []);
  assert.ok(bucket.objects.has(KEY_A), 'the other product still displays KEY_A');
  assert.equal(jobsOf(db)[0]?.state, 'skipped_shared');
});
