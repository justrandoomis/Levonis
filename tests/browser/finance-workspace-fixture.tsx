/** Local-only fixture: every API request is answered here, never live data. */
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import FinanceWorkspace from '../../src/components/financeWorkspace/FinanceWorkspace';
import { financeDay, type OrderProfit, type FinanceSummary, type Promotion, type ProfitTotals } from '../../src/components/financeWorkspace/types';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('levo_lang', params.get('lang') === 'en' ? 'en' : 'ar');
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
const month = '2026-10';
let promo: Promotion = { id: 'promo-fixture', month, title: 'ترويج أكتوبر', currency: 'USD', amount: 100, exchange_rate: 1500, amount_iqd: 150000, enabled: 1, version: 1 };
const totals = { net_goods_iqd: 1_057_000, cogs_iqd: 740_000, gross_profit_iqd: 317_000, shipping_income_iqd: 10000,
  retained_revenue_iqd: 1_057_000, direct_cost_iqd: 35500, cod_tax_iqd: 0,
  wages_iqd: 7000, materials_iqd: 28500, manual_direct_iqd: 0, courier_fee_iqd: 10000, payment_fee_iqd: 0,
  contribution_profit_iqd: 281500, promotion_iqd: 125000, investor_iqd: 88025, owner_net_iqd: 68475,
  general_expenses_iqd: 0, owner_period_net_iqd: 68475, units: 5, orders_count: 1, pending_costs: 0, unknown_lines: 0,
  collected_iqd: 1067000, collection_difference_iqd: 0 };
