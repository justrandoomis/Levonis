/**
 * The browser's side of the print quote engine (`docs/PRINT_QUOTE_ENGINE.md`).
 *
 * WHAT IS NOT HERE, ON PURPOSE: any slicing, any mesh parsing, any three.js.
 * The store bundle carries zero slicer payload and never embeds LEVO Studio
 * (docs/STUDIO_PLAN.md decision 6, pinned by tests/store-isolation.test.ts),
 * for a pricing reason rather than a size one — a number the customer's own
 * machine computed is a number the customer could change, and this one decides
 * money. So the file goes to the Worker, the Worker measures it, and this
 * module only carries the answer back.
 *
 * THE GUEST TOKEN. A signed-out visitor may be quoted (§23); the calculator is
 * how somebody finds out the shop exists, and demanding an account first is how
 * they find out somewhere else instead. Their claim on their own upload is a
 * random token minted here, kept in `sessionStorage` for the tab, and sent in
 * `X-Guest-Token` — never a cookie, so it reaches this one API and nothing else.
 */
import { api } from './api';

const GUEST_TOKEN_KEY = 'levonis-print-quote-guest';

/**
 * The tab's guest token, minted once.
 *
 * `sessionStorage` rather than `localStorage`: the capability should die with
 * the tab, and a guest analysis expires server-side anyway (§35). Every access
 * is guarded — a private window or blocked site data throws on read, and the
 * flow must still work there, so a token that cannot be stored is simply held
 * in memory for the life of the page.
 */
let memoryToken = '';
export function guestToken(): string {
  if (memoryToken) return memoryToken;
  try {
    const stored = sessionStorage.getItem(GUEST_TOKEN_KEY);
    if (stored) {
      memoryToken = stored;
      return stored;
    }
  } catch {
    /* private window, blocked storage — fall through to a memory-only token */
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  memoryToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    sessionStorage.setItem(GUEST_TOKEN_KEY, memoryToken);
  } catch {
    /* memory-only is a working fallback, not an error worth showing */
  }
  return memoryToken;
}

const auth = () => ({ headers: { 'X-Guest-Token': guestToken() } });

// ------------------------------------------------------------------- shapes

export interface QuotePrinter {
  id: string;
  manufacturer: string;
  model: string;
  technology: 'fdm' | 'resin';
  build_mm: { x: number; y: number; z: number };
  default_nozzle_mm: number;
  nozzle_sizes_mm: number[];
  max_simultaneous_materials: number;
  multi_material: string;
  enclosed: boolean;
  materials: string[];
  /**
   * Opaque labels from the Worker (`printerPriceSignature`): two printers with
   * the same `price_group` quote ONE piece in ONE material identically on the
   * file door, and two with the same `untimed_price_group` quote a grams job
   * with no stated time identically. Used only to say so honestly — never to
   * compute a price.
   */
  price_group?: string;
  untimed_price_group?: string;
}

export interface QuoteMaterial {
  id: string;
  material_type: string;
  name: string;
  name_ar: string | null;
  density_g_cm3: number;
  needs_enclosure: number;
  abrasive: number;
}

/** Grams NAMED by where they go (§8), never one "filament" figure. */
export interface AnalysisMaterialView {
  slot: number;
  materialId: string;
  materialType: string;
  colorHex: string;
  modelGrams: number;
  supportGrams: number;
  supportInterfaceGrams: number;
  purgeGrams: number;
  primeTowerGrams: number;
  brimRaftGrams: number;
  otherWasteGrams: number;
  grams: number;
  wasteGrams: number;
}

export interface AnalysisView {
  bounding_box_mm: { x: number; y: number; z: number };
  model_volume_mm3: number;
  part_count: number;
  layer_count: number;
  layer_height_mm: number;
  print_minutes_per_plate: number;
  preparation_minutes: number;
  plate_count: number;
  pieces_per_plate: number;
  tool_changes: number;
  provenance: 'measured' | 'profile' | 'merchant' | 'platform' | 'inferred';
  materials: AnalysisMaterialView[];
  /** Which engine produced it — a geometric estimate or a real slice. */
  engine: string;
  unmeasured: string[];
}

