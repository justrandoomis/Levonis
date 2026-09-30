/**
 * PRINT REQUESTS v2 — the client's half of the contract (stream W5-A).
 *
 * The shapes mirror worker/routes/printRequests.ts and marketplace.ts; the
 * server decides every price, permission and state. Nothing here computes a
 * figure the server will believe.
 */
import { api } from '../../../lib/api';
import type { Estimate } from '../../../lib/printEstimate';

export type SourceType = 'model' | 'link' | 'images' | 'description';
export type ProcessChoice = 'fdm' | 'resin' | 'unsure';
export type Quality = 'draft' | 'standard' | 'fine' | 'ultra';
export type DeliveryPref = '' | 'delivery' | 'pickup';
export type OfferDeliveryMethod = 'pickup' | 'merchant_delivery' | 'courier';

export interface Dims {
  x: number;
  y: number;
  z: number;
}

export interface CatalogMaterial {
  id: string;
  process: 'fdm' | 'resin';
  name_en: string;
  name_ar: string;
  needs_enclosure: boolean;
  abrasive: boolean;
}

export interface Catalog {
  materials: CatalogMaterial[];
  qualities: Array<{ id: Quality; layer_mm: number }>;
  min_job_iqd: number;
}

export interface ModelAnalysis {
  measured: boolean;
  format: string;
  dimensions_mm: Dims;
  volume_mm3: number;
  warnings: Array<{ code: string; severity: string }>;
}

export interface DraftFile {
  id: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  kind: string;
  inline: boolean;
  url: string;
  analysis: ModelAnalysis | null;
}

export interface DraftShape {
  id: string;
  state: string;
  revision: number;
  title: string;
  description: string;
  customer_notes: string;
  quantity: number;
  governorate: string;
  delivery_pref: string;
  deadline: string;
  budget_iqd: number | null;
  expires_at: string | null;
  live_offers: number;
  print: null | {
    source_type: SourceType;
    process: ProcessChoice;
    material_id: string;
    quality: Quality;
    infill_percent: number;
    supports: boolean;
    colors_count: number;
    post_processing_minutes: number;
    color_hex: string;
    color_name: string;
    primary_file_id: string | null;
    source_url: string;
    source_meta: Record<string, unknown>;
    stated_dimensions_mm: Dims | null;
  };
  files: DraftFile[];
}

/**
 * The engine's own public fields, as `/quote` and `/publish` answer them
 * today (cost lines, floor and margin stripped server-side). New screens read
 * the `Estimate` that `/quote` now sends BESIDE it (`QuoteAnswer`), which is
 * the one contract both pricing engines converge on (E3).
 */
export interface Quote {
  priced: boolean;
  reason?: string;
  process: 'fdm' | 'resin';
  material_id: string;
  printed_volume_cm3: number;
  material_grams: number;
  print_time_minutes: number;
  total_time_minutes: number;
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  unit_price_iqd: number;
  confidence: 'high' | 'medium' | 'low';
  confidence_reasons: string[];
  /** Hardware ids the catalogue no longer has, so the wizard can say so. */
  accessories_unknown?: string[];
  range_basis?: 'materials';
}

/** What `POST /api/marketplace/print/quote` answers: the engine's fields and
 *  the contract, side by side. */
export interface QuoteAnswer {
  quote: Quote;
  estimate: Estimate;
}

/** One row of `/revisions`: the estimate as it stood when the revision was
 *  recorded (E8) — the public half of `Quote`, never a cost line. */
export interface RevisionRow {
  revision: number;
  created_at: string;
  changes: string[];
  reason: string;
  estimate: Partial<Quote>;
}

/** What the wizard sends, for a draft save and for a publish alike. */
export interface WizardPayload {
  title?: string;
  description?: string;
  customer_notes: string;
  source_type: SourceType;
  process: ProcessChoice;
  material_id: string;
  quality: Quality;
  quantity: number;
  color_hex: string;
  color_name: string;
  primary_file_id?: string;
  source_url: string;
  source_meta?: Record<string, unknown>;
  stated_dimensions_mm: Dims | null;
  governorate: string;
  delivery_pref: DeliveryPref;
  deadline: string;
  budget_iqd: number | null;
}

