# Audit 02: Cart, store checkout, merchant orders, coupons, delivery, commission and payouts

Repo: `/home/user/Levonis`, audited read-only (`git status` is clean after the audit). Date: 2026-09-24.

**How the findings were checked.**
- **Verified** means the finding was reproduced by running the real route modules against a database with every migration applied. This uses the repo's own harness (`tests/fixtures/app.ts`: `node:sqlite` with D1 batch semantics, real CHECK/UNIQUE constraints and real triggers). Races were simulated with the harness's `failingD1.beforeBatch` hook, which interleaves operations in one process. It does not reproduce D1's own storage concurrency.
- **Static** means the finding comes from reading the code only.

Reproduction suites live outside the repo. All 22 cases pass, which means every defect reproduces:
- `…/scratchpad/merchant-audit/02-commerce-verify.test.ts` (V1–V18)
- `…/scratchpad/merchant-audit/02-commerce-verify-admin.test.ts` (A1–A2)
- `…/scratchpad/merchant-audit/02-commerce-verify-selfreview.test.ts` (Z1)

To run one: `cd /home/user/Levonis && node --import tsx --test <file>`.

**Existing tests I ran.** All pass:

| Test file | Passed |
|---|---|
| cartSeller | 11/11 |
| merchantCartSeparation | 9/9 |
| store-isolation | 6/6 |
| storefrontIsolation | 15/15 |
| merchantOrderStatus | 4/4 |
| merchantOps | 16/16 |
| couponResolver | 16/16 |
| walletHoldSettlement | 10/10 |
| cartUpsert | 18/18 |
| governorates | 7/7 |
| communitySchema | 10/10 |
| adminCommunity | 17/17 |

None of these tests covers the defects in section 9. `couponResolver` tests the platform coupon engine (`@levonis/pricing/coupons`), not merchant coupons.

**Prior art.** `docs/architecture/00-ASSESSMENT.md` already flagged several of these problems:
- :425 HIGH, "merchant cancel never refunds the customer"
- :338, commission returned to the buyer
- :440, hold leak
- :441, self-attested delivery and concurrent payouts, labelled a "GUESS"

`docs/architecture/01-TARGET.md:377` plans the payout fix. **All of them are still live.** This audit confirms them with executable repros. It also shows the payout defect is deterministic, not just a race (B3).

---

## 1. Data model

### 1.1 Seller identity

**`community_merchants`**
- Created in `migrations/0001_init.sql:247-255`: `id`; `user_id UNIQUE → users`; `name`; `verified`.
- Extended in `0030_community_v2_core.sql:43-57`:
  - `status` ∈ active | restricted | suspended (free text, no CHECK)
  - `governorate` (free text)
  - `badge`, `badge_override`, `reputation_score`, `rating_avg_x100`, `rating_count`, `completed_orders`

**`merchant_stores`** (`0030:66-104`)
- `merchant_id NOT NULL UNIQUE`, so **one store per merchant**. `cartSeller.sameSeller` compares only `merchant_id` (`worker/lib/cartSeller.ts:61-65`) and relies on this.
- `user_id` (owner, denormalised), `slug UNIQUE`.
- `governorate TEXT` (free text, :84). `service_areas TEXT '[]'` (free-text list, :85). `delivery_settings TEXT '{}'` (:90).
- `status CHECK IN ('active','paused','suspended')` (:94-95).
- `sells_direct_products` (:93).
- `0037` adds `profile_links` and `profile_facts`.

**Merchant catalogue: `community_products`**
- Base: `0001:257-269`, with `price_iqd CHECK >= 0` and `status CHECK IN ('active','hidden')`.
- Extended in `0030:163-186`: `store_id`, `sku`, `stock INTEGER NOT NULL DEFAULT 0` (**no CHECK ≥ 0**), `track_stock`, `options` / `colors` (free JSON), `delivery_methods` (unused by checkout), `prep_days`, `sold_count`, `lifecycle` (free text: draft/active/hidden/sold_out/archived).
- `0036:32-35` adds `section_id` and `featured`.

### 1.2 Cart

**`cart_items`** (rebuilt in `0030:198-235`)
- `seller_type CHECK IN ('levonis','merchant')`, `merchant_id`, `store_id`, `product_id`, `community_product_id`, `option_id`, `color_id`, `qty CHECK 1..99`.
- A row-shape CHECK (:215-221) enforces exactly one product source matching the seller type.
- **No constraint or trigger enforces one seller per cart.** The comment at :194-197 says the route layer does it. `tests/cartSeller.test.ts:152-168` pins that mixed rows are allowed, but only across two different users.
- Line identity:
  - `0032_cart_line_identity.sql:102-104`: partial `UNIQUE idx_cart_merchant_line(user_id, community_product_id, option_id, color_id) WHERE community_product_id IS NOT NULL`.
  - The Levonis index is `idx_cart_levonis_line`, rebuilt in `0082` and `0083:89-98`.

### 1.3 Orders (shared with the platform)

**`orders`**
- Base: `0001:139-162`. `status CHECK IN ('pending','confirmed','processing','shipped','delivered','cancelled')`. Money columns have `CHECK >= 0`. `idempotency_key UNIQUE` (global).
- Merchant columns (`0030:240-254`): `seller_type`, `merchant_id`, `store_id`, `origin` (platform | store_product | community_request; the last is never written to `orders`), `community_order_id`, and the commission snapshot `commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`. Indexes `idx_orders_merchant` and `idx_orders_store_status`.
- **Unlike `community_orders`, there is no CHECK that fee + receivable = base.**
- `coupon_code` and `coupon_discount_iqd` (`0036:110-111`).
- `client_idempotency_key` with `UNIQUE(user_id, client_idempotency_key)` (`0064:52-55`).
- `stage`, `stage_changed_at`, `next_stage*` (`0028:24-28`). `shipping_type DEFAULT 'direct'` (`0027:14`). `delivered_at` (`0002:96`).
- `cancelled_at`, maintained by triggers (`0081:6-37`).
- **Store orders use none of these per-governorate delivery fields; nothing exists for them.**

**`order_items`**
- Base `0001:164-176`.
- `community_product_id` and `seller_type` (`0030:256-257`); `option_id` and `color_id` (`0008`); `coupon_discount_iqd` (`0077:132`, never written for store orders); cost columns (`0095`).

**`order_status_history`** (`0028:60-73`)
- Append-only timeline with `source CHECK IN ('manual','automatic','delivery_api','system')`.
- The merchant status route never writes it.

### 1.4 Coupons

**`merchant_coupons`** (`0036:88-106`)
- `store_id`, `merchant_id`, `code`, `kind CHECK IN ('fixed_iqd','percent')`, `value CHECK > 0`, `min_total_iqd`, `max_uses CHECK NULL or > 0`, `used_count CHECK >= 0`, `active`, `starts_at`, `ends_at`, `UNIQUE(store_id, code)`.
- **There is no redemption table, no per-user limit, no targeting, and no trigger.** Compare the platform coupons: `coupon_redemptions` with state plus `trg_coupon_redemption_limits` (`0077:151-172`), which raises COUPON_PER_USER_LIMIT, COUPON_GLOBAL_LIMIT and COUPON_NOT_YOURS inside the transaction.

### 1.5 Money

