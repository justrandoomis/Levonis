/**
 * The printed warranty receipt: an A4 business document, one per device.
 *
 * WHY HTML AND NOT A GENERATED PDF FILE. The document is bilingual, and the
 * Arabic half needs real text shaping — letters join, and their forms depend
 * on their neighbours. A PDF writer running inside a Worker has no shaping
 * engine and no Arabic font to embed, so it would emit disconnected glyphs or
 * boxes: a worse document, not a more "real" one. A browser already has both.
 * This page is therefore print-first — `@page { size: A4 }`, real margins,
 * white paper, black text — and the browser's own "Save as PDF" produces a
 * genuine, selectable, vector PDF from it. Nothing here is an image of a
 * document; every value is text.
 *
 * PRINTS IN GREYSCALE. Every distinction is a border, a weight or a rule.
 * Colour only ever adds emphasis to something that already reads without it,
 * because most of these come off a mono laser printer in a shop.
 *
 * THE PAGE COMPUTES NOTHING. It is handed the snapshot stored on the receipt
 * and formats it. A document that recalculated a warranty end date could
 * disagree with the record it was issued from.
 */

import { escapeHtml } from './emailTemplates';
import { qrEncode, qrToSvgPath, QR_MAX_BYTES } from './qr';

export type DocLang = 'ar' | 'en';

export interface WarrantyDocTerm {
  ar: string;
  en: string;
}

export interface WarrantyDocData {
  receipt_no: string;
  issued_date: string | null;
  status: 'draft' | 'active' | 'expired' | 'void' | 'replaced';
  customer: { name: string; address: string; phone: string; email: string };
  product: {
    description: string;
    model: string;
    serial: string;
    price_iqd: number | null;
    purchase_date: string | null;
    order_receipt_no: string;
  };
  warranty: {
    months: number;
    type: string;
    coverage: string;
    start_at: string | null;
    end_at: string | null;
  };
  terms: WarrantyDocTerm[];
  retailer: {
    name: string;
    address_ar: string;
    address_en: string;
    phone: string;
    website: string;
    instagram: string;
  };
  /** Printed under the number so a holder can check the document is real. */
  verify_url: string;
  /** Shown when the document supersedes or is superseded by another. */
  chain: { replaces: string | null; replaced_by: string | null };
}

const COPY = {
  ar: {
    title: 'وصل ضمان',
    other: 'Warranty Receipt',
    copy: 'نسخة الزبون',
    copyOther: 'Customer Copy',
    receiptNo: 'رقم وصل الضمان',
    date: 'التاريخ',
    customer: 'معلومات الزبون',
    name: 'الاسم',
    address: 'العنوان',
    phone: 'الهاتف',
    email: 'البريد الإلكتروني',
    product: 'تفاصيل المنتج',
    description: 'الوصف',
    model: 'الموديل',
    serial: 'الرقم التسلسلي',
    price: 'سعر الشراء',
    purchaseDate: 'تاريخ الشراء',
    orderReceipt: 'رقم وصل الشراء',
    warranty: 'معلومات الضمان',
    period: 'المدة',
    type: 'النوع',
    coverage: 'التغطية',
    start: 'بداية الضمان',
    end: 'نهاية الضمان',
    terms: 'الشروط والأحكام',
    retailer: 'معلومات البائع المعتمد',
    website: 'الموقع',
    instagram: 'إنستغرام',
    signature: 'توقيع الزبون',
    signatureLine: 'الاسم / التاريخ / التوقيع',
    months: (n: number) => (n === 12 ? 'سنة واحدة' : n === 24 ? 'سنتان' : `${n} شهرًا`),
    verify: 'للتحقق من هذا الوصل',
    statusDraft: 'مسودة — غير مُصدَر بعد',
    statusExpired: 'انتهت مدة الضمان',
    statusVoid: 'وصل ملغى',
    statusReplaced: 'استُبدل الجهاز — راجع الوصل البديل',
    replaces: 'يحل محل الوصل',
    replacedBy: 'استُبدل بالوصل',
    iqd: 'د.ع',
  },
  en: {
    title: 'Warranty Receipt',
    other: 'وصل ضمان',
    copy: 'Customer Copy',
    copyOther: 'نسخة الزبون',
    receiptNo: 'Warranty Receipt No.',
    date: 'Date',
    customer: 'Customer Information',
    name: 'Name',
    address: 'Address',
    phone: 'Phone',
    email: 'Email',
    product: 'Product Detail',
    description: 'Description',
    model: 'Model',
    serial: 'Serial Number',
    price: 'Purchase Price',
    purchaseDate: 'Date of Purchase',
    orderReceipt: 'Receipt No.',
    warranty: 'Warranty Information',
    period: 'Period',
    type: 'Type',
    coverage: 'Coverage',
    start: 'Warranty Start',
    end: 'Warranty End',
    terms: 'Terms and Conditions',
    retailer: 'Authorized Retailer Information',
    website: 'Website',
    instagram: 'Instagram',
    signature: 'Customer Signature',
    signatureLine: 'Name / Date / Signature',
    months: (n: number) => (n === 12 ? '1 year' : n === 24 ? '2 years' : `${n} months`),
    verify: 'Verify this receipt at',
    statusDraft: 'DRAFT — not issued yet',
    statusExpired: 'Warranty period has ended',
    statusVoid: 'VOID receipt',
    statusReplaced: 'Device replaced — see the replacement receipt',
    iqd: 'IQD',
    replaces: 'Replaces receipt',
    replacedBy: 'Replaced by receipt',
  },
} as const;

