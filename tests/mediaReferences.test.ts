/**
 * THE SWEEPER MUST NOT BE ABLE TO CALL A LIVE IMAGE AN ORPHAN AGAIN.
 *
 * A read-only audit found that the orphan cleanup's notion of "referenced" was
 * `MEDIA_COLUMNS` + `MEDIA_JSON_COLUMNS` — the product tables and eight JSON
 * columns on `products` — while the objects it offers to delete are everything
 * under the `products/` prefix in R2. Two whole classes of live image sit in
 * that gap:
 *
 *   - The home page's hero banners. `AdminHomeSettings.tsx` uploads them with
 *     `uploadFile(file, 'product')`, so they land at
 *     `products/catalog/gallery/<id>.webp`, and their only pointer is a JSON
 *     document inside `admin_settings.value` under the key `homeBanners`.
 *   - Every past order's thumbnail, in `order_items.image_snapshot` — the
 *     column that exists precisely so an order still shows a picture after the
 *     product is gone.
 *
 * Pressing the button would have deleted both. These tests build the REAL
 * schema (every migration applied to node:sqlite), put a banner and an order
 * thumbnail in it, and prove the wide reference set now holds them — and that
 * the coverage guard refuses the destructive path the moment a migration adds
 * a key-bearing column nobody has classified.
 *
 * Run: node --import tsx --test tests/mediaReferences.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { mediaKeyFromRef } from '../worker/lib/productDeletion';
import {
  MEDIA_REFERENCE_SOURCES,
  NON_MEDIA_COLUMNS,
  SWEEP_MIN_AGE_MS,
  deleteSweptObjects,
  auditMediaCoverage,
  collectMediaReferences,
  mediaColumnCandidates,
  partitionSweepCandidates,
  readLiveSchema,
  verifyMediaCoverage,
  type MediaRefDb,
} from '../worker/lib/mediaRefs';

/**
 * Foreign keys OFF, which is the PRODUCTION condition and not a shortcut:
 * nothing in the Worker issues `PRAGMA foreign_keys`, so on D1 the declared
 * cascades never fire. `tests/productDeletionEngine.test.ts` says the same
 * thing at greater length.
 */
function freshSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

const d1 = (db: DatabaseSync) => new SqliteD1(db) as unknown as MediaRefDb;

/** Fill every NOT NULL column the caller did not name, so a test states only
 *  what it is actually about. */
function insert(db: DatabaseSync, table: string, values: Record<string, unknown>): void {
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
    row[col.name] = /INT|REAL|NUM/i.test(col.type) ? 0 : '';
  }
  const names = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...(names.map((n) => row[n]) as never[]));
}

// ---------------------------------------------------------------------------
//  1. THE MANIFEST IS COMPLETE FOR THE SCHEMA THAT IS ACTUALLY DEPLOYED
// ---------------------------------------------------------------------------

/**
 * THE GUARD A FUTURE MIGRATION CANNOT SLIP PAST.
 *
 * This is the test the whole design exists for. Every TEXT column in the live
 * schema whose name reads like media, and every TEXT column that is a JSON
 * document (`DEFAULT '[]'` / `DEFAULT '{}'` — which is how `products.options`
 * and `admin_settings.value` hide a key behind a name that says nothing),
 * has to be CLASSIFIED: either scanned as a reference source, or excluded with
 * a written reason. Add `promo_banners.image_key` in migration 0100 and this
 * test fails on the first run, before the column can become an invisible
 * reference.
 */
test('every key-bearing column in the live schema is classified', () => {
  const db = freshSchema();
  const schema = new Map(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{
      name: string;
    }>).map((t) => [
      String(t.name),
      (db.prepare(`SELECT name, type, dflt_value FROM pragma_table_info('${t.name}')`).all() as Array<{
        name: string;
        type: string | null;
        dflt_value: string | null;
      }>).map((c) => ({ name: String(c.name), type: c.type ?? null, dflt: c.dflt_value ?? null })),
    ])
  );

  const audit = auditMediaCoverage(schema);
  assert.deepEqual(
    audit.unclassified,
    [],
    'These columns can hold an R2 object key and are named in neither MEDIA_REFERENCE_SOURCES nor ' +
      'NON_MEDIA_COLUMNS (worker/lib/mediaRefs.ts). Until they are, the destructive orphan cleanup ' +
      'refuses to run — which is the intended behaviour, not a test to silence. When unsure, make it ' +
      'a SOURCE: over-scanning reports one orphan fewer, under-scanning deletes a live picture.'
  );
  assert.deepEqual(audit.stale_sources, [], 'a manifest source names a column the schema no longer has');
  assert.deepEqual(audit.stale_exclusions, [], 'an exclusion names a column the schema no longer has');
});

