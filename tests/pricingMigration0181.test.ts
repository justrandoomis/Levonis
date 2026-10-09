/**
 * MIGRATION 0181 — THE PRICING ENGINE CORE, PROVEN ON THE REAL SCHEMA (FX
 * programme plan §4.2 as amended by the owner's decisions 6 and 8; USD
 * procurement design §10, §12 "P-B").
 *
 *   rules        a minimum profit in USD (≤ 2 dp, 0 < x ≤ 100,000) or, on a
 *                migrated row only, whole dinars; never both; the Direct Sale
 *                Extra in whole dinars on the step, never USD; no re-insert
 *   backstops    pricing_sku_costs: target_profit_iqd = floor(T_exact),
 *                computed − R ≥ floor(T), and the slack is within one step —
 *                exactly one step accepted, one dinar more refused
 *   freight      purchase_charges.pricing_role ∈ {additional, excluded}
 *   lots         a batch cost never changes, a lot is never deleted or replaced;
 *                FIFO and the product-deletion unlink still work
 *   decision 6   price_history / order_items / price_protection_claims columns;
 *                an engine order line carries its four facts, frozen after insert;
 *                every other line inserts exactly as before
 *   engine       the mode flips only with its token; on an engine product the
 *                price columns, option inserts and the last active option are
 *                locked (ENGINE_MANAGED) and inputs/rules guarded
 *                (PRICING_PREVIEW_REQUIRED) — value-compared, so an unchanged
 *                save and stock edits pass; with the token everything passes
 *   rates        a central rate still moves while engine products exist (no
 *                rate guard in this build: stale products are listed instead);
 *                config_version moves only on a VALUE change
 *   deletion     an engine-priced product is deleted like any other
 *   refusals     a trigger's code reaches the client as a 409, never a 500
 *   deploy-ahead the installed checks say no on a 0179 database
 *
 * Run: node --import tsx --test tests/pricingMigration0181.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, dbThrough, freshDb, hasColumn, row } from './fixtures/app';
import { deleteProductPermanently } from '../worker/lib/productDeletion';
import { engineDbRefusal, engineDbRefusalCode, ENGINE_DB_REFUSALS } from '../worker/lib/pricingDbRefusals';
import { engineColumnInstalled, engineCoreInstalled } from '../worker/lib/engineInstalled';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { HttpError } from '../worker/lib/http';

const NOW = '2026-10-09T12:00:00.000Z';
const P = 'eng_p1';

function refused(db: DatabaseSync, sql: string, message: RegExp) {
  assert.throws(() => db.exec(sql), message, sql.replace(/\s+/g, ' ').slice(0, 110));
}

/** One product: two models, a direct and a pre-order cell each, routes, a colour and a variant. */
function seedProduct(db: DatabaseSync, id = P) {
  db.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('${id}', '${id}', 'Engine product', 'active', 900000, 5);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${id}_g', '${id}', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('${id}_o0', '${id}', '${id}_g', 'A', 0, 1, 5, 900000), ('${id}_o1', '${id}', '${id}_g', 'B', 1, 1, 5, 950000);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd)
      VALUES ('${id}_o0_d', '${id}', '${id}_o0', 'direct_sale', 1, 950000), ('${id}_o0_p', '${id}', '${id}_o0', 'pre_order', 1, 900000);
    INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd)
      VALUES ('${id}_o0_p_air', '${id}', '${id}_o0_p', 'air', 1, NULL, 900000), ('${id}_o0_p_sea', '${id}', '${id}_o0_p', 'sea', 0, NULL, NULL);
    INSERT INTO product_colors (id, product_id, name_en, hex, sort, active, stock) VALUES ('${id}_c0', '${id}', 'Black', '#000000', 0, 1, 5);
    INSERT INTO product_variants (id, product_id, combo_key, active, stock) VALUES ('${id}_v0', '${id}', 'o:${id}_o0', 1, 5);
  `);
}

function makeEngine(db: DatabaseSync, id = P) {
  db.exec(`
    INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${id}', 1);
    INSERT INTO product_pricing_state (product_id, mode) VALUES ('${id}', 'engine');
    DELETE FROM ops_guards WHERE id = 'pricing-mode:${id}';
  `);
}

const withToken = (id: string, sql: string) =>
  `INSERT INTO ops_guards (id, ok) VALUES ('engine-price:${id}', 1); ${sql}; DELETE FROM ops_guards WHERE id = 'engine-price:${id}';`;

/* ----------------------------------------------------------------- rules -- */

const rule = (id: string, cols: Record<string, string | number | null>) => {
  const base: Record<string, string | number | null> = { id, kind: 'target_profit', scope: 'product', product_id: P, scope_id: '', state: 'ACTIVE', updated_at: NOW, ...cols };
  const keys = Object.keys(base);
  const vals = keys.map((k) => (base[k] === null ? 'NULL' : typeof base[k] === 'number' ? String(base[k]) : `'${base[k]}'`));
  return `INSERT INTO pricing_rules (${keys.join(', ')}) VALUES (${vals.join(', ')})`;
};

test('pricing_rules: a USD minimum profit is ≤ 2 decimals, above 0 and at most 100,000', () => {
  const db = freshDb();
  seedProduct(db);
  for (const ok of ['120', '120.5', '120.55', '0.01', '100000', '99999.99']) {
    db.exec(rule(`r_${ok}`, { amount_usd: ok, scope: 'option', scope_id: `o_${ok}` }));
  }
  for (const bad of ['120.555', '0', '0.00', '-5', '100000.01', '1e3', '.5', '5.', '1.2.3', '12a', '1234567890']) {
    refused(db, rule(`bad_${bad}`, { amount_usd: bad, scope: 'option', scope_id: `b_${bad}` }), /CHECK constraint failed/);
  }
});

test('pricing_rules: dinars only on a migrated minimum profit, never both currencies; the extra is whole dinars on the step', () => {
  const db = freshDb();
  seedProduct(db);
  refused(db, rule('owner_iqd', { amount_iqd: 120000 }), /CHECK constraint failed/);
  db.exec(rule('legacy_iqd', { amount_iqd: 120000, source: 'LEGACY_MIGRATION', legacy_result_id: 'pa_1' }));
  refused(db, rule('both', { amount_iqd: 120000, amount_usd: '75', source: 'LEGACY_MIGRATION', legacy_result_id: 'pa_2', scope: 'option', scope_id: 'o1' }), /CHECK constraint failed/);
  refused(db, rule('zero_legacy', { amount_iqd: 0, source: 'LEGACY_MIGRATION', legacy_result_id: 'pa_3', scope: 'option', scope_id: 'o2' }), /CHECK constraint failed/);
  // A converted legacy row keeps what it was converted from; never without the rate, never on an OWNER row.
  db.exec(rule('converted', { amount_usd: '75.01', legacy_amount_iqd: 120000, legacy_usd_iqd_rate: '1600', source: 'LEGACY_MIGRATION', legacy_result_id: 'pa_4', scope: 'option', scope_id: 'o3' }));
  refused(db, rule('half', { amount_usd: '75.01', legacy_amount_iqd: 120000, source: 'LEGACY_MIGRATION', legacy_result_id: 'pa_5', scope: 'option', scope_id: 'o4' }), /CHECK constraint failed/);
  refused(db, rule('owner_legacy', { amount_usd: '75.01', legacy_amount_iqd: 120000, legacy_usd_iqd_rate: '1600', scope: 'option', scope_id: 'o5' }), /CHECK constraint failed/);
  // ACTIVE ⇔ an amount; INHERIT is the owner's.
  refused(db, rule('active_empty', { scope: 'option', scope_id: 'o6' }), /CHECK constraint failed/);
  db.exec(rule('inherit', { state: 'INHERIT', scope: 'option', scope_id: 'o7' }));
  // The Direct Sale Extra: whole dinars, ≥ 0, on the 1,000 step, never USD.
  db.exec(rule('extra', { kind: 'direct_sale_extra', amount_iqd: 50000 }));
  db.exec(rule('extra0', { kind: 'direct_sale_extra', amount_iqd: 0, scope: 'option', scope_id: 'o1' }));
  refused(db, rule('extra_off', { kind: 'direct_sale_extra', amount_iqd: 50500, scope: 'option', scope_id: 'o2' }), /CHECK constraint failed/);
  refused(db, rule('extra_usd', { kind: 'direct_sale_extra', amount_usd: '30', scope: 'option', scope_id: 'o3' }), /CHECK constraint failed/);
});

test('pricing_rules: a rule is edited, never replaced — by id or by target (F8)', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(rule('r1', { amount_usd: '120' }));
  refused(db, rule('r1', { amount_usd: '90', scope: 'option', scope_id: 'o1' }), /PRICING_INPUT_REINSERT/);
  refused(db, rule('r2', { amount_usd: '90' }), /PRICING_INPUT_REINSERT/);
  refused(db, rule('r1', { amount_usd: '90' }).replace('INSERT INTO', 'INSERT OR REPLACE INTO'), /PRICING_INPUT_REINSERT/);
  db.exec("UPDATE pricing_rules SET amount_usd = '130.25', version = version + 1 WHERE id = 'r1'");
  assert.equal(row(db, "SELECT amount_usd FROM pricing_rules WHERE id = 'r1'")?.amount_usd, '130.25');
});

/* ------------------------------------------------------ storage backstops -- */

const sku = (cols: Record<string, string | number | null>) => {
  const base: Record<string, string | number | null> = {
    product_id: P, combo_key: 'o:eng_p1_o0', channel: 'pre_order_land', shipping_profile: 'GERMANY_LAND', supplier_amount: '450', supplier_currency: 'EUR',
    supplier_input_mode: 'SOURCE_CURRENCY', current_supplier_cost_usd_exact: '495', usd_iqd_rate: '1600', usd_fx_version: 1, cross_rate: '1.1', cross_fx_version: 1,
    fx_rate: '1760', fx_version: 1, supplier_cost_iqd: 792000, shipping_basis: 'weight', shipping_rate: '3200', shipping_version: 1, effective_weight_g: 2500,
    shipping_cost_iqd: 8000, additional_cost_iqd: 0, replacement_exact: '800000', replacement_cost_iqd: 800000, target_profit_iqd: 192000,
    target_profit_usd: '120', target_profit_iqd_exact: '192000', shipping_cost_usd: '5', additional_cost_usd: '0', current_total_cost_usd: '500',
    final_price_usd: '620', target_rule_id: 'r1', target_rule_version: 1, config_version: 0, rounding_step_iqd: 1000, preorder_base_iqd: 992000,
    computed_price_iqd: 992000, computed_at: NOW, ...cols,
  };
  const keys = Object.keys(base);
  const vals = keys.map((k) => (base[k] === null ? 'NULL' : typeof base[k] === 'number' ? String(base[k]) : `'${base[k]}'`));
  return `INSERT INTO pricing_sku_costs (${keys.join(', ')}) VALUES (${vals.join(', ')})`;
};

test('pricing_sku_costs: the §2.5 row (992,000) is accepted, and floor(T) is the whole part of T_exact', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(sku({}));
  // $120.55 × 1,660.5 = 200,173.275 → floor 200,173.
  db.exec(sku({ channel: 'pre_order_air', shipping_profile: 'CHINA_AIR', target_profit_usd: '120.55', target_profit_iqd_exact: '200173.275', target_profit_iqd: 200173, preorder_base_iqd: 1001000, computed_price_iqd: 1001000 }));
  refused(db, sku({ channel: 'pre_order_sea', shipping_profile: 'CHINA_SEA', target_profit_iqd_exact: '200173.275', target_profit_iqd: 200174, preorder_base_iqd: 1001000, computed_price_iqd: 1001000 }), /CHECK constraint failed/);
  refused(db, sku({ channel: 'pre_order_sea', shipping_profile: 'CHINA_SEA', target_profit_iqd_exact: '200173.275', target_profit_iqd: 200172, preorder_base_iqd: 1001000, computed_price_iqd: 1001000 }), /CHECK constraint failed/);
});

test('pricing_sku_costs: computed − R − floor(T) − extra may be exactly one step, never more; never below floor(T)', () => {
  const db = freshDb();
  seedProduct(db);
  // The worst case is real: R_exact = 799,000.2 (R = 799,001) and T_exact = 191,999.9 (floor 191,999) give
  // pre = ceil_1000(991,000.1) = 992,000, and the slack 992,000 − 799,001 − 191,999 is exactly 1,000.
  db.exec(sku({ replacement_exact: '799000.2', replacement_cost_iqd: 799001, supplier_cost_iqd: 791001, target_profit_iqd_exact: '191999.9', target_profit_iqd: 191999, target_profit_usd: null }));
  refused(db, sku({ channel: 'pre_order_air', shipping_profile: 'CHINA_AIR', replacement_cost_iqd: 799000, supplier_cost_iqd: 791000, target_profit_iqd_exact: '191999.5', target_profit_iqd: 191999 }), /CHECK constraint failed/);
  refused(db, sku({ channel: 'pre_order_sea', shipping_profile: 'CHINA_SEA', computed_price_iqd: 991000, preorder_base_iqd: 991000 }), /CHECK constraint failed/);
  // Direct sale: the extra is inside computed and outside the slack.
  db.exec(sku({ channel: 'direct_sale', direct_sale_extra_iqd: 50000, extra_rule_id: 'x', extra_rule_version: 1, computed_price_iqd: 1042000 }));
  refused(db, sku({ channel: 'direct_sale', combo_key: 'o:eng_p1_o1', direct_sale_extra_iqd: 50000, extra_rule_id: 'x', extra_rule_version: 1, computed_price_iqd: 1044000, preorder_base_iqd: 994000 }), /CHECK constraint failed/);
  refused(db, sku({ channel: 'pre_order_air', combo_key: 'o:eng_p1_o1', shipping_profile: 'CHINA_AIR', direct_sale_extra_iqd: 0, extra_rule_id: 'x', extra_rule_version: 1 }), /CHECK constraint failed/);
  assert.equal(count(db, 'SELECT COUNT(*) n FROM pricing_sku_costs'), 2);
});

/* --------------------------------------------------------------- freight -- */

test('purchase_charges.pricing_role: NULL, additional or excluded', () => {
  const db = freshDb();
  assert.ok(hasColumn(db, 'purchase_charges', 'pricing_role'));
  db.exec(`INSERT INTO users (id, email) VALUES ('owner', 'owner@x.co')`);
  db.exec(`INSERT INTO purchase_orders (id, currency, exchange_rate, purchase_day, created_by, created_at, updated_at) VALUES ('po1', 'IQD', 1, '2026-10-09', 'owner', '${NOW}', '${NOW}')`);
  const ins = (id: string, role: string) => `INSERT INTO purchase_charges (id, purchase_id, title, amount_iqd, basis, pricing_role) VALUES ('${id}', 'po1', 'x', 1000, 'quantity', ${role})`;
  db.exec(ins('c1', 'NULL'));
  db.exec(ins('c2', "'additional'"));
  db.exec(ins('c3', "'excluded'"));
  refused(db, ins('c4', "'freight'"), /CHECK constraint failed/);
});

/* ------------------------------------------------------------------ lots -- */

test('a batch cost is fixed: FIFO and the product-deletion unlink work; a cost change, a delete or a REPLACE are refused', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(`INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, purchase_unit_iqd, shipping_share_iqd, internal_share_iqd, total_cost_iqd, cost_basis, received_at)
           VALUES ('l1', '${P}', 'base', '', 5, 5, 800000, 700000, 100000, 0, 4000000, 'received', '${NOW}')`);
  db.exec("UPDATE inventory_lots SET qty_remaining = qty_remaining - 1 WHERE id = 'l1'");
  db.exec("UPDATE inventory_lots SET product_id = NULL WHERE id = 'l1'");
  for (const set of ['unit_cost_iqd = 1', 'purchase_unit_iqd = 1', 'shipping_share_iqd = 1', 'internal_share_iqd = 1', 'total_cost_iqd = 1', "cost_basis = 'opening'", 'qty_received = 9']) {
    refused(db, `UPDATE inventory_lots SET ${set} WHERE id = 'l1'`, /BATCH_COST_IMMUTABLE/);
  }
  db.exec("UPDATE inventory_lots SET unit_cost_iqd = 800000 WHERE id = 'l1'"); // same value: not a change
  refused(db, "DELETE FROM inventory_lots WHERE id = 'l1'", /BATCH_COST_IMMUTABLE/);
  refused(db, `INSERT OR REPLACE INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at) VALUES ('l1', NULL, 'base', '', 5, 5, 1, 'received', '${NOW}')`, /BATCH_COST_IMMUTABLE/);
  assert.deepEqual({ ...(row(db, "SELECT unit_cost_iqd, qty_remaining FROM inventory_lots WHERE id = 'l1'") ?? {}) }, { unit_cost_iqd: 800000, qty_remaining: 4 });
});

/* ------------------------------------------------------------ decision 6 -- */

const orderLine = (id: string, extra = '') =>
  `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd${extra ? `, ${extra.split('|')[0]}` : ''})
   VALUES ('${id}', 'o1', '${P}', 'x', 1, 992000, 992000${extra ? `, ${extra.split('|')[1]}` : ''})`;

test('decision 6: an ordinary line inserts as before; an engine line carries its four facts and they never change', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(`INSERT INTO users (id, email) VALUES ('u1', 'u1@x.co')`);
  db.exec(`INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
           VALUES ('o1', 'u1', '{}', 'd', '{}', 'cod', 992000, 1400, 992000, 992000)`);
  db.exec(orderLine('i_manual'));
  assert.deepEqual({ ...(row(db, "SELECT price_basis, engine_combo_key, engine_channel, engine_regular_iqd, usd_iqd_at_purchase, base_usd_at_purchase FROM order_items WHERE id = 'i_manual'") ?? {}) }, {
    price_basis: null, engine_combo_key: null, engine_channel: null, engine_regular_iqd: null, usd_iqd_at_purchase: null, base_usd_at_purchase: null,
  });
  db.exec(orderLine('i_engine', "price_basis, engine_combo_key, engine_channel, engine_regular_iqd, usd_iqd_at_purchase, base_usd_at_purchase|'engine', 'o:eng_p1_o0', 'pre_order_land', 992000, '1600', '620'"));
  refused(db, orderLine('i_half', "price_basis, engine_combo_key, engine_channel|'engine', 'o:eng_p1_o0', 'pre_order_land'"), /ORDER_SNAPSHOT_SHAPE/);
  refused(db, orderLine('i_orphan', "engine_regular_iqd|992000"), /ORDER_SNAPSHOT_SHAPE/);
  refused(db, orderLine('i_bad', "price_basis, engine_combo_key, engine_channel, engine_regular_iqd, usd_iqd_at_purchase|'engine', 'k', 'pre_order_moon', 1, '1600'"), /CHECK constraint failed/);
  for (const set of ["usd_iqd_at_purchase = '1500'", 'engine_regular_iqd = 1', "price_basis = NULL", "base_usd_at_purchase = '1'"]) {
    refused(db, `UPDATE order_items SET ${set} WHERE id = 'i_engine'`, /ORDER_SNAPSHOT_IMMUTABLE/);
  }
  refused(db, "UPDATE order_items SET price_basis = 'engine' WHERE id = 'i_manual'", /ORDER_SNAPSHOT_IMMUTABLE/);
  // Ordinary edits of the line, and the product-deletion unlink, still pass.
  db.exec("UPDATE order_items SET cost_iqd = 800000, product_id = NULL WHERE id = 'i_engine'");
  // History and claim columns default to today's meaning.
  db.exec(`INSERT INTO price_history (product_id, field, old_iqd, new_iqd) VALUES ('${P}', 'regular', 900000, 992000)`);
  assert.deepEqual({ ...(row(db, 'SELECT price_source, usd_iqd_rate FROM price_history') ?? {}) }, { price_source: 'manual', usd_iqd_rate: null });
  refused(db, `INSERT INTO price_history (product_id, field, price_source) VALUES ('${P}', 'regular', 'robot')`, /CHECK constraint failed/);
  db.exec(`INSERT INTO price_protection_claims (id, user_id, order_id, order_item_id, original_unit_iqd, observed_unit_iqd, qty) VALUES ('cl1', 'u1', 'o1', 'i_manual', 992000, 960000, 1)`);
  assert.deepEqual({ ...(row(db, 'SELECT basis, eligible_unit_iqd FROM price_protection_claims') ?? {}) }, { basis: 'iqd', eligible_unit_iqd: null });
  refused(db, "UPDATE price_protection_claims SET basis = 'fx'", /CHECK constraint failed/);
  refused(db, 'UPDATE price_protection_claims SET eligible_unit_iqd = -1', /CHECK constraint failed/);
});

/* ---------------------------------------------------------------- engine -- */

test('the mode flips only in a batch holding its token', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(`INSERT INTO product_pricing_state (product_id) VALUES ('${P}')`);
  refused(db, `UPDATE product_pricing_state SET mode = 'engine' WHERE product_id = '${P}'`, /PRICING_MODE_ENGINE_ONLY/);
  db.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${P}', 1); UPDATE product_pricing_state SET mode = 'engine' WHERE product_id = '${P}'; DELETE FROM ops_guards WHERE id = 'pricing-mode:${P}'`);
  refused(db, `UPDATE product_pricing_state SET mode = 'manual' WHERE product_id = '${P}'`, /PRICING_MODE_ENGINE_ONLY/);
  db.exec("INSERT INTO products (id, slug, name, status) VALUES ('p2', 'p2', 'P2', 'active')");
  refused(db, "INSERT INTO product_pricing_state (product_id, mode) VALUES ('p2', 'engine')", /PRICING_MODE_ENGINE_ONLY/);
  refused(db, `UPDATE product_pricing_state SET product_id = 'p2' WHERE product_id = '${P}'`, /PRICING_MODE_ENGINE_ONLY/);
  db.exec(`UPDATE product_pricing_state SET write_seq = write_seq + 1, reprice_blocked_code = 'FX_RATE_MISSING', reprice_blocked_at = '${NOW}' WHERE product_id = '${P}'`);
});

