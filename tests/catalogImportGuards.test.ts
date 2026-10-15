/**
 * THE IMPORT CANNOT WRITE MONEY, STOCK OR A PACKAGE MEASURE — PROVEN ON THE
 * SCHEMA EVERY MIGRATION BUILDS (Bambu import spec §B.4, §C.10 layer 3).
 *
 * Migration 0195's guard triggers are armed only while the row
 * ops_guards(id = 'catalog-import-batch') exists, which is only inside an
 * import batch. This file proves, on node:sqlite with all migrations:
 *
 *   - the committed generated block is exactly what the generator prints;
 *   - every protected table exists (a missing one is a FAILURE, except a table
 *     whose own migration file has not landed on this base yet — and that
 *     exception dies the day the file appears);
 *   - with the guard row present, every INSERT, UPDATE and DELETE on a
 *     protected table aborts with IMPORT_FINANCIAL_WRITE_REFUSED;
 *   - on products, option values, variants and colours, a new row with any
 *     money, stock or package value aborts; an upsert or a REPLACE that would
 *     change one aborts; an UPDATE of one aborts; the same rows at their
 *     defaults, or re-sent unchanged, go through;
 *   - the stock decision can be recorded as not_configured, never as a
 *     decision, and never changed;
 *   - without the guard row nothing changes: the same writes are not refused
 *     by these triggers;
 *   - the lease fence refuses a checkpoint from a stale executor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb } from './fixtures/app';
import {
  GUARDED_ROW_TABLES,
  IMPORT_GUARD_ID,
  IMPORT_GUARD_REFUSAL,
  PROTECTED_TABLES,
  STOCK_DECISION_GUARD,
} from '../worker/lib/catalogImport/protectedTables';
// @ts-expect-error — plain ESM script shared with the command line
import { committedGuardBlock, generateGuardBlock, schemaBefore } from '../scripts/gen-import-guard-triggers.mjs';

const arm = (db: DatabaseSync) => db.prepare('INSERT INTO ops_guards (id, ok) VALUES (?, 1)').run(IMPORT_GUARD_ID);
const disarm = (db: DatabaseSync) => db.prepare('DELETE FROM ops_guards WHERE id = ?').run(IMPORT_GUARD_ID);

function raw(): DatabaseSync {
  const db = freshDb();
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

function tables(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
}

type Col = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
const colsOf = (db: DatabaseSync, t: string) => db.prepare(`PRAGMA table_info(${t})`).all() as Col[];

/** A row that satisfies NOT NULL; CHECK constraints are switched off around it. */
function dummyRow(db: DatabaseSync, table: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = { ...overrides };
  for (const c of colsOf(db, table)) {
    if (c.name in row) continue;
    if (c.pk && /INT/i.test(c.type)) continue;
    if (c.notnull !== 1 || c.dflt_value !== null) {
      if (c.pk) row[c.name] = `pk-${c.name}`;
      continue;
    }
    row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 1 : `x-${c.name}`;
  }
  const names = Object.keys(row);
  db.exec('PRAGMA ignore_check_constraints = ON');
  try {
    db.prepare(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...(names.map((n) => row[n]) as never[]));
  } finally {
    db.exec('PRAGMA ignore_check_constraints = OFF');
  }
}

function refusal(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}

test('the generated guard block in 0195 is exactly what the generator prints', () => {
  const committed = committedGuardBlock() as string | null;
  assert.ok(committed, '0195 must carry the generated block between its markers');
  const expected = generateGuardBlock(schemaBefore()) as string;
  assert.equal(committed, expected, 'stale: run node scripts/gen-import-guard-triggers.mjs --write');
});

test('every protected table and guarded column exists — a missing one is a failure, not a skip', () => {
  const db = raw();
  const live = tables(db);
  for (const t of PROTECTED_TABLES) {
    if (live.has(t.table)) continue;
    // The one bounded exception: the table's own migration has not landed on
    // this base. The moment that file exists, this branch fails until the
    // guard block is regenerated with the table in it.
    assert.ok(t.since, `${t.table} is missing from the schema`);
    assert.equal(existsSync(join(ROOT, 'migrations', t.since!)), false, `${t.since} exists, so ${t.table} must exist and be guarded`);
  }
  for (const t of GUARDED_ROW_TABLES) {
    const cols = new Set(colsOf(db, t.table).map((c) => c.name));
    for (const c of [...t.money, ...t.stock, ...t.package]) assert.ok(cols.has(c.name), `${t.table}.${c.name} is missing`);
  }
  const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name));
  for (const t of PROTECTED_TABLES.filter((x) => live.has(x.table))) {
    for (const s of ['ins', 'upd', 'del']) assert.ok(triggers.has(`trg_import_guard_${t.table}_${s}`), `${t.table}: ${s} trigger`);
  }
});

