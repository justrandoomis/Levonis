/**
 * scripts/bambu-import/cf.mjs — THE ONE STEP OF WORKFLOW 60 THAT HOLDS
 * CLOUDFLARE CREDENTIALS (Bambu import spec §A.1, §A.3, §A.8, §D.1, §K.3).
 *
 * It is driven here end to end, as the workflow runs it, with `npx` replaced on
 * PATH by a stand-in for wrangler that answers from a local SQLite file built
 * by every migration (the pattern of tests/remoteMigrationApply.test.ts). The
 * stand-in refuses anything but `d1 list` and `d1 execute levonis-db-staging
 * --remote --json --command` against a config that pins the resolved id; it
 * cannot reach Cloudflare. It proves:
 *
 *   snapshot  every statement of snapshot.sql, in order, one call each; one
 *             file out, snapshot.sealed; the log holds row counts and migration
 *             names and nothing else (the database id only in its mask
 *             command); no planted private value in any log, summary or
 *             unsealed file; the sealed JSON opens with the one-time key and
 *             holds every status and section, and no money or stock;
 *   refusals  a bad key, missing credentials, an existing output, a deadline
 *             too close, a database not found: refused before any statement;
 *             a failing statement leaves a scrubbed reason and no file;
 *   revoke    before migration 0195, a notice and exit 0 with no write; with
 *             the 0195 table, exactly that run's token_sha256 cleared; an
 *             unknown run is an error; a malformed id never reaches wrangler.
 *
 * Run: node --import tsx --test tests/bambuImportCf.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';
// @ts-expect-error - plain ESM helper run by workflow 60, no types
import { parseSnapshotSql, scrub, SNAPSHOT_SQL } from '../scripts/bambu-import/cf.mjs';
// @ts-expect-error - plain ESM helper run by workflow 60 and in the sandbox, no types
import { generateSealKeys, unsealBuffer } from '../scripts/bambu-import/seal.mjs';
// @ts-expect-error - plain ESM helper (the dry run's fixture bundle), no types
import { fixtureBundle } from '../scripts/e2e-bambu-import.mjs';

const CF = join(ROOT, 'scripts/bambu-import/cf.mjs');
const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-token-planted-0123456789';
const PLANTED = ['PLANTED-HIDDEN-NAME', 'PLANTED-DRAFT-SKU', 'PLANTED-INACTIVE-CATALOG', 'PLANTED-SOURCE-URL', 'PLANTED-COLOUR'];
const MONEY = ['7770011', '7770022', '6660011', '6660022', '4242421', '4242422'];
const RUN_A = 'cir_aaaaaaaaaaaaaaaaaaaaaaaa';
const RUN_B = 'cir_bbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** catalog_import_runs exactly as import spec §B.3 and migration 0195 declare it. Used only until 0195 is in migrations/. */
const RUNS_DDL = `CREATE TABLE IF NOT EXISTS catalog_import_runs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'cir_[0-9a-f]*' AND length(id) = 28),
  source TEXT NOT NULL CHECK (source IN ('bambu_us')),
  state TEXT NOT NULL CHECK (state IN ('open','running','blocked','closed','partial')),
  token_sha256 TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT NOT NULL DEFAULT '',
  github_run_id TEXT NOT NULL DEFAULT '',
  manifest_total INTEGER NOT NULL DEFAULT 0,
  reviewed_bundle_sha256 TEXT NOT NULL DEFAULT '',
  sitemap_fingerprint TEXT NOT NULL DEFAULT '',
  code_commit TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cir_active ON catalog_import_runs(source) WHERE state IN ('open','running','blocked');`;

const SEED = `
  INSERT INTO brands (id, slug, name_ar, name_en) VALUES ('br_bambu', 'bambu-lab', 'بامبو لاب', 'Bambu Lab');
  INSERT INTO catalogs (id, slug, name_ar, name_en, active) VALUES ('cat_planted_off', 'planted-off', 'قسم', 'PLANTED-INACTIVE-CATALOG', 0);
  INSERT INTO products (id, slug, name, status, price_iqd, product_cost_iqd, stock, sku, brand_id) VALUES
    ('p_active', 'bambu-a1', 'Bambu A1', 'active', 7770011, 6660011, 4242421, 'A1-SKU', 'br_bambu'),
    ('p_draft', 'draft-one', 'Draft one', 'draft', 7770022, 6660022, NULL, 'PLANTED-DRAFT-SKU', NULL),
    ('p_hidden', 'hidden-one', 'PLANTED-HIDDEN-NAME', 'hidden', 0, NULL, NULL, NULL, 'br_bambu');
  INSERT INTO product_catalogs (product_id, catalog_id, position) VALUES ('p_active', 'cat_planted_off', 1);
  INSERT INTO product_colors (id, product_id, name_en, hex, stock) VALUES ('c1', 'p_active', 'PLANTED-COLOUR', '#000000', 4242422);
  INSERT INTO product_images (id, product_id, url, source_url) VALUES
    ('i1', 'p_hidden', '/files/products/a.webp', 'https://store.bblcdn.com/PLANTED-SOURCE-URL.png');
`;

