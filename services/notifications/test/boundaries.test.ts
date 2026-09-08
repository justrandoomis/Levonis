/**
 * The boundary this service must not cross, checked from inside it
 * (`01-TARGET.md` §2.3, §4 item 5): the RUNTIME guard refuses a foreign
 * statement, and the three declarations of what this service owns — the
 * manifest, the runtime list and the migration — say the same thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ownedDb, OwnershipViolation, tablesInSql } from '@levonis/platform-kit/db';
import { ownerOfTable, platformTableOwner } from '@levonis/contracts/ownership';
import { SUBSCRIPTIONS } from '@levonis/contracts/subscriptions';
import { NOTIFICATION_EVENT_TYPES } from '../src/consumers';
import { NOTIFICATIONS_OWNS, NOTIFICATIONS_READS } from '../src/store';
import { notifyDb, SERVICE_ROOT } from './_harness';

interface Manifest {
  service: string;
  owns: string[];
  reads: string[];
  calls: string[];
  publishes: string[];
  consumes: string[];
  secrets: string[];
  legacyRoutes: string[];
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

test('the runtime list, the manifest and the design agree on what Notifications owns', () => {
  assert.deepEqual([...NOTIFICATIONS_OWNS].sort(), [...manifest.owns].sort());
  assert.deepEqual([...NOTIFICATIONS_READS], manifest.reads);
  assert.deepEqual(manifest.reads, [], 'the events carry what a message needs; a contact comes from IDENTITY.contactFor, never from `users`');
  for (const t of NOTIFICATIONS_OWNS) assert.equal(ownerOfTable(t), 'notifications', `${t} is not notifications-owned in the design`);
});

test('every table named by a SQL literal anywhere in src/ is owned by this service', () => {
  const owned = new Set<string>(NOTIFICATIONS_OWNS);
  const offenders: string[] = [];
  for (const file of srcFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'/g)) {
      const text = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ? ');
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text)) continue;
      const { reads, writes } = tablesInSql(text);
      for (const t of [...reads, ...writes]) {
        if (owned.has(t) || platformTableOwner(t) === 'notifications' || platformTableOwner(t) === 'platform') continue;
        offenders.push(`${file.slice(SERVICE_ROOT.length + 1)}: ${t}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the runtime guard REFUSES a foreign statement, it does not merely log it', async () => {
  const { db } = notifyDb();
  const guarded = ownedDb(db, { service: 'notifications', owns: NOTIFICATIONS_OWNS, reads: NOTIFICATIONS_READS }, { mode: 'throw' });
  assert.doesNotThrow(() => guarded.prepare('SELECT 1 FROM notify_outbox'));
  assert.doesNotThrow(() => guarded.prepare('INSERT INTO notifications_processed_events (event_id) VALUES (?)'));
  for (const sql of [
    'SELECT email FROM users WHERE id = ?',
    'UPDATE orders SET status = ? WHERE id = ?',
    'SELECT u.email FROM user_notifications n JOIN users u ON u.id = n.user_id',
    'INSERT INTO wallet_transactions (id) VALUES (?)',
    // the legacy core table of the same purpose is NOT this service's: the
    // monolith keeps writing `outbox` in the shared database and this Worker
    // must never reach into it.
    "SELECT id FROM outbox WHERE state = 'pending'",
  ]) {
    assert.throws(() => guarded.prepare(sql), OwnershipViolation, sql);
  }
});

test('the consumer handles exactly what the manifest declares, and every declared type is one subscriptions.ts gives us', () => {
  assert.deepEqual([...NOTIFICATION_EVENT_TYPES].sort(), [...manifest.consumes].sort());
  for (const key of manifest.consumes) {
    assert.ok((SUBSCRIPTIONS[key] as readonly string[] | undefined)?.includes('notifications'), `${key} does not list notifications`);
  }
});

test('the types subscriptions.ts lists but this slice does not handle are named, not forgotten', () => {
  const subscribed = Object.entries(SUBSCRIPTIONS)
    .filter(([, consumers]) => (consumers as readonly string[]).includes('notifications'))
    .map(([key]) => key);
  const unhandled = subscribed.filter((k) => !(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(k)).sort();
  assert.ok(unhandled.length > 0, 'this test is about the gap; if it closes, delete it');
  const notes = JSON.stringify((manifest as unknown as { notes: Record<string, string> }).notes.consumes);
  for (const key of unhandled) {
    const type = key.replace(/\.v\d+$/, '');
    assert.ok(notes.includes(type), `${type} is subscribed but neither handled nor named in OWNERSHIP.json notes`);
  }
});

test('Notifications declares no call and publishes nothing yet; its legacy routes are the core\'s, spelled exactly', () => {
  assert.deepEqual(manifest.calls, []);
  assert.deepEqual(manifest.publishes, []);
  const coreRoutes = readFileSync(join(SERVICE_ROOT, '..', '..', 'worker', 'index.ts'), 'utf8');
  for (const route of manifest.legacyRoutes) {
    const mount = route.split('/').slice(0, 3).join('/');
    assert.ok(coreRoutes.includes(`'${mount}'`), `the core no longer mounts ${mount}`);
  }
});

test('no source file logs a credential name', () => {
  for (const file of srcFiles()) {
    const src = readFileSync(file, 'utf8');
    assert.ok(!/console\.(log|error|warn)\([^)]*(TOKEN|SECRET|API_KEY)/.test(src), `${file}: a credential name appears in a log call`);
  }
});
