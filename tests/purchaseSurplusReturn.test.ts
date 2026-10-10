/**
 * THE INVESTMENT REMAINDER RETURNS TO THE INVESTOR'S «أرباحي» (owner request
 * 2026-10-10): 13,000,000 agreed, 12,853,822 landed (purchase + every shipping
 * cost) → 146,178 back to the investor, once, as returned capital, from the
 * cash actually received — at the confirm when the cash is recorded in it, or
 * when «تسجيل تمويل مستلم» records it later.
 *
 * Every money path: the owner's example, cash later, replay and double click,
 * partial cash, overpayment, zero and negative remainders, withdrawal end to
 * end (Dr 3100 / Cr 1000), the snapshot fence, cancellation, later cost edits,
 * several investors and purchases, voided contracts, missing tables, reports,
 * a closed period, privacy of the notice, and the two confirm guards.
 *
 * Run: node --import tsx --test tests/purchaseSurplusReturn.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, put, get, json, all, count, row } from './fixtures/app';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { participantOverview, participantSources, requestWithdrawal, changeWithdrawalState, payWithdrawal } from '../worker/lib/financeParticipants';
import { participantReport } from '../worker/lib/financeParticipantReports';
import { planLotConsumption } from '../worker/lib/inventoryLots';
import { runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { baghdadDay } from '../worker/lib/operations';
import { COST_REFUSALS } from '../packages/contracts/src/costRefusals';
import { SURPLUS_STRINGS } from '../worker/lib/investorSurplus';
import type { Env } from '../worker/lib/types';

const AGREED = 13_000_000, LANDED = 12_853_822, SURPLUS = 146_178;
const OWNER = { id: 'owner', email: 'boss@x.co', role: 'admin', admin_scope: 'full' } as const;

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('owner','boss@x.co','Owner','admin','full'),('investor','investor@x.co','Investor','admin','assistant'),('investor2','investor2@x.co','Second','admin','assistant'),('customer','customer@x.co','Customer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd,stock,inventory_mode) VALUES ('a1','Bambu Lab A1','surplus-a1',3100000,500000,0,'OPTION'),('part','Part','surplus-part',50000,NULL,0,'BASE');
    INSERT INTO product_option_groups(id,product_id,name_en) VALUES('model','a1','Model');
    INSERT INTO product_option_values(id,product_id,group_id,name_en,stock) VALUES('combo','a1','model','Combo',0);`);
  const db = asD1(raw);
  const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => { a.route('/p', adminProcurementRoutes); a.route('/i', adminInvestmentFinanceRoutes); };
  const app = stubApp(db, OWNER, mount);
  const earnings = (user: string) => stubApp(db, { id: user, email: `${user}@x.co`, role: 'admin', admin_scope: 'assistant' }, (a) => a.route('/api/finance-earnings', financeEarningsRoutes));
  /** The owner's shape: 5 × A1 Combo for 12,353,822 + 500,000 shipping = 12,853,822 landed. */
  const payload = (funding: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
    operation_id: crypto.randomUUID(), currency: 'IQD', purchase_day: baghdadDay(), status: 'ordered', cost_state: 'final',
    lines: [{ product_id: 'a1', scope: 'option', scope_id: 'combo', qty_ordered: 5, purchase_cost_mode: 'total', source_total_amount: 12_353_822 }],
    charges: [{ title: 'شحن', amount_iqd: 500_000, basis: 'quantity' }],
    funding: funding ?? { mode: 'store' }, ...extra,
  });
  const investorFunding = (agreed = AGREED, received: number | '' = '', user = 'investor') =>
    ({ mode: 'investor', user_id: user, agreed_iqd: agreed, received_iqd: received, reference: 'INVESTOR-CASH', profit_share_bps: 3500, loss_share_bps: 0 });
  async function confirm(body: Record<string, unknown>) {
    const res = await post(app, '/p/documents', body), data = await json(res);
    assert.equal(res.status, 200, JSON.stringify(data));
    return { id: data.id as string, body, already: !!data.already };
  }
  const detail = async (id: string) => json(await get(app, `/p/documents/${id}`));
  const receipt = (id: string, amount: number, operation: string = crypto.randomUUID(), day = baghdadDay()) =>
    post(app, `/p/documents/${id}/investor-receipts`, { operation_id: operation, amount_iqd: amount, reference: 'BANK', payment_day: day });
  const surplusOf = async (user: string, purchaseId: string) => (await participantOverview(db, user)).entries.find((e) => e.id === `invsurplus:${purchaseId}`);
  const notices = (user = 'investor') => all<{ event_key: string; title_ar: string; title_en: string; body_ar: string; body_en: string; meta: string; kind: string; link: string }>(raw, "SELECT * FROM user_notifications WHERE user_id=? AND event_key LIKE 'investor-surplus:%' ORDER BY created_at,id", user);
  const audits = (action: string) => all<{ target: string; detail: string }>(raw, 'SELECT target,detail FROM audit_log WHERE action=? ORDER BY id', action);
  return { raw, db, app, earnings, payload, investorFunding, confirm, detail, receipt, surplusOf, notices, audits };
}
type Setup = ReturnType<typeof setup>;
async function profiles(x: Setup, ...users: string[]) {
  for (const user of users) {
    const res = await post(x.app, '/i/profiles', { user_id: user, default_profit_share_bps: 3500, default_loss_share_bps: 0 });
    assert.equal(res.status, 200, JSON.stringify(await json(res)));
  }
}
const journal = (x: Setup, account: string) => row<{ d: number; c: number }>(x.raw, 'SELECT COALESCE(SUM(debit_iqd),0) d,COALESCE(SUM(credit_iqd),0) c FROM accounting_lines WHERE account_code=?', account)!;

