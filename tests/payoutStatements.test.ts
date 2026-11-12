/**
 * «المال والأرباح» → الأشخاص والدفعات → «الكشوف» (DECISIONS row 336; GET /statements; PayoutStatements.tsx).
 *
 * The server lists the period's staff payments and its withdrawals — not a rejected or cancelled one, nor one of another
 * period — newest first, with the person; the page shows them with each one's statement as Excel and PDF in the reader's
 * language, and says so when a list is empty; the words keep the Sorani rules (DECISIONS row 183).
 *
 * Every figure is invented. Run: node --import tsx --test tests/payoutStatements.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, words, type FakeElement } from './fixtures/miniDom';
import { period, world } from './fixtures/financeWorld';
import { baghdadDay } from '../worker/lib/operations';
import { PS } from '../src/components/financeWorkspace/statementsStrings';
import type { PayoutStatementsAnswer } from '../src/components/financeWorkspace/PayoutStatements';

const dom = installDom();
let LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };
const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LanguageProvider } = await import('../src/LanguageContext');
const { default: PayoutStatements } = await import('../src/components/financeWorkspace/PayoutStatements');

test('the words keep the Sorani rules', () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, [ar, en, ckb]] of Object.entries(PS)) {
    assert.notEqual(ckb, ar, key);
    assert.notEqual(ckb, en, key);
    assert.match(ckb, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: no Arabic-only letter`);
    assert.equal(ph(ckb), ph(ar), key);
  }
});

test('the server: the period’s staff payments and withdrawals, newest first — never a rejected or cancelled one', async () => {
  const w = world();
  const day = baghdadDay(), now = new Date().toISOString();
  w.raw.exec(`UPDATE finance_staff SET name='موظف تجريبي' WHERE id='staff_sajjad';
    INSERT INTO users(id,email,name,role) VALUES ('inv1','inv1@x.co','مستثمر تجريبي','customer');
    INSERT INTO finance_staff_payments(id,staff_id,amount_iqd,kind,payment_day,note,actor_id,created_at) VALUES
      ('pay-a','staff_sajjad',6500,'payment','${day}','','admin','${day}T07:00:00.000Z'),
      ('adv-b','staff_sajjad',5000,'advance','${day}','','admin','${day}T09:00:00.000Z'),
      ('pay-old','staff_sajjad',1000,'payment','2024-01-05','','admin','2024-01-05T09:00:00.000Z');
    INSERT INTO finance_withdrawals(id,user_id,amount_iqd,paid_iqd,balance_type,state,created_at,updated_at) VALUES
      ('wd-paid','inv1',28000,28000,'earnings','paid','${now}','${now}'),
      ('wd-rej','inv1',9000,0,'earnings','rejected','${now}','${now}'),
      ('wd-can','inv1',9000,0,'earnings','cancelled','${now}','${now}'),
      ('wd-old','inv1',9000,9000,'earnings','paid','2024-01-05T09:00:00.000Z','2024-01-05T09:00:00.000Z');`);
  const b = await w.read(`/f/statements?${period()}`);
  assert.deepEqual(b.staff_payments.map((p: Record<string, unknown>) => [p.id, p.kind, p.amount_iqd, p.person]), [
    ['adv-b', 'advance', 5000, 'موظف تجريبي'], ['pay-a', 'payment', 6500, 'موظف تجريبي'],
  ], 'newest first; another period’s payment is not listed');
  assert.deepEqual(b.withdrawals.map((x: Record<string, unknown>) => [x.id, x.state, x.paid_iqd, x.person]), [['wd-paid', 'paid', 28000, 'مستثمر تجريبي']]);
});

const ANSWER: PayoutStatementsAnswer = {
  staff_payments: [{ id: 'pay-a', kind: 'payment', day: '2026-11-12', amount_iqd: 6500, person: 'موظف تجريبي' }],
  withdrawals: [{ id: 'wd-1', state: 'part_paid', day: '2026-11-10', amount_iqd: 28000, paid_iqd: 10000, person: 'مستثمر تجريبي' }],
};
function serve(answer: PayoutStatementsAnswer) {
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    return new Response(JSON.stringify({ success: true, ...answer }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}
async function mount(lang: 'ar' | 'en' | 'ckb') {
  LANG = lang;
  const container = dom.container();
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(h(LanguageProvider, null, h(PayoutStatements, { from: '2026-11-01', to: '2026-11-30' }))); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setImmediate(r)); });
  return { container, unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); LANG = 'ar'; } };
}
const q = (c: FakeElement, sel: string) => c.querySelector(sel) as unknown as FakeElement;

test('the page: each payout with its statement as Excel and PDF, in the reader’s language; an empty list says so', async () => {
  const sent = serve(ANSWER);
  const page = await mount('en');
  assert.match(sent[0], /\/api\/admin\/finance-workspace\/statements\?from=2026-11-01&to=2026-11-30$/);
  const links = (sel: string) => (q(page.container, sel).querySelectorAll('a') as unknown as FakeElement[]).map((a) => a.getAttribute('href'));
  assert.deepEqual(links('[data-payout-statement="pay-a"]'), [
    '/api/admin/finance-workspace/statements/staff-payments/pay-a/export.xlsx?lang=en',
    '/api/admin/finance-workspace/statements/staff-payments/pay-a/print?lang=en',
  ]);
  assert.deepEqual(links('[data-payout-statement="wd-1"]'), [
    '/api/admin/finance-workspace/statements/withdrawals/wd-1/export.xlsx?lang=en',
    '/api/admin/finance-workspace/statements/withdrawals/wd-1/print?lang=en',
  ]);
  assert.match(words(q(page.container, '[data-payout-withdrawals]')), /Part paid/);
  await page.unmount();
  serve({ staff_payments: [], withdrawals: [] });
  const empty = await mount('ar');
  assert.match(words(q(empty.container, '[data-payout-none="staff"]')), /لا دفعات لموظفين في الفترة/);
  assert.match(words(q(empty.container, '[data-payout-none="withdrawals"]')), /لا سحوبات في الفترة/);
  await empty.unmount();
});
