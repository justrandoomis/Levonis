/**
 * Mandate §12: "migrations تعمل على قاعدة جديدة وعلى نسخة من schema الحالية،
 * وتنجح مرتين دون تكرار أو تلف" — migrations must apply to a fresh database
 * and to a copy of the current schema, and must survive a second run without
 * duplicating or corrupting anything.
 *
 * scripts/migrate-check.mjs applies migrations/ to a throwaway SQLite database
 * exactly the way D1 does (one transaction per file, foreign keys ON, applied
 * files recorded in d1_migrations), then re-runs the whole set and re-executes
 * the newest migration's idempotent statements and asserts no row moved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = (args: string[]) =>
  execFileSync('node', ['scripts/migrate-check.mjs', ...args], {
    encoding: 'utf8',
    env: { ...process.env, MIGRATE_CHECK_DIR: '/tmp/levonis-migrate-check-test' },
  });

test('migrations apply to a fresh database and survive a second pass', () => {
  const out = run(['--twice']);
  assert.match(out, /second full pass applied 0 files/);
  /**
   * THE NEWEST MIGRATION MUST BE PROVEN, AND THERE ARE TWO KINDS OF PROOF.
   *
   * Most files carry re-runnable statements (`CREATE … IF NOT EXISTS`,
   * `INSERT OR IGNORE`), and the harness re-executes them and asserts no row
   * moved. A file made only of `ALTER TABLE … ADD COLUMN` — 0079 is the first
   * — cannot be re-run at all, because SQLite has no `ADD COLUMN IF NOT
   * EXISTS`; its proof is that every column it names is PRESENT after one
   * pass, with the bookkeeping pass above showing it ran exactly once.
   *
   * Either line satisfies this, and NEITHER does not: a migration the harness
   * cannot speak for is untested, not proven.
   */
  const reran = Number(/(\d+) idempotent statement\(s\) re-ran/.exec(out)?.[1] ?? 0);
  const added = Number(/is (\d+) ADD COLUMN\(s\), every one present/.exec(out)?.[1] ?? 0);
  assert.ok(
    reran > 0 || added > 0,
    `the newest migration proved nothing: ${reran} re-run statements, ${added} verified columns`
  );
  assert.match(out, /foreign_key_check violations: 0/);
  assert.match(out, /orphan catalogs: 0/);
  if (reran > 0) assert.match(out, /no trigger changed/);
});

test('migration replay refuses unpaired or mismatched trigger drops', () => {
  const work = mkdtempSync(join(tmpdir(), 'levonis-trigger-replay-'));
  try {
    cpSync('migrations', join(work, 'migrations'), { recursive: true });
    for (const sql of [
      'DROP TRIGGER finance_line_department_no_delete;',
      `DROP TRIGGER finance_line_department_no_delete;
       CREATE TRIGGER wrong_replacement BEFORE DELETE ON finance_line_departments
       BEGIN SELECT RAISE(ABORT, 'wrong replacement'); END;`,
    ]) {
      writeFileSync(join(work, 'migrations/9999_unpaired_trigger.sql'), sql);
      assert.throws(() => execFileSync('node', [resolve('scripts/migrate-check.mjs'), '--twice'], {
        cwd: work,
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, MIGRATE_CHECK_DIR: join(work, 'check') },
      }), /no statement in it is re-runnable by this harness/);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('every migration file is numbered uniquely and applied in order', () => {
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
  const numbers = files.map((f) => f.slice(0, 4));
  assert.equal(new Set(numbers).size, numbers.length, 'duplicate migration numbers');
  assert.deepEqual([...numbers], [...numbers].sort(), 'migration numbers are not sortable in order');
});

test('LEVO PRIME is a real, priced, annual-only plan (§5)', () => {
  const sql = readFileSync('migrations/0018_prime_taxonomy_inventory.sql', 'utf8');
  assert.match(sql, /'prime_12mo', 'prime', 12, 99000/);
  assert.match(sql, /CHECK \(tier IN \('plus','pro','prime'\)\)/);
});

test('§2: no product-page extraction endpoint or panel remains', () => {
  assert.equal(existsSync('worker/routes/extract.ts'), false);
  assert.equal(existsSync('src/components/adminProducts/ExtractPanel.tsx'), false);
  const index = readFileSync('worker/index.ts', 'utf8');
  assert.equal(/extract/i.test(index), false, 'worker/index.ts still mounts an extraction route');
  const misc = readFileSync('worker/routes/misc.ts', 'utf8');
  assert.equal(/miscRoutes\.post\('\/extract'/.test(misc), false, 'legacy /api/extract still mounted');
});
