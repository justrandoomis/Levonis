/**
 * «سرعة متجري» — HOW FAST A STORE IS FOR ITS REAL VISITORS, AND WHAT ON ITS
 * FIRST SCREEN WEIGHS (docs/MERCHANT_PLATFORM_V2.md §0 «Vitals», §4.5 S1–S7,
 * workspace §4.8, §C.1 P4).
 *
 * ONE SYSTEM. The storefront's reporter (src/lib/storeVitals.ts) sends one
 * beacon per page load; the ingest (worker/routes/storefrontEvents.ts) turns
 * each value into a BUCKET at the Web Vitals thresholds and adds one to the
 * store's day (migration 0161); the report (worker/routes/storeLayout.ts) reads
 * the days back; the workspace's attention read (worker/routes/
 * merchantWorkspace.ts) asks one question of the same rows. Everything that
 * decides — the thresholds, the clamps, the bucket holding the 75th
 * percentile, the ≥ 50-sample rule, the three-poor-days rule, the first-view
 * walk and the weight findings — is a pure function in this file, so the
 * routes carry no arithmetic and the tests need no HTTP.
 *
 * NO COPY LIVES HERE. Every word a merchant reads — the bucket names, the
 * finding sentences, the slot labels — is a KEY the client maps through
 * src/components/merchant/storeDesign/strings.ts (ar / en / ckb). The server
 * answers `good | ok | poor`, closed finding codes and closed label keys.
 *
 * THE P75 IS A WORD. A day keeps three counts per vital, never the values, so
 * the 75th percentile cannot be interpolated — and is not: the answer is the
 * bucket the 75th sample falls in when the samples are laid out good → ok →
 * poor («مقدَّر من الفئات»). Under MIN_SAMPLES readings the answer is null and
 * the client shows the collecting copy; a number from 12 visits would be a
 * claim the data cannot back.
 */
import { BLOCKS, type BlockDef, type FieldSpec } from '@levonis/storeLayout/blocks';
import { mediaKey, type MediaKind } from '@levonis/storeLayout/refs';
import { productQueryKey, type BlockData } from '@levonis/storeLayout/data';
import type { StoreBlock, StoreLayout } from '@levonis/storeLayout/schema';
import { addDays } from './baghdadTime';
import { isSchemaMissing } from './membershipBenefits';

// ------------------------------------------------------------------ vitals

export type VitalName = 'lcp' | 'inp' | 'cls' | 'ttfb';
export type Bucket = 'good' | 'ok' | 'poor';
export type VitalsDevice = 'phone' | 'desktop';
export type Verdict = Bucket | 'collecting';

export const VITAL_NAMES: readonly VitalName[] = ['lcp', 'inp', 'cls', 'ttfb'];
export const VITALS_DEVICES: readonly VitalsDevice[] = ['phone', 'desktop'];

/**
 * The Web Vitals thresholds, `[good ≤, ok ≤]`, in the unit the beacon sends:
 * milliseconds for LCP / INP / TTFB, CLS × 1000 (0.1 → 100, 0.25 → 250) so
 * every value is an integer.
 */
export const VITALS_THRESHOLDS: Readonly<Record<VitalName, readonly [number, number]>> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [100, 250],
  ttfb: [800, 1800],
};

/** Above these a value is a broken clock, not a slow page; it is clamped, and still counts as poor. */
export const VITALS_CLAMPS: Readonly<Record<VitalName, number>> = {
  lcp: 60_000,
  inp: 10_000,
  cls: 5_000,
  ttfb: 30_000,
};

/** The body field each vital arrives in. */
export const VITAL_FIELDS: Readonly<Record<VitalName, string>> = {
  lcp: 'lcp_ms',
  inp: 'inp_ms',
  cls: 'cls_x1000',
  ttfb: 'ttfb_ms',
};

/** Readings under which no bucket word is given — the collecting copy instead. */
export const MIN_SAMPLES = 50;
/** The attention rule (S6): phone LCP p75 poor on this many consecutive days, each with at least this many samples. */
export const ATTENTION_POOR_DAYS = 3;
export const ATTENTION_MIN_SAMPLES = 30;
/** How many days back the attention source looks for the streak. */
export const ATTENTION_WINDOW_DAYS = 7;

export function isVitalsDevice(v: unknown): v is VitalsDevice {
  return v === 'phone' || v === 'desktop';
}

/**
 * A reading as sent, or why it is not one. `null` is «absent» — a beacon
 * without an interaction has no INP — and `undefined` is «refused»: a value
 * that is not a finite non-negative number is a malformed beacon, not a slow
 * page. Anything over the clamp is the clamp.
 */
export function clampVital(name: VitalName, raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return undefined;
  return Math.min(Math.round(raw), VITALS_CLAMPS[name]);
}

