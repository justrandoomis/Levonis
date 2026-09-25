/**
 * THE MERCHANT CATALOGUE, MOUNTED AS SHIPPED (merchant platform W2-F) — the
 * products tab, the product editor with variants, the collections tab and
 * the storefront product page with its variant picker, over a scripted API,
 * for scripts/e2e-catalog.mjs to screenshot in Arabic and English at 360px
 * and 1280px. A browser fixture beside ui-kit.html, served only by a local
 * `vite` dev server, never reachable from production.
 *
 *   /tests/browser/catalog.html?lang=ar|en&view=manager|editor|collections|product
 *
 * `window.fetch` answers the endpoints these screens call with the shapes the
 * Worker returns (tests/catalogRoutes.test.ts pins those shapes).
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import { StoreProvider } from '../../src/StoreContext';
import { CatalogManager } from '../../src/components/merchant/catalog/CatalogManager';
import { CollectionsManager } from '../../src/components/merchant/catalog/CollectionsManager';
import ProductEditorSheet from '../../src/components/merchant/catalog/ProductEditorSheet';
import StorefrontProduct from '../../src/pages/StorefrontProduct';
import { Toaster } from '../../src/components/ui/Toast';
import type { MerchantStore } from '../../src/lib/merchant';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
try {
  localStorage.setItem('levo_lang', lang);
} catch {
  /* Arabic, the default */
}
const view = params.get('view') ?? 'manager';

