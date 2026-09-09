/**
 * CASE 15 of the owner's seventeen — "the reveal leaks nothing before the
 * milestone" — docs/BUNDLES_MYSTERY.md §8.
 *
 * THE TABLE IN §8.2 IS THE CHECKLIST; THIS FILE IS THE GUARANTEE.
 *
 * The shape of the assertion matters more than its length. For every
 * customer-facing surface the contract enumerates, the WHOLE serialized body
 * is searched for every token that identifies the drawn filament — its id, its
 * slug, its name, its image URL, its colour id — AND for every one of its
 * PRICES. The prices are the half a naive implementation gets wrong: nothing
 * names the product, and then the component's `pricing_snapshot` carries its
 * ladder and the invoice prints "43,000" beside a line whose name says
 * "Mystery Box", and a buyer with the catalogue open knows exactly what is in
 * the parcel. The fixture gives every candidate a distinct price for that
 * reason.
 *
 * Surface 18 gets the assertion that defeats the other four milestones on its
 * own: the whole public product payload is captured BEFORE and AFTER the
 * purchase and compared. Levonis publishes exact sellable counts per option
 * value and per colour to anonymous callers, so two unauthenticated GETs
 * around a checkout would otherwise identify the pick deterministically — no
 * statistics required.
 *
 * And the admin side is asserted POSITIVELY, not by the absence of leaks
 * elsewhere: an allocation that reached the API and stopped there would leave
 * the justification for admins holding this data at all unimplemented.
 *
 * MONOTONICITY HAS TWO AXES and the first draft of this design asserted only
 * one. Walking the ORDER backwards must not un-reveal — and editing
 * `bundle_config.reveal_stage` in EITHER direction must move no existing
 * order's milestone, because that row is shared by every past and in-flight
 * order of the offer. The frozen `reveal_stage_snapshot` is what makes the
 * second one true, and only a test that edits the config can see it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, row, count, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { productRoutes } from '../worker/routes/products';
import { returnRoutes } from '../worker/routes/returns';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { isRevealed, milestoneReached, reachedMilestones, stageForMilestone } from '../worker/lib/mysteryReveal';
import { seedCatalogue, orderBody } from './lib/bundles';
import { addMysteryOffer, forbiddenTokens, seedMysteryPool, COLOR_POOL_PRODUCT, POOL_PRODUCTS } from './lib/mysteryOffer';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const boss: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };

const appFor = (db: unknown, user: StubUser | null = buyer) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/products', productRoutes);
    a.route('/api/returns', returnRoutes);
    a.route('/api/admin', adminRoutes);
  });

interface Bought {
  raw: DatabaseSync;
  db: D1Database;
  orderId: string;
  drawn: string[];
}

async function buyMystery(spec: Parameters<typeof addMysteryOffer>[1] = {}): Promise<Bought> {
  const raw = seedCatalogue();
  seedMysteryPool(raw);
  addMysteryOffer(raw, spec);
  const db = asD1(raw);
  const app = appFor(db);
  const added = await json(await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1 }));
  assert.equal(added.success, true, `add-to-cart failed: ${JSON.stringify(added).slice(0, 300)}`);
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, `checkout failed: ${JSON.stringify(placed).slice(0, 400)}`);
  const orderId = String(placed.order.id);
  const drawn = all<{ product_id: string }>(
    raw,
    'SELECT product_id FROM mystery_allocations WHERE order_id = ?',
    orderId
  ).map((r) => r.product_id);
  assert.ok(drawn.length > 0, 'the purchase drew nothing');
  return { raw, db, orderId, drawn };
}

/** Every string that identifies the pick, in one list, searched as text
 *  against the whole serialized body — a field-by-field check would pass the
 *  moment a new field is added. */
function assertNoLeak(label: string, payload: unknown, raw: DatabaseSync, drawn: string[]) {
  const body = JSON.stringify(payload);
  for (const token of forbiddenTokens(raw, drawn)) {
    assert.ok(!body.includes(token), `${label} leaked "${token}" before the reveal:\n${body.slice(0, 900)}`);
  }
}

