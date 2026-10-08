/**
 * ROUTE CLASSIFICATION — taxonomy, media, price reports, print quote, membership
 * benefits and warranties (owner decision 2, step S1; the vocabulary is in
 * ./_types.ts, the test is tests/costRouteClassification.test.ts).
 *
 * Catalogue structure and customer programmes: every admin's (`op`), and none
 * of these routers reads a cost column — except the printer economics editor
 * of the print quote. A machine's purchase price, residual value and
 * maintenance rate are what it cost the shop, and its list answers the
 * platform machine-hour rate out of `printPricingConfig`, a cost setting: the
 * owner's alone, behind the cost door.
 */
import type { RouteClassFile } from './_types';
import { NB } from './_types';
import { adminMembershipBenefitRoutes } from '../../worker/routes/adminMembershipBenefits';
import { adminTaxonomyRoutes } from '../../worker/routes/adminTaxonomy';
import { mediaRoutes } from '../../worker/routes/media';
import { adminPriceReportRoutes } from '../../worker/routes/priceReports';
import { adminPrintQuoteRoutes } from '../../worker/routes/printQuote';
import { warrantyAdminRoutes } from '../../worker/routes/warranty';

export default {
  family: 'catalogue',
  mounts: [
    {
      prefix: '/api/admin/taxonomy',
      name: 'adminTaxonomyRoutes',
      router: adminTaxonomyRoutes,
      writes: NB.CATALOGUE,
      routes: {
        'GET /templates': 'op',
        'GET /catalogs': 'op',
        'POST /catalogs': 'op',
        'POST /catalogs/order': 'op',
        'DELETE /catalogs/:id': 'op',
        'PUT /catalogs/:id/delivery-rules/:method': 'op',
        'DELETE /catalogs/:id/delivery-rules/:method': 'op',
        'POST /catalogs/:id/image': 'op',
        'DELETE /catalogs/:id/image': 'op',
        'POST /catalogs/:id/image-mobile': 'op',
        'DELETE /catalogs/:id/image-mobile': 'op',
        'POST /catalogs/:id/image-light': 'op',
        'DELETE /catalogs/:id/image-light': 'op',
        'POST /catalogs/:id/image-light-mobile': 'op',
        'DELETE /catalogs/:id/image-light-mobile': 'op',
        'POST /catalogs/:id/hero-image': 'op',
        'DELETE /catalogs/:id/hero-image': 'op',
        'POST /catalogs/:id/hero-mobile-image': 'op',
        'DELETE /catalogs/:id/hero-mobile-image': 'op',
        'POST /catalogs/:id/hero-light-image': 'op',
        'DELETE /catalogs/:id/hero-light-image': 'op',
        'POST /catalogs/:id/hero-light-mobile-image': 'op',
        'DELETE /catalogs/:id/hero-light-mobile-image': 'op',
        'GET /facets': 'op',
        'POST /facets': 'op',
        'DELETE /facets/:id': 'op',
        'GET /brands': 'op',
        'POST /brands': 'op',
        'DELETE /brands/:id': 'op',
        'GET /hashtags': 'op',
        'POST /hashtags': 'op',
        'POST /hashtags/strip': 'op',
        'DELETE /hashtags/:id': 'op',
        'GET /search-vocabulary': 'op',
        'POST /search-vocabulary': 'op',
        'DELETE /search-vocabulary/:term': 'op',
        // §29 serial tracking by section (0178): the owner's switch alone, the
        // same `isOwner` rule as S1's other owner-only acts that carry no cost.
        'PUT /catalogs/:id/serial-policy': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } },
      },
    },
    {
      prefix: '/api/admin/media',
      name: 'mediaRoutes',
      router: mediaRoutes,
      writes: NB.MEDIA,
      routes: {
        'POST /ingest': 'op',
        'GET /migration/inventory': 'op',
        'GET /migration/status': 'op',
        'POST /migration/apply': 'op',
      },
    },
    {
      prefix: '/api/admin/price-reports',
      name: 'adminPriceReportRoutes',
      router: adminPriceReportRoutes,
      writes: 'customer price reports and their decision (status, note); the gap is computed from public prices',
      routes: {
        'GET /': 'op',
        'PATCH /:id': 'op',
      },
    },
    {
      prefix: '/api/admin/print-quote',
      name: 'adminPrintQuoteRoutes',
      router: adminPrintQuoteRoutes,
      routes: {
        'GET /printer-models': 'cost_read',
        'PATCH /printer-models/:id': { cls: 'cost_write', path: '/api/admin/print-quote/printer-models/bbl-x1c' },
      },
    },
    {
      prefix: '/api/admin/membership-benefits',
      name: 'adminMembershipBenefitRoutes',
      router: adminMembershipBenefitRoutes,
      writes: NB.SETTINGS,
      routes: {
        'GET /': 'op',
        'GET /versions': 'op',
        'POST /': 'op',
        'PUT /:id': 'op',
        'DELETE /:id': 'op',
        'GET /recommended': 'op',
        'POST /recommended': 'op',
        'GET /consolidation': 'op',
        'POST /consolidation': 'op',
        'POST /simulate': 'op',
      },
    },
    {
      prefix: '/api/admin/warranties',
      name: 'warrantyAdminRoutes',
      router: warrantyAdminRoutes,
      writes: 'warranty documents (device, serial, dates, status); no cost column is read',
      routes: {
        'GET /config': 'op',
        'PUT /config': 'op',
        'GET /': 'op',
        'GET /:id': 'op',
        'GET /orders/:orderId': 'op',
        'POST /': 'op',
        'POST /:id/activate': 'op',
        'POST /:id/reissue': 'op',
        'POST /:id/void': 'op',
        'POST /:id/printed': 'op',
        'GET /:id/document': 'op',
      },
    },
  ],
} satisfies RouteClassFile;