test('on a MANUAL product nothing is locked (every lock is inert until the owner adopts the engine)', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(`INSERT INTO product_pricing_state (product_id) VALUES ('${P}')`);
  db.exec(`UPDATE products SET price_iqd = 1, prime_price_iqd = 2, pro_price_iqd = 3, direct_surcharge_iqd = 4 WHERE id = '${P}'`);
  db.exec(`UPDATE product_option_values SET regular_price_iqd = 5, active = 0 WHERE product_id = '${P}'`);
  db.exec(`UPDATE product_option_transports SET surcharge_iqd = 25000, enabled = 1 WHERE product_id = '${P}'`);
  db.exec(`UPDATE product_variants SET regular_price_iqd = 7 WHERE product_id = '${P}'`);
  db.exec(`INSERT INTO product_colors (id, product_id, name_en, hex, regular_price_iqd) VALUES ('${P}_c9', '${P}', 'Red', '#f00', 9)`);
  db.exec(`INSERT INTO pricing_inputs (product_id, scope, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, updated_at) VALUES ('${P}', 'base', '450', 'EUR', 'SOURCE_CURRENCY', '${NOW}')`);
  db.exec(`DELETE FROM product_option_transports WHERE product_id = '${P}'`);
  db.exec(`DELETE FROM product_option_fulfillment WHERE product_id = '${P}'`);
  db.exec(`DELETE FROM product_option_values WHERE product_id = '${P}'`);
});

