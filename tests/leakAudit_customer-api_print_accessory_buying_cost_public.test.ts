/**
 * LEAK AUDIT — customer-api: the shop's BUYING cost of every print accessory
 * reaches anonymous visitors, every customer and every merchant.
 *
 * The owner's rule is that anyone other than the main admin / super admin gets
 * ONLY the final price: no purchase cost, no intermediate value of the pricing
 * chain. `PrintAccessory.cost_iqd` is documented as «What ONE unit costs the
 * shop» (worker/lib/printAccessories.ts) and both print engines add it to the
 * cost base BEFORE the margin (worker/lib/printPricing.ts «It IS inside the
 * margin, because the shop buys the magnet»; worker/lib/printQuote/cost.ts
 * HARDWARE in baseCost, price = trueCost / (1 − margin)). So it is a purchase
 * cost, not a sale price — and these tests look for it, as a sentinel figure
 * the owner set, in every non-owner answer that carries the accessory list:
 *
 *   1. GET  /api/print-quote/accessories         (anonymous, edge-cached)
 *   2. GET  /api/marketplace/print/catalog        (anonymous, edge-cached)
 *   3. POST /api/print-quote/grams-quote          (anonymous)
 *   4. GET  /api/marketplace/print/requests/:id   (another customer + anonymous,
 *      the stored estimate's accessory_lines survive the 4-key deny-list)
 *   5. the guard gap: tests/fixtures/roleMatrix.ts NOT_A_COST tells the role
 *      matrix to ignore `.accessories[N].cost_iqd` on the two public routes.
 *
 * LOCAL ONLY: an in-memory SQLite database with every migration, the real route
 * modules, the stub session of tests/fixtures/app.ts. No network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, stubApp, type Mount } from './fixtures/app';
import { leaks } from './fixtures/costlyProduct';
import { NOT_A_COST } from './fixtures/roleMatrix';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { marketplaceRoutes } from '../worker/routes/marketplace';

/** The shop's buying price of ONE accessory — a figure no price, id or count here can equal. */
const ACC_COST = 47_391;
/** How many the customer asks for, and so the line/total cost the engines would derive. */
const QTY = 3;
const ACC_LINE_COST = ACC_COST * QTY; // 142_173

const SENTINEL_NUMBERS = [ACC_COST, ACC_LINE_COST];
const SENTINEL_TEXT = ['47391', '47,391', '142173', '142,173'];

/** Every non-owner scan: the shared leak walk plus the accessory sentinels in any form. */
function accessoryCostLeaks(body: unknown): string[] {
  const out = leaks(body, { numbers: SENTINEL_NUMBERS });
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    else if (typeof v === 'string') for (const t of SENTINEL_TEXT) if (v.includes(t)) out.push(`${path} ⊃ "${t}"`);
  };
  walk(body, '$');
  return [...new Set(out)];
}

const AUDIT_ACCESSORY = {
  id: 'audit-magnet',
  name_ar: 'مغناطيس تدقيق',
  name_en: 'Audit magnet',
  name_ckb: 'ماگنێتی پشکنین',
  unit: 'piece',
  cost_iqd: ACC_COST,
  category: 'magnet',
  active: true,
};

/** A shop that has filled in its numbers (the same figures tests/printQuoteGrams.test.ts uses),
 *  and whose owner set the accessory catalogue to one row at the sentinel buying price. */
