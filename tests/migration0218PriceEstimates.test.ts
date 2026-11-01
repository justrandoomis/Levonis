/**
 * MIGRATION 0218 — ESTIMATED PRE-ORDER PRICES, PROVEN ON THE REAL SCHEMA
 * (docs/SMART_PRICING.md §2 and §10; owner answers D1–D4 of 2026-10-31;
 * DECISIONS rows 278–282).
 *
 *   harness      scripts/migrate-check.mjs --twice is green, and 0218's own
 *                re-runnable statements change nothing on a migrated database;
 *                the file is additive (two defaulted columns, twelve tables)
 *   seed         thirteen types in three languages with every figure NULL; the
 *                owner's switches start «apply» off and «ordering» on
 *   CHECKs       source ↔ currency, the decimal grammars, filament sea-only,
 *                EU land-only, air only where allowed, a pack divided only by
 *                the owner, one current snapshot per source, `confirmed` ⇒ real
 *                measures, the estimate line's settlement shape
 *   label        T1 set only inside 'engine-price:<id>'; T2 cleared only after
 *                the owner's confirmation on real measures; T3 no product born
 *                labelled; T4 a firm SKU only on a labelled product
 *   overrides    T5 the type's route rules on insert and update
 *   checkout     T6 a labelled line only inside 'estimate-checkout:<order>';
 *                T7 estimate rows only in that batch, for a line of that order,
 *                and frozen afterwards
 *   gate         T8 no confirm, preparation, shipping or courier while a line
 *                is open, proposed or rejected; cancel and pending touches pass
 *   lifecycle    T9 no reopening; T10 cancel voids; T11 every 0140 decision
 *                reaches its lines, and the 0140 fences never fire it
 *   import       the 36 guard triggers refuse inside an import batch only
 *   deploy-ahead on a 0217 database the leaf guards answer as today
 *
 * LOCAL ONLY: in-memory SQLite and a temporary directory, no network.
 *
 * Run: node --import tsx --test tests/migration0218PriceEstimates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { asD1, count, dbThrough, freshDb, hasColumn, row } from './fixtures/app';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';
import { LATE_PROTECTED_TABLES, IMPORT_GUARD_ID, IMPORT_GUARD_REFUSAL } from '../worker/lib/catalogImport/protectedTables';
import {
  estimateAbsentLately,
  estimateClause,
  estimateClauseFor,
  isEstimateRow,
  isMissingEstimateSchema,
  priceEstimatesInstalled,
  rememberEstimateAbsent,
  runWithEstimateClause,
  withoutEstimateClause,
} from '../worker/lib/priceEstimateLabel';
import {
  estimateCheckoutGuardId,
  hasOpenEstimates,
  isEstimateGateAbort,
  isEstimateReopenAbort,
} from '../worker/lib/priceEstimateGate';
import { ESTIMATE_DB_ABORTS, ESTIMATE_UNSETTLED_STATES } from '../packages/contracts/src/priceEstimates';

const FILE = '0218_price_estimates.sql';
const SQL = readFileSync(join(ROOT, 'migrations', FILE), 'utf8');
const NOW = '2026-10-31T12:00:00.000Z';
const SHA = 'a'.repeat(64);

const A = ESTIMATE_DB_ABORTS;

/** Runs `sql` inside a savepoint: on a refusal nothing it did stays (a token included). */
function run(db: DatabaseSync, sql: string): void {
  db.exec('SAVEPOINT t');
  try {
    db.exec(sql);
    db.exec('RELEASE t');
  } catch (e) {
    db.exec('ROLLBACK TO t');
    db.exec('RELEASE t');
    throw e;
  }
}

/** The refusal's message, or null when the statement went through. */
function refusal(db: DatabaseSync, sql: string): string | null {
  try {
    run(db, sql);
    return null;
  } catch (e) {
    return String((e as Error).message);
  }
}

function refused(db: DatabaseSync, sql: string, message: string | RegExp): void {
  const got = refusal(db, sql);
  assert.ok(got !== null, `went through: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  if (typeof message === 'string') assert.equal(got, message, sql.replace(/\s+/g, ' ').slice(0, 160));
  else assert.match(got!, message, sql.replace(/\s+/g, ' ').slice(0, 160));
}

function passes(db: DatabaseSync, sql: string): void {
  assert.equal(refusal(db, sql), null, sql.replace(/\s+/g, ' ').slice(0, 160));
}

const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;
/** A lost fence writes NULL into a NOT NULL column (worker/lib/orderDeletion.ts and others); only that check may answer. */
const nullFence = (table: string, column: string, id: string) =>
  `UPDATE ${table} SET ${column} = CASE WHEN 0 THEN ${column} ELSE NULL END WHERE id = '${id}'`;
const notNull = (table: string, column: string) => `NOT NULL constraint failed: ${table}.${column}`;
const withToken = (token: string, sql: string) =>
  `INSERT INTO ops_guards (id, ok) VALUES ('${token}', 1); ${sql}; DELETE FROM ops_guards WHERE id = '${token}';`;
const priced = (pid: string, sql: string) => withToken(`engine-price:${pid}`, sql);

// ------------------------------------------------------------------ the world

function world(): DatabaseSync {
  const db = freshDb();
  db.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'customer@example.test');
    INSERT INTO products (id, slug, name, status) VALUES ('p_est', 'p-est', 'Estimated', 'active'), ('p_plain', 'p-plain', 'Plain', 'active');
  `);
  return db;
}

/** Labels a product the only way there is: inside the V2 writer's token. */
const label = (db: DatabaseSync, pid: string) => passes(db, priced(pid, `UPDATE products SET price_estimate = 1 WHERE id = '${pid}'`));