export interface PublishResult {
  published: boolean;
  replayed: boolean;
  revised: boolean;
  revision: number;
  quote: Quote;
  matching: { considered: number; eligible: number; notified: number };
}

export const requestsApi = {
  catalog: () => api.get<Catalog>('/api/marketplace/print/catalog'),
  createDraft: (b: { title: string; description: string; customer_notes: string }) =>
    api.post<{ request: { id: string } }>('/api/marketplace/requests', b),
  draft: (id: string) => api.get<{ draft: DraftShape }>(`/api/marketplace/print/requests/${encodeURIComponent(id)}/draft`),
  saveDraft: (id: string, b: WizardPayload) =>
    api.put<{ draft: DraftShape }>(`/api/marketplace/print/requests/${encodeURIComponent(id)}/draft`, b),
  publish: (id: string, b: WizardPayload | Record<string, never>) =>
    api.post<PublishResult>(`/api/marketplace/print/requests/${encodeURIComponent(id)}/publish`, b),
  analyze: (id: string, fileId: string) =>
    api.post<{ analysis: ModelAnalysis | null }>(
      `/api/marketplace/print/requests/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}/analyze`
    ),
  removeFile: (id: string, fileId: string) =>
    api.delete(`/api/marketplace/requests/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`),
  checkLink: (url: string) =>
    api.post<{ link: { canonical_url: string; provider: string; external_id: string }; info: { name?: string; creator?: string; resolved: boolean } }>(
      '/api/marketplace/print/link',
      { url }
    ),
  quote: (b: Record<string, unknown>) => api.post<QuoteAnswer>('/api/marketplace/print/quote', b),
  revisions: (id: string) =>
    api.get<{ current: number; revisions: RevisionRow[] }>(
      `/api/marketplace/print/requests/${encodeURIComponent(id)}/revisions`
    ),
};

// ---------------------------------------------------------------------------
//  THE REQUEST'S DISCUSSION AND THE ORDER'S TIMELINE (Phase 5b, docs/
//  COMMUNITY_ECOSYSTEM.md §9.5). Mirrors worker/routes/requestDiscussion.ts
//  and worker/routes/communityOrderTimeline.ts: the server decides who may
//  write which kind, and a photo is a URL on the Worker — never a key.
// ---------------------------------------------------------------------------

export type CommentKind = 'public_comment' | 'merchant_question' | 'customer_answer' | 'system_update';
/** What a server-written row says happened to the request. */
export type SystemUpdateCode = 'revised' | 'accepted' | 'cancelled' | 'completed' | 'expired' | 'disputed' | 'republished';

export interface RequestComment {
  id: string;
  request_id: string;
  parent_id: string | null;
  kind: CommentKind;
  body: string;
  state: 'visible' | 'hidden';
  created_at: string;
  /** Null for a system row. `role` is who the author is TO THIS REQUEST. */
  author: { id: string; name: string; username: string | null; role: 'customer' | 'merchant' | 'member' } | null;
  /** The decoded server row; null for a person's comment. */
  system: { code: SystemUpdateCode | string; meta: Record<string, unknown> } | null;
  viewer: { mine: boolean; can_remove: boolean };
}

export interface CommentsPage {
  comments: RequestComment[];
  /** Present exactly when a next page exists (D8). */
  next_cursor: string | null;
  /** The visible count — on the first page; a cursor page carries null. */
  total: number | null;
  /** A hint for the composer; the POST decides again. */
  can: { comment: boolean; ask: boolean; answer: boolean };
}

export interface PostCommentBody {
  kind: Exclude<CommentKind, 'system_update'>;
  body: string;
  parent_id?: string;
}

export type OrderUpdateKind = 'started' | 'progress' | 'photo' | 'ready' | 'note' | 'modification_request' | 'delivered';
export type TimelineActor = 'customer' | 'merchant' | 'admin' | 'system';

export interface OrderTimelineEvent {
  /** An update kind, or created | funded | started | delivered | confirmed | completed | released | refunded | dispute | dispute_resolved | cancelled. */
  kind: OrderUpdateKind | string;
  at: string;
  actor: TimelineActor;
  id?: string;
  body?: string;
  /** The photo, as a route on this Worker (inline for a picture). */
  file?: { url: string; inline: boolean } | null;
  amount_iqd?: number;
}

