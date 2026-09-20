/**
 * The browser's side of «سعّر بالغرامات» — POST /api/print-quote/grams-quote.
 *
 * WHY THE SHAPES ARE DECLARED HERE AND NOT IN `src/lib/printQuote.ts`.
 *
 * That module is the file-upload flow's client and is owned elsewhere; adding
 * to it would be two people editing one file for two unrelated reasons. The
 * shapes below are the SERVER's response shape written out locally, which is
 * the same discipline `src/lib/printQuote.ts` itself follows — a hand-written
 * mirror of what the Worker sends, so a field that disappears server-side
 * becomes a type error here rather than `undefined` on a screen.
 *
 * WHAT IS DELIBERATELY ABSENT: any price arithmetic. There is no rate, no
 * minimum and no multiplier in this file or in the panel that uses it. Every
 * figure shown is one `priceJob` produced, because a number the browser worked
 * out is a number that can disagree with the one the shop charges — the exact
 * failure `tests/printQuoteGrams.test.ts` pins down to the dinar.
 */
import { api } from '../../lib/api';

/** One line of the form: this much of this filament, in this colour. */
export interface GramsRowInput {
  material_id: string;
  grams: number;
  color_hex?: string;
}

export interface GramsQuoteRequest {
  printer_model_id: string;
  rows: GramsRowInput[];
  /**
   * Minutes the customer estimates the machine will run, or 0 when they did
   * not say. It is NOT derived from the grams anywhere: a 100 g solid cube and
   * a 100 g lattice are hours apart, so a figure invented from the weight would
   * be a fabricated number wearing an estimate's clothes.
   */
  print_minutes?: number;
  /**
   * «إكسسوارات ميكر وورد» — the hardware the model calls for, per printed part.
   * Counts only; the PRICE is the catalogue's and is applied server-side, so a
   * browser that guessed a figure could never disagree with the one charged.
   */
  accessories?: Array<{ id: string; qty: number }>;
}

export interface PricedAccessoryLine {
  id: string;
  qty: number;
  unit_iqd: number;
  iqd: number;
  name_ar: string;
  name_en: string;
  name_ckb: string;
  unit: 'piece' | 'pair' | 'set' | 'cm' | 'gram';
}

/**
 * §22's customer shape: a price, a range, machine hours and waste. No cost, no
 * margin, no component line — the server builds a physically different payload
 * for a merchant, so there is nothing here for a screen to leak.
 */
export interface GramsPublicQuote {
  confidence: 'exact' | 'estimated' | 'insufficient';
  price_iqd: number;
  range_iqd: { low: number; high: number };
  machine_hours: number;
  waste_grams: number;
  waste_percent: number;
  engine_version: number;
}

/**
 * WHAT THE PRICE COVERS, as codes.
 *
 * Codes rather than sentences because the store speaks three languages and the
 * Worker can only pick one. `material_only` is the flag the screen must never
 * ignore: a grams quote with no stated print time genuinely does not include
 * machine hours, and showing the number without saying so is how a customer
 * finds out half the cost was missing when the merchant's real offer arrives.
 */
export interface GramsCoverage {
  material_only: boolean;
  included: string[];
  excluded: string[];
}

export interface GramsQuoteResponse {
  success: true;
  quote: GramsPublicQuote;
  /** Echoed back by the server, so the panel renders what was PRICED rather
   *  than what is currently typed in the form. */
  rows: Array<{ material_id: string; material_type: string; color_hex: string; grams: number }>;
  grams_total: number;
  print_minutes: number;
  covers: GramsCoverage;
  /** Echoed like `rows`: what the engine actually PRICED, not what is typed. */
  accessories: PricedAccessoryLine[];
  /** Ids the catalogue no longer has. Shown, never swallowed — a customer
   *  whose menu is stale must know their magnet was not counted. */
  accessories_unknown: string[];
  accessories_iqd: number;
}

export const quoteByGrams = (body: GramsQuoteRequest, signal?: AbortSignal) =>
  api.post<GramsQuoteResponse>('/api/print-quote/grams-quote', body, { signal });
