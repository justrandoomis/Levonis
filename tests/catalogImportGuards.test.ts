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
 *     money, stock or package value aborts, and so does a REPLACE that puts a
 *     priced row back; an upsert whose DO UPDATE would change one aborts; an
 *     UPDATE of one aborts; the same rows at their defaults, or re-sent
 *     unchanged — through the real planner's merge, with held units, a
 *     recorded cost and a stored measure the wire body does not carry — go
 *     through; no source writes these tables with REPLACE;
 *   - a warranty fee or a route commission inside products' JSON columns can
 *     be neither set nor changed, while a re-serialisation that keeps them can;
 *   - the stock decision can be recorded as not_configured, never as a
 *     decision, and never changed;
 *   - without the guard row nothing changes: the same writes are not refused
 *     by these triggers;
 *   - the lease fence refuses a checkpoint from a stale executor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, row } from './fixtures/app';
import { planProductSave } from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';
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
  const FEES: Record<string, string> = {
    warranty_plans: '[{"id":"wp1","fee_iqd":50000,"fee_percent":null,"active":true}]',
    preorder_transports: '[{"method":"land","commission_iqd":9000,"active":true}]',
  };
  for (const c of [...products.money, ...products.stock, ...products.package]) {
    const value = c.insertDefault === 'empty_object' ? '{"prime":1}' : c.insertDefault === 'empty_array' ? FEES[c.name] : 7;
    assert.ok(value !== undefined, `${c.name}: the test needs a priced value for this column`);
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
  // REPLACE over an existing priced row with a different price: refused (the row the REPLACE puts back is not at
  // its defaults, and AFTER INSERT fires for it).
  assert.equal(
    refusal(() => db.exec("INSERT OR REPLACE INTO products (id, slug, name, price_iqd, stock) VALUES ('p-ok', 'p-ok', 'p-ok', 2000, 3)")),
    IMPORT_GUARD_REFUSAL
  );
});

/**
 * THE TWO MONEY-BEARING JSON COLUMNS OF products (review 4, finding 5): the
 * price of an extended warranty and the commission of a pre-order route. A new
 * import row carries neither; a merge may re-serialise them (the save path
 * upgrades a legacy plan and re-orders keys) but never move a fee.
 */
test('products: warranty fees and route commissions cannot be set or changed; a re-serialisation that keeps them passes', () => {
  const db = raw();
  disarm(db);
  db.prepare(
    "INSERT INTO products (id, slug, name, status, warranty_plans, preorder_transports) VALUES ('p-w', 'p-w', 'W', 'active', ?, ?)"
  ).run('[{"name":"Extended","price_iqd":50000}]', '[{"method":"land","commission_iqd":9000}]');
  arm(db);
  const set = (w: string, t: string) =>
    refusal(() => db.prepare("UPDATE products SET warranty_plans = ?, preorder_transports = ? WHERE id = 'p-w'").run(w, t));
  // What upgradeWarranty / upgradeTransports write back for the same plans: same fees, other text.
  const upgradedW =
    '[{"id":"wp_legacy_0","title_ar":"Extended","title_en":"","title_ckb":"","terms_ar":"","terms_en":"","terms_ckb":"",' +
    '"duration_months":12,"duration_kind":"total","fee_iqd":50000,"fee_percent":null,"order":0,"active":true}]';
  const upgradedT = '[{"method":"land","commission_iqd":9000,"active":true}]';
  assert.equal(set(upgradedW, upgradedT), null, 'a re-serialisation that keeps every fee is not a change');
  assert.equal(set(upgradedW.replace('50000', '60000'), upgradedT), IMPORT_GUARD_REFUSAL, 'a warranty fee changed');
  assert.equal(set(upgradedW.replace('"fee_percent":null', '"fee_percent":5'), upgradedT), IMPORT_GUARD_REFUSAL, 'a warranty percentage set');
  assert.equal(set(upgradedW.replace('"active":true', '"active":false'), upgradedT), IMPORT_GUARD_REFUSAL, 'a priced plan switched off');
  assert.equal(set('[]', upgradedT), IMPORT_GUARD_REFUSAL, 'a priced plan removed');
  assert.equal(
    set(upgradedW.replace(']', ',{"id":"wp2","fee_iqd":0,"fee_percent":null,"active":true}]'), upgradedT),
    IMPORT_GUARD_REFUSAL,
    'a plan added, even a free one'
  );
  assert.equal(set(upgradedW, upgradedT.replace('9000', '9500')), IMPORT_GUARD_REFUSAL, 'a route commission changed');
  assert.equal(set(upgradedW, upgradedT.replace('land', 'air')), IMPORT_GUARD_REFUSAL, 'a commission moved to another route');
  assert.equal(set(upgradedW, '[]'), IMPORT_GUARD_REFUSAL, 'a route removed');
  for (const [w, t] of [
    ['[{"fee_iqd":0}]', '[]'],
    ['[]', '[{"method":"land","commission_iqd":0}]'],
  ]) {
    assert.equal(
      refusal(() => db.prepare("INSERT INTO products (id, slug, name, warranty_plans, preorder_transports) VALUES ('p-n', 'p-n', 'N', ?, ?)").run(w, t)),
      IMPORT_GUARD_REFUSAL,
      `a new import row carries no warranty plan and no route: ${w} ${t}`
    );
  }
  db.exec("INSERT INTO products (id, slug, name, warranty_plans, preorder_transports) VALUES ('p-n', 'p-n', 'N', '[]', '[]')");
  disarm(db);
  assert.equal(set(upgradedW.replace('50000', '60000'), '[]'), null, 'outside an import batch the owner edits them freely');
});

