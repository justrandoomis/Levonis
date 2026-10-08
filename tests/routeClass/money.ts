/**
 * ROUTE CLASSIFICATION — order price adjustment, trade-in, wallet adjustment
 * and the printer farm (owner decision 2, step S1; the vocabulary
 * is in ./_types.ts, the test is tests/costRouteClassification.test.ts).
 *
 * MONEY, NOT COST. Decision 2 restricts cost data; it leaves moving money with
 * the owner and full or NULL-scope admins, exactly as before (security spec
 * §2.2): order price adjustments, trade-in approval and valuation, wallet
 * adjustment and rounding drift, farm coin grants. Each `money` route refuses
 * an assistant at the guard and lets a full admin through. Trade-in valuation
 * and rules are on the owner's review list (security spec §8): trade-in value
 * is what Levonis pays for a used device it may resell.
 */
import type { RouteClassFile } from './_types';
import { adminWalletAdjustRoutes } from '../../worker/routes/adminWalletAdjust';
import { farmAdminRoutes } from '../../worker/routes/farmAdmin';
import { adminOrderPriceRoutes } from '../../worker/routes/orderPriceAdjust';
import { adminTradeInRoutes } from '../../worker/routes/tradeIn';

export default {
  family: 'money',
  mounts: [
    {
      prefix: '/api/admin/orders',
      name: 'adminOrderPriceRoutes',
      router: adminOrderPriceRoutes,
      routes: {
        'GET /:id/price-adjustment': 'op',
        'POST /:id/price-adjustment': 'money',
        'POST /:id/price-adjustment/:pid/withdraw': { cls: 'op', noBody: 'withdraws a pending adjustment by id; needs one the role fixture does not seed' },
      },
    },
    {
      prefix: '/api/admin/trade-in',
      name: 'adminTradeInRoutes',
      router: adminTradeInRoutes,
      writes: 'a trade-in request’s inspection and status; its money is in the `money` routes',
      routes: {
        'GET /requests': 'op',
        'GET /requests/:id': 'op',
        'POST /requests/:id/inspect': 'op',
        'POST /requests/:id/approve': 'money',
        'POST /requests/:id/value': 'money',
        'POST /requests/:id/complete': 'op',
        'POST /requests/:id/cancel': 'op',
        'GET /rules': 'op',
        'PUT /rules/:family': 'money',
        'POST /rules/:family/test': { cls: 'op', noBody: 'tries a valuation rule of one device family on a sample; needs a family the role fixture does not seed' },
      },
    },
    {
      prefix: '/api/admin/wallet-adjust',
      name: 'adminWalletAdjustRoutes',
      router: adminWalletAdjustRoutes,
      routes: {
        'POST /users/:id': 'money',
        'GET /rounding-drift': 'money',
        'POST /rounding-drift/apply': 'money',
      },
    },
    {
      prefix: '/api/admin/farm',
      name: 'farmAdminRoutes',
      router: farmAdminRoutes,
      writes: 'the printer-farm game: its balance document and shelved state (in-game coins, not dinars)',
      routes: {
        'GET /config': 'op',
        'PUT /config/:section': 'op',
        'POST /config/:section/reset': 'op',
        'GET /shelved': 'op',
        'PUT /shelved': 'op',
        'GET /players/:userId': 'op',
        'POST /players/:userId/grant': 'money',
      },
    },
  ],
} satisfies RouteClassFile;
