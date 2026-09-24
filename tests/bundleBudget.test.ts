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
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');

const KB = 1024;
/**
 * §10 set 350 KB. The entry measured 258 KB gzip while `Product` (2,119 lines),
 * `Cart` (1,749), `Addresses`, `Auth` and every account surface were EAGER
 * imports — under budget, and still most of the application in the first byte.
 * Making them lazy (with an idle prefetch, so the tap stays instant) took it to
 * 60 KB, and the budget is re-cut to 120 KB: comfortable headroom for ordinary
 * work, tight enough that re-eagering a page is caught the same day.
 */
const ENTRY_BUDGET = 120 * KB;
/** §10: any single route chunk. */
const CHUNK_BUDGET = 250 * KB;
/**
 * The entry plus everything it statically imports — what a browser must
 * download before it can render ANYTHING. It measured 406 KB gzip when this
 * budget was first written and 185 KB after the storefront's own pages were
 * split out; 240 KB leaves room to work without leaving room to undo it.
 */
const INITIAL_BUDGET = 240 * KB;
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

/**
 * This suite measures the REAL build, so it builds one when there is none
 * rather than passing on nothing or failing on a checkout.
 *
 * It used to assert `existsSync(ASSETS)` and stop. That reads as strict, and
 * locally it is: a developer always has a `dist/` lying about. But `dist/` is
 * gitignored, and both deploy workflows run this gate BEFORE their build step,
 * so on a clean checkout the assertion could only ever fail — five red tests
 * that said nothing about the bundle, and, because `test:unit` chained with
 * `&&`, they took every workspace suite down with them. The local pass was no
 * better than the CI failure: it measured whatever artifact happened to be on
 * disk, possibly from another commit.
 *
 * Building here costs a few seconds exactly once, when `dist/assets` is
 * absent, and makes the number honest in both places.
 *
 * ABSENT WAS NOT A STRICT ENOUGH TEST, and the PWA work is what proved it.
 *
 * A `dist/` forty minutes older than the newest source file satisfies
 * `existsSync` perfectly, so this hook returned early and all six tests passed
 * — against a build that predated every file in the change. `dist/sw.js` and
 * `dist/_headers` did not exist, `dist/index.html` still carried the old head
 * with no `rel="manifest"` in it, and the one question the suite was there to
 * answer (does the new static import push the entry past 120 KB gzip?) went
 * unanswered while reading as a pass. A stale green is worse than a skip: a
 * skip is visible.
 *
 * So the freshness of the artifact is now part of the condition. The newest
 * mtime under `src/`, plus the three root files that end up in the bundle, is
 * compared against `dist/index.html`; older means rebuild. Comparing against
 * index.html rather than a chunk is deliberate — chunk names are
 * content-hashed, so an unchanged chunk keeps its old file, while the entry
 * document is rewritten by every build.
 */
/** The most recent mtime under a directory, or 0 if it does not exist. */
function newestMtime(path: string): number {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const entry of readdirSync(path)) {
    // `node_modules` cannot appear under the roots below, so there is nothing
    // to prune here and the walk stays a plain recursion.
    newest = Math.max(newest, newestMtime(join(path, entry)));
  }
  return newest;
}

/** True when `dist/` cannot possibly describe the source tree on disk. */
function distIsStale(): boolean {
  const built = newestMtime(join(DIST, 'index.html'));
  if (!built) return true;
  const sources = [
    join(ROOT, 'src'),
    join(ROOT, 'public'),
    join(ROOT, 'index.html'),
    join(ROOT, 'vite.config.ts'),
  ];
  return sources.some((path) => newestMtime(path) > built);
}

before(() => {
  if (existsSync(ASSETS) && !distIsStale()) return;
  execFileSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
  assert.ok(existsSync(ASSETS), 'vite build produced no dist/assets');
  assert.ok(!distIsStale(), 'vite build left dist/ older than the sources it was built from');
});

