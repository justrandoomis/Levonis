/**
 * AN INVESTOR'S WITHDRAWAL STATEMENT (the owner's brief, 2026-11-12, part 2; DECISIONS row 331; worker/lib/financeStatements.ts,
 * GET /statements/withdrawals/:id/export.xlsx and /print).
 *
 * Over an invented agreement — 40,000 invested in a batch of printers, half the profit to the investor — with two units sold
 * and counted and one still waiting, an earlier withdrawal that paid 10,000 of the profit, and this withdrawal taking profit,
 * capital and a purchase's capital surplus: the summary names, per agreement, what was invested, the share, the profit and
 * capital the ledger recorded, what the earlier withdrawal paid, what this one takes and what remains, the surplus as its
 * own line under its invoice number, with totals; the units sheet lists every sold unit behind the agreement with its sale, cost, expenses, profit,
 * the investor's profit and the capital returned, a waiting unit named so; the page to print holds both tables; an unknown
 * withdrawal is 404; the words keep the Sorani rules (DECISIONS row 183).
 *
 * Every figure is invented. Run: node --import tsx --test tests/withdrawalStatement.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './fixtures/app';
import { order, world } from './fixtures/financeWorld';
import { WITHDRAWAL_SUMMARY_COLUMNS, WITHDRAWAL_UNIT_COLUMNS, WITHDRAWAL_WORDS } from '../worker/lib/financeStatements';
import { documentCsp } from '../worker/lib/securityPolicy';

function unzip(bytes: Uint8Array): Map<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder(), out = new Map<string, string>();
  const end = bytes.length - 22, count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    const len = v.getUint32(at + 20, true), nameLen = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.set(name, dec.decode(bytes.subarray(start, start + len)));
    at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return out;
}
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
function grid(sheet: string): Map<number, Map<string, string | number>> {
  const rows = new Map<number, Map<string, string | number>>();
  for (const m of sheet.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, rowNo, inner = ''] = m;
    const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner), v = /<v>([^<]*)<\/v>/.exec(inner);
    const row = rows.get(Number(rowNo)) ?? new Map();
    row.set(col, t ? unescape(t[1]) : Number(v?.[1]));
    rows.set(Number(rowNo), row);
  }
  return rows;
}
/** The table under its header row (whose first cell is `first`): its data rows and its totals row. */
function table(g: Map<number, Map<string, string | number>>, first: string) {
  const header = [...g.entries()].find(([, r]) => r.get('A') === first)![0];
  const keys = [...g.keys()].filter((k) => k > header).sort((a, b) => a - b);
  const total = g.get(keys.pop()!)!;
  return { rows: keys.map((k) => g.get(k)!), total };
}
const letters = (cols: Array<{ key: string }>) => Object.fromEntries(cols.map((c, i) => [c.key, String.fromCharCode(65 + i)]));
const S = letters(WITHDRAWAL_SUMMARY_COLUMNS), U = letters(WITHDRAWAL_UNIT_COLUMNS);

