import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, row, count } from './fixtures/app';
import { planLotConsumption, fifoQueues } from '../worker/lib/inventoryLots';
import { planAtomicAdjustment } from '../worker/lib/inventoryAdjustment';
import { quoteShipping, type ShippingConfig } from '../packages/shipping/src/shipping';

const config: ShippingConfig = {
  ordinary_iqd: 5000,
  printer_small_iqd: null,
  printer_large_iqd: null,
  pro_threshold_iqd: 75000,
  threshold_basis: 'merchandise_after_coupon',
  pro_waiver_covers: 'all',
  prime_threshold_iqd: 75000,
  prime_waiver_covers: 'ordinary_only',
  carton_threshold_spools: 15,
  carton_fee_iqd: 5000,
  printer_advance_required: true,
  protected_iqd: null,
};
const base = {
  deliveryMethod: 'standard' as const,
  merchandiseIqd: 10000,
  tier: 'free' as const,
  tierActive: false,
  atApprovedDefaultAddress: false,
  config,
};

test('standard shipment stays 5k across products, colours, category blocks and carton thresholds', () => {
  const q = quoteShipping({
    ...base,
    items: [
      { product_id: 'PLA', qty: 31, size_class: 'ordinary', is_spool: true, category_path: ['filament'] },
      {
        product_id: 'part',
        qty: 10,
        size_class: 'ordinary',
        delivery: {
          standard: { enabled: true, quantity_step: 1, fee_iqd: 15000 },
          personal: { enabled: false, quantity_step: 1, fee_iqd: 0 },
        },
      },
    ],
    categoryRules: [
      { catalog_id: 'filament', method: 'standard', enabled: true, quantity_step: 15, fee_iqd: 5000 },
    ],
  });
  assert.equal(q.total_iqd, 5000);
  assert.equal(q.components.length, 1);
});

test('catalogue printer classification makes a mixed shipment 10k without a configured size surcharge', () => {
  const q = quoteShipping({
    ...base,
    items: [
      { product_id: 'printer', qty: 2, size_class: null, is_printer: true },
      { product_id: 'filament', qty: 5, size_class: 'ordinary' },
    ],
  });
  assert.equal(q.total_iqd, 10000);
  assert.deepEqual(q.needs_config, []);
  assert.equal(q.components.length, 1);
});

test('a standard delivery waiver applies after the single printer shipment tariff', () => {
  const q = quoteShipping({
    ...base,
    tier: 'prime',
    tierActive: true,
    merchandiseIqd: 100000,
    items: [{ product_id: 'printer', qty: 1, size_class: null, is_printer: true }],
    membershipShipping: {
      rule_id: 'premium',
      eligible: true,
      threshold_iqd: 75000,
      basis_iqd: 100000,
      max_subsidy_iqd: null,
      reason: 'applied',
    },
  });
  assert.equal(q.total_before_waiver_iqd, 10000);
  assert.equal(q.total_iqd, 0);
  assert.equal(q.membership_subsidy_iqd, 10000);
});

function stockDb() {
  const raw = freshDb();
  raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('a','A','a',20000,5,'BASE'),('b','B','b',20000,5,'BASE');
    INSERT INTO users(id,email) VALUES ('buyer','buyer@example.test');
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('order_b','buyer','pending','{}','standard','{}','cod',20000,1500,25000,25000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('item_b','order_b','b','B',1,20000,20000);
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES ('lot_a','a','base','',5,5,1000,'opening','2026-01-01'),('lot_b','b','base','',5,5,9000,'opening','2026-02-01');`);
  return raw;
}

test('BASE FIFO consumption and its COGS are isolated by product_id', async () => {
  const raw = stockDb();
  const plan = await planLotConsumption(asD1(raw), 'order_b', [
    {
      line_id: 'item_b',
      product_id: 'b',
      qty: 1,
      targets: [
        { scope: 'base', scope_id: '', stock: 5, reserved: 0, low_stock_threshold: null, label: 'B' },
      ],
    },
  ]);
  assert.equal(plan.allocations[0].lot_id, 'lot_b');
  assert.equal(plan.allocations[0].cogs_iqd, 9000);
  await asD1(raw).batch(plan.statements);
  assert.equal(
    row<{ qty_remaining: number }>(raw, "SELECT qty_remaining FROM inventory_lots WHERE id='lot_a'")!
      .qty_remaining,
    5,
  );
});

test('a failed lot adjustment rolls back quantity and movement, and a positive count creates a cost layer', async () => {
  const raw = stockDb();
  const input = {
    productId: 'b',
    scope: 'base' as const,
    scopeId: '',
    delta: -2,
    reason: 'count' as const,
    note: '',
    operationId: 'atomic',
    actorUserId: null,
  };
  const plan = await planAtomicAdjustment(asD1(raw), input);
  raw.exec(
    "CREATE TRIGGER fail_lot BEFORE UPDATE ON inventory_lots BEGIN SELECT RAISE(ABORT, 'fault'); END;",
  );
  await assert.rejects(asD1(raw).batch(plan.statements));
  assert.equal(row<{ stock: number }>(raw, "SELECT stock FROM products WHERE id='b'")!.stock, 5);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM inventory_ledger'), 0);
  raw.exec('DROP TRIGGER fail_lot');
  const positive = await planAtomicAdjustment(asD1(raw), {
    ...input,
    operationId: 'found',
    delta: 2,
    unitCostIqd: 9000,
  });
  await asD1(raw).batch(positive.statements);
  assert.equal(count(raw, "SELECT SUM(qty_remaining) n FROM inventory_lots WHERE product_id='b'"), 7);
  assert.equal(
    (await planAtomicAdjustment(asD1(raw), { ...input, operationId: 'found', delta: 2, unitCostIqd: 9000 }))
      .already,
    true,
  );
});

test('counting cannot consume reserved units or commit after another stock change', async () => {
  const raw = stockDb();
  raw.exec("UPDATE products SET stock_reserved=4 WHERE id='b'");
  const input = {
    productId: 'b',
    scope: 'base' as const,
    scopeId: '',
    delta: -2,
    reason: 'count' as const,
    note: '',
    operationId: 'stale',
    actorUserId: null,
  };
  await assert.rejects(planAtomicAdjustment(asD1(raw), input), /المحجوز/);
  raw.exec("UPDATE products SET stock_reserved=0 WHERE id='b'");
  const plan = await planAtomicAdjustment(asD1(raw), input);
  raw.exec("UPDATE products SET stock=4 WHERE id='b'");
  await assert.rejects(asD1(raw).batch(plan.statements));
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM inventory_ledger'), 0);
});

test('repeated identities spanning a FIFO query chunk read each physical lot once', async () => {
  const raw = freshDb();
  raw.exec(
    "INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('same','same','same-queue',10000,2,'BASE');INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES ('same-lot','same','base','',2,2,100,'opening','2026-10-01')",
  );
  const queues = await fifoQueues(
    asD1(raw),
    Array.from({ length: 75 }, () => ({ scope: 'base' as const, scope_id: '', product_id: 'same' })),
  );
  assert.equal(queues.get('base:same')!.length, 1);
});