function order(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id,
       subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at)
     VALUES (?, 'u1', 'pending', '{}', 'delivery', '{}', 'cod', 35000, 1500, 35000, 35000, ?, ?)`
  ).run(id, NOW, NOW);
}

const itemSql = (orderId: string, itemId: string, pid: string | null, qty = 1) =>
  `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
   VALUES ('${itemId}', '${orderId}', ${pid === null ? 'NULL' : `'${pid}'`}, 'Line', ${qty}, 17500, ${17500 * qty})`;

const estimateRowSql = (orderId: string, itemId: string, pid: string, qty = 1) =>
  `INSERT INTO order_price_estimates (order_item_id, order_id, product_id, combo_key, channel, qty, estimate_unit_iqd, notice_version, created_at)
   VALUES ('${itemId}', '${orderId}', '${pid}', '', 'pre_order_sea', ${qty}, 17500, 1, '${NOW}')`;

/** The checkout batch's shape (docs/SMART_PRICING.md §6.3): token, lines, estimate rows, token gone. */
function checkout(db: DatabaseSync, orderId: string, lines: Array<{ item: string; pid: string; qty?: number }>): void {
  const parts = [
    ...lines.map((l) => itemSql(orderId, l.item, l.pid, l.qty ?? 1)),
    ...lines.map((l) => estimateRowSql(orderId, l.item, l.pid, l.qty ?? 1)),
  ];
  passes(db, withToken(estimateCheckoutGuardId(orderId), parts.join(';\n')));
}

const lineState = (db: DatabaseSync, item: string) =>
  row<{ state: string; final_unit_iqd: number | null; adjustment_id: string | null; decided_by: string; decided_at: string | null }>(
    db,
    'SELECT state, final_unit_iqd, adjustment_id, decided_by, decided_at FROM order_price_estimates WHERE order_item_id = ?',
    item
  )!;

/** A pending 0140 proposal on `orderId` (the row only: the hold is 0140's business, not 0218's). */
function proposal(db: DatabaseSync, id: string, orderId: string): void {
  db.prepare(
    `INSERT INTO order_price_adjustments (id, order_id, user_id, state, old_total_iqd, new_total_iqd, delta_iqd, old_due_iqd, new_due_iqd,
       old_wallet_iqd, new_wallet_iqd, wallet_refund_iqd, reason, proposed_by, idempotency_key)
     VALUES (?, ?, 'u1', 'pending', 35000, 36000, 1000, 35000, 36000, 0, 0, 0, 'Final price', 'admin', ?)`
  ).run(id, orderId, `key-${id}`);
}

// ------------------------------------------------------------------ the harness

test('scripts/migrate-check.mjs --twice: every migration applies, the second pass is a no-op, no FK violation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-mc-0218-'));
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
    // While 0218 is the newest file, the harness re-runs ITS statements; the next test proves the same
    // on its own, so it keeps proving it after a later migration lands.
    const newest = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort().at(-1);
    if (newest === FILE) assert.match(out, new RegExp(`✔ ${FILE.replace('.', '\\.')}: \\d+ idempotent statement\\(s\\) re-ran — no row added, no value changed, no trigger changed`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const isRerunnable = (s: string) => /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS /i.test(s) || /^INSERT OR IGNORE INTO /i.test(s);

test('the file is additive and re-runnable: two ADD COLUMNs, and everything else is IF NOT EXISTS or INSERT OR IGNORE', () => {
  const statements = splitStatements(SQL) as string[];
  const alters = statements.filter((s) => /^ALTER TABLE/i.test(s));
  assert.deepEqual(
    alters.map((s) => /^ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(s)?.slice(1, 3).join('.')),
    ['products.price_estimate', 'order_price_adjustments.reason_code']
  );
  const other = statements.filter((s) => !/^ALTER TABLE/i.test(s) && !isRerunnable(s));
  assert.deepEqual(other, [], 'a statement that is neither an ADD COLUMN nor re-runnable');
  assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ''), /\bDROP\s|\bRENAME\b/i, 'nothing is dropped or renamed');
  assert.match(SQL.trimEnd(), /;$/, 'the file ends with a terminated statement (the live apply appends its bookkeeping INSERT)');
});

test("re-running 0218's statements on a migrated database changes no object and no seeded row", () => {
  const db = freshDb();
  const objects = () => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all());
  const seeds = () => JSON.stringify([...db.prepare('SELECT * FROM price_estimate_types ORDER BY key').all(), ...db.prepare('SELECT * FROM price_estimate_control').all()]);
  const before = [objects(), seeds()];
  const again = (splitStatements(SQL) as string[]).filter(isRerunnable);
  assert.ok(again.length >= 60, `only ${again.length} re-runnable statements`);
  db.exec('BEGIN');
  for (const s of again) db.exec(s);
  db.exec('COMMIT');
  assert.deepEqual([objects(), seeds()], before);
});

test('over a populated 0217 database: existing rows read the defaults, and nothing else moves', () => {
  const db = dbThrough('0217');
  assert.equal(hasColumn(db, 'products', 'price_estimate'), false, 'the fixture really is one migration behind');
  db.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'customer@example.test');
    INSERT INTO products (id, slug, name, status) VALUES ('p_old', 'p-old', 'Old', 'active');
  `);
  order(db, 'ord_old');
  proposal(db, 'padj_old', 'ord_old');
  const productsBefore = JSON.stringify(db.prepare('SELECT * FROM products').all());
  db.exec(SQL);
  assert.equal(row<{ v: number }>(db, "SELECT price_estimate AS v FROM products WHERE id = 'p_old'")!.v, 0);
  assert.equal(row<{ v: string }>(db, "SELECT reason_code AS v FROM order_price_adjustments WHERE id = 'padj_old'")!.v, '');
  const productsAfter = (db.prepare('SELECT * FROM products').all() as Array<Record<string, unknown>>).map(({ price_estimate: _, ...rest }) => rest);
  assert.equal(JSON.stringify(productsAfter), productsBefore, 'only the new column was added');
});

// ------------------------------------------------------------------ seed and shape

const TWELVE = [
  'supplier_price_snapshots', 'supplier_price_items', 'supplier_price_skus', 'supplier_price_keys', 'supplier_price_matches',
  'supplier_price_manual', 'price_estimate_types', 'price_estimate_control', 'product_price_estimates', 'price_estimate_lines',
  'price_estimate_firm_skus', 'order_price_estimates',
];

test('the twelve tables exist, the late-protected list names exactly them, and the label columns read their defaults', () => {
  const db = freshDb();
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  for (const t of TWELVE) assert.ok(tables.has(t), `${t} is missing`);
  assert.deepEqual(LATE_PROTECTED_TABLES.map((t) => t.table).sort(), [...TWELVE].sort());
  for (const t of LATE_PROTECTED_TABLES) assert.equal(t.guardedBy, FILE);
  const col = (table: string, name: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown }>).find((c) => c.name === name)!;
  assert.deepEqual({ ...col('products', 'price_estimate') }, { ...col('products', 'price_estimate'), notnull: 1, dflt_value: '0' });
  assert.deepEqual({ ...col('order_price_adjustments', 'reason_code') }, { ...col('order_price_adjustments', 'reason_code'), notnull: 1, dflt_value: "''" });
  db.exec("INSERT INTO products (id, slug, name) VALUES ('p_new', 'p-new', 'New')");
  assert.equal(row<{ v: number }>(db, "SELECT price_estimate AS v FROM products WHERE id = 'p_new'")!.v, 0);
  refused(db, "UPDATE products SET price_estimate = 2 WHERE id = 'p_new'", CHECK);
});

const SORANI_ONLY = /[ڕڵێۆەڤگچپژ]/;
const ARABIC_ONLY = /[ةىيك]/;
const ARABIC_SCRIPT = /[؀-ۿ]/;

test('the seed: thirteen types routed as the owner decided, named in three languages, with every figure NULL', () => {
  const db = freshDb();
  const types = db.prepare('SELECT * FROM price_estimate_types ORDER BY key').all() as Array<Record<string, unknown>>;
  const routing = Object.fromEntries(types.map((t) => [t.key, `${t.sourcing}/${t.route}/air=${t.allow_air}/us=${t.us_reference_allowed}`]));
  assert.deepEqual(routing, {
    printer: 'EU_STORE_EUR/land/air=0/us=1',
    ams: 'EU_STORE_EUR/land/air=0/us=1',
    laser_machine: 'EU_STORE_EUR/land/air=0/us=1',
    electronics_device: 'EU_STORE_EUR/land/air=0/us=1',
    electronics_part: 'EU_STORE_EUR/land/air=0/us=1',
    filament: 'CHINA_CNY/sea/air=0/us=0',
    filament_pack: 'CHINA_CNY/sea/air=0/us=0',
    spare_part: 'CHINA_CNY/sea/air=1/us=0',
    hotend: 'CHINA_CNY/sea/air=1/us=0',
    build_plate: 'CHINA_CNY/sea/air=1/us=0',
    accessory: 'CHINA_CNY/sea/air=1/us=0',
    makers_supply: 'CHINA_CNY/sea/air=1/us=0',
    laser_material: 'CHINA_CNY/sea/air=1/us=0',
  });
  for (const t of types) {
    // Nothing hard-coded: every measure, extra cost and minimum profit waits for the owner.
    for (const f of ['default_weight_g', 'default_length_mm', 'default_width_mm', 'default_height_mm', 'default_cbm', 'additional_cost_iqd', 'min_profit_usd']) {
      assert.equal(t[f], null, `${t.key}.${f} is seeded`);
    }
    assert.equal(t.stale_after_days, 60);
    assert.equal(t.version, 1);
    assert.match(String(t.updated_at), /^\d{4}-\d\d-\d\dT/);
    // DECISIONS row 183: its own Sorani, never the Arabic or the English.
    assert.notEqual(t.name_ckb, t.name_ar, `${t.key}: the Sorani is the Arabic`);
    assert.notEqual(t.name_ckb, t.name_en, `${t.key}: the Sorani is the English`);
    assert.match(String(t.name_ckb), SORANI_ONLY, `${t.key}: no Sorani-only letter`);
    assert.doesNotMatch(String(t.name_ckb), ARABIC_ONLY, `${t.key}: an Arabic-only letter in the Sorani`);
    assert.match(String(t.name_ar), ARABIC_SCRIPT, `${t.key}: the Arabic is not Arabic script`);
    assert.doesNotMatch(String(t.name_en), ARABIC_SCRIPT, `${t.key}: Arabic script in the English`);
  }
  assert.deepEqual({ ...row(db, 'SELECT id, apply_enabled, ordering_enabled, version FROM price_estimate_control')! }, { id: 1, apply_enabled: 0, ordering_enabled: 1, version: 1 });
  refused(db, 'INSERT INTO price_estimate_control (id) VALUES (2)', CHECK);
});

