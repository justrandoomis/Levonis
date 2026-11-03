/**
 * «التالي» SAYS WHY IT CANNOT MOVE (owner report 2026-11-03: «لا أستطيع الضغط على التالي أو إضافة السعر بعد
 * الخصم»; «حسّن نظام التبويبات»).
 *
 * The purchase wizard greyed out «التالي» and its step tabs with no reason (an item without its raw supplier
 * price looked like any other problem), the after-discount field said «انشر أسعار المنتج أولًا» for every
 * reason it was shut, and the inventory tabs were chips with three competing selected states and no address.
 * Pinned here: the blocker list names each missing field by item and step, the buttons keep their gates but
 * speak, the sale field names its real reason, and the tabs are tabs.
 *
 * Run: node --import tsx --test tests/purchaseBlockers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockersUpTo, purchaseBlockers, purchaseBlockerStrings, type PurchaseCheckInput, type PurchaseLineCheck } from '../src/components/adminOperations/purchaseBlockers';

const ROOT = join(import.meta.dirname, '..');
const src = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const line = (over: Partial<PurchaseLineCheck> = {}): PurchaseLineCheck => ({
  label: 'Bambu Lab P1S · P1S AMS 2 Combo',
  key: 'purchase-line-0',
  quantity: true,
  invoiced: true,
  origins: true,
  raw: true,
  rawMode: 'unit',
  packed: true,
  pendingPrice: false,
  ...over,
});
const input = (over: Partial<PurchaseCheckInput> = {}): PurchaseCheckInput => ({
  nameValid: true,
  funding: [],
  lines: [line()],
  trackedOverLimit: false,
  currency: 'EUR',
  exchangeRateValid: true,
  freightRateValid: true,
  basis: 'weight',
  rate: 'ok',
  rateConfirmed: false,
  rateMissingText: 'RATE MISSING',
  rateFarText: 'RATE FAR',
  charges: [],
  serialsOverLimit: false,
  serialsNeedFinal: false,
  totalsValid: true,
  ...over,
});

test('a complete purchase has nothing to fix', () => {
  assert.deepEqual(purchaseBlockers(input(), 'en'), []);
});

test('the owner’s case: an item without its raw supplier price is named, on the costs step, with its field', () => {
  const [b, ...rest] = purchaseBlockers(input({ lines: [line({ raw: false })] }), 'ar');
  assert.equal(rest.length, 0);
  assert.equal(b!.step, 2);
  assert.equal(b!.target, 'purchase-line-0-raw');
  assert.match(b!.text, /سعر شراء القطعة الخام من المورد/);
  assert.match(b!.text, /P1S AMS 2 Combo/, 'the item is named');
  // A line typed as a total asks for the total.
  assert.match(purchaseBlockers(input({ lines: [line({ raw: false, rawMode: 'total' })] }), 'en')[0]!.text, /purchase total/);
});

test('each check of the gate has its own sentence, in step order', () => {
  const all = purchaseBlockers(input({
    nameValid: false,
    funding: ['account', 'profit'],
    lines: [line({ quantity: false, invoiced: false, origins: false, raw: false, packed: false, pendingPrice: true })],
    exchangeRateValid: false,
    freightRateValid: false,
    rate: 'far',
    charges: [{ title: 'توصيل', problems: ['amount'] }],
    serialsNeedFinal: true,
  }), 'en');
  const ids = all.map((b) => b.id);
  assert.deepEqual(ids, ['name', 'funding:account', 'funding:profit', 'purchase-line-0:qty', 'purchase-line-0:invoiced', 'purchase-line-0:origins', 'exchange', 'rate-far', 'freight', 'purchase-line-0:raw', 'purchase-line-0:packed', 'charge:0', 'serials-final', 'purchase-line-0:price']);
  const steps = all.map((b) => b.step);
  assert.deepEqual([...steps].sort(), steps, 'the earliest step first');
  assert.equal(all.find((b) => b.id === 'rate-far')!.text, 'RATE FAR', 'the rate refusal is the contract’s own sentence');
  // Each reason goes to the field it names: the amount (not the expense’s first field), the invoice quantity
  // (not the ordered one), the unit references, the funding field.
  assert.equal(all.find((b) => b.id === 'charge:0')!.target, 'purchase-charge-0-amount');
  assert.equal(all.find((b) => b.id === 'purchase-line-0:invoiced')!.target, 'purchase-line-0-invoiced');
  assert.equal(all.find((b) => b.id === 'purchase-line-0:origins')!.target, 'purchase-line-0-origins');
  assert.equal(all.find((b) => b.id === 'funding:profit')!.target, 'purchase-funding-profit');
  assert.equal(all.find((b) => b.id === 'purchase-line-0:price')!.target, 'purchase-line-0-pricing');
  // «التالي» on a step waits only for what is fixed there or before.
  assert.deepEqual(blockersUpTo(all, 0).map((b) => b.id), ['name', 'funding:account', 'funding:profit']);
  assert.deepEqual(blockersUpTo(all, 1).map((b) => b.id), ['name', 'funding:account', 'funding:profit', 'purchase-line-0:qty', 'purchase-line-0:invoiced', 'purchase-line-0:origins']);
});

test('an expense with no name yet is called that, never «»', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const [b] = purchaseBlockers(input({ charges: [{ title: '  ', problems: ['review'] }] }), lang);
    assert.doesNotMatch(b!.text, /«»|“”/, lang);
  }
  assert.match(purchaseBlockers(input({ charges: [{ title: '', problems: ['review'] }] }), 'ar')[0]!.text, /بلا اسم/);
});

test('the funding gate is the old expression, named check by check', async () => {
  const { fundingProblems, fundingValid, newFunding } = await import('../src/components/adminOperations/PurchaseFundingFields');
  const store = newFunding();
  assert.deepEqual(fundingProblems(store), []);
  assert.equal(fundingValid(store), true);
  const investor = { ...store, mode: 'investor' as const };
  assert.deepEqual(fundingProblems(investor), ['account', 'agreed']);
  const ok = { ...investor, user_id: 'u1', agreed_iqd: 500000 };
  assert.equal(fundingValid(ok), true);
  assert.deepEqual(fundingProblems({ ...ok, profit_share_bps: 10001 }), ['profit']);
  assert.deepEqual(fundingProblems({ ...ok, loss_share_bps: -1 }), ['loss']);
  assert.deepEqual(fundingProblems({ ...ok, received_iqd: 1000 }), ['reference'], 'money received needs its reference');
  assert.deepEqual(fundingProblems({ ...ok, received_iqd: 1000, reference: 'TX1' }), []);
  assert.deepEqual(fundingProblems({ ...ok, received_iqd: 1.5 }), ['received', 'reference']);
  assert.equal(fundingValid({ ...ok, received_iqd: 1.5 }), false);
});

test('no items at all asks for one; a confirmed far rate, an IQD document and no route ask nothing', () => {
  assert.deepEqual(purchaseBlockers(input({ lines: [] }), 'en').map((b) => b.id), ['lines']);
  assert.deepEqual(purchaseBlockers(input({ rate: 'far', rateConfirmed: true }), 'en'), []);
  assert.deepEqual(purchaseBlockers(input({ currency: 'IQD', exchangeRateValid: false }), 'en'), []);
  assert.deepEqual(purchaseBlockers(input({ freightRateValid: null, lines: [line({ packed: null })] }), 'en'), []);
  assert.deepEqual(purchaseBlockers(input({ rate: 'missing' }), 'en').map((b) => b.text), ['RATE MISSING']);
});

test('every sentence exists in Arabic, English and Sorani, and the Sorani is never the Arabic (row 183)', () => {
  const everything = input({
    nameValid: false, funding: ['account', 'agreed', 'received', 'profit', 'loss', 'reference'], trackedOverLimit: true, exchangeRateValid: false, freightRateValid: false,
    lines: [line({ quantity: false, invoiced: false, origins: false, raw: false, packed: false, pendingPrice: true }), line({ key: 'purchase-line-1', raw: false, rawMode: 'total' })],
    charges: [{ title: 'x', problems: ['review'] }, { title: '', problems: ['title'] }, { title: 'y', problems: ['lines'] }, { title: 'z', problems: ['basis'] }],
    serialsOverLimit: true, serialsNeedFinal: true, totalsValid: false,
  });
  const ar = purchaseBlockers(everything, 'ar');
  const en = purchaseBlockers(everything, 'en');
  const ckb = purchaseBlockers(everything, 'ckb');
  assert.equal(ar.length, en.length);
  assert.equal(ar.length, ckb.length);
  ckb.forEach((b, i) => {
    assert.notEqual(b.text, ar[i]!.text, b.id);
    assert.doesNotMatch(b.text.replace(/«[^»]*»/g, ''), /[ةىيك]/, `${b.id}: an Arabic-only letter in the Sorani`);
  });
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const s = purchaseBlockerStrings(lang);
    assert.ok(s.title && s.confirmTitle && s.go && s.generic && s.required && s.quantity && s.invoiced && s.more(2).includes('2'));
  }
  assert.doesNotMatch(Object.values(purchaseBlockerStrings('ckb')).filter((v) => typeof v === 'string').join(' '), /[ةىيك]/);
});

test('the wizard: «التالي» and the confirm keep their gates but are never silently grey, and the dock lists why', () => {
  const panel = src('src/components/adminOperations/ProcurementPanel.tsx');
  // The gates are the old expressions, kept whole.
  assert.match(panel, /const nextBlocked = !nameValid \|\| !fundingValid\(funding\) \|\| \(step > 0 && \(!quantitiesValid \|\| !originsValid\)\) \|\| \(step === 2 && \(!costsValid \|\| !draftSerialsValid \|\| !rateReady \|\| pendingInlinePrices\)\);/);
  assert.match(panel, /fundingNeedsFinalCost \|\| !rateReady \|\| \(quickReceive && header\.cost_state !== 'final'\)/);
  // A blocked button stays pressable (aria-disabled) and its press says why instead of doing nothing.
  assert.match(panel, /aria-disabled=\{nextBlocked \|\| undefined\} onClick=\{goNext\}/);
  assert.match(panel, /aria-disabled=\{confirmBlocked \|\| undefined\}/);
  assert.doesNotMatch(panel, /disabled=\{op\.busy \|\| !nameValid \|\| !fundingValid\(funding\)/, 'the old silent disable is gone');
  assert.match(panel, /data-purchase-blockers/);
  assert.match(panel, /className="inventory-footer inventory-dock"/, 'the dock is still the footer the e2e scripts find');
  // Steps: back is open, a locked step lands on the first thing to fix.
  assert.match(panel, /onClick=\{\(\) => goStep\(i\)\}/);
  assert.match(panel, /aria-disabled=\{locked \|\| undefined\}/);
  // «اذهب» reaches the fields by id.
  for (const id of ['purchase-line-${i}-raw', 'purchase-line-${i}-packed', 'purchase-line-${i}-qty', 'purchase-line-${i}-invoiced', 'purchase-line-${i}-origins', 'purchase-line-${i}-pricing', 'purchase-charge-${i}', 'purchase-charge-${i}-title', 'purchase-charge-${i}-amount', 'purchase-charge-${i}-basis', 'purchase-charge-${i}-lines']) assert.ok(panel.includes(`id={\`${id}\`}`), id);
  for (const id of ['purchase-name', 'purchase-rate', 'purchase-freight', 'purchase-rate-confirm', 'purchase-cost-state', 'purchase-add-item']) assert.ok(panel.includes(`id="${id}"`), id);
  const funding = src('src/components/adminOperations/PurchaseFundingFields.tsx');
  for (const id of ['account', 'agreed', 'profit', 'received', 'reference', 'loss']) assert.ok(funding.includes(`id="purchase-funding-${id}"`), id);
  // The name sits on every step: «اذهب» reaches it where it is, never back on step 1.
  assert.match(panel, /if \(b\.step !== step && !\(b\.target && document\.getElementById\(b\.target\)\)\) setStep\(b\.step\);/);
  // The visible list changes with each keystroke, so it is not a live region; one announcement speaks for a press.
  assert.doesNotMatch(panel, /data-purchase-blockers[^>]*role=|role=\{attempted/);
  assert.match(panel, /className="sr-only" role="alert" data-purchase-announce/);
  // The confirm’s final-cost reason is said on step 2 beside «حالة التكلفة».
  assert.match(panel, /data-purchase-final-cost/);
  const css = src('src/components/adminInventory/inventory-workspace.css');
  assert.match(css, /\.inventory-dock \{ position: sticky; bottom: 0;[^}]*flex-wrap: nowrap;/, 'a wrapping column would carry the buttons off a phone screen');
  assert.match(css, /\.inventory-dock > \.inventory-blockers \{ flex: 0 1 auto; min-height: 0; overflow-y: auto; \}/, 'only the list gives way and scrolls');
  assert.match(css, /\.inventory-sticky-summary \{ position: static;/, 'one sticky element at the bottom, not two on top of each other');
});

test('the after-discount field names its real reason and opens the pricing settings', () => {
  const sale = src('src/components/adminOperations/InlineSaleDiscount.tsx');
  assert.match(sale, /reason === 'NOT_DIRECT'/);
  assert.match(sale, /reason === 'MIXED_PRICES'/);
  assert.match(sale, /reason === 'OWNER_ONLY'/);
  assert.match(sale, /هذا الخيار يُباع اليوم بالطلب المسبق فقط/);
  assert.match(sale, /loc\('فتح إعدادات التسعير', 'Open pricing settings', 'کردنەوەی ڕێکخستنەکانی نرخدان'\)/);
});

test('the inventory tabs are tabs: one selected, roving focus, a panel, and the address keeps the tab', () => {
  const inv = src('src/components/adminInventory/AdminInventory.tsx');
  assert.match(inv, /role="tablist"/);
  assert.match(inv, /role="tabpanel" aria-labelledby=\{`inventory-tab-\$\{current\}`\}/);
  assert.match(inv, /aria-selected=\{current === x\.id\}/);
  assert.match(inv, /tabIndex=\{current === x\.id \? 0 : -1\}/);
  assert.doesNotMatch(inv, /aria-pressed=\{tab === x\.id\}/, 'one selected state, not three');
  assert.match(inv, /get\('itab'\)/);
  assert.match(inv, /url\.searchParams\.set\('itab', tab\)/);
  assert.match(inv, /window\.history\.replaceState/);
  // The legacy list is last.
  const order = ["id: 'stock'", "id: 'procurement'", "id: 'operations'", "id: 'movements'", "id: 'reports'", "id: 'suppliers'", "id: 'incoming'"];
  order.reduce((at, needle) => { const i = inv.indexOf(needle, at); assert.ok(i > at, needle); return i; }, inv.indexOf('const tabs: {'));
});
