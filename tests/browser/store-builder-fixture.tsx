/**
 * THE STORE BUILDER, AS SHIPPED (W4-A) — the real application (src/App) at
 * /merchant/store/design, with the store-layout, merchant, catalogue and
 * storefront routes answered by the REAL Worker routes on SQLite through a
 * local stand-in (`?api=http://127.0.0.1:8792`, started by the e2e script),
 * and the shell's other reads answered here from fixed data. Served only by
 * a local `vite` dev server.
 *
 *   /tests/browser/store-builder.html?lang=ar|en&api=http://127.0.0.1:8792
 *        [&host=store&path=/]   the PUBLIC storefront as the store's own host
 *                               serves it (W6 sweep), from the real routes
 *        [&speed=numbers]       «سرعة متجري» (P4): the two speed reads answered
 *                               from the fixed figures below instead of the
 *                               real routes (a fresh store has no reading yet)
 *        [&speedfail=7]         with `&speed=numbers`: the 7-day report read fails
 *                               (503), so a failed refresh keeps the figures it had
 *        [&pulse=speed]         Today's attention read carries the `speed`
 *                               source, so the Pulse draws its speed line
 *        [&theme=light]         the light «cream» theme
 */
import { createRoot } from 'react-dom/client';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const API = params.get('api') ?? 'http://127.0.0.1:8792';
const onStore = params.get('host') === 'store';
const speedScene = params.get('speed');
const pulseScene = params.get('pulse');
const speedFail = params.get('speedfail');
// The «cream» theme on `&theme=light` — the app's main.tsx (`initTheme`) is not part of this fixture.
if (params.get('theme') === 'light') document.documentElement.setAttribute('data-theme', 'light');
try {
  localStorage.setItem('levo_lang', lang);
} catch {
  /* Arabic, the default */
}
history.replaceState(null, '', params.get('path') ?? '/merchant/store/design');

/** Real routes (worker/routes/*) behind the stand-in. */
const REAL = /^\/api\/(merchant\/(me|store\/layout(\/.*)?|products(\/.*)?|sections|collections|coupons)|storefront\/(?!resolve$).+)$/;

function answer(p: string): { status: number; body: Record<string, unknown> } {
  const ok = (b: Record<string, unknown> = {}) => ({ status: 200, body: { success: true, ...b } });
  // P5 (media everywhere): the upload door, for the still the picker captures from a video. The
  // stand-in backend has no upload route, so it answers with a picture the ledger already holds
  // (tests/fixtures/storeLayout.ts MEDIA.picture2) — the draft then saves with a real poster.
  if (p === '/api/uploads') {
    return ok({ key: 'merchants/owner/public/pic00002.webp', url: '/files/merchants/owner/public/pic00002.webp', mime: 'image/webp', bytes: 1000, width: 1280, height: 720, visibility: 'public' });
  }
  // P4: the attention source the server answers only after three poor phone days running.
  if (p === '/api/merchant/attention' && pulseScene === 'speed') {
    return ok({ generated_at: new Date().toISOString(), attention: { store: { problems: [] }, speed: { grade: 'poor', samples: 214, poor_days: 3, link: '/merchant/store/design' } } });
  }
  if (p === '/api/auth/me') return ok({ user: { id: 'owner', email: 'owner@x.co', username: 'ali', name: 'Ali', role: 'merchant', isAdmin: false, is_investor: false, subscription_plan: 'plus', membership_tier: 'plus', locale: lang, email_verified: true, phone_verified: true } });
  if (p === '/api/storefront/resolve' && !onStore) return ok({ kind: 'main', store: null });
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/attention') return ok({ generated_at: new Date().toISOString(), attention: { store: { problems: [] } } });
  if (p === '/api/merchant/notifications/unread-count') return ok({ unread: 0, unread_by_kind: {} });
  return ok({});
}

/**
 * «سرعة متجري» WITH NUMBERS (P4): a month of phone readings that land on
 * «مقبول» (a computer's on «جيد»), and a heavy first screen whose findings
 * point at the product_focused starter's own sections (`hero`, `products`)
 * and at the page background — so every door on the tab has a place to open.
 * The draft's audit is the same page after the fixes: a light WebP hero.
 */
