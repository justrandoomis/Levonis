/**
 * A STAFF PAYMENT'S STATEMENT (the owner's brief, 2026-11-12, part 2; DECISIONS row 330; worker/lib/financeStatements.ts,
 * GET /statements/staff-payments/:id/export.xlsx and /print).
 *
 * Over an invented month: a payment that paid three wage rows — one per order, one a percentage of the profit with its base,
 * one per piece — one of them partly paid before by another payment; an advance set against one wage so far. The statement
 * lists exactly the rows the payment paid, each with its order and products, its task, how it is counted, earned, paid by
 * other payments, paid here and still due, with the totals; the advance names the part not yet set against wages; the
 * printed page is a stand-alone document; an unknown payment is 404; the words keep the Sorani rules (DECISIONS row 183).
 *
 * Every figure is invented. Run: node --import tsx --test tests/staffPaymentStatement.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './fixtures/app';
import { order, world } from './fixtures/financeWorld';
import { baghdadDay } from '../worker/lib/operations';
import { STAFF_STATEMENT_COLUMNS, STATEMENT_WORDS, howCounted } from '../worker/lib/financeStatements';
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
const COL = Object.fromEntries(STAFF_STATEMENT_COLUMNS.map((c, i) => [c.key, String.fromCharCode(65 + i)]));

function month() {
  const w = world();
  const day = baghdadDay();
  order(w.raw, { id: 'a' });
  order(w.raw, { id: 'b', qty: 3 });
  const cost = (id: string, orderId: string, name: string, basis: string, amount: number, base: number | null, qty: number, value: number) =>
    `('${id}','${orderId}','r-${id}',1,'${name}','g-${id}','staff_sajjad','rent','delivered',${base ?? 'NULL'},${qty},${value},'${day}','approved','${JSON.stringify({ rule: { basis, amount } })}')`;
  // An invented name: the seeded staff row (migration 0162) carries a real first name.
  w.raw.exec("UPDATE finance_staff SET name='موظف تجريبي' WHERE id='staff_sajjad'");
  w.raw.exec(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot) VALUES
      ${cost('c1', 'a', 'تغليف', 'order', 2500, null, 1, 2500)},
      ${cost('c2', 'b', 'حصة من الربح', 'profit_percent', 500, 40000, 3, 2000)},
      ${cost('c3', 'b', 'تجميع', 'unit', 1000, null, 3, 3000)},
      ${cost('c4', 'a', 'توصيل', 'order', 1000, null, 1, 1000)};
    INSERT INTO finance_staff_payments(id,staff_id,amount_iqd,kind,payment_day,note,actor_id,created_at) VALUES
      ('pay-0','staff_sajjad',1000,'payment','${day}','','admin','${day}T08:00:00.000Z'),
      ('pay-1','staff_sajjad',6500,'payment','${day}','أجور الأسبوع','admin','${day}T09:00:00.000Z'),
      ('adv-1','staff_sajjad',5000,'advance','${day}','','admin','${day}T07:00:00.000Z');
    INSERT INTO finance_payment_allocations(payment_id,cost_id,amount_iqd) VALUES ('pay-0','c1',1000),('pay-1','c1',1500),('pay-1','c2',2000),('pay-1','c3',3000),('adv-1','c4',1000);`);
  return { w, day };
}
const sheetOf = async (w: ReturnType<typeof world>, id: string, lang = 'ar') => {
  const res = await get(w.app, `/f/statements/staff-payments/${id}/export.xlsx?lang=${lang}`);
  assert.equal(res.status, 200, id);
  return unzip(new Uint8Array(await res.arrayBuffer())).get('xl/worksheets/sheet1.xml')!;
};

test('how a wage is counted, in words', () => {
  assert.equal(howCounted('ar', 'order', 2500, 1), '2,500 للطلب');
  assert.equal(howCounted('en', 'unit', 1000, 3), '1,000 per piece × 3');
  assert.equal(howCounted('ar', 'profit_percent', 500, 3), '5% من الربح');
  assert.equal(howCounted('en', 'revenue_percent', 250, 1), '2.5% of the sales');
  assert.equal(howCounted('ar', 'order', null, 1), '', 'no rule recorded: nothing invented');
});

test('the payment’s statement: exactly the rows it paid, each traced, with the totals and today’s balance', async () => {
  const { w, day } = month();
  const sheet = await sheetOf(w, 'pay-1');
  assert.match(sheet, /rightToLeft="1"/);
  const g = grid(sheet);
  const text = [...g.values()].flatMap((r) => [...r.values()]).join(' | ');
  for (const part of ['كشف دفعة لموظف', 'الموظف: موظف تجريبي', `الدفعة: 6,500 د.ع يوم ${day}`, 'ملاحظة: أجور الأسبوع', 'المستحق للدفع اليوم:', 'سلف لم تُسوَّ بعد: 4,000 د.ع']) {
    assert.ok(text.includes(part), `«${part}»`);
  }
  const headerRow = [...g.entries()].find(([, r]) => r.get('A') === 'يوم الأجر')![0];
  const data = [...g.keys()].filter((k) => k > headerRow).sort((a, b) => a - b);
  const total = g.get(data.pop()!)!;
  const rows = data.map((k) => g.get(k)!);
  assert.deepEqual(rows.map((r) => [r.get(COL.order_id), r.get(COL.task), r.get(COL.how), r.get(COL.base) ?? null, r.get(COL.earned), r.get(COL.paid_before), r.get(COL.paid_here), r.get(COL.still_due)]), [
    ['a', 'تغليف', '2,500 للطلب', null, 2500, 1000, 1500, 0],
    ['b', 'حصة من الربح', '5% من الربح', 40000, 2000, 0, 2000, 0],
    ['b', 'تجميع', '1,000 للقطعة × 3', null, 3000, 0, 3000, 0],
  ], 'the advance’s wage is not this payment’s');
  assert.ok(String(rows[1].get(COL.products)).includes('×3'), 'the order’s products');
  assert.equal(typeof rows[0].get(COL.cost_day), 'number', 'the day is a real date');
  assert.deepEqual([total.get('A'), total.get(COL.earned), total.get(COL.paid_before), total.get(COL.paid_here), total.get(COL.still_due), total.get(COL.base) ?? null],
    ['المجموع', 7500, 1000, 6500, 0, null], 'the base is not summed: it is not money paid');
});

test('an advance names what of it is not yet set against wages; an unknown payment is 404', async () => {
  const { w } = month();
  const g = grid(await sheetOf(w, 'adv-1', 'en'));
  const text = [...g.values()].flatMap((r) => [...r.values()]).join(' | ');
  assert.ok(text.includes('Advance: 5,000 IQD on'), text.slice(0, 300));
  assert.ok(text.includes('Part of this advance not yet set against wages: 4,000 IQD'));
  assert.equal((await get(w.app, '/f/statements/staff-payments/nope/export.xlsx')).status, 404);
  assert.equal((await get(w.app, '/f/statements/staff-payments/nope/print')).status, 404);
});

test('the printed statement: a stand-alone document with the same rows and totals, every value escaped', async () => {
  const { w } = month();
  w.raw.exec(`UPDATE finance_staff_payments SET note='<i>bonus</i>' WHERE id='pay-1'`);
  const res = await get(w.app, '/f/statements/staff-payments/pay-1/print?lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-security-policy'), documentCsp());
  const html = await res.text();
  assert.ok(html.includes('Note: &lt;i&gt;bonus&lt;/i&gt;') && !html.includes('<i>bonus</i>'));
  assert.match(html, /<th scope="col"[^>]*>Paid by this payment<\/th>/);
  // The arrangement (DECISIONS row 334): the figures with what this payment paid marked, the groups, lines to sign.
  assert.match(html, /<div class="fig key"><span>Paid by this payment<\/span><strong><span dir="ltr">6,500<\/span>/);
  assert.ok(html.includes('<th scope="colgroup" colspan="6">The wage</th>') && html.includes('<span>Received by</span><i></i>'));
  assert.ok(html.includes('<tfoot><tr><th scope="row">Total</th>'));
  assert.ok(html.includes('<span dir="ltr">6,500</span>'), 'the paid-here total');
});

test('the words keep the Sorani rules', () => {
  for (const [key, [ar, en, ckb]] of [...Object.entries(STATEMENT_WORDS), ...STAFF_STATEMENT_COLUMNS.map((c) => [c.key, c.header] as const)]) {
    assert.notEqual(ckb, ar, `${key}: the Arabic in the Sorani slot`);
    assert.notEqual(ckb, en, `${key}: the English in the Sorani slot`);
    assert.match(ckb, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: no Arabic-only letter`);
  }
});
