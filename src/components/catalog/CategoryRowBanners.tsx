import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
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
 * its list). Every row is the full content width.
 *
 * THE PICTURE IS THE BANNER (owner, same day: «اجعل الصورة تملأ البطاقة وليس
 * أن تكون الاسم للفئة فوق أو على الجانب»). The admin's banner for the theme on
 * screen (src/lib/catalog/explorerModel.ts `authoredSrc`) fills the whole row;
 * the name, one line of counts and the «تسوق الآن ←» / «استكشف ←» pill sit ON
 * it, over a scrim from the reading side. The scrim is dark in BOTH themes,
 * so the words are light and legible on any photograph. A borrowed catalogue
 * photograph (a square studio shot on near-black) cannot fill a strip without
 * becoming a meaningless slice, so it holds the far side and dissolves into a
 * ground of its own near-black — one continuous dark picture, never a framed
 * window on a cream card.
 *
 * THIN, BY PROPORTION (owner: «اجعل الشريط المستطيلي انحف»): 15:4 on a phone
 * (88–96 px), 7:1 from 640 px (104–140 px), 8:1 from 1024 px (120–144 px) —
 * a strip at every width from 320 to 1920, never a wall (`ROW_BANNER_SIZE`,
 * shared with the explorer's skeleton).
 *
 * ONE LINK. The name, the line and the pill are all the same target — the
 * pill is the link's label, not a second control inside it — and the target is
 * the whole row, at least 88 px tall.
 *
 * `data-feature` (src/index.css FEATURE SURFACES) still marks it as a feature
 * surface, but the words re-point `ivory`/`white` back to light ink locally:
 * they stand on the dark scrim, not on the page. A per-component override, so
 * the global light-theme rules stay untouched.
 */
export const ROW_BANNER_SIZE =
  'aspect-[15/4] min-h-[88px] max-h-[96px] rounded-2xl sm:aspect-[7/1] sm:min-h-[104px] sm:max-h-[140px] lg:aspect-[8/1] lg:min-h-[120px] lg:max-h-[144px] lg:rounded-[20px]';

/** The words on the photograph: light ink in both themes (see above). */
const ON_PHOTO_INK = '[--color-ivory:#f3efe6] [--color-white:#f3efe6]';

export function CategoryRowBanner({
  to,
  title,
  line,
  cta,
  photo,
  eager = false,
  rowKey,
}: {
  to: string;
  title: string;
  /** «10 طابعات · 4 متوفرة الآن» */
  line: string;
  /** The admin's description. Not drawn: a thin strip carries the name, the counts and the pill only. */
  detail?: string;
  cta: string;
  photo: BannerPhoto | null;
  eager?: boolean;
  rowKey: string;
}) {
  const cover = !!photo && !photo.productPhoto;
  return (
    <Link
      to={to}
      data-feature=""
      data-category-row={rowKey}
      data-row-photo={photo ? (cover ? 'cover' : 'product') : 'none'}
      {...prefetchProps(to)}
      className={`group relative isolate flex w-full overflow-hidden lv-row-banner-ground ring-1 ring-inset ring-white/[0.06] transition-transform duration-150 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted ${ROW_BANNER_SIZE}`}
    >
      {photo ? (
        <CropPhoto
          src={photo.src}
          // A catalogue photograph keeps its dark studio shot in both themes:
          // it dissolves into the banner's near-black ground, which a
          // light-theme twin on cream could not.
          lightSrc={cover ? photo.lightSrc : undefined}
          crop={photo.productPhoto}
          frame={false}
          size={cover ? 1200 : 420}
          eager={eager}
          className={cover ? 'inset-0' : 'lv-fade-start inset-y-0 end-0 aspect-[2/1] sm:aspect-[5/2] lg:aspect-[3/1]'}
        />
      ) : (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 end-0 w-[56%] bg-[radial-gradient(120%_90%_at_100%_100%,rgb(188_163_107/0.16),transparent_60%)] rtl:bg-[radial-gradient(120%_90%_at_0%_100%,rgb(188_163_107/0.16),transparent_60%)]"
        />
      )}
      {/* THE SCRIM: near-black from the reading side, clear by two thirds of
          the way across, so the far side of the picture is seen as it is. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-l from-transparent from-30% via-[rgb(11_12_15/0.55)] via-62% to-[rgb(11_12_15/0.9)] rtl:bg-gradient-to-r sm:from-42% sm:via-70%"
      />
      <div
        className={`relative flex min-w-0 max-w-[64%] flex-col items-start justify-center gap-1 px-3.5 py-3 sm:max-w-[52%] sm:gap-1.5 sm:px-5 lg:max-w-[44%] lg:px-8 ${ON_PHOTO_INK}`}
      >
        <h3 className="line-clamp-1 text-[16px] font-bold leading-[22px] text-ivory [text-shadow:0_1px_2px_rgb(0_0_0/0.35)] sm:text-[19px] sm:leading-7 lg:text-[23px] lg:leading-8">{title}</h3>
        <p className="line-clamp-1 text-[11.5px] font-semibold leading-4 tabular-nums text-ivory/[0.78] sm:text-[13px] sm:leading-5 lg:text-[14px]">{line}</p>
        <span className="mt-0.5 inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full border border-white/25 bg-[rgb(11_12_15/0.45)] px-3 text-[12px] font-bold text-ivory backdrop-blur-sm transition-colors group-hover:border-white/50 motion-reduce:transition-none sm:h-8 sm:px-3.5 sm:text-[13px] lg:h-9 lg:px-4 lg:text-[14px]">
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
