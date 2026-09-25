/**
 * PRINT REQUESTS v2 (stream W5-A), as shipped, on canned answers.
 *
 * A browser fixture (served only by a local `vite`) for screenshots of the
 * wizard and the offers in Arabic and English at a phone and a desktop width:
 *
 *   /tests/browser/print-requests-v2.html?lang=ar|en|ckb&view=wizard|new|offers|merchant|mine|viewer|viewer-full
 *
 * `viewer` is /model-viewer/<token> with the grant a board merchant gets
 * ('preview' — the «معاينة مبسّطة» label); `viewer-full` the customer's.
 *
 * `fetch` is answered with the shapes worker/routes/printRequests.ts and
 * marketplace.ts return; the components themselves are untouched.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { Toaster } from '../../src/components/ui/Toast';
import RequestWizard from '../../src/components/community/requests/RequestWizard';
import OfferCompare from '../../src/components/community/offers/OfferCompare';
import MerchantOfferPanel from '../../src/components/community/offers/MerchantOfferPanel';
import ModelViewer from '../../src/pages/ModelViewer';
import MyOffersList from '../../src/components/community/offers/MyOffersList';
import type { OfferV2 } from '../../src/components/community/offers/types';
import type { CatalogMaterial } from '../../src/components/community/requests/api';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const view = params.get('view') ?? 'wizard';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';

const materials: CatalogMaterial[] = [
  { id: 'pla', process: 'fdm', name_en: 'PLA', name_ar: 'PLA', needs_enclosure: false, abrasive: false },
  { id: 'petg', process: 'fdm', name_en: 'PETG', name_ar: 'PETG', needs_enclosure: false, abrasive: false },
  { id: 'abs', process: 'fdm', name_en: 'ABS', name_ar: 'ABS', needs_enclosure: true, abrasive: false },
  { id: 'tpu', process: 'fdm', name_en: 'TPU (flexible)', name_ar: 'TPU مرن', needs_enclosure: false, abrasive: false },
  { id: 'resin-standard', process: 'resin', name_en: 'Standard resin', name_ar: 'ريزن قياسي', needs_enclosure: false, abrasive: false },
  { id: 'resin-tough', process: 'resin', name_en: 'Tough resin', name_ar: 'ريزن متين', needs_enclosure: false, abrasive: false },
];
const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const draft = {
  id: 'req_1', state: 'draft', revision: 1, title: lang === 'en' ? 'Car phone holder' : 'حامل هاتف للسيارة',
  description: lang === 'en' ? 'A holder that clips onto the air vent, for a 6.7" phone.' : 'حامل يثبت على فتحة المكيف، لهاتف 6.7 إنش.',
  customer_notes: lang === 'en' ? 'Matte black if possible.' : 'أسود مطفي إن أمكن.', quantity: 2, governorate: 'baghdad', delivery_pref: 'delivery',
  deadline: day(9).slice(0, 10), budget_iqd: 25000, expires_at: day(14), live_offers: 0,
  print: { source_type: 'model', process: 'unsure', material_id: 'unsure', quality: 'standard', infill_percent: 20, supports: true, colors_count: 1, post_processing_minutes: 0, color_hex: '#1a1a1a', color_name: 'Black', primary_file_id: 'crf_1', source_url: '', source_meta: {}, stated_dimensions_mm: null },
  files: [{ id: 'crf_1', file_name: 'phone-holder-v3.stl', content_type: 'model/stl', size_bytes: 1_842_112, kind: 'model', inline: false, url: '#', analysis: { measured: true, format: 'stl', dimensions_mm: { x: 82.4, y: 64, z: 41.2 }, volume_mm3: 38000, warnings: [] } }],
};
const M = (id: string, name: string, rating: number | null, n: number, done: number, verified = false) => ({ id, name, verified, badge: '', rating, rating_count: n, completed_orders: done, store_slug: id });
const offers: OfferV2[] = [
  { id: 'off_1', request_id: 'req_1', merchant_id: 'm1', price_iqd: 18000, completion_days: 3, delivery_method: 'merchant_delivery', message: lang === 'en' ? 'I can start tomorrow, black PETG in stock.' : 'أبدأ غدًا، عندي PETG أسود.', materials: '', material_ids: ['petg'], included: lang === 'en' ? 'Light sanding' : 'صنفرة خفيفة', warranty_terms: lang === 'en' ? 'Reprint if it cracks in 30 days' : 'إعادة طباعة إن انكسر خلال 30 يومًا', state: 'pending', expires_at: day(6), created_at: day(-1), updated_at: day(-1), revision: 2, request_revision: 1, stale: false, expired: false, history: [{ revision: 1, request_revision: 1, price_iqd: 21000, completion_days: 3, delivery_method: 'merchant_delivery', reason: 'create', created_at: day(-2) }, { revision: 2, request_revision: 1, price_iqd: 18000, completion_days: 3, delivery_method: 'merchant_delivery', reason: 'edit', created_at: day(-1) }], merchant: M('m1', 'Ali 3D', 4.8, 23, 41, true) },
  { id: 'off_2', request_id: 'req_1', merchant_id: 'm2', price_iqd: 24500, completion_days: 2, delivery_method: 'courier', message: '', materials: '', material_ids: ['abs', 'petg'], included: lang === 'en' ? 'Two colour options' : 'خياران للون', warranty_terms: '', state: 'pending', expires_at: day(12), created_at: day(-1), updated_at: day(-1), revision: 1, request_revision: 1, stale: false, expired: false, history: [], merchant: M('m2', 'Omar Print Lab', 4.5, 9, 12) },
  { id: 'off_3', request_id: 'req_1', merchant_id: 'm3', price_iqd: 15000, completion_days: 6, delivery_method: 'pickup', message: '', materials: '', material_ids: ['pla'], included: '', warranty_terms: '', state: 'superseded', expires_at: null, created_at: day(-3), updated_at: day(-1), revision: 1, request_revision: 0, stale: true, expired: false, history: [], merchant: M('m3', 'Basra Makers', null, 0, 0) },
];
const mine = [
  { ...offers[2], state: 'superseded', request: { id: 'req_1', title: draft.title, state: 'receiving_offers', revision: 2, expires_at: day(20) }, order_id: null },
  { ...offers[0], request: { id: 'req_2', title: lang === 'en' ? 'Gear for a mixer' : 'ترس لخلاط', state: 'receiving_offers', revision: 1, expires_at: day(10) }, order_id: null },
  { ...offers[1], id: 'off_9', state: 'accepted', request: { id: 'req_3', title: lang === 'en' ? 'Replacement knob ×4' : 'مقبض بديل ×4', state: 'in_progress', revision: 1, expires_at: null }, order_id: 'cord_1' },
  { ...offers[1], id: 'off_8', state: 'expired', expired: true, request: { id: 'req_4', title: lang === 'en' ? 'Cosplay helmet' : 'خوذة كوسبلاي', state: 'expired', revision: 1, expires_at: null }, order_id: null },
];

const json = (b: unknown) => new Response(JSON.stringify({ success: true, ...(b as object) }), { headers: { 'content-type': 'application/json' } });
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), location.origin);
  const p = url.pathname;
  const m = init?.method ?? 'GET';
  if (p === '/api/marketplace/print/viewer/tok_1') return json({ format: 'stl', dimensions_mm: { x: 82.4, y: 64, z: 41.2 }, volume_mm3: 38000, triangle_count: 12840, shell_count: 1, expires_at: day(1), grant: view === 'viewer' ? 'preview' : 'full' });
  if (p === '/api/marketplace/print/catalog') return json({ materials, qualities: [], min_job_iqd: 0 });
  if (p.endsWith('/draft')) return json({ draft: view === 'edit' ? { ...draft, state: 'receiving_offers', live_offers: 2 } : draft });
  if (p === '/api/marketplace/print/quote') return json({ quote: { priced: true, price_iqd: 21000, price_low_iqd: 14000, price_high_iqd: 29000, confidence: 'low', range_basis: 'materials' } });
  if (p.endsWith('/revisions')) return json({ current: 2, revisions: [{ revision: 1, created_at: day(-3), changes: [], reason: 'publish' }, { revision: 2, created_at: day(-1), changes: ['quantity', 'material_id'], reason: 'edit' }] });
  if (p === '/api/marketplace/my-offers') return json({ offers: mine, next_cursor: null });
  if (p === '/api/addresses') return json({ addresses: [{ id: 'a1', label: lang === 'en' ? 'Home' : 'البيت', name: 'Sara', phone: '+9647700000009', address: lang === 'en' ? 'Karrada, street 12' : 'الكرادة، شارع 12', landmark: '', governorate: 'baghdad', area: '', notes: '', is_default: 1, created_at: '' }] });
  if (p.startsWith('/api/marketplace/orders/')) return json({ role: 'merchant', order: { id: 'cord_1', state: 'funded' }, thread: { request_id: 'req_3', merchant_id: 'm2' }, contact: { name: 'Sara K', phone: '+9647700000009', governorate: 'baghdad', area: 'Karrada', address: lang === 'en' ? 'Street 12, house 4' : 'شارع 12، دار 4', landmark: lang === 'en' ? 'near the mosque' : 'قرب الجامع', delivery_method: 'merchant_delivery' } });
  void m;
  return new Response(JSON.stringify({ success: false }), { status: 404 });
};

function Page() {
  if (view === 'viewer' || view === 'viewer-full') {
    return (
      <Routes>
        <Route path="/model-viewer/:token" element={<ModelViewer />} />
      </Routes>
    );
  }
  return (
    <div className="min-h-screen bg-canvas px-4 py-5 text-text-primary sm:px-6">
      <div className="mx-auto max-w-2xl lg:max-w-5xl">
        {view === 'wizard' || view === 'new' || view === 'edit' ? (
          <div className="mx-auto max-w-2xl">
            <RequestWizard requestId={view === 'new' ? undefined : 'req_1'} onDone={() => undefined} onCancel={() => undefined} />
          </div>
        ) : view === 'offers' ? (
          <>
            <h2 className="mb-3 text-[13px] font-bold text-gold">{lang === 'en' ? 'Offers received' : 'العروض المقدّمة'}</h2>
            <OfferCompare requestId="req_1" offers={offers} takingOffers materials={materials} onChanged={() => undefined} />
          </>
        ) : view === 'merchant' ? (
          <div className="mx-auto max-w-2xl space-y-6">
            <MerchantOfferPanel requestId="req_1" offers={[offers[2]]} canOffer takingOffers materials={materials} onChanged={() => undefined} />
            <MerchantOfferPanel requestId="req_3" offers={[{ ...offers[1], state: 'accepted', order_id: 'cord_1' }]} canOffer takingOffers={false} materials={materials} onChanged={() => undefined} />
          </div>
        ) : (
          <div className="mx-auto max-w-2xl">
            <MyOffersList requestHref={(id) => `#${id}`} />
          </div>
        )}
      </div>
    </div>
  );
}

// AuthProvider as in src/App: the offer cards' «زيارة المتجر» link reads the session (signed out here: /api/auth/me is a 404).
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
  <LanguageProvider>
    <MemoryRouter initialEntries={[view.startsWith('viewer') ? '/model-viewer/tok_1' : '/']}>
      <Page />
      <Toaster />
    </MemoryRouter>
  </LanguageProvider>
  </AuthProvider>
);
