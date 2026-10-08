# Gifts, Wallet Free Delivery and Quick Buy — plan of record

Owner brief: 2026-10-06 (23 sections). This document is the contract every lane
codes against. It extends the systems that exist; it does not add parallel ones.
Survey facts are cited `file:line` against `7e42c987`.

---

## 0. Settled decisions

| # | Decision | Why |
|---|---|---|
| D1 | **One gift table.** `gift_entitlements` is rebuilt (SQLite cannot widen a CHECK or drop NOT NULL) to carry the new lifecycle, manual grants and the order link. Every existing row survives byte-for-byte as `grant_mode='legacy'`. | `reward_id NOT NULL` makes a non-review grant impossible today (0003:211-225). |
| D2 | **Levels are the existing `gift_pools`** (dead today, `docs/architecture/00-ASSESSMENT.md:86`), one canonical row `gift_level_<n>` per level 1–5 carrying name/description in ar/en/ckb and `active`. **Level items are the existing `gift_pool_items`**, extended with a real product reference. A product row's `stock` column is never read: real inventory decides. Legacy label-only rows stay readable, never offered. | Brief §1: «لا تنشئ منتجات هدايا منفصلة عن المتجر». |
| D3 | A level item is **fully pinned**: product + option values + colour + quantity + sale type (direct_sale / pre_order, plus transport route for pre-order). To offer two colours the admin adds two items. | Simpler, exact, matches «تحديد المنتج / الخيار / اللون / الكمية / بيع مباشر أو طلب مسبق». |
| D4 | Gift states stored: `granted → ready_to_redeem → redeemed → ordered → fulfilled`, `cancelled`. **ADDED_TO_ORDER is derived** (state `redeemed` and a cart line names the gift) so no cart door can leave it stale. Legacy rows keep `available / selected / fulfilled / cancelled`. | One source of truth per fact. |
| D5 | A cancelled order returns its gift to `redeemed` (orderable again). A delivered order makes it `fulfilled`. Both by DB trigger on `orders.status`, so every cancel/deliver door is covered (customer, admin, stage move, sweeps). | The gift was never received. |
| D6 | Stock for a gift moves only through the order: reserved by the checkout batch like any line, deducted at confirmation, returned on cancel. No reservation at grant or redeem. | Brief §1. |
| D7 | Wallet free delivery waives only the **standard** shipment component. Add-ons (protected delivery) and every other method are untouched. New `waiver_source='wallet'`; PRO/PRIME keep precedence when they also apply. | Brief §2. |
| D8 | «100% wallet» = payment method `wallet` and no points used (points are a separate instrument). An order whose paid products total is 0 (gift-only) never qualifies. A rule is met when the order contains a line from the rule's catalog subtree **and** the order's paid products subtotal (after product/membership discounts, before coupon and delivery) is ≥ the rule minimum. | Brief: «مجموع المنتجات فيها». |
| D9 | **Quick Buy is direct sale only** in v1 (no pre-order, bundle, mystery, merchant products), standard delivery only, wallet only, no coupons/points. | One order, one shipping type, nothing to choose at checkout. |
| D10 | **The Quick Buy order row is created at finalisation.** During the 30 minutes the session (`quick_buy_sessions` + `quick_buy_items`) is the draft; nothing appears in the admin queue (brief §14) and no existing order sweep can touch it. **Amended 2026-10-08 (DECISIONS row 188): Quick Buy has no admin surface at all** — no tab, no `/api/admin/quick-buy`, no board badge; a session the order door refuses on every attempt is cancelled by the system with its whole hold and its units released, never parked for an administrator. | Every reader of `orders` stays correct by construction; the owner: «لا حاجة لهذه الإعدادات والتعقيد». |
| D11 | **One wallet hold per session**, replaced (release old + insert new, one batch) on every change, so the held amount always equals the session total. An append-only `quick_buy_events` log records the **delta** of every hold/release/capture for reports. | `wallet_holds` has no partial release (walletOps.ts 1179). |
| D12 | Prices are snapshotted per item at add time. At finalisation the customer pays **at most** what is held: shipping = min(recomputed, quoted), order-level membership discount = max(recomputed, quoted). A lower final total captures less and releases the rest. | Brief §20, §19. |
| D13 | Finalisation runs on the existing per-minute cron (new `waitUntil` beside finance recovery) and lazily on any Quick Buy request that finds an expired open session. Edits are refused **inside the batch** by `expires_at > now`, so the lock is exact even before the cron runs. | No DO/Queue exists (index.ts:1062-1099). |
| D14 | Quick Buy consent reuses `policy_acceptances` (context `quick_buy`) for `terms`, `privacy` and a new policy `quick_buy` (ar/en/ckb), plus the profile's stored versions. A version bump requires re-consent before the next add; an open session finalises on the consent it was started under. | Existing acceptance system (policyOps.ts). |
| D15 | New `orders.order_kind` (`normal|quick_buy|gift`) and `orders.quick_buy_session_id` — shared migration `0174_order_kind.sql`, landed before the lanes split so both build on it. `gift` = every line is a gift line; a mixed order stays `normal`. | Brief §21. |

