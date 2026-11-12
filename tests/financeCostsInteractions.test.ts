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
 * The checker of the second review added:
 * - an expense whose answer is lost on the way back (the server recorded it) is not said to have failed: the page says it may
 *   be recorded, reads itself again and lists it, and the amount is cleared — a second press records nothing (it said
 *   «تعذّر الحفظ.» with 600,000 still typed, and a second press recorded the rent twice);
 * - an editor reopened right after its save, before the page's re-read arrives, does not call the owner's own save a change
 *   made elsewhere — and still names one that was;
 * - a press on the untouched form's «احفظ» puts the focus on the field the problem names (the held button dropped it to the
 *   page);
 * - the small browser's single select keeps one option chosen (the editor's category follows a re-read), and a control held
 *   while it has the focus gives it up to the page.
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
const { createElement: h, act, useState } = await import('react');
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

/** Which requests the transport treats apart (see `serve`). */
type Which = (method: string, path: string) => boolean;
/**
 * The owner's app over a world's database, the routes at their own paths; every request the pages send goes through it.
 * `lose`: the server answers those, and the answer is lost on the way back (the API client's NETWORK). `hold`: their answers
 * wait, outside what settle() waits for, until `release()` — a slow re-read.
 */
function serve(w: ReturnType<typeof world>, { lose, hold }: { lose?: Which; hold?: Which } = {}) {
  const app = stubApp(w.db, { id: 'admin', email: 'boss@x.co', role: 'admin', admin_scope: 'full' }, (a) => {
    a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes);
    a.route('/api/admin/finance', adminFinanceRoutes);
  });
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const inflight = new Set<Promise<unknown>>();
  const held: Array<() => void> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    sent.push({ method, path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const answer = Promise.resolve(app.request(path, { method, headers: { ...(init?.headers as Record<string, string>), 'CF-Connecting-IP': '1.2.3.4' }, body: init?.body }, undefined, ctx));
    inflight.add(answer);
    let res: Response;
    try { res = await answer; } finally { inflight.delete(answer); }
    if (lose?.(method, path)) throw new TypeError('Failed to fetch');
    if (hold?.(method, path)) await new Promise<void>((resolve) => held.push(resolve));
    return res;
  }) as typeof fetch;
  /** Until every request the page started has its answer drawn. */
  const settle = async () => {
    for (let idle = 0, rounds = 0; idle < 3; rounds++) {
      assert.ok(rounds < 200, 'the page settles');
      await act(async () => { await Promise.allSettled([...inflight]); await new Promise((r) => setImmediate(r)); });
      idle = inflight.size === 0 ? idle + 1 : 0;
    }
  };
  /** The held answers arrive, and the page draws them. */
  const release = async () => {
    assert.ok(held.length > 0, 'an answer was held');
    await act(async () => { for (const go of held.splice(0)) go(); await new Promise((r) => setImmediate(r)); });
    await settle();
  };
  return { sent, settle, release, writes: () => sent.filter((r) => r.method !== 'GET') };
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

// ------------------------------------------------------------------ the small browser

test('the small browser: a single select keeps one option chosen, and a control held while it has the focus gives it up to the page', () => {
  const doc = dom.document, select = doc.createElement('select');
  const [rent, power, other] = ['rent', 'power', 'other'].map((v) => { const o = doc.createElement('option'); o.setAttribute('value', v); return select.appendChild(o); });
  rent.selected = true;
  // react-dom marks only the option it chooses, and leaves clearing the one chosen before to the browser.
  power.selected = true;
  assert.deepEqual([rent.selected, power.selected, other.selected], [false, true, false], 'choosing one clears the one chosen before');
  assert.equal(select.value, 'power');
  const box = dom.container(), button = box.appendChild(doc.createElement('button'));
  button.focus();
  assert.equal(doc.activeElement, button);
  button.setAttribute('disabled', '');
  assert.equal(doc.activeElement, doc.body, 'held, the button gives the focus up to the page (HTML\'s focus fixup)');
  button.removeAttribute('disabled');
  assert.equal(doc.activeElement, doc.body, 'and does not take it back');
  box.parentNode?.removeChild(box);
});

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
/** The page as the workspace mounts it: a write's onChanged reads every figure again (`revision`), the page's entries with them. */
function Workspace() {
  const [revision, setRevision] = useState(0);
  return h(GeneralExpenses, { from, to, revision, onChanged: () => setRevision((v) => v + 1), openOrder: noop, onPromotion: noop });
}
const form = (root: FakeElement) => root.querySelector('form[data-finance-expense-form]')!;
/** The form's field under the label that reads `label`. */
const fieldOf = (root: FakeElement, label: string) => named(form(root), 'label', label).querySelector('input')!;
/** What an element says, or null when it is not on the page. */
const said = (el: FakeElement | null) => (el ? words(el) : null);
/** The page's «أضف»: the empty state's while the period has no general expense, else «أضف مصروفًا». */
const addButton = (root: FakeElement) => root.querySelector('[data-finance-expenses-add-empty]') ?? root.querySelector('[data-finance-expenses-add]')!;
const rowsTitled = (title: string) => (w.raw.prepare('SELECT id FROM operating_expenses WHERE title=? AND voided_at IS NULL').all(title) as Array<{ id: string }>).map((r) => r.id);

