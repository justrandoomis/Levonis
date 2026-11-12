/**
 * THE FINANCE AUDIT TRAIL — every change to money leaves a row in audit_log (the owner's brief, 2026-11-12, part 4:
 * «audit logs … all financial calculations must remain accurate and traceable»).
 *
 * Most finance writes already wrote their own row, in the batch that moves the money. Eleven did not: courier money
 * recorded, a manual journal entry and its reversal, a cost approved, a task assigned, an order recomputed, an expense
 * linked, an advance settled against wages, a cost centre or a staff member created, a centre edited, a contract funded.
 * They do now, and this file keeps it so:
 * - THE MAP: every write route of every finance router names the action(s) it writes, or the one reason it writes none
 *   (a preview, one step of a recomputation the screen repeats). A new route in neither place fails here, and so does a
 *   route the map names that is gone.
 * - Each named action is written somewhere in worker/ (a literal, or the withdrawal states' one template).
 * - Through the real routes: a journal entry and its reversal, a cost centre created and edited, an order recomputed —
 *   one row each, with what changed; a replay the route answers `already: true`, and a refusal, none.
 * tests/operationsErp.test.ts holds the rows of courier money, an approved cost, an advance settlement and an expense
 * link, with their replays and refusals.
 *
 * Every figure is invented. Run: node --import tsx --test tests/financeAuditTrail.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { freshDb, asD1, stubApp, post, patch, json, row, count } from './fixtures/app';
import finance from './routeClass/finance';
import { adminWalletAdjustRoutes } from '../worker/routes/adminWalletAdjust';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';

/** What each finance write leaves in audit_log. A string list: those actions (one of them per request); `none`: why not. */
const TRAIL: Record<string, string[] | { none: string }> = {
  '/api/admin/finance POST /expense-categories': ['finance.expense_category.create'],
  '/api/admin/finance PATCH /expense-categories/:id': ['finance.expense_category.update'],
  '/api/admin/finance POST /expenses': ['finance.expense.create'],
  '/api/admin/finance PATCH /expenses/:id': ['finance.expense.update'],
  '/api/admin/finance DELETE /expenses/:id': ['finance.expense.void'],
  '/api/admin/finance POST /expenses/:id/restore': ['finance.expense.restore'],
  '/api/admin/finance-operations POST /staff': ['finance.staff_created'],
  '/api/admin/finance-operations PATCH /staff/:id': ['finance.staff_updated', 'finance.staff_archived'],
  '/api/admin/finance-operations POST /centers': ['finance.center_created'],
  '/api/admin/finance-operations PATCH /centers/:id': ['finance.center_updated'],
  '/api/admin/finance-operations POST /rules': ['finance.rule_created'],
  '/api/admin/finance-operations PUT /rules/:id': ['finance.rule_updated'],
  '/api/admin/finance-operations POST /orders/:id/reconcile': ['finance.order_recomputed'],
  '/api/admin/finance-operations POST /orders/:id/assignment': ['finance.order_assigned'],
  '/api/admin/finance-operations POST /costs/:id/approve': ['finance.cost_approved'],
  '/api/admin/finance-operations POST /costs/:id/reverse': ['finance.cost_reversed'],
  '/api/admin/finance-operations POST /staff/:id/payments': ['finance.staff_paid'],
  '/api/admin/finance-operations POST /staff/:id/advance-settlements': ['finance.advance_settled'],
  '/api/admin/finance-operations POST /expense-links': ['finance.expense_linked'],
  '/api/admin/finance-operations POST /collections': ['finance.collection_recorded'],
  '/api/admin/finance-operations POST /journal': ['accounting.journal_posted'],
  '/api/admin/finance-operations POST /journal/:id/reverse': ['accounting.journal_reversed'],
  '/api/admin/finance-operations POST /periods/close': ['accounting.period_closed'],
  '/api/admin/finance-operations PUT /permissions': ['operations.permission_changed'],
  '/api/admin/finance-operations POST /orders/:id/retry-posting': ['finance.posting_retried'],
  '/api/admin/finance-workspace POST /missing-costs/lines': ['finance.order_adjusted'],
  '/api/admin/finance-workspace POST /orders/:id/adjustments': ['finance.order_adjusted'],
  '/api/admin/finance-workspace POST /promotions': ['finance.monthly_promotion'],
  '/api/admin/finance-workspace PATCH /promotions/:id': ['finance.monthly_promotion'],
  '/api/admin/finance-workspace DELETE /promotions/:id': ['finance.monthly_promotion'],
  '/api/admin/finance-people POST /rules/:id/preview': { none: 'a preview: it works out what a wage change would do and moves no money' },
  '/api/admin/finance-people POST /rules/:id/apply': ['finance.wage_change_applied'],
  '/api/admin/finance-people POST /staff': ['finance.staff_linked'],
  '/api/admin/finance-people PATCH /staff/:id': ['finance.staff_updated', 'finance.staff_archived'],
  '/api/admin/finance-people DELETE /staff/:id': ['finance.staff_archived'],
  '/api/admin/finance-people POST /staff/:id/reconcile': { none: 'one step of a recomputation the screen repeats; the request that starts it (recheck) has its row' },
  '/api/admin/finance-people POST /staff/:id/recheck': ['finance.staff_recheck_requested'],
  '/api/admin/finance-people POST /staff/:id/settle': ['finance.staff_settled'],
  '/api/admin/finance-people POST /withdrawals/:id/approve': ['finance.withdrawal_approved'],
  '/api/admin/finance-people POST /withdrawals/:id/reject': ['finance.withdrawal_rejected'],
  '/api/admin/finance-people POST /withdrawals/:id/pay': ['finance.withdrawal_paid'],
  '/api/admin/finance-people PATCH /costs/:id': ['finance.staff_cost_adjusted'],
  '/api/admin/investment-finance POST /profiles': ['investment.profile_updated'],
  '/api/admin/investment-finance POST /legacy/:id/link': ['investment.legacy_reviewed'],
  '/api/admin/investment-finance POST /contracts': ['investment.contract_created'],
  '/api/admin/investment-finance POST /contracts/:id/funding': ['investment.contract_funded'],
  '/api/admin/investment-finance POST /contracts/:id/void': ['investment.contract_voided'],
  '/api/admin/investment-finance POST /lot-cost-adjustments': ['stock.lot_cost_adjusted'],
  '/api/admin/wallet-adjust POST /users/:id': ['wallet.manual_adjust'],
  '/api/admin/wallet-adjust POST /rounding-drift/apply': ['wallet.rounding_drift.run'],
  '/api/finance-earnings POST /withdrawals': ['finance.withdrawal_requested'],
  '/api/finance-earnings POST /withdrawals/:id/cancel': ['finance.withdrawal_cancelled'],
};

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function writeRoutes(prefix: string, router: Hono<never>): string[] {
  return [...new Set(router.routes.filter((r) => WRITES.has(r.method)).map((r) => `${prefix} ${r.method} ${r.path}`))];
}
const MOUNTS: Array<[string, Hono<never>]> = [
  ...finance.mounts.map((m) => [m.prefix, m.router as unknown as Hono<never>] as [string, Hono<never>]),
  ['/api/admin/wallet-adjust', adminWalletAdjustRoutes as unknown as Hono<never>],
  ['/api/finance-earnings', financeEarningsRoutes as unknown as Hono<never>],
];

