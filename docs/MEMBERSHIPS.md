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

- `features.preorder_gift` — `preorderGiftConfig.enabled` AND a
  `product_id` is set; the comparison lists the gift ONLY when it is true.
  `features.printer_gift` is always `false`: the PLUS-with-a-printer gift is
  granted by hand now (`grantPrinterGiftIfEligible` has no caller), so the
  card does not advertise it. The key stays for pages loaded before.
- `delivery.pro_threshold_iqd` / `delivery.prime_threshold_iqd` from the
  `shippingPolicy` setting (defaults 75,000 / 150,000).
- `benefits` — `publicBenefitSummary` (worker/lib/membershipBenefits.ts): the
  live `membership_benefit_rules`, per tier. A discount is stated ON ITS
  SECTION, never per product — per-product rules are grouped by the section
  their product is filed under and by the offer they make, and published as
  one line with the section's name and `product_count`; no product name
  leaves the server, and the read is one join with no bound parameters (D1
  refuses more than 100). The delivery and tax lines are chosen by the
  checkout's own `selectRule`. The page phrases them in the owner's template:
  «خصم 10% حتى 100,000 د.ع لكل وحدة على الطابعات».
- `entitlement_contract.tiers` — ENTITLEMENT_MINIMUM_TIER resolved for each
  tier; the comparison's ticks are read from here.
- `points_multiplier_x100` — `dailyRewardMultiplierX100` per tier (PLUS 100,
  PREMIUM 150, PRO 200).

## Lifecycle & launch (mandate §8.1)

States: `pending_payment → active → expired`, plus `cancelled`, and the
legacy `prepaid_pending_launch`.

**The site is live, so a purchase starts at once.** `launchConfig.activated`
still gates every writer (`quotePurchase`, the admin grant, the printer gift),
but the gate is open: the code default is `activated: true`
(`DEFAULT_LAUNCH`, worker/lib/entitlements.ts, and `SETTING_DEFAULTS`), and
migration 0109 writes the stored row as activated on every database that had
not been — keeping any `launch_at` / `activated_at` it already carried. A
purchase is `active` with `starts_at = now` and `expires_at =
addMonths(now, duration)`. No customer screen mentions a launch; the quote's
`activate_now` is always true.

**Reservations left from before are converted without an admin.** A
`prepaid_pending_launch` row still waiting is converted the first time its
account is read (`getTierStatus` → `convertLaunchReservations`,
worker/lib/launchActivation.ts), with the same per-account dedupe the admin
sweep uses: the highest tier wins (tie: the latest purchase), the other
reservations are cancelled, a running row of a lower or equal tier is
superseded; a reservation LOWER than a running higher membership stays
waiting for a human. The clock starts at the conversion — never backdated to
the launch, so a late conversion costs the customer no days. Every automatic
conversion is audited (`membership.launch_converted`, plus
`membership.launch_dedupe` when rows were ended); a deferral is not audited on
read (it would be re-read on every page view) but is reported by the sweep.

**The admin button stays for leftovers.** `POST
/api/memberships/admin/activate-launch` with `{confirm:"ACTIVATE"}` records the
launch when it is not recorded yet and converts every reservation that exists
(same function, all accounts, `membership.launch_activation_deferred` for each
deferral). `GET /api/memberships/admin/plans` returns `prepaid_count`, and the
Plans & launch panel keeps the button enabled while it is above zero, labelled
«تفعيل الحجوزات المتبقية (N)». `prepaid_count` counts only what the sweep can
start: a reservation under a higher running tier (and that account's other
reservations) is `deferred_count` instead, shown under the button as a refund or
cancel by hand — otherwise the button would stay lit at «(1)» over a sweep that
always starts 0.

Expiry is calendar months (month-end clamped), stored as ISO UTC, displayed in
the viewer's locale. No auto-renewal exists (needs explicit consent and a
supported payment flow — not implemented by design). An owner who genuinely
wants a pre-launch gate again writes `activated: false` into the setting on
purpose; the reservation machinery still works for that, and the customer
copy then reads «قيد التفعيل».

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
`charge_usd_cents` at the current `exchangeRate`), the spendable balance and
the shortfall IN DINARS (`balance_iqd`, `shortfall_iqd` — computed in dinars,
the unit /wallet prints, migration 0108; /subscription shows these and keeps
the dollar debit as one quiet line in the confirmation) and in cents
(`balance_usd_cents`, `shortfall_usd_cents`), `activate_now`,
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

