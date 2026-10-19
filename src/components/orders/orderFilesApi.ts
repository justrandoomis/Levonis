/**
 * «ملفاتك» on the buyer's order — the client's door to GET /api/orders/:id/files
 * (worker/lib/orderFiles.ts): the path to a purchased file that does not
 * depend on the shopfront being public (a store not approved yet hides its
 * product page, never its buyer's downloads). The links are the shopfront's
 * own doors (community/files/api.ts `storefrontFilesApi.downloadUrl` /
 * `.viewerToken`).
 *
 * WHY NOT IN community/files/api.ts: that module is a static import of the
 * store's product page (src/pages/StorefrontProduct.tsx), so every byte added
 * there is downloaded by every store visit (tests/bundleBudget.test.ts, the
 * storefront app payload). This door is read only by the order page's lazy
 * «Your files» block (./OrderFiles.tsx) and travels in that chunk.
 */
import { api } from '../../lib/api';
import type { ProductFilePublic } from '../community/files/api';

/**
 * One row of GET /api/orders/:id/files: a file the signed-in buyer holds on
 * THIS order, in the shopfront's public shape plus the store slug and product
 * id the doors take. Only rows the download (or, on a `preview`, the viewer)
 * door would serve to this buyer.
 */
export interface OrderFile extends ProductFilePublic {
  product_id: string;
  /** What the buyer bought, as the order recorded it. */
  product_name: string;
  store_slug: string;
}

export const orderFilesApi = {
  list: (orderId: string) =>
    api.get<{ files: OrderFile[] }>(`/api/orders/${encodeURIComponent(orderId)}/files`).then((d) => d.files ?? []),
};
