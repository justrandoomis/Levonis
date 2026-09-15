/**
 * A WHOLE-PRODUCT SAVE MAY NOT STRAND A PRE-ORDER HOLD (0075).
 *
 * `fulfillmentStatements` is a delete-then-insert replace, which is correct:
 * a cell's SETTINGS have no identity a customer sees — it IS (model, order
 * type). Its HELD UNITS do, and so does its row id: `inventory_ledger.scope_id`
 * names the `product_option_fulfillment` / `product_option_transports` row that
 * a live pre-order reserved against. Mint a new id on save and the release for
 * that order matches nothing — the units are never given back, and no screen
 * can show where they went.
 *
 * The admin fulfilment door (`PUT /:id/fulfillment`) passes the surviving rows
 * so ids and `capacity_reserved` carry across. `planProductSave` — the door a
 * TXT import comes through, and the one that rewrites a whole catalogue at once
 * — is the other caller, and it is the dangerous one precisely because nobody
 * is watching a bulk import row by row. This file pins that BOTH doors preserve
 * the hold, by exercising the real planner against the real migrations.
 *
 * Written against the failure, not the fix: the first test asserts the row id
 * and the held count are the SAME objects after a save that rewrites the cell's
 * settings. Before the wiring existed, both changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, row, all } from './fixtures/app';
import { planProductSave, saveProductAtomic } from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';
import { existingCellsFrom, fulfillmentStatements } from '../worker/lib/optionFulfillment';

/**
 * One product, one model, a pre-order cell with a pool of 5 of which 2 are
 * HELD, and a `land` route with its own quota of 3 of which 1 is held. Both
 * counters carry a hold, because the cell and the route are separate rows and
 * a fix that saved only one of them would still lose units.
 */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','B','b@x.co','h','admin');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,inventory_mode,ops_policy)
    VALUES ('p_a1','a1','A1','ايه1','ئەی١',500000,'active',NULL,'[]','[]',
            'pre_order','["pre_order"]',
            '[{"method":"land","active":true,"commission_iqd":2000}]',
            '["https://cdn/a1.png"]','OPTION','{}');
    INSERT INTO product_option_groups (id,product_id,name_en,sort,active) VALUES ('g_m','p_a1','Model',0,1);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,sort,active,stock,reserved)
      VALUES ('v_mini','p_a1','g_m','A1 mini','ايه1 ميني',0,1,4,0);
    INSERT INTO product_option_fulfillment
      (id,product_id,option_id,fulfillment_type,enabled,capacity,capacity_reserved)
      VALUES ('f_pre','p_a1','v_mini','pre_order',1,5,2);
    INSERT INTO product_option_transports
      (id,product_id,fulfillment_id,method,enabled,capacity,capacity_reserved)
      VALUES ('t_land','p_a1','f_pre','land',1,3,1);
  `);
  return raw;
}

const cells = (raw: DatabaseSync) =>
  all<{ id: string; option_id: string; fulfillment_type: string; capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT id, option_id, fulfillment_type, capacity, capacity_reserved FROM product_option_fulfillment ORDER BY id'
  );
const routes = (raw: DatabaseSync) =>
  all<{ id: string; method: string; capacity: number | null; capacity_reserved: number }>(
    raw,
    'SELECT id, method, capacity, capacity_reserved FROM product_option_transports ORDER BY id'
  );

/** The wire body the TXT import path sends: models live under groups[].values[],
 *  and a model's order types ride on its `fulfillments` key. */
const relationsBody = (over: { capacity?: number | null; routeCapacity?: number | null } = {}) => ({
  inventory_mode: 'OPTION',
  groups: [
    {
      id: 'g_m',
      name_en: 'Model',
      sort: 0,
      active: true,
      values: [
        {
          id: 'v_mini',
          name_en: 'A1 mini',
          sort: 0,
          active: true,
          stock: 4,
          availability_type: 'pre_order',
          // The settings that CHANGE across the save, to prove the replace
          // really ran rather than being skipped as a no-op.
          lead_time_text: 'ships in about a month',
          fulfillments: [
            {
              fulfillment_type: 'pre_order',
              enabled: true,
              capacity: over.capacity === undefined ? 5 : over.capacity,
              transports: [
                {
                  method: 'land',
                  enabled: true,
                  surcharge_iqd: 2000,
                  capacity: over.routeCapacity === undefined ? 3 : over.routeCapacity,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  colors: [],
  variants: [],
});

async function save(raw: DatabaseSync, body: Record<string, unknown>) {
  const db = asD1(raw);
  // The SAME intent `PUT /:id/relations` builds — a relations-only update
  // whose `prev` is the stored row, so the planner sees the real product.
  const stored = row<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', 'p_a1')!;
  const plan = await planProductSave(db, {
    mode: 'update',
    doc: null,
    prev: parseProductRow(stored),
    relations: body,
    actor: { adminId: 'boss', money: true },
  });
  await saveProductAtomic(db, plan);
}

test('a whole-product save keeps the pre-order cell row id and its held units', async () => {
  const raw = seed();
  const before = cells(raw)[0];
  assert.equal(before.capacity_reserved, 2, 'the fixture must actually be holding units');

  await save(raw, relationsBody());

  const after = cells(raw);
  assert.equal(after.length, 1, 'the replace leaves exactly the one cell the payload described');
  assert.equal(
    after[0].id,
    before.id,
    'a NEW row id would orphan every inventory_ledger row whose scope_id names the old one'
  );
  assert.equal(after[0].capacity_reserved, 2, 'the hold is the reservation itself, never a setting a save may reset');
  assert.equal(after[0].capacity, 5, 'and the capacity the payload asked for is what is stored');
});

test('a whole-product save keeps a transport route row id and its held units', async () => {
  const raw = seed();
  const before = routes(raw)[0];

  await save(raw, relationsBody());

  const after = routes(raw);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before.id, "the route is a counter of its own — its id is a ledger scope_id too");
  assert.equal(after[0].capacity_reserved, 1);
  assert.equal(after[0].capacity, 3);
});

test('the save still WRITES the settings it was given — the id is kept, the row is not frozen', async () => {
  const raw = seed();
  await save(raw, relationsBody({ capacity: 9, routeCapacity: 4 }));

  assert.equal(cells(raw)[0].capacity, 9, 'a raised pool is stored');
  assert.equal(cells(raw)[0].capacity_reserved, 2, 'and the hold rides across it unchanged');
  assert.equal(routes(raw)[0].capacity, 4);
  assert.equal(routes(raw)[0].capacity_reserved, 1);
});

test('a ledger row written before the save still names a row that exists after it', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO inventory_ledger (id,product_id,scope,scope_id,kind,qty,order_id,idempotency_key,reason)
    VALUES ('l1','p_a1','preorder','f_pre','reserve',2,'o_1','reserve:o_1:f_pre','checkout'),
           ('l2','p_a1','preorder_transport','t_land','reserve',1,'o_2','reserve:o_2:t_land','checkout');
  `);

  await save(raw, relationsBody());

  // THE WHOLE POINT, stated as the join that would return nothing if the ids
  // had moved: every hold in the journal must still resolve to a live counter.
  const orphans = all<{ scope: string; scope_id: string }>(
    raw,
    `SELECT l.scope, l.scope_id FROM inventory_ledger l
      WHERE (l.scope = 'preorder'
              AND NOT EXISTS (SELECT 1 FROM product_option_fulfillment f WHERE f.id = l.scope_id))
         OR (l.scope = 'preorder_transport'
              AND NOT EXISTS (SELECT 1 FROM product_option_transports t WHERE t.id = l.scope_id))`
  );
  assert.deepEqual(orphans, [], 'a release for these orders must still find the counter it has to give back to');
});

