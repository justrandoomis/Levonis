# Security audit — September 2026 (branch `claude/security-audit-2hq4ci`)

Owner-authorised defensive penetration test of the Levonis code base and
`levonis-iq.com`, performed against the source with test data only. Nothing was
deployed; nothing in production was written, deleted or exfiltrated. Every
finding below is fixed at its root cause on this branch, and every fix carries a
regression test that fails on the old code.

## How the attack was run

Ten attacker roles worked in parallel, each on one dimension (object-level
authorisation, admin privilege, wallet and ledger concurrency, checkout and
pricing trust, authentication and sessions, cross-subdomain boundary and
browser headers, uploads and outbound fetches, injection, secrets and rate
limits, the Studio worker). Every candidate finding was then handed to an
independent verifier told to refute it against the actual code; only findings
the verifier could prove end to end survived. Twelve did — one Critical, three
High, one Medium, four Low, three positive Info confirmations. One further
finding (the missing page headers) came from probing the running Worker, not
from reading code, and is recorded separately.

Static checks: `npm audit` on the main project reports 0 vulnerabilities. The
built bundle contains no secret values, no internal cost figures and no source
maps (`dist/**/*.map` is empty; `dist/` is not committed). The only inbound
webhook (Telegram) is authenticated with a timing-safe secret and fails closed
when unconfigured.

## Findings and fixes

### 1. CRITICAL — an assistant admin could mint an unrestricted admin

**Where.** `PATCH /api/admin/users/:id` (`worker/routes/admin.ts`).

**Cause.** `admin_scope` (financial access) was gated behind
`canViewFinancials`, but `role` was not. A freshly promoted admin has
`admin_scope = NULL`, which `adminScope.ts` treats as *full*. An
`assistant`-scope admin — who must never see a cost — could promote any account
(their own second account included), sign in to it, and read every cost and
margin, approve withdrawals and credit wallets.

**Fix.** One pure rule, `userPatchRefusal` in `worker/lib/adminScope.ts`, decides
every user PATCH: granting or revoking the `admin` role requires financial
authority (it *is* financial access); investor status likewise; customer ↔
merchant stays an operations task an assistant may do. Only a *change* counts —
the panel echoes the whole row on every save, so an unchanged `role: 'admin'`
is not an attempt.

**Test.** `tests/userPatchPolicy.test.ts` (12 cases: escalation refused,
demotion refused, financial admin allowed, echo not an attempt, investor
gating, owner protection).

### 2. HIGH — an assistant admin could demote the owner and every other admin

**Where.** Same handler.

**Cause.** The only guard on `role` was "you cannot demote yourself". The owner
(`INITIAL_ADMIN_EMAIL`) was protected against `admin_scope` restriction only.
Chained with #1 the attacker's proxy became the sole administrator; the Google
bootstrap cannot rescue the owner while any admin exists.

**Fix.** `userPatchRefusal`: the owner can never be demoted by anyone; nobody
demotes themselves; demoting another admin needs financial authority.

**Test.** `tests/userPatchPolicy.test.ts`.

### 3. HIGH — money reserved for a withdrawal could be spent again

**Where.** Checkout wallet payment (`worker/routes/orders.ts`), membership
purchase (`worker/routes/memberships.ts`), the legacy admin withdrawal approval
(`worker/routes/admin.ts`) and `spend()` in `worker/lib/wallet.ts`.

**Cause.** The wallet defines *available = settled − active holds*, and the read
side (`getAvailableBalances`) honoured it. Every *write* guard tested the
settled sum alone. A customer could file a withdrawal for their whole balance
(hold created) and, concurrently, pay for an order or a membership with the
same money; when the payout was recorded the ledger went negative.
Reproduced against the real schema: the old statement posted the debit with
the hold active and left available = −100,000.