// The stand-in for `npx`. It records each call's arguments and the config it
// was handed (never an answer), and answers like wrangler 4 does with --json.
const SHIM = `#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const at = args.indexOf('--config');
const config = at >= 0 ? JSON.parse(readFileSync(args[at + 1], 'utf8')) : null;
appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ args, config, env: {
  token: process.env.CLOUDFLARE_API_TOKEN ?? null, account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
  writeLogs: process.env.WRANGLER_WRITE_LOGS ?? null, metrics: process.env.WRANGLER_SEND_METRICS ?? null,
  cfEnv: process.env.CLOUDFLARE_ENV ?? null } }) + '\\n');
if (args[0] !== '--no-install' || args[1] !== 'wrangler' || args[2] !== 'd1' || !config) process.exit(90);
if (args[3] === 'list') {
  if (process.env.MOCK_LIST === 'missing') { console.log('[]'); process.exit(0); }
  console.log(JSON.stringify([{ uuid: '11111111-2222-4333-8444-555555555555', name: 'levonis-db' },
    { uuid: process.env.MOCK_UUID, name: 'levonis-db-staging', num_tables: 300 }], null, 2));
  process.exit(0);
}
if (args[3] === 'time-travel') {
  if (args[4] !== 'info' || args[5] !== 'levonis-db-staging') process.exit(95);
  if (process.env.MOCK_NO_BOOKMARK) { console.log('Database information unavailable'); process.exit(0); }
  console.log("Time Traveling... the current bookmark is 00000001-00000002-00000003-0123456789abcdef0123456789abcdef");
  process.exit(0);
}
if (args[3] !== 'execute' || args[4] !== 'levonis-db-staging') process.exit(91);
for (const refused of ['--file', '--local', '--env', '-e', '--preview', '--persist-to']) if (args.includes(refused)) process.exit(92);
if (!args.includes('--remote') || !args.includes('--json')) process.exit(93);
const bound = config.d1_databases ?? [];
if (bound.length !== 1 || bound[0].database_name !== 'levonis-db-staging' || bound[0].database_id !== process.env.MOCK_UUID) process.exit(94);
const sql = args[args.indexOf('--command') + 1];
if (process.env.MOCK_FAIL && sql.includes(process.env.MOCK_FAIL)) {
  console.log(JSON.stringify({ error: { text: 'A request to the Cloudflare API (/accounts/${ACCOUNT}/d1/database/' + process.env.MOCK_UUID + '/query) failed.',
    notes: [{ text: 'no such table: planted: SQLITE_ERROR [code: 7500] see https://developers.cloudflare.com/d1' }], kind: 'error' } }, null, 2));
  console.error('✘ [ERROR] A request to the Cloudflare API failed. Authorization: Bearer abc.def');
  process.exit(1);
}
const db = new DatabaseSync(process.env.MOCK_DB);
const statement = db.prepare(sql);
if (/^\\s*SELECT\\b/i.test(sql)) {
  console.log(JSON.stringify([{ results: statement.all(), success: true, meta: { duration: 1, changes: 0 } }], null, 2));
} else {
  const done = statement.run();
  console.log(JSON.stringify([{ results: [], success: true, meta: { duration: 1, changes: Number(done.changes) } }], null, 2));
}
db.close();
`;

type Call = { args: string[]; config: { d1_databases?: Array<{ database_id: string; database_name: string; binding: string }> } | null; env: Record<string, string | null> };

