/**
 * COLLECTIONS — the store's shelves (`merchant_store_sections`), only those
 * that hold a published product.
 *
 * `CollectionsList` is the classic page's Sections tab: picking a shelf hands
 * it to the Products tab as a filter. The stacked block links each shelf to
 * the store's product list filtered by it.
 */
import { Link } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { CollectionData } from '../../../../packages/storeLayout/src/data';
import { useStorefrontRuntime } from '../runtime';
import { BlockHeading, Column, Loading, useText } from '../parts';
import { useBlockRows } from '../useBlockRows';
import { collectionName } from './ProductsGrid';
import type { BlockProps } from '../types';

export function CollectionsList({ sections, onPick }: { sections: CollectionData[]; onPick: (id: string) => void }) {
  const { loc, lang } = useLanguage();
  return (
    <div dir="rtl" className="space-y-2">
      {sections.map((s) => (
        <button
          type="button"
          key={s.id}
          onClick={() => onPick(s.id)}
          className="sf-row w-full h-12 px-3.5 flex items-center justify-between gap-2 active:scale-[0.99] transition-transform"
        >
          <span className="text-zinc-100 text-[13px] font-medium truncate">{collectionName(s, lang)}</span>
          <span className="flex items-center gap-1.5 shrink-0 text-zinc-500">
            <span className="text-[11px]">
              {s.product_count} {loc('منتج', 'products', 'بەرهەم')}
            </span>
            <ChevronLeft className="w-4 h-4 ltr:rotate-180" strokeWidth={1.75} aria-hidden="true" />
          </span>
        </button>
      ))}
    </div>
  );
}

export default function CollectionsBlock({ block, data }: BlockProps<'collections'>) {
  const rt = useStorefrontRuntime();
  const { loc, lang } = useLanguage();
  const text = useText();
  const all = useBlockRows(data.collections, rt.loadCollections);
  if (all === null) return <Column><Loading /></Column>;
  const picked = block.settings.collection_ids;
  const sections = picked.length ? picked.map((id) => all.find((c) => c.id === id)).filter((c): c is CollectionData => !!c) : all;
  if (!sections.length) return null;

  const title = text(block.settings.title);
  if (block.variant === 'chips') {
    return (
      <Column>
        <BlockHeading title={title} />
        <div className="flex flex-wrap gap-2">
          {sections.map((s) => (
            <Link
              key={s.id}
              to={rt.collectionHref(s.id)}
              className="inline-flex items-center min-h-[40px] px-4 rounded-full border border-white/15 text-zinc-100 text-[12.5px] font-medium active:scale-[0.98] transition-transform"
            >
              <span dir="auto">{collectionName(s, lang)}</span>
            </Link>
          ))}
        </div>
      </Column>
    );
  }
  if (block.variant === 'cards') {
    return (
      <Column>
        <BlockHeading title={title} />
        <div className="grid grid-cols-2 @min-[40rem]:grid-cols-3 sf-grid">
          {sections.map((s) => (
            <Link key={s.id} to={rt.collectionHref(s.id)} className="sf-card sf-card-pad flex flex-col gap-1 min-h-[76px] justify-center active:scale-[0.99] transition-transform">
              <span className="text-zinc-100 text-[13.5px] font-semibold truncate" dir="auto">
                {collectionName(s, lang)}
              </span>
              <span className="text-zinc-500 text-[11px]">
                {s.product_count} {loc('منتج', 'products', 'بەرهەم')}
              </span>
            </Link>
          ))}
        </div>
      </Column>
    );
  }
  return (
    <Column>
      <BlockHeading title={title} />
      <div dir="rtl" className="space-y-2">
        {sections.map((s) => (
          <Link key={s.id} to={rt.collectionHref(s.id)} className="sf-row w-full h-12 px-3.5 flex items-center justify-between gap-2 active:scale-[0.99] transition-transform">
            <span className="text-zinc-100 text-[13px] font-medium truncate">{collectionName(s, lang)}</span>
            <span className="flex items-center gap-1.5 shrink-0 text-zinc-500">
              <span className="text-[11px]">
                {s.product_count} {loc('منتج', 'products', 'بەرهەم')}
              </span>
              <ChevronLeft className="w-4 h-4 ltr:rotate-180" strokeWidth={1.75} aria-hidden="true" />
            </span>
          </Link>
        ))}
      </div>
    </Column>
  );
}
