/**
 * What every workspace section may ask of the shell around it — the store,
 * whether it may sell, how to build a link on THIS host, and the attention
 * counts — without prop-drilling through the lazy boundary.
 */
import { createContext, useContext } from 'react';
import type { MerchantMe, MerchantStore } from '../../../lib/merchant';
import type { WorkspaceQuery } from '../../../lib/merchantRoutes';
import type { AttentionState } from './attention';

export interface WorkspaceValue {
  me: MerchantMe;
  store: MerchantStore;
  /** The server's answer (`/api/merchant/me` `selling.canSell`), never the page's own guess. */
  canSell: boolean;
  /** `/merchant` on the platform's host, `/admin` on the store's own subdomain. */
  base: string;
  onStoreHost: boolean;
  /** A stored `/merchant/…` link as this host serves it (`hostPath`). */
  href: (link: string) => string;
  /** A platform page (`/subscription`, `/chat/…`) as a link from this host — absolute on a store's subdomain. */
  mainHref: (path: string) => string;
  /** Where a link from the server points: inside the workspace (router) or out to the main site (document). */
  resolveLink: (link: string) => { internal: boolean; to: string };
  /** Open a workspace link, or a main-site path (on a store host, a full navigation to the main site). */
  go: (link: string, opts?: { replace?: boolean }) => void;
  /** The address's allow-listed query words (`readWorkspaceQuery`). */
  query: WorkspaceQuery;
  /** Drop `?new=1` from the address once the section has opened its «new» form. */
  clearQuery: () => void;
  reloadMe: () => void;
  attention: AttentionState;
  setBellUnread: (n: number | null) => void;
}

export const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const v = useContext(WorkspaceContext);
  if (!v) throw new Error('useWorkspace outside the merchant workspace');
  return v;
}
