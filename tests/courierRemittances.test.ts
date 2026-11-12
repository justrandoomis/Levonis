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
 * Every figure is invented. Run: node --import tsx --test tests/courierRemittances.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, get, json, post, stubApp } from './fixtures/app';
import { order, world } from './fixtures/financeWorld';
import { journalPlan } from '../worker/lib/operations';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
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
