/**
 * THE COMMUNITY PAGE'S READS — /api/community/{products,merchants,requests,works}.
 *
 * Every list is a page at a time (`next_cursor`), searchable on the server
 * (`q`), and carries its `total` on the first page so «عرض المزيد» can say how
 * many are left. The shapes mirror worker/routes/community.ts; nothing here
 * decides what a visitor may see — the server's SELECT lists do.
 */
import { api } from '../../../lib/api';

export interface StoreRef {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  /** The shop's own address (a subdomain), or its in-site page. */
  url: string;
}

export interface CommunityProduct {
  id: string;
  slug: string;
  merchant_id: string;
  name: string;
  name_ar: string;
  description: string;
  description_ar?: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  created_at: string;
  /** In stock or not — never a count. Null for a pre-store listing. */
  in_stock?: boolean | null;
  /** The page the product can be bought on. */
  url?: string;
  store?: StoreRef | null;
}

export interface CommunityStore {
  id: string;
  user_id: string;
  name: string;
  bio: string;
  avatarUrl: string | null;
  verified: boolean;
  pro_badge?: boolean;
  premium_badge?: boolean;
  created_at: string;
  store_slug?: string | null;
  store_url?: string | null;
  store_name?: string | null;
  tagline?: string;
  logoUrl?: string | null;
  governorate?: string;
  accepts_custom_requests?: boolean;
  badge?: string;
  rating?: number | null;
  rating_count?: number;
  completed_orders?: number;
  followers?: number;
  product_count?: number;
  following?: boolean;
}

export interface CommunityRequest {
  id: string;
  title: string;
  description: string;
  category?: string;
  quantity?: number;
  material?: string;
  color?: string;
  budget_iqd?: number | null;
  deadline?: string | null;
  governorate?: string;
  state?: string;
  offer_count?: number;
  file_count?: number;
  created_at: string;
  expires_at?: string | null;
}

export interface CommunityWork {
  id: string;
  title: string;
  details: string;
  imageUrl: string | null;
  store: StoreRef;
}

export interface Page<T> {
  rows: T[];
  next: string | null;
  /** Counted on the first page only. */
  total: number | null;
}

/**
 * The lists the home pages through `useCommunityFeed`: the three directories,
 * the two feeds (Phase 2, /api/community/feed) and the makers' directory.
 */
export type FeedKind = 'products' | 'merchants' | 'requests' | 'creators' | 'feed:foryou' | 'feed:following';

function query(q: string, cursor: string | null, limit: number): string {
  const p = new URLSearchParams();
  if (q) p.set('q', q);
  if (cursor) p.set('cursor', cursor);
  p.set('limit', String(limit));
  return p.toString();
}

type Raw<K extends string, T> = { [key in K]: T[] } & { next_cursor?: string | null; total?: number | null };

async function page<K extends string, T>(path: string, key: K, q: string, cursor: string | null, limit: number): Promise<Page<T>> {
  const d = await api.get<Raw<K, T>>(`${path}?${query(q, cursor, limit)}`);
  return { rows: Array.isArray(d[key]) ? d[key] : [], next: d.next_cursor ?? null, total: typeof d.total === 'number' ? d.total : null };
}

export const communityHubApi = {
  products: (q: string, cursor: string | null) =>
    page<'products', CommunityProduct>('/api/community/products', 'products', q, cursor, 24),
  merchants: (q: string, cursor: string | null) =>
    page<'merchants', CommunityStore>('/api/community/merchants', 'merchants', q, cursor, 24),
  requests: (q: string, cursor: string | null) =>
    page<'requests', CommunityRequest>('/api/community/requests', 'requests', q, cursor, 20),
  works: () => api.get<{ works: CommunityWork[] }>('/api/community/works?limit=12').then((d) => d.works ?? []),
  /** The home's short first pages — a rail or three rows, never a directory. */
  few: {
    products: (limit: number) => page<'products', CommunityProduct>('/api/community/products', 'products', '', null, limit),
    merchants: (limit: number) => page<'merchants', CommunityStore>('/api/community/merchants', 'merchants', '', null, limit),
    requests: (limit: number) => page<'requests', CommunityRequest>('/api/community/requests', 'requests', '', null, limit),
  },
  follow: (merchantId: string) => api.post(`/api/community/store/${encodeURIComponent(merchantId)}/follow`),
  unfollow: (merchantId: string) => api.delete(`/api/community/store/${encodeURIComponent(merchantId)}/follow`),
};

/** An address on another origin — a shop's own subdomain. */
export function isExternal(href: string): boolean {
  if (!/^https?:\/\//.test(href)) return false;
  try {
    return new URL(href).origin !== window.location.origin;
  } catch {
    return false;
  }
}