test("the owner's example: 13,000,000 agreed and received at the confirm, 12,853,822 landed → 146,178 returned once, in the same confirm", async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  const d = await x.detail(p.id);
  assert.equal(d.ordered_total_iqd, LANDED);
  assert.equal(d.funding.allocated_iqd, LANDED);
  assert.equal(d.funding.agreed_unallocated_iqd, SURPLUS);
  assert.equal(d.funding.returned_iqd, SURPLUS);
  assert.equal(d.funding.return_total_iqd, SURPLUS);
  assert.equal(d.funding.return_pending_iqd, 0);
  assert.equal(d.funding.unallocated_iqd, SURPLUS, 'the older field still answers for an older screen');

  const own = await participantOverview(x.db, 'investor');
  const entry = own.entries.find((e) => e.id === `invsurplus:${p.id}`);
  assert.ok(entry, 'the remainder is a source of the investor’s own «أرباحي»');
  assert.equal(entry.kind, 'investor_capital');
  assert.equal(entry.amount_iqd, SURPLUS);
  assert.equal(entry.accrued_iqd, SURPLUS);
  assert.equal(entry.available_iqd, SURPLUS);
  assert.equal(entry.state, 'available');
  assert.equal(own.summary.capital_available_iqd, SURPLUS);
  assert.equal(own.summary.capital_surplus_iqd, SURPLUS);
  assert.equal(own.summary.capital_iqd, SURPLUS);
  assert.equal(own.summary.earnings_available_iqd, 0, 'returned capital is not earnings');
  assert.equal(own.summary.net_balance_iqd, 0);
  assert.equal(own.investment.returned_surplus_iqd, SURPLUS);
  assert.equal(own.investment.pending_surplus_iqd, 0);

  // Audit: one receipt row and one returned row, amounts only.
  const returned = x.audits('investment.surplus_returned');
  assert.equal(returned.length, 1);
  assert.deepEqual(JSON.parse(returned[0].detail), { receipt_id: `receipt:${p.id}`, user_id: 'investor', amount_iqd: SURPLUS });
  const received = x.audits('purchase.investor_funding_received');
  assert.equal(received.length, 1);
  assert.deepEqual(JSON.parse(received[0].detail), { receipt_id: `receipt:${p.id}`, amount_iqd: AGREED, allocated_iqd: LANDED });

  // The investor's notice: the amount, in three languages, and nothing else.
  const [notice, ...more] = x.notices();
  assert.equal(more.length, 0);
  assert.equal(notice.event_key, `investor-surplus:receipt:${p.id}`);
  assert.equal(notice.kind, 'payout_available');
  assert.equal(notice.link, '/earnings');
  const meta = JSON.parse(notice.meta) as { title_ckb: string; body_ckb: string };
  assert.equal(notice.title_ar, SURPLUS_STRINGS.title.ar);
  assert.equal(meta.title_ckb, SURPLUS_STRINGS.title.ckb);
  for (const text of [notice.body_ar, notice.body_en, meta.body_ckb]) assert.match(text, /146,178/);
  const all3 = [notice.title_ar, notice.title_en, notice.body_ar, notice.body_en, notice.meta].join(' | ');
  for (const secret of ['13,000,000', '13000000', '12,853,822', '12853822', '12,353,822', '12353822', '2,570,764', '2570764', '500,000', '500000'])
    assert.ok(!all3.includes(secret), `the notice reveals ${secret}`);
  assert.notEqual(meta.body_ckb, notice.body_ar, 'the Sorani body is its own sentence');
  for (const ckb of [meta.title_ckb, meta.body_ckb]) {
    assert.match(ckb, /[ڕڵێۆەڤگچپژ]/, 'Sorani letters');
    assert.doesNotMatch(ckb, /[ةىيك]/, 'no Arabic-only letter in the Sorani');
  }

  // The books: every received dinar is Dr 1000 / Cr 3100; nothing else is booked by the return itself.
  assert.deepEqual(journal(x, '1000'), { d: AGREED, c: 0 });
  assert.deepEqual(journal(x, '3100'), { d: 0, c: AGREED });
});

