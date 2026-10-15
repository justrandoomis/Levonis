#!/usr/bin/env node
/**
 * COST-PRIVACY PROBES, READ-ONLY — workflow 7's check that the live site serves
 * no cost to a stranger (owner decision 2, master plan §4.0, step S1).
 *
 * WHAT IT DOES. Reads every `scripts/live-cost-probes.d/*.json` file (one per
 * programme step, so parallel steps never edit the same file) and, for each
 * probe, issues ONE anonymous GET against the live site:
 *
 *   {"vars":  {"slug": {"from": "/api/products?limit=1&price=1-", "pick": "products.0.slug"}},
 *    "probes":[{"path": "/api/products/{slug}", "status": [200],
 *               "forbidKeys": "regex", "forbidPattern": "regex",
 *               "requirePriceKeys": ["price_iqd"]}]}
 *
 *   status              the answer must be one of these codes
 *   forbidKeys          no JSON key anywhere in the body may match (case-insensitive)
 *   forbidPattern       the raw body text may not match
 *   requireIntegerKeys  every key named here must appear at least once, and
 *                       every occurrence must be an integer (critique G-36: a
 *                       probe that only says "no cost key" passes on an empty
 *                       body; the prices must actually be there)
 *   valuePatterns       {"key": "regex"}: wherever the key appears, its value is
 *                       null or a string matching the regex (FX plan §8: the
 *                       one public FX figure, `displayUsdRate`, is decimal
 *                       text or null — never a number, an object or a list).
 *                       An absent key passes: a database without a rate.
 *                       The failure names the key and the type, never the value
 *   vars                `{name}` placeholders, filled from an earlier anonymous
 *                       GET (a live slug, so no probe names a product by hand),
 *                       or from the command line (`--var name=value`, which
 *                       wins). `"optional": true` (the clean start, DECISIONS
 *                       row 222): a probe whose optional var is legitimately
 *                       empty is SKIPPED with a notice, neither run nor failed —
 *                       an empty catalogue right after the cut-over is not a
 *                       leak. A var read by GET is empty only when that GET
 *                       answered 200 with JSON whose picked list is there and
 *                       empty (`products: []`); any other answer (no answer, a
 *                       status that is not 200, a body that is not JSON) is a
 *                       FAILED read, and it fails the run: a broken listing
 *                       must never pass as an empty one. A var with no `from`
 *                       (the workflow's `--var`) is empty when not given.
 *                       `ran === 0` still fails the run.
 *   requireWhenVar      "name" of an optional var: `requireIntegerKeys` and
 *                       `requirePriceKeys` hold only while that var has a
 *                       value. When it is legitimately empty (nothing priced
 *                       yet), the keys may be absent, but wherever they appear
 *                       they still follow integerKeys / priceKeys, and
 *                       forbidKeys / forbidPattern stay in force
 *   integerKeys         like requireIntegerKeys, without the presence rule:
 *                       every occurrence is an integer, an absent key passes
 *   forbidValues        {"key": "{var}"}: no occurrence of the key may carry
 *                       the filled value (a hidden product's slug must not be
 *                       in a search answer). The failure names the key and
 *                       where, never the value
 *   priceKeys           CATALOG-ONLY (DECISIONS rows 239-240; Bambu import
 *                       spec §K.1 D-1): a product may be SHOWN before it has
 *                       a price («السعر غير متوفر حالياً»). Every occurrence of
 *                       the key is an integer — or null, but ONLY on an object
 *                       that itself says `"price_status": "unpriced"`; and an
 *                       object that says so carries null, never a number (its
 *                       row still holds the archived dinar ladder). A null on
 *                       a priced object, or on one that says nothing, fails.
 *                       An absent key passes
 *   requirePriceKeys    priceKeys plus presence: the key appears at least once.
 *                       It replaces requireIntegerKeys on an answer that may
 *                       mix priced and unpriced products (a listing, a page)
 *   expectValues        {"path": literal}: the value at that dotted path (read
 *                       from the answer's root, as a var's `pick` is) must be
 *                       there and equal the literal — text, a number, a
 *                       boolean or null. `{"price_status": "unpriced",
 *                       "product.price_iqd": null}` proves a product page is
 *                       the unpriced one. The failure names the path, never
 *                       the value
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
 *   node scripts/live-cost-probes.mjs --var hidden_slug=x   (a var from the workflow)
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

/** Every key in a JSON value, at any depth, with the dotted path it sits at and the object that holds it. */
export function* walkKeys(value, path = '') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* walkKeys(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      yield { key, value: child, path: at, holder: value };
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

/** The `{name}` placeholders a probe needs (its path and its forbidValues). */
export function probeVars(probe) {
  const text = [probe.path, ...Object.values(probe.forbidValues ?? {})].join(' ');
  return [...String(text).matchAll(/\{([a-z_][a-z0-9_]*)\}/gi)].map((m) => m[1]);
}

/**
 * One var's GET answer → `{ value }`, `{ empty: true }` when the answer is a
 * 200 with JSON whose picked list is there and empty (`products.0.slug` over
 * `{"products": []}`: nothing is listed yet, the clean start), or `{ error }`
 * for anything else — a status that is not 200, a body that is not JSON, no
 * list at all, or a first item without the key. Only `empty` lets an optional
 * var's probes skip; an error is a failed read (it never names a value).
 */
export function readVar(def, status, text) {
  if (status !== 200) return { error: `status ${status}, expected 200` };
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: 'the answer is not JSON' };
  }
  const v = pick(body, def.pick);
  if (typeof v === 'string' && v) return { value: v };
  const parts = String(def.pick).split('.');
  const at = parts.findIndex((part) => /^\d+$/.test(part));
  if (at >= 0) {
    const list = at === 0 ? body : pick(body, parts.slice(0, at).join('.'));
    if (Array.isArray(list) && list.length === 0) return { empty: true };
  }
  return { error: `the answer has no ${def.pick}` };
}

