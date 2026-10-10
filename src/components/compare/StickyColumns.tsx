import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, X, Zap } from 'lucide-react';
import SafeImage from '../ui/SafeImage';
import { useLanguage } from '../../LanguageContext';
import { columnName, tri, type CompareLang, type CompareOptionChoice, type CompareProductCard } from '../../lib/compare';
import MulticolorBadge from './MulticolorBadge';
import { lensStrings } from './lensStrings';
import { productTone } from './tones';
import { columnGap, columnsTemplate } from './grid';
import { useTheme } from '../../lib/theme';
import { themedImage } from '../../lib/productImage';

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

/**
 * On a crowded phone row the configuration drops the model it repeats:
 * «A1 Combo» under «Bambu Lab A1» reads «Combo». Display only; the select's
 * own choices keep the full names.
 */
export function variantShort(variant: string, product: string): string {
  const model = product.trim().split(/\s+/).pop() ?? '';
  if (model && variant.toLowerCase().startsWith(`${model.toLowerCase()} `)) return variant.slice(model.length + 1);
  return variant;
}

/** The name a column is known by: its configuration («A1 Combo») when it has one, else the product. */
export function columnShortName(p: CompareProductCard, lang: CompareLang): string {
  const product = tri(p.name, lang).split(' / ')[0].trim();
  const option = p.option ? tri(p.option.label, lang).trim() : '';
  return option || product;
}

