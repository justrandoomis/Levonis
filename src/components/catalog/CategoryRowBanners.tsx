import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import { useTheme } from '../../lib/theme';
import CropPhoto from './CropPhoto';
import { ArrowGlyph } from '../home/v2/SectionHead';
import { prefetchProps } from '../../lib/catalog/prefetch';
import { nodeDescription, nodeName } from '../../lib/catalog/categoryPageModel';
import { availableLabel, countNoun, nounKindFor } from '../../lib/catalog/copy';
import { bannerCta, type BannerPhoto, type BannerRow } from '../../lib/catalog/explorerModel';

/**
 * SECTIONS AS HERO BANNERS, ONE PER ROW (owner, 2026-09-26: «يظهر فئات الفرعية
 * بشكل هيرو بانر بسطر واحد مستطيل», like the home page's «اطبع بأكثر من لون» /
 * «من أول طبعة إلى مشروع كامل» banners — src/components/home/v2/EditorialBanners).
 *
 * Drawn on «كل الفئات» (a row per root), on a category page (a row per child,
 * under the hero) and on a sub-section that has sections of its own (above
 * its list). Every row is the full content width: the photograph holds the
 * far side and fades toward the reading side, where the name, one line of
 * counts and a «تسوق الآن ←» / «استكشف ←» pill sit.
 *
 * PROPORTION, NOT A FIXED HEIGHT: a 8:3 strip on a phone (112–150 px), 4:1
 * from 640 px, 5:1 from 1024 px, capped at 200 px — so a wide screen gets a
 * banner, never a wall.
 *
 * ONE LINK. The name, the line and the pill are all the same target — the
 * pill is the link's label, not a second control inside it.
 *
 * IT FOLLOWS THE THEME (`data-feature`, src/index.css FEATURE SURFACES):
 * charcoal on the dark theme; a cream card with ink type on the light one,
 * where a dark catalogue photograph with no light-theme twin (migration 0138)
 * is framed as a window on the far side instead of faded into the cream. A
 * picture the owner uploaded fills the banner under a scrim from the reading
 * side.
 */
export function CategoryRowBanner({
  to,
  title,
  line,
  detail,
  cta,
  photo,
  eager = false,
  rowKey,
}: {
  to: string;
  title: string;
  /** «10 طابعات · 4 متوفرة الآن» */
  line: string;
  /** The admin's description — its first line, from 1024 px only. */
  detail?: string;
  cta: string;
  photo: BannerPhoto | null;
  eager?: boolean;
  rowKey: string;
}) {
  const { theme } = useTheme();
  const framed = !!photo?.productPhoto && theme === 'light' && !photo.lightSrc;
  const cover = !!photo && !photo.productPhoto;
  return (
    <Link
      to={to}
      data-feature=""
      data-category-row={rowKey}
      {...prefetchProps(to)}
      className="group relative isolate flex aspect-[8/3] max-h-[150px] min-h-[112px] w-full overflow-hidden rounded-2xl bg-charcoal ring-1 ring-inset ring-white/[0.06] transition-transform duration-150 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted sm:aspect-[4/1] sm:max-h-[170px] lg:aspect-[5/1] lg:max-h-[200px] lg:rounded-[20px]"
    >
      {photo ? (
        <CropPhoto
          src={photo.src}
          lightSrc={photo.lightSrc}
          crop={photo.productPhoto}
          size={cover ? 720 : 420}
          eager={eager}
          className={
            cover
              ? 'inset-0'
              : framed
                ? 'inset-y-0 end-0 w-[42%] sm:w-[34%] lg:w-[30%]'
                : 'lv-fade-start inset-y-0 end-0 w-[56%] lg:w-[42%]'
          }
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 end-0 w-[56%] bg-[radial-gradient(120%_90%_at_100%_100%,rgb(188_163_107/0.16),transparent_60%)] rtl:bg-[radial-gradient(120%_90%_at_0%_100%,rgb(188_163_107/0.16),transparent_60%)]"
        />
      )}
      {cover ? (
        // An uploaded picture fills the banner; a scrim from the reading side
        // keeps the words legible over whatever the owner chose.
        <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-l from-transparent via-charcoal/50 to-charcoal/90 rtl:bg-gradient-to-r" />
      ) : null}
      <div className="relative flex min-w-0 max-w-[58%] flex-col items-start p-3.5 sm:max-w-[56%] sm:p-5 lg:max-w-[50%] lg:px-8 lg:py-6">
        <h3 className="line-clamp-2 text-[17px] font-bold leading-6 text-ivory lg:text-[24px] lg:leading-8">{title}</h3>
        {detail ? (
          <p className="mt-1 hidden text-[14px] leading-6 text-ivory/[0.74] lg:line-clamp-1">{detail}</p>
        ) : null}
        <p className="mt-0.5 line-clamp-1 text-[12px] font-semibold leading-[18px] tabular-nums text-ivory/[0.68] lg:mt-1 lg:text-[14px] lg:leading-6">
          {line}
        </p>
        <span className="mt-auto inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border border-white/20 bg-charcoal px-3 text-[12px] font-bold text-ivory transition-colors group-hover:border-white/45 sm:h-9 sm:px-3.5 sm:text-[13px] lg:h-10 lg:px-4 lg:text-[14px]">
          {cta}
          <ArrowGlyph className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 motion-reduce:transition-none" />
        </span>
      </div>
    </Link>
  );
}

/** A section of the catalogue as one row: its name, counts and the door that fits it. */
export function CategoryNodeBanner({ row, eager = false }: { row: BannerRow; eager?: boolean }) {
  const { lang, loc } = useLanguage();
  const { node } = row;
  const kind = nounKindFor(node.product_type, node.is_printer_catalog);
  const avail = availableLabel(node.available_count, node.product_count, lang);
  const line = [countNoun(node.product_count, kind, lang), avail].filter(Boolean).join(' · ');
  // OWNER: Sorani to be written by hand (both calls to action).
  const cta = bannerCta(node) === 'explore' ? loc('استكشف', 'Explore') : loc('تسوق الآن', 'Shop now');
  const description = nodeDescription(node, lang).split('\n')[0];
  return (
    <CategoryRowBanner
      to={node.path}
      title={nodeName(node, lang)}
      line={line}
      detail={description}
      cta={cta}
      photo={row.photo}
      eager={eager}
      rowKey={node.slug}
    />
  );
}

/**
 * The stack: a list of rows, one per line, with an optional heading
 * («أقسام الطابعات»). Draws nothing when there is no row.
 */
export default function CategoryRowBanners({
  rows,
  label,
  heading,
  eagerFirst = false,
  className = '',
}: {
  rows: readonly BannerRow[];
  label: string;
  /** A visible h2 over the stack; without one the list is labelled by `label`. */
  heading?: string;
  eagerFirst?: boolean;
  className?: string;
}) {
  const id = React.useId();
  if (rows.length === 0) return null;
  return (
    <section data-category-rows="" aria-label={heading ? undefined : label} aria-labelledby={heading ? id : undefined} className={className}>
      {heading ? (
        <h2 id={id} className="mb-2.5 text-[17px] font-bold leading-7 text-text-primary lg:mb-4 lg:text-[22px] lg:leading-8">
          {heading}
        </h2>
      ) : null}
      <ul className="flex flex-col gap-2.5 lg:gap-4">
        {rows.map((r, i) => (
          <li key={r.node.id}>
            <CategoryNodeBanner row={r} eager={eagerFirst && i === 0} />
          </li>
        ))}
      </ul>
    </section>
  );
}
