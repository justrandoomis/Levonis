/**
 * THE ORDERS LIST v2 ON THE SCREEN (merchant platform v2 §3.3, P3b) —
 * `src/components/merchant/orders/OrdersList.tsx` on `DataList`, replacing
 * `SalesTabs.OrdersTab` in the orders section.
 *
 *   the words: every key in ar, en AND real Sorani (decision row 168);
 *   the arithmetic (./bulk.ts): the tray's plan for a mixed selection, the
 *   sentence a bulk answer earns, the rows after a move, the search's bounds,
 *   the CSV's address;
 *   the render (`renderToStaticMarkup`, the technique of
 *   tests/orderBoardRowItems.test.ts): the seven columns' cells as the cards
 *   and the table draw them (the payment chip apart from the status), the
 *   selection tray as an in-flow toolbar, the packing slips one per page with
 *   what to collect in the header, the screen's frame (search, filter, CSV
 *   over a period);
 *   the CSV's period (Baghdad months, two typed days in order), the list read
 *   as deep as the address says, and the list's state written back to it;
 *   the pins: the tray springs with `m.spring('ui')` and is never
 *   `fixed bottom-0` (tests/uiSystem.test.ts), no invented duration, the
 *   section lazy-loads the new chunk, the refusal codes are translated.
 *
 * The component imports its print stylesheet; node has no CSS loader, so a
 * resolve hook answers `.css` with an empty module before the import.
 *
 * Run: node --import tsx --test tests/ordersListUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { register } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { LanguageProvider } from '../src/LanguageContext';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { ORDERS_STRINGS, ordersCount, moveLabel, fill, type OrdersLang } from '../src/components/merchant/orders/strings';
import {
  applyMoves, baghdadDay, bulkOutcome, bulkPlan, csvHref, exportRange, listParams, mapLimit, readPages, searchTerm, type OrderListRow,
} from '../src/components/merchant/orders/bulk';
import { LIST_PAGES_MAX } from '../src/components/merchant/orders/ordersView';
import {
  locIn, orderMoveLabel, orderPayment, orderPaymentLabel, orderPaymentTone, paymentMark, type OrderPayment,
} from '../src/components/merchant/orders/labels';

register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(specifier, context, next) {
         if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
         return next(specifier, context);
       }`
    )
);
const list = await import('../src/components/merchant/orders/OrdersList');
const { default: OrdersList, SelectionTray, PackingSlips, orderColumns, since } = list;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const KURDISH = /[ەۆێڕڵڤگچپژیک]/;

const row = (over: Partial<OrderListRow> = {}): OrderListRow => ({
  id: 'ORD-A1F3',
  status: 'pending',
  total_iqd: 45_000,
  merchant_receivable_iqd: 40_000,
  customer_name: 'نور محمد',
  item_count: 3,
  created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  governorate: 'baghdad',
  tracking_no: '',
  credit_state: null,
  release_after: null,
  payment_method_id: 'wallet',
  ...over,
});

const html = (node: ReactNode) => renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, node) }));

// ------------------------------------------------------------------ words

test('every key exists in ar, en and ckb; the Sorani is Sorani, never the Arabic pasted across', () => {
  const langs = Object.keys(ORDERS_STRINGS) as OrdersLang[];
  assert.deepEqual(langs.sort(), ['ar', 'ckb', 'en']);
  const keys = Object.keys(ORDERS_STRINGS.ar);
  for (const l of langs) assert.deepEqual(Object.keys(ORDERS_STRINGS[l]).sort(), [...keys].sort(), `${l} has the same keys`);
  let kurdish = 0;
  for (const k of keys) {
    const ar = ORDERS_STRINGS.ar[k as keyof typeof ORDERS_STRINGS.ar];
    const en = ORDERS_STRINGS.en[k as keyof typeof ORDERS_STRINGS.en];
    const ckb = ORDERS_STRINGS.ckb[k as keyof typeof ORDERS_STRINGS.ckb];
    for (const v of [ar, en, ckb]) assert.ok(typeof v === 'string' && v.trim(), `${k} is written`);
    assert.notEqual(ckb, ar, `${k}: ckb is a copy of the Arabic`);
    assert.notEqual(ckb, en, `${k}: ckb is a copy of the English`);
    if (KURDISH.test(ckb)) kurdish++;
    // The same holes in every language, so `fill` never leaves one open.
    const holes = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort();
    assert.deepEqual(holes(en), holes(ar), `${k}: en holes`);
    assert.deepEqual(holes(ckb), holes(ar), `${k}: ckb holes`);
  }
  assert.ok(kurdish / keys.length >= 0.9, `${kurdish}/${keys.length} ckb values carry Kurdish letters`);
});

test('the counted noun and the move words', () => {
  assert.equal(ordersCount(1, 'ar'), 'طلب واحد');
  assert.equal(ordersCount(2, 'ar'), 'طلبان');
  assert.equal(ordersCount(3, 'ar'), '3 طلبات');
  assert.equal(ordersCount(11, 'ar'), '11 طلبًا');
  assert.equal(ordersCount(100, 'ar'), '100 طلب');
  assert.equal(ordersCount(1, 'en'), '1 order');
  assert.equal(ordersCount(4, 'en'), '4 orders');
  assert.equal(ordersCount(4, 'ckb'), '4 داواکاری');
  assert.equal(moveLabel(ORDERS_STRINGS.ar, 'confirmed'), 'تأكيد');
  assert.equal(moveLabel(ORDERS_STRINGS.ckb, 'shipped'), 'ناردن');
  assert.equal(fill(ORDERS_STRINGS.en.bulkAsk, { orders: '3 orders', status: 'Confirmed' }), 'Move 3 orders to “Confirmed”?');
  assert.equal(fill('{a} {b}', { a: 1 }), '1 {b}', 'an unfilled hole stays visible rather than vanishing');
});

test('the new refusal codes are translated three ways and differ from each other', () => {
  for (const code of ['BULK_TOO_MANY', 'BULK_CANCEL_NOT_ALLOWED', 'TRACKING_NO_TOO_LONG']) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e, `${code} translated`);
    assert.ok(e.ar && e.en && e.ckb);
    assert.notEqual(e.ckb, e.ar, `${code}: ckb is not the Arabic`);
    assert.ok(KURDISH.test(e.ckb), `${code}: ckb is Sorani`);
  }
});

// ------------------------------------------------------------- arithmetic

test('bulkPlan: one counted step per forward move the selection can take, in the flow\'s order, never a cancel', () => {
  const rows = [row({ id: 'A', status: 'pending' }), row({ id: 'B', status: 'pending' }), row({ id: 'C', status: 'confirmed' }), row({ id: 'D', status: 'delivered' })];
  assert.deepEqual(bulkPlan(rows, new Set(['A', 'B', 'C', 'D', 'ghost'])), [
    { to: 'confirmed', ids: ['A', 'B'] },
    { to: 'processing', ids: ['C'] },
  ]);
  assert.deepEqual(bulkPlan(rows, new Set(['D'])), [], 'a delivered order has no forward step');
  assert.deepEqual(bulkPlan(rows, new Set()), []);
});

test('bulkOutcome: all done, some refused, none moved', () => {
  assert.deepEqual(bulkOutcome({ status: 'confirmed', done: ['A', 'B'], refused: [] }), { kind: 'done', n: 2 });
  assert.deepEqual(bulkOutcome({ status: 'confirmed', done: ['A'], refused: [{ id: 'B', code: 'ORDER_CHANGED' }] }), {
    kind: 'partial', n: 1, m: 1, refused: [{ id: 'B', code: 'ORDER_CHANGED' }],
  });
  assert.equal(bulkOutcome({ status: 'confirmed', done: [], refused: [{ id: 'B', code: 'ORDER_CHANGED' }] }).kind, 'none');
});

test('applyMoves: the moved rows carry the new status (and a ship\'s number); under another status filter they leave', () => {
  const rows = [row({ id: 'A', status: 'processing' }), row({ id: 'B', status: 'processing' })];
  const shipped = applyMoves(rows, ['A'], 'shipped', '', 'TRK-1');
  assert.equal(shipped[0].status, 'shipped');
  assert.equal(shipped[0].tracking_no, 'TRK-1');
  assert.equal(shipped[1].status, 'processing');
  assert.deepEqual(applyMoves(rows, ['A'], 'shipped', 'processing').map((r) => r.id), ['B'], 'no longer «قيد التجهيز»');
  assert.equal(applyMoves(rows, ['A'], 'shipped', 'shipped').length, 2, 'the filter it moved INTO keeps it');
  assert.equal(applyMoves(rows, ['A'], 'confirmed', '', 'TRK-1')[0].tracking_no, '', 'only a ship carries a number');
});

test('searchTerm, listParams and csvHref: the server\'s words, the server\'s bounds', () => {
  assert.equal(searchTerm('  '), '');
  assert.equal(searchTerm(' نور '), 'نور');
  assert.equal(searchTerm('x'.repeat(60)), 'x'.repeat(60));
  assert.equal(searchTerm('x'.repeat(61)), null);
  assert.equal(listParams({ status: 'pending', q: 'نور', cursor: 'a|b' }).toString(), 'status=pending&q=%D9%86%D9%88%D8%B1&cursor=a%7Cb');
  assert.equal(csvHref({}), '/api/merchant/orders/export.csv');
  assert.equal(csvHref({ status: 'shipped', q: '#A1' }), '/api/merchant/orders/export.csv?status=shipped&q=%23A1');
  // The day range is the server's `from` / `to` (worker/routes/merchant.ts csvDay): YYYY-MM-DD, or not sent.
  assert.equal(csvHref({ status: 'delivered', from: '2026-09-01', to: '2026-09-30' }), '/api/merchant/orders/export.csv?status=delivered&from=2026-09-01&to=2026-09-30');
  assert.equal(csvHref({ to: '2026-09-30' }), '/api/merchant/orders/export.csv?to=2026-09-30', 'an open start');
  assert.equal(csvHref({ from: '1/9/2026', to: '' }), '/api/merchant/orders/export.csv', 'a day the server would refuse is not sent');
  const server = read('worker/routes/merchant.ts');
  assert.match(server, /const from = csvDay\(c\.req\.query\('from'\), 'from'\);/, 'the server reads `from`');
  assert.match(server, /const to = csvDay\(c\.req\.query\('to'\), 'to'\);/, 'the server reads `to`');
});

test('THE CSV\'S PERIOD: a Baghdad day, calendar months in Baghdad, two typed days in order', () => {
  // 22:00 UTC on 31 March is already 1 April in Baghdad (UTC+3).
  assert.equal(baghdadDay(Date.parse('2026-03-31T22:00:00Z')), '2026-04-01');
  assert.equal(baghdadDay(Date.parse('2026-03-31T20:59:59Z')), '2026-03-31');
  assert.deepEqual(exportRange('all', {}, '2026-10-18'), {}, 'all time is no range — the CSV as before');
  assert.deepEqual(exportRange('this_month', {}, '2026-10-18'), { from: '2026-10-01', to: '2026-10-18' });
  assert.deepEqual(exportRange('last_month', {}, '2026-10-18'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(exportRange('last_month', {}, '2026-01-05'), { from: '2025-12-01', to: '2025-12-31' }, 'January\'s last month is last year\'s December');
  assert.deepEqual(exportRange('last_month', {}, '2028-03-31'), { from: '2028-02-01', to: '2028-02-29' }, 'a leap February');
  assert.deepEqual(exportRange('custom', { from: '2026-09-10', to: '2026-09-01' }, '2026-10-18'), { from: '2026-09-01', to: '2026-09-10' }, 'typed backwards is the same range');
  assert.deepEqual(exportRange('custom', { from: '2026-09-10', to: '' }, '2026-10-18'), { from: '2026-09-10' }, 'one day alone is an open end');
  assert.deepEqual(exportRange('custom', { from: '2026-02-30', to: 'x' }, '2026-10-18'), {}, 'a day that is not on the calendar is not sent');
  assert.deepEqual(exportRange('custom', {}, '2026-10-18'), {});
});

test('readPages: the list as deep as the address says, one page after another, stopping where the list ends', async () => {
  const book = Array.from({ length: 7 }, (_, i) => row({ id: `ORD-${i}` }));
  const asked: Array<string | null> = [];
  const page = async (cursor: string | null) => {
    asked.push(cursor);
    const at = cursor ? Number(cursor) : 0;
    // A page of three that repeats its last row on the next one (an order placed between the reads).
    const orders = book.slice(Math.max(0, at - 1), at + 3);
    return { orders, next_cursor: at + 3 < book.length ? String(at + 3) : null };
  };
  const two = await readPages(page, 2);
  assert.deepEqual(asked, [null, '3'], 'each page asks with the cursor the last one ended on');
  assert.deepEqual(two.rows.map((r) => r.id), ['ORD-0', 'ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-5'], 'a row two pages both carry is shown once');
  assert.equal(two.pages, 2);
  assert.equal(two.cursor, '6', 'the next page is still there for «more»');
  asked.length = 0;
  const all = await readPages(page, 10);
  assert.equal(all.pages, 3, 'the list ended before ten pages');
  assert.equal(all.cursor, null);
  assert.equal(all.rows.length, 7);
  assert.equal((await readPages(page, 0)).pages, 1, 'at least one page');
  await assert.rejects(readPages(async () => { throw new Error('offline'); }, 2), /offline/, 'a failed page fails the read; the screen keeps what it shows');
});

test('mapLimit: at most N in flight, answers in order, a failure as null', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (n === 3) throw new Error('no');
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, null, 40, 50]);
  assert.equal(peak, 2);
});

// ----------------------------------------------------------------- render

test('THE COLUMNS as a card or a table cell draws them: number LTR, customer, governorate · lines, money, status chip, since', () => {
  const s = ORDERS_STRINGS.ar;
  const chip = (r: OrderListRow) => createElement('span', { 'data-chip': r.status }, r.status);
  const cols = orderColumns(s, 'ar', (ar: string) => ar, chip);
  assert.deepEqual(cols.map((c) => c.id), ['order', 'customer', 'gov', 'total', 'payment', 'status', 'since']);
  assert.deepEqual(
    cols.map((c) => c.card ?? 'field'),
    ['title', 'meta', 'meta', 'field', 'field', 'badge', 'meta'],
    'one title, one badge (the status), quiet meta lines, the money and how it is paid side by side as fields'
  );
  assert.equal(cols[3].numeric, true, 'money is end-aligned and tabular');
  const r = row();
  const cell = (i: number) => html(cols[i].cell(r));
  assert.equal(cell(0), '<bdi dir="ltr">ORD-A1F3</bdi>');
  assert.equal(cell(1), 'نور محمد');
  // The column is «المحافظة»: where first, then how much (clay polish batch 3).
  assert.equal(cell(2), 'بغداد · 3 منتجات');
  assert.match(cell(3), /data-money/);
  assert.match(cell(3), /45[,٬.]?000|٤٥/, 'the amount');
  assert.match(cell(4), /data-payment-chip="paid"[^>]*>مدفوع · محفظة</, 'the payment is its own chip');
  assert.equal(cell(5), '<span data-chip="pending">pending</span>');
  assert.ok(cell(6).length > 0, 'a relative time');
  assert.equal(html(cols[1].cell(row({ customer_name: '' }))), '—');
  const en = orderColumns(ORDERS_STRINGS.en, 'en', (_ar: string, en: string) => en, chip);
  assert.equal(html(en[2].cell(row({ governorate: '' }))), '3 items');
  assert.equal(since(new Date(Date.now() - 12 * 60_000).toISOString(), 'en'), '12 minutes ago');
  assert.equal(since('garbage', 'en'), '');
});

test('THE TRAY is an in-flow toolbar: one counted button per step, the slips, no fixed positioning', () => {
  const out = html(
    createElement(SelectionTray, {
      plan: [{ to: 'confirmed', ids: ['A', 'B'] }, { to: 'processing', ids: ['C'] }],
      s: ORDERS_STRINGS.ar,
      lang: 'ar',
      busy: false,
      printing: false,
      onMove: () => {},
      onPrint: () => {},
    })
  );
  assert.match(out, /role="toolbar"/);
  assert.match(out, /aria-label="3 طلبات محددة"/);
  assert.match(out, /data-bulk-move="confirmed"[^>]*>تأكيد <bdi dir="ltr">\(2\)<\/bdi>/);
  assert.match(out, /data-bulk-move="processing"[^>]*>بدء التجهيز <bdi dir="ltr">\(1\)<\/bdi>/);
  assert.match(out, /data-bulk-print/);
  assert.match(out, /طباعة ملصقات الشحن/);
  assert.doesNotMatch(out, /\bfixed\b|bottom-0/);
});

test('THE PACKING SLIPS: one article per order, each on its own page, inside the print-only section', () => {
  const order = (id: string) => ({
    order: {
      id, status: 'processing', created_at: '2026-03-01T00:00:00.000Z', delivered_at: null, receipt_confirmed_at: null,
      credit_state: null, release_after: null, subtotal_iqd: 10_000, shipping_iqd: 0, total_iqd: 10_000, platform_fee_iqd: 0,
      merchant_receivable_iqd: 9_000, coupon_code: '', coupon_discount_iqd: 0, payment_method_id: 'cod', due_on_delivery_iqd: id === 'ORD-2' ? 10_000 : 0,
      customer_name: 'سارة', customer_phone: '07701234567', address: { governorate: 'baghdad', area: 'الكرادة', address: 'شارع 62' },
    },
    items: [{ id: 'it1', name_snapshot: 'PLA أسود', option_snapshot: '1kg', qty: 2 }],
  });
  const wallet = order('ORD-3');
  wallet.order.payment_method_id = 'wallet';
  const cancelled = order('ORD-4');
  cancelled.order.payment_method_id = 'wallet';
  cancelled.order.status = 'cancelled';
  const out = html(createElement(PackingSlips, { slips: [order('ORD-1'), order('ORD-2'), wallet, cancelled], storeName: 'Ali 3D', s: ORDERS_STRINGS.ar, lang: 'ar' }));
  assert.match(out, /<section class="order-print-slip" aria-hidden="true" data-print-slips="4">/);
  assert.equal((out.match(/<article /g) ?? []).length, 4);
  // What the courier collects is in the slip's header, boxed, before anything else.
  const slip = (id: string) => out.slice(out.indexOf(`data-print-slip="${id}"`), out.indexOf('</header>', out.indexOf(`data-print-slip="${id}"`)));
  assert.match(slip('ORD-2'), /<span class="order-print-pay" data-slip-pay="cod">يُحصَّل عند الاستلام: /, 'cash to collect, with the amount');
  assert.match(slip('ORD-3'), /<span class="order-print-pay" data-slip-pay="paid">مدفوع · محفظة<\/span>/);
  assert.doesNotMatch(slip('ORD-4'), /order-print-pay/, 'a cancelled order\'s money went back: no payment box');
  assert.doesNotMatch(slip('ORD-1'), /order-print-pay/, 'an unknown method with nothing due claims nothing');
  const en = html(createElement(PackingSlips, { slips: [wallet], storeName: 'Ali 3D', s: ORDERS_STRINGS.en, lang: 'en' }));
  assert.match(en, /data-slip-pay="paid">Paid · wallet</);
  const ckb = html(createElement(PackingSlips, { slips: [order('ORD-2')], storeName: 'Ali 3D', s: ORDERS_STRINGS.ckb, lang: 'ckb' }));
  assert.match(ckb, /data-slip-pay="cod">لە کاتی وەرگرتندا وەردەگیرێت: /);
  const css = read('src/components/merchant/orders/orderPrint.css');
  assert.match(css, /\.order-print-slip \.order-print-pay \{/, 'the box is drawn on paper');
  assert.match(css, /\.order-print-pay\[data-slip-pay='cod'\] \{ border-width: 2\.5pt; \}/, 'cash to collect is the heavy box');
  assert.match(out, /style="break-after:page"/);
  assert.match(out, /data-print-slip="ORD-1"/);
  assert.match(out, /Ali 3D/);
  assert.match(out, /<bdi dir="ltr">07701234567<\/bdi>/);
  assert.match(out, /بغداد، الكرادة، شارع 62/);
  assert.match(out, /PLA أسود — 1kg/);
  assert.match(out, /مدفوع — لا يُحصَّل شيء عند الاستلام/);
  assert.match(out, /يُحصَّل عند الاستلام: /);
});

test('THE SCREEN\'S FRAME: the search field, the CSV door that carries the filter, the seven status chips, the list — and the dialogs it asks with', () => {
  // The whole screen holds a confirm and a prompt dialog, whose Overlay
  // portals into `document.body` — nothing the server renderer can draw. The
  // frame is therefore pinned in the source; its rendered parts are proven above.
  const src = read('src/components/merchant/orders/OrdersList.tsx');
  assert.match(src, /<Input type="search" inputMode="search" enterKeyHint="search"[\s\S]*?data-orders-search \/>/);
  assert.match(src, /error=\{tooLong \? s\.searchTooLong : undefined\}/, 'a too-long search is refused beside the field, before it is sent');
  assert.match(src, /<a href=\{csvHref\(\{ status: filter, q, \.\.\.range \}\)\} download/, 'the CSV takes the current filter and the period');
  assert.match(src, /const range = exportRange\(period, days\);/);
  assert.match(src, /<Select value=\{period\} onChange=\{\(e\) => setPeriod\(e\.target\.value as ExportPeriod\)\} data-orders-period>/, 'the period is the platform\'s own select (the system picker on a phone)');
  assert.match(src, /EXPORT_PERIODS\.map\(/);
  assert.match(src, /\{period === 'custom' && \(/, 'two days appear only for a custom period');
  assert.match(src, /<Input ltr type="date" value=\{days\.from\} max=\{days\.to \|\| today\}/);
  assert.match(src, /<Input ltr type="date" value=\{days\.to\} min=\{days\.from \|\| undefined\} max=\{today\}/);
  assert.match(src, /const STATUS_FILTERS = \['', 'pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled'\] as const;/);
  assert.match(src, /<Segmented\s+size="sm"/, 'the filter is the small Segmented');
  assert.match(src, /badge: st \? badge\(st\) : undefined/, 'the attention counts sit on the stage chips');
  assert.match(src, /useConfirm\(\)/, 'a bulk move asks first');
  assert.match(src, /usePrompt\(\)/, 'a ship asks for the tracking number');
  assert.match(src, /<PackingSlips slips=\{slips\}/);
  assert.match(src, /window\.print\(\)/);
  assert.equal(typeof OrdersList, 'function', 'the default export is the screen');
});

// ------------------------------------------------------------------- pins

test('the section lazy-loads the new list; the tray springs with the kit and is never fixed; no invented duration; print styles load with the chunk', () => {
  const section = read('src/components/merchant/shell/sections/OrdersSection.tsx');
  assert.match(section, /lazy\(\(\) => import\('\.\.\/\.\.\/orders\/OrdersList'\)\)/);
  assert.match(section, /lazy\(\(\) => import\('\.\.\/\.\.\/orders\/OrderDetailScreen'\)\)/);
  assert.doesNotMatch(section, /import\('\.\.\/\.\.\/dashboard\/SalesTabs'\)/, 'the old tab no longer serves this section');

  const src = read('src/components/merchant/orders/OrdersList.tsx');
  assert.match(src, /role="toolbar"/);
  assert.match(src, /transition=\{m\.spring\('ui'\)\}/, 'the tray arrives on the ui spring');
  assert.match(src, /initial=\{\{ y: m\.travel\(16\), opacity: 0 \}\}/, 'and travels 0 under reduced motion');
  assert.match(src, /transition=\{m\.spring\('quick'\)\}/, 'the moved chip on the quick spring');
  assert.doesNotMatch(src, /className="[^"]*fixed bottom-0[^"]*"|\bfixed\b/, 'the tray is in flow, never fixed');
  assert.doesNotMatch(src, /transition=\{\{\s*duration/, 'no invented duration');
  assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|dark:/, 'tokens only, no hex, no dark: variants');
  assert.match(src, /import '\.\/orderPrint\.css'/);
  assert.match(src, /<DataList/);
  assert.match(src, /selection=\{\{/);
  assert.match(src, /rowActions=\{rowActions\}/);
  assert.match(src, /useOrdersStrings\(\)/);
  assert.doesNotMatch(src, /loc\(\s*'[^']*'\s*,\s*'[^']*'\s*\)/, 'no two-language loc() in the new screen: its words are in strings.ts');
  for (const rel of ['src/components/merchant/orders/OrdersList.tsx', 'src/components/merchant/orders/bulk.ts', 'src/components/merchant/orders/strings.ts']) {
    assert.doesNotMatch(read(rel), /window\.(confirm|alert|prompt)\(/, `${rel}: no native dialog`);
  }
});

// ---------------------------------------------------------------- payment

test('PAYMENT APART FROM STATUS: read from the order\'s own method (and what is due at the door), never written', () => {
  const kinds: Array<[Parameters<typeof orderPayment>[0], OrderPayment | null]> = [
    [{ payment_method_id: 'wallet' }, 'paid'],
    [{ payment_method_id: 'full_advance' }, 'paid'],
    [{ payment_method_id: 'cash' }, 'cod'],
    [{ payment_method_id: 'cash', due_on_delivery_iqd: 45_000 }, 'cod'],
    [{ payment_method_id: 'cash', due_on_delivery_iqd: 0 }, 'paid'],
    [{ payment_method_id: 'wallet', due_on_delivery_iqd: 5_000 }, 'cod'],
    [{ payment_method_id: 'bnpl' }, 'instalments'],
    [{ payment_method_id: 'gini', due_on_delivery_iqd: 5_000 }, 'instalments'],
    [{ payment_method_id: '' }, null],
    [{ payment_method_id: null }, null],
    [{ payment_method_id: 'something-new' }, null],
  ];
  for (const [o, want] of kinds) assert.equal(orderPayment(o), want, JSON.stringify(o));
  assert.equal(paymentMark({ status: 'cancelled', payment_method_id: 'wallet' }), null, 'a cancelled order\'s money went back');
  assert.equal(paymentMark({ status: 'pending', payment_method_id: 'wallet' }), 'paid');

  // Cash still to collect is the one that needs the merchant.
  assert.equal(orderPaymentTone('cod', 'shipped'), 'warning');
  assert.equal(orderPaymentTone('cod', 'delivered'), 'neutral');
  assert.equal(orderPaymentTone('paid', 'pending'), 'success');
  assert.equal(orderPaymentTone('paid', 'cancelled'), 'neutral');
  assert.equal(orderPaymentTone('instalments', 'pending'), 'neutral');

  // The words: three languages, real Sorani, none a copy of another.
  for (const p of ['paid', 'cod', 'instalments'] as const) {
    const [a, e, k] = (['ar', 'en', 'ckb'] as const).map((l) => orderPaymentLabel(p, locIn(l)));
    assert.ok(a && e && k);
    assert.notEqual(k, a, `${p}: ckb is the Arabic`);
    assert.notEqual(k, e, `${p}: ckb is the English`);
    assert.ok(KURDISH.test(k), `${p}: ckb is Sorani`);
  }

  // The list's cell: the chip, or a dash.
  const cols = orderColumns(ORDERS_STRINGS.en, 'en', (_ar: string, en: string) => en, () => null);
  const pay = cols.find((c) => c.id === 'payment')!;
  assert.equal(pay.header, 'Payment');
  const cell = (over: Partial<OrderListRow>) => html(pay.cell(row(over)));
  assert.match(cell({ payment_method_id: 'cash', status: 'shipped' }), /data-status-chip="warning"[\s\S]*data-payment-chip="cod"[^>]*>Cash on delivery</);
  assert.match(cell({ payment_method_id: 'cash', status: 'delivered' }), /data-status-chip="neutral"/);
  assert.match(cell({ payment_method_id: 'wallet' }), /data-status-chip="success"/);
  assert.match(cell({ payment_method_id: 'wallet' }), /<svg[^>]*aria-hidden="true"/, 'an icon, so the chip does not speak in colour alone');
  assert.doesNotMatch(cell({ payment_method_id: 'wallet' }), /h-1\.5 w-1\.5/, 'no dot: the status chip has one, this one does not');
  assert.equal(cell({ payment_method_id: 'wallet', status: 'cancelled' }), '—');
  assert.equal(cell({ payment_method_id: undefined }), '—');
});

test('the order screen\'s move verbs are the tray\'s, word for word, in every language', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    for (const to of ['confirmed', 'processing', 'shipped', 'delivered']) {
      assert.equal(orderMoveLabel(to, locIn(lang)), moveLabel(ORDERS_STRINGS[lang], to), `${lang} ${to}`);
    }
  }
});

test('THE LIST\'S STATE GOES TO THE ADDRESS: tab, search and depth arrive as props and every change goes back out; Back shows the last list at once', () => {
  const src = read('src/components/merchant/orders/OrdersList.tsx');
  assert.match(src, /const \[text, setText\] = useState\(initialQuery\);/, 'the search box opens on the address\'s search');
  assert.match(src, /const depth = useRef\(clampPages\(initialPages\)\);/, 'the first read goes as deep as the address says');
  assert.match(src, new RegExp(`const PAGES_MAX = ${LIST_PAGES_MAX};`), 'and never deeper than the address can say');
  assert.doesNotMatch(src, /import \{[^}]*\} from '\.\/ordersView'/, 'only a type from the address module: shared, it would be a chunk the shell names');
  assert.match(src, /readPages\(\(at\) => ordersListApi\.list\(listParams\(\{ status: filter, q, cursor: at \}\)\), depth\.current\)/);
  assert.match(src, /viewChange\.current\?\.\(\{ status: filter \|\| undefined, q: q \|\| undefined, pages: pages > 1 \? pages : undefined \}\)/);
  assert.match(src, /if \(key === written\.current\) return;/, 'only a real change is written — no loop with the address');
  // A new tab or a new search starts at one page again.
  const changeFilter = src.slice(src.indexOf('const changeFilter'), src.indexOf('};', src.indexOf('const changeFilter')));
  assert.match(changeFilter, /depth\.current = 1;\s+setPages\(1\);/);
  // The remembered list is this store's, in memory only (no storage API anywhere in the screen).
  assert.match(src, /const viewKey = \(store: string, status: string, q: string\)/);
  assert.match(src, /seen\.key === viewKey\(storeId, filter, q\) && seen\.pages === depth\.current/);
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB/);
  // The scroll depth comes back a frame after the shell has put the screen at its top.
  assert.match(src, /closest<HTMLElement>\('\[data-scroll-owner\]'\)/);
  assert.match(src, /window\.requestAnimationFrame\(\(\) => owner\.scrollTo\(\{ top \}\)\)/);
  assert.match(read('src/components/merchant/shell/MerchantShell.tsx'), /data-scroll-owner/, 'the shell still names its scroll owner');
});