test('cash recorded later: nothing withdrawable at a confirm without cash; «تسجيل تمويل مستلم» of 13,000,000 returns 146,178', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding()));
  assert.equal(await x.surplusOf('investor', p.id), undefined, 'no cash, nothing to return yet');
  assert.equal(x.notices().length, 0);
  let own = await participantOverview(x.db, 'investor');
  assert.equal(own.summary.capital_available_iqd, 0);
  assert.equal(own.investment.pending_surplus_iqd, SURPLUS, 'shown as pending on «دفعات استثماري»');
  assert.equal(own.investment.returned_surplus_iqd, 0);
  let d = await x.detail(p.id);
  assert.equal(d.funding.return_total_iqd, SURPLUS);
  assert.equal(d.funding.returned_iqd, 0);
  assert.equal(d.funding.return_pending_iqd, SURPLUS);
  assert.equal(d.funding.funding_shortfall_iqd, LANDED);

  const op = crypto.randomUUID();
  const res = await x.receipt(p.id, AGREED, op);
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  const entry = await x.surplusOf('investor', p.id);
  assert.equal(entry?.amount_iqd, SURPLUS);
  assert.equal(entry?.available_iqd, SURPLUS);
  own = await participantOverview(x.db, 'investor');
  assert.equal(own.investment.pending_surplus_iqd, 0);
  assert.equal(own.investment.returned_surplus_iqd, SURPLUS);
  assert.deepEqual(x.notices().map((n) => n.event_key), [`investor-surplus:${op}`]);
  d = await x.detail(p.id);
  assert.equal(d.funding.returned_iqd, SURPLUS);
  assert.equal(d.funding.return_pending_iqd, 0);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM audit_log WHERE action='purchase.investor_funding_received'"), 1, '«تسجيل تمويل مستلم» is audited now');

  // The investor's own page answers the same, over HTTP.
  const page = await json(await get(x.earnings('investor'), '/api/finance-earnings'));
  assert.equal(page.summary.capital_available_iqd, SURPLUS);
  assert.equal(page.summary.capital_surplus_iqd, SURPLUS);
});

test('replay and double click never credit twice: the confirm, the receipt, and two receipts at once', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  // The same confirm again (double click / replay): already, nothing new.
  const again = await x.confirm(p.body);
  assert.equal(again.already, true);
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, SURPLUS);
  assert.equal(x.notices().length, 1);
  assert.equal(x.audits('investment.surplus_returned').length, 1);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 1);

  // A receipt replayed: already; the same id with another amount: refused.
  const op = crypto.randomUUID();
  assert.equal((await x.receipt(p.id, 500_000, op)).status, 200);
  const replay = await x.receipt(p.id, 500_000, op);
  assert.equal(replay.status, 200);
  assert.equal((await json(replay)).already, true);
  assert.equal((await x.receipt(p.id, 600_000, op)).status, 409);
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, SURPLUS + 500_000);
  assert.equal(x.notices().length, 2);

  // Two different receipts at the same moment (a double click on two tabs): the second lands
  // between the first one's read and its commit, so the first is refused by the
  // prior-receipt-sum fence — whole, with no receipt, journal, audit or notice of its own.
  let between: (() => Promise<void>) | null = async () => { assert.equal((await x.receipt(p.id, 200_000)).status, 200); };
  const gated = new Proxy(x.db, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (between && statements.some((s) => (s as unknown as { sql?: string }).sql?.includes('INSERT INTO purchase_investor_receipts'))) {
          const run = between; between = null; await run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const gatedApp = stubApp(gated, OWNER, (a) => a.route('/p', adminProcurementRoutes));
  const raced = await post(gatedApp, `/p/documents/${p.id}/investor-receipts`, { operation_id: 'raced-receipt-01', amount_iqd: 100_000, reference: 'BANK', payment_day: baghdadDay() });
  assert.equal(raced.status, 409, JSON.stringify(await json(raced)));
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM purchase_investor_receipts WHERE id='raced-receipt-01'"), 0);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM user_notifications WHERE event_key='investor-surplus:raced-receipt-01'"), 0);
  // The owner retries the same operation: it is recorded once, against the new total.
  assert.equal((await x.receipt(p.id, 100_000, 'raced-receipt-01')).status, 200);
  const received = count(x.raw, 'SELECT SUM(amount_iqd) n FROM purchase_investor_receipts');
  const principal = count(x.raw, 'SELECT SUM(principal_iqd) n FROM purchase_investor_allocations');
  assert.equal(principal, LANDED);
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, received - principal, 'the source is exactly the cash no contract took');
  assert.equal(x.notices().length, count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts WHERE amount_iqd>allocated_iqd'));
  assert.deepEqual(journal(x, '1000'), { d: received, c: 0 });
});

