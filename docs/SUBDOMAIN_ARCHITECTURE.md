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

### Which names a merchant can never have, and why

`SYSTEM_SUBDOMAINS` in `worker/lib/hosts.ts` holds **138 names**, checked
**before** `reserved_slugs` and kept in code on purpose: a wildcard that
resolves before the database answers is a wildcard that has to be safe without
it. They are grouped by *why*, because the reason decides whether a future name
belongs there:

| Group | Examples | Why |
|---|---|---|
| Running services | `www`, `studio`, `mail`, `send`, `api`, `app`, `community`, `support` | Handing one over takes a live product down. `send` and `mail` carry outbound email |
| Mail infrastructure | `smtp`, `mx`, `dkim`, `dmarc`, `spf`, `bounce`, `postmaster` | These names already speak for this domain's email to the rest of the internet |
| The phishing surface | `login`, `signin`, `verify`, `reset`, `password`, `secure`, `account`, `my` | A merchant controls the *content* of their storefront. On `login.levonis-iq.com` they would get a valid certificate on the real brand's domain and write the page our own customers are looking at |
| Platform functions | `admin`, `checkout`, `cart`, `wallet`, `orders`, `invoice`, `refunds` | A shop at `checkout.` is indistinguishable from the platform doing the same thing |
| Infrastructure | `cdn`, `assets`, `ns1`, `dns`, `vpn`, `git`, `ci`, `status`, `metrics` | Operator names, and the ones scanners try first |
| Environments | `dev`, `staging`, `beta`, `sandbox`, `demo`, `internal`, `docs` | A merchant on `staging.` will be mistaken for our own pre-release site |

Two of those groups are not about names we use. That is deliberate: a name is
reserved because of **who could otherwise ask for it**, not because we plan to
use it.

Names a merchant should not have for *business* reasons live in the
`reserved_slugs` table instead, so they can change without a deploy.

The list is compared against the zone's real DNS records on every run of
workflow 10 — see §7.5.4.

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
blocked** against production. Every blocked item names its reason; none is
counted as a pass.

### The same run against a local deployment: 60 passed, 0 failed

The verification takes its scheme and port from the apex, so it runs against
`wrangler dev` with `STORE_ROOT_DOMAIN=levonis.test` and the hostnames mapped
in `/etc/hosts`. That is a real Worker, a real D1, real HTTP and real
subdomain hostnames — everything except Cloudflare's edge.

```bash
npm run build
STORE_ROOT_DOMAIN=levonis.test npx wrangler dev --port 8787 \
  --var STORE_ROOT_DOMAIN:levonis.test --var APP_ORIGIN:http://levonis.test:8787

APEX=http://levonis.test:8787 SLUG=myshop RUN_ID=local \
  ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/e2e-subdomains.mjs
```

Proven there, with no financial movement at all:

| | |
|---|---|
| PLUS granted by an admin | entitlement, `price_paid_iqd` 0, no wallet row |
| merchant to a store on `myshop.levonis.test` | `kind: merchant`, the store resolves |
| shared login | the apex session works unchanged on the storefront host |
| `/api/admin/*` on the storefront host | **404** — the guard, on a real merchant hostname |
| the merchant's own `/admin` | 200 for the owner on the store host |
| store isolation | an account with no store gets `null`, not someone else's |
| product published | visible on the storefront |
| one cart | the same cart on both hosts; `CART_SELLER_CONFLICT` names both shops |
| R2 | upload to logo to served; an off-platform or foreign reference refused |
| Community | request, attachment (key never in a response), offer, one-live-offer rule |
| Community admin | overview, board with the customer named, reputation, store-only suspension |

What production adds that local cannot: Cloudflare's edge — the wildcard
record, the route, and whatever else in the zone answers before either of
them. That is what §7.5.1 below is about.

### 7.5.1 The blocker is gone: what production answers today

Both owner actions landed. The wildcard redirect to `l.ink` was removed by
hand, the API token was widened to `Zone:DNS:Edit` + `Zone:Workers Routes:Edit`
+ `Zone:Zone:Read` scoped to this zone, and workflow 10 wrote the last missing
piece — the route. Read-only run afterwards:

| | |
|---|---|
| An arbitrary subdomain resolves | resolving |
| …and reaches the Worker (HTTP) | **200** |
| Wildcard DNS record | `CNAME * -> levonis-iq.com`, proxied |
| Wildcard route | `*.levonis-iq.com/*` → `levonis-staging` |
| `/api/admin/*` on a merchant host | **404** |

