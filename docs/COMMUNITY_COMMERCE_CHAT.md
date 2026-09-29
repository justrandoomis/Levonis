# Levo Community as one journey: the commerce chat

Status: **design adopted 2026-09-29; all ten stages built** (the table in §8;
what is left for the owner in §9). Owner request, verbatim in spirit: complete Levo Community
as ONE experience between a customer and a merchant — conversation → product or
quote → acceptance → safe payment → order → work → delivery → confirmation or
dispute — **on top of the systems that already exist**. No second wallet, no
second escrow, no chat checkout, no new orders table, no parallel marketplace.

This document is the gap analysis (§1), the decisions (§2), the data model
(§3), the state machines (§4), the API (§5), the security invariants (§6) and
the test plan (§7). It is written from a read-only survey of the repository at
`0a80451c` (three independent passes: chat, money, products/community/
notifications) and a live diagnosis of Google sign-in.

---

## 0. ملخص بالعربية

- **الموجود ويُبنى عليه كما هو:** المحفظة (سجل إلحاقي + حجوزات + مفاتيح عدم التكرار)، سلة وطلبات المتاجر المدفوعة مسبقًا من المحفظة مع إعادة التسعير في الخادم، مسار الطلب ← العرض ← الضمان (حجز عند القبول، إفراج عند التأكيد، نزاعات وحسم إداري)، سجل التاجر ودفعاته، المحادثات (نص وصور وملفات وصوت) وصندوق وارد التاجر، الإشعارات بمفاتيح أحداث.
- **الناقص:** لا بطاقات في المحادثة إطلاقًا (عمود `kind` مقيّد بـ نص/صورة)، لا طلب موجّه لتاجر واحد، لا منتج خاص بزبون، لا رابط بين المحادثة والطلب، لا بطاقات نظام، التاجر لا يبدأ محادثة، لا معاينة قبل النشر.
- **القرار المالي:** بطاقة منتج أو منتج خاص ← **مسار طلب المتجر** (دفع مسبق من المحفظة، ويُحجز مستحق التاجر حتى الاستلام أو 3 أيام). عرض طباعة ← **مسار الطلب/العرض/الضمان** (حجز عند القبول، إفراج بعد التأكيد). تحويل عرض إلى منتج خاص يُبطل العرض في الدفعة نفسها — مسار مالي واحد لكل عملية.
- **البطاقة تحمل معرّفات فقط،** والخادم يبني اللقطة الأصلية (لا تتغير) والحالة الحالية (تُحسب عند القراءة). لا سعر ولا اسم ولا صورة من المتصفح.
- **Google:** النطاق الرئيسي يعمل؛ الخطأ الحي هو `origin_mismatch` على `www` لأن `www` يخدم التطبيق كاملًا. الإصلاح: تحويل `www` إلى النطاق الرئيسي.
- **الحالة:** نُفّذت المراحل العشر (§8) مع اختبارات هجوم لكل قاعدة صلاحية واختبار للرحلة كاملة بالأموال في كل خطوة. ما ينتظر قرار المالك في §9.

---

## 1. Gap analysis

Legend: **E** existing (build on it as is) · **P** partial · **M** missing ·
**R** needs refactor before it can carry the new flows.

### 1.1 Google sign-in (live diagnosis, 2026-09-29)

| Item | Status | Evidence |
|---|---|---|
| `GET /api/auth/capabilities` → `google: true`, `googleClientId = 552307303785-dn2m6k9gu78buusnnk97vl0cj8sejea8…` | E | live, apex and staging |
| Apex `https://levonis-iq.com/auth`: GIS button renders; clicking opens Google's «Sign in — to continue to levonis-iq.com» (`/o/oauth2/v2/auth` → `/v3/signin/identifier`) | E | headless Chromium through the session proxy |
| **`https://www.levonis-iq.com/auth` serves the whole app (200, no redirect)** and GIS logs `The given origin is not allowed for the given client ID` — **`origin_mismatch`** | **M (the live bug)** | same probe on `www` |
| Server verification: RS256 against Google JWKS, issuer, audience = `GOOGLE_CLIENT_ID`, expiry, `email_verified` | E — untouched | worker/lib/google.ts |
| Embedded in-app browsers (Instagram, Messenger, Telegram…) → Google's `disallowed_useragent` «تم حظر إمكانية الوصول» | E — the button is replaced by «افتح في المتصفح» | src/components/auth/InAppBrowserNotice.tsx |
| Scopes requested: `openid email profile` only (non-sensitive; no verification needed) | E | the auth URL GIS builds |
| OAuth consent screen: Testing vs In production, test users | owner console only | §2 D11 |

