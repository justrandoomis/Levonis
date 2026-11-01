/** Stored public documents must not become a second route to private prices. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appFor, ROLES, OWNER, seededCopy } from './fixtures/roleMatrix';
import { COST, arithmeticLeaks, leaks } from './fixtures/costlyProduct';
import { asD1, get, json, post } from './fixtures/app';
import { productRoutes, homeRoutes } from '../worker/routes/products';
import { miscRoutes } from '../worker/routes/misc';
import { orderRoutes } from '../worker/routes/orders';
import { cartRoutes } from '../worker/routes/cart';
import { parseProductRow, projectPublic } from '../worker/lib/productModel';
import { applyRelations, loadRelationsView } from '../worker/lib/productOverlay';
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

test('configured print rates and margin stay private in the calculator, public settings and home for every caller', async () => {
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
          // The machine-hour rate and the setup fee are inputs of the print
          // price like the margin: the calculator says only whether the
          // service is priced (DECISIONS row 220).
          assert.deepEqual(rates, { configured: true });
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
      // The matrix seeds more than one order for u1 (the leak-audit rows, DECISIONS row 220): read ord1 by id.
      const order = (body.order ?? (body.orders as Array<Record<string, unknown>>).find((o) => o.id === 'ord1')) as Record<string, unknown>;
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
    // The matrix may already give u_m a store (the leak-audit seed): a merchant either way.
    raw.exec("INSERT OR IGNORE INTO community_merchants (id,user_id,name) VALUES ('hardware-merchant','u_m','Hardware Workshop'); INSERT OR IGNORE INTO merchant_stores (id,merchant_id,user_id,slug,name) SELECT 'hardware-store',id,'u_m','hardware-workshop','Hardware Workshop' FROM community_merchants WHERE user_id = 'u_m'");
    raw.prepare('INSERT OR REPLACE INTO admin_settings (key,value) VALUES (?,?)').run('printAccessories', JSON.stringify([
      { id: 'test-magnet', name_ar: 'مغناطيس', name_en: 'Magnet', name_ckb: 'ماگنێت', unit: 'piece', category: 'magnet', active: true, cost_iqd: COST.product },
    ]));
    const input = { printer_model_id: 'bbl-a1m', rows: [{ material_id: 'pla', grams: 100 }], print_minutes: 60 };
    for (const role of ['guest', 'customer', 'merchant'] as const) {
      const app = appFor(raw, ROLES[role], [['/api/print-quote', printQuoteRoutes]]);
      const plain = await json(await post(app, '/api/print-quote/grams-quote', input));
      // The public calculators price on the platform's own figures (no machine
      // of the caller's is involved), so a store owner reads the final price
      // like everyone else — never the platform's cost chain (DECISIONS row 220;
      // a merchant costs their own machines on /analyses/:id/compare).
      assert.ok(!('true_cost_iqd' in plain.quote), `${role}: no cost chain on the public calculator`);
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

test('a merchant cannot reprice the platform calculators: any requested margin answers the platform price, with or without hardware', async () => {
  const raw = seededCopy();
  try {
    raw.exec("UPDATE print_materials SET default_iqd_per_kg=22000 WHERE id='pla'");
    // The matrix may already give u_m a store (the leak-audit seed): a merchant either way.
    raw.exec("INSERT OR IGNORE INTO community_merchants (id,user_id,name) VALUES ('hardware-merchant','u_m','Hardware Workshop'); INSERT OR IGNORE INTO merchant_stores (id,merchant_id,user_id,slug,name) SELECT 'hardware-store',id,'u_m','hardware-workshop','Hardware Workshop' FROM community_merchants WHERE user_id = 'u_m'");
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
      const platformPlain = await quote(undefined);
      const ownLowMargin = await quote(0.000001);
      const ownHighMargin = await quote(90);
      // A margin the caller names made the platform's price an oracle for the
      // platform's own cost — with hardware AND without (DECISIONS row 220):
      // these doors price no machine of the merchant's, so the margin is the
      // platform's for everyone. Their own machines are costed on /compare.
      assert.equal(ownLowMargin.price_iqd, platformPlain.price_iqd, `${path}: a near-zero margin is not honoured`);
      assert.equal(ownHighMargin.price_iqd, platformPlain.price_iqd, `${path}: nor is a high one`);
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

/**
 * V2-0 C5 (DECISIONS row 225): the same public channels carry FINAL NUMBERS
 * ONLY — no cost (above) and no arithmetic either: no resolver `components`,
 * `price_source`, `member_rule` or `pricing_basis`, no fee by name, no raw
 * ladder on any option, colour, order-type cell or route. The costly product
 * has a priced air route (`surcharge_iqd` 25,000) on its model, and its order
 * line is given the resolver's whole answer as a stored snapshot, so every
 * removed key has something to leak. Only the paths a customer screen still
 * renders are allowed through (`CUSTOMER_DEFERRED_ARITHMETIC`, V2-7).
 */
