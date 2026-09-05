/**
 * "Choose your card": the tier selector and the duration cards.
 *
 * The tier is a Segmented radio group with the tier's own accent; the
 * durations are equal cards in a balanced grid — two by two on a phone, one
 * row of four from 640px, and a lone annual plan sits centred at a fixed
 * width rather than stretching across the column. "Best value" is only
 * written on a card when its per-month price is arithmetically the lowest
 * of the tier's priced plans; a tier with one plan has no best value.
 */
import React from 'react';
import { motion } from 'motion/react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { formatIqd } from '../../lib/api';
import { Segmented } from '../ui/Segmented';
import { TabPanels } from '../ui/Tabs';
import { ErrorState, EmptyState } from '../ui/AsyncStates';
import { TIER_META, type AnyTier, type PaidTier } from './tierMeta';
import type { ApiPlan } from './types';

export interface PlanPickerProps {
  plans: ApiPlan[] | null;
  error: unknown;
  onRetry: () => void;
  tiers: PaidTier[];
  activeTier: PaidTier;
  onTierChange: (t: PaidTier) => void;
  tierPlans: ApiPlan[];
  selectedPlanId: string;
  onSelectPlan: (id: string) => void;
  /** The account's active tier, marked "current" on the selector. */
  currentTier: AnyTier;
}

/** Balanced columns for n plans. Literal strings so Tailwind can see them. */
function gridCols(n: number): string {
  if (n <= 1) return 'grid-cols-1 max-w-[16rem] mx-auto';
  if (n === 2) return 'grid-cols-2 max-w-md mx-auto';
  if (n === 3) return 'grid-cols-3';
  if (n === 4) return 'grid-cols-2 sm:grid-cols-4';
  return 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4';
}

/**
 * The plan whose DISPLAYED per-month price is strictly the lowest — or none.
 * The comparison is made on the server's rounded `per_month_iqd`, the very
 * figure written on the cards: two cards that read the same per-month amount
 * are a tie, and a tie is not a best value.
 */
export function bestValuePlanId(plans: ApiPlan[]): string | null {
  const priced = plans.filter((p) => p.per_month_iqd !== null && p.price_iqd !== null && p.duration_months > 0);
  if (priced.length < 2) return null;
  const perMonth = (p: ApiPlan) => p.per_month_iqd as number;
  const sorted = [...priced].sort((a, b) => perMonth(a) - perMonth(b));
  return perMonth(sorted[0]) < perMonth(sorted[1]) ? sorted[0].id : null;
}

