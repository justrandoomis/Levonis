/**
 * THE COMMUNITY DIRECTORY IN A BROWSER (community UI plan C5): the stores page
 * (IMG_8469) and the makers page (IMG_8476), src/pages/community/Stores.tsx and
 * Makers.tsx, with every door they knock on answered here, so they can be
 * driven and photographed without a worker:
 *
 *   /tests/browser/community-directory.html?page=stores|makers
 *     &lang=ar|en|ckb &theme=dark|light &viewer=guest|customer|merchant
 *     &extra=<query of the page, e.g. gov=erbil&tech=fdm>
 *     &state=empty|error (the directory has nothing yet, or the read fails)
 *
 * The answers honour the filters the way the server does (plan B3): the
 * governorate, the process and the design service for stores; the order,
 * «لديهم متجر» and «مزوّد معتمد» for makers; and `q`. Every request the page
 * makes is kept in `window.__directoryCalls`, so a test can see what the
 * address asked the server. A merchant viewer owns «Eve Prints», which is in
 * the directory, so its own card has no follow button. The pictures are drawn
 * here (a backdrop and a printed shape), never a photograph.
 *
 * A browser fixture, never an app route. Only utilities that already exist in
 * the app are used: Tailwind scans this folder too, and a fixture must not
 * grow the store stylesheet. scripts/e2e-community-directory.mjs drives it.
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { clearPrimedRequests } from '../../src/lib/bootFetch';
import { Toaster } from '../../src/components/ui/Toast';
import { SocialProvider } from '../../src/components/community/social/SocialContext';
import CommunityStores from '../../src/pages/community/Stores';
import CommunityMakers from '../../src/pages/community/Makers';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const page = params.get('page') === 'makers' ? 'makers' : 'stores';
const viewer = params.get('viewer') ?? 'guest';
const state = params.get('state') ?? '';
localStorage.setItem('levo_lang', lang);
try {
  localStorage.setItem('levonis.theme.v1', theme);
} catch {
  /* the attribute below still sets it */
}
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', theme);

