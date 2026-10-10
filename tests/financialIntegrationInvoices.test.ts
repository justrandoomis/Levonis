import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, json, post, stubApp } from './fixtures/app';
import { seedCatalogue, orderBody } from './lib/bundles';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { createInvoiceForOrder, invoiceEmailData, type InvoiceSnapshotV1 } from '../worker/lib/invoices';

for (const member of ['unit', 'line'] as const) {
  test(`actual ${member}-applied member checkout produces invoice rows that reconcile to its total`, async () => {
    const raw = seedCatalogue(), db = asD1(raw);
    raw.exec(`UPDATE users SET email='boss@x.co' WHERE id='boss';
      UPDATE users SET email_verified_at=NULL WHERE id='u_pro';
      UPDATE admin_settings SET value='{"paused":false,"since":null}' WHERE key='proPause';
      INSERT INTO approved_addresses(id,user_id,version,name,phone_e164,address,landmark,state)
        VALUES('integration-pro','u_pro',1,'Rami','+9647701234570','Baghdad, Karrada 15','','approved');`);
    const customer = stubApp(db, { id: 'u_pro', role: 'customer', email: 'r@x.co' }, a => {
      a.route('/api/cart', cartRoutes); a.route('/api/orders', orderRoutes);
    });
    const admin = stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => {
      a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
    });
    const rule = await json(await post(admin, '/api/admin/membership-benefits', {
      tier: 'pro', benefit_type: 'product_discount', scope: 'global', discount_mode: 'percent',
      percent: 10, max_discount_iqd: 10000, cap_scope: member === 'unit' ? 'per_unit' : 'per_order', label: 'Invoice membership',
    }));
    assert.equal(rule.success, true, JSON.stringify(rule));
    assert.equal((await json(await post(customer, '/api/cart/items', { productId: 'p_pla', qty: 2 }))).success, true);
    const placed = await json(await post(customer, '/api/orders', orderBody({ addressId: 'addr_o' })));
    assert.equal(placed.success, true, JSON.stringify(placed));
    const orderId = String(placed.order.id);
    const invoice = await createInvoiceForOrder({ DB: db } as Parameters<typeof createInvoiceForOrder>[0], orderId);
    assert.ok(invoice);
    const saved = raw.prepare('SELECT snapshot FROM invoices WHERE id=?').get(invoice.invoiceId)!;
    const snapshot = JSON.parse(String(saved.snapshot)) as InvoiceSnapshotV1;
    const data = invoiceEmailData(snapshot, invoice.invoiceNo, 1, '2026-10-11T00:00:00Z');
    const order = raw.prepare('SELECT * FROM orders WHERE id=?').get(orderId)!;
    assert.equal(order.membership_discount_iqd, 5000, 'the recorded total saving is retained');
    assert.equal(data.membership_discount_iqd, member === 'unit' ? 0 : 5000,
      'only a saving not already inside the displayed subtotal is another invoice subtraction');
    assert.equal(data.subtotal_iqd + data.delivery_fee_iqd + (data.cod_tax_iqd ?? 0)
      - (data.membership_discount_iqd ?? 0) - data.coupon_discount_iqd - data.points_applied_iqd,
      data.total_iqd, 'printed breakdown and paid/due total must agree');
    assert.equal(data.total_iqd, order.total_iqd);
    const replay = await createInvoiceForOrder({ DB: db } as Parameters<typeof createInvoiceForOrder>[0], orderId);
    assert.equal(replay?.created, false);
    assert.equal(raw.prepare('SELECT snapshot FROM invoices WHERE id=?').get(invoice.invoiceId)!.snapshot, saved.snapshot,
      'already-issued invoice snapshots remain immutable');
  });
}
