/**
 * FEATURED PRODUCTS — products the merchant picked by hand, in their order.
 * Only live products arrive (the server reads them scoped to this store), so a
 * pick that was hidden or archived simply is not shown.
 */
import { BlockHeading, Column, ProductGrid, ProductShelf, useText } from '../parts';
import type { BlockProps } from '../types';

export default function FeaturedProductsBlock({ block, store, data }: BlockProps<'featured_products'>) {
  const text = useText();
  const byId = new Map(data.picked.map((p) => [p.id, p]));
  const products = block.settings.product_ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
  if (!products.length) return null;
  return (
    <Column>
      <BlockHeading title={text(block.settings.title)} />
      {block.variant === 'carousel' ? (
        <ProductShelf products={products} storeOpen={!!store.open} />
      ) : (
        <ProductGrid products={products} storeOpen={!!store.open} />
      )}
    </Column>
  );
}