test('a save that does NOT mention fulfillments leaves the cells, and their holds, alone', async () => {
  const raw = seed();
  const before = { cells: cells(raw), routes: routes(raw) };

  const body = relationsBody() as Record<string, unknown>;
  // 0073: the FORM never sends this key, and a payload that is silent about
  // order types must not be read as "delete them all".
  delete ((body.groups as Array<{ values: Array<Record<string, unknown>> }>)[0].values[0]).fulfillments;
  await save(raw, body);

  assert.deepEqual(cells(raw), before.cells);
  assert.deepEqual(routes(raw), before.routes);
});

test('a FILE may not cut a capacity below the units already held', async () => {
  const raw = seed();
  // The cell holds 2; the file asks for 1. The admin panel has refused this
  // since 0075 landed; the template and CSV doors reach the same rows through
  // planProductSave, and nobody reads a spreadsheet row by row.
  await assert.rejects(
    () => save(raw, relationsBody({ capacity: 1 })),
    (e: Error & { code?: string }) => e.code === 'CAPACITY_BELOW_RESERVED',
    'a quota below the hold makes available negative, and the deduct at confirmation then matches nothing'
  );
  assert.equal(cells(raw)[0].capacity, 5, 'and the refusal leaves the stored quota exactly as it was');
});

test('a FILE may not drop a route that is holding units', async () => {
  const raw = seed();
  const body = relationsBody() as Record<string, unknown>;
  const value = (body.groups as Array<{ values: Array<Record<string, unknown>> }>)[0].values[0];
  (value.fulfillments as Array<Record<string, unknown>>)[0].transports = [];

  await assert.rejects(
    () => save(raw, body),
    (e: Error & { code?: string }) => e.code === 'CAPACITY_RESERVED',
    'inventory_ledger.scope_id names that route; delete it and the release finds nothing to give back to'
  );
  assert.equal(routes(raw).length, 1, 'the route is still there');
  assert.equal(routes(raw)[0].capacity_reserved, 1);
});