test('on an ENGINE product: every price change, insert, enable and delete is ENGINE_MANAGED; unchanged saves, stock and lead times pass; the token opens it', () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db);
  for (const sql of [
    `UPDATE products SET price_iqd = 1 WHERE id = '${P}'`,
    `UPDATE products SET direct_surcharge_iqd = 1000 WHERE id = '${P}'`,
    `UPDATE product_option_values SET regular_price_iqd = 1 WHERE id = '${P}_o0'`,
    `UPDATE product_option_values SET pro_adjust_iqd = 1 WHERE id = '${P}_o0'`,
    `INSERT INTO product_option_values (id, product_id, group_id, name_en) VALUES ('${P}_o9', '${P}', '${P}_g', 'New')`,
    `DELETE FROM product_option_values WHERE id = '${P}_o1'`,
    `UPDATE product_option_fulfillment SET regular_price_iqd = 1 WHERE id = '${P}_o0_d'`,
    `UPDATE product_option_fulfillment SET fulfillment_type = 'pre_order' WHERE id = '${P}_o0_d'`,
    `INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type) VALUES ('${P}_o1_d', '${P}', '${P}_o1', 'direct_sale')`,
    `DELETE FROM product_option_fulfillment WHERE id = '${P}_o0_d'`,
    `UPDATE product_option_transports SET surcharge_iqd = 25000 WHERE id = '${P}_o0_p_air'`,
    `UPDATE product_option_transports SET enabled = 1 WHERE id = '${P}_o0_p_sea'`,
    `DELETE FROM product_option_transports WHERE id = '${P}_o0_p_air'`,
    `UPDATE product_colors SET regular_adjust_iqd = 5000 WHERE id = '${P}_c0'`,
    `INSERT INTO product_colors (id, product_id, name_en, hex, pro_price_iqd) VALUES ('${P}_c9', '${P}', 'Red', '#f00', 1)`,
    `UPDATE product_variants SET regular_price_iqd = 1 WHERE id = '${P}_v0'`,
    `INSERT INTO product_variants (id, product_id, combo_key, regular_price_iqd) VALUES ('${P}_v9', '${P}', 'o:${P}_o1', 1)`,
  ]) refused(db, sql, /ENGINE_MANAGED/);

  // The last active model cannot be switched off; another one can.
  db.exec(`UPDATE product_option_values SET active = 0 WHERE id = '${P}_o1'`);
  refused(db, `UPDATE product_option_values SET active = 0 WHERE id = '${P}_o0'`, /ENGINE_MANAGED/);
  refused(db, `UPDATE product_option_values SET active = 1 WHERE id = '${P}_o1'`, /ENGINE_MANAGED/);

  // Value-compared: an unchanged full save, stock, lead time, names, a 1→0 enable, a colour or variant delete pass.
  db.exec(`UPDATE products SET price_iqd = 900000, stock = 2, name = 'Renamed' WHERE id = '${P}'`);
  db.exec(`UPDATE product_option_values SET regular_price_iqd = 900000, stock = 1, lead_time_text = '3 days', cost_iqd = 700000 WHERE id = '${P}_o0'`);
  db.exec(`UPDATE product_option_fulfillment SET enabled = 0, capacity = 3, cost_iqd = 1 WHERE id = '${P}_o0_d'`);
  db.exec(`UPDATE product_option_transports SET capacity_reserved = 1 WHERE id = '${P}_o0_p_air'`);
  db.exec(`INSERT INTO product_colors (id, product_id, name_en, hex) VALUES ('${P}_c8', '${P}', 'Plain', '#fff')`);
  db.exec(`DELETE FROM product_colors WHERE id = '${P}_c8'`);
  db.exec(`DELETE FROM product_variants WHERE id = '${P}_v0'`);
  // The upsert the product form uses: an existing id with the same prices passes.
  db.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, regular_price_iqd) VALUES ('${P}_o0', '${P}', '${P}_g', 'A', 900000)
           ON CONFLICT (id) DO UPDATE SET regular_price_iqd = excluded.regular_price_iqd, name_en = excluded.name_en`);

  // The engine's own batch, and the repricing batch, pass.
  db.exec(withToken(P, `UPDATE products SET price_iqd = 992000 WHERE id = '${P}'; UPDATE product_option_transports SET regular_price_iqd = 992000, surcharge_iqd = 0 WHERE id = '${P}_o0_p_air'`));
  db.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-rates-apply', 1); UPDATE product_option_values SET regular_price_iqd = 995000 WHERE id = '${P}_o0'; DELETE FROM ops_guards WHERE id = 'pricing-rates-apply'`);
  assert.equal(row(db, `SELECT price_iqd FROM products WHERE id = '${P}'`)?.price_iqd, 992000);
  // Another product's token opens nothing here.
  refused(db, withToken('other', `UPDATE products SET price_iqd = 1 WHERE id = '${P}'`), /ENGINE_MANAGED/);
});

