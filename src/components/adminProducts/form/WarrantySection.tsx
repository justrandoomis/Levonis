/**
 * What is left of the product form's warranty block after «خدمات الطابعة» took the warranty over
 * (printer phase 5, owner 2026-11-18; DECISIONS row 358). A printer's warranty (none / 12 / 24
 * months) and Levo Care are sold through «خصص طابعتك» now, so the old extended-warranty editor —
 * the +12 / +24 switches priced as a percent of the printer — is gone from this form. The fields it
 * wrote (`warranty_plans`, `warranty_base_months`, `serialized`) stay in the document and travel
 * through the save untouched.
 *
 * Two small blocks remain, so nothing the save validates becomes un-editable:
 *
 *  - NOT A PRINTER: «تتبّع الرقم التسلسلي» (§29) — whether the product needs a serial at
 *    preparation — and, when older data left extension plans on it, the warning with a one-click
 *    clear (the server refuses that save: WARRANTY_NOT_PRINTER).
 *  - A PRINTER (shown by the form only for a used / refurbished listing, or when the stored
 *    warranty fields fail the save): the base months and the serial switch, plus a one-click clear
 *    of stored extension plans — a graded listing may not carry them (WARRANTY_NOT_EXTENDABLE).
 */

import { Lock, ScanLine } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import { serialStrings } from '../../adminOrders/serials/strings';
import type { WarrantyPlanV2 } from '../../../lib/productTypes';
import { Banner, Field, Grid, Qty, Toggle, btnGhost } from './formUi';
import { PRINTER_BASE_MONTHS } from './model';
import type { FormErrors } from './model';

export function WarrantySection({
  isPrinter,
  plans,
  serialized,
  baseMonths,
  errors,
  onPlansChange,
  onSerializedChange,
  onBaseMonthsChange,
  canEditSerial = false,
  sectionSerial,
}: {
  isPrinter: boolean;
  plans: WarrantyPlanV2[];
  serialized: boolean | null;
  baseMonths: number | null;
  errors: FormErrors;
  onPlansChange: (next: WarrantyPlanV2[]) => void;
  onSerializedChange: (v: boolean) => void;
  onBaseMonthsChange: (v: number | null) => void;
  /**
   * §29 (serial scan, 0178): whether a product needs a serial at preparation
   * — and gets a warranty unit at delivery — is the OWNER's call; the server
   * refuses anyone else's change (OWNER_ONLY). Others see it with a lock.
   */
  canEditSerial?: boolean;
  /** The nearest section policy on this product's branches (read at render, like the server does). */
  sectionSerial?: { policy: 'required' | 'off' | null; sectionName: string | null };
}) {
  if (!isPrinter) {
    return (
      <>
        <SerialTracking serialized={serialized} canEdit={canEditSerial} section={sectionSerial} onChange={onSerializedChange} />
        {plans.length > 0 && <LegacyPlansBanner plans={plans} onPlansChange={onPlansChange} />}
      </>
    );
  }
  return (
    <PrinterDeviceWarranty
      plans={plans}
      serialized={serialized}
      baseMonths={baseMonths}
      errors={errors}
      onPlansChange={onPlansChange}
      onSerializedChange={onSerializedChange}
      onBaseMonthsChange={onBaseMonthsChange}
      canEditSerial={canEditSerial}
    />
  );
}

/**
 * «تتبّع الرقم التسلسلي» for a product that is NOT in a printer section (§29):
 * the AMS family and anything else the owner wants scanned at preparation.
 * Its own answer wins; with none, the nearest section policy decides, then
 * the accessory default (no serial). Two choices, because the server keeps a
 * product's own answer once given (mergeOpsPolicy) — the source line says
 * where today's answer comes from.
 */
