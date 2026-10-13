/**
 * LEAK AUDIT — candidate `lot-count-cost-existence-oracle`
 * (channel: logs-errors / refusal bodies and response flags on the op stock routes).
 *
 * THE CLAIM. An assistant admin holds the `count` operations capability by
 * default (a missing ops_permissions row allows it, worker/lib/operations.ts).
 * Two `op` routes (tests/routeClass/stock.ts) answer them with facts that come
 * only from the owner's private cost and investor data:
 *
 *   - POST /api/admin/stock-operations/lot-counts answers
 *     `unknown_cost: lot.effective === null` (adminStockOperations.ts:711),
 *     where `effective` is the lot's private unit cost (latest cost version,
 *     else inventory_lots.unit_cost_iqd). For a positive count on a lot whose
 *     purchase has an active investment contract it computes
 *     trunc(-delta * cost * loss_share_bps / 10000) and, when that exceeds the
 *     recorded losses, refuses with «لا توجد خسارة موثقة تكفي لتصحيح رأس مال
 *     المستثمر» (:703) — a refusal that exists only when the lot is
 *     investor-funded (owner-only, "تمويل المستثمرين للأدمن الرئيسي فقط"), has a
 *     loss share, AND has a cost above zero.
 *   - POST /api/admin/stock-operations/counts/:id/post answers
 *     `unknown_cost_lines` (:329): how many of the FIFO lots it consumed carry
 *     no cost.
 *
 * Both are booleans / counts / fixed text, so `leaks()` (numeric sentinels,
 * cost-named numeric keys) does not flag the lot-count answer, and the role
 * matrix never walks the count post's success answer (`noBody` in
 * tests/routeClass/stock.ts).
 *
 * WHAT THIS TEST RUNS — locally, on throwaway copies of the role-matrix
 * database (tests/fixtures/roleMatrix.ts), no network, no live host. The SAME
 * request from the SAME assistant (ROLES.assistant) against databases that
 * differ ONLY in the owner's private data:
 *
 *   priced              lot cost = COST.lotUnit, no investment contract
 *   unpriced            lot cost = NULL,         no investment contract
 *   investorPriced      lot cost = COST.lotUnit, active contract with loss share
 *   investorUnpriced    lot cost = NULL,         active contract with loss share
 *
 * The owner's rule: a non-owner gets nothing about cost or how a figure was
 * computed. So the assistant's answer must be the same in every world; any
 * difference is a private fact reaching them. Positive controls prove each
 * request ran the real code path (the count rows exist where it succeeded,
 * nothing was written where it refused).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { count } from './fixtures/app';
import { COST } from './fixtures/costlyProduct';
import { OWNER, ROLES, appFor, call, leaks, seededCopy, type MountSpec, type Router } from './fixtures/roleMatrix';

const PREFIX = '/api/admin/stock-operations';
const MOUNTS: readonly MountSpec[] = [[PREFIX, adminStockOperationsRoutes as Router]];
const ASSISTANT = ROLES.assistant!;

type World = 'priced' | 'unpriced' | 'investorPriced' | 'investorUnpriced';

/**
 * One received purchase `inc_audit` and its lot `lot_audit` of the costly
 * product: 3 received, 1 left on the shelf (so a count may go UP to 3 — the
 * origin limit is qty_received minus transfers and open allocations). The lot
 * is the oldest FIFO layer of p_a1, so a count session that takes one unit
 * consumes it first. Only the lot's cost and the contract change between
 * worlds (the purchase row itself is the same in all four).
 */
function world(kind: World): DatabaseSync {
  const raw = seededCopy();
  const priced = kind === 'priced' || kind === 'investorPriced';
  const cost = priced ? String(COST.lotUnit) : 'NULL';
  const total = priced ? String(COST.lotUnit * 3) : 'NULL';
  raw.exec(`
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,
                                    shipping_total_iqd,internal_delivery_total_iqd,status)
      VALUES ('inc_audit','p_a1','base','',3,3,${COST.incomingUnit},0,0,'received');
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,
                                shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,incoming_id)
      VALUES ('lot_audit','p_a1','base','',3,1,${cost},${cost},0,0,${total},
              '${priced ? 'received' : 'opening_unpriced'}','2026-08-01T09:00:00Z','inc_audit');
  `);
  if (kind === 'investorPriced' || kind === 'investorUnpriced') {
    raw.exec(`
      INSERT INTO investment_contracts (id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,
                                        loss_share_bps,created_by,created_at,request_json)
        VALUES ('ic_audit','inc_audit','usr_inv','Audit contract',1000000,10000,3500,10000,'usr_owner',
                '2026-09-01T00:00:00.000Z','{}');
    `);
  }
  return raw;
}

