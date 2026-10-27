/**
 * EVERY REQUEST THE STUDIO MAKES, IN ONE PLACE — the SPA half of the HTTP
 * contract in packages/creativeDoc/src/api.ts (imported as types only, by
 * relative path: src/ may not import @levonis/* at run time,
 * tests/store-isolation.test.ts).
 *
 * The contract fixes the DTOs and the envelope (`{ success: true, ...dto }`);
 * this file fixes which route answers with which DTO. Where a body could
 * carry the DTO either spread (`{ success, ...DocumentDto }`) or under a
 * name (`{ success, document }`), `one()` accepts both and checks a field
 * the DTO must have — anything else is an INVALID_RESPONSE error, never a
 * guessed object. Lists come back under their plural name.
 *
 * Every call goes through src/lib/api.ts (cookies, deadline, ApiError with
 * the server’s code). AI calls carry their own deadline: a model answer can
 * take far longer than the 20 s default.
 */
import { api, ApiError } from '../../lib/api';
import type {
  AssetDto, AssetKind, BrandDto, BrandVersionDto, ClaimDto, ComposeRequest, ComposeResponse, DocStatus, DocumentDto,
  DocumentSummaryDto, EditRequest, EditResponse, ExportDto, ExportKind, IdeaRecordDto, IdeasRequest, IdeasResponse,
  ModelDto, OpportunityDto, ProductDetailDto, ProductListItemDto, ProviderStatusDto, ReviewRequest, ReviewResponse,
  UsageRecordDto, VerifyDto, VersionDto, VersionOrigin, BudgetSettings, Rates, Effort, ApproveRequest, ReviewDto,
} from '../../../packages/creativeDoc/src/api';
import type { BrandKit } from '../../../packages/creativeDoc/src/brand';
import type { CreativeDocument } from '../../../packages/creativeDoc/src/schema';
import type { ProductSnapshot } from '../../../packages/creativeDoc/src/snapshot';

/** Mirrors `CREATIVE_API` in the contract (a type-only import cannot carry the value). */
export const BASE = '/api/admin/creative-studio';

/** A model call may legitimately take this long; the server has its own deadline below it. */
export const AI_TIMEOUT_MS = 120000;
/** An upload of an exported PNG at 1080×1920 is a few MB on a phone network. */
const UPLOAD_TIMEOUT_MS = 90000;

type Body = Record<string, unknown>;

function invalid(what: string): ApiError {
  return new ApiError(0, `unexpected answer: ${what}`, 'INVALID_RESPONSE');
}

/** The DTO either under `key` or spread at the top level; `must` is a field it always has. */
export function one<T>(body: Body, key: string, must: string): T {
  const inner = body[key];
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && must in (inner as Body)) return inner as T;
  if (must in body) return body as unknown as T;
  throw invalid(key);
}

/** A list under its plural name; a missing list on an un-migrated database is empty, anything else is an error. */
export function list<T>(body: Body, key: string): T[] {
  const v = body[key];
  if (Array.isArray(v)) return v as T[];
  if (v === undefined && body.migrated === false) return [];
  throw invalid(key);
}

