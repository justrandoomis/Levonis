/**
 * STOCK AND PRE-ORDER CAPACITY, THROUGH BOTH FILES, WITH THE FOUR TOKENS
 * MEANING THE SAME THING IN EACH (0075).
 *
 * The four keys the owner asked for:
 *
 *   options.N.direct.stock
 *   options.N.direct.low_stock_threshold
 *   options.N.preorder.capacity
 *   options.N.preorder.transports.M.capacity
 *
 * The first two are DOCUMENTED ALIASES onto `options.N.stock` /
 * `options.N.low_stock_threshold` — one stock source per actual selection,
 * «استخدم مصدر مخزون واحد لكل اختيار فعلي» — so both spellings must reach the
 * single column `product_option_values.stock`, and an export must emit ONE of
 * them. The last two are the new, optional pre-order counters, which never
 * touch the model's stock.
 *
 * And the four tokens, which have to behave identically in the TXT parser,
 * the CSV parser, the validator, the save path, the exporter and the blank
 * generator:
 *
 *   absent    keep what is stored — silence is never a decision
 *   0         tracked, and no units available
 *   __NULL__  NOT TRACKED — unlimited, reserves nothing; never read back as 0
 *   __CLEAR__ resets the CONFIGURED number, never a hold a customer has
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  FIELD_REGISTRY,
  exportProduct,
  generateBlankTemplate,
  parseTemplate,
  toDocBody,
} from '../worker/lib/template';
import { buildExampleTemplate } from '../worker/routes/template';
import { applyRelations } from '../worker/lib/productOverlay';
import type { ProductRelationsView } from '../worker/lib/productOverlay';
import { parseProductRow } from '../worker/lib/productModel';
import {
  BASE_COLUMNS,
  CAPACITY_CLEAR,
  CAPACITY_NULL,
  blankTemplate,
  exampleRows,
  parseImport,
  readmeFor,
  serializeProducts,
  templateShape,
  type ExportProduct,
  type TemplateShape,
} from '../worker/lib/importCsv';
import { resolveProduct, type ExistingShape, type ImportMaps } from '../worker/lib/importApply';
import { fulfillmentStatements, parseFulfillmentPayload } from '../worker/lib/optionFulfillment';
import { freshDb, asD1, stubApp, post, json, all, row, type App } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';

// ---------------------------------------------------------------- TXT setup

const HEAD = 'template_version=2\nname_en=A1 mini\nprice_iqd=499000\n';
const MODEL = ['options.1.id=opt_mini', 'options.1.name_en=A1 mini'];

const txt = (...lines: string[]) => parseTemplate(HEAD + [...MODEL, ...lines].join('\n'));

const cellsOf = (parsed: ReturnType<typeof parseTemplate>, existing: unknown = null) => {
  const out = toDocBody(parsed, existing as never, { needs_review: [] });
  const option = (out.body.options as Array<Record<string, unknown>>)[0]!;
  return {
    option,
    result: out,
    cells: (option.fulfillments ?? []) as Array<Record<string, unknown>>,
    cell: (type: string) =>
      ((option.fulfillments ?? []) as Array<Record<string, unknown>>).find(
        (c) => c.fulfillment_type === type
      ),
  };
};

// =======================================================================
//  1. THE FOUR KEYS EXIST, AND direct.* IS THE MODEL'S OWN COLUMN
// =======================================================================

test('the four keys the owner asked for are in the registry, and only the aliases are import-only', () => {
  const options = FIELD_REGISTRY.groups.find((g) => g.name === 'options')!;
  const direct = options.cellFields!.direct!;
  const preorder = options.cellFields!.preorder!;

  const stock = direct.fields.find((f) => f.key === 'stock')!;
  const threshold = direct.fields.find((f) => f.key === 'low_stock_threshold')!;
  for (const spec of [stock, threshold]) {
    assert.equal(spec.onModel, true, `${spec.key} is the MODEL's column, not the cell's`);
    assert.equal(spec.exported, false, 'an export must state one column once');
    assert.equal(spec.nullable, true, '__NULL__ must be sayable');
  }
  assert.equal(stock.aliasOf, 'stock');
  assert.equal(threshold.aliasOf, 'low_stock_threshold');

  const pool = preorder.fields.find((f) => f.key === 'capacity')!;
  assert.equal(pool.nullable, true);
  assert.equal(pool.exported, undefined, 'the pool is the only spelling there is, so it exports');
  const route = preorder.list!.fields.find((f) => f.key === 'capacity')!;
  assert.equal(route.nullable, true);

  // And the contradiction is declared as a refusal rather than left unknown.
  assert.ok(direct.refused?.capacity, 'options.N.direct.capacity is refused by name');
});

test('options.N.direct.stock lands on the MODEL, never on the direct cell', () => {
  const { option, cell } = cellsOf(
    txt('options.1.direct.enabled=true', 'options.1.direct.stock=7', 'options.1.direct.low_stock_threshold=2')
  );
  assert.equal(option.stock, 7, 'the alias reaches product_option_values.stock');
  assert.equal(option.low_stock_threshold, 2);
  const direct = cell('direct_sale')!;
  assert.equal('stock' in direct, false, 'no second direct-stock column is created anywhere');
  assert.equal('capacity' in direct, false);
});

test('both spellings reach one column; the specific one wins and the warning names both', () => {
  const { option, result } = cellsOf(
    txt('options.1.stock=3', 'options.1.direct.enabled=true', 'options.1.direct.stock=9')
  );
  assert.equal(option.stock, 9, 'the more specific spelling is the deliberate statement');
  assert.ok(
    result.warnings.some((w) => w.includes('options.1.stock') && w.includes('options.1.direct.stock')),
    `a file stating one number twice must be told: ${JSON.stringify(result.warnings)}`
  );
});

test('capacity on a DIRECT cell is refused in the preview, before anything is written', () => {
  const parsed = txt('options.1.direct.enabled=true', 'options.1.direct.capacity=50');
  const hit = parsed.errors.find((e) => e.key === 'options.1.direct.capacity');
  assert.ok(hit, 'it is an ERROR, not a dropped unknown key');
  assert.deepEqual(parsed.unknown_keys, [], 'and it never degrades to a warning');
  assert.match(hit!.message, /options\.N\.stock/, 'the refusal names the field to use instead');
  assert.match(hit!.message, /capacity belongs to a pre-order only/, 'Arabic then English');
  // The merge still runs (a preview reports every problem at once) but the
  // refused number reaches nothing.
  const { option, cell } = cellsOf(parsed);
  assert.equal(option.stock, undefined);
  assert.equal('capacity' in (cell('direct_sale') ?? {}), false);
});

// =======================================================================
//  2. THE FOUR TOKENS, ON EVERY ONE OF THE FOUR KEYS (TXT)
// =======================================================================

const STORED = {
  id: 'prd_x',
  options: [
    {
      id: 'opt_mini',
      name_en: 'A1 mini',
      name_ar: 'A1 mini',
      stock: 12,
      low_stock_threshold: 4,
      fulfillments: [
        {
          fulfillment_type: 'pre_order',
          enabled: true,
          capacity: 30,
          transports: [
            { method: 'air', enabled: true, capacity: 10 },
            { method: 'sea', enabled: true, capacity: null },
          ],
        },
      ],
    },
  ],
  colors: [],
  media: [],
} as unknown;

test('ABSENT keeps what is stored — on all four keys at once', () => {
  // The file talks about the model and says nothing about any number.
  const { option, cell } = cellsOf(txt('options.1.name_en=A1 mini'), STORED);
  assert.equal(option.stock, 12, 'silence is never a decision');
  assert.equal(option.low_stock_threshold, 4);
  const pre = cell('pre_order')!;
  assert.equal(pre.capacity, 30);
  const routes = pre.transports as Array<Record<string, unknown>>;
  assert.deepEqual(
    routes.map((r) => [r.method, r.capacity]),
    [['air', 10], ['sea', null]]
  );
});

test('a pre-order block that mentions only a price leaves the capacity alone', () => {
  const { cell } = cellsOf(txt('options.1.preorder.price_iqd=+25000'), STORED);
  const pre = cell('pre_order')!;
  assert.equal(pre.regular_adjust_iqd, 25_000);
  assert.equal(pre.capacity, 30, 'an untouched capacity is an untouched capacity');
});

test('0 is a real tracked value on all four keys, and never collapses into __NULL__', () => {
  const { option, cell } = cellsOf(
    txt(
      'options.1.direct.stock=0',
      'options.1.direct.low_stock_threshold=0',
      'options.1.preorder.capacity=0',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.capacity=0'
    ),
    STORED
  );
  assert.equal(option.stock, 0);
  assert.equal(option.low_stock_threshold, 0);
  const pre = cell('pre_order')!;
  assert.equal(pre.capacity, 0);
  assert.equal((pre.transports as Array<Record<string, unknown>>)[0]!.capacity, 0);
});

test('__NULL__ is NOT TRACKED on all four keys — and it is not zero', () => {
  const { option, cell } = cellsOf(
    txt(
      'options.1.direct.stock=__NULL__',
      'options.1.direct.low_stock_threshold=__NULL__',
      'options.1.preorder.capacity=__NULL__',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.capacity=__NULL__'
    ),
    STORED
  );
  assert.equal(option.stock, null);
  assert.equal(option.low_stock_threshold, null);
  const pre = cell('pre_order')!;
  assert.equal(pre.capacity, null);
  assert.equal((pre.transports as Array<Record<string, unknown>>)[0]!.capacity, null);
  assert.notEqual(pre.capacity, 0);
});

test('__CLEAR__ resets the configured number on all four keys, and nothing else', () => {
  const { option, cell } = cellsOf(
    txt(
      'options.1.direct.stock=__CLEAR__',
      'options.1.direct.low_stock_threshold=__CLEAR__',
      'options.1.preorder.capacity=__CLEAR__',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.capacity=__CLEAR__'
    ),
    STORED
  );
  assert.equal(option.stock, null, '__CLEAR__ on a nullable number is "not tracked"');
  assert.equal(option.low_stock_threshold, null);
  const pre = cell('pre_order')!;
  assert.equal(pre.capacity, null);
  assert.equal((pre.transports as Array<Record<string, unknown>>)[0]!.capacity, null);
  // NO RESERVATION FIELD IS EVER EXPRESSIBLE FROM A FILE. A clear resets the
  // configured number, not the holds customers already have.
  assert.equal('capacity_reserved' in pre, false);
  assert.equal('stock_reserved' in option, false);
  assert.equal('reserved' in option, false);
});

test('a route left out of the file keeps its own quota; nothing copies one number onto three', () => {
  const { cell } = cellsOf(
    txt(
      'options.1.preorder.capacity=40',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.capacity=__NULL__'
    ),
    STORED
  );
  const routes = (cell('pre_order')!.transports ?? []) as Array<Record<string, unknown>>;
  // THE ASSERTION THIS TEST'S NAME ALWAYS PROMISED. It used to read
  // `[null]` — "only the route the file listed survives" — which is the
  // OPPOSITE of the title and was pinning the wholesale-replace defect in
  // `buildCells`: sea, stored and unmentioned, was deleted along with whatever
  // quota it held. Omission preserves, here as everywhere else in this format.
  assert.deepEqual(
    routes.map((r) => [r.method, r.capacity]),
    [['air', null], ['sea', null]],
    'a route the file left out was deleted instead of kept'
  );
  assert.ok(
    routes.every((r) => r.capacity !== 40),
    'the pool is never copied onto a route'
  );
});

// =======================================================================
//  3. EXPORT → RE-IMPORT IS A NO-OP (TXT)
// =======================================================================

function viewWithCapacity(): ProductRelationsView {
  return {
    has_relations: true,
    inventory_mode: 'OPTION',
    groups: [{ id: 'og1', product_id: 'prd_x', name_en: 'Model', sort: 0, active: 1 }],
    values: [
      {
        id: 'ov1', product_id: 'prd_x', group_id: 'og1', name_en: 'A1 mini', sku_part: 'MINI',
        image: '', sort: 0, active: 1, stock: 12, low_stock_threshold: 4,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: '', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null,
        variant_key: 'a1-mini', variant_label: 'A1 mini',
      },
    ],
    colors: [],
    links: [],
    variants: [],
    images: [],
    fulfillments: [
      {
        id: 'ofl_direct', product_id: 'prd_x', option_id: 'ov1', fulfillment_type: 'direct_sale',
        enabled: 1, sort: 0, capacity: null, capacity_reserved: 0,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null,
      },
      {
        id: 'ofl_pre', product_id: 'prd_x', option_id: 'ov1', fulfillment_type: 'pre_order',
        enabled: 1, sort: 1, capacity: 30, capacity_reserved: 2,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        lead_time_text: '21-30', lead_time_min_days: 21, lead_time_max_days: 30,
      },
    ],
    transports: [
      {
        id: 'otr_air', product_id: 'prd_x', fulfillment_id: 'ofl_pre', method: 'air', enabled: 1,
        sort: 0, surcharge_iqd: 80_000, capacity: 10, capacity_reserved: 1,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null,
      },
      {
        // NO QUOTA OF ITS OWN: this route shares the cell's pool.
        id: 'otr_sea', product_id: 'prd_x', fulfillment_id: 'ofl_pre', method: 'sea', enabled: 1,
        sort: 1, surcharge_iqd: 20_000, capacity: null, capacity_reserved: 0,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null,
      },
    ],
  } as unknown as ProductRelationsView;
}

const exportedDoc = () =>
  applyRelations(
    parseProductRow({ id: 'prd_x', slug: 'x', name: 'A1 mini', price_iqd: 499_000 }),
    viewWithCapacity(),
    { includeInactive: true }
  );

test('the export states each column ONCE: options.N.stock, never options.N.direct.stock', () => {
  const text = exportProduct(exportedDoc(), { includeCost: true, brand: null, catalogs: [] });
  assert.match(text, /^options\.1\.stock=12$/m);
  assert.match(text, /^options\.1\.low_stock_threshold=4$/m);
  assert.equal(/^options\.1\.direct\.stock=/m.test(text), false, 'the alias must never be exported');
  assert.equal(/^options\.1\.direct\.low_stock_threshold=/m.test(text), false);
  assert.equal(/^options\.1\.direct\.capacity=/m.test(text), false, 'and a direct sale has no capacity');
});

test('the export writes the pool and each route capacity, and __NULL__ stays __NULL__', () => {
  const text = exportProduct(exportedDoc(), { includeCost: true, brand: null, catalogs: [] });
  assert.match(text, /^options\.1\.preorder\.capacity=30$/m);
  assert.match(text, /^options\.1\.preorder\.transports\.1\.capacity=10$/m);
  assert.match(
    text,
    /^options\.1\.preorder\.transports\.2\.capacity=__NULL__$/m,
    'a shared route exports as __NULL__, never as 0 and never as the pool'
  );
  assert.equal(/capacity_reserved/.test(text), false, 'a hold is not a setting the file may state');
});

test('export → re-import is a no-op for every stock and capacity number', () => {
  const doc = exportedDoc();
  const text = exportProduct(doc, { includeCost: true, brand: null, catalogs: [] });
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, [], 'the store’s own export must parse clean');
  assert.deepEqual(parsed.unknown_keys, []);

  const back = toDocBody(parsed, doc as never, { needs_review: [] });
  const option = (back.body.options as Array<Record<string, unknown>>)[0]!;
  assert.equal(option.stock, 12);
  assert.equal(option.low_stock_threshold, 4);
  const cells = option.fulfillments as Array<Record<string, unknown>>;
  const pre = cells.find((c) => c.fulfillment_type === 'pre_order')!;
  assert.equal(pre.capacity, 30);
  assert.deepEqual(
    (pre.transports as Array<Record<string, unknown>>).map((t) => [t.method, t.capacity]),
    [['air', 10], ['sea', null]]
  );

  // …and the SECOND round trip is identical to the first, which is what makes
  // it a fixed point rather than a drift.
  const again = exportProduct(
    { ...(doc as object), options: back.body.options } as never,
    { includeCost: true, brand: null, catalogs: [] }
  );
  const capacityLines = (t: string) => t.split('\n').filter((l) => /capacity|\.stock=/.test(l));
  assert.deepEqual(capacityLines(again), capacityLines(text));
});

// =======================================================================
//  4. THE FILES THAT EXISTED BEFORE TODAY
// =======================================================================

test('a pre-0073-era file with only options.N.stock still imports, and invents no capacity', () => {
  const parsed = parseTemplate(
    HEAD +
      [
        'options.1.id=opt_mini',
        'options.1.name_en=A1 mini',
        'options.1.stock=6',
        'options.1.low_stock_threshold=1',
        'options.1.availability_type=pre_order',
        'options.1.lead_time_text=21-30',
      ].join('\n')
  );
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.unknown_keys, []);
  const out = toDocBody(parsed, null, { needs_review: [] });
  const option = (out.body.options as Array<Record<string, unknown>>)[0]!;
  assert.equal(option.stock, 6, 'it still means exactly what it meant');
  assert.equal(option.low_stock_threshold, 1);
  assert.equal(option.fulfillments, undefined, 'a file with no cell block states no cells…');
  assert.equal(
    JSON.stringify(out.body).includes('"capacity"'),
    false,
    '…and no capacity is invented anywhere in the document'
  );
});

// =======================================================================
//  5. THE BLANK AND THE EXAMPLE CARRY THE NEW KEYS
// =======================================================================

const FOUR_KEYS = [
  'options.1.direct.stock',
  'options.1.direct.low_stock_threshold',
  'options.1.preorder.capacity',
  'options.1.preorder.transports.1.capacity',
];

test('the blank generator carries all four keys, documented and commented out', () => {
  const text = generateBlankTemplate();
  for (const key of FOUR_KEYS) {
    assert.ok(text.includes(`${key}=`), `blank template is missing ${key}`);
  }
  // Commented, like every other cell key: a block that is PRESENT declares the
  // model sells that way, so a blank must not declare it for a new product.
  const active = text
    .split('\n')
    .map((l: string) => l.trim())
    .filter((l: string) => l !== '' && !l.startsWith('#'));
  assert.equal(
    active.some((l) => /^options\.\d+\.(direct|preorder)\./.test(l)),
    false
  );
  // And the two rules a column name cannot teach are printed where the keys are.
  assert.match(text, /مشترك|SHARED/);
  assert.match(text, /مستقل|INDEPENDENT|own quota/);
  assert.match(text, /refused|مرفوض/);
});

test('the example teaches both shapes — shared pool and independent quota — with no quantity', () => {
  const text = buildExampleTemplate();
  for (const key of ['direct.stock', 'preorder.capacity', 'preorder.transports.1.capacity']) {
    assert.ok(text.includes(key), `the example never mentions ${key}`);
  }
  assert.match(text, /SHARED|مشترك/);
  assert.match(text, /INDEPENDENT|مستقل/);
  // No commercial number the owner never typed: every capacity in the example
  // is a placeholder or __NULL__.
  for (const line of text.split('\n')) {
    const m = /capacity=(.+)$/.exec(line.replace(/^#\s*/, '').trim());
    if (!m) continue;
    assert.ok(
      m[1] === '__NULL__' || m[1].startsWith('<'),
      `the example must not ship a quantity: ${line}`
    );
  }
});

