/**
 * The bundle budget (`01-TARGET.md` §10, `02-MIGRATION-PLAN.md` slice 1.8).
 *
 * §10 sets two numbers: **350 KB gzip for the entry chunk** and **250 KB for
 * any route chunk**, against a starting point of 2.96 MB raw / 817 KB gzip in
 * one file. Route-level `React.lazy` (`src/App.tsx`, `src/pages/Admin.tsx`) and
 * the `manualChunks` groups in `vite.config.ts` are what get there.
 *
 * THIS FILE MEASURES THREE THINGS, AND THE THIRD IS THE ONE THAT MATTERS MOST.
 *
 *  1. the entry chunk, and every chunk, against §10's numbers;
 *  2. that the split actually happened — every page and panel §10 names has a
 *     chunk of its own. A size test alone can be satisfied by moving code into
 *     a chunk the entry then statically imports, which improves nothing;
 *  3. **the initial payload**: the entry plus the transitive closure of its
 *     STATIC imports, which is what a browser downloads before it can render
 *     anything. A vendor chunk that the entry statically imports is part of the
 *     first byte no matter what the chunk list says, and grouping a lazy-only
 *     library with an eager one silently moves it into that closure — which is
 *     precisely what happened while this slice was being written: `ogl`,
 *     grouped with `motion` as §10 suggests, turned the model viewer's WebGL
 *     renderer into a static dependency of the home page.
 *
 * Gzip, not raw: gzip is what is transferred, and it is the number §10 states.
 *
 * The suite FAILS when `dist/` is missing rather than skipping. A budget test
 * that quietly passes because nobody built the site is the failure mode this
 * repository keeps closing (`scripts/check-studio.mjs`,
 * `scripts/test-workspaces.mjs`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');

const KB = 1024;
/** §10: the entry chunk. */
const ENTRY_BUDGET = 350 * KB;
/** §10: any single route chunk. */
const CHUNK_BUDGET = 250 * KB;
/**
 * The entry plus everything it statically imports. §10 does not name this
 * number, so it is set here with headroom over what the slice measured
 * (406 KB gzip) — big enough that ordinary work does not trip it, small enough
 * that moving a lazy-only library into the eager closure does.
 */
const INITIAL_BUDGET = 470 * KB;
/** Every stylesheet together; the entry's is the one downloaded before first paint. */
const CSS_BUDGET = 60 * KB;

const gz = (path: string) => gzipSync(readFileSync(path), { level: 9 }).length;
const kb = (n: number) => `${(n / KB).toFixed(1)} KB`;

/**
 * The STATIC imports of a built chunk. `import"./x.js"` and `from"./x.js"` are
 * static; `import("./x.js")` is dynamic and is exactly what must NOT count —
 * a lazy route is a dynamic import, and counting it would make every chunk
 * part of the initial payload.
 */
export function staticImports(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/(?:^|[^A-Za-z0-9_$.])(?:import|from)\s*["'](\.\/[^"']+\.js)["']/g)) out.add(m[1].slice(2));
  return [...out];
}

/** The entry chunk, read from index.html rather than guessed from a file name. */
export function entryFromHtml(html: string): string | null {
  const m = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/.exec(html) ?? /<script[^>]+src="\/assets\/([^"]+\.js)"[^>]+type="module"/.exec(html);
  return m?.[1] ?? null;
}

test('the static-import parser counts a static import and never a dynamic one', () => {
  const code = 'import{a}from"./vendor-react-x.js";import"./side-y.js";const p=import("./Admin-z.js");export{a}from"./re-w.js";';
  assert.deepEqual(staticImports(code).sort(), ['re-w.js', 'side-y.js', 'vendor-react-x.js']);
  assert.equal(entryFromHtml('<script type="module" crossorigin src="/assets/index-abc.js"></script>'), 'index-abc.js');
});

test('dist/ exists — this suite measures the real build, and refuses to pass without one', () => {
  assert.ok(
    existsSync(ASSETS),
    'dist/assets is missing. Run `npm run build` first: a budget that passes because nothing was built proves nothing.'
  );
});

