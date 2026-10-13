// Review reproduction (connected-finance, 70b3b623): a line whose product_id
// was NULL from checkout (a mystery spool, orders.ts binds NULL on purpose)
// is treated as "a deleted product with no captured scope". Any earned wage
// on it from a non-universal rule then refuses every later recalculation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, post, stubApp } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { participantOverview, reconcileStaffOrderCosts } from '../worker/lib/financeParticipants';

/** What checkout writes with a mystery spool line, in the order's own batch:
 * its draw in mystery_allocations (worker/lib/mysteryDraw.ts). The fix keys
 * "never linked" on that record, so the fixture carries it (fix 2026-10-13). */
const POOL = `INSERT INTO products(id,name,slug,price_iqd) VALUES ('offer','Mystery offer','mystery-offer',50000),('drawn','PLA Red','pla-red',50000);
  INSERT INTO mystery_pools(id,name) VALUES ('pool','Pool');
  INSERT INTO mystery_pool_entries(id,pool_id,product_id) VALUES ('entry','pool','drawn');`;
const draw = (orderId: string, lineId: string) => `INSERT INTO mystery_allocations(order_item_id,spool_index,order_id,offer_product_id,pool_id,pool_entry_id,product_id,name_snapshot,sale_mode,seed,reveal_stage_snapshot,candidates_sha256)
  VALUES ('${lineId}',0,'${orderId}','offer','pool','entry','drawn','PLA Red','direct','${'0'.repeat(64)}','delivered','${'0'.repeat(64)}'),
         ('${lineId}',1,'${orderId}','offer','pool','entry','drawn','PLA Red','direct','${'1'.repeat(64)}','delivered','${'0'.repeat(64)}');`;

