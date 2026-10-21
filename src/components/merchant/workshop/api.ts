/**
 * THE WORKSHOP'S CLIENT — eligibility, the «مناسب لي» board, stock and private
 * request costing (stream W5-B). The shapes mirror worker/routes/
 * merchantWorkshop.ts and merchantPrinters.ts; the server decides every
 * verdict, permission and price, and nothing here computes one it believes.
 */
import { api } from '../../../lib/api';

export type Dimension = 'trade' | 'capability' | 'stock' | 'reach' | 'preference';
export type DimensionState = 'pass' | 'fail' | 'unknown' | 'untracked';

export interface Verdict {
  request_id: string;
  revision: number;
  eligible: boolean;
  reason: string;
  reasons: string[];
  dims: Record<Dimension, DimensionState>;
  notify: boolean;
  notify_block: '' | 'NOTIFICATIONS_OFF' | 'PAUSED';
  printer: { id: string; name: string } | null;
  stock_tracked: boolean;
  /** P1-05: a job of parts — every part eligible, and each part with its own reasons. Absent on a one-job request. */
  covers_all?: boolean;
  parts?: Array<{ part_id: string; eligible: boolean; reasons: string[]; printer: { id: string; name: string } | null }>;
}

export interface BoardRequest {
  id: string;
  title: string;
  description: string;
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
  revision: number;
  customer_notes: string;
  process: 'fdm' | 'resin' | null;
  material_id: string | null;
  estimate_low_iqd: number | null;
  estimate_high_iqd: number | null;
  file_count: number;
  thumb_url: string | null;
  /** The model link a link request is about (R1), or null. */
  source_url?: string | null;
  has_preview: boolean;
  my_offer: 'pending' | 'superseded' | 'accepted' | null;
  /** P1-05: false when the range sums only the parts that could be priced. Absent on an older Worker. */
  estimate_complete?: boolean;
  /**
   * P1-05: the parts, pieces a set and review; and (review 3) the materials
   * and technologies the parts chose, which a job in several of them names
   * where its v1 row says «open». Absent on an older Worker.
   */
  summary?: {
    parts_count: number; pieces_per_set: number; review_state: string; materials?: string[]; processes?: Array<'fdm' | 'resin'>;
    /** P1-05 review 5: a part left its material open beside the named ones. Absent on an older Worker. */
    materials_open?: boolean;
  } | null;
}

/**
 * WHAT A BOARD CARD NAMES (P1-05 review 3): the technologies and materials of
 * the parts when the row carries them, else the one process and material
 * of the v1 row. `anyTechnology` is said when no technology is named, or when a
 * part was left open beside a named one (the v1 row is open while the parts
 * named only one).
 */
export function boardJobFacts(r: Pick<BoardRequest, 'process' | 'material_id' | 'summary'>): {
  processes: Array<'fdm' | 'resin'>;
  materials: string[];
  anyTechnology: boolean;
  /** Some part left its material open beside the named ones (P1-05 review 5): «PLA + any material», never «PLA» alone. */
  anyMaterial: boolean;
} {
  const named = r.summary?.processes?.filter((x) => x === 'fdm' || x === 'resin') ?? [];
  const processes = named.length ? named : r.process ? [r.process] : [];
  const materials = r.summary?.materials?.length ? r.summary.materials : r.material_id ? [r.material_id] : [];
  return {
    processes,
    materials,
    anyTechnology: !processes.length || (!r.process && processes.length === 1),
    anyMaterial: materials.length > 0 && !!r.summary?.materials_open,
  };
}

/**
 * THE ESTIMATE LABEL OF A BOARD CARD (P1-05 review 6): «of the priced parts
 * only» when a part of the job is unpriced (R10), in the words the list and
 * the request page use; in Sorani «نرخیان بۆ دانراوە» (priced), never
 * «نرخدار», which reads as «valuable». An older Worker says nothing about
 * coverage: the plain label.
 */