// =======================================================================
//  6. THE SPREADSHEET SAYS THE SAME THINGS
// =======================================================================

function shape(): TemplateShape {
  return templateShape('printer');
}

/** One product with one model, plus whatever fulfilment rows are passed. */
function sheet(rows: Array<Record<string, string>>): string {
  const cols = [...BASE_COLUMNS];
  const line = (r: Record<string, string>) =>
    cols.map((c) => (r[c] ?? '').replace(/"/g, '""')).map((v) => (/[",\n]/.test(v) ? `"${v}"` : v)).join(',');
  return [
    cols.join(','),
    line({ row_type: 'product', key: 'A1-MINI', name: 'A1 mini', price_iqd: '499000', sale_types: 'pre_order' }),
    line({ row_type: 'option', key: 'A1-MINI', group: 'Model', value: 'A1 mini', stock: '12', low_stock_threshold: '4' }),
    ...rows.map(line),
  ].join('\n');
}

const fulfil = (over: Record<string, string>) => ({
  row_type: 'fulfillment',
  key: 'A1-MINI',
  links: 'Model:A1 mini',
  value: 'pre_order',
  active: 'yes',
  ...over,
});

/**
 * WHERE EACH TXT CELL KEY LIVES IN THE SHEET — the pin itself.
 *
 * This test used to be a hand-written list of assertions about the four keys
 * that existed the day it was written. It was named "stay pinned to each
 * other" and pinned NOTHING to anything: a fifth key added tomorrow with no
 * CSV home left it green, which is precisely the drift the name promises to
 * catch. The table below is walked against the registry in both directions, so
 * a new key fails here until whoever adds it says where it lives in the sheet
 * — or states here, with a reason, that it deliberately has no cell.
 *
 * `null` is a DECISION and not an absence.
 */
