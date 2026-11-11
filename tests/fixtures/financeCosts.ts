/**
 * Every way an expense can count, in one invented world (redesign step 5, DECISIONS row 317) — for the server's
 * tests/financeCostsServer.test.ts and the pages' tests/financeCostsPages.test.ts. Today, in the shop's month:
 * rent and a power bill (general), a generator tagged only to a cost centre (general, with its tag), a voided rent,
 * the month's promotion, an order's packing wage, a courier's fee, and costs linked to a delivered order, to one on
 * its way and to a cancelled one. General: 100,000 + 30,000 + 7,000 + 20,000 = 157,000; waiting: 9,000.
 */
import { month, order, world } from './financeWorld';
import { baghdadDay } from '../../worker/lib/operations';

export function expenseWorld() {
  const w = world();
  const day = baghdadDay(), m = month();
  order(w.raw, { id: 'shipped' });
  order(w.raw, { id: 'onway', status: 'confirmed', delivered: null });
  order(w.raw, { id: 'gone', status: 'cancelled' });
  w.raw.exec(`INSERT INTO expense_categories(id,slug,name_ar,name_en,name_ckb) VALUES ('power','fig-power','كهرباء','Power','کارەبا');
    INSERT INTO finance_cost_centers(id,name) VALUES ('shop','Shop floor');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by,voided_at,voided_by,void_reason) VALUES
      ('rent','rent',100000,'${day}','Rent','admin',NULL,NULL,''),
      ('power','power',30000,'${day}','Power bill','admin',NULL,NULL,''),
      ('centre','power',7000,'${day}','Generator, shop floor','admin',NULL,NULL,''),
      ('void','rent',55555,'${day}','Mistyped rent','admin','2026-01-01T00:00:00Z','admin','typo'),
      ('promo-exp','rent',240000,'${m}-01','Promotion','admin',NULL,NULL,''),
      ('wage-exp','rent',7500,'${day}','Packing wage','admin',NULL,NULL,''),
      ('fee-exp','rent',3000,'${day}','Courier fee','admin',NULL,NULL,''),
      ('to-shipped','rent',2000,'${day}','Gift wrap','admin',NULL,NULL,''),
      ('to-onway','rent',9000,'${day}','Prepaid customs','admin',NULL,NULL,''),
      ('to-gone','rent',20000,'${day}','Special packing','admin',NULL,NULL,'');
    INSERT INTO finance_monthly_promotions(id,month,title,currency,amount_minor,exchange_rate,amount_iqd,enabled,expense_id,version,created_by,created_at,updated_at) VALUES ('promo','${m}','ترويج','IQD',240000,1,240000,1,'promo-exp',1,'admin','now','now');
    INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,expense_id,snapshot) VALUES ('c1','shipped',NULL,'r1',1,'Packing wage','g1','staff_sajjad','rent','delivered',1,7500,'${day}','approved','wage-exp','{}');
    INSERT INTO finance_collections(id,order_id,payer,amount_iqd,fee_iqd,collection_day,reference,actor_id,created_at,expense_id) VALUES ('col1','shipped','courier',52000,3000,'${day}','','admin','now','fee-exp');
    INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('to-shipped','shipped'),('to-onway','onway'),('to-gone','gone');
    INSERT INTO finance_expense_links(expense_id,center_id) VALUES ('centre','shop');`);
  return w;
}
