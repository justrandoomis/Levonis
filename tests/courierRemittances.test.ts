/**
 * MONEY WITH THE COURIER (the owner's brief, 2026-11-12, part 3; DECISIONS row 332; migration 0232;
 * worker/lib/courierCollections.ts; GET /courier, GET /courier/remittances/:id, POST /courier/remittances,
 * POST /courier/remittances/:id/reconcile).
 *
 * Over invented orders: the parcels still at the courier are the Levonis orders delivered by the courier method with cash
 * due at the door — never pickup, personal delivery, a cancelled order, one not delivered, a prepaid one or one already
 * paid — oldest first, each with the fee estimated as the standard fee quoted (even when delivery was free). Recording a
 * transfer writes, per parcel, an ordinary collection (payer courier) with its fee expense, its journal entry (cash and fee
 * against the sale's receivable) and its audit row, then the transfer, its parcels and its own audit row, in one batch: a
 * retry is `already`, the same operation for other content is refused, less than the site shows is refused (the owner's
 * rule) and more is booked as lower courier fees, a partly paid parcel stays with what is left. An opening's amount is the parcels' cash less
 * their fees. Checking a transfer against the courier's statement reconciles it once and for good; the database refuses
 * any change or deletion of a recorded transfer. An assistant is refused at the door.
 *
 * The second round (DECISIONS row 338; migration 0233; POST /courier/remittances/:id/undo). A prepaid parcel waits for its
 * fee; a transfer carries it as a line of its own (an expense linked to the order and an entry from the cash), and what
 * should arrive is that much less; a fee of 0 settles one. An undo takes a transfer not yet checked back as if never
 * recorded: its parcels and fees are with the courier again, every account is where it was, each entry is reversed on the
 * transfer's own day (a parcel whose sale was posted later gets its receivable back on 1100), the fee expenses are voided
 * and locked, and the transfer stays in the list as undone with what it held. Before 0233 the page reads as before.
 *
 * Every figure is invented. Run: node --import tsx --test tests/courierRemittances.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, get, json, patch, post, send, stubApp } from './fixtures/app';
import { order, world } from './fixtures/financeWorld';
import { journalPlan } from '../worker/lib/operations';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { MAX_REMITTANCE_PARCELS } from '../worker/lib/courierCollections';

type W = ReturnType<typeof world>;
const day = (iso: string) => iso.slice(0, 10);

/** Parcels of every kind; `a` and `b` are the courier's, with their sales in the journal. */
async function parcels() {
  const w = world();
  order(w.raw, { id: 'a', delivered: '2026-11-01T09:00:00.000Z' });                  // 50,000 + 5,000 delivery = 55,000 at the door
  order(w.raw, { id: 'b', qty: 1, delivered: '2026-11-03T09:00:00.000Z' });          // 25,000 + 5,000 = 30,000
  order(w.raw, { id: 'free', qty: 1, shipping: 0, delivered: '2026-11-05T09:00:00.000Z' }); // free delivery: 25,000
  order(w.raw, { id: 'pickup', qty: 1, delivered: '2026-11-02T09:00:00.000Z' });
  order(w.raw, { id: 'personal', qty: 1, delivered: '2026-11-02T09:00:00.000Z' });
  order(w.raw, { id: 'cancelled', qty: 1, status: 'cancelled', delivered: null });
  order(w.raw, { id: 'shipped', qty: 1, status: 'shipped', delivered: null });
  order(w.raw, { id: 'prepaid', qty: 1, delivered: '2026-11-02T09:00:00.000Z' });
  w.raw.exec(`UPDATE orders SET delivery_method_id='pickup' WHERE id='pickup';
    UPDATE orders SET delivery_method_id='personal' WHERE id='personal';
    UPDATE orders SET due_on_delivery_iqd=0 WHERE id='prepaid';
    UPDATE orders SET shipping_before_benefit_iqd=5000 WHERE id='free';`);
  for (const [id, amount] of [['a', 55000], ['b', 30000]] as const) {
    await w.db.batch(journalPlan(w.db, { key: `sale:${id}`, day: '2026-11-01', title: 'بيع', source: 'order', sourceId: id, actor: 'admin' },
      [{ account: '1100', debit: amount }, { account: '4000', credit: amount - 5000 }, { account: '4100', credit: 5000 }]).statements);
  }
  return w;
}
const overview = async (w: W) => w.read('/f/courier');
const transfer = (w: W, body: Record<string, unknown>) => post(w.app, '/f/courier/remittances', { operation_id: 'op-transfer-1', received_day: '2026-11-10', reference: 'Z-1001', ...body });
/** Rows as plain objects (node:sqlite gives them no prototype). */
const rows = (w: W, sql: string, ...p: unknown[]) => (w.raw.prepare(sql).all(...(p as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));

test('the parcels still at the courier: delivered by the courier with cash due, oldest first, with the fee estimate', async () => {
  const w = await parcels();
  const o = await overview(w);
  assert.deepEqual(o.pending.parcels.map((p: Record<string, unknown>) => [p.order_id, p.due_iqd, p.fee_estimate_iqd, p.delivered_day]), [
    ['a', 55000, 5000, '2026-11-01'],
    ['b', 30000, 5000, '2026-11-03'],
    ['free', 25000, 5000, '2026-11-05'],
  ], 'not pickup, personal delivery, cancelled, not yet delivered or prepaid; a free delivery still costs its quoted fee');
  assert.deepEqual([o.pending.count, o.pending.due_iqd, o.pending.fee_estimate_iqd, o.pending.net_estimate_iqd], [3, 110000, 15000, 95000]);
  assert.equal(o.first_time, true);
  assert.deepEqual(o.remittances, []);
});

test('a transfer: each parcel an ordinary collection with its fee and journal entry, then the transfer — one batch', async () => {
  const w = await parcels();
  const res = await transfer(w, { amount_iqd: 75000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }, { order_id: 'b', fee_iqd: 5000 }] });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual([body.already, body.id, body.parcels], [false, 'op-transfer-1', 2]);
  assert.deepEqual(rows(w, 'SELECT id,order_id,payer,amount_iqd,fee_iqd,collection_day,reference FROM finance_collections ORDER BY id'), [
    { id: 'op-transfer-1:1', order_id: 'a', payer: 'courier', amount_iqd: 55000, fee_iqd: 5000, collection_day: '2026-11-10', reference: 'Z-1001' },
    { id: 'op-transfer-1:2', order_id: 'b', payer: 'courier', amount_iqd: 30000, fee_iqd: 5000, collection_day: '2026-11-10', reference: 'Z-1001' },
  ]);
  assert.deepEqual(rows(w, `SELECT l.account_code AS account,l.debit_iqd AS debit,l.credit_iqd AS credit FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
      WHERE e.event_key='collection:op-transfer-1:1' ORDER BY l.account_code`), [
    { account: '1000', debit: 50000, credit: 0 }, { account: '1100', debit: 0, credit: 55000 }, { account: '5200', debit: 5000, credit: 0 },
  ], 'cash and the fee against the sale’s receivable');
  assert.deepEqual(rows(w, "SELECT category_id,amount_iqd,note FROM operating_expenses WHERE title='أجرة شركة التوصيل' ORDER BY note"),
    [{ category_id: 'rent', amount_iqd: 5000, note: 'a' }, { category_id: 'rent', amount_iqd: 5000, note: 'b' }]);
  assert.deepEqual(rows(w, 'SELECT kind,reference,received_day,amount_iqd,collected_iqd,fee_iqd,difference_iqd,parcels,state FROM courier_remittances'),
    [{ kind: 'transfer', reference: 'Z-1001', received_day: '2026-11-10', amount_iqd: 75000, collected_iqd: 85000, fee_iqd: 10000, difference_iqd: 0, parcels: 2, state: 'received' }]);
  assert.deepEqual(rows(w, 'SELECT order_id,collection_id,collected_iqd,fee_iqd FROM courier_remittance_orders ORDER BY order_id'), [
    { order_id: 'a', collection_id: 'op-transfer-1:1', collected_iqd: 55000, fee_iqd: 5000 },
    { order_id: 'b', collection_id: 'op-transfer-1:2', collected_iqd: 30000, fee_iqd: 5000 },
  ]);
  const audit = rows(w, "SELECT action,target,json_extract(detail,'$.remittance_id') AS remittance FROM audit_log WHERE action LIKE 'finance.co%' ORDER BY action,target");
  assert.deepEqual(audit, [
    { action: 'finance.collection_recorded', target: 'op-transfer-1:1', remittance: 'op-transfer-1' },
    { action: 'finance.collection_recorded', target: 'op-transfer-1:2', remittance: 'op-transfer-1' },
    { action: 'finance.courier_remittance_recorded', target: 'op-transfer-1', remittance: null },
  ]);
  const o = await overview(w);
  assert.deepEqual(o.pending.parcels.map((p: Record<string, unknown>) => p.order_id), ['free'], 'the paid parcels left the list');
  assert.equal(o.first_time, false);
  assert.deepEqual([o.unreconciled.count, o.unreconciled.amount_iqd], [1, 75000]);
  assert.deepEqual(o.fee_category, { id: 'rent', name_ar: 'إيجار', name_en: '', name_ckb: '' }, 'the next transfer’s fees go where the last ones went');
  const detail = await w.read('/f/courier/remittances/op-transfer-1');
  assert.deepEqual(detail.parcels.map((p: Record<string, unknown>) => [p.order_id, p.collected_iqd, p.fee_iqd, p.net_iqd]), [['a', 55000, 5000, 50000], ['b', 30000, 5000, 25000]]);
});

