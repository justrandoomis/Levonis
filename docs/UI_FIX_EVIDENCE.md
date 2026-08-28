# UI/Auth Fleet — Verification Evidence

Verification pass for the auth/UI fleet (auth redesign, Telegram OTP flow,
layout/background, buttons/QR, loading states). Date: 2026-08-28. Everything
below was **actually executed** against the local stack; anything that could
not be exercised here is listed explicitly under "Not covered".

## Environment

- `wrangler dev` on `http://127.0.0.1:8787` serving the **built** `dist/`
  plus the real Worker + local D1/R2 emulation.
- Local D1 migrated through `0011_tg_auth_extra.sql`. (The running server's
  DB was initially missing 0011 — the Telegram endpoints returned generic
  500s until `npx wrangler d1 migrations apply levonis-db --local` was run;
  recorded here so deploys remember the migration step.)
- Playwright Chromium 1.56, phone viewport 390x844, `locale: ar`,
  `colorScheme: dark` (the LEVONIS identity is dark; see caveats).
- No Telegram bot token, no Google client id, no email API key configured
  locally — the HONEST unavailability branches are what was exercised, on
  purpose.

## What ran, and the numbers actually observed

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npm run check` | 0 errors (app + worker tsconfigs) |
| Unit tests | `npm run test:unit` | **137 pass / 0 fail** |
| API v1 | `node scripts/api-tests.mjs` | **60 passed, 0 failed** |
| API v2 | `node scripts/api-tests-v2.mjs` | **37 passed, 0 failed** |
| API v3 | `node scripts/api-tests-v3.mjs` | **111 passed, 0 failed, 9 blocked** (blocked = honest env-dependent skips: bot token, webhook secret, email key, owner-decision fees/BNPL, real-phone KYC) |
| Build | `npm run build` | green (chunk-size warning only) |
| Browser E2E | `node scripts/e2e-ui.mjs` | **37 passed, 0 failed** |

## Telegram auth endpoints — real local responses (curl)

No bot exists locally, so only the honest branches can be true:

- `POST /api/auth/telegram/start` (valid phone, Arabic-Indic digits too) →
  `503 {"code":"NOT_CONFIGURED","error":"Telegram sign-in is not configured yet (TELEGRAM_BOT_TOKEN is unset)"}`
- `POST /api/auth/telegram/start` (short phone) → `400 "phone is too short"`
- `GET /status`, `POST /resend`, `POST /complete` with an unknown token →
  `400 {"code":"NO_CHALLENGE","error":"This request is no longer valid — start again"}`
  (enumeration-safe generic wording)
- `POST /api/telegram/webhook` without the secret header → `403 FORBIDDEN`

## Browser evidence (docs/evidence/, 390x844 viewport PNGs)

| File | Shows | Programmatic assertions attached |
|---|---|---|
| `a-auth-ar-rtl.png` | /auth signin, Arabic RTL, LEVONIS wordmark, real labels, Google + Telegram method slots | `dir=rtl`; >= 2 `<label>`s; Google slot = real GSI button OR the honest not-configured notice; labeled `#tg-auth-phone`; Telegram form NOT nested in the credentials form |
| `a2-auth-telegram-honest-503.png` | after submitting a valid phone: the explicit amber "not configured yet" state (real server 503, no fake progress) | notice text waited on after the real response |
| `b-home-bottom.png` | home scrolled to the end, floating BottomNav | pixel-sampled bottom-left / bottom-right 40x40 regions: meanLum 7.7 / 15.0 (< 40), max green-excess **0** on both sides — **no green corner glow** |
| `c1-profile-guest.png` | signed-out profile: honest guest card + "زائر" badge | no "النقاط"/"الرصيد" member tiles in the DOM |
| `c2-profile-member.png` | signed-in profile (account registered through the real API, session cookie set): member badge, real zero balances, referral card, aligned icon grid | address/support/settings buttons on one row (y-delta <= 2px), each >= 44px |
| `d-orders-filter-pending.png` | /orders?status=pending reached by tapping the profile chip; fixture order (created via real checkout) listed | URL + `aria-pressed` chip + order visible |
| `d2-orders-filter-shipped-empty.png` | shipped filter: honest "no orders with this status" empty state | fixture order absent from the filtered list |
| `e-product-detail.png` | product detail with real content (image slot shows the honest fallback — fixture has no images) | frame-by-frame scan during an in-app slug change: skeleton → product 2, **0 stale product-1 frames** |
| `f-support.png` | /support reached by tapping the profile "خدمة العملاء" grid button | URL + non-empty page |

