#!/usr/bin/env node
/**
 * Prove that the Worker a deploy just produced is actually answering, and that
 * the answer comes from the commit that was deployed (`01-TARGET.md` §11.3,
 * `02-MIGRATION-PLAN.md` §12).
 *
 * THREE WAYS TO REACH A WORKER, and the script never guesses between them:
 *
 *  - `--base <url>`  a URL the caller knows: the dark zone for the dark core
 *    and dark gateway, a `*.workers.dev` URL for a dark leaf. `GET <base>/health`
 *    (or `/api/health` for the core, which keeps the legacy shape).
 *  - `--deep <origin>`  a PRODUCTION Worker has `workers_dev:false` and
 *    therefore NO URL of its own. Its probe goes through the gateway (until G3:
 *    the core) at `GET <origin>/api/health?deep=1` with the `x-health-probe`
 *    header, which fans `health()` out over every bound service. The service
 *    must appear in that fan-out and report `ok`.
 *  - `--unbound`  a Worker that is deployed but bound nowhere yet (plan 2.1
 *    before G2) has neither. This is not health: the script says so, prints the
 *    `wrangler tail` command that IS the evidence, and exits non-zero unless
 *    `--accept-unprobeable` says the caller understands that.
 *
 * WHY IT IS THIS STRICT. A green deploy step that proved nothing is the exact
 * failure this repository keeps closing (`scripts/check-studio.mjs`,
 * `scripts/test-workspaces.mjs`, the "errors=not captured" gate in
 * `verify-live-auth.yml`). "Could not look" is never "healthy".
 *
 * The probe token is read from the environment and never printed.
 *
 *   node scripts/probe-health.mjs --service audit --env dark --base https://levonis-audit-dark.<sub>.workers.dev
 *   node scripts/probe-health.mjs --service audit --env production --deep https://levonis-iq.com
 */
import { describe } from './worker-name.mjs';

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const has = (flag) => process.argv.includes(flag);

const service = arg('--service');
const envName = arg('--env', 'dark');
const base = (arg('--base', process.env.PROBE_BASE_URL) || '').replace(/\/$/, '');
const deep = (arg('--deep', process.env.PROBE_DEEP_ORIGIN) || '').replace(/\/$/, '');
const expectVer = arg('--expect-ver', process.env.PROBE_EXPECT_VER || '');
const timeoutMs = Number(arg('--timeout-ms', '10000'));

if (!service) {
  console.error('usage: node scripts/probe-health.mjs --service <name> --env <dark|production> [--base <url> | --deep <origin> | --unbound]');
  process.exit(2);
}
const info = describe(service, envName === 'production' ? '' : envName);

const fail = (msg) => {
  console.error(`probe-health [${service}/${info.env}] ${info.name}: ${msg}`);
  process.exit(1);
};

async function get(url, headers = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the text: a non-JSON body is itself the diagnosis */
    }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(t);
  }
}

/** `{ok:…}` for a service, `{success:true,…}` for the core's legacy shape. */
const isOk = (b) => b?.ok === true || b?.success === true;

if (has('--unbound')) {
  console.error(
    `probe-health [${service}/${info.env}] ${info.name} is deployed but bound nowhere and has no URL, so there is nothing to probe.\n` +
      `  The evidence for this state is one scheduled run:\n` +
      `      npx wrangler tail --name ${info.name} --format pretty\n` +
      `  and a cron tick within a minute. This step is NOT health.`
  );
  process.exit(has('--accept-unprobeable') ? 0 : 1);
}

if (!base && !deep) {
  fail(
    'no way to reach it was given.\n' +
      '  --base <url>   a URL it answers on (the dark zone, or its workers.dev URL)\n' +
      '  --deep <origin>  the gateway/core origin whose /api/health?deep=1 fans out to it\n' +
      '  --unbound      it is deployed but bound nowhere yet (not health; see --accept-unprobeable)\n' +
      '  Refusing to report health for a Worker nobody looked at.'
  );
}

if (base) {
  // The core keeps the legacy `/api/health` shape (§3.3); every service Worker
  // answers `/health` on its own URL.
  const path = service === 'core' ? '/api/health' : '/health';
  let res;
  try {
    res = await get(`${base}${path}`);
  } catch (e) {
    fail(`GET ${base}${path} failed: ${String(e?.message ?? e)}`);
  }
  if (res.status !== 200) fail(`GET ${base}${path} answered ${res.status}: ${res.text.slice(0, 200)}`);
  if (!isOk(res.body)) fail(`GET ${base}${path} answered 200 but not healthy: ${res.text.slice(0, 300)}`);
  const checks = res.body?.checks ?? {};
  if (checks.db && checks.db !== 'ok') fail(`its database check says "${checks.db}"`);
  if (expectVer && res.body?.ver && res.body.ver !== expectVer) {
    fail(`it reports ver "${res.body.ver}" but this deploy shipped "${expectVer}" — the probe reached an older deployment`);
  }
  console.log(
    `probe-health [${service}/${info.env}] ${info.name}: ok at ${base}${path}` +
      (res.body?.ver ? ` (ver ${res.body.ver})` : '') +
      (checks.db ? ` · db ${checks.db}` : '') +
      (checks.outbox_lag_s !== undefined ? ` · outbox_lag_s ${checks.outbox_lag_s}` : '')
  );
  process.exit(0);
}

// ------------------------------------------------------------- deep fan-out
const token = process.env.HEALTH_PROBE_TOKEN;
if (!token) {
  fail('a deep probe needs HEALTH_PROBE_TOKEN in the environment (constant-time compared by the gateway; never printed).');
}
let res;
try {
  res = await get(`${deep}/api/health?deep=1`, { 'x-health-probe': token });
} catch (e) {
  fail(`GET ${deep}/api/health?deep=1 failed: ${String(e?.message ?? e)}`);
}
if (res.status !== 200) fail(`the deep health fan-out answered ${res.status}: ${res.text.slice(0, 200)}`);
const deps = res.body?.services ?? res.body?.checks?.deps ?? res.body?.deps;
if (!deps) fail(`the deep health response carries no per-service section: ${res.text.slice(0, 300)}`);
const entry = Array.isArray(deps) ? deps.find((d) => d?.svc === service || d?.service === service) : deps[service];
if (!entry) {
  fail(
    `the fan-out did not include "${service}" — it is not bound to the Worker at ${deep} yet.\n` +
      '  That is a real finding, not a probe problem: an unbound Worker receives nothing.'
  );
}
if (!isOk(entry) && entry?.ok !== undefined) fail(`"${service}" reported unhealthy in the fan-out: ${JSON.stringify(entry).slice(0, 300)}`);
if (expectVer && entry?.ver && entry.ver !== expectVer) {
  fail(`"${service}" reports ver "${entry.ver}" but this deploy shipped "${expectVer}"`);
}
console.log(`probe-health [${service}/${info.env}] ${info.name}: ok through ${deep}/api/health?deep=1${entry?.ver ? ` (ver ${entry.ver})` : ''}`);
