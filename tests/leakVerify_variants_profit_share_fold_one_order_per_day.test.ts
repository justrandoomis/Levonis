/**
 * VARIANT VERIFY (DECISIONS row 219 port, fix/leak-port 5e6f581c) — #33
 * "staff-api per-order profit share", fixed by folding the employee's
 * profit-percent wage rows «per day and rule without order ids»
 * (worker/lib/financeParticipants.ts `participantEntries`).
 *
 * The fold removes the ORDER ID, not the per-order amount. The folded row is
 * keyed by the delivery day, so:
 *
 *   A. ONE ORDER ON A DAY — the ordinary case for a small shop — folds into a
 *      row that IS that order's wage: floor(profit × pct). The employee knows
 *      their own percentage (it is their wage) and which job they prepared that
 *      day; the product's price is public. cost = price − amount / pct. The
 *      audit test (tests/leakAudit_staff-api_participant_per_order_profit_share)
 *      delivers both of its orders on the SAME day and only looks for rows
 *      that carry an `order_id`, so it passes while the derivation below works.
 *   B. TWO ORDERS ON ONE DAY — the employee reads «أرباحي» after the first
 *      delivery and again after the second: the day row grows by exactly the
 *      second order's wage (and the summary total by the same amount). Polling
 *      un-folds any day.
 *
 * Same path as the audit test: the owner's own route dates the employment,
 * the courier delivery path (moveOrderStage) accrues the wage, the employee
 * reads GET /api/finance-earnings through the real router. Every order is
 * sold at the costly product's public price with a DIFFERENT private FIFO
 * cost (costlyProduct.ts sentinels), so a match is that order's cost.
 *
 * A is FIXED (DECISIONS row 219, verification pass): the participant's own
 * profit-percent rows fold into ONE running line per rule and state (no day
 * of their own, no order id), so a single read never isolates one order. B
 * is pinned for the owner (below).
 *
 * LOCAL ONLY: role-matrix SQLite copy, no network.
 * Run: node --import tsx --test tests/leakVerify_variants_profit_share_fold_one_order_per_day.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, patch } from './fixtures/app';
import { COST } from './fixtures/costlyProduct';
import { OWNER, ROLES, appFor, seededCopy } from './fixtures/roleMatrix';
import { moveOrderStage } from '../worker/lib/orderStageOps';
import type { Env } from '../worker/lib/types';

type AnyApp = Parameters<typeof get>[0];

/** The employee's own wage term, as the role-matrix seed writes it: rule_rm, profit_percent, 1000 bps. */
const OWN_PCT_BPS = 1000;
const K = 10_000 / OWN_PCT_BPS;

async function world() {
  const raw = seededCopy();
  const env = { DB: asD1(raw) } as Env;
  const owner = appFor(raw, OWNER) as unknown as AnyApp;
  const dated = await patch(owner, '/api/admin/finance-people/staff/staff_rm', { start_work_date: '2026-09-01' });
  assert.equal(dated.status, 200, JSON.stringify(await json(dated)));
  const employee = appFor(raw, ROLES.employee) as unknown as AnyApp;
  const productBody = await json(await get(employee, '/api/products/a1'));
  const salePrice = Number((productBody.product ?? productBody).price_iqd);
  assert.equal(salePrice, 900_000, 'the public final price');
  return { raw, env, employee, salePrice };
}

async function deliver(raw: DatabaseSync, env: Env, salePrice: number, o: { id: string; cogs: number; deliveredAt: string }) {
  raw.exec(`
    INSERT INTO orders(id,user_id,status,stage,shipping_type,address_snapshot,delivery_method_id,delivery_method_snapshot,
                       payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at)
      VALUES ('${o.id}','u1','shipped','out_for_delivery','direct','{}','standard','{}','cash',${salePrice},1500,${salePrice},${salePrice},0,'2026-09-21T10:00:00Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES ('oi_${o.id}','${o.id}','p_a1','Bambu Lab A1',1,${salePrice},${salePrice},${o.cogs},'snapshot');
    INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES ('oa_${o.id}','${o.id}','oi_${o.id}','lot1','base',1,${o.cogs},${o.cogs},'verify-${o.id}');
  `);
  const deferred: Promise<unknown>[] = [];
  const moved = await moveOrderStage(env, {
    orderId: o.id, to: 'delivered', source: 'delivery_api', now: o.deliveredAt,
    defer: (work: Promise<unknown>) => { deferred.push(work); },
  });
  assert.equal(moved.moved, true, JSON.stringify(moved));
  await Promise.all(deferred);
}

