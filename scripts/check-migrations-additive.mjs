#!/usr/bin/env node
/**
 * Classifies every statement in a directory of .sql migrations and fails
 * unless all of them are additive.
 *
 * WHY NOT grep. The obvious check — grep for UPDATE and DELETE — is wrong on
 * this schema, and confidently so: `FOREIGN KEY (revision_id) REFERENCES
 * project_revisions(id) ON UPDATE no action ON DELETE no action` contains both
 * words inside a CREATE TABLE. A check that cries wolf on the only migration
 * the repo has is a check nobody will trust the next time.
 *
 * So statements are split and judged by the verb they START with, which is
 * what actually decides whether a statement can touch existing data.
 *
 * Usage: node scripts/check-migrations-additive.mjs <dir> [...more dirs]
 * Exit 0 = every statement is additive. Exit 1 = something is not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Statements that only ever ADD schema; none can modify or remove a row. */
const ADDITIVE = [
  /^CREATE\s+TABLE\b/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX\b/i,
  /^CREATE\s+VIEW\b/i,
  /^CREATE\s+TRIGGER\b/i,
];

/** Statements that change or remove existing data or schema. */
const DESTRUCTIVE = [
  [/^ALTER\s+TABLE\b/i, 'ALTER TABLE — may rewrite the table or change a column'],
  [/^DROP\b/i, 'DROP — removes schema and any data in it'],
  [/^DELETE\b/i, 'DELETE — removes rows'],
  [/^UPDATE\b/i, 'UPDATE — modifies existing rows'],
  [/^INSERT\b/i, 'INSERT — writes rows (a backfill or a seed)'],
  [/^REPLACE\b/i, 'REPLACE — overwrites rows'],
  [/^PRAGMA\b/i, 'PRAGMA — changes database behaviour'],
  [/^ATTACH\b/i, 'ATTACH — reaches another database file'],
  [/^VACUUM\b/i, 'VACUUM — rewrites the whole database'],
];

/**
 * Splits SQL into statements. Comments are removed first, and string literals
 * are respected so a `;` inside quotes does not split a statement.
 */
export function statements(sql) {
  const withoutComments = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const out = [];
  let current = '';
  let quote = null;
  for (const ch of withoutComments) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === ';') { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);

  return out
    // drizzle's own separator, once comments are gone.
    .flatMap((s) => s.split('-->'))
    .map((s) => s.replace(/statement-breakpoint/g, '').trim())
    .filter(Boolean);
}

/** { additive: boolean, reason: string } for one statement. */
export function classify(statement) {
  // `CREATE TABLE IF NOT EXISTS` and friends are still CREATE.
  const head = statement.replace(/^\s+/, '');
  for (const [pattern, reason] of DESTRUCTIVE) {
    if (pattern.test(head)) return { additive: false, reason };
  }
  for (const pattern of ADDITIVE) {
    if (pattern.test(head)) return { additive: true, reason: head.split(/\s+/).slice(0, 3).join(' ') };
  }
  return { additive: false, reason: `unrecognised statement — not on the additive allowlist: ${head.split(/\s+/).slice(0, 4).join(' ')}` };
}

export function auditDirectory(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return files.map((file) => {
    const sql = readFileSync(join(dir, file), 'utf8');
    const parsed = statements(sql).map((s) => ({ statement: s, ...classify(s) }));
    return {
      file,
      statements: parsed,
      additive: parsed.every((s) => s.additive),
      counts: {
        createTable: parsed.filter((s) => /^CREATE\s+TABLE/i.test(s.statement)).length,
        createIndex: parsed.filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX/i.test(s.statement)).length,
        other: parsed.filter((s) => !/^CREATE/i.test(s.statement)).length,
      },
    };
  });
}

// -------------------------------------------------------------------- cli
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/scripts\/)/, ''));
if (invokedDirectly || process.argv[1]?.endsWith('check-migrations-additive.mjs')) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: node scripts/check-migrations-additive.mjs <migrations-dir> [...]');
    process.exit(2);
  }
  let failed = false;
  for (const dir of dirs) {
    const reports = auditDirectory(dir);
    if (!reports.length) {
      console.error(`${dir}: no .sql files found`);
      failed = true;
      continue;
    }
    for (const report of reports) {
      console.log('');
      console.log(`  ${dir}/${report.file}`);
      console.log(`    CREATE TABLE : ${report.counts.createTable}`);
      console.log(`    CREATE INDEX : ${report.counts.createIndex}`);
      console.log(`    other        : ${report.counts.other}`);
      console.log(`    additive-only: ${report.additive ? 'yes' : 'NO'}`);
      for (const s of report.statements) {
        if (s.additive) continue;
        failed = true;
        console.log(`    NOT ADDITIVE: ${s.reason}`);
        console.log(`      ${s.statement.split('\n')[0].slice(0, 120)}`);
      }
    }
  }
  if (failed) {
    console.error('\nAt least one statement is not additive. Review it and apply it deliberately.');
    process.exit(1);
  }
  console.log('\nEvery statement is additive: CREATE only. No statement can modify or remove existing data.');
}
