/**
 * The API answers of tests/browser/points-ads-fixture.tsx, in a module of their own
 * because the app starts its first requests while its modules evaluate
 * (src/lib/bootFetch.ts): this one is imported first, so `window.fetch` is already
 * this table when they leave. It also sets the language and the theme the page reads.
 */
import served from './gifts-data.json';

const params = new URLSearchParams(location.search);
export const view = params.get('view') ?? 'points';
const state = params.get('state') ?? 'ready';
export const lang = ['en', 'ckb'].includes(params.get('lang') ?? '') ? params.get('lang')! : 'ar';
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.lang = lang;
document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
localStorage.setItem('levo_lang', lang);

const VIDEO = params.get('video') ?? '/files/rewards/ads/video/first.mp4';
const POSTER = params.get('poster');
const WAIT = Number(params.get('wait') ?? 45);

const tri = (ar: string, en: string, ckb: string) => ({ ar, en, ckb });
const TITLE = tri('عرض الجمعة السوداء المبكر', 'Early Black Friday deal', 'ئۆفەری هەینیی ڕەشی زوو');
const ENDS = '2026-11-14T20:59:00.000Z';
const adOf = (views_used: number) => ({ id: 'ad_first', title: TITLE, poster_url: POSTER, width: 720, height: 1280, views_used, views_max: 2, ends_at: ENDS });

const PROOF = 'The server can prove its own ticket was issued and that the seconds passed. It cannot prove a person watched.';
const mission = { base_points: 20, points: 20, verification: 'client_asserted', proof: PROOF };

const videoMission = () => {
  const base = { ...mission, required_seconds: 45, seconds_remaining: null, started: false };
  if (state === 'watched') return { ...base, claimed: true, available: true, videoUrl: VIDEO, ad: adOf(1), next_at: '2026-11-07T21:00:00.000Z', done: false };
  if (state === 'used') return { ...base, claimed: true, available: false, videoUrl: null, ad: adOf(2), next_at: null, done: true };
  if (state === 'none') return { ...base, claimed: false, available: false, videoUrl: null, ad: null, next_at: null, done: false };
  if (state === 'legacy') return { ...base, claimed: false, available: true, videoUrl: VIDEO, required_seconds: 15, ad: null, next_at: null, done: false };
  return { ...base, claimed: false, available: true, videoUrl: VIDEO, ad: adOf(0), next_at: null, done: false };
};

const rewardsPayload = () => ({
  success: true,
  today: '2026-11-06',
  server_time: new Date().toISOString(),
  streak: 2,
  checked_in_today: false,
  point_balance: 3240,
  pending_points: { points: 0, next_available_at: null },
  checkin: {
    next_day: 3,
    base_points: 3,
    points: 3,
    verification: 'server_timed',
    proof: 'The server decides the day.',
    ladder: [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, base_points: day, points: day, status: day < 3 ? 'checked' : day === 3 ? 'today' : 'upcoming' })),
  },
  missions: {
    push: { ...mission, base_points: 50, points: 50, claimed: state === 'used' || state === 'watched', available: true },
    video: videoMission(),
    browse: {
      ...mission,
      claimed: state === 'used',
      available: true,
      required_seconds: 180,
      progress_seconds: view === 'clock' || view === 'cart' ? 0 : state === 'watched' ? 45 : 0,
      seconds_remaining: null,
      started: view === 'clock' || view === 'cart' || state === 'watched',
    },
  },
  multiplier: { x100: 100, label: '1x', tier: 'free', active: false, expires_at: null, applies_to: ['checkin', 'tasks', 'purchases', 'reviews'] },
  earning: { iqd_per_point: 1000, checkin_top_rung: 7 },
  history: [],
  is_pro: false,
  membership_reward_multiplier_x100: 100,
});

interface AdRow {
  id: string;
  title: { ar: string; en: string; ckb: string };
  video_url: string;
  poster_url: string | null;
  width: number;
  height: number;
  duration_seconds: number;
  required_seconds: number;
  starts_at: string;
  ends_at: string;
  max_views: number;
  active: boolean;
  sort: number;
  phase: string;
  views: number;
  viewers: number;
  points_paid: number;
}

const ads: AdRow[] = [
  {
    id: 'ad_first',
    title: TITLE,
    video_url: VIDEO,
    poster_url: POSTER,
    width: 720,
    height: 1280,
    duration_seconds: 47,
    required_seconds: 45,
    starts_at: '2026-11-05T00:00:00.000Z',
    ends_at: ENDS,
    max_views: 2,
    active: true,
    sort: 0,
    phase: 'live',
    views: 128,
    viewers: 94,
    points_paid: 2610,
  },
  {
    id: 'ad_old',
    title: tri('إعلان الفلمنت', 'Filament ad', 'ڕیکلامی فیلامێنت'),
    video_url: VIDEO,
    poster_url: null,
    width: 720,
    height: 1280,
    duration_seconds: 30,
    required_seconds: 28,
    starts_at: '2026-10-01T00:00:00.000Z',
    ends_at: '2026-10-10T20:59:00.000Z',
    max_views: 2,
    active: false,
    sort: 1,
    phase: 'off',
    views: 41,
    viewers: 30,
    points_paid: 820,
  },
];

