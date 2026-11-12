/**
 * THE BOOKS' OWN CHECKS (worker/lib/financeChecks.ts) AND THEIR DAILY WORD TO THE ADMIN GROUP (financeChecksAlert.ts) —
 * the owner's brief, 2026-11-12, part 4: «reconciliation, and automated consistency checks».
 *
 * - A clean database finds nothing, and is ok.
 * - Each check finds exactly the one thing seeded for it — its count, its money and its id — and nothing seeded for another
 *   check: an unbalanced posted entry (the posting trigger dropped, as only a hand-written fix could), a failed posting,
 *   more cash at the door than was due, a delivered order with no day, a staff payment shared out beyond its amount, a
 *   delivered order with no sale in the journal (and an order delivered before the journal's first sale, which is not
 *   news), an order cancelled after delivery with its sale still in the journal (and one already reversed, which is not),
 *   a walk-back, cash on a cancelled order, a month with a waiting cost, an expense linked to a cancelled order.
 * - The route answers the same, to the owner only.
 * - The daily word: not before 09:00 Baghdad, once a day; a fault every day it stands, a warning only when what is found
 *   changes, «all clear» once after a day that found something; it names what and how many, never an amount.
 *
 * Every figure is invented. Run: node --import tsx --test tests/financeChecks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { journalPlan } from '../worker/lib/operations';
import { runFinanceChecks, FINANCE_CHECKS, type FinanceCheckKey } from '../worker/lib/financeChecks';
import { dailyFinanceChecks, foundMessage, clearMessage, CHECK_WORDS, FINANCE_CHECKS_STATE_KEY } from '../worker/lib/financeChecksAlert';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import type { Env } from '../worker/lib/types';

type Raw = ReturnType<typeof freshDb>;
function base(): Raw {
  const raw = freshDb();
  raw.exec("INSERT INTO users(id,name,email,role) VALUES ('boss','المالك','boss@x.co','admin'),('u1','زبون','u1@x.co','customer')");
  raw.exec("INSERT INTO expense_categories(id,slug,name_ar) VALUES ('cat-x','checks-x','تجربة')");
  return raw;
}
function order(raw: Raw, id: string, o: { status: string; stage?: string; delivered?: string | null; total?: number; due?: number; seller?: string }) {
  raw.prepare(`INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
      subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,priority,shipping_type,seller_type,delivered_at)
    VALUES (?,?,?,?,'{"name":"x"}','standard','{}','cash',?,1500,?,?,'2026-11-01T08:00:00.000Z',0,'direct',?,?)`)
    .run(id, 'u1', o.status, o.stage ?? o.status, o.total ?? 30000, o.total ?? 30000, o.due ?? o.total ?? 30000, o.seller ?? 'levonis', o.delivered === undefined ? null : o.delivered);
}
async function sale(raw: Raw, orderId: string, day: string, amount: number) {
  const db = asD1(raw);
  await db.batch(journalPlan(db, { key: `sale:${orderId}`, day, title: 'بيع', source: 'order', sourceId: orderId, actor: 'boss' },
    [{ account: '1100', debit: amount }, { account: '4000', credit: amount }]).statements);
  return (raw.prepare('SELECT id FROM accounting_entries WHERE event_key = ?').get(`sale:${orderId}`) as { id: string }).id;
}
/** The run's moment: the courier checks measure two weeks and a week from it, whatever today is. */
const NOW = new Date('2026-11-12T09:00:00.000Z');
const byKey = async (raw: Raw) => new Map((await runFinanceChecks(asD1(raw), NOW)).checks.map((c) => [c.key, c]));

test('a clean database finds nothing, and is ok', async () => {
  const report = await runFinanceChecks(asD1(base()));
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, FINANCE_CHECKS.length);
  for (const c of report.checks) assert.deepEqual([c.key, c.count, c.sample], [c.key, 0, []], c.key);
  assert.deepEqual(new Set(report.checks.map((c) => c.key)), new Set(Object.keys(CHECK_WORDS)), 'the group has words for every check');
});