test('partial cash: nothing returns until the contracts are covered; then exactly the rest', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, 12_000_000)));
  assert.equal(await x.surplusOf('investor', p.id), undefined);
  assert.equal(x.notices().length, 0);
  assert.equal((await participantOverview(x.db, 'investor')).investment.pending_surplus_iqd, SURPLUS);
  // 900,000 more covers the contracts and returns 46,178; 100,000 is still pending.
  assert.equal((await x.receipt(p.id, 900_000)).status, 200);
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, 46_178);
  let own = await participantOverview(x.db, 'investor');
  assert.equal(own.investment.pending_surplus_iqd, 100_000);
  assert.equal(own.summary.capital_available_iqd, 46_178);
  // The last 100,000 arrives: the whole remainder is back.
  assert.equal((await x.receipt(p.id, 100_000)).status, 200);
  own = await participantOverview(x.db, 'investor');
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, SURPLUS);
  assert.equal(own.investment.pending_surplus_iqd, 0);
  assert.equal(own.summary.capital_available_iqd, SURPLUS);
  assert.equal(x.notices().length, 2);
});

test('overpayment: cash above the agreed amount returns too, each receipt with its own notice', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  assert.equal((await x.receipt(p.id, 500_000)).status, 200);
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, SURPLUS + 500_000);
  const d = await x.detail(p.id);
  assert.equal(d.funding.return_total_iqd, SURPLUS + 500_000);
  assert.equal(d.funding.return_pending_iqd, 0);
  const keys = x.notices().map((n) => n.event_key);
  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  assert.match(x.notices()[1].body_en, /^500,000 IQD/);
});

test('a remainder of zero or below returns nothing: agreed = landed, and agreed below landed (the store contributes)', async () => {
  const x = setup(); await profiles(x, 'investor');
  const exact = await x.confirm(x.payload(x.investorFunding(LANDED, LANDED)));
  assert.equal(await x.surplusOf('investor', exact.id), undefined);
  let d = await x.detail(exact.id);
  assert.equal(d.funding.return_total_iqd, 0);
  assert.equal(d.funding.agreed_unallocated_iqd, 0);

  const below = await x.confirm(x.payload(x.investorFunding(10_000_000, 10_000_000)));
  d = await x.detail(below.id);
  assert.equal(d.funding.store_contribution_iqd, LANDED - 10_000_000);
  assert.equal(d.funding.return_total_iqd, 0);
  assert.equal(await x.surplusOf('investor', below.id), undefined);
  assert.equal(x.notices().length, 0);
  assert.equal(x.audits('investment.surplus_returned').length, 0);
  const own = await participantOverview(x.db, 'investor');
  assert.equal(own.summary.capital_available_iqd, 0);
  assert.equal(own.investment.pending_surplus_iqd, 0);
});

