/**
 * A FAILED READ IS NOT AN EMPTY ANSWER — the merchant workspace (review of
 * the merchant page, 2026-09-28).
 *
 * Every screen below used to answer a failed request with the EMPTY state:
 * «ليس لديك متجر بعد» and a PLUS upsell for a merchant with a live store, «no
 * reviews», «no services», «no printers», an empty order book — and, worst,
 * an untracked EMPTY SHELF in the material stock, whose «ابدأ التتبّع» saves a
 * shelf that REPLACES the real one on the server. Each now keeps what it has,
 * or shows the failure with a retry. These pins keep the fallbacks from
 * coming back; the flows themselves run in scripts/e2e-merchant-workspace.mjs.
 *
 * Run: node --import tsx --test tests/merchantLoadFailures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
/** The source without its comments — the comments quote the old fallbacks they replaced. */
const src = (p: string) =>
  readFileSync(join(ROOT, 'src', p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('the workspace gate: a failed reload keeps the store it has; only a first failure is shown, with a retry', () => {
  const page = src('pages/MerchantDashboardPage.tsx');
  assert.doesNotMatch(page, /setMe\(null\)/, 'a dropped request must never read as «no store»');
  assert.match(page, /\.catch\(\(e: unknown\) => setError\(e\)\)/);
  assert.match(page, /if \(!me\) \{\s*return \(\s*<div[^>]*data-merchant-load-failed>\s*<ErrorState error=\{error\} onRetry=\{retry\}/);
  // «no store yet» only for an ANSWER that says so.
  assert.match(page, /if \(!me\.store\) \{/);
});

test('onboarding: a failed /me is a failure with a retry, not the PLUS upsell; a stale slug answer is ignored', () => {
  const page = src('pages/MerchantStart.tsx');
  assert.match(page, /data-merchant-start-failed/);
  assert.match(page, /\.catch\(\(e: unknown\) => alive && setLoadError\(e\)\)/);
  assert.match(page, /e\.code === 'STORE_EXISTS'/);
  assert.match(page, /e\.code === 'STORE_FIELD_INVALID'/);
});

test('material stock: a shelf that did not load is not an empty shelf — nothing is editable until a real answer', () => {
  const stock = src('components/merchant/workshop/MaterialStockSection.tsx');
  assert.doesNotMatch(stock, /setData\(\{ tracked: false, stock: \[\]/, 'the fake empty shelf is gone');
  assert.match(stock, /\.catch\(\(e: unknown\) => setLoadError\(e\)\)/);
  assert.match(stock, /data-stock-load-failed>\s*<ErrorState/);
});

test('reviews, services, showcase, printers, custom orders, coupons, an order: failure is shown, never «none»', () => {
  const cases: Array<[string, RegExp[]]> = [
    ['components/merchant/shell/sections/ReviewsSection.tsx', [/\.catch\(\(e: unknown\) => setLoadError\(e\)\)/, /loadError \? <ErrorState compact error=\{loadError\} onRetry=\{load\} \/>/]],
    ['components/merchant/dashboard/PrintersTab.tsx', [/\.catch\(\(e: unknown\) => setLoadError\(e\)\)/, /loadError \? <ErrorState compact error=\{loadError\} onRetry=\{load\} \/>/]],
  ];
  for (const [file, patterns] of cases) {
    const code = src(file);
    for (const p of patterns) assert.match(code, p, `${file}: ${p}`);
  }
  // Two loaders in the catalogue (services, showcase), three in sales (order, custom orders, coupons).
  const catalog = src('components/merchant/dashboard/CatalogTabs.tsx');
  assert.equal(catalog.match(/\.catch\(\(e: unknown\) => setLoadError\(e\)\)/g)?.length, 2);
  assert.doesNotMatch(catalog, /\.catch\(\(\) => setItems\(\[\]\)\)/);
  const sales = src('components/merchant/dashboard/SalesTabs.tsx');
  assert.ok((sales.match(/setLoadError\(e\)\)/g)?.length ?? 0) >= 3);
  assert.doesNotMatch(sales, /\.catch\(\(\) => setOrders\(\[\]\)\)/);
  assert.doesNotMatch(sales, /merchantApi\.order\(id\)\.then\(setData\)\.catch\(\(\) => \{\}\)/, 'the order spinner that never stopped');
});

test('a service edit sends `active` only when it changed — a paused store can still fix a typo', () => {
  const catalog = src('components/merchant/dashboard/CatalogTabs.tsx');
  assert.match(catalog, /\.\.\.\(!service \|\| service\.active !== f\.active \? \{ active: f\.active \} : \{\}\)/);
});

test('the store picture picker speaks the merchant\'s language, not the server\'s English', () => {
  const picker = src('components/media/ImagePicker.tsx');
  assert.match(picker, /refusalText\(/);
  assert.doesNotMatch(picker, /setError\(e\.message\)|err\.message\}/);
});
