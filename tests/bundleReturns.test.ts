/**
 * RETURNS, CANCELLATION AND REFUNDS KNOW THE PHYSICAL COMPONENTS — case 12 of
 * the owner's seventeen, docs/BUNDLES_MYSTERY.md §6.4, through the REAL routers.
 *
 * THE ARITHMETIC IS THE WHOLE POINT, and it has two wrong answers on either
 * side of the right one:
 *
 *  - pricing a component case off `unit_price_iqd` refunds **0 IQD**, because
 *    §6.2 pins a component's unit price to 0 and puts the money on the parent —
 *    and the points reversal beside it, which reads
 *    `pricing_snapshot.applied_iqd`, reverses nothing at all;
 *  - substituting `component_alloc_iqd` naively **over-refunds**, because the
 *    formula still has to subtract this line's proportional share of coupon and
 *    points, and `Σ component_alloc_iqd` is the parent's GROSS line total.
 *
 * So the allocation becomes the case's gross, scaled by the returned fraction
 * of the row, and everything after it is unchanged. The assertion is the one
 * that matters to a customer: `Σ refundIqd` over a fully returned bundle is the
 * parent's `line_total_iqd` MINUS its share of coupon and points — not 0, and
 * not the gross.
 *
 * The rest of the file holds the three things that make that arithmetic
 * reachable at all: whole-bundle-only returns, the stock going back through the
 * LEDGER onto the rows it came off, and price protection refusing the parent by
 * name while evaluating a component on its own frozen standalone value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, all, count, row, spendable, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { returnRoutes, priceProtectionRoutes } from '../worker/routes/returns';
import { deductOrderStock } from '../worker/lib/orderInventory';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const admin: StubUser = { id: 'boss', role: 'admin', email: 'a@x.co' };
const appFor = (db: unknown, user: StubUser = buyer) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/returns', returnRoutes);
    a.route('/api/price-protection', priceProtectionRoutes);
  });

const itemsOf = (raw: DatabaseSync, orderId: string) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', orderId);

/**
 * One delivered bundle order: bought, confirmed (so the stock is DEDUCTED, the
 * state a return actually starts from), delivered.
 */
async function deliveredBundle(raw: DatabaseSync, opts: { couponCode?: string; qty?: number } = {}) {
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 400_000,
    components: [
      { id: 'bc_printer', product: 'p_printer', qty: 1 },
      { id: 'bc_pla', product: 'p_pla', qty: 2 },
      { id: 'bc_abs', product: 'p_color', qty: 1, colorId: 'pc_black' },
    ],
  });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: opts.qty ?? 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(
    await post(appFor(db), '/api/orders', orderBody(opts.couponCode ? { couponCode: opts.couponCode } : {}))
  );
  assert.equal(res.success, true, JSON.stringify(res));
  const orderId = res.order.id as string;

  await deductOrderStock(db, orderId, null);
  raw
    .prepare("UPDATE orders SET status='delivered', stage='delivered', delivered_at=? WHERE id=?")
    .run(new Date().toISOString(), orderId);
  return { db, orderId };
}

// --------------------------------------------------------- the arithmetic

test('case 12 — a whole-bundle return refunds the parent’s line total NET of coupon and points, never 0 and never the gross', async () => {
  const raw = seedCatalogue();
  raw.exec(
    `INSERT INTO coupons (id,code,kind,value,min_total_iqd,active) VALUES ('cp1','SAVE10','percent',10,0,1)`
  );
  const { db, orderId } = await deliveredBundle(raw, { couponCode: 'SAVE10' });
  const order = row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', orderId)!;
  const rows = itemsOf(raw, orderId);
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const kids = rows.filter((r) => r.bundle_parent_item_id !== null);

  // Opening a case on the PARENT opens one case per component, in one batch.
  const opened = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(opened.success, true, JSON.stringify(opened));
  assert.equal(opened.cases.length, 3, 'one case per component — the parent holds nothing physical');

  const before = spendable(raw, 'buyer');
  let refunded = 0;
  for (const kase of opened.cases as Array<{ id: string }>) {
    const adminApp = appFor(db, admin);
    for (const to of ['assessment', 'approved', 'received', 'inspected']) {
      const step = await json(await post(adminApp, `/api/returns/admin/${kase.id}/transition`, { to }));
      assert.equal(step.success, true, `${to}: ${JSON.stringify(step)}`);
    }
    const resolved = await json(
      await post(adminApp, `/api/returns/admin/${kase.id}/transition`, { to: 'resolved', resolution: 'refund' })
    );
    assert.equal(resolved.success, true, JSON.stringify(resolved));
    refunded += Number(resolved.refund.amount_iqd);
  }

  const coupon = JSON.parse(String(order.coupon_snapshot)) as { discount_iqd: number };
  const discounts = coupon.discount_iqd + Number(order.points_discount_iqd);
  const base = Number(order.subtotal_iqd) + Number(order.shipping_iqd);
  const gross = Number(parent.line_total_iqd);
  const exactNet = gross - Math.floor((discounts * gross) / base);

  assert.ok(refunded > 0, 'pricing a component case off unit_price_iqd would refund exactly 0');
  assert.ok(refunded < gross, 'refunding the allocation raw would over-refund by the discount share');
  assert.ok(
    Math.abs(refunded - exactNet) <= kids.length,
    `Σ refund (${refunded}) is the parent's line total net of its discount share (${exactNet}), within per-case rounding`
  );
  // And the money really moved.
  assert.ok(spendable(raw, 'buyer') > before);
});

