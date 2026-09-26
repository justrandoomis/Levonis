import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import SafeImage from '../ui/SafeImage';
import { useLanguage } from '../../LanguageContext';
import { columnName, type CompareLang, type CompareProductCard } from '../../lib/compare';
import { lensStrings } from './lensStrings';
import { productTone } from './tones';
import { columnsTemplate } from './grid';

/**
 * THE PRODUCT COLUMNS (CATALOG_DISCOVERY §10.3.2; mockup 8).
 *
 * One card per column — photograph, name, price — with ✕ (remove; 24 px drawn,
 * 44 px hit) at the corner and ‹ › (reorder, «انقل يمينًا / يسارًا»), on the
 * same grid as every spec row below (./grid.ts), so a value always sits under
 * its photograph.
 *
 * THE COLLAPSE WITHOUT A JUMP. When the cards scroll out of view a 56 px strip
 * (a 32 px thumbnail and a one-line name per column) takes the top of the
 * scroller, so the table keeps the screen and the reader keeps the names. The
 * cards stay in the flow and simply scroll away; the strip is a separate,
 * zero-height sticky layer that fades in — nothing above the reader's eye
 * changes height, so the page never jumps. Under reduced motion it appears
 * without the slide.
 *
 * Every verb here writes the URL through the page (push), so back undoes it.
 */
/**
 * The strip's names: the words every column's name starts with («Bambu Lab»)
 * are dropped there, so a 110 px column says «X2D», not «Bamb…». The cards
 * and the table keep the full names.
 */
export function stripNames(names: string[]): string[] {
  const words = names.map((n) => n.split(' / ')[0].trim().split(/\s+/));
  let common = 0;
  while (words.length > 1 && words.every((w) => w.length > common && w[common].toLowerCase() === words[0][common]?.toLowerCase())) {
    common++;
  }
  // Only the WHOLE shared prefix is dropped, and only when every name keeps a word.
  if (common === 0 || words.some((w) => w.length <= common)) return words.map((w) => w.join(' '));
  return words.map((w) => w.slice(common).join(' '));
}

export default function StickyColumns({
  products,
  prices,
  wide,
  onRemove,
  onMove,
}: {
  products: CompareProductCard[];
  /** The price row's own text per column (the server's price row), or '' for none. */
  prices: string[];
  wide: boolean;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
}) {
  const { lang, dir } = useLanguage();
  const l = lang as CompareLang;
  const ls = lensStrings(lang);
  const cards = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = cards.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const root = document.getElementById('main-scroll-container');
    // Collapsed once the cards' lower half has left the top of the scroller.
    const io = new IntersectionObserver(([entry]) => setCollapsed(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)), {
      root,
      threshold: 0,
      rootMargin: '-120px 0px 0px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const template = columnsTemplate(products.length, wide);
  const stripShort = stripNames(products.map((p) => columnName(p, l)));
  const last = products.length - 1;

  return (
    <>
      {/* The compact strip: a zero-height sticky layer, shown once the cards are gone. */}
      <div className="sticky top-0 z-20 h-0">
        <div
          aria-hidden={!collapsed}
          data-compare-strip={collapsed ? 'shown' : 'hidden'}
          className={`absolute inset-x-[-16px] top-0 border-b border-border-subtle bg-canvas/92 px-4 backdrop-blur-md transition-[opacity,transform] duration-200 motion-reduce:transition-none ${
            collapsed ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0 motion-reduce:translate-y-0'
          }`}
        >
          <div className="grid h-14 items-center gap-x-3 ps-3 pe-1" style={{ gridTemplateColumns: template }}>
            {wide ? <span /> : null}
            {products.map((p, i) => (
              <div key={p.id} className="flex min-w-0 items-center gap-2">
                <SafeImage src={p.image} alt="" aspect="square" fit="cover" className="w-8 shrink-0 overflow-hidden rounded-lg" bgClassName="bg-charcoal" fallbackClassName="text-snow/35" />
                <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: productTone(i).color }} />
                <span dir="ltr" className="min-w-0 truncate text-[12px] font-bold text-text-primary">
                  {stripShort[i]}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div ref={cards} aria-label={ls.columnsLabel} role="group" className="grid gap-x-3 ps-3 pe-1" style={{ gridTemplateColumns: template }}>
        {wide ? <span /> : null}
        {products.map((p, i) => {
          const name = columnName(p, l);
          const short = name.split(' / ')[0];
          return (
            <div key={p.id} data-compare-column={i} className="relative flex min-w-0 flex-col rounded-[16px] border border-border-subtle bg-surface p-1.5 pb-1">
              <div className="relative overflow-hidden rounded-[12px] bg-charcoal">
                <Link to={`/product/${p.slug}`} tabIndex={-1} aria-hidden="true" className="block aspect-[6/5]">
                  <SafeImage src={p.image} alt="" aspect="auto" className="h-full w-full" bgClassName="bg-charcoal" fallbackClassName="text-snow/35" imgClassName="object-[50%_8%]" />
                </Link>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={ls.remove(short)}
                  title={ls.remove(short)}
                  className="lv-hit absolute start-1.5 top-1.5 grid size-6 place-items-center rounded-full border border-snow/15 bg-onyx/60 text-snow backdrop-blur-md transition-colors hover:bg-onyx/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X aria-hidden="true" className="size-3.5" strokeWidth={2.4} />
                </button>
              </div>
              <div className="flex min-w-0 flex-1 flex-col px-1 pt-2">
                <Link
                  to={`/product/${p.slug}`}
                  dir="ltr"
                  title={name}
                  className="line-clamp-2 text-start text-[12.5px] font-bold leading-[17px] text-text-primary [overflow-wrap:anywhere] hover:underline rtl:text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm"
                >
                  <span aria-hidden="true" className="me-1.5 inline-block size-2 rounded-full align-[1px]" style={{ backgroundColor: productTone(i).color }} />
                  {short}
                </Link>
                {prices[i] ? (
                  <bdi dir="ltr" className="mt-1 block truncate whitespace-nowrap text-start text-[12.5px] font-extrabold tabular-nums text-text-primary rtl:text-right">
                    {prices[i]}
                  </bdi>
                ) : null}
                <div className="mt-auto flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => onMove(i, -1)}
                    disabled={i === 0}
                    aria-label={ls.moveStart(short)}
                    title={ls.moveStart(short)}
                    className="grid size-11 place-items-center rounded-full text-text-secondary transition-colors hover:bg-surface-selected hover:text-text-primary disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {dir === 'ltr' ? <ChevronLeft aria-hidden="true" className="size-4" /> : <ChevronRight aria-hidden="true" className="size-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(i, 1)}
                    disabled={i === last}
                    aria-label={ls.moveEnd(short)}
                    title={ls.moveEnd(short)}
                    className="grid size-11 place-items-center rounded-full text-text-secondary transition-colors hover:bg-surface-selected hover:text-text-primary disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {dir === 'ltr' ? <ChevronRight aria-hidden="true" className="size-4" /> : <ChevronLeft aria-hidden="true" className="size-4" />}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
