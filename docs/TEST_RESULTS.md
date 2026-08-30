# Test results

Newest phase first. A section is filled in **only from a real run**: no number
here is ever copied from a projection, an older report, or a suite that was not
executed. `skipped` is never counted as a pass.

## Phase: §12 acceptance matrix (batch 6) — LOCAL run 2026-08-30

**Executed.** Environment: local `wrangler dev` on `http://127.0.0.1:8787`
serving the freshly built `dist/`, local D1 migrated through `0025`, Chromium
at `/opt/pw-browsers/chromium`. Commit `bb20b46` on
`claude/new-session-2hq4ci`. This is a LOCAL run: it says nothing about what
`https://levonis-iq.com` was serving at the time.

```
npx wrangler d1 migrations apply levonis-db --local
npm run check
npm run test:unit
npm run build
node scripts/migrate-check.mjs --twice
node scripts/migrate-check.mjs --from <copy of the local db> --twice
npx wrangler dev --port 8787
node scripts/e2e-permissions.mjs
node scripts/e2e-images.mjs
node scripts/e2e-import.mjs
node scripts/e2e-import-ui.mjs
node scripts/e2e-product-form.mjs
node scripts/e2e-subscription.mjs
```

| Suite | Passed | Failed | Notes |
|---|---:|---:|---|
| `npm run check` | — | 0 errors | 119 pre-existing `no-explicit-any` warnings, unchanged |
| `npm run test:unit` | 504 | 0 | was 473 at the start of this batch |
| `migrate-check --twice` (fresh) | — | 0 | 94 tables · `foreign_key_check` 0 · orphan catalogs 0 · second pass applied 0 files · `0025` re-ran its 2 statements with no row added and no value changed |
| `migrate-check --from <copy> --twice` | — | 0 | 95 tables · `foreign_key_check` 0 |
| `scripts/e2e-permissions.mjs` | 46 | 0 | **new** — §11 over real HTTP, raw response bytes |
| `scripts/e2e-images.mjs` | 78 | 0 | **new** — the gallery at 390 / 768 / 1024 |
| `scripts/e2e-import.mjs` | 61 | 0 | |
| `scripts/e2e-import-ui.mjs` | 44 | 0 | |
| `scripts/e2e-product-form.mjs` | 67 | 0 | |
| `scripts/e2e-subscription.mjs` | 73 | 0 | |
| **browser + API total** | **369** | **0** | |

Three defects were found by writing these suites and fixed in the same batch —
an assistant admin could not save any product carrying a cost, §5's two
write-time price rules were never enforced anywhere, and six controls in the
image panel were 36px against §1's 44–48px. The row-by-row mapping from each
§12 requirement to the file that proves it is in `docs/ACCEPTANCE.md`.

Still reported as open, not as passes: `plus_12mo` has no price (so PLUS is not
purchasable), and migration 0022's image backfill moved zero rows.

## Phase: integrated mandate (accounts · referrals · points · wallet) — LOCAL run 2026-08-29

**Executed.** Environment: local `wrangler dev` on `http://127.0.0.1:8787`
serving the built `dist/`, local D1 wiped and migrated `0001 → 0017`, Chromium
via playwright-core 1.62.1. Base commit `4e91d71` **plus the uncommitted
integration working tree** (the integrator's wiring pass — see
`docs/INTEGRATED_VERIFY.md` §1 for exactly what changed). Not a staging run and
not the production domain: nothing here says anything about
`https://levonis-iq.com`.

```
rm -rf .wrangler/state && npx wrangler d1 migrations apply levonis-db --local
npm run check
npm run test:unit
npx wrangler dev --ip 127.0.0.1 --port 8787
node scripts/api-tests.mjs
node scripts/api-tests-v2.mjs
node scripts/api-tests-v3.mjs
node scripts/api-tests-v4.mjs
node scripts/e2e-integrated.mjs   # this mandate's browser pass
node scripts/e2e-ui.mjs           # previous-phase regression
```

