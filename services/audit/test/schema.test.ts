/**
 * The schema the code writes against and the migration the deploy applies are
 * one text (`src/schema.ts` → `migrations/0001_audit_init.sql`), the migration
 * is additive and re-runnable, and it creates exactly the tables the design
 * gives to Audit plus this consumer's platform tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOfTable, platformTableOwner } from '@levonis/contracts/ownership';
import { auditSchemaSql } from '../src/schema';
import { migrationSql, SERVICE_ROOT, count } from './_db';

const statements = (sql: string): string[] =>
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

test('the migration is the schema module, statement for statement', () => {
  assert.deepEqual(statements(migrationSql()), statements(auditSchemaSql()));
});

test('every statement is CREATE ... IF NOT EXISTS — additive and re-runnable', () => {
  for (const s of statements(migrationSql())) {
    assert.match(s, /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/, `not additive: ${s}`);
  }
});

test('applying the migration twice leaves the same schema and no rows', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(migrationSql());
  const after1 = tables(raw);
  raw.exec(migrationSql());
  assert.deepEqual(tables(raw), after1, 'the second pass changed the schema');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_events'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM audit_chain_heads'), 0);
});

test('it creates only tables the design gives to Audit (or this service own platform tables)', () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(migrationSql());
  for (const t of tables(raw, 'table')) {
    if (t.startsWith('sqlite_')) continue;
    const owner = ownerOfTable(t) ?? platformTableOwner(t);
    assert.equal(owner, 'audit', `${t} is owned by ${owner ?? 'nobody'}, not audit`);
  }
});

test('the service keeps its own migration stream, separate from the core stream', () => {
  const files = readdirSync(join(SERVICE_ROOT, 'migrations')).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0);
  for (const f of files) assert.match(f, /^\d{4}_[a-z0-9_]+\.sql$/, `${f}: NNNN_name.sql`);
  // the core's stream must not carry Audit's tables: they live in another database
  const core = readdirSync(join(SERVICE_ROOT, '..', '..', 'migrations')).filter((f) => f.endsWith('.sql'));
  assert.ok(core.length > 0 && !core.includes(files[0]), 'the audit migration is not part of the core stream');
});

function tables(raw: DatabaseSync, kind: 'table' | 'both' = 'both'): string[] {
  const sql =
    kind === 'table'
      ? "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      : "SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name";
  return (raw.prepare(sql).all() as Array<{ name: string }>).map((r) => r.name).filter((n) => !n.startsWith('sqlite_autoindex'));
}
