/**
 * THE ESTIMATE OF EACH PART (plan P1-06; design §6.1; P1-05 row 267).
 *
 * `/quote` with the editor’s body and the draft named answers either one job
 * (a single part in one material: the engine’s own range) or the job part
 * by part, with what the total covers (`coverage`): the priced parts with
 * their ranges, the unpriced ones with a reason — no measured model
 * (NO_GEOMETRY), no material (MATERIAL_UNKNOWN) — or with the refusal a
 * publish would answer (`refusal`, e.g. PART_RESIN_MULTI_MATERIAL). Each card
 * shows its own line, so a part the publish would refuse is visible before
 * the publish. Parts are matched by their place in the body: a new part has
 * no id the server keeps between two estimates. Pure.
 */
import { iqdNumber, iqdUnit } from '../../../../lib/money';
import { refusalText } from '../../../../lib/refusalStrings';
import type { Quote } from '../api';
import type { PartEstimate } from './PartCard';
import { fill, type EditorLang, type EditorStrings } from './strings';

interface CoveredPart {
  position: number;
  price_low_iqd: number;
  price_high_iqd: number;
}
interface UncoveredPart {
  position: number;
  reason?: string;
  refusal?: string;
}

export function rangeText(low: number, high: number, lang: EditorLang): string {
  const a = iqdNumber(low, lang);
  const b = iqdNumber(high, lang);
  return low === high ? `${a} ${iqdUnit(lang)}` : `${a}–${b} ${iqdUnit(lang)}`;
}

function reasonText(reason: string | undefined, refusal: string | undefined, lang: EditorLang, t: EditorStrings): string {
  if (refusal) return refusalText(refusal, lang, refusal === 'PART_MATERIAL_UNKNOWN' ? t.materialOutOfCatalogue : t.materialUnknownPrice) || t.materialUnknownPrice;
  if (reason === 'MATERIAL_UNKNOWN') return t.materialUnknownPrice;
  return t.noGeometry;
}

/** Each part’s line, by its place in the body. Empty while there is no estimate. */
export function partEstimates(quote: Quote | null, partsCount: number, lang: EditorLang, t: EditorStrings): Map<number, PartEstimate> {
  const out = new Map<number, PartEstimate>();
  if (!quote) return out;
  const cov = quote.coverage as (Quote['coverage'] & { priced_parts?: CoveredPart[]; unpriced_parts?: UncoveredPart[] }) | undefined;
  if (cov && Array.isArray(cov.priced_parts)) {
    for (const p of cov.priced_parts as CoveredPart[]) {
      out.set(p.position, { kind: 'priced', text: fill(t.partEstimate, { range: rangeText(p.price_low_iqd, p.price_high_iqd, lang) }) });
    }
    for (const p of (cov.unpriced_parts ?? []) as UncoveredPart[]) {
      out.set(p.position, { kind: 'unpriced', text: fill(t.partUnpriced, { reason: reasonText(p.reason, p.refusal, lang, t) }) });
    }
    return out;
  }
  // One job: its range is the one part’s.
  if (partsCount === 1) {
    out.set(
      0,
      quote.priced
        ? { kind: 'priced', text: fill(t.partEstimate, { range: rangeText(quote.price_low_iqd, quote.price_high_iqd, lang) }) }
        : { kind: 'unpriced', text: fill(t.partUnpriced, { reason: reasonText(quote.reason, undefined, lang, t) }) }
    );
  }
  return out;
}
