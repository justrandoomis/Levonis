# Merchant stores — data model, authorization, money

How a LEVO PLUS member becomes a merchant with a working shop, and what stops
them reaching anyone else's data or money.

For hostnames and Cloudflare setup see `SUBDOMAIN_ARCHITECTURE.md`.
For the request/offer/escrow marketplace see `COMMUNITY_V2.md`.

---

## 1. Identities

Four distinct ids. **None is ever treated as another**, even where a one-to-one
relationship happens to hold today (§5).

| Id | Table | Is |
|---|---|---|
| `user_id` | `users` | a Levonis account |
| `merchant_id` | `community_merchants` | the trading entity |
| `store_id` | `merchant_stores` | the storefront |
| `slug` | `merchant_stores.slug` | routing identity **only** — never a key |

`merchant_stores.user_id` is denormalised so an ownership check is one indexed
read. It is never the authorisation on its own: every mutation joins through
the store row and compares against the session user.

### PLUS ≠ verified

Two different questions, two different columns, never merged (§43):

- **PLUS** (`memberships`) — *may this account operate a store?*
- **`community_merchants.verified`** — *has Levonis checked this merchant?*

A brand-new PLUS member can sell. Only an admin can verify.

---

## 2. Entitlements

`worker/lib/entitlements.ts` — server-side, always. The frontend renders what
`/api/merchant/me` says and never inspects a tier string
(`tests/storefrontIsolation.test.ts` asserts this).

| Benefit | PLUS | PREMIUM (`prime`) | PRO |
|---|---|---|---|
| `merchantStore` | ✅ | ✅ | ✅ |
| `merchantProducts` | ✅ | ✅ | ✅ |
| `merchantOrders` | ✅ | ✅ | ✅ |
| `communityOffers` | ✅ | ✅ | ✅ |
| `merchantAnalytics` | ✅ | ✅ | ✅ |
| `merchantSubdomain` | ✅ | ✅ | ✅ |

**Every higher tier inherits every PLUS merchant benefit.** A benefit is
introduced once, at the lowest tier that owns it (`ENTITLEMENT_MINIMUM_TIER`),
and `TIER_INHERITANCE` hands it up the ladder: PLUS → PREMIUM → PRO. A PREMIUM
or PRO member is a more privileged merchant, never a lesser one — **PREMIUM may
open a store.** (PREMIUM is stored as `prime`, the tier's historical id; every
customer-facing surface says PREMIUM.) An earlier version of this table said
PRIME inherited none; the code never worked that way (audit 01 B20).

They are separate names rather than one flag because `gated_benefits` works per
name: an admin must be able to suspend exactly one capability — publishing
products, say — over a complaint, without cancelling a paid membership or
locking the merchant out of their own order history (§84).

---

## 3. Authorization

`worker/lib/merchantAuth.ts` keeps two questions apart on purpose.

### `requireStoreOwner` — *may you see this?*

Resolves the caller's own store **from their session**. There is no store id in
any `/api/merchant/*` path or body for anyone to swap.

### `requireSellingPrivileges` — *may you take on new commitments?*

The same store, plus: merchant not suspended, store not suspended or paused,
and `merchantStore` currently granted. Each refusal is `403` with its own code —
`MERCHANT_SUSPENDED`, `STORE_SUSPENDED`, `STORE_PAUSED`, `SUBSCRIPTION_INACTIVE`
— so the screen can say which of them applies.

### `requireOfferPrivileges` — *may you make a new promise on a request?*

