# Test results

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
