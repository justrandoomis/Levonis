/**
 * THE ORDERS REPORT AS A WORKBOOK AND AS A PRINTED PAGE (the owner's brief, 2026-11-12, part 1: «downloadable, printable
 * Excel/PDF reports for any selected period … detailed columns for every order: order ID, customer name, products, sales
 * amount, product cost, delivery fees, employee costs, investor shares, promotional expenses, discounts, other expenses, and
 * final net profit … totals at the bottom of every numerical column»).
 *
 * THE SAME ROWS AS THE CSV (adminFinanceWorkspace.ts exportOrderRows), so the three files agree: the period's orders, each
 * with its own figures, and — for the whole period — a last row with the period's general expenses and a promotion with no
 * sales, so the totals row's net is the statement's net. An unknown amount is an empty cell, never 0.
 *
 * THE COLUMNS ADD UP TO THE NET, left to right: sales (the goods kept, after item discounts and refunds) + delivery charged −
 * goods cost − the courier's fee − staff wages − materials − promotion − other expenses (costs linked to the order, payment
 * fees; the period's general expenses on the last row) − investor shares − discounts (the order's coupon beyond its goods,
 * price protection credited, a returned trade-in's credit) = net profit. That is the statement's own arithmetic
 * (orderProfit.ts, overlay deductions), only grouped as the brief names it.
 */
import type { XlsxColumn, XlsxSheet } from './xlsx';
import { xmlText } from './xlsx';
import { AUTO_PRINT_SCRIPT } from './securityPolicy';
import { PRINT_FONT_LINK, printBaseCss } from './printDocument';

export type ReportLang = 'ar' | 'en' | 'ckb';
type Tri = readonly [ar: string, en: string, ckb: string];
type Row = Record<string, unknown>;

const W = {
  title: ['تقرير الطلبات — المال والأرباح', 'Orders report — Money & profit', 'ڕاپۆرتی داواکارییەکان — پارە و قازانج'],
  period: ['الفترة: {from} إلى {to}', 'Period: {from} to {to}', 'ماوە: {from} تا {to}'],
  made: ['أُعدّ في {at} بتوقيت بغداد', 'Made {at}, Baghdad time', 'ئامادەکرا لە {at} بە کاتی بەغدا'],
  note: ['المبيعات بعد خصومات البضاعة والمرتجعات. الخلية الفارغة مبلغ لم يُعرف بعد.', 'Sales are after item discounts and refunds. An empty cell is an amount not known yet.', 'فرۆشتن دوای داشکاندنی کاڵا و گەڕاندنەوەکانە. خانەی بەتاڵ بڕێکە کە هێشتا نەزانراوە.'],
  total: ['المجموع', 'Total', 'کۆی گشتی'],
  overhead: ['المصاريف العامة للفترة وترويج شهر بلا مبيعات', 'The period’s general expenses and a promotion with no sales', 'خەرجییە گشتییەکانی ماوەکە و بانگەشەی مانگێکی بێ فرۆشتن'],
  returned: ['مرتجع', 'returned', 'گەڕێنراوە'],
  confirmed: ['مؤكد', 'Confirmed', 'دڵنیاکراوە'],
  estimated: ['تقديري', 'Estimated', 'خەمڵێنراو'],
  waiting: ['ينتظر', 'Waiting', 'چاوەڕێ'],
  sheet: ['الطلبات', 'Orders', 'داواکارییەکان'],
  print: ['طباعة أو حفظ PDF من نافذة الطباعة', 'Print, or save as PDF from the print window', 'چاپ بکە، یان لە پەنجەرەی چاپ وەک PDF پاشەکەوت بکە'],
} as const satisfies Record<string, Tri>;

