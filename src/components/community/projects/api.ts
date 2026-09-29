/**
 * THE PROJECTS' READS AND WRITES — /api/community/posts, /my-posts and
 * /creators/:username (worker/routes/communityPosts.ts).
 *
 * The shapes mirror the server's `postCard`; nothing here decides what a
 * visitor may see — the server's SELECT lists do. A post's pictures come back
 * as URLs; their storage keys are the author's alone and are returned only to
 * them (`media[].key`), because a key is what the editor sends back.
 */
import { api } from '../../../lib/api';

export const POST_KINDS = ['project', 'post', 'tutorial', 'timelapse', 'before_after'] as const;
export type PostKind = (typeof POST_KINDS)[number];
export type PostVisibility = 'public' | 'unlisted' | 'private';
export type PostState = 'draft' | 'published' | 'archived';

export interface CatalogueRef {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  url: string;
}

export interface PostAuthor {
  id: string;
  /** Null for an account that never chose one — its page is then unreachable. */
  username: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface PostMedia {
  id: string;
  kind: 'image' | 'video';
  url: string;
  /** The author's own view only. */
  key?: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
}

export interface PostCard {
  id: string;
  kind: PostKind;
  title: string;
  excerpt: string;
  cover: { url: string; kind: 'image' | 'video'; width: number | null; height: number | null } | null;
  media_count: number;
  author: PostAuthor;
  store: { id: string; slug: string; name: string; logoUrl: string | null; url: string } | null;
  product: { id: string; slug: string; name: string; name_ar: string; price_iqd: number; url: string } | null;
  printer: { name: string; product: CatalogueRef | null };
  material: { name: string; product: CatalogueRef | null };
  color: string;
  print_time_minutes: number | null;
  dimensions: Partial<Record<'x_mm' | 'y_mm' | 'z_mm', number>>;
  tags: string[];
  counts: { likes: number; comments: number; saves: number; views: number };
  state: PostState;
  visibility: PostVisibility;
  published_at: string | null;
  created_at: string;
  url: string;
}

export interface PrintSettings {
  layer_height_mm?: number;
  infill_percent?: number;
  nozzle_mm?: number;
  walls?: number;
  supports?: boolean;
  /** A slicer profile's name. */
  profile?: string;
}

export interface Post extends PostCard {
  body: string;
  media: PostMedia[];
  print_settings: PrintSettings;
  /** The author's own view only. */
  request_id?: string | null;
  community_order_id?: string | null;
  consent_status?: 'not_needed' | 'pending' | 'granted' | 'declined';
  hidden: { at: string; reason: string } | null;
  viewer: {
    mine: boolean;
    /** Set when the viewer is the customer whose part this is: their decision is due, or was given. */
    consent: 'pending' | 'granted' | 'declined' | null;
    can: { edit: boolean; publish: boolean; archive: boolean; delete: boolean };
  };
}

/** «مشاريعي» rows: the card plus what only the author sees. */
export interface MyPost extends PostCard {
  consent_status: 'not_needed' | 'pending' | 'granted' | 'declined';
  hidden: boolean;
}

export interface PostInput {
  title: string;
  body: string;
  kind: PostKind;
  visibility: PostVisibility;
  printer_product_id: string | null;
  printer_name: string;
  material_product_id: string | null;
  material: string;
  color: string;
  print_settings: PrintSettings;
  print_time_minutes: number | null;
  dimensions: Partial<Record<'x_mm' | 'y_mm' | 'z_mm', number>>;
  tags: string[];
  store_id: string | null;
  product_id: string | null;
  request_id: string | null;
  community_order_id: string | null;
  media: Array<{ key: string; kind: 'image' | 'video'; width: number | null; height: number | null; duration_s: number | null }>;
}

export interface Creator {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  bio: string;
  website: string;
  socials: Partial<Record<'instagram' | 'x' | 'tiktok' | 'facebook' | 'youtube', string>>;
  country: string | null;
  member_since: string;
  printers: string[];
  materials: string[];
  badges: { pro: boolean; premium: boolean; verified_merchant: boolean };
  stats: { projects: number; completed_jobs: number };
  /** The creator's store card, in the directory's own shape, when they run one. */
  store: Record<string, unknown> | null;
  viewer: { mine: boolean };
}

export interface PostFilters {
  q?: string;
  kind?: PostKind | '';
  author?: string;
  store?: string;
  product?: string;
  tag?: string;
}

export interface PostPage {
  posts: PostCard[];
  next: string | null;
  /** Counted on the first page only. */
  total: number | null;
}

function qs(filters: PostFilters, cursor: string | null, limit: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, String(v));
  if (cursor) p.set('cursor', cursor);
  p.set('limit', String(limit));
  return p.toString();
}

type RawPage = { posts: PostCard[]; next_cursor?: string | null; total?: number | null };

const toPage = (d: RawPage): PostPage => ({
  posts: Array.isArray(d.posts) ? d.posts : [],
  next: d.next_cursor ?? null,
  total: typeof d.total === 'number' ? d.total : null,
});

export const projectsApi = {
  list: (filters: PostFilters, cursor: string | null = null, limit = 18) =>
    api.get<RawPage>(`/api/community/posts?${qs(filters, cursor, limit)}`).then(toPage),
  trending: (limit = 12) => api.get<{ posts: PostCard[] }>(`/api/community/posts/trending?limit=${limit}`).then((d) => d.posts ?? []),
  get: (id: string) => api.get<{ post: Post }>(`/api/community/posts/${encodeURIComponent(id)}`).then((d) => d.post),
  mine: (cursor: string | null = null, limit = 24) =>
    api.get<{ posts: MyPost[]; next_cursor?: string | null }>(`/api/community/my-posts?${qs({}, cursor, limit)}`)
      .then((d) => ({ posts: d.posts ?? [], next: d.next_cursor ?? null })),
  create: (input: Partial<PostInput>) => api.post<{ post: Post }>('/api/community/posts', input).then((d) => d.post),
  update: (id: string, input: Partial<PostInput>) =>
    api.patch<{ post: Post }>(`/api/community/posts/${encodeURIComponent(id)}`, input).then((d) => d.post),
  publish: (id: string) => api.post<{ post: Post }>(`/api/community/posts/${encodeURIComponent(id)}/publish`).then((d) => d.post),
  archive: (id: string) => api.post<{ post: Post }>(`/api/community/posts/${encodeURIComponent(id)}/archive`).then((d) => d.post),
  restore: (id: string) => api.post<{ post: Post }>(`/api/community/posts/${encodeURIComponent(id)}/restore`).then((d) => d.post),
  remove: (id: string) => api.delete(`/api/community/posts/${encodeURIComponent(id)}`),
  consent: (id: string, decision: 'granted' | 'declined') =>
    api.post(`/api/community/posts/${encodeURIComponent(id)}/consent`, { decision }),
  creator: (username: string) => api.get<{ creator: Creator }>(`/api/community/creators/${encodeURIComponent(username)}`).then((d) => d.creator),
};

/** The in-app address of a project. */
export const projectHref = (id: string) => `/community/projects/${encodeURIComponent(id)}`;
/** The in-app address of a creator. */
export const creatorHref = (username: string) => `/u/${encodeURIComponent(username)}`;
