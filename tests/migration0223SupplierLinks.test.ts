/**
 * MIGRATION 0223 — THE OWNER'S OWN SUPPLIER LINKS, PROVEN ON THE REAL SCHEMA
 * (docs/SMART_PRICING.md §3.10; DECISIONS row 293).
 *
 *   harness      scripts/migrate-check.mjs --twice is green, and the file's
 *                statements re-run on a migrated database change nothing
 *   additive     one table, two indexes, three triggers, every one IF NOT EXISTS
 *   CHECKs       an https address of printable ASCII, 12 to 1000 characters; a
 *                lower-case dotted host; '' or an 'o:' / 'c:' key; the label,
 *                supplier name and note limits; the `psl_` id; a version above
 *                zero; a product that exists
 *   unique       one address once per key of a product
 *   import       the three guard triggers refuse inside an import batch only
 *   deletion     a product's permanent deletion takes its links with it, with
 *                foreign keys on and off, reported under the neutral name
 *
 * LOCAL ONLY: in-memory SQLite and a temporary directory, no network.
 *
 * Run: node --import tsx --test tests/migration0223SupplierLinks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, count, dbThrough, freshDb } from './fixtures/app';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';
import { IMPORT_GUARD_ID, IMPORT_GUARD_REFUSAL, LATE_PROTECTED_TABLES } from '../worker/lib/catalogImport/protectedTables';
import { OWNED_TABLES, deleteProductPermanently } from '../worker/lib/productDeletion';
import { EXPECTED_MIGRATION } from '../worker/lib/schemaVersion';

const FILE = '0223_product_supplier_links.sql';
const SQL = readFileSync(join(ROOT, 'migrations', FILE), 'utf8');
const AT = '2026-11-05T09:00:00.000Z';

/** The refusal's message, or null when the statement went through (inside a savepoint: a refusal leaves nothing). */
function refusal(db: DatabaseSync, sql: string, ...params: Array<string | number>): string | null {
  db.exec('SAVEPOINT t');
  try {
    db.prepare(sql).run(...params);
    db.exec('RELEASE t');
    return null;
  } catch (e) {
    db.exec('ROLLBACK TO t');
    db.exec('RELEASE t');
    return String((e as Error).message);
  }
}

const INSERT =
  'INSERT INTO product_supplier_links (id, product_id, combo_key, url, host, label, supplier_name, note, version, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

interface Row {
  id: string;
  product_id: string;
  combo_key: string;
  url: string;
  host: string;
  label: string;
  supplier_name: string;
  note: string;
  version: number;
}
const good = (over: Partial<Row> = {}): Row => ({
  id: 'psl_0123456789abcdef0123456789abcdef',
  product_id: 'p_h2d',
  combo_key: 'o:v_combo|c:c_blk',
  url: 'https://detail.tmall.com/item.htm?id=693972799714&skuId=4930331344241',
  host: 'detail.tmall.com',
  label: 'Tmall',
  supplier_name: 'Bambu Lab official',
  note: 'MOQ 1',
  version: 1,
  ...over,
});
const insert = (db: DatabaseSync, r: Row) =>
  refusal(db, INSERT, r.id, r.product_id, r.combo_key, r.url, r.host, r.label, r.supplier_name, r.note, r.version, 'usr_owner', AT, 'usr_owner', AT);

function world(): DatabaseSync {
  const db = freshDb();
  db.exec(`INSERT INTO products (id, slug, name, status) VALUES ('p_h2d', 'h2d', 'H2D', 'active'), ('p_pla', 'pla', 'PLA', 'active')`);
  return db;
}

// ------------------------------------------------------------------ the harness