// ------------------------------------------------------------------ CHECKs

test('snapshots: the source fixes the currency, completion is dated, one current snapshot per source', () => {
  const db = freshDb();
  const snap = (id: string, source: string, currency: string, state = 'loading', completed: string | null = null) =>
    `INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, state, created_by, created_at, completed_at)
     VALUES ('${id}', '${source}', '${currency}', 'store_script', '2026-10-31', '${SHA}', '${state}', 'owner', '${NOW}', ${completed === null ? 'NULL' : `'${completed}'`})`;
  passes(db, snap('sps_cn', 'tmall_cn', 'CNY'));
  passes(db, snap('sps_eu', 'bambu_eu', 'EUR'));
  passes(db, snap('sps_us', 'bambu_us', 'USD'));
  // A geo-redirected "EU" capture carrying dollars is never stored as EUR, nor as an EU snapshot at all.
  refused(db, snap('sps_x1', 'bambu_eu', 'USD'), CHECK);
  refused(db, snap('sps_x2', 'tmall_cn', 'USD'), CHECK);
  refused(db, snap('sps_x3', 'bambu_us', 'EUR'), CHECK);
  refused(db, snap('bad_id', 'tmall_cn', 'CNY'), CHECK);
  refused(db, snap('sps_x4', 'tmall_cn', 'CNY', 'complete'), CHECK);
  passes(db, snap('sps_c1', 'tmall_cn', 'CNY', 'complete', NOW));
  refused(db, snap('sps_c2', 'tmall_cn', 'CNY', 'complete', NOW), UNIQUE);
  passes(db, snap('sps_s1', 'tmall_cn', 'CNY', 'superseded', NOW));
  refused(db, `UPDATE supplier_price_snapshots SET price_basis = 'gross' WHERE id = 'sps_eu'`, CHECK);
  passes(db, `UPDATE supplier_price_snapshots SET price_basis = 'net_of_vat' WHERE id = 'sps_eu'`);
});

