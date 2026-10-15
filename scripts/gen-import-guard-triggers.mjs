#!/usr/bin/env node
/**
 * Generates the catalogue-import guard triggers of migration 0195 from the one
 * list in worker/lib/catalogImport/protectedTables.ts (Bambu import spec §B.4).
 *
 *   node scripts/gen-import-guard-triggers.mjs           print the generated block
 *   node scripts/gen-import-guard-triggers.mjs --write   rewrite the block inside 0195
 *   node scripts/gen-import-guard-triggers.mjs --check   exit 1 when 0195's block is stale
 *
 * WHY GENERATED. Twenty-odd tables times three verbs, plus four row tables with
 * eighteen guarded columns each, is exactly the kind of SQL in which a missing
 * `OR` or a forgotten column hides for months. One list, one generator, and a
 * test (tests/catalogImportGuards.test.ts) that fails when the committed block
 * is not what this prints.
 *
 * SCHEMA-AWARE. A table the schema before 0195 does not have yet (the 0193
 * price-request tables on a branch cut before catalog-only landed) cannot carry
 * a trigger: CREATE TRIGGER on a missing table fails the migration. Such a
 * table is named in a comment instead, and the guard test refuses that state
 * the moment its migration file exists — re-run this with --write then.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUARDED_ROW_TABLES,
  IMPORT_GUARD_ID,
  IMPORT_GUARD_REFUSAL,
  PROTECTED_TABLES,
  STOCK_DECISION_GUARD,
} from '../worker/lib/catalogImport/protectedTables.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGET_MIGRATION = '0195_catalog_import_runs.sql';
export const BLOCK_BEGIN = '-- BEGIN GENERATED: scripts/gen-import-guard-triggers.mjs (worker/lib/catalogImport/protectedTables.ts). Do not edit by hand.';
export const BLOCK_END = '-- END GENERATED: scripts/gen-import-guard-triggers.mjs';

const GUARD = `EXISTS (SELECT 1 FROM ops_guards WHERE id = '${IMPORT_GUARD_ID}')`;
const RAISE = `BEGIN SELECT RAISE(ABORT, '${IMPORT_GUARD_REFUSAL}'); END;`;

/** Table name → column names, for every table the migrations BEFORE 0195 create. */
export function schemaBefore(root = ROOT, target = TARGET_MIGRATION) {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(join(root, 'migrations'))
    .filter((f) => f.endsWith('.sql') && f < target)
    .sort();
  for (const f of files) db.exec(readFileSync(join(root, 'migrations', f), 'utf8'));
  const out = new Map();
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    out.set(name, new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name)));
  }
  db.close();
  return out;
}

function nonDefault(col, ref) {
  switch (col.insertDefault) {
    case 'null':
      return `${ref}.${col.name} IS NOT NULL`;
    case 'zero':
      return `${ref}.${col.name} IS NOT 0`;
    case 'zero_or_null':
      return `COALESCE(${ref}.${col.name}, 0) <> 0`;
    case 'empty_object':
      return `${ref}.${col.name} IS NOT '{}'`;
    default:
      throw new Error(`unknown insertDefault ${col.insertDefault} for ${col.name}`);
  }
}

function orJoin(parts, indent) {
  return parts.join(`\n${indent}OR `);
}

