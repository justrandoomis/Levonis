import React from 'react';
import { Link } from 'react-router-dom';
import { type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import OfferBadge from '../ui/OfferBadge';
import Countdown from '../ui/Countdown';

/**
 * The home product card — presentation only; every price shown here is the
 * server's own resolution (CardPrice renders the display_* fields, which are
 * the minimum tier-resolved price across base/options/colours — the owner's
 * «السعر الأساسي للمنتج» rule).
 *
 * §3/§12: the product name is English in every language and is never
 * translated. §4: compare-at is gone — a strikethrough appears ONLY when the
 * viewer's own membership actually lowers the price, or when the server's
 * display price is genuinely below the regular one. The name box is
 * two-lines tall whether the name needs them or not, so cards in a rail all
 * keep one height and the price row sits on one line across the shelf.
 */
export default function ProductCard({ p, widthClass = 'w-[160px]' }: { p: ApiProduct; widthClass?: string }) {
  const images = Array.isArray(p.images) ? p.images : [];
  const firstImage = images[0] || '';
  const name = p.name;

  const displayPrice = p.display_price_iqd ?? p.price_iqd;
  const regularPrice = p.display_regular_iqd ?? p.price_iqd;
  const hasSale = displayPrice < regularPrice;

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
          <OfferBadge className="absolute top-2 end-2">SALE</OfferBadge>
        )}
        {/* A SCHEDULED SPECIAL OFFER, on an ORDINARY card (§12, §13.2). The
            countdown is DECORATION — the API still refuses an expired offer —
            and the price beside it is already the server's offer price, so
            nothing here computes a discount. One shared 1 Hz ticker drives
            every card on the page. */}
        {p.offer && (p.offer.schedule_state === 'upcoming' || p.offer.ends_at) && (
          <span className="absolute bottom-2 start-2 rounded-md bg-black/70 px-1.5 py-0.5 backdrop-blur-sm">
            <Countdown
              target={p.offer.schedule_state === 'upcoming' ? p.offer.starts_at : p.offer.ends_at}
              kind={p.offer.schedule_state === 'upcoming' ? 'opens' : 'ends'}
              className="text-[10px] text-zinc-200"
            />
          </span>
        )}
      </div>
      <div className="p-3 flex flex-col flex-1 min-w-0">
        <h3 dir="ltr" className="text-white font-medium text-[13px] leading-snug line-clamp-2 min-h-[2.2rem] text-start">
          {name}
        </h3>
        <div className="mt-auto pt-2">
          <CardPrice p={p} />
        </div>
      </div>
    </Link>
  );
}
