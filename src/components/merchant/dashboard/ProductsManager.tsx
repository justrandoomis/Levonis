/**
 * The products tab of the merchant dashboard.
 *
 * Since merchant platform W2-F the whole catalogue screen — the list with its
 * search, filters, cursor paging and bulk actions; the product editor with
 * variants, media (video included), 3D-printing attributes and collections;
 * insights; CSV import/export — is the self-contained component set under
 * src/components/merchant/catalog/. This file is its mount point, kept so the
 * dashboard's import (src/pages/MerchantDashboardPage.tsx) does not move.
 */
export { CatalogManager as ProductsManager } from '../catalog/CatalogManager';
