/**
 * NO WRITER REPLACES A FROZEN ROW (FX programme plan §4 rules, critique F8).
 *
 * In SQLite, INSERT OR REPLACE deletes the old row without firing the DELETE
 * trigger and fires no UPDATE trigger, so every frozen 0179 table also carries
 * a BEFORE INSERT "no re-insert" trigger — which ALSO fires on INSERT OR
 * IGNORE and on an upsert's DO UPDATE. So no code may use OR REPLACE, OR
 * IGNORE, REPLACE INTO or ON CONFLICT against these tables: a new row is a
 * plain INSERT, an existing one a version-fenced UPDATE
 * (tests/fxPairsMigration0179.test.ts proves the triggers refuse them).
 *
 * Run: node --import tsx --test tests/noReplaceOnFrozen.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';

/** The frozen tables: 0179's, and 0181's — the pricing inputs and rules, the pricing audit and the batch lots. */
export const FROZEN = ['fx_rate_pairs', 'fx_rate_log', 'pricing_fx_rates', 'pricing_shipping_rates', 'pricing_inputs', 'pricing_rules', 'pricing_audit', 'inventory_lots'];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx|mjs|js|sql)$/.test(name)) out.push(p);
  }
  return out;
}

test('no OR REPLACE / OR IGNORE / REPLACE INTO / ON CONFLICT names a frozen table — in the Worker, the services, the scripts or a later migration', () => {
  const t = FROZEN.join('|');
  const replace = new RegExp(`(?:INSERT\\s+OR\\s+(?:REPLACE|IGNORE)\\s+INTO|REPLACE\\s+INTO)\\s+(${t})\\b`, 'i');
  const upsert = new RegExp(`INSERT\\s+INTO\\s+(${t})\\b[^;]*?ON\\s+CONFLICT`, 'is');
  const hits: string[] = [];
  const scanned = [
    ...files(join(ROOT, 'worker')),
    ...files(join(ROOT, 'services')),
    ...files(join(ROOT, 'scripts')),
    ...files(join(ROOT, 'migrations')).filter((f) => /\/(\d{4})_/.exec(f) && Number(/\/(\d{4})_/.exec(f)![1]) > 179),
  ];
  for (const f of scanned) {
    const text = readFileSync(f, 'utf8');
    if (replace.test(text) || upsert.test(text)) hits.push(relative(ROOT, f));
  }
  assert.deepEqual(hits, []);
  assert.ok(scanned.length > 200, `only ${scanned.length} files scanned`);
});

test('not vacuous: the patterns catch each forbidden shape', () => {
  const t = FROZEN.join('|');
  const replace = new RegExp(`(?:INSERT\\s+OR\\s+(?:REPLACE|IGNORE)\\s+INTO|REPLACE\\s+INTO)\\s+(${t})\\b`, 'i');
  const upsert = new RegExp(`INSERT\\s+INTO\\s+(${t})\\b[^;]*?ON\\s+CONFLICT`, 'is');
  assert.ok(replace.test('INSERT OR REPLACE INTO fx_rate_pairs (pair) VALUES (?)'));
  assert.ok(replace.test('insert or ignore into fx_rate_log (id) values (?)'));
  assert.ok(replace.test('REPLACE INTO pricing_fx_rates (currency) VALUES (?)'));
  assert.ok(upsert.test("INSERT INTO pricing_shipping_rates (profile) VALUES (?)\n ON CONFLICT(profile) DO UPDATE SET rate_iqd = ?"));
  assert.equal(replace.test('INSERT INTO fx_rate_log (id) VALUES (?)'), false);
});
