/**
 * The per-product-type import format — mandate §10, extended to the whole
 * product form (طابعة / ملحقات / فلمنت / اكسسوار).
 *
 * The line this file holds is the round-trip: "تصدير منتج ثم استيراده يعيد نفس
 * الخيارات والألوان والروابط والصور والترتيب والمخزون والأسعار". If
 * `serializeProducts` and `parseImport` ever stop being inverses, an export is
 * a lossy backup and an admin discovers it after re-importing a catalogue.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_COLUMNS,
  SPEC_PREFIX,
  blankTemplate,
  labelRow,
  lookupsSheet,
  parseCsv,
  parseImport,
  readmeFor,
  serializeProducts,
  templateShape,
  templateTypeChoices,
  toCsv,
  type ExportProduct,
} from '../worker/lib/importCsv';
import { blankDoc } from '../src/components/adminProducts/types';
import { PRODUCT_TYPES, groupsForType, productTypeForSection } from '../worker/lib/templateFamilies';
import { normKey, resolveProduct, splitComboKey } from '../worker/lib/importApply';
import type { CatalogRef, ExistingShape, ImportMaps } from '../worker/lib/importApply';
import type { Lookups } from '../worker/lib/lookups';

const devices = templateShape('printer', ['fdm-printers', 'printers'], { includeCost: true });
const materials = templateShape('filament', ['printing-materials'], { includeCost: true });

// ------------------------------------------------------------------ CSV IO

test('parseCsv handles quotes, doubled quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n"x,1","he said ""hi""",z\r\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x,1', 'he said "hi"', 'z'],
  ]);
});

test('toCsv and parseCsv are inverses for awkward cells', () => {
  const rows = [
    ['h1', 'h2'],
    ['plain', 'with,comma'],
    ['with "quotes"', 'with\nnewline'],
    ['', 'trailing space '],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test('a UTF-8 BOM does not become part of the first column name', () => {
  const rows = parseCsv('﻿row_type,key\nproduct,A');
  assert.equal(rows[0][0], 'row_type');
});

// -------------------------------------------------------------- the shape

test('columns follow the product type: a printer sheet is not a filament sheet', () => {
  const d = new Set(devices.columns);
  const m = new Set(materials.columns);
  for (const base of BASE_COLUMNS) {
    assert.ok(d.has(base), `devices is missing base column ${base}`);
    assert.ok(m.has(base), `materials is missing base column ${base}`);
  }
  const dSpec = devices.columns.filter((c) => c.startsWith('spec.'));
  const mSpec = materials.columns.filter((c) => c.startsWith('spec.'));
  assert.ok(dSpec.length > 0 && mSpec.length > 0, 'both types must declare spec columns');
  assert.ok(
    dSpec.some((c) => !mSpec.includes(c)),
    'the two types must not have identical spec columns'
  );
  // The filters column is gone with the form's filters picker.
  assert.ok(!devices.columns.includes('facets'));
});

test('cost is withheld from the sheet an assistant admin downloads', () => {
  const withCost = templateShape('printer', ['printers'], { includeCost: true });
  const without = templateShape('printer', ['printers'], { includeCost: false });
  assert.ok(withCost.columns.includes('cost_iqd'));
  assert.ok(!without.columns.includes('cost_iqd'));
});

test('the label row has one label per column and never shifts them', () => {
  const labels = labelRow(devices);
  assert.equal(labels.length, devices.columns.length);
  assert.ok(labels.every((l) => l.trim() !== ''));
});

test('the blank template parses with zero errors', () => {
  const res = parseImport(blankTemplate(devices, true), devices);
  const errors = res.issues.filter((i) => i.severity === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors));
  assert.equal(res.products.length, 1);
  assert.equal(res.products[0].key, 'EXAMPLE-PRINTER');
  assert.equal(res.products[0].options.length, 2);
  assert.equal(res.products[0].colors.length, 1);
});

test('the label row is skipped by its marker, not by its position', () => {
  const text = blankTemplate(devices, true);
  const rows = parseCsv(text);
  // Delete the label row entirely; the example must still import.
  const withoutLabels = toCsv(rows.filter((r) => !r[0].startsWith('#')));
  const res = parseImport(withoutLabels, devices);
  assert.equal(res.products.length, 1);
  assert.deepEqual(res.issues.filter((i) => i.severity === 'error'), []);
});

test('the README names the spec columns its product type ships with', () => {
  const readme = readmeFor(materials);
  for (const f of materials.specFields) assert.ok(readme.includes(f.id), `README omits ${f.id}`);
});

// ---------------------------------------------------------- the lookups

const lookups: Lookups = {
  sections: [
    {
      id: 'cat_printers',
      slug: 'printers',
      name_en: 'Printers',
      name_ar: 'الطابعات',
      parent_id: null,
      parent_name_en: '',
      parent_slug: null,
      family: 'devices',
      is_printer_catalog: true,
    },
    {
      id: 'cat_printers_fdm',
      slug: 'fdm-printers',
      name_en: 'FDM Printers',
      name_ar: 'طابعات FDM',
      parent_id: 'cat_printers',
      parent_name_en: 'Printers',
      parent_slug: 'printers',
      family: 'devices',
      is_printer_catalog: false,
    },
  ],
  brands: [{ id: 'brand_bambu', slug: 'bambu-lab', name_en: 'Bambu Lab', name_ar: 'بامبو لاب' }],
  facets: [{ id: 'fac_new', slug: 'offers-new', name_en: 'New', name_ar: 'جديد', kind: 'offer' }],
  hashtags: [
    { tag: 'pla', name_ar: '' },
    { tag: 'Bambu-Lab', name_ar: 'بامبو' },
  ],
};

test('the blank template ends with a lookup block the parser skips by marker', () => {
  for (const example of [true, false]) {
    const csv = blankTemplate(devices, example, lookups);
    const rows = parseCsv(csv);
    const find = (type: string, key: string) => rows.find((r) => r[0] === type && r[1] === key);
    // Every value is advertised BY SLUG: display names are not unique, and
    // the importer refuses an ambiguous one rather than pick a row.
    assert.ok(find('#lookup:category', 'printers'), 'main section missing');
    assert.ok(find('#lookup:sub_category', 'fdm-printers'), 'sub-section missing');
    assert.equal(find('#lookup:sub_category', 'fdm-printers')?.[devices.columns.indexOf('category')], 'printers');
    assert.ok(find('#lookup:brand', 'bambu-lab'), 'brand missing');
    assert.ok(find('#lookup:hashtags', 'pla'), 'hashtag missing');
    assert.equal(find('#lookup:facets', 'offers-new'), undefined, 'filters are no longer a column');
    // The marker names the column the value goes in, verbatim.
    for (const row of rows.filter((r) => r[0].startsWith('#lookup:'))) {
      const column = row[0].slice('#lookup:'.length);
      assert.ok(devices.columns.includes(column), `no column named ${column}`);
    }
    for (const r of rows) assert.equal(r.length, devices.columns.length, 'a lookup row shifted the columns');
    const parsed = parseImport(csv, devices);
    assert.deepEqual(parsed.issues.filter((i) => i.severity === 'error'), []);
    assert.equal(parsed.products.length, example ? 1 : 0, 'a lookup row was read as a product');
  }
});

test('the README and lookups.csv list every accepted classification value', () => {
  const readme = readmeFor(devices, lookups);
  for (const v of ['printers', 'fdm-printers', 'bambu-lab', 'Bambu Lab', 'pla', 'Bambu-Lab', 'lookups.csv']) {
    assert.ok(readme.includes(v), `README omits ${v}`);
  }
  const sheet = parseCsv(lookupsSheet(lookups));
  assert.deepEqual(sheet[0], ['column', 'value', 'name_en', 'name_ar', 'slug', 'parent', 'extra']);
  assert.ok(sheet.some((r) => r[0] === 'category' && r[1] === 'printers' && r[6] === 'family=devices'));
  assert.ok(sheet.some((r) => r[0] === 'sub_category' && r[1] === 'fdm-printers' && r[5] === 'printers'));
  assert.ok(sheet.some((r) => r[0] === 'brand' && r[1] === 'bambu-lab' && r[2] === 'Bambu Lab'));
  assert.ok(sheet.some((r) => r[0] === 'hashtags' && r[1] === 'Bambu-Lab'));
});

test('an empty vocabulary still produces a valid template and an honest README', () => {
  const empty: Lookups = { sections: [], brands: [], facets: [], hashtags: [] };
  const parsed = parseImport(blankTemplate(devices, true, empty), devices);
  assert.deepEqual(parsed.issues.filter((i) => i.severity === 'error'), []);
  assert.ok(readmeFor(devices, empty).includes('لا شيء بعد'));
});

// ---------------------------------------------------------- the round-trip

const sample: ExportProduct = {
  key: 'LEVO-A1-01',
  name: 'Bambu Lab A1 Combo',
  description: 'Nozzle diameter: 0.4 mm. Build volume: 256 mm.',
  status: 'active',
  sku: 'LEVO-A1-01',
  display_order: 3,
  is_featured: true,
  brand: 'Bambu Lab',
  category: 'Printers',
  sub_category: 'FDM Printers',
  sale_types: ['direct_sale', 'pre_order'],
  inventory_mode: 'COLOR',
  price_iqd: 950000,
  prime_price_iqd: 910000,
  pro_price_iqd: 880000,
  cost_iqd: 700000,
  direct_surcharge_iqd: 5000,
  stock: 12,
  low_stock_threshold: 3,
  payment_options: ['cod', 'wallet'],
  how_to_use: 'Level the bed, then print the test model.',
  usage_url: 'https://wiki.bambulab.com/en/a1',
  hashtags: ['pla', 'Bambu-Lab'],
  spec_fields: { nozzle: '0.4 mm', build_volume: '256x256x256', technology: 'FDM' },
  options: [
    {
      group: 'Printer',
      value: 'A1',
      sku_part: 'A1',
      image: '',
      active: true,
      stock: null,
      low_stock_threshold: null,
      price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
      // 0043: this fixture predates per-option availability; blank means
      // 'inherit the product', which is what every old option does.
      availability_type: '',
      lead_time_text: '',
      lead_time_min_days: null,
      lead_time_max_days: null,
      variant_key: '',
      variant_label: '',
    },
    {
      group: 'Printer',
      value: 'A1 mini',
      sku_part: 'A1M',
      image: '',
      active: true,
      stock: null,
      low_stock_threshold: null,
      price_iqd: 720000,
      prime_price_iqd: 700000,
      pro_price_iqd: 690000,
      cost_iqd: 500000,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
      // 0043: this fixture predates per-option availability; blank means
      // 'inherit the product', which is what every old option does.
      availability_type: '',
      lead_time_text: '',
      lead_time_min_days: null,
      lead_time_max_days: null,
      variant_key: '',
      variant_label: '',
    },
    {
      group: 'Plug',
      value: 'EU',
      sku_part: 'EU',
      image: '',
      active: true,
      stock: null,
      low_stock_threshold: null,
      price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
      // 0043: this fixture predates per-option availability; blank means
      // 'inherit the product', which is what every old option does.
      availability_type: '',
      lead_time_text: '',
      lead_time_min_days: null,
      lead_time_max_days: null,
      variant_key: '',
      variant_label: '',
    },
  ],
  colors: [
    {
      name: 'Black',
      hex: '#101010',
      sku_part: 'BLK',
      image: '/files/products/import/black.jpg',
      active: true,
      stock: 7,
      low_stock_threshold: 2,
      price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
      links: [
        { group: 'Printer', value: 'A1' },
        { group: 'Plug', value: 'EU' },
      ],
    },
    {
      name: 'White, Matte',
      hex: '#fafafa',
      sku_part: 'WHT',
      image: '',
      active: false,
      stock: 0,
      low_stock_threshold: null,
      price_iqd: 960000,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
      links: [],
    },
  ],
  variants: [
    {
      selection: [
        { group: 'Printer', value: 'A1' },
        { group: 'Plug', value: 'EU' },
      ],
      color: 'Black',
      sku_part: 'A1-EU-BLK',
      active: true,
      stock: 4,
      low_stock_threshold: 1,
      price_iqd: 970000,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
    },
  ],
  images: [
    { image: '/files/products/import/a.jpg', alt: 'front', primary: true, bind: '' },
    { image: '/files/products/import/b.jpg', alt: 'back "angle"', primary: false, bind: 'color:Black' },
    { image: '/files/products/import/c.jpg', alt: '', primary: false, bind: 'option:Printer:A1' },
  ],
  transports: [
    { method: 'air', commission_iqd: null, active: true },
    { method: 'sea', commission_iqd: 15000, active: false },
  ],
  specs: [
    { group: 'Motion', label: 'System', value: 'CoreXY', unit: '' },
    { group: 'Motion', label: 'Max speed', value: '500', unit: 'mm/s' },
    { group: 'Power', label: 'Input', value: '220', unit: 'V' },
  ],
  labels: [
    { key: 'warranty_included', text: 'Warranty included', icon: 'shield', visible: true },
    { key: '', text: 'Ships today', icon: '', visible: false },
  ],
  warranty_plans: [
    {
      title: 'One year',
      terms: 'Manufacturing defects only.\nConsumables are not covered.',
      duration_months: 12,
      duration_kind: 'total',
      fee_iqd: 0,
      active: true,
    },
    {
      title: 'Extended',
      terms: 'Adds a second year.',
      duration_months: 12,
      duration_kind: 'extension',
      fee_iqd: 45000,
      active: true,
    },
  ],
  content_blocks: [
    { kind: 'text', body: 'A paragraph, with a comma and a "quote".', caption: '', alt: '', url: '', image: '' },
    {
      kind: 'video_embed',
      body: '',
      caption: 'Setup walkthrough',
      alt: '',
      url: 'https://www.youtube.com/watch?v=abc',
      image: '',
    },
  ],
  guide_steps: [
    {
      kind: 'setup',
      title: 'Unbox',
      body: 'Remove the foam.',
      images: ['/files/products/import/a.jpg'],
      video_url: '',
      link_url: 'https://wiki.bambulab.com/en/a1/manual/unboxing',
    },
    { kind: 'usage', title: 'First print', body: 'Run the calibration.', images: [], video_url: '', link_url: '' },
  ],
};

test('export then import reproduces every field, order and relation', () => {
  const csv = serializeProducts([sample], devices);
  const res = parseImport(csv, devices);
  assert.deepEqual(res.issues.filter((i) => i.severity === 'error'), []);
  assert.equal(res.products.length, 1);
  const p = res.products[0];

  assert.equal(p.key, sample.key);
  assert.equal(p.name, sample.name);
  assert.equal(p.description, sample.description);
  assert.equal(p.status, sample.status);
  assert.equal(p.sku, sample.sku);
  assert.equal(p.display_order, sample.display_order);
  assert.equal(p.is_featured, sample.is_featured);
  assert.equal(p.brand, sample.brand);
  assert.equal(p.category, sample.category);
  assert.equal(p.sub_category, sample.sub_category);
  assert.deepEqual(p.sale_types, sample.sale_types);
  assert.equal(p.inventory_mode, sample.inventory_mode);
  assert.equal(p.price_iqd, sample.price_iqd);
  assert.equal(p.prime_price_iqd, sample.prime_price_iqd);
  assert.equal(p.pro_price_iqd, sample.pro_price_iqd);
  assert.equal(p.cost_iqd, sample.cost_iqd);
  assert.equal(p.direct_surcharge_iqd, sample.direct_surcharge_iqd);
  assert.equal(p.stock, sample.stock);
  assert.equal(p.low_stock_threshold, sample.low_stock_threshold);
  assert.deepEqual(p.payment_options, sample.payment_options);
  assert.equal(p.how_to_use, sample.how_to_use);
  assert.equal(p.usage_url, sample.usage_url);
  assert.deepEqual(p.spec_fields, sample.spec_fields);

  // ORDER matters: options, colours and images come back in file order.
  assert.deepEqual(
    p.options.map((o) => [o.group, o.value, o.sku_part, o.active, o.price_iqd, o.cost_iqd]),
    sample.options.map((o) => [o.group, o.value, o.sku_part, o.active, o.price_iqd, o.cost_iqd])
  );
  assert.deepEqual(
    p.colors.map((col) => [col.name, col.hex, col.stock, col.active, col.links]),
    sample.colors.map((col) => [col.name, col.hex.toLowerCase(), col.stock, col.active, col.links])
  );
  assert.deepEqual(
    p.images.map((im) => [im.image, im.alt, im.primary, im.bind]),
    sample.images.map((im) => [im.image, im.alt, im.primary, im.bind])
  );

  // …and so do every one of the collections the eight form sections own.
  assert.deepEqual(
    p.variants?.map((v) => [v.selection, v.color, v.sku_part, v.stock, v.price_iqd]),
    sample.variants.map((v) => [v.selection, v.color, v.sku_part, v.stock, v.price_iqd])
  );
  assert.deepEqual(
    p.transports?.map((t) => [t.method, t.commission_iqd, t.active]),
    sample.transports.map((t) => [t.method, t.commission_iqd, t.active])
  );
  assert.deepEqual(p.specs?.map((x) => ({ ...x, line: undefined })), sample.specs.map((x) => ({ ...x, line: undefined })));
  assert.deepEqual(
    p.labels?.map((l) => [l.key, l.text, l.icon, l.visible]),
    sample.labels.map((l) => [l.key, l.text, l.icon, l.visible])
  );
  assert.deepEqual(
    p.warranty_plans?.map((w) => [w.title, w.terms, w.duration_months, w.duration_kind, w.fee_iqd, w.active]),
    sample.warranty_plans.map((w) => [w.title, w.terms, w.duration_months, w.duration_kind, w.fee_iqd, w.active])
  );
  assert.deepEqual(
    p.content_blocks?.map((b) => [b.kind, b.body, b.caption, b.url]),
    sample.content_blocks.map((b) => [b.kind, b.body, b.caption, b.url])
  );
  assert.deepEqual(
    p.guide_steps?.map((g) => [g.kind, g.title, g.body, g.images, g.link_url]),
    sample.guide_steps.map((g) => [g.kind, g.title, g.body, g.images, g.link_url])
  );
});

test('a second round-trip is byte-identical to the first', () => {
  const once = serializeProducts([sample], devices);
  const parsed = parseImport(once, devices).products[0];
  const twice = serializeProducts(
    [
      {
        ...sample,
        colors: sample.colors.map((col) => ({ ...col, hex: col.hex.toLowerCase() })),
        options: parsed.options.map(({ line: _line, ...rest }) => rest),
        variants: parsed.variants.map(({ line: _line, ...rest }) => rest),
        images: parsed.images.map(({ line: _line, ...rest }) => rest),
        transports: (parsed.transports ?? []).map(({ line: _line, ...rest }) => rest),
        specs: (parsed.specs ?? []).map(({ line: _line, ...rest }) => rest),
        labels: (parsed.labels ?? []).map(({ line: _line, ...rest }) => ({
          key: rest.key,
          text: rest.text,
          icon: rest.icon,
          visible: rest.visible,
        })),
        warranty_plans: (parsed.warranty_plans ?? []).map(({ line: _line, ...rest }) => rest),
        content_blocks: (parsed.content_blocks ?? []).map(({ line: _line, ...rest }) => rest),
        guide_steps: (parsed.guide_steps ?? []).map(({ line: _line, ...rest }) => rest),
      },
    ],
    devices
  );
  assert.equal(twice, once);
});

// ------------------------------------------------------------- validation

const parseOne = (rows: string[][]) => parseImport(toCsv([devices.columns, ...rows]), devices);

/** Builds one row from a partial map of column -> value. */
const row = (v: Record<string, string>) => devices.columns.map((c) => v[c] ?? '');