test('on an ENGINE product inputs and product rules change only with a fresh preview (PRICING_PREVIEW_REQUIRED); inputs_seq counts every change', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(`INSERT INTO product_pricing_state (product_id) VALUES ('${P}')`);
  const input = `INSERT INTO pricing_inputs (product_id, scope, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, updated_at) VALUES ('${P}', 'base', '450', 'EUR', 'SOURCE_CURRENCY', '${NOW}')`;
  db.exec(input);
  db.exec(rule('r1', { amount_usd: '120' }));
  db.exec("UPDATE pricing_rules SET amount_usd = '125' WHERE id = 'r1'");
  assert.equal(row(db, `SELECT inputs_seq FROM product_pricing_state WHERE product_id = '${P}'`)?.inputs_seq, 3);
  refused(db, input, /PRICING_INPUT_REINSERT/);
  db.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${P}', 1); UPDATE product_pricing_state SET mode = 'engine' WHERE product_id = '${P}'; DELETE FROM ops_guards WHERE id = 'pricing-mode:${P}'`);
  refused(db, `UPDATE pricing_inputs SET shipping_weight_g = 2500 WHERE product_id = '${P}'`, /PRICING_PREVIEW_REQUIRED/);
  refused(db, `DELETE FROM pricing_inputs WHERE product_id = '${P}'`, /PRICING_PREVIEW_REQUIRED/);
  refused(db, "UPDATE pricing_rules SET amount_usd = '130' WHERE id = 'r1'", /PRICING_PREVIEW_REQUIRED/);
  refused(db, rule('r2', { kind: 'direct_sale_extra', amount_iqd: 50000 }), /PRICING_PREVIEW_REQUIRED/);
  db.exec(withToken(P, `UPDATE pricing_inputs SET shipping_weight_g = 2500 WHERE product_id = '${P}'; UPDATE pricing_rules SET amount_usd = '130' WHERE id = 'r1'`));
  assert.equal(row(db, `SELECT inputs_seq FROM product_pricing_state WHERE product_id = '${P}'`)?.inputs_seq, 5);
  // A global rule moves config_version, not the product's counter.
  const before = Number(row(db, 'SELECT config_version FROM pricing_engine_control WHERE id = 1')?.config_version);
  db.exec(`INSERT INTO pricing_rules (id, kind, scope, scope_id, state, amount_usd, updated_at) VALUES ('g1', 'target_profit', 'global', '', 'ACTIVE', '50', '${NOW}')`);
  assert.equal(Number(row(db, 'SELECT config_version FROM pricing_engine_control WHERE id = 1')?.config_version), before + 1);
});