test('customer channels carry final numbers, never the arithmetic of a price, for every caller', async () => {
  const raw = seededCopy();
  try {
    raw.prepare("UPDATE products SET direct_surcharge_iqd = 40000, preorder_transports = ? WHERE id = 'p_a1'").run(
      JSON.stringify([{ method: 'air', commission_iqd: 15000, active: true }])
    );
    raw.prepare('UPDATE order_items SET pricing_snapshot = ?, transport_snapshot = ?, warranty_snapshot = ? WHERE id = ?').run(
      JSON.stringify({
        regular_iqd: 900000, applied_iqd: 900000, applied_tier: 'regular', unit_subtotal_iqd: 900000, prime_iqd: null, pro_iqd: null,
        price_source: 'option', member_rule: { pro: 'rule_x', prime: null }, pricing_basis: 'direct',
        components: { base_iqd: 900000, option_iqd: 900000, fulfillment_iqd: 900000, transport_iqd: 900000, color_iqd: 900000,
          membership_adjustment_iqd: 0, transport_fee_iqd: 0, direct_fee_iqd: 0, warranty_fee_iqd: 0 },
        direct: { surcharge_iqd: 0, waived: false }, transport: null,
        offer: { offer_id: 'ofw', offer_price_mode: 'discount_percent', offer_discount_percent: 10, price_source: 'offer' },
        fulfillment: { type: 'direct_sale', source: 'stated', from_option_cell: true, variant_key: 'a1', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null },
        warranty: { plan_id: 'coverage', fee_iqd: 0, fee_percent: 7.5, basis_iqd: 900000, duration_months: 12, duration_kind: 'total' },
        errors: [],
      }),
      JSON.stringify({ method: 'air', commission_iqd: 0, waived: false, source: 'components', components: [{ product_id: 'p_a1', fee_iqd: 0 }] }),
      JSON.stringify({ plan_id: 'coverage', duration_months: 12, duration_kind: 'total', fee_iqd: 0, fee_percent: 7.5, basis_iqd: 900000 }),
      'oi1'
    );
    // The scanner is not vacuous: the overlaid document a customer is NOT
    // sent carries the ladder, and the walk sees it.
    const row = raw.prepare("SELECT * FROM products WHERE id = 'p_a1'").get() as Record<string, unknown>;
    const doc = applyRelations(parseProductRow(row), await loadRelationsView(asD1(raw), 'p_a1', 'BASE'));
    assert.ok(arithmeticLeaks({ options: doc.options }).some((l) => l.includes('surcharge_iqd')), 'the walk sees a route fee');

    const mounts = [...publicMounts, ['/api/cart', cartRoutes], ['/api/orders', orderRoutes]] as const;
    const problems: string[] = [];
    for (const role of ['guest', 'customer', 'merchant', 'employee', 'investor'] as const) {
      const app = appFor(raw, ROLES[role], mounts);
      const answers: Array<[string, Response]> = [
        ['GET /api/products/a1', await get(app, '/api/products/a1')],
        ['GET /api/products', await get(app, '/api/products')],
        ['GET /api/home', await get(app, '/api/home')],
        ['POST /api/products/a1/quote', await post(app, '/api/products/a1/quote', { qty: 1, optionValueIds: ['v_a1'], colorId: 'c_blk' })],
        ['POST /api/products/a1/quote air', await post(app, '/api/products/a1/quote', { qty: 1, optionValueIds: ['v_a1'], colorId: 'c_blk', fulfillmentType: 'pre_order', transportMethod: 'air' })],
      ];
      if (role === 'customer') {
        answers.push(['GET /api/cart', await get(app, '/api/cart')]);
        answers.push(['GET /api/orders', await get(app, '/api/orders')]);
        answers.push(['GET /api/orders/ord1', await get(app, '/api/orders/ord1')]);
      }
      for (const [at, res] of answers) {
        assert.equal(res.status, 200, `${role} ${at}`);
        problems.push(...arithmeticLeaks(await json(res)).map((l) => `${role} ${at}: ${l}`));
      }
    }
    assert.deepEqual(problems, []);

    // The order line keeps its final figures and, until V2-7, the facts its screen renders.
    const app = appFor(raw, ROLES.customer, mounts);
    type Line = { pricing: Record<string, unknown>; transport: unknown; warranty: Record<string, unknown> };
    const line = ((await json(await get(app, '/api/orders/ord1'))).order.items as Line[])[0]!;
    assert.equal(line.pricing.unit_subtotal_iqd, 900000);
    assert.equal(line.pricing.pricing_basis, 'direct');
    assert.deepEqual(line.transport, { method: 'air', commission_iqd: 0, waived: false });
    assert.deepEqual(line.warranty.duration_months, 12);
  } finally { raw.close(); }
});

