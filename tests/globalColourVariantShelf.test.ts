/**
 * A GLOBAL COLOUR UNDER EXACT COMBINATIONS NEEDS ITS OWN SHELF PER OPTION.
 *
 * A colour linked to no option (`option_id=__NULL__`) is offered with every
 * option on the product page. The order door (`resolveStock`,
 * VARIANT_COMBINATION) resolves Small+Black to `o:small|c:black` and answers
 * VARIANT_NOT_MODELLED when that row is absent. The save planner used to treat
 * the same colour as linked to NOTHING and demand a colour-less `o:small`
 * shelf instead — so a save succeeded whose Small+Black could never be sold
 * direct, and the exact shelf that WOULD sell was refused.
 *
 * Driven through the real TXT and admin-form routes on a real migrated
 * database.
 * Run: node --import tsx --test tests/globalColourVariantShelf.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, all, row } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { loadRelationsView, snapshotFrom } from '../worker/lib/productOverlay';
import { resolveForOrderType } from '../worker/lib/inventory';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import {
  combinationKey,
  directStockCombinations,
  emptyRelations,
  relationsToWire,
  type RelationsState,
} from '../src/components/adminProducts/form/model';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

function setup() {
  const raw = freshDb();
  const db = asD1(raw);
  const app = stubApp(db, OWNER, (a) => {
    a.route('/api/admin/template', templateRoutes);
  });
  return { raw, db, app };
}

/** Two direct-sale options and one colour shown for both. */
const file = (variants: string) =>
  `template_version=2
slug=global-colour-shelf
name_ar=منتج لون عام
name_en=Global colour product
price_iqd=100000
selling_type=direct_sale
inventory_mode=VARIANT_COMBINATION
options.1.id=opt_small
options.1.name_ar=صغير
options.1.name_en=Small
options.1.active=true
options.1.direct.enabled=true
options.1.stock=__NULL__
options.2.id=opt_large
options.2.name_ar=كبير
options.2.name_en=Large
options.2.active=true
options.2.direct.enabled=true
options.2.stock=__NULL__
colors.1.id=col_black
colors.1.name_ar=أسود
colors.1.name_en=Black
colors.1.hex=#111111
colors.1.option_id=__NULL__
colors.1.active=true
${variants}
`;

const shelf = (n: number, option: string, color: string | null, stock: number) =>
  [
    `variants.${n}.id=var_${n}`,
    `variants.${n}.option_value_ids=${option}`,
    `variants.${n}.color_id=${color ?? '__NULL__'}`,
    `variants.${n}.active=true`,
    `variants.${n}.stock=${stock}`,
  ].join('\n');

interface ParseBody {
  errors?: unknown[];
  validation_error?: { message?: string; errors?: string[] } | null;
}

test('colour-less shelves alone no longer satisfy a global colour — the unsellable save is refused before apply', async () => {
  const { app } = setup();
  const text = file([shelf(1, 'opt_small', null, 5), shelf(2, 'opt_large', null, 3)].join('\n'));
  const res = await post(app, '/api/admin/template/parse', { text });
  const body = (await res.json()) as ParseBody;
  assert.deepEqual(body.errors, []);
  assert.ok(body.validation_error, 'the planner must refuse');
  assert.deepEqual(body.validation_error.errors, [
    'Colour "Black" needs direct-sale stock for option "Small"',
    'Colour "Black" needs direct-sale stock for option "Large"',
  ]);

  const applied = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true });
  assert.equal(applied.status, 400);
});

test('one exact shelf per option×global colour saves, and Small+Black is sellable direct', async () => {
  const { app, raw, db } = setup();
  const text = file([shelf(1, 'opt_small', 'col_black', 5), shelf(2, 'opt_large', 'col_black', 0)].join('\n'));
  const res = await post(app, '/api/admin/template/parse', { text });
  const body = (await res.json()) as ParseBody;
  assert.equal(body.validation_error ?? null, null, JSON.stringify(body.validation_error));

  const applied = await post(app, '/api/admin/template/apply', { text, mode: 'draft', confirm: true });
  const appliedBody = (await applied.json()) as { product_id?: string };
  assert.equal(applied.status, 200, JSON.stringify(appliedBody));
  const productId = appliedBody.product_id!;
  assert.deepEqual(
    all(raw, 'SELECT combo_key, stock FROM product_variants WHERE product_id = ? ORDER BY combo_key', productId).map(
      (r) => [r.combo_key, r.stock]
    ),
    [
      ['o:opt_large|c:col_black', 0],
      ['o:opt_small|c:col_black', 5],
    ]
  );

  // The door the cart and checkout use answers the same selection from the
  // same shelf the planner demanded.
  const product = row(raw, 'SELECT inventory_mode FROM products WHERE id = ?', productId)!;
  const view = await loadRelationsView(db, productId, product.inventory_mode);
  const snap = snapshotFrom(view, { stock: null, reserved: 0, low_stock_threshold: null });
  const small = resolveForOrderType('direct_sale', snap, { option_value_ids: ['opt_small'], color_id: 'col_black' }, null, '');
  assert.equal(small.error, null);
  assert.equal(small.available, 5);
  const large = resolveForOrderType('direct_sale', snap, { option_value_ids: ['opt_large'], color_id: 'col_black' }, null, '');
  assert.equal(large.error, null);
  assert.equal(large.available, 0);
});

