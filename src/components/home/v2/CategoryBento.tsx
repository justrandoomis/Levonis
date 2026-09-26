import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';
import { pickText, type BentoPosition } from '../../../lib/api';
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
 * THE PHOTOGRAPH FILLS THE TILE (owner, 2026-09-26: «اجعل الصورة تملأ
 * البطاقة وليس أن تكون الاسم للفئة فوق أو على الجانب»). Every tile is one
 * picture, edge to edge, with its name ON it over a dark scrim from the
 * bottom corner on the reading side (`.lv-bleed-scrim`, src/index.css). The
 * words and the scrim are the same in both themes — light on dark — because
 * they sit on a photograph, not on the page; the tile under a missing picture
 * is a dark plate for the same reason. The picture is the admin's light/dark
 * pair when there is one (src/lib/homeLayout.ts `ownerPhoto`), else the
 * section's cover, else a real product photograph cropped to its middle band.
 * The earlier label zone above or beside a framed photo window is gone.
 *
 * ONE LAYOUT AT EVERY WIDTH (owner, 2026-09-26, with the reference shot:
 * «الطابعات ثلاثية الأبعاد على اليسار بشكل مربع ويكون على اليمين اثنين
 * مستطيل فوق وثلاثة مربعات في الأسفل»). The phone keeps the same bento as the
 * desktop, only shorter: printers the near-square tile on the LEFT (the end
 * side in Arabic, so it follows the side column in the DOM), the wide
 * material tiles above and the compact ones below on the reading side. The
 * earlier two-column phone flow is gone.
 *
 * THE OWNER PICKS WHAT GOES WHERE (owner, 2026-09-26: «يقرر ماذا يضع على
 * اليسار في المربع الكبير وماذا يضع في المربعات الخمسة على اليمين»). Each tile
 * carries its SQUARE (`position`); the admin's «تسوق حسب الفئة» assignment
 * decides which section fills it and may name it, and an unassigned square
 * keeps the built-in section (src/lib/homeLayout.ts `resolveBento`).
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
  'group relative isolate block h-full overflow-hidden rounded-[14px] lv-bleed-ground ring-1 ring-inset ring-white/[0.06] transition-transform duration-150 active:scale-[0.985] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:rounded-[18px]';

/**
 * The photograph over the whole tile and the scrim over it. `size` is only the
 * intrinsic size hint for the browser; the crop is CSS (PromoPhoto).
 */
function TilePhoto({ tile, size }: { tile: BentoTile; size: number }) {
  if (!tile.image) return null;
  return (
    <>
      <PromoPhoto
        src={tile.image}
        lightSrc={tile.lightImage}
        crop={isProductPhoto(tile)}
        bleed
        width={size}
        height={size}
        className="inset-0"
      />
      <div aria-hidden="true" className="lv-bleed-scrim pointer-events-none absolute inset-0" />
    </>
  );
}

/** Printers — the near-square tile: the name and the pill in the bottom corner. */
function LargeTile({ tile, copy }: { tile: BentoTile; copy: Copy }) {
  const { loc } = useLanguage();
  return (
    <Link to={tile.to} data-bento-tile={tile.id ?? tile.category?.id ?? tile.position} data-bento-position={tile.position} data-feature="" className={TILE}>
      <TilePhoto tile={tile} size={560} />
      <div className="relative flex h-full flex-col items-start justify-end gap-2 p-3 lg:gap-3 lg:p-6">
        <h3 className="max-w-[12ch] text-[15px] font-bold leading-[1.4] text-snow [text-shadow:0_1px_8px_rgb(0_0_0/0.35)] sm:text-[17px] lg:max-w-none lg:text-[28px] lg:leading-[1.3]">
          {copy.title}
        </h3>
        <span className="inline-flex h-8 w-fit items-center gap-1.5 whitespace-nowrap rounded-full bg-snow px-3 text-[12px] font-bold text-onyx shadow-1 lg:h-10 lg:px-4 lg:text-[14px]">
          {/* OWNER: Sorani to be written by hand. */}
          {tile.id === 'printers' ? loc('تسوق الطابعات', 'Shop printers') : loc('تسوق الآن', 'Shop now')}
          <ArrowGlyph className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
        </span>
      </div>
    </Link>
  );
}

