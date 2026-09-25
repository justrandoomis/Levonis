/**
 * ELIGIBILITY AS DATA (stream W5-B), as shipped, on canned answers.
 *
 * A browser fixture (served only by a local `vite`) for screenshots of the
 * workshop's screens in Arabic and English at a phone and a desktop width:
 *
 *   /tests/browser/workshop.html?lang=ar|en&view=board|card|reasons|costing|printers
 *
 * `fetch` is answered with the shapes worker/routes/merchantWorkshop.ts and
 * merchantPrinters.ts return; the components themselves are untouched.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import RequestBoard from '../../src/components/merchant/workshop/RequestBoard';
import WorkshopRequestCard from '../../src/components/merchant/workshop/WorkshopRequestCard';
import { PrintersTab } from '../../src/components/merchant/dashboard/PrintersTab';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const view = params.get('view') ?? 'board';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
const en = lang === 'en';

const materials = [
  { id: 'pla', process: 'fdm' as const, name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false },
  { id: 'petg', process: 'fdm' as const, name_en: 'PETG', name_ar: 'PETG', needs_enclosure: false, abrasive: false },
  { id: 'abs', process: 'fdm' as const, name_en: 'ABS', name_ar: 'ABS', needs_enclosure: true, abrasive: false },
  { id: 'pla-cf', process: 'fdm' as const, name_en: 'PLA-CF', name_ar: 'PLA كربون', needs_enclosure: false, abrasive: true },
  { id: 'resin-standard', process: 'resin' as const, name_en: 'Standard resin', name_ar: 'ريزن قياسي', needs_enclosure: false, abrasive: false },
];
const photo = (a: string, b: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><rect x="18" y="22" width="28" height="20" rx="3" fill="#ffffff" fill-opacity=".85"/></svg>`)}`;
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const row = (id: string, o: Record<string, unknown>) => ({
  id, description: '', quantity: 1, material: '', color: '', dimensions: '', budget_iqd: null, deadline: null,
  governorate: 'baghdad', delivery_pref: 'delivery', state: 'open', offer_count: 0, created_at: day(-1), expires_at: day(20),
  revision: 1, customer_notes: '', process: 'fdm', material_id: 'pla', estimate_low_iqd: null, estimate_high_iqd: null,
  file_count: 2, thumb_url: null, has_preview: true, my_offer: null, ...o,
});
const board = [
  row('req_1', { title: en ? 'Car phone holder, clips onto the vent' : 'حامل هاتف للسيارة يثبت على فتحة المكيف', quantity: 2, budget_iqd: 25000, offer_count: 3, thumb_url: photo('#3b4252', '#5e81ac') }),
  row('req_2', { title: en ? 'Replacement gear for a kitchen mixer' : 'ترس بديل لخلاط المطبخ', material_id: 'petg', estimate_low_iqd: 9000, estimate_high_iqd: 14000, governorate: 'basra', offer_count: 1, my_offer: 'pending', thumb_url: photo('#4c566a', '#a3be8c') }),
  row('req_3', { title: en ? 'Cosplay helmet, painted' : 'خوذة كوسبلاي مطلية', process: null, material_id: null, budget_iqd: 120000, governorate: 'erbil', has_preview: false, offer_count: 5, my_offer: 'superseded' }),
  row('req_4', { title: en ? 'Name sign for a shop front, 40 cm' : 'لوحة اسم لواجهة محل، 40 سم', quantity: 1, material_id: 'pla', budget_iqd: 60000, thumb_url: photo('#2e3440', '#d08770') }),
];

const eligible = {
  request_id: 'req_1', revision: 1, eligible: true, reason: '', reasons: [],
  dims: { trade: 'pass', capability: 'pass', stock: 'pass', reach: 'pass', preference: 'pass' },
  notify: true, notify_block: '', printer: { id: 'p1', name: 'Bambu Lab P1S' }, stock_tracked: true,
};
const notEligible = {
  ...eligible, eligible: false, reason: 'BUILD_VOLUME', reasons: ['BUILD_VOLUME', 'STOCK_COLOR', 'REACH_DELIVERY'], printer: null,
  dims: { trade: 'pass', capability: 'fail', stock: 'fail', reach: 'fail', preference: 'pass' },
};
const costing = {
  quote_id: 'pq_2', request_revision: 1, printer: { id: 'p1', name: 'Bambu Lab P1S' }, material_id: 'pla', quality_id: 'standard', strength_id: 'standard', quantity: 2,
  quote: {
    confidence: 'estimated', true_cost_iqd: 7400, price_iqd: 11400, profit_iqd: 4000, margin_percent: 35.1, machine_hours: 2.6, waste_grams: 6, range_iqd: { low: 10200, high: 12900 },
    lines: [
      { component: 'MODEL_MATERIAL', iqd: 2100, from: 'merchant' }, { component: 'SUPPORT_MATERIAL', iqd: 300, from: 'platform' },
      { component: 'ELECTRICITY', iqd: 400, from: 'merchant' }, { component: 'DEPRECIATION', iqd: 1900, from: 'merchant' },
      { component: 'LABOR', iqd: 1500, from: 'merchant' }, { component: 'FAILURE_RESERVE', iqd: 700, from: 'platform' },
      { component: 'PLATFORM_FEES', iqd: 500, from: 'platform' },
    ],
  },
};
const costs = [
  { id: 'pq_1', price_iqd: 12500, true_cost_iqd: 8100, profit_iqd: 4400, margin_percent: 35, machine_hours: 2.8, confidence: 'estimated', state: 'draft', created_at: day(-1), printer: { id: 'p1', name: 'Bambu Lab P1S' }, material_id: 'pla', request_revision: 1, stale: false },
  { id: 'pq_0', price_iqd: 15000, true_cost_iqd: 9800, profit_iqd: 5200, margin_percent: 35, machine_hours: 3.4, confidence: 'estimated', state: 'draft', created_at: day(-3), printer: { id: 'p3', name: 'Ender 3' }, material_id: 'pla', request_revision: 0, stale: true },
];
const models = [
  { id: 'bbl-p1s', manufacturer: 'Bambu Lab', model: 'P1S', technology: 'fdm', build_mm: { x: 256, y: 256, z: 250 }, nozzle_sizes_mm: [0.2, 0.4, 0.6, 0.8], default_nozzle_mm: 0.4, enclosed: true, hardened_nozzle_available: true, max_colors: 4, multi_material: 'single_nozzle_changer' },
  { id: 'cr-k1', manufacturer: 'Creality', model: 'K1', technology: 'fdm', build_mm: { x: 220, y: 220, z: 250 }, nozzle_sizes_mm: [0.4, 0.6, 0.8], default_nozzle_mm: 0.4, enclosed: true, hardened_nozzle_available: false, max_colors: 1, multi_material: 'none' },
  { id: 'el-saturn4ultra', manufacturer: 'Elegoo', model: 'Saturn 4 Ultra', technology: 'resin', build_mm: { x: 218, y: 122, z: 220 }, nozzle_sizes_mm: [], default_nozzle_mm: 0, enclosed: false, hardened_nozzle_available: false, max_colors: 1, multi_material: 'none' },
];
const printers = [
  { id: 'p1', name: 'Bambu Lab P1S', technology: 'fdm', brand: 'Bambu Lab', model: 'P1S', build_x_mm: 256, build_y_mm: 256, build_z_mm: 250, nozzle_mm: 0.4, materials: ['pla', 'petg', 'abs'], colors: [], multicolor: true, enclosed: true, hardened_nozzle: false, quality_max: 'fine', machine_hour_iqd: 1200, availability: 'available', active: true, sort_order: 0, model_id: 'bbl-p1s', canonical: true, economics: { purchase_iqd: 1150000, useful_print_hours: 5000, electricity_iqd_per_kwh: 120, labor_iqd_per_hour: 5000, maintenance_iqd_per_hour: null } },
  { id: 'p2', name: en ? 'Saturn (resin)' : 'ساتورن (ريزن)', technology: 'resin', brand: 'Elegoo', model: 'Saturn 4 Ultra', build_x_mm: 218, build_y_mm: 122, build_z_mm: 220, nozzle_mm: 0, materials: [], colors: [], multicolor: false, enclosed: false, hardened_nozzle: false, quality_max: 'ultra', machine_hour_iqd: null, availability: 'busy', active: true, sort_order: 1, model_id: 'el-saturn4ultra', canonical: true, economics: {} },
];
const stock = {
  tracked: true, max_lines: 120, materials,
  stock: [
    { material_id: 'pla', color_hex: '#000000', color_name: en ? 'Black' : 'أسود', grams: 2750 },
    { material_id: 'pla', color_hex: '#ffffff', color_name: en ? 'White' : 'أبيض', grams: 900 },
    { material_id: 'petg', color_hex: '', color_name: '', grams: 1000 },
    { material_id: 'resin-standard', color_hex: '#808080', color_name: en ? 'Grey' : 'رمادي', grams: 0 },
  ],
};

const json = (b: unknown) => new Response(JSON.stringify({ success: true, ...(b as object) }), { headers: { 'content-type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const p = url.pathname;
  const m = init?.method ?? 'GET';
  if (p === '/api/merchant/workshop/board') return json({ requests: board, next_cursor: 'c~req_4' });
  if (p.endsWith('/eligibility')) return json(view === 'reasons' ? notEligible : eligible);
  if (p.endsWith('/costs')) return json({ revision: 1, costs });
  if (p.endsWith('/cost') && m === 'POST') return json(costing);
  if (p === '/api/merchant/printers') return json({ printers, materials, technologies: ['fdm', 'resin'], qualities: ['draft', 'standard', 'fine', 'ultra'], models });
  if (p === '/api/merchant/material-stock') return json(stock);
  if (p === '/api/merchant/request-prefs') return json({ prefs: { processes: [], materials: [], colors: [], capabilities: [], governorates: [], delivery: [], min_job_iqd: 0, max_job_iqd: null, min_size_mm: 0, max_size_mm: null, workload: 'normal', paused: false, paused_until: null }, vocabulary: { processes: ['fdm', 'resin'], capabilities: ['multicolor', 'large_format', 'high_detail', 'functional', 'flexible', 'cf'], delivery: ['delivery', 'pickup'], workloads: ['light', 'normal', 'busy', 'full'], materials } });
  if (p === '/api/merchant/request-matches') return json({ matches: [] });
  return new Response(JSON.stringify({ success: false }), { status: 404 });
};

function Page() {
  return (
    <div className="min-h-screen bg-canvas px-4 py-5 text-text-primary sm:px-6">
      <div className="mx-auto max-w-2xl">
        {view === 'board' ? (
          <RequestBoard materials={materials} onOpen={() => undefined} workshopHref="#printers" />
        ) : view === 'card' || view === 'reasons' || view === 'costing' ? (
          <WorkshopRequestCard requestId="req_1" takingOffers openCosting={view === 'costing'} onUseAsOffer={() => undefined} />
        ) : (
          <PrintersTab canSell />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <MemoryRouter>
      <Page />
      <Toaster />
    </MemoryRouter>
  </LanguageProvider>
);