test('a price ladder violation names the product and the rule', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000', prime_price_iqd: '900', pro_price_iqd: '950' }),
  ]);
  assert.ok(res.issues.some((i) => i.severity === 'error' && i.message.includes('PRO')));
});

test('a sale price equal to cost is refused', () => {
  const res = parseOne([row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000', cost_iqd: '1000' })]);
  assert.ok(res.issues.some((i) => i.message.includes('التكلفة')));
});

test('a colour hex that is not #RGB or #RRGGBB is refused on its own line', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000' }),
    row({ row_type: 'color', key: 'K1', value: 'Black', hex: 'black' }),
  ]);
  const issue = res.issues.find((i) => i.message.startsWith('hex:'));
  assert.ok(issue);
  assert.equal(issue.line, 3, 'the error must point at the colour row, not the product row');
});

test('a colour link naming a missing option is refused', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000' }),
    row({ row_type: 'option', key: 'K1', group: 'Printer', value: 'A1' }),
    row({ row_type: 'color', key: 'K1', value: 'Black', hex: '#000000', links: 'Printer:A1|Plug:EU' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('Plug:EU')));
  assert.ok(!res.issues.some((i) => i.message.includes('Printer:A1')));
});

test('two primary images is an error; none is a warning that names the fallback', () => {
  const two = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000' }),
    row({ row_type: 'image', key: 'K1', image: 'a.jpg', primary: 'yes' }),
    row({ row_type: 'image', key: 'K1', image: 'b.jpg', primary: 'yes' }),
  ]);
  assert.ok(two.issues.some((i) => i.severity === 'error' && i.message.includes('رئيسية')));

  const none = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000' }),
    row({ row_type: 'image', key: 'K1', image: 'a.jpg' }),
  ]);
  const warn = none.issues.find((i) => i.severity === 'warning');
  assert.ok(warn && warn.message.includes('الأولى'));
});

