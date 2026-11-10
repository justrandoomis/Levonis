/**
 * «تسوية الأجور» ON SCREEN (owner 2026-11-10; DECISIONS row 306).
 *
 * The owner settled three employees through the API; this is the screen for
 * the next one. The dialog's own request code (wageSettlement.ts, through
 * src/lib/api.ts) runs here against the real routes on a test database:
 *   - the preview writes nothing and shows earned / paid / owed before → agreed,
 *     the change, each order whose wage moves, and the investor whose goods a
 *     cut order sold (their profit rises by their agreed share of the cut);
 *   - the apply sends the preview's `owed_before_iqd` and one operation id, and
 *     a retried apply answers with the settlement it already made;
 *   - each refusal (an open withdrawal, an open cash advance, a recalculation
 *     still running, a period already settled, wages changed since the preview)
 *     comes back with its code and is said in ar, en and ckb with what to do;
 *   - the day is today (Baghdad) at most and after the last settlement;
 *   - the Staff tab offers it to the owner only, on live and removed employees.
 *
 * Run: node --import tsx --test tests/wageSettlementDialog.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { asD1, count, ctx, freshDb, get, json, post, row, send, stubApp, type App } from './fixtures/app';
import { codeOf } from './fixtures/source';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { planOrderFinanceSnapshot } from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import { settleStaffWages } from '../worker/lib/staffSettlement';
import { ApiError } from '../src/lib/api';
import { PERSON_FINANCE_STRINGS } from '../src/lib/personFinanceStrings';
import { applySettlement, baghdadToday, previewSettlement, settlementDays, settlementProblem, settlementRefusal, type SettlementPreview } from '../src/components/financePeople/wageSettlement';
import { SettlementPreviewView, SettlementRefusalBox } from '../src/components/financePeople/WageSettlementView';

const PEOPLE = '/api/admin/finance-people', OPS = '/api/admin/finance-operations';
const LANGS = ['ar', 'en', 'ckb'] as const;

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES
    ('boss','boss@x.co','Owner','admin','full'),
    ('employee','employee@example.test','Hussein','admin','assistant'),
    ('inv','inv@example.test','Sajjad Amer','admin','assistant'),
    ('buyer','buyer@example.test','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,stock,inventory_mode) VALUES ('printer','Printer','settle-printer',50000,0,'BASE');
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by)
      VALUES ('inc','printer','base','',5,5,20000,0,0,'supplier','received','boss');
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at,incoming_id,supplier_id)
      VALUES ('lot:investor','printer','base','',5,4,20000,100000,'received','2026-09-01','inc','supplier');
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json)
      VALUES ('ic','inc','inv','Printers',100000,10000,4500,0,'boss','2026-09-01T00:00:00.000Z','{}');`);
  const db = asD1(raw);
  const app = (id: string, scope = 'assistant') => stubApp(db, { id, email: id === 'boss' ? 'boss@x.co' : `${id}@example.test`, role: 'admin', admin_scope: scope }, (a) => {
    a.route(PEOPLE, adminFinancePeopleRoutes);
    a.route(OPS, adminFinanceOperationsRoutes);
    a.route('/api/finance-earnings', financeEarningsRoutes);
  });
  const boss = app('boss', 'full');
  /** One printer at 50,000 delivered on `delivered`; `investor`: sold from the investor's lot. */
  async function order(id: string, delivered: string, investor = false) {
    const created = '2026-09-01T10:00:00.000Z', lot = investor ? 'lot:investor' : `lot:${id}`;
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',50000,1500,55000,55000,5000,?,?)`).run(id, created, delivered);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis)
      VALUES (?,?,'printer','Printer',1,50000,50000,20000,'snapshot')`).run(`line:${id}`, id);
    if (!investor) raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
      VALUES (?,'printer','base',1,0,20000,'opening',?)`).run(lot, created);
    raw.prepare(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key)
      VALUES (?,?,?,?,'base',1,20000,20000,?)`).run(`alloc:${id}`, id, `line:${id}`, lot, `consumed:${id}`);
    await db.batch(await planOrderFinanceSnapshot(db, id, [{ id: `line:${id}`, product_id: 'printer' }], created));
  }
  /** Hussein at 2,500 a unit, three delivered orders (the third from the investor's lot), wages calculated. */
  async function employee() {
    for (const [id, day, investor] of [['o21', '21', false], ['o22', '22', false], ['inv23', '23', true]] as const) await order(id, `2026-09-${day}T10:00:00.000Z`, investor);
    const linked = await json(await post(boss, `${PEOPLE}/staff`, { user_id: 'employee', start_work_date: '2026-09-20' }));
    assert.ok(linked.id, JSON.stringify(linked));
    assert.equal((await post(boss, `${OPS}/rules`, { staff_id: linked.id, basis: 'unit', amount: 2500, milestone: 'delivered' })).status, 200);
    for (let i = 0; i < 60; i++) {
      const page = await json(await post(boss, `${PEOPLE}/staff/${linked.id}/reconcile`));
      if (page.reconciliation?.state === 'complete') return linked.id as string;
    }
    return assert.fail('the wages were not calculated');
  }
  return { raw, db, boss, self: app('employee'), employee, order };
}

/** The dialog's requests reach the owner's routes; every body it sends is kept. */
async function asOwner<T>(boss: App, run: (sent: Array<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const real = globalThis.fetch, sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
    if (typeof init?.body === 'string') sent.push(JSON.parse(init.body));
    const headers = new Headers(init?.headers); headers.set('CF-Connecting-IP', '1.2.3.4');
    return boss.request(path, { ...init, headers }, undefined, ctx);
  }) as typeof fetch;
  try { return await run(sent); } finally { globalThis.fetch = real; }
}
const refusalOf = async (work: Promise<unknown>) => {
  try { await work; } catch (error) { assert.ok(error instanceof ApiError, String(error)); return settlementRefusal(error); }
  return assert.fail('the server did not refuse');
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const AGREED = { through_day: '2026-10-01', owed_iqd: 3000, reason: '  اتفاق نهائي عند ترك العمل  ' };

test('preview: earned / paid / owed before → agreed, the change, each order, and the investor whose goods a cut order sold — nothing written', async () => {
  const { raw, boss, employee } = setup();
  const id = await employee();
  const preview = await asOwner(boss, () => previewSettlement(id, AGREED));
  assert.deepEqual({ earned: preview.earned_before_iqd, paid: preview.paid_before_iqd, owed: preview.owed_before_iqd, agreed: preview.owed_iqd, change: preview.change_iqd, rows: preview.rows, adjusted: preview.adjusted, reversed: preview.reversed },
    { earned: 7500, paid: 0, owed: 7500, agreed: 3000, change: -4500, rows: 3, adjusted: 3, reversed: 0 });
  // The agreed amount rides on every order in the same proportion.
  assert.deepEqual(preview.order_changes, [
    { order_id: 'o21', before_iqd: 2500, after_iqd: 1000 }, { order_id: 'o22', before_iqd: 2500, after_iqd: 1000 }, { order_id: 'inv23', before_iqd: 2500, after_iqd: 1000 }]);
  // inv23 sold the investor's printer: its wage falls 1,500, so its profit rises 1,500, and the investor takes 45% of it.
  assert.deepEqual(preview.investors, [{ user_id: 'inv', name: 'Sajjad Amer', share_bps: [4500], orders: [{ order_id: 'inv23', share_bps: 4500 }], wage_change_iqd: -1500, profit_change_iqd: 675 }]);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_cost_adjustments'), 0);

  for (const lang of LANGS) {
    const s = PERSON_FINANCE_STRINGS[lang], t = s.settle;
    const html = renderToStaticMarkup(createElement(SettlementPreviewView, { preview, s, lang }));
    const shown = text(html);
    for (const want of [t.ordersThrough, t.rowsLine(3, 3, 0), t.earned, t.paid, t.owedBefore, t.agreed, t.change, t.paidStays, t.investorTitle, t.investorWhy, t.investorOrders(1), t.investorLess, t.ordersTitle(3), t.final, 'Sajjad Amer', '45%', 'o21', 'inv23', '7,500', '3,000', '-4,500', '675'])
      assert.ok(shown.includes(want), `${lang}: «${want}» missing`);
    assert.ok(shown.includes(t.investorUp), `${lang}: a cut raises the investor's profit`);
    assert.match(html, /data-settlement-investors/);
    // Each order reads before → after in the reader's direction.
    assert.ok(shown.includes(lang === 'en' ? '2,500 IQD → 1,000 IQD' : '2,500 د.ع ← 1,000 د.ع'), `${lang}: ${shown}`);
  }
  // A raise lowers the investor's share, and is said so.
  const raise: SettlementPreview = { ...preview, owed_iqd: 9000, change_iqd: 1500, investors: [{ ...preview.investors[0], wage_change_iqd: 500, profit_change_iqd: -225 }] };
  assert.ok(text(renderToStaticMarkup(createElement(SettlementPreviewView, { preview: raise, s: PERSON_FINANCE_STRINGS.en, lang: 'en' }))).includes(`${PERSON_FINANCE_STRINGS.en.settle.investorDown} 225 IQD`));
  // An order that sold two investors' goods names both, each with its own agreement's share.
  const two: SettlementPreview = { ...preview, investors: [...preview.investors, { user_id: 'other', name: 'Other Investor', share_bps: [3000], orders: [{ order_id: 'inv23', share_bps: 3000 }], wage_change_iqd: -1500, profit_change_iqd: 450 }] };
  const both = text(renderToStaticMarkup(createElement(SettlementPreviewView, { preview: two, s: PERSON_FINANCE_STRINGS.en, lang: 'en' })));
  for (const chip of ['Sajjad Amer · 45%', 'Other Investor · 30%']) assert.ok(both.includes(chip), `«${chip}» missing: ${both}`);
});

