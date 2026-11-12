/**
 * «المال والأرباح» → المحاسبة: THE BOOKS' OWN CHECKS ON THE PAGE (src/components/financeWorkspace/AccountingChecks.tsx; the
 * owner's brief, 2026-11-12, part 4).
 *
 * - The words: every check the server runs has a name and a sentence in three languages; the Sorani slot is neither the
 *   Arabic nor the English pasted across, has a Sorani letter and no Arabic-only one, and keeps the placeholders
 *   (DECISIONS row 183). The client's shape is the server's (a compile-time check over runFinanceChecks' answer).
 * - Mounted in the small browser over a fixed answer: the faults first, each row's chip, name, sentence, first ids — an
 *   order's id a button that opens its sheet, any other id plain — «and n more», the count and its money; nothing found is
 *   one line; a check that could not run says so and «افحص الآن» reads again; the time is Baghdad's.
 *
 * Every figure is invented. Run: node --import tsx --test tests/accountingChecksPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { click, installDom, named, words, type FakeElement } from './fixtures/miniDom';
import { freshDb, asD1 } from './fixtures/app';
import { FINANCE_CHECKS, runFinanceChecks } from '../worker/lib/financeChecks';
import type { FinanceChecksAnswer } from '../src/components/financeWorkspace/types';

const dom = installDom();
let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };

const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LanguageProvider } = await import('../src/LanguageContext');
const { default: AccountingChecks } = await import('../src/components/financeWorkspace/AccountingChecks');
const { AS } = await import('../src/components/financeWorkspace/accountingStrings');

test('the words: every check has a name and a sentence, and the Sorani is its own', () => {
  for (const c of FINANCE_CHECKS) assert.ok(c.key in AS && `${c.key}Note` in AS, `${c.key} has its words`);
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, [ar, en, ckb]] of Object.entries(AS)) {
    if (key === 'count') continue;
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: no Arabic-only letter`);
    assert.equal(ph(ckb), ph(ar), `${key}: placeholders`);
    assert.equal(ph(en), ph(ar), `${key}: placeholders`);
  }
});

test('the client reads the server’s answer as it is (a compile-time check)', async () => {
  const answer: FinanceChecksAnswer = await runFinanceChecks(asD1(freshDb()));
  assert.equal(answer.checks.length, FINANCE_CHECKS.length);
});

const ANSWER: FinanceChecksAnswer = {
  checked_at: '2026-11-12T06:05:00.000Z',
  ok: false,
  checks: [
    { key: 'journal_unbalanced', severity: 'error', count: 0, amount_iqd: 0, sample: [] },
    { key: 'walk_backs', severity: 'warning', count: 7, amount_iqd: 28000, sample: ['ORD-0B00000001', 'ORD-0B00000002', 'ORD-0B00000003', 'ORD-0B00000004', 'ORD-0B00000005'] },
    { key: 'posting_errors', severity: 'error', count: 1, amount_iqd: null, sample: ['ORD-0A00000003'] },
    { key: 'pending_cost_months', severity: 'warning', count: 1, amount_iqd: null, sample: ['2026-10'] },
  ],
};

function serve(answers: Array<FinanceChecksAnswer | 'fail'>) {
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    const next = answers.length > 1 ? answers.shift()! : answers[0];
    if (next === 'fail') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ success: true, ...next }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}
async function mount(lang: 'ar' | 'en' | 'ckb', opened: string[] = []) {
  LANG = lang;
  const container = dom.container();
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(h(LanguageProvider, null, h(AccountingChecks, { onOpenOrder: (id: string) => opened.push(id) }))); });
  const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setImmediate(r)); }); };
  await settle();
  return { container, settle, unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); LANG = 'ar'; } };
}
const rowsOf = (c: FakeElement) => c.querySelectorAll('li[data-finance-check]') as unknown as FakeElement[];

test('found: the faults first, each with its chip, its words, its first ids, «and n more», its count and its money', async () => {
  const sent = serve([ANSWER]);
  const opened: string[] = [];
  const page = await mount('ar', opened);
  assert.deepEqual(sent, ['/api/admin/finance-workspace/accounting-checks']);
  const rows = rowsOf(page.container);
  assert.deepEqual(rows.map((r) => [r.getAttribute('data-finance-check'), r.getAttribute('data-finance-check-severity')]),
    [['posting_errors', 'error'], ['walk_backs', 'warning'], ['pending_cost_months', 'warning']], 'nothing found is no row; the fault first');
  const walk = words(rows[1]);
  for (const part of [AS.look[0], AS.walk_backs[0], AS.walk_backsNote[0], 'ORD-0B00000001', 'و2 غيرها', '7 · 28,000 د.ع']) assert.ok(walk.includes(part), `«${part}» in «${walk}»`);
  assert.ok(words(rows[0]).includes(AS.fault[0]));
  assert.ok(words(rows[0]).endsWith('1'), 'a count, no money, where it is not money');
  // An order's id opens its sheet; a month is named, not a button.
  click(named(rows[1] as unknown as FakeElement, 'button', 'ORD-0B00000002'));
  assert.deepEqual(opened, ['ORD-0B00000002']);
  assert.equal((rows[2].querySelectorAll('button') as unknown as FakeElement[]).length, 0);
  assert.ok(words(page.container).includes('فُحص 09:05'), 'the Baghdad time it was checked');
  await page.unmount();
});

test('in English and Sorani, the same rows in their own words', async () => {
  for (const [lang, i] of [['en', 1], ['ckb', 2]] as const) {
    serve([ANSWER]);
    const page = await mount(lang);
    const rows = rowsOf(page.container);
    assert.ok(words(rows[0]).includes(AS.posting_errors[i]) && words(rows[0]).includes(AS.fault[i]), lang);
    assert.ok(words(rows[1]).includes(AS.walk_backs[i]) && words(rows[1]).includes(AS.look[i]), lang);
    await page.unmount();
  }
});

test('nothing found is one line; a check that could not run says so, and «افحص الآن» reads again', async () => {
  serve([{ ...ANSWER, ok: true, checks: ANSWER.checks.map((c) => ({ ...c, count: 0, sample: [] })) }]);
  let page = await mount('ar');
  assert.equal(rowsOf(page.container).length, 0);
  assert.ok(page.container.querySelector('[data-finance-checks-clear]'));
  await page.unmount();

  const sent = serve(['fail', ANSWER]);
  page = await mount('ar');
  assert.ok(words(page.container).includes(AS.failed[0]));
  click(page.container.querySelector('[data-finance-checks-again]') as unknown as FakeElement);
  await page.settle();
  assert.equal(sent.length, 2, 'read again');
  assert.equal(rowsOf(page.container).length, 3);
  await page.unmount();
});