test('a retry is already recorded; the same operation for other content is refused', async () => {
  const w = await parcels();
  const body = { amount_iqd: 50000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }] };
  assert.equal((await transfer(w, body)).status, 200);
  const again = await json(await transfer(w, body));
  assert.deepEqual([again.success, again.already], [true, true]);
  assert.equal(rows(w, 'SELECT id FROM finance_collections').length, 1, 'nothing written twice');
  const other = await transfer(w, { ...body, amount_iqd: 49000, note: 'نقص' });
  assert.equal(other.status, 409);
  assert.equal((await json(other)).code, 'COURIER_OPERATION_REUSED');
});

test('the owner’s rule: never less than the site shows — a shortfall is refused, note or not; more is kept and booked as lower courier fees', async () => {
  const w = await parcels();
  const base = { category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }] };
  for (const note of ['', 'خصم الزعيم أجرة طرد مدفوع مسبقًا']) {
    const refused = await transfer(w, { ...base, amount_iqd: 49000, note });
    assert.equal(refused.status, 400);
    assert.equal((await json(refused)).code, 'COURIER_SHORT', 'a note does not make a shortfall acceptable');
  }
  assert.equal(rows(w, 'SELECT id FROM finance_collections').length, 0, 'nothing written');
  assert.equal((await transfer(w, { ...base, amount_iqd: 52000 })).status, 200, 'more than the site shows needs no note');
  assert.deepEqual(rows(w, 'SELECT amount_iqd,difference_iqd,note FROM courier_remittances'), [{ amount_iqd: 52000, difference_iqd: 2000, note: '' }]);
  assert.deepEqual(rows(w, `SELECT l.account_code AS account,l.debit_iqd AS debit,l.credit_iqd AS credit FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
      WHERE e.event_key='courier-difference:op-transfer-1' ORDER BY l.account_code`), [{ account: '1000', debit: 2000, credit: 0 }, { account: '5200', debit: 0, credit: 2000 }]);
  const cash = rows(w, "SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) AS n FROM accounting_lines WHERE account_code='1000'")[0].n;
  assert.equal(cash, 52000, 'the books’ cash is what arrived');
});