// ------------------------------------------------------------ the pure part

test('the milestone table is the contract, and the two journeys share it', () => {
  const direct = { stage: 'preparing', status: 'processing', shipping_type: 'direct' as const };
  assert.equal(milestoneReached('confirmed', direct, false), true);
  assert.equal(milestoneReached('preparing', direct, false), true);
  assert.equal(milestoneReached('shipped', direct, false), false);
  assert.equal(milestoneReached('delivered', direct, false), false);
  // `'preparing'` maps onto a DIFFERENT stage on the fourteen-stage journey,
  // and it is written in exactly one place.
  assert.equal(stageForMilestone('preparing', 'direct'), 'preparing');
  assert.equal(stageForMilestone('preparing', 'preorder_air'), 'supplier_preparing');
  const pre = { stage: 'supplier_preparing', status: 'processing', shipping_type: 'preorder_air' as const };
  assert.equal(milestoneReached('preparing', pre, false), true);
  assert.equal(milestoneReached('shipped', pre, false), false);
  // `'paid'` is a settlement fact and no stage satisfies it.
  assert.equal(stageForMilestone('paid', 'direct'), null);
  assert.equal(milestoneReached('paid', { stage: 'delivered', status: 'delivered', shipping_type: 'direct' }, false), false);
  assert.equal(milestoneReached('paid', { stage: 'received', status: 'pending', shipping_type: 'direct' }, true), true);
  assert.deepEqual(reachedMilestones(direct, false), ['confirmed', 'preparing']);
});

test('revealed_at, once written, IS the truth — a backwards derivation cannot undo it', () => {
  const at = { stage: 'received', status: 'pending', shipping_type: 'direct' as const };
  assert.equal(isRevealed({ revealed_at: null, reveal_stage_snapshot: 'delivered' }, at, false), false);
  assert.equal(isRevealed({ revealed_at: '2026-01-01T00:00:00Z', reveal_stage_snapshot: 'delivered' }, at, false), true);
});

// -------------------------------------------------------- the twenty surfaces

test('case 15: no customer surface carries the pick, its prices or its images before the milestone', async () => {
  const { raw, db, orderId, drawn } = await buyMystery({ revealStage: 'delivered' });
  const app = appFor(db);

  // 1, 2 — orderPublic and the products join for product_slug.
  const detail = await json(await get(app, `/api/orders/${orderId}`));
  assertNoLeak('GET /api/orders/:id', detail, raw, drawn);
  const line = detail.order.items.find((i: Record<string, unknown>) => !!i.mystery);
  assert.ok(line, 'the mystery line carries no mystery block at all');
  assert.equal(line.mystery.revealed, false);
  assert.equal(line.mystery.spools, 2);
  assert.equal(line.mystery.reveal_at, 'delivered');
  // ABSENT, not empty: a key that exists is a key a refactor fills in.
  assert.equal('picks' in line.mystery, false, 'the pre-reveal block carries a picks key');
  // The customer sees ONE line, not two zero-price spool rows.
  assert.equal(detail.order.items.length, 1);

  // The order list.
  assertNoLeak('GET /api/orders', await json(await get(app, '/api/orders')), raw, drawn);

  // 3 — the units endpoint joins on order_items.product_id, which is NULL.
  assertNoLeak('GET /api/orders/:id/units', await json(await get(app, `/api/orders/${orderId}/units`)), raw, drawn);

  // 4 — tracking is stage labels only.
  assertNoLeak('GET /api/orders/:id/tracking', await json(await get(app, `/api/orders/${orderId}/tracking`)), raw, drawn);

  // 19 — the component rows themselves, as persisted.
  const spools = all<Record<string, unknown>>(
    raw,
    'SELECT * FROM order_items WHERE bundle_parent_item_id IS NOT NULL AND order_id = ?',
    orderId
  );
  assert.equal(spools.length, 2);
  for (const s of spools) {
    assert.equal(s.product_id, null, 'a mystery spool persisted a product id');
    assert.equal(s.pricing_snapshot, null, 'a mystery spool persisted a pricing snapshot');
    assert.equal(s.name_snapshot, 'Mystery Filament Box');
    // The share is OFFER-DERIVED: it sums to the parent's line total and is
    // not any candidate's own price.
    assert.ok(!POOL_PRODUCTS.some((p) => p.price === Number(s.component_value_iqd)));
  }
  const parent = row<Record<string, unknown>>(
    raw,
    'SELECT * FROM order_items WHERE bundle_parent_item_id IS NULL AND order_id = ?',
    orderId
  )!;
  assert.equal(
    spools.reduce((n, s) => n + Number(s.component_alloc_iqd ?? 0), 0),
    Number(parent.line_total_iqd)
  );
  // The parent's own snapshot is serialized wholesale into `orderPublic`, so
  // its composition block must carry no items at all for a mystery line.
  assertNoLeak('order_items.pricing_snapshot (parent)', parent.pricing_snapshot, raw, drawn);

  // 9 — the OrderCreated outbox row: it must EXIST (a swallowed validation
  // failure is invisible) and carry no drawn product id.
  const outbox = all<{ envelope: string; event_type: string }>(
    raw,
    'SELECT event_type, envelope FROM core_outbox_events WHERE aggregate_id = ?',
    orderId
  );
  const created = outbox.filter((e) => String(e.event_type).includes('OrderCreated'));
  if (created.length > 0) assertNoLeak('OrderCreated', created[0].envelope, raw, drawn);

  // 15 — the return flow refuses rather than listing the pick.
  const returned = await json(
    await post(app, '/api/returns', { orderItemId: String(parent.id), qty: 1, reason: 'damaged' })
  );
  assert.equal(returned.success, false);
  assertNoLeak('POST /api/returns', returned, raw, drawn);
});

