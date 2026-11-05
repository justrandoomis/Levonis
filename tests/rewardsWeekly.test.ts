/**
 * THE WEEKLY PRINTER COUPONS AND SPENDING THEM TOGETHER, THROUGH THE REAL CHECKOUT
 * (owner, 2026-11-05; migration 0225; docs/DECISIONS.md rows 223 #4 and 295).
 *
 *   «كل اسبوع كوبون خصم على الفلمنت واحد وكوبون توصيل مجاني للطلبات فوق 100 الف.
 *    طابعه وحده = كوبون واحد، ٣ طابعات = ٣ كوبونات وهكذا كل اسبوع»
 *   «فترة محددة all the warranty period 12month»
 *   «the coupon is for 1 pic, 1 free shipping 5000, 2 coupon mean shipping
 *    discount 10000 and 2 pic of filament»
 *   «كلها بنفس الطلب»، «كل طابعة ضمانها شغال»
 *
 * Real migrations, real triggers, the real cart and checkout routers; only the
 * session is stubbed. Run: node --import tsx --test tests/rewardsWeekly.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, get, row, stubApp, type Mount } from './fixtures/app';
import { BUYER, apps, giftWorld, json, orderBody, paidLine, placeOrder, post, quoteBody, type J } from './fixtures/giftWorld';
import type { Env } from '../worker/lib/types';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { listUserRewardCoupons, revokeRewardsForReturn, WEEKLY_UNIT_LIMIT } from '../worker/lib/rewards/coupons';
import { REWARD_CONFIG_KEY } from '../worker/lib/rewards/config';
import { runRewardSweep, WEEKLY_MIGRATION } from '../worker/lib/rewards/sweep';
import { rewardText } from '../worker/lib/rewards/strings';
import { validateCoupon } from '../worker/lib/membershipOps';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T09:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;

/** The gift world, with a printer in a printer catalog, a filament, and 0225 applied «now». */
function world(appliedAt = NOW): DatabaseSync {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog)
      VALUES ('rw_printers',NULL,'rw-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_printer','reward-printer','A1 mini','طابعة A1 mini','چاپکەری A1 mini',200000,'active',60,'[]','[]','direct_sale','["direct_sale"]','[]','[]','tracked');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0);
    UPDATE products SET category_id = 'cat_materials_fdm', stock = 60 WHERE id = 'p_plain';
    CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  raw.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(WEEKLY_MIGRATION, new Date(appliedAt).toISOString().replace('T', ' ').slice(0, 19));
  return raw;
}

let seq = 0;
/** A printer order through the real checkout, delivered `deliveredAt`. The delivery's own coupons are the caller's to keep or wipe. */
async function printerOrder(raw: DatabaseSync, qty = 1, deliveredAt = at(0), keepFirstPair = false): Promise<{ orderId: string; itemId: string }> {
  const a = apps(raw);
  paidLine(raw, `ci_w_${seq++}`, 'p_printer', { qty, fulfillmentType: 'direct_sale' });
  const order = await placeOrder(a.buyer, { deliveryMethodId: 'pickup', paymentMethodId: 'cash' });
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(deliveredAt, order.id);
  await runOrderDeliveredEffects(envOf(raw), order.id);
  if (!keepFirstPair) {
    raw.prepare('UPDATE coupons SET reward_grant_id = NULL WHERE reward_grant_id IN (SELECT id FROM reward_grants WHERE order_id = ?)').run(order.id);
    raw.prepare('DELETE FROM coupons WHERE id IN (SELECT coupon_id FROM reward_grants WHERE order_id = ?)').run(order.id);
    raw.prepare('DELETE FROM reward_grants WHERE order_id = ?').run(order.id);
    raw.exec("DELETE FROM user_notifications WHERE kind = 'reward'");
  }
  raw.prepare('UPDATE order_item_units SET delivered_at = ?, warranty_start_at = ? WHERE order_id = ?').run(deliveredAt, deliveredAt, order.id);
  // The delivery's own pair was dated by the wall clock; this film runs on its own.
  const ends = new Date(Date.parse(deliveredAt) + 7 * DAY).toISOString();
  raw.prepare('UPDATE reward_grants SET issued_at = ?, expires_at = ? WHERE order_id = ?').run(deliveredAt, ends, order.id);
  raw.prepare('UPDATE coupons SET starts_at = ?, ends_at = ?, created_at = ? WHERE reward_grant_id IN (SELECT id FROM reward_grants WHERE order_id = ?)').run(deliveredAt, ends, deliveredAt, order.id);
  const item = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_printer'", order.id)!;
  return { orderId: order.id as string, itemId: item.id };
}

const sweep = (raw: DatabaseSync, nowIso: string) => runRewardSweep(envOf(raw), nowIso);
const refsOf = (raw: DatabaseSync, orderId: string) =>
  all<{ source_ref: string }>(raw, 'SELECT source_ref FROM reward_grants WHERE order_id = ? ORDER BY issued_at, source_ref', orderId).map((r) => r.source_ref);
const notices = (raw: DatabaseSync) => count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'buyer' AND kind = 'reward'");

// ------------------------------------------------------------------ every week

