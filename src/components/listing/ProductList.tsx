import React from 'react';
import { Link } from 'react-router-dom';
import SafeImage from '../ui/SafeImage';
import CardPrice from '../CardPrice';
import AvailabilityLine from '../product/AvailabilityLine';
import CompareToggle from '../compare/CompareToggle';
import { productMainImage, productPrimaryImage } from '../../lib/productImage';
import { useTheme } from '../../lib/theme';
import { cardHref, cardName, compareTypeOf, type CardProduct } from '../../lib/productCard';
import type { ApiProduct } from '../../lib/api';
import '../../styles/catalog.css';

/**
 * The list view (§7 item 4): one 96 px photograph per row beside the name,
 * the price and the availability — for comparing prices at a glance down a
 * column. The same words and prices as the card (the same `cardName`,
 * `CardPrice`, `AvailabilityLine`), and the same accessibility contract: the
 * row is one stretched link, and the compare toggle is its SIBLING on the
 * photograph, never nested inside it.
 */
export default function ProductList({ products }: { products: ApiProduct[] }) {
  const { theme } = useTheme();
  return (
    <ul data-product-list className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:gap-3">
      {products.map((raw, i) => {
        const p = raw as CardProduct;
        const image = productMainImage(p, theme);
        const lightShown = image !== '' && image === p.light_image;
        const name = cardName(p);
        const type = compareTypeOf(p);
        return (
          <li key={p.id} className={i >= 10 ? 'lv-cv-row' : undefined}>
            <div
              data-product-row
              className="group relative flex min-w-0 gap-3 rounded-[14px] border border-border-subtle bg-surface p-2.5 transition-colors hover:bg-surface-raised has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-focus"
            >
              <div className={`relative size-24 shrink-0 overflow-hidden rounded-[10px] ${lightShown ? 'bg-surface-selected' : 'bg-charcoal'}`}>
                <SafeImage
                  src={image}
                  alt=""
                  aspect="auto"
                  eager={i < 4}
                  className="h-full w-full"
                  bgClassName="bg-charcoal"
                  fallbackClassName="text-snow/35"
                  imgClassName="object-[50%_20%]"
                />
              </div>
              <Link
                to={cardHref(p)}
                className="flex min-w-0 flex-1 flex-col py-0.5 focus-visible:outline-none after:absolute after:inset-0 after:z-[1] after:content-['']"
              >
                <h3
                  dir="ltr"
                  title={name !== p.name ? p.name : undefined}
                  className="line-clamp-2 text-start text-[13px] font-semibold leading-[18px] text-text-primary [overflow-wrap:anywhere] rtl:text-right"
                >
                  {name}
                </h3>
                <div className="mt-1">
                  <CardPrice p={p} density="compact" />
                </div>
                <AvailabilityLine product={p} className="mt-auto pt-1" />
              </Link>
              {type ? (
                <CompareToggle
                  item={{ id: p.id, slug: p.slug || p.id, name, image: productPrimaryImage(p) || '' }}
                  type={type}
                  className="absolute start-3.5 top-3.5 z-[2]"
                />
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