test('case 15: the cart and the quote carry no components and no pick', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw);
  addMysteryOffer(raw);
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1 });

  // 12 — `composition.components` is [] for a mystery line, ALWAYS.
  const cart = await json(await get(app, '/api/cart'));
  const item = cart.items.find((i: Record<string, unknown>) => i.kind === 'mystery');
  assert.ok(item, 'the mystery line vanished from the cart');
  assert.deepEqual(item.composition.components, []);
  assert.equal(item.composition.mystery.spool_qty, 2);
  // Not a pool, not a candidate, not a weight.
  assert.equal('pool_id' in item.composition.mystery, false);
  assert.equal('candidates' in item.composition.mystery, false);
  assertNoLeak('GET /api/cart', cart, raw, POOL_PRODUCTS.map((p) => p.id));

  // 20 — the quote nests nothing top-level and, crucially, WRITES NOTHING.
  const quote = await json(await post(app, '/api/orders/quote', orderBody()));
  assert.equal(quote.success, true, JSON.stringify(quote).slice(0, 300));
  assert.equal(quote.quote.lines.length, 1, 'a mystery line produced more than one quote line');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations'), 0, 'the quote wrote an allocation');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM mystery_draw_audits'), 0, 'the quote wrote an audit row');
  assertNoLeak('POST /api/orders/quote', quote, raw, POOL_PRODUCTS.map((p) => p.id));
});

/**
 * Surface 18 has TWO moments, and the reservation is only the first.
 *
 * `reserve` bumps `stock_reserved` in the order's own batch, so an exact
 * `available` moves the instant the order commits. But `deduct` decrements
 * `stock` ITSELF and runs at `confirmed` — so a differential taken only at the
 * reservation cannot see a projection that publishes `product_colors.stock`
 * verbatim, which is precisely the leak that defeats 'preparing', 'shipped'
 * and 'delivered'. The pool therefore carries a COLOUR-TRACKED candidate, and
 * the catalogue is snapshotted a third time after the stage move.
 */