test('before migration 0232 the page still reads: the parcels, no transfer yet; an id is simply not found', async () => {
  const w = await parcels();
  w.raw.exec('DROP TABLE courier_remittance_orders; DROP TABLE courier_remittances;');
  const o = await overview(w);
  assert.deepEqual([o.pending.count, o.remittances.length, o.unreconciled.count, o.first_time], [3, 0, 0, true]);
  assert.equal((await get(w.app, '/f/courier/remittances/anything')).status, 404);
  assert.equal((await transfer(w, { amount_iqd: 50000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }] })).status, 503, 'recording waits for the migration');
});

test('what a transfer cannot hold: not a courier parcel, nothing due, too much, a fee over the cash, a parcel twice, too many', async () => {
  const w = await parcels();
  const refuse = async (parcels: unknown[], code: string, extra: Record<string, unknown> = {}) => {
    const res = await transfer(w, { amount_iqd: 1, note: 'x', category_id: 'rent', parcels, ...extra });
    assert.equal(res.status, 400, code);
    assert.equal((await json(res)).code, code);
  };
  await refuse([{ order_id: 'pickup', fee_iqd: 0 }], 'COURIER_NOT_A_PARCEL');
  await refuse([{ order_id: 'personal', fee_iqd: 0 }], 'COURIER_NOT_A_PARCEL');
  await refuse([{ order_id: 'shipped', fee_iqd: 0 }], 'COURIER_NOT_A_PARCEL');
  await refuse([{ order_id: 'prepaid', fee_iqd: 0 }], 'COURIER_NOTHING_DUE');
  await refuse([{ order_id: 'a', collected_iqd: 55001, fee_iqd: 0 }], 'COURIER_COLLECTED_RANGE');
  await refuse([{ order_id: 'b', fee_iqd: 30001 }], 'COURIER_FEE_RANGE');
  await refuse([{ order_id: 'a', fee_iqd: 0 }, { order_id: 'a', fee_iqd: 0 }], 'COURIER_DUPLICATE_PARCEL');
  await refuse([], 'COURIER_NO_PARCELS');
  await refuse(Array.from({ length: MAX_REMITTANCE_PARCELS + 1 }, (_, i) => ({ order_id: `x${i}`, fee_iqd: 0 })), 'COURIER_TOO_MANY_PARCELS');
  // The first fee with no category: the owner chooses where courier fees go.
  const res = await transfer(w, { amount_iqd: 50000, parcels: [{ order_id: 'a', fee_iqd: 5000 }] });
  assert.equal(res.status, 400);
  assert.match(String((await json(res)).error), /تصنيف/);
  assert.equal(rows(w, 'SELECT id FROM finance_collections').length, 0);
});

test('a parcel paid in part stays at the courier with what is left', async () => {
  const w = await parcels();
  assert.equal((await transfer(w, { amount_iqd: 15000, category_id: 'rent', parcels: [{ order_id: 'b', collected_iqd: 20000, fee_iqd: 5000 }] })).status, 200);
  const o = await overview(w);
  assert.deepEqual(o.pending.parcels.find((p: Record<string, unknown>) => p.order_id === 'b')?.due_iqd, 10000);
});

