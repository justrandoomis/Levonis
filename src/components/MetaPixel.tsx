import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useStore } from '../StoreContext';
import { isMetaPixelPath, startMetaPixel, trackMetaPageView } from '../lib/metaPixel';

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
 * Meta's script itself is loaded on the first reported page, not before: a
 * visit that never opens one never contacts Meta.
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
    if (!mainSite || !isMetaPixelPath(pathname)) return;
    // A guard's redirect can run before this effect (/cart -> /auth for a
    // guest), and Meta reads the address when the event is sent: report only
    // while the browser is still on the page being reported.
    if (window.location.pathname !== pathname) return;
    startMetaPixel();
    trackMetaPageView();
  }, [resolved, mainSite, pathname]);

  return null;
}
