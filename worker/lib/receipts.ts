/**
 * Printable paper: the purchase receipt, the warranty receipt, and the
 * delivery label.
 *
 * WHY HTML AND NOT PDF. These come off a thermal roll or a label printer in a
 * shop in Baghdad, not out of an email attachment. A browser printing an HTML
 * page sized with `@page { size: 80mm auto }` produces exactly the same
 * output as a PDF would, on any device the owner already has, with no
 * rendering library in a Worker that has 128MB and no fonts. The page carries
 * its own print CSS and nothing else — no fetch, no script beyond the
 * optional auto-print, no external font that a shop's tablet might not load.
 *
 * WHAT "THERMAL PRINTER API" ACTUALLY MEANS IN A BROWSER. There isn't one. A
 * web page cannot open a USB or network printer and speak ESC/POS to it — the
 * only route is the browser's own print dialog, which is what `?print=1`
 * triggers here. For a shop with a NETWORKED receipt printer and a small
 * print server, `escposReceipt()` renders the same receipt as raw ESC/POS
 * bytes that server can forward. Both paths render from the same data, so
 * they cannot disagree about a price.
 *
 * EVERY FIGURE IS PASSED IN, NONE IS COMPUTED HERE. A receipt that
 * recalculates a total is a receipt that can disagree with the order. These
 * functions format; the caller reads the stored order.
 */

import { escapeHtml } from './emailTemplates';

export type ReceiptLang = 'ar' | 'en';

export interface ReceiptLine {
  name: string;
  variant: string;
  qty: number;
  unit_iqd: number;
  line_iqd: number;
}

export interface ReceiptMoneyRow {
  label_ar: string;
  label_en: string;
  amount_iqd: number;
  /** A discount prints with a minus and must not be mistaken for a charge. */
  negative?: boolean;
}

export interface PurchaseReceiptData {
  order_id: string;
  invoice_no: string | null;
  created_at: string;
  customer_name: string;
  phone: string;
  governorate: string;
  area: string;
  address: string;
  landmark: string;
  notes: string;
  lines: ReceiptLine[];
  /** Coupon, points, wallet, membership — whatever the order actually had. */
  adjustments: ReceiptMoneyRow[];
  subtotal_iqd: number;
  shipping_iqd: number;
  total_iqd: number;
  due_on_delivery_iqd: number;
  payment_method: string;
  shipping_type_label: string;
  support_code: string;
}

export interface WarrantyUnit {
  product_name: string;
  serial: string | null;
  unit_index: number;
  months: number;
  starts_at: string | null;
  ends_at: string | null;
}

export interface WarrantyReceiptData {
  order_id: string;
  invoice_no: string | null;
  created_at: string;
  customer_name: string;
  phone: string;
  units: WarrantyUnit[];
  terms: string;
}

export interface DeliveryLabelData {
  order_id: string;
  customer_name: string;
  phone: string;
  governorate: string;
  area: string;
  address: string;
  landmark: string;
  notes: string;
  /** What the driver collects. Zero on a prepaid order — printed either way. */
  cod_iqd: number;
  item_count: number;
  tracking_no: string;
  created_at: string;
}

