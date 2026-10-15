/**
 * Description section titles → neutral section kinds (spec §C.5).
 */
import { labelKey } from '../normalize';

export type SectionKind = 'overview' | 'features' | 'specs' | 'in_the_box' | 'compat' | 'instructions' | 'faq' | 'warning' | 'comparison' | 'other';

const RULES: ReadonlyArray<[RegExp, SectionKind]> = [
  [/\b(in the box|what s in the box|whats in the box|package (list|contents?)|packing list|what is in the box|box contents|included|unboxing|add ons|witb)\b/, 'in_the_box'],
  [/\b(specifications?|specs?|basic information|technical (data|details|parameters)|parameters|product parameters|special)\b/, 'specs'],
  [/\b(compatib\w*|works with|applicable (models?|printers?)|supported printers?|fits)\b/, 'compat'],
  [/\b(faq|frequently asked|questions|printing tips|q a)\b/, 'faq'],
  [/\b(instructions?|installation|how to|user guide|usage|tutorial|setup|steps|maintenance)\b/, 'instructions'],
  [/\b(warning|caution|cautions|attention|notice|safety)\b/, 'warning'],
  [/\b(comparison|compare|which .* is right|vs)\b/, 'comparison'],
  [/\b(features?|highlights?|selling points?|why choose|key features|grip|pic and text)\b/, 'features'],
  [/\b(overview|description|introduction|about|product (details|description))\b/, 'overview'],
];

export function sectionKindOf(title: string): SectionKind {
  const k = labelKey(title);
  if (!k) return 'other';
  for (const [re, kind] of RULES) if (re.test(k)) return kind;
  return 'other';
}
