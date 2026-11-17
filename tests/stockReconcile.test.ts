/**
 * «دقة المخزون وخطة الشراء» — the Difference column and its «تصحيح» action
 * (worker/lib/stockReconcile.ts, POST /api/admin/stock-operations/reconcile).
 *
 * The difference is counter − FIFO lot units for one stock identity. It is a
 * REAL disagreement (a counter that moved without its cost layers), so the fix
 * brings the layers to the counter and never moves the counter: the shelf the
 * shop sells from is unchanged, and a movement row records the correction.
 *
 * LOCAL ONLY: throwaway copies of the role-matrix database, the real router.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { adminStockOperationsRoutes } from '../worker/routes/adminStockOperations';
import { asD1, count } from './fixtures/app';
import { planReconcile } from '../worker/lib/stockReconcile';
import { isFenceMiss } from '../worker/lib/operations';
import { COST } from './fixtures/costlyProduct';
import { OWNER, ROLES, appFor, call, seededCopy, type MountSpec, type Router } from './fixtures/roleMatrix';

const PREFIX = '/api/admin/stock-operations';
const MOUNTS: readonly MountSpec[] = [[PREFIX, adminStockOperationsRoutes as Router]];
type Row = { product_id: string; scope: string; scope_id: string; stock: number; lot_units: number; discrepancy: number; reserved: number };
type Body = { rows: Row[]; summary: { rows_differ: number; units_without_lots: number; lot_units_not_on_shelf: number } };

const shelf = (raw: DatabaseSync) => count(raw, "SELECT stock n FROM products WHERE id='p_a1'");
const lotUnits = (raw: DatabaseSync) =>
  count(raw, "SELECT COALESCE(SUM(qty_remaining),0) n FROM inventory_lots WHERE product_id='p_a1' AND scope='base' AND scope_id=''");
const health = async (raw: DatabaseSync, user = OWNER, query = '') =>
  (await call(appFor(raw, user, MOUNTS), 'GET', `${PREFIX}/health${query}`)).body as Body;
const a1 = (b: Body) => b.rows.find((r) => r.product_id === 'p_a1' && r.scope === 'base')!;

test('the seeded world: counter 5, lot units 2 — a +3 difference that is real, and the summary counts it', async () => {
  const raw = seededCopy();
  const b = await health(raw);
  assert.equal(a1(b).stock, 5);
  assert.equal(a1(b).lot_units, 2);
  assert.equal(a1(b).discrepancy, 3);
  assert.ok(b.summary.rows_differ >= 1);
  assert.ok(b.summary.units_without_lots >= 3);
  // «فقط الفروقات» keeps it; every returned row differs.
  const only = await health(raw, OWNER, '?only_diff=1');
  assert.ok(only.rows.every((r) => r.discrepancy !== 0));
  assert.ok(only.rows.some((r) => r.product_id === 'p_a1'));
});

test('reserved units are not a difference: a held order leaves counter and lots equal', async () => {
  const raw = seededCopy();
  raw.exec("UPDATE products SET stock=2, stock_reserved=2 WHERE id='p_a1'");
  assert.equal(a1(await health(raw)).discrepancy, 0);
});

const journal = (raw: DatabaseSync, account: string, side: 'debit' | 'credit') =>
  count(
    raw,
    `SELECT COALESCE(SUM(l.${side}_iqd),0) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE l.account_code='${account}' AND e.title='تسوية دفعات المخزون'`,
  );

test('+3: a lot of 3 opens at the product cost price with the 1200/5300 gain journal; the counter stays 5 and the row reads 0', async () => {
  const raw = seededCopy();
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0001',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 5, lot_units: 2 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { success: true, fixed: 1, already: false, unknown_cost_rows: 0 });
  assert.equal(shelf(raw), 5);
  assert.equal(lotUnits(raw), 5);
  assert.equal(
    count(
      raw,
      `SELECT COUNT(*) n FROM inventory_lots WHERE product_id='p_a1' AND cost_basis='opening' AND unit_cost_iqd=${COST.product}
         AND purchase_unit_iqd=${COST.product} AND total_cost_iqd=${3 * COST.product} AND qty_received=3 AND qty_remaining=3`,
    ),
    1,
  );
  assert.equal(journal(raw, '1200', 'debit'), 3 * COST.product);
  assert.equal(journal(raw, '5300', 'credit'), 3 * COST.product);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE product_id='p_a1' AND kind='adjust_in' AND qty=3 AND reason LIKE 'reconcile%'"), 1);
  assert.equal(a1(await health(raw)).discrepancy, 0);

  // A replay is a no-op; the same id for a different correction is refused.
  const again = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0001',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 5, lot_units: 2 }],
  });
  assert.equal(again.status, 200);
  assert.equal((again.body as { already: boolean }).already, true);
  assert.equal(lotUnits(raw), 5);
  assert.equal(journal(raw, '1200', 'debit'), 3 * COST.product, 'no second journal');
  const other = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0001',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 6, lot_units: 2 }],
  });
  assert.equal(other.status, 409);
});

test('+2 on an option: the 0098 ladder takes cost_adjust over the product cost when the option has no own cost', async () => {
  const raw = seededCopy();
  raw.exec(`UPDATE products SET inventory_mode='OPTION', product_cost_iqd=100000 WHERE id='p_a1';
    UPDATE product_option_values SET stock=2, cost_iqd=NULL, cost_adjust_iqd=-30000 WHERE id='v_a1';`);
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0008',
    rows: [{ product_id: 'p_a1', scope: 'option', scope_id: 'v_a1', stock: 2, lot_units: 0 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(
    count(raw, "SELECT COUNT(*) n FROM inventory_lots WHERE scope='option' AND scope_id='v_a1' AND cost_basis='opening' AND unit_cost_iqd=70000 AND total_cost_iqd=140000"),
    1,
  );
  assert.equal(journal(raw, '1200', 'debit'), 140000);
});

test('+n with no cost on any rung: an unpriced opening and no journal', async () => {
  const raw = seededCopy();
  raw.exec("UPDATE products SET product_cost_iqd=NULL WHERE id='p_a1'");
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0009',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 5, lot_units: 2 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body as { unknown_cost_rows: number }).unknown_cost_rows, 1);
  assert.equal(
    count(raw, "SELECT COUNT(*) n FROM inventory_lots WHERE product_id='p_a1' AND cost_basis='opening_unpriced' AND unit_cost_iqd IS NULL AND total_cost_iqd IS NULL AND qty_remaining=3"),
    1,
  );
  assert.equal(journal(raw, '1200', 'debit'), 0);
});

test('a cost price changed between the plan and the commit trips the fence', async () => {
  const raw = seededCopy();
  const db = asD1(raw);
  const plan = await planReconcile(db, {
    operationId: 'reconcile-test-0010', productId: 'p_a1', scope: 'base', scopeId: '',
    expectedStock: 5, expectedLotUnits: 2, actorUserId: 'usr_owner',
  });
  raw.exec("UPDATE products SET product_cost_iqd=product_cost_iqd+1 WHERE id='p_a1'");
  await assert.rejects(db.batch(plan.statements), (e: unknown) => isFenceMiss(e));
  assert.equal(lotUnits(raw), 2);
});

test('non-owners (assistant, full admin) hear the generic cost refusal for real and invented rows; nothing is written; no needs_lot_count', async () => {
  for (const user of [ROLES.assistant!, ROLES.full!]) {
    const raw = seededCopy();
    const answers: string[] = [];
    for (const row of [
      { product_id: 'p_a1', scope: 'base', scope_id: '', stock: 5, lot_units: 2 },
      { product_id: 'p_invented', scope: 'base', scope_id: '', stock: 9, lot_units: 0 },
    ]) {
      const res = await call(appFor(raw, user, MOUNTS), 'POST', `${PREFIX}/reconcile`, { operation_id: 'reconcile-test-0011', rows: [row] });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal((res.body as { code?: string }).code, 'COST_ACCESS_DENIED');
      answers.push(JSON.stringify(res.body));
    }
    assert.equal(answers[0], answers[1], 'one answer for a real and an invented row');
    // An empty body too: the refusal comes before validation.
    const empty = await call(appFor(raw, user, MOUNTS), 'POST', `${PREFIX}/reconcile`, {});
    assert.equal(JSON.stringify(empty.body), answers[0]);
    assert.equal(lotUnits(raw), 2);
    assert.equal(count(raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE reason LIKE 'reconcile%'"), 0);
    const funded = fundedWorld(1);
    const row = a1(await health(funded, user)) as Row & { needs_lot_count?: boolean };
    assert.equal(row.discrepancy, -3);
    assert.ok(!('needs_lot_count' in row), 'investor funding is not answered to a non-owner');
  }
});

test('−2: lot units above the counter leave FIFO, oldest first, with the count journal; the counter stays', async () => {
  const raw = seededCopy();
  raw.exec(`UPDATE products SET stock=1 WHERE id='p_a1';
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,
      shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('lot_new','p_a1','base','',1,1,1000,1000,0,0,1000,'received','2026-10-01T09:00:00Z');`);
  // counter 1, lots 2 (lot1, older) + 1 (lot_new) = 3 → −2.
  assert.equal(a1(await health(raw)).discrepancy, -2);
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0002',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 1, lot_units: 3 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(shelf(raw), 1);
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot1'"), 0, 'the oldest lot goes first');
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_new'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE product_id='p_a1' AND kind='adjust_out' AND qty=2 AND reason LIKE 'reconcile%'"), 1);
  assert.equal(
    count(raw, "SELECT COALESCE(SUM(l.debit_iqd),0) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE l.account_code='5300' AND e.title='تسوية دفعات المخزون'"),
    2 * COST.lotUnit,
  );
  assert.equal(a1(await health(raw)).discrepancy, 0);
});

test('a counter that moved after the page was read refuses the fix and writes nothing', async () => {
  const raw = seededCopy();
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0003',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 4, lot_units: 2 }],
  });
  assert.equal(res.status, 409);
  assert.equal((res.body as { code?: string }).code, 'STOCK_CHANGED');
  assert.equal(lotUnits(raw), 2);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE reason LIKE 'reconcile%'"), 0);
});

test('a row already in agreement is a no-op, not an error', async () => {
  const raw = seededCopy();
  raw.exec("UPDATE products SET stock=2 WHERE id='p_a1'");
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0004',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 2, lot_units: 2 }],
  });
  assert.equal(res.status, 200);
  assert.equal((res.body as { fixed: number }).fixed, 0);
});

test('a sale between the plan and the commit trips the fence: nothing is written', async () => {
  const raw = seededCopy();
  const db = asD1(raw);
  const plan = await planReconcile(db, {
    operationId: 'reconcile-test-0005', productId: 'p_a1', scope: 'base', scopeId: '',
    expectedStock: 5, expectedLotUnits: 2, actorUserId: 'usr_owner',
  });
  assert.equal(plan.delta, 3);
  raw.exec("UPDATE products SET stock=4 WHERE id='p_a1'");
  await assert.rejects(db.batch(plan.statements), (e: unknown) => isFenceMiss(e));
  assert.equal(lotUnits(raw), 2);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE reason LIKE 'reconcile%'"), 0);
});

/** lot1 (2 units, oldest) plus a newer investor-funded lot of 2; the counter says `stock`. */
function fundedWorld(stock: number): DatabaseSync {
  const raw = seededCopy();
  raw.exec(`UPDATE products SET stock=${stock} WHERE id='p_a1';
    INSERT INTO incoming_inventory (id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,
                                    shipping_total_iqd,internal_delivery_total_iqd,status)
      VALUES ('inc_rec','p_a1','base','',2,2,1000,0,0,'received');
    INSERT INTO inventory_lots (id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,purchase_unit_iqd,
      shipping_share_iqd,internal_share_iqd,total_cost_iqd,cost_basis,received_at,incoming_id)
    VALUES ('lot_funded','p_a1','base','',2,2,1000,1000,0,0,2000,'received','2026-10-01T09:00:00Z','inc_rec');
    INSERT INTO investment_contracts (id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,
                                      loss_share_bps,created_by,created_at,request_json)
      VALUES ('ic_rec','inc_rec','usr_inv','Reconcile contract',1000000,10000,3500,10000,'usr_owner','2026-09-01T00:00:00.000Z','{}');`);
  return raw;
}

