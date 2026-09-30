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
import { STOREFRONT_FIXED_KB } from '../worker/lib/storeSpeed';

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
const ENTRY_BUDGET = 72 * KB;
/** §10: any single route chunk. */
const CHUNK_BUDGET = 250 * KB;
/**
 * The entry plus everything it statically imports — what a browser must
 * download before it can render ANYTHING. It measured 406 KB gzip when this
 * budget was first written and 185 KB after the storefront's own pages were
 * split out; 240 KB leaves room to work without leaving room to undo it.
 *
 * P1b (docs/MERCHANT_PLATFORM_V2.md §B.1 #6, docs/PERFORMANCE_LOG.md «P1b»):
 * the entry measured 81.9 KB and the initial payload 212.1 KB over four files
 * before; 65.0 KB and 181.8 KB after — the animation library's feature half
 * (`vendor-motion`, 15.7 KB) left the first paint for a lazy `LazyMotion`
 * bundle, the bell, the verify banner, the first-run sheets, the tier table
 * and the search panel became lazy, and the icons shared by lazy routes
 * became one `vendor-icons` chunk instead of 112 files under 1 KB. Both
 * budgets are re-cut to the measured number plus ~10 %: 72 KB and 200 KB.
 * Re-eagering any one of those pieces (the smallest, the tier table, is
 * 1.6 KB) still fits, so the guard is the pair of «never in the initial
 * payload» lists below, which name them; the number catches the next page.
 */
const INITIAL_BUDGET = 200 * KB;
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
  // What `npm run build` does after vite: the headers file the asset layer
  // applies. Without it the build below is the bare `vite build` the
  // `_headers` test exists to refuse.
  execFileSync('node', ['scripts/write-asset-headers.mjs'], { cwd: ROOT, stdio: 'inherit' });
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

/**
 * THE HEADERS FILE IS PART OF THE BUILD, AND A BUILD WITHOUT IT ONCE MEASURED
 * AS THE SITE. The performance survey of 2026-09-29 (docs/MERCHANT_PLATFORM_V2_SURVEY.md
 * «perf-measure») ran against a dist/ produced by a bare `vite build`:
 * dist/_headers — the immutable caching of /assets/*, the CSP, HSTS — was
 * absent, and nothing said so. `npm run build` writes it after vite
 * (scripts/write-asset-headers.mjs; securityPolicy.test.ts pins the order),
 * so its absence means the artifact on disk is not what the deploy serves.
 */
test('dist/_headers exists — the build is `npm run build`, not a bare `vite build`', () => {
  const headers = join(DIST, '_headers');
  assert.ok(existsSync(headers), 'dist/_headers is missing — run `npm run build` (a bare `vite build` ships no caching or CSP headers)');
  const text = readFileSync(headers, 'utf8');
  assert.match(text, /^\/\*$/m, 'dist/_headers has no rule for the asset layer');
  assert.match(text, /^ {2}Content-Security-Policy: /m, 'dist/_headers carries no policy');
  assert.ok(
    statSync(headers).mtimeMs >= statSync(join(DIST, 'index.html')).mtimeMs,
    'dist/_headers is older than dist/index.html — vite emptied dist/ after it was written'
  );
});

/**
 * THE DOCUMENT IS PAID FOR ON EVERY VISIT (`no-cache`), and it measured 7.4 KB
 * gzip of which 5.9 KB were the source's own comments (perf-measure §3).
 * vite.config.ts strips them at build; this holds the result. Measured after
 * the strip: 2.0 KB gzip with Vite's modulepreload links in place; 4 KB fails
 * the day the strip is dropped and passes ordinary head edits.
 */
const DOCUMENT_BUDGET = 4 * KB;

