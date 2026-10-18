import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { sanitizeNextPath } from '../src/components/auth/nextPath';
import { storeReturnUrl } from '../src/components/auth/storeReturn';

test('same-origin relative paths pass through unchanged', () => {
  assert.equal(sanitizeNextPath('/cart'), '/cart');
  assert.equal(sanitizeNextPath('/product/abc-123?x=1#top'), '/product/abc-123?x=1#top');
  assert.equal(sanitizeNextPath('/orders?status=pending'), '/orders?status=pending');
  assert.equal(sanitizeNextPath('/'), '/');
});

test('non-strings, empty and oversized values fall back to /', () => {
  assert.equal(sanitizeNextPath(undefined), '/');
  assert.equal(sanitizeNextPath(null), '/');
  assert.equal(sanitizeNextPath(42), '/');
  assert.equal(sanitizeNextPath(''), '/');
  assert.equal(sanitizeNextPath('   '), '/');
  assert.equal(sanitizeNextPath('/' + 'a'.repeat(2000)), '/');
});

test('open-redirect shapes are rejected', () => {
  assert.equal(sanitizeNextPath('//evil.com'), '/');
  assert.equal(sanitizeNextPath('//evil.com/path'), '/');
  assert.equal(sanitizeNextPath('https://evil.com'), '/');
  assert.equal(sanitizeNextPath('http://evil.com'), '/');
  assert.equal(sanitizeNextPath('javascript:alert(1)'), '/');
  assert.equal(sanitizeNextPath('\\\\evil.com'), '/');
  assert.equal(sanitizeNextPath('/\\evil.com'), '/'); // browsers normalize \ to /
  assert.equal(sanitizeNextPath('/a\\b'), '/');
  assert.equal(sanitizeNextPath('evil.com'), '/');
});

test('control characters are rejected', () => {
  assert.equal(sanitizeNextPath('/a\nb'), '/');
  assert.equal(sanitizeNextPath('/a\tb'), '/');
  assert.equal(sanitizeNextPath('/a\u0000b'), '/');
});

test('never bounces back into /auth itself', () => {
  assert.equal(sanitizeNextPath('/auth'), '/');
  assert.equal(sanitizeNextPath('/auth/'), '/');
  assert.equal(sanitizeNextPath('/auth?reset=x'), '/');
  // …but legitimate paths that merely start with the letters still pass.
  assert.equal(sanitizeNextPath('/authors'), '/authors');
});

test('location-like objects from ProtectedRoute state work', () => {
  assert.equal(sanitizeNextPath({ pathname: '/orders', search: '?f=1', hash: '' }), '/orders?f=1');
  assert.equal(sanitizeNextPath({ pathname: '/cart', search: '', hash: '#items' }), '/cart#items');
  assert.equal(sanitizeNextPath({ pathname: '//evil.com' }), '/');
  assert.equal(sanitizeNextPath({ pathname: 42 }), '/');
  assert.equal(sanitizeNextPath({}), '/');
});

// ------------------------------------------------ back to a shop (sign-in fix, 2026-10-18)

const MAIN = 'https://levonis-iq.com';

test('storeReturnUrl builds the shop address from a slug and the server-given apex', () => {
  assert.equal(storeReturnUrl('ali3d', MAIN, '/cart'), 'https://ali3d.levonis-iq.com/cart');
  assert.equal(storeReturnUrl('ali3d', MAIN, '/p/x?y=1#top'), 'https://ali3d.levonis-iq.com/p/x?y=1#top');
  assert.equal(storeReturnUrl('my-shop', MAIN, '/'), 'https://my-shop.levonis-iq.com/');
  // A location-like object (ProtectedRoute's state.from) is accepted like the page accepts it.
  assert.equal(storeReturnUrl('ali3d', MAIN, { pathname: '/orders', search: '?s=1' }), 'https://ali3d.levonis-iq.com/orders?s=1');
});

