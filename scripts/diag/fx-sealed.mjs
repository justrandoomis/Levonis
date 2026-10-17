#!/usr/bin/env node
/**
 * READ-ONLY, SEALED DIAGNOSIS OF THE PUBLIC USD RATE (workflow 62, branch diag/fx-rate only).
 *
 * Every statement below is a SELECT against the live database (levonis-db-staging). The answers are collected
 * in memory, sealed with scripts/bambu-import/seal.mjs to the one-time X25519 public key in SEAL_PUBKEY, and
 * only the .sealed file is written. The log carries row counts and scrubbed error reasons, never a row.
 *
 *   node scripts/diag/fx-sealed.mjs --out <dir>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePublicKey, sealBuffer } from '../bambu-import/seal.mjs';

const DATABASE = 'levonis-db-staging';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** [key, sql] — every one a SELECT. */
const QUERIES = [
  ['migrations_last', `SELECT id, name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 5`],
  ['pricing_fx_rates', `SELECT * FROM pricing_fx_rates`],
  ['fx_rate_pairs', `SELECT * FROM fx_rate_pairs`],
  ['fx_rate_log_events', `SELECT pair, event, result, count(*) AS n, min(created_at) AS first_at, max(created_at) AS last_at FROM fx_rate_log GROUP BY pair, event, result ORDER BY last_at DESC`],
  ['fx_rate_log_last', `SELECT * FROM fx_rate_log ORDER BY created_at DESC, rowid DESC LIMIT 40`],
  ['settings_fx', `SELECT key, value FROM settings WHERE key LIKE '%fx%' OR key LIKE '%rate%' OR key LIKE '%usd%' OR key LIKE '%currency%'`],
];

const ID_KEYS = /(^|_)(user_id|actor_id|owner_user_id|changed_by|decided_by|proposed_by|actor_user_id|created_by|recipient)$/;
const DROP_KEYS = new Set(['address_snapshot', 'phone', 'email', 'password_hash']);

/** Ids of people shortened to their last 6 characters; addresses dropped. The whole document is sealed anyway. */
function redact(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (DROP_KEYS.has(key)) {
      out[key] = value == null ? value : '[dropped]';
      continue;
    }
    out[key] = ID_KEYS.test(key) && typeof value === 'string' && value.length > 6 ? `…${value.slice(-6)}` : value;
  }
  return out;
}

function scrub(text, secrets) {
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

function reasonOf(result, secrets) {
  for (const stream of [result.stdout, result.stderr]) {
    const start = (stream ?? '').indexOf('{');
    if (start < 0) continue;
    try {
      const error = JSON.parse(stream.slice(start))?.error;
      const notes = Array.isArray(error?.notes) ? error.notes.map((n) => n?.text).filter((t) => typeof t === 'string') : [];
      const text = [error?.text, ...notes].filter(Boolean).join(' / ');
      if (text) return scrub(text, secrets);
    } catch {
      /* not the JSON error shape */
    }
  }
  const line = `${result.stderr ?? ''}`.split('\n').find((l) => /error/i.test(l)) ?? 'no reason given';
  return scrub(line.replace(/^.*?\[ERROR\]\s*/, ''), secrets);
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  if (outIndex < 0 || !process.argv[outIndex + 1]) {
    console.error('usage: node scripts/diag/fx-sealed.mjs --out <dir>');
    return 2;
  }
  const outDir = resolve(process.argv[outIndex + 1]);
  const publicKey = String(process.env.SEAL_PUBKEY ?? '').trim();
  parsePublicKey(publicKey);
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not in this step's environment");
    return 1;
  }
  const env = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' };
  delete env.CLOUDFLARE_ENV;
  const dir = mkdtempSync(join(tmpdir(), 'levonis-diag-fx-'));
  const config = join(dir, 'wrangler.json');
  const secrets = [];
  const writeConfig = (uuid) => {
    const body = { name: 'levonis-diag-fx-fx', compatibility_date: '2026-08-01' };
    if (uuid) body.d1_databases = [{ binding: 'DB', database_name: DATABASE, database_id: uuid }];
    writeFileSync(config, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  };
  const wrangler = (args) => {
    const result = spawnSync('npx', ['--no-install', 'wrangler', ...args, '--config', config], {
      env,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) return { ok: false, reason: `did not complete (${result.error.code ?? result.error.name})` };
    if (result.status !== 0) return { ok: false, reason: `exit ${result.status ?? result.signal}: ${reasonOf(result, secrets)}` };
    try {
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch {
      return { ok: false, reason: 'did not answer with JSON' };
    }
  };

  writeConfig(null);
  const list = wrangler(['d1', 'list', '--json']);
  if (!list.ok) {
    console.error(`d1 list failed: ${list.reason}`);
    return 1;
  }
  const found = Array.isArray(list.value) ? list.value.filter((d) => d?.name === DATABASE) : [];
  if (found.length !== 1 || !UUID_PATTERN.test(String(found[0].uuid ?? ''))) {
    console.error(`d1 list: expected one well-formed ${DATABASE}, found ${found.length}`);
    return 1;
  }
  const uuid = String(found[0].uuid);
  console.log(`::add-mask::${uuid}`);
  secrets.push(uuid);
  writeConfig(uuid);
  console.log(`${DATABASE} resolved; its id is masked`);

  const tables = {};
  const errors = {};
  const counts = {};
  for (const [key, sql] of QUERIES) {
    if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`${key} is not a SELECT`);
    const answer = wrangler(['d1', 'execute', DATABASE, '--remote', '--json', '--yes', '--command', sql]);
    if (!answer.ok) {
      errors[key] = answer.reason;
      console.log(`${key}: ERROR ${answer.reason}`);
      continue;
    }
    const first = Array.isArray(answer.value) ? answer.value[0] : null;
    if (!first || first.success !== true || !Array.isArray(first.results)) {
      errors[key] = 'no successful result';
      console.log(`${key}: ERROR no successful result`);
      continue;
    }
    tables[key] = first.results.map(redact);
    counts[key] = first.results.length;
    console.log(`${key}: ${first.results.length} ${first.results.length === 1 ? 'row' : 'rows'}`);
  }

  const document = {
    database: DATABASE,
    subject: 'public USD display rate',
    taken_at: new Date().toISOString(),
    github: { run_id: process.env.GITHUB_RUN_ID ?? '', sha: process.env.GITHUB_SHA ?? '' },
    statements: Object.fromEntries(QUERIES),
    counts,
    errors,
    tables,
  };
  const clear = Buffer.from(JSON.stringify(document));
  const sealed = sealBuffer(publicKey, clear);
  clear.fill(0);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const target = join(outDir, 'fx-rate.sealed');
  writeFileSync(`${target}.partial`, sealed, { flag: 'wx', mode: 0o600 });
  renameSync(`${target}.partial`, target);
  console.log(`sealed fx-rate.sealed: ${sealed.length} bytes, sha256 ${createHash('sha256').update(sealed).digest('hex')}`);
  console.log(`queries: ${QUERIES.length}, answered: ${Object.keys(counts).length}, failed: ${Object.keys(errors).length}`);
  return 0;
}

process.exitCode = main();