test('case 12 — the points reversal uses the same basis, so a returned bundle reverses what it accrued', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;
  const opened = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));

  let reversedBasis = 0;
  for (const kase of opened.cases as Array<{ id: string }>) {
    const adminApp = appFor(db, admin);
    for (const to of ['assessment', 'approved', 'received', 'inspected']) {
      await post(adminApp, `/api/returns/admin/${kase.id}/transition`, { to });
    }
    const resolved = await json(
      await post(adminApp, `/api/returns/admin/${kase.id}/transition`, { to: 'resolved', resolution: 'refund' })
    );
    reversedBasis += Number(resolved.refund.amount_iqd);
    assert.ok(resolved.points_reversal, 'a component case must carry a points reversal, not silence');
  }
  assert.ok(reversedBasis > 0);
});

test('case 12 — a partial-qty return of a multi-qty bundle scales by kase.qty / order_items.qty', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw, { qty: 2 });
  const rows = itemsOf(raw, orderId);
  const printer = rows.find((r) => r.product_id === 'p_printer')!;
  assert.equal(Number(printer.qty), 2);

  // One of the two printers comes back: half the component's allocation.
  const opened = await json(
    await post(appFor(db), '/api/returns', { orderItemId: printer.id, qty: 1, reason: 'defective' })
  );
  assert.equal(opened.code, 'BUNDLE_PARTIAL_RETURN_NOT_ALLOWED', 'v1 policy: the whole bundle or nothing');

  // Through the whole-bundle door instead, at qty 1 of 2.
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const whole = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(whole.success, true, JSON.stringify(whole));
  const printerCase = (whole.cases as Array<Record<string, unknown>>).find((k) => {
    const item = rows.find((r) => r.id === k.order_item_id);
    return item?.product_id === 'p_printer';
  })!;
  assert.equal(Number(printerCase.qty), 1, 'half the row comes back, not the whole row');

  const adminApp = appFor(db, admin);
  for (const to of ['assessment', 'approved', 'received', 'inspected']) {
    await post(adminApp, `/api/returns/admin/${printerCase.id}/transition`, { to });
  }
  const resolved = await json(
    await post(adminApp, `/api/returns/admin/${printerCase.id}/transition`, { to: 'resolved', resolution: 'refund' })
  );
  const alloc = Number(rows.find((r) => r.id === printerCase.order_item_id)!.component_alloc_iqd);
  assert.equal(Number(resolved.refund.amount_iqd), Math.floor(alloc / 2), 'exactly half the stored allocation');
});

// ------------------------------------------------------------ stock, case 12

test('case 12 — the restore goes through the LEDGER onto the colour row, never products.stock', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const before = row<{ stock: number }>(raw, "SELECT stock FROM product_colors WHERE id='pc_black'")!;
  assert.equal(before.stock, 3, 'confirmation deducted the colour row, not the product row');

  const abs = itemsOf(raw, orderId).find((r) => r.product_id === 'p_color')!;
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;
  const opened = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  const absCase = (opened.cases as Array<Record<string, unknown>>).find((k) => k.order_item_id === abs.id)!;

  const adminApp = appFor(db, admin);
  for (const to of ['assessment', 'approved', 'received', 'inspected']) {
    await post(adminApp, `/api/returns/admin/${absCase.id}/transition`, { to });
  }
  await post(adminApp, `/api/returns/admin/${absCase.id}/transition`, { to: 'resolved', resolution: 'refund' });

  assert.equal(row<{ stock: number }>(raw, "SELECT stock FROM product_colors WHERE id='pc_black'")!.stock, 4);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id = ? AND kind='restore' AND scope='color'", orderId),
    1
  );
  // The restore carries its own fence row, so a guard that matched nothing
  // would roll the credit back with it instead of recording a movement that
  // never happened.
  assert.deepEqual(
    row(raw, 'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = ?', orderId, 'restore'),
    { expected: 1, actual: 1 }
  );
});

