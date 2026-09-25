/**
 * A SECTION'S POOLED QUANTITY DELIVERY RULE (migration 0135).
 *
 * Owner, 2026-09-25: «توصيل العادي قسم fdm filament على القسم الفرعي كاملا هو
 * 5000 لكل 15 بكرة». Every unit filed under this section or any of its
 * sub-sections — any product, option or colour — counts toward ONE pool per
 * order, and the delivery for that pool is ceil(units ÷ step) × fee, the same
 * formula as the per-product rule (the first block is charged). The nearest
 * section with a rule wins, and a pooled line is not also charged by its
 * product rule or the ordinary flat fee. The server is the authority
 * (packages/shipping `quoteShipping`); this dialog only writes the rule.
 *
 * OWNER: Sorani to be written by hand — only the method name reuses existing
 * hand-written Sorani; every other string passes ar/en and falls back to Arabic.
 */
import React, { useState } from 'react';
import { ApiError, api } from '../../lib/api';
import * as T from '../adminProducts/theme';
import { Check, Dialog, FieldRow, fmtN, nameOf, useLoc, type CatalogNode, type SectionDeliveryRule } from './shared';

type Method = SectionDeliveryRule['method'];
const METHODS: Method[] = ['standard', 'personal'];

interface Draft {
  on: boolean;
  step: string;
  fee: string;
}

/** ceil(units / step) × fee — the preview line under each method. */
export function pooledFeeIqd(units: number, step: number, fee: number): number {
  const u = Math.max(0, Math.trunc(units));
  const s = Math.max(1, Math.trunc(step));
  return u === 0 ? 0 : Math.ceil(u / s) * Math.max(0, Math.trunc(fee));
}

/** The one-line summary a section row shows, or '' when it has no rule. */
export function deliveryRuleSummary(
  rules: SectionDeliveryRule[] | undefined,
  loc: (ar: string, en: string, ckb?: string) => string
): string {
  const on = (rules ?? []).filter((r) => r.enabled);
  return on
    .map((r) =>
      r.method === 'standard'
        ? loc(`عادي: ${fmtN(r.fee_iqd)} د.ع لكل ${fmtN(r.quantity_step)}`, `Standard: ${fmtN(r.fee_iqd)} IQD per ${fmtN(r.quantity_step)}`)
        : loc(`شخصي: ${fmtN(r.fee_iqd)} د.ع لكل ${fmtN(r.quantity_step)}`, `Personal: ${fmtN(r.fee_iqd)} IQD per ${fmtN(r.quantity_step)}`)
    )
    .join(' · ');
}

