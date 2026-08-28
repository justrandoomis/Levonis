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
| Worker TypeScript (strict) | `tsc --noEmit -p worker/tsconfig.json` | PASS |
| Frontend TypeScript | `tsc --noEmit` | TO-VERIFY (updated in §5 below) |
| Production build | `npm run build` | TO-VERIFY (updated in §5 below) |

## 3. API / security test suite — `node scripts/api-tests.mjs`

58 automated checks against `wrangler dev` (migrations applied with
`npm run db:migrate:local` first). **Result: 58 passed, 0 failed.**

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

TO-VERIFY — this section is filled in with the real command results after
the frontend rewiring lands (tsc, vite build, and browser spot-checks
against wrangler dev). Do not treat it as passed until it lists results.
