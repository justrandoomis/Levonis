/**
 * The colour vocabulary (spec §G.5): authored base colours in three languages,
 * and the rule that maps a source colour name ("Jade White (10100)") to its
 * base colour ("white") for the multi-valued colour facet. An unmapped name
 * gives no facet token; it stays searchable by its own words. No hex is ever
 * derived from a name (§1 row 4, L-1).
 */
import type { Tri } from './labels';

/*
 * Its own three-word helper, not labels.ts's `tri`: the listing's filters read
 * this table (facetVocabulary.ts) and the product page's knowledge tabs read
 * labels.ts, both in lazy chunks. A runtime import here would make labels.ts a
 * module the two share, which Rollup splits into a sub-1 KB chunk of its own
 * (tests/motionLazy.test.ts counts them). A type import is erased.
 */
const tri = (ar: string, en: string, ckb: string): Tri => ({ ar, en, ckb });

export type BaseColour =
  | 'black' | 'white' | 'grey' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'brown' | 'beige'
  | 'gold' | 'silver' | 'transparent' | 'multicolour';

export const BASE_COLOURS: Readonly<Record<BaseColour, Tri>> = {
  black: tri('أسود', 'Black', 'ڕەش'),
  white: tri('أبيض', 'White', 'سپی'),
  grey: tri('رمادي', 'Grey', 'خۆڵەمێشی'),
  red: tri('أحمر', 'Red', 'سوور'),
  orange: tri('برتقالي', 'Orange', 'پرتەقاڵی'),
  yellow: tri('أصفر', 'Yellow', 'زەرد'),
  green: tri('أخضر', 'Green', 'سەوز'),
  blue: tri('أزرق', 'Blue', 'شین'),
  purple: tri('بنفسجي', 'Purple', 'مۆر'),
  pink: tri('وردي', 'Pink', 'پەمەیی'),
  brown: tri('بني', 'Brown', 'قاوەیی'),
  beige: tri('بيج', 'Beige', 'بێژ'),
  gold: tri('ذهبي', 'Gold', 'زێڕین'),
  silver: tri('فضي', 'Silver', 'زیوی'),
  transparent: tri('شفاف', 'Transparent', 'ڕوون'),
  multicolour: tri('متعدد الألوان', 'Multicolour', 'فرەڕەنگ'),
};

/** Colour words → base colour. Whole-word, case-insensitive. */
const WORDS: ReadonlyArray<[RegExp, BaseColour]> = [
  [/\b(black|onyx|ebony|obsidian|charcoal black|jet)\b/i, 'black'],
  [/\b(white|ivory|snow|pearl white|cream white|bone)\b/i, 'white'],
  [/\b(gr[ae]y|graphite|ash|slate|titan|charcoal|stone)\b/i, 'grey'],
  [/\b(red|maroon|crimson|scarlet|burgundy|cherry|wine|ruby)\b/i, 'red'],
  [/\b(orange|tangerine|peach|apricot|coral|amber|copper orange|pumpkin)\b/i, 'orange'],
  [/\b(yellow|lemon|ochre|mustard|banana|sunflower)\b/i, 'yellow'],
  [/\b(green|olive|mint|lime|jade green|emerald|mistletoe|forest|grass|sage|matcha|avocado)\b/i, 'green'],
  [/\b(blue|navy|cobalt|azure|cyan|turquoise|teal|sky|ice|aqua|sapphire|indigo)\b/i, 'blue'],
  [/\b(purple|violet|lavender|lilac|plum|grape|magenta|indigo purple)\b/i, 'purple'],
  [/\b(pink|rose|sakura|blush|fuchsia|flamingo)\b/i, 'pink'],
  [/\b(brown|chocolate|coffee|bronze|terracotta|walnut|wood|mocha|caramel|cocoa|rust|copper)\b/i, 'brown'],
  [/\b(beige|sand|desert tan|tan|khaki|latte|nude|cream|bone white|champagne)\b/i, 'beige'],
  [/\b(gold|golden)\b/i, 'gold'],
  [/\b(silver)\b/i, 'silver'],
  [/\b(transparent|clear|translucent)\b/i, 'transparent'],
];

/** Words that make a colour name a mix of colours whatever else it names. */
const MULTI = /\b(dual[\s-]?colou?r|tri[\s-]?colou?r|multi[\s-]?colou?r|gradient|rainbow|galaxy|marble|tie[\s-]?dye|confetti|mix(ed)?|camouflage|camo)\b/i;

/**
 * The base colour of a source colour value. Rules, in order:
 *   1. a mix word, or two colour words joined by `-`, `/`, `&` or `+`, → multicolour;
 *   2. otherwise the LAST colour word decides (English puts the head noun last:
 *      "Jade White" → white, "Maroon Red" → red, "Blue Grey" → grey);
 *   3. nothing recognised → null (no facet token, still searchable).
 * Manufacturer codes ("(10100)") are ignored.
 */
export function baseColourOf(name: string): BaseColour | null {
  const text = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (MULTI.test(text)) return 'multicolour';
  const hits: Array<{ at: number; base: BaseColour }> = [];
  for (const [re, base] of WORDS) {
    const g = new RegExp(re.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) hits.push({ at: m.index, base });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.at - b.at);
  const distinct = [...new Set(hits.map((h) => h.base))];
  if (distinct.length > 1 && /[-/&+]/.test(text)) return 'multicolour';
  return hits[hits.length - 1].base;
}

/** The facet mirror of a colour group: distinct base colours, ` | ` joined (§G.5). */
export function colourFacet(names: readonly string[]): string {
  const out: BaseColour[] = [];
  for (const n of names) {
    const b = baseColourOf(n);
    if (b && !out.includes(b)) out.push(b);
  }
  return out.join(' | ');
}

/** A manufacturer colour code in a colour value: "Black (10101)" → "10101" (§C.2). */
export function colourCodeOf(value: string): string | null {
  const m = /\((\d{5})\)/.exec(value);
  return m ? m[1] : null;
}
