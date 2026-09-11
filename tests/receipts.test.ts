/**
 * The paper: purchase receipt, warranty receipt, delivery label.
 *
 * WHAT A TEST CAN ACTUALLY HOLD HERE. Not "does it look right" — that is a
 * printer and a pair of eyes. What it can hold is everything that would make
 * the paper WRONG rather than ugly:
 *
 *   * the final amount printed is the one passed in, to the dinar. A receipt
 *     that recomputes a total is a receipt that can disagree with the order,
 *     and the customer is holding the disagreement;
 *   * a discount prints with a minus and is never mistaken for a charge;
 *   * an adjustment the order did not have prints NOTHING, not a zero row;
 *   * a customer's name or note containing HTML cannot break out of the
 *     document — a name is data, and this document is served from our origin;
 *   * a unit with no serial says so instead of leaving a blank box for
 *     someone to fill in by hand;
 *   * the page carries a real @page size, so the shop is not asked to pick A4
 *     and scale a thermal receipt down to fit it;
 *   * the ESC/POS rendering agrees with the HTML about the total, because the
 *     two are the same receipt on different hardware.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escposReceipt,
  iqd,
  renderDeliveryLabel,
  renderLabelSheet,
  renderPurchaseReceipt,
  renderWarrantyReceipt,
  type DeliveryLabelData,
  type PurchaseReceiptData,
  type WarrantyReceiptData,
} from '../worker/lib/receipts';

const RECEIPT: PurchaseReceiptData = {
  order_id: 'ORD-ABC123',
  invoice_no: 'INV-0007',
  created_at: '2026-03-01T10:30:00.000Z',
  customer_name: 'أحمد الجبوري',
  phone: '07701234567',
  governorate: 'بغداد',
  area: 'الجادرية',
  address: 'شارع 62، محلة 909، دار 15',
  landmark: 'مقابل الصيدلية',
  notes: 'اتصل قبل الوصول',
  lines: [
    { name: 'Bambu Lab A1', variant: 'Combo', qty: 1, unit_iqd: 750_000, line_iqd: 750_000 },
    { name: 'PLA Basic', variant: 'أسود', qty: 3, unit_iqd: 20_000, line_iqd: 60_000 },
  ],
  adjustments: [
    { label_ar: 'خصم الكود SAVE10', label_en: 'Coupon SAVE10', amount_iqd: 81_000, negative: true },
    { label_ar: 'خصم النقاط', label_en: 'Points', amount_iqd: 0, negative: true },
    { label_ar: 'من المحفظة', label_en: 'Wallet', amount_iqd: 0, negative: true },
  ],
  subtotal_iqd: 810_000,
  shipping_iqd: 5_000,
  total_iqd: 734_000,
  due_on_delivery_iqd: 734_000,
  payment_method: 'cash',
  shipping_type_label: 'شحن مباشر',
  support_code: 'LEVO-7788',
};

const WARRANTY: WarrantyReceiptData = {
  order_id: 'ORD-ABC123',
  invoice_no: 'INV-0007',
  created_at: '2026-03-01T10:30:00.000Z',
  customer_name: 'أحمد الجبوري',
  phone: '07701234567',
  units: [
    // unit_index is 1-BASED, exactly as deviceOps.createUnitsOnDelivery
    // writes it (1..qty). The fixture used to start at 0 and hid a slip that
    // printed every unit one higher than the device record.
    { product_name: 'Bambu Lab A1', serial: 'SN-9911', unit_index: 1, months: 24, starts_at: '2026-03-05T09:00:00.000Z', ends_at: '2028-03-05T09:00:00.000Z' },
    { product_name: 'AMS Lite', serial: null, unit_index: 2, months: 12, starts_at: '2026-03-05T09:00:00.000Z', ends_at: '2027-03-05T09:00:00.000Z' },
  ],
  terms: 'الضمان يغطي عيوب التصنيع فقط.',
};

const LABEL: DeliveryLabelData = {
  order_id: 'ORD-ABC123',
  customer_name: 'أحمد الجبوري',
  phone: '07701234567',
  governorate: 'بغداد',
  area: 'الجادرية',
  address: 'شارع 62، محلة 909، دار 15',
  landmark: 'مقابل الصيدلية',
  notes: 'اتصل قبل الوصول',
  cod_iqd: 734_000,
  item_count: 4,
  tracking_no: 'AW-556677',
  created_at: '2026-03-01T10:30:00.000Z',
};

// ------------------------------------------------------------- the money

test('the amount the shopkeeper writes down is the amount passed in', () => {
  const html = renderPurchaseReceipt(RECEIPT);
  assert.ok(html.includes('734,000 IQD'), 'the final total is missing');
  // And it is not silently the subtotal: those are different numbers and
  // printing the wrong one is the whole failure mode.
  assert.ok(html.includes('810,000 IQD'));
  assert.notEqual(RECEIPT.total_iqd, RECEIPT.subtotal_iqd);
});

test('a discount prints with a minus, so it cannot read as a charge', () => {
  const html = renderPurchaseReceipt(RECEIPT);
  assert.ok(html.includes('-81,000 IQD'), 'the coupon line lost its sign');
});

test('an adjustment the order did not have prints nothing at all', () => {
  const html = renderPurchaseReceipt(RECEIPT);
  // Points and wallet are both zero on this order.
  assert.ok(!html.includes('خصم النقاط'), 'a zero points row was printed');
  assert.ok(!html.includes('من المحفظة'), 'a zero wallet row was printed');
});

test('every line and its total appear', () => {
  const html = renderPurchaseReceipt(RECEIPT);
  assert.ok(html.includes('Bambu Lab A1'));
  assert.ok(html.includes('PLA Basic'));
  assert.ok(html.includes('60,000 IQD'));
});

test('"due on delivery" only prints when something is actually due', () => {
  assert.ok(renderPurchaseReceipt(RECEIPT).includes('المستحق عند الاستلام'));
  const prepaid = { ...RECEIPT, due_on_delivery_iqd: 0 };
  assert.ok(!renderPurchaseReceipt(prepaid).includes('المستحق عند الاستلام'));
});

test('iqd() rounds to the dinar and groups in Latin digits', () => {
  // A thermal head has one font; Arabic-Indic digits are a gamble on it.
  assert.equal(iqd(734000), '734,000 IQD');
  assert.equal(iqd(0), '0 IQD');
  assert.equal(iqd(1234.6), '1,235 IQD');
});

// ------------------------------------------------------------- injection

test('a name containing markup cannot break out of the document', () => {
  const evil = {
    ...RECEIPT,
    customer_name: '<script>alert(1)</script>',
    notes: '"><img src=x onerror=alert(2)>',
  };
  const html = renderPurchaseReceipt(evil);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'a script tag survived');
  assert.ok(!html.includes('<img src=x'), 'an img tag survived');
  assert.ok(html.includes('&lt;script&gt;'), 'the name was dropped instead of escaped');
});

test('the label escapes too — it carries the same customer text', () => {
  const evil = { ...LABEL, notes: '<script>x</script>' };
  const html = renderDeliveryLabel(evil);
  assert.ok(!html.includes('<script>x</script>'));
});

// ------------------------------------------------------------- warranty

test('the warranty slip names every unit, its serial and its window', () => {
  const html = renderWarrantyReceipt(WARRANTY);
  assert.ok(html.includes('Bambu Lab A1'));
  assert.ok(html.includes('SN-9911'));
  assert.ok(html.includes('2028-03-05'));
  assert.ok(html.includes('24'));
});

test('the unit number on the slip is the unit number in the database', () => {
  // 1-based on both sides. Printing "2" for the first of two printers sends
  // a customer to a claim desk holding paper that names the wrong device.
  const html = renderWarrantyReceipt(WARRANTY);
  const unitLines = html.split('القطعة').slice(1).map((chunk) => chunk.slice(0, 60));
  assert.equal(unitLines.length, 2);
  assert.ok(unitLines[0].includes('>1<'), unitLines[0]);
  assert.ok(unitLines[1].includes('>2<'), unitLines[1]);
});

test('a unit with no serial SAYS so rather than leaving a blank box', () => {
  // An empty box invites a hand-written serial, and a hand-written serial on
  // a warranty slip is worth nothing at claim time.
  const html = renderWarrantyReceipt(WARRANTY);
  assert.ok(html.includes('بلا رقم تسلسلي'));
});

test('the owner\'s published terms are printed verbatim, and absent when there are none', () => {
  assert.ok(renderWarrantyReceipt(WARRANTY).includes('الضمان يغطي عيوب التصنيع فقط.'));
  const noTerms = renderWarrantyReceipt({ ...WARRANTY, terms: '' });
  assert.ok(!noTerms.includes('شروط الضمان'), 'an empty terms block was printed');
});

// --------------------------------------------------------------- labels

test('the driver\'s two most-used fields are the largest on the sticker', () => {
  const html = renderDeliveryLabel(LABEL);
  // The phone is read from a moving motorbike.
  assert.match(html, /font-size:19px;font-weight:800[^>]*>07701234567/);
  assert.ok(html.includes('734,000 IQD'));
});

test('a prepaid order says PREPAID instead of an amount to collect', () => {
  const html = renderDeliveryLabel({ ...LABEL, cod_iqd: 0 });
  assert.ok(html.includes('مدفوع مسبقًا'));
  assert.ok(!html.includes('المبلغ المطلوب'));
});

test('a batch prints one sticker per page', () => {
  const html = renderLabelSheet([LABEL, { ...LABEL, order_id: 'ORD-XYZ' }]);
  assert.equal((html.match(/class="label"/g) ?? []).length, 2);
  assert.ok(html.includes('page-break-after: always'));
  assert.ok(html.includes('ORD-XYZ'));
});

test('an empty batch says so and does NOT auto-print a blank page', () => {
  const html = renderLabelSheet([], 'ar', true);
  assert.ok(html.includes('لا توجد طلبات جديدة للطباعة'));
  assert.ok(!html.includes('window.print()'), 'a blank sheet would have gone to the printer');
});

// ----------------------------------------------------------- the paper

test('each document declares the paper it is for', () => {
  // Without a @page rule the browser offers A4 and the shop scales an 80mm
  // receipt down to a corner of it.
  assert.ok(renderPurchaseReceipt(RECEIPT).includes('@page { size: 80mm auto'));
  assert.ok(renderPurchaseReceipt(RECEIPT, 'ar', false, 58).includes('@page { size: 58mm auto'));
  assert.ok(renderDeliveryLabel(LABEL).includes('@page { size: 100mm 70mm'));
});

test('auto-print fires only when asked for', () => {
  assert.ok(!renderPurchaseReceipt(RECEIPT).includes('window.print()'));
  assert.ok(renderPurchaseReceipt(RECEIPT, 'ar', true).includes('window.print()'));
});

test('Arabic renders RTL and English LTR', () => {
  assert.ok(renderPurchaseReceipt(RECEIPT, 'ar').includes('dir="rtl"'));
  assert.ok(renderPurchaseReceipt(RECEIPT, 'en').includes('dir="ltr"'));
  assert.ok(renderPurchaseReceipt(RECEIPT, 'en').includes('Purchase receipt'));
});

// --------------------------------------------------------------- ESC/POS

test('the ESC/POS receipt agrees with the HTML about the money', () => {
  // Two renderings of one receipt. The day they disagree is the day a
  // customer is charged one thing and handed paper saying another.
  const raw = escposReceipt(RECEIPT);
  assert.ok(raw.includes('734,000 IQD'), 'the total is missing');
  assert.ok(raw.includes('810,000 IQD'));
  assert.ok(raw.includes('-81,000 IQD'));
  assert.ok(raw.includes('ORD-ABC123'));
});

test('it starts with an initialise and ends with a cut', () => {
  const raw = escposReceipt(RECEIPT);
  assert.ok(raw.startsWith('\x1b@'), 'the printer is never initialised');
  assert.ok(raw.endsWith('\x1dV\x42\x00'), 'the paper is never cut');
});

test('the column count is respected, so nothing wraps into nonsense', () => {
  for (const cols of [32, 48]) {
    const raw = escposReceipt(RECEIPT, cols);
    for (const line of raw.split('\n')) {
      // Control sequences are not printed columns; strip them before
      // measuring. eslint's no-control-regex is right in general and wrong
      // here: ESC/POS IS control characters, and matching them is the point.
      // eslint-disable-next-line no-control-regex
      const printable = line.replace(/\x1b[@aE!][\s\S]?|\x1d[!V][\s\S]{0,2}/g, '');
      assert.ok(printable.length <= cols + 2, `a ${printable.length}-column line at ${cols}: ${printable}`);
    }
  }
});
