import React from 'react';
import { useLanguage } from '../../LanguageContext';
import ProductCard from '../home/ProductCard';
import { availableFirst, cardAvailability } from '../../lib/productCard';
import type { ApiProduct } from '../../lib/api';
import '../../styles/catalog.css';

/**
 * The result grid (§7 item 8): the shop's one compact card, two to a row on
 * a phone (3 from 640 px; beside the desktop filter column 3, then 4 from
 * 1280), with the compare toggle on each.
 *
 * DIRECT SALE FIRST, SAID ONCE. Under the default order the server already
 * puts what can be bought today first; a quiet «بطلب مسبق» divider names the
 * second group (the Products page's wording, §4.2). Any other order is the
 * shopper's own and gets no divider.
 *
 * Rows past the first screen use `content-visibility: auto` with the card's
 * fixed 262 px as their intrinsic size, so a long list costs nothing until it
 * is scrolled to — and never jumps, because the size is the real one.
 */
export default function ProductGrid({ products, divider, withColumn }: { products: ApiProduct[]; divider: boolean; withColumn: boolean }) {
  const { loc } = useLanguage();
  const ordered = divider ? availableFirst(products) : { items: products, splitAt: -1 };
  const laterLabel =
    ordered.splitAt > 0 && ordered.items.slice(ordered.splitAt).every((p) => cardAvailability(p).state === 'preorder')
      ? loc('بطلب مسبق', 'Pre-order')
      : loc('ليست في المخزون الآن', 'Not in stock right now');
  // OWNER: Sorani to be written by hand (the two divider labels above — the Products page's own wording).
  return (
    <ul
      data-product-grid
      className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 ${withColumn ? 'lg:grid-cols-3 xl:grid-cols-4' : 'lg:grid-cols-4 xl:grid-cols-5'} lg:gap-4`}
    >
      {ordered.items.map((p, i) => (
        <React.Fragment key={p.id}>
          {i === ordered.splitAt ? (
            <li role="separator" aria-label={laterLabel} className="col-span-full flex items-center gap-3 pt-2 text-[12px] font-bold text-text-muted">
              <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
              <span aria-hidden="true">{laterLabel}</span>
              <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
            </li>
          ) : null}
          <li className={`flex ${i >= 8 ? 'lv-cv' : ''}`}>
            <ProductCard p={p} density="compact" compareToggle eager={i < 4} />
          </li>
        </React.Fragment>
      ))}
    </ul>
  );
}
