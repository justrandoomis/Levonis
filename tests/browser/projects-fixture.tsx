/**
 * THE PROJECTS' PAGES IN A BROWSER — a project, a creator, the composer and
 * the list — with the API answered locally, so the screens can be seen and
 * photographed without a worker: `?page=project|creator|compose|list`,
 * `&lang=ar|en|ckb`, `&theme=dark|light`, `&viewer=guest|author|customer`.
 * scripts/e2e-projects.mjs drives it (Playwright).
 */
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../../src/AuthContext';
import { LanguageProvider } from '../../src/LanguageContext';
import { WalletProvider } from '../../src/WalletContext';
import { CurrencyProvider } from '../../src/CurrencyContext';
import { Toaster } from '../../src/components/ui/Toast';
import ProjectPage from '../../src/pages/community/Project';
import CreatorPage from '../../src/pages/community/Creator';
import ProjectComposer from '../../src/pages/community/ProjectComposer';
import ProjectsPage from '../../src/pages/community/Projects';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const page = params.get('page') ?? 'project';
const viewer = params.get('viewer') ?? 'guest';
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

const SARA = { id: 'sara', username: 'sara', name: 'سارة كريم', avatarUrl: picture('#7a8c5a', 'vase', 200, 200) };
const store = { id: 's_ali', slug: 'ali3d', name: 'Ali 3D', logoUrl: picture('#b08d3c', 'stand', 200, 200), url: '/community/store/ali3d' };

function card(i: number, over: Record<string, unknown> = {}) {
  const shapes = ['dragon', 'vase', 'stand'] as const;
  const tones = ['#6c7a4a', '#b08d3c', '#4a6c7a', '#7a4a5a'];
  return {
    id: `prj_${i}`,
    kind: 'project',
    title: ['تنين مفصلي بلونين', 'مزهرية حلزونية', 'حامل هاتف قابل للطي', 'علبة تنظيم أدوات'][i % 4],
    excerpt: 'طُبع بدون دعامات، طبقة 0.2، ملء 15%.',
    cover: { url: picture(tones[i % 4], shapes[i % 3]), kind: 'image', width: 800, height: 1000 },
    media_count: 3,
    author: SARA,
    store: i % 2 ? store : null,
    product: null,
    printer: { name: 'Bambu Lab A1', product: { id: 'p_a1', slug: 'bambu-a1', name: 'Bambu Lab A1', name_ar: 'بامبو لاب A1', url: '/product/bambu-a1' } },
    material: { name: 'PLA', product: { id: 'p_pla', slug: 'pla-black', name: 'PLA Black 1kg', name_ar: 'PLA أسود 1 كغ', url: '/product/pla-black' } },
    color: 'أسود',
    print_time_minutes: 380 + i * 40,
    dimensions: { x_mm: 220, y_mm: 60, z_mm: 40 },
    tags: ['dragon', 'articulated', 'pla'],
    counts: { likes: 12 + i, comments: 3, saves: 5, views: 400 },
    state: 'published',
    visibility: 'public',
    published_at: ago(60 * (i + 3)),
    created_at: ago(60 * (i + 4)),
    url: `/community/projects/prj_${i}`,
    ...over,
  };
}

const project = {
  ...card(0, {
    product: { id: 'cp_dragon', slug: 'dragon', name: 'Articulated dragon', name_ar: 'تنين مفصلي', price_iqd: 25000, url: '/community/store/ali3d/p/dragon' },
    store,
  }),
  body: 'طبعته على قطعتين بلونين بدون دعامات. الحيلة: توجيه الذيل بزاوية 45° وتفعيل «Arachne» في السلايسر.\n\nالمفاصل تحتاج خلوصًا 0.3 مم كي تتحرك بحرية بعد الطباعة مباشرة.',
  media: [
    { id: 'm1', kind: 'image', url: picture('#6c7a4a', 'dragon', 1200, 900), width: 1200, height: 900, duration_s: null },
    { id: 'm2', kind: 'image', url: picture('#b08d3c', 'dragon', 1200, 900), width: 1200, height: 900, duration_s: null },
    { id: 'm3', kind: 'image', url: picture('#4a6c7a', 'vase', 1200, 900), width: 1200, height: 900, duration_s: null },
  ],
  print_settings: { layer_height_mm: 0.2, infill_percent: 15, nozzle_mm: 0.4, supports: false },
  hidden: null,
  viewer: {
    mine: viewer === 'author',
    consent: viewer === 'customer' ? 'pending' : null,
    can: { edit: viewer === 'author', publish: viewer === 'author', archive: false, delete: viewer === 'author' },
  },
  ...(viewer === 'author' ? { state: 'draft', consent_status: 'not_needed' } : {}),
};

