/**
 * NOTHING SCHEDULED FOR THE CATALOGUE IMPORT (Bambu import spec §A.9, R11:
 * "no cron, trigger, webhook or Worker binding"; DECISIONS row 241).
 *
 *   1. The wrangler.jsonc crons are the three the Worker already had, in every
 *      environment, and no environment declares a queue, a workflow or a
 *      Durable Object for the import.
 *   2. The `scheduled()` handler of worker/index.ts names nothing of the import,
 *      nor does the cron table it dispatches through.
 *   3. The import's code (worker/lib/catalogImport/*, its two routers) is
 *      reachable only through worker/index.ts's route mounts: no other Worker
 *      module imports it, so no cron path can run it. The one Worker-wide reader
 *      of an import table that a sweep runs is the media reference registry
 *      (worker/lib/mediaRefs.ts reads catalog_import_media.r2_key so a staged
 *      image survives a long block, §B.9) — a reference, never an import step.
 *      The one other reader of the import's code is the owner's estimator
 *      (docs/SMART_PRICING.md §3.8 step 3): it reads a product's reviewed
 *      manifest subtype through the import's own validated reader,
 *      `currentReviewedBundle`, and is itself reachable only through the
 *      owner's estimates router inside the pricing router — a route mount,
 *      never a cron path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ROOT } from './fixtures/d1';

const IMPORT = /catalog[_-]?import/i;
const CRONS = ['*/15 * * * *', '* * * * *', '0 */6 * * *'];

/** wrangler.jsonc without its comments (JSONC → JSON). */
function wrangler(): Record<string, unknown> {
  const text = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i];
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

test('the crons are the three the Worker had, in every environment; no queue, workflow or Durable Object for the import', () => {
  const cfg = wrangler();
  const envs: Array<[string, Record<string, unknown>]> = [['top', cfg], ...Object.entries((cfg.env ?? {}) as Record<string, Record<string, unknown>>)];
  for (const [name, env] of envs) {
    const crons = ((env.triggers ?? {}) as { crons?: string[] }).crons;
    assert.deepEqual(crons, CRONS, `${name}: the crons`);
    for (const key of ['queues', 'workflows', 'durable_objects']) {
      assert.ok(!IMPORT.test(JSON.stringify(env[key] ?? null)), `${name}: no ${key} for the import`);
    }
  }
});

test('the scheduled() handler and its cron table name nothing of the import', () => {
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  const at = index.indexOf('  scheduled(');
  assert.ok(at > 0, 'worker/index.ts has its scheduled handler');
  // The handler's body: up to the next member of the exported object at the same indentation.
  const rest = index.slice(at);
  const end = rest.slice(1).search(/\n {2}[a-zA-Z_]+\s*\(|\n\};/);
  const body = rest.slice(0, end < 0 ? rest.length : end + 1);
  assert.ok(body.length > 200, 'the scan reads the handler');
  assert.doesNotMatch(body, IMPORT);
  assert.doesNotMatch(readFileSync(join(ROOT, 'worker/lib/cronSchedules.ts'), 'utf8'), IMPORT);
  // Every line of worker/index.ts that names the import is an import of a router or its mount.
  for (const line of index.split('\n').filter((l) => IMPORT.test(l))) {
    assert.match(line, /^(import \{ (catalogImportOpsRoutes|adminCatalogImportRoutes) \} from '\.\/routes\/(catalogImportOps|adminCatalogImport)';|app\.route\('\/api\/(ops|admin)\/catalog-import', (catalogImportOpsRoutes|adminCatalogImportRoutes)\);|\/\/.*)$/, line);
  }
});

test('the import\'s code is reachable only through the two route mounts: no other Worker module imports it', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (name.endsWith('.ts')) out.push(p);
    }
    return out;
  };
  const own = (f: string) => f.startsWith('worker/lib/catalogImport/') || f === 'worker/routes/catalogImportOps.ts' || f === 'worker/routes/adminCatalogImport.ts' || f === 'worker/index.ts';
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'worker'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (own(rel)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) if (/catalogImport|CatalogImport/.test(m[1])) offenders.push(`${rel} imports ${m[1]}`);
  }
  // The estimator's one read of the import (docs/SMART_PRICING.md §3.8 step 3): a product's reviewed manifest
  // subtype, through the import's own validated reader — a read of the bundled data, never an import step.
  const ESTIMATOR = 'worker/lib/pricingEngine/estimate/classify.ts';
  const ESTIMATOR_READ = `${ESTIMATOR} imports ../../catalogImport/bundle`;
  assert.deepEqual(offenders.filter((o) => o !== ESTIMATOR_READ), []);
  const source = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
  // That read takes the reader and nothing else of the import…
  const names = [...source(ESTIMATOR).matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/\.\.\/catalogImport\/bundle'/g)].flatMap((m) =>
    m[1]!.split(',').map((x) => x.trim()).filter(Boolean)
  );
  assert.deepEqual(names, ['currentReviewedBundle'], 'the estimator reads the reviewed manifest and nothing else of the import');
  // …and the estimator is reachable only through the owner's estimates router, which only the pricing router
  // mounts: a route mount again, never a cron path.
  const workerFiles = walk(join(ROOT, 'worker')).map((f) => relative(ROOT, f).split(sep).join('/'));
  const estimatorDoors = workerFiles.filter((f) => !f.startsWith('worker/lib/pricingEngine/estimate/') && /from\s+'[^']*pricingEngine\/estimate\/[^']+'/.test(source(f)));
  assert.deepEqual(estimatorDoors, ['worker/routes/adminPriceEstimates.ts'], 'the estimator has one door');
  const routerMounts = workerFiles.filter((f) => /from\s+'[^']*\/adminPriceEstimates'/.test(source(f)));
  assert.deepEqual(routerMounts, ['worker/routes/adminPricing.ts'], 'the estimates router is mounted only inside the owner pricing router');
  const index = source('worker/index.ts');
  const rest = index.slice(index.indexOf('  scheduled('));
  const end = rest.slice(1).search(/\n {2}[a-zA-Z_]+\s*\(|\n\};/);
  assert.doesNotMatch(rest.slice(0, end < 0 ? rest.length : end + 1), /adminPricing|pricingEngine\/estimate/, 'the scheduled handler reaches no estimator');
  assert.doesNotMatch(source('worker/lib/cronSchedules.ts'), /adminPricing|pricingEngine\/estimate/, 'nor does its cron table');
});
