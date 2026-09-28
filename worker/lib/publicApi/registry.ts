/**
 * EVERY CONTENT ENDPOINT OF THE PUBLIC API, AND EVERY SCHEMA IT ANSWERS WITH.
 *
 * Adding an endpoint is adding it to one of the resource lists below: the
 * router serves it, /openapi.json documents it and /context introduces it,
 * all from this one list (worker/lib/publicApi/meta.ts).
 */
import { COMMON_COMPONENTS } from './common';
import { CATALOG_COMPONENTS, CATALOG_ROUTES } from './resources/catalog';
import { COMMUNITY_COMPONENTS, COMMUNITY_ROUTES } from './resources/community';
import { PRODUCT_COMPONENTS, PRODUCT_ROUTES } from './resources/products';
import { SHOP_COMPONENTS, SHOP_ROUTES } from './resources/shop';
import { SITE_COMPONENTS, SITE_ROUTES } from './resources/site';
import { STORE_COMPONENTS, STORE_ROUTES } from './resources/stores';
import type { JsonSchema } from './schema';
import type { PublicRoute } from './types';

/** In the order /context presents them: the shop first, then how to browse it. */
export const RESOURCE_ROUTES: readonly PublicRoute[] = [
  ...SITE_ROUTES.filter((r) => r.tag === 'Site'),
  ...SHOP_ROUTES.filter((r) => r.path === '/home'),
  ...CATALOG_ROUTES,
  ...PRODUCT_ROUTES,
  ...SHOP_ROUTES.filter((r) => r.path !== '/home'),
  ...COMMUNITY_ROUTES,
  ...STORE_ROUTES,
  ...SITE_ROUTES.filter((r) => r.tag !== 'Site'),
];

export const RESOURCE_COMPONENTS: Record<string, JsonSchema> = {
  ...COMMON_COMPONENTS,
  ...CATALOG_COMPONENTS,
  ...PRODUCT_COMPONENTS,
  ...SHOP_COMPONENTS,
  ...SITE_COMPONENTS,
  ...STORE_COMPONENTS,
  ...COMMUNITY_COMPONENTS,
};
