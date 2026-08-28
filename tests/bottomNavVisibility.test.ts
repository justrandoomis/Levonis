import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBottomNavHidden } from '../src/components/BottomNav';

// App.tsx reserves bottom clearance on the scroll container only when the
// floating BottomNav actually renders. This predicate is the single source
// of truth for that visibility, so its route set is pinned by tests.

test('nav is hidden on immersive/detail routes', () => {
  assert.equal(isBottomNavHidden('/admin'), true);
  assert.equal(isBottomNavHidden('/edit-profile'), true);
  assert.equal(isBottomNavHidden('/product/some-slug'), true);
  assert.equal(isBottomNavHidden('/product/x5z7e8'), true);
  assert.equal(isBottomNavHidden('/chat/2'), true);
  assert.equal(isBottomNavHidden('/chat/abc-def'), true);
});

test('nav is visible on the main tab routes', () => {
  assert.equal(isBottomNavHidden('/'), false);
  assert.equal(isBottomNavHidden('/community'), false);
  assert.equal(isBottomNavHidden('/chats'), false);
  assert.equal(isBottomNavHidden('/cart'), false);
  assert.equal(isBottomNavHidden('/profile'), false);
  assert.equal(isBottomNavHidden('/orders'), false);
  assert.equal(isBottomNavHidden('/products'), false);
});

test('prefix rules match only real sub-routes, not sibling routes', () => {
  // '/products' must not be swallowed by the '/product/' prefix rule.
  assert.equal(isBottomNavHidden('/products'), false);
  // '/chats' (list) stays visible while '/chat/:id' (conversation) hides.
  assert.equal(isBottomNavHidden('/chats'), false);
  // Bare '/product' and '/chat' without a trailing segment are not detail pages.
  assert.equal(isBottomNavHidden('/product'), false);
  assert.equal(isBottomNavHidden('/chat'), false);
});