test('withdrawal end to end: request capital, approve, pay — Dr 3100 / Cr 1000; earnings stay untouched; cancel releases', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  const env = { DB: x.db } as Env;
  // The returned capital is not earnings.
  await assert.rejects(requestWithdrawal(env, 'investor', 'wd-earnings-1', 1, 'earnings'), /المبلغ أكبر/);
  // A request through the investor's own page, then cancelled: the amount is available again.
  const page = x.earnings('investor');
  const asked = await post(page, '/api/finance-earnings/withdrawals', { operation_id: 'wd-cancel-01', amount_iqd: SURPLUS, balance_type: 'capital' });
  assert.equal(asked.status, 200, JSON.stringify(await json(asked)));
  assert.equal((await x.surplusOf('investor', p.id))?.available_iqd, 0);
  assert.equal((await post(page, '/api/finance-earnings/withdrawals/wd-cancel-01/cancel', {})).status, 200);
  assert.equal((await x.surplusOf('investor', p.id))?.available_iqd, SURPLUS);

  await requestWithdrawal(env, 'investor', 'wd-capital-1', SURPLUS, 'capital');
  assert.deepEqual(all(x.raw, "SELECT source_kind,source_id,amount_iqd FROM finance_withdrawal_allocations WHERE withdrawal_id='wd-capital-1'"),
    [{ source_kind: 'investor_capital', source_id: `invsurplus:${p.id}`, amount_iqd: SURPLUS }]);
  await assert.rejects(requestWithdrawal(env, 'investor', 'wd-capital-2', 1, 'capital'), /المبلغ أكبر/, 'reserved: nothing more to request');
  await changeWithdrawalState(x.db, 'wd-capital-1', 'owner', 'approve');
  await payWithdrawal(x.db, 'owner', 'wd-capital-1', { id: 'pay-capital-1', amount: SURPLUS, reference: 'CASH', receipt_url: '' });
  const lines = all(x.raw, "SELECT l.account_code,l.debit_iqd,l.credit_iqd FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key='earnings-withdrawal:pay-capital-1' ORDER BY l.account_code");
  assert.deepEqual(lines, [{ account_code: '1000', debit_iqd: 0, credit_iqd: SURPLUS }, { account_code: '3100', debit_iqd: SURPLUS, credit_iqd: 0 }]);
  assert.deepEqual(journal(x, '3100'), { d: SURPLUS, c: AGREED });
  const total = row<{ d: number; c: number }>(x.raw, 'SELECT SUM(debit_iqd) d,SUM(credit_iqd) c FROM accounting_lines')!;
  assert.equal(total.d, total.c, 'the books balance');
  const own = await participantOverview(x.db, 'investor');
  assert.equal(own.summary.capital_available_iqd, 0);
  assert.equal(own.summary.capital_paid_iqd, SURPLUS);
  assert.equal(own.summary.capital_surplus_iqd, SURPLUS, 'the returned amount stays recorded after its payout');
  await assert.rejects(requestWithdrawal(env, 'investor', 'wd-capital-3', 1, 'capital'), /المبلغ أكبر/, 'paid once, never twice');
  assert.equal(x.notices().length, 1);
});