/**
 * A var is legitimately empty when it has no value, it is optional, and
 * either nothing reads it (a workflow `--var` not given) or its GET proved
 * there is nothing to list (`empty` holds its name, see `readVar`).
 */
function isEmptyVar(name, vars, defs, empty) {
  if (typeof vars[name] === 'string' && vars[name] !== '') return false;
  const def = defs[name];
  return def?.optional === true && (!def.from || empty.has(name));
}

/**
 * One probe against the resolved vars: `{ path }` to run, `{ skip }` when an
 * OPTIONAL var it needs is legitimately empty (the clean start: no listed
 * product yet), or `{ error }` when a var is missing otherwise (a required
 * one, or an optional one whose read failed). A probe whose `requireWhenVar`
 * is legitimately empty runs as `{ path, probe, notice }`: `probe` is the one
 * to judge, its required integer and price keys allowed to be absent.
 */
export function planProbe(probe, vars, defs = {}, empty = new Set()) {
  const missing = probeVars(probe).filter((name) => typeof vars[name] !== 'string' || vars[name] === '');
  if (missing.length && missing.every((name) => isEmptyVar(name, vars, defs, empty))) return { skip: `skipped (nothing to probe yet: {${missing.join('}, {')}} has no value)` };
  let path;
  try {
    path = fillPath(probe.path, vars);
  } catch (err) {
    return { error: err.message };
  }
  const when = probe.requireWhenVar;
  const required = [...(probe.requireIntegerKeys ?? []), ...(probe.requirePriceKeys ?? [])];
  if (when && required.length && isEmptyVar(when, vars, defs, empty)) {
    const { requireIntegerKeys, requirePriceKeys, ...rest } = probe;
    const relaxed = { ...rest };
    if (requireIntegerKeys?.length) relaxed.integerKeys = [...(probe.integerKeys ?? []), ...requireIntegerKeys];
    if (requirePriceKeys?.length) relaxed.priceKeys = [...(probe.priceKeys ?? []), ...requirePriceKeys];
    return {
      path,
      probe: relaxed,
      notice: `nothing priced yet ({${when}} is empty): ${required.join(', ')} may be absent, and wherever present must follow ${requirePriceKeys?.length ? 'the price rule (an integer, or null on an unpriced object)' : 'the integer rule'}`,
    };
  }
  return { path };
}

/** `--var name=value` (repeatable) → { name: value }. */
export function cliVars(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--var' || !args[i + 1]) continue;
    const eq = args[i + 1].indexOf('=');
    if (eq > 0) out[args[i + 1].slice(0, eq)] = args[i + 1].slice(eq + 1);
  }
  return out;
}

/**
 * The verdict for one probe over one answer: a list of failure lines, empty
 * when it passed. Pure, so a test can feed it fixed bodies.
 */
