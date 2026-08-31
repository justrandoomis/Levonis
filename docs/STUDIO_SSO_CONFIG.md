# LEVO Studio sign-in — its configuration, and where each value lives

> **Status: configured and deployed.** The owner set the three repository
> secrets, and workflows 7 and 8 carried them onto the two Workers that serve
> users. Both are verified from Cloudflare's own binding list by
> `15 - Verify Live Auth`, which then walks the whole handoff against the live
> origins. The rest of this document is the reference for what each value is
> and where it lives — read it when something needs changing, not to enable
> anything.

The server-to-server sign-in handoff between `levonis-iq.com` and
`studio.levonis-iq.com` is **fully implemented on both sides**. Nothing is
left to write. Before the secrets were set it was disabled, and every endpoint
said so honestly (`503 STUDIO_NOT_CONFIGURED`, `AUTH_NOT_CONFIGURED`) rather
than half-working.

This document names those three values, says exactly where each one goes, and
gives the format each is parsed with. **No real value appears here, and none
should ever be pasted into a chat, a commit, an issue or a log.**

---

## 1. The three names, at a glance

| Name | GitHub repository secret? | Cloudflare Worker secret? | Cloudflare Worker variable? | On which Worker |
| --- | --- | --- | --- | --- |
| `STUDIO_HANDOFF_SECRET` | **yes** | **yes — on BOTH Workers** | no | main site **and** Studio |
| `STUDIO_ALLOWED_DESTINATIONS` | **yes** | no | **yes**, as `STUDIO_ALLOWED_DESTINATIONS` | main site only |
| `STUDIO_PROD_MAIN_SITE_ORIGIN` | **yes** | no | **yes**, but renamed to `MAIN_SITE_ORIGIN` | Studio only |

Two things in that table are easy to get wrong, so they are worth stating
plainly:

* `STUDIO_HANDOFF_SECRET` is **one value that must be identical on two
  Workers**. It is the bearer credential the Studio Worker presents and the
  main-site Worker checks. Set the GitHub secret once; the deploy workflows
  upload the same value to both.
* `STUDIO_PROD_MAIN_SITE_ORIGIN` is **a GitHub secret name that no Worker ever
  reads**. The workflow passes its value through as the Worker variable
  `MAIN_SITE_ORIGIN`. Looking for `STUDIO_PROD_MAIN_SITE_ORIGIN` in the
  Worker's variables will always come up empty; that is correct.

---

## 2. Each value in detail

### `STUDIO_HANDOFF_SECRET` — a shared bearer credential (SECRET)

**Read by both Workers.**

* main site: `worker/routes/studio.ts` → `requireStudioSecret()`, which
  refuses with `503 STUDIO_NOT_CONFIGURED` when it is empty.
* Studio: `studio/worker/auth/callback.ts` → sent as
  `Authorization: Bearer <value>` to `/api/studio/handoff/redeem`;
  `studio/worker/auth/session.ts` uses it again for `/handoff/introspect`.

**Format.** An opaque high-entropy ASCII string. The code `.trim()`s it and
compares it in constant time after hashing both sides, so length is not
constrained and no character class is required. Practically: **at least 32
bytes of randomness**, URL-safe characters only (leading/trailing whitespace
is stripped, so it cannot carry meaning).

A suitable value is produced locally by, for example,
`openssl rand -base64 48 | tr -d '\n'` — **run it on your own machine, and do
not paste the output anywhere except the GitHub secret field.**

**Where to put it.** One place: the GitHub repository secret. The deploy
workflows do the rest with `wrangler secret put`, which is why it must never
be a plain variable — a variable is readable in the Cloudflare dashboard and
in `wrangler deploy` output.

**When unset:** sign-in fails closed. The main site answers
`503 STUDIO_NOT_CONFIGURED`; Studio's callback redirects to
`/?auth_error=denied`. No user is ever signed in by accident.

---

### `STUDIO_ALLOWED_DESTINATIONS` — the destination allowlist (VARIABLE)

**Read by the main-site Worker only**, in
`worker/routes/studio.ts` → `allowedDestinations()`.

**Format.** A **comma-separated list of exact origins**. The parser is:

```ts
(STUDIO_ALLOWED_DESTINATIONS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean)
```

So:

* scheme is **required** — `https://studio.levonis-iq.com`, not
  `studio.levonis-iq.com`;
* a trailing slash is tolerated and stripped — the stored value on the live
  Worker has one, and it is correct;
* surrounding spaces are tolerated;
* the incoming `?dest=` is reduced to `new URL(dest).origin` and matched with
  `Array.includes` — **exact origin equality, no prefixes and no wildcards**.
  A port, a path or a different scheme will not match.

Shape of the value (one entry, or several separated by commas):

```
https://studio.levonis-iq.com
https://studio.levonis-iq.com,https://levonis-studio-staging.<subdomain>.workers.dev
```

This is not sensitive — it is a list of public hostnames — but the existing
workflows read it from a repository secret, so keep it there for consistency.
It reaches the Worker as a plain-text variable via `--var`.

**When unset:** `503 STUDIO_NOT_CONFIGURED` with the message naming this
variable. When set but not containing the destination the Studio host asks
for: `403`, and the code is never minted.

