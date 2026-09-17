/**
 * A CARD IS NOT A PRODUCT DOCUMENT.
 *
 * `/api/home` returns 30 rows and `/api/products` up to 50, and each one used
 * to be serialized through the FULL public projection — the option ladder,
 * every colour with its four price columns, the spec groups, the usage guide
 * and its per-step media, three languages of description, the warranty plans.
 * A grid that draws a picture, a name and a price was being handed tens of
 * kilobytes per tile.
 *
 * Two things have to stay true for `cardShape` to be safe, and neither is
 * obvious from reading it:
 *
 *   1. It must keep every field the card components actually read. Those
 *      components were enumerated when the list was written; this test is what
 *      stops the list and the components drifting apart afterwards.
 *   2. It must NOT keep the heavy, page-only fields — otherwise it is a
 *      comment rather than a projection.
 *
 * And the number on the card must not move: the price is resolved over the
 * WHOLE document before the projection runs, so narrowing the output cannot
 * change it. The last test pins that directly.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { cardShape } from '../worker/routes/products';

/** Every field the card surfaces read, gathered from the files themselves. */
const READ_BY_CARDS = [
  'id',
  'slug',
  'product_slug',
  'name',
  'status',
  'media',
  'images',
  'price_iqd',
  'display_price_iqd',
  'display_regular_iqd',
  'display_prime_iqd',
  'display_pro_iqd',
  'display_applied_tier',
  'display_from',
  'direct_stock_available',
  'offer',
];

/** Page-only, and the reason the payload was large. */
const MUST_NOT_SURVIVE = [
  'options',
  'colors',
  'spec_groups',
  'spec_fields',
  'warranty_plans',
  'warranty_base_months',
  'usage_guide',
  'how_to_use',
  'content_blocks',
  'description',
  'description_ar',
  'description_en',
  'description_ckb',
  'description_images',
  'description_videos',
  'labels',
  'delivery_options',
  'payment_options',
  'preorder_transports',
  'specifications',
  'features',
  'shipping_methods',
  'membership_prices',
  'stores',
];

/** A product row as the full projection would emit it. */
const fullRow = (): Record<string, unknown> => ({
  ...Object.fromEntries(READ_BY_CARDS.map((k) => [k, `v:${k}`])),
  ...Object.fromEntries(MUST_NOT_SURVIVE.map((k) => [k, `HEAVY:${k}`])),
  display_plus_iqd: 1,
  sku: 'SKU-1',
  template_family: 'printers-fdm',
  hashtags: ['a', 'b'],
});

test('every field the card components read survives the projection', () => {
  const card = cardShape(fullRow());
  for (const k of READ_BY_CARDS) {
    assert.equal(card[k], `v:${k}`, `cardShape dropped ${k}, which a card renders`);
  }
});

test('the page-only bulk does not survive — this is the whole point of the projection', () => {
  const card = cardShape(fullRow());
  for (const k of MUST_NOT_SURVIVE) {
    assert.equal(k in card, false, `cardShape kept ${k}; the payload is still a product document`);
  }
});

test('a field the projection does not name is dropped, not passed through', () => {
  const card = cardShape({ ...fullRow(), something_new_and_enormous: 'x'.repeat(10_000) });
  assert.equal('something_new_and_enormous' in card, false);
});

test('an absent field is omitted rather than serialized as undefined', () => {
  // `product_slug` exists only on a composition row. Emitting `undefined` for
  // every ordinary product would put the key back in the JSON as null.
  const card = cardShape({ id: 'p1', slug: 's', name: 'n', price_iqd: 1000 });
  assert.equal('product_slug' in card, false);
  assert.equal('offer' in card, false);
  assert.deepEqual(Object.keys(card).sort(), ['id', 'name', 'price_iqd', 'slug']);
});

test('the projection is applied to the OUTPUT, never to the query that resolves the price', () => {
  // `display_price_iqd` is the cheapest way to buy the product, computed by
  // walking every option and colour. Narrowing the SELECT would change it;
  // narrowing the serialized output cannot. Pin that the routes still hand the
  // whole row to the resolver and only then project.
  const src = readFileSync(join(ROOT, 'worker/routes/products.ts'), 'utf8');
  assert.ok(
    src.includes("let sql = \"SELECT * FROM products WHERE status = 'active'\""),
    'the list route no longer selects the whole row — the resolver would lose the option ladder'
  );
  assert.ok(
    /cardShape\(\s*publicWithDisplayPrice\(/.test(src),
    'cardShape must wrap the resolver result, not replace it'
  );
});

test('a composition card is never run through the product projection', () => {
  // `compositionCard` already returns a narrow shape, and a LOCKED bundle has
  // its member prices stripped in there. Re-projecting it would be a different
  // bug, and a quiet one.
  const src = readFileSync(join(ROOT, 'worker/routes/products.ts'), 'utf8');
  assert.ok(
    src.includes('if (b) return compositionCard(b, ctx);'),
    'the composition branch must return before the product projection'
  );
  assert.ok(
    !/cardShape\(\s*compositionCard/.test(src),
    'a composition card is being re-projected'
  );
});
