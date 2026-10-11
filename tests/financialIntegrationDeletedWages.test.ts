import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, patch, post, stubApp } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { changeWithdrawalState, participantOverview, payWithdrawal, reconcileStaffOrderCosts, requestWithdrawal } from '../worker/lib/financeParticipants';
import { deleteProductPermanently } from '../worker/lib/productDeletion';
import { DELETED_PRODUCT_FINANCE_SCOPE_ACTION, readDeletedProductFinanceScopes } from '../worker/lib/financeDeletedProductScope';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { recordFinancialFailure } from '../worker/lib/orderFinance';
import type { Env } from '../worker/lib/types';

async function setup(target: 'product' | 'catalog') {
  const raw = freshDb(), db = asD1(raw);
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),('employee','employee@x.co','Worker','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO catalogs(id,parent_id,slug,name_ar) VALUES ('root',NULL,'root','Root'),('child','root','child','Child'),('other',NULL,'other','Other');
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','deleted-wage-printer',50000,20000);
    INSERT INTO product_catalogs(product_id,catalog_id,position) VALUES ('p','child',1);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES ('order','buyer','delivered','{}','standard','{}','cash',100000,1500,100000,100000,0,'2026-09-01T00:00:00Z','2026-09-22T10:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('line','order','p','Printer',2,50000,100000,20000,'snapshot');`);
  const app = stubApp(db, { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, a => {
    a.route('/people', adminFinancePeopleRoutes); a.route('/operations', adminFinanceOperationsRoutes);
  });
  const call = async (path: string, body: Record<string, unknown>) => {
    const response = await post(app, path, body), value = await json(response);
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const staff = await call('/people/staff', { user_id: 'employee', start_work_date: '2026-09-01' });
  const rule = await call('/operations/rules', { staff_id: staff.id, basis: 'profit_percent', amount: 1000,
    milestone: 'delivered', target_type: target, target_id: target === 'product' ? 'p' : 'root' });
  const drain = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const result = await call(`/people/staff/${staff.id}/reconcile`, {});
      assert.notEqual(result.reconciliation.state, 'failed', JSON.stringify(result));
      if (result.reconciliation.state === 'complete') return;
    }
    assert.fail('Staff reconciliation did not finish');
  };
  const revise = async (amount: number, extra: Record<string, unknown> = {}) => {
    const version = raw.prepare('SELECT version FROM finance_cost_rules WHERE id=?').get(rule.id)!.version;
    const body = { amount, basis: 'profit_percent', effective_from: '2026-09-15', reason: 'Explicit historical wage revision', version, ...extra };
    let preview = await call(`/people/rules/${rule.id}/preview`, body);
    while (preview.complete === false) preview = await call(`/people/rules/${rule.id}/preview`, { ...body, preview_job_id: preview.preview_job_id });
    await call(`/people/rules/${rule.id}/apply`, { ...body, operation_id: crypto.randomUUID(), preview_token: preview.preview_token });
    await drain(); return preview;
  };
  await drain();
  return { raw, db, app, env: { DB: db } as Env, revise };
}

for (const target of ['product', 'catalog'] as const) {
  test(`deleting a ${target}-scoped wage product preserves earned money and current explicit revisions`, async () => {
    const x = await setup(target);
    try {
      assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 6000);
      await requestWithdrawal(x.env, 'employee', 'paid', 2000);
      await changeWithdrawalState(x.db, 'paid', 'boss', 'approve');
      await payWithdrawal(x.db, 'boss', 'paid', { id: 'receipt', reference: 'cash proof', receipt_url: '' });
      await requestWithdrawal(x.env, 'employee', 'held', 1000);
      const paid = x.raw.prepare('SELECT * FROM finance_staff_payments ORDER BY id').all();
      const frozen = x.raw.prepare('SELECT * FROM finance_order_snapshots ORDER BY order_id').all();
      const costs = x.raw.prepare('SELECT * FROM finance_order_costs ORDER BY id').all();
      const before = (await participantOverview(x.db, 'employee')).summary;
      assert.equal((await deleteProductPermanently(x.db, 'p')).product_deleted, true);
      assert.equal((await reconcileStaffOrderCosts(x.db, 'order')).adjusted, 0);
      const after = (await participantOverview(x.db, 'employee')).summary;
      assert.deepEqual([after.staff_iqd, after.earnings_paid_iqd, after.held_iqd, after.available_earnings_iqd],
        [before.staff_iqd, before.earnings_paid_iqd, before.held_iqd, before.available_earnings_iqd]);
      assert.deepEqual(x.raw.prepare('SELECT * FROM finance_staff_payments ORDER BY id').all(), paid);
      assert.deepEqual(x.raw.prepare('SELECT * FROM finance_order_snapshots ORDER BY order_id').all(), frozen);
      assert.deepEqual(x.raw.prepare('SELECT * FROM finance_order_costs ORDER BY id').all(), costs);
      const fact = (await readDeletedProductFinanceScopes(x.db, ['line'])).get('line')!;
      assert.equal(fact.productId, 'p');
      assert.deepEqual([...fact.catalogDepths].sort(), [['child', 2], ['root', 1]], 'secondary catalogue ancestry is retained without a main/sub department');
      assert.equal(x.raw.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=? AND target=?').get(DELETED_PRODUCT_FINANCE_SCOPE_ACTION, 'line')!.n, 1);

      // Reusing the catalogue id does not reclassify the old sale.
      x.raw.exec("INSERT INTO products(id,name,slug,price_iqd,category_id) VALUES ('p','Different product','reused-wage-id',1000,'other')");
      const journals = x.raw.prepare('SELECT * FROM accounting_entries ORDER BY id').all();
      assert.equal((await reconcileStaffOrderCosts(x.db, 'order')).adjusted, 0);
      assert.deepEqual(x.raw.prepare('SELECT * FROM accounting_entries ORDER BY id').all(), journals);
      await changeWithdrawalState(x.db, 'held', 'employee', 'cancel', 'employee');
      const increase = await x.revise(2000);
      assert.equal(increase.delta_iqd, 6000, 'the current effective amount is applied to the proved original scope');
      assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 12000);
      const removal = await x.revise(2000, { scope: { catalog_ids: ['root'], product_ids: [], excluded_product_ids: ['p'] } });
      assert.equal(removal.delta_iqd, -12000, 'an explicit revised exclusion still removes the old entitlement');
      const removed = (await participantOverview(x.db, 'employee')).summary;
      assert.equal(removed.staff_iqd, 0);
      assert.equal(removed.staff_debt_iqd, 2000);
      assert.deepEqual(x.raw.prepare('SELECT * FROM finance_staff_payments ORDER BY id').all(), paid);
      const corrections = x.raw.prepare('SELECT * FROM finance_cost_adjustments ORDER BY id').all();
      assert.equal((await reconcileStaffOrderCosts(x.db, 'order')).adjusted, 0);
      assert.deepEqual(x.raw.prepare('SELECT * FROM finance_cost_adjustments ORDER BY id').all(), corrections);
    } finally { x.raw.close(); }
  });
}

