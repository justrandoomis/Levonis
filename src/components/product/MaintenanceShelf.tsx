import { useEffect, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api, type ApiProduct, type ProductsListResponse } from '../../lib/api';
import ProductShelf from '../catalog/ProductShelf';

/** «مواد الصيانة» (0148) — the section every shelf of this kind lists from. */
const MAINTENANCE_CATEGORY = 'cat_maint';

/**
 * «مواد الصيانة لهذه الطابعة» — THE PARTS THAT FIT ONE PRINTER, AS A SHELF.
 *
 * The owner: «عندما يشتري المستخدم طابعة معينة يظهر له اقتراحات مواد الصيانة
 * لهذه الطابعة التي اشتراها». One shelf, three doors: the printer's own page,
 * the order that bought it, and the customer's devices. The cards come from
 * the ordinary listing (`/api/products?category=…&fits=…`), so a part here is
 * priced, stocked and ordered — available now first — exactly as it is in its
 * section; nothing is recomputed for the shelf.
 *
 * DRAWN ONLY WHEN IT HAS CARDS. The server already said parts exist (`count`);
 * a failed or empty read leaves nothing on the page rather than an empty frame
 * or an error card in the middle of someone's order.
 */
export default function MaintenanceShelf({
  printerSlug,
  count,
  path,
  title,
  subline,
  id = 'maintenance-parts',
}: {
  printerSlug: string;
  count: number;
  /** `/categories/maintenance-parts/all` — «عرض الكل» adds the printer filter. */
  path: string | null;
  title?: string;
  subline?: string;
  id?: string;
}) {
  const { loc } = useLanguage();
  const [products, setProducts] = useState<ApiProduct[] | null>(null);

  useEffect(() => {
    let alive = true;
    setProducts(null);
    const qs = new URLSearchParams({ category: MAINTENANCE_CATEGORY, fits: printerSlug, limit: '10' });
    api
      .get<ProductsListResponse>(`/api/products?${qs.toString()}`)
      .then((res) => alive && setProducts(res.products ?? []))
      .catch(() => alive && setProducts([]));
    return () => {
      alive = false;
    };
  }, [printerSlug]);

  if (!products || products.length === 0) return null;
  // OWNER: Sorani to be written by hand (the three loc() pairs below).
  return (
    <div data-maintenance-shelf={printerSlug}>
      <ProductShelf
        id={id}
        title={title ?? loc('مواد الصيانة لهذه الطابعة', 'Maintenance parts for this printer')}
        count={count}
        subline={subline ?? loc('فوهات وألواح وقطع غيار تناسب هذه الطابعة', 'Nozzles, plates and spare parts that fit this printer')}
        seeAll={path ? `${path}?fits=${encodeURIComponent(printerSlug)}` : undefined}
        products={products}
      />
    </div>
  );
}
