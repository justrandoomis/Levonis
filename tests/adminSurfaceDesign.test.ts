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
const PANEL = 'src/components/adminProducts/FulfillmentPanel.tsx';
const UI = 'src/components/adminProducts/ui.tsx';
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

test('the row identity reads as identity, and its traits line up down the grid', () => {
  const quick = src(QUICK);
  // State belongs beside the name; settings belong under it.
  assert.match(quick, /data-qp-active=\{rowKey\(row\)\}/);
  // The wrapping pile became two fixed tracks, so routes and quantities align
  // across rows instead of every row being a different height.
  assert.match(quick, /grid-cols-\[minmax\(0,1fr\)_5\.5rem\]/);
  assert.doesNotMatch(quick, /mt-1 flex flex-wrap items-center gap-1\.5" data-qp-traits/);
  // The stock box no longer repeats its column's label on every row.
  assert.doesNotMatch(quick, /<span>\{t\.stock\}<\/span>/);
  assert.match(quick, /aria-label=\{`\$\{t\.stock\} — \$\{row\.label_ar \|\| row\.label_en\}`\}/);
});

// ------------------------------------------------------ order type per model

test('a model is one card, not three nested frames', () => {
  const panel = src(PANEL);
  // The card keeps ONE border. Its two halves are separated by a rule, and the
  // groups inside them by a hairline — not by a second and third rectangle.
  assert.doesNotMatch(panel, /rounded-\[var\(--ap-radius-sm\)\] border border-\[var\(--ap-border\)\] p-2\.5/);
  assert.match(panel, /md:divide-x md:divide-\[var\(--ap-hairline\)\]/);
  assert.match(panel, /border-t border-\[var\(--ap-hairline\)\] space-y-2" data-preorder-capacity/);
  assert.match(panel, /border-t border-\[var\(--ap-hairline\)\] space-y-2" data-direct-stock/);
  // The three shipping routes are a divided list of siblings, not three cards.
  assert.doesNotMatch(panel, /key=\{t\.method\} className="rounded-\[var\(--ap-radius-sm\)\] bg-\[var\(--ap-surface-2\)\]/);

  // An unchecked half is legible as unchecked without reading its controls.
  assert.match(panel, /\$\{direct \? T\.text1 : T\.text3\}/);
  assert.match(panel, /\$\{pre \? T\.text1 : T\.text3\}/);
});

test('the shared admin label uses the panel tokens and can park its prose', () => {
  const ui = src(UI);
  // It painted zinc literals while every control beside it used .ap tokens.
  const label = ui.slice(ui.indexOf('export function L('), ui.indexOf('/** Collapsible editor section card'));
  assert.doesNotMatch(label, /zinc-/);
  assert.match(label, /var\(--ap-text-1\)/);
  assert.match(label, /var\(--ap-text-3\)/);
  // A `tip`, exactly like the product form's Field, so a paragraph of
  // explanation stops being permanent furniture under every control.
  assert.match(label, /tip\?: string/);
  assert.match(label, /role="tooltip"/);
  assert.match(label, /<span className="sr-only">\{tip\}<\/span>/);

  // And the longest sentence in the fulfilment panel now lives behind it.
  const panel = src(PANEL);
  assert.match(panel, /tip=\{tr\(\s*\n\s*'عدّاد مستقل تمامًا عن مخزون البيع المباشر/);
});
