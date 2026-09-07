/**
 * Table ownership (`01-TARGET.md` §2.1): `TABLE_OWNER` in `@levonis/contracts`
 * is generated from the design table; this test fails when a migration
 * creates a table absent from it, when two owners claim one table, or when a
 * service's OWNERSHIP.json claims a table the design gives to someone else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_OWNER, TABLE_OWNER_ENTRIES, ownerOfTable, platformTableOwner } from '@levonis/contracts/ownership';
import { SERVICE_NAMES } from '@levonis/contracts/subscriptions';
import { listServices, readManifest } from './lib/boundaries';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every table a migration creates, with comments stripped first (a comment saying "CREATE TABLE only" is not a table). */
export function tablesCreatedByMigrations(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of sql.matchAll(/CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"[]?([A-Za-z_][A-Za-z0-9_]*)[`"\]]?/gi)) {
      const t = m[1];
      if (!out.has(t)) out.set(t, []);
      out.get(t)!.push(f);
    }
  }
  return out;
}

test('every table created by migrations/ has exactly one owner in the design', () => {
  const created = tablesCreatedByMigrations();
  assert.ok(created.size >= 130, `expected the full schema, saw ${created.size} tables`);
  const orphans = [...created.keys()].filter((t) => !ownerOfTable(t));
  assert.deepEqual(orphans, [], `tables without an owner (add them to 01-TARGET.md §2.1 and packages/contracts/src/ownership.ts): ${orphans.join(', ')}`);
});

test('no table is claimed twice and every owner is a known service', () => {
  const seen = new Map<string, string>();
  for (const [table, owner] of TABLE_OWNER_ENTRIES) {
    assert.ok(!seen.has(table), `${table} is claimed by both ${seen.get(table)} and ${owner}`);
    seen.set(table, owner);
    assert.ok((SERVICE_NAMES as readonly string[]).includes(owner), `${owner} is not a service name`);
  }
  assert.equal(Object.keys(TABLE_OWNER).length, TABLE_OWNER_ENTRIES.length);
  assert.equal(TABLE_OWNER.rate_limits, 'identity', 'ADR-016: the cross-isolate counter belongs to Identity, never the gateway');
  assert.equal(TABLE_OWNER.admin_tg_identities, 'ledger', 'who may approve stays with the money');
  assert.equal(TABLE_OWNER.tg_admin_notifications, 'notifications', 'transport state is Notifications');
  assert.equal(TABLE_OWNER.restriction_cases, 'risk');
});

test('a service OWNERSHIP.json owns only the tables the design assigns to it (plus its platform tables); no two manifests own the same table', () => {
  const ownedBy = new Map<string, string>();
  for (const svc of listServices(ROOT)) {
    const m = readManifest(join(ROOT, 'services', svc));
    if (!m) continue;
    const name = m.service ?? svc;
    for (const table of m.owns) {
      const designOwner = ownerOfTable(table);
      const platform = platformTableOwner(table);
      assert.ok(designOwner === name || platform === name || platform === 'platform', `services/${svc} claims ${table}, which the design gives to ${designOwner ?? 'nobody'}`);
      assert.ok(!ownedBy.has(table), `${table} is owned by both ${ownedBy.get(table)} and ${svc}`);
      ownedBy.set(table, svc);
    }
    for (const table of m.reads) assert.ok(ownerOfTable(table), `services/${svc} reads unknown table ${table}`);
  }
});