test('the ledger\'s form embedded on the page: pressed untouched, or Enter in a field, it names the problem, puts the focus on its field and sends nothing; filled, it records the entry', async () => {
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
  // The press held the very button the focus was on, which gives the focus up to the page: the next Tab started at the top.
  focusOn(fieldOf(page.container, s.fieldAmount), 'the focus goes to the field the problem names, not to the page');
  assert.deepEqual(io.writes(), [], 'nothing was sent');
  // Filled, it records the entry through the old ledger's route, as before.
  await act(async () => { type(fieldOf(page.container, s.fieldAmount), '25000'); });
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
  await act(async () => { click(fieldOf(second.container, s.fieldTitle)); });
  await act(async () => { pressKey('Enter'); });
  assert.equal(said(form(second.container).querySelector('[data-finance-expense-problem]')), s.errAmountNotNumber, 'Enter names the problem');
  focusOn(fieldOf(second.container, s.fieldAmount), 'Enter in the description puts the focus on the amount it names');
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

test('an entry\'s editor kept open across a re-read sends only the field the owner changed: an amount and a category corrected elsewhere meanwhile stay corrected', async () => {
  w.raw.exec("INSERT INTO expense_categories(id,slug,name_ar,sort) VALUES ('power','power','كهرباء',999)");
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('rent','rent',85000,'${baghdadDay()}','Rent','admin')`);
  const io = serve(w), page = await mount(pageOf());
  await io.settle();
  const row = () => page.container.querySelector('li[data-finance-expense="rent"]')!;
  const editor = () => row().querySelector('[data-finance-expense-editor]')!;
  const field = (label: string) => named(editor(), 'label', label).querySelector('input')!;
  const category = () => named(editor(), 'label', s.fieldCategory).querySelector('select')!;
  await act(async () => { click(row().querySelector('[data-finance-expense-edit]')!); });
  await io.settle();
  assert.equal(field(s.fieldAmount).value, '85000', 'the editor opens on the entry');
  assert.equal(category().value, 'rent');
  // The owner changes only the description…
  await act(async () => { type(field(s.fieldTitle), 'Rent, shop'); });
  // …meanwhile the amount and the category are corrected elsewhere (the old report's ledger, another tab): 90,000, power…
  w.raw.exec("UPDATE operating_expenses SET amount_iqd=90000, category_id='power' WHERE id='rent'");
  // …and the page reads its entries again while the editor stays open («أظهر الملغاة»; a refresh or another save does the same).
  await act(async () => { click(named(page.container, 'label', s.showVoided).querySelector('input')!); });
  await io.settle();
  assert.equal(field(s.fieldAmount).value, '90000', 'the field the owner never touched shows the entry as it now is');
  // The rent option comes first in the select: a browser that kept it chosen beside power would read 'rent' here.
  assert.ok(category().querySelectorAll('option').findIndex((o: FakeElement) => o.value === 'rent') < category().querySelectorAll('option').findIndex((o: FakeElement) => o.value === 'power'));
  assert.equal(category().value, 'power', 'and so does the category');
  assert.equal(field(s.fieldTitle).value, 'Rent, shop', 'what the owner typed stays');
  assert.ok(words(editor()).includes(CS.genEditMoved[0]), 'and the editor says the entry changed since it opened');
  await act(async () => { click(named(editor(), 'button', CS.genSave[0])); });
  await io.settle();
  assert.deepEqual(io.writes().map((r) => [r.method, r.path, r.body]), [['PATCH', '/api/admin/finance/expenses/rent', { title: 'Rent, shop' }]], 'only the field the owner changed is sent');
  assert.deepEqual({ ...(w.raw.prepare("SELECT amount_iqd,category_id,title FROM operating_expenses WHERE id='rent'").get() as object) }, { amount_iqd: 90000, category_id: 'power', title: 'Rent, shop' },
    'the corrected amount stands (the edit wrote 85,000 back)');
  await page.unmount();
});

test('an expense whose answer is lost on the way back is not said to have failed: the page says it may be recorded, reads itself again and lists it, and clears the amount — a second press records nothing, and the same entry typed again is recorded once (its operation, the owner’s brief 2026-11-12)', async () => {
  for (const [i, lang] of LANGS.entries()) {
    const io = serve(w, { lose: (method, path) => method === 'POST' && path === '/api/admin/finance/expenses' });
    const page = await mount(h(Workspace), lang);
    await io.settle();
    await act(async () => { click(addButton(page.container)); });
    await io.settle();
    const local = financeStrings(inLang(lang)), title = `Shop rent, answer lost (${lang})`;
    await act(async () => { type(fieldOf(page.container, local.fieldAmount), '600000'); });
    await act(async () => { type(fieldOf(page.container, local.fieldTitle), title); });
    const before = io.sent.length;
    await act(async () => { click(named(form(page.container), 'button', local.save)); });
    await io.settle();
    // The server recorded the rent; only its answer was lost.
    const [id] = rowsTitled(title);
    assert.ok(id, `${lang}: the server recorded it`);
    const shown = words(form(page.container));
    assert.ok(!shown.includes(local.saveFailed), `${lang}: not «${local.saveFailed}» — the rent was recorded, in «${shown.slice(-200)}»`);
    assert.ok(shown.includes(CS.refUnanswered[i]), `${lang}: «${CS.refUnanswered[i]}»`);
    // The page read its entries again, and lists the rent that landed.
    assert.ok(io.sent.slice(before).some((r) => r.method === 'GET' && r.path.startsWith('/api/admin/finance-workspace/expenses?')), `${lang}: the page read its entries again`);
    assert.ok(page.container.querySelector(`li[data-finance-expense="${id}"]`), `${lang}: and lists the rent the server recorded`);
    assert.equal(fieldOf(page.container, local.fieldAmount).value, '', `${lang}: the amount is cleared (600,000 stood ready for a second press)`);
    // A second press records nothing until the amount is typed again.
    await act(async () => { click(named(form(page.container), 'button', local.save)); });
    await io.settle();
    assert.deepEqual(io.writes().map((r) => [r.method, r.path]), [['POST', '/api/admin/finance/expenses']], `${lang}: one write`);
    assert.equal(rowsTitled(title).length, 1, `${lang}: one rent of 600,000, not two`);
    // Typed again — the same entry — and pressed: the server is asked once more, with the same operation, and its answer
    // (lost again) is the first one's rows: nothing new is recorded.
    await act(async () => { type(fieldOf(page.container, local.fieldAmount), '600000'); });
    await act(async () => { click(named(form(page.container), 'button', local.save)); });
    await io.settle();
    const posts = io.writes().filter((r) => r.method === 'POST' && r.path === '/api/admin/finance/expenses');
    assert.equal(posts.length, 2, `${lang}: asked again`);
    const ops = posts.map((r) => (r.body as { operation_id?: string }).operation_id);
    assert.ok(ops[0] && ops[0] === ops[1], `${lang}: with the same operation (${ops.join(' / ')})`);
    assert.equal(rowsTitled(title).length, 1, `${lang}: still one rent of 600,000`);
    await page.unmount();
  }
});

test('an editor reopened right after its save, before the page\'s re-read arrives, does not call the owner\'s own save a change made elsewhere — and still names one that was', async () => {
  w.raw.exec(`INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by) VALUES ('water','rent',12000,'${baghdadDay()}','Water','admin')`);
  let slow = false;
  const io = serve(w, { hold: (method, path) => slow && method === 'GET' && path.startsWith('/api/admin/finance-workspace/expenses?') });
  const page = await mount(h(Workspace));
  await io.settle();
  const row = () => page.container.querySelector('li[data-finance-expense="water"]')!;
  const editor = () => row().querySelector('[data-finance-expense-editor]');
  const field = (label: string) => named(editor()!, 'label', label).querySelector('input')!;
  const edit = async () => { await act(async () => { click(row().querySelector('[data-finance-expense-edit]')!); }); await io.settle(); };
  const save = async () => { await act(async () => { click(named(editor()!, 'button', CS.genSave[0])); }); await io.settle(); };
  await edit();
  await act(async () => { type(field(s.fieldTitle), 'Water, tank'); });
  // The page's re-read after the save is slow to come back, and the owner opens the editor again before it does.
  slow = true;
  await save();
  assert.equal(editor(), null, 'the save closed the editor');
  await edit();
  slow = false;
  await io.release();
  assert.equal(field(s.fieldTitle).value, 'Water, tank', 'the editor follows the entry: the description just saved');
  assert.ok(!words(editor()!).includes(CS.genEditMoved[0]), 'and does not call the owner\'s own save a change made elsewhere');
  await act(async () => { type(field(s.fieldAmount), '13000'); });
  await save();
  assert.deepEqual(io.writes().map((r) => r.body), [{ title: 'Water, tank' }, { amount_iqd: 13000 }], 'each save sends only what it changed');
  // The same window with a change made elsewhere too: the description saved again while another screen corrects the amount.
  await edit();
  await act(async () => { type(field(s.fieldTitle), 'Water, tank 2'); });
  w.raw.exec("UPDATE operating_expenses SET amount_iqd=14000 WHERE id='water'");
  slow = true;
  await save();
  await edit();
  slow = false;
  await io.release();
  assert.equal(field(s.fieldAmount).value, '14000', 'the amount corrected elsewhere');
  assert.equal(field(s.fieldTitle).value, 'Water, tank 2', 'the description the owner saved');
  assert.ok(words(editor()!).includes(CS.genEditMoved[0]), 'and the change made elsewhere is named');
  assert.deepEqual({ ...(w.raw.prepare("SELECT amount_iqd,title FROM operating_expenses WHERE id='water'").get() as object) }, { amount_iqd: 14000, title: 'Water, tank 2' });
  await page.unmount();
});
