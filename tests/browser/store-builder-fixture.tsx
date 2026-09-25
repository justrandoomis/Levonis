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
 */
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import '../../src/index.css';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : params.get('lang') === 'ckb' ? 'ckb' : 'ar';
const API = params.get('api') ?? 'http://127.0.0.1:8792';
const onStore = params.get('host') === 'store';
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
  if (p === '/api/auth/me') return ok({ user: { id: 'owner', email: 'owner@x.co', username: 'ali', name: 'Ali', role: 'merchant', isAdmin: false, is_investor: false, subscription_plan: 'plus', membership_tier: 'plus', locale: lang, email_verified: true, phone_verified: true } });
  if (p === '/api/storefront/resolve' && !onStore) return ok({ kind: 'main', store: null });
  if (p === '/api/community/access') return ok({ closed: false, admin: false, may_enter: true });
  if (p === '/api/merchant/attention') return ok({ generated_at: new Date().toISOString(), attention: { store: { problems: [] } } });
  if (p === '/api/merchant/notifications/unread-count') return ok({ unread: 0, unread_by_kind: {} });
  return ok({});
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
  if (REAL.test(u.pathname)) return realFetch(`${API}${u.pathname}${u.search}`, { ...init, credentials: 'omit' });
  const r = answer(u.pathname);
  await new Promise((res) => setTimeout(res, 30));
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
};

createRoot(document.getElementById('root')!).render(<App />);
