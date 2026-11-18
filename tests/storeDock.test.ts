/**
 * The store's bottom dock (owner, 2026-11-18): the bubble is at the bottom of a
 * community store, not in a top strip; one tap goes to the store's home, three
 * rapid taps report the store; «أضف إلى السلة» lives only in that bar, joined
 * to the bubble.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { countDockTap, storeDockRoute, STORE_DOCK_MULTI_TAP_MS } from '../src/components/storeDock/route';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('three rapid taps report; slow taps never add up', () => {
  const run = { count: 0, at: 0 };
  assert.equal(countDockTap(10_000, run), false);
  assert.equal(countDockTap(10_300, run), false);
  assert.equal(countDockTap(10_600, run), true);
  // The run ended: the next tap starts again.
  assert.equal(countDockTap(10_700, run), false);
  const slow = { count: 0, at: 0 };
  for (let i = 0; i < 6; i++) assert.equal(countDockTap(20_000 + i * (STORE_DOCK_MULTI_TAP_MS + 1), slow), false);
});

test('the dock is on the shop pages, not on the platform pages; a product page draws its own', () => {
  for (const p of ['/', '/products', '/about', '/reviews', '/policies/returns', '/something']) assert.equal(storeDockRoute(p), true, p);
  for (const p of ['/p/x', '/cart', '/checkout', '/store-checkout', '/orders/1', '/admin', '/admin/orders', '/auth', '/model-viewer/t']) assert.equal(storeDockRoute(p), false, p);
});

test('the bubble is the bottom-home anchor and the report is the store report sheet', () => {
  const dock = read('src/components/storeDock/StoreDock.tsx');
  assert.match(dock, /MotionCharacterAnchor kind="bottom-home"/);
  assert.match(dock, /target=\{\{ type: 'store', id: storeId \}\}/);
  assert.match(dock, /import\('\.\.\/community\/social\/ReportSheet'\)/);
  const app = read('src/App.tsx');
  assert.match(app, /<StoreDock storeId=\{store\.id\} homePath="\/" \/>/);
});

test('the product page has one buy bar: the dock, with the add button inside it', () => {
  const page = read('src/pages/StorefrontProduct.tsx');
  assert.match(page, /<StoreDock[\s\S]*?data-store-dock-add[\s\S]*?<\/StoreDock>/);
  assert.equal((page.match(/addToCart\(false\)/g) ?? []).length, 1);
  assert.doesNotMatch(page, /fixed bottom-0 inset-x-0/);
});
