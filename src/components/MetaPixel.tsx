import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../StoreContext';

/**
 * Reports a PageView to the Meta Pixel for each page the visitor opens — on
 * the MAIN SITE only, and only on the pages src/lib/metaPixel.ts lists.
 *
 * MAIN SITE ONLY. The same bundle is every merchant's shop (src/StoreContext.tsx),
 * and the platform's pixel must not report another shop's customers. Which
 * host this is is the SERVER's answer, never the browser's own hostname: nothing is
 * decided until it has answered, and a store host, an unknown or unavailable
 * store, or a system host (Print Cloud) loads nothing from Meta at all.
 *
 * THE PIXEL'S CODE IS A LAZY CHUNK. This component is in the entry, which is
 * every store page's first download too (tests/bundleBudget.test.ts holds the
 * storefront's fixed weight to the KB), so it carries only the decision; the
 * module is fetched on the main site, and Meta's script on the first reported
 * page — a visit that never opens one never contacts Meta.
 */
export default function MetaPixel() {
  const { resolved, store, unknownStore, unavailableStore, system } = useStore();
  const { pathname } = useLocation();
  const mainSite = resolved && !store && !unknownStore && !unavailableStore && !system;
  // The last path decided on: one PageView per page opened, not per render
  // (StrictMode runs effects twice in development).
  const decided = useRef<string | null>(null);

  useEffect(() => {
    if (!resolved || decided.current === pathname) return;
    decided.current = pathname;
    if (!mainSite) return;
    // reportMetaPage checks the page is a reported one and the browser is still on it.
    void import('../lib/metaPixel').then((m) => m.reportMetaPage(pathname)).catch(() => {});
  }, [resolved, mainSite, pathname]);

  return null;
}
