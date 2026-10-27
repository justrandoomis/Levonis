/**
 * THE HTTP CONTRACT between the Worker (`worker/routes/adminCreativeStudio.ts`)
 * and the studio SPA (`src/components/creativeStudio/`). One file, imported by
 * both (the SPA imports it by relative path, `import type` only).
 *
 * Mount: `/api/admin/creative-studio` (apex host only, like every admin router).
 * Bodies are `{ success: true, ...dto }` or `{ success: false, error, code, details? }`.
 *
 * ROLES (spec §32, adapted to the repository's model):
 *   owner           the verified owner (INITIAL_ADMIN_EMAIL): provider key, model,
 *                   budget, rates, brand-kit versions and approval, service claims
 *   full admin      designer + reviewer: documents, AI requests, exports, approval
 *   assistant admin refused (403 CREATIVE_SCOPE_REQUIRED) — no studio access yet
 * Every check is on the server; the SPA only hides what it cannot use.
 *
 * DEPLOY-AHEAD (CLAUDE.md rule 2): every read tolerates a database without the
 * studio tables — list reads answer 200 `{ migrated: false, ... }` with empty
 * data, item reads answer 404; writes answer 503 CREATIVE_SCHEMA_MISSING.
 */
import type { ChatIdea, Idea, Proposal, ReviewNote, CarouselSlidePlan, EditPatch } from './aiContracts';
import type { BrandKit } from './brand';
import type { DocIssue } from './normalize';
import type { QualityReport } from './quality';
import type { Annotation, CreativeDocument, DocFormat, Objective, VisualPriority, Density } from './schema';
import type { Localized, ProductSnapshot, ProductSnapshotData, SnapshotAvailability, SnapshotChange, SnapshotImage, SnapshotPrice, PriceStatus } from './snapshot';
import type { TemplateId, VariantId, FamilyId } from './templates';

export const CREATIVE_API = '/api/admin/creative-studio';

export type ErrorCode =
  | 'CREATIVE_SCHEMA_MISSING' | 'CREATIVE_SCOPE_REQUIRED' | 'OWNER_ONLY' | 'OWNER_EMAIL_UNVERIFIED' | 'FRESH_SESSION_REQUIRED'
  | 'NOT_FOUND' | 'INVALID_INPUT' | 'INVALID_DOCUMENT' | 'VERSION_CONFLICT' | 'STALE_VERSION' | 'IDEMPOTENCY_KEY_REUSED'
  | 'KEY_NOT_CONFIGURED' | 'ENCRYPTION_NOT_CONFIGURED' | 'MODEL_NOT_SELECTED' | 'BUDGET_EXCEEDED' | 'PARALLEL_LIMIT'
  | 'KEY_REJECTED' | 'MODEL_GONE' | 'PROVIDER_RATE_LIMITED' | 'PROVIDER_OVERLOADED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_ERROR'
  | 'PROVIDER_REFUSED' | 'OUTPUT_TRUNCATED' | 'INVALID_OUTPUT' | 'JOB_CANCELLED' | 'JOB_ALREADY_APPLIED'
  | 'SOURCE_CHANGED' | 'QA_BLOCKERS' | 'APPROVAL_STALE' | 'UNSUPPORTED_MEDIA' | 'FILE_TOO_LARGE' | 'ASSET_IN_USE' | 'RATE_LIMITED'
  // Added with the Worker (DECISIONS row 270): the repository's own fresh-sign-in refusal (worker/lib/costAccess.ts
  // `requireFreshSession` answers 401 REAUTH_REQUIRED — the code every owner screen already handles), visual review
  // switched off by the owner or unsupported by the chosen model, no private bucket on the deployment, and the same
  // idempotent AI request still running.
  | 'REAUTH_REQUIRED' | 'VISION_REVIEW_DISABLED' | 'STORAGE_UNAVAILABLE' | 'JOB_IN_PROGRESS'
  // A job whose Worker died mid-call: settled at its worst case by the next AI request's sweep (worker/lib/creative/ai.ts).
  | 'INTERRUPTED';