test('the entry chunk is under 350 KB gzip and every chunk is under 250 KB', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 5, `only ${files.length} chunk(s) — the code splitting is not happening`);
  const entry = entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'));
  assert.ok(entry, 'index.html names no module entry script');
  assert.ok(files.includes(entry!), `index.html points at ${entry}, which dist/assets does not contain`);

  const entryBytes = gz(join(ASSETS, entry!));
  const oversize = files
    .map((f) => ({ f, bytes: gz(join(ASSETS, f)) }))
    .filter((x) => x.bytes > (x.f === entry ? ENTRY_BUDGET : CHUNK_BUDGET))
    .map((x) => `${x.f}: ${kb(x.bytes)} gzip`);

  assert.deepEqual(oversize, [], `over budget (entry ${kb(ENTRY_BUDGET)}, any chunk ${kb(CHUNK_BUDGET)}):\n${oversize.join('\n')}`);
  assert.ok(entryBytes <= ENTRY_BUDGET, `the entry chunk is ${kb(entryBytes)} gzip, over the ${kb(ENTRY_BUDGET)} of 01-TARGET.md §10`);
  console.log(`bundle: entry ${kb(entryBytes)} gzip across ${files.length} chunks`);
});

test('the initial payload — the entry plus everything it STATICALLY imports — stays small', () => {
  const entry = entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!;
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of staticImports(readFileSync(join(ASSETS, file), 'utf8'))) if (!seen.has(dep)) queue.push(dep);
  }
  const total = [...seen].reduce((sum, f) => sum + gz(join(ASSETS, f)), 0);
  const detail = [...seen].sort().map((f) => `  ${f}: ${kb(gz(join(ASSETS, f)))}`).join('\n');
  console.log(`bundle: initial payload ${kb(total)} gzip over ${seen.size} file(s)\n${detail}`);
  assert.ok(total <= INITIAL_BUDGET, `the initial payload is ${kb(total)} gzip, over ${kb(INITIAL_BUDGET)}:\n${detail}`);

  // The libraries that must NEVER be in the eager closure. Each is reached
  // from exactly one lazy route, and each of them being here at some point is
  // what this assertion is remembering.
  for (const lazyOnly of ['vendor-charts', 'vendor-qr', 'vendor-webgl']) {
    const found = [...seen].find((f) => f.startsWith(`${lazyOnly}-`));
    assert.equal(
      found,
      undefined,
      `${lazyOnly} is a STATIC import of the entry. It is only needed by a lazy route, so something re-grouped it or imported it eagerly — that is ${kb(gz(join(ASSETS, found ?? entry)))} gzip added to every first visit.`
    );
  }
});

test('the split really happened: every page and panel §10 names has a chunk of its own', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const has = (name: string) => files.some((f) => f.startsWith(`${name}-`));
  const missing: string[] = [];
  // The routes §10 lists, plus the admin panels of src/pages/Admin.tsx.
  for (const name of [
    'Admin', 'MerchantDashboardPage', 'Wallet', 'Checkout', 'StoreCheckout', 'Requests',
    'Chat', 'Chats', 'Warranty', 'WarrantyVerify', 'Invest', 'InvestAdmin', 'Tools', 'Rewards', 'Referrals',
    'AdminProducts', 'AdminBundles', 'AdminTaxonomy', 'AdminWarranties', 'AdminAds', 'AdminHomeSettings',
    'AdminOverview', 'AdminUsers', 'AdminWalletRequests', 'AdminWalletSettings', 'AdminStoreSettings',
    'AdminSerials', 'AdminReviews', 'AdminKyc', 'AdminMemberships', 'AdminCoupons', 'AdminDelivery',
    'AdminCommunity', 'AdminFarmConfig',
    // the manualChunks groups
    'vendor-react', 'vendor-motion', 'vendor-charts', 'vendor-phone', 'vendor-qr', 'vendor-i18n', 'vendor-webgl',
  ]) {
    if (!has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], `these have no chunk of their own — the lazy import or the manualChunks rule was removed:\n${missing.join(', ')}`);
});

test('the stylesheets stay under their budget', () => {
  // Not "one file": splitting a route out also splits the CSS it is the only
  // user of, which is the point. The budget is on the total, because the whole
  // set is what a visitor who walks the site eventually downloads.
  const css = readdirSync(ASSETS).filter((f) => f.endsWith('.css'));
  assert.ok(css.length > 0, 'no stylesheet was emitted at all');
  const each = css.map((f) => ({ f, bytes: gz(join(ASSETS, f)) })).sort((a, b) => b.bytes - a.bytes);
  const total = each.reduce((sum, x) => sum + x.bytes, 0);
  console.log(`bundle: css ${kb(total)} gzip over ${css.length} file(s) — ${each.map((x) => `${x.f} ${kb(x.bytes)}`).join(', ')}`);
  assert.ok(total <= CSS_BUDGET, `the stylesheets total ${kb(total)} gzip, over ${kb(CSS_BUDGET)}`);
});