function agreement() {
  const w = world();
  order(w.raw, { id: 'a' });
  order(w.raw, { id: 'b', qty: 1 });
  order(w.raw, { id: 'c', qty: 1 });
  const result = (allocation: string, profit: number, capital: number, eligible: number, pending: number, snapshot: object) =>
    `('${allocation}','ct1',${profit},${capital},0,${eligible},${pending},'${JSON.stringify(snapshot)}',1)`;
  w.raw.exec(`INSERT INTO users(id,email,name,role) VALUES ('inv1','inv1@x.co','مستثمر تجريبي','customer');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd) VALUES ('batch1','product','base','',4,4,10000);
    INSERT INTO investment_profiles(user_id,state,default_profit_share_bps,created_by,created_at,updated_at) VALUES ('inv1','active',5000,'admin','2026-10-01T08:00:00.000Z','2026-10-01T08:00:00.000Z');
    INSERT INTO purchase_orders(id,invoice_no,currency,exchange_rate,purchase_day,status,created_by,created_at,updated_at)
      VALUES ('po_surplus_1','PO-77','IQD',1,'2026-10-01','received','admin','2026-10-01T08:00:00.000Z','2026-10-01T08:00:00.000Z');
    INSERT INTO purchase_investor_agreements(purchase_id,user_id,agreed_iqd,allocated_iqd,batch_cost_iqd,profit_share_bps,loss_share_bps,actor_id,created_at,request_json)
      VALUES ('po_surplus_1','inv1',45000,40000,40000,5000,5000,'admin','2026-10-01T08:00:00.000Z','{}');
    INSERT INTO purchase_investor_receipts(id,purchase_id,amount_iqd,allocated_iqd,payment_day,reference,actor_id,created_at,request_json)
      VALUES ('rcpt1','po_surplus_1',45000,40000,'2026-10-01','zain cash','admin','2026-10-01T08:00:00.000Z','{}');
    INSERT INTO investment_contracts(id,incoming_id,user_id,name,principal_iqd,capital_share_bps,profit_share_bps,loss_share_bps,created_by,created_at,request_json,state)
      VALUES ('ct1','batch1','inv1','دفعة الطابعات',40000,10000,5000,5000,'admin','2026-10-01T08:00:00.000Z','{}','active');
    INSERT INTO investor_allocation_results(allocation_id,contract_id,profit_iqd,capital_iqd,loss_iqd,eligible,pending,snapshot,version) VALUES
      ${result('a:allocation', 14000, 20000, 1, 0, { qty: 2, revenue: 50000, cost: 20000, expenses: 2000, profit: 28000 })},
      ${result('b:allocation', 7000, 10000, 1, 0, { qty: 1, revenue: 25000, cost: 10000, expenses: 1000, profit: 14000 })},
      ${result('c:allocation', 0, 0, 0, 1, { qty: 1, revenue: 25000, cost: 10000 })};
    INSERT INTO finance_investor_earnings(id,user_id,contract_id,kind,title,amount_iqd,accrued_iqd,state,day,updated_at) VALUES
      ('invprofit:ct1','inv1','ct1','investor_profit','دفعة الطابعات',11000,21000,'available','2026-11-05','2026-11-05T08:00:00.000Z'),
      ('invcapital:ct1','inv1','ct1','investor_capital','دفعة الطابعات',30000,30000,'available','2026-11-05','2026-11-05T08:00:00.000Z');
    INSERT INTO finance_withdrawals(id,user_id,amount_iqd,paid_iqd,balance_type,state,created_at,updated_at) VALUES
      ('wd0','inv1',10000,10000,'earnings','paid','2026-11-06T08:00:00.000Z','2026-11-06T08:00:00.000Z'),
      ('wd1','inv1',28000,0,'all','approved','2026-11-10T08:00:00.000Z','2026-11-10T08:00:00.000Z');
    INSERT INTO finance_withdrawal_allocations(withdrawal_id,source_kind,source_id,amount_iqd,paid_iqd) VALUES
      ('wd0','investor_profit','invprofit:ct1',10000,10000),
      ('wd1','investor_profit','invprofit:ct1',11000,0),
      ('wd1','investor_capital','invcapital:ct1',14000,0),
      ('wd1','investor_capital','invsurplus:po_surplus_1',3000,0);`);
  return w;
}

