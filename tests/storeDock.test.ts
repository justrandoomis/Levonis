/**
 * The store's bottom dock (owner, 2026-11-18, second ruling): no bubble on a
 * community store; a cart icon that slides up a sheet with this store's
 * products only; «أضف إلى السلة» lives only in that bar, joined to the icon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storeDockRoute, storeLines, storeUnits } from '../src/components/storeDock/route';
import { isMascotHiddenRoute } from '../src/components/bloub/MotionCharacterAnchor';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the sheet and the badge count only this store’s lines', () => {
  const line = (qty: number, unavailable_reason: string | null = null) => ({ qty, unavailable_reason });
  const mine = { store: { id: 's1' }, items: [line(2), line(1), line(5, 'other_store')] };
  assert.equal(storeLines(mine, 's1').length, 2);
  assert.equal(storeUnits(mine, 's1'), 3);
  // A cart locked to another shop holds nothing of this one.
  assert.deepEqual(storeLines(mine, 's2'), []);
  assert.equal(storeUnits(mine, 's2'), 0);
  assert.equal(storeUnits({ store: null, items: [] }, 's1'), 0);
  assert.equal(storeUnits(null, 's1'), 0);
});

test('the dock is on the shop pages, not on the platform pages; a product page draws its own', () => {
  for (const p of ['/', '/products', '/about', '/reviews', '/policies/returns', '/something']) assert.equal(storeDockRoute(p), true, p);
  for (const p of ['/p/x', '/cart', '/checkout', '/store-checkout', '/orders/1', '/admin', '/admin/orders', '/auth', '/model-viewer/t']) assert.equal(storeDockRoute(p), false, p);
});

test('no bubble on a store: no character layer on its address, none on its main-site product page, no top strip', () => {
  const app = read('src/App.tsx');
  assert.match(app, /if \(store \|\| unknownStore \|\| unavailableStore\) return null;/);
  const shell = app.slice(app.indexOf('function StorefrontApp()'), app.indexOf('function AppBootstrapLayer()'));
  assert.doesNotMatch(shell, /<MotionCharacterFallbackHeader/);
  assert.match(shell, /<StoreDock storeId=\{store\.id\} \/>/);
  assert.equal(isMascotHiddenRoute('/community/store/ali3d/p/dragon'), true);
  assert.equal(isMascotHiddenRoute('/community'), false);
  const dock = read('src/components/storeDock/StoreDock.tsx');
  assert.doesNotMatch(dock, /MotionCharacterAnchor/);
  assert.match(dock, /data-store-dock-cart/);
  assert.match(dock, /import\('\.\/StoreCartSheet'\)/);
});

test('the cart sheet is the iOS sheet with two heights and goes to the store checkout', () => {
  const sheet = read('src/components/storeDock/StoreCartSheet.tsx');
  assert.match(sheet, /detents=\{\['medium', 'large'\]\}/);
  assert.match(sheet, /storeLines\(cart, storeId\)/);
  assert.match(sheet, /go\('\/store-checkout'\)/);
});

test('the product page has one buy bar: the dock, with the add button inside it, and tells the dock after an add', () => {
  const page = read('src/pages/StorefrontProduct.tsx');
  assert.match(page, /<StoreDock[\s\S]*?data-store-dock-add[\s\S]*?<\/StoreDock>/);
  assert.equal((page.match(/addToCart\(false\)/g) ?? []).length, 1);
  assert.doesNotMatch(page, /fixed bottom-0 inset-x-0/);
  assert.match(page, /setAdded\(true\);\s*\/\/[^\n]*\n\s*announceStoreCartChanged\(\);/);
});