test('the opening: the parcels’ cash less their fees, under «رصيد افتتاحي», no difference', async () => {
  const w = await parcels();
  const res = await post(w.app, '/f/courier/remittances', { operation_id: 'op-opening-1', kind: 'opening', received_day: '2026-11-12', amount_iqd: 1, category_id: 'rent',
    parcels: [{ order_id: 'a', fee_iqd: 5000 }, { order_id: 'free', fee_iqd: 5000 }] });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.deepEqual(rows(w, 'SELECT kind,reference,amount_iqd,collected_iqd,fee_iqd,difference_iqd FROM courier_remittances'),
    [{ kind: 'opening', reference: 'رصيد افتتاحي', amount_iqd: 70000, collected_iqd: 80000, fee_iqd: 10000, difference_iqd: 0 }], 'the amount sent is ignored');
  assert.equal((await overview(w)).first_time, true, 'an opening is not a transfer: one cut short is finished the same way');
});

test('checking a transfer reconciles it once and for good; the database keeps a recorded transfer as it is', async () => {
  const w = await parcels();
  await transfer(w, { amount_iqd: 50000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }] });
  const res = await post(w.app, '/f/courier/remittances/op-transfer-1/reconcile', { note: 'طابق كشف الزعيم' });
  assert.deepEqual(await json(res), { success: true, already: false });
  assert.deepEqual(rows(w, 'SELECT state,reconciled_by,reconcile_note FROM courier_remittances'), [{ state: 'reconciled', reconciled_by: 'admin', reconcile_note: 'طابق كشف الزعيم' }]);
  assert.ok(rows(w, 'SELECT reconciled_at FROM courier_remittances')[0].reconciled_at);
  assert.deepEqual(await json(await post(w.app, '/f/courier/remittances/op-transfer-1/reconcile', {})), { success: true, already: true });
  assert.equal(rows(w, "SELECT id FROM audit_log WHERE action='finance.courier_remittance_reconciled'").length, 1);
  assert.equal((await post(w.app, '/f/courier/remittances/nope/reconcile', {})).status, 404);
  assert.throws(() => w.raw.exec("UPDATE courier_remittances SET amount_iqd=1 WHERE id='op-transfer-1'"), /immutable/);
  assert.throws(() => w.raw.exec("UPDATE courier_remittances SET state='received',reconciled_at=NULL WHERE id='op-transfer-1'"), /already reconciled/);
  assert.throws(() => w.raw.exec("DELETE FROM courier_remittances WHERE id='op-transfer-1'"), /immutable/);
  assert.throws(() => w.raw.exec("DELETE FROM courier_remittance_orders"), /immutable/);
  assert.equal((await get(w.app, '/f/courier/remittances/nope')).status, 404);
});

