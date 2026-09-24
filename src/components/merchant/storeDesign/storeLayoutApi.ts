/**
 * The store page's draft, publish, history and restore — the client half of
 * worker/routes/storeLayout.ts. Every call is scoped by the server to the
 * signed-in merchant's own store; nothing here names a store.
 */
import { api } from '../../../lib/api';
import type { StoreLayout } from '../../../../packages/storeLayout/src/schema';
import type { LayoutIssue } from '../../../../packages/storeLayout/src/normalize';
import type { BlockData } from '../../../../packages/storeLayout/src/data';

export interface LayoutDraft {
  exists: boolean;
  /** 0 = no draft row yet: the next save creates it. */
  version: number;
  base_revision: number | null;
  updated_at?: string | null;
  layout: StoreLayout;
}

export interface LayoutRevision {
  id: string;
  revision: number;
  schema_version: number;
  published_at: string;
  note: string;
  restored_from: number | null;
  /** The one the storefront shows right now. */
  live: boolean;
}

export interface LayoutState {
  draft: LayoutDraft;
  published: { revision: number | null; id: string | null; published_at: string | null; layout: StoreLayout } | null;
  /** The draft differs from what visitors see. */
  dirty: boolean;
  revisions: LayoutRevision[];
  revision_count: number;
  limits: { max_revisions: number; max_blocks: number; max_bytes: number };
}

const BASE = '/api/merchant/store/layout';

export const storeLayoutApi = {
  get: () => api.get<LayoutState>(BASE),
  saveDraft: (layout: StoreLayout, version: number) =>
    api.put<{ draft: LayoutDraft; issues: LayoutIssue[] }>(`${BASE}/draft`, { layout, version }),
  publish: (version: number, note = '') =>
    api.post<{ published: { id: string; revision: number; published_at: string }; draft: LayoutDraft; issues: LayoutIssue[] }>(
      `${BASE}/publish`,
      note ? { version, note } : { version }
    ),
  revisions: (cursor?: number) =>
    api.get<{ revisions: LayoutRevision[]; next_cursor: number | null }>(`${BASE}/revisions${cursor ? `?cursor=${cursor}` : ''}`),
  restore: (revision: number, version: number, publish: boolean) =>
    api.post<{ restored_from: number; draft: LayoutDraft; published: { id: string; revision: number } | null; issues: LayoutIssue[] }>(
      `${BASE}/restore/${revision}`,
      { version, publish }
    ),
  preview: (revision?: number) =>
    api.get<{ source: string; layout: StoreLayout; blocks_data: BlockData }>(`${BASE}/preview${revision ? `?revision=${revision}` : ''}`),
};
