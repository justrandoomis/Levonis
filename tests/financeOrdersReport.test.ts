/**
 * REPORTS → ORDERS AS A WORKBOOK AND AS A PRINTED PAGE (the owner's brief, 2026-11-12, part 1; DECISIONS row 329;
 * worker/lib/financeOrdersReport.ts, GET /export.xlsx and GET /print).
 *
 * - The columns add up to the net, left to right, on every fully known order: sales + delivery − goods cost − courier −
 *   wages − materials − promotion − other − investor − discounts = net profit; an unknown amount stays empty.
 * - Through the real routes over an invented month: the workbook's rows are the CSV's rows (`part=period`: the orders and
 *   the overheads row), cell for cell in the brief's columns, and its totals row carries each column's sum; filtered, there
 *   is no overheads row; another view is refused.
 * - The printed page is a stand-alone document under the print policy, A4 landscape, its one script the print dialog's,
 *   every value escaped, with the same totals.
 * - Three languages: the words, the sheet's direction, and the Sorani rules (DECISIONS row 183).
 *
 * Every figure is invented. Run: node --import tsx --test tests/financeOrdersReport.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from './fixtures/app';
import { order, period, world } from './fixtures/financeWorld';
import { baghdadDay } from '../worker/lib/operations';
import { REPORT_COLUMNS, REPORT_WORDS, reportRow } from '../worker/lib/financeOrdersReport';
import { AUTO_PRINT_SCRIPT, documentCsp } from '../worker/lib/securityPolicy';

type Row = Record<string, unknown>;

/** The stored zip's text files (worker/lib/xlsx.ts writes method 0). */
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
/** A sheet's rows: row number → column letters → text or number (and `f` for a formula). */
function cells(sheet: string): Map<number, Map<string, { value: string | number; f?: string }>> {
  const rows = new Map<number, Map<string, { value: string | number; f?: string }>>();
  for (const m of sheet.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, rowNo, inner = ''] = m;
    const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner), v = /<v>([^<]*)<\/v>/.exec(inner), f = /<f>([^<]*)<\/f>/.exec(inner);
    const row = rows.get(Number(rowNo)) ?? new Map();
    row.set(col, { value: t ? unescape(t[1]) : Number(v?.[1]), ...(f ? { f: f[1] } : {}) });
    rows.set(Number(rowNo), row);
  }
  return rows;
}
const LETTER = Object.fromEntries(REPORT_COLUMNS.map((c, i) => [c.key, String.fromCharCode(65 + i)]));

test('the columns add up to the net, left to right; an unknown amount stays empty', () => {
  const row: Row = { order_id: 'ORD-0F00000001', delivered_day: '2026-11-03', customer_name: 'زبون', finance_state: 'confirmed',
    retained_revenue_iqd: 50000, shipping_income_iqd: 5000, cod_tax_iqd: 1000, cogs_iqd: 30000, courier_fee_iqd: 5000, wages_iqd: 2500, materials_iqd: 500,
    promotion_iqd: 700, manual_direct_iqd: 1000, payment_fee_iqd: 300, investor_iqd: 2000, coupon_iqd: 1000, price_protection_iqd: 500, trade_in_credit_returned_iqd: 0 };
  const net = 50000 + 6000 - 30000 - 5000 - 2500 - 500 - 700 - 1300 - 2000 - 1500;
  const r = reportRow({ ...row, net_after_report_adjustments_iqd: net }, new Map([['ORD-0F00000001', 'طابعة ×1']]), 'ar');
  const n = (k: string) => r[k] as number;
  assert.equal(n('sales') + n('delivery') - n('cogs') - n('courier') - n('wages') - n('materials') - n('promotion') - n('other') - n('investor') - n('discounts'), n('net'));
  assert.deepEqual([r.delivery, r.other, r.discounts, r.products, r.state], [6000, 1300, 1500, 'طابعة ×1', 'مؤكد']);
  const unknown = reportRow({ ...row, cogs_iqd: null, wages_iqd: null, manual_direct_iqd: null, net_after_report_adjustments_iqd: null }, new Map(), 'en');
  assert.deepEqual([unknown.cogs, unknown.wages, unknown.other, unknown.net, unknown.state], [null, null, null, null, 'Confirmed'], 'never 0 for an unknown');
});

