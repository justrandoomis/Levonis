/**
 * THE MEDIA INVENTORY HAS NEVER ONCE READ THE OWNER'S SETTINGS.
 *
 * `currentMediaReferences` in worker/lib/mediaMigration.ts ended its list with
 * `SELECT value FROM settings`. There is no table called `settings` in this
 * schema and there never has been: `migrations/0001_init.sql:332` creates
 * `admin_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`, and a grep of
 * every `CREATE TABLE` in `migrations/` returns exactly that one row for any
 * name ending in `settings`. So D1 answered `no such table: settings` on every
 * single call, and the bare `catch {}` on the next line threw the error away.
 *
 * The cost is not the failed query. It is WHICH query failed. `admin_settings`
 * is where `homeBanners`, `homeSectionItems` and `mainPageMedia` live — the
 * pictures on the front page, the service icons, the site's own logo — and
 * they are the only references those objects have. Read through the broken
 * query they had none, so the inventory reported them `orphan_candidate`:
 * literally «nothing points at this any more», about the shop's own logo.
 * worker/lib/mediaRefs.ts records the orphan sweeper making this exact mistake
 * once already, on the same rows, with a delete button attached.
 *
 * And `mainPageMedia` needs one more step even once the table name is right:
 * it stores a BARE OBJECT NAME (`banner-1-a1b2.webp`), and `addReference`
 * rejects anything without a `/` precisely so junk cannot become a key. The
 * real object is `UiUx/MainPage/` + that name, so the value must be resolved
 * through `siteMediaKey`, which is why the row is now read WITH its key.
 *
 * The deeper defect is the swallow. A query that fails silently is how a typo
 * this large lived this long, and an inventory is a claim about ABSENCE — the
 * one claim a failed read can never support. `soft()` in
 * worker/lib/stockAlertResolve.ts was written after the same failure class
 * shipped once; these tests pin its contract here: the failure is recorded,
 * and while it stands nothing on the page is called an orphan.
 *
 * Run: node --import tsx --test tests/mediaMigrationSettings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { inventoryLegacyMedia, scanMediaReferences, currentMediaReferences } from '../worker/lib/mediaMigration';
import type { Env } from '../worker/lib/types';

/** Foreign keys OFF: nothing in the Worker issues `PRAGMA foreign_keys`, so on
 *  D1 the declared cascades never fire. The same note as mediaReferences.test.ts. */
function freshSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

const d1 = (db: DatabaseSync) => new SqliteD1(db) as unknown as D1Database;

function setting(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(key, value);
}

test('no migration has ever created a table named `settings`', () => {
  const dir = join(ROOT, 'migrations');
  const names = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi)) {
      names.add(m[1].toLowerCase());
    }
  }
  // The premise of every other test in this file. If a future migration really
  // does add a `settings` table, this fails loudly and someone re-reads the
  // header instead of quietly having two settings stores.
  assert.equal(names.has('settings'), false, 'a bare `settings` table exists now; the fix below needs revisiting');
  assert.equal(names.has('admin_settings'), true, 'the real settings store must be `admin_settings`');
});

test('the source file names no table the schema does not have', () => {
  // Comments are stripped first, because the header above the fix QUOTES the
  // broken statement — that is the point of the header — and a guard that
  // cannot tell the explanation from the code would forbid explaining it.
  const src = readFileSync(join(ROOT, 'worker/lib/mediaMigration.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.ok(!/FROM\s+settings\b/i.test(src), 'the phantom `settings` table is back');
  assert.ok(/FROM\s+admin_settings\b/i.test(src), 'the settings store must still be read');
});

test('NOTHING under worker/ names a bare `settings` table', () => {
  // The two halves of this bug were separated for a while, and that separation
  // was worse than either half alone. worker/routes/media.ts carried the same
  // typo in a place where it is NOT swallowed: `SELECT key, value FROM
  // settings` sits inside a try whose catch deletes the object it has just
  // copied and rethrows, so `POST /api/media/migration/apply` copied, threw,
  // rolled back and returned a 500 for every brand-folder key. While the
  // inventory here was ALSO broken, those keys were reported
  // `orphan_candidate` and the handler refused them before reaching the copy —
  // the bug hid the bug. Fixing the inventory alone would have turned a
  // harmless refusal into a real R2 put/head/delete per attempt.
  //
  // So the guard is repo-wide rather than file-local: the pair cannot separate
  // again.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
    );
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'worker'))) {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    if (/\b(?:FROM|INTO|UPDATE)\s+settings\b/i.test(code)) offenders.push(file.slice(ROOT.length + 1));
  }
  assert.deepEqual(offenders, [], 'these files name a table that has never existed');
});

