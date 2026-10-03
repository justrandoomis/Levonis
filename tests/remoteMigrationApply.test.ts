import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const helper = join(root, 'scripts/apply-remote-migrations.mjs');
const base = '0098_inventory.sql';
const trigger = '0099_product_media_dimensions.sql';
const predecessor = '0161_storefront_vitals.sql';
const upgrade = '0162_operations_erp.sql';
const sampleFiles: Array<[string, string]> = [
  [base, "CREATE TABLE progression(name TEXT PRIMARY KEY); INSERT INTO progression VALUES ('base');"],
  [trigger, "CREATE TABLE media(value INTEGER); CREATE TRIGGER media_value AFTER INSERT ON media BEGIN UPDATE media SET value=value+1; END; INSERT INTO media VALUES (1);"],
  [predecessor, "CREATE TABLE storefront(value INTEGER); INSERT INTO progression VALUES ('predecessor');"],
  [upgrade, "CREATE TABLE operations(value INTEGER); INSERT INTO progression SELECT 'upgrade' FROM progression WHERE name='predecessor';"],
];
type Call = { args: string[]; sql?: string };

// This executable replaces npx on PATH. It executes imports against a local
// SQLite transaction, preserving the file-ingest rollback contract. It cannot
// reach Cloudflare and rejects any target or SQL command other than history.
const shim = `#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
const args = process.argv.slice(2);
const expected = ['--no-install','wrangler','d1','execute','levonis-db-staging','--remote','--env','staging','--yes'];
if (JSON.stringify(args.slice(0, expected.length)) !== JSON.stringify(expected)) process.exit(90);
const fileAt = args.indexOf('--file'), commandAt = args.indexOf('--command');
const sql = fileAt >= 0 ? readFileSync(args[fileAt+1], 'utf8') : undefined;
const previous = (() => { try { return readFileSync(process.env.MOCK_CALLS, 'utf8'); } catch { return ''; } })();
appendFileSync(process.env.MOCK_CALLS, JSON.stringify({args,sql})+'\\n');
if (commandAt >= 0 && args[commandAt+1] !== 'SELECT name FROM d1_migrations ORDER BY name') process.exit(91);
if (commandAt >= 0 && !args.includes('--json')) process.exit(94);
if (fileAt >= 0 && args.includes('--json')) process.exit(95);
const afterImport = previous.includes('"--file"');
if (commandAt >= 0 && (process.env.MOCK_HISTORY || (afterImport && process.env.MOCK_HISTORY_AFTER_IMPORT))) {
  const mode = process.env.MOCK_HISTORY || process.env.MOCK_HISTORY_AFTER_IMPORT;
  if (mode === 'failure') process.exit(43);
  if (mode === 'malformed') { console.log('not JSON'); process.exit(0); }
  if (mode === 'refused') { console.log(JSON.stringify([{success:false,results:[]}])); process.exit(0); }
}
const db = new DatabaseSync(process.env.MOCK_DB);
db.exec('PRAGMA foreign_keys=ON');
if (commandAt >= 0) {
  console.log(JSON.stringify([{success:true,results:db.prepare(args[commandAt+1]).all()}]));
  db.close();
} else if (fileAt >= 0) {
  if (!sql.includes('INSERT INTO d1_migrations (name) VALUES')) process.exit(92);
  db.exec('BEGIN');
  try {
    const actualSql = process.env.MOCK_OMIT_RECORD === basename(args[fileAt+1])
      ? sql.slice(0, sql.lastIndexOf('INSERT INTO d1_migrations (name) VALUES')) : sql;
    db.exec(actualSql);
    if (process.env.MOCK_FAIL_FILE === basename(args[fileAt+1])) throw new Error('injected import failure');
    db.exec('COMMIT');
    console.log('Uploading SQL file...');
    console.log('Executed SQL file successfully (progress output, not JSON)');
    db.close();
  } catch (error) {
    db.exec('ROLLBACK'); db.close(); console.error(error.message); process.exit(44);
  }
} else process.exit(93);
`;

