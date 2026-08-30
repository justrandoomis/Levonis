/**
 * The Devices / Materials import format — mandate §10.
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
  blankTemplate,
  labelRow,
  parseCsv,
  parseImport,
  readmeFor,
  serializeProducts,
  templateShape,
  toCsv,
  type ExportProduct,
} from '../worker/lib/importCsv';
import { normKey, resolveProduct, splitComboKey } from '../worker/lib/importApply';
import type { CatalogRef, ImportMaps } from '../worker/lib/importApply';

const devices = templateShape('devices', ['fdm-printers', 'printers'], { includeCost: true });
const materials = templateShape('materials', ['printing-materials'], { includeCost: true });

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

test('columns follow the section: a Devices sheet is not a Materials sheet', () => {
  const d = new Set(devices.columns);
  const m = new Set(materials.columns);
  for (const base of BASE_COLUMNS) {
    assert.ok(d.has(base), `devices is missing base column ${base}`);
    assert.ok(m.has(base), `materials is missing base column ${base}`);
  }
  const dSpec = devices.columns.filter((c) => c.startsWith('spec.'));
  const mSpec = materials.columns.filter((c) => c.startsWith('spec.'));
  assert.ok(dSpec.length > 0 && mSpec.length > 0, 'both families must declare spec columns');
  assert.ok(
    dSpec.some((c) => !mSpec.includes(c)),
    'the two families must not have identical spec columns'
  );
});

test('cost is withheld from the sheet an assistant admin downloads', () => {
  const withCost = templateShape('devices', ['printers'], { includeCost: true });
  const without = templateShape('devices', ['printers'], { includeCost: false });
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
  assert.equal(res.products[0].key, 'EXAMPLE-001');
  assert.equal(res.products[0].options.length, 2);
  assert.equal(res.products[0].colors[0].links.length, 2);
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

test('the README names the section spec columns it ships with', () => {
  const readme = readmeFor(materials);
  for (const f of materials.specFields) assert.ok(readme.includes(f.id), `README omits ${f.id}`);
});

// ---------------------------------------------------------- the round-trip

const sample: ExportProduct = {
  key: 'LEVO-A1-01',
  name: 'Bambu Lab A1 Combo',
  description: 'Nozzle diameter: 0.4 mm. Build volume: 256 mm.',
  status: 'active',
  display_order: 3,
  brand: 'Bambu Lab',
  category: 'Printers',
  sub_category: 'FDM Printers',
  sale_types: ['direct_sale', 'pre_order'],
  inventory_mode: 'COLOR',
  price_iqd: 950000,
  prime_price_iqd: 910000,
  pro_price_iqd: 880000,
  cost_iqd: 700000,
  stock: 12,
  low_stock_threshold: 3,
  facets: ['offers-new', 'fdm-pla'],
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
      links: [],
    },
  ],
  images: [
    { image: '/files/products/import/a.jpg', alt: 'front', primary: true, bind: '' },
    { image: '/files/products/import/b.jpg', alt: 'back "angle"', primary: false, bind: 'color:Black' },
    { image: '/files/products/import/c.jpg', alt: '', primary: false, bind: 'option:Printer:A1' },
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
  assert.equal(p.display_order, sample.display_order);
  assert.equal(p.brand, sample.brand);
  assert.equal(p.category, sample.category);
  assert.equal(p.sub_category, sample.sub_category);
  assert.deepEqual(p.sale_types, sample.sale_types);
  assert.equal(p.inventory_mode, sample.inventory_mode);
  assert.equal(p.price_iqd, sample.price_iqd);
  assert.equal(p.prime_price_iqd, sample.prime_price_iqd);
  assert.equal(p.pro_price_iqd, sample.pro_price_iqd);
  assert.equal(p.cost_iqd, sample.cost_iqd);
  assert.equal(p.stock, sample.stock);
  assert.equal(p.low_stock_threshold, sample.low_stock_threshold);
  assert.deepEqual(p.facets, sample.facets);
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
        images: parsed.images.map(({ line: _line, ...rest }) => rest),
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
  assert.deepEqual(r.relations.facet_ids, ['fac_new', 'fac_pla']);

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

  const existing = {
    id: 'prd_live',
    slug: 'bambu-lab-a1-combo',
    inventory_mode: 'COLOR',
    doc: { id: 'prd_live', brand_id: 'brand_bambu' } as Record<string, unknown>,
    groups: groups.map((g) => ({ id: g.id, name_en: g.name_en })),
    values: groups.flatMap((g) => g.values.map((v) => ({ id: v.id, group_id: g.id, name_en: v.name_en }))),
    colors: colors.map((col) => ({ id: col.id, name_en: col.name_en })),
    images: images.map((im) => ({ id: im.id, url: im.url })),
    variants: [],
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

test('an unknown brand, section or facet blocks the row instead of inventing one', () => {
  const p = parsedSample();
  p.brand = 'Nonexistent Brand';
  p.facets = ['not-a-facet'];
  const r = resolveProduct(p, null, maps, { newId: idFactory(), money: true });
  assert.ok(r.issues.some((i) => i.message.includes('Nonexistent Brand')));
  assert.ok(r.issues.some((i) => i.message.includes('not-a-facet')));
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

test('a new product cannot claim VARIANT_COMBINATION out of a spreadsheet', () => {
  const p = parsedSample();
  p.inventory_mode = 'VARIANT_COMBINATION';
  const r = resolveProduct(p, null, maps, { newId: idFactory(), money: true });
  assert.ok(r.issues.some((i) => i.message.includes('VARIANT_COMBINATION')));
});

test('existing variant combinations survive a re-import', () => {
  const first = resolveProduct(parsedSample(), null, maps, { newId: idFactory(), money: true });
  const groups = first.relations.groups as Array<{ id: string; name_en: string; values: Array<{ id: string; name_en: string }> }>;
  const colors = first.relations.colors as Array<{ id: string; name_en: string }>;
  const valueId = groups[0].values[0].id;
  const colorId = colors[0].id;

  const existing = {
    id: 'prd_live',
    slug: 's',
    inventory_mode: 'VARIANT_COMBINATION',
    doc: {} as Record<string, unknown>,
    groups: groups.map((g) => ({ id: g.id, name_en: g.name_en })),
    values: groups.flatMap((g) => g.values.map((v) => ({ id: v.id, group_id: g.id, name_en: v.name_en }))),
    colors: colors.map((col) => ({ id: col.id, name_en: col.name_en })),
    images: [],
    variants: [
      {
        id: 'pv_1',
        combo_key: `c:${colorId}|o:${valueId}`,
        sku: 'A1-BLK',
        active: 1,
        stock: 4,
        low_stock_threshold: 1,
        regular_price_iqd: null,
        prime_price_iqd: null,
        pro_price_iqd: null,
        cost_iqd: null,
      },
    ],
  };

  const p = parsedSample();
  p.inventory_mode = 'VARIANT_COMBINATION';
  const r = resolveProduct(p, existing, maps, { newId: () => 'FRESH', money: true });
  assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), []);
  const variants = r.relations.variants as Array<{ id: string; stock: number; option_value_ids: string[]; color_id: string }>;
  assert.equal(variants.length, 1);
  assert.equal(variants[0].id, 'pv_1');
  assert.equal(variants[0].stock, 4, 'combination stock is preserved, not reset');
  assert.deepEqual(variants[0].option_value_ids, [valueId]);
  assert.equal(variants[0].color_id, colorId);
});

test('splitComboKey inverts the key inventory.ts builds', () => {
  assert.deepEqual(splitComboKey('o:v1|o:v2|c:c1'), { option_value_ids: ['v1', 'v2'], color_id: 'c1' });
  assert.deepEqual(splitComboKey('c:c1'), { option_value_ids: [], color_id: 'c1' });
  assert.deepEqual(splitComboKey(''), { option_value_ids: [], color_id: null });
});
