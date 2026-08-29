# Integrated mandate — integration & verification record

What the integrator actually wired, actually ran, and actually observed for the
integrated UX/auth/wallet/rewards mandate. Every number below comes from a real
run in this sandbox against `wrangler dev` on `127.0.0.1:8787` with a local D1
migrated `0001 → 0017`. Nothing here is projected, and nothing that could not be
executed is written up as if it passed.

Reporting uses the mandate's four buckets: **passed · failed · NOT EXECUTED
(غير منفذ) · BLOCKED with a reason (محجوب مع السبب)**. A precondition that is
honestly unconfigured (no bot token, no e-mail key, an owner decision that has
not been made) is BLOCKED — never a pass.

---

## 1. Integration performed (the hand-offs the slices could not make themselves)

The concurrent slices each owned a subset of files; the wiring between them
belongs to the integrator. These are the connections made in this pass.

| # | Hand-off | Change |
| --- | --- | --- |
| 1 | Referrals API was unmounted | `worker/index.ts` mounts `referralRoutes` at `/api/referrals`. Every `/referrals` endpoint answered 404 before this. |
| 2 | `/referrals` page had no route | `src/App.tsx` adds `/referrals` (protected). `src/pages/Profile.tsx` already navigated there. |
| 3 | Support code was dropped at checkout | `src/pages/Checkout.tsx` reads `location.state.supportRef` and sends `supportCode` on **both** `POST /api/orders/quote` and `POST /api/orders`; the money view renders the returned handle with an explicit `0 IQD`. |
| 4 | Product share link carried no handle | `src/pages/Product.tsx` share now asks `GET /api/referrals/support/link?path=/product/<slug>` (server builds the handle; a signed-out visitor shares the plain URL). The page also **captures** an arriving `?ref=` via `captureSupportRefFromSearch`, which is what makes the code visible in the cart later. |
| 5 | `decideDeposit` contract was missing | `worker/lib/walletOps.ts` now exports `decideDeposit(env, { requestId, action, actorUserId, reason, source })` — the exact frozen shape `worker/lib/walletNotify.ts` looks up at runtime. `worker/routes/wallet.ts` approve/reject now call it, so **the site and the Telegram button share one guarded service** (§12.2). Proof: every deposit decision audit row written during the suites carries `"source":"site"`, i.e. it came through walletOps, not through route-local SQL. |
| 6 | Deposit notifications were plain text | The deposit route now calls `notifyAdminsOfDeposit` (proof attached, decision buttons, retry row), falling back to the old plain `notifyAdmins` line only when the rich notification could not even be recorded. Approve/reject additionally close the group message and enqueue the customer's status notification, inside `waitUntil` — never on the ledger path. |
| 7 | Reconcile/notify jobs were never scheduled | `worker/lib/jobs.ts` gains steps 8–10: `processWalletNotifications` (§12.1), `reconcileWallets` (§11.4 — reports, never repairs), `reconcileSupportGifts` (§3.4). Covered by the new `tests/durableJobs.test.ts`. |
| 8 | `/chats` was gated, but its support entries must not be | `src/App.tsx` un-gates `/chats`; the page already renders an honest signed-out state for the private list, and every `/api/chats` read stays authorised server-side. |
| 9 | OTP boxes / referral / password never reached the Telegram flow | `src/components/auth/TelegramAuth.tsx` now uses `OtpBoxes` + `FillButton` (0/6 → 6/6), accepts a `referralCode` prop (sent as `ref` at `/telegram/start`, `referralCode` at `/complete`), and offers the OPTIONAL password that creates the §2.1 phone + password account. `src/pages/Auth.tsx` passes the resolved code. |
| 10 | Stale product frame regression | `src/pages/Product.tsx` reads the address bar through `useSyncExternalStore`. React Router v7 wraps navigations in `startTransition`, so the previous product could stay painted for a frame under the new URL; an external-store read cannot be deferred, so the skeleton now commits before paint. Measured: `staleFrames=1` → `staleFrames=0`. |

Test-harness fixes (fixtures and assertion precision — **no assertion was
weakened**, two were made stricter):

- `scripts/api-tests-v4.mjs` PTS-04 added the same product twice, which the cart
  **merges into one line**, so the concurrency check silently never ran. It now
  uses two different products (12,000 + 500 against a 4,500 point balance) so
  the two checkouts really contend.
- `scripts/api-tests-v4.mjs` PAY-03 asserted `!JSON.stringify(mine).includes('"active"')`
  — but `/memberships/mine` always serialises an `active` boolean, so the check
  could never pass. It now asserts the STATE: tier stays `free`, `active !== true`,
  and zero membership rows.
- The v4 phone fixture pinned a literal `+9647709998877` against a UNIQUE index,
  so a second run on the same database aborted the suite. It is now run-unique,
  derived into all four accepted spellings.
- The anonymous `tg-auth-*` rate-limit buckets are cleared at start, like
  `register`/`login`/`forgot` already were, so a re-run does not report a 429 as
  a broken validation rule.
