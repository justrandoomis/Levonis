/**
 * MIGRATION 0191 (Services V2, S-P1, DECISIONS row 237) AGAINST THE DATA THE
 * LIVE DATABASE ALREADY HOLDS.
 *
 * The file is additive: four nullable columns, one trigger replaced, new
 * triggers. It updates and deletes no row, rebuilds no table, widens no CHECK
 * and builds no unique index over existing rows — the live database may
 * already hold two open warranty claims on one device, two «requested»
 * protection claims on one line, and coupon uses of orders cancelled before
 * this file. Those rows must come through the migration byte for byte, and
 * stay workable afterwards: the triggers refuse NEW writes only.
 *
 *   old rows   a database at 0190 with every kind of legacy row; hashes of the
 *              money and service tables are equal before and after 0191
 *   workable   the legacy duplicates still advance, close and are decided; a
 *              cancelled order's use from before 0191 stays spent (no backfill)
 *              and its reopen takes nothing twice
 *   ahead      this code over a database still at 0190 (a manual redeploy, or
 *              the minutes before workflow 7's migration step): the claim door
 *              files without the new columns and still keeps one open case per
 *              device, inside its own insert
 *   legacy     an order cancelled before 0191 (its trade-in use still 'active')
 *   reopen     and reopened after it: never with a switched-off credit (its
 *              request cancelled, or a second coupon minted by the old code),
 *              a live one fences the second coupon, and the time it sat
 *              cancelled counts against the credit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { dbThrough, row, all, asD1, stubApp, get, post, patch, json, count, pending } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { adminRoutes } from '../worker/routes/admin';
import { deviceRoutes } from '../worker/routes/devices';
import { claimFiledColumnsInstalled } from '../worker/lib/deviceOps';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';
import { RaceD1 } from './fixtures/raceD1';
import { ppWorld } from './sv2_price-protection_fixture';
import { OWNER, adminApp, customerApp, checkoutBody, received, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const MIGRATION = readFileSync(new URL('../migrations/0191_services_integrity.sql', import.meta.url), 'utf8');
const LONG_AGO = '2026-01-10T10:00:00.000Z';

/** A database at 0190 holding one of each legacy shape 0191 must leave alone. */
function legacyWorld(): DatabaseSync {
  const raw = dbThrough('0190');
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('u_a','Sara','a@x.co','h','customer'), ('u_b','Omar','b@x.co','h','customer'), ('boss','Ali','boss@x.co','h','admin');
    INSERT INTO products (id,slug,name,price_iqd,status,stock) VALUES ('p1','p1','Bambu A1',899000,'active',5);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at) VALUES
      ('ORD-D','u_a','delivered','{}','standard','{}','cash',899000,0,1400,894000,0,'${LONG_AGO}','${LONG_AGO}'),
      ('ORD-C','u_a','pending','{}','standard','{}','cash',899000,0,1400,894000,894000,'${LONG_AGO}','${LONG_AGO}'),
      ('ORD-P','u_b','pending','{}','standard','{}','cash',899000,0,1400,899000,899000,'${LONG_AGO}','${LONG_AGO}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES
      ('oi_d','ORD-D','p1','Bambu A1',1,899000,899000),
      ('oi_c','ORD-C','p1','Bambu A1',1,899000,899000),
      ('oi_p','ORD-P','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_start_at,warranty_end_at)
      VALUES ('unit_d','ORD-D','oi_d','p1','u_a',1,'${LONG_AGO}',12,'${LONG_AGO}','2027-01-10T10:00:00.000Z');
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, max_global, active) VALUES
      ('cpn_once','ONCE5K','fixed_iqd',5000,0,1,NULL,1), ('cpn_off','OFF5K','fixed_iqd',5000,0,1,NULL,0);
    INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, created_at) VALUES
      ('r_d','cpn_once','u_a','ORD-D',5000,'${LONG_AGO}'),
      ('r_c','cpn_off','u_a','ORD-C',5000,'${LONG_AGO}');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,amount_iqd,exchange_rate_snapshot)
      VALUES ('wtx_legacy','u_a','deposit','USD',100,'approved',1400,1400);
    INSERT INTO gift_entitlements (id,user_id,max_level,state,grant_mode,reason,level) VALUES ('gift_legacy','u_a',2,'granted','level','admin_gift',2);
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
      VALUES ('lot_legacy','p1','base','',3,2,700000,2100000,'received','${LONG_AGO}');
    -- Two OPEN claims on one device, and a legacy-status one (stage NULL) — the live data W-3 may meet.
    INSERT INTO warranty_claims (id,user_id,order_item_id,product_name,description,unit_id,stage,status,created_at) VALUES
      ('wc_1','u_a','oi_d','Bambu A1','first','unit_d','received','submitted','${LONG_AGO}'),
      ('wc_2','u_a','oi_d','Bambu A1','second','unit_d','diagnosing','in_review','${LONG_AGO}'),
      ('wc_3','u_a','oi_d','Bambu A1','legacy',  'unit_d',NULL,'in_review','${LONG_AGO}');
    -- Two «requested» protection claims on one line — the race G3 closes, already in the data.
    INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state) VALUES
      ('ppc_1','u_a','ORD-D','oi_d',899000,850000,1,'requested'),
      ('ppc_2','u_a','ORD-D','oi_d',899000,840000,1,'requested');
  `);
  // An order cancelled before 0191: its coupon use is still 'active'.
  raw.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-C'");
  return raw;
}

const HASHED = [
  'orders',
  'order_items',
  'order_item_units',
  'wallet_transactions',
  'gift_entitlements',
  'inventory_lots',
  'coupons',
  'coupon_redemptions',
  'warranty_claims',
  'price_protection_claims',
] as const;

/** One hash per table over the columns it had at 0190, every row, in rowid order. */
function hashes(raw: DatabaseSync, columns: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of HASHED) {
    const rows = all(raw, `SELECT ${columns[t].map((c) => `"${c}"`).join(', ')} FROM ${t} ORDER BY rowid`);
    out[t] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  }
  return out;
}
const columnsOf = (raw: DatabaseSync) =>
  Object.fromEntries(HASHED.map((t) => [t, all<{ name: string }>(raw, `PRAGMA table_info(${t})`).map((c) => c.name)]));

test('old rows: 0191 changes no byte of any existing money or service row', () => {
  const raw = legacyWorld();
  const cols = columnsOf(raw);
  const before = hashes(raw, cols);
  const indexes = () => all(raw, "SELECT name, sql FROM sqlite_master WHERE type = 'index' ORDER BY name");
  const indexesBefore = indexes();
  const counts = Object.fromEntries(HASHED.map((t) => [t, row<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM ${t}`)!.n]));
  raw.exec(MIGRATION);
  assert.deepEqual(hashes(raw, cols), before);
  assert.deepEqual(Object.fromEntries(HASHED.map((t) => [t, row<{ n: number }>(raw, `SELECT COUNT(*) AS n FROM ${t}`)!.n])), counts);
  // The new columns exist and say nothing about the old claims.
  assert.deepEqual(
    all(raw, 'SELECT filed_cover_state, filed_cover_via, filed_cover_end_at, filed_policy_version FROM warranty_claims'),
    [0, 1, 2].map(() => ({ filed_cover_state: null, filed_cover_via: null, filed_cover_end_at: null, filed_policy_version: null }))
  );
  // No index was built over the old rows: every rule is a trigger.
  assert.deepEqual(indexes(), indexesBefore);
  const triggers = all<{ name: string }>(raw, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_claim_filed_cover_frozen','trg_one_open_case_per_unit','trg_one_open_case_per_unit_reopen','ppc_one_open','trg_coupon_redemption_limits','trg_coupon_redemption_reclaim','trg_trade_in_one_credit','trg_orders_coupon_released','trg_orders_coupon_reclaimed','trg_orders_reopen_coupon_inactive') ORDER BY name");
  assert.equal(triggers.length, 10, JSON.stringify(triggers));
});