/** What the file itself says, measured on the Worker. Exact for a closed mesh. */
export interface GeometryView {
  volume_mm3: number;
  surface_area_mm2: number;
  dimensions_mm: { x: number; y: number; z: number };
  triangle_count: number;
  shell_count: number | null;
  watertight: boolean | null;
  overhang_ratio: number;
  unit_source: 'declared' | 'assumed';
  warnings: Array<{ code: string; severity: string; detail?: Record<string, number | string> }>;
}

/** §22: not a cost, not a margin, not a component line. A different SHAPE. */
export interface PublicQuoteView {
  confidence: 'exact' | 'estimated' | 'insufficient';
  price_iqd: number;
  range_iqd: { low: number; high: number };
  machine_hours: number;
  waste_grams: number;
  waste_percent: number;
  engine_version: number;
}

// ------------------------------------------------------------------ the calls

export const loadPrinters = (signal?: AbortSignal) =>
  api.get<{ printers: QuotePrinter[] }>('/api/print-quote/printers', { signal }).then((r) => r.printers ?? []);

export const loadMaterials = (signal?: AbortSignal) =>
  api.get<{ materials: QuoteMaterial[] }>('/api/print-quote/materials', { signal }).then((r) => r.materials ?? []);

export interface UploadedModel {
  analysis_id: string;
  file_sha256: string;
  kind: 'model' | 'reference';
  extension: string;
  bytes: number;
  expires_at: string | null;
}

/**
 * Sends the file. A model is tens of megabytes on a phone connection, so the
 * deadline scales with its size rather than using the app's 20-second default,
 * which would abort a perfectly healthy upload halfway.
 */
export function uploadModel(file: File, signal?: AbortSignal): Promise<UploadedModel> {
  const form = new FormData();
  form.append('file', file);
  form.append('guest_token', guestToken());
  return api.post<UploadedModel>('/api/print-quote/uploads', form, {
    signal,
    timeoutMs: Math.min(300_000, 30_000 + Math.ceil(file.size / 1024) * 31),
  });
}

export interface MeasureOptions {
  printer_model_id: string;
  material_id: string;
  quality_id?: 'draft' | 'standard' | 'fine';
  strength_id?: 'light' | 'standard' | 'strong';
  nozzle_mm?: number;
  supports?: boolean;
  quantity?: number;
  color_hex?: string;
}

export const measureModel = (id: string, opts: MeasureOptions, signal?: AbortSignal) =>
  api.post<{ analysis: AnalysisView; geometry: GeometryView }>(`/api/print-quote/analyses/${id}/measure`, opts, {
    ...auth(),
    signal,
    // Measuring streams a mesh of up to five million triangles. It is a Worker
    // pass, not a slice, but it is not a 20-second round trip either.
    timeoutMs: 60_000,
  });

export const quoteAnalysis = (id: string, signal?: AbortSignal) =>
  api.post<{ quote_id: string; quote: PublicQuoteView }>(`/api/print-quote/analyses/${id}/quote`, {}, { ...auth(), signal });

// ------------------------------------------------------------------ presenting

/** Hours and minutes, never "3.47 hours" — nobody schedules a print in decimals. */
export function formatDuration(minutes: number, lang: 'ar' | 'en' | 'ckb'): string {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  const unit = lang === 'en' ? { h: 'h', m: 'min' } : { h: 'س', m: 'د' };
  if (h === 0) return `${m} ${unit.m}`;
  if (m === 0) return `${h} ${unit.h}`;
  return `${h} ${unit.h} ${m} ${unit.m}`;
}

export const formatGrams = (g: number): string => `${(Math.round(g * 10) / 10).toLocaleString('en-US')} g`;
export const formatMm = (mm: number): string => `${Math.round(mm * 10) / 10}`;
