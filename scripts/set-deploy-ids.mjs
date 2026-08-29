#!/usr/bin/env node
/**
 * Resolves deploy-time configuration into wrangler.jsonc, immediately before
 * `wrangler deploy` runs. Nothing here is committed: the repository keeps the
 * *-PLACEHOLDER values so local dev and code review stay free of account
 * identifiers, and this script fills them in the CI working copy only.
 *
 * Two callers, two mechanisms:
 *
 *  1. GitHub Actions passes explicit values as environment variables
 *     (STAGING_DB_ID / PROD_DB_ID / PROD_DB_NAME / PROD_BUCKET) from
 *     repository secrets.
 *  2. Cloudflare Workers Builds passes none of those — but wrangler is
 *     already authenticated there, so the D1 id is resolved BY DATABASE NAME
 *     through `wrangler d1 list`. That is what fixes the deploy failure
 *     "binding DB of type d1 must have a valid `database_id` specified":
 *     the placeholder was reaching the API verbatim.
 *
 * Plain-text vars are also filled from the environment when present, because
 * `wrangler deploy` REPLACES a Worker's vars wholesale — deploying with the
 * committed empty strings would wipe GOOGLE_CLIENT_ID / APP_ORIGIN / … off a
 * running Worker. Values are read, never printed.
 *
 * Usage: node scripts/set-deploy-ids.mjs [--env staging|production]
 *        (CLOUDFLARE_ENV is honoured too; "" / "production" / unset all mean
 *        the top-level block.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const path = new URL('../wrangler.jsonc', import.meta.url);
let cfg = readFileSync(path, 'utf8');
const changes = [];
const notes = [];

// ---------------------------------------------------------------- target env
const argIdx = process.argv.indexOf('--env');
const rawEnv = (argIdx >= 0 ? process.argv[argIdx + 1] : process.env.CLOUDFLARE_ENV) ?? '';
const target = rawEnv === '' || rawEnv === 'production' ? 'production' : rawEnv;
if (target !== 'production' && target !== 'staging') {
  console.error(`set-deploy-ids: unknown environment "${target}" (expected staging or production)`);
  process.exit(1);
}

// Workers Builds deploys whichever environment CLOUDFLARE_ENV/--env selects.
// Refusing an ambiguous run is deliberate: silently taking the top-level
// (production) bindings would point a staging Worker at the production
// database. A failed build is recoverable; that is not.
if (process.env.WORKERS_CI && argIdx < 0 && process.env.CLOUDFLARE_ENV === undefined) {
  console.error(
    'set-deploy-ids: running under Cloudflare Workers Builds without a target environment.\n' +
      'Set the deploy command to `npm run deploy:staging` (or deploy:production), or add a\n' +
      'CLOUDFLARE_ENV build variable. Refusing to guess — the wrong choice would bind the\n' +
      'deployed Worker to the other environment’s D1 database.'
  );
  process.exit(1);
}

// ------------------------------------------------------------- config halves
// The staging block lives under "env"; splitting there lets a replacement be
// scoped to exactly one environment without a JSONC parser.
const envIdx = cfg.indexOf('"env"');
const splitAt = envIdx >= 0 ? envIdx : cfg.length;
let head = cfg.slice(0, splitAt); // top-level (production)
let tail = cfg.slice(splitAt); // env.staging

const inTarget = (fn) => {
  if (target === 'staging') tail = fn(tail);
  else head = fn(head);
};

// ------------------------------------------------------------------ D1 ids
function resolveDbIdByName(name) {
  try {
    const out = execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'list', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: new URL('..', import.meta.url).pathname,
    });
    const list = JSON.parse(out);
    const row = Array.isArray(list) ? list.find((d) => d?.name === name) : null;
    return row?.uuid || null;
  } catch (err) {
    notes.push(`d1 list lookup failed (${err?.message?.split('\n')[0] ?? 'unknown error'})`);
    return null;
  }
}

/** Database name declared in the block we are about to deploy. */
function declaredDbName(block) {
  return block.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
}