test('the built document carries no HTML comments and stays under 4 KB gzip', () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  assert.equal(/<!--/.test(html), false, 'dist/index.html still carries HTML comments — the strip in vite.config.ts is not running');
  const bytes = gz(join(DIST, 'index.html'));
  console.log(`bundle: document ${kb(bytes)} gzip (${html.length} B raw)`);
  assert.ok(bytes <= DOCUMENT_BUDGET, `the document is ${kb(bytes)} gzip, over ${kb(DOCUMENT_BUDGET)}`);
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
  // P1b: the animation features (`vendor-motion`, not `vendor-motion-core`)
  // and the shared icons of the lazy routes (`vendor-icons`); the bell, the
  // verify banner, the first-run sheets, the tier table and the search panel
  // (each a lazy chunk of its own now). tests/motionLazy.test.ts says why.
  for (const lazyOnly of [
    'vendor-charts', 'vendor-qr', 'vendor-webgl', 'Bundles', 'BundleDetail', 'BundlesShelf',
    'vendor-icons', 'NotificationBell', 'EmailVerifyBanner', 'CompleteProfileSheet', 'ThemeIntroSheet', 'tierMeta', 'LiveSearchPanel', 'motionFeaturesBundle',
  ]) {
    const found = [...seen].find((f) => f.startsWith(`${lazyOnly}-`));
    assert.equal(
      found,
      undefined,
      `${lazyOnly} is a STATIC import of the entry. It is only needed by a lazy route, so something re-grouped it or imported it eagerly — that is ${kb(gz(join(ASSETS, found ?? entry)))} gzip added to every first visit.`
    );
  }
  const features = [...seen].find((f) => /^vendor-motion-(?!core-)/.test(f));
  assert.equal(features, undefined, `the animation features (${features}) are a STATIC import of the entry again — an eager module renders \`motion.*\` instead of \`m.*\` under <MotionFeatures> (src/lib/motionFeatures.tsx)`);
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
    // COMMUNITY PHASE 5 + MERCHANT P4/P5 (perf review 2026-09-30): the request
    // page (offers, discussion, compare), the order timeline, the merchant's
    // custom-order screen, the Counter's announcement sheet and the workshop
    // board rail are each a lazy chunk — named here, and kept out of the
    // entry, the store pages and the workspace frame by the test below.
    'Request', 'OrderTimeline', 'CustomOrderScreen', 'AnnouncementSheet', 'BoardRail',
    // the manualChunks groups — `vendor-motion` is the features half and
    // `vendor-motion-core` the eager half (P1b); `vendor-icons` the icons the
    // lazy routes share (vite.config.ts `iconChunk`).
    'vendor-react', 'vendor-motion', 'vendor-motion-core', 'vendor-charts', 'vendor-phone', 'vendor-qr', 'vendor-i18n', 'vendor-webgl', 'vendor-icons',
    // the store layout's tables and the storefront's theme lookups, one file (review 2026-09-30).
    'store-layout',
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
 *
 * W2-F TOOK BOTH STEPS and added the product page's variant picker, media
 * gallery (video included) and printed-product facts: `refusalStrings` is a
 * dynamic import on the first refusal, `OwnerShareMenuItem` a lazy row of the
 * «…» menu. The closure measured 40.7 KB after it (StorefrontProduct 6.8 KB
 * with the variant UI inside it); the budget is that plus ~4 KB, so re-eagering
 * either lazy piece (8.8 / 2.3 KB) fails the same day.
 *
 * THE TYPED QUANTITY (owner, 2026-09-26: «يضغط على الرقم ويكتب الكمية»). The
 * buy bar's stepper became the shared `QuantityInput` (2.6 KB with its rules,
 * packages/pricing/src/quantity.ts), the same control as the Levonis product
 * page and both carts. The closure measured 45.5 KB with it; 47 keeps the
 * guarantee above — re-eagering the smaller lazy piece (2.3 KB) still fails.
 *
 * LEVO COMMUNITY (2026-09-28): the history-aware Back and the follow pill's
 * reset of the community page's remembered lists (a cache module of its own,
 * not the feed hook) took it to 47.1; the suspended-store page, which only a
 * sanctioned shop's visitor ever sees, became a lazy chunk (-0.8). 46.5 KB;
 * then 47.0 with the product page's lazy save/share row and the follower
 * count that moves with a follow. AT THE BUDGET: the next addition to a store
 * page makes something else lazy, or argues for a new number here.
 *
 * COMMUNITY PHASE 5 + MERCHANT P4/P5 (2026-09-30): 47,739 B as integrated —
 * 389 B from the gate. The review paid it back: ONE scheduler for the speed
 * reporter (src/lib/storeBeacon.ts `scheduleStoreVitals`, the same effect had
 * been written into both pages) and the store layout's tables as ONE file
 * (vite.config.ts `store-layout`, where Rollup had split them in three by
 * importer set) — 47,480 B with the review's own a11y fixes inside it. The
 * hero's workshop facts and the video element became small chunks of their
 * own, so a classic page no longer fetches `extra` for them.
 *
 * WHAT COUNTS (P1b). The closure is split in two: the store pages' OWN
 * weight — their chunks and the app modules they pull in, which this budget
 * has always measured — and the shared `vendor-*` chunks (the animation
 * features, the icons the lazy routes share), which are printed and capped
 * in tests/motionLazy.test.ts instead. Before P1b the animation features were
 * inside the initial payload and so invisible here; moving them out of the
 * first paint for every visitor (−30 KB gzip before paint) would otherwise
 * have read as the store pages "growing" by a chunk they already downloaded.
 * The store visitor's total, initial payload plus closure, fell (258 →
 * 250 KB gzip). What remains for the store pages themselves is to render
 * `m.*` under <MotionFeatures> (StorefrontProduct.tsx, StoreCta, the follow
 * pill) so the features leave their first paint too — P11.
 */
