/**
 * A ROW THE SHOP IS HIDING MUST LOOK HIDDEN IN THE ADMIN.
 *
 * A live product reached twenty-five colours with `product_colors.active = 0`.
 * The storefront hid every one of them — correctly — while the admin's «مفعّل»
 * toggle read «معروض» for all twenty-five, because the form hydrated with
 * `c.active !== 0` and the admin wire carries a BOOLEAN. `false !== 0` is
 * true, so the one screen that could have shown the problem asserted the
 * opposite, and saving quietly turned them all back on.
 *
 * These tests pin both halves: the form tells the truth, and there is one tap
 * that undoes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relationsFromWire } from '../src/components/adminProducts/form/model';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const wire = (active: unknown) =>
  ({
    success: true,
    product: { inventory_mode: 'OPTION' },
    groups: [{ id: 'og1', name_en: 'Type', sort: 0, active: true }],
    values: [
      { id: 'ov1', group_id: 'og1', name_en: 'Refill', sku_part: '', image: '', sort: 0,
        active, stock: null, reserved: 0, low_stock_threshold: null },
    ],
    colors: [
      { id: 'pc1', name_en: 'Pink', hex: '#ffc0cb', image: '', sku_part: '', sort: 0,
        active, stock: null, reserved: 0, low_stock_threshold: null },
    ],
    links: [], variants: [], images: [], fulfillments: [],
  }) as unknown as Parameters<typeof relationsFromWire>[0];

test('a hidden row hydrates as hidden — boolean false, not just integer 0', () => {
  // The admin wire's shape: every admin path calls applyRelations with
  // `includeInactive: true`, and worker/lib/productOverlay.ts then emits
  // `active: truthy(x.active)` — a boolean, never the raw column.
  assert.equal(relationsFromWire(wire(false)).colors[0].active, false, 'boolean false is hidden');
  assert.equal(relationsFromWire(wire(0)).colors[0].active, false, 'integer 0 is hidden');
  assert.equal(relationsFromWire(wire(false)).groups[0].values[0].active, false, 'and for option values');

  // …and everything else is shown, including a row that states nothing. That
  // matches the persister, which writes 1 unless the payload says `false`
  // (worker/lib/productPersistence.ts).
  assert.equal(relationsFromWire(wire(true)).colors[0].active, true);
  assert.equal(relationsFromWire(wire(1)).colors[0].active, true);
  assert.equal(relationsFromWire(wire(undefined)).colors[0].active, true, 'a missing key is not "off"');
});

test('the predicate is the SERVER’s own rule, written once', () => {
  const model = readFileSync(join(ROOT, 'src/components/adminProducts/form/model.ts'), 'utf8');
  // `truthy` in worker/lib/productOverlay.ts is `v !== 0 && v !== false`, and
  // it is what decides what the shop shows. The form must not carry a second,
  // different answer to the same question.
  assert.match(model, /const isShown = \(v: unknown\): boolean => v !== 0 && v !== false;/);
  const overlay = readFileSync(join(ROOT, 'worker/lib/productOverlay.ts'), 'utf8');
  assert.match(overlay, /const truthy = \(v: number \| boolean\) => v !== 0 && v !== false;/);

  // No hydration site may go back to the half-test.
  assert.ok(!/active: [a-z]\.active !== 0,/.test(model), 'no site still asks only `!== 0`');
  assert.equal((model.match(/active: isShown\(/g) ?? []).length, 4, 'groups, values, colours, variants');
});

test('hidden colours are announced, and undone in one tap', () => {
  const ui = readFileSync(join(ROOT, 'src/components/adminProducts/form/OptionsSection.tsx'), 'utf8');
  assert.match(ui, /const hiddenColors = rel\.colors\.filter\(\(c\) => !c\.active\)\.length;/);
  // One action, not twenty-five taps.
  assert.match(ui, /const showAllColors = \(\)[\s\S]{0,200}colors: r\.colors\.map\(\(c\) => \(\{ \.\.\.c, active: true \}\)\)/);
  assert.match(ui, /data-colors-hidden-notice/);
  assert.match(ui, /إظهار الكل/);
  // The banner states the consequence, not just a count, and says so
  // differently when EVERY colour is hidden — the case that reads on the shop
  // as "this product has no colours at all".
  assert.match(ui, /كل الألوان \(\$\{hiddenColors\}\) مخفية/);
  assert.match(ui, /لا يظهر أي لون في صفحة المنتج/);
  // Shown only when something is hidden.
  assert.match(ui, /\{hiddenColors > 0 \? \(/);
});