test('an assistant is refused at the door', async () => {
  const w = await parcels();
  const helper = stubApp(asD1(w.raw), { id: 'helper', email: 'h@x.co', role: 'admin', admin_scope: 'assistant' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  assert.equal((await get(helper, '/f/courier')).status, 403);
  assert.equal((await post(helper, '/f/courier/remittances', { operation_id: 'op-helper-1', amount_iqd: 1, parcels: [{ order_id: 'a' }] })).status, 403);
  assert.equal(day(new Date().toISOString()).length, 10);
});

// ─────────────────────────────────────────── the second round (DECISIONS row 338; migration 0233): prepaid fees and undo

/** Every account's balance, debits less credits, leaving out the ones at zero. */
const balances = (w: W) => rows(w, 'SELECT account_code AS account,SUM(debit_iqd-credit_iqd) AS n FROM accounting_lines GROUP BY account_code HAVING n<>0 ORDER BY account_code');
const balance = (w: W, account: string) => Number(rows(w, 'SELECT COALESCE(SUM(debit_iqd-credit_iqd),0) AS n FROM accounting_lines WHERE account_code=?', account)[0].n);
const undo = (w: W, id: string, body: Record<string, unknown>) => post(w.app, `/f/courier/remittances/${id}/undo`, body);

test('a prepaid parcel waits for its fee; a transfer carries it — an expense on the order, an entry from the cash, and that much less should arrive', async () => {
  const w = await parcels();
  const o = await overview(w);
  assert.deepEqual(o.prepaid.parcels.map((p: Record<string, unknown>) => [p.order_id, p.due_iqd, p.fee_estimate_iqd]), [['prepaid', 0, 5000]]);
  assert.deepEqual([o.prepaid.count, o.prepaid.more, o.undo], [1, false, true]);
  const body = { category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }], fees: [{ order_id: 'prepaid', fee_iqd: 5000 }] };
  // 55,000 at the door less its 5,000, less the prepaid parcel's 5,000 the courier also kept: 45,000 should arrive.
  const short = await transfer(w, { ...body, amount_iqd: 44000 });
  assert.equal((await json(short)).code, 'COURIER_SHORT', 'the owner’s rule counts the prepaid fee too');
  const res = await transfer(w, { ...body, amount_iqd: 45000 });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.equal((await json(res)).parcels, 2);
  assert.deepEqual(rows(w, 'SELECT amount_iqd,collected_iqd,fee_iqd,difference_iqd,parcels FROM courier_remittances'),
    [{ amount_iqd: 45000, collected_iqd: 55000, fee_iqd: 10000, difference_iqd: 0, parcels: 2 }]);
  const fee = rows(w, 'SELECT order_id,fee_iqd,expense_id FROM courier_remittance_fees')[0];
  assert.deepEqual([fee.order_id, fee.fee_iqd], ['prepaid', 5000]);
  assert.deepEqual(rows(w, 'SELECT e.category_id,e.amount_iqd,e.expense_day,l.order_id FROM operating_expenses e JOIN finance_expense_links l ON l.expense_id=e.id WHERE e.id=?', fee.expense_id),
    [{ category_id: 'rent', amount_iqd: 5000, expense_day: '2026-11-10', order_id: 'prepaid' }], 'linked to the order: its profit counts it');
  assert.deepEqual(rows(w, `SELECT l.account_code AS account,l.debit_iqd AS debit,l.credit_iqd AS credit FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id
      WHERE e.event_key='courier-fee:op-transfer-1:prepaid' ORDER BY l.account_code`), [{ account: '1000', debit: 0, credit: 5000 }, { account: '5200', debit: 5000, credit: 0 }]);
  assert.equal(balance(w, '1000'), 45000, 'the books’ cash is what arrived');
  assert.deepEqual((await overview(w)).prepaid.parcels, [], 'its fee is recorded');
  const detail = await w.read('/f/courier/remittances/op-transfer-1');
  assert.deepEqual(detail.parcels.map((p: Record<string, unknown>) => [p.order_id, p.kind, p.collected_iqd, p.fee_iqd, p.net_iqd]),
    [['a', 'cash', 55000, 5000, 50000], ['prepaid', 'fee', 0, 5000, -5000]]);
  const audit = rows(w, "SELECT json_extract(detail,'$.prepaid') AS prepaid,json_extract(detail,'$.fee_iqd') AS fee FROM audit_log WHERE action='finance.courier_remittance_recorded'");
  assert.deepEqual(audit, [{ prepaid: '[["prepaid",5000]]', fee: 10000 }]);
  // The fee belongs to its transfer: never edited, voided, moved or deleted on its own.
  assert.throws(() => w.raw.exec(`UPDATE operating_expenses SET voided_at='x' WHERE id='${fee.expense_id}'`), /Correct the source operation/);
  assert.throws(() => w.raw.exec(`UPDATE finance_expense_links SET order_id='a' WHERE expense_id='${fee.expense_id}'`), /Correct the source operation/);
  assert.throws(() => w.raw.exec('UPDATE courier_remittance_fees SET fee_iqd=1'), /immutable/);
  assert.throws(() => w.raw.exec('DELETE FROM courier_remittance_fees'), /immutable/);
});

test('what a prepaid line cannot be: a parcel with cash, not the courier’s, twice, alone, more than the cash, or settled already; a fee of 0 settles one', async () => {
  const w = await parcels();
  const refuse = async (body: Record<string, unknown>, code: string) => {
    const res = await transfer(w, { amount_iqd: 100000, category_id: 'rent', ...body });
    assert.equal((await json(res)).code, code, code);
  };
  await refuse({ parcels: [{ order_id: 'a', fee_iqd: 0 }], fees: [{ order_id: 'b', fee_iqd: 5000 }] }, 'COURIER_NOT_PREPAID');
  await refuse({ parcels: [{ order_id: 'a', fee_iqd: 0 }], fees: [{ order_id: 'pickup', fee_iqd: 5000 }] }, 'COURIER_NOT_A_PARCEL');
  await refuse({ parcels: [{ order_id: 'a', fee_iqd: 0 }], fees: [{ order_id: 'a', fee_iqd: 5000 }] }, 'COURIER_DUPLICATE_PARCEL');
  await refuse({ parcels: [], fees: [{ order_id: 'prepaid', fee_iqd: 5000 }] }, 'COURIER_FEES_ONLY');
  await refuse({ parcels: [{ order_id: 'b', collected_iqd: 4000, fee_iqd: 0 }], fees: [{ order_id: 'prepaid', fee_iqd: 5000 }] }, 'COURIER_FEES_EXCEED');
  await refuse({ parcels: Array.from({ length: MAX_REMITTANCE_PARCELS }, (_, i) => ({ order_id: `x${i}`, fee_iqd: 0 })), fees: [{ order_id: 'prepaid', fee_iqd: 0 }] }, 'COURIER_TOO_MANY_PARCELS');
  assert.equal(rows(w, 'SELECT 1 FROM courier_remittance_fees').length, 0, 'nothing written');
  const zero = await transfer(w, { amount_iqd: 50000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }], fees: [{ order_id: 'prepaid', fee_iqd: 0 }] });
  assert.equal(zero.status, 200);
  assert.deepEqual(rows(w, 'SELECT fee_iqd,expense_id FROM courier_remittance_fees'), [{ fee_iqd: 0, expense_id: null }], 'settled with no expense');
  assert.equal(rows(w, "SELECT 1 FROM accounting_entries WHERE event_key LIKE 'courier-fee:%'").length, 0, 'and no entry');
  assert.deepEqual((await overview(w)).prepaid.parcels, [], 'no longer waiting');
  const again = await post(w.app, '/f/courier/remittances', { operation_id: 'op-transfer-2', received_day: '2026-11-11', amount_iqd: 20000, category_id: 'rent',
    parcels: [{ order_id: 'b', fee_iqd: 5000 }], fees: [{ order_id: 'prepaid', fee_iqd: 5000 }] });
  assert.equal((await json(again)).code, 'COURIER_FEE_RECORDED', 'one transfer holds a prepaid parcel’s fee');
});