test('every reference query runs against the real schema', async () => {
  // The generic guard for this whole bug class. `failed` is empty only when
  // all thirteen statements prepared and ran, so the next `no such table` or
  // `no such column` typo cannot hide behind the catch the way this one did.
  const scan = await scanMediaReferences(d1(freshSchema()));
  assert.deepEqual(scan.failed, [], 'a reference source did not survive the live schema');
});

test('a setting that holds a media key counts as a reference', async () => {
  const db = freshSchema();
  // The real shape `AdminHomeSettings.tsx` writes: uploaded with
  // `purpose=product`, so it lands under the prefix the sweeper lists, and its
  // ONLY pointer is this JSON blob.
  setting(db, 'homeBanners', JSON.stringify([{ image: '/files/products/catalog/gallery/banner1.webp' }]));
  setting(db, 'homeSectionItems', JSON.stringify({ rows: [{ icon: 'ui/levonis/icons/print_a1b2.webp' }] }));

  const refs = await currentMediaReferences(d1(db));
  assert.ok(refs.has('products/catalog/gallery/banner1.webp'), 'the front page banner is still an orphan');
  assert.ok(refs.has('ui/levonis/icons/print_a1b2.webp'), 'the home section icon is still an orphan');
});

test('mainPageMedia stores a bare object name and still resolves to a key', async () => {
  const db = freshSchema();
  setting(db, 'mainPageMedia', JSON.stringify({ 'brand-logo': 'brand-logo-9f2c.webp' }));

  const refs = await currentMediaReferences(d1(db));
  assert.ok(refs.has('UiUx/MainPage/brand-logo-9f2c.webp'), 'the site logo is still reported unreferenced');
  // And the bare name is NOT admitted as a key of its own: a filename with no
  // directory matches nothing in the bucket and would only pad the set.
  assert.equal(refs.has('brand-logo-9f2c.webp'), false);
});

test('a source that throws is recorded, not swallowed', async () => {
  const db = freshSchema();
  setting(db, 'homeBanners', JSON.stringify(['products/catalog/gallery/banner1.webp']));
  const real = new SqliteD1(db);
  const broken = {
    prepare(sql: string) {
      if (/admin_settings/i.test(sql)) {
        return { all: async () => { throw new Error('D1_ERROR: Network connection lost'); } };
      }
      return real.prepare(sql);
    },
  } as unknown as D1Database;

  const scan = await scanMediaReferences(broken);
  assert.deepEqual(scan.failed, ['SELECT key, value FROM admin_settings']);
  // The banner is genuinely missing from the set — that is what a failed read
  // means. The point is that the caller can now SEE that it is missing.
  assert.equal(scan.refs.has('products/catalog/gallery/banner1.webp'), false);
});

function envWith(db: D1Database, keys: string[]): Env {
  return {
    DB: db,
    BUCKET: {
      async list() {
        return {
          objects: keys.map((key) => ({ key, size: 10, uploaded: new Date('2026-01-01T00:00:00.000Z') })),
          truncated: false,
          cursor: undefined,
        };
      },
    },
  } as unknown as Env;
}

test('a degraded scan never calls anything an orphan', async () => {
  const db = freshSchema();
  const real = new SqliteD1(db);
  const broken = {
    prepare(sql: string) {
      if (/admin_settings/i.test(sql)) {
        return { all: async () => { throw new Error('no such table: admin_settings'); } };
      }
      return real.prepare(sql);
    },
  } as unknown as D1Database;

  const page = await inventoryLegacyMedia(envWith(broken, ['UiUx/MainPage/brand-logo-9f2c.webp']), undefined, 10);
  assert.equal(page.degraded, true);
  assert.deepEqual(page.failed_sources, ['SELECT key, value FROM admin_settings']);
  // The exact object the broken query used to hide. Unreferenced it would read
  // `orphan_candidate`; with a source missing that verdict is not available.
  assert.equal(page.objects[0].action, 'manual_review');
  assert.equal(page.objects[0].referenced, false, 'the honest field still says the set did not contain it');
});

test('a healthy scan still names real orphans', async () => {
  const db = freshSchema();
  setting(db, 'mainPageMedia', JSON.stringify({ 'brand-logo': 'brand-logo-9f2c.webp' }));
  const page = await inventoryLegacyMedia(
    envWith(d1(db), ['UiUx/MainPage/brand-logo-9f2c.webp', 'products/import/nobody.webp']),
    undefined,
    10
  );
  assert.equal(page.degraded, false);
  assert.deepEqual(page.failed_sources, []);
  assert.equal(page.objects[0].referenced, true, 'the logo is referenced by mainPageMedia');
  assert.notEqual(page.objects[0].action, 'orphan_candidate');
  assert.equal(page.objects[1].action, 'orphan_candidate', 'a genuinely unreferenced object must still be named');
});
