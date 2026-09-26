import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';
import { isProductPhoto, type BentoTile, type BentoTileId } from '../../../lib/homeLayout';
import PromoPhoto from './PromoPhoto';
import SectionHead, { ArrowGlyph } from './SectionHead';

/**
 * «تسوق حسب الفئة» — THE BENTO.
 *
 * Not six equal cards. One large near-square tile for printers — the thing
 * this shop is — and beside it two rows: the two wide material tiles above,
 * three compact ones below. It is the one visual moment of the light half of
 * the page, so every other section around it stays quiet.
 *
 * THE TILES FOLLOW THE THEME (`data-feature`, src/index.css FEATURE SURFACES).
 * Dark: charcoal tiles, where the studio photograph's own near-black becomes
 * the tile's and a soft mask dissolves the seam. Light: cream tiles with ink
 * type and a charcoal pill; a product's light-theme image (migration 0138)
 * fades in the same way, and a dark photograph with no light twin is framed
 * as an inset window rather than smudged into the cream.
 *
 * THE PHONE LAYOUT IS ITS OWN (owner, 2026-09-26: «بطاقة فئة الطابعات …
 * بشكل طولي ومستطيل … يجب أن تكون مربعة والأيقونة الثانية … شبه مربعة»).
 * Under 640 px the tiles flow into two columns: printers SQUARE, the next
 * tile beside it square too, and the rest in 5:4 pairs (an odd one out spans
 * the row). From 640 px it is the side-by-side bento.
 *
 * THE LAYOUT FOLLOWS THE DATA. A tile is drawn only for a section the shop
 * stocks (src/lib/homeLayout.ts `resolveBento`), so the rows take whatever
 * tiles exist: two top tiles share the row, one takes it whole; the bottom
 * row divides by one, two or three. Nothing is drawn over an empty listing.
 *
 * Every tile is ONE link — the label and the «تسوق الطابعات» pill are the
 * same target, never a button nested in an anchor.
 */

type Copy = { title: string; caption?: string };

function useTileCopy(): Record<BentoTileId, Copy> {
  const { loc, t } = useLanguage();
  return {
    // OWNER: Sorani to be written by hand (every loc() below without a third argument).
    printers: { title: loc('الطابعات ثلاثية الأبعاد', '3D printers', t('printers')) },
    filament: { title: 'Filament', caption: loc('خامات الطباعة', 'Printing filament') },
    resin: { title: 'Resin', caption: loc('راتنج الطباعة', 'Printing resin') },
    parts: { title: loc('قطع الغيار والمستلزمات', 'Spare parts & supplies') },
    accessories: { title: loc('الإكسسوارات والأدوات', 'Accessories & tools') },
    used: { title: loc('المنتجات المستعملة', 'Pre-owned') },
  };
}

const TILE =
  'group relative isolate block overflow-hidden rounded-[14px] bg-charcoal ring-1 ring-inset ring-white/[0.06] transition-transform duration-150 active:scale-[0.985] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted lg:rounded-[18px]';

/**
 * Where the photograph sits in each tile. The label always has a zone of its
 * own — the photograph never runs under the words — and the photograph's
 * edge facing the label dissolves into the tile (`lv-fade-*`).
 */
function LargeTile({ tile, copy }: { tile: BentoTile; copy: Copy }) {
  const { loc } = useLanguage();
  return (
    <Link to={tile.to} data-bento-tile={tile.id} data-feature="" className={`${TILE} aspect-square sm:aspect-auto sm:h-full`}>
      <PromoPhoto
        src={tile.image}
        lightSrc={tile.lightImage}
        crop={isProductPhoto(tile)}
        width={480}
        height={480}
        className="lv-fade-top inset-x-0 bottom-0 top-[30%] lg:top-[18%]"
      />
      <div className="relative flex h-full flex-col justify-between p-3 lg:p-6">
        <h3 className="max-w-[12ch] text-[15px] font-bold leading-[1.35] text-ivory sm:text-[16px] lg:max-w-none lg:text-[26px] lg:leading-tight">
          {copy.title}
        </h3>
        <span className="inline-flex h-8 w-fit items-center gap-1.5 whitespace-nowrap rounded-full bg-gold-muted px-3 text-[12px] font-bold text-gold-ink shadow-1 lg:h-10 lg:px-4 lg:text-[14px]">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('تسوق الطابعات', 'Shop printers')}
          <ArrowGlyph className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
        </span>
      </div>
    </Link>
  );
}

/**
 * The material tiles. On a phone the first of them sits beside the printers
 * as a square, so its photograph takes the lower part like a compact tile's;
 * from 640 px it is the wide tile with the photograph on the far side.
 */