test('storeReturnUrl never becomes an open redirect: only a valid, non-system slug and an https apex', () => {
  for (const slug of ['a.b', 'evil.com', 'ali3d@evil.com', 'ali3d.evil.com', 'studio', 'www', 'api', '', 'ALI3D', 'Ali3d', 'ab', 'x--y', '-ali', 'ali-', 'ali3d/', 'ali3d:443', '//evil.com', 'https://evil.com', null, undefined, 42]) {
    assert.equal(storeReturnUrl(slug, MAIN, '/cart'), null, `slug ${String(slug)} must be refused`);
  }
  for (const main of ['http://levonis-iq.com', '', 'levonis-iq.com', 'javascript:alert(1)', 'https://user:pw@levonis-iq.com', 'https://levonis-iq.com:8443', 'not a url']) {
    assert.equal(storeReturnUrl('ali3d', main, '/cart'), null, `mainSite ${main} must be refused`);
  }
});

test('storeReturnUrl sanitizes the path exactly like the page does', () => {
  assert.equal(storeReturnUrl('ali3d', MAIN, '//evil.com'), 'https://ali3d.levonis-iq.com/');
  assert.equal(storeReturnUrl('ali3d', MAIN, 'https://evil.com/x'), 'https://ali3d.levonis-iq.com/');
  assert.equal(storeReturnUrl('ali3d', MAIN, '/\\evil.com'), 'https://ali3d.levonis-iq.com/');
  assert.equal(storeReturnUrl('ali3d', MAIN, '/auth?next=/x'), 'https://ali3d.levonis-iq.com/', 'never back into /auth');
  assert.equal(storeReturnUrl('ali3d', MAIN, undefined), 'https://ali3d.levonis-iq.com/');
});

test('a shop hands /auth to the apex, and the apex sends the person back afterwards', () => {
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
  const storefront = app.slice(app.indexOf('function StorefrontApp('), app.indexOf('function AppBootstrapLayer('));
  assert.ok(storefront.length > 0, 'StorefrontApp is gone');
  assert.match(storefront, /<Route path="\/auth" element=\{<StoreHostAuthHandoff \/>\} \/>/, 'the shop\'s /auth is the handoff');
  assert.doesNotMatch(storefront, /<Route path="\/auth" element=\{<Auth \/>\}/, 'a shop never renders the sign-in page itself');

  const handoff = app.slice(app.indexOf('function StoreHostAuthHandoff('), app.indexOf('function StorefrontApp('));
  assert.match(handoff, /sanitizeNextPath\(/, 'the destination is sanitized before it travels');
  assert.match(handoff, /q\.set\('store', slug\)/, 'the slug comes from the server-resolved store');
  assert.match(handoff, /window\.location\.replace\(target\)/);
  assert.match(handoff, /if \(!target\) return <Auth \/>;/, 'no root domain configured: the ordinary page, without Google');
  assert.match(handoff, /const \{ lang \} = useLanguage\(\);[\s\S]*q\.set\('lang', lang\);/, 'the reader\'s language travels to the apex');
  assert.match(handoff, /if \(!mainSite \|\| isLocalHost\(window\.location\.hostname\)\) return null;/, 'a local run (levonis.test:8787) stays on its own host');
  // App.tsx puts nextPath.ts in the entry chunk; the host table stays out of it.
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/components/auth/nextPath.ts'), 'utf8'), /worker\/lib\/hosts/, 'storeReturnUrl lives in its own module');

  const auth = readFileSync(join(ROOT, 'src/pages/Auth.tsx'), 'utf8');
  assert.match(auth, /const back = storeReturnUrl\(storeFromQuery, mainSite, dest\);/);
  assert.match(auth, /!onStoreHost &&/, 'Google is never offered on a shop host');
  assert.match(auth, /googleUsable && googleClientId \? <GoogleOAuthProvider/, 'Google\'s script is not loaded where the button cannot be used');
});