/**
 * A lot count by `who` (the assistant unless named): `counted` units on a shelf
 * that said one — 2 finds a unit (delta +1), 0 loses one (delta −1).
 */
async function lotCount(raw: DatabaseSync, counted = 2, who = ASSISTANT) {
  const res = await call(appFor(raw, who, MOUNTS), 'POST', `${PREFIX}/lot-counts`, {
    operation_id: 'audit-lot-count-0001',
    lot_id: 'lot_audit',
    counted_qty: counted,
  });
  return { status: res.status, body: res.body };
}

/** The assistant's count session: one unit fewer than the shelf says, then posted. */
async function countSession(raw: DatabaseSync) {
  const app = appFor(raw, ASSISTANT, MOUNTS);
  const stock = count(raw, "SELECT stock n FROM products WHERE id='p_a1'");
  const open = await call(app, 'POST', `${PREFIX}/counts`, {
    operation_id: 'audit-count-0001',
    name: 'جرد التدقيق',
    lines: [{ product_id: 'p_a1', scope: 'base', scope_id: '', counted_qty: stock - 1 }],
  });
  assert.equal(open.status, 200, `the assistant opens a count session: ${JSON.stringify(open.body)}`);
  const id = (open.body as { id: string }).id;
  const posted = await call(app, 'POST', `${PREFIX}/counts/${id}/post`, {});
  return { status: posted.status, body: posted.body };
}

test('lot count: the assistant\'s answer does not depend on whether the lot\'s private cost is recorded', async () => {
  const pricedDb = world('priced'),
    unpricedDb = world('unpriced');
  // A count that LOSES a unit (an upward count is the owner's alone — the next test).
  const priced = await lotCount(pricedDb, 0),
    unpriced = await lotCount(unpricedDb, 0);

  // Positive controls: the real route ran and wrote the count in both worlds.
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  assert.equal(unpriced.status, 200, JSON.stringify(unpriced.body));
  for (const raw of [pricedDb, unpricedDb]) {
    assert.equal(count(raw, "SELECT COUNT(*) n FROM lot_count_events WHERE id='audit-lot-count-0001'"), 1);
    assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_audit'"), 0);
  }
  // The priced world posted a valuation journal (the cost WAS used) — the unpriced one did not.
  assert.ok(count(pricedDb, "SELECT COUNT(*) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.source_type='lot-count'") > 0);

  // The scanner sees nothing: no sentinel number, no cost-named number.
  assert.deepEqual(leaks(priced.body), []);
  assert.deepEqual(leaks(unpriced.body), []);

  // THE CHECK: same caller, same request, worlds differing only in the
  // owner's private cost — the answer must be identical.
  assert.deepEqual(
    unpriced,
    priced,
    'LEAK: POST /lot-counts tells an assistant whether the lot has a recorded private cost ' +
      `(priced → ${JSON.stringify(priced.body)}, unpriced → ${JSON.stringify(unpriced.body)})`,
  );
});

