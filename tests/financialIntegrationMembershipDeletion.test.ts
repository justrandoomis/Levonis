import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, freshDb } from './fixtures/app';
import { deleteProductPermanently } from '../worker/lib/productDeletion';
import { getOrderGoods, profitSourceFingerprint } from '../worker/lib/orderProfit';
import { membershipDiscountAtLine, membershipDiscountAtLineSql, UNLINKED_MEMBERSHIP_PRODUCTS } from '../worker/lib/orderMembership';
import { correctMembershipSale } from '../worker/lib/membershipSaleCorrection';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { staffBasisFingerprintSql } from '../worker/lib/financeParticipants';
import { salesByDaySql } from '../worker/lib/financeReport';
import { createInvoiceForOrder, type InvoiceSnapshotV1 } from '../worker/lib/invoices';
import { baghdadDay } from '../worker/lib/operations';
import type { Env } from '../worker/lib/types';
import { DELETED_PRODUCT_FINANCE_SCOPE_ACTION } from '../worker/lib/financeDeletedProductScope';

function world() {
  const raw = freshDb(), db = asD1(raw), day = baghdadDay();
  raw.exec(`INSERT INTO users(id,email,name) VALUES ('buyer','buyer@example.com','Buyer');
    INSERT INTO products(id,slug,name,price_iqd) VALUES ('p','p','P',100000),('q','q','Q',50000),('r','r','R',50000);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,
      payment_method_id,subtotal_iqd,membership_discount_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES ('o','buyer','delivered','{}','standard','{}','cash',200000,4000,1400,199000,199000,'2026-10-01T10:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,
      cost_iqd,cost_basis,membership_discount_iqd,membership_rule_id) VALUES
      ('ip','o','p','P',1,100000,100000,40000,'snapshot',2000,'unit-rule'),
      ('iq','o','q','Q',1,50000,50000,20000,'snapshot',1000,'unit-rule'),
      ('ir','o','r','R',1,50000,50000,20000,'snapshot',1000,'line-rule');`);
  const benefit = { version_id: 5, discount_total_iqd: 4000, unit_discount_iqd: 3000, line_discount_iqd: 1000,
    lines: [{ product_id: 'p', rule_id: 'unit-rule', applied_at: 'unit' },
      { product_id: 'q', rule_id: 'unit-rule', applied_at: 'unit' },
      { product_id: 'r', rule_id: 'line-rule', applied_at: 'line' }] };
  const snapshot = () => String(raw.prepare("SELECT benefit_snapshot FROM orders WHERE id='o'").get()!.benefit_snapshot);
  const sales = () => raw.prepare(salesByDaySql({ has0095: true, hasFifo: true, hasPriceAdjustments: true }))
    .get('2026-01-01', '2027-01-01')!;
  const env = { DB: db } as Env;
  return { raw, db, day, env, benefit, snapshot, sales };
}

for (const correctBeforeDelete of [false, true]) {
  test(`permanent deletion preserves membership goods, reports and native correction (${correctBeforeDelete ? 'already corrected' : 'correction pending'})`, async () => {
    const w = world();
    try {
      // Reconstruct an old native sale that deducted the embedded unit savings.
      await runOrderFinancialEffects(w.env, 'o', 'delivered');
      w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify(w.benefit));
      if (correctBeforeDelete) await correctMembershipSale(w.db, 'o', w.day);
      const native = JSON.stringify(w.raw.prepare("SELECT l.* FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key='sale:o' ORDER BY l.id").all());
      const before = (await getOrderGoods(w.db, 'o'))!;
      const fingerprint = await profitSourceFingerprint(w.db, 'o');
      assert.equal(before.lines.reduce((sum, line) => sum + line.net_goods_iqd, 0), 199000);
      assert.equal(w.sales().revenue_iqd, 199000);
      for (const product of ['p', 'q']) {
        assert.equal((await deleteProductPermanently(w.db, product)).product_deleted, true);
        const after = (await getOrderGoods(w.db, 'o'))!;
        assert.deepEqual(after.lines.map(line => [line.id, line.net_goods_iqd, line.cogs_iqd]),
          before.lines.map(line => [line.id, line.net_goods_iqd, line.cogs_iqd]));
        assert.equal(w.sales().revenue_iqd, 199000);
      }
      const preserved = JSON.parse(w.snapshot());
      assert.deepEqual(preserved[UNLINKED_MEMBERSHIP_PRODUCTS], { ip: 'p', iq: 'q' });
      delete preserved[UNLINKED_MEMBERSHIP_PRODUCTS];
      assert.deepEqual(preserved, w.benefit, 'only factual identity metadata is appended; original benefits remain exact');
      assert.deepEqual(w.raw.prepare('SELECT id,product_id FROM order_items ORDER BY id').all().map(v => ({ ...v })),
        [{ id: 'ip', product_id: null }, { id: 'iq', product_id: null }, { id: 'ir', product_id: 'r' }]);
      assert.notEqual((await profitSourceFingerprint(w.db, 'o')).value, fingerprint.value);
      assert.match(String(w.raw.prepare(`SELECT ${staffBasisFingerprintSql('?1')} value`).get('o')!.value), /^\["membership-unit-v1",/,
        'deleted products retain the affected-membership fingerprint, so recovery cannot fall back to the old calculation');
      await correctMembershipSale(w.db, 'o', w.day);
      await correctMembershipSale(w.db, 'o', w.day);
      assert.equal(w.raw.prepare("SELECT COUNT(*) n FROM accounting_entries WHERE event_key='membership-sale:o'").get()!.n, 1);
      assert.equal(w.raw.prepare("SELECT SUM(l.credit_iqd-l.debit_iqd) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.state='posted' AND l.account_code='4000'").get()!.n, 199000);
      assert.equal(JSON.stringify(w.raw.prepare("SELECT l.* FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key='sale:o' ORDER BY l.id").all()), native);
      const invoice = await createInvoiceForOrder(w.env, 'o');
      assert.ok(invoice);
      const printed = JSON.parse(String(w.raw.prepare('SELECT snapshot FROM invoices WHERE id=?').get(invoice.invoiceId)!.snapshot)) as InvoiceSnapshotV1;
      assert.equal(printed.totals.membership_discount_iqd, 1000, 'a new invoice after deletion subtracts only the original line saving');
      assert.equal(printed.totals.total_iqd, 199000);
      const saved = w.snapshot();
      assert.equal((await deleteProductPermanently(w.db, 'p')).already_deleted, true);
      assert.equal(w.snapshot(), saved, 'deletion replay does not rewrite preserved evidence');
    } finally { w.raw.close(); }
  });
}