export interface OrderTimeline {
  role: 'customer' | 'merchant';
  order: {
    id: string;
    request_id: string;
    request_title: string;
    state: string;
    price_iqd: number;
    completion_days: number;
    delivery_method: string;
    created_at: string;
    started_at: string | null;
    ready_at: string | null;
    delivered_at: string | null;
    confirmed_at: string | null;
    completed_at: string | null;
    cancelled_at: string | null;
    auto_complete_at: string | null;
    chat_id: string | null;
  };
  timeline: OrderTimelineEvent[];
  /** More updates exist than the newest 200 the read carries (worker TIMELINE_UPDATES_MAX, review 2026-09-30). */
  older_updates?: boolean;
  can: { update: boolean; ready: boolean; modification_request: boolean };
}

export interface PostOrderUpdateBody {
  kind: Exclude<OrderUpdateKind, 'started' | 'delivered'>;
  body?: string;
  /** The key `uploadLarge(file, 'order_update', { entityId: orderId })` handed back — for `photo`. */
  file_key?: string;
}

export type ReportReason = 'spam' | 'abuse' | 'nudity' | 'fraud' | 'copyright' | 'offtopic' | 'other';

const enc = encodeURIComponent;

export const discussionApi = {
  comments: (requestId: string, opts: { cursor?: string | null; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.cursor) q.set('cursor', opts.cursor);
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return api.get<CommentsPage & { success: boolean }>(`/api/marketplace/requests/${enc(requestId)}/comments${qs ? `?${qs}` : ''}`);
  },
  postComment: (requestId: string, body: PostCommentBody) =>
    api.post<{ success: boolean; comment: RequestComment; replayed?: boolean }>(`/api/marketplace/requests/${enc(requestId)}/comments`, body),
  removeComment: (requestId: string, commentId: string) =>
    api.delete<{ success: boolean }>(`/api/marketplace/requests/${enc(requestId)}/comments/${enc(commentId)}`),
  reportComment: (requestId: string, commentId: string, body: { reason: ReportReason; details?: string }) =>
    api.post<{ success: boolean; report_id: string | null; replayed?: boolean }>(
      `/api/marketplace/requests/${enc(requestId)}/comments/${enc(commentId)}/report`,
      body
    ),
  orderTimeline: (orderId: string) => api.get<OrderTimeline & { success: boolean }>(`/api/marketplace/orders/${enc(orderId)}/timeline`),
  postOrderUpdate: (orderId: string, body: PostOrderUpdateBody) =>
    api.post<{ success: boolean; update: OrderTimelineEvent; replayed?: boolean }>(`/api/marketplace/orders/${enc(orderId)}/updates`, body),
  reportOrderUpdate: (orderId: string, updateId: string, body: { reason: ReportReason; details?: string }) =>
    api.post<{ success: boolean; report_id: string | null; replayed?: boolean }>(
      `/api/marketplace/orders/${enc(orderId)}/updates/${enc(updateId)}/report`,
      body
    ),
};

// ---------------------------------------------------------------------------
//  OFFERS V2, WORKSHOP FACTS AND THE MERCHANT'S BOARD (Phase 5a, docs/
//  COMMUNITY_ECOSYSTEM.md §9.5). Mirrors worker/routes/marketplace.ts (the
//  offers routes and the accept), worker/routes/merchantPrinters.ts
//  (request-prefs) and worker/routes/community.ts (`?for=me`, the store's
//  `workshop`). The server computes the total (price + delivery fee), owns
//  every file key and decides eligibility; nothing here computes a figure
//  the server will believe.
// ---------------------------------------------------------------------------

const encodeId = encodeURIComponent;

export type OfferFileKind = 'image' | 'pdf' | 'model';

/** A file on an offer, as a party sees it: a URL on the Worker. `key` comes back only to the merchant who uploaded it. */
export interface OfferFileV2 {
  id: string | null;
  kind: OfferFileKind;
  name: string;
  bytes: number;
  content_type: string;
  url: string | null;
  key?: string;
}