test('workable: the legacy duplicates still advance, close and are decided; an old cancellation keeps its use', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  // Two open claims on one device: each still moves between open stages, and closes.
  for (const id of ['wc_1', 'wc_2']) {
    raw.prepare("UPDATE warranty_claims SET stage = 'diagnosing', status = 'in_review' WHERE id = ?").run(id);
    raw.prepare("UPDATE warranty_claims SET stage = 'approved', status = 'approved' WHERE id = ?").run(id);
  }
  raw.prepare("UPDATE warranty_claims SET stage = 'repairing' WHERE id = 'wc_3'").run();
  for (const id of ['wc_1', 'wc_2', 'wc_3']) raw.prepare("UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = ?").run(id);
  // …and once every one is closed, a new claim may open.
  raw.exec("INSERT INTO warranty_claims (id,user_id,order_item_id,product_name,description,unit_id,stage,status) VALUES ('wc_new','u_a','oi_d','Bambu A1','new','unit_d','received','submitted')");

  // Two requested protection claims: both are decided as before.
  raw.exec("UPDATE price_protection_claims SET state = 'rejected' WHERE id = 'ppc_1'");
  raw.exec("UPDATE price_protection_claims SET state = 'credited', credited_iqd = 59000 WHERE id = 'ppc_2'");
  assert.deepEqual(all(raw, 'SELECT id, state FROM price_protection_claims ORDER BY id'), [
    { id: 'ppc_1', state: 'rejected' },
    { id: 'ppc_2', state: 'credited' },
  ]);

  // An order cancelled before 0191: no backfill — its use stays spent.
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_c'")!.state, 'active');
  // Re-opening it takes nothing twice (its use was never released), even for a coupon since switched off.
  raw.exec("UPDATE orders SET status = 'pending' WHERE id = 'ORD-C'");
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_c'")!.state, 'active');
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_off'")!.n, 1);
  // A delivered order's use is never released by a cancel (it was received).
  raw.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-D'");
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_d'")!.state, 'active');
});

