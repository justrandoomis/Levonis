import React from 'react';
import { ScanLine } from 'lucide-react';
import { Field, Grid } from './formUi';
import { useLanguage } from '../../../LanguageContext';
import { serialStrings } from '../../adminOrders/serials/strings';
import {
  CONDITION_GRADES_UI,
  CONDITION_KINDS_UI,
  conditionGradeLabel,
  conditionKindLabel,
  type ConditionEntry,
} from '../../../lib/condition';

/**
 * OPEN BOX / USED / REFURBISHED, in the product form.
 *
 * ONE SWITCH AT THE TOP, and everything else is behind it. A new product is
 * the overwhelming majority of what the owner files, so the block collapses to
 * a single select in that case rather than adding fourteen empty inputs to
 * every form. Choosing a kind is what opens it.
 *
 * WHY THE WARRANTY LIVES HERE AND NOT IN THE WARRANTY SECTION. A graded
 * listing's coverage is not the printer base plus extensions — it is one
 * number the owner picks, one month or twelve, and the server refuses to sell
 * extensions on top (WARRANTY_NOT_EXTENDABLE). Putting it beside the grade and
 * the hours keeps the three facts a buyer weighs together in one place, and
 * keeps the warranty section about the thing it is actually about.
 *
 * The section states the two consequences in plain words, because they are
 * decisions the owner is making on the customer's behalf and a form that hides
 * them is a form that lets them be made by accident.
 *
 * SERIAL TRACKING OF A GRADED LISTING (owner decision 4, 2026-10-09): a used
 * printer is tracked per unit; a used non-printer follows its section policy
 * or the product's own setting, and an ordinary accessory stays off. One
 * read-only line says which, computed from what the form already holds — the
 * same order the server resolves it in (worker/lib/serialPolicy.ts), so the
 * form says what the order screen will do. The setting itself is changed in
 * the warranty block above (the owner's).
 */

export interface GradedSerialTracking {
  /** The product's own `serialized` word, or null when it has none. */
  own: boolean | null;
  isPrinter: boolean;
  section: { policy: 'required' | 'off' | null; sectionName: string | null };
}

/**
 * The answer and where it comes from: the product's word, the printer flag,
 * the nearest section, the default. A printer is tracked unless its own word
 * is `false` — and every saved printer carries `true`, written by the server's
 * printer default (worker/lib/warrantyPlans.ts), not by a hand — so a printer
 * whose word is `true` is on BECAUSE it is a printer; only an explicit `false`
 * on a printer is the product's own setting speaking.
 */
export function gradedSerialAnswer(t: GradedSerialTracking): { on: boolean; source: 'product' | 'printer' | 'section' | 'default' } {
  if (t.isPrinter && t.own !== false) return { on: true, source: 'printer' };
  if (t.own !== null) return { on: t.own, source: 'product' };
  if (t.section.policy && t.section.sectionName) return { on: t.section.policy === 'required', source: 'section' };
  return { on: false, source: 'default' };
}

/** What the section walk reads of a catalog node. */
export interface SectionSerialNode {
  id: string;
  parent_id: string | null;
  serial_policy?: 'inherit' | 'required' | 'off';
  name_ar: string;
  name_en: string;
  name_ckb?: string;
}

/**
 * §29: the nearest section on any of this product's branches that says
 * something about serials — leaf to root, 'required' winning across branches.
 * The same walk the server makes (worker/lib/serialPolicy.ts
 * catalogSerialPolicySql), so the form says what the order screen will do. The
 * section is NAMED in the reader's language (the admin's own names, Arabic
 * when a translation is missing), never Arabic on an English or Sorani form.
 */
export function nearestSectionSerial(
  catalogs: readonly SectionSerialNode[],
  starts: readonly (string | null | undefined)[],
  lang: string,
): GradedSerialTracking['section'] {
  const byId = new Map(catalogs.map((c) => [c.id, c]));
  const nameOf = (n: SectionSerialNode) =>
    lang === 'en' ? n.name_en || n.name_ar : lang === 'ckb' ? n.name_ckb || n.name_ar : n.name_ar || n.name_en;
  let found: { policy: 'required' | 'off'; sectionName: string } | null = null;
  for (const start of new Set(starts.filter(Boolean) as string[])) {
    let node = byId.get(start);
    for (let hop = 0; node && hop < 16; hop++) {
      if (node.serial_policy === 'required' || node.serial_policy === 'off') {
        if (!found || (found.policy === 'off' && node.serial_policy === 'required')) {
          found = { policy: node.serial_policy, sectionName: nameOf(node) };
        }
        break;
      }
      node = node.parent_id ? byId.get(node.parent_id) : undefined;
    }
  }
  return found ?? { policy: null, sectionName: null };
}

