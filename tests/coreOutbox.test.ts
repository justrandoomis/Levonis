/**
 * `migrations/0057_core_outbox.sql` VERSUS THE GENERATORS IT SAYS IT CAME FROM.
 *
 * The migration's own header states that its DDL is
 * `outboxSchemaSql('core')` + `auditDetailsSchemaSql('core')` and that this
 * file compares the two "so they can never drift". It named a test that did
 * not exist, which is worse than naming none: the pump does raw SQL against
 * `outboxTables('core')` names on the LIVE database, so a divergence between
 * the applied schema and the code's idea of it is a runtime failure on the
 * shared customer D1, not a compile error.
 *
 * The comparison is on NORMALISED SQL — comments, blank lines and whitespace
 * runs removed — because the migration is allowed its prose and the generator
 * is not. Everything else must match statement for statement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outboxSchemaSql, outboxTables } from '@levonis/platform-kit/outbox';
import { auditDetailsSchemaSql } from '@levonis/platform-kit/audit';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'migrations', '0057_core_outbox.sql');

/** Strips `--` comments and collapses whitespace, then splits into statements. */
function statementsOf(sql: string): string[] {
  const stripped = sql
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  return (splitStatements(stripped) as string[])
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * The ONE deliberate difference, stated in the migration's own header: the
 * generator seeds `pump_lock`, the migration does not — the lock row is created
 * idempotently by `ensurePumpLock()` on first use, which also covers a database
 * restored without it. Named here so it stays a decision rather than becoming
 * the drift this file exists to catch.
 */
const DELIBERATELY_OMITTED = ["INSERT OR IGNORE INTO pump_lock (name) VALUES ('core')"];

test('0057 contains every statement the platform kit generates for the core prefix, verbatim', () => {
  const applied = statementsOf(readFileSync(MIGRATION, 'utf8'));
  const generated = [...statementsOf(outboxSchemaSql('core')), ...statementsOf(auditDetailsSchemaSql('core'))];
  assert.ok(generated.length >= 6, `expected the generators to produce the four tables and their indexes, got ${generated.length}`);
  const missing = generated.filter((g) => !applied.includes(g) && !DELIBERATELY_OMITTED.includes(g));
  assert.deepEqual(
    missing,
    [],
    `the migration has drifted from the generators the pump reads through:\n${missing.join('\n\n')}`
  );
  // The omission is real, and the header says why.
  for (const stmt of DELIBERATELY_OMITTED) assert.ok(!applied.includes(stmt), `${stmt} is documented as omitted but present`);
  assert.match(readFileSync(MIGRATION, 'utf8'), /deliberately NO seed row for `pump_lock`/);
});

test('the tables the pump names in SQL are the tables the migration creates', () => {
  const applied = readFileSync(MIGRATION, 'utf8');
  const t = outboxTables('core');
  for (const table of [t.events, t.deliveries, t.lock, 'core_audit_details']) {
    assert.ok(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`).test(applied),
      `${table} is named by the code but not created by 0057`
    );
  }
});

test('the migration header names this file, and this file exists — the claim and the guard are one thing', () => {
  const header = readFileSync(MIGRATION, 'utf8').slice(0, 2000);
  assert.match(header, /tests\/coreOutbox\.test\.ts/, 'the header must name its anti-drift guard');
});
