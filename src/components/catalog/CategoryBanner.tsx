import React from 'react';
import { Link } from 'react-router-dom';
import CropPhoto from './CropPhoto';
import { ArrowGlyph } from '../home/v2/SectionHead';
import { prefetchProps } from '../../lib/catalog/prefetch';
import type { BannerPhoto } from '../../lib/catalog/explorerModel';

/**
 * ONE DEPARTMENT OF THE SHOP (docs/ux/CATALOG_DISCOVERY.md §5 item 3).
 *
 * A dark banner (the bento's `CropPhoto` twin of `PromoPhoto`) — the product photographs are studio shots on near-black, so
 * on a charcoal ground the picture's own background becomes the banner's and
 * a soft mask dissolves the seam (the bento's rule). The words hold the
 * reading side (60%), the photograph the far side (54%, overlapping under the
 * fade), and a gold arrow sits in the far corner.
 *
 * ONE LINK. The name, the description, the pills and the arrow are all the
 * same target — the arrow is drawn, not a second control. The link's name is
 * the section's name plus its counts, in reading order.
 *
 * `data-theme="dark"` keeps the island dark in the light theme, so the tokens
 * inside (the availability dot, the focus ring) read on charcoal.
 */
export default function CategoryBanner({
  to,
  title,
  description,
  count,
  available,
  photo,
  variant = 'regular',
  eager = false,
}: {
  to: string;
  title: string;
  description?: string;
  /** «10 طابعات» */
  count: string;
  /** «4 متوفرة الآن», or null to omit the pill. */
  available: string | null;
  photo: BannerPhoto | null;
  variant?: 'lead' | 'regular';
  eager?: boolean;
}) {
  const lead = variant === 'lead';
  return (
    <Link
      to={to}
      data-theme="dark"
      data-category-banner={lead ? 'lead' : 'regular'}
      {...prefetchProps(to)}
      className={`group relative isolate block overflow-hidden rounded-[20px] bg-charcoal ring-1 ring-inset ring-white/[0.06] transition-transform duration-150 active:scale-[0.99] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted ${
        lead ? 'h-[208px] sm:h-[240px] lg:h-[280px]' : 'h-[150px] sm:h-[170px] lg:h-[200px]'
      }`}
    >
      {photo ? (
        <CropPhoto
          src={photo.src}
          crop={photo.productPhoto}
          size={lead ? 560 : 360}
          eager={eager}
          className={`lv-fade-start inset-y-0 end-0 ${lead ? 'w-[56%] lg:w-[58%]' : 'w-[54%]'}`}
        />
      ) : (
        <span aria-hidden="true" className="absolute inset-y-0 end-0 w-[54%] bg-[radial-gradient(120%_90%_at_100%_100%,rgb(188_163_107/0.16),transparent_60%)] rtl:bg-[radial-gradient(120%_90%_at_0%_100%,rgb(188_163_107/0.16),transparent_60%)]" />
      )}
      <div className={`relative flex h-full flex-col p-4 lg:p-6 ${lead ? 'w-[64%] lg:w-[48%]' : 'w-[64%] lg:w-[56%]'}`}>
        <h2
          className={`font-extrabold text-ivory ${
            lead ? 'text-[23px] leading-8 lg:text-[32px] lg:leading-[42px]' : 'text-[19px] leading-[27px] lg:text-[22px] lg:leading-8'
          } line-clamp-2`}
        >
          {title}
        </h2>
        {description ? (
          <p className={`mt-1 text-[12px] leading-[18px] text-ivory/[0.72] lg:text-[13.5px] lg:leading-5 ${lead ? 'line-clamp-2 lg:line-clamp-3' : 'line-clamp-2'}`}>
            {description}
          </p>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <Pill>{count}</Pill>
          {available ? (
            <Pill>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              {available}
            </Pill>
          ) : null}
        </div>
      </div>
      <span
        aria-hidden="true"
        className="absolute bottom-3.5 end-3.5 grid size-10 place-items-center rounded-full bg-gold-muted text-gold-ink transition-transform duration-200 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 motion-reduce:transition-none lg:bottom-5 lg:end-5 lg:size-11"
      >
        <ArrowGlyph className="size-4" />
      </span>
    </Link>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-ivory/10 px-2.5 text-[11.5px] font-bold tabular-nums text-ivory/[0.82] lg:h-7 lg:px-3 lg:text-[12.5px]">
      {children}
    </span>
  );
}
