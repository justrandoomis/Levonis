# Reviews and printer gifts — plan of record

Owner brief: 18 sections, received 2026-09-30 (kept in the session scratchpad, `reviews-gifts/BRIEF.md`). Base: branch `release/reviews-gifts` = `22118e43`, the code live on levonis-iq.com. Only this feature ships. Levo Community is postponed.

The six surveys (`reviews-gifts/survey/*.md`) describe the **development** line. Every fact below was checked again on this base. Where the base differs, this document wins:

- No upload-session platform exists here. There is no `uploadSessions.ts`, `uploadEntity.ts`, `fileOwnership.ts`, `UploadTile`, `MediaPicker` or `MediaStrip`.
- `file_objects` has no `sha256` or `purpose` column. The development line adds them in 0156, so 0165 must not add them.
- The review media door has no HTTP Range support.
- The CSS headroom is **53 bytes**, not 454.

## 0. Settled decisions (apply; do not reopen)

| # | Decision |
|---|---|
| S1 | Only this feature ships. Merchant store reviews (`merchantReviews.ts`, `/api/community-reviews`) are a separate system and are **not touched**. |
| S2 | **Printer families** come from the product's **own** section (`sub_category_id`, else `category_id`):<br>• fdm: `cat_printers_fdm` or below it<br>• resin: `cat_printers_resin` or below it<br>• laser: `cat_laser_machines` or below it<br>• the root `cat_printers` only when `productTypeOf` is `printer`<br>• the root `cat_laser` only when it is `laser`<br>The placement-based `printerIdentity` rule is never used (it counts laser accessories). That global rule is not fixed here. Used printers are excluded (`isUsedBranch`). Implementation: `printerGiftFamily`, worker/lib/reviews/eligibility.ts. |
| S3 | Units are excluded when any of these holds:<br>• the unit is refunded (a `return_cases` row with `resolution='refund'` names it or its line)<br>• it was traded in (a `trade_in_claims` row of part `device` exists)<br>• it came from a gift line<br>• the order is a merchant order |
| S4 | A review written **before** the unit is registered is admitted when the registration happens. The device-registration routes re-run admission for that user's existing review. |
| S5 | One gift per unit: `idx_review_rewards_printer_unit` is UNIQUE, in every state, and the replacement chain is guarded. One review per user per product: the existing `UNIQUE(user_id, product_id)` is kept. |
| S6 | A level's items are real store products, and they are **alternatives**: the customer picks ONE after redeeming. This is a **level gift**.<br>A **manual gift** is one product, variant, colour and set of options that the admin fixes.<br>Either way, one product per entitlement. The admin always picks a level 1–5; it keeps `max_level` NOT NULL and records the judgement.<br>Bundles and mystery offers cannot be gifts in v1 (`GIFT_COMPOSITION_UNSUPPORTED`). |
| S7 | On a gift line only the **product** costs 0 IQD. Its line fees (pre-order route commission, direct premium, warranty) are 0 too. Delivery and COD rules apply to the order as normal. |
| S8 | A gift line triggers no other reward. It is excluded from:<br>• the support-code referrer gift (`orderHasSupportEligibleLine`, `supportGiftGuard`)<br>• the referral printer reward (`orderHasPrinterProduct`)<br>• the review-reward purchase proof (`ELIGIBLE_UNIT_SQL`, already done)<br>• the PRO pre-order «فلمنت هدية» on a gift-only order (`preorderGiftFor` call site, orders.ts:4071)<br>• the trade-in coupon cap (`tradeInCouponCap` call site, orders.ts:2966)<br>• offers (no offer lookup for gift rows)<br>All of these exist at this base. |
| S9 | Cancelling the order that consumed a gift returns it to «ready to order». There is **one mechanism**: trigger `trg_orders_cancel_returns_gift`, which covers the customer, admin legacy status, stage move, expiry sweep and Gini sweep doors. `moveOrderStage` into cancelled does not call `cancelledOrderRefundStatements`, so a statement there would miss that door. An order holding a gift line cannot be re-opened (`trg_orders_reopen_gift_guard`). |
| S10 | The `OrderCreated` event contract is unchanged. A gift line is sent as `item_kind: 'ordinary'` with unit 0. |
| S11 | Codes:<br>• 6 digits, drawn from a CSPRNG (`generateAuthOtpCode`)<br>• never stored or logged raw<br>• the verifier is **PBKDF2** with a per-row salt (`hashPassword`) over `gift-code:v1:<entitlement>:<code>`. **Why not HMAC:** every Worker secret is optional, several are absent on the live Worker, and none is meant for this purpose<br>• compared in constant time<br>• 5 tries per code, then locked until the admin re-issues<br>• rate limits: per user `gift_code` 5 per 900 s; per IP `gift_code_ip` 20 per 3600 s, keyed `ip:<CF-Connecting-IP>`<br>• one generic error for every failure<br>• audited without the code<br>• codes never expire; they can be revoked and re-issued (audited) |
| S12 | The Instagram-evidence block leaves the review form. Legacy evidence stays readable to admins. `POST /api/reviews/uploads` accepts `purpose=media` only. |
| S13 | `/gifts` shows the gift level. While a printer reward awaits the admin it shows a quiet «pending» card. |
| S14 | The admin sees objective facts (characters, photos, videos, the 10 conditions) and **no predicted level**:<br>• delete `tierFor`, `tier` and `rewardEligible` as gates<br>• delete the pre-selected level and the server fallback `quality_score ?? tier`<br>• delete `REWARD_NOT_ELIGIBLE`, `CHECKLIST_INCOMPLETE`, `MIN_DETAIL_CHARS` and the predicted level in the notification and Telegram<br>The quality score stays as advice only. |
| S15 | Policy texts that contradict the program get new versions in ar/en/ckb, flagged for the owner:<br>• rewards chapter 7.3, 7.4, 7.5, 7.8, 7.9, 7.12 (worker/lib/policies/rewards.ts ar `:300-384`, en ~`:735-819`, ckb ~`:1170-1255`)<br>• chapter 8 (8.1–8.12)<br>• 13.3 (ar `:507`, en `:942`, ckb `:1377`)<br>• FAQ 12.11 (worker/lib/policies/faq.ts ar `:280`, en `:503`, ckb `:726`)<br>Bump `rewards` to version 5. The archive keeps v4. |
| S16 | Legacy `gift_entitlements` rows are those with states `available`, `selected`, `fulfilled` or `cancelled` and `grant_mode='legacy'`. They stay readable to their owners. The admin can fulfil `selected`, cancel `available`, or **convert** an `available` row by issuing a code. The random box redeem and `LEVEL_COMPOSITION` are deleted. |
| S17 | Review media uses the **existing** review path, fixed and extended. That path is `POST /api/reviews/uploads`, then `storeMedia`, then private `reviews/<uid>/photos\|video/<id>.<ext>`, then `GET /api/reviews/media/*`. There is no new storage and no second uploader. |

## 1. Three separate stages

1. **Publication** (S1, unchanged). A valid POST publishes at once (`status='published'`). Moderation (`/admin/:id/moderate`) is the only thing that unpublishes, and a reward decision never touches publication. A 1-star review of anything stays public.
2. **Gift eligibility** (S1). One deterministic statement runs inside the review's own batch. It inserts a `review_rewards` row (`printer_gift`, `submitted`, `quality_score NULL`, with `unit_id`, `order_id`, `order_item_id` and `product_id`) or nothing. Five stars is a condition of **entry to the program** only, never of publication. The same rule re-runs on PUT and on device registration, both idempotently.
3. **Admin decision** (S2). A human picks level 1–5 and the mode (level or manual), then presses «تأكيد وإصدار الكود». The server re-checks eligibility, then in **one batch**: reward `approved` plus the entitlement `code_issued` with its snapshot and verifier plus the audit row. The raw code is returned once. Reject and request-changes keep their current behaviour. A rejection never unpublishes.

## 2. The gift lifecycle — one state machine (`gift_entitlements.state`)

```
reward submitted ──admin issue──► code_issued ──customer redeems code──► redeemed_ready_to_order
redeemed_ready_to_order ──cart line exists──► in_cart            (DERIVED: EXISTS cart_items.gift_entitlement_id — never stored)
redeemed_ready_to_order ──checkout batch──► ordered              (order_id, order_item_id, ordered_at, order_seq+1)
ordered ──orders.status→delivered (trigger)──► fulfilled
ordered ──orders.status→cancelled, any door (trigger)──► redeemed_ready_to_order   (order link cleared, order_seq kept)
code_issued | redeemed_ready_to_order ──admin cancel──► cancelled (cancelled_at/by/reason; cart line deleted; code revoked)
code (code_state): issued ──revoke──► revoked ──re-issue──► issued (new verifier, code_version+1, attempts 0)
legacy (grant_mode='legacy'): available | selected | fulfilled | cancelled
```

Every transition is one conditional UPDATE, and its WHERE carries the precondition (state, `user_id`, `code_version` or `order_seq`). If it changes 0 rows, the race was lost and the route says so.

**`ui_state`** is derived on the server only (`deriveGiftUiState`, worker/lib/gifts/entitlements.ts):