const STOREFRONT_BUDGET = 47 * KB;
/** Vendor chunks a lazy page may share; they are budgeted on their own, not against a page. */
const isSharedVendor = (f: string) => /^vendor-/.test(f);

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

test('the storefront pages add at most 47 KB gzip beyond the initial payload, and the other blocks stay lazy', () => {
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
  const own = [...beyond].filter((f) => !isSharedVendor(f));
  const vendor = [...beyond].filter(isSharedVendor);
  const total = own.reduce((sum, f) => sum + gz(join(ASSETS, f)), 0);
  const detail = own.sort().map((f) => `  ${f}: ${kb(gz(join(ASSETS, f)))}`).join('\n');
  console.log(`bundle: storefront pages ${kb(total)} gzip beyond the initial payload\n${detail}`);
  console.log(`bundle: storefront pages also share ${vendor.map((f) => `${f} ${kb(gz(join(ASSETS, f)))}`).join(', ') || 'no vendor chunk'}`);
  assert.ok(total <= STOREFRONT_BUDGET, `the storefront pages add ${kb(total)} gzip, over ${kb(STOREFRONT_BUDGET)}:\n${detail}`);
  // P4: the speed tab's «ثابت للتطبيق» row (worker/lib/storeSpeed.ts STOREFRONT_FIXED_KB) IS this
  // measurement — the initial payload plus the storefront pages' own closure — so the number a
  // merchant is shown cannot drift from the build by more than 3 KB.
  const fixed = ([...initial].reduce((sum, f) => sum + gz(join(ASSETS, f)), 0) + total) / KB;
  console.log(`bundle: a store page's fixed app weight ${fixed.toFixed(1)} KB (STOREFRONT_FIXED_KB = ${STOREFRONT_FIXED_KB})`);
  assert.ok(
    Math.abs(fixed - STOREFRONT_FIXED_KB) <= 3,
    `worker/lib/storeSpeed.ts STOREFRONT_FIXED_KB is ${STOREFRONT_FIXED_KB} but the build measures ${fixed.toFixed(1)} KB — update the figure the speed tab shows`
  );

  assert.ok(chunk('extra'), 'the non-classic blocks have no lazy chunk of their own');
  assert.ok(chunk('StoreDesignPanel'), 'the store design panel is not a lazy chunk');
  assert.ok(chunk('tabViews'), 'the other tabs\' views have no lazy chunk of their own');
  // P4: the real-user speed reporter is imported after load + idle, never statically.
  assert.ok(chunk('storeVitals'), 'the speed reporter has no lazy chunk of its own');
  // P5: the page background's media (poster, image, video) arrives after the blocks.
  assert.ok(chunk('BackgroundMedia'), 'the background media layer has no lazy chunk of its own');
  // Review 2026-09-30: the hero's workshop facts row and the moving picture are small chunks of their own —
  // a classic store no longer fetches the 9 KB `extra` chunk for either.
  assert.ok(chunk('workshopFacts'), 'the workshop facts row has no lazy chunk of its own');
  assert.ok(chunk('StoreVideo'), 'the store video element has no lazy chunk of its own');
  for (const piece of ['workshopFacts', 'StoreVideo']) {
    assert.equal(staticClosure(chunk(piece)!).has(chunk('extra')!), false, `${piece} statically pulls in the non-classic blocks' chunk`);
  }
  for (const lazyOnly of ['extra', 'tabViews', 'StoreDesignPanel', 'MerchantDashboardPage', 'vendor-charts', 'storeVitals', 'BackgroundMedia', 'workshopFacts', 'StoreVideo']) {
    const found = [...beyond, ...initial].find((f) => f.startsWith(`${lazyOnly}-`));
    assert.equal(found, undefined, `${lazyOnly} is a STATIC import of a storefront page — every store visit would download it`);
  }
});