### 1.2 Chat

| Item | Status | Evidence |
|---|---|---|
| Threads: personal DM, store DM (`context 'store'`, one per store×customer), store-order thread, request thread (one per request×store) | E | chats.ts:339-538; 0124:110-112 |
| Messages: text, image, video, audio, file (magic-byte sniffing, size caps, membership before storing) | E | chats.ts:676-791; uploads.ts:215-256, 520-527 |
| Merchant inbox with filters, search, cursor | E | merchantInbox.ts |
| Staff read of store-order threads: read-only and audited | E | chats.ts:87-118, 639-646 |
| **Typed messages at the DB level** — `kind CHECK (text,image)`; the project rule is to add a nullable column with its own CHECK, never to rebuild | **R** | 0001:306; 0110:21-31 |
| **Cards** (product, custom product, print request, quote, order, store) | **M** — the plus menu sends plain text; «المتجر» even links the platform catalogue | Chat.tsx:412-430 |
| **System cards** (order created/paid/…) | **M** — the server never writes a message; `sender_id` is NOT NULL → users | 0001:305 |
| Store identity in the thread (header shows the seller's personal name) | P | chats.ts:238-266; Chat.tsx:215-231 |
| Merchant starts a thread with a customer | M | only customer/order/request opens |
| Idempotent send (a retried send duplicates) | M | chats.ts:676-791 |
| `{userId}` DM reuse ignores `context_type` (can return a store/request thread) | R (bug) | chats.ts:521-528 |
| `chats.community_order_id`, `community_orders.chat_id` | P — columns exist, never written | 0031:111, 304 |
| Attachment serving: key visible as `/files/<key>`, any admin can fetch any chat file (audited only for order threads) | R | uploads.ts:700-721 |

### 1.3 Money

| Item | Status | Evidence |
|---|---|---|
| Wallet: append-only ledger (USD cents + dinar display), holds `active→committed/released`, spend guard `available = settled − held`, guarded inserts, fences, idempotent keys | E | walletOps.ts |
| Store checkout: one seller per cart, server repricing (variants, coupon), governorate delivery, stock fences, self-purchase refusal, fingerprint `QUOTE_CHANGED`, per-user idempotency key, hold → one batch | E | cart.ts:2251-2391; storeOrders.ts:255-1184 |
| Store order lifecycle pending→confirmed→processing→shipped→delivered; merchant credit PENDING until receipt or 3 days; cancel = refund+restock+ledger reversal in one batch | E | merchant.ts:1126-1278; storeOrderOps.ts |
| Escrow: request (customer-owned) + offer (merchant) → accept = hold + ONE fenced batch → funded order → start → delivered → confirm/auto-complete → release; disputes frozen, admin resolves; suspension keeps money held | E | marketplace.ts:1454-2109; escrowOps.ts; communityRequests.ts |
| Offer revisions, `OFFER_CHANGED` (expected price + revision), `OFFER_STALE`, one live offer per merchant per request | E | marketplace.ts:1364-1416; 0031:85-87 |
| **A request aimed at ONE merchant** — `visibility='private'` can take no offer at all; eligibility conflates "on the board" with "may quote" | **M / R** | marketplace.ts:921, 960; printMatchingStore.ts:138-146 |
| Accept replay after success answers `409 OFFER_NOT_AVAILABLE` (safe, not idempotent) | P | marketplace.ts:1454 |
| `POST /orders/:id/delivered` answers 200 when its UPDATE matched nothing | R (bug) | marketplace.ts:1813-1822 |
| Request transition table vs the SQL acceptance writes | R (drift) | communityStates.ts:36-54 |
| Link from an order/offer to the conversation it came from | M | — |

### 1.4 Products

| Item | Status | Evidence |
|---|---|---|
| Draft / published / hidden / archived; mirror triggers keep `lifecycle`/`status`; variants, options, media, SKU, stock, prep days, print attributes; ownership in every WHERE + DB triggers | E | 0126; merchantCatalog.ts |
| Publish checks: not admin-hidden, a price > 0, a variant product has an active variant | E | product.ts:708-718 |
| **Preview before publish** | **M** | ProductEditorSheet.tsx |
| **A product visible to ONE customer** | **M** | no audience concept; ~15 public readers check `status='active'` |
| Copy link / send in chat from the workspace | M | CatalogManager.tsx:271-288 |

### 1.5 Community hub, workspace, notifications

| Item | Status |
|---|---|
| Hub: products, stores (directory cards), requests, works rail, follows, reviews, saved items, store pages, requests page with offers and custom orders | E |
| Workspace: Command Center attention sources, inbox, requests section, custom orders, store orders | E |
| Workspace: quotes list, custom products, chat-originated orders, "waiting for the customer" custom orders, disputes in needs-action | M / P |
| Notifications: `user_notifications` with event keys, merchant kinds + preferences, outbox channels, one chat notice per turn | E |
| Product card sent · custom product created · payment completed (customer) · store order «processing» · customer confirmed | M |
| Personal DMs notify nobody; follow switches stored but never read; no web push | P / M |

---

## 2. Decisions

**D1 — The store conversation is the commerce thread.** The existing store DM
(`context_type='store'`, one per store × customer) carries every card. Order
threads and request threads stay as they are for work that did not start in a
chat; nothing is merged or migrated.

**D2 — A card is a message, added, not rebuilt.** New nullable columns on
`chat_messages` (§3.1). The client sends `{type, ref}` and nothing else; the
server checks that the entity belongs to THIS thread's store and customer,
builds the **original snapshot** (frozen at send) and, on every read, the
**current state** for the reader. `kind` stays `text` for a card and `body`
carries a short plain fallback (the entity's own name), so an older client, the
inbox preview and search keep working.

**D3 — Two financial flows, never both for one deal.**

| Card | Flow | When the customer pays | When the merchant is credited |
|---|---|---|---|
| `product_card` (a published product of this store) | **Store order** (cart → quote → place) | at placement, from the wallet | pending → available on receipt or 3 days after delivery |
| `custom_product_card` (a private product for this customer) | **Store order** | same | same |
| `quote_card` (a print quote) | **Request → offer → escrow** | a **hold** at acceptance; debited at release | available at release (confirm / auto-complete / admin) |

A quote turned into a custom product is **superseded in the same batch** that
creates the product; a quote already accepted cannot become a product
(`QUOTE_ALREADY_ACCEPTED`). A custom product already bought cannot be edited or
cancelled (`CUSTOM_PRODUCT_LOCKED`).

**D4 — Direct requests reuse `community_requests`.** `visibility='direct'`
(the column has no CHECK), `target_merchant_id`, `origin_chat_id`. A direct
request is never on the board, never matched or announced to other workshops,
and only its customer and its target merchant can read it or its files. The
authority for quoting it is **direct**: the target merchant takes new work
(`merchantTakesNewWork`), the request is open and not expired, the merchant is
not the customer. Printer/material matching (the board's `liveVerdict`) does not
apply; acceptance branches on the same rule.

**D5 — A merchant may quote without a customer request.** The quote composer
then creates the direct request **owned by the customer of the thread** from
what the merchant wrote. Nothing is charged, nothing is visible to anyone else,
and the customer's acceptance (which the existing route already requires to be
the request's owner) is the consent. Rate-limited.

**D6 — Private custom products.** `community_products.audience_user_id`
(+ `origin_chat_id`, `origin_offer_id`, `custom_expires_at`). The mirror
triggers compute `status='hidden'` whenever an audience is set, so every public
reader — storefront, feed, search, sitemap, public API, favourites, social
cards — excludes it with no change of its own. Buyable only when published, not
admin-hidden, not expired, and the buyer IS the audience; one unit
(`track_stock=1, stock=1`). Created and cancelled only by the store owner, only
for the customer of one of its store threads. Immutable after creation: a change
is a cancel and a new card, so a card can never say one price and charge
another.

**D7 — The agreement is never rewritten.** `card_snapshot` is written once.
The card shows the snapshot AND the current state (price now, stock, quote
state, order stage). A price that moved since the card was sent is shown as
moved; checkout reprices on the server and answers `QUOTE_CHANGED` as it always
did.

**D8 — System cards.** Server-written into the originating thread with
`is_system=1`, the actor as sender, and an idempotent `card_event_key` per event
(`order:<id>:placed`, `custom_order:<id>:funded`, …), after the money batch has
committed; failure to post never fails the money.

**D9 — The community gate.** Creating a print request or a quote in a chat is
Levo Community custom work and follows the same maintenance gate as the board's
create doors (today the live community is closed). Accepting, and every order
transition after it, stays open, as today. Product cards and custom products are
store commerce and are not gated (the store checkout is not). *Owner question:
whether chat quotes should work while the public community is closed.*

**D10 — Notifications ride the existing kinds.** A card is a message: the
existing one-notice-per-turn chat notification carries it, worded for the card
— except a card that waits on the other side's decision (a print request for
the store; a quote, an updated quote or a private product for the customer),
which is its own notice even mid-turn, once per card. Money events use the
order/offer kinds; the in-thread system card does not send a second notice.

**D11 — One sign-in origin.** A visit to `www.` moves to the apex (in the SPA
boot, and with a 301 from the Worker for the documents it serves first).
Owner console: Authorized JavaScript origins = the apex and staging only, no
paths, no wildcards, no store subdomains, no redirect URIs; consent screen «In
production» (or the tester listed while «Testing»).

---

## 3. Data model (additive migrations only)

### 3.1 `chat_messages` (0150)
```
card_type      TEXT CHECK (card_type IS NULL OR card_type IN
                 ('product','custom_product','print_request','quote','order','custom_order','store'))
card_ref       TEXT            -- the entity id; never a price, name or picture
card_snapshot  TEXT            -- JSON, written once by the server
card_event_key TEXT            -- idempotency of system cards: UNIQUE (chat_id, card_event_key)
is_system      INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1))
client_id      TEXT            -- idempotent send: UNIQUE (chat_id, sender_id, client_id)
```
API kinds: `text · image · video · audio · file · product_card ·
custom_product_card · print_request_card · quote_card · order_card
(order and custom_order) · store_card`.

### 3.2 Direct requests (0151)
`community_requests.target_merchant_id`, `origin_chat_id`, `created_by`
('customer' | 'merchant'); `visibility` gains the value `direct`.
`community_orders.chat_id` (exists) is written at acceptance.

### 3.3 Private custom products (0152)
`community_products.audience_user_id`, `origin_chat_id`, `origin_offer_id`,
`custom_expires_at`; the mirror triggers recreated with the audience in the
`status` rule. `cart_items.origin_chat_id` and `orders.origin_chat_id` link a
purchase to the thread it came from.

Every new column is registered where the repository requires it: media
references (`worker/lib/mediaRefs.ts`, snapshots hold `/files/…` paths),
product deletion (`worker/lib/productDeletion.ts`), table ownership
(`packages/contracts/src/ownership.ts`) and the schema version
(`worker/lib/schemaVersion.ts`). Every reader degrades when the Worker ships
before its migration (`isSchemaMissing`).

---

## 4. State machines

### 4.1 Quote card (a `community_offers` row on a direct request)
```
            merchant edits (new revision)            customer accepts (hold + batch)
 pending ───────────────────────────────▶ pending ─────────────────────────────▶ accepted ─▶ (order card)
   │  ▲                                        │
   │  └── merchant re-confirms ◀── superseded ◀┘ customer changed the job / custom product made from it
   ├── merchant withdraws ─────────────▶ cancelled (withdrawn)
   ├── expires_at passes (sweep) ───────▶ expired
   └── customer declines ──────────────▶ declined (rejected)
```
Accept requires `expected_price_iqd` and `offer_revision` equal to what the card
showed (`OFFER_CHANGED` otherwise). A replay by the same customer after success
answers the existing order (idempotent), never a second hold.

### 4.2 Custom product card
```
available ──(purchase: store order placed)──▶ purchased
    │
    ├──(merchant cancels)────────────────────▶ cancelled
    └──(custom_expires_at passes)────────────▶ expired
```
`available` = published ∧ not admin-hidden ∧ stock > 0 ∧ not expired.

### 4.3 Order cards (current state read from the order; system cards mark each move)
- Store order: `paid(pending) → confirmed → processing → shipped → delivered →
  completed (receipt / 3 days)`; `cancelled` (refunded); a support ticket freezes
  the merchant's credit.
- Custom order: `funded → in_progress → merchant_marked_delivered → completed`;
  `disputed → (admin) completed | refunded`; `cancelled` (refunded).

### 4.4 Direct request
`draft → open → receiving_offers → in_progress (accepted) → completed |
cancelled | disputed | expired` — the existing request machine; never on the
board.

---

## 5. API surface (new doors; everything else is the existing routes)

| Method + path | Who | What |
|---|---|---|
| `GET /api/chats/:id` | participants | thread identity: store (name, logo, slug), viewer role, what the viewer may send |
| `POST /api/chats/:id/messages` `{card:{type,ref}, client_id?}` | participants (per type) | send a card; the server validates and snapshots |
| `GET /api/chats/:id/products?q=&cursor=` | participants | the THREAD's store's public published products, with price range and stock |
| `POST /api/chats/:id/print-requests` → files → `…/:rid/send` | the customer | a direct request to this store + its card |
| `POST /api/chats/:id/quotes`, `PATCH …/quotes/:offerId` | the store owner | a quote (and its direct request when none) + card; edits are new revisions |
| `POST /api/chats/:id/custom-products`, `…/:pid/cancel` | the store owner | a private product for this thread's customer + card |
| `GET /api/chats/:id/orders` | participants | this store × this customer's orders, both flows |
| `POST /api/cart/merchant-items` `+origin_chat_id` | the customer | unchanged checks + the thread link |
| `POST /api/marketplace/offers/:id/accept` | the request's customer | unchanged; direct standing; idempotent replay |

---

## 6. Security invariants (each one an attack test, §7)

1. A card's entity belongs to the thread's store (products, custom products,
   quotes) and to the thread's customer (custom products, requests, orders).
   Forged or foreign ids → `CARD_NOT_IN_THREAD`.
2. Only the store owner sends quotes and custom products; only the customer
   sends print requests; either may send product and store cards.
3. No price, name, picture, total, fee, delivery charge or balance is ever read
   from the client: cart and checkout reprice; acceptance compares the price
   and revision the customer saw with the row.
4. A private product is invisible to every public reader and unbuyable by anyone
   but its audience; its owner cannot buy it (`OWN_STORE_PURCHASE`).
5. One deal, one flow: superseding and locking are statements in the money
   batches, not checks before them.
6. Replays are harmless: accept (existing order returned), checkout
   (per-user key), holds (event keys), system cards (event keys), sends,
   quotes, quote edits and private products (`client_id` on the card's
   message: the unique index aborts the whole batch the second time).
7. Merchants never see another merchant's direct request, quote or custom
   product; the customer's contact reaches the merchant only through the
   existing acceptance snapshot.
8. Attachments keep the existing intake (sniffed bytes, chat-scoped keys,
   membership before storing); request files keep the existing
   never-hand-out-the-key route.

---

## 7. Test plan

Unit/route tests on a real D1 (`tests/fixtures/app`), one file per stage, and
the owner's list as attack tests: product of another store in this thread ·
merchant sends a product it does not own · price changed after the card ·
price changed during checkout · same custom product bought twice · another
user buys a private product · another merchant opens a custom product · accept
replay · wallet payment replay · accept vs edit race · insufficient funds ·
double spend · stock race · chat access spoofing · forged attachment ·
refund/dispute race · merchant suspended during settlement. The whole journey
(chat → card → accept/pay → order → start → deliver → confirm/dispute) runs
through the real routes end to end, and the chat screens run in the browser
fixture.

---

## 8. Stages

| # | Stage | Status |
|---|---|---|
| 1 | Google sign-in: `www` → apex | done — `tests/canonicalHost.test.ts`; owner console checks in docs/GOOGLE_SIGNIN_FIX.md §8 |
| 2 | Structured chat messages | done — 0150, worker/lib/chatCards.ts, `GET /api/chats/:id`, idempotent `client_id`; tests/chatCards.test.ts |
| 3 | Product and store cards | done — picker, cards with frozen snapshot + current state, add to cart through the store cart |
| 4 | Print requests and quotes (escrow) | done — 0151, worker/routes/chatCommerce.ts, direct standing, idempotent accept replay, order ↔ thread link; tests/chatQuotes.test.ts |
| 5 | Private custom products (store flow) | done — 0152, worker/lib/privateProducts.ts, cart/checkout audience rule, immutability trigger, quote → product in one batch, order ↔ thread; tests/chatPrivateProducts.test.ts |
| 6 | System cards on every money move; `/delivered` fix | done — `announceCustomOrder` / `announceStoreOrder` at every door (store, customer, admin, the 3-day sweep); «تم التسليم» that matched nothing is `ORDER_CHANGED`; the request state table says what acceptance writes; tests/chatSystemCards.test.ts |
| 7 | Merchant/customer UX | done — cards, the «+» menu per side (the deal first), quote / print request / private product / orders sheets, one order card under its newest event, each side's quick replies, «ابدأ من منتج في متجرك», «نسخ الرابط» in the catalog; browser fixture tests/browser/commerce-chat.html. **Not done:** the owner's preview of a draft product page (§9) |
| 8 | Notifications | done — a card that waits on the other side (print request → store; quote, updated quote, private product → customer) is one notice whoever spoke last, worded for it; every other line keeps the turn rule; money events add no chat notice; tests/chatNotifications.test.ts |
| 9 | Attack tests | done — tests/chatAttacks.test.ts (the owner's §8/§17 list; found and closed: a retried quote / quote edit / private product made two — each now carries the sheet's `client_id`) |
| 10 | End-to-end journey | done — tests/chatJourney.test.ts: custom work through escrow, ready goods + a private product through one checkout, a dispute refunded — with the wallet, the escrow and the store's ledger checked at every step |

## 9. Open for the owner

1. **D9 — chat quotes while the public community is closed.** Today the chat's
   print-request and quote doors follow the community's maintenance switch
   (the live community is closed), so on the live site a store can send product
   cards and private products, but not quotes, until the community opens.
2. **Staff and pre-order conversations.** Staff read a store's ORDER threads
   (read-only, every read audited). A store conversation before any order —
   where a quote was negotiated — is not readable by staff at all. When such a
   deal is disputed, the escrow decision is made from the frozen offer, the
   order and the complaint, without the messages. Opening it to staff (read-only,
   audited, only for a thread that has a disputed order) is one rule in
   `worker/routes/chats.ts` if wanted.
3. **Preview before publish.** The product editor has draft → publish; a
   preview of the draft product page needs the storefront product page to
   render an owner-only draft, and the storefront pages sit at 46.9 of their
   47 KB budget (tests/bundleBudget.test.ts). It needs either that budget
   re-cut or the preview drawn inside the workspace.
4. **Sorani.** Every new sentence carries the Arabic in the `ckb` slot under an
   `OWNER: Sorani to be written by hand` comment; none was generated.
