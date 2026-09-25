/**
 * DELIVERY BY GOVERNORATE, MOUNTED AS SHIPPED (merchant platform W2-A) — the
 * store checkout and the merchant's delivery editor over a scripted API, for
 * scripts/e2e-delivery.mjs to screenshot in Arabic and English at 360px and
 * 1280px. A browser fixture beside ui-kit.html, served only by a local `vite`
 * dev server, never reachable from production.
 *
 *   /tests/browser/delivery.html?lang=ar|en&view=checkout&state=fee|free_over|pickup|unavailable|governorate|no_address
 *   /tests/browser/delivery.html?lang=ar|en&view=editor
 *
 * `window.fetch` answers the few endpoints these screens call with the shapes
 * the Worker returns (tests/storeDeliveryCheckout.test.ts pins those shapes).
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import StoreCheckout from '../../src/pages/StoreCheckout';
import DeliverySettingsEditor from '../../src/components/merchant/delivery/DeliverySettingsEditor';
import { Toaster } from '../../src/components/ui/Toast';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
try {
  localStorage.setItem('levo_lang', lang);
} catch {
  /* Arabic, the default */
}
const view = params.get('view') ?? 'checkout';
const state = params.get('state') ?? 'fee';

const ADDRESSES = [
  { id: 'a_bag', label: 'البيت', name: 'سارة', phone: '+9647701234567', address: 'الكرادة، شارع 62', landmark: '', governorate: 'baghdad', area: '', notes: '', is_default: 1, created_at: '' },
  { id: 'a_bas', label: 'العمل', name: 'سارة', phone: '+9647701234567', address: 'العشار، قرب الكورنيش', landmark: '', governorate: 'basra', area: '', notes: '', is_default: 0, created_at: '' },
  { id: 'a_old', label: 'عنوان قديم', name: 'سارة', phone: '+9647701234567', address: 'قرب السوق', landmark: '', governorate: '', area: '', notes: '', is_default: 0, created_at: '' },
];
const SERVED = ['baghdad', 'nineveh', 'erbil', 'sulaymaniyah', 'duhok', 'kirkuk', 'diyala', 'anbar', 'babil', 'karbala', 'najaf', 'wasit'];
const PICKUP = { governorate: 'baghdad', note: 'الكرادة داخل، اتصل قبل المجيء' };
const LINES = [
  { cart_item_id: 'ci1', product_id: 'p1', name: 'بكرة PLA حرير — 1 كغ', image: '', qty: 2, unit_price_iqd: 14000, line_total_iqd: 28000, variant: 'ذهبي' },
  { cart_item_id: 'ci2', product_id: 'p2', name: 'حامل هاتف مطبوع', image: '', qty: 1, unit_price_iqd: 9000, line_total_iqd: 9000, variant: '' },
];
const PREVIEW = { store_id: 's1', store_name: 'علي للطباعة', store_slug: 'ali3d', lines: LINES, subtotal_iqd: 37000, coupon_code: '', discount_iqd: 0 };

function quote(fulfilment: string, addressId: string) {
  const pickup = fulfilment === 'pickup';
  const freeOver = state === 'free_over';
  const fee = pickup || freeOver ? 0 : 3000;
  const total = 37000 + fee;
  return {
    ...PREVIEW,
    delivery_iqd: fee,
    delivery: {
      fulfilment, address_id: addressId, governorate: pickup ? 'baghdad' : 'baghdad',
      rule: pickup ? 'pickup' : freeOver ? 'free_over' : 'override', fee_iqd: fee, base_fee_iqd: pickup ? 0 : 3000,
      free_over_iqd: pickup ? null : freeOver ? 30000 : 50000, prep_days: 2, eta_note: pickup ? '' : 'نفس اليوم داخل بغداد',
      note: pickup ? PICKUP.note : 'نوصل عبر مندوبنا', served: SERVED, pickup: PICKUP,
    },
    total_iqd: total, expected_total_iqd: total, quote_fingerprint: `fp-${fulfilment}-${addressId}`,
    payment_method: 'wallet', wallet_available_iqd: 150000, wallet_covers: true, wallet_shortfall_iqd: 0, wallet_topup_url: '/wallet',
  };
}

