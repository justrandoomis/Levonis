/**
 * «في الألوان عند تفعيلها فإنه يجبرني على وضع مخزون لكل لون بالرغم من أن
 *  التوضيح انه إذا كان الحقل فارغا يعني صفر غير متوفر أو نافذ، لكن المشكلة
 *  أنه يجبرني على وضع مخزون لكل لون 0 كتابة».
 *
 * The box said «0 = نفد» and the form refused to publish until all twenty-three
 * of them had been typed by hand. Both behaviours were defensible alone and
 * they could not both be right, so here is what a blank ACTUALLY meant:
 *
 *   * a MISSING variant row is already zero — worker/lib/inventory.ts, in
 *     VARIANT_COMBINATION mode: "a combination with no `product_variants` row
 *     is NOT sellable… no silent fallback to base stock";
 *   * a PRESENT row whose stock is NULL is UNTRACKED, which is unlimited.
 *
 * And the form creates a row, with `stock: null`, the moment a colour is
 * linked to a model. So every blank box in that grid was an UNLIMITED shelf —
 * the exact opposite of the placeholder's promise — and on top of that
 * `deriveInventoryMode` only answers VARIANT_COMBINATION when every exact
 * combination carries a number, so publishing with blanks would also have
 * dropped the whole product onto one shared counter.
 *
 * That is what the blocking error was protecting against, and asking for
 * twenty-three hand-typed zeros is not how to protect against it. The blank is
 * resolved at the SAVE BOUNDARY to the number the box already promised.
 *
 * Every assertion below executes the real functions the form saves through.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  combinationKey,
  deriveInventoryMode,
  directStockCombinations,
  emptyRelations,
  relationsToWire,
  withBlankDirectStockAsZero,
  type RelationsState,
} from '../src/components/adminProducts/form/model';

const directSale = [
  { fulfillment_type: 'direct_sale', enabled: true, transports: [], capacity_reserved: 0 },
];
const preOrderOnly = [
  {
    fulfillment_type: 'pre_order',
    enabled: true,
    capacity_reserved: 0,
    transports: [{ method: 'land', enabled: true }],
  },
];

/**
 * The owner's shape in miniature: one group of two models, both sold
 * directly, and two colours each linked to both — four exact shelves, none of
 * them filled in. `as unknown as RelationsState` for the same reason
 * tests/adminProductSelectionUi.test.ts does it: these functions read a named
 * handful of fields and a full literal would be pages of irrelevant nulls.
 */
function shop(over: Partial<RelationsState> = {}): RelationsState {
  return {
    ...emptyRelations(),
    groups: [
      {
        id: 'g1',
        name_en: 'Spool type',
        sort: 0,
        active: true,
        values: [
          { id: 'o_spool', name_en: 'With Spool', active: true, stock: null, fulfillments: directSale },
          { id: 'o_refill', name_en: 'Refill', active: true, stock: null, fulfillments: directSale },
        ],
      },
    ],
    colors: [
      { id: 'c_bone', name_en: 'Bone White', hex: '#e8e8e8', active: true, stock: null, option_value_ids: ['o_spool', 'o_refill'] },
      { id: 'c_tan', name_en: 'Desert Tan', hex: '#e8dbb7', active: true, stock: null, option_value_ids: ['o_spool', 'o_refill'] },
    ],
    variants: [],
    ...over,
  } as unknown as RelationsState;
}

test('four colour × model shelves, and none of them has to be typed', () => {
  const rel = shop();
  assert.equal(directStockCombinations(rel).length, 4, 'two models × two colours');
  // The validator is module-private, so the refusal's removal is pinned by
  // reading the source it used to live in — the string is what the owner
  // photographed, and its return would be the regression.
  const model = readFileSync(new URL('../src/components/adminProducts/form/model.ts', import.meta.url), 'utf8');
  assert.ok(
    !model.includes("'أدخل مخزون البيع المباشر لكل خيار مرتبط بهذا اللون'"),
    'publishing is no longer refused for a blank shelf'
  );
  assert.ok(
    !model.includes("'أدخل مخزون البيع المباشر للخيارات التي لا ترتبط بألوان'"),
    'nor for a colour-less exact shelf, which was the same refusal'
  );
});