const COPY = {
  ar: {
    receiptTitle: 'وصل شراء',
    warrantyTitle: 'وصل ضمان',
    order: 'رقم الطلب',
    invoice: 'رقم الفاتورة',
    date: 'التاريخ',
    customer: 'الزبون',
    phone: 'الهاتف',
    address: 'العنوان',
    landmark: 'أقرب نقطة دالة',
    notes: 'ملاحظات',
    item: 'المنتج',
    qty: 'الكمية',
    price: 'السعر',
    total: 'المجموع',
    subtotal: 'المجموع الفرعي',
    shipping: 'التوصيل',
    grandTotal: 'المبلغ النهائي',
    dueOnDelivery: 'المستحق عند الاستلام',
    payment: 'طريقة الدفع',
    shippingType: 'نوع الشحن',
    support: 'كود الدعم',
    thanks: 'شكرًا لتسوقك من LEVONIS',
    product: 'الجهاز',
    serial: 'الرقم التسلسلي',
    unit: 'القطعة',
    months: 'مدة الضمان (شهر)',
    from: 'يبدأ',
    to: 'ينتهي',
    noSerial: 'بلا رقم تسلسلي',
    terms: 'شروط الضمان',
    keepReceipt: 'احتفظ بهذا الوصل — الضمان لا يُعتمد بدونه',
    cod: 'المبلغ المطلوب',
    prepaid: 'مدفوع مسبقًا',
    pieces: 'عدد القطع',
    tracking: 'رقم التتبع',
  },
  en: {
    receiptTitle: 'Purchase receipt',
    warrantyTitle: 'Warranty receipt',
    order: 'Order',
    invoice: 'Invoice',
    date: 'Date',
    customer: 'Customer',
    phone: 'Phone',
    address: 'Address',
    landmark: 'Landmark',
    notes: 'Notes',
    item: 'Item',
    qty: 'Qty',
    price: 'Price',
    total: 'Total',
    subtotal: 'Subtotal',
    shipping: 'Delivery',
    grandTotal: 'Total due',
    dueOnDelivery: 'Due on delivery',
    payment: 'Payment',
    shippingType: 'Shipping',
    support: 'Support code',
    thanks: 'Thank you for shopping with LEVONIS',
    product: 'Device',
    serial: 'Serial',
    unit: 'Unit',
    months: 'Warranty (months)',
    from: 'Starts',
    to: 'Ends',
    noSerial: 'No serial recorded',
    terms: 'Warranty terms',
    keepReceipt: 'Keep this receipt — warranty is not honoured without it',
    cod: 'Collect',
    prepaid: 'Prepaid',
    pieces: 'Pieces',
    tracking: 'Tracking',
  },
} as const;

/** Grouping separators, always Latin digits: a thermal head has one font. */
export function iqd(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} IQD`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The shared page shell.
 *
 * `size` is a real @page rule, so the browser's print dialog opens on the
 * right paper instead of asking the shopkeeper to pick A4 and then scale it.
 * `autoPrint` fires the dialog on load, which is what a "print" button in the
 * admin panel opens the page for.
 */
function doc(opts: {
  title: string;
  lang: ReceiptLang;
  size: string;
  body: string;
  autoPrint: boolean;
  extraCss?: string;
}): string {
  const dir = opts.lang === 'ar' ? 'rtl' : 'ltr';
  return (
    `<!doctype html><html lang="${opts.lang}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex, nofollow">` +
    `<title>${escapeHtml(opts.title)}</title><style>` +
    `@page { size: ${opts.size}; margin: 0; }` +
    `* { box-sizing: border-box; }` +
    `body { margin: 0; background: #fff; color: #000; font-family: "Segoe UI", Tahoma, Arial, sans-serif; }` +
    // A thermal head prints black on white and nothing else. Forcing the
    // colours stops a browser's "print backgrounds off" default from turning
    // a grey rule into nothing at all.
    `.rule { border-top: 1px dashed #000; margin: 6px 0; }` +
    `.row { display: flex; justify-content: space-between; gap: 8px; }` +
    `.b { font-weight: 700; }` +
    `.ltr { direction: ltr; unicode-bidi: embed; }` +
    `table { width: 100%; border-collapse: collapse; }` +
    `td, th { padding: 2px 0; vertical-align: top; }` +
    `@media print { .noprint { display: none !important; } }` +
    (opts.extraCss ?? '') +
    `</style></head><body>${opts.body}` +
    (opts.autoPrint
      ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},250)})</script>`
      : '') +
    `</body></html>'`.replace(/'$/, '')
  );
}

function kv(label: string, value: string): string {
  if (!value) return '';
  return `<div class="row"><span>${escapeHtml(label)}</span><span class="b ltr">${escapeHtml(value)}</span></div>`;
}

// ------------------------------------------------------------ وصل الشراء

