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
 *
 * Services V2, owner decision 3 (DECISIONS row 223, worker/lib/moneyAuthority.ts):
 * the trade-in inspection and completion join the money routes, the valuation
 * rules are the owner's alone, and a value above the server's estimate is the
 * owner's too (judged in the handler, where the estimate is read).
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
      writes: 'a trade-in request’s status (cancel); its valuation and completion are `money` routes',
      routes: {
        'GET /requests': 'op',
        'GET /requests/:id': 'op',
        // S-P2 (DECISIONS row 238, decision 2): the device is RECEIVED by any admin — no money moves at intake;
        // never on one's own request (TRADE_IN_OWN_REQUEST); a serial mismatch is the owner's, judged in the handler.
        'POST /requests/:id/intake': { cls: 'op', noBody: 'receives a sent trade-in device (serial, hours, condition); needs a sent request the role fixture does not seed' },
        'POST /requests/:id/photos': { cls: 'op', noBody: 'an intake photograph, multipart; needs a sent trade-in request the role fixture does not seed' },
        'POST /requests/:id/device-returned': { cls: 'op', noBody: 'stamps a received device as handed back after a cancel; needs such a request the role fixture does not seed' },
        // Retired by intake: every admin reads 409 TRADE_IN_INTAKE_REQUIRED (a cached desk tab reads a sentence).
        'POST /requests/:id/inspect': { cls: 'op', noBody: 'the retired inspection door; it answers 409 TRADE_IN_INTAKE_REQUIRED to every admin and writes nothing' },
        // Decision 3: a financial admin up to the server's ceiling from intake; above it the owner (judged in the handler).
        'POST /requests/:id/approve': 'money',
        'POST /requests/:id/value': 'money',
        'POST /requests/:id/complete': 'money',
        'POST /requests/:id/cancel': 'op',
        // B.10: the rules (weights, cap, floor, references, offer parameters) price every offer — the owner's to read.
        'GET /rules': 'cost_read',
        // The rules decide every estimate a financial admin may approve: the owner's alone (owner decision 3).
        'PUT /rules/:family': 'owner',
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
