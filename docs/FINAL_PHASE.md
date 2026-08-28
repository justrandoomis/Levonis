# Final phase — requirement → implementation → test matrix

Covers every numbered section of the final-phase brief (August 2026 revision,
"customer protection, after-sales and PRO operations"). One row per
requirement group: where it is implemented, which automated check covers it
(section names refer to `scripts/api-tests-v3.mjs` unless stated), and which
owner decision still gates it (row numbers refer to `docs/DECISIONS.md`).

**Status legend (honest, no inflation):**

- `implemented` — code + tests exist for the behavior as specified.
- `partial` — meaningful behavior exists, a named piece is missing.
- `blocked-on-decision` — the structure ships configurable-and-disabled; the
  commercial value/rule must come from the owner before it can activate.
  Blocked features render explicit needs-configuration states, never
  invented defaults.
- `not-started` — nothing beyond schema/notes exists yet.

**Integration-run note:** this matrix was written while seven implementation
agents worked concurrently. Two wiring steps happen at integration (tracked
by the orchestrator) and until they land the v3 suite reports the affected
checks as failures, by design:

1. `worker/index.ts` must mount the new routers: `telegramRoutes`
   (`/api/telegram`), `invoiceRoutes` (`/api/invoices`), `deviceRoutes`
   (`/api/devices`), `reviewRoutes` (`/api/reviews`), `returnRoutes`
   (`/api/returns`), `priceProtectionRoutes` (`/api/price-protection`),
   `policiesRoutes` (`/api/policies`), `kycRoutes` (`/api/kyc`),
   `supportRoutes` (`/api/support`). The v3 suite probes `/api/policies`
   first and fails fast with an explicit message when unmounted.
2. `awardOrderPoints` (`worker/lib/pointsOps.ts`) is defined and unit-tested
   but not yet called from the delivered transition in
   `worker/routes/admin.ts` (`PATCH /api/admin/orders/:id`). The reversal
   path (`reversePointsForOrder`) is already wired in
   `worker/routes/returns.ts`.

Automated suites: `scripts/api-tests.mjs` (base), `scripts/api-tests-v2.mjs`
(products/memberships — its PRO delivery assertion now encodes the CONFIRMED
address+threshold rule), `scripts/api-tests-v3.mjs` (this phase),
`npm run test:unit` (`tests/*.test.ts`). Results are recorded in
`docs/TEST_RESULTS.md` only after a real run — never projected.

---

## §1 User data protection and authorization

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Server-side ownership on every object; never trust client ids/roles | every route derives the actor from `c.get('user')` (`worker/lib/session.ts`); owner-or-admin loads in invoices/devices/returns/claims/tickets | v3 IDOR checks in the invoices, devices, returns, gifts and support sections; base-suite IDOR block | implemented | — |
| Separate staff permission tiers (support / finance / KYC / security) | single `admin` role today; KYC evidence reads are individually audited (`worker/routes/kyc.ts`) | not automated | partial — role granularity beyond admin/customer is not built | owner to name the staff roles actually employed |
| CSRF/origin, cookies, hashing, rate limits, parameterized SQL | `worker/lib/http.ts` (originCheck, securityHeaders), `worker/lib/ratelimit.ts` (per-user buckets), prepared statements everywhere | base suite (auth/authz blocks); v2/v3 exercise the limits implicitly | implemented | — |
| Admin MFA, no bootstrap backdoor | `INITIAL_ADMIN_EMAIL` bootstrap + Google sign-in; no MFA | not automated | partial — MFA not implemented | owner to approve an MFA mechanism |
| Private objects never on public R2 (`r2.dev`) paths | private prefixes (`receipts/`, `kyc/`, `claims/`, `reviews-evidence/`) served only through authorized routes with `no-store` | v3: evidence/claim-file access is owner/admin-gated; upload keys must belong to the caller | implemented | — |
| Application-layer encryption of identity fields, versioned keys | `worker/lib/sealbox.ts` (versioned `v1:` format), `KYC_ENC_KEY` secret; `tests/sealbox.test.ts` | unit tests; v3 KYC section (honest 503 branch when key unset) | implemented | row 26 (secret present per owner note) |
| Audit of sensitive staff actions | `worker/lib/audit.ts` used across admin serial/claims/KYC/policy/restriction actions | asserted indirectly (behavior) — audit rows checked manually | implemented | — |