test('every week of the warranty each printer gets one pair, and a week never comes twice', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 1, at(0), true);
  assert.equal(refsOf(raw, orderId).length, 2, 'the delivery’s own pair is the first week');

  let out = await sweep(raw, at(3));
  assert.deepEqual(out.weekly, { scanned: 0, issued: 0, errors: 0 }, 'nothing new inside the week');

  out = await sweep(raw, at(7));
  assert.deepEqual(out.weekly, { scanned: 1, issued: 2, errors: 0 }, 'a new pair on day seven');
  assert.deepEqual(out.reminders, { coupons: 0, customers: 0 });
  assert.deepEqual(refsOf(raw, orderId).filter((r) => r.endsWith(':w1')), [`printer:${itemId}:1:filament_discount:w1`, `printer:${itemId}:1:free_shipping:w1`]);
  assert.deepEqual((await sweep(raw, at(7.1))).weekly, { scanned: 0, issued: 0, errors: 0 }, 'the same week, nothing more');

  const fresh = all<{ kind: string; coupon_kind: string; value: number; min_total_iqd: number; max_quantity: number | null; ends_at: string }>(
    raw,
    `SELECT g.kind, c.kind AS coupon_kind, c.value, c.min_total_iqd, c.max_quantity, c.ends_at
       FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.source_ref LIKE '%:w1' ORDER BY g.kind`
  );
  assert.deepEqual(fresh.map((c) => [c.kind, c.coupon_kind, c.value, c.min_total_iqd, c.max_quantity]), [
    ['filament_discount', 'percent', 15, 0, 1],
    ['free_shipping', 'fixed_iqd', 5_000, 100_000, null],
  ]);
  assert.ok(fresh.every((c) => c.ends_at === new Date(NOW + 14 * DAY).toISOString()), 'seven days from the day it was issued');

  const note = row<{ event_key: string; title_ar: string; meta: string; link: string }>(raw, "SELECT * FROM user_notifications WHERE event_key LIKE 'reward:weekly:%'")!;
  assert.equal(note.event_key, `reward:weekly:${at(7).slice(0, 10)}`);
  assert.equal(note.link, '/rewards/coupons');
  assert.ok(JSON.parse(note.meta).body_ckb);
});

test('only the current week is issued: a sweep down for a fortnight owes no back pay', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  assert.deepEqual((await sweep(raw, at(23))).weekly, { scanned: 1, issued: 2, errors: 0 });
  assert.deepEqual(refsOf(raw, orderId), [`printer:${itemId}:1:filament_discount:w3`, `printer:${itemId}:1:free_shipping:w3`]);
});

test('the number of printers is the number of coupons: three printers, three pairs, one notice', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, 3, at(0), true);
  assert.equal(refsOf(raw, orderId).length, 6);
  const before = notices(raw);
  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 3, issued: 6, errors: 0 });
  assert.equal(notices(raw), before + 1, 'one notice however many printers');
  const { orderId: second } = await printerOrder(raw, 1, at(1));
  assert.equal(refsOf(raw, second).length, 0);
  assert.deepEqual((await sweep(raw, at(8))).weekly, { scanned: 1, issued: 2, errors: 0 }, 'a second order’s printer keeps its own clock');
});

test('a backlog drains tick by tick, and a customer is told once a day', async () => {
  const raw = world();
  await printerOrder(raw, WEEKLY_UNIT_LIMIT + 2, at(0));
  const first = await sweep(raw, at(1));
  assert.deepEqual(first.weekly, { scanned: WEEKLY_UNIT_LIMIT, issued: WEEKLY_UNIT_LIMIT * 2, errors: 0 });
  const second = await sweep(raw, at(1.01));
  assert.deepEqual(second.weekly, { scanned: 2, issued: 4, errors: 0 });
  assert.equal(notices(raw), 1);
  assert.deepEqual((await sweep(raw, at(1.02))).weekly, { scanned: 0, issued: 0, errors: 0 });
});

test('the 12 months run from the warranty’s own start; the extended warranty adds nothing, and a shorter warranty ends sooner', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, 1, at(0));
  raw.prepare('UPDATE order_item_units SET warranty_ext_months = 12, warranty_end_at = ? WHERE order_id = ?').run(at(730), orderId);
  assert.equal((await sweep(raw, at(358))).weekly.issued, 2, 'still inside 12 months');
  assert.equal((await sweep(raw, at(366))).weekly.scanned, 0, 'past 12 months, whatever was extended');

  raw.prepare('UPDATE order_item_units SET warranty_base_months = 6 WHERE order_id = ?').run(orderId);
  raw.prepare('DELETE FROM user_notifications').run();
  assert.equal((await sweep(raw, at(190))).weekly.scanned, 0, 'a six-month warranty is six months');
  raw.prepare('UPDATE order_item_units SET warranty_base_months = 24 WHERE order_id = ?').run(orderId);
  assert.equal((await sweep(raw, at(400))).weekly.scanned, 0, 'a longer warranty still stops at the owner’s 12');
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify({ weekly: { enabled: true, months: 18 } }));
  assert.equal((await sweep(raw, at(400))).weekly.scanned, 1, 'the owner’s setting moves it');
});

test('every printer whose warranty still runs earns from the day this reached the database, and nothing is paid back', async () => {
  const raw = world();
  const running = await printerOrder(raw, 1, at(-100));
  const ended = await printerOrder(raw, 1, at(-400));
  const out = await sweep(raw, at(0));
  assert.deepEqual(out.weekly, { scanned: 1, issued: 2, errors: 0 });
  assert.deepEqual(refsOf(raw, running.orderId), [`printer:${running.itemId}:1:filament_discount`, `printer:${running.itemId}:1:free_shipping`], 'its first week, from the migration, not its fourteenth');
  assert.equal(refsOf(raw, ended.orderId).length, 0, 'a warranty that already ended earns nothing');
  assert.equal((await sweep(raw, at(6))).weekly.scanned, 0);
  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 1, issued: 2, errors: 0 }, 'then every seven days');
  assert.ok(refsOf(raw, running.orderId).includes(`printer:${running.itemId}:1:free_shipping:w1`));
  assert.equal((await sweep(raw, at(266))).weekly.issued, 0, 'and it stops when ITS 12 months from delivery do');
});

