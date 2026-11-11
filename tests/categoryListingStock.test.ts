/**
 * THE LISTING PAGE'S SECTION WORD, AS src/pages/CategoryListing.tsx GETS IT (docs/DECISIONS.md rows 309 and
 * 311; the review of 2026-11-11 found the page's own wiring pinned by no test).
 *
 * The map stops counting stock past its cap and the live shop is past it, so a listing page asks its section's
 * counts: ONE silent GET /api/catalog/:slug/counts — never the section's page, which for a signed-in viewer is
 * a tier-priced build of up to a thousand cards that nobody caches — by id when the slug is too long to ask by.
 * Every descendant comes with it and is remembered a minute, so coming back, or opening a section from here at
 * any depth, asks nothing. A root's «all» — the map's, or an inactive root's that the category route names —
 * asks nothing and says no section word.
 *
 * The storefront's own loaders ask the REAL Worker routes here (the fetch is the app), so the path the page
 * asks is the path the Worker answers. The page composes these pieces in a few lines, pinned at the end.
 *
 * Run: node --import tsx --test tests/categoryListingStock.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, json, stubApp, type App, type Mount } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { DEEP, seedDeepSections } from './fixtures/deepSections';
import { LISTING_SLUG_MAX, catalogRoutes } from '../worker/routes/catalog';
import { slugify } from '../worker/routes/adminTaxonomy';
import { asksSectionStock, followSectionStock, forgetSectionStock, listingStockWord, withStock } from '../src/lib/catalog/sectionStock';
import { listingSection, listingTarget, resolveListingRoute } from '../src/lib/catalog/listingModel';
import { loadCategory } from '../src/lib/catalog/data';
import { clearPageCache } from '../src/lib/pageCache';
import { nounKindFor, sectionStockLabel, type CatalogLang, type SectionStock } from '../src/lib/catalog/copy';
import type { CatalogTreeNode, CatalogTreeResponse, CategoryPayload } from '../src/lib/catalog/types';

const mount: Mount = (a) => a.route('/api/catalog', catalogRoutes);
const originalFetch = globalThis.fetch;
/** Every answer `serve` handed out, so a test that failed half-way leaves nothing landing in the next one. */
const inflight: Promise<unknown>[] = [];
const ticks = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 1));
};
afterEach(async () => {
  await Promise.allSettled(inflight.splice(0));
  await ticks();
  globalThis.fetch = originalFetch;
  forgetSectionStock();
  clearPageCache();
});

/** The live catalogue with «makers-supply» three levels deep (tests/fixtures/deepSections.ts). */
function world(extra = ''): App {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedDeepSections(raw);
  if (extra) raw.exec(extra);
  return stubApp(asD1(raw), null, mount);
}

/**
 * The storefront's requests, answered by the Worker's own routes: every path asked, in order, and `settled`,
 * which waits until each answer has reached its caller. `fail` answers each with a server error instead.
 */
function serve(app: App, opts: { fail?: boolean } = {}) {
  const asked: string[] = [];
  const answers: Promise<Response>[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = String(input);
    asked.push(path);
    const answer = opts.fail
      ? Promise.resolve(new Response(JSON.stringify({ success: false, error: 'D1_ERROR' }), { status: 500, headers: { 'content-type': 'application/json' } }))
      : Promise.resolve(app.request(path));
    answers.push(answer);
    inflight.push(answer);
    return answer;
  }) as typeof fetch;
  const settled = async () => {
    await Promise.allSettled(answers);
    await ticks();
  };
  return { asked, settled };
}

/** The map as the live shop gets it: past TREE_AVAILABILITY_CAP it counts no state (`treeNode`'s nulls). */
async function mapPastItsCap(app: App): Promise<CatalogTreeResponse> {
  const tree = (await json(await app.request('/api/catalog/tree'))) as CatalogTreeResponse;
  const strip = (n: CatalogTreeNode) => {
    Object.assign(n, { available_count: null, preorder_count: null, unavailable_count: null, withheld_count: null });
    n.children.forEach(strip);
  };
  tree.roots.forEach(strip);
  return tree;
}

/** `/categories/<root>/<sub>` on this map, as the page reads it: its target and its one section. */
function open(tree: CatalogTreeResponse, root: string, sub: string) {
  const target = listingTarget(resolveListingRoute(tree.roots, root, sub), null);
  assert.ok(target, `${root}/${sub} is on the map`);
  return { target, shown: listingSection(target) };
}

/** The page's effect: `followSectionStock` until its request has settled, and what it handed over. */
async function follow(shown: CatalogTreeNode, s: ReturnType<typeof serve>): Promise<Map<string, SectionStock> | null> {
  let got: Map<string, SectionStock> | null = null;
  followSectionStock(shown, (counts) => {
    got = counts;
  });
  await s.settled();
  return got;
}