export function renderPurchaseReceipt(
  data: PurchaseReceiptData,
  lang: ReceiptLang = 'ar',
  autoPrint = false,
  widthMm = 80
): string {
  const t = COPY[lang];
  const lines = data.lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.name)}${
          l.variant ? `<br><span style="font-size:10px">${escapeHtml(l.variant)}</span>` : ''
        }</td>` +
        `<td style="text-align:center" class="ltr">${l.qty}</td>` +
        `<td style="text-align:end" class="ltr">${escapeHtml(iqd(l.line_iqd))}</td></tr>`
    )
    .join('');

  const adjustments = data.adjustments
    .filter((a) => a.amount_iqd !== 0)
    .map(
      (a) =>
        `<div class="row"><span>${escapeHtml(lang === 'ar' ? a.label_ar : a.label_en)}</span>` +
        `<span class="ltr">${a.negative ? '-' : ''}${escapeHtml(iqd(Math.abs(a.amount_iqd)))}</span></div>`
    )
    .join('');

  const body =
    `<div style="width:${widthMm}mm;padding:6mm 4mm;font-size:12px;line-height:1.45">` +
    `<div style="text-align:center">` +
    `<div style="font-size:20px;font-weight:800;letter-spacing:3px">LEVONIS</div>` +
    `<div style="font-size:13px;font-weight:700;margin-top:2px">${escapeHtml(t.receiptTitle)}</div>` +
    `</div><div class="rule"></div>` +
    kv(t.order, data.order_id) +
    kv(t.invoice, data.invoice_no ?? '') +
    kv(t.date, shortDate(data.created_at)) +
    kv(t.shippingType, data.shipping_type_label) +
    `<div class="rule"></div>` +
    kv(t.customer, data.customer_name) +
    kv(t.phone, data.phone) +
    kv(t.address, [data.governorate, data.area, data.address].filter(Boolean).join(' — ')) +
    kv(t.landmark, data.landmark) +
    kv(t.notes, data.notes) +
    `<div class="rule"></div>` +
    `<table><thead><tr><th style="text-align:start">${escapeHtml(t.item)}</th>` +
    `<th style="text-align:center">${escapeHtml(t.qty)}</th>` +
    `<th style="text-align:end">${escapeHtml(t.total)}</th></tr></thead><tbody>${lines}</tbody></table>` +
    `<div class="rule"></div>` +
    `<div class="row"><span>${escapeHtml(t.subtotal)}</span><span class="ltr">${escapeHtml(iqd(data.subtotal_iqd))}</span></div>` +
    `<div class="row"><span>${escapeHtml(t.shipping)}</span><span class="ltr">${escapeHtml(iqd(data.shipping_iqd))}</span></div>` +
    adjustments +
    `<div class="rule"></div>` +
    // THE number the shopkeeper writes on the paper: after every discount,
    // in the largest type on the receipt, so it cannot be confused with the
    // subtotal above it.
    `<div class="row" style="font-size:17px;font-weight:800"><span>${escapeHtml(t.grandTotal)}</span>` +
    `<span class="ltr">${escapeHtml(iqd(data.total_iqd))}</span></div>` +
    (data.due_on_delivery_iqd > 0
      ? `<div class="row" style="font-size:13px;font-weight:700;margin-top:3px"><span>${escapeHtml(t.dueOnDelivery)}</span>` +
        `<span class="ltr">${escapeHtml(iqd(data.due_on_delivery_iqd))}</span></div>`
      : '') +
    `<div class="rule"></div>` +
    kv(t.payment, data.payment_method) +
    kv(t.support, data.support_code) +
    `<div style="text-align:center;margin-top:8px;font-size:11px">${escapeHtml(t.thanks)}</div>` +
    `</div>`;

  return doc({
    title: `${t.receiptTitle} ${data.order_id}`,
    lang,
    size: `${widthMm}mm auto`,
    body,
    autoPrint,
  });
}

// ------------------------------------------------------------ وصل الضمان

/**
 * The warranty slip that goes in the box with a printer or an accessory.
 *
 * NEVER RENDERED FOR AN ORDER WITH NO WARRANTED UNITS. A blank warranty
 * receipt in a customer's hand is a promise nobody made — the route refuses
 * rather than printing an empty form, and this function's caller checks
 * `units.length` first.
 *
 * A unit with no serial recorded prints "بلا رقم تسلسلي" rather than a blank
 * line: an empty box invites someone to write a number in by hand, and a
 * hand-written serial on a warranty slip is worth nothing at claim time.
 */
export function renderWarrantyReceipt(
  data: WarrantyReceiptData,
  lang: ReceiptLang = 'ar',
  autoPrint = false,
  widthMm = 80
): string {
  const t = COPY[lang];
  const units = data.units
    .map(
      (u) =>
        `<div style="border:1px solid #000;border-radius:3px;padding:4px 6px;margin:5px 0">` +
        `<div class="b">${escapeHtml(u.product_name)}</div>` +
        kv(t.unit, String(u.unit_index + 1)) +
        `<div class="row"><span>${escapeHtml(t.serial)}</span>` +
        `<span class="b ltr">${escapeHtml(u.serial || t.noSerial)}</span></div>` +
        kv(t.months, String(u.months)) +
        kv(t.from, u.starts_at ? shortDate(u.starts_at) : '') +
        kv(t.to, u.ends_at ? shortDate(u.ends_at) : '') +
        `</div>`
    )
    .join('');

  const body =
    `<div style="width:${widthMm}mm;padding:6mm 4mm;font-size:12px;line-height:1.45">` +
    `<div style="text-align:center">` +
    `<div style="font-size:20px;font-weight:800;letter-spacing:3px">LEVONIS</div>` +
    `<div style="font-size:13px;font-weight:700;margin-top:2px">${escapeHtml(t.warrantyTitle)}</div>` +
    `</div><div class="rule"></div>` +
    kv(t.order, data.order_id) +
    kv(t.invoice, data.invoice_no ?? '') +
    kv(t.date, shortDate(data.created_at)) +
    kv(t.customer, data.customer_name) +
    kv(t.phone, data.phone) +
    `<div class="rule"></div>` +
    units +
    (data.terms
      ? `<div class="rule"></div><div class="b">${escapeHtml(t.terms)}</div>` +
        `<div style="font-size:10.5px;line-height:1.5">${escapeHtml(data.terms)}</div>`
      : '') +
    `<div class="rule"></div>` +
    `<div style="text-align:center;font-size:11px;font-weight:700">${escapeHtml(t.keepReceipt)}</div>` +
    `</div>`;

  return doc({
    title: `${t.warrantyTitle} ${data.order_id}`,
    lang,
    size: `${widthMm}mm auto`,
    body,
    autoPrint,
  });
}

// -------------------------------------------------------- ستيكر التوصيل

/** One sticker's inner markup, reused by the single label and the batch. */
function labelBody(d: DeliveryLabelData, lang: ReceiptLang): string {
  const t = COPY[lang];
  return (
    `<div class="label">` +
    `<div class="row" style="align-items:center">` +
    `<span style="font-size:15px;font-weight:800;letter-spacing:2px">LEVONIS</span>` +
    `<span class="ltr" style="font-size:11px;font-weight:700">${escapeHtml(d.order_id)}</span>` +
    `</div><div class="rule"></div>` +
    `<div style="font-size:15px;font-weight:800">${escapeHtml(d.customer_name)}</div>` +
    // The phone is the single most-used field on a delivery sticker: the
    // driver reads it from a moving motorbike. Biggest type on the label.
    `<div class="ltr" style="font-size:19px;font-weight:800;letter-spacing:1px">${escapeHtml(d.phone)}</div>` +
    `<div style="font-size:12px;margin-top:2px">${escapeHtml(
      [d.governorate, d.area].filter(Boolean).join(' — ')
    )}</div>` +
    `<div style="font-size:11.5px">${escapeHtml(d.address)}</div>` +
    (d.landmark ? `<div style="font-size:11px">${escapeHtml(t.landmark)}: ${escapeHtml(d.landmark)}</div>` : '') +
    (d.notes ? `<div style="font-size:10.5px">${escapeHtml(t.notes)}: ${escapeHtml(d.notes)}</div>` : '') +
    `<div class="rule"></div>` +
    `<div class="row" style="align-items:baseline">` +
    `<span style="font-size:11px">${escapeHtml(t.pieces)}: <span class="ltr">${d.item_count}</span></span>` +
    `<span style="font-size:16px;font-weight:800">${
      d.cod_iqd > 0 ? `${escapeHtml(t.cod)}: <span class="ltr">${escapeHtml(iqd(d.cod_iqd))}</span>` : escapeHtml(t.prepaid)
    }</span>` +
    `</div>` +
    (d.tracking_no
      ? `<div class="ltr" style="font-size:11px">${escapeHtml(t.tracking)}: ${escapeHtml(d.tracking_no)}</div>`
      : '') +
    `</div>`
  );
}

const LABEL_CSS =
  `.label { width: 100mm; height: 70mm; padding: 4mm; overflow: hidden; page-break-after: always; }` +
  `.label:last-child { page-break-after: auto; }`;

export function renderDeliveryLabel(
  d: DeliveryLabelData,
  lang: ReceiptLang = 'ar',
  autoPrint = false
): string {
  return doc({
    title: `Label ${d.order_id}`,
    lang,
    size: '100mm 70mm',
    body: labelBody(d, lang),
    autoPrint,
    extraCss: LABEL_CSS,
  });
}

/**
 * A batch of stickers, one per page.
 *
 * The owner asked for this over NEW orders only — the ones not yet sent out —
 * which is a filter the CALLER applies, not this function. A renderer that
 * decided for itself which orders count as new would quietly disagree with
 * the panel's own list the first time the definition changed.
 */
export function renderLabelSheet(
  labels: DeliveryLabelData[],
  lang: ReceiptLang = 'ar',
  autoPrint = false
): string {
  const t = COPY[lang];
  const body = labels.length
    ? labels.map((d) => labelBody(d, lang)).join('')
    : `<div style="padding:12mm;font-size:13px;text-align:center">${escapeHtml(
        lang === 'ar' ? 'لا توجد طلبات جديدة للطباعة' : 'No new orders to print'
      )}</div>`;
  return doc({
    title: `${t.pieces}: ${labels.length}`,
    lang,
    size: '100mm 70mm',
    body,
    autoPrint: autoPrint && labels.length > 0,
    extraCss: LABEL_CSS,
  });
}

// ------------------------------------------------------------- ESC/POS

/**
 * The same receipt as raw ESC/POS, for a shop with a networked printer and a
 * small print server to forward it to.
 *
 * A browser cannot do this itself — there is no web API that opens a USB or
 * network printer and speaks ESC/POS — so this is offered as a body an
 * owner's own print server can POST. It renders from the SAME data as the
 * HTML above, so the paper and the screen cannot disagree about a price.
 *
 * `charsPerLine` is the printer's column count: 32 for a 58mm roll, 48 for
 * an 80mm one. Arabic support on ESC/POS depends entirely on the printer's
 * code page, so this emits the numbers and the Latin text and leaves the
 * Arabic to the HTML path, which any printer renders as an image.
 */
export function escposReceipt(data: PurchaseReceiptData, charsPerLine = 48): string {
  const ESC = '\x1b';
  const GS = '\x1d';
  const center = `${ESC}a\x01`;
  const left = `${ESC}a\x00`;
  const boldOn = `${ESC}E\x01`;
  const boldOff = `${ESC}E\x00`;
  const bigOn = `${GS}!\x11`;
  const bigOff = `${GS}!\x00`;
  const cut = `${GS}V\x42\x00`;
  const rule = '-'.repeat(charsPerLine);

  const pair = (label: string, value: string) => {
    const room = Math.max(1, charsPerLine - label.length - value.length);
    return `${label}${' '.repeat(room)}${value}\n`;
  };

  let out = `${ESC}@`; // initialise
  out += `${center}${boldOn}${bigOn}LEVONIS\n${bigOff}${boldOff}Purchase receipt\n${left}`;
  out += `${rule}\n`;
  out += pair('Order', data.order_id);
  if (data.invoice_no) out += pair('Invoice', data.invoice_no);
  out += pair('Date', shortDate(data.created_at));
  out += pair('Phone', data.phone);
  out += `${rule}\n`;
  for (const l of data.lines) {
    out += `${l.name.slice(0, charsPerLine)}\n`;
    out += pair(`  x${l.qty}`, iqd(l.line_iqd));
  }
  out += `${rule}\n`;
  out += pair('Subtotal', iqd(data.subtotal_iqd));
  out += pair('Delivery', iqd(data.shipping_iqd));
  for (const a of data.adjustments) {
    if (a.amount_iqd === 0) continue;
    out += pair(a.label_en, `${a.negative ? '-' : ''}${iqd(Math.abs(a.amount_iqd))}`);
  }
  out += `${rule}\n`;
  out += `${boldOn}${bigOn}`;
  out += pair('TOTAL', iqd(data.total_iqd));
  out += `${bigOff}${boldOff}`;
  if (data.due_on_delivery_iqd > 0) out += pair('Due on delivery', iqd(data.due_on_delivery_iqd));
  out += `${rule}\n`;
  out += `${center}Thank you\n\n\n${cut}`;
  return out;
}
