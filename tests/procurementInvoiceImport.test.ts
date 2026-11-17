/**
 * «استيراد فاتورة الشراء من الصور» — the reading's local validation, the
 * deterministic catalogue candidates, the match's id guard, and both routes end
 * to end against a stubbed provider (worker/lib/procurementInvoiceImport.ts,
 * worker/routes/adminProcurementImport.ts). No network: the provider is a stub
 * and the model ids are fake.
 *
 * Run: TZ=UTC node --import tsx --test tests/procurementInvoiceImport.test.ts
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { OWNER, all, asD1, json as body, post, put, stubApp } from './fixtures/app';
import { BASE, ENC_KEY, FULL, MODEL_A, SECRET_KEY, message, modelsPage, stubProvider, studioDb, type ProviderCall } from './fixtures/creativeStudio';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminCreativeStudioRoutes } from '../worker/routes/adminCreativeStudio';
import { adminProcurementImportRoutes, procurementImportTransport } from '../worker/routes/adminProcurementImport';
import { creativeTransport } from '../worker/routes/adminCreativeStudio';
import {
  INVOICE_SYSTEM,
  MATCH_SYSTEM,
  documentOf,
  normalizeText,
  rankProducts,
  validateInvoice,
  validateMatch,
  type Candidate,
  type InvoiceGroup,
  type InvoiceLine,
} from '../worker/lib/procurementInvoiceImport';
import type { Selection } from '../worker/lib/inventorySelection';

const P = '/api/admin/procurement';

// ---------------------------------------------------------------------------
// The reading's validation
// ---------------------------------------------------------------------------

const READING = {
  currency: 'CNY',
  orders: [
    { order_no: '3316584630174001887', shop: '义乌市品饰品有限公司', date: '2026-11-15', shipping: 0, discount: null, total: 51.25 },
  ],
  products: [
    {
      order_no: '3316584630174001887',
      title: '手工diy配件饰品材料 手机绳串龙虾扣',
      name_en: 'Phone lanyard strap',
      name_ar: 'حبل موبايل',
      sku: '',
      search_terms: ['lanyard', 'phone strap', 'حبل'],
      lines: [
        { option: '', color: '深绿色', qty: 250, unit_price: 0.09, line_total: 22.5 },
        { option: '', color: '黑色', qty: 250, unit_price: 0.09, line_total: null },
        // The same row read twice from two overlapping screenshots: kept once.
        { option: '', color: '黑色', qty: 250, unit_price: 0.09, line_total: null },
        { option: '', color: '金色', qty: 2.5, unit_price: 0.09, line_total: null },
        { option: '', color: '红色', qty: 10, unit_price: -1, line_total: null },
        { option: '', color: '白色', qty: 50, unit_price: 0.025, line_total: 9 },
      ],
    },
    { order_no: '', title: '', name_en: '', name_ar: '', sku: '', search_terms: [], lines: [{ option: '', color: '', qty: 1, unit_price: 1, line_total: 1 }] },
  ],
  notes: ['one row at the bottom was cut off'],
};

test('validateInvoice: flattens products into lines, keeps a row read twice once, refuses fractional / negative figures and flags a wrong row total', () => {
  const v = validateInvoice(READING);
  assert.ok(v.ok);
  if (!v.ok) return;
  const r = v.result;
  assert.deepEqual(r.lines.map((l) => [l.ref, l.color, l.qty, l.unit_price, l.line_total]), [
    ['L1', '深绿色', 250, 0.09, 22.5],
    ['L2', '黑色', 250, 0.09, 22.5],
    ['L3', '白色', 50, 0.025, 9],
  ]);
  assert.deepEqual(r.lines[2].warnings, ['LINE_TOTAL_MISMATCH'], '9 ≠ 50 × 0.025');
  assert.deepEqual(r.lines[0].warnings, []);
  // The fractional quantity, the negative price and the nameless product's row.
  assert.equal(r.rejected, 3);
  assert.deepEqual(r.groups.map((g) => g.name_en), ['Phone lanyard strap']);
  assert.deepEqual(r.document, { currency: 'CNY', supplier: '义乌市品饰品有限公司', order_no: '3316584630174001887', date: '2026-11-15', shipping: 0, total: 51.25 });
  assert.deepEqual(r.notes, ['one row at the bottom was cut off']);
});

test('validateInvoice: an answer with no usable line is refused, an unknown currency is OTHER, a malformed date is dropped', () => {
  assert.deepEqual(validateInvoice({ currency: 'CNY', orders: [], products: [], notes: [] }), { ok: false, reason: 'no readable purchase line' });
  assert.equal(validateInvoice(null).ok, false);
  assert.equal(validateInvoice([]).ok, false);
  const v = validateInvoice({
    currency: 'GBP',
    orders: [{ order_no: 'X', shop: 'S', date: '17/11/2026', shipping: Number.NaN, discount: 100, total: 4190 }],
    products: [{ order_no: 'X', title: 'Bambu Lab A1', name_en: 'Bambu Lab A1 Combo', name_ar: 'بامبو لاب A1', sku: 'PF002', search_terms: [], lines: [{ option: 'A1 Combo', color: '', qty: 5, unit_price: Number.POSITIVE_INFINITY, line_total: null }, { option: 'A1 Combo', color: '', qty: 5, unit_price: 369, line_total: 1845 }] }],
    notes: [],
  });
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.equal(v.result.document.currency, 'OTHER');
  assert.equal(v.result.document.date, undefined);
  assert.equal(v.result.document.shipping, undefined, 'NaN is not a shipping fee');
  assert.equal(v.result.document.discount, 100);
  assert.equal(v.result.rejected, 1, 'an infinite price is refused');
});

test('documentOf: a paid total is stated only when every order states one', () => {
  const o = (total: number | null) => ({ order_no: 'n', shop: 'a', date: '', shipping: 1, discount: null, total });
  assert.equal(documentOf('CNY', [o(10), o(null)]).total, undefined);
  assert.equal(documentOf('CNY', [o(10), o(5.5)]).total, 15.5);
  assert.equal(documentOf('CNY', [o(10), o(5.5)]).shipping, 2);
});

// ---------------------------------------------------------------------------
// The deterministic candidates
// ---------------------------------------------------------------------------

const group = (g: Partial<InvoiceGroup>): InvoiceGroup => ({ index: 0, title: '', name_en: '', name_ar: '', sku: '', search_terms: [], ...g });
const CATALOGUE = [
  { id: 'p_lanyard', name: 'Phone Lanyard Strap', name_ar: 'حبل الموبايل', sku: '', brand: '' },
  { id: 'p_pla', name: 'PLA Basic Filament 1kg', name_ar: 'خيط PLA', sku: 'PLA-B', brand: 'Bambu Lab' },
  { id: 'p_petg', name: 'PETG HF Filament 1kg', name_ar: 'خيط PETG', sku: 'PETG-HF', brand: 'Bambu Lab' },
  { id: 'p_a1', name: 'Bambu Lab A1', name_ar: 'طابعة بامبو لاب A1', sku: 'PF002-A', brand: 'Bambu Lab' },
];

test('normalizeText folds Arabic letter forms and diacritics', () => {
  assert.equal(normalizeText('أَحْمَر  الموبايلة'), 'احمر الموبايله');
  assert.equal(normalizeText('PLA+ (1KG)'), 'pla 1kg');
});

test('rankProducts: names, Arabic with the article, Latin tokens of a Chinese title and a SKU all find the product', () => {
  assert.equal(rankProducts(group({ name_en: 'Phone lanyard', name_ar: 'حبل موبايل' }), CATALOGUE)[0].product.id, 'p_lanyard');
  assert.equal(rankProducts(group({ title: '拓竹PETG HF 3D打印耗材', name_en: '' }), CATALOGUE)[0].product.id, 'p_petg');
  assert.equal(rankProducts(group({ name_en: 'Printer', sku: 'PF002-A+SA005-EU2' }), CATALOGUE)[0].product.id, 'p_a1', 'the catalogue SKU is part of the supplier SKU');
  assert.deepEqual(rankProducts(group({ name_en: 'Totally unrelated widget' }), CATALOGUE), []);
});

// ---------------------------------------------------------------------------
// The match's guard
// ---------------------------------------------------------------------------

const sel = (id: string, scope: Selection['scope'] = 'base', scope_id = ''): Selection =>
  ({ product_id: id, scope, scope_id, label: id, sku: '', stock: 0, reserved: 0, selling_price_iqd: null, unit_cost_iqd: null, purchase_unit_iqd: null, cost_source: 'unknown', weight_g: 0, volume_mm3: 0, packed_weight_g: null, packed_volume_mm3: null, procurement_defaults: [], procurement_shared_colors: false }) as Selection;
const line = (ref: string, groupIndex: number): InvoiceLine => ({ ref, group: groupIndex, order_no: '', title: 't', name_en: 'n', name_ar: '', sku: '', option: '', color: '', qty: 1, unit_price: 1, line_total: 1, warnings: [] });

test('validateMatch: an id offered for another line, an unknown line and a second pick of a line are refused', () => {
  const byGroup = new Map<number, Candidate[]>([
    [0, [{ id: 'c1', selection: sel('p1'), product_name: 'P1' }]],
    [1, [{ id: 'c2', selection: sel('p2'), product_name: 'P2' }]],
  ]);
  const v = validateMatch(
    {
      picks: [
        { line: 'L1', candidate: 'c2', confidence: 'high' },
        { line: 'L2', candidate: 'c2', confidence: 'medium' },
        { line: 'L2', candidate: '', confidence: 'high' },
        { line: 'L9', candidate: 'c1', confidence: 'high' },
        { line: 'L3', candidate: 'c1', confidence: 'weird' },
      ],
    },
    [line('L1', 0), line('L2', 1), line('L3', 0)],
    byGroup
  );
  assert.ok(v.ok);
  if (!v.ok) return;
  assert.deepEqual(v.result, {
    L1: { candidate: '', confidence: 'low' },
    L2: { candidate: 'c2', confidence: 'medium' },
    L3: { candidate: 'c1', confidence: 'low' },
  });
  assert.equal(validateMatch({}, [], byGroup).ok, false);
});

// ---------------------------------------------------------------------------
// The routes, end to end
// ---------------------------------------------------------------------------

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  delete procurementImportTransport.fetchImpl;
});

/** A header-only PNG of w×h: a valid picture signature with the size in its IHDR. */
function png(w: number, h: number) {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), u32(13), Buffer.from('IHDR'), u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0]), u32(0), u32(0), Buffer.from('IEND'), u32(0)]);
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Count 1 >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF');