test('cancellation releases every component in the same batch as the status flip', async () => {
  const raw = seedCatalogue();
  addBundle(raw, { id: 'prd_b1', slug: 'starter', priceIqd: 400_000 });
  const db = asD1(raw);
  await post(appFor(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 });
  const res = await json(await post(appFor(db), '/api/orders', orderBody({ paymentMethodId: 'wallet', useWallet: true })));
  const orderId = res.order.id as string;
  assert.deepEqual(row(raw, 'SELECT stock_reserved FROM products WHERE id = ?', 'p_printer'), { stock_reserved: 1 });

  const cancelled = await json(await post(appFor(db), `/api/orders/${orderId}/cancel`));
  assert.equal(cancelled.success, true, JSON.stringify(cancelled));
  assert.deepEqual(row(raw, 'SELECT stock_reserved FROM products WHERE id = ?', 'p_printer'), { stock_reserved: 0 });
  assert.deepEqual(row(raw, 'SELECT stock_reserved FROM products WHERE id = ?', 'p_pla'), { stock_reserved: 0 });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM inventory_ledger WHERE order_id=? AND kind='release'", orderId), 3);
  assert.deepEqual(
    row(raw, 'SELECT expected, actual FROM order_reservation_fence WHERE order_id = ? AND kind = ?', orderId, 'release'),
    { expected: 3, actual: 3 }
  );
  // The redemption row SURVIVES the cancellation as a row — but on a NORMAL
  // bundle the owner ruled (decision 4) that its slot comes back, so the row
  // is released rather than deleted. A MYSTERY order never releases: that rule
  // is what stops a cancel-and-re-roll loop (§7.3), and it is pinned in
  // tests/offerRedemptionState.test.ts along with the re-open that takes the
  // slot away again.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ?', orderId), 1);
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM offer_redemptions WHERE order_id = ? AND state = 'released'", orderId),
    1,
    'a cancelled bundle order gives its offer slot back'
  );
});

// ------------------------------------------------------------ the grouping

test('a component case names the bundle it came from and its siblings', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;
  const opened = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  const first = (opened.cases as Array<{ id: string }>)[0];

  const detail = await json(await get(appFor(db, admin), `/api/returns/${first.id}`));
  assert.equal(detail.case.bundle.parent_item_id, parent.id);
  assert.equal(detail.case.bundle.of, 3, '"1 of 3 items in Bundle X" is what staff read when they open the box');
  assert.equal(detail.case.bundle.position, 1);
  assert.equal(detail.case.bundle.components.length, 3);
});

// ----------------------------------------------------- price protection

/**
 * THE RETURNABLE QUOTA IS CONSUMED BY A WHOLE-BUNDLE RETURN.
 *
 * A whole-bundle return opens its cases against the CHILD rows, never against
 * the parent, so a quota read keyed on the parent counted zero for ever: the
 * same delivered bundle could be re-POSTed for the whole 7-day window, each
 * round opening a fresh full set of component cases, each priced off
 * `component_alloc_iqd`, each credited under a `wtx_ret_<caseId>` the wallet
 * idempotency guard had never seen, and each restoring stock under a fresh
 * `operationId = caseId` the ledger's UNIQUE key had never seen either. Three
 * rounds on one 400,000 IQD bundle refunded 1,200,000 IQD and turned one
 * ordered printer into +3 stock. The reservation fence cannot help — every
 * round is a legitimately planned restore whose expected equals its actual —
 * so the bound has to be the quota itself.
 */
test('a whole-bundle return consumes the quota: the same bundle cannot be returned twice', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;

  const first = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.cases.length, 3);

  const second = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(second.code, 'QTY_EXCEEDED', JSON.stringify(second));
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM return_cases WHERE order_id = ?', orderId), 3,
    'the refused round opened no case at all — the fan-out stays all-or-nothing');
});

test('a rejected case frees the quota again, and a two-qty bundle can be returned one at a time', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw, { qty: 2 });
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;
  assert.equal(Number(parent.qty), 2);

  const one = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(one.success, true, JSON.stringify(one));
  const two = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(two.success, true, `the second of two ordered bundles is still returnable: ${JSON.stringify(two)}`);
  const three = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(three.code, 'QTY_EXCEEDED', 'but not a third');

  // A rejected case is not a consumed one — the quota query excludes it.
  raw.exec("UPDATE return_cases SET state = 'rejected'");
  const again = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(again.success, true, JSON.stringify(again));
});