**`merchant_payout_ledger`** (`0031:187-204`)
- `kind CHECK IN ('sale_credit','community_order_credit','refund_debit','commission','manual_adjustment','payout','reversal')`.
- `amount_iqd` is signed. `state CHECK IN ('pending','available','reserved','paid','reversed')`.
- Also `order_id` (no FK), `community_order_id`, `escrow_id`, `admin_id`, `idempotency_key UNIQUE` (global).
- Index `idx_merchant_payout_ledger_order` (`0056:77`).
- Kinds `refund_debit`, `manual_adjustment` and `reversal` are **never written**. State `reserved` is **never used**. The table is not truly append-only: `state` is updated in place (`merchant.ts:1358`, `:1402`).

**Escrow tables (request/offer path; referenced for payouts only)**
- `community_orders` (`0031:93-127`, with CHECK fee + receivable = price).
- `community_escrows` (`0031:144-166`, with CHECK fee + receivable = gross and released + refunded ≤ gross).
- `community_escrow_events` (`0031:170-182`, append-only, `idempotency_key UNIQUE`).

**`merchant_store_analytics_daily`** (`0030:262-278`): never written (dead).

**Commission settings** (`admin_settings`, seeded at `0030:284-290`):
- `communityFeeStorePercentX100` = 500 (5%)
- `communityFeeRequestPercentX100` = 500
- `communityFeeMinIqd` = 0
- `communityAutoCompleteDays` = 7

These are read by `worker/lib/merchantOps.ts:125-182`. `splitFee` works in integer IQD, floors the fee, caps the minimum fee at gross, and guarantees fee + receivable = gross.

**Wallet primitives used by store checkout** (`worker/lib/walletOps.ts`):
- `createPurchaseHold` → `createHold` (:865). The conditional insert `WHERE available >= amount AND NOT EXISTS same (user, kind, event_key)` is at :817-841.
- `classifyHoldFailure` (:845-862) returns `EVENT_KEY_REUSED` when the same key arrives with a different amount (:856).
- `commitHoldStatements` (:1062-1126) posts the debit `wtx_hold_<id>`. The amount becomes -1 (a CHECK abort) unless the hold is active, unlinked, a purchase hold and still funded.
- `walletIqdAvailable` and `walletSpendCents` handle the dinar/cent conversion.

### 1.6 Governorates

- Closed list of 18 ids in `packages/shipping/src/iraqGovernorates.ts:22-41`.
- `normalizeGovernorate` (:46-58) accepts an id, or a name in ar/en/ckb, and returns `''` for anything else.
- Re-exported by `worker/lib/iraqGovernorates.ts:1`. The client mirror is `src/lib/governorates.ts:16-35`, kept in parity by `tests/governorates.test.ts`.
- `addresses.governorate` is `TEXT NOT NULL DEFAULT ''` (`0026_order_fulfilment.sql:23`). New and edited addresses must carry a valid id (`worker/routes/addresses.ts:42-45`, `GOVERNORATE_REQUIRED`). **Legacy rows can still hold `''` or free text.**
- `merchant_stores.governorate` and `community_merchants.governorate` accept any string up to 60 characters (`merchant.ts:204`, `:274-275`). The dashboard UI sends an id, but the server does not validate it.
- The platform itself has no per-governorate pricing. `worker/lib/settings.ts:115` `governorates[]` exists only for PRO priority delivery.

---

## 2. Seller isolation, end to end

### 2.1 Server enforcement points

1. **Deriving the scope.** `cartSellerScope(lines)` (`worker/lib/cartSeller.ts:48-58`) uses **only the first line**. An empty cart has no scope. `sameSeller` compares `seller_type`, then `merchant_id` (:61-65).

2. **The platform add door.** `enforceCartScope` (`worker/routes/cart.ts:1131-1175`), called from both the product and bundle adds (e.g. :1681):
   - Reads every line of the user (:1137-1140).
   - A conflict with a merchant cart → `400 CART_SELLER_CONFLICT` with both shops named (:1147-1159).
   - With `replaceCart` it runs `DELETE FROM cart_items WHERE user_id=?` (:1160-1162).
   - Then the platform insert runs as a **separate statement** (:1722-1738). `seller_type` falls back to its default `'levonis'`.

3. **The merchant add door.** `POST /api/cart/merchant-items` (`cart.ts:2158-2215`):
   - `loadBuyableMerchantProduct` (:2136-2156) checks `lifecycle = 'active'`, `status = 'active'`, store `active`, merchant not `suspended`.
   - Seller conflict check (:2175-2189), with the `replaceCart` delete (:2190-2194).
   - Stock check (:2197-2201).
   - Upsert on `idx_cart_merchant_line` (:2204-2211).
   - **The check and the insert are not atomic, and no DB guard exists**, so two concurrent adds from different sellers can both succeed.

4. **Merchant cart mutations** (PATCH :2318-2340, DELETE :2342-2348) are fenced by `user_id` and `seller_type = 'merchant'`.

5. **At checkout** (`worker/routes/storeOrders.ts:173-193`):
   - Selects **all** merchant lines of the user.
   - Checks store and merchant status **on the first row only**.
   - **Never asserts that every line has the same `merchant_id`/`store_id`.** Delivery settings (:227) and the coupon (:233) come from `first.store_id`, and the order is written with the first line's merchant and store (:465).
   - Then it runs `DELETE FROM cart_items WHERE user_id = ?`, which removes **all** lines, including any Levonis line (:519).

6. **Platform checkout.** `orders.ts` prices from `cartLineSql`, which is `JOIN products` (`cart.ts:684-687`), so merchant lines are never priced there (documented at `orders.ts:2919`).

7. **After the order: merchant side.** Every merchant query uses `requireStoreOwner` (`worker/lib/merchantAuth.ts:164-174`, which resolves the store by session `user_id`) plus `WHERE o.merchant_id = ?` (`merchant.ts:1224`, `:1256`, `:1339`) or `store_id = ?` (coupons, `:1958`, `:2025`). No store id is ever taken from the client. Pinned by `merchantCartSeparation.test.ts` ("lands in the selling merchant's own list and in nobody else's").

### 2.2 What the client does

- `src/pages/Cart.tsx:585-589` sets `merchantScope` from `GET /api/cart`'s `scope`. If the scope is merchant, it renders `MerchantCartView` (:1258-1261).
- **But `GET /api/cart` computes `scope` from `loadCart` items (`cart.ts:1112`), which come from `JOIN products` and therefore exclude merchant lines.** A merchant-only cart returns `items: []` and `scope: null` (**verified, V1**).
  - As a result the merchant cart view, and with it the only link to `/store-checkout` (`MerchantCartView.tsx:172`), is never shown.
  - `noteCartResponse` (`src/lib/cartCount.ts:82-87`) then resets the cart badge to 0.
  - `GET /api/cart/scope` (`cart.ts:2289-2305`) is correct, but only `storeCheckoutApi.scope` references it, and nothing calls that.
- `StorefrontProduct.tsx:71-99` posts to `/api/cart/merchant-items`. On `CART_SELLER_CONFLICT` it opens `SellerConflictDialog` (`src/components/merchant/SellerConflictDialog.tsx`), which offers "go to my cart" (primary) or "clear and shop here" (re-sends the add with `replaceCart: true`).
- `ReorderButton.tsx:190` handles the same code.
- The client never decides the seller. `storefrontIsolation.test.ts` ("the frontend never decides who may sell") pins this.

---

## 3. Store checkout flow, step by step