test('dist/ exists AND is newer than the sources — never a stale build', () => {
  assert.ok(existsSync(ASSETS), 'dist/assets is missing even after a build');
  // The assertion that would have caught the PWA change measuring an artifact
  // from before it existed. `before` rebuilds when this is true, so reaching
  // here still stale means the build itself did not take.
  assert.ok(!distIsStale(), 'dist/ is older than src/, public/ or index.html — every number below is from another commit');
  assert.ok(
    readdirSync(ASSETS).some((f) => f.endsWith('.js')),
    'dist/assets holds no JavaScript — a budget over an empty directory proves nothing'
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
  // `Bundles` and `BundleDetail` are here because `Bundles` USED to be an
  // eager import in src/App.tsx, and the home shelf that renders the same card
  // is deliberately its own lazy chunk for the same reason: importing the
  // bundle card from the eager home page would put the card, the countdown,
  // the offer badge and the tier metadata back into every first visit.
  for (const lazyOnly of ['vendor-charts', 'vendor-qr', 'vendor-webgl', 'Bundles', 'BundleDetail', 'BundlesShelf']) {
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
    // THE STOREFRONT'S OWN PAGES. Each was an eager import, and together they
    // were the bulk of a 942 KB entry chunk. They are lazy AND prefetched on
    // idle (src/App.tsx `prefetchable` / `useIdlePrefetch`), so nothing about
    // the tap got slower — but a regression that re-eagers one would put it
    // back in every first visit, so each is named here.
    'Product', 'Products', 'Cart', 'Addresses', 'Auth',
    'Profile', 'Orders', 'OrderDetail', 'Settings', 'Subscription',
    'Community', 'SavedProducts', 'Policies', 'Support',
    // The bundles surface: `Bundles` was EAGER and sat in the entry chunk of
    // every first visit; `BundleDetail` arrives with its route. Both are named
    // here so a regression that re-eagers either one fails loudly.
    'Bundles', 'BundleDetail',
    'Chat', 'Chats', 'Warranty', 'WarrantyVerify', 'Invest', 'InvestAdmin', 'Tools', 'Rewards', 'Referrals',
    'AdminProducts', 'AdminBundles', 'AdminTaxonomy', 'AdminWarranties', 'AdminAds', 'AdminHomeSettings',
    'AdminOverview', 'AdminUsers', 'AdminWalletRequests', 'AdminWalletSettings', 'AdminStoreSettings',
    'AdminSerials', 'AdminReviews', 'AdminKyc', 'AdminMemberships', 'AdminCoupons', 'AdminDelivery',
    'AdminCommunity', 'AdminFarmConfig',
    // §11.1 tab 4 and §14's bundle budget: the special-offers panel is its own
    // lazy chunk, so an owner who never opens it downloads none of it.
    'AdminOffers',
    // §11.1 tabs 2 and 3, plan slice 8. Both are lazy for the same reason, and
    // both are named here so a regression that drops either tab — leaving the
    // seventeen `/api/admin/mystery` routes with no UI again — fails loudly.
    'AdminMystery', 'AdminMysteryPools',
    // the manualChunks groups
    'vendor-react', 'vendor-motion', 'vendor-charts', 'vendor-phone', 'vendor-qr', 'vendor-i18n', 'vendor-webgl',
  ]) {
    if (!has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], `these have no chunk of their own — the lazy import or the manualChunks rule was removed:\n${missing.join(', ')}`);
});

/**
 * THE STORE PAGE'S OWN WEIGHT. A visitor to a store downloads the initial
 * payload, then the `Storefront` (or `StorefrontProduct`) chunk and whatever
 * that statically imports: the layout renderer and its schema, the theme, and
 * what the classic page shows first (hero, tab strip, Products tab). The other
 * tabs are one lazy chunk (`tabViews`, prefetched when idle), every other
 * block a second (`extra`), and the merchant's design panel a lazy chunk of
 * the dashboard — none of them may become static imports of a store page.
 *
 * THE NUMBER. Audit 05 §6.5 proposed 30 KB, measured at 24.0. Before the
 * store-layout work (W2-C) the same closure already measured 33.8 KB — 8.8 of
 * it `refusalStrings`, which `StorefrontProduct` imports for its error text.
 * The renderer brought it to 46.7: the layout schema the page normalises
 * again before it renders (6.3 KB with the normaliser), the block runtime and
 * theme, plus the share strings (merchant/share) and the Tabs primitive that
 * grew alongside. 50 KB holds that with room for ordinary work, and fails the
 * day either lazy chunk (tabViews 5.3 KB, extra 7.5 KB) is pulled back in.
 * The way down to 30: load `refusalStrings` on the first refusal (-8.8), the
 * owner's share strings with the owner's menu (-2.3).
 */
const STOREFRONT_BUDGET = 50 * KB;

function staticClosure(start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of staticImports(readFileSync(join(ASSETS, file), 'utf8'))) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

test('the storefront pages add at most 50 KB gzip beyond the initial payload, and the other blocks stay lazy', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const chunk = (name: string) => files.find((f) => f.startsWith(`${name}-`));
  const initial = staticClosure(entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!);
  const pages = ['Storefront', 'StorefrontProduct'].map((name) => {
    const f = chunk(name);
    assert.ok(f, `${name} has no chunk of its own`);
    return f!;
  });
  const beyond = new Set<string>();
  for (const page of pages) for (const f of staticClosure(page)) if (!initial.has(f)) beyond.add(f);
  const total = [...beyond].reduce((sum, f) => sum + gz(join(ASSETS, f)), 0);
  const detail = [...beyond].sort().map((f) => `  ${f}: ${kb(gz(join(ASSETS, f)))}`).join('\n');
  console.log(`bundle: storefront pages ${kb(total)} gzip beyond the initial payload\n${detail}`);
  assert.ok(total <= STOREFRONT_BUDGET, `the storefront pages add ${kb(total)} gzip, over ${kb(STOREFRONT_BUDGET)}:\n${detail}`);

  assert.ok(chunk('extra'), 'the non-classic blocks have no lazy chunk of their own');
  assert.ok(chunk('StoreDesignPanel'), 'the store design panel is not a lazy chunk');
  assert.ok(chunk('tabViews'), 'the other tabs\' views have no lazy chunk of their own');
  for (const lazyOnly of ['extra', 'tabViews', 'StoreDesignPanel', 'MerchantDashboardPage', 'vendor-charts']) {
    const found = [...beyond, ...initial].find((f) => f.startsWith(`${lazyOnly}-`));
    assert.equal(found, undefined, `${lazyOnly} is a STATIC import of a storefront page — every store visit would download it`);
  }
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