function WideTile({ tile, copy, square }: { tile: BentoTile; copy: Copy; square: boolean }) {
  return (
    <Link
      to={tile.to}
      data-bento-tile={tile.id}
      data-feature=""
      className={`${TILE} ${square ? 'aspect-square' : 'aspect-[5/4]'} sm:aspect-auto sm:h-full`}
    >
      <PromoPhoto
        src={tile.image}
        lightSrc={tile.lightImage}
        crop={isProductPhoto(tile)}
        width={240}
        height={240}
        className="lv-bento-wide-photo"
      />
      <div className="relative flex h-full flex-col justify-start p-2.5 sm:max-w-[58%] lg:p-5">
        <h3 className="text-[13px] font-bold leading-5 text-ivory lg:text-[19px] lg:leading-7">{copy.title}</h3>
        {copy.caption ? (
          <p className="text-[11px] leading-4 text-text-secondary lg:mt-0.5 lg:text-[13px] lg:leading-5">{copy.caption}</p>
        ) : null}
      </div>
    </Link>
  );
}

function CompactTile({ tile, copy, span }: { tile: BentoTile; copy: Copy; span: boolean }) {
  return (
    <Link
      to={tile.to}
      data-bento-tile={tile.id}
      data-feature=""
      className={`${TILE} ${span ? 'col-span-2 aspect-[5/2]' : 'aspect-[5/4]'} sm:col-span-1 sm:aspect-auto sm:h-full`}
    >
      <PromoPhoto
        src={tile.image}
        lightSrc={tile.lightImage}
        crop={isProductPhoto(tile)}
        width={160}
        height={160}
        className="lv-fade-top inset-x-0 bottom-0 top-[32%] lg:top-[24%]"
      />
      <h3 className="relative p-2 text-[11.5px] font-bold leading-[1.35] text-ivory sm:text-[11px] lg:p-4 lg:text-[15px] lg:leading-6">
        {copy.title}
      </h3>
    </Link>
  );
}

const TOP: BentoTileId[] = ['filament', 'resin'];
const BOTTOM: BentoTileId[] = ['parts', 'accessories', 'used'];
const COLS: Record<number, string> = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' };

export default function CategoryBento({ tiles }: { tiles: BentoTile[] }) {
  const { loc } = useLanguage();
  const copy = useTileCopy();
  const large = tiles.find((t) => t.id === 'printers');
  const top = tiles.filter((t) => TOP.includes(t.id));
  const bottom = tiles.filter((t) => BOTTOM.includes(t.id));
  if (tiles.length === 0) return null;

  // On a phone every tile is an item of ONE two-column grid (the row wrappers
  // below are `display: contents` there). The first tile after the printers
  // is square beside them; the rest pair up, and an odd last one spans.
  const flow = [...(large ? [large] : []), ...top, ...bottom];
  const squareId = flow[1]?.id ?? null;
  const rest = flow.slice(large ? 2 : 0);
  const spanId = rest.length % 2 === 1 ? rest[rest.length - 1].id : null;

  const side = top.length + bottom.length > 0 ? (
    <div className={`contents min-w-0 gap-2 sm:grid lg:gap-3 ${top.length && bottom.length ? 'sm:grid-rows-[1fr_1.08fr]' : 'sm:grid-rows-1'}`}>
      {top.length > 0 && (
        <div className={`contents gap-2 sm:grid lg:gap-3 ${COLS[top.length]}`}>
          {top.map((t) => (
            <WideTile key={t.id} tile={t} copy={copy[t.id]} square={t.id === squareId} />
          ))}
        </div>
      )}
      {bottom.length > 0 && (
        <div className={`contents gap-2 sm:grid lg:gap-3 ${COLS[bottom.length]}`}>
          {bottom.map((t) => (
            <CompactTile key={t.id} tile={t} copy={copy[t.id]} span={t.id === spanId} />
          ))}
        </div>
      )}
    </div>
  ) : null;

  return (
    <section data-home-section="categories_bento" aria-labelledby="home-bento-title">
      {/* OWNER: Sorani to be written by hand. */}
      <SectionHead
        id="home-bento-title"
        title={loc('تسوق حسب الفئة', 'Shop by category')}
        to="/products"
        linkLabel={loc('عرض جميع الفئات', 'All categories')}
      />
      <div
        className={`grid grid-cols-2 gap-2 lg:gap-3 ${
          large && side ? 'sm:grid-cols-[44fr_56fr] lg:grid-cols-[5fr_7fr]' : 'sm:grid-cols-1'
        } sm:h-[240px] lg:h-[380px] xl:h-[420px] 2xl:h-[480px]`}
      >
        {large ? <LargeTile tile={large} copy={copy.printers} /> : null}
        {side}
      </div>
    </section>
  );
}
