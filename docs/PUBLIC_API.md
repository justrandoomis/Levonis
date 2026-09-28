# Levonis Public API — `/api/public/v1`

A read-only API over everything a **signed-out visitor** can see on
levonis-iq.com, for AI agents and other tools. Give an agent
`https://levonis-iq.com/api/public/v1/context` (or `/openapi.json`) and it can
explore the shop, read prices and download product pictures as a visitor
would — with no key and no access to anything private.

Owner's request (2026-09-28): «Public Read-Only API متكامل لموقع Levonis …
بنفس مستوى وصول الزائر العادي غير المسجل، لا أكثر».

## Endpoints

| Path | What |
|---|---|
| `/` | Front door: links to `/context` and `/openapi.json` |
| `/context` | A plain-language map for AI agents: conventions, where to start, catalogue size, every endpoint |
| `/openapi.json` | OpenAPI 3.1 — every endpoint, parameter and field |
| `/site` | Name, languages, currency, delivery and payment methods, support page |
| `/navigation` | The main pages in the site's order |
| `/pages` | Every public page (and every policy as a page) |
| `/home` | The home page: blocks, hero slides, ticker, sections, newest products, flash deals, featured, editorial banners |
| `/sections`, `/sections/{slug}` | The section tree with counts and each section's pictures |
| `/brands`, `/brands/{slug}` | Brands with published products, logos |
| `/products` | Published products: `q`, `section`, `brand`, `min_price`, `max_price`, `available`, `sale`, `offer`, `sort`, `limit`, `cursor` |
| `/products/{slug}` | One product: three-language texts, every original picture, prices per option/colour/combination, availability, pre-order prices, specifications, warranty, condition report, rating, printers a part fits |
| `/products/{slug}/reviews` | Published reviews, reviewer masked as on the site |
| `/search?q=` | The site's search, plus matching sections and brands |
| `/offers` | Products on a time-limited offer now |
| `/bundles`, `/bundles/{slug}` | Bundles and mystery boxes |
| `/policies`, `/policies/{key}` | Every policy document, full Markdown text in three languages |
| `/faq` | The FAQ split into topics and questions |
| `/media` | Logo, hero slides, editorial banners, home-page pictures, brand logos, service pictures |
| `/memberships` | Membership plans, prices and benefits |

Every answer except `/`, `/context` and `/openapi.json` is
`{ "data", "meta": { "version", "pagination" }, "links": { "self", "next", "web" } }`.
Texts are `{ "ar", "en", "ckb" }`; prices are whole IQD; items are identified
by slug and carry `url` (website) and `api_url`.

## Rules (and where each is enforced)

- **Anonymous by construction.** `worker/index.ts` never loads a session for
  `/api/public/v1`; prices come from `pricingCtxForUser(db, null)`. A cookie
  changes nothing (test: *an admin session cookie changes nothing, and no
  session is even read*).
- **Read-only.** GET/HEAD/OPTIONS; any other method is 405 with `Allow`.
- **Main host only.** A merchant subdomain answers 404 (`requireMainHost`).
- **Explicit allowlists.** Every answer is built field by field in
  `worker/lib/publicApi/` (`common.ts`, `resources/*.ts`); nothing is spread
  from an internal object. The OpenAPI schemas are closed
  (`additionalProperties: false`, every property required) and the tests
  validate every live answer against them.
- **Never published** (tested with a secret marker in each place): cost and
  purchase prices, profits, suppliers and supplier links on pictures, SKUs,
  raw stock/reserved counts and thresholds, pre-order capacities, internal
  ids, customers (names are masked as on the site), orders, sessions, admin
  settings (e.g. the bank details of wallet top-up methods), drafts, hidden
  products, inactive sections, pending reviews, moderation notes, benefit-rule
  ids. Review photos are counted but not linked: their storage keys embed the
  reviewer's account id.
- **The same data the site shows.** The API calls the storefront's own
  functions — `listCatalogProducts`, `catalogProductDetail`
  (worker/routes/products.ts), `buildCatalogTree` (catalog.ts), `listBundles`
  (bundles.ts) — rather than re-implementing listing, search or pricing.
- **Offers:** only a live offer that applies to a visitor (or is shown as
  members-only) is published; an offer the admin switched off never is.
- **Members-only bundles:** listed with name and picture but no price, as the
  site shows them to a visitor.
- **Community:** the stores directory and requests board follow the community
  gate — while it is closed (the default), they are not public
  (`/site.community_open`, `/context.content.community_open_to_visitors`).
- **Caching:** answers are edge-cached per colo under their canonical URL
  (origin + path + declared parameters, sorted), with `Cache-Control: public,
  max-age≤60, s-maxage=<route>` and a weak ETag (`If-None-Match` → 304).
- **Rate limit:** 240 uncached requests / 60 s per IP (`rateLimit(c,
  'public-v1', …)`, counted only on a cache miss); 429 with `Retry-After`.
- **CORS:** `Access-Control-Allow-Origin: *`, no credentials (docs/SECURITY.md §2).
- **robots.txt:** `Allow: /api/public/v1/` before `Disallow: /api/`, so agents
  that honour robots.txt may fetch it.

## Adding an endpoint

Add a `PublicRoute` to a resource list in `worker/lib/publicApi/resources/`
(and its schemas to the module's `*_COMPONENTS`). The router, `/openapi.json`
and `/context` pick it up; `tests/publicApi.test.ts` crawls it, scans it for
leaks and validates it against its schema.

Tests: `tests/publicApi.test.ts`.