---

### `STUDIO_PROD_MAIN_SITE_ORIGIN` → `MAIN_SITE_ORIGIN` (VARIABLE)

**Read by the Studio Worker only**, as `MAIN_SITE_ORIGIN`, in
`studio/worker/auth/session.ts` → `mainSiteOrigin()`:

```ts
(env.MAIN_SITE_ORIGIN || env.MAIN_ORIGIN || '').trim().replace(/\/+$/, '')
```

**Format.** A **single origin**, scheme included, no path. A trailing slash is
tolerated and stripped by `mainSiteOrigin()`; the stored value on the live
Worker has one, and it is correct:

```
https://levonis-iq.com
```

This is the origin Studio calls server-to-server for `/handoff/redeem` and
`/handoff/introspect`. It is not sensitive.

**When unset:** `mainSiteOrigin()` returns `''`, the redeem fetch has no host
to reach, and sign-in stays disabled — again failing closed.

---

## 3. Where to set them, given which Workers are actually live

This is the step most likely to be wasted effort, because the Worker names
are inverted (`docs/DECISIONS.md` row 52), and the audit in
`12 - Audit Studio Migrations and Routing` confirmed it from Cloudflare's own
configuration rather than from behaviour:

```
custom domain   studio.levonis-iq.com -> service=levonis-studio-staging (env=production)
zone route      studio.levonis-iq.com/* -> levonis-studio-staging
zone route      *.levonis-iq.com/*      -> levonis-staging
custom domain   levonis-iq.com        -> levonis-staging
```

So the two Workers that serve the live domains are **`levonis-staging`** (main
site) and **`levonis-studio-staging`** (Studio). The Workers called
`levonis-studio` (and any `levonis` — there is none) serve no domain.

**Therefore:**

1. Add the three repository secrets in
   **GitHub → Settings → Secrets and variables → Actions → Repository secrets**:
   * `STUDIO_HANDOFF_SECRET`
   * `STUDIO_ALLOWED_DESTINATIONS`
   * `STUDIO_PROD_MAIN_SITE_ORIGIN`
2. Re-run the two workflows that deploy the **live** Workers:
   * `7 - Deploy LIVE main site levonis-staging` — main site. It sets
     `STUDIO_ALLOWED_DESTINATIONS` as a var and uploads
     `STUDIO_HANDOFF_SECRET` to `levonis-staging`.
   * `8 - Deploy LIVE Studio levonis-studio-staging` — Studio. It sets `MAIN_SITE_ORIGIN`
     from `STUDIO_PROD_MAIN_SITE_ORIGIN` and uploads `STUDIO_HANDOFF_SECRET`
     to `levonis-studio-staging`.

   (`4 - Rebuild levonis-studio-staging (LIVE Studio)` also uploads to `levonis-studio-staging`, but
   `wrangler deploy` replaces plain-text vars wholesale, which is exactly why
   the "keeps vars" workflows exist. Prefer them.)

   Running `5 - Deploy levonis-studio (ALTERNATE …)` would put the secret on
   `levonis-studio`, which no domain points at — it would look successful and
   change nothing about sign-in.

3. Verify by opening `https://studio.levonis-iq.com/auth/login` while signed
   in on the main site. Success lands back on Studio signed in; any failure
   lands on `/?auth_error=denied` and never signs anyone in.

---

## 4. What the handoff does, in one pass

1. Studio `GET /auth/login?return_to=/x` mints a `state` nonce, stores it with
   the sanitized return path in a short-lived host-scoped cookie, and
   redirects to the main site's
   `GET /api/studio/handoff/start?dest=<studio origin>&state=<nonce>`.
   — `studio/worker/auth/callback.ts`
2. The main site validates `dest` against `STUDIO_ALLOWED_DESTINATIONS`
   (exact origin), requires a live `levonis_session`, mints a 32-byte
   single-use code stored **only as its SHA-256 digest**, bound to the user and
   that destination, expiring in 60 seconds, and 302s the browser to
   `<dest>/auth/callback?code=…&state=…`. — `worker/routes/studio.ts`
3. Studio's callback compares `state` against its own cookie — this is what
   makes a top-level GET safe against login-CSRF — then redeems the code
   **server-to-server** with `Authorization: Bearer STUDIO_HANDOFF_SECRET`.
4. The main site consumes the code with a single conditional `UPDATE`
   (atomic; a replay, an expired code, or a mismatched destination all get one
   uniform `BAD_CODE`) and returns the minimum identity only:
   `{ user_id, display_name, locale }` — no email, no phone, no roles, no
   wallet, no KYC.
5. Studio mints its own session row and cookie and redirects to the return
   path, so the code never renders a page and leaves the URL immediately.
6. `POST /api/studio/handoff/introspect` lets Studio's sensitive endpoints ask
   whether the user still has any live main-site session, so a main-site
   logout reaches Studio.

The `studio_handoff_codes` table backing step 2 is created by
`migrations/0012_studio_handoff.sql` on the **store** database (`levonis-db`),
which is a different database from the Studio one and already applied there.

---

