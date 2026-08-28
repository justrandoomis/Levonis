# Security notes

This document lists the confirmed vulnerabilities found in the original
project, how each was fixed, the current security model, and the remaining
risks. Verification evidence is in `docs/TEST_RESULTS.md`.

## 1. Confirmed vulnerabilities in the original code (all fixed)

| # | Finding (original code) | Severity | Fix |
| --- | --- | --- | --- |
| 1 | `POST /api/d1/query` executed **arbitrary SQL from the browser with no authentication** (`server.ts`); `src/lib/db.ts` and 14 components built SQL client-side | Critical | Endpoint removed (now explicit 410). All data access goes through explicit, validated, parameterized server routes with per-route authorization (`worker/routes/*`) |
| 2 | `POST /api/d1/init` allowed **public schema changes** | Critical | Removed; schema is managed by versioned migrations (`migrations/`) applied by an operator |
| 3 | `GET /api/make-all-investors` publicly **granted a privilege to every user** | Critical | Removed; investor status is changed only via the audited admin API |
| 4 | `POST /api/auth/google` **trusted a client-supplied email/name** — anyone could sign in as any account by posting its email | Critical | Google ID tokens are verified server-side: RS256 signature against Google's JWKS, issuer, audience (`GOOGLE_CLIENT_ID`), expiry, `email_verified`; accounts link by stable `sub` |
| 5 | `JWT_SECRET` had a **hardcoded fallback** (`super_secret_jwt_key_123`, also committed in `.env.example`) | Critical | JWTs removed entirely. Sessions are opaque 256-bit random tokens stored **hashed** in D1, delivered in `Secure; HttpOnly; SameSite=Lax` cookies, revocable server-side |
| 6 | Admin status decided **client-side** (hardcoded email `aliamer59409@gmail.com` in `AuthContext`/`Header`, plus a `\|\| true` that showed the admin console to everyone); `AdminUsers` let any user run `UPDATE users SET isAdmin=1` | Critical | Roles live in `users.role`; every `/api/admin/*` route checks the server-side role; admin UI routes are additionally gated client-side (UX only). Admins cannot demote themselves (lockout guard) |
| 7 | **Client-authoritative money**: browser computed balances, inserted its own pre-approved transactions, faked deposits with negative charges, self-awarded points; `set_admin_pass.cjs` set the admin password to `password123` via the open SQL endpoint | Critical | All balances derive from approved ledger rows server-side; spends are conditional inserts that cannot overdraw under concurrency; rewards are server-validated with per-day uniqueness; deposits stay `pending` until an admin decides; every financial mutation is audit-logged |
| 8 | Google flow **generated passwords and disclosed them** in an alert/console "email mock" | High | Removed. Google accounts have no password until the user sets one; password reset uses expiring single-use tokens and honestly reports 503 until an email provider is configured |
| 9 | Forgot-password returned fake success without sending anything | Medium | Honest `503 EMAIL_NOT_CONFIGURED` until an email service is configured; then neutral success (no account enumeration) with a hashed, 30-minute, single-use token |
| 10 | `POST /api/upload` had **no authentication and no validation** (any file, any size, attacker-controlled extension) | High | `POST /api/uploads` requires a session, sniffs magic bytes (JPEG/PNG/WebP/GIF, MP4 for admin product media), caps size (8 MB images / 40 MB admin video), and writes to purpose+owner-scoped keys. Product media upload is admin-only |
| 11 | Receipts and private files publicly readable via R2 public URL | High | The bucket is accessed only through the Worker: `/files/receipts/*` is owner-or-admin, `/files/chat/*` is participants-only, product/avatar/community media are public by policy. Files are served with `nosniff` and a sandboxing CSP |
| 12 | `POST /api/extract` fetched **any user-supplied URL** (SSRF), followed redirects blindly, no size/time limits | Medium | Admin-only + rate-limited; http(s) only; credentials-in-URL rejected; private/reserved IP literals and localhost-style hostnames blocked, re-validated on every redirect hop (max 3); 10 s timeout; response capped at 1 MB and must be `text/html` |
| 13 | Checkout/"Place Order" was fake (client-only state, hardcoded order number); prices and totals were whatever the browser said | High (integrity) | Orders are created server-side from server-priced cart lines, settings-priced delivery, and the server exchange rate, with an idempotency key, atomic stock decrements (`CHECK (stock >= 0)` aborts oversell), and atomic wallet/points deduction |
| 14 | Rate limiting: none anywhere | Medium | D1-backed fixed-window limiter (cross-isolate) on login, register, Google, forgot/reset password, checkout, uploads, deposits/withdrawals, translate, extract, chat/messages |
| 15 | Cross-user access: any user could read/write any other user's wallet rows, investments, messages via SQL | Critical | Every read/mutation is scoped to the session user (or requires the admin role); IDOR checks on orders, addresses, cart items, receipts, chats, warranty claims, favorites |
| 16 | `SELECT * FROM users` shipped **password hashes to the browser** (InvestAdmin) | High | No route ever selects `password_hash`/`google_sub` into a response; admin user listings return an explicit safe column list |

