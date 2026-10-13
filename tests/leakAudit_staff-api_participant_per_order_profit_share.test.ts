/**
 * LEAK AUDIT — staff-api: GET /api/finance-earnings («أرباحي») hands a
 * profit-share participant the PROFIT of each order and of each batch, and
 * with it the private cost.
 *
 * The owner's rule: anyone other than the main admin / super admin receives
 * ONLY the final price — no cost, no profit, no figure from which a cost or a
 * calculation can be derived. Owner decision 2 lets an employee on a
 * profit-share wage and an investor see their OWN SHARE; it does not let them
 * see a cost (tests/fixtures/roleMatrix.ts: "each sees their own share only,
 * never a cost").
 *
 * The path (worker/routes/financeEarnings.ts → participantOverview,
 * worker/lib/financeParticipants.ts):
 *
 *   EMPLOYEE  `entries[]` is one row per finance_order_costs row, with
 *             `order_id`, `title` (the rule name, «نسبة من الربح») and
 *             `amount_iqd` = floor(profit × pct). `movements[]` repeats the
 *             amount per order (financeAccountHistory.ts). The employee knows
 *             the percentage — it is their own wage — and reads the order's
 *             sale price as the public final price, so
 *                 profit = amount / pct       (to within 1/pct dinars)
 *                 cost   = sale price − profit
 *             The code stores the profit base (`finance_order_costs.base_iqd`)
 *             and deliberately leaves it out of the answer; the amount is that
 *             base times a constant the reader already holds.
 *
 *   INVESTOR  `investment.batches[]` (financeInvestorAccount.ts) carries
 *             `principal_iqd`, `qty_ordered`, `profit_share_bps`,
 *             `delivered_qty` and `earned_iqd` per batch. On the real funding
 *             path (worker/lib/purchaseFunding.ts) the principal is
 *             min(agreed, batch cost), so when the investor agreed to more
 *             than the batch cost the principal IS the landed batch cost
 *             (purchase + freight) and `unallocated_iqd` is the remainder;
 *             principal / qty is the landed unit cost, and
 *             earned / bps against the public price gives it a second time.
 *
 * Why the existing guards miss it: the role-matrix seed has no
 * finance_order_costs row and no funded batch, the amounts are not sentinels,
 * `amount_iqd` / `principal_iqd` / `earned_iqd` are not FINANCIAL_FIELDS, and
 * NOT_A_COST already exempts `/api/finance-earnings` `pending_costs`.
 *
 * Everything below runs through the real code: the owner's own route sets
 * the employment date, the courier delivery path (moveOrderStage) accrues the
 * wage, the real procurement document route creates the investor's contract,
 * and the participant reads through the real router. LOCAL ONLY: in-memory /
 * temp-file SQLite with every migration, no network.
 *
 * Run: node --import tsx --test tests/leakAudit_staff-api_participant_per_order_profit_share.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, freshDb, get, json, patch, post, stubApp, type StubUser } from './fixtures/app';
import { COST, leaks } from './fixtures/costlyProduct';
import { OWNER, ROLES, appFor, seededCopy } from './fixtures/roleMatrix';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import { planLotConsumption } from '../worker/lib/inventoryLots';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import type { Env } from '../worker/lib/types';

type AnyApp = Parameters<typeof get>[0];

/**
 * The shared walk, less the one key it flags here that is not a cost: the
 * `pending_cost` / `pending_costs` COUNT of the caller's own wage rows still
 * waiting for an amount (NOT_A_COST in tests/fixtures/roleMatrix.ts exempts
 * the summary one for the same reason).
 */
const scan = (body: unknown, numbers: number[] = []) =>
  leaks(body, { numbers }).filter((f) => !/\.pending_costs? = \d+$/.test(f));

/** The employee's own wage term, as the role-matrix seed writes it: rule_rm, profit_percent, 1000 bps. */
const OWN_PCT_BPS = 1000;

