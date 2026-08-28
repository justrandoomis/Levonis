/**
 * Unit tests for worker/lib/emailTemplates.ts and the invoice snapshot →
 * email-data mapping. Run: npm run test:unit
 * Pins the final-phase §3 guarantees: safe escaping of every interpolated
 * value, correct RTL/LTR markup, plain-text alternatives, honest payment
 * wording (COD is never "paid"), and zero tracking artifacts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderVerifyEmail,
  renderResetPasswordEmail,
  renderPasswordChangedEmail,
  renderOrderInvoiceEmail,
  renderInvoiceHtmlDocument,
  escapeHtml,
  emailLang,
  type InvoiceEmailData,
} from '../worker/lib/emailTemplates';
import { invoiceEmailData, type InvoiceSnapshotV1 } from '../worker/lib/invoices';

const LINK = 'https://levonis-iq.com/?verify_email=abc123';

function invoice(over: Partial<InvoiceEmailData> = {}): InvoiceEmailData {
  return {
    invoice_no: 'INV-2026-AAAA1111',
    order_id: 'ORD-1234567890',
    revision: 1,
    issued_at: '2026-08-28T10:00:00.000Z',
    customer_name: 'Test User',
    lines: [
      {
        name: 'Bambu Lab A1',
        variant: 'Combo / Black',
        qty: 2,
        unit_price_iqd: 500_000,
        line_total_iqd: 1_000_000,
        transport_commission_iqd: 0,
        warranty_fee_iqd: 0,
        warranty_label: '',
      },
    ],
    subtotal_iqd: 1_000_000,
    delivery_fee_iqd: 5_000,
    delivery_waived: false,
    coupon_discount_iqd: 0,
    points_applied_iqd: 0,
    wallet_applied_iqd: 0,
    total_iqd: 1_005_000,
    amount_paid_iqd: 0,
    amount_due_iqd: 1_005_000,
    payment_status: 'cod_due',
    ...over,
  };
}

test('emailLang falls back to Arabic', () => {
  assert.equal(emailLang('en'), 'en');
  assert.equal(emailLang('ckb'), 'ckb');
  assert.equal(emailLang('fr'), 'ar');
  assert.equal(emailLang(undefined), 'ar');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a">&'`), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('verify email: RTL for ar/ckb, LTR for en, link present in html AND text', () => {
  for (const lang of ['ar', 'ckb'] as const) {
    const m = renderVerifyEmail(lang, LINK);
    assert.ok(m.html.includes('dir="rtl"'), `${lang} must be rtl`);
    assert.ok(m.html.includes(LINK));
    assert.ok(m.text.includes(LINK), 'plain-text alternative carries the link');
  }
  const en = renderVerifyEmail('en', LINK);
  assert.ok(en.html.includes('dir="ltr"'));
  assert.ok(en.text.includes(LINK));
});

test('templates contain no tracking pixels, images or scripts', () => {
  const all = [
    renderVerifyEmail('ar', LINK),
    renderResetPasswordEmail('en', LINK),
    renderPasswordChangedEmail('ckb'),
    renderOrderInvoiceEmail('ar', invoice(), 'https://levonis-iq.com/orders'),
  ];
  for (const m of all) {
    assert.ok(!/<img/i.test(m.html), 'no images (no pixel tracking)');
    assert.ok(!/<script/i.test(m.html), 'no scripts');
    assert.ok(!/utm_|track|analytics/i.test(m.html), 'no analytics params');
  }
});

test('interpolated values are escaped in the invoice', () => {
  const inv = invoice({ customer_name: '<b>x</b>', lines: [{ ...invoice().lines[0], name: '<script>alert(1)</script>' }] });
  const m = renderOrderInvoiceEmail('en', inv, '');
  assert.ok(!m.html.includes('<script>alert(1)</script>'));
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(!m.html.includes('<b>x</b>'));
});

test('COD invoice is never labeled paid; amounts render as integer IQD', () => {
  const m = renderOrderInvoiceEmail('en', invoice(), '');
  assert.ok(m.html.includes('Unpaid — due on delivery'));
  assert.ok(!m.text.includes('Paid in full'));
  assert.ok(m.text.includes('1,005,000 IQD'));
});

test('fully settled invoice is labeled paid with zero due', () => {
  const m = renderOrderInvoiceEmail('en', invoice({ amount_paid_iqd: 1_005_000, amount_due_iqd: 0, payment_status: 'paid' }), '');
  assert.ok(m.html.includes('Paid in full'));
  assert.ok(m.text.includes('Amount due: 0 IQD'));
});

test('empty ordersUrl renders no button/link at all', () => {
  const m = renderOrderInvoiceEmail('ar', invoice(), '');
  assert.ok(!/<a /i.test(m.html), 'no anchor when no trusted origin is configured');
});

test('printable document is standalone html with noindex and no scripts', () => {
  const doc = renderInvoiceHtmlDocument('ar', invoice());
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(doc.includes('dir="rtl"'));
  assert.ok(doc.includes('noindex'));
  assert.ok(!/<script/i.test(doc));
});

test('invoiceEmailData maps the persisted snapshot faithfully', () => {
  const snapshot: InvoiceSnapshotV1 = {
    version: 1,
    order: {
      id: 'ORD-XYZ',
      status: 'pending',
      created_at: '2026-08-28T09:00:00.000Z',
      payment_method_id: 'cod',
      membership_tier: 'free',
      exchange_rate: 1400,
    },
    customer: { user_id: 'usr_1', name: 'A', email: 'a@example.com' },
    address: { name: 'A', phone: '077', address: 'Baghdad', landmark: '' },
    lines: [
      {
        order_item_id: 'oi_1',
        product_id: 'p1',
        name: 'Filament PLA',
        variant: 'Red',
        qty: 3,
        unit_price_iqd: 20_000,
        line_total_iqd: 60_000,
        transport_commission_iqd: 0,
        warranty_fee_iqd: 0,
        warranty_label: '',
      },
    ],
    totals: {
      subtotal_iqd: 60_000,
      delivery_fee_iqd: 5_000,
      delivery_waived: false,
      coupon_code: '',
      coupon_discount_iqd: 0,
      points_applied_iqd: 10_000,
      wallet_applied_iqd: 0,
      total_iqd: 55_000,
      amount_paid_iqd: 0,
      amount_due_iqd: 55_000,
      payment_status: 'cod_due',
    },
  };
  const data = invoiceEmailData(snapshot, 'INV-2026-TEST0001', 2, '2026-08-28T10:00:00.000Z');
  assert.equal(data.order_id, 'ORD-XYZ');
  assert.equal(data.revision, 2);
  assert.equal(data.points_applied_iqd, 10_000);
  assert.equal(data.payment_status, 'cod_due');
  assert.equal(data.lines[0].line_total_iqd, 60_000);
  // Revision > 1 shows up in the rendered document.
  const m = renderOrderInvoiceEmail('en', data, '');
  assert.ok(m.text.includes('Revision: 2'));
});