/**
 * The two columns the audit found. Named explicitly, because "the manifest is
 * complete" would still pass if somebody moved these into the exclusion list.
 */
test('the sources that were missing are sources, not exclusions', () => {
  const ids = new Set(MEDIA_REFERENCE_SOURCES.map((s) => `${s.table}.${s.column}`));
  for (const id of ['admin_settings.value', 'order_items.image_snapshot', 'merchant_stores.logo_key', 'reviews.media']) {
    assert.ok(ids.has(id), `${id} must be a scanned reference source`);
    assert.ok(!(id in NON_MEDIA_COLUMNS), `${id} must never be excluded — it holds a live object key`);
  }
  // admin_settings.value is JSON. A column-value comparison sees nothing in it,
  // which is exactly how the banners became invisible.
  assert.equal(MEDIA_REFERENCE_SOURCES.find((s) => s.table === 'admin_settings')?.kind, 'json');
});

test('the wide net catches a JSON column whose name says nothing about media', () => {
  const schema = new Map([
    [
      'promo',
      [
        { name: 'id', type: 'TEXT', dflt: null },
        { name: 'payload', type: 'TEXT', dflt: "'{}'" },
        { name: 'headline', type: 'TEXT', dflt: "''" },
      ],
    ],
  ]);
  const candidates = mediaColumnCandidates(schema);
  assert.ok(candidates.includes('promo.payload'), 'a JSON document is a place a key can hide');
  assert.ok(!candidates.includes('promo.headline'), 'plain text is not');
  assert.deepEqual(auditMediaCoverage(schema).unclassified, ['promo.payload']);
});

// ---------------------------------------------------------------------------
//  2. THE REFERENCES THE OLD SWEEPER COULD NOT SEE
// ---------------------------------------------------------------------------

test('a home banner and a past order thumbnail are referenced, not orphans', async () => {
  const db = freshSchema();
  const bannerKey = 'products/catalog/gallery/bannerobject01.webp';
  const orderKey = 'products/catalog/gallery/orderthumb0001.webp';
  const brandObject = 'brand-bambulab-a1b2.webp';
  const looseKey = 'products/catalog/gallery/nobodyhasthis.webp';

  // Exactly how the admin panel stores them: JSON, inside admin_settings.
  db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
    'homeBanners',
    JSON.stringify({ hero: [{ id: 'b1', image: `/files/${bannerKey}`, link: '/products' }] })
  );
  db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
    'mainPageMedia',
    JSON.stringify({ 'brand-bambulab': brandObject })
  );
  insert(db, 'order_items', { id: 'oi1', order_id: 'ORD-1', image_snapshot: `/files/${orderKey}`, qty: 1 });

  const dbx = d1(db);
  const scan = await collectMediaReferences(dbx, await readLiveSchema(dbx));

  assert.ok(scan.keys.has(bannerKey), 'the home banner is live on the front page and must be referenced');
  assert.ok(scan.keys.has(orderKey), "a past order's thumbnail must be referenced");
  assert.ok(
    scan.keys.has(`UiUx/MainPage/${brandObject}`),
    'mainPageMedia stores a bare object name; it must resolve against UiUx/MainPage/'
  );
  assert.ok(!scan.keys.has(looseKey), 'a key nothing names must stay an orphan');
  assert.deepEqual(scan.failed, [], 'every manifest source must be readable against the real schema');
});

