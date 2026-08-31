# Merchant subdomains — how a hostname becomes a store

`ali3d.levonis-iq.com` and `levonis-iq.com` are the **same Worker and the same
frontend bundle**. There is no build per merchant and no second application.
This document explains how one deployment serves both, what makes it safe, and
exactly what has to be configured in Cloudflare.

---

## 1. The security problem this design has to solve

Wildcard subdomains plus a shared session cookie create a risk that does not
exist on a single-host site, and it is worth stating before anything else:

> A page served from `evil.levonis-iq.com` is **same-origin** with
> `evil.levonis-iq.com/api/...`. That API is the same Worker, and the session
> cookie is scoped to `.levonis-iq.com`, so the request carries the visitor's
> real session.

The existing `originCheck` middleware cannot help — the origin genuinely
matches. A merchant controls the content of their own storefront. So one
platform admin visiting one hostile shop would be enough to drive platform
administration with their own credentials.

**The mitigation: `/api/admin/*` is refused on every host a merchant could
control.**

```ts
// worker/index.ts
app.use('/api/admin/*', async (c, next) => {
  if (!adminAllowedOn(c.get('host'))) {
    return c.json({ success: false, error: 'Not found' }, 404);
  }
  await next();
});
```

404 rather than 403, so a wrong-host caller learns the route does not exist
here rather than that it exists elsewhere.

### The condition is about the ROOT DOMAIN, not the label

This guard was originally `kind !== 'main'`, and that shipped an outage.
`foreign` covers two completely different situations, and treating them alike
turned a configuration mistake into a total loss of platform administration:

| Host | `kind` | `underRoot` | Admin |
|---|---|---|---|
| `levonis-iq.com`, `www.` | `main` | ✔ | **yes** |
| `ali3d.levonis-iq.com` | `merchant` | ✔ | no |
| `studio.levonis-iq.com` | `system` | ✔ | no |
| `a.b.levonis-iq.com` | `foreign` | ✔ | no — one wildcard certificate covers one level |
| `*.workers.dev`, `localhost` | `foreign` | ✘ | **yes** — operator territory, no merchant is served there |
| any host, **root domain unset** | `foreign` | ✘ | **yes** |

That last row is the one that matters. With `STORE_ROOT_DOMAIN` unset and
`APP_ORIGIN` naming a different domain, *every* host classified as `foreign` —
the apex included — and the old guard refused the admin API on the live site
while protecting nobody. A security control that fails closed onto the
operators, on a host no merchant can control, is not making anyone safer.

`tests/hosts.test.ts` pins every row above, including
*"a misconfigured root domain does not take the admin API down"*.

Merchant administration is deliberately **not** under `/api/admin`. It lives
at `/api/merchant/*`, is scoped to the caller's own store, and is a different
thing with a different name. `tests/storefrontIsolation.test.ts` asserts both
facts so a later refactor cannot merge them.

---

## 2. Host classification

`worker/lib/hosts.ts` turns a `Host` header into one of four kinds. It is pure,
does no I/O, and is the only place in the Worker where a hostname becomes a
decision.

| Kind | Example | Meaning |
|---|---|---|
| `main` | `levonis-iq.com`, `www.levonis-iq.com` | The platform. Everything is available. |
| `system` | `studio.`, `mail.`, `api.` | Reserved. Never a merchant. |
| `merchant` | `ali3d.levonis-iq.com` | A candidate slug — syntax-checked, then looked up. |
| `foreign` | anything else, incl. a spoofed `Host` | Treated as the main site. Never a merchant. |

Three rules matter more than they look:

**System names are matched in CODE, before any database lookup.** The list
lives in `SYSTEM_SUBDOMAINS` and must hold even if the database is unreachable,
mid-migration, or has had a row deleted. `studio.levonis-iq.com` is a live
product; handing it to a merchant would take down a running service.

**Only one label deep counts.** `a.b.levonis-iq.com` is `foreign`. A wildcard
certificate covers one level, and deeper names are where cookie and certificate
scoping mistakes get exploited.

**A `Host` containing a control character is refused outright**, not trimmed.
`trim()` would swallow a trailing newline and turn a header-injection attempt
into an ordinary-looking hostname.

The root domain comes from configuration (`STORE_ROOT_DOMAIN`, else derived
from `APP_ORIGIN`) and **never from the request**. With neither set, no host is
ever treated as a merchant — the platform refuses to guess which domain it is.

---

## 3. Slug rules

A slug becomes a DNS label and a public URL, so it is narrow on purpose.