/**
 * REPLACE IS NOT A WRITE PATH (review 4, finding 1). The AFTER INSERT guard
 * refuses a REPLACE that puts a priced row back; one that resets an existing
 * row to the defaults deletes the old row without firing any trigger, so the
 * guarantee for that shape is that nothing writes these tables with REPLACE —
 * read from the sources here — plus §E.4's per-write fingerprint.
 */
test('no Worker or package source writes a guarded catalogue table with REPLACE', () => {
  const guarded = GUARDED_ROW_TABLES.map((t) => t.table).join('|');
  const replace = new RegExp(`\\b(?:INSERT\\s+OR\\s+REPLACE|REPLACE)\\s+INTO\\s+["\`]?(?:${guarded})\\b`, 'i');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && replace.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(ROOT.length + 1));
    }
  };
  for (const dir of ['worker', 'packages', 'scripts']) walk(join(ROOT, dir));
  assert.deepEqual(offenders, []);
  // The pattern itself is live.
  assert.ok(replace.test('INSERT OR REPLACE INTO product_variants (id) VALUES (1)'));
  assert.ok(replace.test('replace into products (id) values (1)'));
  assert.ok(!replace.test('INSERT INTO product_variants (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET stock = excluded.stock'));
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
    // An upsert that re-sends the owner's figures unchanged goes through (the real planner's merge: below).
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

/**
 * THE MERGE OF §E.3, THROUGH THE REAL PLANNER (review 4, finding 1).
 *
 * The planner's upserts never list `reserved`, bind a variant's cost as NULL
 * when the actor has no cost write (actor.money = false, as §E.3 requires),
 * and bind NULL for a dimension the wire body omits — and their ON CONFLICT
 * DO UPDATE leaves all three alone. A BEFORE INSERT guard that compared the
 * INSERT's NEW row with the stored one therefore refused every merge of a
 * product holding a reservation, a recorded variant cost or a stored measure,
 * although nothing would have changed. An upsert is judged by the BEFORE
 * UPDATE OF guard, which sees the row the DO UPDATE actually writes.
 */