test('a child row with no product row is reported, not swallowed', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000' }),
    row({ row_type: 'color', key: 'GHOST', value: 'Black', hex: '#000000' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('GHOST')));
});

test('a duplicate product key is refused', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000' }),
    row({ row_type: 'product', key: 'K1', name: 'Y', price_iqd: '2000' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('مكرر')));
  assert.equal(res.products.length, 1);
});

test('inventory_mode=COLOR with no colour rows cannot be saved', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000', inventory_mode: 'COLOR' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('COLOR')));
});

test('an unknown sale type is named rather than silently dropped', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000', sale_types: 'direct_sale|rental' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('rental')));
});

test('columns the template does not define are reported, not guessed at', () => {
  const res = parseImport(
    toCsv([[...devices.columns, 'invented_column'], [...row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1' }), 'v']]),
    devices
  );
  assert.deepEqual(res.unknownColumns, ['invented_column']);
});

// ------------------------------------------------------------- resolving

const catalogPrinters: CatalogRef = {
  id: 'cat_printers',
  parent_id: null,
  slug: 'printers',
  name_en: 'Printers',
  name_ar: 'الطابعات',
  template_family: 'devices',
};
const catalogFdm: CatalogRef = {
  id: 'cat_printers_fdm',
  parent_id: 'cat_printers',
  slug: 'fdm-printers',
  name_en: 'FDM Printers',
  name_ar: 'طابعات FDM',
  template_family: null,
};

const maps: ImportMaps = {
  brands: new Map([[normKey('Bambu Lab'), 'brand_bambu']]),
  catalogs: new Map([
    [normKey('Printers'), catalogPrinters],
    [normKey('printers'), catalogPrinters],
    [normKey('FDM Printers'), catalogFdm],
  ]),
  facets: new Map([
    [normKey('offers-new'), 'fac_new'],
    [normKey('fdm-pla'), 'fac_pla'],
  ]),
  familyOf: new Map([
    ['cat_printers', 'devices' as const],
    ['cat_printers_fdm', 'devices' as const],
  ]),
  images: new Map([
    ['/files/products/import/a.jpg', '/files/products/import/a.jpg'],
    ['/files/products/import/b.jpg', '/files/products/import/b.jpg'],
    ['/files/products/import/c.jpg', '/files/products/import/c.jpg'],
    ['/files/products/import/black.jpg', '/files/products/import/black.jpg'],
  ]),
};

let seq = 0;
const idFactory = () => {
  seq = 0;
  return (prefix: string) => `${prefix}_${++seq}`;
};

const parsedSample = () => parseImport(serializeProducts([sample], devices), devices).products[0];

test('resolveProduct turns names into ids and keeps the link algebra', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  assert.deepEqual(r.issues, []);
  assert.equal(r.action, 'create');
  assert.equal(r.doc.brand_id, 'brand_bambu');
  assert.equal(r.doc.category_id, 'cat_printers');
  assert.equal(r.doc.sub_category_id, 'cat_printers_fdm');
  assert.equal(r.doc.template_family, 'devices');
  // No facet_ids at all: an absent key preserves what the product already has.
  assert.equal('facet_ids' in r.relations, false);

  const groups = r.relations.groups as Array<{ name_en: string; values: Array<{ id: string; name_en: string }> }>;
  assert.deepEqual(groups.map((g) => g.name_en), ['Printer', 'Plug']);
  assert.deepEqual(groups[0].values.map((v) => v.name_en), ['A1', 'A1 mini']);

  const colors = r.relations.colors as Array<{ name_en: string; option_value_ids: string[] }>;
  // Black is linked to one value in EACH of the two groups (AND across groups).
  assert.equal(colors[0].option_value_ids.length, 2);
  assert.equal(colors[1].option_value_ids.length, 0);
});

test('an image binding resolves to the colour and option it names', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const images = r.relations.images as Array<{
    color_id: string | null;
    option_value_id: string | null;
    is_primary: boolean;
    sort_order: number;
  }>;
  assert.equal(images[0].is_primary, true);
  assert.equal(images[0].color_id, null);
  assert.ok(images[1].color_id, 'the second image binds to a colour');
  assert.ok(images[2].option_value_id, 'the third image binds to an option value');
  assert.deepEqual(images.map((im) => im.sort_order), [0, 1, 2]);
});

test('re-importing an existing product REUSES its row ids so stock survives', () => {
  const first = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const groups = first.relations.groups as Array<{ id: string; name_en: string; values: Array<{ id: string; name_en: string }> }>;
  const colors = first.relations.colors as Array<{ id: string; name_en: string }>;
  const images = first.relations.images as Array<{ id: string; url: string }>;

  const firstVariants = first.relations.variants as Array<{
    id: string;
    option_value_ids: string[];
    color_id: string | null;
  }>;
  const existing = {
    id: 'prd_live',
    slug: 'bambu-lab-a1-combo',
    inventory_mode: 'COLOR',
    doc: { id: 'prd_live', brand_id: 'brand_bambu' } as Record<string, unknown>,
    groups: groups.map((g) => ({ id: g.id, name_en: g.name_en })),
    values: groups.flatMap((g) => g.values.map((v) => ({ id: v.id, group_id: g.id, name_en: v.name_en }))),
    colors: colors.map((col) => ({ id: col.id, name_en: col.name_en })),
    images: images.map((im) => ({ id: im.id, url: im.url })),
    variants: firstVariants.map((v) => ({
      id: v.id,
      combo_key: [...v.option_value_ids.map((x) => `o:${x}`), ...(v.color_id ? [`c:${v.color_id}`] : [])].join('|'),
      sku: 'A1-EU-BLK',
      active: 1,
      stock: 4,
      low_stock_threshold: 1,
      regular_price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
    })),
  };

  const second = resolveProduct(parsedSample(), existing, maps, { newId: () => 'FRESH', money: true });
  assert.equal(second.action, 'update');
  assert.equal(second.productId, 'prd_live');
  const g2 = second.relations.groups as Array<{ id: string; values: Array<{ id: string }> }>;
  assert.deepEqual(g2.map((g) => g.id), groups.map((g) => g.id));
  assert.deepEqual(
    g2.flatMap((g) => g.values.map((v) => v.id)),
    groups.flatMap((g) => g.values.map((v) => v.id))
  );
  assert.deepEqual((second.relations.colors as Array<{ id: string }>).map((col) => col.id), colors.map((col) => col.id));
  assert.deepEqual((second.relations.images as Array<{ id: string }>).map((im) => im.id), images.map((im) => im.id));
  assert.ok(!JSON.stringify(second.relations).includes('FRESH'), 'no id was regenerated');
});

test('hashtags ride in their own column and a sheet without it keeps stored tags', () => {
  const parsed = parsedSample();
  assert.deepEqual(parsed.hashtags, ['pla', 'Bambu-Lab']);
  const fresh = resolveProduct(parsed, null, maps, { newId: idFactory(), money: true });
  assert.deepEqual(fresh.doc.hashtags, ['pla', 'Bambu-Lab']);

  const stored: ExistingShape = {
    id: 'prd_live',
    slug: 'bambu-lab-a1-combo',
    inventory_mode: 'BASE',
    doc: { id: 'prd_live', hashtags: ['kept-tag'] },
    groups: [],
    values: [],
    colors: [],
    images: [],
    variants: [],
  };
  // The column is present and empty: the tags are cleared on purpose.
  const cleared = resolveProduct({ ...parsed, hashtags: [] }, stored, maps, { newId: idFactory(), money: true });
  assert.deepEqual(cleared.doc.hashtags, []);
  // The column is absent (an older export): the stored tags survive.
  const noColumn = { ...devices, columns: devices.columns.filter((c) => c !== 'hashtags') };
  const older = parseImport(serializeProducts([sample], noColumn), noColumn).products[0];
  assert.equal(older.hashtags, null);
  const kept = resolveProduct(older, stored, maps, { newId: idFactory(), money: true });
  assert.deepEqual(kept.doc.hashtags, ['kept-tag']);
  // A tag typed with a hash and spaces is normalized like the form does it.
  const typed = resolveProduct({ ...parsed, hashtags: ['#My Tag', 'pla'] }, null, maps, { newId: idFactory(), money: true });
  assert.deepEqual(typed.doc.hashtags, ['My-Tag', 'pla']);
});

test('spec values the sheet has no column for survive a re-import', () => {
  const existing = {
    id: 'prd_live',
    slug: 's',
    inventory_mode: 'BASE',
    // `finish` belongs to the Materials family; a Devices sheet has no column
    // for it, and importing that sheet must not erase it.
    doc: { spec_fields: { finish: 'Matte', technology: 'SLA' } } as Record<string, unknown>,
    groups: [],
    values: [],
    colors: [],
    images: [],
    variants: [],
  };
  const r = resolveProduct(parsedSample(), existing, maps, {
    newId: idFactory(),
    money: true,
    specFieldIds: devices.specFields.map((f) => f.id),
  });
  const specs = r.doc.spec_fields as Record<string, string>;
  assert.equal(specs.finish, 'Matte', 'an undeclared field is preserved');
  assert.equal(specs.technology, 'FDM', 'a declared field follows the sheet');
});

test('an unknown brand or section blocks the row instead of inventing one', () => {
  const p = parsedSample();
  p.brand = 'Nonexistent Brand';
  const r = resolveProduct(p, null, maps, { newId: idFactory(), money: true });
  assert.ok(r.issues.some((i) => i.message.includes('Nonexistent Brand')));
});

test('a display name two rows share is refused, naming the slug as the way out', () => {
  const ambiguousMaps: ImportMaps = {
    ...maps,
    // Two sections really are called "Printers" (the seed ships several), so
    // the name is in the map — pointing at ONE of them — and also flagged.
    ambiguous: { brands: new Set([normKey('Bambu Lab')]), catalogs: new Set([normKey('Printers')]), facets: new Set<string>() },
  };
  const p = parsedSample();
  const r = resolveProduct(p, null, ambiguousMaps, { newId: idFactory(), money: true });
  const messages = r.issues.map((i) => i.message).join(' | ');
  assert.match(messages, /category: أكثر من صف/);
  assert.match(messages, /brand: أكثر من صف/);
  assert.match(messages, /slug/);

  // And with the slug in the cell instead of the name, the row is clean.
  const bySlug = { ...p, category: 'printers', sub_category: 'fdm-printers', brand: 'Bambu Lab' };
  const slugMaps: ImportMaps = {
    ...maps,
    brands: new Map([[normKey('Bambu Lab'), 'brand_bambu']]),
    catalogs: new Map([
      [normKey('printers'), catalogPrinters],
      [normKey('fdm-printers'), catalogFdm],
    ]),
    ambiguous: { brands: new Set<string>(), catalogs: new Set<string>(), facets: new Set<string>() },
  };
  const clean = resolveProduct(bySlug, null, slugMaps, { newId: idFactory(), money: true });
  assert.deepEqual(clean.issues.filter((i) => i.severity === 'error'), []);
  assert.equal(clean.doc.category_id, 'cat_printers');
  assert.equal(clean.doc.sub_category_id, 'cat_printers_fdm');
});

test('a sub-section that is not a child of the main section is refused', () => {
  const p = parsedSample();
  p.category = 'FDM Printers';
  p.sub_category = 'Printers';
  const r = resolveProduct(p, null, maps, { newId: idFactory(), money: true });
  assert.ok(r.issues.some((i) => i.message.includes('ليس قسمًا فرعيًا')));
});

test('an assistant admin cannot write cost through an import either', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: false });
  assert.equal(r.doc.product_cost_iqd, null);
  const groups = r.relations.groups as Array<{ values: Array<{ cost_iqd: number | null }> }>;
  assert.ok(groups.every((g) => g.values.every((v) => v.cost_iqd === null)));
  assert.ok((r.relations.colors as Array<{ cost_iqd: number | null }>).every((col) => col.cost_iqd === null));
});