test('the wide reference set rescues exactly the objects the narrow one would have destroyed', async () => {
  const db = freshSchema();
  const bannerKey = 'products/catalog/gallery/bannerobject01.webp';
  const looseKey = 'products/catalog/gallery/nobodyhasthis.webp';
  db.prepare('INSERT INTO admin_settings (key, value) VALUES (?, ?)').run(
    'homeBanners',
    JSON.stringify({ hero: [{ id: 'b1', image: `/files/${bannerKey}`, link: '' }] })
  );

  const dbx = d1(db);
  const coverage = await verifyMediaCoverage(dbx);
  assert.equal(coverage.ok, true, coverage.refusals.join(' | '));

  // What `scanProductOrphans` would hand over: both keys look unreferenced to
  // the product tables, because neither is a product image.
  const partition = partitionSweepCandidates(
    [
      { key: bannerKey, bytes: 1024 },
      { key: looseKey, bytes: 2048 },
    ],
    coverage.scan.keys
  );
  assert.deepEqual(partition.protected_keys, [bannerKey]);
  assert.deepEqual(partition.removable, [{ key: looseKey, bytes: 2048 }]);
});

// ---------------------------------------------------------------------------
//  3. THE REFUSAL
// ---------------------------------------------------------------------------

/**
 * A migration adds a key-bearing column. The reference set is now a guess, and
 * the destructive path must say so rather than sweep on the guess.
 */
test('an unclassified key-bearing column makes coverage refuse, naming the column', async () => {
  const db = freshSchema();
  db.exec(`CREATE TABLE promo_banners (id TEXT PRIMARY KEY, image_key TEXT NOT NULL DEFAULT '')`);

  const coverage = await verifyMediaCoverage(d1(db));
  assert.equal(coverage.ok, false);
  assert.ok(coverage.audit.unclassified.includes('promo_banners.image_key'));
  assert.ok(
    coverage.refusals.join(' ').includes('promo_banners.image_key'),
    'the refusal must NAME what is unverified — a refusal nobody can act on is a silent no-op with extra steps'
  );
});

test('a source that cannot be read is a refusal, not a smaller reference set', async () => {
  const db = freshSchema();
  // A column present in pragma_table_info that the SELECT cannot read is what a
  // half-applied migration looks like. Dropping the table under a schema that
  // still lists it is the closest reproduction node:sqlite allows.
  const real = d1(db);
  const broken: MediaRefDb = {
    prepare(sql: string) {
      if (sql.includes('"order_items"')) throw new Error('database disk image is malformed');
      return real.prepare(sql);
    },
  };
  const schema = await readLiveSchema(real);
  const scan = await collectMediaReferences(broken, schema);
  assert.equal(scan.failed.length, 1);
  assert.equal(scan.failed[0]?.source, 'order_items.image_snapshot');
});

// ---------------------------------------------------------------------------
//  4. THE REPORT STAYS SAFE
// ---------------------------------------------------------------------------

test('coverage verification issues no writes', async () => {
  const db = freshSchema();
  const issued: string[] = [];
  const real = d1(db);
  const recording: MediaRefDb = {
    prepare(sql: string) {
      issued.push(sql);
      return real.prepare(sql);
    },
  };
  await verifyMediaCoverage(recording);
  assert.ok(issued.length > 0);
  for (const sql of issued) {
    assert.ok(
      /^\s*SELECT/i.test(sql),
      `the reference scan must be read-only; it issued: ${sql.slice(0, 80)}`
    );
  }
});

// ---------------------------------------------------------------------------
//  5. THE THREE WAYS A SAFE-LOOKING SWEEP STILL DESTROYS A LIVE PICTURE
// ---------------------------------------------------------------------------

/**
 * A FRESHLY UPLOADED IMAGE IS AN ORPHAN UNTIL SAVE.
 *
 * `ImagesSection.tsx` POSTs the file to /api/uploads the instant it is picked
 * and `uploads.ts` writes `products/catalog/gallery/<id>.webp`; the returned
 * `/files/<key>` then lives ONLY in React state until the admin presses Save.
 * Between those two moments NO row in this database names the key, and the
 * one record it does have — `file_objects` — is deliberately not a reference
 * source, because making the upload ledger a source would make the reference
 * set the whole bucket. So the report shows every staged picture as an orphan
 * with `cleanup_allowed: true`, and pressing the button deletes ten photos out
 * of an open form. The age floor is what makes "nothing points at this" mean
 * something.
 */
