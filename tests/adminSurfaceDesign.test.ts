/**
 * The admin panel's own look, pinned where a screenshot was the only evidence.
 *
 * The owner's report, with two screenshots: «في تصميم المخزون وتصميم التسعير
 * الفوري والمخزون تعديل سريع للأسعار وكذلك نوع الطلب لكل موديل التصميم مربك
 * وغير مناسب» — and separately, that the mascot has no business sitting in the
 * admin's top bar.
 *
 * None of that is catchable by a type or a route test, so each rule below is
 * asserted over the source the way tests/bundleAdminUi.test.ts does: there is
 * no browser DOM runner in this repo.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const UI = 'src/components/adminProducts/ui.tsx';
const THEME = 'src/components/adminProducts/theme.css';
const ANCHOR = 'src/components/bloub/MotionCharacterAnchor.tsx';

// ------------------------------------------------- the mascot and the admin

test('the character does not render on an admin route', async () => {
  const { isMascotHiddenRoute } = await import('../src/components/bloub/MotionCharacterAnchor');
  assert.equal(isMascotHiddenRoute('/admin'), true);
  assert.equal(isMascotHiddenRoute('/admin/invest'), true);
  // Case-insensitively, because react-router matches paths that way.
  assert.equal(isMascotHiddenRoute('/Admin/Products'), true);
  // And nowhere else — the character is the storefront's, and it stays there.
  assert.equal(isMascotHiddenRoute('/'), false);
  assert.equal(isMascotHiddenRoute('/administration'), false, 'a prefix match would swallow unrelated routes');
  assert.equal(isMascotHiddenRoute('/orders'), false);

  const anchor = src(ANCHOR);
  assert.match(anchor, /if \(isMascotHiddenRoute\(pathname\)\) return null;/);

  // The travelling layer is hidden by ROUTE and taken out of the box tree, so
  // an admin screen pays neither the vertical space nor the per-frame
  // composite — while the component stays mounted and keeps its journey state.
  const intro = src('src/components/bloub/AppIntro.tsx');
  assert.match(intro, /data-route-hidden=\{isMascotHiddenRoute\(location\.pathname\)/);
  const css = src('src/index.css');
  assert.match(css, /\.lv-app-intro\[data-route-hidden='true'\]\s*\{\s*display: none;/);
});

// ------------------------------------------------------- quick price editing
//
// The Quick Price panel (QuickPricePanel.tsx) typed dinar prices: the Pricing V2 clean start (DECISIONS
// row 222, addendum A.6) closed that door and deleted the panel — a product is priced in dollars in its
// form's «الأسعار» section (tests/productFormV2.test.ts), and tests/stockByOrderTypeUi.test.ts pins that no
// component brings the panel back. Its price-cell, inherit and identity rules went with it.

// ----------------------------------------------------- Apple-style workspace

test('Quick Price opens as a calm, token-scoped workspace instead of an unstyled portal', () => {
  const ui = src(UI);
  const theme = src(THEME);

  // The dialog is portalled to body, so the shell itself must carry `.ap` or
  // every var(--ap-*) value inside the quick editor resolves to nothing.
  assert.match(ui, /className="ap fixed inset-x-0/);
  assert.match(ui, /workspace \? 'ap-quick-workspace sm:max-w-\[1180px\]'/);
  assert.match(ui, /min-h-11 min-w-11/);
  // (AdminProducts opened the Quick Price panel in it; the clean start deleted that panel — the
  // workspace shell stays the modal kit's.)

  // Material is restrained to the shell, with opaque editing surfaces and a
  // reduced-motion path for people who request it.
  assert.match(theme, /\.ap \.ap-quick-workspace/);
  assert.match(theme, /radial-gradient/);
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(theme, /animation-duration: 0\.01ms !important/);
});
