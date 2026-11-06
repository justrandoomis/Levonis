/**
 * ADMIN → المكافآت, EVERYTHING FROM THE ADMIN SIDE (owner, 2026-11-05: «every thing to
 * admin side»; DECISIONS row 298): the overview, the printers, the coupons with their
 * filters and pages, and «منح كوبون» with its four eyes. Real migrations, real routers.
 *
 * Run: node --import tsx --test tests/adminRewardsProgramme.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, dbThrough, get, json, post, row, stubApp, type App, type Mount, type StubUser } from './fixtures/app';
import { BUYER, apps, paidLine, placeOrder, type J } from './fixtures/giftWorld';
import { DAY, envOf, handCoupon, looseRow, printerOrder, rewardsWorld, wipeCoupons } from './fixtures/rewardsWorld';
import { REWARD_CONFIG_KEY } from '../worker/lib/rewards/config';
import { adminRewardsRoutes } from '../worker/routes/adminRewards';
import { rewardProgramRoutes } from '../worker/routes/rewardsProgram';
import { runRewardSweep } from '../worker/lib/rewards/sweep';

const OWNER_ADMIN: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const FULL: StubUser = { id: 'fin', role: 'admin', email: 'fin@x.co', admin_scope: 'full' };
const BOSS_USER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'owner' };
const ASSISTANT: StubUser = { id: 'asst', role: 'admin', email: 'asst@x.co', admin_scope: 'assistant' };

const mount: Mount = (a) => {
  a.route('/api/admin/rewards', adminRewardsRoutes);
  a.route('/api/rewards/program', rewardProgramRoutes);
};
const as = (raw: DatabaseSync, user: StubUser | null): App => stubApp(asD1(raw), user, mount);
const staff = (raw: DatabaseSync) => {
  raw.exec(`
    INSERT OR IGNORE INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('fin','Fin','fin@x.co','h','admin','full'),
      ('asst','Asst','asst@x.co','h','admin','assistant');
  `);
  return raw;
};
const NOW = Date.now();
const iso = (days: number) => new Date(NOW + days * DAY).toISOString();

// ------------------------------------------------------------------ authority

test('who may do what: any admin reads, a customer is refused, an assistant grants nothing', async () => {
  const raw = staff(rewardsWorld());
  for (const path of ['/api/admin/rewards/overview', '/api/admin/rewards/printers', '/api/admin/rewards/grants']) {
    assert.equal((await get(as(raw, ASSISTANT), path)).status, 200, `assistant ${path}`);
    assert.equal((await get(as(raw, FULL), path)).status, 200, `full ${path}`);
    assert.equal((await get(as(raw, OWNER_ADMIN), path)).status, 200, `owner ${path}`);
    assert.equal((await get(as(raw, BUYER), path)).status, 403, `customer ${path}`);
    assert.equal((await get(as(raw, null), path)).status, 401, `guest ${path}`);
  }
  const body = { user_id: 'buyer', kind: 'free_shipping', reason: 'a kind word' };
  const refused = await post(as(raw, ASSISTANT), '/api/admin/rewards/grants', body);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 0);
  assert.equal((await post(as(raw, BUYER), '/api/admin/rewards/grants', body)).status, 403);
});

// ------------------------------------------------------------------ the manual grant

test('«منح كوبون»: one coupon from the team on today’s terms, its audit row and its notice in one batch', async () => {
  const raw = staff(rewardsWorld());
  const res = await post(as(raw, FULL), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'free_shipping', reason: 'A late delivery' });
  const out = await json(res);
  assert.equal(res.status, 201, JSON.stringify(out));
  const c = out.coupon;
  assert.deepEqual([c.kind, c.source, c.state, c.amount_iqd, c.min_total_iqd, c.printer], ['free_shipping', 'admin', 'active', 5_000, 100_000, null]);
  assert.match(c.code, /^RWS/);
  assert.equal(new Date(c.expires_at).getTime() - new Date(c.issued_at).getTime(), 7 * DAY, 'the settings’ validity');

  const grant = row<J>(raw, 'SELECT * FROM reward_grants WHERE id = ?', c.id)!;
  assert.equal(grant.source_ref, `admin:${c.id}`);
  assert.equal(grant.created_by, 'fin');
  const audit = row<J>(raw, "SELECT * FROM audit_log WHERE action = 'rewards.grant' AND target = ?", c.id)!;
  const detail = JSON.parse(String(audit.detail ?? audit.details ?? '{}'));
  assert.equal(detail.user_id, 'buyer');
  assert.equal(detail.reason, 'A late delivery');
  assert.equal(detail.authority.tier, 'financial');

  const note = row<J>(raw, "SELECT * FROM user_notifications WHERE user_id = 'buyer' AND kind = 'reward'")!;
  assert.equal(note.link, '/rewards/coupons');
  assert.equal(note.event_key, `reward:team:${c.id}`);
  assert.ok(note.title_ar && note.title_en && note.body_ar && note.body_en);
  assert.ok(JSON.parse(String(note.meta)).body_ckb);
  assert.notEqual(JSON.parse(String(note.meta)).body_ckb, note.body_ar);

  const hub = await json(await get(as(raw, BUYER), '/api/rewards/program'));
  assert.equal(hub.coupons[0].source, 'admin', 'and the customer has it');
});

test('filament terms honour the owner’s selection and his settings; the days are the owner’s bound', async () => {
  const raw = staff(rewardsWorld());
  raw
    .prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)')
    .run(
      REWARD_CONFIG_KEY,
      JSON.stringify({ valid_days: 9, filament: { enabled: true, percent: 20, max_discount_iqd: 7_000, product_ids: ['p_plain'], max_pieces: 2 } })
    );
  const out = await json(await post(as(raw, OWNER_ADMIN), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'filament_discount', reason: 'Goodwill' }));
  const c = out.coupon;
  assert.deepEqual([c.percent, c.max_discount_iqd, c.max_quantity, c.scope, c.product_ids], [20, 7_000, 2, 'products', ['p_plain']]);
  assert.equal(new Date(c.expires_at).getTime() - new Date(c.issued_at).getTime(), 9 * DAY);

  const longer = await json(await post(as(raw, OWNER_ADMIN), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'filament_discount', reason: 'Goodwill', valid_days: 30 }));
  assert.equal(new Date(longer.coupon.expires_at).getTime() - new Date(longer.coupon.issued_at).getTime(), 30 * DAY);
  const tooLong = await post(as(raw, OWNER_ADMIN), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'filament_discount', reason: 'Goodwill', valid_days: 91 });
  assert.equal(tooLong.status, 400);
});

test('four eyes: an admin cannot grant themselves a coupon, and the owner only with a reason', async () => {
  const raw = staff(rewardsWorld());
  const self = await post(as(raw, FULL), '/api/admin/rewards/grants', { user_id: 'fin', kind: 'free_shipping', reason: 'For myself please' });
  assert.equal(self.status, 403);
  assert.equal((await json(self)).code, 'OWNER_REQUIRED');

  const short = await post(as(raw, OWNER_ADMIN), '/api/admin/rewards/grants', { user_id: 'boss', kind: 'free_shipping', reason: 'mine' });
  assert.equal(short.status, 400);
  assert.equal((await json(short)).code, 'OWNER_REASON_REQUIRED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 0);

  const ok = await post(as(raw, OWNER_ADMIN), '/api/admin/rewards/grants', { user_id: 'boss', kind: 'free_shipping', reason: 'A test of my own checkout' });
  assert.equal(ok.status, 201);
});

test('the refusals: no reason, no such kind, no such customer; and a repeated press is the same coupon', async () => {
  const raw = staff(rewardsWorld());
  const app = as(raw, FULL);
  assert.equal((await post(app, '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'free_shipping' })).status, 400);
  assert.equal((await post(app, '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'free_shipping', reason: 'x' })).status, 400);
  assert.equal((await post(app, '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'gold', reason: 'a reason' })).status, 400);
  const nobody = await post(app, '/api/admin/rewards/grants', { user_id: 'nobody', kind: 'free_shipping', reason: 'a reason' });
  assert.equal(nobody.status, 404);
  assert.equal((await json(nobody)).code, 'USER_NOT_FOUND');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 0);

  const body = { user_id: 'buyer', kind: 'free_shipping', reason: 'A late delivery', idempotency_key: 'open-1' };
  const first = await json(await post(app, '/api/admin/rewards/grants', body));
  const again = await json(await post(app, '/api/admin/rewards/grants', body));
  assert.equal(again.replay, true);
  assert.equal(again.coupon.id, first.coupon.id);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 1, 'one coupon');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'rewards.grant'"), 1, 'one audit row');

  // One opening of the dialog keeps one key. A lost answer, another customer chosen: that is a new grant, not «granted» naming the wrong person.
  const toOther = await json(await post(app, '/api/admin/rewards/grants', { ...body, user_id: 'other' }));
  assert.equal(toOther.replay, undefined);
  assert.notEqual(toOther.coupon.id, first.coupon.id);
  assert.equal(row<{ user_id: string }>(raw, 'SELECT user_id FROM reward_grants WHERE id = ?', toOther.coupon.id)!.user_id, 'other');
  const otherKind = await json(await post(app, '/api/admin/rewards/grants', { ...body, kind: 'filament_discount' }));
  assert.equal(otherKind.replay, undefined, 'nor is another kind the same coupon');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM reward_grants'), 3);
});

// ------------------------------------------------------------------ the list

test('the coupons list: filters by source, customer and printer, and pages past any cap', async () => {
  const raw = staff(rewardsWorld());
  const { orderId, itemId } = await printerOrder(raw, 2, iso(-1), true);
  const team = await handCoupon(raw, 'filament_discount');
  await handCoupon(raw, 'free_shipping', 'other');
  const app = as(raw, ASSISTANT);
  const list = async (query: string) => json(await get(app, `/api/admin/rewards/grants?${query}`));

  assert.equal((await list('')).grants.length, 6);
  assert.deepEqual((await list('source=admin')).grants.map((g: J) => g.id).includes(team.grantId), true);
  assert.equal((await list('source=admin')).grants.length, 2);
  assert.equal((await list('source=printer')).grants.length, 4);
  assert.equal((await list('user_id=other')).grants.length, 1);
  const unit1 = await list(`order_item_id=${itemId}&unit_index=1`);
  assert.equal(unit1.grants.length, 2, 'that printer’s coupons');
  assert.ok(unit1.grants.every((g: J) => g.printer.unit_index === 1 && g.order_id === orderId));
  assert.equal((await get(app, `/api/admin/rewards/grants?unit_index=abc`)).status, 400);

  // A page at a time, nothing lost and nothing twice.
  for (let i = 0; i < 60; i++) await handCoupon(raw, 'free_shipping', 'other', { issuedAt: iso(-3 - i / 100) });
  const seen = new Set<string>();
  let cursor = '';
  let pages = 0;
  do {
    const page = await list(`user_id=other${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.ok(page.grants.length <= 50);
    for (const g of page.grants) {
      assert.ok(!seen.has(g.id), 'never twice');
      seen.add(g.id);
    }
    cursor = page.next_cursor ?? '';
    pages += 1;
  } while (cursor);
  assert.equal(seen.size, 61);
  assert.equal(pages, 2);
  assert.equal((await get(app, '/api/admin/rewards/grants?cursor=nonsense')).status, 400);
  assert.equal((await json(await get(app, '/api/admin/rewards/grants?cursor=nonsense'))).code, 'BAD_CURSOR');
});

test('a spent coupon says what it took and the order it went on; extras and heads alike', async () => {
  const raw = staff(rewardsWorld());
  await printerOrder(raw, 2, iso(-1), true);
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 3, fulfillmentType: 'direct_sale' });
  const a = apps(raw);
  const code = row<{ code: string }>(raw, "SELECT c.code FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.kind = 'free_shipping' LIMIT 1")!.code;
  const order = await placeOrder(a.buyer, { couponCode: code });

  const { grants } = await json(await get(as(raw, FULL), '/api/admin/rewards/grants?state=used'));
  assert.equal(grants.length, 4);
  assert.ok(grants.every((g: J) => g.used_on_order_id === order.id));
  assert.equal(grants.reduce((s: number, g: J) => s + g.amount_spent_iqd, 0), Number(order.coupon.discount_iqd), 'the takes add up to the order’s discount');
  assert.deepEqual(grants.map((g: J) => g.amount_spent_iqd).sort((x: number, y: number) => x - y), [2_250, 2_250, 5_000, 5_000]);
});

// ------------------------------------------------------------------ the printers

test('the printers: the same answer as the sweep, by state, searched by customer, order and serial, paged', async () => {
  const raw = staff(rewardsWorld(NOW - 60 * DAY));
  const stopped = await printerOrder(raw, 1, iso(-50));
  raw.prepare("UPDATE order_item_units SET warranty_closed_at = ?, warranty_closed_reason = 'owner_override' WHERE order_id = ?").run(iso(-1), stopped.orderId);
  const earning = await printerOrder(raw, 2, iso(-3));
  const unit = row<{ id: string }>(raw, 'SELECT id FROM order_item_units WHERE order_id = ? AND unit_index = 2', earning.orderId)!;
  looseRow(raw, 'device_serials', { serial_norm: 'SNABC123', serial_raw: 'SN-ABC-123', unit_id: unit.id, assigned_by: 'boss' });

  const app = as(raw, ASSISTANT);
  const list = async (query: string) => json(await get(app, `/api/admin/rewards/printers?${query}`));

  const everyone = await list('state=all');
  assert.equal(everyone.printers.length, 3);
  assert.equal(everyone.next_cursor, null);
  const first = everyone.printers.find((p: J) => p.order_id === earning.orderId && p.unit_index === 2);
  assert.deepEqual([first.customer.id, first.customer.username, first.customer.email], ['buyer', 'sara', 'buyer@x.co']);
  assert.deepEqual(first.name, { ar: 'طابعة A1 mini', en: 'A1 mini', ckb: 'چاپکەری A1 mini' });
  assert.equal(first.serial, 'SN-ABC-123');
  assert.equal(first.earning, true);
  assert.equal(first.stopped, null);
  assert.equal(first.week, 0);
  assert.ok(first.weeks_total >= 50);
  assert.equal(typeof first.warranty_end_at, 'string');
  assert.equal(first.next_at, new Date(NOW - 3 * DAY + 7 * DAY).toISOString());

  const on = await list('state=earning');
  assert.equal(on.printers.length, 2);
  assert.ok(on.printers.every((p: J) => p.earning));
  const off = await list('state=stopped');
  assert.deepEqual(off.printers.map((p: J) => [p.order_id, p.stopped]), [[stopped.orderId, 'warranty_closed']]);

  // The same two the sweep serves.
  wipeCoupons(raw);
  const sweep = await runRewardSweep(envOf(raw), new Date().toISOString());
  assert.equal(sweep.weekly.scanned, on.printers.length);
  const counted = (await list('state=earning')).printers.find((p: J) => p.order_id === earning.orderId && p.unit_index === 2);
  assert.deepEqual([counted.coupons_issued, counted.coupons_spent], [2, 0]);

  assert.equal((await list('q=sara')).printers.length, 3, 'by the customer');
  assert.equal((await list('q=nobody-here')).printers.length, 0);
  assert.equal((await list(`q=${stopped.orderId}`)).printers.length, 1, 'by the order');
  assert.deepEqual((await list('q=ABC-1')).printers.map((p: J) => p.unit_index), [2], 'by the serial');
  assert.equal((await get(app, '/api/admin/rewards/printers?cursor=nonsense')).status, 400);

  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify({ enabled: false }));
  assert.equal((await list('state=earning')).printers.length, 0, 'nothing earns with the programme off');
  const allOff = await list('state=stopped');
  assert.equal(allOff.printers.length, 3);
  assert.ok(allOff.printers.some((p: J) => p.stopped === 'programme_off'));
  assert.ok(allOff.printers.some((p: J) => p.stopped === 'warranty_closed'), 'and a printer’s own reason stands');
});

test('the printers page: fifty at a time, in delivery order, nothing lost', async () => {
  const raw = staff(rewardsWorld(NOW - 60 * DAY));
  await printerOrder(raw, 55, iso(-3));
  const app = as(raw, FULL);
  const first = await json(await get(app, '/api/admin/rewards/printers'));
  assert.equal(first.printers.length, 50);
  assert.ok(first.next_cursor);
  const second = await json(await get(app, `/api/admin/rewards/printers?cursor=${encodeURIComponent(first.next_cursor)}`));
  assert.equal(second.printers.length, 5);
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.printers, ...second.printers].map((p: J) => p.unit_id)).size, 55);
});

// ------------------------------------------------------------------ the overview

test('the overview: printers and customers, what is due, coupons by kind and state, value apart, and no cost', async () => {
  const raw = staff(rewardsWorld(NOW - 60 * DAY));
  await printerOrder(raw, 2, iso(-3), true);
  const app = as(raw, ASSISTANT);

  const start = await json(await get(app, '/api/admin/rewards/overview'));
  assert.equal(start.success, true);
  assert.equal(start.installed, true);
  assert.deepEqual(start.printers, { earning: 2, customers: 1, due_now: 0 }, 'the delivery’s own pair is this week’s');
  assert.deepEqual(start.coupons.free_shipping, { issued: 2, live: 2, spent: 0, expired: 0, withdrawn: 0, use_rate: 0 });
  assert.deepEqual(start.coupons.all, { issued: 4, live: 4, spent: 0, expired: 0, withdrawn: 0, use_rate: 0 });
  assert.deepEqual(start.weekly_exposure, { printers: 2, per_printer_iqd: 30_000, ceiling_iqd: 60_000, filament_uncapped: false }, '(5,000 + the 25,000 ceiling) × 2');
  assert.equal(start.points_taken_by_shop, 0);
  assert.ok(start.last_issued_at);
  assert.deepEqual(start.switches, { enabled: true, weekly: true, free_shipping: true, filament: true, shop_free_shipping: false, shop_filament: false, shop_products: 0, weekly_started: true }, 'and how many products the shop sells for points (DECISIONS row 299)');
  assert.deepEqual(start.attention.shop_without_price, ['free_shipping', 'filament_discount']);

  // Spend them through the real checkout, and a printer is due.
  paidLine(raw, 'ci_goods', 'p_printer', { qty: 1, fulfillmentType: 'direct_sale' });
  paidLine(raw, 'ci_fil', 'p_plain', { qty: 3, fulfillmentType: 'direct_sale' });
  const a = apps(raw);
  const code = row<{ code: string }>(raw, "SELECT c.code FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id WHERE g.kind = 'free_shipping' LIMIT 1")!.code;
  await placeOrder(a.buyer, { couponCode: code });
  await printerOrder(raw, 1, iso(-1));

  const after = await json(await get(app, '/api/admin/rewards/overview'));
  assert.deepEqual(after.printers, { earning: 3, customers: 1, due_now: 1 });
  assert.deepEqual(after.coupons.filament_discount, { issued: 2, live: 0, spent: 2, expired: 0, withdrawn: 0, use_rate: 100 });
  assert.equal(after.coupons.all.use_rate, 100);
  for (const w of ['last_7_days', 'last_30_days', 'all_time']) {
    assert.deepEqual(after.value_spent[w], { goods_iqd: 4_500, delivery_iqd: 10_000, total_iqd: 14_500 }, w);
  }
  assert.doesNotMatch(JSON.stringify(after), /cost_iqd|cost_usd|profit/i);

  // Older than a week: out of the first window, still in the others. Released: out of all of them.
  raw.exec(`UPDATE coupon_redemptions SET created_at = '${iso(-20)}'`);
  raw.exec(`UPDATE coupon_redemption_extras SET created_at = '${iso(-20)}'`);
  const aged = await json(await get(app, '/api/admin/rewards/overview'));
  assert.equal(aged.value_spent.last_7_days.total_iqd, 0);
  assert.equal(aged.value_spent.last_30_days.total_iqd, 14_500);
  raw.exec("UPDATE coupon_redemption_extras SET state = 'released'");
  raw.exec("UPDATE coupon_redemptions SET state = 'released'");
  assert.equal((await json(await get(app, '/api/admin/rewards/overview'))).value_spent.all_time.total_iqd, 0, 'active only');
});

test('the overview’s ceiling and its attention rows: the filament with no ceiling, and what waits', async () => {
  const raw = staff(rewardsWorld(NOW - 60 * DAY));
  await printerOrder(raw, 1, iso(-3));
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(
    REWARD_CONFIG_KEY,
    JSON.stringify({ filament: { enabled: true, percent: 15, max_discount_iqd: null, product_ids: [], max_pieces: 1 }, shop: { free_shipping: { enabled: true, points: 3_000 }, filament_discount: { enabled: false, points: null } } })
  );
  looseRow(raw, 'reward_competitions', { id: 'cmp_open', title_ar: 'مفتوحة', starts_at: iso(-1), ends_at: iso(5), state: 'published' });
  looseRow(raw, 'reward_competitions', { id: 'cmp_done', title_ar: 'منتهية', starts_at: iso(-9), ends_at: iso(-1), state: 'published' });
  looseRow(raw, 'reward_competitions', { id: 'cmp_draft', title_ar: 'مسودة', starts_at: iso(-9), ends_at: iso(-1), state: 'draft' });

  const o = await json(await get(as(raw, FULL), '/api/admin/rewards/overview'));
  assert.deepEqual(o.weekly_exposure, { printers: 1, per_printer_iqd: 5_000, ceiling_iqd: 5_000, filament_uncapped: true });
  assert.deepEqual(o.attention.shop_without_price, [], 'the owner prices only the delivery coupon: the shop is selling, and nothing waits on the other');
  assert.equal(o.attention.competitions_open, 1);
  assert.equal(o.attention.competitions_awaiting_verdict, 1);
  assert.equal(o.switches.shop_free_shipping, true);
});

test('deploy-ahead: before 0220 and before 0225 every read answers 200, empty, installed false, and the grant 503', async () => {
  for (const through of ['0219', '0224']) {
    const raw = dbThrough(through);
    raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Boss','boss@x.co','h','admin'), ('buyer','Sara','buyer@x.co','h','customer')");
    const app = stubApp(asD1(raw), OWNER_ADMIN, mount, { publishV2: false });

    const overview = await get(app, '/api/admin/rewards/overview');
    const o = await json(overview);
    assert.equal(overview.status, 200, `${through}: ${JSON.stringify(o)}`);
    assert.equal(o.installed, false, through);
    assert.equal(o.printers.earning, 0);
    assert.equal(o.coupons.all.issued, 0);

    const printers = await get(app, '/api/admin/rewards/printers');
    const p = await json(printers);
    assert.equal(printers.status, 200, `${through}: ${JSON.stringify(p)}`);
    assert.deepEqual([p.installed, p.printers, p.next_cursor], [false, [], null], through);

    const grants = await get(app, '/api/admin/rewards/grants');
    const g = await json(grants);
    assert.equal(grants.status, 200, through);
    assert.deepEqual([g.installed, g.grants, g.next_cursor], [false, [], null], through);

    const grant = await post(app, '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'free_shipping', reason: 'a reason' });
    assert.equal(grant.status, 503, through);
    assert.equal((await json(grant)).code, 'REWARDS_NOT_INSTALLED');
  }
});

test('the route’s words reach the audit, never the customer: the reason stays with the shop', async () => {
  const raw = staff(rewardsWorld());
  await post(as(raw, FULL), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'free_shipping', reason: 'Internal note about this customer' });
  const notes = all<J>(raw, "SELECT title_ar, title_en, body_ar, body_en, meta FROM user_notifications WHERE user_id = 'buyer'");
  assert.equal(notes.length, 1);
  assert.doesNotMatch(JSON.stringify(notes), /Internal note/);
  const hub = await json(await get(as(raw, BUYER), '/api/rewards/program'));
  assert.doesNotMatch(JSON.stringify(hub), /Internal note/);
});

// ------------------------------------------------------------------ the owner's filament on an offer

test('a ticked filament on a live offer: the settings and the overview say the coupon takes nothing from it, until he rules', async () => {
  const raw = staff(rewardsWorld());
  raw.exec(`INSERT INTO offer_windows (subject_type,subject_id,id,required_tiers,offer_price_mode,offer_price_iqd,active)
    VALUES ('product','p_plain','ofw_plain','[]','fixed',12000,1)`);
  const terms = (filament: Record<string, unknown>) =>
    raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify({ filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, max_pieces: 1, product_ids: ['p_plain'], ...filament } }));
  const app = as(raw, FULL);

  terms({});
  const config = await json(await get(app, '/api/admin/rewards/config'));
  assert.equal(config.config.filament.on_offer, false, 'off unless he turns it on: row 223 #5, one discount per line');
  assert.equal(config.filaments.find((f: J) => f.id === 'p_plain').on_offer, true, 'the list marks it');
  const overview = await json(await get(app, '/api/admin/rewards/overview'));
  assert.deepEqual(overview.attention.filament_on_offer.map((p: J) => p.id), ['p_plain']);
  assert.ok(overview.attention.filament_on_offer[0].name.ar);

  terms({ on_offer: true });
  assert.deepEqual((await json(await get(app, '/api/admin/rewards/overview'))).attention.filament_on_offer, [], 'his ruling clears it');
  terms({ enabled: false });
  assert.deepEqual((await json(await get(app, '/api/admin/rewards/overview'))).attention.filament_on_offer, [], 'and so does a coupon that is off');
  terms({ product_ids: [] });
  assert.deepEqual((await json(await get(app, '/api/admin/rewards/overview'))).attention.filament_on_offer, [], 'nothing ticked: the whole section, and the rest of it still earns');
});

test('an offer that ended, has not begun or sets no price holds nothing back', async () => {
  const raw = staff(rewardsWorld());
  raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify({ filament: { enabled: true, percent: 15, max_discount_iqd: 25_000, max_pieces: 1, product_ids: ['p_plain'] } }));
  const app = as(raw, FULL);
  const windowOf = (over: string) => {
    raw.exec("DELETE FROM offer_windows WHERE subject_id = 'p_plain'");
    raw.exec(`INSERT INTO offer_windows (subject_type,subject_id,id,required_tiers,offer_price_mode,offer_price_iqd,active,starts_at,ends_at) VALUES ('product','p_plain','ofw_plain','[]',${over})`);
  };
  for (const over of [
    "'fixed',12000,1,NULL,'2020-01-01T00:00:00.000Z'",
    "'fixed',12000,1,'2999-01-01T00:00:00.000Z',NULL",
    "'fixed',12000,0,NULL,NULL",
    "'',NULL,1,NULL,NULL",
  ]) {
    windowOf(over);
    assert.deepEqual((await json(await get(app, '/api/admin/rewards/overview'))).attention.filament_on_offer, [], over);
  }
});

test('the save: the switch is the owner’s, an older screen that never saw it keeps it, and a new coupon freezes it', async () => {
  const raw = staff(rewardsWorld());
  const owner = as(raw, BOSS_USER);
  const cfg = (await json(await get(owner, '/api/admin/rewards/config'))).config;
  const put = (body: unknown) => owner.request('/api/admin/rewards/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await put({ ...cfg, filament: { ...cfg.filament, on_offer: 'yes' } })).status, 400, 'a typo is refused');
  const on = await json(await put({ ...cfg, filament: { ...cfg.filament, on_offer: true } }));
  assert.equal(on.config.filament.on_offer, true);

  const { on_offer: _dropped, ...older } = on.config.filament;
  const kept = await json(await put({ ...on.config, filament: older }));
  assert.equal(kept.config.filament.on_offer, true, 'what an older screen never saw keeps what is stored');

  const grant = await json(await post(as(raw, FULL), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'filament_discount', reason: 'A late delivery' }));
  assert.equal(grant.coupon.on_offer, true, 'the customer’s card reads it from the coupon');
  assert.equal(row<{ stacks: number }>(raw, 'SELECT stacks FROM coupons WHERE reward_grant_id = ?', grant.coupon.id)!.stacks, 1);

  const off = await json(await put({ ...kept.config, filament: { ...kept.config.filament, on_offer: false } }));
  assert.equal(off.config.filament.on_offer, false);
  const after = await json(await post(as(raw, FULL), '/api/admin/rewards/grants', { user_id: 'buyer', kind: 'filament_discount', reason: 'Another late one' }));
  assert.equal(after.coupon.on_offer, false);
  assert.equal(row<{ stacks: number }>(raw, 'SELECT stacks FROM coupons WHERE reward_grant_id = ?', after.coupon.id)!.stacks, 0, 'and the first keeps its own');
  assert.equal(row<{ stacks: number }>(raw, 'SELECT stacks FROM coupons WHERE reward_grant_id = ?', grant.coupon.id)!.stacks, 1);
});

test('the shop’s attention: only while it sells nothing at all, and a product on sale counts', async () => {
  const raw = staff(rewardsWorld());
  const app = as(raw, FULL);
  const terms = (shop: Record<string, unknown>) => raw.prepare('INSERT OR REPLACE INTO admin_settings (key, value) VALUES (?, ?)').run(REWARD_CONFIG_KEY, JSON.stringify({ shop }));
  const shopFlag = async () => (await json(await get(app, '/api/admin/rewards/overview'))).attention.shop_without_price;
  terms({});
  assert.deepEqual(await shopFlag(), ['free_shipping', 'filament_discount'], 'nothing on sale, nothing priced');
  terms({ filament_discount: { enabled: true, points: 3_000 } });
  assert.deepEqual(await shopFlag(), []);
  terms({ items: [{ id: 'it', product_id: 'p_plain', option_value_ids: [], color_id: '', qty: 1, sale_type: 'direct_sale', transport_method: '', points: 100, enabled: true }] });
  assert.deepEqual(await shopFlag(), [], 'a shop selling products is a shop selling');
  terms({ free_shipping: { enabled: false, points: 3_000 } });
  assert.deepEqual(await shopFlag(), ['filament_discount'], 'priced but switched off: nothing is on sale, and one still has no price');
});
