/**
 * CLIENT 5d IN A BROWSER — the order timelines (both sides), «ملف الورشة» and
 * the storefront's workshop facts, on canned answers, so they can be seen,
 * pressed and photographed without a worker (docs/COMMUNITY_ECOSYSTEM.md §9.5):
 *
 *   /tests/browser/order-timeline.html?scene=merchant|customer|workshop|storefront
 *     &state=funded|in_progress|merchant_marked_delivered|completed   (merchant, customer)
 *     &open=1        (merchant: start at the order's own address, as a notification's link does)
 *     &hero=profile|cover|split|minimal                                (storefront)
 *     &lang=ar|en|ckb &theme=dark|light
 *
 * `fetch` is answered with the shapes worker/routes/marketplace.ts,
 * communityOrderTimeline.ts, merchantPrinters.ts and the upload sessions
 * return; the order moves when the screen moves it (start, delivered, an
 * update, «جاهز», cancel, dispute), so a press is seen through. What the page
 * sent is kept on `window.__sent` for scripts/e2e-order-timeline.mjs.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import { Toaster } from '../../src/components/ui/Toast';
import { WorkspaceContext, type WorkspaceValue } from '../../src/components/merchant/shell/context';
import { CustomOrdersTab } from '../../src/components/merchant/dashboard/SalesTabs';
import { WorkshopProfileCard } from '../../src/components/merchant/dashboard/StoreSettingsTab';
import Requests from '../../src/pages/Requests';
import StoreRenderer from '../../src/components/storefront/StoreRenderer';
import { StorefrontRuntimeProvider } from '../../src/components/storefront/runtime';
import { previewRuntime } from '../../src/components/storefront/preview';
import type { StorefrontStore } from '../../src/components/storefront/types';
import '../../src/components/storefront/styles';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const scene = params.get('scene') ?? 'merchant';
const role: 'merchant' | 'customer' = scene === 'customer' ? 'customer' : 'merchant';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const en = lang === 'en';

// ----------------------------------------------------------- the order

const ORDER_ID = 'cord_1';
const order = {
  id: ORDER_ID,
  request_id: 'creq_1',
  merchant_id: 'cm_1',
  customer_id: 'u_nour',
  store_id: 'st_1',
  state: params.get('state') ?? 'in_progress',
  price_iqd: 55_000,
  completion_days: 5,
  delivery_method: 'courier',
  request_title: en ? 'Monitor arm for a 32" screen' : 'حامل شاشة 32 بوصة بذراع متحرك',
  customer_name: 'نور محمد',
  merchant_name: 'Ali 3D',
  store_slug: 'ali3d',
  created_at: ago(60 * 30),
  started_at: null as string | null,
  ready_at: null as string | null,
  delivered_at: null as string | null,
  confirmed_at: null as string | null,
  completed_at: null as string | null,
  cancelled_at: null as string | null,
  auto_complete_at: null as string | null,
  chat_id: 'chat_1',
  offer_snapshot: { price_iqd: 50_000, delivery_fee_iqd: 5_000, total_iqd: 55_000, quantity: 2, color: en ? 'Matte black' : 'أسود مطفي', terms: en ? 'One free reprint if a joint cracks in 30 days.' : 'إعادة طباعة مجانية إن انكسر مفصل خلال 30 يومًا.' },
  request_snapshot: { title: en ? 'Monitor arm for a 32" screen' : 'حامل شاشة 32 بوصة بذراع متحرك' },
};
type Event = { kind: string; at: string; actor: 'customer' | 'merchant' | 'admin' | 'system'; id?: string; body?: string; file?: { url: string; inline: boolean } | null; amount_iqd?: number };
const events: Event[] = [
  { kind: 'created', at: ago(60 * 30), actor: 'customer' },
  { kind: 'funded', at: ago(60 * 30 - 1), actor: 'customer' },
];
if (order.state !== 'funded') {
  order.started_at = ago(60 * 20);
  events.push({ kind: 'started', at: order.started_at, actor: 'merchant', id: 'u_start' });
  events.push({ kind: 'progress', at: ago(60 * 8), actor: 'merchant', id: 'u_p1', body: en ? 'The base and the first arm are printed; the joints go on the printer tonight.' : 'طُبعت القاعدة والذراع الأولى، والمفاصل تدخل الطابعة الليلة.' });
  events.push({ kind: 'modification_request', at: ago(60 * 6), actor: 'customer', id: 'u_m1', body: en ? 'Could the clamp open to 45 mm? My desk is thick.' : 'هل يمكن أن يفتح المشبك حتى 45 مم؟ مكتبي سميك.' });
  events.push({ kind: 'photo', at: ago(60 * 2), actor: 'merchant', id: 'u_ph1', body: en ? 'The clamp, reprinted wider.' : 'المشبك بعد إعادة طباعته أعرض.', file: { url: `/api/marketplace/orders/${ORDER_ID}/updates/u_ph1/file`, inline: true } });
}
if (order.state === 'merchant_marked_delivered' || order.state === 'completed') {
  order.ready_at = ago(60);
  order.delivered_at = ago(30);
  order.auto_complete_at = new Date(Date.now() + 3 * 86_400_000).toISOString();
  events.push({ kind: 'ready', at: order.ready_at, actor: 'merchant', id: 'u_r' });
  events.push({ kind: 'delivered', at: order.delivered_at, actor: 'merchant', id: 'u_d' });
}
if (order.state === 'completed') {
  order.confirmed_at = ago(10);
  order.completed_at = ago(10);
  events.push({ kind: 'confirmed', at: ago(10), actor: 'customer' }, { kind: 'released', at: ago(10), actor: 'system', amount_iqd: 52_250 }, { kind: 'completed', at: ago(10), actor: 'customer' });
}

const LIVE = new Set(['funded', 'in_progress', 'merchant_marked_delivered']);
const BEFORE_DELIVERY = new Set(['funded', 'in_progress']);
const can = () => ({
  mark_delivered: role === 'merchant' && order.state === 'in_progress',
  start_work: role === 'merchant' && order.state === 'funded',
  confirm: role === 'customer' && order.state === 'merchant_marked_delivered',
  dispute: ['funded', 'in_progress', 'merchant_marked_delivered'].includes(order.state),
  cancel: order.state === 'funded',
});
const timeline = () => ({
  success: true,
  role,
  order: { ...order, offer_snapshot: undefined, request_snapshot: undefined },
  timeline: [...events].sort((a, b) => a.at.localeCompare(b.at)),
  can: {
    update: role === 'merchant' && LIVE.has(order.state),
    ready: role === 'merchant' && order.state === 'in_progress' && !order.ready_at,
    modification_request: role === 'customer' && BEFORE_DELIVERY.has(order.state),
  },
});
const detail = () => ({
  success: true,
  // The admin's confirmation window (the server's default) — what «سلّمت العمل» names.
  auto_complete_days: 7,
  order,
  role,
  contact:
    role === 'merchant'
      ? { name: 'نور محمد', phone: '07701234567', governorate: 'baghdad', area: 'الكرادة', address: 'شارع 62، قرب جامعة بغداد', landmark: '', address_notes: '', delivery_method: 'courier' }
      : { name: 'Ali 3D', phone: '07809876543', store_name: 'Ali 3D', store_slug: 'ali3d', delivery_method: 'courier' },
  thread: { request_id: 'creq_1', merchant_id: 'cm_1' },
  escrow: { state: order.state === 'completed' ? 'released' : 'held', gross_iqd: 55_000, platform_fee_iqd: 2_750, merchant_receivable_iqd: 52_250, released_at: null, refunded_at: null },
  can: can(),
});
const listRow = () => ({
  id: ORDER_ID,
  state: order.state,
  price_iqd: order.price_iqd,
  merchant_receivable_iqd: 52_250,
  created_at: order.created_at,
  delivered_at: order.delivered_at,
  completed_at: order.completed_at,
  auto_complete_at: order.auto_complete_at,
  request_title: order.request_title,
  merchant_name: order.merchant_name,
  store_slug: order.store_slug,
  role,
});

// ----------------------------------------------------------- the workshop profile

const prefs = {
  processes: ['fdm'],
  materials: ['pla', 'petg'],
  colors: ['#000000'],
  capabilities: ['multicolor'],
  governorates: ['baghdad', 'erbil'],
  delivery: ['courier'],
  min_job_iqd: 10_000,
  max_job_iqd: null as number | null,
  min_size_mm: 0,
  max_size_mm: 250,
  workload: 'busy',
  paused: false,
  paused_until: null as string | null,
  turnaround_days: 4 as number | null,
  workshop_intro: en ? 'A workshop in Baghdad printing spare parts since 2021.' : 'ورشة في بغداد، نطبع قطع الغيار منذ 2021.',
  technologies: params.get('printers') === '0' ? [] : ['fdm', 'resin'],
  max_build_mm: params.get('printers') === '0' ? {} : { x: 256, y: 256, z: 300 },
};

// ----------------------------------------------------------- the storefront

const STORE = {
  id: 'st_1',
  slug: 'ali3d',
  url: 'https://ali3d.levonis-iq.com',
  name: 'Ali 3D',
  tagline: en ? 'Printing in Baghdad' : 'ورشة طباعة في بغداد',
  description: en ? 'FDM and resin, delivered across Iraq.' : 'طباعة FDM وريزن، توصيل لكل العراق.',
  logoUrl: null,
  bannerUrl: null,
  accent: 'gold',
  categories: [],
  governorate: 'baghdad',
  service_areas: [],
  contact_phone: null,
  business_hours: [],
  policies: {},
  social_links: {},
  profile_links: [],
  profile_facts: [],
  profile_facts_configured: false,
  delivery_settings: {},
  accepts_custom_requests: true,
  sells_direct_products: true,
  open: true,
  status: 'active',
  merchant: { id: 'cm_1', name: 'Ali 3D', verified: true, pro_badge: false, premium_badge: false, badge: 'trusted', rating: 4.8, rating_count: 23, completed_orders: 41 },
  created_at: '2024-03-01T00:00:00.000Z',
  product_count: 12,
  followers: 87,
  positive_pct: 96,
  workshop: params.get('facts') === '0' ? undefined : { technologies: ['fdm', 'resin'], materials: ['pla', 'petg'], max_build_mm: { x: 256, y: 256, z: 300 }, turnaround_days: 3, governorates: ['baghdad'], delivery: ['courier'], custom_enabled: true, intro: '' },
} as unknown as StorefrontStore;
const T = (ar: string, e: string) => ({ ar, en: e });
const LAYOUT = {
  schema_version: 1,
  blocks: [
    { id: 'hero', type: 'hero', variant: params.get('hero') ?? 'profile', settings: {} },
    { id: 'stats', type: 'stats', variant: 'cards', settings: { title: T('بالأرقام', 'In numbers'), metrics: ['rating', 'completed_orders', 'followers'] } },
    { id: 'text', type: 'text', settings: { body: T('نطبع لك ما تحتاجه — اطلب عرض سعر.', 'We print what you need — ask for a quote.') } },
  ],
};

// ----------------------------------------------------------- the doors

const sent: Array<{ method: string; path: string; body: unknown }> = [];
(window as unknown as { __sent: typeof sent }).__sent = sent;
const me = {
  id: role === 'merchant' ? 'u_ali' : 'u_nour',
  username: role === 'merchant' ? 'ali' : 'nour',
  name: role === 'merchant' ? 'Ali' : 'نور محمد',
  role: 'customer',
  email: 'x@x.co',
  locale: lang === 'ckb' ? 'ku' : lang,
  avatar_key: null,
  bio: '',
  website: '',
  profile: {},
  country: 'IQ',
  phone: null,
  has_phone: false,
  notify_whatsapp: true,
  subscription_plan: 'free',
  membership_tier: 'free',
  subscription_expiry: 0,
  is_investor: false,
  isAdmin: false,
  creator_public: false,
};
let uploadN = 0;
let updateN = 0;

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify({ success: true, ...(body as object) }), { status, headers: { 'content-type': 'application/json' } });
  const refused = (status: number, code: string, error = code) => new Response(JSON.stringify({ success: false, error, code }), { status, headers: { 'content-type': 'application/json' } });
  let body: unknown = null;
  if (init?.body && typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  if (method !== 'GET' && !p.includes('/parts/')) sent.push({ method, path: p + u.search, body });

  if (p === '/api/auth/me' || p === '/api/me') return ok({ user: me });
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/me') return ok(role === 'merchant' ? { eligible: true, tier: 'pro', tier_active: true, can: { store: true, offers: true }, store: { id: 'st_1', slug: 'ali3d', name: 'Ali 3D' } } : { eligible: false, tier: 'free', can: {}, store: null });

  // ---- the order (marketplace.ts, communityOrderTimeline.ts)
  if (p === '/api/marketplace/orders' && method === 'GET') return ok({ orders: [listRow()] });
  if (p === `/api/marketplace/orders/${ORDER_ID}` && method === 'GET') return ok(detail());
  if (p === `/api/marketplace/orders/${ORDER_ID}/timeline`) return ok(timeline());
  if (p === `/api/marketplace/orders/${ORDER_ID}/start` && method === 'POST') {
    if (order.state !== 'funded') return refused(409, 'CUSTOM_ORDER_CANNOT_START');
    order.state = 'in_progress';
    order.started_at = new Date().toISOString();
    events.push({ kind: 'started', at: order.started_at, actor: 'merchant', id: 'u_start' });
    return ok({});
  }
  if (p === `/api/marketplace/orders/${ORDER_ID}/delivered` && method === 'POST') {
    order.state = 'merchant_marked_delivered';
    order.delivered_at = new Date().toISOString();
    order.auto_complete_at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    events.push({ kind: 'delivered', at: order.delivered_at, actor: 'merchant', id: 'u_d' });
    return ok({ auto_complete_at: order.auto_complete_at });
  }
  if (p === `/api/marketplace/orders/${ORDER_ID}/cancel` && method === 'POST') {
    order.state = 'cancelled';
    order.cancelled_at = new Date().toISOString();
    events.push({ kind: 'cancelled', at: order.cancelled_at, actor: role }, { kind: 'refunded', at: order.cancelled_at, actor: 'system', amount_iqd: 55_000 });
    return ok({ refunded: true });
  }
  if (p === `/api/marketplace/orders/${ORDER_ID}/dispute` && method === 'POST') {
    order.state = 'disputed';
    events.push({ kind: 'dispute', at: new Date().toISOString(), actor: role });
    return ok({ complaint_id: 'cmp_1' });
  }
  if (p === `/api/marketplace/orders/${ORDER_ID}/confirm` && method === 'POST') {
    order.state = 'completed';
    order.completed_at = new Date().toISOString();
    events.push({ kind: 'confirmed', at: order.completed_at, actor: 'customer' }, { kind: 'completed', at: order.completed_at, actor: 'customer' });
    return ok({});
  }
  if (p === `/api/marketplace/orders/${ORDER_ID}/updates` && method === 'POST') {
    const b = (body ?? {}) as { kind?: string; body?: string; file_key?: string };
    if (b.kind === 'modification_request' && !BEFORE_DELIVERY.has(order.state)) return refused(409, 'ORDER_UPDATE_TOO_LATE');
    const id = `u_new${++updateN}`;
    const at = new Date().toISOString();
    if (b.kind === 'ready') order.ready_at = at;
    // The key goes in; what comes back — and what the timeline carries — is the route.
    events.push({ kind: b.kind ?? 'note', at, actor: role, id, body: b.body ?? '', file: b.file_key ? { url: `/api/marketplace/orders/${ORDER_ID}/updates/${id}/file`, inline: true } : null });
    return ok({ update: events[events.length - 1] }, 201);
  }
  if (p === `/api/chats/open` && method === 'POST') return ok({ chatId: 'chat_1' });

  // ---- the upload session (purpose order_update) — the key comes back to the uploader only
  if (p === '/api/uploads/sessions' && method === 'POST') return ok({ session_id: `ups_${++uploadN}`, chunk_bytes: 5 * 1024 * 1024 }, 201);
  if (/^\/api\/uploads\/sessions\/[^/]+\/parts\/\d+$/.test(p)) return ok({ received: true });
  if (/^\/api\/uploads\/sessions\/[^/]+\/complete$/.test(p)) {
    return ok({ key: `community-orders/${ORDER_ID}/updates/obj_${uploadN}.png`, url: `/api/uploads/private/${uploadN}`, visibility: 'private', mime: 'image/png', bytes: 1024, sha256: 'x' });
  }

  // ---- the workshop profile (merchantPrinters.ts)
  if (p === '/api/merchant/request-prefs' && method === 'GET') {
    return ok({ prefs, vocabulary: { processes: ['fdm', 'resin'], capabilities: [], delivery: ['courier', 'pickup'], workloads: ['light', 'normal', 'busy', 'full'], materials: [] } });
  }
  if (p === '/api/merchant/request-prefs' && method === 'PUT') {
    const b = (body ?? {}) as Record<string, unknown>;
    if (typeof b.turnaround_days === 'number' && (b.turnaround_days < 1 || b.turnaround_days > 60)) return refused(400, 'PREFS_TURNAROUND_INVALID');
    // The server replaces the row: whatever the body leaves out falls back — the fixture does the same.
    Object.assign(prefs, {
      processes: b.processes ?? [],
      materials: b.materials ?? [],
      governorates: b.governorates ?? [],
      workload: b.workload ?? 'normal',
      turnaround_days: b.turnaround_days ?? null,
      workshop_intro: typeof b.workshop_intro === 'string' ? b.workshop_intro : '',
    });
    return ok({});
  }

  // ---- whatever else the pages ask on the side
  if (p.startsWith('/api/community/reviews') || p.includes('pending-reviews') || p.startsWith('/api/reviews')) return ok({ items: [], reviews: [], pending: [] });
  if (p.startsWith('/api/wallet') || p.startsWith('/api/currency') || p.startsWith('/api/settings') || p.startsWith('/api/notifications')) return ok({});
  if (p.startsWith('/api/')) return ok({ items: [], requests: [], orders: [], offers: [], reviews: [], next_cursor: null });
  return realFetch(input, init);
}) as typeof window.fetch;

// ----------------------------------------------------------- the scenes

/** Where a link went: a page that names its address, so a navigation can be checked. */
function Elsewhere() {
  const { pathname, search, hash } = useLocation();
  return (
    <main data-elsewhere={pathname + search + hash} className="p-6 text-text-primary">
      <p className="font-mono text-sm">{pathname + search + hash}</p>
    </main>
  );
}