function fixture(files = sampleFiles, applied = [base], seed = '') {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-import-test-'));
  const dbPath = join(dir, 'remote.sqlite');
  const callsPath = join(dir, 'calls.jsonl');
  mkdirSync(join(dir, 'migrations'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/npx'), shim, { mode: 0o755 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  for (const [name, sql] of files) {
    writeFileSync(join(dir, 'migrations', name), sql);
    if (applied.includes(name)) {
      db.exec(sql);
      db.prepare('INSERT INTO d1_migrations(name) VALUES (?)').run(name);
    }
  }
  if (seed) db.exec(seed);
  db.close();
  return {
    dir,
    run: (env: Record<string, string> = {}, args: string[] = []) => spawnSync(process.execPath, [helper, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, MOCK_DB: dbPath, MOCK_CALLS: callsPath, ...env },
    }),
    calls: (): Call[] => {
      try { return readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
      catch { return []; }
    },
    inspect: <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(dbPath);
      try { return read(db); } finally { db.close(); }
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const importedNames = (calls: Call[]) => calls.filter((call) => call.sql).map((call) => /VALUES \('([^']+)'\);\s*$/.exec(call.sql!)?.[1]);
const historyNames = (db: DatabaseSync) => db.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map((row) => row.name);

test('non-JSON file progress succeeds with confirmed history, preserves trigger bodies and order, and retries without duplication', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(importedNames(f.calls()), [trigger, predecessor, upgrade]);
    for (const call of f.calls()) {
      assert.deepEqual(call.args.slice(0, 9), ['--no-install', 'wrangler', 'd1', 'execute', 'levonis-db-staging', '--remote', '--env', 'staging', '--yes']);
      if (call.sql) {
        assert.ok(call.args.includes('--file'));
        assert.ok(!call.args.includes('--json'));
        assert.ok(!call.args.includes('--command'), 'schema and bookkeeping must share the file import');
      } else {
        assert.ok(call.args.includes('--json'), 'history confirmation must remain strict JSON');
      }
    }
    assert.match(result.stdout, /Executed SQL file successfully \(progress output, not JSON\)/);
    assert.match(f.calls().find((call) => call.sql?.includes('CREATE TRIGGER'))!.sql!, /BEGIN UPDATE media SET value=value\+1; END;/);
    f.inspect((db) => {
      assert.deepEqual(historyNames(db), sampleFiles.map(([name]) => name));
      assert.equal(db.prepare('SELECT value FROM media').get()!.value, 2);
      assert.ok(db.prepare("SELECT 1 FROM progression WHERE name='upgrade'").get());
    });
    const importsBefore = importedNames(f.calls()).length;
    assert.equal(f.run().status, 0);
    assert.equal(importedNames(f.calls()).length, importsBefore, 'retry must not import an already recorded migration');
  } finally { f.dispose(); }
});

test('failed import rolls schema and bookkeeping back and stops before the next migration', () => {
  const f = fixture();
  try {
    const result = f.run({ MOCK_FAIL_FILE: trigger });
    assert.notEqual(result.status, 0);
    assert.deepEqual(importedNames(f.calls()), [trigger]);
    f.inspect((db) => {
      assert.deepEqual(historyNames(db), [base]);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='media'").get(), undefined);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='operations'").get(), undefined);
    });
  } finally { f.dispose(); }
});

test('an import reporting success without confirmed bookkeeping blocks its successor', () => {
  const f = fixture();
  try {
    const result = f.run({ MOCK_OMIT_RECORD: trigger });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Remote history did not confirm/);
    assert.deepEqual(importedNames(f.calls()), [trigger]);
    f.inspect((db) => assert.deepEqual(historyNames(db), [base]));
  } finally { f.dispose(); }
});

for (const mode of ['failure', 'malformed', 'refused']) {
  test(`unconfirmed initial history (${mode}) prevents any file import`, () => {
    const f = fixture();
    try {
      assert.notEqual(f.run({ MOCK_HISTORY: mode }).status, 0);
      assert.deepEqual(importedNames(f.calls()), []);
    } finally { f.dispose(); }
  });
}

test('a lost history response after import stops before the next migration', () => {
  const f = fixture();
  try {
    assert.notEqual(f.run({ MOCK_HISTORY_AFTER_IMPORT: 'malformed' }).status, 0);
    assert.deepEqual(importedNames(f.calls()), [trigger]);
  } finally { f.dispose(); }
});

test('empty history and attempts to override the fixed live target are refused', () => {
  const f = fixture(sampleFiles, []);
  try {
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(importedNames(f.calls()), []);
    const callsBefore = f.calls().length;
    assert.notEqual(f.run({}, ['--database', 'other']).status, 0);
    assert.equal(f.calls().length, callsBefore, 'an unsupported target must fail before invoking Wrangler');
  } finally { f.dispose(); }
});

test('the real 0162 retry imports only the missing file and preserves existing customer data', () => {
  const files = readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql')).sort()
    .map((name): [string, string] => [name, readFileSync(join(root, 'migrations', name), 'utf8')]);
  const applied = files.map(([name]) => name).filter((name) => name < upgrade);
  const f = fixture(files, applied, "INSERT INTO users(id,name,email,password_hash,role) VALUES ('existing','Existing','existing@example.com','h','customer')");
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(importedNames(f.calls()), [upgrade]);
    f.inspect((db) => {
      assert.equal(db.prepare("SELECT name FROM users WHERE id='existing'").get()!.name, 'Existing');
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='purchase_orders'").get());
      assert.ok(historyNames(db).includes(upgrade));
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  } finally { f.dispose(); }
});

test('both live migration paths invoke the helper after recording their restore bookmark', () => {
  for (const file of ['auto-migrate-on-push.yml', 'deploy-staging-code.yml']) {
    const workflow = readFileSync(join(root, '.github/workflows', file), 'utf8');
    assert.ok(workflow.indexOf('run: node scripts/apply-remote-migrations.mjs') > workflow.indexOf('id: bookmark'));
    assert.ok(!workflow.includes('npx wrangler d1 migrations apply'), 'neither live path may return compound triggers to /query');
  }
});