export function bucketVital(name: VitalName, value: number): Bucket {
  const [good, ok] = VITALS_THRESHOLDS[name];
  return value <= good ? 'good' : value <= ok ? 'ok' : 'poor';
}

export type VitalsSample = Partial<Record<VitalName, number>>;

/**
 * The readings of one beacon body, or null when the body is malformed: a
 * field that is present must be a number, and at least one must be present.
 */
export function readVitalsSample(body: Record<string, unknown>): VitalsSample | null {
  const sample: VitalsSample = {};
  let any = false;
  for (const name of VITAL_NAMES) {
    const v = clampVital(name, body[VITAL_FIELDS[name]]);
    if (v === undefined) return null;
    if (v === null) continue;
    sample[name] = v;
    any = true;
  }
  return any ? sample : null;
}

export interface BucketCounts {
  good: number;
  ok: number;
  poor: number;
}

/**
 * The bucket holding the 75th percentile of the counted readings, laid out
 * good → ok → poor; null with no readings. The 75th sample of n is sample
 * ⌈0.75·n⌉ (1-based): of 100 readings the 75th, of 4 the 3rd.
 */
export function p75Bucket(c: BucketCounts): Bucket | null {
  const good = Math.max(0, Number(c.good) || 0);
  const ok = Math.max(0, Number(c.ok) || 0);
  const poor = Math.max(0, Number(c.poor) || 0);
  const n = good + ok + poor;
  if (n <= 0) return null;
  const at = Math.ceil(0.75 * n);
  if (good >= at) return 'good';
  if (good + ok >= at) return 'ok';
  return 'poor';
}

const WORSE: Record<Bucket, number> = { good: 0, ok: 1, poor: 2 };
export const worstBucket = (a: Bucket, b: Bucket): Bucket => (WORSE[a] >= WORSE[b] ? a : b);

// ---------------------------------------------------------------- recording

export interface RecordVitalsInput {
  storeId: string;
  day: string;
  device: VitalsDevice;
  visitor: string;
  nonce: string;
  sample: VitalsSample;
  /**
   * The salted network hash of an ANONYMOUS sender; '' for a signed-in one,
   * who is not capped (the traffic beacon's rule, `recordStatements` in
   * worker/lib/storefrontAnalytics.ts).
   */
  net?: string;
}

/**
 * THE TRAFFIC BEACON'S NETWORK CAP, CARRIED OVER (review 2026-09-30). An
 * anonymous visitor is address + user agent, and a script can rotate the
 * agent at will: without a cap one address was N «visitors», enough to set a
 * store's speed word and to raise — or bury — its «slow on phones» attention
 * row. At most this many anonymous marks per network per store, day and
 * device are counted, the traffic beacon's mechanism with a tighter number:
 * a speed reading is a SAMPLE, not a census, so no single network may supply
 * more than a fifth of the verdict's floor (MIN_SAMPLES) or a third of an
 * attention day (ATTENTION_MIN_SAMPLES) — a word always rests on several
 * networks. A signed-in account is one visitor wherever it is, and not capped.
 */
export const VITALS_ANON_PER_NETWORK = 10;

const BUCKETS: readonly Bucket[] = ['good', 'ok', 'poor'];
/** The twelve bucket columns of storefront_vitals_daily, in statement order. */
export const BUCKET_COLUMNS = VITAL_NAMES.flatMap((v) => BUCKETS.map((b) => `${v}_${b}`));

/**
 * The statements that record one beacon: the mark, then the day's counters by
 * the mark THIS nonce created — 1 if this request made it, 0 if the visitor
 * was already counted today on this device. One batch, all or nothing; a
 * counter is therefore always the number of distinct marks, whatever the
 * retries (the exact pattern of worker/lib/storefrontAnalytics.ts).
 */