test('the investors named are the ones whose profit the cut reaches: delivered orders and goods still sold only', async () => {
  const { raw, boss, employee, order } = setup();
  // Two more orders from the investor's lot: one cancelled after delivery, one whose printer came back to stock.
  await order('invC24', '2026-09-24T10:00:00.000Z', true);
  await order('invR25', '2026-09-25T10:00:00.000Z', true);
  const id = await employee();
  raw.exec("UPDATE orders SET status='cancelled' WHERE id='invC24'");
  raw.exec(`INSERT INTO order_item_inventory_allocations(id,order_id,order_item_id,lot_id,scope,qty,unit_cost_iqd,cogs_iqd,idempotency_key,released_at)
    VALUES ('release:invR25','invR25','line:invR25','lot:investor','base',1,20000,20000,'released:invR25','2026-09-26T10:00:00.000Z')`);
  const preview = await asOwner(boss, () => previewSettlement(id, { ...AGREED, owed_iqd: 5000 }));
  // Both stay in the settlement (they were delivered before the day) …
  assert.deepEqual(preview.order_changes.map((o) => o.order_id).sort(), ['inv23', 'invC24', 'invR25', 'o21', 'o22']);
  // … but neither pays the investor a profit, so only inv23 counts for them.
  assert.deepEqual(preview.investors.map((v) => ({ orders: v.orders.map((o) => o.order_id), wages: v.wage_change_iqd })), [{ orders: ['inv23'], wages: preview.order_changes.find((o) => o.order_id === 'inv23')!.after_iqd - 2500 }]);
});

