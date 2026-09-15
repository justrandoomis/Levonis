/**
 * THE THREE DOORS A PRE-ORDER CAPACITY WENT MISSING BEHIND (0075).
 *
 * Migration 0075 gave a (model x pre_order) cell an OPTIONAL shared pool and
 * each of its routes an optional quota of its own. NULL is UNTRACKED —
 * unlimited, reserves nothing — and 0 is tracked and empty. The counters
 * themselves are pinned by tests/stockByOrderType.test.ts. This file pins the
 * three FILE doors, each of which was green while losing the number:
 *
 *  D1. THE SPREADSHEET DOOR THREW EVERY CAPACITY AWAY. `POST
 *      /api/admin/import/confirm` applies a sheet through `planRelationsWrite`,
 *      which writes MODELS and emits no cell statement at all —
 *      `fulfillmentStatements` is reached only from `planProductSave`, which
 *      the TXT door uses and the sheet door does not. So a `fulfillment` row's
 *      capacity was parsed, validated, refused by name when it was typed on the
 *      wrong row, shown in a CLEAN PREVIEW — and then dropped. The cell stayed
 *      UNTRACKED, which is unlimited, so every buyer after the first was sold a
 *      unit nobody had.
 *
 *  D2. `options.N.preorder.transports=__CLEAR__` EMPTIED THE MERGE BASE as
 *      well as the list, so a route RE-LISTED after it — the routes the notes
 *      tell an owner to name «التي تريد بقاءها», the ones they want to KEEP —
 *      was written FRESH: a stored quota of 10 became NULL, untracked,
 *      unlimited. The preview reported success with empty errors, empty
 *      warnings and an EMPTY `cleared_fields`, the one field whose whole job is
 *      to name what a file cleared.
 *
 *  D3. `options.1.capacity=44` — the spelling an admin reaching for "how many
 *      may I pre-order" types beside `options.1.stock` — was accepted with the
 *      generic «unknown key was ignored» warning and the apply SUCCEEDED with
 *      the cell untracked. The same mistake is refused BY NAME in the sheet,
 *      and `options.N.direct.capacity` is refused by name in this very format.
 *
 * Real migrations, real SQLite, the real `/api/admin/import` router and the
 * real template parser. Nothing about the cells is stubbed: every row asserted
 * here was written by the production path.
 *
 * Run: npx tsx --test tests/capacityImportDoors.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, stubApp, ctx, all, type App } from './fixtures/app';
import { adminImportRoutes } from '../worker/routes/adminImport';
import { BASE_COLUMNS } from '../worker/lib/importCsv';
import { parseTemplate, toDocBody } from '../worker/lib/template';

// ============================================================= the fixtures

const SECTION = 'tpl_printers';

function setup() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role)
      VALUES ('boss','Admin','boss@x.co','h','admin');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,template_family,is_printer_catalog,active)
      VALUES ('${SECTION}',NULL,'tpl-printers','طابعات','Printers','devices',1,1);
  `);
  const app = stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) =>
    a.route('/api/admin/import', adminImportRoutes)
  );
  return { raw, app };
}

const COLS = [...BASE_COLUMNS];
const line = (r: Record<string, string>) =>
  COLS.map((c) => (r[c] ?? '').replace(/"/g, '""'))
    .map((v) => (/[",\n]/.test(v) ? `"${v}"` : v))
    .join(',');

/** The product + one model, plus whatever `fulfillment` rows a case needs. */
function sheet(rows: Array<Record<string, string>>): string {
  return [
    COLS.join(','),
    line({
      row_type: 'product',
      key: 'A1-MINI',
      name: 'A1 mini',
      status: 'active',
      category: 'tpl-printers',
      price_iqd: '499000',
      sale_types: 'pre_order',
      inventory_mode: 'OPTION',
    }),
    line({ row_type: 'option', key: 'A1-MINI', group: 'Model', value: 'A1 mini', availability_type: 'pre_order' }),
    ...rows.map(line),
  ].join('\n');
}

const preOrderCell = (over: Record<string, string> = {}) => ({
  row_type: 'fulfillment',
  key: 'A1-MINI',
  links: 'Model:A1 mini',
  value: 'pre_order',
  active: 'yes',
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response) => (await res.json()) as Record<string, any>;

async function preview(app: App, csv: string) {
  const form = new FormData();
  form.set('file', new File([csv], 'data.csv', { type: 'text/csv' }));
  form.set('category', SECTION);
  const res = await app.request(
    '/api/admin/import/preview',
    { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } },
    undefined,
    ctx
  );
  return body(res);
}

