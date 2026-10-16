#!/usr/bin/env node
/**
 * THE ONLY CODE IN WORKFLOW 60 THAT RUNS WITH CLOUDFLARE CREDENTIALS
 * (Bambu import spec §A.1, §A.8, §D.1, §K.3; docs/DECISIONS.md row 239, which
 * allows reading and writing the production D1 and R2 for this import only).
 *
 * Workflow 60 hands CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to the steps
 * that run this file and to no other step. It drives wrangler, and nothing
 * else, with SQL built only from validated values:
 *
 *   node scripts/bambu-import/cf.mjs snapshot --seal <one-time public key> --out <dir>
 *       Runs every SELECT of scripts/bambu-import/snapshot.sql against the live
 *       database (§D.1), seals the JSON answer in memory to the dispatch's key
 *       and writes <dir>/snapshot.sealed. The clear JSON never touches the
 *       disk: wrangler's answer is read from a pipe, wrangler's own debug log
 *       is switched off, and the buffer is overwritten once sealed. The log
 *       carries row counts and migration names, never a row.
 *   node scripts/bambu-import/cf.mjs revoke --run <cir_ + 24 hex>
 *   node scripts/bambu-import/cf.mjs revoke --run-file <file the open/mint step wrote>
 *       `token_sha256 = ''` on that run, so every ops path answers 404. With
 *       --run (THE KILL SWITCH, §A.3, workflow 60 mode=revoke) it also marks
 *       the run stopped by its owner (`notes = 'kill_switch'`): no chained
 *       job's mint re-arms it, only the owner's own dispatch (see mint). Until
 *       migration 0195 is live there is no catalog_import_runs table and no
 *       token: a notice, and exit 0. With --run-file (the always() step after
 *       a mode that minted a token): no file means no token was minted in this
 *       job — a notice, and exit 0; the mark is never touched. The revoke
 *       never refuses for the job deadline: it is what must still run after
 *       the importer used its time (see openContext).
 *   node scripts/bambu-import/cf.mjs preflight --mode <mode> --run <run id or ''>
 *       Every job that writes starts here (§A.1, §K.2 step 11): the live
 *       migration count and last name equal the repository's, the 0195 table
 *       exists, and the Time Travel bookmark (the restore point) is printed. For
 *       preflight and open: no active run; for preflight also no CSV import
 *       lease. For run, close and withdraw: the run exists and is active.
 *   node scripts/bambu-import/cf.mjs open --token-file <file> --run-file <file>
 *       Creates the run row (`cir_` + 24 hex, state open, the reviewed bundle's
 *       digest, the manifest size, the commit) with a fresh 256-bit token:
 *       the token goes to a 0600 file only the importer step reads, and only
 *       its SHA-256 is stored. The run id goes to its own file.
 *   node scripts/bambu-import/cf.mjs mint --run <cir_ + 24 hex> --chain-count <0-12> --token-file <file> --run-file <file>
 *       A fresh per-job token for an active run (run, close, withdraw): the
 *       same 0600 file, the hash and its expiry on the run row. A run the kill
 *       switch stopped gets no token for a chained job (chain_count above 0:
 *       the chain job dispatched it, maybe before the owner pressed the
 *       switch, maybe after a door that did not settle); the owner's own
 *       dispatch (chain_count 0) lifts the switch, and says so.
 *   node scripts/bambu-import/cf.mjs report --run <cir_ + 24 hex> --seal <public key> --out <dir>
 *       The run's ledger read from D1 (§H.3: items, states, codes, counts,
 *       public URLs, the Worker's checks next to the runner's evidence), sealed
 *       in memory to report.sealed. The log carries counts by state only.
 *
 * THE TARGET IS FIXED: levonis-db-staging, the live database behind
 * levonis-iq.com (the "-staging" names are historical, docs/WORKERS.md), and
 * never an input or an environment choice. Its id is resolved with
 * `wrangler d1 list`, masked in the log at once (`::add-mask::`, as workflows
 * 7 and 59 do), and pinned in a throwaway wrangler config of one D1 binding,
 * so nothing here depends on, or rewrites, the repository's wrangler.jsonc.
 * Every statement is its own `--command` call: `--remote --file` would run an
 * import that makes the live database unavailable while it runs.
 *
 * NOTHING PRIVATE IS PRINTED. Errors carry a scrubbed one-line reason: ids,
 * hex runs of 32+ characters, `Bearer` values and anything after `://` are
 * redacted. Wrangler's output itself is never echoed.
 *
 * Exit codes: 0 done, 1 refused or failed, 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePublicKey, sealBuffer } from './seal.mjs';

/** The live D1 database (wrangler.jsonc `env.staging`, binding DB). Never derived from input. */
export const DATABASE = 'levonis-db-staging';
/** catalog_import_runs.id, the shape 0195's CHECK and workflow 60 both enforce. */
export const RUN_ID_PATTERN = /^cir_[0-9a-f]{24}$/;
export const SNAPSHOT_SQL = fileURLToPath(new URL('./snapshot.sql', import.meta.url));
export const SNAPSHOT_FILE = 'snapshot.sealed';
export const SNAPSHOT_FORMAT = 'levonis-bambu-snapshot/1';
export const REPORT_FILE = 'report.sealed';
export const REPORT_FORMAT = 'levonis-bambu-report/1';
/** The modes workflow 60 runs cf.mjs preflight for. */
export const PREFLIGHT_MODES = ['preflight', 'open', 'run', 'close', 'withdraw'];
/** The reviewed files the Worker bundles (scripts/bambu-import/discover.ts REVIEWED_FILES, §A.3). */
export const REVIEWED_FILES = [
  'manifest.json',
  'taxonomy-map.json',
  'existing-matches.json',
  'compat-targets.json',
  'identity-map.json',
  'media-overrides.json',
  'search-synonyms.json',
  'curated/index.json',
];
const BOOKMARK_PATTERN = /[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}/;
/** A job token outlives the 330-minute deadline by the 20 minutes left to the job's 350-minute timeout, never more. */
const TOKEN_TAIL_MS = 20 * 60_000;

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One wrangler call never runs longer than this, nor past the job's deadline less a minute. */
const CALL_LIMIT_MS = 3 * 60_000;
const DEADLINE_MARGIN_MS = 60_000;
const WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export class CfError extends Error {}