test('the withdrawal snapshot fence sees the remainder: a receipt between read and commit is refused; a rename is not', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  let between: (() => Promise<void>) | null = null;
  const gated = new Proxy(x.db, {
    get(target, key) {
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (between && statements.some((s) => (s as unknown as { sql?: string }).sql?.includes('INSERT INTO finance_withdrawals'))) {
          const run = between; between = null; await run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const env = { DB: gated } as Env;
  between = async () => { assert.equal((await x.receipt(p.id, 50_000)).status, 200); };
  await assert.rejects(requestWithdrawal(env, 'investor', 'wd-raced-01', SURPLUS, 'capital'), (e: { status?: number }) => e.status === 409);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM finance_withdrawals WHERE id='wd-raced-01'"), 0, 'nothing written');
  // A rename between the read and the commit changes the title only: the fence holds.
  between = async () => {
    x.raw.prepare('UPDATE purchase_orders SET invoice_no=? WHERE id=?').run('شحنة ألمانيا', p.id);
  };
  await requestWithdrawal(env, 'investor', 'wd-renamed-1', SURPLUS + 50_000, 'capital');
  assert.equal(count(x.raw, "SELECT amount_iqd n FROM finance_withdrawals WHERE id='wd-renamed-1'"), SURPLUS + 50_000);
  // participantSources and the fence agree on a plain request too (the investor's own page path).
  const sources = await participantSources(x.db, 'investor');
  assert.equal(sources.filter((s) => s.id.startsWith('invsurplus:')).length, 1);
});

test('cancellation and later cost edits leave the returned amount exactly as it was', async () => {
  const x = setup(); await profiles(x, 'investor');
  // Cancelled with nothing received.
  const cancelled = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  const closed = await post(x.app, `/p/documents/${cancelled.id}/close`, { reason: 'ألغى المورد الشحنة' });
  assert.equal(closed.status, 200, JSON.stringify(await json(closed)));
  assert.equal(row<{ status: string }>(x.raw, 'SELECT status FROM purchase_orders WHERE id=?', cancelled.id)?.status, 'cancelled');
  assert.equal((await x.surplusOf('investor', cancelled.id))?.amount_iqd, SURPLUS);
  assert.equal((await x.surplusOf('investor', cancelled.id))?.available_iqd, SURPLUS);
  assert.equal(x.notices().length, 1, 'no second notice');

  // Received in full, then: the purchase cannot be re-planned, and a lot-cost correction never moves the remainder.
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  let d = await x.detail(p.id);
  const frozen = await put(x.app, `/p/documents/${p.id}`, { ...p.body, version: d.purchase.version });
  assert.equal(frozen.status, 409);
  assert.equal((await json(frozen)).code, 'INVESTMENT_PURCHASE_FROZEN');
  const received = await post(x.app, `/p/documents/${p.id}/receive`, { operation_id: crypto.randomUUID(), lines: d.lines.map((l: { line_id: string; qty_ordered: number }) => ({ line_id: l.line_id, qty: l.qty_ordered })) });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  d = await x.detail(p.id);
  const adjusted = await post(x.app, '/i/lot-cost-adjustments', { operation_id: crypto.randomUUID(), incoming_id: d.lines[0].id, new_unit_cost_iqd: 2_400_000, title: 'خصم المورد' });
  assert.equal(adjusted.status, 200, JSON.stringify(await json(adjusted)));
  assert.equal((await x.surplusOf('investor', p.id))?.amount_iqd, SURPLUS);
  d = await x.detail(p.id);
  assert.equal(d.funding.agreed_unallocated_iqd, SURPLUS);
  assert.equal(d.funding.returned_iqd, SURPLUS);
  assert.equal(x.notices().length, 2);
  assert.equal((await participantOverview(x.db, 'investor')).summary.capital_surplus_iqd, 2 * SURPLUS);
});

test('several investors and purchases: each sees only their own remainder; a manual per-line contract never creates one', async () => {
  const x = setup(); await profiles(x, 'investor', 'investor2');
  const a = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  const b = await x.confirm(x.payload(x.investorFunding(LANDED + 100_000, LANDED + 100_000, 'investor2')));
  const c = await x.confirm(x.payload(x.investorFunding(AGREED + 50_000, AGREED + 50_000)));
  const mine = (await participantOverview(x.db, 'investor')).entries.filter((e) => e.id.startsWith('invsurplus:')).map((e) => [e.id, e.amount_iqd]).sort();
  assert.deepEqual(mine, [[`invsurplus:${a.id}`, SURPLUS], [`invsurplus:${c.id}`, SURPLUS + 50_000]].sort());
  assert.equal((await participantOverview(x.db, 'investor')).summary.capital_available_iqd, 2 * SURPLUS + 50_000);
  const theirs = (await participantOverview(x.db, 'investor2')).entries.filter((e) => e.id.startsWith('invsurplus:')).map((e) => [e.id, e.amount_iqd]);
  assert.deepEqual(theirs, [[`invsurplus:${b.id}`, 100_000]]);
  assert.equal(x.notices('investor').length, 2);
  assert.equal(x.notices('investor2').length, 1);

  // A manual contract for the second investor on a store-funded line, funded to its cap: no remainder, and no more cash.
  const store = await x.confirm(x.payload(null));
  const line = (await x.detail(store.id)).lines[0];
  const contract = await post(x.app, '/i/contracts', { operation_id: 'manual-contract-01', incoming_id: line.id, user_id: 'investor2', name: 'Manual', principal_iqd: 1_000_000, capital_share_bps: 2000, profit_share_bps: 2000, loss_share_bps: 0 });
  assert.equal(contract.status, 200, JSON.stringify(await json(contract)));
  assert.equal((await post(x.app, '/i/contracts/manual-contract-01/funding', { operation_id: 'manual-funding-1', amount_iqd: 1_000_000, reference: 'CASH' })).status, 200);
  assert.notEqual((await post(x.app, '/i/contracts/manual-contract-01/funding', { operation_id: 'manual-funding-2', amount_iqd: 1, reference: 'CASH' })).status, 200);
  const after = (await participantOverview(x.db, 'investor2')).entries.filter((e) => e.id.startsWith('invsurplus:'));
  assert.deepEqual(after.map((e) => [e.id, e.amount_iqd]), [[`invsurplus:${b.id}`, 100_000]]);
});

test('receipt input cannot redirect a confirmed agreement to another investor or let them withdraw its remainder', async () => {
  const x = setup(); await profiles(x, 'investor', 'investor2');
  const p = await x.confirm(x.payload(x.investorFunding()));
  const received = await post(x.app, `/p/documents/${p.id}/investor-receipts`, {
    operation_id: 'wrong-investor-receipt', amount_iqd: AGREED, reference: 'BANK',
    user_id: 'investor2', investor_id: 'investor2',
  });
  assert.equal(received.status, 200, JSON.stringify(await json(received)));
  assert.equal((await x.surplusOf('investor', p.id))?.available_iqd, SURPLUS);
  assert.equal(await x.surplusOf('investor2', p.id), undefined);
  assert.equal(x.notices('investor').length, 1);
  assert.equal(x.notices('investor2').length, 0);
  const withdrawal = await post(x.earnings('investor2'), '/api/finance-earnings/withdrawals', {
    operation_id: 'wrong-investor-withdrawal', amount_iqd: SURPLUS, balance_type: 'capital',
    user_id: 'investor', source_id: `invsurplus:${p.id}`,
  });
  assert.notEqual(withdrawal.status, 200);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM finance_withdrawals'), 0);
  assert.equal((await x.surplusOf('investor', p.id))?.available_iqd, SURPLUS);
});

test('a draft with received cash typed creates no return before confirmation; negative funding cannot create one', async () => {
  const x = setup(); await profiles(x, 'investor');
  const draft = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED), { status: 'draft' }));
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_agreements'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_lines'), 0);
  assert.equal(await x.surplusOf('investor', draft.id), undefined);
  assert.equal((await x.receipt(draft.id, AGREED)).status, 404);
  assert.equal(x.notices().length, 0);

  const before = count(x.raw, 'SELECT COUNT(*) n FROM purchase_orders');
  for (const funding of [x.investorFunding(-1, AGREED), x.investorFunding(AGREED, -1)]) {
    assert.equal((await post(x.app, '/p/documents', x.payload(funding))).status, 400);
  }
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_orders'), before);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 0);
  assert.equal((await participantOverview(x.db, 'investor')).summary.capital_available_iqd, 0);
});

