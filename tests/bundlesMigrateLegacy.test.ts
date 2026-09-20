/**
 * THE LEGACY BUNDLES BACKFILL — docs/BUNDLES_MYSTERY.md §1.11, plan slice 5.
 *
 * `bundles` / `bundle_items` (0034) are superseded, migrated and frozen, never
 * dropped. This file proves the four things the plan's gate names, against the
 * REAL migration files applied the way D1 applies them (one transaction per
 * file, in filename order):
 *
 *   1. every legacy bundle arrives as a `products` row with composition
 *      'bundle', status 'draft', price_iqd 0 and stock NULL — an unpriced
 *      draft, never an auto-published sellable product with no honest price;
 *   2. epoch MILLISECONDS become ISO text, because `bundles` stored
 *      `Date.now()` and `products` stores ISO;
 *   3. today's members-only gate is preserved EXACTLY, as a SET —
 *      ["plus","prime","pro"], which is what `benefits.exclusiveSections`
 *      means, and not a ladder minimum that would admit PRIME to every future
 *      PLUS-exclusive offer;
 *   4. a second pass moves NO row: every id the backfill derives is
 *      deterministic and keyed off the legacy row, so `INSERT OR IGNORE`
 *      collides on the primary key instead of inserting a second copy.
 *
 * The gate insert lives in `0063_bundles_legacy_gate.sql` rather than 0059
 * because `offer_windows` is created by 0060 and migrations apply in file
 * order — an insert into it from 0059 fails with "no such table" on a fresh
 * database. Everything else about it is §1.11 verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { all, row, count } from './fixtures/app';

const MIGRATIONS = join(ROOT, 'migrations');
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const sqlOf = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

const BACKFILL = '0059_bundles_migrate_legacy.sql';
const GATE = '0063_bundles_legacy_gate.sql';

/** Applies every migration whose name sorts before `stop`. */
function applyBefore(db: DatabaseSync, stop: string) {
  for (const f of files()) {
    if (f >= stop) break;
    db.exec(sqlOf(f));
  }
}

function applyFrom(db: DatabaseSync, start: string) {
  for (const f of files()) {
    if (f < start) continue;
    db.exec(sqlOf(f));
  }
}

const MS_CREATED = Date.UTC(2024, 4, 17, 9, 30, 0);
const MS_UPDATED = Date.UTC(2025, 0, 3, 18, 5, 0);

/** A database carrying two legacy bundles exactly as 0034's admin CRUD wrote
 *  them, with the backfill and everything after it applied on top. */
