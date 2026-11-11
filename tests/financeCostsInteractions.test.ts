/**
 * «المال والأرباح» → التكاليف — THE PAGES IN THE OWNER'S HANDS (redesign step 5, DECISIONS row 317; the checker of its
 * independent review).
 *
 * tests/financeCostsPages.test.ts reads the pages as they are drawn. This file uses them: mounted by react-dom in the small
 * browser of tests/fixtures/miniDom.ts, typed into, clicked and keyed as the owner does, writing through the real routes over
 * an invented world. It holds what only the owner's hands find:
 * - «التكاليف الناقصة»: a keystroke in the price field while the confirmation is open closes it and leaves the focus in the
 *   field — it moved to «راجِع وثبّت», the next digit was lost, and Enter reopened the confirmation at the half-typed price;
 *   «إلغاء» and Escape give the focus back to «راجِع وثبّت»;
 * - «المصاريف العامة»: the ledger's form embedded on the page never stands with a disabled «احفظ» and nothing said —
 *   pressed, or Enter in a field, on an untouched form, it names the problem and sends nothing;
 * - a category added twice says it exists, in the reader's language (it said «تعذّر الحفظ.»);
 * - an entry's editor kept open across a re-read sends only the field the owner changed: an amount corrected elsewhere
 *   meanwhile stays corrected, and the editor shows it.
 *
 * Every figure is invented (DECISIONS row 316). Run: node --import tsx --test tests/financeCostsInteractions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { click, installDom, named, pressKey, type, words, type FakeElement } from './fixtures/miniDom';
import { ctx, stubApp } from './fixtures/app';
import { period, world } from './fixtures/financeWorld';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { baghdadDay } from '../worker/lib/operations';

const dom = installDom();
let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };

// react-dom reads the document when it loads: everything that draws comes after installDom().
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LanguageProvider } = await import('../src/LanguageContext');
const { MissingGroup, groupMissing } = await import('../src/components/financeWorkspace/MissingCostsSheet');
const { default: GeneralExpenses } = await import('../src/components/financeWorkspace/GeneralExpenses');
const { financeStrings } = await import('../src/components/adminFinance/strings');
const { CS } = await import('../src/components/financeWorkspace/costsStrings');

const noop = () => {};
const LANGS = ['ar', 'en', 'ckb'] as const;
const inLang = (lang: (typeof LANGS)[number]) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
const s = financeStrings(inLang('ar'));
const [from, to] = (() => { const q = new URLSearchParams(period()); return [q.get('from')!, q.get('to')!]; })();

/** The owner's app over a world's database, the routes at their own paths; every request the pages send goes through it. */
function serve(w: ReturnType<typeof world>) {
  const app = stubApp(w.db, { id: 'admin', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => {
    a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes);
    a.route('/api/admin/finance', adminFinanceRoutes);
  });
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const inflight = new Set<Promise<unknown>>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    sent.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const answer = Promise.resolve(app.request(path, { method, headers: { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '1.2.3.4' }, body: init?.body }, undefined, ctx));
    inflight.add(answer);
    try { return await answer; } finally { inflight.delete(answer); }
  }) as typeof fetch;
  /** Until every request the page started has its answer drawn. */
  const settle = async () => {
    for (let idle = 0, rounds = 0; idle < 3; rounds++) {
      assert.ok(rounds < 200, 'the page settles');
      await act(async () => { await Promise.allSettled([...inflight]); await new Promise((r) => setImmediate(r)); });
      idle = inflight.size === 0 ? idle + 1 : 0;
    }
  };
  return { sent, settle, writes: () => sent.filter((r) => r.method !== 'GET') };
}

/** `node` mounted in the page's own language frame, in `lang`. */
async function mount(node: ReactNode, lang: (typeof LANGS)[number] = 'ar') {
  LANG = lang;
  const container = dom.container();
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(h(LanguageProvider, null, node)); });
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); LANG = 'ar'; } };
}
/** The focus is on `el`; a failure names where it is instead (never a diff of two element trees). */
const focusOn = (el: FakeElement | null | undefined, message: string) => {
  const at = dom.document.activeElement;
  assert.ok(!!el && at === el, `${message} — the focus is on <${at.localName}> «${words(at).slice(0, 60)}»`);
};

// ------------------------------------------------------------------ التكاليف الناقصة