test('scripts/migrate-check.mjs --twice: every migration applies, the second pass is a no-op, no FK violation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-mc-0223-'));
  try {
    const out = execFileSync(process.execPath, ['scripts/migrate-check.mjs', '--twice'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MIGRATE_CHECK_DIR: dir },
      timeout: 180_000,
    });
    assert.match(out, new RegExp(`✔ ${FILE.replace('.', '\\.')} \\(\\d+ statements\\)`));
    assert.match(out, /second full pass applied 0 files/);
    assert.match(out, /foreign_key_check violations: 0/);
    // While 0223 is the newest file, the harness re-runs ITS statements; the next test proves the same on its own.
    const newest = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().at(-1);
    if (newest === FILE) assert.match(out, new RegExp(`✔ ${FILE.replace('.', '\\.')}: \\d+ idempotent statement\\(s\\) re-ran — no row added, no value changed, no trigger changed`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file is additive and re-runnable: one table, two indexes, three triggers, each IF NOT EXISTS; a second run changes nothing', () => {
  const statements = splitStatements(SQL) as string[];
  assert.equal(statements.length, 6);
  assert.ok(statements.every((s) => /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS /i.test(s)), 'every statement is re-runnable');
  assert.ok(!statements.some((s) => /^(ALTER|DROP|UPDATE|DELETE|INSERT|REPLACE)\b/i.test(s)), 'no existing table or row is touched');
  assert.doesNotMatch(SQL, /\/\*/, '`--` comments only');
  const db = world();
  assert.equal(insert(db, good()), null);
  const schema = () => JSON.stringify(db.prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'product_supplier_links' ORDER BY name").all());
  const before = schema();
  const rows = JSON.stringify(db.prepare('SELECT * FROM product_supplier_links').all());
  db.exec(SQL);
  assert.equal(schema(), before, 'no table, index or trigger changed');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM product_supplier_links').all()), rows, 'no row added or changed');
  assert.deepEqual(
    (db.prepare("SELECT name FROM sqlite_master WHERE tbl_name = 'product_supplier_links' AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name),
    ['ix_psl_product', 'trg_import_guard_product_supplier_links_del', 'trg_import_guard_product_supplier_links_ins', 'trg_import_guard_product_supplier_links_upd', 'ux_psl_link']
  );
  // The code expects it: the schema version names it, or a later migration once one lands.
  assert.ok(EXPECTED_MIGRATION >= FILE, 'schemaVersion names 0223 or a later migration');
  // A database before it has no such table.
  assert.equal(count(dbThrough('0220'), "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'product_supplier_links'"), 0);
});

// ------------------------------------------------------------------ the CHECKs

test('the CHECKs hold whatever door writes: an https address of printable ASCII, a dotted lower-case host, a key, the text limits, the id', () => {
  const db = world();
  const CHECK = /CHECK constraint failed/;
  for (const [what, over] of [
    ['http', { url: 'http://detail.tmall.com/item.htm?id=1' }],
    ['javascript', { url: 'javascript:alert(1)//https://x' }],
    ['a space', { url: 'https://example.com/a b' }],
    ['non-ASCII', { url: 'https://bücher.de/a' }],
    ['a control', { url: 'https://example.com/\u0007' }],
    ['too short', { url: 'https://a.b' }],
    ['over 1000', { url: `https://example.com/${'a'.repeat(981)}` }],
    ['an upper-case host', { host: 'Example.com' }],
    ['a host without a dot', { host: 'localhost' }],
    ['a host with an underscore', { host: 'exa_mple.com' }],
    ['a host too short', { host: 'a.' }],
    ['a key of no kind', { combo_key: 'x:1' }],
    ['an empty option', { combo_key: 'o:' }],
    ['an empty colour', { combo_key: 'c:' }],
    ['a key over 400', { combo_key: `o:${'v'.repeat(399)}` }],
    ['a label over 80', { label: 'x'.repeat(81) }],
    ['a supplier over 80', { supplier_name: 'x'.repeat(81) }],
    ['a note over 300', { note: 'x'.repeat(301) }],
    ['a bad id prefix', { id: 'link_1' }],
    ['an empty id', { id: 'psl_' }],
    ['an id over 40', { id: `psl_${'a'.repeat(37)}` }],
    ['version zero', { version: 0 }],
  ] as const) {
    const got = insert(db, good(over as Partial<Row>));
    assert.match(String(got), CHECK, `${what}: ${String(got)}`);
  }
  assert.match(String(insert(db, good({ product_id: 'p_nobody' }))), /FOREIGN KEY constraint failed/, 'a product that exists');
  // The limits themselves pass.
  assert.equal(insert(db, good({ id: 'psl_a', url: `https://example.com/${'a'.repeat(980)}`, host: 'example.com', label: 'x'.repeat(80), supplier_name: 'y'.repeat(80), note: 'z'.repeat(300) })), null);
  assert.equal(insert(db, good({ id: 'psl_b', combo_key: '', url: 'https://a.bc', host: 'a.bc' })), null);
  assert.equal(insert(db, good({ id: 'psl_c', combo_key: 'c:c_wht', url: 'https://xn--bcher-kva.de/a?q=%3Cx%3E#f', host: 'xn--bcher-kva.de' })), null);
  assert.equal(insert(db, good({ id: `psl_${'a'.repeat(36)}` })), null);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_supplier_links'), 4);
});

test('one address once per key of a product; the same address for another key or another product is its own link', () => {
  const db = world();
  assert.equal(insert(db, good()), null);
  assert.match(String(insert(db, good({ id: 'psl_dup' }))), /UNIQUE constraint failed: product_supplier_links\.product_id, product_supplier_links\.combo_key, product_supplier_links\.url/);
  assert.equal(insert(db, good({ id: 'psl_other_key', combo_key: 'o:v_combo' })), null);
  assert.equal(insert(db, good({ id: 'psl_other_product', product_id: 'p_pla' })), null);
  assert.match(String(insert(db, good({ id: 'psl_other_key', url: 'https://other.example/x', host: 'other.example' }))), /UNIQUE constraint failed: product_supplier_links\.id/);
});

// ------------------------------------------------------------------ the import guard

test('the import guard: armed, every write aborts; disarmed, the triggers stay silent', () => {
  const db = world();
  assert.ok(LATE_PROTECTED_TABLES.some((t) => t.table === 'product_supplier_links' && t.guardedBy === FILE));
  assert.equal(insert(db, good()), null);
  db.exec(`INSERT INTO ops_guards (id, ok) VALUES ('${IMPORT_GUARD_ID}', 1)`);
  assert.equal(insert(db, good({ id: 'psl_armed', combo_key: '' })), IMPORT_GUARD_REFUSAL);
  assert.equal(refusal(db, "UPDATE product_supplier_links SET label = 'x'"), IMPORT_GUARD_REFUSAL);
  assert.equal(refusal(db, 'DELETE FROM product_supplier_links'), IMPORT_GUARD_REFUSAL);
  db.exec(`DELETE FROM ops_guards WHERE id = '${IMPORT_GUARD_ID}'`);
  assert.equal(refusal(db, "UPDATE product_supplier_links SET label = 'x'"), null);
  assert.equal(refusal(db, 'DELETE FROM product_supplier_links'), null);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM product_supplier_links'), 0);
});

// ------------------------------------------------------------------ deletion

for (const foreignKeys of [true, false]) {
  test(`a product's permanent deletion takes its links, reported under the neutral name; another product's stay (foreign keys ${foreignKeys ? 'on' : 'off'})`, async () => {
    const db = world();
    if (!foreignKeys) db.exec('PRAGMA foreign_keys = OFF');
    assert.ok(OWNED_TABLES.some((t) => t.table === 'product_supplier_links'), 'the registry lists the table');
    assert.equal(insert(db, good()), null);
    assert.equal(insert(db, good({ id: 'psl_whole', combo_key: '', url: 'https://supplier.example/h2d', host: 'supplier.example' })), null);
    assert.equal(insert(db, good({ id: 'psl_pla', product_id: 'p_pla', combo_key: '' })), null);
    const out = await deleteProductPermanently(asD1(db), 'p_h2d', { newId: () => `job-${Math.random()}` });
    assert.equal(out.product_deleted, true);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM product_supplier_links WHERE product_id = 'p_h2d'"), 0);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM product_supplier_links WHERE product_id = 'p_pla'"), 1);
    // Whether a product had supplier links is supplier data: never named in the deletion's answer.
    assert.equal('product_supplier_links' in out.rows_deleted_by_table, false);
    assert.ok((out.rows_deleted_by_table.pricing_engine ?? 0) >= 2);
  });
}