test('the IQD conversion snapshot changes only with the owner-input token and a newer converted_at', () => {
  const db = freshDb();
  seedProduct(db);
  db.exec(`INSERT INTO pricing_inputs (product_id, scope, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, original_input_amount, original_input_currency,
             conversion_rate_snapshot, conversion_fx_version, canonical_supplier_cost_usd, converted_at, updated_at)
           VALUES ('${P}', 'base', '602.409638', 'USD', 'IQD_CONVERTED', '1000000', 'IQD', '1660', 1, '602.409638', '${NOW}', '${NOW}')`);
  const later = '2026-10-29T12:00:00.000Z';
  refused(db, `UPDATE pricing_inputs SET supplier_cost_amount = '571.428571', canonical_supplier_cost_usd = '571.428571', conversion_rate_snapshot = '1750', converted_at = '${later}' WHERE product_id = '${P}'`, /FX_SNAPSHOT_IMMUTABLE/);
  db.exec(`UPDATE pricing_inputs SET shipping_weight_g = 2500, version = version + 1 WHERE product_id = '${P}'`);
  db.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-input-owner:${P}', 1);
           UPDATE pricing_inputs SET original_input_amount = '1100000', supplier_cost_amount = '628.571428', canonical_supplier_cost_usd = '628.571428', conversion_rate_snapshot = '1750', converted_at = '${later}' WHERE product_id = '${P}';
           DELETE FROM ops_guards WHERE id = 'pricing-input-owner:${P}'`);
  // Back to the supplier's currency: the snapshot columns go NULL together (CHECK).
  refused(db, `INSERT INTO ops_guards (id, ok) VALUES ('pricing-input-owner:${P}', 1); UPDATE pricing_inputs SET supplier_input_mode = 'SOURCE_CURRENCY', original_input_currency = NULL WHERE product_id = '${P}'`, /CHECK constraint failed/);
});

test('the pricing audit is append-only', () => {
  const db = freshDb();
  db.exec(`INSERT INTO pricing_audit (id, entity, entity_key, action, created_at) VALUES ('pa1', 'rule', 'r1', 'rule_set', '${NOW}')`);
  refused(db, "UPDATE pricing_audit SET reason = 'x'", /PRICING_AUDIT_IMMUTABLE/);
  refused(db, 'DELETE FROM pricing_audit', /PRICING_AUDIT_IMMUTABLE/);
  refused(db, `INSERT OR REPLACE INTO pricing_audit (id, entity, entity_key, action, created_at) VALUES ('pa1', 'rule', 'r1', 'rule_set', '${NOW}')`, /PRICING_AUDIT_IMMUTABLE/);
  for (const action of ['input_from_purchase', 'engine_entry', 'reprice_owner', 'legacy_accept', 'rule_convert', 'engine_exit', 'fx_apply'])
    db.exec(`INSERT INTO pricing_audit (id, entity, entity_key, action, created_at) VALUES ('pa_${action}', 'engine', 'k', '${action}', '${NOW}')`);
  refused(db, `INSERT INTO pricing_audit (id, entity, entity_key, action, created_at) VALUES ('pa_gate', 'engine', 'k', 'gate_confirm', '${NOW}')`, /CHECK constraint failed/);
});

/* ----------------------------------------------------------------- rates -- */

test('a central rate still moves while engine products exist (no rate guard in this build); config_version moves only on a value change', () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db);
  const cv = () => Number(row(db, 'SELECT config_version FROM pricing_engine_control WHERE id = 1')?.config_version);
  const start = cv();
  db.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND'`);
  assert.equal(cv(), start + 1);
  db.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', updated_at = '${NOW}' WHERE profile = 'GERMANY_LAND'`);
  assert.equal(cv(), start + 1, 'the same value written again is not a change');
  db.exec(`UPDATE fx_rate_pairs SET effective_rate = '1600', effective_version = 1, drift_anchor_rate = '1600' WHERE pair = 'USD_IQD'`);
  db.exec(`UPDATE pricing_fx_rates SET rate_iqd = '1600', usd_iqd_rate = '1600', usd_version = 1, version = version + 1 WHERE currency = 'USD'`);
  assert.equal(cv(), start + 2);
});