type Entry = { id: string; order_id: string | null; amount_iqd: number; day?: string; title: string };

/** The cost range a wage amount pins: amount = floor(profit × pct). */
function costFrom(amount: number, salePrice: number) {
  const profitLow = amount * K, profitHigh = amount * K + (K - 1);
  return { low: salePrice - profitHigh, high: salePrice - profitLow };
}

test('A: a day with one delivered order folds into a row that IS that order’s wage — the employee recovers its private cost', async () => {
  const { raw, env, employee, salePrice } = await world();
  const ORDERS = [
    { id: 'ord_v1', cogs: COST.orderCogs, deliveredAt: '2026-09-25T10:00:00Z' },
    { id: 'ord_v2', cogs: COST.lotPurchase, deliveredAt: '2026-09-26T10:00:00Z' },
  ];
  for (const o of ORDERS) await deliver(raw, env, salePrice, o);

  const body = await json(await get(employee, '/api/finance-earnings'));
  const entries = (body.entries ?? []) as Entry[];
  // The port's fix is in place: no row names an order.
  assert.ok(entries.every((e) => !e.order_id), `a row still names an order: ${JSON.stringify(entries)}`);

  const derived: string[] = [];
  for (const o of ORDERS) {
    const day = o.deliveredAt.slice(0, 10);
    const row = entries.find((e) => String(e.day ?? e.id).includes(day));
    if (!row) continue;
    const c = costFrom(row.amount_iqd, salePrice);
    if (o.cogs >= c.low && o.cogs <= c.high) {
      derived.push(`folded row ${row.id} («${row.title}», day ${day}) amount ${row.amount_iqd} → cost ${c.low}..${c.high} = the private FIFO cost ${o.cogs} of the one order delivered that day (${o.id})`);
    }
  }
  assert.deepEqual(derived, [], `usr_emp recovers per-order private costs from the folded «أرباحي» rows:\n  ${derived.join('\n  ')}`);
});

/**
 * Kept, failing, as `todo` — the owner rules. A share of profit paid as it is
 * earned shows its holder each order's share the moment it lands: any figure
 * the employee can read before and after one delivery (the running line, the
 * summary, the withdrawable balance) differs by that order's wage. Only a
 * different wage basis, or profit-share earnings that show (and can be
 * withdrawn) only when a period closes, ends it — a change to when the
 * employee is paid, which is the owner's to make.
 */
const OWNER_RULING =
  'OWNER RULING NEEDED (DECISIONS row 219): a profit-percent wage paid as it is earned shows each delivery’s share to the employee who reads their balance before and after it; only a different basis or period-end visibility closes it';

test('B: two orders on one day — reading «أرباحي» before and after the second delivery un-folds it', { todo: OWNER_RULING }, async () => {
  const { raw, env, employee, salePrice } = await world();
  const first = { id: 'ord_v3', cogs: COST.orderCogs, deliveredAt: '2026-09-27T09:00:00Z' };
  const second = { id: 'ord_v4', cogs: COST.lotPurchase, deliveredAt: '2026-09-27T15:00:00Z' };
  await deliver(raw, env, salePrice, first);
  const before = await json(await get(employee, '/api/finance-earnings'));
  await deliver(raw, env, salePrice, second);
  const after = await json(await get(employee, '/api/finance-earnings'));

  const dayRow = (b: Record<string, unknown>) => ((b.entries ?? []) as Entry[]).find((e) => String(e.day ?? e.id).includes('2026-09-27'));
  const r0 = dayRow(before), r1 = dayRow(after);
  assert.ok(r0 && r1, `the day row exists before and after: ${JSON.stringify([before.entries, after.entries])}`);
  assert.ok(!r1!.order_id, 'the folded row names no order');
  const delta = r1!.amount_iqd - r0!.amount_iqd;
  const c = costFrom(delta, salePrice);
  const derived = second.cogs >= c.low && second.cogs <= c.high
    ? [`day row grew ${r0!.amount_iqd} → ${r1!.amount_iqd} (Δ ${delta}) → cost ${c.low}..${c.high} = the private FIFO cost ${second.cogs} of ${second.id}`]
    : [];
  assert.deepEqual(derived, [], `usr_emp un-folds a day by polling «أرباحي»:\n  ${derived.join('\n  ')}`);
});