const PLACEHOLDER = target === 'staging' ? 'STAGING-DB-ID-PLACEHOLDER' : 'PROD-DB-ID-PLACEHOLDER';
const explicitId = target === 'staging' ? process.env.STAGING_DB_ID : process.env.PROD_DB_ID;

if (process.env.STAGING_DB_ID) {
  tail = tail.replace('STAGING-DB-ID-PLACEHOLDER', process.env.STAGING_DB_ID);
  changes.push('staging database_id (env)');
}
if (process.env.PROD_DB_ID) {
  head = head.replace('PROD-DB-ID-PLACEHOLDER', process.env.PROD_DB_ID);
  changes.push('production database_id (env)');
}
if (process.env.PROD_DB_NAME) {
  head = head.replace('"database_name": "levonis-db"', `"database_name": ${JSON.stringify(process.env.PROD_DB_NAME)}`);
  changes.push('production database_name (env)');
}
if (process.env.PROD_BUCKET) {
  head = head.replace('"bucket_name": "levonis-files"', `"bucket_name": ${JSON.stringify(process.env.PROD_BUCKET)}`);
  changes.push('production bucket_name (env)');
}

// Still a placeholder for the environment being deployed → resolve by name.
const targetBlock = target === 'staging' ? tail : head;
if (!explicitId && targetBlock.includes(PLACEHOLDER)) {
  const name = declaredDbName(targetBlock);
  const uuid = name ? resolveDbIdByName(name) : null;
  if (uuid) {
    inTarget((b) => b.replace(PLACEHOLDER, uuid));
    changes.push(`${target} database_id (resolved from name "${name}")`);
  } else {
    console.error(
      `set-deploy-ids: could not determine the ${target} D1 database id.\n` +
        `  Database name in wrangler.jsonc: ${name ?? '(none found)'}\n` +
        (notes.length ? `  ${notes.join('; ')}\n` : '') +
        '  Provide it explicitly (STAGING_DB_ID / PROD_DB_ID) or make sure the deploy\n' +
        '  credentials can list D1 databases in this account.'
    );
    process.exit(1);
  }
}

// -------------------------------------------------------------- plain vars
// `wrangler deploy` replaces vars wholesale, so anything left empty here is
// erased on the live Worker. Fill from the environment when the caller
// supplied a value; leave the committed empty string otherwise.
const VARS = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID,
  INITIAL_ADMIN_EMAIL: process.env.INITIAL_ADMIN_EMAIL,
  EXTRA_ALLOWED_ORIGINS: process.env.EXTRA_ALLOWED_ORIGINS,
  APP_ORIGIN: process.env.APP_ORIGIN,
  EMAIL_ALLOWED_RECIPIENTS: process.env.EMAIL_ALLOWED_RECIPIENTS,
  EMAIL_FROM: process.env.EMAIL_FROM,
};
const filled = [];
for (const [key, value] of Object.entries(VARS)) {
  if (!value) continue;
  const re = new RegExp(`("${key}"\\s*:\\s*)""`);
  inTarget((b) => {
    if (!re.test(b)) return b;
    filled.push(key);
    return b.replace(re, `$1${JSON.stringify(value)}`);
  });
}
if (filled.length) changes.push(`${target} vars: ${filled.join(', ')}`);

// A deploy that leaves these empty ERASES them on a running Worker. Warn
// loudly rather than silently shipping a config that breaks Google sign-in
// or the origin used in e-mail links. (Worker SECRETS are unaffected by a
// deploy — only these plain-text vars are replaced.)
const criticalEmpty = ['GOOGLE_CLIENT_ID', 'APP_ORIGIN', 'INITIAL_ADMIN_EMAIL'].filter((k) =>
  new RegExp(`"${k}"\\s*:\\s*""`).test(target === 'staging' ? tail : head)
);
if (criticalEmpty.length) {
  console.warn(
    `set-deploy-ids: WARNING — deploying ${target} with empty ${criticalEmpty.join(', ')}.\n` +
      '  wrangler replaces a Worker\'s plain-text vars wholesale, so any value currently\n' +
      '  live will be cleared. Provide them as build/environment variables to keep them.'
  );
}

writeFileSync(path, head + tail);
console.log(`set-deploy-ids [${target}]:`, changes.join(' · ') || 'no changes');