test('deleted wage identity accepts only strict system facts and never overrides a live line', async () => {
  const x = await setup('product');
  try {
    const fact = { version: 1, product_id: 'p', catalog_depths: { root: 1, child: 2 } };
    const write = (detail: unknown, actor: string | null = null, action = DELETED_PRODUCT_FINANCE_SCOPE_ACTION) =>
      x.raw.prepare('INSERT INTO audit_log(actor_id,action,target,detail) VALUES (?,?,?,?)').run(actor, action, 'line', typeof detail === 'string' ? detail : JSON.stringify(detail));
    write(fact);
    assert.equal((await readDeletedProductFinanceScopes(x.db, ['line'])).size, 0);
    x.raw.exec("UPDATE order_items SET product_id=NULL WHERE id='line'");
    assert.equal((await readDeletedProductFinanceScopes(x.db, ['line'])).get('line')!.productId, 'p');
    for (const invalid of ['{', { ...fact, version: 2 }, { ...fact, product_id: '' }, { ...fact, catalog_depths: [] }, { ...fact, catalog_depths: { root: 0 } }, { ...fact, catalog_depths: { root: '1' } }]) {
      write(invalid);
      assert.equal((await readDeletedProductFinanceScopes(x.db, ['line'])).size, 0);
    }
    x.raw.prepare('DELETE FROM audit_log WHERE action=?').run(DELETED_PRODUCT_FINANCE_SCOPE_ACTION);
    write(fact, 'boss'); write(fact, null, 'unrelated');
    assert.equal((await readDeletedProductFinanceScopes(x.db, ['line'])).size, 0);
  } finally { x.raw.close(); }
});

