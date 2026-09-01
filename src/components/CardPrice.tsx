import React from 'react';
import { Star } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { formatIqd, type ApiProduct } from '../lib/api';

/**
 * The ONE price block every product card renders (home rails, /products grid,
 * bundles). Entirely server-driven: `display_price_iqd` is the CHEAPEST
 * tier-resolved price across the base row and every active option/colour,
 * already resolved at the VIEWER'S server-side tier — the client never does
 * tier math, so a spoofed local state can't change a shown price.
 *
 * The owner's display rules:
 *  - non-member (or PLUS, which has no price tier): bold regular price, and
 *    under it — faint — the PRIME and PRO prices when they exist;
 *  - PRIME member: bold PRIME price (strikethrough regular beside it), faint
 *    PRO price under it;
 *  - PRO member: the PRO price alone.
 * Which branch applies is read from display_applied_tier — the server's
 * verdict, not a client guess. `display_from` marks genuinely differing
 * variant prices, so «يبدأ من» is honest, never decorative.
 */
export default function CardPrice({ p, compact = false }: { p: ApiProduct; compact?: boolean }) {
  const { loc } = useLanguage();

  const main = p.display_price_iqd ?? p.price_iqd;
  const regular = p.display_regular_iqd ?? p.price_iqd;
  const appliedTier = p.display_applied_tier ?? 'regular';
  const struck = main < regular ? regular : null;
  const from = !!p.display_from;

  const teasers: Array<{ label: string; price: number }> = [];
  if (appliedTier === 'regular') {
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

  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
        {from && (
          <span className="text-zinc-500 text-[10px] shrink-0">{loc('يبدأ من', 'from', 'لە')}</span>
        )}
        <span
          className={`font-bold ${compact ? 'text-[13px]' : 'text-[15px]'} ${
            memberPrice ? 'text-gold font-extrabold inline-flex items-center gap-1' : 'text-white'
          }`}
        >
          {memberPrice && <Star aria-hidden className="w-3 h-3 fill-gold" />}
          {formatIqd(main)}
        </span>
        {struck !== null && (
          <span className="text-zinc-500 text-[11px] line-through truncate">{formatIqd(struck)}</span>
        )}
      </div>
      {teasers.map((t) => (
        <div key={t.label} className="flex items-center gap-1 mt-0.5 min-w-0">
          <Star aria-hidden className="w-2.5 h-2.5 text-gold/70 shrink-0" />
          <span className="text-zinc-500 font-medium text-[10px] truncate">
            {t.label} {formatIqd(t.price)} ({loc('للمشتركين', 'members', 'بۆ ئەندامان')})
          </span>
        </div>
      ))}
    </div>
  );
}
