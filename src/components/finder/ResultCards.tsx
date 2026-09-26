import React from 'react';
import { Link } from 'react-router-dom';
import { Star } from 'lucide-react';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import AvailabilityLine from '../product/AvailabilityLine';
import { productPrimaryImage } from '../../lib/productImage';
import { cardHref, cardName, compareTypeOf, type CardProduct } from '../../lib/productCard';
import type { FinderResult } from '../../lib/catalog/types';
import ReasonList from './ReasonList';
import { CompareButton, SaveButton } from './ResultActions';
import { resultsUi, type FinderLang } from './strings';

export interface ResultCardProps {
  result: FinderResult;
  lang: FinderLang;
  saved: boolean;
  saveBusy: boolean;
  onSave: (() => void) | null;
}

function useCardBits(result: FinderResult) {
  const p = result.card as CardProduct;
  const name = cardName(p);
  const image = productPrimaryImage(p);
  const type = compareTypeOf(p);
  const item = { id: p.id, slug: p.slug || p.id, name, image: image || '' };
  return { p, name, image, type, item, href: cardHref(p) };
}

/**
 * #1 — THE PICK (mockup 7): a 16:10 photograph with the «الأنسب لك» badge (the
 * finder's one gold mark), the name, price and availability, «لماذا نرشّحها»
 * with up to three reasons and one caveat, then «عرض المنتج» (primary), the
 * compare toggle and save.
 */
export function ResultHero({ result, lang, saved, saveBusy, onSave }: ResultCardProps) {
  const t = resultsUi(lang);
  const { p, name, image, type, item, href } = useCardBits(result);
  const headingId = `finder-r-${p.id}`;
  return (
    <article
      aria-labelledby={headingId}
      data-finder-rank={result.rank}
      className="overflow-hidden rounded-[22px] border border-border-subtle bg-surface shadow-[var(--shadow-2)]"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-charcoal">
        <SafeImage
          src={image}
          alt=""
          aspect="auto"
          eager
          className="h-full w-full"
          bgClassName="bg-charcoal"
          fallbackClassName="text-snow/35"
          imgClassName="object-[50%_18%]"
        />
        <span className="absolute end-3 top-3 inline-flex items-center gap-1.5 rounded-full bg-gold-fill px-3 py-1.5 text-[12.5px] font-extrabold text-ink shadow-[0_6px_18px_-8px_rgb(0_0_0/0.6)]">
          <Star aria-hidden="true" className="size-3.5 fill-ink" strokeWidth={0} />
          {t.bestBadge}
        </span>
      </div>
      <div className="p-4 sm:p-5">
        <h2 id={headingId} dir="ltr" title={name !== p.name ? p.name : undefined} className="text-[18px] font-extrabold leading-[24px] tracking-[-0.01em] text-text-primary text-start rtl:text-right">
          <Link to={href} className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            {name}
          </Link>
        </h2>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-4 gap-y-1.5">
          <CardPrice p={p} density="compact" />
          <AvailabilityLine product={p} className="min-w-[132px]" />
        </div>
        <div className="mt-4 border-t border-border-subtle pt-4">
          <h3 className="text-[12.5px] font-bold text-text-muted">{t.why}</h3>
          <div className="mt-2">
            <ReasonList reasons={result.reasons} caveats={result.caveats} lang={lang} maxReasons={3} maxCaveats={1} watchLabel={t.watch} />
          </div>
        </div>
        <div className="mt-5 flex items-stretch gap-2.5">
          <Link to={href} className="lv-button lv-button-primary !min-h-12 flex-1 !rounded-2xl !text-[15px]">
            {t.viewProduct}
          </Link>
          {type ? (
            <CompareButton
              item={item}
              type={type}
              label={t.compare}
              onLabel={t.inCompare}
              addName={t.compareAdd(name)}
              removeName={t.compareRemove(name)}
              iconOnly
            />
          ) : null}
          {onSave ? <SaveButton saved={saved} busy={saveBusy} onToggle={onSave} label={saved ? t.unsave(name) : t.save(name)} /> : null}
        </div>
      </div>
    </article>
  );
}