/** The two material tiles: the name and its caption in the bottom corner. */
function WideTile({ tile, copy }: { tile: BentoTile; copy: Copy }) {
  return (
    <Link to={tile.to} data-bento-tile={tile.id ?? tile.category?.id ?? tile.position} data-bento-position={tile.position} data-feature="" className={TILE}>
      <TilePhoto tile={tile} size={400} />
      <div className="relative flex h-full flex-col justify-end p-2 sm:p-2.5 lg:p-5">
        <h3 className="text-[12px] font-bold leading-[1.4] text-snow [text-shadow:0_1px_6px_rgb(0_0_0/0.35)] sm:text-[13px] lg:text-[20px] lg:leading-[1.35]">
          {copy.title}
        </h3>
        {copy.caption ? (
          <p className="text-[10px] leading-[1.45] text-snow/80 sm:text-[11px] lg:mt-0.5 lg:text-[13px]">{copy.caption}</p>
        ) : null}
      </div>
    </Link>
  );
}

function CompactTile({ tile, copy }: { tile: BentoTile; copy: Copy }) {
  return (
    <Link to={tile.to} data-bento-tile={tile.id ?? tile.category?.id ?? tile.position} data-bento-position={tile.position} data-feature="" className={TILE}>
      <TilePhoto tile={tile} size={240} />
      <div className="relative flex h-full flex-col justify-end p-2 lg:p-4">
        <h3 className="text-[10.5px] font-bold leading-[1.4] text-snow [text-shadow:0_1px_6px_rgb(0_0_0/0.35)] sm:text-[11px] lg:text-[15px] lg:leading-[1.45]">
          {copy.title}
        </h3>
      </div>
    </Link>
  );
}

const TOP: BentoPosition[] = ['top-1', 'top-2'];
const BOTTOM: BentoPosition[] = ['bottom-1', 'bottom-2', 'bottom-3'];
const COLS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' };

export default function CategoryBento({ tiles }: { tiles: BentoTile[] }) {
  const { loc, lang } = useLanguage();
  const presets = useTileCopy();
  /** The owner's title, else the built-in copy, else the section's own name. */
  const copyOf = (t: BentoTile): Copy => {
    const own = t.title ? pickText(t.title, lang) : '';
    const preset = t.id ? presets[t.id] : null;
    if (own) return { title: own, caption: undefined };
    if (preset) return preset;
    const c = t.category;
    return { title: c ? (lang === 'en' ? c.name_en : lang === 'ckb' ? c.name_ckb : c.name_ar) || c.name_ar || c.name_en : '' };
  };
  const large = tiles.find((t) => t.position === 'large');
  const top = tiles.filter((t) => TOP.includes(t.position));
  const bottom = tiles.filter((t) => BOTTOM.includes(t.position));
  if (tiles.length === 0) return null;

  const side = top.length + bottom.length > 0 ? (
    <div className={`grid min-w-0 gap-2 lg:gap-3 ${top.length && bottom.length ? 'grid-rows-[1fr_1.08fr]' : 'grid-rows-1'}`}>
      {top.length > 0 && (
        <div className={`grid min-h-0 gap-2 lg:gap-3 ${COLS[top.length]}`}>
          {top.map((t) => (
            <WideTile key={t.position} tile={t} copy={copyOf(t)} />
          ))}
        </div>
      )}
      {bottom.length > 0 && (
        <div className={`grid min-h-0 gap-2 lg:gap-3 ${COLS[bottom.length]}`}>
          {bottom.map((t) => (
            <CompactTile key={t.position} tile={t} copy={copyOf(t)} />
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
        to="/categories"
        linkLabel={loc('عرض جميع الفئات', 'All categories')}
      />
      <div
        className={`grid gap-2 lg:gap-3 ${
          large && side ? 'grid-cols-[58fr_42fr] sm:grid-cols-[56fr_44fr] lg:grid-cols-[7fr_5fr]' : 'grid-cols-1'
        } h-[200px] min-[400px]:h-[216px] sm:h-[240px] lg:h-[380px] xl:h-[420px] 2xl:h-[480px]`}
      >
        {/* The side column first: in Arabic the grid starts on the right, so
            the printers tile lands on the LEFT, as in the owner's reference. */}
        {side}
        {large ? <LargeTile tile={large} copy={copyOf(large)} /> : null}
      </div>
    </section>
  );
}