**Fix.** One conditional spend, `usdSpendStatement` in `worker/lib/walletOps.ts`,
guarded on the spendable balance, used by checkout and memberships; the legacy
approval uses `approvableWithdrawalSql` (spendable + the request's own hold);
`lib/wallet.ts spend()` subtracts holds for USD. An uncovered amount becomes −1
and violates `CHECK (amount > 0)`, aborting the whole batch.

**Test.** `tests/walletSpendGuard.test.ts` (the double-spend is refused,
partial holds leave the exact remainder, the legacy predicate counts the own
hold once, points are untouched). The existing `tests/walletOps.test.ts` still
passes.

### 4. HIGH — a single-use coupon could be redeemed many times at once

**Where.** `validateCoupon` (`worker/lib/membershipOps.ts`) and the checkout
batch.

**Cause.** `max_per_user` / `max_global` were enforced by counting redemptions
in one statement and inserting in a later one; the table's only constraint was
`UNIQUE(order_id)`. Concurrent checkouts each counted zero and all redeemed.

**Fix.** Migration `0049_security_hardening.sql` adds a `BEFORE INSERT` trigger
on `coupon_redemptions` that raises `COUPON_PER_USER_LIMIT` /
`COUPON_GLOBAL_LIMIT` inside the checkout transaction, so the refused
redemption takes its order down with it (D1 runs a batch as one transaction).
Checkout maps the abort back to its existing error codes. The local migration
harness's SQL splitter learned `BEGIN … END` (wrangler's already had it) so a
trigger proves the same thing locally that it does on D1.

**Test.** `tests/couponLimits.test.ts` (per-user, per-user > 1, global cap,
NULL = unlimited, and the transactional rollback of the order),
`tests/sqlSplit.test.ts`, and `tests/migrations.test.ts` (the migration applies
twice cleanly).

### 5. MEDIUM — referral free delivery was not "one per friend" until delivery

**Where.** `referralFreeDeliveryApplies` (`worker/lib/membershipOps.ts`).

**Cause.** The row marking the purchase as used was written on *delivery*; every
printer order the friend placed before the first one arrived also shipped free.

