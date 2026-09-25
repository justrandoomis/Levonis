/**
 * WHAT A STORE VISITOR NEEDS FROM THE MERCHANT MODULE, AND NOTHING ELSE (W6).
 *
 * `lib/merchant.ts` holds every merchant, order, checkout and admin client —
 * ~9 KB that the workspace needs and a shopper never calls. The storefront
 * pages and blocks import these four from here, so a store visit downloads
 * this file instead of that one (tests/bundleBudget.test.ts measures both
 * closures). `lib/merchant.ts` re-exports them unchanged.
 */
import { api } from './api';
import type {
  DeliveryToGovernorate,
  MerchantProduct,
  MerchantStore,
  SavedProduct,
  ShowcaseItem,
  StoreDeliverySummary,
  StoreSection,
  StoreService,
} from './merchant';

export const storefrontApi = {
  resolve: () =>
    api.get<{ kind: string; store: MerchantStore | null; root_domain?: string | null }>('/api/storefront/resolve'),
  store: (slug: string) => api.get<{ store: MerchantStore }>(`/api/storefront/${slug}`),
  /** Legacy-link resolution: accepts a store id OR a merchant id (§57). */
  storeById: (id: string) => api.get<{ store: MerchantStore }>(`/api/storefront/by-id/${encodeURIComponent(id)}`),
  products: (slug: string, params = '') =>
    api.get<{ products: MerchantProduct[]; next_cursor: string | null }>(
      `/api/storefront/${slug}/products${params}`
    ),
  product: (slug: string, productSlug: string) =>
    api.get<{ product: MerchantProduct; store: MerchantStore }>(
      `/api/storefront/${slug}/products/${productSlug}`
    ),
  reviews: (slug: string) =>
    api.get<{
      average: number | null;
      count: number;
      distribution: Record<string, number>;
      reviews: Array<Record<string, unknown>>;
    }>(`/api/storefront/${slug}/reviews`),
  sections: (slug: string) => api.get<{ sections: StoreSection[] }>(`/api/storefront/${slug}/sections`),
  services: (slug: string) => api.get<{ services: StoreService[] }>(`/api/storefront/${slug}/services`),
  showcase: (slug: string) => api.get<{ items: ShowcaseItem[] }>(`/api/storefront/${slug}/showcase`),
  /** A preview of delivery to one governorate — or, signed in and without one, to the viewer's own address. */
  delivery: (slug: string, governorate = '') =>
    api.get<{ delivery: StoreDeliverySummary & { governorate: string | null; source: 'query' | 'address' | null; quote: DeliveryToGovernorate | null } }>(
      `/api/storefront/${slug}/delivery${governorate ? `?governorate=${encodeURIComponent(governorate)}` : ''}`
    ),
};

/** The storefront heart — per-user, so it lives outside /api/storefront. */
export const communityFavoritesApi = {
  list: () => api.get<{ items: SavedProduct[] }>('/api/community-favorites'),
  ids: () => api.get<{ product_ids: string[] }>('/api/community-favorites/ids'),
  add: (productId: string) => api.put<{ favorite: boolean }>(`/api/community-favorites/${productId}`),
  remove: (productId: string) => api.delete<{ favorite: boolean }>(`/api/community-favorites/${productId}`),
};

/** IQD, formatted the way the rest of the app formats it. */
export function iqd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${Number(n).toLocaleString('en-US')} IQD`;
}

/** Merchant badge label. Names are localised; the criteria are not negotiable. */
export function badgeLabel(
  badge: string,
  loc: (ar: string, en: string, ckb?: string) => string
): string {
  switch (badge) {
    case 'trusted':
      return loc('موثوق', 'Trusted', 'متمانەپێکراو');
    case 'professional':
      return loc('محترف', 'Professional', 'پیشەیی');
    case 'elite':
      return loc('نخبة', 'Elite', 'نخبە');
    case 'featured':
      return loc('مميّز', 'Featured', 'تایبەت');
    default:
      return loc('جديد', 'New', 'نوێ');
  }
}