## §2 Telegram: phone ownership, linking, OTP, notifications

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Challenge-based linking, opaque nonce, digest-only storage | `worker/routes/telegram.ts` (`/link/start`, `/link/status`, `/link/confirm`), `link_challenges` (0003) | v3 "telegram" — deep link contains no phone, status is session-scoped | implemented | — |
| Contact-request keyboard; reject typed/forwarded/foreign contacts, mismatch | webhook `handleContact` (contact.user_id must equal from.id; forward markers rejected; full-E.164 match), `worker/lib/phone.ts` + `tests/phone.test.ts`, `tests/telegram.test.ts` | unit tests; live private-chat flow needs a real bot — BLOCKED in v3 with reason | implemented | row 26 (separate staging bot) |
| Webhook secret header, update dedupe, no polling | `POST /api/telegram/webhook`: honest 503 unset, timing-safe 403 wrong header, `telegram_updates` UNIQUE dedupe | v3 "telegram" (503/403 branches; dedupe when the runner holds the secret) | implemented | row 26 |
| OTP purposes, hashed verifier, attempts/expiry/resend supersession | `otp_challenges` (0003), `worker/lib/telegram.ts` `sendOtp`/`verifyOtp`, `POST /api/telegram/otp/verify` | v3: wrong-purpose/no-challenge rejection; brute-force limits unit-level | implemented | — |
| OTP delivery to the verified PRIVATE chat only, never the admin group | `sendOtp` targets `telegram_links.chat_id`; admin notifications remain a separate channel | manual staging check (real delivery) — BLOCKED locally | implemented | row 26 |
| Notification outbox with retries/dedup | `outbox` (0003), `worker/lib/outbox.ts` | invoice replay check in v3 proves event-key dedupe | implemented | — |

## §3 Resend: email verification, password flows, invoice-only email

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Email verification: send/resend/expiry/one-use; POST-only confirm | `worker/routes/auth.ts` (`/verify-email/status|send|confirm`), `email_verification_tokens` | v3 "email verification": honest 503 unconfigured, GET cannot consume, bad token rejected; real receipt BLOCKED until secrets | implemented | row 14 (secrets) |
| Change password / forgot password with generic responses + revocation | `/change-password`, `/forgot-password`, `/reset-password` in `worker/routes/auth.ts` | base suite (honest 503 without provider); flows re-tested on staging | implemented | row 14 |
| Invoice as the ONLY routine order email | `worker/lib/invoices.ts` `createInvoiceForOrder` + outbox event `invoice:<order>:1`; templates in `worker/lib/emailTemplates.ts` (+`tests/emailTemplates.test.ts`) | v3 "invoices": auto-created once, replay yields ONE invoice; no other order email paths exist | implemented | row 23 (issuance event default: order acceptance) |
| Honest paid/unpaid/COD/BNPL status; revisions not mutation | `invoices.payment_status`, `POST /api/invoices/:id/revise` appends revisions | v3: COD invoice is `cod_due`/`unpaid`, never "paid" | implemented | row 9 (§13) business identity data for the printed form |
| Owner-gated access, no permanent public PDFs | `/api/invoices/mine`, `/:id`, `/:id/html` — owner-or-admin, `no-store` | v3: foreign read 404, anonymous 401 | implemented | — |

## §4 Serialized devices, delivery and warranty

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| One record per physical unit (5 printers + 1 AMS = 6) | `order_item_units` (0003) + `createUnitsOnDelivery` (`worker/lib/deviceOps.ts`) called from the delivered transition | v3 "devices": delivered → exactly 6 units; replayed transition rejected, nothing duplicated | implemented | — |
| Explicit device eligibility (no name guessing) | `products.ops_policy` (`serialized`, `warranty_base_months`, `size_class`) via `POST /api/devices/admin/products/:id/ops-policy` | v3 setup: printer serialized 12mo; AMS serialized with honestly-unset duration | implemented | row 18 (AMS base months) |
| Admin serial assignment, uniqueness, no accidental reassignment | `device_serials` (norm PK, unit UNIQUE), `POST /api/devices/admin/units/:unitId/serial` (409 `REASSIGN_REQUIRED` + reason) | v3: duplicate serial 409 | implemented | — |
| Customer registration: non-enumerating, never moves dates | `POST /api/devices/register` (one generic 404 for unknown/foreign/undelivered), `device_registrations` | v3: foreign and unknown serials return the SAME answer; `warranty_start_at` stays `delivered_at`; duplicate registration idempotent | implemented | — |
| Coverage math: 12 base, +12/+24 checkout-only, calendar months, leap/EOM | `computeCoverage`/`addMonths` (`tests/warranty.test.ts`); extension = `warranty_plans` selected at checkout only — no post-purchase API exists | v3: 2024-02-29 + 36 months → 2027-02-28 via the audited delivery-correction endpoint; unit tests cover more cases | implemented | row 18 (extension fees) |
| Per-unit delivery, audited corrections | `PATCH /api/devices/admin/units/:unitId/delivery` (reason + audit, recomputes one window) | v3 delivery-correction check | implemented | — |
| Claims with messages/attachments/decisions; replacements keep history | `warranty_claims` + `claim_messages`, `/units/:unitId/claims`, `/claims/:id`, admin decide/replace (`replaced_by_unit_id` chain) | v3: owner claim + authorized warranty facts; foreign 404 | implemented | row 4 (§13) coverage after replacement |