Route: `POST /api/store-orders/quote` then `POST /api/store-orders` (`worker/routes/storeOrders.ts`, mounted at `worker/index.ts:365`, auth required at :54).

### 3.1 Quote (:252-314)

- The body is read for **`couponCode` only**. `addressId` is not read, so the quote has no idea where the goods are going.
- It calls `priceMerchantCart` (:171-249), then `feeFor('store', subtotal - discount)` (:257).
- It reads the wallet in dinars (`walletIqdAvailable`, :276-281) and returns `wallet_covers` and `wallet_shortfall_iqd`.
- **It also returns the commission split to the customer** (`commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`, :309-311).
- There is no rate limit. Nothing is persisted, and no token or fingerprint is issued.

### 3.2 Pricing authority (`priceMerchantCart`, :171-249)

Every number is read from D1. The client sends only ids, a quantity, a coupon code and an address id (`cart.ts:2130-2133`; `storeOrders.ts:164-170`).
- Unit price is `community_products.price_iqd` (:208). Options and colours have **no price effect**, and their ids are **not validated** against the product (`cart.ts:2163-2164`; V15).
- Subtotal is Σ unit × qty.

### 3.3 Stock revalidation

- At checkout it re-checks `lifecycle` / `status` / `track_stock && stock < qty` **per line** (:197-207).
- At commit, it runs `UPDATE community_products SET stock = stock - ?, sold_count = sold_count + ? WHERE id = ? AND (track_stock = 0 OR stock >= ?)` (:497-503).
- **That UPDATE is a no-op, not an abort, when it matches zero rows.** The batch commits anyway. The comment at :494-496 claims the WHERE clause prevents overselling. In fact it only prevents negative stock, while the order still ships units that were never there (**V2, V3**).
- Quantities are not summed across two lines of the same product (different option or colour) (**V2**).

### 3.4 Coupon application (`resolveCoupon`, :137-162)

- Only when a code is typed. The code is uppercased, then looked up with `WHERE store_id = <cart's first store> AND code = ?`.
- Checks: `active`, `starts_at`, `ends_at`, `max_uses` against `used_count`, `min_total_iqd` against the **pre-discount subtotal**.
- Discount: `percent` = floor(subtotal × value / 100), where value ≤ 90 is enforced at creation (`merchant.ts:1970`). `fixed` = min(value, subtotal).
- The discount applies to merchandise only, never to delivery.
- Redemption is an **unguarded** `UPDATE merchant_coupons SET used_count = used_count + 1 WHERE … used_count < max_uses` in the batch (:472-479). **If it matches zero rows, the order still commits with the discount** (**V4**).
- There is no per-customer limit, no redemption row, and no release on cancellation (**V6**).

### 3.5 Delivery fee: how it is decided today (:225-231)

```ts
const settings = safeParse(first.delivery_settings, {});                 // merchant_stores.delivery_settings JSON
let delivery = Number.isFinite(fee) && fee > 0 ? Math.floor(fee) : 0;   // settings.fee_iqd, flat
if (freeOver > 0 && subtotal >= freeOver) delivery = 0;                 // settings.free_over_iqd, PRE-discount subtotal
```

- **Source.** `merchant_stores.delivery_settings`, written only by `PATCH /api/merchant/store`. The body is reduced by `sanitizeDelivery` (`merchant.ts:433-443`) to:
  - `fee_iqd` in 0..1,000,000
  - `free_over_iqd` greater than 0, up to 1e9
  - `note` up to 200 characters
- **The UI** is `src/components/merchant/dashboard/StoreSettingsTab.tsx:77-79` and `:130-134`. Leaving the fee field empty means the key is omitted, which means free delivery.
- **Client input.** Nothing the client sends is trusted or even read. There is also **no address, governorate, service area, pickup option, preparation time or per-product `delivery_methods` input anywhere in the computation.**
  - `service_areas` is a free-text list that is never enforced.
  - The customer's address governorate is snapshotted into `address_snapshot` (:457) and printed in the admin announcement (:601), but it never affects price or availability.
- **Snapshot.** The fee is written to `orders.shipping_iqd` (:461). `delivery_method_id = 'merchant'`, and `delivery_method_snapshot = {"by":"merchant","store":name}` (:457). No rule or governorate is recorded.
- **Where the fee money goes.** It is included in `total_iqd` and debited from the customer. It is **excluded from the merchant's credit** (`merchant_receivable_iqd` = goods after discount − commission, :368 and :508-518). It is also **excluded from platform revenue**, because `financeReport.ts:156-163` recognises `seller_type = 'levonis'` only (**V10**). The fee is an unaccounted liability that sits in nobody's books.

### 3.6 Idempotency (:327-339, :421-430, :546-563)

- `idempotencyKey` is required, 8–80 characters. The client mints `sc-<uuid>` once per page visit (`StoreCheckout.tsx:85`).
- Replay: `SELECT id FROM orders WHERE user_id = ? AND (client_idempotency_key = ? OR idempotency_key = ?)`, which returns the original order (per-user unique since `0064`).
- The wallet hold's event key is `store-order:<user>:<key>`, minted by the server. The ledger key is `sale:<orderId>`, also server-minted, so the globally unique column cannot be abused across users.
- A UNIQUE error on either orders key → replay, or `409 IDEMPOTENCY_KEY_REUSED`.
- **Hold lifecycle.** The hold is taken *before* the batch and deliberately survives a failed batch so that a same-key retry can reuse it (pinned by `walletHoldSettlement.test.ts`). But:
  - If the retry's total differs (cart, coupon or fee changed), `createHold` returns `EVENT_KEY_REUSED`, which surfaces as a generic `400 WALLET_ERROR` (:437).
  - A page reload mints a new key.
  - Either way **the old hold stays `active` forever**. Nothing releases stale purchase holds (**V13**).

### 3.7 Order creation atomicity (:444-547)

One `DB.batch` contains:
- the `orders` INSERT (`status = 'pending'`, `stage = 'received'`, `seller_type = 'merchant'`, `origin = 'store_product'`, commission snapshot, coupon snapshot)
- the coupon increment
- per line, an `order_items` INSERT (with `option_snapshot` = raw ids joined by " / ") and the stock UPDATE
- the ledger `sale_credit` at state `pending`
- the cart DELETE
- `commitHoldStatements` (debit plus hold flip, which aborts the whole batch unless funded)
- optionally the `PaymentCompleted` outbox row

This is all-or-nothing **for SQL errors**. The stock and coupon "guards" are not errors (see 3.3 and 3.4). After the batch come the audit row (:565) and the admin Telegram topic announcement (:592-620). **The merchant is not notified**: `merchant_notification_preferences.new_orders` is stored (`0030:142-154`) but never read. The response is `SELECT * FROM orders` (:622-623, and also on replay at :337 and :557), so it includes `platform_fee_iqd`, `merchant_receivable_iqd`, `commission_percent_x100` and `admin_note`.

### 3.8 Payment methods

**Wallet only.** `payWithWallet: false` → `400 STORE_PREPAID_ONLY` (:361-366). `payment_method_id = 'wallet'`, `due_on_delivery_iqd = 0` (:458-462). There is no cash on delivery and no pickup (header :27-33; pinned by `merchantCartSeparation.test.ts`).

The affordability check is in dinars against `walletIqdAvailable` (:390-402). The charge is `Math.max(1, walletSpendCents(...))` cents (:417).

