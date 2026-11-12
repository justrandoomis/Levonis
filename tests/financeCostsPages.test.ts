/**
 * «المال والأرباح» → التكاليف — THE PAGES (redesign step 5, owner 2026-11-11; DECISIONS row 317).
 *
 * What the client works out is pure and held here: a missing-cost group's sale-time estimate as one range (or none), the
 * promotion's percent column adding up to exactly 100 after rounding, the period's entries grouped by where they count and
 * the general ones by category. Every new word is in Arabic, English and real Sorani (DECISIONS row 183), and no sentence of
 * the promotion page speaks of pieces or units — the month's promotion is shared by sales value (row 313). Then the pages as
 * the owner reads them, drawn on the server's own answers for invented worlds: «23 بندًا»-style headers that agree with their
 * number, the missing-cost card with its range or «لا تقدير ولا سعر», who carries the promotion adding up to the month, its
 * history in words, the general expenses whose total is the statement's line and whose other entries say where they count,
 * the drawer's general line listing its entries, and the promotion's month following the period.
 *
 * The independent review of step 5 added: a page and a drawer past the server's limit (their emptiness, bars and headings
 * from the totals; a cut list saying so), voided entries brought back only where they are owned, a month closed in
 * accounting offering no edit, an edit sending only what changed, refusals in the reader's language, a card naming its
 * unpriced lines beside a range, the promotion's form only on its own month's answer, labels that say «as invoiced», a past
 * month with no sales, a gift month, a moved promotion, no letter glued to a placeholder, the drawer in dollars, and the
 * ledger's embedded form in the reader's language.
 *
 * Every figure here is invented (DECISIONS row 316: no live order, day or amount in the repository).
 * Run: node --import tsx --test tests/financeCostsPages.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LanguageProvider } from '../src/LanguageContext';
import { CS, COUNTED, counted, refusalWords } from '../src/components/financeWorkspace/costsStrings';
import { estimateRange, percentText, promotionTable, rangeFigures, sharePercents } from '../src/components/financeWorkspace/costFigures';
import { categoryName, categoryShares, editableHere, editPatch, ELSEWHERE, entryDraft, groupEntries, inClosedMonth, KIND_LABEL, movedFields, rebaseDraft, type ExpenseEntryRow, type ExpenseKind, type ExpensesAnswer } from '../src/components/financeWorkspace/expenseKinds';
import { ApiError } from '../src/lib/api';
import { PA_STRINGS } from '../src/components/financeWorkspace/displayCurrencyStrings';
import { amountText } from '../src/components/financeWorkspace/Reports';
import { monthText } from '../src/components/financeWorkspace/overviewStrings';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import type { FinanceSummary } from '../src/components/financeWorkspace/types';
import type { PromotionsAnswer } from '../src/components/financeWorkspace/PromotionPage';
import { everyState, month, order, period, previousMonth, world } from './fixtures/financeWorld';
import { crowdedWorld, expenseWorld } from './fixtures/financeCosts';
import { json, patch, post, send, stubApp, type App } from './fixtures/app';
import { codeOf } from './fixtures/source';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { baghdadDay } from '../worker/lib/operations';
import { dayParts } from '../worker/lib/baghdadTime';

let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
// The workspace imports its stylesheet; node has no CSS loader (as tests/financeOverviewFigures.test.ts).
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
  return next(specifier, context);
}`));
const { default: FinanceWorkspace } = await import('../src/components/financeWorkspace/FinanceWorkspace');
const { MissingGroup, groupMissing } = await import('../src/components/financeWorkspace/MissingCostsSheet');
const { default: PromotionPage, Carriers, History, editText } = await import('../src/components/financeWorkspace/PromotionPage');
const { default: ExpenseLedger } = await import('../src/components/adminFinance/ExpenseLedger');
const { financeStrings } = await import('../src/components/adminFinance/strings');
const { ExpensesView, GeneralEntryList } = await import('../src/components/financeWorkspace/GeneralExpenses');
const { FigureBody } = await import('../src/components/financeWorkspace/FigureDrawer');

const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/, ARABIC_ONLY = /[ةىيك]/;
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const draw = (node: ReactNode, lang: 'ar' | 'en' | 'ckb' = 'ar') => { LANG = lang; try { return renderToStaticMarkup(createElement(LanguageProvider, null, node)); } finally { LANG = 'ar'; } };
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const noop = () => {};

// ------------------------------------------------------------------ pure

test('a group\'s sale-time estimates are one range — lowest to highest, one figure when they agree, none when there is none', () => {
  assert.deepEqual(estimateRange([12500, 12000, 12250]), { min: 12000, max: 12500 });
  assert.equal(rangeFigures(estimateRange([12500, 12000])!), '12,000–12,500');
  assert.equal(rangeFigures(estimateRange([40])!), '40');
  assert.equal(estimateRange([]), null);
  // groupMissing keeps each distinct estimate of a group (tests/personFinanceView.test.ts pins it); the range reads them.
  const line = (id: string, estimate: number | null) => ({ order_id: id, version: 1, delivered_at: null, customer_name: null, line_id: `${id}:l`, product_id: 'esun', name: 'Filament', option: 'Grey', color: null, qty: 1, confidence: 'estimated', estimate_unit_iqd: estimate, cogs_iqd: estimate });
  const [g] = groupMissing([line('a', 12500), line('b', 12000), line('c', 12500)]);
  assert.equal(rangeFigures(estimateRange(g.estimates)!), '12,000–12,500');
});

test('the promotion\'s percent column adds up to exactly 100 after rounding, the largest remainders taking what is left', () => {
  for (const values of [[1, 1, 1], [2, 1], [999_000, 1_000, 500, 250, 125, 125], [7, 7, 7, 7, 7, 7, 7], [1_000_000, 3], [5]]) {
    const p = sharePercents(values);
    assert.equal(Math.round(p.reduce((a, b) => a + b, 0) * 10), 1000, `${values}: ${p}`);
    p.forEach((x, i) => assert.ok(Math.abs(x - (100 * values[i]) / values.reduce((a, b) => a + b, 0)) <= 0.1 + 1e-9, `${values}[${i}] within a tenth`));
  }
  assert.deepEqual(sharePercents([1, 1, 1]), [33.4, 33.3, 33.3]);
  assert.deepEqual(sharePercents([0, 0]), [0, 0], 'nothing to share');
  assert.deepEqual(sharePercents([3, -1, 1]), [75, 0, 25], 'nothing below 0');
  assert.equal(percentText(33.3), '33.3%');
  // The table: rows with their percent, and totals that are the rows' own.
  const t = promotionTable([{ name: 'Printer', qty: 2, sales_iqd: 2_000_000, promotion_iqd: 9_901 }, { name: 'Switch', qty: 100, sales_iqd: 20_000, promotion_iqd: 99 }]);
  assert.deepEqual(t.total, { qty: 102, sales_iqd: 2_020_000, promotion_iqd: 10_000 });
  assert.deepEqual(t.rows.map((r) => r.percent), [99, 1]);
  // A month whose lines all sold at 0 (gifts): the server shares it equally by line; the percents follow those shares.
  assert.deepEqual(promotionTable([{ qty: 1, sales_iqd: 0, promotion_iqd: 300 }, { qty: 3, sales_iqd: 0, promotion_iqd: 100 }]).rows.map((r) => r.percent), [75, 25]);
});

const row = (id: string, kind: ExpenseKind, amount: number, extra: Partial<ExpenseEntryRow> = {}): ExpenseEntryRow => ({ id, expense_day: '2026-03-04', amount_iqd: amount, title: id, note: '', series_id: null,
  category_id: 'rent', category: { name_ar: 'إيجار', name_en: 'Rent', name_ckb: 'کرێی شوێن' }, kind, counts_as_general: kind === 'general' || kind === 'order_ended',
  order_id: null, order_status: null, promotion_month: null, center_id: null, center_name: null, voided: false, void_reason: '', ...extra });

test('the entries are grouped by where they count: the general ones apart, the rest by kind in the page\'s order, the voided in no sum', () => {
  const rows = [row('rent', 'general', 100), row('fee', 'collection_fee', 3), row('promo', 'promotion', 50), row('gone', 'order_ended', 20), row('wage', 'order_cost', 7),
    row('wrap', 'order_delivered', 2), row('customs', 'order_waiting', 9), row('customs2', 'order_waiting', 1), row('void', 'general', 999, { voided: true })];
  const g = groupEntries(rows);
  assert.deepEqual(g.general.map((r) => r.id), ['rent', 'gone'], 'the cancelled order\'s cost is a general expense since step 1');
  assert.deepEqual(g.elsewhere.map((x) => [x.kind, x.rows.map((r) => r.id), x.amount_iqd]), [['promotion', ['promo'], 50], ['order_cost', ['wage'], 7], ['collection_fee', ['fee'], 3], ['order_delivered', ['wrap'], 2], ['order_waiting', ['customs', 'customs2'], 10]]);
  assert.deepEqual(g.voided.map((r) => r.id), ['void']);
  assert.deepEqual(ELSEWHERE, ['promotion', 'order_cost', 'collection_fee', 'order_delivered', 'order_waiting']);
  assert.deepEqual((['general', 'order_ended', 'promotion', 'order_cost', 'collection_fee', 'order_delivered', 'order_waiting'] as ExpenseKind[]).map(editableHere), [true, true, false, false, false, true, true],
    'the promotion, an order\'s wage and a courier\'s fee are edited at their source');
  // By category: shares of the general total, the percents adding up to 100.
  const shares = categoryShares([{ category_id: 'rent', name_ar: 'إيجار', name_en: 'Rent', name_ckb: 'کرێی شوێن', amount_iqd: 2, entries: 1 }, { category_id: 'power', name_ar: 'كهرباء', name_en: '', name_ckb: '', amount_iqd: 1, entries: 2 }]);
  assert.deepEqual(shares.map((c) => [c.category_id, Number(c.share.toFixed(4)), c.percent]), [['rent', 0.6667, 66.7], ['power', 0.3333, 33.3]]);
  assert.equal(categoryName('ckb', shares[0]), 'کرێی شوێن');
  assert.equal(categoryName('en', shares[1]), 'كهرباء', 'a name never written in English stands in Arabic');
});

// ------------------------------------------------------------------ words

test('every new word of the costs section is in Arabic, English and real Sorani, with the same placeholders (DECISIONS row 183)', () => {
  for (const [key, [ar, en, ckb]] of Object.entries(CS)) {
    for (const s of [ar, en, ckb]) assert.ok(s.trim() === s && s.length > 0, key);
    assert.notEqual(ckb, ar, `${key}: the Sorani is the Arabic`);
    assert.notEqual(ckb, en, `${key}: the Sorani is the English`);
    assert.match(ckb, SORANI_ONLY, `${key}: «${ckb}» has no Sorani letter`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: «${ckb}» has an Arabic-only letter`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: the English is English`);
    assert.equal(holes(en), holes(ar), `${key}: English placeholders`);
    assert.equal(holes(ckb), holes(ar), `${key}: Sorani placeholders`);
  }
  for (const [key, c] of Object.entries(COUNTED)) {
    assert.match(c.ckb, SORANI_ONLY, key);
    assert.doesNotMatch(c.ckb, ARABIC_ONLY, key);
    assert.ok(!c.ar.includes(c.ckb as never), key);
    assert.equal(holes(c.ckb), 'n', key);
    assert.equal(holes(c.en[1]), 'n', key);
  }
  // A count agrees with its noun in Arabic; English has one and many; Sorani keeps the noun (invented counts).
  assert.deepEqual([1, 2, 3, 10, 11, 23, 100, 101, 1200].map((n) => counted('ar', 'lines', n)), ['بند واحد', 'بندان', '3 بنود', '10 بنود', '11 بندًا', '23 بندًا', '100 بند', '101 بند', '1,200 بند']);
  assert.equal(counted('ar', 'missingHead', 23), '23 بندًا بلا تكلفة مؤكدة', 'the mockup\'s header');
  assert.deepEqual([counted('en', 'pieces', 1), counted('en', 'pieces', 24), counted('ckb', 'orders', 2)], ['1 piece', '24 pieces', '2 داواکاری']);
  assert.deepEqual([2, 3].map((n) => counted('ar', 'linesNoPrice', n)), ['بندان بلا تقدير ولا سعر', '3 بنود بلا تقدير ولا سعر']);
});

test('no letter is glued to a placeholder: a Sorani suffix after an amount read «د.عەوە» (the independent review of step 5)', () => {
  const glued = /\}\p{L}|\p{L}\{/u;
  const slots = [...Object.entries(CS).flatMap(([key, tri]) => tri.map((s, i) => [`${key}.${['ar', 'en', 'ckb'][i]}`, s] as const)),
    ...Object.entries(COUNTED).flatMap(([key, c]) => [...c.ar, ...c.en, c.ckb].map((s) => [key, s] as const)),
    ...Object.entries(PA_STRINGS).filter(([key]) => key.startsWith('promotion')).flatMap(([key, t]) => Object.values(t).map((s) => [key, String(s)] as const))];
  for (const [key, s] of slots) assert.doesNotMatch(s, glued, `${key}: «${s}»`);
  // Drawn with an amount: the history of a dinar promotion, and a period across two months, in Sorani.
  const ckb = (ar: string, en: string, k?: string) => k ?? ar;
  const iqd = (amount: number) => ({ month: '2026-03', currency: 'IQD', amount, exchange_rate: 1, amount_iqd: amount, enabled: true });
  const changed = editText(ckb, { id: 'h', version: 2, at: '2026-03-02T09:00:00Z', actor_id: 'admin', actor_name: 'Owner', before: iqd(200000), after: iqd(250000) }, 'ckb');
  assert.equal(changed, 'گۆڕدرا: 200,000 د.ع ← 250,000 د.ع');
  assert.doesNotMatch(changed, /د\.ع[ەە]/);
});

test('no sentence of the promotion page speaks of pieces or units: the month\'s promotion is shared by sales value (DECISIONS row 313)', () => {
  const promotion: Array<[string, readonly [string, string, string]]> = Object.entries(CS).filter(([key]) => /^(promo|hist)/.test(key));
  assert.ok(promotion.length >= 25, `${promotion.length} promotion sentences`);
  // The tables the page reuses are its sentences too (the review of step 5: the rate hint said «للوحدة الواحدة» / "one unit").
  for (const [key, t] of Object.entries(PA_STRINGS)) if (key.startsWith('promotion')) promotion.push([key, [t.ar, t.en, t.ckb]]);
  assert.ok(promotion.some(([key]) => key === 'promotionRateHint'));
  for (const [key, [ar, en, ckb]] of promotion) {
    assert.doesNotMatch(ar, /قطع|قطعة|وحدة/, `${key}: «${ar}»`);
    assert.doesNotMatch(en, /\b(pieces?|units?)\b/i, `${key}: ${en}`);
    assert.doesNotMatch(ckb, /پارچە|(?<!\p{L})یەکە(?!\p{L})/u, `${key}: «${ckb}»`);
  }
  // The one promotion word naming pieces is a count column of «من يحمل الترويج» — what the invoice sold, not the rule.
  assert.deepEqual(Object.entries(CS).filter(([, [ar]]) => /قطع/.test(ar)).map(([key]) => key).filter((key) => !key.startsWith('miss')), ['carriersPieces']);
  // The page writes its rule with these words, not with sentences of its own.
  const page = codeOf('src/components/financeWorkspace/PromotionPage.tsx');
  assert.doesNotMatch(page, /loc\('/, 'every word of the page is in costsStrings.ts or the tables it reuses');
  assert.doesNotMatch(page, /قطع المنتجات|units sell|sold units|per piece/);
});

// ------------------------------------------------------------------ the pages

test('«التكاليف الناقصة»: a card per product and size or colour — lines, pieces kept, orders, and the estimate as a range or «لا تقدير ولا سعر» in red', () => {
  const line = (order: string, id: string, product: string, option: string, qty: number, estimate: number | null) => ({ order_id: order, version: 1, delivered_at: '2026-03-05T10:00:00Z', customer_name: null,
    line_id: id, product_id: product, name: product === 'mag' ? 'Round Magnet' : 'Filament', option, color: null, qty, restocked_qty: 0, cost_qty: qty, stock_qty: 0, preorder: false,
    confidence: estimate == null ? 'unknown' : 'estimated', estimate_unit_iqd: estimate, cogs_iqd: estimate == null ? null : estimate * qty });
  const groups = groupMissing([line('o1', 'a', 'mag', 'D5', 12, null), line('o2', 'b', 'mag', 'D5', 12, null), line('o3', 'c', 'fil', 'Grey', 1, 12000), line('o4', 'd', 'fil', 'Grey', 2, 12500), line('o5', 'e', 'fil', 'Grey', 1, 12000)]);
  const card = (g: (typeof groups)[number], lang: 'ar' | 'en' | 'ckb' = 'ar') => draw(createElement(MissingGroup, { g, stockNote: false, locked: false, onStart: noop, onDone: noop, openOrder: noop }), lang);
  const magnets = card(groups[0]), filament = card(groups[1]);
  assert.match(text(magnets), /Round Magnet · D5/);
  assert.match(text(magnets), /بندان .*24 قطعة .*طلبان/, 'two lines, 24 pieces kept, two orders — each noun agreeing with its number');
  assert.match(magnets, /<b class="fw-neg" data-finance-missing-estimate="none">لا تقدير ولا سعر<\/b>/, 'no estimate and no price: in red');
  assert.match(text(filament), /3 بنود .*4 قطع .*3 طلبات .*تقدير وقت البيع: 12,000–12,500 د.ع/);
  assert.match(filament, /placeholder="12000"/, 'the lowest estimate as the field\'s hint, never a saved value');
  for (const html of [magnets, filament]) {
    assert.match(html, />سعر الشراء للقطعة \(د.ع\)</);
    assert.match(html, /<button[^>]*disabled=""[^>]*>راجِع وثبّت<\/button>/, 'nothing to confirm before a price is typed');
    assert.doesNotMatch(html, /role="alertdialog"/, 'the inline confirmation opens only after «راجِع وثبّت»');
  }
  assert.match(text(card(groups[1], 'en')), /3 lines .*4 pieces .*3 orders .*Sale-time estimate: 12,000–12,500/);
  assert.match(text(card(groups[0], 'ckb')), /2 بڕگە .*24 پارچە .*2 داواکاری .*نە خەمڵاندن و نە نرخ/);
  assert.doesNotMatch(filament, /data-finance-missing-estimate="some-none"/, 'every line estimated: nothing in red');
  // A card whose lines are partly estimated and partly priced by nothing (the review of step 5): the range, and the
  // unpriced ones named in red — they blank their orders' net whatever the estimate says.
  const [mixed] = groupMissing([line('o6', 'f', 'fil', 'Blue', 1, 12000), line('o7', 'g', 'fil', 'Blue', 4, null), line('o8', 'h', 'fil', 'Blue', 6, null)]);
  const html = card(mixed);
  assert.match(text(html), /تقدير وقت البيع: 12,000 د.ع بندان بلا تقدير ولا سعر/);
  assert.match(html, /<b class="fw-neg" data-finance-missing-estimate="some-none">بندان بلا تقدير ولا سعر<\/b>/);
  assert.match(text(card(mixed, 'en')), /Sale-time estimate: 12,000 د.ع 2 lines with no estimate and no price/);
  assert.match(text(card(mixed, 'ckb')), /2 بڕگە بێ خەمڵاندن و بێ نرخ/);
  // The confirmation opens on its sentence (focusable), never on «تأكيد السعر»: a second Enter confirms nothing unread.
  const sheet = codeOf('src/components/financeWorkspace/MissingCostsSheet.tsx');
  assert.match(sheet, /confirmButton\.current\?\.querySelector<HTMLElement>\('p'\)\?\.focus\(\)/);
  assert.doesNotMatch(sheet, /button:last-child/);
  assert.match(sheet, /<p id=\{confirmId\} tabIndex=\{-1\}>/);
});

test('«ترويج الشهر»: who carries it adds up to the month exactly, a month without sales waits for them, and the history says each edit in words', async () => {
  const w = world();
  order(w.raw, { id: 'printer', qty: 1, unit: 1000000, cost: 800000, shipping: 0 });
  order(w.raw, { id: 'switches', qty: 100, unit: 100, cost: 50, product: 'switch', shipping: 0 });
  assert.equal((await post(w.app, '/f/promotions', { month: month(), currency: 'IQD', amount: 10101 })).status, 200);
  const answer = await w.read(`/f/promotions?month=${month()}`) as PromotionsAnswer;
  const html = draw(createElement(Carriers, { data: answer, narrow: false }));
  const rows = [...html.matchAll(/<tr><th scope="row"[^>]*>(.*?)<\/tr>/g)].map((m) => text(m[1]).trim());
  assert.equal(rows.length, 2);
  assert.match(rows[0], /^product 1 1,000,000 د.ع 99\.0% 10,001 د.ع$/);
  assert.match(rows[1], /^switch 100 10,000 د.ع 1\.0% 100 د.ع$/);
  assert.match(text(/<tfoot>(.*)<\/tfoot>/.exec(html)![1]), /101 1,010,000 د.ع 100\.0% 10,101 د.ع/, 'the totals row: the month\'s amount exactly');
  assert.ok(text(html).includes(CS.promoStaff[0]), 'staff and investor shares never include it');
  for (const lang of ['ar', 'en', 'ckb'] as const) for (const th of draw(createElement(Carriers, { data: answer, narrow: false }), lang).match(/<th scope="col"[^>]*>([^<]*)</g) ?? []) assert.ok(text(th).trim().length > 0, `${lang}: every column has a header`);
  // A phone: a list, the same rows and the total.
  assert.match(text(draw(createElement(Carriers, { data: answer, narrow: true }))), /switch 100 د.ع .*99\.0%|product 10,001 د.ع/);
  // No sales yet: the amount waits, and counts on the 1st.
  const waiting = text(draw(createElement(Carriers, { data: { ...answer, products: [], unallocated_iqd: 30000, total_iqd: 30000 }, narrow: false })));
  assert.match(waiting, /ينتظر مبيعات الشهر 30,000 د.ع/);
  assert.ok(waiting.includes(CS.promoWaitingNote[0]));
  assert.ok(text(draw(createElement(Carriers, { data: { ...answer, products: [], total_iqd: 0 }, narrow: false }))).includes(CS.promoNone[0]));
  // The review of step 5: the columns say what they hold — the pieces sold and the sales as the invoice has them, the basis of
  // the shares — and a return or a refund does not move them (the reports' «القطع» and «صافي المبيعات» are kept and retained).
  const heads = [...html.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(heads.slice(1, 4), ['القطع المبيعة', 'المبيعات كما في الفاتورة', 'حصته من المبيعات']);
  assert.ok(text(html).includes(CS.promoInvoiced[0]));
  assert.match(text(draw(createElement(Carriers, { data: answer, narrow: false }), 'en')), /Pieces sold Sales as invoiced Share of sales Promotion share/);
  // A month whose every line was free (gifts): the percent column follows the shares, and its header says so.
  const gifts = draw(createElement(Carriers, { data: { ...answer, products: [{ product_id: 'a', name: 'Gift A', qty: 1, sales_iqd: 0, promotion_iqd: 5050 }, { product_id: 'b', name: 'Gift B', qty: 1, sales_iqd: 0, promotion_iqd: 5051 }] }, narrow: false }));
  assert.ok([...gifts.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((m) => m[1]).includes(CS.promoColShareGifts[0]));
  assert.doesNotMatch(gifts, new RegExp(`>${CS.promoColShare[0]}<`));
  // A month that is over and had no sale: nothing waits any more — the amount counted on its 1st (owner default 5.7.4).
  const ended = text(draw(createElement(Carriers, { data: { ...answer, month: '2020-01', products: [], unallocated_iqd: 30000, total_iqd: 30000 }, narrow: false })));
  assert.match(ended, /حُسب في يومه الأول 30,000 د.ع/);
  assert.ok(ended.includes(CS.promoEndedNote[0]) && !ended.includes(CS.promoWaiting[0]));
  assert.match(text(draw(createElement(Carriers, { data: { ...answer, month: '2999-01', products: [], unallocated_iqd: 30000, total_iqd: 30000 }, narrow: false }))), /ينتظر مبيعات الشهر/, 'a month still to come waits');
  // The history, newest first, in words.
  const usd = (amount: number, enabled = true) => ({ currency: 'USD', amount, exchange_rate: 1500, amount_iqd: amount * 1500, enabled });
  const edits = [{ id: 'h3', version: 3, at: '2026-03-02T09:30:00Z', actor_id: 'admin', actor_name: 'Owner', before: usd(120), after: usd(120, false) },
    { id: 'h2', version: 2, at: '2026-03-02T09:00:00Z', actor_id: 'admin', actor_name: 'Owner', before: usd(100), after: usd(120) },
    { id: 'h1', version: 1, at: '2026-03-01T08:00:00Z', actor_id: 'gone', actor_name: null, before: null, after: usd(100) }];
  const loc = (ar: string) => ar;
  assert.deepEqual(edits.map((h) => editText(loc, h)), ['أُوقف: 120 USD (180,000 د.ع)', 'من 100 USD (150,000 د.ع) إلى 120 USD (180,000 د.ع)', 'أُدخل: 100 USD (150,000 د.ع)']);
  const history = text(draw(createElement(History, { edits })));
  assert.ok(history.indexOf('أُوقف') < history.indexOf('أُدخل'), 'newest first');
  assert.match(history, /Owner · 2 آذار 2026 12:30/, 'who and when, in Baghdad');
  assert.match(history, /مستخدم محذوف/, 'a deleted user is named as such, never a bare dash');
  // A promotion moved to another month says so, in both months' histories; an edit that kept the amount says that too.
  const moved = { id: 'h4', version: 4, at: '2026-03-03T09:00:00Z', actor_id: 'admin', actor_name: 'Owner', before: { ...usd(120), month: '2026-03' }, after: { ...usd(120), month: '2026-02' } };
  assert.equal(editText(loc, moved), 'نُقل من شهر آذار 2026 إلى شهر شباط 2026 · المبلغ كما هو: 120 USD (180,000 د.ع)');
  assert.equal(editText((a: string, e: string) => e, moved, 'en'), 'Moved from Mar 2026 to Feb 2026 · Amount unchanged: 120 USD (180,000 د.ع)');
  // Older edits left out are said to be.
  assert.ok(text(draw(createElement(History, { edits, truncated: true }))).includes('تُعرض آخر 3 من التعديلات'));
  assert.doesNotMatch(text(draw(createElement(History, { edits }))), /تُعرض آخر/);
});

test('«ترويج الشهر»: its form stands only on the month\'s own answer — never another month\'s amount — and one condition holds Save and Enter', () => {
  // First render (the read not back yet): no amount, no save, no rule to act on — the loading line only.
  const first = draw(createElement(PromotionPage, { month: '2026-03', onMonth: noop, from: '2026-03-01', to: '2026-03-31', onChanged: noop }));
  assert.match(first, /تحميل ترويج الشهر…/);
  assert.doesNotMatch(first, /data-finance-promotion-amount|data-finance-promotion-save/);
  const page = codeOf('src/components/financeWorkspace/PromotionPage.tsx');
  // The form is drawn on `shown` (this month's answer) only; a failed read offers to read again instead.
  assert.match(page, /\{!shown \? \(loading \? <Loading text=\{cs\(loc, 'promoLoading'\)\} \/> : <div className="fw-error" role="alert" data-finance-promotion-read-failed>/);
  // One condition for the button and for Enter: nothing goes while the month is unread, loading, saving or missing its rate.
  assert.match(page, /const blocked = loading \|\| !shown \|\| saving \|\| amount\.trim\(\) === '' \|\| \(foreign && !keepsRate && exchange\.trim\(\) === ''\);/);
  assert.match(page, /const save = async \(\) => \{\n {4}if \(blocked\) return;/);
  assert.match(page, /disabled=\{blocked\} onClick=\{save\}/);
  // Disabling asks first (the month and its amount named) and says when it is done.
  assert.match(page, /onClick=\{\(\) => setStopping\(true\)\}/);
  assert.match(page, /cs\(loc, 'promoDisableAsk', \{ month: monthText\(L, month\), amount: promotionAmount\(selected\) \}\)/);
  assert.match(page, /setNotice\(cs\(loc, 'promoDisabled'\)\)/);
  // A refusal in the reader's language.
  assert.doesNotMatch(page, /refusalText\(e\.code/);
  assert.match(page, /refusalWords\(loc, lang, e,/);
});

test('«المصاريف العامة»: the total is the statement\'s line, every entry of the period is accounted for, and the other entries say where they count', async () => {
  const w = expenseWorld();
  const answer = await w.read(`/f/expenses?${period()}`) as ExpensesAnswer, s = await w.read(`/f/summary?${period()}`) as FinanceSummary;
  const view = (lang: 'ar' | 'en' | 'ckb' = 'ar') => draw(createElement(ExpensesView, { data: answer, error: '', from: answer.range.from, to: answer.range.to, showVoided: false, onShowVoided: noop, onChanged: noop, openOrder: noop, onPromotion: noop }), lang);
  const html = view();
  assert.match(html, new RegExp(`data-finance-expenses-total="${s.totals.general_expenses_iqd}"`), 'the page\'s total is the statement\'s «المصاريف العامة»');
  assert.match(text(html), /157,000 د.ع الرقم نفسه، بالدينار، في سطر «المصاريف العامة»/, 'the same figure — in dinars, as this page always is');
  // Two "expenses" never stand side by side unexplained: every entry = general + what counts elsewhere.
  assert.match(text(html), /كل القيود المسجّلة في الفترة 418,500 د.ع = المصاريف العامة 157,000 د.ع \+ ما يُحسب في مكان آخر 261,500 د.ع/);
  // By category, with share bars; the entries are the general ones only.
  assert.match(text(html), /إيجار 120,000 د.ع 76\.4% كهرباء 37,000 د.ع 23\.6%/);
  const entries = /data-finance-expenses-entries[^>]*>(.*?)<\/ul>/.exec(html)![1];
  assert.deepEqual([...entries.matchAll(/data-finance-expense="([^"]+)"/g)].map((m) => m[1]).sort(), ['centre', 'power', 'rent', 'to-gone']);
  assert.match(text(entries), /مركز التكلفة: Shop floor/, 'the cost-centre tag (owner default 5.7.3: the rule stays as today)');
  assert.match(text(entries), /مرتبط بطلب انتهى دون تسليم ← يُحسب مصروفًا عامًا/);
  // The rest, apart, each kind labelled with where it counts; the promotion, the wage and the fee are edited at their source.
  const elsewhere = /data-finance-expenses-elsewhere[^>]*>(.*)$/.exec(html)![1];
  assert.deepEqual([...elsewhere.matchAll(/<section[^>]*data-finance-expense-kind="(\w+)"/g)].map((m) => m[1]), ['promotion', 'order_cost', 'collection_fee', 'order_delivered', 'order_waiting']);
  for (const kind of ELSEWHERE) assert.ok(text(elsewhere).includes(CS[KIND_LABEL[kind]][0]), kind);
  assert.equal((elsewhere.match(/data-finance-expense-edit/g) ?? []).length, 2, 'only the two costs linked to an order are edited here');
  assert.equal((html.match(/data-finance-expense-edit/g) ?? []).length, 6, 'and the four general ones');
  assert.match(html, /href="\/api\/admin\/finance-workspace\/export\.csv\?from=[\d-]+&amp;to=[\d-]+&amp;view=expenses"/);
  // In English and Sorani too.
  assert.match(text(view('en')), /Every entry recorded in the period, 418,500 د.ع = general expenses 157,000 د.ع/);
  assert.match(text(view('ckb')), /هەموو تۆمارەکانی ئەم ماوەیە، 418,500 د.ع/);
  // A period with no general expense: the empty state and its «أضف»; no bare figure under it.
  const none = await world().read(`/f/expenses?${period()}`) as ExpensesAnswer;
  const empty = draw(createElement(ExpensesView, { data: none, error: '', from: none.range.from, to: none.range.to, showVoided: false, onShowVoided: noop, onChanged: noop, openOrder: noop, onPromotion: noop }));
  assert.match(text(empty), /لا مصاريف عامة في الفترة/);
  assert.match(empty, /<button[^>]*aria-expanded="false"[^>]*data-finance-expenses-add-empty/, 'its «أضف» opens the form and closes it again');
  assert.doesNotMatch(text(empty), /—/, 'no bare dash');
  // Each amount of the sentence stays whole on one line, in its own direction (a phone split «0» from «د.ع»).
  assert.match(html, /<bdi style="white-space:nowrap"><span class="fw-money" dir="ltr">418,500 د.ع<\/span><\/bdi>/);
  // The promotion entry opens its own month's promotion page, not the period's.
  assert.match(elsewhere, new RegExp(`data-finance-expense-promotion="${month()}"`));
});

/** One answer of GET /expenses drawn as the page, in `lang`. */
const page = (answer: ExpensesAnswer, extra: { showVoided?: boolean; from?: string; to?: string } = {}, lang: 'ar' | 'en' | 'ckb' = 'ar') => draw(createElement(ExpensesView,
  { data: answer, error: '', from: extra.from ?? answer.range.from, to: extra.to ?? answer.range.to, showVoided: !!extra.showVoided, onShowVoided: noop, onChanged: noop, openOrder: noop, onPromotion: noop }), lang);