/**
 * «سعر تقديري» (migration 0218; docs/SMART_PRICING.md §5, invariant I6): an estimated product's customer
 * channels carry the boolean label and final numbers — never the supplier catalogue behind the estimate,
 * its flags, measures, type defaults or the estimator's figures, all seeded here with sentinels in every
 * owner-only 0218 table. A line sold at an estimate is read back with its label.
 */
const ESTIMATE_PRIVATE = { decimals: ['173.37', '419.83', '58.91', '4.73', '18.861'], numbers: [7731, 67891, 676767, 686868, 3731, 2917, 1733] };
const ESTIMATE_WORDS = ['TMALL-TITLE-SECRET-7E', 'SUPPLIER-ITEM-7E', 'supplier-secret-7e.example', 'EST_DEFAULT_WEIGHT', 'EST_US_REFERENCE', 'tmall_cn', 'type_default'];

function seedEstimate(raw: ReturnType<typeof seededCopy>, pid: string): void {
  const now = '2026-11-01T00:00:00.000Z';
  raw.exec(`
    INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${pid}', 1);
    UPDATE products SET price_estimate = 1 WHERE id = '${pid}';
    DELETE FROM ops_guards WHERE id = 'engine-price:${pid}';
    INSERT INTO supplier_price_snapshots (id, source, currency, capture, captured_on, captured_by, file_sha256, item_count, sku_count, state, created_by, created_at, completed_at)
      VALUES ('sps_7e_cn', 'tmall_cn', 'CNY', 'browser_sweep', '2026-10-31', 'usr_owner', '${'a'.repeat(64)}', 1, 1, 'complete', 'usr_owner', '${now}', '${now}');
    INSERT INTO supplier_price_items (snapshot_id, item_key, url, page_host, title, name_en, category, sourcing_hint, route_hint)
      VALUES ('sps_7e_cn', 'SUPPLIER-ITEM-7E', 'https://supplier-secret-7e.example/item', 'supplier-secret-7e.example', 'TMALL-TITLE-SECRET-7E', 'A1', 'printer', 'CHINA_CNY', 'CHINA_SEA');
    INSERT INTO supplier_price_skus (snapshot_id, item_key, sku_key, price, price_label, net_weight_g)
      VALUES ('sps_7e_cn', 'SUPPLIER-ITEM-7E', 'SUPPLIER-ITEM-7E-sku', '173.37', '优惠前', 7731);
    INSERT INTO supplier_price_matches (product_id, combo_key, source, item_key, sku_key, confidence, method, reasons_json, state, decided_by, decided_at, found_in_snapshot, updated_at)
      VALUES ('${pid}', '', 'tmall_cn', 'SUPPLIER-ITEM-7E', 'SUPPLIER-ITEM-7E-sku', 'exact', 'sku_code', '["EST_US_REFERENCE"]', 'confirmed', 'auto', '${now}', 'sps_7e_cn', '${now}');
    INSERT INTO supplier_price_manual (product_id, combo_key, amount, currency, entered_by, entered_at) VALUES ('${pid}', 'c:x', '58.91', 'USD', 'usr_owner', '${now}');
    UPDATE price_estimate_types SET default_weight_g = 7731, default_length_mm = 3731, default_width_mm = 2917, default_height_mm = 1733,
                                    default_cbm = '18.861', additional_cost_iqd = 67891, min_profit_usd = '4.73' WHERE key = 'printer';
    INSERT INTO product_price_estimates (product_id, type_key, type_source, state, measure_basis, flags_json, applied_at, applied_by, applied_wire_json, updated_at)
      VALUES ('${pid}', 'printer', 'supplier_category', 'estimated', 'type_default', '["EST_DEFAULT_WEIGHT"]', '${now}', 'usr_owner', '{"supplier_cost_amount":"419.83","source":"tmall_cn"}', '${now}');
    INSERT INTO price_estimate_lines (product_id, combo_key, channel, price_source, supplier_amount, supplier_currency, measure_source, est_cost_iqd, est_price_iqd, computed_at)
      VALUES ('${pid}', '', 'pre_order_sea', 'tmall_cn', '173.37', 'CNY', 'type_default', 676767, 686868, '${now}');
  `);
}