const CSV_HOME: Record<string, string | null> = {
  // ONE STOCK SOURCE PER ACTUAL SELECTION. Both direct spellings ARE the
  // model's own columns on the `option` row, which the sheet has always
  // carried — two spellings, one column, in both files.
  'direct.stock': 'stock',
  'direct.low_stock_threshold': 'low_stock_threshold',

  // THE TWO PRE-ORDER COUNTERS SHARE ONE COLUMN, and the ROW says which one it
  // is: a `fulfillment` row with an empty `kind` is the model's shared pool,
  // one naming air/sea/land is that route's independent quota. Never both,
  // never a sum.
  'preorder.capacity': 'capacity',
  'preorder.transports.capacity': 'capacity',
  'preorder.transports.method': 'kind',

  // A cell, and a route, is switched on or off by the `active` column of the
  // `fulfillment` row that names it.
  'direct.enabled': 'active',
  'preorder.enabled': 'active',
  'preorder.transports.enabled': 'active',

  // NO SHEET CELL, ON PURPOSE. A `fulfillment` row carries the optional
  // capacity and the enabled flag and NOTHING ELSE (worker/lib/importCsv.ts):
  // repeating a cell's price ladder and its lead time there would let a sheet
  // that sets a quota silently rewrite a price it never mentioned. These are
  // edited in the TXT file or in the admin form.
  'direct.price_iqd': null,
  'direct.prime_price_iqd': null,
  'direct.pro_price_iqd': null,
  'direct.cost_iqd': null,
  'preorder.price_iqd': null,
  'preorder.prime_price_iqd': null,
  'preorder.pro_price_iqd': null,
  'preorder.cost_iqd': null,
  'preorder.lead_time_text': null,
  'preorder.lead_time_min_days': null,
  'preorder.lead_time_max_days': null,
  'preorder.transports.surcharge_iqd': null,
  'preorder.transports.price_iqd': null,
  'preorder.transports.prime_price_iqd': null,
  'preorder.transports.pro_price_iqd': null,
  'preorder.transports.lead_time_text': null,
  'preorder.transports.lead_time_min_days': null,
  'preorder.transports.lead_time_max_days': null,
};

