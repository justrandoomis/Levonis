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
 *       The kill switch (§A.3): `token_sha256 = ''` on that run, so every ops
 *       path answers 404. Until migration 0195 is live there is no
 *       catalog_import_runs table and no token: a notice, and exit 0.
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
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePublicKey, sealBuffer } from './seal.mjs';

/** The live D1 database (wrangler.jsonc `env.staging`, binding DB). Never derived from input. */
export const DATABASE = 'levonis-db-staging';
/** catalog_import_runs.id, the shape 0195's CHECK and workflow 60 both enforce. */
export const RUN_ID_PATTERN = /^cir_[0-9a-f]{24}$/;
export const SNAPSHOT_SQL = fileURLToPath(new URL('./snapshot.sql', import.meta.url));
export const SNAPSHOT_FILE = 'snapshot.sealed';
export const SNAPSHOT_FORMAT = 'levonis-bambu-snapshot/1';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** One wrangler call never runs longer than this, nor past the job's deadline less a minute. */
const CALL_LIMIT_MS = 3 * 60_000;
const DEADLINE_MARGIN_MS = 60_000;
const WRITE_WORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export class CfError extends Error {}

const USAGE = [
  'usage: node scripts/bambu-import/cf.mjs snapshot --seal <public key> --out <dir>',
  '       node scripts/bambu-import/cf.mjs revoke --run <cir_ + 24 hex>',
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
  if (mode === 'snapshot') {
    const given = options(['--seal', '--out']);
    parsePublicKey(given['--seal']);
    if (!given['--out'] || given['--out'].startsWith('-')) throw new CfError('snapshot: --out needs a directory');
    return { mode, publicKey: given['--seal'], outDir: resolve(given['--out']) };
  }
  if (mode === 'revoke') {
    const given = options(['--run']);
    if (!RUN_ID_PATTERN.test(given['--run'] ?? '')) throw new CfError('revoke: --run must be cir_ followed by 24 lowercase hex characters');
    return { mode, runId: given['--run'] };
  }
  if (['preflight', 'mint'].includes(mode)) throw new CfError(`${mode} is not yet built (import spec §K.2 step 8)`);
  throw new CfError('the first argument is snapshot or revoke');
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

function openContext(env, log) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new CfError("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not in this step's environment");
  }
  const deadline = parseDeadline(env.DEADLINE_EPOCH);
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

function wrangler(context, args) {
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

export function revoke(context, { runId }) {
  if (!RUN_ID_PATTERN.test(runId)) throw new CfError('revoke: not a run id');
  resolveDatabase(context);
  const table = query(context, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'catalog_import_runs'").results[0];
  if (Number(table?.n) !== 1) {
    context.log('::notice::catalog_import_runs is not in the live database yet (migration 0195 has not landed): no run token exists, so there is nothing to revoke.');
    summary(context.env, ['## Bambu import: revoke', '', 'No `catalog_import_runs` table yet (migration 0195 not landed): nothing to revoke.']);
    return 0;
  }
  // runId matched RUN_ID_PATTERN (cir_ + 24 hex): it cannot carry a quote.
  query(context, `UPDATE catalog_import_runs SET token_sha256 = '' WHERE id = '${runId}'`);
  const check = query(
    context,
    `SELECT COUNT(*) AS run_rows, COALESCE(SUM(token_sha256 <> ''), 0) AS run_tokens, (SELECT COUNT(*) FROM catalog_import_runs WHERE token_sha256 <> '') AS live_tokens FROM catalog_import_runs WHERE id = '${runId}'`
  ).results[0];
  if (Number(check?.run_rows) !== 1) throw new CfError(`revoke: there is no run ${runId} in catalog_import_runs`);
  if (Number(check?.run_tokens) !== 0) throw new CfError(`revoke: the token of ${runId} is still set`);
  context.log(`revoke: ${runId}: token cleared; tokens still live on any run: ${Number(check.live_tokens)}`);
  summary(context.env, ['## Bambu import: revoke', '', `Run \`${runId}\`: token cleared. Tokens still live on any run: ${Number(check.live_tokens)}.`]);
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
    context = openContext(env, log);
    return parsed.mode === 'snapshot' ? snapshot(context, parsed) : revoke(context, parsed);
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
