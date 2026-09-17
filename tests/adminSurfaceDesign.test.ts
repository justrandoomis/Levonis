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

const QUICK = 'src/components/adminProducts/QuickPricePanel.tsx';
const UI = 'src/components/adminProducts/ui.tsx';
const THEME = 'src/components/adminProducts/theme.css';
const PRODUCTS = 'src/components/AdminProducts.tsx';
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

test('a price cell carries one control, not a row of chips', () => {
  const quick = src(QUICK);
  // The three-chip row is gone, and with it the component that drew it.
  assert.doesNotMatch(quick, /function ModeChip\(/);
  assert.doesNotMatch(quick, /<ModeChip\b/);

  // What replaced it: a single prefix inside the field, and only where the
  // distinction it makes can actually apply (a product's base price has no
  // level above it to be a difference FROM).
  assert.match(quick, /const toggleAdjust = \(\) => setMode\(mode === 'adjust' \? 'fixed' : 'adjust'\);/);
  assert.match(quick, /\{canAdjust && \(/);
  assert.match(quick, /data-qp-mode-btn=\{`\$\{key\}:adjust`\}/);
  // The glyph is the whole visual; its meaning still reaches a screen reader.
  assert.match(quick, /<span className="sr-only">\{mode === 'adjust' \? t\.adjust : t\.fixed\}<\/span>/);
});

test('clearing a box means inherit — except where there is nothing to inherit from', () => {
  const quick = src(QUICK);
  // The defect the chips were hiding: emptying the product's base regular
  // price marked it `inherit` from a level that does not exist.
  assert.match(quick, /const cleared: Mode = canInherit \? 'inherit' : 'fixed';/);
  assert.match(quick, /copy\[key\] = \{ mode: value === '' \? cleared : nextMode, text: value \}/);
  assert.match(quick, /const placeholder = !canInherit\s*\n\s*\? t\.required/);
});

test('the row identity reads as identity while fulfilment stays in its dedicated workspace', () => {
  const quick = src(QUICK);
  // State belongs beside the name; settings belong under it.
  assert.match(quick, /data-qp-active=\{rowKey\(row\)\}/);
  // Exact option-colour counters use a stable label/value track in the
  // fulfilment workspace rather than being repeated inside every price row.
  assert.match(quick, /grid-cols-\[minmax\(0,1fr\)_5\.5rem\]/);
  assert.doesNotMatch(quick, /mt-1 flex flex-wrap items-center gap-1\.5" data-qp-traits/);
  assert.match(quick, /function QuickFulfillmentPanel/);
  assert.doesNotMatch(quick, /data-qp-availability=/);
});

// ----------------------------------------------------- Apple-style workspace

test('Quick Price opens as a calm, token-scoped workspace instead of an unstyled portal', () => {
  const ui = src(UI);
  const theme = src(THEME);
  const products = src(PRODUCTS);

  // The dialog is portalled to body, so the shell itself must carry `.ap` or
  // every var(--ap-*) value inside the quick editor resolves to nothing.
  assert.match(ui, /className="ap fixed inset-x-0/);
  assert.match(ui, /workspace \? 'ap-quick-workspace sm:max-w-\[1180px\]'/);
  assert.match(ui, /min-h-11 min-w-11/);
  assert.match(products, /<Modal\s*\n\s*wide\s*\n\s*workspace/);

  // Material is restrained to the shell, with opaque editing surfaces and a
  // reduced-motion path for people who request it.
  assert.match(theme, /\.ap \.ap-quick-workspace/);
  assert.match(theme, /radial-gradient/);
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(theme, /animation-duration: 0\.01ms !important/);
});

test('Quick Price exposes one clear hierarchy, segmented tabs and a persistent action bar', () => {
  const quick = src(QUICK);

  assert.match(quick, /role="tablist"/);
  assert.match(quick, /role="tab"/);
  assert.match(quick, /aria-selected=\{tab === x\.id\}/);
  assert.match(quick, /min-h-10/);
  assert.match(quick, /sticky bottom-0/);
  assert.match(quick, /backdrop-blur-xl/);

  // Model, sale type and route are distinct surface levels, without the old
  // standalone duplicate fulfilment panel.
  assert.match(quick, /rounded-xl bg-\[var\(--ap-surface-1\)\]/);
  assert.match(quick, /rounded-xl bg-\[var\(--ap-surface-2\)\]/);
  assert.match(quick, /rounded-lg bg-\[var\(--ap-surface-1\)\]/);
  assert.doesNotMatch(quick, /preorder\.capacity/);
});