test('the product NAME is copied into every language, never translated', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  assert.equal(r.doc.name_en, sample.name);
  assert.equal(r.doc.name_ar, sample.name);
  assert.equal(r.doc.name_ckb, sample.name);
});

test('VARIANT_COMBINATION with no variant row is refused, naming the fix', () => {
  const p = { ...parsedSample(), inventory_mode: 'VARIANT_COMBINATION', variants: [] };
  const r = resolveProduct(p, null, maps, { newId: idFactory(), money: true });
  assert.ok(r.issues.some((i) => i.message.includes('VARIANT_COMBINATION')));
});

test('a variant row builds a real combination out of the names it selects', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const groups = r.relations.groups as Array<{ name_en: string; values: Array<{ id: string; name_en: string }> }>;
  const colors = r.relations.colors as Array<{ id: string; name_en: string }>;
  const variants = r.relations.variants as Array<{
    option_value_ids: string[];
    color_id: string | null;
    sku: string;
    stock: number | null;
    regular_price_iqd: number | null;
  }>;
  assert.equal(variants.length, 1);
  const a1 = groups[0].values.find((v) => v.name_en === 'A1')!.id;
  const eu = groups[1].values.find((v) => v.name_en === 'EU')!.id;
  assert.deepEqual([...variants[0].option_value_ids].sort(), [a1, eu].sort());
  assert.equal(variants[0].color_id, colors.find((c) => c.name_en === 'Black')!.id);
  assert.equal(variants[0].sku, 'A1-EU-BLK');
  assert.equal(variants[0].stock, 4);
  assert.equal(variants[0].regular_price_iqd, 970000);
});

