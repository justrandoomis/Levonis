/**
 * A FAULTY PART OF A BUNDLE CAN BE CLAIMED ON ITS OWN (owner decision 3).
 *
 * The owner kept commercial partial returns refused — a bundle is returned
 * whole — and added one sentence that changes the shape of the guard:
 * *"do not let this rule block warranty/fault handling of a single component;
 * repair or replacement of a defective part must remain possible … without
 * treating it as a partial bundle return."*
 *
 * Those are two different things and the code now says so. A change of mind
 * about one part of a discounted bundle is refused, because keeping the cheap
 * half at the bundle price is a discount nobody offered. A fault is not a
 * purchase decision: the remedies this pipeline offers for one — `repair` and
 * `replacement` — move no money at all.
 *
 * WHAT WOULD HAVE MADE THE CARVE-OUT A LIE. Three things, each tested here:
 * the customer payload nests components under the priced line and never as
 * top-level items, so without a per-component affordance in the UI no
 * component id could ever be posted; the mystery-reveal guard only ran when
 * the PARENT was posted, so a directly-posted mystery spool would have walked
 * past it; and the quota check is per child, so one component's case made the
 * whole-bundle door answer with a message aimed at the wrong row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { asD1, stubApp, post, json, all, count, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { returnRoutes } from '../worker/routes/returns';
import { deductOrderStock } from '../worker/lib/orderInventory';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';
import { seedMysteryPool, addMysteryOffer } from './lib/mysteryOffer';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const appFor = (db: unknown, user: StubUser = buyer) =>
  stubApp(db, user, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/returns', returnRoutes);
  });

const itemsOf = (raw: DatabaseSync, orderId: string) =>
  all<Record<string, unknown>>(raw, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', orderId);

/** One delivered bundle: bought, confirmed (stock deducted), delivered. */
async function deliveredBundle(raw: DatabaseSync, productId = 'prd_b1') {
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  const orderId = res.order.id as string;
  await deductOrderStock(db, orderId, 'boss');
  raw
    .prepare("UPDATE orders SET status = 'delivered', delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(orderId);
  return { db, orderId };
}

function standardBundle(raw: DatabaseSync) {
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 400_000,
    components: [
      { id: 'bc_printer', product: 'p_printer', qty: 1 },
      { id: 'bc_pla', product: 'p_pla', qty: 2 },
    ],
  });
}

// ------------------------------------------------------------- the carve-out

test('a DEFECT on one component opens a case; a change of mind on the same component does not', async () => {
  const raw = seedCatalogue();
  standardBundle(raw);
  const { db, orderId } = await deliveredBundle(raw);
  const spool = itemsOf(raw, orderId).find((r) => r.product_id === 'p_pla')!;

  for (const reason of ['not_as_described', 'wrong_product']) {
    const refused = await json(
      await post(appFor(db), '/api/returns', { orderItemId: spool.id, qty: 1, reason })
    );
    assert.equal(refused.code, 'BUNDLE_PARTIAL_RETURN_NOT_ALLOWED', `${reason} is commercial and stays refused`);
  }

  for (const reason of ['defective', 'manufacturing_fault', 'shipping_damage']) {
    raw.exec('DELETE FROM return_cases');
    const opened = await json(
      await post(appFor(db), '/api/returns', { orderItemId: spool.id, qty: 1, reason })
    );
    assert.equal(opened.success, true, `${reason} must reach the case pipeline: ${JSON.stringify(opened)}`);
    // The SINGLE-item shape (`case`), not the whole-bundle fan-out (`cases`):
    // a faulty part opens one case for that part and drags nothing else in.
    assert.ok(opened.case, `one case, for the faulty part only: ${JSON.stringify(opened)}`);
    assert.equal(String(opened.case.order_item_id), String(spool.id));
    assert.equal(opened.cases, undefined, 'a component claim is not a bundle fan-out');
  }
});

test('the faulty part keeps its own identity: its case is priced on what that part cost', async () => {
  const raw = seedCatalogue();
  standardBundle(raw);
  const { db, orderId } = await deliveredBundle(raw);
  const rows = itemsOf(raw, orderId);
  const printer = rows.find((r) => r.product_id === 'p_printer')!;

  const opened = await json(
    await post(appFor(db), '/api/returns', { orderItemId: printer.id, qty: 1, reason: 'defective' })
  );
  assert.equal(opened.success, true, JSON.stringify(opened));
  assert.equal(String(opened.case.order_item_id), String(printer.id));
  // The whole bundle is NOT dragged in: exactly one case exists.
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM return_cases WHERE order_id = ?', orderId), 1);
  // And the case names the component, whose alloc is its share of what was paid.
  assert.ok(Number(printer.component_alloc_iqd) > 0, 'the component carries its own share of the price');
});

test('one part under claim does not make the whole-bundle door lie about the quantity', async () => {
  const raw = seedCatalogue();
  standardBundle(raw);
  const { db, orderId } = await deliveredBundle(raw);
  const rows = itemsOf(raw, orderId);
  const spool = rows.find((r) => r.product_id === 'p_pla')!;
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;

  await json(await post(appFor(db), '/api/returns', { orderItemId: spool.id, qty: 2, reason: 'defective' }));
  const whole = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(whole.success, false);
  assert.equal(
    whole.code,
    'BUNDLE_COMPONENT_ALREADY_CLAIMED',
    `the refusal must name the part, not the bundle's quantity: ${JSON.stringify(whole)}`
  );
  assert.match(String(whole.error), /PLA/i, 'and say which part');
});

