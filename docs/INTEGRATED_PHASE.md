# Integrated phase — button/feature → API → DB/event → permission → acceptance test → state

The delivery matrix required by the integrated mandate (§15: «مصفوفة الزر/الخاصية
← API ← قاعدة البيانات/الحدث ← الصلاحية ← اختبار القبول ← الحالة»), covering the
whole scope of that mandate: accounts and sign-up methods (§2), referrals and
support codes (§3), points and missions (§4), the unified financial view (§5),
admin import/template (§6), the product page (§7), conversations (§8), the
Studio link (§9), settings (§10), the wallet and the unified payment policy
(§11), wallet notifications and Telegram approval (§12).

Where this mandate contradicts earlier phases it **supersedes** them. The three
overrides that change previously shipped behaviour are:

1. **100 IQD of net eligible merchandise = 1 point** (was 1,000), applied from a
   versioned effective date; old rows keep their own rate and are never
   recomputed (§4.2, migration `0014_points_rule.sql`).
2. **A support code is not a discount.** It is worth exactly 0 IQD to the buyer,
   coexists with a coupon and with points, and only attributes an entitlement
   (§3.3).
3. **One payment policy everywhere**: wallet, or COD where the order is eligible.
   No path creates a successful purchase without collection or a valid COD
   obligation, and a COD order is never "paid" at creation (§11.5).

**Status legend (honest, no inflation):**

- `implemented` — code exists and an automated check asserts the behaviour.
- `partial` — meaningful behaviour exists; a named piece is missing.
- `wiring-pending` — the code exists but an integration step (a mount, a field
  hand-off) is still missing, so the feature cannot work end to end yet.
- `blocked-on-decision` — the structure ships configurable-and-disabled; the
  commercial value must come from the owner before it can activate. Blocked
  features render explicit needs-configuration states, never invented defaults.
- `not-verified-here` — implemented by another slice this round and not
  exercised by an API suite; the UI/browser suite owns it.

Automated suites: `scripts/api-tests.mjs` (base), `scripts/api-tests-v2.mjs`
(products/memberships), `scripts/api-tests-v3.mjs` (final phase — its points
section now asserts the NEW 100:1 pending-accrual rule),
**`scripts/api-tests-v4.mjs` (this mandate)**, `scripts/e2e-ui.mjs` (browser),
`npm run test:unit` (`tests/*.test.ts`). Results are recorded in
`docs/TEST_RESULTS.md` **only after a real run** — never projected. Decision row
numbers refer to `docs/DECISIONS.md`.

---

## 0. Integration steps this matrix depends on — **ALL LANDED**

Observed while a concurrent fleet was still writing the slices. Frozen files
(`worker/index.ts`, `src/App.tsx`, `src/lib/api.ts`) belong to the integrator,
so these are hand-offs, not slice bugs.

**Status: steps 1–4 were wired in the integration pass and verified by a real
run — see `docs/INTEGRATED_VERIFY.md` (§1 for what changed, §2 for the
numbers). Step 5 (an admin coupon API) is still absent; v4 still inserts that
row through `PROMOTE_CMD` and says so.** Every row in this matrix that said
`wiring-pending` is now exercised: `/api/referrals` is mounted, `/referrals` is
routed, `Checkout.tsx` forwards `supportCode`, and the product share link is
built by `GET /api/referrals/support/link`.

| # | The wiring that was missing | Effect while it was missing | Status |
| --- | --- | --- | --- |
| 1 | `worker/index.ts` does not mount `referralRoutes` (`worker/routes/referrals.ts`) at `/api/referrals` | every referrals/support-gift endpoint answers 404; the referrals page cannot load | **landed** — REF-01…REF-07 green |
| 2 | `src/App.tsx` has no `/referrals` route although `src/pages/Profile.tsx` navigates there and `src/pages/Referrals.tsx` exists | the profile icon leads to a blank route | **landed** — `/referrals` is a protected route |
| 3 | `src/pages/Checkout.tsx` never reads `location.state.supportRef` (the cart already passes it) and never sends `supportCode` in `POST /api/orders` / `/api/orders/quote` | a support code chosen in the cart is dropped at checkout — no attribution, no gift | **landed** — browser pass asserts the handle and its `0 IQD` on the checkout money view |
| 4 | `src/pages/Product.tsx` share button shares `window.location.href` and never calls `GET /api/referrals/support/link` | a signed-in sharer's own link carries no support ref (§3.3) | **landed** — share asks the server for the link; the product page captures an arriving `?ref=` |
| 5 | No admin API creates a discount coupon (`coupons` rows are inserted by hand) | coupon coexistence is testable only through the SQL channel | **still open** — v4 inserts the row through `PROMOTE_CMD` and says so |

