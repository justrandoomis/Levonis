/**
 * A finance world on a fresh database, for the «المال والأرباح» tests that read the workspace router as the screens do:
 * the same Levonis order with one line and a priced FIFO lot (or no price, or the sale-time estimate) that
 * tests/financeFigures.test.ts builds, the owner as the caller, and the shop's dollar rate. Shared by the reports'
 * server tests and the figure drawer's (redesign step 4, DECISIONS row 316).
 */
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './app';
import { adminFinanceWorkspaceRoutes } from '../../worker/routes/adminFinanceWorkspace';
import { baghdadDay } from '../../worker/lib/operations';

export type Raw = ReturnType<typeof freshDb>;
export const month = () => baghdadDay().slice(0, 7);
/** The month before this one, as YYYY-MM. */
export const previousMonth = () => { const [y, m] = month().split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);
/** This month, whole. */
export const period = () => `from=${month()}-01&to=${lastDay(month())}`;

export interface O { id: string; qty?: number; unit?: number; cost?: number | null; estimate?: number; delivered?: string | null; status?: string; product?: string; shipping?: number; coupon?: number }
/** A Levonis order with one line; `cost` null = never priced, otherwise a priced FIFO lot backs it (unless it has a sale-time estimate). */
export function order(raw: Raw, o: O) {
  const qty = o.qty ?? 2, unit = o.unit ?? 25000, sub = qty * unit, ship = o.shipping ?? 5000, total = sub + ship;
  const at = o.delivered === undefined ? new Date().toISOString() : o.delivered;
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,cod_tax_iqd,points_discount_iqd,order_kind,created_at,delivered_at,coupon_discount_iqd)
    VALUES (?,'buyer',?,'{}','standard','{}','cash',?,1400,?,?,?,0,0,'normal',?,?,?)`).run(o.id, o.status ?? 'delivered', sub, total, total, ship, at ?? new Date().toISOString(), at, o.coupon ?? 0);
  const cost = o.cost === undefined ? 10000 : o.cost, product = o.product ?? 'product';
  raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,?,?,'SKU',?,?,?,?,?)`)
    .run(`${o.id}:item`, o.id, product, product, qty, unit, sub, cost, cost === null ? 'unpriced' : 'snapshot');
  if (o.estimate !== undefined) raw.prepare('UPDATE order_items SET estimated_cost_iqd=? WHERE id=?').run(o.estimate, `${o.id}:item`);
  if (cost !== null && o.estimate === undefined) {
    raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at) VALUES (?,?,'base','',?,0,?,'opening',?)`).run(`${o.id}:lot`, product, qty, cost, at ?? new Date().toISOString());
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,scope_id,qty,unit_cost_iqd,cogs_iqd,idempotency_key) VALUES (?,?,?,?,'base','',?,?,?,?)`)
      .run(`${o.id}:allocation`, o.id, `${o.id}:item`, `${o.id}:lot`, qty, cost, cost * qty, `${o.id}:allocation`);
  }
}
export function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('admin','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('product','Printer','fig-printer',25000,0,999),('magnet','Magnet','fig-magnet',500,0,NULL),('esun','eSUN','fig-esun',20000,0,NULL),('switch','Switch','fig-switch',120,0,NULL);
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('rent','fig-rent','إيجار');
    INSERT INTO admin_settings(key,value) VALUES ('exchangeRate','1400') ON CONFLICT(key) DO UPDATE SET value='1400';`);
  const db = asD1(raw);
  const app = stubApp(db, { id: 'admin', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  const read = async (path: string) => { const r = await get(app, path); const b = await json(r); assert.equal(r.status, 200, `${path}: ${JSON.stringify(b)}`); return b; };
  // The bytes as a spreadsheet reads them: Response.text() would drop the BOM the export starts with.
  const text = async (path: string) => { const r = await get(app, path); assert.equal(r.status, 200, path); return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()); };
  return { raw, db, app, read, text };
}
/** The shop's dollar rate (1,500), applied since January: every order and day of the period has one. */
export const usd = (raw: Raw) => raw.exec(`UPDATE fx_rate_pairs SET effective_rate='1500', effective_version=1, drift_anchor_rate='1500', effective_source='provider' WHERE pair='USD_IQD';
  INSERT INTO fx_rate_log(id,pair,event,trigger_kind,effective_before,effective_after,result,created_at) VALUES ('l1','USD_IQD','review_approved','owner',NULL,'1500','APPLIED','2026-01-01T00:00:00.000Z');`);

/**
 * Every way an order of a period can stand, in one world (redesign step 4): confirmed on a FIFO lot with a coupon, a
 * packing wage and a box; resting on the sale-time estimate; waiting for a purchase price, for the cost a profit-based
 * wage needs, for an investor share's projection, for a refund amount nobody recorded, and an investor share held by a
 * posting error (a line to review). This month carries rent; last month a promotion with no sales, counted on its 1st —
 * so the period from last month's 1st has both kinds of overhead. Each order has its own product, so the products and
 * sections can be told apart; two sections, one of them with English and Sorani names.
 */
export function everyState() {
  const w = world();
  usd(w.raw);
  const day = baghdadDay(), prev = previousMonth();
  w.raw.exec(`INSERT INTO products(id,name,slug,price_iqd,stock,product_cost_iqd) VALUES ('funded','Funded','fig-funded',25000,0,999),('held','Held','fig-held',25000,0,999),('returned','Returned','fig-returned',25000,0,999),('wage','Wage','fig-wage',25000,0,999);
    INSERT INTO catalogs(id,slug,name_ar,name_en,name_ckb) VALUES ('printers','fig-printers','الطابعات','Printers','چاپکەرەکان'),('parts','fig-parts','قطع','','');
    UPDATE products SET category_id='printers' WHERE id IN ('product','funded','held');
    UPDATE products SET category_id='parts' WHERE id IN ('magnet','esun');`);
  order(w.raw, { id: 'fifo', coupon: 3000 });
  order(w.raw, { id: 'est', qty: 1, unit: 20000, cost: null, estimate: 15000, product: 'esun', shipping: 0 });
  order(w.raw, { id: 'mag', qty: 60, unit: 500, cost: null, product: 'magnet', shipping: 0 });
  order(w.raw, { id: 'wage', product: 'wage' });
  order(w.raw, { id: 'inv', product: 'funded' });
  order(w.raw, { id: 'err', product: 'held' });
  order(w.raw, { id: 'ret', product: 'returned' });
  w.raw.exec(`INSERT INTO finance_order_costs(id,order_id,order_item_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot) VALUES
      ('c1','wage',NULL,'r1',1,'Packing wage','g1','staff_sajjad','rent','delivered',1,NULL,'${day}','pending_cost','{}'),
      ('c2','fifo',NULL,'r2',1,'Packing wage','g2','staff_sajjad','rent','delivered',1,7500,'${day}','approved','{}'),
      ('c3','fifo',NULL,'r3',1,'Box','g3',NULL,'rent','delivered',1,2000,'${day}','approved','{}');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('batch','funded','base','',4,4,10000);
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json,state) VALUES ('contract','batch','buyer','Funding',40000,10000,1000,1000,'admin','now','{}','active');
    UPDATE inventory_lots SET incoming_id='batch' WHERE id IN ('inv:lot','err:lot');
    INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('post:err','err','journal failed','2026-11-11T07:00:00Z');
    INSERT INTO return_cases(id,order_id,order_item_id,user_id,qty,reason,state,resolution,decided_at) VALUES ('rc1','ret','ret:item','buyer',1,'defective','resolved','refund','${day}T08:00:00Z');
    INSERT INTO finance_line_departments(order_item_id,main_catalog_id,sub_catalog_id,main_name,sub_name,captured_at,is_legacy) VALUES ('ret:item','gone','gone-sub','قسم محذوف','فرع محذوف','2026-11-01T00:00:00Z',0);
    INSERT INTO stock_return_inspections(id,order_item_id,qty,disposition,actor_id,created_at,return_case_id) VALUES ('si1','ret:item',1,'damage','admin','${day}T09:00:00Z','rc1');
    INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${day}','Rent','admin'),('promo-exp','rent',30000,'${prev}-01','Promotion','admin');
    INSERT INTO finance_monthly_promotions(id,month,title,currency,amount_minor,exchange_rate,amount_iqd,enabled,expense_id,version,created_by,created_at,updated_at) VALUES ('promo','${prev}','ترويج','IQD',30000,1,30000,1,'promo-exp',1,'admin','now','now');`);
  const from = `${prev}-01`, to = lastDay(month());
  return { ...w, range: `from=${from}&to=${to}`, from, to };
}