---

## 1. Gifts

**Prior work to reuse.** Branch `release/reviews-gifts` (commit `94e8943f`, based on the
older live commit `22118e43`) holds a parked, unverified build of an earlier gifts brief
(2026-09-30, `docs/REVIEWS_GIFTS.md` on that branch): gift levels from real store products,
the gift cart line, checkout at 0 IQD, the cancel/deliver triggers, MyGifts/GiftCard, admin
item sheet, fixtures and tests. It is a quarry, not a merge: port the parts that fit this
document. Its decisions that still hold here: S6 (a level's items are alternatives, one
product per entitlement; bundles and mystery offers cannot be gifts), S7 (only the product
is free; its line fees are 0 too; delivery and COD rules apply to the order as normal), S8
(a gift line triggers no other reward: support-code gift, referral printer reward,
review-reward purchase proof, the PRO pre-order filament gift on a gift-only order, the
trade-in coupon cap, offers), S9 (one trigger covers every cancel door; an order holding a
gift line cannot be re-opened), S10 (`OrderCreated` unchanged: a gift line is
`item_kind: 'ordinary'` with unit 0). Not carried over: the 6-digit redemption code, the
review media/eligibility rewrite and its policy edits — this brief does not ask for them.

### 1.1 Schema — `migrations/0175_gift_lifecycle.sql`

`gift_entitlements` rebuilt (stash `gift_redemptions` first, as 0141/0165 precedent; recreate index):

```
id, reward_id NULL UNIQUE REFERENCES review_rewards(id), user_id NOT NULL,
max_level, chosen_level, chosen_options, contents, state, created_at, selected_at, fulfilled_at   -- legacy, unchanged
grant_mode   'legacy'|'level'|'product'          NOT NULL DEFAULT 'legacy'
reason       'legacy'|'review'|'reward'|'compensation'|'admin_gift'
level        1..5 (NULL only on legacy)
admin_note   TEXT NOT NULL DEFAULT ''           -- internal, never returned to the customer
granted_by, granted_at, updated_at, version INTEGER NOT NULL DEFAULT 1
gift_item_id         -- the level item chosen (NULL for an arbitrary product grant)
gift_product_id, gift_option_value_ids (canonical JSON), gift_color_id, gift_qty, gift_sale_type, gift_transport_method
gift_snapshot  JSON  -- names ar/en/ckb, image, option/colour labels, sku, regular unit price at choose time
chosen_at, redeemed_at
order_id, order_item_id, ordered_at, order_seq INTEGER NOT NULL DEFAULT 0
cancelled_at, cancelled_by, cancel_reason
CHECK legacy ⇔ state IN (available,selected,fulfilled,cancelled); new ⇔ state IN (granted,ready_to_redeem,redeemed,ordered,fulfilled,cancelled)
CHECK state IN (ready_to_redeem,redeemed,ordered,fulfilled) AND grant_mode<>'legacy' ⇒ gift_product_id NOT NULL
CHECK state='ordered' ⇒ order_id NOT NULL AND order_item_id NOT NULL
```