test('a pair issued on delivery before this arrived is that printer’s first week, never issued again', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, 1, at(-2), true);
  assert.equal(refsOf(raw, orderId).length, 2);
  assert.equal((await sweep(raw, at(0))).weekly.scanned, 0);
  assert.equal(refsOf(raw, orderId).length, 2);
});

test('a database that cannot say when this arrived issues nothing', async () => {
  const raw = world();
  await printerOrder(raw, 1, at(-3));
  raw.exec('DELETE FROM d1_migrations');
  assert.deepEqual((await sweep(raw, at(0))).weekly, { scanned: 0, issued: 0, errors: 0 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 0);
});

test('what stops the coupons: the owner’s switch, a cancelled or merchant order, a gift, a closed warranty, a trade-in', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  const stops = async (why: string, doit: () => void, undo: () => void) => {
    doit();
    assert.equal((await sweep(raw, at(1))).weekly.scanned, 0, why);
    undo();
  };
  const setting = (v: J) => raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify(v));
  await stops('programme off', () => setting({ enabled: false }), () => setting({}));
  await stops('weekly off', () => setting({ weekly: { enabled: false, months: 12 } }), () => setting({}));
  await stops('both coupons off', () => setting({ free_shipping: { enabled: false }, filament: { enabled: false } }), () => setting({}));
  await stops('order not delivered', () => raw.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId), () => raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId));
  await stops('merchant order', () => raw.prepare("UPDATE orders SET seller_type = 'merchant' WHERE id = ?").run(orderId), () => raw.prepare("UPDATE orders SET seller_type = 'levonis' WHERE id = ?").run(orderId));
  await stops('a gift line', () => raw.prepare("UPDATE order_items SET gift_entitlement_id = 'ge_fake' WHERE id = ?").run(itemId), () => raw.prepare('UPDATE order_items SET gift_entitlement_id = NULL WHERE id = ?').run(itemId));
  await stops('not a printer any more', () => raw.prepare("DELETE FROM product_catalogs WHERE product_id = 'p_printer'").run(), () => raw.prepare("INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0)").run());
  await stops(
    'warranty closed',
    () => raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'returned' WHERE order_id = ?").run(at(0.5), orderId),
    () => raw.prepare('UPDATE order_item_units SET warranty_closed_at = NULL, warranty_closed_reason = NULL WHERE order_id = ?').run(orderId)
  );
  raw.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  const columns = all<{ name: string; notnull: number; dflt_value: unknown; type: string }>(raw, "SELECT name, \"notnull\", dflt_value, type FROM pragma_table_info('trade_in_requests')");
  const needed = columns.filter((c) => c.notnull && c.dflt_value === null && !['id', 'user_id', 'order_item_id', 'unit_index', 'status', 'scope', 'completed_at'].includes(c.name));
  const names = ['id', 'user_id', 'order_item_id', 'unit_index', 'status', 'scope', 'completed_at', ...needed.map((c) => c.name)];
  const fill = needed.map((c) => (/INT|REAL|NUM/i.test(c.type) ? 0 : ''));
  await stops(
    'traded in',
    () => raw.prepare(`INSERT INTO trade_in_requests (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run('ti_1', 'buyer', itemId, 1, 'completed', 'whole', at(0.5), ...fill),
    () => raw.prepare('DELETE FROM trade_in_requests').run()
  );
  raw.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');
  assert.equal((await sweep(raw, at(1))).weekly.scanned, 1, 'every door undone, the printer earns again');
});

test('a printer replaced under warranty keeps earning on its one slot, and stops when the replacement’s warranty closes', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  const unit = row<{ id: string; product_id: string }>(raw, 'SELECT id, product_id FROM order_item_units WHERE order_id = ?', orderId)!;
  raw
    .prepare(
      `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version, replacement_of_unit_id)
       VALUES ('unit_repl', ?, ?, ?, 'buyer', 2, ?, 12, 0, ?, ?, '{}', ?)`
    )
    .run(orderId, itemId, unit.product_id, at(10), at(0), at(365), unit.id);
  raw.prepare("UPDATE order_item_units SET replaced_by_unit_id = 'unit_repl', warranty_closed_at = ?, warranty_closed_reason = 'replaced' WHERE id = ?").run(at(10), unit.id);

  const out = await sweep(raw, at(14));
  assert.deepEqual(out.weekly, { scanned: 1, issued: 2, errors: 0 }, 'one printer, one pair: the replacement is not a second printer');
  assert.deepEqual(refsOf(raw, orderId), [`printer:${itemId}:1:filament_discount:w2`, `printer:${itemId}:1:free_shipping:w2`], 'on the slot the customer bought');

  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'returned' WHERE id = 'unit_repl'").run(at(15));
  assert.equal((await sweep(raw, at(21))).weekly.scanned, 0, 'the device in the customer’s hands came back');
});

test('a returned printer stops earning whether or not the case could name the unit, and the rest of the line does not', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 3, at(0));
  raw.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  const columns = all<{ name: string; notnull: number; dflt_value: unknown; type: string }>(raw, "SELECT name, \"notnull\", dflt_value, type FROM pragma_table_info('return_cases')");
  const base: Record<string, unknown> = { id: 'rc_1', order_id: orderId, order_item_id: itemId, user_id: 'buyer', state: 'resolved', resolution: 'refund', qty: 1 };
  for (const c of columns) if (c.notnull && c.dflt_value === null && !(c.name in base)) base[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : '';
  const names = Object.keys(base).filter((n) => columns.some((c) => c.name === n));
  raw.prepare(`INSERT INTO return_cases (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => base[n] as string | number));
  raw.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');

  // No unit was named: the highest open slot stops.
  assert.deepEqual((await sweep(raw, at(1))).weekly, { scanned: 2, issued: 4, errors: 0 });
  assert.deepEqual([...new Set(all<{ unit_index: number }>(raw, 'SELECT unit_index FROM reward_grants WHERE order_id = ? ORDER BY unit_index', orderId).map((r) => r.unit_index))], [1, 2]);

  // The case names unit 1: it stops, and the printer that was held back earns again.
  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'returned', return_case_id = 'rc_1' WHERE order_id = ? AND unit_index = 1").run(at(2), orderId);
  assert.deepEqual((await sweep(raw, at(8))).weekly, { scanned: 2, issued: 4, errors: 0 });
  assert.deepEqual([...new Set(all<{ unit_index: number }>(raw, "SELECT unit_index FROM reward_grants WHERE source_ref LIKE '%:w1' ORDER BY unit_index").map((r) => r.unit_index))], [2, 3]);

  // The return takes back the week's live coupons, never a past week's, and only up to what came back.
  const out = await revokeRewardsForReturn(envOf(raw), { caseId: 'rc_1', orderItemId: itemId, qty: 1 }, at(8.5));
  assert.equal(out.revoked, 2);
  const taken = all<{ source_ref: string }>(raw, "SELECT source_ref FROM reward_grants WHERE revoke_reason = 'return:rc_1'").map((r) => r.source_ref);
  assert.ok(taken.every((r) => r.endsWith(':w1') && r.includes(`:3:`)), JSON.stringify(taken));
});

