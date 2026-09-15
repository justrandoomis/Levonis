/**
 * THE FOUR SURFACES 0075 LEFT UNGUARDED.
 *
 * Migration 0075 gave a (model x pre_order) cell an OPTIONAL capacity and each
 * of its routes an optional quota. The counters themselves are pinned by
 * tests/stockByOrderType.test.ts. This file pins the four places the counters
 * REACH A HUMAN — a cart screen, a refusal sentence, a TXT import preview and
 * a spreadsheet import preview — because every one of them was green while
 * telling the reader something that is not true:
 *
 *  S1. THE CART READ PATH. `loadCart` passed the stated order type and the
 *      capacity snapshot to `saleAvailability` but never applied
 *      `unusableOrderType`, which the add and patch doors both apply. So a
 *      line stored as `pre_order` whose quota had filled up came back as
 *      mode "direct_sale", reason null, with the SHELF's count and the shelf's
 *      ceiling — no warning on the screen, a `+` button offering to raise the
 *      quantity to a number of units that line will never be sold from, and a
 *      customer who finds out at the checkout.
 *
 *  S2. THE ONLY CUSTOMER-FACING REFUSAL THIS WORK ADDS.
 *      `PREORDER_CAPACITY_EXHAUSTED` never reached `REFUSAL_STRINGS`, so
 *      `apiRefusal` fell through to the server's untranslated English on the
 *      cart and the checkout while the product page showed its own Arabic.
 *      In an Arabic-first shop the one sentence a customer must NOT read as
 *      "sold out" was the one printing in English.
 *
 *  S3. THE TXT IMPORTER DESTROYING A ROUTE. `buildCells` replaced the
 *      transports list wholesale, so a file naming air alone DELETED sea and
 *      land — with `{ success: true, warnings: [] }`. Before 0075 that lost a
 *      price; since 0075 it destroys an independent route quota, which is the
 *      only thing between that route and unlimited pre-orders.
 *
 *  S4. THE SHEET DROPPING A QUOTA IN SILENCE. `capacity` is a BASE column, so
 *      it is a legal cell on every row type, but it is read in one branch
 *      only. Typed on the `option` row — the row where `stock` lives — it
 *      vanished with no issue at all, while the TXT format refuses the
 *      analogous mistake by name.
 *
 * Run: npx tsx --test tests/stockCapacitySurfaces.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asD1, freshDb, stubApp, get, post, json, row, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { cartRoutes } from '../worker/routes/cart';
import { REFUSAL_STRINGS, apiRefusal } from '../src/lib/refusalStrings';
import { parseTemplate, toDocBody } from '../worker/lib/template';
import { BASE_COLUMNS, parseImport, templateShape } from '../worker/lib/importCsv';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown) => stubApp(db, buyer, (a) => a.route('/api/cart', cartRoutes));

// =====================================================================
//  S1 — THE CART READ PATH KEEPS THE LINE'S OWN ORDER TYPE
// =====================================================================
//
// One model, both order types: a healthy shelf and a pre-order pool of one.
// That is the smallest shop in which "the quota filled up while the line sat
// in the basket" is a sentence — and in which the descriptive fallback has
// somewhere to fall TO.

function seedShop(o: { stock?: number | null; pool?: number | null } = {}): DatabaseSync {
  const { stock = 7, pool = 1 } = o;
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'direct_sale','["direct_sale","pre_order"]',
            '[{"method":"air","active":true,"commission_iqd":7500},
              {"method":"sea","active":true,"commission_iqd":3000}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,${stock === null ? 'NULL' : stock},0);
    INSERT INTO product_option_fulfillment (id,product_id,option_id,fulfillment_type,enabled,capacity)
      VALUES ('f_direct','p_a1','v_mini','direct_sale',1,NULL),
             ('f_pre','p_a1','v_mini','pre_order',1,${pool === null ? 'NULL' : pool});
    INSERT INTO product_option_transports (id,product_id,fulfillment_id,method,enabled,capacity) VALUES
      ('t_air','p_a1','f_pre','air',1,NULL),
      ('t_sea','p_a1','f_pre','sea',1,NULL);
  `);
  raw.prepare("INSERT INTO admin_settings (key, value) VALUES ('shippingPolicy', ?)").run(JSON.stringify({ ordinary_iqd: 5000 }));
  return raw;
}

interface CartLine {
  qty: number;
  availability: {
    mode: string;
    reason: string | null;
    stock: { available: number | null; max_qty: number };
    preorder: { capacity: { tracked: boolean; available: number | null; max_qty: number } };
    qty_ok: boolean;
  };
}

const readCart = async (db: unknown): Promise<CartLine[]> =>
  ((await json(await get(appFor(db), '/api/cart'))).items ?? []) as CartLine[];

/** The quota fills up BEHIND the customer while their line sits in the basket:
 *  somebody else's order took the last place. Nothing about their row changes. */
