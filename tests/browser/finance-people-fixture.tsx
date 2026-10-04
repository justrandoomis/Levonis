/** Local-only fixture: real staff/investor/withdrawal components, all API calls stay in memory. */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import MyEarnings, { type EarningsData } from '../../src/components/financePeople/MyEarnings';
import PeoplePanel from '../../src/components/financePeople/PeoplePanel';
import InvestorPanel from '../../src/components/financePeople/InvestorPanel';
import WithdrawalPanel from '../../src/components/financePeople/WithdrawalPanel';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('levo_lang', params.get('lang') === 'en' ? 'en' : 'ar');
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
const accounts = [{ id: 'sajjad', name: 'سجاد علي', email: 'sajjad@example.test', role: 'admin', admin_scope: 'assistant' }, { id: 'hussein', name: 'حسين أحمد', email: 'hussein@example.test', role: 'admin', admin_scope: 'assistant' }, { id: 'investor', name: 'محمد عامر', email: 'mohammed@example.test', role: 'admin', admin_scope: 'assistant' }];
type FixtureStaff = { id: string; name: string; role: string; active: number; user_id: string; account_name: string; account_email: string; start_work_date: string | null; archived_at: string | null };
const staff: FixtureStaff[] = [{ id: 'staff-s', name: 'سجاد علي', role: 'تجهيز الطلبات', active: 1, user_id: 'sajjad', account_name: 'سجاد علي', account_email: 'sajjad@example.test', start_work_date: '2026-09-20', archived_at: null }];
const catalogs = [{ id: 'printers', name_ar: 'الطابعات', parent_id: null }, { id: 'fdm', name_ar: 'طابعات الفلمنت', parent_id: 'printers' }, { id: 'materials', name_ar: 'الفلمنت', parent_id: null }, { id: 'accessories', name_ar: 'الملحقات', parent_id: null }];
const products = [{ id: 'a1', name_ar: 'Bambu Lab A1 Combo', name_en: 'Bambu Lab A1 Combo', sku: 'A1-C', price_iqd: 965000, status: 'active', composition: '' }, { id: 'x2d', name_ar: 'Bambu Lab X2D Combo', name_en: 'Bambu Lab X2D Combo', sku: 'X2D-C', price_iqd: 1999000, status: 'active', composition: '' }];
const rules = [{ id: 'rule-s', version: 1, name: 'أجر تجهيز الطابعات', staff_id: 'staff-s', amount: 5000, basis: 'unit', milestone: 'delivered', requires_assignment: 0, active: 1, employment_effective_default: params.get('explicit-date') === '1' ? 0 : 1, effective_from: params.get('explicit-date') === '1' ? '2026-10-01' : '2026-09-21', effective_to: null, scope: { catalog_ids: ['printers'], product_ids: [], excluded_product_ids: ['x2d'] } }];
const incoming = [{ id: 'incoming-a1', purchase_id: 'purchase-10', label: 'شحنة أكتوبر · Bambu Lab A1 Combo', product_id: 'a1', qty_ordered: 5, qty_received: 5, total_cost_iqd: 3200000 }, { id: 'incoming-x2d', purchase_id: 'purchase-10', label: 'شحنة أكتوبر · Bambu Lab X2D Combo', product_id: 'x2d', qty_ordered: 5, qty_received: 2, total_cost_iqd: 7500000 }];
const contracts = [{ id: 'contract-1', name: 'محمد · دفعة أكتوبر', user_id: 'investor', user_name: 'محمد عامر', incoming_id: 'incoming-a1', incoming_label: incoming[0].label, principal_iqd: 3200000, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: 0, created_at: '2026-10-01' }];
const earnings: EarningsData = { summary: { earned_iqd: 235000, available_iqd: 145000, held_iqd: 40000, paid_iqd: 50000, pending_iqd: 35000, staff_iqd: 50000, investor_profit_iqd: 185000, capital_iqd: 0, pending_costs: 1 }, entries: [
  { id: 'w1', kind: 'staff', title: 'تجهيز طابعة A1 Combo', order_id: 'ORD-10042', day: '2026-10-03', amount_iqd: 5000, accrued_iqd: 5000, paid_iqd: 0, held_iqd: 0, available_iqd: 5000, state: 'due' },
  { id: 'inv1', kind: 'investor_profit', title: 'محمد · دفعة أكتوبر', day: '2026-10-03', amount_iqd: 150000, accrued_iqd: 185000, paid_iqd: 50000, held_iqd: 40000, available_iqd: 60000, state: 'available' },
  { id: 'w2', kind: 'staff', title: 'أجر تجهيز طلب بانتظار التكلفة', order_id: 'ORD-10051', day: '2026-10-04', amount_iqd: 0, accrued_iqd: 0, paid_iqd: 0, held_iqd: 0, available_iqd: 0, state: 'pending_cost' },
], withdrawals: [{ id: 'wd-1', amount_iqd: 40000, paid_iqd: 0, state: 'requested', created_at: '2026-10-03T08:00:00Z', user_name: 'سجاد علي', email: 'sajjad@example.test' }, { id: 'wd-2', amount_iqd: 50000, paid_iqd: 50000, state: 'paid', created_at: '2026-10-01T08:00:00Z', reference: 'CASH-124', user_name: 'حسين أحمد', email: 'hussein@example.test' }] };
const json = (body: object, status = 200) => new Response(JSON.stringify({ success: status < 400, ...body }), { status, headers: { 'content-type': 'application/json' } });
type FixtureReconciliation = { staff_id: string; revision: number; state: string; cursor: string; processed_orders: number; adjusted_orders: number; error: string | null; updated_at: string };
const reconciliations = new Map<string, FixtureReconciliation>();
function pendingReconciliation(id: string): FixtureReconciliation {
  const job = { staff_id: id, revision: (reconciliations.get(id)?.revision ?? 0) + 1, state: 'pending', cursor: '', processed_orders: 0, adjusted_orders: 0, error: null, updated_at: new Date().toISOString() };
  reconciliations.set(id, job);
  return job;
}
const writes: Array<{ path: string; method: string; body: unknown }> = [];
Object.assign(window, { __financePeopleFixtureWrites: writes });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin), method = init?.method || 'GET';
  await new Promise((r) => setTimeout(r, 70));
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (method !== 'GET') writes.push({ path: url.pathname, method, body });
  if (url.pathname === '/api/finance-earnings') return json(earnings);
  if (url.pathname === '/api/finance-earnings/withdrawals') { earnings.summary.available_iqd -= body.amount_iqd; earnings.summary.held_iqd += body.amount_iqd; earnings.withdrawals.unshift({ id: crypto.randomUUID(), amount_iqd: body.amount_iqd, paid_iqd: 0, state: 'requested', created_at: new Date().toISOString(), user_name: 'سجاد علي' }); return json({}); }
  if (/\/withdrawals\/.+\/cancel$/.test(url.pathname)) { const w = earnings.withdrawals.find((w) => w.id === url.pathname.split('/').at(-2)); earnings.summary.available_iqd += w.amount_iqd; earnings.summary.held_iqd -= w.amount_iqd; w.state = 'cancelled'; return json({}); }
  if (url.pathname === '/api/admin/finance-people/accounts') { const q = url.searchParams.get('q') || ''; return json({ accounts: accounts.filter((a) => `${a.name} ${a.email}`.includes(q)) }); }
  if (url.pathname === '/api/admin/finance-people/staff') {
    if (method === 'POST') {
      const account = accounts.find((item) => item.id === body.user_id);
      if (!account) return json({ error: 'اختر حسابًا' }, 400);
      if (staff.some((item) => item.user_id === account.id)) return json({ error: 'الموظف مسجل مسبقًا؛ عدّل بياناته من القائمة.' }, 409);
      const person: FixtureStaff = { id: crypto.randomUUID(), name: body.name || account.name, role: body.role || '', active: body.active === false ? 0 : 1, user_id: account.id, account_name: account.name, account_email: account.email, start_work_date: body.start_work_date || null, archived_at: null };
      staff.push(person);
      return json({ staff: person, reconciliation: pendingReconciliation(person.id) });
    }
    return json({ staff, catalogs, rules, scope_products: products, reconciliations: [...reconciliations.values()] });
  }
  if (/\/finance-people\/staff\//.test(url.pathname)) {
    const isReconcile = url.pathname.endsWith('/reconcile');
    const id = url.pathname.split('/').at(isReconcile ? -2 : -1);
    const person = staff.find((item) => item.id === id);
    if (!person) return json({ error: 'الموظف غير موجود' }, 404);
    if (isReconcile) {
      const previous = reconciliations.get(person.id) ?? pendingReconciliation(person.id);
      const failed = params.get('reconcile') === 'fail' && previous.state !== 'failed';
      const processed = failed ? previous.processed_orders : params.get('reconcile') === 'long' ? previous.processed_orders + 25 : 27;
      const reconciliation = { ...previous, state: failed ? 'failed' : params.get('reconcile') === 'long' && processed < 200 ? 'pending' : 'complete', processed_orders: processed, adjusted_orders: Math.floor(processed / 2), cursor: failed ? previous.cursor : `order-${processed}`, error: failed ? 'تعذر إكمال الحساب؛ أعد المحاولة.' : null, updated_at: new Date().toISOString() };
      reconciliations.set(person.id, reconciliation);
      return json({ reconciliation });
    }
    if (method === 'DELETE') { person.archived_at = new Date().toISOString(); person.active = 0; return json({ staff: person, reconciliation: pendingReconciliation(person.id) }); }
    if (body.name !== undefined) person.name = body.name;
    if (body.role !== undefined) person.role = body.role;
    if (body.start_work_date !== undefined) person.start_work_date = body.start_work_date;
    if (body.active !== undefined) person.active = body.active ? 1 : 0;
    if (body.restore === true) person.archived_at = null;
    if (body.user_id) { const account = accounts.find((item) => item.id === body.user_id); if (account) { person.user_id = account.id; person.account_name = account.name; person.account_email = account.email; } }
    const reconciliation = pendingReconciliation(person.id);
    return json({ staff: person, reconciliation });
  }
  if (/\/finance-operations\/rules/.test(url.pathname)) { if (method === 'POST') rules.push({ ...body, id: crypto.randomUUID(), version: 1 }); else { const i = rules.findIndex((r) => r.id === url.pathname.split('/').at(-1)); rules[i] = { ...rules[i], ...body, active: body.active ? 1 : 0, version: rules[i].version + 1 }; } return json({ reconciliation: pendingReconciliation(body.staff_id) }); }
  if (url.pathname === '/api/admin/products-v2') return json({ products: products.filter((p) => p.name_en.toLowerCase().includes((url.searchParams.get('search') || '').toLowerCase())) });
  if (url.pathname.startsWith('/api/admin/products-v2/')) return json({ product: products.find((p) => p.id === url.pathname.split('/').at(-1)) });
  if (url.pathname === '/api/admin/finance-people/withdrawals') return json({ withdrawals: earnings.withdrawals });
  if (/\/finance-people\/withdrawals\/.+\//.test(url.pathname)) { const w = earnings.withdrawals.find((w) => w.id === url.pathname.split('/').at(-2)); const action = url.pathname.split('/').at(-1); if (action === 'approve') w.state = 'approved'; if (action === 'reject') w.state = 'rejected'; if (action === 'pay') { w.paid_iqd += body.amount_iqd; w.reference = body.reference; w.state = w.paid_iqd === w.amount_iqd ? 'paid' : 'part_paid'; } return json({}); }
  if (url.pathname === '/api/admin/investment-finance/config') return json({ users: accounts, incoming, contracts });
  if (url.pathname === '/api/admin/investment-finance/contracts' && method === 'POST') { contracts.push({ ...body, id: crypto.randomUUID(), created_at: new Date().toISOString(), user_name: accounts.find((a) => a.id === body.user_id)?.name }); return json({}); }
  if (url.pathname.startsWith('/api/admin/investment-finance/contracts/')) { if (method === 'POST') return json({}); return json({ contract: contracts.find((c) => c.id === url.pathname.split('/').at(-1)), summary: { funded_iqd: 3200000, principal_iqd: 3200000, inventory_capital_iqd: 1920000, accrued_profit_iqd: 185000, available_profit_iqd: 150000, recovered_capital_iqd: 1280000, loss_iqd: 0 }, lots: [{ id: 'lot-1', label: 'A1 Combo · دفعة أكتوبر', qty_remaining: 3, location_name: 'المخزن الرئيسي' }], events: [{ id: 'ev-1', kind: 'funding', amount_iqd: 3200000, created_at: '2026-10-01', reference: 'TR-100' }] }); }
  return json({ error: `Unmocked fixture route: ${method} ${url.pathname}` }, 404);
};

const views = { earnings: MyEarnings, people: PeoplePanel, investors: InvestorPanel, withdrawals: WithdrawalPanel };
const View = views[params.get('view') as keyof typeof views] || MyEarnings;
createRoot(document.getElementById('root')!).render(<LanguageProvider><MemoryRouter><main className="min-h-screen bg-bg-primary text-text-primary px-4 py-6"><div className="mx-auto max-w-4xl"><View /></div></main></MemoryRouter></LanguageProvider>);