test('an estimated product on every customer channel: the label and final numbers, never the catalogue behind it, for every caller', async () => {
  const raw = seededCopy();
  try {
    seedEstimate(raw, 'p_a1');
    // The checkout froze the acknowledged notice version into the line it sold at an estimate (§6.3).
    const snapshot = JSON.parse(String((raw.prepare("SELECT pricing_snapshot AS s FROM order_items WHERE id = 'oi1'").get() as { s: string }).s || '{}'));
    raw.prepare("UPDATE order_items SET pricing_snapshot = ? WHERE id = 'oi1'").run(JSON.stringify({ ...snapshot, applied_iqd: 900000, unit_subtotal_iqd: 900000, estimate: { v: 1 } }));
    const mounts = [...publicMounts, ['/api/cart', cartRoutes], ['/api/orders', orderRoutes]] as const;
    const problems: string[] = [];
    for (const role of ['guest', 'customer', 'merchant', 'employee', 'investor'] as const) {
      const app = appFor(raw, ROLES[role], mounts);
      const answers: Array<[string, Response]> = [
        ['GET /api/products/a1', await get(app, '/api/products/a1')],
        ['GET /api/products', await get(app, '/api/products')],
        ['GET /api/home', await get(app, '/api/home')],
        ['POST /api/products/a1/quote', await post(app, '/api/products/a1/quote', { qty: 1, optionValueIds: ['v_a1'], colorId: 'c_blk' })],
      ];
      if (role === 'customer') {
        answers.push(['GET /api/cart', await get(app, '/api/cart')]);
        answers.push(['GET /api/orders', await get(app, '/api/orders')]);
        answers.push(['GET /api/orders/ord1', await get(app, '/api/orders/ord1')]);
      }
      for (const [at, res] of answers) {
        assert.equal(res.status, 200, `${role} ${at}`);
        const body = await json(res);
        problems.push(...leaks(body, ESTIMATE_PRIVATE).map((l) => `${role} ${at}: ${l}`));
        problems.push(...arithmeticLeaks(body).map((l) => `${role} ${at}: ${l}`));
        const text = JSON.stringify(body);
        for (const word of ESTIMATE_WORDS) if (text.includes(word)) problems.push(`${role} ${at}: carries «${word}»`);
      }
    }
    assert.deepEqual(problems, []);
    // Not vacuous: the label is on the page and on the order line sold at an estimate, and only there.
    const guest = appFor(raw, ROLES.guest, mounts);
    const page = await json(await get(guest, '/api/products/a1'));
    assert.equal(page.product.price_estimate, true);
    const customer = appFor(raw, ROLES.customer, mounts);
    const line = ((await json(await get(customer, '/api/orders/ord1'))).order.items as Array<{ id?: string; pricing: Record<string, unknown> }>)[0]!;
    assert.equal(line.pricing.price_estimate, true, 'the line sold at an estimate says so');
    assert.equal(JSON.stringify(line.pricing).includes('"v"'), false, 'never the notice version or any other field of the record');
  } finally { raw.close(); }
});
