/**
 * AN OPTION'S OR A COLOUR'S NAME — NEVER ITS ID.
 *
 * The cart's «تغيير الخيارات» sheet printed `c.name || c.id`. `name` is the
 * V1 field: a V2 product document keeps a value's name in `name_en`, `name_ar`
 * and `name_ckb` (a legacy `name` is folded into `name_en` when the row is
 * parsed), and the public projection (`publicColor` / `publicOption`,
 * worker/lib/productModel.ts — an allow-list) sends only those three. So every
 * colour and every option of a V2 product reached the sheet without a `name`,
 * and the fallback printed its UUID (owner's screenshot, 2026-10-17).
 *
 * THE RULE IS THE PRODUCT PAGE'S (`pickName`, src/pages/Product.tsx): option
 * and colour names are English in every language (product-form mandate §7 —
 * the ar/ckb slots are filled with the same English string on save), so the
 * sheet says «BLACK» exactly where the line's colour tag and the product page
 * say it. For a row saved before that rule, the reader's own slot comes next,
 * then the other one, then the value's own label. Empty when the row has no
 * name at all: the caller then numbers it in the reader's language — an id is
 * never a label.
 */
export type ChoiceLang = 'ar' | 'en' | 'ckb';

export interface NamedChoice {
  name?: string | null;
  name_en?: string | null;
  name_ar?: string | null;
  name_ckb?: string | null;
  variant_label?: string | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function choiceName(choice: NamedChoice, lang: ChoiceLang): string {
  const own = lang === 'ckb' ? text(choice.name_ckb) : text(choice.name_ar);
  const other = lang === 'ckb' ? text(choice.name_ar) : text(choice.name_ckb);
  return text(choice.name_en) || text(choice.name) || own || other || text(choice.variant_label);
}

/** «اللون 2» / «Colour 2» / «ڕەنگی 2» — a row with no name at all, numbered in the sheet's order. */
export function unnamedChoice(kind: 'colour' | 'option', n: number, lang: ChoiceLang): string {
  if (kind === 'colour') return lang === 'en' ? `Colour ${n}` : lang === 'ckb' ? `ڕەنگی ${n}` : `اللون ${n}`;
  return lang === 'en' ? `Option ${n}` : lang === 'ckb' ? `هەڵبژاردەی ${n}` : `الخيار ${n}`;
}