export function SectionDeliveryDialog({
  node,
  onClose,
  onSaved,
}: {
  node: CatalogNode;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { loc } = useLoc();
  const initial = (m: Method): Draft => {
    const r = node.delivery_rules?.find((x) => x.method === m);
    return r ? { on: r.enabled, step: String(r.quantity_step), fee: String(r.fee_iqd) } : { on: false, step: '', fee: '' };
  };
  const [drafts, setDrafts] = useState<Record<Method, Draft>>({ standard: initial('standard'), personal: initial('personal') });
  const set = (m: Method, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [m]: { ...d[m], ...patch } }));
  const dirty = METHODS.some((m) => {
    const a = drafts[m];
    const b = initial(m);
    return a.on !== b.on || a.step !== b.step || a.fee !== b.fee;
  });

  const label = (m: Method) => (m === 'standard' ? loc('التوصيل العادي', 'Standard delivery', 'گەیاندنی ئاسایی') : loc('التوصيل الشخصي', 'Personal delivery'));

  return (
    <Dialog
      titleAr={`قاعدة توصيل القسم «${nameOf(node, 'ar')}»`}
      titleEn={`Section delivery rule — "${nameOf(node, 'en')}"`}
      onClose={onClose}
      dirty={dirty}
      testId="section-delivery"
      onSave={async () => {
        for (const m of METHODS) {
          const d = drafts[m];
          const had = node.delivery_rules?.some((x) => x.method === m) ?? false;
          const path = `/api/admin/taxonomy/catalogs/${encodeURIComponent(node.id)}/delivery-rules/${m}`;
          if (!d.on) {
            if (had) await api.delete(path);
            continue;
          }
          const step = Number(d.step);
          const fee = Number(d.fee);
          if (!Number.isInteger(step) || step < 1) {
            throw new Error(loc(`${label(m)}: عدد القطع لكل دفعة يجب أن يكون عددًا صحيحًا ≥ 1.`, `${label(m)}: units per block must be a whole number ≥ 1.`));
          }
          if (!Number.isInteger(fee) || fee < 0) {
            throw new Error(loc(`${label(m)}: الرسم يجب أن يكون عددًا صحيحًا بالدينار.`, `${label(m)}: the fee must be a whole number of IQD.`));
          }
          try {
            await api.put(path, { enabled: true, quantity_step: step, fee_iqd: fee });
          } catch (e) {
            if (e instanceof ApiError && typeof e.code === 'string' && e.code.startsWith('CATEGORY_DELIVERY_')) {
              throw new Error(loc('القيم غير صالحة — راجع العدد والرسم.', 'Invalid values — check the units and the fee.'));
            }
            throw e;
          }
        }
        await onSaved();
      }}
    >
      <p className="text-[12.5px] text-[var(--ap-text-2)]">
        {loc(
          'كل القطع في هذا القسم وأقسامه الفرعية — أي منتج، أي خيار، أي لون — تُجمع معًا في الطلب الواحد، ويُحسب التوصيل: عدد الدفعات (تقريب للأعلى) × رسم الدفعة. تحل هذه القاعدة محل رسم التوصيل الخاص بكل منتج ومحل رسم التوصيل العادي لهذه القطع، ولا تُضاف فوقهما. إعفاءات العضوية والعروض تنطبق عليها كما تنطبق على التوصيل.',
          'Every unit in this section and its sub-sections — any product, option or colour — is pooled per order, and delivery is: started blocks × the block fee. This rule replaces the per-product delivery rule and the flat ordinary fee for those units; it is never added on top. Membership and promotion waivers apply to it like any delivery fee.'
        )}
      </p>
      {METHODS.map((m) => {
        const d = drafts[m];
        const step = Number(d.step);
        const fee = Number(d.fee);
        const valid = Number.isInteger(step) && step >= 1 && Number.isInteger(fee) && fee >= 0;
        const example = valid ? Math.max(step + 1, 20) : 0;
        return (
          <fieldset key={m} className="rounded-xl border border-[var(--ap-border)] p-3 grid gap-3" data-section-delivery={m}>
            <legend className="px-1 text-[13px] font-semibold text-[var(--ap-text-1)]">{label(m)}</legend>
            <Check
              id={`sd-${m}-on`}
              label={loc('تفعيل قاعدة القسم لهذه الطريقة', 'Use a section rule for this method')}
              checked={d.on}
              onChange={(v) => set(m, { on: v })}
            />
            {d.on && (
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldRow id={`sd-${m}-step`} label={loc('عدد القطع لكل دفعة', 'Units per block')} required ltr>
                  <input
                    id={`sd-${m}-step`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    className={`${T.input} w-full`}
                    value={d.step}
                    onChange={(e) => set(m, { step: e.target.value })}
                    placeholder="15"
                  />
                </FieldRow>
                <FieldRow id={`sd-${m}-fee`} label={loc('رسم كل دفعة (د.ع)', 'Fee per block (IQD)')} required ltr>
                  <input
                    id={`sd-${m}-fee`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={250}
                    className={`${T.input} w-full`}
                    value={d.fee}
                    onChange={(e) => set(m, { fee: e.target.value })}
                    placeholder="5000"
                  />
                </FieldRow>
                {valid && (
                  <p className="sm:col-span-2 text-[12px] text-[var(--ap-text-3)] tabular-nums" data-section-delivery-example>
                    {loc(
                      `مثال: ${fmtN(example)} قطعة = ${fmtN(Math.ceil(example / step))} × ${fmtN(fee)} = ${fmtN(pooledFeeIqd(example, step, fee))} د.ع`,
                      `Example: ${fmtN(example)} units = ${fmtN(Math.ceil(example / step))} × ${fmtN(fee)} = ${fmtN(pooledFeeIqd(example, step, fee))} IQD`
                    )}
                  </p>
                )}
              </div>
            )}
          </fieldset>
        );
      })}
      <p className="text-[11.5px] text-[var(--ap-text-3)]">
        {loc('قاعدة القسم الفرعي تتقدم على قاعدة القسم الرئيسي.', 'A sub-section’s rule takes precedence over its main section’s.')}
      </p>
    </Dialog>
  );
}