/** Every `options.N.<cell>[.<list>].<field>` key the TXT registry declares. */
function txtCellKeys(): string[] {
  const options = FIELD_REGISTRY.groups.find((g) => g.name === 'options')!;
  const keys: string[] = [];
  for (const [cellName, cell] of Object.entries(options.cellFields!)) {
    for (const f of cell.fields) keys.push(`${cellName}.${f.key}`);
    if (cell.list) for (const f of cell.list.fields) keys.push(`${cellName}.${cell.list.name}.${f.key}`);
  }
  return keys;
}

test('the CSV column list and the TXT key list stay pinned to each other', () => {
  const keys = txtCellKeys();
  const columns = BASE_COLUMNS as readonly string[];

  // 1. NO TXT CELL KEY MAY EXIST WITHOUT A DECLARED SHEET HOME. This is the
  //    assertion the old body was missing entirely.
  assert.deepEqual(
    keys.filter((k) => !(k in CSV_HOME)),
    [],
    'a TXT cell key has no declared CSV home — add it to CSV_HOME with its column, or with null and the reason it has none'
  );
  // 2. AND THE TABLE MAY NOT OUTLIVE THE KEYS, or it stops describing the
  //    format and starts describing a memory of it.
  assert.deepEqual(
    Object.keys(CSV_HOME).filter((k) => !keys.includes(k)),
    [],
    'CSV_HOME names a TXT cell key the registry no longer declares'
  );
  // 3. EVERY NAMED COLUMN IS A REAL COLUMN OF THE SHEET.
  for (const [key, column] of Object.entries(CSV_HOME)) {
    if (column === null) continue;
    assert.ok(columns.includes(column), `${key} is mapped to "${column}", which is not a column of the sheet`);
  }

  // The direct aliases really are aliases onto the model's own column — the
  // reason they need no column of their own.
  const options = FIELD_REGISTRY.groups.find((g) => g.name === 'options')!;
  const direct = options.cellFields!.direct!;
  assert.ok(direct.fields.some((f) => f.key === 'stock' && f.onModel));
  assert.equal(
    columns.some((c) => c === 'direct_stock' || c === 'preorder_stock'),
    false,
    'no second direct-stock column may appear in the sheet either'
  );
  // And there is exactly ONE capacity column, which both capacity keys map to
  // above: the row type is what tells the two counters apart.
  assert.equal(
    columns.filter((c) => c.includes('capacity')).length,
    1,
    'one capacity column: the row type says which counter it is'
  );

  // And the README an admin actually reads names them both.
  const readme = readmeFor(shape());
  assert.match(readme, /fulfillment/);
  assert.match(readme, /capacity/);
  assert.match(readme, /مشترك/);
  assert.match(readme, /مستقل/);
});