test('items, SKUs and keys: decimal prices as text, strict JSON shapes, a cascade from the snapshot', () => {
  const db = freshDb();
  db.exec(`INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, created_by, created_at)
           VALUES ('sps_1', 'tmall_cn', 'CNY', 'browser_sweep', '2026-10-31', '${SHA}', 'owner', '${NOW}')`);
  passes(db, `INSERT INTO supplier_price_items (snapshot_id, item_key, url, page_host, title, codes_json, props_json)
              VALUES ('sps_1', '1053109777521', 'https://detail.tmall.com/item.htm?id=1053109777521', 'detail.tmall.com', '拓竹 ZH121', '["ZH121"]', '[]')`);
  refused(db, "INSERT INTO supplier_price_items (snapshot_id, item_key, codes_json) VALUES ('sps_1', 'i2', '{}')", CHECK);
  refused(db, "INSERT INTO supplier_price_items (snapshot_id, item_key, sourcing_hint) VALUES ('sps_1', 'i3', 'EU')", CHECK);
  const sku = (key: string, price: string) =>
    `INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, options_json, price, price_label) VALUES ('sps_1', '1053109777521', '${key}', '{"商品规格":"1套"}', '${price}', '优惠前')`;
  for (const ok of ['99', '241', '69.00', '0.5', '12345678901234567890.12']) passes(db, sku(`ok_${ok}`, ok));
  for (const bad of ['0', '0.0', '-5', '1.', '.5', '1.2.3', '1e3', 'abc', ' 9', '9 ', '1234567890123456789012345']) refused(db, sku(`bad_${bad}`, bad), CHECK);
  refused(db, "INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, options_json, price) VALUES ('sps_1', '1053109777521', 's9', '[]', '9')", CHECK);
  refused(db, "INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price, pack_units) VALUES ('sps_1', '1053109777521', 's10', '9', 0)", CHECK);
  refused(db, "INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_1', 'no_item', 's11', '9')", /FOREIGN KEY/);
  passes(db, "INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key) VALUES ('sps_1', 'part_code', 'ZH121', '1053109777521')");
  refused(db, "INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key) VALUES ('sps_1', 'colour', 'x', '1')", CHECK);
  // Discarding a snapshot takes its items, SKUs and keys with it.
  passes(db, "DELETE FROM supplier_price_snapshots WHERE id = 'sps_1'");
  for (const t of ['supplier_price_items', 'supplier_price_skus', 'supplier_price_keys']) assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${t}`), 0, t);
});

test('matches and manual prices: a pack is divided only by the owner, one confirmed match per SKU and source, evidence for a page', () => {
  const db = world();
  const match = (sku: string, state: string, by: string, units = 1, confidence = 'high', combo = '') =>
    `INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, units_per_offer, state,
       decided_by, decided_at, found_in_snapshot, updated_at)
     VALUES ('p_est', '${combo}', 'tmall_cn', 'item1', '${sku}', '${confidence}', 'part_code', ${units}, '${state}', '${by}', '${by ? NOW : ''}', 'sps_1', '${NOW}')`;
  passes(db, match('s1', 'suggested', ''));
  refused(db, match('s2', 'confirmed', ''), CHECK);
  passes(db, match('s3', 'confirmed', 'auto'));
  refused(db, match('s4', 'confirmed', 'admin_owner'), UNIQUE);
  // A 10-pack is never divided silently: not suggested, not automatic — only the owner's confirmation.
  refused(db, match('s5', 'suggested', '', 10, 'high', 'o:v2'), CHECK);
  refused(db, match('s6', 'confirmed', 'auto', 10, 'high', 'o:v3'), CHECK);
  passes(db, match('s7', 'confirmed', 'admin_owner', 10, 'high', 'o:v4'));
  refused(db, match('s8', 'confirmed', 'admin_owner', 1001, 'high', 'o:v5'), CHECK);
  refused(db, match('s9', 'suggested', '', 1, 'certain', 'o:v6'), CHECK);
  const manual = (combo: string, origin: string, url: string, host: string, amount = '69.5', currency = 'CNY') =>
    `INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, origin, evidence_url, evidence_host, entered_by, entered_at)
     VALUES ('p_est', '${combo}', '${amount}', '${currency}', '${origin}', '${url}', '${host}', 'admin_owner', '${NOW}')`;
  passes(db, manual('', 'typed', '', ''));
  refused(db, manual('o:a', 'store_page', '', ''), CHECK);
  passes(db, manual('o:b', 'store_page', 'https://eu.store.bambulab.com/products/a1', 'eu.store.bambulab.com', '299', 'EUR'));
  refused(db, manual('o:c', 'typed', '', '', '0'), CHECK);
  refused(db, manual('o:d', 'typed', '', '', '10', 'IQD'), CHECK);
  // The product's own rows go with it.
  db.exec("DELETE FROM products WHERE id = 'p_est'");
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM supplier_price_matches'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM supplier_price_manual'), 0);
});

test('types: EU means land, filament means sea, air only where allowed, figures in their grammars', () => {
  const db = freshDb();
  const type = (key: string, sourcing: string, route: string, air = 0, us = 0) =>
    `INSERT INTO price_estimate_types (key, name_ar, name_en, name_ckb, sourcing, route, allow_air, us_reference_allowed, updated_at)
     VALUES ('${key}', 'نوع', 'Type', 'جۆر', '${sourcing}', '${route}', ${air}, ${us}, '${NOW}')`;
  passes(db, type('drone', 'EU_STORE_EUR', 'land', 0, 1));
  passes(db, type('cable', 'CHINA_CNY', 'air', 1));
  refused(db, type('eu_sea', 'EU_STORE_EUR', 'sea'), CHECK);
  refused(db, type('cn_land', 'CHINA_CNY', 'land'), CHECK);
  refused(db, type('eu_air', 'EU_STORE_EUR', 'land', 1), CHECK);
  refused(db, type('cn_air_closed', 'CHINA_CNY', 'air', 0), CHECK);
  refused(db, type('cn_us', 'CHINA_CNY', 'sea', 0, 1), CHECK);
  refused(db, type('Bad-Key', 'CHINA_CNY', 'sea'), CHECK);
  refused(db, "INSERT INTO price_estimate_types (key, name_ar, name_en, name_ckb, sourcing, route, updated_at) VALUES ('copy', 'نوع', 'Type', 'نوع', 'CHINA_CNY', 'sea', 't')", CHECK);
  // Filament is sea only, by type, whatever is tried.
  refused(db, "UPDATE price_estimate_types SET route = 'air', allow_air = 1 WHERE key = 'filament'", CHECK);
  refused(db, "UPDATE price_estimate_types SET allow_air = 1 WHERE key = 'filament_pack'", CHECK);
  refused(db, "UPDATE price_estimate_types SET sourcing = 'EU_STORE_EUR', route = 'land' WHERE key = 'filament'", CHECK);
  passes(db, "UPDATE price_estimate_types SET route = 'air' WHERE key = 'spare_part'");
  // Grammars: a USD minimum profit with at most six decimals up to 100000; a CBM; a whole box or none.
  for (const ok of ['2', '2.5', '0.000001', '100000']) passes(db, `UPDATE price_estimate_types SET min_profit_usd = '${ok}' WHERE key = 'printer'`);
  for (const bad of ['0', '2.1234567', '100000.01', '-1', '2,5', '1e2']) refused(db, `UPDATE price_estimate_types SET min_profit_usd = '${bad}' WHERE key = 'printer'`, CHECK);
  passes(db, "UPDATE price_estimate_types SET default_cbm = '0.004' WHERE key = 'filament'");
  refused(db, "UPDATE price_estimate_types SET default_cbm = '0' WHERE key = 'filament'", CHECK);
  passes(db, 'UPDATE price_estimate_types SET default_length_mm = 200, default_width_mm = 200, default_height_mm = 100, default_weight_g = 1300 WHERE key = \'filament\'');
  refused(db, "UPDATE price_estimate_types SET default_height_mm = NULL WHERE key = 'filament'", CHECK);
  refused(db, "UPDATE price_estimate_types SET additional_cost_iqd = -1 WHERE key = 'filament'", CHECK);
  refused(db, "UPDATE price_estimate_types SET stale_after_days = 0 WHERE key = 'filament'", CHECK);
});

test('product estimates: estimated needs its type and what was applied; confirmed needs real measures; an unknown type is refused', () => {
  const db = world();
  const ppe = (pid: string, cols: string, vals: string) =>
    `INSERT INTO product_price_estimates (product_id, updated_at${cols ? `, ${cols}` : ''}) VALUES ('${pid}', '${NOW}'${vals ? `, ${vals}` : ''})`;
  refused(db, ppe('p_est', 'type_key', "'no_such_type'"), /FOREIGN KEY/);
  refused(db, ppe('p_est', "state", "'estimated'"), CHECK);
  refused(db, ppe('p_est', 'state, type_key', "'estimated', 'filament'"), CHECK);
  passes(db, ppe('p_est', 'state, type_key, applied_at, applied_wire_json, measure_basis', `'estimated', 'filament', '${NOW}', '{}', 'type_default'`));
  refused(db, `UPDATE product_price_estimates SET state = 'confirmed', confirmed_at = '${NOW}' WHERE product_id = 'p_est'`, CHECK);
  refused(db, `UPDATE product_price_estimates SET state = 'confirmed', measure_basis = 'real' WHERE product_id = 'p_est'`, CHECK);
  passes(db, `UPDATE product_price_estimates SET state = 'confirmed', measure_basis = 'real', confirmed_at = '${NOW}', confirmed_by = 'admin_owner' WHERE product_id = 'p_est'`);
  refused(db, `UPDATE product_price_estimates SET flags_json = '{}' WHERE product_id = 'p_est'`, CHECK);
  refused(db, `UPDATE product_price_estimates SET preview_hash = 'short' WHERE product_id = 'p_est'`, CHECK);
  refused(db, ppe('p_plain', 'type_source', "'guess'"), CHECK);
  refused(db, `INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, computed_at) VALUES ('p_est', '', 'direct_sale', 'tmall_cn', 'model', '${NOW}')`, CHECK);
  passes(db, `INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, supplier_amount, supplier_currency, measure_source, est_cost_iqd, est_price_iqd, computed_at)
              VALUES ('p_est', '', 'pre_order_sea', 'tmall_cn', '69', 'CNY', 'type_default', 14524, 17500, '${NOW}')`);
  refused(db, `INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, supplier_currency, measure_source, computed_at) VALUES ('p_est', 'o:x', 'pre_order_sea', 'none', 'IQD', 'none', '${NOW}')`, CHECK);
});

// ------------------------------------------------------------------ the label

test('T3: no product is born labelled — not by the import, a copy or a create, token or not', () => {
  const db = world();
  refused(db, "INSERT INTO products (id, slug, name, price_estimate) VALUES ('p_born', 'p-born', 'Born', 1)", A.LABEL_OUTSIDE_PRICE_WRITE);
  refused(db, priced('p_born', "INSERT INTO products (id, slug, name, price_estimate) VALUES ('p_born', 'p-born', 'Born', 1)"), A.LABEL_OUTSIDE_PRICE_WRITE);
  label(db, 'p_est');
  refused(db, "INSERT OR REPLACE INTO products (id, slug, name, status, price_estimate) VALUES ('p_est', 'p-est', 'Estimated', 'active', 1)", A.LABEL_OUTSIDE_PRICE_WRITE);
});

test('T1: the label is set only inside the V2 price write of that very product', () => {
  const db = world();
  refused(db, "UPDATE products SET price_estimate = 1 WHERE id = 'p_est'", A.LABEL_OUTSIDE_PRICE_WRITE);
  refused(db, priced('p_plain', "UPDATE products SET price_estimate = 1 WHERE id = 'p_est'"), A.LABEL_OUTSIDE_PRICE_WRITE);
  refused(db, withToken('pricing-rates-apply', "UPDATE products SET price_estimate = 1 WHERE id = 'p_est'"), A.LABEL_OUTSIDE_PRICE_WRITE);
  label(db, 'p_est');
  assert.equal(row<{ v: number }>(db, "SELECT price_estimate AS v FROM products WHERE id = 'p_est'")!.v, 1);
  // A save that does not name the label keeps it; naming it at its value fires nothing.
  passes(db, "UPDATE products SET name = 'Renamed' WHERE id = 'p_est'");
  passes(db, "UPDATE products SET price_estimate = 1 WHERE id = 'p_est'");
  assert.ok(isEstimateRow(row(db, "SELECT * FROM products WHERE id = 'p_est'")));
  assert.equal(isEstimateRow(row(db, "SELECT * FROM products WHERE id = 'p_plain'")), false);
});

test('T2: the label is cleared only after the owner confirmed the product on real measures, in the same batch', () => {
  const db = world();
  label(db, 'p_est');
  const clear = "UPDATE products SET price_estimate = 0 WHERE id = 'p_est'";
  refused(db, clear, A.LABEL_CLEAR_REFUSED);
  refused(db, priced('p_est', clear), A.LABEL_CLEAR_REFUSED);
  db.exec(`INSERT INTO product_price_estimates (product_id, type_key, state, applied_at, applied_wire_json, measure_basis, updated_at)
           VALUES ('p_est', 'filament', 'estimated', '${NOW}', '{}', 'type_default', '${NOW}')`);
  refused(db, clear, A.LABEL_CLEAR_REFUSED);
  // The confirmation is recorded first, then the label goes — one batch.
  passes(db, `UPDATE product_price_estimates SET state = 'confirmed', measure_basis = 'real', confirmed_at = '${NOW}', confirmed_by = 'admin_owner' WHERE product_id = 'p_est';
              ${clear}`);
  assert.equal(row<{ v: number }>(db, "SELECT price_estimate AS v FROM products WHERE id = 'p_est'")!.v, 0);
});

test('T4: a firm SKU exists only on a labelled product, and cannot be moved to another one', () => {
  const db = world();
  const firm = (pid: string, combo: string) =>
    `INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES ('${pid}', '${combo}', 'admin_owner', '${NOW}')`;
  refused(db, firm('p_est', 'o:a'), A.FIRM_UNLABELLED);
  label(db, 'p_est');
  passes(db, firm('p_est', 'o:a'));
  refused(db, firm('p_plain', 'o:a'), A.FIRM_UNLABELLED);
  refused(db, "UPDATE price_estimate_firm_skus SET product_id = 'p_plain' WHERE product_id = 'p_est'", A.FIRM_UNLABELLED);
  passes(db, "UPDATE price_estimate_firm_skus SET combo_key = 'o:b' WHERE product_id = 'p_est'");
  refused(db, firm('p_est', 'o:b'), UNIQUE);
});

// ------------------------------------------------------------------ overrides

test("T5: a product's overrides obey its type — filament by sea, EU by land, China never by land, air only where allowed", () => {
  const db = freshDb();
  db.exec("INSERT INTO products (id, slug, name) VALUES ('p1', 'p1', 'P'), ('p2', 'p2', 'P')");
  const put = (type: string | null, sourcing: string | null, route: string | null) => {
    const v = (x: string | null) => (x === null ? 'NULL' : `'${x}'`);
    return `INSERT INTO product_price_estimates (product_id, type_key, sourcing_override, route_override, updated_at)
            VALUES ('p1', ${v(type)}, ${v(sourcing)}, ${v(route)}, '${NOW}')`;
  };
  const ok = (type: string | null, s: string | null, r: string | null) => {
    passes(db, put(type, s, r));
    db.exec("DELETE FROM product_price_estimates WHERE product_id = 'p1'");
  };
  const no = (type: string | null, s: string | null, r: string | null) => refused(db, put(type, s, r), A.TYPE_RULE);
  // Filament: sea only (never air, never land), whatever the sourcing says.
  ok('filament', null, null);
  ok('filament', null, 'sea');
  no('filament', null, 'air');
  no('filament', null, 'land');
  no('filament_pack', null, 'air');
  no('filament', 'EU_STORE_EUR', 'land');
  no('filament', 'EU_STORE_EUR', null);
  // Air only where the type allows it.
  ok('spare_part', null, 'air');
  ok('hotend', null, 'sea');
  no('printer', null, 'air');
  no(null, null, 'air');
  // EU sourcing by land only; an EU product with no route override travels by land.
  ok('printer', null, null);
  ok('printer', null, 'land');
  no('printer', null, 'sea');
  ok('spare_part', 'EU_STORE_EUR', null);
  ok('spare_part', 'EU_STORE_EUR', 'land');
  no('spare_part', 'EU_STORE_EUR', 'sea');
  no('spare_part', 'EU_STORE_EUR', 'air');
  // China sourcing never by land.
  no('spare_part', null, 'land');
  no('printer', 'CHINA_CNY', null);
  ok('printer', 'CHINA_CNY', 'sea');
  no('printer', 'CHINA_CNY', 'air');
  // The same rules on update, whichever of the three moves.
  passes(db, put('spare_part', null, 'air'));
  refused(db, "UPDATE product_price_estimates SET type_key = 'filament' WHERE product_id = 'p1'", A.TYPE_RULE);
  refused(db, "UPDATE product_price_estimates SET sourcing_override = 'EU_STORE_EUR' WHERE product_id = 'p1'", A.TYPE_RULE);
  passes(db, "UPDATE product_price_estimates SET route_override = 'sea' WHERE product_id = 'p1'");
  refused(db, "UPDATE product_price_estimates SET route_override = 'land' WHERE product_id = 'p1'", A.TYPE_RULE);
  passes(db, "UPDATE product_price_estimates SET type_key = 'filament' WHERE product_id = 'p1'");
  refused(db, "UPDATE product_price_estimates SET route_override = 'air' WHERE product_id = 'p1'", A.TYPE_RULE);
  passes(db, "UPDATE product_price_estimates SET state = 'paused' WHERE product_id = 'p1'");
});

// ------------------------------------------------------------------ the checkout

test('T6: a line of a labelled product is refused outside the estimate checkout; other lines are untouched', () => {
  const db = world();
  order(db, 'ord1');
  label(db, 'p_est');
  refused(db, itemSql('ord1', 'i_bad', 'p_est'), A.CHECKOUT_REQUIRED);
  // Another order's token does not open this order.
  refused(db, withToken(estimateCheckoutGuardId('ord_other'), itemSql('ord1', 'i_bad', 'p_est')), A.CHECKOUT_REQUIRED);
  passes(db, itemSql('ord1', 'i_plain', 'p_plain'));
  passes(db, itemSql('ord1', 'i_null', null));
  checkout(db, 'ord1', [{ item: 'i_est', pid: 'p_est', qty: 2 }]);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'estimate-checkout:%'"), 0, 'the token never outlives the batch');
  assert.deepEqual({ ...row(db, "SELECT state, qty, notice_version FROM order_price_estimates WHERE order_item_id = 'i_est'")! }, { state: 'open', qty: 2, notice_version: 1 });
});

test('T7: estimate rows are born only in their checkout batch, for a line of that order, and never change identity', () => {
  const db = world();
  label(db, 'p_est');
  order(db, 'ord1');
  passes(db, withToken(estimateCheckoutGuardId('ord1'), itemSql('ord1', 'i1', 'p_est', 2)));
  // No token.
  refused(db, estimateRowSql('ord1', 'i1', 'p_est', 2), A.LINE_OUTSIDE_CHECKOUT);
  // A row that does not describe its line: another product, another quantity, another order's line.
  refused(db, withToken(estimateCheckoutGuardId('ord1'), estimateRowSql('ord1', 'i1', 'p_plain', 2)), A.LINE_OUTSIDE_CHECKOUT);
  refused(db, withToken(estimateCheckoutGuardId('ord1'), estimateRowSql('ord1', 'i1', 'p_est', 1)), A.LINE_OUTSIDE_CHECKOUT);
  order(db, 'ord2');
  refused(db, withToken(estimateCheckoutGuardId('ord2'), estimateRowSql('ord2', 'i1', 'p_est', 2)), A.LINE_OUTSIDE_CHECKOUT);
  // An order that has left «تم الاستلام», or has a courier, takes no new estimate row.
  db.exec("UPDATE orders SET delivery_remote_id = 'X1' WHERE id = 'ord1'");
  refused(db, withToken(estimateCheckoutGuardId('ord1'), estimateRowSql('ord1', 'i1', 'p_est', 2)), A.LINE_OUTSIDE_CHECKOUT);
  db.exec("UPDATE orders SET delivery_remote_id = '', status = 'confirmed', stage = 'confirmed' WHERE id = 'ord1'");
  refused(db, withToken(estimateCheckoutGuardId('ord1'), estimateRowSql('ord1', 'i1', 'p_est', 2)), A.LINE_OUTSIDE_CHECKOUT);
  db.exec("UPDATE orders SET status = 'pending', stage = 'received' WHERE id = 'ord1'");
  passes(db, withToken(estimateCheckoutGuardId('ord1'), estimateRowSql('ord1', 'i1', 'p_est', 2)));
  // Frozen identity; the settlement columns move.
  for (const set of ["qty = 3", "estimate_unit_iqd = 1", "combo_key = 'o:x'", "channel = 'pre_order_air'", "notice_version = 2", "product_id = 'p_plain'", "order_id = 'ord2'", "qty = qty"]) {
    refused(db, `UPDATE order_price_estimates SET ${set} WHERE order_item_id = 'i1'`, A.LINE_FROZEN);
  }
  passes(db, "UPDATE order_price_estimates SET state = 'confirmed', final_unit_iqd = 17500, decided_by = 'admin', decided_at = 'now' WHERE order_item_id = 'i1'");
  // The settlement shape: a proposal names its 0140 row and its final price.
  refused(db, "UPDATE order_price_estimates SET state = 'proposed', final_unit_iqd = 18000 WHERE order_item_id = 'i1'", CHECK);
  refused(db, "UPDATE order_price_estimates SET state = 'approved', adjustment_id = 'padj', final_unit_iqd = NULL WHERE order_item_id = 'i1'", CHECK);
  refused(db, "UPDATE order_price_estimates SET final_unit_iqd = 0 WHERE order_item_id = 'i1'", CHECK);
});

// ------------------------------------------------------------------ the gate

test('T8: while a line is open, proposed or rejected the order stays at «تم الاستلام»; cancel and pending touches pass', () => {
  const db = world();
  label(db, 'p_est');
  order(db, 'ord1');
  checkout(db, 'ord1', [{ item: 'i1', pid: 'p_est' }]);
  const blocked = [
    "status = 'confirmed'",
    "status = 'processing'",
    "status = 'shipped'",
    "status = 'delivered'",
    "stage = 'confirmed'",
    "stage = 'supplier_preparing'",
    "stage = 'preparing'",
    "status = 'confirmed', stage = 'confirmed'",
    "delivery_remote_id = 'X1'",
  ];
  for (const state of ESTIMATE_UNSETTLED_STATES) {
    const settle = state === 'open' ? "state = 'open', adjustment_id = NULL, final_unit_iqd = NULL" : `state = '${state}', adjustment_id = 'padj_x', final_unit_iqd = 18000`;
    db.exec(`UPDATE order_price_estimates SET ${settle} WHERE order_item_id = 'i1'`);
    for (const set of blocked) refused(db, `UPDATE orders SET ${set} WHERE id = 'ord1'`, A.UNCONFIRMED);
    // A NULL fence is no move: the NOT NULL check answers, not the gate.
    refused(db, nullFence('orders', 'status', 'ord1'), notNull('orders', 'status'));
    passes(db, `UPDATE orders SET status = 'pending', stage = 'received', updated_at = '${NOW}' WHERE id = 'ord1'`);
    passes(db, `UPDATE orders SET delivery_remote_id = '', updated_at = '${NOW}' WHERE id = 'ord1'`);
    passes(db, `UPDATE orders SET admin_note = 'called the customer' WHERE id = 'ord1'`);
  }
  // A settled line opens the gate.
  db.exec("UPDATE order_price_estimates SET state = 'confirmed', adjustment_id = NULL, final_unit_iqd = 17500 WHERE order_item_id = 'i1'");
  passes(db, "UPDATE orders SET status = 'confirmed', stage = 'confirmed' WHERE id = 'ord1'");
  // An order with no estimate line never meets the gate.
  order(db, 'ord_plain');
  passes(db, itemSql('ord_plain', 'ip', 'p_plain'));
  passes(db, "UPDATE orders SET status = 'confirmed', stage = 'confirmed', delivery_remote_id = 'X2' WHERE id = 'ord_plain'");
  // The customer can always leave.
  order(db, 'ord2');
  checkout(db, 'ord2', [{ item: 'i2', pid: 'p_est' }]);
  passes(db, "UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ord2'");
});

test('T9 and T10: cancelling voids the unsettled lines, and a cancelled estimate order is never reopened', () => {
  const db = world();
  label(db, 'p_est');
  order(db, 'ord1');
  checkout(db, 'ord1', [
    { item: 'i_open', pid: 'p_est' },
    { item: 'i_prop', pid: 'p_est' },
    { item: 'i_rej', pid: 'p_est' },
    { item: 'i_conf', pid: 'p_est' },
  ]);
  db.exec(`
    UPDATE order_price_estimates SET state = 'proposed', adjustment_id = 'padj_a', final_unit_iqd = 18000 WHERE order_item_id = 'i_prop';
    UPDATE order_price_estimates SET state = 'rejected', adjustment_id = 'padj_b', final_unit_iqd = 18000 WHERE order_item_id = 'i_rej';
    UPDATE order_price_estimates SET state = 'confirmed', final_unit_iqd = 17500, decided_by = 'admin', decided_at = '${NOW}' WHERE order_item_id = 'i_conf';
  `);
  passes(db, "UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ord1'");
  for (const item of ['i_open', 'i_prop', 'i_rej']) {
    const s = lineState(db, item);
    assert.equal(s.state, 'void', item);
    assert.match(String(s.decided_at), /^\d{4}-\d\d-\d\dT/, item);
  }
  assert.equal(lineState(db, 'i_conf').state, 'confirmed', 'a settled line is history, untouched');
  assert.equal(lineState(db, 'i_conf').decided_at, NOW);
  refused(db, "UPDATE orders SET status = 'pending', stage = 'received' WHERE id = 'ord1'", A.REOPEN_REFUSED);
  refused(db, "UPDATE orders SET status = 'pending' WHERE id = 'ord1'", A.REOPEN_REFUSED);
  // A NULL fence (a lost deletion or refund race) is no reopening: NOT NULL answers, and
  // orderDeletion maps that to ORDER_CHANGED (review schema-1 / orders-5).
  refused(db, nullFence('orders', 'status', 'ord1'), notNull('orders', 'status'));
  passes(db, "UPDATE orders SET status = CASE WHEN 1 THEN status ELSE NULL END WHERE id = 'ord1'");
  passes(db, `UPDATE orders SET updated_at = '${NOW}' WHERE id = 'ord1'`);
  // An order without estimate lines is not this trigger's business.
  order(db, 'ord_plain');
  db.exec("UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ord_plain'");
  assert.notEqual(refusal(db, "UPDATE orders SET status = 'pending', stage = 'received' WHERE id = 'ord_plain'"), A.REOPEN_REFUSED);
});

test('T11: every 0140 decision reaches its proposed lines; the 0140 fences never fire it', () => {
  const db = world();
  label(db, 'p_est');
  const decide = (to: string, by: string | null = 'u1') =>
    `UPDATE order_price_adjustments SET state = '${to}', decided_at = '${NOW}', decided_by = ${by === null ? 'NULL' : `'${by}'`} WHERE id = 'padj1' AND state = 'pending'`;
  const setUp = (orderId: string) => {
    order(db, orderId);
    checkout(db, orderId, [
      { item: `${orderId}_a`, pid: 'p_est' },
      { item: `${orderId}_b`, pid: 'p_est' },
    ]);
    db.exec(`DELETE FROM order_price_adjustments WHERE id = 'padj1'`);
    proposal(db, 'padj1', orderId);
    // The confirm door's proposal batch: line a differs (proposed under padj1), line b equals its estimate.
    db.exec(`UPDATE order_price_estimates SET state = 'proposed', final_unit_iqd = 18000, adjustment_id = 'padj1' WHERE order_item_id = '${orderId}_a';
             UPDATE order_price_estimates SET state = 'confirmed', final_unit_iqd = 17500 WHERE order_item_id = '${orderId}_b'`);
  };
  // The 0140 propose fence (pending → pending) changes nothing.
  setUp('o_fence');
  passes(db, "UPDATE order_price_adjustments SET state = state WHERE id = 'padj1' AND state = 'pending'");
  assert.equal(lineState(db, 'o_fence_a').state, 'proposed');
  // Its lost branch (NULL) aborts on NOT NULL and reaches no line.
  refused(db, nullFence('order_price_adjustments', 'state', 'padj1'), notNull('order_price_adjustments', 'state'));
  assert.equal(lineState(db, 'o_fence_a').state, 'proposed');
  // Approved: the line is approved at its final price; the gate opens.
  passes(db, decide('approved'));
  assert.deepEqual({ ...lineState(db, 'o_fence_a') }, { state: 'approved', final_unit_iqd: 18000, adjustment_id: 'padj1', decided_by: 'u1', decided_at: NOW });
  assert.equal(lineState(db, 'o_fence_b').state, 'confirmed', 'a line settled at its estimate is not the proposal\'s');
  // The approve batch's final fence (approved → approved) changes nothing.
  db.exec("UPDATE order_price_estimates SET state = 'confirmed' WHERE order_item_id = 'o_fence_a'");
  passes(db, "UPDATE order_price_adjustments SET state = 'approved' WHERE id = 'padj1' AND state = 'approved'");
  assert.equal(lineState(db, 'o_fence_a').state, 'confirmed');
  passes(db, "UPDATE orders SET status = 'confirmed', stage = 'confirmed' WHERE id = 'o_fence'");

  // Rejected: the line stays held as rejected; closeWithoutMoney's fence (rejected → rejected) changes nothing.
  setUp('o_rej');
  passes(db, decide('rejected'));
  assert.equal(lineState(db, 'o_rej_a').state, 'rejected');
  assert.equal(lineState(db, 'o_rej_a').adjustment_id, 'padj1');
  passes(db, "UPDATE order_price_adjustments SET state = 'rejected' WHERE id = 'padj1' AND state = 'rejected'");
  assert.equal(lineState(db, 'o_rej_a').state, 'rejected');
  refused(db, "UPDATE orders SET status = 'confirmed' WHERE id = 'o_rej'", A.UNCONFIRMED);

  // Withdrawn by an admin: the line is open again, its proposal forgotten.
  setUp('o_wd');
  passes(db, decide('withdrawn', 'admin'));
  assert.deepEqual({ ...lineState(db, 'o_wd_a') }, { state: 'open', final_unit_iqd: null, adjustment_id: null, decided_by: 'admin', decided_at: NOW });
  refused(db, "UPDATE orders SET stage = 'confirmed' WHERE id = 'o_wd'", A.UNCONFIRMED);

  // Voided (the customer's cancel): the line is void; a NULL decider is recorded as ''.
  setUp('o_void');
  passes(db, decide('void', null));
  assert.equal(lineState(db, 'o_void_a').state, 'void');
  assert.equal(lineState(db, 'o_void_a').decided_by, '');
  // reason_code: only an estimate proposal names it, and only with its one value.
  passes(db, "UPDATE order_price_adjustments SET reason_code = 'ESTIMATE_FINAL_PRICE' WHERE id = 'padj1'");
  refused(db, "UPDATE order_price_adjustments SET reason_code = 'OTHER' WHERE id = 'padj1'", CHECK);
});

// ------------------------------------------------------------------ the import guard

test('the import guard: all 36 triggers refuse inside an import batch; outside one the same writes go through', () => {
  const db = world();
  label(db, 'p_est');
  order(db, 'ord1');
  checkout(db, 'ord1', [{ item: 'i1', pid: 'p_est' }]);
  // One real row in every table, written outside any import.
  db.exec(`
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, created_by, created_at)
      VALUES ('sps_1', 'tmall_cn', 'CNY', 'browser_sweep', '2026-10-31', '${SHA}', 'owner', '${NOW}');
    INSERT INTO supplier_price_items (snapshot_id, item_key) VALUES ('sps_1', 'item1');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_1', 'item1', 'sku1', '69');
    INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key) VALUES ('sps_1', 'part_code', 'ZH121', 'item1');
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, found_in_snapshot, updated_at)
      VALUES ('p_est', '', 'tmall_cn', 'item1', 'sku1', 'medium', 'name', 'suggested', 'sps_1', '${NOW}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, entered_by, entered_at) VALUES ('p_est', '', '69', 'CNY', 'owner', '${NOW}');
    INSERT INTO product_price_estimates (product_id, type_key, updated_at) VALUES ('p_est', 'filament', '${NOW}');
    INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, computed_at)
      VALUES ('p_est', '', 'pre_order_sea', 'tmall_cn', 'type_default', '${NOW}');
    INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES ('p_est', '', 'owner', '${NOW}');
  `);
  const writes: Record<string, { ins: string; upd: string; del: string }> = {
    supplier_price_snapshots: {
      ins: `INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, file_sha256, created_by, created_at) VALUES ('sps_2', 'bambu_us', 'USD', 'store_script', '2026-10-31', '${SHA}', 'o', '${NOW}')`,
      upd: "UPDATE supplier_price_snapshots SET captured_by = 'x'",
      del: 'DELETE FROM supplier_price_snapshots',
    },
    supplier_price_items: { ins: "INSERT INTO supplier_price_items (snapshot_id, item_key) VALUES ('sps_1', 'item2')", upd: "UPDATE supplier_price_items SET title = 'x'", del: 'DELETE FROM supplier_price_items' },
    supplier_price_skus: { ins: "INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price) VALUES ('sps_1', 'item1', 'sku2', '1')", upd: "UPDATE supplier_price_skus SET price = '70'", del: 'DELETE FROM supplier_price_skus' },
    supplier_price_keys: { ins: "INSERT INTO supplier_price_keys (snapshot_id, key_type, key_value, item_key) VALUES ('sps_1', 'handle', 'h', 'item1')", upd: "UPDATE supplier_price_keys SET sku_key = 'x'", del: 'DELETE FROM supplier_price_keys' },
    supplier_price_matches: {
      ins: `INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, state, found_in_snapshot, updated_at) VALUES ('p_est', 'o:x', 'tmall_cn', 'item1', 'sku1', 'low', 'name', 'suggested', 'sps_1', '${NOW}')`,
      upd: "UPDATE supplier_price_matches SET confidence = 'low'",
      del: 'DELETE FROM supplier_price_matches',
    },
    supplier_price_manual: {
      ins: `INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, entered_by, entered_at) VALUES ('p_est', 'o:x', '1', 'CNY', 'o', '${NOW}')`,
      upd: "UPDATE supplier_price_manual SET amount = '70'",
      del: 'DELETE FROM supplier_price_manual',
    },
    price_estimate_types: {
      ins: `INSERT INTO price_estimate_types (key, name_ar, name_en, name_ckb, sourcing, route, updated_at) VALUES ('newtype', 'نوع', 'Type', 'جۆر', 'CHINA_CNY', 'sea', '${NOW}')`,
      upd: "UPDATE price_estimate_types SET min_profit_usd = '2'",
      del: "DELETE FROM price_estimate_types WHERE key = 'laser_material'",
    },
    price_estimate_control: { ins: 'INSERT INTO price_estimate_control (id) VALUES (1)', upd: 'UPDATE price_estimate_control SET apply_enabled = 1', del: 'DELETE FROM price_estimate_control' },
    product_price_estimates: {
      ins: `INSERT INTO product_price_estimates (product_id, updated_at) VALUES ('p_plain', '${NOW}')`,
      upd: "UPDATE product_price_estimates SET state = 'paused'",
      del: 'DELETE FROM product_price_estimates',
    },
    price_estimate_lines: {
      ins: `INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, measure_source, computed_at) VALUES ('p_est', 'o:x', 'pre_order_sea', 'none', 'none', '${NOW}')`,
      upd: 'UPDATE price_estimate_lines SET est_price_iqd = 1',
      del: 'DELETE FROM price_estimate_lines',
    },
    price_estimate_firm_skus: {
      ins: `INSERT INTO price_estimate_firm_skus (product_id, combo_key, confirmed_by, confirmed_at) VALUES ('p_est', 'o:x', 'o', '${NOW}')`,
      upd: "UPDATE price_estimate_firm_skus SET confirmed_by = 'x'",
      del: 'DELETE FROM price_estimate_firm_skus',
    },
    order_price_estimates: {
      // Inside its checkout token, so only the import guard can be what refuses it.
      ins: withToken(estimateCheckoutGuardId('ord1'), estimateRowSql('ord1', 'i1', 'p_est')),
      upd: "UPDATE order_price_estimates SET decided_by = 'x'",
      del: 'DELETE FROM order_price_estimates',
    },
  };
  assert.deepEqual(Object.keys(writes).sort(), [...TWELVE].sort());
  const armed = (sql: string) => withToken(IMPORT_GUARD_ID, sql);
  let refusals = 0;
  for (const [table, w] of Object.entries(writes)) {
    for (const [verb, sql] of Object.entries(w)) {
      refused(db, armed(sql), IMPORT_GUARD_REFUSAL);
      refusals++;
      assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards WHERE id = ?', IMPORT_GUARD_ID), 0, `${table} ${verb}: the refused batch left no guard row`);
    }
  }
  assert.equal(refusals, 36);
  // Disarmed, the same updates and deletes are not refused by the guard (children before parents, so every
  // statement still finds its row).
  for (const w of Object.values(writes)) passes(db, w.upd);
  for (const table of [...TWELVE].reverse()) passes(db, writes[table]!.del);
  const guards = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'trg_import_guard_*' AND tbl_name IN (" + TWELVE.map((t) => `'${t}'`).join(',') + ')').get() as { n: number };
  assert.equal(guards.n, 36);
});

// ------------------------------------------------------------------ names and abort codes

test('every database abort of 0218 is named in the contract, and every contract name is raised by 0218', () => {
  const raised = new Set([...SQL.matchAll(/RAISE\(ABORT, '([A-Z_]+)'\)/g)].map((m) => m[1]!).filter((c) => c !== IMPORT_GUARD_REFUSAL));
  assert.deepEqual([...raised].sort(), [...new Set(Object.values(ESTIMATE_DB_ABORTS))].sort());
  const triggers = new Set((freshDb().prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name));
  for (const t of [
    'trg_products_price_estimate_set', 'trg_products_price_estimate_clear', 'trg_products_price_estimate_insert',
    'trg_price_estimate_firm_ins', 'trg_price_estimate_firm_upd', 'trg_ppe_route_rule_ins', 'trg_ppe_route_rule_upd',
    'trg_order_items_price_estimate_guard', 'trg_ope_insert_guard', 'trg_ope_frozen', 'trg_orders_price_estimate_gate',
    'trg_orders_price_estimate_reopen', 'trg_orders_price_estimate_cancel', 'trg_price_adj_estimate_lines',
  ]) {
    assert.ok(triggers.has(t), `${t} is missing`);
  }
  // The checkout token the triggers read is the one the gate module builds.
  assert.equal(estimateCheckoutGuardId('ORD-1'), 'estimate-checkout:ORD-1');
  assert.equal((SQL.match(/'estimate-checkout:' \|\| NEW\.order_id/g) ?? []).length, 2);
});

// ------------------------------------------------------------------ the leaf guards, live

test('the gate module reads the real gate: open lines, settled lines, an abort from the trigger itself', async () => {
  const db = world();
  label(db, 'p_est');
  order(db, 'ord1');
  checkout(db, 'ord1', [{ item: 'i1', pid: 'p_est' }]);
  const d1 = asD1(db);
  assert.equal(await hasOpenEstimates(d1, 'ord1'), true);
  assert.equal(await hasOpenEstimates(d1, 'ord_none'), false);
  try {
    await d1.prepare("UPDATE orders SET status = 'confirmed', stage = 'confirmed' WHERE id = ?").bind('ord1').run();
    assert.fail('the gate let the order through');
  } catch (e) {
    assert.equal(isEstimateGateAbort(e), true);
    assert.equal(isEstimateReopenAbort(e), false);
  }
  db.exec("UPDATE order_price_estimates SET state = 'confirmed', final_unit_iqd = 17500 WHERE order_item_id = 'i1'");
  assert.equal(await hasOpenEstimates(d1, 'ord1'), false);
  db.exec("UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id = 'ord1'");
  try {
    await d1.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").bind('ord1').run();
    assert.fail('a cancelled estimate order was reopened');
  } catch (e) {
    assert.equal(isEstimateReopenAbort(e), true);
    assert.equal(isEstimateGateAbort(e), false);
  }
  // Any other failure is the door's to decide: it is thrown, never read as "no lines".
  const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('D1_ERROR: network connection lost'); } }) }) };
  await assert.rejects(() => hasOpenEstimates(broken as never, 'ord1'), /network connection lost/);
});

test('deploy-ahead: on a 0217 database every leaf guard answers as today', async () => {
  const raw = dbThrough('0217');
  raw.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'customer@example.test');
    INSERT INTO products (id, slug, name, status) VALUES ('p1', 'p1', 'P', 'active');
  `);
  order(raw, 'ord1');
  const db = asD1(raw);
  // The owner routes' probe: not installed, and asked again next time.
  assert.equal(await priceEstimatesInstalled(db), false);
  assert.equal(await priceEstimatesInstalled(db), false);
  // The gate: no table, no lines, no trigger.
  assert.equal(await hasOpenEstimates(db, 'ord1'), false);
  // The label: an absent key is not labelled.
  assert.equal(isEstimateRow(row(raw, "SELECT * FROM products WHERE id = 'p1'")), false);
  // The real refusals of a 0217 database are recognised; another missing column or table is not.
  const errorOf = (sql: string) => {
    try {
      raw.prepare(sql).all();
      return null;
    } catch (e) {
      return e;
    }
  };
  for (const sql of [
    'SELECT p.id FROM products p WHERE COALESCE(p.price_estimate, 0) = 0',
    'SELECT id FROM products WHERE price_estimate = 1',
    'SELECT product_id FROM price_estimate_firm_skus',
    'SELECT 1 FROM order_price_estimates',
    'SELECT 1 FROM product_price_estimates',
    'SELECT 1 FROM supplier_price_snapshots',
  ]) {
    const e = errorOf(sql);
    assert.ok(e, `${sql} should fail on 0217`);
    assert.equal(isMissingEstimateSchema(e), true, String((e as Error).message));
  }
  assert.equal(isMissingEstimateSchema(errorOf('SELECT nope FROM products')), false);
  assert.equal(isMissingEstimateSchema(errorOf('SELECT 1 FROM no_such_table_here')), false);
  assert.equal(isMissingEstimateSchema(new Error('D1_ERROR: no such column: p.price_estimate: SQLITE_ERROR')), true);
  assert.equal(isMissingEstimateSchema(new Error('UNIQUE constraint failed: products.slug')), false);

  // The clause: retried without it, remembered for a minute, and today's statement exactly.
  const sql = `SELECT p.id FROM products p WHERE p.status = 'active'${estimateClause('p')}`;
  assert.equal(withoutEstimateClause(sql), "SELECT p.id FROM products p WHERE p.status = 'active'");
  const ran: string[] = [];
  const exec = async (s: string) => {
    ran.push(s);
    return raw.prepare(s).all();
  };
  assert.equal(estimateAbsentLately(db), false);
  const rows = await runWithEstimateClause(db, sql, exec);
  assert.equal(rows.length, 1);
  assert.deepEqual(ran, [sql, withoutEstimateClause(sql)]);
  assert.equal(estimateAbsentLately(db), true);
  assert.equal(estimateClauseFor(db, 'p'), '');
  ran.length = 0;
  await runWithEstimateClause(db, sql, exec);
  assert.deepEqual(ran, [withoutEstimateClause(sql)], 'asked nothing first while the absence is fresh');
  // Another error is not hidden.
  await assert.rejects(() => runWithEstimateClause({}, `SELECT nope FROM products p WHERE 1${estimateClause('p')}`, exec), /no such column: nope/);
});

