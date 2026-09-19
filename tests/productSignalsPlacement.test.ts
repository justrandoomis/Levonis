/**
 * WHERE THE THREE SIGNALS SIT, AND WHEN THEY ARE HONESTLY SILENT.
 *
 * The owner asked three times for the rating, the units sold and the
 * availability type to sit BELOW the «المتجر الرسمي» line and ABOVE «وصف
 * المنتج», and reported it as never applied. It had in fact shipped — but
 * rendered ABOVE the <h1>, so the header looked untouched and the request
 * looked ignored. The row EXISTING was never the thing in doubt; its POSITION
 * was. A test that only asserted `data-product-signals` is present would have
 * passed against the broken build too, which is the whole reason this file
 * asserts ORDER and nothing weaker.
 *
 * The second half of the file pins the silence. Two of the three chips are
 * correctly invisible on this shop today — there are no published reviews and
 * no product has passed five delivered units — and the owner has been told so.
 * Those thresholds are THEIR decision, so this file locks them in place rather
 * than leaving them free to be quietly lowered to make the header look busier.
 *
 * Source assertions, not DOM assertions: this repository has no browser test
 * runner (see tests/uiSystem.test.ts), and the ordering being defended here is
 * a property of the JSX itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SALES_TIERS, salesBadgeTier } from '../worker/lib/salesBadge';

const product = readFileSync(new URL('../src/pages/Product.tsx', import.meta.url), 'utf8');

/**
 * The signals row itself, sliced out so nothing below it can satisfy a match.
 *
 * Computed lazily, per test, rather than once at module scope: a missing hook
 * evaluated at import time aborts the whole file, and the ORDER assertions
 * below are the ones that carry the owner's actual complaint. They must be
 * able to fail on their own terms and name the position that is wrong.
 */
const signalsRow = (): string => {
  const open = product.indexOf('<div data-product-signals');
  assert.notEqual(open, -1, 'the signals row carries a data-product-signals hook');
  const close = product.indexOf('{stockNote ?', open);
  assert.ok(close > open, 'the stock note closes the signals row');
  return product.slice(open, product.indexOf('\n', product.indexOf('</div>', close)));
};

test('the signals row renders BELOW the store line and ABOVE the description', () => {
  const storeLine = product.indexOf('{s.officialStore} · Levonis');
  const title = product.indexOf('<h1 className=');
  const row = product.indexOf('<div data-product-signals');
  const conditionPanel = product.indexOf('<ConditionPanel condition={productCondition}');
  const description = product.indexOf('<Section title={s.description}');

  for (const [name, at] of Object.entries({ storeLine, title, row, conditionPanel, description })) {
    assert.ok(at > 0, `${name} is present in Product.tsx`);
  }

  // The regression the owner actually reported: the row above the title.
  assert.ok(title < row, 'the product title comes BEFORE the signals row, not after it');
  assert.ok(storeLine < row, 'the «المتجر الرسمي» line comes BEFORE the signals row');
  // «فوق وصف المنتج» — and above the graded-unit panel too, because the
  // condition CHIP in this row introduces that panel rather than echoing it.
  assert.ok(row < conditionPanel, 'the signals row comes BEFORE the condition panel');
  assert.ok(row < description, 'the signals row comes BEFORE «وصف المنتج»');
});