/** The generated SQL block (markers included), for the given pre-0195 schema. */
export function generateGuardBlock(schema) {
  const lines = [BLOCK_BEGIN];
  const missing = PROTECTED_TABLES.filter((t) => !schema.has(t.table));
  for (const t of missing) {
    if (!t.since) throw new Error(`protected table ${t.table} is missing from the schema and names no migration that creates it`);
  }
  lines.push('-- Armed only while ops_guards holds the row ' + `'${IMPORT_GUARD_ID}'` + ', which exists only inside an import batch.');
  if (missing.length) {
    lines.push('-- Not in the schema before this file, so not guarded here (re-run the generator with --write once they land):');
    for (const t of missing) lines.push(`--   ${t.table} (${t.since})`);
  }
  lines.push('');
  lines.push('-- (a) Pricing, stock, orders, wallet and ledger tables: no INSERT, UPDATE or DELETE inside an import batch.');
  for (const { table } of PROTECTED_TABLES) {
    if (!schema.has(table)) continue;
    for (const [suffix, verb] of [['ins', 'INSERT'], ['upd', 'UPDATE'], ['del', 'DELETE']]) {
      lines.push(`CREATE TRIGGER IF NOT EXISTS trg_import_guard_${table}_${suffix} BEFORE ${verb} ON ${table}`);
      lines.push(`WHEN ${GUARD}`);
      lines.push(RAISE);
    }
  }
  lines.push('');
  lines.push('-- (b) Catalogue rows the import writes: money, stock and package columns stay at their defaults on a new row,');
  lines.push('--     equal to the stored row on an upsert, and unchanged on an UPDATE.');
  for (const t of GUARDED_ROW_TABLES) {
    const cols = schema.get(t.table);
    if (!cols) throw new Error(`guarded row table ${t.table} is missing from the schema`);
    const all = [...t.money, ...t.stock, ...t.package];
    for (const c of all) if (!cols.has(c.name)) throw new Error(`guarded column ${t.table}.${c.name} is missing from the schema`);
    const fresh = all.map((c) => nonDefault(c, 'NEW'));
    const differs = all.map((c) => `NEW.${c.name} IS NOT o.${c.name}`);
    lines.push(`CREATE TRIGGER IF NOT EXISTS trg_import_guard_${t.table}_ins BEFORE INSERT ON ${t.table}`);
    lines.push(`WHEN ${GUARD}`);
    lines.push(` AND ((NOT EXISTS (SELECT 1 FROM ${t.table} o WHERE o.id = NEW.id)`);
    lines.push(`       AND (${orJoin(fresh, '            ')}))`);
    lines.push(`   OR EXISTS (SELECT 1 FROM ${t.table} o WHERE o.id = NEW.id`);
    lines.push(`       AND (${orJoin(differs, '            ')})))`);
    lines.push(RAISE);
    lines.push(`CREATE TRIGGER IF NOT EXISTS trg_import_guard_${t.table}_upd BEFORE UPDATE OF ${all.map((c) => c.name).join(', ')} ON ${t.table}`);
    lines.push(`WHEN ${GUARD}`);
    lines.push(` AND (${orJoin(all.map((c) => `NEW.${c.name} IS NOT OLD.${c.name}`), '      ')})`);
    lines.push(RAISE);
  }
  lines.push('');
  lines.push('-- (c) The stock decision (§B.10): an import records "not configured", never a decision, and never changes one.');
  const sd = STOCK_DECISION_GUARD;
  const sdCols = schema.get(sd.table);
  if (sdCols) {
    for (const c of sd.frozenColumns) if (!sdCols.has(c)) throw new Error(`stock decision column ${sd.table}.${c} is missing`);
    const refused = sd.refusedOnInsert.map((v) => `'${v}'`).join(',');
    lines.push(`CREATE TRIGGER IF NOT EXISTS trg_import_guard_stock_decision BEFORE INSERT ON ${sd.table}`);
    lines.push(`WHEN ${GUARD}`);
    lines.push(` AND (NEW.stock_decision IN (${refused})`);
    lines.push(`   OR EXISTS (SELECT 1 FROM ${sd.table} o WHERE o.source = NEW.source AND o.source_product_id = NEW.source_product_id`);
    lines.push(`       AND (${orJoin(sd.frozenColumns.map((c) => `NEW.${c} IS NOT o.${c}`), '            ')})))`);
    lines.push(RAISE);
    lines.push(`CREATE TRIGGER IF NOT EXISTS trg_import_guard_stock_decision_upd BEFORE UPDATE OF ${sd.frozenColumns.join(', ')} ON ${sd.table}`);
    lines.push(`WHEN ${GUARD}`);
    lines.push(` AND (${orJoin(sd.frozenColumns.map((c) => `NEW.${c} IS NOT OLD.${c}`), '      ')})`);
    lines.push(RAISE);
  } else {
    // 0194 creates it; 0195 is always applied after 0194.
    throw new Error(`${sd.table} is missing from the schema before ${TARGET_MIGRATION}`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/** The block as it stands in the committed migration (markers included), or null. */
export function committedGuardBlock(root = ROOT) {
  const sql = readFileSync(join(root, 'migrations', TARGET_MIGRATION), 'utf8');
  const a = sql.indexOf(BLOCK_BEGIN);
  const b = sql.indexOf(BLOCK_END);
  if (a < 0 || b < 0 || b < a) return null;
  return sql.slice(a, b + BLOCK_END.length);
}

function main() {
  const args = process.argv.slice(2);
  const block = generateGuardBlock(schemaBefore());
  if (args.includes('--write')) {
    const path = join(ROOT, 'migrations', TARGET_MIGRATION);
    const sql = readFileSync(path, 'utf8');
    const current = committedGuardBlock();
    if (current === null) {
      console.error(`${TARGET_MIGRATION} has no generated block markers`);
      process.exit(1);
    }
    writeFileSync(path, sql.replace(current, block));
    console.log(`rewrote the generated block of ${TARGET_MIGRATION}`);
    return;
  }
  if (args.includes('--check')) {
    if (committedGuardBlock() !== block) {
      console.error(`${TARGET_MIGRATION}: the generated guard block is stale — run node scripts/gen-import-guard-triggers.mjs --write`);
      process.exit(1);
    }
    console.log(`${TARGET_MIGRATION}: the generated guard block is current`);
    return;
  }
  console.log(block);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