test('a bundle returned in full still answers QTY_EXCEEDED, not the component message', async () => {
  const raw = seedCatalogue();
  standardBundle(raw);
  const { db, orderId } = await deliveredBundle(raw);
  const parent = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id === null)!;

  const first = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(first.success, true, JSON.stringify(first));
  const again = await json(await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'defective' }));
  assert.equal(again.code, 'QTY_EXCEEDED', 'every part is spent — the bundle really has been returned');
});

// --------------------------------------------------------- the reveal fence

test('a mystery spool cannot be claimed as faulty before its reveal — the carve-out is not a leak', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw);
  const mysteryId = addMysteryOffer(raw, { revealStage: 'delivered', spoolQty: 1 });
  const db = asD1(raw);
  const added = await json(await post(appFor(db), '/api/cart/items', { productId: mysteryId, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const res = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(res.success, true, JSON.stringify(res));
  const orderId = res.order.id as string;

  // Confirmed and shipped, but NOT delivered: the reveal milestone is not met.
  await deductOrderStock(db, orderId, 'boss');
  raw.prepare("UPDATE orders SET status = 'shipped', stage = 'shipped' WHERE id = ?").run(orderId);
  raw
    .prepare("UPDATE orders SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(orderId);

  const spool = itemsOf(raw, orderId).find((r) => r.bundle_parent_item_id !== null)!;
  const claim = await json(
    await post(appFor(db), '/api/returns', { orderItemId: spool.id, qty: 1, reason: 'defective' })
  );
  assert.equal(claim.code, 'MYSTERY_NOT_REVEALED', `a component claim must hit the reveal fence too: ${JSON.stringify(claim)}`);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM return_cases WHERE order_id = ?', orderId), 0);
});

// -------------------------------------------------------- the app can reach it

test('the app offers the per-part claim, or the carve-out is unreachable from a phone', () => {
  const ui = readFileSync(new URL('../src/components/returns/ReturnsSection.tsx', import.meta.url), 'utf8');
  // Components are nested under the priced line (`bundle.components[]`) and are
  // never top-level items, so a screen that only iterates `order.items` can
  // never post a component id — the backend carve-out would be dead code.
  assert.match(ui, /bundle\?\.components/, 'the returns screen does not read the bundle components');
  assert.match(ui, /startForm\(k\.order_item_id, true\)/, 'no per-component claim button');
  assert.match(ui, /COMPONENT_REASONS/, 'the component form must offer only the reasons the server accepts');

  const strings = readFileSync(new URL('../src/lib/refusalStrings.ts', import.meta.url), 'utf8');
  assert.match(strings, /BUNDLE_COMPONENT_ALREADY_CLAIMED/, 'the new refusal has no customer sentence');
});

/**
 * A REPAIRED PART DOES NOT SPEND THE BUNDLE'S RETURN RIGHT.
 *
 * The carve-out let a case be opened directly against a child, and the quota
 * query counted every case that was not `rejected` — including one resolved as
 * `repair` or `replacement`, which moves no money and returns no goods. So a
 * customer who reported a crushed spool on day 2 and had it replaced on day 3
 * could never return the 400,000 IQD bundle on day 4: that child's quota read
 * as spent, and the commercial reason gate refuses the child on its own. The
 * fault report cost them their refund right.
 */
test('a component case resolved as repair or replacement leaves the whole-bundle return open', async () => {
  for (const resolution of ['repair', 'replacement', 'declined'] as const) {
    const raw = seedCatalogue();
    standardBundle(raw);
    const { db, orderId } = await deliveredBundle(raw);
    const rows = itemsOf(raw, orderId);
    const spool = rows.find((r) => r.product_id === 'p_pla')!;
    const parent = rows.find((r) => r.bundle_parent_item_id === null)!;

    const claim = await json(
      await post(appFor(db), '/api/returns', { orderItemId: spool.id, qty: 2, reason: 'defective' })
    );
    assert.equal(claim.success, true, JSON.stringify(claim));
    // Staff resolve it without money or goods moving.
    raw
      .prepare("UPDATE return_cases SET state = 'resolved', resolution = ? WHERE id = ?")
      .run(resolution, String(claim.case.id));

    const whole = await json(
      await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'not_as_described' })
    );
    assert.equal(
      whole.success,
      true,
      `a ${resolution} must not consume the bundle's return right: ${JSON.stringify(whole)}`
    );
  }
});

test('a component case that was REFUNDED does consume it, and the refusal says so honestly', async () => {
  const raw = seedCatalogue();
  standardBundle(raw);
  const { db, orderId } = await deliveredBundle(raw);
  const rows = itemsOf(raw, orderId);
  const spool = rows.find((r) => r.product_id === 'p_pla')!;
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;

  const claim = await json(
    await post(appFor(db), '/api/returns', { orderItemId: spool.id, qty: 2, reason: 'defective' })
  );
  raw.prepare("UPDATE return_cases SET state = 'resolved', resolution = 'refund' WHERE id = ?").run(String(claim.case.id));

  const whole = await json(
    await post(appFor(db), '/api/returns', { orderItemId: parent.id, qty: 1, reason: 'not_as_described' })
  );
  assert.equal(whole.code, 'BUNDLE_COMPONENT_ALREADY_CLAIMED', JSON.stringify(whole));
  // The old sentence promised the rest "can still be returned individually",
  // which the commercial reason gate refuses. It must not promise that.
  assert.ok(
    !/still be returned individually/.test(String(whole.error)),
    `the refusal promises something the reason gate refuses: ${whole.error}`
  );
  assert.match(String(whole.error), /fault/i, 'it says what CAN still be done');
});
