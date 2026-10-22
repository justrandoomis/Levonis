/**
 * ROUTE CLASSIFICATION — the routers mounted OUTSIDE /api/admin that carry
 * admin routes (wallet, memberships, telegram, invoices, devices and the
 * serial inventory, reviews, gifts, returns, price protection, policies, KYC,
 * support, referrals, and the misc router's /translate). DECISIONS row 220.
 *
 * tests/costRouteClassification.test.ts used to classify only the
 * `/api/admin…` mounts, so about 120 admin routes under another prefix had no
 * class and none of the COST / MONEY / OWNER proofs. Every route of each of
 * these routers is classified here — the customer routes `open`, the admin
 * routes by the guard they actually answer with:
 *   money  an assistant is refused at the guard, a full admin is not
 *          (wallet withdrawal fee and adjustment, BNPL, Telegram identities);
 *   op     any admin; whatever cost such a route touches is stripped for a
 *          non-owner (the role-matrix GET and write sweeps walk every answer
 *          over the rows tests/fixtures/roleMatrix.ts seedAuditRows adds).
 * No route of these routers answers a cost class today: none is behind
 * requireCostRead / requireCostWrite. A new admin route here needs a class
 * like any other (the test fails on an unclassified route).
 *
 * The writes carry no valid body: the empty body runs for every role and
 * every validation refusal is walked (`writes` below).
 */
import type { RouteClassFile } from './_types';
import { walletRoutes } from '../../worker/routes/wallet';
import { miscRoutes } from '../../worker/routes/misc';
import { membershipsRoutes } from '../../worker/routes/memberships';
import { telegramRoutes } from '../../worker/routes/telegram';
import { invoiceRoutes } from '../../worker/routes/invoices';
import { deviceRoutes } from '../../worker/routes/devices';
import { reviewRoutes } from '../../worker/routes/reviews';
import { legacyGiftRoutes, giftRoutes } from '../../worker/routes/gifts';
import { returnRoutes, priceProtectionRoutes } from '../../worker/routes/returns';
import { policiesRoutes } from '../../worker/routes/policies';
import { kycRoutes } from '../../worker/routes/kyc';
import { supportRoutes } from '../../worker/routes/support';
import { referralRoutes } from '../../worker/routes/referrals';

const WRITES =
  'customer and admin acts on wallets, memberships, devices, serials, gifts, reviews, returns, claims, KYC and support; the empty body walks every validation refusal';

