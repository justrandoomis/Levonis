/**
 * FIFO — «كل عملية بيع تستهلك أقدم دفعة تكلفة متاحة أولًا».
 *
 * The core invariant of the whole inventory feature:
 *
 *   CURRENT STOCK MAY HAVE MULTIPLE HISTORICAL COSTS, AND EVERY SALE CONSUMES
 *   THE OLDEST AVAILABLE COST LOT FIRST.
 *
 * The owner's acceptance example (§81) is at the bottom of this file, run end
 * to end against a real SQLite built from the real migrations. It is the test
 * that decides whether this feature is finished:
 *
 *   10 units at 450,000 + 10 units at 560,000, sell 12
 *     → 10 x 450,000 + 2 x 560,000 = 5,620,000
 *     NOT 12 x 560,000 (6,720,000) and NOT a weighted average (6,060,000)
 *
 * Every other test here exists because there is a plausible implementation that
 * gets that number right and something else wrong: a queue that crosses
 * colours, a remainder that loses dinars, a return that credits today's price
 * to a unit bought last year, an unknown cost quietly read as free.
 *
 * Run: npx tsx --test tests/inventoryFifo.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1 } from './fixtures/app';
import {
  cogsByLine,
  fifoQueues,
  hasLots,
  lotCostBreakdown,
  planLotConsumption,
  planLotRestore,
  splitExact,
} from '../worker/lib/inventoryLots';
import type { StockMove, StockScope } from '../worker/lib/inventory';

// ---------------------------------------------------------------- fixtures

let seq = 0;
const nid = (p: string) => `${p}_${String(++seq).padStart(4, '0')}`;

function seedProduct(raw: DatabaseSync, mode = 'BASE'): string {
  const pid = nid('prd');
  raw
    .prepare(
      `INSERT INTO products (id, name, slug, price_iqd, inventory_mode, stock) VALUES (?, ?, ?, 650000, ?, 0)`
    )
    .run(pid, `P ${pid}`, pid, mode);
  return pid;
}

/** A lot on the shelf. `received` is the FIFO sort key, so it is explicit. */
function seedLot(
  raw: DatabaseSync,
  o: {
    product: string;
    scope?: StockScope;
    scopeId?: string;
    qty: number;
    unitCost: number | null;
    received: string;
    id?: string;
  }
): string {
  const id = o.id ?? nid('ilot');
  raw
    .prepare(
      `INSERT INTO inventory_lots
         (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      o.product,
      o.scope ?? 'base',
      o.scopeId ?? '',
      o.qty,
      o.qty,
      o.unitCost,
      o.unitCost === null ? 'opening_unpriced' : 'received',
      o.received
    );
  return id;
}

function seedOrder(raw: DatabaseSync, itemIds: readonly string[]): string {
  const uid = nid('usr');
  raw.prepare(`INSERT INTO users (id, name, email, password_hash, role) VALUES (?, 'C', ?, 'h', 'customer')`).run(uid, `${uid}@x.co`);
  const oid = nid('ord');
  // Every NOT NULL column without a default, filled with the minimum that
  // makes a real row: this file is about lots, not about checkout, and a
  // fixture that drifts from the schema would fail for the wrong reason.
  raw
    .prepare(
      `INSERT INTO orders
         (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
          payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd)
       VALUES (?, ?, 'pending', '{}', 'std', '{}', 'cod', 0, 1, 0, 0)`
    )
    .run(oid, uid);
  for (const item of itemIds) {
    raw
      .prepare(
        `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
         VALUES (?, ?, NULL, 'item', 1, 0, 0)`
      )
      .run(item, oid);
  }
  return oid;
}

const move = (o: {
  product: string;
  line: string;
  qty: number;
  scope?: StockScope;
  scopeId?: string;
}): StockMove => ({
  product_id: o.product,
  qty: o.qty,
  line_id: o.line,
  targets: [
    {
      scope: o.scope ?? 'base',
      scope_id: o.scopeId ?? '',
      stock: 0,
      reserved: 0,
      low_stock_threshold: null,
      label: 'x',
    },
  ],
});

const lotQty = (raw: DatabaseSync, id: string): number =>
  (raw.prepare(`SELECT qty_remaining AS q FROM inventory_lots WHERE id = ?`).get(id) as { q: number }).q;

async function runPlan(raw: DatabaseSync, statements: D1PreparedStatement[]): Promise<void> {
  // The real caller appends these to its own db.batch. The fixture's batch is
  // one transaction, exactly as D1's is.
  if (statements.length) await asD1(raw).batch(statements);
}

// =========================================================================
// 1. THE MONEY SPLIT — §14
// =========================================================================

test('a split always sums to exactly the total, however awkward the division', () => {
  for (const total of [0, 1, 7, 100, 500_000, 1_000_001, 999_999_983]) {
    for (const parts of [1, 2, 3, 7, 10, 13, 97]) {
      const shares = splitExact(total, parts);
      assert.equal(shares.length, parts);
      assert.equal(
        shares.reduce((a, b) => a + b, 0),
        total,
        `${total} over ${parts} lost or gained dinars`
      );
      assert.ok(shares.every((s) => Number.isInteger(s) && s >= 0), 'a share was not a whole dinar');
      // Largest-remainder: no two shares differ by more than one dinar.
      assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, 'the split is lumpy');
    }
  }
});

test('the split is deterministic — the same purchase twice gives the same lots', () => {
  assert.deepEqual(splitExact(500_000, 7), splitExact(500_000, 7));
  assert.deepEqual(splitExact(10, 3), [4, 3, 3]);
});

test('a negative total is refused, not read as zero', () => {
  // A negative freight cost is a data-entry fault. Clamping it would hide the
  // fault and quietly under-cost the lot.
  assert.throws(() => splitExact(-1, 3));
  assert.throws(() => splitExact(100, 0));
});

// =========================================================================
// 2. THE LOT COST — §7, §9, §10, §11
// =========================================================================

test("the owner's worked example: 500,000 + 50,000 + 10,000 = 560,000", () => {
  const b = lotCostBreakdown({
    purchaseUnitIqd: 500_000,
    shippingTotalIqd: 500_000,
    internalDeliveryTotalIqd: 100_000,
    qtyOrdered: 10,
    qtyThisReceipt: 10,
    alreadyReceived: 0,
  });
  assert.equal(b.shippingShareIqd, 500_000);
  assert.equal(b.internalShareIqd, 100_000);
  assert.equal(b.unitCostIqd, 560_000);
  assert.equal(b.totalCostIqd, 5_600_000);
  assert.equal(b.complete, true);
});

test('a cost component that was never entered leaves the lot unpriceable', () => {
  // §13: not entered is not zero. A lot priced without its freight would report
  // a margin the shop never earned.
  const b = lotCostBreakdown({
    purchaseUnitIqd: 500_000,
    shippingTotalIqd: null,
    internalDeliveryTotalIqd: 100_000,
    qtyOrdered: 10,
    qtyThisReceipt: 10,
    alreadyReceived: 0,
  });
  assert.equal(b.complete, false);
  assert.equal(b.unitCostIqd, null);
  assert.equal(b.totalCostIqd, null);
  assert.equal(b.shippingShareIqd, null);
  assert.equal(b.internalShareIqd, 100_000, 'the component that WAS entered is still reported');
});

test('an explicit zero is a real cost, not a missing one', () => {
  const b = lotCostBreakdown({
    purchaseUnitIqd: 500_000,
    shippingTotalIqd: 0,
    internalDeliveryTotalIqd: 0,
    qtyOrdered: 10,
    qtyThisReceipt: 10,
    alreadyReceived: 0,
  });
  assert.equal(b.complete, true);
  assert.equal(b.unitCostIqd, 500_000);
});

test('two partial receipts account for the whole freight bill and not a dinar more', () => {
  /**
   * §33. 500,000 of freight over 7 ordered units does not divide evenly. If
   * both receipts took the same slice the purchase would over-account by the
   * remainder; if each rounded on its own it would under-account.
   */
  const first = lotCostBreakdown({
    purchaseUnitIqd: 100_000,
    shippingTotalIqd: 500_000,
    internalDeliveryTotalIqd: 70_001,
    qtyOrdered: 7,
    qtyThisReceipt: 4,
    alreadyReceived: 0,
  });
  const second = lotCostBreakdown({
    purchaseUnitIqd: 100_000,
    shippingTotalIqd: 500_000,
    internalDeliveryTotalIqd: 70_001,
    qtyOrdered: 7,
    qtyThisReceipt: 3,
    alreadyReceived: 4,
  });
  assert.equal(first.shippingShareIqd! + second.shippingShareIqd!, 500_000);
  assert.equal(first.internalShareIqd! + second.internalShareIqd!, 70_001);
  assert.equal(
    first.totalCostIqd! + second.totalCostIqd!,
    100_000 * 7 + 500_000 + 70_001,
    'the two lots together must equal what the purchase actually cost'
  );
});

// =========================================================================
// 3. THE QUEUE — §22
// =========================================================================

test('the queue is per stock identity: a colour cannot eat another colour\'s older lot', () => {
  const raw = freshDb();
  const pid = seedProduct(raw, 'COLOR');
  raw.prepare(`INSERT INTO product_colors (id, product_id, name_en, hex, stock) VALUES ('col_black', ?, 'B', '#000', 5)`).run(pid);
  raw.prepare(`INSERT INTO product_colors (id, product_id, name_en, hex, stock) VALUES ('col_white', ?, 'W', '#fff', 5)`).run(pid);
  const older = seedLot(raw, { product: pid, scope: 'color', scopeId: 'col_black', qty: 5, unitCost: 100_000, received: '2026-01-01T00:00:00.000Z' });
  const newer = seedLot(raw, { product: pid, scope: 'color', scopeId: 'col_white', qty: 5, unitCost: 900_000, received: '2026-06-01T00:00:00.000Z' });

  return fifoQueues(asD1(raw), [{ scope: 'color', scope_id: 'col_white' }]).then((q) => {
    const white = q.get('color:col_white') ?? [];
    assert.equal(white.length, 1);
    assert.equal(white[0].id, newer, 'the queue reached into another colour');
    assert.ok(!white.some((l) => l.id === older));
  });
});

test('capacity scopes have no lots — a pre-order is a promise, not a shelf', () => {
  // §65. Turning pre-order capacity into stock is explicitly forbidden.
  assert.equal(hasLots('base'), true);
  assert.equal(hasLots('option'), true);
  assert.equal(hasLots('color'), true);
  assert.equal(hasLots('variant'), true);
  assert.equal(hasLots('preorder' as StockScope), false);
  assert.equal(hasLots('preorder_transport' as StockScope), false);
});

// =========================================================================
// 4. CONSUMPTION — §2, §23
// =========================================================================

test('one sale inside one lot takes from the oldest and leaves the rest', async () => {
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const b = seedLot(raw, { product: pid, qty: 10, unitCost: 560_000, received: '2026-09-20T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);

  const plan = await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 6 })]);
  await runPlan(raw, plan.statements);

  assert.equal(lotQty(raw, a), 4, 'the OLD lot must be the one that shrank');
  assert.equal(lotQty(raw, b), 10, 'the new lot must be untouched');
  assert.deepEqual(plan.shortfall, []);
});

test('A SALE THAT CROSSES BATCHES KEEPS ITS EXACT SPLIT — §23', async () => {
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 3, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const b = seedLot(raw, { product: pid, qty: 10, unitCost: 560_000, received: '2026-09-20T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);

  const plan = await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 7 })]);
  await runPlan(raw, plan.statements);

  assert.equal(lotQty(raw, a), 0);
  assert.equal(lotQty(raw, b), 6);

  const rows = raw
    .prepare(`SELECT lot_id, qty, unit_cost_iqd, cogs_iqd FROM order_item_inventory_allocations ORDER BY id`)
    .all() as Array<{ lot_id: string; qty: number; unit_cost_iqd: number; cogs_iqd: number }>;
  assert.equal(rows.length, 2, 'a split sale must record TWO allocations, not an average');
  assert.deepEqual(
    rows.map((r) => [r.lot_id, r.qty, r.cogs_iqd]),
    [
      [a, 3, 1_350_000],
      [b, 4, 2_240_000],
    ]
  );
  const total = rows.reduce((n, r) => n + r.cogs_iqd, 0);
  assert.equal(total, 3 * 450_000 + 4 * 560_000);
  assert.notEqual(total, 7 * 560_000, 'it used the newest cost for everything');
  assert.notEqual(total, Math.round(((3 * 450_000 + 10 * 560_000) / 13) * 7), 'it used a weighted average');
});

test('two lines of one order do not both claim the same units', async () => {
  // The running simulation, not a fresh read per line: two cart lines of one
  // product resolve to the SAME identity, and judging each against the queue's
  // full quantity would allocate the same units twice.
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 5, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const b = seedLot(raw, { product: pid, qty: 5, unitCost: 560_000, received: '2026-09-20T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1', 'itm_2']);

  const plan = await planLotConsumption(asD1(raw), oid, [
    move({ product: pid, line: 'itm_1', qty: 4 }),
    move({ product: pid, line: 'itm_2', qty: 4 }),
  ]);
  await runPlan(raw, plan.statements);

  assert.equal(lotQty(raw, a), 0);
  assert.equal(lotQty(raw, b), 2, '8 units were taken in total, not 4 twice over');
});

test('an unknown lot cost produces an unknown COGS, never a free one', async () => {
  const raw = freshDb();
  const pid = seedProduct(raw);
  seedLot(raw, { product: pid, qty: 5, unitCost: null, received: '2026-01-01T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);

  const plan = await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 2 })]);
  await runPlan(raw, plan.statements);

  const row = raw.prepare(`SELECT unit_cost_iqd, cogs_iqd FROM order_item_inventory_allocations`).get() as {
    unit_cost_iqd: number | null;
    cogs_iqd: number | null;
  };
  assert.equal(row.unit_cost_iqd, null);
  assert.equal(row.cogs_iqd, null, 'an unknown cost became free');

  const cogs = await cogsByLine(asD1(raw), [oid]);
  assert.equal(cogs.get('itm_1')!.known, false, 'finance must be told the cost is not known');
});

test('a replayed deduction moves nothing a second time', async () => {
  // A retried confirmation, a duplicated webhook, a double-tapped button.
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);
  const moves = [move({ product: pid, line: 'itm_1', qty: 4 })];

  await runPlan(raw, (await planLotConsumption(asD1(raw), oid, moves)).statements);
  assert.equal(lotQty(raw, a), 6);
  await runPlan(raw, (await planLotConsumption(asD1(raw), oid, moves)).statements);
  assert.equal(lotQty(raw, a), 6, 'the replay consumed the lot again');
  const n = raw.prepare(`SELECT COUNT(*) AS n FROM order_item_inventory_allocations`).get() as { n: number };
  assert.equal(n.n, 1);
});

test('a queue shorter than the demand is REPORTED, not silently rounded away', async () => {
  // Cannot happen while counters and lots move in one batch, which is why it
  // is reported rather than thrown: a bookkeeping gap must not refuse a paid
  // order, and finance already knows how to say a cost is partly unknown.
  const raw = freshDb();
  const pid = seedProduct(raw);
  seedLot(raw, { product: pid, qty: 2, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);

  const plan = await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 5 })]);
  assert.deepEqual(plan.shortfall, [{ order_item_id: 'itm_1', scope: 'base', scope_id: '', qty: 3 }]);
  assert.equal(plan.allocations.length, 1);
});

// =========================================================================
// 5. RETURN AND CANCELLATION — §36, §37
// =========================================================================

test('A RETURN GOES BACK TO THE LOT IT CAME FROM, at the cost it came at', async () => {
  /**
   * §37. Crediting a returned 450,000 unit to today's 560,000 layer would
   * invent 110,000 dinars of inventory value out of a refund, and the next sale
   * would report a cost the shop never paid.
   */
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 3, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const b = seedLot(raw, { product: pid, qty: 10, unitCost: 560_000, received: '2026-09-20T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);

  await runPlan(raw, (await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 3 })])).statements);
  assert.equal(lotQty(raw, a), 0);

  await runPlan(raw, (await planLotRestore(asD1(raw), oid)).statements);
  assert.equal(lotQty(raw, a), 3, 'the units did not go back to the lot they came from');
  assert.equal(lotQty(raw, b), 10, 'the newest lot was credited units it never sold');
});

test('a cancellation spanning two lots gives each one back exactly what it gave', async () => {
  // §36's worked example: 2 from Lot A and 1 from Lot B come back as 2 and 1,
  // never as 3 into the newest.
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 2, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const b = seedLot(raw, { product: pid, qty: 10, unitCost: 560_000, received: '2026-09-20T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);

  await runPlan(raw, (await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 3 })])).statements);
  assert.equal(lotQty(raw, a), 0);
  assert.equal(lotQty(raw, b), 9);

  await runPlan(raw, (await planLotRestore(asD1(raw), oid)).statements);
  assert.equal(lotQty(raw, a), 2);
  assert.equal(lotQty(raw, b), 10);
});

test('a return cannot give back more than was taken', async () => {
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);
  await runPlan(raw, (await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 2 })])).statements);

  await runPlan(raw, (await planLotRestore(asD1(raw), oid, { qtyByLine: { itm_1: 99 } })).statements);
  assert.equal(lotQty(raw, a), 10, 'the lot was inflated past what it ever received');
});

test('a returned unit stops counting as a cost of goods sold', async () => {
  const raw = freshDb();
  const pid = seedProduct(raw);
  seedLot(raw, { product: pid, qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);
  await runPlan(raw, (await planLotConsumption(asD1(raw), oid, [move({ product: pid, line: 'itm_1', qty: 4 })])).statements);
  assert.equal((await cogsByLine(asD1(raw), [oid])).get('itm_1')!.cogs_iqd, 1_800_000);

  await runPlan(raw, (await planLotRestore(asD1(raw), oid, { qtyByLine: { itm_1: 1 } })).statements);
  const after = (await cogsByLine(asD1(raw), [oid])).get('itm_1')!;
  assert.equal(after.qty, 3);
  assert.equal(after.cogs_iqd, 1_350_000, 'the returned unit is still being charged as sold');
});

// =========================================================================
// 6. THE ACCEPTANCE EXAMPLE — §81
// =========================================================================

test('ACCEPTANCE §81 — 10 at 450,000 plus 10 at 560,000, sell 12, COGS is 5,620,000', async () => {
  const raw = freshDb();
  const pid = seedProduct(raw, 'OPTION');
  raw
    .prepare(`INSERT INTO product_option_groups (id, product_id, name_en) VALUES ('grp_a', ?, 'Option')`)
    .run(pid);
  raw
    .prepare(
      `INSERT INTO product_option_values (id, product_id, group_id, name_en, stock) VALUES ('opt_a', ?, 'grp_a', 'A', 20)`
    )
    .run(pid);

  const lotA = seedLot(raw, {
    product: pid, scope: 'option', scopeId: 'opt_a',
    qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z',
  });
  const lotB = seedLot(raw, {
    product: pid, scope: 'option', scopeId: 'opt_a',
    qty: 10, unitCost: 560_000, received: '2026-09-20T00:00:00.000Z',
  });

  // Before the sale: twenty units the customer can see, two costs the owner can.
  const before = await fifoQueues(asD1(raw), [{ scope: 'option', scope_id: 'opt_a' }]);
  assert.equal(
    (before.get('option:opt_a') ?? []).reduce((n, l) => n + l.qty_remaining, 0),
    20
  );

  const oid = seedOrder(raw, ['itm_1']);
  const plan = await planLotConsumption(asD1(raw), oid, [
    move({ product: pid, line: 'itm_1', qty: 12, scope: 'option', scopeId: 'opt_a' }),
  ]);
  await runPlan(raw, plan.statements);

  assert.equal(lotQty(raw, lotA), 0, 'the old lot must be exhausted first');
  assert.equal(lotQty(raw, lotB), 8);

  const cogs = (await cogsByLine(asD1(raw), [oid])).get('itm_1')!;
  assert.equal(cogs.qty, 12);
  assert.equal(cogs.lots, 2, 'the sale must remember that it crossed two lots');
  assert.equal(cogs.known, true);

  assert.equal(cogs.cogs_iqd, 5_620_000, 'the owner\'s exact number');
  assert.notEqual(cogs.cogs_iqd, 12 * 560_000, 'it priced everything at the newest cost');
  assert.notEqual(cogs.cogs_iqd, 12 * 505_000, 'it used a weighted average');
});

// ---------------------------------------------------------------------------
//  THE REPLAY THE GUARDS DID NOT CATCH
// ---------------------------------------------------------------------------

test('a replayed RESTORE does not credit the lot a second time', async () => {
  /**
   * The case the `qty_remaining + ? <= qty_received` cap alone does not cover,
   * because the room exists: a lot of 10 sells 4 to this order and 6 to
   * another, this order comes back, and the replay's +4 fits inside the lot's
   * own ceiling. The shelf then claims 8 units while holding 4.
   *
   * The consumption row stays `released_at IS NULL` for ever — a release is a
   * separate row — so a second call reads the same rows and plans the same
   * restore. The fix is to skip the releases already recorded.
   */
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });

  const mine = seedOrder(raw, ['itm_1']);
  await runPlan(raw, (await planLotConsumption(asD1(raw), mine, [move({ product: pid, line: 'itm_1', qty: 4 })])).statements);
  const theirs = seedOrder(raw, ['itm_2']);
  await runPlan(raw, (await planLotConsumption(asD1(raw), theirs, [move({ product: pid, line: 'itm_2', qty: 6 })])).statements);
  assert.equal(lotQty(raw, a), 0);

  await runPlan(raw, (await planLotRestore(asD1(raw), mine)).statements);
  assert.equal(lotQty(raw, a), 4);

  const replay = await planLotRestore(asD1(raw), mine);
  assert.equal(replay.statements.length, 0, 'the replay planned work that was already done');
  await runPlan(raw, replay.statements);
  assert.equal(lotQty(raw, a), 4, 'the replay credited the lot units nobody returned');

  // And the other order's six units are still sold, which is the whole point.
  const released = raw.prepare(
    `SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE released_at IS NOT NULL`
  ).get() as { n: number };
  assert.equal(released.n, 1);
});

test('two callers racing on one line: the loser takes nothing with it', async () => {
  /**
   * Both planned before either committed, so neither could see the other's
   * allocation row and the read-before-write skip cannot help. The allocation's
   * UNIQUE key is the last lock, and it only works because that INSERT is hard:
   * `INSERT OR IGNORE` would let the loser's duplicate pass silently while the
   * lot UPDATE beside it — which only asks whether the lot still holds enough —
   * took four more units.
   */
  const raw = freshDb();
  const pid = seedProduct(raw);
  const a = seedLot(raw, { product: pid, qty: 10, unitCost: 450_000, received: '2026-08-10T00:00:00.000Z' });
  const oid = seedOrder(raw, ['itm_1']);
  const moves = [move({ product: pid, line: 'itm_1', qty: 4 })];

  const first = await planLotConsumption(asD1(raw), oid, moves);
  const second = await planLotConsumption(asD1(raw), oid, moves);
  assert.equal(second.statements.length, first.statements.length, 'both callers planned the same work');

  await runPlan(raw, first.statements);
  await assert.rejects(asD1(raw).batch(second.statements as never), 'the loser must lose its whole batch');

  assert.equal(lotQty(raw, a), 6, 'the lot was consumed twice');
  const n = raw.prepare(`SELECT COUNT(*) AS n FROM order_item_inventory_allocations`).get() as { n: number };
  assert.equal(n.n, 1);
});