| Suite | Passed | Failed | Not executed | Blocked | Environment | Commit |
| --- | --- | --- | --- | --- | --- | --- |
| `npm run check` (typecheck) | 0 errors | 0 | — | — | local | 4e91d71 + working tree |
| `npm run test:unit` | 325 | 0 | — | — | local | 4e91d71 + working tree |
| Base (v1) | 60 | 0 | — | — | local dev + D1 | 4e91d71 + working tree |
| Products / memberships (v2) | 37 | 0 | — | — | local dev + D1 | 4e91d71 + working tree |
| Final phase (v3) | 118 | 0 | 0 | 9 | local dev + D1 | 4e91d71 + working tree |
| **Integrated mandate (v4)** | 147 | 0 | 5 | 7 | local dev + D1 | 4e91d71 + working tree |
| Browser (`e2e-integrated`) | 43 | 0 | 1 | 1 | Chromium 390×844 / 1024×768 / 1280×800 | 4e91d71 + working tree |
| Browser (`e2e-ui`, regression) | 38 | 0 | 0 | 0 | Chromium 390×844 | 4e91d71 + working tree |

Totals: **768 passed, 0 failed, 6 not executed, 17 blocked.**

Re-run caveat: v3 reports 117/10 instead of 118/9 on a database that already
holds a published policy — its "policy list is honestly empty before
publishing" check blocks itself rather than pretending. The 118/9 line above is
the wiped-database run.

The per-scenario detail required by mandate §14 (scenario · expected · actual ·
environment · evidence), the screenshot inventory, and the full BLOCKED /
NOT-EXECUTED lists with their reasons live in **`docs/INTEGRATED_VERIFY.md`** —
they are not duplicated here so the two can never drift apart.

Still blocked after this run (unchanged by it, and never counted as passes):
live OTP delivery and the Telegram group approval buttons (`docs/DECISIONS.md`
row 26), live e-mail verification and reset (row 14), Google Console origins
(row 28), the withdrawal payout channel (§13.1 — **no register row yet**), COD
eligibility (§13.3 — **no register row yet**), the support-gift repeat policy
(row 11) and the points rule's commercial effective date (row 20).

## Phase: auth & UI fixes — STAGING run 2026-08-28 (commit acdba80)

Same workflow, all three suites against the live staging worker after the
auth/UI overhaul (migration 0011 applied): base **60/60**, v2 **37/37**,
v3 **117 passed, 0 failed, 7 blocked** — two MORE passes than the local
run because staging's real TELEGRAM_BOT_TOKEN lets the sign-in deep-link
checks execute (opaque link, masked phone, Arabic-digit input). Locally
the same commit measured: typecheck 0, unit 138/138, 60/60, 37/37,
115/0/9, plus the new browser suite scripts/e2e-ui.mjs **37/37**
(pixel-sampled proof the bottom-corner glow is gone; evidence in
docs/UI_FIX_EVIDENCE.md + docs/evidence/).

Owner-external items for this phase: Google Console origins
(docs/GOOGLE_SIGNIN_FIX.md) and a real-device Telegram sign-in pass on
staging.

## Phase: final phase (v3) — STAGING run 2026-08-28 (live Cloudflare)

Workflow `2 - Deploy Staging + Tests` on commit `5e427d9` deployed
migrations 0001–0010 + both new secrets to the staging worker and ran all
three suites remotely against
https://levonis-staging.just-randoomis.workers.dev:

| Suite | Result |
| --- | --- |
| Base (v1) | **60 passed, 0 failed** — Telegram admin-notify sent=true, Google signature verification active |
| Products/memberships (v2) | **37 passed, 0 failed** — incl. the CONFIRMED rule: PRO delivery NOT waived without an approved default address |
| Final phase (v3) | **114 passed, 0 failed, 6 blocked** — two more passes than local because the REAL staging `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET` let the deep-link issuance and the live webhook forgery-rejection (403) + update_id dedupe checks run |

Live-verified highlights: 5 printers + 1 AMS → 6 units with independent
serials; registration never restarts the warranty clock; +36 months from
2024-02-29 clamps to 2027-02-28; 75,000 charged / 75,001 free at the
approved address only; alternate address ordinary + automatic restore;
checkout refused while a printer fee is honestly unconfigured
(SHIPPING_NEEDS_CONFIG); one invoice per order under replay, honest
cod_due; consent enforced the moment terms were published; KYC gated
behind Telegram phone verification; PRO ticket priority ranked in the
admin queue; the full cross-user IDOR battery passed. Test admin accounts
were demoted afterwards (changes: 3).

