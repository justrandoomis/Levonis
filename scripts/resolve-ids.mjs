#!/usr/bin/env node
/**
 * Resolve a service's deploy-time resource ids into its wrangler config, and
 * make a FIRST deploy possible (`02-MIGRATION-PLAN.md` §11.6, §12).
 *
 * Two jobs, both of which exist because of a failure mode that has already
 * happened on this account or is documented in the plan:
 *
 *  1. **D1 ids by NAME.** The repository commits `*-PLACEHOLDER` instead of
 *     account identifiers, so the id has to be resolved from
 *     `wrangler d1 list --json` right before the deploy — exactly what
 *     `scripts/set-deploy-ids.mjs` does for the core. With `--create` a MISSING
 *     database is created first (the pattern of `deploy-staging.yml:47-60`);
 *     without it, a missing database is a refusal, never a silent skip.
 *
 *  2. **Two-step first deploy.** The Workers upload API rejects a `services`
 *     binding whose target Worker does not exist yet. That makes self-bindings
 *     and cycles (Ledger↔Notifications, Identity↔Notifications) undeployable in
 *     one pass. So this script STRIPS every `services` entry whose target is
 *     absent from the account, the workflow deploys, and then runs it again
 *     with `--full` and deploys a second time. The second pass is idempotent:
 *     when nothing was stripped, the workflow skips it.
 *
 *     `--full` RE-CHECKS THE ACCOUNT; it does not put bindings back blind. The
 *     two-pass dance only works for a target the same job creates (a
 *     self-binding). For the core<->leaf cycle it was actually written for —
 *     `services/audit` and `services/analytics` bind `levonis-core-dark`, which
 *     the LEAF jobs run before — an unconditional restore produced a second
 *     deploy the upload API refuses for the same reason as the first, failing
 *     the job and stopping the whole gated rollout. So `--full` re-adds only
 *     the targets that now exist, and reports `restored` so the workflow can
 *     skip a redeploy that would restore nothing. A leaf whose target still
 *     does not exist is deployed WITHOUT that binding and re-deployed by the
 *     `rebind` stage after the core is up.
 *
 * SAFETY. This script only ever touches configs of NEW Workers. It refuses
 * outright if the resolved Worker name is one of the two live Workers
 * (`levonis-staging`, `levonis-studio-staging` — `docs/WORKERS.md`), because
 * nothing in this programme may rewrite the config of a Worker that is serving
 * customers. It creates nothing without `--create`, and it never prints an id.
 *
 *   node scripts/resolve-ids.mjs --service audit --env dark [--create] [--full] [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseJsonc } from './lib/jsonc.mjs';
import { ROOT, configPath, describe } from './worker-name.mjs';

/** Never rewritten by this programme. `docs/WORKERS.md` is the source of truth. */
const LIVE_WORKERS = new Set(['levonis-staging', 'levonis-studio-staging']);

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);

const service = arg('--service');
const envName = arg('--env', 'dark');
const create = has('--create');
const full = has('--full');
const dryRun = has('--dry-run');

if (!service) {
  console.error('usage: node scripts/resolve-ids.mjs --service <name> --env <dark|production> [--create] [--full] [--dry-run]');
  process.exit(2);
}

const env = envName === 'production' ? '' : envName;
const info = describe(service, env);
if (LIVE_WORKERS.has(info.name)) {
  console.error(
    `resolve-ids: "${info.name}" is a LIVE Worker (docs/WORKERS.md). This script only prepares NEW Workers; ` +
      'the live deploys are workflows 7 and 8.'
  );
  process.exit(1);
}

const path = configPath(service);
const cfg = parseJsonc(readFileSync(path, 'utf8'));
const block = env ? cfg.env[env] : cfg;
const changes = [];