/** The stored shape of a product whose relations match the sample exactly. */
const existingLike = (first: ReturnType<typeof resolveProduct>, comboStock: number) => {
  const groups = first.relations.groups as Array<{ id: string; name_en: string; values: Array<{ id: string; name_en: string }> }>;
  const colors = first.relations.colors as Array<{ id: string; name_en: string }>;
  const variants = first.relations.variants as Array<{ id: string; option_value_ids: string[]; color_id: string | null }>;
  return {
    id: 'prd_live',
    slug: 's',
    inventory_mode: 'VARIANT_COMBINATION',
    doc: {} as Record<string, unknown>,
    groups: groups.map((g) => ({ id: g.id, name_en: g.name_en })),
    values: groups.flatMap((g) => g.values.map((v) => ({ id: v.id, group_id: g.id, name_en: v.name_en }))),
    colors: colors.map((col) => ({ id: col.id, name_en: col.name_en })),
    images: [],
    variants: variants.map((v) => ({
      id: 'pv_stored',
      // The stored key lists the colour FIRST and the values in another order,
      // because inventory.ts builds it that way; matching must not depend on it.
      combo_key: [`c:${v.color_id}`, ...[...v.option_value_ids].reverse().map((x) => `o:${x}`)].join('|'),
      sku: 'A1-EU-BLK',
      active: 1,
      stock: comboStock,
      low_stock_threshold: 1,
      regular_price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
    })),
  };
};

