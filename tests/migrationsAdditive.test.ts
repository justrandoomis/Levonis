/**
 * What the migration gate will and will not let through.
 *
 * WHY THIS EXISTS. `13 - Apply Studio Migrations` refuses to run a migration
 * that is not purely additive, and that refusal is the only thing standing
 * between a future migration and a live database. So the classifier behind it
 * is tested here rather than trusted.
 *
 * The first version of this gate was a grep for ALTER/UPDATE/DELETE/DROP. It
 * would have rejected the repo's only Studio migration, because every foreign
 * key in it reads `ON UPDATE no action ON DELETE no action` inside a CREATE
 * TABLE. A gate that fails on the one safe migration teaches people to bypass
 * it, so the classifier judges statements by the verb they begin with. Both
 * halves of that — catching the real thing, and not crying wolf — are pinned
 * below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error - plain ESM helper shared with the workflow, no types
import { auditDirectory, classify, statements } from '../scripts/check-migrations-additive.mjs';

const STUDIO_MIGRATIONS = new URL('../studio/drizzle', import.meta.url).pathname;

test('the repo’s Studio migration is additive, foreign keys and all', () => {
  const reports = auditDirectory(STUDIO_MIGRATIONS);
  assert.ok(reports.length > 0, 'studio/drizzle should contain at least one migration');
  for (const report of reports) {
    const offending = report.statements.filter((s: { additive: boolean }) => !s.additive);
    assert.deepEqual(offending, [], `${report.file} was classified as non-additive: ${JSON.stringify(offending)}`);
  }
});

test('a foreign key’s ON UPDATE / ON DELETE is not a data change', () => {
  // The exact shape drizzle emits, and the exact shape the naive grep failed on.
  const sql = `CREATE TABLE project_files (
    id text PRIMARY KEY NOT NULL,
    revision_id text NOT NULL,
    FOREIGN KEY (revision_id) REFERENCES project_revisions(id) ON UPDATE no action ON DELETE no action
  )`;
  assert.equal(classify(sql).additive, true);
});

test('the statements that can touch existing data are all refused', () => {
  const cases: Array<[string, string]> = [
    ['ALTER TABLE projects ADD COLUMN archived INTEGER', 'ALTER TABLE'],
    ['DROP TABLE projects', 'DROP'],
    ['DROP INDEX idx_projects_owner_updated', 'DROP'],
    ['DELETE FROM projects WHERE deleted_at IS NOT NULL', 'DELETE'],
    ['UPDATE projects SET name = \'x\'', 'UPDATE'],
    ['INSERT INTO projects (id) VALUES (\'x\')', 'INSERT'],
    ['REPLACE INTO projects (id) VALUES (\'x\')', 'REPLACE'],
    ['PRAGMA foreign_keys = OFF', 'PRAGMA'],
    ['VACUUM', 'VACUUM'],
    ['ATTACH DATABASE \'other.db\' AS other', 'ATTACH'],
  ];
  for (const [sql, expected] of cases) {
    const verdict = classify(sql);
    assert.equal(verdict.additive, false, `${sql} should have been refused`);
    assert.ok(verdict.reason.startsWith(expected), `${sql} -> ${verdict.reason}`);
  }
});

test('an unrecognised statement is refused rather than assumed harmless', () => {
  // The allowlist is closed on purpose: a statement nobody thought about is
  // not a statement to run unattended against a live database.
  const verdict = classify('CREATE VIRTUAL TABLE fts USING fts5(name)');
  assert.equal(verdict.additive, false);
  assert.match(verdict.reason, /allowlist/);
});

test('splitting respects comments, string literals and drizzle breakpoints', () => {
  const sql = [
    "-- DROP TABLE projects  (this is a comment, not a statement)",
    "CREATE TABLE a (id TEXT PRIMARY KEY, note TEXT DEFAULT 'x; DELETE FROM b');",
    '--> statement-breakpoint',
    'CREATE INDEX idx_a ON a (id);',
  ].join('\n');

  const parsed = statements(sql);
  assert.equal(parsed.length, 2, `expected two statements, got ${JSON.stringify(parsed)}`);
  assert.ok(parsed[0].startsWith('CREATE TABLE a'));
  assert.ok(parsed[1].startsWith('CREATE INDEX idx_a'));
  for (const s of parsed) assert.equal(classify(s).additive, true);
});

test('the gate is the one the workflow actually runs', () => {
  // If the workflow stops calling this script, these tests guard nothing.
  const workflow = readFileSync(new URL('../.github/workflows/apply-studio-migrations.yml', import.meta.url), 'utf8');
  assert.match(workflow, /node scripts\/check-migrations-additive\.mjs studio\/drizzle/);
  // And it must stay opt-in: dry_run defaults to true, and a real run needs
  // the confirmation phrase. Read the dry_run block itself — a regex over a
  // window of characters would happily match the NEXT input's default.
  const lines = workflow.split('\n');
  const first = lines.findIndex((line) => /^ {6}dry_run:/.test(line));
  assert.ok(first >= 0, 'the workflow no longer declares a dry_run input');
  const block: string[] = [];
  for (const line of lines.slice(first + 1)) {
    if (/^ {0,6}\S/.test(line)) break; // the next key at the same or lower level
    block.push(line.trim());
  }
  assert.ok(block.includes('default: true'),
    `dry_run must default to true; its block is ${JSON.stringify(block)}`);
  assert.match(workflow, /APPLY-STUDIO-MIGRATIONS/);
});

/**
 * The var-preservation greps in the "keeps vars" deploy workflows.
 *
 * These workflows read the live Worker's variables back from the API and
 * re-send them, because `wrangler deploy` replaces plain-text vars wholesale.
 * Each name that is about to be overridden is first removed from the
 * carried-over list with `grep -v "^NAME<TAB>"`. One of the four wrote the
 * two characters `\t` instead of a real tab, which in a BRE pattern matches a
 * literal `t` — so `^GOOGLE_CLIENT_IDt` never matched, the old line survived,
 * and a duplicate `--var GOOGLE_CLIENT_ID:` reached wrangler.
 *
 * It is pinned here because this is the workflow the owner must run to set
 * STUDIO_ALLOWED_DESTINATIONS, and a var-handling bug in that same script is
 * the kind that surfaces as "I set it and nothing happened".
 */
test('every var-preservation grep uses a real tab, not the characters \\t', () => {
  for (const file of ['deploy-staging-code.yml', 'deploy-studio-code.yml']) {
    const text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.includes('grep -v "^')) continue;
      assert.ok(
        !line.includes('\\t'),
        `${file}:${index + 1} uses the characters \\t where a tab is required: ${line.trim()}`
      );
      assert.ok(
        line.includes('\t'),
        `${file}:${index + 1} has no tab in its pattern: ${line.trim()}`
      );
    }
  }
});
