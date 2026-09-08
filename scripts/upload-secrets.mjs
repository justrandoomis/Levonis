#!/usr/bin/env node
/**
 * Upload a service's secrets — BY NAME ONLY — from the repository's secret
 * store to its Worker (`02-MIGRATION-PLAN.md` §11.6, §12).
 *
 * THE RULES THIS ENFORCES
 *  1. **The names are the contract.** Only the names listed in
 *     `services/<name>/SECRETS.md` may be uploaded. A repository secret that is
 *     not in that file is ignored, and a name in that file that is not declared
 *     in `OWNERSHIP.json` `secrets` is a refusal — `tests/leastPrivilege.test.ts`
 *     holds the same pair together at check time.
 *  2. **Unset means untouched.** A secret whose environment variable is absent
 *     is skipped, never cleared. A service ships with its provider unconfigured
 *     and says so honestly (`services/ads`, `services/notifications`); an
 *     upload step that blanked a name would be a silent outage instead.
 *  3. **Values never reach a log, a command line or this script's stdout.** The
 *     value is piped to `wrangler secret put` on stdin. `ps` shows the name, and
 *     only the name.
 *  4. **A live Worker is never a target.** `levonis-staging` and
 *     `levonis-studio-staging` are refused outright; their secrets are
 *     workflows 7 and 8's business.
 *
 *  5. **A non-production environment prefers its OWN credential.**
 *     `<SVC>__<ENV>__<NAME>` (e.g. `ADS__DARK__META_CAPI_ACCESS_TOKEN`,
 *     `NOTIFICATIONS__DARK__EMAIL_API_KEY`) wins over `<SVC>__<NAME>` for that
 *     environment. Without it one repository secret goes to BOTH the dark and
 *     the production Worker, which is how a dark run ends up holding the
 *     production mail key and the production ad-platform tokens. Where the
 *     env-scoped name is unset the plain one is still used, so nothing that
 *     works today stops working — but the safe configuration is now
 *     expressible, and it is the one the dark workflows should be given.
 *
 * The environment variable for `<NAME>` of service `<svc>` is `<SVC>__<NAME>`
 * (double underscore), e.g. `AUDIT__AUDIT_CHAIN_KEY`,
 * `ADS__META_CAPI_ACCESS_TOKEN`; `<SVC>__<ENV>__<NAME>` overrides it per
 * environment.
 *
 *   node scripts/upload-secrets.mjs --service audit --env dark [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, describe } from './worker-name.mjs';

const LIVE_WORKERS = new Set(['levonis-staging', 'levonis-studio-staging']);

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const service = arg('--service');
const envName = arg('--env', 'dark');
const dryRun = process.argv.includes('--dry-run');
if (!service) {
  console.error('usage: node scripts/upload-secrets.mjs --service <name> --env <dark|production> [--dry-run]');
  process.exit(2);
}

/**
 * The secret NAMES a SECRETS.md declares. Deliberately permissive about the
 * markdown around them and strict about the shape of a name, so the file can
 * stay prose: a SHOUTING_SNAKE token in a list item, a table cell or a code
 * span counts, and a sentence does not. This mirrors `secretNamesIn()` in
 * `tests/lib/wrangler.ts`, which is what checks the same file at check time.
 */
export function secretNamesIn(markdown) {
  const out = new Set();
  // Byte-identical to `secretNamesIn()` in tests/lib/wrangler.ts. The check and
  // the upload must read the same file the same way, or a name could pass
  // `npm run check` and never be uploaded (or the reverse).
  for (const m of markdown.matchAll(/^\s*[-*|]?\s*`?([A-Z][A-Z0-9_]{2,})`?\s*(?:[-–—:|]|$)/gm)) out.add(m[1]);
  return [...out];
}

const info = describe(service, envName === 'production' ? '' : envName);
if (LIVE_WORKERS.has(info.name)) {
  console.error(`upload-secrets: "${info.name}" is a LIVE Worker (docs/WORKERS.md) — refusing. Workflows 7 and 8 own its secrets.`);
  process.exit(1);
}

const dir = join(ROOT, 'services', service);
const secretsMd = join(dir, 'SECRETS.md');
if (!existsSync(secretsMd)) {
  console.log(`upload-secrets: services/${service}/SECRETS.md does not exist — this service declares no secrets, nothing to upload`);
  process.exit(0);
}
const declared = secretNamesIn(readFileSync(secretsMd, 'utf8'));

const manifestPath = join(dir, 'OWNERSHIP.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const owned = new Set(manifest.secrets ?? []);
const undeclared = declared.filter((n) => !owned.has(n));
if (undeclared.length) {
  console.error(
    `upload-secrets: SECRETS.md names ${undeclared.join(', ')} but OWNERSHIP.json "secrets" does not declare them.\n` +
      '  A secret this service is not declared to hold is not uploaded — least privilege is the manifest, not the markdown.'
  );
  process.exit(1);
}

const prefix = `${service.toUpperCase().replace(/-/g, '_')}__`;
/** `ADS__DARK__` for `--env dark`; production reads the plain prefix only. */
const envPrefix = info.env && info.env !== 'production' ? `${prefix}${info.env.toUpperCase().replace(/-/g, '_')}__` : null;
const uploaded = [];
const skipped = [];
const envScoped = [];
for (const name of declared) {
  const scoped = envPrefix ? process.env[`${envPrefix}${name}`] : undefined;
  const value = scoped || process.env[`${prefix}${name}`];
  if (!value) {
    skipped.push(name);
    continue;
  }
  if (scoped) envScoped.push(name);
  if (dryRun) {
    uploaded.push(name);
    continue;
  }
  // `--name` and NEVER `--env`: under legacy-env semantics wrangler appends the
  // environment to a name it is given and asks Cloudflare for `<name>-<env>`
  // (`docs/WORKERS.md`, `tests/workflowNaming.test.ts`). Say the Worker once.
  const args = ['--no-install', 'wrangler', 'secret', 'put', name, '-c', info.config, '--name', info.name];
  try {
    // The value goes in on stdin. It is never an argument and never printed.
    execFileSync('npx', args, { cwd: ROOT, input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    uploaded.push(name);
  } catch (e) {
    console.error(`upload-secrets: uploading ${name} to ${info.name} failed: ${String(e?.message ?? e).split('\n')[0]}`);
    process.exit(1);
  }
}

console.log(
  `upload-secrets [${service}/${info.env}] ${info.name}: ` +
    `${dryRun ? 'would upload' : 'uploaded'} ${uploaded.length ? uploaded.join(', ') : 'none'}` +
    (envScoped.length ? ` · from ${envPrefix}<NAME>: ${envScoped.join(', ')}` : '') +
    (skipped.length ? ` · left untouched (no ${prefix}<NAME> set): ${skipped.join(', ')}` : '')
);