/** A trade-in request row with only what these tests read, the rest of its NOT NULL columns filled. */
function tradeInRow(raw: DatabaseSync, itemId: string, fields: Record<string, string | number>) {
  raw.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  const columns = all<{ name: string; notnull: number; dflt_value: unknown; type: string }>(raw, "SELECT name, \"notnull\", dflt_value, type FROM pragma_table_info('trade_in_requests')");
  const base: Record<string, string | number> = { id: 'ti_shop', user_id: 'buyer', order_item_id: itemId, unit_index: 1, scope: 'whole', ...fields };
  for (const c of columns) if (c.notnull && c.dflt_value === null && !(c.name in base)) base[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : '';
  const names = Object.keys(base);
  raw.prepare(`INSERT INTO trade_in_requests (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => base[n]));
  raw.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');
}

test('a printer the shop has received for a trade-in earns nothing from that moment, and earns again if it is handed back', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  tradeInRow(raw, itemId, { status: 'awaiting_payment', intake_at: at(0.5) });
  assert.deepEqual((await sweep(raw, at(1))).weekly, { scanned: 0, issued: 0, errors: 0 }, 'in the shop, not in the customer’s hands');

  raw.prepare("UPDATE trade_in_requests SET status = 'cancelled' WHERE id = 'ti_shop'").run();
  assert.equal((await sweep(raw, at(1.5))).weekly.scanned, 0, 'cancelled, and the shop still holds it');

  raw.prepare("UPDATE trade_in_requests SET device_returned_at = ? WHERE id = 'ti_shop'").run(at(2));
  assert.deepEqual((await sweep(raw, at(2.5))).weekly, { scanned: 1, issued: 2, errors: 0 }, 'back with its owner, it earns again');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants WHERE order_id = ?', orderId), 2);

  // The AMS alone leaves the printer with its owner.
  raw.prepare('DELETE FROM trade_in_requests').run();
  tradeInRow(raw, itemId, { status: 'awaiting_payment', intake_at: at(7), scope: 'ams_only' });
  assert.equal((await sweep(raw, at(8))).weekly.scanned, 1, 'an AMS in the shop stops nothing');
});

test('a lower slot whose replacement went back is the printer that refund took: the other printer on the line keeps earning', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, 2, at(0));
  const unit = row<{ id: string; product_id: string }>(raw, 'SELECT id, product_id FROM order_item_units WHERE order_id = ? AND unit_index = 1', orderId)!;
  raw.prepare(
    `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version, replacement_of_unit_id)
     VALUES ('unit_repl', ?, ?, ?, 'buyer', 3, ?, 12, 0, ?, ?, '{}', ?)`
  ).run(orderId, itemId, unit.product_id, at(1), at(0), at(365), unit.id);
  raw.prepare("UPDATE order_item_units SET replaced_by_unit_id = 'unit_repl', warranty_closed_at = ?, warranty_closed_reason = 'replaced' WHERE id = ?").run(at(1), unit.id);

  // Both slots live, the first through its replacement.
  assert.deepEqual((await sweep(raw, at(1.5))).weekly, { scanned: 2, issued: 4, errors: 0 });

  // The replacement comes back and is refunded: the case names it, and one printer is left.
  raw.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
  const columns = all<{ name: string; notnull: number; dflt_value: unknown; type: string }>(raw, "SELECT name, \"notnull\", dflt_value, type FROM pragma_table_info('return_cases')");
  const base: Record<string, string | number> = { id: 'rc_r', order_id: orderId, order_item_id: itemId, user_id: 'buyer', state: 'resolved', resolution: 'refund', qty: 1 };
  for (const c of columns) if (c.notnull && c.dflt_value === null && !(c.name in base)) base[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : '';
  const names = Object.keys(base).filter((n) => columns.some((c) => c.name === n));
  raw.prepare(`INSERT INTO return_cases (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...names.map((n) => base[n]));
  raw.exec('PRAGMA ignore_check_constraints = OFF; PRAGMA foreign_keys = ON;');
  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'returned', return_case_id = 'rc_r' WHERE id = 'unit_repl'").run(at(2));

  assert.deepEqual((await sweep(raw, at(8))).weekly, { scanned: 1, issued: 2, errors: 0 }, 'one printer left, and it still earns');
  assert.deepEqual([...new Set(all<{ unit_index: number }>(raw, "SELECT unit_index FROM reward_grants WHERE source_ref LIKE '%:w1'").map((r) => r.unit_index))], [2]);
});