test('the map: every finance write names what it leaves in audit_log, or why it leaves nothing — and names no route that is gone', () => {
  const live = MOUNTS.flatMap(([prefix, router]) => writeRoutes(prefix, router));
  assert.ok(live.length >= 50, `only ${live.length} finance writes found`);
  const unnamed = live.filter((r) => !(r in TRAIL));
  assert.deepEqual(unnamed, [], 'a finance write with no audit row and no reason: add its row in the batch that moves the money, then name it here');
  const gone = Object.keys(TRAIL).filter((r) => !live.includes(r));
  assert.deepEqual(gone, [], 'a route the map names no longer exists');
  for (const [r, v] of Object.entries(TRAIL)) if (!Array.isArray(v)) assert.ok(v.none.length > 20, `${r}: say why`);
});

function sourceOf(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((p) => (statSync(p).isDirectory() ? sourceOf(p) : p.endsWith('.ts') ? readFileSync(p, 'utf8') : ''))
    .join('\n');
}

test('each action the map names is written by the worker — a literal, or the withdrawal states’ one template', () => {
  const src = sourceOf('worker');
  const withdrawalState = /^finance\.withdrawal_(approved|rejected|cancelled)$/;
  for (const actions of Object.values(TRAIL)) {
    if (!Array.isArray(actions)) continue;
    for (const a of actions) {
      const literal = src.includes(`'${a}'`) || src.includes(`"${a}"`) || src.includes(`\`${a}\``);
      const template = withdrawalState.test(a) && src.includes('`finance.withdrawal_${state}`');
      assert.ok(literal || template, `${a} is never written`);
    }
  }
});

// ═══════════════════════════════════════════════ through the real routes