async function confirm(app: App, importId: string) {
  const res = await app.request(
    '/api/admin/import/confirm',
    {
      method: 'POST',
      body: JSON.stringify({ import_id: importId }),
      headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    },
    undefined,
    ctx
  );
  return body(res);
}

/** Preview then confirm, asserting the preview accepted the file on the way. */
async function importSheet(app: App, csv: string) {
  const prev = await preview(app, csv);
  assert.equal(prev.success, true, JSON.stringify(prev));
  assert.deepEqual(
    prev.rows.flatMap((r: { errors: string[] }) => r.errors),
    [],
    'the preview refused a sheet this test expected it to accept'
  );
  return confirm(app, prev.import_id);
}

interface CellRow {
  id: string;
  fulfillment_type: string;
  enabled: number;
  capacity: number | null;
  capacity_reserved: number;
}
interface RouteRow {
  id: string;
  method: string;
  capacity: number | null;
  capacity_reserved: number;
}
const cells = (raw: DatabaseSync) =>
  all<CellRow>(
    raw,
    'SELECT id, fulfillment_type, enabled, capacity, capacity_reserved FROM product_option_fulfillment ORDER BY fulfillment_type'
  );
const routes = (raw: DatabaseSync) =>
  all<RouteRow>(raw, 'SELECT id, method, capacity, capacity_reserved FROM product_option_transports ORDER BY method');

// =====================================================================
//  D1 — THE SHEET DOOR WRITES THE CAPACITY IT PREVIEWED
// =====================================================================

test('D1: a sheet that states a shared pool of 1 writes a pool of 1, not an untracked cell', async () => {
  const { raw, app } = setup();
  const res = await importSheet(app, sheet([preOrderCell({ capacity: '1' })]));
  assert.equal(res.summary.created, 1, JSON.stringify(res));
  assert.equal(res.summary.failed, 0, JSON.stringify(res.rows));

  const stored = cells(raw);
  assert.equal(stored.length, 1, `the sheet capacity reached no row at all: ${JSON.stringify(stored)}`);
  assert.equal(stored[0].fulfillment_type, 'pre_order');
  assert.equal(
    stored[0].capacity,
    1,
    'the cell is untracked — NULL is UNLIMITED, so every buyer after the first is sold a unit nobody has'
  );
  assert.equal(stored[0].capacity_reserved, 0);
});

test('D1: 0 survives the sheet door as 0 — tracked and empty, never NULL', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([preOrderCell({ capacity: '0' })]));
  assert.equal(cells(raw)[0].capacity, 0, '0 collapsed into untracked, which sells an unlimited number instead of none');
});

test('D1: a route quota is written to the route, and the pool it does not spend stays untracked', async () => {
  const { raw, app } = setup();
  await importSheet(
    app,
    sheet([preOrderCell({}), preOrderCell({ kind: 'air', capacity: '3' })])
  );
  assert.deepEqual(
    routes(raw).map((r) => [r.method, r.capacity]),
    [['air', 3]],
    'the per-route quota was dropped, so air takes unlimited pre-orders'
  );
  // One counter per sale: a route with its own quota does not also spend the
  // pool, and nothing copied 3 onto the cell.
  assert.equal(cells(raw)[0].capacity, null);
});

test('D1: an update moves the number and keeps the row id and the units already held', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([preOrderCell({ capacity: '5' })]));
  const before = cells(raw)[0];

  // A live pre-order takes one unit. `inventory_ledger.scope_id` names THIS
  // row, so a save that mints a new id strands the hold for ever.
  raw.prepare('UPDATE product_option_fulfillment SET capacity_reserved = 1 WHERE id = ?').run(before.id);

  const res = await importSheet(app, sheet([preOrderCell({ capacity: '7' })]));
  assert.equal(res.summary.updated, 1, JSON.stringify(res.rows));
  const after = cells(raw)[0];
  assert.equal(after.capacity, 7, 'the second sheet did not move the pool');
  assert.equal(after.id, before.id, 'the cell was re-inserted under a new id — the live hold now points at nothing');
  assert.equal(after.capacity_reserved, 1, 'the held unit was zeroed by a re-import and can never be released');
});

test('D1: a sheet with no fulfillment row leaves the stored cells exactly as they are', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([preOrderCell({ capacity: '4' })]));
  const before = cells(raw);

  await importSheet(app, sheet([]));
  assert.deepEqual(cells(raw), before, 'a price-only re-import destroyed a capacity it never mentioned');
});

