/**
 * WHERE THE COMPARE TRAY IS DRAWN (CATALOG_DISCOVERY §10.4, stream S3), and
 * how it is wired into the app.
 *
 * The tray floats above the bottom nav on browsing pages. It is hidden where
 * it would cover the page's own job — /compare, the cart, checkout, the
 * finder, the admin, the merchant workspace, and every page with its own
 * sticky purchase bar (the product page, where the top-bar badge stands in
 * for it, and a bundle's page). The wiring half pins the entry-chunk cost:
 * the tray UI is a lazy chunk behind a gate, and the store is the only
 * compare code the entry imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { trayVisibleOn } from '../src/lib/compareTray';
import { badgeLabel, traySubline, trayTitle } from '../src/components/compare/trayStrings';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

test('the tray is drawn on browsing pages', () => {
  for (const path of ['/', '/products', '/products?category=cat_printers', '/categories', '/categories/printers/fdm-printers', '/bundles', '/used-printers', '/support', '/profile']) {
    assert.equal(trayVisibleOn(path.split('?')[0]), true, path);
  }
});

test('the tray is hidden where it would cover the page’s own job', () => {
  for (const path of [
    '/compare',
    '/compare/',
    '/COMPARE',
    '/cart',
    '/checkout',
    '/checkout/success',
    '/printer-finder',
    '/admin',
    '/admin/products',
    '/merchant',
    '/merchant/orders/1',
    '/product/bambu-lab-x2d',
    '/bundles/starter-kit',
    '/chat/42',
    '/auth',
  ]) {
    assert.equal(trayVisibleOn(path), false, path);
  }
});

test('the tray is lazy: the entry imports the gate and the store, never the tray UI', () => {
  const app = read('src/App.tsx');
  assert.match(app, /import CompareTrayGate from '\.\/components\/compare\/CompareTrayGate';/);
  assert.match(app, /<CompareTrayGate \/>/);
  assert.doesNotMatch(app, /components\/compare\/CompareTray'/, 'App must not import the tray UI statically');

  const gate = read('src/components/compare/CompareTrayGate.tsx');
  assert.match(gate, /React\.lazy\(\(\) =>\s*import\('\.\/CompareTray'\)\.catch\(/, 'a failed chunk must render nothing, not crash the shell');
  assert.match(gate, /if \(!armed && count === 0\) return null;/, 'nothing is downloaded until the tray holds a product');

  const store = read('src/lib/compareTray.ts');
  assert.doesNotMatch(store, /from 'react'/, 'the store stays React-free');
  assert.match(store, /addEventListener\('storage'/, 'cross-tab sync');
});

test('the tray answers a refused add, and mounts the only customer-shell Toaster (not on /admin)', () => {
  const tray = read('src/components/compare/CompareTray.tsx');
  assert.match(tray, /useConfirm\(\)/, 'a type conflict asks with the shared ConfirmDialog');
  assert.doesNotMatch(tray, /window\.confirm|\balert\(/);
  assert.match(tray, /notice\.kind === 'full'/);
  assert.match(tray, /duration: 5000,\s*action: \{ label: loc\('تراجع', 'Undo'\), onClick: \(\) => compareTray\.restore\(saved\) \}/, 'clear offers a 5 s undo');
  assert.match(tray, /\{!onAdmin && <Toaster \/>\}/, '/admin mounts its own Toaster');
  assert.match(tray, /count >= 2 \?/, '«قارن» needs two products');
  assert.match(tray, /compareHref\(state\)/);
});

test('the product page shows the tray as a top-bar badge', () => {
  const product = read('src/pages/Product.tsx');
  assert.match(product, /import CompareBadge from '\.\.\/components\/compare\/CompareBadge';/);
  const header = product.slice(product.indexOf('ref={pageHeaderRef}'), product.indexOf('onClick={handleShare}'));
  assert.match(header, /<CompareBadge\b/, 'the badge sits in the product page top bar');
  const badge = read('src/components/compare/CompareBadge.tsx');
  assert.match(badge, /if \(!count\) return null;/, 'nothing is drawn while the tray is empty');
  assert.match(badge, /size-11/, 'a 44 px target');
});

test('the tray counts in Arabic properly', () => {
  assert.equal(trayTitle(1, 'printer', 'ar'), 'طابعة واحدة للمقارنة');
  assert.equal(trayTitle(2, 'printer', 'ar'), 'طابعتان للمقارنة');
  assert.equal(trayTitle(3, 'printer', 'ar'), '3 طابعات للمقارنة');
  assert.equal(trayTitle(2, 'filament', 'ar'), 'منتجان للمقارنة');
  assert.equal(trayTitle(2, 'printer', 'en'), '2 printers to compare');
  assert.equal(traySubline(1, 'printer', 'ar'), 'أضف طابعة أخرى للمقارنة');
  assert.equal(traySubline(2, 'printer', 'ar'), 'يمكنك إضافة طابعتين');
  assert.equal(traySubline(3, 'printer', 'ar'), 'يمكنك إضافة طابعة أخرى');
  assert.equal(traySubline(4, 'printer', 'ar'), 'اكتملت المقارنة: أربعة كحد أقصى');
  assert.equal(badgeLabel(3, 'ar'), 'قارن الآن (3)');
});