const OWNER = { id: 'boss', email: 'boss@x.co', role: 'admin' as const };
function ops() {
  const raw = freshDb();
  raw.exec("INSERT INTO users(id,name,email,role) VALUES ('boss','المالك','boss@x.co','admin'),('u1','زبون','u1@x.co','customer')");
  const app = stubApp(asD1(raw), OWNER, (a) => a.route('/f', adminFinanceOperationsRoutes));
  return { raw, app };
}
const rowsOf = (raw: ReturnType<typeof freshDb>, action: string) =>
  (raw.prepare('SELECT actor_id, target, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as Array<{ actor_id: string; target: string; detail: string }>)
    .map((r) => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> }));

test('a manual journal entry and its reversal: one row each with the money; their replays none', async () => {
  const { raw, app } = ops();
  const entry = { operation_id: 'jrnl-op-000000001', day: '2026-11-03', title: 'تسوية صندوق', lines: [{ account: '1000', debit: 7000 }, { account: '3100', credit: 7000 }] };
  const posted = await post(app, '/f/journal', entry);
  assert.equal(posted.status, 200, JSON.stringify(await json(posted)));
  assert.equal((await json(await post(app, '/f/journal', entry))).already, true);
  const [p] = rowsOf(raw, 'accounting.journal_posted');
  assert.equal(rowsOf(raw, 'accounting.journal_posted').length, 1);
  assert.deepEqual([p.actor_id, p.target, p.detail.debit_iqd, p.detail.title, p.detail.lines], ['boss', 'manual:jrnl-op-000000001', 7000, 'تسوية صندوق', [['1000', 7000, 0], ['3100', 0, 7000]]]);
  const id = row<{ id: string }>(raw, "SELECT id FROM accounting_entries WHERE event_key='manual:jrnl-op-000000001'")!.id;
  const reversed = await post(app, `/f/journal/${id}/reverse`, { day: '2026-11-04', reason: 'قيد بالخطأ' });
  assert.equal(reversed.status, 200, JSON.stringify(await json(reversed)));
  assert.equal((await json(await post(app, `/f/journal/${id}/reverse`, { day: '2026-11-04', reason: 'قيد بالخطأ' }))).already, true);
  const r = rowsOf(raw, 'accounting.journal_reversed');
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].target, r[0].detail.reason, r[0].detail.debit_iqd], [id, 'قيد بالخطأ', 7000]);
});

test('a refused journal entry (a closed month) leaves no row', async () => {
  const { raw, app } = ops();
  raw.exec("INSERT INTO accounting_periods(month, closed_at, closed_by) VALUES ('2026-10', '2026-11-01T09:00:00.000Z', 'boss')");
  const res = await post(app, '/f/journal', { operation_id: 'jrnl-op-000000002', day: '2026-10-20', title: 'تسوية صندوق', lines: [{ account: '1000', debit: 5000 }, { account: '3100', credit: 5000 }] });
  assert.equal(res.status, 409);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'accounting.%'"), 0);
});

test('a cost centre created and edited: rows with its name, and the edit with before and after; an unknown centre is 404 and no row', async () => {
  const { raw, app } = ops();
  const made = await json(await post(app, '/f/centers', { name: 'المعرض' }));
  assert.equal(made.success, true, JSON.stringify(made));
  const [c] = rowsOf(raw, 'finance.center_created');
  assert.deepEqual([c.target, c.detail], [made.id, { name: 'المعرض' }]);
  assert.equal((await patch(app, `/f/centers/${made.id}`, { name: 'المعرض الجديد', active: false })).status, 200);
  const [u] = rowsOf(raw, 'finance.center_updated');
  assert.deepEqual(u.detail, { before: { name: 'المعرض', active: 1 }, after: { name: 'المعرض الجديد', active: 0 } });
  assert.equal((await patch(app, '/f/centers/cc_missing', { name: 'لا شيء' })).status, 404);
  assert.equal(rowsOf(raw, 'finance.center_updated').length, 1);
  const staff = await json(await post(app, '/f/staff', { name: 'موظف تجربة', role: 'تغليف' }));
  assert.deepEqual(rowsOf(raw, 'finance.staff_created').map((r) => [r.target, r.detail]), [[staff.id, { name: 'موظف تجربة', role: 'تغليف' }]]);
});

test('an order recomputed by hand leaves its row', async () => {
  const { raw, app } = ops();
  raw.exec(`INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
      subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,priority,shipping_type,seller_type)
    VALUES ('ORD-A0D17E001','u1','pending','received','{"name":"x"}','standard','{}','cash',1000,1500,1000,1000,'2026-11-02T08:00:00.000Z',0,'direct','levonis')`);
  assert.equal((await post(app, '/f/orders/ORD-A0D17E001/reconcile', {})).status, 200);
  assert.deepEqual(rowsOf(raw, 'finance.order_recomputed').map((r) => [r.target, r.detail]), [['ORD-A0D17E001', { status: 'pending', stage: 'received' }]]);
});
