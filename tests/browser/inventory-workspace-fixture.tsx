import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import AdminInventory from '../../src/components/adminInventory/AdminInventory';
import InvestorPanel from '../../src/components/financePeople/InvestorPanel';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
localStorage.setItem('levo_lang', params.get('lang') === 'en' ? 'en' : 'ar');
const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
Object.assign(window, { inventoryRequests: requests });
const product = { id: 'printer', name_ar: 'طابعة تجريبية', name_en: 'Fixture printer', sku: 'PRINTER', price_iqd: 800000, status: 'active', composition: '' };
const selection = { product_id: product.id, scope: 'color', scope_id: 'black', label: 'طابعة تجريبية · أسود', sku: 'PRINTER-BLACK', stock: 12, reserved: 0, selling_price_iqd: 800000, purchase_unit_iqd: 500000, unit_cost_iqd: 500000, cost_source: 'latest_purchase', weight_g: 3000, volume_mm3: 5000 };
const lot = { id: 'lot-fixture', incoming_id: 'incoming-fixture', product_id: product.id, scope: selection.scope, scope_id: selection.scope_id, name: product.name_en, name_ar: product.name_ar, product_name: product.name_ar, qty_received: 15, qty_remaining: 12, unit_cost_iqd: 500000, received_at: '2026-01-01T10:00:00Z', location_name: 'المستودع الرئيسي', location_id: 'main' };
let adjustment: Record<string, unknown>[] = [];
const purchase = { id: 'purchase-fixture', invoice_no: 'INV-12', supplier_name: 'مورد تجريبي', supplier_id: 'supplier', warehouse_id: 'main', status: 'ordered', cost_state: 'final', total_cost_iqd: 500000, paid_iqd: 0, version: 1, currency: 'IQD', exchange_rate: 1, purchase_day: '2026-10-04', expected_day: '', tracking: '', note: '', attachment_url: '', invoice_total_iqd: null };
let purchasedLines = [{ ...selection, id: 'incoming-fixture', line_id: 'line-fixture', qty_ordered: 1, invoiced_qty: 1, qty_received: 0, rejected_qty: 0, source_unit_amount: 500000, charges_iqd: 0 }];
const contract = { id: 'contract-fixture', name: 'اتفاق تجريبي', user_id: 'investor', user_name: 'مستثمر تجريبي', incoming_id: 'incoming-fixture', principal_iqd: 500000, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: 10000, state: 'active', created_at: '2026-10-04' };
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin), path = url.pathname, method = init?.method || 'GET';
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ path, method, body });
  let data: Record<string, unknown> | undefined;
  if (path === '/api/admin/inventory/overview') data = { on_hand_units: 12, active_lots: 1, inventory_value_iqd: 6000000, unpriced_units: 0, incoming_purchases: 1, incoming_units: 1, incoming_purchase_total_iqd: 500000, aging_units: { d0_30: 0, d31_90: 0, d91_180: 0, d180_plus: 12 } };
  else if (path === '/api/admin/inventory/lines') data = { lines: [{ product_id: product.id, product_name: product.name_ar, product_sku: product.sku, product_image: '', inventory_mode: 'finite', scope: 'color', scope_id: 'black', on_hand: 12, lot_count: 1, oldest_received_at: lot.received_at, unpriced_units: 0, inventory_value_iqd: 6000000, oldest_unit_cost_iqd: 500000, newest_unit_cost_iqd: 500000 }], limit: 50, offset: 0 };
  else if (path === '/api/admin/products-v2') data = { products: [product] };
  else if (path === '/api/admin/products-v2/printer') data = { product };
  else if (path === '/api/admin/procurement/config') data = { suppliers: [{ id: 'supplier', name: 'مورد تجريبي' }], locations: [{ id: 'main', name: 'المستودع الرئيسي' }, { id: 'shelf', name: 'الرف الأول' }] };
  else if (path === '/api/admin/procurement/selections/printer') data = { selections: [selection] };
  else if (path === '/api/admin/procurement/documents' && method === 'POST') { purchasedLines = (body.lines as typeof purchasedLines).map((l, i) => ({ ...l, id: `incoming-${i}`, line_id: `line-${i}`, qty_received: 0, rejected_qty: 0, charges_iqd: 0 })); data = { id: purchase.id }; }
  else if (path === '/api/admin/procurement/documents') data = { purchases: [purchase] };
  else if (path === `/api/admin/procurement/documents/${purchase.id}`) data = { purchase, lines: purchasedLines, charges: [], payments: [], paid_iqd: 0, ordered_total_iqd: 500000, balance_iqd: 500000, matching: { ordered_qty: 1, received_qty: 0, invoiced_qty: 1, rejected_qty: 0, invoice_difference_iqd: null } };
  else if (path.endsWith('/receive') && method === 'POST') data = {};
  else if (path === '/api/admin/stock-operations/health') data = { rows: [{ ...selection, name: product.name_en, name_ar: product.name_ar, stock: 12, lot_units: 12, available: 11, discrepancy: 0, incoming: 1, recommended_purchase: 0, cover_days: 80, sold_30d: 5, reorder_point: 2, lead_time_days: 7 }] };
  else if (path === '/api/admin/stock-operations/locations') data = { lots: [lot], locations: [{ id: 'main', name: 'المستودع الرئيسي' }, { id: 'shelf', name: 'الرف الأول' }] };
  else if (path === '/api/admin/stock-operations/counts') data = { counts: [] };
  else if (path === '/api/admin/stock-operations/trace') data = { links: [], lots: [lot], returns: [{ id: 'return-fixture', order_id: 'order-fixture', order_item_id: 'item-fixture', name_snapshot: product.name_ar, qty: 2 }], return_allocations: [{ id: 'allocation-funded', order_item_id: 'item-fixture', lot_id: lot.id, qty: 2, claimed: 0, label: 'دفعة ممولة' }, { id: 'allocation-owner', order_item_id: 'item-fixture', lot_id: 'owner-lot', qty: 2, claimed: 1, label: 'دفعة المالك' }] };
  else if (path === '/api/admin/stock-operations/return-inspections') data = {};
  else if (path === '/api/admin/stock-operations/scan') data = { lot: body.code === 'WRONG' ? { ...lot, id: 'other-lot' } : lot, serial: null, match: body.code !== 'MISMATCH' };
  else if (path === '/api/admin/stock-operations/lot-counts') { lot.qty_remaining = Number(body.counted_qty); data = {}; }
  else if (path === '/api/admin/stock-operations/transfers') data = {};
  else if (path === '/api/admin/investment-finance/lots') data = { lots: [lot] };
  else if (path === '/api/admin/investment-finance/lots/lot-fixture') data = { lot, contracts: [], allocations: [], adjustments: adjustment };
  else if (path === '/api/admin/investment-finance/lot-cost-adjustments') { adjustment = [{ id: 'adjustment-fixture', adjustment_day: '2026-10-04', old_unit_cost_iqd: lot.unit_cost_iqd, new_unit_cost_iqd: body.new_unit_cost_iqd }]; lot.unit_cost_iqd = Number(body.new_unit_cost_iqd); data = {}; }
  else if (path === '/api/admin/investment-finance/config') data = { users: [{ id: 'investor', name: 'مستثمر تجريبي', email: 'investor@example.test' }], incoming: purchasedLines.map((l) => ({ id: l.id, purchase_id: purchase.id, label: l.label, product_id: l.product_id, qty_ordered: l.qty_ordered, qty_received: l.qty_received, total_cost_iqd: 500000 })), contracts: params.get('panel') === 'investors' ? [contract] : [] };
  else if (path === '/api/admin/investment-finance/contracts/contract-fixture/void') { contract.state = 'void'; data = {}; }
  else if (path === '/api/admin/investment-finance/contracts/contract-fixture') data = { contract, can_void: params.get('funded') !== '1' && contract.state === 'active', lots: [], events: params.get('funded') === '1' ? [{ id: 'funding-event', kind: 'funding', amount_iqd: 500000, created_at: '2026-10-04' }] : [], summary: { funded_iqd: params.get('funded') === '1' ? 500000 : 0, principal_iqd: 500000, inventory_capital_iqd: 0, accrued_profit_iqd: 0, available_profit_iqd: 0, recovered_capital_iqd: 0, loss_iqd: 0 } };
  else if (path === '/api/admin/investment-finance/contracts' && method === 'POST') data = { id: 'contract-fixture' };
  return new Response(JSON.stringify(data ? { success: true, ...data } : { success: false, error: `Fixture missing ${method} ${path}` }), { status: data ? 200 : 404, headers: { 'content-type': 'application/json' } });
}) as typeof window.fetch;

class Catch extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: unknown) { return { error: String(e) }; }
  render() { return this.state.error ? <p data-fixture-error>{this.state.error}</p> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><LanguageProvider><div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}><Catch>{params.get('panel') === 'investors' ? <InvestorPanel /> : <AdminInventory />}</Catch></div></LanguageProvider></React.StrictMode>);
