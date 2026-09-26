/**
 * «يضغط على الرقم ويكتب الكمية التي يريدها … إذا كان المخزون ألف قطعة وكتب
 *  المستخدم ألف وواحد يرفض ويرجعه إلى ألف … أما في البيع المسبق فيكون متاحا.»
 *
 * The rules behind the one quantity control (packages/pricing/src/quantity.ts)
 * and the wiring that makes every buying surface use it.
 *
 * Run: node --import tsx --test tests/quantityInput.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINE_QTY_MAX,
  QTY_INPUT_MAX,
  clampQuantity,
  quantityLimit,
  resolveQuantityDraft,
  sanitizeQuantityDraft,
} from '../packages/pricing/src/quantity';
import { saleAvailability } from '../worker/routes/products';
import { ROOT } from './fixtures/d1';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ─────────────────────────────────────────────── what a keyboard types

test('Arabic-Indic and Persian digits read as digits', () => {
  assert.equal(sanitizeQuantityDraft('١٢٣'), '123');
  assert.equal(sanitizeQuantityDraft('۱۲۳'), '123');
  assert.equal(sanitizeQuantityDraft('١٠۰0'), '1000', 'mixed systems in one figure');
});

test('a pasted grouped figure is its digits; signs, fractions and letters are dropped', () => {
  assert.equal(sanitizeQuantityDraft('1,000'), '1000');
  assert.equal(sanitizeQuantityDraft('١٬٠٠٠'), '1000', 'the Arabic thousands separator');
  assert.equal(sanitizeQuantityDraft(' 12 pcs'), '12');
  assert.equal(sanitizeQuantityDraft('-5'), '5');
  assert.equal(sanitizeQuantityDraft('abc'), '');
});

test('the field holds at most six digits', () => {
  assert.equal(sanitizeQuantityDraft('12345678'), '123456');
  assert.ok(QTY_INPUT_MAX >= 999_999);
});

// ─────────────────────────────────────────────── what a draft commits to

test('empty goes back to what it was — never 0, never a silent 1', () => {
  assert.deepEqual(resolveQuantityDraft('', { max: 50, previous: 7 }), { value: 7, capped: false, raised: false });
  assert.deepEqual(resolveQuantityDraft('  ', { max: 50, previous: 7 }).value, 7);
  assert.deepEqual(resolveQuantityDraft('xyz', { max: 50, previous: 3 }).value, 3);
});

test('0 becomes the floor of 1', () => {
  assert.deepEqual(resolveQuantityDraft('0', { max: 50, previous: 7 }), { value: 1, capped: false, raised: true });
  assert.equal(resolveQuantityDraft('٠', { max: 50, previous: 7 }).value, 1);
});

test('the owner’s example: 1,000 on the shelf, 1,001 typed → 1,000, and it says so', () => {
  const r = resolveQuantityDraft('1001', { max: 1000, previous: 1 });
  assert.deepEqual(r, { value: 1000, capped: true, raised: false });
  assert.deepEqual(resolveQuantityDraft('1,000', { max: 1000, previous: 1 }), { value: 1000, capped: false, raised: false });
  assert.deepEqual(resolveQuantityDraft('١٠٠١', { max: 1000, previous: 1 }).value, 1000);
});

test('a figure within the ceiling is taken as typed', () => {
  assert.deepEqual(resolveQuantityDraft('250', { max: 1000, previous: 1 }), { value: 250, capped: false, raised: false });
});

test('clampQuantity is total: NaN, fractions and an empty shelf all land in range', () => {
  assert.equal(clampQuantity(Number.NaN, 10).value, 1);
  assert.equal(clampQuantity(2.9, 10).value, 2);
  assert.equal(clampQuantity(5, 0).value, 1, 'nothing sellable still shows 1 — the buy button is what is disabled');
  assert.deepEqual(clampQuantity(11, 10), { value: 10, capped: true, raised: false });
});

// ─────────────────────────────────────────── whose ceiling, from the server

test('direct sale: the ceiling is the shelf, named as the shelf', () => {
  const lim = quantityLimit({ mode: 'direct_sale', stock: { available: 40, max_qty: 40 } });
  assert.deepEqual(lim, { max: 40, kind: 'stock' });
});

test('direct sale with more on the shelf than one line may hold: the per-line ceiling, named as such', () => {
  const lim = quantityLimit({ mode: 'direct_sale', stock: { available: LINE_QTY_MAX * 3, max_qty: LINE_QTY_MAX } });
  assert.deepEqual(lim, { max: LINE_QTY_MAX, kind: 'per_order' }, 'never «المتوفر: <ceiling>» about a bigger shelf');
});

test('pre-order is open: no quota means only the per-line ceiling', () => {
  const lim = quantityLimit({
    mode: 'preorder',
    stock: { available: 0, max_qty: LINE_QTY_MAX },
    preorder: { capacity: { available: null, max_qty: LINE_QTY_MAX } },
  });
  assert.deepEqual(lim, { max: LINE_QTY_MAX, kind: 'per_order' }, 'an empty shelf does not limit a pre-order');
});

test('pre-order with a tracked quota: the quota is the ceiling, named as the quota', () => {
  const lim = quantityLimit({
    mode: 'preorder',
    stock: { available: 0, max_qty: 12 },
    preorder: { capacity: { available: 12, max_qty: 12 } },
  });
  assert.deepEqual(lim, { max: 12, kind: 'preorder_quota' });
});

test('no availability block (an older Worker) falls back to the per-line ceiling', () => {
  assert.deepEqual(quantityLimit(undefined), { max: LINE_QTY_MAX, kind: 'per_order' });
});

test('switching the sale type re-applies the rule: the same selection, two ceilings', () => {
  const doc = {
    selling_type: 'direct_sale',
    sale_types: ['direct_sale', 'pre_order'],
    stock: 3,
    options: [],
    colors: [],
    preorder_transports: [{ method: 'air', commission_iqd: 25_000, active: true }],
  } as unknown as Parameters<typeof saleAvailability>[0];
  const direct = saleAvailability(doc, { preferredType: 'direct_sale', transportDefaults: [] });
  const pre = saleAvailability(doc, { preferredType: 'pre_order', transportMethod: 'air', transportDefaults: [] });
  assert.equal(direct.mode, 'direct_sale');
  assert.deepEqual(quantityLimit(direct), { max: 3, kind: 'stock' });
  assert.equal(pre.mode, 'preorder');
  assert.deepEqual(quantityLimit(pre), { max: LINE_QTY_MAX, kind: 'per_order' }, 'the shelf of 3 does not cap a pre-order');
  // And the door agrees with the page about a quantity over the shelf.
  assert.equal(saleAvailability(doc, { preferredType: 'direct_sale', qty: 4, transportDefaults: [] }).qty_ok, false);
  assert.equal(saleAvailability(doc, { preferredType: 'pre_order', transportMethod: 'air', qty: 40, transportDefaults: [] }).qty_ok, true);
});

// ─────────────────────────────────────────────── one control everywhere

const SURFACES = [
  'src/pages/Product.tsx',
  'src/pages/Cart.tsx',
  'src/pages/BundleDetail.tsx',
  'src/pages/StorefrontProduct.tsx',
  'src/components/merchant/MerchantCartView.tsx',
];

test('every buying surface uses QuantityInput, and no hand-made stepper is left', () => {
  for (const rel of SURFACES) {
    const src = read(rel);
    assert.match(src, /<QuantityInput\b/, `${rel} does not use the shared control`);
    assert.doesNotMatch(src, /<Minus\b/, `${rel} still draws its own − button`);
    assert.doesNotMatch(src, /Math\.min\(99\b/, `${rel} still hard-codes the per-line ceiling`);
  }
});

test('the control types, commits once, clamps quietly and is labelled', () => {
  const src = read('src/components/ui/QuantityInput.tsx');
  assert.match(src, /inputMode="numeric"/);
  assert.match(src, /el\.select\(\)/, 'tapping the number selects it, so typing replaces it');
  assert.match(src, /onBlur=\{\(e\) => commit\(/, 'commits on blur');
  assert.match(src, /e\.key === 'Enter'/, 'and on Enter / Done');
  assert.match(src, /aria-live="polite"/, 'the hint is announced politely');
  assert.match(src, /loc\('الكمية'/, 'the number is called «الكمية»');
  assert.match(src, /الحد الأقصى المتوفر: \$\{shown\}/);
  assert.doesNotMatch(src, /confirm\(|alert\(/, 'never a dialog');
  assert.doesNotMatch(src, /\bdark:/, 'theme roles only');
});

test('the cart saves a quantity once per decision and flushes before checkout', () => {
  const src = read('src/pages/Cart.tsx');
  assert.match(src, /setTimeout\(run, QTY_DEBOUNCE_MS\)/);
  assert.match(src, /await flushQuantities\(\);\s*navigate\('\/checkout'/);
});

test('no door hard-codes the per-line ceiling any more', () => {
  for (const rel of ['worker/routes/cart.ts', 'worker/routes/products.ts']) {
    const src = read(rel);
    assert.doesNotMatch(src, /MIN\(99,|max: 99\b(?!,? ?def: 5)/, `${rel} still carries its own 99`);
  }
});
