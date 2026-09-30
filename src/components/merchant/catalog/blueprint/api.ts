/**
 * «التخصيص» — THE BUILDER'S DOORS, TYPED (worker/routes/merchantBlueprints.ts,
 * lane L5). Every door answers the same BuilderState, so the screen never
 * re-reads after a write. Everything here is the merchant's own: private,
 * no-store; the client sends ids and its own declarations, the server
 * normalises, checks the references (its parts, its materials, its printers)
 * and prices.
 *
 *   GET  /api/merchant/products/:id/blueprint           the state
 *   PUT  /api/merchant/products/:id/blueprint/model     {keys: 1–12 product_file keys}
 *   PUT  /api/merchant/products/:id/blueprint/draft     {spec, rev?}
 *   PUT  /api/merchant/products/:id/blueprint/look      {poster, idmap, quads, camera}
 *   POST /api/merchant/products/:id/blueprint/publish   {rev}
 *   POST /api/merchant/products/:id/blueprint/pause
 *
 * The door in the product editor reads the state with `api.get` itself (so
 * this file rides the builder's chunk, not the editor's); the types are free.
 */
import { api } from '../../../../lib/api';
import type { BlueprintSpec, PublicBlueprint, Vec3 } from '../../../../../packages/catalog/src/personalize/types';
import type { CompiledPart } from './model';
import type { LookBody } from './capture';

export interface RevisionOut {
  id: string;
  rev: number;
  state: 'draft' | 'live' | 'retired';
  /** The merchant's spec with its private notes; null for a draft whose spec was never saved (a model attached first). */
  spec: BlueprintSpec | null;
  mesh_state: 'none' | 'pending' | 'ready' | 'failed' | 'photo';
  /** `url` = the merchant's own full mesh of this revision (gzip, hidden parts included). */
  mesh: { url: string; public_url: string | null; hash: string | null; bytes: number | null; triangles: number | null; dims_mm: Vec3 | null } | null;
  look: { poster_url: string; w: number; h: number; idmap: string; quads: Record<string, unknown>; camera: number[] } | null;
  analysis: { format?: string; dims_mm?: Vec3; warnings?: string[]; hint?: string; triangles?: number };
  source_keys: string[];
  parts: CompiledPart[];
  from_iqd: number | null;
  published_at: string | null;
  retired_at: string | null;
  updated_at: string;
}

export interface BuilderState {
  product_id: string;
  draft: RevisionOut | null;
  live: RevisionOut | null;
  /** Newest first, at most 20 (`retired_more` when there are older ones). */
  retired: Array<{ id: string; rev: number; published_at: string | null; retired_at: string | null }>;
  retired_more: boolean;
  mesh_state: RevisionOut['mesh_state'];
  /** The current revision's compiled parts — their names are the merchant's file's. */
  parts: CompiledPart[];
  /** Machine words: MESH_FAILED, HINT_<hint>, the compile's warnings, NEEDS_SPEC | NEEDS_MESH | NEEDS_LOOK. */
  warnings: string[];
  suggestions: { roles: Array<{ n: number; role: string }>; grams: Record<string, number> };
  /** The studio's preview of the draft (or the live revision): the mesh through the merchant's own door. */
  preview: PublicBlueprint | null;
  limits: { max_triangles: number; max_blueprints_per_store: number; source_files: number };
}

const at = (productId: string, tail = '') => `/api/merchant/products/${encodeURIComponent(productId)}/blueprint${tail}`;

export const blueprintApi = {
  state: (productId: string) => api.get<BuilderState>(at(productId)),
  /** Compiled inline by the Worker (≈ 0.1 s for 60k triangles, plus the read of up to 40 MB). */
  model: (productId: string, keys: string[]) => api.put<BuilderState>(at(productId, '/model'), { keys }, { timeoutMs: 120_000 }),
  /** Autosave: silent, and `rev` names the revision being edited (a live one opens the next draft from it). */
  draft: (productId: string, spec: BlueprintSpec, rev: number | null) =>
    api.put<BuilderState>(at(productId, '/draft'), rev ? { spec, rev } : { spec }, { mascot: 'silent' }),
  look: (productId: string, body: LookBody) => api.put<BuilderState>(at(productId, '/look'), body, { timeoutMs: 60_000 }),
  publish: (productId: string, rev: number) => api.post<BuilderState>(at(productId, '/publish'), { rev }, { timeoutMs: 60_000 }),
  pause: (productId: string) => api.post<BuilderState>(at(productId, '/pause')),
};
