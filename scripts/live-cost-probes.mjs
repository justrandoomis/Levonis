#!/usr/bin/env node
/**
 * COST-PRIVACY PROBES, READ-ONLY — workflow 7's check that the live site serves
 * no cost to a stranger (owner decision 2, master plan §4.0, step S1).
 *
 * WHAT IT DOES. Reads every `scripts/live-cost-probes.d/*.json` file (one per
 * programme step, so parallel steps never edit the same file) and, for each
 * probe, issues ONE anonymous GET against the live site:
 *
 *   {"vars":  {"slug": {"from": "/api/products?limit=1", "pick": "products.0.slug"}},
 *    "probes":[{"path": "/api/products/{slug}", "status": [200],
 *               "forbidKeys": "regex", "forbidPattern": "regex",
 *               "requireIntegerKeys": ["price_iqd"]}]}
 *
 *   status              the answer must be one of these codes
 *   forbidKeys          no JSON key anywhere in the body may match (case-insensitive)
 *   forbidPattern       the raw body text may not match
 *   requireIntegerKeys  every key named here must appear at least once, and
 *                       every occurrence must be an integer (critique G-36: a
 *                       probe that only says "no cost key" passes on an empty
 *                       body; the prices must actually be there)
 *   vars                `{name}` placeholders, filled from an earlier anonymous
 *                       GET (a live slug, so no probe names a product by hand)
 *
 * WHAT IT NEVER DOES. No cookie, no token, no write, no method but GET, no
 * redirect followed (a redirect is reported as its own status). Nothing it
 * touches changes production data.
 *
 * A failed probe fails the step, and the run says which path, which status and
 * which key — never a value, because a value is exactly what must not be in a
 * log.
 *
 *   node scripts/live-cost-probes.mjs                       (https://levonis-iq.com)
 *   node scripts/live-cost-probes.mjs --base https://…      (another origin)
 *   node scripts/live-cost-probes.mjs --dir path/to/probes  (another probe folder)
 *
 * NO OWNER-ROW CHECK (DECISIONS row 185 amendment, 2026-10-08). The deploy no
 * longer reads the users table: an owner whose address is not verified yet is
 * refused cost with OWNER_EMAIL_UNVERIFIED and verifies from the admin
 * screens, so there is nothing to stop a deploy for.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Every key in a JSON value, at any depth, with the dotted path it sits at. */
export function* walkKeys(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walkKeys(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      yield { key, value: child, path: at };
      yield* walkKeys(child, at);
    }
  }
}

/** `products.0.slug` → value, or undefined. */
export function pick(value, dotted) {
  let cur = value;
  for (const part of String(dotted).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

/** Fills `{name}` placeholders; refuses a probe whose variable could not be resolved. */
export function fillPath(path, vars) {
  return String(path).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (whole, name) => {
    const v = vars[name];
    if (typeof v !== 'string' || v === '') throw new Error(`variable {${name}} has no value`);
    return encodeURIComponent(v);
  });
}

/**
 * The verdict for one probe over one answer: a list of failure lines, empty
 * when it passed. Pure, so a test can feed it fixed bodies.
 */
export function judge(probe, status, text) {
  const failures = [];
  const allowed = Array.isArray(probe.status) && probe.status.length ? probe.status : [200];
  if (!allowed.includes(status)) failures.push(`status ${status}, expected ${allowed.join(' or ')}`);
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (probe.forbidKeys) {
    const re = new RegExp(probe.forbidKeys, 'i');
    const hits = new Set();
    for (const { key, path } of walkKeys(body)) if (re.test(key)) hits.add(`${key} (at ${path})`);
    for (const hit of [...hits].slice(0, 10)) failures.push(`forbidden key ${hit}`);
    if (hits.size > 10) failures.push(`… and ${hits.size - 10} more forbidden keys`);
  }
  if (probe.forbidPattern && new RegExp(probe.forbidPattern, 'i').test(text ?? '')) {
    failures.push(`the body matches the forbidden pattern /${probe.forbidPattern}/i`);
  }
  for (const name of probe.requireIntegerKeys ?? []) {
    let seen = 0;
    let bad = 0;
    for (const { key, value } of walkKeys(body)) {
      if (key !== name) continue;
      seen++;
      if (!Number.isSafeInteger(value)) bad++;
    }
    if (seen === 0) failures.push(`required key ${name} is absent`);
    else if (bad > 0) failures.push(`${bad} of ${seen} ${name} value(s) are not integers`);
  }
  return failures;
}

/** Every probe file, in name order. */
export function loadProbeFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, spec: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
}

async function get(base, path) {
  const res = await fetch(new URL(path, base), {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/json', 'user-agent': 'levonis-live-cost-probes/1 (read-only)' },
    signal: AbortSignal.timeout(25_000),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const base = flag('--base', 'https://levonis-iq.com');
  const dir = resolve(flag('--dir', join(HERE, 'live-cost-probes.d')));
  const files = loadProbeFiles(dir);
  let failed = 0;
  let ran = 0;
  for (const { file, spec } of files) {
    const vars = {};
    for (const [name, def] of Object.entries(spec.vars ?? {})) {
      try {
        const r = await get(base, def.from);
        const v = pick(JSON.parse(r.text), def.pick);
        if (typeof v === 'string' && v) vars[name] = v;
        else console.log(`::warning::${file}: {${name}} could not be read from ${def.from} (status ${r.status})`);
      } catch (err) {
        console.log(`::warning::${file}: {${name}} could not be read from ${def.from} (${err?.name ?? 'error'})`);
      }
    }
    for (const probe of spec.probes ?? []) {
      let path;
      try {
        path = fillPath(probe.path, vars);
      } catch (err) {
        failed++;
        console.log(`::error::${file}: ${probe.path} — ${err.message}`);
        continue;
      }
      ran++;
      let status = 0;
      let text = '';
      try {
        ({ status, text } = await get(base, path));
      } catch (err) {
        failed++;
        console.log(`::error::${file}: GET ${path} did not answer (${err?.name ?? 'error'})`);
        continue;
      }
      const failures = judge(probe, status, text);
      if (failures.length) {
        failed++;
        for (const f of failures) console.log(`::error::${file}: GET ${path} — ${f}`);
      } else {
        console.log(`ok  GET ${path} -> ${status}`);
      }
    }
  }
  console.log(`${ran} probe(s) run, ${failed} failed`);
  if (ran === 0) {
    console.log('::error::no probe ran — an empty probe set proves nothing');
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.log(`::error::the cost-privacy probes crashed: ${err?.message ?? err}`);
    process.exit(1);
  });
}