test('case 15, surface 18: the public catalogue is byte-identical around the purchase AND the confirmation', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw, 'mpl_test', { withColorCandidate: true });
  addMysteryOffer(raw);
  const db = asD1(raw);
  const anon = appFor(db, null);

  const slugs = [...POOL_PRODUCTS.map((p) => p.slug), COLOR_POOL_PRODUCT.slug];
  const snapshot = async () => {
    const out: Record<string, unknown> = {};
    for (const slug of slugs) out[slug] = await json(await get(anon, `/api/products/${slug}`));
    out.__list = await json(await get(anon, '/api/products?limit=50'));
    return JSON.stringify(out);
  };

  const before = await snapshot();
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1 });
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 300));
  const orderId = String(placed.order.id);
  const afterReserve = await snapshot();

  // The reservation really happened…
  assert.ok(
    count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'reserve' AND order_id = ?", orderId) > 0,
    'nothing was reserved, so this assertion proves nothing'
  );
  // …and NO per-colour or per-option number moved in the public payload.
  assert.equal(afterReserve, before, 'the anonymous catalogue changed around a mystery purchase — surface 18 is open');

  // Now the deduction, which moves `stock` itself rather than `stock_reserved`.
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  const { deductOrderStock } = await import('../worker/lib/orderInventory');
  await deductOrderStock(db, orderId, 'boss');
  assert.ok(
    count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'deduct' AND order_id = ?", orderId) > 0,
    'nothing was deducted, so the second half of this assertion proves nothing'
  );
  const afterDeduct = await snapshot();
  assert.equal(afterDeduct, before, 'the anonymous catalogue moved at CONFIRMED — surface 18 is open at the option/colour level');
});

test('case 15, surface 18: a pool member publishes no per-colour count at all', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw, 'mpl_test', { withColorCandidate: true });
  addMysteryOffer(raw);
  const anon = appFor(asD1(raw), null);
  const body = await json(await get(anon, `/api/products/${COLOR_POOL_PRODUCT.slug}`));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 300));
  assert.equal(body.product.stock, null, 'the base counter is coarse');
  assert.ok(body.product.colors.length >= 2, 'the colour rows are still published — only their counts are not');
  for (const c of body.product.colors as Array<Record<string, unknown>>) {
    assert.equal(c.stock, null, `colors[].stock published an exact count for ${String(c.id)}`);
    assert.equal(c.low_stock_threshold, null);
  }
  for (const o of (body.product.options ?? []) as Array<Record<string, unknown>>) {
    assert.equal(o.stock, null, 'options[].stock published an exact count');
  }
});

/**
 * §8.2 ROW 18 IS A PUBLICATION RULE, NOT A CATALOGUE-ROUTE RULE.
 *
 * `coarseStock` was threaded only through the anonymous product routes, while
 * `GET /api/cart` and every cart and checkout refusal read the same four stock
 * tables with no coarsening. Because `reserve` bumps `stock_reserved` inside
 * the order's own batch, a buyer could snapshot the candidates THROUGH THEIR
 * OWN CART before and after checking out and read the drawn product and the
 * spool count off the delta — which defeats every milestone including 'paid',
 * the one §17 decision 10 promises is deliverable even if coarse counts are
 * rejected. The refusal variant needs no purchase at all.
 */
test('case 15, surface 18: the CART payload publishes no count for a pool member, before or after the purchase', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw, 'mpl_test', { withColorCandidate: true });
  addMysteryOffer(raw);
  const db = asD1(raw);
  const app = appFor(db);

  // A pool member sitting in the cart as an ORDINARY line is a customer
  // payload that reads the same stock rows the catalogue does.
  await post(app, '/api/cart/items', { productId: 'mp_c', qty: 1 });
  const cartLine = (body: Record<string, unknown>) =>
    (body.items as Array<Record<string, unknown>>).find((i) => i.productId === 'mp_c')!;

  const before = await json(await get(app, '/api/cart'));
  const lineBefore = cartLine(before);
  assert.equal(lineBefore.stock, null, 'GET /api/cart published an exact base count for a pool member');
  assert.equal((lineBefore.availability as Record<string, Record<string, unknown>>).stock.available, null);
  assert.equal((lineBefore.availability as Record<string, Record<string, unknown>>).stock.on_hand, null);

  await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1 });
  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 300));
  assert.ok(
    count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE kind = 'reserve' AND order_id = ?", String(placed.order.id)) > 0,
    'nothing was reserved, so the differential proves nothing'
  );

  // The cart is empty now, so the pool member is re-added and re-read: the
  // payload must be identical to the one taken before the draw.
  await post(app, '/api/cart/items', { productId: 'mp_c', qty: 1 });
  const after = cartLine(await json(await get(app, '/api/cart')));
  assert.equal(
    JSON.stringify(after.availability),
    JSON.stringify(lineBefore.availability),
    'the cart line moved around a mystery purchase — the cart is an oracle'
  );
  assert.equal(after.stock, null);
});

