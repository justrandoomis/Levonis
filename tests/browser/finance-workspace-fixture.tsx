/** Local-only fixture: every API request is answered here, never live data. */
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import FinanceWorkspace from '../../src/components/financeWorkspace/FinanceWorkspace';
import type { OrderProfit, FinanceSummary, Promotion } from '../../src/components/financeWorkspace/types';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
localStorage.setItem('levo_lang', params.get('lang') === 'en' ? 'en' : 'ar');
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
const month = '2026-10';
let promo: Promotion = { id: 'promo-fixture', month, title: 'ترويج أكتوبر', currency: 'USD', amount: 100, exchange_rate: 1500, amount_iqd: 150000, enabled: 1, version: 1 };
const totals = { net_goods_iqd: 1_057_000, cogs_iqd: 740_000, gross_profit_iqd: 317_000, shipping_income_iqd: 10000,
  wages_iqd: 7000, materials_iqd: 28500, manual_direct_iqd: 0, courier_fee_iqd: 10000, payment_fee_iqd: 0,
  contribution_profit_iqd: 281500, promotion_iqd: 15000, investor_iqd: 88025, owner_net_iqd: 178475,
  general_expenses_iqd: 30000, owner_period_net_iqd: 148475, units: 5, orders_count: 2, pending_costs: 0, unknown_lines: 0,
  collected_iqd: 1067000, collection_difference_iqd: 0 };
const order: OrderProfit = {
  order_id: 'LV-2026-00418', version: 1,
  order: { id: 'LV-2026-00418', status: 'delivered', created_at: '2026-10-02T09:00:00Z', delivered_at: '2026-10-03T10:00:00Z', customer_name: 'علي عامر', shipping_iqd: 10000 },
  totals: { ...totals, general_expenses_iqd: 0, owner_period_net_iqd: undefined },
  lines: [
    { id: 'item-printer', product_id: 'printer', name_snapshot: 'Bambu Lab A1 Combo', sku_snapshot: 'A1-COMBO', option_snapshot: 'Combo', qty: 1, returned_qty: 0,
      net_goods_iqd: 965000, cogs_iqd: 680000, fifo_cogs_iqd: 680000, cost_confidence: 'fifo', wages_iqd: 5000, materials_iqd: 28500, manual_direct_iqd: 0,
      gross_profit_iqd: 285000, contribution_profit_iqd: 251500, promotion_iqd: 3000, investor_iqd: 88025, owner_net_iqd: 160475 },
    { id: 'item-filament', product_id: 'filament', name_snapshot: 'Bambu Lab PLA Basic', sku_snapshot: 'PLA-BASIC-BLACK', option_snapshot: 'With spool', color_snapshot: 'أسود', qty: 4, returned_qty: 0,
      net_goods_iqd: 92000, cogs_iqd: 60000, fifo_cogs_iqd: 60000, cost_confidence: 'fifo', wages_iqd: 2000, materials_iqd: 0, manual_direct_iqd: 0,
      gross_profit_iqd: 32000, contribution_profit_iqd: 30000, promotion_iqd: 12000, investor_iqd: 0, owner_net_iqd: 18000 },
  ],
  costs: [{ id: 'cost-fixture-1', rule_name: 'تجهيز الطابعة', staff_id: 'staff-sajjad', staff_name: 'سجاد', amount_iqd: 5000, effective_amount_iqd: 5000, state: 'due', order_item_id: 'item-printer', center_id: 'printers' }],
  warnings: [], history: [],
};
const summary: FinanceSummary = { totals, truncated: false, exceptions: [], promotions: [promo],
  orders: [{ ...order.order, ...order.totals }, { id: 'LV-2026-00417', status: 'delivered', customer_name: 'حسين أحمد', created_at: '2026-10-01T09:00:00Z', delivered_at: '2026-10-01T12:00:00Z', owner_net_iqd: 31500, net_goods_iqd: 115000 }],
  products: order.lines.map((l) => ({ ...l, id: l.product_id ?? l.id, name: l.name_snapshot })),
  categories: [{ ...order.lines[0], id: 'printers', name: 'الطابعات', qty: 1 }, { ...order.lines[1], id: 'filaments', name: 'الفلمنت', qty: 4 }],
};
const json = (value: object, status = 200) => new Response(JSON.stringify({ success: status < 400, ...value }), { status, headers: { 'content-type': 'application/json' } });
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (!url.pathname.startsWith('/api/')) throw new Error('Fixture only permits mocked API requests');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  const method = init?.method ?? 'GET';
  await new Promise((resolve) => setTimeout(resolve, 35));
  if (url.pathname.endsWith('/summary')) return json(summary);
  if (url.pathname.endsWith('/orders')) return json({ orders: summary.orders, total: summary.orders.length, offset: 0 });
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