function seedCatalogue(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,name_ku,description,description_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,images,inventory_mode,ops_policy,sku)
    VALUES ('p_lanyard','lanyard','Phone Lanyard Strap','حبل الموبايل','','','',0,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','COLOR','{}',NULL),
           ('p_a1','a1','Bambu Lab A1 Combo','بامبو لاب A1 كومبو','','','',0,'active',0,'[]','[]','direct_sale','["direct_sale"]','[]','BASE','{}','PF002-A+SA005-EU2');
    INSERT INTO product_colors (id,product_id,name_en,name_ar,hex,active,stock) VALUES
      ('col_green','p_lanyard','Dark green','أخضر غامق','#0a5a2a',1,0),
      ('col_black','p_lanyard','Black','أسود','#000000',1,0);
  `);
}

async function setup(env: Record<string, unknown> = { ANTHROPIC_API_KEY: SECRET_KEY }, user = OWNER) {
  const raw = await studioDb();
  seedCatalogue(raw);
  const app = stubApp(
    asD1(raw),
    user,
    (a) => {
      a.use('/api/admin/*', noStoreUnlessSet);
      a.route(BASE, adminCreativeStudioRoutes);
      a.route(P, adminProcurementImportRoutes);
    },
    { env: { CREATIVE_STUDIO_ENC_KEY: ENC_KEY, ...env } }
  );
  return { raw, app };
}

const EXTRACT_ANSWER = {
  currency: 'CNY',
  orders: [{ order_no: 'O-1', shop: 'Shop', date: '2026-11-15', shipping: 0, discount: null, total: 45 }],
  products: [
    { order_no: 'O-1', title: '手机绳 lanyard', name_en: 'Phone lanyard strap', name_ar: 'حبل موبايل', sku: '', search_terms: ['lanyard'], lines: [
      { option: '', color: '深绿色', qty: 250, unit_price: 0.09, line_total: 22.5 },
      { option: '', color: '黑色', qty: 250, unit_price: 0.09, line_total: 22.5 },
    ] },
    { order_no: 'O-1', title: 'Bambu Lab A1 3D Printer', name_en: 'Bambu Lab A1 Combo', name_ar: 'طابعة', sku: 'PF002-A+SA005-EU2', search_terms: [], lines: [{ option: 'A1 Combo', color: '', qty: 5, unit_price: 369, line_total: 1845 }] },
    { order_no: 'O-1', title: '未知商品', name_en: 'Mystery gadget', name_ar: 'أداة', sku: '', search_terms: [], lines: [{ option: '', color: '', qty: 1, unit_price: 2, line_total: 2 }] },
  ],
  notes: [],
};

test('extract + match: the owner\'s model reads the files with the invoice prompt; candidates come from the catalogue and the model only chooses among them', async () => {
  const { raw, app } = await setup();
  let matchBody: Record<string, unknown> | null = null;
  const stub = stubProvider((call: ProviderCall) => {
    if (call.url.includes('/v1/models')) return modelsPage();
    const system = String(call.body?.system ?? '');
    if (system === INVOICE_SYSTEM) return message(EXTRACT_ANSWER);
    assert.equal(system, MATCH_SYSTEM);
    matchBody = call.body;
    // The candidate ids offered for the lanyard's colours, read back from the request.
    const text = (call.body as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0].content[0].text;
    const data = JSON.parse(text.split('<lines_and_candidates>\n')[1].split('\n</lines_and_candidates>')[0]);
    const lanyard = data.find((g: { product: { name_en: string } }) => g.product.name_en === 'Phone lanyard strap');
    const id = (label: string) => lanyard.candidates.find((c: { selection: string }) => c.selection.includes(label)).id;
    return message({ picks: [{ line: 'L1', candidate: id('أخضر غامق'), confidence: 'high' }, { line: 'L2', candidate: id('أسود'), confidence: 'medium' }] });
  });
  restore = stub.restore;
  procurementImportTransport.fetchImpl = creativeTransport.fetchImpl;
  assert.equal((await put(app, `${BASE}/provider/settings`, { model: MODEL_A })).status, 200);

  const res = await post(app, `${P}/import/extract`, {
    idempotency_key: 'invoice-read-0001',
    files: [
      { label: 'order.png', data: png(620, 1500).toString('base64') },
      { label: 'invoice.pdf', data: PDF.toString('base64') },
    ],
  });
  const ex = await body(res);
  assert.equal(res.status, 200, JSON.stringify(ex));
  assert.equal(ex.lines.length, 4);
  assert.deepEqual(ex.document, { currency: 'CNY', supplier: 'Shop', order_no: 'O-1', date: '2026-11-15', shipping: 0, total: 45 });

  const sent = stub.messages()[0].body!;
  assert.equal(sent.model, MODEL_A);
  assert.deepEqual((sent.output_config as { effort?: string }).effort, 'low');
  const blocks = (sent.messages as Array<{ content: Array<{ type: string; source?: { media_type: string } }> }>)[0].content;
  assert.deepEqual(blocks.filter((b) => b.type !== 'text').map((b) => [b.type, b.source!.media_type]), [['image', 'image/png'], ['document', 'application/pdf']]);
  // The job is on the studio's ledger, stored under the vision task.
  assert.deepEqual(all<{ task: string; status: string }>(raw, `SELECT task, status FROM creative_jobs WHERE id = '${ex.job_id}'`).map((r) => ({ ...r })), [{ task: 'review', status: 'succeeded' }]);

  const m = await post(app, `${P}/import/match`, { job_id: ex.job_id, idempotency_key: 'invoice-match-0001' });
  const mb = await body(m);
  assert.equal(m.status, 200, JSON.stringify(mb));
  const by = Object.fromEntries((mb.lines as Array<{ ref: string; key: string | null; confidence: string | null; via: string | null }>).map((l) => [l.ref, l]));
  assert.deepEqual(by.L1, { ref: 'L1', key: 'p_lanyard|color|col_green', confidence: 'high', via: 'ai' });
  assert.deepEqual(by.L2, { ref: 'L2', key: 'p_lanyard|color|col_black', confidence: 'medium', via: 'ai' });
  assert.deepEqual(by.L3, { ref: 'L3', key: 'p_a1|base|', confidence: 'high', via: 'sku' }, 'the SKU decides without the model');
  assert.deepEqual(by.L4, { ref: 'L4', key: null, confidence: null, via: null }, 'no catalogue product: left for the manual picker');
  assert.equal(mb.selections['p_lanyard|color|col_green'].product_id, 'p_lanyard');
  // The match call carried only the open lanyard lines — not the SKU-decided printer, not the candidate-less gadget.
  assert.ok(matchBody);
  const matchText = JSON.stringify(matchBody);
  assert.ok(matchText.includes('L1') && matchText.includes('L2') && !matchText.includes('"L3') && !matchText.includes('Mystery'));
  assert.equal(stub.messages().length, 2);
});

test('extract: no key → 409 KEY_NOT_CONFIGURED before any provider call; a non-owner admin is refused at the cost door', async () => {
  const { app } = await setup({});
  const stub = stubProvider(() => message({}));
  restore = stub.restore;
  procurementImportTransport.fetchImpl = creativeTransport.fetchImpl;
  const res = await post(app, `${P}/import/extract`, { idempotency_key: 'invoice-read-0002', files: [{ label: 'a.png', data: png(10, 10).toString('base64') }] });
  assert.equal(res.status, 409);
  assert.equal((await body(res)).code, 'KEY_NOT_CONFIGURED');
  assert.equal(stub.calls.length, 0);

  const other = await setup({ ANTHROPIC_API_KEY: SECRET_KEY }, FULL);
  const refused = await post(other.app, `${P}/import/extract`, { idempotency_key: 'invoice-read-0003', files: [] });
  assert.equal(refused.status, 403);
  assert.equal((await body(refused)).code, 'COST_ACCESS_DENIED');
});

test('extract: a file that is neither a picture nor a PDF, too many files, and a missing key are refused before the provider', async () => {
  const { app } = await setup();
  const stub = stubProvider((call) => (call.url.includes('/v1/models') ? modelsPage() : message(EXTRACT_ANSWER)));
  restore = stub.restore;
  procurementImportTransport.fetchImpl = creativeTransport.fetchImpl;
  assert.equal((await put(app, `${BASE}/provider/settings`, { model: MODEL_A })).status, 200);
  const html = await post(app, `${P}/import/extract`, { idempotency_key: 'invoice-read-0004', files: [{ label: 'x', data: Buffer.from('<html>hello world</html>').toString('base64') }] });
  assert.equal(html.status, 415);
  const many = await post(app, `${P}/import/extract`, { idempotency_key: 'invoice-read-0005', files: Array.from({ length: 21 }, () => ({ label: 'a', data: png(10, 10).toString('base64') })) });
  assert.equal((await body(many)).code, 'IMPORT_TOO_MANY_FILES');
  const nokey = await post(app, `${P}/import/extract`, { files: [{ label: 'a', data: png(10, 10).toString('base64') }] });
  assert.equal(nokey.status, 400);
  assert.equal(stub.messages().length, 0);
});
