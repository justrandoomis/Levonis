/**
 * A STORE'S PRODUCT, AS THIS VIEWER MAY SEE IT — moved out of
 * worker/routes/productFiles.ts (`visibleProduct`) without a change of
 * behaviour, so the product files' doors and the request editor's «اطلب
 * طباعته» entry (worker/routes/requestEntries.ts; plan P1-06,
 * docs/DECISIONS.md row 268) ask one question with one set of answers:
 * STORE_UNAVAILABLE for a store the viewer may not see, 404 for a product
 * that is not this store's, not published, or another customer's private one.
 */
import { notFound } from './http';
import { storeHiddenFromPublic, storeSanctioned, type StoreContext } from './merchantAuth';
import { publicStoreUnavailable } from './merchantApproval';
import { privateProductsReady } from './privateProducts';
import { hasProductGrant } from './fileOwnership';
import { storeBySlugOrRetired } from '../routes/storefront';

export interface VisibleProduct {
  ctx: StoreContext;
  product: { id: string; slug: string; owner_id: string; published: boolean };
}

/**
 * The store, servable TO THIS VIEWER (a sanction closes it to everyone; a
 * merchant the public may not see yet closes it to all but its owner and a
 * buyer with a live grant on the product), and the product as the shopfront
 * shows it — the same
 * `lifecycle = 'active' AND status = 'active'` rule storefront.ts applies,
 * plus 0152's private products, which only their one customer may see. The
 * store owner sees their own product in every state (they are looking at
 * their own editor's preview). `allowUnpublished` lets a caller decide the
 * hidden case itself (the download door: a buyer's grant outlives a hide);
 * `published` says which case it is.
 *
 * ONE WAVE, not two: the store and the product are read in parallel (the
 * product by its id, its `store_id` checked against the store afterwards),
 * so a shopper's read costs one dependent round trip less from a far primary.
 */
export async function visibleStoreProduct(
  db: D1Database,
  viewer: { id: string } | null,
  slug: string,
  productId: string,
  opts: { allowUnpublished?: boolean } = {}
): Promise<VisibleProduct> {
  const [ctx, p] = await Promise.all([
    storeBySlugOrRetired(db, slug),
    privateProductsReady(db).then((privateReady) =>
      db.prepare(
        `SELECT id, slug, store_id, lifecycle, status, ${privateReady ? 'audience_user_id' : 'NULL AS audience_user_id'}
           FROM community_products WHERE id = ?`
      )
        .bind(productId)
        .first<{ id: string; slug: string; store_id: string; lifecycle: string; status: string; audience_user_id: string | null }>()
    ),
  ]);
  // A SANCTION closes these doors to everyone, the owner too — as before push 1.4.
  if (storeSanctioned(ctx)) throw publicStoreUnavailable();
  const owner = !!viewer && viewer.id === ctx.store.user_id;
  /*
   * A STORE THE PUBLIC MAY NOT SEE (its merchant not approved — owner
   * decisions C1/C2) answers the one generic STORE_UNAVAILABLE (C9) to the
   * public, but not to the people whose work is already done: the store's
   * owner, and a buyer holding a LIVE grant on this product (a paid order
   * already placed — «nothing is frozen»). Asked before «not found», so a
   * stranger learns nothing about which product ids exist on a hidden store.
   */
  if (!owner && storeHiddenFromPublic(ctx)) {
    const entitled = !!viewer && !!p && p.store_id === ctx.store.id && (await hasProductGrant(db, p.id, viewer.id));
    if (!entitled) throw publicStoreUnavailable();
  }
  if (!p || p.store_id !== ctx.store.id) throw notFound('Product not found');
  const published = p.lifecycle === 'active' && p.status === 'active';
  if (!owner && !opts.allowUnpublished && !published) throw notFound('Product not found');
  if (!owner && p.audience_user_id && (!viewer || viewer.id !== p.audience_user_id)) throw notFound('Product not found');
  return { ctx, product: { id: p.id, slug: p.slug, owner_id: ctx.store.user_id, published } };
}

