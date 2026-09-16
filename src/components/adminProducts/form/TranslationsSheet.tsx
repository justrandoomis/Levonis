/**
 * THE HAND-WRITTEN TRANSLATION — the door the review flag pointed at.
 *
 * WHAT WAS WRONG. The form is English-in: the local engine (§3) generates the
 * Arabic and Sorani copies from the English source and NEVER invents prose,
 * because "ممنوع استخدام AI … للترجمة" and a rule engine cannot write correct
 * Arabic or Kurdish sentences. A field it could not cover was flagged
 * `review_needed` — and that was the end of the road. There was no screen on
 * which a human could supply the copy the engine refused to guess, so the flag
 * named a problem nobody could fix, save after save.
 *
 * The owner met it from the other side: they typed ARABIC into the English
 * boxes and expected English and Kurdish back. That direction does not exist
 * and cannot be built without the generative translation §3 forbids. What CAN
 * exist — and now does — is this: every field the engine could not translate,
 * with its source, and a box per language for the person who actually knows
 * the words. The server stores those as `approved` and never overwrites them
 * while their source is unchanged.
 *
 * WHAT EACH REASON MEANS, said in the row rather than in a manual:
 *
 *   not_english  the English box is holding Arabic. Nothing downstream can
 *                translate it, and the storefront's English page is currently
 *                showing Arabic. Fixing the source is the real repair; writing
 *                the two copies here is the workaround.
 *   prose        ordinary English sentences. Expected — this always needed a
 *                human and always will.
 *   terms        spec-shaped text whose vocabulary the dictionary lacks. Worth
 *                reporting, because adding the term fixes it for every product
 *                at once.
 *
 * Nothing here saves on its own. What is typed travels with مسودة / نشر, so
 * one save carries the product and its translations together.
 */

import React, { useMemo, useState } from 'react';
import { Languages, Check, AlertTriangle } from 'lucide-react';
import { Modal } from '../ui';
import { TextArea, btnGhost, btnPrimary } from './formUi';
import type { EditorDoc } from '../types';
import { localizableSlots } from '../../../../worker/lib/translationSlots';

export type ReviewReason = 'not_english' | 'prose' | 'terms';
export interface ReviewItem {
  field: string;
  reason: ReviewReason;
}
export type TranslationOverrides = Record<string, { ar?: string; ckb?: string }>;

const REASON: Record<ReviewReason, { ar: string; hint: string; tone: 'warn' | 'info' }> = {
  not_english: {
    ar: 'مكتوب بالعربية في حقل الإنجليزية',
    hint: 'صفحة المنتج بالإنجليزية تعرض هذا النص العربي كما هو. الأفضل كتابة المصدر بالإنجليزية؛ وإلى أن يحدث ذلك اكتب النسختين هنا.',
    tone: 'warn',
  },
  prose: {
    ar: 'جُمل — تحتاج مترجمًا بشريًا',
    hint: 'المترجم المحلي لا يؤلّف جملًا (§3). هذا متوقع لكل وصف مكتوب بأسلوب حر.',
    tone: 'info',
  },
  terms: {
    ar: 'مصطلح غير موجود في القاموس',
    hint: 'نص على هيئة مواصفة لكن أحد مصطلحاته غير معروف. اكتبه هنا، وإضافة المصطلح لاحقًا تُصلحه لكل المنتجات.',
    tone: 'info',
  },
};

/** A readable name for a slot key. The keys carry ids that mean nothing to a
 *  person, so the label says WHICH group or row, from the document itself. */