test('D1: the preview and the door answer about the same counter when one is held', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([preOrderCell({ capacity: '5' })]));
  raw.prepare('UPDATE product_option_fulfillment SET capacity_reserved = 2').run();

  // Cutting the pool under the units already held: the door refuses it, so the
  // preview has to say so too. A preview that promises what the confirm will
  // refuse is worse than either answer alone.
  const csv = sheet([preOrderCell({ capacity: '1' })]);
  const prev = await preview(app, csv);
  const errors = prev.rows.flatMap((r: { errors: string[] }) => r.errors) as string[];
  assert.equal(errors.length, 1, `the preview promised an import the confirm refuses: ${JSON.stringify(prev.rows)}`);
  assert.match(errors[0], /2/, 'the refusal does not say how many units are held');

  const res = await confirm(app, prev.import_id);
  assert.equal(res.summary.updated, 0, 'the confirm wrote a capacity below the units already held');
  assert.equal(cells(raw)[0].capacity, 5, 'the stored pool moved anyway');
  assert.equal(cells(raw)[0].capacity_reserved, 2, 'the held units are gone and can never be released');
});

test('D1: __NULL__ untracks a pool the sheet owns, and the two are not the same word', async () => {
  const { raw, app } = setup();
  await importSheet(app, sheet([preOrderCell({ capacity: '6' })]));
  assert.equal(cells(raw)[0].capacity, 6);
  await importSheet(app, sheet([preOrderCell({ capacity: '__NULL__' })]));
  assert.equal(cells(raw)[0].capacity, null, 'the sheet could not give a pool back to untracked');
});

test('D1: a row that states only a quota does not switch a disabled order type back on', async () => {
  const { raw, app } = setup();
  // The owner turns the pre-order off in the sheet…
  await importSheet(app, sheet([preOrderCell({ active: 'no', capacity: '3' })]));
  assert.equal(cells(raw)[0].enabled, 0, JSON.stringify(cells(raw)));

  // …and later edits only the number, leaving `active` blank the way a
  // hand-written row does. Blank is "say nothing", exactly as it is for
  // `capacity`; the old fallback was `true`, which would sell a pre-order the
  // owner had deliberately stopped offering.
  await importSheet(app, sheet([preOrderCell({ active: '', capacity: '4' })]));
  const after = cells(raw)[0];
  assert.equal(after.enabled, 0, 'a blank cell switched a disabled order type back on');
  assert.equal(after.capacity, 4, 'and the number the row did state was not written');
});

// =====================================================================
//  D2 — __CLEAR__ IS A STATEMENT ABOUT THE LIST, NOT ABOUT A QUOTA
// =====================================================================

const HEAD = 'template_version=2\nname_en=A1 mini\nprice_iqd=499000\n';
const parse = (bodyText: string) => parseTemplate(HEAD + bodyText);

/** Stored: air with its own quota of 10, sea with 20. */
const storedTwoRoutes = () =>
  ({
    options: [
      {
        id: 'opt_mini',
        name_en: 'A1 mini',
        fulfillments: [
          {
            fulfillment_type: 'pre_order',
            enabled: true,
            capacity: null,
            transports: [
              { method: 'air', enabled: true, capacity: 10, surcharge_iqd: 80_000 },
              { method: 'sea', enabled: true, capacity: 20, surcharge_iqd: 30_000 },
            ],
          },
        ],
      },
    ],
  }) as unknown as Parameters<typeof toDocBody>[1];

const routesOf = (out: ReturnType<typeof toDocBody>) =>
  ((out.body.options as Array<Record<string, unknown>>)[0]!.fulfillments as Array<Record<string, unknown>>).find(
    (c) => c.fulfillment_type === 'pre_order'
  )!.transports as Array<Record<string, unknown>>;

const CLEARED = ['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.preorder.transports=__CLEAR__'];

test('D2: a route re-listed after __CLEAR__ keeps its own quota', () => {
  const out = toDocBody(
    parse([...CLEARED, 'options.1.preorder.transports.1.method=air'].join('\n')),
    storedTwoRoutes(),
    {}
  );
  assert.deepEqual(
    routesOf(out).map((r) => [r.method, r.capacity]),
    [['air', 10]],
    "air's independent quota was replaced by NULL — untracked, i.e. unlimited pre-orders on that route"
  );
  // And everything else it carried survives with it.
  assert.equal(routesOf(out)[0].surcharge_iqd, 80_000);
});

test('D2: __CLEAR__ still removes every route the same file does not name again', () => {
  const out = toDocBody(
    parse([...CLEARED, 'options.1.preorder.transports.1.method=air'].join('\n')),
    storedTwoRoutes(),
    {}
  );
  assert.deepEqual(routesOf(out).map((r) => r.method), ['air'], 'sea survived a clear that names it nowhere');

  const emptied = toDocBody(parse(CLEARED.join('\n')), storedTwoRoutes(), {});
  assert.deepEqual(routesOf(emptied), [], 'a bare clear no longer empties the list');
});

