/**
 * Studio /auth/* routes (STUDIO_PLAN decision 3) — handled INSIDE the Studio
 * worker fetch, before any vinext delegation, so everything stays
 * same-origin under the COOP/COEP isolation policy (connect-src 'self' is
 * never widened for sign-in).
 *
 * Flow:
 *   GET  /auth/login?return_to=/x   generate a state nonce, remember it (with
 *                                   the sanitized return path) in a short-lived
 *                                   host-scoped cookie, redirect to the MAIN
 *                                   worker's handoff entry.
 *   GET  /auth/callback?code&state  verify state against our own cookie, then
 *                                   redeem the single-use code SERVER-TO-SERVER
 *                                   at the main worker (shared secret), mint the
 *                                   Studio session, and redirect to the return
 *                                   path — the code never renders a page and is
 *                                   cleaned from the URL by the redirect.
 *   POST /auth/logout               destroy the Studio session (server-side row
 *                                   + cookie). GET is accepted for plain links
 *                                   but refused for cross-site navigations.
 *   GET  /auth/me                   { user | null } for client-side UI state.
 *   GET  /signin-with-chatgpt       legacy paths from the old hosting — 302 to
 *        /signout-with-chatgpt      the new endpoints (they used to 404).
 *
 * Failures NEVER sign the user in silently and never leak which check failed
 * to the browser beyond a generic marker (?auth_error=denied).
 */
import {
  type StudioAuthEnv,
  type StudioSessionUser,
  STUDIO_HANDOFF_COOKIE,
  clearHandoffCookie,
  clearSessionCookie,
  createStudioSession,
  destroyStudioSession,
  handoffCookie,
  loadStudioSession,
  mainSiteOrigin,
  normalizeLocale,
  parseCookies,
  randomToken,
  safeEqual,
  safeRelativeReturnPath,
  sessionCookie,
} from './session';

const AUTH_PATHS = new Set([
  '/auth',
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/auth/me',
  '/signin-with-chatgpt',
  '/signout-with-chatgpt',
]);

/** True for every path this module owns (unknown /auth/* get a JSON 404). */
export function isAuthRoute(pathname: string): boolean {
  return AUTH_PATHS.has(pathname) || pathname.startsWith('/auth/');
}

const NO_STORE = 'private, no-store';

function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': NO_STORE, ...extraHeaders },
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': NO_STORE });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

/** Generic failure landing — no detail beyond a marker the UI may surface. */
function failRedirect(cookies: string[] = []): Response {
  return redirect('/?auth_error=denied', cookies);
}

