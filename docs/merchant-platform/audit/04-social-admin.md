# 04 — Social & Admin audit: chats, merchant inbox, reviews/reputation, verification & PRO, notifications, analytics, admin community

Repo: `/home/user/Levonis` @ `234f5e3` (working tree clean; nothing in the repo was modified).
Method: read every server route/lib and UI file in scope; ran the existing suites; wrote 12 throw-away
probes against the real migrations + real route handlers (outside the repo:
`scratchpad/merchant-audit/verify.test.ts`, run with
`NODE_PATH=/home/user/Levonis/node_modules node --import tsx --test <file>` from the repo root).

**Existing tests run (all green, 178 tests):** chatAttachments 15/15, chatPresence 4/4, chatPresenceRoutes 5/5,
reviews 5/5 (platform-review name masking only), adminCommunity 17/17, membershipsVerifiedBadge 4/4,
communityGate 35/35, customerNotify 31/31, escrow 21/21, storefrontIsolation 15/15, store-isolation 6/6, merchantOps 16/16.
**Untested today:** chat list/open/read authorisation, message paging, merchant analytics correctness, store-review
creation/eligibility, admin escrow resolve, admin payout, any merchant-facing notification.

**Probes (all 12 confirmed the defect):** B1 payout double-pay · B2 sanction clobber · B3 resolve replay double reputation +
request stuck `disputed` · B4 remove a disputed request · B5 chat shows oldest 500 · B6 admin silently joins a merchant thread ·
B7 analytics count cancelled orders · B8 review images unvalidated / edit leaves reputation stale · B9 confirm race double-count ·
B10 customer's merchant-order message reaches nobody · B11 merchant reviews own store · B12 accept retry strands the request.

---

## 1. Data model (what exists, where, and whether anything uses it)

### 1.1 Conversations
| Table / column | Defined | Used by | Notes |
|---|---|---|---|
| `chats(id, created_at)` | `migrations/0001_init.sql:289-292` | `worker/routes/chats.ts` | |
| `chats.order_id` + partial UNIQUE `idx_chats_order` | `0026_order_fulfilment.sql:33,37` | `chats.ts:115,133,169`; `adminChats.ts:73` | one thread per `orders` row |
| `chats.context_type/context_id/merchant_id/store_id/community_order_id` + 2 indexes | `0031_community_v2_marketplace.sql:299-306` | **nothing** (grep: zero reads/writes) | dead — the designed "store / product / request / offer / community_order / merchant_order" context |
| `chat_participants(chat_id, user_id, last_read_at)` PK(chat,user) | `0001:294-300` | `chats.ts`, `uploads.ts:463-468,655-660` | no `role`, no store scope, no mute/archive |
| `chat_messages(id, chat_id, sender_id, kind CHECK text/image, body, file_key, created_at)` idx(chat,created_at) | `0001:302-311` | `chats.ts` | no edit/delete/system/seq/client-id |
| `chat_messages.attachment_kind CHECK image/video/audio/file` | `0110_chat_attachment_kind.sql:47-48` | `chats.ts:238-253,339-353` | |
| `chat_typing_presence(chat_id,user_id,expires_at_ms)` FK→participants | `0071_chat_typing_presence.sql:4-11` | `worker/lib/chatPresence.ts:4-18` | 7 s server TTL |
| `community_orders.chat_id` | `0031:111` | **nothing** | custom orders have no thread |

### 1.2 Reviews, reputation, verification, PRO
| Table / column | Defined | Notes |
|---|---|---|
| `community_merchants.verified` (admin flag) | `0001:247-255` (`verified` at 253) | set only by `POST /api/admin/community/merchants/:id/verify` |
| `community_merchants.status/status_reason/status_changed_at, badge, badge_override, reputation_score, rating_avg_x100, rating_count, completed_orders, governorate, phone` | `0030_community_v2_core.sql:43-59` | `reputation_score` is **never written** (grep); `worker/lib/merchantReputation.ts` named at `0030:51` does not exist |
| `merchant_reviews` (1 per `order_id` / per `community_order_id`, rating 1-5, body, images JSON, merchant_reply, hidden, edited_count) | `0031:210-232` | unique partial indexes `0031:229-232` |
| `merchant_reputation_events(kind, points, order_id, community_order_id, review_id, note)` append-only | `0031:238-253` | kinds listed in comment only (no CHECK) |
| PRO badge = membership entitlement `proMerchantBadge: 'pro'` | `worker/lib/entitlements.ts:109,132-141,478` | gated by `restriction_cases.benefit_flags` (`0003_final_phase.sql:400`); legacy flag alias `verifiedMerchant` at `entitlements.ts:138`; compat accessor `benefits.verifiedMerchant` = PRO at `entitlements.ts:477` (unused) |
| KYC (PRO identity) | `worker/routes/kyc.ts` | not linked to merchant verification at all |

### 1.3 Disputes / money (admin-community scope)
| Table | Defined |
|---|---|
| `community_complaints` (reporter, reported user, merchant, store, order/community order/offer/product, category, status, priority, assigned_admin, resolution) | `0031:256-281` |
| `community_complaint_messages` (sender_role user/merchant/admin, body, file_key, `internal`) | `0031:283-294` |
| `community_escrows` / `community_escrow_events` (append-only, idempotency_key UNIQUE) | `0031:144-182` |
| `merchant_payout_ledger` (kind, signed amount, state pending/available/reserved/paid/reversed, idempotency_key UNIQUE) | `0031:187-204` |
| community settings seeds (`communityFee*`, `communityAutoCompleteDays`, `communityRequestExpiryDays`, `communityOfferMaxPerRequest`) | `0030:284-290`; gate row `communityGate` (`worker/lib/communityGate.ts:47,67-98`) |

### 1.4 Notifications
| Table | Defined | Notes |
|---|---|---|
| `user_notifications(user_id, kind, title_ar/en, body_ar/en, link PATH, entity_type, entity_id, meta, event_key, read_at)` UNIQUE(user,event_key) | `0045_print_requests.sql:36-69` | per USER — no store/audience scope; no ckb columns (ckb rides in `meta`, which the API never returns) |
| `user_notification_channels(user, channel inapp/telegram/whatsapp/email, enabled, is_primary)` | `0092_stock_alerts.sql:168-175` | customer channel choice |
| `outbox` / `outbox_v2` (email, telegram, whatsapp) | `0003:81`, `0086_outbox_whatsapp.sql:34` | durable outbound |
| `merchant_notification_preferences` (9 switches) | `0030:142-154` | only `request_opportunities` is ever read (`printRequests.ts:986`, `printMatching.ts:296`) |