/**
 * Two delivered orders of the costly product, each at its public final price,
 * each with a DIFFERENT private FIFO cost (two sentinels of costlyProduct.ts),
 * so a per-order derivation is told apart from the summary total.
 */
const ORDERS = [
  { id: 'ord_emp1', cogs: COST.orderCogs },
  { id: 'ord_emp2', cogs: COST.lotPurchase },
] as const;

test('an employee on a profit-percent wage cannot recover any order’s private cost from GET /api/finance-earnings', async () => {
  const raw = seededCopy();
  const env = { DB: asD1(raw) } as Env;

  // The owner dates the role-matrix employee's employment through the owner's own route.
  const owner = appFor(raw, OWNER) as unknown as AnyApp;
  const dated = await patch(owner, '/api/admin/finance-people/staff/staff_rm', { start_work_date: '2026-09-01' });
  assert.equal(dated.status, 200, JSON.stringify(await json(dated)));

  // The public final price — what every visitor, the employee included, may read.
  const employee = appFor(raw, ROLES.employee) as unknown as AnyApp;
  const productRes = await get(employee, '/api/products/a1');
  assert.equal(productRes.status, 200);
  const productBody = await json(productRes);
  const salePrice = Number((productBody.product ?? productBody).price_iqd);
  assert.equal(salePrice, 900_000, 'the public final price the orders below were sold at');

  // Two ordinary orders of that product, picked from lot1 at a private FIFO cost, delivered by the courier path.
  for (const o of ORDERS) {
    raw.exec(`
      INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,delivery_method_snapshot,
                         payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at)
        VALUES ('${o.id}','u1','shipped','out_for_delivery','direct','{}','standard','{}','cash',${salePrice},1500,${salePrice},${salePrice},0,'2026-09-21T10:00:00Z');
      INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
        VALUES ('oi_${o.id}','${o.id}','p_a1','Bambu Lab A1',1,${salePrice},${salePrice},${o.cogs},'snapshot');
      INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
        VALUES ('oa_${o.id}','${o.id}','oi_${o.id}','lot1','base',1,${o.cogs},${o.cogs},'audit-${o.id}');
    `);
    const deferred: Promise<unknown>[] = [];
    const moved = await moveOrderStage(env, {
      orderId: o.id, to: 'delivered', source: 'delivery_api', now: '2026-09-25T10:00:00Z',
      defer: (work: Promise<unknown>) => { deferred.push(work); },
    });
    assert.equal(moved.moved, true, JSON.stringify(moved));
    await Promise.all(deferred);
  }
  // The path is exercised: the real writer accrued one profit-percent wage per order.
  const accrued = all<{ order_id: string; amount_iqd: number }>(raw,
    "SELECT order_id,amount_iqd FROM finance_order_costs WHERE staff_id='staff_rm' AND order_id LIKE 'ord_emp%' ORDER BY order_id");
  assert.equal(accrued.length, ORDERS.length, `one wage row per delivered order: ${JSON.stringify(accrued)}`);

  // What the employee receives.
  const res = await get(employee, '/api/finance-earnings');
  assert.equal(res.status, 200);
  const body = await json(res);
  const scanner = scan(body);

  const derivations: string[] = [];
  const perOrder = new Map<string, number>();
  for (const e of (body.entries ?? []) as Array<{ order_id: string | null; amount_iqd: number; title: string }>) {
    if (e.order_id) perOrder.set(e.order_id, e.amount_iqd);
  }
  for (const o of ORDERS) {
    const amount = perOrder.get(o.id);
    if (amount === undefined) continue;
    // amount = floor(profit × bps / 10000)  ⇒  profit ∈ [amount·k, amount·k + k − 1], k = 10000 / bps.
    const k = 10_000 / OWN_PCT_BPS;
    const profitLow = amount * k, profitHigh = amount * k + (k - 1);
    const costLow = salePrice - profitHigh, costHigh = salePrice - profitLow;
    if (o.cogs >= costLow && o.cogs <= costHigh) {
      derivations.push(
        `entries[order_id=${o.id}] title «${(body.entries as Array<{ order_id: string; title: string }>).find((x) => x.order_id === o.id)!.title}» amount_iqd ${amount}` +
        ` at the employee's own ${OWN_PCT_BPS / 100}% → profit ${profitLow}..${profitHigh}` +
        ` → private cost ${costLow}..${costHigh} (true FIFO cost ${o.cogs})`,
      );
    }
  }
  assert.deepEqual(
    derivations,
    [],
    `usr_emp (employee, profit-percent wage) recovers each order's private cost from GET /api/finance-earnings ` +
      `plus the public final price ${salePrice}:\n  ${derivations.join('\n  ')}\n` +
      `(the shared leak scanner flags ${scanner.length} cost finding(s) on this body${scanner.length ? `: ${JSON.stringify(scanner)}` : ' — it cannot see this'})`,
  );
});

