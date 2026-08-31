/**
 * Which store — if any — is this hostname?
 *
 * ONE DEPLOYMENT SERVES EVERY STORE (§10). There is no build per merchant and
 * no separate frontend project: the same bundle answers levonis-iq.com and
 * ali3d.levonis-iq.com, and this provider is what tells the app which one it
 * is. It asks the Worker once on boot, because only the server can safely
 * turn a Host header into a store — the browser's own hostname is a hint, not
 * an authorisation, and a store must exist and be resolvable before anything
 * renders as its shopfront.
 *
 * WHY NOT PARSE `location.hostname` HERE. It would work for the happy path
 * and be wrong everywhere else: a slug that looks valid but has no store, a
 * system subdomain, a staging host, a preview URL. The server already
 * classifies hosts in one place (worker/lib/hosts.ts) and is the only side
 * that knows which slugs exist. Asking it keeps one answer instead of two
 * that can disagree.
 *
 * The identity is untouched by any of this. A customer signed in on the main
 * site is already signed in here — that is the parent-domain cookie, not
 * anything this provider does.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { storefrontApi, type MerchantStore } from './lib/merchant';

interface StoreContextValue {
  /** The store this hostname belongs to, or null for the main site. */
  store: MerchantStore | null;
  /** True once the question has been answered either way. */
  resolved: boolean;
  /** A hostname that looked like a store but is not one. */
  unknownStore: boolean;
}

const StoreContext = createContext<StoreContextValue>({
  store: null,
  resolved: false,
  unknownStore: false,
});

export function useStore(): StoreContextValue {
  return useContext(StoreContext);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreContextValue>({
    store: null,
    resolved: false,
    unknownStore: false,
  });

  useEffect(() => {
    let alive = true;
    storefrontApi
      .resolve()
      .then((d) => {
        if (!alive) return;
        setState({ store: d.store ?? null, resolved: true, unknownStore: false });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // A 404 from /resolve means "this host looks like a store and is
        // not one" — which is a real answer worth rendering, not a network
        // failure. Anything else falls back to the main site, because a
        // transient error must never blank out levonis-iq.com.
        const status = (e as { status?: number })?.status;
        setState({ store: null, resolved: true, unknownStore: status === 404 });
      });
    return () => {
      alive = false;
    };
  }, []);

  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}
