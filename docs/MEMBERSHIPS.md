# Memberships, entitlements and the two referral programs

Source of truth: `membership_plans` + `memberships` tables (migration 0002,
rebuilt in 0018, one-active index and credit columns in 0052), resolved by
`worker/lib/entitlements.ts` (`getTierStatus`). The legacy
`users.subscription_*` columns are a read cache kept in sync by
`getTierStatus` — every enforcement path reads the ledger, never the browser
and never request fields.

## Plans

Seeded by migrations 0002 / 0018 / 0030; the DATABASE stays authoritative
(`GET /api/memberships/plans` lists the active rows, the purchase path
re-reads the row). All six are active today:

| Plan id | Tier | Duration | Price | Purchasable |
| --- | --- | --- | --- | --- |
| `plus_1mo` | PLUS | 1 month | 4,500 IQD | Yes |
| `plus_3mo` | PLUS | 3 months | 10,000 IQD | Yes |
| `plus_6mo` | PLUS | 6 months | 17,000 IQD | Yes |
| `plus_12mo` | PLUS | 12 months | 29,000 IQD | Yes |
| `prime_12mo` | PRIME | 12 months | 99,000 IQD | Yes |
| `pro_12mo` | PRO | 12 months | 499,000 IQD | Yes |

Prices are data. `price_iqd = NULL` means UNPRICED: the storefront shows
"price to be announced" and `subscribeUser` refuses with `PLAN_UNPRICED`.
The admin edits prices and the active flag from **Admin → Memberships →
Plans & launch** (`GET /api/memberships/admin/plans`,
`PATCH /api/memberships/admin/plans/:id` with `{price_iqd: int|null,
active: bool}`); an empty price field in that panel means unpriced.

`GET /api/memberships/plans` also returns `per_month_iqd` on every plan
(`Math.round(price_iqd / duration_months)`, null while unpriced) — the cards
and the "best value" badge read it, so no figure is worked out in the
browser — and:

- `features.printer_gift` — `printerGiftConfig.enabled` AND its `plan_id`
  exists; `features.preorder_gift` — `preorderGiftConfig.enabled` AND a
  `product_id` is set. The /subscription page lists those two gifts ONLY
  when the flag is true, so a switched-off gift is never advertised.
- `delivery.pro_threshold_iqd` / `delivery.prime_threshold_iqd` from the
  `shippingPolicy` setting (defaults 75,000 / 150,000), so the benefit copy
  quotes the same numbers the quote engine applies.

## Lifecycle & launch (mandate §8.1)

States: `pending_payment → prepaid_pending_launch | active → expired`,
plus `cancelled`. While `launchConfig.activated` is false, a paid purchase
becomes **prepaid_pending_launch**: full duration reserved, clock NOT
started, honest UI ("card reserved — activates at launch"). Launch
activation is an explicit, audited, idempotent admin action
(`POST /api/memberships/admin/activate-launch` with `{confirm:"ACTIVATE"}`,
reachable from the Plans & launch panel, which asks for the word to be
typed in an in-app window) that starts every prepaid membership at the
activation timestamp. Expiry is calendar months (month-end clamped),
stored as ISO UTC, displayed in the viewer's locale. No auto-renewal exists
(needs explicit consent and a supported payment flow — not implemented by
design).

### One membership at a time (`quotePurchase` / `subscribeUser`)

| Account holds | Buys | Result |
| --- | --- | --- |
| same tier, active | same tier | `ALREADY_SUBSCRIBED` — renew when it expires |
| higher tier, active | lower tier | `DOWNGRADE_BLOCKED` (PRO→PRIME, PRO→PLUS, PRIME→PLUS) |
| lower tier, active | higher tier | **upgrade**: credit = unused fraction of the old row's **credit basis** (remaining days ÷ total days, floored, capped at the new price); the old row is `cancelled`; PLUS→PRIME, PLUS→PRO, PRIME→PRO alike. Post-launch only — the credit needs "remaining days" to exist |
| same tier, prepaid | same tier | `ALREADY_PREPAID` |
| higher tier, prepaid | lower tier | `DOWNGRADE_BLOCKED` |
| lower tier, prepaid | higher tier | **replaced**: nothing has started, so the reservation's whole credit basis (100%) is credited and the lower row is `cancelled` in the same batch — one reservation per account, never two waiting for the launch |

