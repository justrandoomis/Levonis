/**
 * THE SHELVES BELOW THE FOLD.
 *
 * The owner asked for sections the storefront did not have — «الأكثر مبيعًا»،
 * «flash deals»، «الفيلمنت العشوائي»، «الكومبو»، «سوبر ديلز» — and for each to
 * be drawn its own way rather than as another horizontal rail.
 *
 * Two of them turned out to be already built and simply never surfaced:
 * `offer_windows` (migration 0060) is the shop's scheduled-offer table and
 * /api/home passed a literal `null` where every other route passes the offer
 * view, and `products.is_featured` is the flag the admin form already writes.
 * The tests here pin what each shelf SELECTS, because the selection is the
 * part that can silently become wrong.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, ctx, freshDb, json, stubApp } from './fixtures/app';
import { homeRoutes } from '../worker/routes/products';
import {
  bestSellerIds,
  featuredIds,
  filamentCandidateIds,
  flashDealIds,
  seededShuffle,
  shuffleSeed,
  SHUFFLE_BUCKET_MS,
} from '../worker/lib/homeShelves';
import { SOLD_STATES, SOLD_STATES_SQL } from '../worker/lib/soldStates';

type Raw = ReturnType<typeof freshDb>;

function product(raw: Raw, id: string, extra: Record<string, unknown> = {}): void {
  const cols = { slug: id, name: id, description: '', price_iqd: 100000, status: 'active', ...extra };
  const keys = ['id', ...Object.keys(cols)];
  raw.prepare(
    `INSERT INTO products (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(id, ...Object.values(cols));
}

/** One order in `status`, carrying `qty` of `productId`. */
function sale(raw: Raw, orderId: string, status: string, productId: string, qty: number): void {
  raw.prepare(
    `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
                         payment_method_id, subtotal_iqd, total_iqd, exchange_rate, due_on_delivery_iqd)
     VALUES (?, 'u1', ?, '{}', 'dm', '{}', 'cash', 1000, 1000, 1400, 0)`
  ).run(orderId, status);
  raw.prepare(
    `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES (?, ?, ?, 'x', ?, 1000, 1000)`
  ).run(`oi_${orderId}_${productId}`, orderId, productId, qty);
}