test('the confirm guards: an estimated cost is refused with investor funding (a draft still saves); a second agreement is a 409, never a 500', async () => {
  const x = setup(); await profiles(x, 'investor');
  const estimated = x.payload(x.investorFunding(AGREED, AGREED), { cost_state: 'estimated' });
  const refused = await post(x.app, '/p/documents', estimated), body = await json(refused);
  assert.equal(refused.status, 409);
  assert.equal(body.code, 'INVESTMENT_NEEDS_FINAL_COST');
  assert.equal(body.error, `${COST_REFUSALS.INVESTMENT_NEEDS_FINAL_COST.ar} / ${COST_REFUSALS.INVESTMENT_NEEDS_FINAL_COST.en}`);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_orders'), 0, 'nothing written');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_lines'), 0);
  assert.equal(x.notices().length, 0);
  // A draft with an estimated cost and investor funding still saves (no agreement is written for a draft).
  const draft = await x.confirm(x.payload(x.investorFunding(), { cost_state: 'estimated', status: 'draft' }));
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_agreements'), 0);
  // Confirming that draft with an estimated cost is refused too; with the final cost it confirms.
  let d = await x.detail(draft.id);
  const confirmEstimated = await put(x.app, `/p/documents/${draft.id}`, { ...draft.body, status: 'ordered', version: d.purchase.version });
  assert.equal((await json(confirmEstimated)).code, 'INVESTMENT_NEEDS_FINAL_COST');
  const confirmFinal = await put(x.app, `/p/documents/${draft.id}`, { ...draft.body, status: 'ordered', cost_state: 'final', version: d.purchase.version });
  assert.equal(confirmFinal.status, 200, JSON.stringify(await json(confirmFinal)));

  // Void the unfunded contracts, then save again with investor funding: the agreement stays, 409.
  for (const c of all<{ id: string }>(x.raw, 'SELECT id FROM investment_contracts')) assert.equal((await post(x.app, `/i/contracts/${c.id}/void`, { operation_id: `void-${c.id}`.slice(0, 50) })).status, 200);
  d = await x.detail(draft.id);
  const again = await put(x.app, `/p/documents/${draft.id}`, { ...draft.body, status: 'ordered', cost_state: 'final', version: d.purchase.version });
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'INVESTMENT_AGREEMENT_EXISTS');
  // Cash later recorded for that purchase has no active contract to fill: all of it is the investor's.
  assert.equal((await x.receipt(draft.id, 1_000_000)).status, 200);
  assert.equal((await x.surplusOf('investor', draft.id))?.amount_iqd, 1_000_000);
  assert.equal(count(x.raw, "SELECT COUNT(*) n FROM investor_finance_events WHERE kind='funding'"), 0, 'a voided contract takes no cash');
});