Remaining blocked (owner action, per docs/DECISIONS.md): email end-to-end
(row 14 — Resend secrets), price-protection payout channel (22), printer
fee mapping + carton (3/16), BNPL rules (10/21), and the full KYC cycle
(manual staging step needing a real Telegram-verified phone + synthetic
documents).

## Phase: final phase (v3) — integrated, local run 2026-08-28

All suites ran against `wrangler dev` (fresh D1 via migrations 0001–0010,
then repeated on the same persistent database to prove idempotency). Local
`.dev.vars` supplied SYNTHETIC `TELEGRAM_WEBHOOK_SECRET`/`KYC_ENC_KEY`
values so those code paths execute locally — never the owner's real values.

| Check | Command | Result |
| --- | --- | --- |
| Unit tests (pricing/shipping/phone/warranty/points/sealbox/telegram/email/reviews/policies/support) | `npm run test:unit` | **93 passed, 0 failed** |
| TypeScript (frontend + worker strict) | `npm run check` | PASS (0 errors) |
| Production build | `npm run build` | PASS |
| Base API suite | `node scripts/api-tests.mjs` | **60 passed, 0 failed** (also re-run after policies were published — consent attached automatically) |
| v2 API suite | `node scripts/api-tests-v2.mjs` | **39/39 fresh · 37/37 persistent**, incl. the corrected CONFIRMED PRO-delivery assertion |
| v3 final-phase suite, fresh DB | `node scripts/api-tests-v3.mjs` | **112 passed, 0 failed, 8 blocked** |
| v3 re-runs on the persistent DB ×3 | same | **112 passed, 0 failed, 8 blocked** each — policy-consent, gift-pool and register-bucket idempotency fixed and verified |

Blocked rows (honest unconfigured preconditions, never counted as passes):
Telegram bot token absent locally (live private-chat delivery is a staging
check), Resend keys absent locally, printer 25k/50k fee mapping + carton
fee + BNPL + price-protection payout channel + KYC retention pending owner
decisions (docs/DECISIONS.md rows 3/10/16/21/22/24), full KYC cycle needs a
Telegram-verified phone (manual staging step with synthetic documents).

Restriction gating is live: an active restriction case's benefit flags now
gate `worker/lib/entitlements.ts` benefit checks, checkout PRO context,
shipping waiver, order priority and ticket priority — pausing benefits
never touches orders, wallet, warranty, support access or the paid
membership record.

## Phase: final phase (v3) — original pre-integration note

The final-phase acceptance suite exists at `scripts/api-tests-v3.mjs`
(Telegram linking/webhook/OTP, email verification + one-invoice-per-order,
serialized devices & per-unit warranty, reviews/quality-score/gift levels,
points 999/1000/1999, returns 7-day window, price protection,
PRO free-delivery rule at the approved address, checkout policy consent,
KYC honest-unconfigured branch, deterministic support assistant + PRO queue
priority, and the cross-user IDOR battery). It reports **passed / failed /
BLOCKED** distinctly — a check whose precondition is honestly unconfigured
(no `TELEGRAM_WEBHOOK_SECRET`, no `KYC_ENC_KEY`, unpriced printer/carton
fees per `docs/DECISIONS.md`) records as blocked-with-reason, not as passed.

**No results are recorded here yet.** The suite has not been executed —
route mounting in `worker/index.ts` and the `awardOrderPoints` delivered-
transition wiring land at integration, and the numbers will be filled in
from a real run against `wrangler dev` (and then staging) at that point.
Skeleton to be completed after the run:

| Check | Command | Result |
| --- | --- | --- |
| Unit tests (all `tests/*.test.ts`) | `npm run test:unit` | _pending integration run_ |
| TypeScript (frontend + worker strict) | `npm run check` | _pending integration run_ |
| Base API suite | `node scripts/api-tests.mjs` | _pending integration run_ |
| v2 API suite (incl. corrected PRO-delivery assertion) | `node scripts/api-tests-v2.mjs` | _pending integration run_ |
| v3 final-phase suite, fresh DB | `node scripts/api-tests-v3.mjs` | _pending integration run (passed / failed / blocked to be reported distinctly)_ |
| v3 final-phase suite, persistent DB re-run | `node scripts/api-tests-v3.mjs` | _pending integration run_ |