And the §95 run against the live site, with no credentials of any kind:

| Checked on levonis-iq.com | Result |
|---|---|
| the apex classifies as the platform, ten requests running | `main` ×10 |
| a nonexistent subdomain | 404, `kind: merchant` — a missing store, not the homepage |
| `studio.levonis-iq.com` | 200, system host, untouched by the wildcard |
| `/api/admin/community/overview` on a merchant host | 404 |
| the same route on the apex | 401 — it exists, the stranger is refused |
| register on the apex, then call the storefront host | the same session, the same user |
| add to cart on the apex, then read it on the storefront host | the same cart |

Three checks stay **blocked and are not blockable any other way**: they ask
what the Worker does with a *forged* `Host`, and Cloudflare rewrites `Host` to
the hostname it routed for (§7.6), so the question cannot be asked from
outside at all. `tests/hosts.test.ts` asks it directly, against the same real
hostnames.

### 7.5.2 The merchant half, without a single credential

Creating a store needs PLUS, and granting PLUS needs an admin session. That
does **not** make the merchant half unverifiable, because §13 is not really
about creating a store — it is about what a wildcard hostname does once one
exists. So the verification finds a store that already exists instead:

1. `GET /api/community/products` — public. Any active merchant product.
2. `POST /api/cart/merchant-items` with that product id. The response carries
   the store it belongs to, **slug included**.
3. That slug is a real storefront hostname, and everything else runs there.

Nothing has to be configured and nothing is secret. What it proves on the real
hostname of a real shop: the storefront resolves and serves the app, the
session from the apex is the same user, the cart line is visible, the store
publishes its products, platform admin is 404, and a visitor is not the
merchant (`can.store: false`, and the merchant product list refuses them).

It also proves the one-seller rule the hard way: the first attempt is made
while a LEVONIS item is in the cart and must be **refused** with
`CART_SELLER_CONFLICT` naming both shops, before `replaceCart` is used.

Locally that path is 29 passed / 0 failed; the whole chain with an admin is
60 passed / 0 failed. No money moves in either: a cart line is not a ledger
entry, and the order and escrow steps stay behind `ALLOW_FINANCIAL`.

**On production it found nothing to discover**, and that is the real answer
to why the merchant half is still unproven there:

```
BLK  a published merchant product is discoverable
     — no active community product exists on this deployment yet
```

`GET /api/community/products` on levonis-iq.com returns an empty list, and
the deploy's own read of the live database agrees:

```
live store slugs read (json): 0
slugs=ok
```

**No merchant store exists on the live site at all.** Credentials were
never the blocker for most of it — there is no shop to look at. That also
means the reserved-list expansion could not have taken any storefront offline,
because none exists yet.

So the remaining work is not code and needs no credential handed to anyone:
**open one store on production and publish one product**, through the site's
own admin and merchant screens. `POST /api/memberships/admin/grant` will make
an account PLUS without a payment; onboarding and the first product are the
merchant's own screens. Then re-run workflow 11 and the whole chain above
becomes measurable on the live domain.

One step stays blocked even then, and honestly so: **the owner reaching their
own `/admin` on their store host** needs that owner's session, which no
discovery can substitute for.

### 7.5.3 The Git integration: the case for keeping it, and against

A Cloudflare Workers Git integration deploys `levonis-staging` on **every push
to the default branch**, about 60 seconds later, with no GitHub Actions run
involved:

```
push 03:36:26  →  deploy 03:37:25   source=wrangler
push 03:40:19  →  deploy 03:41:04   source=wrangler
push 03:41:37  →  deploy 03:42:20   source=wrangler
push 03:43:21  →  deploy 03:44:22   source=wrangler
```

It has caused exactly two real failures here, and the code now absorbs both.

**1. It erased a live variable.** `wrangler deploy` replaces plain-text vars
wholesale, so a deploy that does not carry `STORE_ROOT_DOMAIN` deletes it.
Workflow 7 set it at 03:31; the next push erased it at 03:37, taking merchant
subdomain resolution down with it.

*Fixed in code.* `scripts/prepare-deploy-config.mjs` used to preserve only
names already declared in `wrangler.jsonc`, and `STORE_ROOT_DOMAIN` was not
one. It now reads the live vars from the Cloudflare API and walks the **union**
of live and declared names, so a variable it has never heard of still survives
a deploy. The variable is also declared in the config, so it cannot fall
through that gap twice.

