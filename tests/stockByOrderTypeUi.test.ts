/**
 * Option-owned fulfilment and direct-only inventory — UI contract.
 *
 * There is no browser runner in this repository, so these assertions pin the
 * visible wiring in the same source-level style as the other admin UI tests.
 * Run: npx tsx --test tests/stockByOrderTypeUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const OPTIONS = 'src/components/adminProducts/form/OptionsSection.tsx';
const MODEL = 'src/components/adminProducts/form/model.ts';
const FORM = 'src/components/adminProducts/ProductForm.tsx';
const QUICK = 'src/components/adminProducts/QuickPricePanel.tsx';
const PRODUCT = 'src/pages/Product.tsx';
const CARD_EDGE = 'src/components/DirectStockEdge.tsx';
const HOME_CARD = 'src/components/home/ProductCard.tsx';
const PRODUCTS = 'src/pages/Products.tsx';
const PROFILE = 'src/pages/Profile.tsx';

test('the duplicate model-order panel is gone and fulfilment lives on each option', () => {
  assert.equal(
    existsSync(join(ROOT, 'src/components/adminProducts/FulfillmentPanel.tsx')),
    false,
    'the obsolete second fulfilment editor still exists'
  );
  const form = read(FORM);
  assert.doesNotMatch(form, /FulfillmentPanel/);
  assert.doesNotMatch(form, /نوع الطلب لكل موديل/);

  const options = read(OPTIONS);
  assert.match(options, /function FulfillmentEditor/);
  assert.match(options, /data-option-availability=\{value\.id\}/);
});

test('direct sale and pre-order are independent checkboxes on an option', () => {
  const options = read(OPTIONS);
  const editor = options.slice(options.indexOf('function FulfillmentEditor'));
  assert.match(editor, /checked=\{direct\.enabled\}/);
  assert.match(editor, /replaceCell\(\{ \.\.\.direct, enabled \}\)/);
  assert.match(editor, /checked=\{preorder\.enabled\}/);
  assert.match(editor, /replaceCell\(\{ \.\.\.preorder, enabled \}\)/);
  assert.match(editor, /زيادة البيع المباشر/);
  assert.match(editor, /regular_adjust_iqd/);
});

test('pre-order exposes route availability and increases but no inventory control', () => {
  const options = read(OPTIONS);
  const editor = options.slice(options.indexOf('function FulfillmentEditor'));
  assert.match(editor, /Pre-order — بلا مخزون/);
  for (const method of ['land', 'sea', 'air']) assert.match(editor, new RegExp(`method: '${method}'`));
  assert.match(editor, /current\.surcharge_iqd/);
  assert.doesNotMatch(editor, /preorder\.capacity|route\.capacity|سعة الطلب المسبق/);

  const model = read(MODEL);
  assert.match(model, /capacity: f\.capacity_reserved > 0 \? f\.capacity : null/);
  assert.match(model, /capacity: t\.capacity_reserved > 0 \? t\.capacity : null/);
});

test('direct stock is option-owned until a colour is linked, then exact option-colour rows own it', () => {
  const options = read(OPTIONS);
  const model = read(MODEL);
  assert.match(options, /<Qty value=\{v\.stock\}/);
  assert.match(options, /data-option-stock-total=\{v\.id\}/);
  assert.match(options, /مجموع الألوان/);
  assert.match(options, /data-color-direct-stock=\{c\.id\}/);
  assert.match(options, /setCombinationStock\(combo, stock\)/);
  assert.match(model, /export function directStockCombinations/);
  assert.match(model, /color_id: null/);
  assert.match(model, /return 'VARIANT_COMBINATION'/);

  // A BLANK SHELF IS ZERO, NOT A REFUSAL. This used to pin the opposite: the
  // error that blocked saving until every exact option-colour box carried a
  // typed number — twenty-three of them on the owner's own product, each
  // beside a box reading «0 = نفد». The grid must still be complete when it
  // reaches the server (a present row with a NULL stock is UNTRACKED, and a
  // hole in the grid drops the product to one shared counter), so the blank
  // is resolved at the save boundary instead of demanded from the admin.
  assert.doesNotMatch(model, /أدخل مخزون البيع المباشر لكل خيار مرتبط بهذا اللون/);
  assert.doesNotMatch(model, /أدخل مخزون البيع المباشر للخيارات التي لا ترتبط بألوان/);
  assert.match(model, /export function withBlankDirectStockAsZero/);
  assert.match(model, /const rel = withBlankDirectStockAsZero\(input\);/);
  // Resolved BEFORE the mode is derived, or the payload and the mode would be
  // computed from two different grids.
  const wire = model.slice(model.indexOf('export function relationsToWire'));
  assert.ok(
    wire.indexOf('withBlankDirectStockAsZero(input)') < wire.indexOf('deriveInventoryMode(rel)'),
    'the blanks must be filled before the inventory mode is derived from them'
  );
  // The option-level blank is a different question and keeps its own check.
  assert.match(model, /أدخل مخزون البيع المباشر لهذا الخيار/);
});

test('the product-level selling section keeps delivery and warranty, not stock or surcharge fields', () => {
  const form = read(FORM);
  assert.match(form, /خيارات التوصيل والضمان/);
  assert.match(form, /Delivery & warranty/);
  assert.doesNotMatch(form, /ar="مخزون المنتج"/);
  assert.doesNotMatch(form, /ar="حد التنبيه"/);
  assert.doesNotMatch(form, /ar="زيادة البيع المباشر"/);
});

test('Quick Price Edit mirrors fulfilment, route increases and exact direct stock', () => {
  const quick = read(QUICK);
  assert.match(quick, /function QuickFulfillmentPanel/);
  assert.match(quick, /التوفر والزيادة والمخزون حسب الخيار/);
  // Read from the RESOLVED state, not the raw one: the quick panel routes
  // through the same save-boundary rule as the full editor, so a blank
  // direct-sale shelf is a zero here too rather than a wall.
  assert.match(quick, /const resolved = withBlankDirectStockAsZero\(complete\);/);
  assert.match(quick, /directStockCombinations\(resolved\)/);
  assert.doesNotMatch(quick, /أكمل ربط الألوان ومخزونها من التعديل الكامل أولًا/);
  assert.doesNotMatch(quick, /أدخل مخزون البيع المباشر لكل خيار أو لون مفعّل قبل الحفظ/);
  assert.match(quick, /scope: 'variant' as const/);
  assert.match(quick, /scope: 'option' as const/);
  assert.match(quick, /inventoryMode = exact\.length > 0 \? 'VARIANT_COMBINATION' : 'OPTION'/);
  assert.match(quick, /Pre-order — بلا مخزون/);
  assert.match(quick, /stock: enabled && !hasCombinations && v\.stock === null \? 0 : v\.stock/);
  assert.match(quick, /aria-selected=\{tab === x\.id\}/);
  assert.doesNotMatch(quick, /preorder\.capacity/);
});

test('the product price card does not repeat item price or fulfilment surcharge notes', () => {
  const page = read(PRODUCT);
  assert.doesNotMatch(page, /itemPrice:/);
  assert.doesNotMatch(page, /transportFee:/);
  assert.doesNotMatch(page, /directFee:/);
  assert.match(page, /data-warranty-fee-row/);
  assert.match(page, /item price and fulfilment increases are deliberately/);
});

test('the desktop product layout uses the viewport and stacks availability choices vertically', () => {
  const page = read(PRODUCT);
  assert.match(page, /max-w-\[1540px\]/);
  assert.match(page, /lg:grid-cols-\[minmax\(0,1fr\)_400px\]/);
  assert.match(page, /xl:grid-cols-\[minmax\(0,1fr\)_440px\]/);
  assert.match(page, /<div className="mt-2 flex flex-col gap-2">/);
  assert.doesNotMatch(page, /عمولة الطلب المسبق غير معدة/);
  assert.doesNotMatch(page, /Pre-order commission is not configured/);
});

test('product details apply the server-proven stocked direct selection once on load', () => {
  const page = read(PRODUCT);
  assert.match(page, /data\.initial_selection\?\.fulfillment_type === 'direct_sale'/);
  assert.match(page, /setOptionValueIds\(openingOptionValueIds\)/);
  assert.match(page, /optionValueIds: optionValueIds\.length \? optionValueIds : undefined/);
  assert.match(page, /body\.optionValueIds = optionValueIds/);
  assert.match(page, /data-option-groups/);
  assert.match(page, /relationOptionGroups\.flatMap/);
  assert.match(page, /setColorId\(/);
  assert.match(page, /setOrderType\(initial \? 'direct_sale' : ''\)/);
  assert.doesNotMatch(page, /useEffect\(\(\) => \{[\s\S]{0,300}setOrderType\('direct_sale'\)/);
});

test('inactive relational groups never fall back to legacy product options', () => {
  const page = read(PRODUCT);
  assert.match(page, /const opts = data\.relations\s*\?[\s\S]{0,180}publicRelationOptionIds\.has\(option\.id\)/);
  assert.doesNotMatch(page, /publicRelationOptionIds\.size > 0/);
  assert.match(page, /const storefrontOptions = useMemo\(\(\) => \{[\s\S]{0,180}if \(!relations\) return all;/);
  assert.match(page, /const options = storefrontOptions;/);
  assert.doesNotMatch(page, /relationIds\.size > 0|visibleOptionIds\.size > 0/);
});

/**
 * THE OWNER'S COLOUR RULE, in their own words:
 *
 *   «إذا لم يحدد اللون لأي خيار يكون تحديد لكل الخيارات، إذا حدد لخيار واحد
 *    فيظهر فقط في هذا الخيار»
 *
 * A colour that names NO option belongs to every option; a colour that names
 * one belongs only to that one.
 *
 * THIS TEST USED TO PIN THE OPPOSITE OF HALF OF IT. It asserted the exact
 * expression `!c.option_id || chosen.has(c.option_id)`, which asks whether the
 * CHOSEN value is the colour's — and before the buyer has chosen anything
 * `chosen` is empty, so every option-linked colour was hidden. On a product
 * whose direct sale is sold out there is no `initial_selection` to pre-select
 * an option with, so the page opened with NO colours at all. That is the
 * defect the owner reported as «الألوان لا تظهر في صفحة تفاصيل المنتج»,
 * written down here as a requirement.
 *
 * What the test protects is unchanged and is the half that matters: once an
 * option IS chosen, a colour belonging to a different one must not be
 * offered. Only the not-yet-chosen case moved.
 */