test('an object uploaded minutes ago is too young to be called an orphan', () => {
  const now = Date.parse('2026-09-19T12:00:00.000Z');
  const staged = 'products/catalog/gallery/juststaged01.webp';
  const old = 'products/catalog/gallery/longforgotten.webp';

  const partition = partitionSweepCandidates(
    [
      { key: staged, bytes: 100, uploaded: new Date(now - 5 * 60_000).toISOString() },
      { key: old, bytes: 200, uploaded: new Date(now - SWEEP_MIN_AGE_MS - 60_000).toISOString() },
      // No date at all: treated as old, or the sweep could never remove anything.
      { key: 'products/catalog/gallery/undatedobject.webp', bytes: 300, uploaded: null },
    ],
    new Set<string>(),
    { now }
  );

  assert.deepEqual(partition.staged_keys, [staged], 'the open form’s picture survives');
  assert.deepEqual(
    partition.removable.map((o) => o.key).sort(),
    [old, 'products/catalog/gallery/undatedobject.webp'].sort()
  );
  assert.deepEqual(partition.protected_keys, []);
});

/**
 * THE SWEEP DELETES FROM BOTH LOCATIONS, LIKE EVERY OTHER DELETE HERE.
 *
 * A raw `bucket.delete` on the primary binding leaves the legacy copy of a
 * stable key in place — and `readThroughLegacy` then serves that copy back to
 * the world, while the report has already told the owner the bytes are gone
 * and `file_objects` has already been stamped. `deleteMediaObject` attempts
 * both, which is why this function takes an env and not one bucket.
 */
test('a swept object is removed from the legacy bucket too, not just the primary', async () => {
  const primary = new Map<string, number>([['products/catalog/gallery/twinobject1.webp', 1]]);
  const legacy = new Map<string, number>([['products/catalog/gallery/twinobject1.webp', 1]]);
  const bucketOf = (m: Map<string, number>) => ({ delete: async (k: string) => void m.delete(k) });

  const env = { R2_PUBLIC: bucketOf(primary), BUCKET: bucketOf(legacy), DB: null } as never;
  const out = await deleteSweptObjects(env, [{ key: 'products/catalog/gallery/twinobject1.webp', bytes: 1 }]);

  assert.deepEqual(out.deleted, ['products/catalog/gallery/twinobject1.webp']);
  assert.equal(primary.size, 0, 'the primary copy is gone');
  assert.equal(legacy.size, 0, 'and so is the copy readThroughLegacy would have served back');
});

/**
 * THE MANIFEST'S OWN BLIND SPOT, PINNED SO IT CANNOT REOPEN.
 *
 * `core_outbox_events.envelope` really does carry object keys — the product
 * save publishes `ProductAddedV1` with `images: doc.media.map(...)` — and
 * `outbox.payload` has the same shape. Neither matched the media-name pattern
 * and neither had a JSON default, so `auditMediaCoverage` reported
 * `unclassified: []` while both were invisible: a clean bill of health that
 * was not true. They are classified now, as exclusions, because an event log
 * records what WAS shown, not what is shown.
 */
test('the event log and the message outbox are classified, not invisible', async () => {
  const db = freshSchema();
  const schema = await readLiveSchema(d1(db));
  const candidates = new Set(mediaColumnCandidates(schema));

  for (const id of ['core_outbox_events.envelope', 'outbox.payload']) {
    assert.ok(candidates.has(id), `${id} must be a candidate the audit sees`);
    assert.ok(id in NON_MEDIA_COLUMNS, `${id} must carry a written reason`);
  }
  assert.deepEqual(auditMediaCoverage(schema).unclassified, []);
});

/**
 * AN APPLIED IMPORT IS A LEDGER, NOT A PAGE.
 *
 * `product_imports` rows are never deleted and no prune job exists, so a
 * payload scanned unconditionally names its `products/import/<sha>` keys for
 * ever. The queue would find every one of them, close its job
 * `skipped_shared` — permanently, since a closed job leaves `pending` once —
 * and no admin action could ever reclaim those bytes. Worse, each one inflated
 * `r2_objects_protected`, the number the owner was told means "a live page
 * still shows this".
 *
 * While the import is still STAGED the payload is the only thing naming those
 * objects, and that is a real reference. The window, and only the window.
 */
