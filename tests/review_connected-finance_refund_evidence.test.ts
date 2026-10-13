// Review reproduction (connected-finance, 3c051143): the cumulative refund cap
// reads each earlier resolved refund's amount from audit_log (or its wallet
// credit). A Gini order (or a 0 IQD refund) has no wallet credit, and the audit
// row is written after the decision batch by audit(), which swallows failures
// and runs only after points/finance/serial hooks. When that write is lost the
// committed refund has no evidence and every later refund of the line is
// refused for ever, although the amount is known (finance facts, case note).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, json, post, stubApp } from './fixtures/app';
import { returnRoutes } from '../worker/routes/returns';

test('a committed Gini refund keeps its amount as evidence for the next partial refund of the same line', async () => {
  const raw = freshDb(), db = asD1(raw);
  try {
    raw.exec(`INSERT INTO users(id,email,name,role) VALUES ('boss','boss@x.co','Owner','admin'),('u1','u1@x.co','Buyer','customer');
      INSERT INTO products(id,name,slug,price_iqd) VALUES ('p','Printer','printer-p',100000);
      INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,gini_paid_iqd,delivered_at)
        VALUES ('o','u1','delivered','{}','home','{}','gini',200000,1400,200000,0,200000,'2026-10-01T00:00:00.000Z');
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
        VALUES ('line','o','p','Printer',2,100000,200000);
      INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state) VALUES
        ('rc1','o','line','u1',1,'defective','inspected'),('rc2','o','line','u1',1,'defective','inspected');`);
    const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => a.route('/api/returns', returnRoutes));
    // The decision batch commits; the separate, error-swallowing audit write does not
    // (equivalently: a later hook such as the points reversal throws before audit()).
    raw.exec(`CREATE TRIGGER lose_return_audit BEFORE INSERT ON audit_log WHEN NEW.action='return.transition'
      BEGIN SELECT RAISE(ABORT,'synthetic transient audit failure'); END;`);
    const first = await json(await post(admin, '/api/returns/admin/rc1/transition', { to: 'resolved', resolution: 'refund' }));
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.refund.channel, 'gini');
    assert.equal(first.refund.amount_iqd, 100000);
    assert.equal(raw.prepare("SELECT state FROM return_cases WHERE id='rc1'").get()!.state, 'resolved');
    // The amount is durably known elsewhere (the refund fact and the case's Gini note), but not consulted.
    const fact = raw.prepare("SELECT refund_iqd FROM finance_refund_facts WHERE case_id='rc1'").get();
    console.log('finance_refund_facts rc1:', JSON.stringify(fact), 'note:', raw.prepare("SELECT admin_note FROM return_cases WHERE id='rc1'").get()!.admin_note);
    raw.exec('DROP TRIGGER lose_return_audit');
    const second = await post(admin, '/api/returns/admin/rc2/transition', { to: 'resolved', resolution: 'refund' });
    const body = await json(second);
    assert.equal(second.status, 200, `second unit of the line can never be refunded: ${JSON.stringify(body)}`);
    assert.equal(body.refund.amount_iqd, 100000);
  } finally { raw.close(); }
});