export function boardEstimateLabel(complete: boolean | undefined, lang: 'ar' | 'en' | 'ckb'): string {
  if (complete === false) {
    return { ar: 'تقدير القطع المسعّرة فقط', en: 'Estimate of the priced parts only', ckb: 'خەمڵاندن تەنها بۆ ئەو پارچانەی نرخیان بۆ دانراوە' }[lang];
  }
  return { ar: 'تقدير Levonis', en: 'Levonis estimate', ckb: 'خەمڵاندنی Levonis' }[lang];
}

export interface BoardPage {
  requests: BoardRequest[];
  next_cursor: string | null;
  /** The workshop cannot take new work at all, and why. */
  blocked?: 'CANNOT_TAKE_WORK' | 'NOT_TAKING_REQUESTS' | 'MERCHANT_NOT_APPROVED';
}

export interface BoardFilters {
  process?: '' | 'fdm' | 'resin';
  material?: string;
  governorate?: string;
}

export interface CostLine {
  component: string;
  iqd: number;
  from: string;
  detail?: string;
}

export interface CostQuote {
  confidence: string;
  lines: CostLine[];
  true_cost_iqd: number;
  price_iqd: number;
  profit_iqd: number;
  margin_percent: number;
  machine_hours: number;
  waste_grams: number;
  range_iqd: { low: number; high: number };
}

export interface Costing {
  quote_id: string;
  request_revision: number;
  printer: { id: string; name: string };
  material_id: string;
  quality_id: string;
  strength_id: string;
  quantity: number;
  quote: CostQuote;
}

export interface CostRow {
  id: string;
  price_iqd: number;
  true_cost_iqd: number;
  profit_iqd: number;
  margin_percent: number;
  machine_hours: number;
  confidence: string;
  state: 'draft' | 'offered' | 'accepted' | 'expired' | 'withdrawn';
  created_at: string;
  printer: { id: string | null; name: string };
  material_id: string | null;
  request_revision: number;
  stale: boolean;
}

export interface CostInput {
  merchant_printer_id?: string;
  material_id?: string;
  quality_id?: 'draft' | 'standard' | 'fine';
  strength_id?: 'light' | 'standard' | 'strong';
  target_margin_percent?: number;
}

export interface QuoteMaterial {
  id: string;
  type: string;
  name_en: string;
  name_ar: string;
}

export interface StockLine {
  material_id: string;
  color_hex: string;
  color_name: string;
  grams: number;
}

export interface StockResponse {
  tracked: boolean;
  stock: StockLine[];
  materials: Array<{ id: string; process: 'fdm' | 'resin'; name_en: string; name_ar: string }>;
  max_lines: number;
}

export interface PrinterModelOption {
  id: string;
  manufacturer: string;
  model: string;
  technology: 'fdm' | 'resin';
  build_mm: { x: number; y: number; z: number };
  nozzle_sizes_mm: number[];
  default_nozzle_mm: number;
  enclosed: boolean;
  hardened_nozzle_available: boolean;
  max_colors: number;
  multi_material: string;
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const workshopApi = {
  board: (f: BoardFilters & { cursor?: string | null; limit?: number } = {}) =>
    api.get<BoardPage>(`/api/merchant/workshop/board${qs({ process: f.process, material: f.material, governorate: f.governorate, cursor: f.cursor, limit: f.limit })}`),
  verdict: (requestId: string) => api.get<Verdict>(`/api/merchant/workshop/requests/${encodeURIComponent(requestId)}/eligibility`),
  cost: (requestId: string, input: CostInput) =>
    api.post<Costing>(`/api/merchant/workshop/requests/${encodeURIComponent(requestId)}/cost`, input),
  costs: (requestId: string) =>
    api.get<{ revision: number; costs: CostRow[] }>(`/api/merchant/workshop/requests/${encodeURIComponent(requestId)}/costs`),
  stock: () => api.get<StockResponse>('/api/merchant/material-stock'),
  saveStock: (lines: StockLine[], untrack = false) =>
    api.put<{ tracked: boolean; stock: StockLine[] }>('/api/merchant/material-stock', { lines, ...(untrack ? { untrack: true } : {}) }),
};

/** What «استخدم هذا كعرضي» hands the offer composer: a price and where it came from. Never sent until the merchant sends it. */
export interface OfferPrefill {
  price_iqd: number;
  quote_id: string;
}
