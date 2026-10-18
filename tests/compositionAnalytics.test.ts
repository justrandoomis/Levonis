/**
 * COMPOSITION AND MYSTERY ANALYTICS — docs/BUNDLES_MYSTERY.md §12, §1.10.
 *
 * TWO PROPERTIES, AND BOTH OF THEM ARE ABOUT WHAT IS *NOT* THERE.
 *
 * 1. NOTHING CUSTOMER-SENSITIVE IS REACHABLE. `mystery_allocation_stats`
 *    projects `(day, pool_id, pool_entry_id, product_id, color_id, sale_mode,
 *    n)` and nothing else — no order id, no user id, no address. That is a
 *    structural guarantee only while the analytics code READS THE VIEW rather
 *    than the base table, so this file asserts the view's own columns AND
 *    walks the admin payloads looking for an order id or a user id.
 *
 * 2. THE COUNTERS ARE IDEMPOTENT PER DAY AND PER SUBJECT.
 *    `INSERT … ON CONFLICT(day, subject_id) DO UPDATE` is one row per (day,
 *    subject) however many taps land on it, which is what keeps add-to-cart
 *    analytics one write instead of five — and an unvalidated subject can
 *    never be seeded into the table at all, or the only conversion figure the
 *    owner reads has a denominator anyone can inflate.
 *
 * Everything else on those screens is DERIVED — a query over the parent
 * `order_items` rows and their frozen snapshots — so it cannot drift from what
 * was actually sold, and there is no second place where revenue is written
 * down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, stubApp, post, get, json, all, count, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { bundlesRoutes, adminCompositionAnalyticsRoutes } from '../worker/routes/bundles';
import { bundleAnalytics, metricStatement, mysteryAnalytics, utcDay } from '../worker/lib/compositionAnalytics';
import { seedCatalogue, addBundle, orderBody, DEFAULT_COMPONENTS } from './lib/bundles';
import { addMysteryOffer, seedMysteryPool } from './lib/mysteryOffer';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };

const appFor = (db: unknown, user: StubUser | null = buyer, host?: string) =>
  stubApp(
    db,
    user,
    (a) => {
      a.route('/api/cart', cartRoutes);
      a.route('/api/orders', orderRoutes);
      a.route('/api/bundles', bundlesRoutes);
      a.route('/api/admin/analytics', adminCompositionAnalyticsRoutes);
    },
    host ? { host } : {}
  );

// ------------------------------------------------------------ the view

test('mystery_allocation_stats exposes no order id and no user id, by construction', () => {
  const raw = seedCatalogue();
  const cols = all<{ name: string }>(raw, "SELECT name FROM pragma_table_info('mystery_allocation_stats')").map(
    (c) => c.name
  );
  assert.deepEqual(cols.sort(), ['color_id', 'day', 'n', 'pool_entry_id', 'pool_id', 'product_id', 'sale_mode'].sort());
  for (const forbidden of ['order_id', 'order_item_id', 'user_id', 'seed', 'revealed_at', 'candidates_sha256']) {
    assert.ok(!cols.includes(forbidden), `the analytics view exposes ${forbidden}`);
  }
});

test('composition_daily_metrics carries no user, no order and no address column', () => {
  const raw = seedCatalogue();
  const cols = all<{ name: string }>(raw, "SELECT name FROM pragma_table_info('composition_daily_metrics')").map(
    (c) => c.name
  );
  assert.deepEqual(cols.sort(), ['adds', 'day', 'oos_blocks', 'subject_id', 'views'].sort());
});

// -------------------------------------------------------- the counters

test('the counters are idempotent per (day, subject): many taps, one row', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const day = utcDay();
  for (let i = 0; i < 5; i += 1) await metricStatement(db, 'p_x', 'views')!.run();
  await metricStatement(db, 'p_x', 'adds')!.run();
  await metricStatement(db, 'p_x', 'oos_blocks')!.run();
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM composition_daily_metrics'), 1);
  const r = row<{ day: string; views: number; adds: number; oos_blocks: number }>(
    raw,
    'SELECT day, views, adds, oos_blocks FROM composition_daily_metrics WHERE subject_id = ?',
    'p_x'
  )!;
  assert.equal(r.day, day);
  assert.equal(r.views, 5);
  assert.equal(r.adds, 1);
  assert.equal(r.oos_blocks, 1);
  // The field name is chosen from a fixed list, never interpolated from input.
  assert.equal(metricStatement(db, 'p_x', 'stock' as never), null);
  assert.equal(metricStatement(db, '', 'views'), null);
});

test('the view counter is SIGNED-IN only and refuses an unvalidated subject', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'p_bundle', priceIqd: 400000, components: DEFAULT_COMPONENTS });
  const db = asD1(raw);

  // Anonymous: no row at all. An IP bucket that Iraqi carriers NAT heavily
  // would both undercount real customers and let anyone inflate the only
  // conversion denominator the owner reads (§10, §12).
  const anon = await appFor(db, null).request('/api/bundles/p_bundle/view', { method: 'POST' });
  assert.equal(anon.status >= 400, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM composition_daily_metrics'), 0);

  // A signed-in view of a real composition row counts once.
  const ok = await json(await post(appFor(db), '/api/bundles/p_bundle/view'));
  assert.equal(ok.success, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM composition_daily_metrics WHERE subject_id = ?', 'p_bundle'), 1);

  // An ORDINARY product is not a composition subject, and neither is a string
  // somebody invented: nothing may be seeded into the table.
  const ordinary = await post(appFor(db), '/api/bundles/p_pla/view');
  assert.equal(ordinary.status, 404);
  const nonsense = await post(appFor(db), '/api/bundles/not-a-product/view');
  assert.equal(nonsense.status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM composition_daily_metrics'), 1);
});

test('a successful add counts once, in the same batch as the line it counts', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'p_bundle', priceIqd: 400000, components: DEFAULT_COMPONENTS });
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'p_bundle', qty: 1 });
  assert.equal(
    row<{ adds: number }>(raw, 'SELECT adds FROM composition_daily_metrics WHERE subject_id = ?', 'p_bundle')!.adds,
    1
  );

  // A refusal on AVAILABILITY counts an `oos_blocks` and writes no line…
  // Five is inside `max_qty_per_order`, so the refusal is the AVAILABILITY one
  // (`max_bundles` is 3 on the owner's worked example) rather than the cap —
  // the cap is a policy refusal and is deliberately not a stock statistic.
  const refused = await json(await post(app, '/api/cart/items', { productId: 'p_bundle', qty: 5 }));
  assert.equal(refused.success, false);
  const after = row<{ adds: number; oos_blocks: number }>(
    raw,
    'SELECT adds, oos_blocks FROM composition_daily_metrics WHERE subject_id = ?',
    'p_bundle'
  )!;
  assert.equal(after.adds, 1, 'a refused add was counted as an add');
  assert.equal(after.oos_blocks, 1);
});

test('a membership lock is not counted as a stock problem', async () => {
  const raw = seedCatalogue();
  addBundle(raw, {
    id: 'p_locked',
    priceIqd: 400000,
    components: DEFAULT_COMPONENTS,
    window: { required_tiers: '["plus"]' },
  });
  const db = asD1(raw);
  const refused = await json(await post(appFor(db), '/api/cart/items', { productId: 'p_locked', qty: 1 }));
  assert.equal(refused.code, 'MEMBERSHIP_REQUIRED');
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM composition_daily_metrics WHERE subject_id = ?', 'p_locked'),
    0,
    'a locked offer inflated the out-of-stock counter'
  );
});

// -------------------------------------------------------- the derived side

test('revenue and savings are DERIVED from the parent rows, never counted twice', async () => {
  const raw = seedCatalogue();
  // Components total 400000 + 2×25000 + 5000 = 455000; the bundle sells at
  // 400000, so the saving is 55000 and it is on the PARENT's snapshot.
  addBundle(raw, { id: 'p_bundle', priceIqd: 400000, components: DEFAULT_COMPONENTS });
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'p_bundle', qty: 1 });
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 300));
  raw.prepare("UPDATE orders SET status = 'confirmed' WHERE id = ?").run(String(placed.order.id));

  const { rows, totals } = await bundleAnalytics(db);
  const bundleRow = rows.find((r) => r.product_id === 'p_bundle')!;
  assert.ok(bundleRow, 'the purchased bundle is not in the analytics');
  assert.equal(bundleRow.orders, 1);
  assert.equal(bundleRow.units, 1);
  // The parent's line total, and NOT the four rows the order really holds:
  // a component's `line_total_iqd` is 0, so including them would leave revenue
  // right and unit counts quadrupled.
  assert.equal(bundleRow.revenue_iqd, Number(placed.order.subtotal_iqd));
  assert.equal(bundleRow.savings_iqd, 455000 - 400000);
  assert.equal(totals.revenue_iqd, bundleRow.revenue_iqd);
  // Conversion is over SIGNED-IN views and is labelled as such at the API.
  // Nothing viewed the detail page in this test, so the denominator is 0 and
  // the conversion figure is null rather than a fabricated 100 %.
  assert.equal(bundleRow.views, 0);
  assert.equal(bundleRow.conversion_percent, null);
  assert.equal(bundleRow.adds, 1);
});

test('the mystery figures come from the view, and name no customer', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw);
  addMysteryOffer(raw);
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1 });
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true);

  const stats = await mysteryAnalytics(db);
  assert.equal(stats.by_mode.find((m) => m.sale_mode === 'direct')!.n, 2);
  assert.equal(stats.by_pool[0].pool_id, 'mpl_test');
  assert.ok(stats.by_product.length > 0);
  // A pool entry with weight and zero allocations is visible as a stock
  // problem — the row an owner most needs and the one a GROUP BY over the
  // allocations would drop.
  assert.equal(stats.by_entry.length, 4);
  assert.ok(stats.by_entry.some((e) => e.n === 0));

  const body = JSON.stringify(stats);
  assert.ok(!body.includes(String(placed.order.id)), 'the mystery analytics carry an order id');
  assert.ok(!body.includes('buyer'), 'the mystery analytics carry a user id');
});

// ------------------------------------------------------------- the guards

test('the analytics routes are admin-only and apex-only', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  // A signed-in customer is refused by the router's OWN `requireAdmin`;
  // `requireMainHost` is a host check and would have let them straight in.
  assert.equal((await get(appFor(db, buyer), '/api/admin/analytics/bundles')).status, 403);
  assert.equal((await get(appFor(db, null), '/api/admin/analytics/mystery')).status, 401);
  assert.equal(
    (await get(appFor(db, boss, 'somestore.levonis-iq.com'), '/api/admin/analytics/bundles')).status,
    404,
    'the analytics screens are reachable from a merchant subdomain'
  );
  const okRes = await json(await get(appFor(db, boss), '/api/admin/analytics/bundles'));
  assert.equal(okRes.success, true);
  assert.equal(okRes.conversion_basis, 'signed_in_views');
});
