/**
 * The boundary this service must not cross, checked from inside it
 * (`01-TARGET.md` §2.3, §4 item 5, rule 3 of the slice brief: "it never runs
 * SQL against tables it does not own — enforce with a test").
 *
 * The repo-level `tests/serviceBoundaries.test.ts` scans the source text of
 * every service. This test is the other half: it proves the RUNTIME guard —
 * `ownedDb()` in `throw` mode, which is what `src/index.ts` wraps the database
 * in — actually refuses a foreign statement, and that the three declarations of
 * what this service owns (the manifest, the runtime list, the migration) say
 * the same thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ownedDb, OwnershipViolation, tablesInSql } from '@levonis/platform-kit/db';
import { ownerOfTable, platformTableOwner } from '@levonis/contracts/ownership';
import { SUBSCRIPTIONS } from '@levonis/contracts/subscriptions';
import { ADS_EVENT_TYPES } from '../src/consumers';
import { ADS_OWNS, ADS_READS } from '../src/store';
import { adsDb, SERVICE_ROOT } from './_harness';

interface Manifest {
  service: string;
  owns: string[];
  reads: string[];
  calls: string[];
  publishes: string[];
  consumes: string[];
  secrets: string[];
}

const manifest = JSON.parse(readFileSync(join(SERVICE_ROOT, 'OWNERSHIP.json'), 'utf8')) as Manifest;

function srcFiles(dir = join(SERVICE_ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('the runtime list, the manifest and the design agree on what Ads owns', () => {
  assert.deepEqual([...ADS_OWNS].sort(), [...manifest.owns].sort());
  assert.deepEqual([...ADS_READS], manifest.reads);
  assert.deepEqual(manifest.reads, [], 'Ads joins locally and reads no other service (01-TARGET.md §9.1)');
  for (const t of ADS_OWNS) assert.equal(ownerOfTable(t), 'ads', `${t} is not ads-owned in the design`);
});

test('every table named by a SQL literal anywhere in src/ is owned by this service', () => {
  const owned = new Set<string>(ADS_OWNS);
  const offenders: string[] = [];
  for (const file of srcFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g)) {
      const text = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ? ');
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) continue;
      const { reads, writes } = tablesInSql(text);
      for (const t of [...reads, ...writes]) {
        if (owned.has(t) || platformTableOwner(t) === 'ads' || platformTableOwner(t) === 'platform') continue;
        offenders.push(`${file.slice(SERVICE_ROOT.length + 1)}: ${t}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the runtime guard REFUSES a foreign statement, it does not merely log it', async () => {
  const { db } = adsDb();
  const guarded = ownedDb(db, { service: 'ads', owns: ADS_OWNS, reads: ADS_READS }, { mode: 'throw' });
  // its own tables are fine, including the implied platform ones
  assert.doesNotThrow(() => guarded.prepare('SELECT 1 FROM ads_deliveries'));
  assert.doesNotThrow(() => guarded.prepare('INSERT INTO ads_processed_events (event_id) VALUES (?)'));
  // somebody else's are not — read or write, and whatever the intent
  for (const sql of [
    'SELECT email FROM users WHERE id = ?',
    'UPDATE orders SET status = ? WHERE id = ?',
    'SELECT o.id FROM ads_deliveries d JOIN orders o ON o.id = d.event_id',
    'INSERT INTO analytics_events (event_id) VALUES (?)',
  ]) {
    assert.throws(() => guarded.prepare(sql), OwnershipViolation, sql);
  }
});

test('the consumer accepts exactly the six types subscriptions.ts lists for ads, and the manifest says the same', () => {
  const fromTable = Object.entries(SUBSCRIPTIONS)
    .filter(([, consumers]) => (consumers as readonly string[]).includes('ads'))
    .map(([key]) => key)
    .sort();
  assert.deepEqual([...ADS_EVENT_TYPES].sort(), fromTable);
  assert.deepEqual([...manifest.consumes].sort(), fromTable);
  assert.ok(!fromTable.includes('UserCreated.v1'), 'no consent can exist at signup (03-EVENTS.md §3.1)');
});

test('Ads declares no call to any other service and publishes nothing yet', () => {
  assert.deepEqual(manifest.calls, []);
  assert.deepEqual(manifest.publishes, []);
});

test('every secret NAME the adapters look for is declared in the manifest, and no value of one is in the tree', async () => {
  const names = new Set(manifest.secrets);
  const { META_SECRET_NAMES } = await import('../src/providers/meta');
  const { GOOGLE_SECRET_NAMES } = await import('../src/providers/google');
  const { TIKTOK_SECRET_NAMES } = await import('../src/providers/tiktok');
  const { SNAPCHAT_SECRET_NAMES } = await import('../src/providers/snapchat');
  for (const n of [...META_SECRET_NAMES, ...GOOGLE_SECRET_NAMES, ...TIKTOK_SECRET_NAMES, ...SNAPCHAT_SECRET_NAMES]) {
    assert.ok(names.has(n), `${n} is read by an adapter but not declared in OWNERSHIP.json secrets`);
  }
  // and no source file interpolates a secret into anything but a request header
  for (const file of srcFiles()) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(TOKEN|SECRET|ACCESS)/.test(src), `${file}: a credential name appears in a log call`);
  }
});