/**
 * Kept, failing, as `todo` (DECISIONS row 219): an investor's own account IS
 * the batch's money — the principal the purchase drew from their capital
 * (min(agreed, landed batch cost)), the remainder returned to them, the capital
 * recovered per unit sold, and their profit share per unit — so any figure
 * that lets them check and withdraw what is theirs also spells the landed
 * cost. Hiding it means changing what the investor can see of their own money
 * (or funding batches at the agreed amount, not at cost): the owner decides.
 */
test('an investor cannot read the landed batch cost from GET /api/finance-earnings', {
  todo: 'OWNER RULING NEEDED (DECISIONS row 219): the investor’s own principal, unallocated remainder, recovered capital and per-unit share are the landed batch cost by construction',
}, async () => {
  // The real funding path, as tests/fundedProcurement.test.ts drives it: an
  // investor profile (an assistant admin, which eligibleInvestorProfile
  // requires), a purchase document whose funding agreement exceeds the batch
  // cost, receiving, and one delivered sale at the public price.
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users(id,email,name,role,admin_scope) VALUES
      ('owner','boss@x.co','Owner','admin','full'),
      ('investor','investor@x.co','Investor','admin','assistant'),
      ('customer','customer@x.co','Customer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode)
      VALUES ('a1','Bambu Lab A1','audit-funded-a1',965000,NULL,0,'OPTION');
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('model','a1','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES ('combo','a1','model','Combo',0);
  `);
  const db = asD1(raw);
  const ownerUser: StubUser = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' };
  const owner = stubApp(db, ownerUser, (a) => {
    a.route('/p', adminProcurementRoutes);
    a.route('/i', adminInvestmentFinanceRoutes);
  });

  // Private: 5 units at 2,500,000 purchase + 500,000 freight = 3,000,000 landed, 600,000 a unit.
  const PRIVATE = { purchaseTotal: 2_500_000, freight: 500_000, landedTotal: 3_000_000, landedUnit: 600_000, purchaseUnit: 500_000 };
  const AGREED = 3_250_000; // what the investor agreed and paid — more than the batch costs
  const SALE_PRICE = 965_000; // the public final price
  const BPS = 3500;

  const profile = await post(owner, '/i/profiles', { user_id: 'investor', default_profit_share_bps: BPS, default_loss_share_bps: 0 });
  assert.equal(profile.status, 200, JSON.stringify(await json(profile)));
  const created = await post(owner, '/p/documents', {
    operation_id: crypto.randomUUID(), currency: 'IQD', purchase_day: baghdadDay(), status: 'ordered', cost_state: 'final',
    lines: [{ product_id: 'a1', scope: 'option', scope_id: 'combo', qty_ordered: 5, purchase_cost_mode: 'total',
      source_total_amount: PRIVATE.purchaseTotal, selling_price_iqd: SALE_PRICE }],
    charges: [{ title: 'شحن إلى المخزن', amount_iqd: PRIVATE.freight, basis: 'quantity' }],
    funding: { mode: 'investor', user_id: 'investor', agreed_iqd: AGREED, received_iqd: AGREED, reference: 'INVESTOR-CASH',
      profit_share_bps: BPS, loss_share_bps: 0 },
  });
  const doc = await json(created);
  assert.equal(created.status, 200, JSON.stringify(doc));
  const detail = await json(await get(owner, `/p/documents/${doc.id}`));
  const received = await post(owner, `/p/documents/${doc.id}/receive`, {
    operation_id: crypto.randomUUID(),
    lines: detail.lines.map((l: { line_id: string; qty_ordered: number; qty_received: number }) => ({ line_id: l.line_id, qty: l.qty_ordered - l.qty_received })),
  });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));

  // One delivered, collected sale at the public price.
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
    subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
    VALUES ('sold1','customer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(SALE_PRICE, SALE_PRICE, SALE_PRICE, now, now);
  raw.prepare(`INSERT INTO order_items(id,order_id,product_id,option_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
    VALUES ('item:sold1','sold1','a1','combo','A1 Combo',1,?,?)`).run(SALE_PRICE, SALE_PRICE);
  const plan = await planLotConsumption(db, 'sold1', [{ product_id: 'a1', line_id: 'item:sold1', qty: 1,
    targets: [{ scope: 'option', scope_id: 'combo', stock: 5, reserved: 0, low_stock_threshold: 0, label: 'Combo' }] }]);
  await db.batch(plan.statements);
  raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('cash:sold1','sold1','customer',?,?,'owner',?)")
    .run(SALE_PRICE, baghdadDay(), now);
  await runOrderFinancialEffects({ DB: db } as Env, 'sold1', 'delivered');

  // What the investor receives.
  const investorUser: StubUser = { id: 'investor', email: 'investor@x.co', role: 'admin', admin_scope: 'assistant' };
  const investor = stubApp(db, investorUser, (a) => a.route('/api/finance-earnings', financeEarningsRoutes));
  const res = await get(investor, '/api/finance-earnings');
  assert.equal(res.status, 200);
  const body = await json(res);
  const batches = (body.investment?.batches ?? []) as Array<Record<string, number>>;
  assert.ok(batches.length >= 1, `the path is exercised: the investor's funded batch is listed (${JSON.stringify(body.investment)})`);

  const found: string[] = [...scan(body, Object.values(PRIVATE))];
  for (const b of batches) {
    if (b.qty_ordered > 0 && b.principal_iqd / b.qty_ordered === PRIVATE.landedUnit) {
      found.push(`batches[${b.id}].principal_iqd ${b.principal_iqd} / qty_ordered ${b.qty_ordered} = landed unit cost ${PRIVATE.landedUnit}`);
    }
    if (b.delivered_qty > 0 && b.earned_iqd > 0) {
      const profitPerUnit = (b.earned_iqd * 10_000) / b.profit_share_bps / b.delivered_qty;
      if (Math.abs(SALE_PRICE - profitPerUnit - PRIVATE.landedUnit) < 1) {
        found.push(`batches[${b.id}].earned_iqd ${b.earned_iqd} / ${b.profit_share_bps} bps / delivered_qty ${b.delivered_qty} = profit ${profitPerUnit} a unit → public price ${SALE_PRICE} − profit = landed unit cost ${PRIVATE.landedUnit}`);
      }
    }
  }
  if (body.investment?.unallocated_iqd === AGREED - PRIVATE.landedTotal) {
    found.push(`investment.unallocated_iqd ${body.investment.unallocated_iqd} = agreed ${AGREED} − landed batch cost ${PRIVATE.landedTotal}`);
  }
  assert.deepEqual(found, [], `the investor reads the private landed batch cost from GET /api/finance-earnings:\n  ${found.join('\n  ')}`);
});