test('the rules refuse NEW writes only, with the codes the routes map', () => {
  const raw = legacyWorld();
  raw.exec(MIGRATION);
  // W-3: a third open claim on a device that already holds open ones.
  assert.throws(
    () => raw.exec("INSERT INTO warranty_claims (id,user_id,order_item_id,product_name,description,unit_id,stage,status) VALUES ('wc_x','u_a','oi_d','A1','x','unit_d','received','submitted')"),
    /CLAIM_ALREADY_OPEN/
  );
  // G3: a third requested protection claim on the same line.
  assert.throws(
    () => raw.exec("INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state) VALUES ('ppc_x','u_a','ORD-D','oi_d',899000,830000,1,'requested')"),
    /CLAIM_PENDING/
  );
  // W-1: the cover a claim was filed under is written once, never rewritten.
  raw.exec("INSERT INTO warranty_claims (id,user_id,product_name,description,filed_cover_state,filed_cover_via,filed_cover_end_at,filed_policy_version) VALUES ('wc_g','u_a','general','g','active','original','2027-01-10T10:00:00.000Z','warranty@4')");
  assert.throws(() => raw.exec("UPDATE warranty_claims SET filed_cover_state = 'expired' WHERE id = 'wc_g'"), /CLAIM_FILED_COVER_FROZEN/);
  assert.throws(() => raw.exec("UPDATE warranty_claims SET filed_cover_state = 'active' WHERE id = 'wc_1'"), /CLAIM_FILED_COVER_FROZEN/, 'an old claim is never back-filled');
  // Any other column of a claim still moves.
  raw.exec("UPDATE warranty_claims SET admin_note = 'seen' WHERE id = 'wc_g'");
  // Correction 1: an inactive coupon cannot be redeemed by any writer.
  assert.throws(
    () => raw.exec("INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('r_x','cpn_off','u_b','ORD-P',5000)"),
    /COUPON_INACTIVE/
  );
});

