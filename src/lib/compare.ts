import { api, type RequestOptions } from './api';
import type { CompareLens, CompareLensId } from '../../packages/catalog/src/discoveryTypes';

/**
 * THE COMPARISON, AS THE BROWSER SEES IT — the wire shapes and the two calls.
 *
 * WHY THE TYPES ARE RE-DECLARED HERE instead of imported. `worker/` is
 * `exclude`d from `tsconfig.json` (the browser config), because worker code
 * needs the Workers runtime types this one does not have. So the page cannot
 * `import type { CompareResult } from '../../worker/lib/compareSpecs'` — the
 * wall is deliberate, and this file is the one place that pays for it. Every
 * field below is a verbatim copy of an exported interface in
 * `worker/lib/compareSpecs.ts` / `worker/routes/compare.ts`; changing one there
 * without changing it here is a silent break, so the shapes are kept minimal
 * and no field is invented on this side.
 *
 * WHAT THIS FILE REFUSES TO DO. It does not score, rank, invert an axis or
 * compute a price. The server already did all four, and a second opinion in the
 * browser is how a page comes to disagree with its own verdict — a customer who
 * reads «الأرخص» on one row and a different cheapest machine in the band above
 * stops believing either. The only arithmetic here is `priceDeltas`, and it is
 * derived from the very numbers the price row is rendered from (the server's
 * own comment says the difference is meant to be derived, precisely so it
 * cannot drift into a second field).
 */

// ------------------------------------------------------------- wire shapes

export interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

export type CompareLang = 'ar' | 'en' | 'ckb';

/** Pick a trilingual label for the reader. ckb falls back to Arabic, the
 *  source language — the same substitution `LanguageContext.loc` makes. */
export function tri(value: Trilingual | undefined, lang: CompareLang): string {
  if (!value) return '';
  if (lang === 'en') return value.en || value.ar;
  if (lang === 'ckb') return value.ckb || value.ar || value.en;
  return value.ar || value.en;
}

export type SpecParse = 'number' | 'dimensions' | 'range' | 'boolean' | 'list' | 'text';
export type SpecBetter = 'higher' | 'lower' | 'none';
export type CompareBasis = 'same_section' | 'same_type' | 'mixed';

export interface CompareValue {
  raw: string;
  /** The comparable reading, or null when absent or unparseable. */
  num: number | null;
  /** Display string with the unit already applied. Empty when `missing`. */
  text: string;
  /** No value recorded. NEVER a loss — see `worker/lib/compareSpecs.ts` D1. */
  missing: boolean;
  axes?: number[];
  items?: string[];
}

export interface CompareRow {
  field_id: string;
  label: Trilingual;
  unit: string;
  parse: SpecParse;
  better: SpecBetter;
  /** Per product, in the order the ids were requested. */
  values: CompareValue[];
  winners: number[];
  losers?: number[];
  /** 0 = shown, never scored. The price row is always 0. */
  weight?: number;
  decisive: boolean;
}

export interface CompareGroup {
  id: string;
  label: Trilingual;
  /** Both sides were ASKED these questions — not that both answered them. */
  shared: boolean;
  rows: CompareRow[];
}

export interface CompareVerdict {
  scores: number[];
  /** Per product, the field_ids it wins. */
  wins: string[][];
  /** Per product, the field_ids it loses — «وهذه ما لا تتفوق عليه». */
  losses: string[][];
  /** Rows nobody could be scored on because somebody had no value. */
  unscored: string[];
}

export interface CompareAxis {
  field_id: string;
  label: Trilingual;
}

export interface CompareResult {
  basis: CompareBasis;
  basis_label: Trilingual;
  groups: CompareGroup[];
  verdict: CompareVerdict;
  /** Normalised 0..1, `series[productIndex][axisIndex]`, always further = better. */
  chart: { axes: CompareAxis[]; series: number[][] };
  /**
   * «أفضل لـ» — one verdict per buyer's question, printers and lasers only,
   * computed by the server (worker/lib/compareLenses.ts). Absent or empty for
   * anything else (a filament comparison has no lens row).
   */
  lenses?: CompareLens[];
}