export function recordVitalsStatements(db: D1Database, r: RecordVitalsInput): D1PreparedStatement[] {
  const flags = VITAL_NAMES.flatMap((v) => {
    const value = r.sample[v];
    const bucket = value === undefined ? null : bucketVital(v, value);
    return BUCKETS.map((b) => (bucket === b ? 1 : 0));
  });
  const lcpSum = r.sample.lcp ?? 0;
  const ttfbSum = r.sample.ttfb ?? 0;
  // ?1 store ?2 day ?3 device ?4 visitor ?5 nonce ?6..?17 the twelve flags ?18 lcp sum ?19 ttfb sum
  const flagParams = flags.map((_f, i) => `?${6 + i}`).join(', ');
  const net = r.net ?? '';
  return [
    // The mark — for an anonymous sender only while its network is under the cap.
    db
      .prepare(
        `INSERT OR IGNORE INTO storefront_vitals_marks (store_id, day, device, visitor, nonce, net)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE ?6 = ''
             OR (SELECT COUNT(*) FROM storefront_vitals_marks WHERE store_id = ?1 AND day = ?2 AND device = ?3 AND net = ?6) < ?7`
      )
      .bind(r.storeId, r.day, r.device, r.visitor, r.nonce, net, VITALS_ANON_PER_NETWORK),
    db
      .prepare(
        `INSERT INTO storefront_vitals_daily (store_id, day, device, samples, ${BUCKET_COLUMNS.join(', ')}, lcp_sum_ms, ttfb_sum_ms)
         SELECT ?1, ?2, ?3, 1, ${flagParams}, ?18, ?19
          WHERE (SELECT COUNT(*) FROM storefront_vitals_marks
                  WHERE store_id = ?1 AND day = ?2 AND device = ?3 AND visitor = ?4 AND nonce = ?5) > 0
         ON CONFLICT (store_id, day, device) DO UPDATE SET
           samples = samples + excluded.samples,
           ${BUCKET_COLUMNS.map((col) => `${col} = ${col} + excluded.${col}`).join(',\n           ')},
           lcp_sum_ms = lcp_sum_ms + excluded.lcp_sum_ms,
           ttfb_sum_ms = ttfb_sum_ms + excluded.ttfb_sum_ms`
      )
      .bind(r.storeId, r.day, r.device, r.visitor, r.nonce, ...flags, lcpSum, ttfbSum),
  ];
}

/**
 * Records one beacon: ONE batch, and nothing after it (review 2026-09-30 —
 * the ingest used to pay a sixth round trip for a COUNT its caller threw
 * away). `verify` asks, in a second read, whether the beacon added a sample —
 * for a caller that wants the answer (the tests); the route does not.
 */
