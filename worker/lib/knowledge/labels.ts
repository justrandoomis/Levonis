/**
 * THE KNOWLEDGE MODEL'S CUSTOMER WORDS (the Bambu import spec §G.1, §G.2,
 * §G.4; docs/DECISIONS.md rows 2, 183, 241).
 *
 * The registry (packages/catalog/src/bambuImport/registry) already holds the
 * three-language label of every spec key, every document kind and every value
 * state; this file adds the one vocabulary the registry does not carry — the
 * headings of the spec groups the page draws — and re-exports the rest, so the
 * knowledge answer, the compare cells and the staff completeness card read one
 * set of words. Every Sorani slot is written in Sorani and never copies the
 * Arabic (row 183; tests/productKnowledgeRoute.test.ts walks them).
 */
import { tri, VALUE_STATE_LABELS, type Tri } from '@levonis/catalog/bambuImport/registry/labels';

export type { Tri };
export { VALUE_STATE_LABELS };

/** The status of one knowledge fact (0194 `product_spec_values.status`). */
export type SpecStatus = 'verified' | 'unverified' | 'not_found' | 'not_published' | 'not_applicable' | 'unknown';

export const SPEC_STATUSES: readonly SpecStatus[] = ['verified', 'unverified', 'not_found', 'not_published', 'not_applicable', 'unknown'];

export const isSpecStatus = (v: unknown): v is SpecStatus => typeof v === 'string' && (SPEC_STATUSES as readonly string[]).includes(v);

/**
 * The label a state shows INSTEAD OF A BLANK (§G.2 «Value states»): never 0,
 * never «No». `verified` has none — a verified value is its own answer.
 */
export function stateLabel(status: SpecStatus): Tri | null {
  return status === 'verified' ? null : VALUE_STATE_LABELS[status];
}

/**
 * The spec groups, in the order the Specifications tab draws them (`group_key`
 * of 0194, the registry's `group`). A group the registry adds later is drawn
 * after these, under its own key, until it is given words here.
 */
export const GROUP_LABELS: Readonly<Record<string, Tri>> = {
  identity: tri('الطراز والسلسلة', 'Model & series', 'مۆدێل و زنجیرە'),
  printing: tri('الطباعة', 'Printing', 'تایبەتمەندییەکانی چاپ'),
  motion: tri('الحركة والسرعة', 'Motion & speed', 'جووڵە و خێرایی'),
  extrusion: tri('البثق ورأس الطباعة', 'Extruder & hotend', 'پاڵنەر و سەری چاپ'),
  nozzle: tri('النوزل', 'Nozzle', 'نۆزڵ'),
  thermal: tri('درجات الحرارة', 'Temperatures', 'پلەکانی گەرمی'),
  material: tri('المادة', 'Material', 'کەرەستە'),
  print_settings: tri('إعدادات الطباعة', 'Print settings', 'ڕێکخستنەکانی چاپ'),
  drying: tri('التجفيف', 'Drying', 'وشککردنەوە'),
  mechanical: tri('الخصائص الميكانيكية', 'Mechanical properties', 'تایبەتمەندییە میکانیکییەکان'),
  electrical: tri('الكهرباء', 'Electrical', 'کارەبا'),
  connectivity: tri('الاتصال والتخزين', 'Connectivity & storage', 'پەیوەندیکردن و بیرگە'),
  physical: tri('الهيكل وبيئة التشغيل', 'Body & environment', 'جەستە و ژینگەی کارکردن'),
  ams: tri('نظام AMS', 'AMS', 'سیستەمی AMS'),
  part: tri('القطعة', 'Part', 'پارچە'),
  // The registry's `contents.pieces` («Quantity» on spare parts and plates); `package.contents` is the box, not this heading.
  contents: tri('المحتويات والكمية', 'Contents & quantity', 'ناوەڕۆک و ژمارە'),
  compat: tri('التوافق', 'Compatibility', 'گونجاوی لەگەڵ ئامێرەکان'),
  safety: tri('السلامة والشهادات', 'Safety & certifications', 'سەلامەتی و بڕوانامەکان'),
  variant: tri('ملاحظات الخيارات', 'Option notes', 'تێبینییەکانی هەڵبژاردە'),
  other: tri('مواصفات أخرى', 'Other specifications', 'تایبەتمەندییەکانی تر'),
};

export const GROUP_ORDER: readonly string[] = Object.keys(GROUP_LABELS);

/** A group's words; an unknown group shows its key in English (never an Arabic copy in the Sorani slot). */
export function groupLabel(group: string): Tri {
  return GROUP_LABELS[group] ?? { ar: group, en: group, ckb: group };
}
