/**
 * PRINT CLOUD'S ADDRESS SPACE — which section owns a path.
 *
 * The shell (src/cloud/PrintCloudApp.tsx) answers a few pages itself — `/`,
 * `/printers`, `/printers/:id`, `/how-it-works`, `/auth` and the 404 — and
 * hands every path under a section's prefixes to that section's own module,
 * which renders its own `<Routes>` with FULL paths (`/files/:id`, not
 * `:id`):
 *
 *   print    /print, /files, /projects, /jobs   pages/print/PrintRoutes.tsx   (signed in)
 *   store    /store, /orders                    pages/store/StoreRoutes.tsx   (public; its
 *                                               own screens ask for an account where needed)
 *   account  /account                           pages/account/AccountRoutes.tsx (signed in)
 *
 * The four tabs of the bar and the pill nav point at the section roots.
 */
import type { Tri } from './types';
import { nav } from './strings/common';

export type CloudSection = 'print' | 'store' | 'account';
export type CloudTab = 'home' | CloudSection;

export const SECTION_PREFIXES: Readonly<Record<CloudSection, readonly string[]>> = {
  print: ['/print', '/files', '/projects', '/jobs'],
  store: ['/store', '/orders'],
  account: ['/account'],
};

/** The section a path belongs to, or null for the shell's own pages. Case-insensitive, as the router is. */
export function cloudSection(pathname: string): CloudSection | null {
  const path = pathname.toLowerCase();
  for (const section of ['print', 'store', 'account'] as const) {
    if (SECTION_PREFIXES[section].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return section;
  }
  return null;
}

/** The tab a path lights up: its section's, or Home for the shell's own pages. */
export function activeTab(pathname: string): CloudTab {
  return cloudSection(pathname) ?? 'home';
}

export interface TabDef {
  id: CloudTab;
  to: string;
  label: Tri;
}

/** The four tabs, in the prototype's order. */
export const TABS: readonly TabDef[] = [
  { id: 'home', to: '/', label: nav.home },
  { id: 'print', to: '/print', label: nav.print },
  { id: 'store', to: '/store', label: nav.store },
  { id: 'account', to: '/account', label: nav.account },
];