**Enforced by the database, not only by the read.** Migration 0052 adds the
partial unique index `idx_memberships_one_active ON memberships(user_id)
WHERE state = 'active'`, after cancelling any legacy duplicates (per account
the active row with the latest `expires_at` stays; tie → latest
`created_at`). Every writer of a live row (`subscribeUser`, the admin grant,
the printer gift) inserts through a statement whose `state` becomes
`'conflict'` — refused by the CHECK — when the account already holds ANY
live row (active or prepaid) at the instant of writing, so two purchases
fired together cannot both pass the quote's SELECT and both commit: the
batch that loses rolls back with its wallet spend and answers
**409 `ALREADY_SUBSCRIBED`**. `subscribeUser` cancels the rows the quote
ends BEFORE inserting the new one, each conditional on the state the quote
read.

**Credit basis (migration 0052).** `price_paid_iqd` is what was CHARGED
(after any credit) and stays what a refund uses. `credit_basis_iqd` is what
the row is worth to a later proration — charge + credit applied, i.e. the
plan price for a purchase; `0` for admin grants and gifts; `NULL` on rows
older than the migration, which fall back to `price_paid_iqd`.
`credit_applied_iqd` records the credit the purchase consumed, so a replayed
confirmation reports the same `credit_iqd` (and the wallet debit) as the
first. Without the basis, PLUS 29,000 → PRIME 99,000 → PRO 199,000 on one
day charged 29,000 + 70,000 + 129,000 = 228,000; it now charges
29,000 + 70,000 + 100,000 = 199,000.

`GET /api/memberships/quote?planId=` runs the same code without writing and
returns the exact charge (`price_iqd`, `credit_iqd`, `charge_iqd`,
`charge_usd_cents` at the current `exchangeRate`), the spendable
`balance_usd_cents`, the `shortfall_usd_cents`, `activate_now`,
`expires_at` (preview) and `upgrade_from_tier` (the active row OR the
reservation this purchase ends); refusals come back as `{ok:false, code,
message}`. An inactive plan is **404** — the quote never carries the price of
a plan `GET /plans` hides. `pending_tiers` is still emitted, always empty,
for pages loaded before the one-reservation rule. The confirmation window on
/subscription shows this quote and nothing computed in the browser.

**The confirmation carries the figures it displayed.** `POST /subscribe`
accepts `charge_iqd` and `charge_usd_cents`; `subscribeUser` recomputes the
quote and, when either differs (a day boundary moved the remaining days, the
exchange rate changed), refuses with **409 `QUOTE_CHANGED`** and
`details.quote` = the fresh quote, writing nothing. The page shows the new
figures with a one-line notice (ar/en/ckb) and asks again — same attempt,
same key. A client that sends no figures (older pages) is charged the
recomputed quote as before; half-sent figures are 400.

Purchases are idempotent (deterministic membership id from user +
idempotency key; deterministic wallet-transaction ids), atomic with the
wallet charge (conditional-insert batch), and preserved through migration
(existing paid time became `migrated` active rows). The page generates ONE
idempotency key per confirmed attempt and reuses it only for a retry of that
attempt.

## Entitlements (server-enforced)

What /subscription promises is exactly this table — nothing without an
enforcement point is listed as live.

