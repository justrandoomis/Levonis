#!/usr/bin/env node
/**
 * Carry a running Worker's plain-text vars forward across a deploy.
 *
 * WHY THIS EXISTS. `wrangler deploy` replaces a Worker's plain-text vars
 * WHOLESALE: any name not passed on the command line is deleted from the
 * running Worker. That has already cost this project a live outage —
 * `STORE_ROOT_DOMAIN` was set by the GitHub deploy and then dropped ~60 s later
 * by a Workers-Builds deploy that did not know the name, and merchant subdomain
 * resolution went with it (`scripts/prepare-deploy-config.mjs` header).
 *
 * The logic lived inside `prepare-deploy-config.mjs`, which only ever runs
 * inside Cloudflare Workers Builds. `02-MIGRATION-PLAN.md` §11.6 and §12 ask
 * for it as a module so `_deploy-worker.yml` can use the same rule for every
 * new Worker — `prepare-deploy-config.mjs` now imports it, so the two cannot
 * drift.
 *
 * Values are never printed. The CLI writes `name<TAB>value` lines for the
 * workflow to mask and pass back as `--var`, and the human-readable output on
 * stderr is NAMES ONLY.
 *
 *   node scripts/lib/preserve-vars.mjs --worker levonis-audit-dark > /tmp/vars.tsv
 *   node scripts/lib/preserve-vars.mjs --worker <name> --allow-missing   # a first deploy
 */

/**
 * Read the plain-text vars currently set on a deployed Worker.
 *
 * Returns `null` when the settings could not be read at all (no credentials,
 * network failure, or the API answering an error) and `{}` when the Worker
 * simply does not exist yet. The distinction is the whole point: a caller must
 * be able to refuse to deploy blind, while still allowing a first deploy.
 */
export async function liveVars(scriptName, opts = {}) {
  const token = opts.token ?? process.env.CLOUDFLARE_API_TOKEN;
  const account = opts.account ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const doFetch = opts.fetch ?? fetch;
  if (!token || !account) return null;
  let res;
  try {
    res = await doFetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${scriptName}/settings`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {
    return null;
  }
  // 404 = the Worker has never been deployed. That is not a failure to read;
  // it is a first deploy, and it has no vars to lose.
  if (res.status === 404) return {};
  if (!res.ok) return null;
  let body;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (body && body.success === false) return null;
  const out = {};
  for (const b of body?.result?.bindings ?? []) {
    if (b?.type === 'plain_text' && typeof b.name === 'string' && typeof b.text === 'string') out[b.name] = b.text;
  }
  return out;
}

/**
 * Merge the three sources in the order the deploys have always used:
 * an explicit value wins, then whatever is live on the Worker, then the
 * (usually empty) value the config declares.
 *
 * EVERY live name is considered, not only the ones the config happens to
 * declare — that gap is exactly what erased `STORE_ROOT_DOMAIN`.
 */
export function mergeVars(configVars = {}, live = null, overrides = {}) {
  const vars = { ...configVars };
  const preserved = [];
  const overridden = [];
  const names = new Set([...Object.keys(vars), ...Object.keys(live ?? {})]);
  for (const key of names) {
    if (overrides[key]) {
      vars[key] = overrides[key];
      overridden.push(key);
    } else if (!vars[key] && live && live[key]) {
      vars[key] = live[key];
      preserved.push(key);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value && vars[key] === undefined) {
      vars[key] = value;
      overridden.push(key);
    }
  }
  const empty = Object.entries(vars)
    .filter(([, v]) => !v)
    .map(([k]) => k)
    .sort();
  return { vars, preserved: preserved.sort(), overridden: [...new Set(overridden)].sort(), empty };
}

/** `name<TAB>value` lines, one per var, sorted so a diff of two runs is readable. */
export function toTsv(vars) {
  return Object.keys(vars)
    .sort()
    .map((name) => `${name}\t${vars[name]}`)
    .join('\n');
}

// --------------------------------------------------------------------- CLI
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const worker = arg('--worker');
  if (!worker) {
    console.error('preserve-vars: --worker <name> is required');
    process.exit(2);
  }
  const live = await liveVars(worker);
  if (live === null) {
    console.error(
      `preserve-vars: could not read the vars of "${worker}".\n` +
        '  Refusing to print an empty set: deploying with it would WIPE every var on the running Worker.\n' +
        '  (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID must be set and able to read Worker settings.)'
    );
    process.exit(1);
  }
  const names = Object.keys(live).sort();
  // stderr, so stdout stays a clean TSV. NAMES ONLY.
  console.error(
    names.length
      ? `preserve-vars: ${worker} currently has ${names.length} var(s): ${names.join(', ')}`
      : `preserve-vars: ${worker} has no plain-text vars yet (first deploy, or none set)`
  );
  const tsv = toTsv(live);
  if (tsv) process.stdout.write(`${tsv}\n`);
}