function shop(): DatabaseSync {
  const raw = freshDb();
  raw.prepare(`UPDATE print_materials SET default_iqd_per_kg = 22000 WHERE id = 'pla'`).run();
  raw
    .prepare(
      `UPDATE printer_models
          SET purchase_iqd = 900000, residual_iqd = 100000, useful_print_hours = 4000,
              maintenance_iqd_per_hour = 150, printing_watts = 110,
              bed_heating_watts = 350, nozzle_heating_watts = 60
        WHERE id = 'bbl-a1m'`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO admin_settings (key, value) VALUES ('printAccessories', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(JSON.stringify([AUDIT_ACCESSORY]));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,phone_e164) VALUES
      ('buyer','Sara','s@x.co','h','customer','+9647700000001'),
      ('stranger','Nour','n@x.co','h','customer',NULL);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const bucket = { put: async () => ({}), get: async () => null, head: async () => null, delete: async () => undefined };

const mount: Mount = (a) => {
  a.route('/api/print-quote', printQuoteRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

const anonymous = (raw: DatabaseSync) =>
  stubApp(asD1(raw), null, mount, { env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket } });
const customer = (raw: DatabaseSync, id: string) =>
  stubApp(asD1(raw), { id, role: 'customer', email: `${id}@x.co` }, mount, {
    env: { R2_PRIVATE: bucket, R2_PUBLIC: bucket, BUCKET: bucket },
  });

// ------------------------------------------------------------------ 1 + 2

for (const path of ['/api/print-quote/accessories', '/api/marketplace/print/catalog']) {
  test(`anonymous GET ${path} carries no accessory buying cost`, async () => {
    const raw = shop();
    const res = await get(anonymous(raw), path);
    assert.equal(res.status, 200);
    const cacheControl = res.headers.get('Cache-Control') ?? '';
    const body = await json(res);
    // The route really served the owner's catalogue — otherwise this test proves nothing.
    assert.ok(
      (body.accessories as Array<{ id: string }>).some((a) => a.id === AUDIT_ACCESSORY.id),
      `the owner's accessory row is not in the answer: ${JSON.stringify(body.accessories)}`
    );
    const found = accessoryCostLeaks(body);
    assert.deepEqual(
      found,
      [],
      `anonymous ${path} (Cache-Control: ${cacheControl}) publishes the shop's accessory BUYING cost: ${found.join('; ')}`
    );
  });
}

// ------------------------------------------------------------------ 3

test('anonymous POST /api/print-quote/grams-quote echoes no accessory buying cost', async () => {
  const raw = shop();
  const res = await post(anonymous(raw), '/api/print-quote/grams-quote', {
    printer_model_id: 'bbl-a1m',
    rows: [{ material_id: 'pla', grams: 100, color_hex: '#000000' }],
    print_minutes: 180,
    accessories: [{ id: AUDIT_ACCESSORY.id, qty: QTY }],
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true, JSON.stringify(body));
  // The final price exists and is allowed; it is NOT what this test inspects.
  assert.ok(Number(body.quote?.price_iqd) > 0, `no final price: ${JSON.stringify(body.quote)}`);
  // The accessory was really priced (its id is echoed), so the path is exercised.
  assert.ok(
    JSON.stringify(body).includes(AUDIT_ACCESSORY.id),
    `the accessory never reached the engine: ${JSON.stringify(body)}`
  );
  const found = accessoryCostLeaks(body);
  assert.deepEqual(found, [], `anonymous grams-quote echoes the accessory BUYING cost: ${found.join('; ')}`);
});

// ------------------------------------------------------------------ 4

test('GET /api/marketplace/print/requests/:id gives another customer and a guest no accessory buying cost', async () => {
  const raw = shop();
  const draft = await post(customer(raw, 'buyer'), '/api/marketplace/requests', {
    title: 'A magnet box',
    description: 'A box with magnets in the lid, please',
  });
  assert.equal(draft.status, 201, JSON.stringify(await json(draft.clone())));
  const id = (await json(draft)).request.id as string;
  const pub = await post(customer(raw, 'buyer'), `/api/marketplace/print/requests/${id}/publish`, {
    process: 'fdm',
    material_id: 'pla',
    quality: 'standard',
    quantity: 1,
    volume_cm3: 20,
    accessories: [{ id: AUDIT_ACCESSORY.id, qty: QTY }],
  });
  assert.equal(pub.status, 200, JSON.stringify(await json(pub)));

  const found: string[] = [];
  for (const [who, app] of [
    ['another customer', customer(raw, 'stranger')],
    ['an anonymous visitor', anonymous(raw)],
  ] as const) {
    const res = await get(app, `/api/marketplace/print/requests/${id}`);
    const body = await json(res);
    assert.equal(res.status, 200, `${who}: ${JSON.stringify(body)}`);
    assert.ok(body.print, `${who}: no print block`);
    assert.ok(
      JSON.stringify(body.print.estimate ?? {}).includes(AUDIT_ACCESSORY.id),
      `${who}: the stored estimate does not name the accessory, so the path is not exercised: ${JSON.stringify(body.print.estimate)}`
    );
    for (const l of accessoryCostLeaks(body)) found.push(`${who}: ${l}`);
  }
  assert.deepEqual(found, [], `the published request hands the accessory BUYING cost to non-owners: ${found.join('; ')}`);
});

// ------------------------------------------------------------------ 5 (guard gap)

test('the role-matrix sweep is not told to ignore the accessory buying cost', () => {
  const exempted = [
    ['/api/print-quote/accessories', '$.accessories[0].cost_iqd = 47391'],
    ['/api/marketplace/print/catalog', '$.accessories[0].cost_iqd = 47391'],
  ].filter(([path, leak]) => NOT_A_COST.some((n) => n.path.test(path) && n.leak.test(leak)));
  assert.deepEqual(
    exempted,
    [],
    `tests/fixtures/roleMatrix.ts NOT_A_COST exempts the accessory BUYING cost (documented as «What ONE unit costs the shop») on: ${exempted.map(([p]) => p).join(', ')}`
  );
});
