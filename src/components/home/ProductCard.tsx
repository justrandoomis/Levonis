import React from 'react';
import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { formatIqd, type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';

/**
 * The home product card — presentation only; every price shown here is the
 * server's own resolution.
 *
 * §3/§12: the product name is English in every language and is never
 * translated. §4: compare-at is gone — a strikethrough appears ONLY when the
 * viewer's own membership actually lowers the price, or when the server's
 * display price is genuinely below the regular one. The name box is
 * two-lines tall whether the name needs them or not, so cards in a rail all
 * keep one height and the price row sits on one line across the shelf.
 */
export default function ProductCard({ p, widthClass = 'w-[160px]' }: { p: ApiProduct; widthClass?: string }) {
  const { user } = useAuth();
  const { loc } = useLanguage();

  const plan = user?.membership_tier ?? 'free';
  const planActive =
    !!user && plan !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > Date.now());

  const images = Array.isArray(p.images) ? p.images : [];
  const firstImage = images[0] || '';
  const name = p.name;

  const proPrice = p.membership_prices?.pro ?? null;
  const planPrice = planActive && (plan === 'plus' || plan === 'pro') ? p.membership_prices?.[plan] ?? null : null;
  const displayPrice = p.display_price_iqd ?? p.price_iqd;
  const regularPrice = p.display_regular_iqd ?? p.price_iqd;
  const hasSale = displayPrice < regularPrice;
  const showPlanPrice = !!planPrice && planPrice > 0 && planPrice < p.price_iqd;

  return (
    <Link
      to={`/product/${p.slug || p.id}`}
      className={`${widthClass} shrink-0 rounded-xl overflow-hidden flex flex-col group bg-zinc-900/50 border border-zinc-800/80 hover:border-zinc-600 transition-colors min-w-0`}
    >
      <div className="relative aspect-square overflow-hidden bg-zinc-950">
        <SafeImage
          src={firstImage}
          alt={name}
          aspect="auto"
          className="w-full h-full group-hover:scale-[1.04] transition-transform duration-500 motion-reduce:transition-none"
        />
        {hasSale && (
          <span className="absolute top-2 end-2 bg-rose-600/95 text-white text-[10px] font-bold tracking-wide px-2 py-0.5 rounded-md">
            SALE
          </span>
        )}
      </div>
      <div className="p-3 flex flex-col flex-1 min-w-0">
        <h3 dir="ltr" className="text-white font-medium text-[13px] leading-snug line-clamp-2 min-h-[2.2rem] text-start">
          {name}
        </h3>
        <div className="mt-auto pt-2">
          {showPlanPrice ? (
            <div className="flex flex-col">
              <span className="text-zinc-500 text-[11px] line-through">{formatIqd(p.price_iqd)}</span>
              <span className="text-gold font-extrabold text-[15px] flex items-center gap-1">
                <Star aria-hidden className="w-3.5 h-3.5 fill-gold" />
                {formatIqd(planPrice!)}
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-white font-bold text-[15px]">{formatIqd(p.price_iqd)}</span>
                {hasSale && (
                  <span className="text-zinc-500 text-[11px] line-through truncate">{formatIqd(regularPrice)}</span>
                )}
              </div>
              {proPrice ? (
                <div className="flex items-center gap-1 mt-0.5 min-w-0">
                  <Star aria-hidden className="w-2.5 h-2.5 text-gold/70 shrink-0" />
                  <span className="text-zinc-500 font-medium text-[10px] truncate">
                    {formatIqd(proPrice)} ({loc('للمشتركين', 'members', 'بۆ ئەندامان')})
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