function user(raw: Raw): void {
  raw.prepare(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ('u1','a@b.c','A','x','customer')`
  ).run();
}

// =========================================================================
// BEST SELLERS
// =========================================================================

test('best sellers ranks by units actually sold, most first', async () => {
  const raw = freshDb();
  user(raw);
  product(raw, 'p_few');
  product(raw, 'p_many');
  sale(raw, 'o1', 'delivered', 'p_few', 1);
  sale(raw, 'o2', 'confirmed', 'p_many', 5);
  assert.deepEqual(await bestSellerIds(asD1(raw)), ['p_many', 'p_few']);
});

test('an order whose stock has NOT moved does not make a best seller', async () => {
  /**
   * `pending` is an unpaid order and `cancelled` is not a sale at all.
   * Counting either would put a product on the shelf on the strength of a
   * purchase that never happened — which is what
   * `adminProducts.ts`'s `status != 'cancelled'` does, and why this shelf does
   * not copy it. See worker/lib/soldStates.ts.
   */
  const raw = freshDb();
  user(raw);
  product(raw, 'p1');
  sale(raw, 'o1', 'pending', 'p1', 9);
  sale(raw, 'o2', 'cancelled', 'p1', 9);
  assert.deepEqual(await bestSellerIds(asD1(raw)), []);
});

test('every state this shelf counts is one the inventory lifecycle deducts stock in', () => {
  // The two lists must not drift: a state that counts as a sale here but not
  // as a stock movement there would rank a product the shop never shipped.
  assert.deepEqual([...SOLD_STATES], ['confirmed', 'processing', 'shipped', 'delivered']);
  assert.equal(SOLD_STATES_SQL, "('confirmed','processing','shipped','delivered')");
});

test('best sellers can be scoped to a department, descendants included', async () => {
  const raw = freshDb();
  user(raw);
  product(raw, 'p_printer', { category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm' });
  product(raw, 'p_filament', { category_id: 'cat_materials', sub_category_id: 'cat_materials_fdm' });
  sale(raw, 'o1', 'delivered', 'p_printer', 2);
  sale(raw, 'o2', 'delivered', 'p_filament', 9);
  assert.deepEqual(
    await bestSellerIds(asD1(raw), { catalogId: 'cat_printers' }),
    ['p_printer'],
    'the filament outsells it and still belongs to a different department'
  );
});

test('a bundle row is not ranked beside ordinary products', async () => {
  const raw = freshDb();
  user(raw);
  product(raw, 'p1');
  product(raw, 'b1', { composition: 'bundle' });
  sale(raw, 'o1', 'delivered', 'b1', 50);
  sale(raw, 'o2', 'delivered', 'p1', 1);
  assert.deepEqual(await bestSellerIds(asD1(raw)), ['p1']);
});

// =========================================================================
// FLASH DEALS
// =========================================================================

function offerWindow(raw: Raw, id: string, productId: string, over: Record<string, unknown> = {}): void {
  const row = {
    subject_type: 'product',
    subject_id: productId,
    id,
    starts_at: null as string | null,
    ends_at: null as string | null,
    offer_price_mode: 'discount_percent',
    discount_percent: 10,
    active: 1,
    ...over,
  };
  const keys = Object.keys(row);
  raw.prepare(
    `INSERT INTO offer_windows (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  ).run(...Object.values(row));
}

const NOW = '2026-06-01T12:00:00.000Z';

test('flash deals are live, priced windows — ending soonest first', async () => {
  const raw = freshDb();
  product(raw, 'p_late');
  product(raw, 'p_soon');
  offerWindow(raw, 'ofw_late', 'p_late', { ends_at: '2026-06-09T00:00:00.000Z' });
  offerWindow(raw, 'ofw_soon', 'p_soon', { ends_at: '2026-06-02T00:00:00.000Z' });
  assert.deepEqual(await flashDealIds(asD1(raw), NOW), ['p_soon', 'p_late']);
});

test('a window that changes no price is a schedule, not a deal', async () => {
  // offer_price_mode '' means the window is a gate or a limit. Putting one on
  // a deals shelf advertises a discount that does not exist.
  const raw = freshDb();
  product(raw, 'p1');
  offerWindow(raw, 'ofw_1', 'p1', { offer_price_mode: '', discount_percent: null });
  assert.deepEqual(await flashDealIds(asD1(raw), NOW), []);
});

test('an expired, a not-yet-started and an inactive window are all absent', async () => {
  const raw = freshDb();
  product(raw, 'p_over');
  product(raw, 'p_future');
  product(raw, 'p_off');
  offerWindow(raw, 'ofw_over', 'p_over', { ends_at: '2026-05-01T00:00:00.000Z' });
  offerWindow(raw, 'ofw_future', 'p_future', { starts_at: '2026-07-01T00:00:00.000Z' });
  offerWindow(raw, 'ofw_off', 'p_off', { active: 0 });
  assert.deepEqual(await flashDealIds(asD1(raw), NOW), []);
});

test('a MEMBERS-ONLY deal is still selected — eligibility is not an SQL filter', async () => {
  /**
   * Filtering `required_tiers = '[]'` in the query would hide a members-only
   * offer from the member it was built for. The route resolves eligibility
   * through `offerEligible`, exactly as /api/bundles does, so the card can be
   * shown locked to a guest and priced to a member.
   */
  const raw = freshDb();
  product(raw, 'p1');
  offerWindow(raw, 'ofw_1', 'p1', { required_tiers: '["plus"]' });
  assert.deepEqual(await flashDealIds(asD1(raw), NOW), ['p1']);
});

// =========================================================================
// FILAMENT
// =========================================================================

test('the filament pool is the materials branch and everything under it', async () => {
  const raw = freshDb();
  product(raw, 'p_pla', { category_id: 'cat_materials', sub_category_id: 'cat_materials_fdm' });
  product(raw, 'p_resin', { category_id: 'cat_materials', sub_category_id: 'cat_materials_resin' });
  product(raw, 'p_printer', { category_id: 'cat_printers', sub_category_id: 'cat_printers_fdm' });
  const pool = await filamentCandidateIds(asD1(raw), 'cat_materials');
  assert.deepEqual(pool.sort(), ['p_pla', 'p_resin'], 'a printer is not a filament');
});

test('the shuffle is STABLE inside a bucket and changes between buckets', () => {
  // ORDER BY RANDOM() re-rolls on every request including the client's own
  // refetch, so scrolling away and back would show a different shelf — which
  // reads as a bug rather than as variety.
  const pool = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const t = 1_800_000_000_000;
  const first = seededShuffle(pool, shuffleSeed(t));
  assert.deepEqual(seededShuffle(pool, shuffleSeed(t + 1000)), first, 'same bucket, same shelf');
  assert.notDeepEqual(
    seededShuffle(pool, shuffleSeed(t + SHUFFLE_BUCKET_MS)),
    first,
    'the next bucket is a different handful'
  );
  assert.deepEqual([...first].sort(), pool, 'a shuffle loses and invents nothing');
});

// =========================================================================
// SUPER DEALS
// =========================================================================

test('super deals is the owner’s own featured flag', async () => {
  const raw = freshDb();
  product(raw, 'p_plain');
  product(raw, 'p_push', { is_featured: 1 });
  assert.deepEqual(await featuredIds(asD1(raw)), ['p_push']);
});

// =========================================================================
// THE ENDPOINT
// =========================================================================

test('/api/home/sections answers every shelf, and an empty shop is not an error', async () => {
  const raw = freshDb();
  const a = stubApp(asD1(raw) as never, null, (x) => x.route('/api/home', homeRoutes), {
    host: APEX,
    env: { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'b@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
  const res = await a.request('/api/home/sections', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);
  assert.equal(res.status, 200);
  const body = await json(res);
  for (const key of ['best_sellers', 'flash_deals', 'filament', 'super_deals']) {
    assert.ok(Array.isArray(body[key]), `${key} must always be a list`);
  }
});

test('the endpoint keeps each shelf’s own ranking — IN (...) does not', async () => {
  // The rows come back in one `WHERE id IN (...)` read, which has no order at
  // all. Re-applying each id list is what stops the best-seller shelf arriving
  // in whatever order SQLite happened to scan.
  const raw = freshDb();
  user(raw);
  product(raw, 'p_a');
  product(raw, 'p_b');
  sale(raw, 'o1', 'delivered', 'p_b', 10);
  sale(raw, 'o2', 'delivered', 'p_a', 1);
  const a = stubApp(asD1(raw) as never, null, (x) => x.route('/api/home', homeRoutes), {
    host: APEX,
    env: { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'b@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });
  const body = await json(
    await a.request('/api/home/sections', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx)
  );
  assert.deepEqual((body.best_sellers as { id: string }[]).map((p) => p.id), ['p_b', 'p_a']);
});
