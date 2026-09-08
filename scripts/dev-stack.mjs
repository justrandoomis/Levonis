#!/usr/bin/env node
/**
 * THE WHOLE DARK STACK, LOCALLY, IN ONE COMMAND.
 *
 * Six Workers — the gateway, the core and the four leaf consumers — inside one
 * workerd, wired to each other by REAL service bindings, against REAL local D1
 * databases. Nothing is uploaded, nothing is created on the Cloudflare account,
 * and no live Worker is touched: `wrangler dev` runs the code here.
 *
 * WHY THIS EXISTS. Each service already has a `dev/` rig that runs it beside a
 * stub. A stub cannot show what only the assembled stack does: an event
 * published inside a checkout batch in the CORE, pumped in `waitUntil`, fanned
 * out over four bindings, and idempotently recorded by four different
 * consumers, with a gateway in front of all of it. Every interesting failure in
 * Phase 1 has been of that kind — a `KeyRing` keyed by `kid` so one key
 * published under two names failed every envelope; `d1 migrations apply`
 * writing to a different state directory from `wrangler dev`, so every table
 * was missing and every health check still said `ok`.
 *
 * THE ONE THING TO GET RIGHT is `--persist-to`. `wrangler d1 migrations apply
 * --local` writes under the CONFIG's own directory unless it is told otherwise,
 * while `wrangler dev` opens its own state directory — so without a shared
 * `--persist-to` the migrations land somewhere the dev server never reads, and
 * `SELECT 1` works fine on an empty database. This script passes the same
 * directory to both, always.
 *
 *   node scripts/dev-stack.mjs                 # migrate, then run on :8799
 *   node scripts/dev-stack.mjs --print         # print the command and exit
 *   node scripts/dev-stack.mjs --no-migrate    # skip the migration pass
 *   node scripts/dev-stack.mjs --port 9100 --persist-to .wrangler/dark
 *   node scripts/dev-stack.mjs --primary core --test-scheduled
 *   node scripts/dev-stack.mjs --primary audit --set ALLOWED_CALLER_KIDS=core:<kid>:<pub>
 *
 * Then, in another shell:
 *   node scripts/e2e-dark.mjs --base http://localhost:8799
 *
 * THE SECOND THING TO GET RIGHT is WHICH Worker the flags reach. `wrangler dev`
 * hands the AUXILIARY configs only `--env` (see `setupDevEnv` in the CLI: every
 * config after the first is started with `{env, disableDevRegistry,
 * multiworkerPrimary}` and nothing else). So `--var`, `--test-scheduled` and
 * the port apply to the PRIMARY Worker only, and a rig that needs to drive one
 * service's HTTP surface, its cron, or a var it does not declare has to make
 * that service the primary — which is what `--primary` is for. The runtime,
 * the bindings and the persisted D1 files are shared, so the rest of the stack
 * is still real either way.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from './worker-name.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ORDER MATTERS: the FIRST config is the primary — it is what the port serves.
 * The gateway is first because the whole point of the stack is that a request
 * arrives at the gateway and leaves through a consumer. Every other config is
 * reachable from it by service NAME, which is how the bindings resolve.
 */
export const STACK = [
  { service: 'gateway', why: 'the front door: every request from a client enters here' },
  { service: 'core', why: 'the legacy monolith, dark twin; the gateway forwards to it' },
  { service: 'audit', why: 'consumer' },
  { service: 'analytics', why: 'consumer' },
  { service: 'ads', why: 'consumer' },
  { service: 'notifications', why: 'consumer' },
];

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);
/** Every occurrence of a repeatable flag, in order. */
const all = (flag) =>
  process.argv.reduce((out, a, i) => (a === flag && process.argv[i + 1] ? [...out, process.argv[i + 1]] : out), []);

if (has('--remote')) {
  console.error(
    'dev-stack: --remote would run this against the real Cloudflare account.\n' +
      '  This script is local only. Deploying or reaching the account is an owner-gated action.'
  );
  process.exit(1);
}

const port = arg('--port', '8799');
const persistTo = arg('--persist-to', '.wrangler/dark');
const rootDomain = arg('--root-domain', 'levonis-dark.local');
const primary = arg('--primary', 'gateway');
/** `--set NAME=VALUE`, repeatable. Reaches the PRIMARY Worker only — see the header. */
const sets = all('--set');

