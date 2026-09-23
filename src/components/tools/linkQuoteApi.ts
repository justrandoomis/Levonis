/**
 * The browser's side of «أو الصق رابط المجسم» — POST /api/print-quote/link.
 *
 * A hand-written mirror of what the Worker sends (worker/routes/printQuote.ts,
 * the `/link` route), in the same discipline as `gramsQuoteApi.ts`: a field
 * that disappears server-side becomes a type error here, not `undefined` on a
 * screen. No price arithmetic lives here — a resolved link is priced by the
 * same engine as the grams door, and the screen only prints what it returned.
 */
import { api } from '../../lib/api';
import type { GramsCoverage, GramsPublicQuote } from './gramsQuoteApi';

/** What the URL alone says — always available, no request to the site. */
export interface ParsedModelLink {
  /** 'makerworld' | 'printables' | 'thingiverse' | 'thangs' | 'cults3d' | '' */
  provider: string;
  external_id: string;
  canonical_url: string;
  host: string;
}

/** What the site's own API said, when the owner configured one. */
export interface ModelLinkInfo {
  resolved: boolean;
  /** NO_API_CONFIGURED, PROVIDER_NOT_ENABLED, NO_MODEL_ID_IN_URL, TIMEOUT… */
  reason?: string;
  provider: string;
  external_id: string;
  url: string;
  name?: string;
  creator?: string;
  images?: string[];
  estimated_weight_g?: number;
  estimated_time_minutes?: number;
}

/**
 * `quote` is null unless the site's API gave a weight; the three figures
 * beside it arrive only with a quote.
 */
export interface LinkQuoteResponse {
  success: true;
  link: ParsedModelLink;
  info: ModelLinkInfo;
  quote: GramsPublicQuote | null;
  grams_total?: number;
  print_minutes?: number;
  covers?: GramsCoverage;
}

export const quoteByLink = (
  body: { url: string; printer_model_id: string; material_id: string },
  signal?: AbortSignal
) => api.post<LinkQuoteResponse>('/api/print-quote/link', body, { signal });

/** The site's own name, for a sentence a customer reads. */
export function providerName(provider: string, host: string): string {
  const known: Record<string, string> = {
    makerworld: 'MakerWorld',
    printables: 'Printables',
    thingiverse: 'Thingiverse',
    thangs: 'Thangs',
    cults3d: 'Cults3D',
  };
  return known[provider] ?? host;
}
