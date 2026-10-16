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

test('D3: the button reads addLabel whenever a colour is chosen; «أضف إلى السلة» only when this selection has no colour to choose', () => {
  const label = constBlock('buyButtonLabel');
  // The words come from buyLabelKind (src/lib/colourQuantities.ts, unit-tested), fed by the CURRENT selection.
  assert.match(SRC, /const buyKind = buyLabelKind\(\{[\s\S]*?colourToChoose,[\s\S]*?\}\);/);
  assert.match(SRC, /const colourToChoose = orderedColors\.length > 0 \|\| !!colourGroup;/, 'a colourless model keeps «أضف إلى السلة»');
  assert.match(label, /buyKind === 'addColour'\s*\?\s*addLabel\(cl, \[\{ name: chosenColour!\.name, qty \}\], \{ short: true \}\)/);
  assert.match(label, /buyKind === 'chooseColour'\s*\?\s*cs\.chooseColourFirst/, 'a colour still to choose says so');
  assert.match(label, /buyKind === 'addToCart'\s*\?\s*s\.addToCart/);
  assert.equal((label.match(/s\.addToCart/g) ?? []).length, 1, 's.addToCart is reached from that one branch only');
  assert.match(label, /buyKind === 'addedColour'\s*\?\s*addedLabel\(cl, lastAdded!, \{ short: true \}\)/, 'after an add: what WAS added');
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
  assert.match(quick, /const quickChosen = chosenColourOf\(product, relations, colorId, optionValueIds\);/);
  assert.match(quick, /if \(outcome\.kind === 'added' && quickChosen\) \{\s*\/\/[^\n]*\n\s*setQty\(1\);/);
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

// ------------------------------------------------------------- review fixes

test('review: «أُضيف 50 × Black» lasts only while the selection and the quantity are still what was added', () => {
  assert.match(SRC, /const justAdded = lastAdded \? addedFlash && addedKey === currentSelectionKey : !!notice;/);
  assert.match(SRC, /const currentSelectionKey = pressKey\(\{ colour: colorId, optionValueIds, qty, orderType: requestedOrderType, route: effectiveTransport, warranty: warrantyPlanId \}\);/);
  const add = SRC.slice(SRC.indexOf('const postAddToCart = useCallback('), SRC.indexOf('const handleAddToCart'));
  assert.match(add, /setAddedKey\(pressKey\(\{ colour: colorId, optionValueIds, qty: 1, orderType: requestedOrderType, route: effectiveTransport, warranty: warrantyPlanId \}\)\);/);
});

test('review: the single door sends inCart, and a lost answer is re-read before another press can double the line', () => {
  const add = SRC.slice(SRC.indexOf('const postAddToCart = useCallback('), SRC.indexOf('const handleAddToCart'));
  assert.doesNotMatch(add, /Retrying after a failure is safe \(the server upserts one row\)/, 'the upsert ADDS: a retry was never safe');
  assert.match(add, /if \(cartLinesLoaded\) body\.inCart = before;/);
  assert.match(add, /err\.code === 'CART_LINES_CHANGED'/);
  assert.match(add, /err\.status === 0/);
  assert.match(add, /lostAnswerVerdict\(\[\{ id: 'line', before, want: qty, after: lineQtyIn\(fresh, product\.id, optionValueIds, optionId, colorId\), maxQty: availability\?\.stock\.max_qty \?\? null, replaced: replaceCart \}\]\)/);
});

test('review: an option that leaves fewer than two colours closes «عدة ألوان» with a notice, never silently back to the old single quantity', () => {
  assert.match(SRC, /if \(colourMode === 'many' && !multiOffered\) \{[\s\S]{0,900}?closeMultiForOption\(/);
  assert.match(SRC, /setColourHint\(\{ kind: 'closed', names: closed\.dropped\.map\(colourNameOf\) \}\);/);
  assert.match(SRC, /colourHint\.kind === 'closed'\s*\?\s*cs\.multiClosed\(/);
});

test('review: the colours left behind are remembered for «حدّد كمية لكل لون» and the switch; the opening colour counts for D6', () => {
  const tap = constBlock('afterColourTap');
  assert.match(SRC, /colourMemory\.current = rememberAfterTap\(colourMemory\.current, \{ from, to, qty \}\);/);
  assert.match(SRC, /const w = tapWindow\(colourTaps\.current, from, to, now\);/);
  assert.ok(tap.length > 0);
  assert.match(SRC, /setMultiRows\(prefillRows\(\{ \.\.\.multiRows, \.\.\.colourMemory\.current, \.\.\.seed \}, /);
});

test('review: in «عدة ألوان» the header says nothing about the colour the page holds behind the scenes', () => {
  assert.match(SRC, /const stockNote = colourMulti \? '' : shelfNote;/);
  assert.equal((SRC.match(/\{stockNote \?|\{stockNote &&|\{shelfNote/g) ?? []).length, 1, 'the note is drawn in one place, from the gated value');
});

test('review: ⚡ names what it buys, and its toast names what was bought', () => {
  const bar = readFileSync(join(ROOT, 'src/components/quickBuy/QuickBuyBar.tsx'), 'utf8');
  assert.match(bar, /\{buy\.busy \? words\.ctaBusy : buy\.label \?\? words\.cta\}/);
  assert.match(bar, /aria-label=\{quick \? buy\.ariaLabel : words\.turnOn\}/);
  assert.match(SRC, /label: quickBuyCapsuleLabel,/);
  assert.match(SRC, /ariaLabel: quickBuyCapsuleAria,/);
  const actions = readFileSync(join(ROOT, 'src/components/quickBuy/quickBuyActions.ts'), 'utf8');
  assert.match(actions, /toast\.success\(ctx\.addedTitle \|\| t\.added,/);
  const quick = SRC.slice(SRC.indexOf('const runQuickBuy = useCallback('), SRC.indexOf('runQuickBuyRef.current = '));
  assert.match(quick, /addedTitle: quickChosen \? colourStrings\(lang\)\.quickBuyAdded\(countTimesName\(\{ name: quickChosen\.name, qty \}\)\) : undefined,/);
});

test('review: the several-colours panel — a lost capped answer, the guest label, focus after the sheet, one alert, the sheet width, the reload target', () => {
  assert.match(PANEL, /lostAnswerVerdict\(/);
  assert.match(PANEL, /cs\.partlyAdded/);
  assert.doesNotMatch(PANEL, /after === ceilingOf\(id\) \+ before/, 'a capped merge never ends at before + the shelf');
  assert.match(PANEL, /const btn = multiAddButton\(\{ lang: cl, signedIn: isAuthenticated, signInLabel, busy, gateOpen, lines \}\);/);
  assert.match(PANEL, /disabled=\{btn\.disabled\}/);
  assert.match(PANEL, /aria-disabled=\{btn\.ariaDisabled \|\| undefined\}/);
  assert.match(PANEL, /\{!\(panelSlot && wide\) \? <div className="mt-3 space-y-2">\{topBlock\}<\/div> : null\}/, 'one role="alert" per layout');
  assert.match(PANEL, /panelClassName="sm:max-w-\[440px\] sm:w-\[92vw\]"/);
  assert.match(PANEL, /className="relative lv-hit ms-2 font-bold underline underline-offset-2"/);
  assert.match(PANEL, /aria-label=\{cs\.sheetLine\(isolate\(name\), groupedNumber\(added\)\)\}/);
  assert.match(PANEL, /cs\.totalLine\(pieces, live\.length\)/);
  assert.match(PANEL, /heldOnSharedCounter\(cartLinesLoaded \? cartLines : \[\], productId, q\.scope, sharedOptionValueIds\)/);
});

test('review: a swatch\'s ring is the 3:1 field line, so black reads on the dark theme and white on the light', async () => {
  const tag = readFileSync(join(ROOT, 'src/components/product/ColourTag.tsx'), 'utf8');
  assert.doesNotMatch(tag, /ring-border-subtle/);
  assert.equal((tag.match(/ring-1 ring-\[var\(--clay-field\)\]/g) ?? []).length, 2, 'the colour circle and the picture circle');
  const { contrast, parseColor } = (await import('../scripts/theme-tokens.mjs')) as { contrast: (a: number[], b: number[]) => number; parseColor: (v: string) => number[] };
  const css = readFileSync(join(ROOT, 'src/index.css'), 'utf8');
  const dark = css.slice(css.indexOf("[data-theme='dark']"));
  const light = css.slice(css.indexOf("[data-theme='light']"), css.indexOf("[data-theme='dark']"));
  const v = (block: string, name: string) => parseColor(new RegExp(`--${name}:([^;}]+)`).exec(block)![1].trim());
  for (const g of ['surface', 'surface-raised', 'surface-selected', 'canvas']) {
    assert.ok(contrast(v(dark, 'clay-field'), v(dark, `color-${g}`)) >= 3, `dark ring on ${g}`);
    assert.ok(contrast(v(dark, 'clay-field'), parseColor('#111111')) >= 3, 'dark ring around a black swatch');
    assert.ok(contrast(v(light, 'clay-field'), v(light, `color-${g}`)) >= 3, `light ring on ${g}`);
    assert.ok(contrast(v(light, 'clay-field'), parseColor('#ffffff')) >= 3, 'light ring around a white swatch');
  }
});

test('review: no colour chosen on a colour-stock filament — the sentence beside the button asks for a colour, it does not say «out of stock»', () => {
  assert.match(
    SRC,
    /mode === 'unavailable' && availability\?\.reason \? \([\s\S]{0,600}?\{colourToChoose && !chosenColour \? reasonText\(s, 'COLOR_REQUIRED'\) : reasonText\(s, availability\.reason\)\}/
  );
});