const COLUMNS: Array<{ key: string; kind: XlsxColumn['kind']; header: Tri }> = [
  { key: 'order_id', kind: 'text', header: ['رقم الطلب', 'Order', 'ژمارەی داواکاری'] },
  { key: 'delivered_day', kind: 'date', header: ['يوم التسليم', 'Delivered', 'ڕۆژی گەیاندن'] },
  { key: 'customer_name', kind: 'text', header: ['الزبون', 'Customer', 'کڕیار'] },
  { key: 'products', kind: 'text', header: ['المنتجات', 'Products', 'بەرهەمەکان'] },
  { key: 'sales', kind: 'money', header: ['المبيعات', 'Sales', 'فرۆشتن'] },
  { key: 'delivery', kind: 'money', header: ['التوصيل المحصّل', 'Delivery charged', 'گەیاندنی وەرگیراو'] },
  { key: 'cogs', kind: 'money', header: ['تكلفة البضاعة', 'Goods cost', 'تێچووی کاڵا'] },
  { key: 'courier', kind: 'money', header: ['أجرة شركة التوصيل', 'Courier fee', 'کرێی کۆمپانیای گەیاندن'] },
  { key: 'wages', kind: 'money', header: ['أجور الموظفين', 'Staff wages', 'کرێی کارمەندان'] },
  { key: 'materials', kind: 'money', header: ['مواد التغليف', 'Materials', 'کەرەستەی پێچانەوە'] },
  { key: 'promotion', kind: 'money', header: ['الترويج', 'Promotion', 'بانگەشە'] },
  { key: 'other', kind: 'money', header: ['مصاريف أخرى', 'Other expenses', 'خەرجیی تر'] },
  { key: 'investor', kind: 'money', header: ['حصص المستثمرين', 'Investor shares', 'بەشی وەبەرهێنەران'] },
  { key: 'discounts', kind: 'money', header: ['الخصومات', 'Discounts', 'داشکاندنەکان'] },
  { key: 'net', kind: 'money', header: ['صافي الربح', 'Net profit', 'قازانجی پوخت'] },
  { key: 'state', kind: 'text', header: ['الحالة', 'State', 'دۆخ'] },
];

const pick = (lang: ReportLang, t: Tri) => (lang === 'en' ? t[1] : lang === 'ckb' ? t[2] : t[0]);
const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A sum of amounts: unknown when any of them is (null or absent), as every total on the screens. */
const plus = (...xs: unknown[]): number | null => (xs.every(isNum) ? (xs as number[]).reduce((a, x) => a + x, 0) : null);
const amount = (v: unknown): number | null => (isNum(v) ? v : null);

/** Each order's products, «name ×qty», with the returned pieces named. */
export function productsOf(bases: ReadonlyArray<{ order_id: string; lines: ReadonlyArray<{ name_snapshot: string; qty: number; returned_qty: number }> }>, lang: ReportLang) {
  const sep = lang === 'en' ? '; ' : '، ';
  return new Map(bases.map((b) => [b.order_id, b.lines.map((l) => `${l.name_snapshot} ×${l.qty}${l.returned_qty ? ` (${pick(lang, W.returned)} ${l.returned_qty})` : ''}`).join(sep)]));
}

/** One file row from one CSV row (exportOrderRows). */
export function reportRow(o: Row, products: ReadonlyMap<string, string>, lang: ReportLang): Row {
  if (o.row_kind === 'overhead') {
    return { order_id: '', delivered_day: '', customer_name: pick(lang, W.overhead), products: '', sales: null, delivery: null, cogs: null, courier: null,
      wages: null, materials: null, promotion: amount(o.promotion_iqd), other: amount(o.general_expenses_iqd), investor: null, discounts: null,
      net: amount(o.net_after_report_adjustments_iqd), state: '' };
  }
  const state = o.finance_state === 'confirmed' ? W.confirmed : o.finance_state === 'estimated' ? W.estimated : o.finance_state === 'waiting' ? W.waiting : null;
  return {
    order_id: o.order_id, delivered_day: o.delivered_day, customer_name: o.customer_name, products: products.get(String(o.order_id)) ?? '',
    sales: amount(o.retained_revenue_iqd), delivery: plus(o.shipping_income_iqd, o.cod_tax_iqd), cogs: amount(o.cogs_iqd), courier: amount(o.courier_fee_iqd),
    wages: amount(o.wages_iqd), materials: amount(o.materials_iqd), promotion: amount(o.promotion_iqd), other: plus(o.manual_direct_iqd, o.payment_fee_iqd),
    investor: amount(o.investor_iqd), discounts: plus(o.coupon_iqd, o.price_protection_iqd, o.trade_in_credit_returned_iqd),
    net: amount(o.net_after_report_adjustments_iqd), state: state ? pick(lang, state) : '',
  };
}

