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
import { PRINT_FONT_LINK } from './printDocument';

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
    /**
     * A PURCHASED extension, when the device record carries one: the base the
     * customer got with the printer and the months they bought on top. Both
     * optional — receipts issued before the extended-warranty round, and
     * devices with no extension, print no extension row at all.
     */
    base_months?: number | null;
    ext_months?: number;
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
    extension: 'الضمان الممدد',
    extendedBy: (base: number, ext: number) => `تمديد مدفوع +${ext} شهرًا فوق الضمان الأساسي (${base} شهرًا)`,
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
    extension: 'Extended warranty',
    extendedBy: (base: number, ext: number) => `Extended by ${ext} months on top of the ${base}-month base warranty`,
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

/**
 * The amount, with the number isolated instead of the row forced to LTR.
 * `dir="ltr"` on the whole cell printed the Iraqi dinar abbreviation «د.ع»
 * reversed as «ع.د» — the bidi algorithm lays a trailing Arabic run out
 * right-to-left inside a left-to-right line. U+2066/U+2069 pin the digits
 * left-to-right and leave the unit to the document's own direction, which is
 * the only arrangement that reads correctly in both languages.
 */
const money = (n: number | null, unit: string): string =>
  n === null || n === undefined ? '—' : `\u2066${new Intl.NumberFormat('en-US').format(n)}\u2069 ${unit}`;

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
    /* PINNED, because the font is now actually loaded. Cairo sets a taller
       line box than the Tahoma this document has been falling back to, and
       this page is budgeted to ONE A4 sheet — an unpinned line-height would
       let the swap push it onto a second. */
    font-size: 9.5pt; line-height: 1.4;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  /* ONE SHEET. 186mm is A4 minus the 12mm margins, and everything below is
     sized so the whole document lands inside the 273mm of usable height that
     leaves. A customer's copy that prints its signature box on a second page
     is not the document the owner asked for, so the type scale, the padding
     and the column split are all tuned against a measured render rather than
     left to whatever the content happens to need. */
  .sheet { width: 186mm; margin: 0 auto; }
  /* Header: the one filled block on the page. It keeps its ink in greyscale
     because the text on it is white and the fill is dark enough to stay dark
     when a mono printer converts it. */
  .head { background: #12233f; color: #fff; text-align: center; padding: 4.5mm 6mm 4mm; }
  .head h1 { margin: 0; font-size: 19pt; font-weight: 800; letter-spacing: .5px; }
  .head .sub { font-size: 9.5pt; opacity: .92; margin-top: .8mm; }
  .copybar {
    background: #e8eef7; border: 1px solid #12233f; border-top: 0;
    padding: 1.6mm 5mm; font-weight: 700; font-size: 9.5pt; color: #12233f;
    display: flex; justify-content: space-between; gap: 6mm;
  }
  .copybar .en { font-weight: 600; opacity: .75; }
  .body { border: 1px solid #12233f; border-top: 0; padding: 4mm; }
  .grid { display: grid; grid-template-columns: 1.12fr 1fr; gap: 5mm; align-items: start; }
  .col { min-width: 0; }
  .sec { margin-bottom: 3mm; break-inside: avoid; }
  .sec h2 {
    margin: 0 0 1.2mm; font-size: 10pt; font-weight: 800; color: #12233f;
    border-bottom: 1.2px solid #12233f; padding-bottom: .8mm;
  }
  .row { display: flex; gap: 2.5mm; padding: .7mm 0; border-bottom: 1px dotted #b9c2cf; }
  .row:last-child { border-bottom: 0; }
  .lbl { flex: 0 0 36%; font-weight: 700; font-size: 8.5pt; color: #26313f; }
  .val { flex: 1 1 auto; min-width: 0; font-size: 9pt; word-break: break-word; }
  .val.strong { font-weight: 700; }
  .norow { display: flex; gap: 3mm; align-items: stretch; }
  .no {
    flex: 1 1 auto; border: 1.5px dashed #12233f; padding: 2mm 3mm; text-align: center;
    font-size: 12.5pt; font-weight: 800; letter-spacing: 1px; color: #12233f;
    display: flex; flex-direction: column; justify-content: center;
  }
  .qrbox { flex: 0 0 auto; border: 1px solid #12233f; padding: 1mm; display: flex; align-items: center; }
  .qr { display: block; }
  .no small { display: block; font-size: 7.5pt; letter-spacing: 0; font-weight: 600; color: #26313f; margin-top: .8mm; }
  .terms { border: 1px solid #12233f; padding: 2.2mm 3mm; }
  .terms ul { margin: 0; padding-inline-start: 4.5mm; }
  .terms li { font-size: 8pt; line-height: 1.4; margin-bottom: 1mm; }
  .coverage { font-size: 8pt; line-height: 1.4; }
  .sign { margin-top: 3.5mm; break-inside: avoid; }
  .sign-title {
    margin: 0 0 1.2mm; font-size: 10pt; font-weight: 800; color: #12233f;
    border-bottom: 1.2px solid #12233f; padding-bottom: .8mm;
  }
  .sign .box { border: 1px solid #12233f; height: 15mm; }
  .sign .cap { text-align: center; font-size: 8pt; color: #26313f; margin-top: 1.2mm; }
  .foot { margin-top: 3mm; font-size: 8pt; color: #26313f; display: flex; justify-content: space-between; gap: 4mm; }
  .banner {
    border: 1.5px solid #111; padding: 1.5mm 4mm; margin-bottom: 3mm;
    font-weight: 800; font-size: 9.5pt; text-align: center;
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
  .noprint a {
    display: inline-block; margin-inline-start: 3mm; padding: 2mm 4mm;
    border: 1px solid #12233f; border-radius: 2mm; color: #12233f;
    font-weight: 700; text-decoration: none; font-size: 11pt;
  }
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
    row(t.price, money(data.product.price_iqd, t.iqd)) +
    row(t.purchaseDate, longDate(data.product.purchase_date, lang)) +
    row(t.orderReceipt, data.product.order_receipt_no, { ltr: true });

  // A purchased extension prints as its own row, under the total period, so
  // the paper says both what the printer came with and what was bought.
  const ext = data.warranty.ext_months ?? 0;
  const base = data.warranty.base_months ?? null;
  const extensionRow =
    ext > 0 && base !== null ? row(t.extension, t.extendedBy(base, ext)) : '';
  const warranty =
    row(t.period, t.months(data.warranty.months)) +
    extensionRow +
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

  // The other language is one click away from the document itself rather than
  // from a control on some admin screen, so whichever surface opened this can
  // switch without going back. Both wordings are stored per receipt, so this
  // shows the copy it was ISSUED with, not today's configuration.
  const otherLang = lang === 'ar' ? 'en' : 'ar';
  const langLink =
    `<a href="?lang=${otherLang}">${lang === 'ar' ? 'English' : 'العربية'}</a>`;

  const printBar =
    `<div class="noprint">` +
    `<button type="button" onclick="window.print()">${lang === 'ar' ? 'طباعة / حفظ PDF' : 'Print / Save as PDF'}</button>` +
    langLink +
    `<span class="hint">${
      lang === 'ar'
        ? 'اختر «حفظ بصيغة PDF» في نافذة الطباعة للحصول على ملف PDF حقيقي بنص قابل للتحديد.'
        : 'Choose “Save as PDF” in the print dialog for a real, text-selectable PDF file.'
    }</span></div>`;

  return (
    `<!doctype html><html lang="${lang}" dir="${dir}"><head>` +
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(`${t.title} ${data.receipt_no}`)}</title>` +
    /* THE FONT THIS DOCUMENT ALREADY ASKED FOR.
       `font-family` has named Cairo since the document was written and nothing
       ever fetched it, so every warranty certificate the shop has printed came
       out in Segoe UI or Tahoma. documentCsp has allowed fonts.googleapis.com
       and fonts.gstatic.com all along — the request was simply never made. */
    PRINT_FONT_LINK +
    `<style>${CSS}</style></head><body>` +
    `<div class="sheet">` +
    `<div class="head"><h1>${escapeHtml(t.title)}</h1><div class="sub">${escapeHtml(t.other)}</div></div>` +
    `<div class="copybar"><span>${escapeHtml(t.copy)}</span><span class="en">${escapeHtml(t.copyOther)}</span></div>` +
    `<div class="body">` +
    statusBanner(data, t) +
    `<div class="grid">` +
    // The split is by MEASURED HEIGHT, not by topic: the warranty block
    // carries the coverage paragraph and the terms carry seven sentences, so
    // putting both in one column made that column drive the page onto a
    // second sheet. Identity and provenance on one side, the promise and its
    // conditions on the other, and the two come out within a few millimetres
    // of each other.
    `<div class="col">` +
    section(t.receiptNo, receiptNoBlock + row(t.date, longDate(data.issued_date, lang))) +
    section(t.customer, customer) +
    section(t.product, product) +
    section(t.retailer, retailer + chain) +
    `</div>` +
    `<div class="col">` +
    section(t.warranty, warranty) +
    section(t.terms, terms) +
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
