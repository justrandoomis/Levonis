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
import { financeDocumentHtml, type DocFigure } from './financeDocument';

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
  // The arrangement (DECISIONS row 334): the column groups, the summary figures and the summary sheet.
  gOrder: ['الطلب', 'Order', 'داواکاری'],
  gRevenue: ['الإيراد', 'Revenue', 'داهاتەکان'],
  gCosts: ['التكاليف', 'Costs', 'تێچووەکان'],
  gShares: ['الحصص والخصومات', 'Shares and discounts', 'بەش و داشکاندن'],
  gResult: ['النتيجة', 'Result', 'ئەنجام'],
  fOrders: ['الطلبات', 'Orders', 'داواکارییەکان'],
  fSales: ['المبيعات', 'Sales', 'فرۆشتن'],
  fDelivery: ['التوصيل المحصّل', 'Delivery charged', 'گەیاندنی وەرگیراو'],
  fCosts: ['التكاليف', 'Costs', 'تێچووەکان'],
  fShares: ['الحصص والخصومات', 'Shares and discounts', 'بەش و داشکاندن'],
  fNet: ['صافي الربح', 'Net profit', 'قازانجی پوخت'],
  fMargin: ['الهامش من المبيعات والتوصيل', 'Margin on sales and delivery', 'ڕێژەی قازانج لە فرۆشتن و گەیاندن'],
  summarySheet: ['الملخص', 'Summary', 'کورتە'],
  item: ['البند', 'Item', 'بڕگە'],
  value: ['القيمة', 'Value', 'بەها'],
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
      net: amount(o.net_after_report_adjustments_iqd), state: '', __kind: 'overhead' };
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
    // Left to right as the net is built: the order, what came in, what it cost, what went to others, what is left.
    groups: [
      { label: pick(lang, W.gOrder), span: 4 }, { label: pick(lang, W.gRevenue), span: 2 }, { label: pick(lang, W.gCosts), span: 6 },
      { label: pick(lang, W.gShares), span: 2 }, { label: pick(lang, W.gResult), span: 2 },
    ],
    strong: ['net'],
  };
}

/** The figures a reader looks for first: the orders, what came in, what it cost, what went to others, the net and its margin. */
export function ordersReportFigures(sheet: XlsxSheet, lang: ReportLang): DocFigure[] {
  const sum = (...keys: string[]) => sheet.rows.reduce((n, r) => n + keys.reduce((m, k) => m + (isNum(r[k]) ? (r[k] as number) : 0), 0), 0);
  const sales = sum('sales'), delivery = sum('delivery'), net = sum('net');
  return [
    { label: pick(lang, W.fOrders), value: sheet.rows.filter((r) => r.__kind !== 'overhead').length, kind: 'int' },
    { label: pick(lang, W.fSales), value: sales, kind: 'money' },
    { label: pick(lang, W.fDelivery), value: delivery, kind: 'money' },
    { label: pick(lang, W.fCosts), value: sum('cogs', 'courier', 'wages', 'materials', 'promotion', 'other'), kind: 'money' },
    { label: pick(lang, W.fShares), value: sum('investor', 'discounts'), kind: 'money' },
    { label: pick(lang, W.fNet), value: net, kind: 'money', tone: 'key' },
    { label: pick(lang, W.fMargin), value: sales + delivery > 0 ? net / (sales + delivery) : null, kind: 'pct' },
  ];
}

/** The workbook: the orders first (as it always was), then the summary figures on their own sheet. */
export function ordersReportWorkbook(input: OrdersReportInput): XlsxSheet[] {
  const sheet = ordersReportSheet(input), { lang } = input;
  return [sheet, {
    name: pick(lang, W.summarySheet),
    rtl: lang !== 'en',
    heading: [pick(lang, W.title), fill(pick(lang, W.period), { from: input.from, to: input.to }), fill(pick(lang, W.made), { at: baghdadClock(input.at) })],
    columns: [
      { key: 'label', kind: 'text', header: pick(lang, W.item), width: 34 },
      { key: 'value', kind: 'money', header: pick(lang, W.value), width: 18, kindOf: (r) => (r.kind === 'pct' ? 'pct' : r.kind === 'int' ? 'int' : 'money') },
    ],
    rows: ordersReportFigures(sheet, lang).map((f) => ({ label: f.label, value: f.value, kind: f.kind })),
  }];
}

/**
 * The report as a stand-alone print document (financeDocument.ts: the header band, the summary figures, the grouped
 * table, the totals, page numbers; the one hashed script opens the print dialog, where «Save as PDF» is the PDF — Arabic
 * is shaped by the browser itself). A4 landscape, every value escaped.
 */
export function ordersReportHtml(input: OrdersReportInput): string {
  const sheet = ordersReportSheet(input), { lang } = input;
  return financeDocumentHtml({
    lang,
    title: pick(lang, W.title),
    meta: [fill(pick(lang, W.period), { from: input.from, to: input.to }), fill(pick(lang, W.made), { at: baghdadClock(input.at) })],
    figures: ordersReportFigures(sheet, lang),
    tables: [{ sheet }],
    notes: [pick(lang, W.note)],
    printHint: pick(lang, W.print),
  });
}

export const REPORT_LANGS: readonly ReportLang[] = ['ar', 'en', 'ckb'];
export const REPORT_WORDS = W;
export const REPORT_COLUMNS = COLUMNS;
