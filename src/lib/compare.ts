import { api, type RequestOptions } from './api';

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
}

export interface CompareProductCard {
  id: string;
  slug: string;
  name: Trilingual;
  image: string | null;
  /** The BASE price — the cheapest way to buy it. A «يبدأ من» figure. */
  price_iqd: number;
  product_type: 'printer' | 'parts' | 'filament' | 'accessory' | null;
  section: { id: string; slug: string; label: Trilingual } | null;
  brand_id: string | null;
  /** Open box / used / refurbished. A comparison that hides this calls a used
   *  machine cheaper than a new one. */
  graded: boolean;
}

export interface CompareResponse {
  success: true;
  products: CompareProductCard[];
  /** null for a single product: a comparison of one is not a comparison. */
  comparison: CompareResult | null;
}

export interface CandidatesResponse {
  success: true;
  /** The anchor's own card, which is why this call can also fill an empty page. */
  for: CompareProductCard;
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

export function fetchCandidates(
  anchorId: string,
  q: string,
  opts?: RequestOptions
): Promise<CandidatesResponse> {
  const query = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : '';
  return api.get<CandidatesResponse>(
    `/api/compare/candidates?for=${encodeURIComponent(anchorId)}${query}`,
    opts
  );
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
