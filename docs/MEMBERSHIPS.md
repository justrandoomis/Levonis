# Memberships, entitlements and the two referral programs

Source of truth: `membership_plans` + `memberships` tables (migration 0002),
resolved by `worker/lib/entitlements.ts` (`getTierStatus`). The legacy
`users.subscription_*` columns are a read cache kept in sync by
`getTierStatus` — every enforcement path reads the ledger, never the browser
and never request fields.

## Plans

| Plan | Duration | Price | Purchasable |
| --- | --- | --- | --- |
| PLUS 1/3/6/12 mo | 1/3/6/12 months | **unpriced** (owner schedule pending — DECISIONS #4) | No — honest "price to be announced" |
| PRO 12 mo | 12 months | 499,000 IQD | Yes |

Prices are data (`PATCH /api/memberships/admin/plans/:id`); an unpriced plan
can never be purchased. The old hardcoded PRO 6mo/1yr prices were removed —
the mandate defines a single PRO 12-month plan.

## Lifecycle & launch (mandate §8.1)

States: `pending_payment → prepaid_pending_launch | active → expired`,
plus `cancelled`. While `launchConfig.activated` is false, a paid purchase
becomes **prepaid_pending_launch**: full duration reserved, clock NOT
started, honest UI ("card reserved — activates at launch"). Launch
activation is an explicit, audited, idempotent admin action
(`POST /api/memberships/admin/activate-launch` with confirm text) that
starts every prepaid membership at the activation timestamp. Expiry is
calendar months (month-end clamped), stored as ISO UTC, displayed in the
viewer's locale. No proration is invented beyond the pre-existing
PLUS→PRO upgrade credit; no auto-renewal exists (needs explicit consent and
a supported payment flow — not implemented by design).

Purchases are idempotent (deterministic membership id from user +
idempotency key; deterministic wallet-transaction ids), atomic with the
wallet charge (conditional-insert batch), and preserved through migration
(existing paid time became `migrated` active rows).

## Entitlements (server-enforced)

| Benefit | Tier | Enforcement point |
| --- | --- | --- |
| Product discounts (explicit PRO prices / policy) | PRO | price resolver |
| Free last-mile delivery | PRO | checkout (delivery=0 + `delivery_waived`) |
| No preorder commission | PRO | price resolver (`transport.waived`) |
| Merchant profile (community store) | PLUS+PRO | store creation gate (existing stores grandfathered) |
| Exclusive sections / offers / coupons / PRO products | per config | coupon validation + (offers/products: configuration-gated) |
| Priority service | PRO | `orders.priority` flag + admin visibility |
| Verified merchant + advertising | PRO | eligibility precondition; admin verification remains a moderation act |
| BNPL | PRO | **disabled** — ledger structure only (DECISIONS #10) |
| 12-hour priority delivery promise | PRO | **not advertised** — flag exists, SLA wording pending (DECISIONS #9) |
| Custom-domain storefront | PLUS | **not built** — requires Cloudflare for SaaS cost approval (DECISIONS #12) |

Marketing copy in the UI marks unimplemented benefits "قريبًا" — nothing is
presented as live before it is.

## Referral programs (mandate §9)

Distinct campaigns with separate attribution and rewards; both use
persistent per-user codes (`referral_codes`), attribution
`UNIQUE(referred_id, campaign)`, and rewards `UNIQUE(campaign, source_ref)`
so retries/status replays can never double-award. Self-referrals rejected.

**9.1 Printer referral** — referred friend's qualifying printer purchase
(printer = product in a catalog flagged `is_printer_catalog`, never name
matching): the friend's qualifying order gets free delivery at checkout
(`referralFreeDeliveryApplies`); the referrer's reward row is created when
the order is marked **delivered** (admin action records `delivered_at`),
with `eligible_at = delivered_at + 7 days`. Rewards lazily promote
pending→qualified after `eligible_at` on read (no browser timers, no lost
scheduled jobs). Order cancellation cancels pending/qualified rewards.
Multiple different friends → multiple rewards; one reward per qualifying
order (multi-printer orders default to one pending admin review —
DECISIONS #11).

**9.2 New PRO subscriber referral** — a *new paid* PRO subscription through
the invitation creates a `qualified` reward keyed to the membership id
(renewals/self/unpaid never count; prepaid-at-launch activates once and
never re-awards, because the reward keys to the purchase membership id).
Membership cancellation cancels the reward.

Fulfilment is manual-admin for now: admin moves
qualified→available→reserved→fulfilled, choosing the actual spool
(`spool_product_id`, validated against live products) server-side — no fake
frontend randomness, no promising out-of-stock spools. Full audit trail.

## Administration

`/api/memberships/admin/*`: list memberships, edit plan prices, launch
activation, cancel+refund (idempotent deterministic refund tx), referral
review/fulfilment. All audited. Test-fixture accounts are demoted by the
staging workflow and can never satisfy entitlement checks in production.