export function PlanPicker({
  plans,
  error,
  onRetry,
  tiers,
  activeTier,
  onTierChange,
  tierPlans,
  selectedPlanId,
  onSelectPlan,
  currentTier,
}: PlanPickerProps) {
  const { t } = useLanguage();
  const m = useMotion();
  const meta = TIER_META[activeTier];
  const best = bestValuePlanId(tierPlans);

  return (
    <section aria-labelledby="choose-card-title" className="relative">
      <h3 id="choose-card-title" className="text-lg font-bold text-gold mb-4 text-center lg:text-start">
        {t('chooseCard')}
      </h3>

      {tiers.length > 0 && (
        <Segmented
          group="tier"
          label={t('chooseCard')}
          value={activeTier}
          onChange={(id) => onTierChange(id as PaidTier)}
          dataAttr="data-tier-tab"
          className="mb-5"
          items={tiers.map((tier) => {
            const tm = TIER_META[tier];
            return {
              id: tier,
              label: tm.label,
              icon: <tm.Icon className="w-4 h-4 shrink-0" aria-hidden />,
              accent: { indicator: tm.indicator, text: tm.text },
              badge:
                currentTier === tier ? (
                  <span className="hidden sm:inline text-[9px] font-bold px-1.5 py-px rounded-full bg-white/10 text-zinc-200 border border-white/15">
                    {t('currentTier')}
                  </span>
                ) : undefined,
            };
          })}
        />
      )}

      {plans === null && !error ? (
        <div role="status" aria-busy="true" className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
          <span className="sr-only">{t('loadingPlans')}</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-40 rounded-2xl bg-zinc-800/50 animate-pulse motion-reduce:animate-none" aria-hidden />
          ))}
        </div>
      ) : error ? (
        // A failed fetch is an error with a retry — never "no plans".
        <ErrorState error={error} onRetry={onRetry} compact />
      ) : tiers.length === 0 ? (
        <EmptyState compact title={t('noPlans')} />
      ) : (
        <TabPanels value={activeTier} order={tiers}>
          <div
            role="radiogroup"
            aria-label={t('chooseDuration')}
            className={`grid gap-3 pt-3 ${gridCols(tierPlans.length)}`}
          >
            {tierPlans.map((p) => {
              const priced = p.price_iqd !== null; // null = unpriced; 0 is a real price
              const on = selectedPlanId === p.id;
              const isBest = best === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  data-plan={p.id}
                  onClick={() => onSelectPlan(p.id)}
                  className={`relative w-full min-w-0 min-h-[10.5rem] rounded-2xl border p-3 flex flex-col items-center justify-between text-center press-scale transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 ${
                    on ? 'border-transparent bg-zinc-900/70' : 'border-white/10 bg-zinc-900/40 hover:border-white/25'
                  }`}
                >
                  {on && (
                    <motion.span
                      // The ring is one element per tier that travels between
                      // the cards, so a change of mind reads as a move, not a
                      // blink. A new tier gets a fresh ring (its own layoutId).
                      layoutId={`plan-ring-${activeTier}`}
                      data-plan-ring
                      aria-hidden
                      className={`absolute -inset-px rounded-2xl border-2 ${meta.ring}`}
                      style={{ boxShadow: `0 0 24px ${meta.hex}33` }}
                      transition={m.reduced ? { duration: 0 } : m.spring('quick')}
                    />
                  )}
                  {isBest && (
                    <span
                      data-best-value
                      className={`absolute -top-2.5 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 text-[9.5px] font-black px-2 py-0.5 rounded-full border whitespace-nowrap ${meta.chip}`}
                    >
                      {t('bestValue')}
                    </span>
                  )}

                  <span className="relative z-10 mt-2 flex flex-col items-center">
                    <span className={`font-black leading-none text-[clamp(1.9rem,8vw,2.6rem)] tabular-nums ${on ? 'text-white' : 'text-zinc-100'}`} dir="ltr">
                      {p.duration_months}
                    </span>
                    <span className="text-zinc-400 text-[12px] mt-1">
                      {p.duration_months === 1 ? t('month') : t('months')}
                    </span>
                  </span>

                  <span className="relative z-10 flex flex-col items-center w-full min-w-0 mt-2">
                    {priced ? (
                      <>
                        <span className="text-white font-bold text-[13.5px] tabular-nums truncate max-w-full" dir="ltr">
                          {formatIqd(p.price_iqd as number)}
                        </span>
                        {/* Two short lines, not one long one: a four-up row inside
                            the desktop two-column layout leaves ~100px per card.
                            The per-month figure is the server's (per_month_iqd). */}
                        {p.duration_months > 1 && p.per_month_iqd !== null && (
                          <>
                            <span className="text-zinc-400 text-[11px] tabular-nums truncate max-w-full mt-0.5" dir="ltr">
                              {formatIqd(p.per_month_iqd)}
                            </span>
                            <span className="text-zinc-500 text-[10px] truncate max-w-full">{t('perMonth')}</span>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="text-amber-400 font-bold text-[12px] truncate max-w-full">{t('priceTBA')}</span>
                        <span className="text-[10px] text-amber-500/80">{t('comingSoon')}</span>
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </TabPanels>
      )}
    </section>
  );
}

export default PlanPicker;