test('a retry sent while its first request was still being written answers with that settlement, not «already settled»', async () => {
  const { raw, db, employee } = setup();
  const id = await employee();
  const input = { staffId: id, throughDay: '2026-10-01', owedIqd: 3000, reason: 'x', actor: 'boss', expectedOwedBefore: 7500, operationId: 'settle-cross-0001' };
  const first = await settleStaffWages(db, input);
  assert.equal('already' in first, false);
  // The retry looked for its settlement a moment before the first one landed …
  let hidden = false;
  const racing = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => (!hidden && sql.startsWith('SELECT * FROM finance_staff_settlements WHERE id=?') ? (hidden = true, { bind: () => ({ first: async () => null }) }) : target.prepare(sql));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  // … then found the period settled by that very request: it answers with it.
  const again = await settleStaffWages(racing, input);
  assert.equal(hidden, true);
  assert.equal('already' in again && again.already, true);
  assert.equal(again.settlement.through_day, '2026-10-01');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 1);
  // Another request that finds the period settled is still refused.
  await assert.rejects(settleStaffWages(db, { ...input, operationId: 'settle-cross-0002' }), (e: unknown) => (e as { code?: string }).code === 'SETTLE_ALREADY_SETTLED');
});

test('apply: the preview\'s owed-before and one operation id are sent; a retried apply returns the same settlement; the period is then settled', async () => {
  const { raw, boss, employee } = setup();
  const id = await employee();
  await asOwner(boss, async (sent) => {
    const preview = await previewSettlement(id, AGREED);
    assert.deepEqual(sent.at(-1), { through_day: '2026-10-01', owed_iqd: 3000, reason: 'اتفاق نهائي عند ترك العمل', preview: true });
    const done = await applySettlement(id, preview, AGREED.reason, 'settle-dialog-0001');
    assert.deepEqual(done, { already: false, through_day: '2026-10-01', owed_iqd: 3000 });
    assert.deepEqual(sent.at(-1), { through_day: '2026-10-01', owed_iqd: 3000, reason: 'اتفاق نهائي عند ترك العمل', preview: false, expected_owed_before_iqd: 7500, operation_id: 'settle-dialog-0001' });
    const saved = row(raw, 'SELECT id,owed_iqd,owed_before_iqd,rows_settled,reason FROM finance_staff_settlements');
    assert.deepEqual({ ...saved }, { id: 'wagesettle_settle-dialog-0001', owed_iqd: 3000, owed_before_iqd: 7500, rows_settled: 3, reason: 'اتفاق نهائي عند ترك العمل' });
    // A timeout after the write: the same request answers with the settlement it made.
    assert.deepEqual(await applySettlement(id, preview, AGREED.reason, 'settle-dialog-0001'), { already: true, through_day: '2026-10-01', owed_iqd: 3000 });
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 1);
    // The same day again is a period already settled.
    assert.equal(await refusalOf(previewSettlement(id, AGREED)), 'settled');
  });
  // The staff list carries it (the dialog's lower bound, for an employee with no linked account too).
  const listed = (await json(await get(boss, `${PEOPLE}/staff`))).staff.find((s: { id: string }) => s.id === id);
  assert.deepEqual(listed.settlement, { through_day: '2026-10-01', owed_iqd: 3000, settlement_day: baghdadDay() });
});