test('a price-protection claim on the bundle PARENT is refused by name, not with a misleading NO_ELIGIBLE_DROP', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;
  const res = await json(await post(appFor(db), '/api/price-protection/claims', { orderItemId: parent.id }));
  assert.equal(res.code, 'COMPOSITION_NOT_ELIGIBLE');
  assert.match(String(res.error), /individually/);
});

/**
 * A COMPONENT CLAIM IS EVALUATED ON WHAT THE CUSTOMER PAID FOR THAT COMPONENT.
 *
 * Two wrong answers sit on either side of the right one, exactly as with the
 * refund arithmetic above:
 *
 *  - reading `pricing_snapshot.applied_iqd` gives 0 (§6.2 pins it), so every
 *    claim ends in a misleading `NO_ELIGIBLE_DROP` — "we looked and found
 *    nothing" for a comparison that was never possible;
 *  - reading `component_value_iqd` — the UNDISCOUNTED standalone catalogue
 *    value — credits a number the customer never paid. The bundle below is
 *    worth 480,000 and sold for 400,000, so the printer's frozen value is
 *    400,000 while its share of the price is 333,333. A catalogue drop to
 *    20,000 would then have credited 380,000 IQD on a component that cost
 *    333,333 — and 380,000 is also 95% of the price of the WHOLE order, with
 *    the goods kept.
 *
 * The anchor is `component_alloc_iqd / qty`: the same stored figure §6.4 makes
 * the refund basis, so a refund and a price-protection credit cannot disagree
 * about what one component cost.
 */
test('a component price-protection claim is anchored on the PAID share, and can never exceed it', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const printer = itemsOf(raw, orderId).find((r) => r.product_id === 'p_printer')!;
  assert.equal(Number(printer.unit_price_iqd), 0, 'the component is zero-priced…');
  assert.equal(Number(printer.component_value_iqd), 400_000, '…its standalone value is frozen beside it…');
  const paid = Number(printer.component_alloc_iqd);
  assert.equal(paid, 333_333, '…and its share of the 400,000 bundle price is what was actually charged');

  // A drop to 350,000 is BELOW the catalogue value but still ABOVE what this
  // buyer paid inside the bundle, so there is no eligible drop. Anchoring on
  // `component_value_iqd` would have credited 50,000 for a price the customer
  // never reached.
  raw.exec("UPDATE products SET price_iqd = 350000 WHERE id = 'p_printer'");
  const none = await json(await post(appFor(db), '/api/price-protection/claims', { orderItemId: printer.id }));
  assert.equal(none.code, 'NO_ELIGIBLE_DROP', JSON.stringify(none));

  // A drop BELOW the paid share is a real drop, and it is measured from it.
  raw.exec("UPDATE products SET price_iqd = 300000 WHERE id = 'p_printer'");
  const res = await json(await post(appFor(db), '/api/price-protection/claims', { orderItemId: printer.id }));
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.claim.original_unit_iqd, paid, 'the anchor is the paid share, never the undiscounted value');
  assert.equal(res.claim.observed_unit_iqd, 300_000);
});

test('a catastrophic catalogue drop cannot credit more than the component cost inside the bundle', async () => {
  const raw = seedCatalogue();
  const { db, orderId } = await deliveredBundle(raw);
  const order = row<Record<string, unknown>>(raw, 'SELECT * FROM orders WHERE id = ?', orderId)!;
  const printer = itemsOf(raw, orderId).find((r) => r.product_id === 'p_printer')!;
  const paid = Number(printer.component_alloc_iqd);

  raw.exec("UPDATE products SET price_iqd = 20000 WHERE id = 'p_printer'");
  const claim = await json(await post(appFor(db), '/api/price-protection/claims', { orderItemId: printer.id }));
  assert.equal(claim.success, true, JSON.stringify(claim));

  const before = spendable(raw, 'buyer');
  const approved = await json(
    await post(appFor(db, admin), `/api/price-protection/admin/claims/${claim.claim.id}/decide`, { decision: 'approved' })
  );
  assert.equal(approved.success, true, JSON.stringify(approved));
  const credited = spendable(raw, 'buyer') - before;
  const rate = Number(order.exchange_rate) || 1400;
  const creditedIqd = Math.round((credited / 100) * rate);

  assert.ok(creditedIqd <= paid, `credited ${creditedIqd} IQD must not exceed the ${paid} IQD paid for this component`);
  assert.ok(
    creditedIqd <= Number(order.total_iqd),
    'and a single component credit can never exceed the price of the whole order'
  );
});
