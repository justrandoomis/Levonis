/**
 * «المال والأرباح» → التكاليف — THE PAGES (redesign step 5, owner 2026-11-11; DECISIONS row 317).
 *
 * What the client works out is pure and held here: a missing-cost group's sale-time estimate as one range (or none), the
 * promotion's percent column adding up to exactly 100 after rounding, the period's entries grouped by where they count and
 * the general ones by category. Every new word is in Arabic, English and real Sorani (DECISIONS row 183), and no sentence of
 * the promotion page speaks of pieces or units — the month's promotion is shared by sales value (row 313). Then the pages as
 * the owner reads them, drawn on the server's own answers for invented worlds: «19 بندًا»-style headers that agree with their
 * number, the missing-cost card with its range or «لا تقدير ولا سعر», who carries the promotion adding up to the month, its
 * history in words, the general expenses whose total is the statement's line and whose other entries say where they count,
 * the drawer's general line listing its entries, and the promotion's month following the period.
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
import { CS, COUNTED, counted } from '../src/components/financeWorkspace/costsStrings';
import { estimateRange, percentText, promotionTable, rangeFigures, sharePercents } from '../src/components/financeWorkspace/costFigures';
import { categoryName, categoryShares, editableHere, ELSEWHERE, groupEntries, KIND_LABEL, type ExpenseEntryRow, type ExpenseKind, type ExpensesAnswer } from '../src/components/financeWorkspace/expenseKinds';
import { monthText } from '../src/components/financeWorkspace/overviewStrings';
import { DisplayCurrencyContext } from '../src/components/financeWorkspace/displayCurrency';
import type { FinanceSummary } from '../src/components/financeWorkspace/types';
import type { PromotionsAnswer } from '../src/components/financeWorkspace/PromotionPage';
import { everyState, month, order, period, world } from './fixtures/financeWorld';
import { expenseWorld } from './fixtures/financeCosts';
import { post } from './fixtures/app';
import { codeOf } from './fixtures/source';

let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
// The workspace imports its stylesheet; node has no CSS loader (as tests/financeOverviewFigures.test.ts).
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,', shortCircuit: true };
  return next(specifier, context);
}`));
const { default: FinanceWorkspace } = await import('../src/components/financeWorkspace/FinanceWorkspace');
const { MissingGroup, groupMissing } = await import('../src/components/financeWorkspace/MissingCostsSheet');
const { Carriers, History, editText } = await import('../src/components/financeWorkspace/PromotionPage');
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
  // A count agrees with its noun in Arabic; English has one and many; Sorani keeps the noun.
  assert.deepEqual([1, 2, 3, 10, 11, 19, 100, 101, 1200].map((n) => counted('ar', 'lines', n)), ['بند واحد', 'بندان', '3 بنود', '10 بنود', '11 بندًا', '19 بندًا', '100 بند', '101 بند', '1,200 بند']);
  assert.equal(counted('ar', 'missingHead', 19), '19 بندًا بلا تكلفة مؤكدة', 'the mockup\'s header');
  assert.deepEqual([counted('en', 'pieces', 1), counted('en', 'pieces', 30), counted('ckb', 'orders', 2)], ['1 piece', '30 pieces', '2 داواکاری']);
});

test('no sentence of the promotion page speaks of pieces or units: the month\'s promotion is shared by sales value (DECISIONS row 313)', () => {
  const promotion = Object.entries(CS).filter(([key]) => /^(promo|hist)/.test(key));
  assert.ok(promotion.length >= 25, `${promotion.length} promotion sentences`);
  for (const [key, [ar, en, ckb]] of promotion) {
    assert.doesNotMatch(ar, /قطع|قطعة/, `${key}: «${ar}»`);
    assert.doesNotMatch(en, /\b(pieces?|units?)\b/i, `${key}: ${en}`);
    assert.doesNotMatch(ckb, /پارچە/, `${key}: «${ckb}»`);
  }
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
});

test('«المصاريف العامة»: the total is the statement\'s line, every entry of the period is accounted for, and the other entries say where they count', async () => {
  const w = expenseWorld();
  const answer = await w.read(`/f/expenses?${period()}`) as ExpensesAnswer, s = await w.read(`/f/summary?${period()}`) as FinanceSummary;
  const view = (lang: 'ar' | 'en' | 'ckb' = 'ar') => draw(createElement(ExpensesView, { data: answer, error: '', from: answer.range.from, to: answer.range.to, showVoided: false, onShowVoided: noop, onChanged: noop, openOrder: noop, onNavigate: noop }), lang);
  const html = view();
  assert.match(html, new RegExp(`data-finance-expenses-total="${s.totals.general_expenses_iqd}"`), 'the page\'s total is the statement\'s «المصاريف العامة»');
  assert.match(text(html), /157,000 د.ع الرقم نفسه في سطر «المصاريف العامة»/);
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
  const empty = draw(createElement(ExpensesView, { data: none, error: '', from: none.range.from, to: none.range.to, showVoided: false, onShowVoided: noop, onChanged: noop, openOrder: noop, onNavigate: noop }));
  assert.match(text(empty), /لا مصاريف عامة في الفترة/);
  assert.match(empty, /data-finance-expenses-add-empty/);
  assert.doesNotMatch(text(empty), /—/, 'no bare dash');
});

test('the drawer\'s «المصاريف العامة» line lists the period\'s general entries, and they add up to the statement\'s line', async () => {
  const w = everyState();
  const s = await w.read(`/f/summary?${w.range}`) as FinanceSummary, e = await w.read(`/f/expenses?${w.range}`) as ExpensesAnswer;
  assert.equal(e.totals.general_iqd, s.totals.general_expenses_iqd);
  const list = draw(createElement(GeneralEntryList, { rows: e.rows, total: e.totals.general_iqd, from: w.from, to: w.to }));
  assert.equal((list.match(/data-finance-drawer-entry=/g) ?? []).length, e.rows.filter((r) => r.counts_as_general).length);
  assert.match(text(list), new RegExp(`المجموع ${(s.totals.general_expenses_iqd ?? 0).toLocaleString('en-US')} د.ع`));
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
  assert.match(ws, /page\('monthly', \(\) => <PromotionPage month=\{month\}/);
  assert.match(ws, /page\('expenses', \(\) => <GeneralExpenses from=\{range\.from\} to=\{range\.to\}/);
  assert.doesNotMatch(ws, /MonthlyCosts|ExpenseLedger/);
  assert.match(ws, /const setRange = \(next: FinanceRange\) => \{ setRangeState\(next\); setMonthPick\(null\); \};/, 'a new period: the month follows it again');
});