const someoneElseTakesTheLastPlace = (raw: DatabaseSync) =>
  raw.exec("UPDATE product_option_fulfillment SET capacity_reserved = capacity WHERE id = 'f_pre'");

test('a pre-order line whose quota filled up is still a PRE-ORDER when the cart is read', async () => {
  const raw = seedShop({ stock: 7, pool: 1 });
  const db = asD1(raw);

  const added = await json(
    await post(appFor(db), '/api/cart/items', {
      productId: 'p_a1', qty: 1, optionId: 'v_mini', fulfillmentType: 'pre_order', transportMethod: 'air',
    })
  );
  assert.equal(added.success, true, JSON.stringify(added));

  someoneElseTakesTheLastPlace(raw);
  // The stored line is untouched — this is a READ defect, not a write one.
  assert.equal(
    row<{ fulfillment_type: string }>(raw, 'SELECT fulfillment_type FROM cart_items WHERE user_id = ?', 'buyer')!.fulfillment_type,
    'pre_order'
  );

  const [line] = await readCart(db);
  const a = line.availability;

  // WITHOUT THE FIX this read `direct_sale` / null / 7 / 7: the descriptive
  // fallback re-typed the line and published the shelf as its ceiling.
  assert.equal(a.mode, 'preorder', 'the read path re-typed a stored pre-order as a direct sale');
  assert.equal(a.reason, 'PREORDER_CAPACITY_EXHAUSTED', 'the line reports no reason at all');
  assert.equal(a.qty_ok, false, 'the quantity in the basket is still reported as fine');

  // The counter that actually limits the line is the one the cart reads for a
  // pre-order line, and it says zero.
  assert.equal(a.preorder.capacity.tracked, true);
  assert.equal(a.preorder.capacity.available, 0, 'the pre-order quota is full');
  assert.equal(a.preorder.capacity.max_qty, 0);

  // The shelf is NOT rewritten — it really does hold seven — but it is not
  // what this line may be bought from, so the published ceiling is zero and
  // the `+` button (which reads exactly this) cannot offer the shelf's count.
  assert.equal(a.stock.available, 7, 'the shelf is a fact and is not zeroed to mean "sold out"');
  assert.equal(a.stock.max_qty, 0, 'the cart still offers to raise this line to the SHELF count');
});

test('the same guard, inverted: a stored direct sale is not re-described as a pre-order', async () => {
  // Nothing left on the shelf, pre-order wide open — the fallback's other
  // direction, and the same defect: a customer who pressed "buy now" would be
  // shown an import quota, with its different price, wait and counter.
  const raw = seedShop({ stock: 2, pool: null });
  const db = asD1(raw);

  const added = await json(
    await post(appFor(db), '/api/cart/items', {
      productId: 'p_a1', qty: 1, optionId: 'v_mini', fulfillmentType: 'direct_sale',
    })
  );
  assert.equal(added.success, true, JSON.stringify(added));

  raw.exec("UPDATE product_option_values SET stock = 0 WHERE id = 'v_mini'");

  const [line] = await readCart(db);
  assert.equal(line.availability.mode, 'direct_sale', 'a stored direct sale became a pre-order on the read path');
  assert.equal(line.availability.reason, 'OUT_OF_STOCK');
  assert.equal(line.availability.stock.max_qty, 0);
  assert.equal(line.availability.qty_ok, false);
});

