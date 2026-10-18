/**
 * ROUTE CLASSIFICATION — «طلبات اعتماد التجار», the reviewer's side of the
 * merchant application (Community V3 push 1.2, DECISIONS row 257; the
 * vocabulary is in ./_types.ts, the test is tests/costRouteClassification.test.ts).
 *
 * The reviewer routes are `op`: no cost, price, wallet, escrow or payout is
 * read or answered, and the door is the reviewer scope (owner, full admin, or
 * an assistant holding MERCHANT_REVIEW — tests/merchantReview.test.ts holds the
 * matrix), which grants nothing financial. Issuing and revoking that grant is
 * the OWNER's act alone (`requireOwner`).
 */
import type { RouteClassFile } from './_types';
import { NB } from './_types';
import { adminMerchantApplicationRoutes } from '../../worker/routes/adminMerchantApplications';

const DECISION =
  'one guarded transition of a merchant application (state, revision, the public reason and the internal note); no cost, price or money column is read or answered, and the sweep has no application in a state it can move';

export default {
  family: 'merchantReview',
  mounts: [
    {
      prefix: '/api/admin/merchant-applications',
      name: 'adminMerchantApplicationRoutes',
      router: adminMerchantApplicationRoutes,
      routes: {
        'GET /': 'op',
        'GET /reviewers': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' } },
        'POST /reviewers/:userId/grant': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' }, why: NB.OWNER_ACT },
        'POST /reviewers/:userId/revoke': { cls: 'owner', refusal: { status: 403, code: 'OWNER_ONLY' }, why: NB.OWNER_ACT },
        'GET /:id': 'op',
        'GET /:id/photo': 'op',
        'POST /:id/start-review': { cls: 'op', noBody: DECISION },
        'POST /:id/request-changes': { cls: 'op', noBody: DECISION },
        'POST /:id/approve': { cls: 'op', noBody: DECISION },
        'POST /:id/reject': { cls: 'op', noBody: DECISION },
      },
    },
  ],
} satisfies RouteClassFile;