// ---------------------------------------------------------------------------
// Provider (owner)
// ---------------------------------------------------------------------------

export type Effort = 'low' | 'medium' | 'high';

export interface BudgetSettings {
  /** Hard caps, enforced on the server with a reservation before every call. */
  daily_requests: number;
  daily_tokens: number;
  /** USD caps apply only when rates are set (no rates → token and request caps only). */
  daily_usd: number | null;
  monthly_usd: number | null;
  /** Concurrent AI calls per studio (batch create obeys it too). */
  max_parallel: number;
  /** Automatic fix rounds after a quality check (spec §23: default 2). */
  auto_fix_rounds: number;
}

export interface Rates {
  input_per_mtok_usd: number;
  output_per_mtok_usd: number;
  /** Where the owner took the numbers from, and when — costs are always labelled ESTIMATED. */
  source: string;
  as_of: string;
}

export interface UsageTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  /** Estimated from the owner's rates; null when no rates are set. Never billing data. */
  est_cost_usd: number | null;
}

export interface ProviderStatusDto {
  migrated: boolean;
  provider: 'anthropic';
  /** `stored`: the owner's key, encrypted in D1. `worker_secret`: the Worker secret ANTHROPIC_API_KEY. */
  key: { source: 'stored' | 'worker_secret' | 'none'; hint: string | null; set_at: string | null };
  /** CREATIVE_STUDIO_ENC_KEY is set and a seal/unseal round trip works — required to store a key. */
  encryption_ready: boolean;
  /** The owner's choice from the live model list (never a default written in the repository). */
  model: string | null;
  effort: Effort | null;
  last_test: { ok: boolean; at: string; code: string | null } | null;
  capabilities: { structured_outputs: boolean | null; vision: boolean | null; effort: boolean | null };
  budget: BudgetSettings;
  rates: Rates | null;
  vision_review: boolean;
  today: UsageTotals;
  month: UsageTotals;
  /** True for the owner: the settings page is editable. */
  can_manage: boolean;
  /** AI requests can be made now (key + model + budget left). */
  ready: boolean;
  /** Why not, when not ready. */
  not_ready_code: ErrorCode | null;
  /** The owner's own priorities (PUT /provider/settings `priorities`), never the opportunity kinds. Absent from a Worker that predates it. */
  priorities?: string[];
}

export interface ModelDto {
  id: string;
  display_name: string;
  created_at: string | null;
  structured_outputs: boolean | null;
  vision: boolean | null;
  effort: boolean | null;
}

export interface UsageRecordDto {
  id: string;
  created_at: string;
  task: AiTask;
  model: string | null;
  status: 'ok' | 'error' | 'cancelled' | 'refused';
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  est_cost_usd: number | null;
  actor_name: string | null;
  document_id: string | null;
}

// ---------------------------------------------------------------------------
// Store (read-only)
// ---------------------------------------------------------------------------

export interface ProductListItemDto {
  id: string;
  slug: string;
  name: Localized;
  brand: Localized | null;
  image: { url: string; same_origin: boolean; width: number | null; height: number | null } | null;
  price_status: PriceStatus;
  display_price_iqd: number | null;
  availability: SnapshotAvailability;
  has_variants: boolean;
  category_id: string | null;
}

export interface ProductVariantDto {
  key: string;
  label: Localized;
  images: SnapshotImage[];
  price: SnapshotPrice;
  availability: SnapshotAvailability;
}

export interface ProductDetailDto {
  id: string;
  slug: string;
  path: string;
  name: Localized;
  brand: Localized | null;
  category: Localized | null;
  images: SnapshotImage[];
  price: SnapshotPrice;
  availability: SnapshotAvailability;
  variants: ProductVariantDto[];
  specs: ProductSnapshotData['specs'];
  contents: ProductSnapshotData['contents'];
}

export interface VerifyDto {
  snapshot_id: string;
  fresh: ProductSnapshot | null;
  changes: SnapshotChange[];
}