- 3–32 characters, `a-z0-9-`, no leading or trailing hyphen
- **No `--`** — that is how `xn--` punycode is smuggled in, and a punycode slug
  can render as a completely different script in the address bar
- Not a system name (checked in code), not in `reserved_slugs` (checked in the
  database), not taken, not another store's recently-released slug

Mixed case is **normalised, not rejected** — hostnames are case-insensitive —
and `checkSlug` returns the value that will actually be stored so the
onboarding form can show `Ali3D → ali3d` before the merchant commits.

**Releasing a slug parks it for 180 days** (`SLUG_RESERVATION_DAYS`). Otherwise
a competitor watches for a rename and captures the traffic, and every link and
QR code already printed on a box points at them.

`slug` is **never a primary key**. Stores are keyed on `store_id`, so a future
custom domain can be mapped to a store without touching a single order (§69).

---

## 4. Frontend resolution

```
browser → GET /api/storefront/resolve → { kind, store }
```

`src/StoreContext.tsx` asks the Worker **once on boot**, then `App.tsx` renders
either the storefront application or the main site.

It deliberately does **not** parse `location.hostname`. Only the server knows
which slugs exist and which hosts are system hosts; a second answer in the
browser is a second answer that can disagree. The first paint waits for that
one request, which costs a moment and avoids flashing the wrong brand at
someone who opened a merchant's link.

`store: null` for the main site is a normal answer, not an error. A 404 means
"this host looks like a store and is not one" — rendered as *no such store*,
never as a silent redirect to the homepage, which would make a typo look like
the platform itself.

---

## 5. Routing on a merchant host

| Path | Renders |
|---|---|
| `/` | the storefront |
| `/p/:productSlug` | a product |
| `/cart`, `/checkout`, `/orders` | **the platform's** — one cart, one checkout, one history |
| `/admin` | merchant store administration (owner only) |
| anything else | the storefront |

The browser stays on `ali3d.levonis-iq.com` throughout. Nothing redirects to
`/community/store/:id` — that route still works for compatibility (§57), and
the storefront reports its canonical subdomain URL.

Cart, checkout and orders are **not** re-implemented per store. A customer has
one Levonis account, one cart and one order history wherever they are shopping
(§94).

---

## 6. Shared login

One identity, everywhere. `worker/lib/session.ts` scopes the cookie:

| Environment | `Domain` | Why |
|---|---|---|
| Production (`levonis-iq.com`) | `.levonis-iq.com` | Shared across the apex and every storefront |
| `localhost` | *(omitted)* | `localhost` has no dot; a browser rejects a single-label Domain |
| `*.workers.dev` | *(omitted)* | A public suffix; the cookie would be offered to every other tenant, and browsers reject it |

Omitting `Domain` gives a host-only cookie, which works. This matters more than
it sounds: **a browser silently discards a `Set-Cookie` with a `Domain` it will
not accept.** No error is raised. Sign-in simply never sticks, and it reads as
"login is broken" rather than "the cookie was rejected."