test('each refusal comes back by code and is said in ar, en and ckb: an open withdrawal, a recalculation still running, a period already settled, wages changed since the preview', async () => {
  const { raw, boss, self, employee } = setup();
  const id = await employee();
  const said = (kind: NonNullable<ReturnType<typeof settlementRefusal>>) => {
    for (const lang of LANGS) {
      const s = PERSON_FINANCE_STRINGS[lang];
      const html = renderToStaticMarkup(createElement(SettlementRefusalBox, { kind, s, lang, last: { through_day: '2026-10-01', owed_iqd: 3000 } }));
      assert.match(html, /role="alert"/);
      for (const want of [s.settle.refusedTitle, s.settle.refusal[kind], s.settle.refusalAction[kind]]) assert.ok(text(html).includes(want), `${lang} ${kind}: «${want}» missing`);
      if (kind === 'settled') assert.ok(text(html).includes(s.settledThrough), `${lang}: the last settlement is named`);
    }
  };
  await asOwner(boss, async () => {
    // An open withdrawal holds a row.
    const requested = await post(self, '/api/finance-earnings/withdrawals', { operation_id: 'held-withdrawal-1', amount_iqd: 2500 });
    assert.equal(requested.status, 200, JSON.stringify(await json(requested)));
    assert.equal(await refusalOf(previewSettlement(id, AGREED)), 'withdrawal'); said('withdrawal');
    const withdrawal = row<{ id: string }>(raw, 'SELECT id FROM finance_withdrawals')!;
    assert.equal((await post(boss, `${PEOPLE}/withdrawals/${withdrawal.id}/reject`, { note: 'settlement' })).status, 200);

    // Wages being redone: refused at the preview already, and at the apply.
    const preview = await previewSettlement(id, AGREED);
    raw.exec(`UPDATE finance_staff_reconciliations SET state='pending',cursor='' WHERE staff_id='${id}'`);
    assert.equal(await refusalOf(previewSettlement(id, AGREED)), 'recalculation'); said('recalculation');
    assert.equal(await refusalOf(applySettlement(id, preview, AGREED.reason, 'settle-dialog-0002')), 'recalculation');
    raw.exec(`UPDATE finance_staff_reconciliations SET state='complete' WHERE staff_id='${id}'`);

    // A wage changed since the preview: the apply refuses and asks for a new preview.
    const cost = row<{ id: string }>(raw, `SELECT id FROM finance_order_costs WHERE staff_id='${id}' AND order_id='o21'`)!;
    assert.equal((await send(boss, 'PATCH', `${PEOPLE}/costs/${cost.id}`, { amount_iqd: 2000 })).status, 200);
    assert.equal(await refusalOf(applySettlement(id, preview, AGREED.reason, 'settle-dialog-0003')), 'changed'); said('changed');
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 0);

    // A fresh preview applies; the same period is then refused as settled.
    const fresh = await previewSettlement(id, AGREED);
    assert.equal(fresh.owed_before_iqd, 7000);
    assert.equal((await applySettlement(id, fresh, AGREED.reason, 'settle-dialog-0004')).already, false);
    assert.equal(await refusalOf(previewSettlement(id, { ...AGREED, through_day: '2026-09-25' })), 'settled'); said('settled');
    // A day that has not come (the form stops it first; the server says it too).
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    assert.equal(await refusalOf(previewSettlement(id, { ...AGREED, through_day: tomorrow })), 'future'); said('future');
  });
});