function migrated() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  applyBefore(db, BACKFILL);

  db.exec(`
    INSERT INTO products (id, slug, status, name, name_ar, price_iqd, stock, inventory_mode)
    VALUES ('prd_printer','printer','active','Printer','طابعة',900000,5,'BASE'),
           ('prd_spool','spool','active','Spool','فتيل',20000,6,'BASE');
  `);
  db.prepare(
    'INSERT INTO bundles (id, name, description, image, active, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run('bnd_live', 'Starter kit', 'A printer and a spool', 'https://cdn.example/kit.jpg', 1, 2, MS_CREATED, MS_UPDATED);
  db.prepare(
    'INSERT INTO bundles (id, name, description, image, active, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run('bnd_off', 'Retired kit', '', '', 0, 7, MS_CREATED, MS_UPDATED);
  db.prepare('INSERT INTO bundle_items (bundle_id, product_id, qty, sort) VALUES (?,?,?,?)').run('bnd_live', 'prd_printer', 1, 0);
  db.prepare('INSERT INTO bundle_items (bundle_id, product_id, qty, sort) VALUES (?,?,?,?)').run('bnd_live', 'prd_spool', 2, 1);

  applyFrom(db, BACKFILL);
  return db;
}

test('0059 is insert-only: it never drops, updates or deletes a legacy row', () => {
  const sql = sqlOf(BACKFILL).replace(/--[^\n]*/g, '');
  for (const forbidden of [/\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bALTER\b/i]) {
    assert.equal(forbidden.test(sql), false, `${BACKFILL} contains ${forbidden} — the legacy tables are frozen, not rewritten`);
  }
  assert.match(sql, /INSERT OR IGNORE INTO products/);
  assert.match(sql, /INSERT OR IGNORE INTO bundle_config/);
  assert.match(sql, /INSERT OR IGNORE INTO bundle_components/);
  assert.match(sqlOf(GATE).replace(/--[^\n]*/g, ''), /INSERT OR IGNORE INTO offer_windows/);
});

test('every legacy bundle lands as an UNPRICED DRAFT product with no stock', () => {
  const db = migrated();
  const p = row<Record<string, unknown>>(db, "SELECT * FROM products WHERE id = 'prd_bnd_bnd_live'")!;
  assert.equal(p.status, 'draft', 'a migrated bundle is never auto-published');
  assert.equal(p.price_iqd, 0, '0034 gave bundles no price, so there is no honest price to migrate');
  assert.equal(p.stock, null, 'a bundle is NEVER stocked — availability is computed');
  assert.equal(p.composition, 'bundle');
  assert.equal(p.selling_type, 'bundle');
  assert.equal(p.sale_types, '["bundle"]');
  assert.equal(p.inventory_mode, 'BASE');
  assert.equal(p.name, 'Starter kit');
  assert.equal(p.description, 'A printer and a spool');
  assert.equal(p.display_order, 2, 'the legacy sort becomes display_order');
  assert.equal(p.images, '[]', '0099 drains the legacy mirror instead of leaving an external hotlink active');
  assert.deepEqual(
    row<Record<string, unknown>>(
      db,
      "SELECT url, r2_key, source_url, quarantined, quarantine_reason FROM product_images WHERE product_id='prd_bnd_bnd_live'"
    ),
    {
      url: '',
      r2_key: '',
      source_url: 'https://cdn.example/kit.jpg',
      quarantined: 1,
      quarantine_reason: 'external_or_unsafe_url',
    },
    'the old address survives only as inert repair provenance'
  );
  assert.equal(String(p.slug).startsWith('bundle-'), true);

  // An empty legacy image is an empty gallery, not a list holding ''.
  assert.equal(row<Record<string, unknown>>(db, "SELECT images FROM products WHERE id = 'prd_bnd_bnd_off'")!.images, '[]');
});

test('epoch milliseconds become ISO text — `bundles` wrote Date.now(), `products` stores ISO', () => {
  const db = migrated();
  const p = row<{ created_at: string; updated_at: string }>(
    db,
    "SELECT created_at, updated_at FROM products WHERE id = 'prd_bnd_bnd_live'"
  )!;
  assert.equal(p.created_at, new Date(MS_CREATED).toISOString());
  assert.equal(p.updated_at, new Date(MS_UPDATED).toISOString());
});

test("today's members-only gate is preserved exactly, as a SET and not a ladder minimum", () => {
  const db = migrated();
  const w = row<Record<string, unknown>>(
    db,
    "SELECT * FROM offer_windows WHERE subject_type='product' AND subject_id='prd_bnd_bnd_live'"
  )!;
  // exclusiveSections is PLUS or PRIME or PRO — all three, written as a set.
  assert.equal(w.required_tiers, '["plus","prime","pro"]');
  assert.equal(w.id, 'ofw_bnd_bnd_live');
  assert.equal(w.active, 1, "the legacy `active` flag rides onto the window");
  assert.equal(w.offer_price_mode, '', 'the migration invents no price');
  const off = row<Record<string, unknown>>(
    db,
    "SELECT active FROM offer_windows WHERE subject_id='prd_bnd_bnd_off'"
  )!;
  assert.equal(off.active, 0, 'an inactive legacy bundle keeps its inactive window');
});

test('the composition is migrated with a SURROGATE id per legacy row, qty and order preserved', () => {
  const db = migrated();
  const comps = all<Record<string, unknown>>(
    db,
    "SELECT * FROM bundle_components WHERE bundle_product_id = 'prd_bnd_bnd_live' ORDER BY sort"
  );
  assert.equal(comps.length, 2);
  assert.deepEqual(
    comps.map((r) => [r.id, r.member_product_id, r.qty, r.sort]),
    [
      ['bc_bnd_bnd_live_prd_printer', 'prd_printer', 1, 0],
      ['bc_bnd_bnd_live_prd_spool', 'prd_spool', 2, 1],
    ]
  );
  assert.equal(
    row<Record<string, unknown>>(db, "SELECT * FROM bundle_config WHERE product_id='prd_bnd_bnd_live'")!.price_mode,
    'fixed'
  );
  assert.equal(
    row<Record<string, unknown>>(db, "SELECT * FROM bundle_config WHERE product_id='prd_bnd_bnd_live'")!.max_qty_per_order,
    5
  );
});

test('a second pass moves NO row — every derived id is deterministic', () => {
  const db = migrated();
  const before = {
    products: count(db, 'SELECT COUNT(*) AS n FROM products'),
    components: count(db, 'SELECT COUNT(*) AS n FROM bundle_components'),
    windows: count(db, 'SELECT COUNT(*) AS n FROM offer_windows'),
    configs: count(db, 'SELECT COUNT(*) AS n FROM bundle_config'),
  };
  // An admin priced and published one of them in the meantime; re-running the
  // backfill must not undo that, and must not insert a second copy.
  db.exec("UPDATE products SET status='active', price_iqd=850000 WHERE id='prd_bnd_bnd_live'");
  db.exec("UPDATE offer_windows SET required_tiers='[]' WHERE subject_id='prd_bnd_bnd_live'");

  db.exec(sqlOf(BACKFILL));
  db.exec(sqlOf(GATE));

  assert.deepEqual(
    {
      products: count(db, 'SELECT COUNT(*) AS n FROM products'),
      components: count(db, 'SELECT COUNT(*) AS n FROM bundle_components'),
      windows: count(db, 'SELECT COUNT(*) AS n FROM offer_windows'),
      configs: count(db, 'SELECT COUNT(*) AS n FROM bundle_config'),
    },
    before,
    'the second pass inserted a duplicate — an id in the backfill is not deterministic'
  );
  const p = row<Record<string, unknown>>(db, "SELECT status, price_iqd FROM products WHERE id='prd_bnd_bnd_live'")!;
  assert.deepEqual([p.status, p.price_iqd], ['active', 850000], "a re-run must not un-publish an admin's work");
  assert.equal(
    row<Record<string, unknown>>(db, "SELECT required_tiers FROM offer_windows WHERE subject_id='prd_bnd_bnd_live'")!
      .required_tiers,
    '[]',
    'a re-run must not restore a gate the admin deliberately emptied'
  );
});

test('the legacy tables themselves are untouched — they are history now', () => {
  const db = migrated();
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM bundles'), 2);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM bundle_items'), 2);
  const b = row<Record<string, unknown>>(db, "SELECT * FROM bundles WHERE id='bnd_live'")!;
  assert.equal(b.created_at, MS_CREATED, 'the legacy epoch-ms column is not rewritten in place');
});

test('the migrated database has zero foreign-key violations', () => {
  const db = migrated();
  const violations = all<Record<string, unknown>>(db, 'PRAGMA foreign_key_check');
  assert.deepEqual(violations, []);
});
