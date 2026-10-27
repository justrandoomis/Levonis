/**
 * THE OLD `?tab=` ADDRESSES AND WHERE THEY LIVE NOW (community UI plan C1, §3).
 *
 * The home used to hold six tabs (`/community?tab=foryou|following|projects|
 * requests|stores|creators`, and the two older names `products` and
 * `merchants`). Each section has its own page now (D-7), so an old address,
 * from a link already in the app, a bookmark or the history of someone, is sent to
 * that page with `replace` (Back never lands on the old name), keeping the
 * search term `q`. `products` stays on the home as its products list
 * (`?list=products`), and `foryou` is the home itself. The answer never has a
 * `tab`, so a redirect cannot loop.
 */
export const TAB_IDS = ['foryou', 'following', 'projects', 'requests', 'stores', 'creators'] as const;
export type CommunityTab = (typeof TAB_IDS)[number];

/** The page of each old tab name. */
export const TAB_PAGES: Readonly<Record<string, string>> = {
  following: '/community/following',
  projects: '/community/projects',
  requests: '/requests',
  stores: '/community/stores',
  merchants: '/community/stores',
  creators: '/community/makers',
};

/** Where an address with `?tab=` belongs now, or null when it has none. */
export function legacyTabTarget(params: URLSearchParams): string | null {
  const tab = params.get('tab');
  if (tab === null) return null;
  const q = (params.get('q') ?? '').trim();
  const page = Object.prototype.hasOwnProperty.call(TAB_PAGES, tab) ? TAB_PAGES[tab] : null;
  const next = new URLSearchParams();
  // The home («لك», the old products tab, or a name nobody knows) keeps its own products list.
  if (!page && (tab === 'products' || params.get('list') === 'products')) next.set('list', 'products');
  if (q) next.set('q', q);
  const query = next.toString();
  return `${page ?? '/community'}${query ? `?${query}` : ''}`;
}
