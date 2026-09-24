/**
 * THE WORKSPACE ROUTER — which screen an address opens.
 *
 * The addresses are the contract's (packages/contracts/src/merchantRoutes.ts):
 * the Worker writes them into notifications, the nav table builds its links
 * from them, and this resolves them. It replaced W2-E's URL→tab adapter in
 * MerchantDashboardPage.tsx and accepts every address that adapter accepted:
 *
 *   /merchant                     the Command Center
 *   /merchant/<section>[/<id>]    that section (`id` for orders, products,
 *                                 coupons, custom orders)
 *   /merchant/inbox/<thread>      AWAY: the thread still opens in the Chat
 *                                 page (/chat/<id>) until the merchant thread
 *                                 view exists
 *   /merchant/requests/<id>       AWAY: the request opens on the board
 *                                 (/requests?request=<id>)
 *   /merchant/custom-orders[/id]  an older spelling of the custom-order book,
 *                                 redirected to /merchant/requests/orders[/id]
 *   anything else under the base  REDIRECTED to the Command Center — never a
 *                                 blank page
 *
 * The same tree is served under `/admin` on a store's own subdomain (`base`).
 * A query string is the section's business (`readWorkspaceQuery`), never the
 * router's. Pure: no React, no window — the tests call it directly.
 */
import {
  SECTION_PATHS,
  SECTIONS_WITH_ID,
  parseMerchantPath,
  type MerchantSection,
} from '../../../lib/merchantRoutes';

export type WorkspaceRoute =
  | { kind: 'section'; section: MerchantSection; id?: string }
  /** The canonical address of this screen on this host — replace the URL. */
  | { kind: 'redirect'; to: string }
  /** A page outside the workspace, on the platform's main site. */
  | { kind: 'away'; to: string };

/** Older spellings a stored link or a bookmark may still carry. */
export const LEGACY_ALIASES: Readonly<Record<string, MerchantSection>> = {
  'custom-orders': 'custom_orders',
};

export function resolveWorkspaceRoute(pathname: string, base: string): WorkspaceRoute {
  const clean = String(pathname ?? '').split(/[?#]/)[0].replace(/\/+$/, '');
  const at = parseMerchantPath(clean, base);
  if (at) {
    if (at.section === 'inbox' && at.id) return { kind: 'away', to: `/chat/${encodeURIComponent(at.id)}` };
    if (at.section === 'requests' && at.id) return { kind: 'away', to: `/requests?request=${encodeURIComponent(at.id)}` };
    return at.id ? { kind: 'section', section: at.section, id: at.id } : { kind: 'section', section: at.section };
  }
  if (clean.startsWith(`${base}/`)) {
    const [head, ...tail] = clean.slice(base.length + 1).split('/');
    const alias = LEGACY_ALIASES[head];
    if (alias) {
      const target = `${base}/${SECTION_PATHS[alias]}${tail.length ? `/${tail.join('/')}` : ''}`;
      // Only if the rewritten address is itself a real one; otherwise home.
      return { kind: 'redirect', to: parseMerchantPath(target, base) ? target : base };
    }
  }
  return { kind: 'redirect', to: base };
}

/**
 * The route table as data — every section, its path, and whether it takes an
 * id — for the tests that hold the nav, the router and the contract together.
 */
export const ROUTE_TABLE: ReadonlyArray<{ section: MerchantSection; path: string; withId: boolean }> = (
  Object.keys(SECTION_PATHS) as MerchantSection[]
).map((section) => ({ section, path: SECTION_PATHS[section], withId: SECTIONS_WITH_ID.has(section) }));
