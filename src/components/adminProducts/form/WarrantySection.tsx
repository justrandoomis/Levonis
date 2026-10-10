/**
 * The extended-warranty block of the product form — PRINTERS ONLY (owner
 * mandate). It appears when the chosen section (or its sub-section) is a
 * printer catalog, and it edits exactly what the server stores:
 *
 *  - the device coverage the plans rest on: `serialized` (a unit is recorded
 *    per physical printer at delivery) and `warranty_base_months` (12 by
 *    default — the clock the extension is added to);
 *  - the two plans the store sells, as two switches: +12 months → 24 in
 *    total, +24 months → 36 in total. Each is priced as a PERCENT of the
 *    printer's regular price (the owner's example range, 7.5–10%, is shown as
 *    a hint, not enforced), with an optional fixed IQD fee for a plan that
 *    states no percent. The dinar preview beside each switch is the same
 *    arithmetic the resolver runs (model.ts `warrantyFee`, a faithful copy of
 *    worker/lib/warrantyPlans.ts), on the base price the admin typed.
 *
 * The plan ids are stable (`wp_ext12` / `wp_ext24`) so a re-save updates the
 * plan a customer's cart already points at instead of retiring it; titles are
 * English (§3) and the server's local translator fills ar/ckb. A product that
 * is NOT a printer but still carries plans (older data) gets a warning and a
 * one-click clear, because the server refuses that save (WARRANTY_NOT_PRINTER).
 */

import React from 'react';
import { Lock, ScanLine, ShieldCheck } from 'lucide-react';
import { formatIqd } from '../../../lib/api';
import { useLanguage } from '../../../LanguageContext';
import { Segmented } from '../../ui/Segmented';
import { serialStrings } from '../../adminOrders/serials/strings';
import type { WarrantyPlanV2 } from '../../../lib/productTypes';
import { Banner, Field, Grid, Money, Percent, Qty, Toggle, btnGhost } from './formUi';
import { FEE_PERCENT_HINT, PRINTER_BASE_MONTHS, PRINTER_EXTENSION_MONTHS, warrantyFee } from './model';
import type { FormErrors } from './model';

const PLAN_ID: Record<number, string> = { 12: 'wp_ext12', 24: 'wp_ext24' };

function planTitle(ext: number, base: number): string {
  return `Extended warranty +${ext} months (${base + ext} months total)`;
}

function planTerms(ext: number, base: number): string {
  return `Adds ${ext} months to the ${base}-month base warranty (${base + ext} months in total) — the same manufacturing-defect coverage, from the delivery date. Purchased with the printer only.`;
}