**2. It races the asset upload.** A push during a workflow-7 deploy can put a
*different build of the same commit* on the live site — same content, different
bytes, because the two paths do not get the same build variables
(`VITE_GOOGLE_CLIENT_ID` among them).

*Absorbed, not fixed.* The byte-identity proof retries, and if it never
converges it names this race instead of reporting a bare "different". It
happened once and passed on re-run with no code change.

Nothing else it does is harmful. It cannot touch DNS, routes, secrets, or the
database, and it deploys the same commit workflow 7 deploys.

**The comparison, plainly:**

| | Keep it connected | Disconnect it |
|---|---|---|
| Migrations | **Never applied.** A push whose code needs a new column deploys that code with the old schema for as long as it takes someone to run workflow 7 | Workflow 7 applies migrations *before* the code that needs them |
| Tests | **Not run.** A push that fails CI still reaches production ~60s later | A red build never deploys |
| Variables | Preserved now — by a script, on every path, verified after the fact | Preserved by the same script; one less path that has to be right |
| Asset bytes | Can race workflow 7 and win | One writer |
| Rollback | Reverting the branch is enough | Reverting the branch, then workflow 7 |
| Speed | Push, and it is live in ~60s | Push, run workflow 7, ~4 min |
| Blast radius of a bad push to the default branch | Immediate | Bounded by the workflow gate |

**The recommendation is to disconnect it, and the reason is the migration
row, not the variable row.** The variable failure is fixed in code and cannot
recur. The migration failure cannot be fixed in code from this side: a deploy
path that does not know about `migrations/` will always be able to ship code
ahead of its schema, and the window is a live customer database.

**It has not caused an overwrite since the fix.** No variable has gone missing
across any push since `prepare-deploy-config.mjs` started walking the union,
and the byte-identity check has passed on every run since. So this is not
urgent, and the integration is not currently doing damage — it is a path that
skips the two gates that exist for a reason.

**The one condition that should force the decision:** the next migration. Do
not merge a schema change to the default branch while this is connected
without running workflow 7 first, or accept disconnecting it before that
merge.

To disconnect: Cloudflare dashboard → Workers & Pages → `levonis-staging` →
Settings → Build → disconnect the repository. Nothing in this repo needs
changing; workflow 7 is already the deliberate path.

### 7.5.4 The reserved list is now checked against the zone, not memory

`SYSTEM_SUBDOMAINS` protects 138 names in six documented groups (§3). A list
somebody typed can fall behind the zone, so workflow 10 now compares the two
on every run — `scripts/audit-reserved-subdomains.mjs`, tested in
`tests/reservedSubdomains.test.ts`:

* a **proxied** DNS record whose name is not reserved **fails the run**. The
  wildcard route matches a hostname whether or not it has its own record, so
  that name's traffic reaches the Worker and would classify as a merchant slug.
* an **unproxied** record that is not reserved is a warning: it never reaches
  the Worker, but a merchant could still take the slug.
* the reverse is deliberately not checked. Reserving a name with *no* record
  is the entire point of the phishing group.

That is what makes "and any subdomain already dedicated to an existing
service" a check rather than a promise. Against the live zone:

```
one-label names with DNS records under levonis-iq.com: 4
  ok   _acme-challenge  (TXT)        — not a usable slug, no merchant can claim it
  ok   send  (MX+TXT, proxied=false) — reserved in code
  ok   studio  (AAAA, proxied=true)  — reserved in code
  ok   www  (CNAME, proxied=true)    — reserved in code
audit=ok
```

Note what that list does *not* contain: `mail` has no record of its own, so
`mail.levonis-iq.com` now resolves through the wildcard and reaches the
Worker. It is reserved in code, so it classifies as `system` and no store can
ever be served there. Mail delivery is unaffected — that runs on the apex's MX
records, which the wildcard does not touch.

And reserving a name is not free in the other direction either: `classifyHost`
consults the list BEFORE looking a slug up, so a name that becomes reserved
stops resolving to its store the moment the deploy lands. Workflow 7 therefore
reads the live store slugs and refuses to deploy if any of them just became
reserved (`scripts/check-live-store-slugs.mjs`) — after the migrations,
before the deploy.

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