The v2 change to note for the next run: the former check
`PRO free delivery applied (shipping 0)` was wrong under the CONFIRMED
owner rule (`docs/DECISIONS.md` row 15) — that buyer has no approved
default PRO address, so it is now
`PRO delivery not waived without approved default address (5000)`.

---

## Phase: products & memberships (v2) — 2026-08-28

All checks below ran against `wrangler dev` (local D1/R2) on the current
branch head; the same two API suites run automatically against staging in
workflow `2 - Deploy Staging + Tests`.

| Check | Command | Result |
| --- | --- | --- |
| Unit tests (pricing / shipping / phone) | `npm run test:unit` | **28 passed, 0 failed** |
| TypeScript (frontend + worker strict) | `npm run check` | PASS (0 errors) |
| Base API suite | `node scripts/api-tests.mjs` | **60 passed, 0 failed** (also re-run on a used database: 60/60) |
| v2 API suite, fresh DB | `ALLOW_LAUNCH_ACTIVATION=1 node scripts/api-tests-v2.mjs` | **39 passed, 0 failed** (includes the global launch-activation endpoint + idempotent re-activation) |
| v2 API suite, persistent DB (launch already active) | `node scripts/api-tests-v2.mjs` ×3 | **37 passed, 0 failed** each run — the 2 launch-endpoint tests skip by design; purchase-state assertions adapt to the live launch state |
| v2 API suite, persistent DB (launch NOT active — staging simulation) | `node scripts/api-tests-v2.mjs` | **37 passed, 0 failed**; the suite activated only its own test membership via SQL and `launchConfig.activated` remained `false` afterwards (verified by direct query) |

The v2 suite covers: brands/catalogs CRUD + scoped ordering, products-v2
editor round-trip, the price resolver (null-inheritance, PRO clamp,
transport commission, warranty fees), TXT template export→parse→apply
round-trip, extraction-v2 admin/SSRF gates, membership plans (unpriced
PLUS rejected with `PLAN_UNPRICED`), PRO purchase + idempotent replay,
prepaid-pending-launch vs active states, referral code issuance, PRO
checkout entitlements (commission waived, warranty fee kept, free
delivery, tier snapshot on the order), and the community PLUS/PRO gate.

Rate limiting is now keyed **per user id when authenticated** (IP only for
anonymous endpoints) — Iraqi carrier NAT puts many customers behind one
IP, and the old IP-only bucket also made repeated test runs interfere.
Anonymous limits (login, register, forgot-password) still key by IP.

Staging note: the workflow runs the v2 suite **without**
`ALLOW_LAUNCH_ACTIVATION`, so the owner's staging launch configuration is
never flipped by tests.

---

# Test results (Phase 1, local)

Everything below ran locally against the emulated Cloudflare stack
(`wrangler dev` with local D1/R2 via Miniflare). **No live/production
Cloudflare resources were touched.** Live integration tests are Phase 3.

## Environment

- Node 22, npm 10, wrangler 4.127 (local emulation), date: 2026-08-28
- Commands used are reproducible from the repo root.

## 1. Dependency install & audit

| Check | Command | Result |
| --- | --- | --- |
| Install | `npm install` | OK (clean tree, single lockfile) |
| Vulnerabilities | `npm audit` | **0 vulnerabilities** |

## 2. Type checks & build

| Check | Command | Result |
| --- | --- | --- |
| Worker TypeScript (strict) | `tsc --noEmit -p worker/tsconfig.json` | PASS (0 errors) |
| Frontend TypeScript | `tsc --noEmit` | PASS (0 errors) |
| Production build | `npm run build` | PASS (`vite build`, 2798 modules; main JS chunk 1.37 MB / 382 KB gzip — code-splitting noted as a future improvement) |

## 3. API / security test suite — `node scripts/api-tests.mjs`

