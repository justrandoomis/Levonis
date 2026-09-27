/**
 * A KEY IS THE PRODUCT'S OWN — worker/lib/relationIdScope.ts.
 *
 * The owner's file «Bambu-Lab-PLA-Pure-LEVONIS.txt» was refused at «افحص
 * الملف»: `option value id "refill-1kg" already belongs to another product`,
 * because another filament's file had already used the same keys. Two
 * products may now be written from the same keys; each keeps its own rows,
 * every link follows the scoped id, and a re-import lands on the same rows.
 *
 * Driven through the real TXT parse/apply routes on a real migrated database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, all, row, count } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { loadRelationsView, snapshotFrom } from '../worker/lib/productOverlay';
import { resolveForOrderType } from '../worker/lib/inventory';
import { MAX_SCOPED_ID, remapRelationIds, scopedRelationId } from '../worker/lib/relationIdScope';

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };

function setup() {
  const raw = freshDb();
  const db = asD1(raw);
  const app = stubApp(db, OWNER, (a) => a.route('/api/admin/template', templateRoutes));
  return { raw, db, app };
}

/** One filament, with the keys every filament file of the family shares. */
const filament = (slug: string, name: string, extra = '') =>
  `template_version=2
slug=${slug}
name_ar=${name}
name_en=${name}
price_iqd=25000
selling_type=direct_sale
inventory_mode=VARIANT_COMBINATION
options.1.id=refill-1kg
options.1.name_ar=ريفل 1 كغ
options.1.name_en=Refill 1kg
options.1.active=true
options.1.direct.enabled=true
options.1.stock=__NULL__
options.2.id=with-spool-1kg
options.2.name_ar=مع بكرة 1 كغ
options.2.name_en=With spool 1kg
options.2.active=true
options.2.direct.enabled=true
options.2.stock=__NULL__
colors.1.id=white
colors.1.name_ar=أبيض
colors.1.name_en=White
colors.1.hex=#FFFFFF
colors.1.option_id=__NULL__
colors.1.active=true
variants.1.id=refill-white
variants.1.option_value_ids=refill-1kg
variants.1.color_id=white
variants.1.active=true
variants.1.stock=7
variants.2.id=spool-white
variants.2.option_value_ids=with-spool-1kg
variants.2.color_id=white
variants.2.active=true
variants.2.stock=3
${extra}`;

interface Applied {
  product_id?: string;
  error?: string;
  errors?: string[];
}

async function apply(app: ReturnType<typeof setup>['app'], text: string, mode: 'draft' | 'update' = 'draft') {
  const res = await post(app, '/api/admin/template/apply', { text, mode, confirm: true });
  const body = (await res.json()) as Applied;
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.product_id!;
}

const valueIds = (raw: ReturnType<typeof setup>['raw'], productId: string) =>
  all<{ id: string }>(raw, 'SELECT id FROM product_option_values WHERE product_id = ? ORDER BY sort', productId).map((r) => r.id);

test('the owner’s case: a second filament written from the same keys is checked and saved, not refused', async () => {
  const { app, raw, db } = setup();
  const first = await apply(app, filament('pla-basic', 'PLA Basic'));

  // «افحص الملف» — the preview that refused the owner's file.
  const text = filament('pla-pure', 'PLA Pure');
  const parsed = (await (await post(app, '/api/admin/template/parse', { text })).json()) as {
    errors?: unknown[];
    validation_error?: { errors?: string[] } | null;
  };
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.validation_error ?? null, null, JSON.stringify(parsed.validation_error));

  const second = await apply(app, text);
  assert.notEqual(first, second);

  // The first product's rows are exactly as it wrote them.
  assert.deepEqual(valueIds(raw, first), ['refill-1kg', 'with-spool-1kg']);
  assert.equal(row(raw, 'SELECT product_id FROM product_colors WHERE id = ?', 'white')?.product_id, first);

  // The second product has its own, scoped to it, and every link follows.
  const scoped = (key: string) => scopedRelationId(key, second);
  assert.deepEqual(valueIds(raw, second), [scoped('refill-1kg'), scoped('with-spool-1kg')]);
  assert.equal(row(raw, 'SELECT product_id FROM product_colors WHERE id = ?', scoped('white'))?.product_id, second);
  assert.deepEqual(
    all(raw, 'SELECT id, combo_key, stock FROM product_variants WHERE product_id = ? ORDER BY stock', second).map((r) => [
      r.id,
      r.combo_key,
      r.stock,
    ]),
    [
      [scoped('spool-white'), `o:${scoped('with-spool-1kg')}|c:${scoped('white')}`, 3],
      [scoped('refill-white'), `o:${scoped('refill-1kg')}|c:${scoped('white')}`, 7],
    ]
  );

  // And the door the cart uses sells the second product from its own shelf.
  const product = row(raw, 'SELECT inventory_mode FROM products WHERE id = ?', second)!;
  const view = await loadRelationsView(db, second, product.inventory_mode as string);
  const snap = snapshotFrom(view, { stock: null, reserved: 0, low_stock_threshold: null });
  const refill = resolveForOrderType(
    'direct_sale',
    snap,
    { option_value_ids: [scoped('refill-1kg')], color_id: scoped('white') },
    null,
    ''
  );
  assert.equal(refill.error, null);
  assert.equal(refill.available, 7);
});