## 2. Security model (current)

- **Sessions**: opaque token → SHA-256 → `sessions` table; 14-day expiry;
  logout deletes the row; password change/reset revokes all sessions.
  Cookie: `Secure; HttpOnly; SameSite=Lax; Path=/`.
- **CSRF**: `SameSite=Lax` plus an Origin check on every non-GET request
  (same-origin or `EXTRA_ALLOWED_ORIGINS`). No cross-site read of state is
  possible (no CORS headers are emitted).
- **Passwords**: PBKDF2-SHA256 (WebCrypto, 100k iterations) stored as
  `pbkdf2$iter$salt$hash`; legacy bcrypt hashes (from the old server) verify
  via bcryptjs and are transparently re-hashed on the next successful login.
  Length 8–128 enforced; identifiers normalized to lowercase; uniqueness
  enforced by DB constraints.
- **Roles**: `customer | merchant | admin` in `users.role`; `is_investor`
  flag for the invest portal. UI hiding is never the control — every
  endpoint re-checks.
- **Initial admin**: while **no admin exists**, the account whose *verified
  Google identity* matches `INITIAL_ADMIN_EMAIL` is promoted on sign-in
  (audited). Password-registration never auto-promotes (an attacker who
  merely knows the email cannot claim admin). Manual alternative:
  `wrangler d1 execute levonis-db --remote --command "UPDATE users SET role='admin' WHERE email='<you>'"`.
- **Money**: IQD amounts are integers (dinars); wallet USD amounts are
  integer cents; points are integers; `exchangeRate` (IQD per USD) is an
  admin setting recorded on each order. IQD→cents conversions round **up**
  so the wallet never undercharges. Products store canonical IQD (the old
  divide-by-rate storage silently repriced the whole catalog whenever the
  rate changed — fixed).
- **Audit**: `audit_log` records admin/financial mutations (actor, action,
  target, bounded detail; never passwords or tokens).
- **Headers**: `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy`, `Permissions-Policy` on API responses; uploaded files
  are additionally served with `Content-Security-Policy: default-src 'none'; sandbox`.
- **Errors**: clients receive safe messages; stack traces and internals stay
  in Worker logs.

## 3. Remaining risks & honest limitations

1. **No email verification at registration.** Password accounts are created
   unverified. Mitigations: password reset only works via a configured email
   provider; the initial-admin bootstrap ignores password accounts. Adding
   verification requires the email provider (Phase 2/3 decision).
2. **"Watched ad" mission is client-attested.** The server cannot prove the
   video played; the claim is capped at once/day/account and rate-limited.
   The browse mission, by contrast, is fully server-timed.
3. **Push notifications are permission-only.** There is no push backend;
   the UI says so honestly. (Requires a Web Push service + VAPID keys.)
4. **Workers free plan CPU limits vs PBKDF2.** 100k iterations typically
   runs in the low tens of ms of CPU. On the free plan (10 ms CPU) logins
   may be throttled/fail under load — the Workers paid plan is recommended;
   iteration count is a single constant in `worker/lib/crypto.ts`.
5. **Rate limiting is per-IP fixed-window** in D1 — adequate for abuse
   damping, not a DDoS defense (Cloudflare's own WAF/rate rules can be added
   in the dashboard in Phase 3).
6. **No Content-Security-Policy on the HTML document yet.** The SPA loads
   Google Sign-In scripts and remote images; a strict CSP needs careful
   allowlisting and testing against Google's script requirements — planned
   for Phase 3 verification rather than shipped untested (the app never uses
   `dangerouslySetInnerHTML`; XSS surface is limited to React-escaped text).
7. **SSRF residual**: hostname-based blocking cannot see post-DNS rebinding.
   The endpoint is admin-only, rate-limited, and Workers egress has no
   route to your private infrastructure, so residual risk is low.
8. **Secrets requiring rotation if the old stack ever ran in production**:
   the Cloudflare **API token**, **R2 access keys**, **JWT secret**, and
   **Gemini key** referenced by the old `.env` layout must be treated as
   compromised (the old server design shipped them into a public-facing
   process with an open SQL proxy), and the old admin account password
   (`password123`, set by `set_admin_pass.cjs`) must be changed. None of
   these values were present in the archive itself.
9. **Chat privacy**: only participants can read a conversation. There is
   deliberately no admin backdoor; adding moderated access would need an
   explicit, audited design.

## 4. Dependency & secret scan

- `npm audit` at build time: see `docs/TEST_RESULTS.md`.
- Source scan for embedded secrets found **no real credentials** in the
  archive (only placeholder `.env.example` values and the hardcoded JWT
  fallback string, both now removed).