### 1.5 Analytics sources
| Source | Defined | Written by | Status |
|---|---|---|---|
| `community_products.view_count` | `0030:174` | `storefront.ts:303-310` (+1 per product-detail GET) | live, unfiltered |
| `community_products.sold_count` | `0030:173` | `storeOrders.ts:498-502` (+qty at placement) | live, never decremented |
| `orders` (merchant_id, status, totals, fee, receivable, coupon_code/discount, address_snapshot→governorate) | `0001:139-160`, `0030:240-254` | checkout | live, real |
| `order_items.community_product_id/qty/line_total_iqd` | `0030:256` | `storeOrders.ts` | live, real |
| `community_offers`, `community_orders`, `community_request_matches`, `merchant_request_prefs` | `0031:61-138`, `0045:122,205` | marketplace / print requests | live, real |
| `follows(created_at)` | `0001:282-287`, `0031:311-314` | follow routes | live, real |
| `merchant_coupons(used_count, ends_at)` | `0036_store_builder.sql:88-106` | coupons | live, real |
| `merchant_store_analytics_daily` (store_views, product_views, offers, followers…) | `0030:262-278` | **nothing** | dead table |
| Event bus `ProductViewed/AddToCart/CheckoutStarted/OrderCreated` | `worker/routes/products.ts:3345-3366`, `cart.ts:1742-1766`, `orders.ts:3899,4469` | platform products only | **off in production**: `EVENT_BUS_ENABLED` only set for `env.dark` (`wrangler.jsonc:346`) |
| `services/analytics` (analytics_events + daily rollups, merchant daily RPC) | `services/analytics/*` | — | "Nothing here is deployed" (`services/analytics/README.md`) |

---

## 2. Chats

### 2.1 Participant model
* Flat user↔chat membership; no roles. Three ways in (`POST /api/chats/open`, `chats.ts:93-183`):
  1. **Order thread** `{orderId}` (`orders` table only). Allowed for the order owner, any `role='admin'`, or the store owner when
     `orders.merchant_id` is set (`chats.ts:100-113`). Creation inserts the ORDER OWNER plus the opener (`chats.ts:131-143`);
     an admin/seller opening an existing thread is `INSERT OR IGNORE`-joined (`chats.ts:118-129`).
  2. **Store DM** `{merchantId}` → resolves `community_merchants.user_id` (`chats.ts:150-157`) → becomes a plain general DM
     between two ACCOUNTS; no store context is stored.
  3. **General DM** `{userId}` — any authenticated user may open a DM with any user id (`chats.ts:158-182`); reuse only of the
     pair's non-order thread (`chats.ts:166-174`). The legacy store page gets the id from the public payload
     (`community.ts:34` `user_id`; `src/pages/MerchantStore.tsx:94`).
* No request/offer threads and no custom-order (community order) threads exist anywhere (`Requests.tsx` has no chat;
  `community_orders.chat_id` never written; `/open {orderId}` only looks in `orders`, `chats.ts:100-107`).

### 2.2 Authorisation (verified)
| Operation | Check | Cite |
|---|---|---|
| read thread | `assertParticipant` | `chats.ts:19-25,258` |
| send | participant + `chat-send` 200/h | `chats.ts:276-279` |
| typing get/set | participant (+90/min) | `chats.ts:187-204` |
| attachment upload | participant BEFORE bytes stored; key `chat/<chatId>/…` | `uploads.ts:460-469` |
| attachment reference on send | key must start `chat/${chatId}/` and exist in R2 | `chats.ts:313-315` |
| attachment download | participant, **or any admin** | `uploads.ts:642-660` (`if (!row && user.role !== 'admin')`) |
| list | own participations only | `chats.ts:58-59` |

**Merchant isolation holds:** a merchant can only enter a thread they are a participant of, or an order thread for an order
of their own store (`isSeller`, `chats.ts:112`). Probe B6: a stranger gets 403 on read and on `/open` for someone else's order.

