/**
 * CATALOG DISCOVERY — the storefront's view of the wire shapes
 * (docs/ux/CATALOG_DISCOVERY.md §11, IMPLEMENTATION_PLAN.md S0).
 *
 * The shapes are defined ONCE, in packages/catalog/src/discoveryTypes.ts, and
 * built by the Worker from the same file. This module only pins the generic
 * card to the storefront's `ApiProduct`, so a page imports one name:
 *
 *   GET /api/catalog/tree            → CatalogTreeResponse
 *   GET /api/catalog/:slug           → CategoryPayload            (404 CATALOG_NOT_FOUND)
 *   GET /api/products?…&facets=1     → ProductsListResponse (+ ListingMeta fields)
 *   GET /api/printer-finder?…        → FinderResponse
 *   GET /api/printer-finder/meta     → FinderMeta
 *   GET /api/compare?ids=…           → comparison.lenses: CompareLens[]
 */
import type { ApiProduct } from '../api';
import type {
  CategoryPayload as CategoryPayloadOf,
  FinderResponse as FinderResponseOf,
  FinderResult as FinderResultOf,
  Shelf as ShelfOf,
} from '../../../packages/catalog/src/discoveryTypes';

export type {
  BrandCount,
  CatalogTreeNode,
  CatalogTreeResponse,
  CategoryLayout,
  CompareLens,
  CompareLensId,
  FacetOption,
  FacetSet,
  FinderCaveat,
  FinderCoverage,
  FinderCriterion,
  FinderExcluded,
  FinderMeta,
  FinderReason,
  FinderRelaxation,
  ListingMeta,
  ShelfChip,
  ShelfKind,
  Trilingual,
} from '../../../packages/catalog/src/discoveryTypes';

export type {
  FacetField,
  FinderAnswers,
  FinderBudget,
  FinderLevel,
  FinderPriority,
  FinderSale,
  FinderTech,
  FinderUse,
  ListingFilters,
  ListingSort,
  ListingState,
  PriceRange,
  SaleFilter,
  SizeBucket,
} from '../../../packages/catalog/src/discovery';

export type Shelf = ShelfOf<ApiProduct>;
export type CategoryPayload = CategoryPayloadOf<ApiProduct>;
export type FinderResult = FinderResultOf<ApiProduct>;
export type FinderResponse = FinderResponseOf<ApiProduct>;
