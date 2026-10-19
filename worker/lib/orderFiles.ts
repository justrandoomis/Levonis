/**
 * «ملفاتك» — THE FILES A BUYER PAID FOR, READ FROM THEIR OWN ORDER
 * (GET /api/orders/:id/files; community v3 push 1.4 review).
 *
 * WHY A SECOND DOOR TO THE SAME FILES. The shopfront's product page is the
 * only other place a buyer sees a purchased file (src/pages/StorefrontProduct.tsx
 * → src/components/storefront/ProductFiles.tsx), and it is mounted only after
 * the PUBLIC product read succeeds. A store the public may not see (its
 * merchant not approved yet, push 1.4) answers that read STORE_UNAVAILABLE,
 * so the buyer of a paid download had no screen that led to it — while the
 * download door itself (worker/routes/productFiles.ts `visibleProduct`)
 * rightly stays open to them. «Finishing work stays open»: the order is the
 * buyer's, and so is this list.
 *
 * THE RULES ARE THE DOWNLOAD DOOR'S, NOT NEW ONES. A row is listed only when
 * that door, asked by THIS buyer, would serve it:
 *
 *   · the order is the signed-in caller's own — anyone else's, an admin's
 *     included, is the same «Order not found» a missing id gets (no oracle);
 *     a cancelled order lists nothing (its money went back, and with it the
 *     grants it paid for — `revokeOrderProductFileGrantStatements`);
 *   · a SANCTIONED store (`storeSanctioned`) lists nothing — the doors are
 *     closed to everyone, exactly as `visibleProduct` closes them; a store
 *     merely not approved yet stays open to a buyer with a live grant, as
 *     there;
 *   · the product is the store's own and, when it is a private product
 *     (0152), the caller is its one customer;
 *   · a downloadable row is a file the caller holds a LIVE grant on
 *     (`liveGrantSql` — the predicate `activeGrant` and `hasProductGrant`
 *     ask: not expired, not paid by an order since cancelled);
 *   · a `preview` row is offered «View in 3D» only when it has a mesh, the
 *     caller holds a live grant on another file of the product (the viewer
 *     door's `full` rule) AND the product is still on the shopfront — the
 *     viewer door, unlike the download, does not outlive a hide.
 *
 * Never a storage key, never a URL to the bytes, never another buyer's row:
 * each row carries what the client needs to build the existing doors' links
 * (`store_slug`, `product_id`, `id`) and the shopfront's public file shape.
 * A database a migration behind (no 0157 grants table, no 0152 audience
 * column) answers an empty list, never a 500.
 */
import { liveGrantSql, productFilesReady, type ProductFileRole } from './fileOwnership';
import { storeById, storeSanctioned, type StoreContext } from './merchantAuth';
import { isSchemaMissing } from './membershipBenefits';
import { privateProductsReady } from './privateProducts';

/** One row of GET /api/orders/:id/files. */
export interface OrderFile {
  /** The file id — the `:fid` of /api/product-files/:slug/:productId/:fid/{download,viewer-token}. */
  id: string;
  role: ProductFileRole;
  name: string;
  bytes: number;
  kind: string;
  /** The file has a derived mesh; on a `preview` row: «View in 3D» (the viewer-token door). */
  has_preview: boolean;
  /** The download door serves it to this buyer now (never true on a preview). */
  downloadable: boolean;
  /** Always true here: only what the buyer holds is listed. */
  granted: true;
  product_id: string;
  /** What the buyer bought, as the order recorded it. */
  product_name: string;
  /** The store's live slug — the `:slug` of the doors above. */
  store_slug: string;
}

export class OrderFilesNotFound extends Error {}

interface Row {
  id: string;
  product_id: string;
  role: string;
  name: string;
  bytes: number;
  kind: string;
  preview_key: string | null;
  store_id: string;
  lifecycle: string;
  product_status: string;
  audience_user_id: string | null;
  product_name: string | null;
  granted: number;
}

/**
 * The files of the caller's own order. Throws `OrderFilesNotFound` for a
 * missing order and for anyone else's alike — the route maps both to its one
 * «Order not found».
 */
export async function orderFilesFor(
  db: D1Database,
  userId: string,
  orderId: string,
  now: string = new Date().toISOString()
): Promise<OrderFile[]> {
  const order = await db
    .prepare('SELECT id, user_id, status FROM orders WHERE id = ?')
    .bind(orderId)
    .first<{ id: string; user_id: string; status: string }>();
  // Someone else's order is "not found", never "forbidden" — and an admin is
  // not this order's buyer: the grants below are the caller's own.
  if (!order || String(order.user_id) !== userId) throw new OrderFilesNotFound();
  if (String(order.status) === 'cancelled') return [];
  if (!(await productFilesReady(db))) return [];

  let rows: Row[];
  try {
    const privateReady = await privateProductsReady(db);
    const { results } = await db
      .prepare(
        `SELECT f.id, f.product_id, f.role, f.name, f.bytes, f.kind, f.preview_key,
                p.store_id, p.lifecycle, p.status AS product_status,
                ${privateReady ? 'p.audience_user_id' : 'NULL AS audience_user_id'},
                (SELECT oi2.name_snapshot FROM order_items oi2
                  WHERE oi2.order_id = ?1 AND oi2.community_product_id = f.product_id
                  ORDER BY oi2.id LIMIT 1) AS product_name,
                EXISTS (SELECT 1 FROM product_file_grants g
                         WHERE g.product_file_id = f.id AND g.user_id = ?2 AND ${liveGrantSql('g', '?3')}) AS granted
           FROM product_files f
           JOIN community_products p ON p.id = f.product_id
          WHERE f.product_id IN (SELECT oi.community_product_id FROM order_items oi
                                  WHERE oi.order_id = ?1 AND oi.community_product_id IS NOT NULL)
          ORDER BY f.product_id, f.position, f.created_at, f.id`
      )
      .bind(orderId, userId, now)
      .all<Row>();
    rows = results ?? [];
  } catch (e) {
    if (isSchemaMissing(e)) return [];
    throw e;
  }
  if (!rows.length) return [];

  // The stores behind these products (one, on every store order today), each
  // read the way the doors read it — with its sanction and approval stamp.
  const storeIds = [...new Set(rows.map((r) => String(r.store_id)))];
  const stores = new Map<string, StoreContext>();
  await Promise.all(
    storeIds.map(async (sid) => {
      const ctx = await storeById(db, sid);
      if (ctx) stores.set(sid, ctx);
    })
  );

  // «Bought» is per product: a live grant on ANY of its files (`hasProductGrant`).
  const bought = new Set(rows.filter((r) => !!r.granted).map((r) => r.product_id));

  const out: OrderFile[] = [];
  for (const r of rows) {
    if (!bought.has(r.product_id)) continue;
    const ctx = stores.get(String(r.store_id));
    if (!ctx || storeSanctioned(ctx)) continue;
    if (r.audience_user_id && r.audience_user_id !== userId) continue;
    const published = r.lifecycle === 'active' && r.product_status === 'active';
    const isPreview = r.role === 'preview';
    if (isPreview ? !(r.preview_key && published) : !r.granted) continue;
    out.push({
      id: r.id,
      role: r.role as ProductFileRole,
      name: r.name,
      bytes: Number(r.bytes ?? 0),
      kind: r.kind,
      has_preview: !!r.preview_key,
      downloadable: !isPreview,
      granted: true,
      product_id: r.product_id,
      product_name: String(r.product_name ?? ''),
      store_slug: ctx.store.slug,
    });
  }
  return out;
}
