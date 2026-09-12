/**
 * Structural regressions for the shared UI architecture.
 *
 * This repository intentionally has no browser DOM runner. These assertions
 * pin the layout contracts that previously failed only on small phones: a
 * portalled layer contract, one viewport owner, in-flow composers and a
 * canonical selected-state primitive. Visual behavior is still verified in
 * the browser before deployment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the dark system is semantic and selection uses a small cue rather than a gold flood', () => {
  const css = read('src/index.css');
  assert.match(css, /--color-canvas:\s*#0b0c0f/);
  assert.match(css, /--color-surface-raised:/);
  assert.match(css, /--color-text-secondary:/);
  assert.match(css, /--color-success:/);
  assert.match(css, /--color-warning:/);
  assert.match(css, /--color-danger:/);
  assert.match(css, /\.lv-choice\[aria-pressed='true'\]/);
  assert.match(css, /box-shadow:\s*inset 2px 0 0 var\(--color-gold\)/);
  assert.doesNotMatch(css, /\.lv-choice\[aria-pressed='true'\][\s\S]{0,300}background-color:\s*var\(--color-gold\)/);
});

test('product variants and availability modes share the restrained accessible choice primitive', () => {
  const product = read('src/pages/Product.tsx');
  assert.match(product, /className="lv-choice[^\n]+"/);
  assert.match(product, /aria-pressed=\{!wantPreorder\}/);
  assert.match(product, /aria-pressed=\{wantPreorder\}/);
  assert.match(product, /<SafeImage[\s\S]{0,500}lv-choice-mark/);
  assert.doesNotMatch(product, /border-gold\s+bg-gold\/15\s+text-gold/);
});

test('language popover and modal layers use portals and one documented stack', () => {
  const overlay = read('src/components/ui/Overlay.tsx');
  const header = read('src/components/Header.tsx');
  assert.match(overlay, /UI_LAYERS/);
  assert.match(overlay, /export function overlayLayer/);
  assert.match(overlay, /visualViewport/);
  assert.match(overlay, /document\.getElementById\('main-scroll-container'\)/);
  assert.match(overlay, /createPortal\([\s\S]+document\.body/);
  assert.match(header, /<Anchored[\s\S]{0,300}testId="header-language-menu"/);
});

test('a modal hides the persistent nav and every legacy sheet is lifted above app chrome', () => {
  const css = read('src/index.css');
  const nav = read('src/components/BottomNav.tsx');
  const overlay = read('src/components/ui/Overlay.tsx');
  assert.match(nav, /data-bottom-nav/);
  assert.match(css, /data-overlay-open='true'[\s\S]{0,100}\[data-bottom-nav\]/);
  assert.match(overlay, /z < UI_LAYERS\.overlay/);
  assert.match(overlay, /pb-\[env\(safe-area-inset-bottom\)\]/);
});

test('checkout owns a reachable dynamic viewport and centers its meaningful loader', () => {
  const checkout = read('src/pages/Checkout.tsx');
  const app = read('src/App.tsx');
  assert.match(app, /h-\[100dvh\]\s+min-h-0/);
  assert.match(checkout, /data-testid="checkout-loading"/);
  assert.match(checkout, /grid h-full min-h-0 w-full flex-1 place-items-center/);
  assert.match(checkout, /Preparing checkout…/);
  assert.match(checkout, /data-checkout-viewport/);
  assert.match(checkout, /h-full min-h-0 w-full overflow-y-auto/);
});

test('merchant checkout uses the same reachable viewport, choices, and in-flow action bar', () => {
  const checkout = read('src/pages/StoreCheckout.tsx');
  assert.match(checkout, /h-full min-h-0 bg-canvas[^\n]+flex flex-col/);
  assert.match(checkout, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(checkout, /aria-pressed=\{addressId === a\.id\}/);
  assert.match(checkout, /aria-pressed=\{payWithWallet\}/);
  assert.match(checkout, /htmlFor="store-coupon-code"/);
  assert.doesNotMatch(checkout, /className="[^"]*fixed bottom-0[^"]*"/);
});

test('support and direct chat keep suggestions and the final message above an in-flow composer', () => {
  for (const path of ['src/pages/Support.tsx', 'src/pages/Chat.tsx']) {
    const source = read(path);
    assert.match(source, /data-(?:support|chat)-messages|data-support-conversation/);
    assert.match(source, /data-(?:support|chat)-suggestions/);
    assert.match(source, /data-(?:support|chat)-composer/);
    assert.match(source, /min-h-0 flex-1 overflow-y-auto|flex-1 min-h-0 overflow-y-auto/);
    assert.doesNotMatch(source, /className="[^"]*fixed bottom-0[^"]*"/);
  }
});

test('important support fields have visible labels and field-local errors', () => {
  const support = read('src/pages/Support.tsx');
  assert.match(support, /<label htmlFor="support-ticket-subject"/);
  assert.match(support, /aria-describedby=\{fieldErrors\.subject/);
  assert.match(support, /id="support-ticket-subject-error" role="alert"/);
  assert.match(support, /<label htmlFor="support-ticket-message"/);
});

test('addresses and settings group rows with restrained shared surfaces', () => {
  const addresses = read('src/pages/Addresses.tsx');
  const settings = read('src/pages/Settings.tsx');
  assert.match(addresses, /lv-surface divide-y divide-border-subtle[^\n]+data-address-list/);
  assert.match(settings, /<SectionCard title=\{s\.secAccount\}/);
  assert.match(settings, /<SectionCard title=\{s\.secPrefs\}/);
  assert.match(settings, /lv-surface overflow-hidden divide-y/);
  assert.doesNotMatch(settings, /border-gold bg-gold\/15 text-gold/);
});