test('«التكاليف الناقصة»: a keystroke in the price field while the confirmation is open leaves the focus in the field; «إلغاء» and Escape give it back to «راجِع وثبّت»', async () => {
  const line = (order: string, id: string, qty: number) => ({ order_id: order, version: 1, delivered_at: '2026-03-05T10:00:00Z', customer_name: null, line_id: id, product_id: 'toggle', name: 'Toggle',
    option: 'Red', color: null, qty, restocked_qty: 0, cost_qty: qty, stock_qty: 0, preorder: false, confidence: 'estimated', estimate_unit_iqd: 70, cogs_iqd: 70 * qty });
  const [g] = groupMissing([line('o1', 'a', 40), line('o2', 'b', 47)]);
  const page = await mount(h(MissingGroup, { g, stockNote: false, locked: false, onStart: noop, onDone: noop, openOrder: noop }));
  const field = page.container.querySelector('input')!, dialog = () => page.container.querySelector('[role="alertdialog"]');
  const review = () => named(page.container, 'button', CS.missReview[0]);
  await act(async () => { type(field, '75'); });
  await act(async () => { click(review()); });
  focusOn(dialog()?.querySelector('p'), 'the confirmation opens on its sentence, not on «تأكيد السعر»');
  assert.match(words(dialog()!), /75 د\.ع/);
  // 75 is wrong: the owner clicks back into the field and types on, to 7,500. The first digit closes the confirmation…
  await act(async () => { type(field, '750'); });
  assert.ok(!dialog(), 'a changed price closes the confirmation');
  focusOn(field, 'and the focus stays where the owner types (it went to «راجِع وثبّت»)');
  // …and Enter — natural after typing — reopens nothing: the field is in no form, and «راجِع وثبّت» does not have the focus.
  await act(async () => { pressKey('Enter'); });
  assert.ok(!dialog(), 'Enter did not reopen the confirmation at 750 a piece');
  await act(async () => { type(field, '7500'); });
  assert.equal(field.value, '7500', 'the next digit lands in the field');
  // «راجِع وثبّت» reviews 7,500 a piece; «إلغاء» closes it and gives the focus back to «راجِع وثبّت».
  await act(async () => { click(review()); });
  assert.match(words(dialog()!), /7,500 د\.ع/);
  await act(async () => { click(named(dialog()!, 'button', 'إلغاء')); });
  assert.ok(!dialog());
  focusOn(review(), '«إلغاء»: the focus back on «راجِع وثبّت»');
  // Escape, from the sentence the confirmation opens on, too.
  await act(async () => { click(review()); });
  await act(async () => { pressKey('Escape'); });
  assert.ok(!dialog());
  focusOn(review(), 'Escape: the focus back on «راجِع وثبّت»');
  await page.unmount();
});

// ------------------------------------------------------------------ المصاريف العامة

// One invented world for the page's tests (each world builds every migration: seconds apiece). They run in this order, each
// seeding what it reads: the empty period first, then the entries the later ones add.
const w = world();
const pageOf = () => h(GeneralExpenses, { from, to, onChanged: noop, openOrder: noop, onPromotion: noop });
const form = (root: FakeElement) => root.querySelector('form[data-finance-expense-form]')!;
/** What an element says, or null when it is not on the page. */
const said = (el: FakeElement | null) => (el ? words(el) : null);
/** The page's «أضف»: the empty state's while the period has no general expense, else «أضف مصروفًا». */
const addButton = (root: FakeElement) => root.querySelector('[data-finance-expenses-add-empty]') ?? root.querySelector('[data-finance-expenses-add]')!;

test('the ledger\'s form embedded on the page: pressed untouched, or Enter in a field, it names the problem and sends nothing; filled, it records the entry', async () => {
  const io = serve(w), page = await mount(pageOf());
  await io.settle();
  // An empty period: the empty state's «أضف» opens the ledger's own form.
  await act(async () => { click(page.container.querySelector('[data-finance-expenses-add-empty]')!); });
  await io.settle();
  const add = () => named(form(page.container), 'button', s.save), problem = () => form(page.container).querySelector('[data-finance-expense-problem]');
  assert.equal(add().disabled, false, 'an untouched form offers its «احفظ» (it was disabled with nothing said)');
  assert.ok(!problem(), 'and shows no red line before anything is typed');
  await act(async () => { click(add()); });
  assert.equal(said(problem()), s.errAmountNotNumber, 'pressed, it names what is missing');
  assert.equal(add().disabled, true, 'and only then holds the button, with its reason beside it');
  assert.deepEqual(io.writes(), [], 'nothing was sent');
  // Filled, it records the entry through the old ledger's route, as before.
  await act(async () => { type(named(form(page.container), 'label', s.fieldAmount).querySelector('input')!, '25000'); });
  assert.ok(!problem());
  await act(async () => { click(add()); });
  await io.settle();
  assert.deepEqual(io.writes().map((r) => [r.method, r.path, (r.body as { amount_iqd: number }).amount_iqd]), [['POST', '/api/admin/finance/expenses', 25000]]);
  assert.equal((w.raw.prepare('SELECT COUNT(*) n FROM operating_expenses WHERE amount_iqd=25000 AND voided_at IS NULL').get() as { n: number }).n, 1);
  await page.unmount();
  // Enter in a field of an untouched form: the same — the problem said, nothing sent (a disabled default button swallowed it).
  const again = serve(w), second = await mount(pageOf());
  await again.settle();
  await act(async () => { click(second.container.querySelector('[data-finance-expenses-add]')!); });
  await again.settle();
  await act(async () => { click(named(form(second.container), 'label', s.fieldAmount).querySelector('input')!); });
  await act(async () => { pressKey('Enter'); });
  assert.equal(said(form(second.container).querySelector('[data-finance-expense-problem]')), s.errAmountNotNumber, 'Enter names the problem');
  assert.deepEqual(again.writes(), []);
  await second.unmount();
});

