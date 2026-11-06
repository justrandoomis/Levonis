/**
 * EVERY PRINTER AND WHAT IT EARNS (owner, 2026-11-05: «coupons with every printer»;
 * DECISIONS row 298). The customer's «طابعاتك» and the sweep read ONE definition, and this
 * holds them to it, case by case: a printer reads `earning` exactly when the weekly sweep
 * would serve it. Real migrations, real routers; only the session is stubbed.
 *
 * Run: node --import tsx --test tests/rewardsPrinters.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, dbThrough, row, stubApp, type Mount } from './fixtures/app';
import { BUYER, get, json, type J } from './fixtures/giftWorld';
import { DAY, envOf, handCoupon, looseRow, printerOrder, rewardsWorld, wipeCoupons } from './fixtures/rewardsWorld';
import { parsePrinterSourceRef, printerSourceRef, listUserRewardCoupons } from '../worker/lib/rewards/coupons';
import { REWARD_CONFIG_KEY } from '../worker/lib/rewards/config';
import { customerPrinters } from '../worker/lib/rewards/printers';
import { runRewardSweep } from '../worker/lib/rewards/sweep';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';

const NOW = Date.parse('2026-11-05T09:00:00.000Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const mount: Mount = (a) => a.route('/api/rewards/program', rewardProgramRoutes);

test('a coupon’s key reads back: the slot, the kind and the week, and anything else is no printer', () => {
  const unit = { order_item_id: 'oi_abc:def', unit_index: 3 };
  for (const kind of ['free_shipping', 'filament_discount'] as const) {
    assert.deepEqual(parsePrinterSourceRef(printerSourceRef(unit, kind)), { order_item_id: 'oi_abc:def', unit_index: 3, kind, week: 0 });
    assert.deepEqual(parsePrinterSourceRef(printerSourceRef(unit, kind, 7)), { order_item_id: 'oi_abc:def', unit_index: 3, kind, week: 7 });
  }
  for (const other of ['shop:rwg_1', 'admin:rwg_2', '', null, undefined, 'printer:oi:1', 'printer:oi:x:free_shipping']) {
    assert.equal(parsePrinterSourceRef(other), null, String(other));
  }
});

/** The read's word and the sweep's act on one printer at one instant, the printer's coupons gone so the sweep would serve it. */
async function bothSay(raw: DatabaseSync, nowIso: string) {
  wipeCoupons(raw);
  const printers = await customerPrinters(asD1(raw), 'buyer', nowIso);
  const served = (await runRewardSweep(envOf(raw), nowIso)).weekly.scanned;
  wipeCoupons(raw);
  return { printers, served };
}

/** The read and the sweep agree that this printer earns, or that it does not and why. */
async function holds(raw: DatabaseSync, nowIso: string, expect: { earning: true } | { earning: false; stopped: string | null }, why: string) {
  const { printers, served } = await bothSay(raw, nowIso);
  const earning = printers.some((p) => p.earning);
  assert.equal(earning, served > 0, `${why}: the read says ${earning}, the sweep served ${served}`);
  assert.equal(earning, expect.earning, why);
  if (!expect.earning) {
    // A line that was never a printer of the programme is not listed at all.
    if (expect.stopped === null) assert.deepEqual(printers, [], why);
    else assert.equal(printers[0]?.stopped, expect.stopped, why);
  }
}

