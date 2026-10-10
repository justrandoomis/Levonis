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
  possible (no CORS headers are emitted) — with ONE exception: the public
  read-only API `/api/public/v1/*` (docs/PUBLIC_API.md) answers with
  `Access-Control-Allow-Origin: *` and no `Allow-Credentials`. That is safe
  because the prefix never loads a session (worker/index.ts skip-list), so
  its answers are identical for every caller and hold nothing a signed-out
  visitor cannot already see; it accepts GET/HEAD/OPTIONS only (405 for the
  rest).
- **Passwords**: PBKDF2-SHA256 (WebCrypto, 100k iterations) stored as
  `pbkdf2$iter$salt$hash`; legacy bcrypt hashes (from the old server) verify
  via bcryptjs and are transparently re-hashed on the next successful login.
  Length 8–128 enforced; identifiers normalized to lowercase; uniqueness
  enforced by DB constraints.
- **Roles**: `customer | merchant | admin` in `users.role`; `is_investor`
  flag for the invest portal. UI hiding is never the control — every
  endpoint re-checks. Platform administration is apex-only wherever it is
  mounted: `requireAdmin` itself refuses (404) any host on which
  `adminAllowedOn` says a merchant could control the page, so a visiting
  admin's parent-domain cookie on a storefront reaches no admin route
  (`tests/adminHostGuard.test.ts` walks every discovered admin route).
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
  rate changed — fixed). Settlement rule: a purchase hold that commits posts
  its approved `withdrawal` row (`wtx_hold_<holdId>`) in the same batch or
  does not commit (`walletOps.commitHoldStatements`); a merchant is credited
  only in a batch where the buyer's debit posted; committed holds without a
  debit are reported by reconciliation, never repaired.
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

## 5. The deception layer — decoys, trap data and blocks (DECISIONS row 206)

Owner brief 2026-10-10: «للذين يحاولون اختراق الموقع او الاحتيال او سرقه بيانات او
التلاعب يتم اكتشافهم عن طريق ملفات وهمية ويتم حظرهم مباشرة — نظام ذكي يوهم المخترق بانه
حصل على المعلومات لكن يكتشف بانه تم حظره». Defensive only: the site answers the
people who ask it; nothing reaches out to anyone. Code: `worker/lib/deception/`,
`worker/routes/decoys.ts`, `worker/routes/adminSecurity.ts`; migration
`0185_security_deception.sql`.

**The decoys.** `/.env` (and `.local`, `.production`, `.backup`), `/.git/*`,
`/config.json`, `/backup.sql`, `/database.sql`, `/admin/export/*`,
`/api/internal/*`, `/api/v0/*`, WordPress (`/wp-login.php`, `/wp-admin/*`,
`/xmlrpc.php`) and `/phpmyadmin/*` answer realistic, entirely invented data —
built in memory from a random batch id, never from the database — carrying
trap tokens (an API key, an admin e-mail and passwords, a session, product
ids shaped like real ones). ONE ANSWER FOR EVERYONE who is answered at all: a
tool, a browser, an image tag, a user agent claiming to be Googlebot, a forged
`Sec-Fetch-*` header and a staff account get the same body with the same
headers a file would carry (no cookie, no `no-store`, no robots header, no
wait for a database write) — comparing requests tells an attacker nothing. A
path a real exposed server would not have (a git object, an unknown internal
API path) answers 404. The decoys are NOT in robots.txt (that would hand out
the list of traps). Each decoy path, bare directory names included, is in
`run_worker_first` in all three environments.