/**
 * THE MERCHANT WORKSPACE'S FRAME (W3-A). `/merchant` used to be one eager
 * 65.3 KB gzip chunk (103.1 KB with its closure beyond the initial payload):
 * opening the Overview downloaded every tab. The workspace is now a small
 * shell — the route element, the one nav table, the top bar, the sidebar /
 * rail / phone tabs, the router — and every screen is its own lazy chunk,
 * fetched when its address is opened. The palette and the phone's «More»
 * sheet load the first time they are opened.
 *
 * THE NUMBERS. Audit 05 §6.5 proposed 25 KB gzip for the shell. Measured at
 * W3-A: the shell chunk 20.5 KB (a third of it the words of the store-status
 * reasons and the nav in Arabic, English and Sorani), 28.3 KB with its closure
 * beyond the initial payload (the store bell, the toast stack, the menu
 * primitive and the nav icons). The budgets are that plus ~4 KB, so pulling
 * any screen back into the frame (the smallest, CustomersSection, is 1 KB; a
 * typical one 5–10 KB) fails the same day.
 */
const WORKSPACE_SHELL_BUDGET = 25 * KB;
const WORKSPACE_CLOSURE_BUDGET = 32 * KB;
/** The screens: each must have a chunk of its own and none may be a static import of the frame. */
const WORKSPACE_SCREENS = [
  'CommandCenter', 'SalesTabs', 'CatalogTabs', 'ProductsManager', 'PrintersTab', 'CostingTab', 'StoreSettingsTab',
  'StoreDesignPanel', 'MerchantFinance', 'DeliverySettingsEditor', 'MerchantInbox', 'AnalyticsSection', 'ReviewsSection',
  'CustomersSection', 'RequestsSection', 'NotificationsSection', 'CommandPalette', 'MoreSheet',
  // W3-B: the orders address picks the list or the order's own screen, each lazy.
  'OrdersSection', 'OrderDetailScreen',
  // P3b: the orders list itself is a lazy chunk beside the order screen.
  'OrdersList',
];