test('case 15, surface 18: a cart refusal names no count for a pool member', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw, 'mpl_test', { withColorCandidate: true });
  addMysteryOffer(raw);
  const db = asD1(raw);
  const app = appFor(db);

  // A quantity far above the real stock: the refusal used to answer
  // "Only 9 left" for one candidate and "Only 7 left" for another, which is
  // the whole pool's inventory published on demand, for free, with no order.
  const refused = await json(await post(app, '/api/cart/items', { productId: 'mp_c', qty: 99 }));
  assert.equal(refused.success, false, JSON.stringify(refused));
  assert.equal(refused.code, 'QTY_UNAVAILABLE');
  assert.doesNotMatch(String(refused.error), /Only \d+ left/, 'the refusal published an exact count');
  for (const n of [7, 9]) {
    assert.doesNotMatch(String(refused.error), new RegExp(`\\b${n}\\b`), `the refusal leaked the count ${n}`);
  }

  // And the same door for a product that is NOT in a pool still says how many
  // are left — the coarse rule is membership-scoped, not a blanket silence.
  const ordinary = await json(await post(app, '/api/cart/items', { productId: 'p_pla', qty: 99 }));
  assert.equal(ordinary.code, 'QTY_UNAVAILABLE', JSON.stringify(ordinary));
  assert.match(String(ordinary.error), /Only 6 left/);
});

test('case 15, surface 18: the checkout stock refusal names no count for a pool member', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw, 'mpl_test', { withColorCandidate: true });
  addMysteryOffer(raw);
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'mp_c', qty: 5 });
  // The stock is pulled out from under the cart AFTER the line was written,
  // so the door — not the add — is the surface under test.
  raw.exec("UPDATE products SET stock = 2 WHERE id = 'mp_c'");
  const refused = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(refused.success, false, JSON.stringify(refused).slice(0, 300));
  assert.equal(refused.code, 'OUT_OF_STOCK');
  assert.doesNotMatch(String(refused.error), /Only \d+/, 'the checkout refusal published an exact count');
});

/**
 * THE SHIPPING QUOTE IS A CUSTOMER PAYLOAD (§8.2, beyond the table's row 20).
 *
 * `shippingItems` was built from the DRAWN candidate's own `ops_policy`, so
 * `quote.shipping.components[].kind` named the pick's size class — published on
 * `POST /api/orders/quote`, which draws but writes nothing, and then frozen
 * into `delivery_method_snapshot` and served back on `GET /api/orders/:id`
 * from the first second. Any pool that is not perfectly homogeneous in
 * `size_class` leaked a partition of the candidate set, before the purchase
 * and after it. The pool below is deliberately heterogeneous.
 */
