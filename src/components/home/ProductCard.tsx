import React from 'react';
import { Link } from 'react-router-dom';
import { type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import OfferBadge from '../ui/OfferBadge';
import Countdown from '../ui/Countdown';
import { productMainImage, productPrimaryImage } from '../../lib/productImage';
import { useTheme } from '../../lib/theme';
import DirectStockEdge from '../DirectStockEdge';
import AvailabilityLine from '../product/AvailabilityLine';
import CompareToggle from '../compare/CompareToggle';
import { useLanguage } from '../../LanguageContext';
import { conditionKindLabel } from '../../lib/condition';
import { cardHref, cardName, compareTypeOf, type CardProduct } from '../../lib/productCard';

/**
 * THE SHOP'S PRODUCT CARD — one card for the home rails, the listings and
 * search (docs/ux/CATALOG_DISCOVERY.md §4). Presentation only: every price is
 * the server's own resolution (CardPrice renders the display_* fields), and
 * every word about the product comes from src/lib/productCard.ts.
 *
 * §3/§12: the product name is English in every language and is never
 * translated. §4: a strikethrough appears ONLY when the viewer's own
 * membership or a live offer actually lowers the price.
 *
 * TWO DENSITIES.
 *
 *  compact — the owner's brief: «بطاقتان في الصف في الجوال، تقليل الحجم العام
 *    قليلًا، تقليل المسافات الداخلية بشكل مدروس، الحفاظ على صورة المنتج واضحة،
 *    السعر بارزًا، حالة التوفر واضحة، اسم المنتج line-clamp ومنسقًا بشكل أنيق».
 *    262 px tall at 174 px wide (it was 274–298), and that height is FIXED:
 *      photo    6:5, top-anchored (the studio photographs letter the model
 *               name in the top fifth and the shop's address in the bottom
 *               sixth, so a top-anchored 6:5 keeps the machine and its name
 *               whole and drops only the address);
 *      body     9 / 10 / 10 padding;
 *      name     12.5/17 semibold, two lines reserved (the part before the
 *               first « / », the full name in `title`);
 *      price    one row, 15 px 800 tabular — the strongest thing on the card;
 *      member   one row, reserved even when empty;
 *      stock    one row pinned to the bottom, a dot AND a word.
 *    The whole card is one link, but the link is a SIBLING of the compare
 *    toggle, never its parent: the card is a `div`, the link covers it with
 *    a stretched `::after`, and the toggle sits above that.
 *
 *  regular — the previous card, kept for any caller not yet moved.
 */
export default function ProductCard({
  p,
  widthClass,
  density = 'regular',
  width = 'fill',
  compareToggle = false,
  eager = false,
}: {
  p: ApiProduct;
  /** An explicit width utility; overrides `width`. */
  widthClass?: string;
  density?: 'regular' | 'compact';
  /** `rail`: the 148 px card of a horizontal shelf; `fill`: its grid cell. */
  width?: 'rail' | 'fill';
  /** Offer the compare toggle (listings, shelves, home «أحدث المنتجات»). */
  compareToggle?: boolean;
  /** Above-the-fold: load the photograph eagerly. */
  eager?: boolean;
}) {
  if (density === 'compact') {
    return (
      <CompactCard
        p={p as CardProduct}
        widthClass={widthClass ?? (width === 'rail' ? 'w-[148px] shrink-0' : 'w-full')}
        compareToggle={compareToggle}
        eager={eager}
      />
    );
  }
  return <RegularCard p={p} widthClass={widthClass ?? 'w-[160px]'} />;
}

function CompactCard({
  p,
  widthClass,
  compareToggle,
  eager,
}: {
  p: CardProduct;
  widthClass: string;
  compareToggle: boolean;
  eager: boolean;
}) {
  const { lang } = useLanguage();
  const { theme } = useTheme();
  // The main image for the theme on screen (0138); the compare tray keeps the
  // primary, which is the product's identity rather than a theme's picture.
  const image = productMainImage(p, theme);
  const lightShown = image !== '' && image === p.light_image;
  const name = cardName(p);
  const shortened = name !== (p.name ?? '').trim();
  const displayPrice = p.display_price_iqd ?? p.price_iqd;
  const regularPrice = p.display_regular_iqd ?? p.price_iqd;
  const hasSale = displayPrice < regularPrice;
  const type = compareToggle ? compareTypeOf(p) : null;
  const condition = p.condition?.kind ? conditionKindLabel(p.condition.kind, lang) : '';

  return (
    <div
      data-product-card="compact"
      className={`${widthClass} group relative flex min-w-0 flex-col overflow-hidden rounded-[14px] border border-border-subtle bg-surface transition-colors hover:bg-surface-raised has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus`}
    >
      <div className={`relative aspect-[6/5] overflow-hidden ${lightShown ? 'bg-surface-selected' : 'bg-charcoal'}`}>
        <SafeImage
          src={image}
          alt=""
          aspect="auto"
          eager={eager}
          className="h-full w-full"
          bgClassName={lightShown ? 'bg-surface-selected' : 'bg-charcoal'}
          fallbackClassName="text-snow/35"
          imgClassName="object-[50%_4%] transition-transform duration-500 group-hover:scale-[1.03] motion-reduce:transition-none"
        />
        {hasSale && <OfferBadge className="absolute top-2 end-2">SALE</OfferBadge>}
        {/* A scheduled special offer (§12, §13.2): decoration only — the API
            refuses an expired offer, and the price is already the offer's. */}
        {p.offer && (p.offer.schedule_state === 'upcoming' || p.offer.ends_at) && (
          <span className="absolute bottom-1.5 start-1.5 rounded-md bg-onyx/70 px-1.5 py-0.5 backdrop-blur-sm">
            <Countdown
              target={p.offer.schedule_state === 'upcoming' ? p.offer.starts_at : p.offer.ends_at}
              kind={p.offer.schedule_state === 'upcoming' ? 'opens' : 'ends'}
              className="text-[10px] text-snow"
            />
          </span>
        )}
        {/* Graded stock says so on the card, on the photograph so the
            card's height does not change. */}
        {condition && (
          <span className="absolute bottom-1.5 end-1.5 rounded-md bg-onyx/70 px-1.5 py-0.5 text-[10px] font-bold leading-4 text-snow backdrop-blur-sm">
            {condition}
          </span>
        )}
      </div>

      <Link
        to={cardHref(p)}
        className="flex min-w-0 flex-1 flex-col px-2.5 pb-2.5 pt-[9px] focus-visible:outline-none after:absolute after:inset-0 after:z-[1] after:content-['']"
      >
        <h3
          dir="ltr"
          title={shortened ? p.name : undefined}
          className="line-clamp-2 min-h-[34px] text-[12.5px] font-semibold leading-[17px] text-text-primary [overflow-wrap:anywhere] text-start rtl:text-right"
        >
          {name}
        </h3>
        <div className="mt-1.5">
          <CardPrice p={p} density="compact" />
        </div>
        <AvailabilityLine product={p} className="mt-auto pt-[7px]" />
      </Link>

      {type && (
        <CompareToggle
          item={{ id: p.id, slug: p.slug || p.id, name, image: productPrimaryImage(p) || '' }}
          type={type}
          className="absolute top-1.5 start-1.5 z-[2]"
        />
      )}
    </div>
  );
}

function RegularCard({ p, widthClass }: { p: ApiProduct; widthClass: string }) {
  const { theme } = useTheme();
  const firstImage = productMainImage(p, theme);
  const lightShown = firstImage !== '' && firstImage === p.light_image;
  const name = p.name;

  const displayPrice = p.display_price_iqd ?? p.price_iqd;
  const regularPrice = p.display_regular_iqd ?? p.price_iqd;
  const hasSale = displayPrice < regularPrice;

  return (
    <Link
      to={cardHref(p)}
      className={`${widthClass} relative shrink-0 overflow-hidden flex flex-col group bg-surface rounded-xl border border-border-subtle hover:bg-surface-raised transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
    >
      <div className={`relative aspect-square overflow-hidden ${lightShown ? 'bg-surface-selected' : 'bg-charcoal'}`}>
        <SafeImage
          src={firstImage}
          alt={name}
          aspect="auto"
          className="w-full h-full group-hover:scale-[1.04] transition-transform duration-500 motion-reduce:transition-none"
        />
        {hasSale && (
          <OfferBadge className="absolute top-2 end-2">SALE</OfferBadge>
        )}
        {p.offer && (p.offer.schedule_state === 'upcoming' || p.offer.ends_at) && (
          <span className="absolute bottom-2 start-2 rounded-md bg-onyx/70 px-1.5 py-0.5 backdrop-blur-sm">
            <Countdown
              target={p.offer.schedule_state === 'upcoming' ? p.offer.starts_at : p.offer.ends_at}
              kind={p.offer.schedule_state === 'upcoming' ? 'opens' : 'ends'}
              className="text-[10px] text-snow"
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
      <DirectStockEdge product={p} />
    </Link>
  );
}
