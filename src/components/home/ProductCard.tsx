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
import { cardHref, cardKnowledgeLine, cardName, compareTypeOf, type CardProduct } from '../../lib/productCard';
import { isUnpriced } from '../../lib/priceStatus';

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
 *    280 px tall at 174 px wide (it was 274–298; 262 before the knowledge
 *    line), and that height is FIXED:
 *      photo    6:5, top-anchored (the studio photographs letter the model
 *               name in the top fifth and the shop's address in the bottom
 *               sixth, so a top-anchored 6:5 keeps the machine and its name
 *               whole and drops only the address);
 *      body     9 / 10 / 10 padding;
 *      name     12.5/17 semibold, two lines reserved (the part before the
 *               first « / », the full name in `title`);
 *      line     11/16 muted, one row RESERVED even when empty: the section
 *               and the key values (the Bambu import spec §G.5) — a card the
 *               server sent no line for is the same height as one it did, so
 *               a rail never stairsteps and the skeleton never shifts;
 *      price    one row, 15 px 800 tabular — the strongest thing on the card;
 *      member   one row, reserved even when empty;
 *      stock    one row pinned to the bottom, a dot AND a word.
 *    The whole card is one link, but the link is a SIBLING of the compare
 *    toggle, never its parent: the card is a `div`, the link covers it with
 *    a stretched `::after`, and the toggle sits above that.
 *
 *  regular — the previous card, kept for any caller not yet moved.
 *
 * CLAY (docs/DECISIONS.md row 209). A product card is resting clay (level 1:
 * the lit rim, the shaded base and ONE soft cast — the one blurred layer a
 * scrolling list of forty cards repaints) that dents while it is pressed.
 * The photograph sits in a tray 4 px inside the card (22 − 4 = 18 px
 * corners). Only the card's own link dents it — pressing the compare toggle
 * on its photograph does not. Hover changes the fill only — no lift and no image zoom on a
 * repeated item — and nothing on the card blurs what is behind it. A long
 * grid hands `lv-cv` to the card itself (`className`), never to a wrapper:
 * paint containment clips a descendant's shadow at the wrapper's edge.
 */
export default function ProductCard({
  p,
  widthClass,
  density = 'regular',
  width = 'fill',
  compareToggle = false,
  eager = false,
  fetchPriority,
  deferImage = false,
  imageSizes,
  className,
}: {
  p: ApiProduct;
  /** An explicit width utility; overrides `width`. */
  widthClass?: string;
  density?: 'regular' | 'compact';
  /** `rail`: the 148 px card of a horizontal shelf; `fill`: its grid cell. */
  width?: 'rail' | 'fill';
  /** Offer the compare toggle (listings, shelves, home «أحدث المنتجات»). */
  compareToggle?: boolean;
  /** Above-the-fold: load the photograph eagerly (no fade). */
  eager?: boolean;
  /** The photograph's request priority (SafeImage `fetchPriority`): `high` only for the largest paint. */
  fetchPriority?: 'high' | 'auto';
  /** Below a grid's first screen: hold the photograph until it nears the screen (SafeImage `defer`). */
  deferImage?: boolean;
  /** Override for a shelf that changes from a fixed-width rail to a grid. */
  imageSizes?: string;
  /** Extra classes on the compact card's root (a long grid's `lv-cv`). */
  className?: string;
}) {
  if (density === 'compact') {
    return (
      <CompactCard
        p={p as CardProduct}
        widthClass={`${widthClass ?? (width === 'rail' ? 'w-[148px] shrink-0' : 'w-full')}${className ? ` ${className}` : ''}`}
        compareToggle={compareToggle}
        eager={eager}
        fetchPriority={fetchPriority}
        deferImage={deferImage}
        imageSizes={imageSizes ?? (width === 'rail' ? '148px' : GRID_CARD_SIZES)}
      />
    );
  }
  return <RegularCard p={p} widthClass={widthClass ?? 'w-[160px]'} />;
}

/**
 * A GRID CARD'S PHOTOGRAPH: 5 / 4 / 3 across, two across a phone. On a phone
 * of DPR 2.5 or more the slot is declared at 1 / 2.2 instead of 1 / 2 of the
 * row, so the 174 px card of a 390 px DPR-3 phone takes the 480 copy (0.92
 * image pixels per screen pixel at 460 ppi, which no eye resolves) instead of
 * the 640 one — about a third of the grid's bytes (verification of DECISIONS
 * row 226: the grid's bytes had not moved). A 2.625 phone gets the same copy
 * at 0.99.
 */
const GRID_CARD_SIZES =
  '(min-width: 1280px) calc((100vw - 72px) / 5), (min-width: 1024px) calc((100vw - 68px) / 4), (min-width: 640px) calc((100vw - 56px) / 3), (min-resolution: 2.5dppx) calc((100vw - 42px) / 2.2), calc((100vw - 42px) / 2)';

