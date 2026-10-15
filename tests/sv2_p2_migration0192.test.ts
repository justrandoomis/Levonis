/**
 * MIGRATION 0192 (Services V2, S-P2, DECISIONS row 238) AGAINST THE DATA THE
 * LIVE DATABASE ALREADY HOLDS.
 *
 * The file is additive: nullable or defaulted columns, four new tables, new
 * triggers. It updates and deletes no row, rebuilds no table, widens no CHECK,
 * and its only uniqueness rules live on the new (empty) tables. Trade-in
 * requests in every status, their coupons (with and without an end), the
 * orders that spent them, wallet, gift and lot rows must come through byte for
 * byte; afterwards the triggers refuse NEW writes only:
 *
 *   8   no trade-in credit is spent, or reclaimed by a reopen, before the device's intake
 *   7   intake is stamped once
 *   9   a delivered order that completed a trade-in is never cancelled
 *   10  cancelling an undelivered order of a completed request gives the same coupon back for 30 days, once
 *   *   the valuation record, the stock provenance and the re-issues refuse rewrites
 *
 * Run: node --import tsx --test tests/sv2_p2_migration0192.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { all, count, dbThrough, row } from './fixtures/app';
// @ts-expect-error — plain JS module shared with scripts/
import { splitStatements } from '../scripts/lib/sql-split.mjs';

const MIGRATION = readFileSync(new URL('../migrations/0192_trade_in_v2.sql', import.meta.url), 'utf8');
const LONG_AGO = '2026-01-10T10:00:00.000Z';
const STATUSES = ['draft', 'submitted', 'under_review', 'value_changed', 'customer_rejected', 'awaiting_payment', 'completed', 'cancelled'] as const;

/** A database at 0191 holding a trade-in in every status, with the coupons and orders the old flow left. */
function legacyWorld(): DatabaseSync {
  const raw = dbThrough('0191');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u_a','Sara','a@x.co','h','customer'), ('boss','Ali','boss@x.co','h','admin');
    INSERT INTO products (id,slug,name,price_iqd,status,stock) VALUES ('p1','p1','Bambu A1',899000,'active',5), ('p2','p2','Bambu P1S',1500000,'active',5);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at) VALUES
      ('ORD-OLD','u_a','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'${LONG_AGO}','${LONG_AGO}'),
      ('ORD-LIVE','u_a','pending','{}','standard','{}','cash',1500000,0,1400,955000,955000,'${LONG_AGO}','${LONG_AGO}'),
      ('ORD-DONE','u_a','delivered','{}','standard','{}','cash',1500000,0,1400,955000,0,'${LONG_AGO}','${LONG_AGO}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES
      ('oi_old','ORD-OLD','p1','Bambu A1',${STATUSES.length},899000,${899000 * STATUSES.length}),
      ('oi_live','ORD-LIVE','p2','Bambu P1S',1,1500000,1500000),
      ('oi_done','ORD-DONE','p2','Bambu P1S',1,1500000,1500000);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,amount_iqd,exchange_rate_snapshot)
      VALUES ('wtx_legacy','u_a','deposit','USD',100,'approved',1400,1400);
    INSERT INTO gift_entitlements (id,user_id,max_level,state,grant_mode,reason,level) VALUES ('gift_legacy','u_a',2,'granted','level','admin_gift',2);
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
      VALUES ('lot_legacy','p1','base','',3,2,700000,2100000,'received','${LONG_AGO}');
  `);
  STATUSES.forEach((status, i) => {
    raw.exec(`INSERT INTO trade_in_requests (id,user_id,status,order_id,order_item_id,unit_index,family,estimated_iqd,final_value_iqd,credit_iqd,created_at,updated_at)
              VALUES ('tin_${status}','u_a','${status}','ORD-OLD','oi_old',${i + 1},'fdm',545000,
                      ${status === 'awaiting_payment' || status === 'completed' ? 545000 : 'NULL'},
                      ${status === 'awaiting_payment' || status === 'completed' ? 545000 : 'NULL'},'${LONG_AGO}','${LONG_AGO}')`);
  });
  // Credits minted on photos before S-P2: one with no end (before row 228), one spent by a live order, one completed.
  raw.exec(`
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, assigned_user_id, trade_in_id, ends_at) VALUES
      ('cpn_await','TIAWAIT00000','fixed_iqd',545000,0,1,1,1,'u_a','tin_awaiting_payment',NULL),
      ('cpn_done','TIDONE000000','fixed_iqd',545000,0,1,1,1,'u_a','tin_completed','2026-02-01T00:00:00.000Z');
    UPDATE trade_in_requests SET coupon_id = 'cpn_await' WHERE id = 'tin_awaiting_payment';
    UPDATE trade_in_requests SET coupon_id = 'cpn_done' WHERE id = 'tin_completed';
    INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, created_at) VALUES
      ('r_live','cpn_await','u_a','ORD-LIVE',545000,'${LONG_AGO}'),
      ('r_done','cpn_done','u_a','ORD-DONE',545000,'${LONG_AGO}');
  `);
  return raw;
}

const HASHED = ['orders', 'order_items', 'wallet_transactions', 'gift_entitlements', 'inventory_lots', 'coupons', 'coupon_redemptions', 'trade_in_requests', 'trade_in_events'] as const;

/** One hash per table over the columns it had at 0191, every row, in rowid order. */
function hashes(raw: DatabaseSync, columns: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of HASHED) {
    const rows = all(raw, `SELECT ${columns[t].map((c) => `"${c}"`).join(', ')} FROM ${t} ORDER BY rowid`);
    out[t] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return out;
}
const columnsOf = (raw: DatabaseSync) => Object.fromEntries(HASHED.map((t) => [t, all<{ name: string }>(raw, `PRAGMA table_info(${t})`).map((c) => c.name)]));

const abort = (raw: DatabaseSync, sql: string, code: RegExp) => assert.throws(() => raw.exec(sql), code);

test('old rows: 0192 changes no byte of any existing order, line, wallet, gift, lot, coupon or trade-in row', () => {
  const raw = legacyWorld();
  const cols = columnsOf(raw);
  const before = hashes(raw, cols);
  const indexes = () => all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name").map((r) => r.name);
  const indexesBefore = indexes();
  raw.exec(MIGRATION);
  assert.deepEqual(hashes(raw, cols), before);
  // New indexes only on the new columns; nothing unique over an existing table.
  const added = indexes().filter((n) => !indexesBefore.includes(n));
  assert.deepEqual(added.sort(), ['idx_trade_in_requests_intake', 'idx_trade_in_requests_offer_expiry', 'idx_trade_in_valuations_request'].sort());
  // Every old request reads as v1, not received, never above a ceiling.
  for (const s of STATUSES) {
    const r = row<{ valuation_version: number; intake_at: string | null; above_ceiling: number; pickup_fee_iqd: number; intake_json: string }>(
      raw,
      'SELECT valuation_version, intake_at, above_ceiling, pickup_fee_iqd, intake_json FROM trade_in_requests WHERE id = ?',
      `tin_${s}`
    )!;
    assert.deepEqual(r, { valuation_version: 1, intake_at: null, above_ceiling: 0, pickup_fee_iqd: 0, intake_json: '{}' });
  }
  // The file itself writes no row anywhere (the new tables are empty).
  for (const t of ['trade_in_valuations', 'trade_in_component_refs', 'trade_in_stock', 'trade_in_credit_reissues']) {
    assert.equal(count(raw, `SELECT COUNT(*) AS n FROM ${t}`), 0, t);
  }
  // Applying it again (migrate-check --twice re-runs the IF NOT EXISTS statements) changes nothing.
  const after = hashes(raw, cols);
  for (const stmt of (splitStatements(MIGRATION) as string[]).filter((x) => /CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS/.test(x))) raw.exec(stmt);
  assert.deepEqual(hashes(raw, cols), after);
});

test('8: a credit minted before intake is not spent — insert or reopen — until the device is received', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  raw.exec(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                                subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at)
            VALUES ('ORD-NEW','u_a','pending','{}','standard','{}','cash',1500000,0,1400,955000,955000,'${LONG_AGO}','${LONG_AGO}')`);
  // Release the live order's use (cancel) so the limit trigger is not the one answering.
  raw.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-LIVE'`);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_live'")!.state, 'released');
  abort(raw, `INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('r_new','cpn_await','u_a','ORD-NEW',545000)`, /TRADE_IN_DEVICE_NOT_RECEIVED/);
  // The reopen takes the use back: refused while the device is not received.
  abort(raw, `UPDATE orders SET status = 'pending' WHERE id = 'ORD-LIVE'`, /TRADE_IN_DEVICE_NOT_RECEIVED/);
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM orders WHERE id = 'ORD-LIVE'")!.status, 'cancelled');
  // Received: both pass.
  raw.exec(`UPDATE trade_in_requests SET intake_at = '${new Date().toISOString()}' WHERE id = 'tin_awaiting_payment'`);
  raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('r_new','cpn_await','u_a','ORD-NEW',545000)`);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_await' AND state = 'active'"), 1);
  // An ordinary coupon is untouched by the rule.
  raw.exec(`INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active) VALUES ('cpn_promo','PROMO5K','fixed_iqd',5000,0,NULL,1,1)`);
  raw.exec(`INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                                subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at)
            VALUES ('ORD-P','u_a','pending','{}','standard','{}','cash',10000,0,1400,5000,5000,'${LONG_AGO}','${LONG_AGO}')`);
  raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('r_p','cpn_promo','u_a','ORD-P',5000)`);
});