export interface OfferHistoryEntryV2 {
  revision: number;
  request_revision: number;
  price_iqd: number;
  completion_days: number | null;
  delivery_method: string;
  reason: string;
  created_at: string;
}

/** One offer — sent (`draft: false`) or the merchant's own saved draft (`draft: true`, `state: 'draft'`). */
export interface OfferV2 {
  id: string;
  request_id: string;
  merchant_id: string;
  store_id: string | null;
  /** Null only on a draft saved without a price. */
  price_iqd: number | null;
  /** The delivery fee; part of what the customer agrees to. */
  delivery_fee_iqd: number;
  /** price + delivery fee, computed by the server; what `acceptOffer` confirms. */
  total_iqd: number | null;
  quantity: number | null;
  color: string;
  terms: string;
  completion_days: number;
  delivery_method: OfferDeliveryMethod | '' | string;
  message: string;
  materials: string;
  material_ids: string[];
  included: string;
  warranty_terms: string;
  state: 'draft' | 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'expired' | 'superseded' | string;
  draft: boolean;
  expires_at: string | null;
  /** The validity under the name the card reads (= expires_at). */
  valid_until: string | null;
  valid_days?: number | null;
  created_at: string;
  updated_at: string;
  /** 0 on a draft. */
  revision: number;
  request_revision: number;
  /** The customer's «عرض معدّل»: revision > 1. */
  revised: boolean;
  stale: boolean;
  expired: boolean;
  files: OfferFileV2[];
  history?: OfferHistoryEntryV2[];
  order_id?: string | null;
  workshop_unable?: boolean;
  quote_id?: string | null;
  merchant: {
    id: string;
    name: string;
    verified: boolean;
    pro_badge?: boolean;
    premium_badge?: boolean;
    badge: string;
    rating: number | null;
    rating_count: number;
    completed_orders: number;
    store_slug: string | null;
  } | null;
}

/** What the composer sends — for a new offer, a draft (`draft: true`), an edit (any subset) and a draft's save. */
export interface OfferInputV2 {
  price_iqd?: number;
  delivery_fee_iqd?: number;
  quantity?: number | null;
  color?: string;
  terms?: string;
  completion_days?: number;
  delivery_method?: OfferDeliveryMethod | '';
  material_ids?: string[];
  materials?: string;
  included?: string;
  warranty_terms?: string;
  message?: string;
  valid_days?: number | null;
  /** Keys handed back by `uploadLarge(file, 'offer', { entityId: requestId })`; at most six. */
  files?: Array<{ key: string }>;
  quote_id?: string;
  /** Save without sending: invisible to the customer until `sendOffer`. */
  draft?: boolean;
}

export interface MyOfferRowV2 extends OfferV2 {
  request: { id: string; title: string; state: string; revision: number; expires_at: string | null };
  order_id: string | null;
}

/** What `acceptOffer` sends: the TOTAL and the revision the confirmation showed. */
export interface AcceptOfferBody {
  expected_total_iqd: number;
  offer_revision: number;
  address_id?: string;
}

/** «ملف الورشة» + the matching filters, as GET/PUT /api/merchant/request-prefs read and write them. */
export interface RequestPrefsV2 {
  processes: string[];
  materials: string[];
  colors: string[];
  capabilities: string[];
  governorates: string[];
  delivery: string[];
  min_job_iqd: number;
  max_job_iqd: number | null;
  min_size_mm: number;
  max_size_mm: number | null;
  workload: 'light' | 'normal' | 'busy' | 'full' | string;
  paused: boolean;
  paused_until: string | null;
  /** 1..60, or null for «not stated»; a ranking signal, never a filter. */
  turnaround_days: number | null;
  /** ≤ 300 characters, shown on the store page. */
  workshop_intro: string;
  /** Derived from the printers on every save — read-only on the client. */
  technologies: string[];
  max_build_mm: { x?: number; y?: number; z?: number };
}

export interface RequestPrefsVocabulary {
  processes: string[];
  capabilities: string[];
  delivery: string[];
  workloads: string[];
  materials: Array<{ id: string; process: 'fdm' | 'resin'; name_en: string; name_ar: string }>;
}