test('case 15: the shipping quote and the frozen delivery snapshot name no size class from the pool', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw);
  addMysteryOffer(raw, { revealStage: 'delivered' });
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/cart/items', { productId: 'p_mystery', qty: 1 });

  // The pre-purchase oracle: repeated quotes must not move with the draw.
  const fees = new Set<number>();
  for (let i = 0; i < 6; i += 1) {
    const q = await json(await post(app, '/api/orders/quote', orderBody()));
    assert.equal(q.success, true, JSON.stringify(q).slice(0, 300));
    const kinds = (q.quote.shipping.components as Array<{ kind: string }>).map((k) => k.kind);
    assert.equal(kinds.includes('printer_large'), false, 'the quote named the drawn candidate’s size class');
    fees.add(Number(q.quote.shipping.total_iqd));
  }
  assert.equal(fees.size, 1, 'the shipping fee moved with the draw — the fee itself is the oracle');

  const placed = await json(await post(app, '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 300));
  const order = await json(await get(app, `/api/orders/${String(placed.order.id)}`));
  assert.equal(order.success, true, JSON.stringify(order).slice(0, 300));
  assertNoLeak(
    'GET /api/orders/:id (delivery_method_snapshot)',
    order,
    raw,
    POOL_PRODUCTS.map((p) => p.id)
  );
});

// ------------------------------------------------------------- the admin side

test('case 15: admins see the pick THROUGHOUT, with the "not yet revealed" chip', async () => {
  const { db, orderId, drawn } = await buyMystery({ revealStage: 'delivered' });
  const adminApp = appFor(db, boss);
  const payload = await json(await get(adminApp, `/api/admin/orders/${orderId}`));
  assert.equal(payload.success, true, JSON.stringify(payload).slice(0, 300));
  const line = payload.order.items.find((i: Record<string, unknown>) => !!i.mystery);
  assert.ok(line, 'the admin order payload carries no mystery block');
  // POSITIVELY: the pick is there, from the first second.
  assert.equal(line.mystery.picks.length, 2);
  assert.deepEqual(
    line.mystery.picks.map((p: { product_id: string }) => p.product_id).sort(),
    [...drawn].sort()
  );
  assert.equal(line.mystery.revealed, false);
  assert.equal(line.mystery.pending_customer_reveal, true, 'the packing screen would claim the customer has been told');
  const body = JSON.stringify(payload);
  for (const id of drawn) assert.ok(body.includes(id), `the admin payload does not name ${id}`);
});

// ------------------------------------------------------------ monotonicity

test('reveal is monotone on the ORDER axis: forward reveals, backward does not un-reveal', async () => {
  const { raw, db, orderId, drawn } = await buyMystery({ revealStage: 'confirmed' });
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  const app = appFor(db);

  const before = await json(await get(app, `/api/orders/${orderId}`));
  assertNoLeak('before confirmation', before, raw, drawn);

  const moved = await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  assert.equal(moved.moved, true);
  assert.ok(
    count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations WHERE order_id = ? AND revealed_at IS NOT NULL', orderId) === 2,
    'the stage move did not stamp revealed_at'
  );

  const after = await json(await get(app, `/api/orders/${orderId}`));
  const line = after.order.items.find((i: Record<string, unknown>) => !!i.mystery);
  assert.equal(line.mystery.revealed, true);
  assert.equal(line.mystery.picks.length, 2);
  const body = JSON.stringify(after);
  for (const id of drawn) assert.ok(body.includes(id), 'the customer was not told after the milestone');

  // One step BACKWARDS (allowed by canMoveStage) — un-telling a customer what
  // they bought would be the worse lie.
  await moveOrderStage(env, { orderId, to: 'received', source: 'manual', force: true, changedBy: 'boss' });
  const back = await json(await get(app, `/api/orders/${orderId}`));
  const backLine = back.order.items.find((i: Record<string, unknown>) => !!i.mystery);
  assert.equal(backLine.mystery.revealed, true, 'a backwards stage move un-revealed the pick');
});