The debit is posted **without** the dinar pair from 0108 (:529-533). The platform checkout (`usdSpendStatement`) and escrow (`settlementDinars`, `escrowOps.ts:114-123`) do record it. The effect is display-only: up to 13 IQD of deposit remainder per deposit stays shown as balance and is not spendable.

### 3.9 Commission

`feeFor(db, 'store', subtotal − discount)` (:368), which uses the current store rate from settings and snapshots it onto the order (:466). The base is goods after the merchant's coupon. **Delivery is not part of the base, and it is not paid to the merchant either.**

### 3.10 Ledger and payout entries

There is exactly one row per order: `merchant_payout_ledger(kind='sale_credit', amount=merchant_receivable_iqd, state='pending', order_id, idempotency_key='sale:<orderId>')` (:508-518). No commission row is written for store sales, unlike escrow (`escrowOps.ts:404-415`), so gross and commission cannot be derived from the ledger. Later changes are **in-place state flips**:
- `pending` → `available` on merchant "delivered" (`merchant.ts:1355-1361`)
- `pending` → `reversed` on merchant cancel (:1397-1406)

---

## 4. Merchant order lifecycle

**States and transitions.** Store orders use `orders.status` only. `MERCHANT_ORDER_FLOW` (`worker/routes/merchant.ts:1313-1321`):
- pending → confirmed | cancelled
- confirmed → processing | cancelled
- processing → shipped | cancelled
- shipped → delivered
- delivered and cancelled are terminal

The client mirrors this map (`src/components/merchant/dashboard/SalesTabs.tsx:29-36`).

**Who can move a store order.** Four different doors, none of them aware of the others' side effects:

| Door | Route | Transitions | Side effects |
|---|---|---|---|
| Merchant | `POST /api/merchant/orders/:id/status` (`merchant.ts:1331-1436`); `requireStoreOwner`, so it still works with PLUS lapsed or the store suspended; rate-limited to 120/h | Per the flow above; conditional flip `WHERE status = <read>` (:1349-1353); a lost race → 409 (:1412-1414) | **delivered:** ledger pending→available; `completed_orders + 1` and one `order_completed` reputation row, both fenced once (:1379-1394). **cancelled:** ledger →reversed (:1397-1406). **Every transition:** `notifyOrderStatus` to the buyer (:1426-1434); audit row. **NOT done:** wallet refund on cancel (V5); stock and `sold_count` restore; coupon release; `stage` / `order_status_history` / `delivered_at` (V8) |
| Customer | `POST /api/orders/:id/cancel` (`orders.ts:5048-5113`) | pending → cancelled only | Refunds the wallet (`cancelledOrderRefundStatements`, `orderCancelOps.ts:49+`); `planOrderReturn` targets `inventory_ledger`, which store orders never wrote. **Ledger stays `pending`; community stock and coupon are not restored** (V6) |
| Platform admin | `PATCH /api/admin/orders/:id` (`admin.ts:3184+`) with `ORDER_TRANSITIONS` (`admin.ts:2392-2401`): any forward move, backward moves, and **reopen from cancelled** | No `seller_type` guard. The admin list badges merchant orders (`admin.ts:2072`) | cancel → wallet refund, ledger stays pending (A1). delivered → `delivered_at` and platform delivered effects, **ledger stays pending forever** (A2). Reopening a customer-cancelled store order does **not** re-charge the customer. If the merchant then delivers, pending→available and the merchant is paid for goods the customer was refunded for (static chain from V6 + A2 + the merchant flow) |
| Expiry sweep | `orderExpirySweep.ts:83-101` | Excludes merchant orders (:86-87) | None, correctly |

**Timeline data available.**
- `orders.created_at`; `updated_at`; `cancelled_at` (trigger, `0081`).
- `stage_changed_at` (creation only).
- The `audit` table (`merchant.order_status` with from/to), which is not exposed to anyone.
- `user_notifications` / outbox rows keyed `order.status.<status>:<id>`.

**Missing.** `delivered_at`, `order_status_history`, shipped time, tracking number, carrier, cancellation reason, and who cancelled. `GET /api/orders/:id/tracking` (`orders.ts:5013-5046`) is stage-based, so a delivered store order shows **"received"** forever (V8). The return flow requires `delivered_at` (`returns.ts:339`, `:967`), so **store orders can never be returned**.

**Reviews.** Eligible when the order is `delivered` and owned by the reviewer (`merchantReviews.ts:127-136`). There is no check that the reviewer is not the merchant, so self-dealing is possible (Z1).

**Merchant screens.**
- `OrdersTab` (`SalesTabs.tsx:69-171`) ignores `next_cursor`, so only the first 30 orders are visible. Cancel uses `window.confirm` and says nothing about refunds.
- `OrderDetail` (:174-282) shows Items, Delivery, Total, Platform fee and "Your share". Its arithmetic visibly fails to add up whenever there is a delivery fee: 19,000 − 700 ≠ 13,300.
- `payment_method` falls back to "Cash on delivery" (:272), which is legacy.

---

## 5. Coupons for merchant stores

**Model.** `merchant_coupons` (§1.4). Code format is `^[A-Z0-9][A-Z0-9-]{2,29}$` (`merchant.ts:1934-1940`). Kind is `percent` (1–90) or `fixed_iqd` (1–1e8) (:1969-1970). Also `min_total_iqd`, optional `max_uses`, `starts_at` and `ends_at` (ISO-normalised, :1942-1953). Code, kind and value are immutable after creation (:2019-2020).

**CRUD.**
- `GET /coupons` requires `requireStoreOwner` (:1955-1961).
- `POST` requires `requireSellingPrivileges` and is rate-limited to 30/h (:1963-1994).
- `PATCH` requires selling privileges only to activate; pausing is always allowed (:1996-2029).
- `DELETE` hard-deletes an unused coupon and deactivates a used one (:2031-2048).
- UI: `SalesTabs.tsx:440-585`.

**Validation.** Only in the store checkout (`storeOrders.ts:137-162`), against `store_id = <cart's first store>`.

**Isolation.**
- From other merchants: the store scope is in every coupon query (`merchant.ts:1958`, `:2025`, `:2035`; `storeOrders.ts:146`), so a code from store B cannot be used in store A and a merchant cannot read or edit another store's codes. The only weakness is V9: a mixed cart applies store A's coupon to B's goods too.
- From official Levonis: platform coupons (`coupons` / `coupon_redemptions`, the resolver in `packages/pricing`) are never consulted in store checkout, and `merchant_coupons` is only referenced by `storeOrders.ts` and `merchant.ts` (grep). **The two are isolated.**

**Gaps.**
- No redemption rows, so it is impossible to see who used a code or on which order (except `orders.coupon_code`).
- No per-user limit, first-order-only option, product or section targeting, or stacking rules.
- The cap race (V4). No release on cancel (V6).
- `min_total` and `free_over` both use the pre-discount subtotal (V18, a policy choice that should be made explicit).
- `order_items.coupon_discount_iqd` is not allocated, so partial refunds have no per-line basis.

---

## 6. Merchant finance

**What exists.** A single table, `merchant_payout_ledger`, with in-place state flips plus a SUM (`merchantBalance`, `escrowOps.ts:646-663`), which returns `available_iqd` / `pending_iqd` / `paid_iqd` grouped by `state`.