**Fix.** Migration 0049 records `referral_delivery_waived` on the order at
checkout (from the quote's `waiver_source = 'promotion'`); the check reads it.
A cancelled order gives the waiver back.

**Test.** `tests/referralFreeDelivery.test.ts`.

### 6. LOW — sign-in was throttled per IP only

**Cause.** A guess spread across many addresses was never limited for the one
account it targeted.

**Fix.** A second limit keyed on a hash of the identifier
(`identifierKey` in `worker/lib/ratelimit.ts`), applied before any lookup and
to every identifier alike so it reveals nothing about which accounts exist;
the same for `forgot-password` per address.

**Test.** `tests/rateLimitKey.test.ts`.

### 7. LOW — outbound-fetch guard: redirects and an over-stated docstring

**Cause.** `externalModels.ts` fetched provider APIs with `redirect: 'follow'`,
so a redirect was never re-validated; `fetchGuard.ts` claimed to block private
addresses but only checks *literal* ones (a Worker has no DNS API; the Workers
egress does not route private ranges, which is why the verifier held this at
Low).

**Fix.** Redirects are followed by hand with every hop validated, exactly as
`media.ts` already did; the docstring now says precisely what is and is not
checked.

**Test.** `tests/fetchGuard.test.ts` (a hop to `127.0.0.1` is refused before it
is dialled; a public hop is followed).

### 8. LOW — Studio rendered a signed-in shell after a main-site logout

**Cause.** The `/api/*` branch applied the main-site liveness check; the SSR
document branch called the raw session loader.

**Fix.** One loader, `loadLiveStudioSession` (`studio/worker/auth/session.ts`),
used by both branches.

**Test.** `studio/tests/auth-handoff.test.mjs` (a revoked account renders as a
guest; the wiring of both branches is pinned).

### 9. LOW — `?sort=constructor` reached the SQL text

**Cause.** `ORDERS[sort]` on a plain object answers prototype names with a
builtin function; its source text landed inside `ORDER BY`. No injection (the
text is fixed), a 500.

**Fix.** `pickFrom` in `worker/lib/http.ts`, used by both sort lookups.

**Test.** `tests/pickFrom.test.ts`.

### 10. Found by the live probe — the page itself carried no security headers

**Cause.** `wrangler.jsonc` runs the Worker only for `/api/*` and `/files/*`;
`index.html`, every SPA route and `/assets/*` are served by the asset layer
before the Worker runs. The `securityHeaders` middleware — X-Frame-Options,
nosniff, Referrer-Policy — has therefore never reached the page in production:
the API next to it had every header, the document had none. The page was
framable.

**Fix.** `dist/_headers` is generated on every build from
`worker/lib/securityPolicy.ts` (`scripts/write-asset-headers.mjs`), so the page
and the API carry one policy text.

**Test.** `tests/securityPolicy.test.ts` pins the file's content and the build
wiring. Verified on `wrangler dev`: the document and assets now return the
headers (see "Evidence").

## Hardening delivered alongside (not exploitable as found)

- **Content-Security-Policy and HSTS** on every response. `script-src 'self'
  https://accounts.google.com https://static.cloudflareinsights.com` — no
  inline, no eval — so an injected script
  does not run even if React's escaping ever fails on merchant-controlled text
  (the storefront serves the platform's own bundle on merchant subdomains; the
  injection attacker found no XSS sink, which is why the verifier refuted the
  "malicious merchant JS" scenario). Print documents carry their own policy
  naming their one inline auto-print script by hash, pinned by test. Google
  sign-in, the fonts, vendor-CDN product media and blob previews are allowed
  explicitly. Browser smoke on seven pages: zero CSP violations, every page
  rendered.
  *Live finding after the first deploy (workflow 28, run 1):* the zone's
  Cloudflare Web Analytics setting makes the EDGE inject `beacon.min.js` into
  every HTML response — nothing in the repository loads it — and the policy
  refused it on all six public pages, blinding the owner's analytics. The
  script origin (`static.cloudflareinsights.com`) and the beacon origin
  (`cloudflareinsights.com`) are now allowed explicitly; both are
  Cloudflare's own fixed first-party code and add no inline/eval allowance.
  Switching the injection off is a dashboard setting — the owner's call, not a
  code change.
- **Credential changes are apex-only.** `change-password`, `change-email` and
  `google/link` sit behind the same `requireMainHost` guard as `/api/admin/*`
  (a merchant host carries the visitor's cookie and needs none of them);
  sign-in stays available on every storefront.
- **A first password needs a fresh sign-in.** A Google/Telegram account has no
  password to prove; a session cookie alone is not proof of presence. Setting
  the first password, or changing the email of a Telegram-only account, now
  requires a sign-in within the last ten minutes (`REAUTH_REQUIRED`).
- **Studio dependencies.** `npm audit fix` (non-breaking) applied; 17 advisories
  remain, all in the build toolchain (`vite`, `ws`, `wrangler`, `miniflare`,
  `@cloudflare/vite-plugin`, `next`) and each requires a major/forced upgrade.
  The verifier confirmed none is reachable from untrusted input in the deployed
  Worker: `fflate` runs only in the uploader's own browser tab with hard
  expansion limits; the server upload path never decompresses; `undici` and
  `fast-uri` are off the Workers runtime path.

## Confirmed sound (positive results)

- No IDOR: every handler that reads or writes a row by id enforces ownership
  (25 routers reviewed; a second, independent 478-handler guard survey agreed).
- No SQL injection: every query binds parameters; the two sort maps were the
  only interpolation and are now own-property lookups.
- No XSS sink: the one `dangerouslySetInnerHTML` renders constant SVG; the
  document renderers escape.
- Secrets, costs, source maps: none in the browser bundle.
- Telegram webhook: authenticated, timing-safe, fails closed.
- Rate limits: present on every sensitive mutating endpoint, keyed on values a
  caller cannot forge.

## Completed after the owner's approval, and what was reverted

The owner approved the two deferred items. One shipped; the other was attempted,
failed adversarial re-review twice, and was reverted rather than shipped with a
regression.

- **Admin withdrawal path — SHIPPED.** The legacy `/wallet-requests/:id/decide`
  now refuses a hold-backed withdrawal (`USE_WITHDRAWAL_WORKFLOW`), so a ledger
  row can no longer be flipped with its hold left active; the wallet-request
  lists carry the workflow row, and both admin panels drive
  `/api/wallet/admin/withdrawals/:id/{approve,processing,paid,reject,fail}` —
  a payout only with the transfer's reference, and a reconciliation finding
  recorded before a parked transfer can be marked paid or failed. Deposits and
  pre-holds rows are decided as before. Tests: `tests/adminWalletDecide.test.ts`.

- **CSP on the live site — SHIPPED.** Workflow `28 - Verify Live Security
  Headers + CSP` (`scripts/e2e-security-headers.mjs`) proves, read-only, that
  the document, an SPA route, an asset and the API all carry the headers with
  one policy text and that a real browser opens the public pages with zero
  violations.

- **Account enumeration at `/register` (Low) — SHIPPED, pre-launch, in the
  form the audit recommended.** Two earlier implementations were built and each
  was caught by an adversarial re-review as introducing a HIGH the original LOW
  did not have (an unconfirmed account kept in `users` behind a flag re-leaked
  the answer through the username and let a stranger fix a password the owner
  would confirm; a `pending_signups` row that CARRIED a password still let
  whoever submitted the sign-up choose the password the inbox owner would
  "confirm"). Both were reverted. The shipped design removes the root cause of
  both: the password is set by the CONFIRMING request, never by `/register`.

  With a mail provider configured (`emailFirstSignup` in `/api/auth/capabilities`):
    - `POST /api/auth/register` stores only the profile (address, requested
      handle, name, country, language, referral) in `pending_signups`
      (migration 0051 — the table has NO password column), mails a
      "finish creating your account" link to `/auth?finish=TOKEN`, opens no
      session and answers the identical `{pending_email: true}` body whether
      the address is free or taken; a taken address instead receives an
      "account exists" notice, once per address per day. Both branches do one
      lookup, two writes and one queued mail. A pending sign-up never claims a
      username, so `/username-available`, `/login`, the referral count and the
      admin list see nothing. Per-address limit 5/h on top of the IP limit.
    - `GET /api/auth/signup/pending?token=` shows the finish page the pending
      profile without spending the link (a mail scanner's GET burns nothing).
    - `POST /api/auth/signup/complete {token, password}` validates and hashes
      the password FIRST (a weak password never burns the link), claims the
      row with one DELETE (of two concurrent completions exactly one wins),
      creates the account born verified, claims the handle only if still free
      (else null → onboarding asks), binds the referral, opens the session.
      An address that gained an account another way meanwhile → 409
      `ALREADY_REGISTERED`, no session. Every dead link (unknown, expired,
      superseded, used) is one generic 400 wording.
    - The latest attempt per address wins: a planted sign-up's link dies the
      moment the owner signs up, and it never carried a password anyway.
  Without a mail provider the pre-existing behaviour stays (immediate account,
  password required, 409 `EMAIL_TAKEN`) — development and tests only. The
  sign-up page hides its password fields in email-first mode and shows a
  "check your email" step; the finish screen is a sibling of the
  `/auth?reset=TOKEN` screen. Tests: `tests/registerEmailFirst.test.ts`
  (15 cases: nothing in `users`, no password column, identical taken/free
  bodies, no handle claimed, one notice a day, no takeover, read-without-spend,
  weak password keeps the link, single use, handle fallback, handle override,
  address raced, expiry, member link opens no session, Kurdish mail on the
  trusted origin, capabilities flag, no-mail fallback).

- **Re-review of the 2026-09-05 batch (orders, warranty centre, email-first
  sign-up, pricing offsets) — one HIGH found and fixed before deploy.** Two
  independent adversarial reviewers read the six commits.
    - HIGH — device takeover through a guessed receipt number. The one-account-
      per-device change had let ANY signed-in user link a device nobody had
      linked yet by typing its serial or its receipt number (`WR-YYYY-MMDD-NNN`,
      a per-day counter), then open the buyer's receipt document (name, phone,
      address, email, price, full serial) and file claims on it. Fixed: a
      never-linked device belongs to the account that bought it; a stranger may
      link a device only after its holder — or an admin — RELEASED it (a revoked
      registration), which is the transfer the owner described. A later holder's
      copy of the receipt is redacted (no customer block, no price) and carries
      no buyer order id; the refusal does the same database work whether the
      serial exists or not. Tests: `tests/deviceRegistration.test.ts` (never-
      linked device refused by serial, receipt and QR link; redacted holder copy;
      no buyer order id to a holder).
    - LOW — device admin routes reachable on merchant subdomains → now behind
      `requireMainHost` too (test: a merchant host answers 404 to an admin).
    - LOW — referral planting on pending sign-ups → the finish page shows the
      pending code and sends back what the person kept; an empty value removes
      it (tests: dropped and kept).
    - LOW — sign-up mail volume → a per-address daily cap (12) on top of the
      hourly one, applied before the free/taken branch (test).
    - LOW — serial-lookup timing → equalised.
    - Migration 0051 now rebuilds `pending_signups` (`DROP TABLE IF EXISTS` then
      `CREATE`) so a database that ran the reverted draft cannot keep its
      password column.
  Everything else attacked was found sound: identical sign-up bodies and limits
  on both branches, no handle claimed by a pending sign-up, single-use atomic
  completion that never opens a session into an existing account, CSRF origin
  check on every new state-changing route, parameterised `IN (...)` builders,
  masked serials and no holder identity in customer payloads, cost fields
  stripped everywhere public, member prices clamped at or below regular.

- **`/telegram/complete` email oracle (Medium) — SHIPPED (independent of the
  above).** The email-taken check ran before the OTP was consumed, so one
  verified phone challenge could probe many addresses. It is moved to the
  post-OTP insert (via the existing `UNIQUE(users.email)` handler), so each
  probe now burns a fresh code.

## Evidence

- `npm run test:unit`: 1350 tests, 0 failures (baseline 1304; 46 added).
- `npm run check`: 0 errors (typecheck ×3, eslint, Studio typecheck).
- `studio`: `npm test` — 223 pass, 0 fail, 1 pre-existing skip (signed APK).
- `npm run build`: succeeds; `dist/_headers` written.
- Live probe on `wrangler dev`: before the fix the document had no
  `X-Frame-Options`, `Content-Security-Policy` or `Strict-Transport-Security`
  while `/api/health` had all three; after the fix all responses carry them.
- Browser smoke (Playwright, Chromium) on `/`, `/auth`, `/products`,
  `/community`, `/cart`, `/settings`, `/warranty/*`: 0 CSP violations, all
  pages rendered. Console errors were the sandbox proxy resetting external
  connections (fonts, Google), which is a network failure, not a policy block.

Not deployed. Production deployment needs the owner's explicit approval
(`deploy-staging-code.yml`, which applies migration 0049 before the code).

## Phase 0 follow-up — 2026-09-07 (architecture-assessment findings)

Five defects surfaced by the architecture assessment were first CONFIRMED with
executable repros against the real routes and the real migrations, then fixed
at the root on this branch. Each fix carries a permanent regression test that
fails on the old code. Nothing was deployed and no live row was rewritten.

### P0-1. P0 (money) — a committed purchase hold never posted its ledger debit

**Where.** `worker/lib/walletOps.ts` (`commitHold`), `worker/routes/storeOrders.ts`
(wallet-paid store orders), `worker/lib/escrowOps.ts` (`releaseEscrow`,
`refundEscrow`).

**Cause.** `wallet_holds` is the reservation book and `wallet_transactions` the
ledger; `effectiveHoldsUsdSql` subtracts only ACTIVE holds from the spendable
balance. `commitHold` without a `txId` flipped `state` to `committed` and wrote
no `withdrawal` row, so the moment a store order or an escrow release
"committed" the hold, the buyer's whole balance was spendable again while the
merchant's payout ledger was credited. A customer cancel then posted
`wtx_refund_<order>_usd` for money that had never left — the buyer ended ABOVE
the original deposit. A partial escrow refund did the same and additionally
credited the refunded part (net minting). The platform checkout
(`usdSpendStatement`) was already correct.

**Fix.** The settlement rule: a committed purchase hold posts its debit in the
same transaction or does not commit. `commitHoldStatements()` returns two
statements — an approved `withdrawal` row with the deterministic id
`wtx_hold_<holdId>` whose amount becomes -1 (CHECK abort of the whole batch)
unless the hold is an active, unlinked, still-funded purchase hold, and the
flip that links the hold to that row through `tx_id`. `commitHold` wraps them
in one batch (guard aborts are classified; any other failure propagates).
`storeOrders` appends them to the order batch, so order, merchant share and
debit commit together. `releaseEscrow` and `refundEscrow` are each ONE batch;
every merchant credit is conditional on `FUNDED_BY_HOLD` ("the customer's debit
is posted and linked to this hold"), and a full refund's hold release is fenced
(`assertHoldStateStatement`) so a refunded escrow can never sit over kept money.
A partial refund is the full debit plus a credit of the refunded part, so the
net equals what the merchant receives. Reconciliation
(`walletReconciliationReport`, `GET /api/wallet/admin/reconciliation`, the cron
report in `lib/jobs.ts`) now reports `committed_hold_without_debit` anomalies
and a `committed_holds_without_debit` count.

**Legacy rows.** Holds committed before this rule (`state='committed'`,
`tx_id IS NULL`) are only REPORTED by reconciliation; nothing rewrites them and
no migration touches existing rows. Whether and how to reconcile the live data
is the owner's decision (DECISIONS row 98).

**Test.** `tests/walletHoldSettlement.test.ts` (10): debited exactly once at
placement; place → cancel returns exactly the deposit; a failed order batch
leaves the hold active and the retry settles once; `commitHold` replays without
a second debit and refuses withdrawal/unfunded holds; escrow release debits
once and pays in the same batch; partial refund nets correctly; full refund
releases; a sabotaged hold refuses the whole settlement (merchant never
credited); a transient failure writes nothing on either side; the legacy leak
row is reported and untouched.

### P0-2. HIGH (authz) — platform-admin surfaces answered on merchant subdomains

**Where.** `worker/lib/http.ts` (`requireAdmin`), every router using it outside
`/api/admin/*`: `/api/kyc/admin/*`, `/api/telegram/admin/*`,
`/api/support/admin/*`, `/api/policies/admin/*`, `/api/wallet/admin/*`,
`/api/referrals/admin/*`, `/api/reviews/admin/*`, plus the inline-guarded
routes in `returns.ts`, `invoices.ts` and `misc.ts` (`/translate`).

**Cause.** The apex-only host guard was a prefix middleware
(`app.use('/api/admin/*', requireMainHost)`); `requireAdmin` checked the role
and never the host. The session cookie is scoped to the parent domain, so a
page on `somestore.levonis-iq.com` is same-origin with its API and carries a
visiting admin's own session.

**Fix.** The host rule is part of admin authorisation itself: `requireAdmin`
first checks `adminAllowedOn(host)` — using the classification
`worker/index.ts` sets, or classifying the Host header against the configured
root domain when a router is mounted without that middleware — and answers the
same `404 Not found` as `requireMainHost`. Apex, `www`, localhost, preview and
unconfigured-root hosts still pass (`adminAllowedOn` unchanged);
`requireMainHost` is unchanged and stays on `/api/admin/*` and the credential
routes; merchant dashboard routes (`merchantAuth`) are unaffected.

**Test.** `tests/adminHostGuard.test.ts` (4): discovers every admin route from
`worker/index.ts` and `worker/routes/*.ts` (225 routes: `/api/admin` mounts,
router-wide / sub-path / inline `requireAdmin`, any `/admin` segment), drives
the REAL Worker entry point with a real session row and cookie, and asserts
404 on the merchant host for all of them and reachability on the apex for all
of them (plus 200 on the seven that leaked); a customer session gets 403 on the
apex and 404 on the merchant host.

### P0-3. HIGH (money) — `POST /api/admin/wallet/credit` had no scope, no idempotency, no rate limit

**Where.** `worker/routes/admin.ts`.

**Cause.** Any admin — an `assistant` included — could mint up to the maximum;
a double submit credited twice; 25 rapid calls all succeeded.

**Fix.** `canViewFinancials` is required (403 `FINANCIAL_SCOPE_REQUIRED`, the
farm's wording); `rateLimit(c, 'admin-credit', 20, 3600)` per admin; a required
`idempotencyKey` (8–80 chars) with the ledger id derived from
`sha256(adminId:key)` and a conditional INSERT — the second identical submit
returns the same id with `replayed: true` and credits nothing; the same key with
a different payload is 409 `IDEMPOTENCY_KEY_REUSED`; the key is on the audit
row. There is no caller of this route in `src/` (verified by grep), so no UI
change was needed; any script using it must now send `idempotencyKey`.

**Test.** `tests/adminWalletCredit.test.ts` (7).

### P0-4. MEDIUM (money) — order cancellation was two transactions

**Where.** `worker/routes/orders.ts` (`POST /:id/cancel`), `worker/routes/admin.ts`
(`PATCH /orders/:id` → `cancelled`), new `worker/lib/orderCancelOps.ts`,
`worker/lib/orderInventory.ts` (`planOrderReturn`).

**Cause.** The customer route flipped the status with a standalone `.run()` and
posted the refund from a later batch; a failure in between left a cancelled,
unrefunded order that the `status === 'pending'` guard then refused to retry.
The admin cancel had the same shape and — verified — never flipped
`points_reservations` nor cancelled the pending accrual.

**Fix.** `cancelledOrderRefundStatements()` builds the wallet and points
refunds (idempotent on `wtx_refund_<order>_usd|_pts`, amount -1 → CHECK abort
when the order is not cancelled), the reservation flip, the accrual
cancellation and a NOT-NULL fence on `orders.status` that aborts the batch
whenever the flip matched zero rows. Both routes run the conditional flip, the
planned stock return and these statements in ONE `db.batch`; a lost flip is a
400, a transient failure leaves the order untouched and retryable.

**Test.** `tests/orderCancelAtomic.test.ts` (4): injected batch failure leaves
the order pending and unrefunded and the retry refunds exactly once; a flip
that loses to a concurrent transition writes nothing; admin cancel refunds,
returns the reservation and cancels the accrual, and a re-open → cancel does
not double-refund; admin cancel under failure / stale edit writes nothing.

### P0-5. MEDIUM (money) — the legacy deposit decision bypassed the deposit service

**Where.** `worker/routes/admin.ts` (`POST /wallet-requests/:id/decide`),
`src/components/AdminWalletRequests.tsx`, `src/components/AdminOverview.tsx`.

**Cause.** The legacy route approved deposits with a plain UPDATE, skipping
`decideDeposit`'s `amount_mismatch` refusal, the dedup-slot release on
rejection and the Telegram message close — and both admin screens still called
it for deposits.

**Fix.** USD deposit decisions on the legacy route delegate to `decideDeposit`
(same refusals: 409 `AMOUNT_MISMATCH`, 400 `REASON_REQUIRED`; same side
effects, message close and customer notice in the background); the response
shape stays `{ success: true }`. Withdrawals filed before the holds engine (no
`wallet_withdrawals` row — the only other kind the legacy list carries) keep
the legacy path. Both screens now call
`/api/wallet/admin/deposits/:id/approve|reject` for deposit rows (a rejection
requires a written reason) and the legacy decide only for pre-holds
withdrawals.

**Test.** `tests/depositDecideGuard.test.ts` (5).

### Behaviour changes the owner should know about

- Wallet-paid store orders now really charge the buyer at placement (one
  approved `withdrawal` row, `wtx_hold_<holdId>`), and an escrow release or
  partial refund really debits the customer. Balances shown after these events
  drop by the purchase amount, as they should have.
- Merchant credits in `merchant_payout_ledger` are only ever written in a batch
  where the customer's debit posted. An escrow whose hold cannot settle (a hold
  released out of band) refuses the release with `WALLET_ERROR` instead of
  paying the merchant.
- Rejecting a deposit — on either screen or through the legacy route — now
  requires a reason of at least 3 characters.
- An `assistant`-scope admin can no longer credit wallets; every manual credit
  needs an `idempotencyKey`.
- Admin surfaces outside `/api/admin/*` answer 404 on merchant subdomains for
  everyone (previously 200 for an admin session, 401/403 for others).
- Committed holds without a debit from before this change are listed by
  `GET /api/wallet/admin/reconciliation` (`committed_hold_without_debit`) and
  counted by the hourly job; they are not repaired.

### Evidence (this section)

- `npm run test:unit`: 1734 tests, 0 failures (baseline 1704; 30 added across
  the five new suites).
- `npm run check`: 0 errors (typecheck ×3, eslint — 120 pre-existing warnings,
  Studio typecheck clean).
- `npm run build`: succeeds; `dist/_headers` written.
- `node scripts/migrate-check.mjs --twice`: all 54 migrations apply, second
  pass a no-op, 0 foreign-key violations. No migration was added.