test('armed, every INSERT, UPDATE and DELETE on a protected table aborts; disarmed, these triggers stay silent', () => {
  const db = raw();
  const live = tables(db);
  // Isolate the guard: the pricing, order and ledger tables carry their own
  // triggers (ENGINE_MANAGED, append-only ledgers …) that would refuse the
  // dummy rows below for their own reasons. Only 0195's guard is under test.
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'trg_import_guard_%'").all() as Array<{ name: string }>) {
    db.exec(`DROP TRIGGER "${name}"`);
  }
  for (const { table } of PROTECTED_TABLES) {
    if (!live.has(table)) continue;
    dummyRow(db, table);
    const first = colsOf(db, table)[0].name;
    arm(db);
    assert.equal(refusal(() => db.exec(`INSERT INTO "${table}" DEFAULT VALUES`)), IMPORT_GUARD_REFUSAL, `${table}: insert`);
    assert.equal(refusal(() => db.exec(`UPDATE "${table}" SET "${first}" = "${first}"`)), IMPORT_GUARD_REFUSAL, `${table}: update`);
    assert.equal(refusal(() => db.exec(`DELETE FROM "${table}"`)), IMPORT_GUARD_REFUSAL, `${table}: delete`);
    disarm(db);
    // Outside an import batch the same writes go through.
    assert.equal(refusal(() => db.exec(`UPDATE "${table}" SET "${first}" = "${first}"`)), null, `${table}: update without the guard row`);
    assert.equal(refusal(() => db.exec(`DELETE FROM "${table}"`)), null, `${table}: delete without the guard row`);
  }
});

function productRow(db: DatabaseSync, id: string): void {
  db.prepare("INSERT INTO products (id, slug, name, status) VALUES (?, ?, ?, 'active')").run(id, id, id);
}

test('products: a new row keeps every money, stock and package column at its default; an update cannot set one', () => {
  const db = raw();
  const products = GUARDED_ROW_TABLES.find((t) => t.table === 'products')!;
  arm(db);
  productRow(db, 'p-ok');
  db.exec("UPDATE products SET name = 'renamed', description = 'text' WHERE id = 'p-ok'");
  for (const c of [...products.money, ...products.stock, ...products.package]) {
    const value = c.insertDefault === 'empty_object' ? '{"prime":1}' : 7;
    assert.equal(
      refusal(() => db.prepare(`INSERT INTO products (id, slug, name, ${c.name}) VALUES (?, ?, 'x', ?)`).run(`p-${c.name}`, `s-${c.name}`, value)),
      IMPORT_GUARD_REFUSAL,
      `insert with ${c.name}`
    );
    assert.equal(refusal(() => db.prepare(`UPDATE products SET ${c.name} = ? WHERE id = 'p-ok'`).run(value)), IMPORT_GUARD_REFUSAL, `update of ${c.name}`);
  }
  // The same value again is not a change.
  db.exec("UPDATE products SET price_iqd = 0, stock = NULL WHERE id = 'p-ok'");
  disarm(db);
  db.exec("UPDATE products SET price_iqd = 1000, stock = 3 WHERE id = 'p-ok'");
  arm(db);
  // REPLACE over an existing priced row with a different price: refused (the row exists, and differs).
  assert.equal(
    refusal(() => db.exec("INSERT OR REPLACE INTO products (id, slug, name, price_iqd, stock) VALUES ('p-ok', 'p-ok', 'p-ok', 2000, 3)")),
    IMPORT_GUARD_REFUSAL
  );
});

