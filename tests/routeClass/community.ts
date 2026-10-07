/**
 * ROUTE CLASSIFICATION — Levo Community administration and the chat console
 * (owner decision 2, step S1; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * Moderation is every admin's (`op`); escrow, payouts, merchant finance,
 * reconciliation and the commission setting are MONEY (an assistant is
 * refused, a full admin is not — tests/communityMoneyScope.test.ts holds the
 * per-handler detail). No route here reads a product cost.
 */
import type { RouteClassFile } from './_types';
import { NB } from './_types';
import { adminChatRoutes } from '../../worker/routes/adminChats';
import { adminCommunityRoutes } from '../../worker/routes/adminCommunity';

export default {
  family: 'community',
  mounts: [
    {
      prefix: '/api/admin/community',
      name: 'adminCommunityRoutes',
      router: adminCommunityRoutes,
      writes: NB.MODERATION,
      routes: {
        'GET /overview': 'op',
        'GET /settings': 'op',
        'PATCH /settings': 'money',
        'GET /gate': 'op',
        'GET /gate/lookup': 'op',
        'PUT /gate': 'op',
        'GET /merchants': 'op',
        'POST /merchants/:id/verify': 'op',
        'POST /merchants/:id/status': 'op',
        'POST /merchants/:id/badge': 'op',
        'POST /stores/:id/status': 'op',
        'GET /merchants/:id/products': 'op',
        'POST /products/:id/hide': 'op',
        'POST /reviews/:id/hide': 'op',
        'POST /requests/:id/remove': 'op',
        'GET /requests': 'op',
        'GET /requests/:id': 'op',
        'POST /offers/:id/reject': 'op',
        'GET /reviews': 'op',
        'GET /merchants/:id/reputation': 'op',
        'POST /merchants/:id/reputation': 'op',
        'GET /complaints': 'op',
        'GET /complaints/:id': 'op',
        'POST /complaints/:id/status': 'op',
        'POST /complaints/:id/messages': 'op',
        'POST /escrows/:id/resolve': 'money',
        'GET /merchants/:id/finance': 'money',
        'GET /reconciliation/store-orders': 'money',
        'POST /reconciliation/store-orders/:id/refund': 'money',
        'POST /reconciliation/store-orders/:id/reverse-credit': 'money',
        'POST /merchants/:id/payout': 'money',
        'GET /payouts': 'money',
        'POST /payouts/:id/approve': 'money',
        'POST /payouts/:id/paid': 'money',
        'POST /payouts/:id/fail': 'money',
        'POST /merchants/:id/adjustment': 'money',
        'GET /ledger/parity': 'money',
        'GET /reports': 'op',
      },
    },
    {
      prefix: '/api/admin/chats',
      name: 'adminChatRoutes',
      router: adminChatRoutes,
      routes: {
        'GET /summary': 'op',
        'GET /': 'op',
      },
    },
  ],
} satisfies RouteClassFile;