const EMPTY: ConditionEntry = {
  kind: 'open_box',
  grade: 'like_new',
  usage_hours: null,
  warranty_months: 12,
  new_product_id: null,
  fault_ar: '', fault_en: '', fault_ckb: '',
  repair_ar: '', repair_en: '', repair_ckb: '',
  notes_ar: '', notes_en: '', notes_ckb: '',
  unit_images: [],
};

const INPUT =
  'w-full bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-sm text-white focus:border-iris outline-none min-h-[44px]';

export function ConditionSection({
  condition,
  onChange,
  inUsedSection = false,
  serialTracking,
}: {
  condition: ConditionEntry | null;
  onChange: (next: ConditionEntry | null) => void;
  /** What decides serial tracking for this product (owner decision 4); the line shows only on a graded listing. */
  serialTracking?: GradedSerialTracking;
  /**
   * The product is filed under «المستعمل» (0147). A unit there with no
   * condition would be sold as NEW — no grade, no hours, a new printer's
   * warranty and returns — so the form says so where the choice is made.
   */
  inUsedSection?: boolean;
}) {
  const set = <K extends keyof ConditionEntry>(key: K, value: ConditionEntry[K]) => {
    onChange({ ...(condition ?? EMPTY), [key]: value });
  };
  const { lang } = useLanguage();
  const ss = serialStrings(lang);
  const tracking = serialTracking ? gradedSerialAnswer(serialTracking) : null;
  const trackingSource =
    !tracking || !serialTracking
      ? ''
      : tracking.source === 'product'
        ? ss.usedSourceProduct
        : tracking.source === 'printer'
          ? ss.usedSourcePrinter
          : tracking.source === 'section'
            ? ss.usedSourceSection(serialTracking.section.sectionName ?? '')
            : ss.usedSourceDefault;

  return (
    <div>
      {inUsedSection && !condition ? (
        <p role="status" data-used-section-hint className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-200">
          هذا المنتج في قسم «المستعمل» — اختر حالته (مستعمل أو علبة مفتوحة أو مُجدَّد) لتظهر درجته وساعات تشغيله للزبون وفي المقارنة، وإلا بيع على أنه جديد.
        </p>
      ) : null}
      <Grid cols={3}>
        <Field
          ar="حالة المنتج"
          en="Condition"
          hint="اتركه «جديد» للمنتجات العادية"
          htmlFor="condition-kind"
        >
          <select
            id="condition-kind"
            className={INPUT}
            value={condition?.kind ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              // Empty is the deliberate way back to NEW; the admin route reads
              // an explicit `condition: null` as "un-grade this listing",
              // whereas an ABSENT key would keep whatever is stored.
              onChange(v === '' ? null : { ...(condition ?? EMPTY), kind: v as ConditionEntry['kind'] });
            }}
          >
            <option value="">جديد / New</option>
            {CONDITION_KINDS_UI.map((k) => (
              <option key={k} value={k}>
                {conditionKindLabel(k, 'ar')} — {conditionKindLabel(k, 'en')}
              </option>
            ))}
          </select>
        </Field>
      </Grid>

      {condition && (
        <>
          <p className="mt-3 mb-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-2 text-[12px] leading-relaxed text-amber-200/90">
            هذا المنتج سيظهر في قسم «Open Box والمستعمل»، ولن يقبل الإرجاع لتغيير
            الرأي (يبقى مشمولاً إذا وصل تالفاً أو كان خاطئاً)، ولا تُباع عليه خطط
            ضمان ممدّد — الضمان هو ما تختاره هنا.
          </p>

          {tracking && (
            <p
              role="status"
              data-graded-serial-tracking={tracking.on ? 'on' : 'off'}
              data-graded-serial-source={tracking.source}
              className="mb-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-zinc-300"
            >
              <ScanLine className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
              <span className="min-w-0">{ss.usedSerialLine(tracking.on ? ss.usedStateOn : ss.usedStateOff, trackingSource)}</span>
            </p>
          )}
          {/* Off only by default: a used device that needs a serial (an AMS) is
              missed unless its section says so — the section editor's own hint. */}
          {tracking?.source === 'default' && (
            <p data-graded-serial-hint className="-mt-2 mb-3 text-[11.5px] leading-relaxed text-zinc-400">
              {ss.sectionUsedHint}
            </p>
          )}

          <Grid cols={3}>
            <Field ar="درجة الحالة" en="Grade" htmlFor="condition-grade">
              <select
                id="condition-grade"
                className={INPUT}
                value={condition.grade}
                onChange={(e) => set('grade', e.target.value as ConditionEntry['grade'])}
              >
                {CONDITION_GRADES_UI.map((g) => (
                  <option key={g} value={g}>
                    {conditionGradeLabel(g, 'ar')} — {conditionGradeLabel(g, 'en')}
                  </option>
                ))}
              </select>
            </Field>

            <Field ar="ساعات التشغيل" en="Hours used" hint="اتركه فارغاً إذا كان غير معروف" htmlFor="condition-hours">
              <input
                id="condition-hours"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                dir="ltr"
                className={INPUT}
                value={condition.usage_hours ?? ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  // Empty is "unknown", NOT zero — a used printer with 0 hours
                  // is a claim, and an empty box is not.
                  const n = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
                  set('usage_hours', Number.isFinite(n as number) ? n : null);
                }}
              />
            </Field>

            <Field ar="ضمان ليفو" en="LEVONIS warranty" htmlFor="condition-warranty">
              <select
                id="condition-warranty"
                className={INPUT}
                value={String(condition.warranty_months)}
                onChange={(e) => set('warranty_months', Number(e.target.value))}
              >
                <option value="1">شهر واحد / 1 month</option>
                <option value="12">١٢ شهراً / 12 months</option>
              </select>
            </Field>
          </Grid>

          <div className="mt-3">
            <Field
              ar="معرّف المنتج الجديد"
              en="New product id"
              hint="لعرض سعر الجديد مشطوباً بجانب السعر — اتركه فارغاً لإخفاء المقارنة"
              htmlFor="condition-new-id"
              span
            >
              <input
                id="condition-new-id"
                type="text"
                dir="ltr"
                className={INPUT}
                value={condition.new_product_id ?? ''}
                onChange={(e) => set('new_product_id', e.target.value.trim() || null)}
              />
            </Field>
          </div>

          <TriLingual
            label="العطل الذي كان فيه"
            field="fault"
            condition={condition}
            onChange={(k, v) => set(k, v)}
          />
          <TriLingual
            label="الإصلاح الذي جرى"
            field="repair"
            condition={condition}
            onChange={(k, v) => set(k, v)}
          />
          <TriLingual
            label="ملاحظات للمشتري"
            field="notes"
            condition={condition}
            onChange={(k, v) => set(k, v)}
          />
        </>
      )}
    </div>
  );
}