| Benefit | Tier | Enforcement point |
| --- | --- | --- |
| Storefront with its own subdomain, dashboard, orders, community offers, analytics, merchant profile | PLUS + PRO | `benefits.merchant*` / `communityOffers` / `merchantProfile` (merchant.ts, merchantAuth.ts, community.ts, marketplace.ts) |
| Bundles section | PLUS + PRIME + PRO | `benefits.exclusiveSections` (bundles.ts) |
| Tier-required coupons | PLUS / PRIME / PRO | `validateCoupon`: `benefits.exclusiveCoupons` AND `pricing.TIER_RANK` ladder (pro > prime > plus) |
| Free PLUS gift on a printer purchase | — | `grantPrinterGiftIfEligible`, only while `printerGiftConfig.enabled`; advertised only when `features.printer_gift` — and as "how to get PLUS free" under the PLUS card, not as a PLUS benefit. An account already holding a live membership receives no second row: the skip is audited (`membership.gift_skipped`) for an admin to comp by hand |
| PRIME prices where a product states one | PRIME | price resolver |
| Free ordinary delivery strictly above `prime_threshold_iqd` after coupons and points | PRIME | shipping.ts `primeDeliveryEligible` |
| PRO prices where a product states one | PRO (approved default address) | price resolver, orders.ts `proContext` |
| Free standard + protected delivery strictly above `pro_threshold_iqd` | PRO (approved default address) | shipping.ts `freeDelivery` |
| No shipping-type surcharge (pre-order commission; direct-sale premium) | PRO (approved default address) | pricing.ts `noPreorderCommission` |
| Priority service on warranty claims and support | PRO | devices.ts, support.ts `priorityService` |
| Double daily check-in points | PRO | rewards.ts `checkinPoints` |
| Referral reward when an invited friend buys PRO | PRO | `onProSubscriptionPurchased` |
| Free filament on a fully prepaid pre-order | PRO | `preorderGiftFor`, only while `preorderGiftConfig` is enabled with a product; advertised only when `features.preorder_gift` |
| Verified-merchant badge | PRO | community.ts `proVerifiedOwners`: `verified = admin flag OR active PRO with benefits.verifiedMerchant` on every merchant payload |
| BNPL | — | **disabled** — ledger structure only (DECISIONS #10); shown as "coming soon" |
| 12-hour delivery promise | — | **not built** — shown as "coming soon" (DECISIONS #9) |
| Custom-domain storefront | — | **not built** (DECISIONS #12); shown as "coming soon" |

Removed from the page as having no code behind them: daily game tickets
(×1 / ×5), "PRO-only products and offers" (`benefits.proExclusive` is
defined but nothing reads it), "advertising eligibility", the "special
offers / random filament" sections, and the "tangible physical card /
3D-printable Levo ID" block.

An active restriction case (support.ts) pauses individual benefit flags;
`GET /api/memberships/mine` returns them as `status.gated_benefits` and the
page shows them to the member under "Paused benefits".

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

`/api/memberships/admin/*`: list memberships, list/edit plans (price and
active flag), launch activation, grant without payment, cancel+refund
(idempotent deterministic refund tx), referral review/fulfilment. All
audited. The surface is mounted under `/api/memberships`, outside the
`/api/admin/*` host guard in `worker/index.ts`, so it carries its own
`requireMainHost` before `requireAdmin` (as `devices.ts` does): a merchant
subdomain answers **404** even to a visiting admin's cookie.

- **Grant** refuses (409 `ALREADY_SUBSCRIBED` / `ALREADY_PREPAID`, with the
  live row in `details`) while the account holds any live membership —
  cancel it first, then grant; a replay of an earlier grant key stays a
  replay. Grants carry `credit_basis_iqd = 0`.
- **Launch activation** honours one-active-per-account on legacy data: an
  account with several reservations activates the highest tier (tie: the
  latest purchase) and the rest are cancelled; a running row of a lower or
  equal tier is superseded (cancelled) by the reservation; a reservation
  LOWER than a running higher membership stays pending and is written to the
  audit log (`membership.launch_activation_deferred`) for a human to refund
  or cancel. Every deviation from a plain prepaid → active flip is audited
  (`membership.launch_dedupe`); the response reports `converted` and
  `deferred`. The admin UI is `src/components/AdminMemberships.tsx` (Admin →
Memberships): **Members** (search, detail, restrictions, grant), **Support
queue**, and **Plans & launch** (price editor, active toggle, launch state
and the typed-`ACTIVATE` activation window). Test-fixture accounts are
demoted by the staging workflow and can never satisfy entitlement checks in
production.