test('a receipt in a closed period is refused whole: no receipt, journal, audit, notice or source', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding()));
  x.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run('2026-01', new Date().toISOString(), 'owner');
  const res = await x.receipt(p.id, AGREED, crypto.randomUUID(), '2026-01-15');
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'PERIOD_CLOSED');
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM purchase_investor_receipts'), 0);
  assert.equal(count(x.raw, 'SELECT COUNT(*) n FROM accounting_lines'), 0);
  assert.equal(x.audits('investment.surplus_returned').length, 0);
  assert.equal(x.notices().length, 0);
  assert.equal(await x.surplusOf('investor', p.id), undefined);
});

test('reports: the returned remainder is neither capital still at work nor capital recovered from sales', async () => {
  const x = setup(); await profiles(x, 'investor');
  await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  const report = await participantReport(x.db, { from: null, to: null });
  assert.equal(report.capital.received_iqd, AGREED);
  assert.equal(report.capital.returned_surplus_iqd, SURPLUS);
  assert.equal(report.capital.remaining_iqd, LANDED, 'received − recovered − returned − loss');
  const profilesView = await json(await get(x.app, '/i/profiles'));
  const capital = profilesView.profiles.find((p: { user_id: string }) => p.user_id === 'investor').capital;
  assert.equal(capital.recovered_iqd, 0, '«مسترد من المبيعات» counts sales only');
  assert.equal(capital.returned_surplus_iqd, SURPLUS);
  assert.equal(capital.unallocated_iqd, SURPLUS);
  assert.equal(capital.received_iqd, AGREED);
});

test('missing funding tables (a database before 0168 is read as one): the page, the sources and a withdrawal work with no remainder', async () => {
  const x = setup(); await profiles(x, 'investor');
  const p = await x.confirm(x.payload(x.investorFunding(AGREED, AGREED)));
  // Make the investor's profit withdrawable: receive, sell and deliver one unit, collected.
  const d = await x.detail(p.id);
  assert.equal((await post(x.app, `/p/documents/${p.id}/receive`, { operation_id: crypto.randomUUID(), lines: d.lines.map((l: { line_id: string; qty_ordered: number }) => ({ line_id: l.line_id, qty: l.qty_ordered })) })).status, 200);
  const now = new Date().toISOString(), price = 3_100_000;
  x.raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at) VALUES ('sold','customer','delivered','{}','standard','{}','cash',?,1500,?,?,0,?,?)`).run(price, price, price, now, now);
  x.raw.prepare(`INSERT INTO order_items(id,order_id,product_id,option_id,name_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('item:sold','sold','a1','combo','A1 Combo',1,?,?)`).run(price, price);
  const plan = await planLotConsumption(x.db, 'sold', [{ product_id: 'a1', line_id: 'item:sold', qty: 1, targets: [{ scope: 'option', scope_id: 'combo', stock: 5, reserved: 0, low_stock_threshold: 0, label: 'Combo' }] }]);
  await x.db.batch(plan.statements);
  x.raw.prepare("INSERT INTO finance_collections(id,order_id,payer,amount_iqd,collection_day,actor_id,created_at) VALUES ('cash:sold','sold','customer',?,?,'owner',?)").run(price, baghdadDay(), now);
  await runOrderFinancialEffects({ DB: x.db } as Env, 'sold', 'delivered');
  const before = await participantOverview(x.db, 'investor');
  const profit = before.summary.earnings_available_iqd;
  assert.ok(profit > 0, 'the investor has profit to withdraw');
  assert.equal(before.summary.capital_surplus_iqd, SURPLUS);

  for (const table of ['purchase_investor_receipts', 'purchase_investor_agreements']) {
    x.raw.exec(`ALTER TABLE ${table} RENAME TO ${table}_gone`);
    const own = await participantOverview(x.db, 'investor');
    assert.equal(own.entries.some((e) => e.id.startsWith('invsurplus:')), false);
    assert.equal(own.summary.capital_surplus_iqd, 0);
    const page = await get(x.earnings('investor'), '/api/finance-earnings');
    assert.equal(page.status, 200, JSON.stringify(await json(page)));
    x.raw.exec(`ALTER TABLE ${table}_gone RENAME TO ${table}`);
  }
  x.raw.exec('ALTER TABLE purchase_investor_receipts RENAME TO purchase_investor_receipts_gone');
  await requestWithdrawal({ DB: x.db } as Env, 'investor', 'wd-no-tables', profit, 'earnings');
  assert.equal(count(x.raw, "SELECT amount_iqd n FROM finance_withdrawals WHERE id='wd-no-tables'"), profit);
  assert.equal((await participantSources(x.db, 'investor')).some((s) => s.id.startsWith('invsurplus:')), false);
});