test('the clause and the runner on a migrated database: the clause is kept and excludes labelled rows', async () => {
  const raw = world();
  label(raw, 'p_est');
  const db = asD1(raw);
  // The owner routes' probe: installed, then remembered for the binding — no statement on the next call.
  let probes = 0;
  const counting = { prepare: (s: string) => (probes++, db.prepare(s)) };
  assert.equal(await priceEstimatesInstalled(counting), true);
  assert.equal(await priceEstimatesInstalled(counting), true);
  assert.equal(probes, 1);
  const sql = `SELECT p.id FROM products p WHERE p.status = 'active'${estimateClause('p')} ORDER BY p.id`;
  const ran: string[] = [];
  const rows = await runWithEstimateClause(db, sql, async (s) => {
    ran.push(s);
    return raw.prepare(s).all() as Array<{ id: string }>;
  });
  assert.deepEqual(rows.map((r) => r.id), ['p_plain']);
  assert.deepEqual(ran, [sql]);
  assert.equal(estimateAbsentLately(db), false);
  assert.equal(estimateClauseFor(db, 'p'), estimateClause('p'));
  // Two aliases, one statement: both clauses go together.
  const two = `SELECT a.id FROM products a JOIN products b ON b.id = a.id WHERE 1${estimateClause('a')}${estimateClause('b')}`;
  assert.equal(withoutEstimateClause(two), 'SELECT a.id FROM products a JOIN products b ON b.id = a.id WHERE 1');
  assert.throws(() => estimateClause('p; DROP TABLE products'), /PRICE_ESTIMATE_INVARIANT/);
  assert.throws(() => estimateClause(''), /PRICE_ESTIMATE_INVARIANT/);
  // A binding remembered as absent asks again after the minute.
  const fresh = {};
  rememberEstimateAbsent(fresh);
  assert.equal(estimateAbsentLately(fresh), true);
  assert.equal(estimateAbsentLately({}), false);
  rememberEstimateAbsent(null as never);
  assert.equal(isEstimateRow({ price_estimate: true }), true);
  assert.equal(isEstimateRow({ price_estimate: 0 }), false);
  assert.equal(isEstimateRow({}), false);
  assert.equal(isEstimateRow(null), false);
});