// Pictures drawn here — a fixture has no /files.
const pic = (hue: number, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${hue + 40},60%,18%)"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/><text x="300" y="320" font-size="64" text-anchor="middle" fill="white" font-family="sans-serif">${label}</text></svg>`
  )}`;
const PICS = [pic(20, 'Dragon'), pic(210, 'Blue'), pic(0, 'Red')];

const ATTR = { material: 'petg', technology: 'fdm', color: null, finish: 'sanded', dim_x_mm: 120, dim_y_mm: 80, dim_z_mm: 150, weight_g: 210 };
const base = {
  slug: 'dragon', name_ar: '', description: '', description_ar: '', original_price_iqd: null, compare_at_iqd: null, sku: '', category: 'مجسمات',
  condition: 'new', prep_days: 2, lifecycle: 'active', status: 'active', legacy_note: null, options: [], colors: [], delivery_methods: [],
  collection_ids: ['c1'], section_id: null, featured: false, view_count: 120, moderation: null, created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-20T10:00:00Z',
  attributes: ATTR, low_stock_threshold: 3,
};
const LIST = [
  { ...base, id: 'p1', name: lang === 'en' ? 'Articulated dragon' : 'تنين مفصلي مطبوع', images: [PICS[0]], price_iqd: 18000, stock: 9, track_stock: true, state: 'published', sold_out: false, low_stock: true, variant_mode: 'variants', variant_count: 6, price_range: { min: 18000, max: 26000 }, sold_count: 41 },
  { ...base, id: 'p2', name: lang === 'en' ? 'Phone stand' : 'حامل هاتف', images: [PICS[1]], price_iqd: 9000, stock: 0, track_stock: true, state: 'published', sold_out: true, low_stock: false, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 12, sku: 'PS-01' },
  { ...base, id: 'p3', name: lang === 'en' ? 'Planter pot' : 'أصيص نباتات', images: [PICS[2]], price_iqd: 12500, stock: 14, track_stock: true, state: 'draft', sold_out: false, low_stock: false, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 0 },
  { ...base, id: 'p4', name: lang === 'en' ? 'Keychain set' : 'مجموعة ميداليات', images: [], price_iqd: 3000, stock: 0, track_stock: false, state: 'hidden', sold_out: false, low_stock: false, variant_mode: 'legacy', variant_count: 0, price_range: null, sold_count: 5, moderation: { hidden_by_admin: true, reason: 'صور غير واضحة', at: '2026-09-10' } },
];
const GROUPS = [
  { id: 'g_size', name: lang === 'en' ? 'Size' : 'المقاس', name_ar: '', kind: 'choice', values: [
    { id: 'v_s', name: 'S', name_ar: '', swatch: '' }, { id: 'v_m', name: 'M', name_ar: '', swatch: '' }, { id: 'v_l', name: 'L', name_ar: '', swatch: '' }] },
  { id: 'g_col', name: lang === 'en' ? 'Colour' : 'اللون', name_ar: '', kind: 'color', values: [
    { id: 'v_red', name: lang === 'en' ? 'Red' : 'أحمر', name_ar: '', swatch: 'red' }, { id: 'v_blue', name: lang === 'en' ? 'Blue' : 'أزرق', name_ar: '', swatch: 'blue' }] },
];
const V = (id: string, a: string, b: string, price: number | null, stock: number, active = true) => ({
  id, value_ids: [a, b], label: `${a}/${b}`, price_iqd: price, compare_at_iqd: null, stock, sku: `DR-${id}`, active, image_key: b === 'v_blue' ? 'merchants/u/public/b.webp' : null, low_stock_threshold: null,
});
const VARIANTS = [V('1', 'v_s', 'v_red', null, 3), V('2', 'v_s', 'v_blue', null, 0), V('3', 'v_m', 'v_red', 22000, 4), V('4', 'v_m', 'v_blue', 22000, 2), V('5', 'v_l', 'v_red', 26000, 0, false), V('6', 'v_l', 'v_blue', 26000, 0)];
const DETAIL = {
  ...LIST[0],
  media: [
    { id: 'm1', kind: 'image', key: 'merchants/u/public/a.webp', url: PICS[0], alt: '', alt_ar: '' },
    { id: 'm2', kind: 'image', key: 'merchants/u/public/b.webp', url: PICS[1], alt: '', alt_ar: '' },
    { id: 'm3', kind: 'video', key: 'merchants/u/public/c.mp4', url: '/nothing.mp4', alt: '', alt_ar: '' },
  ],
  option_groups: GROUPS,
  variants: VARIANTS,
};
const COLLECTIONS = [
  { id: 'c1', name: lang === 'en' ? 'Figures' : 'مجسمات', name_ar: '', kind: 'manual', description: '', description_ar: '', image_url: null, image_key: null, sort_order: 0, active: true, product_count: 7 },
  { id: 'c2', name: lang === 'en' ? 'Featured' : 'منتجات مميّزة', name_ar: '', kind: 'featured', description: '', description_ar: '', image_url: null, image_key: null, sort_order: 1, active: true, product_count: 3 },
  { id: 'c3', name: lang === 'en' ? 'Home' : 'للبيت', name_ar: '', kind: 'manual', description: '', description_ar: '', image_url: null, image_key: null, sort_order: 2, active: false, product_count: 4 },
];
const STORE = {
  id: 's1', merchant_id: 'm1', slug: 'ali3d', url: '/community/store/ali3d', name: lang === 'en' ? 'Ali 3D prints' : 'علي للطباعة', tagline: '', description: '', logoUrl: null, bannerUrl: null,
  accent: 'olive', categories: [], governorate: 'baghdad', service_areas: [], contact_phone: null, business_hours: [], policies: {}, social_links: {},
  accepts_custom_requests: true, sells_direct_products: true, status: 'active', open: true,
  merchant: { verified: true, pro_badge: false, rating: 4.8, rating_count: 23 },
  delivery_to_you: { governorate: 'baghdad', available: true, reason: null, fee_iqd: 3000, free: false, free_over_iqd: null, prep_days: 1, eta_note: '' },
} as unknown as MerchantStore;
const PUBLIC_PRODUCT = {
  ...LIST[0],
  description: lang === 'en' ? 'A fully articulated dragon, printed in one piece. Every joint moves.' : 'تنين مفصلي بالكامل، مطبوع قطعة واحدة. كل مفصل يتحرك.',
  in_stock: true,
  media: [
    { kind: 'image', url: PICS[0], alt: '', alt_ar: '' },
    { kind: 'image', url: PICS[1], alt: '', alt_ar: '' },
    { kind: 'video', url: '/nothing.mp4', alt: '', alt_ar: '' },
  ],
  option_groups: GROUPS.map((g) => ({ ...g, values: g.values })),
  variants: VARIANTS.filter((v) => v.active).map((v) => ({
    id: v.id, value_ids: v.value_ids, price_iqd: v.price_iqd ?? 18000, compare_at_iqd: v.id === '3' ? 25000 : null, in_stock: v.stock > 0, image: v.value_ids[1] === 'v_blue' ? PICS[1] : null,
  })),
};

function answer(path: string, method: string): { status: number; body: unknown } {
  if (path === '/api/auth/me') return { status: 200, body: { success: true, user: { id: 'buyer', name: 'Sara', email: 's@x.co', role: 'user' } } };
  if (path === '/api/storefront/resolve') return { status: 200, body: { success: true, kind: 'main', store: null } };
  if (path === '/api/merchant/products/stats') return { status: 200, body: { success: true, totals: { total: 4, published: 2, draft: 1, hidden: 1, archived: 0, out_of_stock: 1, low_stock: 1, views: 480, sold: 58 }, categories: [] } };
  if (path === '/api/merchant/products' && method === 'GET') return { status: 200, body: { success: true, products: LIST, total: 4, next_cursor: null } };
  if (/^\/api\/merchant\/products\/p\d$/.test(path)) return { status: 200, body: { success: true, product: DETAIL } };
  if (path === '/api/merchant/collections') return { status: 200, body: { success: true, collections: COLLECTIONS } };
  if (path === '/api/merchant/printers') return { status: 200, body: { success: true, printers: [], materials: [{ id: 'pla', name_en: 'PLA', name_ar: 'PLA' }, { id: 'petg', name_en: 'PETG', name_ar: 'PETG' }] } };
  if (path.startsWith('/api/storefront/ali3d/products/')) return { status: 200, body: { success: true, product: PUBLIC_PRODUCT, store: STORE } };
  return { status: 200, body: { success: true } };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
  const r = answer(u.pathname, (init?.method ?? 'GET').toUpperCase());
  await new Promise((res) => setTimeout(res, 40));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

function Dashboard({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-canvas text-text-secondary">
      <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">{children}</div>
      <Toaster />
    </div>
  );
}

function App() {
  if (view === 'product') {
    return (
      <Routes>
        <Route path="/community/store/:slug/p/:productSlug" element={<StorefrontProduct />} />
      </Routes>
    );
  }
  if (view === 'collections') return <Dashboard><CollectionsManager canSell /></Dashboard>;
  if (view === 'editor') {
    return (
      <Dashboard>
        <ProductEditorSheet open productId="p1" canSell collections={COLLECTIONS as never} onClose={() => {}} onSaved={() => {}} />
      </Dashboard>
    );
  }
  return <Dashboard><CatalogManager canSell store={STORE} /></Dashboard>;
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <AuthProvider>
      <StoreProvider>
        <MemoryRouter initialEntries={[view === 'product' ? '/community/store/ali3d/p/dragon' : '/merchant']}>
          <App />
        </MemoryRouter>
      </StoreProvider>
    </AuthProvider>
  </LanguageProvider>
);
