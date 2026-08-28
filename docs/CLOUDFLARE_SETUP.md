# Cloudflare setup (Phase 2) and deployment (Phase 3)

Everything below is dashboard-first (phone/tablet friendly). CLI commands are
optional equivalents. **Do not paste secret values into chat — enter them
only in the Cloudflare dashboard fields described here.**

## Architecture (what you are deploying)

One **Cloudflare Worker** (`levonis`) that:

- serves the built React app as **static assets** with SPA routing,
- serves the entire API (`/api/*`, `/files/*`) with **native bindings** to
  **D1** (`levonis-db`, SQLite database) and **R2** (`levonis-files`, file
  storage).

Why this shape: native bindings need **no API tokens or S3 keys inside the
running app** (the old design shipped an account-level API token into the
server), one Worker means one deploy and no CORS, and Workers static assets
replace a separate Pages project. Serverless = no server to maintain.

## Phase 2 — resources, configuration, secrets

### 2.1 Setup table

| Name | Purpose | Type | Where to obtain/create | Where to enter | Required | Safe verification |
| --- | --- | --- | --- | --- | --- | --- |
| Cloudflare account | Hosts everything | account | dash.cloudflare.com | — | Required | You can open Workers & Pages in the dashboard |
| **Workers paid plan** ($5/mo) | Password hashing + real traffic headroom (free plan's 10 ms CPU limit can throttle logins) | plan | Dashboard → Workers & Pages → Plans | — | Strongly recommended | Plan badge shows "Paid" |
| D1 database `levonis-db` | All application data | resource | Dashboard → Storage & Databases → D1 → Create database → name `levonis-db` | Copy its **Database ID** into `wrangler.jsonc` → `d1_databases[0].database_id` (edit the file on GitHub) | Required | D1 page shows the database; after first deploy `/api/health` returns ok |
| R2 bucket `levonis-files` | Receipts, avatars, product media | resource | Dashboard → R2 → Create bucket → name `levonis-files` (R2 needs a card on file; free tier is generous) | Name already matches `wrangler.jsonc` | Required | Bucket appears in R2; uploads work in staging tests |
| `INITIAL_ADMIN_EMAIL` | Which verified Google account becomes the first admin | public var | Your own Gmail address | Worker → Settings → Variables and Secrets → add as **Text** variable (it is already declared in `wrangler.jsonc`; you can also set it there) | Required (or use the SQL alternative below) | After you sign in with Google once, the Admin button appears |
| `GOOGLE_CLIENT_ID` | Server-side audience check for Google Sign-In | public var | console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID (Web application). Authorized JavaScript origins: your `https://<worker>.workers.dev` URL and your custom domain | `wrangler.jsonc` `vars.GOOGLE_CLIENT_ID` **and** build variable `VITE_GOOGLE_CLIENT_ID` (see 2.3) | Optional (Google login hidden without it) | Google button renders and signs in on staging |
| `GEMINI_API_KEY` | Admin product-translation tool | **secret** | aistudio.google.com → Get API key | Worker → Settings → Variables and Secrets → add as **Secret** | Optional | Admin → product editor → Translate works; without it the button shows "not configured" |
| `EMAIL_API_KEY` | Password-reset emails (Resend) | **secret** | resend.com → API Keys (verify a sending domain) | Worker secret | Optional | Forgot-password reports "link sent" instead of 503 |
| `EMAIL_FROM` | Sender for reset emails, e.g. `Levonis <noreply@yourdomain>` | public var | Your verified sender | Worker variable | Optional (required with EMAIL_API_KEY) | Reset email arrives |
| GitHub connection | Build & deploy from the repo without a terminal | integration | Dashboard → Workers & Pages → Create → **Import a repository** → pick `justrandoomis/Levonis`, branch of your choice | — | Required for no-terminal deploys | Build logs appear under the Worker's Deployments |

Notes:
- **No Cloudflare API token, no R2 access keys, and no JWT secret are needed
  anywhere.** The Worker reaches D1/R2 through bindings; sessions use random
  tokens stored hashed in D1. If the old `.env` values ever existed in a
  real account, rotate/delete them (see docs/SECURITY.md §3.8).
- The build must NOT receive any secret as a `VITE_*` variable — only
  `VITE_GOOGLE_CLIENT_ID`, which is public by design.

### 2.2 Domain & OAuth redirect URLs

- Default URL: `https://levonis.<your-subdomain>.workers.dev` (shown on the
  Worker page). A custom domain can be attached later: Worker → Settings →
  Domains & Routes → Add → Custom domain.
- Google OAuth client: add every origin the site is served from (workers.dev
  URL and custom domain) to **Authorized JavaScript origins**. No redirect
  URI is needed for the Google Identity Services button.

### 2.3-A GitHub Actions deployment (the active path)

Three manually-triggered workflows exist under the repo's **Actions** tab
(run them from an iPad: Actions → pick the workflow → Run workflow → choose
the branch → Run):

1. **`1 - Verify Cloudflare Setup`** — read-only. Checks the API token,
   whether `CLOUDFLARE_DATABASE_ID` matches a real database (and whether it
   already holds tables/data), the R2 buckets, the Telegram bot token
   (`getMe`), and which optional settings are present. Changes nothing.
2. **`2 - Deploy Staging + Tests`** — creates/reuses `levonis-db-staging` +
   `levonis-files-staging`, applies migrations to the STAGING database only,
   deploys the `levonis-staging` worker to workers.dev, uploads the Telegram
   secrets to it, then runs the full 60-check API test suite against the
   live staging URL. Never touches production data or DNS.
3. **`3 - Deploy Production (approval required)`** — refuses to run unless
   you type `DEPLOY-PRODUCTION` into the confirmation input. Deploys the
   production worker to its workers.dev URL only (no custom domain, no DNS).
   Migrations run only when the `apply_migrations` box is ticked AND the
   production database is empty; a non-empty database aborts with an error.

Repository secrets used vs. unused by the current implementation:

| GitHub secret | Used? | How |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | ✅ | wrangler auth inside the workflows only — never inside the running app |
| `CLOUDFLARE_DATABASE_ID` | ✅ | matched to the real D1 database and injected into wrangler.jsonc at production deploy time |
| `CLOUDFLARE_R2_BUCKET_NAME` | ✅ | injected as the production R2 binding name |
| `VITE_GOOGLE_CLIENT_ID` | ✅ | frontend build var + the worker's `GOOGLE_CLIENT_ID` audience check (public value) |
| `TELEGRAM_BOT_TOKEN` | ✅ | uploaded as a Worker **secret**; server-side admin notifications (orders, wallet requests) + `getMe` verification |
| `TELEGRAM_ADMIN_CHAT_ID` | ➕ needed | **add this secret** — the chat/channel ID the bot posts into; without it the bot has nowhere to send |
| `INITIAL_ADMIN_EMAIL` | ➕ needed | **add this secret** — email promoted to admin on first verified Google sign-in while no admin exists |
| `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_ENDPOINT`, `CLOUDFLARE_R2_PUBLIC_URL` | ❌ unused | the Worker uses native R2 bindings; S3 keys are never needed. If these keys were used by the old deployment, rotate them |
| `JWT_SECRET` | ❌ unused | JWTs were removed (revocable cookie sessions); safe to delete |
| `GOOGLE_CLIENT_SECRET` | ❌ unused | the Google Identity Services ID-token flow needs only the client ID; the secret is never uploaded anywhere |

### 2.3-B Build configuration (Workers Builds — optional alternative)

When importing the repository (2.1 last row):

- Build command: `npm run build`
- Deploy command: `npx wrangler d1 migrations apply levonis-db --remote && npx wrangler deploy`
  (this applies pending migrations, then deploys — safe to re-run; already-
  applied migrations are skipped)
- Build variables: `VITE_GOOGLE_CLIENT_ID` = your Google client ID (only if
  using Google login)

The first deploy will fail until `database_id` is filled in `wrangler.jsonc`
(2.1). Edit the file directly on GitHub from a tablet: open the file → pencil
icon → replace `PLACEHOLDER-SET-IN-PHASE-2` → commit.

### 2.4 Initial admin (choose one)

1. **Google bootstrap (recommended):** set `INITIAL_ADMIN_EMAIL`, then sign
   in on the deployed site with that Google account. While no admin exists,
   that verified sign-in is promoted automatically (audited). Existing
   *password* accounts with the same email are never auto-promoted.
2. **SQL alternative:** Dashboard → D1 → `levonis-db` → Console →
   `UPDATE users SET role='admin' WHERE email='you@example.com';`
   (create the account through the site first).

## Phase 3 — live integration and acceptance (after you confirm Phase 2)

Run in this order; stop and report if any step fails.

1. **Confirm the target**: account, Worker name, database, bucket — nothing
   else in the account is touched.
2. **Existing data?** If a previous D1 database holds real data, do NOT run
   the fresh migration against it. First export a backup (D1 → your database
   → Export, or `npx wrangler d1 export levonis-db --remote --output backup.sql`),
   then we design an upgrade migration from the actual schema. The
   `0001_init.sql` migration is for a fresh database.
3. **Staging first**: import the repo as a second Worker (e.g.
   `levonis-staging`) with its own D1/R2 resources, deploy, and run the
   acceptance list below there.
4. **Acceptance checklist** (staging, then production):
   - register / login / logout / session survives refresh; wrong password
     rejected; rate limit kicks in after repeated failures
   - Google sign-in (if configured); initial admin appears
   - admin: create a product (with image upload) → storefront shows it;
     hide it → it disappears from list/detail/search
   - customer: add to cart → checkout with address + delivery method →
     order appears in Orders and in admin; duplicate submit does not create
     a second order; cancel refunds wallet/points
   - wallet: deposit with receipt (stays pending) → admin approves →
     balance updates; withdrawal cannot exceed balance
   - authorization spot-checks from a second account: other users' orders,
     addresses, receipts and chats return 403/404; non-admin `/api/admin/*`
     returns 403; `/api/d1/query` returns 410
   - uploads: non-image rejected; >8 MB rejected
   - mobile layout + RTL (Arabic) pass on the main flows
5. **Production deploy** = the same Git-based deploy on the production
   Worker. Verify `/api/health`, then repeat the read-only parts of the
   checklist. No destructive tests against real customers or balances.

## Local development (for completeness)

```
npm install
npm run db:migrate:local
npm run dev            # API + built assets on 127.0.0.1:8787 (local D1/R2 emulation)
npm run dev:web        # optional: Vite HMR on :5173 proxying to :8787
```