// ------------------------------------------------------------- wrangler I/O
const wrangler = (args) =>
  execFileSync('npx', ['--no-install', 'wrangler', ...args], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function d1List() {
  try {
    const out = JSON.parse(wrangler(['d1', 'list', '--json']));
    return Array.isArray(out) ? out : [];
  } catch (e) {
    console.error(`resolve-ids: \`wrangler d1 list\` failed: ${String(e?.message ?? e).split('\n')[0]}`);
    process.exit(1);
  }
}

/** Worker names that exist on the account. Used only to decide what to strip. */
function deployedWorkers() {
  const names = new Set();
  for (const s of [...(block.services ?? [])]) {
    if (!s?.service) continue;
    try {
      wrangler(['deployments', 'list', '--name', s.service]);
      names.add(s.service);
    } catch {
      /* absent: leave it out */
    }
  }
  return names;
}

// ------------------------------------------------------------------ D1 ids
let databases = null;
for (const db of block.d1_databases ?? []) {
  if (typeof db.database_id === 'string' && db.database_id && !db.database_id.includes('PLACEHOLDER')) continue;
  databases ??= d1List();
  let row = databases.find((d) => d?.name === db.database_name);
  if (!row && create) {
    if (dryRun) {
      changes.push(`would create D1 "${db.database_name}"`);
      continue;
    }
    console.log(`resolve-ids: creating D1 "${db.database_name}"…`);
    wrangler(['d1', 'create', db.database_name]);
    databases = d1List();
    row = databases.find((d) => d?.name === db.database_name);
  }
  if (!row?.uuid) {
    console.error(
      `resolve-ids: D1 database "${db.database_name}" does not exist on this account.\n` +
        (create
          ? '  Creating it failed — the deploy token may not have D1:edit.'
          : '  Re-run the workflow with the "create missing resources" input to create it. Creating a database is an account change and is confirmed, never implicit.')
    );
    process.exit(1);
  }
  db.database_id = row.uuid; // never printed
  changes.push(`database_id of "${db.database_name}" (resolved from its name)`);
}

// ------------------------------------------------------------- R2 buckets
if (create && (block.r2_buckets ?? []).length) {
  let existing = '';
  try {
    existing = wrangler(['r2', 'bucket', 'list']);
  } catch {
    existing = '';
  }
  for (const b of block.r2_buckets) {
    if (new RegExp(`\\b${b.bucket_name}\\b`).test(existing)) continue;
    if (dryRun) {
      changes.push(`would create R2 bucket "${b.bucket_name}"`);
      continue;
    }
    console.log(`resolve-ids: creating R2 bucket "${b.bucket_name}"…`);
    try {
      wrangler(['r2', 'bucket', 'create', b.bucket_name]);
    } catch (e) {
      console.error(`resolve-ids: could not create R2 bucket "${b.bucket_name}": ${String(e?.message ?? e).split('\n')[0]}`);
      process.exit(1);
    }
    changes.push(`created R2 bucket "${b.bucket_name}"`);
  }
}

// ------------------------------------------- services bindings (first deploy)
const stripped = [];
const restored = [];
if ((block.services ?? []).length) {
  const present = deployedWorkers();
  const keep = [];
  for (const s of block.services) {
    if (present.has(s.service)) {
      keep.push(s);
      if (full) restored.push(`${s.binding} -> ${s.service}`);
    } else {
      stripped.push(`${s.binding} -> ${s.service}`);
    }
  }
  if (stripped.length) {
    block.services = keep;
    changes.push(`stripped ${stripped.length} services binding(s) whose target Worker does not exist yet: ${stripped.join(', ')}`);
  }
  if (full) {
    changes.push(
      restored.length
        ? `second pass: ${restored.length} binding(s) whose target now exists: ${restored.join(', ')}`
        : 'second pass: no stripped binding\u2019s target exists yet — nothing to redeploy'
    );
  }
}

// --------------------------------------------------------------------- write
if (dryRun) {
  console.log(`resolve-ids [${service}/${info.env}] DRY RUN: ${changes.join(' · ') || 'nothing to do'}`);
} else {
  // The CI working copy is ephemeral; plain JSON is valid in a .jsonc file.
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`resolve-ids [${service}/${info.env}] ${info.name}: ${changes.join(' · ') || 'no changes'}`);
}

// The workflow reads these. `stripped` says a second pass is worth attempting
// at all; `restored` (only meaningful under `--full`) says whether the second
// pass actually put anything back — a redeploy that restores nothing would be
// refused by the upload API for the same reason the first pass was.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `stripped=${stripped.length}\nrestored=${restored.length}\n`, { flag: 'a' });
}