| Facts | `ui_state` |
|---|---|
| reward awaiting the admin | `pending` |
| code issued | `awaiting_code` |
| code issued, 5 wrong tries | `locked` |
| redeemed, no item chosen yet | `choose_item` |
| redeemed, item chosen | `ready` |
| redeemed, cart line exists | `in_cart` |
| ordered | `ordered` |
| fulfilled | `delivered` |
| cancelled | `cancelled` |
| any other legacy row | `legacy` |

## 3. Eligibility statement

`ELIGIBLE_UNIT_SQL` in worker/lib/reviews/eligibility.ts is implemented and smoke-tested. Its binds:

| Bind | Meaning |
|---|---|
| `?1` | review id |
| `?2` | `checkReviewText(body).ok ? 1 : 0` |
| `?3` | `printerGiftFamilyOf(product) ? 1 : 0` |

It returns the ONE qualifying unit. The review's own order and line are preferred; another delivered unit of the same model that the reviewer owns is accepted. It requires all of these:

- `reviews`: `source='user'`, `status='published'`, `stars=5`
- the unit: `owner_user_id` = the reviewer, delivered, not replaced
- the order: the reviewer's, `status='delivered'` with `delivered_at` set, not a merchant order
- `device_registrations`: held by the reviewer, not revoked
- the exclusions of S3
- no `printer_gift` reward anywhere on the unit's replacement chain

`admitPrinterGiftStatement(db, {rewardId, reviewId, textOk, familyOk, nowIso, qualitySnapshot?})` is an `INSERT … SELECT … ON CONFLICT DO NOTHING`. It is appended to the review batch after the review INSERT or UPDATE.

`recheckPrinterGift(db, rewardId)` follows a warranty replacement forward to the live unit. S2 must call it at issue and at redeem.

**Fallback points** stay: the base value × 2 × the member multiplier. They become **exclusive** with admission inside the batch: `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM review_rewards WHERE review_id=?)` on `points_awards` and `wallet_transactions`, and the same guard on the `fallback_points_awarded` UPDATE.

## 4. Text rule

The rule lives in `packages/catalog/src/reviewRules.ts`. It is implemented. The Worker imports it as `@levonis/catalog/reviewRules` through worker/lib/reviews/text.ts. The SPA imports it by relative path.

**Normalisation:**

1. Trim. More than 4000 UTF-16 units → `REVIEW_TEXT_TOO_LONG`.
2. NFKC.
3. Strip `\p{Cf}` and the tatweel «ـ».
4. Collapse every run of `\s+` to one space, and trim again.
5. `length` = the code points of the result. Fewer than **30** → `REVIEW_TEXT_TOO_SHORT`.

**`REVIEW_TEXT_REPETITIVE`** applies when any of these holds:

- fewer than 20 letters or digits (`\p{L}\p{N}`)
- fewer than 5 distinct letters or digits
- fewer than 3 distinct words
- the text without spaces is one unit of 1–6 characters repeated 5 or more times

Applied to new and edited **user** reviews only. Existing short reviews stay published. System markers (empty body) never pass through the rule.

## 5. Media rules (S1 server, C1 client)

- **Limits.** At most **10 images and 2 videos** per review, checked on POST and PUT. They are **refused, never sliced**: `REVIEW_MEDIA_TOO_MANY_IMAGES` / `_VIDEOS`, with `details {max, got}`. Photos only, video only, both, or none are all fine.
- **Upload door.** `POST /api/reviews/uploads` sniffs the **bytes**:
  - Images: JPEG, PNG, WebP, GIF and AVIF via `sniff()`. JPEG and PNG are converted to WebP by `storeMedia`.
  - HEIC/HEIF → `IMAGE_HEIC_UNSUPPORTED`, the existing message.
  - Video: every file must pass `sniffVideo(buf)` over the whole body, which proves a playable video track. MP4 and QuickTime MOV (stored as `.mp4`, `video/mp4`) and WebM (add `case 'video/webm': return 'webm'` to `extensionFor`, worker/lib/imageConvert.ts). Otherwise `VIDEO_UNSUPPORTED`.
  - Anything else → `REVIEW_UPLOAD_UNSUPPORTED`.
  - Caps: image ≤ **8 MiB** (`IMAGE_MAX`) and video ≤ **40 MiB** (`VIDEO_MAX`). **Keep `const VIDEO_MAX = 40 * 1024 * 1024;` in worker/routes/reviews.ts**, because services/gateway/test/uploadClasses.test.ts reads it. Refusal: `REVIEW_UPLOAD_TOO_LARGE`.
  - Auth: `requireAuth`, rate `review_upload` 40 per 3600 s (existing).
  - Errors are now **codes** with sentences (§9).
- **SHA-256.** The digest of the bytes *as they arrived* is written to the R2 object's `customMetadata.sha256`. This restores the regression, so `storeMedia` gains an optional `customMetadata` that it passes through. When media is attached, the entry `{key, kind, sha256, bytes, mime}` takes kind, mime, bytes and sha256 from the **object head**, never from the client slot.
- **Duplicates:**
  - same key or same sha256 twice in one review → `REVIEW_MEDIA_DUPLICATE`
  - a sha256 already in another review of this user → `REVIEW_MEDIA_REUSED`
  - a key attached to another review → `REVIEW_MEDIA_IN_USE` (409)
  - a key not under `reviews/<uid>/`, or with no object → `REVIEW_MEDIA_NOT_OWNED`
  - an object that is neither `image/*` nor `video/*` → `REVIEW_MEDIA_KIND`
- **Input.** `media: [{key}]` in gallery order. For one release the old `photoKeys` / `videoKey` are also accepted, mapped into the same validator. On PUT, omitting media keeps it and `[]` clears it.
- **Cleanup of never-attached uploads.** Uses the existing queue: `media_cleanup_jobs` with `not_before`, drained by `runGuardedMediaCleanup` in cron step `media_cleanup`.
  - After each upload, write `reviewMediaStagingStatement`: reason `review_media_staging`, private, `not_before = now+24h`.
  - Before a POST or PUT batch, call `protectMediaObjectFromCleanup(db, key)` for every new key. If it returns false → `REVIEW_MEDIA_NOT_OWNED`.
  - Inside the batch, `closeReviewMediaStagingStatement` closes the attached keys' jobs.
  - When an edit drops keys, queue `enqueueMediaDetach`.
  - A failed POST leaves the job pending, and the cron deletes the object.
- **Door.** `GET /api/reviews/media/*` keeps the fragments pinned by tests/mediaAuthority.test.ts: `json_each(reviews.media)`, `json_extract(m.value, '$.key') = ?`, `.bind(key)`, `status = 'published'`, the charset guard, evidence `no-store`, `public|private, no-cache`, and 304 after authorisation. **Add Range, 206 and 416**, using `parseByteRange` from uploads.ts and `getMediaObject(env,'private',key,{range})`. Without it iOS Safari will not play review videos. Pin it with a new test, `tests/reviewsMediaRange.test.ts`.
- **Public API.** `photo_count` counts images only. `video_count` is added (worker/lib/publicApi/resources/products.ts ~600).

## 6. Routes — every door