test('a staged import protects its objects; an applied one does not', async () => {
  const staged = 'products/import/gallery/aaaa1111bbbb2222.webp';
  const applied = 'products/import/gallery/cccc3333dddd4444.webp';

  const db = freshSchema();
  insert(db, 'product_imports', {
    id: 'imp_staged', template_family: 'devices', state: 'preview',
    payload: JSON.stringify([{ images: [`/files/${staged}`] }]),
  });
  insert(db, 'product_imports', {
    id: 'imp_applied', template_family: 'devices', state: 'applied',
    payload: JSON.stringify([{ images: [`/files/${applied}`] }]),
  });

  const coverage = await verifyMediaCoverage(d1(db));
  assert.equal(coverage.ok, true, coverage.refusals.join(' | '));
  assert.ok(coverage.scan.keys.has(staged), 'a preview’s objects have nothing else naming them yet');
  assert.ok(
    !coverage.scan.keys.has(applied),
    'an applied import must not keep its images alive for ever — product_images is what decides now'
  );
});

/**
 * A CACHE-BUSTED PATH IS STILL A REFERENCE.
 *
 * `product_images.url` is free TEXT the admin types into, and the form's own
 * `classifyImageUrl` waves through any string starting with `/`. Someone
 * pastes `/files/<key>?v=2` to force a refresh after re-uploading; the browser
 * ignores the query and the product looks perfect. The relative branch of
 * `mediaKeyFromRef` used to slice that string raw, so the "key" carried the
 * `?`, `isSafeMediaKey` rejected it, the reference was dropped from the set —
 * and the next sweep deleted a file that a live page was displaying. The
 * absolute-URL branch never had this problem because `new URL` hands back
 * `pathname`. Both branches normalise the same way now.
 */
test('a /files/ reference with a query string or a fragment still names its key', () => {
  const key = 'products/catalog/gallery/ab12cd34.webp';
  assert.equal(mediaKeyFromRef(`/files/${key}?v=2`), key);
  assert.equal(mediaKeyFromRef(`/files/${key}#top`), key);
  assert.equal(mediaKeyFromRef(`/files/${key}`), key);
  assert.equal(mediaKeyFromRef(`https://levonis-iq.com/files/${key}?v=2`), key);
  // And nothing new is accepted: an off-site address is still not ours.
  assert.equal(mediaKeyFromRef('https://static.insales-cdn.com/x.png?v=2'), null);
  assert.equal(mediaKeyFromRef('/files/'), null);
});

/**
 * THE ORDER OF THE TWO READS IN THE DESTRUCTIVE HANDLER.
 *
 * This is asserted against the SOURCE because it is an ordering, and an
 * ordering has no value to inspect at run time — but it is the one arrangement
 * that can destroy a live image through pure timing. If the references are
 * read FIRST, a save committing before the bucket is listed is invisible to
 * the partition and its object is deleted while a live row names it. The
 * read-only report has always listed first; the cleanup had not.
 *
 * The second assertion is the final re-check: the staleness comparison is
 * computed before the row-delete pass, so a save committing after it was
 * guarded by nothing at all.
 */
test('the cleanup lists the bucket BEFORE it reads the references, and re-reads them before deleting', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/adminProducts.ts'), 'utf8');
  const handler = src.slice(src.indexOf("adminProductsRoutes.post('/maintenance/orphans/cleanup'"));
  const end = handler.indexOf("adminProductsRoutes.post('/maintenance/media-cleanup/retry'");
  const body = end > 0 ? handler.slice(0, end) : handler;

  const listedAt = body.indexOf('scanProductOrphans(c.env.DB, bucket');
  const verifiedAt = body.indexOf('verifyMediaCoverage(c.env.DB)');
  assert.ok(listedAt > 0 && verifiedAt > 0, 'both reads must be present');
  assert.ok(
    listedAt < verifiedAt,
    'the R2 listing must run FIRST so the reference set is the NEWER of the two reads'
  );

  const recheckAt = body.lastIndexOf('verifyMediaCoverage(c.env.DB)');
  const deleteAt = body.indexOf('deleteSweptObjects(');
  assert.ok(recheckAt > verifiedAt, 'there must be a SECOND coverage read');
  assert.ok(recheckAt < deleteAt, 'and it must come before anything is removed from the bucket');
});