/** One three-language paragraph. Arabic is the source; the others may be blank. */
function TriLingual({
  label,
  field,
  condition,
  onChange,
}: {
  label: string;
  field: 'fault' | 'repair' | 'notes';
  condition: ConditionEntry;
  onChange: (key: keyof ConditionEntry, value: string) => void;
}) {
  const langs: Array<{ key: keyof ConditionEntry; label: string; dir: 'rtl' | 'ltr' }> = [
    { key: `${field}_ar` as keyof ConditionEntry, label: 'العربية', dir: 'rtl' },
    { key: `${field}_en` as keyof ConditionEntry, label: 'English', dir: 'ltr' },
    { key: `${field}_ckb` as keyof ConditionEntry, label: 'کوردی', dir: 'rtl' },
  ];
  return (
    <div className="mt-3">
      <label className="block text-xs font-bold text-zinc-500 uppercase mb-1.5">{label}</label>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {langs.map((l) => (
          <div key={String(l.key)} className="min-w-0">
            <span className="block text-[10px] text-zinc-600 mb-1">{l.label}</span>
            <textarea
              dir={l.dir}
              rows={2}
              aria-label={`${label} — ${l.label}`}
              className={`${INPUT} resize-y`}
              value={String(condition[l.key] ?? '')}
              onChange={(e) => onChange(l.key, e.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