## §5 Printer reviews, Instagram evidence, five gift levels

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Eligibility: delivered buyer; media sniffed; evidence private | `worker/routes/reviews.ts` (`POST /api/reviews`, `/uploads`, private `reviews-evidence/` prefix) | v3 "reviews": non-buyer 404; duplicate review 409; uploads sniffed | implemented | — |
| Quality score 1–5 is a rubric, NOT sentiment/stars | admin `POST /api/reviews/admin/:id/reward` with deterministic checklist + human `qualityScore` | v3: a 1-star critical review is approved at score 3 | implemented | row 5 (§13) rubric thresholds |
| Score N unlocks ONE box of levels 1..N | `gift_entitlements.max_level`, `POST /api/reviews/gifts/:id/redeem` | v3: level 4 locked at score 3; one redemption; replay returns the SAME persisted contents | implemented | — |
| Server-side random contents from real stock, atomic decrement | `gift_pool_items` (CHECK stock ≥ 0), `gift_redemptions` PK | v3: stock 2 → 1 exactly once; unstocked pool → honest `GIFT_POOL_UNCONFIGURED` 503 | implemented | row 19 (pool contents/stock) |
| No duplicate rewards from edits/re-approval | UNIQUE reward per review; re-approve 409 | v3 re-approval check; `tests/reviews.test.ts` | implemented | row 5 (multiplicity per unit/order/review — default: one per review) |
| Other-product review points (configured value only) | `reviewPointsConfig` setting; honest `REVIEW_POINTS_UNCONFIGURED` 503 when unset | covered by route logic; value BLOCKED | blocked-on-decision | row 6 (§13) |

## §6 Service policies wired to checkout/database/admin

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| 6.1 Extensions checkout-only, snapshotted per item | `warranty_snapshot` per order item; no post-purchase extension endpoint | v3 devices section (ext months on units) | implemented | row 18 (fees) |
| 6.2 Returns: 7 days from actual unit/item delivery; request time governs | `worker/routes/returns.ts`, `return_cases` state machine | v3 "returns": within-window accepted; 8-days-back rejected `RETURN_WINDOW_CLOSED`; foreign case 404 | implemented | refund destination + freight policy (§13.8) |
| 6.3 Shipping: 5,000 ordinary; PRO waiver = active PRO + approved default address + strictly >75,000 | `worker/lib/shipping.ts` (pure engine) + `computeCheckout` (`worker/routes/orders.ts`); `tests/shipping.test.ts` | v3 "PRO free-delivery": 75,000 charged / 75,001 free at the approved address; no waiver without approval; alternate address ordinary; automatic restore; PRO-only; v2 assertion fixed to the confirmed rule | implemented (CONFIRMED rule — rows 15) | rows 3/16/17 (printer 25k/50k map, carton, threshold basis) |
| 6.3 Printer fees / carton / advance payment | config knobs in `shippingPolicy`; unconfigured → `needs_config`, checkout refused | v3: quote carries the blocker; order 400 `SHIPPING_NEEDS_CONFIG`; amounts BLOCKED | blocked-on-decision | rows 3/16 |
| 6.4 Discounts/offers per tier, server-enforced | pricing resolver (`worker/lib/pricing.ts`, v2 suite), `proPricingPolicy` explicit-only | v2 suite | implemented | row 7 |
| 6.5 BNPL (PRO-only, 200k aggregate, ≤7 days) | `bnpl_accounts`/`bnpl_ledger` (0002) exist; no purchase path enabled | BLOCKED row in v3 | blocked-on-decision | rows 10/21 |
| 6.6 Points: 1,000 IQD = 1 point, 1 point = 1 IQD, exactly once | `worker/lib/pointsOps.ts` + `points_awards` guard; `tests/points.test.ts`; **wiring of `awardOrderPoints` into the delivered transition pending integration** | v3 "points": 999/1000/1999 → 0/1/1; replayed transition awards nothing | partial until wired | row 20 (qualifying-spend definition — default merchandise only) |
| 6.6 Daily tasks/missions | `worker/routes/rewards.ts` (check-in/push/video/browse, Baghdad day boundary) | base suite | implemented | row 6 (§13) award values |
| 6.7 Play & Earn / competitions | `ticket_ledger`/`game_sessions` schema (0003) only; no gameplay endpoints; paid/chance mechanics deliberately not built | BLOCKED (legality) | blocked-on-decision | rows 25 + §13.11 |
| 6.8 Price protection: 7 days, history-backed, no auto payout | `price_protection_claims` + `price_history`; `POST /api/price-protection/claims` (buyer-class comparison, prior-credit cap) | v3 "price protection": pending claim, credited 0, no wallet/points movement | implemented | row 22 (compensation channel) |

