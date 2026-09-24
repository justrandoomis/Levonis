# 03 — Requests · Offers · Escrow · Matching · Printers · Costing — audit

Repo: `/home/user/Levonis` @ `234f5e3` (read-only audit, 2026-09-24).
Scope: `worker/routes/{marketplace,printRequests,merchantPrinters,printQuote}.ts`, `worker/lib/{printMatching,escrowOps,printPricing,externalModels,communityGate,communityStates}.ts`, `worker/lib/printQuote/*`, migrations 0001/0015/0030/0031/0045/0056/0078/0097, `src/pages/Requests.tsx`, `src/components/print/*`, `src/components/merchant/dashboard/{PrintersTab,CostingTab,SalesTabs}.tsx`, `src/pages/ModelViewer.tsx`, `docs/{PRINT_REQUESTS,PRINT_QUOTE_ENGINE,COMMUNITY_V2}.md`.

**How findings were verified.** Every item marked **[verified]** in §10 was reproduced against the real route modules + real migrations (node:sqlite through the repo's own `tests/fixtures/app.ts` / `SqliteD1` harness) by scratch tests kept OUTSIDE the repo:

- `scratchpad/merchant-audit/verify/marketplaceBugs.test.ts` — tests A–K (11/11 pass = behaviour confirmed)
- `scratchpad/merchant-audit/verify/dupcol.test.ts` — costing printer build-volume loss

Re-run: `cd /home/user/Levonis && node --import tsx --test <scratch file>`. Items marked **[reading]** are from code inspection only (usually races that the single-process harness cannot interleave faithfully).

**Existing suites (all green):** escrow 21/21 · printMatching 24/24 · requestFiles 18/18 · communityGate 35/35 · communityStates 12/12 · adminCommunity 17/17 · merchantOps 16/16 · printQuoteRoutes 18 · printQuoteEngine 18 · printQuoteGrams 8 · printQuoteLinkAndPrinters 8 · printQuoteGeometry 14 · printQuoteSlicerAdapter 9 · printQuoteUi 5 · printPricing 25 · printRequestNotifyLanguage 8 · modelGeometry 25 · printAccessories 19 · printJobMinimum 8 · externalModelCover 7 · communitySchema 10 · store-isolation 6 · profilePrintersMoved 3 · toolsLinkAndPrinterClient 8. NB `tests/offerEligibility.test.ts` and `tests/offerLimits.test.ts` are about **product/bundle special offers** (`worker/lib/offers.ts`), not marketplace offers. There is **no route-level test** of `POST /offers/:id/accept` (beyond "is not 503" in communityGate.test.ts:728-742), confirm, dispute, admin resolve, or payouts — escrow is only tested at the `escrowOps` library level.

---

## 1. Data model

### 1.1 Requests and their print side

| Table | Where | Key columns / constraints | Notes |
|---|---|---|---|
| `community_requests` | `migrations/0001_init.sql:273-280`, extended `0031_community_v2_marketplace.sql:21-42`, idx `0056_ledger_keys.sql:75` | `id`, `customer_id → users ON DELETE CASCADE`, `title`, `description`, `status CHECK ('open','closed')` (coarse mirror), **`state TEXT NOT NULL DEFAULT 'open'` — no CHECK** (0031:21), `category`, `quantity`, `material`, `color`, `dimensions` (text), `budget_iqd`, `deadline` (free text ≤40), `governorate` (free text), `delivery_pref` (free text), `notes`, `visibility` (no CHECK; 'public' / 'private'), `offer_count` (denormalised counter), `accepted_offer_id`, `community_order_id` (no FKs), `expires_at`, `updated_at` | State machine only in code (`worker/lib/communityStates.ts:18-67`). `draft` exists in code but nothing creates a draft. `category` never set by the wizard. |
| `community_print_requests` | `0045_print_requests.sql:152-189` | PK `request_id → community_requests CASCADE`; `process CHECK ('fdm','resin')`; `material_id` (free text, not validated); `color_hex`, `color_name`; `quality CHECK (draft/standard/fine/ultra)`; `infill_percent`, `supports`, `colors_count`, `post_processing_minutes`; `primary_file_id → community_request_files ON DELETE SET NULL`; `source_kind CHECK ('upload','link')`, `source_provider`, `source_url` (≤600, **not URL-validated**), `source_meta` (sanitised JSON, printRequests.ts:89-104); `analysis`/`estimate` JSON snapshots; `estimate_low/high_iqd`, `estimate_confidence CHECK`; `completeness` | 1:1 side table (keeps `publicRequest()` whitelist narrow). **No revision/version**: re-publish overwrites it (see §10 K). |
| `community_request_files` | `0031:48-58`, + `model_format/analysis/analysed_at` `0045:195-197`, + `preview_key` `0045:249` | `request_id → CASCADE`, `file_key` (R2 key, never returned), `file_name`, `content_type`, `size_bytes`, `kind` ('reference'/'model'/'document') | Max 6 per request (`marketplace.ts:228`); 8 MB image / 40 MB model (`worker/lib/attachments.ts:41-42`). Byte-level classification: JPEG/PNG/GIF/WebP/PDF/STL/3MF/OBJ/AMF/GLB/glTF/STEP (`attachments.ts:90-147`). |
| `community_request_matches` | `0045:205-221`, idx merchant `0056:78` | `(request_id, merchant_id)` UNIQUE; `eligible`, `reject_reason`, `score`, `score_detail` JSON, `notified`, `notification_id` | Audit of every matching decision incl. rejections. Written only at publish. |
| `model_view_tokens` | `0045:231-242` | PK `token_hash` (SHA-256 of 32 random bytes), `file_id → files CASCADE`, `request_id`, `created_by`, `expires_at`, `revoked_at`, `uses`, `last_used_at` | `revoked_at` is **never written**; rows never pruned. |
| `user_notifications` | `0045:36-69` | per-language title/body (ar/en only; ckb rides in `meta`), `link`, `entity_type/id`, `event_key`; UNIQUE `(user_id, event_key) WHERE event_key<>''` | Generic in-app inbox; kinds typed in `worker/lib/notifications.ts:34-78`. |

### 1.2 Offers

| Table | Where | Key columns / constraints |
|---|---|---|
| `community_offers` | `0031:61-87` | `request_id → CASCADE`, `merchant_id → community_merchants CASCADE`, `store_id`, `price_iqd CHECK >0`, `completion_days CHECK >=0`, `delivery_method` (free text), `message`, `materials` (free text ≤500), `included` (≤500), `warranty_terms` (≤500), `state CHECK ('pending','accepted','rejected','withdrawn','expired','superseded')`, `expires_at` (free text, never enforced), timestamps. **Partial UNIQUE `idx_community_offers_one_live (request_id, merchant_id) WHERE state IN ('pending','accepted')`** (0031:85-87). No revision table; no link to the request spec version the offer priced. `expired`/`superseded` never written. |

### 1.3 Orders, escrow, money, disputes

| Table | Where | Key columns / constraints | Notes |
|---|---|---|---|
| `community_orders` | `0031:93-127` | `request_id`, **`offer_id` with `UNIQUE idx_community_orders_offer` (0031:124) — not partial**, `customer_id`, `merchant_id`, `store_id`, `state CHECK ('accepted','funded','in_progress','merchant_marked_delivered','customer_confirmed','completed','disputed','cancelled','refunded')`, snapshot `price_iqd`, `commission_percent_x100`, `platform_fee_iqd`, `merchant_receivable_iqd`, `CHECK (platform_fee_iqd + merchant_receivable_iqd = price_iqd)`, `completion_days`, `delivery_method`, `offer_snapshot` JSON, `chat_id` (never set), `delivered_at`, `confirmed_at`, `auto_complete_at` (+ partial idx 0031:126-127), `completed_at`, `cancelled_at` | No delivery-address snapshot, no customer contact, no request-spec snapshot. `customer_confirmed` state never written. |
| `community_order_items` | `0031:129-138` | line items | **Unused** (no writer). |
| `community_escrows` | `0031:144-166` | UNIQUE `community_order_id`; `gross_iqd>0`; fee/receivable identity CHECK; `released_iqd + refunded_iqd <= gross_iqd`; `state CHECK ('pending','held','released','partially_refunded','refunded','disputed','cancelled')`; `hold_id` (→ `wallet_holds`), `held_at/released_at/refunded_at/disputed_at` | Rows are inserted directly as `held` (`escrowOps.ts:276-279`); `pending`/`cancelled` unused. |
| `community_escrow_events` | `0031:170-182` | `kind CHECK ('created','held','release','refund','dispute_open','dispute_resolve','cancel')`, `amount_iqd`, `actor_id`, `actor_role`, `reason`, **`idempotency_key UNIQUE`** | Append-only by convention (no trigger). Written kinds: `held`, `release`, `refund`, `dispute_open`. The hold-time FX rate lives only in the `held` event's `reason` (`rate=…;cents=…`, `escrowOps.ts:136-144, 291`). |
| `merchant_payout_ledger` | `0031:187-204` | `kind CHECK (sale_credit, community_order_credit, refund_debit, commission, manual_adjustment, payout, reversal)`, signed `amount_iqd`, `state CHECK (pending, available, reserved, paid, reversed)`, `idempotency_key UNIQUE` | Balance = `SUM` by state (`escrowOps.ts:646-663`) — see bug D. Also written by store orders (`storeOrders.ts:510`) and state-updated at `merchant.ts:1358,1402`. |
| `wallet_holds` | `0015_wallet_holds.sql:70+` | `kind CHECK ('purchase','withdrawal')`, `amount_cents>0`, `state (active/committed/released)`, `event_key` unique per business event | Escrow reuses the checkout reservation book (availability check inside the INSERT). |
| `community_complaints` / `_messages` | `0031:256-294` | status workflow, `internal` notes | Created by dispute route; admin resolution of escrow does not touch complaint status. |
| `merchant_reputation_events` | `0031:238-253` | `kind`, `points` | Score derived; written on confirm (+10) and resolve (0/-20). |
| `chats` context columns | `0031:299-306` | `context_type/context_id/merchant_id/store_id/community_order_id` | **Never used** by the marketplace — no chat is opened on acceptance. |
| `orders.origin/community_order_id` | `0030_community_v2_core.sql:243-245` | — | Unused: custom requests never touch cart/orders (good). |
| settings seed | `0030:284-290` | `communityFeeRequestPercentX100=500`, `communityFeeStorePercentX100=500`, `communityFeeMinIqd=0`, `communityAutoCompleteDays=7`, `communityOfferMaxPerRequest=1`, `communityRequestExpiryDays=30` | `communityOfferMaxPerRequest` is never read. |

### 1.4 Merchant identity, capability, preferences

| Table | Where | Notes |
|---|---|---|
| `community_merchants` (ext.) | `0030:43-59` | `status` (active/restricted/suspended), `governorate`, `badge`, `rating_avg_x100`, `rating_count`, `completed_orders` (counter). |
| `merchant_stores` | `0030:66-104` | `accepts_custom_requests` (0030:92), `status CHECK (active,paused,suspended)`, `governorate`, `service_areas` JSON (unused by matching), `delivery_settings` JSON. |
| `merchant_notification_preferences` | `0030:142-154` | `request_opportunities` = master switch for match notifications. |
| `merchant_printers` | `0045:79-114` + economics `0078:124-137` | Physics typed by the merchant: `technology CHECK (fdm,resin)`, `build_x/y/z_mm`, `nozzle_mm`, `materials` JSON (ids, free text), `colors` JSON (≤9-char strings), `multicolor`, `enclosed`, `hardened_nozzle`, `quality_max CHECK`, `machine_hour_iqd`, `availability CHECK (available,busy,offline)`, `active`. 0078 adds `model_id → printer_models`, `purchase_iqd`, `purchase_date`, `residual_iqd`, `useful_print_hours`, `maintenance_iqd_per_hour`, `electricity_iqd_per_kwh`, `labor_iqd_per_hour`, `hours_printed`, `multi_material`, `toolhead_count` — **none of the 0078 columns has a writer anywhere** (only tests insert them by SQL). |
| `merchant_request_prefs` | `0045:122-144` | Empty arrays = no filter. `processes`, `materials`, `colors`, `capabilities`, `governorates` (free text), `delivery`, `min/max_job_iqd`, `min/max_size_mm`, `workload CHECK (light,normal,busy,full)`, `paused`, `paused_until`. |

### 1.5 Print-quote engine (merchant costing)

| Table | Where | Notes |
|---|---|---|
| `printer_models` | `0078:28-113`, seed `0078:444-478`, flow physics `0078:511-522` | 14 rows, **all Bambu Lab FDM**; economics NULL (admin-editable via `PATCH /api/admin/print-quote/printer-models/:id`, `printQuote.ts:1893`). |
| `print_materials` | `0078:148-171`, seed `0078:527-541` | 9 rows (PLA, PLA-CF, PETG, TPU, ABS, ASA, PC, PA-CF, PVA) — **no resin**; `default_iqd_per_kg` NULL; `product_id` never written. |
| `merchant_spools` | `0078:173-191` | Merchant acquisition cost per spool. **No route/UI writes it.** |
| `print_analyses` / `print_analysis_materials` | `0078:203-286` | Owner or guest (`guest_token_hash`, 48 h `expires_at`) — **expired guest rows/objects are never purged**. |
| `print_quotes` / `print_quote_cost_components` | `0078:296-355` | Frozen snapshot + engine version; `request_id` (0078:334) **never written**. |
| `print_actuals`, `print_failures`, `printer_calibration_stats` | `0078:364-428` | Calibration loop tables; **no writers**. |

**Two material catalogues.** Requests/matching/estimates use the `printMaterials` admin setting (`worker/lib/printPricing.ts:94-112`: 10 FDM + 8 resin, ids like `pa`, `petg-cf`, `resin-*`), while the quote engine uses the `print_materials` table (different id set, no resin). Printer vocabularies also differ: request quality has `ultra`, the quote engine only `draft/standard/fine` (`printQuote.ts:591,707`).

---

## 2. Request lifecycle + API surface

### 2.1 Lifecycle as actually implemented

```
Wizard step 1 end ──POST /api/marketplace/requests──▶ state=open, status=open, visibility=public   ← already on the public board & offerable
   upload files (POST /requests/:id/files), analyse each model (POST /print/requests/:id/files/:fid/analyze)
Wizard step 3 ──POST /print/requests/:id/publish──▶ writes spec/estimate side row, overwrites row fields, runs matching, notifies ≤25
First offer ──▶ receiving_offers
Accept ──▶ offer_selected (race guard) ──hold ok──▶ in_progress   (hold fails ──▶ back to receiving_offers)
Order: funded → in_progress (start) → merchant_marked_delivered → completed (confirm)        request: in_progress → completed
Dispute ──▶ order disputed, request disputed ──admin resolve──▶ order completed|refunded; request STAYS disputed (bug C)
Cancel order (funded only, customer/merchant) ──▶ order cancelled, request cancelled (terminal)
Customer cancel request ──▶ allowed from draft/open/receiving_offers/offer_selected/in_progress (communityStates.ts:37-43) (bug J)
Expiry: no sweep — expired requests just disappear from the board list (marketplace.ts:146) but stay 'open'
```

Transition table: `worker/lib/communityStates.ts:36-52` (request), `:113-128` (order), `orderIsActive` `:135-137`, `cancellationPolicy` `:152-169`. Routes largely write states with their own SQL instead of `canMove*` (e.g. funding-failure rollback `offer_selected→receiving_offers`, marketplace.ts:763-768, is not a declared transition). Request state `delivered` is never written (delivered route updates only the order, marketplace.ts:905-909).

### 2.2 Endpoints

Mounts: `worker/index.ts:343` (`/api/merchant` ← merchantPrinterRoutes), `:351` (`/api/marketplace/print` ← printRequestRoutes, mounted before) `:353` (`/api/marketplace` ← marketplaceRoutes), `:250` (`/api/print-quote`), `:290` (`/api/admin/community`), `:292` (`/api/admin/print-quote`). "Gate" = `requireCommunityOpen` (`communityGate.ts:233-237`; community is fail-closed with an admin/allow-list door, `:67-114`).

| Endpoint | Auth | Gate | Who / rule | file:line |
|---|---|---|---|---|
| `GET /api/marketplace/requests` | none | ✓ | public board: `state IN (open,receiving_offers) AND visibility='public' AND not expired`; filters `category`, `governorate` (UI uses neither), cursor | marketplace.ts:131-158 |
| `GET /api/marketplace/requests/:id` | optional | ✓ (even for the owner) | owner; anyone if public+open (expiry NOT checked); else merchant with `accepted` offer | :160-202 |
| `POST /requests/:id/files` | ✓ | ✗ | owner; only while open/receiving_offers/draft; ≤6; bytes classified | :242-329 |
| `GET /requests/:id/files/:fileId` | ✓ | **✗** | owner; **any signed-in user** while public+open (expiry ignored); engaged merchant; admin | :338-384 |
| `DELETE /requests/:id/files/:fileId` | ✓ | ✗ | owner, open window | :386-410 |
| `POST /requests` | ✓ | ✓ | creates `open`/public immediately; rate 10/h | :412-452 |
| `GET /my-requests` | ✓ | ✗ | owner, `publicRequest` shape | :463-472 |
| `POST /requests/:id/cancel` | ✓ | ✗ | owner; `canMoveRequest(from,'cancelled')`; rejects pending offers | :475-503 |
| `GET /requests/:id/offers` | ✓ | ✗ | customer sees all; merchant only own (`? = 1 OR o.merchant_id = ?`) | :508-535 |
| `POST /requests/:id/offers` | ✓ | ✓ | `requireSellingPrivileges` + `communityOffers` benefit; request open; not own | :537-616 |
| `POST /offers/:id/withdraw` | ✓ | ✗ | merchant, `state='pending'` | :619-630 |
| `PATCH /offers/:id` | ✓ | ✓ | merchant, `state='pending'`; **not audited**; no UI caller | :633-662 |
| `POST /offers/:id/accept` | ✓ | ✗ (by design) | customer of the request | :680-804 |
| `GET /orders`, `GET /orders/:id` | ✓ | ✗ | either party (`loadOrderForParty` :809-829) | :1094-1109, :831-867 |
| `POST /orders/:id/start` | ✓ | ✗ | merchant, `funded→in_progress` (no audit) | :870-881 |
| `POST /orders/:id/delivered` | ✓ | ✗ | merchant, sets `auto_complete_at` | :891-913 |
| `POST /orders/:id/confirm` | ✓ | ✗ | customer → `releaseEscrow` | :918-965 |
| `POST /orders/:id/dispute` | ✓ | ✗ | either party while active; complaint + freeze + Telegram «Report» | :971-1043 |
| `POST /orders/:id/cancel` | ✓ | ✗ | per `cancellationPolicy` (funded: either party) → full refund | :1051-1091 |
| `GET/POST /complaints[/:id[/messages]]` | ✓ | ✗ | reporter only | :1194-1317 |
| `GET /api/marketplace/print/catalog` | none | ✗ | materials (public projection), qualities, capabilities, formats, accessories | printRequests.ts:174-205 |
| `POST /print/requests/:id/files/:fileId/analyze` | ✓ | ✗ | owner; server-side `analyseModel`, caches LVM1 preview in R2 | :218-279 |
| `POST /print/link` | ✓ | ✗ | parse + optional provider JSON API (no HTML) | :290-299 |
| `POST /print/quote` | ✓ | ✗ | Levonis estimate (cost lines stripped) | :364-411 |
| `POST /print/requests/:id/publish` | ✓ | ✓ | owner; state open/receiving_offers/draft; **re-callable** | :653-944 |
| `GET /print/requests/:id` | optional | gate-aware | owner; anyone if public+open & may enter; engaged merchant | :1083-1170 |
| `POST /print/requests/:id/files/:fileId/viewer-token` | ✓ | **✗** | owner / **any signed-in user** if public+open / engaged merchant; hours 1-168 | :1180-1222 |
| `GET /print/viewer/:token`, `/mesh` | none | ✗ | token valid & not expired (`revoked_at` never set) | :1225-1282 |
| `POST /print/requests/:id/repeat` | ✓ | ✓ | copies request+files+spec into a new **open, public, unpublished** request | :1294-1428 |
| `GET /print/my-requests` | ✓ | ✗ | owner-scoped rich list | :1449-1526 |
| `GET|POST|PUT|DELETE /api/merchant/printers[/:id]` | ✓ | ✗ | `requireStoreOwner` | merchantPrinters.ts:87-205 |
| `GET|PUT /api/merchant/request-prefs` | ✓ | ✗ | `requireStoreOwner` | :225-317 |
| `GET /api/merchant/request-matches` | ✓ | ✗ | own decisions only | :326-352 |
| `/api/print-quote/*` (printers, accessories, materials, uploads, analyses/:id[/measure|/lookup|/file|/quote|/compare], grams-quote, link) | mostly optional (guest allowed) | ✗ | owner / guest token / admin; `/compare` merchant-only | printQuote.ts:319-1505 |
| `/api/admin/community/*` (requests, offers/:id/reject, escrows/:id/resolve, merchants/:id/finance|payout, complaints…) | admin, apex only | n/a | | adminCommunity.ts:44, 491-652, 997-1099 |

### 2.3 What a merchant (or anyone) can see of a customer's request

- Board/detail whitelist `publicRequest()` (`marketplace.ts:70-91`): id, title, description, category, quantity, material, color, dimensions, budget, deadline, governorate, delivery_pref, state, offer_count, created_at, expires_at, **customer_name (= `users.name`, the full display name)**, file_count. Excluded: customer_id, notes, visibility, email, phone, address. Good.
- File list for anyone who may see the request: id, file_name, content_type, size, kind, inline, route URL (never the key) (`:185-199`).
- Print facts (`printRequests.ts:1126-1169`): process, material_id, colour, quality, infill, supports, colours, post-processing, primary_file_id, `source_url`/`source_meta`, full `analysis` JSON, estimate minus cost lines, completeness, required capabilities.
- **After acceptance nothing more is revealed**: `GET /orders/:id` returns the order row + `customer_name` (`:809-841`); no address, phone, or chat is created (chats context columns unused). The docs' "a merchant learns how to reach the customer when their offer is accepted" (COMMUNITY_V2 §2, marketplace.ts:12-16) is not implemented.

### 2.4 File access rules and tokens

| Who | Original file (`GET /requests/:id/files/:fid`) | Viewer token mint | Print facts |
|---|---|---|---|
| Customer | always | ✓ | ✓ |
| Any signed-in user (merchant or not, eligible or not) | while `visibility='public' AND state IN (open,receiving_offers)` — expiry ignored, **community gate ignored** | same | only when community gate lets them in |
| Merchant with accepted offer | while order lives (no end) | ✓ | ✓ |
| Admin | always | via the rules above | via rules above |
| Anonymous | ✗ (requireAuth) | ✗ | if gate open and public+open |

Response hardening for originals: `Content-Disposition: attachment` for non-images, `nosniff`, `CSP default-src 'none'; sandbox`, `private, max-age=300` (`marketplace.ts:374-383`). Keys under `requests/<userId>/…` (`:231`), private bucket.

Viewer tokens: 32 random bytes, SHA-256 stored, TTL 1-168 h (default 72) (`printRequests.ts:1211-1219`); validity check = exists ∧ not revoked ∧ not expired (`:1270-1282`) — **no re-check of request state or of the minter's current right**, no revoke path, metadata returns the original `file_name` (`:1235`, shown at `src/pages/ModelViewer.tsx:813-814`). The preview mesh is decimated only above 250 k triangles (`worker/lib/modelGeometry.ts:1006, 1026`), i.e. for typical models it is the full float32 geometry.

---

## 3. Offers

**Model**: one row per merchant bid; one live (pending/accepted) per merchant per request enforced by the partial unique index (0031:85-87). Create (`marketplace.ts:537-616`): requires selling privileges (store not paused/suspended, merchant not *suspended* — `restricted` passes, `merchantAuth.ts:185-206`) and the `communityOffers` plan benefit (`:541-542`); request must be open (`:549-551`, expiry not checked); no capability/eligibility check, no `accepts_custom_requests` check, no visibility check. Batch = INSERT + `offer_count+1` + `open→receiving_offers` (`:560-585`); customer notified in-app + outbound channels (`notifyOfferReceived`, `worker/lib/engagementNotify.ts`). Edit only while pending (`:655-657`), not audited, no revision history. Withdraw (`:619-630`) does not decrement `offer_count`.

UI (`src/pages/Requests.tsx`): `OfferForm` sends only price, completion days, message, warranty (`:669, 677-682`); `delivery_method`, `materials`, `included` are supported by the API but never collected or displayed (`OfferCard` `:571-657`). No edit/withdraw UI. Merchants see only their own offer; competitors' prices are filtered in SQL (`:528-531`).

**Acceptance flow** (`marketplace.ts:680-804`):
1. Read offer+request (`:685-692`); require caller = customer, offer `pending` (read-time check only).
2. **Race guard** (`:695-701`):
   ```sql
   UPDATE community_requests
      SET state = 'offer_selected', status = 'closed', accepted_offer_id = ?, updated_at = ?
    WHERE id = ? AND customer_id = ? AND state IN ('open','receiving_offers')
   ```
   0 rows → 409 "already has an accepted offer".
3. Separate batch (`:708-742`): offer → `accepted` (**`WHERE id = ?` only — no `state='pending'` guard**), rivals pending → rejected, INSERT `community_orders` (snapshot incl. fee split from `feeFor`), `community_requests.community_order_id`.
4. `holdEscrow` (`:746-754`, key `accept:<orderId>`).
5. On failure: order → cancelled, request → receiving_offers, offer and same-instant-rejected rivals → pending (`:760-775`, keyed on identical `updated_at`) — but the cancelled order keeps `offer_id`, so **the same offer can never be accepted again** (bug A).
6. On success: order `funded`, request `in_progress` (`:787-793`), audit.

Backstops: `UNIQUE(community_orders.offer_id)` (0031:124), `UNIQUE(community_escrows.community_order_id)`, escrow idempotency keys. Weak points: the race guard and the order/escrow writes are three separate commits (a crash between them strands `offer_selected`/`accepted` rows with no sweeper); no expected-price/offer-version check (bug B); the offer UPDATE is unguarded against a concurrent withdraw.

---

## 4. Escrow

**State machines** (three parallel ones, kept in step by route code):

- Escrow (`worker/lib/escrowOps.ts:51-58`): `held → released | refunded | partially_refunded | disputed`; `disputed → released | refunded | partially_refunded`. `pending`, `cancelled` unused.
- Order (`communityStates.ts:113-128`): `accepted → funded → in_progress → merchant_marked_delivered → completed`; `disputed → completed|refunded|cancelled`. `merchant_marked_delivered → in_progress` is declared but has **no route**; `customer_confirmed` is never written.
- Request mirrors the order loosely (in_progress/completed/cancelled/disputed); never `delivered`; stays `disputed` after admin resolution.

**Money movements** (all IQD integers in escrow/ledger; wallet in USD cents with dinar remainder columns, 0108):

| Operation | Wallet side | Merchant ledger | Escrow row / event | file:line |
|---|---|---|---|---|
| Hold (accept) | `wallet_holds` purchase hold, availability checked inside INSERT; affordability asked in dinars (`walletIqdAvailable`), cents floored/capped (`walletSpendCents`) | — | INSERT state `held`; event `held` with `rate=;cents=` | escrowOps.ts:195-295 |
| Release (customer confirm / admin) | hold committed + customer debit posted (`commitHoldStatements`) | `community_order_credit` +receivable `available`; `commission` −fee `paid` — both `INSERT … SELECT … WHERE FUNDED_BY_HOLD` | `released`, `released_iqd=gross`; event `release` | :312-315, :359-439 |
| Full refund (cancel / admin) | hold released | — | `refunded`; event `refund` | :467-514 |
| Partial refund (admin) | hold committed + debit; refunded part credited back as approved `deposit` (floored at hold rate, ≤ hold cents) | `community_order_credit` of `min(receivable, gross − refund)`; **no commission row**; `released_iqd` not updated | `partially_refunded`, `refunded_iqd += amount`; event `refund` | :515-603 |
| Dispute | — | — | `held → disputed`, event `dispute_open` | :614-643 |
| Payout (admin) | — | `payout` −amount **state `paid`** | — | adminCommunity.ts:1073-1099 |

Guards: every settlement is ONE `db.batch` with a conditional escrow flip + hold fence + `FUNDED_BY_HOLD` predicate on credits; idempotency keys (`confirm:<order>`, `cancel:<order>`, `dispute:<order>`, `admin:<decision>:<escrow>`); DB CHECKs for the money identities (0031:120, 162-163).

**Disputes**: `POST /orders/:id/dispute` inserts a complaint, sets order+request `disputed` (unconditional UPDATEs, `marketplace.ts:987-1004`), calls `disputeEscrow` (result ignored, `:1006-1014`), announces to the admin Telegram «Report» topic (`:1034-1041`). Only the customer UI has a dispute button (`Requests.tsx:942-964`); merchant UI has none (`SalesTabs.tsx:316-431`).

**Admin settlement**: `POST /api/admin/community/escrows/:id/resolve` (`adminCommunity.ts:997-1051`) — decision `release|refund|partial_refund` + reason ≥3 chars; does not require `disputed` (any `held` escrow can be settled); after the money op it unconditionally sets the order `completed|refunded` and appends a reputation event (`:1024-1043`) even on idempotent replay; request state and complaint status untouched; parties not notified.

**Audit trail**: `audit()` rows for request create/cancel, offer create/withdraw/accept, delivered, completed, disputed, cancelled, admin actions (`marketplace.ts:449,501,592,628,795,911,963,1016,1089`; `adminCommunity.ts:502,650,1045,1097`); missing for offer PATCH (`:633-662`), order start (`:870-881`), file upload/delete, viewer-token minting (row only). Escrow events + ledger rows are append-only by convention (no DB triggers).

**Auto-completion**: `communityAutoCompleteDays` (default 7) sets `auto_complete_at` (`marketplace.ts:899-909`) and the UI promises "Auto-confirms on …" to both parties (`Requests.tsx:912-916`, `SalesTabs.tsx:428-429`), but **no job reads `auto_complete_at`** (grep of `worker/` finds only the writer and a SELECT). Money waits for the customer indefinitely.

---

## 5. Matching — exactly how it works today

Trigger: only inside `POST /print/requests/:id/publish` (`printRequests.ts:817-922`). Never on printer/pref changes, never on request edits other than a re-publish, never for `/repeat` copies or for requests created without the wizard.

**Inputs** (`MatchRequest`, `printMatching.ts:58-72`): process, material_id, color_hex, quality, colors_count, measured `dimensions_mm` (**`{0,0,0}` when not measured** — link/description/image requests, `printRequests.ts:825`), governorate & delivery_pref (re-read from the row), Levonis estimate (`estimate_iqd`), quantity (unused by the matcher).
**Candidates** (`loadCandidates`, `printRequests.ts:976-1071`): all `community_merchants.status='active'` + LEFT JOIN store + notification prefs; ALL active printers; ALL prefs — loaded into memory on every publish. `response_minutes: null`, `trouble_rate: 0`, `pro: false` hard-coded (`:1067-1069`) → the response-time, reliability and PRO signals are constant for everyone. No membership/plan check → merchants whose PLUS lapsed are notified but then 403 on offering.

**Pipeline per merchant** (`decide`, `printMatching.ts:271-405`), order = policy:
1. Trade gates: merchant active; store status active (a missing store passes because `store_status` is `''`, `:290`); `accepts_custom_requests`.
2. Wants to hear: `request_opportunities`; `paused` (with optional `paused_until` auto-expiry) (`:296-300`).
3. **Physics** — any printer that fits (`printerFits`, `:218-245`): active & not offline; `technology === process`; material: `printer.materials` **empty ⇒ any material allowed**, else must include `material_id`; catalogue flags `needs_enclosure ⇒ enclosed`, `abrasive ⇒ hardened_nozzle`; **build volume with all six axis permutations** (`fitsInBuild`, `:248-260`; skipped if printer dims 0; trivially passes when request dims are unknown); `quality_max ≥ quality`; `colors_count>1 ⇒ multicolor`. `printer.colors`, nozzle size, max simultaneous materials, stock — **not checked**. Best printer: available first, then cheapest `machine_hour_iqd`.
4. **Preferences only narrow** (`:326-354`): processes, materials, governorates (only if request has one), delivery (only if request has one), min/max size vs longest edge (unknown dims = 0 ⇒ fails any `min_size_mm>0`), min/max job value vs Levonis estimate (skipped if unpriced), capabilities (job-derived `requiredCapabilities` `:202-214` must all be in the list if the list is non-empty), colours (only if listed and job names a hex).
5. Score (`:357-394`) with admin-tunable weights (`DEFAULT_MATCH_WEIGHTS` `:178-194`): capability fit 25, location 18 (exact governorate string equality ⇒ 1 else 0.35), availability 14 (workload), rating 12, completed jobs 8, response time 8 (constant 0.6), reliability 8 (constant 1), price suitability 4, preference match 3, PRO 3 (constant 0).

**Default = everything the workshop can do: yes** (empty prefs = no filter, `0045:124-125`, `merchantPrinters.ts:230-232`, test `printMatching.test.ts:287`). **Preferences can never widen capability: yes by construction**, but capability itself is self-declared free text (any build volume ≤5000 mm, any material ids, empty material list = all), so "actual printer capabilities" is not guaranteed. **Location/delivery is not a hard constraint** unless the merchant configured governorate/delivery filters: a pickup-only request in Basra still notifies Erbil shops (only a lower location score). No stock (spools/colours) dimension exists in matching at all.

**Notifications to matched merchants** (`printRequests.ts:842-922`): top `printMatchNotifyLimit` (default 25) eligible by score get ONE in-app `user_notifications` row each (`kind print_request_match`, link `/requests?request=<id>`, trilingual body composed from structured fields `printMatchNotification` `:555-640`, ckb in `meta`), deduped by `event_key print_request_match:<request>`. No push/Telegram/WhatsApp/email for merchants. Every decision (incl. rejections, reason, score detail) upserted into `community_request_matches`; merchants read their own via `GET /api/merchant/request-matches` (panel in PrintersTab, no link to the request). On re-publish, already-notified merchants are not re-notified, but their match row gets a `notification_id` of a notification that was never inserted (`:866-918`).

---

## 6. Merchant printers + request preferences (model and UI)

**Server** — `worker/routes/merchantPrinters.ts`: router guarded by `requireAuth` (`:35`) + `requireStoreOwner` per handler. `readPrinter` (`:108-145`) validates enums, requires build volume >0 (`:120-122`), accepts materials as up to 40 free strings (`:131`), colours as ≤9-char strings (no hex validation, `:132`), optional `machine_hour_iqd`. PUT/DELETE scoped `WHERE id=? AND merchant_id=?`. Prefs PUT (`:267-317`) filters processes/capabilities/delivery to vocabularies, governorates free text (`:277`), `paused_until` any `Date.parse`-able string. No link to `printer_models` (`model_id` never written), no economics fields, no stock.

**UI** — `src/components/merchant/dashboard/PrintersTab.tsx` (mounted `src/pages/MerchantDashboardPage.tsx:230`):
- `PrintersSection` (`:433`) + `PrinterForm` (`:712`): name, technology, brand/model text, build XYZ, nozzle, materials chips from the `printMaterials` catalogue, colours, multicolour/enclosed/hardened toggles, max quality, machine-hour cost, availability; warns about materials the hardware toggles make impossible (`:736-744`). No canonical-model picker (build volume typed by hand).
- `RequestPrefsSection` (`:1037`): clear "empty = everything your printers can do" copy (`:1122-1126`), governorates chips from the 18-id list, workload, pause/pause-until, min/max value & size.
- `MatchesPanel` (`:1394`): "why didn't I get this request?" list with reason text (`reasonText` `:191`), not linked to requests.

---

## 7. Merchant print costing — what exists

Engine: `worker/lib/printQuote/{model,cost,printers,geometryAdapter,slicerAdapter,repository}.ts` (2,638 lines) + routes `worker/routes/printQuote.ts` + docs `docs/PRINT_QUOTE_ENGINE.md`.

- **Flow used by the Costing tab** (`src/components/merchant/dashboard/CostingTab.tsx`, mounted `MerchantDashboardPage.tsx:231`): upload model → `POST /api/print-quote/uploads` (private R2, `print_analyses` row) → `POST /analyses/:id/measure` against a chosen canonical printer + material (server-side `analyseModel` + `analysisFromGeometry`, provenance `platform`, range) → `POST /analyses/:id/compare` (`printQuote.ts:1416-1505`) prices the analysis on **every merchant printer**, returning per printer: eligibility + reasons, `merchantQuote` (`:1675-1693`: component lines with provenance, base cost, failure reserve, true cost, suggested price, profit, margin, markup, break-even, range, waste g/%, machine hours) and a "because" block.
- Cost model: 16 components incl. material/support/purge/brim, electricity, depreciation, maintenance, labour, post-processing, packaging, overhead, platform fee, failure reserve as expected retries (`1/p − 1` × fraction); margin as share of price; floor from `printPricingConfig.min_job_iqd` (0 by owner ruling, migration 0097). Quotes are frozen (`print_quotes` + components + snapshot + engine version). Public vs merchant payloads are two functions (`publicQuote` `:1662-1672`).
- Also: grams-only quote (`:1199-1247`), link quote (`:1346-1404`), admin printer-model economics editor (`src/components/adminCommunity/PrinterModelsEditor.tsx`).

**What does not work / is missing:**
- **All real merchant printers are unpriceable** — they are created without `model_id` (no writer), so `loadMerchantPrinters` takes the legacy path, where `SELECT p.*, …, m.build_x_mm, m.build_y_mm, m.build_z_mm …` (`printQuote/repository.ts:160-173`) overwrites the merchant's typed build volume with the LEFT JOIN's NULLs → `buildMm {0,0,0}` → `printerEligibility` returns `build_volume` for a 20 mm cube (**[verified]** `verify/dupcol.test.ts`). The route test passes only because it inserts a linked printer by SQL (`tests/printQuoteRoutes.test.ts:692-705`).
- Reason codes don't match the UI labels (server `build_volume`, `material:X`, `materials_at_once`, `enclosure`, `hardened_nozzle`, `nozzle` — `printers.ts:292-307`; UI keys `TOO_LARGE…NOZZLE_NOT_AVAILABLE` — `CostingTab.tsx:106-113`), so raw codes are shown (`:403`).
- Merchant economics have no input path: `merchant_spools`, printer purchase/electricity/labour/maintenance overrides — nothing writes them; the "spool" rung is unreachable, so "your cost" is Levonis' retail filament price / platform defaults labelled as such.
- Not connected to requests: a merchant cannot cost a customer's request file directly (`readableAnalysis` owner/guest/admin only, `printQuote.ts:512-529`; `print_quotes.request_id` never written); they must download the customer's original and re-upload (creating a permanent private copy, signed-in retention = forever).
- No resin: `print_materials` has no resin rows and `printer_models` only FDM; quality `ultra` absent.
- `/analyses/:id/quote` for a merchant ignores their machines (`merchantPrinter: null`, `:922`).
- Calibration loop (`print_actuals`/`print_failures`/`printer_calibration_stats`) has no writers.
- Separately, the **customer-facing request estimate** uses a different engine (`worker/lib/printPricing.ts`) whose support estimate still counts bed-contact area as overhang (`printPricing.ts:383`, documented in PRINT_QUOTE_ENGINE.md §5.2).

---

## 8. Strengths to KEEP

1. **One request, side tables, no copies** — print spec/matches/tokens hang off `community_requests` by id; matching returns decisions only (`printMatching.ts:9-12`, test `printMatching.test.ts:143`).
2. **Matching core** — pure, testable `decide()` with physics-before-preference ordering, six-orientation fit, enclosure/abrasive gates, narrow-only prefs with empty = everything, pause-until, PRO bonus applied after eligibility and capped at the smallest weight, admin-tunable weights, and **every decision persisted with a machine-readable reason** + merchant-facing "why not" panel.
3. **Race-safe single acceptance** — conditional `UPDATE … WHERE state IN ('open','receiving_offers')` + `UNIQUE(community_orders.offer_id)` + partial unique live-offer index; order snapshot of the offer; commission snapshot per order.
4. **Escrow engine** — reuse of `wallet_holds` (availability check inside the INSERT), dinar-first affordability, single-batch settlements with conditional flips + hold fences + `FUNDED_BY_HOLD` predicate, UNIQUE idempotency keys, integer IQD, DB CHECK identities (fee+receivable=gross, released+refunded≤gross), append-only events, balance-as-SUM, partial refund as two visible movements. 21 attack-style tests.
5. **Privacy primitives** — `publicRequest()` whitelist in the SELECT; competitors' prices filtered in SQL; R2 keys never leave the server; private prefix; byte-level attachment classification; `nosniff` + sandbox CSP; derived-mesh viewer with hashed, expiring tokens.
6. **Server-side measurement** (`analyseModel`) — the customer cannot doctor geometry; stored analysis is re-read at publish.
7. **External links** — no HTML scraping, `validateOutboundUrl` on every hop with manual redirects, cover image as https link only (`externalModels.ts:81-200`, `printRequests.ts:89-104`).
8. **Notification plumbing** — `user_notifications` with event-key dedupe; trilingual, structured, script-aware composer for match messages; customer offer-received notifications through outbound channels.
9. **Community gate** — server-side, fail-closed, allow-list by immutable user id, explicit exceptions for in-flight trade.
10. **Quote engine design** — provenance ladder, public vs merchant payloads by construction, margin-as-share, failure reserve as expected retries, component rows, frozen snapshots, printer comparison with reasons instead of a black-box score.
11. **Wizard UX direction** — progressive (file/link → spec with collapsed advanced options → price/publish), measurement runs while the user fills step 2, live debounced estimate, completeness meter that never gates.

---

## 9. Gaps vs the target — concrete

**Customer wizard**
- G1. Sources: only "upload" or "link" (`PrintRequestWizard.tsx:839`, gate `:482-486`); no description-only path; reference images only as a generic upload; no manual dimensions; no customer "notes" field (the `notes` column is used to stash the link, `:511`).
- G2. Process is derived from the material, and a material (first FDM, i.e. PLA) is auto-selected (`:403-404`) — no "Not sure" for FDM/resin/material; a customer who doesn't care is matched only to PLA-capable FDM shops.
- G3. No draft/published separation: the row is created `open`+`public` at the end of step 1 (`:501-512` → `marketplace.ts:423-447`) and is immediately on the board and offerable; abandoned wizards leave live posts; `/repeat` creates live posts that are never matched (bug E).
- G4. Spec can change after offers exist (re-publish, file add/remove during `receiving_offers`) with no revision, no offer invalidation, no merchant notice (bug K).
- G5. Request/offer expiry and deadline are not enforced (bug I); no expiry sweep; `deadline` is free text.

**Board & merchant browsing**
- G6. Board lists every public open request to everyone; no "matched/eligible for me" view, no filters in UI (server supports category/governorate), no pagination in UI (`Requests.tsx:318-325` ignores `next_cursor`), no thumbnails.
- G7. Offer permission is plan-based, not eligibility-based: any PLUS merchant can bid on anything (no capability, `accepts_custom_requests`, visibility or expiry check).
- G8. External link, cover image and provider of link-sourced requests are never shown to merchants (no UI renders `source_url`/`source_meta`) — a link-only request reaches merchants as title+description only.
- G9. File permission is "any signed-in account" for originals; target needs per-permission rules (eligible merchants see previews; original download gated, e.g. after acceptance or customer opt-in); token preview is lossless under 250 k triangles; tokens not revocable nor tied to request state.
- G10. Customer's full name (`users.name`) is on the public board; consider alias/first name.

**Matching**
- G11. No material-stock/colour-stock dimension (spools unused; `printer.colors` unused).
- G12. Printer capability is self-declared, not tied to canonical `printer_models`; empty material list = all materials.
- G13. Location/delivery reach is a preference filter only, not a capability (no service areas/shipping reach; `merchant_stores.service_areas` unused).
- G14. Matching runs once at publish; no re-match on new printers/prefs/stock, no re-notification, dead signals (response time, reliability, PRO), whole-table load per publish; merchants' plan not checked; merchant notifications in-app only.

**Offers**
- G15. UI collects 4 of the 7 target fields (no delivery method, materials, inclusions); no edit/withdraw UI; no offer revisions or validity; no expected-price check at accept (bug B); merchants not notified on accept/reject/cancel (`'offer_accepted'` declared at `notifications.ts:37`, never sent).

**Escrow / orders**
- G16. No contact reveal / chat / delivery-address snapshot on acceptance — the merchant has no in-app way to deliver.
- G17. Auto-complete promised in UI but not implemented; no `delivered → in_progress` route; merchant cannot dispute from UI; no notifications for start/delivered/confirm/dispute/resolution to the counter-party.
- G18. Admin resolution doesn't require a dispute, doesn't close the request or complaint, doesn't notify, double-writes reputation on replay (bug C).
- G19. Partial refund commission is implicit (no `commission` row, `released_iqd` not set), so platform revenue and merchant earnings are not reconstructible from the ledger alone.
- G20. Funding is wallet-only (customer must top up first); no crash-recovery sweep for `offer_selected`/`accepted` stragglers or orphan holds.
- G21. Payout ledger semantics broken (bug D).

**Costing**
- G22. Costing is not wired to requests (can't open a request's file, can't prefill an offer), merchant economics/spools have no UI, resin unsupported, and currently all merchant-created printers fail the fit check (bug L).

---

## 10. Bugs / security issues found

Severity is for a marketplace holding customer money and IP. "Scratch test" letters refer to `scratchpad/merchant-audit/verify/marketplaceBugs.test.ts`.

| # | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| A | **High** | **Retrying acceptance after a funding failure strands the request.** On INSUFFICIENT_FUNDS the route cancels the order but the row keeps `offer_id`; `idx_community_orders_offer` is a full UNIQUE, so the customer's retry (after topping up — the normal path) wins the request race guard, then the order INSERT throws `UNIQUE constraint failed: community_orders.offer_id` → 500, request left `offer_selected` with `accepted_offer_id` set and no order; every other offer then gets 409. | marketplace.ts:695-701, 717-721, 760-775; 0031:124 | **[verified]** test A: 1st accept 400, 2nd accept 500, request `offer_selected`, `community_order_id NULL`, other offer 409 |
| B | **High** | **Price can change between the customer's confirm and the hold.** `PATCH /offers/:id` lets the merchant edit price while pending (unaudited), and `accept` takes no expected price/version; the UI confirm dialog shows the stale price (`Requests.tsx:434-440`) while the server holds the new one. | marketplace.ts:633-662, 685-703, 746-754 | **[verified]** test B: PATCH 50,000→95,000, accept → order 95,000 |
| D | **High** | **Merchant payouts never reduce "available", so the same balance can be paid out repeatedly.** Payout rows are `state='paid'` (negative), `merchantBalance.available_iqd` sums only `state='available'`, and the payout guard compares against it (read-then-insert). Admin UI shows "Available" unchanged and "Paid out" inflated by commission rows. Affects store sales too (same ledger). | adminCommunity.ts:1081-1092; escrowOps.ts:646-663; AdminCommunity.tsx:374-431 | **[verified]** test D: earned 47,500; two payouts of 47,500 both succeed; available stays 47,500 |
| E | **High** (product) | **Unpublished requests are live.** Wizard step 1 creates `open/public`; board lists it; merchants can offer; no matching or estimate until publish (and `/repeat` copies are never published). Docs claim publish is "the last moment before any merchant sees the request" (PRINT_REQUESTS.md:270-271). | PrintRequestWizard.tsx:501-512; marketplace.ts:423-447, 137-151; printRequests.ts:1313-1328 | **[verified]** test E |
| L | **High** (feature) | **Costing tab rejects every UI-created printer as `build_volume`.** Duplicate column names in `SELECT p.*, …, m.build_x_mm…` let the LEFT JOIN's NULLs overwrite the merchant's values on unlinked printers (all of them — `model_id` has no writer). Same name-keyed row semantics as D1 `.all()`. | printQuote/repository.ts:160-173, 214-231; printers.ts:286-293 | **[verified]** dupcol test: `buildMm {0,0,0}`, 20 mm cube ineligible |
| C | Med | **Admin escrow resolution is not idempotent in its side effects and leaves the request `disputed`.** Replay returns `replayed:true` but still inserts another reputation event (−20) and rewrites the order; request state never updated; complaint not touched; any `held` (non-disputed) escrow can be settled. | adminCommunity.ts:997-1051 | **[verified]** test C: 2 `dispute_lost` events, request `disputed`, order `refunded` |
| F | Med | **Viewer tokens: minted by any signed-in account, outlive request closure (≤168 h), no revocation, leak original file name; preview is lossless below 250 k triangles.** No community-gate check on minting. | printRequests.ts:1180-1222, 1225-1243, 1270-1282; modelGeometry.ts:1006,1026; ModelViewer.tsx:813-814 | **[verified]** test F: plain customer mints; after cancel anonymous `GET /viewer/:token` → 200 with `name` |
| G | Med | **Original model files downloadable by any signed-in account (not only merchants), and the download route bypasses the maintenance gate** (board 503, file 200). Expiry also ignored. | marketplace.ts:338-384 (no `requireCommunityOpen`, `openToOffers` ignores `expires_at`) | **[verified]** test G |
| J | Med | **Customer can cancel the request while its funded order is running** (`in_progress → cancelled` is a declared request transition); order/escrow keep running → request `cancelled`, order `in_progress`, escrow `held`. | communityStates.ts:43; marketplace.ts:475-503 | **[verified]** test J |
| K | Med | **Re-publish rewrites the job under standing offers** (process/material/quality/quantity/dimensions/governorate) with no revision, no offer invalidation, no merchant notice; files can also be added/removed during `receiving_offers`. | printRequests.ts:658-660, 757-815; marketplace.ts:251-253, 394-396 | **[verified]** test K: PLA×1 → resin×50 ultra, 2 offers still pending |
| I | Med | **Expiry is cosmetic**: expired requests vanish from the board but still accept offers and acceptance; offer `expires_at` never enforced. | marketplace.ts:146 vs 549-551, 692 | **[verified]** test I |
| M | Med | **Auto-complete promised but not implemented** — `auto_complete_at` is written and displayed to both parties, but no job reads it. | marketplace.ts:899-909; Requests.tsx:912-916; SalesTabs.tsx:428-429; no reader in `worker/` | [reading, grep-confirmed] |
| N | Med | **Merchant is never told their offer was accepted** (and no party is told about start/delivered/confirm/cancel/resolution). `'offer_accepted'` is declared but has no sender. | notifications.ts:37; marketplace.ts:680-1091 (only `notifyOfferReceived` at :608-613) | [reading, grep-confirmed] |
| H | Low | Withdraw doesn't decrement `offer_count`; re-offer inflates it (board shows phantom offers). | marketplace.ts:619-630 vs 578-584 | **[verified]** test H: 2 live, count 3 |
| O | Low | Accept marks the offer `accepted` without `AND state='pending'` → a concurrent withdraw is silently overridden (or, if the merchant re-offered, the live-offer unique index aborts the batch → same stranding as A). | marketplace.ts:692, 710-711 | [reading] |
| P | Low | Offer INSERT is not guarded against the request leaving `open` between check and batch → orphan pending offers on a closed request. | marketplace.ts:549-585 | [reading] |
| Q | Low | Concurrent double-confirm: `releaseEscrow` replays `ok`, and the route's reputation insert + `completed_orders+1` are not conditional on the order transition → double count. | marketplace.ts:918-965; escrowOps.ts:360-365, 328 | [reading, race] |
| R | Low | Dispute route writes `disputed` unconditionally and ignores `disputeEscrow`'s result → a dispute racing a confirm can leave order `disputed` over a `released` escrow. | marketplace.ts:979-1014 | [reading, race] |
| S | Low | Admin `requests/:id/remove` allows `offer_selected`/`disputed` (money in flight) and doesn't reject pending offers. | adminCommunity.ts:495-498 | [reading] |
| T | Low | Partial refund writes no `commission` row and leaves `released_iqd=0` → platform take implicit, escrow row doesn't show the merchant's share. | escrowOps.ts:515-593 | [reading] |
| U | Low | Re-publish stores `notification_id` of a notification that was `INSERT OR IGNORE`d away. | printRequests.ts:865-921 | [reading] |
| V | Low | Consistency: `restricted` merchants can bid (only `suspended` blocked) though matching excludes them; lapsed-plan merchants are notified but can't bid; `private` visibility is honoured by board/files but ignored by matching, offers and the `request-matches` title list. | merchantAuth.ts:189-203; printRequests.ts:976-991; marketplace.ts:537-552 | [reading] |
| W | Low | `source_url` stored without URL validation (≤600 chars). Not rendered today, but a future `<a href>` would be an XSS sink; validate with `validateOutboundUrl`. | printRequests.ts:687, 807 | [reading] |
| X | Low | Retention: expired guest `print_analyses` (48 h promise) and their R2 models are never purged; `model_view_tokens` never pruned; deleting an attachment leaves its `request-previews/…lvm` object; request files kept forever. | printQuote.ts:468-470; no DELETE in `worker/`; marketplace.ts:405-407 | [reading, grep-confirmed] |
| Y | Low | Owner can't open their own request page while the community is closed (`GET /requests/:id` is gated before the owner check) → the "pending offers while closed" screen shows no attachments. | marketplace.ts:160; Requests.tsx:417-424, 1002-1039 | [reading] |
| Z | Low | CostingTab reason labels don't match server codes (raw codes shown). | CostingTab.tsx:106-113, 403; printers.ts:292-307 | [reading] |

No finding allowed one customer to read another customer's private data beyond the designed "public + open ⇒ any signed-in user" rule; ownership checks (`customer_id = ?`, `merchant_id = ?`, `loadOrderForParty`) and SQL-level offer filtering held up in every path examined.

---

## 11. Recommended foundation changes, in dependency order

**Phase 0 — stop-the-bleeding (independent, small, each with a route-level regression test)**
1. Bug A: make the one-order-per-offer rule partial — a migration that replaces `idx_community_orders_offer` with `CREATE UNIQUE INDEX … ON community_orders(offer_id) WHERE state <> 'cancelled'` (index-only; `DROP INDEX` has precedent in 0064/0083) — or stop inserting a fresh order per attempt (fund first, then create the order). Also put the request race guard, the offer freeze (`AND state='pending' AND price_iqd=?`) and the order insert into ONE batch with a fence statement so a crash cannot strand `offer_selected`.
2. Bug B: `accept` requires `expected_price_iqd` + offer `updated_at`/revision; audit every offer edit.
3. Bug D: define payout rows as `available` negatives (or compute available = credits − payouts − reversals) and make the payout an `INSERT … SELECT … WHERE balance >= amount`; migrate existing rows by compensating entries, not edits.
4. Bug C: resolve requires `disputed` (or an explicit override flag), skips side effects on replay, moves request + complaint to their final states, notifies both parties.
5. Bugs F/G: add `requireCommunityOpen` to file download + token mint; check request state and caller right at token use; add revocation on close/cancel; stop returning `file_name`; cap TTL.
6. Bug L: alias `m.build_*`/`m.nozzle_*` in `loadMerchantPrinters`; align reason codes in CostingTab.
7. Bugs J/I/H: forbid request-level cancel once an order exists (route cancellation through the order); enforce `expires_at` in offer create/accept; decrement `offer_count` on withdraw (or derive it).
8. Either implement the auto-complete sweep or remove the promise from both UIs.

**Phase 1 — request lifecycle foundation** (everything else keys off this)
9. Real `draft → published` split: create as `draft` (not on the board, not offerable), publish = the only transition to `open`, performed by one endpoint that also runs matching; `/repeat` creates a draft.
10. Request **revisions**: `community_request_revisions` (spec + files + estimate snapshot, hash); offers reference the revision they priced; material spec changes after the first offer create a new revision that marks older pending offers `superseded` and notifies their merchants. Order snapshots the accepted revision.
11. Wizard input model for the target: sources = model upload | link | images | description-only; "not sure" for process/material; manual dimensions; notes; structured deadline (date) and budget; one-request-state source of truth (derive request state from the order once one exists).
12. Expiry/cleanup job: expire requests and offers, prune tokens, purge expired guest analyses and orphan previews, reconcile stuck `offer_selected`/`accepted` orders and orphan holds.

**Phase 2 — one capability & catalogue model** (prerequisite for matching v2 and costing v2)
13. Single material catalogue (merge `printMaterials` setting and `print_materials`, add resin) and single quality vocabulary.
14. `merchant_printers.model_id` required for new printers (canonical physics from `printer_models`, add resin models), merchant overrides economics only; admin path for unknown machines.
15. Merchant material stock (`merchant_spools` or a lighter stock table: material × colour × grams, with UI) and delivery reach (governorates served, pickup/delivery capabilities).

**Phase 3 — eligibility as data, matching v2**
16. `eligibility(request_revision, merchant)` = request requirements ∩ canonical printer capability (tech, 6-orientation fit, material/enclosure/abrasive, quality, multi-material count, nozzle) ∩ stock ∩ prefs (narrow-only, default all) ∩ location/delivery reach ∩ plan/status. Persist in `community_request_matches` (per revision) and make it the single authority for: board "for me" filter, **offer permission**, **file/preview permission**.
17. Re-match via outbox events on revision publish, printer/stock/pref changes; notifications through the outbox (push/Telegram/WhatsApp) respecting prefs and caps; fill the dead scoring signals (response time, reliability, PRO) or drop them.

**Phase 4 — files & previews**
18. Permission matrix: eligible merchants → preview (decimated/quantised, watermark) + images; original download → customer, admin, accepted merchant (or customer-granted per merchant); all reads audited. Tokens bound to (user, revision), revocable.

**Phase 5 — offers v2 and escrow/order v2**
19. Offer revisions (price, completion days, delivery method enum, materials from catalogue, inclusions, warranty, validity), edit = new revision visible to the customer, full offer UI incl. edit/withdraw, notifications on accept/reject/supersede.
20. Order v2: snapshot address/contact release and open a context chat at funding; `delivered → in_progress` rework route; merchant dispute UI; notifications at every step; admin resolution closing request+complaint; partial refunds with explicit pro-rated `commission` rows and `released_iqd`; DB triggers enforcing append-only on escrow events and ledger; reconciliation report.

**Phase 6 — merchant costing v2 (private)**
21. Cost a request revision directly (server-side read permission via eligibility, no re-upload), write `print_quotes.request_id`, "use this as my offer" prefill (price stays private until sent); merchant economics + spools UI; resin path; record actuals/failures to feed calibration.

**Phase 7 — tests**
22. Route-level suites for accept (race, retry after funding failure, bait-and-switch), confirm/dispute/resolve replays, payouts, token lifecycle, draft visibility, revision supersession, eligibility-gated offers/files.
