/**
 * Applies the local deterministic translator to a whole ProductDoc — mandate
 * §3: text is entered ONCE in English and the Arabic and Sorani copies are
 * produced locally, with no visible ar/ckb fields anywhere in the form.
 *
 * Two rules are absolute here:
 *
 *  1. THE NAME IS NEVER TRANSLATED. "عنوان/اسم المنتج يبقى باللغة الإنجليزية
 *     في جميع الواجهات ولا تتم ترجمته". `name_ar` and `name_ckb` are set equal
 *     to `name_en` so every surface — including ones that still pick a name by
 *     locale — shows the English name. The same applies to option and colour
 *     names, which §7 defines as English-only.
 *
 *  2. NOTHING IS INVENTED. A segment the engine cannot cover keeps its English
 *     text and the field is listed in `review_needed`. Saving is never blocked
 *     (§3: "لا تخترع ترجمة ولا تمنع حفظ المنتج").
 *
 * This runs on the SAVE path only. Existing rows are untouched until an admin
 * edits them, so nothing in the catalogue is rewritten behind the owner's back.
 */

import type { ProductDoc } from '../productModel';
import { reviewReason, translateText, type ReviewReason } from './index';
import type { TranslationInput } from './store';

/** One flagged field and WHY — see `reviewReason`. A bare list of 66 field
 *  keys told the owner nothing about what to do with them. */
export interface ReviewItem {
  field: string;
  reason: ReviewReason;
}

export interface LocalizeResult {
  /** Field keys still needing a human, e.g. ['description', 'spec:g1:r2']. */
  review_needed: string[];
  /** The same fields, each with the reason it could not be translated. */
  review_details: ReviewItem[];
  /** Rows to persist in product_translations. */
  fields: TranslationInput[];
}

/** Mutates `doc` in place: fills every ar/ckb slot from its English source. */
export function localizeProductDoc(doc: ProductDoc): LocalizeResult {
  const review: string[] = [];
  const details: ReviewItem[] = [];
  const fields: TranslationInput[] = [];

  /** Translates one English source into both languages and reports honestly. */
  const put = (
    key: string,
    sourceEn: string,
    set: (ar: string, ckb: string) => void,
    { track = true }: { track?: boolean } = {}
  ) => {
    const src = sourceEn ?? '';
    if (!src.trim()) {
      set('', '');
      return;
    }
    const ar = translateText(src, 'ar');
    const ckb = translateText(src, 'ckb');
    set(ar.text, ckb.text);
    if (track) fields.push({ field: key, source_en: src });
    if (ar.status !== 'machine' || ckb.status !== 'machine') {
      review.push(key);
      details.push({ field: key, reason: reviewReason(src) });
    }
  };

  /** Copies English verbatim into both slots — for names and codes that must
   *  not be translated at all. */
  const keepEnglish = (sourceEn: string, set: (ar: string, ckb: string) => void) => {
    set(sourceEn, sourceEn);
  };

  // 1. Name — never translated, in any surface.
  keepEnglish(doc.name_en, (ar, ckb) => {
    doc.name_ar = ar;
    doc.name_ckb = ckb;
  });

  // 2. Prose fields.
  put('description', doc.description_en, (ar, ckb) => {
    doc.description_ar = ar;
    doc.description_ckb = ckb;
  });

  // `how_to_use` is a single string in the doc; there is no ar/ckb slot for it
  // on the product row, so its translation lives only in product_translations
  // and is read from there by the storefront.
  if (doc.how_to_use && doc.how_to_use.trim()) {
    put('how_to_use', doc.how_to_use, () => {});
  }

  // 3. Specifications.
  for (const g of doc.spec_groups ?? []) {
    put(`spec_group:${g.id}:title`, g.title_en, (ar, ckb) => {
      g.title_ar = ar;
      g.title_ckb = ckb;
    });
    for (const r of g.rows ?? []) {
      put(`spec:${g.id}:${r.id}:label`, r.label_en, (ar, ckb) => {
        r.label_ar = ar;
        r.label_ckb = ckb;
      });
      put(`spec:${g.id}:${r.id}:value`, r.value_en, (ar, ckb) => {
        r.value_ar = ar;
        r.value_ckb = ckb;
      });
    }
  }

  // 4. Labels / badges.
  for (const l of doc.labels ?? []) {
    put(`label:${l.id}`, l.text_en, (ar, ckb) => {
      l.text_ar = ar;
      l.text_ckb = ckb;
    });
  }

  // 5. Long-form content blocks.
  for (const b of doc.content_blocks ?? []) {
    put(`block:${b.id}:body`, b.body_en, (ar, ckb) => {
      b.body_ar = ar;
      b.body_ckb = ckb;
    });
    put(`block:${b.id}:caption`, b.caption_en, (ar, ckb) => {
      b.caption_ar = ar;
      b.caption_ckb = ckb;
    });
    put(`block:${b.id}:alt`, b.alt_en, (ar, ckb) => {
      b.alt_ar = ar;
      b.alt_ckb = ckb;
    });
  }

  // 6. Warranty plans — the terms are a legal text a machine must not guess at,
  //    so an uncovered plan is flagged loudly rather than half-rendered.
  for (const w of doc.warranty_plans ?? []) {
    put(`warranty:${w.id}:title`, w.title_en, (ar, ckb) => {
      w.title_ar = ar;
      w.title_ckb = ckb;
    });
    put(`warranty:${w.id}:terms`, w.terms_en, (ar, ckb) => {
      w.terms_ar = ar;
      w.terms_ckb = ckb;
    });
  }

  // 7. Option and colour names are English-only by §7 — copied, never
  //    translated, so the buyer sees the same token the SKU uses.
  for (const o of doc.options ?? []) {
    keepEnglish(o.name_en, (ar, ckb) => {
      o.name_ar = ar;
      o.name_ckb = ckb;
    });
  }
  for (const col of doc.colors ?? []) {
    keepEnglish(col.name_en, (ar, ckb) => {
      col.name_ar = ar;
      col.name_ckb = ckb;
    });
  }

  return { review_needed: review, review_details: details, fields };
}
