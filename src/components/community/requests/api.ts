/**
 * PRINT REQUESTS v2 — the client's half of the contract (stream W5-A).
 *
 * The shapes mirror worker/routes/printRequests.ts and marketplace.ts; the
 * server decides every price, permission and state. Nothing here computes a
 * figure the server will believe.
 */
import { api } from '../../../lib/api';

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

export interface Quote {
  priced: boolean;
  reason?: string;
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  confidence: 'high' | 'medium' | 'low';
  range_basis?: 'materials';
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
  quote: (b: Record<string, unknown>) => api.post<{ quote: Quote }>('/api/marketplace/print/quote', b),
  revisions: (id: string) =>
    api.get<{ current: number; revisions: Array<{ revision: number; created_at: string; changes: string[]; reason: string }> }>(
      `/api/marketplace/print/requests/${encodeURIComponent(id)}/revisions`
    ),
};
