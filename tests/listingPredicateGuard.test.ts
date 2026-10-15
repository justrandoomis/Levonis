/**
 * NO CUSTOMER SURFACE MAY ASK `status = 'active'` OF `products` ON ITS OWN, AND
 * EVERY CALLER NAMES WHICH QUESTION IT ASKS (owner brief 2026-10-10;
 * DECISIONS rows 239 (3) and 240; worker/lib/listing.ts).
 *
 * Two predicates since the catalog-only release:
 *   VISIBLE  — may a customer SEE it (the listing, the page, the API, compare…)
 *   SELLABLE — may a customer BUY it (every purchase door: the old «listed»)
 *
 * The guard:
 *   1. no raw `status = 'active'` on `products` in a customer file;
 *   2. every allow-listed raw line still exists;
 *   3. a SELLABLE-only file (a purchase door) never asks VISIBLE — its one
 *      visible-then-refuse lookup goes through `refuseIfOnlyCatalog`;
 *   4. a count table per file: any new caller changes a count, and the test
 *      says "reclassify this site in docs and here" — the review gate;
 *   5. the old ambiguous names are gone from every code line under worker/;
 *   6. the predicates themselves: SELLABLE is the old clause byte for byte,
 *      VISIBLE carries exactly the catalog-blocking codes and never a price;
 *   7. no raw `price_iqd || 0` / `?? 0` read of a `products` row on a VISIBLE
 *      surface — a catalog-only product's row still holds its archived dinar
 *      ladder (migration 0190 updates no row).
 *
 * In-memory checks (`row.status === 'active'`) are not SQL and are left out:
 * the cart and checkout rewrite an unsellable line's status in memory first.
 *
 * Run: node --import tsx --test tests/listingPredicateGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from './fixtures/d1';
import { CATALOG_BLOCKING_CODES } from '../packages/contracts/src/productCompleteness';
import { sellableSql, visibleSql } from '../worker/lib/listing';

/** The customer-facing files that read platform products (design §(c); spec §2). */
const CUSTOMER_FILES = [
  'worker/routes/products.ts',
  'worker/lib/homeShelves.ts',
  'worker/lib/catalogMembership.ts',
  'worker/lib/catalogPresentation.ts',
  'worker/routes/catalog.ts',
  'worker/routes/printerFinder.ts',
  'worker/lib/printerFits.ts',
  'worker/routes/compare.ts',
  'worker/routes/support.ts',
  'worker/routes/communitySearch.ts',
  'worker/routes/communityFavorites.ts',
  'worker/routes/profile.ts',
  'worker/lib/socialPreview.ts',
  'worker/routes/seo.ts',
  'worker/lib/publicApi/resources/products.ts',
  'worker/lib/publicApi/resources/shop.ts',
  'worker/lib/publicApi/resources/catalog.ts',
  'worker/lib/publicApi/meta.ts',
  'worker/routes/cart.ts',
  'worker/routes/orders.ts',
  'worker/lib/quickBuy/session.ts',
  'worker/lib/quickBuy/finalize.ts',
  'worker/routes/bundles.ts',
  'worker/lib/bundleRead.ts',
  'worker/lib/bundleComposition.ts',
  'worker/lib/mysteryDraw.ts',
  'worker/routes/priceReports.ts',
  'worker/lib/tradeIn.ts',
  // Services S-P2 (DECISIONS row 238): the device a credit buys and its new price today — purchase-side.
  'worker/lib/tradeInTargets.ts',
  'worker/lib/tradeInToday.ts',
  'worker/lib/printQuote/repository.ts',
  // DECISIONS row 240 (spec §2.1): every site the split classified.
  'worker/lib/gifts/selection.ts',
  'worker/lib/stockAlertResolve.ts',
  'worker/routes/stockAlerts.ts',
  'worker/routes/communityPosts.ts',
  'worker/routes/reviews.ts',
  'worker/routes/returns.ts',
  'worker/entrypoints/CatalogEntrypoint.ts',
  // The Bambu import spec §G.1: the knowledge answer links a relation's target only while it is VISIBLE.
  'worker/lib/knowledge/productKnowledge.ts',
];