/** One thing per check, each seeded apart from the others' rows. */
async function seeded(): Promise<Raw> {
  const raw = base();
  // The journal's first sale (1 Nov) and an order delivered before it with no sale: not news.
  order(raw, 'ORD-0A0000000A', { status: 'delivered', delivered: '2026-11-01T09:00:00.000Z' });
  await sale(raw, 'ORD-0A0000000A', '2026-11-01', 30000);
  order(raw, 'ORD-0A00000001', { status: 'delivered', delivered: '2026-10-30T09:00:00.000Z' });
  // delivered_without_sale
  order(raw, 'ORD-0A00000002', { status: 'delivered', delivered: '2026-11-04T09:00:00.000Z', total: 41000 });
  // journal_unbalanced: a posted entry whose lines disagree (only a hand-written fix can make one).
  raw.exec(`INSERT INTO accounting_entries(id,event_key,entry_day,title,source_type,source_id,state,created_at)
      VALUES ('je-bad','manual:bad','2026-11-05','قيد','manual','bad','draft','2026-11-05T08:00:00.000Z');
    INSERT INTO accounting_lines(id,entry_id,account_code,debit_iqd,credit_iqd) VALUES ('jl-1','je-bad','1000',9000,0),('jl-2','je-bad','3100',0,8000);
    DROP TRIGGER accounting_post; UPDATE accounting_entries SET state='posted' WHERE id='je-bad';`);
  // posting_errors
  order(raw, 'ORD-0A00000003', { status: 'delivered', delivered: '2026-11-05T09:00:00.000Z' });
  await sale(raw, 'ORD-0A00000003', '2026-11-05', 30000);
  raw.exec("INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('cogs:ORD-0A00000003','ORD-0A00000003','x','2026-11-05T09:00:00.000Z')");
  // collections_over_due: 5,000 due at the door, 6,500 recorded.
  order(raw, 'ORD-0A00000004', { status: 'delivered', delivered: '2026-11-06T09:00:00.000Z', total: 5000 });
  await sale(raw, 'ORD-0A00000004', '2026-11-06', 5000);
  raw.exec("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,fee_iqd,collection_day,actor_id,created_at) VALUES ('col-1','ORD-0A00000004','courier',6500,0,'2026-11-07','boss','2026-11-07T08:00:00.000Z')");
  // undated_delivered
  order(raw, 'ORD-0A00000005', { status: 'delivered', delivered: 'not a day', total: 12000 });
  // staff_payment_overallocated: a 1,000 payment shared out as 1,500.
  raw.exec(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot)
      VALUES ('cost-1','ORD-0A0000000A','rule-1',1,'تجهيز','prep','staff_sajjad','cat-x','delivered',1,1500,'2026-11-01','approved','{}');
    INSERT INTO finance_staff_payments(id,staff_id,amount_iqd,kind,payment_day,actor_id,created_at) VALUES ('pay-1','staff_sajjad',1000,'payment','2026-11-02','boss','2026-11-02T08:00:00.000Z');
    INSERT INTO finance_payment_allocations(payment_id,cost_id,amount_iqd) VALUES ('pay-1','cost-1',1500);`);
  // cancelled_after_delivery_in_journal, and one whose sale was reversed already (not news).
  order(raw, 'ORD-0A00000006', { status: 'cancelled', delivered: '2026-11-03T09:00:00.000Z', total: 27000 });
  await sale(raw, 'ORD-0A00000006', '2026-11-03', 27000);
  order(raw, 'ORD-0A00000007', { status: 'cancelled', delivered: '2026-11-03T09:00:00.000Z' });
  const reversed = await sale(raw, 'ORD-0A00000007', '2026-11-03', 30000);
  const db = asD1(raw);
  await db.batch(journalPlan(db, { key: `order-cancel:${reversed}`, day: '2026-11-08', title: 'عكس', source: 'order_cancel', sourceId: 'ORD-0A00000007', actor: 'boss', reversalOf: reversed },
    [{ account: '4000', debit: 30000 }, { account: '1100', credit: 30000 }]).statements);
  // walk_backs
  order(raw, 'ORD-0A00000008', { status: 'processing', stage: 'preparing', delivered: '2026-11-02T09:00:00.000Z', total: 18000 });
  // cash_on_cancelled
  order(raw, 'ORD-0A00000009', { status: 'cancelled', delivered: null, total: 9000 });
  raw.exec("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,fee_iqd,collection_day,actor_id,created_at) VALUES ('col-2','ORD-0A00000009','customer',9000,0,'2026-11-02','boss','2026-11-02T08:00:00.000Z')");
  // courier_money_overdue: a parcel delivered 18 days before the run (before the journal's first sale, so no other check's).
  order(raw, 'ORD-0A0000000B', { status: 'delivered', delivered: '2026-10-25T09:00:00.000Z', total: 22000 });
  // courier_transfers_unchecked: a transfer recorded 10 days before the run and never checked.
  raw.exec(`INSERT INTO courier_remittances(id,reference,received_day,amount_iqd,collected_iqd,fee_iqd,difference_iqd,parcels,created_by,created_at)
    VALUES ('rem-1','Z-1','2026-11-02',4000,5000,1000,0,1,'boss','2026-11-02T08:00:00.000Z')`);
  // pending_cost_months
  raw.exec(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,qty,amount_iqd,cost_day,state,snapshot)
    VALUES ('cost-2','ORD-0A00000002','rule-1',1,'تجهيز','prep','staff_sajjad','cat-x','delivered',1,NULL,'2026-10-15','pending_cost','{}')`);
  // expenses_counting_nowhere: linked to the cancelled order.
  raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,created_by) VALUES ('exp-x','cat-x',7000,'2026-11-02','boss');
    INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('exp-x','ORD-0A00000009');`);
  return raw;
}

test('each check finds exactly the one thing seeded for it — its count, its money, its id', async () => {
  const found = await byKey(await seeded());
  const want: Record<FinanceCheckKey, [number, number | null, string[]]> = {
    journal_unbalanced: [1, 1000, ['je-bad']],
    posting_errors: [1, null, ['ORD-0A00000003']],
    collections_over_due: [1, 1500, ['ORD-0A00000004']],
    undated_delivered: [1, 12000, ['ORD-0A00000005']],
    staff_payment_overallocated: [1, 500, ['pay-1']],
    delivered_without_sale: [1, 41000, ['ORD-0A00000002']],
    cancelled_after_delivery_in_journal: [1, 27000, ['ORD-0A00000006']],
    walk_backs: [1, 18000, ['ORD-0A00000008']],
    cash_on_cancelled: [1, 9000, ['ORD-0A00000009']],
    pending_cost_months: [1, null, ['2026-10']],
    expenses_counting_nowhere: [1, 7000, ['exp-x']],
    courier_money_overdue: [1, 22000, ['ORD-0A0000000B']],
    courier_transfers_unchecked: [1, 4000, ['rem-1']],
  };
  for (const [key, [count, amount, sample]] of Object.entries(want) as Array<[FinanceCheckKey, [number, number | null, string[]]]>) {
    const c = found.get(key)!;
    assert.deepEqual([c.count, c.amount_iqd, c.sample], [count, amount, sample], key);
  }
  const report = await runFinanceChecks(asD1(await seeded()));
  assert.equal(report.ok, false, 'a fault is not ok');
});

test('the first five ids, in order, and the count of all of them', async () => {
  const raw = base();
  for (let i = 1; i <= 7; i++) order(raw, `ORD-0B0000000${i}`, { status: 'processing', stage: 'preparing', delivered: '2026-11-02T09:00:00.000Z', total: 1000 * i });
  const c = (await byKey(raw)).get('walk_backs')!;
  assert.deepEqual([c.count, c.amount_iqd, c.sample], [7, 28000, ['ORD-0B00000001', 'ORD-0B00000002', 'ORD-0B00000003', 'ORD-0B00000004', 'ORD-0B00000005']]);
});

test('the route answers the same, to the owner', async () => {
  const raw = await seeded();
  const app = stubApp(asD1(raw), { id: 'boss', email: 'boss@x.co', role: 'admin' }, (a) => a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes));
  const body = await json(await get(app, '/api/admin/finance-workspace/accounting-checks'));
  assert.equal(body.success, true, JSON.stringify(body).slice(0, 300));
  assert.equal(body.ok, false);
  assert.equal((body.checks as Array<{ key: string; count: number }>).find((c) => c.key === 'walk_backs')!.count, 1);
  const helper = stubApp(asD1(raw), { id: 'helper', email: 'h@x.co', role: 'admin', admin_scope: 'assistant' }, (a) => a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes));
  assert.equal((await get(helper, '/api/admin/finance-workspace/accounting-checks')).status, 403, 'an assistant is refused at the door');
});

// ═══════════════════════════════════════════════ the daily word

const env = (raw: Raw) => ({ DB: asD1(raw), APP_ORIGIN: 'https://shop.example' }) as unknown as Env;
const at = (day: string, hour: number) => new Date(`${day}T${String(hour - 3).padStart(2, '0')}:30:00.000Z`);
const state = (raw: Raw) => JSON.parse((raw.prepare('SELECT value FROM admin_settings WHERE key = ?').get(FINANCE_CHECKS_STATE_KEY) as { value: string } | undefined)?.value ?? 'null');

test('the daily word: not before nine, once a day; a fault every day, a warning when it changes, all clear once', async () => {
  const raw = base();
  order(raw, 'ORD-0C00000001', { status: 'processing', stage: 'preparing', delivered: '2026-11-02T09:00:00.000Z' });
  const e = env(raw);
  assert.deepEqual(await dailyFinanceChecks(e, at('2026-11-10', 8)), { ran: false, sent: null, signature: '' }, 'not before 09:00 Baghdad');
  const first = await dailyFinanceChecks(e, at('2026-11-10', 9));
  assert.deepEqual([first.ran, first.sent, first.signature], [true, 'found', 'walk_backs:1']);
  assert.equal((await dailyFinanceChecks(e, at('2026-11-10', 15))).ran, false, 'once a day');
  // A warning that has not changed is not said again the next day.
  const same = await dailyFinanceChecks(e, at('2026-11-11', 9));
  assert.deepEqual([same.ran, same.sent], [true, null]);
  // A fault is said every day it stands.
  raw.exec("INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('cogs:ORD-0C00000001','ORD-0C00000001','x','2026-11-11T09:00:00.000Z')");
  assert.equal((await dailyFinanceChecks(e, at('2026-11-12', 9))).sent, 'found');
  assert.equal((await dailyFinanceChecks(e, at('2026-11-13', 9))).sent, 'repeat');
  // Everything cleared: said once, then silence.
  raw.exec("DELETE FROM finance_posting_errors; UPDATE orders SET status='delivered', stage='delivered' WHERE id='ORD-0C00000001'");
  assert.equal((await dailyFinanceChecks(e, at('2026-11-14', 9))).sent, 'clear');
  assert.equal((await dailyFinanceChecks(e, at('2026-11-15', 9))).sent, null);
  assert.deepEqual(state(raw), { day: '2026-11-15', signature: '', errors: false });
});

test('the message names what and how many, never an amount; and links the owner’s page', async () => {
  const raw = await seeded();
  const report = await runFinanceChecks(asD1(raw), NOW);
  const text = foundMessage(report, env(raw));
  for (const c of report.checks) assert.ok(text.includes(`${CHECK_WORDS[c.key]}: ${c.count}`), c.key);
  for (const amount of [41000, 27000, 22000, 18000, 12000, 9000, 7000, 4000, 1500, 1000, 500]) {
    assert.ok(!text.includes(String(amount)) && !text.includes(amount.toLocaleString('en-US')), `no amount (${amount}) in the group`);
  }
  assert.ok(text.startsWith('⛔'), 'a fault leads');
  assert.ok(text.endsWith('https://shop.example/admin?tab=finance&finance=accounting'));
  assert.ok(clearMessage(env(raw)).startsWith('✅'));
  assert.ok(!foundMessage(report, { DB: asD1(raw) } as unknown as Env).includes('http'), 'no origin configured: no link');
});