Other changes:
- `gift_pools` + `name_ckb, description_ar, description_en, description_ckb, updated_at, updated_by`; `INSERT OR IGNORE` rows `gift_level_1..5` (active=1, generic names). Code reads/writes only the canonical row of a level.
- `gift_pool_items` + `product_id, option_value_ids, color_id, qty (≥1), sale_type, transport_method, sort, updated_at`.
- `cart_items` + `gift_entitlement_id TEXT` (+ UNIQUE partial index). A gift line uses `shipping_method_id='gift:'||id`, so it never collides with a paid line of the same variant in `idx_cart_levonis_line`.
- `order_items` + `gift_entitlement_id TEXT` (+ UNIQUE partial index — one live order line per gift, order_seq makes the next attempt distinct).
- Triggers: `trg_orders_gift_cancelled` (status→cancelled: `ordered → redeemed`, clear order link), `trg_orders_gift_delivered` (status→delivered: `ordered → fulfilled`), `trg_orders_gift_reopen_guard` (refuse reopening a cancelled order that held a gift line).

### 1.2 Routes — `worker/routes/gifts.ts` mounted at `/api/gifts` (gift routes move out of reviews.ts)

Customer (auth):
| Method / path | Body | Result | Refusals |
|---|---|---|---|
| GET `/` | — | `{gifts:[GiftView]}` | — |
| POST `/:id/choose` | `{itemId}` | `{gift}` | 404 `GIFT_NOT_FOUND`; 409 `GIFT_STATE`, `GIFT_ITEM_UNAVAILABLE` |
| POST `/:id/redeem` | `{}` | `{gift}` (replay-safe) | 409 `GIFT_STATE`, `GIFT_CHOICE_REQUIRED`, `GIFT_ITEM_UNAVAILABLE` |

`POST /api/cart/gift-items {giftId, replaceCart?}` (cart.ts): requires `redeemed`, inserts the locked 0 IQD line (qty = gift_qty), `already_in_cart` on replay. `PATCH` a gift line → 409 `GIFT_LINE_LOCKED`. Checkout prices a gift line at 0 from the frozen selection, writes `order_items.gift_entitlement_id`, flips `redeemed → ordered` (conditional on `order_seq`), fences the count, all in the order batch, **before** the cart-line delete.

`GiftView` = `{id, status (GRANTED|READY_TO_REDEEM|REDEEMED|ADDED_TO_ORDER|ORDERED|FULFILLED|CANCELLED|LEGACY), level:{n,name,description}, reason, mode, choices?:[ItemView], chosen?:ItemView, order?:{id, status}, granted_at, redeemed_at, ordered_at}` — never `admin_note`.

Admin (requireAdmin) under `/api/gifts/admin`:
- `GET /levels`, `PUT /levels/:n` (names/descriptions/active), `POST /levels/:n/items`, `PUT /items/:id`, `DELETE /items/:id` (soft: active=0).
- `GET /grants?state&level&reason&user&q&cursor`, `POST /grants` `{userId, mode:'level'|'product', level, itemId?|product?:{productId, optionValueIds, colorId, qty, saleType, transportMethod?}, reason, note, idempotencyKey}`, `PATCH /grants/:id` `{note?, reason?}`, `POST /grants/:id/cancel {reason}`, `POST /grants/:id/convert` (legacy available → granted), `POST /grants/:id/fulfill` (legacy selected only), `GET /grants/:id/audit`.
- The review reward approval (`POST /api/reviews/admin/:id/reward`, printer gift) creates a `level` grant with `reason='review'`, `level = qualityScore`.
  A level the owner switched off is refused (409 `GIFT_LEVEL_INACTIVE`, `details.level`), as on «منح هدية»; the admin approves with another score or switches the level on. An empty level is allowed: the customer's card says «لا توجد هدايا متاحة في هذا المستوى الآن» until the level has products.
