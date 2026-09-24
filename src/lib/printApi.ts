/**
 * THE PRINT-REQUEST CLIENT.
 *
 * One place that knows the shapes `/api/marketplace/print/*` returns, so the
 * wizard, the request detail panel and the viewer page cannot drift apart by
 * each re-declaring them slightly differently.
 *
 * WHAT IS DELIBERATELY ABSENT. The server strips `cost_lines`, `cost_iqd`,
 * `floor_iqd` and `margin_percent` from every customer- and merchant-facing
 * response, so those fields do not appear here either. A type that named them
 * would invite a component to read a field that is never sent and render
 * `undefined` — or worse, tempt someone into "fixing" the server to send it.
 * What a customer gets is the range, the confidence, and why.
 */

import { api } from './api';

export type PrintProcess = 'fdm' | 'resin';
export type PrintQuality = 'draft' | 'standard' | 'fine' | 'ultra';
export type Confidence = 'high' | 'medium' | 'low';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Mirrors `ModelWarning` in worker/lib/modelGeometry.ts, code list included:
 *  a union rather than `string` so a UI that words these cannot silently miss
 *  one the analyser can actually emit. */
export type ModelWarningCode =
  | 'NOT_WATERTIGHT'
  | 'ZERO_VOLUME'
  | 'INVERTED_NORMALS'
  | 'VERY_LARGE'
  | 'VERY_SMALL'
  | 'THIN_FEATURES'
  | 'HEAVY_OVERHANG'
  | 'MANY_PARTS'
  | 'TOPOLOGY_NOT_ANALYSED'
  | 'HUGE_MESH'
  | 'UNIT_ASSUMED'
  | 'DEGENERATE_TRIANGLES';

export interface ModelWarning {
  code: ModelWarningCode;
  detail?: Record<string, number | string>;
  severity: 'info' | 'warning' | 'blocking';
}

/** Mirrors `ModelAnalysis` in worker/lib/modelGeometry.ts. */
export interface ModelAnalysis {
  format: string;
  capability: {
    previewable: boolean;
    measurable: boolean;
    sliceable: boolean;
    convertible: boolean;
    reference_only: boolean;
  };
  measured: boolean;
  reason?: string;
  unit: 'mm';
  unit_source: 'declared' | 'assumed';
  dimensions_mm: Vec3;
  bbox_min_mm: Vec3;
  bbox_max_mm: Vec3;
  volume_mm3: number;
  surface_area_mm2: number;
  triangle_count: number;
  shell_count: number | null;
  watertight: boolean | null;
  overhang_area_mm2: number;
  overhang_ratio: number;
  complexity: number;
  warnings: ModelWarning[];
  title?: string;
  suggested_material?: string;
  suggested_colors?: string[];
}

/**
 * Exactly what `publicMaterial` in worker/routes/printRequests.ts sends — no
 * density, no price per kg, no waste factor. Those are the shop's economics
 * and the wizard has no business knowing them; it asks the server for a price
 * instead of computing one.
 */
export interface PrintMaterialInfo {
  id: string;
  process: PrintProcess;
  name_ar: string;
  name_en: string;
  /** ABS/ASA need a chamber. Shown as a hint, enforced by the matcher. */
  needs_enclosure: boolean;
  /** CF/GF fill needs a hardened nozzle. Same: a hint here, a rule there. */
  abrasive: boolean;
}

export interface FormatInfo {
  id: string;
  previewable: boolean;
  measurable: boolean;
  sliceable: boolean;
  convertible: boolean;
  reference_only: boolean;
}

export interface PrintCatalog {
  materials: PrintMaterialInfo[];
  processes: PrintProcess[];
  qualities: Array<{ id: PrintQuality; layer_mm: number }>;
  capabilities: string[];
  formats: FormatInfo[];
  min_job_iqd: number;
}

/** The public half of `Quote` — the shop's cost breakdown is not in it. */
export interface PublicQuote {
  priced: boolean;
  reason?: string;
  process: PrintProcess;
  material_id: string;
  printed_volume_cm3: number;
  material_grams: number;
  print_time_minutes: number;
  total_time_minutes: number;
  price_iqd: number;
  price_low_iqd: number;
  price_high_iqd: number;
  confidence: Confidence;
  confidence_reasons: string[];
  unit_price_iqd: number;
}

export interface PrintSpec {
  process: PrintProcess;
  material_id: string;
  color_hex: string;
  color_name: string;
  quality: PrintQuality;
  infill_percent: number;
  supports: boolean;
  colors_count: number;
  post_processing_minutes: number;
  quantity: number;
}

