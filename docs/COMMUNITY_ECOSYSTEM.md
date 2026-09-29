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

Planned (Phase 2, 0154): `user_follows(follower_id, user_id)`, `community_likes(user_id, post_id)`,
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

## 5. Client (Phase 1, landed)

- `/community/projects` — the list with kind chips, a tag chip and server search (pages/community/Projects.tsx; `ProjectsGrid` is reused by the home's «المشاريع» tab in Phase 2).
- `/community/projects/:id` — the project: snap media strip (one moving dot, tap-to-play video, arrows for a pointer), kicker + title + byline, counts hidden at zero, the spec list, the story, tags, the doors (store, product with price, material), the author's banners and menu, the asked customer's consent card, «اطلب طباعة مثلها» as the one accent verb on a sticky bar above the bottom nav. Two columns from `lg`.
- `/community/projects/new`, `/community/projects/:id/edit` — the composer: pictures first (`ProjectMediaPicker`, purpose=post, cover = first), title, kind chips, story, the facts with catalogue pickers for printer and material, tags, the store link for a store owner, visibility, save-draft / publish under the thumb.
- `/u/:username` — the creator: avatar, kicker, name, handle, badges, bio, stats, tabs «المشاريع | نبذة» (store card with follow, member since, printers, materials, website, socials).
- Profile «مشاريعي» tab (states, pending consent, hides) and the profile editor's «صفحتي العامة» switch with printers / materials.
- Browser fixture tests/browser/projects.html + scripts/e2e-projects.mjs: 101 checks over ar/en/ckb × dark/cream × 360/1280 (landmarks, no horizontal overflow, no page errors).

## 6. Phases

1. **Projects + creator profiles** — landed (this document, §3–5). Tests: tests/communityPosts.test.ts (11).
2. **Social graph + Feed V3** — 0154 tables and counter triggers; like/save/comment/follow-creator/block/mute/report endpoints with rate limits and idempotency; grouped notifications (`ON CONFLICT` upsert on a grouping key + count); the community home rebuilt to the «العدد» plan (masthead, quick actions, six tabs, cover story, numbered sections, rails, the feed, tools, colophon; springs from `useMotion()`, skeletons at exact heights, `bg-canvas` tokens, ≤ 1 new CSS rule).
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