test('CSV: capacity on a direct sale is refused at PREVIEW, with the field to use instead', () => {
  const out = parseImport(sheet([fulfil({ value: 'direct_sale', capacity: '5' })]), shape());
  const hit = out.issues.find((i) => i.severity === 'error' && /capacity/.test(i.message));
  assert.ok(hit, `expected a refusal, got ${JSON.stringify(out.issues)}`);
  assert.match(hit!.message, /stock/, 'it names the model stock as the place for the number');
  assert.match(hit!.message, /a direct sale has no capacity/);
  assert.equal(out.products[0]!.fulfillments?.length ?? 0, 0, 'and nothing is carried forward');
});

test('CSV: the four tokens mean in the sheet exactly what they mean in the TXT file', () => {
  const read = (cell: string | undefined) => {
    const row: Record<string, string> = cell === undefined ? {} : { capacity: cell };
    const out = parseImport(sheet([fulfil(row)]), shape());
    assert.deepEqual(out.issues.filter((i) => i.severity === 'error'), []);
    return out.products[0]!.fulfillments![0]!;
  };
  assert.equal('capacity' in read(undefined), false, 'an empty cell says nothing');
  assert.equal('capacity' in read(''), false);
  assert.equal(read('0').capacity, 0, 'zero is tracked and empty');
  assert.equal(read(CAPACITY_NULL).capacity, null, '__NULL__ is untracked');
  assert.equal(read(CAPACITY_CLEAR).capacity, null, '__CLEAR__ resets to untracked');
  assert.notEqual(read(CAPACITY_NULL).capacity, 0);
});

test('CSV: a route row carries its own quota, and leaving it empty keeps it on the pool', () => {
  const out = parseImport(
    sheet([
      fulfil({ capacity: '40' }),
      fulfil({ kind: 'air', capacity: '10' }),
      fulfil({ kind: 'sea' }),
    ]),
    shape()
  );
  assert.deepEqual(out.issues.filter((i) => i.severity === 'error'), []);
  const rows = out.products[0]!.fulfillments!;
  assert.deepEqual(
    rows.map((r) => [r.method, r.capacity]),
    [['', 40], ['air', 10], ['sea', undefined]]
  );
});

test('CSV: a fulfillment row naming a model the file has no option row for is refused', () => {
  const out = parseImport(sheet([fulfil({ links: 'Model:Nope' })]), shape());
  assert.ok(out.issues.some((i) => i.severity === 'error' && /Nope/.test(i.message)));
});

test('CSV: the same (model, order type, route) twice is refused', () => {
  const out = parseImport(sheet([fulfil({ kind: 'air' }), fulfil({ kind: 'air' })]), shape());
  assert.ok(out.issues.some((i) => i.severity === 'error' && /مكرر|twice/.test(i.message)));
});

test('CSV: a sheet with NO fulfillment row says nothing, so stored cells survive', () => {
  const out = parseImport(sheet([]), shape());
  assert.equal(out.products[0]!.fulfillments, null, 'null is "this file does not talk about cells"');
});

const MAPS: ImportMaps = {
  brands: new Map(),
  catalogs: new Map(),
  facets: new Map(),
  familyOf: new Map(),
  images: new Map(),
};

const storedProduct = (): ExistingShape => ({
  id: 'prd_x',
  slug: 'a1-mini',
  inventory_mode: 'OPTION',
  doc: {} as Record<string, unknown>,
  groups: [{ id: 'og1', name_en: 'Model' }],
  values: [{ id: 'ov1', group_id: 'og1', name_en: 'A1 mini' }],
  colors: [],
  images: [],
  variants: [],
  fulfillments: [
    {
      id: 'ofl_pre',
      option_id: 'ov1',
      fulfillment_type: 'pre_order',
      enabled: true,
      capacity: 30,
      capacity_reserved: 2,
      regular_price_iqd: 520_000,
      lead_time_text: '21-30',
      transports: [{ id: 'otr_air', method: 'air', capacity: 10, surcharge_iqd: 80_000 }],
    },
  ],
});