test('re-importing the same file into the same product updates its rows — no duplicates, no new ids', async () => {
  const { app, raw } = setup();
  await apply(app, filament('pla-basic', 'PLA Basic'));
  const second = await apply(app, filament('pla-pure', 'PLA Pure'));
  const before = valueIds(raw, second);

  // The owner's original file again, now as an update of the second product.
  const again = await apply(app, `product_id=${second}\n${filament('pla-pure', 'PLA Pure')}`.replace('variants.1.stock=7', 'variants.1.stock=9'), 'update');
  assert.equal(again, second);
  assert.deepEqual(valueIds(raw, second), before, 'the same scoped rows, not new ones');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?', second), 2);
  assert.equal(
    row(raw, 'SELECT stock FROM product_variants WHERE id = ?', scopedRelationId('refill-white', second))?.stock,
    9,
    'the edit landed on the existing combination'
  );
});

test('a key the product already owns is never renamed', async () => {
  const { app, raw } = setup();
  const first = await apply(app, filament('pla-basic', 'PLA Basic'));
  await apply(app, filament('pla-pure', 'PLA Pure'));
  // The FIRST product re-imports its own file: its keys are its own rows.
  await apply(app, `product_id=${first}\n${filament('pla-basic', 'PLA Basic')}`, 'update');
  assert.deepEqual(valueIds(raw, first), ['refill-1kg', 'with-spool-1kg']);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM product_option_values WHERE id LIKE 'refill-1kg-%'`), 1, 'only the second product’s scoped row');
});

test('scoped ids are stable, product-specific and inside the cart’s 60-character limit', () => {
  assert.equal(scopedRelationId('refill-1kg', 'prd_a'), scopedRelationId('refill-1kg', 'prd_a'));
  assert.notEqual(scopedRelationId('refill-1kg', 'prd_a'), scopedRelationId('refill-1kg', 'prd_b'));
  assert.match(scopedRelationId('refill-1kg', 'prd_a'), /^refill-1kg-[0-9a-z]{7}$/);
  const long = 'x'.repeat(58);
  const a = scopedRelationId(`${long}-a`, 'prd_a');
  const b = scopedRelationId(`${long}-b`, 'prd_a');
  assert.ok(a.length <= MAX_SCOPED_ID && b.length <= MAX_SCOPED_ID);
  assert.notEqual(a, b, 'two long keys sharing a prefix still differ');
});

test('every link follows a renamed id: colour → options, combination → options and colour, picture → its binding', () => {
  const maps = {
    groups: new Map([['g', 'g-s']]),
    values: new Map([['v1', 'v1-s']]),
    colors: new Map([['c1', 'c1-s']]),
    variants: new Map([['x1', 'x1-s']]),
    images: new Map([['i1', 'i1-s']]),
  };
  const out = remapRelationIds(
    {
      groups: [{ id: 'g', values: [{ id: 'v1' }, { id: 'v2' }] }],
      colors: [{ id: 'c1', option_value_ids: ['v1', 'v2'] }],
      variants: [{ id: 'x1', option_value_ids: ['v1'], color_id: 'c1' }],
      images: [
        { id: 'i1', option_value_id: 'v1' },
        { id: 'i2', color_id: 'c1' },
        { id: 'i3', variant_id: 'x1' },
      ],
    },
    maps
  );
  assert.deepEqual(out, {
    groups: [{ id: 'g-s', values: [{ id: 'v1-s' }, { id: 'v2' }] }],
    colors: [{ id: 'c1-s', option_value_ids: ['v1-s', 'v2'] }],
    variants: [{ id: 'x1-s', option_value_ids: ['v1-s'], color_id: 'c1-s' }],
    images: [
      { id: 'i1-s', option_value_id: 'v1-s' },
      { id: 'i2', color_id: 'c1-s' },
      { id: 'i3', variant_id: 'x1-s' },
    ],
  });
  // A key the payload does not carry stays absent: several mean «preserve».
  assert.equal('facet_ids' in remapRelationIds({ groups: [] }, maps), false);
  assert.equal('colors' in remapRelationIds({ groups: [] }, maps), false);
});
