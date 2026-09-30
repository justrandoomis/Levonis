# Levo Community — the Social + Creator + Manufacturing ecosystem

The owner's brief (2026-09-29, «Social + Creator + Manufacturing Ecosystem», 28
sections, and the transactional brief §21–36 before it) asked for ONE integrated
community: what makers print (projects and posts), who they are (creator
pages), how they meet the workshops (feed, search, discovery, matching), and
the manufacturing loop that already exists (requests → offers → escrow →
delivery → review) — built on the systems Levonis has, never beside them:

> لا تكرر الموجود: ممنوع إنشاء wallet جديد، escrow جديد، chat system جديد،
> products table جديدة، orders table جديدة، request marketplace جديد،
> notification system جديد.

This document is the gap analysis the brief asked for («ابدأ بـ Gap Analysis
جديد من HEAD الحالي: Existing / Partial / Missing / Needs Refactor ثم نفذ على
مراحل»), the decisions taken while building, the data model, and the phase
plan with its test plan. It is written against HEAD f18690fd and updated as
each phase lands. Sibling documents: docs/COMMUNITY_COMMERCE_CHAT.md (the
commerce chat, done), docs/MOTION.md (motion rules), docs/DECISIONS.md (the
owner's standing decisions).

## 1. Gap analysis from HEAD

Read by eight parallel surveys of the worker, the SPA and the migrations, then
a completeness critic. «Existing» means it works end to end today; «Partial»
means the data or half the flow is there; «Missing» means nothing; «Needs
refactor» means it exists but the brief's rules cannot be met on it as is.

### 1.1 Content: projects, posts, creators

| Area | State | Where |
|---|---|---|
| Maker projects / posts (photos, video, timelapse, tutorial, before/after) | **Missing → built in Phase 1** (`community_posts`, `community_post_media`, 0153) | worker/routes/communityPosts.ts |
| Portfolio «works» rail | Existing but a different thing: `merchant_showcase` kind='work', ≤3 per store, no page | community.ts `/works`, hub/WorksRail.tsx |
| Creator profile page | **Missing → built in Phase 1** (`/u/:username`, `users.creator_public`) | pages/community/Creator.tsx |
| Profile socials | Partial: EditProfile writes `instagram/xAccount/tiktok/facebook` into `profile_json`; nothing validates or renders them publicly | pages/EditProfile.tsx |
| Printers / materials a creator uses | Missing on customers (legacy `printer1..4` keys); merchants have structured `merchant_printers` | 0045, PrintersTab |
| Project → request wizard («اطلب طباعته») | Missing: the wizard has `?link=` prefill only | RequestWizard.tsx, Requests.tsx:108 |
| Share previews for projects / creators | Missing: socialPreview rewrites product and store paths only | worker/lib/socialPreview.ts |

### 1.2 Social graph and feed

| Area | State | Where |
|---|---|---|
| Follow a store | Existing: `follows(user_id, merchant_id)`, POST/DELETE `/api/community/store/:id/follow`, `GET /followed` (cap 500, no paging), merchant followers list | community.ts:492, merchant.ts:959 |
| Follow a creator (user → user) | Missing | — |
| Like / save / comment on a post | Missing; counters exist on 0153 with `CHECK >= 0` and nothing writes them | 0153 |
| Save a product | Existing: `community_product_favorites` (PUT idempotent, `cfav` 120/h) — the shape to copy | communityFavorites.ts |
| Block / mute | Missing; `POST /api/chats/open {userId}` lets anyone DM anyone | chats.ts:559 |
| Mentions, share | Missing (share = the browser's share sheet on the project page) | — |
| Report a post / user / store | Missing; `community_complaints.category` accepts product/store/conduct but only order disputes write rows | 0031:256, marketplace.ts:1988 |
| Feed | Missing: three newest-first lists (products, stores, requests) under tabs; no For You, no Following | pages/Community.tsx |
| Notification grouping («أعجب 12 شخصًا») | Missing: `user_notifications` dedupes by `event_key`, never aggregates; customer bell has no kind filter and Bell-icon fallbacks | notifications.ts, NotificationBell.tsx |
| Anti-spam | Partial: `rateLimit(bucket, limit, window, key?)` everywhere; decency filter only on names/usernames | ratelimit.ts, decency.ts |

### 1.3 Search and discovery

| Area | State | Where |
|---|---|---|
| Catalogue search | Existing: token index 0089 (`search_tokens`, synonyms, ghost completion), `/api/products?search=` | worker/lib/search/* |
| Community search | Partial: LIKE over each list's own columns, per tab, no cross-entity result | community.ts, communityPosts.ts |
| Unified search (products, stores, creators, projects, requests, materials, brands) | Missing | — |
| Autocomplete / recent / trending searches | Missing (no search log by design: «no invasive tracking») | recentlyViewed.ts |
| Recommendations | Partial: home shelves (best sellers all-time, featured flag), affinity ranking in localStorage (orphaned SpotlightTiles) | homeShelves.ts |
| Featured / trending stores and creators | Missing; posts have `/posts/trending` (30 days, likes·3 + comments·4 + saves·5 + views) | communityPosts.ts |

### 1.4 Files and the 3D asset platform (§27–35)

| Area | State | Where |
|---|---|---|
| Byte sniffing | Existing: `classifyAttachment` (JPEG/PNG/GIF/WebP/PDF/3MF/GLB/STL/OBJ/STEP/AMF/glTF), `sniffVideo` | worker/lib/attachments.ts |
| Size limits | Partial: images 8 MB, video 40 MB, models 40 MB; whole body read; not admin-configurable | uploads.ts:36 |
| Multipart / resumable uploads, checksum, progress, cancel, retry | Missing | — |
| Zip-bomb bound for 3MF/ZIP | Missing | attachments.ts |
| Viewer tokens | Existing: `model_view_tokens` (60 min, preview/full), LVM mesh, ogl viewer; keys never returned | printRequests.ts, model-viewer |
| Files on merchant products (preview / download-after-purchase / reference / instruction / source) | Missing | — |
| Link cards with server-side URL validation | Partial: `validateOutboundUrl` (http/https, private IPs blocked) exists for fetches; no card | fetchGuard.ts |
| Per-file authorization | Existing for request files (`fileReader` access); chat files expose `/files/<key>` | marketplace.ts, chats.ts |

### 1.5 Manufacturing loop (§21–26, 36)

| Area | State | Where |
|---|---|---|
| Matching (trade / capability / stock / reach / preference), verdicts per revision, queue, notices with dedup | Existing | eligibility.ts, printMatchingStore.ts |
| Workshop profile used in matching | Partial: `merchant_printers`, `merchant_material_stock`, `merchant_request_prefs`, delivery profiles feed the engine; store `categories/service_areas/profile_facts` are display text | StoreSettingsTab, PrintersTab |
| Offers | Partial: price, days, delivery method, message, materials, included, warranty, revisions, states pending/accepted/rejected/withdrawn/expired/superseded; **no delivery fee, no attachments, no `draft`/`revised` state name** (a revision is `superseded → pending`) | 0031:61, marketplace.ts |
| Atomic accept → funded order with snapshots | Existing; `chat_id` set only for direct requests (board orders have no chat) | marketplace.ts:1467 |
| Execution timeline | Partial: funded → in_progress → merchant_marked_delivered → customer_confirmed → completed; no `ready`, no progress photos, no `started_at` | communityStates.ts |
| Delivered never releases money | Existing: only confirm (customer) or the auto-complete sweep release; disputes hold | escrowOps.ts, communityRequests.ts:509 |
| Discussion on a request (public comment / merchant question / customer answer / system update) | Missing | — |
| Request page (header → status → files → details → comments → offers → comparison → chat → accepted offer → timeline → escrow → delivery → review) | Partial: `RequestDetail` inside pages/Requests.tsx at `/requests?request=<id>`, no dedicated route file, no timeline, no comments | Requests.tsx:636 |
| Merchant custom-order view | Partial: a card list, no cancel/dispute buttons though the API allows both | SalesTabs.tsx:605 |

### 1.6 Moderation, reputation, disputes

| Area | State | Where |
|---|---|---|
| Sanctions | Existing for merchants (active/restricted/suspended) and stores; product hide with reason (sticky, 0126 triggers); review hide; request removal; offer rejection | adminCommunity.ts |
| Post hide | Partial: 0153 columns and read-side enforcement; **no admin write route or UI** | communityPosts.ts |
| User suspension / ban | Missing (`restriction_cases` gates membership benefits only) | support.ts:3224 |
| Appeals | Missing (policy text only) | policies/community.ts |
| Audit | Existing: `audit()` / `auditStatements()`; no viewer UI | audit.ts |
| Reputation | Partial: `badgeFor` (new/trusted/professional/elite), rating refresh, events table (`order_completed`, `review_received`, `dispute_won/lost`, `admin_adjustment`); `reputation_score` column dead; response time and completion rate not measured | merchantOps.ts:196, merchantReviews.ts |
| Explainable badges (Verified, Fast Response, Reliable Seller, Custom Printing Specialist, High Completion Rate) | Missing | — |
| Dispute evidence access for staff | **Needs refactor**: staff may read `store_order` threads only (audited); the `store` / `request` threads a community order lives in answer 403 even during a dispute; no link from the dispute desk to the chat | chats.ts:603, adminCommunity.ts:1509 |

### 1.7 Analytics, collections, activity

| Area | State | Where |
|---|---|---|
| Storefront analytics beacon (store/product view, add to cart, checkout) | Existing, private-by-design (salted visitor hash, Baghdad days, bots and owners dropped) | storefrontAnalytics.ts |
| Post views | Missing writer (`view_count` = 0) | — |
| Merchant analytics report | Existing (PLUS) | merchantAnalytics.ts |
| Creator analytics | Missing | — |
| Saved collections (private boards) | Missing; merchant collections exist for the storefront | merchantCatalog.ts:1270 |
| Activity centre | Missing; the merchant notification centre groups by day only | MerchantNotificationCenter.tsx |
| Draft product preview without the storefront budget | Partial: the merchant catalogue previews through its own screens; the storefront never reads drafts | StorefrontProduct.tsx |

### 1.8 Localisation and shell

| Area | State | Where |
|---|---|---|
| ar / en / ckb | Existing: `loc(ar, en, ckb?)` falls back to Arabic; ~250 files; per-feature strings tables | LanguageContext.tsx |
| Sorani policing | Partial and contradictory: some tests demand real Sorani, three demand the Arabic copy (cartServerError, finderStrings, farmShelved); `uiPrimitives.test.ts` forbids invented Sorani in the UI primitives | tests/*.test.ts |
| Notification text | ar/en only (`NotificationInput`); merchant feed carries `title_ckb` in meta | notifications.ts |
| Bottom nav, themes, motion kit | Existing: `html[data-theme]` tokens, `useMotion()` springs, TabStrip/TabPanels, `.material` | motion.ts, Tabs.tsx |
| CSS budget | 60 KB gzip total, ~50 B headroom before Phase 1; every new utility class costs bytes | tests/bundleBudget.test.ts |

## 2. Decisions

Numbered to be cited from code comments as «docs/COMMUNITY_ECOSYSTEM.md D<n>».

- **D1 — One table for projects and posts.** `community_posts.kind` (project | post | tutorial | timelapse | before_after) instead of a projects table beside a posts table: the feed, the cards, the moderation and the counters are one code path, and a project is a post with more facts.
- **D2 — Every linked id is checked against the author.** A post may cite its author's own store, a non-private product of that store, a catalogue printer or material by id, and a job the author was a party to. Anything else is `POST_LINK_NOT_OWNED` / `POST_LINK_NOT_FOUND`, and a picture key must sit under the author's own upload prefix AND in `file_objects` under their `owner_id` (`POST_MEDIA_NOT_OWNED`). The client sends ids; the server decides (the commerce chat's D2 again).
- **D3 — A customer's part needs the customer's consent.** A workshop publishing a piece it printed for a customer's request or order gets `consent_status = 'pending'` and the customer is notified (`portfolio_consent`); the post cannot publish until `granted`; a published post cannot take on such a link (409 `CONSENT_REQUIRED`); the feed rule itself excludes anything not `not_needed | granted`. The customer may read the piece they are asked about whatever its state.
- **D4 — A creator page is a choice.** `/u/<username>` exists for an account with `creator_public = 1` (set by the first publish and by the profile switch) or a store owner (public through the store). Closed pages are closed from every side: a card withholds the username so nothing links to a 404. Private and misspelt names answer the same 404 wording.
- **D5 — Only the allow-listed socials leave `profile_json`.** instagram, x (stored as `xAccount` by the profile editor), tiktok, facebook, youtube; printers and materials as string lists. Nothing else in the blob is ever returned.
- **D6 — Real Sorani for every new community string.** The owner's rule («لا تترك Arabic placeholder في ckb») reverses the older «OWNER: Sorani to be written by hand» convention for the community ecosystem: every new key in `src/components/community/projects/strings.ts` and `src/lib/refusalStrings.ts` carries a written Sorani sentence. The primitives' test (`uiPrimitives.test.ts`) still forbids INVENTED Sorani in the shared primitives, so no new Sorani goes into those files.
- **D7 — The CSS budget is paid for, not raised.** Phase 1 added ~250 B of utilities and paid them back by retiring the community tiles' bespoke rules (`.lv-community-tile`) and gradients; the stylesheets stand at 59.9 KB of 60 KB. New surfaces reuse the utilities already in the build; a class that exists nowhere else is swapped for one that does, or written inline (Toast's pattern for the sticky action bar).
- **D8 — Feeds page by `(published_at, id)` with an exact cursor.** One row more than asked is read so `next_cursor` is present only when a next page exists (worker/lib/feedCursor.ts's convention returned a cursor on every full page, which made infinite scroll fetch an empty tail).
- **D9 — No new money, chat, order or notification system.** Likes, saves, follows and comments write their own small tables and the counters on 0153; everything transactional stays in `community_orders`, `community_escrows`, `chats`, `user_notifications`.
- **D10 — The composer is a page, not a sheet.** A long form on a phone is a page with its actions under the thumb and the bottom nav hidden (`isBottomNavHidden`); the home's «شارك مشروعًا» links to it.
- **D11 — Media keys are the author's alone.** `GET /posts/:id` returns `media[].key` to the author and staff only; everyone else gets URLs. Post pictures live under the anonymous-public prefix `users/<uid>/posts/`, so a draft's picture is fetchable by anyone who has its (unguessable) URL — accepted for Phase 1, recorded as open question Q4 below.

## 3. Data model (Phase 1, landed)

```
community_posts       id, author_id → users, kind, title, body, state (draft|published|archived),
                      visibility (public|unlisted|private), printer_product_id → products, printer_name,
                      material_product_id → products, material, color, print_settings JSON,
                      print_time_minutes, dimensions JSON, tags JSON, store_id → merchant_stores,
                      product_id → community_products, request_id → community_requests,
                      community_order_id → community_orders, consent_status
                      (not_needed|pending|granted|declined), like/comment/save/view_count,
                      admin_hidden_at, admin_hidden_reason, published_at, created_at, updated_at
community_post_media  id, post_id (CASCADE), kind (image|video), media_key, width, height,
                      duration_s, sort_order
users.creator_public  0|1
```

Indexes: the partial feed index on the public rule; author, store, product, request.
Trigger: a published post always has `published_at`. Registered: schema
version 0153/146, ownership (`marketplace`), media sweeper (`media_key`;
`print_settings`/`dimensions`/`tags` as non-media).

Landed (Phase 2, 0154): `user_follows(follower_id, user_id)`, `community_likes(user_id, post_id)`,
`community_saves(user_id, post_id, collection_id?)`, `community_comments(id, post_id, author_id,
parent_id, body, state)`, `user_blocks`, `user_mutes`, `community_reports(id, reporter_id,
target_type, target_id, reason, state)` and the counter triggers on `community_posts`.

## 4. API (Phase 1, landed) — all behind `communityGate()`

| Method, path | Who | Notes |
|---|---|---|
| GET `/api/community/posts` | anyone | q, kind, author, store, product, tag; cursor `published_at|id`; `total` on page 1 |
| GET `/api/community/posts/trending` | anyone | 30 days, ≤24 |
| GET `/api/community/posts/:id` | per D3/D4/D11 | `viewer.mine`, `viewer.consent`, `viewer.can` |
| POST `/api/community/posts` | account, 20/h | creates a draft |
| PATCH `/api/community/posts/:id` | author, 120/h | archived refused; published keeps its promises |
| POST `…/publish`, `/archive`, `/restore` | author | each answers with the post |
| DELETE `/api/community/posts/:id` | author | published refused (`POST_PUBLISHED`) |
| POST `…/consent` | the linked job's customer | `granted` / `declined`, notifies the author |
| GET `/api/community/my-posts` | account | every state, `created_at|id` cursor |
| GET `/api/community/creators/:username` | anyone, per D4 | socials by allow-list, badges, stats, store card |
| PATCH `/api/profile {creator_public}` | account | strict boolean; `publicUser` returns it |

Refusal codes (all three languages in src/lib/refusalStrings.ts): POST_MEDIA_NOT_OWNED,
POST_MEDIA_TOO_MANY, POST_MEDIA_KIND, POST_LINK_NOT_OWNED, POST_LINK_NOT_FOUND,
POST_SETTING_INVALID, POST_NEEDS_MEDIA, POST_ARCHIVED, POST_PUBLISHED,
POST_HIDDEN_BY_ADMIN, CONSENT_REQUIRED, CONSENT_DECLINED, CONSENT_NOT_NEEDED.

## 4b. API (Phase 2, landed) — all behind `communityGate()`, every write `requireAuth`

Router worker/routes/communitySocial.ts, mounted after the post routes. Every 200/201 carries
`success: true`; refusals are `{ success: false, error, code }`. Every write is idempotent — a
replayed like, save, follow, block, mute, report or comment removal changes nothing and answers
the same, and two comment sends in flight with one `client_id` land once (0155); counters move
only through the 0154 triggers.

**One story for a block (review fix).** Every community door answers a block with the words a
missing thing gets — 404 `NOT_FOUND` — from BOTH sides: the creator page, the post page, its
comments, a like, a save, a comment, a follow. None of them says BLOCKED, so the blocked side
learns nothing from any post id. The messaging doors are the exception that names it: POST
`/api/chats/open` answers 403 `BLOCKED`, and a general DM thread that existed before the block
refuses both sides' messages and typing with 403 `BLOCKED` and leaves the blocker's inbox (a
thread cannot pretend not to exist). A body that is JSON `null`, an array or a scalar is `{}`
(`jsonObject` in worker/lib/http.ts), so a malformed body is a 400, never a 500.

| Method, path | Who | Notes |
|---|---|---|
| PUT / DELETE `/api/community/posts/:id/like` | account, `social-like` 240/h | `{ liked, likes }`; 404 unreadable post or across a block; author hears `post_liked` grouped (not from someone they muted) |
| PUT / DELETE `/api/community/posts/:id/save` | account, `social-save` 240/h | body `{ collection? ≤40 }` (a second PUT moves the save); `{ saved, saves }`; nobody is told |
| GET `/api/community/saved` | account | `PostCard & { saved_at, collection }`, newest first, cursor `saved_at|post_id`, limit ≤48 |
| GET `/api/community/posts/:id/comments` | per the post's rule; 404 across a block | oldest first, cursor `created_at|id`, limit ≤50, `total` = the visible comments THIS viewer is shown (blocked/muted authors are out of the number as well as the rows; the card's `comment_count` stays the post's own); removed rows are stubs (`body:''`, `author:null`); hidden rows only for staff and their author (a reply whose parent is missing is drawn top-level) |
| POST `/api/community/posts/:id/comments` | account, `social-comment` 60/h | `{ body 2–2000, parent_id?, client_id? ≤64 }`; 201, or 200 `replayed` when this author already sent this `client_id` under this post (stored, unique per post+author+client_id, 0155 — two sends in flight land once) or for the same body+parent within the 10 s cooldown; 429 `COMMENT_TOO_FAST`; 400 `COMMENT_INDECENT`; 404 across a block; one level — a reply to a reply files under the thread root; `comment_replied` to the parent's author, `post_commented` to the post's author, once when they coincide, neither to someone who muted the writer; links end in `#comments` |
| DELETE `/api/community/comments/:id` | the comment's or the post's author | state `removed`, stub kept; anyone else 404 |
| PUT / DELETE `/api/community/users/:id/follow` | account, `follow-user` 60/h | `{ following, followers }` (`users.follower_count`); 400 `CANNOT_FOLLOW_SELF`; PUT 404 without a creator page or store, and 404 across a block; `new_follower` grouped (not to someone who muted the follower), linking to the follower's page only when it exists, else `/community?tab=creators` |
| PUT / DELETE `/api/community/users/:id/block` | account, `social-block` 60/h | `{ blocked }`; PUT deletes the follows both ways; 400 `CANNOT_BLOCK_SELF` |
| PUT / DELETE `/api/community/users/:id/mute` | account, `social-block` 60/h | `{ muted }`; tells nobody — and the muted person's likes, comments and follows ring no bell for the muter |
| GET `/api/community/me/social` | account | `{ following_users, following_stores, blocked, muted }`, ≤500 each, newest first |
| POST `/api/community/reports` | account, `report` 20/h | `{ target_type: post|comment|user|store|product|request, target_id, reason: spam|abuse|nudity|fraud|copyright|offtopic|other, details? ≤1000 }`; 201 `{ report_id }`, 200 `replayed` on the second press (the first reason stands); 404 `REPORT_TARGET_NOT_FOUND` for anything the reporter could not already open — a post they may read, a visible comment under one, a person WITH a page, a live store, a listed product, a request on the board — so the door is no existence oracle; audit `community.report`, Telegram topic `report` after the response |
| GET `/api/community/feed?scope=foryou|following` | anyone / account | `PostCard[]`, cursor `published_at|id`, limit ≤30; `following` = followed makers ∪ owners of followed stores, 401 for a guest; both scopes drop blocked-either-way and muted authors |
| GET `/api/community/creators` | anyone | q over name/username/bio, `featured=1`; only accounts with a page and a username, never blocked either way; opaque offset cursor, `total` on page 1. Starts from the candidates (`creator_public = 1`, 0155's partial index, ∪ live merchants) and joins ONE grouped read of public posts for the project count and last publication — no per-row subqueries over every user |

Changes to Phase 1 routes: every post card (`/posts`, `/posts/trending`, `/feed`, `/saved`,
`/my-posts`) carries `viewer: { liked, saved }` (false/false for a guest); `/posts/:id` merges
`liked`/`saved`/`following_author` into its viewer object and answers 404 across a block;
`/posts` takes `not_kind=<kind>` (the creator page's «المنشورات» = `not_kind=project`, with an exact
`total`); `/posts` and `/posts/trending` (and `/posts`' `total`) exclude blocked-either-way and
muted authors for a signed-in viewer; `/creators/:username` adds `stats.followers`,
`viewer.following`, `viewer.blocked` and answers 404 across a block. POST `/api/chats/open
{ userId }` answers 403 `BLOCKED` across a block, and so do POST `/api/chats/:id/messages` and
`/typing` on a general thread between a blocked pair (`assertMayWriteInThread`); GET `/api/chats`
leaves such a thread out of the blocker's list.

Notifications (worker/lib/notifications.ts): kinds `post_liked`, `post_commented`,
`comment_replied`, `new_follower`; `notifyGrouped()` keeps ONE `user_notifications` row per
(recipient, group key) — `INSERT … ON CONFLICT(user_id, event_key) DO UPDATE` climbs
`meta.count`, records `last_actor`, retitles from the count and clears `read_at`. The count is
PEOPLE, not events: `meta.actors` remembers the last 50 actor ids and the upsert changes nothing
(count, body, link, `read_at`, `created_at`) for an actor already in it — one account liking,
unliking and liking again is one person and rings the bell once. ar/en only, like every
notification row (Q5 stays open).

Refusal codes (ar/en/ckb in src/lib/refusalStrings.ts): BLOCKED, CANNOT_FOLLOW_SELF,
CANNOT_BLOCK_SELF, COMMENT_INDECENT, COMMENT_TOO_FAST, REPORT_TARGET_NOT_FOUND.

Tests: tests/communitySocial.test.ts (22 — replay, grouped notifications, comment ownership,
follow rules and spam, the block matrix, mute, the following feed, report-once, creators, body
forgery; and the review regressions: people-not-events counting, the DM thread closed by a
block, the concurrent comment send, the viewer's `total`, the `null` body, the report oracle,
the quiet mute, `not_kind` + `following_author`, the notification links),
tests/communitySocialUi.test.ts (8), tests/communityHubUi.test.ts (extended);
scripts/e2e-projects.mjs (under `<StrictMode>`, as src/main.tsx mounts the app) and
scripts/e2e-community-home.mjs in the browser.

## 4c. API (Phase 3, landed) — all behind `communityGate()`, guest-optional, no writes

Router worker/routes/communitySearch.ts, mounted at `/api/community` after the social routes.
Every 200 carries `success: true`; refusals are `{ success: false, error, code }`. Nothing is
written: no new table, no search log, no query tracking — «recent searches» are the browser's
alone (`localStorage` key `levonis.communityRecent.v1`, ≤ 10 `{ term, at }`, versioned like
`recentlyViewed.ts`; emails, phones and one-character terms are never stored).

**No new visibility predicate.** Every section is the SQL its own list already publishes with —
`POST_PUBLIC_SQL` + `postExclusionSql` (Phase 2's block/mute exclusion for a signed-in viewer),
`communityDirectoryVisible` + `merchantBlockSql`, `creatorListSql` (the `/creators` rule, hoisted
out of the handler), `communityProductsVisible` + `merchantBlockSql` (a private product is
`status = 'hidden'` by 0152's trigger), `requestBoardVisible` plus a `NOT EXISTS user_blocks` both
ways on the request's customer — so a hidden post, a suspended store, a private product, a draft
or private request or a closed creator page is absent here because it is absent there. No email,
phone, bio, cost price or private title ever leaves a suggestion or a card.

**The block on a shop** (review of Phase 3): `merchantBlockSql(v, alias)` in worker/routes/community.ts
is the one `NOT EXISTS user_blocks` both ways between the viewer and the merchant's account,
ANDed into GET `/merchants` and GET `/products` themselves (the lists' own SQL, so the tab and the
overlay agree), and from there into the stores and products sections, the store suggestion lane,
and `/recommend` for a store or a product — both the anchor lookup (a blocked shop 404s, as a
blocked author's post does) and the rows. A shop knows no mute. The tag suggestion lane carries
`postExclusionSql` too, so a tag unique to a blocked author's post is not offered and then found
to lead to an empty page.

**Bounded, every one.** `q` is trimmed and refused past 60 code points (400
`SEARCH_QUERY_TOO_LONG`); a section reads at most `limit` rows (1–12, default 5) and its `total`
is `SELECT COUNT(*) FROM (… LIMIT 200)` — «+200» is the most a badge says; every LIKE goes through
`likePattern` (byte-bounded, wildcards literal); the catalogue index (`searchProducts`) is used
only where it is installed and ready, with the catalogue route's LIKE fallback otherwise;
`rateLimit('community-search', 120, 60)` per account or `CF-Connecting-IP` across all four routes
(429 `RATE_LIMITED`); an edge-cache hit for a guest is served before the limiter and costs no DB
beyond `communityGate()`'s one `admin_settings` read (the gate is mounted before every handler and
is the wall — accepted as is; memoising its verdict per isolate is the lever if `/trending`'s volume
ever matters). The tag lane of `/suggest` and `/recommend` for a post are windowed (30 and 180 days)
and pre-filtered before their `json_each` walk, so neither scans the whole published table.
Deferred: the limiter's D1 upsert is still paid once per `/search` and once per `/suggest` for a
member's keystroke (a guest's within a minute hits the edge); a cheap in-isolate pre-check in
worker/lib/ratelimit.ts would halve it and is outside this phase's files.

| Method, path | Who | Notes |
|---|---|---|
| GET `/api/community/search?q=&types=&limit=` | anyone | `{ q, sections: { projects, stores, creators, products, requests, materials, brands }, took_ms }` in that order; each section `{ rows, total, more }` (+ `error: true`, `rows: []`, `total: null` when its query threw — logged, the others still land). Rows are the EXISTING cards: `postCard` + `withViewerFlags`, `directoryCard` (+ `following`), the `/creators` card (`creatorCard`), the `/api/community/products` card (`communityFeedProduct`), the `/requests` card, and `{ id, slug, name, name_ar, imageUrl, href }` for catalogue materials (the `cat_materials` subtree via `catalogSubtreeFilter`) and active brands (`href` `/products?brand=<slug>`). `types` is a comma list that narrows (unknown names ignored, none = all); a section that did not run answers `total: null`; an empty `q` runs nothing. `more`: `/community/projects?q=`, `/community?tab=stores&q=`, `/community?tab=creators&q=`, `/community?tab=foryou&list=products&q=`, `/community?tab=requests&q=` (the tab reads `?q=`; the board page keeps its term in local state), `/products?search=…&category=cat_materials`, `/products?search=…`. All seven run in one `Promise.all`. Guest: `public, max-age=60` at the edge (every viewer predicate collapses at `''`, so two guests typing the same word share one answer; `took_ms` is the first guest's); member: `private, no-store` |
| GET `/api/community/search/suggest?q=` | anyone | `{ suggestions: [{ text, type: project\|store\|creator\|product\|tag, href }] ≤ 8, completion }` — names only: store names, creator name/username of page-only accounts, public post titles, catalogue product names (index or LIKE fallback), tags by prefix over public posts (`json_each`); round-robin across the lanes; `completion` is `suggestCompletion` over the ranked names (the ghost word). The tag lane reads the last 30 days' public posts the viewer may see (`postExclusionSql`). Under 2 characters → `{ suggestions: [], completion: null }`. Hrefs: `/community/store/<merchant id>`, `/u/<username>`, `/community/projects/<id>`, `/product/<slug>`, `/community/projects?tag=<tag>`. Guest: `public, max-age=60` at the edge; member: `private, no-store` |
| GET `/api/community/trending` | anyone | `{ projects (the /posts/trending SQL, 8), tags (top 12 over 30-day public posts), stores (6; completed `community_orders` in 30 d + `user_follows.created_at` in 30 d, ties by rating), creators (6; likes on public posts in 30 d, then followers; only accounts with a public post or a follower), totals: { merchants } (the guest directory's count, for the home's colophon) }` — viewer-independent by construction: post cards carry `viewer { liked:false, saved:false }`, store cards `following: false`; the client overlays `/me/social` and hides blocked/muted authors itself, as Phase 2's rails do. `public, max-age=300` for everyone |
| GET `/api/community/recommend?for=post:<id>\|store:<id>\|product:<id>&limit=` | anyone | «قد يعجبك»: `{ for, kind: projects\|stores\|products, rows }`, `limit` 1–12 default 6. Post: shared tags weigh 3, the material 2, the printer 1, over the last 180 days and only candidates that share something (pre-filtered before the card projection), never the anchor, blocked/muted authors excluded; the anchor must be PUBLIC for anyone but its author or staff (an unlisted piece is readable by link but is in no list, and a guest's answer is shared at the edge); store (a `community_merchants` id or a `merchant_stores` id): same governorate or overlapping categories, `accepts_custom_requests` first, never a shop across a block; product: other stores' visible products with the same category or material, never a blocked shop's. 404 `NOT_FOUND` when the anchor is not visible to the viewer (own drafts allowed for the author and staff; across a block, for a post, a store or a product); 400 `RECOMMEND_ANCHOR_INVALID` for a malformed `for`. Guest: `public, max-age=60`; member: `private, no-store`; a 404 is never stored |

**The edge cache** is `caches.default` under a CANONICAL key — the origin, the path and only the
route's declared parameters, sorted (`q`, `types`, `limit` for `/search`; `q` for `/suggest`;
`for`, `limit` for `/recommend`; none for `/trending`), as worker/routes/publicApi.ts's
`canonicalUrl` does, so an unknown or reordered parameter cannot mint a second entry
(`cacheKeyUrl`) — with the route's own `Cache-Control` re-stamped on a hit so the zone's browser
TTL cannot inflate it. A signed-in `/search`, `/suggest` or `/recommend` answer carries the
viewer's block/mute exclusions, so it is `private, no-store` and never reaches the shared cache.

Export-only changes to earlier routers: `POST_SEARCH` from worker/routes/communityPosts.ts;
`communityFeedProduct` from worker/routes/community.ts; `creatorListSql(q, v)`, `creatorCard(...)`
and `CREATOR_SEARCH` hoisted out of the `/creators` handler in worker/routes/communitySocial.ts
(identical SQL and output). One behavioural change to earlier routers: GET `/merchants` and GET
`/products` now AND `merchantBlockSql` for a signed-in viewer (a guest's lists are unchanged).

Refusal codes (ar/en/ckb in src/lib/refusalStrings.ts): `SEARCH_QUERY_TOO_LONG` (its Sorani is now
real, D6), `RECOMMEND_ANCHOR_INVALID` (new), `NOT_FOUND`, `RATE_LIMITED`.

**Client** (src/components/community/search/, all strings ar/en/real ckb in `strings.ts`):
`SearchOverlay.tsx` (lazy) opens from the home's search bar and from `/community/projects` on
focus/click/typing/↓ — a docked full-height panel under the bar on a phone (sheet spring, modal
lock, bottom nav hidden), a centred `max-w-2xl` panel from `sm`. The input is a `combobox`
(`aria-autocomplete="both"`: it lists rows AND draws an inline completion) naming ONE `listbox`
that owns nothing but `option`s and `group`s: the «ابحث في…» chip and the suggestions in one
group, each section a group labelled by its plain heading text with «الكل» as its last option,
the recent terms (each term, its «×» and «مسح السجل» all options, 44 px targets) and the trending
tags as groups of the empty state; the skeleton, an error, the «no results» copy and an
`aria-live="polite"` line (the sections' bounded counts, «no results», the grey word, a forgotten
term) sit beside the list, never inside it. Option ids are positional or server ids, never a typed
term. ↑/↓ through `aria-activedescendant`, Enter opens or submits, Delete (or Backspace over an
empty box) on a lit recent term forgets it, Escape closes and returns focus. A card inside an
option carries no follow pill (`StoreCard canFollow={false}`, `CreatorCard follow={false}`): the
card's page has it. `/suggest` at 200 ms and `/search` at 300 ms with `AbortController`; the
results block is one stable node whose rows reconcile by id and whose opacity alone moves
(CROSS_FADE) while a fresher answer is on its way. The ghost completion is drawn inside the page's
own bar (`src/components/search/ghost.ts`) and accepted by Tab, the end arrow or Space; the page's
input carries `dir="auto"` and the overlay leaves it there on close, so Latin text does not jump
across the field. Sections in the owner's order with the bounded count and «الكل» → `section.more`;
empty box → recent terms + trending tags; no results → trending chips under the copy; client-side
block/mute hiding. What the browser remembers is the chosen suggestion's own text or the searched
term, never the fragment behind a suggestion. THE URL CONTRACT: submit writes `?q=` on the current
tab at once; while the panel is open the page's own 300 ms `?q=` debounce is suspended (a keystroke
is the panel's two reads, not a third for a list behind a full-height panel — and «لك» is not
swapped for the projects search under it) and resumes the moment the panel steps aside.
`TrendingTags.tsx` («وسوم رائجة» under the cover, laid out from the home composite so it never
inserts itself later and shifts the first screen; `.lv-choice`'s own focus outline), `RecommendRail.tsx`
(lazy «قد يعجبك» / «متاجر مشابهة» on the project page and the community store page — on the store
page handed to `Storefront` as its `footer`, rendered by `StoreRenderer` INSIDE the store's theme
island so it wears the store's tokens; hidden on error or empty). The home composite
(`hub/useHomeData.ts`) folds the one 5-minute `/trending` read in: it gives the tag row, the makers
and stores rails and the colophon's merchant count, and the featured `/creators?featured=1` and
`/merchants` reads are asked only when trending has nothing to say — so the section set and its
numbering are decided once, at first paint. `useTrending()` remains for the overlay's empty state.
Nothing new is imported statically by src/pages/Storefront*.tsx (the store page imports Storefront,
not the reverse). CSS (D7): paid back before adding — dead animation rules retired and `@source
not` for docs/, worker/, migrations/, scripts/, studio/, services/ so Tailwind no longer emits
utilities mentioned only there; the build stands at 59.6 KB gzip of 60, the storefront closure at
46.3 KB of 47.

Tests: tests/communitySearch.test.ts (15 — every section is its list's own rule; `types` narrows
and unrun sections say `total: null`; 250 matches count as 200 and a section reads ≤ 12; the
61-character term; suggestions never carry an email, a phone, a bio-only match or a private title;
the block both ways and the mute, for the viewer and not for a guest; a blocked MERCHANT gone from
the stores, the products, the store suggestion, `/recommend` (anchor and rows) and GET
`/merchants` + `/products` themselves, both ways, present for a guest; a blocked or muted author's
tag not suggested and the tag lane windowed; trending from public posts, orders + follows and
30-day likes plus the directory count, `max-age=300` for guest and member alike; the three
recommend rankings, never the anchor, 404 for hidden/draft/private/unlisted/missing/blocked
anchors (the author may anchor their own), the 180-day window, 400 for a malformed `for`; the
zone-cache stub — a guest's suggest, search and recommend miss→store→HIT re-stamped `max-age=60`,
a member never stored; the canonical key — five unknown parameters on `/trending` mint one entry
and reordered parameters share one; the 121st request → 429 per address; Arabic and Latin both
match, diacritics folded through the index), tests/communitySearchUi.test.ts (11 — lazy chunks,
storefront isolation, the store page's rail inside the theme island, the combobox and its
keyboard, the listbox owning options and groups only, option ids free of user text, the live
region, no follow control in the panel, the URL debounce suspended under the open panel,
`dir="auto"`, one stable results node, 44 px targets, the trending chips' focus outline, no
`<button>` in `<a>`, tokens only, ar/en/ckb parity with real Sorani, bounded counts, `recent.ts`
stores a term and a time and refuses PII, the CSS payback), tests/refusalStrings.test.ts (the new
codes); scripts/e2e-community-home.mjs (focus opens the overlay, recent + trending in the empty
state with the listbox owning options and groups only, Delete forgets a lit term, Escape keeps
focus, suggestions then the sections in order as labelled groups with 44 px «الكل», no follow
pill, the live region filled, the URL and the issue holding still under the open panel, the
results node surviving a keystroke, the `?q=` contract resuming on close, a click reopening on the
same term, ↓↓ + Enter navigates — 750 checks over ar/en/ckb × dark/cream × 360/1280, no page
errors, no horizontal overflow with the overlay open) and scripts/e2e-projects.mjs (247).

## 4d. API (Phase 4, landed) — files, viewer grants and link cards

Migrations 0156 (`upload_sessions`; `file_objects` + `sha256`, `purpose`), 0157 (`product_files`,
`product_file_grants`, `community_post_files`, `viewer_grants`; `model_view_tokens` + `source_type`,
`source_id`), 0158 (`link_cards`). Routers: worker/routes/uploadSessions.ts (mounted at
`/api/uploads/sessions`, `requireAuth` on `*`), worker/routes/productFiles.ts (`merchantProductFileRoutes`
under `/api/merchant`, `publicProductFileRoutes` at `/api/product-files`), worker/routes/communityPosts.ts
(files on posts, under `/api/community`), worker/routes/printRequests.ts (the shared viewer),
worker/routes/linkCards.ts (`/api/link-cards`), worker/routes/chats.ts (link messages),
worker/routes/uploads.ts (the whole-body door, changed), worker/routes/adminCommunity.ts (limits).
Every 200 carries `success: true`; refusals are `{ success: false, error, code }` and every code is
localised in src/lib/refusalStrings.ts (ar/en/ckb). Entity rules for BOTH upload doors live in one
place, `assertUploadEntity` (worker/lib/uploadEntity.ts).

| Method, path | Guard | Refusal codes |
|---|---|---|
| POST `/api/uploads/sessions` `{purpose, entity_id?, file_name, bytes, mime, sha256}` → 201 `{session_id, chunk_bytes, parts_total, expires_at}` | `requireAuth`; `rateLimit` `upload-session` 30/h; purpose ∈ post\|community\|chat\|request\|product_file (`offer`/`order_update` return with their consumer routes — review 2026-09-30); `assertUploadEntity`; limits from `uploadLimits`, quota from `uploadQuotas` — the owner's LIVE objects **plus their open, unexpired sessions**, so sessions opened in turn cannot each pass the same cap | 400 `UPLOAD_KIND_NOT_ALLOWED` {extension, purpose}, `UPLOAD_TOO_LARGE` {limit_bytes, kind}, `UPLOAD_QUOTA_EXCEEDED` {limit_bytes, used_bytes, purpose}; 403 `STORE_REQUIRED` (community, product_file), chat non-participant, `CHAT_READ_ONLY`; 404 a stranger's request/product; 409 `REQUEST_NOT_EDITABLE` |
| PUT `/api/uploads/sessions/:id/parts/:n` (raw `application/octet-stream`, `n` 1-based) → `{received[], bytes_so_far, parts_total}` | owner only; `rateLimit` `upload-part` 3600/h; non-final parts exactly `chunk_bytes`; idempotent per `n` (CAS on `parts_json`) | 404 `UPLOAD_SESSION_NOT_FOUND` (anyone else, closed, expired, or the upload already assembled/aborted on the bucket while the part was in flight); 400 `UPLOAD_PART_TOO_LARGE` {chunk_bytes, expected_bytes, part}; plain 400 past the end |
| GET `/api/uploads/sessions/:id` → `{session_id, state, received, bytes_so_far, declared_bytes, chunk_bytes, parts_total, expires_at}` | owner only; `rateLimit` `upload-session-read` 600/h | 404 `UPLOAD_SESSION_NOT_FOUND` (also aborted/expired) |
| POST `/api/uploads/sessions/:id/complete` → `{key?, url, visibility, mime, bytes, sha256, width, height, analysis?, warnings?, file?}` (`key` only for post\|community\|product_file; `file` = the `community_request_files` row for `request`) | owner only; `rateLimit` `upload-session-close` 120/h; the quota asked AGAIN (this session left out of the count) before the ledger row, then head + tail sniff, ZIP central-directory bound, streamed SHA-256; every refusal deletes the object and aborts the session | `UPLOAD_QUOTA_EXCEEDED`, `UPLOAD_INCOMPLETE` {missing, bytes_so_far, declared_bytes}, `UPLOAD_KIND_NOT_ALLOWED` {declared, detected}, `VIDEO_UNSUPPORTED`, `IMAGE_HEIC_UNSUPPORTED`, `ARCHIVE_TOO_DEEP`, `CHECKSUM_MISMATCH` {declared, actual}, `UPLOAD_TOO_LARGE` (glTF > 4 MiB); warning `VIDEO_NOT_FASTSTART` |
| DELETE `/api/uploads/sessions/:id` → `{state}` | owner only; `rateLimit` `upload-session-close` 120/h; aborts the R2 multipart upload | 404 `UPLOAD_SESSION_NOT_FOUND` |
| POST `/api/uploads` (changed) | `requireAuth`; `SIMPLE_UPLOAD_PURPOSES` (unchanged set); `uploadLimits` capped at `SIMPLE_UPLOAD_HARD_CAP` 40 MiB; writes `file_objects.purpose` | `UPLOAD_TOO_LARGE` {limit_bytes}, `UPLOAD_QUOTA_EXCEEDED` (post_gb) |
| PATCH `/api/admin/community/settings` `{uploadLimits?, uploadQuotas?}` | any admin (a pre-handler before the financial one; fee keys still need the financial scope); audit `admin.upload_limits` {before, after} | 400 outside the bounds (image_mb 1..1024, video/model/archive_mb 1..4096, document_mb 1..1024, chunk_mb 5..40, session_hours 1..168, quotas 0..1024 GB) |
| GET `/api/merchant/products/:id/files`; POST `{file_key, role, name?, position?}`; PATCH `/:fid` `{role?, name?, position?}`; DELETE `/:fid`; PUT `/order` `{ids[]}` | `requireAuth` + `storeForUser` + the product of that store; `rateLimit` `product-file-write` 120/h; the key must be the caller's own PRIVATE `file_objects` row with purpose `product_file`; audit `merchant.product_file_added/updated/removed` | `PRODUCT_FILE_NOT_OWNED`, `PRODUCT_FILE_LIMIT` (12), `PRODUCT_FILE_ROLE_INVALID`, `PRODUCT_FILE_ORDER_INVALID`, `PRODUCT_FILE_NOT_FOUND`; 404 another store's product |
| GET `/api/product-files/:slug/:productId` → `{files:[{id, role, name, bytes, kind, has_preview, downloadable, granted}]}` | guest OK; `anonymousCached` (`perViewer: true`, no params); never a key; the store and the product are read in ONE wave and a member's grants ride in the files statement; `granted` on the `preview` row = a LIVE grant on any file of the product (the buyer's viewer link then opens the full mesh); the product read (`/api/storefront/:slug/products/:productSlug`) carries `file_count`, and the page asks here only when it is not 0 | 404 |
| POST `/api/product-files/:slug/:productId/:fid/viewer-token` → `{token, url:'/model-viewer/<token>', expires_at, grant}` | guest OK (bound to SHA-256(`CF-Connecting-IP`+UA+day) — never `X-Forwarded-For`) or the account; `rateLimit` `viewer-token` 60/h; grant `preview` for the preview role, `full` for the owner and for a BUYER = an account holding a live grant on any file of the product (`hasProductGrant`; the preview role itself is never granted) | `PRODUCT_FILE_NOT_FOUND`, `NO_PREVIEW`, `VIEWER_NOT_ALLOWED` |
| GET `/api/product-files/:slug/:productId/:fid/download` (attachment, nosniff, sandbox CSP; counted; audit `product_file.downloaded`) | signed-in holder of a LIVE `product_file_grants` row (written inside the store checkout batch for download_after_purchase\|source_model\|reference\|instruction; **revoked inside `cancelStoreOrder`'s batch when the order is cancelled and refunded** — re-pointed at another live order of the buyer that covers the product, deleted otherwise — and dead at the door in any case once its order is `cancelled`: `liveGrantSql`) or the owner; `rateLimit` `product-file-download` 120/h; a purchase outlives a hide | 404 guest; 404 a signed-in non-holder once the product is hidden/archived (no oracle on a withdrawn product's file ids); 403 `PRODUCT_FILE_NOT_GRANTED` on a shown product |
| POST/PATCH `/api/community/posts` `files[]` `{file_key\|key, name?, downloadable?}`; GET `/posts/:id` → `post.files[]` `{id, name, bytes, kind, downloadable, has_preview, key? (author/admin only)}` | the post's own guards; model\|document only, from a `post` PRIVATE key of the author (a `community` upload is public and can never be one) | `POST_FILE_LIMIT` (3), `POST_FILE_NOT_OWNED`, `POST_FILE_KIND` |
| POST `/api/community/posts/:id/files/:fid/viewer-token` | guest OK on a public post (session-bound), the author always; `rateLimit` `viewer-token` | `POST_FILE_NOT_FOUND`, `NO_PREVIEW`, `VIEWER_NOT_ALLOWED` |
| GET `/api/community/posts/:id/files/:fid/download` (attachment; counted; audit `community.post_file_downloaded`) | `requireAuth`; `downloadable` or the author; `rateLimit` `post-file-download` 120/h | 403 `POST_FILE_NOT_DOWNLOADABLE`, `POST_FILE_NOT_FOUND` |
| GET `/api/marketplace/print/viewer/:token` (+ `source_type`, `name`), GET `…/:token/mesh` | `model_view_tokens` first, then `viewer_grants`; the source's live visibility re-checked on every read — and, for an account-bound post link, a block between reader and author (`blockedEither`, worker/lib/userBlocks.ts); revoked on archive/delete/private/hide/unpublish | 404 `VIEWER_TOKEN_INVALID` |
| POST `/api/link-cards/resolve` `{url}` → `{card}` | `requireAuth`; `rateLimit` `link-card` 60/h; off-list host → bare card `status: 'blocked'` with NO fetch; the allow-list holds on EVERY hop (`guardedFetchBytes` `allowHost`): a listed host redirecting off it is refused before the landing page is requested, and a picture is fetched only from a listed host or one of the picture hosts the listed pages use (`imageHostAllowed`) | 400 `LINK_URL_INVALID`, `LINK_HOST_BLOCKED` (`LINK_FETCH_FAILED` rides as `card.reason`, never thrown) |
| GET `/api/link-cards?url=` → `{card}` | guest OK; session-free (`sessionFreePublicGet`: the body has no per-viewer field, so a member's feed hits the colo entry too); `anonymousCached` params `['url']`; stored rows only, never fetches | 404 `NOT_FOUND` |
| POST `/api/chats/:id/cards/link` `{url, client_id}` → 201 `{id, message, card}` / 200 `{…, replayed: true}` | `requireAuth`; `assertMayWriteInThread`; `rateLimit` `chat-send` 200/h + `link-card` 60/h; the message is kind `text`, body = URL, `card_snapshot` `{type:'link', …}`; readers get `message.link` | `LINK_URL_INVALID`, `LINK_HOST_BLOCKED`; 403 non-participant |

Notifications: `files_added:<chatId>` (people, not files; Sorani stamped into meta) and
`request_files:<requestId>` (owners of matched merchants ∪ merchants with a live offer, before the
re-match). Cron: `sweepExpiredUploadSessions` (abort + `expired`, ≤ 200 per tick; closed rows deleted
after 7 days). Key placement (`placementFor`): post image/video → public `users/<uid>/posts/`; post
model/document → private `users/<uid>/post-files/`; community → public `merchants/<uid>/public/`;
chat → private `chat/<chatId>/…`; request → private `requests/<uid>/files/`; product_file → private
`merchants/<uid>/product-files/` (`offer` → `merchants/<uid>/offers/` and `order_update` →
`orders/<orderId>/updates/` are reserved for the day their consumer routes exist and are not
session purposes yet); link cards → public `link-cards/<id>.webp`; previews →
`product-previews/<productId>/<fileId>.lvm`, `post-previews/<postId>/<fileId>.lvm`. Private keys
under the new prefixes answer 404 through `GET /files/*`; consumers serve them through the gated
routes above.

## 5. Client (Phase 1, landed)

- `/community/projects` — the list with kind chips, a tag chip and server search (pages/community/Projects.tsx; `ProjectsGrid` is reused by the home's «المشاريع» tab in Phase 2).
- `/community/projects/:id` — the project: snap media strip (one moving dot, tap-to-play video, arrows for a pointer), kicker + title + byline, counts hidden at zero, the spec list, the story, tags, the doors (store, product with price, material), the author's banners and menu, the asked customer's consent card, «اطلب طباعة مثلها» as the one accent verb on a sticky bar above the bottom nav. Two columns from `lg`.
- `/community/projects/new`, `/community/projects/:id/edit` — the composer: pictures first (`ProjectMediaPicker`, purpose=post, cover = first), title, kind chips, story, the facts with catalogue pickers for printer and material, tags, the store link for a store owner, visibility, save-draft / publish under the thumb.
- `/u/:username` — the creator: avatar, kicker, name, handle, badges, bio, stats, tabs «المشاريع | نبذة» (store card with follow, member since, printers, materials, website, socials).
- Profile «مشاريعي» tab (states, pending consent, hides) and the profile editor's «صفحتي العامة» switch with printers / materials.
- Browser fixture tests/browser/projects.html + scripts/e2e-projects.mjs: 101 checks over ar/en/ckb × dark/cream × 360/1280 (landmarks, no horizontal overflow, no page errors).

## 6. Phases

1. **Projects + creator profiles** — landed (this document, §3–5). Tests: tests/communityPosts.test.ts (11).
2. **Social graph + Feed V3** — landed (§4b, docs/COMMUNITY_HOME_PLAN.md). 0154 tables and counter triggers, 0155 (comment `client_id` replay key, creators index); like/save/comment/follow-creator/block/mute/report endpoints with rate limits and idempotency; grouped notifications (`ON CONFLICT` upsert on a grouping key + count); the community home rebuilt to the «العدد» plan (masthead, quick actions, six tabs, cover story, numbered sections, rails, the feed, tools, colophon; springs from `useMotion()`, skeletons at exact heights, `bg-canvas` tokens, ≤ 1 new CSS rule).
3. **Unified search + discovery** — landed (§4c, §9.3). One `/api/community/search` over projects, stores, creators, products, requests, materials, brands (LIKE + the catalogue index where it exists, every section its own list's SQL, bounded rows and counts), `/search/suggest` from names only, `/trending` from counters that exist, `/recommend` beside a post, a store or a product; no new table, no query log; the lazy search overlay, «وسوم رائجة» and the «قد يعجبك» rails on the client; the CSS budget paid back before it was spent. Tests: tests/communitySearch.test.ts (12), tests/communitySearchUi.test.ts (10).
4. **3D asset platform + files (§27–35)** — landed (§4d, §9.4). Resumable multipart sessions with a streamed SHA-256 verify, admin-configurable limits and per-purpose quotas, head+tail sniffing with the ZIP central-directory bound (and the same filter inside `parse3mf`/`parseAmf`), files with roles on products and posts, grants written at checkout, the shared viewer over `viewer_grants`, link cards behind an allow-list with re-hosted pictures as ordinary chat messages, grouped `files_added`/`request_files` notifications; the client: `uploadLarge` + `UploadTile` in the project media picker, the request wizard, the chat picker, the post composer and the product-files editor; link cards in chat, comments and posts. Tests: tests/uploadSessions.test.ts (10), tests/uploadSession.client.test.ts (12), tests/productFiles.test.ts (12), tests/postFiles.test.ts (6), tests/linkCards.test.ts (14), tests/postFilesUi.test.ts (9), tests/productFilesUi.test.ts (13), tests/linkCardsUi.test.ts (11). Review fixes 2026-09-30 (DECISIONS row 177): refund revokes grants, buyer per product, quota counts open sessions, allow-list per hop, `offer`/`order_update` withdrawn.
5. **Workshop profiles + matching + offers V2 + the request page (§21–26, 36)** — structured workshop profile in the store settings feeding `loadCandidates`; offers gain delivery fee, attachments, validity, `draft`/`revised` semantics and re-acceptance; request discussion; execution timeline with `ready` and progress photos; the consolidated request page in the owner's order; merchant cancel/dispute.
6. **Moderation V2 + Reputation V2 + dispute access** — reports on every target, post hide route + UI, user suspend/ban with enforcement, appeals, audit viewer; explainable badges computed from measured response time and completion rate; staff read of `store`/`request` threads only while a linked order is disputed, audited.
7. **Analytics + collections + activity centre + draft preview** — post view beacon (same privacy rules), creator and merchant dashboards, private saved collections, the activity centre, the draft preview surface off the storefront budget.
8. **Performance, accessibility, localisation, verification, deploy** — cursor paging everywhere, lazy media, virtualised long lists, 44 px targets, full RTL, ckb everywhere new, the whole test plan green, deploy after the owner's word.

## 7. Test plan (the brief's list, mapped)

| Brief | Test |
|---|---|
| follow spam, like replay, save replay | Phase 2: idempotent PUT/DELETE, `rateLimit` buckets, counters unchanged on replay |
| comment ownership | Phase 2: only the author edits/deletes; the post author may hide |
| project privacy | tests/communityPosts.test.ts: draft/private/unlisted/hidden matrix (done) |
| private file access | tests/productFiles.test.ts, tests/postFiles.test.ts, tests/uploadSessions.test.ts: a stranger is 404 at every session step; the shopfront list never carries a key; download 404 guest / 403 non-buyer / 200 attachment for the buyer with no key in any header; a hidden post's viewer token answers 404 (done) |
| creator block rules | Phase 2: a blocked user cannot DM, follow, comment or see the page |
| moderation bypass | Phase 6: hidden post is 404 to all but author/staff on every read path (feed, trending, search, creator grid) |
| hidden project in search | tests/communitySearch.test.ts: the hidden, draft and private posts are in no section and no suggestion, out of the trending tags and projects, never a recommendation and no anchor for one — 404 `NOT_FOUND` (done) |
| banned store in recommendations | tests/communitySearch.test.ts: a suspended store is out of every section and of `/recommend` — `communityDirectoryVisible` is the only rule (done); the ban itself and its enforcement are Phase 6 |
| forged linked product | tests/communityPosts.test.ts (done) |
| file ownership spoof | tests/communityPosts.test.ts media keys (done); tests/productFiles.test.ts / tests/postFiles.test.ts: a public, foreign or unknown key is `PRODUCT_FILE_NOT_OWNED` / `POST_FILE_NOT_OWNED`; a forged `.stl` that is a PNG is classified by bytes (tests/uploadSessions.test.ts) (done) |
| staff dispute access audit | Phase 6 |

## 8. Open questions for the owner

- **Q1** Should turning the creator page off also unlist the account's published projects? Today they stay public without the author link (D4).
- **Q2** Should the older «works» rail (`merchant_showcase`) be migrated into projects, or kept as the store's own portfolio strip? The plan keeps it for the stores rail and lets the feed be posts.
- **Q3** Following a creator who owns a store: one follow or two? Proposal: one `user_follows` row, and the store's follower count includes creator followers of its owner.
- **Q4** Should draft and private posts' pictures move to a private prefix served through a signed URL (cost: a fetch per picture)? Today the URL is unguessable but public (D11).
- **Q5** Sorani in notifications: add `title_ckb`/`body_ckb` columns to `user_notifications`, or keep ar/en with the merchant feed's meta trick?

## 9. Phase specifications

### 9.0 Numbering

Migrations in these specs are named by ROLE; the file number is the next free one at merge (`ls migrations | tail -1` + 1) — 0155 was taken by the Phase 2 review fix (`0155_community_comment_replay.sql`) while §9 still spoke of it. The same rule holds for docs/DECISIONS.md rows: the next free row when the phase lands. The merchant programme (docs/MERCHANT_PLATFORM_V2.md §C.3) shares the sequence.

Written before each phase's workflow so the builders code against one text.
Each spec names the tables (additive), the routes with their guards and
refusal codes, the client surfaces, and the tests that prove it.

### 9.4 Phase 4 — The 3D asset platform and files (§27–35) — LANDED (§4d)

**Landed 2026-09-29 — deviations from the specification below** (the spec is kept as written; the
routes, guards and codes as built are in §4d):

- **Migrations**: 0156 `asset_platform` (sessions, `file_objects.sha256`/`purpose`), 0157
  `product_and_post_files` (`product_files`, `product_file_grants`, `community_post_files`,
  `viewer_grants`, `model_view_tokens.source_type`/`source_id`), 0158 `link_cards` — post files and
  the viewer columns landed in 0157, not 0158.
- **`viewer_grants` is its own table**: product and post viewer tokens live there (60 min, SHA-256
  hashed, bound to the account or to SHA-256(IP+UA+UTC day) with a one-day grace, the source's live
  visibility re-checked on every read); `model_view_tokens` keeps request tokens and only gained the
  `source_type`/`source_id` columns. Column `grant_level` mirrors the older table; the API field is `grant`.
- **Link cards are ordinary chat messages**: 0150's `card_type` CHECK was not rebuilt; a link line is
  kind `text`, body = the canonical URL, `card_type` NULL, `card_snapshot` `{type:'link', card_id, url,
  host, title, description, image_url, kind}`; readers get `message.link`. Request comments do not
  exist as a table; the comments surface that cards links is the post comments sheet.
- **Final mount paths**: the public product side is `/api/product-files/:slug/:productId[/:fid/…]`
  (not under `/api/storefront`), the merchant editor `/api/merchant/products/:id/files`, link cards
  `/api/link-cards`. The public list also answers `granted` beside `downloadable`.
- **Grants** are written inside the store checkout batch (not a paid/delivered transition) for
  download_after_purchase, source_model, reference and instruction (the spec's own prose says the
  last two are «downloadable after purchase»); the community-order funded transition grants nothing
  because a community order carries no product id (`productFileGrantStatement` already accepts
  `communityOrderId` for the day it does).
- **Complete** answers `url` and no key for `chat` and creates NO message row — the client posts the
  message with the session's key (a server-side message on complete is a chat-wave follow-up); for
  `request` it inserts the `community_request_files` row (cap 6) but does not replay the marketplace
  route's revise/supersede statements for a published request with pending offers. Video is sniffed
  from the first 64 KiB (a non-faststart MP4 is accepted with the `VIDEO_NOT_FASTSTART` warning).
- **`.zip` is refused at session creation** (the `EXTENSION` allow-list has no zip; `archive_mb` waits
  for the day it is admitted); `merchants/<uid>/offers/` stays reserved for `offer` keys (no `offers`
  domain, and no `offer` session purpose, until the offer composer uploads).
- **Whole-body `POST /api/uploads`** keeps a 40 MiB hard cap whatever `image_mb`/`video_mb` say;
  larger files take sessions. Post files ALWAYS take a session (the simple door files `post` under
  the public `posts/` prefix, which the post API refuses).
- **No offer composer upload exists** in the tree, so the `UploadTile` is adopted in the request
  wizard, the project media picker and composer, the chat picker and the product-files editor only —
  and `offer` / `order_update` are NOT session purposes until those routes exist (a completed
  session must never answer a key nothing can consume; review 2026-09-30).
- **Grouped `request_files`** counts people (the grouped contract): a second batch from the same
  customer does not re-surface a read row.


**Measured substrate** (survey 2026-09-29): `POST /api/uploads` reads the
whole body (`formData()` → `arrayBuffer()`), images 8 MiB / video 40 MiB /
chat documents 10 MiB, purposes receipt|avatar|chat|product|community|support|
complaint|post, `file_objects` ledger without a checksum column, response
carries the key; request files go through `POST /api/marketplace/requests/:id/files`
(owner only, 6 per request, `classifyAttachment`, key hand-built as
`requests/<uid>/<id>.<ext>`, private, `fileReader` access levels
download|view|preview|none, every read logged in `request_file_reads`);
`classifyAttachment` recognises JPEG/PNG/GIF/WebP/PDF/3MF/AMF/GLB/binary+ASCII
STL/OBJ/STEP/glTF; `parse3mf`/`parseAmf` call `unzipSync` unfiltered (the
zip-bomb hole; the bounded filter to copy is worker/routes/template.ts:3455);
the viewer: `model_view_tokens` (hash, 60 min, grant preview|full,
`bound_user`), `viewerMesh` → LVM1 ≤ 250k triangles, `GET /viewer/:token`
+ `/mesh`, `src/pages/ModelViewer.tsx` (ogl); chat files under
`chat/<chatId>/` served by participant check; product media
`community_product_media` (image|video, ≤12, 2 videos) with no downloadable
files; no multipart anywhere; limits are constants; `GET /files/*` supports
Range/206 and serves public keys through the edge cache.

**Migration `asset_platform` (additive; number = next free at merge)**

```
upload_sessions        id, owner_id → users, purpose, entity_id, file_name, declared_bytes, declared_mime,
                       sha256 (hex, client-declared, verified on complete), chunk_bytes, r2_upload_id,
                       object_key (final), parts_json ('[]': [{n, etag, bytes}]),
                       state CHECK (open|completed|aborted|expired), expires_at, created_at, updated_at
file_objects           + sha256 TEXT, + purpose TEXT NOT NULL DEFAULT ''
product_files          id, product_id → community_products CASCADE, store_id → merchant_stores, file_key (private
                       prefix merchants/<uid>/product-files/…), role CHECK (preview|download_after_purchase|
                       reference|instruction|source_model), name, bytes, mime, kind (model|document|image|archive),
                       analysis JSON, preview_key, position, created_at
product_file_grants    id, product_file_id → product_files CASCADE, user_id → users, order_id (store order) NULL,
                       community_order_id NULL, granted_at, expires_at NULL, downloads INTEGER 0
                       UNIQUE (product_file_id, user_id)
link_cards             id, url, host, title, description, image_key NULL, kind CHECK (model_page|video|article|
                       unknown), fetched_at, status CHECK (ok|blocked|failed), created_at   -- one row per URL, reused
chat_messages          card_type gains 'link' and 'file' (0150's CHECK is a comment-only list? — verify; if a CHECK
                       exists, rebuild is NOT allowed: store link/file cards as card_type 'link'|'file' only if the
                       CHECK admits them, else as kind 'text' with card_snapshot and card_type '' — decide in code review)
admin_settings         keys uploadLimits: { image_mb, video_mb, model_mb, archive_mb, document_mb, chunk_mb,
                       session_hours } with SETTING_DEFAULTS (image 25, video 100, model 300, archive 500, document
                       25, chunk 8, session 24), editable by PATCH /api/admin/community/settings (financial scope
                       not required — a new admin.upload_limits audit)
```

**Upload sessions (multipart, resumable)** — `worker/routes/uploadSessions.ts`,
mounted at `/api/uploads/sessions`, `requireAuth`, rate `upload-session` 30/h:

| Method, path | Behaviour |
|---|---|
| POST `/` `{purpose, entity_id?, file_name, bytes, mime, sha256}` | validates purpose ⊂ {post, community, chat, request, product_file, offer, order_update}, the entity (same checks `POST /api/uploads` runs: thread participant, request owner, store owner…), the declared size against the purpose's limit from `uploadLimits`, and the extension against `EXTENSION`; creates the R2 multipart upload (`bucket.createMultipartUpload(key)`) under the purpose's prefix via `buildMediaKey`; returns `{ session_id, chunk_bytes, expires_at }` |
| PUT `/:id/parts/:n` (raw body) | owner only; `n` 1-based; body ≤ chunk_bytes (+ the last part smaller); `resumeMultipartUpload(key, uploadId).uploadPart(n, body)`; records `{n, etag, bytes}`; idempotent per n (a re-sent part replaces); answers `{ received: [n…], bytes_so_far }` |
| GET `/:id` | the resume point: `{ state, received parts, bytes_so_far, expires_at }` |
| POST `/:id/complete` | verifies every part present and `SUM(bytes) = declared_bytes`; `complete(parts)`; then reads the first 64 KiB and the last 64 KiB for sniffing (`classifyAttachment` / `sniffVideo` on the head) and streams the object through `crypto.subtle.digest('SHA-256')` in 1 MiB slices to verify the declared `sha256` (on mismatch: delete the object, `CHECKSUM_MISMATCH`); for zip-based formats (3MF/AMF/ZIP) opens the central directory and refuses when entries > 2 000 or the declared uncompressed total > 8× the compressed size or > the model limit (`ARCHIVE_TOO_DEEP`) — the same bound goes into `parse3mf`/`parseAmf` via an `unzipSync` filter; writes `file_objects` (+sha256, purpose) and answers `{ key?, url, mime, bytes, sha256, analysis? }` — the key only for purposes whose consumers send it back (post, community, product_file, offer, order_update), never for chat/request (they answer with the message/file row) |
| DELETE `/:id` | abort (`abortMultipartUpload`) |

Sessions expire after `session_hours` (cron sweeps `open` sessions past
`expires_at`: abort + delete). `POST /api/uploads` stays for small files and
gains the same configurable limits and sniffing; the client picks the session
path above 8 MiB or when the file is a model/archive.

**Client** — `src/lib/uploadSession.ts`: `uploadLarge(file, purpose, {entityId, onProgress, signal})`
→ SHA-256 in a Web Worker (`crypto.subtle` over slices), session create,
parts in sequence (2 in flight), progress events, `AbortSignal` cancel,
exponential retry per part (3×), resume from `GET /:id` after a reload
(session id kept in `sessionStorage` per file fingerprint); a shared
`UploadTile` (progress ring, «إلغاء», «إعادة المحاولة», bytes/total, the
checksum step named) used by the request wizard, the project composer, the
offer composer, the chat attachment picker and the product-files editor;
mobile: `<input capture>` for photos, the picker accepts multiple, big files
warn on cellular with the size.

**Files on products** — merchant editor (`ProductFilesEditor` in the catalogue
form): add/remove/reorder, role per file, name; `POST/PATCH/DELETE
/api/merchant/products/:id/files` (store owner; a `product_file` upload's key
must sit under the owner's prefix and in `file_objects`); the storefront
product page lists files by role: `preview` (a viewer token minted through a
new `POST /api/storefront/:slug/products/:id/files/:fid/viewer-token`, grant
preview, 60 min, bound to the viewer or the anonymous session hash),
`reference`/`instruction` (open to read after purchase only when the merchant
says so — flag `public_before_purchase` on the row? NO: keep roles strict:
reference/instruction are visible to everyone as names, downloadable after
purchase), `download_after_purchase`/`source_model` (only through
`product_file_grants`: granted in the store-order paid/delivered transition
and the community order funded transition, one grant per buyer per file,
download counted, `GET /api/storefront/:slug/products/:id/files/:fid/download`
streams with `Content-Disposition: attachment` after the grant check — never
a public key, never `/files/<key>`; every download logged).

**Link cards** — `POST /api/chats/:id/cards/link {url}` and the same for
request comments and post bodies: `validateOutboundUrl` (http/https only,
no javascript:/data:/file:, private ranges blocked, ≤ 2 KB), host allow-list
for previews (printables.com, thingiverse.com, makerworld.com, cults3d.com,
youtube.com/youtu.be, instagram.com, tiktok.com, github.com — everything
else gets a bare card with the host only), a fetch with a 5 s budget,
2 MiB cap, `text/html` only, OG title/description/image parsed from the
first 256 KiB, image re-hosted through the IMAGES binding into a public
`link-cards/` key (never hot-linked), one `link_cards` row per URL reused for
24 h; the card renders title/host/image with `rel="noopener noreferrer
nofollow"` and opens in a new tab; the model-page kind offers «اطلب
طباعته» which pre-fills the wizard's link source.

**The shared viewer** — `src/pages/ModelViewer.tsx` becomes the one viewer for
request files, product previews and post attachments through the token
routes; the mint endpoint per source (request: exists; product: above; post:
`POST /api/community/posts/:id/files/:fid/viewer-token`, public posts →
anonymous grant `preview`, bound to a session hash instead of a user); the
LVM mesh stays the only bytes a viewer receives; tokens revoked when the
source closes/hides (existing `revokeViewerTokensStatement` pattern with a
`source_type` column added to `model_view_tokens` in 0158 — nullable, default
'request').

**Post attachments** — `community_post_files` (0158): id, post_id, file_key
(private `users/<uid>/post-files/…`), kind (model|document), name, bytes,
analysis, preview_key; the composer adds «ملف المجسم (اختياري)»; the project
page lists files as rows (name, size, «عرض ثلاثي الأبعاد» via token; the
download of the original only when the author ticks `downloadable` and the
viewer is signed in — logged).

**Grouped file notifications** — the Phase 2 `notifyGrouped` with keys
`files_added:<threadId>` («أرسل أحمد 4 ملفات») and `request_files:<requestId>`
for the merchants on a request's matches.

**Protections** — bytes sniffed (head) + structure checked (zip central
directory bound, STL count arithmetic, glTF JSON parse with a 4 MiB cap,
STEP header) before any byte is stored permanently; forged MIME ignored
(`declared_mime` is a hint); path traversal impossible (`buildMediaKey`
segments only, extension from the sniff); per-owner quotas by purpose
(`uploadQuotas` setting: post 2 GiB, product_file 5 GiB, request 1 GiB,
counted from `file_objects` PLUS the owner's open, unexpired sessions, and
asked again on `complete` with the session left out — so neither sessions
opened in turn nor two opened in one instant pass the same cap twice);
download grants that die with the money — `cancelStoreOrder` revokes the
grants an order paid for inside the batch that refunds it, and a grant whose
order is `cancelled` is not live at any door (`liveGrantSql`); the link-card
allow-list held on every fetch hop, pictures included; `X-Content-Type-Options: nosniff` and the
sandbox CSP on every `/files` and download response (exist); a preview
image is generated for models by the existing analyse path (`preview_key`)
and served with `Cache-Control: private` for private sources.

**Tests** (`tests/uploadSessions.test.ts`, `tests/productFiles.test.ts`,
`tests/linkCards.test.ts`): a session by another user is 404 at every step;
parts over the chunk size refused; complete with a missing part refused;
checksum mismatch deletes the object; a zip with 5 000 entries or a 100×
ratio is refused before storage; a forged `.stl` that is a PNG is classified
by bytes; the product download without a grant is 404 for a stranger and 403
for a signed-in non-buyer, 200 with `attachment` for the buyer, and never
returns a key; a refunded order takes its grants back (and a second paid
order keeps them); a buyer's viewer link on the preview carries `full`; a
hidden product's file ids answer a stranger 404; the viewer token for a hidden
post is revoked; link cards refuse `javascript:`, `file:`, `data:`,
`http://10.0.0.1/` and never fetch without the allow-list — on any hop, an
off-list `og:image` included; the admin limit change is audited and applied on
the next session; quotas count live objects and open sessions and are asked
again on complete.

### 9.5 Phase 5 — Workshop profiles, matching, offers V2, the request page (§21–26, 36)

**What exists and is kept as is** (survey §1.5): the eligibility engine
(`evaluateEligibility`, `loadCandidates`, `matchRequest`/`matchMerchant`,
the re-match queue and cron), the notice `matching_request` with dedup key
`print_request_match:<requestId>`, the eligibility-fenced offer INSERT,
offer revisions (`community_offer_revisions`, `superseded → pending` on
reconfirm/edit, `OFFER_STALE` on a stale accept), the atomic accept
(`reserveEscrowFunds` then one batch: request → in_progress, offer →
accepted, rivals → rejected, `community_orders` funded with offer/request/
contact snapshots), the order state machine and escrow rules (delivered never
releases; only confirm or the auto-complete sweep do; disputes hold).

**Migration `offers_v2_timeline` (additive; number = next free at merge)**

```
community_offers      + delivery_fee_iqd INTEGER NOT NULL DEFAULT 0 CHECK (>= 0)
                      + quantity INTEGER, + color TEXT NOT NULL DEFAULT '', + terms TEXT NOT NULL DEFAULT ''
                      + is_draft INTEGER NOT NULL DEFAULT 0     -- «draft»: saved, not yet sent (state stays 'pending'
                                                              --  but a draft is invisible to the customer and never
                                                              --  fences the one-live-offer index: partial index adds
                                                              --  AND is_draft = 0)
community_offer_files id, offer_id → community_offers CASCADE, file_key (private prefix
                      offers/<offerId>/…), kind (image|pdf|model), name, bytes, created_at
community_request_comments
                      id, request_id → community_requests CASCADE, author_id → users, parent_id,
                      kind CHECK (public_comment|merchant_question|customer_answer|system_update),
                      body, state CHECK (visible|removed|hidden), admin_hidden_reason, created_at, updated_at
community_order_updates
                      id, community_order_id → community_orders CASCADE, actor_id → users,
                      kind CHECK (started|progress|photo|ready|note|modification_request|delivered),
                      body, file_key (private prefix community-orders/<orderId>/updates/…), created_at
community_orders      + ready_at TEXT, + started_at TEXT
merchant_request_prefs + turnaround_days INTEGER, + technologies TEXT '[]' (derived from printers on save),
                      + max_build_mm TEXT '{}' (derived), + workshop_intro TEXT ''
community_reports     rebuilt (empty in 0154) with target_type + 'request_comment' | 'order_update'
```

The order state CHECK is not widened: «ready» is a timeline event
(`community_order_updates.kind='ready'`, `community_orders.ready_at`) inside
`in_progress`; `merchant_marked_delivered` stays the state that starts the
auto-complete clock. `revised` is not a state either: it is `revision > 1 AND
state = 'pending'` (the customer sees «عرض معدّل» and the history).

**Routes** (all existing guards kept: `requireCommunityOpen`, `requireAuth`,
`requireOfferPrivileges`, `assertMayQuote`; rate limits reuse the buckets)

| Method, path | Change |
|---|---|
| POST `/api/marketplace/requests/:id/offers` | body gains `delivery_fee_iqd`, `quantity`, `color`, `terms`, `draft: boolean`, `files: [{key}]` (keys under `offers/<pending>/…` are moved to the offer's prefix; each checked in `file_objects` by owner) |
| PATCH `/api/marketplace/offers/:id` | same fields; editing a sent offer bumps the revision (exists); the customer is told («عُدّل العرض») |
| POST `/api/marketplace/offers/:id/send` | draft → sent: `is_draft = 0`, `offer_count` +1, `offer_received` notice; refused when the request is no longer open |
| GET `/api/marketplace/requests/:id/offers` | each offer carries `delivery_fee_iqd`, `total_iqd = price + delivery_fee`, `files` (URLs by `fileReader` access, never keys), `revised`, `valid_until` (= expires_at) |
| POST `/api/marketplace/offers/:id/accept` | body `expected_total_iqd` replaces `expected_price_iqd` (the fee is part of what was agreed); escrow gross = total; **for a board request the accept batch also finds-or-creates the `request` thread (context_type='request', context_id, merchant_id) and writes `community_orders.chat_id`**, then posts the system card there (direct requests already do) |
| GET/POST `/api/marketplace/requests/:id/comments` | the discussion: public_comment (anyone signed in while the request is on the board), merchant_question (an eligible merchant, `liveVerdictForUser`), customer_answer (the customer; may answer a question by `parent_id`); system_update rows are written by the server on revision/accept/close; DELETE by the author; `community_reports` target `request_comment`; rate 60/h; decency filter |
| POST `/api/marketplace/orders/:id/start` | also writes `started_at` and an update `started` |
| POST `/api/marketplace/orders/:id/updates` | merchant: progress / photo (upload purpose `order_update`, private) / ready (sets `ready_at`) / note; customer: `modification_request` (only before delivered); each notifies the other side (`order_update` kind, grouped per order) and posts a system card in the order's chat when `chat_id` is set |
| GET `/api/marketplace/orders/:id/timeline` | the merged timeline: created/funded (escrow events), started, updates, delivered, confirmed/auto-complete, dispute, completed — actor as role, files as URLs per party |
| POST `/api/marketplace/orders/:id/cancel`, `/dispute` | unchanged; the merchant UI gains both buttons (the API already allows them per `cancellationPolicy`) |
| GET/PUT `/api/merchant/request-prefs` | `turnaround_days`, `workshop_intro`; `technologies`/`max_build_mm` recomputed from `merchant_printers` on every printer write (`rematchWorkshop`) |
| GET `/api/community/store/:id` (public) | gains `workshop: { technologies, materials (from stock or prefs), max_build_mm, turnaround_days, governorates, delivery, custom_enabled, intro }` |
| GET `/api/community/requests?for=me` | merchant viewer: the workshop board's eligible rows (`community_request_matches.eligible = 1 AND revision = r.revision`) — the home's «طلبات تناسبك» |

Ranking (`printMatchingScore.ts`) reads `turnaround_days` (shorter first,
after eligibility) — a measured `response_minutes` waits for Phase 6.

**Client**

- `/requests/:id` becomes a route file `src/pages/community/Request.tsx`
  (the old `/requests?request=<id>` redirects) in the owner's order: header
  (title, state chip, customer/merchant line) → status strip → files (the
  existing `AttachmentList`, viewer tokens) → details (`PrintSummary`, fields)
  → discussion (comments, questions, answers; system updates inline) → offers
  (customer: `OfferCompare` with delivery fee and total, files, revision
  history; merchant: `OfferComposer` V2 with draft/send) → comparison →
  chat door (`POST /api/chats/open {requestId, merchantId}`) → accepted offer
  → timeline (`/orders/:id/timeline`) → escrow (held/released, never a key) →
  delivery (contact snapshot per party) → review (`StoreReviews` when
  completed).
- `OfferComposer` V2: price, delivery method + fee, days, quantity, material
  (catalogue ids), colour, notes, terms, validity, files (purpose `offer`,
  private), «احفظ مسودة» / «أرسل العرض»; the offer card shows the total.
- Merchant custom order screen (`SalesTabs` → a real page
  `src/components/merchant/orders/CustomOrderScreen.tsx`): timeline, progress
  composer (text, photos, «جاهز»), cancel/dispute per policy, contact card.
- Customer order view (`MyCommunityOrders`): timeline, «اطلب تعديلًا»,
  dispute (exists), confirm (exists).
- Store settings: a «ملف الورشة» section (intro, turnaround, derived
  technologies/build volume read-only with links to Printers/Stock/Prefs);
  the storefront `Hero`/`Stats` show the workshop facts.

**Tests** (`tests/offersV2.test.ts`, `tests/requestDiscussion.test.ts`,
`tests/orderTimeline.test.ts`): a draft offer is invisible to the customer and
does not block a second live offer; the fee is in the escrow gross and in the
snapshot; `expected_total_iqd` mismatch → `OFFER_CHANGED`; accepting a
revised offer without its revision → `OFFER_STALE`; a board accept writes
`chat_id` and the system card; a merchant not eligible cannot ask a
merchant_question; only the customer answers; a stranger cannot post an
update; `ready` does not move state nor money; `modification_request` after
delivered is refused; the timeline never carries a file key; cancel/dispute
follow `cancellationPolicy` for the merchant too.

### 9.3 Phase 3 — Unified search and discovery — LANDED (§4c)

**Landed.** The routes, caching and tests as built are in §4c; the client in §4c «Client». The
specification below is kept as written; where it named `creatorVisible`, the shipped rule is
`creatorListSql` (the `/creators` handler's own SQL, hoisted); `sort=trending` on the rails became
the rails reading `/trending`'s rows directly; `/recommend` for a product matches by category or
material (no `catalogPresentation` shelves were needed).

**Kept as is:** the catalogue token index (`searchProducts`, synonyms, ghost
completion — products only), `likePattern`/`sqlLikeClause`, the community
lists' own `q`, the home shelves (`homeShelves.ts`).

**No new tables.** No search log, no query tracking (the brief: «no invasive
tracking»); «recent searches» live in the browser only (localStorage,
versioned like `recentlyViewed.ts`), «trending» is computed from counters
that already exist.

**Routes** (behind `communityGate()`, no auth, `rateLimit('community-search', 120, 60)`)

| Method, path | Shape |
|---|---|
| GET `/api/community/search?q=&types=&limit=` | `{ q, sections: { products, stores, creators, projects, requests, materials, brands }, took_ms }` — each section ≤ `limit` (default 5, max 12) rows in that entity's existing public card shape (`ProductTile`'s product, `directoryCard`, the creator card, `postCard`, the request card, catalogue material/brand rows) plus a `total` per section from a bounded COUNT (LIMIT 200 inside). Visibility rules are the lists' own SQL (`communityProductsVisible`, `communityDirectoryVisible`, `requestBoardVisible`, `POST_PUBLIC_SQL`, `creatorVisible` conditions) — never a new predicate. Products and materials/brands come through `searchProducts` where the index is installed (with the LIKE fallback the catalogue route already has), the rest through `likePattern` on the columns each list searches today. `types` narrows to a comma list. Blocked/muted authors are excluded for a signed-in viewer (Phase 2's helper). |
| GET `/api/community/search/suggest?q=` | ≤ 8 completions from names only (store names, creator names/usernames, project titles, catalogue product names via `suggestCompletion`), each `{ text, type, href }`; 2-character minimum; cached 60 s at the edge for guests. |
| GET `/api/community/trending` | `{ projects (existing /posts/trending), tags (json_each over the last 30 days' public posts, top 12), stores (by 30-day completed orders + new followers from `follows.created_at`), creators (by 30-day likes on their posts) }` — all from existing tables, cached 5 min. |
| GET `/api/community/recommend?for=post:<id>|store:<id>|product:<id>&limit=` | «قد يعجبك»: same material/printer/tags for a post; same governorate/categories for a store; same section/brand for a product (`catalogPresentation` shelves). No per-user model; the viewer's own affinity ranking stays on the device (`rankByAffinity`). |

**Client**

- One search overlay for the community (`src/components/community/search/SearchOverlay.tsx`, lazy): opened from the home's search bar and from `/community/projects`; sections in the owner's order (projects, stores, creators, products, requests, materials, brands), each with «الكل» to the tab or page that lists it with `?q=`; keyboard: arrows across results, Enter opens, Esc closes; recent (device) and trending chips when the box is empty; `LiveSearch`'s ghost completion reused from `src/components/search/ghost.ts`.
- The home's search bar keeps the URL contract (`?q=` per tab) and gains the overlay on focus; the tabs' lists still search on the server.
- Home discovery rails from `/trending`: «وسوم رائجة» chips under the cover; the creators and stores rails accept `sort=trending`.

**Tests** (`tests/communitySearch.test.ts`): a hidden project, a suspended
store, a private product and a draft request never appear in any section;
`types` narrows; totals are bounded; suggestions never include an email, a
phone or a private request; blocked authors are excluded for the viewer;
rate limit answers 429; ar/en/ckb query strings all match (Arabic-Indic digits
and diacritics normalised by `normalizeText` where the index is used).

### 9.6 Phase 6 — Moderation V2, reputation V2, dispute evidence access

**Migration `moderation_v2` (additive; number = next free at merge)**

```
users                 + status TEXT NOT NULL DEFAULT 'active' CHECK (active|restricted|suspended|banned)
                      + status_reason TEXT NOT NULL DEFAULT '', + status_until TEXT, + status_changed_at TEXT
moderation_actions    id, actor_id (staff), target_type CHECK (post|comment|request_comment|user|store|product|
                      request|review), target_id, action CHECK (hide|remove|warn|restrict|suspend|ban|restore),
                      reason, until, report_id → community_reports NULL, created_at
                      (the audit_log row is still written; this table is the queryable history the desk shows)
moderation_appeals    id, user_id, action_id → moderation_actions, body, state CHECK (open|accepted|rejected),
                      decided_by, decided_at, decision, created_at
community_comments    (0154) already has state hidden + admin_hidden_reason
merchant_metrics_daily merchant_id, day, first_reply_minutes_sum, first_reply_count, orders_completed,
                      orders_cancelled_by_merchant, disputes_lost, PK (merchant_id, day)
chat_staff_reads      id, chat_id, admin_id, complaint_id → community_complaints, created_at
                      (one row per read session; the audit_log row is written too)
```

**Enforcement** (`users.status`): `restricted` → no new posts, comments,
offers, requests, DMs (reads stay); `suspended` (until a date) → the same
plus no follows/likes and the creator page answers 404; `banned` → the
session is refused at `requireAuth` for every write and the account's public
content is hidden (`POST_PUBLIC_SQL` and the comment/creator predicates gain
`AND author.status NOT IN ('suspended','banned')` through one shared SQL
fragment `AUTHOR_VISIBLE_SQL`). Merchants keep their own sanction
(`community_merchants.status`); a user ban also suspends their store through
the existing `POST /stores/:id/status` path.

**Routes** (`worker/routes/adminModeration.ts`, `requireAdmin`; every write →
`audit()` + `moderation_actions` + the person notified with the reason and
the appeal door)

| Method, path | Effect |
|---|---|
| GET `/api/admin/moderation/reports?state&type&cursor` | the queue from `community_reports`, with the target rendered (post card / comment / user / store / product / request) and the reporter count per target |
| POST `/api/admin/moderation/reports/:id` `{state, resolution}` | reviewed / actioned / dismissed |
| POST `/api/admin/moderation/posts/:id/hide` `{hidden, reason}` | sets `community_posts.admin_hidden_at/_reason` (0153 read-side rules already apply) |
| POST `/api/admin/moderation/comments/:id/hide` | `state='hidden'` (0154 trigger keeps the count) |
| POST `/api/admin/moderation/users/:id/status` `{status, reason, until?}` | the ladder warn → restrict → suspend → ban → restore; 409 when a status is lower than an active one without `restore` |
| GET/POST `/api/moderation/appeals` (user), POST `/api/admin/moderation/appeals/:id` | one open appeal per action; accepted → restore |
| GET `/api/admin/moderation/audit?target=` | the history for one target from `moderation_actions` + `audit_log` |

**Reputation V2** (`worker/lib/reputation.ts`): explainable badges computed
nightly by the cron beside `refreshStaleMerchantBadges` and stored on
`community_merchants.badges_json` (0156 column) as
`[{ key, since, evidence }]`:
`verified_merchant` (`verified=1`), `fast_response` (median first reply in
store/request threads over 30 days ≤ 60 min, ≥ 10 threads — measured from
`chat_messages` joined to `chat_participants.role`), `reliable_seller`
(≥ 20 completed in 90 days, merchant-cancel ≤ 3 %, disputes lost 0),
`custom_specialist` (≥ 10 completed community orders in 90 days and
`accepts_custom_requests`), `high_completion` (completion ≥ 95 % over ≥ 20
orders). Each badge's page (`/community/badges`) explains the rule in three
languages; the store hero, the directory card and the creator page show up to
three with a tooltip «لماذا؟». `printMatchingScore.ts` reads
`response_minutes` and `trouble_rate` from `merchant_metrics_daily` instead of
the hard-coded nulls. Admin escrow resolve (release/partial) also bumps
`completed_orders` and writes `order_completed` (survey §1.6 gap).

**Dispute evidence access** (the brief's rule, verbatim: staff read-only,
audited, only while disputed, only for the pre-order store conversation linked
to a disputed order): `GET /api/chats/:id` and `/messages` admit a staff
reader to a `store` or `request` thread only when a `community_orders` row in
state `disputed` links to it (`community_orders.chat_id = :id`, or the
request thread whose `request_id` matches the disputed order's request and
whose merchant is the order's merchant) or a `store_order` complaint is open on
its order; the read is `readOnly`, cards' actions are emptied
(`chatCards.ts` staff viewer), every session writes `chat_staff_reads` +
`audit('admin.chat_read')`, the composer is absent, and the door closes the
moment the order leaves `disputed`. The dispute desk gains «المحادثة» and
«الطلب» links; file reads through `/files/<key>` for those threads go through
`recordStaffChatFileRead` (today they are unaudited for non-order threads).

**Tests** (`tests/moderationV2.test.ts`, `tests/reputationV2.test.ts`,
`tests/disputeEvidenceAccess.test.ts`): moderation bypass (hidden post/comment
invisible on feed, trending, search, creator grid, saved list; banned author's
content gone everywhere; a restricted user cannot write anywhere but can
read); appeal once per action; a badge appears only with its evidence and is
explainable; staff read: 403 before the dispute, 200 read-only during, 403
after resolution; every read audited once per session; no staff write path;
the evidence rows never expose keys.

### 9.7 Phase 7 — Analytics, collections, activity centre, draft preview

**Migration `analytics_collections` (additive; number = next free at merge)**

```
community_post_views_daily  post_id, day, views, PK (post_id, day)    -- from the beacon, salted-visitor deduped
community_post_view_marks   post_id, day, visitor, PK                  -- same shape as storefront_event_marks
user_collections            id, user_id, name, is_public INTEGER 0, created_at, updated_at
community_saves             + collection_id → user_collections NULL (0154's `collection` text is migrated into rows)
```

**Beacon:** `POST /api/community/events` with `{event:'post_view', post:id}`
through the storefront beacon's rules (`sendBeacon`, no id under DNT/GPC,
bots dropped, the author not counted, one per visitor per day, 240/min per
network) — `worker/lib/storefrontAnalytics.ts`'s `recordStatements` pattern,
writing `community_posts.view_count` on a new mark. Trending keeps its
formula with real views.

**Dashboards**

- Creator: `GET /api/community/me/analytics?from&to` → views, likes, saves,
  comments, followers gained per day; top projects; «من أين» = referrer host
  class only (direct/search/social/other). Shown on `/u/<me>` («إحصاءاتي»
  tab, owner only) and never to visitors (the public stats stay projects and
  followers).
- Merchant: the existing `/api/merchant/analytics/report` gains
  `community: { post_views, project_clicks_to_products, print_requests_from_projects }`
  (a click from a project's «اشترِ هذه القطعة» is a `product_view` with
  `ref='project'` in the existing beacon).

**Collections:** `GET/POST/PATCH/DELETE /api/community/collections`,
`PUT /api/community/collections/:id/posts/:postId`; private by default;
a public collection has a page `/u/<username>/collections/<id>`; the save
button offers «حفظ في…» (Sheet) with the default list first; `/community/saved`
becomes the collections page.

**Activity centre:** `/activity` (customer) = the grouped
`user_notifications` list with filters «الكل | تعليقات | إعجابات | متابعون |
الطلبات» (`GET /api/notifications?kind=` gains a kind filter and cursor
paging), «تعليم الكل كمقروء», and the merchant centre's day buckets; the
header bell links to it.

**Draft product preview:** the merchant catalogue's product form gains
«معاينة» that renders the storefront product block in a lazy `PreviewSheet`
from the DRAFT document in memory (the same `StorefrontProduct` block
components fed a local object), never through `/api/storefront/*`, so the
public storefront closure stays under its 47 KB and never learns to read a
draft.

**Tests:** a view is counted once per visitor per day and never for the
author or a bot; analytics endpoints answer only the owner; a private
collection is 404 to others and a public one lists only public posts; the
activity filter never leaks another user's rows; the storefront chunk graph
does not gain the preview sheet (`tests/bundleBudget.test.ts`).

### 9.8 Phase 8 — Performance, accessibility, localisation, verification, deploy

**Performance (the brief's list):** every community list cursor-paged (no
offsets anywhere in the new routes; `feedCursor`/`nextPostCursor`); media
lazy below the fold (`SafeImage` default) and eager only for the first four
tiles / the cover; the feed virtualised past 60 rows (`content-visibility:
auto` on `.lv-section` rows, no library); skeletons at the section's exact
height; no 3D file bytes in any list (the viewer loads only on its own page
by token); the home's first paint = cover + trending + one request row +
one page of posts (the rest mounts in view); `readPageCache` for Back; the
budgets (`tests/bundleBudget.test.ts`) unchanged: entry 120 KB, initial
240 KB, storefront closure 47 KB, CSS 60 KB.

**Accessibility:** one Tab stop per card (stretched link) and buttons as
siblings; `aria-pressed` on every toggle; ≥ 44 px targets; `focus-visible`
rings everywhere; sections `aria-labelledby`; the media strip's slides named
«n / N»; video tap-to-play, never autoplay; reduced motion collapses every
spring (`useMotion`) and stops skeleton pulses; colour never the only cue.

**Localisation:** ar, en, ckb complete for every string the phases added —
checked by a test that walks `src/components/community/**/strings.ts` and
`src/lib/refusalStrings.ts` and fails on a missing key or a ckb equal to its
ar for more than 10 % of keys (the deliberately identical ones — brand words,
digits — are listed); notification titles for the new kinds in three
languages once Q5 is answered (default: ar/en with the merchant feed's
`title_ckb` meta); RTL walked in the browser scripts for ar and ckb; Arabic
counted nouns via `hub/copy.ts` forms.

**Verification before deploy:** `npm run check`; `npm run test:unit`;
`node scripts/migrate-check.mjs --twice`; `npm run build` + the budget test;
the browser scripts (`e2e-projects`, `e2e-community-home`, and the ones the
later phases add) in ar/en/ckb × dark/cream × 360/1280; a security pass over
the brief's attack list (§7) with every case a test; then the deploy
workflow after the owner's word, with the live checks the earlier deploys
used (health shows the last migration, the community gate answers, the new
routes 200/401/404 as designed, `www` still redirects).