export interface OrdersReportInput {
  from: string;
  to: string;
  lang: ReportLang;
  /** The instant the file is made; written in Baghdad time. */
  at: Date;
  /** exportOrderRows' rows, the overhead row last when there is one. */
  orders: ReadonlyArray<Row>;
  products: ReadonlyMap<string, string>;
}

const baghdadClock = (at: Date) => new Date(at.getTime() + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

/** The report as one workbook sheet. */
export function ordersReportSheet(input: OrdersReportInput): XlsxSheet {
  const { lang } = input;
  return {
    name: pick(lang, W.sheet),
    rtl: lang !== 'en',
    heading: [pick(lang, W.title), fill(pick(lang, W.period), { from: input.from, to: input.to }), fill(pick(lang, W.made), { at: baghdadClock(input.at) }), pick(lang, W.note)],
    totalLabel: pick(lang, W.total),
    columns: COLUMNS.map((c) => ({ key: c.key, kind: c.kind, header: pick(lang, c.header), ...(c.key === 'products' ? { width: 48 } : {}) })),
    rows: input.orders.map((o) => reportRow(o, input.products, lang)),
  };
}

const money = (v: unknown) => (isNum(v) ? v.toLocaleString('en-US') : '');
/** Escaped text with its days and times kept left to right: inside an Arabic line «2026-11-12» would read «12-11-2026». */
const textHtml = (s: string) => xmlText(s).replace(/\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?/g, (m) => `<span dir="ltr">${m}</span>`);

/**
 * The report as a stand-alone print document (asDocument; the one hashed script opens the print dialog, where «Save as
 * PDF» is the PDF — Arabic is shaped by the browser itself). A4 landscape, the header repeated on every sheet, the totals
 * row last, every value escaped.
 */
export function ordersReportHtml(input: OrdersReportInput): string {
  const sheet = ordersReportSheet(input), dir = input.lang === 'en' ? 'ltr' : 'rtl';
  const totals = sheet.columns.map((c, j) => {
    if (j === 0) return `<th scope="row">${xmlText(sheet.totalLabel ?? '')}</th>`;
    if (c.kind === 'text' || c.kind === 'date') return '<td></td>';
    let sum = 0;
    for (const r of sheet.rows) if (isNum(r[c.key])) sum += r[c.key] as number;
    return `<td class="num"><span dir="ltr">${money(sum)}</span></td>`;
  }).join('');
  const body = sheet.rows.map((r) => `<tr>${sheet.columns.map((c) => c.kind === 'text' || c.kind === 'date'
    ? `<td${c.key === 'products' ? ' class="products"' : ''}>${textHtml(String(r[c.key] ?? ''))}</td>`
    : `<td class="num"><span dir="ltr">${money(r[c.key])}</span></td>`).join('')}</tr>`).join('');
  const [title, ...lines] = sheet.heading ?? [];
  return `<!doctype html><html lang="${input.lang === 'ckb' ? 'ckb' : input.lang}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${xmlText(title ?? '')}</title>${PRINT_FONT_LINK}<style>${printBaseCss(8)}
  @page { size: A4 landscape; margin: 8mm; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p { margin: 0 0 2px; font-size: 10px; color: #3a4048; }
  .hint { margin: 0 0 10px; }
  table { font-size: 9px; margin-top: 8px; }
  th, td { border: 1px solid #c9ced6; padding: 3px 4px; text-align: start; vertical-align: top; }
  thead th { background: #e8eef2; font-weight: 700; }
  td.num { text-align: end; white-space: nowrap; }
  td.products { max-width: 240px; }
  tfoot th, tfoot td { font-weight: 700; border-top: 2px solid #8899a6; }
</style></head><body>
<h1>${xmlText(title ?? '')}</h1>${lines.map((l) => `<p>${textHtml(l)}</p>`).join('')}<p class="hint no-print">${xmlText(pick(input.lang, W.print))}</p>
<table><thead><tr>${sheet.columns.map((c) => `<th scope="col">${xmlText(c.header)}</th>`).join('')}</tr></thead>
<tbody>${body}</tbody><tfoot><tr>${totals}</tr></tfoot></table>
<script>${AUTO_PRINT_SCRIPT}</script></body></html>`;
}

export const REPORT_LANGS: readonly ReportLang[] = ['ar', 'en', 'ckb'];
export const REPORT_WORDS = W;
export const REPORT_COLUMNS = COLUMNS;
