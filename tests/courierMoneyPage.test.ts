/**
 * «المال والأرباح» → المحاسبة → «أموال لدى شركة التوصيل» ON THE PAGE (src/components/financeWorkspace/CourierMoney.tsx;
 * the owner's brief, 2026-11-12, part 3; DECISIONS row 332).
 *
 * - The words keep the Sorani rules (DECISIONS row 183); the page's limit is the server's; the client reads the server's
 *   answer as it is (a compile-time check over courierOverview).
 * - Mounted in the small browser over a fixed answer: the three figures, the first-time note, the parcels oldest first.
 *   Ticking parcels opens the transfer: their cash less their fees, the amount that arrived prefilled with it; a different
 *   amount shows the difference and holds «سجّل التحويل» until a note says why; pressing it sends each parcel's cash and
 *   fee, the amount, the day, the statement number and the fee category, then reads again. A retry after a lost answer
 *   sends the same operation id. The first time, the ticked parcels can go as the opening balance instead. A received
 *   transfer is checked with «تمت المطابقة» → «تأكيد المطابقة»; a checked one says who checked it.
 *
 * Every figure is invented. Run: node --import tsx --test tests/courierMoneyPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choose, click, installDom, named, type, words, type FakeElement } from './fixtures/miniDom';
import { asD1, freshDb } from './fixtures/app';
import { courierOverview, MAX_REMITTANCE_PARCELS } from '../worker/lib/courierCollections';
import type { CourierOverview } from '../src/components/financeWorkspace/types';

const dom = installDom();
let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };

const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LanguageProvider } = await import('../src/LanguageContext');
const { default: CourierMoney, MAX_PARCELS } = await import('../src/components/financeWorkspace/CourierMoney');
const { CS } = await import('../src/components/financeWorkspace/courierStrings');

test('the words keep the Sorani rules; the page’s limit is the server’s; the client reads the server’s answer', async () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, [ar, en, ckb]] of Object.entries(CS)) {
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: no Arabic-only letter`);
    assert.equal(ph(ckb), ph(ar), `${key}: placeholders`);
    assert.equal(ph(en), ph(ar), `${key}: placeholders`);
  }
  assert.equal(MAX_PARCELS, MAX_REMITTANCE_PARCELS);
  const answer: CourierOverview = await courierOverview(asD1(freshDb()));
  assert.deepEqual([answer.pending.count, answer.first_time], [0, true]);
});

const parcel = (id: string, due: number, fee: number, day: string, days: number) =>
  ({ order_id: id, customer_name: `زبون ${id.slice(-1)}`, governorate: 'بغداد', tracking_no: '', delivered_day: day, days, due_iqd: due, fee_estimate_iqd: fee });
const OVERVIEW: CourierOverview = {
  pending: {
    parcels: [parcel('ORD-0D00000001', 55000, 5000, '2026-10-20', 23), parcel('ORD-0D00000002', 30000, 5000, '2026-11-03', 9), parcel('ORD-0D00000003', 3000, 5000, '2026-11-05', 7)],
    count: 3, due_iqd: 88000, fee_estimate_iqd: 13000, net_estimate_iqd: 75000, oldest_days: 23,
  },
  remittances: [],
  unreconciled: { count: 0, amount_iqd: 0 },
  first_time: true,
  fee_category: { id: 'fees' },
};
const TRANSFERS: CourierOverview['remittances'] = [
  { id: 'rem-2', kind: 'transfer', reference: 'Z-1002', received_day: '2026-11-10', amount_iqd: 49000, collected_iqd: 55000, fee_iqd: 5000, difference_iqd: -1000, parcels: 1, state: 'received', note: 'نقص', created_by_name: 'Owner', created_at: '2026-11-10T09:00:00.000Z', reconciled_by_name: null, reconciled_at: null, reconcile_note: '' },
  { id: 'rem-1', kind: 'opening', reference: 'رصيد افتتاحي', received_day: '2026-11-01', amount_iqd: 25000, collected_iqd: 30000, fee_iqd: 5000, difference_iqd: 0, parcels: 1, state: 'reconciled', note: '', created_by_name: 'Owner', created_at: '2026-11-01T09:00:00.000Z', reconciled_by_name: 'Owner', reconciled_at: '2026-11-02T09:00:00.000Z', reconcile_note: '' },
];

interface Sent { method: string; url: string; body: Record<string, unknown> | null }
function serve(overview: CourierOverview, opts: { failPosts?: number } = {}) {
  const sent: Sent[] = [];
  let failures = opts.failPosts ?? 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    const ok = (b: unknown) => new Response(JSON.stringify({ success: true, ...(b as object) }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('expense-categories')) return ok({ categories: [{ id: 'fees', slug: 'fees', name_ar: 'أجور التوصيل', name_en: 'Courier fees', name_ckb: '', active: true }, { id: 'rent', slug: 'rent', name_ar: 'إيجار', name_en: 'Rent', name_ckb: '', active: true }] });
    if (method === 'POST') {
      if (failures > 0) { failures--; throw new TypeError('Failed to fetch'); }
      return ok(url.endsWith('/reconcile') ? { already: false } : { already: false, id: (JSON.parse(String(init!.body)) as { operation_id: string }).operation_id, parcels: 1 });
    }
    if (/\/courier\/remittances\//.test(url)) return ok({ remittance: TRANSFERS[0], parcels: [{ ...parcel('ORD-0D00000009', 55000, 5000, '2026-11-01', 12), collected_iqd: 55000, fee_iqd: 5000, net_iqd: 50000 }] });
    return ok(overview);
  }) as typeof fetch;
  return sent;
}
async function mount(lang: 'ar' | 'en' | 'ckb', opened: string[] = [], changed: string[] = []) {
  LANG = lang;
  const container = dom.container();
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(h(LanguageProvider, null, h(CourierMoney, { onOpenOrder: (id: string) => opened.push(id), onChanged: () => changed.push('changed') }))); });
  const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setImmediate(r)); }); };
  await settle();
  return { container, settle, unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); LANG = 'ar'; } };
}
const q = (c: FakeElement, sel: string) => c.querySelector(sel) as unknown as FakeElement;
const qa = (c: FakeElement, sel: string) => c.querySelectorAll(sel) as unknown as FakeElement[];
const tick = async (page: Awaited<ReturnType<typeof mount>>, id: string) => {
  await act(async () => { click(q(page.container, `tr[data-courier-parcel="${id}"] input[data-courier-pick]`)); });
  await page.settle();
};

test('the three figures, the first-time note and the parcels, oldest first; an order opens its sheet', async () => {
  serve(OVERVIEW);
  const opened: string[] = [];
  const page = await mount('ar', opened);
  assert.match(words(q(page.container, '[data-courier-due]')), /88,000/);
  assert.match(words(q(page.container, '[data-courier-due]')), /3 طرد · أقدمها منذ 23 يومًا/);
  assert.match(words(q(page.container, '[data-courier-net]')), /75,000/);
  assert.match(words(q(page.container, '[data-courier-howto]')), /أول مرة هنا/);
  assert.deepEqual(qa(page.container, 'tr[data-courier-parcel]').map((r) => r.getAttribute('data-courier-parcel')), ['ORD-0D00000001', 'ORD-0D00000002', 'ORD-0D00000003']);
  assert.match(words(q(page.container, 'tr[data-courier-parcel="ORD-0D00000003"]')), /3,000.*3,000.*0/, 'a fee never above the cash');
  await act(async () => { click(named(page.container, 'button', 'ORD-0D00000002')); });
  assert.deepEqual(opened, ['ORD-0D00000002']);
  assert.equal(q(page.container, '[data-courier-form]'), null, 'no form until a parcel is ticked');
  assert.match(words(q(page.container, '[data-courier-no-transfers]')), /لم يُسجَّل أي تحويل بعد/);
  await page.unmount();
});

test('a transfer: ticked parcels, their cash less fees, a difference that needs its note, then what is sent', async () => {
  const sent = serve(OVERVIEW);
  const changed: string[] = [];
  const page = await mount('ar', [], changed);
  await tick(page, 'ORD-0D00000001');
  await tick(page, 'ORD-0D00000002');
  const form = q(page.container, '[data-courier-form]');
  assert.match(words(form), /المحدَّد: 2 طرد/);
  assert.match(words(form), /75,000/, 'their cash less their fees');
  const amount = q(page.container, 'input[data-courier-amount]');
  assert.equal(amount.value, '75000', 'the amount that arrived starts as what should arrive');
  assert.equal((q(page.container, 'select[data-courier-category]')).value, 'fees', 'the last fee category');
  // Al-Zaeem's invoice says the second parcel's fee was 6,000, and 73,000 arrived.
  await act(async () => { type(q(page.container, 'tr[data-courier-parcel="ORD-0D00000002"] input[data-courier-fee]'), '6000'); });
  await act(async () => { type(amount, '73,000'); });
  await page.settle();
  assert.match(words(q(page.container, '[data-courier-difference]')), /-1,000|−1,000/);
  const record = named(page.container, 'button', 'سجّل التحويل');
  assert.equal(record.disabled, true, 'a difference needs its note');
  await act(async () => { type(q(page.container, 'input[data-courier-note]'), 'خصم أجرة طرد مدفوع مسبقًا'); });
  await act(async () => { type(q(page.container, 'input[data-courier-reference]'), 'Z-1003'); });
  await page.settle();
  assert.equal(record.disabled, false);
  await act(async () => { click(record); });
  await page.settle();
  const post = sent.find((s) => s.method === 'POST')!;
  assert.match(post.url, /\/api\/admin\/finance-workspace\/courier\/remittances$/);
  const { operation_id, received_day, ...rest } = post.body!;
  assert.match(String(operation_id), /^[0-9a-f-]{36}$/);
  assert.match(String(received_day), /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(rest, { kind: 'transfer', reference: 'Z-1003', amount_iqd: 73000, note: 'خصم أجرة طرد مدفوع مسبقًا', category_id: 'fees',
    parcels: [{ order_id: 'ORD-0D00000001', collected_iqd: 55000, fee_iqd: 5000 }, { order_id: 'ORD-0D00000002', collected_iqd: 30000, fee_iqd: 6000 }] });
  assert.match(words(q(page.container, '[data-courier-message]')), /سُجّل: 2 طرد/);
  assert.equal(sent.filter((s) => s.method === 'GET' && /\/courier$/.test(s.url)).length, 2, 'read again');
  assert.deepEqual(changed, ['changed']);
  await page.unmount();
});

test('a retry after a lost answer sends the same operation id', async () => {
  const sent = serve(OVERVIEW, { failPosts: 1 });
  const page = await mount('en');
  await tick(page, 'ORD-0D00000002');
  const record = named(page.container, 'button', 'Record the transfer');
  await act(async () => { click(record); });
  await page.settle();
  assert.ok(q(page.container, '[data-courier-error]'), 'the failure is said');
  await act(async () => { click(record); });
  await page.settle();
  const posts = sent.filter((s) => s.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body!.operation_id, posts[1].body!.operation_id);
  await page.unmount();
});

test('the first time, the ticked parcels can go as the opening balance', async () => {
  const sent = serve(OVERVIEW);
  const page = await mount('ar');
  await act(async () => { click(q(page.container, 'input[data-courier-pick-all]')); });
  await page.settle();
  await act(async () => { choose(q(page.container, 'select[data-courier-category]'), 'rent'); });
  await act(async () => { click(named(page.container, 'button', 'سجّل كرصيد افتتاحي')); });
  await page.settle();
  const post = sent.find((s) => s.method === 'POST')!;
  assert.equal(post.body!.kind, 'opening');
  assert.equal(post.body!.category_id, 'rent');
  assert.deepEqual((post.body!.parcels as Array<{ order_id: string }>).map((p) => p.order_id), ['ORD-0D00000001', 'ORD-0D00000002', 'ORD-0D00000003']);
  await page.unmount();
});

test('a received transfer is checked once; a checked one says who checked it; a transfer opens its parcels', async () => {
  const sent = serve({ ...OVERVIEW, first_time: false, remittances: TRANSFERS, unreconciled: { count: 1, amount_iqd: 49000 } });
  const page = await mount('en');
  assert.match(words(q(page.container, '[data-courier-howto]')), /When a transfer arrives/);
  assert.equal(q(page.container, '[data-courier-opening]'), null);
  assert.match(words(q(page.container, '[data-courier-unchecked]')), /49,000.*1 transfers/);
  assert.match(words(q(page.container, 'tr[data-courier-transfer="rem-1"]')), /Opening balance.*Checked by Owner on 2026-11-02/);
  await act(async () => { click(q(page.container, 'tr[data-courier-transfer="rem-2"] button[data-courier-reconcile]')); });
  await page.settle();
  await act(async () => { type(q(page.container, 'input[data-courier-reconcile-note]'), 'matches statement Z-1002'); });
  await act(async () => { click(named(page.container, 'button', 'Confirm the check')); });
  await page.settle();
  const post = sent.find((s) => s.method === 'POST')!;
  assert.match(post.url, /\/courier\/remittances\/rem-2\/reconcile$/);
  assert.deepEqual(post.body, { note: 'matches statement Z-1002' });
  await act(async () => { click(named(page.container, 'button', /1 · Parcels/)); });
  await page.settle();
  assert.match(words(q(page.container, '[data-courier-transfer-parcels]')), /ORD-0D00000009.*50,000/);
  await page.unmount();
});