test('the read says earning exactly when the sweep would serve it: what stops a printer, one door at a time', async () => {
  const raw = rewardsWorld(NOW);
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  const now = at(1);
  const setting = (v: J) => raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify(v));

  await holds(raw, now, { earning: true }, 'a printer in its warranty');

  setting({ enabled: false });
  await holds(raw, now, { earning: false, stopped: 'programme_off' }, 'the programme off');
  setting({ weekly: { enabled: false, months: 12 } });
  await holds(raw, now, { earning: false, stopped: 'programme_off' }, 'the weeks off');
  setting({ free_shipping: { enabled: false }, filament: { enabled: false } });
  await holds(raw, now, { earning: false, stopped: 'programme_off' }, 'both coupons off');
  setting({});
  await holds(raw, now, { earning: true }, 'switched back on');

  raw.prepare("UPDATE orders SET seller_type = 'merchant' WHERE id = ?").run(orderId);
  await holds(raw, now, { earning: false, stopped: null }, 'a store’s order');
  raw.prepare("UPDATE orders SET seller_type = 'levonis' WHERE id = ?").run(orderId);

  raw.prepare("UPDATE order_items SET gift_entitlement_id = 'ge_fake' WHERE id = ?").run(itemId);
  await holds(raw, now, { earning: false, stopped: null }, 'a gift line');
  raw.prepare('UPDATE order_items SET gift_entitlement_id = NULL WHERE id = ?').run(itemId);

  raw.prepare("DELETE FROM product_catalogs WHERE product_id = 'p_printer'").run();
  await holds(raw, now, { earning: false, stopped: null }, 'not a printer any more');
  raw.prepare("INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','rw_printers',0)").run();

  raw.prepare("UPDATE orders SET status = 'shipped' WHERE id = ?").run(orderId);
  await holds(raw, now, { earning: false, stopped: null }, 'not delivered');
  raw.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);

  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'owner_override' WHERE order_id = ?").run(at(0.5), orderId);
  await holds(raw, now, { earning: false, stopped: 'warranty_closed' }, 'the warranty closed');
  raw.prepare("UPDATE order_item_units SET warranty_closed_reason = 'returned' WHERE order_id = ?").run(orderId);
  await holds(raw, now, { earning: false, stopped: 'returned' }, 'closed by a return');
  raw.prepare('UPDATE order_item_units SET warranty_closed_at = NULL, warranty_closed_reason = NULL WHERE order_id = ?').run(orderId);

  looseRow(raw, 'trade_in_requests', { id: 'ti_1', user_id: 'buyer', order_item_id: itemId, unit_index: 1, status: 'completed', scope: 'whole', completed_at: at(0.5) });
  await holds(raw, now, { earning: false, stopped: 'traded_in' }, 'traded in');
  raw.prepare('DELETE FROM trade_in_requests').run();

  looseRow(raw, 'trade_in_requests', { id: 'ti_2', user_id: 'buyer', order_item_id: itemId, unit_index: 1, status: 'awaiting_payment', scope: 'whole', intake_at: at(0.5) });
  await holds(raw, now, { earning: false, stopped: 'in_shop' }, 'in the shop for a trade-in');
  raw.prepare("UPDATE trade_in_requests SET status = 'cancelled', device_returned_at = ? WHERE id = 'ti_2'").run(at(0.7));
  await holds(raw, now, { earning: true }, 'handed back');
  raw.prepare('DELETE FROM trade_in_requests').run();
  looseRow(raw, 'trade_in_requests', { id: 'ti_3', user_id: 'buyer', order_item_id: itemId, unit_index: 1, status: 'awaiting_payment', scope: 'ams_only', intake_at: at(0.5) });
  await holds(raw, now, { earning: true }, 'only its AMS is in the shop');
  raw.prepare('DELETE FROM trade_in_requests').run();

  looseRow(raw, 'return_cases', { id: 'rc_1', order_id: orderId, order_item_id: itemId, user_id: 'buyer', state: 'resolved', resolution: 'refund', qty: 1 });
  await holds(raw, now, { earning: false, stopped: 'returned' }, 'a refund that named no unit');
  raw.prepare('DELETE FROM return_cases').run();

  await holds(raw, at(366), { earning: false, stopped: 'warranty_over' }, 'past its months');
  raw.prepare('UPDATE order_item_units SET warranty_base_months = 6 WHERE order_id = ?').run(orderId);
  await holds(raw, at(190), { earning: false, stopped: 'warranty_over' }, 'a six-month warranty is six months');
  raw.prepare('UPDATE order_item_units SET warranty_base_months = 12 WHERE order_id = ?').run(orderId);

  await holds(raw, at(1), { earning: true }, 'every door undone');
});