function labelFor(key: string, doc: EditorDoc): string {
  if (key === 'description') return 'الوصف';
  if (key === 'how_to_use') return 'طريقة الاستخدام';
  const parts = key.split(':');
  if (parts[0] === 'spec_group') {
    const g = doc.spec_groups?.find((x) => x.id === parts[1]);
    return `مجموعة المواصفات: ${g?.title_en || parts[1]}`;
  }
  if (parts[0] === 'spec') {
    const g = doc.spec_groups?.find((x) => x.id === parts[1]);
    const r = g?.rows?.find((x) => x.id === parts[2]);
    const what = parts[3] === 'label' ? 'اسم الحقل' : 'القيمة';
    return `${g?.title_en || parts[1]} › ${r?.label_en || parts[2]} — ${what}`;
  }
  if (parts[0] === 'label') return `شارة: ${doc.labels?.find((x) => x.id === parts[1])?.text_en || parts[1]}`;
  // 0079 — the three families that gained per-language slots.
  if (parts[0] === 'usage_step') {
    const st = doc.usage_guide?.steps?.find((x) => x.id === parts[1]);
    const where = st?.kind === 'setup' ? 'التركيب' : 'الاستخدام';
    const what = parts[2] === 'title' ? 'العنوان' : 'الشرح';
    return `خطوة ${where}: ${st?.title || parts[1]} — ${what}`;
  }
  if (parts[0] === 'lead_time') {
    const o = doc.options?.find((x) => x.id === parts[1]);
    const model = o?.variant_label || o?.name_en || parts[1];
    if (parts.length === 2) return `مدة التجهيز: ${model}`;
    const type = parts[2] === 'pre_order' ? 'طلب مسبق' : 'بيع مباشر';
    if (parts.length === 3) return `مدة التجهيز: ${model} — ${type}`;
    const route = parts[3] === 'air' ? 'جوي' : parts[3] === 'sea' ? 'بحري' : 'بري';
    return `مدة التجهيز: ${model} — ${type} · ${route}`;
  }
  if (parts[0] === 'block') {
    const b = doc.content_blocks?.find((x) => x.id === parts[1]);
    const what = parts[2] === 'body' ? 'النص' : parts[2] === 'caption' ? 'التعليق' : 'الوصف البديل';
    return `قسم المحتوى ${b?.id || parts[1]} — ${what}`;
  }
  if (parts[0] === 'warranty') {
    const w = doc.warranty_plans?.find((x) => x.id === parts[1]);
    const what = parts[2] === 'title' ? 'العنوان' : 'الشروط';
    return `الضمان: ${w?.title_en || parts[1]} — ${what}`;
  }
  return key;
}

export interface TranslationRow {
  key: string;
  label: string;
  reason: ReviewReason;
  en: string;
  ar: string;
  ckb: string;
}

/**
 * Joins the flagged field list to the document's own slots. A flagged field
 * with no slot is DROPPED rather than shown with boxes that would save into
 * nothing — the guard, not the design. Until 0079 `how_to_use` was the field
 * it dropped, which is why «طريقة الاستخدام» could be FLAGGED for review and
 * still had no row here to fix it in. It has slots now, as do the usage steps
 * and all three rungs of «مدة التجهيز».
 */
export function translationRows(doc: EditorDoc, review: ReviewItem[]): TranslationRow[] {
  const slots = new Map(
    localizableSlots(doc as unknown as Record<string, unknown>).map((s) => [s.key, s] as const)
  );
  const rows: TranslationRow[] = [];
  for (const item of review) {
    const slot = slots.get(item.field);
    if (!slot || !slot.en.trim()) continue;
    rows.push({
      key: item.field,
      label: labelFor(item.field, doc),
      reason: item.reason,
      en: slot.en,
      ar: slot.ar,
      ckb: slot.ckb,
    });
  }
  return rows;
}

