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
3. **Unified search + discovery** — one `/api/community/search` over products, stores, creators, projects, requests, materials, brands (LIKE + the catalogue index where it exists), autocomplete from names, «trending» from counters, no query log.
4. **3D asset platform + files (§27–35)** — upload sessions (multipart/resumable) with checksum, admin-configurable limits, structure sniffing with zip-bomb bounds, file roles on products / requests / chat, link cards with URL validation, the shared viewer with temporary tokens, grouped file notifications, per-file authorization tests.
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
| private file access | Phase 4: per-file authorization, never a key in a response |
| creator block rules | Phase 2: a blocked user cannot DM, follow, comment or see the page |
| moderation bypass | Phase 6: hidden post is 404 to all but author/staff on every read path (feed, trending, search, creator grid) |
| hidden project in search | Phase 3 |
| banned store in recommendations | Phase 3/6 |
| forged linked product | tests/communityPosts.test.ts (done) |
| file ownership spoof | tests/communityPosts.test.ts media keys (done); Phase 4 for 3D files |
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

### 9.4 Phase 4 — The 3D asset platform and files (§27–35)

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
counted from `file_objects`); `X-Content-Type-Options: nosniff` and the
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
returns a key; the viewer token for a hidden post is revoked; link cards
refuse `javascript:`, `file:`, `data:`, `http://10.0.0.1/` and never fetch
without the allow-list; the admin limit change is audited and applied on the
next session; quotas count only live objects.

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

### 9.3 Phase 3 — Unified search and discovery

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
