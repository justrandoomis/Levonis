import React, { forwardRef, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, WandSparkles } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import CropPhoto from './CropPhoto';
import { compareHref, compareTray } from '../../lib/compareTray';
import { isPrinterNode, nodeDescription, nodeName } from '../../lib/catalog/categoryPageModel';
import { countWord, nounKindFor } from '../../lib/catalog/copy';
import type { BannerPhoto } from '../../lib/catalog/explorerModel';
import type { CategoryPayload } from '../../lib/catalog/types';

/**
 * THE CATEGORY'S HERO (docs/ux/CATALOG_DISCOVERY.md §6 item 2, mockup 02).
 *
 * A charcoal island (`data-theme="dark"`): the breadcrumb, the name, the
 * admin's description (omitted, never invented, when there is none), two
 * live stats, and the doors that fit this department — for printers the gold
 * «ساعدني أختار» and a ghost «قارن الطابعات»; for everything else one ghost
 * «تصفّح الكل». A photograph fills the bottom far corner and fades toward the
 * words and the top.
 *
 * `compact` is the hero of a department whose page IS its listing (§6, «A
 * category with no sub-sections»): 180 px, the same words, no photograph
 * competition with the grid below.
 *
 * The photograph's mask (`.lv-fade-hero`) lives in src/styles/catalog.css,
 * imported by the page that draws this hero (CategoryPage).
 *
 * Desktop: two columns, the words 5fr and the photograph 7fr, 320 px.
 */
const CategoryHero = forwardRef<HTMLElement, {
  payload: Pick<CategoryPayload, 'node' | 'path'>;
  photo: BannerPhoto | null;
  compact?: boolean;
}>(function CategoryHero({ payload, photo, compact = false }, ref) {
  const { lang, loc, dir } = useLanguage();
  const { node } = payload;
  const name = nodeName(node, lang);
  const description = nodeDescription(node, lang);
  const printers = isPrinterNode(node);
  const kind = nounKindFor(node.product_type, node.is_printer_catalog);
  const tray = useSyncExternalStore(compareTray.subscribe, compareTray.getSnapshot, compareTray.getSnapshot);
  const compareTo = tray.type === 'printer' && tray.items.length ? compareHref(tray) : '/compare';
  const Sep = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const avail = node.available_count;

  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).
  const ghost =
    'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-ivory/[0.22] bg-charcoal/60 px-4 backdrop-blur-md text-[13px] font-bold text-ivory transition-colors hover:border-ivory/40 hover:bg-ivory/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted lg:min-h-12 lg:px-6 lg:text-[14px]';

  return (
    <section
      ref={ref}
      data-theme="dark"
      data-category-hero={compact ? 'compact' : 'full'}
      aria-labelledby="category-title"
      className={`group relative isolate overflow-hidden rounded-[22px] bg-charcoal text-ivory ring-1 ring-inset ring-white/[0.05] lg:grid lg:grid-cols-[5fr_7fr] lg:rounded-[28px] ${
        compact ? 'min-h-[180px] lg:min-h-[220px]' : 'min-h-[252px] lg:min-h-[320px]'
      }`}
    >
      {photo ? (
        <CropPhoto
          src={photo.src}
          crop={photo.productPhoto}
          size={compact ? 420 : 640}
          eager
          className={
            compact
              ? 'lv-fade-start inset-y-0 end-0 w-[46%] lg:w-[52%]'
              : 'lv-fade-hero bottom-0 end-0 h-[74%] w-[58%] lg:h-full lg:w-[60%]'
          }
        />
      ) : null}
      <div className={`relative flex flex-col p-[18px] lg:p-9 ${compact ? '' : 'min-h-[252px] lg:min-h-[320px]'}`}>
        <div className={compact ? 'max-w-[70%] lg:max-w-none' : 'max-w-[68%] lg:max-w-none'}>
        <nav aria-label={loc('مسار التصفح', 'Breadcrumb')}>
          <ol className="flex flex-wrap items-center gap-1 text-[11.5px] text-ivory/60 lg:text-[13px]">
            <li>
              <Link to="/categories" className="lv-hit relative -mx-1 inline-flex min-h-6 items-center rounded px-1 hover:text-ivory focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted">
                {loc('الفئات', 'Categories')}
              </Link>
            </li>
            {payload.path.map((p, i) => {
              const last = i === payload.path.length - 1;
              return (
                <li key={p.id} className="flex items-center gap-1">
                  <Sep aria-hidden="true" className="size-3 opacity-70" />
                  {last ? (
                    <span aria-current="page">{nodeName(p, lang)}</span>
                  ) : (
                    <Link to={p.path} className="lv-hit relative -mx-1 rounded px-1 hover:text-ivory focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted">
                      {nodeName(p, lang)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <h1 id="category-title" className="mt-1.5 text-[24px] font-extrabold leading-[33px] tracking-[-0.01em] lg:mt-3 lg:text-[40px] lg:leading-[50px]">
          {name}
        </h1>
        {description ? (
          <p className={`mt-1.5 text-[12.5px] leading-5 text-ivory/[0.74] lg:mt-3 lg:max-w-[36ch] lg:text-[15px] lg:leading-7 ${compact ? 'line-clamp-2' : 'line-clamp-3'}`}>
            {description}
          </p>
        ) : null}
        <dl className="mt-3.5 flex gap-5 lg:mt-6 lg:gap-8">
          <div className="flex flex-col-reverse">
            <dt className="text-[11px] text-ivory/[0.62] lg:text-[12.5px]">{countWord(node.product_count, kind, lang)}</dt>
            <dd className="text-[18px] font-extrabold tabular-nums leading-[22px] lg:text-[26px] lg:leading-8">{node.product_count}</dd>
          </div>
          {avail !== null && avail > 0 ? (
            <div className="flex flex-col-reverse">
              <dt className="flex items-center gap-1.5 text-[11px] text-ivory/[0.62] lg:text-[12.5px]">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
                {loc('متوفرة الآن', 'Available now')}
              </dt>
              <dd className="text-[18px] font-extrabold tabular-nums leading-[22px] lg:text-[26px] lg:leading-8">{avail}</dd>
            </div>
          ) : null}
        </dl>
        </div>
        {!compact ? (
          <div className="mt-auto flex flex-wrap gap-2 pt-4 lg:pt-8">
            {printers ? (
              <>
                <Link
                  to="/printer-finder"
                  data-hero-cta="finder"
                  className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-gold-muted px-4 text-[13px] font-extrabold text-gold-ink transition-[filter] hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ivory lg:min-h-12 lg:px-6 lg:text-[14px]"
                >
                  <WandSparkles aria-hidden="true" className="size-4" />
                  {loc('ساعدني أختار', 'Help me choose')}
                </Link>
                <Link to={compareTo} data-hero-cta="compare" className={ghost}>
                  {loc('قارن الطابعات', 'Compare printers')}
                </Link>
              </>
            ) : (
              <Link to={`${node.path}/all`} data-hero-cta="all" className={ghost}>
                {loc('تصفّح الكل', 'Browse all')}
              </Link>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
});

export default CategoryHero;
