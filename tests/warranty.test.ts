/**
 * The warranty receipt's rules, as pure functions: the number, the status the
 * clock decides, the one-year window, the snapshotted terms, and the line
 * between what a receipt holder may see and what belongs to the customer.
 *
 * The database-backed invariants (a serial is mandatory, two devices get two
 * receipts, a cancelled order issues nothing, a reprint creates no second
 * document) live in scripts/e2e-warranty.mjs against a running worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_WARRANTY_CONFIG,
  PRIVATE_RECEIPT_FIELDS,
  RECEIPT_NO_RE,
  daysRemaining,
  effectiveStatus,
  formatReceiptNo,
  isCovered,
  parseWarrantyConfig,
  publicView,
  receiptNoPrefix,
  receiptNoSequence,
  warrantyWindow,
  type WarrantyReceiptRow,
} from '../worker/lib/warranty';
import { renderWarrantyDoc, type WarrantyDocData } from '../worker/lib/warrantyDoc';

// ------------------------------------------------------------ the number

test('the receipt number carries the day it was issued and that day’s sequence', () => {
  assert.equal(formatReceiptNo('2026-09-02T10:00:00.000Z', 1), 'WR-2026-0902-001');
  assert.equal(formatReceiptNo('2026-09-02T23:59:59.000Z', 42), 'WR-2026-0902-042');
  assert.equal(formatReceiptNo('2026-01-05T00:00:00.000Z', 7), 'WR-2026-0105-007');
  // A shop that issues more than 999 in one day keeps counting rather than
  // wrapping back onto a number it already handed out.
  assert.equal(formatReceiptNo('2026-09-02T10:00:00.000Z', 1000), 'WR-2026-0902-1000');
});

test('the prefix and the sequence round-trip, and foreign numbers read as zero', () => {
  const iso = '2026-09-02T10:00:00.000Z';
  assert.equal(receiptNoPrefix(iso), 'WR-2026-0902-');
  assert.equal(receiptNoSequence(formatReceiptNo(iso, 12)), 12);
  assert.equal(receiptNoSequence('INV-2026-1A2B3C4D'), 0);
  assert.equal(receiptNoSequence('WR-2026-0902'), 0);
  assert.equal(receiptNoSequence(''), 0);
});

test('the number pattern accepts our numbers and nothing else', () => {
  assert.ok(RECEIPT_NO_RE.test('WR-2026-0902-001'));
  assert.ok(RECEIPT_NO_RE.test('WR-2026-0902-1000'));
  assert.equal(RECEIPT_NO_RE.test('wr-2026-0902-001'), false);
  assert.equal(RECEIPT_NO_RE.test('WR-2026-0902-1'), false);
  assert.equal(RECEIPT_NO_RE.test('SN-260601014148'), false);
});

// ------------------------------------------------------------ the window

test('one year means the same date next year, and February keeps its footing', () => {
  assert.equal(warrantyWindow('2026-09-02T00:00:00.000Z', 12).end_at, '2027-09-02T00:00:00.000Z');
  assert.equal(warrantyWindow('2026-09-02T00:00:00.000Z', 24).end_at, '2028-09-02T00:00:00.000Z');
  // 29 February + 12 months has no same-date answer; the last day of the
  // target month is the honest one, never 1 March.
  assert.equal(warrantyWindow('2024-02-29T00:00:00.000Z', 12).end_at, '2025-02-28T00:00:00.000Z');
  // The start is preserved exactly, so the document and the record agree.
  assert.equal(warrantyWindow('2026-09-02T13:45:10.000Z', 12).start_at, '2026-09-02T13:45:10.000Z');
});

test('days remaining counts down and goes negative once the window closes', () => {
  const now = '2026-09-02T00:00:00.000Z';
  assert.equal(daysRemaining('2026-09-12T00:00:00.000Z', now), 10);
  assert.equal(daysRemaining('2026-09-02T00:00:00.000Z', now), 0);
  assert.ok((daysRemaining('2026-08-30T00:00:00.000Z', now) ?? 0) < 0);
  assert.equal(daysRemaining(null, now), null);
});

// ------------------------------------------------------------ the status

test('expiry is what the clock says about an active receipt, never a stored word', () => {
  const now = '2026-09-02T00:00:00.000Z';
  assert.equal(effectiveStatus('active', '2027-09-02T00:00:00.000Z', now), 'active');
  assert.equal(effectiveStatus('active', '2026-09-01T00:00:00.000Z', now), 'expired');
  // A draft, a void or a replaced receipt is that whatever the date says.
  assert.equal(effectiveStatus('draft', '2020-01-01T00:00:00.000Z', now), 'draft');
  assert.equal(effectiveStatus('void', '2099-01-01T00:00:00.000Z', now), 'void');
  assert.equal(effectiveStatus('replaced', '2099-01-01T00:00:00.000Z', now), 'replaced');
  // No end date recorded: never claim an expiry that was never computed.
  assert.equal(effectiveStatus('active', null, now), 'active');
  // An unknown stored value degrades to the least-claiming state.
  assert.equal(effectiveStatus('nonsense', null, now), 'draft');
});

test('only a live, in-date receipt counts as covered', () => {
  assert.equal(isCovered('active'), true);
  for (const s of ['draft', 'expired', 'void', 'replaced'] as const) assert.equal(isCovered(s), false);
});

// ------------------------------------------------------------ the config

test('the shop’s details and terms are defaults, not constants', () => {
  const edited = parseWarrantyConfig({
    default_months: 24,
    type_ar: 'ضمان الوكيل',
    terms: [{ ar: 'شرط واحد', en: 'One term' }],
    retailer: { phone: '07700000000' },
  });
  assert.equal(edited.default_months, 24);
  assert.equal(edited.type_ar, 'ضمان الوكيل');
  assert.deepEqual(edited.terms, [{ ar: 'شرط واحد', en: 'One term' }]);
  assert.equal(edited.retailer.phone, '07700000000');
  // Anything not edited keeps the shipped wording rather than becoming empty.
  assert.equal(edited.retailer.name, DEFAULT_WARRANTY_CONFIG.retailer.name);
  assert.equal(edited.coverage_ar, DEFAULT_WARRANTY_CONFIG.coverage_ar);
});

test('a broken or empty config never produces a receipt with no terms', () => {
  for (const junk of [null, undefined, '', 'not json', 42, { terms: [] }, { default_months: 0 }]) {
    const cfg = parseWarrantyConfig(junk);
    assert.ok(cfg.terms.length > 0, `terms lost for ${JSON.stringify(junk)}`);
    assert.ok(cfg.default_months >= 1 && cfg.default_months <= 240);
    assert.ok(cfg.retailer.name.length > 0);
  }
});

test('the default terms say the things the owner requires them to say', () => {
  const ar = DEFAULT_WARRANTY_CONFIG.terms.map((t) => t.ar).join(' ');
  const en = DEFAULT_WARRANTY_CONFIG.terms.map((t) => t.en).join(' ');
  assert.match(ar, /إبراز هذا الوصل/);
  assert.match(ar, /الرقم التسلسلي/);
  assert.match(en, /inspect and diagnose/i);
  assert.match(en, /does not automatically mean replacement/i);
  assert.match(en, /remaining original warranty/i);
  assert.match(en, /void if the serial number has been removed/i);
  assert.match(en, /manufacturer’s applicable policy/i);
});

// ------------------------------------------------------- the public view

const ROW: WarrantyReceiptRow = {
  id: 'wr_1',
  receipt_no: 'WR-2026-0902-001',
  unit_id: 'unit_1',
  order_id: 'ORD-ABC123',
  status: 'active',
  serial_raw: 'SN-260601014148',
  serial_norm: 'SN260601014148',
  customer_name: 'أسامة محمود',
  customer_phone: '07802969048',
  customer_address: 'بغداد، أبو غريب، تقاطع الزيتون',
  customer_email: 'osama@example.com',
  product_description: 'Gigabyte GeForce RTX 5070 Ti AERO 16GB',
  product_model: '5070 Ti AERO 16GB',
  purchase_price_iqd: 1_850_000,
  purchase_date: '2026-09-02T00:00:00.000Z',
  order_receipt_no: 'INV-2026-0902-001',
  warranty_type: 'ضمان ليفونيس',
  warranty_type_en: 'Levonis Warranty',
  warranty_months: 12,
  coverage_text: 'يغطي عيوب التصنيع',
  coverage_text_en: 'Covers manufacturing defects.',
  terms_json: JSON.stringify(DEFAULT_WARRANTY_CONFIG.terms),
  retailer_json: JSON.stringify(DEFAULT_WARRANTY_CONFIG.retailer),
  warranty_start_at: '2026-09-02T00:00:00.000Z',
  warranty_end_at: '2027-09-02T00:00:00.000Z',
  print_count: 0,
  replaces_receipt_id: null,
  replaced_by_receipt_id: null,
  void_reason: '',
  issued_at: '2026-09-02T00:00:00.000Z',
  created_at: '2026-09-02T00:00:00.000Z',
};

test('public verification proves coverage and tells the holder nothing about the buyer', () => {
  const view = publicView(ROW, '2026-10-01T00:00:00.000Z');
  const json = JSON.stringify(view);
  assert.equal(view.status, 'active');
  assert.equal(view.product, 'Gigabyte GeForce RTX 5070 Ti AERO 16GB');
  assert.equal(view.serial_masked, '****4148');
  assert.ok((view.days_remaining ?? 0) > 300);

  // Nothing that identifies or locates the customer, and no full serial.
  for (const field of PRIVATE_RECEIPT_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(view, field), false, `public view exposes ${field}`);
  }
  for (const secret of [
    ROW.customer_name,
    ROW.customer_phone,
    ROW.customer_address,
    ROW.customer_email,
    ROW.serial_raw,
    ROW.serial_norm,
    ROW.order_id,
    ROW.unit_id,
    String(ROW.purchase_price_iqd),
  ]) {
    assert.equal(json.includes(secret), false, `public view leaks "${secret}"`);
  }
});

test('a void or replaced receipt verifies as itself, and never as covered', () => {
  const now = '2026-10-01T00:00:00.000Z';
  const voided = publicView({ ...ROW, status: 'void' }, now);
  assert.equal(voided.status, 'void');
  assert.equal(isCovered(voided.status), false);
  assert.equal(voided.note, 'void');
  assert.equal(voided.days_remaining, null);

  const replaced = publicView({ ...ROW, status: 'replaced' }, now);
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.note, 'replaced');

  const expired = publicView(ROW, '2028-01-01T00:00:00.000Z');
  assert.equal(expired.status, 'expired');
  assert.equal(isCovered(expired.status), false);
});

test('the amount isolates its digits instead of forcing the row left to right', () => {
  const html = renderWarrantyDoc(DOC, 'ar');
  // U+2066 .. U+2069 around the number. Forcing dir="ltr" on the whole cell
  // laid the Iraqi dinar abbreviation out backwards as «ع.د».
  assert.match(html, /\u2066[\d,]+\u2069 د\.ع/);
  const priceCell = /<div class="lbl">[^<]*سعر[^<]*<\/div><div class="val"[^>]*>/.exec(html);
  assert.ok(priceCell, 'the price row exists');
  assert.equal(priceCell![0].includes('dir="ltr"'), false, 'and it is not forced to LTR');
});

test('the other language is reachable from the document itself', () => {
  assert.match(renderWarrantyDoc(DOC, 'ar'), /href="\?lang=en"/);
  assert.match(renderWarrantyDoc(DOC, 'en'), /href="\?lang=ar"/);
});

// ------------------------------------------------------------- the paper

const DOC: WarrantyDocData = {
  receipt_no: 'WR-2026-0902-001',
  issued_date: '2026-09-02T00:00:00.000Z',
  status: 'active',
  customer: { name: 'أسامة محمود', address: 'بغداد، أبو غريب', phone: '07802969048', email: '' },
  product: {
    description: 'Gigabyte GeForce RTX 5070 Ti AERO 16GB',
    model: '5070 Ti AERO 16GB',
    serial: 'SN-260601014148',
    price_iqd: 1_850_000,
    purchase_date: '2026-09-02T00:00:00.000Z',
    order_receipt_no: 'INV-2026-0902-001',
  },
  warranty: {
    months: 12,
    type: 'ضمان ليفونيس',
    coverage: 'يغطي عيوب التصنيع وأعطال الأجزاء تحت الاستعمال الطبيعي.',
    start_at: '2026-09-02T00:00:00.000Z',
    end_at: '2027-09-02T00:00:00.000Z',
  },
  terms: DEFAULT_WARRANTY_CONFIG.terms,
  retailer: DEFAULT_WARRANTY_CONFIG.retailer,
  verify_url: 'https://levonis-iq.com/warranty/WR-2026-0902-001',
  chain: { replaces: null, replaced_by: null },
};

test('the document is A4 with real margins, not a thermal roll', () => {
  const html = renderWarrantyDoc(DOC, 'ar');
  assert.match(html, /@page \{ size: A4; margin: 12mm; \}/);
  assert.equal(html.includes('80mm'), false);
  // White paper, dark ink: nothing here depends on a dark UI theme.
  assert.match(html, /background: #fff/);
});

test('every field the owner listed is on the paper', () => {
  const html = renderWarrantyDoc(DOC, 'ar');
  for (const value of [
    'WR-2026-0902-001',
    'أسامة محمود',
    '07802969048',
    'Gigabyte GeForce RTX 5070 Ti AERO 16GB',
    '5070 Ti AERO 16GB',
    'SN-260601014148',
    '1,850,000',
    'INV-2026-0902-001',
    'ضمان ليفونيس',
    'LEVONIS',
    'LEVONIS-IQ.COM',
    '@LEVONIS_IQ',
    '07838455220',
  ]) {
    assert.ok(html.includes(value), `the document omits ${value}`);
  }
  // The signature block and the verification address.
  assert.match(html, /توقيع الزبون/);
  assert.match(html, /levonis-iq\.com\/warranty\/WR-2026-0902-001/);
  // Every configured term is printed, not a summary of them.
  for (const t of DEFAULT_WARRANTY_CONFIG.terms) assert.ok(html.includes(t.ar), `missing term: ${t.ar}`);
});

test('the English copy is the same document, in English', () => {
  const html = renderWarrantyDoc(DOC, 'en');
  assert.match(html, /<html lang="en" dir="ltr">/);
  assert.ok(html.includes('Warranty Receipt'));
  assert.ok(html.includes('Customer Copy'));
  assert.ok(html.includes('Authorized Retailer Information'));
  assert.ok(html.includes('September 2, 2026'));
  for (const t of DEFAULT_WARRANTY_CONFIG.terms) assert.ok(html.includes(t.en), `missing English term: ${t.en}`);
});

test('a receipt that is not live says so on the paper itself', () => {
  assert.match(renderWarrantyDoc({ ...DOC, status: 'void' }, 'ar'), /وصل ملغى/);
  assert.match(renderWarrantyDoc({ ...DOC, status: 'expired' }, 'ar'), /انتهت مدة الضمان/);
  assert.match(renderWarrantyDoc({ ...DOC, status: 'draft' }, 'ar'), /مسودة/);
  assert.match(renderWarrantyDoc({ ...DOC, status: 'replaced' }, 'en'), /Device replaced/);
  // A live one carries no banner at all.
  assert.equal(/class="banner/.test(renderWarrantyDoc(DOC, 'ar')), false);
});

test('the verification QR is drawn as vector modules, not fetched as an image', () => {
  const html = renderWarrantyDoc(DOC, 'ar');
  assert.match(html, /<svg class="qr"/);
  assert.match(html, /<path d="M/);
  assert.equal(/<img/.test(html), false);
});

test('customer text cannot inject markup into the document', () => {
  const html = renderWarrantyDoc(
    { ...DOC, customer: { ...DOC.customer, name: '<script>alert(1)</script>' } },
    'ar'
  );
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('the print dialog opens only when the caller asked for it', () => {
  assert.equal(renderWarrantyDoc(DOC, 'ar', false).includes('window.print()'), true); // the button
  assert.equal(/addEventListener\('load'/.test(renderWarrantyDoc(DOC, 'ar', false)), false);
  assert.ok(/addEventListener\('load'/.test(renderWarrantyDoc(DOC, 'ar', true)));
});

// --------------------------------------------------------- the migration

test('the printed wording is snapshotted in BOTH languages', () => {
  const sql = readFileSync(new URL('../migrations/0042_warranty_receipts.sql', import.meta.url), 'utf8');
  // Without these two the English document would print the Arabic type and
  // coverage, because the row it reads only ever stored one language.
  assert.match(sql, /warranty_type_en TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /coverage_text_en TEXT NOT NULL DEFAULT ''/);
});

test('migration 0042 is additive and enforces one live receipt per unit and per serial', () => {
  const sql = readFileSync('migrations/0042_warranty_receipts.sql', 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert.match(statements, /CREATE TABLE IF NOT EXISTS warranty_receipts/);
  assert.match(statements, /CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_receipts_no/);
  assert.match(
    statements,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_receipts_unit_live[\s\S]*?WHERE status IN \('draft','active'\)/
  );
  assert.match(
    statements,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_warranty_receipts_serial_live[\s\S]*?WHERE status IN \('draft','active'\) AND serial_norm <> ''/
  );
  // Nothing existing is rewritten or dropped.
  assert.doesNotMatch(statements, /DROP|DELETE FROM|ALTER TABLE order_item_units|UPDATE /i);
});
