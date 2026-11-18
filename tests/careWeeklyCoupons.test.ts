/**
 * THE WEEKLY COUPONS BELONG TO LEVO CARE (owner, 2026-11-19; docs/DECISIONS.md row 359).
 *
 *   «weekly coupons … is included with levo care», «for 12m only, start from day of
 *    delivery and end on 12m», and, asked who gets them from now on: «Only Levo Care buyers».
 *
 * A printer sold on a line that carries frozen printer services (order_items.services_snapshot,
 * sold through «خصص طابعتك») earns the delivery's pair, the weekly pairs and the catch-up only
 * when that snapshot says care_months > 0, for the owner's 12 months from delivery whatever the
 * Care itself runs (24 or 36). A line with no snapshot earns exactly as before: that is how the
 * printers already sold keep theirs. One SQL test decides it for every path and every screen
 * (worker/lib/rewards/earning.ts `slotCareSql`).
 *
 * Real migrations, the real checkout and delivery effects; only the session is stubbed.
 * Run: node --import tsx --test tests/careWeeklyCoupons.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, hasColumn, row } from './fixtures/app';
import { apps, giftWorld, paidLine, placeOrder } from './fixtures/giftWorld';
import type { Env } from '../worker/lib/types';
import { runOrderDeliveredEffects } from '../worker/lib/orderDeliveredEffects';
import { issuePrinterRewards } from '../worker/lib/rewards/coupons';
import { customerPrinters, adminPrintersPage } from '../worker/lib/rewards/printers';
import { rewardsOverview } from '../worker/lib/rewards/overview';
import { lineHasCareSql, slotCareSql, slotStoppedSql } from '../worker/lib/rewards/earning';
import { REWARD_MIGRATION, WEEKLY_MIGRATION, runRewardSweep } from '../worker/lib/rewards/sweep';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-05T09:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const envOf = (raw: DatabaseSync) => ({ DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' }) as unknown as Env;

function world(): DatabaseSync {
  const raw = giftWorld();
  raw.exec(`
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,name_ckb,is_printer_catalog)
      VALUES ('rw_printers',NULL,'rw-printers','طابعات','Printers','چاپکەرەکان',1);
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
      VALUES ('p_printer','reward-printer','A1 mini','طابعة A1 mini','چاپکەری A1 mini',200000,'active',60,'[]','[]','direct_sale','["direct_sale"]','[]','[]','tracked');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0);
    CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  const applied = new Date(NOW - 30 * DAY).toISOString().replace('T', ' ').slice(0, 19);
  for (const name of [REWARD_MIGRATION, WEEKLY_MIGRATION]) raw.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(name, applied);
  return raw;
}

/** The frozen services of a line, as the checkout writes them (packages/pricing/src/printerServices.ts). */
const services = (warranty: 0 | 12 | 24, care: 0 | 12) =>
  JSON.stringify({ warranty_months: warranty, care_months: care, care_total_months: care ? warranty + 12 : 0, revision: 1, lines: [] });

let seq = 0;
/** A printer order through the real checkout; `snapshot` is frozen on its line before the delivery. */
async function printerOrder(raw: DatabaseSync, snapshot: string | null, deliveredAt = at(0), qty = 1) {
  const a = apps(raw);
  paidLine(raw, `ci_cw_${seq++}`, 'p_printer', { qty, fulfillmentType: 'direct_sale' });
  const order = await placeOrder(a.buyer, { deliveryMethodId: 'pickup', paymentMethodId: 'cash' });
  const item = row<{ id: string }>(raw, "SELECT id FROM order_items WHERE order_id = ? AND product_id = 'p_printer'", order.id)!;
  if (snapshot !== null) raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(snapshot, item.id);
  raw.prepare("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?").run(deliveredAt, order.id);
  await runOrderDeliveredEffects(envOf(raw), order.id);
  raw.prepare('UPDATE order_item_units SET delivered_at = ?, warranty_start_at = ? WHERE order_id = ?').run(deliveredAt, deliveredAt, order.id);
  return { orderId: order.id as string, itemId: item.id };
}

const refsOf = (raw: DatabaseSync, orderId: string) =>
  all<{ source_ref: string }>(raw, 'SELECT source_ref FROM reward_grants WHERE order_id = ? ORDER BY source_ref', orderId).map((r) => r.source_ref);
