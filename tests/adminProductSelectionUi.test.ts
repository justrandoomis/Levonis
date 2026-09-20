import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  centimetresToMillimetres,
  DimensionsSection,
  gramsToKilograms,
  inheritedMeasurementPlaceholder,
  kilogramsToGrams,
  millimetresToCentimetres,
} from '../src/components/adminProducts/form/DimensionsSection';
import {
  cleanDanglingImageBindings,
  emptyRelations,
  inheritedDimensionsForSelection,
  relationsFromWire,
  relationsToWire,
  type RelationsResponse,
  type RelationsState,
} from '../src/components/adminProducts/form/model';
import { emptyDimensions } from '../src/lib/productTypes';
import {
  productGalleryForSelection,
  productSelectionComboKey,
  productVariantIdForSelection,
} from '../src/lib/productImage';

test('kg↔g and cm↔mm editor conversions round-trip exactly', () => {
  for (const grams of [1, 50, 999, 1000, 1234, 9400, 99_999_999]) {
    assert.equal(kilogramsToGrams(gramsToKilograms(grams)), grams, `${grams} g`);
  }
  for (const millimetres of [1, 9, 10, 11, 430, 999_999]) {
    assert.equal(centimetresToMillimetres(millimetresToCentimetres(millimetres)), millimetres, `${millimetres} mm`);
  }
  assert.equal(kilogramsToGrams('0.0001'), null, 'sub-gram precision is not rounded');
  assert.equal(centimetresToMillimetres('1.23'), null, 'sub-millimetre precision is not rounded');
  assert.equal(kilogramsToGrams(''), null, 'empty is inherit');
});

test('selection dimensions start collapsed and label inherited placeholders with values and units', () => {
  const overrides = { ...emptyDimensions(), width_mm: 411 };
  const inherited = { ...emptyDimensions(), net_weight_g: 1234, width_mm: 400 };
  const html = renderToStaticMarkup(createElement(DimensionsSection, {
    dimensions: overrides,
    inherited,
    collapsible: true,
    onChange: () => undefined,
  }));

  assert.match(html, /aria-expanded="false"/, 'a custom override does not auto-expand the editor');
  assert.match(html, /data-dimensions-mode="custom"/, 'the collapsed header still exposes custom state');
  assert.match(html, /placeholder="Inherited \/ من الأعلى · 1\.234 kg"/);
  assert.equal(inheritedMeasurementPlaceholder(11, 10), 'Inherited / من الأعلى · 1.1 cm');
  assert.equal(inheritedMeasurementPlaceholder(null, 10), '');
  assert.equal(overrides.net_weight_g, null, 'rendering a placeholder did not copy it into override state');
});

test('relation dimension overrides reload and save as flat nullable fields', () => {
  const prices = {
    regular_price_iqd: null,
    prime_price_iqd: null,
    pro_price_iqd: null,
    cost_iqd: null,
  };
  const response = {
    success: true,
    groups: [{ id: 'g', name_en: 'Model', sort: 0, active: 1 }],
    values: [{
      ...prices,
      id: 'o', group_id: 'g', name_en: 'A1', sku_part: '', image: '', sort: 0, active: 1,
      stock: null, low_stock_threshold: null, net_weight_g: 8000, width_mm: null,
    }],
    colors: [{
      ...prices,
      id: 'c', name_en: 'Black', hex: '#000000', image: '', sku_part: '', sort: 0, active: 1,
      stock: null, low_stock_threshold: null, package_weight_g: 9400,
    }],
    variants: [{
      ...prices,
      id: 'v', combo_key: 'o:o|c:c', sku: null, active: 1, stock: null,
      low_stock_threshold: null, height_mm: 450,
    }],
    links: [{ color_id: 'c', option_value_id: 'o', group_id: 'g' }],
    images: [],
  } as unknown as RelationsResponse;

  const state = relationsFromWire(response);
  assert.equal(state.groups[0].values[0].dimensions?.net_weight_g, 8000);
  assert.equal(state.groups[0].values[0].dimensions?.width_mm, null);
  assert.equal(state.colors[0].dimensions?.package_weight_g, 9400);
  assert.equal(state.variants[0].dimensions?.height_mm, 450);

  const wire = relationsToWire(state);
  assert.equal(wire.groups[0].values[0].net_weight_g, 8000);
  assert.equal(wire.groups[0].values[0].width_mm, null, 'clear is sent explicitly as null');
  assert.equal(wire.colors[0].package_weight_g, 9400);
  assert.equal(wire.variants[0].height_mm, 450);
  assert.equal('dimensions' in wire.groups[0].values[0], false, 'wire contract stays flat');
});