test('CSV: a disabled stored cell is not switched back on by a capacity-only edit', () => {
  // The DB stores the flag as 0/1 and the payload parser reads `!== false`, so
  // a stored 0 handed back verbatim would read as TRUE. The loader coerces it.
  const stored = storedProduct();
  stored.fulfillments![0]!.enabled = false;
  const parsed = parseImport(sheet([fulfil({ capacity: '45', active: 'no' })]), shape());
  const resolved = resolveProduct(parsed.products[0]!, stored, MAPS, {
    newId: (p: string) => `${p}_new`,
    money: true,
  } as never);
  const values = (resolved.relations.groups as Array<{ values: Array<Record<string, unknown>> }>)[0]!.values;
  const cells = values[0]!.fulfillments as Array<Record<string, unknown>>;
  assert.equal(cells[0]!.enabled, false, 'the sheet said no, and it stays no');
});

test('CSV → relations: a capacity-only sheet moves the number and keeps every stored price', () => {
  const parsed = parseImport(sheet([fulfil({ capacity: '45' })]), shape());
  assert.deepEqual(parsed.issues.filter((i) => i.severity === 'error'), []);
  const resolved = resolveProduct(parsed.products[0]!, storedProduct(), MAPS, {
    newId: (p: string) => `${p}_new`,
    money: true,
  } as never);
  const values = (resolved.relations.groups as Array<{ values: Array<Record<string, unknown>> }>)[0]!.values;
  const cells = values[0]!.fulfillments as Array<Record<string, unknown>>;
  assert.equal(cells.length, 1);
  assert.equal(cells[0]!.capacity, 45, 'the sheet set the pool');
  assert.equal(cells[0]!.regular_price_iqd, 520_000, 'and touched no price it never mentioned');
  assert.equal(cells[0]!.lead_time_text, '21-30');
  const routes = cells[0]!.transports as Array<Record<string, unknown>>;
  assert.deepEqual(routes.map((r) => [r.method, r.capacity]), [['air', 10]], 'nor a route it never mentioned');
});

test('CSV → relations: a sheet with no fulfillment row attaches nothing, so the writer preserves', () => {
  const parsed = parseImport(sheet([]), shape());
  const resolved = resolveProduct(parsed.products[0]!, storedProduct(), MAPS, {
    newId: (p: string) => `${p}_new`,
    money: true,
  } as never);
  const values = (resolved.relations.groups as Array<{ values: Array<Record<string, unknown>> }>)[0]!.values;
  assert.equal('fulfillments' in values[0]!, false, 'silence must not be a replacement');
});

test('CSV export → re-import is a no-op, and an untracked capacity survives as __NULL__', () => {
  const sh = shape();
  const product: ExportProduct = {
    key: 'A1-MINI',
    line: 0,
    name: 'A1 mini',
    description: '',
    status: 'active',
    sku: 'A1-MINI',
    display_order: 0,
    is_featured: false,
    brand: '',
    category: '',
    sub_category: '',
    sale_types: ['pre_order'],
    inventory_mode: 'OPTION',
    price_iqd: 499_000,
    prime_price_iqd: null,
    pro_price_iqd: null,
    cost_iqd: null,
    direct_surcharge_iqd: null,
    stock: null,
    low_stock_threshold: null,
    warranty_base_months: null,
    serialized: null,
    payment_options: [],
    how_to_use: '',
    usage_url: '',
    hashtags: [],
    spec_fields: {},
    options: [
      {
        group: 'Model', value: 'A1 mini', sku_part: '', image: '', active: true,
        stock: 12, low_stock_threshold: 4,
        price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: 'pre_order', lead_time_text: '', lead_time_min_days: null,
        lead_time_max_days: null, variant_key: 'a1-mini', variant_label: 'A1 mini',
      },
    ],
    colors: [],
    variants: [],
    images: [],
    transports: [],
    fulfillments: [
      { group: 'Model', value: 'A1 mini', fulfillment_type: 'pre_order', method: '', capacity: 30, enabled: true },
      { group: 'Model', value: 'A1 mini', fulfillment_type: 'pre_order', method: 'air', capacity: 10, enabled: true },
      { group: 'Model', value: 'A1 mini', fulfillment_type: 'pre_order', method: 'sea', capacity: null, enabled: true },
    ],
    specs: [],
    labels: [],
    warranty_plans: [],
    content_blocks: [],
    guide_steps: [],
  } as unknown as ExportProduct;

  const csv = serializeProducts([product], sh);
  assert.match(csv, /fulfillment/);
  assert.ok(csv.includes(CAPACITY_NULL), 'an untracked route must export as __NULL__, not as an empty cell');

  const back = parseImport(csv, sh);
  assert.deepEqual(back.issues.filter((i) => i.severity === 'error'), []);
  const rows = back.products[0]!.fulfillments!;
  assert.deepEqual(
    rows.map((r) => [r.method, r.capacity]),
    [['', 30], ['air', 10], ['sea', null]],
    'the sea route comes back UNTRACKED, not 0'
  );
  assert.equal(back.products[0]!.options[0]!.stock, 12, 'and the model stock is still the option row’s');
});

test('the CSV blank/example teaches the shape with no quantity of its own', () => {
  const sh = shape();
  const rows = exampleRows(sh);
  const cells = rows.filter((r) => r.row_type === 'fulfillment');
  assert.ok(cells.length >= 2, 'both shapes are demonstrated: the pool and a route');
  for (const r of cells) {
    assert.equal(r.capacity, CAPACITY_NULL, `the example must ship no quantity: ${JSON.stringify(r)}`);
  }
  assert.ok(blankTemplate(sh, true).includes('fulfillment'));
  assert.equal(blankTemplate(sh, false).includes('fulfillment'), false, 'a blank stays blank');
});

// =======================================================================
//  7. THE SAVE PATH: A CLEAR RESETS A NUMBER, NEVER A HOLD
// =======================================================================

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return db;
}