## §7 Policies, privacy and checkout consent

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Original trilingual LEVONIS policy drafts (not Bambu copies) | `worker/lib/policyOps.ts` `POLICY_DRAFTS` + `tests/policyDrafts.test.ts`; drafts for owner/legal review — publication is an explicit admin act | seed-drafts in v3 | implemented as DRAFTS — legal approval pending | owner/legal review; business identity data (§13.9) |
| Versioned publish, immutability, archived history readable | `policy_documents`, `POST /api/policies/admin/publish` (confirm phrase, hash per lang) | v3 "checkout consent" (publish idempotent across runs) | implemented | — |
| Honest empty state before publishing | `GET /api/policies` returns `[]` | v3 "policies" (tolerant on persistent DBs) | implemented | — |
| Checkout refuses without current acceptance; recorded server-side | `verifyAndRecordAcceptance` inside `POST /api/orders` → `policy_acceptances` (hash+version+context) | v3: 400 `POLICY_ACCEPTANCE_REQUIRED` without, success with; base orders before publish prove enforcement turns on with publication | implemented | — |

## §8 Non-AI automated support

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Deterministic intents, clarifying questions, no AI model | `worker/routes/support.ts` `/assistant` (intent table + keyword matcher, ar/en/ckb texts); `tests/support.test.ts` | v3 "support": no-intent → clarify with choices | implemented | — |
| Same customer-authorized APIs; technically unable to read foreign data | handlers query with `user_id` filters and return allowlisted DTOs | v3: foreign order id → not-found-in-your-account, zero leak of the foreign id | implemented | — |
| Real ticket escalation with explicit confirmation; PRO queue priority | `support_tickets` (+priority snapshot), `POST /api/support/tickets` (`confirm:true`), admin queue `ORDER BY priority DESC, created_at ASC` | v3: CONFIRM_REQUIRED; foreign refs refused; PRO ticket ranks above an earlier ordinary one; foreign ticket read 404 | implemented | — |

## §9 PRO membership: identity, one phone, one address

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| KYC case flow (draft→…→verified), encrypted fields, human review | `worker/routes/kyc.ts`, `kyc_cases` (+0009), sealbox encryption, audited evidence reads | v3 "KYC": honest 503 when `KYC_ENC_KEY` unset; phone-verification gate when configured; full cycle is a manual staging step with synthetic documents | implemented | rows 24/26 |
| One approved default address, versioned, staff-approved; selection ≠ edit | `approved_addresses` versions; `/api/kyc/address-request` + admin decision; checkout matches by content snapshot (`isApprovedDefaultAddress`) | v3 PRO shipping section (approved-vs-alternate context); binding-bypass attempts covered by content matching | implemented | — |
| Alternate address = ordinary order, automatic restore, no sanction | `computeCheckout` recomputes context per request; nothing stored/downgraded | v3: alternate 5,000 → approved 0 automatically | implemented (CONFIRMED) | — |
| Phone change requires new ownership proof | `/api/kyc/phone-change-request` (Telegram-verified phone, case_type `phone_change`) | route-level; live proof BLOCKED with linking | implemented | — |
| Community merchant access independent of checkout address (PLUS or PRO) | community gate by membership only (`worker/routes/community.ts`); v2 suite covers the PLUS/PRO gate | v2 community section | implemented (CONFIRMED) | row 1 (§13) future community brief |