test('dimension placeholders resolve product → first authored option → color without mutating overrides', () => {
  const first = { ...emptyDimensions(), width_mm: 410 };
  const second = { ...emptyDimensions(), width_mm: 999, depth_mm: 500 };
  const color = { ...emptyDimensions(), height_mm: 450 };
  const rel = {
    ...emptyRelations(),
    groups: [
      { id: 'g1', name_en: 'Model', sort: 0, active: true, values: [{ id: 'o1', active: true, dimensions: first }] },
      { id: 'g2', name_en: 'Size', sort: 1, active: true, values: [{ id: 'o2', active: true, dimensions: second }] },
    ],
    colors: [{ id: 'c', active: true, dimensions: color }],
  } as unknown as RelationsState;
  const product = { ...emptyDimensions(), width_mm: 400, depth_mm: 420, height_mm: 430 };
  const inherited = inheritedDimensionsForSelection(rel, product, {
    option_value_ids: ['o2', 'o1'],
    color_id: 'c',
  });
  assert.deepEqual(
    { width_mm: inherited.width_mm, depth_mm: inherited.depth_mm, height_mm: inherited.height_mm },
    { width_mm: 410, depth_mm: 420, height_mm: 450 }
  );
  assert.equal(first.depth_mm, null, 'inherited product value was not copied into option state');
  assert.equal(color.width_mm, null, 'inherited option value was not copied into color state');
});

test('removing a target clears option/color/variant bindings without deleting gallery rows', () => {
  const rel = {
    ...emptyRelations(),
    images: [
      { id: 'io', url: '/o.webp', option_value_id: 'gone', color_id: null, variant_id: null },
      { id: 'ic', url: '/c.webp', option_value_id: null, color_id: 'gone', variant_id: null },
      { id: 'iv', url: '/v.webp', option_value_id: null, color_id: null, variant_id: 'gone' },
    ],
  } as RelationsState;
  const cleaned = cleanDanglingImageBindings(rel);
  assert.equal(cleaned.images.length, 3);
  assert.deepEqual(
    cleaned.images.map((image) => [image.option_value_id, image.color_id, image.variant_id]),
    [[null, null, null], [null, null, null], [null, null, null]]
  );
});

test('selection media resolves variant > color > every selected option > primary, preserving gallery order within a tier', () => {
  const base = [
    { id: 'primary', url: '/primary.webp', primary: true },
    { id: 'o2', url: '/o2.webp' },
    { id: 'color', url: '/color.webp' },
    { id: 'variant', url: '/variant.webp' },
    { id: 'o1', url: '/o1.webp' },
  ];
  const bindings = [
    { id: 'o1', url: '/o1.webp', option_value_id: 'model-a' },
    { id: 'o2', url: '/o2.webp', option_value_id: 'size-l' },
    { id: 'color', url: '/color.webp', color_id: 'red' },
    { id: 'variant', url: '/variant.webp', variant_id: 'v-exact' },
  ];
  assert.equal(
    productSelectionComboKey({ optionValueIds: ['size-l', 'model-a'], colorId: 'red' }),
    'o:model-a|o:size-l|c:red'
  );
  const variantId = productVariantIdForSelection(
    [{ id: 'v-exact', combo_key: 'o:model-a|o:size-l|c:red' }],
    { optionValueIds: ['size-l', 'model-a'], colorId: 'red' }
  );
  assert.equal(variantId, 'v-exact');
  assert.deepEqual(
    productGalleryForSelection(base, bindings, {
      optionValueIds: ['model-a', 'size-l'], colorId: 'red', variantId,
    }).map((image) => image.url),
    ['/variant.webp', '/color.webp', '/o2.webp', '/o1.webp', '/primary.webp']
  );
});
