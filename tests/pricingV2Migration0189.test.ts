/**
 * MIGRATION 0189 — PRICING V2 CORE, PROVEN ON THE REAL SCHEMA (docs/PRICING-V2.md;
 * owner decisions A1, B1, C1, D1, DECISIONS rows 221 and 222; implementation
 * spec §2).
 *
 *   method       product_pricing_state.pricing_method ∈ {cost, usd}; set,
 *                changed or cleared only with the 'pricing-mode:' token and
 *                only on an engine product — a V2 product never drops to
 *                manual through the old exit door
 *   points       the dollar price points: a colour is a difference, an SKU and
 *                the product are fixed prices, ≤ 2 decimals, a difference is
 *                never 0; engine token on every write, never re-inserted,
 *                every change bumps inputs_seq
 *   discounts    the one pre-order discount: ≥ 0 (0 = an explicit «no
 *                discount» exception), the same guards
 *   results      the private V2 figures: P ≤ D, direct sells at D with no Δ,
 *                price-first never floors, cost-first names its cost; guarded
 *                like 0183 (ENGINE_MANAGED)
 *   snapshot     the legacy snapshot is append-only; only the permanent
 *                product deletion (its own token) or a cascade removes it
 *   fees         a V2 product's surcharge and route commissions stay 0; a V1
 *                engine product and a manual product are untouched
 *   SKU key      'o:*' passes the 0183 CHECK while '' is still refused; option
 *                id '*' is reserved in the database and in the relations planner
 *   re-run       the file's re-runnable statements change nothing
 *   deletion     a V2 product is deleted like any other, its private rows
 *                reported under the neutral engine name, no token left behind
 *   refusals     the three new database codes cross as a 409 in three languages
 *   deploy-ahead the installed checks say no on a 0188 database
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2Migration0189.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, count, dbThrough, freshDb, hasColumn, row } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { V2_SENTINEL_SNAPSHOT_PAYLOAD, seedV2Sentinels } from './fixtures/fxSentinels';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';
import { deleteProductPermanently } from '../worker/lib/productDeletion';
import { engineDbRefusal, engineDbRefusalCode } from '../worker/lib/pricingDbRefusals';
import { engineColumnInstalled, pricingV2Installed } from '../worker/lib/engineInstalled';
import { loadRelationsSnapshot, planRelationsWriteFrom } from '../worker/lib/productPersistence';
import { PRODUCT_COMBO_KEY, PRODUCT_SKU_ROW_KEY, skuKeyOfStored, storedSkuKey } from '../packages/pricing/src/skuChannel';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { HttpError } from '../worker/lib/http';

const NOW = '2026-10-13T12:00:00.000Z';
const P = 'v2_p1';

/** Runs `sql` inside a savepoint: on a refusal nothing it did stays (a token included). */
function run(db: DatabaseSync, sql: string): void {
  db.exec('SAVEPOINT t');
  try {
    db.exec(sql);
    db.exec('RELEASE t');
  } catch (e) {
    db.exec('ROLLBACK TO t');
    db.exec('RELEASE t');
    throw e;
  }
}

function refused(db: DatabaseSync, sql: string, message: RegExp): void {
  assert.throws(() => run(db, sql), message, sql.replace(/\s+/g, ' ').slice(0, 140));
}

const CHECK = /CHECK constraint failed/;
const tokenSql = (token: string, sql: string) =>
  `INSERT INTO ops_guards (id, ok) VALUES ('${token}', 1); ${sql}; DELETE FROM ops_guards WHERE id = '${token}';`;
const priced = (id: string, sql: string) => tokenSql(`engine-price:${id}`, sql);
const moded = (id: string, sql: string) => tokenSql(`pricing-mode:${id}`, sql);

/** One product: a model group with two models, a colour, a direct and a pre-order cell with routes. */
function seedProduct(db: DatabaseSync, id = P): void {
  db.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('${id}', '${id}', 'V2 product', 'active', 1500000, 5);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${id}_g', '${id}', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('${id}_o0', '${id}', '${id}_g', 'Standard', 0, 1, 5, 1500000), ('${id}_o1', '${id}', '${id}_g', 'Combo', 1, 1, 5, 1815000);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd)
      VALUES ('${id}_o0_d', '${id}', '${id}_o0', 'direct_sale', 1, 1500000), ('${id}_o0_p', '${id}', '${id}_o0', 'pre_order', 1, 1425000);
    INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd)
      VALUES ('${id}_o0_p_sea', '${id}', '${id}_o0_p', 'sea', 1, NULL, 1425000);
    INSERT INTO product_colors (id, product_id, name_en, hex, sort, active, stock) VALUES ('${id}_c0', '${id}', 'Red', '#ff0000', 0, 1, 5);
  `);
}

/** The product's engine state: V1 (method NULL) or V2 ('cost' | 'usd'), set the way the writer will set it. */
function makeEngine(db: DatabaseSync, id = P, method: 'cost' | 'usd' | null = null): void {
  const m = method === null ? 'NULL' : `'${method}'`;
  run(db, moded(id, `INSERT INTO product_pricing_state (product_id, mode, pricing_method, v2_since) VALUES ('${id}', 'engine', ${m}, ${method ? `'${NOW}'` : 'NULL'})`));
}

const lit = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`);
function insertSql(table: string, values: Record<string, string | number | null>): string {
  const keys = Object.keys(values);
  return `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => lit(values[k]!)).join(', ')})`;
}

