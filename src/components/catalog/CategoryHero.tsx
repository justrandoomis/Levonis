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
 * THE CATEGORY'S HERO (docs/ux/CATALOG_DISCOVERY.md §6 item 2).
 *
 * PART OF THE PAGE, NOT A CARD ON IT (owner, 2026-09-26: «كانها مدموجه في
 * الأعلى بدون حدود المستطيل الذي يحيط بها … أقل عرض وسمك ومناسبة مع جميع
 * الشاشات وخاصة الصغيرة»). No surface, no border, no ring, no rounded box: the
 * words stand on the page's own canvas in the page's own ink, and the picture
 * dissolves into that canvas on every edge (`.lv-hero-blend`,
 * src/styles/catalog.css), so nothing draws a rectangle in either theme.
 *
 * It carries the breadcrumb, the name, the admin's description on one line
 * (omitted, never invented, when there is none), the live counts on one line
 * («10 طابعات · 4 متوفرة الآن») and the doors that fit this department — for
 * printers the primary «ساعدني أختار» and «قارن الطابعات»; for everything
 * else «تصفّح الكل». About 145 px on a phone, 210 px from 1024 px.
 *
 * THE PICTURE. The admin's banner for the theme on screen (0136/0142, see
 * explorerModel `authoredSrc`) is a full-width band behind the words, faded to
 * nothing on the reading side and at the top and bottom edges. A borrowed
 * product photograph is a compact visual on the far side, faded the same way
 * (its light-theme twin, 0138, on the light theme when it has one).
 *
 * `compact` is the hero of a department whose page IS its listing (§6, «A
 * category with no sub-sections»): the same words without the doors.
 */
const CategoryHero = forwardRef<HTMLElement, {
  payload: Pick<CategoryPayload, 'node' | 'path'>;
  photo: BannerPhoto | null;
  compact?: boolean;
}>(function CategoryHero({ payload, photo, compact = false }, ref) {
  const { lang, loc, dir } = useLanguage();
  const { node } = payload;
  const name = nodeName(node, lang);
  const description = nodeDescription(node, lang).split('\n')[0];
  const printers = isPrinterNode(node);
  const kind = nounKindFor(node.product_type, node.is_printer_catalog);
  const tray = useSyncExternalStore(compareTray.subscribe, compareTray.getSnapshot, compareTray.getSnapshot);
  const compareTo = tray.type === 'printer' && tray.items.length ? compareHref(tray) : '/compare';
  const Sep = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const avail = node.available_count;
  const band = !!photo && !photo.productPhoto;

  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).
  const door =
    'lv-hit relative inline-flex h-9 items-center justify-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none lg:h-11 lg:px-5 lg:text-[14px]';
  const ghost = `${door} border border-border-subtle bg-surface/70 text-text-primary backdrop-blur-sm hover:border-text-muted`;

  return (
    <section
      ref={ref}
      data-category-hero={compact ? 'compact' : 'full'}
      data-hero-photo={photo ? (band ? 'band' : 'product') : 'none'}
      aria-labelledby="category-title"
      className="group relative isolate text-text-primary"
    >
      {photo ? (
        <CropPhoto
          src={photo.src}
          lightSrc={photo.lightSrc}
          crop={photo.productPhoto}
          frame={false}
          size={band ? 1200 : 480}
          eager
          className={`lv-hero-blend -z-10 ${
            band ? 'inset-y-0 -inset-x-4 sm:-inset-x-6 lg:inset-x-0' : 'inset-y-0 -end-4 w-[42%] sm:-end-6 sm:w-[38%] lg:end-0 lg:w-[34%]'
          }`}
        />
      ) : null}
      <div className="flex min-w-0 flex-col py-2 lg:py-5">
        <div className={`flex min-w-0 flex-col ${photo ? 'max-w-[62%] sm:max-w-[60%] lg:max-w-[58%]' : ''}`}>
        <nav aria-label={loc('مسار التصفح', 'Breadcrumb')}>
          <ol className="flex flex-wrap items-center gap-1 text-[11.5px] leading-4 text-text-muted lg:text-[13px] lg:leading-5">
            <li>
              <Link to="/categories" className="lv-hit relative -mx-1 inline-flex items-center rounded px-1 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
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
                    <Link to={p.path} className="lv-hit relative -mx-1 rounded px-1 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                      {nodeName(p, lang)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <h1 id="category-title" className="mt-0.5 text-[22px] font-extrabold leading-[30px] tracking-[-0.01em] lg:mt-1 lg:text-[32px] lg:leading-[42px]">
          {name}
        </h1>
        {description ? (
          <p data-hero-description="" className="line-clamp-1 text-[12.5px] leading-[18px] text-text-secondary lg:text-[15px] lg:leading-6">
            {description}
          </p>
        ) : null}
        <dl className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] leading-[18px] text-text-secondary lg:mt-1 lg:text-[14px] lg:leading-5">
          <div className="flex items-baseline gap-1">
            <dt className="sr-only">{loc('عدد المنتجات', 'Products')}</dt>
            <dd className="font-bold tabular-nums text-text-primary">{node.product_count}</dd>
            <dd>{countWord(node.product_count, kind, lang)}</dd>
          </div>
          {avail !== null && avail > 0 ? (
            <div className="flex items-center gap-1.5">
              <span aria-hidden="true" className="text-text-muted">·</span>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
              <dt className="sr-only">{loc('متوفرة الآن', 'Available now')}</dt>
              <dd className="font-bold tabular-nums text-text-primary">{avail}</dd>
              <dd aria-hidden="true">{loc('متوفرة الآن', 'available now')}</dd>
            </div>
          ) : null}
        </dl>
        </div>
        {!compact ? (
          <div className="mt-2.5 flex flex-wrap gap-2 lg:mt-4">
            {printers ? (
              <>
                <Link
                  to="/printer-finder"
                  data-hero-cta="finder"
                  className={`${door} bg-primary-fill text-canvas hover:bg-primary-fill-hover`}
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