test('a bundle parent is not the device: its row reads nothing, as the sweep passes it over', async () => {
  const raw = rewardsWorld(NOW);
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  await holds(raw, at(1), { earning: true }, 'before it has a component');
  looseRow(raw, 'order_items', { id: 'oi_kid', order_id: orderId, product_id: 'p_plain', name_snapshot: 'Kid', qty: 1, unit_price_iqd: 0, line_total_iqd: 0, bundle_parent_item_id: itemId });
  await holds(raw, at(1), { earning: false, stopped: null }, 'a bundle parent');
});

test('a printer replaced under warranty is one printer on its slot, and stops when the replacement’s warranty closes', async () => {
  const raw = rewardsWorld(NOW);
  const { orderId, itemId } = await printerOrder(raw, 1, at(0));
  const unit = row<{ id: string; product_id: string }>(raw, 'SELECT id, product_id FROM order_item_units WHERE order_id = ?', orderId)!;
  raw
    .prepare(
      `INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_ext_months, warranty_start_at, warranty_end_at, policy_version, replacement_of_unit_id)
       VALUES ('unit_repl', ?, ?, ?, 'buyer', 2, ?, 12, 0, ?, ?, '{}', ?)`
    )
    .run(orderId, itemId, unit.product_id, at(10), at(0), at(365), unit.id);
  raw.prepare("UPDATE order_item_units SET replaced_by_unit_id = 'unit_repl', warranty_closed_at = ?, warranty_closed_reason = 'replaced' WHERE id = ?").run(at(10), unit.id);

  const { printers, served } = await bothSay(raw, at(14));
  assert.equal(served, 1, 'one printer');
  assert.equal(printers.length, 1, 'the replacement is not a second printer');
  assert.deepEqual([printers[0].earning, printers[0].unit_index, printers[0].week], [true, 1, 2], 'on the slot the customer bought');

  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'owner_override' WHERE id = 'unit_repl'").run(at(15));
  await holds(raw, at(21), { earning: false, stopped: 'warranty_closed' }, 'the device in the customer’s hands');
});

test('a database that cannot say when the weeks began issues nothing, and says the programme is off', async () => {
  const raw = rewardsWorld(NOW);
  await printerOrder(raw, 1, at(0));
  raw.exec('DELETE FROM d1_migrations');
  await holds(raw, at(1), { earning: false, stopped: 'programme_off' }, 'no start to count from');
});

test('what each printer says: its week of its weeks, the next coupons, when it ends, and this week’s coupons', async () => {
  const raw = rewardsWorld(NOW);
  const { itemId } = await printerOrder(raw, 2, at(0), true);
  await runRewardSweep(envOf(raw), at(10));

  const printers = await customerPrinters(asD1(raw), 'buyer', at(10));
  assert.equal(printers.length, 2, 'one row per unit');
  const [first] = printers;
  assert.equal(first.order_item_id, itemId);
  assert.equal(first.unit_index, 1);
  assert.equal(first.product_slug, 'reward-printer');
  assert.deepEqual(first.name, { ar: 'طابعة A1 mini', en: 'A1 mini', ckb: 'چاپکەری A1 mini' });
  assert.equal(first.image, 'https://cdn/a1.png');
  assert.equal(first.earning, true);
  assert.equal(first.stopped, null);
  assert.equal(first.week, 1, 'day 10 is the second week, 0 first');
  assert.equal(first.weeks_total, 53, '12 months of seven-day weeks');
  assert.equal(first.next_at, at(14), 'seven days after the week’s start');
  assert.equal(first.ends_at, '2027-11-05T09:00:00.000Z', 'twelve calendar months from the warranty’s start');
  assert.deepEqual(first.this_week.map((c) => [c.kind, c.state]).sort(), [['filament_discount', 'active'], ['free_shipping', 'active']]);
  assert.ok(first.this_week.every((c) => Date.parse(c.expires_at) > Date.parse(at(10))));

  // The last week has no next.
  const last = await customerPrinters(asD1(raw), 'buyer', at(364.5));
  assert.equal(last[0].earning, true);
  assert.equal(last[0].week, 52);
  assert.equal(last[0].next_at, null, 'the next week would fall past its end');
});

