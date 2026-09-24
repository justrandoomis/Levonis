/**
 * Is the workspace being shown on the viewer's OWN store host (or on the main
 * site)? `/admin` on a store's subdomain is that store's dashboard; opened on
 * somebody else's shop it used to show the VIEWER's own store under the other
 * shop's address (audit 01 B16). Nothing leaked — every call is scoped to the
 * session — but a dashboard that is not the host's is the wrong page there,
 * so src/pages/MerchantDashboardPage.tsx refuses to draw the workspace.
 *
 * The browser never parses the hostname to decide which store it is on
 * (storefrontIsolation.test.ts): `host.storeId` is the server's answer from
 * /api/storefront/resolve. Only when the host resolved to no servable store
 * (a suspended one) is the address the SERVER gave the viewer's own store
 * compared with the one in the bar. Pure, for the tests.
 */
export function onOwnHost(
  own: { id: string; url: string },
  host: { storeId: string | null; storeHost: boolean },
  locationHost: string
): boolean {
  if (!host.storeHost) return true;
  if (host.storeId) return host.storeId === own.id;
  try {
    return new URL(own.url).host === locationHost;
  } catch {
    return false;
  }
}