const word = (n: CatalogTreeNode, lang: CatalogLang) => sectionStockLabel(n, nounKindFor(n.product_type, n.is_printer_catalog), lang);

test('a section the map did not count asks its counts ONCE — /counts, never its page — and says what its own page says', async () => {
  const app = world();
  const s = serve(app);
  const tree = await mapPastItsCap(app);
  const { target, shown } = open(tree, 'makers-supply', 'maker-tools');
  assert.ok(shown && asksSectionStock(shown), 'the map counted nothing: the page asks');
  const section: CatalogTreeNode = shown;
  assert.equal(listingStockWord(target, null, 'ar'), null, 'and says nothing until the counts come');

  const got = await follow(section, s);
  assert.deepEqual(s.asked, ['/api/catalog/maker-tools/counts'], 'one request, for the counts: never /api/catalog/maker-tools');
  assert.ok(got);
  const counts: ReadonlyMap<string, SectionStock> = got;
  assert.deepEqual([...counts.keys()], ['cat_makers_tools', DEEP.hand, DEEP.saws], 'the section, its child and its grandchild');

  // What the section's own page says, in every language: the header beside its count, and each row.
  const own = (await json(await app.request('/api/catalog/maker-tools'))) as CategoryPayload;
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(listingStockWord(target, counts, lang), word(own.node, lang), lang);
    assert.deepEqual(
      section.children.map((c) => word(withStock(c, counts), lang)),
      own.children.map((c) => word(c, lang)),
      `${lang}: the rows`
    );
  }
  assert.equal(listingStockWord(target, counts, 'ar'), 'كلها متوفرة', 'both products of «maker-tools» are in stock');
  assert.equal(word(withStock(section.children[0], counts), 'ar'), 'متوفر الآن', '«hand-tools»: its one product');
});

test('remembered a minute: coming back, or opening a section from here at any depth, asks nothing — a minute later, once again', async () => {
  const app = world();
  const s = serve(app);
  const tree = await mapPastItsCap(app);
  await follow(open(tree, 'makers-supply', 'maker-tools').shown!, s);
  assert.deepEqual(s.asked, ['/api/catalog/maker-tools/counts']);

  // Back to it; on to «hand-tools», whose own row «saws» is a GRANDCHILD of «maker-tools»; on to «saws».
  for (const sub of ['maker-tools', 'hand-tools', 'saws']) {
    const { target, shown } = open(tree, 'makers-supply', sub);
    let got: Map<string, SectionStock> | null = null;
    followSectionStock(shown!, (counts) => {
      got = counts;
    });
    assert.ok(got, `${sub}: handed over at once, from memory`);
    assert.notEqual(listingStockWord(target, got, 'ar'), null, `${sub}: and the header has its word at once`);
  }
  await s.settled();
  assert.deepEqual(s.asked, ['/api/catalog/maker-tools/counts'], 'nothing more was asked');

  // A minute later the memory has lapsed: one request again, for the section opened.
  const realNow = Date.now;
  const later = realNow() + 61_000;
  Date.now = () => later;
  try {
    assert.ok(await follow(open(tree, 'makers-supply', 'hand-tools').shown!, s));
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(s.asked, ['/api/catalog/maker-tools/counts', '/api/catalog/hand-tools/counts']);
});

test('by id when the slug is too long to ask by; an Arabic slug travels encoded — each the very path the Worker answers', async () => {
  const long = `hand-tools-${'x'.repeat(LISTING_SLUG_MAX)}`;
  const arabic = slugify('عدد يدوية', 'x');
  assert.equal(arabic, 'عدد-يدوية', 'an admin may name a section in Arabic: its slug keeps the letters');
  for (const [slug, path] of [
    [long, `/api/catalog/${DEEP.hand}/counts`],
    [arabic, `/api/catalog/${encodeURIComponent(arabic)}/counts`],
  ]) {
    forgetSectionStock();
    const app = world(`UPDATE catalogs SET slug = '${slug}' WHERE id = '${DEEP.hand}'`);
    const s = serve(app);
    const counts = await follow(open(await mapPastItsCap(app), 'makers-supply', slug).shown!, s);
    assert.deepEqual(s.asked, [path], slug);
    assert.deepEqual([...(counts?.keys() ?? [])], [DEEP.hand, DEEP.saws], `${path}: the Worker answered it`);
  }
});

test('a page that moved on is handed nothing, though the answer is remembered; a failure hands nothing, remembers nothing and is never unhandled', async () => {
  const unhandled: unknown[] = [];
  const note = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', note);
  try {
    const app = world();
    const { shown } = open(await mapPastItsCap(app), 'makers-supply', 'maker-tools');
    let handed = 0;
    const hand = () => {
      handed += 1;
    };

    const failing = serve(app, { fail: true });
    followSectionStock(shown!, hand);
    await failing.settled();
    assert.deepEqual(failing.asked, ['/api/catalog/maker-tools/counts']);
    assert.equal(handed, 0, 'a failure: the line goes without its word');

    const s = serve(app);
    const stop = followSectionStock(shown!, hand);
    stop();
    await s.settled();
    assert.deepEqual(s.asked, ['/api/catalog/maker-tools/counts'], 'nothing was remembered from the failure: asked again');
    assert.equal(handed, 0, 'the page moved on before the answer: nothing handed over');
    followSectionStock(shown!, hand);
    assert.equal(handed, 1, 'but the answer was remembered: the next visit has it at once');
    await s.settled();
    assert.deepEqual(s.asked, ['/api/catalog/maker-tools/counts']);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], 'no rejection left unobserved');
  } finally {
    process.off('unhandledRejection', note);
  }
});