const wipe = (raw: DatabaseSync, orderId: string) => {
  raw.prepare('UPDATE coupons SET reward_grant_id = NULL WHERE reward_grant_id IN (SELECT id FROM reward_grants WHERE order_id = ?)').run(orderId);
  raw.prepare('DELETE FROM coupons WHERE id IN (SELECT coupon_id FROM reward_grants WHERE order_id = ?)').run(orderId);
  raw.prepare('DELETE FROM reward_grants WHERE order_id = ?').run(orderId);
};
const sweep = (raw: DatabaseSync, nowIso: string) => runRewardSweep(envOf(raw), nowIso);

test('a printer sold through the services WITHOUT Levo Care earns nothing: not on delivery, not weekly, not by the catch-up', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, services(12, 0), at(0));
  assert.deepEqual(refsOf(raw, orderId), [], 'the delivery issues no pair');
  assert.equal((await issuePrinterRewards(envOf(raw), orderId, at(0))).reason, 'no_printer', 'asked again, the order has no earning printer');

  const soon = await sweep(raw, at(1));
  assert.deepEqual(soon.catch_up, { scanned: 0, issued: 0, errors: 0 }, 'the catch-up does not even look at it');
  assert.deepEqual(soon.weekly, { scanned: 0, issued: 0, errors: 0 });
  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 0, issued: 0, errors: 0 }, 'no weekly pair either');
  assert.deepEqual(refsOf(raw, orderId), []);

  const [mine] = await customerPrinters(asD1(raw), 'buyer', at(7));
  assert.equal(mine.earning, false);
  assert.equal(mine.stopped, 'no_care', 'the customer’s «طابعاتك» says why');
  const adminList = await adminPrintersPage(asD1(raw), { state: 'stopped' }, at(7));
  assert.deepEqual(adminList.printers.map((p) => p.stopped), ['no_care'], 'and so does the admin’s list');
  assert.equal((await adminPrintersPage(asD1(raw), { state: 'earning' }, at(7))).printers.length, 0);
  assert.equal((await rewardsOverview(asD1(raw), at(7))).printers.earning, 0, 'the overview counts it out');
});

test('with Levo Care it earns the delivery’s pair and every week for 12 months from delivery only, even when the Care runs 36', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, services(24, 12), at(0));
  assert.deepEqual(refsOf(raw, orderId), [`printer:${itemId}:1:filament_discount`, `printer:${itemId}:1:free_shipping`], 'the delivery’s own pair');

  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 1, issued: 2, errors: 0 }, 'week one');
  assert.deepEqual((await sweep(raw, at(7.1))).weekly, { scanned: 0, issued: 0, errors: 0 }, 'never twice');

  const [mine] = await customerPrinters(asD1(raw), 'buyer', at(7));
  assert.equal(mine.earning, true);
  assert.equal(mine.stopped, null);
  assert.equal(mine.ends_at?.slice(0, 10), '2027-11-05', 'the coupons end 12 months after the delivery');
  assert.equal((await rewardsOverview(asD1(raw), at(7))).printers.earning, 1);

  assert.deepEqual((await sweep(raw, at(360))).weekly, { scanned: 1, issued: 2, errors: 0 }, 'still inside the year');
  const before = refsOf(raw, orderId).length;
  assert.deepEqual((await sweep(raw, at(366))).weekly, { scanned: 0, issued: 0, errors: 0 }, 'after 12 months nothing, though the Care runs to month 36');
  assert.deepEqual((await sweep(raw, at(700))).weekly, { scanned: 0, issued: 0, errors: 0 });
  assert.equal(refsOf(raw, orderId).length, before);
  const [later] = await customerPrinters(asD1(raw), 'buyer', at(366));
  assert.equal(later.stopped, 'warranty_over', 'the coupon year is over');
});

test('Levo Care bought with NO warranty still earns its 12 months: the window is the delivery’s, not the warranty’s', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, services(0, 12), at(0));
  const base = row<{ m: number | null }>(raw, 'SELECT warranty_base_months AS m FROM order_item_units WHERE order_id = ?', orderId)!;
  assert.equal(base.m, 0, 'the unit’s own warranty is zero months');
  assert.equal(refsOf(raw, orderId).length, 2);
  assert.deepEqual((await sweep(raw, at(200))).weekly, { scanned: 1, issued: 2, errors: 0 });
  const [mine] = await customerPrinters(asD1(raw), 'buyer', at(200));
  assert.equal(mine.earning, true);
  assert.equal(mine.ends_at?.slice(0, 10), '2027-11-05');
  assert.deepEqual((await sweep(raw, at(366))).weekly, { scanned: 0, issued: 0, errors: 0 });
});

