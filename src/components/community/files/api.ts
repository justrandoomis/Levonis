/**
 * FILES ON PRODUCTS AND POSTS — the client's typed doors to
 * worker/routes/productFiles.ts and the attachment routes in
 * worker/routes/communityPosts.ts (docs/COMMUNITY_ECOSYSTEM.md §9.4).
 *
 * The shapes mirror the server's answers; nothing here decides who may see a
 * file — the server's roles, grants and tokens do. A storage KEY appears in
 * exactly two places: what an upload handed back and the owner's own listing
 * (`file_key` on a merchant's rows, `key` on an author's rows), because a key
 * is what the editor sends back. A shopper's or a reader's rows never carry
 * one, and the bytes are reached only through `downloadUrl` (an attachment
 * behind a grant) or the viewer page (`viewerToken(...).url`).
 *
 * Refusal codes these doors raise — map them through
 * src/lib/refusalStrings.ts: PRODUCT_FILE_NOT_FOUND, PRODUCT_FILE_NOT_GRANTED,
 * PRODUCT_FILE_NOT_OWNED, PRODUCT_FILE_LIMIT, PRODUCT_FILE_ROLE_INVALID,
 * PRODUCT_FILE_ORDER_INVALID, POST_FILE_LIMIT, POST_FILE_NOT_OWNED,
 * POST_FILE_KIND, POST_FILE_NOT_FOUND, POST_FILE_NOT_DOWNLOADABLE,
 * VIEWER_TOKEN_INVALID, NO_PREVIEW, VIEWER_NOT_ALLOWED.
 */
import { api } from '../../../lib/api';

export const PRODUCT_FILE_ROLES = ['preview', 'download_after_purchase', 'reference', 'instruction', 'source_model'] as const;
export type ProductFileRole = (typeof PRODUCT_FILE_ROLES)[number];
export type FileKind = 'model' | 'document' | 'image' | 'archive';

/** The most files one product carries, and one post. */
export const PRODUCT_FILES_MAX = 12;
export const POST_FILES_MAX = 3;

/** A product file as a shopper sees it: a name and a size by role — no key, no URL to the bytes. */
export interface ProductFilePublic {
  id: string;
  role: ProductFileRole;
  name: string;
  bytes: number;
  kind: FileKind;
  /** A `preview` file with a derived mesh: «عرض ثلاثي الأبعاد» is offered. */
  has_preview: boolean;
  /** May THIS viewer download it now — the owner always, a buyer with a grant, never a guest. */
  downloadable: boolean;
  /** The owner, or a viewer holding a live grant (on the preview row: the viewer link opens the full mesh). */
  granted: boolean;
}

/** The owner's row: the public one plus what the editor sends back. */
export interface ProductFileOwned extends Omit<ProductFilePublic, 'downloadable'> {
  file_key: string;
  mime: string;
  position: number;
  created_at: string;
}

export interface ProductFileInput {
  /** The key an upload with purpose `product_file` handed back. */
  file_key: string;
  role: ProductFileRole;
  name?: string;
  position?: number;
}

export interface ViewerToken {
  token: string;
  /** The viewer page: `/model-viewer/<token>`. */
  url: string;
  expires_at: string;
  /** `preview` = the coarse mesh; `full` = the stored one (owner, author, buyer). */
  grant: 'preview' | 'full';
}

/** A post attachment as a reader sees it; `key` only on the author's own read. */
export interface PostFile {
  id: string;
  name: string;
  bytes: number;
  kind: 'model' | 'document';
  /** The author ticked «يمكن تنزيله»: a signed-in reader may take the original. */
  downloadable: boolean;
  has_preview: boolean;
  key?: string;
}

/** What the composer sends in `files[]` on POST/PATCH /api/community/posts. */
export interface PostFileInput {
  /** The key an upload with purpose `post` handed back. */
  file_key: string;
  name?: string;
  downloadable?: boolean;
}

const enc = encodeURIComponent;

/** The merchant's editor — /api/merchant/products/:id/files (store owner only). */
export const productFilesApi = {
  list: (productId: string) =>
    api.get<{ files: ProductFileOwned[]; max: number }>(`/api/merchant/products/${enc(productId)}/files`),
  add: (productId: string, input: ProductFileInput) =>
    api.post<{ file: ProductFileOwned; replayed?: boolean }>(`/api/merchant/products/${enc(productId)}/files`, input).then((d) => d.file),
  update: (productId: string, fileId: string, patch: Partial<Pick<ProductFileInput, 'role' | 'name' | 'position'>>) =>
    api.patch<{ file: ProductFileOwned }>(`/api/merchant/products/${enc(productId)}/files/${enc(fileId)}`, patch).then((d) => d.file),
  remove: (productId: string, fileId: string) =>
    api.delete<{ success: true }>(`/api/merchant/products/${enc(productId)}/files/${enc(fileId)}`),
  reorder: (productId: string, ids: string[]) =>
    api.put<{ files: ProductFileOwned[] }>(`/api/merchant/products/${enc(productId)}/files/order`, { ids }).then((d) => d.files),
};

/** The shopfront — /api/product-files/:slug/:productId (public; the download signed in). */
export const storefrontFilesApi = {
  list: (slug: string, productId: string) =>
    api.get<{ files: ProductFilePublic[] }>(`/api/product-files/${enc(slug)}/${enc(productId)}`).then((d) => d.files ?? []),
  viewerToken: (slug: string, productId: string, fileId: string) =>
    api.post<ViewerToken>(`/api/product-files/${enc(slug)}/${enc(productId)}/${enc(fileId)}/viewer-token`),
  /**
   * The download is a navigation, not a fetch: the server answers an
   * attachment, so the page points `<a href>` (or `window.location`) here and
   * the browser saves it. 401/403/404 arrive as a JSON body the anchor cannot
   * decode — check `list()`'s `downloadable` before offering the link.
   */
  downloadUrl: (slug: string, productId: string, fileId: string) =>
    `/api/product-files/${enc(slug)}/${enc(productId)}/${enc(fileId)}/download`,
};

/** A project's attachments — read with the post (`post.files`), minted and downloaded here. */
export const postFilesApi = {
  viewerToken: (postId: string, fileId: string) =>
    api.post<ViewerToken>(`/api/community/posts/${enc(postId)}/files/${enc(fileId)}/viewer-token`),
  /** Same navigation rule as the storefront download; offered only when `downloadable` (or the author). */
  downloadUrl: (postId: string, fileId: string) => `/api/community/posts/${enc(postId)}/files/${enc(fileId)}/download`,
};

/** The viewer page's own reads — /api/marketplace/print/viewer/:token (src/pages/ModelViewer.tsx). */
export const viewerHref = (token: string) => `/model-viewer/${enc(token)}`;

/** «2.4 MB» / «640 KB» — the size beside a file name. */
export function formatBytes(bytes: number, lang: 'ar' | 'en' | 'ckb' = 'ar'): string {
  const n = Number(bytes) || 0;
  const units = lang === 'en' ? ['B', 'KB', 'MB', 'GB'] : lang === 'ckb' ? ['بایت', 'کیلۆبایت', 'مێگابایت', 'گیگابایت'] : ['بايت', 'ك.ب', 'م.ب', 'غ.ب'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const num = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1);
  return `${num} ${units[i]}`;
}