---

## §2 Accounts: sign-in and sign-up

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Create account (e-mail + password) | `POST /api/auth/register` | `users` insert; session cookie; `referral_attributions` when a code came along | anonymous; `register` bucket 30/h/IP | v4 AUTH-02 (`user@example.com`, `user@example.ru`, `name+tag@sub.example.co.uk` accepted; four malformed forms refused), AUTH-03 (7 refused / 8 accepted / 8 non-Latin accepted) | implemented |
| Sign in (e-mail, username **or** phone) | `POST /api/auth/login` | reads `users.phone_e164`, then a live `telegram_links` row | anonymous; `login` 20/15min | v4 AUTH-04 — `07…`, `+964…`, Arabic-Indic digits and a spaced form all resolve to ONE account id | implemented |
| Phone sign-up (Telegram-verified) | `POST /api/auth/telegram/start` → `status` → `resend` → `complete` | `link_challenges`, `otp_challenges`, `users.phone_e164` (UNIQUE), `telegram_links` | anonymous; per-purpose buckets 6/10min, complete 10/5min | v4 AUTH-04 (invalid phones refused before any Telegram call; e-mail sign-up refuses an unproven phone), AUTH-05 (purpose separation, wrong/expired/consumed, attempt cap) | implemented, delivery `blocked-on-decision` (row 26 — no bot token here) |
| Six-digit OTP box → “Verify” | `POST /api/telegram/otp/verify`, `POST /api/auth/telegram/complete` | `otp_challenges.attempts`/`consumed_at`; single-use, keyed digest, never logged | signed-in for the link purpose; challenge-bound for auth | v4 AUTH-05: five digits never verify, a correct code after the cap is still refused (`OTP_LOCKED`), a consumed code cannot be replayed | implemented |
| Google button | `POST /api/auth/google` (+ `/google/link`) | `users.google_sub`, session | anonymous | base suite (signature verification); interactive sign-in unverifiable here | `blocked-on-decision` (row 28 — Console origins are an owner step) |
| Verify e-mail / resend / forgot / reset / change password | `/api/auth/verify-email/*`, `/forgot-password`, `/reset-password`, `/change-password` | `email_verification_tokens`, `password_reset_tokens` (single-use, expiring), session invalidation | owner of the account; per-bucket limits | v4 AUTH-02 non-enumeration (identical answer for a known and an unknown address); v3 covers the token flows | implemented; live delivery `blocked-on-decision` (row 14) |
| Fill-progress button (incomplete → ready → submitting) | none — pure client state | none | — | `tests/fillButton.test.ts` + browser suite (v4 records it as NOT EXECUTED, it is not an API behaviour) | not-verified-here |
| “Have a referral code?” bar | `GET /api/auth/referrer-info?ref=` then the code rides the sign-up body | resolved server-side; only the resulting user id is stored | anonymous, 60/5min | v4 REF-02 (resolve for display; empty/unknown codes never block sign-up; a body-supplied `referrer_user_id` attributes nothing) | implemented |

