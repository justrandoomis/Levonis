/**
 * A PRODUCT'S WORDS IN THE READER'S LANGUAGE (review of Levo Community,
 * 2026-09-28): the community's product tile gave an Arabic reader the
 * merchant's Arabic name; the store's own product page and product cards
 * printed `name` to everyone. One rule now (src/lib/productText.ts), used by
 * all three.
 *
 * Run: node --import tsx --test tests/productText.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { productDescription, productName } from '../src/lib/productText';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the Arabic words for an Arabic reader when the merchant wrote them; the name as written otherwise', () => {
  const both = { name: 'Shelf bracket', name_ar: 'حامل رف', description: 'PETG', description_ar: 'بتج' };
  assert.equal(productName(both, 'ar'), 'حامل رف');
  assert.equal(productName(both, 'en'), 'Shelf bracket');
  assert.equal(productName(both, 'ckb'), 'Shelf bracket', 'no Sorani field: the name as written');
  assert.equal(productDescription(both, 'ar'), 'بتج');
  assert.equal(productDescription(both, 'en'), 'PETG');
  assert.equal(productName({ name: 'حامل رف', name_ar: '' }, 'ar'), 'حامل رف', 'no Arabic name: the one written');
  assert.equal(productName({ name: '', name_ar: 'حامل رف' }, 'en'), 'حامل رف', 'only an Arabic name: shown to everyone');
  assert.equal(productDescription({ name: 'x', description: null, description_ar: null }, 'ar'), '');
});

test('the store\'s product page and cards use it, as the community tile does', () => {
  const page = code('src/pages/StorefrontProduct.tsx');
  assert.match(page, /const name = productName\(product, lang\);\s*const description = productDescription\(product, lang\);/);
  assert.match(page, /<h1 className="text-white font-bold text-\[18px\] leading-snug mb-2" dir="auto">\{name\}<\/h1>/);
  assert.doesNotMatch(page, /\{product\.name\}|\{product\.description\}/);
  const card = code('src/components/storefront/parts.tsx');
  assert.match(card, /const name = productName\(product, lang\);/);
  assert.match(card, /alt=\{name\}/);
  assert.match(code('src/components/community/hub/ProductTile.tsx'), /const name = productName\(p, lang\);/);
});

test('the store\'s product page can be saved and shared — a lazy chunk, off the store pages\' budget', () => {
  const page = code('src/pages/StorefrontProduct.tsx');
  assert.match(page, /const ProductActions = lazy\(\(\) => import\('\.\.\/components\/community\/ProductActions'\)\);/);
  assert.match(page, /<Suspense fallback=\{<div className="h-11 w-\[96px\] shrink-0" aria-hidden="true" \/>\}>\s*<ProductActions productId=\{product\.id\} name=\{name\} \/>/);
  const actions = code('src/components/community/ProductActions.tsx');
  assert.match(actions, /\(want \? communityFavoritesApi\.add\(productId\) : communityFavoritesApi\.remove\(productId\)\)\s*\.catch\(\(\) => setSaved\(!want\)\)/, 'a refusal puts the heart back');
  assert.match(actions, /if \(busy\.current\) return;/, 'a second tap in flight is dropped');
  assert.match(actions, /aria-pressed=\{saved\}/);
  assert.match(actions, /await navigator\.clipboard\.writeText\(url\);/, 'no share sheet: the address is copied and said');
  // A fact left out of the answer is as unstated as a null one.
  const facts = code('src/components/catalog/ProductFacts.tsx');
  assert.match(facts, /if \(attributes\.weight_g != null\)/);
});

test('the preparation time is a counted phrase — «يومين», not «2 يوم»; «1 day», not «1 days»', () => {
  const page = code('src/pages/StorefrontProduct.tsx');
  assert.match(page, /if \(n === 1\) return 'يوم واحد';\s*if \(n === 2\) return 'يومين';/);
  assert.match(page, /if \(r >= 3 && r <= 10\) return `\$\{n\} أيام`;\s*if \(r >= 11 && r <= 99\) return `\$\{n\} يومًا`;\s*return `\$\{n\} يوم`;/);
  assert.match(page, /`يجهّز خلال \$\{arDays\(product\.prep_days\)\}`/);
  assert.match(page, /product\.prep_days === 1 \? 'day' : 'days'/);
  assert.doesNotMatch(page, /`يجهّز خلال \$\{product\.prep_days\} يوم`/);
});
