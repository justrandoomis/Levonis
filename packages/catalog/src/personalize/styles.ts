/**
 * THE SIX TEXT STYLES — Fun · Gaming · Elegant · Kids · Minimal · Bold (the
 * owner's brief; survey §5.2 «Decals»: presets of weight, tracking, outline,
 * shadow and skew; per-glyph jitter only for scripts that do not join).
 *
 * Units: `tracking`, `outline`, `shadow` and `jitter` in em of the font size,
 * `skew` the horizontal shear per unit of height (0.14 ≈ 8°, leaning forward
 * in the reading direction), `weight` a Cairo weight (300–900).
 * Tracking and jitter apply only to a line without Arabic letters: spacing or
 * bouncing joined letters breaks them apart, so the studio draws such a line
 * with neither and fit.ts measures it the same way.
 *
 * STYLE_LADDER is the order Smart Fit climbs when strokes would print too
 * thin (fit.ts): lightest first, each weight at least the one before.
 */
import type { Area, StyleKey } from './types';

export interface StylePreset {
  weight: number;
  tracking: number;
  outline: number;
  shadow: number;
  skew: number;
  jitter: number;
}

export const STYLE_PRESETS: Readonly<Record<StyleKey, StylePreset>> = {
  fun: { weight: 700, tracking: 0.02, outline: 0, shadow: 0.05, skew: 0, jitter: 0.06 },
  gaming: { weight: 800, tracking: 0.04, outline: 0.04, shadow: 0, skew: 0.14, jitter: 0 },
  elegant: { weight: 300, tracking: 0.08, outline: 0, shadow: 0, skew: 0, jitter: 0 },
  kids: { weight: 800, tracking: 0.03, outline: 0.05, shadow: 0.04, skew: 0, jitter: 0.1 },
  minimal: { weight: 400, tracking: 0.02, outline: 0, shadow: 0, skew: 0, jitter: 0 },
  bold: { weight: 900, tracking: 0, outline: 0, shadow: 0, skew: 0, jitter: 0 },
};

/** Lightest first — the ladder Smart Fit climbs for a bolder style. */
export const STYLE_LADDER: readonly StyleKey[] = ['elegant', 'minimal', 'fun', 'gaming', 'kids', 'bold'];

/** The styles a text area offers, in ladder order; [] for any other area. */
export function stylesFor(area: Pick<Area, 'text'>): StyleKey[] {
  const allowed = area.text?.styles;
  if (!allowed) return [];
  return STYLE_LADDER.filter((s) => allowed === 'all' || allowed.includes(s));
}

/**
 * What a style adds around the glyphs' advances, in em: `x` to a line's
 * width (both outlines, the shadow, the lean over the line's height), `y` to
 * its height (both outlines, the shadow, the bounce up and down).
 */
export function styleBox(style: StyleKey, lineEm: number): { x: number; y: number } {
  const s = STYLE_PRESETS[style];
  return {
    x: 2 * s.outline + s.shadow + Math.abs(s.skew) * lineEm,
    y: 2 * s.outline + s.shadow + 2 * s.jitter,
  };
}