// ---------------------------------------------------------------------------
// Brand and claims
// ---------------------------------------------------------------------------

export interface BrandDto {
  migrated: boolean;
  /** null = no saved version yet: the default kit, pending the owner's approval. */
  version: number | null;
  status: 'default' | 'pending' | 'approved';
  kit: BrandKit;
  /** The site logo's natural size (src/lib/siteLogo.ts serves the file). */
  site_logo: { width: number; height: number };
}

export interface BrandVersionDto {
  version: number;
  status: 'pending' | 'approved';
  note: string;
  created_at: string;
  created_by_name: string | null;
  approved_at: string | null;
}

export interface ClaimDto {
  id: string;
  key: string;
  version: number;
  status: 'pending' | 'approved' | 'retired';
  title: Localized;
  summary: Localized;
  conditions: Localized;
  details_path: string | null;
  product_ids: string[];
  valid_from: string | null;
  valid_until: string | null;
  last_verified_at: string | null;
  source_note: string;
  approved_at: string | null;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type AssetKind = 'logo' | 'background' | 'reference_liked' | 'reference_rejected' | 'product_extra' | 'icon' | 'element';

export interface AssetDto {
  id: string;
  kind: AssetKind;
  label: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  /** spec §38: original catalogue picture / uploaded by a person / generated / derived. */
  provenance: 'uploaded' | 'catalog' | 'generated' | 'derived';
  derived_from: string | null;
  product_id: string | null;
  review: 'approved' | 'needs_review' | 'rejected';
  note: string;
  created_at: string;
  /** Same-origin url the editor draws (`/api/admin/creative-studio/assets/<id>/file`). */
  url: string;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocStatus = 'idea' | 'draft' | 'in_review' | 'approved' | 'scheduled' | 'published' | 'archived' | 'failed';
export type DocKind = 'post' | 'slide' | 'experiment';
export type VersionOrigin = 'manual' | 'ai' | 'template' | 'restore' | 'relayout' | 'import';

export interface DocumentSummaryDto {
  id: string;
  title: string;
  status: DocStatus;
  kind: DocKind;
  format: DocFormat;
  product_id: string | null;
  product_name: Localized | null;
  template_id: string | null;
  version: number;
  approved_version: number | null;
  /** Why an approved design needs review again (price changed, claim changed…); empty when it does not. */
  needs_review: string[];
  campaign_id: string | null;
  parent_id: string | null;
  updated_at: string;
  created_at: string;
  /** The latest export's id, for a thumbnail. */
  thumb_export_id: string | null;
}

export interface DocumentDto extends DocumentSummaryDto {
  content: CreativeDocument;
  brand_version: number | null;
  /**
   * The kit of the brand version this design is pinned to (`brand_version`;
   * the kit in force when that version is gone). Bound text is rendered with
   * it — the same kit the Worker's checks use — never with a newer kit.
   * Absent from a Worker that predates it.
   */
  brand_kit?: BrandKit;
  updated_by_name: string | null;
  /** Normaliser issues found when the stored content was read (non-fatal; fatal content is never stored). */
  issues: DocIssue[];
}

export interface VersionDto {
  version: number;
  origin: VersionOrigin;
  change_summary: string;
  created_at: string;
  created_by_name: string | null;
  job_id: string | null;
}

export type RejectReason = 'product_small' | 'crowded' | 'text_long' | 'background_off' | 'wrong_variant_image' | 'unclear' | 'other';

export interface ReviewDto {
  id: string;
  version: number;
  decision: 'approved' | 'rejected';
  reasons: RejectReason[];
  note: string;
  brand_version: number | null;
  export_ids: string[];
  actor_name: string | null;
  created_at: string;
  invalidated_at: string | null;
  invalidated_reason: string | null;
}

export type ExportKind = 'png' | 'jpeg' | 'webp' | 'project_json' | 'background';

export interface ExportDto {
  id: string;
  document_id: string;
  version: number;
  kind: ExportKind;
  width: number | null;
  height: number | null;
  bytes: number;
  final: boolean;
  /** The server's re-verification of the bound data at export time. */
  source_check: 'fresh' | 'changed' | 'unverified' | 'none';
  created_at: string;
  url: string;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/**
 * `chat`: the free conversation on Home. Its job and usage rows are STORED under `ideas` (the 0216 CHECK lists
 * the six tasks above it and is not widened in place — worker/lib/creative/jobs.ts `storedTask`), so a design
 * made from a chat idea links that job exactly like an ideas answer.
 */
export type AiTask = 'test' | 'ideas' | 'compose' | 'edit' | 'review' | 'carousel' | 'chat';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobDto {
  id: string;
  task: AiTask;
  status: JobStatus;
  document_id: string | null;
  base_version: number | null;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
  applied_at: string | null;
}

export interface AiUsageDto {
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number | null;
  model: string;
}

/** Deterministic evidence for «شنو أنشر اليوم؟» — computed from the studio's own records, shown with or without AI. */
export interface OpportunityDto {
  id: string;
  kind: 'arrival' | 'back_in_stock' | 'offer' | 'coverage_gap' | 'service_claim' | 'owner_priority' | 'education_topic' | 'history';
  ref: string;
  label: Localized;
  detail: string;
  detected_at: string | null;
}

export interface IdeaRecordDto extends Idea {
  id: string;
  status: 'new' | 'used' | 'dismissed';
  job_id: string;
  created_at: string;
}

export interface IdeasRequest { count: number; priorities: string[]; idempotency_key: string }
export interface IdeasResponse { job_id: string; ideas: IdeaRecordDto[]; rejected: number; notes: string[]; usage: AiUsageDto }

/** One turn of the Home conversation; the client keeps the history and sends the last CHAT_LIMITS.turns of it. */
export interface ChatTurn { role: 'user' | 'assistant'; text: string }
export interface ChatRequest { messages: ChatTurn[]; idempotency_key: string }
export interface ChatResponse { job_id: string; reply: string; suggested_ideas: ChatIdea[]; dropped: number; usage: AiUsageDto }

export interface ComposeRequest {
  /** A product snapshot (product posts) or an approved claim (service posts). */
  snapshot_id: string | null;
  claim_id: string | null;
  objective: Objective;
  priority: VisualPriority;
  density: Density;
  template: TemplateId;
  family: FamilyId | null;
  variants: VariantId[];
  locale: 'ar' | 'en';
  /** The owner's own words about this post (optional). */
  brief: string;
  idempotency_key: string;
}
export interface ComposeResponse { job_id: string; proposals: Proposal[]; rejected: number; warnings: string[]; missing: string[]; usage: AiUsageDto }

export interface EditRequest {
  document_id: string;
  base_version: number;
  instruction: string;
  /** Selected / pointed-at layers; null = the owner asked for a design-wide change. */
  scope_ids: string[] | null;
  annotations: Annotation[];
  idempotency_key: string;
}
export interface EditResponse {
  job_id: string;
  /** The validated patch; the editor previews it and applies it locally after the owner confirms. */
  patch: EditPatch;
  usage: AiUsageDto;
}

export interface ReviewRequest { document_id: string; version: number; image_base64: string; idempotency_key: string }
export interface ReviewResponse { job_id: string; notes: ReviewNote[]; summary: string; usage: AiUsageDto }

export interface CarouselRequest { snapshot_id: string | null; claim_id: string | null; topic: string; slides: number; locale: 'ar' | 'en'; idempotency_key: string }
export interface CarouselResponse { job_id: string; slides: CarouselSlidePlan[]; caption: string; rejected: number; usage: AiUsageDto }

export interface ApproveRequest {
  version: number;
  /** The editor's full report (text fit, fonts and assets are measured in the browser); the server re-runs every check it can. */
  qa: QualityReport;
  export_ids: string[];
}

// ---------------------------------------------------------------------------
// Response envelopes — what each endpoint answers (worker/routes/adminCreativeStudio.ts).
// Every success is `{ success: true, ...<the type below> }`; every refusal is
// `{ success: false, error, code: ErrorCode, details? }`. A list read on a
// database without the studio tables answers its envelope with `migrated: false`
// and empty data; an item read answers 404.
// ---------------------------------------------------------------------------

/** GET /provider, PUT|DELETE /provider/key, PUT /provider/settings. */
export type ProviderResponse = ProviderStatusDto;
/** POST /provider/test — the status after the test, and the test's own outcome. */
export interface ProviderTestResponse extends ProviderStatusDto { test: { ok: boolean; code: ErrorCode | null } }
/** GET /provider/models (owner). */
export interface ModelsResponse { models: ModelDto[] }
/** PUT /provider/settings body (owner); every field optional, absent = unchanged; `model: null` clears the choice. */
export interface ProviderSettingsRequest {
  model?: string | null;
  effort?: Effort | null;
  budget?: Partial<BudgetSettings>;
  rates?: Rates | null;
  vision_review?: boolean;
  priorities?: string[];
}

export interface UsageDayDto { day: string; requests: number; tokens_used: number; est_cost_usd: number | null }
/** GET /usage?days=1..90 — the ledger (no text, no key) and per-day totals (Asia/Baghdad days). */
export interface UsageResponse { migrated: boolean; records: UsageRecordDto[]; days: UsageDayDto[]; today: UsageTotals; month: UsageTotals }

/** GET /products?q=&category=&limit=&offset= — the storefront listing as a guest sees it. */
export interface ProductsResponse { products: ProductListItemDto[]; total: number | null }
/** GET /products/:id */
export type ProductResponse = ProductDetailDto;
/** POST /snapshots, POST /snapshots/import, GET /snapshots/:id */
export type SnapshotResponse = ProductSnapshot;
/** POST /snapshots/:id/verify — `fresh` is stored as a NEW live snapshot (bind to it after review). */
export type VerifyResponse = VerifyDto;

/** GET /brand */
export type BrandResponse = BrandDto;
/** GET /brand/versions */
export interface BrandVersionsResponse { migrated: boolean; versions: BrandVersionDto[] }
/** GET /brand/versions/:version — one version and its kit (a pending version can be viewed before approval). */
export interface BrandVersionResponse { version: BrandVersionDto; kit: BrandKit }
/** POST /brand/versions, POST /brand/versions/:version/approve — the saved version and the kit now in force. */
export interface BrandSaveResponse { saved: BrandVersionDto; brand: BrandDto }

/** GET /claims — per claim, its approved version and a newer pending one. */
export interface ClaimsResponse { migrated: boolean; claims: ClaimDto[] }
/** POST /claims, PUT /claims/:id, POST /claims/:id/approve (`marked`: designs now needing review). */
export interface ClaimResponse { claim: ClaimDto; marked?: number }
/** GET /claims/:id/documents */
export interface ClaimDocumentsResponse { documents: DocumentSummaryDto[] }

/** GET /assets?kind= */
export interface AssetsResponse { migrated: boolean; assets: AssetDto[] }
/** POST /assets (multipart: file, kind, label?, note?, product_id?), PATCH /assets/:id {review, note?}, DELETE /assets/:id */
export interface AssetResponse { asset: AssetDto }

/** GET /documents?status=&product_id=&format=&campaign_id=&kind=&q=&from=&to=&limit=&offset= */
export interface DocumentsResponse { migrated: boolean; documents: DocumentSummaryDto[]; total: number; limit: number; offset: number }
/**
 * POST /documents {title, content, kind?, parent_id?, campaign_id?, idempotency_key?, origin?, job_id?} —
 * `origin` 'ai' needs `job_id`: a succeeded, unapplied, uncancelled job of this
 * actor, marked applied to version 1 in the same write.
 * GET|PUT|PATCH /documents/:id (PATCH = rename only, no new version), POST …/restore, …/duplicate, …/status
 */
export interface DocumentResponse { document: DocumentDto }
/** GET /documents/:id/versions */
export interface VersionsResponse { versions: VersionDto[] }
/** GET /documents/:id/versions/:version */
export interface VersionContentResponse { version: VersionDto; content: CreativeDocument; issues: DocIssue[] }
/** POST /documents/:id/approve — `qa` is the SERVER's report (the checks the Worker re-ran). */
export interface ApproveResponse { document: DocumentDto; review: ReviewDto; qa: QualityReport }
/** POST /documents/:id/reject {reasons: RejectReason[], note} */
export interface RejectResponse { document: DocumentDto; review: ReviewDto }
/** GET /documents/:id/reviews */
export interface ReviewsResponse { reviews: ReviewDto[] }
/** POST /documents/:id/exports (multipart: file + meta = JSON {version, kind, final, width, height}) */
export interface ExportResponse { export: ExportDto }
/** GET /documents/:id/exports */
export interface ExportsResponse { exports: ExportDto[] }

/** GET /jobs */
export interface JobsResponse { migrated: boolean; jobs: JobDto[] }
/** POST /jobs/:id/cancel, POST /jobs/:id/applied {document_id, version} */
export interface JobResponse { job: JobDto }

/** GET /opportunities */
export interface OpportunitiesResponse { migrated: boolean; opportunities: OpportunityDto[] }
/** GET /ideas */
export interface IdeasListResponse { migrated: boolean; ideas: IdeaRecordDto[] }
/** PATCH /ideas/:id {status} */
export interface IdeaResponse { idea: IdeaRecordDto }

export interface FeedbackDto {
  id: string;
  document_id: string | null;
  kind: 'reject' | 'note' | 'like';
  reasons: RejectReason[];
  note: string;
  scope: 'document' | 'brand';
  created_at: string;
  created_by_name: string | null;
}
/** POST /feedback {document_id?, kind, reasons, note, scope} */
export interface FeedbackResponse { feedback: FeedbackDto }
/** GET /feedback */
export interface FeedbackListResponse { migrated: boolean; feedback: FeedbackDto[] }

/** POST /watch/sync — one bounded step of the catalogue watch; the first whole pass is a baseline. */
export interface WatchSyncResponse { processed: number; baseline: boolean; baseline_complete: boolean; pass_complete: boolean; arrivals: number; back_in_stock: number }

// ---------------------------------------------------------------------------
// Phase 4 — campaigns and the internal calendar (migration 0216; worker/lib/creative/planning.ts).
// INTERNAL ONLY: nothing is published anywhere; a planned date is a reminder for a person.
// ---------------------------------------------------------------------------

export interface CampaignDto {
  id: string;
  name: string;
  notes: string;
  /** 'YYYY-MM-DD' or null. */
  starts_on: string | null;
  ends_on: string | null;
  archived: boolean;
  document_count: number;
  created_at: string;
  updated_at: string;
}
/** GET /campaigns */
export interface CampaignsResponse { migrated: boolean; campaigns: CampaignDto[] }
/** POST /campaigns {name, notes?, starts_on?, ends_on?}, PATCH /campaigns/:id {name?, notes?, starts_on?, ends_on?, archived?} */
export interface CampaignResponse { campaign: CampaignDto }
/** PUT /documents/:id/campaign {campaign_id: string | null} — no new version; an approval stands. */
export interface DocumentCampaignResponse { document: DocumentSummaryDto }

/** One design on the internal calendar: the day (Asia/Baghdad calendar day) a person means to post it. */
export interface PlanItemDto { planned_for: string; note: string; document: DocumentSummaryDto }
/** GET /plan?from=YYYY-MM-DD&to=YYYY-MM-DD (at most 92 days) */
export interface PlanResponse { migrated: boolean; items: PlanItemDto[] }
/** PUT /documents/:id/plan {planned_for: 'YYYY-MM-DD' | null, note?} — null removes the date. No new version. */
export interface DocumentPlanResponse { plan: { planned_for: string; note: string } | null }
