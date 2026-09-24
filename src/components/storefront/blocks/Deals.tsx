/**
 * DEALS — published products whose price is below their original price.
 * `DealsView` is the classic Deals tab (a grid and «show more»); the stacked
 * block shows a count of them as a grid or a shelf.
 */
import { Star } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import type { ProductPage } from '../../../../packages/storeLayout/src/data';
import { BlockHeading, Column, Empty, Loading, ProductGrid, ProductShelf, useText } from '../parts';
import { usePagedProducts } from './ProductsGrid';
import type { BlockProps } from '../types';

export function DealsView({ initial, storeOpen }: { initial: ProductPage | undefined; storeOpen: boolean }) {
  const { loc } = useLanguage();
  const { items, cursor, busy, more } = usePagedProducts('deals', '', initial);
  if (items === null) return <Loading />;
  if (!items.length) {
    return <Empty icon={<Star className="w-8 h-8 text-zinc-600" strokeWidth={1.5} aria-hidden="true" />} text={loc('لا توجد عروض حالية', 'No current deals', 'ئۆفەر نییە')} />;
  }
  return (
    <div className="space-y-3">
      <ProductGrid products={items} storeOpen={storeOpen} />
      {cursor && (
        <button
          type="button"
          onClick={() => void more()}
          disabled={busy}
          className="w-full h-9 rounded-xl border border-zinc-800 text-[12px] text-zinc-300 hover:border-zinc-700 disabled:opacity-50"
        >
          {busy ? loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…') : loc('عرض المزيد', 'Show more', 'زیاتر ببینە')}
        </button>
      )}
    </div>
  );
}

export default function DealsBlock({ block, store, data }: BlockProps<'deals'>) {
  const text = useText();
  const { items } = usePagedProducts('deals', '', data.products.deals);
  if (items === null) return <Column><Loading /></Column>;
  if (!items.length) return null;
  const shown = items.slice(0, block.settings.limit);
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      {block.variant === 'carousel' ? (
        <ProductShelf products={shown} storeOpen={!!store.open} />
      ) : (
        <ProductGrid products={shown} storeOpen={!!store.open} />
      )}
    </Column>
  );
}
