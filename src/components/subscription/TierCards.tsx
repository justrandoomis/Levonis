/**
 * «اختر بطاقتك» — the card is the offer.
 *
 * What a customer buys here is a card, so the page shows the card: each tier
 * as the object itself, at the size of the real thing on a phone, in the
 * printed material every Levo card shares (cardMaterial in LevoCard.tsx).
 * The previous page drew a grid of boxes with a thumbnail in each; the box
 * was the design and the card a sticker on it. Now the box is gone and the
 * card carries its name, its price and where the account stands against it.
 *
 * TWO WAYS TO CHOOSE, ONE CHOICE.
 *   · The tier switch above the cards is the control: a real radio group
 *     (role=radiogroup / role=radio / aria-checked, a roving tabindex, arrow
 *     keys that follow the writing direction, Home/End). Its one selection
 *     cue is a pill that travels between the names on the house spring and
 *     jumps under reduced motion (.claude/skills/apple-design §3).
 *   · On a phone the cards are a rail you swipe; the card that settles in the
 *     middle IS the choice, and choosing a name brings its card to the middle.
 *     From 768px the three sit side by side, the chosen one raised and the
 *     others stepped back. A card is a pointer convenience, hidden from
 *     assistive tech — the switch says everything once.
 *
 * Under the cards, one panel for the chosen tier: the price as the headline
 * (the server's `price_iqd` / `per_month_iqd`, never arithmetic here), where
 * this account stands, and what the card is for — swapped with a short
 * cross-fade when the choice changes, so the reader sees WHAT changed.
 *
 * Motion is spent once: the cards rise in on the first paint. Everything else
 * answers a touch. Reduced motion drops every travel and keeps the fades.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMotion } from '../../lib/motion';
import { useMoney } from '../../CurrencyContext';
import { ErrorState, EmptyState } from '../ui/AsyncStates';
import { cardMaterial } from './LevoCard';
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

/** The server's figures for one tier, sorted — no arithmetic of our own. */
function priceFacts(plans: ApiPlan[] | null, tier: PaidTier) {
  const own = (plans || []).filter((p) => p.tier === tier).sort((a, b) => a.duration_months - b.duration_months);
  const priced = own.filter((p) => p.price_iqd !== null);
  const longest = priced[priced.length - 1] ?? null;
  const cheapestMonthly = priced.reduce<ApiPlan | null>(
    (best, p) => (p.per_month_iqd !== null && (!best || (best.per_month_iqd ?? Infinity) > p.per_month_iqd) ? p : best),
    null
  );
  return { priced, longest, cheapestMonthly };
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
  const railRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef<Partial<Record<PaidTier, HTMLDivElement | null>>>({});
  const settleTimer = useRef<number | null>(null);
  /** Set while WE are scrolling the rail, so its settling does not re-choose. */
  const steering = useRef(false);
  /** The rise-in is the page's one unprompted motion, and it happens once. */
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setEntered(true), 700);
    return () => window.clearTimeout(id);
  }, []);

  /** Is the rail actually a rail right now (a phone), or a row (768px+)? */
  const railScrolls = () => {
    const rail = railRef.current;
    return !!rail && rail.scrollWidth > rail.clientWidth + 4;
  };

  // A choice made anywhere else (the switch, the URL, a default) brings its
  // card to the middle of the rail.
  useEffect(() => {
    const card = cardRefs.current[selected];
    const rail = railRef.current;
    if (!card || !rail || !railScrolls()) return;
    const railBox = rail.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const delta = box.left + box.width / 2 - (railBox.left + railBox.width / 2);
    if (Math.abs(delta) < 4) return;
    steering.current = true;
    rail.scrollBy({ left: delta, behavior: m.reduced ? 'auto' : 'smooth' });
    const release = window.setTimeout(() => {
      steering.current = false;
    }, m.reduced ? 50 : 600);
    return () => window.clearTimeout(release);
  }, [selected, m.reduced, tiers.length]);

  // The card a swipe leaves in the middle is the choice.
  const onRailScroll = useCallback(() => {
    if (steering.current) return;
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const rail = railRef.current;
      if (!rail || steering.current) return;
      const mid = rail.getBoundingClientRect().left + rail.clientWidth / 2;
      let best: PaidTier | null = null;
      let bestGap = Infinity;
      for (const tier of tiers) {
        const el = cardRefs.current[tier];
        if (!el) continue;
        const b = el.getBoundingClientRect();
        const gap = Math.abs(b.left + b.width / 2 - mid);
        if (gap < bestGap) {
          bestGap = gap;
          best = tier;
        }
      }
      if (best && best !== selected) onSelect(best);
    }, 90);
  }, [tiers, selected, onSelect]);

  useEffect(
    () => () => {
      if (settleTimer.current) window.clearTimeout(settleTimer.current);
    },
    []
  );

  if (plans === null && !error) {
    return (
      <div role="status" aria-busy="true" className="space-y-5">
        <span className="sr-only">{t('loadingPlans')}</span>
        <div className="h-11 w-full max-w-sm rounded-full bg-surface border border-border-subtle animate-pulse motion-reduce:animate-none" aria-hidden />
        <div className="flex gap-4 overflow-hidden md:grid md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="shrink-0 w-[82%] md:w-auto aspect-[1.586/1] rounded-[22px] bg-surface border border-border-subtle animate-pulse motion-reduce:animate-none"
              aria-hidden
            />
          ))}
        </div>
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

  const badgeFor = (state: TierStanding) =>
    state === 'current'
      ? t('yourCurrentPlan')
      : state === 'upgrade'
        ? t('upgradeBadge')
        : state === 'included'
          ? t('includedInYours')
          : state === 'tba'
            ? t('priceTBA')
            : null;

  /** «٢٬٤١٧ د.ع / شهر» for a tier with several durations, the price otherwise. */
  const headline = (tier: PaidTier) => {
    const { priced, longest, cheapestMonthly } = priceFacts(plans, tier);
    if (priced.length === 0) return { main: t('priceTBA'), per: null as string | null, from: false, sub: null as React.ReactNode };
    if (priced.length === 1) {
      const p = priced[0];
      return {
        main: money(p.price_iqd as number),
        per: null,
        from: false,
        sub: (
          <>
            {durationLabel(p.duration_months, lang)}
            {p.duration_months > 1 && p.per_month_iqd !== null && (
              <>
                {durationSep(lang)}
                <bdi dir={dir}>{money(p.per_month_iqd)}</bdi> {t('perMonth')}
              </>
            )}
          </>
        ),
      };
    }
    return {
      main: money(cheapestMonthly?.per_month_iqd ?? (longest?.price_iqd as number)),
      per: lang === 'en' ? t('month').toLowerCase() : t('month'),
      from: true,
      sub: longest ? (
        <>
          <bdi dir={dir}>{money(longest.price_iqd as number)}</bdi>
          {durationSep(lang)}
          {durationLabel(longest.duration_months, lang)}
        </>
      ) : null,
    };
  };

  const meta = TIER_META[selected];
  const head = headline(selected);
  const badge = badgeFor(standing[selected]);

  return (
    <div className="space-y-5 md:space-y-7">
      {/* ------------------------------------------------ the switch */}
      <div
        role="radiogroup"
        aria-labelledby="choose-card-title"
        onKeyDown={onKeyDown}
        className="relative grid w-full max-w-md rounded-full border border-border-subtle bg-surface p-1"
        style={{ gridTemplateColumns: `repeat(${tiers.length}, minmax(0, 1fr))` }}
      >
        {tiers.map((tier) => {
          const tm = TIER_META[tier];
          const on = tier === selected;
          return (
            <button
              key={tier}
              ref={(el) => {
                refs.current[tier] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-tier-tab={tier}
              onClick={() => onSelect(tier)}
              className="relative z-0 flex min-h-11 items-center justify-center gap-1.5 rounded-full px-2 text-[13px] font-extrabold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {on && (
                <motion.span
                  // One pill, shared by every name: a change of mind moves it.
                  layoutId="tier-card-ring"
                  data-tier-ring
                  aria-hidden
                  className="absolute inset-0 -z-10 rounded-full border bg-surface-raised"
                  style={{ borderColor: `${tm.hex}80` }}
                  transition={m.reduced ? { duration: 0 } : m.spring('quick')}
                />
              )}
              <tm.Icon className={`h-3.5 w-3.5 shrink-0 ${on ? tm.text : 'text-text-muted'}`} aria-hidden />
              <span dir="ltr" className={on ? 'text-text-primary' : 'text-text-secondary'}>
                {tm.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* ------------------------------------------------- the cards */}
      <div
        ref={railRef}
        onScroll={onRailScroll}
        data-card-rail
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-[9%] pb-3 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:-mx-6 md:mx-0 md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:px-0 md:pb-0"
      >
        {tiers.map((tier, i) => {
          const tm = TIER_META[tier];
          const on = tier === selected;
          const h = headline(tier);
          const state = standing[tier];
          return (
            <motion.div
              key={tier}
              ref={(el) => {
                cardRefs.current[tier] = el;
              }}
              data-tier-card={tier}
              aria-hidden
              onClick={() => onSelect(tier)}
              initial={m.reduced ? false : { opacity: 0, y: 18 }}
              animate={{
                opacity: on ? 1 : 0.62,
                y: on ? m.travel(-6) : 0,
                scale: on || m.reduced ? 1 : 0.965,
              }}
              transition={m.reduced ? { duration: 0.15 } : entered ? m.spring('ui') : { ...m.spring('ui'), delay: i * 0.06 }}
              className="relative w-[82%] max-w-[22rem] shrink-0 cursor-pointer snap-center md:w-auto md:max-w-none"
            >
              {/* A card is an object, not a paragraph: its face is laid out the
                  same way in every language, like the plastic in a wallet. */}
              <div
                dir="ltr"
                className="relative flex aspect-[1.586/1] flex-col justify-between overflow-hidden rounded-[22px] border p-4 sm:p-5 text-white"
                style={cardMaterial(tier)}
              >
                <div className="flex items-start justify-between gap-3">
                  <span dir="ltr" className="text-[11px] font-bold tracking-[0.22em] text-white/70">
                    LEVONIS
                  </span>
                  <tm.Icon className="h-5 w-5 shrink-0" style={{ color: tm.hex }} aria-hidden />
                </div>

                <div className="min-w-0">
                  <p className="text-[1.9rem] sm:text-[2.1rem] font-black leading-none tracking-[-0.02em] text-white [text-shadow:0_1px_0_rgb(0_0_0/0.5)]">
                    {tm.label}
                  </p>
                  <div className="mt-2.5 flex items-end justify-between gap-2">
                    {state === 'current' && (
                      <span dir={dir} className="shrink-0 inline-flex items-center gap-1 rounded-full bg-white/12 px-2 py-0.5 text-[11px] font-bold text-white">
                        <Check className="h-3 w-3" strokeWidth={3} aria-hidden /> {t('yourCurrentPlan')}
                      </span>
                    )}
                    <p dir={dir} className="ms-auto min-w-0 text-[13px] font-semibold leading-tight text-white/85 tabular-nums">
                      {h.from && <span className="text-white/60">{loc('من ', 'from ', 'لە ')}</span>}
                      <span className="whitespace-nowrap">{h.main}</span>
                      {h.per && <span className="text-white/60"> / {h.per}</span>}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* -------------------------------------- the chosen card, read */}
      <div aria-live="polite" className="relative md:max-w-2xl">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={selected}
            data-tier-detail={selected}
            initial={{ opacity: 0, y: m.travel(8) }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: m.travel(-6) }}
            transition={m.spring('quick')}
          >
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[13px] font-extrabold">
                  <meta.Icon className={`h-4 w-4 ${meta.text}`} aria-hidden />
                  <span dir="ltr" className={meta.text}>
                    {meta.label}
                  </span>
                </p>
                <p data-tier-price className="mt-1 text-[1.9rem] sm:text-[2.25rem] font-extrabold leading-[1.1] tracking-[-0.01em] text-text-primary tabular-nums">
                  {head.from && <span className="text-[14px] font-semibold text-text-secondary">{loc('من ', 'from ', 'لە ')}</span>}
                  <span className="whitespace-nowrap">{head.main}</span>
                  {head.per && <span className="text-[14px] font-semibold text-text-secondary"> / {head.per}</span>}
                </p>
                {head.sub && <p className="mt-0.5 text-[12.5px] text-text-muted tabular-nums">{head.sub}</p>}
              </div>
              {badge && (
                <span
                  data-tier-standing={standing[selected]}
                  className={`inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-[12px] font-semibold ${
                    standing[selected] === 'current' ? 'text-success' : 'text-text-secondary'
                  }`}
                >
                  {standing[selected] === 'current' && <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />}
                  {badge}
                </span>
              )}
            </div>

            {highlights[selected].length > 0 && (
              <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 sm:gap-x-6">
                {highlights[selected].map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-[13.5px] leading-relaxed text-text-secondary">
                    <span
                      aria-hidden
                      className="mt-[3px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
                      style={{ backgroundColor: `${meta.hex}24`, color: meta.hex }}
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        </AnimatePresence>

        <button
          type="button"
          onClick={onCompare}
          className="mt-3 -ms-3 inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-[13px] font-semibold text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t('compareLink')} <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export default TierCards;