export async function recordVitals(db: D1Database, r: RecordVitalsInput, opts: { verify?: boolean } = {}): Promise<boolean> {
  await db.batch(recordVitalsStatements(db, r));
  if (!opts.verify) return true;
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM storefront_vitals_marks WHERE store_id = ? AND day = ? AND device = ? AND visitor = ? AND nonce = ?')
    .bind(r.storeId, r.day, r.device, r.visitor, r.nonce)
    .first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

// ------------------------------------------------------------------ report

/** One row of storefront_vitals_daily as D1 hands it back (numbers may arrive as strings). */
export interface VitalsDayRow {
  day: string;
  samples: number;
  lcp_good: number;
  lcp_ok: number;
  lcp_poor: number;
  inp_good: number;
  inp_ok: number;
  inp_poor: number;
  cls_good: number;
  cls_ok: number;
  cls_poor: number;
  ttfb_good: number;
  ttfb_ok: number;
  ttfb_poor: number;
  lcp_sum_ms?: number;
  ttfb_sum_ms?: number;
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
  device: VitalsDevice;
  window_days: number;
  /** The first day of the window (inclusive), Baghdad. */
  from: string;
  min_samples: number;
  /** Beacons counted in the window. */
  samples: number;
  /** Only the days that have a row, oldest first. */
  days: VitalsDay[];
  /** The whole window's counts per vital. */
  totals: Record<VitalName, BucketCounts>;
  /** The bucket holding the 75th percentile — a WORD — or null under `min_samples` readings of that vital. */
  p75_bucket: Record<VitalName, Bucket | null>;
  /**
   * Mean milliseconds beside the word — null until that vital has
   * `min_samples` readings (review 2026-09-30: under the floor a mean of one
   * or two readings IS those visitors' readings, and two reads a sample apart
   * gave the newest visitor's exact value by differencing), and rounded to
   * 100 ms so one more reading cannot be read back out of it. Never a percentile.
   */
  mean_ms: { lcp: number | null; ttfb: number | null };
  /** The worst of the LCP / INP / CLS words; `collecting` under `min_samples` beacons or with no word at all. */
  verdict: Verdict;
}

const n0 = (v: unknown) => Math.max(0, Number(v) || 0);
const countsOf = (r: VitalsDayRow, v: VitalName): BucketCounts => ({
  good: n0(r[`${v}_good` as keyof VitalsDayRow]),
  ok: n0(r[`${v}_ok` as keyof VitalsDayRow]),
  poor: n0(r[`${v}_poor` as keyof VitalsDayRow]),
});
const emptyCounts = (): BucketCounts => ({ good: 0, ok: 0, poor: 0 });
/** A mean to the nearest 100 ms — «2.4 s» is what the panel says, and a coarser figure cannot be differenced. */
const roundMean = (ms: number) => Math.round(ms / 100) * 100;
const total = (c: BucketCounts) => c.good + c.ok + c.poor;

/**
 * The report's numbers from a store's day rows. `days` is the window (7 or
 * 28) ending on `today`; rows outside it are ignored even if a caller read
 * more. Pure: the same rows always give the same words.
 */
export function summarizeVitals(
  rows: readonly VitalsDayRow[],
  opts: { days: number; today: string; device: VitalsDevice; minSamples?: number }
): RumSummary {
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const from = addDays(opts.today, -(opts.days - 1)) || opts.today;
  const inWindow = rows
    .filter((r) => typeof r.day === 'string' && r.day >= from && r.day <= opts.today)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const totals: Record<VitalName, BucketCounts> = { lcp: emptyCounts(), inp: emptyCounts(), cls: emptyCounts(), ttfb: emptyCounts() };
  let samples = 0;
  let lcpSum = 0;
  let ttfbSum = 0;
  const days: VitalsDay[] = inWindow.map((r) => {
    const day: VitalsDay = { day: r.day, samples: n0(r.samples), lcp: countsOf(r, 'lcp'), inp: countsOf(r, 'inp'), cls: countsOf(r, 'cls'), ttfb: countsOf(r, 'ttfb') };
    samples += day.samples;
    lcpSum += n0(r.lcp_sum_ms);
    ttfbSum += n0(r.ttfb_sum_ms);
    for (const v of VITAL_NAMES) {
      totals[v].good += day[v].good;
      totals[v].ok += day[v].ok;
      totals[v].poor += day[v].poor;
    }
    return day;
  });
  const p75 = Object.fromEntries(
    VITAL_NAMES.map((v) => [v, total(totals[v]) >= minSamples ? p75Bucket(totals[v]) : null])
  ) as Record<VitalName, Bucket | null>;
  let verdict: Verdict = 'collecting';
  if (samples >= minSamples) {
    for (const v of ['lcp', 'inp', 'cls'] as const) {
      const word = p75[v];
      if (!word) continue;
      verdict = verdict === 'collecting' ? word : worstBucket(verdict, word);
    }
  }
  return {
    device: opts.device,
    window_days: opts.days,
    from,
    min_samples: minSamples,
    samples,
    days,
    totals,
    p75_bucket: p75,
    mean_ms: {
      lcp: total(totals.lcp) >= minSamples ? roundMean(lcpSum / total(totals.lcp)) : null,
      ttfb: total(totals.ttfb) >= minSamples ? roundMean(ttfbSum / total(totals.ttfb)) : null,
    },
    verdict,
  };
}

/** The window's rows for one store and device, oldest first; a database before 0161 has none. */
export async function readVitalsDays(db: D1Database, storeId: string, device: VitalsDevice, fromDay: string): Promise<VitalsDayRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT day, samples, ${BUCKET_COLUMNS.join(', ')}, lcp_sum_ms, ttfb_sum_ms
           FROM storefront_vitals_daily
          WHERE store_id = ?1 AND device = ?2 AND day >= ?3
          ORDER BY day`
      )
      .bind(storeId, device, fromDay)
      .all<VitalsDayRow>();
    return results ?? [];
  } catch (e) {
    if (isSchemaMissing(e)) return [];
    throw e;
  }
}

// --------------------------------------------------------------- attention

export interface SpeedAttention {
  grade: 'poor';
  /** Phone samples over the poor streak. */
  samples: number;
  /** How many consecutive days the phone LCP p75 bucket has been poor. */
  poor_days: number;
}

/**
 * S6: the workspace row exists ONLY when the phone LCP p75 bucket is poor on
 * ATTENTION_POOR_DAYS consecutive days, each with at least
 * ATTENTION_MIN_SAMPLES samples, and the streak reaches today or yesterday
 * (today may still be young). Otherwise null, and the field is absent — the
 * shell rule «a source that did not answer renders no row» holds for a source
 * that answered «nothing to say» too. `rows` are PHONE rows.
 */
export function speedAttention(rows: readonly VitalsDayRow[], today: string): SpeedAttention | null {
  const poorDays = new Map<string, number>();
  for (const r of rows) {
    if (n0(r.samples) < ATTENTION_MIN_SAMPLES) continue;
    if (p75Bucket(countsOf(r, 'lcp')) !== 'poor') continue;
    poorDays.set(r.day, n0(r.samples));
  }
  const yesterday = addDays(today, -1);
  const end = poorDays.has(today) ? today : poorDays.has(yesterday) ? yesterday : '';
  if (!end) return null;
  let streak = 0;
  let samples = 0;
  for (let day = end; poorDays.has(day); day = addDays(day, -1)) {
    streak += 1;
    samples += poorDays.get(day) ?? 0;
  }
  return streak >= ATTENTION_POOR_DAYS ? { grade: 'poor', samples, poor_days: streak } : null;
}

// ------------------------------------------------------------ weight audit

/**
 * THE FIXED COST every store visitor pays before the merchant's own pictures:
 * the app's initial payload plus the storefront pages' closure, in KB gzip,
 * as tests/bundleBudget.test.ts measures them (initial 183.0 KB + storefront
 * closure 46.6 KB = 229.6 KB after P4/P5, docs/PERFORMANCE_LOG.md 2026-09-30).
 * The bundle test pins it within 3 KB of the build, so it cannot drift; it is
 * shown as context beside the merchant's own weight, never as a finding.
 */
export const STOREFRONT_FIXED_KB = 230;
/** The Arabic Cairo subset every store page preloads (index.html: 30,896 B); the Latin subsets load on demand. */
export const STOREFRONT_FONT_KB = 31;

/** A hero-family picture heavier than this is a finding (owner question §D.8: 1.5 MB, GIF included). */
export const HERO_HEAVY_BYTES = 1.5 * 1024 * 1024;
/** First-row product pictures averaging more than this are a finding. */
export const PRODUCT_IMAGE_LARGE_BYTES = 400 * 1024;
/** More visible blocks than this before the first product row is a finding. */
export const ABOVE_FOLD_MAX_BLOCKS = 3;
/** The first product row: four cards (two at 360 px, four at 1280). */
export const FIRST_ROW_PRODUCTS = 4;
/** How many blocks after the hero belong to the first view. */
export const FIRST_VIEW_BLOCKS = 2;
/** A gallery in the first view is measured by its first pictures, not all 24. */
export const FIRST_VIEW_MEDIA_PER_BLOCK = 6;

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

/** The closed set of slot labels the client maps to words. */
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

/** Where a first-view file is edited: a block id, or one of these store-level places. */
export const HEADER_SLOT = 'header';
export const BACKGROUND_SLOT = 'background';

export interface FirstViewSlot {
  block_id: string;
  label_key: FirstViewLabel;
  key: string;
  kind: MediaKind;
  product_id?: string;
  /** True for a video the page starts on its own (a `video` block with autoplay, a hero or background video). */
  autoplay?: boolean;
}

export interface FirstView {
  slots: FirstViewSlot[];
  /** Video slots that have no poster picture beside them. */
  posterless: Array<{ block_id: string; label_key: FirstViewLabel }>;
  /** A background video the layout plays on phones too (P5 key, read defensively). */
  background_video_on_phone: boolean;
  /** Visible blocks before the first product-bearing block; null when the page has no product block. */
  above_fold_blocks: number | null;
  /** The block whose first row of products was measured, if any. */
  product_block_id: string | null;
}

export interface FirstViewItem {
  block_id: string;
  label_key: FirstViewLabel;
  key: string;
  /** From file_objects; null when the ledger has no live row for the key (not measured). */
  bytes: number | null;
  mime: string | null;
  product_id?: string;
}

export interface SpeedFinding {
  code: SpeedFindingCode;
  block_id?: string;
  params: Record<string, number>;
}

export interface WeightAudit {
  first_view: FirstViewItem[];
  fixed: { app_kb: number; font_kb: number };
  findings: SpeedFinding[];
}

/** What the audit reads from the store row. */
export interface AuditStore {
  user_id: string;
  logo_key?: string | null;
  banner_key?: string | null;
}

/** A product card as `blockDataFor` answers it — only what the audit needs. */
export interface FirstRowProduct {
  id: string;
  images: string[];
}
export interface FirstProductRow {
  block_id: string;
  items: FirstRowProduct[];
}

const PRODUCT_BLOCKS = new Set<StoreBlock['type']>(['products_grid', 'products_carousel', 'featured_products', 'deals']);

/** Does this block put products on the page? */
function bearsProducts(b: StoreBlock): boolean {
  if (PRODUCT_BLOCKS.has(b.type)) return true;
  return b.type === 'tabs' && (b.settings.items as readonly string[]).includes('products');
}

/**
 * Blocks a phone renders NOW, in order: not hidden, not desktop-only, and —
 * for a scheduled block (storefront L8, read defensively) — inside its window
 * when `nowIso` is given. Written out rather than borrowed from
 * `renderableBlocks`, whose signature the storefront track is extending.
 */
export function phoneBlocks(layout: StoreLayout, nowIso = ''): StoreBlock[] {
  return (layout.blocks ?? []).filter((b) => {
    if (!b || b.hidden || b.visibility?.mobile === false) return false;
    const schedule = asObject((b as unknown as Record<string, unknown>).schedule);
    if (nowIso && schedule) {
      const from = typeof schedule.from === 'string' ? schedule.from : '';
      const until = typeof schedule.until === 'string' ? schedule.until : '';
      if (from && from > nowIso) return false;
      if (until && until <= nowIso) return false;
    }
    return true;
  });
}

/**
 * The media a block's OWN settings name, in declaration order: its media
 * fields, then the media fields of its list items (a gallery's pictures).
 * Walked against the registry rather than through `collectLayoutRefs`, which
 * answers for a whole layout — background included — and would hand a
 * block the page's own files.
 */
export function blockMedia(b: StoreBlock): Array<{ key: string; kind: MediaKind; field: string }> {
  const def: BlockDef | undefined = BLOCKS[b.type];
  if (!def) return [];
  const out: Array<{ key: string; kind: MediaKind; field: string }> = [];
  const walk = (specs: { readonly [k: string]: FieldSpec }, values: Record<string, unknown>, prefix: string) => {
    for (const field of Object.keys(specs)) {
      const spec = specs[field];
      const v = values?.[field];
      if (spec.t === 'media') {
        const key = keyOf(v, spec.kind);
        if (key) out.push({ key, kind: spec.kind, field: `${prefix}${field}` });
      } else if (spec.t === 'list' && Array.isArray(v)) {
        v.forEach((item, i) => walk(spec.item, asObject(item) ?? {}, `${prefix}${field}[${i}].`));
      }
    }
  };
  walk(def.settings, (b.settings as unknown as Record<string, unknown>) ?? {}, '');
  return out;
}

/** A stored key as the ledger spells it (`/files/` stripped), or '' for anything that is not a key. */
function keyOf(raw: unknown, kind: MediaKind): string {
  const v = mediaKey(raw, kind, null);
  return v && v.ok ? v.key : '';
}

/** An unknown-shaped setting read as a string key of the given kind; P5's hero/background keys arrive this way. */
const str = (o: Record<string, unknown> | null, k: string): unknown => (o ? o[k] : undefined);
const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * THE FIRST VIEW of a store page on a phone, as slots: the background (P5),
 * the header's logo and cover, the hero's picture (or video and poster, P5),
 * the first FIRST_VIEW_BLOCKS blocks after the hero, and the first product
 * row's pictures. Pure — the same layout always names the same files.
 */
export function describeFirstView(store: AuditStore, layout: StoreLayout, firstRow: FirstProductRow | null, nowIso = ''): FirstView {
  const slots: FirstViewSlot[] = [];
  const posterless: FirstView['posterless'] = [];
  const seen = new Set<string>();
  const add = (slot: FirstViewSlot) => {
    if (!slot.key || seen.has(`${slot.label_key}:${slot.key}`)) return;
    seen.add(`${slot.label_key}:${slot.key}`);
    slots.push(slot);
  };

  // THE BACKGROUND LAYER (storefront L4): `{ kind: none|image|video, media,
  // poster, dim, phones }`. Phones paint the still — `media` for an image,
  // `poster` for a video — and the video itself only when `phones` says so.
  const background = asObject((layout as unknown as Record<string, unknown>).background);
  const bgKind = str(background, 'kind');
  const bgImage = bgKind === 'image' ? keyOf(str(background, 'media'), 'image') : '';
  const bgVideo = bgKind === 'video' ? keyOf(str(background, 'media'), 'video') : '';
  const bgPoster = bgKind === 'video' ? keyOf(str(background, 'poster'), 'image') : '';
  const backgroundVideoOnPhone = !!bgVideo && str(background, 'phones') === true;
  if (bgImage) add({ block_id: BACKGROUND_SLOT, label_key: 'background', key: bgImage, kind: 'image' });
  if (bgVideo) {
    if (bgPoster) add({ block_id: BACKGROUND_SLOT, label_key: 'background_poster', key: bgPoster, kind: 'image' });
    else posterless.push({ block_id: BACKGROUND_SLOT, label_key: 'background' });
    if (backgroundVideoOnPhone) add({ block_id: BACKGROUND_SLOT, label_key: 'background', key: bgVideo, kind: 'video', autoplay: true });
  }

  const blocks = phoneBlocks(layout, nowIso);
  const hero = blocks.find((b) => b.type === 'hero') ?? null;
  const heroSettings = hero ? (hero.settings as unknown as Record<string, unknown>) : null;
  // THE HERO (L3): `image` is the cover AND the poster of `video`; phones play
  // the video only under `video_on_phone`.
  const heroImage = keyOf(str(heroSettings, 'image'), 'image');
  const heroVideo = keyOf(str(heroSettings, 'video'), 'video');
  const heroVideoOnPhone = !!heroVideo && str(heroSettings, 'video_on_phone') === true;

  // The header: the avatar, and the store's cover unless a hero picture replaces it.
  const logo = keyOf(store.logo_key, 'image');
  const banner = keyOf(store.banner_key, 'image');
  if (logo && layout.header?.variant !== 'none') add({ block_id: HEADER_SLOT, label_key: 'logo', key: logo, kind: 'image' });
  if (banner && !heroImage && (!hero || str(heroSettings, 'show_cover') !== false)) {
    add({ block_id: hero ? hero.id : HEADER_SLOT, label_key: 'banner', key: banner, kind: 'image' });
  }
  if (hero) {
    if (heroImage) add({ block_id: hero.id, label_key: heroVideo ? 'hero_poster' : 'hero_image', key: heroImage, kind: 'image' });
    if (heroVideo) {
      if (!heroImage) posterless.push({ block_id: hero.id, label_key: 'hero_video' });
      if (heroVideoOnPhone) add({ block_id: hero.id, label_key: 'hero_video', key: heroVideo, kind: 'video', autoplay: true });
    }
  }

  // The first blocks after the hero, each walked on its own so a slot keeps its block.
  const after = blocks.filter((b) => b.type !== 'hero').slice(0, FIRST_VIEW_BLOCKS);
  for (const b of after) {
    const s = b.settings as unknown as Record<string, unknown>;
    const media = blockMedia(b);
    const isVideoBlock = b.type === 'video';
    const video = isVideoBlock ? keyOf(str(s, 'video'), 'video') : '';
    const poster = isVideoBlock ? keyOf(str(s, 'poster'), 'image') : '';
    let taken = 0;
    for (const m of media) {
      if (taken >= FIRST_VIEW_MEDIA_PER_BLOCK) break;
      const label: FirstViewLabel = m.kind === 'video' ? 'block_video' : isVideoBlock && m.field === 'poster' ? 'block_poster' : 'block_image';
      add({ block_id: b.id, label_key: label, key: m.key, kind: m.kind, ...(m.kind === 'video' && str(s, 'autoplay') === true ? { autoplay: true } : {}) });
      taken += 1;
    }
    if (video && !poster) posterless.push({ block_id: b.id, label_key: 'block_video' });
  }

  // The first product row's pictures.
  if (firstRow) {
    for (const p of firstRow.items.slice(0, FIRST_ROW_PRODUCTS)) {
      const key = keyOf(p.images?.[0], 'image');
      if (key) add({ block_id: firstRow.block_id, label_key: 'product_image', key, kind: 'image', product_id: p.id });
    }
  }

  const firstProductAt = blocks.findIndex(bearsProducts);
  return {
    slots,
    posterless,
    background_video_on_phone: backgroundVideoOnPhone,
    above_fold_blocks: firstProductAt < 0 ? null : firstProductAt,
    product_block_id: firstRow?.block_id ?? (firstProductAt < 0 ? null : blocks[firstProductAt].id),
  };
}

/**
 * The first product row a layout shows, from the rows `blockDataFor` read for
 * it: the first product-bearing visible block and its first cards. Pure.
 */
export function pickFirstProductRow(layout: StoreLayout, data: BlockData, nowIso = ''): FirstProductRow | null {
  for (const b of phoneBlocks(layout, nowIso)) {
    let items: FirstRowProduct[] | null = null;
    switch (b.type) {
      case 'products_grid':
      case 'products_carousel':
        items = data.products[productQueryKey(b.settings.source, b.settings.collection_id)]?.items ?? [];
        break;
      case 'deals':
        items = data.products[productQueryKey('deals')]?.items ?? [];
        break;
      case 'featured_products': {
        const byId = new Map(data.picked.map((p) => [p.id, p]));
        items = b.settings.product_ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
        break;
      }
      case 'tabs':
        if ((b.settings.items as readonly string[]).includes('products')) items = data.products[productQueryKey('latest')]?.items ?? [];
        break;
      default:
        break;
    }
    if (items) return { block_id: b.id, items: items.slice(0, FIRST_ROW_PRODUCTS).map((p) => ({ id: p.id, images: p.images ?? [] })) };
  }
  return null;
}

export interface FileSize {
  bytes: number;
  mime: string;
}

const isImage = (mime: string | null) => !!mime && mime.startsWith('image/');

/**
 * THE FINDINGS, from the first view and what the ledger says each file
 * weighs. Closed codes, numbers only in `params`; the client writes the
 * sentences. Ordered heaviest first, so the first row of the panel is the
 * thing to fix first; OK_IMAGES closes the list when nothing about the
 * pictures is wrong.
 */
export function auditWeight(view: FirstView, sizes: ReadonlyMap<string, FileSize>): WeightAudit {
  const first_view: FirstViewItem[] = view.slots.map((s) => {
    const size = sizes.get(s.key);
    return {
      block_id: s.block_id,
      label_key: s.label_key,
      key: s.key,
      bytes: size ? size.bytes : null,
      mime: size ? size.mime : null,
      ...(s.product_id ? { product_id: s.product_id } : {}),
    };
  });
  const bytesOf = (slot: FirstViewSlot) => sizes.get(slot.key)?.bytes ?? 0;
  const mimeOf = (slot: FirstViewSlot) => sizes.get(slot.key)?.mime ?? null;
  const findings: SpeedFinding[] = [];

  // The hero family's PICTURES: the hero's own picture (or the poster of its
  // video), or the cover standing in for it. The 1.5 MB line is the picture
  // cap (owner question §D.8); a video's weight is named by the autoplay finding.
  const heroFamily = view.slots.filter((s) => s.kind === 'image' && (s.label_key === 'hero_image' || s.label_key === 'hero_poster' || s.label_key === 'banner'));
  for (const s of heroFamily) {
    if (mimeOf(s) === 'image/gif') findings.push({ code: 'HERO_GIF', block_id: s.block_id, params: { bytes: bytesOf(s) } });
  }
  for (const s of heroFamily) {
    if (bytesOf(s) > HERO_HEAVY_BYTES) findings.push({ code: 'HERO_HEAVY', block_id: s.block_id, params: { bytes: bytesOf(s), max_bytes: HERO_HEAVY_BYTES } });
  }

  if (view.background_video_on_phone) {
    const bg = view.slots.find((s) => s.label_key === 'background' && s.kind === 'video');
    findings.push({ code: 'BACKGROUND_VIDEO_ON_PHONE', block_id: BACKGROUND_SLOT, params: { bytes: bg ? bytesOf(bg) : 0 } });
  }

  const autoplay = view.slots.filter((s) => s.kind === 'video' && s.autoplay);
  if (autoplay.length) {
    findings.push({
      code: 'AUTOPLAY_VIDEO_COUNT',
      ...(autoplay.length === 1 ? { block_id: autoplay[0].block_id } : {}),
      params: { count: autoplay.length, bytes: autoplay.reduce((sum, s) => sum + bytesOf(s), 0) },
    });
  }

  for (const p of view.posterless) findings.push({ code: 'POSTER_MISSING', block_id: p.block_id, params: {} });

  const productPictures = view.slots.filter((s) => s.label_key === 'product_image' && sizes.has(s.key));
  if (productPictures.length) {
    const sum = productPictures.reduce((acc, s) => acc + bytesOf(s), 0);
    const avg = Math.round(sum / productPictures.length);
    if (avg > PRODUCT_IMAGE_LARGE_BYTES) {
      findings.push({
        code: 'PRODUCT_IMAGES_LARGE',
        ...(view.product_block_id ? { block_id: view.product_block_id } : {}),
        params: { avg_bytes: avg, count: productPictures.length, max_bytes: PRODUCT_IMAGE_LARGE_BYTES },
      });
    }
  }

  if (view.above_fold_blocks !== null && view.above_fold_blocks > ABOVE_FOLD_MAX_BLOCKS) {
    findings.push({ code: 'ABOVE_FOLD_BLOCKS', params: { count: view.above_fold_blocks, max: ABOVE_FOLD_MAX_BLOCKS } });
  }

  const measuredImages = view.slots.filter((s) => s.kind === 'image' && isImage(mimeOf(s)));
  const pictureTrouble = findings.some((f) => f.code === 'HERO_GIF' || f.code === 'HERO_HEAVY' || f.code === 'PRODUCT_IMAGES_LARGE');
  if (measuredImages.length && !pictureTrouble) {
    findings.push({ code: 'OK_IMAGES', params: { bytes: measuredImages.reduce((sum, s) => sum + bytesOf(s), 0), count: measuredImages.length } });
  }

  return { first_view, fixed: { app_kb: STOREFRONT_FIXED_KB, font_kb: STOREFRONT_FONT_KB }, findings };
}

/** What the ledger says the owner's files weigh — one statement, however many keys, through json_each. */
export async function fileSizesFor(db: D1Database, ownerId: string, keys: readonly string[]): Promise<Map<string, FileSize>> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT object_key, byte_size, mime_type FROM file_objects
        WHERE owner_id = ?1 AND deleted_at IS NULL AND object_key IN (SELECT value FROM json_each(?2))`
    )
    .bind(ownerId, JSON.stringify(unique))
    .all<{ object_key: string; byte_size: number; mime_type: string }>();
  return new Map((results ?? []).map((r) => [String(r.object_key), { bytes: n0(r.byte_size), mime: String(r.mime_type ?? '') }]));
}

/**
 * S4: the weight of a layout's first view for THIS store. `productsFirstRow`
 * is what `pickFirstProductRow` chose from the rows `blockDataFor` read (the
 * route does that; this stays free of the layout planner). Only the owner's
 * own ledger rows are consulted (`owner_id = store.user_id`), so a key that
 * is not theirs weighs nothing here — and never reaches anyone else.
 */
export async function auditLayoutWeight(
  db: D1Database,
  store: AuditStore,
  layout: StoreLayout,
  productsFirstRow: FirstProductRow | null,
  nowIso = ''
): Promise<WeightAudit> {
  const view = describeFirstView(store, layout, productsFirstRow, nowIso);
  const sizes = await fileSizesFor(db, store.user_id, view.slots.map((s) => s.key));
  return auditWeight(view, sizes);
}

/** The outbound lab check (S7): a link, never a fetch — the CSP's connect-src is not involved. */
export function pageSpeedUrl(storeUrl: string): string | null {
  if (!/^https:\/\//i.test(storeUrl)) return null;
  return `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(storeUrl)}`;
}
