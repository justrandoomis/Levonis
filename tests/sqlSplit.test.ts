/**
 * The migration harness splits a .sql file into statements before running
 * them. A trigger body is `BEGIN …; …; END;` — semicolons that are not
 * boundaries — and a naive split would hand SQLite half a trigger. wrangler
 * tracks BEGIN/CASE … END; the local splitter must agree with it, or a
 * migration that deploys fine would fail the local check (or the reverse).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { unstable_splitSqlQuery as splitWithWrangler } from 'wrangler';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';

test('ordinary statements split on semicolons, comments and strings honoured', () => {
  const sql = "CREATE TABLE a (x TEXT); -- note; not a split\nINSERT INTO a VALUES ('x;y'); /* c; */ SELECT 1;";
  assert.deepEqual(splitStatements(sql), ["CREATE TABLE a (x TEXT)", "INSERT INTO a VALUES ('x;y')", 'SELECT 1']);
});

test('a trigger stays one statement, and what follows it is still split', () => {
  const trigger = [
    'CREATE TRIGGER IF NOT EXISTS t BEFORE INSERT ON r',
    'BEGIN',
    "  SELECT RAISE(ABORT, 'A') WHERE (SELECT COUNT(*) FROM r) >= 1;",
    "  SELECT RAISE(ABORT, 'B') WHERE 1 = 2;",
    'END;',
  ].join('\n');
  const parts = splitStatements(trigger + '\nALTER TABLE o ADD COLUMN c INTEGER NOT NULL DEFAULT 0;');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('CREATE TRIGGER'));
  assert.ok(parts[0].endsWith('END'), 'the trigger runs through its END');
  assert.ok(parts[0].includes("RAISE(ABORT, 'B')"), 'both body statements are inside it');
  assert.equal(parts[1], 'ALTER TABLE o ADD COLUMN c INTEGER NOT NULL DEFAULT 0');
});

test('a CASE expression inside an ordinary statement does not swallow the next one', () => {
  const sql = "UPDATE t SET v = CASE WHEN a THEN 1 ELSE 0 END; SELECT 2;";
  assert.deepEqual(splitStatements(sql), ['UPDATE t SET v = CASE WHEN a THEN 1 ELSE 0 END', 'SELECT 2']);
});

test('a CASE ending with a comma or parenthesis closes before the next statement', () => {
  const sql = [
    'INSERT INTO t(a,b) SELECT CASE WHEN x THEN 1 ELSE 0 END,',
    'coalesce(CASE WHEN y THEN 2 ELSE 3 END) FROM s;',
    'SELECT 4;',
  ].join('\n');
  const parts = splitStatements(sql);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /END,\s*coalesce\([\s\S]*END\) FROM s$/);
  assert.equal(parts[1], 'SELECT 4');
});

test('the real 0049 migration splits into its three statements', () => {
  const parts = splitStatements(readFileSync('migrations/0049_security_hardening.sql', 'utf8'));
  assert.equal(parts.length, 3, parts.map((p: string) => p.slice(0, 40)).join(' | '));
  assert.match(parts[1], /^CREATE TRIGGER IF NOT EXISTS trg_coupon_redemption_limits[\s\S]*END$/);
});

test('the newest migration matches Wrangler local D1 statement boundaries', () => {
  const newest = readdirSync('migrations').filter((file) => file.endsWith('.sql')).sort().at(-1);
  assert.ok(newest, 'no migration file found');

  const sql = readFileSync(`migrations/${newest}`, 'utf8');
  const normalize = (statement: string) => statement.replace(/\s+/g, ' ').trim();
  const local = splitStatements(sql).map(normalize);
  const wrangler = splitWithWrangler(sql).map(normalize);

  assert.deepEqual(
    wrangler,
    local,
    `${newest} is valid SQLite, but Wrangler would merge or split its statements differently`
  );
});

test('every migration from 0179 on matches Wrangler local D1 statement boundaries, and none closes a CASE with END touching a parenthesis', () => {
  // Wrangler opens a CASE on whitespace + CASE + whitespace and closes it only
  // on whitespace + END + (whitespace or ';'). An END touching its closing
  // parenthesis never closes, and every later statement of the file is folded
  // into one: 0179 first carried exactly that and Wrangler saw ONE statement
  // where the harness saw 24. The check above reads only the newest file, so
  // it would stop looking at 0179 the day 0180 lands; this one keeps reading
  // every file from 0179 on. Older files are applied everywhere and stay as
  // they are (additive migrations only).
  const normalize = (statement: string) => statement.replace(/\s+/g, ' ').trim();
  const files = readdirSync('migrations').filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) >= 179).sort();
  assert.ok(files.includes('0179_fx_rates.sql'), 'the FX migration is read');
  for (const file of files) {
    const sql = readFileSync(`migrations/${file}`, 'utf8');
    const code = splitStatements(sql).join(';\n');
    assert.doesNotMatch(code, /\bEND\)/i, `${file}: write END ) with a space so Wrangler closes the CASE`);
    assert.deepEqual(splitWithWrangler(sql).map(normalize), splitStatements(sql).map(normalize), `${file}: Wrangler would merge or split its statements differently`);
  }
});
