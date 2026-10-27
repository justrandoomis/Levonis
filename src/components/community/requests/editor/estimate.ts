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
import { iqdUnit } from '../../../../lib/money';
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

/**
 * A line that mixes Arabic or Sorani with Latin names and figures, with every
 * Latin or number run isolated left to right (U+2066 … U+2069), so
 * «82×64×41 ملم», «قياسية · 0.20 mm» and «PETG + PLA» keep their order in a
 * right-to-left line (src/lib/bidi.ts explains the reordering). The same rule
 * as ui/BidiText `bidiContent`, as a string: importing that module from the
 * editor split its chunk, and the new chunk name landed in the entry preload
 * map the storefront payload has no room for (tests/bundleBudget.test.ts).
 */
export function isolateLtr(line: string): string {
  return String(line ?? '').replace(/[0-9A-Za-z](?:[0-9A-Za-z.,×\-–+/ ]*[0-9A-Za-z])?/g, (run) => `\u2066${run}\u2069`);
}

/** «45,000»: Latin digits in every language (plan R13), grouped. */
export const latinIqd = (iqd: number): string => Math.round(iqd).toLocaleString('en-US');

export function rangeText(low: number, high: number, lang: EditorLang): string {
  const a = latinIqd(low);
  const b = latinIqd(high);
  // The range is isolated left to right, so «22,000–28,000» never reads backwards in a right-to-left line.
  return low === high ? `${a} ${iqdUnit(lang)}` : `\u2066${a}–${b}\u2069 ${iqdUnit(lang)}`;
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