test('undo: the transfer taken back as if never recorded — parcels and fees back, expenses voided and locked, each entry reversed on its day; it stays, undone', async () => {
  const w = await parcels();
  const start = balances(w);
  // 85,000 cash − 10,000 fees − the prepaid 5,000 = 70,000 should arrive; 72,000 did (2,000 more).
  const body = { amount_iqd: 72000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }, { order_id: 'b', fee_iqd: 5000 }], fees: [{ order_id: 'prepaid', fee_iqd: 5000 }] };
  assert.equal((await transfer(w, body)).status, 200);
  assert.notDeepEqual(balances(w), start);
  assert.equal((await json(await undo(w, 'op-transfer-1', { reason: '  ' }))).code, 'COURIER_UNDO_REASON', 'a reason is required');
  const res = await undo(w, 'op-transfer-1', { reason: 'حدّدت طردًا خطأً' });
  assert.deepEqual(await json(res), { success: true, already: false, parcels: 3 });
  assert.deepEqual(balances(w), start, 'every account is back where it was before the transfer');
  for (const t of ['finance_collections', 'courier_remittance_orders', 'courier_remittance_fees']) assert.equal(rows(w, `SELECT 1 FROM ${t}`).length, 0, t);
  assert.deepEqual(rows(w, 'SELECT o.event_key AS original,r.entry_day AS day,r.source_type AS source FROM accounting_entries r JOIN accounting_entries o ON o.id=r.reversal_of ORDER BY o.event_key'), [
    { original: 'collection:op-transfer-1:1', day: '2026-11-10', source: 'courier_remittance' },
    { original: 'collection:op-transfer-1:2', day: '2026-11-10', source: 'courier_remittance' },
    { original: 'courier-difference:op-transfer-1', day: '2026-11-10', source: 'courier_remittance' },
    { original: 'courier-fee:op-transfer-1:prepaid', day: '2026-11-10', source: 'courier_remittance' },
  ], 'each entry reversed once, on the transfer’s own day');
  const fees = rows(w, "SELECT id,note,voided_at IS NOT NULL AS voided,voided_by,void_reason FROM operating_expenses WHERE title='أجرة شركة التوصيل' ORDER BY note");
  assert.deepEqual(fees.map((e) => [e.note, e.voided, e.voided_by]), [['a', 1, 'admin'], ['b', 1, 'admin'], ['prepaid', 1, 'admin']]);
  assert.ok(fees.every((e) => String(e.void_reason).includes('حدّدت طردًا خطأً')), 'voided with the reason');
  for (const e of fees) {
    assert.throws(() => w.raw.exec(`UPDATE operating_expenses SET voided_at=NULL,voided_by=NULL WHERE id='${e.id}'`), /Correct the source operation/, 'a restore would count the fee twice');
    assert.throws(() => w.raw.exec(`DELETE FROM operating_expenses WHERE id='${e.id}'`), /Correct the source operation/);
  }
  assert.deepEqual(rows(w, 'SELECT order_id,kind,collected_iqd,fee_iqd,collection_id IS NOT NULL AS collection FROM courier_remittance_undone ORDER BY kind,order_id'), [
    { order_id: 'a', kind: 'cash', collected_iqd: 55000, fee_iqd: 5000, collection: 1 },
    { order_id: 'b', kind: 'cash', collected_iqd: 30000, fee_iqd: 5000, collection: 1 },
    { order_id: 'prepaid', kind: 'fee', collected_iqd: 0, fee_iqd: 5000, collection: 0 },
  ], 'what it held is kept');
  const o = await overview(w);
  assert.deepEqual(o.pending.parcels.map((p: Record<string, unknown>) => p.order_id), ['a', 'b', 'free'], 'its parcels are with the courier again');
  assert.deepEqual(o.prepaid.parcels.map((p: Record<string, unknown>) => p.order_id), ['prepaid']);
  assert.deepEqual([o.unreconciled.count, o.unreconciled.amount_iqd, o.first_time], [0, 0, true], 'it waits for no check, and the opening is offered again');
  const row = o.remittances[0];
  assert.deepEqual([row.id, row.state, row.undo_reason, row.undone_by_name, typeof row.undone_at], ['op-transfer-1', 'received', 'حدّدت طردًا خطأً', 'Owner', 'string']);
  const detail = await w.read('/f/courier/remittances/op-transfer-1');
  assert.deepEqual(detail.parcels.map((p: Record<string, unknown>) => [p.order_id, p.kind, p.net_iqd]), [['a', 'cash', 50000], ['b', 'cash', 25000], ['prepaid', 'fee', -5000]]);
  const audit = rows(w, "SELECT json_extract(detail,'$.reason') AS reason,json_extract(detail,'$.parcels') AS parcels FROM audit_log WHERE action='finance.courier_remittance_undone' AND target='op-transfer-1'");
  assert.deepEqual(audit, [{ reason: 'حدّدت طردًا خطأً', parcels: '[["a",55000,5000],["b",30000,5000]]' }]);
  // Once and final: a retry is `already`; it is never checked; the same operation is not answered «recorded».
  assert.deepEqual(await json(await undo(w, 'op-transfer-1', { reason: 'again' })), { success: true, already: true, parcels: 0 });
  assert.equal((await json(await post(w.app, '/f/courier/remittances/op-transfer-1/reconcile', {}))).code, 'COURIER_UNDONE');
  assert.throws(() => w.raw.exec("UPDATE courier_remittances SET state='reconciled',reconciled_at='x',reconciled_by='admin' WHERE id='op-transfer-1'"), /cannot be reconciled/);
  assert.equal((await json(await transfer(w, body))).code, 'COURIER_OPERATION_UNDONE');
  assert.throws(() => w.raw.exec('DELETE FROM courier_remittance_voids'), /final/);
  assert.throws(() => w.raw.exec('UPDATE courier_remittance_undone SET fee_iqd=0'), /final/);
  // The owner records it again, corrected, as a new transfer.
  const fixed = await post(w.app, '/f/courier/remittances', { operation_id: 'op-transfer-2', received_day: '2026-11-10', reference: 'Z-1001', amount_iqd: 50000, category_id: 'rent',
    parcels: [{ order_id: 'a', fee_iqd: 5000 }] });
  assert.equal(fixed.status, 200);
  const after = await overview(w);
  assert.deepEqual([after.first_time, after.unreconciled.count, after.pending.parcels.map((p: Record<string, unknown>) => p.order_id)], [false, 1, ['b', 'free']]);
  assert.equal(balance(w, '1000'), 50000);
});