test('the merchant workspace shell is small, stays out of every customer closure, and loads each screen lazily', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const chunk = (name: string) => files.find((f) => f.startsWith(`${name}-`));
  const shell = chunk('MerchantDashboardPage');
  assert.ok(shell, 'the workspace shell has no chunk of its own');
  const initial = staticClosure(entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!);
  assert.equal(initial.has(shell!), false, 'the workspace shell is in the initial payload');

  const own = gz(join(ASSETS, shell!));
  // The shell's own closure; the shared vendor chunks are accounted as for the store pages above.
  const closure = [...staticClosure(shell!)].filter((f) => !initial.has(f) && !isSharedVendor(f));
  const total = closure.reduce((sum, f) => sum + gz(join(ASSETS, f)), 0);
  const detail = closure.sort().map((f) => `  ${f}: ${kb(gz(join(ASSETS, f)))}`).join('\n');
  console.log(`bundle: workspace shell ${kb(own)} gzip, ${kb(total)} with its closure beyond the initial payload\n${detail}`);
  assert.ok(own <= WORKSPACE_SHELL_BUDGET, `the workspace shell is ${kb(own)} gzip, over ${kb(WORKSPACE_SHELL_BUDGET)}`);
  assert.ok(total <= WORKSPACE_CLOSURE_BUDGET, `the workspace shell adds ${kb(total)} gzip, over ${kb(WORKSPACE_CLOSURE_BUDGET)}:\n${detail}`);
  // The shared vendor chunks the shell reaches are printed too, and the one
  // that matters is pinned: the frame renders `m.*` under <MotionFeatures>, so
  // the animation FEATURES half (`vendor-motion`, 16 KB gzip) is never a static
  // import of it again — a re-eagered `motion.*` in the shell used to hide
  // behind `isSharedVendor` while the shell number stayed green (perf review 2026-09-30).
  const shellVendor = [...staticClosure(shell!)].filter((f) => !initial.has(f) && isSharedVendor(f));
  console.log(`bundle: workspace shell also shares ${shellVendor.map((f) => `${f} ${kb(gz(join(ASSETS, f)))}`).join(', ') || 'no vendor chunk'}`);
  assert.equal(
    shellVendor.find((f) => /^vendor-motion-(?!core-)/.test(f)),
    undefined,
    'the animation features chunk is a STATIC import of the workspace shell — an element renders motion.* instead of m.* under <MotionFeatures>'
  );

  const inShell = new Set(closure);
  for (const name of WORKSPACE_SCREENS) {
    const f = chunk(name);
    assert.ok(f, `${name} has no chunk of its own — a workspace screen was made eager`);
    assert.equal(inShell.has(f!), false, `${name} is a STATIC import of the workspace shell — opening /merchant would download it`);
    assert.equal(initial.has(f!), false, `${name} is in the initial payload`);
  }
  // P4: the builder's «السرعة» tab is a lazy chunk of the builder, fetched when the tab opens.
  assert.ok(chunk('SpeedPanel'), 'the speed tab has no chunk of its own');
  assert.equal(staticClosure(chunk('StoreDesignPanel')!).has(chunk('SpeedPanel')!), false, 'the speed tab is a static import of the builder');
  // Nothing of the workspace reaches a store visitor either.
  const storefront = new Set(['Storefront', 'StorefrontProduct'].flatMap((n) => [...staticClosure(chunk(n)!)]));
  for (const name of ['MerchantDashboardPage', ...WORKSPACE_SCREENS]) {
    const f = chunk(name)!;
    assert.equal(storefront.has(f), false, `${name} is a static import of a storefront page`);
  }
});

/**
 * THE ANALYTICS SCREEN DRAWS ITS OWN CHARTS (W3-B). Its charts are in-house
 * SVG (src/components/merchant/analytics/charts.tsx), so the screen must never
 * pull the storefront's chart library (`vendor-charts`, ~120 KB gzip) or any
 * other chart package into the workspace. Measured at W3-B: the screen chunk
 * 11.0 KB gzip; 16 KB leaves room to work, and fails the day a library
 * arrives. The order screen measured 7.4 KB (budget 12 KB).
 */
const ANALYTICS_SCREEN_BUDGET = 16 * KB;
const ORDER_SCREEN_BUDGET = 12 * KB;
/**
 * TODAY (CommandCenter) is the merchant's landing screen on every workspace
 * open. Measured after the perf review of 2026-09-30: the chunk 14.8 KB gzip
 * (the Counter's three-language strings ride in it), its closure beyond the
 * shell 18 KB — the restock sheet is a lazy chunk, the refusal sentences load
 * on the first refusal, and the `motion` proxy is gone from it AND from the
 * switch it renders. 18 KB leaves room for a line, not for a sheet or a
 * sentence table; the two names below are the ones that used to sneak in.
 */
const TODAY_SCREEN_BUDGET = 18 * KB;

test('the analytics, order and Today screens stay small and never pull in a chart library, the animation features or the refusal sentences', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const chunk = (name: string) => files.find((f) => f.startsWith(`${name}-`));
  const shell = chunk('MerchantDashboardPage')!;
  const initial = staticClosure(entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!);
  const shellClosure = staticClosure(shell);
  for (const [name, budget] of [['AnalyticsSection', ANALYTICS_SCREEN_BUDGET], ['OrderDetailScreen', ORDER_SCREEN_BUDGET], ['CommandCenter', TODAY_SCREEN_BUDGET]] as const) {
    const f = chunk(name);
    assert.ok(f, `${name} has no chunk of its own`);
    const own = gz(join(ASSETS, f!));
    const beyond = [...staticClosure(f!)].filter((x) => !initial.has(x) && !shellClosure.has(x));
    console.log(`bundle: ${name} ${kb(own)} gzip; beyond the shell: ${beyond.join(', ')}`);
    assert.ok(own <= budget, `${name} is ${kb(own)} gzip, over ${kb(budget)}`);
    assert.equal(beyond.some((x) => /^vendor-charts-/.test(x)), false, `${name} pulls the chart library in`);
    if (name === 'CommandCenter') {
      assert.equal(beyond.some((x) => /^vendor-motion-(?!core-)/.test(x)), false, `${name} carries the animation features statically — an element (or a primitive it renders) uses motion.* instead of m.* under <MotionFeatures>`);
      assert.equal(beyond.some((x) => /^refusalStrings-/.test(x)), false, `${name} carries the refusal sentences statically — load them on the first refusal`);
      assert.equal(beyond.some((x) => /^RestockSheet-/.test(x)), false, `${name} imports the restock sheet statically — it opens on a tap, as a lazy chunk`);
    }
  }
});

