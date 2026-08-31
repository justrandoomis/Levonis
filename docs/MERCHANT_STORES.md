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

| Benefit | PLUS | PRO | PRIME |
|---|---|---|---|
| `merchantStore` | ✅ | ✅ | ❌ |
| `merchantProducts` | ✅ | ✅ | ❌ |
| `merchantOrders` | ✅ | ✅ | ❌ |
| `communityOffers` | ✅ | ✅ | ❌ |
| `merchantAnalytics` | ✅ | ✅ | ❌ |
| `merchantSubdomain` | ✅ | ✅ | ❌ |

**PRO inherits every PLUS merchant benefit** — a PRO member is a more
privileged merchant, not a lesser one.

**PRIME inherits none.** It was sold as a delivery and priority tier for
buyers; granting it selling rights would let someone open a shop on a plan that
was never sold as one.

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
and `merchantStore` currently granted.

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
store.status    : active | paused | suspended         (paused = merchant's own)
```

A merchant can pause and re-open their own shop. **A merchant can never lift an
admin suspension** — that state is not reachable from the settings endpoint at
all, and the UI shows the reason instead of a disabled control.

A suspended or paused store still **resolves**: its page renders and explains
itself, and its existing customers keep their orders and chats. It simply
cannot take new ones.

A visitor is told a shop is closed, never *why*. Whether the merchant paused
it, an admin suspended it, or their subscription lapsed is between them and
Levonis (§51).

---

## 5. Products

`community_products`, extended rather than replaced (0001 → 0030).

`status` stays the visibility switch it always was; `lifecycle` says why:
`draft | active | hidden | sold_out | archived`. They are kept in step by every
writer, so a reader that predates the lifecycle is never lied to.

**Editing is real.** The old dashboard could create and delete but not edit, so
fixing a mistyped price meant deleting the product and losing its history.

**Delete is archive when the product has ever been ordered.** Removing the row
would blank out what a customer actually bought. `DELETE` is only honoured for
a product nothing has ever touched, and the UI says which happened.

**Duplicating starts as a draft** — copying a live product straight to the
storefront publishes an unedited clone to real customers.

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
dialogue offers going back to the cart (primary) or clearing it (deliberately
not the default).

Clearing is the **same add re-sent with `replaceCart: true`** — one request, so
a cart can never be left emptied with nothing added because a second call
failed. Nothing is ever cleared without that flag.

---

## 7. Money

Prices are read from D1 at add and again at checkout. A client that posts a
price, a total or a delivery fee is **ignored** — those fields are not read
(§17).

### Store sales

```
customer pays → merchant credited PENDING → delivered → AVAILABLE
```

The merchant's share is visible as "coming" without being spendable before the
customer has the goods (§77). Cancelling **reverses** the row rather than
deleting it, so the ledger still explains itself.

Commission is snapshot per order (`commission_percent_x100`,
`platform_fee_iqd`, `merchant_receivable_iqd`). Changing the rate tomorrow
never rewrites what a merchant was owed for a sale that already happened
(§30, §75).

### The balance is a SUM

`merchant_payout_ledger` is append-only. There is **no balance column** for a
retry to double, and a merchant can add up the list in their dashboard and get
the same number the platform shows.

Paying a merchant writes a **negative** row (`kind = 'payout'`) rather than
reducing anything.

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
`GET /me` · `GET /slug-check` · `POST /onboard` · `PATCH /store` ·
`POST /store/slug` · products CRUD + duplicate · `GET /orders`,
`GET /orders/:id`, `POST /orders/:id/status` · `GET /analytics` ·
`GET /payouts` · `GET /reviews`, `POST /reviews/:id/reply` · `GET /followers` ·
`GET /customers` · `GET|PATCH /notifications` · `GET /subscription`

### `/api/storefront/*` — public
`GET /resolve` · `GET /:slug` · `GET /:slug/products` ·
`GET /:slug/products/:productSlug` · `GET /:slug/reviews` · `GET /by-id/:id`

### `/api/store-orders/*` — merchant checkout
`POST /quote` · `POST /`

### `/api/cart/*` — added
`POST /merchant-items` · `GET /scope` · `GET /merchant`

---

## 10. Appearance limits

A merchant controls **content**: logo, banner, name, tagline, description,
policies, hours, social links, featured products.

They control **no styling**. `accent` is a preset *name* mapped to classes
defined in `Storefront.tsx`, with an explicit fallback for anything
unrecognised. No merchant string reaches the stylesheet; there is no
`dangerouslySetInnerHTML`; and a test asserts no merchant value appears in an
inline style.

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