test('the catch-up gives a Care printer the pair its delivery missed, and never one to a serviced printer without Care', async () => {
  const raw = world();
  const care = await printerOrder(raw, services(12, 12), at(0));
  const bare = await printerOrder(raw, services(12, 0), at(0));
  wipe(raw, care.orderId);
  const out = await sweep(raw, at(0.5));
  assert.deepEqual(out.catch_up, { scanned: 1, issued: 2, errors: 0 });
  assert.equal(refsOf(raw, care.orderId).length, 2);
  assert.equal(refsOf(raw, bare.orderId).length, 0);
});

test('a line with no frozen services keeps exactly what it had: the printers already sold', async () => {
  const raw = world();
  const { orderId, itemId } = await printerOrder(raw, null, at(0));
  assert.equal(row<{ s: string | null }>(raw, 'SELECT services_snapshot AS s FROM order_items WHERE id = ?', itemId)!.s, null);
  assert.equal(refsOf(raw, orderId).length, 2, 'the delivery’s pair, as before');
  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 1, issued: 2, errors: 0 });
  const [mine] = await customerPrinters(asD1(raw), 'buyer', at(7));
  assert.equal(mine.earning, true);
  assert.equal(mine.ends_at?.slice(0, 10), '2027-11-05');
  assert.deepEqual((await sweep(raw, at(366))).weekly, { scanned: 0, issued: 0, errors: 0 }, 'its own 12 months end as they always did');
});

test('one order, three kinds of line: only the Care one and the legacy one earn', async () => {
  const raw = world();
  const care = await printerOrder(raw, services(12, 12), at(0));
  const bare = await printerOrder(raw, services(24, 0), at(0));
  const old = await printerOrder(raw, null, at(0));
  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 2, issued: 4, errors: 0 });
  assert.equal(refsOf(raw, care.orderId).length, 4);
  assert.equal(refsOf(raw, old.orderId).length, 4);
  assert.equal(refsOf(raw, bare.orderId).length, 0);
  const mine = await customerPrinters(asD1(raw), 'buyer', at(7));
  assert.deepEqual(mine.map((p) => p.stopped).sort(), ['no_care', null, null].sort());
});

test('a snapshot that is not JSON earns nothing and breaks nothing', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, null, at(0));
  wipe(raw, orderId);
  raw.prepare("UPDATE order_items SET services_snapshot = '{broken' WHERE order_id = ?").run(orderId);
  assert.deepEqual((await sweep(raw, at(7))).weekly, { scanned: 0, issued: 0, errors: 0 });
  assert.equal((await customerPrinters(asD1(raw), 'buyer', at(7)))[0].stopped, 'no_care');
});

test('a database without the services column (before 0234) issues as it always did', async () => {
  const raw = world();
  const { orderId } = await printerOrder(raw, null, at(0));
  wipe(raw, orderId);
  raw.exec('ALTER TABLE order_items DROP COLUMN services_snapshot');
  assert.equal(hasColumn(raw, 'order_items', 'services_snapshot'), false, 'this really is a database without the column');

  assert.equal((await issuePrinterRewards(envOf(raw), orderId, at(0))).issued, 2, 'the delivery’s pair');
  const out = await sweep(raw, at(7));
  assert.equal(out.installed, true);
  assert.deepEqual(out.weekly, { scanned: 1, issued: 2, errors: 0 });
  const [mine] = await customerPrinters(asD1(raw), 'buyer', at(7));
  assert.equal(mine.earning, true);
  assert.equal((await rewardsOverview(asD1(raw), at(7))).printers.earning, 1);
});

test('the fragments are one definition: «stopped» is NULL exactly when the Care test holds, and neither is ever NULL', () => {
  const stopped = slotStoppedSql({ now: '?1', months: '?3' });
  assert.ok(stopped.includes(slotCareSql()), 'the screens read the test the sweep runs');
  assert.match(stopped, /THEN 'no_care'/);
  for (const sql of [slotCareSql(), lineHasCareSql('u.order_item_id')]) assert.match(sql, /^COALESCE\(/, 'a missing line reads as a plain 0/1');
});