/**
 * THE PHASE-5 SCREENS STAY LAZY (perf review 2026-09-30). The request page,
 * the order timeline, the custom-order screen, the announcement sheet and the
 * workshop board rail were new lazy chunks the gate did not name: a static
 * import of any of them would have added it to every first visit, every store
 * visit or every workspace open without a test failing. Each must be a chunk
 * of its own and a static import of none of those closures; the announcement
 * sheet opens on a tap from Today, so it is not in Today's closure either.
 */
const PHASE5_LAZY = ['Request', 'OrderTimeline', 'CustomOrderScreen', 'AnnouncementSheet', 'BoardRail'] as const;

test('the Phase-5 screens are lazy chunks outside the entry, the store pages, the workspace frame and Today', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const chunk = (name: string) => files.find((f) => f.startsWith(`${name}-`));
  const initial = staticClosure(entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!);
  const storefront = new Set(['Storefront', 'StorefrontProduct'].flatMap((n) => [...staticClosure(chunk(n)!)]));
  const shell = staticClosure(chunk('MerchantDashboardPage')!);
  const today = staticClosure(chunk('CommandCenter')!);
  for (const name of PHASE5_LAZY) {
    const f = chunk(name);
    assert.ok(f, `${name} has no chunk of its own — its lazy import was removed`);
    console.log(`bundle: ${name} ${kb(gz(join(ASSETS, f!)))} gzip (lazy)`);
    assert.equal(initial.has(f!), false, `${name} is in the initial payload — every first visit would download it`);
    assert.equal(storefront.has(f!), false, `${name} is a static import of a store page`);
    assert.equal(shell.has(f!), false, `${name} is a static import of the workspace frame — opening /merchant would download it`);
  }
  assert.equal(today.has(chunk('AnnouncementSheet')!), false, 'the announcement sheet is a static import of Today — it opens on a tap, as a lazy chunk');
  // The board rail is fetched by the community home only for a signed-in workshop — never inside the home's own chunk.
  assert.equal(staticClosure(chunk('Community')!).has(chunk('BoardRail')!), false, 'the board rail is a static import of the community home');
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

/**
 * THE COMPARE TRAY STAYS OUT OF THE FIRST BYTE (docs/ux/IMPLEMENTATION_PLAN.md
 * S3, CATALOG_DISCOVERY §12). The entry imports only the tray's store
 * (src/lib/compareTray.ts) and its gate; the tray itself — the bar, the undo
 * toast's Toaster, the conflict dialog — is its own chunk, downloaded the
 * first time the tray holds a product. Measured at S3: the store + gate added
 * 1.24 KB gzip to the entry (68.35 → 69.62 KB built from HEAD with only S3's
 * entry files), inside the plan's ≤ 1.5 KB; the entry budget itself is
 * unchanged. The tray chunk measured 2.6 KB gzip.
 */
const COMPARE_TRAY_CHUNK_BUDGET = 8 * KB;

test('the compare tray is a lazy chunk of its own, never in the initial payload', () => {
  const files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
  const tray = files.find((f) => f.startsWith('CompareTray-'));
  assert.ok(tray, 'the compare tray has no chunk of its own — it was made eager');
  const initial = staticClosure(entryFromHtml(readFileSync(join(DIST, 'index.html'), 'utf8'))!);
  assert.equal(initial.has(tray!), false, 'the compare tray is in the initial payload');
  const own = gz(join(ASSETS, tray!));
  console.log(`bundle: compare tray ${kb(own)} gzip`);
  assert.ok(own <= COMPARE_TRAY_CHUNK_BUDGET, `the compare tray chunk is ${kb(own)} gzip, over ${kb(COMPARE_TRAY_CHUNK_BUDGET)}`);
});