export interface CompareProductCard {
  id: string;
  slug: string;
  name: Trilingual;
  image: string | null;
  /** «الصورة الرئيسية للوضع الفاتح» (migration 0138), only when the product has one. */
  light_image?: string;
  /** The BASE price — the cheapest way to buy it. A «يبدأ من» figure. */
  price_iqd: number;
  /** Mirrors `ProductTypeId` in worker/lib/templateFamilies.ts — the laser
   *  machine and the laser/blade consumable are the two the line added. */
  product_type: 'printer' | 'parts' | 'filament' | 'accessory' | 'laser' | 'laser_material' | null;
  section: { id: string; slug: string; label: Trilingual } | null;
  brand_id: string | null;
  /** Open box / used / refurbished. A comparison that hides this calls a used
   *  machine cheaper than a new one. */
  graded: boolean;
  /** ON A COMPARISON COLUMN ONLY: the product, when `id` is a slot key
   *  (`productId:optionId`) rather than a product id. */
  product_id?: string;
  /** ON A COMPARISON COLUMN ONLY: the option this column is priced as. */
  option?: { id: string; label: Trilingual } | null;
  /** ON A PICKER CARD ONLY, and only when there are at least two: what this
   *  product can be added AS. «خاصه الطابعات التي تحمل ليزر او كومبو فيه جهاز
   *  ams فهذا يفرق.» */
  options?: Array<{ id: string; label: Trilingual }>;
}

/**
 * ONE ORDERED POINT OF THE POWER ANSWER. Points, not a table: «لا يتم وضعها
 * بشكل جداول وهوسه وخربطه». Mirrors `PowerPoint` in worker/lib/powerAdvice.ts.
 */
export interface PowerPoint {
  id: string;
  text: Trilingual;
}

/** An assumption the arithmetic rests on, shipped so the page can print the
 *  working beside the answer rather than handing over an oracle. */
export interface PowerAssumption {
  id: string;
  /** The value as the reader should see it — "220 V", "0.6", "50–80%". */
  value: string;
  text: Trilingual;
}

/**
 * The mains answer for ONE column — «كم تستهلك الطابعة … وكم تحتاج من الـ UPS».
 *
 * Only the fields this page renders are copied, per the file header's rule: the
 * server object also carries the per-reading watts and amps, the runtime table
 * and the breaker figure, and the page draws none of them directly because
 * every one of them is already a sentence in `points`, WITH its caveat
 * attached. Picking a bare number off this object and rendering it without the
 * sentence is precisely what the module's own comments forbid — a UPS size or
 * an MCB rating with the caveat left behind in TypeScript.
 *
 * `known: false` means nobody entered a wattage. The page then renders NOTHING:
 * a power section assembled out of «غير مذكور» reads as a statement about the
 * machine, and it is a statement about our data entry.
 */
export interface PowerAdvice {
  known: boolean;
  points: PowerPoint[];
  assumptions: PowerAssumption[];
}

export interface CompareResponse {
  success: true;
  products: CompareProductCard[];
  /**
   * The power advice, ALIGNED INDEX-FOR-INDEX with `products`, and present for
   * a single column too — the mains question is worth answering about one
   * machine. It is a top-level key rather than a field on the card because
   * `CompareProductCard` is also what /candidates returns up to 120 of.
   */
  power?: PowerAdvice[];
  /** null for a single product: a comparison of one is not a comparison. */
  comparison: CompareResult | null;
}

export interface CandidatesResponse {
  success: true;
  /** The anchor's own card, which is why this call can also fill an empty page.
   *  NULL when no anchor was given — the «إضافة طابعة» path, where the list is
   *  the catalogue rather than "machines like this one". */
  for: CompareProductCard | null;
  products: CompareProductCard[];
}

// -------------------------------------------------------------- the calls

/**
 * Mirrors `MAX_COMPARE_IDS` in `worker/routes/compare.ts`.
 *
 * THE SERVER IS THE AUTHORITY and refuses a fifth id by name
 * (`COMPARE_TOO_MANY`). This constant exists only so the page can stop
 * OFFERING a fifth slot — an "add" button that always ends in a refusal is a
 * worse answer than a button that is not there.
 */
export const MAX_COMPARE_IDS = 4;

export function fetchComparison(ids: string[], opts?: RequestOptions): Promise<CompareResponse> {
  return api.get<CompareResponse>(`/api/compare?ids=${encodeURIComponent(ids.join(','))}`, opts);
}

/**
 * `anchorId` MAY BE NULL, and that is the «زر لاضافه الطابعه».
 *
 * With a machine placed, the list is "what is worth comparing with this one".
 * With none — a first visit, cleared storage, or someone who wants a machine
 * unlike the one they were reading — the server answers with the catalogue,
 * newest first, narrowed by whatever was typed. Without this the comparison
 * page could only ever be started from a product page.
 */