58 automated checks against `wrangler dev` (migrations applied with
`npm run db:migrate:local` first). **Result: 58 passed, 0 failed.**
(The suite has since grown to 60 checks — current results are in the
v2 phase section at the top of this file.)

Covered, with the exact assertions in `scripts/api-tests.mjs`:

- **Removed attack surface**: `/api/d1/query`, `/api/d1/init`,
  `/api/make-all-investors` all return 410; health OK.
- **Auth**: register/login/logout; weak password rejected (400); duplicate
  email rejected (409); wrong password rejected (401); session cookie
  restores the user; logout revokes the session server-side;
  forgot-password returns an honest 503 while no email provider is
  configured.
- **Authorization**: anonymous cart/wallet → 401; non-admin admin API
  (overview, product create, role change) → 403; non-investor invest
  portal → 403; a freshly registered user is not admin.
- **Products**: admin create; public listing/detail; internal cost price
  never appears publicly; hidden products vanish from list and detail
  (404) — no leak through the detail endpoint.
- **Checkout**: server-computed totals (2×10,000 IQD + 5,000 IQD shipping
  = 25,000 IQD asserted); idempotency-key replay returns the same order
  instead of double-charging; stock decremented atomically; oversized
  quantities rejected; invalid delivery method rejected; advance payment
  without wallet balance rejected with `INSUFFICIENT_BALANCE`.
- **IDOR**: another account cannot read or cancel someone else's order,
  edit their address, fetch their receipt file, or approve wallet
  requests.
- **Uploads**: valid PNG accepted into an owner-scoped `receipts/` key;
  content sniffing rejects a fake `.png`; product-media upload rejected
  for non-admins.
- **Wallet review**: deposit requires an uploaded receipt and stays
  `pending` (balance unchanged); admin approval credits the balance
  exactly once (double-decide rejected); withdrawal above balance
  rejected.
- **Refunds**: cancelling a pending order restores wallet money; a second
  cancel is rejected (no double refund).
- **Rewards**: daily check-in credits once; the same-day repeat returns
  409; points balance reflects a single credit.

## 4. What these tests do NOT cover (honest scope)

- Live Cloudflare behavior (real D1/R2 latency, Workers CPU limits,
  workers.dev TLS) — Phase 3, staging first.
- Email delivery, Google Sign-In against real Google (verified locally
  only to the point of honest 503/config errors).
- Payment gateways — none are integrated by design (wallet deposits are
  receipt + admin review; no gateway is simulated).
- Load/DDoS behavior of the D1-backed rate limiter.

## 5. Frontend verification

- `npx tsc --noEmit`: PASS, zero errors across all of `src/` after the
  rewiring (with `@types/react`/`@types/react-dom` installed).
- `npm run build`: PASS.
- Static scans: zero remaining `queryDb`/`initDb` references; zero
  references to the hardcoded admin email; no `auth_token`/entitlement
  localStorage keys — the only remaining localStorage uses are UI
  preferences (language, theme, invest display currency).
- **Browser end-to-end run** (headless Chromium/Playwright at phone
  viewport 390×844 against `wrangler dev` serving the production build) —
  **13/13 checks passed**:
  1. admin + product fixture created through the admin API
  2. registration through the sign-up form redirects into the app
  3. product page shows the real name and real IQD price
  4. add-to-cart puts the item in the server cart
  5. cart page lists the item
  6. address created through the Addresses form and listed
  7. checkout shows the saved address
  8. checkout shows the server-priced total
  9. Place Order returns a real order number (`ORD-…`) on the success
     screen (screenshot evidence)
  10. Orders page lists that order
  11. a non-admin visiting `/admin` is bounced (and the admin API would
      403 regardless)
  12. the admin account reaches the admin console
  13. the admin overview shows live database figures — the same order id,
      totals, user counts (screenshot evidence)
- RTL/Arabic rendering, the discounted rail, sale badges and bottom nav
  were visually confirmed on the phone-sized screenshots during the run.

Not browser-tested in this pass (implemented and API-tested, pending
Phase 3 staging verification): Google Sign-In against real Google, wallet
deposit UI upload on a physical device, admin home-settings drag-reorder
on touch, Kurdish translations page-by-page.
