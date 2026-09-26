import React from 'react';
import { Sparkles, Star } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { type ApiProduct } from '../lib/api';
import { useMoney } from '../CurrencyContext';
import { memberLine, splitMoney } from '../lib/productCard';

/**
 * The ONE price block every product card renders (home rails, /products grid,
 * bundles). Entirely server-driven: `display_price_iqd` is the CHEAPEST
 * tier-resolved price across the base row and every active option/colour,
 * already resolved at the VIEWER'S server-side tier — the client never does
 * tier math, so a spoofed local state can't change a shown price.
 *
 * The owner's display rules:
 *  - non-member: bold regular price, and under it — faint — the PRIME and PRO
 *    prices when they exist;
 *  - PLUS member on a BUNDLE or MYSTERY offer: bold PLUS price. That rung is
 *    offer-scoped (docs/BUNDLES_MYSTERY.md §4.4) and no ordinary product emits
 *    it — but without this branch a PLUS member is shown the regular price on
 *    the grid, the home shelf and search, and is then charged the PLUS price in
 *    the cart and at the door;
 *  - PRIME member: bold PRIME price (strikethrough regular beside it), faint
 *    PRO price under it;
 *  - PRO member: the PRO price, in PRO's red with its mark, and the regular
 *    price small and struck beside it — the saving read at a glance.
 * Which branch applies is read from display_applied_tier — the server's
 * verdict, not a client guess. `display_from` marks genuinely differing
 * variant prices, so «يبدأ من» is honest, never decorative.
 */
export default function CardPrice({
  p,
  compact = false,
  density = 'regular',
}: {
  p: ApiProduct;
  /** Smaller type for list rows (search suggestions, bundle tiles). */
  compact?: boolean;
  /** 'compact' is the compact product card's price block (see CompactPrice). */
  density?: 'regular' | 'compact';
}) {
  if (density === 'compact') return <CompactPrice p={p} />;
  return <RegularPrice p={p} compact={compact} />;
}

