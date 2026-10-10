/**
 * ROUTE CLASSIFICATION — the product, relations, price-grid, bundle, mystery
 * and offer routers (owner decision 2, step S1; the vocabulary is in
 * ./_types.ts, the test is tests/costRouteClassification.test.ts).
 *
 * These are the catalogue's working routers: every admin edits products, and
 * the product document, the relations, the fulfilment panel and the price grid
 * all carry cost at five levels. Those reads are `op` — the server strips the
 * cost for every non-owner (projectForAdmin) — and the writes are `op` with a
 * VALID body each, built the way the panel builds it: read the document as the
 * same caller, send it back. A non-owner's round trip carries no cost key, and
 * the server must neither refuse it nor answer a cost. The routes that exist
 * only to read or move cost (price history, cost change, copy, selection
 * price) are refused outright.
 */
import type { RouteClassFile } from './_types';
import { NB } from './_types';
import { adminBundlesRoutes } from '../../worker/routes/adminBundles';
import { adminPriceGridRoutes } from '../../worker/routes/adminPriceGrid';
import { adminProductRelationsRoutes } from '../../worker/routes/adminProductRelations';
import { adminProductsRoutes } from '../../worker/routes/adminProducts';
import { adminCompositionAnalyticsRoutes } from '../../worker/routes/bundles';
import { adminMysteryRoutes } from '../../worker/routes/mystery';
import { adminOffersRoutes } from '../../worker/routes/offers';