function refuse(code: string, extra: Record<string, unknown>) {
  return { status: 409, body: { success: false, error: code, code, details: { served: SERVED, pickup: PICKUP, fulfilment: 'delivery', preview: PREVIEW, ...extra } } };
}

const CONFIG = {
  profile: { default_mode: 'fee', default_fee_iqd: 5000, free_over_iqd: 50000, free_over_basis: 'after_discount', pickup_enabled: true, pickup_governorate: 'baghdad', pickup_note: 'الكرادة داخل، اتصل قبل المجيء', prep_days: 1, note: 'نوصل عبر مندوبنا', version: 3 },
  rules: [
    { governorate_id: 'baghdad', mode: 'fee', fee_iqd: 3000, free_over_iqd: null, prep_days: null, eta_note: 'نفس اليوم', note: '' },
    { governorate_id: 'erbil', mode: 'free', fee_iqd: null, free_over_iqd: null, prep_days: 3, eta_note: '', note: '' },
    { governorate_id: 'basra', mode: 'disabled', fee_iqd: null, free_over_iqd: null, prep_days: null, eta_note: '', note: '' },
  ],
  configured: true,
  store_open: true,
  coverage: { served: SERVED, pickup: true, serviceable: true },
};

function answer(path: string, method: string, body: Record<string, unknown>): { status: number; body: unknown } {
  if (path.startsWith('/api/addresses')) {
    return { status: 200, body: { success: true, addresses: state === 'no_address' ? [] : ADDRESSES, approved_snapshot: null } };
  }
  if (path === '/api/store-orders/quote') {
    if (state === 'no_address') return refuse('ADDRESS_REQUIRED', {});
    const fulfilment = String(body.fulfilment ?? 'delivery');
    const addressId = String(body.addressId ?? (state === 'unavailable' ? 'a_bas' : state === 'governorate' ? 'a_old' : 'a_bag'));
    if (fulfilment === 'pickup') return { status: 200, body: { success: true, quote: quote('pickup', addressId) } };
    if (addressId === 'a_bas') return refuse('DELIVERY_UNAVAILABLE', { address_id: 'a_bas', governorate: 'basra', reason: 'governorate_disabled' });
    if (addressId === 'a_old') return refuse('ADDRESS_GOVERNORATE_REQUIRED', { address_id: 'a_old', governorate: '', reason: 'governorate_required' });
    return { status: 200, body: { success: true, quote: quote(state === 'pickup' ? 'pickup' : 'delivery', addressId) } };
  }
  if (path === '/api/merchant/delivery') {
    if (method === 'PUT') return { status: 200, body: { success: true, ...CONFIG, profile: { ...CONFIG.profile, version: 4 } } };
    return { status: 200, body: { success: true, ...CONFIG } };
  }
  return { status: 200, body: { success: true } };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
  let body: Record<string, unknown> = {};
  try {
    body = init?.body ? JSON.parse(String(init.body)) : {};
  } catch {
    /* not JSON */
  }
  const r = answer(u.pathname, (init?.method ?? 'GET').toUpperCase(), body);
  await new Promise((res) => setTimeout(res, 60));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

function App() {
  if (view === 'editor') {
    return (
      <div className="min-h-[100dvh] bg-canvas text-text-secondary">
        <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4">
          <DeliverySettingsEditor storeGovernorate="baghdad" />
        </div>
        <Toaster />
      </div>
    );
  }
  return <StoreCheckout />;
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <MemoryRouter initialEntries={['/store-checkout']}>
      <App />
    </MemoryRouter>
  </LanguageProvider>
);
