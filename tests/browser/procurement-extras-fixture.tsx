/** Purchase costs with a supplier route: raw price, route freight, actual
 * extra expenses and their «تفاصيل». Run: scripts/e2e-procurement-extras.mjs.
 * ?draft=route|manual seeds a local draft (the owner's X2D Combo × 5 at
 * 1,616.88 IQD/EUR and 5,944 IQD/kg); the route's current rates are newer. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageProvider } from '../../src/LanguageContext';
import ProcurementPanel from '../../src/components/adminOperations/ProcurementPanel';
import '../../src/components/adminProducts/theme.css';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
localStorage.setItem('levo_lang', ['en', 'ckb'].includes(params.get('lang') ?? '') ? params.get('lang')! : 'ar');
const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
Object.assign(window, { procurementRequests: requests });

const profile = { id: 'germany_land', name_ar: 'ألمانيا — شحن بري', name_en: 'Germany · land freight', currency: 'EUR', shipping_basis: 'weight', exchange_rate: 1650, shipping_rate_iqd: 6100, version: 5 };
const line = { product_id: 'x2d', scope: 'option', scope_id: 'combo', label: 'X2D Combo', sku: 'X2D-COMBO', stock: 0, reserved: 0, selling_price_iqd: 1800000, cost_source: 'procurement_default', weight_g: 22300, volume_mm3: 0, qty_ordered: 5, invoiced_qty: 5, purchase_cost_mode: 'unit', source_unit_amount: 855, source_total_amount: 4275 };
const header = { supplier_id: '', warehouse_id: '', invoice_no: '', currency: 'EUR', exchange_rate: 1616.88, cost_profile_id: 'germany_land', cost_profile_version: 4, shipping_basis: 'weight', shipping_rate_iqd: 5944, purchase_day: '2026-10-06', expected_day: '', tracking: '', note: '', attachment_url: '', invoice_total_iqd: '', cost_state: 'final' };
const manual = { ...header, cost_profile_id: null, cost_profile_version: null, shipping_basis: null, shipping_rate_iqd: null };
const seed = params.get('draft');
if (seed === 'route' || seed === 'manual')
  localStorage.setItem('levonis-purchase-draft-v2', JSON.stringify({ header: seed === 'route' ? header : manual, lines: [line], charges: seed === 'manual' ? [{ title: 'شحن', amount_iqd: 466330, basis: 'quantity' }] : [], operationId: 'op-fixture' }));
else localStorage.removeItem('levonis-purchase-draft-v2');

const purchase = { id: 'doc-1', invoice_no: 'DE-2026-17', supplier_name: '', supplier_id: '', warehouse_id: '', status: 'ordered', cost_state: 'final', total_cost_iqd: 7634918, paid_iqd: 0, version: 1, request_json: '{}', ...header };
const saved = { ...line, id: 'inc-1', line_id: 'pol-1', qty_received: 0, rejected_qty: 0, purchase_unit_iqd: 1382432, purchase_total_iqd: 6912162, auto_shipping_iqd: 662756, charges_iqd: 662756 + 60000 };
const charges = [
  { id: 'pch-1', title: 'توصيل محلي', amount_iqd: 50000, basis: 'quantity', scope: 'shipment', unit_amount_iqd: null, applies_to: null, allocations: [{ line_id: 'pol-1', amount_iqd: 50000 }] },
  { id: 'pch-2', title: 'تغليف', amount_iqd: 10000, basis: 'quantity', scope: 'unit', unit_amount_iqd: 2000, applies_to: null, allocations: [{ line_id: 'pol-1', amount_iqd: 10000 }] },
];
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin), path = url.pathname, method = init?.method || 'GET';
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ path, method, body });
  let data: Record<string, unknown> | undefined;
  if (path === '/api/admin/procurement/config') data = { suppliers: [], locations: [], investors: [], cost_profiles: [profile] };
  else if (path === '/api/admin/procurement/documents' && method === 'GET') data = { purchases: [purchase] };
  else if (path.startsWith('/api/admin/procurement/documents') && (method === 'POST' || method === 'PUT')) data = { id: 'doc-1' };
  else if (path === '/api/admin/procurement/documents/doc-1' && method === 'GET') data = { purchase, funding: null, lines: [saved], charges, payments: [], ordered_total_iqd: 7634918, paid_iqd: 0, balance_iqd: 7634918, matching: { ordered_qty: 5, received_qty: 0, invoiced_qty: 5, rejected_qty: 0, invoice_difference_iqd: null } };
  return new Response(JSON.stringify(data ? { success: true, ...data } : { success: false, error: `Fixture missing ${method} ${path}` }), { status: data ? 200 : 404, headers: { 'content-type': 'application/json' } });
}) as typeof window.fetch;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LanguageProvider><div className="ap" dir={params.get('lang') === 'en' ? 'ltr' : 'rtl'} style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}><ProcurementPanel onChanged={() => {}} /></div></LanguageProvider></React.StrictMode>,
);