export default {
  family: 'off-prefix',
  mounts: [
    {
      prefix: '/api/wallet',
      name: 'walletRoutes',
      router: walletRoutes,
      writes: WRITES,
      routes: {
        'GET /': 'open',
        'GET /policy': 'open',
        'POST /deposits': 'open',
        'POST /withdrawals': 'open',
        'GET /withdrawals': 'open',
        'POST /withdrawals/:id/cancel': 'open',
        'POST /transactions/:id/review-request': 'open',
        'GET /review-requests': 'open',
        'GET /admin/reconciliation': 'op',
        'GET /admin/withdrawal-fee': 'op',
        'PUT /admin/withdrawal-fee': 'money',
        'GET /admin/withdrawals': 'op',
        'POST /admin/withdrawals/:id/approve': 'op',
        'POST /admin/withdrawals/:id/processing': 'op',
        'POST /admin/withdrawals/:id/paid': 'op',
        'POST /admin/withdrawals/:id/reject': 'op',
        'POST /admin/withdrawals/:id/fail': 'op',
        'POST /admin/withdrawals/:id/reconcile': 'op',
        'POST /admin/withdrawals/:id/reconcile/clear': 'op',
        'GET /admin/deposits/declared': 'op',
        'POST /admin/deposits/:id/observe': 'op',
        'POST /admin/deposits/:id/approve': 'op',
        'POST /admin/deposits/:id/reject': 'op',
        'POST /admin/transactions/:id/adjustment': 'money',
        'GET /admin/review-requests': 'op',
        'POST /admin/review-requests/:id/close': 'op',
      },
    },
    {
      prefix: '/api',
      name: 'miscRoutes',
      router: miscRoutes,
      writes: WRITES,
      routes: {
        'GET /health': 'open',
        'GET /settings/public': 'open',
        'POST /translate': 'op',
      },
    },
    {
      prefix: '/api/memberships',
      name: 'membershipsRoutes',
      router: membershipsRoutes,
      writes: WRITES,
      routes: {
        'GET /plans': 'open',
        'GET /quote': 'open',
        'GET /mine': 'open',
        'GET /entitlements': 'open',
        'GET /bnpl': 'open',
        'POST /bnpl/request': 'open',
        'POST /bnpl/repay': 'open',
        'POST /subscribe': 'open',
        'POST /referral/enter': 'open',
        'PUT /admin/bnpl/:userId': { cls: 'money', refusal: { status: 403, code: 'FORBIDDEN' } },
        'GET /admin/list': 'op',
        'GET /admin/plans': 'op',
        'PATCH /admin/plans/:id': 'op',
        'POST /admin/pro-pause': 'op',
        'POST /admin/activate-launch': 'op',
        'POST /admin/grant': 'op',
        'POST /admin/:id/cancel': 'op',
        'GET /admin/referrals': 'op',
        'PATCH /admin/referrals/:id': 'op',
      },
    },
    {
      prefix: '/api/telegram',
      name: 'telegramRoutes',
      router: telegramRoutes,
      writes: WRITES,
      routes: {
        'POST /link/start': 'open',
        'GET /link/status': 'open',
        'POST /link/confirm': 'open',
        'POST /otp/verify': 'open',
        'POST /webhook': 'open',
        'POST /admin/set-webhook': 'op',
        'GET /admin/webhook-info': 'op',
        'GET /admin/tg-identities': { cls: 'money', refusal: { status: 403, code: 'FORBIDDEN' } },
        'POST /admin/tg-identities': { cls: 'money', refusal: { status: 403, code: 'FORBIDDEN' } },
        'POST /admin/tg-identities/:telegramUserId/revoke': { cls: 'money', refusal: { status: 403, code: 'FORBIDDEN' } },
        'GET /admin/wallet-notifications': 'op',
        'POST /admin/wallet-notifications/:id/retry': 'op',
        'POST /ops/webhook': 'open',
        'GET /admin/bot-status': 'op',
        'POST /admin/set-admin-webhook': 'op',
        'GET /admin/admin-webhook-info': 'op',
        'POST /admin/group/reset': 'op',
      },
    },
    {
      prefix: '/api/invoices',
      name: 'invoiceRoutes',
      router: invoiceRoutes,
      writes: WRITES,
      routes: {
        'GET /mine': 'open',
        'GET /:id': 'open',
        'GET /:id/html': 'open',
        'POST /:id/revise': 'op',
        'POST /:id/resend': 'op',
      },
    },
    {
      prefix: '/api/devices',
      name: 'deviceRoutes',
      router: deviceRoutes,
      writes: WRITES,
      routes: {
        'GET /admin/serial-inventory': 'op',
        'GET /admin/serial-inventory/export': 'op',
        'POST /admin/serial-inventory/preview': 'op',
        'POST /admin/serial-inventory/commit': 'op',
        'POST /admin/serial-inventory/scan': 'op',
        'POST /admin/serial-inventory/link-ean': 'op',
        'GET /admin/serial-inventory/resolve': 'op',
        'GET /admin/serial-inventory/variants': 'op',
        'GET /admin/serial-inventory/:serial': 'op',
        'POST /admin/serial-inventory/:serial/warranty-mode': 'op',
        'PATCH /admin/serial-inventory/:serial': 'op',
        'POST /admin/serial-inventory/:serial/void': 'op',
        'POST /admin/serial-inventory/:serial/restore': 'op',
        'GET /mine': 'open',
        'GET /eligible': 'open',
        'POST /register': 'open',
        'POST /units/:unitId/register': 'open',
        'DELETE /units/:unitId/registration': 'open',
        'GET /claims': 'open',
        'GET /claims/:id': 'open',
        'POST /units/:unitId/claims': 'open',
        'POST /claims/:id/messages': 'open',
        'POST /claims/upload': 'open',
        'GET /claim-files/*': 'open',
        'GET /admin/orders/:orderId/units': 'op',
        'GET /admin/units': 'op',
        'GET /admin/units/:unitId/history': 'op',
        'POST /admin/units/:unitId/unregister': 'op',
        'POST /admin/orders/:orderId/units/backfill': 'op',
        'POST /admin/units/backfill-delivered': 'op',
        'POST /admin/units/:unitId/serial': 'op',
        'PATCH /admin/units/:unitId/delivery': {
          cls: 'op',
          why: 'a correction that shortens or keeps the window is any admin’s; a LATER date is the owner’s, judged in the handler once the unit is read (owner decision 3, G-2)',
        },
        'PATCH /admin/units/:unitId/warranty': {
          cls: 'op',
          why: 'shortening keeps confirm_shorter; LENGTHENING is the owner’s, judged in the handler once the unit is read (owner decision 3, G-1)',
        },
        // A whole-unit replacement is the owner's act alone (owner decision 3, row 223).
        'POST /admin/units/:unitId/replace': 'owner',
        'GET /admin/claims': 'op',
        'PATCH /admin/claims/:id': {
          cls: 'op',
          why: 'receiving, diagnosing, repairing and closing are any admin’s; a DECISION (approved, rejected, replaced, or a changed decision) needs the financial scope, judged in the handler once the claim is read (owner decision 3)',
        },
        'POST /admin/products/:id/ops-policy': 'op',
      },
    },
    {
      prefix: '/api/reviews',
      name: 'reviewRoutes',
      router: reviewRoutes,
      writes: WRITES,
      routes: {
        'POST /': 'open',
        'PUT /:id': 'open',
        'GET /mine': 'open',
        'GET /eligibility/:productId': 'open',
        'GET /order/:orderId': 'open',
        'GET /product/:idOrSlug': 'open',
        'POST /uploads': 'open',
        'GET /media/*': 'open',
        'GET /admin/queue': 'op',
        'POST /admin/:id/moderate': 'op',
        // Declining or asking for changes is any admin's; APPROVING pays and is
        // judged in the handler once the action is read (moneyAuthority review_reward).
        'POST /admin/:id/reward': { cls: 'op', why: 'approve is a money act judged in the handler (review_reward); reject and request_changes stay with every admin' },
      },
    },
    {
      prefix: '/api/reviews',
      name: 'legacyGiftRoutes',
      router: legacyGiftRoutes,
      writes: WRITES,
      routes: {
        'GET /gifts': 'open',
        'POST /gifts/:entitlementId/redeem': 'open',
        'GET /admin/gifts': 'op',
        'POST /admin/gifts/:id/fulfill': 'op',
        'POST /admin/gifts/:id/cancel': 'op',
        'GET /admin/pools': 'op',
        'POST /admin/pools': 'op',
        'PUT /admin/pools/:itemId': 'op',
        'DELETE /admin/pools/:itemId': 'op',
      },
    },
    {
      prefix: '/api/gifts',
      name: 'giftRoutes',
      router: giftRoutes,
      writes: WRITES,
      routes: {
        'GET /': 'open',
        'POST /:id/choose': 'open',
        'POST /:id/redeem': 'open',
        'GET /admin/levels': 'op',
        'PUT /admin/levels/:n': 'op',
        'GET /admin/products/:id/options': 'op',
        // What a level holds is what every level gift may become (decision 3).
        'POST /admin/levels/:n/items': 'money',
        'PUT /admin/items/:id': 'money',
        'DELETE /admin/items/:id': 'op',
        'GET /admin/users': 'op',
        'GET /admin/grants': 'op',
        'GET /admin/grants/:id': 'op',
        'GET /admin/grants/:id/audit': 'op',
        'POST /admin/grants': 'money',
        // The note is any admin's; changing WHY a gift was given is judged in the handler (gift_grant).
        'PATCH /admin/grants/:id': { cls: 'op', why: 'a reason change is a money act judged in the handler (gift_grant); the internal note stays with every admin' },
        'POST /admin/grants/:id/cancel': 'op',
        'POST /admin/grants/:id/convert': 'money',
        'POST /admin/grants/:id/fulfill': 'op',
      },
    },
    {
      prefix: '/api/returns',
      name: 'returnRoutes',
      router: returnRoutes,
      writes: WRITES,
      routes: {
        'POST /': 'open',
        'GET /': 'open',
        'GET /admin/queue': 'op',
        'POST /admin/:id/transition': {
          cls: 'op',
          why: 'collection and inspection moves are any admin’s; resolving with a REFUND needs the financial scope, judged in the handler (owner decision 3, PP-B1)',
        },
        'GET /:id': 'open',
      },
    },
    {
      prefix: '/api/price-protection',
      name: 'priceProtectionRoutes',
      router: priceProtectionRoutes,
      writes: WRITES,
      routes: {
        'POST /claims': 'open',
        'GET /claims': 'open',
        'GET /admin/claims': 'op',
        // The queue's detail sheet: the claim, its price rows and what approving would credit — read-only.
        'GET /admin/claims/:id': 'op',
        // Approving credits a wallet; rejecting ends the claim (owner decision 3, PP-B1). Above the
        // owner line, or for the author of the price that made the drop, the owner decides (handler).
        'POST /admin/claims/:id/decide': 'money',
      },
    },
    {
      prefix: '/api/policies',
      name: 'policiesRoutes',
      router: policiesRoutes,
      writes: WRITES,
      routes: {
        'GET /': 'open',
        'GET /:key': 'open',
        'GET /admin/list': 'op',
      },
    },
    {
      prefix: '/api/kyc',
      name: 'kycRoutes',
      router: kycRoutes,
      writes: WRITES,
      routes: {
        'POST /upload': 'open',
        'GET /mine': 'open',
        'POST /submit': 'open',
        'POST /address-request': 'open',
        'POST /address-self-approve': 'open',
        'GET /approved-address': 'open',
        'POST /phone-change-request': 'open',
        // The KYC desk (DECISIONS row 261): owner and full admins, an assistant only with the owner's
        // KYC_REVIEW grant (403 KYC_REVIEW_FORBIDDEN) — tests/adminScopeKycDisputes.test.ts.
        'GET /admin/queue': 'op',
        'GET /admin/cases/:id': 'op',
        'GET /admin/cases/:id/evidence/:idx': 'op',
        'POST /admin/cases/:id/decision': 'op',
        'GET /admin/address-queue': 'op',
        'POST /admin/address/:id/decision': 'op',
      },
    },
    {
      prefix: '/api/support',
      name: 'supportRoutes',
      router: supportRoutes,
      writes: WRITES,
      routes: {
        'POST /assistant': 'open',
        // Push B (worker/routes/assistAi.ts): readiness is public; a read needs the customer's own
        // session and their own attachment (tests/aiReadRoutes.test.ts), never an admin.
        'GET /assistant/readiness': 'open',
        'POST /assistant/read': 'open',
        'POST /assistant/read-frames': 'open',
        'GET /tickets': 'open',
        'POST /tickets': 'open',
        'GET /tickets/:id': 'open',
        'POST /tickets/:id/messages': 'open',
        'GET /admin/tickets': 'op',
        'GET /admin/tickets/:id': 'op',
        'POST /admin/tickets/:id/messages': 'op',
        'PATCH /admin/tickets/:id': 'op',
        'GET /admin/members': 'op',
        'GET /admin/members/:userId': 'op',
        'POST /admin/members/:userId/restrictions': 'op',
        'PATCH /admin/restrictions/:id': 'op',
      },
    },
    {
      prefix: '/api/referrals',
      name: 'referralRoutes',
      router: referralRoutes,
      writes: WRITES,
      routes: {
        'GET /me': 'open',
        'GET /support/resolve': 'open',
        'GET /support/link': 'open',
        'GET /admin/gifts': 'op',
        'PATCH /admin/gifts/:id': 'op',
        'POST /admin/gifts/evaluate': 'op',
        'POST /admin/gifts/reconcile': 'op',
      },
    },
  ],
} satisfies RouteClassFile;