const USAGE = [
  'usage: node scripts/bambu-import/cf.mjs snapshot --seal <public key> --out <dir>',
  '       node scripts/bambu-import/cf.mjs revoke --run <cir_ + 24 hex> | --run-file <file>',
  '       node scripts/bambu-import/cf.mjs preflight --mode <mode> --run <cir_ + 24 hex or empty>',
  '       node scripts/bambu-import/cf.mjs open --token-file <file> --run-file <file>',
  '       node scripts/bambu-import/cf.mjs mint --run <cir_ + 24 hex> --chain-count <0-12> --token-file <file> --run-file <file>',
  '       node scripts/bambu-import/cf.mjs report --run <cir_ + 24 hex> --seal <public key> --out <dir>',
].join('\n');

/**
 * snapshot.sql → [{ key, sql }]. A statement is one plain SELECT ending in
 * `;`, preceded by a `-- @key <name>` line; other comments are dropped and
 * whitespace outside quotes is folded, so the SQL sent is one line.
 */
export function parseSnapshotSql(text) {
  const statements = [];
  let key = null;
  let sql = '';
  const finish = () => {
    const body = sql.trim();
    sql = '';
    if (!body) throw new CfError('snapshot.sql: an empty statement');
    if (!key) throw new CfError(`snapshot.sql: a statement has no "-- @key" line: ${body.slice(0, 60)}`);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new CfError(`snapshot.sql: "${key}" is not a key name`);
    if (statements.some((statement) => statement.key === key)) throw new CfError(`snapshot.sql: the key ${key} is used twice`);
    if (!/^SELECT\s/i.test(body)) throw new CfError(`snapshot.sql: ${key} is not a SELECT`);
    if (WRITE_WORDS.test(body.replace(/'(?:[^']|'')*'/g, "''"))) throw new CfError(`snapshot.sql: ${key} is not read-only`);
    statements.push({ key, sql: body });
    key = null;
  };
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "'") {
      const close = /'(?:[^']|'')*'/y;
      close.lastIndex = at;
      const literal = close.exec(text);
      if (!literal) throw new CfError('snapshot.sql: an unterminated string literal');
      sql += literal[0];
      at += literal[0].length - 1;
    } else if (char === '-' && text[at + 1] === '-') {
      const end = text.indexOf('\n', at);
      const comment = text.slice(at + 2, end < 0 ? text.length : end);
      const named = /^\s*@key\s+(\S+)\s*$/.exec(comment);
      if (named) {
        if (sql.trim()) throw new CfError(`snapshot.sql: "@key ${named[1]}" inside a statement`);
        if (key) throw new CfError(`snapshot.sql: two @key lines before one statement (${key}, ${named[1]})`);
        key = named[1];
      }
      at = end < 0 ? text.length : end - 1;
    } else if (char === '/' && text[at + 1] === '*') {
      throw new CfError('snapshot.sql: block comments are not allowed');
    } else if (char === ';') {
      finish();
    } else if (/\s/.test(char)) {
      if (sql && !sql.endsWith(' ')) sql += ' ';
    } else {
      sql += char;
    }
  }
  if (sql.trim()) throw new CfError('snapshot.sql: the last statement does not end in ;');
  if (key) throw new CfError(`snapshot.sql: "@key ${key}" names no statement`);
  if (!statements.length) throw new CfError('snapshot.sql: no statement');
  return statements;
}

