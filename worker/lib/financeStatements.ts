/**
 * PAYMENT STATEMENTS (the owner's brief, 2026-11-12, part 2: «When withdrawing investor profits or paying employees, generate
 * detailed downloadable statements … Every statement must show exactly where each amount came from, with totals at the
 * bottom of each column»; DECISIONS row 330).
 *
 * A STAFF PAYMENT'S STATEMENT. A payment pays approved wage rows oldest first (POST /finance-operations/staff/:id/payments
 * writes `finance_payment_allocations`), and an advance pays the rows it is later settled against (payrollAdvance.ts). So the
 * statement is those rows: each wage's day, its order and products, the task, how it is counted (per piece, per order, a
 * percentage of the profit or of the sales, with its base), what it earned, what other payments had paid of it, what this
 * payment paid, and what is still due on it — with the totals, and the staff member's balance today beside them. Every
 * figure is read from the rows the payment wrote; nothing is recomputed.
 *
 * The same document as a workbook (worker/lib/xlsx.ts) and as a page to print or save as PDF, as the orders report
 * (financeOrdersReport.ts), in Arabic, English and Sorani.
 */
import type { XlsxColumn, XlsxSheet } from './xlsx';
import { xmlText } from './xlsx';
import { AUTO_PRINT_SCRIPT } from './securityPolicy';
import { PRINT_FONT_LINK, printBaseCss } from './printDocument';
import { effectiveStaffCostSql, staffAdvanceSql, staffPaymentBudget } from './financeParticipants';
import { notFound } from './http';
import { SURPLUS_PREFIX, SURPLUS_ROWS_SQL, surplusInstalled } from './investorSurplus';
import type { ReportLang } from './financeOrdersReport';