function SerialTracking({
  serialized,
  canEdit = false,
  section,
  onChange,
}: {
  serialized: boolean | null;
  canEdit?: boolean;
  section?: { policy: 'required' | 'off' | null; sectionName: string | null };
  onChange: (v: boolean) => void;
}) {
  const { lang } = useLanguage();
  const s = serialStrings(lang);
  const effective = serialized ?? section?.policy === 'required';
  const source =
    serialized !== null
      ? s.policyOwn
      : section?.policy && section.sectionName
        ? s.policyFromSection(section.sectionName)
        : s.policyDefault;
  return (
    <div className="mb-3 min-w-0 rounded-lg border border-border-subtle p-3" data-form="serial-tracking" data-serial-effective={effective ? 'required' : 'off'}>
      <div className="flex items-start gap-2 mb-2.5 min-w-0">
        <ScanLine className="w-4 h-4 text-text-secondary shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h4 className="text-[12.5px] font-bold text-white">{s.policyTitle}</h4>
          <p className="text-[11px] text-text-secondary leading-snug">{s.policyHint}</p>
        </div>
        {!canEdit && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-text-secondary" data-serial-policy-locked>
            <Lock className="h-3.5 w-3.5" aria-hidden />
            {s.policyOwnerOnly}
          </span>
        )}
      </div>
      {canEdit ? (
        <Segmented
          group="product-serial-tracking"
          label={s.policyTitle}
          value={effective ? 'required' : 'off'}
          onChange={(id) => onChange(id === 'required')}
          size="sm"
          dataAttr="data-serial-policy"
          items={[
            { id: 'required', label: s.policyRequired },
            { id: 'off', label: s.policyOff },
          ]}
        />
      ) : (
        <p className="text-[13px] font-semibold text-white">{effective ? s.policyEffectiveOn : s.policyEffectiveOff}</p>
      )}
      {/* Where today's answer comes from; the locked view has just said what it is. */}
      <p className="mt-1.5 text-[11px] text-text-secondary" data-serial-policy-source>
        {canEdit ? `${effective ? s.policyEffectiveOn : s.policyEffectiveOff} · ${source}` : source}
      </p>
    </div>
  );
}

function LegacyPlansBanner({ plans, onPlansChange }: { plans: WarrantyPlanV2[]; onPlansChange: (next: WarrantyPlanV2[]) => void }) {
  const { lang } = useLanguage();
  const t = (ar: string, en: string, ckb: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb : ar);
  return (
      <div className="mb-3 min-w-0" data-form="warranty-not-printer">
        <Banner kind="warn">
          {t(
            `هذا المنتج ليس في قسم طابعات ويحمل ${plans.length} خطة ضمان ممدد قديمة — سيُرفض الحفظ حتى تُحذف الخطط أو يُنقل المنتج إلى قسم طابعات.`,
            `This product is not in a printer section and still carries ${plans.length} old extended-warranty plan(s) — the save is refused until they are removed or the product moves to a printer section.`,
            `ئەم بەرهەمە لە بەشی پرینتەردا نییە و هێشتا ${plans.length} پلانی گەرەنتی درێژکراوەی کۆنی پێوەیە — پاشەکەوتکردن ڕەت دەکرێتەوە تا پلانەکان لادەبرێن یان بەرهەمەکە دەگوازرێتەوە بۆ بەشی پرینتەر.`
          )}
          <div className="mt-2">
            <button type="button" className={`${btnGhost} h-8 text-[12px]`} onClick={() => onPlansChange([])}>
              {t('حذف خطط الضمان', 'Remove the warranty plans', 'سڕینەوەی پلانەکانی گەرەنتی')}
            </button>
          </div>
        </Banner>
      </div>
  );
}

/**
 * A printer's own device cover: how long its base warranty runs from delivery and whether a unit is
 * recorded per printer. No extension plans are edited here any more; plans an older save left on the
 * product are counted, their refusals (if any) are said, and one button removes them.
 */