const point = (scope: string, scopeId: string, kind: string, usd: string, id = P) =>
  insertSql('pricing_price_points', { product_id: id, scope, scope_id: scopeId, kind, amount_usd: usd, updated_by: 'usr_owner', updated_at: NOW });
const discount = (scope: string, scopeId: string, usd: string, id = P) =>
  insertSql('pricing_preorder_discounts', { product_id: id, scope, scope_id: scopeId, amount_usd: usd, updated_by: 'usr_owner', updated_at: NOW });

/** PRICING-V2.md §1.6's Standard pre-order (sea) row: R 1,023,000, T $318 at 1,500, Δ $50 — every CHECK satisfied. */
function result(over: Record<string, string | number | null> = {}): string {
  return insertSql('pricing_v2_sku_results', {
    product_id: P, combo_key: `o:${P}_o0`, channel: 'pre_order_sea', method: 'cost', anchor: 'cost',
    final_price_iqd: 1425000, exact_iqd: '1425000', direct_price_iqd: 1500000, direct_exact_iqd: '1500000',
    usd_ceil6: '950', deltas_usd: '0', discount_usd: '50', discount_scope: 'product', discount_scope_id: '', floor: 'none',
    shipping_profile: 'CHINA_SEA', supplier_currency: 'USD', fx_rate: '1500', fx_version: 1, cross_rate: null, cross_fx_version: null,
    shipping_rate: '250000', shipping_version: 1, replacement_exact: '1023000', replacement_cost_iqd: 1023000,
    target_profit_usd: '318', target_rule_id: 'rule_t', target_rule_version: 1, usd_iqd_rate: '1500', usd_fx_version: 1,
    inputs_seq: 0, config_version: 0, write_seq: 1, computed_at: NOW, ...over,
  });
}

const SHA = 'a'.repeat(64);
function snapshot(over: Record<string, string | number | null> = {}): string {
  return insertSql('pricing_legacy_snapshots', {
    id: 'snap1', product_id: P, reason: 'v2_migration', captured_at: NOW, usd_iqd_rate: '1500', fx_version: 1,
    actor: 'usr_owner', payload_json: '{"product":{"price_iqd":1500000}}', payload_sha256: SHA, ...over,
  });
}

const seqOf = (db: DatabaseSync, id = P) => row<{ inputs_seq: number }>(db, 'SELECT inputs_seq FROM product_pricing_state WHERE product_id = ?', id)!.inputs_seq;

/* ---------------------------------------------------------------- method -- */