test('each chip is guarded, so nothing prints a zero it does not have', () => {
  // «0 تقييم» and «+0 مبيعات» are the two sentences this row must never say.
  const row = signalsRow();
  assert.match(
    row,
    /\{rating && rating\.count > 0 \? \([\s\S]{0,200}data-product-rating/,
    'the rating chip renders only when a published review actually exists'
  );
  assert.match(
    row,
    /\{salesBadge !== null \? \([\s\S]{0,200}data-product-sales/,
    'the sales chip renders only when the server sent a tier'
  );
  // Each guard is a ternary with `null` on the empty branch — no placeholder,
  // no dash, no "0". An empty shelf should look new, not unwanted.
  assert.equal(
    (row.match(/\) : null\}/g) ?? []).length >= 3,
    true,
    'every optional chip falls back to null rather than to a placeholder'
  );
});

test('the rating threshold is one PUBLISHED review, enforced on the server', () => {
  const route = readFileSync(new URL('../worker/routes/products.ts', import.meta.url), 'utf8');
  // The Worker sends `rating: null` below the threshold; the page then also
  // checks `rating.count > 0`. Two gates, one meaning — and neither of them is
  // a number this page may invent.
  assert.match(route, /FROM reviews WHERE product_id = \? AND status = 'published'/);
  // Anchored to the ternary itself: `/:\s*null;/` on its own matched a
  // semicolon after the word `null` anywhere in a several-thousand-line file,
  // so nothing could ever have broken it. This pins the FALSE branch of the
  // rating gate, which is the thing that must stay `null`.
  assert.match(route, /ratingCount > 0\s*\n?\s*\?[\s\S]{0,240}?:\s*null;/);
});

test('the sales threshold is five DELIVERED units, and this page may not lower it', () => {
  assert.equal(SALES_TIERS[0], 5, 'the first tier is five units');
  assert.equal(salesBadgeTier(0), null, 'no sale, no chip');
  assert.equal(salesBadgeTier(4), null, 'four sales is below the first tier — still no chip');
  assert.equal(salesBadgeTier(5), 5, 'five sales passes the first tier');
  assert.equal(salesBadgeTier(237), 200, 'the tier is rounded DOWN, never up');
  // The page reads the tier and never the raw count, so it has no number to
  // round and no threshold to move.
  assert.doesNotMatch(product, /SALES_TIERS|salesBadgeTier/);
});

test('the availability chip and the «طريقة التوفر» chooser share ONE computation', () => {
  // `effectivePreorder` is the chooser's own boolean. The chip is derived from
  // it rather than from a parallel reading of the raw server default, so the
  // header cannot say «بيع مباشر» while the panel below quotes a pre-order.
  assert.match(product, /const effectivePreorder = orderType \? wantPreorder : mode === 'preorder';/);
  // …and the derived three-state honours USABILITY, not just the button press.
  // Sharing one computation is worth nothing if the shared answer can be a
  // mode the server has already closed: a buyer holding a stale
  // `orderType = 'direct_sale'` on a product whose last unit just sold would
  // otherwise read the green «بيع مباشر» chip over a disabled «نفد المخزون»
  // button. An unusable pick falls back to `mode`, which is stock-aware.
  const em = /const effectiveMode: 'direct_sale' \| 'preorder' \| 'unavailable' =([\s\S]*?);\n/.exec(product);
  assert.ok(em, 'the page still derives one three-state mode for the chip');
  assert.match(em[1], /mode === 'unavailable'\s*\n?\s*\? 'unavailable'/);
  assert.match(em[1], /preUsable\s*\n?\s*\? 'preorder'\s*\n?\s*: mode/);
  assert.match(em[1], /directUsable\s*\n?\s*\? 'direct_sale'\s*\n?\s*: mode/);

  // The two usability booleans must be in scope ABOVE the chip that needs
  // them — a hoist that silently slid back down would leave the chip blind.
  const usableAt = product.indexOf('const directUsable =');
  assert.ok(usableAt > 0 && usableAt < product.indexOf('const effectiveMode:'));
  assert.match(product, /const showTransports = effectivePreorder &&/);

  // The badge and the shelf note both read the derived state.
  assert.match(product, /const modeBadge =\s*\n\s*effectiveMode === 'preorder'/);
  assert.match(product, /:\s*effectiveMode === 'direct_sale'/);
  assert.match(product, /if \(!availability \|\| effectiveMode !== 'direct_sale'\) return '';/);
  // …and the note itself never says «متوفر» about an empty shelf. Widening
  // its gate from `mode` to `effectiveMode` is what made that branch
  // reachable at all, so the zero is answered here rather than left to luck.
  assert.match(product, /return left > 0 \? s\.inStock : '';/);

  // A sold-out direct sale with an open pre-order must read «طلب مسبق» — not
  // «متوفر», and not «غير متوفر». `unavailable` is reachable only when the
  // SERVER says no mode is usable.
  assert.doesNotMatch(product, /const modeBadge =[\s\S]{0,400}\bmode === 'direct_sale'/);
});

test('the row wraps instead of overflowing, and carries no physical directions', () => {
  // 360px: four chips plus a brand plus a stock note do not fit on one line in
  // any of the three languages, and Kurdish is the longest.
  const row = signalsRow();
  assert.match(row, /flex items-center gap-x-2 gap-y-1\.5 flex-wrap/);
  assert.doesNotMatch(row, /\b(ml|mr|pl|pr|left|right|text-left|text-right)-/);

  // Tailwind v4: an arbitrary text size sets font-size ONLY, so every one of
  // them in this row names its own line box.
  for (const match of row.matchAll(/text-\[\d+px\](?<rest>[^"`]*)/g)) {
    assert.match(match.groups!.rest, /leading-/, `"${match[0]}" needs an explicit leading-`);
  }

  // hover: is gated behind @media (hover: hover) in this codebase, so nothing
  // in a read-only row may depend on it to be legible.
  assert.doesNotMatch(row, /hover:/);
});