test('ahead: the claim door over a database at 0190 files without the new columns and still keeps one open case per device', async () => {
  const raw = dbThrough('0190');
  const now = Date.now();
  const delivered = new Date(now - 30 * 86_400_000).toISOString();
  const end = new Date(now + 300 * 86_400_000).toISOString();
  raw.exec(`
    INSERT INTO users (id,name,email,username,password_hash,role) VALUES ('buyer','Sara','sara@x.co','sara','h','customer');
    INSERT INTO products (id,slug,name,price_iqd) VALUES ('p1','a1','Bambu A1',899000);
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'${delivered}');
    INSERT INTO order_items (id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('oi1','ORD-1','p1','Bambu A1',1,899000,899000);
    INSERT INTO order_item_units (id,order_id,order_item_id,product_id,owner_user_id,unit_index,delivered_at,warranty_base_months,warranty_start_at,warranty_end_at)
      VALUES ('u1','ORD-1','oi1','p1','buyer',1,'${delivered}',12,'${delivered}','${end}');
    INSERT INTO device_registrations (unit_id, user_id) VALUES ('u1','buyer');
  `);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'buyer', role: 'customer', email: 'sara@x.co' }, (a) => a.route('/api/devices', deviceRoutes));
  const claim = (key: string) =>
    post(app, '/api/devices/units/u1/claims', { subject: 'Extruder clicks', description: 'The extruder clicks on every print.', idempotencyKey: key });

  const first = await json(await claim('ahead-key-0001'));
  assert.equal(first.success, true, JSON.stringify(first));
  const seen = await json(await get(app, `/api/devices/claims/${first.id}`));
  assert.equal(seen.claim.coverage_at_filing, null, 'no column, nothing claimed');

  // No trigger on this database: the insert's own fence keeps one open case per device.
  const second = await claim('ahead-key-0002');
  const body = await json(second);
  assert.equal(second.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'CLAIM_ALREADY_OPEN');
  assert.equal(body.details?.claim_id, first.id);
  assert.equal(row<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM warranty_claims WHERE unit_id = 'u1'")!.n, 1);

  // The probe never remembers «absent»: once 0191 lands, the same database object records the cover.
  assert.equal(await claimFiledColumnsInstalled(db), false);
  raw.exec(MIGRATION);
  assert.equal(await claimFiledColumnsInstalled(db), true);
  raw.exec(`UPDATE warranty_claims SET stage = 'resolved', status = 'approved' WHERE id = '${first.id}'`);
  const third = await json(await claim('ahead-key-0003'));
  assert.equal(third.success, true, JSON.stringify(third));
  assert.equal(row<{ s: string }>(raw, 'SELECT filed_cover_state AS s FROM warranty_claims WHERE id = ?', third.id)!.s, 'active');
});

