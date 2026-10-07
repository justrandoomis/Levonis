/**
 * ROUTE CLASSIFICATION — the legacy admin router, /api/admin (owner decision
 * 2, step S1; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * The router every admin screen grew out of: users, orders, delivery, coupons,
 * settings, site media, warranty claims. Its cost surfaces are the legacy
 * product list and save (projected and refused per field), the cost settings
 * (per key: `minMarginPercent`, `printPricingConfig`, `printMaterials`), and the
 * legacy investment register under /invest/* (refused at a door). Its money
 * surfaces — manual wallet credit, provider test sends — stay with full and
 * NULL-scope admins. The money that moves inside an order change (a cancel
 * with refund) is refused per request; tests/communityMoneyScope.test.ts
 * classifies those handlers.
 */
import type { RouteClassFile } from './_types';
import { NB } from './_types';
import { adminRoutes } from '../../worker/routes/admin';

export default {
  family: 'admin',
  mounts: [
    {
      prefix: '/api/admin',
      name: 'adminRoutes',
      router: adminRoutes,
      writes: NB.ORDER_FLOW,
      routes: {
        'GET /providers': 'op',
        'GET /overview': 'op',
        'POST /telegram/test': { cls: 'op', noBody: 'sends a fixed test line to the admin group; answers delivery status only' },
        'POST /providers/test': { cls: 'money', refusal: { status: 403, code: 'SCOPE_FORBIDDEN' } },
        'GET /users': 'op',
        'GET /users/lookup': 'op',
        'GET /users/:id/detail': 'op',
        // Who may change whom: owner-only widening, investor status and promotion
        // rules (tests/userPatchPolicy.test.ts, tests/adminPromotionDefault.test.ts).
        'PATCH /users/:id': { cls: 'op', path: '/api/admin/users/u1', body: { membership_tier: 'plus' } },
        'GET /products': 'op',
        // The legacy save binds the cost only for the owner (leak L3).
        'POST /products': { cls: 'op', body: { id: 'p_a1', name: 'Bambu Lab A1', slug: 'a1', price_iqd: 910000 } },
        'DELETE /products/:id': { cls: 'op', noBody: 'removes a product row (refused while history holds it); answers ids only' },
        'GET /wallet-requests': 'op',
        // The deposit desk is an assistant duty (tests/communityMoneyScope.test.ts «desk»).
        'POST /wallet-requests/:id/decide': { cls: 'op', noBody: 'decides a customer wallet request; needs a pending request the role fixture does not seed' },
        'POST /wallet/credit': 'money',
        'GET /orders': 'op',
        'DELETE /orders/:id': 'op',
        'GET /orders/:id': 'op',
        'GET /orders/:id/stages': 'op',
        'GET /orders/:id/receipt': 'op',
        'GET /orders/:id/warranty-receipt': 'op',
        'GET /orders/:id/label': 'op',
        'GET /labels': 'op',
        'GET /delivery/config': 'op',
        'POST /delivery/statuses/refresh': 'op',
        'GET /delivery/statuses': 'op',
        'PUT /delivery/statuses/:remoteId': 'op',
        'POST /orders/:id/delivery': 'op',
        'POST /orders/:id/delivery/sync': 'op',
        'POST /delivery/sync': 'op',
        'POST /orders/sweep-stages': 'op',
        'POST /orders/:id/gini-receipt': 'op',
        'PATCH /orders/:id/stage': 'op',
        'PATCH /orders/:id': 'op',
        'GET /coupons': 'op',
        'POST /coupons': { cls: 'op', noBody: 'promo codes (a discount rule); no cost column is read' },
        'PATCH /coupons/:id': { cls: 'op', noBody: 'promo codes (a discount rule); no cost column is read' },
        'DELETE /coupons/:id': { cls: 'op', noBody: 'promo codes (a discount rule); no cost column is read' },
        'GET /settings': 'op',
        'GET /site-media': 'op',
        'POST /site-media/:slot': { cls: 'op', noBody: NB.MEDIA },
        'DELETE /site-media/:slot': { cls: 'op', noBody: NB.MEDIA },
        // Mixed by KEY: the cost keys are the owner's (403 COST_ACCESS_DENIED to
        // anyone else, tests/costLeaksPhase0.test.ts L6), the money keys need
        // money scope, the rest are every admin's. The sweep writes a cost key.
        'PUT /settings/:key': { cls: 'op', path: '/api/admin/settings/minMarginPercent', body: { value: 17 } },
        'GET /warranty-claims': 'op',
        'PATCH /warranty-claims/:id': { cls: 'op', noBody: 'warranty claim status and notes; no cost column is read' },
        'GET /invest/users': 'cost_read',
        'GET /invest/users/:userId': 'cost_read',
        'POST /invest/users/:userId/investments': 'cost_write',
        'PATCH /invest/investments/:id': 'cost_write',
        'DELETE /invest/investments/:id': 'cost_write',
        'POST /invest/investments/:id/items': 'cost_write',
        'DELETE /invest/items/:id': 'cost_write',
        'POST /invest/users/:userId/messages': 'cost_write',
        'GET /blocked-terms': 'op',
        'POST /blocked-terms': { cls: 'op', noBody: NB.MODERATION },
        'DELETE /blocked-terms/:term': { cls: 'op', noBody: NB.MODERATION },
      },
    },
  ],
} satisfies RouteClassFile;
