/**
 * §11 — COST REACHES NO RESPONSE AN ASSISTANT ADMIN CAN OPEN.
 *
 * `includeCost` was added to the .txt download and stopped there. /parse and
 * /apply return the whole merged document plus a key-by-key diff, so the same
 * admin who could not download the cost sheet could paste the file into
 * "check" and read every cost out of the response instead.
 *
 * Two mechanisms now cover it, and they work differently — which is the point
 * of this file:
 *
 *   `preview` and `product` are DOCUMENTS, stripped by key name
 *      (stripFinancials removes any field called cost_iqd, cost_adjust_iqd, …).
 *
 *   `diff` is an array of {field, before, after}. NONE of those three keys
 *      names a cost, so stripFinancials walks straight past it and the number
 *      would survive as a VALUE. The diff is therefore gated at its source
 *      instead: it is built from docToEntries, and with includeCost false the
 *      cost keys never enter it at all.
 *
 * Assertions here are shaped as "no key mentioning cost survives, at any
 * level", not "cost_iqd is gone" — the shape that catches the NEXT cost column
 * too, whoever adds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductRow, projectAdmin } from '../worker/lib/productModel';
import { applyRelations } from '../worker/lib/productOverlay';
import type { ProductRelationsView } from '../worker/lib/productOverlay';
import { docToEntries } from '../worker/lib/template';
import { stripFinancials } from '../worker/lib/adminScope';

function costlyDoc() {
  const view = {
    has_relations: true,
    inventory_mode: 'BASE',
    groups: [{ id: 'og1', product_id: 'p', name_en: 'Model', sort: 0, active: 1 }],
    values: [
      {
        id: 'ov1', product_id: 'p', group_id: 'og1', name_en: 'A1', sku_part: '', image: '',
        sort: 0, active: 1, stock: null, low_stock_threshold: null,
        regular_price_iqd: 900_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 700_000,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: 12_345,
        availability_type: '', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null,
        variant_key: '', variant_label: '',
      },
    ],
    colors: [
      {
        id: 'pc1', product_id: 'p', name_en: 'Black', hex: '#000000', image: '',
        sort: 0, active: 1, stock: null, low_stock_threshold: null,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 54_321,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
      },
    ],
    links: [], variants: [], images: [],
  } as unknown as ProductRelationsView;
  return applyRelations(
    parseProductRow({
      id: 'p', slug: 'p', status: 'active', name_ar: 'م', price_iqd: 900_000,
      product_cost_iqd: 650_000, selling_type: 'direct_sale',
      sale_types: JSON.stringify(['direct_sale']),
    }),
    view,
    { includeInactive: true }
  );
}

/** Every cost number this product carries, at every level. */
const COST_NUMBERS = ['650000', '700000', '12345', '54321'];

test('with the gate open, the entries carry the costs — otherwise this proves nothing', () => {
  const keys = docToEntries(costlyDoc(), { includeCost: true }).map((e) => e.key);
  assert.ok(keys.some((k) => k === 'product_cost_iqd'));
  assert.ok(keys.some((k) => k.endsWith('.cost_iqd')));
  assert.ok(keys.some((k) => k.endsWith('.cost_adjust_iqd')));
});

test('with the gate closed, NO key mentioning cost is emitted at any level', () => {
  const entries = docToEntries(costlyDoc(), { includeCost: false });
  const offenders = entries.filter((e) => /cost/i.test(e.key));
  assert.deepEqual(offenders, [], `these cost keys survived: ${offenders.map((o) => o.key).join(', ')}`);
});

test('and no cost VALUE survives either — the diff is built from these entries', () => {
  // The diff pairs before/after entry values under the keys `field`, `before`
  // and `after`, none of which stripFinancials recognises. So the only thing
  // standing between an assistant admin and the cost sheet is that the entries
  // never carried it.
  const values = docToEntries(costlyDoc(), { includeCost: false })
    .map((e) => e.value)
    .filter((v): v is string => v !== null);
  for (const n of COST_NUMBERS) {
    assert.ok(!values.includes(n), `the cost ${n} appeared as a diff value`);
  }
});

test('a diff-shaped payload is NOT protected by the key-name stripper', () => {
  // Pinned deliberately: it explains why the gate had to move to the source.
  // If stripFinancials ever learns to read values, this test should be the one
  // that tells us the belt is no longer the only thing holding.
  const diffRow = { field: 'options.1.cost_iqd', before: '700000', after: '650000' };
  assert.deepEqual(stripFinancials([diffRow]), [diffRow]);
});

test('a document payload IS protected by the key-name stripper', () => {
  const stripped = stripFinancials({ preview: projectAdmin(costlyDoc()) });
  const json = JSON.stringify(stripped);
  assert.ok(!/cost/i.test(json), 'no cost field survives in a document projection');
  for (const n of COST_NUMBERS) {
    assert.ok(!json.includes(n), `the cost ${n} survived in the document`);
  }
});

test('the compare-at price is NOT a cost and must not be stripped', () => {
  const doc = { ...costlyDoc(), original_price_iqd: 1_100_000 };
  const stripped = stripFinancials(doc) as { original_price_iqd?: number };
  assert.equal(stripped.original_price_iqd, 1_100_000, 'a public was-price is not margin detail');
});
