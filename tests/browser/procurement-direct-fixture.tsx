/** A stock purchase named and reviewed for DIRECT SALE (owner request
 * 2026-10-10): the purchase card with explicit API fixtures. Run:
 * scripts/e2e-procurement-direct.mjs. A local draft seeds the owner's A1 and
 * A1 Combo (Germany by land); the pricing preview answers «data only» until
 * the review sends a Direct Sale Extra, then the prices the confirm writes.
 * `?lang=ckb|en` picks the language, `?theme=light|dark` the theme. */
import React from 'react';
import { privateDrafts } from '../../src/lib/privateDrafts';
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
const draftLine = (scope_id: string, label: string, unit: number) => ({ product_id: 'a1', scope: 'option', scope_id, label, sku: `A1-${scope_id}`, stock: 0, reserved: 0, selling_price_iqd: 749000, cost_source: 'procurement_default', weight_g: 9000, volume_mm3: 0, qty_ordered: 7, invoiced_qty: 7, purchase_cost_mode: 'unit', source_unit_amount: unit, source_total_amount: unit * 7 });
const header = { supplier_id: 'germany', warehouse_id: '', invoice_no: '', currency: 'EUR', exchange_rate: 1650, cost_profile_id: 'germany_land', cost_profile_version: 5, shipping_basis: 'weight', shipping_rate_iqd: 6100, purchase_day: '2026-10-10', expected_day: '', tracking: '', note: '', attachment_url: '', invoice_total_iqd: '', cost_state: 'final' };
privateDrafts.setItem('levonis-purchase-draft-v2', JSON.stringify({ header, lines: [draftLine('std', 'A1', 320), draftLine('combo', 'A1 Combo', 445)], charges: [], operationId: 'op-direct-fixture' }));

// ----------------------------------------------------------------- the pricing preview
const names = (n: string) => ({ name_ar: n, name_en: n, name_ckb: n });
const MODELS = [
  { option_id: 'std', n: 'A1', today: 749000, todayDirect: 799000, cost: 585727, base: 875000 },
  { option_id: 'combo', n: 'A1 Combo', today: 915000, todayDirect: 965000, cost: 810391, base: 1100000 },
];
const summary = (m: (typeof MODELS)[number], extra: number | null) => ({
  state: 'ok', issue_codes: [], shipping_profile: 'GERMANY_LAND', profile_source: 'proposed', engine_priced: false, sells_direct: true, option_id: m.option_id,
  rule_level: 'product', minimum_target_profit_usd: '175', target_profit_iqd: null, target_profit_cents: 17500, current_total_cost_cents: Math.round((m.cost / 1650) * 100),
  final_price_cents: Math.round((m.cost / 1650) * 100) + 17500, preorder_base_iqd: m.base, direct_sale_extra_iqd: extra, direct_sale_price_iqd: extra == null ? null : m.base + extra,
  rounding_added_iqd: 0, supplier_original_amount: '320', supplier_original_currency: 'EUR', iqd_converted: null, cross_rate: '1.1', supplier_cost_usd: '352', supplier_cost_cents: 35200,
  basis: 'weight', effective_weight_g: 9000, effective_cbm: null, shipping_rate: '6100', shipping_cost_iqd: 54900, shipping_cost_usd: '33.27', shipping_cost_cents: 3327,
  additional_cost_iqd: 0, additional_cost_usd: '0', additional_cost_cents: 0, excluded_charges: [], current_total_cost_usd: null, final_price_usd: null, usd_iqd_rate: '1650',
  document_rate: null, store_price_iqd: m.today,
});
const previewRows = MODELS.flatMap((m) => [
  { option_id: m.option_id, ...names(m.n), channel: 'direct_sale', today_prepaid_iqd: m.todayDirect, today_cod_iqd: null, cod_priced_as_direct: true, computed_price_iqd: null, change_iqd: null, replacement_cost_iqd: null, target_profit_usd: null, target_profit_iqd: null, direct_sale_extra_iqd: null, preorder_base_iqd: null, issue_codes: ['DIRECT_SALE_EXTRA_MISSING'] },
  { option_id: m.option_id, ...names(m.n), channel: 'pre_order_land', today_prepaid_iqd: m.today, today_cod_iqd: m.todayDirect, cod_priced_as_direct: true, computed_price_iqd: m.base, change_iqd: m.base - m.today, replacement_cost_iqd: m.cost, target_profit_usd: '175', target_profit_iqd: 288750, direct_sale_extra_iqd: null, preorder_base_iqd: m.base, issue_codes: [] },
]);
const adoptionRow = (m: (typeof MODELS)[number], channel: string, extra: number) => {
  const price = channel === 'direct_sale' ? m.base + extra : m.base;
  const before = channel === 'direct_sale' ? m.todayDirect : m.today;
  return { option_id: m.option_id, ...names(m.n), channel, today_prepaid_iqd: before, computed_price_iqd: price, change_iqd: price - before, change_pct: ((price - before) / before * 100).toFixed(1), large: true, drop_flag: false, replacement_cost_iqd: m.cost, target_profit_usd: '175', target_profit_iqd: 288750, preorder_base_iqd: m.base, direct_sale_extra_iqd: channel === 'direct_sale' ? extra : null, final_price_usd: null, route_fee_removed: false, pro_before_iqd: null, pro_after_iqd: null, prime_before_iqd: null, prime_after_iqd: null };
};
const pricingPreview = (body?: Record<string, unknown>) => {
  const pricing = (body?.pricing ?? {}) as { direct_sale_extras?: Array<{ amount_iqd: number | null }> };
  const typed = pricing.direct_sale_extras?.find((x) => x.amount_iqd != null)?.amount_iqd ?? null;
  const complete = typed != null;
  return {
    rates: { usd_iqd_rate: '1650', review_pending: false, derived_stale: false },
    lines: MODELS.map((m, index) => ({ index, line_id: null, key: `a1:option:${m.option_id}`, product_id: 'a1', pricing_summary: summary(m, typed) })),
    products: [{
      product_id: 'a1', label: 'Bambu Lab A1', mode: 'manual', feeds: true, eligible: true, reason: null, use_purchase: true, prefer_purchase_values: false,
      preview_hash: complete ? `${'b'.repeat(56)}${String(typed).padStart(8, '0')}` : 'a'.repeat(64), applied: false, cancelled_source: false,
      entries: [{ scope: 'option', scope_id: 'std', narrow: false, line_ids: [], kept_higher: [], changes: { supplier_cost_amount: { before: null, after: '320' } } }],
      proposals: [{ scope: 'base', scope_id: '', shipping_profile: 'GERMANY_LAND' }], shadowed: [], rows: previewRows,
      missing_codes: complete ? [] : ['DIRECT_SALE_EXTRA_MISSING'], cod_priced_as_direct: true, minimum_profits: [],
      direct_sale_extras: [], extra_suggestions: MODELS.map((m) => ({ option_id: m.option_id, direct_sale_extra_iqd: 50000 })),
      adoption: {
        kind: complete ? 'adopt' : null, mode: 'manual', complete, missing_codes: complete ? [] : ['DIRECT_SALE_EXTRA_MISSING'], needs_write: complete, preview_hash: complete ? 'c'.repeat(64) : null,
        large_change: complete, drop_flag: false, legacy_step: false, cod_priced_as_direct: true, review_pending: false, usd_iqd_rate: '1650',
        rows: complete ? MODELS.flatMap((m) => [adoptionRow(m, 'direct_sale', typed!), adoptionRow(m, 'pre_order_land', typed!)]) : [],
      },
    }],
  };
};