let template: string | null = null;
/** Every migration plus D1's bookkeeping, written once to a file each fixture copies. */
function templateDb(): string {
  if (template) return template;
  const dir = mkdtempSync(join(tmpdir(), 'levonis-cf-template-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const db = freshDb();
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const insert = db.prepare('INSERT INTO d1_migrations (name) VALUES (?)');
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) insert.run(file);
  const file = join(dir, 'template.sqlite');
  db.exec(`VACUUM INTO '${file}'`);
  db.close();
  return (template = file);
}

function fixture(seed = SEED) {
  const dir = mkdtempSync(join(tmpdir(), 'levonis-cf-test-'));
  for (const sub of ['bin', 'tmp']) mkdirSync(join(dir, sub));
  writeFileSync(join(dir, 'bin', 'npx'), SHIM, { mode: 0o755 });
  const db = join(dir, 'remote.sqlite');
  copyFileSync(templateDb(), db);
  if (seed) {
    const raw = new DatabaseSync(db);
    raw.exec(seed);
    raw.close();
  }
  const keys = generateSealKeys();
  const callsFile = join(dir, 'calls.jsonl');
  const summary = join(dir, 'summary.md');
  return {
    dir,
    db,
    keys,
    out: join(dir, 'out'),
    summary,
    run: (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [CF, ...args], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
          HOME: dir,
          NODE_OPTIONS: process.env.NODE_OPTIONS ?? '',
          TMPDIR: join(dir, 'tmp'),
          MOCK_DB: db,
          MOCK_CALLS: callsFile,
          MOCK_UUID: UUID,
          GITHUB_STEP_SUMMARY: summary,
          CLOUDFLARE_API_TOKEN: TOKEN,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          ...env,
        },
      }),
    callsFile,
    calls: (): Call[] => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    query: <T>(sql: string): T[] => {
      const raw = new DatabaseSync(db);
      try {
        return (raw.prepare(sql).all() as object[]).map((r) => ({ ...r })) as T[];
      } finally {
        raw.close();
      }
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Every file under `dir` but the skipped paths (the stand-in's database, its call record and itself). */
function filesUnder(dir: string, skip: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip.includes(path)) continue;
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, skip));
    else out.push(path);
  }
  return out;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const EXECUTE = ['--no-install', 'wrangler', 'd1', 'execute', 'levonis-db-staging', '--remote', '--json', '--yes', '--command'];