const order: OrderProfit = {
  order_id: 'LV-2026-00418', version: 1,
  order: { id: 'LV-2026-00418', status: 'delivered', created_at: '2026-10-02T09:00:00Z', delivered_at: '2026-10-03T10:00:00Z', customer_name: 'علي عامر', shipping_iqd: 10000 },
  totals: { ...totals, general_expenses_iqd: 0, owner_period_net_iqd: undefined },
  lines: [
    { id: 'item-printer', product_id: 'printer', name_snapshot: 'Bambu Lab A1 Combo', sku_snapshot: 'A1-COMBO', option_snapshot: 'Combo', qty: 1, returned_qty: 0,
      net_goods_iqd: 965000, cogs_iqd: 680000, fifo_cogs_iqd: 680000, cost_confidence: 'fifo', wages_iqd: 5000, materials_iqd: 28500, manual_direct_iqd: 0,
      gross_profit_iqd: 285000, contribution_profit_iqd: 251500, promotion_iqd: 25000, investor_iqd: 88025, owner_net_iqd: 138475 },
    { id: 'item-filament', product_id: 'filament', name_snapshot: 'Bambu Lab PLA Basic', sku_snapshot: 'PLA-BASIC-BLACK', option_snapshot: 'With spool', color_snapshot: 'أسود', qty: 4, returned_qty: 0,
      net_goods_iqd: 92000, cogs_iqd: 60000, fifo_cogs_iqd: 60000, cost_confidence: 'fifo', wages_iqd: 2000, materials_iqd: 0, manual_direct_iqd: 0,
      gross_profit_iqd: 32000, contribution_profit_iqd: 30000, promotion_iqd: 100000, investor_iqd: 0, owner_net_iqd: -70000 },
  ],
  costs: [{ id: 'cost-fixture-1', rule_name: 'تجهيز الطابعة', staff_id: 'staff-sajjad', staff_name: 'سجاد', amount_iqd: 5000, effective_amount_iqd: 5000, state: 'due', order_item_id: 'item-printer', center_id: 'printers' }],
  warnings: [], history: [],
};
const otherTotals = { net_goods_iqd: 115000, retained_revenue_iqd: 115000, cogs_iqd: 80000, gross_profit_iqd: 35000, shipping_income_iqd: 5000, cod_tax_iqd: 0, direct_cost_iqd: 1500, wages_iqd: 1500, materials_iqd: 0, manual_direct_iqd: 0, courier_fee_iqd: 5000, payment_fee_iqd: 0, contribution_profit_iqd: 33500, promotion_iqd: 25000, investor_iqd: 0, owner_net_iqd: 8500, units: 1, pending_costs: 0, unknown_lines: 0, collected_iqd: 120000, collection_difference_iqd: 0 };
const summary: FinanceSummary = { totals, truncated: false, exceptions: [], promotions: [promo],
  orders: [{ ...order.order, ...order.totals }, { id: 'LV-2026-00417', status: 'delivered', customer_name: 'حسين أحمد', created_at: '2026-10-01T09:00:00Z', delivered_at: '2026-10-01T12:00:00Z', ...otherTotals }],
  products: order.lines.map((l) => ({ ...l, id: l.product_id ?? l.id, name: l.name_snapshot })),
  categories: [{ ...order.lines[0], id: 'printers', name: 'الطابعات', qty: 1, level: 'main' }, { ...order.lines[1], id: 'filaments', name: 'الفلمنت', qty: 4, level: 'main' }],
};
if (params.get('state') === 'unknown') {
  order.totals.cogs_iqd = null; order.totals.owner_net_iqd = null; order.warnings = ['cost:item-printer:unknown'];
  order.lines[0].cogs_iqd = null; order.lines[0].owner_net_iqd = null; order.lines[0].cost_confidence = 'unknown';
  summary.orders[0].cogs_iqd = null; summary.orders[0].owner_net_iqd = null; summary.orders[0].unknown_lines = 1;
  summary.products[0].cogs_iqd = null; summary.products[0].owner_net_iqd = null;
  summary.categories[0].cogs_iqd = null; summary.categories[0].owner_net_iqd = null;
}
// Coherent synthetic figures, filtered by the selected range; no production request escapes this fixture.
function fixtureSummary(from: string, to: string): FinanceSummary {
  const selected = params.get('state') === 'empty' ? [] : summary.orders.filter((row) => { const day = financeDay(row.delivered_at); return day >= from && day <= to; });
  const add = (rows: ProfitTotals[]): ProfitTotals => Object.fromEntries(Object.keys(totals).map((key) => [key, rows.some((row) => (row as Record<string, unknown>)[key] === null) ? null : rows.reduce((sum, row) => sum + Number((row as Record<string, unknown>)[key] ?? 0), 0)]));
  const t = add(selected), general = params.get('state') !== 'empty' && from <= '2026-10-01' && to >= '2026-10-01' ? 30000 : 0;
  t.orders_count = selected.length; t.general_expenses_iqd = general; t.owner_period_net_iqd = t.owner_net_iqd == null ? null : t.owner_net_iqd - general;
  const chartAmounts = (v: ProfitTotals, generalCost = 0) => ({ revenue_iqd: Number(v.retained_revenue_iqd ?? 0) + Number(v.shipping_income_iqd ?? 0), cost_iqd: v.cogs_iqd == null && selected.length ? null : Number(v.cogs_iqd ?? 0) + Number(v.direct_cost_iqd ?? 0) + Number(v.manual_direct_iqd ?? 0) + Number(v.courier_fee_iqd ?? 0) + Number(v.payment_fee_iqd ?? 0) + Number(v.promotion_iqd ?? 0) + generalCost, owner_net_iqd: v.owner_net_iqd == null && selected.length ? null : Number(v.owner_net_iqd ?? 0) - generalCost, investor_iqd: Number(v.investor_iqd ?? 0), orders_count: v.orders_count ?? 0, unknown_lines: v.unknown_lines ?? 0, pending_costs: v.pending_costs ?? 0 });
  const daily = [];
  for (let day = Date.parse(from); day <= Date.parse(to) && daily.length < 366; day += 86400000) { const date = new Date(day).toISOString().slice(0, 10), rows = selected.filter((row) => financeDay(row.delivered_at) === date), v = add(rows); v.orders_count = rows.length; daily.push({ day: date, ...chartAmounts(v, date === '2026-10-01' ? general : 0) }); }
  const hasPrimary = selected.some((row) => row.id === order.order_id), hasOther = selected.some((row) => row.id === 'LV-2026-00417');
  const categories = hasPrimary ? [...summary.categories] : [];
  if (hasOther) { const index = categories.findIndex((row) => row.id === 'filaments'), original = index >= 0 ? categories[index] : undefined; const row = { ...(original ?? {}), ...add([original ?? {}, otherTotals]), id: 'filaments', name: 'الفلمنت', level: 'main' as const, qty: (original?.qty ?? 0) + 1 }; if (index >= 0) categories[index] = row; else categories.push(row); }
  return { ...summary, range: { from, to }, totals: t, orders: selected, categories, products: hasPrimary ? summary.products : [], chart_data: { ...chartAmounts(t, general), basis: 'delivered_baghdad_day', daily, expense_composition: [{ key: 'goods', amount_iqd: t.cogs_iqd === null ? null : t.cogs_iqd ?? 0 }, { key: 'wages', amount_iqd: t.wages_iqd ?? 0 }, { key: 'materials', amount_iqd: t.materials_iqd ?? 0 }, { key: 'other', amount_iqd: t.manual_direct_iqd ?? 0 }, { key: 'delivery', amount_iqd: Number(t.courier_fee_iqd ?? 0) + Number(t.payment_fee_iqd ?? 0) }, { key: 'promotion', amount_iqd: t.promotion_iqd ?? 0 }, { key: 'general', amount_iqd: general }] } };
}
const json = (value: object, status = 200) => new Response(JSON.stringify({ success: status < 400, ...value }), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (!url.pathname.startsWith('/api/')) throw new Error('Fixture only permits mocked API requests');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  const method = init?.method ?? 'GET';
  await new Promise((resolve) => setTimeout(resolve, 35));
  if (url.pathname.endsWith('/summary')) return json(fixtureSummary(url.searchParams.get('from') ?? `${month}-01`, url.searchParams.get('to') ?? `${month}-31`));
  if (url.pathname.endsWith('/orders')) {
    const range = fixtureSummary(url.searchParams.get('from') ?? `${month}-01`, url.searchParams.get('to') ?? `${month}-31`), query = url.searchParams.get('q') ?? '', status = url.searchParams.get('status');
    const orders = range.orders.filter((row) => (!query || `${row.id} ${row.customer_name}`.includes(query)) && (!status || row.status === status));
    return json({ orders, total: orders.length, offset: 0 });
  }
  if (url.pathname.includes('/orders/') && url.pathname.endsWith('/adjustments')) {
    const line = order.lines.find((l) => l.id === body.line_id);
    const target = (line ?? order.totals) as unknown as Record<string, number>;
    order.history.unshift({ old_value_iqd: target[body.field], new_value_iqd: body.value_iqd, field: body.field, line_id: body.line_id, actor_name: 'علي عامر', created_at: new Date().toISOString(), version: ++order.version });
    target[body.field] = body.value_iqd;
    if (line) { line.gross_profit_iqd = line.net_goods_iqd! - line.cogs_iqd!; line.owner_net_iqd = line.gross_profit_iqd - (line.wages_iqd ?? 0) - (line.materials_iqd ?? 0) - (line.manual_direct_iqd ?? 0) - (line.promotion_iqd ?? 0) - (line.investor_iqd ?? 0); }
    return json({ version: order.version });
  }
  if (url.pathname.includes('/orders/')) return json(order);
  if (url.pathname.startsWith('/api/admin/finance-people/costs/') && method === 'PATCH') {
    const cost = order.costs.find((c) => c.id === url.pathname.split('/').pop());
    if (!cost) return json({ error: 'Fixture cost not found' }, 404);
    const difference = body.amount_iqd - (cost.effective_amount_iqd ?? cost.amount_iqd);
    cost.effective_amount_iqd = body.amount_iqd;
    const line = order.lines.find((l) => l.id === cost.order_item_id);
    if (line) { line.wages_iqd = (line.wages_iqd ?? 0) + difference; line.owner_net_iqd = (line.owner_net_iqd ?? 0) - difference; }
    return json({ cost });
  }
  if (url.pathname.endsWith('/promotions') && method === 'GET') return json({ promotions: [promo] });
  if (url.pathname.includes('/promotions')) {
    if (method === 'DELETE') promo.enabled = 0;
    else { promo = { ...promo, ...body, exchange_rate: body.exchange_rate ?? 1500, amount_iqd: body.amount * (body.currency === 'USD' ? body.exchange_rate ?? 1500 : 1), enabled: 1, version: promo.version + 1 }; summary.promotions = [promo]; }
    return json({ promotion: promo });
  }
  if (url.pathname.endsWith('/expense-categories')) return json({ categories: [] });
  if (url.pathname.endsWith('/expenses')) return json({ expenses: [] });
  return json({ error: `Fixture endpoint not configured: ${url.pathname}` }, 404);
};

createRoot(document.getElementById('root')!).render(<LanguageProvider><div style={{ maxWidth: 1200, margin: '0 auto', padding: '16px 8px', minHeight: '100vh' }}><FinanceWorkspace /></div></LanguageProvider>);