/** `2 September 2026` in English, `2026-09-02` in Arabic (Latin digits both). */
function longDate(iso: string | null, lang: DocLang): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (lang === 'en') {
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  const months = [
    'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
    'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const money = (n: number | null, unit: string): string =>
  n === null || n === undefined ? '—' : `${new Intl.NumberFormat('en-US').format(n)} ${unit}`;

/**
 * The verification address as a QR square, drawn as one SVG path so it
 * survives printing at any size and needs no image, no font and no network.
 * A URL longer than the encoder's ten versions prints without it rather than
 * throwing on a document someone is waiting to hand over.
 */
function qrSvg(url: string, sizeMm: number): string {
  try {
    if (new TextEncoder().encode(url).length > QR_MAX_BYTES) return '';
    const m = qrEncode(url);
    const quiet = 2;
    const side = m.size + quiet * 2;
    return (
      `<svg class="qr" viewBox="0 0 ${side} ${side}" width="${sizeMm}mm" height="${sizeMm}mm" ` +
      `role="img" aria-label="QR" shape-rendering="crispEdges">` +
      `<rect width="${side}" height="${side}" fill="#fff"/>` +
      `<path d="${qrToSvgPath(m, quiet)}" fill="#000"/></svg>`
    );
  } catch {
    return '';
  }
}

/**
 * A label/value line. The VALUE of a serial, a phone or a price is Latin even
 * on an Arabic page, so those carry their own direction: an Arabic paragraph
 * would otherwise move a leading digit to the wrong end of the number.
 */
function row(label: string, value: string, opts: { ltr?: boolean; strong?: boolean } = {}): string {
  const v = value && value !== '—' ? escapeHtml(value) : '—';
  return (
    `<div class="row">` +
    `<div class="lbl">${escapeHtml(label)}</div>` +
    `<div class="val${opts.strong ? ' strong' : ''}"${opts.ltr ? ' dir="ltr"' : ''}>${v}</div>` +
    `</div>`
  );
}

function section(title: string, inner: string): string {
  return `<section class="sec"><h2>${escapeHtml(title)}</h2>${inner}</section>`;
}

type Copy = (typeof COPY)['ar'] | (typeof COPY)['en'];

/** A banner for anything that is not a live, in-date receipt. */
function statusBanner(data: WarrantyDocData, t: Copy): string {
  const text =
    data.status === 'draft'
      ? t.statusDraft
      : data.status === 'expired'
        ? t.statusExpired
        : data.status === 'void'
          ? t.statusVoid
          : data.status === 'replaced'
            ? t.statusReplaced
            : '';
  if (!text) return '';
  const tone = data.status === 'expired' ? 'warn' : data.status === 'draft' ? 'draft' : 'bad';
  return `<div class="banner ${tone}">${escapeHtml(text)}</div>`;
}

const CSS = `
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111; }
  body {
    font-family: 'Cairo', 'Segoe UI', 'Tahoma', 'Arial', system-ui, sans-serif;
    font-size: 11pt; line-height: 1.5;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { width: 186mm; margin: 0 auto; }
  /* Header: the one filled block on the page. It keeps its ink in greyscale
     because the text on it is white and the fill is dark enough to stay dark
     when a mono printer converts it. */
  .head { background: #12233f; color: #fff; text-align: center; padding: 7mm 6mm 6mm; }
  .head h1 { margin: 0; font-size: 26pt; font-weight: 800; letter-spacing: .5px; }
  .head .sub { font-size: 12pt; opacity: .92; margin-top: 1mm; }
  .copybar {
    background: #e8eef7; border: 1px solid #12233f; border-top: 0;
    padding: 2.5mm 5mm; font-weight: 700; font-size: 11.5pt; color: #12233f;
    display: flex; justify-content: space-between; gap: 6mm;
  }
  .copybar .en { font-weight: 600; opacity: .75; }
  .body { border: 1px solid #12233f; border-top: 0; padding: 5mm; }
  .grid { display: grid; grid-template-columns: 1.55fr 1fr; gap: 6mm; align-items: start; }
  .col { min-width: 0; }
  .sec { margin-bottom: 4.5mm; break-inside: avoid; }
  .sec h2 {
    margin: 0 0 1.5mm; font-size: 12pt; font-weight: 800; color: #12233f;
    border-bottom: 1.5px solid #12233f; padding-bottom: 1mm;
  }
  .row { display: flex; gap: 3mm; padding: 1.1mm 0; border-bottom: 1px dotted #b9c2cf; }
  .row:last-child { border-bottom: 0; }
  .lbl { flex: 0 0 34%; font-weight: 700; font-size: 10pt; color: #26313f; }
  .val { flex: 1 1 auto; min-width: 0; font-size: 10.5pt; word-break: break-word; }
  .val.strong { font-weight: 700; }
  .norow { display: flex; gap: 3mm; align-items: stretch; }
  .no {
    flex: 1 1 auto; border: 1.5px dashed #12233f; padding: 2.5mm 4mm; text-align: center;
    font-size: 15pt; font-weight: 800; letter-spacing: 1px; color: #12233f;
    display: flex; flex-direction: column; justify-content: center;
  }
  .qrbox { flex: 0 0 auto; border: 1px solid #12233f; padding: 1mm; display: flex; align-items: center; }
  .qr { display: block; }
  .no small { display: block; font-size: 8.5pt; letter-spacing: 0; font-weight: 600; color: #26313f; margin-top: 1mm; }
  .terms { border: 1px solid #12233f; padding: 3mm 4mm; }
  .terms ul { margin: 0; padding-inline-start: 5mm; }
  .terms li { font-size: 9.5pt; line-height: 1.55; margin-bottom: 1.6mm; }
  .coverage { font-size: 10pt; line-height: 1.55; }
  .sign { margin-top: 5mm; break-inside: avoid; }
  .sign-title {
    margin: 0 0 1.5mm; font-size: 12pt; font-weight: 800; color: #12233f;
    border-bottom: 1.5px solid #12233f; padding-bottom: 1mm;
  }
  .sign .box { border: 1px solid #12233f; height: 22mm; }
  .sign .cap { text-align: center; font-size: 9.5pt; color: #26313f; margin-top: 1.5mm; }
  .foot { margin-top: 4mm; font-size: 9pt; color: #26313f; display: flex; justify-content: space-between; gap: 4mm; }
  .banner {
    border: 1.5px solid #111; padding: 2mm 4mm; margin-bottom: 4mm;
    font-weight: 800; font-size: 11pt; text-align: center;
  }
  .banner.bad { background: #f6e3e1; border-color: #7d2b22; color: #7d2b22; }
  .banner.warn { background: #f7efdc; border-color: #7a5c15; color: #7a5c15; }
  .banner.draft { background: #eceff3; border-color: #445; color: #333; }
  .chain { font-size: 9pt; color: #26313f; margin-top: 2mm; }
  @media print { .noprint { display: none !important; } }
  .noprint { text-align: center; margin: 6mm auto 0; }
  .noprint button {
    font: inherit; font-weight: 700; padding: 3mm 7mm; margin: 0 2mm;
    border: 1px solid #12233f; background: #12233f; color: #fff; border-radius: 3mm; cursor: pointer;
  }
  .noprint .hint { display: block; margin-top: 2mm; font-size: 9.5pt; color: #444; }
`;

/**
 * The whole document. `autoPrint` opens the browser's print dialog on load —
 * the same route the purchase receipt and the delivery label already take,
 * and the only way a web page can reach a printer or the PDF writer.
 */
export function renderWarrantyDoc(data: WarrantyDocData, lang: DocLang = 'ar', autoPrint = false): string {
  const t = COPY[lang];
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const retailerAddress = lang === 'ar' ? data.retailer.address_ar : data.retailer.address_en;

  const qr = qrSvg(data.verify_url, 22);
  const receiptNoBlock =
    `<div class="norow">` +
    `<div class="no" dir="ltr">${escapeHtml(data.receipt_no)}` +
    `<small>${escapeHtml(t.verify)}: ${escapeHtml(data.verify_url)}</small></div>` +
    (qr ? `<div class="qrbox">${qr}</div>` : '') +
    `</div>`;

  const customer =
    row(t.name, data.customer.name, { strong: true }) +
    row(t.address, data.customer.address) +
    row(t.phone, data.customer.phone, { ltr: true }) +
    (data.customer.email ? row(t.email, data.customer.email, { ltr: true }) : '');

  const product =
    row(t.description, data.product.description, { strong: true }) +
    row(t.model, data.product.model, { ltr: true }) +
    row(t.serial, data.product.serial, { ltr: true, strong: true }) +
    row(t.price, money(data.product.price_iqd, t.iqd), { ltr: true }) +
    row(t.purchaseDate, longDate(data.product.purchase_date, lang)) +
    row(t.orderReceipt, data.product.order_receipt_no, { ltr: true });

  const warranty =
    row(t.period, t.months(data.warranty.months)) +
    row(t.type, data.warranty.type) +
    `<div class="row"><div class="lbl">${escapeHtml(t.coverage)}</div>` +
    `<div class="val coverage">${escapeHtml(data.warranty.coverage)}</div></div>` +
    row(t.start, longDate(data.warranty.start_at, lang), { strong: true }) +
    row(t.end, longDate(data.warranty.end_at, lang), { strong: true });

  const terms =
    `<div class="terms"><ul>` +
    data.terms.map((x) => `<li>${escapeHtml(lang === 'ar' ? x.ar || x.en : x.en || x.ar)}</li>`).join('') +
    `</ul></div>`;

  const retailer =
    row(t.name, data.retailer.name, { strong: true }) +
    row(t.address, retailerAddress) +
    row(t.phone, data.retailer.phone, { ltr: true }) +
    row(t.website, data.retailer.website, { ltr: true }) +
    row(t.instagram, data.retailer.instagram, { ltr: true });

  const chain =
    (data.chain.replaces ? `<div class="chain">${escapeHtml(t.replaces)}: <span dir="ltr">${escapeHtml(data.chain.replaces)}</span></div>` : '') +
    (data.chain.replaced_by ? `<div class="chain">${escapeHtml(t.replacedBy)}: <span dir="ltr">${escapeHtml(data.chain.replaced_by)}</span></div>` : '');

  const printBar =
    `<div class="noprint">` +
    `<button type="button" onclick="window.print()">${lang === 'ar' ? 'طباعة / حفظ PDF' : 'Print / Save as PDF'}</button>` +
    `<span class="hint">${
      lang === 'ar'
        ? 'اختر «حفظ بصيغة PDF» في نافذة الطباعة للحصول على ملف PDF حقيقي بنص قابل للتحديد.'
        : 'Choose “Save as PDF” in the print dialog for a real, text-selectable PDF file.'
    }</span></div>`;

  return (
    `<!doctype html><html lang="${lang}" dir="${dir}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(`${t.title} ${data.receipt_no}`)}</title>` +
    `<style>${CSS}</style></head><body>` +
    `<div class="sheet">` +
    `<div class="head"><h1>${escapeHtml(t.title)}</h1><div class="sub">${escapeHtml(t.other)}</div></div>` +
    `<div class="copybar"><span>${escapeHtml(t.copy)}</span><span class="en">${escapeHtml(t.copyOther)}</span></div>` +
    `<div class="body">` +
    statusBanner(data, t) +
    `<div class="grid">` +
    `<div class="col">` +
    section(t.receiptNo, receiptNoBlock + row(t.date, longDate(data.issued_date, lang))) +
    section(t.customer, customer) +
    section(t.product, product) +
    section(t.warranty, warranty) +
    `</div>` +
    `<div class="col">` +
    section(t.terms, terms) +
    section(t.retailer, retailer + chain) +
    `</div>` +
    `</div>` +
    `<div class="sign"><h2 class="sign-title">${escapeHtml(t.signature)}</h2>` +
    `<div class="box"></div><div class="cap">${escapeHtml(t.signatureLine)}</div></div>` +
    `<div class="foot"><span dir="ltr">${escapeHtml(data.receipt_no)}</span>` +
    `<span dir="ltr">${escapeHtml(data.retailer.website)}</span></div>` +
    `</div></div>` +
    printBar +
    (autoPrint ? `<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},250)})</script>` : '') +
    `</body></html>`
  );
}
