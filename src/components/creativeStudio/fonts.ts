/**
 * THE STUDIO’S FONTS, LOADED ONLY WHEN THE STUDIO OPENS.
 *
 * IBM Plex Sans Arabic (400/600/700, complete builds, self-hosted under
 * public/fonts/ibm-plex-sans-arabic/ — see the LICENSE there) is registered
 * with the FontFace API here and nowhere else, so no storefront page ever
 * downloads it. Cairo is the site’s own font (declared in index.html, its
 * Kurdish patch face in src/index.css); the studio only waits for it.
 *
 * Nothing is measured, drawn or exported before every family/weight a
 * document uses has answered `document.fonts.load` with a real face. A face
 * that does not load is REPORTED (the quality check’s `font_not_loaded`
 * blocker, and a visible warning) — the browser’s fallback glyphs are never
 * passed off as the brand font.
 */
import { fontKey } from '../../../packages/creativeDoc/src/quality';
import { FONT_REGISTRY, type CreativeDocument, type FontFamilyId, type FontWeight } from '../../../packages/creativeDoc/src/schema';

export const PLEX_DIR = '/fonts/ibm-plex-sans-arabic';
export const PLEX_FILES: Readonly<Record<400 | 600 | 700, string>> = {
  400: 'IBMPlexSansArabic-Regular.woff2',
  600: 'IBMPlexSansArabic-SemiBold.woff2',
  700: 'IBMPlexSansArabic-Bold.woff2',
};

let registered = false;

/** Adds the Plex faces to `document.fonts` (once). They download on first use. */
export function registerStudioFonts(): void {
  if (registered || typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  registered = true;
  const family = FONT_REGISTRY['plex-arabic'].family;
  for (const [weight, file] of Object.entries(PLEX_FILES)) {
    const face = new FontFace(family, `url(${PLEX_DIR}/${file}) format('woff2')`, { weight, style: 'normal', display: 'block' });
    // `add` lives in lib.dom.iterable, which the tests' config does not load; the browser has it.
    (document.fonts as unknown as { add(f: FontFace): void }).add(face);
  }
}

export interface FontNeed {
  family: FontFamilyId;
  weight: FontWeight;
  /** The words drawn in it — `load` fetches exactly the subsets they need. */
  sample: string;
}

/** Every family/weight a document draws, with the text drawn in it. */
export function fontNeeds(doc: CreativeDocument): FontNeed[] {
  const byKey = new Map<string, FontNeed>();
  for (const l of doc.layers) {
    if (l.type !== 'text') continue;
    const key = `${l.font.family}|${l.font.weight}`;
    const prev = byKey.get(key);
    if (prev) prev.sample = (prev.sample + ' ' + l.text).slice(0, 2000);
    else byKey.set(key, { family: l.font.family, weight: l.font.weight, sample: l.text.slice(0, 2000) || 'ابجد' });
  }
  return [...byKey.values()];
}

/** Every registered weight of the kit’s two families, waited for before a layout is measured (a new design has no layers yet). */
export function kitFontNeeds(families: readonly FontFamilyId[], sample: string): FontNeed[] {
  const out: FontNeed[] = [];
  for (const family of new Set(families)) for (const weight of FONT_REGISTRY[family].weights) out.push({ family, weight, sample: sample.slice(0, 2000) || 'ابجد ABC 123' });
  return out;
}

export async function ensureNeeds(needs: readonly FontNeed[]): Promise<FontState> {
  registerStudioFonts();
  const state: FontState = { loaded: new Set(), failed: [] };
  if (typeof document === 'undefined' || !document.fonts) return state;
  await Promise.all(needs.map(async (need) => {
    const family = FONT_REGISTRY[need.family].family;
    try {
      const faces = await document.fonts.load(`${need.weight} 40px "${family}"`, need.sample);
      if (faces.length > 0 && faces.every((f) => f.status === 'loaded')) state.loaded.add(fontKey(family, need.weight));
      else state.failed.push(`${family} ${need.weight}`);
    } catch {
      state.failed.push(`${family} ${need.weight}`);
    }
  }));
  return state;
}

export interface FontState {
  /** `fontKey(cssFamily, weight)` for each face that really loaded — what qualityReport reads. */
  loaded: Set<string>;
  /** Human-readable `Family weight` of each face that did not. */
  failed: string[];
}

/**
 * Waits for every face the document needs. A load that rejects, or resolves
 * with no matching face (the browser would draw a fallback), is a failure.
 */
export async function ensureFonts(doc: CreativeDocument, previous?: FontState): Promise<FontState> {
  registerStudioFonts();
  const state: FontState = { loaded: new Set(previous?.loaded ?? []), failed: [] };
  if (typeof document === 'undefined' || !document.fonts) return state;
  await Promise.all(
    fontNeeds(doc).map(async (need) => {
      const family = FONT_REGISTRY[need.family].family;
      const key = fontKey(family, need.weight);
      if (state.loaded.has(key) && document.fonts.check(`${need.weight} 40px "${family}"`, need.sample)) return;
      state.loaded.delete(key);
      try {
        const faces = await document.fonts.load(`${need.weight} 40px "${family}"`, need.sample);
        const ok = faces.length > 0 && faces.every((f) => f.status === 'loaded');
        if (ok) state.loaded.add(key);
        else state.failed.push(`${family} ${need.weight}`);
      } catch {
        state.failed.push(`${family} ${need.weight}`);
      }
    }),
  );
  return state;
}
