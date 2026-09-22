import React from 'react';
import { PackageOpen, ShieldCheck, Clock, Wrench, AlertTriangle, Info } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import SafeImage from '../ui/SafeImage';
import { conditionGradeLabel, conditionKindLabel, conditionText, type ConditionEntry } from '../../lib/condition';
import { useMoney } from '../../CurrencyContext';

/**
 * WHAT THIS UNIT ACTUALLY IS, BEFORE ANYONE PAYS FOR IT.
 *
 * The owner's example is the whole brief: an X2D Combo whose AMS 2 Pro
 * motherboard failed and was replaced. A buyer deciding on that needs four
 * facts and needs them TOGETHER — what kind of not-new it is, how worn it is,
 * what went wrong and what was done, and what they are covered for. Scattering
 * them among the ordinary specification rows would let a shopper skim past the
 * one thing that distinguishes this listing from the new one beside it.
 *
 * SO IT IS ONE PANEL, AND IT SITS ABOVE THE PURCHASE CONTROLS. Not because it
 * is an alarm — it is not, and §3 of the design skill is explicit that a state
 * must not be dressed as a warning — but because it is the frame the price
 * below it only makes sense inside. 1,220,000 د.ع is a bargain or a mistake
 * depending on the paragraph above it.
 *
 * The no-return line is the exception that IS a caution: it removes a right
 * the customer would otherwise have, so it carries the warning tone while
 * everything else in the panel stays neutral. One cue, on the one thing that
 * needs it.
 */
const STRINGS = {
  ar: {
    heading: 'حالة هذا الجهاز',
    grade: 'الحالة',
    hours: 'ساعات التشغيل',
    hoursUnit: 'ساعة',
    warranty: 'ضمان ليفو',
    months: (n: number) => (n === 1 ? 'شهر واحد' : `${n} شهراً`),
    fault: 'العطل الذي كان فيه',
    repair: 'الإصلاح الذي جرى',
    notes: 'ملاحظات',
    noReturn: 'غير قابل للإرجاع أو الاستبدال بعد الاستلام.',
    noReturnWhy: 'يبقى الجهاز مشمولاً إذا وصل تالفاً أو كان الجهاز خاطئاً.',
    newPrice: 'سعر الجديد',
    saving: (v: string) => `توفير ${v}`,
    photos: 'صور الجهاز نفسه',
  },
  en: {
    heading: 'The condition of this unit',
    grade: 'Condition',
    hours: 'Hours used',
    hoursUnit: 'h',
    warranty: 'LEVONIS warranty',
    months: (n: number) => (n === 1 ? '1 month' : `${n} months`),
    fault: 'What was wrong with it',
    repair: 'What was done',
    notes: 'Notes',
    noReturn: 'Not returnable or exchangeable after delivery.',
    noReturnWhy: 'A claim is still accepted if it arrives faulty, damaged, or is the wrong item.',
    newPrice: 'New price',
    saving: (v: string) => `You save ${v}`,
    photos: 'Photographs of this unit',
  },
  ckb: {
    heading: 'دۆخی ئەم ئامێرە',
    grade: 'دۆخ',
    hours: 'کاتژمێری بەکارهێنان',
    hoursUnit: 'کاتژمێر',
    warranty: 'زەمانەتی لیڤۆنیس',
    months: (n: number) => (n === 1 ? 'مانگێک' : `${n} مانگ`),
    fault: 'کێشەکەی چی بوو',
    repair: 'چی کرا',
    notes: 'تێبینی',
    noReturn: 'دوای وەرگرتن ناگەڕێندرێتەوە و ناگۆڕدرێتەوە.',
    noReturnWhy: 'ئەگەر شکاو یان هەڵە گەیشت، داواکاری هێشتا وەردەگیرێت.',
    newPrice: 'نرخی نوێ',
    saving: (v: string) => `${v} پاشەکەوت`,
    photos: 'وێنەی هەمان ئامێر',
  },
} as const;