test('a never-linked (mystery) line is not deleted-product evidence: exclusion-scoped wage stays calculable', async () => {
  const raw = freshDb(), db = asD1(raw);
  try {
    raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
      ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
      INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('excluded','Gift card','gift-card',1000,0);
      INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
        VALUES ('order','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,0,'2026-09-01T00:00:00Z','2026-09-22T10:00:00Z');
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
        VALUES ('spool','order',NULL,'Mystery spool',2,50000,100000,20000,'snapshot');
      ${POOL} ${draw('order', 'spool')}`);
    const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
      a.route('/people', adminFinancePeopleRoutes); a.route('/operations', adminFinanceOperationsRoutes);
    });
    const call = async (path: string, body: Record<string, unknown>) => {
      const response = await post(app, path, body), value = await json(response);
      assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const staff = await call('/people/staff', { user_id: 'employee', start_work_date: '2026-09-01' });
    // "Every product except gift cards": a supported, non-universal scope.
    await call('/operations/rules', { staff_id: staff.id, basis: 'unit', amount: 500, milestone: 'delivered',
      target_type: 'all', scope: { catalog_ids: [], product_ids: [], excluded_product_ids: ['excluded'] } });
    let state = '';
    for (let attempt = 0; attempt < 10 && state !== 'complete'; attempt++) {
      const result = await call(`/people/staff/${staff.id}/reconcile`, {});
      state = result.reconciliation.state;
      assert.notEqual(state, 'failed', JSON.stringify(result));
    }
    assert.equal(state, 'complete');
    // The wage was earned on the never-linked line (2 units x 500).
    assert.equal((await participantOverview(db, 'employee')).summary.staff_iqd, 1000);
    // No product was ever deleted. A plain recalculation must succeed and change nothing.
    const outcome = await reconcileStaffOrderCosts(db, 'order').then(r => r, (e: { code?: string; message?: string }) => e);
    assert.ok(!('code' in outcome && outcome.code === 'WAGE_SCOPE_REVIEW_REQUIRED'),
      `never-linked line refused as missing deleted-product scope: ${JSON.stringify(outcome)}`);
  } finally { raw.close(); }
});

test('delivery of a new mystery order with an exclusion-scoped wage completes its finance pass', async () => {
  const { runOrderFinancialEffects } = await import('../worker/lib/orderFinance');
  const raw = freshDb(), db = asD1(raw);
  try {
    raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
      ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
      INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('excluded','Gift card','gift-card',1000,0);`);
    const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
      a.route('/people', adminFinancePeopleRoutes); a.route('/operations', adminFinanceOperationsRoutes);
    });
    const call = async (path: string, body: Record<string, unknown>) => {
      const response = await post(app, path, body), value = await json(response);
      assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const staff = await call('/people/staff', { user_id: 'employee', start_work_date: '2026-09-01' });
    await call('/operations/rules', { staff_id: staff.id, basis: 'unit', amount: 500, milestone: 'delivered',
      target_type: 'all', scope: { catalog_ids: [], product_ids: [], excluded_product_ids: ['excluded'] } });
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await call(`/people/staff/${staff.id}/reconcile`, {});
      if (result.reconciliation.state === 'complete') break;
    }
    raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
        VALUES ('fresh','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,0,'2026-10-01T00:00:00Z','2026-10-02T10:00:00Z');
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
        VALUES ('fresh-spool','fresh',NULL,'Mystery spool',2,50000,100000,20000,'snapshot');
      ${POOL} ${draw('fresh', 'fresh-spool')}`);
    const outcome = await runOrderFinancialEffects({ DB: db } as never, 'fresh', 'delivered').then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));
    const sale = raw.prepare("SELECT COUNT(*) n FROM accounting_entries WHERE event_key='sale:fresh'").get()!.n;
    assert.equal(outcome, 'ok', `delivery finance pass refused after posting sale journal (sale entries: ${sale})`);
  } finally { raw.close(); }
});

test('a later staff reconciliation job does not stop permanently at a mystery order', async () => {
  const raw = freshDb(), db = asD1(raw);
  try {
    raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
      ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
      INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('excluded','Gift card','gift-card',1000,0);
      INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
        VALUES ('order','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,0,'2026-09-01T00:00:00Z','2026-09-22T10:00:00Z');
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
        VALUES ('spool','order',NULL,'Mystery spool',2,50000,100000,20000,'snapshot');
      ${POOL} ${draw('order', 'spool')}`);
    const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
      a.route('/people', adminFinancePeopleRoutes); a.route('/operations', adminFinanceOperationsRoutes);
    });
    const call = async (path: string, body: Record<string, unknown>) => {
      const response = await post(app, path, body), value = await json(response);
      assert.equal(response.status, 200, JSON.stringify(value)); return value;
    };
    const drain = async (staffId: string) => {
      let state = '', error = '';
      for (let attempt = 0; attempt < 10 && state !== 'complete' && state !== 'failed'; attempt++) {
        const result = await call(`/people/staff/${staffId}/reconcile`, {});
        state = result.reconciliation.state; error = String(result.reconciliation.error ?? '');
      }
      return { state, error };
    };
    const staff = await call('/people/staff', { user_id: 'employee', start_work_date: '2026-09-01' });
    await call('/operations/rules', { staff_id: staff.id, basis: 'unit', amount: 500, milestone: 'delivered',
      target_type: 'all', scope: { catalog_ids: [], product_ids: [], excluded_product_ids: ['excluded'] } });
    assert.equal((await drain(staff.id)).state, 'complete');
    // Any later change that queues this employee's reconciliation (here: a second wage rule).
    await call('/operations/rules', { staff_id: staff.id, basis: 'unit', amount: 100, milestone: 'delivered', target_type: 'all',
      group_key: 'second-task' });
    const second = await drain(staff.id);
    assert.equal(second.state, 'complete', `staff reconciliation stuck: ${JSON.stringify(second)}`);
  } finally { raw.close(); }
});

/* Control (fix 2026-10-13): a NULL-product line with NO checkout draw is still
 * a legacy deletion whose scope was never recorded, and still waits for review
 * (tests/financialIntegrationDeletedWages.test.ts covers the full flow). */
test('control: without its checkout draw a NULL-product line keeps the legacy-deletion review', async () => {
  const { readNeverLinkedLines } = await import('../worker/lib/financeDeletedProductScope');
  const raw = freshDb(), db = asD1(raw);
  try {
    raw.exec(`INSERT INTO users(id,email,name,role) VALUES ('buyer','buyer@x.co','Buyer','customer');
      INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
        VALUES ('order','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,0,'2026-09-01T00:00:00Z','2026-09-22T10:00:00Z');
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
        VALUES ('spool','order',NULL,'Mystery spool',2,50000,100000,20000,'snapshot'),('deleted','order',NULL,'Printer',1,50000,50000,20000,'snapshot');
      ${POOL} ${draw('order', 'spool')}`);
    assert.deepEqual([...await readNeverLinkedLines(db, ['spool', 'deleted'])], ['spool']);
  } finally { raw.close(); }
});
