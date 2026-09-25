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
  has_preview: boolean;
  my_offer: 'pending' | 'superseded' | 'accepted' | null;
}

export interface BoardPage {
  requests: BoardRequest[];
  next_cursor: string | null;
  /** The workshop cannot take new work at all, and why. */
  blocked?: 'CANNOT_TAKE_WORK' | 'NOT_TAKING_REQUESTS';
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
