import React from 'react';
import { Link } from 'react-router-dom';
import { PackageOpen } from 'lucide-react';
import { type ApiProduct, formatIqd } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import SafeImage from '../ui/SafeImage';
import SectionHeader from './SectionHeader';
import { productPrimaryImage } from '../../lib/productImage';
import { conditionKindLabel, conditionGradeLabel, type ConditionEntry } from '../../lib/condition';
import { useRail } from '../../lib/useRail';

/**
 * OPEN BOX, USED AND REFURBISHED — the shelf.
 *
 * A separate card from `ProductCard` rather than a flag on it, and the reason
 * is the price row. An ordinary card strikes through a REGULAR price when the
 * viewer's membership or a sale lowers it; this one strikes through the price
 * of a DIFFERENT product — the new one this is a used copy of. Rendering two
 * unrelated meanings through one component is how a shelf comes to tell a
 * customer that a used printer is on sale.
 *
 * WHAT A CARD MUST SAY BEFORE IT IS TAPPED. The kind (open box / used /
 * refurbished) and the grade, because "cheap printer" and "repaired printer"
 * are different purchases and the shelf is where that decision starts. The
 * condition badge is the ONE tinted element — §7: accent where it
 * communicates state, and nowhere else — so a rail of these reads as a row of
 * products rather than a row of warnings.
 */
export default function OpenBoxShelf({ products }: { products: ApiProduct[] }) {
  const { t, lang } = useLanguage();
  const rail = useRail();

  if (products.length === 0) return null;

  return (
    <section data-home-section="open_box" className="mb-10 sm:mb-12">
      <SectionHeader title={t('openBoxTitle')} accent="bg-info" to="/products?condition=any" />
      <p className="-mt-2 mb-3 text-[12px] text-zinc-500 leading-relaxed">{t('openBoxNote')}</p>
      <div
        ref={rail.ref}
        className="flex gap-2.5 overflow-x-auto overscroll-x-contain hide-scrollbar snap-x pb-1 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 sm:gap-3"
      >
        {products.map((p) => (
          <OpenBoxCard key={p.id} p={p} lang={lang} />
        ))}
      </div>
    </section>
  );
}

function OpenBoxCard({ p, lang }: { p: ApiProduct; lang: string }) {
  const condition = (p as ApiProduct & { condition?: ConditionEntry | null }).condition ?? null;
  const reference = (p as ApiProduct & { condition_reference?: { reference_iqd: number; saving_iqd: number } })
    .condition_reference;
  const price = p.display_price_iqd ?? p.price_iqd;

  return (
    <Link
      to={`/product/${p.slug || p.id}`}
      data-open-box-card={p.id}
      className="w-[160px] relative shrink-0 snap-start overflow-hidden flex flex-col bg-surface rounded-xl border border-border-subtle hover:bg-surface-raised transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="relative aspect-square overflow-hidden bg-black">
        <SafeImage src={productPrimaryImage(p)} alt={p.name} aspect="square" className="w-full h-full" />
        {condition ? (
          <span className="absolute top-2 start-2 inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-1 text-[10px] font-bold text-info backdrop-blur-sm">
            <PackageOpen aria-hidden="true" className="w-3 h-3" />
            {conditionKindLabel(condition.kind, lang)}
          </span>
        ) : null}
      </div>

      <div className="p-2.5 min-w-0 flex flex-col gap-1">
        {/* The product name is English in every language and never translated
            — the same rule the ordinary card follows. */}
        <h3 dir="ltr" className="text-[13px] font-medium leading-snug text-white line-clamp-2 min-h-[2.2rem] text-start">
          {p.name}
        </h3>

        {condition ? (
          <span className="text-[11px] text-zinc-400">
            {conditionGradeLabel(condition.grade, lang)}
            {condition.usage_hours !== null ? (
              <>
                {' · '}
                <span dir="ltr" className="tabular-nums">{condition.usage_hours.toLocaleString('en-US')}</span>
                {` ${lang === 'en' ? 'h' : 'س'}`}
              </>
            ) : null}
          </span>
        ) : null}

        <span className="mt-0.5 flex flex-col">
          <span className="text-[14px] font-bold text-white tabular-nums">{formatIqd(price)}</span>
          {/* The NEW product's current price, not a compare-at on this row.
              Present only when the server found an honest saving. */}
          {reference ? (
            <span className="text-[11px] text-zinc-500 line-through tabular-nums">
              {formatIqd(reference.reference_iqd)}
            </span>
          ) : null}
        </span>
      </div>
    </Link>
  );
}