The single source is `ENTITLEMENT_MINIMUM_TIER` (worker/lib/entitlements.ts):
a benefit is introduced at the lowest tier that owns it and every higher tier
inherits it (`TIER_INHERITANCE`: PLUS ⊂ PREMIUM ⊂ PRO). `GET /plans` sends it
resolved per tier as `entitlement_contract.tiers`, and «مقارنة الخطط» on
/subscription draws its ticks from that — so what the page promises is this
table and nothing else.

| Entitlement | From | Enforcement point |
| --- | --- | --- |
| `merchantProfile`, `merchantStore`, `merchantProducts`, `merchantOrders`, `merchantAnalytics`, `merchantSubdomain` — storefront with its own subdomain, dashboard, orders, analytics | PLUS | merchant.ts, merchantAuth.ts, marketplace.ts |
| `communityOffers` — offers on Community requests | PLUS | community.ts |
| `exclusiveSections` — Bundles | PLUS | bundles.ts |
| `exclusiveCoupons` — tier-required coupons | PLUS | `validateCoupon` + `pricing.TIER_RANK` ladder |
| `memberOffers` — member offers | PLUS | offers.ts |
| `premiumPricing` — PREMIUM prices and PREMIUM discount rules | PREMIUM | price resolver + `membership_benefit_rules` |
| `premiumDelivery` — PREMIUM free-delivery rule (after coupons AND points) | PREMIUM | shipping + `membership_benefit_rules` |
| `premiumRewards` — daily check-in ×1.5 (PRO ×2) | PREMIUM | `dailyRewardMultiplierX100` (pointsMultiplier.ts) |
| `codTaxExemption` — MAY be exempt; the rule decides (PREMIUM ships "no") | PREMIUM | `membership_benefit_rules` `cod_tax_exemption` |
| `proPricing` — PRO prices and PRO discount rules | PRO (approved default address) | price resolver, `pricingTierContext` |
| `freeDelivery` — PRO free-delivery rule | PRO (approved default address) | shipping + `membership_benefit_rules` |
| `noPreorderCommission` — no shipping-type surcharge | PRO (approved default address) | pricing.ts |
| `proMerchantBadge` — PRO merchant badge | PRO | community.ts `usersWithEntitlement` |
| `priorityService` — priority on warranty and support | PRO | devices.ts, support.ts |
| `priorityDelivery12h` — 12-hour preparation and delivery, where the method, shipping type, area and address qualify | PRO | priorityDelivery.ts |
| `bnpl` — buy now, pay later (approved account, verified identity, approved address, credit limit) | PRO | bnpl.ts, `/api/memberships/bnpl*` |
| `proExclusive` | PRO | defined; nothing reads it, so the page does not list it |

Conditional perks the page lists only when switched on: the pre-order
filament gift (`features.preorder_gift`, `preorderGiftFor`). The PLUS gift
with a printer is granted by hand and not advertised. The PRO referral reward
is not a PRO entitlement (it is recorded for the referrer whatever their
tier), so the PRO card does not list it.

Removed from the page as having no code behind them: daily game tickets
(×1 / ×5), "PRO-only products and offers", "advertising eligibility", the
"special offers / random filament" sections, and the "tangible physical card /
3D-printable Levo ID" block.

An active restriction case (support.ts) pauses individual benefit flags;
`GET /api/memberships/mine` returns them as `status.gated_benefits` and the
page shows them to the member under "Paused benefits".

## Referral programs (mandate §9)

Distinct campaigns with separate attribution and rewards; both use
persistent per-user codes (`referral_codes`), attribution
`UNIQUE(referred_id, campaign)`, and rewards `UNIQUE(campaign, source_ref)`
so retries/status replays can never double-award. Self-referrals rejected.

**The referred account gets nothing.** The owner: «الإحالة لا يحصل على أي
شيء فقط كود دعم». Signing up with a code (worded «كود الدعم» / "Support code"
/ «کۆدی پاڵپشتی» on /auth) only records the attribution: no delivery waiver,
discount, points or membership reaches the new account. A delivery waiver
comes only from an active membership's `free_shipping` rule (PRO: standard and
personal; PREMIUM: standard only), through `resolveOrderBenefits` — the
checkout passes `independentFreeDelivery = false` to `quoteShipping`, and the
former referral waiver (`referralFreeDeliveryApplies`) no longer exists.

**9.1 Printer referral** — referred friend's qualifying printer purchase
(printer = product in a catalog flagged `is_printer_catalog`, never name
matching) is recorded for the REFERRER only; the friend's order is priced and
delivered like anyone else's. The referrer's reward row is created when
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