test('lot count: the assistant\'s answer does not reveal that a lot is investor-funded with a cost above zero', async () => {
  const plainDb = world('priced'),
    investorDb = world('investorPriced'),
    investorUnpricedDb = world('investorUnpriced');
  // UP: one unit found. Only the owner posts an upward count (DECISIONS row
  // 219, LOT_COUNT_UP_OWNER_ONLY) — every other counter hears one refusal,
  // decided before the lot's cost or funding is read, and nothing is written.
  const plain = await lotCount(plainDb),
    investor = await lotCount(investorDb),
    investorUnpriced = await lotCount(investorUnpricedDb);
  for (const [r, raw] of [[plain, plainDb], [investor, investorDb], [investorUnpriced, investorUnpricedDb]] as const) {
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal((r.body as { code?: string }).code, 'LOT_COUNT_UP_OWNER_ONLY', JSON.stringify(r.body));
    assert.equal(count(raw, "SELECT COUNT(*) n FROM lot_count_events"), 0, 'a refused count writes nothing');
    assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_audit'"), 1);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM investor_finance_events"), 0);
  }
  for (const r of [plain, investor, investorUnpriced]) assert.deepEqual(leaks(r.body), []);
  assert.deepEqual(
    investor,
    plain,
    'LEAK: POST /lot-counts answers an assistant differently when the lot is investor-funded with a loss share and a cost above zero ' +
      `(plain lot → ${plain.status} ${JSON.stringify(plain.body)}, investor lot → ${investor.status} ${JSON.stringify(investor.body)})`,
  );
  assert.deepEqual(
    investor,
    investorUnpriced,
    'LEAK: on an investor-funded lot the assistant\'s answer flips on whether the private cost is recorded ' +
      `(cost recorded → ${investor.status} ${JSON.stringify(investor.body)}, no cost → ${investorUnpriced.status} ${JSON.stringify(investorUnpriced.body)})`,
  );

  // Positive controls, the owner: the same upward count posts on the plain lot
  // and meets the investor-capital rule on the funded one (he sees both).
  const ownerPlain = await lotCount(world('priced'), 2, OWNER),
    ownerInvestor = await lotCount(world('investorPriced'), 2, OWNER);
  assert.equal(ownerPlain.status, 200, JSON.stringify(ownerPlain.body));
  assert.equal(ownerInvestor.status, 400, JSON.stringify(ownerInvestor.body));

  // DOWN: one unit lost — the assistant's count posts on every lot, and the
  // answer is the same whether the lot is investor-funded or costed.
  const downPlainDb = world('priced'),
    downInvestorDb = world('investorPriced'),
    downInvestorUnpricedDb = world('investorUnpriced');
  const downPlain = await lotCount(downPlainDb, 0),
    downInvestor = await lotCount(downInvestorDb, 0),
    downInvestorUnpriced = await lotCount(downInvestorUnpricedDb, 0);
  assert.equal(downPlain.status, 200, JSON.stringify(downPlain.body));
  assert.ok(count(downInvestorDb, "SELECT COUNT(*) n FROM investor_finance_events WHERE contract_id='ic_audit'") > 0, 'the investor loss branch ran');
  for (const r of [downPlain, downInvestor, downInvestorUnpriced]) assert.deepEqual(leaks(r.body), []);
  assert.deepEqual(downInvestor, downPlain, 'LEAK: a downward count answers an assistant differently on an investor-funded lot');
  assert.deepEqual(downInvestor, downInvestorUnpriced, 'LEAK: a downward count answers an assistant differently on an unpriced investor lot');
});

test('count post: the assistant\'s answer does not reveal whether the consumed FIFO lot has a private cost', async () => {
  const pricedDb = world('priced'),
    unpricedDb = world('unpriced');
  const priced = await countSession(pricedDb),
    unpriced = await countSession(unpricedDb);

  // Positive controls: both sessions posted and took the unit from lot_audit (oldest FIFO layer).
  assert.equal(priced.status, 200, JSON.stringify(priced.body));
  assert.equal(unpriced.status, 200, JSON.stringify(unpriced.body));
  for (const raw of [pricedDb, unpricedDb]) {
    assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_audit'"), 0);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM stock_counts WHERE id='audit-count-0001' AND status='posted'"), 1);
  }

  // THE CHECK: same caller, same session, worlds differing only in the
  // consumed lot's private cost — the answer must be identical.
  assert.deepEqual(
    unpriced,
    priced,
    'LEAK: POST /counts/:id/post tells an assistant how many consumed lots have no recorded private cost ' +
      `(priced → ${JSON.stringify(priced.body)}, unpriced → ${JSON.stringify(unpriced.body)})`,
  );
});