test('ahead: without 0191\'s ppc_one_open, the protection claim door still records one «requested» claim per line, even under a race', async () => {
  const w = ppWorld();
  // The shape of a database at 0190 for this rule: no trigger behind the insert.
  w.raw.exec('DROP TRIGGER ppc_one_open');
  w.raw.prepare(`INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('p', 'p', 'Plain', 'active', 40000, 5)`).run();
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const race = new RaceD1(w.raw);
  race.whenRun = (sql) => sql.includes('INSERT INTO price_protection_claims');
  const seen: { inner?: number } = {};
  race.runHook = async () => {
    seen.inner = (await w.claim(itemId)).status;
  };
  const app = stubApp(race as unknown as D1Database, { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => {
    a.route('/api/price-protection', priceProtectionRoutes);
    a.route('/api/returns', returnRoutes);
  });
  const outer = await post(app, '/api/price-protection/claims', { orderItemId: itemId });
  const body = await json(outer);
  assert.equal(seen.inner, 200);
  assert.equal(outer.status, 400, JSON.stringify(body));
  assert.equal(body.code, 'CLAIM_PENDING');
  assert.equal(w.n("SELECT COUNT(*) n FROM price_protection_claims WHERE order_item_id = ? AND state = 'requested'", itemId), 1);
});

// ===================================================================== legacy reopen (trade-in credits)

const DAY = 86_400_000;
const MINUTE = 60_000;
/** One CREATE TRIGGER of 0191, as the file writes it. */
const block = (name: string) => {
  const i = MIGRATION.indexOf(`CREATE TRIGGER IF NOT EXISTS ${name}`);
  assert.ok(i >= 0, name);
  return MIGRATION.slice(i, MIGRATION.indexOf('END;', i) + 4);
};
const ownerAdmin = (raw: DatabaseSync) => stubApp(new LimitD1(raw) as unknown as D1Database, OWNER, (a) => a.route('/api/admin', adminRoutes));
const reopen = (raw: DatabaseSync, door: 'status' | 'stage', orderId: string) =>
  door === 'status'
    ? patch(ownerAdmin(raw), `/api/admin/orders/${orderId}`, { status: 'pending' })
    : patch(ownerAdmin(raw), `/api/admin/orders/${orderId}/stage`, { stage: 'received' });
const statusOf = (raw: DatabaseSync, orderId: string) => row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', orderId)!.status;
const useOf = (raw: DatabaseSync, orderId: string) => row<{ state: string }>(raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', orderId)!.state;

/** An approved trade-in with its credit code in hand. */
async function readyToPay(raw: DatabaseSync) {
  const id = await submitted(raw);
  await received(raw, id);
  const approved = await json(await post(adminApp(raw), `/api/admin/trade-in/requests/${id}/approve`));
  assert.equal(approved.request.status, 'awaiting_payment', JSON.stringify(approved));
  const pay = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/checkout`));
  assert.ok(pay.coupon_code, JSON.stringify(pay));
  const coupon = row<{ id: string }>(raw, 'SELECT id FROM coupons WHERE trade_in_id = ?', id)!;
  return { id, code: pay.coupon_code as string, coupon: coupon.id };
}
let lineSeq = 0;
/** The P1S the credit buys, in Sara's cart, ordered with `code`. */
async function tiOrder(raw: DatabaseSync, code: string) {
  const line = `c_p1s_m${++lineSeq}`;
  raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
            VALUES ('${line}','cust','p_p1s','','[]','','','','',1)`);
  const res = await post(customerApp(raw), '/api/orders', checkoutBody({ couponCode: code, itemIds: [line] }));
  const body = await json(res);
  await Promise.all(pending.splice(0));
  return { status: res.status, body, id: String(body.order?.id ?? '') };
}
/**
 * A cancel as it ran before 0191 — no release trigger, the use stays spent —
 * by the customer (reopened later through the status door) or through the stage door.
 */
async function legacyCancel(raw: DatabaseSync, orderId: string, door: 'status' | 'stage' = 'status') {
  raw.exec('DROP TRIGGER trg_orders_coupon_released');
  const res =
    door === 'status'
      ? await post(customerApp(raw), `/api/orders/${orderId}/cancel`, {})
      : await patch(ownerAdmin(raw), `/api/admin/orders/${orderId}/stage`, { stage: 'cancelled' });
  assert.equal(res.status, 200, await res.clone().text());
  raw.exec(block('trg_orders_coupon_released'));
  assert.equal(useOf(raw, orderId), 'active');
}

test('legacy reopen: an order cancelled before 0191 whose trade-in was cancelled since stays cancelled — through both admin doors', async () => {
  for (const door of ['status', 'stage'] as const) {
    const raw = seed({ deliveredDaysAgo: 40 });
    const t = await readyToPay(raw);
    const a = await tiOrder(raw, t.code);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    await legacyCancel(raw, a.id, door);
    // No live order holds the credit, so its owner may cancel the trade-in: the device is released, the credit switched off.
    const tc = await post(customerApp(raw), `/api/trade-in/requests/${t.id}/cancel`, { reason: 'changed my mind' });
    assert.equal(tc.status, 200, await tc.clone().text());
    assert.equal(row<{ active: number }>(raw, 'SELECT active FROM coupons WHERE id = ?', t.coupon)!.active, 0);

    const res = await reopen(raw, door, a.id);
    const body = await json(res);
    assert.equal(res.status, 409, `${door}: ${JSON.stringify(body)}`);
    assert.equal(body.code, 'ORDER_REOPEN_COUPON_SPENT');
    assert.equal(statusOf(raw, a.id), 'cancelled', `${door}: the order keeps no credit its request no longer has`);
  }
});

test('legacy reopen: a request re-minted before 0191 — its first order is not reopened, and a first order reopened before 0191 fences the second coupon', async () => {
  const raw = seed({ deliveredDaysAgo: 40 });
  const t = await readyToPay(raw);
  const a = await tiOrder(raw, t.code);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  await legacyCancel(raw, a.id);
  // The old «إتمام الدفع»: the first coupon switched off, a second minted and named by the request.
  raw.exec(`DROP TRIGGER trg_trade_in_one_credit;
    UPDATE coupons SET active = 0 WHERE id = '${t.coupon}';
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, max_global, active, assigned_user_id, trade_in_id, product_id, option_value_id, color_id, ends_at)
      SELECT 'cpn_c2', 'TICREDIT2', kind, value, min_total_iqd, max_per_user, max_global, 1, assigned_user_id, trade_in_id, product_id, option_value_id, color_id, ends_at
        FROM coupons WHERE id = '${t.coupon}';
    UPDATE trade_in_requests SET coupon_id = 'cpn_c2' WHERE id = '${t.id}';`);
  raw.exec(block('trg_trade_in_one_credit'));

  // (1) Reopening the first order would put its credit beside the second coupon: refused.
  const res = await reopen(raw, 'status', a.id);
  const body = await json(res);
  assert.equal(res.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'ORDER_REOPEN_COUPON_SPENT');
  assert.equal(statusOf(raw, a.id), 'cancelled');

  // (2) The database may already hold that first order reopened before 0191: a live
  // order carrying the first coupon's use. The second coupon then buys nothing.
  raw.exec('DROP TRIGGER trg_orders_reopen_coupon_inactive');
  raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(a.id);
  raw.exec(block('trg_orders_reopen_coupon_inactive'));
  const orders = () => count(raw, "SELECT COUNT(*) AS n FROM orders WHERE user_id = 'cust'");
  const before = orders();
  const b = await tiOrder(raw, 'TICREDIT2');
  assert.equal(b.status, 400, JSON.stringify(b.body));
  assert.equal(b.body.code, 'TRADE_IN_COUPON_MISMATCH');
  assert.equal(orders(), before, 'nothing ordered');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = 'cpn_c2'"), 0, 'nothing redeemed');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions r JOIN coupons c ON c.id = r.coupon_id JOIN orders o ON o.id = r.order_id WHERE c.trade_in_id = ? AND r.state = 'active' AND o.status <> 'cancelled'", t.id),
    1,
    'one live order carries this trade-in credit'
  );
});