test('a legacy deleted wage with no scope evidence waits for review without erasing pay; explicit deactivation still applies', async () => {
  const x = await setup('product');
  try {
    await requestWithdrawal(x.env, 'employee', 'legacy-paid', 2000);
    await changeWithdrawalState(x.db, 'legacy-paid', 'boss', 'approve');
    await payWithdrawal(x.db, 'boss', 'legacy-paid', { id: 'legacy-receipt', reference: 'cash proof', receipt_url: '' });
    // Reproduce deletion by the former code: the link is already gone when
    // this code sees the product, so there is no identity to capture or guess.
    x.raw.exec("UPDATE order_items SET product_id=NULL WHERE id='line'");
    await deleteProductPermanently(x.db, 'p');
    assert.equal((await readDeletedProductFinanceScopes(x.db, ['line'])).size, 0);
    const costs = x.raw.prepare('SELECT * FROM finance_order_costs ORDER BY id').all();
    const paid = x.raw.prepare('SELECT * FROM finance_staff_payments ORDER BY id').all();
    const adjustments = x.raw.prepare('SELECT * FROM finance_cost_adjustments ORDER BY id').all();
    await assert.rejects(reconcileStaffOrderCosts(x.db, 'order'), { code: 'WAGE_SCOPE_REVIEW_REQUIRED' });
    await recordFinancialFailure(x.db, 'order', 'automatic-finance', new Error('Synthetic interrupted reconciliation'));
    const recovery = await drainOrderFinanceRecovery(x.env);
    assert.deepEqual([recovery.scanned, recovery.failed], [1, 1]);
    assert.match(String(x.raw.prepare("SELECT message FROM finance_posting_errors WHERE event_key='automatic-finance:order'").get()!.message), /wage scope/i);
    assert.deepEqual(x.raw.prepare('SELECT * FROM finance_order_costs ORDER BY id').all(), costs);
    assert.deepEqual(x.raw.prepare('SELECT * FROM finance_staff_payments ORDER BY id').all(), paid);
    assert.deepEqual(x.raw.prepare('SELECT * FROM finance_cost_adjustments ORDER BY id').all(), adjustments);
    const universal = await x.revise(1000, { scope: { catalog_ids: [], product_ids: [], excluded_product_ids: [] } });
    assert.equal(universal.delta_iqd, 0, 'an explicit universal scope needs no missing product identity');
    const removal = await x.revise(1000, { active: false });
    assert.equal(removal.delta_iqd, -6000, 'explicit deactivation proves the wage ended without needing product scope');
    const summary = (await participantOverview(x.db, 'employee')).summary;
    assert.equal(summary.staff_iqd, 0);
    assert.equal(summary.staff_debt_iqd, 2000);
    assert.deepEqual(x.raw.prepare('SELECT * FROM finance_staff_payments ORDER BY id').all(), paid);
  } finally { x.raw.close(); }
});

test('an explicit manual wage remains calculable when a legacy deleted product has no scope evidence', async () => {
  const x = await setup('product');
  try {
    const cost = x.raw.prepare("SELECT id FROM finance_order_costs WHERE order_id='order'").get()!;
    const response = await patch(x.app, `/people/costs/${cost.id}`, { amount_iqd: 7000 });
    assert.equal(response.status, 200, JSON.stringify(await json(response)));
    x.raw.exec("UPDATE order_items SET product_id=NULL WHERE id='line'");
    await deleteProductPermanently(x.db, 'p');
    const adjustments = x.raw.prepare('SELECT * FROM finance_cost_adjustments ORDER BY id').all();
    assert.equal((await reconcileStaffOrderCosts(x.db, 'order')).adjusted, 0);
    assert.equal((await participantOverview(x.db, 'employee')).summary.staff_iqd, 7000);
    assert.deepEqual(x.raw.prepare('SELECT * FROM finance_cost_adjustments ORDER BY id').all(), adjustments);
  } finally { x.raw.close(); }
});
