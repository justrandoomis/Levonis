/**
 * SIGNING IN FROM PRINT CLOUD.
 *
 * cloud.<root> cannot sign anyone in with Google — Google accepts only the
 * apex as an origin, and the server withholds it on every system host
 * (worker/lib/hosts.ts `googleAllowedOn`). So, exactly as a shop does
 * (src/App.tsx `StoreHostAuthHandoff`), a visitor who needs an account is
 * handed to the apex's sign-in page:
 *
 *   https://<root>/auth?next=<sanitized path>&app=cloud&lang=<chosen>
 *
 * and after signing in the apex sends them back to `https://cloud.<root><next>`
 * (src/pages/Auth.tsx `finishAuth` → src/components/auth/storeReturn.ts
 * `appReturnUrl`). The session cookie is the parent domain's, so they arrive
 * signed in. `app` is a LITERAL from an allowlist, never a host: nothing a
 * link can carry turns this into an open redirect (tests/printCloudUiShell.test.ts).
 *
 * With no root domain configured, or on a local run (levonis.test:8787 is
 * http and has a port), there is no apex to go to: the ordinary sign-in page
 * is shown here instead, without Google.
 *
 * A screen asks for an account with `<RequireSignIn>` (the whole screen) or
 * `useSignIn()` (a button: «sign in to buy»).
 */
import React from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { chosenLang, useLanguage } from '../LanguageContext';
import { useStore } from '../StoreContext';
import { isLocalHost } from '../lib/canonicalHost';
import { CloudPageFallback } from './ui/CloudPageFallback';
import { cloudHandoffUrl } from './signInUrl';

/** The ordinary sign-in page, for a host with no apex to hand over to. */
const Auth = React.lazy(() => import('../pages/Auth'));

/** cloud.<root>'s /auth: to the apex, or (no apex) the ordinary page here. */
export function CloudAuthHandoff() {
  const { mainSite } = useStore();
  const { lang } = useLanguage();
  const location = useLocation();
  const from = (location.state as { from?: unknown } | null)?.from;
  const target = React.useMemo(() => {
    if (!mainSite || isLocalHost(window.location.hostname)) return null;
    return cloudHandoffUrl(mainSite, location.search, from, chosenLang());
    // `lang` is a dependency only to re-read the stored choice after a switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainSite, from, location.search, lang]);
  React.useEffect(() => {
    if (target) window.location.replace(target);
  }, [target]);
  if (!target) {
    return (
      <React.Suspense fallback={<CloudPageFallback />}>
        <Auth />
      </React.Suspense>
    );
  }
  return <CloudPageFallback />;
}

/**
 * A screen that needs an account: signed out, the visitor goes through
 * /auth (above) and comes back to exactly this address.
 */
export function RequireSignIn({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoaded } = useAuth();
  const location = useLocation();
  if (!isLoaded) return <CloudPageFallback />;
  if (!isAuthenticated) return <Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** For a button: `const signIn = useSignIn(); <Button onClick={() => signIn()} />` — back here afterwards (or to `next`). */
export function useSignIn(): (next?: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return React.useCallback(
    (next?: string) => navigate('/auth', { state: { from: next ?? location.pathname + location.search } }),
    [navigate, location.pathname, location.search]
  );
}