Guards: `requireAuth`, or `requireAdmin` from the router's `use('/admin/*')`, which also checks the admin host. A rate limit written `bucket n/s` means `rateLimit(c, bucket, n, s)`. **Both route files are mounted at `/api/reviews`** (worker/index.ts); their paths never overlap.

### 6.1 Reviews — worker/routes/reviews.ts (lane S1)

| Method and path | Guard / rate | Body | Response | Refusals |
|---|---|---|---|---|
| `POST /api/reviews` | auth · `review_submit 10/3600` | `{productId, orderId, stars 1-5, body, media?:[{key}] \| photoKeys?, videoKey?}` | `{success, published:true, quality (advisory, no tier), review: MyReviewView, gift:{program:boolean, queued:boolean, missing: GiftCheck[]}}` | 404 order not the caller's or product not in it; 400 `ORDER_NOT_DELIVERED`; 409 `REVIEW_ALREADY_EXISTS` (add the code, keep the sentence); 400 `REVIEW_TEXT_*`; 400/409 `REVIEW_MEDIA_*` |
| `PUT /api/reviews/:id` | auth · `review_submit` | same; the product and order cannot change | `{success, review, gift}` | 404; 409 `REVIEW_NOT_EDITABLE` once a reward is decided or the review is rejected. **LEFT JOIN**, so a review without a reward row can be edited. After the edit: a `submitted` reward re-runs `recheckPrinterGift`, and on failure is set `rejected` by `system` with reason «no longer eligible after edit» (plus the fallback points); with no reward, admission runs |
| `GET /api/reviews/mine` | auth | — | unchanged plus `media` | — |
| `GET /api/reviews/eligibility/:productId` | auth | — | adds `gift:{program, family, linked, linked_elsewhere, unit_rewarded}`, `media_limits:{max_images:10, max_videos:2, image_mb:8, video_mb:40}` and `can_edit` | — |
| `GET /api/reviews/order/:orderId` | auth | — | per line, adds `gift{…}` (as above, per product), `can_edit` and `media_limits`. `existing_review.media` gains `key` for the owner, so the sheet can edit | 404 |
| `GET /api/reviews/product/:idOrSlug` | public | `?page` | unchanged shape. `media` may hold up to 12 items `{url, kind}` | 404 |
| `POST /api/reviews/uploads` | auth · `review_upload 40/3600` | multipart `{purpose:'media', file}` | `{success, key, kind, sha256, bytes, url}` | `REVIEW_UPLOAD_UNSUPPORTED`, `REVIEW_UPLOAD_TOO_LARGE`, `IMAGE_HEIC_UNSUPPORTED`, `VIDEO_UNSUPPORTED` |
| `GET /api/reviews/media/*` | per key (owner, admin or published) | Range, If-None-Match | 200, 206, 304, 416 | 404 |
| `GET /api/reviews/admin/reviews` **(new)** | admin | `?status, source, stars, printer=0\|1, has_media=0\|1, q, cursor, limit≤50` | `{success, reviews:[{review_id, created_at, stars, body, media, status, source, moderation_note, customer{id,email,username,name}, product{id,name,name_ar,family}, order_id, order_item_id, reward:{id,kind,state,level}\|null}], next_cursor}`. **Every** review (LEFT JOIN), keyset on `(created_at DESC, id)` | — |
| `POST /api/reviews/admin/:id/moderate` | admin | unchanged | unchanged | unchanged |

Device hook (S1, worker/routes/devices.ts): after a successful bind in `POST /api/devices/register` and in `POST /api/devices/units/:unitId/register`, call `await admitPrinterGiftForUnit(c.env, {userId: user.id, unitId})`. It is contained: it never throws.

POST and PUT also delete the in-app «predicted level» notification. The Telegram «📢 Review» line keeps `N/5` (pinned). The «Reward level N» line is replaced by «Printer gift candidate — awaiting an admin decision» when the review was admitted.

### 6.2 Gifts — worker/routes/gifts.ts (lane S2)

Moved verbatim at this commit. S2 now rewrites the handlers.

| Method and path | Guard / rate | Body | Response | Refusals |
|---|---|---|---|---|
| `GET /api/reviews/gifts` | auth | — | `{success, gifts: GiftView[], pending: PendingGiftView[]}` (types in worker/lib/gifts/entitlements.ts). Never a code or verifier | — |
| `POST /api/reviews/gifts/:entitlementId/redeem` | auth · `gift_code 5/900` plus `gift_code_ip 20/3600` (explicit key `ip:<ip>`) | `{code}` (ASCII-normalise digits first) | `{success, gift: GiftView}` with `ui_state` `choose_item` or `ready` | **Every** failure is 400 `GIFT_CODE_INVALID`: wrong, used, revoked, locked, foreign or unknown id, broken linkage (`recheckPrinterGift`). 429 `RATE_LIMITED` |
| `POST /api/reviews/gifts/:entitlementId/choose` | auth · `gift_choose 30/300` | `{ref, optionValueIds?, colorId?}`. Only the snapshot's allowed values; pins are never overridable | `{success, gift}` | 404 `GIFT_NOT_FOUND`; 409 `GIFT_NOT_REDEEMED`; 409 `GIFT_IN_CART`; 409 `GIFT_ALREADY_ORDERED`; 400 `GIFT_CHOICE_INVALID` |
| `GET /api/reviews/admin/queue` | admin | `?state=submitted\|revision_needed\|approved\|rejected\|all&cursor=` | **the gift queue** (below) | — |
| `POST /api/reviews/admin/:id/reward` | admin | reject or request_changes: `{action, reason≥3}`, unchanged. approve of a **points** reward: unchanged, pinned by reviewMultiplier. approve of a **printer_gift** reward = **ISSUE**: `{action:'approve', level:1-5, mode:'level'\|'manual', manual?:{productId, saleType, optionValueIds, colorId, transportMethod}, note?, requestId (8-80)}` | `{success, review_id, reward_state:'approved', entitlement:{id, state:'code_issued', level, grant_mode}, code:'NNNNNN', code_issued_at, code_issued_by}`, header `Cache-Control: no-store`. A replay with the same `requestId` → `{success, replay:true, entitlement, code:null}` | 400 `GIFT_LEVEL_REQUIRED` (no default, no fallback); 400 `GIFT_LEVEL_EMPTY`; 400 `GIFT_SELECTION_INVALID` / `GIFT_COMPOSITION_UNSUPPORTED` / `GIFT_TRANSPORT_REQUIRED` / `GIFT_SALE_TYPE_UNAVAILABLE`; 409 `GIFT_ELIGIBILITY_CHANGED`; 409 `GIFT_ALREADY_ISSUED` (another requestId); 400 `SYSTEM_REVIEW_NO_REWARD` |
| `POST /api/reviews/admin/gifts/:id/issue` | admin | same body as the issue, for a **legacy `available`** entitlement (conversion) | same | same, plus 409 `GIFT_NOT_CONVERTIBLE` |
| `POST /api/reviews/admin/gifts/:id/revoke-code` | admin | `{reason≥5}` | `{success, gift}`. `code_state` → revoked; the state stays `code_issued` | 409 unless `code_state='issued'` |
| `POST /api/reviews/admin/gifts/:id/reissue-code` | admin | `{reason≥5, requestId}` | as the issue response (raw code once, `no-store`). `code_version+1`, attempts 0 | 409 unless the state is `code_issued` |
| `POST /api/reviews/admin/gifts/:id/cancel` | admin | `{reason≥5}` | `{success}`. From `code_issued`, `redeemed_ready_to_order` or legacy `available`. Same batch: the state change, code revoked, `DELETE cart_items WHERE gift_entitlement_id=?` and the audit row | 409 `GIFT_ALREADY_ORDERED` (cancel the order instead) |
| `POST /api/reviews/admin/gifts/:id/fulfill` | admin | — | legacy `selected` only (unchanged) | 400 |
| `GET /api/reviews/admin/gifts` | admin | `?state&cursor` | granted gifts with code state, attempts, issued at/by, redeemed at, order link and status, in-cart flag | — |
| `GET /api/reviews/admin/pools` | admin | — | `{success, items:[LevelItemView]}`: product snapshot (name, image, selling type, variant, colour, allowed lists), `active`, `sort`, `legacy:boolean`, and server `warnings` (archived, out of stock, selection gone) | — |
| `POST /api/reviews/admin/pools` | admin | `LevelItemInput` (worker/lib/gifts/levels.ts) | `{success, item}` | 400 `GIFT_*` from `validateLevelItem` |
| `PUT /api/reviews/admin/pools/reorder` | admin | `{level, ids:[…]}`. **Register it BEFORE `/:itemId`** | `{success, items}` | 400 |
| `POST /api/reviews/admin/pools/preview` | admin | `GiftSelectionInput` | `{success, ok, display, errors}`. Also serves the manual mode | — |
| `GET /api/reviews/admin/gift-options/:productId` | admin | — | the selectable projection: sale types actually offered, groups and values, colours with their option links, pre-order transports | 404 |
| `PUT /api/reviews/admin/pools/:itemId` · `DELETE …/:itemId` | admin | partial `LevelItemInput`; `active:false` disables | `{success, item}` | 404, 400 |

**Gift-queue row** (brief §3):

| Field | Contents |
|---|---|
| `review` | `{id, stars, body (full), media (all), created_at, status, source}` |
| `user` | `{id, email, username, name}` |
| `product` | `{id, name, name_ar, image, family, section{id, name_ar, name_en, name_ckb}}` |
| `order` | `{id, status, delivered_at}` |
| `order_item` | `{id, name_snapshot, option_snapshot}` |
| `unit` | `{id, unit_index, delivered_at, warranty_end_at, replaced_by_unit_id}` |
| `serial` | raw serial or null |
| `receipt_no` | — |
| `registration` | `{state: reviewer\|other\|released\|none, registered_at}` |
| `eligibility` | `{snapshot, live: GiftDiagnostics}` |
| `prior_reward` | — |
| `reward` | `{id, state, level, decided_by, decided_at, reason}` |
| `entitlement` | `{id, state, grant_mode, level, code_state, code_attempts, code_issued_at, code_issued_by, code_redeemed_at}` or null |
| `legacy` | true when `unit_id` is NULL (not checked against the new rules). Legacy rows also carry the Instagram evidence |
| `quality` | advice only: `{score, reasons, signals}`. **No tier, no level** |

**Issue.** The route first calls `recheckPrinterGift` (fail → 409 `GIFT_ELIGIBILITY_CHANGED`), builds and validates the snapshot, and generates the code and its verifier. Then it runs **one batch**:

1. `UPDATE review_rewards SET state='approved', quality_score=level, reason, decided_by, decided_at=:now WHERE id=? AND kind='printer_gift' AND state IN ('submitted','revision_needed') AND EXISTS (<RECHECK_SQL as a subquery>)`. The eligibility fence and the state fence are in one statement.
2. `INSERT INTO gift_entitlements (…, state='code_issued', grant_mode, max_level=chosen_level=level, gift_snapshot, gift_* when the item is fixed, code_verifier, code_state='issued', code_version=1, code_request_id=requestId, code_issued_at, code_issued_by) SELECT … WHERE EXISTS (SELECT 1 FROM review_rewards WHERE id=? AND state='approved' AND decided_at=:now)`. `reward_id` is UNIQUE.
3. `auditStatements('gift.issue', {level, mode, entitlement_id, code_version})`. **Never the code.**

If statement 2 inserted 0 rows, the route re-reads and answers one of three ways:

- the replay of the same `requestId` → no code
- another `requestId` → 409 `GIFT_ALREADY_ISSUED`
- the recheck failed → 409 `GIFT_ELIGIBILITY_CHANGED`

A `level` gift snapshots **every active item** of that level (`GiftSnapshot`, validated with `requireSellable:false`). If exactly one item remains and it has nothing to choose, `gift_*` is fixed at issue.

**Redeem.** The steps run in this order:

1. Claim an attempt: `UPDATE … SET code_attempts=code_attempts+1 WHERE id=? AND user_id=? AND state='code_issued' AND code_state='issued' AND code_attempts<5`. Zero rows → generic error.
2. `verifyGiftCode`.
3. `recheckPrinterGift`.
4. One batch:
   - `UPDATE … SET state='redeemed_ready_to_order', code_state='redeemed', code_redeemed_at=? … WHERE id=? AND user_id=? AND state='code_issued' AND code_state='issued' AND code_version=?`
   - `INSERT INTO gift_redemptions … SELECT … WHERE EXISTS(the row now redeemed at this instant)`. Its primary key makes the redemption happen once, for ever.
   - `auditStatements('gift.redeem')`.
5. The 5th failure also writes `audit('gift.code.locked')`.

Two concurrent correct submissions → exactly one success. The other gets the generic error.

### 6.3 Commerce — worker/routes/cart.ts and worker/routes/orders.ts (lane S3)

| Method and path | Guard / rate | Body | Response | Refusals |
|---|---|---|---|---|
| `POST /api/cart/gift-items` | auth · `gift_cart_add 30/300` | `{entitlementId, replaceCart?}`. Nothing else is read | the same cart payload as `POST /api/cart/items`, plus `already_in_cart?:true`. It lives under `/api/cart`, so the badge updates by itself | 404 `GIFT_NOT_FOUND`; 409 `GIFT_NOT_REDEEMED`, `GIFT_CHOICE_REQUIRED`, `GIFT_ALREADY_ORDERED`, `GIFT_NOT_AVAILABLE`; stock and type codes (`OUT_OF_STOCK`, `DIRECT_SALE_NOT_ENABLED`, `PREORDER_NOT_ENABLED`, `TRANSPORT_REQUIRED`, `GIFT_SALE_TYPE_UNAVAILABLE`); `CART_SHIPPING_CONFLICT` / `CART_SELLER_CONFLICT` (existing dialog, retry with `replaceCart`) |
| `PATCH /api/cart/items/:id` (gift line) | — | — | — | 409 `GIFT_LINE_LOCKED` |
| `DELETE /api/cart/items/:id`, `DELETE /api/cart` | unchanged | — | the gift becomes ready again (derived) | — |
| `GET /api/cart` | unchanged | — | gift line: `{kind:'gift', locked:true, unit_price_iqd:0, gift:{entitlement_id, level, value_iqd}, availability}`. No `benefitLines`, `warranty_plans:[]`, `support_gift_eligible:false`. It is placed **before** the inactive-product skip, so an unavailable gift shows as blocked instead of vanishing | — |
| `POST /api/orders/quote`, `POST /api/orders` | unchanged | unchanged | a gift line is priced at 0 through `verifyGiftCartLines`, using the entitlement's frozen selection | 409 `GIFT_NOT_ORDERABLE` / `GIFT_ALREADY_ORDERED`. The catch maps `GIFT_NOT_ORDERABLE`, and UNIQUE on `order_items.gift_entitlement_id`, **before** the generic CHECK → `CONFLICT_RETRY` |

**Add door.** It checks, in order:

1. The entitlement belongs to the user.
2. The state is `redeemed_ready_to_order` and an item is chosen.
3. It is idempotent: an existing line → `already_in_cart`.
4. `validateGiftSelection(requireSellable:true)`.
5. `enforceCartScope`.

Then it runs a **plain INSERT**, never an upsert, because cart.ts must keep exactly two `ON CONFLICT DO UPDATE SET qty` (tests/cartMultiOptionIdentity.test.ts). The INSERT writes `qty=1`, `shipping_method_id='gift:'||id`, `option_id=canonical[0]`, `option_value_ids`, `color_id`, `fulfillment_type=gift_sale_type`, `transport_method`, `warranty_plan_id=''` and `gift_entitlement_id`. A UNIQUE hit → `already_in_cart`.

**Checkout** (same batch):

- The gift `ComputedLine` has:
  - `unit=0, line=0, applied_iqd=0`
  - real `stock_targets` from `resolveForOrderType(frozen type)`: the direct counter, or nothing for a pre-order
  - `pricing_snapshot` zeroed, plus `gift{entitlement_id, reward_id, level, value_iqd}`
  - `transport_snapshot` `{method, commission_iqd:0, waived:true, waived_by:'gift'}`, which keeps `shipping_type=preorder_<route>`
  - `warranty_snapshot:null`
  - `cost_iqd` and `cost_basis` kept
  - no `benefit`, no offer
  - `shipping_method_id` `''`
- The ordinary `order_items` INSERT text stays **unchanged**. The gift variant adds `gift_entitlement_id, gift_order_seq` (seq = `order_seq+1`). Trigger `trg_order_items_gift_line_guard` proves the precondition.
- The flip: `UPDATE gift_entitlements SET state='ordered', order_id, order_item_id, ordered_at, order_seq=order_seq+1 WHERE id=? AND user_id=? AND state='redeemed_ready_to_order' AND order_seq=?`.
- The fence: `INSERT INTO order_reservation_fence(order_id,kind,expected,actual) SELECT ?, 'gift', <n>, (SELECT COUNT(*) FROM gift_entitlements WHERE order_id=? AND state='ordered')`.
- The existing loop deletes the cart line.
- Inventory: `planInventory` reserves, `planOrderDeduction` deducts once, cancel releases or restores once. There is no gift inventory; `gift_pool_items.stock` is never read or decremented for product rows.

`orderPublic` items add `is_gift` and `gift_entitlement_id`. Invoices show «هدية», and `transport.waived` already keeps the commission out. The Telegram order line gets a 🎁 marker.

## 7. Database — migrations/0165_reviews_gifts.sql (written; `migrate-check --twice` green)

- **`review_rewards`**
  - Columns: `unit_id`, `order_id`, `order_item_id`, `product_id` (plain TEXT pointers).
  - `idx_review_rewards_printer_unit` — UNIQUE `(unit_id) WHERE kind='printer_gift' AND unit_id IS NOT NULL`.
  - `idx_review_rewards_queue (kind, state, created_at)`.
- **`gift_pool_items`** (level items, extended, not duplicated)
  - Columns:
    - `product_id` — REFERENCES products(id)
    - `sale_type` — '' | direct_sale | pre_order
    - `option_value_ids` — pins, canonical
    - `color_id`
    - `transport_method`
    - `allowed_option_value_ids`, `allowed_color_ids` — the customer's subset
    - `sort`
    - `updated_at`
  - Indexes: `idx_gift_pool_items_level_sort (level, active, sort)` and `idx_gift_pool_items_product (product_id) WHERE product_id IS NOT NULL`.
  - `gift_pools` stays dormant.
- **`gift_entitlements`**, rebuilt:
  - Precedent 0141. `gift_redemptions` is stashed as `_mig0165_gift_redemptions`, then restored and the stash dropped. Every row, `reward_id` UNIQUE and `idx_gift_entitlements_user` are preserved. This was proven with data (scratchpad `arch/rebuild-data.mjs`).
  - The state CHECK is widened to add `code_issued`, `redeemed_ready_to_order` and `ordered`.
  - New columns:

    | Group | Columns |
    |---|---|
    | mode and snapshot | `grant_mode` (legacy \| level \| manual), `gift_snapshot` (`GiftSnapshot` JSON), `gift_item_ref` |
    | frozen line | `gift_product_id`, `gift_option_value_ids`, `gift_color_id`, `gift_sale_type`, `gift_transport_method` |
    | code | `code_verifier`, `code_state`, `code_attempts`, `code_version`, `code_request_id`, `code_issued_at`, `code_issued_by`, `code_redeemed_at`, `code_revoked_at` |
    | order link | `order_id`, `order_item_id`, `ordered_at`, `order_seq` |
    | cancel and housekeeping | `cancelled_at`, `cancelled_by`, `cancel_reason`, `updated_at` |

  - Table CHECKs:
    - legacy states only on legacy rows
    - `issued` ⇒ verifier
    - `code_issued` ⇒ code issued or revoked
    - no ready, ordered or fulfilled without a redeemed code
    - `ordered` ⇒ order, line, time and product
    - a new-flow `cancelled` ⇒ `cancelled_at`
  - Indexes: `idx_gift_entitlements_order (order_id) WHERE order_id IS NOT NULL` and UNIQUE `idx_gift_entitlements_order_item (order_item_id) WHERE NOT NULL`.
- **`cart_items`**
  - Column: `gift_entitlement_id`, with no FK.
  - UNIQUE `idx_cart_items_gift_line (gift_entitlement_id) WHERE NOT NULL`.
  - Trigger `trg_cart_items_gift_line_guard` (BEFORE INSERT): qty 1, the `gift:` discriminator, and the owner's entitlement ready with the same product; otherwise `RAISE GIFT_NOT_ORDERABLE`.
  - `idx_cart_levonis_line` is **not** rebuilt; the discriminator keeps gift lines out of it.
- **`order_items`**
  - Columns: `gift_entitlement_id`, and `gift_order_seq` (CHECK ≥1).
  - UNIQUE `idx_order_items_gift_line (gift_entitlement_id, gift_order_seq) WHERE gift_entitlement_id IS NOT NULL`. Two orders can never consume one gift, and a new order after a cancelled one is attempt n+1.
  - Trigger `trg_order_items_gift_line_guard` (BEFORE INSERT): qty 1 at 0/0, the buyer's entitlement ready, the same product, `seq = order_seq+1`.
- **`orders` triggers**
  - `trg_orders_cancel_returns_gift`
  - `trg_orders_reopen_gift_guard` (`GIFT_ORDER_REOPEN_REFUSED`)
  - `trg_orders_delivered_fulfils_gift`
- **Trigger rules.** Triggers name only columns no test drops. They were created after the rebuild. A future rebuild of `cart_items` or `orders` must re-create them.
- **Registered in the same change:**
  - `worker/lib/schemaVersion.ts` (0165, count 146)
  - `mediaRefs.ts`:
    - source `gift_entitlements.gift_snapshot`, json
    - NON_MEDIA: `gift_entitlements.gift_option_value_ids`, and on `gift_pool_items`: `option_value_ids`, `allowed_option_value_ids`, `allowed_color_ids`
  - `productDeletion.ts` BLOCKING refs:
    - `gift_pool_items`: `PRODUCT_IN_GIFT_LEVEL`
    - `review_rewards`: `PRODUCT_HAS_REVIEW_REWARDS`. This closes the pre-existing FK hole behind OWNED `reviews`.
    - `gift_entitlements` live gifts: `PRODUCT_IN_OPEN_GIFT`
  - `orderDeletion.ts`: `review_rewards` and `gift_entitlements` added to HISTORY, with the `order_item_id` unlink
  - `scripts/wipe-live-content.sql`: `gift_pool_items` and `gift_pools` now run before `products`
  - tolerance and snapshot entries:
    - `gift_entitlements <- orders.ts#POST /`
    - `cart_items <- gifts.ts#POST /admin/gifts/:id/cancel`
    - two `media_cleanup_jobs` entries <- the `worker/lib/reviews/media.ts` staging statements
  - No new table, so `ownership.ts` is unchanged. The `_mig0165_` and `_new` names map back to their owners.

## 8. UI screens (C1, C2, C3)

**Budgets.** Measured on this base with `vite build` in the scratchpad at `arch/dist-base`:

| Item | Size | Budget |
|---|---|---|
| CSS total | **61,387 B** | 61,440 B, so **53 B headroom** |
| entry | 81.3 KB | 120 KB |
| initial payload | 214.3 KB | 240 KB |
| `Product` chunk | 42.1 KB | — |
| `ReviewSheet` chunk (static in Orders and OrderDetail) | 6.9 KB | — |
| `AdminReviews` chunk | 9.6 KB | — |
| `MyGifts` chunk | 4.7 KB | — |
| `vendor-phone` | 35.6 KB | — |

**Rule: zero new CSS classes.** Only use classes already in the entry stylesheet. Anything missing goes in `style={{…}}`. Class-like tokens are also forbidden in comments, because Tailwind scans raw text. Check with `node <scratchpad>/arch/hascls.mjs cls1 cls2 …`, which reads the entry CSS; `ALL_CSS=1` adds the lazy chunk CSS, including `.ap`. After a build, `tests/bundleBudget.test.ts` must stay green.

- **C1 — ReviewSheet is the ONLY review form.**
  - Move it to Sheet v2 (`ui/Sheet`, `detents={['large']}`, header and footer, `dirty`).
  - Stars: 44 px radios.
  - Textarea with the live counter «x/30 · y/4000» from `checkReviewText`, and the reason shown inline.
  - `ReviewMediaPicker`: multi-select photos, a video input (`video/mp4,video/quicktime,video/webm`), camera on touch devices, `blob:` previews, remove, **replace** in the same slot, counters «الصور x/10» and «الفيديو x/2», a per-file progress bar (XHR `upload.onprogress`, the TradeInWizard idiom, no 20 s timeout), and client pre-checks for type and size.
  - The submit button is disabled while any upload is pending or failed, or while the text rule fails; the reason is in the footer (`aria-live`).
  - Limit errors appear in the three languages.
  - Edit mode uses PUT with the full media list.
  - The gift hint per line comes only from the server's `gift` block.
  - The Instagram block is deleted.
  - New prop `initialProductId`.
  - The 13 ckb placeholders are replaced with real Sorani.
  - `ReviewSection` loses its form. «اكتب/عدّل مراجعتك» opens `ReviewSheet` lazily. The list and the «my review» card render `ReviewMediaGallery`.
  - **Lazy loading:** `Product.tsx` does `const ReviewSection = React.lazy(…)` and keeps the literal `<ReviewSection productId={product.id} />` (pinned by giniCheckoutUi). `Orders.tsx` and `OrderDetail.tsx` load `ReviewSheet` with `React.lazy`, mounted after the first open.
  - `ReviewMediaGallery`: a contract stub is written; C1 owns the real one. It has thumbnails and a full-size viewer through `Overlay` (the `Product.tsx:4187` lightbox recipe), and videos use `controls playsInline preload="none"`, **never autoplay**, several allowed. It is used by `ReviewSection`, the «my review» card, `MyReviewsTab` and the rated rows of `ReviewSheet`.
  - OrderDetail: exclude system markers from «reviewed»; the thanks text says «published»; a line with `is_gift` shows the badge «هدية / Gift / دیاری».
- **C2 — Admin «المراجعات والهدايا».**
  - `AdminReviews.tsx` keeps its basename, because the chunk name is pinned. It becomes a thin shell over `src/components/adminReviews/*`.
  - Tabs: «كل المراجعات» (every review, moderation), «هدايا الطابعات» (the gift queue: the §3 facts, a 10-row ✓/✗ checklist of snapshot and live values, the gallery, the decision panel), «مستويات الهدايا» (the levels editor) and «الهدايا الممنوحة».
  - The decision panel:
    - level 1–5 with **no preselection**
    - the mode «استخدام هدايا المستوى / اختيار هدية يدويًا»; manual uses `ProductPicker` inside the `.ap` scope, the gift-options projection and the preview
    - «تأكيد وإصدار الكود», guarded by `useConfirm`, with a `requestId` generated once per attempt
    - `IssuedCodeDialog` shows the code once (`dir="ltr" font-mono`) with «نسخ الكود» (`copyText`). It is not dismissible by the scrim or Escape, and the code is cleared on close.
  - Revoke and re-issue go through `usePrompt(reason)`.
  - The levels editor lets the admin add, edit, disable, delete (`useConfirm`) and reorder (↑/↓) items, via a Sheet v2 configurator for product, sale type, pins, allowed subsets and route.
  - Remove `window.prompt` and `window.confirm`, the hex colours and the predicted-level UI.
  - Admin order modal: gift badge.
- **C3 — /gifts and the cart.**
  - `MyGifts.tsx` is rewritten in place (the route and lazy import are unchanged) as one card per `ui_state`:
    - `pending`: a quiet card
    - `awaiting_code`: printer image and name, «تم اعتماد مراجعتك للحصول على هدية», the level, the **6-box code input** and «استرداد الهدية». Errors are generic.
    - `locked`: «تواصل مع الدعم»
    - `choose_item`: alternatives as `.lv-choice`, plus the allowed option and colour picks
    - `ready`: «تم استرداد الهدية — الهدية جاهزة للطلب», image, name, level, بيع مباشر/طلب مسبق, option, colour, and «أضف الهدية إلى السلة», with `ShippingConflictDialog` → `replaceCart`
    - `in_cart`: «الهدية موجودة في السلة» and a link to `/cart`
    - `ordered`: «تم استرداد الهدية وطلبها», the order number and status (`statusLabel`) and «عرض الطلب» → `/orders/:id`
    - `delivered` and `cancelled`
    - `legacy`: read-only
  - **OTP:** extend `src/components/auth/OtpBoxes.tsx`. Import `toAsciiDigits` from `src/lib/localeNumber` instead of `./PhoneField`, keeping `normalizeOtp` identical; this removes `vendor-phone` from `/gifts`. Add a prop `appearance?: 'auth'|'plain'`. The default is unchanged. `plain` uses entry-CSS classes only, since `lv-otp*` is not in the entry CSS.
  - `GiftsEntry` counts `ui_state ∈ {awaiting_code, choose_item, ready}`.
  - `Cart.tsx`: a gift line shows the «هدية» chip and `Money iqd={0}` with its value, has no stepper, option or warranty editors, and can be removed. `Checkout.tsx` shows the gift line at 0 in the summary.
  - C3 also owns the refusal strings (§9) and the policy texts (S15).

## 9. Refusal codes — ar / en / ckb

C3 pastes the customer-facing codes into `src/lib/refusalStrings.ts`, and adds the emitting worker files to `tests/refusalStrings.test.ts`'s source list. The admin-only codes go in `src/components/adminReviews/strings.ts` (C2).

| Code | ar | en | ckb |
|---|---|---|---|
| REVIEW_TEXT_TOO_SHORT | اكتب 30 حرفًا حقيقيًا على الأقل عن تجربتك مع المنتج. | Write at least 30 real characters about your experience with the product. | لانیکەم 30 پیتی ڕاستەقینە دەربارەی ئەزموونت لەگەڵ بەرهەمەکە بنووسە. |
| REVIEW_TEXT_TOO_LONG | نص المراجعة أطول من 4000 حرف. اختصره قليلًا. | The review is longer than 4000 characters. Please shorten it. | دەقی هەڵسەنگاندنەکە لە 4000 پیت درێژترە. تکایە کورتی بکەرەوە. |
| REVIEW_TEXT_REPETITIVE | النص يبدو مكررًا أو رموزًا فقط. اكتب رأيك بكلمات حقيقية. | The text looks repeated or made of symbols only. Write your opinion in real words. | دەقەکە دووبارەکراوە یان تەنها هێمایە. بیروڕای خۆت بە وشەی ڕاستەقینە بنووسە. |
| REVIEW_ALREADY_EXISTS | قيّمت هذا المنتج من قبل. يمكنك تعديل مراجعتك بدل كتابة واحدة جديدة. | You already reviewed this product. You can edit your review instead. | پێشتر ئەم بەرهەمەت هەڵسەنگاندووە. دەتوانیت هەڵسەنگاندنەکەت دەستکاری بکەیت. |
| REVIEW_NOT_EDITABLE | لا يمكن تعديل هذه المراجعة بعد الآن. | This review can no longer be edited. | ئیتر ناتوانرێت ئەم هەڵسەنگاندنە دەستکاری بکرێت. |
| REVIEW_MEDIA_TOO_MANY_IMAGES | الحد 10 صور لكل مراجعة. احذف بعض الصور ثم أرسل. | A review can have up to 10 photos. Remove some and send again. | هەر هەڵسەنگاندنێک دەتوانێت تا 10 وێنەی هەبێت. هەندێکیان لابە و دووبارە بنێرە. |
| REVIEW_MEDIA_TOO_MANY_VIDEOS | الحد فيديوهان لكل مراجعة. احذف فيديو ثم أرسل. | A review can have up to 2 videos. Remove one and send again. | هەر هەڵسەنگاندنێک دەتوانێت تا 2 ڤیدیۆی هەبێت. یەکێکیان لابە و دووبارە بنێرە. |
| REVIEW_MEDIA_NOT_OWNED | تعذّر العثور على أحد الملفات المرفوعة. ارفعه مرة أخرى. | One of the uploaded files could not be found. Upload it again. | یەکێک لە فایلە بارکراوەکان نەدۆزرایەوە. دووبارە باری بکەرەوە. |
| REVIEW_MEDIA_KIND | أحد الملفات ليس صورة ولا فيديو. اختر ملفًا آخر. | One of the files is neither a photo nor a video. Choose another file. | یەکێک لە فایلەکان نە وێنەیە نە ڤیدیۆ. فایلێکی تر هەڵبژێرە. |
| REVIEW_MEDIA_DUPLICATE | أضفت الملف نفسه مرتين. احذف النسخة المكررة. | You added the same file twice. Remove the duplicate. | هەمان فایلت دوو جار زیاد کردووە. دووبارەکەی لابە. |
| REVIEW_MEDIA_REUSED | هذا الملف مستخدم في مراجعة سابقة لك. أضف صورًا أو فيديو من هذا المنتج. | This file is already in one of your earlier reviews. Add photos or video of this product. | ئەم فایلە لە هەڵسەنگاندنێکی پێشووتدا بەکارهاتووە. وێنە یان ڤیدیۆی ئەم بەرهەمە زیاد بکە. |
| REVIEW_MEDIA_IN_USE | هذا الملف مرتبط بمراجعة أخرى. ارفع ملفًا جديدًا. | This file belongs to another review. Upload a new one. | ئەم فایلە سەر بە هەڵسەنگاندنێکی ترە. فایلێکی نوێ بار بکە. |
| REVIEW_UPLOAD_UNSUPPORTED | نوع الملف غير مدعوم. ارفع صورة JPEG أو PNG أو WebP، أو فيديو MP4 أو MOV أو WebM. | This file type is not supported. Upload a JPEG, PNG or WebP photo, or an MP4, MOV or WebM video. | ئەم جۆرە فایلە پشتگیری ناکرێت. وێنەی JPEG یان PNG یان WebP، یان ڤیدیۆی MP4 یان MOV یان WebM بار بکە. |
| REVIEW_UPLOAD_TOO_LARGE | الملف أكبر من المسموح: الصورة حتى 8 ميغابايت والفيديو حتى 40 ميغابايت. | The file is too large: photos up to 8 MB, videos up to 40 MB. | فایلەکە لە ڕادەی ڕێگەپێدراو گەورەترە: وێنە تا 8 مێگابایت و ڤیدیۆ تا 40 مێگابایت. |
| VIDEO_UNSUPPORTED | هذا الفيديو لا يمكن تشغيله في المتصفح. صدّره بصيغة MP4 ثم أعد رفعه. | This video cannot be played in a browser. Export it as MP4 and upload it again. | ئەم ڤیدیۆیە لە وێبگەڕدا لێنادرێت. بە شێوازی MP4 دەریبکە و دووبارە باری بکەرەوە. |
| IMAGE_HEIC_UNSUPPORTED | (the three halves of the existing `HEIF_REFUSAL`, worker/routes/uploads.ts:134) | ← | ← |
| GIFT_CODE_INVALID | الكود غير صحيح أو غير صالح. تأكد من الأرقام أو تواصل مع الدعم. | The code is incorrect or no longer valid. Check the digits or contact support. | کۆدەکە هەڵەیە یان ئیتر کار ناکات. ژمارەکان بپشکنە یان پەیوەندی بە پشتگیرییەوە بکە. |
| GIFT_NOT_FOUND | لم نجد هذه الهدية في حسابك. | We could not find this gift on your account. | ئەم دیارییە لە هەژمارەکەتدا نەدۆزرایەوە. |
| GIFT_NOT_REDEEMED | أدخل كود الهدية أولًا لاستردادها. | Enter the gift code first to redeem it. | سەرەتا کۆدی دیارییەکە بنووسە بۆ وەرگرتنەوەی. |
| GIFT_CHOICE_REQUIRED | اختر هديتك أولًا ثم أضفها إلى السلة. | Choose your gift first, then add it to the cart. | سەرەتا دیارییەکەت هەڵبژێرە، پاشان زیادی بکە بۆ سەبەتە. |
| GIFT_CHOICE_INVALID | هذا الاختيار غير متاح لهذه الهدية. اختر من الخيارات المعروضة. | This choice is not available for this gift. Pick one of the options shown. | ئەم هەڵبژاردنە بۆ ئەم دیارییە بەردەست نییە. یەکێک لە هەڵبژاردنە پیشاندراوەکان هەڵبژێرە. |
| GIFT_IN_CART | الهدية موجودة في السلة. احذفها من السلة لتغيير اختيارك. | The gift is in your cart. Remove it from the cart to change your choice. | دیارییەکە لە سەبەتەکەدایە. لە سەبەتەکە لایبە بۆ گۆڕینی هەڵبژاردنەکەت. |
| GIFT_ALREADY_ORDERED | طُلبت هذه الهدية بالفعل ولا يمكن طلبها مرة أخرى. | This gift has already been ordered and cannot be ordered again. | ئەم دیارییە پێشتر داواکراوە و ناتوانرێت دووبارە داوا بکرێتەوە. |
| GIFT_NOT_AVAILABLE | هذه الهدية لم تعد متاحة. تواصل مع الدعم إن كان ذلك خطأ. | This gift is no longer available. Contact support if this is a mistake. | ئەم دیارییە ئیتر بەردەست نییە. ئەگەر هەڵەیە پەیوەندی بە پشتگیرییەوە بکە. |
| GIFT_NOT_ORDERABLE | لا يمكن طلب الهدية الآن. حدّث صفحة الهدايا ثم حاول مرة أخرى. | The gift cannot be ordered right now. Refresh your gifts page and try again. | ئێستا ناتوانرێت دیارییەکە داوا بکرێت. پەڕەی دیارییەکان نوێ بکەرەوە و دووبارە هەوڵ بدەرەوە. |
| GIFT_LINE_LOCKED | سطر الهدية ثابت: لا يمكن تغيير كميته أو خياراته. يمكنك حذفه فقط. | A gift line is fixed: its quantity and options cannot change. You can only remove it. | هێڵی دیاری جێگیرە: بڕ و هەڵبژاردنەکانی ناگۆڕدرێن. تەنها دەتوانیت لایببەیت. |
| GIFT_SALE_TYPE_UNAVAILABLE | نوع البيع المحدد لهذه الهدية غير متاح حاليًا. تواصل مع الدعم. | The sale type set for this gift is not available right now. Contact support. | جۆری فرۆشتنی دیاریکراو بۆ ئەم دیارییە ئێستا بەردەست نییە. پەیوەندی بە پشتگیرییەوە بکە. |

**Admin-only codes** (C2 strings):

| Code | ar | en | ckb |
|---|---|---|---|
| GIFT_LEVEL_REQUIRED | اختر مستوى الهدية من 1 إلى 5. | Choose the gift level, 1 to 5. | ئاستی دیارییەکە لە 1 تا 5 هەڵبژێرە. |
| GIFT_LEVEL_EMPTY | لا توجد هدايا فعّالة في هذا المستوى. أضف منتجًا أو اختر هدية يدويًا. | This level has no active gifts. Add a product or choose a gift manually. | هیچ دیارییەکی چالاک لەم ئاستەدا نییە. بەرهەمێک زیاد بکە یان دیارییەک بە دەست هەڵبژێرە. |
| GIFT_ELIGIBILITY_CHANGED | لم تعد المراجعة مؤهلة (تغيّر ربط الطابعة أو النجوم أو الطلب). | The review is no longer eligible (printer link, stars or order changed). | هەڵسەنگاندنەکە ئیتر شایستە نییە (بەستنەوەی چاپکەر، ئەستێرەکان یان داواکارییەکە گۆڕاوە). |
| GIFT_ALREADY_ISSUED | صدر كود لهذه المراجعة ولا يُعرض مرة أخرى. استخدم «إلغاء وإصدار كود جديد». | A code was already issued and is never shown again. Use “Revoke and issue a new code”. | پێشتر کۆدێک دەرچووە و دووبارە پیشان نادرێتەوە. «هەڵوەشاندنەوە و دەرکردنی کۆدی نوێ» بەکاربهێنە. |
| GIFT_COMPOSITION_UNSUPPORTED | الحزم والعروض الغامضة لا يمكن أن تكون هدية. | Bundles and mystery offers cannot be gifts. | کۆمەڵە و پێشکەشکراوە نادیارەکان ناتوانن ببنە دیاری. |
| GIFT_SELECTION_INVALID | الخيار أو اللون المختار لا يخص هذا المنتج أو غير متاح. | The chosen option or colour does not belong to this product or is unavailable. | هەڵبژاردن یان ڕەنگی هەڵبژێردراو سەر بەم بەرهەمە نییە یان بەردەست نییە. |
| GIFT_TRANSPORT_REQUIRED | اختر طريق الشحن للطلب المسبق. | Choose the shipping route for the pre-order. | ڕێگای گواستنەوە بۆ پێش-داواکارییەکە هەڵبژێرە. |
| GIFT_ORDER_REOPEN_REFUSED | لا يُعاد فتح طلب فيه هدية بعد إلغائه؛ عادت الهدية للزبون ليطلبها من جديد. | An order holding a gift cannot be re-opened; the gift went back to the customer to order again. | داواکارییەک کە دیاری تێدایە دووبارە ناکرێتەوە؛ دیارییەکە گەڕایەوە بۆ کڕیار تا دووبارە داوای بکات. |

**Key UI sentences** (for C1, C2 and C3):

| ar | en | ckb |
|---|---|---|
| تم اعتماد مراجعتك للحصول على هدية | Your review was approved for a gift | هەڵسەنگاندنەکەت بۆ وەرگرتنی دیاری پەسەند کرا |
| أدخل الكود المكوّن من 6 أرقام | Enter the 6-digit code | کۆدە 6 ژمارەییەکە بنووسە |
| استرداد الهدية | Redeem gift | وەرگرتنەوەی دیاری |
| تم استرداد الهدية — الهدية جاهزة للطلب | Gift redeemed — ready to order | دیارییەکە وەرگیرایەوە — ئامادەیە بۆ داواکردن |
| أضف الهدية إلى السلة | Add the gift to cart | دیارییەکە زیاد بکە بۆ سەبەتە |
| الهدية موجودة في السلة | The gift is in your cart | دیارییەکە لە سەبەتەکەدایە |
| تم استرداد الهدية وطلبها | Gift redeemed and ordered | دیارییەکە وەرگیرایەوە و داواکرا |
| عرض الطلب | View order | بینینی داواکاری |
| تم تسليم الهدية | Gift delivered | دیارییەکە گەیەنرا |
| مراجعتك قيد اعتماد الهدية | Your review is being considered for a gift | هەڵسەنگاندنەکەت لە ژێر پێداچوونەوەدایە بۆ دیاری |
| تأكيد وإصدار الكود | Confirm and issue code | پشتڕاستکردنەوە و دەرکردنی کۆد |
| نسخ الكود | Copy code | کۆپیکردنی کۆد |
| إلغاء وإصدار كود جديد | Revoke and issue a new code | هەڵوەشاندنەوە و دەرکردنی کۆدی نوێ |
| استخدام هدايا المستوى / اختيار هدية يدويًا | Use the level's gifts / Choose a gift manually | بەکارهێنانی دیارییەکانی ئاست / هەڵبژاردنی دیاری بە دەست |

The brand is always «Levonis» in Latin letters.

## 10. Lanes — six builders, one owner per file

Every builder must, in addition to the lane rules below:

- read this document
- never edit a file another lane owns
- run `npm run check` scoped to their files, plus their own tests
- commit nothing unless told to

A lane may ADD optional fields to a contract; it may **rename nothing**.

- **S1 — reviews server**
  - Owns:
    - `worker/routes/reviews.ts`
    - `worker/lib/reviews/{text,media,eligibility,points}.ts`
    - `packages/catalog/src/reviewRules.ts`
    - `worker/lib/reviewQuality.ts`: drop `tierFor`, `tier` and `rewardEligible`; keep the score and signals
    - `worker/lib/mediaStorage.ts`: `StoreMediaInput.customMetadata` pass-through only
    - `worker/lib/imageConvert.ts`: `extensionFor` webm
    - `worker/routes/devices.ts`: the two hook lines
    - `worker/lib/publicApi/resources/products.ts`: counts
    - tests: new `tests/reviewRules.test.ts`, `tests/reviewSubmission.test.ts`, `tests/reviewMedia.test.ts`, `tests/reviewEligibility.test.ts`, `tests/reviewGiftReadmission.test.ts`, `tests/reviewsAdminList.test.ts`, `tests/reviewsMediaRange.test.ts`; updates to `tests/reviewQuality.test.ts`, `tests/reviewMultiplier.test.ts`, `tests/orderReviewSheet.test.ts`, `tests/mediaAuthority.test.ts`, `tests/publicApi.test.ts`
  - Contracts: §3, §4, §5, §6.1. `giftDiagnostics` and `admitPrinterGiftForUnit` are to be filled in.
  - Keep `VIDEO_MAX`. Keep the mediaAuthority fragments. The existing reward-route calls in S1's tests go through `giftRoutes` (already mounted in the test harnesses).
- **S2 — gifts server**
  - Owns:
    - `worker/routes/gifts.ts`
    - `worker/lib/gifts/{codes,entitlements,levels}.ts`
    - tests: `tests/giftLevels.test.ts` (rewrite: levels are products; the `LEVEL_COMPOSITION` pin is deleted with the box redeem), new `tests/giftIssue.test.ts`, `tests/giftRedeem.test.ts`, `tests/giftsList.test.ts`, `tests/giftLevelsEditor.test.ts`, `tests/giftQueue.test.ts`
  - Contracts: §2, §6.2, `GiftView`, `GiftSnapshot`, `validateGiftSelection` (S3 calls it with `requireSellable:true`) and `LevelItemInput`.
  - Calls S1's `recheckPrinterGift` and `giftDiagnostics`.
  - Must keep reject, request_changes and points-approve byte-compatible (tests/reviewQuality and tests/reviewMultiplier).
  - Delete the box redeem, `LEVEL_COMPOSITION`, `levelAvailability`, `randomIndex`, the stock decrement and the tier gates.
- **S3 — commerce server**
  - Owns:
    - `worker/routes/cart.ts`
    - `worker/routes/orders.ts`
    - `worker/lib/gifts/cartLine.ts`
    - `worker/lib/cartLineProjection.ts`: add `{name:'gift_entitlement_id', sqlDefault:'NULL'}`
    - `worker/lib/membershipOps.ts`: `orderHasSupportEligibleLine`, `supportGiftGuard` and `orderHasPrinterProduct`, each gaining `AND oi.gift_entitlement_id IS NULL`. On a database behind 0165, `isSchemaMissing` counts as "no gift lines".
    - `worker/lib/invoices.ts`: «هدية»
    - `worker/lib/adminTopicRouting.ts`: 🎁
    - tests: new `tests/giftCart.test.ts`, `tests/giftCheckout.test.ts`, `tests/giftOrderLifecycle.test.ts` (cancel from every door → ready; delivered → fulfilled; reopen refused; order deletion unlinks), `tests/giftRewardExclusions.test.ts`
  - Contracts: §6.3, S7–S10, `GiftLineVerdict`.
  - Must keep green: cartMultiOptionIdentity, cartUpsert, cartIdentityContract, orderTypeContract, orderSelectionSnapshots, extendedWarranty, checkoutSchemaResilience, cartServerError, financeLedger, ordersIdempotencyScope, reservationFence, orderCancelAtomic, orderExpiry, bundle and mystery, preorderGift, tradeIn.
- **C1 — client reviews**
  - Owns:
    - `src/components/orders/ReviewSheet.tsx`
    - `src/components/reviews/ReviewSection.tsx`
    - `src/components/reviews/ReviewMediaGallery.tsx` (replace the stub, keep the props)
    - new `src/components/reviews/{ReviewMediaPicker,ReviewMediaViewer,StarRating}.tsx`, `reviewStrings.ts` and `reviewUpload.ts` (XHR with progress to `/api/reviews/uploads`)
    - `src/pages/Product.tsx` (the lazy ReviewSection only)
    - `src/pages/Orders.tsx` and `src/pages/OrderDetail.tsx` (lazy sheet, system-marker fix, thanks text, gift badge)
    - `src/components/orders/OrderCard.tsx` (gift badge)
    - `src/components/profile/MyReviewsTab.tsx`
    - tests: `tests/reviewSheetUi.test.ts`, `tests/reviewStringsUi.test.ts` (the ordersListUi Sorani pattern), `tests/reviewMediaPickerLogic.test.ts`
  - Contracts: §5, §6.1, `ReviewMediaGalleryProps`.
  - Keep `orderReviewSheet`'s «no dangerouslySetInnerHTML» and giniCheckoutUi's literal.
- **C2 — client admin**
  - Owns:
    - `src/components/AdminReviews.tsx` (shell)
    - `src/components/adminReviews/*`: `strings.ts`, `ReviewsList.tsx`, `GiftQueue.tsx`, `ReviewFacts.tsx`, `GiftDecisionPanel.tsx`, `IssuedCodeDialog.tsx`, `GiftLevelsEditor.tsx` (lazy), `GiftItemSheet.tsx` (lazy), `GrantedGifts.tsx`
    - `src/pages/Admin.tsx` (only the reviews sidebar label with ckb and the `.ap` exclusion list, if the panel moves to `.ap`)
    - `src/components/adminOrders/OrderDetailModal.tsx` (gift badge)
    - tests: `tests/adminReviewsUi.test.ts`, `tests/adminReviewsStrings.test.ts`
  - Contracts: §6.1 admin, §6.2 admin.
- **C3 — client gifts and cart**
  - Owns:
    - `src/components/reviews/MyGifts.tsx` (the only file of `/gifts`)
    - new `src/components/reviews/gifts/{GiftCard.tsx, giftStrings.ts}`
    - `src/components/auth/OtpBoxes.tsx`
    - `src/components/orders/GiftsEntry.tsx`
    - `src/pages/Cart.tsx`, `src/pages/Checkout.tsx`
    - `src/lib/refusalStrings.ts` and `tests/refusalStrings.test.ts` (all §9 customer codes)
    - `worker/lib/policies/rewards.ts` and `faq.ts` (S15, v5; the texts are marked «OWNER REVIEW» in the handoff)
    - tests: `tests/giftsPageUi.test.ts`, `tests/giftStringsUi.test.ts`, `tests/cartGiftLineUi.test.ts`, plus `tests/fillButton.test.ts` kept green
  - Contracts: `GiftView` and `ui_state`, §6.2 customer, §6.3 cart.

**Integrator** (after the six lanes):

- `worker/index.ts` is already mounted, and `App.tsx` needs no new route. Leave the `/gifts` wrapper.
- `tests/bundleBudget.test.ts`:
  - `ReviewSection`, `ReviewSheet` and `ReviewMediaViewer` are lazy and not in the initial payload
  - `vendor-phone` is not in the `MyGifts` closure
  - `AdminReviews` stays a chunk
  - the CSS budget still holds
- `docs/DECISIONS.md` rows: S1–S17, and the owner items of §12.
- A note in `docs/FINAL_PHASE.md` §5 that it is superseded.
- Replace the gift block of `scripts/api-tests-v3.mjs` (`:405-459`).
- Run the whole unit suite, `npm run check` and `npm run build`, plus the budgets.
- Deploy order: **apply 0165 before the Worker**. The ordinary `order_items` INSERT never names the new columns, and cart reads go through `CART_LINE_COLUMNS` defaults, so a Worker that arrives ahead of the migration still sells.

## 11. Test map — every line of brief §9 and §18

| Brief line | Test file → test name |
|---|---|
| §9 text < 30 refused | reviewRules → «29 real characters are refused»; reviewSubmission → «POST with 29 real characters is 400 REVIEW_TEXT_TOO_SHORT and stores nothing» |
| §9 30+ accepted | reviewRules → «30 real characters in ar/en/ckb are accepted»; reviewSubmission → «30 real characters publish at once» |
| §9 10 images ok, 11 refused | reviewMedia → «10 images are accepted; the 11th is refused, never sliced» |
| §9 2 videos ok, 3 refused | reviewMedia → «2 videos are accepted; a 3rd is refused» |
| §9 fake MIME refused | reviewMedia → «a text file named .jpg and declared image/jpeg is refused by its signature»; → «an audio-only MP4 is VIDEO_UNSUPPORTED» |
| §9 duplicate media | reviewMedia → «the same key or sha256 twice is REVIEW_MEDIA_DUPLICATE; the digest is stored on the object and in reviews.media» |
| §9 non-owner cannot review | reviewSubmission → «a stranger posting with the buyer's order gets 404 and nothing is stored» |
| §9 1–4★ printer published, not queued | reviewEligibility → «a 1–4 star printer review publishes and enters no gift queue» |
| §9 5★ + text, not registered | reviewEligibility → «5 stars and text with the printer not linked in the warranty centre: no queue» |
| §9 registered to another user | reviewEligibility → «a unit linked to another account: no queue» |
| §9 correct → queue once | reviewEligibility → «a linked printer, 5 stars and text enter the queue exactly once (retry and double POST)» |
| §9 no two rewards per unit | reviewEligibility → «a second reward on one unit is refused by the unique index; a replacement on a rewarded chain is not admitted» |
| §9 admin picks each level 1–5 | giftIssue → «the admin issues at each level 1..5, and nothing is preselected or defaulted» |
| §9 code is 6 digits | giftIssue → «the issued code is exactly six digits» |
| §9 raw code not stored | giftIssue → «the raw code is in no column of any table and in no audit row» |
| §9 correct code works once | giftRedeem → «the correct code redeems once» |
| §9 reuse fails | giftRedeem → «a used code fails with the generic error» |
| §9 wrong code, no information | giftRedeem → «a wrong code, a foreign entitlement and an unknown id all answer the same 400 GIFT_CODE_INVALID» |
| §9 brute force limited | giftRedeem → «five wrong tries lock the code; the per-user and per-IP limits answer 429» |
| §9 double issue | giftIssue → «a double press with the same requestId makes one entitlement and one code; the replay returns no code» |
| §9 concurrent redeem | giftRedeem → «two concurrent redemptions of one code: exactly one succeeds» |
| §9 media public and in admin | reviewSubmission → «media appear on GET /product/:id and in GET /admin/reviews»; giftQueue → «the gift queue carries every image and video»; reviewSheetUi → «the gallery renders videos without autoplay» |
| §18 real products per level 1–5 | giftLevelsEditor → «a real product can be added to each level 1..5» |
| §18 edit, delete, disable | giftLevelsEditor → «a level item can be edited, disabled and deleted; granted gifts keep their snapshot» |
| §18 direct sale, option and colour | giftLevelsEditor → «a direct-sale item with a valid option and colour is accepted» |
| §18 pre-order, option and colour | giftLevelsEditor → «a pre-order item with option, colour and route is accepted» |
| §18 variant of another product | giftLevelsEditor → «an option value of another product is refused (OPTION_VALUE_NOT_FOUND)» |
| §18 colour not linked | giftLevelsEditor → «a colour not linked to the chosen option is refused (COLOR_OPTION_MISMATCH)» |
| §18 manual gift | giftIssue → «a manual gift pins one product, variant and colour and overrides the level items» |
| §18 snapshot unchanged | giftIssue → «editing the product after issue leaves gift_snapshot unchanged» |
| §18 redeem → ready only | giftRedeem → «redeeming gives redeemed_ready_to_order and creates no order, cart line or ledger row» |
| §18 add once | giftCart → «the gift is added to the cart once at 0 IQD» |
| §18 no duplicate | giftCart → «a second add, sequential or concurrent, makes no second line» |
| §18 remove, then re-add | giftCart → «removing the gift line returns it to ready; adding again works» |
| §18 success → ordered | giftCheckout → «a successful checkout marks the gift ordered with order_id, order_item_id and ordered_at» |
| §18 add button gone | giftsList → «after ordering, /gifts shows ui_state ordered with the order and no add action»; giftsPageUi → «the ordered card shows «عرض الطلب» and never «أضف الهدية إلى السلة»» |
| §18 API refuses ordered | giftCart → «adding an ordered gift is refused (GIFT_ALREADY_ORDERED)» |
| §18 concurrent checkouts | giftCheckout → «two concurrent checkouts of one gift make one order; the loser consumes nothing» |
| §18 direct sale deducts once | giftCheckout → «a direct-sale gift reserves once and deducts once at confirmation» |
| §18 pre-order keeps its type | giftCheckout → «a pre-order gift keeps pre_order, its route and its lead time» |
| §18 /gifts ready, then ordered | giftsList → «/gifts shows ready before the order and ordered after it» |

## 12. For the owner to decide or confirm

1. **Policy v5 texts** (S15). The 5★ condition reverses policy 13.3 and 7.4. Several markets treat a reward conditioned on a 5★ rating as deceptive; one example is the US FTC 2024 rule on consumer reviews. The «مراجعة ضمن برنامج المكافآت» disclosure stays. The new texts need the owner's explicit approval.
2. **The single live product at the `cat_laser` root** qualifies as laser by its type. If it is an accessory, re-file it under `cat_laser_acc`; otherwise move it under `cat_laser_machines`.
3. **The HMAC upgrade.** An optional `GIFT_CODE_PEPPER` secret could be added later if the owner wants a keyed verifier.
4. **Reopening a cancelled order that held a gift** is refused (the gift was returned to the customer). Confirm.
5. **The review upload rate.** `review_upload` 40/h: a full review with 12 files is fine. Four reviews in an hour are not. Raise it if needed.