test('an open cash advance is refused by code until it is applied to the wages; a refusal without a code keeps the server\'s words', async () => {
  const { raw, boss, employee } = setup();
  const id = await employee();
  assert.equal((await post(boss, `${OPS}/staff/${id}/payments`, { operation_id: 'advance-0001', amount_iqd: 1000, kind: 'advance' })).status, 200);
  await asOwner(boss, async () => {
    assert.equal(await refusalOf(previewSettlement(id, AGREED)), 'advance');
  });
  for (const lang of LANGS) {
    const s = PERSON_FINANCE_STRINGS[lang];
    const shown = text(renderToStaticMarkup(createElement(SettlementRefusalBox, { kind: 'advance', s, lang })));
    assert.ok(shown.includes(s.settle.refusal.advance) && shown.includes(s.settle.refusalAction.advance), lang);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM finance_staff_settlements'), 0);
  // What the refusal says to do — apply the advance to the wages — opens the settlement; the advance counts as paid.
  for (const cost of raw.prepare(`SELECT id FROM finance_order_costs WHERE staff_id=?`).all(id) as Array<{ id: string }>) assert.equal((await post(boss, `${OPS}/costs/${cost.id}/approve`)).status, 200);
  const applied = await post(boss, `${OPS}/staff/${id}/advance-settlements`, { operation_id: 'advance-use-01', amount_iqd: 1000 });
  assert.equal(applied.status, 200, JSON.stringify(await json(applied)));
  const preview = await asOwner(boss, () => previewSettlement(id, AGREED));
  assert.deepEqual({ paid: preview.paid_before_iqd, owed: preview.owed_before_iqd }, { paid: 1000, owed: 6500 });
  // A refusal the dialog does not name keeps the server's own words.
  assert.equal(settlementRefusal(new ApiError(409, 'تعذر توزيع المبلغ المتفق عليه على أجور الفترة', 'SETTLE_SPLIT')), null);
  assert.equal(settlementRefusal(new Error('network')), null);
});

test('the day: today in Baghdad at most, after the last settlement; settled through yesterday leaves no day today', () => {
  assert.equal(baghdadToday(new Date('2026-11-09T21:30:00.000Z')), '2026-11-10');
  assert.equal(baghdadToday(new Date('2026-11-09T20:59:00.000Z')), '2026-11-09');
  assert.deepEqual(settlementDays('2026-11-10', null), { min: null, max: '2026-11-10', open: true });
  // Hussein, Sousou and Sajjad were settled with the new period starting 10 Nov: nothing is open until tomorrow.
  assert.deepEqual(settlementDays('2026-11-10', { through_day: '2026-11-10', owed_iqd: 75000 }), { min: '2026-11-11', max: '2026-11-10', open: false });
  const days = settlementDays('2026-11-20', { through_day: '2026-11-10', owed_iqd: 75000 });
  assert.deepEqual(days, { min: '2026-11-11', max: '2026-11-20', open: true });
  const ok = { through_day: '2026-11-15', owed_iqd: 0, reason: 'leaving' };
  assert.equal(settlementProblem(ok, days), null);
  assert.equal(settlementProblem({ ...ok, through_day: '' }, days), 'day');
  assert.equal(settlementProblem({ ...ok, through_day: '2026-11-21' }, days), 'future');
  assert.equal(settlementProblem({ ...ok, through_day: '2026-11-10' }, days), 'settled');
  for (const owed of [null, -1, 1.5]) assert.equal(settlementProblem({ ...ok, owed_iqd: owed }, days), 'amount');
  assert.equal(settlementProblem({ ...ok, reason: ' a  ' }, days), 'reason');
  // The counts read right in English, one or many.
  assert.equal(PERSON_FINANCE_STRINGS.en.settle.rowsLine(1, 1, 1), '1 wage in the period · 1 changes · 1 waiting for an order cost is cancelled');
  assert.equal(PERSON_FINANCE_STRINGS.en.settle.rowsLine(10, 7, 0), '10 wages in the period · 7 change');
});

test('the Staff tab offers «تسوية الأجور» to the owner only, on live and removed employees, and previews before it applies', () => {
  const panel = codeOf('src/components/financePeople/PeoplePanel.tsx');
  assert.match(panel, /const settleButton = \(person: Staff\) => canManage && <Button /);
  assert.equal(panel.match(/settleButton\(person\)/g)?.length, 2, 'live and removed employees');
  assert.match(panel, /\{canManage && <div className="fp-row-actions">\{settleButton\(person\)\}<\/div>\}/);
  assert.match(panel, /<WageSettlementDialog staff=\{settling\} last=\{lastSettlement\(settling\.id\)\} onClose=\{\(\) => setSettling\(null\)\} onStale=\{\(\) => void refresh\(\)\}/);
  assert.match(panel, /void op\.run\(refresh, \(\) => s\.settle\.done\(/);
  // The last settlement comes from the staff list first (every employee), the people picture second.
  assert.match(panel, /const lastSettlement = \(staffId: string\) => config\?\.staff\.find\(\(p\) => p\.id === staffId\)\?\.settlement \?\? personOf\(staffId\)/);
  // No raw bidi control characters in the source (the name's isolates are escapes).
  assert.doesNotMatch(panel, /[\u2066-\u2069\u202a-\u202e]/);
  assert.match(panel, /`\\u2068\$\{settling\.name\}\\u2069`/);
  const dialog = codeOf('src/components/financePeople/WageSettlementDialog.tsx');
  assert.match(dialog, /previewSettlement\(staff\.id, \{ through_day: day, owed_iqd: owed, reason \}\);\s*operation\.current = crypto\.randomUUID\(\);/);
  assert.match(dialog, /applySettlement\(staff\.id, preview, reason, operation\.current\)/);
  // Apply exists only beside a preview, and not while a refusal stands.
  assert.match(dialog, /\{preview \? <Button variant="primary" loading=\{op\.busy\} disabled=\{!!refusal\} onClick=\{apply\}>/);
  // Old figures are reloaded: on «already settled» or «changed», and on closing after an apply that got no answer.
  assert.match(dialog, /if \(kind === 'settled' \|\| kind === 'changed'\) onStale\(\);/);
  assert.match(dialog, /const close = \(\) => \{ if \(tried\.current\) onStale\(\); onClose\(\); \};/);
  assert.match(dialog, /setRefusal\(null\); tried\.current = true;/);
  assert.match(dialog, /<Dialog open title=\{t\.title\} onClose=\{close\}/);
  // Every word on the dialog comes from personFinanceStrings (checked key for key in tests/personFinanceView.test.ts).
  for (const file of ['WageSettlementDialog.tsx', 'WageSettlementView.tsx', 'wageSettlement.ts']) assert.doesNotMatch(codeOf(`src/components/financePeople/${file}`), /\bloc\(/, file);
  // The client's path is the people routes' own (shared.tsx pulls a stylesheet, so it is written out).
  assert.match(codeOf('src/components/financePeople/shared.tsx'), /export const PEOPLE = '\/api\/admin\/finance-people';/);
  assert.match(codeOf('src/components/financePeople/wageSettlement.ts'), /`\/api\/admin\/finance-people\/staff\/\$\{encodeURIComponent\(staffId\)\}\/settle`/);
});