**Writers.**
- Store sale: `sale_credit` at pending (`storeOrders.ts:508-518`).
- Merchant delivered: pending → available (`merchant.ts:1355-1361`).
- Merchant cancel: pending → reversed (:1397-1406).
- Escrow release: `community_order_credit` at available, plus `commission` (negative) at state **`paid`** (`escrowOps.ts:392-415`). Both are guarded by `FUNDED_BY_HOLD` (:312-315).
- Escrow partial refund: `community_order_credit` at available (:580-591).
- Admin payout: `payout` (negative) at state **`paid`** (`adminCommunity.ts:1073-1099`).

**Readers.**
- `GET /api/merchant/payouts`: balance plus the last 100 rows (`merchant.ts:1440-1452`), shown by `MoneyTab` (`src/pages/MerchantDashboardPage.tsx:483-527`).
- `GET /api/merchant/analytics`: gross, fees and receivable **computed from `orders`, not the ledger, and including cancelled orders** (`merchant.ts:1546-1554`). `/customers` lifetime totals (`merchant.ts:1513-1526`) also include cancelled orders.
- Admin: `GET /api/admin/community/merchants/:id/finance` (`adminCommunity.ts:1054-1064`).

**Pending → available.** Store sales become available **on the merchant's own "delivered" tap** (a self-attested fact, with no customer confirmation, return window or dispute freeze; V8). Community orders become available only through the escrow release: customer confirmation, auto-complete, or an admin decision.

**Payouts.**
- **Admin-only and manual.** The UI is `src/components/adminCommunity/AdminCommunity.tsx:370-392`: `window.prompt` for amount and note, with a fresh idempotency key minted per click (:385).
- There is no merchant payout request, payout method or destination, status workflow (requested/approved/paid/failed), or transfer reference field (only a free-text note).
- **"Available" is `SUM(state='available')`, and payout rows are written with state `paid`, so available never decreases after a payout** (V3/V7). Reported "paid" is `SUM(state='paid')`, which also includes escrow commission rows, so the merchant's "Paid out" tile (`MerchantDashboardPage.tsx:497`, `Math.abs(paid_iqd)`) overstates payouts by the commission.
- The ledger list shows no `state`, so reversed and pending credits look like income.

**Coverage against the target figures:**
- gross: from orders (includes cancelled)
- commission: from orders; the ledger only has it for escrow
- receivable: from orders
- pending, available, paid: ledger, all three incorrect for the reasons above
- refunds: **none**; `refund_debit` is never written
- escrow amounts: not in the merchant finance view
- payout history: `payout` rows mixed with commission rows

---

## 7. Strengths to keep

1. **Server-authoritative money.** The client sends only ids, qty, coupon code, address id and idempotency key. Prices, fees, discount, commission and wallet coverage are all read from D1 (`storeOrders.ts:164-170`; `cart.ts:2130-2133`). Commission is snapshotted per order (`0030:246-251`).
2. **Integer-IQD commission maths.** `splitFee` (`merchantOps.ts:163-175`): floored fee, min fee capped at gross, fee + receivable = gross. Rates come from admin settings with safe fallbacks (:125-142). Tests: `merchantOps.test.ts`.
3. **One-seller scope derived from lines, not a flag.** Enforced on both add doors, named conflicts with a single-request `replaceCart`, a row-shape CHECK in the DB (`0030:215-221`) and partial unique line indexes (`0032:98-104`). **Keep the concept.** Harden it with a DB trigger (§10).
4. **A separate store checkout with the prepaid-only rule.** `STORE_PREPAID_ONLY`, fixed delivery method, wallet only (`storeOrders.ts:347-366`). Pinned by tests.
5. **Idempotency design.** Per-user client key (`0064`); server-minted keys for globally unique columns (`storeOrders.ts:421-426`, `:513-517`); replay-on-UNIQUE (:552-561).
6. **Atomic settlement.** Order, items, ledger credit and wallet debit in one batch, with the debit guard aborting the batch if the hold is not funded (`walletOps.ts:1062-1126`). Pinned by `walletHoldSettlement.test.ts`. The same rule applies to escrow (`FUNDED_BY_HOLD`, `escrowOps.ts:312-315`).
7. **Tenant isolation.** `requireStoreOwner` resolves by session user only (`merchantAuth.ts:164-174`). Every merchant query has `merchant_id`/`store_id` in its WHERE. `requireSellingPrivileges` is split from data access (:185-206), so reads survive a PLUS lapse.
8. **Merchant status route mechanics.** Conditional flip, a losing race returns 409, completion counters fenced once (`merchant.ts:1349-1414`, pinned by `merchantOrderStatus.test.ts`), the buyer is notified through the shared writer (:1426-1434).
9. **Data minimisation.** The merchant order detail uses named columns (no cost), and the customer phone comes from the address snapshot (`merchant.ts:1260-1309`).
10. **Governorates.** A closed, shared 18-id list with a parity test; addresses require it.
11. **Platform guards already exclude merchant orders** where they must: the expiry sweep (`orderExpirySweep.ts:86-87`), finance revenue (`financeReport.ts:156-163`, :1093), and the delivery-day picker (`orderStageOps.ts:171`).
12. **A reusable pattern for coupons.** Platform `coupon_redemptions` with state plus the limit trigger (`0077:113-172`) is the model merchant coupons should adopt.

---

## 8. Gaps against the target

| Target | Today | Gap |
|---|---|---|
| **One cart = one seller, server-side** | Route-level check-then-insert on two doors; checkout trusts the cart; `GET /api/cart` scope is broken (V1) | No DB guard (race → mixed cart, V9); checkout does not assert one seller; checkout deletes all lines (V17); `replaceCart` deletes before validating (V14) |
| **Store checkout logically separate** | A separate route, but the same `orders` table and the same platform doors (customer cancel, admin PATCH, tracking, returns) act on store orders with platform semantics | The platform doors are not seller-aware (V6, A1, A2). Store orders need their own lifecycle service, or explicit seller-aware branches in every shared door |
| **Server-side pricing / stock / coupons / commission / wallet** | Pricing and commission correct; wallet correct except orphan holds | Stock and coupon guards are no-ops (V2, V3, V4); no quote binding (V10b); orphan holds (V13); options unvalidated and unpriced (V15) |
| **Idempotent, atomic order creation** | Yes, for the SQL batch | Hold outside the batch with no TTL; `EVENT_KEY_REUSED` becomes a generic error |
| **Merchant sets delivery pricing per governorate** | One flat `fee_iqd` + `free_over_iqd` + note | **Everything is missing:** default + per-governorate override, disabled governorates, free governorates, pickup, preparation time, address-aware quote and place-order, rule snapshot, merchant credit for the fee (V10), UI |
| **Merchant finance from a ledger** (gross, commission, receivable, pending, available, paid, refunds, escrow, payout history) | Partial: a mutable-state ledger, with figures partly derived from `orders` | Double payout (V7); "paid" mixes commission; no refunds or delivery-fee lines; analytics include cancelled orders; escrow held not shown; no payout requests or methods; no statements or export; no reserve/hold period |
| **Merchant selling eligibility at checkout** | Only store `active` and merchant not `suspended` | PLUS lapse, `restricted` status and `sells_direct_products` are ignored (V11), against `docs/MERCHANT_STORES.md:84-87` ("Stops: receiving new orders") |

### 8.1 What must change to support per-governorate delivery safely