export function fetchCandidates(
  anchorId: string | null,
  q: string,
  opts?: RequestOptions
): Promise<CandidatesResponse> {
  const params = new URLSearchParams();
  if (anchorId) params.set('for', anchorId);
  if (q.trim()) params.set('q', q.trim());
  const query = params.toString();
  return api.get<CandidatesResponse>(`/api/compare/candidates${query ? `?${query}` : ''}`, opts);
}

// ------------------------------------------------------------ the URL is it

/**
 * THE IDS LIVE IN THE URL, so a comparison is a LINK someone can send.
 *
 * Read and write go through this pair rather than through ad-hoc `split(',')`
 * at four call sites, because the two halves have to agree exactly: a page that
 * writes `a,b` and reads `a, b` renders a column for a product id with a space
 * in it and then asks the server about it.
 *
 * De-duplication happens on read AND on write. Two links to the same printer is
 * a mistake nobody needs to be told about, and a product compared against
 * itself is a page of ties.
 */
export function readIds(search: URLSearchParams | string): string[] {
  const raw = typeof search === 'string' ? search : search.get('ids') ?? '';
  const out: string[] = [];
  for (const piece of String(raw).split(',')) {
    const id = piece.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  // DELIBERATELY NOT CAPPED HERE. A hand-made link carrying six ids would, if
  // silently trimmed to four, render four columns under a URL that names six —
  // and the reader would have no way to know which two vanished. The server
  // refuses the whole request by name instead (`COMPARE_TOO_MANY`), which the
  // page shows with its own message and a way out. The cap this page DOES
  // enforce is on what it offers: the add button disappears at four.
  return out;
}

/** The `?ids=` value for a set of columns, or '' when there are none. */
export function writeIds(ids: string[]): string {
  return readIds(ids.join(',')).join(',');
}

// --------------------------------------------------------------- reading it

/**
 * THE NAME OF A COLUMN, which is not always the name of a product.
 *
 * «يقارن بين طابعه ونفس الطابعه لكن الخيار يختلف.» Two columns of one printer
 * under two options would otherwise print the same name twice, with two
 * different prices and nothing on screen saying why. The option is appended
 * with a middle dot — «X1C · كومبو» — rather than in brackets, because it is a
 * continuation of the name, not an aside about it, and the dot reads the same
 * in both writing directions.
 *
 * A column with no option is the product's own name, unchanged. Everywhere a
 * column is named goes through here, so the legend, the verdict, the table
 * headers, the price row and the slot list cannot label the same column three
 * different ways.
 */
export function columnName(card: CompareProductCard, lang: CompareLang): string {
  const base = tri(card.name, lang);
  return card.option ? `${base} · ${tri(card.option.label, lang)}` : base;
}

/**
 * field_id → the WHOLE ROW, so a caller can read the typed value behind a
 * chart axis rather than re-deriving one.
 *
 * «بالإضافة إلى الشريط اجعل هنالك رقما يكتب … أمامه رقم وليس فقط شريط.» The
 * chart's own `series` is a 0..1 RATIO against the best answer on that axis,
 * which is the right number for the length of a bar and the wrong one to print
 * — «78%» of what, exactly. The figure a reader wants is «32 mm³/s», and the
 * only place it exists is the row the server already sent, with its unit
 * already applied. Reading it from there is also what keeps the chart and the
 * table below it from ever disagreeing.
 */
export function rowIndex(result: CompareResult): Map<string, CompareRow> {
  const out = new Map<string, CompareRow>();
  for (const group of result.groups) for (const row of group.rows) out.set(row.field_id, row);
  return out;
}

/** field_id → label, for the verdict's win/loss lists and the chart legend. */
export function labelIndex(result: CompareResult): Map<string, Trilingual> {
  const out = new Map<string, Trilingual>();
  for (const group of result.groups) for (const row of group.rows) out.set(row.field_id, row.label);
  return out;
}

/** The synthetic price row the server emits as `groups[0]`. Found by id rather
 *  than by position, so a future group inserted before it cannot make the page
 *  render a spec row as the price. */
export function priceRow(result: CompareResult): CompareRow | null {
  const group = result.groups.find((g) => g.id === 'price');
  return group?.rows[0] ?? null;
}

/** Every group except the price one, shared first — the reading order the
 *  table uses. `shared` is the server's word for "both sides were asked these
 *  questions", so an FDM-only group sorts after and is labelled as its own. */
export function specGroups(result: CompareResult): CompareGroup[] {
  const groups = result.groups.filter((g) => g.id !== 'price');
  return [...groups.filter((g) => g.shared), ...groups.filter((g) => !g.shared)];
}

export interface PriceDelta {
  /** true for every product that ties the lowest price. */
  cheapest: boolean;
  /** IQD above the cheapest. 0 for the cheapest, null when no price recorded. */
  moreIqd: number | null;
  /** Per cent above the cheapest, rounded. null when it cannot be expressed. */
  morePercent: number | null;
}

/**
 * THE DIFFERENCE, DERIVED FROM THE ROW THE PAGE IS RENDERING.
 *
 * `worker/lib/compareSpecs.ts` deliberately does not freeze this into a second
 * field: "derivable, and deliberately not frozen into a second field that could
 * disagree with the row". So it is computed here from `row.values[i].num` —
 * the same numbers `row.values[i].text` was printed from — and from nothing
 * else. Never from the product cards, which are a different read.
 */
export function priceDeltas(row: CompareRow): PriceDelta[] {
  const nums = row.values.map((v) => v.num);
  const present = nums.filter((n): n is number => n !== null && n > 0);
  if (present.length === 0) {
    return nums.map(() => ({ cheapest: false, moreIqd: null, morePercent: null }));
  }
  const base = Math.min(...present);
  return nums.map((n) => {
    if (n === null || n <= 0) return { cheapest: false, moreIqd: null, morePercent: null };
    const more = n - base;
    return {
      cheapest: more === 0,
      moreIqd: more,
      morePercent: base > 0 ? Math.round((more / base) * 100) : null,
    };
  });
}

/**
 * Does this row say anything different about the products?
 *
 * THE «الفروقات فقط» FILTER RESTS ON THIS, and it is deliberately NOT
 * `row.decisive`. `decisive` means "everybody answered AND the answers differ",
 * which is the right test for scoring and for a chart axis — but for a reader
 * scanning for differences, «A: 300 °C / B: غير مذكور» IS one of the most
 * important rows on the page. Hiding it would hide the gap the filter exists to
 * surface.
 *
 * The equality test mirrors the server's own `readingsDiffer`: numbers when
 * every product produced one, normalised raw text otherwise — with a missing
 * value as its own distinct key, so present-versus-absent always counts as a
 * difference.
 */
export function rowDiffers(row: CompareRow): boolean {
  if (row.values.length < 2) return false;
  if (row.values.every((v) => !v.missing && v.num !== null)) {
    const first = row.values[0].num as number;
    return row.values.some((v) => (v.num as number) !== first);
  }
  const keys = new Set(
    row.values.map((v) => (v.missing ? '\u0000' : v.raw.trim().toLowerCase().replace(/\s+/g, ' ')))
  );
  return keys.size > 1;
}

export type RowScoring = 'winner' | 'tie' | 'unscored' | 'informational';

/**
 * WHY A ROW PRODUCED NO WINNER, named rather than left blank.
 *
 * Three very different situations look identical in the data — a tie, a gap in
 * the shop's own data entry, and a field nobody ever annotated as comparable —
 * and a reader who cannot tell them apart reads all three as "this machine
 * lost". Each gets its own chip on the row.
 */
export function rowScoring(row: CompareRow): RowScoring {
  if (row.better === 'none' || (row.weight ?? 0) === 0) return 'informational';
  if (row.values.some((v) => v.missing || v.num === null)) return 'unscored';
  return row.winners.length > 0 ? 'winner' : 'tie';
}

/** The product indexes sharing the top score, or [] when nobody leads. */
export function leaders(verdict: CompareVerdict): number[] {
  const best = Math.max(...verdict.scores, 0);
  if (best <= 0) return [];
  return verdict.scores.flatMap((s, i) => (s === best ? [i] : []));
}

// ---------------------------------------------------- «أفضل لـ» and the table

export type { CompareLens, CompareLensId };

/** The lens order the page draws (the server's LENS_ORDER). */
export const LENS_IDS: readonly CompareLensId[] = ['business', 'beginners', 'value', 'multicolor', 'precision'];

/** `?lens=` → a lens id, or null for «الكل» / anything unknown. */
export function readLens(search: URLSearchParams | string): CompareLensId | null {
  const raw = typeof search === 'string' ? search : search.get('lens') ?? '';
  return (LENS_IDS as readonly string[]).includes(raw) ? (raw as CompareLensId) : null;
}

/**
 * THE ROWS EACH LENS WEIGHS — the fields worker/lib/compareLenses.ts reads, so
 * choosing «للأعمال» tints the rows its verdict rests on. This is a pointer to
 * the evidence, not a rule: the page scores nothing (see the file header).
 */
export const LENS_FIELDS: Readonly<Record<CompareLensId, readonly string[]>> = {
  business: ['print_speed', 'max_acceleration', 'build_volume', 'enclosed', 'print_failure_detection', 'air_filtration', 'warranty'],
  beginners: ['skill_level', 'assembly', 'auto_leveling', 'filament_sensor', 'power_loss_recovery', 'camera'],
  value: ['price_iqd'],
  multicolor: ['max_colors', 'extruders'],
  precision: ['min_layer_height', 'z_accuracy', 'xy_resolution'],
};

/** «الفروقات فقط» starts ON for three or more columns (CATALOG_DISCOVERY §10.1). */
export const diffOnlyByDefault = (columns: number): boolean => columns >= 3;

/** How many spec rows «الفروقات فقط» hides: every value the same. The price row is never counted. */
export function identicalRowCount(result: CompareResult): number {
  return specGroups(result).reduce((n, g) => n + g.rows.filter((r) => !rowDiffers(r)).length, 0);
}

/**
 * THE LENGTH OF A ROW'S BAR for column `i`, 0..1, or null when the row gets no
 * bar. Only rows the server SCORES in a direction get one (`number` and
 * `dimensions` with `better` higher or lower), and only a column with a
 * reading: a missing value draws no bar at all (never a zero-length "loss").
 *
 *   higher is better → value / max
 *   lower is better  → min / value   (the finest reading is the full bar)
 *
 * Computed from `row.values[i].num` — the numbers the cells are printed from —
 * so a bar can never disagree with its label.
 */
export function barRatio(row: CompareRow, i: number): number | null {
  if (row.parse !== 'number' && row.parse !== 'dimensions') return null;
  // A year is a name, not a quantity: 2025 is not «99.95% of» 2026.
  if (NO_BAR_FIELDS.has(row.field_id)) return null;
  if (row.better !== 'higher' && row.better !== 'lower') return null;
  const nums = row.values.map((v) => (v.missing || v.num === null || !(v.num > 0) ? null : v.num));
  const mine = nums[i];
  if (mine === null || mine === undefined) return null;
  const known = nums.filter((n): n is number => n !== null);
  if (known.length < 2) return null;
  if (row.better === 'higher') return mine / Math.max(...known);
  return Math.min(...known) / mine;
}

/** Numeric rows that are labels rather than magnitudes. */
const NO_BAR_FIELDS = new Set(['release_year']);

/** Whether a row draws bars at all (two or more columns have a reading). */
export const rowHasBars = (row: CompareRow): boolean => row.values.some((_, i) => barRatio(row, i) !== null);

/** A `dimensions` reading in mm with three axes → litres, for the sub-line («37.0 لتر»). */
export function litres(row: CompareRow, i: number): number | null {
  if (row.parse !== 'dimensions') return null;
  const v = row.values[i];
  if (!v || v.missing || !v.axes || v.axes.length !== 3 || row.unit.trim().toLowerCase() !== 'mm') return null;
  const [a, b, c] = v.axes;
  const l = (a * b * c) / 1_000_000;
  return Number.isFinite(l) && l > 0 ? Math.round(l * 10) / 10 : null;
}

export type RowHint = 'higher' | 'lower' | 'informational' | 'unscored';

/**
 * The direction hint under a row label — «الأعلى أفضل», «الأقل أفضل», «للمعلومة،
 * لا يُحتسب», or «لا يُحتسب: قيمة غير مذكورة» — from the server's own fields.
 */
export function rowHint(row: CompareRow): RowHint {
  const scoring = rowScoring(row);
  if (scoring === 'informational') return 'informational';
  if (scoring === 'unscored') return 'unscored';
  return row.better === 'lower' ? 'lower' : 'higher';
}

/**
 * REORDER: move column `from` by `delta` (−1 toward the start, +1 toward the
 * end), clamped. Returns a new list; the same list when nothing moves.
 */
export function moveColumn(ids: readonly string[], from: number, delta: -1 | 1): string[] {
  const to = from + delta;
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The lens with this id, when the comparison carries it. */
export function lensById(result: CompareResult | null, id: CompareLensId | null): CompareLens | null {
  if (!result || !id) return null;
  return (result.lenses ?? []).find((l) => l.id === id) ?? null;
}