export default function StickyColumns({
  products,
  prices,
  wide,
  onRemove,
  onMove,
  onVariant,
}: {
  products: CompareProductCard[];
  prices: string[];
  wide: boolean;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  /** «بدون AMS / كومبو / ليزر»: switch this column to another configuration of the same machine. */
  onVariant?: (index: number, optionId: string) => void;
}) {
  const { lang, dir } = useLanguage();
  const { theme } = useTheme();
  const imageOf = (p: CompareProductCard) => themedImage(p.image ?? '', p.light_image, theme);
  const l = lang as CompareLang;
  const ls = lensStrings(lang);
  const cards = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const el = cards.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const root = document.getElementById('main-scroll-container');
    const io = new IntersectionObserver(([entry]) => setCollapsed(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0)), {
      root,
      threshold: 0,
      rootMargin: '-120px 0px 0px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const template = columnsTemplate(products.length, wide);
  const stripShort = stripNames(products.map((p) => columnShortName(p, l)));
  const last = products.length - 1;
  const dense = !wide && products.length >= 3;
  const gap = columnGap(products.length, wide);

  return (
    <>
      {/*
        THE STICKY HEADER: photograph, name, configuration and price per
        column, so a row far down the table is still read against WHICH
        machine at WHICH price. A zero-height sticky layer that fades in once
        the cards have scrolled away — nothing above the reader's eye changes
        height, so the page never jumps. It is drawn INSIDE the page column
        (no negative inset past the gutter), so it can never widen the page.
      */}
      <div className="sticky top-0 z-20 h-0">
        <div
          aria-hidden={!collapsed}
          data-compare-strip={collapsed ? 'shown' : 'hidden'}
          className={`absolute inset-x-0 top-0 rounded-b-lg border-b border-border-subtle bg-surface-raised shadow-lg transition-[opacity,transform] duration-200 motion-reduce:transition-none ${
            collapsed ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0 motion-reduce:translate-y-0'
          }`}
        >
          <div className={`grid min-h-[60px] items-center ${gap} py-2 ps-3 pe-1`} style={{ gridTemplateColumns: template }}>
            {wide ? <span /> : null}
            {products.map((p, i) => (
              <div key={p.id} data-strip-column={i} className="flex min-w-0 items-center gap-2">
                {/* Three or four columns on a phone leave ~75 px each: the
                    price is worth more than a 28 px thumbnail there. */}
                {dense ? null : (
                  <SafeImage src={imageOf(p)} alt="" aspect="square" fit="cover" className="w-9 shrink-0 overflow-hidden rounded-lg" bgClassName="bg-charcoal" fallbackClassName="text-snow/35" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1">
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: productTone(i).color }} />
                    <span dir="ltr" className="min-w-0 truncate text-[11.5px] font-bold leading-4 text-text-primary">
                      {stripShort[i]}
                    </span>
                  </span>
                  {prices[i] ? (
                    <bdi dir="ltr" className="block truncate text-start text-[11.5px] font-extrabold leading-4 tabular-nums text-text-secondary rtl:text-right">
                      {prices[i]}
                    </bdi>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div ref={cards} aria-label={ls.columnsLabel} role="group" className={`grid ${gap} ps-3 pe-1`} style={{ gridTemplateColumns: template }}>
        {wide ? <span /> : null}
        {products.map((p, i) => {
          const name = columnName(p, l);
          const short = tri(p.name, l).split(' / ')[0];
          const variantName = p.option ? tri(p.option.label, l) : '';
          const choices = p.options ?? [];
          return (
            <div key={p.id} data-compare-column={i} className={`lv-surface relative flex min-w-0 flex-col pb-1 ${dense ? 'p-1' : 'p-1.5'}`}>
              <div className="relative overflow-hidden rounded-lg bg-charcoal">
                <Link to={`/product/${p.slug}`} tabIndex={-1} aria-hidden="true" className="block aspect-[6/5]">
                  <SafeImage src={imageOf(p)} alt="" aspect="auto" className="h-full w-full" bgClassName="bg-charcoal" fallbackClassName="text-snow/35" imgClassName="object-[50%_8%]" />
                </Link>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={ls.remove(short)}
                  title={ls.remove(short)}
                  className="lv-hit absolute start-1.5 top-1.5 grid size-6 place-items-center rounded-full border border-snow/15 bg-onyx/70 text-snow transition-colors hover:bg-onyx/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X aria-hidden="true" className="size-3.5" strokeWidth={2.4} />
                </button>
              </div>
              <div className={`flex min-w-0 flex-1 flex-col pt-2 ${dense ? 'px-0.5' : 'px-1'}`}>
                <Link
                  to={`/product/${p.slug}`}
                  dir="ltr"
                  title={name}
                  className="line-clamp-2 text-start text-[12.5px] font-bold leading-[17px] text-text-primary [overflow-wrap:anywhere] hover:underline rtl:text-right focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm"
                >
                  <span aria-hidden="true" className="me-1.5 inline-block size-2 rounded-full align-[1px]" style={{ backgroundColor: productTone(i).color }} />
                  {/* On a crowded phone row the brand every column shares is
                      dropped («X2D», not «Bambu…»); the link's title keeps it. */}
                  {dense ? stripNames(products.map((x) => tri(x.name, l).split(' / ')[0]))[i] : short}
                </Link>
                {choices.length >= 2 && onVariant ? (
                  <VariantSwitch
                    index={i}
                    name={short}
                    value={p.option?.id ?? ''}
                    choices={choices}
                    lang={l}
                    current={dense ? variantShort(variantName, short) : variantName}
                    onChange={(optionId) => onVariant(i, optionId)}
                  />
                ) : variantName && variantName !== short && choices.length >= 2 ? (
                  <span dir="ltr" className="mt-1 block truncate text-start text-[11.5px] font-semibold text-text-secondary rtl:text-right">
                    {variantName}
                  </span>
                ) : null}
                {prices[i] ? (
                  <bdi dir="ltr" title={ls.priceAsSold} className={`mt-1 block whitespace-nowrap text-start font-extrabold tabular-nums tracking-[-0.01em] text-text-primary rtl:text-right ${dense ? 'text-[11px]' : 'truncate text-[13px]'}`}>
                    {prices[i]}
                  </bdi>
                ) : null}
                {p.multicolor ? (
                  <MulticolorBadge badge={p.multicolor.badge} lang={l} size={dense ? 'xs' : 'sm'} className="mt-1.5" />
                ) : null}
                {p.laser_module_w ? (
                  <span data-laser-chip className="mt-1 inline-flex w-fit items-center gap-1 rounded-sm border border-border-subtle px-1.5 py-0.5 text-[10.5px] font-bold leading-[13px] text-text-secondary">
                    <Zap aria-hidden="true" className="size-3 shrink-0 text-warning" strokeWidth={2.2} />
                    {ls.laser(p.laser_module_w)}
                  </span>
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

/**
 * «بدون AMS / كومبو / ليزر» — the column's configuration, switchable in place.
 *
 * A NATIVE <select>, on purpose: on a phone it opens the system wheel (big
 * targets, the platform's own scrolling), it is announced as a combobox with
 * its value, and it costs no sheet. Each choice carries its own direct-sale
 * price from the server, so the switch is also the price comparison between
 * configurations of one machine.
 */
function VariantSwitch({
  index,
  name,
  value,
  choices,
  lang,
  current,
  onChange,
}: {
  index: number;
  name: string;
  value: string;
  choices: CompareOptionChoice[];
  lang: CompareLang;
  current: string;
  onChange: (optionId: string) => void;
}) {
  const ls = lensStrings(lang);
  const id = `lv-compare-variant-${index}`;
  return (
    // The VISIBLE face is the configuration's name, wrapped over two lines if
    // it must — a 60 px column cannot show «H2D Laser Full Combo 10W» on one.
    // The native select lies over it, transparent, so the tap, the keyboard
    // and the screen reader all get the real control.
    <label
      htmlFor={id}
      className="relative mt-1.5 flex min-h-9 min-w-0 items-center gap-1 rounded-sm lv-well border border-[var(--clay-field)] py-1 ps-1.5 pe-1 transition-colors focus-within:ring-2 focus-within:ring-focus"
    >
      <span dir="ltr" aria-hidden="true" className="line-clamp-2 min-w-0 flex-1 text-start text-[10.5px] font-bold leading-[13px] text-text-primary [overflow-wrap:break-word] rtl:text-right">
        {current || ls.variant}
      </span>
      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-text-muted" />
      <select
        id={id}
        data-variant-switch={index}
        aria-label={ls.variantOf(name)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {tri(c.label, lang)}
            {typeof c.price_iqd === 'number' && c.price_iqd > 0 ? ` — ${c.price_iqd.toLocaleString('en-US')}` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