export function WarrantySection({
  isPrinter,
  plans,
  serialized,
  baseMonths,
  priceIqd,
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
  /** The product's regular base price — the preview's basis. */
  priceIqd: number | null;
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
  const base = baseMonths ?? PRINTER_BASE_MONTHS;
  const effectiveSerialized = serialized ?? true;

  if (!isPrinter) {
    return (
      <>
        <SerialTracking serialized={serialized} canEdit={canEditSerial} section={sectionSerial} onChange={onSerializedChange} />
        {plans.length > 0 && <LegacyPlansBanner plans={plans} onPlansChange={onPlansChange} />}
      </>
    );
  }
  return (
    <PrinterWarranty
      base={base}
      plans={plans}
      serialized={serialized}
      effectiveSerialized={effectiveSerialized}
      baseMonths={baseMonths}
      priceIqd={priceIqd}
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
  return (
      <div className="mb-3 min-w-0" data-form="warranty-not-printer">
        <Banner kind="warn">
          الضمان الممدد للطابعات فقط. هذا المنتج ليس في قسم طابعات ويحمل {plans.length} خطة ضمان قديمة — سيُرفض الحفظ حتى
          تُحذف الخطط أو يُنقل المنتج إلى قسم طابعات.
          <div className="mt-2">
            <button type="button" className={`${btnGhost} h-8 text-[12px]`} onClick={() => onPlansChange([])}>
              حذف خطط الضمان
            </button>
          </div>
        </Banner>
      </div>
  );
}

function PrinterWarranty({
  base,
  plans,
  serialized,
  effectiveSerialized,
  baseMonths,
  priceIqd,
  errors,
  onPlansChange,
  onSerializedChange,
  onBaseMonthsChange,
  canEditSerial = false,
}: {
  base: number;
  plans: WarrantyPlanV2[];
  serialized: boolean | null;
  effectiveSerialized: boolean;
  baseMonths: number | null;
  priceIqd: number | null;
  errors: FormErrors;
  onPlansChange: (next: WarrantyPlanV2[]) => void;
  onSerializedChange: (v: boolean) => void;
  onBaseMonthsChange: (v: number | null) => void;
  canEditSerial?: boolean;
}) {
  const { lang } = useLanguage();
  const ss = serialStrings(lang);

  const planFor = (ext: number) =>
    plans.find((p) => p.duration_kind === 'extension' && p.duration_months === ext) ?? null;

  const setPlan = (ext: number, on: boolean) => {
    const existing = planFor(ext);
    if (!on) {
      onPlansChange(plans.filter((p) => p !== existing));
      return;
    }
    if (existing) {
      onPlansChange(plans.map((p) => (p === existing ? { ...p, active: true } : p)));
      return;
    }
    const order = PRINTER_EXTENSION_MONTHS.indexOf(ext as 12 | 24);
    const fresh: WarrantyPlanV2 = {
      id: PLAN_ID[ext] ?? `wp_ext${ext}`,
      title_en: planTitle(ext, base),
      title_ar: '',
      title_ckb: '',
      terms_en: planTerms(ext, base),
      terms_ar: '',
      terms_ckb: '',
      duration_months: ext,
      duration_kind: 'extension',
      fee_iqd: 0,
      fee_percent: null,
      order: order < 0 ? plans.length : order,
      active: true,
    };
    onPlansChange([...plans, fresh].sort((a, b) => a.duration_months - b.duration_months));
  };

  const patchPlan = (ext: number, patch: Partial<WarrantyPlanV2>) =>
    onPlansChange(
      plans.map((p) => (p.duration_kind === 'extension' && p.duration_months === ext ? { ...p, ...patch } : p))
    );

  // Plans the two switches cannot express (legacy 'total' kinds, odd
  // durations): shown so the admin knows why the save is refused.
  const foreign = plans.filter((p) => p.duration_kind !== 'extension' || !(PRINTER_EXTENSION_MONTHS as readonly number[]).includes(p.duration_months));

  return (
    <div className="mb-3 min-w-0 rounded-xl border border-gold/25 bg-gold/[0.04] p-3" data-form="extended-warranty">
      <div className="flex items-start gap-2 mb-2.5 min-w-0">
        <ShieldCheck className="w-4 h-4 text-gold shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <h4 className="text-[12.5px] font-bold text-white">
            الضمان الممدد <span className="text-[10px] font-medium text-text-muted">Extended warranty · printers only</span>
          </h4>
          <p className="text-[11px] text-text-secondary leading-snug">
            يشتريه الزبون قبل إتمام الطلب فقط (صفحة المنتج أو السلة). الرسم نسبة من سعر الطابعة الاعتيادي، ولا يُعفى
            بالعضوية.
          </p>
        </div>
      </div>

      <Grid cols={2}>
        <Field
          ar="مدة الضمان الأساسي"
          en="Base months"
          hint={`من تاريخ التسليم — ${PRINTER_BASE_MONTHS} شهرًا للطابعات`}
          error={errors.warranty_base_months ?? null}
        >
          <Qty value={baseMonths} onChange={onBaseMonthsChange} placeholder={`${PRINTER_BASE_MONTHS} (افتراضي)`} />
        </Field>
        <Field
          ar="جهاز مُرقَّم"
          en="Serialized"
          hint="وحدة لكل طابعة عند التسليم — عليها يُسجَّل الضمان"
          error={errors.serialized ?? null}
        >
          <Toggle
            checked={effectiveSerialized}
            onChange={onSerializedChange}
            disabled={!canEditSerial}
            label={effectiveSerialized ? 'تُسجَّل وحدة لكل جهاز' : 'بلا تسجيل وحدات'}
            sub={serialized === null ? 'افتراضي' : undefined}
          />
          {!canEditSerial && (
            <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-text-secondary" data-serial-policy-locked>
              <Lock className="h-3 w-3" aria-hidden />
              {ss.policyOwnerOnly}
            </span>
          )}
        </Field>
      </Grid>

      <div className="grid gap-2 mt-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
        {PRINTER_EXTENSION_MONTHS.map((ext) => {
          const plan = planFor(ext);
          const on = !!plan && plan.active;
          const planErr = plan ? errors[`warranty_plan:${plan.id}`] ?? null : null;
          const pctErr = plan ? errors[`warranty_percent:${plan.id}`] ?? null : null;
          const preview = plan && priceIqd !== null && priceIqd > 0 ? warrantyFee(plan, priceIqd) : null;
          return (
            <div
              key={ext}
              data-form={`warranty-plan-${ext}`}
              className={`rounded-lg border border-border-subtle p-2.5 min-w-0 ${on ? 'bg-surface-raised' : ''}`}
            >
              <Toggle
                checked={on}
                onChange={(v) => setPlan(ext, v)}
                label={`+${ext} شهرًا`}
                sub={`→ ${base + ext} شهرًا إجمالًا`}
              />
              {on && plan && (
                <div className="mt-2 space-y-2 min-w-0">
                  <Field
                    ar="النسبة من سعر الطابعة"
                    en="Fee percent"
                    hint={`الموصى به ${FEE_PERCENT_HINT.min}%–${FEE_PERCENT_HINT.max}%`}
                    error={pctErr}
                  >
                    <Percent
                      value={plan.fee_percent}
                      onChange={(v) => patchPlan(ext, { fee_percent: v })}
                      placeholder={String(FEE_PERCENT_HINT.min)}
                    />
                  </Field>
                  <Field
                    ar="أو رسم ثابت"
                    en="Fixed fee (IQD)"
                    hint={plan.fee_percent !== null ? 'مهمل ما دامت النسبة محددة' : 'يُستخدم عندما لا توجد نسبة؛ 0 = مجاني'}
                  >
                    <Money
                      value={plan.fee_iqd}
                      onChange={(v) => patchPlan(ext, { fee_iqd: v ?? 0 })}
                      placeholder="0"
                      disabled={plan.fee_percent !== null}
                    />
                  </Field>
                  <p className="text-[11px] text-text-secondary tabular-nums" data-form={`warranty-preview-${ext}`}>
                    {preview !== null
                      ? `على السعر الأساسي ${formatIqd(priceIqd as number)}: +${formatIqd(preview)}`
                      : 'أدخل السعر الأساسي لعرض مثال على الرسم'}
                  </p>
                  {planErr && <p className="text-[11px] text-red-400">{planErr}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {foreign.length > 0 && (
        <div className="mt-2">
          <Banner kind="error">
            {foreign.length} خطة قديمة لا تطابق شكل الطابعات (تمديد +12 أو +24 فقط) — سيُرفض الحفظ حتى تُحذف:{' '}
            <span className="font-mono text-[11px]" dir="ltr">
              {foreign.map((p) => `${p.id} (${p.duration_months} ${p.duration_kind})`).join(', ')}
            </span>
            <div className="mt-2">
              <button
                type="button"
                className={`${btnGhost} h-8 text-[12px]`}
                onClick={() => onPlansChange(plans.filter((p) => !foreign.includes(p)))}
              >
                حذف الخطط القديمة
              </button>
            </div>
          </Banner>
        </div>
      )}
      {errors.warranty_plans && <p className="mt-2 text-[11px] text-red-400">{errors.warranty_plans}</p>}
    </div>
  );
}