## Defects found by this pass and fixed

1. **Nested `<form>` broke the Telegram flow on /auth** (`src/pages/Auth.tsx`).
   `providerSection` (which contains TelegramAuth's own `<form>`) rendered
   inside the signin/signup forms. HTML drops nested form tags, so the
   "المتابعة عبر تيليغرام" submit button actually submitted the
   email/password form and the Telegram flow could never start. Fixed by
   moving the provider section outside both forms; the e2e script now pins
   this (`telegram flow owns its own form`).
2. **One-frame stale product flash** (`src/pages/Product.tsx`). The load
   effect is passive (runs after paint), so an in-app slug change painted
   the previous product for one frame under the new URL. Reproduced by the
   e2e frame scan (`staleFrames=1`), fixed with a synchronous
   adjust-state-during-render guard, re-verified (`staleFrames=0`).
3. **Un-applied migration 0011 locally** — Telegram endpoints 500'd until
   applied (see Environment). Not a code defect; recorded as an ops step.

## Integration wirings applied (from the fleet's reported needs)

- `src/App.tsx`: `ProtectedRoute`/`AdminRoute` now redirect with
  `<Navigate to="/auth" replace state={{ from: location.pathname + location.search }} />`
  so the destination survives login (Auth.tsx sanitizes it via
  `sanitizeNextPath`).
- `src/pages/Auth.tsx`: `<TelegramAuth>` now receives
  `onSuccess={finishAuth}` (returns to the preserved destination) and
  `onSwitchMode={switchView}` (the post-proof "use login / use signup" hint
  can flip the view).
- `src/pages/Auth.tsx`: background gradient corner switched from the
  off-token `#1a210e` (the same yellow-green family as the removed glow) to
  the site token `to-olive-dark` (#0A1F18). This also stops Tailwind from
  emitting the `to-[#1a210e]` utility anywhere.
- `src/components/auth/EmailVerifyBanner.tsx`: accounts with the Telegram
  placeholder address (`…@telegram.local`) no longer see a "verify your
  email" banner — no message could ever arrive there.
- `worker/routes/auth.ts`: `POST /verify-email/send` now refuses
  `@telegram.local` placeholders with `400 NO_REAL_EMAIL` instead of
  returning the generic "sent" wording for unroutable mail.
- `worker/index.ts`: verified `/api/auth` (incl. `/telegram/*`) and
  `/api/telegram` routes were already registered — no change needed.

## Not covered — explicitly

- **Real iPad Safari / Android Chrome / physical devices.** Everything above
  is Playwright Chromium emulation at 390x844. Browser emulation is not a
  device test; keyboard/safe-area/autofill behavior on real iOS was NOT
  verified here.
- **Real Google sign-in.** `origin_mismatch` is fixable only in the Google
  Cloud Console (owner step — see `docs/GOOGLE_SIGNIN_FIX.md`). Locally the
  client id is unset, so only the honest "not enabled" state and the
  server's forged-credential rejection were exercised. Do NOT claim Google
  works until a real login succeeds on the production origin.
- **Real Telegram device flow.** No bot token locally; the deep link,
  request_contact, OTP delivery and /complete happy path were exercised only
  at the unit level (`tests/telegramAuth.test.ts`) and via the honest 503 /
  generic-error API branches. A staging run with the real
  `@Levonisiq_bot` is still required.
- **Email verification end-to-end** (no email API key locally — honest 503).
- **Light-scheme rendering.** Screenshots use dark-scheme emulation.
  `src/pages/Profile.tsx` / `src/pages/Chats.tsx` still paint light
  backgrounds on light-scheme devices (page-internal, flagged by the layout
  agent; owner call whether to force dark there).
- **External resources in the sandbox**: Google Fonts (`Cairo`) and the GSI
  script are unreachable from this environment (`ERR_CONNECTION_RESET`), so
  screenshots render with fallback system fonts. Not an app defect; verify
  typography on staging.
- The `Test Printer x5z7e8` card from the original report was NOT deleted or
  hidden (per the data-protection rule). Local DBs contain api-test fixture
  products named "Test Printer …"; whether the production card is a leaked
  fixture must be checked against the production DB by the owner.