export default function ConditionPanel({
  condition,
  reference,
}: {
  condition: ConditionEntry;
  reference?: { reference_iqd: number; saving_iqd: number } | null;
}) {
  const { money } = useMoney();
  const { lang } = useLanguage();
  const s = STRINGS[lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar'];
  const fault = conditionText(condition, 'fault', lang);
  const repair = conditionText(condition, 'repair', lang);
  const notes = conditionText(condition, 'notes', lang);

  return (
    <section
      data-condition-panel={condition.kind}
      aria-labelledby="condition-heading"
      className="mt-4 rounded-2xl border border-border-subtle bg-surface overflow-hidden"
    >
      <header className="flex items-center gap-2.5 px-4 py-3 border-b border-border-subtle/70">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-info/15 px-2.5 py-1 text-[11px] font-bold text-info">
          <PackageOpen aria-hidden="true" className="w-3.5 h-3.5" />
          {conditionKindLabel(condition.kind, lang)}
        </span>
        <h2 id="condition-heading" className="text-[14px] font-bold text-text-primary">
          {s.heading}
        </h2>
      </header>

      {/* The measurable facts, as a definition list so a screen reader reads
          each value with the label it belongs to rather than as loose text. */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 px-4 py-3.5 sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-[11px] text-text-muted">{s.grade}</dt>
          <dd className="mt-0.5 text-[13px] font-bold text-text-primary truncate">
            {conditionGradeLabel(condition.grade, lang)}
          </dd>
        </div>

        {condition.usage_hours !== null && (
          <div className="min-w-0">
            <dt className="flex items-center gap-1 text-[11px] text-text-muted">
              <Clock aria-hidden="true" className="w-3 h-3" />
              {s.hours}
            </dt>
            <dd className="mt-0.5 text-[13px] font-bold text-text-primary tabular-nums" dir="ltr">
              {condition.usage_hours.toLocaleString('en-US')} {s.hoursUnit}
            </dd>
          </div>
        )}

        <div className="min-w-0">
          <dt className="flex items-center gap-1 text-[11px] text-text-muted">
            <ShieldCheck aria-hidden="true" className="w-3 h-3" />
            {s.warranty}
          </dt>
          <dd className="mt-0.5 text-[13px] font-bold text-text-primary">{s.months(condition.warranty_months)}</dd>
        </div>
      </dl>

      {/* The comparison. Present only when the server found an honest saving —
          never a zero or a negative one beside a struck-through number. */}
      {reference && (
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-4 pb-3.5">
          <span className="text-[11px] text-text-muted">{s.newPrice}</span>
          <span className="text-[13px] text-text-muted line-through tabular-nums">
            {money(reference.reference_iqd)}
          </span>
          <span className="text-[12px] font-bold text-success tabular-nums">
            {s.saving(money(reference.saving_iqd))}
          </span>
        </div>
      )}

      {(fault || repair || notes) && (
        <div className="border-t border-border-subtle/70 px-4 py-3.5 space-y-3">
          {fault && <Para icon={<AlertTriangle className="w-3.5 h-3.5" />} label={s.fault} body={fault} />}
          {repair && <Para icon={<Wrench className="w-3.5 h-3.5" />} label={s.repair} body={repair} />}
          {notes && <Para icon={<Info className="w-3.5 h-3.5" />} label={s.notes} body={notes} />}
        </div>
      )}

      {/* Photographs of THIS unit. A stock photo cannot show a scuff, and the
          scuff is what the buyer is accepting in exchange for the discount. */}
      {condition.unit_images.length > 0 && (
        <div className="border-t border-border-subtle/70 px-4 py-3.5">
          <p className="mb-2 text-[11px] text-text-muted">{s.photos}</p>
          <div className="flex gap-2 overflow-x-auto hide-scrollbar">
            {condition.unit_images.map((src, i) => (
              <SafeImage
                key={`${src}-${i}`}
                src={src}
                alt=""
                aspect="square"
                className="w-20 h-20 shrink-0 rounded-lg border border-border-subtle"
              />
            ))}
          </div>
        </div>
      )}

      {/* THE ONE CAUTION IN THE PANEL. It removes a right the customer would
          otherwise have, so it carries the warning tone while every other row
          above stays neutral — one cue, on the one thing that needs it. */}
      <p className="flex items-start gap-2 border-t border-warning/20 bg-warning/[0.07] px-4 py-3 text-[12px] leading-snug text-warning">
        <AlertTriangle aria-hidden="true" className="mt-0.5 w-4 h-4 shrink-0" />
        <span>
          <span className="font-bold">{s.noReturn}</span>{' '}
          <span className="text-text-secondary">{s.noReturnWhy}</span>
        </span>
      </p>
    </section>
  );
}

function Para({ icon, label, body }: { icon: React.ReactNode; label: string; body: string }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[11px] font-bold text-text-muted">
        <span aria-hidden="true" className="shrink-0">{icon}</span>
        {label}
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-text-secondary break-words">{body}</p>
    </div>
  );
}