/* -------------------------------------------------------------- deletion -- */

test('an engine-priced product with inputs, rules, costs and audit rows is deleted like any other; its audit stays', async () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db);
  db.exec(withToken(P, `INSERT INTO pricing_inputs (product_id, scope, supplier_cost_amount, supplier_cost_currency, supplier_input_mode, updated_at) VALUES ('${P}', 'base', '450', 'EUR', 'SOURCE_CURRENCY', '${NOW}'); ${rule('r1', { amount_usd: '120' })}`));
  db.exec(sku({}));
  db.exec(`INSERT INTO pricing_audit (id, entity, entity_key, product_id, action, created_at) VALUES ('pa1', 'engine', '${P}', '${P}', 'engine_entry', '${NOW}')`);
  const result = await deleteProductPermanently(asD1(db) as never, P);
  assert.equal(result.product_deleted, true);
  for (const t of ['product_pricing_state', 'pricing_inputs', 'pricing_rules', 'pricing_sku_costs', 'product_option_values', 'product_option_fulfillment', 'product_option_transports'])
    assert.equal(count(db, `SELECT COUNT(*) n FROM ${t} WHERE product_id = '${P}'`), 0, t);
  assert.equal(count(db, `SELECT COUNT(*) n FROM pricing_audit WHERE product_id = '${P}'`), 1, 'the audit is history');
});

