/**
 * The ten live printers of 2026-09-25 as finder candidates (guest prices, the
 * captured direct-sale stock), for the pure scorer tests. The route tests use
 * the same data through the database (tests/fixtures/liveCatalog.ts).
 */
import { LIVE_PRODUCTS, type LiveProduct } from './liveCatalog';
import type { FinderCandidate } from '../../worker/lib/printerFinder';

export type Card = { id: string; name: string };

export function liveCandidates(patch: (p: LiveProduct) => Partial<LiveProduct> | void = () => {}): FinderCandidate<Card>[] {
  return LIVE_PRODUCTS.filter((p) => p.sub_category_id === 'cat_printers_fdm').map((base, rank) => {
    const p = { ...base, spec_fields: { ...base.spec_fields }, ...(patch(base) ?? {}) };
    return {
      id: p.id,
      card: { id: p.id, name: p.name.split(' / ')[0] },
      productType: 'printer' as const,
      price: p.price_iqd,
      available: p.stock,
      sectionSlugs: ['fdm-printers', 'printers'],
      specs: p.spec_fields,
      rank,
    };
  });
}