/** The public `workshop` block of GET /api/community/store/:id. */
export interface WorkshopFactsV2 {
  technologies: string[];
  materials: string[];
  max_build_mm: { x?: number; y?: number; z?: number };
  turnaround_days: number | null;
  governorates: string[];
  delivery: string[];
  custom_enabled: boolean;
  intro: string;
}

/** A row of the merchant's own board (`?for=me`): the board's public request plus the engine's rank for this workshop. */
export interface BoardForMeRow {
  id: string;
  title: string;
  description: string;
  category: string | null;
  quantity: number;
  material: string;
  color: string;
  dimensions: string;
  budget_iqd: number | null;
  deadline: string | null;
  governorate: string;
  delivery_pref: string;
  state: string;
  offer_count: number;
  created_at: string;
  expires_at: string | null;
  customer_name: string | null;
  file_count: number;
  revision: number;
  customer_notes: string;
  status: string;
  customer_username: string | null;
  match_score: number;
}

export interface BoardForMePage {
  requests: BoardForMeRow[];
  /** Present exactly when a next page exists (D8). */
  next_cursor: string | null;
  total: number | null;
  for: 'me';
}

export const offersV2Api = {
  /** The offers on a request (the customer sees all, a merchant their own) and the merchant's own draft, if any. */
  list: (requestId: string) =>
    api.get<{ success: boolean; offers: OfferV2[]; draft: OfferV2 | null; is_customer: boolean }>(
      `/api/marketplace/requests/${encodeId(requestId)}/offers`
    ),
  /** A new offer — or, with `draft: true`, a saved draft the customer cannot see. */
  createOffer: (requestId: string, b: OfferInputV2) =>
    api.post<{ success: boolean; offer: OfferV2 }>(`/api/marketplace/requests/${encodeId(requestId)}/offers`, b),
  /** Edit a sent offer (bumps its revision; the customer is told) or a draft (in place). */
  updateOffer: (offerId: string, b: Partial<OfferInputV2>) =>
    api.patch<{ success: boolean; offer: OfferV2 }>(`/api/marketplace/offers/${encodeId(offerId)}`, b),
  /** «أرسل العرض»: a draft becomes a live offer; OFFER_REQUEST_CLOSED keeps the draft when the request closed. */
  sendOffer: (draftId: string) =>
    api.post<{ success: boolean; offer: OfferV2 }>(`/api/marketplace/offers/${encodeId(draftId)}/send`),
  /** Accept the TOTAL the card showed; a changed total or revision is OFFER_CHANGED with the fresh offer. */
  acceptOffer: (offerId: string, b: AcceptOfferBody) =>
    api.post<{ success: boolean; order: { id: string; state: string; price_iqd: number; chat_id: string | null }; escrow_id: string | null; replayed?: boolean }>(
      `/api/marketplace/offers/${encodeId(offerId)}/accept`,
      b
    ),
  /** «عروضي», drafts flagged on the first page; `state=draft` lists only them. */
  mine: (cursor = '', state = '') =>
    api.get<{ success: boolean; offers: MyOfferRowV2[]; next_cursor: string | null }>(
      `/api/marketplace/my-offers?limit=20${cursor ? `&cursor=${encodeId(cursor)}` : ''}${state ? `&state=${encodeId(state)}` : ''}`
    ),
  /** The workshop's filters and profile. */
  requestPrefs: () => api.get<{ success: boolean; prefs: RequestPrefsV2; vocabulary: RequestPrefsVocabulary }>('/api/merchant/request-prefs'),
  saveRequestPrefs: (b: Partial<Omit<RequestPrefsV2, 'technologies' | 'max_build_mm'>>) =>
    api.put<{ success: boolean }>('/api/merchant/request-prefs', b),
  /** «طلبات تناسبك»: the eligible rows of the signed-in merchant's workshop. */
  boardForMe: (cursor = '', limit = 20) =>
    api.get<BoardForMePage & { success: boolean }>(
      `/api/community/requests?for=me&limit=${limit}${cursor ? `&cursor=${encodeId(cursor)}` : ''}`
    ),
  /** A store page's workshop facts ride the store read itself. */
  storeWorkshop: (merchantId: string) =>
    api.get<{ success: boolean; workshop: WorkshopFactsV2 | null }>(`/api/community/store/${encodeId(merchantId)}`),
};