/** What `GET /api/marketplace/print/requests/:id` returns under `print`. */
export interface PrintFacts extends PrintSpec {
  primary_file_id: string | null;
  source_kind: string;
  source_provider: string;
  source_url: string;
  source_meta: Record<string, unknown>;
  analysis: ModelAnalysis | null;
  estimate: Partial<PublicQuote>;
  estimate_low_iqd: number | null;
  estimate_high_iqd: number | null;
  estimate_confidence: Confidence | null;
  completeness: number;
  required_capabilities: string[];
}

/**
 * A row of the customer's own list. Richer than the public board's shape on
 * purpose — this route is owner-scoped in SQL, the board's is a whitelist.
 */
export interface MyRequestRow {
  id: string;
  title: string;
  state: string;
  quantity: number;
  material: string;
  color: string;
  budget_iqd: number | null;
  deadline: string | null;
  governorate: string;
  offer_count: number;
  file_count: number;
  created_at: string;
  /** null for a request made before the print system, or never published. */
  print: {
    process: PrintProcess;
    material_id: string;
    color_hex: string;
    color_name: string;
    quality: PrintQuality;
    estimate_low_iqd: number | null;
    estimate_high_iqd: number | null;
    estimate_confidence: Confidence | null;
    completeness: number;
    primary_file_id: string | null;
    primary_file_name: string;
    primary_format: string;
    has_preview: boolean;
    source_kind: string;
    source_provider: string;
  } | null;
  /** Present only after the customer picked an offer. */
  accepted: {
    offer_id: string;
    order_id: string | null;
    merchant_name: string;
    price_iqd: number | null;
    completion_days: number | null;
  } | null;
}

export interface LinkInfo {
  resolved: boolean;
  reason?: string;
  name?: string;
  creator?: string;
  description?: string;
  images?: string[];
  license?: string;
  material?: string;
  colors?: string[];
  weight_g?: number;
  print_minutes?: number;
  plates?: number;
}

export interface LinkResult {
  link: { provider: string; external_id: string; canonical_url: string; host: string };
  info: LinkInfo;
}

export interface ViewerMeta {
  name: string;
  format: string;
  dimensions_mm: Vec3 | null;
  volume_mm3: number;
  triangle_count: number;
  shell_count: number | null;
  expires_at: string;
}

const BASE = '/api/marketplace/print';

export const printApi = {
  catalog: () => api.get<PrintCatalog>(`${BASE}/catalog`),

  analyze: (requestId: string, fileId: string) =>
    api.post<{ analysis: ModelAnalysis }>(`${BASE}/requests/${requestId}/files/${fileId}/analyze`),

  link: (url: string) => api.post<LinkResult>(`${BASE}/link`, { url }),

  quote: (body: Record<string, unknown>) => api.post<{ quote: PublicQuote }>(`${BASE}/quote`, body),

  publish: (requestId: string, body: Record<string, unknown>) =>
    api.post<{ notified: number; matched: number; estimate: PublicQuote }>(
      `${BASE}/requests/${requestId}/publish`,
      body
    ),

  myRequests: () => api.get<{ requests: MyRequestRow[] }>(`${BASE}/my-requests`),

  facts: (requestId: string) =>
    api.get<{ print: PrintFacts | null; is_owner: boolean }>(`${BASE}/requests/${requestId}`),

  viewerToken: (requestId: string, fileId: string) =>
    api.post<{ token: string; url: string; expires_at: string }>(
      `${BASE}/requests/${requestId}/files/${fileId}/viewer-token`
    ),

  /**
   * Copy a request and PUBLISH the copy (it goes through matching). When the
   * publish step fails the copy is kept as a draft and `published` says so —
   * the caller must tell the customer rather than assume it went live.
   */
  repeat: (requestId: string) =>
    api.post<{
      request_id: string;
      files: number;
      published: boolean;
      publish_error?: string;
      matching?: { considered: number; eligible: number; notified: number };
    }>(`${BASE}/requests/${requestId}/repeat`),
};

/**
 * A range reads as one price when both ends round to the same number, which is
 * what happens on small jobs. Say it once rather than "18,000 – 18,000".
 */
export function priceRange(low: number | null, high: number | null, fmt: (n: number) => string): string {
  if (low === null && high === null) return '';
  if (low === null) return fmt(high as number);
  if (high === null || high === low) return fmt(low);
  return `${fmt(low)} – ${fmt(high)}`;
}

export function mmSize(d: Vec3 | null | undefined): string {
  if (!d) return '';
  const r = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
  return `${r(d.x)} × ${r(d.y)} × ${r(d.z)}`;
}

export function cm3(volumeMm3: number): number {
  return Math.round((volumeMm3 / 1000) * 10) / 10;
}

/** Minutes → "2 س 15 د" / "2h 15m", never "135 minutes". */
export function duration(minutes: number, ar: boolean): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return ar ? `${rest} د` : `${rest}m`;
  if (!rest) return ar ? `${h} س` : `${h}h`;
  return ar ? `${h} س ${rest} د` : `${h}h ${rest}m`;
}