test('a period past the server\'s limit: the page and the drawer take their emptiness, bars and headings from the totals, and a cut list says so', async () => {
  const w = crowdedWorld(600);
  const answer = await w.read(`/f/expenses?${period()}`) as ExpensesAnswer;
  assert.equal(answer.truncated, true);
  const html = page(answer);
  assert.doesNotMatch(text(html), /لا مصاريف عامة في الفترة/, 'a 300,000 total never stands beside «no general expense»');
  assert.match(html, /data-finance-expenses-total="300000"/);
  assert.match(text(html), /حسب الفئة إيجار 300,000 د.ع 100\.0%/);
  assert.equal((/data-finance-expenses-entries[^>]*>(.*?)<\/ul>/.exec(html)![1].match(/data-finance-expense="/g) ?? []).length, 3, 'every rent of the 1st');
  assert.doesNotMatch(html, /data-finance-expenses-partial=""/, 'the general list is whole');
  // The other group's heading is the period's sum, not the listed rows'; its list says how much of it is shown.
  const delivered = /data-finance-expense-kind="order_delivered"[^>]*>(.*?)<\/section>/.exec(html)![1];
  assert.match(text(delivered), /^ مرتبط بطلب مُسلَّم ← «المواد والتكاليف الإضافية» لذلك الطلب 600,000 د.ع/);
  assert.match(text(delivered), /قيود هذا القسم: تُعرض 497 من 600؛ المجموع للفترة كلها\./);
  // The drawer: every general entry and its total; nothing cut, nothing said.
  const list = draw(createElement(GeneralEntryList, { rows: answer.rows, total: answer.totals.general_iqd, from: answer.range.from, to: answer.range.to, entries: 3 }));
  assert.equal((list.match(/data-finance-drawer-entry=/g) ?? []).length, 3);
  assert.match(text(list), /مجموع قيود الفترة \(كل الأعمدة\) 300,000 د.ع/);
  assert.doesNotMatch(list, /data-finance-drawer-entries-partial/);
  // A general list the server cut (more general entries than its page): the page and the drawer say how many of how many.
  const cut: ExpensesAnswer = { ...answer, rows: answer.rows.filter((r) => r.counts_as_general).slice(0, 2), totals: { ...answer.totals, by_kind: { ...answer.totals.by_kind, general: { amount_iqd: 300000, entries: 3 } } } };
  assert.match(text(page(cut)), /قيود هذا القسم: تُعرض 2 من 3/);
  assert.match(text(draw(createElement(GeneralEntryList, { rows: cut.rows, total: 300000, from: cut.range.from, to: cut.range.to, entries: 3 }))), /تُعرض 2 من 3/);
  // No general entry listed at all, the total not zero: the list and its total, never «no general expense».
  const none = draw(createElement(GeneralEntryList, { rows: [], total: 300000, from: cut.range.from, to: cut.range.to, entries: 3 }));
  assert.doesNotMatch(text(none), /لا مصاريف عامة في الفترة/);
  assert.match(text(none), /مجموع قيود الفترة \(كل الأعمدة\) 300,000 د.ع .*تُعرض 0 من 3/);
});

test('voided entries come back only where they are owned; a month closed in accounting offers no edit; a promotion linked to an order is flagged', async () => {
  const w = expenseWorld();
  assert.equal((await send(w.app, 'DELETE', '/f/promotions/promo')).status, 200, 'the month\'s promotion disabled on its own page');
  const voided = await w.read(`/f/expenses?${period()}&include_voided=1`) as ExpensesAnswer;
  const html = page(voided, { showVoided: true });
  const li = (id: string) => new RegExp(`<li data-finance-expense="${id}"[^>]*>(.*?)</li>`).exec(html)?.[1] ?? '';
  assert.doesNotMatch(li('promo-exp'), /data-finance-expense-restore|استرجاع/, 'a disabled promotion is brought back on its page, not here (the database refuses it)');
  assert.match(text(li('promo-exp')), /ملغى — أُوقف من صفحة الترويج/, 'its reason in the reader\'s language, not the server\'s Arabic');
  assert.match(li('promo-exp'), /افتح ترويج الشهر/);
  assert.match(text(page(voided, { showVoided: true }, 'en')), /Voided — Stopped on the promotion page/);
  assert.match(li('void'), /data-finance-expense-restore/, 'a voided rent comes back here');
  // An order's wage voided at its source (the database refuses any other change to its row) is not restored here either.
  const wage = page({ ...voided, rows: voided.rows.map((r) => (r.id === 'wage-exp' ? { ...r, voided: true, void_reason: 'cancelled with its order' } : r)) }, { showVoided: true });
  assert.doesNotMatch(/<li data-finance-expense="wage-exp"[^>]*>(.*?)<\/li>/.exec(wage)![1], /data-finance-expense-restore/);
  // A closed month: no edit, no void, no restore; each entry and the page say why.
  const m = month();
  w.raw.exec(`INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES ('${m}','2026-01-01T00:00:00Z','admin')`);
  const closed = page(await w.read(`/f/expenses?${period()}&include_voided=1`) as ExpensesAnswer, { showVoided: true });
  assert.doesNotMatch(closed, /data-finance-expense-edit|data-finance-expense-restore/);
  assert.match(text(closed), new RegExp(`أشهر الفترة المغلقة محاسبيًا: ${monthText('ar', m)}\\.`));
  assert.match(text(closed), /شهر مغلق محاسبيًا/);
  assert.equal(inClosedMonth({ expense_day: `${m}-04` }, [m]), true);
  assert.equal(inClosedMonth({ expense_day: '2020-01-04' }, [m]), false);
  // A promotion's expense linked to an order (possible before this review): flagged — it counts twice.
  const linked = expenseWorld();
  linked.raw.exec("INSERT INTO finance_expense_links(expense_id,order_id) VALUES ('promo-exp','shipped')");
  const flagged = page(await linked.read(`/f/expenses?${period()}`) as ExpensesAnswer);
  assert.match(text(/<li data-finance-expense="promo-exp"[^>]*>(.*?)<\/li>/.exec(flagged)![1]), /مرتبط أيضًا بطلب، فيُحسب مرتين: في الترويج وفي تكاليف الطلب shipped/);
});

test('an entry\'s day keeps its year when the period spans two; an edit sends only what changed; a refusal is said in the reader\'s language', () => {
  const r = row('rent', 'general', 600000, { expense_day: '2025-11-11', title: 'Shop rent' });
  const answer: ExpensesAnswer = { range: { from: '2025-11-11', to: '2026-11-10' }, rows: [r, row('rent2', 'general', 600000, { expense_day: '2026-11-10' })], truncated: false,
    totals: { general_iqd: 1200000, waiting_iqd: 0, all_iqd: 1200000, entries: 2, by_kind: { general: { amount_iqd: 1200000, entries: 2 }, order_ended: { amount_iqd: 0, entries: 0 }, promotion: { amount_iqd: 0, entries: 0 }, order_cost: { amount_iqd: 0, entries: 0 }, collection_fee: { amount_iqd: 0, entries: 0 }, order_delivered: { amount_iqd: 0, entries: 0 }, order_waiting: { amount_iqd: 0, entries: 0 } },
      by_category: [{ category_id: 'rent', name_ar: 'إيجار', name_en: 'Rent', name_ckb: 'کرێی شوێن', amount_iqd: 1200000, entries: 2 }] }, closed_months: [] };
  assert.match(text(page(answer)), /11 تشرين الثاني 2025 · إيجار/, 'a year-long period names the year, as the drawer and the reports do');
  // The page without its answer: a failed read says so (no loading line under it); a read in flight shows the loading line only.
  const view = (data: ExpensesAnswer | null, error: string) => draw(createElement(ExpensesView, { data, error, from: '2026-03-01', to: '2026-03-31', showVoided: false, onShowVoided: noop, onChanged: noop, openOrder: noop, onPromotion: noop }));
  assert.match(view(null, 'تعذّر الاتصال'), /role="alert">تعذّر الاتصال</);
  assert.doesNotMatch(view(null, 'تعذّر الاتصال'), /تحميل المصاريف/);
  assert.match(view(null, ''), /تحميل المصاريف…/);
  assert.doesNotMatch(view(null, ''), /data-finance-expenses-total/);
  // Only the read of the period on screen is drawn: another period's answer never stands under these dates.
  assert.match(codeOf('src/components/financeWorkspace/GeneralExpenses.tsx'), /const shown = data && data\.range\?\.from === from && data\.range\?\.to === to \? data : null;/);
  // The edit: only the changed fields go (PATCH keeps the rest), so a value corrected elsewhere is never written back.
  const d = entryDraft(r);
  assert.deepEqual(editPatch(r, d), {}, 'nothing changed');
  assert.deepEqual(editPatch(r, { ...d, title: 'Shop rent, November' }), { title: 'Shop rent, November' });
  assert.deepEqual(editPatch(r, { ...d, amount: '650000', category_id: 'power' }), { amount_iqd: 650000, category_id: 'power' });
  assert.deepEqual(editPatch(r, { ...d, amount: ' 600000 ' }), {}, 'the same amount, spaces around it');
  // An editor kept open across a re-read, the entry's amount corrected elsewhere meanwhile (the checker of the review): diffed
  // against the entry read again, the draft opened before sent the old amount back with the description.
  const opened = { ...r, amount_iqd: 85000, title: 'Rent' }, now = { ...opened, amount_iqd: 90000 }, typed = { ...entryDraft(opened), title: 'Rent, shop' };
  assert.deepEqual(editPatch(now, typed), { amount_iqd: 85000, title: 'Rent, shop' }, 'the write the review found');
  assert.deepEqual(movedFields(opened, now), ['amount'], 'what the other screen changed');
  assert.deepEqual(movedFields(opened, { ...opened }), [], 'a re-read that changed nothing');
  // The draft follows the entry: the untouched amount takes 90,000, the typed description stays, and only it is sent.
  const rebased = rebaseDraft(opened, now, typed);
  assert.deepEqual(rebased, { ...typed, amount: '90000' });
  assert.deepEqual(editPatch(now, rebased), { title: 'Rent, shop' });
  // A field the owner typed in stays theirs, even one the other screen changed too; spaces around the same amount are untouched.
  assert.equal(rebaseDraft(opened, now, { ...typed, amount: '87000' }).amount, '87000');
  assert.equal(rebaseDraft(opened, now, { ...typed, amount: ' 85000 ' }).amount, '90000');
  assert.deepEqual(rebaseDraft(opened, { ...now, title: 'Rent, March', category_id: 'power' }, typed), { ...typed, amount: '90000', category_id: 'power' }, 'every untouched field, and never the typed one');
  // The editor opens on the entry as it is, closes back on «تعديل», and «إلغاء» never voids: the void asks first.
  const src = codeOf('src/components/financeWorkspace/GeneralExpenses.tsx');
  assert.match(src, /const open = \(\) => \{ setDraft\(entryDraft\(r\)\);/);
  assert.match(src, /const close = \(\) => \{ setEditing\(false\); setVoiding\(false\); setError\(''\); setDraft\(entryDraft\(r\)\); editButton\.current\?\.querySelector<HTMLButtonElement>\('button'\)\?\.focus\(\); \};/);
  assert.match(src, /void run\(\(\) => updateExpense\(r\.id, patch\), sentFields\(patch\)\)/);
  assert.match(src, /onClick=\{\(\) => setVoiding\(true\)\} data-finance-expense-void>/);
  assert.equal((src.match(/voidExpense\(/g) ?? []).length, 1, 'one void, behind its confirmation');
  assert.match(src, /if \(e\.key === 'Escape'\)/);
  assert.notEqual(CS.genVoidAction[0], 'إلغاء');
  assert.notEqual(CS.genVoidAction[2], 'هەڵوەشاندنەوە', 'not the Sorani Cancel of the missing-cost confirmation');
  // Refusals: this table's sentence for the costs pages' codes, the shop's table for its own; any other refusal is said as one,
  // with the server's reason after it — never the bare fallback, which hid why (the checker of step 5's second review); the
  // fallback only for what no request threw.
  const loc = (lang: 'ar' | 'en' | 'ckb') => (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k ?? a : a);
  for (const [code, key] of [['PERIOD_CLOSED', 'refPeriodClosed'], ['CONFLICT', 'refConflict'], ['EXPENSE_VOIDED', 'refVoided'], ['CATEGORY_UNKNOWN', 'refCategory'],
    ['CATEGORY_EXISTS', 'refCategoryExists'], ['NOT_FOUND', 'refNotFound'], ['EXPENSE_AMOUNT_INVALID', 'refAmount'], ['RATE_LIMITED', 'refRateLimited'], ['BAD_NUMBER', 'refNumber'],
    ['UNAUTHORIZED', 'refSignedOut'], ['FORBIDDEN', 'refForbidden']] as const)
    for (const [i, lang] of (['ar', 'en', 'ckb'] as const).entries()) assert.equal(refusalWords(loc(lang), lang, { code, message: 'This expense is voided — restore it before editing' }, 'fallback'), CS[key][i], `${code} ${lang}`);
  // A day the server refuses: the old ledger's own sentence for the same check, reused (never repeated in this table).
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const ledger = financeStrings(loc(lang));
    assert.equal(refusalWords(loc(lang), lang, { code: 'EXPENSE_DAY_INVALID' }, 'fallback'), ledger.errDayNotADay);
    assert.equal(refusalWords(loc(lang), lang, { code: 'EXPENSE_DAY_TOO_FAR' }, 'fallback'), ledger.errDayTooFar);
  }
  for (const [i, lang] of (['ar', 'en', 'ckb'] as const).entries())
    assert.equal(refusalWords(loc(lang), lang, { code: 'NO_SUCH_CODE', message: 'raw' }, 'fallback'), CS.refOther[i].replace('{reason}', 'raw'), `${lang}: a code no table words`);
  assert.equal(refusalWords(loc('ar'), 'ar', new Error('network'), 'fallback'), 'fallback');
});

test('every coded refusal the costs pages\' writes can meet is said in the reader\'s language, never «تعذّر الحفظ.» (the checker of step 5\'s review)', async () => {
  // The routes the pages write through, refusing for real on an invented world: the old ledger's expense and category routes
  // (the entries' edits and the embedded form), the promotions route, the closed month and the finance door's hourly budget —
  // and, since the checker of the second review, the admin door in front of them all.
  const routes = (a: App) => { a.route('/e', adminFinanceRoutes); a.route('/f', adminFinanceWorkspaceRoutes); };
  const w = expenseWorld(), day = baghdadDay(), app = stubApp(w.db, { id: 'admin', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, routes);
  // A day two years ahead of today's: the 15th of January of that year, which every year has (today's month and day were used:
  // run on 29 February, that named no day, and the route said EXPENSE_DAY_INVALID — the checker of step 5's second review).
  const twoYearsAhead = (today: string) => `${Number(today.slice(0, 4)) + 2}-01-15`;
  // dayParts is the route's own calendar check (validateExpenseDay); isDay checks the shape only.
  assert.ok(dayParts(twoYearsAhead('2028-02-29')), `from a leap day too, a day that exists: ${twoYearsAhead('2028-02-29')}`);
  assert.equal((await post(app, '/e/expense-categories', { name_ar: 'صيانة' })).status, 200);
  const refused = async (what: string, sent: Response | Promise<Response>) => {
    const res = await sent, body = await json(res);
    assert.ok(res.status >= 400 && res.status < 500, `${what}: ${res.status} ${JSON.stringify(body)}`);
    return { what, error: new ApiError(res.status, String(body.error), body.code as string | undefined) };
  };
  const answers = [
    await refused('a category added twice', post(app, '/e/expense-categories', { name_ar: 'صيانة' })),
    await refused('a category that is gone', patch(app, '/e/expense-categories/gone', { active: false })),
    await refused('an unknown category', post(app, '/e/expenses', { category_id: 'gone', amount_iqd: 5000, expense_day: day })),
    await refused('an amount of nothing', post(app, '/e/expenses', { category_id: 'rent', amount_iqd: 0, expense_day: day })),
    await refused('a day that is not one', post(app, '/e/expenses', { category_id: 'rent', amount_iqd: 5000, expense_day: '2026-02-30' })),
    await refused('a day two years ahead', post(app, '/e/expenses', { category_id: 'rent', amount_iqd: 5000, expense_day: twoYearsAhead(day) })),
    await refused('an edit of a voided entry', patch(app, '/e/expenses/void', { title: 'Rent, again' })),
    await refused('an entry that is gone', patch(app, '/e/expenses/gone', { title: 'Rent, again' })),
    await refused('a promotion edited on a stale version', patch(app, '/f/promotions/promo', { version: 99, amount: 1000 })),
    await refused('a dollar promotion without the rate paid', post(app, '/f/promotions', { month: previousMonth(), currency: 'USD', amount: 10 })),
    await refused('a promotion under the smallest amount (the page lets 0.001 through)', post(app, '/f/promotions', { month: previousMonth(), currency: 'IQD', amount: 0.001 })),
    // The admin door: the owner's session lapsed, an account no longer an administrator, an administrator who is not the owner.
    await refused('a session that has ended', patch(stubApp(w.db, null, routes), '/e/expenses/rent', { title: 'Rent, again' })),
    await refused('an account no longer an administrator', patch(stubApp(w.db, { id: 'cust', email: 'c@x.co', role: 'customer' }, routes), '/e/expenses/rent', { title: 'Rent, again' })),
    await refused('an administrator who is not the owner', patch(stubApp(w.db, { id: 'a2', email: 'other@x.co', role: 'admin', admin_scope: 'full' }, routes), '/e/expenses/rent', { title: 'Rent, again' })),
  ];
  w.raw.exec(`INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES ('${month()}','2026-01-01T00:00:00Z','admin')`);
  answers.push(await refused('an edit in a month closed in accounting', patch(app, '/e/expenses/rent', { title: 'Rent, again' })));
  const now = Math.floor(Date.now() / 1000);
  w.raw.exec(`INSERT INTO rate_limits(key,window_start,count) VALUES ('finance-write:u:admin',${now - (now % 3600)},120) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=120`);
  answers.push(await refused('the hour\'s finance writes spent', patch(app, '/e/expenses/rent', { title: 'Rent, again' })));
  assert.deepEqual(answers.map((a) => a.error.code), ['CATEGORY_EXISTS', 'NOT_FOUND', 'CATEGORY_UNKNOWN', 'EXPENSE_AMOUNT_INVALID', 'EXPENSE_DAY_INVALID', 'EXPENSE_DAY_TOO_FAR',
    'EXPENSE_VOIDED', 'NOT_FOUND', 'CONFLICT', 'PROMOTION_RATE_REQUIRED', 'BAD_NUMBER', 'UNAUTHORIZED', 'FORBIDDEN', 'COST_ACCESS_DENIED', 'PERIOD_CLOSED', 'RATE_LIMITED']);
  // Each as the page words it (GeneralExpenses' errorText): the sentence, in the reader's language — never the fallback, never
  // the server's own sentence (Arabic or English whatever the page's language).
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const loc = (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k ?? a : a), s = financeStrings(loc);
    const words = answers.map(({ what, error }) => ({ what, error, said: refusalWords(loc, lang, error, s.saveFailed) }));
    for (const { what, error, said } of words) {
      assert.notEqual(said, s.saveFailed, `${lang} ${what} (${error.code}): «${said}»`);
      assert.notEqual(said, error.message, `${lang} ${what}: not the server's sentence`);
      if (lang === 'en') assert.doesNotMatch(said, /[؀-ۿ]/, `${what}: in English`);
      else assert.match(said, /[؀-ۿ]/, `${lang} ${what}`);
      if (lang === 'ckb') assert.match(said, SORANI_ONLY, `${what}: in Sorani, «${said}»`);
    }
    // Each has a sentence of its own: none falls through to the frame that quotes the server's reason.
    for (const { what, error, said } of words) assert.notEqual(said, loc(...CS.refOther).replace('{reason}', error.message.trim()), `${lang} ${what}: not the server's reason quoted`);
  }
});

test('a write whose answer never came is never said to have failed — it may have landed — and a refusal no table words still says why (the checker of step 5\'s second review)', async () => {
  const { writeUnanswered } = await import('../src/components/adminFinance/expenseForm');
  const { api, clearApiSessionRequests } = await import('../src/lib/api');
  // Drawn from the API client itself (src/lib/api.ts), over a transport that fails as the owner's phone does.
  const real = globalThis.fetch, drawn: Array<{ what: string; error: ApiError }> = [];
  const failing = async (what: string, transport: (init?: RequestInit) => Promise<Response>, timeoutMs?: number) => {
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => transport(init)) as typeof fetch;
    try {
      await api.post('/api/admin/finance/expenses', { category_id: 'rent', amount_iqd: 600000 }, timeoutMs ? { timeoutMs } : undefined);
      assert.fail(`${what}: it answered`);
    } catch (e) {
      assert.ok(e instanceof ApiError, `${what}: ${String(e)}`);
      drawn.push({ what, error: e });
    } finally { globalThis.fetch = real; }
  };
  const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  await failing('the answer lost on the way back', async () => { throw new TypeError('Failed to fetch'); });
  await failing('past the client\'s deadline', (init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))), 5);
  await failing('an answer that came under another session', async () => { clearApiSessionRequests(); return answer(200, { success: true, ids: ['exp_1'] }); });
  await failing('a server failure with no refusal of its own', async () => answer(500, { success: false, error: 'Something went wrong. Please try again.' }));
  await failing('the database busy', async () => answer(500, { success: false, error: 'The store is busy right now. Please try again in a moment.', code: 'SERVICE_BUSY' }));
  assert.deepEqual(drawn.map(({ error }) => [error.status, error.code ?? null]), [[0, 'NETWORK'], [0, 'TIMEOUT'], [0, 'ABORTED'], [500, null], [500, 'SERVICE_BUSY']]);
  for (const [i, lang] of (['ar', 'en', 'ckb'] as const).entries()) {
    const loc = (a: string, e: string, k?: string) => (lang === 'en' ? e : lang === 'ckb' ? k ?? a : a), s = financeStrings(loc);
    for (const { what, error } of drawn) {
      const said = refusalWords(loc, lang, error, s.saveFailed);
      assert.notEqual(said, s.saveFailed, `${lang} ${what}: «${said}» — the write may have been recorded`);
      assert.equal(said, CS.refUnanswered[i], `${lang} ${what}`);
      assert.ok(writeUnanswered(error), what);
    }
    // A refusal no table words — the server's own validation, a code added later — says it was refused, and why.
    for (const error of [new ApiError(400, 'title is too long (max 120 characters)'), new ApiError(503, 'تحديث مساحة العمل المالية لم يطبق بعد', 'NOT_CONFIGURED')]) {
      assert.equal(writeUnanswered(error), false, error.message);
      assert.equal(refusalWords(loc, lang, error, s.saveFailed), CS.refOther[i].replace('{reason}', error.message), `${lang}: ${error.message}`);
    }
    // What no request threw keeps the page's own fallback.
    assert.equal(refusalWords(loc, lang, new Error('boom'), s.saveFailed), s.saveFailed);
  }
  // Refused before anything was written: never «it may have been saved».
  for (const error of [new ApiError(409, 'x', 'PERIOD_CLOSED'), new ApiError(401, 'Authentication required', 'UNAUTHORIZED'), new ApiError(429, 'x', 'RATE_LIMITED'), new ApiError(503, 'x', 'NOT_CONFIGURED'), new Error('x'), null])
    assert.equal(writeUnanswered(error), false, String(error));
  // Every write of the costs pages reads the page again on such an answer, so the sentence's «تُقرأ الصفحة من جديد» holds.
  const ledger = codeOf('src/components/adminFinance/ExpenseLedger.tsx'), page = codeOf('src/components/financeWorkspace/GeneralExpenses.tsx'), promo = codeOf('src/components/financeWorkspace/PromotionPage.tsx');
  assert.equal((ledger.match(/if \(writeUnanswered\(e\)\)/g) ?? []).length, 3, 'the expense, a new category, a category switched on or off');
  assert.match(ledger, /if \(writeUnanswered\(e\)\) \{\n {8}if \(formOnly\) \{\n {10}setDraft\(\(d\) => \(\{ \.\.\.d, amount: '' \}\)\);\n {10}setTouched\(false\);\n {8}\}\n {8}keepError\.current = true;\n {8}refresh\(\);/, 'the expense: the page read again, its sentence kept, the amount cleared');
  assert.match(ledger, /if \(keepError\.current\) keepError\.current = false;\n {4}else setError\(null\);/, 'the read a lost answer starts keeps what the form says');
  assert.match(page, /if \(writeUnanswered\(e\)\) \{ sent\.current = \{ \.\.\.sent\.current, \.\.\.sending \}; onChanged\(\); \}/, 'an entry\'s edit, void or restore');
  assert.equal((promo.match(/if \(writeUnanswered\(e\)\) onChanged\(\);/g) ?? []).length, 2, 'the promotion\'s save and its stop');
});

test('an edit\'s own save is not a change made elsewhere: what a row sent, as the entry carries it once it lands (the checker of step 5\'s second review)', async () => {
  const { movedElsewhere, sentFields } = await import('../src/components/financeWorkspace/expenseKinds');
  const r = { category_id: 'utilities', amount_iqd: 12000, expense_day: '2026-03-04', title: 'Water' };
  assert.deepEqual(sentFields(editPatch(r, { ...entryDraft(r), title: ' Water, tank ', amount: '13000' })), { amount: '13000', title: 'Water, tank' }, 'the route trims the description');
  assert.deepEqual(sentFields({}), {});
  // The editor reopened on the entry as it was; the re-read brings the description this row just saved.
  const saved = { ...r, title: 'Water, tank' };
  assert.deepEqual(movedFields(r, saved), ['title']);
  assert.deepEqual(movedElsewhere(r, saved, { title: 'Water, tank' }), [], 'the owner\'s own save');
  assert.deepEqual(movedElsewhere(r, saved, {}), ['title'], 'nothing sent: a change made elsewhere');
  assert.deepEqual(movedElsewhere(r, { ...saved, amount_iqd: 14000 }, { title: 'Water, tank' }), ['amount'], 'and a field another screen changed meanwhile is still named');
  assert.deepEqual(movedElsewhere(r, { ...r, title: 'Water, roof' }, { title: 'Water, tank' }), ['title'], 'a value other than the one sent');
});

test('the ledger\'s form embedded on the page speaks the reader\'s language, names no problem before anything is typed, and shows no ledger', () => {
  const s = financeStrings((a: string, e: string) => e);
  const form = draw(createElement(ExpenseLedger, { formOnly: true, from: '2026-03-01', to: '2026-03-31', s, latin: true, dir: 'ltr', onChanged: noop,
    categoryLabel: (c: { name_en: string }) => c.name_en, categoryPrompt: CS.genCategoryPick[1], errorText: () => 'x' }), 'en');
  assert.match(form, /<option value=""[^>]*>Choose a category<\/option>/, 'a prompt, never a bare «—»');
  assert.doesNotMatch(form, /data-finance-expense-problem/, 'no red «type an amount» on a form nobody touched');
  // …and so no disabled «Save» with nothing said beside it: pressed, it names the problem (tests/financeCostsInteractions.test.ts).
  assert.match(form, /<button type="submit" class="[^"]*">/, 'the untouched form\'s «Save» is offered');
  assert.doesNotMatch(form, new RegExp(s.addExpense), 'the page\'s own heading names the form');
  assert.doesNotMatch(form, new RegExp(s.periodTotal), 'no ledger under it: the page lists the entries itself');
  assert.match(codeOf('src/components/adminFinance/ExpenseLedger.tsx'), /formOnly \? Promise\.resolve\(null\) : fetchExpenses\(/, 'and it does not read the ledger\'s rows either');
  // The old report's whole ledger is unchanged: its heading, its «—», its problem line at once, beside a held «Save».
  const ledger = draw(createElement(ExpenseLedger, { from: '2026-03-01', to: '2026-03-31', s, latin: true, dir: 'ltr', onChanged: noop }), 'en');
  assert.match(ledger, new RegExp(s.addExpense));
  assert.match(ledger, /<option value=""[^>]*>—<\/option>/);
  assert.match(ledger, /data-finance-expense-problem/);
  assert.match(ledger, /<button type="submit" disabled="" class="[^"]*">/);
  assert.match(ledger, new RegExp(s.periodTotal));
});

test('the drawer\'s «المصاريف العامة» line lists the period\'s general entries, and they add up to the statement\'s line', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}&display=USD`) as FinanceSummary, e = await w.read(`/f/expenses?${w.range}`) as ExpensesAnswer;
  assert.equal(e.totals.general_iqd, s.totals.general_expenses_iqd);
  const list = draw(createElement(GeneralEntryList, { rows: e.rows, total: e.totals.general_iqd, from: w.from, to: w.to }));
  assert.equal((list.match(/data-finance-drawer-entry=/g) ?? []).length, e.rows.filter((r) => r.counts_as_general).length);
  // Named for what it sums (every column), apart from the column's own «المجموع» above it (the review of step 5).
  assert.match(text(list), new RegExp(`مجموع قيود الفترة \\(كل الأعمدة\\) ${(s.totals.general_expenses_iqd ?? 0).toLocaleString('en-US')} د.ع`));
  assert.doesNotMatch(text(list), /المجموع \d/);
  // In dollars: the entries stay in dinars, as recorded, and the sentence gives their total in dollars — the statement's own cents.
  const usdCents = s.display_usd?.available ? s.display_usd.totals?.general_expenses_cents : undefined;
  assert.equal(typeof usdCents, 'number', 'the every-state world has the shop\'s dollar rate');
  const usd = text(draw(createElement(GeneralEntryList, { rows: e.rows, total: e.totals.general_iqd, from: w.from, to: w.to, usdCents })));
  assert.ok(usd.replace(/ ،/g, '،').includes(`المبالغ هنا بالدينار كما سُجّلت؛ مجموعها بالدولار ${amountText(usdCents!, true)}، كما في سطر الكشف.`), usd);
  assert.doesNotMatch(text(list), /بالدولار/, 'in dinars, no dollar sentence');
  // The drawer hands the list the statement's dollars only when it shows dollars; the general line's note is one sentence.
  const drawerSrc = codeOf('src/components/financeWorkspace/FigureDrawer.tsx');
  assert.match(drawerSrc, /<DrawerGeneralEntries from=\{range\.from\} to=\{range\.to\} usdCents=\{u \? usd\?\.totals\?\.general_expenses_cents \?\? null : undefined\} \/>/);
  assert.doesNotMatch(drawerSrc, /generalNote/);
  // A period with no general expense: the list says so, with no «(0 د.ع)» note above it.
  const empty = text(draw(createElement(GeneralEntryList, { rows: [], total: 0, from: w.from, to: w.to, entries: 0 })));
  assert.match(empty, /لا مصاريف عامة في الفترة/);
  assert.doesNotMatch(empty, /0 د.ع/);
  // The drawer opened on the general line reads them for its own period (a loading state while it does, never an empty list).
  const drawer = draw(createElement(DisplayCurrencyContext.Provider, { value: 'IQD' }, createElement(FigureBody, { data: s, figure: 'general', from: w.from, to: w.to, onClose: noop, openOrder: noop, onNavigate: noop })));
  assert.match(drawer, /تحميل المصاريف…/);
  assert.match(drawer, /افتح المصاريف العامة/);
  assert.doesNotMatch(draw(createElement(DisplayCurrencyContext.Provider, { value: 'IQD' }, createElement(FigureBody, { data: s, figure: 'net', from: w.from, to: w.to, onClose: noop, openOrder: noop, onNavigate: noop }))), /تحميل المصاريف/, 'only the general line');
});

/** The workspace as it opens on a link (its first render: the effects that read the server do not run here). */
function open(search: string, lang: 'ar' | 'en' | 'ckb' = 'ar') {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = { location: { search, href: `https://levonis-iq.com/admin${search}` }, history: { state: null, replaceState: () => {} } };
  LANG = lang;
  try { return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(FinanceWorkspace))); } finally { g.window = before; LANG = 'ar'; }
}
test('the promotion\'s month follows the period — its last month — unless the owner picked one; a period across months says each has its own', () => {
  const picked = (html: string) => /value="(\d{4}-\d{2})"/.exec(/<input type="month"[^>]*data-finance-promotion-month[^>]*>/.exec(html)?.[0] ?? '')?.[1];
  assert.equal(picked(open('?finance=monthly&from=2026-09-01&to=2026-09-30')), '2026-09');
  assert.equal(picked(open('?finance=monthly&from=2026-09-15&to=2026-10-14')), '2026-10', 'the last month of the period');
  assert.equal(picked(open('?finance=monthly&from=2026-09-01&to=2026-09-30&financeMonth=2026-08')), '2026-08', 'a pick in the address holds');
  const across = open('?finance=monthly&from=2026-09-15&to=2026-10-14');
  assert.match(text(across), /الفترة تمتد من أيلول 2026 إلى تشرين الأول 2026/);
  assert.match(across, /<h2>ترويج الشهر · تشرين الأول 2026<\/h2>/, 'the month is named on the page');
  assert.doesNotMatch(open('?finance=monthly&from=2026-09-01&to=2026-09-30'), /data-finance-promotion-span/);
  assert.equal(monthText('ckb', '2026-11'), 'تشرینی دووەم 2026');
  // The workspace wires the two pages and no longer the old ones.
  const ws = codeOf('src/components/financeWorkspace/FinanceWorkspace.tsx');
  // One mount per month (the review of step 5, as MonthlyCosts had): nothing typed for one month stands in another's form.
  assert.match(ws, /page\('monthly', \(\) => <PromotionPage key=\{month\} month=\{month\}/);
  assert.match(ws, /page\('expenses', \(\) => <GeneralExpenses from=\{range\.from\} to=\{range\.to\}/);
  // A promotion entry opens its own month's promotion page.
  assert.match(ws, /onPromotion=\{\(m\) => \{ setMonthPick\(m\); setSection\('monthly'\); \}\}/);
  assert.doesNotMatch(ws, /MonthlyCosts|ExpenseLedger/);
  assert.match(ws, /const setRange = \(next: FinanceRange\) => \{ setRangeState\(next\); setMonthPick\(null\); \};/, 'a new period: the month follows it again');
});