/** Reviewed lines that are NOT a platform product's visibility: file → substrings, each with its reason. */
const ALLOWED: Record<string, Array<[string, string]>> = {
  'worker/routes/products.ts': [["cp.slug = ? AND cp.status = 'active'", 'community_products (a merchant listing)']],
  'worker/routes/communityFavorites.ts': [
    ["p.status = 'active' AND p.lifecycle = 'active'", 'community_products'],
    ["FROM community_products WHERE id = ? AND status = 'active'", 'community_products'],
  ],
  'worker/lib/socialPreview.ts': [
    ["p.slug = ?1 AND p.status = 'active' AND p.lifecycle = 'active'", 'community_products'],
    ["WHERE p.slug = ? AND p.status = 'active'", 'community_products (the merchant fallback after the platform read)'],
  ],
  'worker/routes/seo.ts': [["p.lifecycle = 'active' AND p.status = 'active'", "a store's sitemap: community_products"]],
  'worker/routes/orders.ts': [["wr.status = 'active'", 'warranty_receipts']],
  'worker/lib/tradeIn.ts': [["AND status = 'active'`", 'trade-in claims by order item, not products']],
};

const SQL_ACTIVE = /\bstatus\s*=\s*'active'/;
const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);
const codeLines = (file: string) =>
  readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter((l) => !isComment(l.line));

