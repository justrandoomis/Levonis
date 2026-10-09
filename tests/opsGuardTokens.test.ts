/**
 * A FIXED ops_guards TOKEN IS ALWAYS DELETED IN THE BATCH THAT INSERTED IT
 * (FX programme plan §5.3, critique F15).
 *
 * `ops_guards` (0162: `id` primary key, CHECK ok = 1) carries two kinds of
 * row: a fence (`fence()`, worker/lib/operations.ts — a fresh id inserted and
 * deleted by the same two statements) and a FIXED token a database guard
 * reads (`cancelled-order-delete:<id>`, `promotion-write:<id>`, and from
 * FX-5 the repricing writer's `pricing-rates-apply`). A fixed token left
 * behind would disarm the guard that reads it, so every file that inserts one
 * must also delete the same token. FX-1 adds no fixed token: the FX module
 * fences only.
 *
 * Run: node --import tsx --test tests/opsGuardTokens.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** The fixed token prefixes a file inserts: a literal in the VALUES, or the literal head of the bound id. */
export function insertedTokens(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/INSERT\s+INTO\s+ops_guards\s*\(\s*id\s*,\s*ok\s*\)\s*(VALUES\s*\(\s*'([^']+)'|VALUES\s*\(\s*\?[^)]*\)[^;]{0,40}?\.bind\(\s*[`'"]([a-z][a-z0-9_-]*:?)|SELECT)/gis)) {
    const literal = m[2] ?? m[3];
    if (literal) out.add(literal.replace(/'\|\|.*$/, ''));
  }
  return [...out];
}

test('every fixed token a Worker file inserts, it also deletes', () => {
  const problems: string[] = [];
  let tokens = 0;
  for (const f of walk(join(ROOT, 'worker'))) {
    const src = readFileSync(f, 'utf8');
    for (const token of insertedTokens(src)) {
      tokens++;
      const deleted = new RegExp(`DELETE\\s+FROM\\s+ops_guards\\s+WHERE\\s+id\\s*=\\s*(?:'${token}|\\?[^;]{0,40}?\\.bind\\(\\s*[\`'"]${token})`, 'is').test(src);
      if (!deleted) problems.push(`${relative(ROOT, f)}: inserts ops_guards token ${token} and never deletes it`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(tokens >= 2, `only ${tokens} fixed tokens found — the scan reads nothing`);
});

test('the FX module uses fences only: no fixed token, and pricing-rates-apply does not exist before FX-5', () => {
  for (const f of walk(join(ROOT, 'worker/lib/fx'))) assert.deepEqual(insertedTokens(readFileSync(f, 'utf8')), [], relative(ROOT, f));
  for (const f of walk(join(ROOT, 'worker'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /pricing-rates-apply/, relative(ROOT, f));
});

test('not vacuous: the scan reads both token shapes', () => {
  assert.deepEqual(insertedTokens(`db.prepare("INSERT INTO ops_guards(id,ok) VALUES ('cancelled-order-delete:'||?,1)")`), ['cancelled-order-delete:']);
  assert.deepEqual(insertedTokens("db.prepare('INSERT INTO ops_guards(id,ok) VALUES (?,1)').bind(`promotion-write:${x}`)"), ['promotion-write:']);
  assert.deepEqual(insertedTokens('INSERT INTO ops_guards(id,ok) SELECT ?, CASE WHEN 1 THEN 1 ELSE 0 END'), []);
});