test('legacy reopen: a trade-in order cancelled before 0191 and reopened after it is charged the time it sat cancelled — its next cancel adds only held time', () => {
  const raw = dbThrough('0190');
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const E = ago(13); // the credit's end: seven days after it was minted with the order, 20 days ago
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u_a','Sara','a@x.co','h','customer');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,updated_at)
      VALUES ('ORD-X','u_a','pending','{}','standard','{}','cash',899000,0,1400,894000,894000,'${ago(20)}','${ago(20)}');
    INSERT INTO trade_in_requests (id,user_id,status,order_id,order_item_id,family,created_at,updated_at,coupon_id,credit_iqd)
      VALUES ('tir_1','u_a','awaiting_payment','ORD-OLD','oi_old','fdm','${ago(21)}','${ago(21)}','cpn_t',5000);
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_per_user, max_global, active, ends_at, trade_in_id, assigned_user_id)
      VALUES ('cpn_t','TRADE1','fixed_iqd',5000,0,1,1,1,'${E}','tir_1','u_a');
    INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, created_at) VALUES ('r_x','cpn_t','u_a','ORD-X',5000,'${ago(20)}');
  `);
  // Cancelled before 0191, after holding the credit one day: the use stays spent, the end never moved.
  raw.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-X'");
  raw.prepare("UPDATE orders SET cancelled_at = ? WHERE id = 'ORD-X'").run(ago(19));
  raw.exec(MIGRATION);
  const end = () => Date.parse(row<{ ends_at: string }>(raw, "SELECT ends_at FROM coupons WHERE id = 'cpn_t'")!.ends_at);
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) < MINUTE, `${what}: ${new Date(actual).toISOString()} vs ${new Date(expected).toISOString()}`);

  // Reopened now: the nineteen days it sat cancelled count against the credit.
  raw.exec("UPDATE orders SET status = 'pending' WHERE id = 'ORD-X'");
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_x'")!.state, 'active');
  near(end(), Date.parse(E) - 19 * DAY, 'reopen: the gap is charged');
  // Held two more days, then cancelled (the trigger reads the real clock: the
  // order's created_at moves back two days instead).
  raw.prepare("UPDATE orders SET created_at = ? WHERE id = 'ORD-X'").run(ago(22));
  raw.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-X'");
  near(end(), Date.parse(E) + 3 * DAY, 'cancel: the original end plus the day and the two days an order held it, never the gap');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM coupon_redemptions WHERE id = 'r_x'")!.state, 'released');
});