test('the summary: per agreement what was invested, earned, paid before, taken now and left — the surplus its own line — with totals', async () => {
  const w = agreement();
  const res = await get(w.app, '/f/statements/withdrawals/wd1/export.xlsx?lang=ar');
  assert.equal(res.status, 200);
  const files = unzip(new Uint8Array(await res.arrayBuffer()));
  assert.match(files.get('xl/workbook.xml')!, /<sheet name="الملخص" sheetId="1"[^>]*\/><sheet name="الوحدات المبيعة" sheetId="2"/);
  const g = grid(files.get('xl/worksheets/sheet1.xml')!);
  const text = [...g.values()].flatMap((r) => [...r.values()]).join(' | ');
  for (const part of ['كشف سحب مستثمر', 'المستثمر: مستثمر تجريبي', 'السحب: 28,000 د.ع، طُلب يوم 2026-11-10، دُفع منه 0 د.ع']) assert.ok(text.includes(part), `«${part}»`);
  const { rows, total } = table(g, 'الاتفاق');
  assert.deepEqual(rows.map((r) => [r.get(S.name), r.get(S.invested) ?? null, r.get(S.share) ?? null, r.get(S.profit) ?? null, r.get(S.capital), r.get(S.paid_before), r.get(S.this), r.get(S.remaining) ?? null]), [
    ['دفعة الطابعات', 40000, '50%', 21000, 30000, 10000, 25000, 16000],
    ['فائض رأس مال: PO-77', null, null, null, 5000, 0, 3000, 2000],
  ]);
  assert.deepEqual([total.get(S.profit), total.get(S.capital), total.get(S.paid_before), total.get(S.this), total.get(S.remaining), total.get(S.invested) ?? null],
    [21000, 35000, 10000, 28000, 18000, null], 'the withdrawal is the total of «this withdrawal»; the invested amount is not summed');
});

test('the units: every sold unit behind the agreement, traced, a waiting one named so, with totals', async () => {
  const w = agreement();
  const files = unzip(new Uint8Array(await (await get(w.app, '/f/statements/withdrawals/wd1/export.xlsx?lang=en')).arrayBuffer()));
  const { rows, total } = table(grid(files.get('xl/worksheets/sheet2.xml')!), 'Agreement');
  assert.deepEqual(rows.map((r) => [r.get(U.order_id), r.get(U.qty), r.get(U.revenue), r.get(U.cost), r.get(U.expenses) ?? null, r.get(U.net) ?? null, r.get(U.share), r.get(U.earning), r.get(U.capital), r.get(U.state)]), [
    ['a', 2, 50000, 20000, 2000, 28000, '50%', 14000, 20000, 'Counted'],
    ['b', 1, 25000, 10000, 1000, 14000, '50%', 7000, 10000, 'Counted'],
    ['c', 1, 25000, 10000, null, null, '50%', 0, 0, 'Waiting'],
  ]);
  assert.equal(typeof rows[0].get(U.day), 'number', 'the delivery day, a real date');
  assert.deepEqual([total.get(U.revenue), total.get(U.earning), total.get(U.capital)], [100000, 21000, 30000], 'the units add up to the ledger’s profit and capital');
});

test('the printed statement holds both tables, a page apart; an unknown withdrawal is 404', async () => {
  const w = agreement();
  const res = await get(w.app, '/f/statements/withdrawals/wd1/print?lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), documentCsp());
  const html = await res.text();
  assert.equal(html.match(/<table>/g)?.length, 2);
  assert.equal(html.match(/<script>/g)?.length, 1, 'one script: the print dialog');
  assert.ok(html.includes('.page-break { break-before: page; }') && html.includes('<div class="page-break"></div>'));
  assert.equal(html.match(/class="no-print"/g)?.length, 1, 'the print hint once');
  assert.match(html, /<th scope="col"[^>]*>This withdrawal<\/th>/);
  assert.match(html, /<th scope="col"[^>]*>Investor’s profit<\/th>/);
  assert.match(html, /<div class="fig key"><span>This withdrawal<\/span><strong><span dir="ltr">28,000<\/span>/, 'the figure the statement is about');
  assert.ok(html.includes('<h2>Units sold</h2>') && html.includes('<span>Received by</span><i></i>'));
  assert.equal((await get(w.app, '/f/statements/withdrawals/nope/export.xlsx')).status, 404);
});

test('the words keep the Sorani rules', () => {
  const all = [...Object.entries(WITHDRAWAL_WORDS), ...[...WITHDRAWAL_SUMMARY_COLUMNS, ...WITHDRAWAL_UNIT_COLUMNS].map((c) => [c.key, c.header] as const)];
  for (const [key, [ar, en, ckb]] of all) {
    assert.notEqual(ckb, ar, `${key}: the Arabic in the Sorani slot`);
    assert.notEqual(ckb, en, `${key}: the English in the Sorani slot`);
    assert.match(ckb, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: no Arabic-only letter`);
  }
});
