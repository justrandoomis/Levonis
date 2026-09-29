/**
 * THE SOCIAL GRAPH'S READS AND WRITES — likes, saves, comments, creator
 * follows, blocks, mutes, reports, the personal feed and the creators'
 * directory (worker/routes/communitySocial.ts, docs/COMMUNITY_ECOSYSTEM.md
 * Phase 2).
 *
 * The client sends ids and the server decides: every write here is
 * idempotent on the server, so a replayed like or follow changes nothing and
 * answers the same numbers, which is what lets the buttons be optimistic and
 * correct themselves from the reply. Nothing here decides what a viewer may
 * see — a draft cannot be liked by a stranger because the server says so.
 */
import { api } from '../../../lib/api';
import type { PostCard } from '../projects/api';

export { creatorHref, projectHref } from '../projects/api';
export type { PostCard } from '../projects/api';

export interface CommentAuthor {
  id: string;
  /** Null when their creator page is closed (the card never links to a 404). */
  username: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface Comment {
  id: string;
  post_id: string;
  parent_id: string | null;
  body: string;
  /** A `removed` row comes back as a stub with an empty body, so replies keep their place. */
  state: 'visible' | 'removed' | 'hidden';
  created_at: string;
  author: CommentAuthor;
  viewer: { mine: boolean; can_remove: boolean };
  /** Set by the client while the send is in flight. */
  pending?: boolean;
}

export interface CommentPage {
  comments: Comment[];
  next: string | null;
  total: number;
}

export interface CreatorCard {
  id: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  bio: string;
  badges: { pro: boolean; premium: boolean; verified_merchant: boolean };
  stats: { projects: number; followers: number };
  store: { id: string; slug: string; name: string; url: string } | null;
  viewer: { following: boolean };
}

export interface CreatorPage {
  creators: CreatorCard[];
  next: string | null;
  total: number | null;
}

/** The viewer's own graph, once per session: what the cards need to draw their state. */
export interface SocialMe {
  following_users: string[];
  following_stores: string[];
  blocked: string[];
  muted: string[];
}

export type FeedScope = 'foryou' | 'following';

export const REPORT_TARGETS = ['post', 'comment', 'user', 'store', 'product', 'request'] as const;
export type ReportTarget = (typeof REPORT_TARGETS)[number];
export const REPORT_REASONS = ['spam', 'abuse', 'nudity', 'fraud', 'copyright', 'offtopic', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportInput {
  target_type: ReportTarget;
  target_id: string;
  reason: ReportReason;
  details?: string;
}

export interface CreatorFilters {
  q?: string;
  featured?: boolean;
}

export interface PostPage {
  posts: PostCard[];
  next: string | null;
}

const enc = encodeURIComponent;

function paged(cursor: string | null | undefined, limit: number | undefined, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams(extra);
  if (cursor) p.set('cursor', cursor);
  if (limit) p.set('limit', String(limit));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const toPosts = (d: { posts?: PostCard[]; next_cursor?: string | null }): PostPage => ({
  posts: Array.isArray(d.posts) ? d.posts : [],
  next: d.next_cursor ?? null,
});

export const socialApi = {
  // ---- likes and saves ----------------------------------------------------
  like: (postId: string) => api.put<{ liked: boolean; likes: number }>(`/api/community/posts/${enc(postId)}/like`),
  unlike: (postId: string) => api.delete<{ liked: boolean; likes: number }>(`/api/community/posts/${enc(postId)}/like`),
  save: (postId: string, collection?: string) =>
    api.put<{ saved: boolean; saves: number }>(`/api/community/posts/${enc(postId)}/save`, collection ? { collection } : {}),
  unsave: (postId: string) => api.delete<{ saved: boolean; saves: number }>(`/api/community/posts/${enc(postId)}/save`),
  saved: (cursor: string | null = null, limit = 18) =>
    api.get<{ posts: PostCard[]; next_cursor?: string | null }>(`/api/community/saved${paged(cursor, limit)}`).then(toPosts),

  // ---- comments -----------------------------------------------------------
  comments: (postId: string, cursor: string | null = null, limit = 20) =>
    api
      .get<{ comments: Comment[]; next_cursor?: string | null; total?: number }>(`/api/community/posts/${enc(postId)}/comments${paged(cursor, limit)}`)
      .then((d): CommentPage => ({
        comments: Array.isArray(d.comments) ? d.comments : [],
        next: d.next_cursor ?? null,
        total: typeof d.total === 'number' ? d.total : 0,
      })),
  addComment: (postId: string, input: { body: string; parent_id?: string | null; client_id?: string }) =>
    api.post<{ comment: Comment; replayed?: boolean }>(`/api/community/posts/${enc(postId)}/comments`, {
      body: input.body,
      ...(input.parent_id ? { parent_id: input.parent_id } : {}),
      ...(input.client_id ? { client_id: input.client_id } : {}),
    }),
  removeComment: (id: string) => api.delete(`/api/community/comments/${enc(id)}`),

  // ---- people -------------------------------------------------------------
  follow: (userId: string) => api.put<{ following: boolean; followers: number }>(`/api/community/users/${enc(userId)}/follow`),
  unfollow: (userId: string) => api.delete<{ following: boolean; followers: number }>(`/api/community/users/${enc(userId)}/follow`),
  block: (userId: string) => api.put<{ blocked: boolean }>(`/api/community/users/${enc(userId)}/block`),
  unblock: (userId: string) => api.delete<{ blocked: boolean }>(`/api/community/users/${enc(userId)}/block`),
  mute: (userId: string) => api.put<{ muted: boolean }>(`/api/community/users/${enc(userId)}/mute`),
  unmute: (userId: string) => api.delete<{ muted: boolean }>(`/api/community/users/${enc(userId)}/mute`),
  me: () =>
    api.get<Partial<SocialMe>>('/api/community/me/social').then(
      (d): SocialMe => ({
        following_users: Array.isArray(d.following_users) ? d.following_users : [],
        following_stores: Array.isArray(d.following_stores) ? d.following_stores : [],
        blocked: Array.isArray(d.blocked) ? d.blocked : [],
        muted: Array.isArray(d.muted) ? d.muted : [],
      })
    ),

  // ---- reports ------------------------------------------------------------
  report: (input: ReportInput) => api.post<{ report_id: string; replayed?: boolean }>('/api/community/reports', input),

  // ---- lists --------------------------------------------------------------
  feed: (scope: FeedScope, cursor: string | null = null, limit = 12) =>
    api.get<{ posts: PostCard[]; next_cursor?: string | null }>(`/api/community/feed${paged(cursor, limit, { scope })}`).then(toPosts),
  creators: (filters: CreatorFilters = {}, cursor: string | null = null, limit = 18) => {
    const extra: Record<string, string> = {};
    if (filters.q) extra.q = filters.q;
    if (filters.featured) extra.featured = '1';
    return api
      .get<{ creators: CreatorCard[]; next_cursor?: string | null; total?: number | null }>(`/api/community/creators${paged(cursor, limit, extra)}`)
      .then((d): CreatorPage => ({
        creators: Array.isArray(d.creators) ? d.creators : [],
        next: d.next_cursor ?? null,
        total: typeof d.total === 'number' ? d.total : null,
      }));
  },
};

/** A stable id for one send, so a retried comment is the same comment (`client_id`). */
export function clientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now()}${Math.random().toString(16).slice(2)}`;
}
