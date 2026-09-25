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
 * DARK TILES ON AN IVORY GROUND, deliberately. The shop's product photographs
 * are studio shots on near-black with a warm key light; placed on a light
 * card they read as dark stickers. On a charcoal tile the photograph's own
 * background becomes the tile's, and a soft mask at the photograph's edge
 * dissolves the seam.
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
    <Link to={tile.to} data-bento-tile={tile.id} data-theme="dark" className={`${TILE} h-full`}>
      <PromoPhoto
        src={tile.image}
        crop={isProductPhoto(tile)}
        width={480}
        height={480}
        className="lv-fade-top inset-x-0 bottom-0 top-[26%] lg:top-[18%]"
      />
      <div className="relative flex h-full flex-col justify-between p-3.5 lg:p-6">
        <h3 className="max-w-[12ch] text-[16px] font-bold leading-[1.35] text-ivory lg:max-w-none lg:text-[26px] lg:leading-tight">
          {copy.title}
        </h3>
        <span className="inline-flex h-8 w-fit items-center gap-1.5 whitespace-nowrap rounded-full bg-gold-muted px-3 text-[12px] font-bold text-gold-ink lg:h-10 lg:px-4 lg:text-[14px]">
          {/* OWNER: Sorani to be written by hand. */}
          {loc('تسوق الطابعات', 'Shop printers')}
          <ArrowGlyph className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
        </span>
      </div>
    </Link>
  );
}

function WideTile({ tile, copy }: { tile: BentoTile; copy: Copy }) {
  return (
    <Link to={tile.to} data-bento-tile={tile.id} data-theme="dark" className={`${TILE} h-full`}>
      <PromoPhoto
        src={tile.image}
        crop={isProductPhoto(tile)}
        width={240}
        height={240}
        className="lv-fade-start inset-y-0 end-0 w-[58%] lg:w-[55%]"
      />
      <div className="relative flex h-full max-w-[58%] flex-col justify-start p-2.5 lg:p-5">
        <h3 className="text-[13px] font-bold leading-5 text-ivory lg:text-[19px] lg:leading-7">{copy.title}</h3>
        {copy.caption ? (
          <p className="text-[11px] leading-4 text-text-secondary lg:mt-0.5 lg:text-[13px] lg:leading-5">{copy.caption}</p>
        ) : null}
      </div>
    </Link>
  );
}

function CompactTile({ tile, copy }: { tile: BentoTile; copy: Copy }) {
  return (
    <Link to={tile.to} data-bento-tile={tile.id} data-theme="dark" className={`${TILE} h-full`}>
      <PromoPhoto
        src={tile.image}
        crop={isProductPhoto(tile)}
        width={160}
        height={160}
        className="lv-fade-top inset-x-0 bottom-0 top-[30%] lg:top-[24%]"
      />
      <h3 className="relative p-2 text-[11px] font-bold leading-[1.35] text-ivory lg:p-4 lg:text-[15px] lg:leading-6">
        {copy.title}
      </h3>
    </Link>
  );
}

const TOP: BentoTileId[] = ['filament', 'resin'];
const BOTTOM: BentoTileId[] = ['parts', 'accessories', 'used'];
const COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' };

export default function CategoryBento({ tiles }: { tiles: BentoTile[] }) {
  const { loc } = useLanguage();
  const copy = useTileCopy();
  const large = tiles.find((t) => t.id === 'printers');
  const top = tiles.filter((t) => TOP.includes(t.id));
  const bottom = tiles.filter((t) => BOTTOM.includes(t.id));
  if (tiles.length === 0) return null;

  const side = top.length + bottom.length > 0 ? (
    <div className={`grid min-w-0 gap-2 lg:gap-3 ${top.length && bottom.length ? 'grid-rows-[1fr_1.08fr]' : 'grid-rows-1'}`}>
      {top.length > 0 && (
        <div className={`grid gap-2 lg:gap-3 ${COLS[top.length]}`}>
          {top.map((t) => (
            <WideTile key={t.id} tile={t} copy={copy[t.id]} />
          ))}
        </div>
      )}
      {bottom.length > 0 && (
        <div className={`grid gap-2 lg:gap-3 ${COLS[bottom.length]}`}>
          {bottom.map((t) => (
            <CompactTile key={t.id} tile={t} copy={copy[t.id]} />
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
        className={`grid gap-2 lg:gap-3 ${
          large && side ? 'grid-cols-[44fr_56fr] lg:grid-cols-[5fr_7fr]' : 'grid-cols-1'
        } h-[188px] sm:h-[240px] lg:h-[380px]`}
      >
        {large ? <LargeTile tile={large} copy={copy.printers} /> : null}
        {side}
      </div>
    </section>
  );
}
