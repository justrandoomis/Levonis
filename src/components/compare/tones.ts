/**
 * ONE COLOUR PER MACHINE, EVERYWHERE ON THE PAGE.
 *
 * A comparison of four columns is a page where the reader is constantly asking
 * "which one was that again?" — in the verdict band, in the chart, on a winning
 * cell, in the picker. Giving each product a colour it keeps from the top of
 * the page to the bottom answers that question without a legend and without a
 * lookup, which is most of the difference between «سهل وسلس» and «متشابكة».
 *
 * THE FOUR ARE EXISTING TOKENS (src/index.css `@theme`), not new brand colours:
 * gold is already the app's accent and selected state, and info / success /
 * warning are already the status hues. Gold comes first because the first
 * column is the machine the visitor arrived with.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every place a tone appears also carries the
 * product's name or a text label — a reader who cannot distinguish these four
 * hues loses a convenience, never the meaning.
 */
export interface ProductTone {
  /** The solid colour: a dot, a bar, a winner mark. */
  color: string;
  /** A tint of it for a surface, faint enough to read text on. */
  tint: string;
  /** A border at the strength this system uses for an accented edge. */
  edge: string;
}

const tone = (token: string): ProductTone => ({
  color: `var(${token})`,
  tint: `color-mix(in oklab, var(${token}) 14%, var(--color-surface))`,
  edge: `color-mix(in oklab, var(${token}) 38%, transparent)`,
});

const TONES: ProductTone[] = [
  tone('--color-gold'),
  tone('--color-info'),
  tone('--color-success'),
  tone('--color-warning'),
];

/** The tone for a column. Wraps rather than throwing: the server caps the
 *  comparison at four, and a fifth column would be a bug, not a crash. */
export function productTone(index: number): ProductTone {
  return TONES[((index % TONES.length) + TONES.length) % TONES.length];
}