function RegularPrice({ p, compact }: { p: ApiProduct; compact: boolean }) {
  const { money } = useMoney();
  const { loc } = useLanguage();

  const main = p.display_price_iqd ?? p.price_iqd;
  const regular = p.display_regular_iqd ?? p.price_iqd;
  const appliedTier = p.display_applied_tier ?? 'regular';
  const struck = main < regular ? regular : null;
  const from = !!p.display_from;

  const teasers: Array<{ label: string; price: number }> = [];
  // A PLUS viewer is already on the offer-scoped PLUS rung, so PRIME and PRO
  // are teased only when they are genuinely cheaper than what they are paying
  // — the same rule the regular branch follows, not a second one.
  if (appliedTier === 'regular' || appliedTier === 'plus') {
    if (typeof p.display_prime_iqd === 'number' && p.display_prime_iqd < main)
      teasers.push({ label: 'PRIME', price: p.display_prime_iqd });
    if (typeof p.display_pro_iqd === 'number' && p.display_pro_iqd < main)
      teasers.push({ label: 'PRO', price: p.display_pro_iqd });
  } else if (appliedTier === 'prime') {
    if (typeof p.display_pro_iqd === 'number' && p.display_pro_iqd < main)
      teasers.push({ label: 'PRO', price: p.display_pro_iqd });
  }
  // A PRO member sees the PRO price alone — nothing to tease.

  const memberPrice = appliedTier !== 'regular';
  /** PRO is drawn in PRO's own red (tierMeta), every other member rung in gold. */
  const pro = appliedTier === 'pro';

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
        {from && (
          <span className="text-zinc-500 text-[10px] shrink-0">{loc('يبدأ من', 'from', 'لە')}</span>
        )}
        <span
          className={`font-bold ${compact ? 'text-[13px]' : 'text-[15px]'} ${
            pro
              ? 'text-coral font-extrabold inline-flex items-center gap-1'
              : memberPrice
                ? 'text-gold font-extrabold inline-flex items-center gap-1'
                : 'text-white'
          }`}
          data-pro-price={pro || undefined}
        >
          {pro ? (
            <Sparkles aria-hidden className="w-3 h-3" />
          ) : (
            memberPrice && <Star aria-hidden className="w-3 h-3 fill-gold" />
          )}
          {money(main)}
        </span>
        {struck !== null && (
          <span className="text-zinc-500/80 text-[10.5px] line-through truncate">{money(struck)}</span>
        )}
      </div>
      {teasers.map((t) => (
        <div key={t.label} className="flex items-center gap-1 mt-0.5 min-w-0">
          <Star aria-hidden className="w-2.5 h-2.5 text-gold/70 shrink-0" />
          <span className="text-zinc-500 font-medium text-[10px] truncate">
            {t.label} {money(t.price)} ({loc('للمشتركين', 'members', 'بۆ ئەندامان')})
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * THE COMPACT CARD'S PRICE (docs/ux/CATALOG_DISCOVERY.md §4.1) — two fixed
 * rows, so a grid of cards keeps one height whatever the viewer's tier:
 *
 *   row 1   «يبدأ من» 10 muted · the amount 15/20 800 tabular · «د.ع» 10.5
 *   row 2   ONE member line — the cheapest rung below what this viewer pays
 *           (src/lib/productCard.ts `memberLine`): ✧ 674,100 لأعضاء PRO.
 *           When there is no cheaper rung but the viewer's own price is below
 *           the regular one (a member, or a live offer), the struck regular
 *           price takes the row instead. Otherwise the row stays empty.
 *
 * The main amount keeps CardPrice's colour rule: PRO's red for a PRO viewer,
 * gold for PRIME and PLUS, the foreground for everyone else. Same fields,
 * same server verdict — nothing here computes a price.
 */
function CompactPrice({ p }: { p: ApiProduct }) {
  const { money } = useMoney();
  const { loc } = useLanguage();

  const main = p.display_price_iqd ?? p.price_iqd;
  const regular = p.display_regular_iqd ?? p.price_iqd;
  const applied = p.display_applied_tier ?? 'regular';
  const [amount, unit] = splitMoney(money(main));
  const line = memberLine(p);
  const struck = !line && main < regular ? regular : null;
  const amountTone =
    applied === 'pro' ? 'text-coral' : applied === 'regular' ? 'text-text-primary' : 'text-gold';

  return (
    <div data-card-price="compact" className="min-w-0">
      <div className="flex h-5 min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap">
        {p.display_from ? (
          <span className="shrink-0 text-[10px] font-semibold text-text-muted">{loc('يبدأ من', 'from', 'لە')}</span>
        ) : null}
        <bdi
          dir="ltr"
          data-pro-price={applied === 'pro' || undefined}
          className={`text-[15px] font-extrabold leading-5 tracking-[-0.01em] tabular-nums ${amountTone}`}
        >
          {amount}
        </bdi>
        {unit ? <span className="shrink-0 text-[10.5px] font-bold text-text-secondary">{unit}</span> : null}
      </div>
      <div className="mt-px flex h-[15px] min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[10.5px] leading-[15px] text-text-secondary">
        {line ? (
          <>
            {line.tier === 'PRO' ? (
              <Sparkles aria-hidden className="size-2.5 shrink-0 text-coral" />
            ) : (
              <Star aria-hidden className="size-2.5 shrink-0 fill-current text-gold" />
            )}
            <bdi dir="ltr" className="font-semibold tabular-nums">{splitMoney(money(line.price))[0]}</bdi>
            {/* OWNER: Sorani to be written by hand («لأعضاء» before a tier name). */}
            <span className="truncate">{loc('لأعضاء', 'for')}</span>
            <b className={`font-extrabold tracking-[0.02em] ${line.tier === 'PRO' ? 'text-coral' : 'text-gold'}`}>{line.tier}</b>
          </>
        ) : struck !== null ? (
          <>
            {/* OWNER: Sorani to be written by hand («بدل» — instead of). */}
            <span className="sr-only">{loc('بدل', 'instead of')} </span>
            <bdi dir="ltr" className="text-text-muted line-through tabular-nums">{splitMoney(money(struck))[0]}</bdi>
          </>
        ) : null}
      </div>
    </div>
  );
}
