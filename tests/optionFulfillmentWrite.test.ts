/**
 * THE WRITE DOOR FOR ORDER TYPES, AND THE DOOR THE OLD SHAPE CANNOT COME BACK
 * THROUGH.
 *
 * Two doors, on purpose: `PUT /:id/relations` writes MODELS, `PUT
 * /:id/fulfillment` writes what each model DOES. That separation is what makes
 * the owner's first rule enforceable at the API instead of by convention —
 *
 *   "لا تنشئ Pre-order / Direct / Air / Sea / Land كـProduct Options."
 *
 * — because a structure payload has no field that could invent an order type,
 * and an order-type payload has no field that could invent a model.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import { availabilityFromName } from '../worker/lib/availability';
import {
  fulfillmentStatements,
  legacyShapeErrors,
  parseFulfillmentPayload,
  saleTypesFromCells,
} from '../worker/lib/optionFulfillment';
import { HttpError } from '../worker/lib/http';

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}

const OPTIONS = new Set(['m-mini', 'm-combo']);
const cell = (over: Record<string, unknown> = {}) => ({
  option_id: 'm-mini',
  fulfillment_type: 'direct_sale',
  regular_price_iqd: 549_000,
  ...over,
});

// --------------------------------------------------------------- VALIDATION

test('a cell naming a model that is not on this product is refused', () => {
  assert.throws(
    () => parseFulfillmentPayload({ fulfillments: [cell({ option_id: 'nope' })] }, OPTIONS),
    (e: unknown) => e instanceof HttpError && e.code === 'UNKNOWN_OPTION'
  );
});

test('one cell per (model, order type) — the unique index, said in a sentence', () => {
  assert.throws(
    () => parseFulfillmentPayload({ fulfillments: [cell(), cell()] }, OPTIONS),
    /already has a direct_sale cell/
  );
});

test('a direct sale carries no transport, because it has no journey', () => {
  assert.throws(
    () =>
      parseFulfillmentPayload(
        { fulfillments: [cell({ transports: [{ method: 'air' }] })] },
        OPTIONS
      ),
    (e: unknown) => e instanceof HttpError && e.code === 'TRANSPORT_ON_DIRECT'
  );
});

test('a route is air, sea or land — and never twice', () => {
  assert.throws(
    () =>
      parseFulfillmentPayload(
        { fulfillments: [cell({ fulfillment_type: 'pre_order', transports: [{ method: 'rocket' }] })] },
        OPTIONS
      ),
    /must be air, sea or land/
  );
  assert.throws(
    () =>
      parseFulfillmentPayload(
        {
          fulfillments: [
            cell({ fulfillment_type: 'pre_order', transports: [{ method: 'air' }, { method: 'air' }] }),
          ],
        },
        OPTIONS
      ),
    /air is listed twice/
  );
});

test('an empty money field means INHERIT and a zero means zero', () => {
  const [parsed] = parseFulfillmentPayload(
    { fulfillments: [cell({ regular_price_iqd: '', prime_price_iqd: 0, regular_adjust_iqd: -5000 })] },
    OPTIONS
  );
  assert.equal(parsed!.regular_price_iqd, null);
  assert.equal(parsed!.prime_price_iqd, 0);
  assert.equal(parsed!.regular_adjust_iqd, -5000, 'an adjustment may be negative; a price may not');
  assert.throws(() => parseFulfillmentPayload({ fulfillments: [cell({ regular_price_iqd: -1 })] }, OPTIONS), /whole number/);
});

test('a lead time that ends before it starts is refused', () => {
  assert.throws(
    () =>
      parseFulfillmentPayload(
        { fulfillments: [cell({ fulfillment_type: 'pre_order', lead_time_min_days: 30, lead_time_max_days: 7 })] },
        OPTIONS
      ),
    /cannot be longer than/
  );
});

// ------------------------------------------------------------------ WRITING

test('a save REPLACES the product cells, and a removed cell is really gone', async () => {
  const raw = schema();
  raw.exec(`
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p','a1','A1',499000);
    INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g','p','Model');
    INSERT INTO product_option_values (id,product_id,group_id,name_en) VALUES ('m-mini','p','g','A1 mini');
    INSERT INTO product_option_values (id,product_id,group_id,name_en) VALUES ('m-combo','p','g','A1 mini Combo');
  `);
  const db = new SqliteD1(raw) as unknown as { prepare(sql: string): D1PreparedStatement; batch(s: D1PreparedStatement[]): Promise<unknown[]> };
  let n = 0;
  const ids = () => `id-${++n}`;

  const first = parseFulfillmentPayload(
    {
      fulfillments: [
        { option_id: 'm-mini', fulfillment_type: 'direct_sale', regular_price_iqd: 549_000 },
        {
          option_id: 'm-mini',
          fulfillment_type: 'pre_order',
          lead_time_text: '١٤ يوم',
          transports: [
            { method: 'air', surcharge_iqd: 80_000 },
            { method: 'sea', surcharge_iqd: 20_000, enabled: false },
          ],
        },
      ],
    },
    OPTIONS
  );
  await db.batch(fulfillmentStatements(db, 'p', first, ids));

  const cells = raw.prepare('SELECT option_id, fulfillment_type FROM product_option_fulfillment ORDER BY fulfillment_type').all();
  assert.equal(cells.length, 2);
  const routes = raw.prepare('SELECT method, surcharge_iqd, enabled FROM product_option_transports ORDER BY method').all() as Array<Record<string, unknown>>;
  assert.deepEqual(routes.map((r) => [r.method, r.surcharge_iqd, r.enabled]), [
    ['air', 80_000, 1],
    ['sea', 20_000, 0],
  ]);

  // Saving only the direct cell removes the pre-order cell AND its routes —
  // a replacement is the only shape that lets a cell be deleted at all.
  const second = parseFulfillmentPayload(
    { fulfillments: [{ option_id: 'm-mini', fulfillment_type: 'direct_sale', regular_price_iqd: 560_000 }] },
    OPTIONS
  );
  await db.batch(fulfillmentStatements(db, 'p', second, ids));
  assert.equal((raw.prepare('SELECT * FROM product_option_fulfillment').all() as unknown[]).length, 1);
  assert.equal((raw.prepare('SELECT * FROM product_option_transports').all() as unknown[]).length, 0);
  assert.equal(
    (raw.prepare('SELECT regular_price_iqd AS p FROM product_option_fulfillment').get() as { p: number }).p,
    560_000
  );
});

test('the product sale types are DERIVED from what its models offer', () => {
  const values = [
    { id: 'm-mini', merged_into: '' },
    { id: 'm-combo', merged_into: '' },
    { id: 'm-old', merged_into: 'm-mini' },
  ] as never;

  assert.deepEqual(
    saleTypesFromCells(values, parseFulfillmentPayload({ fulfillments: [cell()] }, OPTIONS), ['pre_order']),
    ['direct_sale']
  );
  assert.deepEqual(
    saleTypesFromCells(
      values,
      parseFulfillmentPayload(
        { fulfillments: [cell(), cell({ fulfillment_type: 'pre_order' })] },
        OPTIONS
      ),
      ['pre_order']
    ),
    ['direct_sale', 'pre_order']
  );
  // A disabled cell is not an offer, and with nothing offered the product keeps
  // what it had rather than becoming unsellable.
  assert.deepEqual(
    saleTypesFromCells(values, parseFulfillmentPayload({ fulfillments: [cell({ enabled: false })] }, OPTIONS), ['pre_order']),
    ['pre_order']
  );
});

// -------------------------------------------------- THE OLD SHAPE IS BLOCKED

const existingNone = new Map<string, { name_en: string; variant_key: string }>();

test('two NEW models sharing a variant_key are refused — that is the old shape', () => {
  const errors = legacyShapeErrors(
    [
      { id: 'a', name_en: 'A1 mini', variant_key: 'a1-mini', active: 1 },
      { id: 'b', name_en: 'A1 mini too', variant_key: 'a1-mini', active: 1 },
    ],
    existingNone,
    availabilityFromName
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /one model/);
});

test('a NEW option named as an order type is refused', () => {
  for (const name of ['A1 mini — Pre-order', 'A1 mini - Direct Sale', 'A1 mini (طلب مسبق)']) {
    const errors = legacyShapeErrors([{ id: 'a', name_en: name, variant_key: '', active: 1 }], existingNone, availabilityFromName);
    assert.equal(errors.length, 1, `${name} should be refused`);
    assert.match(errors[0]!, /order type is not a product option/);
  }
});

test('an ordinary model name is not refused', () => {
  for (const name of ['A1 mini', 'A1 mini Combo', '0.4mm Nozzle', 'أسود']) {
    assert.deepEqual(
      legacyShapeErrors([{ id: 'a', name_en: name, variant_key: 'k', active: 1 }], existingNone, availabilityFromName),
      [],
      `${name} should be allowed`
    );
  }
});

test('an UNTOUCHED legacy product stays editable — this blocks a shape, not a catalogue', () => {
  const existing = new Map([
    ['a', { name_en: 'A1 mini — Pre-order', variant_key: 'a1-mini' }],
    ['b', { name_en: 'A1 mini — Direct', variant_key: 'a1-mini' }],
  ]);
  const unchanged = legacyShapeErrors(
    [
      { id: 'a', name_en: 'A1 mini — Pre-order', variant_key: 'a1-mini', active: 1 },
      { id: 'b', name_en: 'A1 mini — Direct', variant_key: 'a1-mini', active: 1 },
    ],
    existing,
    availabilityFromName
  );
  assert.deepEqual(unchanged, [], 'saving an old product without touching its models must still work');

  // But ADDING a third row to that duplicate group is creating the old shape.
  const added = legacyShapeErrors(
    [
      { id: 'a', name_en: 'A1 mini — Pre-order', variant_key: 'a1-mini', active: 1 },
      { id: 'b', name_en: 'A1 mini — Direct', variant_key: 'a1-mini', active: 1 },
      { id: 'c', name_en: 'A1 mini — Air', variant_key: 'a1-mini', active: 1 },
    ],
    existing,
    availabilityFromName
  );
  assert.equal(added.length, 1);
});

test('an INACTIVE row is not a model, so it cannot make a duplicate', () => {
  assert.deepEqual(
    legacyShapeErrors(
      [
        { id: 'a', name_en: 'A1 mini', variant_key: 'a1-mini', active: 1 },
        { id: 'b', name_en: 'A1 mini old', variant_key: 'a1-mini', active: 0 },
      ],
      existingNone,
      availabilityFromName
    ),
    []
  );
});