test('a merge through the real planner (actor.money = false) passes over reserved units, a variant cost and a stored measure', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('boss', 'B', 'b@x.co', 'h', 'admin');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, options, colors, images, inventory_mode)
      VALUES ('p_m', 'p-m', 'A1', 'ايه1', 'ئەی١', 'active', '[]', '[]', '[]', 'OPTION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_m', 'p_m', 'Size', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, reserved, regular_price_iqd)
      VALUES ('v_std', 'p_m', 'g_m', 'Standard', 0, 1, 5, 2, 1000);
    INSERT INTO product_variants (id, product_id, combo_key, active, stock, regular_price_iqd, cost_iqd, package_weight_g)
      VALUES ('x_std', 'p_m', 'o:v_std', 1, 5, 1000, 700, 900);
  `);
  const db = asD1(raw);
  // The stored relations as the wire body (§E.3): no `reserved` (the wire has
  // none), no cost (the actor has no cost write) and no package_weight_g key.
  const body = {
    inventory_mode: 'OPTION',
    groups: [
      {
        id: 'g_m', name_en: 'Size', sort: 0, active: true,
        values: [{ id: 'v_std', name_en: 'Standard', sort: 0, active: true, stock: 5, regular_price_iqd: 1000 }],
      },
    ],
    colors: [],
    variants: [{ id: 'x_std', option_value_ids: ['v_std'], active: true, stock: 5, regular_price_iqd: 1000 }],
  };
  const stored = row<Record<string, unknown>>(raw, "SELECT * FROM products WHERE id = 'p_m'")!;
  const plan = await planProductSave(db, {
    mode: 'update',
    doc: null,
    prev: parseProductRow(stored),
    relations: body,
    actor: { adminId: 'boss', money: false },
  });
  const guard = (sql: string) => db.prepare(sql).bind(IMPORT_GUARD_ID);
  const batch = () =>
    db.batch([guard('INSERT INTO ops_guards (id, ok) VALUES (?, 1)'), ...plan.statements, guard('DELETE FROM ops_guards WHERE id = ?')]);
  await batch(); // an import batch: guard row first, the planner's statements, guard row last
  assert.deepEqual(
    { ...row<Record<string, unknown>>(raw, "SELECT stock, reserved, regular_price_iqd FROM product_option_values WHERE id = 'v_std'")! },
    { stock: 5, reserved: 2, regular_price_iqd: 1000 },
    'the held units and the price are untouched'
  );
  assert.deepEqual(
    { ...row<Record<string, unknown>>(raw, "SELECT stock, regular_price_iqd, cost_iqd, package_weight_g FROM product_variants WHERE id = 'x_std'")! },
    { stock: 5, regular_price_iqd: 1000, cost_iqd: 700, package_weight_g: 900 },
    'the recorded cost and the stored measure are kept'
  );
  // The same planner shape that WOULD move a figure is still refused (a stock
  // figure: the planner itself pins every dinar price under Pricing V2).
  const changed = await planProductSave(db, {
    mode: 'update',
    doc: null,
    prev: parseProductRow(stored),
    relations: { ...body, variants: [{ ...body.variants[0], stock: 6 }] },
    actor: { adminId: 'boss', money: false },
  });
  await assert.rejects(
    () => db.batch([guard('INSERT INTO ops_guards (id, ok) VALUES (?, 1)'), ...changed.statements, guard('DELETE FROM ops_guards WHERE id = ?')]),
    (e: Error) => e.message.includes(IMPORT_GUARD_REFUSAL)
  );
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?", IMPORT_GUARD_ID)!.n, 0, 'the refused batch left no guard row behind');
});

/**
 * THE SAME MERGE WITH THE PRODUCT DOCUMENT (§E.3: "prev = doc from the row"),
 * on a product whose warranty plan is still the legacy `{name, price_iqd}`
 * shape and whose route commission has no `active` key. The planner writes
 * both columns back re-serialised — other text, the same fees — which is why
 * the guard compares their money and not their text (review 4, finding 5).
 * A document that moves a warranty fee is refused by the guard; a moved route
 * commission never reaches it (the planner puts the stored one back,
 * pinLegacyDocMoney), and a raw write of one is refused above.
 */
test('a full-document merge re-serialises warranty plans and route commissions without moving a fee; a moved fee is refused', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id, name, email, password_hash, role) VALUES ('boss', 'B', 'b@x.co', 'h', 'admin');
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, options, colors, images, inventory_mode, warranty_plans, preorder_transports)
      VALUES ('p_w', 'p-w', 'A1', 'ايه1', 'ئەی١', 'active', '[]', '[]', '[]', 'BASE',
              '[{"name":"Extended","price_iqd":50000}]', '[{"method":"land","commission_iqd":9000}]');
  `);
  const db = asD1(raw);
  const stored = row<Record<string, unknown>>(raw, "SELECT * FROM products WHERE id = 'p_w'")!;
  const guard = (sql: string) => db.prepare(sql).bind(IMPORT_GUARD_ID);
  const inBatch = async (doc: ReturnType<typeof parseProductRow>) => {
    const plan = await planProductSave(db, { mode: 'update', doc, prev: parseProductRow(stored), relations: null as never, actor: { adminId: 'boss', money: false } });
    return db.batch([guard('INSERT INTO ops_guards (id, ok) VALUES (?, 1)'), ...plan.statements, guard('DELETE FROM ops_guards WHERE id = ?')]);
  };
  await inBatch(parseProductRow(stored));
  const after = row<{ warranty_plans: string; preorder_transports: string }>(raw, "SELECT warranty_plans, preorder_transports FROM products WHERE id = 'p_w'")!;
  assert.notEqual(after.warranty_plans, stored.warranty_plans, 'the save re-serialised the legacy plan');
  assert.equal((JSON.parse(after.warranty_plans) as Array<{ fee_iqd: number }>)[0].fee_iqd, 50000, 'with the same fee');
  assert.equal((JSON.parse(after.preorder_transports) as Array<{ commission_iqd: number }>)[0].commission_iqd, 9000);

  const moved = parseProductRow(stored);
  moved.warranty_plans = moved.warranty_plans.map((w) => ({ ...w, fee_iqd: 60000 }));
  await assert.rejects(() => inBatch(moved), (e: Error) => e.message.includes(IMPORT_GUARD_REFUSAL), 'a warranty fee moved inside an import batch');
  const commission = parseProductRow(stored);
  commission.preorder_transports = commission.preorder_transports.map((t) => ({ ...t, commission_iqd: 9500 }));
  await inBatch(commission);
  const kept = row<{ warranty_plans: string; preorder_transports: string }>(raw, "SELECT warranty_plans, preorder_transports FROM products WHERE id = 'p_w'")!;
  assert.equal((JSON.parse(kept.preorder_transports) as Array<{ commission_iqd: number }>)[0].commission_iqd, 9000, 'the stored commission stands');
  assert.equal((JSON.parse(kept.warranty_plans) as Array<{ fee_iqd: number }>)[0].fee_iqd, 50000, 'and the refused warranty fee never landed');
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
