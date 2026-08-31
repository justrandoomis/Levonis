#!/usr/bin/env node
/**
 * Cloudflare Workers Builds — resolve wrangler.jsonc before `wrangler deploy`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The dashboard-connected build runs a FIXED pair of commands:
 *
 *     npm run build          <- repo-controlled  (this script hooks in here)
 *     npx wrangler deploy    <- NOT repo-controlled: no --env, no substitution
 *
 * That plain deploy failed twice with
 *   "binding DB of type d1 must have a valid `database_id` specified [10021]"
 * because the repository intentionally commits *-PLACEHOLDER instead of real
 * resource ids, and it also warned that the config Worker name ("levonis")
 * did not match the Worker the CI system deploys ("levonis-staging").
 *
 * Since the deploy command cannot be changed from the repository, the build
 * command has to leave a config behind that a bare `wrangler deploy` can use
 * correctly. This script does exactly that, and ONLY inside Workers Builds:
 * every other caller (GitHub Actions, local dev) sees the file untouched.
 *
 * WHAT IT DOES (all of it printed in the build log)
 *   1. Detects the Workers Builds container.
 *   2. Picks the target environment from the Worker name the CI system
 *      provides — never a guess that could bind a staging Worker to the
 *      production database.
 *   3. Copies that environment's name / D1 / R2 into the top-level block,
 *      because a bare `wrangler deploy` reads the top level.
 *   4. Resolves the D1 id BY DATABASE NAME through the already-authenticated
 *      `wrangler d1 list` — no identifier is committed or printed.
 *   5. PRESERVES the plain-text vars already live on that Worker (wrangler
 *      replaces vars wholesale, so an empty config would silently erase
 *      GOOGLE_CLIENT_ID / APP_ORIGIN / … from a running site). Build
 *      environment variables win over the preserved values.
 *
 * Worker SECRETS are never touched by a deploy and are never read here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CONFIG = new URL('../wrangler.jsonc', import.meta.url);
const REPO = new URL('..', import.meta.url).pathname;

// ------------------------------------------------------------ CI detection
// GitHub Actions must never take this path: it does its own substitution with
// explicit ids and deploys with an explicit --env.
const inGitHubActions = !!process.env.GITHUB_ACTIONS;
const inWorkersBuilds =
  !inGitHubActions &&
  (!!process.env.WORKERS_CI ||
    !!process.env.WORKERS_CI_BUILD_UUID ||
    process.cwd().startsWith('/opt/buildhome'));

if (!inWorkersBuilds) process.exit(0);

console.log('prepare-deploy-config: Cloudflare Workers Builds detected.');
// Names only — never values. This makes the next build log self-documenting
// if Cloudflare changes which variables it injects.
const injected = Object.keys(process.env)
  .filter((k) => /^(WORKERS_|WORKERS_CI|CLOUDFLARE_|CF_)/.test(k))
  .sort();
console.log(`  build variables present (names only): ${injected.join(', ') || 'none'}`);

// --------------------------------------------------------- JSONC utilities
/** Strip // and /* *\/ comments without touching string contents. */
function stripJsonComments(src) {
  let out = '';
  let inStr = false;
  let esc = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // Trailing commas are legal in JSONC but not JSON.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const raw = readFileSync(CONFIG, 'utf8');
const cfg = JSON.parse(stripJsonComments(raw));

// ------------------------------------------------------------ target choice
const envNames = Object.keys(cfg.env ?? {});
const productionName = cfg.name;

// Wrangler itself knows the Worker the CI system expects (it printed the name
// in the failing build). Read it from whichever variable carries it; fall back
// to an explicit override, and only then to a documented default.
const ciWorkerName =
  process.env.CLOUDFLARE_WORKERS_SCRIPT_NAME ||
  process.env.WORKERS_CI_SCRIPT_NAME ||
  process.env.WORKERS_SCRIPT_NAME ||
  process.env.CI_WORKER_NAME ||
  '';

let target = ''; // '' means the top-level (production) block
if (ciWorkerName) {
  if (ciWorkerName === productionName) target = '';
  else {
    const match = envNames.find((e) => (cfg.env[e]?.name ?? `${productionName}-${e}`) === ciWorkerName);
    if (!match) {
      console.error(
        `prepare-deploy-config: the CI Worker name "${ciWorkerName}" matches no environment in wrangler.jsonc ` +
          `(top level: "${productionName}", environments: ${envNames.join(', ') || 'none'}).\n` +
          '  Refusing to guess which database this Worker should bind to.'
      );
      process.exit(1);
    }
    target = match;
  }
  console.log(`  CI Worker name: ${ciWorkerName} -> environment "${target || '(top level)'}"`);
} else if (process.env.LEVONIS_CI_ENV !== undefined) {
  target = process.env.LEVONIS_CI_ENV === 'production' ? '' : process.env.LEVONIS_CI_ENV;
  console.log(`  LEVONIS_CI_ENV override -> environment "${target || '(top level)'}"`);
} else {
  // The connected Worker is levonis-staging (it serves the site today). This
  // default is stated out loud, and LEVONIS_CI_ENV overrides it in one step.
  target = 'staging';
  console.log(
    '  No CI Worker name variable found; defaulting to environment "staging" ' +
      '(set LEVONIS_CI_ENV=production as a build variable to change this).'
  );
}

// --------------------------------------------- fold the target into top level
// A bare `wrangler deploy` reads the top-level block, so the chosen
// environment's identity must BE the top level for this build.
if (target) {
  const block = cfg.env[target];
  if (!block) {
    console.error(`prepare-deploy-config: environment "${target}" is not defined in wrangler.jsonc`);
    process.exit(1);
  }
  for (const key of ['name', 'd1_databases', 'r2_buckets', 'vars', 'assets', 'observability', 'triggers']) {
    if (block[key] !== undefined) cfg[key] = structuredClone(block[key]);
  }
  console.log(`  top-level config now describes: ${cfg.name}`);
}

// ------------------------------------------------------------- D1 id by name
function resolveDbId(name) {
  if (process.env.STAGING_DB_ID && target === 'staging') return process.env.STAGING_DB_ID;
  if (process.env.PROD_DB_ID && !target) return process.env.PROD_DB_ID;
  try {
    const out = execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'list', '--json'], {
      encoding: 'utf8',
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const row = JSON.parse(out).find((d) => d?.name === name);
    return row?.uuid || null;
  } catch (err) {
    console.error(`  d1 list failed: ${String(err?.message ?? err).split('\n')[0]}`);
    return null;
  }
}

for (const db of cfg.d1_databases ?? []) {
  if (typeof db.database_id === 'string' && !db.database_id.includes('PLACEHOLDER')) continue;
  const id = resolveDbId(db.database_name);
  if (!id) {
    console.error(
      `prepare-deploy-config: could not resolve the id of D1 database "${db.database_name}".\n` +
        '  The deploy credentials must be able to list D1 databases in this account.'
    );
    process.exit(1);
  }
  db.database_id = id;
  console.log(`  resolved database_id for "${db.database_name}" (from its name)`);
}

// ------------------------------------------------- keep the live plain vars
// `wrangler deploy` replaces vars wholesale. Without this step the first
// dashboard-triggered deploy would clear values that the GitHub workflow set
// with --var, breaking Google sign-in and e-mail links on a running site.
async function liveVars(scriptName) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return null;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${scriptName}/settings`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) return null;
  const body = await res.json();
  const out = {};
  for (const b of body?.result?.bindings ?? []) {
    if (b?.type === 'plain_text' && typeof b.name === 'string' && typeof b.text === 'string') out[b.name] = b.text;
  }
  return out;
}

cfg.vars ??= {};
const fromEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID,
  INITIAL_ADMIN_EMAIL: process.env.INITIAL_ADMIN_EMAIL,
  EXTRA_ALLOWED_ORIGINS: process.env.EXTRA_ALLOWED_ORIGINS,
  APP_ORIGIN: process.env.APP_ORIGIN,
  EMAIL_ALLOWED_RECIPIENTS: process.env.EMAIL_ALLOWED_RECIPIENTS,
  EMAIL_FROM: process.env.EMAIL_FROM,
  // The host classifier reads this. Without it every host is `foreign`, no
  // merchant subdomain resolves, and — before adminAllowedOn — the whole
  // admin API answered 404 on the apex.
  STORE_ROOT_DOMAIN: process.env.STORE_ROOT_DOMAIN,
};

const preserved = [];
const overridden = [];
const live = await liveVars(cfg.name).catch(() => null);

// EVERY live name, not only the ones this file happens to declare.
//
// This loop used to iterate `Object.keys(cfg.vars)`, which meant a variable
// present on the running Worker but absent from the committed config was
// never considered for preservation — and `wrangler deploy` replaces vars
// wholesale, so it was silently erased. That is exactly the failure this
// script exists to prevent, reappearing through the one gap it left.
//
// It cost STORE_ROOT_DOMAIN on the live site: set by the GitHub Actions
// deploy, then dropped ~60 seconds after the next push, taking merchant
// subdomain resolution with it.
const names = new Set([...Object.keys(cfg.vars), ...Object.keys(live ?? {})]);
for (const key of names) {
  if (fromEnv[key]) {
    cfg.vars[key] = fromEnv[key];
    overridden.push(key);
  } else if (!cfg.vars[key] && live && live[key]) {
    cfg.vars[key] = live[key];
    preserved.push(key);
  }
}
for (const [key, value] of Object.entries(fromEnv)) {
  if (value && cfg.vars[key] === undefined) {
    cfg.vars[key] = value;
    overridden.push(key);
  }
}

if (overridden.length) console.log(`  vars from build variables: ${overridden.join(', ')}`);
if (preserved.length) console.log(`  vars preserved from the live Worker: ${preserved.join(', ')}`);
if (!live) {
  console.log('  (could not read the live Worker settings — vars come from build variables only)');
}
const stillEmpty = Object.entries(cfg.vars)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (stillEmpty.length) {
  console.warn(
    `  WARNING: deploying with empty ${stillEmpty.join(', ')}. wrangler replaces vars wholesale, so any ` +
      'value currently live for those names will be cleared. Add them as build variables to keep them.'
  );
}

// The CI working copy is ephemeral; comments are not needed in it, and plain
// JSON is valid in a .jsonc file.
writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);
console.log('prepare-deploy-config: wrangler.jsonc resolved for this build.');