**The anti-framing rule.** Evidence counts in full only where nobody else
could have put it: a request with NO `Sec-Fetch-*` header at all (a tool —
every current browser sends them; a partial or unknown set is a tool's too),
or trap data in a header, a cookie or the sign-in body (whatever its type or
size). Anything a link can carry — a decoy opened by a navigation, trap data
in a URL the app echoed into its own fetch, an injection-shaped query, a
claimed crawler following links — is LINKABLE: recorded and scored, but a
linkable score stops at 99, one short of a block. An image, a frame, a
cross-site fetch or a navigation without a click is recorded only. So an
attacker who posts a link, sends one on WhatsApp or prints a QR code cannot
get anyone blocked, customer or staff.

**Deceive, then block.** A tool's decoy request gets the fake data; this
isolate knows the block at once and the rows are written after the answer:
the account (signed in) or the address (anonymous), the trap batch, the
owner's bell with no figure. From its next request: `403 ACCESS_BLOCKED` with
a reference, the block page for documents, a full-screen notice in the app —
in Arabic, English and Sorani, never saying why, for how long, or what kind of
block. A browser's visitor is deceived the same way and is blocked the moment
he USES the trap data where no link puts it (the admin e-mail and password at
the sign-in form, the key in a header or a tool): that block answer carries
the device tag. Canary-shaped junk to hide a real token is itself a probe.

**Signals and scores.** Each account, device tag and network has a score that
halves every six hours; 100 blocks. Price or cost fields sent to the cart or
checkout (50; the server keeps its own price), injection shapes (25), tamper
switches (20), sign-in brute force (15, never on a shared address), guessing
admin routes (10), probing other people's records (5), admin refusals (3).
The admin refusals and the sign-in 429s are always linkable (workflow 7's
probes from a reused runner, through any number of isolates, stop at 99).

**Who is never blocked.** The verified owner (the table refuses an owner
row); other admins only by a confirmed trap token (a staff account opening a
decoy is deceived, its batch issued to it, and the owner's bell rings);
registered probe accounts; crawlers Cloudflare VERIFIED (a plain 404 from a
decoy — a user-agent claim is no exemption). Network blocks are for TOOLS
only: a carrier's shared address is never blocked for the browsers behind it,
a signed-in tool passes unless its account was made after the block (signing
up does not escape it), and a session cookie no session backs is no account.
They use the exact IPv4 address or IPv6 /64, keyed by the deception secret
per day (no database reader can enumerate an address back), last 24 hours (1
hour by score alone) and never apply to the Telegram and Studio server doors.
`/api/auth/*` stays reachable under every block: signing in, proving an
address (an unverified owner blocked by her own test proves it and is exempt
at once), resetting a password, signing out. Account and device blocks last
30 days; lifting an account lifts the tags its block answers set.

**Budgets.** Anonymous decoy and score incidents may fill 2,000 of the 3,000
block rows a day; the rest is kept for trap-data uses and accounts. One IPv4
/24 or IPv6 /48 writes at most 16 anonymous incidents before its addresses
stop getting rows of their own — an IPv6 /48 rotating its /64s is then
blocked whole. A decoy writes at most one trap batch per actor a minute.

**Speed.** Account and network blocks live in a per-isolate snapshot refreshed
in the background every 30 seconds; device tags need no database. An ordinary
request issues no extra D1 statement; static paths are never checked; any
error lets the request through.

**The owner's console «الأمان»** (Admin → الإدارة, verified owner only,
`/api/admin/security`): the tiles, the blocks, the whole security log, the
scores, an incident with «ما الذي أُعطي له» (the fake answer regenerated from
its batch), and «رفع الحظر» / «رفع كل حظر هذه الحادثة» with an audit row. The
log never stores a target id the trap value could be, nor any path parameter
named like a capability (`:token`, `:key`, `:code`…).

**The key.** `SECURITY_CANARY_KEY` (a Worker secret) keys the trap tokens, the
device tag and the network keys; when it is unset a key is DERIVED from
`TELEGRAM_WEBHOOK_SECRET` (else `STUDIO_HANDOFF_SECRET`, else
`TELEGRAM_ADMIN_WEBHOOK_SECRET`). With none of them the layer fails closed:
decoys still answer their fake data, but carry no trap data and no tag is
minted — there is no built-in key. The console says when it is off. No
workflow puts or deletes it; rotating the source secret ends the tags and trap
data already handed out.

**Known limits.** A cookie-less scanner may get ordinary public answers from
another isolate for up to 30 seconds after its block. A tool that forges a
browser's `Sec-Fetch-*` headers passes network blocks and its decoy and URL
evidence counts as linkable — it is still deceived, recorded and scored, and
blocked the moment it uses trap data where no link puts it. An old browser
that sends no `Sec-Fetch-*` (Safari before 16.4) behind an address a scanner
got blocked meets that block for up to 24 hours. A workflow 7 runner whose
address a scanner on the same cloud got blocked reads `ACCESS_BLOCKED`:
re-run it (a new runner) or lift the block in «الأمان». The live Worker also
answers on its `workers.dev` address, where the device-tag cookie of
levonis-iq.com is not sent (`workers_dev: false` is the owner's call: it
changes the deploy).

**Drill.** `scripts/local-deception-drill.mjs` plays a scanner against a LOCAL
Worker only (`wrangler dev --local`); it refuses any base that is not
`http://localhost` or `http://127.0.0.1`.
