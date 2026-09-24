/** PRODUCTS CAROUSEL — one source of products as a shelf that scrolls sideways. */
import { productQueryKey } from '../../../../packages/storeLayout/src/data';
import { BlockHeading, Column, Loading, ProductShelf, useText } from '../parts';
import { usePagedProducts } from './ProductsGrid';
import type { BlockProps } from '../types';

export default function ProductsCarouselBlock({ block, store, data }: BlockProps<'products_carousel'>) {
  const s = block.settings;
  const text = useText();
  const { items } = usePagedProducts(s.source, s.collection_id, data.products[productQueryKey(s.source, s.collection_id)]);
  if (items === null) return <Column><Loading /></Column>;
  if (!items.length) return null;
  return (
    <Column>
      <BlockHeading title={text(s.title)} />
      <ProductShelf products={items.slice(0, s.limit)} storeOpen={!!store.open} />
    </Column>
  );
}
