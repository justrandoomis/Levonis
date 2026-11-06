/**
 * ROUTE CLASSIFICATION — Admin → Rewards (migration 0220; docs/DECISIONS.md
 * row 286; the vocabulary is in ./_types.ts, the test is
 * tests/costRouteClassification.test.ts).
 *
 * The programme's TERMS and PUBLISHING a competition decide what the shop gives
 * every customer: the owner's (worker/lib/moneyAuthority.ts 'coupon_issue',
 * DECISIONS rows 223 #3 and 228). Extending one customer's coupon and paying a
 * competition's prizes give value to a person: `money` ('gift_grant').
 * Withdrawing a coupon, cancelling a competition (every entry fee comes back)
 * and writing a draft give nothing away: `op`. No route here reads a cost.
 */
import type { RouteClassFile } from './_types';
import { adminRewardsRoutes } from '../../worker/routes/adminRewards';

export default {
  family: 'rewards',
  mounts: [
    {
      prefix: '/api/admin/rewards',
      name: 'adminRewardsRoutes',
      router: adminRewardsRoutes,
      routes: {
        // The terms, the FDM filaments the owner may tick, and counts of coupons issued and used — no cost.
        'GET /config': 'op',
        'PUT /config': 'owner',
        'GET /grants': 'op',
        'POST /grants/:id/revoke': { cls: 'op', noBody: 'withdraws one unused reward coupon by id; needs a grant the role fixture does not seed' },
        'POST /grants/:id/extend': 'money',
        'GET /competitions': 'op',
        'POST /competitions': {
          cls: 'op',
          body: { title_ar: 'مسابقة أفضل طبعة', starts_at: '2030-01-01T00:00:00.000Z', ends_at: '2030-01-31T00:00:00.000Z' },
          why: 'a DRAFT, invisible to customers until the owner publishes it',
        },
        'PUT /competitions/:id': { cls: 'op', noBody: 'edits one draft by id; needs a draft the role fixture does not seed' },
        'POST /competitions/:id/publish': 'owner',
        'POST /competitions/:id/cancel': { cls: 'op', noBody: 'cancels one competition by id and refunds its entry fees; needs a competition the role fixture does not seed' },
        'GET /competitions/:id/entries': 'op',
        'POST /competitions/:id/entries/:entryId/disqualify': { cls: 'op', noBody: 'refuses one entry by id; needs an entry the role fixture does not seed' },
        'POST /competitions/:id/finish': 'money',
        // 0227 — the points mission's video ads: what every customer is shown and paid for is the owner's act.
        'GET /ads': 'op',
        'POST /ads': 'owner',
        'PUT /ads/:id': 'owner',
        'POST /ads/:id/toggle': {
          cls: 'op',
          noBody: 'switches one ad by id, with no cost in reach; switching OFF is any admin, switching ON refuses all but the owner inside the handler (tests/rewardAds.test.ts); needs an ad the role fixture does not seed',
        },
      },
    },
  ],
} satisfies RouteClassFile;