function PrinterDeviceWarranty({
  plans,
  serialized,
  baseMonths,
  errors,
  onPlansChange,
  onSerializedChange,
  onBaseMonthsChange,
  canEditSerial = false,
}: {
  plans: WarrantyPlanV2[];
  serialized: boolean | null;
  baseMonths: number | null;
  errors: FormErrors;
  onPlansChange: (next: WarrantyPlanV2[]) => void;
  onSerializedChange: (v: boolean) => void;
  onBaseMonthsChange: (v: number | null) => void;
  canEditSerial?: boolean;
}) {
  const { lang } = useLanguage();
  const ss = serialStrings(lang);
  const t = (ar: string, en: string, ckb: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb : ar);
  const effectiveSerialized = serialized ?? true;
  // Every refusal the stored plans meet (model.ts warrantyRules): said here, where the clear button is.
  const planErrors = [
    errors.warranty_plans,
    ...plans.flatMap((p) => [errors[`warranty_plan:${p.id}`], errors[`warranty_percent:${p.id}`]]),
  ].filter((e): e is string => !!e);

  return (
    <div className="mb-3 min-w-0" data-form="device-warranty">
      <Grid cols={2}>
        <Field
          ar="مدة الضمان الأساسي"
          en="Base months"
          hint={t(
            `بالأشهر من تاريخ التسليم — ${PRINTER_BASE_MONTHS} للطابعات الجديدة`,
            `In months from the delivery date — ${PRINTER_BASE_MONTHS} for new printers`,
            `بە مانگ لە بەرواری گەیاندنەوە — ${PRINTER_BASE_MONTHS} بۆ پرینتەری نوێ`
          )}
          error={errors.warranty_base_months ?? null}
        >
          <Qty value={baseMonths} onChange={onBaseMonthsChange} placeholder={t(`${PRINTER_BASE_MONTHS} (افتراضي)`, `${PRINTER_BASE_MONTHS} (default)`, `${PRINTER_BASE_MONTHS} (بنەڕەتی)`)} />
        </Field>
        <Field
          ar="جهاز مُرقَّم"
          en="Serialized"
          hint={t('وحدة لكل طابعة عند التسليم — عليها يُسجَّل الضمان', 'One unit per printer at delivery — the warranty is recorded on it', 'یەکەیەک بۆ هەر پرینتەرێک لە کاتی گەیاندن — گەرەنتی لەسەری تۆمار دەکرێت')}
          error={errors.serialized ?? null}
        >
          <Toggle
            checked={effectiveSerialized}
            onChange={onSerializedChange}
            disabled={!canEditSerial}
            label={effectiveSerialized ? t('تُسجَّل وحدة لكل جهاز', 'A unit is recorded per device', 'بۆ هەر ئامێرێک یەکەیەک تۆمار دەکرێت') : t('بلا تسجيل وحدات', 'No units recorded', 'بێ تۆمارکردنی یەکە')}
            sub={serialized === null ? t('افتراضي', 'default', 'بنەڕەتی') : undefined}
          />
          {!canEditSerial && (
            <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-secondary" data-serial-policy-locked>
              <Lock className="h-3 w-3" aria-hidden />
              {ss.policyOwnerOnly}
            </span>
          )}
        </Field>
      </Grid>

      {plans.length > 0 && (
        <div className="mt-3" data-form="warranty-old-plans">
          <Banner kind={planErrors.length > 0 ? 'error' : 'warn'}>
            {t(
              `محفوظ مع هذا المنتج ${plans.length} خطة ضمان ممدد قديمة. الضمان يُباع الآن من «خصص طابعتك»، ولا تُعدَّل هذه الخطط هنا.`,
              `${plans.length} old extended-warranty plan(s) are stored with this product. The warranty is sold through «Customize your printer» now, and these plans are no longer edited here.`,
              `${plans.length} پلانی گەرەنتی درێژکراوەی کۆن لەگەڵ ئەم بەرهەمە پاشەکەوت کراوە. گەرەنتی ئێستا لە «پرینتەرەکەت ڕێکبخە»وە دەفرۆشرێت، و ئەم پلانانە لێرە دەستکاری ناکرێن.`
            )}
            {planErrors.length > 0 && (
              <ul className="mt-1 list-disc ps-5">
                {planErrors.map((e) => <li key={e}>{e}</li>)}
              </ul>
            )}
            <div className="mt-2">
              <button type="button" className={`${btnGhost} h-8 text-[12px]`} onClick={() => onPlansChange([])} data-form="warranty-old-plans-clear">
                {t('حذف خطط الضمان القديمة', 'Remove the old warranty plans', 'سڕینەوەی پلانە کۆنەکانی گەرەنتی')}
              </button>
            </div>
          </Banner>
        </div>
      )}
    </div>
  );
}