test('a return withdraws every live coupon of the printer, whichever week it came from, and leaves the other printer alone', async () => {
  const raw = world();
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify({ valid_days: 21 }));
  const { itemId } = await printerOrder(raw, 2, at(0));
  await sweep(raw, at(0.1));
  await sweep(raw, at(7.1));
  const live = () => all<{ unit_index: number }>(raw, 'SELECT g.unit_index FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.revoked_at IS NULL AND c.active = 1 ORDER BY g.unit_index').map((r) => r.unit_index);
  assert.deepEqual(live(), [1, 1, 1, 1, 2, 2, 2, 2], 'a longer validity leaves two weeks live on each printer');

  const out = await revokeRewardsForReturn(envOf(raw), { caseId: 'rc_w', orderItemId: itemId, qty: 1 }, at(7.2));
  assert.equal(out.revoked, 4);
  assert.deepEqual(live(), [1, 1, 1, 1], 'the other printer’s coupons are its own');
  assert.deepEqual(await revokeRewardsForReturn(envOf(raw), { caseId: 'rc_w', orderItemId: itemId, qty: 1 }, at(7.3)), { revoked: 0 }, 'the same case twice withdraws nothing more');
});

test('the notices say what the owner set: his pieces, and no minimum when there is none', () => {
  const kinds = ['free_shipping', 'filament_discount'] as const;
  const terms = { kind: 'weekly_coupons' as const, until: '2026-12-01', percent: 15, amount: 5_000, kinds };
  const usual = rewardText({ ...terms, min: 100_000, pieces: 1 }).body;
  assert.match(usual.ar, /فوق 100,000 د\.ع/);
  assert.match(usual.ar, /قطعة واحدة/);
  assert.match(usual.en, /over 100,000 IQD/);
  assert.match(usual.en, /one piece/);
  assert.match(usual.ckb, /سەرووی 100,000 دینار/);
  assert.match(usual.ckb, /یەک پارچە/);

  const owners = rewardText({ ...terms, min: 0, pieces: 3 }).body;
  assert.doesNotMatch(owners.ar, /فوق/);
  assert.match(owners.ar, /3 قطع/);
  assert.doesNotMatch(owners.en, /over/);
  assert.match(owners.en, /3 pieces/);
  assert.doesNotMatch(owners.ckb, /سەرووی/);
  assert.match(owners.ckb, /3 پارچە/);
  assert.match(rewardText({ ...terms, min: 0, pieces: 2 }).body.ar, /قطعتين/);
  assert.match(rewardText({ ...terms, min: 0, pieces: 11 }).body.ar, /11 قطعة/);
});

test('a cancel by any door withdraws every week of that printer’s unused coupons', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, 1, at(0));
  await sweep(raw, at(7));
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM reward_grants WHERE order_id = ? AND revoke_reason = 'order_cancelled'", orderId), 2);
});

test('the reminder leaves the weeks alone: their own notice is the rhythm', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, 1, at(0));
  await sweep(raw, at(7));
  const out = await sweep(raw, at(13.5));
  assert.deepEqual(out.reminders, { coupons: 0, customers: 0 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM reward_grants WHERE order_id = ? AND reminded_at IS NOT NULL", orderId), 0);
});

// ------------------------------------------------------------------ one order spends them together

const mountRewards: Mount = (a) => {
  a.route('/api/cart', cartRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/rewards/program', rewardProgramRoutes);
};
const rewardsApp = (raw: DatabaseSync) => stubApp(asD1(raw), BUYER, mountRewards, { publishV2: 'always' });

/** Two printers delivered «now», their coupons really live, and an order of two printers-worth of goods plus filament in the cart. */
async function twoPrintersAndCart(raw: DatabaseSync, filamentQty = 3) {
  const realNow = new Date().toISOString();
  const { orderId } = await printerOrder(raw, 2, realNow, true);
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: filamentQty, fulfillmentType: 'direct_sale' });
  const codes = all<{ kind: string; code: string; coupon_id: string }>(
    raw,
    'SELECT g.kind, c.code, g.coupon_id FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.order_id = ? ORDER BY g.kind, g.unit_index',
    orderId
  );
  return { orderId, codes, code: (kind: string) => codes.find((c) => c.kind === kind)!.code };
}

