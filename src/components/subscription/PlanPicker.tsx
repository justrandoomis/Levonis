/**
 * The duration, when there is one to choose.
 *
 * Only a tier that sells more than one plan (PLUS today) gets a control: a
 * Segmented radio group whose options carry the per-month figure — the
 * server's `per_month_iqd`, never a division done here — and «الأوفر» on the
 * option that is arithmetically the cheapest per month. A tier that sells one
 * plan says so in a line of text; a radio group with one option is a question
 * nobody can answer differently.
 */
import React from 'react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';
import { Segmented } from '../ui/Segmented';
import { TIER_META, durationLabel, type PaidTier } from './tierMeta';
import type { ApiPlan } from './types';

/**
 * The plan whose DISPLAYED per-month price is strictly the lowest — or none.
 * The comparison is made on the server's rounded `per_month_iqd`, the very
 * figure written on the options: two that read the same per-month amount are
 * a tie, and a tie is not a best value.
 */
export function bestValuePlanId(plans: ApiPlan[]): string | null {
  const priced = plans.filter((p) => p.per_month_iqd !== null && p.price_iqd !== null && p.duration_months > 0);
  if (priced.length < 2) return null;
  const perMonth = (p: ApiPlan) => p.per_month_iqd as number;
  const sorted = [...priced].sort((a, b) => perMonth(a) - perMonth(b));
  return perMonth(sorted[0]) < perMonth(sorted[1]) ? sorted[0].id : null;
}

export interface PlanPickerProps {
  tier: PaidTier;
  /** The tier's plans, shortest first. */
  tierPlans: ApiPlan[];
  selectedPlanId: string;
  onSelectPlan: (id: string) => void;
}

export function PlanPicker({ tier, tierPlans, selectedPlanId, onSelectPlan }: PlanPickerProps) {
  const { t, loc, lang } = useLanguage();
  const { money } = useMoney();
  const meta = TIER_META[tier];

  if (tierPlans.length === 0) return null;
  if (tierPlans.length === 1) {
    const only = tierPlans[0];
    return (
      <p data-single-plan className="text-[13px] text-text-secondary">
        <span className="font-semibold text-text-primary">
          {only.duration_months === 12 ? loc('اشتراك سنوي', 'Annual membership', 'ئەندامێتیی ساڵانە') : t('chooseDuration')}
        </span>
        {' · '}
        {durationLabel(only.duration_months, lang)}
      </p>
    );
  }

  const best = bestValuePlanId(tierPlans);
  return (
    <div>
      <h3 id="duration-title" className="mb-2 text-[13px] font-semibold text-text-secondary">
        {t('chooseDuration')}
      </h3>
      <Segmented
        group={`duration-${tier}`}
        label={t('chooseDuration')}
        value={selectedPlanId}
        onChange={onSelectPlan}
        dataAttr="data-plan"
        items={tierPlans.map((p) => ({
          id: p.id,
          accent: { indicator: 'bg-surface-selected border-border-subtle', text: 'text-text-primary' },
          label: (
            <span className="flex flex-col items-center leading-tight py-1">
              <span className="text-[13px] font-bold">{durationLabel(p.duration_months, lang)}</span>
              {p.per_month_iqd !== null ? (
                <span className="text-[11px] font-medium text-text-muted tabular-nums">
                  {money(p.per_month_iqd)}
                </span>
              ) : (
                <span className="text-[11px] font-medium text-text-muted">{t('priceTBA')}</span>
              )}
              {best === p.id && (
                <span data-best-value className={`mt-0.5 text-[10px] font-bold ${meta.text}`}>
                  {t('bestValue')}
                </span>
              )}
            </span>
          ),
        }))}
      />
      <p className="mt-1.5 text-[11.5px] text-text-muted">{loc('السعر الشهري تحت كل مدة', 'Monthly price under each option', 'نرخی مانگانە')}</p>
    </div>
  );
}

export default PlanPicker;