type Tri = readonly [ar: string, en: string, ckb: string];
type Row = Record<string, unknown>;
const pick = (lang: ReportLang, t: Tri) => (lang === 'en' ? t[1] : lang === 'ckb' ? t[2] : t[0]);
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const money = (v: unknown) => (isNum(v) ? v.toLocaleString('en-US') : '');
const baghdadClock = (at: Date) => new Date(at.getTime() + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

export const STATEMENT_WORDS = {
  staffTitle: ['كشف دفعة لموظف', 'Staff payment statement', 'کەشفی پارەدانی کارمەند'],
  staff: ['الموظف: {name}', 'Staff member: {name}', 'کارمەند: {name}'],
  payment: ['الدفعة: {amount} د.ع يوم {day}', 'Payment: {amount} IQD on {day}', 'پارەدان: {amount} د.ع لە {day}'],
  advance: ['سلفة: {amount} د.ع يوم {day}، تُسوّى مع الأجور حين تُستحق', 'Advance: {amount} IQD on {day}, set against wages as they are earned', 'پێشینە: {amount} د.ع لە {day}، لەگەڵ کرێ یەکلادەکرێتەوە کاتێک شایستە دەبێت'],
  note: ['ملاحظة: {note}', 'Note: {note}', 'تێبینی: {note}'],
  unsettled: ['ما لم يُسوَّ بعد من هذه السلفة: {amount} د.ع', 'Part of this advance not yet set against wages: {amount} IQD', 'بەشی ئەم پێشینەیە کە هێشتا یەکلانەکراوەتەوە: {amount} د.ع'],
  payable: ['المستحق للدفع اليوم: {amount} د.ع', 'Payable today: {amount} IQD', 'شایستەی پارەدان ئەمڕۆ: {amount} د.ع'],
  advances: ['سلف لم تُسوَّ بعد: {amount} د.ع', 'Advances not yet settled: {amount} IQD', 'پێشینەی یەکلانەکراوە: {amount} د.ع'],
  made: ['أُعدّ في {at} بتوقيت بغداد', 'Made {at}, Baghdad time', 'ئامادەکرا لە {at} بە کاتی بەغدا'],
  total: ['المجموع', 'Total', 'کۆی گشتی'],
  sheet: ['الكشف', 'Statement', 'کەشف'],
  none: ['لم تُسدّد هذه الدفعة أجرًا بعد', 'This payment has not paid a wage yet', 'ئەم پارەدانە هێشتا هیچ کرێیەکی نەداوە'],
  unit: ['{amount} للقطعة × {qty}', '{amount} per piece × {qty}', '{amount} بۆ هەر پارچەیەک × {qty}'],
  order: ['{amount} للطلب', '{amount} per order', '{amount} بۆ هەر داواکارییەک'],
  profit: ['{pct}% من الربح', '{pct}% of the profit', '{pct}% لە قازانج'],
  revenue: ['{pct}% من المبيعات', '{pct}% of the sales', '{pct}% لە فرۆشتن'],
  print: ['طباعة أو حفظ PDF من نافذة الطباعة', 'Print, or save as PDF from the print window', 'چاپ بکە، یان لە پەنجەرەی چاپ وەک PDF پاشەکەوت بکە'],
} as const satisfies Record<string, Tri>;
const W = STATEMENT_WORDS;

export const STAFF_STATEMENT_COLUMNS: Array<{ key: string; kind: XlsxColumn['kind']; header: Tri }> = [
  { key: 'cost_day', kind: 'date', header: ['يوم الأجر', 'Wage day', 'ڕۆژی کرێ'] },
  { key: 'order_id', kind: 'text', header: ['الطلب', 'Order', 'داواکاری'] },
  { key: 'products', kind: 'text', header: ['المنتجات', 'Products', 'بەرهەمەکان'] },
  { key: 'task', kind: 'text', header: ['المهمة', 'Task', 'ئەرک'] },
  { key: 'how', kind: 'text', header: ['طريقة الحساب', 'How it is counted', 'چۆنیەتی ژماردن'] },
  { key: 'base', kind: 'money', header: ['الأساس', 'Base', 'بنەما'] },
  { key: 'earned', kind: 'money', header: ['المستحق', 'Earned', 'شایستە'] },
  { key: 'paid_before', kind: 'money', header: ['دُفع بغيرها', 'Paid by other payments', 'بە پارەدانی تر دراوە'] },
  { key: 'paid_here', kind: 'money', header: ['دُفع بهذه الدفعة', 'Paid by this payment', 'بەم پارەدانە دراوە'] },
  { key: 'still_due', kind: 'money', header: ['الباقي', 'Still due', 'ماوە'] },
];

/** How a wage is counted, in words: the rule's own basis and amount (basis points for a percentage). */
export function howCounted(lang: ReportLang, basis: unknown, amount: unknown, qty: unknown): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const n = isNum(amount) ? amount : Number(amount);
  if (!Number.isFinite(n)) return '';
  if (basis === 'unit') return fill(pick(lang, W.unit), { amount: n.toLocaleString('en-US'), qty: String(qty ?? '') });
  if (basis === 'order') return fill(pick(lang, W.order), { amount: n.toLocaleString('en-US') });
  const pct = (n / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (basis === 'profit_percent') return fill(pick(lang, W.profit), { pct });
  if (basis === 'revenue_percent') return fill(pick(lang, W.revenue), { pct });
  return '';
}

export interface StaffPaymentStatement {
  payment: { id: string; staff_id: string; staff_name: string; amount_iqd: number; kind: string; payment_day: string; note: string };
  rows: Row[];
  /** For an advance: what of it no wage has been set against yet. */
  unsettled_iqd: number | null;
  payable_today_iqd: number;
  advances_iqd: number;
}

/** The statement of one staff payment or advance, from the rows it wrote. */
export async function staffPaymentStatement(db: D1Database, paymentId: string): Promise<StaffPaymentStatement> {
  const p = await db.prepare(`SELECT p.id,p.staff_id,s.name AS staff_name,p.amount_iqd,p.kind,p.payment_day,p.note
      FROM finance_staff_payments p JOIN finance_staff s ON s.id=p.staff_id WHERE p.id=?`).bind(paymentId)
    .first<StaffPaymentStatement['payment']>();
  if (!p) throw notFound('Payment not found');
  const rows = (await db.prepare(`SELECT c.cost_day,c.order_id,c.rule_name AS task,c.qty,c.base_iqd AS base,${effectiveStaffCostSql('c')} AS earned,a.amount_iqd AS paid_here,
      COALESCE((SELECT basis FROM finance_wage_targets t WHERE t.cost_id=c.id),json_extract(c.snapshot,'$.rule.basis')) AS basis,
      json_extract(c.snapshot,'$.rule.amount') AS rule_amount,
      (SELECT COALESCE(SUM(o.amount_iqd),0) FROM finance_payment_allocations o WHERE o.cost_id=c.id AND o.payment_id<>a.payment_id) AS paid_before,
      (SELECT group_concat(i.name_snapshot||' ×'||i.qty,'، ') FROM order_items i WHERE i.order_id=c.order_id AND i.bundle_parent_item_id IS NULL) AS products
    FROM finance_payment_allocations a JOIN finance_order_costs c ON c.id=a.cost_id WHERE a.payment_id=? ORDER BY c.cost_day,c.id`).bind(paymentId).all<Row>()).results ?? [];
  const settled = rows.reduce((n, r) => n + Number(r.paid_here ?? 0), 0);
  const [budget, advance] = await Promise.all([
    staffPaymentBudget(db, p.staff_id),
    db.prepare(`SELECT ${staffAdvanceSql('?')} AS n`).bind(p.staff_id).first<{ n: number }>(),
  ]);
  return {
    payment: p,
    rows: rows.map((r) => ({ ...r, still_due: Math.max(0, Number(r.earned ?? 0) - Number(r.paid_before ?? 0) - Number(r.paid_here ?? 0)) })),
    unsettled_iqd: p.kind === 'advance' ? Math.max(0, p.amount_iqd - settled) : null,
    payable_today_iqd: budget.available_iqd,
    advances_iqd: Number(advance?.n ?? 0),
  };
}

/** The statement as one workbook sheet. */
export function staffStatementSheet(st: StaffPaymentStatement, lang: ReportLang, at: Date): XlsxSheet {
  const p = st.payment;
  const heading = [
    pick(lang, W.staffTitle),
    fill(pick(lang, W.staff), { name: p.staff_name }),
    fill(pick(lang, p.kind === 'advance' ? W.advance : W.payment), { amount: money(p.amount_iqd), day: p.payment_day }),
    ...(p.note ? [fill(pick(lang, W.note), { note: p.note })] : []),
    ...(st.unsettled_iqd !== null ? [fill(pick(lang, W.unsettled), { amount: money(st.unsettled_iqd) })] : []),
    fill(pick(lang, W.payable), { amount: money(st.payable_today_iqd) }),
    fill(pick(lang, W.advances), { amount: money(st.advances_iqd) }),
    fill(pick(lang, W.made), { at: baghdadClock(at) }),
    ...(st.rows.length ? [] : [pick(lang, W.none)]),
  ];
  return {
    name: pick(lang, W.sheet),
    rtl: lang !== 'en',
    heading,
    totalLabel: pick(lang, W.total),
    columns: STAFF_STATEMENT_COLUMNS.map((c) => ({ key: c.key, kind: c.kind, header: pick(lang, c.header), ...(c.key === 'base' ? { total: false } : {}), ...(c.key === 'products' ? { width: 40 } : {}) })),
    rows: st.rows.map((r) => ({ ...r, how: howCounted(lang, r.basis, r.rule_amount, r.qty), base: r.basis === 'profit_percent' || r.basis === 'revenue_percent' ? r.base : null })),
  };
}

/** Escaped text with its days and times kept left to right inside an Arabic line. */
const textHtml = (s: string) => xmlText(s).replace(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g, (m) => `<span dir="ltr">${m}</span>`);

/** Any statement sheet as a stand-alone print document (asDocument): its heading, its table, its totals. */
export function statementHtml(sheet: XlsxSheet, lang: ReportLang): string {
  const dir = lang === 'en' ? 'ltr' : 'rtl';
  const [title, ...lines] = sheet.heading ?? [];
  const totals = sheet.columns.map((c, j) => {
    if (j === 0) return `<th scope="row">${xmlText(sheet.totalLabel ?? '')}</th>`;
    if (c.kind === 'text' || c.kind === 'date' || c.total === false) return '<td></td>';
    let sum = 0;
    for (const r of sheet.rows) if (isNum(r[c.key])) sum += r[c.key] as number;
    return `<td class="num"><span dir="ltr">${money(sum)}</span></td>`;
  }).join('');
  const body = sheet.rows.map((r) => `<tr>${sheet.columns.map((c) => c.kind === 'text' || c.kind === 'date'
    ? `<td>${textHtml(String(r[c.key] ?? ''))}</td>`
    : `<td class="num"><span dir="ltr">${money(r[c.key])}</span></td>`).join('')}</tr>`).join('');
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${xmlText(title ?? '')}</title>${PRINT_FONT_LINK}<style>${printBaseCss(10)}
  @page { size: A4 landscape; margin: 10mm; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  p { margin: 0 0 2px; font-size: 11px; color: #3a4048; }
  table { font-size: 10px; margin-top: 10px; }
  th, td { border: 1px solid #c9ced6; padding: 4px 5px; text-align: start; vertical-align: top; }
  thead th { background: #e8eef2; font-weight: 700; }
  td.num { text-align: end; white-space: nowrap; }
  tfoot th, tfoot td { font-weight: 700; border-top: 2px solid #8899a6; }
</style></head><body>
<h1>${xmlText(title ?? '')}</h1>${lines.map((l) => `<p>${textHtml(l)}</p>`).join('')}<p class="no-print">${xmlText(pick(lang, W.print))}</p>
<table><thead><tr>${sheet.columns.map((c) => `<th scope="col">${xmlText(c.header)}</th>`).join('')}</tr></thead>
<tbody>${body}</tbody><tfoot><tr>${totals}</tr></tfoot></table>
<script>${AUTO_PRINT_SCRIPT}</script></body></html>`;
}

// ─────────────────────────────────────────────────────────────── an investor's withdrawal

/**
 * AN INVESTOR'S WITHDRAWAL STATEMENT (the owner's brief, 2026-11-12, part 2: «Investors: Investment amount, product name,
 * unit cost, selling price, all expenses and discounts, final net profit, profit-sharing percentage, and the investor's
 * actual earnings»; DECISIONS row 331).
 *
 * A withdrawal draws on earnings rows (finance_withdrawal_allocations): one profit row and one capital row per agreement
 * (`invprofit:<agreement>`, `invcapital:<agreement>`), a purchase's capital surplus (`invsurplus:<purchase>`), or — for a
 * staff member's request — wage rows. The statement has two tables:
 *   THE SUMMARY   one line per agreement: what was invested, the profit share, the profit earned and the capital returned
 *                 to date (the ledger's own accrued figures, never recomputed), what earlier withdrawals paid of them, what
 *                 this withdrawal takes, and what remains; a surplus or a wage as its own line;
 *   THE UNITS     every sold unit behind those agreements (investor_allocation_results, one per inventory allocation): its
 *                 order, day and product, the pieces, the sale, the goods cost, the expenses, the profit, the share, the
 *                 investor's profit, the capital it returned and any loss — as the ledger recorded them, a unit still
 *                 waiting named so.
 */
export const WITHDRAWAL_WORDS = {
  title: ['كشف سحب مستثمر', 'Investor withdrawal statement', 'کەشفی ڕاکێشانی وەبەرهێنەر'],
  investor: ['المستثمر: {name}', 'Investor: {name}', 'وەبەرهێنەر: {name}'],
  request: ['السحب: {amount} د.ع، طُلب يوم {day}، دُفع منه {paid} د.ع', 'Withdrawal: {amount} IQD, requested {day}, {paid} IQD of it paid', 'ڕاکێشان: {amount} د.ع، لە {day} داواکرا، {paid} د.ع ی لێ دراوە'],
  summary: ['الملخص', 'Summary', 'کورتە'],
  units: ['الوحدات المبيعة', 'Units sold', 'یەکە فرۆشراوەکان'],
  surplus: ['فائض رأس مال: {title}', 'Capital surplus: {title}', 'زیادەی سەرمایە: {title}'],
  wage: ['أجر: {task}', 'Wage: {task}', 'کرێ: {task}'],
  counted: ['محتسب', 'Counted', 'ژمێردراو'],
  waiting: ['ينتظر', 'Waiting', 'چاوەڕێ'],
  note: ['الأرباح ورأس المال المسترد كما سجّلها الدفتر حتى اليوم؛ الباقي = المكتسب − ما دفعته سحوبات سابقة − هذا السحب.', 'Profit and capital returned as the ledger recorded them to date; remaining = earned − paid by earlier withdrawals − this withdrawal.', 'قازانج و سەرمایەی گەڕاوە وەک دەفتەر تا ئەمڕۆ تۆماری کردوون؛ ماوە = بەدەستهاتوو − ئەوەی ڕاکێشانی پێشوو داویانە − ئەم ڕاکێشانە.'],
} as const satisfies Record<string, Tri>;
const WW = WITHDRAWAL_WORDS;

type StatementColumn = { key: string; kind: XlsxColumn['kind']; header: Tri };
export const WITHDRAWAL_SUMMARY_COLUMNS: StatementColumn[] = [
  { key: 'name', kind: 'text', header: ['الاتفاق', 'Agreement', 'ڕێککەوتن'] },
  { key: 'invested', kind: 'money', header: ['المبلغ المستثمر', 'Invested', 'بڕی وەبەرهێنراو'] },
  { key: 'share', kind: 'text', header: ['حصة الربح', 'Profit share', 'بەشی قازانج'] },
  { key: 'profit', kind: 'money', header: ['الربح المكتسب', 'Profit earned', 'قازانجی بەدەستهاتوو'] },
  { key: 'capital', kind: 'money', header: ['رأس المال المسترد', 'Capital returned', 'سەرمایەی گەڕاوە'] },
  { key: 'paid_before', kind: 'money', header: ['دفعته سحوبات سابقة', 'Paid by earlier withdrawals', 'ڕاکێشانی پێشوو دایانە'] },
  { key: 'this', kind: 'money', header: ['هذا السحب', 'This withdrawal', 'ئەم ڕاکێشانە'] },
  { key: 'remaining', kind: 'money', header: ['الباقي', 'Remaining', 'ماوە'] },
];
export const WITHDRAWAL_UNIT_COLUMNS: StatementColumn[] = [
  { key: 'agreement', kind: 'text', header: ['الاتفاق', 'Agreement', 'ڕێککەوتن'] },
  { key: 'order_id', kind: 'text', header: ['الطلب', 'Order', 'داواکاری'] },
  { key: 'day', kind: 'date', header: ['يوم التسليم', 'Delivered', 'ڕۆژی گەیاندن'] },
  { key: 'product', kind: 'text', header: ['المنتج', 'Product', 'بەرهەم'] },
  { key: 'qty', kind: 'int', header: ['القطع', 'Pieces', 'پارچە'] },
  { key: 'revenue', kind: 'money', header: ['سعر البيع', 'Sale', 'نرخی فرۆشتن'] },
  { key: 'cost', kind: 'money', header: ['تكلفة البضاعة', 'Goods cost', 'تێچووی کاڵا'] },
  { key: 'expenses', kind: 'money', header: ['المصاريف', 'Expenses', 'خەرجییەکان'] },
  { key: 'net', kind: 'money', header: ['صافي الربح', 'Net profit', 'قازانجی پوخت'] },
  { key: 'share', kind: 'text', header: ['حصة الربح', 'Profit share', 'بەشی قازانج'] },
  { key: 'earning', kind: 'money', header: ['ربح المستثمر', 'Investor’s profit', 'قازانجی وەبەرهێنەر'] },
  { key: 'capital', kind: 'money', header: ['رأس المال المسترد', 'Capital returned', 'سەرمایەی گەڕاوە'] },
  { key: 'loss', kind: 'money', header: ['الخسارة', 'Loss', 'زیان'] },
  { key: 'state', kind: 'text', header: ['الحالة', 'State', 'دۆخ'] },
];

export interface WithdrawalStatement {
  withdrawal: { id: string; user_id: string; user_name: string; amount_iqd: number; paid_iqd: number; state: string; created_at: string };
  summary: Row[];
  units: Row[];
}

const pct = (bps: unknown) => (isNum(bps) ? `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : '');
const snap = (v: unknown, key: string): number | null => {
  try { const x = (JSON.parse(String(v ?? '{}')) as Record<string, unknown>)[key]; return isNum(x) ? x : null; } catch { return null; }
};

/** The statement of one withdrawal, from the rows it reserved and the ledger's own figures. */
export async function withdrawalStatement(db: D1Database, withdrawalId: string, lang: ReportLang): Promise<WithdrawalStatement> {
  const w = await db.prepare(`SELECT w.id,w.user_id,COALESCE(u.name,u.email,w.user_id) AS user_name,w.amount_iqd,w.paid_iqd,w.state,w.created_at
      FROM finance_withdrawals w LEFT JOIN users u ON u.id=w.user_id WHERE w.id=?`).bind(withdrawalId).first<WithdrawalStatement['withdrawal']>();
  if (!w) throw notFound('Withdrawal not found');
  const allocs = (await db.prepare(`SELECT a.source_kind,a.source_id,a.amount_iqd,
      (SELECT COALESCE(SUM(o.paid_iqd),0) FROM finance_withdrawal_allocations o WHERE o.source_kind=a.source_kind AND o.source_id=a.source_id AND o.withdrawal_id<>a.withdrawal_id) AS paid_before
    FROM finance_withdrawal_allocations a WHERE a.withdrawal_id=? ORDER BY a.source_kind,a.source_id`).bind(withdrawalId)
    .all<{ source_kind: string; source_id: string; amount_iqd: number; paid_before: number }>()).results ?? [];
  const contractOf = (id: string) => (/^inv(?:profit|capital):/.test(id) ? id.slice(id.indexOf(':') + 1) : null);
  const contractIds = [...new Set(allocs.map((a) => contractOf(a.source_id)).filter((x): x is string => !!x))];
  const contracts = contractIds.length ? (await db.prepare(`SELECT c.id,c.name,c.principal_iqd,c.profit_share_bps,
      (SELECT accrued_iqd FROM finance_investor_earnings WHERE id='invprofit:'||c.id) AS profit,
      (SELECT accrued_iqd FROM finance_investor_earnings WHERE id='invcapital:'||c.id) AS capital
    FROM investment_contracts c WHERE c.id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at,c.id`).bind(JSON.stringify(contractIds)).all<Row>()).results ?? [] : [];
  const summary: Row[] = contracts.map((c) => {
    const mine = allocs.filter((a) => contractOf(a.source_id) === c.id);
    const paidBefore = mine.reduce((n, a) => n + Number(a.paid_before), 0), here = mine.reduce((n, a) => n + Number(a.amount_iqd), 0);
    const earned = Number(c.profit ?? 0) + Number(c.capital ?? 0);
    return { name: c.name, invested: c.principal_iqd, share: pct(c.profit_share_bps), profit: c.profit ?? 0, capital: c.capital ?? 0,
      paid_before: paidBefore, this: here, remaining: Math.max(0, earned - paidBefore - here) };
  });
  // A purchase's capital surplus, as the withdrawal page itself reads it (investorSurplus.ts): its invoice number and the
  // whole surplus; one no longer listed (a contract took the cash since) keeps its id's tail and no total.
  const surplusIds = allocs.filter((a) => a.source_id.startsWith(SURPLUS_PREFIX)).map((a) => a.source_id);
  const surplus = new Map<string, { title: string; amount_iqd: number }>();
  if (surplusIds.length && await surplusInstalled(db)) {
    for (const r of (await db.prepare(`SELECT id,title,amount_iqd FROM (${SURPLUS_ROWS_SQL}) WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(w.user_id, JSON.stringify(surplusIds)).all<{ id: string; title: string; amount_iqd: number }>()).results ?? []) surplus.set(r.id, r);
  }
  for (const a of allocs.filter((x) => !contractOf(x.source_id))) {
    if (a.source_kind === 'staff') {
      const cost = await db.prepare(`SELECT c.rule_name,c.order_id,${effectiveStaffCostSql('c')} AS earned FROM finance_order_costs c WHERE c.id=?`).bind(a.source_id).first<Row>();
      summary.push({ name: fill(pick(lang, WW.wage), { task: `${String(cost?.rule_name ?? a.source_id)} — ${String(cost?.order_id ?? '')}` }), invested: null, share: '',
        profit: cost?.earned ?? null, capital: null, paid_before: a.paid_before, this: a.amount_iqd, remaining: null });
    } else {
      const s = surplus.get(a.source_id), whole = s ? s.amount_iqd : null;
      summary.push({ name: fill(pick(lang, WW.surplus), { title: s?.title ?? a.source_id.slice(SURPLUS_PREFIX.length).slice(-8) }), invested: null, share: '',
        profit: null, capital: whole, paid_before: a.paid_before, this: a.amount_iqd,
        remaining: whole === null ? null : Math.max(0, whole - Number(a.paid_before) - Number(a.amount_iqd)) });
    }
  }
  const units = contractIds.length ? (await db.prepare(`SELECT r.contract_id,c.name AS agreement,c.profit_share_bps,a.order_id,date(o.delivered_at,'+3 hours') AS day,
      i.name_snapshot AS product,r.snapshot,r.profit_iqd,r.capital_iqd,r.loss_iqd,r.eligible,r.pending
    FROM investor_allocation_results r JOIN investment_contracts c ON c.id=r.contract_id
      JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN order_items i ON i.id=a.order_item_id JOIN orders o ON o.id=a.order_id
    WHERE r.contract_id IN (SELECT value FROM json_each(?)) ORDER BY o.delivered_at,a.order_id,r.allocation_id`).bind(JSON.stringify(contractIds)).all<Row>()).results ?? [] : [];
  return {
    withdrawal: w,
    summary,
    units: units.map((u) => ({
      agreement: u.agreement, order_id: u.order_id, day: u.day, product: u.product, qty: snap(u.snapshot, 'qty'),
      revenue: snap(u.snapshot, 'revenue'), cost: snap(u.snapshot, 'cost'), expenses: snap(u.snapshot, 'expenses'), net: snap(u.snapshot, 'profit'),
      share: pct(u.profit_share_bps), earning: u.profit_iqd, capital: u.capital_iqd, loss: u.loss_iqd,
      state: pick(lang, Number(u.eligible) === 1 && !Number(u.pending) ? WW.counted : WW.waiting),
    })),
  };
}

/** The withdrawal statement as a workbook: the summary sheet, then the units sheet. */
export function withdrawalSheets(st: WithdrawalStatement, lang: ReportLang, at: Date): XlsxSheet[] {
  const w = st.withdrawal;
  const heading = [
    pick(lang, WW.title),
    fill(pick(lang, WW.investor), { name: w.user_name }),
    fill(pick(lang, WW.request), { amount: money(w.amount_iqd), day: String(w.created_at).slice(0, 10), paid: money(w.paid_iqd) }),
    pick(lang, WW.note),
    fill(pick(lang, W.made), { at: baghdadClock(at) }),
  ];
  const cols = (list: StatementColumn[]) => list.map((c) => ({ key: c.key, kind: c.kind, header: pick(lang, c.header), ...(c.key === 'invested' ? { total: false } : {}) }));
  return [
    { name: pick(lang, WW.summary), rtl: lang !== 'en', heading, totalLabel: pick(lang, W.total), columns: cols(WITHDRAWAL_SUMMARY_COLUMNS), rows: st.summary },
    { name: pick(lang, WW.units), rtl: lang !== 'en', heading: [pick(lang, WW.units), fill(pick(lang, WW.investor), { name: w.user_name })], totalLabel: pick(lang, W.total),
      columns: cols(WITHDRAWAL_UNIT_COLUMNS), rows: st.units },
  ];
}

/** Several statement sheets as one stand-alone print document: each sheet's heading, table and totals, a page apart. */
export function statementsHtml(sheets: XlsxSheet[], lang: ReportLang): string {
  if (sheets.length === 1) return statementHtml(sheets[0], lang);
  const first = statementHtml(sheets[0], lang);
  const bodies = sheets.map((s, i) => {
    const html = statementHtml(s, lang);
    const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('<script>'));
    // The «print or save as PDF» hint once, above the first table.
    return i === 0 ? body : `<div class="page-break"></div>${body.replace(/<p class="no-print">[^<]*<\/p>/, '')}`;
  }).join('');
  return `${first.slice(0, first.indexOf('</style>'))}  .page-break { break-before: page; }\n${first.slice(first.indexOf('</style>'), first.indexOf('<body>') + 6)}${bodies}<script>${AUTO_PRINT_SCRIPT}</script></body></html>`;
}