test('a FILE may lower a capacity down TO the units held, but not past them', async () => {
  const raw = seed();
  await save(raw, relationsBody({ capacity: 2 }));
  assert.equal(cells(raw)[0].capacity, 2, 'exactly the held count is legal — it means "no more places"');
  assert.equal(cells(raw)[0].capacity_reserved, 2);
});

test('__CLEAR__/untracked from a file keeps the row and its hold', async () => {
  const raw = seed();
  // null = untracked. It is not a way to zero a counter, and it must not be a
  // way to lose the units the counter is holding.
  await save(raw, relationsBody({ capacity: null, routeCapacity: null }));
  assert.equal(cells(raw)[0].capacity, null);
  assert.equal(cells(raw)[0].capacity_reserved, 2, 'the hold survives going untracked');
  assert.equal(routes(raw)[0].capacity_reserved, 1);
});

test('existingCellsFrom skips a transport whose cell is gone rather than keying it wrongly', () => {
  const built = existingCellsFrom(
    [{ id: 'f_pre', option_id: 'v_mini', fulfillment_type: 'pre_order', capacity_reserved: 2 }],
    [
      { id: 't_land', fulfillment_id: 'f_pre', method: 'land', capacity_reserved: 1 },
      { id: 't_ghost', fulfillment_id: 'f_deleted', method: 'air', capacity_reserved: 7 },
    ]
  );
  assert.deepEqual([...built.cells.keys()], ['v_mini|pre_order']);
  assert.deepEqual(
    [...built.transports.keys()],
    ['v_mini|pre_order|land'],
    'an orphan route has no (model, order type) to key on; the FK drops it with its cell'
  );
});

test('a caller that passes no existing cells behaves exactly as it did before 0075', () => {
  const raw = seed();
  const db = asD1(raw);
  const parsed = [
    {
      option_id: 'v_mini',
      fulfillment_type: 'pre_order' as const,
      enabled: true,
      sort: 0,
      capacity: 5,
      regular_price_iqd: null,
      prime_price_iqd: null,
      pro_price_iqd: null,
      cost_iqd: null,
      regular_adjust_iqd: null,
      prime_adjust_iqd: null,
      pro_adjust_iqd: null,
      cost_adjust_iqd: null,
      lead_time_text: '',
      lead_time_min_days: null,
      lead_time_max_days: null,
      transports: [],
    },
  ];
  let n = 0;
  const withOut = fulfillmentStatements(db, 'p_a1', parsed, () => `made_${++n}`);
  assert.ok(withOut.length > 0, 'the back-compatible call still plans a replace');

  n = 0;
  const withIn = fulfillmentStatements(
    db,
    'p_a1',
    parsed,
    () => `made_${++n}`,
    existingCellsFrom(
      [{ id: 'f_pre', option_id: 'v_mini', fulfillment_type: 'pre_order', capacity_reserved: 2 }],
      []
    )
  );
  assert.equal(withIn.length, withOut.length, 'supplying the map changes the VALUES bound, not the shape of the plan');
});

test('the columns this rests on exist, so a dropped migration fails here and not in production', () => {
  const raw = seed();
  const cols = (table: string) =>
    all<{ name: string }>(raw, `SELECT name FROM pragma_table_info(?)`, table).map((c) => c.name);
  for (const t of ['product_option_fulfillment', 'product_option_transports']) {
    assert.ok(cols(t).includes('capacity'), `${t}.capacity`);
    assert.ok(cols(t).includes('capacity_reserved'), `${t}.capacity_reserved`);
  }
  assert.ok(
    row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM pragma_table_info('inventory_ledger') WHERE name = 'scope'")!.n === 1
  );
});