const CONFIG = {
  enabled: true,
  valid_days: 7,
  weekly: { enabled: true, months: 12 },
  free_shipping: { enabled: true, amount_iqd: 5000, min_order_iqd: 100000 },
  filament: { enabled: true, percent: 15, max_discount_iqd: 25000, product_ids: [], max_pieces: 1 },
  shop: { free_shipping: { enabled: true, points: 3000 }, filament_discount: { enabled: false, points: null } },
};

const requests: Array<{ path: string; method: string; body?: unknown }> = [];
const unstubbed: string[] = [];
Object.assign(window, { pointsRequests: requests, pointsUnstubbed: unstubbed });

const ok = (body: unknown, status = 200) => new Response(JSON.stringify({ success: true, ...(body as object) }), { status, headers: { 'Content-Type': 'application/json' } });
const refuse = (status: number, code: string, error: string) => new Response(JSON.stringify({ success: false, code, error }), { status, headers: { 'Content-Type': 'application/json' } });

let pinged = 0;
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, location.origin);
  const p = url.pathname;
  const method = (init?.method || 'GET').toUpperCase();
  if (!p.startsWith('/api/')) return realFetch(input as RequestInfo, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  requests.push({ path: `${p}${url.search}`, method, body });

  if (p === '/api/auth/me') return ok({ user: { id: 'u_sara', name: 'سارة', email: 'sara@example.com', role: view === 'admin' ? 'admin' : 'customer', username: 'sara', email_verified_at: '2026-01-01T00:00:00.000Z' } });
  if (p === '/api/settings/public') return ok({ settings: {} });
  if (p === '/api/wallet') return ok({ balances: { usd_cents: 0, points: 3240 }, transactions: [] });
  if (p.startsWith('/api/notifications') || p.startsWith('/api/currency') || p.startsWith('/api/compare')) return ok({ notifications: [], unread: 0 });

  if (p === '/api/rewards' && method === 'GET') return ok(rewardsPayload());
  if (p === '/api/rewards/video/start') {
    if (params.get('refuse')) return refuse(409, params.get('refuse')!, 'refused');
    return ok({ required_seconds: 45, seconds_remaining: WAIT, videoUrl: VIDEO, ad: adOf(state === 'watched' ? 1 : 0), started_at: '2026-11-06T09:00:00.000Z' });
  }
  if (p === '/api/rewards/video') return ok({ points: 20, base_points: 20, multiplier_x100: 100 });
  if (p === '/api/rewards/browse/start') return ok({ required_seconds: 180 });
  if (p === '/api/rewards/browse/ping') {
    pinged += 1;
    if (params.get('award')) return ok({ done: true, seconds: 180, awarded: true, points: 20, base_points: 20, multiplier_x100: 100 });
    return ok({ done: false, seconds: Math.min(180, pinged * 15) });
  }

  if (p === '/api/cart' && method === 'GET') return ok(served.cart);
  if (p === '/api/storefront/resolve') return ok({ store: null });

  // The upload doors, answering as they do: the real doors are tests/rewardAdsMedia.test.ts.
  if (p === '/api/uploads' && method === 'POST') {
    const file = (init?.body as FormData).get('file') as File;
    const isVideo = file.type.startsWith('video/');
    return ok({ key: 'rewards/ads/x', url: isVideo ? VIDEO : (POSTER ?? ''), mime: file.type, bytes: file.size, visibility: 'public' });
  }

  if (p === '/api/admin/rewards/config' && method === 'GET') return ok({ config: CONFIG, filaments: [], filament_section_id: 'cat', installed: true, summary: [] });
  if (p === '/api/admin/rewards/ads' && method === 'GET') return ok({ installed: true, ads, mission_enabled: params.get('mission') !== 'off' });
  if (p === '/api/admin/rewards/ads' && method === 'POST') {
    ads.unshift({ ...ads[0], id: `ad_${ads.length}`, title: tri(body.title_ar, body.title_en, body.title_ckb), phase: 'live', views: 0, viewers: 0, points_paid: 0 });
    return ok({ id: ads[0].id }, 201);
  }
  const toggle = /^\/api\/admin\/rewards\/ads\/([^/]+)\/toggle$/.exec(p);
  if (toggle) {
    const a = ads.find((x) => x.id === toggle[1])!;
    a.active = body.active;
    a.phase = body.active ? 'live' : 'off';
    return ok({ active: body.active, changed: true });
  }
  const edit = /^\/api\/admin\/rewards\/ads\/([^/]+)$/.exec(p);
  if (edit && method === 'PUT') return ok({});

  unstubbed.push(`${method} ${p}`);
  return refuse(404, 'NOT_STUBBED', `Fixture missing ${method} ${p}`);
}) as typeof window.fetch;
