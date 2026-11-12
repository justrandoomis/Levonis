/**
 * «سجل العمليات المالية» — THE FINANCE ACTIVITY LOG (the owner's brief, 2026-11-12, part 4: «audit logs … traceable»;
 * GET /api/admin/finance-workspace/activity and src/components/financeWorkspace/AccountingActivity.tsx; DECISIONS row 328).
 *
 * - The words: every action a finance write can leave (each finance, investment and accounting action the worker writes,
 *   the withdrawal states' template, and the admin's wallet acts the log reads) has its sentence in three languages; the
 *   Sorani slot is its own (DECISIONS row 183).
 * - The route: the period's finance rows, newest first, with the person's name; a member's own wallet request and any other
 *   family are not finance activity; the system's own rows only with `auto=1`; `q` finds a target, a detail or a name; fifty
 *   a page and `before` for the next; an assistant is refused.
 * - The page, mounted in the small browser over fixed answers: each row's sentence, its Baghdad time, the person or «النظام»,
 *   the order it concerns (its own id or the one its detail names) as a button that opens its sheet, «before ← after» in the
 *   reader's direction or the amount, and the note line; on a phone, the same acts as a list with their money in view; the
 *   search is sent once the typing stops; the switch adds the system's rows; «المزيد» adds the next page under the first.
 *
 * Every figure is invented. Run: node --import tsx --test tests/accountingActivityPage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { click, installDom, named, type, words, type FakeElement } from './fixtures/miniDom';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import { adminFinanceWorkspaceRoutes, ACTIVITY_WALLET_ACTIONS } from '../worker/routes/adminFinanceWorkspace';

const dom = installDom();
const LANG: 'ar' | 'en' | 'ckb' = 'ar';
(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => (k === 'levo_lang' ? LANG : null), setItem: () => {}, removeItem: () => {} };

const { createElement: h, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { LanguageProvider } = await import('../src/LanguageContext');
const { default: AccountingActivity, activityMoney, activityNote, activityOrder } = await import('../src/components/financeWorkspace/AccountingActivity');
const { AAS, ACTION_WORDS } = await import('../src/components/financeWorkspace/activityStrings');

function sourceOf(dir: string): string {
  return readdirSync(dir).map((name) => join(dir, name))
    .map((p) => (statSync(p).isDirectory() ? sourceOf(p) : p.endsWith('.ts') ? readFileSync(p, 'utf8') : '')).join('\n');
}

test('the words: every action the log can hold has its sentence, and the Sorani is its own', () => {
  const src = sourceOf('worker');
  const written = [...new Set([...src.matchAll(/['`]((?:finance|investment|accounting)\.[a-z_.]+)['`]/g)].map((m) => m[1]))];
  assert.ok(written.length >= 45, `${written.length} actions found`);
  const all = [...written, 'finance.withdrawal_approved', 'finance.withdrawal_rejected', 'finance.withdrawal_cancelled',
    'operations.permission_changed', 'stock.lot_cost_adjusted', ...ACTIVITY_WALLET_ACTIONS];
  for (const a of all) assert.ok(a in ACTION_WORDS, `${a} has no sentence`);
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [key, [ar, en, ckb]] of [...Object.entries(AAS), ...Object.entries(ACTION_WORDS)]) {
    assert.notEqual(ckb, ar, `${key}: the Arabic in the Sorani slot`);
    assert.notEqual(ckb, en, `${key}: the English in the Sorani slot`);
    assert.match(ckb, /[ڕڵێۆەڤگچپژیک]/, `${key}: a Sorani letter`);
    assert.doesNotMatch(ckb, /[ةىيك]/, `${key}: no Arabic-only letter`);
    assert.equal(ph(ckb), ph(ar), key);
  }
});

// ═══════════════════════════════════════════════ the route

function world() {
  const raw = freshDb();
  raw.exec("INSERT INTO users(id,name,email,role) VALUES ('boss','المالك','boss@x.co','admin'),('helper','مساعد','h@x.co','admin'),('u1','زبون','u1@x.co','customer')");
  const ins = raw.prepare('INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)');
  // 10 Nov 23:30 Baghdad (20:30Z) is in the 10th; 11 Nov 00:10 Baghdad (21:10Z of the 10th) is the 11th.
  ins.run('boss', 'finance.collection_recorded', 'col-1', JSON.stringify({ order_id: 'ORD-0D00000001', amount_iqd: 5000, fee_iqd: 1000, net_iqd: 4000, reference: 'AZ-77' }), '2026-11-10T20:30:00.000Z');
  ins.run('boss', 'finance.expense.create', 'exp-1', JSON.stringify({ amount_iqd: 450000, title: 'إيجار' }), '2026-11-10T21:10:00.000Z');
  ins.run(null, 'finance.staff_cost_materialized', 'cost-1', JSON.stringify({ amount_iqd: 2500, order_id: 'ORD-0D00000001' }), '2026-11-11T08:00:00.000Z');
  ins.run('u1', 'wallet.deposit.requested', 'dep-1', JSON.stringify({ amount_iqd: 100000 }), '2026-11-11T09:00:00.000Z');
  ins.run('boss', 'wallet.deposit.approved', 'dep-1', JSON.stringify({ amount_iqd: 100000 }), '2026-11-11T09:05:00.000Z');
  ins.run('boss', 'order.status', 'ORD-0D00000001', '{}', '2026-11-11T09:10:00.000Z');
  ins.run('boss', 'finance.order_adjusted', 'ORD-0D00000002', JSON.stringify({ field: 'cogs_iqd', before_iqd: 30000, after_iqd: 28000 }), '2026-11-12T07:00:00.000Z');
  const as = (who: { id: string; email: string; admin_scope?: string }) => stubApp(asD1(raw), { ...who, role: 'admin' }, (a) => a.route('/api/admin/finance-workspace', adminFinanceWorkspaceRoutes));
  return { raw, owner: as({ id: 'boss', email: 'boss@x.co' }), helper: as({ id: 'helper', email: 'h@x.co', admin_scope: 'assistant' }) };
}
const actions = (body: Record<string, unknown>) => (body.rows as Array<{ action: string }>).map((r) => r.action);

test('the route: the period’s finance rows, newest first, named; the system only on asking; a search; an assistant refused', async () => {
  const { owner, helper } = world();
  const all = await json(await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-10&to=2026-11-12'));
  assert.equal(all.success, true, JSON.stringify(all).slice(0, 300));
  assert.deepEqual(actions(all), ['finance.order_adjusted', 'wallet.deposit.approved', 'finance.expense.create', 'finance.collection_recorded'],
    'newest first; a member’s own request, another family and the system’s own rows are not in it');
  assert.equal((all.rows as Array<{ actor_name: string }>)[0].actor_name, 'المالك');
  assert.equal(all.next, null);
  // Baghdad days: 00:10 on the 11th is the 11th, 23:30 on the 10th the 10th.
  assert.deepEqual(actions(await json(await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-11&to=2026-11-11'))), ['wallet.deposit.approved', 'finance.expense.create']);
  assert.deepEqual(actions(await json(await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-10&to=2026-11-12&auto=1'))),
    ['finance.order_adjusted', 'wallet.deposit.approved', 'finance.staff_cost_materialized', 'finance.expense.create', 'finance.collection_recorded']);
  assert.deepEqual(actions(await json(await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-10&to=2026-11-12&q=AZ-77'))), ['finance.collection_recorded'], 'a reference');
  assert.deepEqual(actions(await json(await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-10&to=2026-11-12&q=ORD-0D00000002'))), ['finance.order_adjusted'], 'an order');
  assert.equal((await get(helper, '/api/admin/finance-workspace/activity?from=2026-11-10&to=2026-11-12')).status, 403);
  assert.equal((await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-10&to=2026-11-12&before=-4')).status, 400);
});

test('the route: fifty a page, and `before` for the next', async () => {
  const { raw, owner } = world();
  const ins = raw.prepare('INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 60; i++) ins.run('boss', 'finance.cost_approved', `cost-${i}`, '{}', `2026-11-12T08:${String(i % 60).padStart(2, '0')}:00.000Z`);
  const first = await json(await get(owner, '/api/admin/finance-workspace/activity?from=2026-11-12&to=2026-11-12'));
  assert.equal((first.rows as unknown[]).length, 50);
  assert.ok(typeof first.next === 'number');
  const second = await json(await get(owner, `/api/admin/finance-workspace/activity?from=2026-11-12&to=2026-11-12&before=${first.next}`));
  assert.equal((second.rows as unknown[]).length, 11, '60 approvals and the correction');
  assert.equal(second.next, null);
  const ids = [...(first.rows as Array<{ id: number }>), ...(second.rows as Array<{ id: number }>)].map((r) => r.id);
  assert.equal(new Set(ids).size, 61, 'no row twice');
});

test('a row’s money, its order and its note, as its detail carries them', () => {
  assert.deepEqual(activityMoney({ before_iqd: 30000, after_iqd: 28000 }), { before: 30000, after: 28000 });
  assert.deepEqual(activityMoney({ amount_iqd: 5000, net_iqd: 4000 }), { value: 5000 });
  assert.deepEqual(activityMoney({ debit_iqd: 7000 }), { value: 7000 });
  assert.equal(activityMoney({ field: 'x' }), null);
  assert.equal(activityMoney(null), null);
  assert.equal(activityOrder({ target: 'ORD-0D00000002', detail: {} }), 'ORD-0D00000002');
  assert.equal(activityOrder({ target: 'col-1', detail: { order_id: 'ORD-0D00000001' } }), 'ORD-0D00000001', 'a collection concerns its order');
  assert.equal(activityOrder({ target: 'exp-1', detail: { order_id: 'not an order' } }), null);
  assert.equal(activityNote({ reason: 'قيد بالخطأ', title: 'x' }), 'قيد بالخطأ');
  assert.equal(activityNote({ reference: 'AZ-77' }), 'AZ-77');
  assert.equal(activityNote({ title: 'a'.repeat(120) }).length, 90);
});

// ═══════════════════════════════════════════════ the page

const ROW = (id: number, action: string, target: string, detail: unknown, actor: string | null, at: string) => ({ id, actor_id: actor, actor_name: actor ? 'المالك' : null, action, target, detail, at });
function serve(pages: Array<{ rows: unknown[]; next: number | null }>) {
  const sent: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    const next = pages.length > 1 ? pages.shift()! : pages[0];
    return new Response(JSON.stringify({ success: true, ...next }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return sent;
}
async function mount(opened: string[] = []) {
  const container = dom.container();
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => { root.render(h(LanguageProvider, null, h(AccountingActivity, { from: '2026-11-01', to: '2026-11-12', onOpenOrder: (id: string) => opened.push(id) }))); });
  const settle = async (ms = 0) => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  await settle();
  return { container, settle, unmount: async () => { await act(async () => { root.unmount(); }); container.parentNode?.removeChild(container); } };
}
const rowsOf = (c: FakeElement) => c.querySelectorAll('tr[data-finance-activity-row]') as unknown as FakeElement[];

test('the page: each row in words, its Baghdad time, the person or the system, an order that opens, the money, the note', async () => {
  const sent = serve([{ rows: [
    ROW(9, 'finance.order_adjusted', 'ORD-0D00000002', { before_iqd: 30000, after_iqd: 28000 }, 'boss', '2026-11-12T07:00:00.000Z'),
    ROW(8, 'finance.staff_cost_materialized', 'cost-1', { amount_iqd: 2500 }, null, '2026-11-11T08:00:00.000Z'),
    ROW(7, 'finance.collection_recorded', 'col-1', { amount_iqd: 5000, reference: 'AZ-77', order_id: 'ORD-0D00000001' }, 'boss', '2026-11-10T20:30:00.000Z'),
    ROW(6, 'finance.something_new', 'x-1', {}, 'boss', '2026-11-10T08:00:00.000Z'),
  ], next: null }]);
  const opened: string[] = [];
  const page = await mount(opened);
  assert.deepEqual(sent, ['/api/admin/finance-workspace/activity?from=2026-11-01&to=2026-11-12']);
  const rows = rowsOf(page.container);
  assert.equal(rows.length, 4);
  for (const part of [ACTION_WORDS['finance.order_adjusted'][0], '2026-11-12 10:00', 'المالك', 'ORD-0D00000002', '30,000 د.ع ← 28,000 د.ع']) assert.ok(words(rows[0]).includes(part), `«${part}» in «${words(rows[0])}»`);
  assert.ok(words(rows[1]).includes(AAS.system[0]), 'the system, by name');
  assert.ok(words(rows[2]).includes('AZ-77') && words(rows[2]).includes('5,000 د.ع') && words(rows[2]).includes('2026-11-10 23:30'));
  assert.ok(words(rows[3]).includes('finance.something_new'), 'an action the table does not know reads as its code');
  click(named(rows[0], 'button', 'ORD-0D00000002'));
  assert.deepEqual(opened, ['ORD-0D00000002']);
  click(named(rows[2], 'button', 'ORD-0D00000001'));
  assert.deepEqual(opened, ['ORD-0D00000002', 'ORD-0D00000001'], 'a collection opens the order it was recorded on');
  assert.equal((rows[1].querySelectorAll('button') as unknown as FakeElement[]).length, 0, 'a wage with no order names its own id');
  await page.unmount();
});

test('on a phone the same acts are a list, each with its money in view', async () => {
  const w = globalThis as unknown as { window: { matchMedia?: unknown } };
  const before = w.window.matchMedia;
  w.window.matchMedia = () => ({ matches: true, media: '(max-width: 600px)', addEventListener() {}, removeEventListener() {} });
  try {
    serve([{ rows: [ROW(9, 'finance.order_adjusted', 'ORD-0D00000002', { before_iqd: 30000, after_iqd: 28000 }, 'boss', '2026-11-12T07:00:00.000Z')], next: null }]);
    const page = await mount();
    assert.equal(rowsOf(page.container).length, 0, 'no table');
    const items = page.container.querySelectorAll('li[data-finance-activity-row]') as unknown as FakeElement[];
    assert.equal(items.length, 1);
    for (const part of ['11-12 10:00', ACTION_WORDS['finance.order_adjusted'][0], 'المالك', 'ORD-0D00000002', '30,000 د.ع ← 28,000 د.ع']) assert.ok(words(items[0]).includes(part), `«${part}» in «${words(items[0])}»`);
    await page.unmount();
  } finally {
    w.window.matchMedia = before;
  }
});

test('the page: the search is sent once the typing stops, the switch adds the system, «المزيد» adds the next page', async () => {
  const one = { rows: [ROW(9, 'finance.cost_approved', 'cost-9', {}, 'boss', '2026-11-12T07:00:00.000Z')], next: 9 };
  const two = { rows: [ROW(8, 'finance.cost_approved', 'cost-8', {}, 'boss', '2026-11-12T06:00:00.000Z')], next: null };
  const sent = serve([one, two, one, one, one]);
  const page = await mount();
  click(page.container.querySelector('[data-finance-activity-more]') as unknown as FakeElement);
  await page.settle();
  assert.equal(rowsOf(page.container).length, 2, 'the next page under the first');
  assert.equal(sent[1], '/api/admin/finance-workspace/activity?from=2026-11-01&to=2026-11-12&before=9');
  await act(async () => { type(page.container.querySelector('[data-finance-activity-search]') as unknown as FakeElement, 'AZ-77'); });
  await page.settle(120);
  assert.ok(sent.some((u) => u.endsWith('&q=AZ-77')), sent.join(' | '));
  assert.ok(!sent.some((u) => /q=A(&|$)|q=AZ(&|$)/.test(u)), 'not on every key');
  click(page.container.querySelector('[data-finance-activity-auto]') as unknown as FakeElement);
  await page.settle();
  assert.ok(sent.at(-1)!.includes('auto=1'), sent.at(-1));
  await page.unmount();
});

test('a staff payment’s row opens its statement, as Excel and as a page to print (DECISIONS row 330)', async () => {
  serve([{ rows: [
    ROW(9, 'finance.staff_paid', 'pay-1', { staff_id: 'staff_a', kind: 'payment', amount_iqd: 6500, payment_day: '2026-11-12' }, 'boss', '2026-11-12T07:00:00.000Z'),
    ROW(8, 'finance.cost_approved', 'cost-1', {}, 'boss', '2026-11-12T06:00:00.000Z'),
  ], next: null }]);
  const page = await mount();
  const rows = rowsOf(page.container);
  const links = rows[0].querySelectorAll('a') as unknown as FakeElement[];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), [
    '/api/admin/finance-workspace/statements/staff-payments/pay-1/export.xlsx?lang=ar',
    '/api/admin/finance-workspace/statements/staff-payments/pay-1/print?lang=ar',
  ]);
  assert.equal(links[1].getAttribute('target'), '_blank', 'the page to print opens in its own tab');
  assert.equal((rows[1].querySelectorAll('a') as unknown as FakeElement[]).length, 0, 'other rows have none');
  assert.ok(words(rows[0]).includes('6,500 د.ع'), 'the payment’s amount, now on its row');
  await page.unmount();
});
