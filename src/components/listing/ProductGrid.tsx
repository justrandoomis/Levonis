import React from 'react';
import { useLanguage } from '../../LanguageContext';
import ProductCard from '../home/ProductCard';
import { availableFirst, gridImageLoading, laterIsPreorder } from '../../lib/productCard';
import type { ApiProduct } from '../../lib/api';
import { UNPRICED_TEXT } from '../../lib/priceStatus';
import '../../styles/catalog.css';

/**
 * The result grid (§7 item 8): the shop's one compact card, two to a row on
 * a phone (3 from 640 px; beside the desktop filter column 3, then 4 from
 * 1280), with the compare toggle on each.
 *
 * DIRECT SALE FIRST, SAID ONCE. Under the default order the server already
 * puts what can be bought today first; a quiet «بطلب مسبق» divider names the
 * second group (the Products page's wording, §4.2), and catalog-only products
 * (DECISIONS rows 239-240) close the grid under «السعر غير متوفر حالياً» — a
 * stock word is never printed over items whose stock is not set. Any other
 * order is the shopper's own and gets no divider.
 *
 * The first two rows load at once (a listing's grid starts under its search
 * and toolbar, ~250 px down a phone); the rest wait until they near the
 * screen (src/lib/productCard.ts `gridImageLoading`).
 *
 * Rows past the first screen use `content-visibility: auto` with the card's
 * fixed 262 px as their intrinsic size, so a long list costs nothing until it
 * is scrolled to — and never jumps, because the size is the real one.
 */
/** Two rows of two: the cards a phone shows above the fold of a listing. */
const FIRST_SCREEN_CARDS = 4;

export default function ProductGrid({ products, divider, withColumn }: { products: ApiProduct[]; divider: boolean; withColumn: boolean }) {
  const { loc } = useLanguage();
  const ordered = divider ? availableFirst(products) : { items: products, splitAt: -1, unpricedAt: -1 };
  const laterLabel = laterIsPreorder(ordered)
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
          {i === ordered.splitAt || i === ordered.unpricedAt ? (
            <Divider label={i === ordered.unpricedAt ? loc(UNPRICED_TEXT.ar, UNPRICED_TEXT.en, UNPRICED_TEXT.ckb) : laterLabel} />
          ) : null}
          {/* `lv-cv` (content-visibility) goes on the CARD, not this <li>:
              paint containment clips a descendant's ink at the container's
              edge, which would cut every card's clay shadow from the 9th on. */}
          <li className="flex">
            <ProductCard p={p} density="compact" compareToggle {...gridImageLoading(i, FIRST_SCREEN_CARDS)} className={i >= 8 ? 'lv-cv' : undefined} />
          </li>
        </React.Fragment>
      ))}
    </ul>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <li role="separator" aria-label={label} className="col-span-full flex items-center gap-3 pt-2 text-[12px] font-bold text-text-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
      <span aria-hidden="true">{label}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-border-subtle" />
    </li>
  );
}
