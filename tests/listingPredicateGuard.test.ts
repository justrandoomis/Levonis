/**
 * NO NEW CUSTOMER SURFACE MAY ASK `status = 'active'` OF `products` ON ITS OWN
 * (owner brief 2026-10-10; worker/lib/listing.ts).
 *
 * «إخفاء المنتجات الناقصة عن الزبائن» works only if every customer read asks
 * the ONE predicate — active AND not held by the owner's switch. Before it
 * there were some sixty raw `status = 'active'` checks with no helper; a new
 * one written tomorrow would quietly show a held product again. This walks
 * the customer files and fails on any SQL `status = 'active'` that is not in
 * the reviewed list below — each entry another table (a merchant's own
 * products, a warranty receipt, a restriction case) or a composition row,
 * which is never held (a held member already makes it unavailable).
 *
 * In-memory checks (`row.status === 'active'`) are not SQL and are left out:
 * the cart and checkout rewrite a held line's status in memory first.
 *
 * Run: node --import tsx --test tests/listingPredicateGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

/** The customer-facing files that read platform products (design §(c)). */
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
  'worker/routes/bundles.ts',
  'worker/lib/bundleRead.ts',
  'worker/lib/bundleComposition.ts',
  'worker/lib/mysteryDraw.ts',
  'worker/routes/priceReports.ts',
  'worker/lib/tradeIn.ts',
  'worker/lib/printQuote/repository.ts',
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
  'worker/routes/bundles.ts': [
    ["let where = \"p.status = 'active'\"", 'the bundle rows themselves (compositions are never held)'],
    ["AND status = 'active' AND composition <> ''", 'a composition row (never held)'],
  ],
  'worker/lib/tradeIn.ts': [["AND status = 'active'`", 'trade-in claims by order item, not products']],
};

const SQL_ACTIVE = /\bstatus\s*=\s*'active'/;
const isComment = (line: string) => /^\s*(\*|\/\/|\/\*)/.test(line);

test('every customer file asks the listing predicate, never a raw `status = \'active\'` on products', () => {
  const problems: string[] = [];
  for (const file of CUSTOMER_FILES) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const allowed = ALLOWED[file] ?? [];
    text.split('\n').forEach((line, i) => {
      if (isComment(line) || !SQL_ACTIVE.test(line)) return;
      if (allowed.some(([s]) => line.includes(s))) return;
      problems.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(problems, [], 'a customer read must use listing(db).listed(alias) (worker/lib/listing.ts)');
});

test('each allow-listed line still exists (a stale entry would hide a new raw check behind an old reason)', () => {
  const stale: string[] = [];
  for (const [file, entries] of Object.entries(ALLOWED)) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [s, why] of entries) if (!text.includes(s)) stale.push(`${file}: «${s}» (${why})`);
  }
  assert.deepEqual(stale, []);
});

test('the predicate itself lives in one place and holds back a held row', () => {
  const text = readFileSync(join(ROOT, 'worker/lib/listing.ts'), 'utf8');
  assert.match(text, /NOT EXISTS \(SELECT 1 FROM product_completeness pch WHERE pch\.product_id = \$\{alias\}\.id AND pch\.held = 1\)/);
  for (const file of CUSTOMER_FILES.filter((f) => !['worker/routes/bundles.ts', 'worker/lib/bundleRead.ts'].includes(f))) {
    const text2 = readFileSync(join(ROOT, file), 'utf8');
    assert.ok(/from '(\.\.\/)*(lib\/)?listing'|from '\.\/listing'|from '\.\.\/listing'|from '\.\.\/\.\.\/listing'|membershipCte|loadCompositionMembers\(/.test(text2), `${file} reads through the predicate`);
  }
});