test('option values, variants and colours: defaults pass, an upsert that keeps the stored figures passes, any change aborts', () => {
  const db = raw();
  productRow(db, 'p1');
  db.exec("INSERT INTO product_option_groups (id, product_id, name_en) VALUES ('g1', 'p1', 'Colour')");
  const rows: Record<string, string> = {
    product_option_values: "INSERT INTO product_option_values (id, product_id, group_id, name_en{cols}) VALUES ('{id}', 'p1', 'g1', 'v'{vals})",
    product_variants: "INSERT INTO product_variants (id, product_id, combo_key{cols}) VALUES ('{id}', 'p1', 'o:{id}'{vals})",
    product_colors: "INSERT INTO product_colors (id, product_id, name_en, hex{cols}) VALUES ('{id}', 'p1', 'Black', '#000000'{vals})",
  };
  const upsert: Record<string, string> = {
    product_option_values: ' ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en{set}',
    product_variants: ' ON CONFLICT (id) DO UPDATE SET combo_key = excluded.combo_key{set}',
    product_colors: ' ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en{set}',
  };
  const sql = (t: string, id: string, cols: Record<string, unknown>, onConflict = false) => {
    const names = Object.keys(cols);
    let s = rows[t]
      .replaceAll('{id}', id)
      .replace('{cols}', names.map((n) => `, ${n}`).join(''))
      .replace('{vals}', names.map((n) => `, ${cols[n] === null ? 'NULL' : JSON.stringify(cols[n])}`).join(''));
    if (onConflict) s += upsert[t].replace('{set}', names.map((n) => `, ${n} = excluded.${n}`).join(''));
    return s;
  };
  for (const t of GUARDED_ROW_TABLES.filter((x) => x.table !== 'products')) {
    // A stored row priced and stocked by the owner, written outside any import.
    disarm(db);
    db.exec(sql(t.table, `${t.table}-owned`, { regular_price_iqd: 5000, stock: 4 }));
    arm(db);
    // A new import row at its defaults goes through.
    db.exec(sql(t.table, `${t.table}-new`, {}));
    // A merge re-sends the owner's row unchanged through the planner's upsert: it goes through.
    db.exec(sql(t.table, `${t.table}-owned`, { regular_price_iqd: 5000, stock: 4 }, true));
    for (const c of [...t.money, ...t.stock, ...t.package]) {
      assert.equal(refusal(() => db.exec(sql(t.table, `${t.table}-n-${c.name}`, { [c.name]: 9 }))), IMPORT_GUARD_REFUSAL, `${t.table}: new row with ${c.name}`);
      assert.equal(refusal(() => db.exec(`UPDATE ${t.table} SET ${c.name} = 9 WHERE id = '${t.table}-new'`)), IMPORT_GUARD_REFUSAL, `${t.table}: update of ${c.name}`);
    }
    assert.equal(
      refusal(() => db.exec(sql(t.table, `${t.table}-owned`, { regular_price_iqd: 6000, stock: 4 }, true))),
      IMPORT_GUARD_REFUSAL,
      `${t.table}: an upsert that changes the owner's price`
    );
    assert.equal(
      refusal(() => db.exec(sql(t.table, `${t.table}-owned`, { regular_price_iqd: 5000, stock: 9 }, true))),
      IMPORT_GUARD_REFUSAL,
      `${t.table}: an upsert that changes the owner's stock`
    );
  }
});