test('a variant row lands on the stored combination it names, keeping its id', () => {
  const first = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const existing = existingLike(first, 4);
  const p = { ...parsedSample(), inventory_mode: 'VARIANT_COMBINATION' };
  const r = resolveProduct(p, existing, maps, { newId: () => 'FRESH', money: true });
  assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), []);
  const variants = r.relations.variants as Array<{ id: string; stock: number | null; sku: string }>;
  assert.equal(variants.length, 1);
  assert.equal(variants[0].id, 'pv_stored', 'the stored combination was matched, not replaced');
  // The SHEET owns stock once it carries the row — that is the whole point of
  // being able to edit a combination in Excel.
  assert.equal(variants[0].stock, 4, 'the sheet said 4');
  assert.equal(variants[0].sku, 'A1-EU-BLK');
});

test('a file with no variant rows carries the stored combinations through', () => {
  const first = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const existing = existingLike(first, 9);
  const p = { ...parsedSample(), variants: [] };
  const r = resolveProduct(p, existing, maps, { newId: () => 'FRESH', money: true });
  const variants = r.relations.variants as Array<{ id: string; stock: number | null }>;
  assert.equal(variants.length, 1);
  assert.equal(variants[0].id, 'pv_stored');
  assert.equal(variants[0].stock, 9, 'a silent sheet does not touch combination stock');
});

test('splitComboKey inverts the key inventory.ts builds', () => {
  assert.deepEqual(splitComboKey('o:v1|o:v2|c:c1'), { option_value_ids: ['v1', 'v2'], color_id: 'c1' });
  assert.deepEqual(splitComboKey('c:c1'), { option_value_ids: [], color_id: 'c1' });
  assert.deepEqual(splitComboKey(''), { option_value_ids: [], color_id: null });
});

// -------------------------------------------------- the four product types
//
// The owner's «ويكون حسب نوع المنتج اذا طابعه او ملحقات او فلمنت او اكسسوار».
// These tests hold the split itself: four types, each with its own columns,
// each reachable from the sections that mean it.

test('there are exactly the four product types the owner named', () => {
  assert.deepEqual(PRODUCT_TYPES.map((t) => t.id), ['printer', 'parts', 'filament', 'accessory']);
  assert.deepEqual(
    templateTypeChoices().map((t) => t.id),
    ['printer', 'parts', 'filament', 'accessory']
  );
  assert.ok(templateTypeChoices().every((t) => t.label_ar && t.hint_ar && t.spec_columns > 0));
});

test('each type gets its own columns, and no type declares a field twice', () => {
  const seen = new Map<string, string[]>();
  for (const type of PRODUCT_TYPES) {
    const shape = templateShape(type.id, [], { includeCost: true });
    const ids = shape.specFields.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, `${type.id} declares a field twice`);
    assert.equal(new Set(shape.columns).size, shape.columns.length, `${type.id} has a duplicate column`);
    seen.set(type.id, ids);
  }
  // A printer is asked about its build volume; a filament spool is not, and
  // neither is asked the other's question. That IS the precision requested.
  assert.ok(seen.get('printer')!.includes('build_volume'));
  assert.ok(!seen.get('filament')!.includes('build_volume'));
  assert.ok(seen.get('filament')!.includes('diameter'));
  assert.ok(!seen.get('printer')!.includes('diameter'));
  // And an accessory or a part is asked neither.
  for (const light of ['parts', 'accessory'] as const) {
    assert.ok(!seen.get(light)!.includes('build_volume'), `${light} should not ask for a build volume`);
    assert.ok(!seen.get(light)!.includes('nozzle_temp_max'), `${light} should not ask for a nozzle temperature`);
    assert.ok(seen.get(light)!.includes('dimensions'), `${light} should still ask for dimensions`);
  }
});

test('a section resolves to its type leaf-first, and an unmapped one falls back honestly', () => {
  assert.equal(productTypeForSection('devices', ['fdm-printers', 'printers']), 'printer');
  // The leaf wins: an accessory under «الطابعات» is a part, not a printer.
  assert.equal(productTypeForSection('devices', ['resin-printer-accessories', 'printers']), 'parts');
  assert.equal(productTypeForSection('materials', ['fdm-materials', 'materials']), 'filament');
  assert.equal(productTypeForSection('materials', ['accessories']), 'accessory');
  assert.equal(productTypeForSection('devices', ['a-section-nobody-mapped']), 'printer');
  assert.equal(productTypeForSection('materials', ['a-section-nobody-mapped']), 'filament');
});

