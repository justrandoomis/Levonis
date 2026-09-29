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

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
// Type-only: `lib/merchant` (the merchant API clients, ~8 KB) is shared with
// lazy screens, so a VALUE import here pulled all of it into the entry chunk
// for one GET (W6). The resolve call is spelled out below instead.
import type { MerchantStore } from './lib/merchant';
import { api } from './lib/api';
// THE ANSWER MAY ALREADY BE IN THE DOCUMENT, OR ALREADY ON ITS WAY (P2b,
// docs/MERCHANT_PLATFORM_V2.md §B.1 #3). The Worker writes the anonymous
// resolve answer into the documents it rewrites for a share card as a JSON
// data block; for every other document `lib/bootFetch.ts` started the request
// at module evaluation, before React mounted. Either way the question is not
// asked a second time here: the block is read synchronously, the primed
// request is taken over, and only a page with neither fetches from the effect.
import { INLINE_RESOLVE_ID, readInlineJson, settleJson, takePrimed } from './lib/bootFetch';

interface StoreContextValue {
  /** The store this hostname belongs to, or null for the main site. */
  store: MerchantStore | null;
  /** True once the question has been answered either way. */
  resolved: boolean;
  /** A hostname that looked like a store but is not one. */
  unknownStore: boolean;
  /**
   * A store that exists and is under an ADMIN sanction (its own suspension or
   * its merchant's). Owner decision 2026-09-24: the page is only «المتجر غير
   * متاح حاليًا» — the server sends nothing of the shop to render anyway.
   */
  unavailableStore: boolean;
  /**
   * The platform's own origin (`https://<root domain>`), FROM THE SERVER — the
   * store host links «LEVONIS», the request board and the messenger here, and
   * never to a domain typed into the bundle (audit 01 B19). Empty when the
   * deployment has no root domain configured: links then stay relative.
   */
  mainSite: string;
}

const StoreContext = createContext<StoreContextValue>({
  store: null,
  resolved: false,
  unknownStore: false,
  unavailableStore: false,
  mainSite: '',
});

const mainSiteOf = (root: unknown): string =>
  typeof root === 'string' && /^[a-z0-9.-]+$/i.test(root) ? `https://${root}` : '';

/**
 * A RENAMED STORE'S OLD ADDRESS FOLLOWS IT (audit 01 B14). The server answers
 * an old slug with `STORE_MOVED` and where the shop lives now; the path and
 * query come along, so an old product link lands on the same product. Only an
 * https:// address on the SAME root domain is followed — the target comes
 * from the server, but a redirect is the one place a bad value would send a
 * customer somewhere else entirely.
 */
function followMove(redirect: unknown, mainSite: string): boolean {
  if (typeof redirect !== 'string' || !mainSite || typeof window === 'undefined') return false;
  try {
    const to = new URL(redirect);
    const root = new URL(mainSite).hostname;
    if (to.protocol !== 'https:' || !(to.hostname === root || to.hostname.endsWith(`.${root}`))) return false;
    window.location.replace(`${to.origin}${window.location.pathname}${window.location.search}`);
    return true;
  } catch {
    return false;
  }
}

export function useStore(): StoreContextValue {
  return useContext(StoreContext);
}

/** The shape `GET /api/storefront/resolve` answers with (and the inline data block repeats). */
type ResolveAnswer = { success?: boolean; kind: string; store: MerchantStore | null; root_domain?: string | null };

/**
 * The document's own answer, when the Worker wrote one. Only a SUCCESS answer
 * is ever inlined (worker/index.ts `assetWithPreview`): a host that is not a
 * store, or a store under sanction, is left to the request below, whose
 * refusal codes the catch already understands. Anything malformed reads as
 * absent — the page then simply asks, as it always did.
 */
function inlineResolve(): StoreContextValue | null {
  const d = readInlineJson<ResolveAnswer>(INLINE_RESOLVE_ID);
  if (!d || d.success === false || typeof d.kind !== 'string') return null;
  return {
    store: d.store ?? null,
    resolved: true,
    unknownStore: false,
    unavailableStore: false,
    mainSite: mainSiteOf(d.root_domain),
  };
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoreContextValue>(
    () =>
      inlineResolve() ?? {
        store: null,
        resolved: false,
        unknownStore: false,
        unavailableStore: false,
        mainSite: '',
      }
  );
  // Answered by the document: nothing to ask. Read once, at mount, so the
  // effect below neither re-runs nor depends on state.
  const answeredByDocument = useRef(state.resolved);

  useEffect(() => {
    if (answeredByDocument.current) return;
    let alive = true;
    // The request `bootFetch` started at module evaluation, when there is one;
    // the ordinary client call otherwise (a re-mount, a test, a page whose
    // boot code did not run). Both settle to the same answer or the same error.
    // Spelled out (not `RESOLVE_PATH`) on purpose: tests/storefrontIsolation.test.ts
    // reads this file for the literal call — the browser asks the SERVER which
    // store a hostname is, never `location.hostname`.
    const primed = takePrimed('/api/storefront/resolve');
    const answer = primed
      ? settleJson<ResolveAnswer>('/api/storefront/resolve', primed)
      : api.get<ResolveAnswer>('/api/storefront/resolve');
    answer
      .then((d) => {
        if (!alive) return;
        setState({
          store: d.store ?? null,
          resolved: true,
          unknownStore: false,
          unavailableStore: false,
          mainSite: mainSiteOf(d.root_domain),
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // A 404 from /resolve means "this host looks like a store and is
        // not one" — which is a real answer worth rendering, not a network
        // failure. Anything else falls back to the main site, because a
        // transient error must never blank out levonis-iq.com.
        const err = e as { status?: number; code?: string; details?: Record<string, unknown>; body?: Record<string, unknown> };
        const mainSite = mainSiteOf(err?.body?.root_domain);
        if (err?.code === 'STORE_MOVED' && followMove(err.details?.redirect, mainSite)) return;
        const unavailable = err?.status === 404 && err?.code === 'STORE_UNAVAILABLE';
        setState({
          store: null,
          resolved: true,
          unknownStore: err?.status === 404 && !unavailable,
          unavailableStore: unavailable,
          mainSite,
        });
      });
    return () => {
      alive = false;
    };
  }, []);

  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}