- Product save (`planRelations`): an option value, colour or combination named by an active level item, a gift in `ready_to_redeem`/`redeemed`, or an open/failed Quick Buy line is DEACTIVATED instead of deleted, exactly as one a live order names — the same holders that block deleting the whole product (`productDeletion.ts`).

Every write: one batch with `auditStatements` (`gift.grant`, `gift.choose`, `gift.redeem`, `gift.order`, `gift.cancel`, `gift.note`, `gift.convert`, `gift.fulfill`, `gift.level.update`, `gift.item.*`), detail = level, product, user, actor. The customer is notified on grant (`gift_granted`).

### 1.3 UI
- `/gifts` (MyGifts rewrite): one card per gift; level choices grid → «اختر هديتك» → «استرداد الهدية» → «تم استرداد الهدية ✓» + «أضف إلى السلة» → «في السلة» → «تم طلب هذه الهدية» + order link → «تم التسليم». Cart/Checkout/Order show the gift line «هدية — 0 د.ع».
- Admin: `src/components/adminGifts/` (lazy, `.ap` theme): Levels editor (ProductPicker like `adminMystery/AdminMysteryPools.tsx`), Grants list + filters, Grant sheet, detail with audit timeline. AdminReviews keeps its review queue; its pools/gifts tabs open the new screens.

---

## 2. Wallet Free Delivery

Setting `walletFreeDelivery` (admin_settings, validated in `PUT /api/admin/settings/:key`, public subset for the checkout label):

```json
{ "enabled": true, "require_full_wallet": true, "methods": ["standard"],
  "rules": [ {"catalog_id": "cat_printers", "min_products_iqd": 500000, "enabled": true},
             {"catalog_id": "cat_materials_fdm", "min_products_iqd": 0, "enabled": true} ] }
```

- `worker/lib/walletFreeDelivery.ts`: `normalizeWalletFreeDelivery(raw)` and the pure verdict
  `walletFreeDeliveryVerdict({config, deliveryMethodId, paymentMethodId, pointsUsed, lines:[{ancestry:string[], paid_iqd:number}], productsSubtotalIqd})`
  → `{eligible, rule|null, reason}` (D8). `require_full_wallet=false` makes the payment method irrelevant.
- `quoteShipping` gains `walletFreeDelivery?: boolean`: waives the standard shipment component; `waiver_source` order: pro, prime, wallet, promotion, none.
- Checkout (`settle`): the verdict is computed on the final pass (after points), passed to `runQuote`; the quote and order snapshot carry `wallet_free_delivery {rule, products_subtotal_iqd}`; `delivery_waived=1`, `shipping_before_benefit_iqd` = original fee, `shipping_benefit_iqd` = waived amount, `shipping_iqd` = 0. Finance posts 4100 from `shipping_iqd` (0) — nothing to reverse.
- Customer label: «توصيل عادي مجاني — للدفع الكامل من محفظة Levo» (en: “Free standard delivery — paid in full from Levo Wallet”, ckb: «گەیاندنی ئاسایی بەخۆڕایی — بۆ پارەدانی تەواو لە جزدانی Levo»). Admin settings block in AdminStoreSettings.

---

## 3. Quick Buy

### 3.1 Schema — `migrations/0176_quick_buy.sql`
- `quick_buy_profiles(user_id PK, enabled, address_id, terms_version, privacy_version, policy_version, consented_at, wallet_consent_at, updated_at)` (no FK on address_id: a deleted address disables Quick Buy at use time instead of failing the delete).
- `quick_buy_sessions(id PK, user_id, state open|submitted|cancelled|failed, started_at, expires_at, order_id (reserved at start, used at finalisation), address_id, address_snapshot JSON, delivery_method_id 'standard', rev, hold_id, held_iqd, held_cents, exchange_rate, items_iqd, discount_iqd, shipping_iqd, shipping_before_iqd, total_iqd, quote_json, consent_json, lease_until, finalize_attempts, finalize_error, submitted_at, cancelled_at, cancel_reason, created_at, updated_at)`;
  UNIQUE `(user_id) WHERE state='open'`; index `(expires_at) WHERE state='open'`; UNIQUE `(order_id)`.