test("the form's spec groups and the template's spec columns are the same list", () => {
  // worker/routes/adminTaxonomy.ts serves fieldsFor() to the form and
  // templateShape() builds the columns; both go through groupsForType, so a
  // field can never be in the form but missing from the sheet.
  for (const type of PRODUCT_TYPES) {
    const formFields = groupsForType(type.id).flatMap((g) => g.fields.map((f) => f.id));
    const columns = templateShape(type.id, [], { includeCost: true }).columns
      .filter((c) => c.startsWith(SPEC_PREFIX))
      .map((c) => c.slice(SPEC_PREFIX.length));
    assert.deepEqual(columns, formFields, `${type.id} drifted`);
  }
});

test('every type ships a worked example of its own that imports cleanly', () => {
  for (const type of PRODUCT_TYPES) {
    const shape = templateShape(type.id, [], { includeCost: true });
    const res = parseImport(blankTemplate(shape, true), shape);
    const errors = res.issues.filter((i) => i.severity === 'error');
    assert.deepEqual(errors, [], `${type.id}: ${JSON.stringify(errors)}`);
    assert.equal(res.products.length, 1, `${type.id} example is not one product`);
    const p = res.products[0];
    assert.equal(p.key, `EXAMPLE-${type.id.toUpperCase()}`);
    // Every row type is demonstrated, or nobody learns it exists.
    assert.ok((p.transports ?? []).length > 0, `${type.id} example has no transport row`);
    assert.ok((p.specs ?? []).length > 0, `${type.id} example has no spec row`);
    assert.ok((p.labels ?? []).length > 0, `${type.id} example has no label row`);
    assert.ok((p.warranty_plans ?? []).length > 0, `${type.id} example has no warranty row`);
    assert.ok((p.content_blocks ?? []).length > 0, `${type.id} example has no content row`);
    assert.ok((p.guide_steps ?? []).length > 0, `${type.id} example has no guide row`);
    assert.ok(p.images.length > 0, `${type.id} example has no image row`);
    // The README names the type and every row type it accepts.
    const readme = readmeFor(shape);
    for (const rowType of ['product', 'option', 'color', 'variant', 'image', 'transport', 'spec', 'label', 'warranty', 'content', 'guide']) {
      assert.ok(readme.includes(rowType), `${type.id} README omits the ${rowType} row`);
    }
  }
});

// ------------------------------------------- every form field has a home
//
// The owner's «ويشمل كل شي كل الحقول في اضافه المنتج». blankDoc() is the
// admin form's own state shape, so this list cannot go stale behind the form:
// add a field there and this test fails until the sheet can carry it.

test('every field of the product form is expressible in the sheet', () => {
  const columns = new Set(devices.columns);
  /** field of blankDoc() -> the column or row type that carries it. */
  const carriedBy: Record<string, string> = {
    // product-row columns
    name_en: 'name', name_ar: 'name', name_ckb: 'name',
    description_en: 'description', description_ar: 'description', description_ckb: 'description',
    status: 'status', sku: 'sku', display_order: 'display_order', is_featured: 'is_featured',
    brand_id: 'brand', category_id: 'category', sub_category_id: 'sub_category', hashtags: 'hashtags',
    sale_types: 'sale_types', selling_type: 'sale_types',
    price_iqd: 'price_iqd', prime_price_iqd: 'prime_price_iqd', pro_price_iqd: 'pro_price_iqd',
    product_cost_iqd: 'cost_iqd', direct_surcharge_iqd: 'direct_surcharge_iqd',
    stock: 'stock', low_stock_threshold: 'low_stock_threshold', payment_options: 'payment_options',
    how_to_use: 'how_to_use', spec_fields: 'spec.*',
    // child row types
    options: 'row:option', colors: 'row:color', media: 'row:image',
    preorder_transports: 'row:transport', spec_groups: 'row:spec', labels: 'row:label',
    warranty_plans: 'row:warranty', content_blocks: 'row:content', usage_guide: 'row:guide',
    // derived or managed elsewhere, never typed into a sheet
    id: 'derived', slug: 'derived', doc_version: 'derived', content_rev: 'derived',
    template_family: 'derived', translation_meta: 'derived', catalog_ids: 'derived',
  };
  const rowTypes = new Set(['option', 'color', 'image', 'transport', 'spec', 'label', 'warranty', 'content', 'guide']);
  for (const field of Object.keys(blankDoc())) {
    const home = carriedBy[field];
    assert.ok(home, `the sheet has no home for the form field "${field}"`);
    if (home === 'derived' || home === 'spec.*') continue;
    if (home.startsWith('row:')) {
      assert.ok(rowTypes.has(home.slice(4)), `${field} claims a row type that does not exist`);
      continue;
    }
    assert.ok(columns.has(home), `${field} claims column "${home}", which the template does not have`);
  }
});

// ------------------------------------------------------- precise refusals

test('a spec value outside a select field\u2019s options is refused, naming them', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000', [`${SPEC_PREFIX}technology`]: 'Steam' }),
  ]);
  const issue = res.issues.find((i) => i.message.includes('technology'));
  assert.ok(issue, JSON.stringify(res.issues));
  assert.ok(issue.message.includes('FDM'), 'the accepted values are named');
});

test('a non-numeric value in a number spec field is refused', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1000', [`${SPEC_PREFIX}print_speed`]: 'fast' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('print_speed')));
});

test('an unknown status names the three it accepts instead of silently drafting', () => {
  const res = parseOne([row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1', status: 'published' })]);
  const issue = res.issues.find((i) => i.message.startsWith('status'));
  assert.ok(issue);
  assert.ok(issue.message.includes('hidden'));
});

test('an unknown row type names the eleven that exist', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1' }),
    row({ row_type: 'widget', key: 'K1' }),
  ]);
  const issue = res.issues.find((i) => i.message.includes('widget'));
  assert.ok(issue);
  assert.ok(issue.message.includes('warranty'));
});

test('a warranty row without a duration is refused on its own line', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1' }),
    row({ row_type: 'warranty', key: 'K1', value: 'One year' }),
  ]);
  const issue = res.issues.find((i) => i.message.startsWith('duration_months'));
  assert.ok(issue);
  assert.equal(issue.line, 3);
});

test('a transport row on a product that is not sold pre-order is refused', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1', sale_types: 'direct_sale' }),
    row({ row_type: 'transport', key: 'K1', value: 'air' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('pre_order')));
});

test('a variant naming an option that is not in the file is refused', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1' }),
    row({ row_type: 'option', key: 'K1', group: 'Printer', value: 'A1' }),
    row({ row_type: 'variant', key: 'K1', links: 'Printer:A9' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('Printer:A9')));
});