test('a blank shelf is SAVED as zero, not as unlimited', () => {
  const wire = relationsToWire(shop());
  assert.equal(wire.variants.length, 4, 'every exact shelf is written');
  assert.deepEqual(
    wire.variants.map((v: { stock: number | null }) => v.stock),
    [0, 0, 0, 0],
    'blank means nothing is on the shelf — a NULL here would be UNTRACKED, i.e. unlimited'
  );
});

test('and the product keeps its per-combination counters rather than collapsing to one', () => {
  // `deriveInventoryMode` answers VARIANT_COMBINATION only for a COMPLETE
  // grid. Before this, a blank dropped the whole product to a single shared
  // counter — a second, quieter way for the same blank to oversell.
  assert.equal(relationsToWire(shop()).inventory_mode, 'VARIANT_COMBINATION');
  assert.equal(deriveInventoryMode(withBlankDirectStockAsZero(shop())), 'VARIANT_COMBINATION');
});

test('a number the admin DID type is never overwritten', () => {
  const rel = shop({
    variants: [
      { id: 'v1', option_value_ids: ['o_spool'], color_id: 'c_bone', active: true, stock: 7, reserved: 0 },
      { id: 'v2', option_value_ids: ['o_refill'], color_id: 'c_tan', active: true, stock: 0, reserved: 0 },
    ],
  } as unknown as Partial<RelationsState>);
  const wire = relationsToWire(rel);
  const byKey = new Map(
    wire.variants.map((v: { option_value_ids: string[]; color_id: string | null; stock: number | null }) => [
      combinationKey(v),
      v.stock,
    ])
  );
  assert.equal(byKey.get(combinationKey({ option_value_ids: ['o_spool'], color_id: 'c_bone' })), 7, 'kept');
  assert.equal(byKey.get(combinationKey({ option_value_ids: ['o_refill'], color_id: 'c_tan' })), 0, 'an explicit 0 is still 0');
  assert.equal(byKey.size, 4, 'and the two nobody filled are zeroed');
});

test('it never writes a PRE-ORDER shelf — that is a different counter', () => {
  const rel = shop({
    groups: [
      {
        id: 'g1',
        name_en: 'Spool type',
        sort: 0,
        active: true,
        values: [
          { id: 'o_spool', name_en: 'With Spool', active: true, stock: null, fulfillments: preOrderOnly },
          { id: 'o_refill', name_en: 'Refill', active: true, stock: null, fulfillments: preOrderOnly },
        ],
      },
    ],
  } as unknown as Partial<RelationsState>);
  assert.deepEqual(relationsToWire(rel).variants, [], 'a pre-order-only model has no direct shelf to zero');
});

test('a product with no colour grid at all is untouched', () => {
  const plain = {
    ...emptyRelations(),
    groups: [
      {
        id: 'g1',
        name_en: 'Size',
        sort: 0,
        active: true,
        values: [{ id: 'o1', name_en: 'M', active: true, stock: 4, fulfillments: directSale }],
      },
    ],
  } as unknown as RelationsState;
  assert.equal(directStockCombinations(plain).length, 0, 'no colour is linked to a model');
  assert.equal(withBlankDirectStockAsZero(plain), plain, 'the same object back — nothing to resolve');
});

test('the resolution is pure: the state React is rendering from is not mutated', () => {
  const rel = shop();
  const before = JSON.stringify(rel);
  withBlankDirectStockAsZero(rel);
  relationsToWire(rel);
  assert.equal(JSON.stringify(rel), before, 'no variant was added to the live state');
});

test('the reader this relies on still says a missing row is zero', () => {
  /**
   * The whole change rests on VARIANT_COMBINATION meaning what its own header
   * says. If that ever softens into a fallback, a zeroed shelf stops being
   * a zero and this test is where it is caught.
   */
  const inventory = readFileSync(new URL('../worker/lib/inventory.ts', import.meta.url), 'utf8');
  assert.match(inventory, /combination with no `product_variants` row is\s*\n?\s*\* NOT sellable/);
  assert.match(inventory, /return \{ targets: \[\], tracked: true, available: 0, error: 'VARIANT_NOT_MODELLED' \};/);
  // And that a PRESENT row with a null stock is untracked — the case the
  // blank used to fall into.
  assert.match(inventory, /if \(v\.stock === null\) return untracked;/);
});