test('two printers’ coupons go on one order: 10,000 IQD off the delivery and two pieces of filament, from any one code', async () => {
  const raw = world();
  const { code, codes } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const plain = await json(await post(a.buyer, '/api/orders/quote', quoteBody()));
  const fee = Number(plain.quote.shipping.total_iqd);
  assert.ok(fee >= 10_000, `the fixture’s delivery costs ${fee}`);

  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code('free_shipping') })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  const c = quote.quote.coupon;
  assert.equal(c.merchandise_iqd, 2 * 2_250, '15% of two pieces at 15,000 IQD, not three');
  assert.equal(c.delivery_iqd, 10_000);
  assert.equal(c.discount_iqd, 14_500);
  assert.equal(c.code, code('free_shipping'), 'the code in the box heads the order');
  assert.equal(c.pool.length, 4);
  assert.equal(quote.quote.total_iqd, plain.quote.total_iqd - 14_500, 'and the total says so');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemption_extras'), 0, 'a quote spends nothing');

  const order = await placeOrder(a.buyer, { couponCode: code('filament_discount') });
  assert.equal(order.coupon.code, code('filament_discount'), 'whichever code the customer pressed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ? AND state = 'active'", order.id), 1, 'one row where the shop reads «the order’s coupon»');
  const extras = all<{ coupon_id: string; amount_iqd: number }>(raw, "SELECT coupon_id, amount_iqd FROM coupon_redemption_extras WHERE order_id = ? AND state = 'active'", order.id);
  assert.equal(extras.length, 3);
  const primary = row<{ amount_iqd: number }>(raw, 'SELECT amount_iqd FROM coupon_redemptions WHERE order_id = ?', order.id)!;
  assert.equal(primary.amount_iqd + extras.reduce((s, e) => s + e.amount_iqd, 0), 14_500, 'the rows add up to the order’s discount');
  const stored = row<{ coupon_discount_iqd: number; coupon_snapshot: string }>(raw, 'SELECT coupon_discount_iqd, coupon_snapshot FROM orders WHERE id = ?', order.id)!;
  assert.equal(JSON.parse(stored.coupon_snapshot).discount_iqd, 14_500);
  assert.equal(JSON.parse(stored.coupon_snapshot).merchandise_iqd, 4_500);
  assert.equal(
    count(raw, 'SELECT COALESCE(SUM(coupon_discount_iqd), 0) AS n FROM order_items WHERE order_id = ?', order.id),
    4_500,
    'the goods part on the lines, the delivery part on no line: every money reader’s residual still adds up'
  );

  const views = await listUserRewardCoupons(asD1(raw), 'buyer');
  assert.deepEqual(views.map((v) => v.state), ['used', 'used', 'used', 'used']);
  assert.ok(views.every((v) => v.used_on_order_id === order.id), 'every card names the order that spent it');
  assert.equal(codes.length, 4);
});

test('coupons that take less than the screen said refuse the order with the new total, and nothing is written', async () => {
  const raw = world();
  const { code, codes } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code('free_shipping') })));
  assert.equal(quote.quote.coupon.discount_iqd, 14_500);

  // One delivery coupon runs out while the page is open.
  const ship = codes.filter((c) => c.kind === 'free_shipping')[1];
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), ship.coupon_id);

  const before = count(raw, 'SELECT COUNT(*) AS n FROM orders');
  const res = await post(a.buyer, '/api/orders', orderBody({ couponCode: code('free_shipping'), couponDiscountSeen: 14_500 }));
  const out = await json(res);
  assert.equal(res.status, 409, JSON.stringify(out));
  assert.equal(out.code, 'COUPON_POOL_CHANGED');
  assert.equal(out.details.quote.coupon.discount_iqd, 9_500, 'the answer carries the total to show');
  assert.equal(out.details.quote.total_iqd, quote.quote.total_iqd + 5_000);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM orders'), before, 'nothing was written');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemption_extras'), 0);

  // Pressed again, on the screen that shows it.
  const order = await placeOrder(a.buyer, { couponCode: code('free_shipping'), couponDiscountSeen: 9_500 });
  assert.equal(order.coupon.discount_iqd, 9_500);
});

test('more off than the screen said goes through, a tab that says nothing goes through, and a promo code is not asked', async () => {
  const raw = world();
  const { code, orderId } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const more = await placeOrder(a.buyer, { couponCode: code('free_shipping'), couponDiscountSeen: 1_000 });
  assert.equal(more.coupon.discount_iqd, 14_500);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id = ? AND status = 'delivered'", orderId), 1);

  raw.prepare(
    `INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active) VALUES ('cpn_promo', 'PROMO10', 'fixed_iqd', 1000, 0, 100, 5, 1)`
  ).run();
  paidLine(raw, 'ci_promo', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  const promo = await placeOrder(a.buyer, { couponCode: 'PROMO10', couponDiscountSeen: 999_999 });
  assert.equal(promo.coupon.code, 'PROMO10', 'a promo code applies or is refused: it does not shrink');
});

test('a code spent beside another says so in the cart and at the quote, the same as one spent at the head of an order', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const order = await placeOrder(a.buyer, { couponCode: code('free_shipping') });
  const extra = row<{ code: string }>(
    raw,
    "SELECT c.code FROM coupon_redemption_extras x JOIN coupons c ON c.id = x.coupon_id JOIN reward_grants g ON g.coupon_id = c.id WHERE x.order_id = ? AND g.kind = 'filament_discount' LIMIT 1",
    order.id
  )!;
  const head = order.coupon.code as string;
  // Goods past the delivery coupon's minimum, so nothing but being spent stands in its way.
  paidLine(raw, 'ci_goods2', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil2', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });

  for (const spent of [extra.code, head]) {
    const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code: spent }));
    assert.equal(check.valid, false, JSON.stringify(check));
    assert.equal(check.reason, 'GLOBAL_LIMIT_REACHED');
    const res = await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: spent }));
    const quote = await json(res);
    assert.equal(res.status, 400, JSON.stringify(quote));
    assert.equal(quote.code, 'GLOBAL_LIMIT_REACHED');
  }
});

