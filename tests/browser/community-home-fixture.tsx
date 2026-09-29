/**
 * THE COMMUNITY HOME IN A BROWSER — src/pages/Community.tsx with every door
 * it knocks on answered locally, so the issue can be seen and photographed
 * without a worker: `?tab=foryou|following|projects|requests|stores|creators`
 * (and the two old names), `&lang=ar|en|ckb`, `&theme=dark|light`,
 * `&viewer=guest|customer|merchant`, `&empty=1` for a community with nothing
 * in it yet (the typeset cover, the first-issue feed).
 * scripts/e2e-community-home.mjs drives it (Playwright).
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import { Toaster } from '../../src/components/ui/Toast';
import Community from '../../src/pages/Community';
import { CommunityGate } from '../../src/pages/community/access';
import { SocialProvider } from '../../src/components/community/social/SocialContext';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const tab = params.get('tab') ?? 'foryou';
const viewer = params.get('viewer') ?? 'guest';
const empty = params.get('empty') === '1';
localStorage.setItem('levo_lang', lang);
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
document.documentElement.setAttribute('data-theme', params.get('theme') === 'light' ? 'light' : 'dark');

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

/** A photograph stand-in: a soft backdrop and one printed object. */
function picture(tone: string, shape: 'dragon' | 'vase' | 'stand', w = 800, h = 1000): string {
  const body =
    shape === 'dragon'
      ? `<path d="M120 620 q80 -220 260 -160 t240 60 q60 40 -20 90 t-220 -20 q-120 -20 -160 80 z" fill="${tone}"/><circle cx="560" cy="470" r="18" fill="#111"/>`
      : shape === 'vase'
        ? `<path d="M300 200 q-90 160 0 300 q40 80 -20 200 h240 q-60 -120 -20 -200 q90 -140 0 -300 z" fill="${tone}"/>`
        : `<rect x="240" y="300" width="320" height="60" rx="14" fill="${tone}"/><rect x="270" y="360" width="60" height="320" rx="10" fill="${tone}" opacity=".9"/><rect x="470" y="360" width="60" height="320" rx="10" fill="${tone}" opacity=".9"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><radialGradient id="g" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#f1ede4"/><stop offset="1" stop-color="#c9c2b3"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><ellipse cx="${w / 2}" cy="${h * 0.78}" rx="${w * 0.3}" ry="18" fill="#000" opacity=".12"/>${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const TONES = ['#6c7a4a', '#b08d3c', '#4a6c7a', '#7a4a5a'];
const SHAPES = ['dragon', 'vase', 'stand'] as const;
const TITLES = ['تنين مفصلي بلونين', 'مزهرية حلزونية', 'حامل هاتف قابل للطي', 'علبة تنظيم أدوات'];
const KINDS = ['project', 'post', 'tutorial', 'timelapse', 'before_after'] as const;

const MAKERS = [
  { id: 'sara', username: 'sara', name: 'سارة كريم', avatarUrl: picture('#7a8c5a', 'vase', 200, 200), bio: 'أطبع في البيت منذ 2021 — ألعاب مفصلية وقطع غيار لا تُباع.' },
  { id: 'omar', username: 'omar', name: 'Omar 3D', avatarUrl: picture('#b08d3c', 'stand', 200, 200), bio: 'Functional prints, PETG mostly.' },
  { id: 'lina', username: 'lina', name: 'لينا', avatarUrl: null, bio: 'راتنج ومنمنمات.' },
  { id: 'hama', username: 'hama', name: 'هەمە ڕەشید', avatarUrl: picture('#4a6c7a', 'dragon', 200, 200), bio: 'چاپی سێ ڕەهەندی لە سلێمانی.' },
  { id: 'nour', username: 'nour', name: 'نور', avatarUrl: null, bio: '' },
  { id: 'zain', username: null as string | null, name: 'زين', avatarUrl: null, bio: 'بدون صفحة عامة.' },
];

const STORES = Array.from({ length: 6 }, (_, i) => ({
  id: `m_${i}`,
  user_id: `u_${i}`,
  name: ['Ali 3D', 'ورشة النور', 'Print Lab', 'مطبعة بغداد', 'Kurd Print', 'سليمانية 3D'][i],
  bio: 'طباعة FDM وراتنج، تسليم لكل العراق.',
  avatarUrl: null,
  verified: i % 2 === 0,
  pro_badge: i === 0,
  premium_badge: i === 1,
  created_at: ago(60 * 24 * (i + 3)),
  store_slug: ['ali3d', 'alnoor', 'printlab', 'baghdad', 'kurdprint', 'suly3d'][i],
  store_url: `/community/store/${['ali3d', 'alnoor', 'printlab', 'baghdad', 'kurdprint', 'suly3d'][i]}`,
  store_name: ['Ali 3D', 'ورشة النور', 'Print Lab', 'مطبعة بغداد', 'Kurd Print', 'سليمانية 3D'][i],
  tagline: '',
  logoUrl: i % 3 === 0 ? picture(TONES[i % 4], 'stand', 200, 200) : null,
  governorate: ['baghdad', 'basra', 'erbil', 'baghdad', 'sulaymaniyah', 'sulaymaniyah'][i],
  accepts_custom_requests: i % 2 === 1,
  badge: i === 0 ? 'trusted' : 'new',
  rating: i === 0 ? 4.8 : null,
  rating_count: i === 0 ? 23 : 0,
  completed_orders: i * 7,
  followers: 40 - i * 5,
  product_count: 3 + i,
  following: false,
}));

const storeRef = (i: number) => {
  const m = STORES[i % STORES.length];
  return { id: m.store_slug, slug: m.store_slug, name: m.store_name, logoUrl: m.logoUrl, url: m.store_url };
};

const graph = { liked: new Set<string>(), saved: new Set<string>(), following: new Set<string>(), followingStores: new Set<string>(), blocked: new Set<string>(), muted: new Set<string>(), reports: new Set<string>() };

function card(i: number) {
  const kind = KINDS[i % KINDS.length];
  const portrait = i % 3 !== 1;
  const author = MAKERS[i % MAKERS.length];
  const withStore = i % 2 === 1;
  return {
    id: `prj_${i}`,
    kind,
    title: `${TITLES[i % 4]}${i >= 4 ? ` ${i}` : ''}`,
    excerpt: kind === 'tutorial' ? 'كيف تضبط الخلوص بين المفاصل كي تتحرك من أول طبعة — ثلاث تجارب وقياساتها.' : 'طُبع بدون دعامات، طبقة 0.2، ملء 15%.',
    cover: { url: picture(TONES[i % 4], SHAPES[i % 3], portrait ? 800 : 1200, portrait ? 1000 : 900), kind: i % 7 === 3 ? 'video' : 'image', width: portrait ? 800 : 1200, height: portrait ? 1000 : 900 },
    media_count: 3,
    author: { id: author.id, username: author.username, name: author.name, avatarUrl: author.avatarUrl },
    store: withStore ? storeRef(i) : null,
    product: i % 4 === 1 ? { id: `cp_${i}`, slug: 'dragon', name: 'Articulated dragon', name_ar: 'تنين مفصلي', price_iqd: 25000, url: `${storeRef(i).url}/p/dragon` } : null,
    printer: { name: 'Bambu Lab A1', product: { id: 'p_a1', slug: 'bambu-a1', name: 'Bambu Lab A1', name_ar: 'بامبو لاب A1', url: '/product/bambu-a1' } },
    material: { name: 'PLA', product: i % 3 === 0 ? { id: 'p_pla', slug: 'pla-black', name: 'PLA Black 1kg', name_ar: 'PLA أسود 1 كغ', url: '/product/pla-black' } : null },
    color: 'أسود',
    print_time_minutes: 380 + i * 40,
    dimensions: { x_mm: 220, y_mm: 60, z_mm: 40 },
    tags: ['dragon', 'articulated', 'pla'].slice(0, (i % 3) + 1),
    counts: { likes: i % 4 === 0 ? 0 : 12 + i, comments: i % 2, saves: 5, views: 400 },
    state: 'published',
    visibility: 'public',
    published_at: ago(60 * (i + 3)),
    created_at: ago(60 * (i + 4)),
    url: `/community/projects/prj_${i}`,
    viewer: { liked: graph.liked.has(`prj_${i}`), saved: graph.saved.has(`prj_${i}`) },
  };
}

const ALL_POSTS = empty ? [] : Array.from({ length: 30 }, (_, i) => card(i));
const TRENDING = empty ? [] : [card(1), card(2), card(3), card(0), card(5), card(6), card(7), card(8)];

const creatorCard = (m: (typeof MAKERS)[number], i: number) => ({
  id: m.id,
  username: m.username ?? m.id,
  name: m.name,
  avatarUrl: m.avatarUrl,
  bio: m.bio,
  badges: { pro: i === 0, premium: i === 1, verified_merchant: i === 3 },
  stats: { projects: 8 - i, followers: 41 - i * 6 },
  store: i === 3 ? { id: 'm_4', slug: 'kurdprint', name: 'Kurd Print', url: '/community/store/kurdprint' } : null,
  viewer: { following: graph.following.has(m.id) },
});

const REQUESTS = Array.from({ length: 9 }, (_, i) => ({
  id: `req_${i}`,
  title: ['حامل شاشة 32 بوصة', 'قطعة غيار لخلاط', 'مجسم معماري 1:200', 'Cable organiser ×20'][i % 4],
  description: 'أحتاجه خلال أسبوع، اللون أسود، مع ملف STL مرفق.',
  quantity: i % 3 === 0 ? 20 : 1,
  material: ['PLA', 'PETG', 'Resin'][i % 3],
  budget_iqd: i % 2 ? 45000 : null,
  deadline: ago(-60 * 24 * (i + 2)),
  governorate: ['baghdad', 'erbil', 'basra'][i % 3],
  state: 'open',
  offer_count: i % 4,
  file_count: i % 2,
  created_at: ago(30 * (i + 1)),
}));

const PRODUCTS = Array.from({ length: 24 }, (_, i) => ({
  id: `cp_${i}`,
  slug: `piece-${i}`,
  merchant_id: STORES[i % STORES.length].id,
  name: ['Articulated dragon', 'Spiral vase', 'Phone stand', 'Tool box'][i % 4],
  name_ar: TITLES[i % 4],
  description: '',
  images: [picture(TONES[i % 4], SHAPES[i % 3], 600, 600)],
  price_iqd: 15000 + i * 2500,
  original_price_iqd: i % 5 === 0 ? 30000 + i * 2500 : null,
  created_at: ago(60 * i),
  in_stock: i % 7 !== 6,
  url: `${storeRef(i).url}/p/piece-${i}`,
  store: storeRef(i),
}));

const WORKS = Array.from({ length: 12 }, (_, i) => ({
  id: `w_${i}`,
  title: TITLES[i % 4],
  details: '',
  imageUrl: picture(TONES[(i + 2) % 4], SHAPES[(i + 1) % 3], 900, 900),
  store: storeRef(i),
}));

const me =
  viewer === 'guest'
    ? null
    : { id: 'eve', username: 'eve', name: 'إيف', role: 'customer', email: 'x@x.co', locale: lang === 'ckb' ? 'ku' : lang, avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ', phone: null, has_phone: false, notify_whatsapp: true, subscription_plan: 'free', membership_tier: 'free', subscription_expiry: 0, is_investor: false, isAdmin: false, creator_public: false };

const merchantMe =
  viewer === 'merchant'
    ? { eligible: true, tier: 'pro', tier_active: true, expires_at: null, gated_benefits: [], can: { store: true, products: true, orders: true, offers: true, analytics: true, subdomain: false }, store: { id: 'st_eve', slug: 'eveprints', name: 'Eve Prints', logoUrl: null }, selling: { canSell: true, reason: '' }, suggested_slug: null }
    : { eligible: false, tier: 'free', tier_active: false, expires_at: null, gated_benefits: [], can: {}, store: null, selling: { canSell: false, reason: '' }, suggested_slug: null };

const q = (u: URL, k: string) => (u.searchParams.get(k) ?? '').trim().toLowerCase();
const limitOf = (u: URL, def: number) => Math.max(1, Math.min(48, Number(u.searchParams.get('limit')) || def));
const offsetOf = (u: URL) => Math.max(0, Number(u.searchParams.get('cursor')) || 0);
function pageOf<T>(rows: T[], u: URL, def: number, key: string) {
  const limit = limitOf(u, def);
  const offset = offsetOf(u);
  const slice = rows.slice(offset, offset + limit);
  return { [key]: slice, next_cursor: offset + limit < rows.length ? String(offset + limit) : null, total: offset === 0 ? rows.length : null };
}
const has = (text: string, term: string) => !term || text.toLowerCase().includes(term);

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const method = (init?.method ?? 'GET').toUpperCase();
  const ok = (body: unknown) => Response.json({ success: true, ...(body as object) });
  const refused = (status: number) => new Response(JSON.stringify({ success: false }), { status, headers: { 'content-type': 'application/json' } });
  if (p === '/api/auth/me' || p === '/api/me') return me ? ok({ user: me }) : refused(401);
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/me') return me ? ok(merchantMe) : refused(401);
  // ---- the social graph ----
  if (p === '/api/community/me/social') return me ? ok({ following_users: [...graph.following], following_stores: [...graph.followingStores], blocked: [...graph.blocked], muted: [...graph.muted] }) : refused(401);
  let m = /^\/api\/community\/posts\/([^/]+)\/(like|save)$/.exec(p);
  if (m) {
    if (!me) return refused(401);
    const set = m[2] === 'like' ? graph.liked : graph.saved;
    if (method === 'PUT') set.add(m[1]);
    if (method === 'DELETE') set.delete(m[1]);
    const base = 12 + Number(m[1].replace('prj_', ''));
    return m[2] === 'like' ? ok({ liked: set.has(m[1]), likes: base + (set.has(m[1]) ? 1 : 0) }) : ok({ saved: set.has(m[1]), saves: 5 + (set.has(m[1]) ? 1 : 0) });
  }
  m = /^\/api\/community\/posts\/([^/]+)\/comments$/.exec(p);
  if (m) return ok({ comments: [], next_cursor: null, total: 0 });
  m = /^\/api\/community\/users\/([^/]+)\/(follow|block|mute)$/.exec(p);
  if (m) {
    if (!me) return refused(401);
    const set = m[2] === 'follow' ? graph.following : m[2] === 'block' ? graph.blocked : graph.muted;
    if (method === 'PUT') set.add(m[1]);
    if (method === 'DELETE') set.delete(m[1]);
    if (m[2] === 'follow') return ok({ following: set.has(m[1]), followers: 41 + (set.has(m[1]) ? 1 : 0) });
    return ok(m[2] === 'block' ? { blocked: set.has(m[1]) } : { muted: set.has(m[1]) });
  }
  m = /^\/api\/community\/store\/([^/]+)\/follow$/.exec(p);
  if (m) {
    if (!me) return refused(401);
    if (method === 'POST') graph.followingStores.add(m[1]);
    if (method === 'DELETE') graph.followingStores.delete(m[1]);
    return ok({ following: graph.followingStores.has(m[1]) });
  }
  if (p === '/api/community/reports' && method === 'POST') return new Response(JSON.stringify({ success: true, report_id: 'rep_1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  // ---- the lists ----
  if (p === '/api/community/feed') {
    const scope = u.searchParams.get('scope');
    if (scope === 'following' && !me) return refused(401);
    const rows = scope === 'following' ? (viewer === 'customer' && !params.get('follows') ? [] : ALL_POSTS.filter((c) => c.author.id === 'sara' || c.author.id === 'omar')) : ALL_POSTS;
    const page = pageOf(rows, u, 12, 'posts');
    return ok({ scope, posts: page.posts, next_cursor: page.next_cursor });
  }
  if (p === '/api/community/creators') {
    const term = q(u, 'q');
    const rows = empty ? [] : MAKERS.filter((x) => x.username).map(creatorCard).filter((c) => has(`${c.name} ${c.username} ${c.bio}`, term));
    return ok(pageOf(rows, u, 18, 'creators'));
  }
  if (p === '/api/community/posts/trending') return ok({ posts: TRENDING });
  if (p === '/api/community/posts') {
    const term = q(u, 'q');
    const kind = u.searchParams.get('kind') ?? '';
    const tag = u.searchParams.get('tag') ?? '';
    const author = u.searchParams.get('author') ?? '';
    const rows = ALL_POSTS.filter((c) => (!kind || c.kind === kind) && (!tag || c.tags.includes(tag)) && (!author || c.author.id === author) && has(`${c.title} ${c.excerpt}`, term));
    return ok(pageOf(rows, u, 18, 'posts'));
  }
  if (p === '/api/community/merchants') {
    const term = q(u, 'q');
    const rows = empty ? [] : STORES.map((s) => ({ ...s, following: graph.followingStores.has(s.id) })).filter((s) => has(`${s.store_name} ${s.bio}`, term));
    return ok(pageOf(rows, u, 24, 'merchants'));
  }
  if (p === '/api/community/requests') {
    const term = q(u, 'q');
    const rows = empty ? [] : REQUESTS.filter((r) => has(`${r.title} ${r.description}`, term));
    return ok(pageOf(rows, u, 20, 'requests'));
  }
  if (p === '/api/community/products') {
    const term = q(u, 'q');
    const rows = empty ? [] : PRODUCTS.filter((r) => has(`${r.name} ${r.name_ar}`, term));
    return ok(pageOf(rows, u, 24, 'products'));
  }
  if (p === '/api/community/works') return ok({ works: empty ? [] : WORKS });
  if (p.startsWith('/api/wallet') || p.startsWith('/api/currency') || p.startsWith('/api/settings') || p.startsWith('/api/notifications')) return ok({});
  if (init?.method && init.method !== 'GET') return ok({});
  return realFetch(input, init);
}) as typeof window.fetch;

/** Where a link went: a page that names its address, so a navigation can be checked. */
function Elsewhere() {
  const { pathname, search } = useLocation();
  return (
    <main data-elsewhere={pathname + search} className="p-6 text-text-primary">
      <p className="font-mono text-sm">{pathname + search}</p>
    </main>
  );
}

const extra = params.get('extra') ? `&${params.get('extra')}` : '';

// The app's own provider order (src/App.tsx): Auth → Language → Wallet → Currency → Social.
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[`/community?tab=${encodeURIComponent(tab)}${extra}`]}>
            <SocialProvider>
              <Routes>
                <Route
                  path="/community"
                  element={
                    <CommunityGate>
                      <Community />
                    </CommunityGate>
                  }
                />
                <Route path="*" element={<Elsewhere />} />
              </Routes>
            </SocialProvider>
          </MemoryRouter>
          <Toaster />
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
