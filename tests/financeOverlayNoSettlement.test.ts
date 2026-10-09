/**
 * THE COUPON AND PRICE-PROTECTION DEDUCTIONS NEVER REACH A SETTLEMENT
 * (design P-A §7.2 F4/F5, integrity H3; owner question Q3, default "report
 * only").
 *
 * Fixing the coupon and the price-protection credit inside the profit base
 * would re-split investor shares and re-post wages and journals for orders
 * already settled. So they are a REPORT-ONLY overlay: applied by
 * worker/routes/adminFinanceWorkspace.ts to the answers it returns, and seen by
 * nothing that settles money. This file proves it three ways:
 *   1. two orders identical but for a coupon and a credited claim have the
 *      same profit base — the basis every writer reads;
 *   2. reading the workspace (summary, list, detail) and reconciling the order
 *      leave investor results, order costs, workspace postings, journals and
 *      the order, line, wallet and claim rows byte-identical;
 *   3. only the workspace route imports the overlay module.
 *
 * Run: node --import tsx --test tests/financeOverlayNoSettlement.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { getOrderProfitBase, getOrderProfitBases, syncOrderWorkspaceAccounting } from '../worker/lib/orderProfit';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';

function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('boss','boss@x.co','Owner','admin','full'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','overlay-printer',100000,60000);`);
  const order = (id: string, coupon: number | null) => {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at,coupon_snapshot)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',200000,1400,195000,195000,5000,'2026-03-04T09:00:00.000Z','2026-03-05T10:00:00.000Z',?)`)
      .run(id, coupon ? JSON.stringify({ code: 'SAVE', discount_iqd: coupon }) : null);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'p','Printer',2,100000,200000,60000,'snapshot')`).run(`${id}:1`, id);
  };
  order('plain', null);
  order('overlay', 10000);
  raw.exec(`INSERT INTO price_protection_claims(id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
    VALUES ('ppc','buyer','overlay','overlay:1',100000,96000,2,8000,'credited')`);
  const app = stubApp(asD1(raw), { id: 'boss', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  return { raw, db: asD1(raw), app };
}

const SETTLED_TABLES = ['investor_allocation_results', 'finance_order_costs', 'finance_workspace_postings', 'finance_order_adjustments',
  'finance_order_versions', 'accounting_entries', 'accounting_lines', 'orders', 'order_items', 'wallet_transactions', 'price_protection_claims'];
function snapshot(raw: ReturnType<typeof freshDb>): string {
  const present = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name));
  return JSON.stringify(SETTLED_TABLES.filter((t) => present.has(t)).map((t) => [t, raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
}
const strip = (v: unknown, id: string): unknown => JSON.parse(JSON.stringify(v).split(id).join('ORDER'));

test('the profit base every writer reads is the same with and without a coupon and a credited claim', async () => {
  const { db } = world();
  const [plain, overlay] = await getOrderProfitBases(db, ['plain', 'overlay']).then((b) => [b.find((x) => x.order_id === 'plain')!, b.find((x) => x.order_id === 'overlay')!]);
  const comparable = (b: typeof plain, id: string) => {
    const copy = strip(b, id) as { order: Record<string, unknown> };
    delete copy.order.coupon_snapshot;
    // The two orders are inserted a moment apart; the row's own clock is not part of the profit base.
    delete copy.order.updated_at;
    return copy;
  };
  assert.deepEqual(comparable(overlay, 'overlay'), comparable(plain, 'plain'));
  assert.equal(overlay.totals.net_goods_iqd, 200000, 'calculateGoods still ignores the order-level coupon');
  assert.equal(JSON.stringify(overlay).includes('price_protection'), false);
  assert.equal(JSON.stringify(overlay).includes('coupon_iqd'), false);
});

test('reading the workspace and reconciling write nothing new: investor results, costs, postings, journals and order rows are byte-identical', async () => {
  const { raw, db, app } = world();
  await syncOrderWorkspaceAccounting(db, 'overlay');
  await reconcileFinanceOrder(db, 'overlay', { day: '2026-03-06' });
  const before = snapshot(raw);
  const baseBefore = JSON.stringify(await getOrderProfitBase(db, 'overlay'));

  for (const path of ['/f/summary?from=2026-03-01&to=2026-03-31', '/f/orders?from=2026-03-01&to=2026-03-31', '/f/orders/overlay']) {
    const res = await get(app, path);
    assert.equal(res.status, 200, path);
    const body = await json(res);
    const text = JSON.stringify(body);
    assert.match(text, /"price_protection_iqd":8000/, `${path} shows the deduction`);
  }
  await syncOrderWorkspaceAccounting(db, 'overlay');
  await reconcileFinanceOrder(db, 'overlay', { day: '2026-03-06' });

  assert.equal(snapshot(raw), before, 'no settled row moved');
  assert.equal(JSON.stringify(await getOrderProfitBase(db, 'overlay')), baseBefore, 'the profit base is unchanged');
});

test('only the workspace route imports the overlay; no settlement module names it', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(join(ROOT, 'worker'));
  const importers = files.filter((f) => /from\s+['"][^'"]*financeReportOverlay['"]/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(importers, ['worker/routes/adminFinanceWorkspace.ts']);
  for (const f of ['worker/lib/orderProfit.ts', 'worker/lib/investorFinance.ts', 'worker/lib/financeWageCalculation.ts', 'worker/lib/financeParticipants.ts', 'worker/lib/orderFinance.ts', 'worker/lib/financeReconcile.ts']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /price_protection_claims|financeReportOverlay|reportAdjustments/, `${f} must not see the report-only deductions`);
  }
});
