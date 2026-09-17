/**
 * How a graded listing READS. The rules live on the server
 * (worker/lib/condition.ts); this file only turns them into words.
 *
 * The labels are here rather than in `translations.ts` because they are a
 * closed vocabulary that has to stay in step with the server's unions — a
 * grade the server can store and the storefront cannot name would render as a
 * raw `like_new` on a product page. Keeping the two lists in one small file
 * makes that pairing visible; tests/conditionLabels.test.ts asserts it.
 */

export type ConditionKind = 'open_box' | 'used' | 'refurbished';
export type ConditionGrade = 'like_new' | 'excellent' | 'good' | 'fair';

/** The shape the API sends on a card and on the product detail. */
export interface ConditionEntry {
  kind: ConditionKind;
  grade: ConditionGrade;
  usage_hours: number | null;
  warranty_months: number;
  new_product_id: string | null;
  fault_ar: string;
  fault_en: string;
  fault_ckb: string;
  repair_ar: string;
  repair_en: string;
  repair_ckb: string;
  notes_ar: string;
  notes_en: string;
  notes_ckb: string;
  unit_images: string[];
}

type Lang = 'ar' | 'en' | 'ckb';
const asLang = (lang: string): Lang => (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');

/**
 * «Open Box» is left in Latin script in all three languages on purpose: it is
 * the term the owner used, it is what the trade calls it, and translating it
 * to «صندوق مفتوح» would leave a customer searching for the English phrase
 * they already know with nothing to match.
 */
const KIND_LABELS: Record<ConditionKind, Record<Lang, string>> = {
  open_box: { ar: 'Open Box', en: 'Open Box', ckb: 'Open Box' },
  used: { ar: 'مستعمل', en: 'Used', ckb: 'بەکارهاتوو' },
  refurbished: { ar: 'مجدّد', en: 'Refurbished', ckb: 'نۆژەنکراوە' },
};

const GRADE_LABELS: Record<ConditionGrade, Record<Lang, string>> = {
  like_new: { ar: 'شبه جديد', en: 'Like new', ckb: 'وەک نوێ' },
  excellent: { ar: 'حالة ممتازة', en: 'Excellent', ckb: 'زۆر باش' },
  good: { ar: 'حالة جيدة', en: 'Good', ckb: 'باش' },
  fair: { ar: 'حالة مقبولة', en: 'Fair', ckb: 'مامناوەند' },
};

export function conditionKindLabel(kind: ConditionKind, lang: string): string {
  return KIND_LABELS[kind]?.[asLang(lang)] ?? KIND_LABELS.used[asLang(lang)];
}

export function conditionGradeLabel(grade: ConditionGrade, lang: string): string {
  return GRADE_LABELS[grade]?.[asLang(lang)] ?? GRADE_LABELS.good[asLang(lang)];
}

/** One of the document's three-language text fields, in the reader's language,
 *  falling back to whichever the owner actually filled in — the same rule
 *  `pickText` applies to home content. */
export function conditionText(
  doc: ConditionEntry,
  field: 'fault' | 'repair' | 'notes',
  lang: string
): string {
  const l = asLang(lang);
  const order: Lang[] = l === 'ar' ? ['ar', 'en', 'ckb'] : l === 'en' ? ['en', 'ar', 'ckb'] : ['ckb', 'ar', 'en'];
  for (const candidate of order) {
    const value = doc[`${field}_${candidate}` as keyof ConditionEntry];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export const CONDITION_KINDS_UI: readonly ConditionKind[] = ['open_box', 'used', 'refurbished'];
export const CONDITION_GRADES_UI: readonly ConditionGrade[] = ['like_new', 'excellent', 'good', 'fair'];