test('snapshot: one sealed file; the log holds row counts and migration names only; the key opens every status and no money', () => {
  const f = fixture();
  try {
    const result = f.run(['snapshot', '--seal', f.keys.publicKey, '--out', f.out], { CLOUDFLARE_ENV: 'staging', GITHUB_RUN_ID: '42', GITHUB_SHA: 'c0ffee' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(readdirSync(f.out), ['snapshot.sealed'], 'the only output is the sealed file');

    // The log, line by line: nothing that is not a count, a migration name, the mask command or the sealed file's digest.
    const statements: Array<{ key: string; sql: string }> = parseSnapshotSql(readFileSync(SNAPSHOT_SQL, 'utf8'));
    const lines = result.stdout.trim().split('\n');
    const allowed = [
      new RegExp(`^::add-mask::${UUID}$`),
      /^cf: levonis-db-staging resolved; its id is masked in this log$/,
      /^snapshot: [a-z_0-9]+: \d+ rows?$/,
      /^snapshot: migrations applied: \d+; first \d{4}_[\w-]+\.sql; last \d{4}_[\w-]+\.sql$/,
      /^snapshot: sealed snapshot\.sealed: \d+ bytes, sha256 [0-9a-f]{64}; the clear JSON never touched the disk$/,
    ];
    for (const line of lines) assert.ok(allowed.some((pattern) => pattern.test(line)), `an unexpected log line: ${line}`);
    assert.equal(lines[0], `::add-mask::${UUID}`, 'the id is masked before anything else is printed');
    assert.equal(result.stdout.split(UUID).length - 1, 1, 'the id appears only in its mask command');
    const counted = lines.filter((l) => / rows?$/.test(l)).map((l) => l.split(': ')[1]);
    assert.deepEqual(counted, statements.map((s) => s.key));
    const migrations = readdirSync(join(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(lines.includes(`snapshot: migrations applied: ${migrations.length}; first ${migrations[0]}; last ${migrations.at(-1)}`));
    assert.ok(lines.includes('snapshot: products: 3 rows'), 'every status is counted');

    // Calls: the id resolved first, then one --command per statement, in order, against the pinned id.
    const calls = f.calls();
    assert.deepEqual(calls[0].args.slice(0, 5), ['--no-install', 'wrangler', 'd1', 'list', '--json']);
    assert.deepEqual(calls.slice(1).map((c) => c.args.slice(0, EXECUTE.length)), statements.map(() => EXECUTE));
    assert.deepEqual(calls.slice(1).map((c) => c.args[EXECUTE.length]), statements.map((s) => s.sql));
    for (const call of calls) {
      assert.equal(call.args.at(-2), '--config');
      assert.ok(call.args.at(-1)!.startsWith(join(f.dir, 'tmp')), 'the throwaway config lives in the temp directory');
      assert.deepEqual(call.env, { token: TOKEN, account: ACCOUNT, writeLogs: 'false', metrics: 'false', cfEnv: null },
        'wrangler keeps no debug log of the answer, sends no metrics, and no inherited CLOUDFLARE_ENV chooses the target');
    }
    for (const call of calls.slice(1)) assert.deepEqual(call.config?.d1_databases, [{ binding: 'DB', database_name: 'levonis-db-staging', database_id: UUID }]);
    assert.deepEqual(readdirSync(join(f.dir, 'tmp')), [], 'the throwaway config is removed');

    // Nothing private anywhere outside the sealed file and the stand-in's own database.
    const sealedPath = join(f.out, 'snapshot.sealed');
    const leftovers = filesUnder(f.dir, [f.db, f.callsFile, join(f.dir, 'bin')]);
    assert.ok(leftovers.includes(sealedPath) && leftovers.includes(f.summary));
    for (const file of leftovers) {
      const body = readFileSync(file);
      for (const secret of [...PLANTED, 'Bambu A1', TOKEN]) assert.ok(!body.includes(Buffer.from(secret)), `${secret} is readable in ${file}`);
    }
    for (const secret of [...PLANTED, TOKEN, ACCOUNT]) assert.ok(!result.stdout.includes(secret), secret);
    const summary = readFileSync(f.summary, 'utf8');
    assert.ok(!summary.includes(UUID));
    assert.match(summary, /\| products \| 3 \|/);
    assert.ok(summary.includes(sha256(readFileSync(sealedPath))), 'the summary names the sealed file by its digest');
    assert.ok(result.stdout.includes(`sha256 ${sha256(readFileSync(sealedPath))}`));

    // The one-time key opens it: every status and section is inside, no money or stock is.
    const clear = unsealBuffer(f.keys.privateKeyPem, readFileSync(sealedPath)).toString('utf8');
    const snapshot = JSON.parse(clear);
    assert.equal(snapshot.format, 'levonis-bambu-snapshot/1');
    assert.equal(snapshot.database, 'levonis-db-staging');
    assert.deepEqual(snapshot.github, { run_id: '42', run_attempt: '', sha: 'c0ffee' });
    assert.equal(snapshot.snapshot_sql_sha256, sha256(readFileSync(SNAPSHOT_SQL)));
    assert.deepEqual(snapshot.statements, Object.fromEntries(statements.map((s) => [s.key, s.sql])));
    assert.deepEqual(Object.keys(snapshot.tables), statements.map((s) => s.key));
    for (const { key } of statements) assert.equal(snapshot.counts[key], snapshot.tables[key].length, key);
    assert.deepEqual(snapshot.tables.products.map((p: { status: string }) => p.status).sort(), ['active', 'draft', 'hidden']);
    assert.equal(snapshot.counts.catalogs, f.query<{ n: number }>('SELECT COUNT(*) AS n FROM catalogs')[0].n);
    assert.deepEqual(snapshot.tables.d1_migrations.map((m: { name: string }) => m.name), migrations);
    for (const secret of PLANTED) assert.ok(clear.includes(secret), `${secret} belongs in the sealed snapshot`);
    for (const value of MONEY) assert.ok(!clear.includes(value), `the money or stock value ${value} reached the snapshot`);
    assert.doesNotMatch(clear, /"[a-z_]*(?:price|cost|stock|reserved|package|weight)[a-z_]*":/);
  } finally {
    f.dispose();
  }
});

test('snapshot refuses before any statement: a bad key, no credentials, an existing output, a close deadline, no such database', () => {
  const f = fixture();
  try {
    const before = f.calls().length;
    const args = ['snapshot', '--seal', f.keys.publicKey, '--out', f.out];

    const badKey = f.run(['snapshot', '--seal', `${f.keys.publicKey.slice(0, 42)}=`, '--out', f.out]);
    assert.equal(badKey.status, 2);
    assert.match(badKey.stderr, /43 base64url characters/);

    const noToken = f.run(args, { CLOUDFLARE_API_TOKEN: '' });
    assert.equal(noToken.status, 1);
    assert.match(noToken.stderr, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not in this step's environment/);

    const close = f.run(args, { DEADLINE_EPOCH: String(Math.floor(Date.now() / 1000) + 30) });
    assert.equal(close.status, 1);
    assert.match(close.stderr, /deadline is less than two minutes away/);
    assert.equal(f.run(args, { DEADLINE_EPOCH: 'soon' }).status, 1);

    assert.equal(f.calls().length, before, 'no Cloudflare call was made');

    mkdirSync(f.out, { recursive: true });
    writeFileSync(join(f.out, 'snapshot.sealed'), 'an earlier run');
    const exists = f.run(args);
    assert.equal(exists.status, 1);
    assert.match(exists.stderr, /snapshot\.sealed already exists/);
    assert.equal(readFileSync(join(f.out, 'snapshot.sealed'), 'utf8'), 'an earlier run', 'never overwritten');
    assert.equal(f.calls().length, before, 'still no Cloudflare call');
    rmSync(f.out, { recursive: true });

    const missing = f.run(args, { MOCK_LIST: 'missing' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /expected one database named levonis-db-staging, found 0/);
    assert.deepEqual(f.calls().map((c) => c.args[3]), ['list'], 'no statement without the database');
    assert.ok(!existsSync(join(f.out, 'snapshot.sealed')));

    for (const usage of [['snapshot', '--seal', f.keys.publicKey], ['snapshot', '--out', f.out, '--seal', f.keys.publicKey, '--extra', 'x'], ['preflight'], ['mint'], ['drop'], []]) {
      const refused = f.run(usage);
      assert.equal(refused.status, 2, usage.join(' '));
      assert.match(refused.stderr, /^::error::cf\.mjs: /m);
    }
    assert.match(f.run(['preflight']).stderr, /preflight takes --mode <…> --run <…>/);
  } finally {
    f.dispose();
  }
});

test('a failing statement: a scrubbed one-line reason, exit 1, nothing sealed, no row printed', () => {
  const f = fixture();
  try {
    const result = f.run(['snapshot', '--seal', f.keys.publicKey, '--out', f.out], { MOCK_FAIL: 'FROM products' });
    assert.equal(result.status, 1);
    const errors = result.stderr.trim().split('\n');
    assert.equal(errors.length, 1, result.stderr);
    assert.match(errors[0], /^::error::cf\.mjs snapshot: wrangler d1 execute failed \(exit 1\): A request to the Cloudflare API \(\/accounts\/\[hex\]\/d1\/database\/\[masked\]\/query\) failed\. \/ no such table: planted: SQLITE_ERROR \[code: 7500\] see https:\/\/\[redacted\]$/);
    for (const secret of [UUID, ACCOUNT, 'developers.cloudflare.com', ...PLANTED]) assert.ok(!result.stderr.includes(secret), secret);
    assert.ok(!result.stdout.includes('PLANTED'), 'no row was printed before the failure');
    assert.ok(result.stdout.includes('snapshot: brands: 1 row\n'));
    assert.deepEqual(existsSync(f.out) ? readdirSync(f.out) : [], [], 'nothing sealed, nothing partial');
    assert.deepEqual(readdirSync(join(f.dir, 'tmp')), []);
  } finally {
    f.dispose();
  }
});

test('revoke before migration 0195: a notice and exit 0, and nothing is written', () => {
  const f = fixture('DROP TABLE IF EXISTS catalog_import_runs;');
  try {
    const result = f.run(['revoke', '--run', RUN_A]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::notice::catalog_import_runs is not in the live database yet \(migration 0195 has not landed\)/m);
    const sqls = f.calls().slice(1).map((c) => c.args[EXECUTE.length]);
    assert.deepEqual(sqls, ["SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'catalog_import_runs'"]);
    assert.match(readFileSync(f.summary, 'utf8'), /nothing to revoke/);
  } finally {
    f.dispose();
  }
});

test('revoke with the 0195 table: exactly that run\'s token_sha256 is cleared', () => {
  const f = fixture();
  try {
    const hasTable = f.query<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'catalog_import_runs'")[0].n === 1;
    const raw = new DatabaseSync(f.db);
    if (!hasTable) raw.exec(RUNS_DDL);
    raw.exec(`INSERT INTO catalog_import_runs (id, source, state, token_sha256, token_expires_at) VALUES
      ('${RUN_A}', 'bambu_us', 'open', '${HASH_A}', '2099-01-01T00:00:00.000Z'),
      ('${RUN_B}', 'bambu_us', 'closed', '${HASH_B}', '2099-01-01T00:00:00.000Z')`);
    raw.close();

    const result = f.run(['revoke', '--run', RUN_A]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^revoke: ${RUN_A}: token cleared; tokens still live on any run: 1$`, 'm'));
    const rows = f.query<{ id: string; state: string; token_sha256: string; token_expires_at: string }>(
      'SELECT id, state, token_sha256, token_expires_at FROM catalog_import_runs ORDER BY id');
    assert.deepEqual(rows, [
      { id: RUN_A, state: 'open', token_sha256: '', token_expires_at: '2099-01-01T00:00:00.000Z' },
      { id: RUN_B, state: 'closed', token_sha256: HASH_B, token_expires_at: '2099-01-01T00:00:00.000Z' },
    ]);
    const sqls = f.calls().slice(1).map((c) => c.args[EXECUTE.length]);
    assert.equal(sqls[1], `UPDATE catalog_import_runs SET token_sha256 = '' WHERE id = '${RUN_A}'`, 'the one write, on the §B.3 columns');
    assert.equal(sqls.length, 3);
    for (const secret of [HASH_A, HASH_B]) assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));

    // Revoking again is harmless; an unknown run is an error, not a silent success.
    assert.equal(f.run(['revoke', '--run', RUN_A]).status, 0);
    const unknown = f.run(['revoke', '--run', 'cir_cccccccccccccccccccccccc']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /there is no run cir_cccccccccccccccccccccccc in catalog_import_runs/);
  } finally {
    f.dispose();
  }
});

test('revoke: a malformed or injected run id never reaches wrangler', () => {
  const f = fixture('');
  try {
    for (const id of ['', 'cir_AAAAAAAAAAAAAAAAAAAAAAAA', 'cir_aaaa', `${RUN_A}a`, `${RUN_A.slice(0, -1)}'`, "cir_000000000000000000000000' OR '1'='1", 'run_aaaaaaaaaaaaaaaaaaaaaaaa']) {
      const result = f.run(['revoke', '--run', id]);
      assert.equal(result.status, 2, id);
      assert.match(result.stderr, /--run must be cir_ followed by 24 lowercase hex characters/);
    }
    assert.equal(f.run(['revoke']).status, 2);
    assert.equal(f.run(['revoke', '--run', RUN_A, '--all', 'yes']).status, 2);
    assert.deepEqual(f.calls(), []);
  } finally {
    f.dispose();
  }
});

test('scrub: ids, long hex, bearer values and URLs are redacted, on one short line', () => {
  const text = `failed for ${UUID} on account ${ACCOUNT}\nAuthorization: Bearer abc.def-123 at https://api.cloudflare.com/client/v4/x?y=1 and SECRET-VALUE`;
  const out = scrub(text, ['SECRET-VALUE']);
  assert.equal(out, 'failed for [id] on account [hex] Authorization: Bearer [redacted] at https://[redacted] and [masked]');
  assert.equal(scrub('x'.repeat(1000)).length, 300);
  assert.equal(scrub(`${'ab'.repeat(15)}c`), `${'ab'.repeat(15)}c`, '31 hex characters are kept');
  assert.equal(scrub('ab'.repeat(16)), '[hex]', '32 are redacted');
});

// ------------------------------------------------------------------ build step 8: preflight, open, mint, revoke --run-file, report


const BOOKMARK = '00000001-00000002-00000003-0123456789abcdef0123456789abcdef';
const deadlineIn = (minutes: number) => String(Math.floor(Date.now() / 1000) + minutes * 60);

/** A reviewed bundle (the dry run's fixture files) in a directory of its own. */
function dataDir(root: string): string {
  const dir = join(root, 'data');
  for (const [file, body] of Object.entries((fixtureBundle() as { text: Record<string, string> }).text)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), body);
  }
  return dir;
}

function withRun(f: ReturnType<typeof fixture>, state: string, hash = HASH_A) {
  const raw = new DatabaseSync(f.db);
  raw.exec(`INSERT INTO catalog_import_runs (id, source, state, token_sha256, token_expires_at) VALUES ('${RUN_A}', 'bambu_us', '${state}', '${hash}', '2099-01-01T00:00:00.000Z')`);
  raw.close();
}

test('preflight: the live migrations equal the repository, the run is active, and the Time Travel bookmark is printed', () => {
  const f = fixture();
  try {
    withRun(f, 'running');
    const ok = f.run(['preflight', '--mode', 'run', '--run', RUN_A]);
    assert.equal(ok.status, 0, ok.stderr);
    const migrations = readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort();
    assert.match(ok.stdout, new RegExp(`preflight: migrations applied: ${migrations.length}; last ${migrations.at(-1)}; the repository has ${migrations.length}`));
    assert.match(ok.stdout, new RegExp(`preflight: run ${RUN_A} is active`));
    assert.match(ok.stdout, new RegExp(`Time Travel bookmark \\(restore point\\): ${BOOKMARK}`));
    assert.match(readFileSync(f.summary, 'utf8'), new RegExp(`wrangler d1 time-travel restore levonis-db-staging --bookmark ${BOOKMARK}`));
    assert.ok(f.calls().some((c) => c.args.slice(2, 6).join(' ') === 'd1 time-travel info levonis-db-staging'));
    assert.ok(f.calls().every((c) => !/^(INSERT|UPDATE|DELETE)/i.test(c.args[EXECUTE.length] ?? '')), 'preflight writes nothing');

    // open and preflight refuse while a run is active; run refuses an unknown or closed run.
    assert.match(f.run(['preflight', '--mode', 'open', '--run', '']).stderr, /an import run is already active/);
    assert.match(f.run(['preflight', '--mode', 'run', '--run', RUN_B]).stderr, /is not an active import run/);
    // No bookmark, no write.
    assert.match(f.run(['preflight', '--mode', 'run', '--run', RUN_A], { MOCK_NO_BOOKMARK: '1' }).stderr, /no Time Travel bookmark was returned/);
    // Arguments are validated before anything runs.
    for (const bad of [['--mode', 'snapshot', '--run', ''], ['--mode', 'run', '--run', ''], ['--mode', 'open', '--run', "x' OR 1"]]) {
      assert.equal(f.run(['preflight', ...bad]).status, 2, bad.join(' '));
    }
  } finally {
    f.dispose();
  }
});

test('preflight: a migration count that differs and a CSV import lease each refuse', () => {
  const f = fixture();
  try {
    const raw = new DatabaseSync(f.db);
    raw.exec("INSERT INTO d1_migrations (name) VALUES ('9999_not_in_the_repository.sql')");
    raw.close();
    assert.match(f.run(['preflight', '--mode', 'preflight', '--run', '']).stderr, /the live migrations are not the repository's/);
  } finally {
    f.dispose();
  }
  const g = fixture();
  try {
    const raw = new DatabaseSync(g.db);
    const cols = (raw.prepare('PRAGMA table_info(product_imports)').all() as Array<{ name: string; notnull: number; dflt_value: unknown }>);
    const needed = cols.filter((c) => c.notnull && c.dflt_value === null).map((c) => c.name);
    const values = needed.map((n) => (n === 'id' ? "'imp1'" : "'x'"));
    raw.exec(`INSERT INTO product_imports (${needed.join(', ')}) VALUES (${values.join(', ')})`);
    raw.exec("UPDATE product_imports SET apply_lease_until = '2099-01-01T00:00:00.000Z'");
    raw.close();
    const r = g.run(['preflight', '--mode', 'preflight', '--run', '']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a CSV import is applying/);
  } finally {
    g.dispose();
  }
});

test('open: a new run row with only the token hash; the token in a 0600 file; never in the log', () => {
  const f = fixture();
  try {
    const data = dataDir(f.dir);
    const tokenFile = join(f.dir, 'tmp', 'import-token');
    const runFile = join(f.dir, 'tmp', 'import-run');
    const deadline = deadlineIn(330);
    const r = f.run(['open', '--token-file', tokenFile, '--run-file', runFile], { DEADLINE_EPOCH: deadline, BAMBU_IMPORT_DATA_DIR: data, GITHUB_RUN_ID: '777', GITHUB_SHA: 'c'.repeat(40) });
    assert.equal(r.status, 0, r.stderr);
    const token = readFileSync(tokenFile, 'utf8').trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    const runId = readFileSync(runFile, 'utf8').trim();
    assert.match(runId, /^cir_[0-9a-f]{24}$/);
    const rows = f.query<Record<string, unknown>>(`SELECT id, state, token_sha256, token_expires_at, github_run_id, manifest_total, reviewed_bundle_sha256, code_commit FROM catalog_import_runs`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, runId);
    assert.equal(rows[0].state, 'open');
    assert.equal(rows[0].token_sha256, sha256(token), 'only the SHA-256 of the token is stored');
    assert.equal(rows[0].token_expires_at, new Date((Number(deadline) + 20 * 60) * 1000).toISOString(), 'it expires with the job');
    assert.equal(rows[0].github_run_id, '777');
    assert.equal(rows[0].manifest_total, 2);
    assert.match(String(rows[0].reviewed_bundle_sha256), /^[0-9a-f]{64}$/);
    for (const text of [r.stdout, r.stderr, readFileSync(f.summary, 'utf8')]) {
      assert.ok(!text.includes(token), 'the token is never printed');
      assert.ok(!text.includes(sha256(token)), 'nor its hash');
    }
    // Without a deadline no token is minted; an active run refuses a second open (ux_cir_active).
    assert.match(f.run(['open', '--token-file', join(f.dir, 'tmp', 't2'), '--run-file', join(f.dir, 'tmp', 'r2')], { BAMBU_IMPORT_DATA_DIR: data }).stderr, /DEADLINE_EPOCH is required/);
    const second = f.run(['open', '--token-file', join(f.dir, 'tmp', 't3'), '--run-file', join(f.dir, 'tmp', 'r3')], { DEADLINE_EPOCH: deadline, BAMBU_IMPORT_DATA_DIR: data });
    assert.equal(second.status, 1);
    assert.ok(!existsSync(join(f.dir, 'tmp', 't3')), 'a refused open leaves no token file behind');
  } finally {
    f.dispose();
  }
});

test('mint: a fresh token for an active run only; a closed run gets none, and its file is removed', () => {
  const f = fixture();
  try {
    withRun(f, 'running');
    const tokenFile = join(f.dir, 'tmp', 'import-token');
    const runFile = join(f.dir, 'tmp', 'import-run');
    const r = f.run(['mint', '--run', RUN_A, '--token-file', tokenFile, '--run-file', runFile], { DEADLINE_EPOCH: deadlineIn(330), GITHUB_RUN_ID: '42' });
    assert.equal(r.status, 0, r.stderr);
    const token = readFileSync(tokenFile, 'utf8').trim();
    assert.equal(f.query<{ token_sha256: string }>(`SELECT token_sha256 FROM catalog_import_runs WHERE id = '${RUN_A}'`)[0].token_sha256, sha256(token));
    assert.equal(readFileSync(runFile, 'utf8').trim(), RUN_A);
    assert.ok(!r.stdout.includes(token) && !r.stdout.includes(sha256(token)));
    const updates = f.calls().map((c) => c.args[EXECUTE.length] ?? '').filter((sql) => /^UPDATE/.test(sql));
    assert.equal(updates.length, 1);
    assert.match(updates[0], /^UPDATE catalog_import_runs SET token_sha256 = '[0-9a-f]{64}', token_expires_at = '[0-9T:.Z-]+', github_run_id = '42' WHERE id = 'cir_a{24}' AND state IN \('open','running','blocked'\)$/);
  } finally {
    f.dispose();
  }
  const g = fixture();
  try {
    withRun(g, 'closed');
    const tokenFile = join(g.dir, 'tmp', 'import-token');
    const r = g.run(['mint', '--run', RUN_A, '--token-file', tokenFile, '--run-file', join(g.dir, 'tmp', 'import-run')], { DEADLINE_EPOCH: deadlineIn(330) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not an active import run: no token was stored/);
    assert.ok(!existsSync(tokenFile));
  } finally {
    g.dispose();
  }
});

test('revoke --run-file: no file means no token was minted (exit 0, no call); a file clears that run', () => {
  const f = fixture();
  try {
    const none = f.run(['revoke', '--run-file', join(f.dir, 'tmp', 'missing')]);
    assert.equal(none.status, 0, none.stderr);
    assert.match(none.stdout, /no run id file: this job minted no token/);
    assert.deepEqual(f.calls(), []);
    withRun(f, 'running');
    const runFile = join(f.dir, 'tmp', 'import-run');
    writeFileSync(runFile, `${RUN_A}\n`);
    const r = f.run(['revoke', '--run-file', runFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(f.query<{ token_sha256: string }>(`SELECT token_sha256 FROM catalog_import_runs WHERE id = '${RUN_A}'`)[0].token_sha256, '');
    writeFileSync(runFile, "cir_x' OR '1'='1\n");
    assert.match(f.run(['revoke', '--run-file', runFile]).stderr, /does not hold a run id/);
  } finally {
    f.dispose();
  }
});

test('report: the run ledger sealed in memory; counts by state in the log, nothing else', () => {
  const f = fixture();
  try {
    withRun(f, 'running');
    const raw = new DatabaseSync(f.db);
    raw.exec(`INSERT INTO catalog_import_items (id, run_id, source, source_product_id, handle, canonical_url, queue_position, discovered_at, processing_state, slug)
      VALUES ('cii_1', '${RUN_A}', 'bambu_us', '1', 'a1', 'https://us.store.bambulab.com/products/PLANTED-SOURCE-URL', 1, '2026-10-16', 'DISCOVERED', 'PLANTED-HIDDEN-NAME')`);
    raw.close();
    const r = f.run(['report', '--run', RUN_A, '--seal', f.keys.publicKey, '--out', f.out]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(f.out), ['report.sealed']);
    for (const line of r.stdout.trim().split('\n')) {
      assert.match(line, /^(::add-mask::[0-9a-f-]{36}|cf: levonis-db-staging resolved; its id is masked in this log|report: DISCOVERED: 1|report: sealed report\.sealed: \d+ bytes, sha256 [0-9a-f]{64})$/, line);
    }
    for (const secret of PLANTED) assert.ok(!r.stdout.includes(secret) && !readFileSync(f.summary, 'utf8').includes(secret), secret);
    const doc = JSON.parse(unsealBuffer(f.keys.privateKeyPem, readFileSync(join(f.out, 'report.sealed'))).toString());
    assert.equal(doc.format, 'levonis-bambu-report/1');
    assert.equal(doc.tables.items.length, 1);
    assert.equal(doc.tables.items[0].slug, 'PLANTED-HIDDEN-NAME', 'the sealed report keeps what the agent needs');
    assert.ok(!('canonical_url' in doc.tables.items[0]), 'the store URL is not even in the report');
  } finally {
    f.dispose();
  }
});