test('a missing option×global-colour shelf is named, even when the other option has one', async () => {
  const { app } = setup();
  const text = file(shelf(1, 'opt_small', 'col_black', 5));
  const body = (await (await post(app, '/api/admin/template/parse', { text })).json()) as ParseBody;
  assert.deepEqual(body.validation_error?.errors, ['Colour "Black" needs direct-sale stock for option "Large"']);
});

// ============================================================ the admin form
//
// The planner above is the same one the form's save doors run
// (adminProducts.ts, adminProductRelations.ts). The form builds its
// direct-stock grid in `directStockCombinations`; before this it skipped every
// colour linked to no model, so a product with one linked and one global
// colour sent the colour-less shelves the old rule wanted, and the save was
// refused with a shelf the admin had no box to type into.

const directCell = [{ fulfillment_type: 'direct_sale', enabled: true, transports: [], capacity_reserved: 0 }];

/** Colour A on Small only, colour B global; the admin typed Small×A = 5. */
function mixedForm(): RelationsState {
  return {
    ...emptyRelations(),
    groups: [
      {
        id: 'g_size',
        name_en: 'Size',
        sort: 0,
        active: true,
        values: [
          { id: 'opt_small', name_en: 'Small', name_ar: 'صغير', active: true, stock: null, fulfillments: directCell },
          { id: 'opt_large', name_en: 'Large', name_ar: 'كبير', active: true, stock: null, fulfillments: directCell },
        ],
      },
    ],
    colors: [
      { id: 'col_a', name_en: 'A', name_ar: 'أ', hex: '#111111', active: true, stock: null, option_value_ids: ['opt_small'] },
      { id: 'col_b', name_en: 'B', name_ar: 'ب', hex: '#222222', active: true, stock: null, option_value_ids: [] },
    ],
    variants: [
      { id: 'pv_small_a', option_value_ids: ['opt_small'], color_id: 'col_a', sku: '', active: true, stock: 5, reserved: 0, low_stock_threshold: null },
    ],
  } as unknown as RelationsState;
}

test('the form grid shows one shelf per option × global colour, beside the linked ones', () => {
  assert.deepEqual(directStockCombinations(mixedForm()).map(combinationKey).sort(), [
    'o:opt_large|c:col_b',
    'o:opt_small|c:col_a',
    'o:opt_small|c:col_b',
  ]);
  // Global colours alone, on a product not on exact combinations, stay a
  // plain option-stock product: no grid appears out of nowhere.
  const plain = { ...mixedForm(), colors: mixedForm().colors.filter((c) => c.id === 'col_b'), variants: [] };
  assert.deepEqual(directStockCombinations(plain), []);
});

test('the form save of a linked + global colour product is accepted by the planner, blanks stored as zero', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  const app = stubApp(db, OWNER, (a) => {
    a.route('/api/admin/products-v2', adminProductsRoutes);
    a.route('/api/admin/products', adminProductRelationsRoutes);
  });
  const made = (await (
    await post(app, '/api/admin/products-v2', { name_en: 'Mixed', name_ar: 'مختلط', price_iqd: 100000, status: 'draft' })
  ).json()) as { product: { id: string } };
  const id = made.product.id;
  const wire = relationsToWire(mixedForm());
  assert.equal(wire.inventory_mode, 'VARIANT_COMBINATION');
  const res = await app.request(`/api/admin/products/${id}/relations`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(wire),
  });
  assert.equal(res.status, 200, await res.text());
  assert.deepEqual(
    all(raw, 'SELECT combo_key, stock FROM product_variants WHERE product_id = ? ORDER BY combo_key', id).map((r) => [
      r.combo_key,
      r.stock,
    ]),
    [
      ['o:opt_large|c:col_b', 0],
      ['o:opt_small|c:col_a', 5],
      ['o:opt_small|c:col_b', 0],
    ]
  );
});