## §3 Referrals, support codes and the filament gift

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Referrals page (icon under “My orders”) | `GET /api/referrals/me` | reads `referral_attributions`, `support_gift_entitlements`, `referral_rewards`; buyer identity never exposed (order refs are masked) | signed-in owner | v4 REF-02 (invite path + username + one signup invite) | implemented — mounted and green |
| Copy / share invite link | `GET /api/referrals/support/link?path=` | none (pure link building) | signed-in | v4 REF-04 resolve block; link building unit-tested in `tests/supportCode.test.ts` | implemented (server side) |
| Support code in the cart (auto from a link, or typed) | `GET /api/referrals/support/resolve?ref=`, then `supportCode` on `POST /api/orders/quote` and `/api/orders` | `orders.support_snapshot` frozen at confirmation (migration 0014); the cart stores nothing | signed-in; 60/5min on resolve | v4 REF-04: identical merchandise/delivery/total with and without the code; the quote shows the handle with `discount_iqd: 0`; coexists with a fixed coupon **and** points | implemented — the cart→checkout hand-off is wired and asserted in the browser pass (`checkout-support-line.png`) |
| Remove the support code | client state only (`src/pages/Cart.tsx`) | none | — | browser suite — v4 records it NOT EXECUTED (no server state is involved by design) | not-verified-here |
| Beneficiary cannot be swapped | replay of `POST /api/orders` with the same idempotency key; `PATCH /api/admin/orders/:id` | `orders.support_snapshot` is written once, by checkout only | admin cannot re-point it | v4 REF-05: a replay carrying another code returns the ORIGINAL attribution; an admin order update does not change it; a new order's code never rewrites the account's signup inviter | implemented |
| Filament gift entitlement | `POST /api/referrals/admin/gifts/evaluate`, `/reconcile`, `PATCH /admin/gifts/:id`; triggered by the delivered transition | `support_gift_entitlements` UNIQUE(order_id); states pending_eligibility → due → reserved → paid / cancelled | admin for the review queue; referrer sees only their own claim | v4 REF-06: delivered **and** settled **and** an explicitly eligible printer line ⇒ exactly one claim; delivered-replay + evaluate + reconcile create no second one; an accessory never qualifies | implemented |
| Self-support and abuse guards | `resolve` returns `SELF_SUPPORT`; `buildSupportSnapshot` returns null | no attribution row is written at all | — | v4 REF-07: own handle refused on resolve, no snapshot on the order, no entitlement after delivery | implemented |
| Eligibility flag on products | `POST /api/admin/products-v2` (catalog `is_printer_catalog`) + `products.support_gift_eligible` | explicit admin fields only — never a name match | admin | v4 REF-06 (printer catalog qualifies, plain accessory does not) | partial — the per-product override has no editor field yet; the catalog flag is the only UI |
| Gift quantity / repeat policy / post-payout returns | — | — | — | — | `blocked-on-decision` (row 11, mandate §13.2): one gift per qualifying ORDER ships as the safe default |