## 5. What was actually missing from the architecture, and is now wired

Step 6 above was **not real** until this round. `verifyMainSessionLiveness`
existed in `studio/worker/auth/session.ts` and `/api/studio/handoff/introspect`
existed in `worker/routes/studio.ts`, both complete and both secret-gated — and
**nothing in the repository called either of them.** The module comment
promised that main-site logout reaches Studio; nothing made it true. Since
Studio mints its own 14-day session at sign-in, the practical effect was that
logging out of `levonis-iq.com` would have left the account signed in on
`studio.levonis-iq.com` for a fortnight.

It is wired now, in `studio/worker/index.ts` on the `/api/*` branch:

* the check runs only on API requests, never on assets or SSR documents;
* the answer is cached per user for **60 seconds**, so an editing session makes
  one call rather than one per request;
* **only a definite `inactive` revokes.** `unknown` — unconfigured,
  unreachable, a non-200, a malformed body — keeps the session. This is
  deliberate and is the whole reason the helper returns three states rather
  than a boolean: the handoff is currently unconfigured, which answers
  `unknown` for everyone, and failing closed there would sign out every
  account on a feature that is supposed to be off;
* a revocation destroys **all** of that user's Studio sessions, so a second
  browser is not a way to keep a revoked session alive;
* a revoked session becomes a **guest**, not an error — editing keeps working,
  account features stop, matching the existing guest posture;
* the cached verdict is cleared on logout and on a fresh redemption, so
  signing back in is not shadowed by a stale `inactive`.

Six tests in `studio/tests/auth-handoff.test.mjs` cover this against both real
workers in-process, and each was proved by breaking what it guards.

### Two smaller things found in the same pass

* **`APP_ORIGIN` on the Studio Worker is written by three workflows and read by
  nothing.** It is declared in `studio/wrangler.jsonc` and typed in
  `studio/worker/index.ts`, and the comments describe it as driving return-URL
  validation and cookies. It does not: return paths are validated by
  `safeRelativeReturnPath`, which only ever accepts same-origin **relative**
  paths and needs no origin to do it, and the session cookie is host-scoped by
  omitting `Domain`. Setting `STUDIO_PROD_APP_ORIGIN` therefore changes
  nothing. It is left in place rather than removed — removing a var that three
  workflows write is a larger change than this round should make — but it
  should not be relied on.
* **`STUDIO_ALLOWED_DESTINATIONS` was not declared in the root
  `wrangler.jsonc`.** That file's own comment, two lines above where it now
  sits, explains why that matters: "a name that is not in this file is a name
  the Workers-Builds preservation pass cannot see, and an unpreserved var is a
  wiped var." It is declared now, in both the top-level and the `staging`
  blocks, so the value cannot be silently wiped after you set it.
* **`deploy-staging-code.yml` had a var-preservation bug** on exactly this
  path: three of its four `grep -v "^NAME<TAB>"` lines used a real tab and the
  fourth used the two characters `\t`, which a BRE reads as a literal `t`. The
  `GOOGLE_CLIENT_ID` line therefore survived and a duplicate `--var` reached
  wrangler. Fixed, and pinned by a test.

---

## 6. The email switch has two halves, and one of them was unsettable

This is not part of the Studio handoff, but it was found by the same live run
and it has the same shape, so it belongs beside it.

`/api/auth/capabilities` decides both email features with one expression
(`worker/routes/auth.ts`):

```ts
const mail = !!(c.env.EMAIL_API_KEY && (c.env.EMAIL_FROM || '').trim());
// passwordReset: mail, emailVerification: mail
```

`worker/lib/outbox.ts` refuses identically:
`if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return { ok: false, error: 'EMAIL_NOT_CONFIGURED' }`.

So **both** are required. On the live Worker `EMAIL_API_KEY` was correctly
installed as a secret and `EMAIL_FROM` was present as a plain var **with an
empty value** — and nothing could change that, because `7 - Deploy LIVE main
site` reads the Worker's current vars and writes them back, which can carry a
value forward but can never introduce one. Setting the API key and redeploying
any number of times would have left password reset and email verification
switched off, with `capabilities` honestly reporting `false` and both
endpoints answering `503 EMAIL_NOT_CONFIGURED`.

| Name | GitHub secret | Worker secret | Worker variable | On which Worker |
| --- | --- | --- | --- | --- |
| `EMAIL_API_KEY` | **yes** | **yes** | no | main site |
| `EMAIL_FROM` | **yes** | no | **yes**, same name | main site |

**`EMAIL_FROM` format.** Either `user@domain` or `Name <user@domain>`. The
deploy validates that shape and refuses anything else, because a malformed
sender's only symptom at Resend is mail that never arrives.

**It cannot be defaulted.** The sending domain must be verified in the owner's
Resend account; an address invented in this repository would be rejected on
every send. That is why it is the owner's value and why the workflow asks for
it rather than assuming one.

`EMAIL_ALLOWED_RECIPIENTS` must stay **empty** on the live Worker. When it is
set, `outbox.ts` marks any send to an address outside the list as `skipped` —
the API still reports success and the message never leaves. Workflow 7 already
refuses to deploy while it is set.
