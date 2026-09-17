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
  assert.match(model, /أدخل مخزون البيع المباشر لكل خيار مرتبط بهذا اللون/);
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
  assert.match(quick, /directStockCombinations\(complete\)/);
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
  assert.match(page, /setOptionId\(openingOptionId\)/);
  assert.match(page, /setColorId\(/);
  assert.match(page, /setOrderType\(initial \? 'direct_sale' : ''\)/);
  assert.doesNotMatch(page, /useEffect\(\(\) => \{[\s\S]{0,300}setOrderType\('direct_sale'\)/);
});

test('the direct-stock card edge overlays every product-card surface without changing layout', () => {
  const edge = read(CARD_EDGE);
  assert.match(edge, /pointer-events-none absolute inset-x-0 bottom-0/);
  assert.match(edge, /h-3/);
  assert.match(edge, /data-direct-stock-edge/);
  assert.doesNotMatch(edge, /rounded-/);

  for (const path of [HOME_CARD, PRODUCTS, PROFILE]) {
    const card = read(path);
    assert.match(card, /DirectStockEdge/);
    assert.match(card, /\brelative\b/);
    assert.match(card, /overflow-hidden/);
  }
});