test('nothing is asked where nothing is needed: a map that counted, a root’s «all» — the map’s, or an inactive root’s the category route names', async () => {
  // A map that counted (a shop under its cap): the header says the map's own word, and nothing is asked.
  const app = world();
  const s = serve(app);
  const counted = open((await json(await app.request('/api/catalog/tree'))) as CatalogTreeResponse, 'makers-supply', 'maker-tools');
  assert.equal(asksSectionStock(counted.shown), false);
  assert.equal(listingStockWord(counted.target, null, 'ar'), 'كلها متوفرة');
  // The map's root at its «all»: the whole department — no section, nothing asked, no word.
  const all = open(await mapPastItsCap(app), 'makers-supply', 'all');
  assert.deepEqual([all.target.wholeRoot, all.shown], [true, null]);
  assert.equal(asksSectionStock(all.shown), false);
  assert.equal(listingStockWord(all.target, null, 'ar'), null);
  assert.deepEqual(s.asked, []);

  // An INACTIVE root: the map leaves it out, so the page asks the category route, as its fallback does.
  const inactive = world(`UPDATE catalogs SET active = 0 WHERE id = 'cat_makers'`);
  const t = serve(inactive);
  const map = await mapPastItsCap(inactive);
  assert.equal(resolveListingRoute(map.roots, 'makers-supply', 'all'), null, 'not on the map');
  const fallback = async (lookup: string) => {
    const p = await loadCategory(lookup);
    return { node: p.node, root: !p.node.parent_id };
  };
  const rootAll = listingTarget(null, await fallback('makers-supply'))!;
  assert.deepEqual([rootAll.canonical, rootAll.wholeRoot], ['/categories/makers-supply/all', true]);
  assert.equal(listingSection(rootAll), null);
  assert.equal(asksSectionStock(listingSection(rootAll)), false);
  assert.equal(listingStockWord(rootAll, null, 'ar'), null, 'its «all» is the whole department: no section word');
  // A section under it: its own word, from the category route's own counts — nothing more is asked.
  const section = listingTarget(null, await fallback('maker-tools'))!;
  assert.equal(section.wholeRoot, false);
  assert.equal(asksSectionStock(listingSection(section)), false, 'the category route counted it');
  assert.equal(listingStockWord(section, null, 'ar'), 'كلها متوفرة');
  await t.settled();
  assert.deepEqual(t.asked, ['/api/catalog/makers-supply', '/api/catalog/maker-tools'], 'the fallback’s own reads, never a counts');
});

test('the page composes exactly these: one target, its one section, the counts through followSectionStock, the word through listingStockWord', () => {
  const page = readFileSync(join(ROOT, 'src/pages/CategoryListing.tsx'), 'utf8');
  for (const line of [
    'const target = listingTarget(route, fallback);',
    'const shown = listingSection(target);',
    'const stockSlug = asksSectionStock(shown) ? shown.slug : null;',
    'return followSectionStock(shown, (counts) => setStock({ slug: stockSlug, counts }));',
    'bannerRows((shown?.children ?? []).map((c) => withStock(c, counts)), [])',
    'stock: listingStockWord(target, stock && stock.slug === node.slug ? stock.counts : null, lang),',
    '.then((p) => alive && setFallback({ node: p.node, root: !p.node.parent_id }))',
  ]) {
    assert.ok(page.includes(line), line);
  }
  // The section's page is read only for a section the map leaves out, never for its counts; the counts are
  // asked and remembered in one place (src/lib/catalog/sectionStock.ts).
  assert.deepEqual(page.match(/loadCategory\([^)]*\)/g), ['loadCategory(lookup)']);
  assert.doesNotMatch(page, /\b(loadSectionCounts|rememberSectionStock|rememberedSectionStock)\b/);
});