test('a line whose stated type is still usable is left exactly as it was', async () => {
  const raw = seedShop({ stock: 7, pool: 3 });
  const db = asD1(raw);
  await post(appFor(db), '/api/cart/items', {
    productId: 'p_a1', qty: 1, optionId: 'v_mini', fulfillmentType: 'pre_order', transportMethod: 'air',
  });

  const [line] = await readCart(db);
  assert.equal(line.availability.mode, 'preorder');
  assert.equal(line.availability.reason, null, 'a healthy line must not carry a refusal');
  assert.equal(line.availability.preorder.capacity.available, 3);
  assert.equal(line.availability.stock.max_qty, 3, 'the pre-order ceiling, not the shelf and not zero');
  assert.equal(line.availability.qty_ok, true);
});

// =====================================================================
//  S2 — THE REFUSAL IS A SENTENCE, IN THE CUSTOMER'S LANGUAGE
// =====================================================================

/** Verbatim from `worker/routes/products.ts` — what the server actually sends. */
const SERVER_SENTENCE = 'The pre-order quota for this selection is full.';

test('PREORDER_CAPACITY_EXHAUSTED has an ar, an en and a ckb sentence', () => {
  const entry = REFUSAL_STRINGS.PREORDER_CAPACITY_EXHAUSTED;
  assert.ok(entry, 'the only customer-facing code 0075 adds is not in the table at all');
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(typeof entry[lang], 'string');
    assert.ok(entry[lang].trim().length > 0, `${lang} is empty`);
    assert.notEqual(entry[lang], 'PREORDER_CAPACITY_EXHAUSTED', `${lang} is the bare identifier`);
    assert.ok(!/[A-Z]{3,}_[A-Z]/.test(entry[lang]), `${lang} leaks a machine code into a sentence`);
  }
  // Arabic is Arabic, and it is not the English pasted across.
  assert.match(entry.ar, /[؀-ۿ]/, 'the Arabic sentence carries no Arabic');
  assert.notEqual(entry.ar, entry.en);
  // The customer must be able to tell this apart from an empty shelf: the
  // whole reason this code exists rather than reusing OUT_OF_STOCK.
  assert.match(entry.en, /pre-order/i, 'the English never says which counter ran out');
  assert.ok(
    entry.ar.includes('الطلب المسبق'),
    'the Arabic never names the pre-order quota, so it reads as "sold out"'
  );
});

test('the Sorani is the Arabic, not an invention, and it says so', () => {
  const entry = REFUSAL_STRINGS.PREORDER_CAPACITY_EXHAUSTED;
  assert.equal(
    entry.ckb,
    entry.ar,
    'the Kurdish for this sentence is the owner’s to write by hand; until then the ckb slot carries the ARABIC'
  );
  // And the file says why, where the next person to touch it will read it.
  const src = readFileSync(join(ROOT, 'src/lib/refusalStrings.ts'), 'utf8');
  const from = src.indexOf('PREORDER_CAPACITY_EXHAUSTED: {');
  assert.ok(from > 0);
  assert.match(
    src.slice(from, src.indexOf('},', from)),
    /NO SORANI IS INVENTED HERE/,
    'the ckb fallback is undocumented, so the next writer will "fix" it with a machine translation'
  );
});

test('apiRefusal answers the refusal in Arabic instead of the server’s English', () => {
  const err = { code: 'PREORDER_CAPACITY_EXHAUSTED', message: SERVER_SENTENCE };
  // This is the exact call the cart and the checkout make.
  assert.equal(apiRefusal(err, 'ar'), REFUSAL_STRINGS.PREORDER_CAPACITY_EXHAUSTED.ar);
  assert.equal(apiRefusal(err, 'ckb'), REFUSAL_STRINGS.PREORDER_CAPACITY_EXHAUSTED.ckb);
  assert.notEqual(apiRefusal(err, 'ar'), SERVER_SENTENCE, 'an Arabic customer still reads the English sentence');
  assert.notEqual(apiRefusal(err, 'ckb'), SERVER_SENTENCE, 'a Kurdish customer still reads the English sentence');
});