test('an order of several coupons keeps every code in its invoice, beside the one discount they made', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const order = await placeOrder(a.buyer, { couponCode: code('free_shipping') });
  const invoice = row<{ snapshot: string }>(raw, 'SELECT snapshot FROM invoices WHERE order_id = ? AND revision = 1', order.id)!;
  const totals = JSON.parse(invoice.snapshot).totals;
  assert.equal(totals.coupon_discount_iqd, 14_500);
  const spent = all<{ code: string }>(
    raw,
    `SELECT c.code FROM coupons c WHERE c.id IN (SELECT coupon_id FROM coupon_redemptions WHERE order_id = ?1 UNION SELECT coupon_id FROM coupon_redemption_extras WHERE order_id = ?1)`,
    order.id
  ).map((r) => r.code);
  assert.equal(spent.length, 4);
  assert.deepEqual(String(totals.coupon_code).split(', ').sort(), [...spent].sort());
});

test('what the order cannot use stays with the customer for the next one', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw, 1);
  const a = apps(raw);
  const first = await placeOrder(a.buyer, { couponCode: code('filament_discount') });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemption_extras WHERE order_id = ?', first.id), 2, 'one piece of filament and two delivery coupons');
  const views = await listUserRewardCoupons(asD1(raw), 'buyer');
  assert.deepEqual(views.map((v) => `${v.kind}:${v.state}`).sort(), ['filament_discount:active', 'filament_discount:used', 'free_shipping:used', 'free_shipping:used']);
  const unused = views.find((v) => v.state === 'active')!;

  paidLine(raw, 'ci_fil2', 'p_plain', { qty: 2, fulfillmentType: 'direct_sale' });
  const next = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: unused.code })));
  assert.equal(next.success, true, JSON.stringify(next));
  assert.equal(next.quote.coupon.merchandise_iqd, 2_250, 'the one left, on one piece');
  assert.equal(next.quote.coupon.delivery_iqd ?? 0, 0);
});

test('a delivery coupon under its minimum takes nothing and is not spent; alone, the code says why', async () => {
  const raw = world();
  const realNow = new Date().toISOString();
  const { orderId } = await printerOrder(raw, 1, realNow, true);
  const ship = row<{ code: string }>(raw, "SELECT c.code FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.order_id = ? AND g.kind = 'free_shipping'", orderId)!.code;
  const filamentCode = row<{ code: string }>(raw, "SELECT c.code FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.order_id = ? AND g.kind = 'filament_discount'", orderId)!.code;
  const a = apps(raw);
  paidLine(raw, 'ci_p', 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: ship })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(quote.quote.coupon.delivery_iqd ?? 0, 0, '15,000 of goods is under 100,000');
  assert.equal(quote.quote.coupon.merchandise_iqd, 2_250, 'the filament coupon beside it still takes its piece');

  raw.prepare('UPDATE coupons SET active = 0 WHERE code = ?').run(filamentCode);
  raw.prepare("UPDATE reward_grants SET revoked_at = ?, revoke_reason = 'admin' WHERE coupon_id = (SELECT id FROM coupons WHERE code = ?)").run(realNow, filamentCode);
  const refused = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: ship })));
  assert.equal(refused.success, false);
  assert.equal(refused.code, 'MIN_TOTAL_NOT_MET');
  const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code: ship }));
  assert.deepEqual([check.valid, check.reason, check.min_total_iqd], [false, 'MIN_TOTAL_NOT_MET', 100_000]);
});

test('in the cart the code answers for the goods it can see, and the delivery waits', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const check = await json(await post(a.buyer, '/api/cart/coupon-check', { code: code('free_shipping') }));
  assert.equal(check.valid, true, JSON.stringify(check));
  assert.equal(check.estimated_discount_iqd, 4_500);
});

test('a cancel gives every coupon of the order back, and a reopen takes them again within the limits', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const order = await placeOrder(a.buyer, { couponCode: code('free_shipping') });
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemption_extras WHERE order_id = ? AND state = 'released'", order.id), 3);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ? AND state = 'released'", order.id), 1);
  assert.deepEqual((await listUserRewardCoupons(asD1(raw), 'buyer')).map((v) => v.state), ['active', 'active', 'active', 'active']);

  raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(order.id);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM coupon_redemption_extras WHERE order_id = ? AND state = 'active'", order.id), 3);
  assert.deepEqual((await listUserRewardCoupons(asD1(raw), 'buyer')).map((v) => v.state), ['used', 'used', 'used', 'used']);

  // Spent elsewhere while the order sat cancelled: the reopen is refused whole.
  raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(order.id);
  const extra = row<{ coupon_id: string }>(raw, 'SELECT coupon_id FROM coupon_redemption_extras WHERE order_id = ? LIMIT 1', order.id)!;
  paidLine(raw, 'ci_again', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  const second = await placeOrder(a.buyer, { couponCode: code('free_shipping') });
  const secondTook = count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemption_extras WHERE order_id = ? AND coupon_id = ?', second.id, extra.coupon_id);
  const secondHead = count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ? AND coupon_id = ?', second.id, extra.coupon_id);
  if (secondTook + secondHead > 0) {
    assert.throws(() => raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(order.id), /COUPON_GLOBAL_LIMIT/);
    assert.equal(row<{ status: string }>(raw, 'SELECT status FROM orders WHERE id = ?', order.id)!.status, 'cancelled', 'the order stays cancelled');
  }
});

