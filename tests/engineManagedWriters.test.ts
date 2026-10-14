/**
 * ENGINE_MANAGED: ON AN ENGINE-PRICED PRODUCT THE OLD DINAR PRICE WRITERS
 * REFUSE (owner decision 8; MVP plan §5 "The database is the enforcement").
 *
 * The quick-price grid (cell edit, bulk, copy, undo) and the selection price
 * refuse up front with ENGINE_MANAGED in the viewer's language; the product
 * form's save is refused by the database's value-compared lock when it
 * changes a price, and passes untouched when it does not (stock, names and
 * cost stay editable); a manual product is untouched by all of this. The
 * product detail tells the form the product is engine-managed, so its price
 * cells render read only.
 *
 * Run: node --import tsx --test tests/engineManagedWriters.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

// The quick-price grid, the selection price and the V1 engine write these cases once drove are closed by the
// clean start (DECISIONS row 222, addendum A.6; tests/pricingV2LegacyDoorsRefused.test.ts pins the refusals).
test('the CSV import names an engine product’s refused row in words, never the driver’s text; the form has no dinar price cell to lock', () => {
  const src = readFileSync(join(ROOT, 'worker/routes/adminImport.ts'), 'utf8');
  assert.match(src, /reason: importFailureReason\(error\)/);
  const failureReason = src.slice(src.indexOf('function importFailureReason('), src.indexOf('\ninterface PreviewRow'));
  assert.match(failureReason, /const pricing = engineDbRefusal\(error\);\s*if \(pricing\) return pricing\.message;/,
    'engine refusals retain their deliberate translated message before the generic error fallback');
  assert.doesNotMatch(failureReason, /String\(error\)|error instanceof Error \? error\.message/,
    'an unexpected driver error must never be serialized into the report');
  // Pricing V2-4 (2026-10-14, DECISIONS row 222): the product form types no dinar price, so
  // there is no V1 cell left to lock — a model's and a colour's price is the V2 selector.
  const form = readFileSync(join(ROOT, 'src/components/adminProducts/ProductForm.tsx'), 'utf8');
  assert.doesNotMatch(form, /pricesLocked=|directPricesLocked=/);
  const options = readFileSync(join(ROOT, 'src/components/adminProducts/form/OptionsSection.tsx'), 'utf8');
  assert.doesNotMatch(options, /<Money\b|regular_price_iqd|direct_sale_extra_iqd/);
});
