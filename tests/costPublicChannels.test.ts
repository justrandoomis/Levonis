/** Stored public documents must not become a second route to private prices. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ROLES, OWNER, seededCopy } from './fixtures/roleMatrix';
import { COST, leaks } from './fixtures/costlyProduct';
import { get, json, post } from './fixtures/app';
import { productRoutes, homeRoutes } from '../worker/routes/products';
import { miscRoutes } from '../worker/routes/misc';
import { orderRoutes } from '../worker/routes/orders';
import { parseProductRow, projectPublic } from '../worker/lib/productModel';
import { publicPrintServiceRates } from '../worker/lib/settings';
import { printQuoteRoutes } from '../worker/routes/printQuote';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { publicEstimate } from '../worker/lib/requestRevisions';

const publicMounts = [
  ['/api/products', productRoutes], ['/api/home', homeRoutes], ['/api', miscRoutes],
] as const;

test('public service tariffs only accept numeric scalars, including historical numeric strings', () => {
  const rates = publicPrintServiceRates({
    machine_iqd_per_hour: { supplier_cost_iqd: COST.product },
    setup_fee_iqd: [COST.option],
  });
  assert.deepEqual(rates, { machine_iqd_per_hour: null, setup_fee_iqd: null });
  assert.deepEqual(publicPrintServiceRates({ machine_iqd_per_hour: '2500', setup_fee_iqd: 0 }),
    { machine_iqd_per_hour: 2500, setup_fee_iqd: 0 });
  assert.deepEqual(publicPrintServiceRates({ machine_iqd_per_hour: -1, setup_fee_iqd: Infinity }),
    { machine_iqd_per_hour: null, setup_fee_iqd: null });
});

test('configured print margin stays private in the calculator, public settings and home for every caller', async () => {
  const raw = seededCopy();
  try {
    raw.prepare('INSERT OR REPLACE INTO admin_settings (key,value) VALUES (?,?)').run('printServicePricing', JSON.stringify({
      machine_iqd_per_hour: 2500, setup_fee_iqd: 1500, margin_percent: 37,
    }));
    const problems: string[] = [];
    for (const [role, user] of Object.entries({ ...ROLES, owner: OWNER })) {
      const app = appFor(raw, user, publicMounts);
      for (const path of ['/api/products/print-calculator', '/api/settings/public', '/api/home']) {
        const res = await get(app, path);
        assert.equal(res.status, 200, `${role} ${path}`);
        const body = await json(res);
        problems.push(...leaks(body).map((leak) => `${role} ${path}: ${leak}`));
        if (path.endsWith('/print-calculator')) {
          const rates = body.rates as Record<string, unknown>;
          assert.equal(rates.machine_iqd_per_hour, 2500, 'published service price remains usable');
          assert.equal(rates.setup_fee_iqd, 1500);
          assert.equal(rates.configured, true);
        }
      }
    }
    assert.deepEqual(problems, []);
  } finally { raw.close(); }
});

test('legacy/imported spec maps publish physical facts without private pricing keys', async () => {
  const raw = seededCopy();
  try {
    const specs = { net_weight: '1000', material_type: 'PLA', supplier_cost_iqd: String(COST.product), target_profit_iqd: String(COST.option) };
    raw.prepare('UPDATE products SET spec_fields=? WHERE id=?').run(JSON.stringify(specs), 'p_a1');
    const stored = raw.prepare('SELECT * FROM products WHERE id=?').get('p_a1') as Record<string, unknown>;
    const publicDoc = projectPublic(parseProductRow(stored));
    assert.equal(publicDoc.spec_fields.net_weight, '1000');
    assert.equal(publicDoc.price_iqd, 900000);
    const app = appFor(raw, ROLES.guest, publicMounts);
    const res = await get(app, '/api/products/a1');
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(leaks({ publicDoc, response: body }), []);
  } finally { raw.close(); }
});

test('historical order snapshots are projected when read, retaining the paid price and coverage', async () => {
  const raw = seededCopy();
  try {
    raw.prepare('UPDATE order_items SET pricing_snapshot=?, warranty_snapshot=?, transport_snapshot=? WHERE id=?').run(
      JSON.stringify({ applied_iqd: 900000, unit_subtotal_iqd: 900000, cost_iqd: COST.orderLine, nested: { supplier_cost_iqd: COST.product } }),
      JSON.stringify({ plan_id: 'coverage', duration_months: 12, fee_iqd: 0, cost_iqd: COST.option }),
      JSON.stringify({ method: 'air', commission_iqd: 0, supplierCostIqd: COST.route }), 'oi1',
    );
    const app = appFor(raw, ROLES.customer, [['/api/orders', orderRoutes]]);
    const problems: string[] = [];
    for (const path of ['/api/orders', '/api/orders/ord1']) {
      const res = await get(app, path);
      assert.equal(res.status, 200);
      const body = await json(res);
      const order = (body.order ?? (body.orders as unknown[])[0]) as Record<string, unknown>;
      const line = (order.items as Array<Record<string, unknown>>)[0]!;
      assert.equal(line.unit_price_iqd, 900000);
      assert.equal((line.pricing as Record<string, unknown>).applied_iqd, 900000);
      assert.equal((line.warranty as Record<string, unknown>).duration_months, 12);
      assert.equal((line.transport as Record<string, unknown>).method, 'air');
      problems.push(...leaks(body).map((leak) => `${path}: ${leak}`));
    }
    assert.deepEqual(problems, []);
  } finally { raw.close(); }
});

test('accessory catalogues expose choices and units, never the shop acquisition price', async () => {
  const raw = seededCopy();
  try {
    raw.prepare('INSERT OR REPLACE INTO admin_settings (key,value) VALUES (?,?)').run('printAccessories', JSON.stringify([
      { id: 'test-magnet', name_ar: 'مغناطيس', name_en: 'Magnet', name_ckb: 'ماگنێت', unit: 'piece', category: 'magnet', active: true, cost_iqd: COST.product },
    ]));
    const problems: string[] = [];
    for (const [role, user] of Object.entries({ ...ROLES, owner: OWNER })) {
      const app = appFor(raw, user, [['/api/print-quote', printQuoteRoutes], ['/api/marketplace/print', printRequestRoutes]]);
      for (const path of ['/api/print-quote/accessories', '/api/marketplace/print/catalog']) {
        const res = await get(app, path);
        assert.equal(res.status, 200);
        const body = await json(res);
        assert.equal(body.accessories[0].id, 'test-magnet');
        assert.equal(body.accessories[0].unit, 'piece');
        problems.push(...leaks(body).map(l => `${role} ${path}: ${l}`));
      }
    }
    assert.deepEqual(problems, []);
  } finally { raw.close(); }
});

test('grams quotes keep the final hardware-inclusive price and selected quantities without raw hardware cost', async () => {
  const raw = seededCopy();
  try {
    raw.exec("UPDATE print_materials SET default_iqd_per_kg=22000 WHERE id='pla'");
    raw.exec("INSERT INTO community_merchants (id,user_id,name) VALUES ('hardware-merchant','u_m','Hardware Workshop'); INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('hardware-store','hardware-merchant','u_m','hardware-workshop','Hardware Workshop')");
    raw.prepare('INSERT OR REPLACE INTO admin_settings (key,value) VALUES (?,?)').run('printAccessories', JSON.stringify([
      { id: 'test-magnet', name_ar: 'مغناطيس', name_en: 'Magnet', name_ckb: 'ماگنێت', unit: 'piece', category: 'magnet', active: true, cost_iqd: COST.product },
    ]));
    const input = { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 60 };
    for (const role of ['guest', 'customer', 'merchant'] as const) {
      const app = appFor(raw, ROLES[role], [['/api/print-quote', printQuoteRoutes]]);
      const plain = await json(await post(app, '/api/print-quote/grams-quote', input));
      if (role === 'merchant') assert.ok('true_cost_iqd' in plain.quote, 'own no-hardware economics remain available');
      const res = await post(app, '/api/print-quote/grams-quote', { ...input, accessories: [{ id: 'test-magnet', qty: 1 }] });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.ok(body.quote.price_iqd > plain.quote.price_iqd + COST.product, 'hardware remains inside the final selling margin');
      assert.equal(body.accessories[0].id, 'test-magnet');
      assert.equal(body.accessories[0].qty, 1);
      assert.deepEqual(leaks(body), [], role);
    }
  } finally { raw.close(); }
});

test('published and historical estimates retain selected accessories without their raw amounts', () => {
  const projected = publicEstimate(JSON.stringify({ price_iqd: 990000, accessory_lines: [
    { id: 'test-magnet', qty: 1, name_ar: 'مغناطيس', name_en: 'Magnet', name_ckb: 'ماگنێت', unit: 'piece', unit_iqd: COST.product, iqd: COST.product },
  ] }));
  assert.equal(projected.price_iqd, 990000);
  assert.equal((projected.accessory_lines as Array<Record<string, unknown>>)[0]!.qty, 1);
  assert.deepEqual(leaks(projected), []);
});

test('a merchant controls their own margin but cannot reprice platform hardware at acquisition cost', async () => {
  const raw = seededCopy();
  try {
    raw.exec("UPDATE print_materials SET default_iqd_per_kg=22000 WHERE id='pla'");
    raw.exec("INSERT INTO community_merchants (id,user_id,name) VALUES ('hardware-merchant','u_m','Hardware Workshop'); INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('hardware-store','hardware-merchant','u_m','hardware-workshop','Hardware Workshop')");
    raw.exec("INSERT INTO print_analyses (id,owner_id,file_sha256,fingerprint,printer_model_id,print_minutes_per_plate) VALUES ('hardware-analysis','u_m','hardware-hash','hardware-fingerprint','bbl-a1m',60)");
    raw.exec("INSERT INTO print_analysis_materials (id,analysis_id,material_id,material_type,model_grams) VALUES ('hardware-material','hardware-analysis','pla','PLA',100)");
    const app = appFor(raw, ROLES.merchant, [['/api/print-quote', printQuoteRoutes]]);
    const input = { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 60 };
    for (const path of ['/api/print-quote/grams-quote', '/api/print-quote/analyses/hardware-analysis/quote']) {
      const quote = async (target_margin_percent?: number, hardware = false) => {
        const response = await post(app, path, {
          ...input, target_margin_percent,
          ...(hardware ? { accessories: [{ id: 'privacy-magnet', qty: 1 }] } : {}),
        });
        assert.equal(response.status, 200, path);
        const body = await json(response);
        if (hardware) assert.deepEqual(leaks(body), [], path);
        return body.quote;
      };
      const platformHardware = await quote(undefined, true);
      const ownLowMargin = await quote(0.000001);
      const ownHighMargin = await quote(90);
      assert.ok(ownHighMargin.price_iqd > ownLowMargin.price_iqd, 'the merchant still chooses their own no-hardware selling margin');
      for (const margin of [0, 0.000001, 10, 90]) {
        const hardware = await quote(margin, true);
        assert.notEqual(hardware.price_iqd - ownLowMargin.price_iqd, COST.product,
          `${path}: ${margin}% must not create an exact acquisition-cost oracle`);
        assert.equal(hardware.price_iqd, platformHardware.price_iqd,
          'a merchant margin cannot override the platform selling margin on platform hardware');
      }
    }
  } finally { raw.close(); }
});