## §10 PRO administration

| Requirement | Implementation | Automated test | Status | Owner decision |
| --- | --- | --- | --- | --- |
| Member search/detail with verification/subscription/restriction facts | `GET /api/support/admin/members`, `/members/:userId` | manual admin-screen check | implemented | — |
| Restriction cases gate specific benefits, never login/warranty/support | `restriction_cases` (+0010 `benefit_flags`), `activeRestrictionFlags` consulted at ticket priority/benefits | v3 ticket-priority path exercises the gate hook | implemented | §13.7 thresholds for automatic restrictions |
| Priority queues that actually order work | support queue ordering; order `priority` flag at checkout in PRO context | v3 support queue check | implemented | — |
| BNPL exposure console | not built (feature disabled) | — | blocked-on-decision | rows 10/21 |

## §11 Data model, transactions, admin configuration

| Requirement | Implementation | Automated test | Status |
| --- | --- | --- | --- |
| Constraints/uniques enforce financial invariants (no check-then-write) | migrations 0003 + 0006–0010: UNIQUE unit index, serial PK, redemption PK, `points_awards` PK, acceptance UNIQUE, CHECK stock ≥ 0; `env.DB.batch` everywhere | v3 replay checks (units, invoice, points, gifts) | implemented |
| Replayed events cannot restart coverage / re-award / duplicate invoices | idempotent unit creation, invoice per (order, revision), points guard | v3 devices/invoices/points sections | implemented (points pending the one wiring call) |
| Live config vs historical snapshots | order/pricing/warranty snapshots at checkout; ops-policy changes apply to future deliveries only | v3 (price drop after delivery does not rewrite the order) | implemented |

## §12 Customer experience and performance

| Requirement | Implementation | Automated test | Status |
| --- | --- | --- | --- |
| Mobile-first flows: warranty, returns, reviews/gifts, policies, support | `src/pages/Warranty.tsx`, `Policies.tsx`, `Support.tsx`, components under `src/components/{kyc,returns,reviews}/`, admin `AdminSerials/AdminReviews/AdminKyc/AdminMemberships` | manual (browser run at integration) | implemented per concurrent agents — UI verification pending the integration browser pass |
| ar/en/ckb + RTL, honest loading/error/empty states | per-component `STRINGS` maps + `useLanguage()` | manual | partial until the browser pass |
| Performance before/after measurements | not done this phase | — | not-started (documented follow-up) |

## §13 Decisions that must not be guessed

Maintained in `docs/DECISIONS.md` (26 rows). CONFIRMED and never re-asked:
row 15 (PRO delivery: PRO only + approved default address + strictly
>75,000; alternate address ordinary; automatic restore) and the
community-merchant eligibility (PLUS/PRO may sell). Open rows gating
features in this phase: 3, 5, 6, 10, 14, 16, 17, 18, 19, 20, 21, 22, 23,
24, 25, 26.

## §14 Verification and acceptance

| Requirement | Implementation | Status |
| --- | --- | --- |
| Extended suite with passed / failed / BLOCKED reported distinctly | `scripts/api-tests-v3.mjs` (three counters; blocked-with-reason for honestly unconfigured preconditions; synthetic fixtures only) | implemented — awaiting the integration run |
| v2 correction for the confirmed shipping rule | `scripts/api-tests-v2.mjs`: the old "PRO free delivery (shipping 0)" check now asserts 5,000 IQD because that buyer has no approved default address | implemented |
| Unit tests | `tests/{pricing,shipping,phone,telegram,warranty,points,reviews,policyDrafts,sealbox,emailTemplates,support}.test.ts` | implemented |
| Manual/live items (cannot be automated locally) | real Telegram private-chat flow + iPad app-switch return; real email receipt; staging webhook ownership; browser pass for the new pages | pending staging (§15) |

## §15 Staging, production, operational handoff

Not part of this code phase. Gates before any deploy: owner decisions above,
secrets per row 26 (`TELEGRAM_WEBHOOK_SECRET`, `KYC_ENC_KEY`, email secrets
per row 14, `PROD_APP_ORIGIN`, separate staging bot), D1 backup/bookmark,
webhook ownership check, and the existing deployment approval mechanism.
Status: not-started (deliberately — deployment requires explicit
authorization).