test('−n that would reach an investor-funded lot is refused (RECONCILE_INVESTOR_LOT), marked on the card, and writes nothing', async () => {
  const raw = fundedWorld(1); // lots 4 → −3: lot1's 2 then 1 of the funded lot
  const row = a1(await health(raw));
  assert.equal(row.discrepancy, -3);
  assert.equal((row as Row & { needs_lot_count?: boolean }).needs_lot_count, true);
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0006',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 1, lot_units: 4 }],
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal((res.body as { code?: string }).code, 'RECONCILE_INVESTOR_LOT');
  assert.equal(lotUnits(raw), 4);
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot1'"), 2);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM inventory_ledger WHERE reason LIKE 'reconcile%'"), 0);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM investor_finance_events WHERE contract_id='ic_rec'"), 0);
});

test('−n that FIFO takes only from unfunded older lots still fixes', async () => {
  const raw = fundedWorld(2); // lots 4 → −2: lot1's 2 only
  const row = a1(await health(raw));
  assert.equal((row as Row & { needs_lot_count?: boolean }).needs_lot_count, false);
  const res = await call(appFor(raw, OWNER, MOUNTS), 'POST', `${PREFIX}/reconcile`, {
    operation_id: 'reconcile-test-0007',
    rows: [{ product_id: 'p_a1', scope: 'base', scope_id: '', stock: 2, lot_units: 4 }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot1'"), 0);
  assert.equal(count(raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_funded'"), 2);
});
