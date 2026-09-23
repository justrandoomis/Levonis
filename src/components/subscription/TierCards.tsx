/**
 * «اختر بطاقتك» — one card per tier, the choice made where the offer is read.
 *
 * The old selector was a pill of three names with the benefits three screens
 * further down, so a customer chose before they could see what each tier
 * gives. Each card now carries its own face, its price (the server's figures:
 * `price_iqd`, `per_month_iqd`), three things it is for, and where the account
 * stands against it — the current card, an upgrade, one already included, or
 * one whose price is not announced yet.
 *
 * ONE SELECTION CUE (.claude/skills/apple-design §3): a 1px ring in the tier's
 * colour and a small filled check. The ring is one element shared across the
 * cards, so a change of mind travels on the house spring instead of blinking;
 * under reduced motion it jumps. The tier colour is used on the name, the
 * mark and that cue — nowhere else, and never as a glow.
 *
 * A real radio group: role=radiogroup / role=radio / aria-checked, a roving
 * tabindex, and arrow keys that follow the writing direction. «قارن» sits
 * beside the radio, not inside it, so no interactive element is nested in
 * another.
 */
import React, { useRef } from 'react';
import { motion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { useMoney } from '../../CurrencyContext';
import { ErrorState, EmptyState } from '../ui/AsyncStates';
import { CardArt } from './LevoCard';
import { TIER_META, durationLabel, durationSep, type PaidTier } from './tierMeta';
import type { ApiPlan } from './types';

/** Where the account stands against one tier. */
export type TierStanding = 'current' | 'upgrade' | 'included' | 'tba' | 'open';

export interface TierCardsProps {
  plans: ApiPlan[] | null;
  error: unknown;
  onRetry: () => void;
  tiers: PaidTier[];
  selected: PaidTier;
  onSelect: (tier: PaidTier) => void;
  standing: Record<PaidTier, TierStanding>;
  highlights: Record<PaidTier, string[]>;
  onCompare: () => void;
}

export function TierCards({
  plans,
  error,
  onRetry,
  tiers,
  selected,
  onSelect,
  standing,
  highlights,
  onCompare,
}: TierCardsProps) {
  const { t, loc, lang, dir } = useLanguage();
  const { money } = useMoney();
  const m = useMotion();
  const refs = useRef<Partial<Record<PaidTier, HTMLButtonElement | null>>>({});

  if (plans === null && !error) {
    return (
      <div role="status" aria-busy="true" className="grid gap-3 md:grid-cols-3">
        <span className="sr-only">{t('loadingPlans')}</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-44 md:h-80 rounded-[20px] bg-surface border border-border-subtle animate-pulse motion-reduce:animate-none" aria-hidden />
        ))}
      </div>
    );
  }
  // A failed fetch is an error with a retry — never "no plans".
  if (error) return <ErrorState error={error} onRetry={onRetry} compact />;
  if (tiers.length === 0) return <EmptyState compact title={t('noPlans')} />;

  const choose = (tier: PaidTier) => {
    onSelect(tier);
    refs.current[tier]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // "Forward" is the writing direction: ArrowRight goes back in Arabic.
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const i = Math.max(0, tiers.indexOf(selected));
    if (e.key === forward || e.key === 'ArrowDown') {
      e.preventDefault();
      choose(tiers[(i + 1) % tiers.length]);
    } else if (e.key === back || e.key === 'ArrowUp') {
      e.preventDefault();
      choose(tiers[(i - 1 + tiers.length) % tiers.length]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      choose(tiers[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      choose(tiers[tiers.length - 1]);
    }
  };

  return (
    <div role="radiogroup" aria-labelledby="choose-card-title" onKeyDown={onKeyDown} className="grid gap-3 md:grid-cols-3 md:gap-4">
      {tiers.map((tier) => {
        const meta = TIER_META[tier];
        const on = tier === selected;
        const own = (plans || []).filter((p) => p.tier === tier).sort((a, b) => a.duration_months - b.duration_months);
        const priced = own.filter((p) => p.price_iqd !== null);
        const longest = priced[priced.length - 1] ?? null;
        const cheapestMonthly = priced.reduce<ApiPlan | null>(
          (best, p) => (p.per_month_iqd !== null && (!best || (best.per_month_iqd ?? Infinity) > p.per_month_iqd) ? p : best),
          null
        );
        const state = standing[tier];
        const badge =
          state === 'current'
            ? t('yourCurrentPlan')
            : state === 'upgrade'
              ? t('upgradeBadge')
              : state === 'included'
                ? t('includedInYours')
                : state === 'tba'
                  ? t('priceTBA')
                  : null;
        return (
          <div key={tier} className="relative">
            <button
              ref={(el) => {
                refs.current[tier] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-tier-tab={tier}
              data-tier-card={tier}
              onClick={() => onSelect(tier)}
              className={`relative flex flex-col justify-start w-full h-full text-start rounded-[20px] border border-border-subtle bg-surface p-4 pb-14 md:p-5 md:pb-16 transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
                on ? 'bg-surface-raised' : ''
              }`}
            >
              {on && (
                <motion.span
                  // One ring, shared by every card: a change of mind moves it.
                  layoutId="tier-card-ring"
                  data-tier-ring
                  aria-hidden
                  className="pointer-events-none absolute -inset-px rounded-[20px] border"
                  style={{ borderColor: meta.hex }}
                  transition={m.reduced ? { duration: 0 } : m.spring('quick')}
                />
              )}

              <span className="flex w-full items-start gap-3 md:flex-col md:gap-4">
                <CardArt tier={tier} size="md" className="max-md:w-14 max-md:h-[35px] max-md:rounded-[7px] md:w-28 md:h-[4.45rem] md:rounded-[11px]" />
                <span className="min-w-0 flex-1 md:w-full">
                  <span className="flex items-center gap-1.5">
                    <meta.Icon className={`w-4 h-4 shrink-0 ${meta.text}`} aria-hidden />
                    <span className={`text-[15px] md:text-[16px] font-extrabold ${meta.text}`} dir="ltr">
                      {meta.label}
                    </span>
                  </span>
                  {priced.length === 0 ? (
                    <span className="mt-1 block text-[15px] font-bold text-text-secondary">{t('priceTBA')}</span>
                  ) : priced.length === 1 ? (
                    <span className="mt-1 block">
                      <span className="block text-[1.35rem] md:text-[1.75rem] leading-tight font-extrabold text-text-primary tabular-nums">
                        {money(priced[0].price_iqd as number)}
                      </span>
                      <span className="block text-[12px] text-text-muted tabular-nums">
                        {durationLabel(priced[0].duration_months, lang)}
                        {priced[0].duration_months > 1 && priced[0].per_month_iqd !== null && (
                          <>
                            {durationSep(lang)}
                            <bdi dir={dir}>{money(priced[0].per_month_iqd)}</bdi> {t('perMonth')}
                          </>
                        )}
                      </span>
                    </span>
                  ) : (
                    <span className="mt-1 block">
                      <span className="block text-[1.35rem] md:text-[1.75rem] leading-tight font-extrabold text-text-primary tabular-nums">
                        <span className="text-[13px] font-semibold text-text-secondary">{loc('من ', 'from ', 'لە ')}</span>
                        <span className="whitespace-nowrap">{money(cheapestMonthly?.per_month_iqd ?? (longest?.price_iqd as number))}</span>
                        <span className="text-[13px] font-semibold text-text-secondary"> / {lang === 'en' ? t('month').toLowerCase() : t('month')}</span>
                      </span>
                      {longest && (
                        <span className="block text-[12px] text-text-muted tabular-nums">
                          <bdi dir={dir}>{money(longest.price_iqd as number)}</bdi>
                          {durationSep(lang)}
                          {durationLabel(longest.duration_months, lang)}
                        </span>
                      )}
                    </span>
                  )}
                  {badge && (
                    <span
                      data-tier-standing={state}
                      className={`mt-2 inline-block max-w-full text-[11.5px] leading-snug font-semibold px-2 py-0.5 rounded-md border border-border-subtle bg-canvas/50 ${
                        state === 'current' ? 'text-success' : 'text-text-secondary'
                      }`}
                    >
                      {badge}
                    </span>
                  )}
                </span>
                {/* The small check: empty ring until chosen. */}
                <span
                  aria-hidden
                  className={`absolute top-4 end-4 md:top-5 md:end-5 w-5 h-5 rounded-full flex items-center justify-center transition-colors ${
                    on ? '' : 'border border-border-subtle'
                  }`}
                  style={on ? { backgroundColor: meta.hex } : undefined}
                >
                  {on && <Check className="w-3.5 h-3.5 text-canvas" strokeWidth={3} />}
                </span>
              </span>

              {highlights[tier].length > 0 && (
                <span className="mt-3.5 md:mt-5 block w-full space-y-1.5 border-t border-border-subtle/70 pt-3 md:pt-4">
                  {highlights[tier].map((line) => (
                    <span key={line} className="flex items-start gap-2 text-[12.5px] md:text-[13px] leading-relaxed text-text-secondary">
                      <Check className="mt-[3px] w-3.5 h-3.5 shrink-0 text-text-muted" strokeWidth={2.4} aria-hidden />
                      <span>{line}</span>
                    </span>
                  ))}
                </span>
              )}

            </button>
            <button
              type="button"
              onClick={onCompare}
              className="absolute bottom-2 end-2 md:bottom-3 md:end-3 inline-flex items-center gap-1 min-h-11 px-3 rounded-xl text-[12.5px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {t('compareLink')} <ChevronDown className="w-3.5 h-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default TierCards;