test('every customer file asks a listing predicate, never a raw `status = \'active\'` on products', () => {
  const problems: string[] = [];
  for (const file of CUSTOMER_FILES) {
    const allowed = ALLOWED[file] ?? [];
    for (const { line, n } of codeLines(file)) {
      if (!SQL_ACTIVE.test(line)) continue;
      if (allowed.some(([s]) => line.includes(s))) continue;
      problems.push(`${file}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(problems, [], 'a customer read must use listing(db).visible(alias) or .sellable(alias) (worker/lib/listing.ts)');
});

test('each allow-listed line still exists (a stale entry would hide a new raw check behind an old reason)', () => {
  const stale: string[] = [];
  for (const [file, entries] of Object.entries(ALLOWED)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [s, why] of entries) if (!text.includes(s)) stale.push(`${file}: «${s}» (${why})`);
  }
  assert.deepEqual(stale, []);
});

// ------------------------------------------------------------- the families

const VISIBLE_CALL = /\.visible\(|optimisticVisible\(|visibleSql\(|invisibleIds\(|isVisibleRow\(|visibleProductBySlug\(|refuseIfOnlyCatalog\(/g;
const SELLABLE_CALL =
  /\.sellable\(|\.sellableFlag\(|optimisticSellable\(|optimisticSellableFlag\(|sellableSql\(|sellableFlagSql\(|unsellableIds\(|isSellableRow\(|sellableProductBySlug\(|isUnsellable\(|sellableAndCatalogOnly\(/g;
const STATES_CALL = /statesOf\(/g;

function countCalls(file: string): { visible: number; sellable: number; states: number } {
  let visible = 0;
  let sellable = 0;
  let states = 0;
  for (const { line } of codeLines(file)) {
    visible += (line.match(VISIBLE_CALL) ?? []).length;
    sellable += (line.match(SELLABLE_CALL) ?? []).length;
    states += (line.match(STATES_CALL) ?? []).length;
  }
  return { visible, sellable, states };
}

/**
 * THE PURCHASE DOORS (spec §2.1 test 1). They ask SELLABLE only; the one VISIBLE
 * question allowed is `refuseIfOnlyCatalog` — "is it still shown? then 409
 * PRICE_NOT_AVAILABLE, else the door's own 404" — counted here.
 */
const SELLABLE_ONLY: Record<string, number> = {
  'worker/routes/cart.ts': 1,
  'worker/routes/orders.ts': 0,
  'worker/lib/quickBuy/session.ts': 1,
  'worker/lib/quickBuy/finalize.ts': 0,
  'worker/lib/gifts/selection.ts': 0,
  'worker/lib/bundleComposition.ts': 0,
  'worker/lib/bundleRead.ts': 0,
  'worker/routes/bundles.ts': 0,
  'worker/lib/mysteryDraw.ts': 0,
  'worker/lib/tradeIn.ts': 0,
  'worker/lib/tradeInTargets.ts': 0,
  'worker/lib/tradeInToday.ts': 0,
  'worker/routes/priceReports.ts': 1,
  'worker/lib/printQuote/repository.ts': 0,
  'worker/lib/stockAlertResolve.ts': 0,
  'worker/routes/stockAlerts.ts': 2,
  'worker/routes/returns.ts': 0,
};

/**
 * BANNED IN A PURCHASE FILE: every VISIBLE question, and `statesOf` — it answers 'catalog_only', a VISIBLE
 * fact, so a door admitting `!== 'hidden'` would sell a product with no price while every count stayed the
 * same. A purchase door asks `sellableAndCatalogOnly` instead: a sellable set to admit with, and the
 * catalog-only set only to name its refusal.
 */
const PURCHASE_BANNED = /\.visible\(|optimisticVisible\(|visibleSql\(|invisibleIds\(|isVisibleRow\(|visibleProductBySlug\(|statesOf\(/;

test('a purchase door never asks VISIBLE — only the named visible-then-refuse helper, counted', () => {
  const problems: string[] = [];
  const banned = PURCHASE_BANNED;
  for (const [file, refusals] of Object.entries(SELLABLE_ONLY)) {
    let seen = 0;
    for (const { line, n } of codeLines(file)) {
      if (banned.test(line)) problems.push(`${file}:${n}: ${line.trim()}`);
      seen += (line.match(/refuseIfOnlyCatalog\(/g) ?? []).length;
    }
    if (seen !== refusals) problems.push(`${file}: ${seen} refuseIfOnlyCatalog call(s), expected ${refusals}`);
  }
  assert.deepEqual(problems, [], 'a purchase path asks SELLABLE (worker/lib/listing.ts); reclassify this site in docs and here');
});

/**
 * EVERY CALLER, COUNTED (spec §2.1 test 2; §2's table). A new or moved call
 * changes a number here: reclassify the site in docs/PRICING-V2.md
 * («catalog-only products») and here, on purpose.
 */
const EXPECTED_CALLS: Record<string, { visible: number; sellable: number; states: number }> = {
  'worker/entrypoints/CatalogEntrypoint.ts': { visible: 0, sellable: 0, states: 1 },
  'worker/lib/bundleComposition.ts': { visible: 0, sellable: 1, states: 0 },
  'worker/lib/bundleRead.ts': { visible: 0, sellable: 1, states: 0 },
  'worker/lib/catalogMembership.ts': { visible: 1, sellable: 0, states: 0 },
  'worker/lib/catalogPresentation.ts': { visible: 0, sellable: 0, states: 0 },
  'worker/lib/gifts/selection.ts': { visible: 0, sellable: 4, states: 0 },
  'worker/lib/homeShelves.ts': { visible: 0, sellable: 8, states: 0 },
  'worker/lib/mysteryDraw.ts': { visible: 0, sellable: 3, states: 0 },
  'worker/lib/printQuote/repository.ts': { visible: 0, sellable: 2, states: 0 },
  'worker/lib/printerFits.ts': { visible: 3, sellable: 0, states: 0 },
  'worker/lib/publicApi/meta.ts': { visible: 1, sellable: 2, states: 0 },
  'worker/lib/publicApi/resources/catalog.ts': { visible: 1, sellable: 0, states: 0 },
  'worker/lib/publicApi/resources/products.ts': { visible: 2, sellable: 1, states: 0 },
  'worker/lib/publicApi/resources/shop.ts': { visible: 0, sellable: 1, states: 0 },
  'worker/lib/quickBuy/finalize.ts': { visible: 0, sellable: 0, states: 0 },
  'worker/lib/quickBuy/session.ts': { visible: 1, sellable: 2, states: 0 },
  'worker/lib/socialPreview.ts': { visible: 1, sellable: 0, states: 0 },
  'worker/lib/stockAlertResolve.ts': { visible: 0, sellable: 1, states: 0 },
  'worker/lib/tradeIn.ts': { visible: 0, sellable: 2, states: 0 },
  // S-P2: the target search and the product page's entry (`isListedDeviceTarget`), and «سعر اليوم» — SELLABLE.
  'worker/lib/tradeInTargets.ts': { visible: 0, sellable: 2, states: 0 },
  'worker/lib/tradeInToday.ts': { visible: 0, sellable: 1, states: 0 },
  'worker/routes/bundles.ts': { visible: 0, sellable: 2, states: 0 },
  'worker/routes/cart.ts': { visible: 1, sellable: 3, states: 0 },
  'worker/routes/catalog.ts': { visible: 2, sellable: 2, states: 0 },
  'worker/routes/communityFavorites.ts': { visible: 1, sellable: 1, states: 0 },
  'worker/routes/communityPosts.ts': { visible: 3, sellable: 0, states: 0 },
  'worker/routes/communitySearch.ts': { visible: 2, sellable: 0, states: 0 },
  'worker/routes/compare.ts': { visible: 3, sellable: 3, states: 1 },
  'worker/routes/orders.ts': { visible: 0, sellable: 3, states: 0 },
  'worker/routes/priceReports.ts': { visible: 1, sellable: 1, states: 0 },
  'worker/routes/printerFinder.ts': { visible: 1, sellable: 1, states: 0 },
  // +1 VISIBLE: `/:slug/knowledge` is gated on the product page's own question (the Bambu import spec §G.1).
  'worker/routes/products.ts': { visible: 8, sellable: 12, states: 0 },
  // The knowledge answer's relation targets: a link only to a VISIBLE product (§B.6), else the label alone.
  'worker/lib/knowledge/productKnowledge.ts': { visible: 1, sellable: 0, states: 0 },
  'worker/routes/profile.ts': { visible: 2, sellable: 1, states: 0 },
  'worker/routes/returns.ts': { visible: 0, sellable: 2, states: 0 },
  'worker/routes/reviews.ts': { visible: 2, sellable: 0, states: 0 },
  'worker/routes/seo.ts': { visible: 1, sellable: 0, states: 0 },
  'worker/routes/stockAlerts.ts': { visible: 2, sellable: 0, states: 0 },
  'worker/routes/support.ts': { visible: 4, sellable: 5, states: 0 },
  // «طلب السعر» (migration 0193): the request door's validation (`validatePriceRequestSelection`, shared with the
  // Bambu import's /complete, its spec §K.1 D-5) asks VISIBLE and the SELLABLE flag; the sweep asks each
  // product's state. The door itself (worker/routes/priceRequests.ts) asks neither.
  'worker/routes/priceRequests.ts': { visible: 0, sellable: 0, states: 0 },
  'worker/lib/priceRequests.ts': { visible: 1, sellable: 1, states: 1 },
};

/** Every .ts under worker/, relative to the repository root. */
function workerSources(dir = join(ROOT, 'worker'), out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) workerSources(p, out);
    else if (name.endsWith('.ts')) out.push(relative(ROOT, p).split('\\').join('/'));
  }
  return out;
}

/** Files that call the predicates for a reason that is not a customer read (admin, sweeps), reviewed. */
const NOT_CUSTOMER_CALLERS = new Set<string>([
  'worker/lib/listing.ts',
  // The admin's «ظاهر بلا سعر» count (stats `shown_unpriced`): visible and not sellable, an owner screen.
  'worker/routes/adminProducts.ts',
  // The Bambu import's own D1 recompute before COMPLETE (import spec §I.1.10): one `statesOf` asks whether the
  // product it just wrote is visible and not sellable. A check the Worker runs for the import, not a customer read.
  'worker/lib/catalogImport/verifyD1.ts',
]);

test('the count of each predicate family per file is the reviewed one (reclassify this site in docs and here)', () => {
  const diffs: string[] = [];
  for (const [file, want] of Object.entries(EXPECTED_CALLS)) {
    const got = countCalls(file);
    if (got.visible !== want.visible || got.sellable !== want.sellable || got.states !== want.states) {
      diffs.push(`${file}: got ${JSON.stringify(got)}, reviewed ${JSON.stringify(want)} — reclassify this site in docs and here`);
    }
  }
  assert.deepEqual(diffs, []);
  for (const file of CUSTOMER_FILES) assert.ok(file in EXPECTED_CALLS, `${file} is not counted`);
  // Nothing under worker/ calls a predicate outside the table.
  const callers: string[] = [];
  for (const file of workerSources()) {
    if (NOT_CUSTOMER_CALLERS.has(file) || file in EXPECTED_CALLS) continue;
    const got = countCalls(file);
    if (got.visible + got.sellable + got.states > 0) callers.push(`${file}: ${JSON.stringify(got)}`);
  }
  assert.deepEqual(callers, [], 'a new caller of the listing predicates: classify it in spec §2 and count it here');
});

test('the old ambiguous names are gone from every code line under worker/', () => {
  const OLD = /\.listed\(|\bunlistedIds\b|\bheldIds\b|\bisListedRow\b|\boptimisticListed\b|\blistedProductBySlug\b|\blistedSql\b|\bisHeld\(|\blistedWithoutHeld\b/;
  const hits: string[] = [];
  for (const file of workerSources()) {
    for (const { line, n } of codeLines(file)) if (OLD.test(line)) hits.push(`${file}:${n}: ${line.trim()}`);
  }
  assert.deepEqual(hits, [], 'name the question: visible(…) or sellable(…) (worker/lib/listing.ts)');
});

test('the predicates themselves: SELLABLE is the old clause, VISIBLE carries exactly the catalog-blocking codes and never a price', () => {
  const text = readFileSync(join(ROOT, 'worker/lib/listing.ts'), 'utf8');
  // SELLABLE keeps the sale-held clause and the clean start's V2 clause (DECISIONS row 222, addendum A.4.1).
  assert.match(text, /NOT EXISTS \(SELECT 1 FROM product_completeness pch WHERE pch\.product_id = \$\{alias\}\.id AND pch\.held = 1\)/);
  assert.match(
    text,
    /AND EXISTS \(SELECT 1 FROM product_pricing_state pv2 WHERE pv2\.product_id = \$\{alias\}\.id AND pv2\.mode = 'engine' AND pv2\.pricing_method IS NOT NULL AND EXISTS \(SELECT 1 FROM pricing_v2_sku_results rv2 WHERE rv2\.product_id = \$\{alias\}\.id\)\)/
  );
  assert.match(text, /return `\$\{active\}\$\{held\}\$\{v2 \? v2Clause\(alias\) : ' AND 0'\}`/, 'without 0189 nothing is sellable (fail closed)');
  assert.equal(
    sellableSql('p', true, false),
    "p.status = 'active' AND NOT EXISTS (SELECT 1 FROM product_completeness pch WHERE pch.product_id = p.id AND pch.held = 1) AND 0"
  );
  assert.match(sellableSql('p', false), /^p\.status = 'active' AND EXISTS \(SELECT 1 FROM product_pricing_state pv2/);
  // VISIBLE: the catalog hold with exactly the contract's codes, and no price at all.
  const v = visibleSql('p', true);
  const codes = CATALOG_BLOCKING_CODES.map((c) => `'${c}'`).join(',');
  assert.equal(
    v,
    `p.status = 'active' AND NOT EXISTS (SELECT 1 FROM product_completeness pcv WHERE pcv.product_id = p.id AND pcv.held = 1 AND EXISTS (SELECT 1 FROM json_each(pcv.missing_json) jcv WHERE json_extract(jcv.value, '$.c') IN (${codes})))`
  );
  assert.deepEqual([...CATALOG_BLOCKING_CODES], ['IMAGE', 'CATEGORY']);
  assert.doesNotMatch(v, /pricing_v2_sku_results|product_pricing_state|price/, 'visibility never depends on a price');
  assert.equal(visibleSql('p', false), "p.status = 'active'");
  // Every customer file reads through the predicate (or the membership CTE that embeds it).
  for (const file of CUSTOMER_FILES) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(
      /from '(\.\.\/)*(lib\/)?listing'|from '\.\/listing'|from '\.\.\/listing'|from '\.\.\/\.\.\/listing'|membershipCte|loadCompositionMembers\(/.test(src),
      `${file} reads through the predicate`
    );
  }
});

/**
 * A RAW PRICE READ ON A VISIBLE SURFACE (spec §2.1 test 5). A catalog-only
 * product's row holds its archived dinar ladder; a price reaches a customer only
 * through `publicWithDisplayPrice`, `levelPrice` or the `sellable_now`-gated
 * helpers (`rowPriceIfSellable`). The lines below are reviewed: each reads a
 * row the SELLABLE predicate already chose.
 */
const RAW_PRICE = /Number\([^)]*\.price_iqd\) \|\| 0|price_iqd \?\? 0|price_iqd\) \|\| 0/;
const RAW_PRICE_FILES = [
  'worker/routes/products.ts',
  'worker/routes/compare.ts',
  'worker/routes/support.ts',
  'worker/routes/profile.ts',
  'worker/routes/communityFavorites.ts',
  'worker/routes/printerFinder.ts',
  'worker/routes/catalog.ts',
  'worker/lib/printerFits.ts',
  'worker/routes/communitySearch.ts',
  'worker/lib/socialPreview.ts',
  'worker/routes/seo.ts',
  'worker/lib/publicApi/resources/products.ts',
  'worker/lib/publicApi/resources/catalog.ts',
  'worker/lib/publicApi/common.ts',
  'worker/entrypoints/CatalogEntrypoint.ts',
  'worker/routes/communityPosts.ts',
  'worker/routes/reviews.ts',
];
const RAW_PRICE_ALLOWED: Record<string, Array<[string, string]>> = {
  'worker/routes/products.ts': [
    ['const price = Number(row.price_iqd) || 0;', '/print-calculator: rows read through the SELLABLE predicate'],
    ['conditionSaving(Number(parsed.price_iqd) || 0', 'the graded unit, in the SELLABLE branch of the page only'],
    ['referencePrices.set(String(r.id), Number(r.price_iqd) || 0)', 'open-box reference prices: a SELLABLE read'],
    ['Number(card.display_price_iqd ?? card.price_iqd ?? 0)', 'the open-box shelf: SELLABLE rows, priced cards'],
  ],
};

test('no raw `price_iqd || 0` / `?? 0` read of a products row on a VISIBLE surface', () => {
  const hits: string[] = [];
  for (const file of RAW_PRICE_FILES) {
    const allowed = RAW_PRICE_ALLOWED[file] ?? [];
    for (const { line, n } of codeLines(file)) {
      if (!RAW_PRICE.test(line)) continue;
      if (allowed.some(([s]) => line.includes(s))) continue;
      hits.push(`${file}:${n}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], 'a catalog-only row would publish its archived price: read it through rowPriceIfSellable or the card');
  for (const [file, entries] of Object.entries(RAW_PRICE_ALLOWED)) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    for (const [s, why] of entries) assert.ok(src.includes(s), `${file}: stale allow-list entry «${s}» (${why})`);
  }
});