function ReasonChip({ reason }: { reason: ReviewReason }) {
  const r = REASON[reason];
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${
        r.tone === 'warn' ? 'bg-amber-500/15 text-amber-300' : 'bg-zinc-800 text-zinc-300'
      }`}
    >
      {r.tone === 'warn' && <AlertTriangle className="w-3 h-3" aria-hidden="true" />}
      {r.ar}
    </span>
  );
}

export default function TranslationsSheet({
  doc,
  review,
  overrides,
  onApply,
  onClose,
}: {
  doc: EditorDoc;
  review: ReviewItem[];
  overrides: TranslationOverrides;
  onApply: (next: TranslationOverrides) => void;
  onClose: () => void;
}) {
  const rows = useMemo(() => translationRows(doc, review), [doc, review]);
  // Edited locally and handed back on «تم» — closing the sheet by mistake must
  // not commit half-written Kurdish to the next save.
  const [draft, setDraft] = useState<TranslationOverrides>(() => ({ ...overrides }));

  const textOf = (row: TranslationRow, lang: 'ar' | 'ckb') => {
    const typed = draft[row.key]?.[lang];
    if (typeof typed === 'string') return typed;
    // The stored copy equals the English source when the engine refused it;
    // showing that is honest — it is exactly what the storefront renders now.
    return lang === 'ar' ? row.ar : row.ckb;
  };

  const put = (key: string, lang: 'ar' | 'ckb', text: string) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], [lang]: text } }));

  const dirty = JSON.stringify(draft) !== JSON.stringify(overrides);
  const written = rows.filter(
    (r) => typeof draft[r.key]?.ar === 'string' && typeof draft[r.key]?.ckb === 'string'
  ).length;

  return (
    <Modal
      titleAr="ترجمة يدوية"
      titleEn="Manual translation"
      wide
      dirty={dirty}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-[11px] text-zinc-500 flex-1 min-w-[140px]">
            {written} من {rows.length} مكتملة · تُحفظ مع المنتج عند «نشر» أو «مسودة»
          </span>
          <button type="button" className={btnGhost} onClick={onClose}>
            إلغاء
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            <Check className="w-4 h-4" /> تم
          </button>
        </div>
      }
    >
      <p className="text-[12px] leading-relaxed text-zinc-400 mb-3">
        المترجم المحلي يعمل من الإنجليزية إلى العربية والكردية، ولا يؤلّف جملًا — هذه قاعدة مقصودة، لا عطل. الحقول
        أدناه هي التي لم يستطع تغطيتها؛ اكتب نسختها العربية والكردية هنا وستُحفظ كما كتبتها ولن تُستبدل تلقائيًا ما دام
        النص الإنجليزي كما هو.
      </p>

      {rows.length === 0 ? (
        <p className="text-[12px] text-zinc-500">لا حقول بانتظار ترجمة يدوية.</p>
      ) : (
        <div className="space-y-2.5 min-w-0">
          {rows.map((row) => (
            <div
              key={row.key}
              data-translation-row={row.key}
              className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h4 className="text-[12px] font-bold text-zinc-200 truncate min-w-0 flex-1">{row.label}</h4>
                <ReasonChip reason={row.reason} />
              </div>
              <p className="text-[10px] text-zinc-500 leading-snug">{REASON[row.reason].hint}</p>

              <div className="rounded-md bg-black/30 border border-zinc-800 px-2 py-1.5">
                <span className="block text-[10px] font-bold text-zinc-500 mb-0.5">المصدر / source</span>
                <p className="text-[11px] text-zinc-300 whitespace-pre-wrap break-words" dir="auto">
                  {row.en}
                </p>
              </div>

              <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))] min-w-0">
                <label className="min-w-0 block">
                  <span className="block text-[11px] font-bold text-zinc-400 mb-1">العربية</span>
                  <TextArea
                    rows={3}
                    dir="rtl"
                    lang="ar"
                    value={textOf(row, 'ar')}
                    onChange={(e) => put(row.key, 'ar', e.target.value)}
                    aria-label={`${row.label} — العربية`}
                  />
                </label>
                <label className="min-w-0 block">
                  <span className="block text-[11px] font-bold text-zinc-400 mb-1">الكردية (سوراني)</span>
                  <TextArea
                    rows={3}
                    dir="rtl"
                    lang="ckb"
                    value={textOf(row, 'ckb')}
                    onChange={(e) => put(row.key, 'ckb', e.target.value)}
                    aria-label={`${row.label} — الكردية`}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export { Languages as TranslationsIcon };