/**
 * #2 AND #3 (and a 4th within 0.02 of the 3rd): a horizontal card — a 92 px
 * photograph with the rank, one reason and one caveat, «عرض المنتج» and the
 * compare toggle.
 */
export function ResultRow({ result, lang, saved, saveBusy, onSave }: ResultCardProps) {
  const t = resultsUi(lang);
  const { p, name, image, type, item, href } = useCardBits(result);
  const headingId = `finder-r-${p.id}`;
  return (
    <article
      aria-labelledby={headingId}
      data-finder-rank={result.rank}
      className="rounded-[20px] border border-border-subtle bg-surface p-3.5"
    >
      <div className="flex gap-3.5">
        <div className="relative size-[92px] shrink-0 overflow-hidden rounded-[14px] bg-charcoal">
          <SafeImage src={image} alt="" aspect="auto" className="h-full w-full" bgClassName="bg-charcoal" fallbackClassName="text-snow/35" imgClassName="object-[50%_10%]" />
          <span
            aria-hidden="true"
            className="absolute end-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-ivory text-[12px] font-extrabold tabular-nums text-ink"
          >
            {result.rank}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-[15px] font-bold leading-[20px] text-text-primary">
            <span className="sr-only">{t.rank(result.rank)}: </span>
            <Link to={href} dir="ltr" title={name !== p.name ? p.name : undefined} className="block text-start rtl:text-right hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-sm">
              {name}
            </Link>
          </h2>
          <div className="mt-1.5">
            <CardPrice p={p} density="compact" />
          </div>
          <AvailabilityLine product={p} className="mt-1" />
        </div>
      </div>
      <div className="mt-3">
        <ReasonList reasons={result.reasons} caveats={result.caveats} lang={lang} maxReasons={1} maxCaveats={1} dense specFirst watchLabel={t.watch} />
      </div>
      <div className="mt-3 flex items-stretch gap-2">
        <Link to={href} className="lv-button lv-button-secondary flex-1 !rounded-2xl">
          {t.viewProduct}
        </Link>
        {type ? (
          <CompareButton item={item} type={type} label={t.compare} onLabel={t.inCompare} addName={t.compareAdd(name)} removeName={t.compareRemove(name)} />
        ) : null}
        {onSave ? <SaveButton saved={saved} busy={saveBusy} onToggle={onSave} label={saved ? t.unsave(name) : t.save(name)} /> : null}
      </div>
    </article>
  );
}

export function ResultSkeleton({ hero = false }: { hero?: boolean }) {
  return (
    <div aria-hidden="true" className={`overflow-hidden rounded-[20px] border border-border-subtle bg-surface ${hero ? '' : 'p-3.5'}`}>
      {hero ? (
        <>
          <div className="aspect-[16/10] animate-pulse bg-surface-selected motion-reduce:animate-none" />
          <div className="space-y-3 p-4">
            <div className="h-5 w-2/3 rounded-md bg-surface-selected" />
            <div className="h-4 w-1/3 rounded-md bg-surface-selected" />
            <div className="h-3.5 w-5/6 rounded-md bg-surface-selected" />
            <div className="h-3.5 w-4/6 rounded-md bg-surface-selected" />
          </div>
        </>
      ) : (
        <div className="flex gap-3.5">
          <div className="size-[92px] animate-pulse rounded-[14px] bg-surface-selected motion-reduce:animate-none" />
          <div className="flex-1 space-y-2.5 pt-1">
            <div className="h-4 w-3/4 rounded-md bg-surface-selected" />
            <div className="h-4 w-1/3 rounded-md bg-surface-selected" />
            <div className="h-3 w-1/2 rounded-md bg-surface-selected" />
          </div>
        </div>
      )}
    </div>
  );
}