test('the database refuses to spend a coupon twice, in either table, and a coupon that is not a reward', async () => {
  const raw = world();
  const { code, codes } = await twoPrintersAndCart(raw);
  const a = apps(raw);
  const order = await placeOrder(a.buyer, { couponCode: code('free_shipping') });
  const head = row<{ coupon_id: string }>(raw, 'SELECT coupon_id FROM coupon_redemptions WHERE order_id = ?', order.id)!.coupon_id;
  const anExtra = row<{ coupon_id: string }>(raw, 'SELECT coupon_id FROM coupon_redemption_extras WHERE order_id = ? LIMIT 1', order.id)!.coupon_id;
  const twin = await placeOrderRaw(raw);
  const insertExtra = (couponId: string, user = 'buyer') =>
    raw.prepare('INSERT INTO coupon_redemption_extras (id, coupon_id, user_id, order_id, amount_iqd) VALUES (?, ?, ?, ?, 1)').run(`x_${Math.random()}`, couponId, user, twin);
  assert.throws(() => insertExtra(head), /COUPON_GLOBAL_LIMIT/, 'spent as the head of an order');
  assert.throws(() => insertExtra(anExtra), /COUPON_GLOBAL_LIMIT/, 'spent beside it');
  assert.throws(
    () => raw.prepare("INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd, created_at) VALUES ('r_x', ?, 'buyer', ?, 1, ?)").run(anExtra, twin, at(0)),
    /COUPON_GLOBAL_LIMIT/,
    'the head of a second order cannot take one spent beside the first'
  );
  raw.exec("INSERT INTO coupons (id, code, kind, value, active, max_per_user) VALUES ('promo_x', 'PROMOX', 'percent', 10, 1, 1)");
  assert.throws(() => insertExtra('promo_x'), /COUPON_INACTIVE/, 'only a reward coupon ever sits beside another');
  const unspent = codes.find((c) => c.coupon_id !== head && count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemption_extras WHERE coupon_id = ?', c.coupon_id) === 0);
  if (unspent) assert.throws(() => insertExtra(unspent.coupon_id, 'other'), /COUPON_NOT_YOURS/, 'and only for its owner');
});

async function placeOrderRaw(raw: DatabaseSync): Promise<string> {
  paidLine(raw, `ci_tw_${seq++}`, 'p_plain', { qty: 1, fulfillmentType: 'direct_sale' });
  const order = await placeOrder(apps(raw).buyer, { deliveryMethodId: 'pickup', paymentMethodId: 'cash' });
  return order.id as string;
}

test('a promo code stays one per order: it never opens the pool', async () => {
  const raw = world();
  await twoPrintersAndCart(raw);
  raw.exec("INSERT INTO coupons (id, code, kind, value, active, max_per_user, min_total_iqd) VALUES ('promo_y', 'PROMOY', 'percent', 10, 1, 1, 0)");
  const a = apps(raw);
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: 'PROMOY' })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(quote.quote.coupon.code, 'PROMOY');
  assert.equal(quote.quote.coupon.pool, undefined);
});

test('somebody else’s reward code is a code that does not exist, and opens nothing', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw);
  const out = await validateCoupon(envOf(raw), 'other', code('free_shipping'), 500_000);
  assert.deepEqual(out, { ok: false, reason: 'CODE_NOT_FOUND' });
});

test('a code that ended opens this week’s coupons when they can be spent, and says what is wrong with it when they cannot', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw, 1);
  const a = apps(raw);
  const old = code('filament_discount');
  raw.prepare('UPDATE coupons SET ends_at = ? WHERE code = ?').run(new Date(Date.now() - 60_000).toISOString(), old);
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: old })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.notEqual(quote.quote.coupon.code, old, 'the order is headed by a coupon that is live');

  raw.exec("UPDATE coupons SET ends_at = '2020-01-01T00:00:00.000Z' WHERE reward_grant_id IS NOT NULL");
  const dead = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: old })));
  assert.deepEqual([dead.success, dead.code], [false, 'EXPIRED']);
});

test('the hub tells the page what each coupon is worth, and what the programme promises', async () => {
  const raw = world();
  await printerOrder(raw, 1, new Date().toISOString(), true);
  const hub = await json(await get(rewardsApp(raw), '/api/rewards/program'));
  assert.equal(hub.success, true, JSON.stringify(hub));
  assert.deepEqual(hub.program.weekly, { enabled: true, months: 12 });
  assert.deepEqual(hub.program.free_shipping, { enabled: true, amount_iqd: 5_000, min_order_iqd: 100_000 });
  assert.equal(hub.program.filament.max_pieces, 1);
  const ship = hub.coupons.find((c: J) => c.kind === 'free_shipping');
  const fil = hub.coupons.find((c: J) => c.kind === 'filament_discount');
  assert.deepEqual([ship.percent, ship.amount_iqd, ship.min_total_iqd, ship.max_quantity], [0, 5_000, 100_000, null]);
  assert.deepEqual([fil.percent, fil.amount_iqd, fil.min_total_iqd, fil.max_quantity], [15, null, 0, 1]);
});

test('deploy-ahead: on a database without 0225 a reward code goes the ordinary way and the sweep reports it', async () => {
  const raw = world();
  const { code } = await twoPrintersAndCart(raw);
  raw.exec('DROP TRIGGER IF EXISTS trg_orders_coupon_extras_released; DROP TRIGGER IF EXISTS trg_orders_coupon_extras_reclaimed; DROP TRIGGER IF EXISTS trg_coupon_redemption_not_pooled; DROP TRIGGER IF EXISTS trg_coupon_redemption_reclaim_not_pooled; DROP TABLE coupon_redemption_extras;');
  const a = apps(raw);
  const quote = await json(await post(a.buyer, '/api/orders/quote', quoteBody({ couponCode: code('filament_discount') })));
  assert.equal(quote.success, true, JSON.stringify(quote));
  assert.equal(quote.quote.coupon.merchandise_iqd, 2_250, 'one coupon, on its own terms');
  assert.equal(quote.quote.coupon.pool, undefined);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'coupon_redemption_extras'"), 0);
  const order = await placeOrder(a.buyer, { couponCode: code('filament_discount') });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ?', order.id), 1);
  assert.equal((await runRewardSweep(envOf(raw))).installed, false);
});
