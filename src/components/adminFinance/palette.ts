/**
 * THE DASHBOARD'S CHART COLOURS — validated, not eyeballed.
 *
 * Every hex in this file came out of the documented data-viz palette and was
 * put through `scripts/validate_palette.js` against THIS store's surfaces
 * before a single chart was drawn. The store is black (`--color-canvas`
 * #0b0c0f, cards `--color-surface` #131519), so the DARK column is the one
 * that applies and the light steps of that palette are not in this file at
 * all: a hue stepped for a white page sits outside the dark lightness band and
 * stops doing identity work on black.
 *
 * The runs, verbatim, on the three-series list this screen actually draws and
 * on all four measures together:
 *
 *   node validate_palette.js "#3987e5,#199e70,#9085e9" --mode dark --surface "#000000"
 *     [PASS] Lightness band         all 3 inside L 0.48–0.67
 *     [PASS] Chroma floor           all 3 >= 0.1
 *     [PASS] CVD separation         worst adjacent #9085e9↔#199e70 ΔE 17.3 (deutan)
 *     [PASS] Normal-vision floor    worst adjacent #199e70↔#3987e5 ΔE 20.9 (normal)
 *     [PASS] Contrast vs surface    all 3 >= 3:1
 *     → ALL CHECKS PASS
 *
 *   node validate_palette.js "#3987e5,#199e70,#9085e9,#d95926" --mode dark --surface "#000000"
 *   node validate_palette.js "#3987e5,#199e70,#9085e9,#d95926" --mode dark --surface "#131519"
 *     → ALL CHECKS PASS on both surfaces, same worst pairs.
 *
 * ---------------------------------------------------------------------------
 * COLOUR FOLLOWS THE MEASURE, NEVER THE RANK.
 *
 * THE DEFECT THIS PREVENTS: assigning colours by row order, so that filtering
 * a product out repaints the survivors and an owner who learned «الأزرق هو
 * المبيعات» is now reading the wrong line. Here the hue is bound to WHAT THE
 * NUMBER IS — revenue, gross profit, net profit, spending — for the whole
 * dashboard. Change the period, change the granularity, drop a category: every
 * surviving mark keeps its colour, because nothing about the colour was
 * derived from the data's order or its size.
 *
 * That also rules out the ramp-by-value anti-pattern on the breakdown bars.
 * Products, categories and expense categories are NOMINAL — «أقلام» is not
 * more or less than «أحبار» — so every bar in one of those charts wears ONE
 * colour, the colour of the measure it plots. Shading them light-to-dark by
 * value would spend the identity channel re-encoding the thing the bar's
 * LENGTH already says, and would fail the chroma and lightness checks by
 * construction.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT THE STORE'S GOLD. `--color-gold` (#BAA369) is the brand's selection
 * cue — `.lv-choice[aria-pressed='true']` paints a 2px gold inset edge with it
 * — and a series wearing the same colour as "this is the thing you chose"
 * makes the chart argue with the period control above it. Chart identity and
 * UI selection are two different jobs and must not share a hue.
 */

/** The categorical slots this screen uses, from the documented dark column. */
const SLOT_BLUE = '#3987e5';
const SLOT_AQUA = '#199e70';
const SLOT_VIOLET = '#9085e9';
const SLOT_ORANGE = '#d95926';

/** What a number IS, which is what decides its colour. */
export type FinanceMeasure = 'revenue' | 'gross_profit' | 'net_profit' | 'expenses';

/**
 * One hue per measure, for the whole dashboard.
 *
 * The ORDER matters and is the CVD-safety mechanism: the time chart draws
 * revenue, then gross profit, then net profit, so those three are adjacent in
 * that sequence and were validated as that sequence. Re-ordering the series
 * without re-running the validator is how a pair that was never checked ends
 * up touching.
 */
export const MEASURE_COLOR: Record<FinanceMeasure, string> = {
  revenue: SLOT_BLUE,
  gross_profit: SLOT_AQUA,
  net_profit: SLOT_VIOLET,
  expenses: SLOT_ORANGE,
};

/**
 * CHART CHROME — the furniture, one step off the surface and recessive.
 *
 * Solid hairlines, never dashed: a dashed rule reads as "projection" or
 * "threshold" when it is only a grid. These are raw hex rather than
 * `var(--color-*)` because they are handed to recharts as SVG attributes, and
 * an SVG `stroke` cannot resolve a custom property through a prop.
 */
export const CHART_INK = {
  /** Gridlines: 1.34:1 on the card surface — visible, never competing. */
  grid: '#2a2e35',
  /** Axis rules and the zero baseline. */
  axis: '#3a3f48',
  /** Axis tick text. 5.33:1 on the card surface. */
  tick: '#858b95',
  /** Direct labels and readouts. TEXT TOKENS, never the series colour. */
  label: '#b7bbc3',
  /** The strong readout inside a tooltip. */
  strong: '#f2f3f5',
  /**
   * The colour a mark is separated by. Every 2px gap between touching bars and
   * every ring around a dot is painted in the SURFACE colour, so the
   * separation is white space and not a stroke of extra ink around the data.
   */
  surface: '#131519',
} as const;

/** Mark specs, fixed across every chart on this screen (marks-and-anatomy). */
export const MARK = {
  /** Bars are capped, never filled to the band: the leftover is air. */
  barSize: 18,
  /** Lines: 2px, round join and cap. */
  lineWidth: 2,
  /** An end dot big enough to hit, with a 2px surface ring. */
  dotRadius: 4,
  ringWidth: 2,
} as const;