test('two variant rows selecting the same thing are refused', () => {
  const res = parseOne([
    row({ row_type: 'product', key: 'K1', name: 'X', price_iqd: '1' }),
    row({ row_type: 'option', key: 'K1', group: 'Printer', value: 'A1' }),
    row({ row_type: 'variant', key: 'K1', links: 'Printer:A1', stock: '1' }),
    row({ row_type: 'variant', key: 'K1', links: 'Printer:A1', stock: '2' }),
  ]);
  assert.ok(res.issues.some((i) => i.message.includes('مكررة')));
});

// ------------------------------------------- absent means preserve

test('a sheet silent about a collection does not clear it', () => {
  const stored: ExistingShape = {
    id: 'prd_live',
    slug: 's',
    inventory_mode: 'BASE',
    doc: {
      id: 'prd_live',
      labels: [{ id: 'lbl_kept', key: '', text_en: 'Kept', text_ar: 'Kept', text_ckb: 'Kept', icon: '', order: 0, visible: true }],
      warranty_plans: [{ id: 'wp_kept', title_en: 'Kept plan', duration_months: 6, fee_iqd: 0, active: true }],
      how_to_use: 'stored text',
      is_featured: true,
      payment_options: ['cod'],
    },
    groups: [],
    values: [],
    colors: [],
    images: [],
    variants: [],
  };
  // A sheet with only the product row: no label, warranty, spec or guide rows.
  const narrow = parseOne([row({ row_type: 'product', key: 'LEVO-A1-01', name: 'X', price_iqd: '1000', category: 'printers' })]);
  const r = resolveProduct(narrow.products[0], stored, maps, { newId: idFactory(), money: true });
  assert.deepEqual((r.doc.labels as Array<{ id: string }>).map((l) => l.id), ['lbl_kept']);
  assert.deepEqual((r.doc.warranty_plans as Array<{ id: string }>).map((w) => w.id), ['wp_kept']);
  // …but the product row's own columns are present-and-empty, so they apply.
  assert.equal(r.doc.how_to_use, '');
  assert.equal(r.doc.is_featured, false);
  assert.deepEqual(r.doc.payment_options, []);
});

test('the child rows become the document the form would have produced', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });

  const groups = r.doc.spec_groups as Array<{ title_en: string; rows: Array<{ label_en: string; value_en: string; unit: string }> }>;
  assert.deepEqual(groups.map((g) => g.title_en), ['Motion', 'Power']);
  assert.deepEqual(groups[0].rows.map((x) => [x.label_en, x.value_en, x.unit]), [
    ['System', 'CoreXY', ''],
    ['Max speed', '500', 'mm/s'],
  ]);

  const labels = r.doc.labels as Array<{ key: string; text_en: string; visible: boolean; order: number }>;
  assert.deepEqual(labels.map((l) => [l.key, l.text_en, l.visible, l.order]), [
    ['warranty_included', 'Warranty included', true, 0],
    ['', 'Ships today', false, 1],
  ]);

  const plans = r.doc.warranty_plans as Array<{ title_en: string; duration_months: number; duration_kind: string; fee_iqd: number }>;
  assert.deepEqual(plans.map((w) => [w.title_en, w.duration_months, w.duration_kind, w.fee_iqd]), [
    ['One year', 12, 'total', 0],
    ['Extended', 12, 'extension', 45000],
  ]);

  const blocks = r.doc.content_blocks as Array<{ kind: string; body_en: string; url: string }>;
  assert.deepEqual(blocks.map((b) => b.kind), ['text', 'video_embed']);
  assert.equal(blocks[1].url, 'https://www.youtube.com/watch?v=abc');

  const transports = r.doc.preorder_transports as Array<{ method: string; commission_iqd: number | null; active: boolean }>;
  assert.deepEqual(transports, [
    { method: 'air', commission_iqd: null, active: true },
    { method: 'sea', commission_iqd: 15000, active: false },
  ]);

  const guide = r.doc.usage_guide as { official_url: string; steps: Array<{ kind: string; title: string; images: string[] }> };
  assert.equal(guide.official_url, 'https://wiki.bambulab.com/en/a1');
  assert.deepEqual(guide.steps.map((st) => [st.kind, st.title]), [['setup', 'Unbox'], ['usage', 'First print']]);
  assert.deepEqual(guide.steps[0].images, ['/files/products/import/a.jpg']);

  assert.equal(r.doc.is_featured, true);
  assert.equal(r.doc.direct_surcharge_iqd, 5000);
  assert.deepEqual(r.doc.payment_options, ['cod', 'wallet']);
  assert.equal(r.doc.how_to_use, sample.how_to_use);
  assert.equal(r.doc.sku, 'LEVO-A1-01');
});

test('the legacy JSON mirror uses the v2 price key, so an option price reads back', () => {
  const r = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const options = r.doc.options as Array<{ name_en: string; regular_price_iqd: number | null }>;
  const mini = options.find((o) => o.name_en === 'Printer: A1 mini');
  assert.ok(mini, JSON.stringify(options.map((o) => o.name_en)));
  assert.equal(mini.regular_price_iqd, 720000, 'the mirror must name the field the v2 shape reads');
  const colors = r.doc.colors as Array<{ name_en: string; regular_price_iqd: number | null }>;
  assert.equal(colors.find((c) => c.name_en === 'White, Matte')!.regular_price_iqd, 960000);
});

test('re-importing keeps the ids of specs, labels, plans and guide steps', () => {
  const first = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const stored: ExistingShape = {
    id: 'prd_live',
    slug: 's',
    inventory_mode: 'BASE',
    doc: {
      id: 'prd_live',
      spec_groups: first.doc.spec_groups,
      labels: first.doc.labels,
      warranty_plans: first.doc.warranty_plans,
      content_blocks: first.doc.content_blocks,
      usage_guide: first.doc.usage_guide,
    } as Record<string, unknown>,
    groups: [],
    values: [],
    colors: [],
    images: [],
    variants: [],
  };
  const second = resolveProduct(parsedSample(), stored, maps, { newId: () => 'FRESH', money: true });
  const ids = (v: unknown) => (v as Array<{ id: string }>).map((x) => x.id);
  assert.deepEqual(ids(second.doc.labels), ids(first.doc.labels));
  assert.deepEqual(ids(second.doc.warranty_plans), ids(first.doc.warranty_plans));
  assert.deepEqual(ids(second.doc.spec_groups), ids(first.doc.spec_groups));
  assert.deepEqual(ids(second.doc.content_blocks), ids(first.doc.content_blocks));
  assert.deepEqual(
    (second.doc.usage_guide as { steps: Array<{ id: string }> }).steps.map((x) => x.id),
    (first.doc.usage_guide as { steps: Array<{ id: string }> }).steps.map((x) => x.id)
  );
});