test('reveal is monotone on the CONFIG axis: editing reveal_stage moves no existing order', async () => {
  const { raw, db, orderId, drawn } = await buyMystery({ revealStage: 'delivered' });
  const app = appFor(db);

  // 'delivered' → 'paid' would reveal every in-flight order at once. It must
  // not: the milestone this order was SOLD UNDER is frozen on its allocation.
  raw.prepare("UPDATE bundle_config SET reveal_stage = 'paid' WHERE product_id = 'p_mystery'").run();
  const stillHidden = await json(await get(app, `/api/orders/${orderId}`));
  assertNoLeak('after reveal_stage was edited to paid', stillHidden, raw, drawn);
  assert.equal(
    row<{ v: string }>(raw, "SELECT reveal_stage_snapshot AS v FROM mystery_allocations WHERE order_id = ?", orderId)!.v,
    'delivered'
  );

  // And the other direction: an order already revealed under 'confirmed' is
  // not re-hidden by moving the config to 'delivered'.
  const second = await buyMystery({ revealStage: 'confirmed' });
  const env = { DB: second.db } as unknown as Parameters<typeof moveOrderStage>[0];
  await moveOrderStage(env, { orderId: second.orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  second.raw.prepare("UPDATE bundle_config SET reveal_stage = 'delivered' WHERE product_id = 'p_mystery'").run();
  const shown = await json(await get(appFor(second.db), `/api/orders/${second.orderId}`));
  const line = shown.order.items.find((i: Record<string, unknown>) => !!i.mystery);
  assert.equal(line.mystery.revealed, true, 'a config edit re-hid a pick the customer had already seen');
});

// ------------------------------------------------------------- the re-roll

test('a revealed mystery order cannot be self-cancelled, and cancelling frees no redemption slot', async () => {
  const { raw, db, orderId } = await buyMystery({ revealStage: 'confirmed' });
  const env = { DB: db } as unknown as Parameters<typeof moveOrderStage>[0];
  const app = appFor(db);

  // Not yet revealed: the ordinary cancel path still works, and it does NOT
  // delete the redemption row (§17 decision 4).
  const before = count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE subject_id = ?', 'p_mystery');
  assert.equal(before, 1, 'no redemption row was written for the mystery subject');

  await moveOrderStage(env, { orderId, to: 'confirmed', source: 'manual', changedBy: 'boss' });
  // Confirmation moves the order out of `pending`, so the ordinary guard
  // already refuses; put it back to prove the MYSTERY guard is the one that
  // fires rather than the status one.
  raw.prepare("UPDATE orders SET status = 'pending' WHERE id = ?").run(orderId);
  const refused = await json(await post(app, `/api/orders/${orderId}/cancel`, {}));
  assert.equal(refused.success, false);
  assert.equal(refused.code, 'MYSTERY_REVEALED_NO_CANCEL');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM orders WHERE id = ? AND status = 'cancelled'", orderId), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE subject_id = ?', 'p_mystery'), 1);
});

test("the 'paid' milestone is crossed by the settlement, not by a stage", async () => {
  const { raw, db, orderId, drawn } = await buyMystery({ revealStage: 'paid' });
  const app = appFor(db);
  // A cash-on-delivery order is not paid at purchase, so nothing is revealed.
  assertNoLeak('an unpaid COD order', await json(await get(app, `/api/orders/${orderId}`)), raw, drawn);

  const total = row<{ v: number }>(raw, 'SELECT total_iqd AS v FROM orders WHERE id = ?', orderId)!.v;
  // Recording the collection is the ONLY thing that makes a cash order paid,
  // and it is the only thing that can cross this milestone for one.
  const settled = await json(
    await post(appFor(db, boss), `/api/orders/${orderId}/settlement`, {
      amountIqd: total,
      eventKey: 'cod:receipt-1',
      kind: 'cod_collection',
    })
  );
  assert.equal(settled.success, true, JSON.stringify(settled).slice(0, 300));
  assert.equal(settled.settlement.fully_settled, true);
  assert.equal(
    count(raw, 'SELECT COUNT(*) AS n FROM mystery_allocations WHERE order_id = ? AND revealed_at IS NOT NULL', orderId),
    2,
    'the settlement did not stamp the paid milestone'
  );

  const after = await json(await get(app, `/api/orders/${orderId}`));
  const line = after.order.items.find((i: Record<string, unknown>) => !!i.mystery);
  assert.equal(line.mystery.revealed, true, "a fully settled order did not cross the 'paid' milestone");
});