if (!STACK.some((s) => s.service === primary)) {
  console.error(`dev-stack: --primary ${primary} is not in the stack (${STACK.map((s) => s.service).join(', ')})`);
  process.exit(1);
}
for (const s of sets) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    console.error(`dev-stack: --set expects NAME=VALUE, got ${s.split('=')[0]}=…`);
    process.exit(1);
  }
}

/** Everything the stack needs, resolved from the configs rather than hard-coded. */
export function plan(primaryService = 'gateway') {
  const ordered = [...STACK].sort((a, b) => Number(b.service === primaryService) - Number(a.service === primaryService));
  return ordered.map(({ service, why }) => {
    const info = describe(service, 'dark');
    return { ...info, why: service === primaryService ? `PRIMARY (the port serves it; --var and --test-scheduled reach it) — ${why}` : why };
  });
}

const parts = plan(primary);

// ------------------------------------------------------------------- checks
const missing = parts.filter((p) => !existsSync(join(ROOT, p.config)));
if (missing.length) {
  console.error(`dev-stack: missing config(s): ${missing.map((m) => m.config).join(', ')}`);
  process.exit(1);
}
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error(
    'dev-stack: dist/ has no index.html. The dark core serves the SPA from it, and workerd will refuse the assets block.\n' +
      '  Run `npm run build` first.'
  );
  process.exit(1);
}

const configArgs = parts.flatMap((p) => ['-c', p.config]);
const devCommand = [
  'wrangler', 'dev',
  ...configArgs,
  '--env', 'dark',
  '--port', port,
  '--persist-to', persistTo,
  // Without a root domain every hostname classifies as `foreign`, and the
  // apex/storefront distinction the gateway exists for cannot be exercised.
  // Both names are declared by the gateway AND by the core, so whichever of
  // the two is primary reads them; a config that does not declare a name
  // simply ignores the override.
  '--var', `STORE_ROOT_DOMAIN:${rootDomain}`,
  '--var', `APP_ORIGIN:http://localhost:${port}`,
  ...sets.flatMap((s) => ['--var', s.replace('=', ':')]),
  ...(has('--test-scheduled') ? ['--test-scheduled'] : []),
];

if (has('--print')) {
  console.log(`# the whole dark stack, one workerd, no account touched (primary: ${primary}):`);
  console.log(`npx ${devCommand.join(' ')}`);
  console.log('\n# what each config is:');
  for (const p of parts) console.log(`#   ${p.config.padEnd(38)} ${p.name.padEnd(28)} ${p.why}`);
  process.exit(0);
}

// --------------------------------------------------------------- migrations
if (!has('--no-migrate')) {
  mkdirSync(join(ROOT, persistTo), { recursive: true });
  for (const p of parts) {
    for (const db of p.d1) {
      if (!db.migrations_dir) continue;
      process.stdout.write(`dev-stack: migrating ${db.database_name} (${p.service}) … `);
      const res = spawnSync(
        'npx',
        [
          '--no-install', 'wrangler', 'd1', 'migrations', 'apply', db.database_name,
          '--local', '--persist-to', persistTo, '-c', p.config, '--env', 'dark',
        ],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      if (res.status !== 0) {
        console.log('FAILED');
        console.error(res.stderr || res.stdout);
        console.error(
          `dev-stack: could not migrate ${db.database_name}.\n` +
            '  The rig is useless without it: SELECT 1 succeeds on an empty database, so every\n' +
            '  health check would still say ok while every table was missing.'
        );
        process.exit(1);
      }
      const applied = /Applied (\d+)/.exec(res.stdout)?.[1] ?? /(\d+) migration/.exec(res.stdout)?.[1] ?? 'up to date';
      console.log(typeof applied === 'string' && applied === 'up to date' ? 'up to date' : `${applied} applied`);
    }
  }
}

// ---------------------------------------------------------------------- run
console.log(`\ndev-stack: ${parts.length} Workers on http://localhost:${port} (state in ${persistTo})`);
for (const p of parts) console.log(`  ${p.name.padEnd(28)} ${p.config}`);
console.log(`\n  drive it:  node scripts/e2e-dark.mjs --base http://localhost:${port}\n`);

const child = spawn('npx', ['--no-install', ...devCommand], { cwd: ROOT, stdio: 'inherit' });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