- `quick_buy_items(id PK, session_id, user_id, product_id, option_id, option_value_ids, color_id, warranty_plan_id, qty, unit_price_iqd, line_total_iqd, snapshot JSON, stock_targets JSON, created_at, updated_at, removed_at)`; UNIQUE live line `(session_id, product_id, option_value_ids, color_id, warranty_plan_id, unit_price_iqd) WHERE qty>0`.
- `quick_buy_actions(user_id, key, session_id, kind, request_hash, response_json, created_at, PK(user_id,key))` — idempotency.
- `quick_buy_events(id, session_id, user_id, kind hold|release|capture|reserve|unreserve|add|update|remove|start|submit|cancel|fail, amount_iqd, amount_cents, item_id, hold_id, order_id, detail, created_at)` — append-only.
- `orders.order_kind` / `orders.quick_buy_session_id` already exist (0174).

### 3.2 Routes — `worker/routes/quickBuy.ts` at `/api/quick-buy` (auth; every write carries `idempotencyKey`)

| Method / path | Body | Result | Refusals |
|---|---|---|---|
| GET `/profile` | — | `{enabled, address, consent, required:{terms,privacy,quick_buy}, needs_consent}` | — |
| POST `/activate` | `{policyAcceptance:[{key,version}×3], walletConsent:true, addressId, idempotencyKey}` | `{profile}` | 400 `POLICY_ACCEPTANCE_REQUIRED`, `QUICK_BUY_ADDRESS_INVALID` |
| PUT `/profile` | `{enabled?, addressId?}` | `{profile}` | 400 `QUICK_BUY_ADDRESS_INVALID` |
| GET `/session` | — | `{session|null, recent|null, server_now}` | — |
| POST `/items` | `{productId, qty, optionId?, optionValueIds?, colorId?, warrantyPlanId?, idempotencyKey}` | `{session, added:{item_id, qty}}` | 409 `QUICK_BUY_NOT_ACTIVE`, `QUICK_BUY_RECONSENT_REQUIRED`, `QUICK_BUY_DIRECT_ONLY`, `QUICK_BUY_UNSUPPORTED_PRODUCT`, `OUT_OF_STOCK` (details.available), `QUICK_BUY_INSUFFICIENT_BALANCE` (details.available_iqd, required_iqd), `QUICK_BUY_EXPIRED`, `QUICK_BUY_BUSY`, `IDEMPOTENCY_KEY_REUSED` |
| PATCH `/items/:id` | `{qty, idempotencyKey}` (0 removes) | `{session}` | same + `QUICK_BUY_ITEM_NOT_FOUND` |
| DELETE `/items/:id` | `{idempotencyKey}` | `{session}` | — |
| POST `/session/cancel` | `{idempotencyKey}` | `{session:null}` | — |

Admin: **none** (removed 2026-10-08, DECISIONS row 188). The admin meets a Quick Buy only as the ordinary order it becomes; nothing confirms, prepares, ships, retries or cancels a session by hand.

`SessionView` = `{id, state, started_at, expires_at, remaining_ms, server_now, items:[{id, product_id, name, image, option_label, color_label, sku, qty, unit_price_iqd, line_total_iqd, max_qty}], items_iqd, discount_iqd, shipping_iqd, shipping_before_iqd, free_delivery:{applied, label}, total_iqd, held_iqd, address:{name, phone, governorate, area, address, landmark}, delivery_method:'standard', order_id (after submit), rev}`.

### 3.3 Every write is one D1 batch
`add / change qty / remove`:
1. idempotency row (`INSERT … ON CONFLICT DO NOTHING` + fence on hash) — a replay returns the stored response;
2. session insert (start) or `UPDATE … SET rev=rev+1 WHERE id=? AND rev=? AND state='open' AND expires_at > now` + `fence(changes()=1)`;
3. item insert/update;
4. inventory: `planInventory('reserve'|'release', op 'qb_<actionId>', line = item id)` + fence on the ledger rows;
5. wallet: `releaseHoldStatement(old)` + `assertHoldStateStatement(old,'released')`, then the new hold insert (guarded on available) + fence that it is active; session totals/hold_id;
6. `quick_buy_events` rows with the deltas.
Removing the last item cancels the session (release everything, no new hold).