test('7: intake is stamped once', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  raw.exec(`UPDATE trade_in_requests SET intake_at = '2026-10-15T10:00:00.000Z' WHERE id = 'tin_submitted'`);
  abort(raw, `UPDATE trade_in_requests SET intake_at = '2026-10-16T10:00:00.000Z' WHERE id = 'tin_submitted'`, /TRADE_IN_ALREADY_RECEIVED/);
  abort(raw, `UPDATE trade_in_requests SET intake_at = NULL WHERE id = 'tin_submitted'`, /TRADE_IN_ALREADY_RECEIVED/);
  // Writing the same value (another column's update) is not a second intake.
  raw.exec(`UPDATE trade_in_requests SET intake_at = intake_at, updated_at = 'x' WHERE id = 'tin_submitted'`);
});

test('9: a delivered order that completed a trade-in is returned, never cancelled', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  abort(raw, `UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-DONE'`, /TRADE_IN_ORDER_DELIVERED/);
  // A delivered order without a completed trade-in keeps its old behaviour.
  raw.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-OLD'`);
});

test('10: cancelling the undelivered order of a completed request re-issues the same coupon for 30 days — once, with one event', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  // A legacy completion before delivery: the live order belongs to the completed request.
  raw.exec(`UPDATE coupon_redemptions SET coupon_id = 'cpn_done' WHERE id = 'r_live'`);
  raw.exec(`DELETE FROM coupon_redemptions WHERE id = 'r_done'`);
  const t0 = Date.now();
  raw.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-LIVE'`);
  const x = row<{ coupon_id: string; reason: string; amount_iqd: number; ends_at: string }>(raw, "SELECT coupon_id, reason, amount_iqd, ends_at FROM trade_in_credit_reissues WHERE request_id = 'tin_completed'")!;
  assert.equal(x.coupon_id, 'cpn_done');
  assert.equal(x.reason, 'order_cancelled');
  assert.equal(x.amount_iqd, 545000);
  assert.ok(Math.abs(Date.parse(x.ends_at) - (t0 + 30 * 86_400_000)) < 60_000, x.ends_at);
  assert.equal(row<{ ends_at: string }>(raw, "SELECT ends_at FROM coupons WHERE id = 'cpn_done'")!.ends_at, x.ends_at);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_live'")!.state, 'released', '0191 released the use');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = 'tin_completed' AND action = 'credit_reissued'"), 1);
  // Reopen (needs intake: trigger 8) and cancel again: no second re-issue, no second event.
  raw.exec(`UPDATE trade_in_requests SET intake_at = '${new Date().toISOString()}' WHERE id = 'tin_completed'`);
  raw.exec(`UPDATE orders SET status = 'pending' WHERE id = 'ORD-LIVE'`);
  raw.exec(`UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-LIVE'`);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_credit_reissues'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE action = 'credit_reissued'"), 1);
  // The awaiting request's live order cancelled: no re-issue (0191 gives that credit its held time instead).
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_credit_reissues WHERE request_id = 'tin_awaiting_payment'"), 0);
});