test('a category added twice says that it exists, in the reader\'s language — not «تعذّر الحفظ.» with no reason', async () => {
  w.raw.exec("INSERT INTO expense_categories(id,slug,name_ar) VALUES ('fix','صيانة','صيانة')");
  for (const [i, lang] of LANGS.entries()) {
    const io = serve(w), page = await mount(pageOf(), lang);
    await io.settle();
    await act(async () => { click(addButton(page.container)); });
    await io.settle();
    const local = financeStrings(inLang(lang));
    const name = page.container.querySelectorAll('input').find((el: FakeElement) => el.getAttribute('placeholder') === local.categoryNamePlaceholder)!;
    await act(async () => { type(name, 'صيانة'); });
    await act(async () => { click(named(page.container, 'button', local.newCategory)); });
    await io.settle();
    assert.deepEqual(io.writes().map((r) => [r.method, r.path]), [['POST', '/api/admin/finance/expense-categories']], `${lang}: one request`);
    const shown = words(page.container);
    assert.ok(!shown.includes(local.saveFailed), `${lang}: not the generic «${local.saveFailed}»`);
    assert.ok(shown.includes(CS.refCategoryExists[i]), `${lang}: «${CS.refCategoryExists[i]}» in «${shown.slice(-300)}»`);
    await page.unmount();
  }
});

test('an entry\'s editor kept open across a re-read sends only the field the owner changed: an amount corrected elsewhere meanwhile stays corrected', async () => {
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent','rent',85000,'${baghdadDay()}','Rent','admin')`);
  const io = serve(w), page = await mount(pageOf());
  await io.settle();
  const row = () => page.container.querySelector('li[data-finance-expense="rent"]')!;
  const editor = () => row().querySelector('[data-finance-expense-editor]')!;
  const field = (label: string) => named(editor(), 'label', label).querySelector('input')!;
  await act(async () => { click(row().querySelector('[data-finance-expense-edit]')!); });
  await io.settle();
  assert.equal(field(s.fieldAmount).value, '85000', 'the editor opens on the entry');
  // The owner changes only the description…
  await act(async () => { type(field(s.fieldTitle), 'Rent, shop'); });
  // …meanwhile the amount is corrected elsewhere (the old report's ledger, another tab): 90,000…
  w.raw.exec("UPDATE operating_expenses SET amount_iqd=90000 WHERE id='rent'");
  // …and the page reads its entries again while the editor stays open («أظهر الملغاة»; a refresh or another save does the same).
  await act(async () => { click(named(page.container, 'label', s.showVoided).querySelector('input')!); });
  await io.settle();
  assert.equal(field(s.fieldAmount).value, '90000', 'the field the owner never touched shows the entry as it now is');
  assert.equal(field(s.fieldTitle).value, 'Rent, shop', 'what the owner typed stays');
  assert.ok(words(editor()).includes(CS.genEditMoved[0]), 'and the editor says the entry changed since it opened');
  await act(async () => { click(named(editor(), 'button', CS.genSave[0])); });
  await io.settle();
  assert.deepEqual(io.writes().map((r) => [r.method, r.path, r.body]), [['PATCH', '/api/admin/finance/expenses/rent', { title: 'Rent, shop' }]], 'only the field the owner changed is sent');
  assert.deepEqual({ ...(w.raw.prepare("SELECT amount_iqd,title FROM operating_expenses WHERE id='rent'").get() as object) }, { amount_iqd: 90000, title: 'Rent, shop' },
    'the corrected amount stands (the edit wrote 85,000 back)');
  await page.unmount();
});