`requireSellingPrivileges` plus a merchant in good standing. Anything but
exactly `active` — a `restricted` merchant, or a status nobody has taught the
gate — is `403 MERCHANT_RESTRICTED`. It guards making an offer, editing one (an
edit re-prices and re-confirms) and re-confirming a stale one; withdrawing stays
on `requireSellingPrivileges`, because taking a promise back is never refused.
The buy path asks the same of a store's owner (`storeTakesOrders`), and accepting
a standing offer from a merchant sanctioned since it was made is
`409 MERCHANT_UNAVAILABLE` (audit 03 V, audit 04 #23).

**Collapsing these is how an expired subscription ends up hiding a merchant's
own unpaid invoices.** When PLUS lapses:

| Still available | Stops |
|---|---|
| Orders, order details, delivery info | Publishing products |
| Earnings, payout ledger | Receiving new orders |
| Reviews and replies | Submitting offers |
| Customers, analytics, chats | Changing the store slug |
| **Finishing accepted work** | |

Nothing is deleted, ever. Renewal restores selling immediately (§48).

---

## 4. Store lifecycle

```
merchant.status : active | restricted | suspended     (admin)
store.status    : active | paused | suspended         (paused = merchant's own; suspended = admin)
```

**Two sanctions, two rows** (audit 04 B2, audit 01 B8). The merchant route
(`POST /api/admin/community/merchants/:id/status`) writes only
`community_merchants`; the store route (`POST /stores/:id/status`) writes only
`merchant_stores`. Neither overwrites the other, so restricting or restoring a
merchant never re-opens a store its merchant paused or an admin suspended.
Migration 0118 handed back the stores the old cascade had suspended *along with*
their merchant — with no store decision of their own on the audit record — as
`paused`: closed, and re-openable by the merchant alone once restored.

| | Storefront | New store orders | New offers | Work already owed |
|---|---|---|---|---|
| store `paused` (the merchant's switch) | renders, says it is closed | ✗ | ✗ `STORE_PAUSED` | ✓ |
| merchant `restricted` | live and editable | ✗ | ✗ `MERCHANT_RESTRICTED` | ✓ |
| store `suspended` | «المتجر غير متاح حاليًا» only | ✗ | ✗ `STORE_SUSPENDED` | ✓ |
| merchant `suspended` | «المتجر غير متاح حاليًا» only | ✗ | ✗ `MERCHANT_SUSPENDED` | ✓ |

**A suspended store shows only «المتجر غير متاح حاليًا»** (owner decision,
2026-09-24). Its own suspension or its owner's — `storeIsSuspended`,
worker/lib/merchantAuth.ts — and every `/api/storefront/*` read answers
`404 STORE_UNAVAILABLE` with no merchant-controlled field: no products, banner,
bio or reviews, not even the name, which may be the very thing it was suspended
for. `/resolve` says the same on the store's own host, the web manifest falls
back to the platform's identity, and the share card, the sitemap entry and the
community listings drop it. A `paused` store is not a sanction: it renders and
says it is closed. Existing customers keep their orders and chats either way.

A suspended store still **saves its settings** — everything but `open`, which
answers `STORE_SUSPENDED` (or `MERCHANT_SUSPENDED` / `SUBSCRIPTION_INACTIVE`)
while the rest of the form lands (audit 01 B4).

A merchant can pause and re-open their own shop. **A merchant can never lift an
admin suspension** — that state is not reachable from the settings endpoint at
all, and the UI shows the reason instead of a disabled control.

A visitor is told a shop is closed or unavailable, never *why*. Whether the
merchant paused it, an admin suspended it, or their subscription lapsed is
between them and Levonis (§51).

### Addresses

A renamed store's old slug is parked for 180 days (`SLUG_RESERVATION_DAYS`) and
**keeps pointing at the shop** until another store claims it: on the old host
`/resolve` answers `404 STORE_MOVED` with `details.redirect` and the app
replaces the address; `/api/storefront/<old slug>` serves the store. A live slug
always wins over a parked one (audit 01 B14). A store under a sanction is not
followed there: its old address answers `STORE_UNAVAILABLE` and never discloses
the new one (review S4). The deploy guard checks these retired names too, and
stops the deploy when it cannot read them (review F9). Every literal segment of the
storefront router (`resolve`, `by-id`, `sections`, …) and `p` are reserved
slugs (worker/lib/hosts.ts, group 7; the router is walked by a test — B23). A
slug lost to a concurrent onboarding or rename is `409 SLUG_UNAVAILABLE`, a
double-tapped onboarding `409 STORE_EXISTS` — never a raw 500 (B24). The domain
under which addresses live comes from the server (`root_domain` on `/me` and on
every `/resolve` answer), never from a literal in the app (B19).

---

## 5. Products

`community_products`, extended rather than replaced (0001 → 0030).

**The state is `publish_state`** (0126): `draft | published | hidden | archived`,
CHECK-constrained. `lifecycle` (`active` for published) and `status` are
trigger-maintained mirrors, so a reader that predates it is never lied to.
«Sold out» is DERIVED (tracked stock at zero), never stored; the old manual
`sold_out` became `hidden`, which is what customers saw (0127, DECISIONS 126).

**Variants** (0126): up to 3 option groups, 30 values each, 100 variants, each
with its own price override, compare-at, stock, SKU, active flag, picture and
low-stock line. The product's stock is the sum of its active variants
(triggers). The server prices the chosen variant at add and at checkout; a
client sends a variant id, never a price. Products still sold by the pre-0126
`options`/`colors` JSON are `variant_mode = 'legacy'` and sell exactly as
before until converted (automatically only when nothing must be invented —
the `catalog_legacy_variants` job — otherwise by the merchant in the editor).
Media are ordered rows (images and up to 2 videos, 12 in all, alt text), and a
printed product carries typed attributes (material from the platform list,
technology, palette colour, finish, dimensions, weight).

**Collections are the sections** (same rows, same ids): manual ones hold
products in the merchant's order; `featured`, `new_arrivals` (30 days) and
`best_sellers` are computed, one of each per store.

**Editing is real.** The old dashboard could create and delete but not edit, so
fixing a mistyped price meant deleting the product and losing its history.

**Delete is archive when the product has ever been ordered.** Removing the row
would blank out what a customer actually bought. `DELETE` is only honoured for
a product nothing has ever touched, and the UI says which happened.

**Duplicating starts as a draft** — copying a live product straight to the
storefront publishes an unedited clone to real customers.

**A product Levonis hid stays hidden** (audit 01 B9). The hide is Levonis's own
state — `admin_hidden_at`, `admin_hidden_reason` (0118) — beside the merchant's
`lifecycle`, not written over it. The merchant may still edit the product
(fixing what it was hidden for is the point) but not publish or duplicate it:
`409 PRODUCT_HIDDEN_BY_ADMIN`, with the reason, and the dashboard shows
«أخفته Levonis» and why. `status` is computed in the same SQL statement, where
the hide wins, so no path can surface it. Only
`POST /api/admin/community/products/:id/hide {hidden:false}` lifts it, and the
merchant's own lifecycle choice is what returns.

**One door for products.** The legacy `POST /api/community/my-store/products`
and `DELETE …/:id` wrote store-less rows with any image URL and hard-deleted
ordered products; they now answer `307` to the store routes above, so an old
client still works — under these rules (audit 01 B10).

The public storefront shows a product's sales as a rounded-down tier
(`sales_tier`: «+200»), never the exact `sold_count`; a product view counts one
visitor per product per day, and never the owner or a crawler (audit 04 #20,
#21). Lists page by `(created_at, id)` so rows sharing an instant — a CSV
import — are never skipped, and an import stamps each row its own instant in
file order (audit 01 B5).

Slugs are namespaced by store (`ali3d-bracket-a1b2c3`), so two merchants can
both sell a "bracket" without one of them failing to save.

---

## 6. One cart, one seller

`worker/lib/cartSeller.ts`. This is the rule §14 and §15 are most specific
about.

A cart belongs to the customer — one cart infrastructure, no per-store cart.
But **a checkout settles with exactly one seller**: one order, one delivery
promise, one commission, one party responsible.

The scope is **derived from the lines**, not stored as a flag:

```ts
cartSellerScope(lines) // → null | { seller_type, merchant_id, store_id }
```

A flag drifts. Remove the last merchant line and a stored flag still says
"merchant", refusing the next Levonis add for a cart that is empty. A
derivation cannot get that wrong. An empty cart has **no** scope — it is not
"a Levonis cart with nothing in it" — so the first add from either side never
conflicts.

This mirrors `lib/shippingType.ts`, which solved the same shape of problem for
air/sea/land. One idiom, so a reader who understands one understands both.

### The database backs it up

```sql
CHECK (
  (seller_type = 'levonis'  AND product_id IS NOT NULL AND community_product_id IS NULL
     AND merchant_id IS NULL AND store_id IS NULL)
  OR
  (seller_type = 'merchant' AND community_product_id IS NOT NULL AND product_id IS NULL
     AND merchant_id IS NOT NULL AND store_id IS NOT NULL)
)
```

An endpoint written next year that skips `cartSeller` entirely still cannot
write a line that lies about who is selling.

**And one user's cart holds ONE seller** (migration 0114, wave 1). The two
add doors read the cart, decide, then insert — so two adds from two tabs
could both pass their read, and the store checkout then billed one store for
another's goods (audit 02 B8). `BEFORE INSERT` and `BEFORE UPDATE OF user_id,
seller_type, merchant_id` triggers on `cart_items` now
`RAISE(ABORT, 'CART_SELLER_CONFLICT')` when another row of the same user
names another seller; both doors map it to the same `400
CART_SELLER_CONFLICT` their own check answers. The store checkout refuses a
cart an older build left mixed (`409 CART_SELLER_CONFLICT`) and deletes only
the line ids it priced (B21).

### Line identity: two partial indexes, and why not one key

"The same line twice is one line with a bigger quantity" is enforced by two
**partial** unique indexes (migration 0032), not by one key over both product
columns:

```sql
CREATE UNIQUE INDEX idx_cart_levonis_line
  ON cart_items(user_id, product_id, option_id, color_id, shipping_method_id)
  WHERE product_id IS NOT NULL;

CREATE UNIQUE INDEX idx_cart_merchant_line
  ON cart_items(user_id, community_product_id, option_id, color_id)
  WHERE community_product_id IS NOT NULL;
```

> **NULLS ARE DISTINCT IN A SQLITE UNIQUE INDEX**, and forgetting it cost a
> production outage. 0030 widened 0001's key to
> `(user_id, product_id, community_product_id, option_id, color_id,
> shipping_method_id)`. That looks like a superset. It is not: a Levonis line
> has `community_product_id` NULL and a merchant line has `product_id` NULL,
> so every row was unique no matter what. The constraint stopped constraining,
> the `ON CONFLICT(...)` in `cart.ts` stopped naming any index that exists, and
> SQLite answers that with an error — so **adding anything to a cart returned
> 500 on the live site**.

A merchant line is keyed **without** `shipping_method_id`: merchant delivery is
settled at checkout with the one store, not chosen per line, so including it
would make two identical lines look different whenever the column moved.

0032 folds any duplicates the broken window allowed by **summing** their
quantities rather than deleting a row — the customer put those items in their
cart, and losing them silently is worse than a quantity they can see and edit.

`tests/cartUpsert.test.ts` issues the routes' actual SQL against the actual
migrated schema, which is the gap that let this through: every other cart test
in the repo works on parsed structures or stubs, so none of them could see it.
One case asserts the pre-0032 statement **still fails**, so the fix cannot be
quietly undone.

### The conflict

`400 CART_SELLER_CONFLICT`, with **both shops named** in `details` — "items
from another store" makes the customer guess which one is in the way. The
dialogue offers the owner's two answers (docs/MERCHANT_PLATFORM.md §2):
«العودة إلى السلة الحالية» (primary) or «إفراغ السلة والتحول للبائع الجديد»
(deliberately not the default).

Clearing is the **same add re-sent with `replaceCart: true`** — one request, so
a cart can never be left emptied with nothing added because a second call
failed. Nothing is ever cleared without that flag. The add is **validated
first** — an add that would be refused (sold out, store closed, an option the
product does not offer) clears nothing — and the delete and the insert run in
**one batch** (audit 02 B15).

---

## 7. Money

Prices are read from D1 at add and again at checkout. A client that posts a
price, a total or a delivery fee is **ignored** — those fields are not read
(§17).

### Store sales

```
customer pays → merchant credited PENDING → merchant marks delivered
  → customer confirms receipt, OR 3 days pass with no open complaint → AVAILABLE
```

The merchant's share — the goods after the coupon, less the commission, **plus
the merchant's own delivery fee** (audit 02 B4; the commission is on the goods
only) — is visible as "coming" without being spendable before the customer has
the goods (§77). **The merchant's own «تم التسليم» releases nothing** (owner
decision 2026-09-24): it stamps `delivered_at`, writes the stage and the
customer's tracker history, and starts the clock. The customer's «استلمت
طلبي» (`POST /api/orders/:id/confirm-receipt`) releases at once; otherwise the
scheduled sweep (`worker/lib/storeOrderOps.ts`, `releaseDueStoreCredits`)
releases three days after `delivered_at` — idempotent and audited — unless a
complaint or support ticket on the order is open, which freezes it. Returns
of a store order go through support (`STORE_ORDER_RETURN_VIA_SUPPORT`).

`delivered_at` is the **latest** move into delivered (review F5): a delivery an
admin walked back and the merchant marks again starts a fresh three days; a
Levonis order keeps its first date (its warranty and return window start
there). The sweep reads only rows it can release, so frozen rows never starve
it (review F3). **No credit is ever released on an order whose customer was
already refunded** (`wtx_refund_<order>_usd` exists — legacy rows the old
code refunded and then let an admin re-open, review F4); those, and paid
orders an old merchant-cancel never refunded, are listed read-only to the
owner or a financial admin under Community → Money → «مطابقة أموال طلبات
المتاجر» (`GET /api/admin/community/reconciliation/store-orders`) and put right
one order at a time by an audited decision — `…/:id/reverse-credit` or
`…/:id/refund` — never by a migration.

A checkout retried with the same key pays with its own reservation (review
F6), and two checkout tabs on one cart cannot both commit: the batch requires
every priced cart line to still be there (409 `CART_CHANGED`, review F7). An
admin cancel that refunds or claws back money needs the financial scope
(review S6). The storefront's `open` is the cart's own answer
(`storeTakesOrders`, review S1).

Cancelling — by the merchant, by the customer while the order is still
pending, or by an admin — is **one operation** (`cancelStoreOrder`): the
conditional status flip, the full wallet refund, stock and `sold_count`
restored, the coupon use released, and the credit **reversed** rather than
deleted (a pending credit becomes `reversed`; one already available gets a
negative `reversal` row), with a history row — once, however many taps race.
An admin cannot "reopen" a cancelled store order
(`409 STORE_ORDER_REOPEN_REFUSED`): its money has already gone back.

The quote and the order are **one agreement** (audit 02 B12): the quote
returns `quote_fingerprint`, and placing the order without the fingerprint of
what the database prices now is refused `409 QUOTE_CHANGED` with the fresh
quote. Stock and single-use coupon caps are fences inside the order's batch —
a unit or a code taken by a concurrent order aborts it (`409 OUT_OF_STOCK`,
`409 COUPON_EXHAUSTED`) rather than being a silent no-op. A store that is
paused, suspended, not selling products, or whose owner no longer holds the
store entitlement (PLUS, PREMIUM or PRO), or whose merchant is suspended or
restricted, takes no order and no cart add (`STORE_CLOSED`); nobody buys
from their own store (`OWN_STORE_PURCHASE`). The free-delivery threshold is
judged on the goods after the coupon; the coupon's own minimum on the goods at
the store's prices, before it (docs/DECISIONS.md).

**Delivery is the merchant's, by governorate** (W2-A, migration 0120,
docs/DECISIONS.md row 125). A profile per store — default fee / free / off,
a free-over threshold, pickup (a place and instructions, still prepaid),
preparation days, a note, a version — and a rule for each governorate that
departs from the default (fee, free or off, with its own threshold, preparation
days, delivery-time line and note). The fee is computed on the server from the
customer's SAVED address → governorate → these rows
(`resolveMerchantDelivery`, packages/shipping), at the quote and again at
place-order; the quote fingerprint binds the address, the governorate, the
rule, the fee and the profile version, and the order batch fences on the
version. The order keeps `delivery_governorate`, `delivery_rule`,
`delivery_prep_days`, `quote_fingerprint` and the whole applied rule in
`delivery_method_snapshot`; `delivery_method_id` is `merchant` or
`merchant_pickup`. A store that never saved the editor is priced from its
wave-1 `delivery_settings` as version 0.

Commission is snapshot per order (`commission_percent_x100`,
`platform_fee_iqd`, `merchant_receivable_iqd`). Changing the rate tomorrow
never rewrites what a merchant was owed for a sale that already happened
(§30, §75).

### The balance is a SUM — of an append-only ledger (wave 2, W2-B)

The merchant's money lives in `merchant_ledger_entries` (migration 0121,
worker/lib/merchantLedger.ts). A line is written once — triggers refuse any
UPDATE or DELETE — and there is **no balance column**: every figure is a SUM.
Money sits in four buckets, `pending → available → reserved → paid`; a move
between buckets is two lines that sum to zero. A store sale is three pending
lines: the goods, the platform's commission as its own line, and the
merchant's delivery fee as its own line. The customer's confirmation or the
three-day sweep releases them (`release`); a cancel writes refund lines
(in pending, or as a claw-back from available); a custom order's escrow
release credits `escrow_release` and its commission straight into available.
No new line may take a bucket below zero, except a customer refund after the
release (a debt the merchant's next sales settle; payouts are refused while it
lasts).

**Payouts are requests** (`merchant_payouts`): the merchant asks from the
finance page, and the same batch moves the amount available → reserved with an
INSERT that cannot exceed «available», however many requests race. A
financial admin approves, then marks it paid with the transfer's reference
(reserved → paid) — or fails it with a reason (reserved → available); the
merchant may cancel a request nobody approved yet. The wave-1 «record a
payout» sheet now records a payout request the admin makes and pays in one
batch. The old `merchant_payout_ledger` is read-only for the code; its rows
were carried over deterministically with every merchant's balance unchanged
(`GET /api/admin/community/ledger/parity` re-proves it).

---

## 8. Customer privacy

A merchant sees what fulfilment requires and nothing else (§51, §60).

| Shown | Never shown |
|---|---|
| Display name | Email, password, auth identity |
| Delivery address **on their own orders** | Wallet balance |
| Phone **on their own orders** | Purchases from other stores |
| Order count and lifetime value **with this store** | Admin metadata |

The customer list is built **from this merchant's orders**, so it can only
contain someone they have traded with. There is no user search.

---

## 9. API surface

### `/api/merchant/*` — the caller's own store
- **store:** `GET /me` (with `root_domain`) · `GET /slug-check` · `POST /onboard` ·
  `PATCH /store` · `POST /store/slug` · `GET /subscription` ·
  `GET /store/share` (the share kit: the absolute link, the card it unfurls as,
  the app icon's state — §11)
- **delivery by governorate** (W2-A, §7): `GET /delivery` →
  `{profile, rules[], configured, store_open, coverage}` · `PUT /delivery`
  (`{version, profile, rules[]}`, the whole configuration; `400 DELIVERY_INVALID
  {issues:[{path, code}]}`, `409 DELIVERY_VERSION_CONFLICT {config}`,
  `409 DELIVERY_NO_COVERAGE` for an open store that would deliver nowhere with no
  pickup — `PATCH /store {open: true}` refuses the same). `PATCH /store` still
  accepts wave 1's flat `delivery_settings` from a cached form: an unchanged echo
  moves nothing, a real edit reaches the profile's default
- **products** (worker/routes/merchantCatalog.ts, same prefix, W2-F):
  `GET /products?q=&state=&stock=in|low|out|untracked&collection=&variants=&sort=&cursor=`
  (opaque `next_cursor`, `total`; `?page=` still pages by offset; `400 CURSOR_INVALID`) ·
  `GET /products/:id` (with `media`, `option_groups`, `variants`) · `POST /products` ·
  `PATCH /products/:id` (`400 PRODUCT_INVALID {errors:[{path,code}]}`,
  `409 PRODUCT_HIDDEN_BY_ADMIN`, `409 PRODUCT_NOT_PUBLISHABLE`, `400 STOCK_REQUIRED`) ·
  `DELETE /products/:id` (archive when ordered) · `POST /products/:id/duplicate` (a draft) ·
  `POST /products/bulk {action, ids ≤100, price_iqd|stock|collection_id}` — answered per
  product (`NOT_FOUND`, `PRODUCT_HIDDEN_BY_ADMIN`, `PRODUCT_NOT_PUBLISHABLE`,
  `VARIANTS_HAVE_OWN_STOCK`, `PRODUCT_HAS_ORDERS`) · `GET /products/stats` ·
  `GET /products/:id/insights` (views from the analytics days, units/revenue from
  non-cancelled orders, per variant) · `GET /products/export.csv` ·
  `POST /products/import {csv, confirm}` (dry run first; per-row `{row, field, code}`; drafts)
- **collections:** `GET|POST /collections` · `PATCH|DELETE /collections/:id` (the same
  four under `/sections`) · `GET|PUT|POST /collections/:id/products` ·
  `DELETE /collections/:id/products/:productId` (`409 COLLECTION_COMPUTED`,
  `400 COLLECTION_KIND_EXISTS`, `COLLECTIONS_LIMIT`)
- **catalogue:** the same four for `/services`, `/showcase` and `/coupons`
- **orders:** `GET /orders` · `GET /orders/:id` · `POST /orders/:id/status` ·
  `GET /custom-orders/summary`
- **money and people:** `GET /analytics` (sales only — cancelled orders are
  counted apart, never as revenue) · `GET /customers` ·
  `GET /followers` · `GET /reviews` · `POST /reviews/:id/reply`
- **notifications:** `GET|PATCH /notifications` (`wired` names the switches a
  sender actually reads; the rest show «قريبًا». A switch governs the OUTSIDE
  channels — the in-app notice is always written; `complaints`,
  `subscription_expiry`, `system_alerts` are forced on) ·
  `GET /notifications/feed?cursor=&unread=1&kind=` · `GET /notifications/unread-count` ·
  `POST /notifications/read {id?}` — the store's notices only, each deep-linked
  to its object's workspace address (W2-E, worker/lib/merchantNotify.ts)
- **inbox** (worker/routes/merchantInbox.ts): `GET /inbox?cursor=&q=&kind=direct|order|request&unread=1`
  · `GET /inbox/unread-count` — the store's threads its owner is a member of,
  searched on the server
- **analytics over a range** (worker/routes/merchantAnalytics.ts):
  `GET /analytics/report?from=&to=` (Baghdad days, ≤366) — traffic from the
  beacon (absent before counting began), orders live from `orders`, funnel,
  top/least-viewed products, returning customers, coupons, governorates,
  requests/offers; `403 ANALYTICS_NOT_INCLUDED`, `400 BAD_RANGE`
- **printers** (worker/routes/merchantPrinters.ts, same prefix): `GET|POST /printers` ·
  `PUT|DELETE /printers/:id` · `GET|PUT /request-prefs` · `GET /request-matches`
- **finance** (worker/routes/merchantFinance.ts): `GET /finance/summary` ·
  `GET /finance/ledger?cursor=&kind=&from=&to=` · `GET /payouts` ·
  `POST /payouts` (`{amount_iqd, channel, account, holder, note, idempotencyKey}`;
  `400 INSUFFICIENT_BALANCE {available_iqd}`, `UNKNOWN_PAYOUT_METHOD`,
  `PAYOUT_ACCOUNT_REQUIRED`, `409 IDEMPOTENCY_KEY_REUSED`) ·
  `POST /payouts/:id/cancel` (`409 PAYOUT_NOT_CANCELLABLE`) — §7
- **store page layout** (worker/routes/storeLayout.ts, `/store/layout`): `GET /` ·
  `PUT /draft` (`{layout, version}`; `409 DRAFT_CHANGED`) · `POST /publish` ·
  `GET /revisions` · `GET /revisions/:revision` · `POST /restore/:revision`
  (`publish: true` to make it live) · `GET /preview` — §10
- **the workspace** (worker/routes/merchantWorkspace.ts, W3-A): `GET /attention` —
  every count the Command Center and the workspace badges show (orders waiting
  on the merchant by stage, custom orders to start / in progress, unread
  conversations, unread notices, open matching requests with no offer, low /
  sold-out published products, new and unanswered reviews, available and
  pending money, payouts in flight, coupons ending within 7 days, the store's
  problems: suspended / restricted / paused / PLUS lapsed / unpublished page
  draft), each with its workspace link; a source that cannot answer is ABSENT,
  never 0, and the requests count is absent while Levo Community is shut ·
  `GET /search?q=` (2–60 characters; `400 SEARCH_QUERY_TOO_SHORT` /
  `SEARCH_QUERY_TOO_LONG`) — orders by number, products by name / Arabic name /
  SKU, customers who bought here by name or phone (matched, never returned),
  5 of each. Both owner-scoped in SQL, rate-limited (120 / 60 per minute).

### `/api/storefront/*` — public
`GET /resolve` · `GET /:slug` · `GET /:slug/sections` · `GET /:slug/services` ·
`GET /:slug/showcase` · `GET /:slug/products` · `GET /:slug/products/:productSlug` ·
`GET /:slug/reviews` · `GET /by-id/:storeId` ·
`GET /:slug/delivery?governorate=` — fees and availability for one governorate
(without it, the signed-in visitor's default-address governorate) plus where the
store delivers; a preview, the checkout prices again (W2-A) ·
`POST /events` — the first-party analytics beacon (`store_view`, `product_view`,
`add_to_cart`, `checkout_started`; always `204`, `400 BAD_EVENT`,
`413 EVENT_TOO_LARGE`): once per visitor per day, never the owner or a crawler,
stored only as salted hashes (worker/lib/storefrontAnalytics.ts). A product GET
no longer counts a view (audit 01 B22).

Every `/:slug…` read serves the live slug, then a slug the store was renamed
away from, and never a sanctioned store (`404 STORE_UNAVAILABLE`, §4).

`/resolve`, `/:slug` and `/by-id` also carry the store's **published** layout
(`layout`, `layout_source`, `layout_revision`) and the rows its blocks show
(`blocks_data`); the product page's `store.layout_theme` carries the theme
alone. Never the draft (§10). Every store answer also carries `delivery` (the
governorates served with their fees, pickup, preparation days, the note) and
`delivery_to_you` — the signed-in visitor's own governorate, answered — or null.

### `/api/admin/community/*` — store moderation (apex only)
`GET /merchants` (with each store's `store_url`) ·
`POST /merchants/:id/status` (the merchant row only) ·
`POST /stores/:id/status` (the store row only) · `POST /merchants/:id/verify|badge` ·
`GET /merchants/:id/products` · `POST /products/:id/hide {hidden, reason}` ·
`GET /reconciliation/store-orders` (read-only) and
`POST /reconciliation/store-orders/:id/refund|reverse-credit {reason}` (review F4) ·
`GET /payouts` · `POST /payouts/:id/approve|paid {reference}|fail {reason}` ·
`POST /merchants/:id/adjustment {amount_iqd, reason, idempotencyKey}` · `GET /ledger/parity` (W2-B, §7) ·
money routes behind the financial scope — see COMMUNITY_V2.md §11

### `/api/community/*` — legacy merchant doors
`POST /my-store/products` → `307 /api/merchant/products` ·
`DELETE /my-store/products/:id` → `307 /api/merchant/products/:id` (§5)

### `/api/chats/*` — a store's threads
`POST /open {merchantId}` opens the STORE's thread with this customer (one per
pair, `context: 'store'`); `POST /open {requestId, merchantId?}` a custom
request's thread between its requester and a merchant with an offer on it
(`403 REQUEST_THREAD_NOT_ALLOWED` otherwise). Every store thread carries
`store_id`, its context and each member's role (migration 0124).
`POST /open {orderId}` adds the customer AND the seller; `GET /:id/messages`
pages newest-first (`limit`, `before` cursor, `has_more`, `older_cursor`); a
customer's message notifies the seller as the store's `new_message`, opening
the thread in the inbox (their `new_messages` switch governs the outside
channels). Staff read
a store thread — its messages and its files — read-only (`read_only: true`, an
`admin.chat_read` audit row) and never join it; sending, typing and uploading
into it are the customer's and the seller's only (`403 CHAT_READ_ONLY`, review
S3).

### `/api/store-orders/*` — merchant checkout
`POST /quote` `{addressId?, fulfilment: delivery|pickup, couponCode?}` (returns
`quote_fingerprint` and the `delivery` breakdown; without `addressId` it prices
the default address and names it) · `POST /` `{idempotencyKey, addressId,
fulfilment, quoteFingerprint, couponCode?}` (`409 QUOTE_CHANGED` carries the
fresh quote; the same key with a different fingerprint is
`409 IDEMPOTENCY_KEY_REUSED`). Both refuse `409 ADDRESS_REQUIRED`,
`409 ADDRESS_GOVERNORATE_REQUIRED` and `409 DELIVERY_UNAVAILABLE {reason, served,
pickup, preview}` — never a default fee for an address without a governorate —
and `404 ADDRESS_NOT_FOUND` for an address that is not the customer's

### `/api/orders/*` — added for store orders
`POST /:id/confirm-receipt` — the customer's «استلمت طلبي»

### `/api/cart/*` — added
`POST /merchant-items` · `GET /scope` · `GET /merchant`

---

## 10. Appearance limits

A merchant controls **content**: logo, banner, name, tagline, description,
policies, hours, social links, featured products.

They choose **presentation only from closed lists**, never write it. `accent`
is a preset *name* mapped to classes defined in
`src/components/storefront/theme.ts`, with an explicit fallback for anything
unrecognised. No merchant string reaches the stylesheet; there is no
`dangerouslySetInnerHTML`; and a test asserts no merchant value appears in an
inline style.

### The store page's layout (packages/storeLayout, migration 0122)

The page is a **layout**: a theme (seven presets — classic, minimal, modern,
premium dark, workshop, portfolio, product focused), tokens chosen from enums
(surface, radius, density, type, card, product card, picture ratio, spacing,
columns, width), a header and footer variant, and up to 40 **blocks** of 27
types, each with typed, bounded settings. Text is `{ar, en, ckb}`; a link is
an internal route, one of this store's products or collections, or an
`https://` address; a picture or a video is a storage key this owner uploaded
(checked against `file_objects`); a social link is a provider and a handle,
and the address is built from the provider's template.

- **One gate.** `normalizeLayout` (the same code in the Worker and the page)
  cleans what it can and names what it refuses: an unsafe link, somebody
  else's media, an unknown schema version or an oversize layout refuses the
  save (`400 LAYOUT_REJECTED` with the issues); anything else is cleaned and
  reported. The Worker then checks ids and media against this store's rows.
- **A draft is never public.** The storefront reads the revision
  `merchant_stores.published_revision_id` names, normalised again on the way
  out. A store that never published — and a database a migration behind —
  shows the classic page, generated from its settings on the fly; nothing was
  backfilled.
- **Publishing is one batch** fenced on the draft version: the revision, the
  pointer, pruning to the newest 50 and the audit row land together or not at
  all, and two tabs publishing the same draft make one revision. Restore
  copies a revision into the draft, or publishes it as a new revision.
- **The theme is presentation only.** Tokens reach the page as `data-sf-*`
  attributes whose values are enums, read by our own
  `src/components/storefront/theme.css`; every preset's accent is `store`,
  i.e. the colour picked in store settings. Changing the theme touches no
  product, review, collection or word.

Tests: `tests/storeLayoutSchema.test.ts`, `tests/storeLayoutRoutes.test.ts`,
`tests/storeLayoutMalicious.test.ts`, `tests/storefrontBlocks.test.ts`.

Social links are reduced to `http(s)` URLs **on the way in**, so a
`javascript:` href in a store profile — stored XSS against every visitor of
that shop — never reaches the renderer at all.

### Images: uploaded, not typed

`worker/lib/mediaRefs.ts`. The logo, the banner and every product picture must
address an object **this platform issued to this merchant** —
`community/<user id>/<id>.<ext>`, the key layout `worker/routes/uploads.ts`
produces. Ownership is legible from the key, so no second lookup is needed.

The stylesheet is not the only place a merchant string can reach a page. An
`<img src>` a merchant controls is a request the **visitor's** browser makes
to wherever the merchant chose:

| Accepted | Refused |
|---|---|
| `community/<own id>/ab12cd.jpg` | `https://anywhere.example/pixel.gif` |
| `/files/community/<own id>/ab12cd.jpg` | `//anywhere.example/pixel.gif` |
| | `data:` and `javascript:` |
| | `community/<another merchant>/x.jpg` |
| | `.svg` (SVG is script) |
| | anything with `..` or a second path segment |

A bad logo or banner is a **400** — a merchant who uploaded a logo and got no
logo deserves to be told why. A bad entry in a product gallery is **dropped
silently**, because a merchant fixing a mistyped price should not be blocked
by one stale reference. `tests/attachments.test.ts` attacks both.

The UI is one component (`src/components/media/ImagePicker.tsx`) used by all
three surfaces: pick, preview, replace, remove, and — for a gallery — promote
an image to cover, since the first image is what the storefront grid shows.
Type and size are checked in the browser as a courtesy; the server sniffs the
bytes and is the gate.

---

## 11. The store's own app and share card

Each store installs as **its own app** on its own host (docs/MERCHANT_PLATFORM.md
§2 decision 11, §4.5): the per-host manifest names the store, starts at `/` of
that host with scope `/`, `display: standalone`, on the document black
(worker/lib/webManifest.ts, worker/routes/manifest.ts).

- **Icons are the store's logo, cut to size.** When the logo changes
  (`PATCH /store`, after the response) — and, for stores that predate this,
  on the first manifest, `/store-icon/*` or share-kit request — the Worker cuts
  it through `env.IMAGES` into five PNGs: 192 and 512 (`any`), 512 `maskable`
  (the whole logo inside the safe zone, on the store's ground colour), the
  180 px Apple touch icon and a 32 px favicon (worker/lib/storeIcons.ts,
  table `merchant_store_icons`, migration 0123). Their keys carry a digest of
  the logo, so a new logo is a new URL and installed apps update. With valid
  renditions the manifest lists only the store's icons; the platform's appear
  only as a true fallback — no logo, a logo too small (under 96 px) or
  unreadable, renditions still being cut, no Images binding, or a suspended
  store. A logo that cannot be cut is recorded with a stable reason and not
  retried before its back-off.
- **iOS and the tab read `/store-icon/<name>`** (`apple-touch.png`,
  `favicon-32.png`, `192.png`, `512.png`, `maskable-512.png`): one shared
  `index.html` links these stable paths and the Worker answers each per host —
  the store's rendition, or the platform's PNG — revalidating every five
  minutes.
- **A store link unfurls as the store.** `/` on a store's host (and
  `/community/store/<ref>` on the main site) carries the store's card: its
  name, its tagline (else its description, else «متجر X على منصة Levonis»),
  its 512 px icon and its host; a product card on the store's host names the
  store as the site and borrows its line and icon where the product has none
  (worker/lib/socialPreview.ts). A suspended store has no card.
- **The owner's share kit** (`src/components/merchant/share/`): copy, the
  system share sheet where one exists, a printable QR code, the card preview
  and the app icon's state — in store settings, and for the owner behind the
  storefront's «…» menu.
