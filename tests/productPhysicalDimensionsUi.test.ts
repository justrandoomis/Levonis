import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPhysicalMeasurement,
  hasProductDimensions,
  resolveProductSelectionDimensions,
} from '../src/lib/productDimensions';

const product = {
  dimensions: {
    net_weight_g: 8000,
    width_mm: 430,
    depth_mm: 400,
    height_mm: 450,
    package_weight_g: 10000,
    package_width_mm: 500,
    package_depth_mm: 550,
    package_height_mm: 590,
  },
};

const relations = {
  option_groups: [
    {
      values: [
        { id: 'a1', net_weight_g: 7900, package_weight_g: 9200, package_height_mm: 600 },
        { id: 'a1_combo', net_weight_g: 8400, package_weight_g: 12000, package_height_mm: 650 },
      ],
    },
  ],
  colors: [{ id: 'black', width_mm: 440, package_width_mm: 520 }],
  variants: [
    {
      id: 'a1_black',
      combo_key: 'o:a1|c:black',
      package_weight_g: 9500,
      package_depth_mm: 570,
    },
    {
      id: 'combo_black',
      combo_key: 'o:a1_combo|c:black',
      package_weight_g: null,
      package_depth_mm: 620,
    },
  ],
};

test('product page resolves A1 and A1 Combo cartons field-by-field', () => {
  assert.deepEqual(
    resolveProductSelectionDimensions(product, relations, {
      optionValueIds: ['a1'],
      colorId: 'black',
    }),
    {
      net_weight_g: 7900,
      width_mm: 440,
      depth_mm: 400,
      height_mm: 450,
      package_weight_g: 9500,
      package_width_mm: 520,
      package_depth_mm: 570,
      package_height_mm: 600,
    }
  );

  const combo = resolveProductSelectionDimensions(product, relations, {
    optionValueIds: ['a1_combo'],
    colorId: 'black',
  });
  assert.deepEqual(combo, {
    net_weight_g: 8400,
    width_mm: 440,
    depth_mm: 400,
    height_mm: 450,
    package_weight_g: 12000,
    package_width_mm: 520,
    package_depth_mm: 620,
    package_height_mm: 650,
  });
  assert.equal(hasProductDimensions(combo), true);
});

test('storefront formats g/mm as exact kg/cm text without mutating resolved facts', () => {
  assert.equal(formatPhysicalMeasurement(9500, 'weight'), '9.5 kg');
  assert.equal(formatPhysicalMeasurement(1234, 'weight'), '1.234 kg');
  assert.equal(formatPhysicalMeasurement(1, 'weight'), '0.001 kg');
  assert.equal(formatPhysicalMeasurement(520, 'length'), '52 cm');
  assert.equal(formatPhysicalMeasurement(11, 'length'), '1.1 cm');
  assert.equal(formatPhysicalMeasurement(null, 'length'), '—');
});

test('product page renders all eight resolved fields without copying them into state', () => {
  const source = readFileSync(new URL('../src/pages/Product.tsx', import.meta.url), 'utf8');
  for (const field of [
    'net_weight_g',
    'width_mm',
    'depth_mm',
    'height_mm',
    'package_weight_g',
    'package_width_mm',
    'package_depth_mm',
    'package_height_mm',
  ]) {
    assert.match(source, new RegExp(`key: '${field}'`), field);
  }
  assert.match(source, /resolveProductSelectionDimensions\(product, relations/);
  assert.match(source, /data-resolved-physical-dimensions/);
  assert.match(source, /formatPhysicalMeasurement\(value, row\.kind\)/);
  assert.doesNotMatch(source, /setPhysicalDimensions/);

  const projection = readFileSync(new URL('../worker/lib/productModel.ts', import.meta.url), 'utf8');
  assert.match(projection, /dimensions:\s*doc\.dimensions/);
});
