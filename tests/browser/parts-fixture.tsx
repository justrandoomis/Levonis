/**
 * PARTS AS STORE PRODUCTS, MOUNTED AS SHIPPED (Programme C, phase C1) — the
 * product editor with its «يُستخدم داخل منتجات مطبوعة» door open on a part
 * that came «من ليفونيس», the «من ليفونيس» sheet over the Levonis parts door,
 * and the products tab with its kind filter and «قطعة» chips — over a
 * scripted API, for screenshots at 360px and 1280px. A browser fixture beside
 * catalog.html, served only by a local `vite` dev server, never reachable
 * from production.
 *
 *   /tests/browser/parts.html?lang=ar|en|ckb&theme=dark|light&view=editor|new|from-levonis|manager
 *
 * `window.fetch` answers with the shapes the Worker returns
 * (tests/partSpecs.test.ts and tests/partsFromLevonis.test.ts pin them).
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { LanguageProvider } from '../../src/LanguageContext';
import { AuthProvider } from '../../src/AuthContext';
import { StoreProvider } from '../../src/StoreContext';
import { CatalogManager } from '../../src/components/merchant/catalog/CatalogManager';
import ProductEditorSheet from '../../src/components/merchant/catalog/ProductEditorSheet';
import FromLevonisSheet from '../../src/components/merchant/catalog/parts/FromLevonisSheet';
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
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');
const view = params.get('view') ?? 'editor';

const pic = (hue: number, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><radialGradient id="g"><stop offset="0" stop-color="hsl(${hue},20%,70%)"/><stop offset="1" stop-color="hsl(${hue},25%,28%)"/></radialGradient></defs><rect width="400" height="400" fill="hsl(${hue},15%,16%)"/><circle cx="200" cy="200" r="120" fill="url(#g)"/><text x="200" y="215" font-size="44" text-anchor="middle" fill="white" font-family="sans-serif">${label}</text></svg>`
  )}`;
const PICS = { magnet: pic(210, 'N52'), led: pic(45, 'LED'), nfc: pic(160, 'NFC'), screw: pic(0, 'M3'), ring: pic(280, 'Ring') };

const L = (ar: string, en: string, ckb: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb : ar);

const base = {
  slug: 'magnet', description: '', description_ar: '', original_price_iqd: null, compare_at_iqd: null, sku: '', category: '',
  condition: 'new', prep_days: 0, lifecycle: 'hidden', status: 'hidden', legacy_note: null, options: [], colors: [], delivery_methods: [],
  collection_ids: [], section_id: null, featured: false, view_count: 0, moderation: null, created_at: '2026-09-28T10:00:00Z', updated_at: '2026-09-29T10:00:00Z',
  attributes: { material: null, technology: null, color: null, finish: null, dim_x_mm: null, dim_y_mm: null, dim_z_mm: null, weight_g: 2 }, low_stock_threshold: null,
};

const GROUPS = [
  { id: 'pov_6x3', name: '6×3 mm', name_ar: '٦×٣ مم' },
  { id: 'pov_10x2', name: '10×2 mm', name_ar: '١٠×٢ مم' },
];
const DETAIL = {
  ...base,
  id: 'pp1',
  name: 'N52 Magnet',
  name_ar: 'مغناطيس N52',
  images: ['/files/merchants/u/public/lvaaa.webp'],
  price_iqd: 1000,
  stock: 40,
  track_stock: true,
  state: 'hidden',
  sold_out: false,
  low_stock: false,
  variant_mode: 'variants',
  variant_count: 2,
  price_range: { min: 1000, max: 1500 },
  sold_count: 0,
  is_part: true,
  media: [{ id: 'm1', kind: 'image', key: 'merchants/u/public/lvaaa.webp', url: PICS.magnet, alt: '', alt_ar: '' }],
  option_groups: [{ id: 'po_size', name: 'Size', name_ar: 'المقاس', kind: 'choice', values: GROUPS.map((v) => ({ ...v, swatch: '' })) }],
  variants: [
    { id: 'pv1', value_ids: ['pov_6x3'], label: '٦×٣ مم', price_iqd: null, compare_at_iqd: null, stock: 30, sku: '', active: true, image_key: null, low_stock_threshold: null },
    { id: 'pv2', value_ids: ['pov_10x2'], label: '١٠×٢ مم', price_iqd: 1500, compare_at_iqd: null, stock: 10, sku: '', active: true, image_key: null, low_stock_threshold: null },
  ],
  part_spec: {
    printed_use: 'Yes', part_kind: 'magnet', part_shape: 'round', diameter_mm: '6', height_mm: '3', install_type: 'Press fit', install_minutes: '2',
    fits_family: 'lamp, keychain', variant_specs: 'pov_10x2: diameter_mm=10, height_mm=2', source: 'levonis:lv_mag',
  },
};
const NEW_PRODUCT = { ...DETAIL, id: 'pp2', name: 'Desk lamp', name_ar: 'مصباح مكتب', is_part: false, part_spec: null, state: 'published', variant_mode: 'simple', option_groups: [], variants: [], price_range: null, media: [], images: [] };

const LIST = [
  { ...DETAIL, images: [PICS.magnet] },
  { ...base, id: 'pp3', slug: 'led', name: 'LED strip 5V', name_ar: 'شريط LED ٥ فولت', images: [PICS.led], price_iqd: 3500, stock: 12, track_stock: true, state: 'hidden', sold_out: false, low_stock: false, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 0, is_part: true },
  { ...base, id: 'pp4', slug: 'lamp', name: 'Moon lamp', name_ar: 'مصباح القمر', images: [PICS.ring], price_iqd: 25000, stock: 6, track_stock: true, state: 'published', lifecycle: 'active', status: 'active', sold_out: false, low_stock: false, variant_mode: 'simple', variant_count: 0, price_range: null, sold_count: 14, is_part: false },
];

const words = (ar: string, en: string, ckb: string) => ({ ar, en, ckb });
const PRINT_PARTS = [
  {
    id: 'lv_key', slug: 'key-ring', name: 'Split key ring 25 mm', name_ar: 'حلقة مفاتيح ٢٥ مم', name_ckb: 'ئەڵقەی کلیل ٢٥ ملم', price_iqd: 250, in_stock: true, image: PICS.ring, kind: 'keyring',
    words: words('حلقة مفاتيح دائرية ٢٥ مم', 'Round key ring 25 mm', 'ئەڵقەی خڕی کلیل ٢٥ ملم'), options: [],
  },
  {
    id: 'lv_led', slug: 'led-strip', name: 'LED strip 5V', name_ar: 'شريط LED ٥ فولت', name_ckb: 'شریتی LED ٥ ڤۆڵت', price_iqd: 3000, in_stock: false, image: PICS.led, kind: 'led',
    words: words('ضوء LED شريطي ١٠٠٠ مم ٥ فولت', 'Strip LED 1000 mm 5 V', 'گڵۆپی شریتی LED ١٠٠٠ ملم ٥ ڤۆڵت'), options: [],
  },
  {
    id: 'lv_mag', slug: 'n52-magnet', name: 'N52 Magnet', name_ar: 'مغناطيس N52', name_ckb: 'موگناتیسی N52', price_iqd: 1000, in_stock: true, image: PICS.magnet, kind: 'magnet',
    words: words('مغناطيس دائري ٦ × ٣ مم', 'Round magnet 6 × 3 mm', 'موگناتیسی خڕ ٦ × ٣ ملم'),
    options: [
      { key: 'opt-6x3', name: '6×3 mm', name_ar: '٦×٣ مم', name_ckb: '٦×٣ ملم', price_iqd: 1000, in_stock: true, words: words('مغناطيس دائري ٦ × ٣ مم', 'Round magnet 6 × 3 mm', 'موگناتیسی خڕ ٦ × ٣ ملم') },
      { key: 'opt-10x2', name: '10×2 mm', name_ar: '١٠×٢ مم', name_ckb: '١٠×٢ ملم', price_iqd: 1500, in_stock: true, words: words('مغناطيس دائري ١٠ × ٢ مم', 'Round magnet 10 × 2 mm', 'موگناتیسی خڕ ١٠ × ٢ ملم') },
    ],
  },
  {
    id: 'lv_nfc', slug: 'nfc-tag', name: 'NFC tag NTAG215', name_ar: 'شريحة NFC ‏NTAG215', name_ckb: 'چیپی NFC ‏NTAG215', price_iqd: 1750, in_stock: true, image: PICS.nfc, kind: 'nfc',
    words: words('شريحة NFC دائرية ٢٥ مم', 'Round NFC tag 25 mm', 'چیپی خڕی NFC ٢٥ ملم'), options: [],
  },
  {
    id: 'lv_scr', slug: 'screw-m3', name: 'Screw M3 × 10', name_ar: 'برغي M3 × 10', name_ckb: 'بورغی M3 × 10', price_iqd: 100, in_stock: true, image: PICS.screw, kind: 'screw',
    words: words('برغي ٣ × ١٠ مم', 'Screw 3 × 10 mm', 'بورغی ٣ × ١٠ ملم'), options: [],
  },
];

const STORE = {
  id: 's1', merchant_id: 'm1', slug: 'ali3d', url: '/community/store/ali3d', name: L('علي للطباعة', 'Ali 3D prints', 'چاپی عەلی'), tagline: '', description: '', logoUrl: null, bannerUrl: null,
  accent: 'olive', categories: [], governorate: 'baghdad', service_areas: [], contact_phone: null, business_hours: [], policies: {}, social_links: {},
  accepts_custom_requests: true, sells_direct_products: true, status: 'active', open: true,
  merchant: { verified: true, pro_badge: false, rating: 4.8, rating_count: 23 },
} as unknown as MerchantStore;

(window as unknown as { __calls: string[] }).__calls = [];

function answer(path: string, method: string, query: URLSearchParams): { status: number; body: unknown } {
  (window as unknown as { __calls: string[] }).__calls.push(`${method} ${path}${query.toString() ? `?${query}` : ''}`);
  if (path === '/api/auth/me') return { status: 200, body: { success: true, user: { id: 'u', name: 'Ali', email: 'a@x.co', role: 'merchant' } } };
  if (path === '/api/storefront/resolve') return { status: 200, body: { success: true, kind: 'main', store: null } };
  if (path === '/api/merchant/products/stats') return { status: 200, body: { success: true, totals: { total: 3, published: 1, draft: 0, hidden: 2, archived: 0, out_of_stock: 0, low_stock: 0, views: 40, sold: 14 }, categories: [] } };
  if (path === '/api/merchant/products' && method === 'GET') {
    const kind = query.get('kind');
    const rows = kind === 'parts' ? LIST.filter((p) => p.is_part) : kind === 'products' ? LIST.filter((p) => !p.is_part) : LIST;
    return { status: 200, body: { success: true, products: rows, total: rows.length, next_cursor: null } };
  }
  if (path === '/api/merchant/products/pp1') return { status: 200, body: { success: true, product: DETAIL } };
  if (path === '/api/merchant/products/pp2') return { status: 200, body: { success: true, product: NEW_PRODUCT } };
  if (/^\/api\/merchant\/products\/pp\d$/.test(path)) return { status: 200, body: { success: true, product: DETAIL } };
  if (path === '/api/merchant/collections') return { status: 200, body: { success: true, collections: [] } };
  if (path === '/api/merchant/printers') return { status: 200, body: { success: true, printers: [], materials: [] } };
  if (path === '/api/products/print-parts') {
    const kind = query.get('kind');
    const q = (query.get('q') ?? '').toLowerCase();
    const rows = PRINT_PARTS.filter((p) => (!kind || p.kind === kind) && (!q || `${p.name} ${p.name_ar}`.toLowerCase().includes(q)));
    return { status: 200, body: { success: true, parts: rows, next_cursor: null } };
  }
  if (path === '/api/merchant/parts/from-levonis' && method === 'POST') return { status: 201, body: { success: true, product: { ...DETAIL, id: 'pp9' }, images: { copied: 1, skipped: 0 } } };
  if (path === '/api/merchant/parts/pp1/refresh' && method === 'POST') {
    return { status: 200, body: { success: true, product: DETAIL, levonis: { id: 'lv_mag', option_key: null, price_iqd: 1250, in_stock: true } } };
  }
  return { status: 200, body: { success: true } };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  if (!u.pathname.startsWith('/api/')) return realFetch(input, init);
  const r = answer(u.pathname, (init?.method ?? 'GET').toUpperCase(), u.searchParams);
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

/** Opens after mount, as the real doors do (see catalog-fixture.tsx). */
function EditorView({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  return (
    <Dashboard>
      <ProductEditorSheet open={open} productId={productId} canSell collections={[]} onClose={() => {}} onSaved={() => {}} />
    </Dashboard>
  );
}

function FromLevonisView() {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  return (
    <Dashboard>
      <FromLevonisSheet open={open} onClose={() => setOpen(false)} onOpen={() => {}} onImported={() => {}} />
    </Dashboard>
  );
}

function App() {
  if (view === 'editor') return <EditorView productId="pp1" />;
  if (view === 'new') return <EditorView productId="pp2" />;
  if (view === 'from-levonis') return <FromLevonisView />;
  return <Dashboard><CatalogManager canSell store={STORE} /></Dashboard>;
}

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <AuthProvider>
      <StoreProvider>
        <MemoryRouter initialEntries={['/merchant']}>
          <App />
        </MemoryRouter>
      </StoreProvider>
    </AuthProvider>
  </LanguageProvider>
);
