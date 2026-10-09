/**
 * ROUTE CLASSIFICATION — «التسعير والشحن», the owner's pricing workspace
 * (pricing engine MVP P1; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * Every route is COST: today's price next to the old landed cost, the minimum
 * profit and the Direct Sale Extra derived from them, the rate reference and the
 * what-if's replacement cost. The router's door — requireAdmin, the rate
 * limit, then `requireCostRead` on `use('*')` above the first route
 * (tests/costPredicateUsage.test.ts) — refuses every caller but the verified
 * owner before an id is read.
 *
 * The what-if is a POST only because it carries a body; it writes nothing
 * (tests/pricingPreviewNoWrite.test.ts), so it is a cost READ.
 */
import type { RouteClassFile } from './_types';
import { adminPricingRoutes } from '../../worker/routes/adminPricing';

export default {
  family: 'pricing',
  mounts: [
    {
      prefix: '/api/admin/pricing',
      name: 'adminPricingRoutes',
      router: adminPricingRoutes,
      routes: {
        'GET /overview': 'cost_read',
        'GET /products/:id': 'cost_read',
        'POST /products/:id/what-if': {
          cls: 'cost_read',
          body: { supplier_cost: '100.5', currency: 'EUR' },
          why: 'a calculator: it prices in memory and writes nothing; POST only for its body',
        },
      },
    },
  ],
} satisfies RouteClassFile;