function speedAnswer(u: URL): Record<string, unknown> {
  const phone = u.searchParams.get('device') !== 'desktop';
  const days = u.searchParams.get('days') === '7' ? 7 : 28;
  const dayOf = (back: number) => new Date(Date.now() + 3 * 3600_000 - back * 86_400_000).toISOString().slice(0, 10);
  const rows = Array.from({ length: days }, (_, i) => {
    // Both windows of both devices hold ≥ 50 readings, as a verdict needs (7 days of a computer: 62).
    const n = phone ? 9 + ((i * 5) % 7) : 8 + (i % 3);
    const good = phone ? Math.round(n * (0.5 + 0.3 * Math.sin(i / 2.5) ** 2)) : n;
    const poor = phone ? Math.round(n * 0.15) : 0;
    const ok = Math.max(0, n - good - poor);
    const inpOk = phone && i % 4 === 0 ? 1 : 0;
    return { day: dayOf(days - 1 - i), samples: n, lcp: { good, ok, poor }, inp: { good: n - inpOk, ok: inpOk, poor: 0 }, cls: { good: n, ok: 0, poor: 0 }, ttfb: { good: n - (i % 2), ok: i % 2, poor: 0 } };
  });
  const totals = Object.fromEntries(
    (['lcp', 'inp', 'cls', 'ttfb'] as const).map((v) => [v, rows.reduce((a, r) => ({ good: a.good + r[v].good, ok: a.ok + r[v].ok, poor: a.poor + r[v].poor }), { good: 0, ok: 0, poor: 0 })])
  );
  const samples = rows.reduce((a, r) => a + r.samples, 0);
  const published = {
    first_view: [
      { block_id: 'background', label_key: 'background_poster', key: 'merchants/owner/store/bg.webp', bytes: 182_000, mime: 'image/webp' },
      { block_id: 'header', label_key: 'logo', key: 'merchants/owner/store/logo.webp', bytes: 38_000, mime: 'image/webp' },
      { block_id: 'hero', label_key: 'hero_image', key: 'merchants/owner/store/hero.gif', bytes: 6_500_000, mime: 'image/gif' },
      ...[1, 2, 3, 4].map((n) => ({ block_id: 'products', label_key: 'product_image', key: `merchants/owner/products/p${n}.jpg`, bytes: 520_000 + n * 4_000, mime: 'image/jpeg', product_id: `p${n}` })),
    ],
    fixed: { app_kb: 226, font_kb: 31 },
    findings: [
      { code: 'HERO_GIF', block_id: 'hero', params: { bytes: 6_500_000 } },
      { code: 'HERO_HEAVY', block_id: 'hero', params: { bytes: 6_500_000, max_bytes: 1_572_864 } },
      { code: 'POSTER_MISSING', block_id: 'background', params: {} },
      { code: 'PRODUCT_IMAGES_LARGE', block_id: 'products', params: { avg_bytes: 530_000, count: 4, max_bytes: 409_600 } },
    ],
  };
  const draft = {
    ...published,
    first_view: published.first_view.map((it) => (it.block_id === 'hero' ? { ...it, key: 'merchants/owner/store/hero.webp', bytes: 380_000, mime: 'image/webp' } : it.label_key === 'product_image' ? { ...it, bytes: 180_000 } : it)),
    findings: [
      { code: 'POSTER_MISSING', block_id: 'background', params: {} },
      { code: 'OK_IMAGES', params: { bytes: 1_320_000, count: 7 } },
    ],
  };
  if (u.pathname.endsWith('/speed')) return { success: true, source: u.searchParams.get('source') === 'draft' ? 'draft' : 'published', audit: u.searchParams.get('source') === 'draft' ? draft : published };
  return {
    success: true,
    generated_at: new Date().toISOString(),
    rum: {
      device: phone ? 'phone' : 'desktop',
      window_days: days,
      from: dayOf(days - 1),
      min_samples: 50,
      samples,
      days: rows,
      totals,
      p75_bucket: phone ? { lcp: 'ok', inp: 'good', cls: 'good', ttfb: 'good' } : { lcp: 'good', inp: 'good', cls: 'good', ttfb: 'good' },
      mean_ms: phone ? { lcp: 2930, ttfb: 610 } : { lcp: 1480, ttfb: 390 },
      verdict: phone ? 'ok' : 'good',
    },
    weight: published,
    weight_source: 'published',
    psi_url: 'https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fraf3d.levonis-iq.com',
  };
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, location.origin);
  if (!u.pathname.startsWith('/api/') || u.origin !== location.origin) return realFetch(input, init);
  if (onStore && u.pathname === '/api/storefront/resolve') {
    // The store's own host: resolve answers with the real store row.
    const r = await (await realFetch(`${API}/api/storefront/raf3d`, { credentials: 'omit' })).json();
    return new Response(JSON.stringify({ success: true, kind: 'store', store: r.store, root_domain: 'levonis-iq.com' }), { headers: { 'content-type': 'application/json' } });
  }
  if (speedScene === 'numbers' && u.pathname.startsWith('/api/merchant/store/layout/speed')) {
    await new Promise((res) => setTimeout(res, 120));
    if (speedFail && u.pathname.endsWith('/report') && u.searchParams.get('days') === speedFail) {
      return new Response(JSON.stringify({ success: false, error: 'busy', code: 'SERVICE_BUSY' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(speedAnswer(u)), { headers: { 'content-type': 'application/json' } });
  }
  if (REAL.test(u.pathname)) return realFetch(`${API}${u.pathname}${u.search}`, { ...init, credentials: 'omit' });
  const r = answer(u.pathname);
  await new Promise((res) => setTimeout(res, 30));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

// The application is imported only now, AFTER the stand-in is installed: since
// P2b, src/lib/bootFetch.ts sends `/api/storefront/resolve` (and `/api/home`
// on `/`) at module evaluation, before any component renders — a static
// `import App` would be hoisted above the patch and that first request would
// leave through the real fetch, to a dev server with no Worker behind it.
const { default: App } = await import('../../src/App');
createRoot(document.getElementById('root')!).render(<App />);