- `scripts/e2e-ui.mjs` (previous phase) asserted the Google and Telegram slots
  were visible simultaneously. §2.1 deliberately replaced that long column with
  a tab row, so the suite now SELECTS the method first; the assertions
  themselves are unchanged, plus a new one that there are 4 tabs and 1 panel.

---

## 2. What ran, and the real numbers

Clean environment: `rm -rf .wrangler/state && npx wrangler d1 migrations apply
levonis-db --local` (0001 → 0017 all ✅), `npm run build`, then
`npx wrangler dev --ip 127.0.0.1 --port 8787`.

| Command | Result |
| --- | --- |
| `npm run check` (tsc app + worker) | **0 errors** |
| `npm run test:unit` (`tests/*.test.ts`) | **325 passed, 0 failed** |
| `npm run build` | green — `index.js` 1,854.29 kB (gzip 525.96), `index.css` 167.96 kB (gzip 25.17), 2 lazy admin chunks |
| `node scripts/api-tests.mjs` | **60 passed, 0 failed** |
| `node scripts/api-tests-v2.mjs` | **37 passed, 0 failed** |
| `node scripts/api-tests-v3.mjs` | **118 passed, 0 failed, 9 blocked** |
| `node scripts/api-tests-v4.mjs` | **147 passed, 0 failed, 5 not executed, 7 blocked** |
| `node scripts/e2e-integrated.mjs` (this mandate's browser pass) | **43 passed, 0 failed, 1 not executed, 1 blocked** |
| `node scripts/e2e-ui.mjs` (previous phase, regression) | **38 passed, 0 failed** |

Total: **768 automated checks passed, 0 failed** across unit, API and browser
runs, plus 17 honestly blocked and 6 not executed (listed in §4).

Re-run note, so nobody is surprised: on a database that already holds a
published policy, v3 reports **117 passed / 10 blocked** instead of 118/9 — its
"policy list is honestly empty before publishing" check cannot reproduce the
pre-publish state and blocks itself. That is the suite being honest about a
non-reproducible precondition, not a regression.

### Cross-slice behaviour observed directly

- Deposit decisions: `audit_log` rows read back after the run —
  `wallet.deposit.approved {"note":"v4 concurrent A","source":"site"}` and
  `wallet.deposit.rejected {"reason":"v4 synthetic rejection","source":"site"}`.
  The `source` field only exists inside `walletOps.decideDeposit`, so the site
  route demonstrably goes through the shared service.
- The mandated §5 arithmetic is asserted digit by digit by v4 and passed:
  merchandise 75,000 · 739 points → 74,261 · delivery 5,000 · total **79,261** ·
  wallet 30,000 · COD **49,261** · pending points floor(74,261/100) = **742**,
  released only after a recorded collection **and** the seven-day hold.
- Referrals: REF-01 … REF-07 all green now that `/api/referrals` is mounted,
  including "a replay with another code returns the ORIGINAL attribution" and
  "an admin order update cannot re-point the beneficiary".

---

## 3. Browser pass — `scripts/e2e-integrated.mjs`

Playwright (playwright-core 1.62.1, `/opt/pw-browsers/chromium`) driving the
REAL built app served by the dev worker: Arabic default (RTL), dark scheme,
390×844 phone, 1024×768 iPad and 1280×800 admin viewports. Every claim is a DOM
measurement, a computed style, a decoded pixel or an observed network request —
screenshots are evidence, never the assertion.

Screenshots → `docs/evidence/integrated/`:

| File | What it evidences |
| --- | --- |
| `auth-methods.png` | 4 method tabs in ONE row, exactly 1 mounted `tabpanel`, 1 visible form — not the long column §2.1 forbids |
| `auth-fill-partial.png` | sign-up part-way: fill grew **0 % → 20 % → 40 % → 60 %** (username, then name, then a partial e-mail) and the button is still disabled |
| `auth-fill-ready.png` | every rule satisfied: `--lv-fill-pct: 100%`, `data-ready="true"`, `disabled === false` |
| `auth-fill-regressed.png` | one character deleted from the confirmation → below 100 %, `data-ready="false"` immediately |
| `auth-referral-bar.png` | `/auth?ref=<username>` auto-opens the bar with the server-resolved referrer name, before any account exists |
| `auth-otp-paste.png` | six linked boxes; one paste of `"123 456"` fills all six; verify button 0/6 → 6/6 then enabled; Backspace regresses to 5/6 and disables |
| `referrals-page.png` | `/referrals` renders as a real route (not the catch-all): the unique `@username`, the `/auth?ref=` invite link with copy/share, and the plain-language difference between a SIGN-UP invite and a PURCHASE support code |
| `cart-support-applied.png` | support code captured from a product link, referrer named, explicit `0 د.ع` |
| `checkout-support-line.png` | the same code reaches the checkout money view with a zero effect |
| `cart-support-removed.png` | removal survives a full reload — nothing re-adds it behind the user |
| `rewards-dark.png` | `/points` top region mean luminance **37.2** (dark; the gate is < 60), max green excess **0** over 329,160 sampled pixels, root background `rgb(0,0,0)` — the olive wash is gone, measured in pixels |
| `product-cta-390.png` | exactly ONE visible CTA, inside the bottom bar pinned to the viewport bottom, no horizontal scroll |
| `product-cta-1024.png` | CTA inside the sticky purchase panel; **no** fixed bar at all; no fixed ancestor; width < 60 % of the viewport |
| `admin-import-modal.png` | the dialog scrim spans the viewport; `elementFromPoint` at the topbar centre and at the sidebar centre both land inside the dialog layer; all labelled action buttons are fully in view |
| `chats-signed-out.png` / `chats-signed-in.png` | the two permanent support entries render both signed out and signed in |
| `community-studio.png` | LEVO Studio is an external `https://studio.levonis-iq.com` link with `rel="noopener"`; **zero** slicer/wasm/3D requests and **zero** requests to the Studio subdomain were observed |

---

## 4. Honestly not covered

**BLOCKED — an unconfigured precondition or an open owner decision (never a pass).**

From v4 (7) and the browser pass (1):

- Real Telegram delivery, the contact-ownership share, the resend cooldown and
  the group approval buttons — no `TELEGRAM_BOT_TOKEN` and no authorised group
  here (row 26). The OTP *rules* are proven with planted challenges and the OTP
  *step* is driven in the browser from a planted verified challenge; delivery is
  not claimed.
- Live reset/verification e-mail — `EMAIL_API_KEY`/`EMAIL_FROM` unset (row 14);
  only the honest 503 branch is asserted.
- Gift repeat policy, per-printer counting and post-payout clawback (row 11 /
  §13.2) — one gift per qualifying ORDER is the shipped default.
- The commercial effective date of the 100:1 points rule (row 20 / §13.4).
- Live payout execution, eligible balance sources, limits and fees (§13.1 —
  **no register row exists yet; one must be added**).
- COD eligibility per product class / community store (§13.3 — **no register row
  yet**).

From v3 (9): the Telegram deep link and webhook-secret branches, live e-mail
verification, price-protection payout execution, printer/carton fee amounts
(rows 3/16), BNPL (rows 10/21) and the full KYC cycle.

**NOT EXECUTED — real, but out of reach of this environment.**

- **Real device verification.** iPad hardware, iOS Safari, the on-screen
  keyboard and the OS `prefers-reduced-motion` setting. Chromium at 390×844 and
  1024×768 is an emulation, not a device test.
- **Live Telegram group approvals.** Needs a staging bot token, an authorised
  admin group and `admin_tg_identities` seeded with a real Telegram user id
  mapped to a real admin. The webhook branch, the token lifecycle and the shared
  decision service are covered by v3/v4 and unit tests; the button press in a
  real group is not.
- **Production-domain checks.** `https://levonis-iq.com`, the Google Console
  authorised origins, DNS, the deployed Worker and `mail.levonis-iq.com` are all
  unreachable from this sandbox and are an owner/deploy step. Nothing in this
  record says anything about the deployed site.
- **Legacy short passwords still sign in** — a fresh isolated DB has no
  pre-existing production account; verify on a restored copy before launch.
- **PTS-05/PTS-06** mission/video anti-replay (base suite covers the claim
  rules; a server-verified watch session is still not built).
- **PAY-04** staff-role separation on cost/profit fields — only admin/customer
  roles exist, so there is no unauthorised assistant role to test.

**Known limits of what was proven.**

- Every D1 race in the suites is exercised through the real guards, but against
  local SQLite/miniflare — not Cloudflare's D1 under real concurrency.
- The durable jobs are proven by `tests/durableJobs.test.ts` (real SQLite built
  from the real migrations: each new step runs, reconciliation writes exactly
  ONE audit row on a broken invariant and repairs nothing, a failing step never
  starves the later ones). The local `wrangler dev` cron endpoint did not
  actually invoke the scheduled handler in this sandbox, so Cloudflare's
  scheduler firing it in production is unverified here.
- `WAL-09` (fault injection between hold, stock, order and ledger) remains the
  structural gap this round does not close.

---

## 5. Reproducing this

```bash
rm -rf .wrangler/state
npx wrangler d1 migrations apply levonis-db --local     # 0001 → 0017
npm run check && npm run test:unit && npm run build
npx wrangler dev --ip 127.0.0.1 --port 8787             # separate shell
node scripts/api-tests.mjs
node scripts/api-tests-v2.mjs
node scripts/api-tests-v3.mjs
node scripts/api-tests-v4.mjs
node scripts/e2e-integrated.mjs                         # screenshots → docs/evidence/integrated/
node scripts/e2e-ui.mjs                                 # previous-phase regression
```

Migrations `0013 → 0017` must be applied before login-by-phone, Telegram
sign-up, the points rule, wallet holds, support codes and the Telegram admin
actions work at all.