/** A photograph stand-in: a warm backdrop, a table, and one printed shape. */
function picture(tone: string, shape: number): string {
  const shapes = [
    `<path d="M300 180 q-90 160 0 300 q40 80 -20 200 h240 q-60 -120 -20 -200 q90 -140 0 -300 z" fill="${tone}"/>`,
    `<rect x="230" y="320" width="340" height="240" rx="18" fill="${tone}"/><path d="M200 330 l200 -150 l200 150 z" fill="#b5523b"/>`,
    `<circle cx="400" cy="460" r="170" fill="${tone}"/><circle cx="400" cy="460" r="60" fill="#e9e3d6"/>`,
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 700"><defs><radialGradient id="g" cx="50%" cy="30%" r="80%"><stop offset="0" stop-color="#e9d9bd"/><stop offset="1" stop-color="#7c6247"/></radialGradient></defs><rect width="800" height="700" fill="url(#g)"/><rect y="560" width="800" height="140" fill="#8a5a36"/>${shapes[shape % 3]}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function face(tone: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="#55606b"/><circle cx="60" cy="48" r="24" fill="${tone}"/><path d="M18 120 q42 -60 84 0 z" fill="#2f3a44"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function mark(tone: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><rect width="120" height="120" fill="${tone}"/><path d="M60 26 l30 17 v34 l-30 17 l-30 -17 v-34 z" fill="none" stroke="#17120b" stroke-width="7" stroke-linejoin="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const TONES = ['#e8e1d2', '#7d8f5c', '#c46a44', '#3d4248'];
const works = (prefix: string, n: number, at = 0) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}_w${i}`, title: `work ${i}`, imageUrl: picture(TONES[(i + at) % 4], i + at) }));

interface Shop {
  id: string;
  user_id: string;
  name: string;
  store_name: string;
  tagline: string;
  governorate: string;
  techs: string[];
  design: boolean;
  accepts_custom_requests: boolean;
  rating: number | null;
  rating_count: number;
  approved_provider: boolean;
  verified: boolean;
  logo: string | null;
  works: number;
  /** Never sent: the directory must not carry a phone (plan R3). */
  contact_phone: string;
}

const SHOPS: Shop[] = [
  { id: 'cm_baghdad', user_id: 'u_haider', name: 'ورشة بغداد', store_name: 'ورشة بغداد', tagline: 'طباعة قطع ومنتجات عملية', governorate: 'baghdad', techs: ['fdm'], design: true, accepts_custom_requests: true, rating: 4.8, rating_count: 23, approved_provider: true, verified: true, logo: mark('#dcbc8c'), works: 3, contact_phone: '07700000000' },
  { id: 'cm_tabaa', user_id: 'u_noor', name: 'ستوديو طبعة', store_name: 'ستوديو طبعة', tagline: 'مجسمات معمارية وديكور', governorate: 'erbil', techs: ['resin'], design: false, accepts_custom_requests: true, rating: null, rating_count: 0, approved_provider: true, verified: false, logo: mark('#c98f86'), works: 3, contact_phone: '07700000001' },
  { id: 'cm_ibdaa', user_id: 'u_mustafa', name: 'ورشة الإبداع', store_name: 'ورشة الإبداع', tagline: 'نماذج وأجزاء مخصصة', governorate: 'basra', techs: ['fdm', 'resin'], design: false, accepts_custom_requests: false, rating: 4.5, rating_count: 12, approved_provider: false, verified: false, logo: null, works: 2, contact_phone: '07700000002' },
  { id: 'cm_eve', user_id: 'eve', name: 'Eve Prints', store_name: 'Eve Prints', tagline: 'Small runs in PETG', governorate: 'baghdad', techs: ['fdm'], design: true, accepts_custom_requests: true, rating: 5, rating_count: 3, approved_provider: true, verified: false, logo: null, works: 0, contact_phone: '07700000003' },
];

interface Person {
  id: string;
  username: string;
  name: string;
  bio: string;
  projects: number;
  followers: number;
  store: boolean;
  approved: boolean;
  recent: number;
  works: number;
}

const PEOPLE: Person[] = [
  { id: 'u_sara', username: 'sara_hassan', name: 'سارة حسن', bio: 'تصميم ومنتجات عملية\nأطبع منذ 2019', projects: 9, followers: 40, store: false, approved: false, recent: 3, works: 3 },
  { id: 'u_ali', username: 'ali_haider', name: 'علي حيدر', bio: 'مجسمات معمارية', projects: 5, followers: 120, store: true, approved: true, recent: 1, works: 3 },
  { id: 'u_ahmed', username: 'ahmed_ali', name: 'أحمد علي', bio: 'إضاءة وديكور مطبوع', projects: 3, followers: 12, store: false, approved: false, recent: 2, works: 2 },
  { id: 'u_zainab', username: 'zainab_karim', name: 'Zainab Karim', bio: '', projects: 1, followers: 2, store: true, approved: false, recent: 4, works: 0 },
];

const graph = { followingUsers: new Set(['u_ali']), followingStores: new Set(['cm_tabaa']) };

const me =
  viewer === 'guest'
    ? null
    : { id: 'eve', username: 'eve', name: 'إيف', role: 'customer', email: 'x@x.co', locale: lang === 'ckb' ? 'ku' : lang, avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ', phone: null, has_phone: false, notify_whatsapp: true, subscription_plan: 'free', membership_tier: 'free', subscription_expiry: 0, is_investor: false, isAdmin: false, creator_public: false };

const merchantMe =
  viewer === 'merchant'
    ? { eligible: true, approved: true, tier: 'pro', tier_active: true, expires_at: null, gated_benefits: [], can: { store: true, products: true, orders: true, offers: true, analytics: true, subdomain: false }, store: { id: 'st_eve', slug: 'eveprints', name: 'Eve Prints', logoUrl: null }, selling: { canSell: true, reason: '' }, suggested_slug: null }
    : { eligible: false, tier: 'free', tier_active: false, expires_at: null, gated_benefits: [], can: {}, store: null, selling: { canSell: false, reason: '' }, suggested_slug: null };

const calls: string[] = [];
(window as unknown as { __directoryCalls: string[] }).__directoryCalls = calls;

const has = (u: URL, k: string) => (u.searchParams.get(k) ?? '').trim();
const matches = (term: string, ...fields: string[]) => !term || fields.some((f) => f.toLowerCase().includes(term.toLowerCase()));

function storeRow(s: Shop) {
  return {
    id: s.id,
    user_id: s.user_id,
    name: s.name,
    bio: s.tagline,
    avatarUrl: s.logo,
    verified: s.verified,
    approved_provider: s.approved_provider,
    pro_badge: false,
    premium_badge: false,
    created_at: new Date().toISOString(),
    store_slug: s.id.replace('cm_', ''),
    store_url: `/community/store/${s.id}`,
    store_name: s.store_name,
    tagline: s.tagline,
    logoUrl: s.logo,
    governorate: s.governorate,
    accepts_custom_requests: s.accepts_custom_requests,
    badge: s.rating_count ? 'rising' : 'new',
    rating: s.rating,
    rating_count: s.rating_count,
    completed_orders: 10,
    followers: graph.followingStores.has(s.id) ? 8 : 7,
    product_count: 4,
    following: me ? graph.followingStores.has(s.id) : false,
    works: works(s.id, s.works, SHOPS.indexOf(s)),
  };
}

function personRow(p: Person) {
  return {
    id: p.id,
    username: p.username,
    name: p.name,
    avatarUrl: face(TONES[PEOPLE.indexOf(p) % 4]),
    bio: p.bio,
    badges: { pro: false, premium: false, verified_merchant: false, approved_provider: p.approved },
    stats: { projects: p.projects, followers: p.followers },
    store: p.store ? { id: `st_${p.id}`, slug: p.username, name: p.name, url: `/community/store/st_${p.id}` } : null,
    viewer: { following: me ? graph.followingUsers.has(p.id) : false },
    works: works(p.id, p.works, PEOPLE.indexOf(p) + 1).map((w) => ({ ...w, width: 800, height: 600, url: `/community/projects/${w.id}` })),
  };
}

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const ok = (body: unknown) => Response.json({ success: true, ...(body as object) });
  const refused = (status: number) => new Response(JSON.stringify({ success: false }), { status, headers: { 'content-type': 'application/json' } });
  if (p.startsWith('/api/')) calls.push(`${method} ${p}${u.search}`);
  if (p === '/api/auth/me' || p === '/api/me') return me ? ok({ user: me }) : refused(401);
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/me') return me ? ok(merchantMe) : refused(401);
  if (p === '/api/community/me/social') return me ? ok({ following_users: [...graph.followingUsers], following_stores: [...graph.followingStores], blocked: [], muted: [] }) : refused(401);
  let m = /^\/api\/community\/users\/([^/]+)\/follow$/.exec(p);
  if (m) {
    if (!me) return refused(401);
    if (method === 'PUT') graph.followingUsers.add(m[1]);
    if (method === 'DELETE') graph.followingUsers.delete(m[1]);
    return ok({ following: graph.followingUsers.has(m[1]), followers: 41 });
  }
  m = /^\/api\/community\/store\/([^/]+)\/follow$/.exec(p);
  if (m) {
    if (!me) return refused(401);
    if (method === 'POST') graph.followingStores.add(m[1]);
    if (method === 'DELETE') graph.followingStores.delete(m[1]);
    return ok({ following: graph.followingStores.has(m[1]) });
  }
  if (p === '/api/community/merchants') {
    if (state === 'error') return refused(500);
    const term = has(u, 'q');
    const gov = has(u, 'governorate');
    const tech = has(u, 'tech');
    const service = has(u, 'service');
    const rows = state === 'empty' ? [] : SHOPS.filter((s) => matches(term, s.name, s.tagline) && (!gov || s.governorate === gov) && (!tech || s.techs.includes(tech)) && (!service || s.design));
    return ok({ merchants: rows.map(storeRow), next_cursor: null, total: rows.length });
  }
  if (p === '/api/community/creators') {
    if (state === 'error') return refused(500);
    const term = has(u, 'q');
    const sort = has(u, 'sort') || (u.searchParams.get('featured') === '1' ? 'featured' : 'recent');
    let rows = state === 'empty' ? [] : PEOPLE.filter((c) => matches(term, c.name, c.username, c.bio) && (has(u, 'has_store') !== '1' || c.store) && (has(u, 'approved') !== '1' || c.approved));
    rows = [...rows].sort((a, b) => (sort === 'featured' ? b.projects - a.projects : sort === 'followers' ? b.followers - a.followers : a.recent - b.recent));
    return ok({ creators: rows.map(personRow), next_cursor: null, total: rows.length });
  }
  if (p.startsWith('/api/')) return refused(404);
  return realFetch(input, init);
}) as typeof window.fetch;
// The session read the app starts at import time (src/lib/bootFetch.ts) left before this answer
// was in place: drop it, so the provider asks again, here.
clearPrimedRequests();

/** Where a link went: a page that names its address, so a navigation can be checked. */
function Elsewhere() {
  const { pathname, search } = useLocation();
  return (
    <main data-elsewhere={pathname + search} className="p-6 text-text-primary">
      <p className="font-mono text-sm">{pathname + search}</p>
    </main>
  );
}

/** The address of the page, mirrored on the root, so a test can read the filters it holds. */
function Address() {
  const { pathname, search } = useLocation();
  document.documentElement.setAttribute('data-address', pathname + search);
  return null;
}

const extra = params.get('extra') ?? '';
const start = `/community/${page}${extra ? `?${extra}` : ''}`;

// The app provider order (src/App.tsx): Auth, Language, then the router and Social.
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <MemoryRouter initialEntries={[start]}>
        <SocialProvider>
          <Address />
          <Routes>
            <Route path="/community/stores" element={<CommunityStores />} />
            <Route path="/community/makers" element={<CommunityMakers />} />
            <Route path="*" element={<Elsewhere />} />
          </Routes>
        </SocialProvider>
      </MemoryRouter>
      <Toaster />
    </LanguageProvider>
  </AuthProvider>
);