Attributes stay `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. Lax is correct:
the cookie survives a top-level navigation from the store to a shop, and does
not ride along on a cross-site POST.

**Logout mirrors the same `Domain` and `Path`.** A cookie deleted with
different attributes than it was created with is not deleted at all — the
browser keeps offering the old one and "log out" becomes a lie.

---

## 7. Cloudflare configuration (production)

Three things, done once. **No per-merchant DNS record is ever needed** — that
is the entire point of the wildcard, and store creation must work the instant a
slug is saved.

### 7.1 Wildcard DNS

In the `levonis-iq.com` zone, add a **proxied** record:

| Type | Name | Content | Proxy |
|---|---|---|---|
| `CNAME` | `*` | `levonis-iq.com` | **Proxied (orange cloud)** |

Existing records win over the wildcard, so `studio` and `mail` keep resolving
to their own targets. Verify that before and after:

```bash
dig +short studio.levonis-iq.com
dig +short mail.levonis-iq.com
dig +short anything-else.levonis-iq.com   # should resolve via the wildcard
```

### 7.2 Route the wildcard to the Worker

Workers → the store Worker → **Settings → Domains & Routes → Add route**:

```
*.levonis-iq.com/*
```

on zone `levonis-iq.com`. Keep the existing custom domains for
`levonis-iq.com` and `www.levonis-iq.com`.

> The Worker serving `levonis-iq.com` today is **`levonis-staging`**, not
> `levonis` — there is no Worker named `levonis` on the account. Add the route
> to the Worker that actually serves the site (see `docs/DECISIONS.md` row 52).

### 7.3 Certificate

A Universal SSL certificate covers `levonis-iq.com` and `*.levonis-iq.com` —
**one level only**, which is exactly why `classifyHost` refuses
`a.b.levonis-iq.com`. Nothing extra is needed unless deeper names are ever
wanted, which would require Advanced Certificate Manager and a matching change
to the host classifier.

### 7.4 Worker variables

| Name | Value | Notes |
|---|---|---|
| `STORE_ROOT_DOMAIN` | `levonis-iq.com` | **Set explicitly by the deploy.** Do not rely on the fallback |
| `APP_ORIGIN` | `https://levonis-iq.com` | Set, but **does not currently name this domain** — see below |

Both are plain vars. `wrangler deploy` **replaces plain-text vars wholesale**,
so use workflow `7 - Deploy Staging Code`, which reads the running Worker's
vars from the Cloudflare API and passes every one back.

> **STORE_ROOT_DOMAIN used to be optional. It is not any more, and the reason
> is a production outage.** It was derived from `APP_ORIGIN`, and `APP_ORIGIN`
> on the live Worker does not name `levonis-iq.com` — so `classifyHost`
> returned `foreign` for every host including the apex, and the apex-only
> admin guard refused the entire admin API on the platform's own domain. The
> deploy now pins the value, and `adminAllowedOn` no longer fails closed onto
> the operator (§1).

> **`APP_ORIGIN` still does not name this domain**, and the deploy warns about
> it on every run without changing it. That variable builds the links in
> outbound password-reset and verification email, so every one of those links
> currently points somewhere other than the live site. Repointing it is a
> deliberate decision for the owner — it changes what real customers receive —
> so no workflow does it automatically.

### 7.5 What is actually in place today, and what is not

Measured from GitHub Actions on 2026-08-31 (workflow **10 - Merchant
Subdomains**, read-only). This section is state, not design — re-run the
workflow rather than trusting it.

| | State |
|---|---|
| Wildcard DNS (`*`) | ✅ **in place** — an arbitrary subdomain resolves to Cloudflare |
| `studio.` and `mail.` | ✅ unaffected; the Studio answers 200 |
| Worker on the apex | ✅ `levonis-staging` |
| `STORE_ROOT_DOMAIN` on the Worker | ✅ set, and survives a Git-integration deploy |
| Apex classifies as `main` | ✅ 10/10 requests |
| Admin API on the apex | ✅ 401 for a stranger (not 404) |
| Adding to the cart | ✅ no longer 500 |
| Wildcard Worker route | ❌ **not verified** — the API token cannot read routes |
| **A redirect intercepts every subdomain** | ❌ **blocker** |
| `APP_ORIGIN` names this domain | ❌ owner decision — emailed links point elsewhere |

The §95 run (workflow 11) currently reports **10 passed, 0 failed, 15
blocked**. Every blocked item names its reason; none is counted as a pass.

**THE BLOCKER.** Every `*.levonis-iq.com` hostname answers `302` to
`https://levonis-iq-com.l.ink/…`, which then 404s:

```
$ curl -sSI https://anything.levonis-iq.com/api/health
location: https://levonis-iq-com.l.ink/api/health
server: cloudflare
```

`l.ink` is Cloudflare's link shortener. Something in the zone — a Redirect
Rule, a Page Rule, or the shortener app — matches every subdomain and answers
before any Worker route can. **No merchant storefront can load until it is
removed or narrowed**, and no §95 check that needs a subdomain can be run.

It is not currently a security exposure: the redirect means `/api/admin/*` is
unreachable on those hosts rather than served. But unreachable is not the same
as guarded, and the verification reports it as **blocked**, never as a pass.

**A THIRD DEPLOY PATH IS ALSO DEPLOYING THIS WORKER**, and it is what made
the configuration look haunted. A Cloudflare Workers Git integration deploys
`levonis-staging` on **every push to the default branch**, about 60 seconds
later, with no GitHub Actions run involved:

```
push 03:36:26  →  deploy 03:37:25   source=wrangler
push 03:40:19  →  deploy 03:41:04   source=wrangler
push 03:41:37  →  deploy 03:42:20   source=wrangler
push 03:43:21  →  deploy 03:44:22   source=wrangler
```

`scripts/prepare-deploy-config.mjs` exists to make that path safe, and it
preserves the live vars — but it only looked at names **already declared in
`wrangler.jsonc`**. `STORE_ROOT_DOMAIN` was not one, so the GitHub Actions
deploy set it at 03:31 and the next push erased it at 03:37, taking merchant
subdomain resolution with it. Both are fixed: the preservation pass now walks
every live name, and the variable is declared in the config so it can never
fall through that gap again.

If you see live configuration change without a deploy you started, this is
the first thing to check.

**It also races the asset upload.** A push during a workflow-7 deploy can put
a *different build of the same commit* on the live site — same content hash,
different bytes, because the two paths do not get the same build variables
(`VITE_GOOGLE_CLIENT_ID` among them). The byte-identity proof now retries and,
if it never converges, says so by name instead of just "different".

> **Recommendation: disconnect the Git integration.** Cloudflare dashboard →
> Workers & Pages → `levonis-staging` → Settings → Build → disconnect the
> repository. Workflow 7 is the deliberate path: it runs the tests, applies
> migrations *before* the code that needs them, carries the vars, and proves
> byte-identity afterwards. The Git integration does none of that and can
> silently replace what it deploys.

The fix is verified the only way it can be: set the variable through workflow
7, push an unrelated commit, wait for the Git-integration deploy, and read the
variable again. It has to still be there.

**Two things the owner has to do**, neither of which is code:

1. **Remove the wildcard redirect** in the Cloudflare dashboard
   (Rules → Redirect Rules / Page Rules, and the link-shortener app if it is
   enabled), so `*.levonis-iq.com` reaches the Worker.
2. **Widen the API token** on this zone with `Zone:DNS:Edit` and
   `Zone:Workers Routes:Edit`. It currently has `Zone:Zone:Read` and nothing
   else at zone level, so workflow 10 can report but cannot apply, and the
   wildcard route cannot even be read:

   ```
   cloudflare: 10000 Authentication error   (on /zones/<id>/dns_records)
   cloudflare: 10000 Authentication error   (on /zones/<id>/workers/routes)
   ```

Then re-run workflow 10 with `confirm: APPLY`, and workflow 11 to verify.

### 7.6 A forged Host header cannot reach the Worker

Worth knowing before designing a test around it: **Cloudflare rewrites the
`Host` header to the hostname it routed for.** Negotiating TLS for the apex
and sending `Host: ali3d.levonis-iq.com` does not make the Worker classify
the request as a merchant — it still sees `levonis-iq.com` and answers
`kind: 'main'`.

That is a security property (a forged Host cannot confuse this Worker about
which hostname it is serving) and a testing limitation: the Worker's
merchant-host behaviour **cannot be measured from outside** until the wildcard
route exists. `tests/hosts.test.ts` covers it against real hostnames instead,
and the live verification reports those checks as blocked rather than
inventing a verdict.

### 7.7 Verification

```bash
# The main site is unaffected
curl -s -o /dev/null -w '%{http_code}\n' https://levonis-iq.com/api/health

# A merchant host resolves to its store
curl -s https://ali3d.levonis-iq.com/api/storefront/resolve | jq .kind    # "merchant"

# A system host is never a merchant
curl -s https://studio.levonis-iq.com/ -o /dev/null -w '%{http_code}\n'   # the Studio, unchanged

# THE IMPORTANT ONE: platform admin is refused off the apex
curl -s -o /dev/null -w '%{http_code}\n' https://ali3d.levonis-iq.com/api/admin/community/overview
# expect 404 — and 200/401/403 means the host guard is not in effect
```

That last check is the one to run after every deploy that touches routing.

---

## 8. Local development and staging

Wildcard subdomains cannot be reproduced on `localhost` or `workers.dev`, and
the code does not pretend otherwise:

- `sessionCookieDomain` returns `null`, so the cookie is host-only and works
- `classifyHost` returns `foreign` for hosts outside the configured root, so
  nothing is treated as a merchant
- `storeUrl()` falls back to `/community/store/:id`, so a store link is never
  dead — it points at the in-app route instead

A store can therefore be created, managed and shopped from entirely on
staging through `/community/store/:slug`; only the vanity hostname is absent.

To exercise real subdomains locally, map them in `/etc/hosts` and set
`STORE_ROOT_DOMAIN`:

```
127.0.0.1 levonis.test ali3d.levonis.test
```

```bash
STORE_ROOT_DOMAIN=levonis.test npx wrangler dev --port 8787
```

`levonis.test` is not a public suffix and has a dot, so the shared cookie path
behaves exactly as it does in production.

---

## 9. What is deliberately not built

**Per-store DNS records.** The wildcard handles every merchant. Creating a
record per store would make store creation depend on a DNS API call that can
fail, rate-limit, or drift out of sync with the database.

**External custom domains** (`ali3d.com` → the store). The architecture is
ready for it — `store_id` is the identity and the slug is only routing — but it
needs Cloudflare for SaaS, which is a per-hostname cost and an owner decision
(`docs/DECISIONS.md` row 12). Until then, `.levonis-iq.com` is the offer.
