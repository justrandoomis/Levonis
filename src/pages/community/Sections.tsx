/**
 * THE DOOR OF THE COMMUNITY SECTION PAGES (community UI plan B4, §3):
 * /community/following, /community/stores and /community/makers.
 *
 * It loads the page of the address on screen; each page stays a chunk of its
 * own. It is reached through the community home chunk (src/pages/Community.tsx
 * re-exports it, src/App.tsx names that chunk for the three addresses), for two
 * reasons the build measures (tests/bundleBudget.test.ts):
 *   - the entry gains no chunk of its own and no preload list for these
 *     routes (the entry and a store visit are at their byte caps);
 *   - the lists the section pages share with the home tabs (the feeds, the
 *     cards, the words) stay in the home chunk, already in memory when a page
 *     loads, instead of splitting into small chunks every visit has to name.
 * A visit to a section loads the home chunk first, as the home tab it
 * replaces did.
 */
import { Suspense, lazy } from 'react';
import { useLocation } from 'react-router-dom';

const PAGES = {
  '/community/following': lazy(() => import('./Following')),
  '/community/stores': lazy(() => import('./Stores')),
  '/community/makers': lazy(() => import('./Makers')),
} as const;

/** The section of an address, a trailing slash allowed; null for any other. */
export function sectionOf(pathname: string): keyof typeof PAGES | null {
  const path = pathname.replace(/\/+$/, '');
  return path in PAGES ? (path as keyof typeof PAGES) : null;
}

export default function CommunitySections() {
  const { pathname } = useLocation();
  const key = sectionOf(pathname);
  if (!key) return null;
  const Page = PAGES[key];
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}