function b64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): string | null {
  try {
    let s = value.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

const mainOrigin = mainSiteOrigin;

/** Honest 503 while the deploy wiring has not configured sign-in yet. */
function notConfigured(): Response {
  return json(
    {
      success: false,
      error: 'Sign-in is not configured yet on this deployment. Guest editing keeps working.',
      code: 'AUTH_NOT_CONFIGURED',
    },
    503
  );
}

// /auth/login ----------------------------------------------------------------

function handleLogin(request: Request, env: StudioAuthEnv, url: URL): Response {
  if (!mainOrigin(env) || !env.STUDIO_HANDOFF_SECRET) return notConfigured();
  const returnTo = safeRelativeReturnPath(url.searchParams.get('return_to') || '/');
  const state = randomToken(32);
  // state + return path live only in this host-scoped cookie; the callback
  // verifies the state echoed through the main worker against it.
  const cookie = handoffCookie(`${state}.${b64urlEncode(returnTo)}`);
  const start = new URL('/api/studio/handoff/start', `${mainOrigin(env)}/`);
  start.searchParams.set('dest', url.origin);
  start.searchParams.set('state', state);
  return redirect(start.toString(), [cookie]);
}

// /auth/callback -------------------------------------------------------------

interface RedeemResult {
  user: StudioSessionUser;
}

/** Server-to-server redemption at the main worker. Null = rejected/unreachable. */
async function redeemCode(env: StudioAuthEnv, code: string, dest: string): Promise<RedeemResult | null> {
  try {
    const res = await fetch(`${mainOrigin(env)}/api/studio/handoff/redeem`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${(env.STUDIO_HANDOFF_SECRET || '').trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code, dest }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      user_id?: unknown;
      display_name?: unknown;
      locale?: unknown;
    } | null;
    if (!data || data.success !== true) return null;
    const id = typeof data.user_id === 'string' ? data.user_id.trim() : '';
    if (!id || id.length > 128) return null;
    const displayName = (typeof data.display_name === 'string' ? data.display_name : '').slice(0, 200) || 'User';
    return { user: { id, display_name: displayName, locale: normalizeLocale(data.locale) } };
  } catch {
    return null;
  }
}

async function handleCallback(request: Request, env: StudioAuthEnv, url: URL): Promise<Response> {
  if (!mainOrigin(env) || !env.STUDIO_HANDOFF_SECRET) return notConfigured();

  // Never let a speculative fetch burn the single-use code — the real
  // navigation re-requests the URL and consumes it then.
  const purpose = request.headers.get('Sec-Purpose') || request.headers.get('Purpose') || '';
  if (purpose.includes('prefetch') || purpose.includes('prerender')) {
    return new Response(null, { status: 204, headers: { 'Cache-Control': NO_STORE } });
  }

  const clear = [clearHandoffCookie()];
  const code = url.searchParams.get('code') || '';
  const state = url.searchParams.get('state') || '';
  const cookieValue = parseCookies(request.headers.get('Cookie')).get(STUDIO_HANDOFF_COOKIE) || '';
  const dot = cookieValue.indexOf('.');
  const expectedState = dot > 0 ? cookieValue.slice(0, dot) : '';
  const returnTo = safeRelativeReturnPath(dot > 0 ? b64urlDecode(cookieValue.slice(dot + 1)) || '/' : '/');

  // The state nonce in the URL must match the one THIS host set before the
  // round-trip — a handoff this browser never initiated (login-CSRF, forged
  // links) dies here without touching the main worker.
  if (!code || code.length > 256 || !state || !expectedState || !(await safeEqual(state, expectedState))) {
    return failRedirect(clear);
  }

  const redeemed = await redeemCode(env, code, url.origin);
  if (!redeemed) return failRedirect(clear);

  // Account switch on this device: drop the previous session row before the
  // new identity's cookie replaces it (never two identities on one browser).
  const previous = await loadStudioSession(request, env);
  if (previous) await destroyStudioSession(env, previous.sessionId);

  const { token, expires } = await createStudioSession(
    env,
    redeemed.user,
    request.headers.get('User-Agent') || ''
  );
  // The 302 both cleans the single-use code out of the address bar/history
  // navigation and lands on the verified same-origin relative return path.
  return redirect(returnTo, [sessionCookie(token, expires), ...clear]);
}

// /auth/logout ---------------------------------------------------------------

function wantsHtmlNavigation(request: Request): boolean {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document';
  return (request.headers.get('Accept') || '').includes('text/html');
}

async function handleLogout(request: Request, env: StudioAuthEnv, url: URL): Promise<Response> {
  if (request.method === 'POST') {
    // Same-origin check for the mutating form: browsers send Origin on
    // cross-site POSTs; the Lax cookie would not accompany them anyway.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) {
      return json({ success: false, error: 'Cross-origin request rejected' }, 403);
    }
  } else if (request.method === 'GET') {
    // GET is kept for plain sign-out links, but a cross-site navigation must
    // not be able to force a logout (Sec-Fetch-Site ships in all supported
    // engines; absent means an old client following its own link).
    const site = request.headers.get('Sec-Fetch-Site');
    if (site === 'cross-site') {
      return json({ success: false, error: 'Cross-site sign-out rejected' }, 403);
    }
  } else {
    return json({ success: false, error: 'Method not allowed' }, 405);
  }

  const session = await loadStudioSession(request, env);
  if (session) await destroyStudioSession(env, session.sessionId);

  if (wantsHtmlNavigation(request)) {
    const returnTo = safeRelativeReturnPath(url.searchParams.get('return_to') || '/');
    return redirect(returnTo, [clearSessionCookie()]);
  }
  return json({ success: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

// Entry ----------------------------------------------------------------------

/**
 * Handles every route isAuthRoute() claims. The caller (worker/index.ts) has
 * already stripped untrusted oai- and x-levo- headers and will re-apply the
 * global security headers to whatever is returned here.
 */
export async function handleAuthRoute(request: Request, env: StudioAuthEnv): Promise<Response> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case '/auth/login':
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ success: false, error: 'Method not allowed' }, 405);
      }
      return handleLogin(request, env, url);

    case '/auth/callback':
      // GET only — a HEAD or speculative request must never consume the code.
      if (request.method !== 'GET') {
        return json({ success: false, error: 'Method not allowed' }, 405);
      }
      return handleCallback(request, env, url);

    case '/auth/logout':
      return handleLogout(request, env, url);

    case '/auth/me': {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ success: false, error: 'Method not allowed' }, 405);
      }
      const session = await loadStudioSession(request, env);
      return json({ success: true, user: session ? session.user : null });
    }

    // Legacy hosting paths (previously 404): forward to the real endpoints.
    case '/signin-with-chatgpt': {
      const returnTo = safeRelativeReturnPath(url.searchParams.get('return_to') || '/');
      return redirect(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
    }
    case '/signout-with-chatgpt': {
      const returnTo = safeRelativeReturnPath(url.searchParams.get('return_to') || '/');
      return redirect(`/auth/logout?return_to=${encodeURIComponent(returnTo)}`);
    }

    default:
      return json({ success: false, error: 'Not found' }, 404);
  }
}