test('the stock decision: not_configured is recorded, a decision is never written or changed inside an import batch', () => {
  const db = raw();
  productRow(db, 'p1');
  productRow(db, 'p2');
  const ins = (pid: string, sid: string, decision: string, by = '', at = '') =>
    db
      .prepare(
        `INSERT INTO ${STOCK_DECISION_GUARD.table} (source, source_product_id, product_id, source_handle, canonical_url, match_kind,
           stock_decision, stock_decided_by, stock_decided_at, fingerprint, fetched_at, import_run_id)
         VALUES ('bambu_us', ?, ?, ?, 'https://us.store.bambulab.com/products/' || ?, 'created', ?, ?, ?, 'f', 't', 'cir_0123456789abcdef01234567')
         ON CONFLICT (source, source_product_id) DO UPDATE SET stock_decision = excluded.stock_decision,
           stock_decided_by = excluded.stock_decided_by, stock_decided_at = excluded.stock_decided_at`
      )
      .run(sid, pid, `h-${sid}`, sid, decision, by, at);
  arm(db);
  ins('p1', '1', 'not_configured');
  ins('p1', '1', 'not_configured'); // an idempotent re-send
  for (const d of STOCK_DECISION_GUARD.refusedOnInsert) {
    assert.equal(refusal(() => ins('p2', '2', d, 'owner', '2026-10-15T00:00:00Z')), IMPORT_GUARD_REFUSAL, `insert ${d}`);
    assert.equal(refusal(() => ins('p1', '1', d, 'owner', '2026-10-15T00:00:00Z')), IMPORT_GUARD_REFUSAL, `upsert to ${d}`);
  }
  for (const c of STOCK_DECISION_GUARD.frozenColumns) {
    assert.equal(
      refusal(() => db.exec(`UPDATE ${STOCK_DECISION_GUARD.table} SET ${c} = 'x' WHERE source_product_id = '1'`)),
      IMPORT_GUARD_REFUSAL,
      `update of ${c}`
    );
  }
  disarm(db);
  // The owner's own action (outside any import batch) records the decision.
  db.exec(
    `UPDATE ${STOCK_DECISION_GUARD.table} SET stock_decision = 'untracked', stock_decided_by = 'owner', stock_decided_at = '2026-10-15T00:00:00Z'
      WHERE source_product_id = '1'`
  );
  arm(db);
  assert.equal(refusal(() => ins('p1', '1', 'not_configured')), IMPORT_GUARD_REFUSAL, 'a re-import cannot reset the owner decision');
});

test('the lease fence aborts a checkpoint from a stale executor', () => {
  const db = raw();
  const run = 'cir_0123456789abcdef01234567';
  db.prepare("INSERT INTO catalog_import_runs (id, source, state) VALUES (?, 'bambu_us', 'running')").run(run);
  db.prepare(
    `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at, lease_token, lease_until)
     VALUES ('i1', ?, 'bambu_us', '1', 'a', 'https://us.store.bambulab.com/products/a', 1, 't', 'lease-A', '2999-01-01T00:00:00.000Z')`
  ).run(run);
  const event = (seq: number, lease: string, stage = 'WRITTEN') =>
    db.prepare(`INSERT INTO catalog_import_events (id, run_id, item_id, seq, stage, outcome, lease_token) VALUES (?, ?, 'i1', ?, ?, 'ok', ?)`).run(`e${seq}`, run, seq, stage, lease);
  event(1, 'lease-A');
  assert.equal(refusal(() => event(2, 'lease-B')), 'IMPORT_LEASE_LOST', 'another executor\'s lease');
  assert.equal(refusal(() => event(3, '')), 'IMPORT_LEASE_LOST', 'no lease');
  db.exec("UPDATE catalog_import_items SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = 'i1'");
  assert.equal(refusal(() => event(4, 'lease-A')), 'IMPORT_LEASE_LOST', 'an expired lease');
  event(5, '', 'EXTRACTING'); // only checkpoint stages are fenced
  db.exec("UPDATE catalog_import_items SET lease_until = '2999-01-01T00:00:00.000Z' WHERE id = 'i1'");
  db.exec(`UPDATE catalog_import_runs SET state = 'closed' WHERE id = '${run}'`);
  assert.equal(refusal(() => event(6, 'lease-A')), 'IMPORT_LEASE_LOST', 'a closed run');
});

test('one active run per source, one item in flight per run', () => {
  const db = raw();
  db.exec("INSERT INTO catalog_import_runs (id, source, state) VALUES ('cir_0123456789abcdef01234567', 'bambu_us', 'open')");
  assert.match(String(refusal(() => db.exec("INSERT INTO catalog_import_runs (id, source, state) VALUES ('cir_76543210fedcba9876543210', 'bambu_us', 'running')"))), /UNIQUE/);
  assert.match(String(refusal(() => db.exec("INSERT INTO catalog_import_runs (id, source, state) VALUES ('run-1', 'bambu_us', 'closed')"))), /CHECK/);
  const item = (id: string, pos: number) =>
    db.exec(
      `INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at)
       VALUES ('${id}', 'cir_0123456789abcdef01234567', 'bambu_us', '${id}', '${id}', 'u', ${pos}, 't')`
    );
  item('a', 1);
  item('b', 2);
  db.exec("UPDATE catalog_import_items SET processing_state = 'EXTRACTING' WHERE id = 'a'");
  assert.match(String(refusal(() => db.exec("UPDATE catalog_import_items SET processing_state = 'EXTRACTING' WHERE id = 'b'"))), /UNIQUE/);
});