test('undo: the cash of a parcel whose sale was posted later waited as an advance (2300); undone, the receivable is back on 1100 where the sale looks for it', async () => {
  const w = await parcels();
  order(w.raw, { id: 'c', qty: 1, delivered: '2026-11-06T09:00:00.000Z' });
  // Neither 'free' nor 'c' has its sale in the journal yet: their cash is booked against 2300.
  assert.equal((await transfer(w, { amount_iqd: 45000, category_id: 'rent', parcels: [{ order_id: 'free', fee_iqd: 5000 }, { order_id: 'c', fee_iqd: 5000 }] })).status, 200);
  assert.equal(balance(w, '2300'), -55000);
  // Then the sale of 'free' is posted, taking its advance.
  await w.db.batch(journalPlan(w.db, { key: 'sale:free', day: '2026-11-11', title: 'بيع', source: 'order', sourceId: 'free', actor: 'admin' },
    [{ account: '2300', debit: 25000 }, { account: '4000', credit: 25000 }]).statements);
  assert.equal((await undo(w, 'op-transfer-1', { reason: 'خطأ' })).status, 200);
  assert.deepEqual([balance(w, '2300'), balance(w, '1100'), balance(w, '1000'), balance(w, '5200')], [0, 85000 + 25000, 0, 0],
    'the posted sale keeps its advance used and the courier owes its cash again; the unposted one’s advance is simply gone');
});