// =====================================================================
//  S3 — A ROUTE THE TXT FILE DOES NOT NAME IS PRESERVED
// =====================================================================

const HEAD = 'template_version=2\nname_en=A1 mini\nprice_iqd=499000\n';
const parse = (body: string) => parseTemplate(HEAD + body);

/** Stored: three priced routes, each with its own independent quota. */
const storedThreeRoutes = () =>
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
              { method: 'land', enabled: true, capacity: 5, surcharge_iqd: 20_000 },
            ],
          },
        ],
      },
    ],
  }) as unknown as Parameters<typeof toDocBody>[1];

const routesOf = (out: ReturnType<typeof toDocBody>) =>
  ((out.body.options as Array<Record<string, unknown>>)[0]!.fulfillments as Array<Record<string, unknown>>)
    .find((c) => c.fulfillment_type === 'pre_order')!.transports as Array<Record<string, unknown>>;

test('a file naming only air keeps sea and land, with their quotas intact', () => {
  const out = toDocBody(
    parse(
      [
        'options.1.id=opt_mini',
        'options.1.name_en=A1 mini',
        'options.1.preorder.transports.1.method=air',
        'options.1.preorder.transports.1.capacity=12',
      ].join('\n')
    ),
    storedThreeRoutes(),
    {}
  );
  const routes = routesOf(out);
  assert.deepEqual(
    routes.map((r) => [r.method, r.capacity]),
    [['air', 12], ['sea', 20], ['land', 5]],
    'a route the file does not name was DELETED, taking its independent quota with it'
  );
  // The unnamed routes keep everything, not just their method.
  assert.equal(routes.find((r) => r.method === 'sea')!.surcharge_iqd, 30_000);
  assert.equal(routes.find((r) => r.method === 'land')!.enabled, true);
  // And nothing was copied onto them: only air moved.
  assert.equal(routes.find((r) => r.method === 'air')!.surcharge_iqd, 80_000, 'the named route kept its unmentioned fields');
});

test('a quota is never auto-copied onto the routes the file did not mention', () => {
  const routes = routesOf(
    toDocBody(
      parse(
        [
          'options.1.id=opt_mini',
          'options.1.name_en=A1 mini',
          'options.1.preorder.transports.1.method=air',
          'options.1.preorder.transports.1.capacity=99',
        ].join('\n')
      ),
      storedThreeRoutes(),
      {}
    )
  );
  assert.deepEqual(routes.filter((r) => r.method !== 'air').map((r) => r.capacity), [20, 5]);
});

test('__CLEAR__ on the list is how routes are removed, and it is the only way', () => {
  // The owner's explicit statement: drop every stored route, keep the one the
  // same file names. "The file did not mention it" and "the owner deleted it"
  // stay two different things.
  const out = toDocBody(
    parse(
      [
        'options.1.id=opt_mini',
        'options.1.name_en=A1 mini',
        'options.1.preorder.transports=__CLEAR__',
        'options.1.preorder.transports.1.method=air',
        'options.1.preorder.transports.1.capacity=12',
      ].join('\n')
    ),
    storedThreeRoutes(),
    {}
  );
  assert.deepEqual(routesOf(out).map((r) => [r.method, r.capacity]), [['air', 12]]);

  // With nothing named after it, every route goes.
  const emptied = toDocBody(
    parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.preorder.transports=__CLEAR__'].join('\n')),
    storedThreeRoutes(),
    {}
  );
  assert.deepEqual(routesOf(emptied), []);

  // A bare `transports=<something else>` is named as a mistake rather than
  // dropped into unknown_keys, which is how the loss stayed invisible before.
  const wrong = parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.preorder.transports=air'].join('\n'));
  assert.ok(
    wrong.errors.some((e) => e.key === 'options.1.preorder.transports'),
    `expected the bare list key to be refused, got ${JSON.stringify(wrong.errors)} / ${JSON.stringify(wrong.unknown_keys)}`
  );
  assert.deepEqual(wrong.unknown_keys, []);
});