function month() {
  const w = world();
  const day = baghdadDay();
  order(w.raw, { id: 'a', coupon: 3000 });
  order(w.raw, { id: 'b' });
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent1','rent',10001,'${day}','Rent','admin');
    UPDATE users SET name='<b>Buyer</b> & "co"' WHERE id='buyer';`);
  return w;
}
function parseCsv(text: string): Row[] {
  const [head, ...lines] = text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  const split = (l: string) => { const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    out.push(cur); return out; };
  const keys = split(head);
  return lines.map((l) => Object.fromEntries(split(l).map((v, i) => [keys[i], v === '' ? null : /^-?\d+$/.test(v) ? Number(v) : v.replace(/^'/, '')])));
}

test('the workbook is the CSV’s rows in the brief’s columns, with the overheads row and a totals row', async () => {
  const w = month();
  const csv = parseCsv(await w.text(`/f/export.csv?view=orders&part=period&${period()}`));
  assert.ok(csv.some((r) => r.row_kind === 'overhead'), 'the period’s overheads row');
  const res = await get(w.app, `/f/export.xlsx?view=orders&${period()}&lang=ar`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="finance-orders-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  const files = unzip(new Uint8Array(await res.arrayBuffer()));
  const sheet = files.get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /rightToLeft="1"/);
  const grid = cells(sheet);
  const header = 6; // four heading lines, a blank, then the header
  assert.equal(grid.get(header)!.get('A')!.value, 'رقم الطلب');
  assert.equal(grid.get(header)!.get(LETTER.net)!.value, 'صافي الربح');
  const data = [...grid.keys()].filter((k) => k > header).sort((a, b) => a - b);
  const totalRow = data.pop()!;
  assert.equal(data.length, csv.length, 'one row per CSV row');
  const expect = csv.map((o) => reportRow(o, new Map(), 'ar'));
  data.forEach((rowNo, i) => {
    const got = grid.get(rowNo)!;
    for (const key of ['sales', 'delivery', 'cogs', 'courier', 'wages', 'materials', 'promotion', 'other', 'investor', 'discounts', 'net']) {
      const want = expect[i][key];
      if (want === null) assert.ok(!got.has(LETTER[key]), `row ${rowNo} ${key}: empty`);
      else assert.equal(got.get(LETTER[key])?.value, want, `row ${rowNo} ${key}`);
    }
  });
  assert.equal(grid.get(data[0])!.get(LETTER.customer_name)!.value, '<b>Buyer</b> & "co"', 'text kept as written, escaped in the file');
  // The totals: each number column's SUM over exactly the data rows, carrying the sum.
  const totals = grid.get(totalRow)!;
  assert.equal(totals.get('A')!.value, 'المجموع');
  for (const key of ['sales', 'cogs', 'other', 'net']) {
    const sum = expect.reduce((v, r) => v + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0);
    assert.equal(totals.get(LETTER[key])!.value, sum, `${key} total`);
    assert.equal(totals.get(LETTER[key])!.f, `SUM(${LETTER[key]}${data[0]}:${LETTER[key]}${data[data.length - 1]})`);
  }
  const csvNet = csv.reduce((v, r) => v + (typeof r.net_after_report_adjustments_iqd === 'number' ? r.net_after_report_adjustments_iqd : 0), 0);
  assert.equal(totals.get(LETTER.net)!.value, csvNet, 'the net total is the CSV’s, overheads included');
});

test('filtered, the file is the page’s rows with no overheads row; another view is refused', async () => {
  const w = month();
  const grid = cells(unzip(new Uint8Array(await (await get(w.app, `/f/export.xlsx?view=orders&${period()}&q=a`)).arrayBuffer())).get('xl/worksheets/sheet1.xml')!);
  const customers = [...grid.values()].map((r) => r.get(LETTER.customer_name)?.value);
  assert.ok(!customers.includes(REPORT_WORDS.overhead[0]), 'no overheads row under a search');
  assert.equal((await get(w.app, `/f/export.xlsx?view=products&${period()}`)).status, 400);
  assert.equal((await get(w.app, `/f/export.xlsx?view=orders&${period()}&state=nonsense`)).status, 400);
});

test('the printed page: a stand-alone document, A4 landscape, the print dialog its one script, every value escaped', async () => {
  const w = month();
  const res = await get(w.app, `/f/print?view=orders&${period()}&lang=en`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(res.headers.get('content-security-policy'), documentCsp());
  const html = await res.text();
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.ok(html.includes('@page { size: A4 landscape; margin: 8mm; }'));
  assert.equal(html.match(/<script>/g)?.length, 1);
  assert.ok(html.includes(`<script>${AUTO_PRINT_SCRIPT}</script>`));
  assert.ok(html.includes('&lt;b&gt;Buyer&lt;/b&gt; &amp; &quot;co&quot;') && !html.includes('<b>Buyer</b>'), 'escaped');
  assert.ok(html.includes('<th scope="col">Net profit</th>') && html.includes('<tfoot><tr><th scope="row">Total</th>'));
  const ar = await (await get(w.app, `/f/print?view=orders&${period()}`)).text();
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  assert.ok(ar.includes('<th scope="col">صافي الربح</th>'));
});

test('three languages: the words, the direction, and the Sorani its own', async () => {
  const w = month();
  const sheetOf = async (lang: string) => unzip(new Uint8Array(await (await get(w.app, `/f/export.xlsx?view=orders&${period()}&lang=${lang}`)).arrayBuffer())).get('xl/worksheets/sheet1.xml')!;
  const en = await sheetOf('en'), ckb = await sheetOf('ckb');
  assert.ok(!/rightToLeft/.test(en) && /rightToLeft="1"/.test(ckb));
  assert.ok(en.includes('>Net profit<') && ckb.includes('>قازانجی پوخت<'));
  for (const [key, [ar, en2, ckb2]] of [...Object.entries(REPORT_WORDS), ...REPORT_COLUMNS.map((c) => [c.key, c.header] as const)]) {
    assert.notEqual(ckb2, ar, `${key}: the Arabic in the Sorani slot`);
    assert.notEqual(ckb2, en2, `${key}: the English in the Sorani slot`);
    assert.match(ckb2, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb2, /[ةىيك]/, `${key}: no Arabic-only letter`);
  }
});