test('the new tables refuse rewrites; the lot of a trade-in cannot be inserted twice', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  const now = new Date().toISOString();
  raw.exec(`INSERT INTO trade_in_valuations (id, request_id, phase, offer_iqd, created_at) VALUES ('tiv_1','tin_submitted','submit',545000,'${now}')`);
  abort(raw, `UPDATE trade_in_valuations SET offer_iqd = 1 WHERE id = 'tiv_1'`, /TRADE_IN_VALUATION_IMMUTABLE/);
  abort(raw, `DELETE FROM trade_in_valuations WHERE id = 'tiv_1'`, /TRADE_IN_VALUATION_IMMUTABLE/);
  abort(raw, `INSERT OR REPLACE INTO trade_in_valuations (id, request_id, phase, created_at) VALUES ('tiv_1','tin_submitted','submit','${now}')`, /TRADE_IN_VALUATION_IMMUTABLE/);
  raw.exec(`INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
            VALUES ('ilot_ti_tin_completed','p1','base','',1,1,545000,545000,'received','${now}')`);
  raw.exec(`INSERT INTO trade_in_stock (request_id, lot_id, product_id, cost_basis_iqd, order_id, created_at) VALUES ('tin_completed','ilot_ti_tin_completed','p1',545000,'ORD-DONE','${now}')`);
  abort(raw, `UPDATE trade_in_stock SET cost_basis_iqd = 1`, /TRADE_IN_STOCK_IMMUTABLE/);
  abort(raw, `DELETE FROM trade_in_stock`, /TRADE_IN_STOCK_IMMUTABLE/);
  abort(raw, `INSERT OR REPLACE INTO trade_in_stock (request_id, lot_id, product_id, cost_basis_iqd, order_id, created_at) VALUES ('tin_completed','ilot_x','p1',1,'ORD-DONE','${now}')`, /TRADE_IN_STOCK_IMMUTABLE/);
  abort(raw, `INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
              VALUES ('ilot_ti_tin_completed','p1','base','',1,1,1,1,'received','${now}')`, /BATCH_COST_IMMUTABLE|UNIQUE/);
  raw.exec(`INSERT INTO trade_in_credit_reissues (id, request_id, coupon_id, order_id, reason, amount_iqd, ends_at, created_at)
            VALUES ('tcr_1','tin_completed','cpn_done','ORD-LIVE','returned',545000,'${now}','${now}')`);
  abort(raw, `UPDATE trade_in_credit_reissues SET amount_iqd = 1`, /TRADE_IN_REISSUE_IMMUTABLE/);
  abort(raw, `DELETE FROM trade_in_credit_reissues`, /TRADE_IN_REISSUE_IMMUTABLE/);
  abort(raw, `INSERT INTO trade_in_credit_reissues (id, request_id, coupon_id, order_id, reason, amount_iqd, ends_at, created_at)
              VALUES ('tcr_2','tin_completed','cpn_done','ORD-LIVE','order_cancelled',1,'${now}','${now}')`, /UNIQUE/);
  // The CHECKs on the new columns refuse a value outside their range.
  abort(raw, `UPDATE trade_in_rule_sets SET max_offer_bp = 9600`, /CHECK/);
  abort(raw, `INSERT INTO trade_in_component_refs (product_id, option_value_id, role, ref_price_usd, updated_at) VALUES ('p1','','ams','1.234','${now}')`, /CHECK/);
  raw.exec(`INSERT INTO trade_in_component_refs (product_id, option_value_id, role, ref_price_usd, updated_at) VALUES ('p1','','ams','219.99','${now}')`);
});