export function judge(probe, status, text, vars = {}) {
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
  const integers = (name, required) => {
    let seen = 0;
    let bad = 0;
    for (const { key, value } of walkKeys(body)) {
      if (key !== name) continue;
      seen++;
      if (!Number.isSafeInteger(value)) bad++;
    }
    if (seen === 0 && required) failures.push(`required key ${name} is absent`);
    else if (bad > 0) failures.push(`${bad} of ${seen} ${name} value(s) are not integers`);
  };
  for (const name of probe.requireIntegerKeys ?? []) integers(name, true);
  for (const name of probe.integerKeys ?? []) integers(name, false);
  // Catalog-only (DECISIONS row 240): a price is an integer, or null on an object that says it is unpriced.
  const prices = (name, required) => {
    let seen = 0;
    let notInteger = 0;
    let nullOnPriced = 0;
    let numberOnUnpriced = 0;
    for (const { key, value, holder } of walkKeys(body)) {
      if (key !== name) continue;
      seen++;
      const unpriced = holder?.price_status === 'unpriced';
      if (value === null) {
        if (!unpriced) nullOnPriced++;
      } else if (!Number.isSafeInteger(value)) notInteger++;
      else if (unpriced) numberOnUnpriced++;
    }
    if (seen === 0 && required) failures.push(`required key ${name} is absent`);
    if (notInteger > 0) failures.push(`${notInteger} of ${seen} ${name} value(s) are neither integers nor null`);
    if (nullOnPriced > 0) failures.push(`${nullOnPriced} of ${seen} ${name} value(s) are null on an object not marked price_status: unpriced`);
    if (numberOnUnpriced > 0) failures.push(`${numberOnUnpriced} of ${seen} ${name} value(s) are a number on an object marked price_status: unpriced`);
  };
  for (const name of probe.requirePriceKeys ?? []) prices(name, true);
  for (const name of probe.priceKeys ?? []) prices(name, false);
  for (const [at, literal] of Object.entries(probe.expectValues ?? {})) {
    const got = body === undefined ? undefined : pick(body, at);
    if (got === undefined) failures.push(`expected key ${at} is absent`);
    else if (got !== literal) failures.push(`${at} does not equal the expected ${literal === null ? 'null' : typeof literal === 'string' ? 'text' : typeof literal}`);
  }
  for (const [name, template] of Object.entries(probe.forbidValues ?? {})) {
    const value = String(template).replace(/\{([a-z_][a-z0-9_]*)\}/gi, (w, v) => String(vars[v] ?? ''));
    if (!value) continue;
    for (const { key, value: got, path } of walkKeys(body)) {
      if (key === name && String(got) === value) failures.push(`forbidden value of key ${key} (at ${path})`);
    }
  }
  for (const [name, pattern] of Object.entries(probe.valuePatterns ?? {})) {
    const re = new RegExp(pattern);
    for (const { key, value, path } of walkKeys(body)) {
      if (key !== name || value === null) continue;
      if (typeof value !== 'string') failures.push(`${key} (at ${path}) is a ${Array.isArray(value) ? 'list' : typeof value}, expected text or null`);
      else if (!re.test(value)) failures.push(`${key} (at ${path}) does not match /${pattern}/`);
    }
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

/**
 * The whole run over the probe files, with `get(path)` → `{ status, text }`
 * (workflow 7 passes a live GET; the tests pass the local Worker). Returns
 * the counts; every line goes to `log`. Exported so a test runs exactly
 * what workflow 7 runs.
 */
export async function runProbes(files, get, fromCli = {}, log = console.log) {
  let failed = 0;
  let ran = 0;
  let skipped = 0;
  for (const { file, spec } of files) {
    const vars = { ...fromCli };
    const empty = new Set();
    for (const [name, def] of Object.entries(spec.vars ?? {})) {
      if (typeof vars[name] === 'string' && vars[name]) continue;
      if (!def.from) continue;
      let read;
      try {
        const r = await get(def.from);
        read = readVar(def, r.status, r.text);
      } catch (err) {
        read = { error: `no answer (${err?.name ?? 'error'})` };
      }
      if (read.value) {
        vars[name] = read.value;
      } else if (read.empty) {
        empty.add(name);
        log(`::notice::${file}: ${def.from} lists nothing yet, {${name}} is empty`);
      } else {
        // Not an empty catalogue: a broken listing must never pass as one.
        failed++;
        log(`::error::${file}: {${name}} could not be read from ${def.from} (${read.error})`);
      }
    }
    for (const probe of spec.probes ?? []) {
      const plan = planProbe(probe, vars, spec.vars ?? {}, empty);
      if (plan.skip) {
        skipped++;
        log(`::notice::${file}: ${probe.path} — ${plan.skip}`);
        continue;
      }
      if (plan.error) {
        failed++;
        log(`::error::${file}: ${probe.path} — ${plan.error}`);
        continue;
      }
      if (plan.notice) log(`::notice::${file}: ${probe.path} — ${plan.notice}`);
      const path = plan.path;
      ran++;
      let status = 0;
      let text = '';
      try {
        ({ status, text } = await get(path));
      } catch (err) {
        failed++;
        log(`::error::${file}: GET ${path} did not answer (${err?.name ?? 'error'})`);
        continue;
      }
      const failures = judge(plan.probe ?? probe, status, text, vars);
      if (failures.length) {
        failed++;
        for (const f of failures) log(`::error::${file}: GET ${path} — ${f}`);
      } else {
        log(`ok  GET ${path} -> ${status}`);
      }
    }
  }
  return { ran, failed, skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const base = flag('--base', 'https://levonis-iq.com');
  const dir = resolve(flag('--dir', join(HERE, 'live-cost-probes.d')));
  const { ran, failed, skipped } = await runProbes(loadProbeFiles(dir), (path) => get(base, path), cliVars(args));
  console.log(`${ran} probe(s) run, ${failed} failed${skipped ? `, ${skipped} skipped (nothing to probe yet)` : ''}`);
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