### 3.4 Finalisation — `finalizeQuickBuySession(env, id)` (cron + lazy), one batch
claim lease → recompute quote (D12) → statements:
`orders` INSERT (shared builder, `order_kind='quick_buy'`, payment `wallet`, due 0) · `order_items` INSERTs (shared builder, from snapshots) · inventory transfer per item: `release` session reservation then `reserve` under the order (`planInventory` with the released moves credited) + reservation fence · wallet: commit the session hold with `ref=orderId` (or release + new final hold + commit when the total fell) · settlement `prepaid_at_purchase` · `planOrderFinanceSnapshot` (journal `wallet-advance`) · OrderCreated outbox · session flip `open → submitted` guarded by `expires_at <= now` and its stored `order_id` (the loser of a race hits the PK and rolls back) · events `capture`/`release`/`submit` · in-app + channel notice `quick_buy_submitted`.
After commit: `initOrderStage`, invoice, `notifyOrderPlaced`, admin announcement — exactly as checkout (orders.ts:4758-4886). Ten failed attempts → **cancelled** (`cancel_reason='not_submitted'`). A refused attempt leases the session for 45 s (`QUICK_BUY_RETRY_SPACING_S`, the database's clock), so the next one waits about a minute whoever triggers it — the cron or a burst of the customer's own page loads — and a brief glitch cannot spend all ten in a second: one fenced batch releases the hold and every reservation and writes `fail`/`release`/`cancel`; the customer's bell says so in ar/en/ckb (`quick_buy_failed`, key `quick_buy_not_submitted:<session>`). No administrator is alerted or needed (DECISIONS row 188). If that batch cannot land, the lease is cleared and the next tick goes straight back to it — never to a late order attempt. A row left `failed` by the earlier release is swept the same way, ten a tick.

### 3.5 UI (as built — owner brief §4 and §13 supersede the first sketch)
- **Product page: one morphing control** (`src/components/quickBuy/QuickBuyBar.tsx`) for signed-in customers on
  catalogue products. Cart mode `[⚡ 50px circle][🛒 أضف إلى السلة]`, quick mode `[⚡ شراء سريع][🛒 circle]`,
  6px apart, the bar's width constant. ⚡ sits at the inline START — the right in ar/ckb, as the owner drew it — and
  pushes the cart capsule toward the inline end as it grows. One motion value `p∈[0,1]` drives both widths, the
  clipped and fading cart label, the gliding icons and the primary/accent crossfade; React commits only when the
  motion settles. Tap: press 0.97→1, then a 450ms easeInOutCubic push; the compact 🛒 runs it in reverse. Drag: the
  ⚡ capsule follows the finger (`p = p₀ + dx/D`), completes past 45% or on a flick faster than ~500px/s, springs
  back otherwise; a 6px slop separates a tap from a drag and a drag never buys. Haptics: one tick at the threshold,
  one when the morph to Quick Buy completes. The compact capsules are real buttons named «تفعيل الشراء السريع» and
  «العودة إلى الإضافة للسلة» (en, ckb). Reduced motion: the layout changes at once and only the looks crossfade.
  Measured: a 60-step drag with 0 long tasks and 0 React commits, frame p95 16.8ms.
- Not activated → the press only, then the activation Sheet: three unchecked consents + the wallet-hold consent,
  then the default address; on success the bar morphs to quick mode by itself, no second tap. A printer asks for
  the standard-delivery warning (unticked) before it is added. Insufficient balance: «رصيد محفظة Levo غير كافٍ
  لإتمام الشراء السريع.» with the available and required amounts — and the bar stays in quick mode.
- My orders: the card «شراء سريع — قيد التجميع» exists **only while the session is open**: live mm:ss from
  `expires_at` with the server offset, a progress hairline, items with qty stepper / remove, totals, held amount,
  address, delivery; locked at 00:00. Once submitted the card disappears and the order is an ordinary order card
  (§13) carrying only «⚡ تم إنشاؤه بالشراء السريع»; the order's page carries the same badge. A pending order the
  wallet paid in full reads «بانتظار التأكيد», not «بانتظار الدفع».
- Settings › «الشراء السريع»: switch, default address, consents (versions and date), re-consent.
- Bottom nav account icon: «⚡ mm:ss» chip while a session is open.

---

### 3.6 As built (main tree, verified by tests/quickBuy.test.ts)

**Customer API** (`/api/quick-buy`, auth, every write carries `idempotencyKey` in the body or the
`Idempotency-Key` header):

| Method / path | Body | 200 result |
|---|---|---|
| GET `/profile` | — | `{profile: {enabled, active, needs_consent, address, address_missing, consent, required:{terms,privacy,quick_buy}}}` |
| POST `/activate` | `{policyAcceptance:[{key,version}]×3, walletConsent:true, addressId, idempotencyKey}` | `{profile}` |
| PUT `/profile` | `{enabled?, addressId?, idempotencyKey}` | `{profile}` |
| GET `/session` | — | `{session: SessionView|null, recent: SessionView+{order}|null, server_now}` |
| POST `/items` | `{productId, qty, optionId?, optionValueIds?, colorId?, warrantyPlanId?, printerStandardDeliveryAcceptance?, idempotencyKey}` | `{session, ended, added:{item_id, qty}, replay, server_now}` |
| PATCH `/items/:id` | `{qty (0 removes), idempotencyKey}` | same |
| DELETE `/items/:id` | `{idempotencyKey}` | same (`session:null`, `ended` = the cancelled session when it was the last line) |
| POST `/session/cancel` | `{idempotencyKey}` | `{session:null}` |

Refusal codes: 400 `POLICY_ACCEPTANCE_REQUIRED`, `QUICK_BUY_WALLET_CONSENT_REQUIRED`, `QUICK_BUY_ADDRESS_INVALID`,
`OUT_OF_STOCK` (details.available), `VALIDATION`; 409 `QUICK_BUY_NOT_ACTIVE`, `QUICK_BUY_RECONSENT_REQUIRED`,
`QUICK_BUY_DIRECT_ONLY`, `QUICK_BUY_UNSUPPORTED_PRODUCT`, `QUICK_BUY_INSUFFICIENT_BALANCE`
(details.available_iqd, required_iqd), `QUICK_BUY_EXPIRED`, `QUICK_BUY_BUSY` (retry with the SAME key),
`QUICK_BUY_PREVIOUS_PENDING`, `QUICK_BUY_NO_SESSION`, `QUICK_BUY_FULL`, `QUICK_BUY_ITEM_NOT_FOUND` (404),
`PRINTER_STANDARD_DELIVERY_ACCEPTANCE_REQUIRED` (details.policy — the printer standard-delivery warning, once
per session), `SHIPPING_NEEDS_CONFIG`, `IDEMPOTENCY_KEY_REUSED`.

`SessionView` = `{id, state, started_at, expires_at, server_now, remaining_ms, editable, items:[{id, product_id,
slug, name, name_ar, name_ku, image, variant, sku, qty, unit_price_iqd, line_total_iqd, option_value_ids, color_id,
warranty_plan_id}], items_iqd, discount_iqd, shipping_iqd, shipping_before_iqd, free_delivery:{applied, label:{ar,en,ckb}},
total_iqd, held_iqd, address:{name, phone, governorate, area, address, landmark}, delivery_method:'standard',
order_id (submitted only), finalize_error (a legacy `failed` row only), cancel_reason (cancelled only; `not_submitted` = the
system gave up and refunded), rev}`. `recent` also carries a session cancelled `not_submitted` within the last day, for the one
line on «طلباتي».

**How it is priced and written.** Every change runs `computeCheckout` with a `CheckoutSource` (the session's
lines through the cart projection, the frozen address, the session's own reserved units and held cents credited
back, the quoted unit prices as ceilings, the session's rate) and commits ONE batch: idempotency row → session
(fenced on `rev`, on `expires_at > now` by the database clock and on the new hold id) → lines → stock release and
reserve (fenced on their ledger keys) → old hold released + asserted, new hold inserted under the wallet's own
availability guard + fenced → `quick_buy_events`. The hold is `comp.walletUsdCents`, exactly what the order will
spend.

**Finalisation** (`worker/lib/quickBuy/finalize.ts`): per-minute cron + lazily from any Quick Buy request.
Lease → `placeOrder(c, user, body, hooks)` — the cart's own order door, extracted from `POST /api/orders` with no
change to its SQL. Hooks: reserved `orderId`; `before` = release the session hold (+assert) and the session's
reservations (+fence), first in the batch; the order plan is credited those units (`reservedCredit` in
`planInventory`); unit and delivery-fee ceilings; `guard` refuses a total above the hold
(`QUICK_BUY_TOTAL_ABOVE_HOLD`); `after` flips `open → submitted` only when `expires_at <= now` (fenced) and writes
capture/release/unreserve/submit events; consent = the activation's acceptance rows copied onto the order. The
order is `order_kind='quick_buy'` and enters the normal workflow (stock RESERVED under the order, deducted at
confirmation like every order). Ten failed attempts, about a minute apart (a refused attempt leases the session for 45 s) → cancelled
`not_submitted`: hold and units released in one fenced batch, the customer told in three languages, no order, no admin step (DECISIONS row 188). The earlier claim
that admins are alerted was never true of the code and the admin retry/cancel routes are gone.

**After 00:00 the order is an ordinary order (owner brief §13).** From the moment the session is submitted, the
order is an ordinary `ORD-…` order with the same model, statuses, details page, tracking, cancellation, refund and
notifications as a cart order. `order_kind='quick_buy'` (and `quick_buy_session_id`) only label it for reports
and the optional badge «⚡ تم إنشاؤه بالشراء السريع»; nothing branches on them. A cancel goes through
`POST /api/orders/:id/cancel` and its normal refund and stock return; the session stays `submitted` as history
(tests/quickBuy.test.ts «§13»). The customer's bell notice says the order is now a regular order and links to it.
The Quick Buy card on «طلباتي» exists only while a session is open.

**Admin**: nothing of its own (owner, 2026-10-08, DECISIONS row 188 — the screen «الشراء السريع», its summary and
`/api/admin/quick-buy` are removed). A finalised Quick Buy order is an ordinary order everywhere the admin looks: the
board (no Quick Buy badge — only «🎁 هدية» remains), its counts, the Telegram announcement, the finance reports. Only
the reports keep `order_kind` («الأرباح والتكاليف» breaks orders down by kind; `/api/admin/orders?kind=` still
filters, with no button on the board).

**Wallet**: `iqd_held` counts a Quick Buy hold in the dinars the session agreed; `iqd_held_quick_buy` drives the
line «منها محجوز لطلب الشراء السريع» on the wallet page.

## 4. Reports
- Orders carry `order_kind`; finance workspace lists and filters it; the gift line is a 0 line with its cost.
- Quick Buy money: `quick_buy_events` (hold/release/capture deltas) + `wallet_holds` (ref_type `quick_buy`). Holds post nothing to the journal; capture becomes the ordinary `wallet-advance` entry; revenue stays at delivery.
- Customer wallet: an active Quick Buy hold shows as «محجوز لطلب شراء سريع»; the capture is the debit row «دفع طلب شراء سريع #…»; releases as «تحرير مبلغ محجوز».

## 5. Acceptance (brief §23) and races (§19)
Scripted end-to-end in `tests/quickBuy*.test.ts`, `tests/gift*.test.ts`, `tests/walletFreeDelivery.test.ts`: the two acceptance scenarios step by step, plus double-click, two devices, last-second edit vs expiry, expiry during remove, network retry (same key), sold out, price change, delivery fee change, address change, insufficient balance, release/refund, removing the last item, browser closed (cron), duplicate redeem/order via API.
