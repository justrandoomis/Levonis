/**
 * THE HOME'S SIX SECTIONS AND HOW THE URL NAMES THEM.
 *
 * `/community?tab=foryou|following|projects|requests|stores|creators`. Two
 * older names still arrive from links already in the app and in people's
 * history: `?tab=products` (the old first tab — now the in-page products
 * list under «لك», `?tab=foryou&list=products`) and `?tab=merchants`
 * (src/pages/FollowedStores.tsx links it — now `stores`). They are resolved
 * here, synchronously, so the first paint is already the right section, and
 * the page rewrites the address with `replace` so Back never lands on the
 * old name.
 */
export const TAB_IDS = ['foryou', 'following', 'projects', 'requests', 'stores', 'creators'] as const;
export type CommunityTab = (typeof TAB_IDS)[number];

export interface ResolvedTab {
  tab: CommunityTab;
  /** «لك» showing the products list instead of the issue. */
  list: 'products' | null;
  /** The address used an old name and should be rewritten. */
  legacy: boolean;
}

export function resolveTab(params: URLSearchParams): ResolvedTab {
  const raw = params.get('tab');
  const list = params.get('list') === 'products' ? 'products' : null;
  if (raw === 'products') return { tab: 'foryou', list: 'products', legacy: true };
  if (raw === 'merchants') return { tab: 'stores', list: null, legacy: true };
  const tab = (TAB_IDS as readonly string[]).includes(raw ?? '') ? (raw as CommunityTab) : 'foryou';
  return { tab, list: tab === 'foryou' ? list : null, legacy: false };
}

/** The address the old name should become. */
export function canonicalParams(params: URLSearchParams): URLSearchParams {
  const p = new URLSearchParams(params);
  const r = resolveTab(params);
  p.set('tab', r.tab);
  if (r.list) p.set('list', r.list);
  else p.delete('list');
  return p;
}