## §4 Points, missions and videos

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Points earned on a purchase | `POST /api/orders` | `points_accruals` PENDING row inside the checkout batch; `purchase_at` = the server instant, `available_at` = +7×24h, rate frozen per row | owner | v4 PTS-01 (99 → 0, 100 → 1, 199 → 1, 75,000 → 750, rule `v2`); v3 points section (999/1,000/1,999 → 9/10/19 pending) | implemented |
| Seven-day hold + settlement gate | `POST /api/orders/:id/settlement`; durable sweep `releaseDueAccruals` | `order_payment_settlements` UNIQUE(order_id, event_key); accrual pending → released; POINT ledger row with a deterministic id | admin records collections; the sweep is server-scheduled, never user-triggered | v4 PTS-02: settled but not yet due releases nothing; a day-9 collection releases 742 then and there; the window is not restarted from delivery; replays never award twice | implemented |
| Uncollected COD | as above | `settled_at` stays NULL | — | v4 PTS-02 (delivered + uncollected ⇒ still pending, balance unchanged) | implemented |
| “Use my points” in the cart | `POST /api/orders/quote` / `/api/orders` with `usePoints` | `points_reservations` UNIQUE(order_id) + a balance-guarded POINT withdrawal, in the checkout batch | owner; spendable balance only (pending never spends) | v4 PTS-03 (739 → exactly 739 IQD; a 500 IQD basket absorbs 500 of 5,000 points and never pays delivery), PTS-04 (two concurrent orders never overspend; a failed checkout loses nothing) | implemented |
| Old balances after the rule change | — | old rows keep `iqd_per_point`/`rule_version`; `points_awards` (pre-0014) is never re-evaluated | — | v4 PTS-07: an old-rule accrual releases 12 points, not 120, and keeps its rate after release | implemented |
| Effective date of the new rule | `admin_settings.pointsRuleConfig` | seeded at migration time so every existing order is unambiguously “before” | owner | v4 records it BLOCKED | `blocked-on-decision` (row 20, mandate §13.4) |
| Daily check-in / push / video / browse missions | `POST /api/rewards/*` | `reward_claims` UNIQUE(user, mission, day) + POINT ledger row in one batch; Baghdad day computed server-side | signed-in; `rewards` buckets | base suite; v4 records PTS-05/PTS-06 NOT EXECUTED (out of this slice's scope) | partial — the video claim is capped per day but a server-verified watch session is not built |
| Admin video/mission management | `PUT /api/admin/settings/adVideoUrl` | `admin_settings` | admin | base suite | partial — a full mission CRUD with versions, schedules and budgets does not exist |

## §5 The unified financial snapshot

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Cart / checkout / order detail / invoice money view | `POST /api/orders/quote`, `GET /api/orders/:id` (`financial`) | one server computation (`computeCheckout` → `financialSnapshot`); no screen recomputes | owner; admin sees the same numbers | v4 §5 block asserts the mandated example digit by digit: 75,000 · 739 → 74,261 · 5,000 · **79,261** · wallet 30,000 · COD **49,261** · pending **742** | implemented |
| Honest payment state | same | `payment_state` derived from recorded collections | — | v4 §5 (`payment_state ≠ paid` at creation, `collected 30,000 / outstanding 49,261`) and PAY-01 (wallet-only ⇒ `paid`) | implemented |
| Support code line in the money view | same | `orders.support_snapshot` | — | v4 REF-04 (`discount_iqd: 0`) | implemented |
| Points line (used, value, pending, eligibility date) | same | `points_accruals` + `points_reservations` | — | v4 §5 (`points.pending = 742`, `available_at = purchase + 7d`, `hold_days = 7`) | implemented |
| Cost/profit never exposed to an unauthorised assistant | pricing snapshots strip cost before persistence | `order_items.pricing_snapshot` | admin-only fields | v3 covers the buyer-visible shape; v4 records PAY-04 NOT EXECUTED | partial — only admin/customer roles exist, so there is no “assistant” role to restrict |

## §6–§10 Admin import, product page, chats, Studio, settings

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Download import template | `GET /api/admin/template/...` (+ `src/components/adminProducts/download.ts`) | none | admin | `tests/templateDownload.test.ts`, browser suite | not-verified-here (template slice) |
| Import dialog / admin frame density | `POST /api/admin/extract-v2`, `/api/admin/products-v2` | `products`, `product_*` | admin | browser suite (UI-02) | not-verified-here |
| Product page image, CTA, availability | `GET /api/products/:slug`, `POST /api/cart/items` | `products.stock`, `selling_type` | anonymous read | `tests/saleMode.test.ts`, browser suite (UI-03/UI-04) | not-verified-here |
| Product share → support link | `GET /api/referrals/support/link` | none | signed-in | browser suite | implemented — the share builds the handled link; an arriving `?ref=` is captured on the product page |
| Support conversations (bot + human) | `POST /api/support/assistant`, `/api/support/tickets`, `/api/chats/*` | `support_tickets`, `chat_messages`; participant-scoped reads | owner/staff; strict IDOR checks | v3 support section (foreign order ids leak nothing, IDOR 404s) | implemented |
| Studio entry | `POST /api/studio/handoff/start` | `studio_handoff` (migration 0012) | signed-in | v3/base; honest 503 when the handoff secret is unset | `blocked-on-decision` (row 30) |
| Settings page (profile, e-mail, password, addresses, language) | `PUT /api/profile`, `/api/auth/change-email`, `/change-password`, `/api/addresses` | `users`, `addresses`; verified-e-mail gates | owner | base suite + browser suite (UI-07) | not-verified-here (settings slice) |

## §11 Wallet and the unified payment policy

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Balance card (available / held / pending) | `GET /api/wallet` | `wallet_transactions` + `wallet_holds` (migration 0015); available = settled − active holds | owner | v4 WAL-08 (`available = settled − held`; pending deposits are never spendable) | implemented |
| Add balance (amount + receipt + reference) | `POST /api/uploads` (purpose `receipt`) → `POST /api/wallet/deposits` | pending `wallet_transactions` row + `wallet_deposit_meta` with a UNIQUE reference per provider/channel | owner; 10/h; receipt must live under `receipts/<own id>/` | v4 WAL-01 (pending, available unchanged, shown separately; same reference refused), WAL-10 (negative/fractional/overflow/non-numeric refused; a foreign proof cannot be attached or viewed) | implemented |
| Admin approve / reject a deposit | `POST /api/wallet/admin/deposits/:id/approve` · `/reject` · `/observe` | one conditional UPDATE; an amount mismatch blocks approval | admin | v4 WAL-02 (two concurrent approvals ⇒ one credit, one 409; a later replay credits nothing), WAL-03 (approve vs reject race ⇒ one transition, no side entry), WAL-04 (a customer calling the admin route is refused) | implemented |
| Request a withdrawal | `POST /api/wallet/withdrawals` | `wallet_holds` (active) + pending ledger row + `wallet_withdrawals` with the destination frozen | owner; 10/h | v4 WAL-07 (held once — available drops, settled does not; the same key holds nothing twice), WAL-08 (above-balance refused; a purchase racing a withdrawal never goes negative) | implemented |
| Admin approve → processing → paid / reject / fail | `/api/wallet/admin/withdrawals/:id/*` | state machine `WITHDRAWAL_TRANSITIONS`; commit-on-paid, release-once-on-close | admin | v4 WAL-07: approval is “approved for processing” (`money_sent: false`, no payout timestamp); paid commits the hold once; a replayed payout debits nothing | implemented |
| Live payout, eligible sources, limits, fees | — | — | — | v4 records it BLOCKED | `blocked-on-decision` (mandate §13.1 — **no register row exists yet; one must be added**) |
| Wallet purchase (full or mixed with COD) | `POST /api/orders` with `useWallet` | wallet debit + settlement row `prepaid_at_purchase` in the checkout batch | owner | v4 PAY-01 (wallet-only ⇒ collected = total, `paid`), §5 (mixed 30,000 + 49,261) | implemented |
| COD | `POST /api/orders` with `paymentMethodId: 'cash'`; collection via `POST /api/orders/:id/settlement` | nothing collected at creation; collection is a separate audited event | admin records the collection | v4 PAY-03 (points appear only after a recorded collection), PTS-02 | implemented |
| Subscriptions are never activated by COD | `POST /api/memberships/subscribe` | wallet-guarded ledger insert; no COD branch exists | owner | v4 PAY-03 (an unfunded subscribe attempt fails and no membership becomes active) | implemented |
| Refunds | `POST /api/orders/:id/cancel` (+ returns flow) | deterministic refund ids; points return AS POINTS; the pending accrual is cancelled | owner | v4 PAY-03 (a refund returns exactly what was paid; a repeat is refused; the accrual is cancelled, never released) | implemented |
| COD eligibility per product class / community store | — | — | — | v4 records it BLOCKED | `blocked-on-decision` (mandate §13.3 — no register row yet) |

## §12 Wallet notifications and Telegram approval

| Button / feature | API | DB / event | Permission | Acceptance test | State |
| --- | --- | --- | --- | --- | --- |
| Deposit lands in the admin group with the proof attached | `notifyAdminsOfDeposit` (outbox) | `tg_admin_notifications` (migration 0017), send state + attempts | server | `tests/walletNotify.test.ts` (pure builders: caption sanitising, digit grouping, closed keyboard) | implemented, delivery `blocked-on-decision` (row 26) |
| Inline “Approve” / “Reject” buttons | `POST /api/telegram/webhook` → `handleAdminActionCallback` | `tg_admin_actions` opaque short-lived tokens; `admin_tg_identities` maps a Telegram user to a real admin | webhook secret + a mapped admin identity | v3 webhook branches (wrong secret, update dedupe); v4 records WAL-05/WAL-06 BLOCKED | implemented, unverified live |
| One decision wins across site + Telegram | both call the same approval service | the same conditional UPDATE as the site route | admin | v4 WAL-02/WAL-03 prove the service-level guarantee the button re-uses | implemented |

## §13 Owner decisions still open (cited by the suites)

| # | Decision | Register row | What ships meanwhile |
| --- | --- | --- | --- |
| 1 | Withdrawals: eligible balance sources, payout channel, limits, fees, who confirms a transfer | **no row yet — add one** (mandate §13.1) | request/hold/state machine works; `fee_configured: false`, no live payout |
| 2 | Support gift: per order or per printer, repeat limits, return-after-payout | row 11 | one gift per qualifying ORDER, manual admin fulfilment |
| 3 | COD: which order classes and community stores may use it | **no row yet — add one** (mandate §13.3) | one server-side payment computation for every path; digital subscriptions have no COD branch |
| 4 | Effective date of the 100:1 points rule for new purchases | row 20 (its 1,000:1 text is superseded) | `effective_at` seeded at migration time; old rows keep their own rate |
| 5 | Exchange rate and rounding | row 6 | 1,400 default; v4 pins it temporarily only to make an exact 30,000 IQD wallet contribution representable, then restores it |
| 6 | Secrets: Telegram bot/staging bot, e-mail, Google origins | rows 14, 26, 28 | honest 503/blocked states everywhere |

## §14 Acceptance-test coverage map

| ID | Where it is asserted | Bucket if the environment is bare |
| --- | --- | --- |
| AUTH-01 | `tests/fillButton.test.ts`, browser suite | v4: NOT EXECUTED (not an API behaviour) |
| AUTH-02, AUTH-03, AUTH-04 | v4 §14.1 | passes offline |
| AUTH-05 | v4 §14.1 (planted challenges prove purpose/limits) | delivery BLOCKED (row 26) |
| AUTH-06, AUTH-07 | v3 Telegram/Google branches | BLOCKED (rows 26, 28) |
| AUTH-08 | v3 token flows; v4 non-enumeration | live e-mail BLOCKED (row 14) |
| AUTH-09 | browser suite | — |
| REF-01 | browser suite | — |
| REF-02, REF-04, REF-05, REF-06, REF-07 | v4 §14.2 | passes once `/api/referrals` is mounted |
| REF-03 | browser suite (client state) | v4: NOT EXECUTED |
| PTS-01, PTS-02, PTS-03, PTS-04, PTS-07 + the §5 arithmetic | v4 §14.3 and §5 block; v3 points section | passes offline |
| PTS-05, PTS-06 | base suite | v4: NOT EXECUTED |
| WAL-01, WAL-02, WAL-03, WAL-04, WAL-07, WAL-08, WAL-10 | v4 §14.4 | passes offline |
| WAL-05, WAL-06 | v3 webhook branches; live group run | BLOCKED (row 26) |
| WAL-09 | partially via PTS-04 / WAL-08 | fault injection between reservation stages is **not** built |
| PAY-01, PAY-02, PAY-03 | v4 §14.4 | COD eligibility BLOCKED (§13.3) |
| PAY-04 | — | NOT EXECUTED (no staff roles beyond admin) |
| UI-01…UI-08 | `scripts/e2e-integrated.mjs` (this mandate's browser pass — auth tabs/fill/OTP, cart+checkout support code, points background, product CTA, admin dialog, chats, Studio link) plus `scripts/e2e-ui.mjs` for the previous phase's ids | executed: 43 passed / 0 failed / 1 not executed (real device) / 1 blocked (live Telegram) |

## Honest gaps in this matrix

- **This matrix HAS now been run** (local `wrangler dev` + a wiped D1 migrated
  0001→0017): 60 · 37 · 118 · 147 · 43 · 38 passed, 0 failed, 17 blocked, 6 not
  executed. The evidence, the screenshot inventory and the reasons behind every
  blocked/not-executed row are in `docs/INTEGRATED_VERIFY.md`, and the summary
  table is in `docs/TEST_RESULTS.md`. A local run is not a staging run and says
  nothing about `levonis-iq.com`.
- Rows marked `not-verified-here` were written by other slices in the same
  concurrent round; this matrix names their API and test owner, it does not
  claim their behaviour was observed.
- `WAL-09` (fault injection between hold, stock, order and ledger) and a
  server-verified video-watch session are the two structural gaps this round
  does not close.
- Granular staff roles (support / finance / KYC) do not exist; every admin can
  see everything an admin can see.