/* -------------------------------------------------------------- refusals -- */

test("a trigger's refusal reaches the client as a 409 with its code and three languages — never its SQL", async () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db);
  let caught: unknown = null;
  try {
    await asD1(db).prepare(`UPDATE products SET price_iqd = 1 WHERE id = '${P}'`).run();
  } catch (e) {
    caught = e;
  }
  assert.equal(engineDbRefusalCode(caught), 'ENGINE_MANAGED');
  const http = engineDbRefusal(caught);
  assert.ok(http instanceof HttpError);
  assert.equal(http.status, 409);
  assert.equal(http.code, 'ENGINE_MANAGED');
  assert.doesNotMatch(http.message, /UPDATE|products|price_iqd/);
  // D1 wraps the SQLite text; a cause is read too. A longer code is never mistaken for a shorter one.
  assert.equal(engineDbRefusalCode(new Error('D1_ERROR', { cause: new Error('BATCH_COST_IMMUTABLE: SQLITE_CONSTRAINT') })), 'BATCH_COST_IMMUTABLE');
  assert.equal(engineDbRefusalCode(new Error('ENGINE_MANAGED_PRICES_KEPT')), null);
  assert.equal(engineDbRefusalCode(new Error('no such table: x')), null);
  assert.equal(engineDbRefusalCode(new HttpError(409, 'x', 'ENGINE_MANAGED')), null, 'a route refusal keeps its own answer');
  for (const code of ENGINE_DB_REFUSALS) {
    const t = COST_REFUSALS[code];
    assert.ok(t.ar && t.en && t.ckb, code);
    assert.notEqual(t.ckb, t.ar, `${code}: ckb is its own Sorani`);
    assert.match(t.ckb, /[ڕۆێڵەچ]/, `${code}: Sorani letters`);
  }
});

/* ---------------------------------------------------------- deploy-ahead -- */

test('deploy-ahead: on a 0179 database the engine core reads as not installed; on 0181 it is', async () => {
  const old = asD1(dbThrough('0179'));
  assert.equal(await engineCoreInstalled(old), false);
  assert.equal(await engineColumnInstalled(old, 'purchase_charges', 'pricing_role'), false);
  assert.equal(await engineColumnInstalled(old, 'order_items', 'price_basis'), false);
  const now = asD1(freshDb());
  assert.equal(await engineCoreInstalled(now), true);
  assert.equal(await engineColumnInstalled(now, 'purchase_charges', 'pricing_role'), true);
  assert.equal(await engineColumnInstalled(now, 'order_items', 'base_usd_at_purchase'), true);
  assert.equal(await engineColumnInstalled(now, 'price_protection_claims', 'basis'), true);
  // An answer is remembered only when present: the old database is asked again.
  assert.equal(await engineCoreInstalled(old), false);
  await assert.rejects(() => engineColumnInstalled(now, 'order_items', 'qty' as never), /not a 0181 column/);
});