test('preserved identity is strict own-key evidence only for a null live link, in both JavaScript and SQL', () => {
  const w = world();
  try {
    const key = 'quoted".item';
    const cases: Array<{ id: string | number; product: string | number | null; map: unknown; expected: number }> = [
      { id: key, product: null, map: { [key]: 'p' }, expected: 0 },
      { id: '__proto__', product: null, map: JSON.parse('{"__proto__":"p"}'), expected: 0 },
      { id: 'toString', product: null, map: {}, expected: 2000 },
      { id: 'ip', product: 'p', map: { ip: 'q' }, expected: 0 },
      { id: 'ip', product: 'q', map: { ip: 'p' }, expected: 2000 },
      { id: 'ip', product: '', map: { ip: 'p' }, expected: 2000 },
      { id: 'ip', product: 123, map: { ip: 'p' }, expected: 2000 },
      { id: '', product: null, map: { '': 'p' }, expected: 2000 },
      { id: 123, product: null, map: { '123': 'p' }, expected: 2000 },
      ...[null, [], { ip: 123 }, { ip: '' }, { ip: null }].map(map => ({ id: 'ip', product: null, map, expected: 2000 })),
    ];
    for (const { id, product, map, expected } of cases) {
      const benefit_snapshot = JSON.stringify({ lines: [{ product_id: 'p', rule_id: 'unit-rule', applied_at: 'unit' }],
        [UNLINKED_MEMBERSHIP_PRODUCTS]: map });
      w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(benefit_snapshot);
      const item = { id, product_id: product, membership_rule_id: 'unit-rule', membership_discount_iqd: 2000 };
      assert.equal(membershipDiscountAtLine({ benefit_snapshot }, item), expected, JSON.stringify(item));
      assert.equal(w.raw.prepare(`SELECT ${membershipDiscountAtLineSql()} value FROM
        (SELECT ? id,? product_id,'unit-rule' membership_rule_id,2000 membership_discount_iqd,'o' order_id) i`).get(id, product)!.value,
      expected, 'SQL uses a bound key, not an interpolated JSON path');
    }
  } finally { w.raw.close(); }
});