test('a printer’s week counts from the programme’s start when it was delivered before, and the first-week pair is week 0', async () => {
  const raw = rewardsWorld(NOW);
  await printerOrder(raw, 1, at(-100));
  const [p] = await customerPrinters(asD1(raw), 'buyer', at(8));
  assert.equal(p.week, 1);
  assert.equal(p.next_at, at(14));
  assert.equal(p.weeks_total, Math.ceil((Date.parse('2027-07-28T09:00:00.000Z') - NOW) / (7 * DAY)));
});

test('earning first, at most forty, and only the customer’s own', async () => {
  const raw = rewardsWorld(NOW);
  const stoppedOne = await printerOrder(raw, 1, at(-300));
  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'owner_override' WHERE order_id = ?").run(at(-1), stoppedOne.orderId);
  await printerOrder(raw, 1, at(-200));
  const printers = await customerPrinters(asD1(raw), 'buyer', at(0));
  assert.deepEqual(printers.map((p) => p.earning), [true, false], 'the stopped one last, though it is older or newer');
  assert.deepEqual(await customerPrinters(asD1(raw), 'other', at(0)), []);

  await printerOrder(raw, 41, at(-1));
  const many = await customerPrinters(asD1(raw), 'buyer', at(0));
  assert.equal(many.length, 40);
  assert.ok(many.every((p) => p.earning));
});

test('the route: the customer’s printers, no cost and no order figure, with the server’s clock', async () => {
  const raw = rewardsWorld();
  await printerOrder(raw, 1, new Date(Date.now() - DAY).toISOString(), true);
  const app = stubApp(asD1(raw), BUYER, mount);
  const res = await get(app, '/api/rewards/program/printers');
  const out = await json(res);
  assert.equal(res.status, 200);
  assert.deepEqual([out.success, out.installed], [true, true]);
  assert.equal(typeof out.server_time, 'string');
  assert.equal(out.printers.length, 1);
  assert.deepEqual(Object.keys(out.printers[0]).sort(), [
    'delivered_at',
    'earning',
    'ends_at',
    'image',
    'name',
    'next_at',
    'order_item_id',
    'product_slug',
    'stopped',
    'this_week',
    'unit_index',
    'warranty_start_at',
    'week',
    'weeks_total',
  ]);
  assert.doesNotMatch(JSON.stringify(out), /cost_iqd|unit_price_iqd/);
});

test('deploy-ahead: before 0220 and before 0225 the same 200, empty, installed false', async () => {
  for (const through of ['0219', '0224']) {
    const raw = dbThrough(through);
    raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','buyer@x.co','h','customer')");
    const app = stubApp(asD1(raw), BUYER, mount, { publishV2: false });
    const res = await get(app, '/api/rewards/program/printers');
    const out = await json(res);
    assert.equal(res.status, 200, through);
    assert.deepEqual([out.success, out.installed, out.printers], [true, false, []], through);
  }
});

test('a coupon names its printer and its week; the shop’s and the team’s name none', async () => {
  const raw = rewardsWorld(NOW);
  const { itemId } = await printerOrder(raw, 1, new Date(Date.now() - DAY).toISOString(), true);
  await handCoupon(raw, 'free_shipping');
  raw.prepare("UPDATE reward_grants SET source_ref = ? WHERE order_item_id = ? AND kind = 'filament_discount'").run(printerSourceRef({ order_item_id: itemId, unit_index: 1 }, 'filament_discount', 4), itemId);

  const views = await listUserRewardCoupons(asD1(raw), 'buyer');
  const printerCoupon = views.find((v) => v.source === 'printer' && v.kind === 'filament_discount')!;
  assert.deepEqual(printerCoupon.printer, {
    name: { ar: 'طابعة A1 mini', en: 'A1 mini', ckb: 'چاپکەری A1 mini' },
    image: 'https://cdn/a1.png',
    unit_index: 1,
    week: 4,
    product_slug: 'reward-printer',
  });
  assert.equal(views.find((v) => v.source === 'printer' && v.kind === 'free_shipping')!.printer!.week, 0, 'the delivery’s own pair is week 0');
  assert.equal(views.find((v) => v.source === 'admin')!.printer, null);
});
