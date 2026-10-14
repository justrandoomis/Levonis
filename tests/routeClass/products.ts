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
        // «يحتاج تسعيرًا» (the clean start, addendum A.8): codes, counts, names and field names only, projected
        // per viewer (a price editor never reads a cost code's name or the owner-only filters).
        'GET /needs-pricing': 'op',
        // D1 (addendum A.10): a confirmed purchase's cost waits for the owner's review — cost end to end.
        'GET /:id/purchase-review': { cls: 'cost_read', why: 'the cost inputs a confirmed stock purchase implies, pending the owner’s review' },
        'POST /:id/purchase-review/:reviewId/preview': { cls: 'cost_read', why: 'the review’s price change: prices in memory, writes nothing; POST only for its path' },
        'POST /:id/purchase-review/:reviewId/apply': { cls: 'cost_write', why: 'one V2 batch: the purchase’s cost inputs, the prices they move and the review marked applied' },
        'POST /:id/purchase-review/:reviewId/dismiss': { cls: 'cost_write', why: '«أبقِ التكلفة الحالية»: the review is dismissed, nothing else moves' },
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
        'POST /:id/reprice': { cls: 'op', noBody: 'retired by the clean start (addendum A.6): 409 PRICING_V2_MANAGED for every product and every admin, nothing written' },
        'DELETE /:id': { cls: 'op', noBody: 'removes the product row (refused while history holds it); answers ids only' },
        'PUT /:id/catalogs': { cls: 'op', body: { catalog_ids: [] } },
        // The admin price preview: the owner's carries cost_iqd, everyone else's does not.
        'POST /:id/quote': { cls: 'op', body: { tier: 'pro' } },
        // Pricing V2-3b (spec §4.1, C-7): price editors reach these, so they are `op`; every dollar,
        // rate and cost field is enforced per field (403 COST_ACCESS_DENIED with the field names) and
        // every answer is an allow-list (v2/dto.ts) — the owner's carries `v2_*`, nobody else's does
        // (tests/pricingV2Roles.test.ts sweeps them over V2_SENTINELS).
        'GET /:id/pricing': 'op',
        'POST /pricing/preview': {
          cls: 'op',
          body: {
            product_id: null,
            structure: { doc: { id: 'prd_v2_route_class', name_en: 'Draft', name_ar: 'مسودة', price_iqd: 0, status: 'draft' }, relations: null },
            pricing: { method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd: '100' }] },
          },
          why: 'add-product’s V2 preview: prices the draft in memory and writes nothing (a non-owner sending dollars is refused by field)',
        },
        'PUT /:id/pricing': {
          cls: 'op',
          noBody: 'a prices-only apply: without its body it is refused (400) and writes nothing; the seeded product needs pricing (its first V2 write comes through here or the save)',
        },
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
                // No route surcharge: the clean start (A.6) refuses a dinar cell the stored route does not hold.
                transports: [{ method: 'air', enabled: true, sort: 0, capacity: 3 }],
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
        // The clean start (addendum A.6): the price grid is closed — every route answers 409 PRICING_V2_MANAGED
        // {section} for every product and every admin, writes nothing and names no figure.
        'PATCH /:id/price-grid': { cls: 'op', noBody: 'closed by the clean start: 409 PRICING_V2_MANAGED {section: 3}, nothing written' },
        'PATCH /:id/price-grid/traits': { cls: 'op', noBody: 'closed by the clean start: 409 PRICING_V2_MANAGED {section: 5}, nothing written' },
        'POST /:id/price-grid/bulk': { cls: 'op', noBody: 'closed by the clean start: 409 PRICING_V2_MANAGED {section: 3}, nothing written' },
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
