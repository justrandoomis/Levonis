/**
 * THE PRODUCT PAGE NO LONGER LETS A QUANTITY FOLLOW THE COLOUR (docs/ux/COLOUR-QUANTITIES.md).
 *
 * Source-level, as tests/productSelectionMemory.test.ts holds the page: the
 * places where the incident's path was closed must stay closed.
 *
 *   D3  the button names what it adds whenever a colour is involved, and the
 *       bare «أضف إلى السلة» is reached only for a product with no colours;
 *   D4  the reset runs in the colour TAP handlers, never in an effect;
 *   D5  after an add (and a Quick Buy) the quantity returns to 1;
 *       `product-cta` stays on every buy button;
 *   §3.11 the several-colours panel is a lazy chunk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const SRC = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
const PANEL = readFileSync(join(ROOT, 'src/components/product/ColourQuantityPanel.tsx'), 'utf8');

/** The body of `const name = …;` up to the next top-level statement of the component. */
function constBlock(name: string): string {
  const at = SRC.indexOf(`const ${name} =`);
  assert.ok(at >= 0, `${name} is defined`);
  const end = SRC.indexOf(';\n', at);
  return SRC.slice(at, end);
}

test('D3: the button reads addLabel whenever a colour is chosen; «أضف إلى السلة» only without a colour dimension', () => {
  const label = constBlock('buyButtonLabel');
  assert.match(label, /chosenColour\s*\?\s*addLabel\(cl, \[\{ name: chosenColour\.name, qty \}\], \{ short: true \}\)/);
  assert.match(label, /: cs\.chooseColourFirst/, 'a colour still to choose says so');
  assert.match(label, /!hasColourDimension\s*\?\s*s\.addToCart/, 'the bare label is the no-colour branch');
  assert.equal((label.match(/s\.addToCart/g) ?? []).length, 1, 's.addToCart is reached from that one branch only');
  assert.match(label, /lastAdded\s*\?\s*addedLabel\(cl, lastAdded, \{ short: true \}\)/, 'after an add: what WAS added');
  // The full name reaches assistive tech when the visible one is shortened.
  assert.match(SRC, /ariaLabel: buyButtonAria,/);
  assert.match(SRC, /aria-label=\{buyButtonAria\}/);
});

test('D4: the reset is called from the chip and the colour-group handlers, and no effect sets qty from a colour', () => {
  assert.match(SRC, /const onColourChipTap = \(id: string, selected: boolean\) => \{\s*const next = selected \? '' : id;\s*afterColourTap\(colorId, next\);/);
  assert.match(SRC, /onClick=\{\(\) => \{[\s\S]{0,900}?onColourChipTap\(col\.id, selected\);\s*\}\}/);
  assert.match(SRC, /if \(group\.kind === 'color'\) afterColourTap\(groupSelected, selected \? '' : value\.id\);/);
  assert.match(constBlock('afterColourTap'), /qtyAfterColourChange\(\{ from, to, qty \}\)/);
  // No effect reads a colour and writes the quantity.
  for (const m of SRC.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[([^\]]*)\]\);/g)) {
    const [, body, deps] = m;
    if (/\bsetQty\(/.test(body)) {
      assert.ok(!/\bcolorId\b/.test(deps) && !/\bcolorId\b/.test(body), `an effect sets qty from the colour: ${m[0].slice(0, 160)}`);
    }
  }
});

test('D5: after a successful add and a Quick Buy success the quantity returns to 1', () => {
  const add = SRC.slice(SRC.indexOf('const postAddToCart = useCallback('), SRC.indexOf('const handleAddToCart'));
  assert.match(add, /if \(chosen\) \{[\s\S]*?setLastAdded\(\{ name: chosen\.name, qty, capped \}\);[\s\S]*?setQty\(1\);/);
  assert.match(add, /const capped = after > 0 && after < before \+ qty \? \{ after \} : null;/, 'a capped merge is said, never silent');
  // The add's answer is the whole cart: a several-colours add right after it may send inCart.
  assert.match(add, /setCartLines\(items\);\s*\/\/[^\n]*\n\s*setCartLinesLoaded\(true\);/);
  const quick = SRC.slice(SRC.indexOf('const runQuickBuy = useCallback('), SRC.indexOf('runQuickBuyRef.current = '));
  assert.match(quick, /if \(outcome\.kind === 'added' && chosenColourOf\(product, relations, colorId, optionValueIds\)\) \{\s*\/\/[^\n]*\n\s*setQty\(1\);/);
});

test('every buy button keeps data-testid="product-cta"', () => {
  assert.match(SRC, /<button\s+type="button"\s+data-testid="product-cta"/, 'the plain button');
  assert.match(readFileSync(join(ROOT, 'src/components/quickBuy/QuickBuyBar.tsx'), 'utf8'), /data-testid="product-cta"/, 'the Quick Buy bar');
  assert.match(PANEL, /data-testid="product-cta"/, 'the several-colours add');
});

test('§3.11: ColourQuantityPanel is imported only through React.lazy', () => {
  assert.match(SRC, /const loadColourQuantityPanel = \(\) => import\('\.\.\/components\/product\/ColourQuantityPanel'\);/);
  assert.match(SRC, /const ColourQuantityPanel = React\.lazy\(loadColourQuantityPanel\);/);
  for (const m of SRC.matchAll(/^import\s+(?!type\b)[^;]*from '\.\.\/components\/product\/ColourQuantityPanel';$/gm)) {
    assert.fail(`a static import: ${m[0]}`);
  }
  assert.match(SRC, /<ChunkBoundary compact>\s*<React\.Suspense fallback=\{[^}]*\}>\s*<ColourQuantityPanel/);
});

test('the several-colours add is one all-or-nothing request, guarded against a double tap', () => {
  assert.match(PANEL, /api\.post<\{ items: CartItem\[\]; added: AddedLine\[\] \}>\('\/api\/cart\/items\/batch', body\)/);
  assert.match(PANEL, /if \(addInFlight\.current\) return;/);
  assert.match(PANEL, /\.\.\.\(cartLinesLoaded \? \{ inCart: sent\[id\] \} : \{\}\)/, 'inCart only when the cart was really read');
  assert.match(PANEL, /err\.code === 'CART_LINES_CHANGED'/);
  assert.match(PANEL, /err\.code === 'CART_SHIPPING_CONFLICT'/);
  assert.match(PANEL, /onConfirm=\{\(\) => void send\(true\)\}/, 'empty the cart and add repeats the SAME batch');
  assert.match(PANEL, /role="alert"/);
  assert.match(PANEL, /invalid=\{!!error\}/);
  assert.match(PANEL, /stepButtonsInTabOrder=\{false\}/);
  assert.match(PANEL, /min=\{0\}/);
});

test('the hint, the switch and the gallery chip are on the page', () => {
  assert.match(SRC, /<div role="status" data-colour-hint=\{colourHint\.kind\}/);
  assert.match(SRC, /group="colour-mode"/);
  assert.match(SRC, /label=\{cs\.colourModeLabel\}/);
  assert.match(SRC, /data-gallery-colour-chip/);
  assert.match(SRC, /cs\.priceWithColour/);
});