**Two staff exceptions contradict the stated policy** ("no moderator backdoor", `chats.ts:11-15`; "a merchant-store order's thread
with its seller stay the business of their participants", `adminChats.ts:21-25`):
* any admin can join ANY order thread including merchant-store orders (`chats.ts:108,122-127`); the admin order modal's Chat tab
  does it silently for merchant orders too (`src/components/adminOrders/OrderDetailModal.tsx:183-184` → `OrderChatPanel.tsx:98`).
  Probe B6: participants became `[boss, buyer, owner]` and the admin read the thread. Participants are not told.
* any admin can fetch any chat file by key (`uploads.ts:660`).

### 2.3 Attachments
Image (camera/album), video (MP4/WebM), audio (voice notes: WebM/Ogg/MP3/MP4-AAC) and PDF files. Kind is decided by the
folder the upload route sniffed the bytes into, never by the client (`chats.ts:206-230`, `uploads.ts:239,293`).
Legacy-safe dual storage (`kind` text/image + `attachment_kind`, `0110`). Delivered via `/files/chat/…` behind the
membership check. Well tested (`tests/chatAttachments.test.ts`, 15 tests). Gaps: one attachment per message, no
filename/size/duration metadata stored, "files" = PDF only, no caption+attachment pairing in the list preview.

### 2.4 Unread tracking
Per participant `last_read_at` (`0001:297`). Unread = messages from others newer than it (`chats.ts:51-53`). The messages GET
stamps it on every call (`chats.ts:264-268`) — i.e. every 5-second poll is a D1 write. Team unread for the shop desk is a
separate SQL (`adminChats.ts:65-71`). No per-store unread, no dedicated unread-count endpoint: `BottomNav.tsx:119-137` pulls the
whole chat list (5 correlated sub-queries per chat, `chats.ts:45-57`) on every route change to sum a badge.

### 2.5 How order / request / store chats are linked
* Store orders: `chats.order_id` (unique). **The seller is not auto-added**: if the customer opens first (the customer order page
  offers «محادثة مباشرة مع الفريق» for every order, `SupportActions.tsx:81-87`, `OrderDetail.tsx:752`) the thread has one
  participant; the admin desk excludes merchant orders (`adminChats.ts:78`) and the announce hook returns for them
  (`adminChats.ts:218`). Probe B10: participants `[buyer]`, merchant's list empty, 0 notifications — the message reaches nobody
  until the merchant happens to press "Chat about this order" (`SalesTabs.tsx:195-207`).
* Store chats: plain account-to-account DM; the chat never records store, product, request or offer.
* Request/offer/custom-order chats: none.

### 2.6 Merchant inbox today
None. The workspace (`src/pages/MerchantDashboardPage.tsx:112-134`) has no Messages tab; Overview links out to the
consumer `/chats` page (`MerchantDashboardPage.tsx:344`). That list mixes the merchant's personal purchases chats with store chats,
labels each row with the other ACCOUNT's personal name (`chats.ts:54-57`, LIMIT 1 without ORDER BY for 3-party threads), has
client-side search over the first 100 threads by name/last line only (`Chats.tsx:301-306`), no filters (order / request / store),
and no order context on rows. On a storefront host the order-chat button hard-codes `https://levonis-iq.com/chat/…`
(`SalesTabs.tsx:201`).

### 2.7 Mobile UX state (`src/pages/Chat.tsx`)
* Layout: full-screen shell `h-[100dvh] … overflow-hidden` (`App.tsx:538`), flex column, messages `overflow-y-auto
  overscroll-contain` (`Chat.tsx:462`), composer `shrink-0` with safe-area padding (`Chat.tsx:512`). Viewport meta has no
  `interactive-widget` (`index.html:42`) and the page has no `visualViewport` handling → keyboard behaviour is the browser's default
  pan (header can scroll away; composer can sit under the iOS keyboard).
* Scroll: `messagesEndRef.scrollIntoView({behavior:'smooth'})` on every count change (`Chat.tsx:93-99`) — yanks a reader who
  scrolled up, and walks ancestor scrollers; the repo already documents why this is wrong and ships the fix
  (`src/lib/supportThread.ts:67-121` `useThreadScroll`, used by the admin panels, not by Chat.tsx).
* Data: full-thread poll every 5 s (`Chat.tsx:124-139`) returning **the oldest 500** messages (`chats.ts:260`; probe B5: 510
  messages → last shown `msg 499`); no paging/"load earlier"; header name found by downloading the whole chat list
  (`Chat.tsx:144-160`); typing poll every 2 s (`useChatPresence.ts:64`).
* Composer: single-line `<input type="text">`, Enter sends (`Chat.tsx:597-601`); no multi-line, no link detection (shared
  location is plain text), no read receipts, no day separators (time only), failed attachment sends are dropped.
* Good: 44 px targets, optimistic bubbles, voice recorder, emoji/attach panels capped at `28dvh`/`42dvh`, RTL-aware.

---

## 3. Reviews & reputation

### 3.1 Model
Store/custom-order reviews: `merchant_reviews` (§1.2). Platform product reviews (`worker/routes/reviews.ts`) are a separate,
richer system (media upload pipeline, moderation queue, quality workflow, masked names) with no merchant linkage.

### 3.2 Who may review
`POST /api/community-reviews` (`merchantReviews.ts:111-201`): a store order owned by the caller with `status='delivered'` and
`merchant_id` set, or a community order owned by the caller with `state='completed'` (`merchantReviews.ts:127-145`); merchant/store
taken from the row, one per transaction by unique index (`161-165`). `GET /eligible` lists candidates (`79-101`).
* **No UI anywhere calls either endpoint** (grep of `src/` for `community-reviews` finds only follow calls in `Storefront.tsx`),
  so customers cannot actually leave a store or custom-order review today; `review_available: true` from confirm
  (`marketplace.ts:964`) is never consumed.
* **No self-review guard**: the reviewer is never compared with the merchant owner, the store cart has no self-purchase guard
  (`cart.ts:2136-2156`, `storeOrders.ts` refusals at 149/188/362/398/433/437 only), and the merchant sets their own store order to
  `delivered` (`merchant.ts:1331-1438`). Probe B11: owner reviewed own store → 201, rating 5.00, +10 reputation.
* Edit window 24 h (`merchantReviews.ts:211-235`); edit recomputes rating but not the `review_received` points (probe B8: 5★→1★
  kept `+10`).
* `images`: any 6 strings, unbounded length, no media-key validation (`merchantReviews.ts:158`; probe B8 stored a 200 KB string, an
  external tracking URL and `javascript:`). Not rendered anywhere yet → latent.
* Public store reviews expose the reviewer's full `users.name` (`storefront.ts:325,361`) while platform reviews always mask it
  (`reviews.ts:168-175,870`; mandate §5 pinned by `tests/reviews.test.ts`).

### 3.3 Merchant replies
Once, 1-1500 chars, conditional UPDATE `merchant_reply = ''` scoped to `merchant_id` (`merchant.ts:1489-1504`); no edit, no
customer notification, no admin moderation of the reply text (admin can only hide the whole review).

### 3.4 Rating aggregation
`refreshMerchantRating` recomputes AVG/COUNT over non-hidden rows and re-derives the badge (`merchantReviews.ts:39-71`);
storefront distribution is computed live (`storefront.ts:333-345`). Called on review create/edit, admin hide, verify, badge override
only (`adminCommunity.ts:359,410,486`) — **not** when `completed_orders` changes (`merchant.ts:1384`, `marketplace.ts:959`), so an
earned badge lags until the next review event.

### 3.5 Reputation events
Writers: store order delivered `order_completed +10` (fenced, `merchant.ts:1368-1395`); community confirm `order_completed +10`
(unfenced, `marketplace.ts:945-962`); review `(rating-3)*5` (`merchantReviews.ts:167-170`); admin `admin_adjustment ±500`
(`adminCommunity.ts:750-778`); escrow resolve `dispute_won 0 / dispute_lost -20` (`adminCommunity.ts:1034-1043`).
**Effects: none outside the admin panel.** `reputation_score` is never computed; `badgeFor` uses completed orders + rating +
verified only (`merchantOps.ts:196-210`); the matcher uses rating/completed orders with `trouble_rate: 0`, `pro: false`,
`response_minutes: null` hard-coded (`printRequests.ts:1067-1069`). So disputes, admin corrections and review points change nothing
a customer or the matcher sees.

### 3.6 Dispute effects
Opening a dispute (either party) freezes escrow and writes a complaint (`marketplace.ts:971-1049`); **no** reputation event on open
(`dispute_opened` kind unused); admin resolution writes `dispute_won/lost` (above). The merchant cannot see or answer a dispute
raised against them: complaint read/reply is reporter-only (`marketplace.ts:1163-1177,1194-1210`), there is no merchant route
(`merchant.ts` has none) even though the header promises the merchant "keeps every read — … disputes" (`merchant.ts:11`) and the
admin can set `waiting_merchant`.

### 3.7 Verification vs PRO badge — separation is real, with four conflation seams
**Separated correctly:** DB (`verified` admin flag vs membership entitlement), API (`verified` and `pro_badge` returned side by side:
`storefront.ts:76-77`, `community.ts:38-39`, `marketplace.ts:533`), UI (sky/gold `BadgeCheck` vs red-gold `ProMerchantBadge`,
`Storefront.tsx:309-316`, `ProMerchantBadge.tsx:4-9`), tests (`membershipsVerifiedBadge.test.ts`, 4 passing: PRO≠verified,
PLUS≠PRO, lapse/cancel/restriction remove PRO).
**Seams to close:** (a) `elite` reputation badge requires `verified` (`merchantOps.ts:206`) — verification feeds reputation;
(b) compat accessor `benefits.verifiedMerchant` returns the PRO entitlement (`entitlements.ts:476-477`, unused footgun); (c) the
restriction flag that pauses PRO is literally named `verifiedMerchant` (`entitlements.ts:136-138`; admin strings label it "PRO
merchant badge", `adminMemberships/strings.ts:372`); (d) "Verified" also labels verified-purchase reviews (`Storefront.tsx:1263`).
Verification itself is a bare toggle (`adminCommunity.ts:346-370`): no application, evidence, reviewer notes, expiry or merchant
notification; the dashboard never shows the merchant their own verification/PRO state.

---

## 4. Notifications

### 4.1 Storage, API, bell
`worker/lib/notifications.ts` (statement builder with per-user `event_key` replay guard `132-156`, never-throwing `notify` `160-169`,
list/unread/markRead scoped by user in SQL `171-217`). API `worker/routes/notifications.ts`: list (drops `meta`, `44-56`),
unread-count, mark read, channel preferences (`95-167`). Bell `src/components/notifications/NotificationBell.tsx`: badge polled every
60 s while visible, list on open, sheet on phones, optimistic read, `navigate(n.link)`. The legacy merchant dashboard inside
EditProfile (`MerchantDashboard.tsx` → `DashboardLayout.tsx:455-470`) has a hard-coded empty "no notifications" dropdown.

### 4.2 Kinds
Declared (`notifications.ts:34-78`): `print_request_match, offer_received, offer_accepted, order_update, review_reward_pending,
stock_back, support_reply, complaint_reply, warranty_reply, warranty_stage`. **`offer_accepted` is never written** (grep: only the
type and an audit string, `marketplace.ts:795`). `entity_type` union (`notifications.ts:100`) has no chat/payout/dispute/coupon/store.

### 4.3 Deep links
Paths, never origins: `/requests?request=` (`printRequests.ts:874`, `engagementNotify.ts:221`), `/orders/:id`
(`orderNotify.ts:304-321`), review landing (`orderNotify.ts:384-395`), `/support?tab=tickets&ticket|complaint=`
(`engagementNotify.ts:130-135`), `/warranty?claim=` (`334-336`). The merchant workspace is **not URL-addressable** (no
`useSearchParams` in `MerchantDashboardPage.tsx` or `components/merchant/dashboard/*`), so no notification could deep-link to a
merchant order, review, payout or dispute even if one were sent.

### 4.4 Delivery channels
In-app (`user_notifications`); email (Resend), Telegram customer bot, WhatsApp (wasender) via the durable outbox fan-out
`notifyCustomer` (`customerNotify.ts:566`, readiness-checked); admins via Telegram topics (`announceAfterResponse`). **No Web Push**
(stated honestly in `Settings.tsx:47,146,229`). The dark `services/notifications` is not deployed.

### 4.5 Merchant events today
| Event | Merchant told? | Who is told instead |
|---|---|---|
| Print request matches shop | **Yes**, in-app only, honours `request_opportunities` (`printRequests.ts:866-899`) | — |
| New store order | No | admin Telegram «Orders» topic with full address/phone (`storeOrders.ts:592-619`) |
| New chat message | No (nobody, for merchant threads) | admin topic only for SHOP order threads (`adminChats.ts:201-224`) |
| Offer accepted / custom order funded | No (`marketplace.ts:680-829`) | — |
| New store review | No | admin «Review» topic (`merchantReviews.ts:191-198`) |
| Dispute opened against merchant | No (and cannot see it) | admin «Report» topic (`marketplace.ts:1034-1041`) |
| Escrow released / payout available / payout recorded | No | — |
| Low stock, coupon ending, new follower, subscription expiry, suspension/verification decision | No | — |
Customer-side (for contrast): offer received, order status incl. store orders changed by the merchant (`merchant.ts:1428`),
support/complaint/warranty replies, stock back.

### 4.6 Preferences
`merchant_notification_preferences` has 9 switches (3 "forced on") rendered as working toggles
(`MerchantDashboardPage.tsx:534-606`, `merchant.ts:1070-1132`); **8 of 9 control nothing**. The one that is read,
`request_opportunities`, also removes the merchant from matching entirely (`printMatching.ts:296` `NOTIFICATIONS_OFF`), conflating
"don't notify me" with "don't match me".

---

## 5. Analytics

### 5.1 Real sources that exist (usable for the target)
Revenue/orders/AOV/fees/receivable/status mix: `orders` (merchant_id). Product revenue/units: `order_items.community_product_id`.
Returning customers & customer list: `orders.user_id`. Governorate: `orders.address_snapshot` JSON (`governorate`, read in
`SalesTabs.tsx:189`). Coupon performance: `orders.coupon_code/coupon_discount_iqd`, `merchant_coupons.used_count/ends_at`.
Requests matched/notified/rejected-why: `community_request_matches`. Offers sent/accepted/win-rate: `community_offers`.
Custom-order revenue: `community_orders`/`community_escrows`/`merchant_payout_ledger`. Followers over time: `follows.created_at`.
Rating: `merchant_reviews`. Product views: `community_products.view_count` (see caveats).

### 5.2 Not captured at all
Store (profile) views, per-day product views, add-to-cart for merchant products, checkout-started for store checkout, traffic source /
referrer / UTM, unique visitors. `merchant_store_analytics_daily` is dead; the event bus is off in production and the platform events
don't cover merchant products anyway; `services/analytics` is dark.

### 5.3 What the merchant UI shows today
| Tile (UI) | Source | Verdict |
|---|---|---|
| Gross sales / Your earnings / Orders / Average order (`MerchantDashboardPage.tsx:269-277`) | `merchant.ts:1545-1553` over ALL `orders` rows | **Wrong**: includes cancelled orders (probe B7: 90 000 cancelled counted, gross 100 000, AOV 50 000); excludes custom (community) orders entirely |
| Products active/total, Followers | `merchant.ts:1556-1562,1574-1576` | real |
| Views | `SUM(view_count)` | real but unthrottled (no rate limit, no dedupe, owner and bots counted — `storefront.ts:291-313`) |
| Offers accepted/sent + win-rate | `merchant.ts:1569-1572` | real (withdrawn/expired count as "sent") |
| Custom orders waiting | `merchant.ts:2055-2070` | real |
| Products page cards: views/total/active/drafts/hidden (`ProductsManager.tsx:376-420`) | `merchant.ts:771-837` | totals real; **"Total views" sparkline is lifetime views bucketed by product CREATION week** (`merchant.ts:788-796`) — reads like a traffic trend but is not |
| Product insights (views, sold, revenue, units, orders) (`ProductsManager.tsx:933+`) | `merchant.ts:839-873` | revenue/units real (excl. cancelled); `sold` = `sold_count` inflated (never decremented on cancel, `merchant.ts:1397-1406`) |
| Top products (API only) | `ORDER BY sold_count, view_count` (`merchant.ts:1564-1567`) | inflated ranking |
| Repeat customers (API only) | `merchant.ts:1578-1582` | counts cancelled orders |
| Customers tab: orders + lifetime (`MerchantDashboardPage.tsx:452-481`) | `merchant.ts:1513-1528` | **includes cancelled** (probe B7: 2 orders / 100 000 for 1 real 10 000 sale); store orders only; no governorate/returning flag |
| Money: Available / Pending / Paid out (`MerchantDashboardPage.tsx:483-532`) | `merchantBalance` (`escrowOps.ts:646-663`) | **Available never decreases after a payout** (payout rows are `state='paid'`); **"Paid out" includes platform commission rows** (`escrowOps.ts:404-415` writes commission as `paid`) |
| Admin: "Commission earned"/"Gross volume" (`AdminCommunity.tsx:1700-1701`) | `adminCommunity.ts:71-77` all `community_orders` | includes cancelled/refunded orders; excludes store-sale commission |
Nothing is computed from pure invention — every figure has a table behind it — but the flagged ones are computed from the wrong row set
or mislabelled. Public side: exact `sold_count` is exposed on every storefront product (`storefront.ts:107`), contradicting the
platform rule that the raw count never reaches the browser (`worker/lib/salesBadge.ts:14-19`).

---

## 6. Admin community today

Mounted `/api/admin/community` (`worker/index.ts:290`), apex-only via `requireAdmin`'s host check (`http.ts:63-69`) — **role check
only; no `admin_scope` check anywhere in the file** (`adminCommunity.ts:44`), unlike the platform rule "the 403 every money-moving
admin route answers an assistant-scope admin" (`worker/lib/walletAdjust.ts:81-89`) and `adminFinance.ts:74-80`.

| Capability | Endpoint (`adminCommunity.ts`) | UI control (`AdminCommunity.tsx`) | Notes |
|---|---|---|---|
| Overview (merchants/stores/products/requests/offers/escrow/complaints) | `GET /overview` 50-110 | Overview 120-205 | fee/gross over all states |
| Commission & lifecycle settings | `GET/PATCH /settings` 112-151 | Settings 1716+ | assistant can change commission; auto-complete setting has **no sweeper** (no step in `jobs.ts:236-621`) though both parties are shown "Auto-confirms on <date>" (`SalesTabs.tsx:428`, `Requests.tsx:912`) |
| Community gate (open/closed + allow-list, audited, chunked) | `GET/PUT /gate`, `/gate/lookup` 185-327 | `CommunityGatePanel.tsx` | solid |
| Merchant list/search | `GET /merchants` 329-344 | Merchants 208-359 | |
| Verify / unverify | `POST /merchants/:id/verify` 346-370 | toggle | no workflow, merchant not told |
| Suspend / restrict / restore merchant | `POST /merchants/:id/status` 372-398 | 281-313 | clobbers store sanction (B2); `restricted` enforced only by the matcher (`printRequests.ts:987`), not by `requireSellingPrivileges` (`merchantAuth.ts:185-209`); UI has no "lift restriction" (`AdminCommunity.tsx:281,306`); merchant not told |
| Store suspend / re-open | `POST /stores/:id/status` 429-460 | 314-338 | good guard vs suspended owner |
| Badge override | `POST /merchants/:id/badge` 400-418 | 1016 | free text ≤30 chars, not an enum |
| Hide product | `POST /products/:id/hide` 462-471 | **none** (`merchant.ts` client has `hideProduct`, unused) | no unhide, no reason |
| Hide review | `POST /reviews/:id/hide` 473-489 | 841 | rating recomputed |
| Request remove | `POST /requests/:id/remove` 491-516 | 782 | lets `disputed`/`offer_selected` through (B4) |
| Board & request detail (customer named, all offers, files via auth route) | `GET /requests`, `/requests/:id` 518-615 | Board 522-797 | |
| Reject pending offer | `POST /offers/:id/reject` 617-662 | 736 | state-machine guarded |
| Reviews moderation list | `GET /reviews` 664-697 | Reputation 821 | |
| Reputation view / append correction | `GET/POST /merchants/:id/reputation` 699-778 | 944-1097 | points affect nothing (§3.5) |
| Complaints list/detail/status/reply (+internal notes, attachments, reporter notified) | 786-990 | Disputes 1127-1659 | merchant side absent |
| Escrow resolve (release / refund / partial) | `POST /escrows/:id/resolve` 997-1052 | 1311 | assistant scope allowed; replay double reputation; request left `disputed` (B3); parties not notified |
| Merchant finance timeline / record payout | 1054-1099 | MerchantDetail 361-420 | assistant scope allowed; double-pay (B1) |
Absent: store content moderation (name, tagline, description, logo, banner, services, showcase), user/store/product/message
**reports** (the only complaint writer is the community-order dispute, `marketplace.ts:989`), store-order disputes, verification
queue, merchant notifications for any sanction, chat moderation with audited access.

---

## 7. Strengths to KEEP

1. **Participant-only chat with one membership question** end to end — read, send, typing, upload and download all ask
   `chat_participants` (`chats.ts:19-25`, `uploads.ts:460-469,642-660`); key names the conversation, not the sender (`chats.ts:290-313`).
2. **Server-sniffed attachment kinds** + additive `attachment_kind` migration with a pre-migration fallback (`chats.ts:34-75,319-353`, `0110`).
3. **Server-clock typing presence** with FK cascade and TTL (`0071`, `chatPresence.ts`).
4. **Admin support desk pattern**: team-unread SQL (`adminChats.ts:50-78`), one-function counts (`117-131`), debounced
   text-free Telegram announce (`201-224`), `useThreadScroll`/`mergeThread`/`pollWhileVisible` (`src/lib/supportThread.ts`) — reuse for the merchant inbox.
5. **Notification primitives**: per-user replay-proof `event_key`, statement-returning builder for batching, stored per language,
   path-only links, never-throwing senders, in-app floor + outbox fan-out with channel readiness (`notifications.ts`, `customerNotify.ts`, `engagementNotify.ts`).
6. **Review integrity by constraint**: one review per transaction via partial unique indexes; eligibility derived from the transaction row;
   ratings recomputed from rows (`0031:210-232`, `merchantReviews.ts:39-71,111-165`).
7. **Append-only reputation and money**: `merchant_reputation_events`, `community_escrow_events` (idempotency keys), ledger as SUM;
   corrections by new rows (`adminCommunity.ts:750-778`).
8. **Verification ≠ PRO** in data, API, UI and tests (`membershipsVerifiedBadge.test.ts`).
9. **Merchant tenant isolation** via session-derived store in every `/api/merchant` query (`merchantAuth.ts:164-178`), and the
   read-vs-sell split (`requireStoreOwner` `merchantAuth.ts:164-178` vs `requireSellingPrivileges` `185-209`).
10. **Escrow state machine & settlement ops** (`communityStates.ts`, `escrowOps.ts`) — idempotent, CHECK-backed; community gate (audited, fail-closed, chunked).
11. **Honest-UI culture**: null-not-zero AOV, "no Web Push" disclosure, `positive_pct` null with no reviews (`storefront.ts:125-150`).

---

## 8. Gaps vs the target (concrete)

**Merchant Inbox**
- G1 No inbox in the workspace; no store-owned conversation (chats belong to accounts; `chats.store_id/merchant_id/context_*` unused).
- G2 No request chats, offer chats or custom-order chats; store DMs carry no store/product context; order chats only for `orders`.
- G3 Seller not auto-joined to their order thread; no notification of any chat message to any end user (B10).
- G4 Search is client-side over ≤100 threads by name/last line; no server-side message search, no filters (unread/order/request/customer).
- G5 Paging: list LIMIT 100 no cursor; thread oldest-500 (B5); polling re-downloads whole threads; no `since` cursor; no unread-count endpoint.
- G6 Mobile: no keyboard-aware layout, `scrollIntoView` yank, single-line input, no load-earlier, no jump-to-latest, no read receipts.
- G7 No block/report/mute/archive; any user can DM any user id (`chats.ts:158-182`); public merchant payload leaks `user_id` (`community.ts:34`).
- G8 Staff access is silent and unaudited (admin joins merchant threads; admin file bypass).

**CRM**
- G9 Customers list includes cancelled orders, excludes custom orders, no governorate, no returning flag, no last-order detail, no search/paging (`merchant.ts:1513-1528`).

**Reviews & Reputation**
- G10 No customer UI to write store or custom-order reviews; no "rate this order" notification for store orders.
- G11 Self-review possible (B11); review images unvalidated; public reviewer names unmasked.
- G12 Reputation events affect nothing; `reputation_score` never derived; disputes don't affect standing/matching; badge not refreshed on completion.
- G13 Merchant cannot see/answer disputes against them; no dispute-opened reputation event; store orders have no dispute path.
- G14 Verification is a toggle with no application/evidence/notes/expiry/notification; `elite` couples verification into reputation.

**Notification Center**
- G15 Only one merchant event exists (print match). Missing: new order, message, offer accepted, low stock, new review, dispute, payout available, coupon ending, sanction/verification decisions.
- G16 Preferences UI promises 9 controls; 8 are inert; `request_opportunities` conflates notify with match eligibility.
- G17 No store-scoped notifications (per user only), no merchant-workspace deep links (workspace not URL-addressable), `meta`/ckb not returned, no Web Push.

**Analytics**
- G18 Gross/receivable/AOV/customers include cancelled orders; custom-order revenue excluded; `sold_count` never reversed; views unthrottled.
- G19 No store views, per-day product views, add-to-cart, checkout-started, traffic source, unique visitors; dead daily table; bus off.
- G20 No coupon performance, governorate, request-funnel or period (date-range) views, although the data exists.

**Admin Community**
- G21 No financial-scope enforcement on money routes; no content moderation of store fields/services/showcase; product hide has no UI/unhide.
- G22 No reports queue (only community-order disputes); no verification queue; `restricted` undefined/unenforced; sanctions don't notify merchants.
- G23 Escrow: no auto-complete sweep despite UI promise; resolution doesn't close request/complaint atomically or notify parties.

---

## 9. Bugs / security issues (verified)

Severity: **H** high · **M** medium · **L** low. "Probe" = scratch test result against real migrations/handlers.

1. **[H] Admin payout can pay the same money repeatedly.** `merchantBalance` counts only `state='available'` rows
   (`escrowOps.ts:646-663`); payouts are inserted as `state='paid'` (`adminCommunity.ts:1089-1091`), so `available_iqd` never
   drops and the guard `amount > balance.available_iqd` (`adminCommunity.ts:1082`) passes forever. The UI prompts with that same
   figure (`AdminCommunity.tsx:372-376`). *Probe B1:* 10 000 earned → two payouts of 10 000 accepted, ledger nets −10 000,
   `available_iqd` still 10 000. Same root cause makes the merchant's "Available" wrong after any payout.
2. **[H] Assistant-scope admins can move money.** No `assertFinancialScope`/`canViewFinancials` in `adminCommunity.ts`
   (only `requireAdmin`, line 44) for `/escrows/:id/resolve`, `/merchants/:id/payout`, `/merchants/:id/finance`, `PATCH /settings`
   (commission) — contradicts `walletAdjust.ts:81-89` and `adminFinance.ts:74-80`. (Verified by reading.)
3. **[H] Merchant self-review / reputation farming.** No reviewer≠owner check (`merchantReviews.ts:127-145`), no self-purchase
   guard in store cart/checkout (`cart.ts:2136-2156`), merchant controls delivery status (`merchant.ts:1331-1438`). Cost ≈ 5%
   commission per fake review; also inflates `completed_orders`, badge and matcher score (`printMatching.ts:378-379`).
   *Probe B11:* owner's review of own store → 201, rating 5.00, +10.
4. **[H] Customer messages on merchant-store orders reach nobody.** Seller not added at creation (`chats.ts:131-143`), shop desk
   excludes merchant orders (`adminChats.ts:78`), announce skips them (`adminChats.ts:218`), UI calls it "direct conversation with the
   team" (`SupportActions.tsx:35`). *Probe B10:* participants `[buyer]`, merchant list empty, 0 notifications.
5. **[H-adjacent, marketplace.ts] Accept → funding fails → "Top up and try again" → retry 500 and the request is stranded.** The
   rollback keeps the `cancelled` community order (`marketplace.ts:761`) and `idx_community_orders_offer` is a full UNIQUE on
   `offer_id` (`0031:124`); the request flip to `offer_selected` (`marketplace.ts:696-700`) happens before the failing batch
   (`708-741`) and is not undone. *Probe B12:* `UNIQUE constraint failed: community_orders.offer_id`; request
   `{state:'offer_selected', status:'closed', accepted_offer_id:'o3'}`, offer still `pending`.
6. **[M] Merchant status change overwrites store sanctions and the merchant's own pause.** `adminCommunity.ts:389-393` sets the store
   to `active` for any non-suspended merchant status. *Probe B2:* store suspended for a banner → merchant set `restricted` → store
   `active`; merchant-paused store re-opened on restore. Contradicts `docs/COMMUNITY_V2.md` "Two sanctions, not one".
7. **[M] Escrow resolve replay double-penalises and leaves the request disputed.** Reputation insert is unconditional after a
   replayed settlement (`adminCommunity.ts:1024-1044`); `community_requests.state` is never updated. *Probe B3:* two calls both
   `replayed=true`, 2 events / −40 points, request `disputed`. The UI even alerts "already recorded" (`AdminCommunity.tsx:1312`).
8. **[M] Community confirm race double-counts completion.** Post-release batch is unconditional (`marketplace.ts:945-962`) and a
   concurrent second confirm gets `released.replayed=true` (`escrowOps.ts:360-365`). *Probe B9* (serialized-batch D1 shim):
   `completed_orders 2`, 2 `order_completed` events. `merchant.ts:1368-1395` already has the correct fence to copy.
9. **[M] Admin "remove request" cancels a disputed (or offer_selected) request** while order+escrow stay frozen
   (`adminCommunity.ts:497` guard omits both). *Probe B4:* `{req:'cancelled', order:'disputed', escrow:'disputed'}`.
10. **[M] Chat threads silently truncate at 500 — newest messages invisible.** `ORDER BY created_at ASC LIMIT 500`
    (`chats.ts:260`). *Probe B5:* 510 messages → last shown `msg 499`.
11. **[M] Silent staff join of private merchant↔customer threads** (policy/privacy). `chats.ts:108,122-127` + admin order modal Chat
    tab (`OrderDetailModal.tsx:184`). *Probe B6:* participants `[boss,buyer,owner]`, admin reads 200. Plus admin file bypass
    (`uploads.ts:660`). No audit row, no visible "staff joined".
12. **[M] Merchant analytics include cancelled orders** (gross, fees, receivable, AOV, repeat customers, CRM lifetime)
    (`merchant.ts:1545-1553,1578-1582,1513-1528`). *Probe B7:* one delivered 10 000 + one cancelled 90 000 → gross 100 000,
    receivable 95 000, AOV 50 000; customer "2 orders / 100 000".
13. **[M] Escrow auto-complete is promised but never runs.** `auto_complete_at` set (`marketplace.ts:903`), displayed to both parties
    (`SalesTabs.tsx:428`, `Requests.tsx:912`), partial index exists (`0031:126-127`), but no job step (`jobs.ts:236-621`).
14. **[M] Merchant cannot read or answer disputes against them** (`marketplace.ts:1163-1177` reporter-only) though admin may set
    `waiting_merchant` and `merchant.ts:11` promises dispute reads.
15. **[M] Public store reviews expose full customer names** (`storefront.ts:325,361`) vs masked platform reviews (`reviews.ts:168-175,870`).
16. **[L] Review edit leaves reputation stale** (`merchantReviews.ts:228-233`; probe B8: 5★→1★ keeps +10).
17. **[L] Review `images` unvalidated / unbounded** (`merchantReviews.ts:158`; probe B8 stored 200 KB + external URL + `javascript:`) —
    latent XSS/tracking/storage vector the day a renderer ships.
18. **[L] `offer_accepted` notification declared but never written** (`notifications.ts:37`; `marketplace.ts:680-829`).
19. **[L] 8 of 9 merchant notification toggles are inert** (`merchant.ts:1085-1132` vs zero readers) — UI promises controls that do nothing.
20. **[L] `sold_count` never reversed on cancel and exposed exactly in public** (`storeOrders.ts:498-502`, `merchant.ts:1397-1406`,
    `storefront.ts:107` vs `salesBadge.ts:14-19`).
21. **[L] Product `view_count` trivially inflatable** — no rate limit/dedupe on `GET /api/storefront/:slug/products/:productSlug`
    (`storefront.ts:291-313`).
22. **[L] "Paid out" shows commissions; admin "Commission earned" includes cancelled/refunded and excludes store-sale fees**
    (`MerchantDashboardPage.tsx:497`, `escrowOps.ts:404-415`, `adminCommunity.ts:71-77`).
23. **[L] `restricted` merchant status has no enforcement** outside matching (`merchantAuth.ts:185-209` ignores it); UI cannot lift it directly.
24. **[L] Badge not refreshed when `completed_orders` changes** (callers of `refreshMerchantRating`: `adminCommunity.ts:359,410,486`,
    `merchantReviews.ts:172,233` only).
25. **[L] Hard-coded production host** `https://levonis-iq.com/chat/…` in the merchant order sheet (`SalesTabs.tsx:201`); `…levonis-iq.com`
    labels in admin (`AdminCommunity.tsx:257,707`).
26. **[L] Legacy merchant dashboard bell is a static empty stub** (`DashboardLayout.tsx:455-470`, reached via `EditProfile.tsx:216`).
27. **[L, docs] `docs/COMMUNITY_V2.md` claims "Every one of these has a control"** (false for product hide) and "no update path" for payout
    rows (`merchant.ts:1356-1361,1400-1405` flip ledger states).

---

## 10. Recommended foundation changes (dependency order)

**Step 0 — Stop the bleeding (small, independent; each with a regression test in the existing harness)**
1. Ledger semantics: make `available` = net spendable (payout rows reduce it — e.g. record payouts against `available` or compute
   `available = Σ available + Σ payout`), and make the payout INSERT conditional in SQL (`INSERT … SELECT … WHERE net_available >= ?`) (#1, #22).
2. `assertFinancialScope` on escrow resolve, payout, finance, commission settings (#2).
3. Idempotent reputation writes: add `idempotency_key UNIQUE` (or a unique (kind, community_order_id/order_id/review_id) index) to
   `merchant_reputation_events`; fence community-confirm like `merchant.ts:1368-1395`; settle request + complaint in the resolve batch (#7, #8).
4. Sanction model: never touch store status on restrict; on merchant restore lift only a suspension the merchant sanction set
   (store `suspended_by`/`status_source`) (#6). Tighten request-remove guard (#9). Make the accept retry-safe (partial UNIQUE over live
   states, or delete the failed order row, and put the request flip inside the batch) (#5).
5. Review integrity: forbid reviewer = store owner and store self-purchase; validate images as owned media keys; mask public names;
   re-derive `review_received` on edit (#3, #15-17).
6. Analytics correctness: exclude cancelled/refunded; add community-order revenue as its own series; decrement `sold_count` on
   cancel; bucket public sales like `salesBadge`; throttle/dedupe views (#12, #20-21).

**Step 1 — Conversation foundation (everything in the Inbox depends on this)**
1. Give `chats` real ownership/context using the already-migrated 0031 columns: `context_type` ∈ {store, order, community_order,
   request_offer}, `store_id`, `merchant_id`, `community_order_id`, plus unique partial indexes per context (store+customer,
   order, community_order, request+merchant). Additive migration only.
2. `chat_participants`: add `role` (customer/merchant/staff/admin), `joined_via`, `last_read_seq`, `muted`, `archived_at`.
   Auto-join the store owner when an order/request/custom-order thread is created; staff joins become explicit, audited, and
   announced by a system message (restricted to dispute/support contexts); scope the `/files/chat` admin bypass the same way.
3. Messages: monotonic per-chat `seq`, `client_msg_id` (idempotent send), `system` kind, `edited_at/deleted_at`; separate
   `chat_attachments` (mime, size, name, duration; multiple per message).
4. Read API: cursor pagination (`before_seq`, `after_seq`), `/api/chats/unread-count`, list with context filters and a
   store/personal split, server search (D1 FTS5 over `chat_messages.body` joined through participation).
5. Client: shared thread component using `useThreadScroll`, `after_seq` polling (Durable Object realtime later), textarea composer,
   `visualViewport`/`interactive-widget=resizes-content` keyboard handling, load-earlier, jump-to-latest, retry for failed sends.
6. Request/offer threads (created on offer submit or customer question) and custom-order threads (set `community_orders.chat_id`).

**Step 2 — Merchant workspace addressability + Notification Center (depends on Step 1 for message events)**
1. Make `/merchant/*` URL-addressable (`/merchant/inbox/:chatId`, `/merchant/orders/:id`, `/merchant/custom/:id`,
   `/merchant/reviews/:id`, `/merchant/disputes/:id`, `/merchant/payouts`, `/merchant/products/:id`), retire the legacy
   `MerchantDashboard`/`DashboardLayout` stub.
2. Extend `NotificationKind`/`entity_type` (new_store_order, chat_message, offer_accepted, low_stock, new_review, review_reply,
   dispute_opened/updated, payout_available, payout_recorded, coupon_ending, merchant_sanction, verification_decision) and add an
   audience/`store_id` column so the workspace bell filters store notifications; return `meta`/ckb.
3. One `notifyMerchant()` that reads `merchant_notification_preferences` (forced kinds honoured) and fans out in-app + outbox;
   decouple `request_opportunities` from match eligibility.
4. Producers: store checkout, chat send (debounced), offer accept, review create/reply, dispute open/resolve, escrow release,
   delivered → payout available, admin sanctions/verification; scheduled steps in `jobs.ts` for low stock, coupon ending, escrow
   auto-complete (which also fixes #13).

**Step 3 — Reviews, reputation, disputes, verification (depends on Step 2 for notifications)**
1. Customer UI for store & custom-order reviews (the `/eligible` + create API exists); merchant reply notification; admin reply moderation.
2. One reputation derivation (score from events with a published point table incl. `dispute_opened/lost`, `late`, `cancelled`),
   persisted to `reputation_score` by the same writer; refresh badge on every completion/review/dispute; feed matcher
   `trouble_rate`/`response_minutes` from real data.
3. Party view of disputes for merchants (list/read/reply, no internal notes), dispute path for store orders, reports table/flow
   for store/product/review/message.
4. `merchant_verifications` workflow (application, evidence refs, reviewer, reason, expiry, history) → `community_merchants.verified`
   becomes a derived cache; remove `verified` from `elite` or document it; delete `benefits.verifiedMerchant` alias and rename the
   `verifiedMerchant` restriction flag (keeping a read alias) so verification and PRO never share a name.

**Step 4 — Analytics from real events (can start after Step 0; complete after Step 2)**
1. Capture merchant-surface events in the monolith with a daily-salted visitor hash (owner/bots excluded): store_view, product_view,
   add_to_cart (`/cart/merchant-items`), checkout_started/placed (store checkout), plus referrer/UTM at session start.
   Write increments into the existing `merchant_store_analytics_daily` (add product-level daily table) and a 30-day raw table — or
   switch on the dark analytics service with `merchant_id` on these events.
2. Read models with date ranges: revenue (delivered, net of refunds), orders, AOV, conversion (orders / unique product viewers),
   top/low products, returning customers, coupon performance, requests matched→offers→accepted, governorates, traffic; each metric
   labelled with its source; remove the creation-week "views" sparkline.
3. CRM as a derived per-(merchant, customer) view over store + community orders: orders count (non-cancelled), total purchases
   (delivered), last order, returning flag, governorate of latest address — no email/phone outside an order context.

**Step 5 — Admin community completion (after Steps 0-3)**
Financial scopes throughout; content moderation (store fields, logo/banner, services, showcase, products) with hide/unhide + reason
+ merchant notification; reports queue; verification queue; defined and enforced `restricted`; audited chat access for disputes;
escrow auto-complete visibility; tests for every money and sanction path (the current suite covers refusals only).