test('a file that mentions no route at all still leaves all three alone', () => {
  const out = toDocBody(
    parse(['options.1.id=opt_mini', 'options.1.name_en=A1 mini', 'options.1.preorder.capacity=4'].join('\n')),
    storedThreeRoutes(),
    {}
  );
  assert.deepEqual(routesOf(out).map((r) => r.method), ['air', 'sea', 'land']);
});

// =====================================================================
//  S4 — THE SHEET REFUSES A CAPACITY ON THE WRONG ROW, BY NAME
// =====================================================================

const shape = () => templateShape('printer');

/** One product, one model, plus whatever extra rows a case needs. */
function sheet(rows: Array<Record<string, string>>): string {
  const cols = [...BASE_COLUMNS];
  const line = (r: Record<string, string>) =>
    cols.map((c) => (r[c] ?? '').replace(/"/g, '""')).map((v) => (/[",\n]/.test(v) ? `"${v}"` : v)).join(',');
  return [
    cols.join(','),
    line({ row_type: 'product', key: 'A1-MINI', name: 'A1 mini', price_iqd: '499000', sale_types: 'pre_order' }),
    line({ row_type: 'option', key: 'A1-MINI', group: 'Model', value: 'A1 mini', stock: '12' }),
    ...rows.map(line),
  ].join('\n');
}

const capacityIssues = (csv: string) =>
  parseImport(csv, shape()).issues.filter((i) => i.severity === 'error' && /capacity/.test(i.message));

test('capacity typed on an option row is refused by name, not dropped', () => {
  // The likeliest mistake there is: `stock` lives on this row, so this is
  // where an admin reaches for "how many may I pre-order".
  const csv = [
    ...sheet([]).split('\n').slice(0, 2),
    [...BASE_COLUMNS]
      .map((c) =>
        c === 'row_type' ? 'option'
        : c === 'key' ? 'A1-MINI'
        : c === 'group' ? 'Model'
        : c === 'value' ? 'A1 mini'
        : c === 'stock' ? '12'
        : c === 'capacity' ? '30'
        : ''
      )
      .join(','),
  ].join('\n');

  const hits = capacityIssues(csv);
  assert.equal(hits.length, 1, `a capacity on an option row was silently dropped: ${JSON.stringify(parseImport(csv, shape()).issues)}`);
  assert.match(hits[0].message, /option/, 'the refusal does not name the row the admin typed it on');
  assert.match(hits[0].message, /fulfillment/, 'the refusal does not name the row that carries a pre-order capacity');
  assert.match(hits[0].message, /stock/, 'the refusal does not name the column that carries direct-sale stock');
  // And it is not an unknown column — the column is legal, the ROW is wrong.
  assert.deepEqual(parseImport(csv, shape()).unknownColumns, []);
});

test('capacity typed on a product row is refused too', () => {
  const csv = [
    [...BASE_COLUMNS].join(','),
    [...BASE_COLUMNS]
      .map((c) =>
        c === 'row_type' ? 'product'
        : c === 'key' ? 'A1-MINI'
        : c === 'name' ? 'A1 mini'
        : c === 'price_iqd' ? '499000'
        : c === 'sale_types' ? 'pre_order'
        : c === 'capacity' ? '30'
        : ''
      )
      .join(','),
  ].join('\n');
  const hits = capacityIssues(csv);
  assert.equal(hits.length, 1, 'a capacity on a product row is still dropped in silence');
  assert.match(hits[0].message, /product/);
});

test('the fulfillment row — the one that owns the column — is untouched', () => {
  const csv = sheet([
    { row_type: 'fulfillment', key: 'A1-MINI', links: 'Model:A1 mini', value: 'pre_order', active: 'yes', capacity: '30' },
  ]);
  const out = parseImport(csv, shape());
  assert.deepEqual(out.issues.filter((i) => i.severity === 'error'), []);
  assert.equal(out.products[0]!.fulfillments![0]!.capacity, 30);

  // An empty capacity cell on every other row stays exactly what it was:
  // silence, not a refusal. The guard must not fire on a blank sheet.
  const quiet = parseImport(sheet([]), shape());
  assert.deepEqual(quiet.issues.filter((i) => i.severity === 'error'), []);
});