// ----------------------------------------------------------------- the purchase documents
const state = { name: 'شحنة قديمة' };
const purchase = () => ({ id: 'doc-1', invoice_no: state.name, supplier_name: 'Germany', status: 'ordered', cost_state: 'final', total_cost_iqd: 12853822, paid_iqd: 0, version: 2, request_json: '{}', ...header, invoice_no: state.name });
const savedLine = (m: (typeof MODELS)[number], i: number) => ({ ...draftLine(m.option_id, m.n, 320), id: `inc-${i}`, line_id: `pol-${i}`, qty_received: 0, rejected_qty: 0, purchase_unit_iqd: 528000, purchase_total_iqd: 3696000, auto_shipping_iqd: 384300, charges_iqd: 384300 });
const funding = { investor_name: 'Investor', user_id: 'investor', agreed_iqd: 13000000, allocated_iqd: 12853822, received_iqd: 0, unallocated_iqd: 0, store_contribution_iqd: 0, funding_shortfall_iqd: 12853822, profit_share_bps: 3500 };

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin), path = url.pathname, method = init?.method || 'GET';
  if (!path.startsWith('/api/')) return realFetch(input, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ path, method, body });
  let data: Record<string, unknown> | undefined;
  if (path === '/api/admin/procurement/config') data = { suppliers: [{ id: 'germany', name: 'Germany' }], locations: [], investors: [], cost_profiles: [profile] };
  else if (path === '/api/admin/procurement/documents' && method === 'GET') data = { purchases: [purchase(), { ...purchase(), id: 'doc-2', invoice_no: '', status: 'draft' }] };
  else if (path === '/api/admin/procurement/documents' && method === 'POST') { state.name = String(body?.invoice_no ?? ''); data = { id: 'doc-1' }; }
  else if (path === '/api/admin/procurement/documents/doc-1/name' && method === 'PATCH') { state.name = String(body?.name ?? '').replace(/\s+/g, ' ').trim(); data = { id: 'doc-1', name: state.name }; }
  else if (path === '/api/admin/procurement/documents/doc-1' && method === 'GET') data = { purchase: purchase(), funding, lines: MODELS.map(savedLine), charges: [], payments: [], ordered_total_iqd: 12853822, paid_iqd: 0, balance_iqd: 12853822, matching: { ordered_qty: 14, received_qty: 0, invoiced_qty: 14, rejected_qty: 0, invoice_difference_iqd: null } };
  else if (path === '/api/admin/pricing/procurement/preview') data = pricingPreview(body);
  else if (path === '/api/admin/pricing/products/a1/apply-purchase') data = { already: false, product_id: 'a1', rows_changed: 2, priced: true, entered: true };
  return new Response(JSON.stringify(data ? { success: true, ...data } : { success: false, error: `Fixture missing ${method} ${path}` }), { status: data ? 200 : 404, headers: { 'content-type': 'application/json' } });
}) as typeof window.fetch;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><LanguageProvider><div className="ap" dir={params.get('lang') === 'en' ? 'ltr' : 'rtl'} style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}><ProcurementPanel onChanged={() => {}} /></div></LanguageProvider></React.StrictMode>,
);
