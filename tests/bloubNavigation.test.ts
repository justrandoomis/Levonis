import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { measureHomeTarget } from '../src/components/bloub/anchors';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the bottom navigation is two groups with an independent Home target', () => {
  const source = read('src/components/BottomNav.tsx');
  assert.match(source, /data-bottom-nav-group="account-cart"/);
  assert.match(source, /data-bottom-nav-group="messages-community"/);
  assert.match(source, /MotionCharacterAnchor kind="bottom-home"/);
  assert.match(read('src/components/bloub/MotionCharacterAnchor.tsx'), /data-bloub-home-target/);
  assert.match(source, /signalBloub\('tap'/);
  assert.match(source, /data-nav-badge=\{item\.path === '\/cart' \? 'cart' : item\.path === '\/chats' \? 'messages'/);
  assert.doesNotMatch(source, /grid-cols-5/);
});

test('missing intro target is a valid measured outcome, not an exception', () => {
  const root = { querySelector: () => null } as unknown as ParentNode;
  assert.equal(measureHomeTarget(root), null);
});

test('intro geometry uses the real target bounds', () => {
  const root = {
    querySelector: () => ({
      getBoundingClientRect: () => ({ left: 24, top: 700, width: 52, height: 44 }),
    }),
  } as unknown as ParentNode;
  assert.deepEqual(measureHomeTarget(root), { x: 28, y: 700, size: 44 });
});

test('one shared character persists between measured anchors and respects reduced motion', () => {
  const intro = read('src/components/bloub/AppIntro.tsx');
  const app = read('src/App.tsx');
  const css = read('src/index.css');
  assert.equal((intro.match(/<BloubHome\b/g) ?? []).length, 1);
  assert.match(intro, /completedRef\.current/);
  assert.match(intro, /measureCharacterAnchor\(\)/);
  /**
   * STILL EXACTLY ONE MEASUREMENT PER FRAME — which is what this line has
   * always been here to pin — but it now rides the loop's OWN frame instead
   * of a second `requestAnimationFrame` of its own. A scroll raises a flag and
   * `tick` consumes it in its read phase, before the frame writes anything.
   * The old shape could not be ordered against the loop: `tick` re-arms itself
   * on its first line, so a measurement queued after frame N always landed
   * AFTER the draw in frame N+1 — a forced synchronous reflow, once per scroll
   * frame, on every route. See tests/mascotFrameBudget.test.ts.
   */
  assert.match(intro, /measurePending = true;/);
  assert.match(intro, /if \(measurePending\) \{\s*measurePending = false;\s*measure\(\);/);
  assert.doesNotMatch(intro, /attempts < 5/);
  assert.match(intro, /data-bloub-rendered/);
  assert.match(app, /<AppBootstrapLayer\s*\/>[\s\S]{0,100}<AppContent\s*\/>/);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]+\.lv-app-intro__character/);
  assert.match(css, /\.lv-app-intro__character\s*\{[^}]*left:\s*0/);
  assert.doesNotMatch(css, /\.lv-app-intro__character\s*\{[^}]*inset-inline-start:/);
});

test('Home readiness is driven by the real critical request settling', () => {
  const home = read('src/pages/Home.tsx');
  assert.match(home, /if \(!initialLoading\) markHomeCriticalReady\(\)/);
  assert.doesNotMatch(home, /setTimeout\([^)]*markHomeCriticalReady/);
});