/** One reason, one line, nothing an outsider could use. */
export function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[masked]');
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/[0-9a-f]{32,}/gi, '[hex]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/:\/\/\S*/g, '://[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** argv → { mode, … }, every value validated before anything else runs. */
export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = (allowed) => {
    const seen = {};
    if (rest.length !== allowed.length * 2) throw new CfError(`${mode} takes ${allowed.join(' <…> ')} <…>`);
    for (let at = 0; at < rest.length; at += 2) {
      const [flag, value] = [rest[at], rest[at + 1]];
      if (!allowed.includes(flag) || flag in seen) throw new CfError(`${mode}: unexpected argument ${JSON.stringify(flag)}`);
      seen[flag] = value;
    }
    return seen;
  };
  const runOf = (value, what = mode) => {
    if (!RUN_ID_PATTERN.test(value ?? '')) throw new CfError(`${what}: --run must be cir_ followed by 24 lowercase hex characters`);
    return value;
  };
  const fileOf = (value, flag) => {
    if (!value || value.startsWith('-') || /[\0\n]/.test(value)) throw new CfError(`${mode}: ${flag} needs a file path`);
    return resolve(value);
  };
  if (mode === 'snapshot' || mode === 'report') {
    const given = options(mode === 'snapshot' ? ['--seal', '--out'] : ['--run', '--seal', '--out']);
    parsePublicKey(given['--seal']);
    if (!given['--out'] || given['--out'].startsWith('-')) throw new CfError(`${mode}: --out needs a directory`);
    return { mode, publicKey: given['--seal'], outDir: resolve(given['--out']), ...(mode === 'report' ? { runId: runOf(given['--run']) } : {}) };
  }
  if (mode === 'revoke') {
    if (rest[0] === '--run-file') {
      const given = options(['--run-file']);
      return { mode, runFile: fileOf(given['--run-file'], '--run-file') };
    }
    const given = options(['--run']);
    if (!RUN_ID_PATTERN.test(given['--run'] ?? '')) throw new CfError('revoke: --run must be cir_ followed by 24 lowercase hex characters');
    return { mode, runId: given['--run'] };
  }
  if (mode === 'preflight') {
    const given = options(['--mode', '--run']);
    if (!PREFLIGHT_MODES.includes(given['--mode'])) throw new CfError(`preflight: --mode must be one of ${PREFLIGHT_MODES.join(', ')}`);
    const needsRun = ['run', 'close', 'withdraw'].includes(given['--mode']);
    if (needsRun) runOf(given['--run'], `preflight for ${given['--mode']}`);
    else if (given['--run'] !== '' && !RUN_ID_PATTERN.test(given['--run'] ?? '')) throw new CfError('preflight: --run is a run id or empty');
    return { mode, forMode: given['--mode'], runId: given['--run'] };
  }
  if (mode === 'open') {
    const given = options(['--token-file', '--run-file']);
    return { mode, tokenFile: fileOf(given['--token-file'], '--token-file'), runFile: fileOf(given['--run-file'], '--run-file') };
  }
  if (mode === 'mint') {
    const given = options(['--run', '--chain-count', '--token-file', '--run-file']);
    if (!/^(?:[0-9]|1[0-2])$/.test(given['--chain-count'] ?? '')) throw new CfError('mint: --chain-count must be a whole number from 0 to 12');
    return {
      mode,
      runId: runOf(given['--run']),
      chainCount: Number(given['--chain-count']),
      tokenFile: fileOf(given['--token-file'], '--token-file'),
      runFile: fileOf(given['--run-file'], '--run-file'),
    };
  }
  throw new CfError('the first argument is snapshot, revoke, preflight, open, mint or report');
}

function parseDeadline(value) {
  if (value === undefined || value === '') return null;
  if (!/^\d{9,11}$/.test(value)) throw new CfError('DEADLINE_EPOCH is not a time in seconds');
  return Number(value) * 1000;
}