test('__CLEAR__ through the writer: the number goes untracked, the hold and the row id stay', async () => {
  const raw = schema();
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p','a1','A1',499000);
    INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g','p','Model');
    INSERT INTO product_option_values (id,product_id,group_id,name_en) VALUES ('ov1','p','g','A1 mini');
  `);
  const db = new SqliteD1(raw) as unknown as {
    prepare(sql: string): D1PreparedStatement;
    batch(s: D1PreparedStatement[]): Promise<unknown[]>;
  };

  // A model with a tracked pool and a tracked air quota, both holding units.
  const first = parseFulfillmentPayload(
    {
      fulfillments: [
        {
          option_id: 'ov1',
          fulfillment_type: 'pre_order',
          capacity: 30,
          transports: [{ method: 'air', capacity: 10 }, { method: 'sea' }],
        },
      ],
    },
    new Set(['ov1'])
  );
  let n = 0;
  await db.batch(fulfillmentStatements(db, 'p', first, () => `id-${++n}`));
  raw.exec("UPDATE product_option_fulfillment SET capacity_reserved = 2");
  raw.exec("UPDATE product_option_transports SET capacity_reserved = 1 WHERE method = 'air'");

  const cellRow = raw.prepare('SELECT id FROM product_option_fulfillment').get() as { id: string };
  const airRow = raw.prepare("SELECT id FROM product_option_transports WHERE method='air'").get() as { id: string };

  // The file says __CLEAR__ on both, which reaches the writer as `capacity: null`.
  const cleared = parseFulfillmentPayload(
    {
      fulfillments: [
        {
          option_id: 'ov1',
          fulfillment_type: 'pre_order',
          capacity: null,
          transports: [{ method: 'air', capacity: null }, { method: 'sea' }],
        },
      ],
    },
    new Set(['ov1'])
  );
  const existing = {
    cells: new Map([['ov1|pre_order', { id: cellRow.id, capacity_reserved: 2 }]]),
    transports: new Map([['ov1|pre_order|air', { id: airRow.id, capacity_reserved: 1 }]]),
  };
  await db.batch(fulfillmentStatements(db, 'p', cleared, () => `id-${++n}`, existing));

  const after = raw
    .prepare('SELECT id, capacity, capacity_reserved FROM product_option_fulfillment')
    .get() as { id: string; capacity: number | null; capacity_reserved: number };
  assert.equal(after.capacity, null, 'the CONFIGURED number is reset to untracked');
  assert.equal(after.capacity_reserved, 2, 'the units customers are holding are NOT released by a file');
  assert.equal(after.id, cellRow.id, 'and the row id survives, or the ledger could never release them');

  const air = raw
    .prepare("SELECT id, capacity, capacity_reserved FROM product_option_transports WHERE method='air'")
    .get() as { id: string; capacity: number | null; capacity_reserved: number };
  assert.equal(air.capacity, null);
  assert.equal(air.capacity_reserved, 1);
  assert.equal(air.id, airRow.id);
});

// =======================================================================
//  8. THE REAL ROUTE: A FILE'S CAPACITY REACHES THE TABLES
// =======================================================================

const OWNER = { id: 'usr_owner', role: 'admin' as const, email: 'boss@x.co', admin_scope: null };
const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/admin/template', templateRoutes);
  a.route('/api/admin/products', adminProductRelationsRoutes);
};

const applyText = async (app: App, text: string, mode: 'draft' | 'update' = 'draft') =>
  json(await post(app, '/api/admin/template/apply', { text, mode, confirm: true }));

const FILE = [
  'template_version=2',
  'name_ar=A1 mini',
  'name_en=A1 mini',
  'price_iqd=499000',
  'inventory_mode=OPTION',
  'options.1.id=ov_mini',
  'options.1.name_ar=A1 mini',
  'options.1.name_en=A1 mini',
  'options.1.direct.enabled=true',
  'options.1.direct.stock=7',
  'options.1.direct.low_stock_threshold=2',
  'options.1.preorder.enabled=true',
  'options.1.preorder.capacity=30',
  'options.1.preorder.transports.1.method=air',
  'options.1.preorder.transports.1.capacity=10',
  'options.1.preorder.transports.2.method=sea',
  'options.1.preorder.transports.2.capacity=__NULL__',
].join('\n');

test('POST /template/apply writes the model stock AND the pre-order capacities to the tables', async () => {
  const raw = freshDb();
  const app = stubApp(asD1(raw), OWNER, mount);
  const res = await applyText(app, FILE);
  assert.equal(res.success, true, JSON.stringify(res));

  // The direct number is the MODEL's stock — there is no second column.
  const value = row(
    raw,
    'SELECT stock, low_stock_threshold FROM product_option_values WHERE id = ?',
    'ov_mini'
  ) as { stock: number; low_stock_threshold: number };
  assert.equal(value.stock, 7, 'options.N.direct.stock is options.N.stock');
  assert.equal(value.low_stock_threshold, 2);

  const cells = all(
    raw,
    'SELECT fulfillment_type, capacity, capacity_reserved FROM product_option_fulfillment ORDER BY fulfillment_type'
  ) as Array<{ fulfillment_type: string; capacity: number | null; capacity_reserved: number }>;
  assert.deepEqual(
    cells.map((c) => [c.fulfillment_type, c.capacity]),
    [['direct_sale', null], ['pre_order', 30]],
    'a direct cell never carries a capacity; the pre-order cell carries the pool'
  );
  assert.ok(cells.every((c) => c.capacity_reserved === 0), 'a new cell holds nothing');

  const routes = all(
    raw,
    'SELECT method, capacity FROM product_option_transports ORDER BY method'
  ) as Array<{ method: string; capacity: number | null }>;
  assert.deepEqual(
    routes.map((r) => [r.method, r.capacity]),
    [['air', 10], ['sea', null]],
    'air holds its own quota; sea is left on the shared pool — no quantity is copied'
  );
});

test('re-applying the SAME file keeps the row ids and the units already held', async () => {
  const raw = freshDb();
  const app = stubApp(asD1(raw), OWNER, mount);
  const created = await applyText(app, FILE);
  const productId = String(created.product_id ?? created.id ?? '');
  assert.ok(productId, JSON.stringify(created));

  const before = row(raw, 'SELECT id FROM product_option_fulfillment WHERE fulfillment_type = ?', 'pre_order') as {
    id: string;
  };
  raw.prepare('UPDATE product_option_fulfillment SET capacity_reserved = 4 WHERE id = ?').run(before.id);
  raw.prepare("UPDATE product_option_transports SET capacity_reserved = 1 WHERE method = 'air'").run();

  // The SAME file, applied again as an update. The replace is delete-then-
  // insert, so this is the case that would mint a new row id and zero the hold.
  const updated = await applyText(
    app,
    FILE.replace('template_version=2', `template_version=2
product_id=${productId}`),
    'update'
  );
  assert.equal(updated.success, true, JSON.stringify(updated));

  const after = row(
    raw,
    'SELECT id, capacity, capacity_reserved FROM product_option_fulfillment WHERE fulfillment_type = ?',
    'pre_order'
  ) as { id: string; capacity: number | null; capacity_reserved: number };
  assert.equal(after.id, before.id, 'the row id is inventory_ledger.scope_id — minting a new one strands the hold');
  assert.equal(after.capacity, 30, 'the file said 30 and still says 30');
  assert.equal(after.capacity_reserved, 4, 'and it released nothing a customer is holding');
  const air = row(raw, "SELECT capacity_reserved FROM product_option_transports WHERE method = 'air'") as {
    capacity_reserved: number;
  };
  assert.equal(air.capacity_reserved, 1);
});

test('__CLEAR__ on a capacity that is HOLDING units is refused, not silently obeyed', async () => {
  // This case used to assert the opposite — that __CLEAR__ went through and
  // simply kept the hold — and that was wrong, so the assertion is inverted
  // here rather than deleted. Untracked is STRICTLY WORSE than zero: the
  // deduct guard is `<onHand> IS NOT NULL AND ...`, so once the column is NULL
  // the held units can be neither deducted at confirmation nor released on a
  // cancel. They would sit in capacity_reserved for ever, and re-tracking the
  // quota would then be blocked below them for ever by CAPACITY_BELOW_RESERVED.
  // __CLEAR__ is how an owner stops LIMITING a pre-order; it is not how they
  // lose the orders they have already taken.
  const raw = freshDb();
  const app = stubApp(asD1(raw), OWNER, mount);
  const created = await applyText(app, FILE);
  const productId = String(created.product_id ?? created.id ?? '');
  const before = row(raw, 'SELECT id FROM product_option_fulfillment WHERE fulfillment_type = ?', 'pre_order') as {
    id: string;
  };
  raw.prepare('UPDATE product_option_fulfillment SET capacity_reserved = 4 WHERE id = ?').run(before.id);

  const cleared = await applyText(
    app,
    FILE.replace('template_version=2', `template_version=2
product_id=${productId}`).replace(
      'options.1.preorder.capacity=30',
      'options.1.preorder.capacity=__CLEAR__'
    ),
    'update'
  );
  assert.equal(cleared.success, false, JSON.stringify(cleared));
  assert.equal(cleared.code, 'CAPACITY_UNTRACKED_WHILE_HELD', JSON.stringify(cleared));
  assert.match(String(cleared.error), /4/, 'the refusal names the count, so the owner knows what to cancel');

  const after = row(
    raw,
    'SELECT capacity, capacity_reserved FROM product_option_fulfillment WHERE fulfillment_type = ?',
    'pre_order'
  ) as { capacity: number | null; capacity_reserved: number };
  assert.equal(after.capacity, 30, 'and the refusal changed nothing');
  assert.equal(after.capacity_reserved, 4);
});

test('__CLEAR__ IS obeyed once nothing is held, and keeps the row id', async () => {
  const raw = freshDb();
  const app = stubApp(asD1(raw), OWNER, mount);
  const created = await applyText(app, FILE);
  const productId = String(created.product_id ?? created.id ?? '');
  const before = row(raw, 'SELECT id FROM product_option_fulfillment WHERE fulfillment_type = ?', 'pre_order') as {
    id: string;
  };

  const cleared = await applyText(
    app,
    FILE.replace('template_version=2', `template_version=2
product_id=${productId}`).replace(
      'options.1.preorder.capacity=30',
      'options.1.preorder.capacity=__CLEAR__'
    ),
    'update'
  );
  assert.equal(cleared.success, true, JSON.stringify(cleared));
  const after = row(
    raw,
    'SELECT id, capacity FROM product_option_fulfillment WHERE fulfillment_type = ?',
    'pre_order'
  ) as { id: string; capacity: number | null };
  assert.equal(after.capacity, null, 'untracked = unlimited pre-orders again');
  assert.equal(after.id, before.id, 'and the row identity still survives the replace');
});

test('a file that mentions no cell block leaves the stored cells exactly as they are', async () => {
  const raw = freshDb();
  const app = stubApp(asD1(raw), OWNER, mount);
  const created = await applyText(app, FILE);
  const productId = String(created.product_id ?? created.id ?? '');

  const priceOnly = [
    'template_version=2',
    `product_id=${productId}`,
    'name_ar=A1 mini',
    'name_en=A1 mini',
    'price_iqd=520000',
  ].join('\n');
  const res = await applyText(app, priceOnly, 'update');
  assert.equal(res.success, true, JSON.stringify(res));

  const cells = all(raw, 'SELECT fulfillment_type, capacity FROM product_option_fulfillment ORDER BY fulfillment_type');
  assert.deepEqual(cells, [
    { fulfillment_type: 'direct_sale', capacity: null },
    { fulfillment_type: 'pre_order', capacity: 30 },
  ]);
  const routes = all(raw, 'SELECT method, capacity FROM product_option_transports ORDER BY method');
  assert.deepEqual(routes, [{ method: 'air', capacity: 10 }, { method: 'sea', capacity: null }]);
});

test('the writer refuses a capacity on a direct cell before it can reach a column', () => {
  assert.throws(
    () =>
      parseFulfillmentPayload(
        { fulfillments: [{ option_id: 'ov1', fulfillment_type: 'direct_sale', capacity: 5 }] },
        new Set(['ov1'])
      ),
    /CAPACITY_ON_DIRECT|capacity/
  );
});