const creator = {
  id: 'sara',
  username: 'sara',
  name: 'سارة كريم',
  avatarUrl: SARA.avatarUrl,
  bio: 'أطبع في البيت منذ 2021 — ألعاب مفصلية، أدوات مطبخ، وقطع غيار لا تُباع.',
  website: 'sara.prints',
  socials: { instagram: 'sara.prints', x: '@sara3d' },
  country: 'IQ',
  member_since: '2021-04-02T00:00:00Z',
  printers: ['Bambu Lab A1', 'Ender 3 V3 SE'],
  materials: ['PLA', 'PETG', 'TPU'],
  badges: { pro: true, premium: false, verified_merchant: false },
  stats: { projects: 8, completed_jobs: 0 },
  store: null,
  viewer: { mine: viewer === 'author' },
};

const me = viewer === 'guest' ? null : { id: viewer === 'author' ? 'sara' : 'eve', username: viewer === 'author' ? 'sara' : 'eve', name: viewer === 'author' ? 'سارة كريم' : 'إيف', role: 'customer', email: 'x@x.co', locale: lang === 'ckb' ? 'ku' : lang, avatar_key: null, bio: '', website: '', profile: {}, country: 'IQ', phone: null, has_phone: false, notify_whatsapp: true, subscription_plan: 'free', membership_tier: 'free', subscription_expiry: 0, is_investor: false, isAdmin: false, creator_public: false };

const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  const p = u.pathname;
  const ok = (body: unknown) => Response.json({ success: true, ...(body as object) });
  if (p === '/api/auth/me' || p === '/api/me') return me ? ok({ user: me }) : new Response(JSON.stringify({ success: false }), { status: 401 });
  if (p === '/api/community/access') return ok({ open: true, allowed: true });
  if (p === '/api/community/posts/trending') return ok({ posts: [card(1), card(2), card(3), card(0)] });
  if (p === '/api/community/posts') return ok({ posts: Array.from({ length: 8 }, (_, i) => card(i)), next_cursor: null, total: 8 });
  if (/^\/api\/community\/posts\/[^/]+$/.test(p)) return ok({ post: project });
  if (/^\/api\/community\/posts\/[^/]+\/(publish|archive|restore|consent)$/.test(p)) return ok({ post: { ...project, state: 'published' }, consent_status: 'granted' });
  if (p.startsWith('/api/community/creators/')) return ok({ creator });
  if (p === '/api/community/my-posts') return ok({ posts: [card(0, { state: 'draft', consent_status: 'not_needed', hidden: false }), card(1, { consent_status: 'pending', hidden: false })], next_cursor: null });
  if (p === '/api/merchant/me') return ok({ eligible: false, tier: 'free', tier_active: false, expires_at: null, gated_benefits: [], can: {}, store: null, selling: { canSell: false, reason: '' }, suggested_slug: null });
  if (p === '/api/products') return ok({ products: [{ id: 'p_a1', slug: 'bambu-a1', name: 'Bambu Lab A1', name_ar: 'بامبو لاب A1', images: [], price_iqd: 450000 }] });
  if (p.startsWith('/api/wallet') || p.startsWith('/api/currency') || p.startsWith('/api/settings')) return ok({});
  if (init?.method && init.method !== 'GET') return ok({});
  return realFetch(input, init);
}) as typeof window.fetch;

const initial =
  page === 'creator' ? '/u/sara' : page === 'compose' ? '/community/projects/new' : page === 'list' ? '/community/projects' : '/community/projects/prj_0';

// The app's own provider order (src/App.tsx): Auth → Language → Wallet → Currency.
createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <LanguageProvider>
      <WalletProvider>
        <CurrencyProvider>
          <MemoryRouter initialEntries={[initial]}>
            <Routes>
              <Route path="/community/projects" element={<ProjectsPage />} />
              <Route path="/community/projects/new" element={<ProjectComposer />} />
              <Route path="/community/projects/:id" element={<ProjectPage />} />
              <Route path="/community/projects/:id/edit" element={<ProjectComposer />} />
              <Route path="/u/:username" element={<CreatorPage />} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </CurrencyProvider>
      </WalletProvider>
    </LanguageProvider>
  </AuthProvider>
);