test('D2: the preview names what the clear removed instead of reporting nothing', () => {
  const out = toDocBody(
    parse([...CLEARED, 'options.1.preorder.transports.1.method=air'].join('\n')),
    storedTwoRoutes(),
    {}
  );
  assert.ok(
    out.cleared_fields.includes('options.1.preorder.transports'),
    `cleared_fields is the field that names what a file cleared, and it says nothing: ${JSON.stringify(out.cleared_fields)}`
  );
  assert.ok(
    out.warnings.some((w) => w.includes('sea')),
    `the route that was deleted is named nowhere in the preview: ${JSON.stringify(out.warnings)}`
  );
  assert.ok(
    !out.warnings.some((w) => w.includes('air')),
    'a route the file kept is reported as removed',
  );
});

test('D2: untracking a route is still available, and still has to be said out loud', () => {
  const out = toDocBody(
    parse(
      [...CLEARED, 'options.1.preorder.transports.1.method=air', 'options.1.preorder.transports.1.capacity=__NULL__'].join('\n')
    ),
    storedTwoRoutes(),
    {}
  );
  assert.deepEqual(routesOf(out).map((r) => [r.method, r.capacity]), [['air', null]]);
});

test('D2: removing the whole cell is named in cleared_fields too', () => {
  const out = toDocBody(
    parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.preorder=__CLEAR__'].join('\n')),
    storedTwoRoutes(),
    {}
  );
  assert.ok(
    out.cleared_fields.includes('options.1.preorder'),
    `a removed order type — and its whole pool — was reported nowhere: ${JSON.stringify(out.cleared_fields)}`
  );
});

// =====================================================================
//  D3 — A CAPACITY TYPED WHERE THE FORMAT HAS NONE IS REFUSED BY NAME
// =====================================================================

test('D3: options.N.capacity is refused by name, not dropped with a shrug', () => {
  const parsed = parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.capacity=44'].join('\n'));
  const hit = parsed.errors.find((e) => e.key === 'options.1.capacity');
  assert.ok(
    hit,
    `a capacity an admin typed on purpose was ignored: ${JSON.stringify({ errors: parsed.errors, unknown: parsed.unknown_keys })}`
  );
  assert.match(hit!.message, /options\.N\.preorder\.capacity/, 'the refusal does not name the key that carries the pool');
  assert.match(
    hit!.message,
    /options\.N\.preorder\.transports\.M\.capacity/,
    "the refusal does not name the key that carries one route's own quota"
  );
  assert.match(hit!.message, /options\.N\.stock/, 'the refusal does not name where direct-sale stock goes');
  assert.deepEqual(parsed.unknown_keys, [], 'it is still being dropped as an unknown key as well');
  assert.ok(hit!.line > 1, 'the refusal does not point at the line the admin typed');
});

test('D3: a capacity typed at the top of the file is refused too', () => {
  const parsed = parse('capacity=44\n');
  assert.ok(
    parsed.errors.some((e) => e.key === 'capacity'),
    `a product-level capacity is still dropped in silence: ${JSON.stringify(parsed.unknown_keys)}`
  );
});

test('D3: the two keys that DO carry a capacity are untouched', () => {
  const parsed = parse(
    [
      'options.1.id=opt_mini',
      'options.1.name_en=A1 mini',
      'options.1.preorder.capacity=12',
      'options.1.preorder.transports.1.method=air',
      'options.1.preorder.transports.1.capacity=3',
    ].join('\n')
  );
  assert.deepEqual(parsed.errors, [], JSON.stringify(parsed.errors));
  const out = toDocBody(parsed, storedTwoRoutes(), {});
  const cell = (out.body.options as Array<Record<string, unknown>>)[0]!
    .fulfillments as Array<Record<string, unknown>>;
  const pre = cell.find((x) => x.fulfillment_type === 'pre_order')!;
  assert.equal(pre.capacity, 12);
  assert.equal((pre.transports as Array<Record<string, unknown>>).find((t) => t.method === 'air')!.capacity, 3);
});

test('D3: the direct cell keeps its own refusal, which names the model stock', () => {
  const parsed = parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.direct.capacity=44'].join('\n'));
  const hit = parsed.errors.find((e) => e.key === 'options.1.direct.capacity');
  assert.ok(hit, JSON.stringify(parsed));
  assert.match(hit!.message, /options\.N\.stock/);
});

test('D3: a spec field that happens to be called capacity is still a spec field', () => {
  const parsed = parse('spec.capacity=220 L\n');
  assert.deepEqual(parsed.errors, [], JSON.stringify(parsed.errors));
  assert.equal(parsed.specFields.capacity?.value, '220 L');
});