const q = (params: Record<string, string | number | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** A fresh idempotency key per user action (the server refuses a reused key with different content). */
export function idempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Provider (owner)
// ---------------------------------------------------------------------------

export const provider = {
  status: async (): Promise<ProviderStatusDto> => one<ProviderStatusDto>(await api.get<Body>(`${BASE}/provider`), 'provider_status', 'can_manage'),
  /** The key goes to the server in the request body and nowhere else; the answer carries only a hint. */
  saveKey: (key: string) => api.put<Body>(`${BASE}/provider/key`, { api_key: key }),
  removeKey: () => api.delete<Body>(`${BASE}/provider/key`),
  test: () => api.post<Body>(`${BASE}/provider/test`, {}, { timeoutMs: AI_TIMEOUT_MS }),
  models: async (): Promise<ModelDto[]> => list<ModelDto>(await api.get<Body>(`${BASE}/provider/models`, { timeoutMs: 45000 }), 'models'),
  saveSettings: (s: { model?: string | null; effort?: Effort | null; budget?: BudgetSettings; rates?: Rates | null; vision_review?: boolean }) =>
    api.put<Body>(`${BASE}/provider/settings`, s),
  /** The ledger (codes and counts, never text): GET /usage answers `{ records, days, today, month }`. */
  usage: async (): Promise<UsageRecordDto[]> => list<UsageRecordDto>(await api.get<Body>(`${BASE}/usage`), 'records'),
};

// ---------------------------------------------------------------------------
// Store (read-only) and snapshots
// ---------------------------------------------------------------------------

export const store = {
  search: async (text: string, signal?: AbortSignal): Promise<ProductListItemDto[]> =>
    list<ProductListItemDto>(await api.get<Body>(`${BASE}/products${q({ q: text, limit: 24 })}`, { signal }), 'products'),
  product: async (id: string): Promise<ProductDetailDto> => one<ProductDetailDto>(await api.get<Body>(`${BASE}/products/${encodeURIComponent(id)}`), 'product', 'variants'),
  snapshot: async (productId: string, variantKey: string | null): Promise<ProductSnapshot> =>
    one<ProductSnapshot>(await api.post<Body>(`${BASE}/snapshots`, { product_id: productId, variant_key: variantKey }), 'snapshot', 'hash'),
  getSnapshot: async (id: string): Promise<ProductSnapshot> => one<ProductSnapshot>(await api.get<Body>(`${BASE}/snapshots/${encodeURIComponent(id)}`), 'snapshot', 'hash'),
  verify: async (id: string): Promise<VerifyDto> => one<VerifyDto>(await api.post<Body>(`${BASE}/snapshots/${encodeURIComponent(id)}/verify`, {}), 'verify', 'changes'),
};

// ---------------------------------------------------------------------------
// Brand and claims
// ---------------------------------------------------------------------------

export const brand = {
  get: async (): Promise<BrandDto> => one<BrandDto>(await api.get<Body>(`${BASE}/brand`), 'brand', 'kit'),
  versions: async (): Promise<BrandVersionDto[]> => list<BrandVersionDto>(await api.get<Body>(`${BASE}/brand/versions`), 'versions'),
  saveVersion: (kit: BrandKit, note: string) => api.post<Body>(`${BASE}/brand/versions`, { kit, note }),
  approve: (version: number) => api.post<Body>(`${BASE}/brand/versions/${version}/approve`, {}),
  claims: async (): Promise<ClaimDto[]> => list<ClaimDto>(await api.get<Body>(`${BASE}/claims`), 'claims'),
};

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const assets = {
  list: async (kind?: AssetKind): Promise<AssetDto[]> => list<AssetDto>(await api.get<Body>(`${BASE}/assets${q({ kind })}`), 'assets'),
  upload: async (file: Blob, kind: AssetKind, label: string): Promise<AssetDto> => {
    const form = new FormData();
    form.set('file', file);
    form.set('kind', kind);
    form.set('label', label);
    return one<AssetDto>(await api.post<Body>(`${BASE}/assets`, form, { timeoutMs: UPLOAD_TIMEOUT_MS }), 'asset', 'review');
  },
  /** A reviewer's verdict: only approved assets are offered to designs and to Claude. */
  review: async (id: string, review: AssetDto['review'], note?: string): Promise<AssetDto> =>
    one<AssetDto>(await api.patch<Body>(`${BASE}/assets/${encodeURIComponent(id)}`, note === undefined ? { review } : { review, note }), 'asset', 'review'),
  remove: (id: string) => api.delete<Body>(`${BASE}/assets/${encodeURIComponent(id)}`),
};

/** The same-origin url the canvas draws a studio asset from (never a model-written URL). */
export function assetFileUrl(id: string): string {
  return `${BASE}/assets/${encodeURIComponent(id)}/file`;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentFilters {
  status?: DocStatus | '';
  format?: string;
  product_id?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SaveResult {
  version: number;
  updated_at: string | null;
}

function saveResultOf(body: Body): SaveResult {
  const doc = (body.document && typeof body.document === 'object' ? body.document : body) as Body;
  if (typeof doc.version !== 'number') throw invalid('version');
  return { version: doc.version, updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : null };
}

export const documents = {
  list: async (f: DocumentFilters = {}): Promise<{ documents: DocumentSummaryDto[]; migrated: boolean }> => {
    const body = await api.get<Body>(`${BASE}/documents${q({ ...f })}`);
    return { documents: list<DocumentSummaryDto>(body, 'documents'), migrated: body.migrated !== false };
  },
  get: async (id: string): Promise<DocumentDto> => one<DocumentDto>(await api.get<Body>(`${BASE}/documents/${encodeURIComponent(id)}`), 'document', 'content'),
  create: async (input: { title: string; content: CreativeDocument; kind?: 'post' | 'slide' | 'experiment'; parent_id?: string | null; origin?: VersionOrigin; job_id?: string | null }): Promise<DocumentDto> =>
    one<DocumentDto>(await api.post<Body>(`${BASE}/documents`, { kind: 'post', origin: 'template', parent_id: null, job_id: null, ...input }), 'document', 'content'),
  /** Version-fenced: a 409 VERSION_CONFLICT means someone saved after `base_version`, and nothing was written. */
  save: async (id: string, input: { content: CreativeDocument; base_version: number; origin: VersionOrigin; job_id?: string | null; change_summary?: string }): Promise<SaveResult> =>
    saveResultOf(await api.put<Body>(`${BASE}/documents/${encodeURIComponent(id)}`, { job_id: null, change_summary: '', ...input })),
  /** A rename: no new version, an approval stands. */
  rename: (id: string, title: string) => api.patch<Body>(`${BASE}/documents/${encodeURIComponent(id)}`, { title }),
  /** Draft / in review / archived, version-fenced like a save. */
  setStatus: async (id: string, status: Extract<DocStatus, 'draft' | 'in_review' | 'archived'>, baseVersion: number): Promise<SaveResult> =>
    saveResultOf(await api.post<Body>(`${BASE}/documents/${encodeURIComponent(id)}/status`, { status, base_version: baseVersion })),
  versions: async (id: string): Promise<VersionDto[]> => list<VersionDto>(await api.get<Body>(`${BASE}/documents/${encodeURIComponent(id)}/versions`), 'versions'),
  version: async (id: string, version: number): Promise<{ content: CreativeDocument }> => {
    const body = await api.get<Body>(`${BASE}/documents/${encodeURIComponent(id)}/versions/${version}`);
    const holder = (body.version && typeof body.version === 'object' && 'content' in (body.version as Body) ? body.version : body) as Body;
    if (!holder.content || typeof holder.content !== 'object') throw invalid('content');
    return { content: holder.content as CreativeDocument };
  },
  /** A restore is a new version on top of `baseVersion` (the version the archive was showing); bound data is re-verified before approval. */
  restore: async (id: string, version: number, baseVersion: number): Promise<SaveResult> =>
    saveResultOf(await api.post<Body>(`${BASE}/documents/${encodeURIComponent(id)}/restore`, { version, base_version: baseVersion })),
  approve: async (id: string, req: ApproveRequest): Promise<ReviewDto> => one<ReviewDto>(await api.post<Body>(`${BASE}/documents/${encodeURIComponent(id)}/approve`, req), 'review', 'decision'),
  exports: async (id: string): Promise<ExportDto[]> => list<ExportDto>(await api.get<Body>(`${BASE}/documents/${encodeURIComponent(id)}/exports`), 'exports'),
  /** Records an export the browser rendered; `final` is refused by the server unless the design is clean and verified. */
  uploadExport: async (id: string, input: { file: Blob; kind: ExportKind; version: number; final: boolean; width: number | null; height: number | null }): Promise<ExportDto> => {
    const form = new FormData();
    form.set('file', input.file);
    // The Worker reads the export's facts from ONE JSON field (POST /documents/:id/exports).
    form.set('meta', JSON.stringify({ version: input.version, kind: input.kind, final: input.final, width: input.width, height: input.height }));
    return one<ExportDto>(await api.post<Body>(`${BASE}/documents/${encodeURIComponent(id)}/exports`, form, { timeoutMs: UPLOAD_TIMEOUT_MS }), 'export', 'kind');
  },
};

// ---------------------------------------------------------------------------
// AI and jobs
// ---------------------------------------------------------------------------

export const ai = {
  opportunities: async (): Promise<OpportunityDto[]> => list<OpportunityDto>(await api.get<Body>(`${BASE}/opportunities`), 'opportunities'),
  ideas: async (req: IdeasRequest): Promise<IdeasResponse> => one<IdeasResponse>(await api.post<Body>(`${BASE}/ai/ideas`, req, { timeoutMs: AI_TIMEOUT_MS }), 'result', 'ideas'),
  savedIdeas: async (): Promise<IdeaRecordDto[]> => list<IdeaRecordDto>(await api.get<Body>(`${BASE}/ideas`), 'ideas'),
  compose: async (req: ComposeRequest): Promise<ComposeResponse> => one<ComposeResponse>(await api.post<Body>(`${BASE}/ai/compose`, req, { timeoutMs: AI_TIMEOUT_MS }), 'result', 'proposals'),
  edit: async (req: EditRequest, signal?: AbortSignal): Promise<EditResponse> => one<EditResponse>(await api.post<Body>(`${BASE}/ai/edit`, req, { timeoutMs: AI_TIMEOUT_MS, signal }), 'result', 'patch'),
  review: async (req: ReviewRequest): Promise<ReviewResponse> => one<ReviewResponse>(await api.post<Body>(`${BASE}/ai/review`, req, { timeoutMs: AI_TIMEOUT_MS }), 'result', 'notes'),
  cancel: (id: string) => api.post<Body>(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`, {}),
  /** Tells the server the owner applied this answer to `version` (a cancelled or stale job is refused there too). */
  applied: (id: string, documentId: string, version: number) => api.post<Body>(`${BASE}/jobs/${encodeURIComponent(id)}/applied`, { document_id: documentId, version }),
};