/** A throwaway config holding one D1 binding: the live database, by the id just resolved. */
function writeConfig(context, uuid) {
  const config = { name: 'levonis-bambu-import-cf', compatibility_date: '2026-08-01' };
  if (uuid) config.d1_databases = [{ binding: 'DB', database_name: DATABASE, database_id: uuid }];
  writeFileSync(context.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * `honourDeadline: false` is the revoke's: it runs in workflow 60's always() step after the importer has used
 * its time, after a late cancel or after an overrun, and it must clear the token whatever the clock says. It is
 * bounded by CALL_LIMIT_MS per wrangler call (four calls) and by the job's 350-minute timeout, which the
 * 330-minute deadline leaves 20 minutes before (TOKEN_TAIL_MS), never by DEADLINE_EPOCH.
 */
function openContext(env, log, { honourDeadline = true } = {}) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new CfError("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not in this step's environment");
  }
  const deadline = honourDeadline ? parseDeadline(env.DEADLINE_EPOCH) : null;
  if (deadline !== null && deadline - Date.now() < DEADLINE_MARGIN_MS * 2) throw new CfError('the job deadline is less than two minutes away');
  const childEnv = { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' };
  // The database is named here; an inherited environment never chooses another one.
  delete childEnv.CLOUDFLARE_ENV;
  const dir = mkdtempSync(join(tmpdir(), 'levonis-cf-'));
  const context = { env: childEnv, dir, config: join(dir, 'wrangler.json'), deadline, log, secrets: [] };
  writeConfig(context, null);
  return context;
}

/** The reason wrangler gave, from its --json error object or its first error line, scrubbed. */
function wranglerReason(result, secrets) {
  for (const stream of [result.stdout, result.stderr]) {
    const at = (stream ?? '').indexOf('{');
    if (at < 0) continue;
    try {
      const error = JSON.parse(stream.slice(at))?.error;
      const notes = Array.isArray(error?.notes) ? error.notes.map((note) => note?.text).filter((text) => typeof text === 'string') : [];
      const text = [error?.text, ...notes].filter(Boolean).join(' / ');
      if (text) return scrub(text, secrets);
    } catch {
      /* not the JSON error shape */
    }
  }
  const line = `${result.stderr ?? ''}`.split('\n').find((candidate) => /error/i.test(candidate)) ?? 'no reason given';
  return scrub(line.replace(/^.*?\[ERROR\]\s*/, ''), secrets);
}

function wrangler(context, args, { raw = false } = {}) {
  const left = context.deadline === null ? CALL_LIMIT_MS : context.deadline - DEADLINE_MARGIN_MS - Date.now();
  if (left <= 0) throw new CfError('the job deadline leaves no time for another Cloudflare call');
  const result = spawnSync('npx', ['--no-install', 'wrangler', ...args, '--config', context.config], {
    cwd: ROOT,
    env: context.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: Math.min(CALL_LIMIT_MS, left),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const what = `wrangler ${args.slice(0, 2).join(' ')}`;
  if (result.error) throw new CfError(`${what} did not complete (${result.error.code ?? result.error.name})`);
  if (result.status !== 0) {
    throw new CfError(`${what} failed (exit ${result.status ?? result.signal}): ${wranglerReason(result, context.secrets)}`);
  }
  if (raw) return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CfError(`${what} did not answer with JSON`);
  }
}

/** Resolve the live database's id, mask it, and pin it in the throwaway config. */
function resolveDatabase(context) {
  const list = wrangler(context, ['d1', 'list', '--json']);
  const found = Array.isArray(list) ? list.filter((database) => database?.name === DATABASE) : [];
  if (found.length !== 1) throw new CfError(`d1 list: expected one database named ${DATABASE}, found ${found.length}`);
  const uuid = String(found[0].uuid ?? '');
  if (!UUID_PATTERN.test(uuid)) throw new CfError(`d1 list: ${DATABASE} has no well-formed id`);
  context.log(`::add-mask::${uuid}`);
  context.secrets.push(uuid);
  writeConfig(context, uuid);
  context.log(`cf: ${DATABASE} resolved; its id is masked in this log`);
}

/** One statement through `d1 execute --remote --command`; exactly one successful answer. */
function query(context, sql) {
  const answer = wrangler(context, ['d1', 'execute', DATABASE, '--remote', '--json', '--yes', '--command', sql]);
  if (!Array.isArray(answer) || answer.length !== 1 || answer[0]?.success !== true || !Array.isArray(answer[0].results)) {
    throw new CfError('d1 execute: wrangler did not confirm one successful statement');
  }
  return answer[0];
}

function summary(env, lines) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

export function snapshot(context, { publicKey, outDir }) {
  const text = readFileSync(SNAPSHOT_SQL, 'utf8');
  const statements = parseSnapshotSql(text);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const target = join(outDir, SNAPSHOT_FILE);
  if (existsSync(target) || existsSync(`${target}.partial`)) throw new CfError(`${SNAPSHOT_FILE} already exists in the output directory`);
  resolveDatabase(context);

  const tables = {};
  const counts = {};
  for (const { key, sql } of statements) {
    const rows = query(context, sql).results;
    tables[key] = rows;
    counts[key] = rows.length;
    context.log(`snapshot: ${key}: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`);
  }
  const migrations = (tables.d1_migrations ?? []).map((row) => row?.name);
  if (!migrations.length || migrations.some((name) => typeof name !== 'string' || !/^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name))) {
    throw new CfError('snapshot: the live migration history is empty or malformed');
  }
  context.log(`snapshot: migrations applied: ${migrations.length}; first ${migrations[0]}; last ${migrations.at(-1)}`);

  const env = context.env;
  const document = {
    format: SNAPSHOT_FORMAT,
    database: DATABASE,
    taken_at: new Date().toISOString(),
    github: { run_id: env.GITHUB_RUN_ID ?? '', run_attempt: env.GITHUB_RUN_ATTEMPT ?? '', sha: env.GITHUB_SHA ?? '' },
    snapshot_sql_sha256: createHash('sha256').update(text).digest('hex'),
    statements: Object.fromEntries(statements.map(({ key, sql }) => [key, sql])),
    counts,
    tables,
  };
  const clear = Buffer.from(JSON.stringify(document));
  const sealed = sealBuffer(publicKey, clear);
  clear.fill(0);
  const partial = `${target}.partial`;
  writeFileSync(partial, sealed, { flag: 'wx', mode: 0o600 });
  renameSync(partial, target);
  const digest = createHash('sha256').update(sealed).digest('hex');
  context.log(`snapshot: sealed ${SNAPSHOT_FILE}: ${sealed.length} bytes, sha256 ${digest}; the clear JSON never touched the disk`);
  summary(env, [
    '## Bambu import: sealed snapshot of the live catalogue',
    '',
    '| statement | rows |',
    '|---|---|',
    ...statements.map(({ key }) => `| ${key} | ${counts[key]} |`),
    '',
    `Migrations applied: ${migrations.length}, the last \`${migrations.at(-1)}\`.`,
    `Artifact \`bambu-import-sealed\` holds \`${SNAPSHOT_FILE}\`: ${sealed.length} bytes, SHA-256 \`${digest}\`.`,
    'Open it in the sandbox only: `node scripts/bambu-import/unseal.mjs --key <private key file> snapshot.sealed snapshot.json`.',
  ]);
  return 0;
}

/** The run's mark of the kill switch (catalog_import_runs.notes): set by `revoke --run`, cleared by the owner's dispatch. */
export const KILL_MARK = 'kill_switch';

/**
 * `kill`: the kill switch (workflow 60 mode=revoke). It also marks the run, so that a chained job — dispatched a
 * moment before, or after a door that did not settle while the token was being cleared — never mints it a token
 * again (mint). The always() revoke of every job (`--run-file`) clears the token only.
 */
export function revoke(context, { runId, kill = false }) {
  if (!RUN_ID_PATTERN.test(runId)) throw new CfError('revoke: not a run id');
  resolveDatabase(context);
  const table = query(context, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'catalog_import_runs'").results[0];
  if (Number(table?.n) !== 1) {
    context.log('::notice::catalog_import_runs is not in the live database yet (migration 0195 has not landed): no run token exists, so there is nothing to revoke.');
    summary(context.env, ['## Bambu import: revoke', '', 'No `catalog_import_runs` table yet (migration 0195 not landed): nothing to revoke.']);
    return 0;
  }
  // runId matched RUN_ID_PATTERN (cir_ + 24 hex): it cannot carry a quote.
  query(context, `UPDATE catalog_import_runs SET token_sha256 = ''${kill ? `, notes = '${KILL_MARK}'` : ''} WHERE id = '${runId}'`);
  const check = query(
    context,
    `SELECT COUNT(*) AS run_rows, COALESCE(SUM(token_sha256 <> ''), 0) AS run_tokens, (SELECT COUNT(*) FROM catalog_import_runs WHERE token_sha256 <> '') AS live_tokens FROM catalog_import_runs WHERE id = '${runId}'`
  ).results[0];
  if (Number(check?.run_rows) !== 1) throw new CfError(`revoke: there is no run ${runId} in catalog_import_runs`);
  if (Number(check?.run_tokens) !== 0) throw new CfError(`revoke: the token of ${runId} is still set`);
  context.log(`revoke: ${runId}: token cleared; tokens still live on any run: ${Number(check.live_tokens)}`);
  if (kill) context.log(`revoke: ${runId}: the kill switch holds: no chained job mints a token again; the owner's own dispatch (chain_count 0) lifts it`);
  summary(context.env, [
    '## Bambu import: revoke',
    '',
    `Run \`${runId}\`: token cleared. Tokens still live on any run: ${Number(check.live_tokens)}.`,
    ...(kill ? ['', 'The kill switch holds: no chained job mints a token for this run again. Dispatching the run yourself (chain_count 0) lifts it; cancel any dispatch of yours still queued.'] : []),
  ]);
  return 0;
}

/** Revoke through the run-id file a mint/open step wrote; no file means no token was minted in this job. */
export function revokeFromFile(context, { runFile }) {
  if (!existsSync(runFile)) {
    context.log('::notice::no run id file: this job minted no token, so there is nothing to revoke.');
    return 0;
  }
  const runId = readFileSync(runFile, 'utf8').trim();
  if (!RUN_ID_PATTERN.test(runId)) throw new CfError('revoke: the run id file does not hold a run id');
  return revoke(context, { runId });
}

const iso = (ms) => new Date(ms).toISOString();
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The repository's migrations: the count and the last name the live database must report. */
export function repoMigrations(root = ROOT) {
  const names = readdirSync(join(root, 'migrations')).filter((name) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
  return { count: names.length, last: names.at(-1) ?? '' };
}

/** The reviewed bundle's combined digest and manifest size (discover.ts bundleDigest; the Worker compares it). */
export function reviewedBundle(root = ROOT, dataDir = '') {
  const dir = dataDir ? resolve(root, dataDir) : join(root, 'data', 'bambu-import');
  const sums = {};
  for (const file of REVIEWED_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) throw new CfError(`the reviewed file data/bambu-import/${file} is missing`);
    sums[file] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  const digest = createHash('sha256')
    .update(Object.keys(sums).sort().map((file) => `${file} ${sums[file]}\n`).join(''))
    .digest('hex');
  let rows = 0;
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    rows = Array.isArray(manifest?.rows) ? manifest.rows.length : Array.isArray(manifest) ? manifest.length : 0;
  } catch {
    throw new CfError('data/bambu-import/manifest.json is not JSON');
  }
  return { digest, rows };
}

function tableExists(context, name) {
  return Number(query(context, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${name}'`).results[0]?.n) === 1;
}

/** The restore point (§1 row 18): the Time Travel bookmark at this moment, printed and in the summary. */
function bookmark(context) {
  const text = wrangler(context, ['d1', 'time-travel', 'info', DATABASE], { raw: true });
  const found = BOOKMARK_PATTERN.exec(text);
  if (!found) throw new CfError('no Time Travel bookmark was returned: refusing to write the live database without a restore point');
  return found[0];
}

export function preflight(context, { forMode, runId }) {
  resolveDatabase(context);
  const migrations = query(context, 'SELECT COUNT(*) AS n, (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS last FROM d1_migrations').results[0] ?? {};
  const repo = repoMigrations();
  const count = Number(migrations.n);
  const last = String(migrations.last ?? '');
  context.log(`preflight: migrations applied: ${count}; last ${/^\d{4}_[\w-]+\.sql$/.test(last) ? last : '?'}; the repository has ${repo.count}, the last ${repo.last}`);
  if (count !== repo.count || last !== repo.last) throw new CfError('the live migrations are not the repository\'s: deploy through workflow 7 first');
  if (!tableExists(context, 'catalog_import_runs')) throw new CfError('catalog_import_runs is not in the live database (migration 0195)');
  const active = Number(query(context, "SELECT COUNT(*) AS n FROM catalog_import_runs WHERE state IN ('open','running','blocked')").results[0]?.n);
  context.log(`preflight: active import runs: ${active}`);
  if ((forMode === 'preflight' || forMode === 'open') && active !== 0) throw new CfError('an import run is already active');
  let leases = 0;
  if (forMode === 'preflight' && tableExists(context, 'product_imports')) {
    leases = Number(query(context, "SELECT COUNT(*) AS n FROM product_imports WHERE apply_lease_until > strftime('%Y-%m-%dT%H:%M:%fZ','now')").results[0]?.n);
    context.log(`preflight: CSV imports holding an apply lease: ${leases}`);
    if (leases !== 0) throw new CfError('a CSV import is applying: wait for it');
  }
  if (['run', 'close', 'withdraw'].includes(forMode)) {
    const run = query(context, `SELECT COUNT(*) AS n FROM catalog_import_runs WHERE id = '${runId}' AND state IN ('open','running','blocked')`).results[0];
    if (Number(run?.n) !== 1) throw new CfError(`run ${runId} is not an active import run`);
    context.log(`preflight: run ${runId} is active`);
  }
  const bm = bookmark(context);
  context.log(`preflight: Time Travel bookmark (restore point): ${bm}`);
  summary(context.env, [
    '## Bambu import: preflight and restore point',
    '',
    `Migrations applied: ${count}, the last \`${last}\`. Active import runs: ${active}.`,
    `Time Travel bookmark: \`${bm}\``,
    '```',
    `wrangler d1 time-travel restore ${DATABASE} --bookmark ${bm}`,
    '```',
    '**استعادة نقطة الرجوع تمحو كل ما كُتب بعدها (طلبات، محافظ). الملاذ الأخير فقط؛ التراجع المضبوط هو §A.10.**',
    'Restoring this bookmark erases everything written after it (orders, wallets). The last resort only; the controlled rollback is §A.10 of the import spec.',
  ]);
  return 0;
}

/** A fresh 256-bit token: the clear value to a 0600 file, its SHA-256 for the run row. */
function newToken(tokenFile) {
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: 'wx' });
  const hash = createHash('sha256').update(token).digest('hex');
  return hash;
}

function tokenExpiry(context) {
  if (context.deadline === null) throw new CfError('DEADLINE_EPOCH is required to mint a token (it expires at the job end)');
  const expires = iso(context.deadline + TOKEN_TAIL_MS);
  if (!ISO_PATTERN.test(expires)) throw new CfError('the token expiry is malformed');
  return expires;
}

function writeRunFile(runFile, runId) {
  mkdirSync(dirname(runFile), { recursive: true, mode: 0o700 });
  writeFileSync(runFile, `${runId}\n`, { mode: 0o600, flag: 'w' });
}

const githubRunOf = (env) => (/^\d{1,20}$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : '');
const commitOf = (env) => (/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : '');

export function open(context, { tokenFile, runFile }) {
  const expires = tokenExpiry(context);
  // BAMBU_IMPORT_DATA_DIR exists for tests (a fixture bundle); workflow 60 never sets it.
  const bundle = reviewedBundle(ROOT, context.env.BAMBU_IMPORT_DATA_DIR ?? '');
  resolveDatabase(context);
  if (!tableExists(context, 'catalog_import_runs')) throw new CfError('catalog_import_runs is not in the live database (migration 0195)');
  const runId = `cir_${randomBytes(12).toString('hex')}`;
  if (!RUN_ID_PATTERN.test(runId)) throw new CfError('the new run id is malformed');
  // The run id file first: the always() revoke finds the run even if a later line fails.
  writeRunFile(runFile, runId);
  const hash = newToken(tokenFile);
  try {
    // Every value below is validated: the run id and digests are hex, the expiry ISO, the counts integers.
    query(
      context,
      `INSERT INTO catalog_import_runs (id, source, state, token_sha256, token_expires_at, github_run_id, manifest_total, reviewed_bundle_sha256, code_commit) VALUES ('${runId}', 'bambu_us', 'open', '${hash}', '${expires}', '${githubRunOf(context.env)}', ${Number(bundle.rows) | 0}, '${bundle.digest}', '${commitOf(context.env)}')`
    );
    const check = query(context, `SELECT COUNT(*) AS n FROM catalog_import_runs WHERE id = '${runId}' AND token_sha256 = '${hash}' AND state = 'open'`).results[0];
    if (Number(check?.n) !== 1) throw new CfError('the new run was not stored');
  } catch (failure) {
    rmSync(tokenFile, { force: true });
    throw failure;
  }
  context.log(`open: run ${runId} created (${bundle.rows} manifest rows); a job token was minted, only its hash is stored; it expires ${expires}`);
  summary(context.env, ['## Bambu import: run opened', '', `Run \`${runId}\`: ${bundle.rows} manifest rows; reviewed bundle \`${bundle.digest}\`. The job token expires ${expires} and is revoked at the end of this job.`]);
  return 0;
}

export function mint(context, { runId, chainCount, tokenFile, runFile }) {
  if (!Number.isInteger(chainCount) || chainCount < 0 || chainCount > 12) throw new CfError('mint: the chain count is 0 to 12');
  const expires = tokenExpiry(context);
  resolveDatabase(context);
  writeRunFile(runFile, runId);
  const killed = () => Number(query(context, `SELECT COUNT(*) AS n FROM catalog_import_runs WHERE id = '${runId}' AND notes = '${KILL_MARK}'`).results[0]?.n) === 1;
  const stopped = () => new CfError(`run ${runId} was stopped by the kill switch: a chained job never re-arms it; dispatch mode=run with chain_count 0 to continue`);
  // A chained job (the chain job dispatched it) never re-arms a run its owner stopped; the owner's dispatch does.
  const chained = chainCount > 0;
  const wasKilled = killed();
  if (wasKilled && chained) throw stopped();
  const hash = newToken(tokenFile);
  try {
    // Chained: fenced on the mark as well, so a kill switch pressed between the read above and this write still wins.
    query(
      context,
      `UPDATE catalog_import_runs SET token_sha256 = '${hash}', token_expires_at = '${expires}', github_run_id = '${githubRunOf(context.env)}'${wasKilled ? ", notes = ''" : ''} WHERE id = '${runId}' AND state IN ('open','running','blocked')${chained ? ` AND notes <> '${KILL_MARK}'` : ''}`
    );
    const check = query(context, `SELECT COUNT(*) AS n FROM catalog_import_runs WHERE id = '${runId}' AND token_sha256 = '${hash}'`).results[0];
    if (Number(check?.n) !== 1) throw chained && killed() ? stopped() : new CfError(`run ${runId} is not an active import run: no token was stored`);
  } catch (failure) {
    rmSync(tokenFile, { force: true });
    throw failure;
  }
  if (wasKilled) context.log(`mint: run ${runId}: the kill switch is lifted by this dispatch of the owner (chain_count 0)`);
  context.log(`mint: run ${runId}: a job token was minted, only its hash is stored; it expires ${expires}`);
  return 0;
}

/** The run's ledger (§H.3) read from D1 and sealed in memory; the log carries counts by state only. */
export function report(context, { runId, publicKey, outDir }) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const target = join(outDir, REPORT_FILE);
  if (existsSync(target) || existsSync(`${target}.partial`)) throw new CfError(`${REPORT_FILE} already exists in the output directory`);
  resolveDatabase(context);
  if (!tableExists(context, 'catalog_import_runs')) throw new CfError('catalog_import_runs is not in the live database (migration 0195)');
  const statements = {
    run: `SELECT id, state, manifest_total, started_at, closed_at, reviewed_bundle_sha256, sitemap_fingerprint, code_commit, github_run_id FROM catalog_import_runs WHERE id = '${runId}'`,
    items: `SELECT source_product_id, handle, queue_position, product_type, curated_scope, hold_code, processing_state, last_completed_stage, attempts, stage_attempts, retry_at, last_error_code, blocker_code, match_kind, levonis_product_id, slug, live_url, unpublished_on_block, quality, d1_checks, edge_evidence, source_sold_out_variants, verified_at, completed_at, updated_at FROM catalog_import_items WHERE run_id = '${runId}' ORDER BY queue_position`,
    media: `SELECT role, status, COUNT(*) AS n FROM catalog_import_media WHERE run_id = '${runId}' GROUP BY role, status ORDER BY role, status`,
    conflicts: `SELECT kind, resolved, COUNT(*) AS n FROM catalog_import_conflicts WHERE run_id = '${runId}' GROUP BY kind, resolved ORDER BY kind`,
    events: `SELECT stage, outcome, COUNT(*) AS n FROM catalog_import_events WHERE run_id = '${runId}' GROUP BY stage, outcome ORDER BY stage, outcome`,
  };
  const tables = {};
  for (const [key, sql] of Object.entries(statements)) tables[key] = query(context, sql).results;
  if ((tables.run ?? []).length !== 1) throw new CfError(`there is no run ${runId}`);
  const byState = {};
  for (const item of tables.items) byState[item.processing_state] = (byState[item.processing_state] ?? 0) + 1;
  for (const [state, n] of Object.entries(byState).sort()) {
    if (/^[A-Z_]{3,32}$/.test(state)) context.log(`report: ${state}: ${n}`);
  }
  const clear = Buffer.from(JSON.stringify({ format: REPORT_FORMAT, database: DATABASE, taken_at: new Date().toISOString(), run_id: runId, by_state: byState, tables }));
  const sealed = sealBuffer(publicKey, clear);
  clear.fill(0);
  writeFileSync(`${target}.partial`, sealed, { flag: 'wx', mode: 0o600 });
  renameSync(`${target}.partial`, target);
  const digest = createHash('sha256').update(sealed).digest('hex');
  context.log(`report: sealed ${REPORT_FILE}: ${sealed.length} bytes, sha256 ${digest}`);
  summary(context.env, [
    '## Bambu import: run report (sealed)',
    '',
    '| state | items |',
    '|---|---|',
    ...Object.entries(byState)
      .filter(([state]) => /^[A-Z_]{3,32}$/.test(state))
      .sort()
      .map(([state, n]) => `| ${state} | ${n} |`),
    '',
    `Artifact \`bambu-import-sealed\` holds \`${REPORT_FILE}\`: ${sealed.length} bytes, SHA-256 \`${digest}\`.`,
  ]);
  return 0;
}

export function main(argv, { env = process.env, log = console.log, error = console.error } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (failure) {
    error(`::error::cf.mjs: ${failure instanceof Error ? failure.message : String(failure)}`);
    error(USAGE);
    return 2;
  }
  let context;
  try {
    context = openContext(env, log, { honourDeadline: parsed.mode !== 'revoke' });
    switch (parsed.mode) {
      case 'snapshot':
        return snapshot(context, parsed);
      case 'revoke':
        // --run is the kill switch (workflow 60 mode=revoke); --run-file the always() revoke of a job's own token.
        return parsed.runFile ? revokeFromFile(context, parsed) : revoke(context, { ...parsed, kill: true });
      case 'preflight':
        return preflight(context, parsed);
      case 'open':
        return open(context, parsed);
      case 'mint':
        return mint(context, parsed);
      default:
        return report(context, parsed);
    }
  } catch (failure) {
    const reason = failure instanceof CfError ? failure.message : `${failure?.name ?? 'Error'}: ${failure?.message ?? ''}`;
    error(`::error::cf.mjs ${parsed.mode}: ${scrub(reason, context?.secrets)}`);
    return 1;
  } finally {
    if (context) rmSync(context.dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