1. **Stored configuration.** Replace the free-form JSON with a validated structure: a profile table plus a per-governorate rules table, or versioned JSON with a strict schema.
   - Governorate keys must be ids from the closed list, via `normalizeGovernorate`. Reject unknown ids; never store a name.
   - The profile holds: `default_mode` (fee | free | disabled), `default_fee_iqd`, `free_over_iqd` and its basis (merchandise **after** the merchant discount; decide explicitly, since today's code uses pre-discount, V18), `pickup_enabled` plus pickup location and note, `prep_days`, `note`, and a monotonically increasing `version`.
   - Each rule holds: `mode` (fee | free | disabled), `fee_iqd`, an optional per-governorate `free_over_iqd`, optional `prep_days`/`eta` and a note.
   - Validate: fee bounds (reuse the 1,000,000 cap); if the store is open, at least one serviceable governorate or pickup must exist.

2. **One pure resolver.** For example `packages/shipping/src/merchantDelivery.ts`: `resolveMerchantDelivery(profile, rules, governorateId, merchandiseAfterDiscountIqd, method)` returns `{available, reason, fee_iqd, rule: 'override'|'default'|'free_governorate'|'free_over'|'pickup', prep_days, note, profile_version}`.
   - Precedence: the governorate is disabled → unavailable; pickup chosen → 0; free governorate → 0; override fee; default fee. Then the free-over threshold sets the fee to 0.
   - Integer IQD, never negative. Unit-tested like `splitFee`.

3. **Quote must take the address.** `POST /api/store-orders/quote {addressId, fulfilment, couponCode}`.
   - Read the address with `WHERE id = ? AND user_id = ?`, then `normalizeGovernorate(address.governorate)`.
   - An empty or unknown governorate (legacy rows) → `409 ADDRESS_GOVERNORATE_REQUIRED`. **Never fall back silently to the default fee.**
   - A disabled governorate → `409 DELIVERY_UNAVAILABLE`, with the served list.
   - Return the delivery breakdown plus a **quote fingerprint** (a hash of lines, unit prices, qty, coupon id and discount, governorate, fee, profile version, total) or `expected_total_iqd`.

4. **Place-order recomputes from the address row**, never from a client-sent governorate or fee.
   - Compare against the fingerprint or expected total. A mismatch → `409 QUOTE_CHANGED`, with the fresh quote, so the customer re-confirms.
   - Today a merchant can raise the fee between quote and tap and the customer is charged silently (V10b).

5. **Snapshot the applied rule on the order.**
   - `delivery_method_id ∈ {merchant_delivery, merchant_pickup}`.
   - `delivery_method_snapshot = {governorate, rule, fee_iqd, free_over_iqd, prep_days, eta, note, profile_version}`.
   - Queryable columns such as `delivery_governorate`, `delivery_rule`, `prep_days`, so later edits never rewrite history and disputes can be judged.

6. **Money.**
   - Credit the fee to the merchant as its own ledger line (`delivery_credit`). Today it is lost (V10).
   - Decide whether commission applies to delivery. If it does not, cap per-governorate fees, or merchants can move price into "delivery" to avoid commission.

7. **Idempotency interplay.**
   - Changing the address changes the fee, which changes the hold amount, which with the same key produces `EVENT_KEY_REUSED`.
   - Bind the key to the quote fingerprint: the client mints a new key when the fingerprint changes, and the server answers a same-key/different-fingerprint request with an explicit `409 IDEMPOTENCY_KEY_REUSED`.
   - Add a TTL release for orphan holds (V13).

8. **Cart and UI.**
   - `StoreCheckout.tsx` must send `addressId` with every quote and re-quote on address change. Today it quotes with the coupon only (`StoreCheckout.tsx:94`; client contract `src/lib/merchant.ts:500-505`).
   - Show unavailable, free and pickup states; show the prep time and ETA; disable Place when unavailable.
   - The merchant settings need an 18-row governorate table.
   - The storefront should show "delivers to <your governorate>: <fee>".

9. **Tests.** Resolver units; quote/place parity; address changed between quote and place; merchant edits the profile mid-checkout (409); legacy address with an empty governorate; replay unaffected by later edits; disabled governorate refused at place-order even when quoted earlier.

---

## 9. Bugs and security issues (verified unless marked static)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| **B1** | **P0 functional** | `GET /api/cart` returns `scope: null` and `items: []` for a merchant-only cart. `cart.ts:1112` derives the scope from `loadCart` items, which are `JOIN products` (`cart.ts:684-687`). `Cart.tsx:589` therefore never renders `MerchantCartView` (:1261), the only link to `/store-checkout` (`MerchantCartView.tsx:172`). **The store checkout is unreachable from the UI**, and opening `/cart` resets the cart badge to 0 | V1. UI consequence from code reading |
| **B2** | **P0 money** | **A merchant can cancel a paid (wallet-debited) store order and the customer is never refunded.** The ledger is reversed; stock and `sold_count` are not restored (`merchant.ts:1397-1406`). Previously reported (`00-ASSESSMENT.md:425`), still live | V5: buyer balance stays at DEP − paid, no `wtx_refund_*` row |
| **B3** | **P0 money** | **The admin payout never reduces "available".** Payout rows are `state = 'paid'` and available = `SUM(state = 'available')` (`adminCommunity.ts:1081-1092`; `escrowOps.ts:646-663`). The same balance can be paid out any number of times; it is not merely a race, as `00-ASSESSMENT.md:441` assumed | V7: two payouts of 10,000 from a 10,000 balance, both `replayed: false` |
| **B4** | **P1 money** | **The merchant's delivery fee is charged to the customer but credited to nobody.** The receivable excludes it (`storeOrders.ts:368`, `:508-518`); platform revenue excludes merchant orders (`financeReport.ts:156-163`). The merchant ships at their own cost. The UI shows totals that do not reconcile (`SalesTabs.tsx:261-270`) | V10: total 19,000, fee 700, credit 13,300 → 5,000 unaccounted |
| **B5** | **P1 inventory** | **Oversell.** (a) The stock UPDATE's WHERE clause is a no-op, not an abort (`storeOrders.ts:497-503`). (b) Quantities are not aggregated across option/colour lines of the same product (:197-207). `community_products.stock` has no CHECK | V2 (2 sold, stock 1); V3 (concurrent last unit, order still placed) |
| **B6** | **P1 coupon** | **The `max_uses` cap is not enforced under concurrency.** The conditional increment is a no-op (`storeOrders.ts:472-479`) | V4: single-use code redeemed twice |
| **B7** | **P1 money / finance** | **Customer or admin cancel leave the merchant credit `pending` forever**, and community stock and coupon uses are not restored (`orders.ts:5048-5113`; `admin.ts:3184+`). The merchant dashboard shows money "coming" for refunded orders. Chain: an admin reopening a customer-cancelled order (allowed by `admin.ts:2392-2401`) plus merchant delivery pays the merchant for refunded goods (static). Partly reported in `00-ASSESSMENT.md:425` | V6, A1 |
| **B8** | **P1 isolation** | **A mixed-seller cart settles entirely to the first merchant.** Checkout never asserts a single seller (`storeOrders.ts:173-193`, `:465`). Merchant B's product is decremented, A is credited for B's goods, and A's coupon and delivery apply. The add doors are check-then-insert with no DB guard (`cart.ts:2170-2211`, `:1137-1163`, `:1722-1738`) | V9 (state seeded; the race itself is static) |
| **B9** | **P1 lifecycle** | **Merchant transitions never update `stage`, `order_status_history` or `delivered_at`** (`merchant.ts:1349-1353`). The customer tracker stays at "received" (`orders.ts:5013-5046`). Returns are impossible (`returns.ts:339`). An admin "delivered" leaves the merchant credit pending forever | V8, A2 |
| **B10** | **P1 trust** | **The merchant self-attests delivery, and funds become `available` immediately.** No customer confirmation, window or dispute freeze, unlike escrow orders. Combined with B3, this is direct cash exposure. Previously reported in `00-ASSESSMENT.md:441` | V8 (ledger `available` after 4 merchant taps) |
| **B11** | **P1 policy** | **Checkout ignores the merchant's selling eligibility:** PLUS lapse, `restricted`, `sells_direct_products` (`storeOrders.ts:190-193`; `cart.ts:2151-2154`). This contradicts `docs/MERCHANT_STORES.md:84-87` | V11: `POST /merchant/coupons` returns 403 for the merchant, yet their store takes orders |
| **B12** | **P1 price integrity** | **No binding between quote and order.** Place-order re-prices silently; a fee or price change after the quote is charged without consent | V10b: quoted 19,000, charged 39,000 |
| **B13** | P2 wallet | **Orphaned active purchase holds**, with no TTL or release path (`storeOrders.ts:418-439`, `:541-545`). A same-key retry with a new amount → `EVENT_KEY_REUSED` → generic `WALLET_ERROR` (`walletOps.ts:856`). Funds stay locked indefinitely | V13 |
| **B14** | P2 admin | **The payout route treats any INSERT error as a successful replay** (`adminCommunity.ts:1093-1095`). Examples: an FK failure, a transient error, a key collision with another merchant's payout under the globally unique key. The admin is told "already recorded" while nothing was written | V12 |
| **B15** | P2 UX / data | **`replaceCart` deletes the cart before the stock check.** A refused add leaves the cart empty (`cart.ts:2190-2201`), contradicting its own comment and `SellerConflictDialog.tsx:16-18` | V14 |
| **B16** | P2 data integrity | **Option and colour ids are never validated** against the product and are stored raw in `option_snapshot` (`cart.ts:2163-2164`; `storeOrders.ts:490`). Options cannot carry price | V15 |
| **B17** | P2 marketplace integrity | **Self-dealing.** A merchant can buy from their own store, mark it delivered and review themselves: rating, `completed_orders`, `sold_count` and badge farming (`cart.ts:2158+`; `merchantReviews.ts:127-136`) | V16, Z1 |
| **B18** | P2 privacy | **The customer receives the commission split and the raw order row** (`storeOrders.ts:309-311`, `:337`, `:557`, `:622`). Previously reported in `00-ASSESSMENT.md:338` | V10 reads `placed.order.platform_fee_iqd` from the buyer's response |
| **B19** | P2 finance reporting | **Analytics gross, fees and receivable, and customer lifetime value, include cancelled and refunded orders** (`merchant.ts:1546-1554`, `:1513-1526`) | Static |
| **B20** | P2 finance semantics | **"Paid out" includes escrow commission rows** (`escrowOps.ts:404-415`; `MerchantDashboardPage.tsx:497`). `reserved` is unused. The ledger list hides `state`, so reversed credits show as income (`MerchantDashboardPage.tsx:506-520`) | Static |
| B21 | P3 | Checkout deletes every cart line of the user, including never-priced Levonis lines (`storeOrders.ts:519`) | V17 |
| B22 | P3 policy | Free-over and coupon minimum use the pre-discount subtotal (`storeOrders.ts:155`, `:231`) | V18 |
| B23 | P3 | The merchant is not notified of new store orders; the `new_orders` preference is never read | Static (grep) |
| B24 | P3 | The store-order debit omits the 0108 dinar pair (`storeOrders.ts:529-533`), unlike platform and escrow. Display-only remainder of ≤13 IQD per deposit | Static |
| B25 | P3 | `loadMerchantCart.available` ignores `status = 'hidden'` (`cart.ts:2265`); the checkout refuses it anyway | Static |
| B26 | P3 | The merchant `OrdersTab` ignores `next_cursor`, so only 30 orders are visible (`SalesTabs.tsx:76-81`). The customer order projection carries no store id or slug, only `delivery_method.store` (`orders.ts:713`) | Static |
| B27 | P3 | The store and merchant `governorate` are free text on the server (`merchant.ts:204`, `:274-275`); `service_areas` is free text and unenforced | Static |

---

## 10. Recommended foundation changes, in dependency order

### Phase 0: hotfixes (no or minimal schema; each with a route test)

1. **B1.** Compute `scope` in `GET /api/cart` from **all** `cart_items` rows of the user (the same query as `/cart/scope`), not from `loadCart` items. Add a test: a merchant-only cart → `scope.seller_type = 'merchant'`.

2. **B2 and B7: one seller-aware cancel.** Add `cancelStoreOrderStatements(order, actor)` that returns, in one batch:
   - the conditional status flip
   - `cancelledOrderRefundStatements` (wallet refund)
   - community stock and `sold_count` restore
   - coupon release
   - ledger reversal (`pending` → `reversed`, or a reversal row if already `available`)
   - a history row

   Use it from the merchant cancel, the customer cancel (`orders.ts:5048`) and the admin PATCH (`admin.ts:3184`). **Refuse admin reopen of merchant orders**, or make it require re-payment.

3. **B3 and B14: payouts.**
   - `available = SUM(state = 'available') + SUM(kind = 'payout')`, or better, see Phase 1.5.
   - Make the payout insert conditional in the statement, e.g. `INSERT … SELECT … WHERE (available − reserved − paid_out) >= ?`.
   - Report only a UNIQUE conflict on *the same* key, merchant and amount as a replay; propagate every other error.

4. **B5 and B6: guards must abort, not no-op.**
   - Aggregate qty per product first.
   - Use the codebase's NULL-into-NOT-NULL fence (as in `assertHoldStateStatement`, `walletOps.ts:1128-1136`). For example: `UPDATE community_products SET updated_at = CASE WHEN track_stock = 0 OR stock >= ? THEN updated_at ELSE NULL END WHERE id = ?`, placed **before** the decrement (`updated_at` is `NOT NULL`, `0030:175`). Or add a trigger with `RAISE(ABORT, 'OUT_OF_STOCK')`.
   - Fence the coupon the same way, and map the abort to `409 OUT_OF_STOCK` / `409 COUPON_EXHAUSTED`.

5. **B8 and B21.** At checkout, assert that `COUNT(DISTINCT merchant_id) = 1 AND COUNT(DISTINCT store_id) = 1` over the priced lines, or return 409 `CART_SELLER_CONFLICT`. Delete only the priced line ids.

6. **B11.** At add-to-cart and at checkout, require the store to be open, the merchant to be neither `suspended` nor `restricted`, `sells_direct_products = 1`, and the owner to hold the `merchantStore` benefit. Reuse `sellingStatus` logic server-side for the *owner* of the store.

7. **B18.** Return `orderPublic(...)`-style projections from `/api/store-orders` and the replay path. Drop the commission fields from the customer quote.

8. **B9.** The merchant status route writes `stage` (status → stage map as in `0028:41-51`), an `order_status_history` row (add `source 'merchant'`; this needs a CHECK change or a new table) and `delivered_at` (COALESCE, as in `admin.ts`).

9. **B15.** Move the `replaceCart` delete into the same batch as the insert, after validation.

10. **B17 (minimum).** Refuse `orders.user_id = merchant owner` at add and checkout, and refuse reviews by the store owner.

### Phase 1: schema foundations (migrations; additive where possible)

1. **Enforce one seller in the DB.** Add a `BEFORE INSERT` and a `BEFORE UPDATE OF seller_type, merchant_id` trigger on `cart_items` that runs `SELECT RAISE(ABORT, 'CART_SELLER_CONFLICT') WHERE EXISTS (SELECT 1 FROM cart_items x WHERE x.user_id = NEW.user_id AND x.id <> NEW.id AND (x.seller_type <> NEW.seller_type OR COALESCE(x.merchant_id, '') <> COALESCE(NEW.merchant_id, '')))`. This closes the race (B8). It is compatible with `cartSeller.test.ts:152`, which uses two different users. Map the error to the existing 400.

2. **Merchant coupon redemptions.** `merchant_coupon_redemptions(id, coupon_id, store_id, user_id, order_id UNIQUE, discount_iqd, state active|released, …)`, plus a limit trigger modelled on `0077:151-172` (global `max_uses`, new `max_per_user`, optional `assigned_user_id`). Keep `used_count` as a derived display field or drop it. Add targeting columns (product / section / first-order).

3. **Merchant delivery configuration.**
   - `merchant_delivery_profiles(store_id PK, default_mode CHECK, default_fee_iqd CHECK >= 0, free_over_iqd, free_over_basis CHECK, pickup_enabled, pickup_governorate, pickup_note, prep_days CHECK >= 0, note, version INTEGER NOT NULL, updated_at)`.
   - `merchant_delivery_rules(store_id, governorate_id CHECK IN (<18 ids>), mode CHECK IN ('fee','free','disabled'), fee_iqd, free_over_iqd, prep_days, note, PRIMARY KEY(store_id, governorate_id))`.
   - Backfill from `merchant_stores.delivery_settings`: `fee_iqd` → default fee, `free_over_iqd` → threshold, `note` → note. Keep the JSON column read-only for rollback.

4. **Order delivery snapshot.** Add `delivery_governorate`, `delivery_rule`, `delivery_prep_days` and `quote_fingerprint` to `orders`. Keep `delivery_method_snapshot` as the full JSON.

5. **Merchant ledger v2.** The kind/state CHECKs on `merchant_payout_ledger` cannot be altered in place, so create a new table:
   - `merchant_ledger_entries(id, merchant_id, order_id, community_order_id, escrow_id, payout_id, kind CHECK IN ('sale_gross','commission','delivery_fee','refund','commission_refund','adjustment','payout','payout_reversal'), bucket CHECK IN ('pending','available','reserved','paid'), amount_iqd, event_key UNIQUE, created_by, created_at)`
   - **Append-only.** Bucket moves are new rows (e.g. `release`: −X pending, +X available), never UPDATEs.
   - Every figure the owner asked for becomes a SUM over this table: gross, commission, delivery, refunds, receivable, pending, available, reserved, paid, and escrow (via `community_escrows`).
   - Backfill from `merchant_payout_ledger` with deterministic keys. Keep the old table read-only.
   - Add a `release_after` hold period, so "delivered" does not make money instantly spendable (B10). Release by a cron after N days (`autoCompleteDays`, `merchantOps.ts:187-193`), or on customer confirmation; freeze on complaint.

6. **Payouts workflow.** `merchant_payout_methods` (reuse the `payoutMethods` channel idea, `walletOps.ts:1446+`) and `merchant_payouts(id, merchant_id, amount_iqd, state requested|approved|processing|paid|failed|cancelled, method_snapshot, reference, requested_by, decided_by, event_key UNIQUE, …)`. A request writes a `reserved` bucket entry through a conditional insert; paid moves reserved → paid; failed moves reserved → available.

7. **A TTL sweep for store-order purchase holds.** Release `wallet_holds` with `ref_type = 'store_order'`, `state = 'active'` and no `orders` row after N minutes, fenced against the order batch as in the saga pattern (`01-TARGET.md:421`; `04-DECISIONS.md:97`).

8. Drop or implement `merchant_store_analytics_daily`. It is dead today.

### Phase 2: API contracts

1. `POST /api/store-orders/quote` `{addressId, fulfilment: 'delivery'|'pickup', couponCode?}` returns:
   - `{store, lines[], subtotal_iqd, discount_iqd, delivery: {governorate, available, reason?, rule, fee_iqd, prep_days, eta?, note?}, total_iqd, quote_fingerprint, wallet_available_iqd, wallet_covers, wallet_shortfall_iqd, wallet_topup_url}`
   - No commission fields.
   - Errors: `ADDRESS_GOVERNORATE_REQUIRED`, `DELIVERY_UNAVAILABLE`, `COUPON_INVALID{reason}`, `CART_SELLER_CONFLICT`, `STORE_CLOSED`, `OUT_OF_STOCK{product_id, available}`.

2. `POST /api/store-orders` `{idempotencyKey, addressId, fulfilment, couponCode?, quoteFingerprint}`:
   - `201 {order: <public projection>}`, or a replay.
   - `409 QUOTE_CHANGED {quote}`, `409 DELIVERY_UNAVAILABLE`, `409 OUT_OF_STOCK`, `409 COUPON_EXHAUSTED`, `409 IDEMPOTENCY_KEY_REUSED`, `400 INSUFFICIENT_FUNDS`, `400 STORE_PREPAID_ONLY`.

3. `GET` and `PUT /api/merchant/delivery` returns `{profile, rules[18]}`, strictly validated, bumping `version`. The storefront gets `GET /api/storefront/:slug/delivery?governorate=` (public, fees only).

4. **Merchant order lifecycle.**
   - `POST /api/merchant/orders/:id/{confirm|prepare|ship|deliver|cancel}`, where `ship` takes a carrier and tracking number and `cancel` takes a required reason and does a refund plus restock.
   - Customer: `POST /api/orders/:id/confirm-receipt` and a dispute window.
   - `GET /api/merchant/orders?cursor=&status=&from=&to=` with a customer projection that includes the store identity.
   - The order timeline, from `order_status_history`, is visible to both parties.

5. **Merchant finance.**
   - `GET /api/merchant/finance/summary` returns `{gross, commission, delivery_fees, refunds, receivable, pending, available, reserved, paid_out, escrow_held}`, all ledger-derived.
   - `GET /api/merchant/finance/ledger?cursor=`.
   - `POST` and `GET /api/merchant/payouts`, with the admin decide endpoints behind the financial scope.

### Phase 3: UI (after the contracts)

- `StoreCheckout.tsx`: send `addressId` and fulfilment, re-quote on address change, show the delivery breakdown, unavailable and pickup states, and the prep time/ETA. Handle `QUOTE_CHANGED` by showing the new total and asking for confirmation. Regenerate the idempotency key when the fingerprint changes.
- Merchant settings: an 18-governorate delivery table, pickup, prep time, note.
- Merchant finance tab: bucket tiles, a ledger with state and kind labels, payout requests.
- Orders tab: pagination, a timeline, ship with tracking, cancel with a reason (and a refund notice).

Each step should come with a route-level test in the style of `tests/merchantCartSeparation.test.ts`. The reproduction cases in the scratch suites can be turned into regression tests: invert the assertions once each fix lands.
