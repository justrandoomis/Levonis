/**
 * «سرعة متجري» — the client half of the speed routes (merchant platform v2
 * §4.5 S4/S5/S7; server: worker/routes/storeLayout.ts, worker/lib/storeSpeed.ts).
 *
 * Every call is scoped by the server to the signed-in merchant's own store;
 * nothing here names a store. Every WORD on the screen — the bucket names,
 * the finding sentences, the slot labels — is mapped by the panel from the
 * closed keys below through storeDesign/strings.ts (ar / en / ckb); the
 * server sends no copy.
 */
import { api } from '../../../../lib/api';

export type Bucket = 'good' | 'ok' | 'poor';
export type Verdict = Bucket | 'collecting';
export type VitalName = 'lcp' | 'inp' | 'cls' | 'ttfb';
export type SpeedDevice = 'phone' | 'desktop';
export type SpeedDays = 7 | 28;

export const VITAL_NAMES: readonly VitalName[] = ['lcp', 'inp', 'cls', 'ttfb'];
/** The Web Vitals thresholds `[good ≤, ok ≤]` in the server's units (ms; CLS × 1000) — for the tiles' hint line. */
export const VITALS_THRESHOLDS: Readonly<Record<VitalName, readonly [number, number]>> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [100, 250],
  ttfb: [800, 1800],
};

export interface BucketCounts {
  good: number;
  ok: number;
  poor: number;
}

export interface VitalsDay {
  day: string;
  samples: number;
  lcp: BucketCounts;
  inp: BucketCounts;
  cls: BucketCounts;
  ttfb: BucketCounts;
}

export interface RumSummary {
  device: SpeedDevice;
  window_days: number;
  /** The first Baghdad day of the window. */
  from: string;
  /** Under this many readings a vital has no word (`p75_bucket` null) and the panel shows the collecting copy. */
  min_samples: number;
  /** Beacons counted in the window. */
  samples: number;
  /** Only the days with a row, oldest first. */
  days: VitalsDay[];
  totals: Record<VitalName, BucketCounts>;
  /** The bucket holding the 75th percentile — a WORD, never a number — or null. */
  p75_bucket: Record<VitalName, Bucket | null>;
  /** Mean milliseconds beside the word (context only), or null. */
  mean_ms: { lcp: number | null; ttfb: number | null };
  /** The worst of the LCP / INP / CLS words; `collecting` under `min_samples` beacons. */
  verdict: Verdict;
}

/** The closed set of first-view slot labels (worker/lib/storeSpeed.ts FIRST_VIEW_LABELS). */
export const FIRST_VIEW_LABELS = [
  'background',
  'background_poster',
  'logo',
  'banner',
  'hero_image',
  'hero_video',
  'hero_poster',
  'block_image',
  'block_video',
  'block_poster',
  'product_image',
] as const;
export type FirstViewLabel = (typeof FIRST_VIEW_LABELS)[number];

/** Store-level `block_id` values a slot may carry instead of a layout block's id. */
export const HEADER_SLOT = 'header';
export const BACKGROUND_SLOT = 'background';

export interface FirstViewItem {
  /** A layout block id, or HEADER_SLOT / BACKGROUND_SLOT — the «open the block» door. */
  block_id: string;
  label_key: FirstViewLabel;
  /** The owner's own storage key (this is an owner-only read); render through `mediaSrc`. */
  key: string;
  /** null when the ledger has no live row for the key (not measured). */
  bytes: number | null;
  mime: string | null;
  product_id?: string;
}

/** The closed finding codes (worker/lib/storeSpeed.ts SPEED_FINDING_CODES), heaviest first as the server orders them. */
export const SPEED_FINDING_CODES = [
  'HERO_GIF',
  'HERO_HEAVY',
  'BACKGROUND_VIDEO_ON_PHONE',
  'AUTOPLAY_VIDEO_COUNT',
  'POSTER_MISSING',
  'PRODUCT_IMAGES_LARGE',
  'ABOVE_FOLD_BLOCKS',
  'OK_IMAGES',
] as const;
export type SpeedFindingCode = (typeof SPEED_FINDING_CODES)[number];

export interface SpeedFinding {
  code: SpeedFindingCode;
  /** Where it is fixed: a block id, HEADER_SLOT or BACKGROUND_SLOT; absent for a page-level finding. */
  block_id?: string;
  /**
   * Numbers only, by code: HERO_HEAVY {bytes, max_bytes} · HERO_GIF {bytes} ·
   * BACKGROUND_VIDEO_ON_PHONE {bytes} · AUTOPLAY_VIDEO_COUNT {count, bytes} ·
   * POSTER_MISSING {} · PRODUCT_IMAGES_LARGE {avg_bytes, count, max_bytes} ·
   * ABOVE_FOLD_BLOCKS {count, max} · OK_IMAGES {bytes, count}.
   */
  params: Record<string, number>;
}

export interface WeightAudit {
  first_view: FirstViewItem[];
  /** The fixed cost every visitor pays before the merchant's own files, KB gzip: the app, and the Arabic font. */
  fixed: { app_kb: number; font_kb: number };
  findings: SpeedFinding[];
}

export type LayoutSource = 'published' | 'draft' | 'default';

export interface SpeedAuditAnswer {
  source: LayoutSource;
  audit: WeightAudit;
}

export interface SpeedReport {
  generated_at: string;
  rum: RumSummary;
  /** The PUBLISHED layout's audit. */
  weight: WeightAudit;
  weight_source: LayoutSource;
  /** The outbound PageSpeed Insights link («قياس مختبري», a separate tile), or null while the store has no https address. */
  psi_url: string | null;
}

const BASE = '/api/merchant/store/layout/speed';

export const speedApi = {
  /** The real-user report for a window and a device, with the published layout's audit. */
  report: (days: SpeedDays = 28, device: SpeedDevice = 'phone') => api.get<SpeedReport>(`${BASE}/report?days=${days}&device=${device}`),
  /** The first-view weight audit of the published layout or the draft. */
  audit: (source: 'published' | 'draft' = 'published') => api.get<SpeedAuditAnswer>(`${BASE}?source=${source}`),
};

/** The vital whose word decides a verdict tile's tone; TTFB is context, not a Core Web Vital. */
export const CORE_VITALS: readonly VitalName[] = ['lcp', 'inp', 'cls'];
