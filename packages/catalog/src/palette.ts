/**
 * THE COLOURS A MERCHANT MAY PAINT A SWATCH WITH — a closed list of NAMES.
 *
 * A product's colour (a variant value of a «colour» option group, or the
 * printed colour of a simple product) is shown to every visitor as a swatch.
 * The swatch is drawn by the platform's stylesheet from this key
 * (`data-swatch="red"`), never from a colour a merchant typed: no merchant
 * string reaches CSS (docs/MERCHANT_STORES.md §10, DECISIONS row 122). The
 * list is the vocabulary of filament and resin — what a 3D-printing shop
 * actually sells — plus `multi` (multicolour prints) and `clear`.
 *
 * Sorani is never machine-written (docs/DECISIONS.md row 11): the names are
 * Arabic and English; a caller's `loc` falls back to the Arabic.
 * OWNER: Sorani to be written by hand.
 */
export const SWATCHES = [
  'black', 'white', 'gray', 'silver', 'red', 'orange', 'yellow', 'green',
  'teal', 'blue', 'navy', 'purple', 'pink', 'brown', 'beige', 'gold',
  'bronze', 'wood', 'marble', 'clear', 'glow', 'multi',
] as const;

export type Swatch = (typeof SWATCHES)[number];

export const SWATCH_NAMES: Record<Swatch, { ar: string; en: string }> = {
  black: { ar: 'أسود', en: 'Black' },
  white: { ar: 'أبيض', en: 'White' },
  gray: { ar: 'رمادي', en: 'Grey' },
  silver: { ar: 'فضي', en: 'Silver' },
  red: { ar: 'أحمر', en: 'Red' },
  orange: { ar: 'برتقالي', en: 'Orange' },
  yellow: { ar: 'أصفر', en: 'Yellow' },
  green: { ar: 'أخضر', en: 'Green' },
  teal: { ar: 'فيروزي', en: 'Teal' },
  blue: { ar: 'أزرق', en: 'Blue' },
  navy: { ar: 'كحلي', en: 'Navy' },
  purple: { ar: 'بنفسجي', en: 'Purple' },
  pink: { ar: 'وردي', en: 'Pink' },
  brown: { ar: 'بني', en: 'Brown' },
  beige: { ar: 'بيج', en: 'Beige' },
  gold: { ar: 'ذهبي', en: 'Gold' },
  bronze: { ar: 'برونزي', en: 'Bronze' },
  wood: { ar: 'خشبي', en: 'Wood' },
  marble: { ar: 'رخامي', en: 'Marble' },
  clear: { ar: 'شفاف', en: 'Clear' },
  glow: { ar: 'مضيء في الظلام', en: 'Glow in the dark' },
  multi: { ar: 'متعدد الألوان', en: 'Multicolour' },
};

/** The key, or '' for anything that is not one — never the raw input. */
export function swatchKey(raw: unknown): Swatch | '' {
  return typeof raw === 'string' && (SWATCHES as readonly string[]).includes(raw) ? (raw as Swatch) : '';
}