function CompactCard({
  p,
  widthClass,
  compareToggle,
  eager,
  fetchPriority,
  deferImage,
  imageSizes,
}: {
  p: CardProduct;
  widthClass: string;
  compareToggle: boolean;
  eager: boolean;
  fetchPriority?: 'high' | 'auto';
  deferImage: boolean;
  imageSizes: string;
}) {
  const { lang } = useLanguage();
  const { theme } = useTheme();
  // The main image for the theme on screen (0138); the compare tray keeps the
  // primary, which is the product's identity rather than a theme's picture.
  const image = productMainImage(p, theme);
  const lightShown = image !== '' && image === p.light_image;
  const name = cardName(p);
  const shortened = name !== (p.name ?? '').trim();
  // CATALOG-ONLY (rows 239-240): no number, so no SALE badge and no offer
  // countdown — the compare toggle stays (compare is a catalogue read).
  const priced = !isUnpriced(p);
  const displayPrice = p.display_price_iqd ?? p.price_iqd;
  const regularPrice = p.display_regular_iqd ?? p.price_iqd;
  const hasSale = priced && displayPrice != null && regularPrice != null && displayPrice < regularPrice;
  const type = compareToggle ? compareTypeOf(p) : null;
  const condition = p.condition?.kind ? conditionKindLabel(p.condition.kind, lang) : '';
  const line = cardKnowledgeLine(p, lang === 'en' || lang === 'ckb' ? lang : 'ar');

  return (
    <div
      data-product-card="compact"
      className={`${widthClass} group relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm transition-colors hover:bg-surface-raised has-[a:active]:shadow-press has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus`}
    >
      <div className={`relative mx-1 mt-1 aspect-[6/5] overflow-hidden rounded-lg ${lightShown ? 'bg-surface-selected' : 'bg-charcoal'}`}>
        <SafeImage
          src={image}
          alt=""
          aspect="auto"
          eager={eager}
          fetchPriority={fetchPriority}
          defer={deferImage}
          sizes={imageSizes}
          className="h-full w-full"
          bgClassName={lightShown ? 'bg-surface-selected' : 'bg-charcoal'}
          fallbackClassName="text-snow/35"
          imgClassName="object-[50%_4%]"
        />
        {hasSale && <OfferBadge className="absolute top-2 end-2">SALE</OfferBadge>}
        {/* A scheduled special offer (§12, §13.2): decoration only — the API
            refuses an expired offer, and the price is already the offer's. */}
        {priced && p.offer && (p.offer.schedule_state === 'upcoming' || p.offer.ends_at) && (
          <span className="absolute bottom-1.5 start-1.5 rounded-sm bg-onyx/80 px-1.5 py-0.5">
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
          <span className="absolute bottom-1.5 end-1.5 rounded-sm bg-onyx/80 px-1.5 py-0.5 text-[10px] font-bold leading-4 text-snow">
            {condition}
          </span>
        )}
      </div>

      <Link
        to={cardHref(p)}
        className="no-press flex min-w-0 flex-1 flex-col px-2.5 pb-2.5 pt-[9px] focus-visible:outline-none after:absolute after:inset-0 after:z-[1] after:content-['']"
      >
        <h3
          dir="ltr"
          title={shortened ? p.name : undefined}
          className="line-clamp-2 min-h-[34px] text-[12.5px] font-semibold leading-[17px] text-text-primary [overflow-wrap:anywhere] text-start rtl:text-right"
        >
          {name}
        </h3>
        {/* The section and the key values (spec §G.5): one muted line, the values as LTR islands —
            its row kept even when empty, so every compact card is one height. */}
        <p
          className="mt-0.5 h-4 truncate text-[11px] leading-4 text-text-muted"
          data-card-line
          data-card-knowledge={line ? '' : undefined}
          aria-hidden={line ? undefined : true}
        >
          {line ? (
            <>
              {line.section}
              {line.specs.map((v, i) => (
                <React.Fragment key={i}>
                  {line.section || i > 0 ? ' · ' : ''}
                  <bdi>{v}</bdi>
                </React.Fragment>
              ))}
            </>
          ) : null}
        </p>
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

  const priced = !isUnpriced(p);
  const displayPrice = p.display_price_iqd ?? p.price_iqd;
  const regularPrice = p.display_regular_iqd ?? p.price_iqd;
  const hasSale = priced && displayPrice != null && regularPrice != null && displayPrice < regularPrice;

  return (
    <Link
      to={cardHref(p)}
      className={`${widthClass} relative shrink-0 overflow-hidden flex flex-col group bg-surface rounded-xl border border-border-subtle shadow-sm no-press hover:bg-surface-raised active:shadow-press transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
    >
      <div className={`relative aspect-square overflow-hidden ${lightShown ? 'bg-surface-selected' : 'bg-charcoal'}`}>
        <SafeImage
          src={firstImage}
          alt={name}
          aspect="auto"
          sizes="160px"
          className="w-full h-full"
        />
        {hasSale && (
          <OfferBadge className="absolute top-2 end-2">SALE</OfferBadge>
        )}
        {priced && p.offer && (p.offer.schedule_state === 'upcoming' || p.offer.ends_at) && (
          <span className="absolute bottom-2 start-2 rounded-sm bg-onyx/80 px-1.5 py-0.5">
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