/** The workspace's addresses as the shell answers them: a stored `/merchant/…` link is this host's path, `go` navigates. */
function MerchantScene() {
  const navigate = useNavigate();
  const { id } = useParams();
  const workspace = {
    href: (link: string) => link,
    mainHref: (path: string) => path,
    go: (link: string, opts?: { replace?: boolean }) => navigate(link, opts),
  } as unknown as WorkspaceValue;
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main className="mx-auto w-full max-w-3xl px-4 py-6" data-scene="merchant">
        <CustomOrdersTab focusOrderId={id ?? null} />
      </main>
    </WorkspaceContext.Provider>
  );
}

function Scene() {
  if (scene === 'customer') return <Requests />;
  if (scene === 'workshop') {
    return (
      <main className="mx-auto w-full max-w-2xl px-4 py-6" data-scene="workshop">
        <WorkshopProfileCard />
      </main>
    );
  }
  if (scene === 'storefront') {
    return (
      <main data-scene="storefront">
        <StorefrontRuntimeProvider value={previewRuntime({ mode: 'live' })}>
          <StoreRenderer store={STORE} layout={LAYOUT} />
        </StorefrontRuntimeProvider>
      </main>
    );
  }
  return <MerchantScene />;
}

const start = scene === 'customer' ? '/requests?view=orders' : scene === 'storefront' ? '/store' : params.get('open') === '1' ? `/merchant/requests/orders/${ORDER_ID}` : '/merchant/requests/orders';

// The app's own provider order (src/App.tsx): Auth → Language → Wallet → Currency.
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[start]}>
            <div className="min-h-screen bg-canvas text-text-primary">
              <Routes>
                <Route path="/requests" element={<Scene />} />
                <Route path="/merchant/requests/orders" element={<Scene />} />
                <Route path="/merchant/requests/orders/:id" element={<Scene />} />
                <Route path="/store" element={<Scene />} />
                <Route path="*" element={<Elsewhere />} />
              </Routes>
            </div>
            <Toaster />
          </MemoryRouter>
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
