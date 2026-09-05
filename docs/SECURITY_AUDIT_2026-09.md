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
  https://accounts.google.com` — no inline, no eval — so an injected script
  does not run even if React's escaping ever fails on merchant-controlled text
  (the storefront serves the platform's own bundle on merchant subdomains; the
  injection attacker found no XSS sink, which is why the verifier refuted the
  "malicious merchant JS" scenario). Print documents carry their own policy
  naming their one inline auto-print script by hash, pinned by test. Google
  sign-in, the fonts, vendor-CDN product media and blob previews are allowed
  explicitly. Browser smoke on seven pages: zero CSP violations, every page
  rendered.
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

## Completed after the owner's approval

- **Account enumeration at `/register`** (Low) — closed, at the root. An
  email sign-up now creates NOTHING in `users` until the emailed link proves
  the inbox; the attempt waits in `pending_signups` (migration 0050, keyed by
  address so the latest attempt wins). A free address and a taken one return
  the identical body, open no session and do the same password work, and
  neither claims a username — so nothing anywhere (the response,
  `/username-available`, `/login`, the referral count) reveals whether the
  address has an account; only its owner learns, by reading the inbox (a
  confirmation link, or an "account exists" notice — one per address per day).
  `/verify-email/confirm` is the only place the account and its username are
  created, and the only sign-up path that opens a session; a member's own
  verification link never does. A first attempt that kept the unconfirmed
  account in `users` behind a `signup_verification_required` flag was caught by
  an adversarial re-review (below) as WORSE than the original — it leaked the
  answer through the username and let a stranger's first attempt fix a password
  the owner would confirm — and was replaced by this `pending_signups` design.
  Legacy accounts are untouched; a deployment without a mail service keeps the
  old immediate-session behaviour. Test: `tests/registerEmailFirst.test.ts`.
  The same reusable email oracle in `/telegram/complete` (one verified phone
  challenge could probe many addresses because the check ran before the OTP was
  consumed) is closed by moving the collision to the post-OTP insert, so each
  probe burns a fresh code.

- **Admin withdrawal path.**- **Admin withdrawal path.** The legacy `/wallet-requests/:id/decide` now
  refuses a hold-backed withdrawal (`USE_WITHDRAWAL_WORKFLOW`), so a ledger row
  can no longer be flipped with its hold left active; the wallet-request lists
  carry the workflow row, and the admin panels drive
  `/api/wallet/admin/withdrawals/:id/{approve,processing,paid,reject,fail}`
  — payout only with the transfer's reference. Deposits and pre-holds rows are
  decided as before. Test: `tests/adminWalletDecide.test.ts`.
- **CSP on the live site.** Workflow `28 - Verify Live Security Headers + CSP`
  (`scripts/e2e-security-headers.mjs`) proves, read-only, that the document,
  an SPA route, an asset and the API all carry the headers with one policy
  text, and that a real browser opens the public pages with zero violations.

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
