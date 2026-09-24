/**
 * THE LIVE D1 REFUSES A COMPOUND SELECT OF MORE THAN 5 TERMS.
 *
 * Migration 0121 went out with a seven-term UNION ALL inside a trigger and the
 * deploy stopped at «too many terms in compound SELECT» (run 149). Workflow 58
 * measured the cap on the live database: a UNION ALL chain of 5 terms runs, 6
 * fail; a multi-row VALUES used as a table is NOT limited. The local test
 * engine allows 500, so nothing else in this suite could have seen it.
 *
 * This holds every migration statement and every SQL template in the Worker
 * to the cap. It counts UNIONs per statement (per template literal in code),
 * which over-counts when one statement holds two separate chains — erring
 * towards refusing, which is the side to err on before a deploy.
 *
 * Run: node --import tsx --test tests/d1CompoundLimit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { D1_MAX_UNION_TERMS } from '../worker/lib/storeLayout';

const ROOT = new URL('..', import.meta.url).pathname;
const unions = (sql: string) => (sql.replace(/--[^\n]*/g, '').match(/\bUNION\b/gi) ?? []).length;

test('the measured cap is the one the code uses', () => {
  assert.equal(D1_MAX_UNION_TERMS, 5);
});

test('no migration statement chains more than 5 compound SELECT terms', () => {
  const bad: string[] = [];
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(join(ROOT, 'migrations', f), 'utf8');
    // A trigger body holds `;` of its own: count per top-level statement by
    // splitting on `;` that ends a line outside BEGIN…END, approximated by
    // counting within each CREATE TRIGGER … END; block as one statement.
    const statements = sql.split(/;\s*\n(?![^]*?\bEND\b[^]*?;)|\bEND\s*;/i);
    for (const st of statements) {
      const terms = unions(st) + 1;
      if (terms > D1_MAX_UNION_TERMS) bad.push(`${f}: ${terms} terms`);
    }
  }
  assert.deepEqual(bad, [], 'a statement D1 would refuse');
});

function* tsFiles(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (n.endsWith('.ts')) yield p;
  }
}

test('no SQL template in the Worker chains more than 5 compound SELECT terms', () => {
  const bad: string[] = [];
  for (const file of tsFiles(join(ROOT, 'worker'))) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/`([^`]*)`/g)) {
      const terms = unions(m[1]) + 1;
      if (terms > D1_MAX_UNION_TERMS) bad.push(`${file.slice(ROOT.length)}: ${terms} terms`);
    }
    // A chain assembled at run time (`parts.join(' UNION ALL ')`) must be chunked.
    if (/\.join\(\s*['"`]\s*UNION/.test(src) && !/D1_MAX_UNION_TERMS/.test(src)) {
      bad.push(`${file.slice(ROOT.length)}: joins a UNION chain without chunking to D1_MAX_UNION_TERMS`);
    }
  }
  assert.deepEqual(bad, [], 'SQL D1 would refuse');
});
