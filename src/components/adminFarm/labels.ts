/**
 * The bridge between a dotted config path and the words the admin reads:
 * `labelCandidates` (schema.ts) decides the lookup order, `LABELS`
 * (strings.ts) holds the curated trilingual copy, and a key nobody curated is
 * humanised from its own name so an engine field added tomorrow is still
 * editable today. No React here — tests import this directly.
 */
import type { Language } from '../../translations';
import { humanize, labelCandidates } from './schema';
import { LABELS, type FieldLabel } from './strings';

export interface ResolvedLabel {
  /** In the UI language. */
  label: string;
  /** The same label in the OTHER main language (English, or Arabic when the UI is English). */
  secondary?: string;
  hint?: string;
  /** False when the label was humanised from the key rather than written by hand. */
  curated: boolean;
}

/** The first curated entry matching the path's candidates, most specific first. */
export function findLabel(path: string): FieldLabel | undefined {
  for (const c of labelCandidates(path)) {
    const hit = LABELS[c];
    if (hit) return hit;
  }
  return undefined;
}

export function labelFor(path: string, lang: Language): ResolvedLabel {
  const hit = findLabel(path);
  if (!hit) {
    const last = path.split('.').pop() ?? path;
    return { label: humanize(last), curated: false };
  }
  const primary = hit[lang];
  const secondary = lang === 'en' ? hit.ar : hit.en;
  return {
    label: primary,
    secondary: secondary && secondary !== primary ? secondary : undefined,
    hint: hit.hint?.[lang],
    curated: true,
  };
}