test('identity preservation rolls back with deletion, while absent or ambiguous historical evidence is unchanged', async () => {
  const w = world();
  try {
    w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(JSON.stringify({ ...w.benefit,
      [UNLINKED_MEMBERSHIP_PRODUCTS]: { ip: 'wrong-old-value', previous: 'earlier-product' } }));
    const before = w.snapshot();
    w.raw.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON products BEGIN SELECT RAISE(ABORT,'synthetic deletion failure'); END");
    await assert.rejects(deleteProductPermanently(w.db, 'p'), /synthetic deletion failure/);
    assert.equal(w.snapshot(), before);
    assert.equal(w.raw.prepare("SELECT product_id FROM order_items WHERE id='ip'").get()!.product_id, 'p');
    assert.equal(w.raw.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get(DELETED_PRODUCT_FINANCE_SCOPE_ACTION)!.n, 0,
      'scope evidence is rolled back with the failed deletion, not left as an external side effect');
    w.raw.exec('DROP TRIGGER refuse_delete');
    await deleteProductPermanently(w.db, 'p');
    assert.deepEqual(JSON.parse(w.snapshot())[UNLINKED_MEMBERSHIP_PRODUCTS], { ip: 'p', previous: 'earlier-product' },
      'the current link is authoritative; other saved identities remain intact');
    const ambiguous = JSON.stringify({ lines: [{ product_id: 'q', rule_id: 'unit-rule', applied_at: 'unit' },
      { product_id: 'q', rule_id: 'unit-rule', applied_at: 'line' }] });
    w.raw.prepare("UPDATE orders SET benefit_snapshot=? WHERE id='o'").run(ambiguous);
    await deleteProductPermanently(w.db, 'q');
    assert.equal(w.snapshot(), ambiguous, 'ambiguous evidence retains its historical reading without inventing metadata');
  } finally { w.raw.close(); }
  const old = dbThrough('0073');
  try {
    old.exec("INSERT INTO products(id,slug,name,price_iqd) VALUES ('old','old','Old',1000)");
    assert.equal((await deleteProductPermanently(asD1(old), 'old')).product_deleted, true,
      'the pre-membership schema never references absent benefit columns');
  } finally { old.close(); }
});

test('deleted wage scope captures all placements and exact cycle-safe ancestor depths at batch time', async () => {
  const w = world();
  try {
    w.raw.exec(`PRAGMA foreign_keys=OFF;
      INSERT INTO catalogs(id,parent_id,slug,name_ar) VALUES
        ('root',NULL,'root','Root'),('child','root','child','Child'),('secondary',NULL,'secondary','Secondary'),
        ('cycle-a','cycle-b','cycle-a','A'),('cycle-b','cycle-c','cycle-b','B'),('cycle-c','cycle-a','cycle-c','C'),
        ('tail','cycle-a','tail','Tail'),('orphan','missing','orphan','Orphan'),('quoted".catalog','root','quoted','Quoted');
      UPDATE products SET category_id='root',sub_category_id='child' WHERE id='p';
      INSERT INTO product_catalogs(product_id,catalog_id,position) VALUES
        ('p','secondary',1),('p','tail',1),('p','orphan',1),('p','quoted".catalog',1);`);
    const racing = {
      prepare: w.db.prepare.bind(w.db),
      batch: async <T>(statements: D1PreparedStatement[]) => {
        // A catalogue change after deletion's preliminary reads must be seen
        // by the statement that actually commits the unlink evidence.
        w.raw.exec("UPDATE catalogs SET parent_id='root' WHERE id='secondary'");
        return w.db.batch<T>(statements);
      },
    };
    const result = await deleteProductPermanently(racing, 'p');
    assert.equal(result.product_deleted, true);
    const row = w.raw.prepare('SELECT actor_id,target,detail FROM audit_log WHERE action=?').get(DELETED_PRODUCT_FINANCE_SCOPE_ACTION)!;
    assert.equal(row.actor_id, null);
    assert.equal(row.target, 'ip');
    assert.deepEqual(JSON.parse(String(row.detail)), { version: 1, product_id: 'p', catalog_depths: {
      root: 1, child: 2, secondary: 2, 'cycle-a': 3, 'cycle-b': 3, 'cycle-c': 3,
      tail: 4, orphan: 2, missing: 1, 'quoted".catalog': 2,
    } });
    assert.equal(result.rows_deleted_by_table.audit_log, undefined);
    assert.equal(result.rows_unlinked_by_table.audit_log, undefined);
    assert.equal((await deleteProductPermanently(w.db, 'p')).already_deleted, true);
    assert.equal(w.raw.prepare('SELECT COUNT(*) n FROM audit_log WHERE action=?').get(DELETED_PRODUCT_FINANCE_SCOPE_ACTION)!.n, 1);
  } finally { w.raw.close(); }
});

test('scope evidence needs no optional finance or catalogue tables on the initial schema', async () => {
  const raw = dbThrough('0001');
  try {
    raw.exec(`INSERT INTO users(id,email,name) VALUES ('buyer','buyer@example.com','Buyer');
      INSERT INTO products(id,slug,name,price_iqd) VALUES ('p','p','P',1000);
      INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,
        payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
        VALUES ('o','buyer','{}','standard','{}','cash',1000,1400,1000,1000);
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
        VALUES ('i','o','p','P',1,1000,1000);`);
    assert.equal((await deleteProductPermanently(asD1(raw), 'p')).product_deleted, true);
    assert.deepEqual(JSON.parse(String(raw.prepare('SELECT detail FROM audit_log WHERE action=?')
      .get(DELETED_PRODUCT_FINANCE_SCOPE_ACTION)!.detail)), { version: 1, product_id: 'p', catalog_depths: {} });
    assert.equal(raw.prepare("SELECT product_id FROM order_items WHERE id='i'").get()!.product_id, null);
  } finally { raw.close(); }
});