test('the method is set, changed or cleared only with the mode token, and only on an engine product', () => {
  const db = freshDb();
  seedProduct(db);
  assert.ok(hasColumn(db, 'product_pricing_state', 'pricing_method'));
  assert.ok(hasColumn(db, 'product_pricing_state', 'v2_since'));

  // Born V2: the token AND mode = 'engine'.
  refused(db, `INSERT INTO product_pricing_state (product_id, mode, pricing_method) VALUES ('${P}', 'engine', 'cost')`, /PRICING_MODE_ENGINE_ONLY/);
  refused(db, moded(P, `INSERT INTO product_pricing_state (product_id, mode, pricing_method) VALUES ('${P}', 'manual', 'cost')`), /PRICING_MODE_ENGINE_ONLY/);
  refused(db, moded(P, `INSERT INTO product_pricing_state (product_id, mode, pricing_method) VALUES ('${P}', 'engine', 'iqd')`), CHECK);
  makeEngine(db, P, 'cost');
  assert.equal(row(db, 'SELECT pricing_method FROM product_pricing_state WHERE product_id = ?', P)!.pricing_method, 'cost');

  // A method change needs the token; a V2 product never drops to manual, even with it.
  refused(db, `UPDATE product_pricing_state SET pricing_method = 'usd' WHERE product_id = '${P}'`, /PRICING_MODE_ENGINE_ONLY/);
  run(db, moded(P, `UPDATE product_pricing_state SET pricing_method = 'usd' WHERE product_id = '${P}'`));
  refused(db, moded(P, `UPDATE product_pricing_state SET mode = 'manual' WHERE product_id = '${P}'`), /PRICING_MODE_ENGINE_ONLY/);
  refused(db, `UPDATE product_pricing_state SET pricing_method = NULL WHERE product_id = '${P}'`, /PRICING_MODE_ENGINE_ONLY/);

  // The work-queue columns stay free (the writer's own counters), as in 0181.
  run(db, `UPDATE product_pricing_state SET inputs_seq = inputs_seq + 1, write_seq = write_seq + 1, priced_at = '${NOW}' WHERE product_id = '${P}'`);

  // A V1 engine product: unchanged until the owner's token says otherwise.
  const v1 = 'v1_p';
  seedProduct(db, v1);
  makeEngine(db, v1, null);
  refused(db, `UPDATE product_pricing_state SET pricing_method = 'cost' WHERE product_id = '${v1}'`, /PRICING_MODE_ENGINE_ONLY/);
  run(db, moded(v1, `UPDATE product_pricing_state SET mode = 'manual' WHERE product_id = '${v1}'`));
  refused(db, moded(v1, `UPDATE product_pricing_state SET pricing_method = 'cost' WHERE product_id = '${v1}'`), /PRICING_MODE_ENGINE_ONLY/);
  run(db, moded(v1, `UPDATE product_pricing_state SET mode = 'engine', pricing_method = 'cost' WHERE product_id = '${v1}'`));

  // Leaving V2 (V2-7's rollback) clears the method in the same tokened statement that leaves engine.
  run(db, moded(P, `UPDATE product_pricing_state SET mode = 'manual', pricing_method = NULL WHERE product_id = '${P}'`));
  assert.deepEqual(row(db, 'SELECT mode, pricing_method FROM product_pricing_state WHERE product_id = ?', P), { mode: 'manual', pricing_method: null });
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

/* ---------------------------------------------------------------- points -- */

test('price points: a colour is a difference, an SKU and the product are fixed prices, ≤ 2 decimals, a difference is never 0', () => {
  const db = freshDb();
  seedProduct(db);
  const ok = [
    point('product', '', 'fixed', '1000'),
    point('option', `${P}_o0`, 'fixed', '1200.5'),
    point('option', `${P}_o1`, 'delta', '-43.21'),
    point('option', 'other_group_value', 'delta', '+5'),
    point('color', `${P}_c0`, 'delta', '7.77'),
    point('sku', `o:${P}_o0|c:${P}_c0`, 'fixed', '1234.56'),
    point('sku', `o:${P}_o1|c:${P}_c0`, 'fixed', '100000'),
  ];
  for (const sql of ok) run(db, priced(P, sql));
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM pricing_price_points WHERE product_id = ?', P), ok.length);

  const bad: Array<[string, string]> = [
    [point('color', 'c_fixed', 'fixed', '10'), 'a colour fixed price (C1: a colour is a difference)'],
    [point('sku', 'o:x', 'delta', '10'), 'an SKU difference (C1: an SKU is a fixed price)'],
    [point('product', '', 'delta', '10', 'v2_other'), 'a product difference (the product is the anchor)'],
    [point('option', 'three_dp', 'fixed', '10.123'), 'three decimals'],
    [point('option', 'three_dp_d', 'delta', '-10.123'), 'three decimals on a difference'],
    [point('option', 'zero_d', 'delta', '0'), 'a difference of 0'],
    [point('option', 'neg_zero_d', 'delta', '-0'), 'a difference of -0'],
    [point('option', 'zero_cents_d', 'delta', '+0.00'), 'a difference of +0.00'],
    [point('option', 'zero_f', 'fixed', '0'), 'a fixed price of 0'],
    [point('option', 'neg_f', 'fixed', '-5'), 'a negative fixed price'],
    [point('option', 'big_f', 'fixed', '100000.01'), 'above 100,000'],
    [point('option', 'big_d', 'delta', '-100000.01'), 'a difference above 100,000'],
    [point('option', 'lead_dot', 'fixed', '.5'), 'no leading digit'],
    [point('option', 'trail_dot', 'fixed', '5.'), 'a trailing point'],
    [point('option', 'exp', 'fixed', '1e3'), 'an exponent'],
    [point('option', 'comma', 'fixed', '1,5'), 'a comma'],
    [point('option', 'two_signs', 'delta', '+-5'), 'two signs'],
    [point('product', 'x', 'fixed', '10', 'v2_other'), 'a product scope with an id'],
    [point('option', '', 'fixed', '10'), 'an option scope without an id'],
  ];
  db.exec("INSERT INTO products (id, slug, name, price_iqd) VALUES ('v2_other', 'v2_other', 'Other', 1000)");
  for (const [sql, why] of bad) {
    const id = sql.includes("'v2_other'") ? 'v2_other' : P;
    assert.throws(() => run(db, priced(id, sql)), CHECK, why);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

test('price points and discounts: the engine token on every write, never re-inserted, every change bumps inputs_seq', () => {
  const db = freshDb();
  seedProduct(db);

  // A product with no engine state is guarded too: only the V2 writer and the migration write these rows.
  refused(db, point('product', '', 'fixed', '1000'), /PRICING_PREVIEW_REQUIRED/);
  refused(db, discount('product', '', '50'), /PRICING_PREVIEW_REQUIRED/);

  makeEngine(db, P, 'usd');
  const seq0 = seqOf(db);
  refused(db, point('product', '', 'fixed', '1000'), /PRICING_PREVIEW_REQUIRED/);
  run(db, priced(P, point('product', '', 'fixed', '1000')));
  run(db, priced(P, discount('product', '', '50')));
  assert.equal(seqOf(db), seq0 + 2, 'each insert bumps inputs_seq');

  // F8: a re-insert and an INSERT OR REPLACE are refused (neither would fire an UPDATE/DELETE trigger).
  refused(db, priced(P, point('product', '', 'fixed', '1100')), /PRICING_INPUT_REINSERT/);
  refused(db, priced(P, point('product', '', 'fixed', '1100').replace('INSERT INTO', 'INSERT OR REPLACE INTO')), /PRICING_INPUT_REINSERT/);
  refused(db, priced(P, discount('product', '', '60')), /PRICING_INPUT_REINSERT/);
  refused(db, priced(P, discount('product', '', '60').replace('INSERT INTO', 'INSERT OR REPLACE INTO')), /PRICING_INPUT_REINSERT/);

  // Updates: the token, a fenced version, never a move to another product.
  refused(db, `UPDATE pricing_price_points SET amount_usd = '1100', version = version + 1 WHERE product_id = '${P}'`, /PRICING_PREVIEW_REQUIRED/);
  refused(db, `UPDATE pricing_preorder_discounts SET amount_usd = '60' WHERE product_id = '${P}'`, /PRICING_PREVIEW_REQUIRED/);
  run(db, priced(P, `UPDATE pricing_price_points SET amount_usd = '1100', version = version + 1 WHERE product_id = '${P}' AND version = 1`));
  run(db, priced(P, `UPDATE pricing_preorder_discounts SET amount_usd = '60', version = version + 1 WHERE product_id = '${P}' AND version = 1`));
  assert.equal(seqOf(db), seq0 + 4, 'each update bumps inputs_seq');
  seedProduct(db, 'v2_q');
  refused(db, tokenSql('engine-price:v2_q', priced(P, `UPDATE pricing_price_points SET product_id = 'v2_q' WHERE product_id = '${P}'`)), /PRICING_PREVIEW_REQUIRED/);

  // Deletes: the token while the product exists.
  refused(db, `DELETE FROM pricing_price_points WHERE product_id = '${P}'`, /PRICING_PREVIEW_REQUIRED/);
  refused(db, `DELETE FROM pricing_preorder_discounts WHERE product_id = '${P}'`, /PRICING_PREVIEW_REQUIRED/);
  run(db, priced(P, `DELETE FROM pricing_preorder_discounts WHERE product_id = '${P}'`));
  assert.equal(seqOf(db), seq0 + 5, 'a delete bumps inputs_seq');

  // The discount's own grammar: ≥ 0 (0 is the explicit «no discount» exception), ≤ 2 decimals, ≤ 100,000.
  run(db, priced(P, discount('product', '', '0')));
  run(db, priced(P, discount('option', `${P}_o1`, '25.5')));
  run(db, priced(P, discount('color', `${P}_c0`, '100000')));
  run(db, priced(P, discount('sku', `o:${P}_o0|c:${P}_c0`, '0.97')));
  for (const [usd, why] of [['-1', 'negative'], ['10.123', 'three decimals'], ['100000.01', 'above 100,000'], ['', 'empty'], ['1e2', 'an exponent']]) {
    assert.throws(() => run(db, priced(P, discount('option', `bad_${why}`, usd!))), CHECK, why);
  }
  assert.throws(() => run(db, priced(P, discount('product', 'x', '5'))), CHECK, 'a product scope with an id');
  assert.throws(() => run(db, priced(P, discount('sku', '', '5'))), CHECK, 'an SKU scope without its key');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

/* --------------------------------------------------------------- results -- */

test('V2 results: P ≤ D, direct sells at D with no Δ, price-first never floors, cost-first names its cost', () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db, P, 'cost');
  run(db, priced(P, result()));
  run(db, priced(P, result({ channel: 'direct_sale', final_price_iqd: 1500000, exact_iqd: '1500000', usd_ceil6: '1000', discount_usd: null, discount_scope: null, discount_scope_id: null })));
  // The canonical product key '' (here, never the stored 'o:*'), a price-first row without cost, a withdrawn discount.
  run(db, priced(P, result({ combo_key: '', method: 'usd', anchor: 'product_fixed', replacement_exact: null, replacement_cost_iqd: null, target_rule_id: null, target_rule_version: null, target_profit_usd: null, shipping_profile: null, supplier_currency: null, fx_rate: null, fx_version: null, shipping_rate: null, shipping_version: null })));
  run(db, priced(P, result({ combo_key: `o:${P}_o1`, final_price_iqd: 1500000, exact_iqd: '1500000', floor: 'discount_withdrawn' })));
  run(db, priced(P, result({ combo_key: `o:${P}_o1|c:${P}_c0`, exact_iqd: '1424999.123456789', deltas_usd: '-35.44', discount_usd: '0', usd_ceil6: '949.999416' })));

  const bad: Array<[Record<string, string | number | null>, string]> = [
    [{ final_price_iqd: 1501000 }, 'P > D'],
    [{ channel: 'direct_sale', final_price_iqd: 1500000 }, 'a direct-sale row with a discount'],
    [{ channel: 'direct_sale', discount_usd: null, discount_scope: null, discount_scope_id: null }, 'direct sale below D'],
    [{ discount_usd: null, discount_scope: null, discount_scope_id: null }, 'a pre-order row without its Δ'],
    [{ method: 'usd', floor: 'discount_withdrawn' }, 'a price-first row with a floor (C-6)'],
    [{ method: 'usd', floor: 'lifted_to_cost' }, 'a price-first row lifted to cost'],
    [{ replacement_exact: null, replacement_cost_iqd: null }, 'a cost-first row without its cost'],
    [{ target_rule_id: null, target_rule_version: null }, 'a cost-first row without its rule'],
    [{ final_price_iqd: 1425500 }, 'a price off the 1,000 step'],
    [{ direct_price_iqd: 1500500 }, 'a direct price off the step'],
    [{ final_price_iqd: 0 }, 'a zero price'],
    [{ exact_iqd: '1.2.3' }, 'an exact figure that is no decimal'],
    [{ exact_iqd: '-1425000' }, 'a negative exact figure'],
    [{ usd_ceil6: '950.1234567' }, 'more than 6 decimals'],
    [{ deltas_usd: '1.234' }, 'a difference with 3 decimals'],
    [{ discount_usd: '-5' }, 'a negative Δ'],
    [{ combo_key: 'x' }, 'a key that is no SKU key'],
    [{ discount_scope: 'product', discount_scope_id: null }, 'a Δ scope without its id'],
    [{ anchor: 'other' }, 'an unknown anchor'],
    [{ floor: 'other' }, 'an unknown floor'],
    [{ channel: 'pre_order' }, 'an unknown channel'],
    [{ fx_version: null }, 'a rate without its version'],
    [{ usd_iqd_rate: '0' }, 'a zero USD/IQD'],
  ];
  for (const [over, why] of bad) {
    const key = { combo_key: `o:bad_${bad.findIndex((b) => b[1] === why)}`, ...over };
    assert.throws(() => run(db, priced(P, result(key))), CHECK, why);
  }
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

test('V2 results are guarded like the SKU price rung (0183): the engine token or the repricing token', () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db, P, 'cost');
  refused(db, result(), /ENGINE_MANAGED/);
  run(db, tokenSql('pricing-rates-apply', result()));
  refused(db, `UPDATE pricing_v2_sku_results SET usd_iqd_rate = '1530' WHERE product_id = '${P}'`, /ENGINE_MANAGED/);
  run(db, priced(P, `UPDATE pricing_v2_sku_results SET usd_iqd_rate = '1530' WHERE product_id = '${P}'`));
  seedProduct(db, 'v2_q');
  refused(db, tokenSql('engine-price:v2_q', priced(P, `UPDATE pricing_v2_sku_results SET product_id = 'v2_q' WHERE product_id = '${P}'`)), /ENGINE_MANAGED/);
  refused(db, `DELETE FROM pricing_v2_sku_results WHERE product_id = '${P}'`, /ENGINE_MANAGED/);
  run(db, priced(P, `DELETE FROM pricing_v2_sku_results WHERE product_id = '${P}'`));
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

/* -------------------------------------------------------------- snapshot -- */

test('the legacy snapshot is append-only: never edited, re-inserted or deleted while the product exists', () => {
  const db = freshDb();
  seedProduct(db);
  run(db, snapshot());
  refused(db, `UPDATE pricing_legacy_snapshots SET payload_json = '{}' WHERE id = 'snap1'`, /PRICING_SNAPSHOT_IMMUTABLE/);
  refused(db, priced(P, `UPDATE pricing_legacy_snapshots SET actor = 'x' WHERE id = 'snap1'`), /PRICING_SNAPSHOT_IMMUTABLE/);
  refused(db, snapshot({ payload_json: '{}' }), /PRICING_SNAPSHOT_IMMUTABLE/);
  refused(db, snapshot({ payload_json: '{}' }).replace('INSERT INTO', 'INSERT OR REPLACE INTO'), /PRICING_SNAPSHOT_IMMUTABLE/);
  refused(db, `DELETE FROM pricing_legacy_snapshots WHERE id = 'snap1'`, /PRICING_SNAPSHOT_IMMUTABLE/);
  refused(db, priced(P, `DELETE FROM pricing_legacy_snapshots WHERE id = 'snap1'`), /PRICING_SNAPSHOT_IMMUTABLE/);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots'), 1);

  const bad: Array<[Record<string, string | number | null>, string]> = [
    [{ payload_json: 'not json' }, 'a payload that is not JSON'],
    [{ payload_sha256: 'a'.repeat(63) }, 'a digest of the wrong length'],
    [{ payload_sha256: 'A'.repeat(64) }, 'an upper-case digest'],
    [{ payload_sha256: 'g'.repeat(64) }, 'a digest that is not hex'],
    [{ reason: 'other' }, 'an unknown reason'],
    [{ payload_version: 2 }, 'an unknown payload version'],
    [{ usd_iqd_rate: '0' }, 'a zero rate'],
    [{ fx_version: 0 }, 'a rate version of 0'],
  ];
  bad.forEach(([over, why], i) => assert.throws(() => run(db, snapshot({ id: `snap_bad_${i}`, ...over })), CHECK, why));

  // Only the permanent deletion's own token releases it while the product exists.
  run(db, tokenSql(`product-delete:${P}`, `DELETE FROM pricing_legacy_snapshots WHERE id = 'snap1'`));
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots'), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

test('a cascade takes the points, the discount, the results and the snapshot with their product', () => {
  const db = freshDb();
  db.exec(`INSERT INTO products (id, slug, name, price_iqd) VALUES ('${P}', '${P}', 'Bare', 1500000)`);
  makeEngine(db, P, 'cost');
  run(db, priced(P, point('product', '', 'fixed', '1000')));
  run(db, priced(P, discount('product', '', '50')));
  run(db, priced(P, result({ combo_key: '' })));
  run(db, snapshot());
  db.exec(`DELETE FROM products WHERE id = '${P}'`);
  for (const t of ['pricing_price_points', 'pricing_preorder_discounts', 'pricing_v2_sku_results', 'pricing_legacy_snapshots', 'product_pricing_state']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE product_id = ?`, P), 0, t);
  }
});

/* ------------------------------------------------------------------ fees -- */

test('fees stay 0 on a V2 product; a V1 engine product and a manual product are untouched', () => {
  const db = freshDb();
  for (const id of [P, 'v1_p', 'manual_p']) seedProduct(db, id);
  makeEngine(db, P, 'usd');
  makeEngine(db, 'v1_p', null);
  const surcharge = (id: string, v: string) => priced(id, `UPDATE products SET direct_surcharge_iqd = ${v} WHERE id = '${id}'`);
  const routes = (id: string, json: string) => `UPDATE products SET preorder_transports = '${json}' WHERE id = '${id}'`;

  refused(db, surcharge(P, '1000'), /PRICING_V2_FEES_RETIRED/);
  run(db, surcharge(P, '0'));
  run(db, surcharge(P, 'NULL'));
  refused(db, routes(P, '[{"method":"air","commission_iqd":5000}]'), /PRICING_V2_FEES_RETIRED/);
  refused(db, routes(P, '[{"method":"air"}]'), /PRICING_V2_FEES_RETIRED/);
  refused(db, routes(P, '[{"method":"air","commission_iqd":null}]'), /PRICING_V2_FEES_RETIRED/);
  refused(db, routes(P, '[{"method":"air","commission_iqd":0},{"method":"sea","commission_iqd":1000}]'), /PRICING_V2_FEES_RETIRED/);
  run(db, routes(P, '[{"method":"air","commission_iqd":0},{"method":"sea","commission_iqd":0}]'));
  run(db, routes(P, '[]'));
  // An unrelated column on the same row is not this trigger's business.
  run(db, `UPDATE products SET name = 'Renamed', stock = 7 WHERE id = '${P}'`);

  for (const id of ['v1_p', 'manual_p']) {
    run(db, surcharge(id, '2000'));
    run(db, routes(id, '[{"method":"air","commission_iqd":5000},{"method":"sea"}]'));
  }
  assert.equal(row(db, "SELECT direct_surcharge_iqd AS v FROM products WHERE id = 'v1_p'")!.v, 2000);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

/* --------------------------------------------------------------- SKU key -- */

test("the option-less product's stored key 'o:*' passes the 0183 CHECK while '' is still refused; option id '*' is reserved", async () => {
  assert.equal(PRODUCT_SKU_ROW_KEY, 'o:*');
  assert.equal(storedSkuKey(PRODUCT_COMBO_KEY), 'o:*');
  assert.equal(skuKeyOfStored('o:*'), PRODUCT_COMBO_KEY);
  const db = freshDb();
  seedProduct(db);
  makeEngine(db, P, 'usd');
  const sku = (key: string) =>
    `INSERT INTO product_sku_prices (product_id, combo_key, channel, regular_price_iqd, write_seq, updated_at) VALUES ('${P}', '${key}', 'direct_sale', 1500000, 1, '${NOW}')`;
  run(db, priced(P, sku(storedSkuKey(''))));
  refused(db, priced(P, sku('')), CHECK);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM product_sku_prices WHERE combo_key = 'o:*'"), 1);

  // The database refuses the id '*' for any option value, on any product…
  refused(db, `INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('*', 'manual_p', '${P}_g', 'Star', 9, 1)`, /OPTION_ID_RESERVED/);
  db.exec("INSERT INTO products (id, slug, name, price_iqd) VALUES ('manual_p', 'manual_p', 'Manual', 1000)");
  db.exec("INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('manual_g', 'manual_p', 'Model', 0, 1)");
  refused(db, "INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('*', 'manual_p', 'manual_g', 'Star', 0, 1)", /OPTION_ID_RESERVED/);
  db.exec("INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('star', 'manual_p', 'manual_g', 'Star', 0, 1)");

  // …and the relations planner says so with a 400 before any statement exists.
  const d1 = asD1(db);
  const snap = await loadRelationsSnapshot(d1, 'manual_p');
  const plan = await planRelationsWriteFrom(
    d1,
    snap,
    { groups: [{ id: 'manual_g', name_en: 'Model', values: [{ id: '*', name_en: 'Star' }] }], colors: [], variants: [], images: [] },
    { money: true }
  );
  assert.ok(!plan.stmts, 'a value with the reserved id is never planned');
  assert.ok(plan.errors.some((e) => /OPTION_ID_RESERVED/.test(e)), plan.errors.join(' | '));
});

/* ---------------------------------------------------------------- re-run -- */

test('a migrate-check-style re-run of 0189 changes nothing', () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db, P, 'cost');
  seedV2Sentinels(db, P, `${P}_o0`, `${P}_c0`);
  const schema = () => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all());
  const contents = () =>
    JSON.stringify(
      ['product_pricing_state', 'pricing_price_points', 'pricing_preorder_discounts', 'pricing_v2_sku_results', 'pricing_legacy_snapshots'].map((t) =>
        db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()
      )
    );
  const [schemaBefore, contentsBefore] = [schema(), contents()];
  const statements = (splitStatements(readFileSync(join(ROOT, 'migrations/0189_pricing_v2_core.sql'), 'utf8')) as string[]).filter(
    (s) => !/^ALTER\s+TABLE/i.test(s)
  );
  assert.ok(statements.length >= 25, `only ${statements.length} re-runnable statements`);
  assert.ok(statements.every((s) => /^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) IF NOT EXISTS/i.test(s)), 'every statement but the two ADD COLUMNs is re-runnable');
  db.exec('BEGIN');
  for (const s of statements) db.exec(s);
  db.exec('COMMIT');
  assert.equal(schema(), schemaBefore, 'no table, index or trigger changed');
  assert.equal(contents(), contentsBefore, 'no row added or changed');
});

/* -------------------------------------------------------------- deletion -- */

for (const foreignKeys of [true, false]) {
  test(`a V2 product is deleted like any other; its private rows count as pricing_engine and no token stays (foreign keys ${foreignKeys ? 'on' : 'off'})`, async () => {
    const db = freshDb();
    if (!foreignKeys) db.exec('PRAGMA foreign_keys = OFF');
    seedProduct(db);
    makeEngine(db, P, 'cost');
    seedV2Sentinels(db, P, `${P}_o0`, `${P}_c0`);
    const before = {
      points: count(db, 'SELECT COUNT(*) AS n FROM pricing_price_points WHERE product_id = ?', P),
      discounts: count(db, 'SELECT COUNT(*) AS n FROM pricing_preorder_discounts WHERE product_id = ?', P),
      results: count(db, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ?', P),
      snapshots: count(db, 'SELECT COUNT(*) AS n FROM pricing_legacy_snapshots WHERE product_id = ?', P),
    };
    assert.deepEqual(before, { points: 4, discounts: 2, results: 2, snapshots: 1 });

    const out = await deleteProductPermanently(asD1(db), P, { newId: () => `job-${Math.random()}` });
    assert.equal(out.product_deleted, true);
    for (const t of ['products', 'product_pricing_state', 'pricing_price_points', 'pricing_preorder_discounts', 'pricing_v2_sku_results', 'pricing_legacy_snapshots']) {
      assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'products' ? 'id' : 'product_id'} = ?`, P), 0, t);
    }
    // The state row and the nine V2 rows, under the neutral name only (their own names are private vocabulary).
    assert.equal(out.rows_deleted_by_table.pricing_engine, 1 + 4 + 2 + 2 + 1);
    for (const t of ['pricing_price_points', 'pricing_preorder_discounts', 'pricing_v2_sku_results', 'pricing_legacy_snapshots', 'ops_guards']) {
      assert.equal(t in out.rows_deleted_by_table, false, t);
    }
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0, 'every deletion token is removed in the same batch');
  });
}

test('a failed deletion of a V2 product restores every V2 row and leaves no token', async () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db, P, 'usd');
  seedV2Sentinels(db, P, `${P}_o0`, `${P}_c0`);
  const dump = () =>
    JSON.stringify(['pricing_price_points', 'pricing_preorder_discounts', 'pricing_v2_sku_results', 'pricing_legacy_snapshots', 'product_pricing_state'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const before = dump();
  db.exec("CREATE TRIGGER refuse_final_product_delete BEFORE DELETE ON products BEGIN SELECT RAISE(ABORT, 'test_delete_failed'); END");
  await assert.rejects(deleteProductPermanently(asD1(db), P), /test_delete_failed/);
  assert.equal(dump(), before);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});

/* -------------------------------------------------------------- refusals -- */

test("0189's three database refusals reach the client as a 409 with their code in three languages — never their SQL", async () => {
  const db = freshDb();
  seedProduct(db);
  makeEngine(db, P, 'cost');
  run(db, snapshot());
  const d1 = asD1(db);
  const attempts: Array<[string, string]> = [
    [`UPDATE products SET preorder_transports = '[{"method":"air","commission_iqd":5000}]' WHERE id = '${P}'`, 'PRICING_V2_FEES_RETIRED'],
    [`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('*', '${P}', '${P}_g', 'Star', 9, 1)`, 'OPTION_ID_RESERVED'],
    [`UPDATE pricing_legacy_snapshots SET actor = 'x' WHERE id = 'snap1'`, 'PRICING_SNAPSHOT_IMMUTABLE'],
  ];
  for (const [sql, code] of attempts) {
    let caught: unknown = null;
    try {
      await d1.prepare(sql).run();
    } catch (e) {
      caught = e;
    }
    assert.equal(engineDbRefusalCode(caught), code, sql);
    const http = engineDbRefusal(caught);
    assert.ok(http instanceof HttpError);
    assert.equal(http.status, 409);
    assert.equal(http.code, code);
    assert.doesNotMatch(http.message, /UPDATE |INSERT INTO|SQLITE|preorder_transports|pricing_legacy_snapshots|product_option_values|commission_iqd/);
    const t = COST_REFUSALS[code as keyof typeof COST_REFUSALS];
    assert.ok(t.ar && t.en && t.ckb, code);
    assert.notEqual(t.ckb, t.ar, `${code}: ckb is its own Sorani (row 183)`);
  }
  // Whole word: a longer code is never read as one of these.
  assert.equal(engineDbRefusalCode(new Error('PRICING_V2_FEES_RETIRED_SOON')), null);
});

/* ---------------------------------------------------------- deploy-ahead -- */

test('deploy-ahead: on a 0188 database nothing is V2 — the installed checks say no, and yes once 0189 lands', async () => {
  const old = asD1(dbThrough('0188'));
  assert.equal(await pricingV2Installed(old), false);
  assert.equal(await engineColumnInstalled(old, 'product_pricing_state', 'pricing_method'), false);
  const now = asD1(freshDb());
  assert.equal(await pricingV2Installed(now), true);
  assert.equal(await pricingV2Installed(now), true, 'remembered');
  assert.equal(await engineColumnInstalled(now, 'product_pricing_state', 'pricing_method'), true);
  assert.equal(await engineColumnInstalled(now, 'product_pricing_state', 'v2_since'), true);
});

/* ------------------------------------------------------------ role matrix -- */

test('the role matrix seeds the V2 sentinels on its costly product without making it V2', async () => {
  const { seededCopy } = await import('./fixtures/roleMatrix');
  const db = seededCopy();
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM pricing_price_points WHERE product_id = 'p_a1'"), 4);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM pricing_preorder_discounts WHERE product_id = 'p_a1'"), 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = 'p_a1'"), 2);
  assert.equal(row(db, "SELECT payload_json AS p FROM pricing_legacy_snapshots WHERE product_id = 'p_a1'")!.p, V2_SENTINEL_SNAPSHOT_PAYLOAD);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM product_pricing_state WHERE product_id = 'p_a1' AND pricing_method IS NOT NULL"), 0);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM ops_guards'), 0);
});