export default {
  family: 'products',
  mounts: [
    {
      prefix: '/api/admin/products-v2',
      name: 'adminProductsRoutes',
      router: adminProductsRoutes,
      writes: NB.CATALOGUE,
      routes: {
        'POST /:id/selection-price': 'cost_write',
        'GET /brands': 'op',
        'POST /brands': 'op',
        'PATCH /brands/:id': 'op',
        'GET /catalogs': 'op',
        'POST /catalogs': 'op',
        'PATCH /catalogs/:id': 'op',
        'POST /catalogs/:catalogId/reorder': 'op',
        'GET /': 'op',
        'GET /stats': 'op',
        // «ناقص» / «إخفاء المنتجات الناقصة عن الزبائن» (owner brief 2026-10-10,
        // worker/routes/adminCompleteness.ts): every admin reads a product's
        // missing fields (a non-owner reads one OWNER_DATA item for the private
        // ones); the count, the recount and the switch are the verified owner's.
        'GET /completeness/summary': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } },
        'POST /completeness/refresh': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } },
        'PUT /completeness/hide': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } },
        'GET /:id/completeness': 'op',
        'GET /maintenance/orphans': 'op',
        'POST /maintenance/orphans/cleanup': { cls: 'op', noBody: NB.MEDIA },
        'POST /maintenance/media-cleanup/retry': { cls: 'op', noBody: NB.MEDIA },
        'PATCH /:id/status': { cls: 'op', body: { status: 'active' } },
        'GET /printer-options': 'op',
        'GET /:id': 'op',
        // The product save: the document as the caller read it, sent back.
        'POST /': {
          cls: 'op',
          body: async (read: (p: string) => Promise<Record<string, unknown>>) => (await read('/api/admin/products-v2/p_a1')).product,
        },
        'POST /:id/reprice': { cls: 'op', body: { mode: 'delta', from_price_iqd: 900000, to_price_iqd: 950000 } },
        'DELETE /:id': { cls: 'op', noBody: 'removes the product row (refused while history holds it); answers ids only' },
        'PUT /:id/catalogs': { cls: 'op', body: { catalog_ids: [] } },
        // The admin price preview: the owner's carries cost_iqd, everyone else's does not.
        'POST /:id/quote': { cls: 'op', body: { tier: 'pro' } },
      },
    },
    {
      prefix: '/api/admin/products',
      name: 'adminProductRelationsRoutes',
      router: adminProductRelationsRoutes,
      routes: {
        'GET /:id/relations': 'op',
        'GET /:id/stock': 'op',
        'PUT /:id/relations': {
          cls: 'op',
          body: async (read: (p: string) => Promise<Record<string, unknown>>) => {
            const { success: _ok, ...relations } = await read('/api/admin/products/p_a1/relations');
            void _ok;
            return relations;
          },
        },
        'GET /:id/fulfillment': 'op',
        'PUT /:id/fulfillment': {
          cls: 'op',
          body: {
            fulfillments: [
              {
                option_id: 'v_a1',
                fulfillment_type: 'pre_order',
                enabled: true,
                sort: 0,
                capacity: 5,
                transports: [{ method: 'air', enabled: true, sort: 0, surcharge_iqd: 25000, capacity: 3 }],
              },
            ],
          },
        },
        'POST /:id/stock/adjust': { cls: 'op', body: { scope: 'base', delta: 1, reason: 'role matrix count' } },
      },
    },
    {
      prefix: '/api/admin/products',
      name: 'adminPriceGridRoutes',
      router: adminPriceGridRoutes,
      routes: {
        'GET /:id/price-grid': 'op',
        'PATCH /:id/price-grid': {
          cls: 'op',
          body: { cells: [{ level: 'option', id: 'v_a1', field: 'regular', mode: 'fixed', value: '950000' }] },
        },
        'PATCH /:id/price-grid/traits': { cls: 'op', body: { traits: [{ level: 'option', id: 'v_a1', field: 'active', value: true }] } },
        // Leak L4: a preview below cost must say nothing about the cost to a non-owner.
        'POST /:id/price-grid/bulk': { cls: 'op', body: { op: 'set', fields: ['regular'], value: 100_000, scope: { levels: ['product'] } } },
        'POST /:id/price-grid/copy': 'cost_write',
        'POST /:id/price-grid/undo': {
          cls: 'op',
          noBody: 'needs the batch id of an earlier grid write, which only the owner’s price history names; the unknown-batch refusal is walked',
        },
        'GET /:id/price-history': 'cost_read',
        'POST /:id/price-grid/cost-change': 'cost_write',
      },
    },
    {
      prefix: '/api/admin/bundles',
      name: 'adminBundlesRoutes',
      router: adminBundlesRoutes,
      writes: 'needs a bundle or mystery product, which the role fixture does not seed; component cost is swept for an assistant by tests/adminBundlesRoutes.test.ts («component cost never reaches an assistant admin»)',
      routes: {
        'GET /': 'op',
        'GET /:productId': 'op',
        'GET /:productId/preview': 'op',
        'POST /': 'op',
        'PUT /reorder': 'op',
        'PUT /:productId': 'op',
        'POST /:productId/duplicate': 'op',
        'PATCH /:productId/status': 'op',
        'DELETE /:productId': 'op',
      },
    },
    {
      prefix: '/api/admin/mystery',
      name: 'adminMysteryRoutes',
      router: adminMysteryRoutes,
      writes: 'needs a bundle or mystery product, which the role fixture does not seed; component cost is swept for an assistant by tests/adminBundlesRoutes.test.ts («component cost never reaches an assistant admin»)',
      routes: {
        'GET /pools': 'op',
        'POST /pools': 'op',
        'GET /pools/:id': 'op',
        'PUT /pools/:id': 'op',
        'DELETE /pools/:id': 'op',
        'GET /pools/:id/entries': 'op',
        'POST /pools/:id/entries/generate': 'op',
        'PUT /pools/:id/entries': 'op',
        'GET /pools/:id/eligible': 'op',
        'GET /offers': 'op',
        'POST /offers': 'op',
        'GET /offers/:productId': 'op',
        'PUT /offers/:productId': 'op',
        'POST /offers/:productId/duplicate': 'op',
        'POST /offers/:productId/rotate-secret': 'op',
        'POST /pool-membership': 'op',
        'GET /offers/:productId/audits': 'op',
      },
    },
    {
      prefix: '/api/admin/offers',
      name: 'adminOffersRoutes',
      router: adminOffersRoutes,
      writes: 'special offers are discount rules on a product (percent, amount, dates); the router reads no cost column',
      routes: {
        'GET /': 'op',
        'GET /tiers': 'op',
        'GET /:productId': 'op',
        'POST /': 'op',
        'PUT /:productId': 'op',
        'DELETE /:productId': 'op',
      },
    },
    {
      prefix: '/api/admin/analytics',
      name: 'adminCompositionAnalyticsRoutes',
      router: adminCompositionAnalyticsRoutes,
      routes: {
        'GET /bundles': 'op',
        'GET /mystery': 'op',
      },
    },
  ],
} satisfies RouteClassFile;