test('a colour with no option belongs to every option, and a linked one narrows once a choice exists', () => {
  const page = read(PRODUCT);
  // The old wholesale bypass must not come back: it returned EVERY colour
  // regardless of links, which would offer a colour for an option it is not
  // sold in the moment the buyer chose that option.
  assert.doesNotMatch(page, /if \(optionValueIds\.length === 0\) return all;/);

  // The owner's default, per colour rather than for the whole list.
  assert.match(page, /const nothingChosen = chosen\.size === 0;/);
  assert.match(
    page,
    /if \(links\.length === 0\) return !c\.option_id \|\| nothingChosen \|\| chosen\.has\(c\.option_id\);/,
    'an unassigned colour is on every option; an assigned one narrows once a choice exists'
  );
  assert.match(page, /if \(nothingChosen\) return true;/, 'and a linked colour is visible before any choice too');

  // The narrowing itself — per-group AND, per-link OR — is what keeps a colour
  // off an option it does not belong to, and it is untouched.
  assert.match(page, /\[\.\.\.byGroup\.values\(\)\]\.every\(\(ids\) => ids\.some\(\(id\) => chosen\.has\(id\)\)\)/);

  // The effect that drops a now-invalid colour is what stops a stale pick
  // surviving a change of option.
  assert.match(page, /if \(colorId && !colorsForOption\.some\(\(c\) => c\.id === colorId\)\) setColorId\(''\)/);
});

test('the direct-stock card edge overlays every product-card surface without changing layout', () => {
  const edge = read(CARD_EDGE);
  assert.match(edge, /pointer-events-none absolute inset-x-0 bottom-0/);
  assert.match(edge, /h-3/);
  assert.match(edge, /data-direct-stock-edge/);
  assert.doesNotMatch(edge, /rounded-/);

  // The regular card and the profile's cards keep the edge. The COMPACT card
  // (docs/ux/CATALOG_DISCOVERY.md §4.1) replaces it with a legible
  // availability line — «an 8 px strip that nobody can read on a phone» —
  // and the /products grid now renders that compact card instead of its own
  // copy, so the direct-stock fact reaches both surfaces in words.
  for (const path of [HOME_CARD, PROFILE]) {
    const card = read(path);
    assert.match(card, /DirectStockEdge/);
    assert.match(card, /\brelative\b/);
    assert.match(card, /overflow-hidden/);
  }
  assert.match(read(HOME_CARD), /<AvailabilityLine product=\{p\}/);
  assert.match(read(PRODUCTS), /<ProductCard p=\{p\} density="compact"/);
});