test('undo is refused for a checked transfer, in a closed month and to an assistant; an unknown transfer is not found', async () => {
  const w = await parcels();
  await transfer(w, { amount_iqd: 50000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }] });
  await post(w.app, '/f/courier/remittances/op-transfer-1/reconcile', {});
  const checked = await undo(w, 'op-transfer-1', { reason: 'x' });
  assert.deepEqual([checked.status, (await json(checked)).code], [409, 'COURIER_RECONCILED']);
  assert.throws(() => w.raw.exec("INSERT INTO courier_remittance_voids(remittance_id,reason,actor_id,created_at) VALUES ('op-transfer-1','x','admin','t')"), /cannot be undone/);
  assert.equal((await post(w.app, '/f/courier/remittances', { operation_id: 'op-transfer-2', received_day: '2026-11-10', amount_iqd: 25000, category_id: 'rent', parcels: [{ order_id: 'b', fee_iqd: 5000 }] })).status, 200);
  w.raw.exec("INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES ('2026-11','2026-12-01T00:00:00.000Z','admin')");
  const closed = await undo(w, 'op-transfer-2', { reason: 'x' });
  assert.deepEqual([closed.status, (await json(closed)).code], [409, 'PERIOD_CLOSED']);
  w.raw.exec('DELETE FROM accounting_periods');
  assert.equal((await undo(w, 'nope', { reason: 'x' })).status, 404);
  const helper = stubApp(asD1(w.raw), { id: 'helper', email: 'h@x.co', role: 'admin', admin_scope: 'assistant' }, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  assert.equal((await post(helper, '/f/courier/remittances/op-transfer-2/undo', { reason: 'x' })).status, 403);
  assert.equal(rows(w, 'SELECT 1 FROM courier_remittance_voids').length, 0, 'nothing undone');
});

test('before migration 0233: the page reads with no prepaid parcel and no undo; a transfer without prepaid lines records; prepaid lines and undo wait', async () => {
  const w = await parcels();
  // As a database before 0233 is: none of its tables, none of its triggers.
  w.raw.exec(`DROP TRIGGER courier_fee_expense_update; DROP TRIGGER courier_fee_expense_delete; DROP TRIGGER courier_fee_expense_link_update;
    DROP TRIGGER courier_fee_expense_link_delete; DROP TRIGGER courier_remittance_reconcile_not_void; DROP TRIGGER courier_remittance_order_no_delete;
    DROP TABLE courier_remittance_undone; DROP TABLE courier_remittance_voids; DROP TABLE courier_remittance_fees;`);
  const o = await overview(w);
  assert.deepEqual([o.pending.count, o.prepaid.count, o.undo, o.first_time], [3, 0, false, true]);
  assert.equal((await transfer(w, { amount_iqd: 50000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }] })).status, 200);
  const row = (await overview(w)).remittances[0];
  assert.deepEqual([row.id, row.undone_at, row.undo_reason], ['op-transfer-1', null, '']);
  assert.equal((await w.read('/f/courier/remittances/op-transfer-1')).parcels.length, 1);
  const prepaid = await post(w.app, '/f/courier/remittances', { operation_id: 'op-transfer-2', received_day: '2026-11-10', amount_iqd: 25000, category_id: 'rent',
    parcels: [{ order_id: 'b', fee_iqd: 5000 }], fees: [{ order_id: 'prepaid', fee_iqd: 0 }] });
  assert.equal(prepaid.status, 503);
  assert.equal((await undo(w, 'op-transfer-1', { reason: 'x' })).status, 503);
  assert.deepEqual(await json(await post(w.app, '/f/courier/remittances/op-transfer-1/reconcile', {})), { success: true, already: false });
});

test('the expense routes refuse a fee a courier transfer holds, in words that send the owner to the courier page', async () => {
  const w = await parcels();
  const app = stubApp(w.db, { id: 'admin', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => {
    a.route('/f', adminFinanceWorkspaceRoutes); a.route('/e', adminFinanceRoutes); a.route('/o', adminFinanceOperationsRoutes);
  });
  assert.equal((await transfer(w, { amount_iqd: 45000, category_id: 'rent', parcels: [{ order_id: 'a', fee_iqd: 5000 }], fees: [{ order_id: 'prepaid', fee_iqd: 5000 }] })).status, 200);
  const refused = async (res: Response, what: string) => {
    const b = await json(res);
    assert.deepEqual([res.status, b.code], [409, 'COURIER_FEE_EXPENSE'], what);
    assert.match(String(b.error), /أموال لدى شركة التوصيل/, what);
  };
  const live = String(rows(w, 'SELECT expense_id FROM courier_remittance_fees')[0].expense_id);
  await refused(await patch(app, `/e/expenses/${live}`, { amount_iqd: 1 }), 'edit');
  await refused(await send(app, 'DELETE', `/e/expenses/${live}?reason=x`), 'void');
  await refused(await post(app, '/o/expense-links', { expense_id: live, order_id: 'a' }), 'moved to another order');
  assert.equal((await undo(w, 'op-transfer-1', { reason: 'خطأ' })).status, 200);
  const voided = rows(w, 'SELECT id FROM operating_expenses WHERE voided_at IS NOT NULL').map((r) => String(r.id));
  assert.equal(voided.length, 2, 'the parcel’s fee and the prepaid fee');
  for (const id of voided) await refused(await post(app, `/e/expenses/${id}/restore`, {}), 'restored');
  // Any other expense is as it was.
  w.raw.exec("INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent-nov','rent',100000,'2026-11-02','إيجار','admin')");
  const voidRent = await send(app, 'DELETE', '/e/expenses/rent-nov?reason=x');
  assert.equal(voidRent.status, 200, JSON.stringify(await json(voidRent.clone())));
  assert.equal((await post(app, '/e/expenses/rent-nov/restore', {})).status, 200);
});
