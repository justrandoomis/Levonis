# Levo master spec: plan for Phase 1 and Phase 2

This plan covers spec §31 Phase 1 (shared foundations) and Phase 2 (the first complete journey). It is a list of pushes. Each push names its files, its migrations (additive only) and its tests, mapped to the §29 acceptance ids, and ends with a definition of done.

- **Base:** `b8233ee3` (Phase 0). **Status refreshed on 2026-10-20 at `aa713842` (live).**
- **Evidence:** `docs/LEVO_ACCEPTANCE_MATRIX.md` (row ids such as `17.parts`) and `docs/LEVO_GAP_MAP.md` (integration points I1–I15, duplication risks D1–D17, conflicts 0–70).
- **Owner answers:** Q1–Q8 were answered on 2026-10-19 and are recorded in DECISIONS row 262 (section 6 below). Q1 and Q5 differ from the recommendation: there is no allow-list, and the accepted merchant also receives the template or Studio source.

**Status per push at `aa713842`:**

| Push | Status | Commits | Deploy |
|---|---|---|---|
| P1-01 | landed; live check open | [13cc3bbb](https://github.com/justrandoomis/Levonis/commit/13cc3bbbf4b02d50cd6600ab4587f47818f2466a) [b5849909](https://github.com/justrandoomis/Levonis/commit/b5849909b63d6cc960f0d65ea9e75e7f81040233) [2f87b255](https://github.com/justrandoomis/Levonis/commit/2f87b25511dfc89ce30e6dd85cb8227c72733fa2) [e7071e22](https://github.com/justrandoomis/Levonis/commit/e7071e22bf6f6186d9b9de80eef6eef44aaef8ff) [016bc50e](https://github.com/justrandoomis/Levonis/commit/016bc50eb1f20cc7e739307da23b316aecc104ca) [25f964c6](https://github.com/justrandoomis/Levonis/commit/25f964c62f00512c69574e27377dd6eef7d3a735) | [run 385](https://github.com/justrandoomis/Levonis/actions/runs/39306603594) |
| P1-02 | landed; live check open | [459ab4fc](https://github.com/justrandoomis/Levonis/commit/459ab4fcd249d07af3ce5aa87a064fc6de915645) [aa713842](https://github.com/justrandoomis/Levonis/commit/aa7138420115a810391a4cf2dd63000a8461fd80) | [run 390](https://github.com/justrandoomis/Levonis/actions/runs/39344539808) |
| P1-03 to P1-08 | not started | — | — |
| P1-09 | landed; live check open | [0913940a](https://github.com/justrandoomis/Levonis/commit/0913940abb40399219908f6e32033c1cbd56c16f) (+ [8cfd2a18](https://github.com/justrandoomis/Levonis/commit/8cfd2a1826852675d68edea3f8fd6506ab144deb), [78f59088](https://github.com/justrandoomis/Levonis/commit/78f59088c93eec53009c38fc493470208bab4a2c)) | [run 387](https://github.com/justrandoomis/Levonis/actions/runs/39315589473); [Studio run 22](https://github.com/justrandoomis/Levonis/actions/runs/39317770773), [verify run 4](https://github.com/justrandoomis/Levonis/actions/runs/39318101437) |
| P1-10 | done | [11d0a119](https://github.com/justrandoomis/Levonis/commit/11d0a119b6a84cb0873963302dd7727f9b152856) (+ [8cfd2a18](https://github.com/justrandoomis/Levonis/commit/8cfd2a1826852675d68edea3f8fd6506ab144deb), [78f59088](https://github.com/justrandoomis/Levonis/commit/78f59088c93eec53009c38fc493470208bab4a2c)) | [run 387](https://github.com/justrandoomis/Levonis/actions/runs/39315589473); [Studio run 22](https://github.com/justrandoomis/Levonis/actions/runs/39317770773), [verify run 4](https://github.com/justrandoomis/Levonis/actions/runs/39318101437) |
| P1-11 to P1-13 | not started | — | — |
| P1-14 | in progress (this push, prose only) | — | skipped by design |
| P2-01 to P2-10 | not started | — | — |

Outside this plan, also live since Phase 0: assistant price parity and the printer finder ([fb56c50d](https://github.com/justrandoomis/Levonis/commit/fb56c50df16cc8766e0971c20837de8f9f51fcf4), [11e07ff5](https://github.com/justrandoomis/Levonis/commit/11e07ff550f10d73f7f696d953b10f2c153f7568), [run 381](https://github.com/justrandoomis/Levonis/actions/runs/39283808130)), the catalogue import delta mode and full listing paging ([f0c5cb82](https://github.com/justrandoomis/Levonis/commit/f0c5cb823341e970b271b20fd90d39cfa3889d8e)…[003e580c](https://github.com/justrandoomis/Levonis/commit/003e580c73d00416f684d53b81695d47f83cda87), [run 385](https://github.com/justrandoomis/Levonis/actions/runs/39306603594)).

---

## 0. Rules every push follows

**Flow (CLAUDE.md, DECISIONS row 184):**
- Run `npm run check` and `npm run test:unit` locally.
- Push to `claude/new-session-2hq4ci`.
- Follow workflow 7 to green, then probe the live site.
- No feature branches merged by hand, no force-push.
- A prose-only push (`docs/`, `*.md`) skips the deploy.

**Migrations:**
- `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` / triggers only. Never rebuild a CHECK; add a column or a side table instead (conflict 6).
- The number is assigned at push time. `0205` is live, so the next free number is `0206`. The names below are working names.
- Every new read tolerates the table or column being absent, because an older build or database may run.
- Studio migrations live in `studio/drizzle/` (`0001` and `0002` are live; next: `0003_*`).

**Money and policy:**
- Money paths (escrow, ledger, commission, refunds) are untouched unless a push says so.
- The money tests (`tests/escrow.test.ts`, `tests/merchantLedgerFlows.test.ts`, `tests/offersV2.test.ts`, `tests/communityAcceptIntegrity.test.ts`) must pass unchanged.
- No invented number (rule 13): royalties and licence terms wait for the owner (L6). The owner's numbers are Q4 24 h, Q7 1 GiB per user and 64 MiB per file. A minimum job price is the merchant's own (Q3); the platform sets none.

**Owner decisions honoured:**
- C1–C16 (with C8 changed: re-apply immediately).
- S1–S13; S10 staff never get money access.
- The community stays **closed**: every community-facing piece sits behind `requireCommunityOpen` (`worker/lib/communityGate.ts:233`). Owner answer Q1: no allow-list; the journeys are built open to everyone, and the owner opens the community and `/requests` when every task is complete.
- Smart Diagnose stays deterministic.
- The AI layer (Workers AI + Claude API behind an adapter) belongs to the smart search and assistant lane. Phase 1–2 use **no model** for geometry, prices, stock, compatibility or Sorani.

**Existing engines reused, never duplicated:**
- Pricing V2 on a USD base (`packages/pricing`, `worker/lib/pricingEngine/*`, `worker/lib/fx/officialRate.ts`).
- Print engine B (`worker/lib/printQuote/*`). Engine A is frozen for legacy estimates (D1).
- The slicer in `studio/` (`studio/app/engine-adapter.ts`, Orca presets).
- R2 private storage and `fileOwnership`, `requestFilePolicy` and `viewerGrants`.
- The single-seller cart (`worker/lib/cartSeller.ts`): tool and template orders go through request, offer and escrow, never the cart.
- Messages and notifications (`notifyGrouped`, `postSystemCard`).

**Strings:** every new string ships in ar, en and real ckb (row 183). Add the files to the Sorani ratchet (`tests/soraniStorefrontGaps.test.ts` pattern).

**Definition of done (every push):**
1. Both local gates are green.
2. Workflow 7 is green and the live probe passes.
3. Every new route has a `tests/routeClass` entry.
4. Every new public DTO has a leak-audit test.
5. Bundle budgets are green (`tests/bundleBudget.test.ts`, `tests/store-isolation.test.ts`).
6. The matching `docs/LEVO_ACCEPTANCE_MATRIX.md` rows are updated with file:line evidence. An acceptance id is marked done only with a passing test cited.
7. A DECISIONS row is written per phase and per owner answer.
8. Anything not built is listed in the push notes, never claimed.

---

## 1. Order and lanes

```
Phase 1
  Lane A (approval, admin)   P1-01 ─► P1-02
  Lane B (requests)          P1-03 ─► P1-04 ─► P1-05 ─► P1-06
  Lane C (merchant admin)    P1-07 ─► P1-08 (optional in Phase 1; S6/S7 are decided)
  Lane D (Studio)            P1-09 ─► P1-10 ─► P1-11 (needs P1-04 sources)
  Lane E (assets, tests)     P1-12 ─► P1-13 ─► P1-14 (docs, last)
Phase 2 (starts when P1-01, P1-04, P1-09, P1-11 and P1-12 are live)
  P2-01 ─► P2-02 ─► P2-03 ─► P2-04
  P2-05 ─► P2-06 ─► P2-07 ─► P2-08 ─► P2-09
  P2-10 (after P2-01 and P2-06)
```

Lanes run in parallel only when their file sets do not overlap. Lane B and Lane D meet at P1-11 (request source kind `studio_revision`).

---

## 2. Phase 1: shared foundations

Spec line 805 lists:
- images and multi-source requests;
- tenant isolation, KYC and merchant approval;
- the single cart;
- the earlier Shopify admin and filters;
- Studio linking, project saving and private files.

### What is already done (do not rebuild)

| Area | Live evidence |
|---|---|
| Merchant approval data, applicant flow, reviewer queue, owner-only grants (pushes 1.1 + 1.2) | `migrations/0204_merchant_applications.sql`; `worker/lib/merchantApproval.ts`; `worker/routes/merchantApplication.ts`; `worker/routes/adminMerchantApplications.ts`; tests `merchantApplication`, `merchantReview` and `merchantApplicationGates` |
| PII sealed, audited and never public | `worker/lib/sealbox.ts`; `tests/merchantApplication.test.ts:337-395` (acceptance 08 done) |
| Request upload hardening R2/R3 | `worker/routes/uploadSessions.ts:665-694`; `tests/requestFileDoors.test.ts` |
| Merchant admin Wave 0 (payment badge, CSV period, URL list state, account menu, ledger periods, undo, tap-to-open, ckb) | commits `8cddf83c`, `d7feb5e5`, `be069427`; `tests/merchantWave0.test.ts` |
| Single-seller cart | `worker/lib/cartSeller.ts`; `tests/merchantCartSeparation.test.ts` |
| Studio account saving, conflicts, autosave, cleanup | `studio/worker/api/projects.ts`; `studio/app/project-sync.ts`; acceptance 01 and 03 done in code (manual two-device evidence still owed) |

### Pushes

#### P1-01 Land approval enforcement and merchant Wave 1 (Lane A, L)
- **Status: landed and live (run 385); Done-when check open:** the live direct-API probe for an unapproved PLUS merchant. Landed as [13cc3bbb](https://github.com/justrandoomis/Levonis/commit/13cc3bbbf4b02d50cd6600ab4587f47818f2466a) (push 1.4), [b5849909](https://github.com/justrandoomis/Levonis/commit/b5849909b63d6cc960f0d65ea9e75e7f81040233) (push 1.3 with merchant Wave 1 and migration `0205`) and the review fixes [2f87b255](https://github.com/justrandoomis/Levonis/commit/2f87b25511dfc89ce30e6dd85cb8227c72733fa2), [e7071e22](https://github.com/justrandoomis/Levonis/commit/e7071e22bf6f6186d9b9de80eef6eef44aaef8ff), [016bc50e](https://github.com/justrandoomis/Levonis/commit/016bc50eb1f20cc7e739307da23b316aecc104ca), [25f964c6](https://github.com/justrandoomis/Levonis/commit/25f964c62f00512c69574e27377dd6eef7d3a735); live through workflow 7 [run 385](https://github.com/justrandoomis/Levonis/actions/runs/39306603594) (DECISIONS rows 259, 260). Acceptance 06 is done. Still open from this push: the PII sweep over the push 1.4 public surfaces (acceptance 08 extension) and the recorded live direct-API probe. `MERCHANT_STORES.md` and `MERCHANT_PLATFORM.md` were rewritten.
- **Content:**
  - review and land the enforcement branch: push 1.3 (landed as `b5849909`: migration `0205_merchant_application_backfill.sql`, draft applications for existing merchants under C1/C2) and push 1.4 (landed as `13cc3bbb`: E3–E12, `merchantPublicSql` and `storePublicSql` on every public surface, the creator back door, `CATALOG_CACHE_EPOCH` bump);
  - Wave 1 merchant UI.
- **Before cutover:** run the read-only LIST count of pending offers, carts and open orders of unapproved merchants, and give the owner the number.
- **Migration:** `0205` (landed and live).
- **Tests:**
  - `tests/merchantApprovalEnforcement.test.ts` (:188 every new commitment refused, :231 E6 acceptance, :544 absent from 31 public surfaces) → **acceptance 06**;
  - extend the PII sweep to the 1.4 public surfaces: search, public API, OG, analytics events → **08**;
  - approval-aware search → part of **50**;
  - F routes (orders, payouts, disputes, offer withdraw) still work under review (row `06.lapse-keeps-history`).
- **Done when:** an unapproved PLUS merchant gets `MERCHANT_NOT_APPROVED` on every E-door through a direct API call on live, and is absent from the directory, search, sitemap and OG. Then rewrite `MERCHANT_STORES.md:27-34` and `MERCHANT_PLATFORM.md:49`.

#### P1-02 Approval follow-ups and admin scope (Lane A, M)
- **Status: landed and live (run 390); Done-when check open:** a live 403 on `/api/kyc/admin/*` for an ungranted assistant. Landed as [459ab4fc](https://github.com/justrandoomis/Levonis/commit/459ab4fcd249d07af3ce5aa87a064fc6de915645) and [aa713842](https://github.com/justrandoomis/Levonis/commit/aa7138420115a810391a4cf2dd63000a8461fd80); live through workflow 7 [run 390](https://github.com/justrandoomis/Levonis/actions/runs/39344539808) (DECISIONS row 261). Acceptance 07, 34 and 48 are done. The live 403 check for an ungranted assistant is not recorded in the matrix yet.
- **Content:**
  - the C4 «مزوّد معتمد» badge, derived only from `approved_at` through `merchantPublicSql`, on the store header, directory card, product card and maker page (`worker/lib/merchantOps.ts` `badgeFor`). `verified` stays a separate mark;
  - `KYC_REVIEW` and `DISPUTES` keys in `CAPABILITY_GRANTS` (the `0204` key CHECK is shape-only, so no migration). `/api/kyc/admin/*` (`worker/routes/kyc.ts:178`) and the complaints routes (`worker/routes/adminCommunity.ts:1073-1178`) use a `canReviewKyc` / `canHandleDisputes` gate: owner and full admins by default, assistants only with an owner grant (C5 pattern, `worker/lib/merchantApproval.ts:302-316`);
  - drop `customer_name` and `customer_username` from the public request list (`worker/routes/community.ts:405,430`; conflict 62);
  - real Sorani for the Admin tab labels (`src/pages/Admin.tsx:284-354`, conflict 3).
- **Migration:** none.
- **Tests:**
  - scope matrix rows: PREMIUM customer, assistant without the grant, merchant → no KYC read, no approval → **07**;
  - public-list schema assertion (no identity fields) → **34**;
  - checkout address change leaves `merchant_applications`, membership and KYC rows untouched → **48**;
  - badge renders only for approved, non-suspended merchants.
- **Done when:** an assistant without a grant gets 403 on `/api/kyc/admin/*` on live.

#### P1-03 Request hardening, the rest (Lane B, M)
- **Status: not started.**
- **Content:** the Community V3 gap plan Phase 2 items not yet live:
  - R1: `LinkCard` for the pasted link on details, board and offer panel (`worker/lib/linkCards.ts`, `src/components/community/links/LinkCard.tsx`);
  - R4: Blob previews `{tempId, File, objectUrl}`, revoked on unmount; both upload doors answer `{id, url, inline}`;
  - R5: one upload-limits module in `packages/contracts`, read by every door and by the UI (D11);
  - R6: `attachmentDisposition`;
  - R8/R9: localised mirrors and wizard ckb;
  - R11: the legacy POST uses `process_unsure`;
  - R12: a sized rendition behind the authorised route (`worker/lib/imageVariants.ts`, `marketplace.ts:493`);
  - R13: align with row 173;
  - a client-side size check in `RequestWizard.addFiles`;
  - coded format errors rendered from `FORMAT_CAPABILITIES` in ar/en/ckb (row `14.format-honesty`).
- **Migration:** none.
- **Tests:**
  - a session completing on a published request supersedes stale offers and notifies once;
  - a 7th file is refused;
  - limits are identical across the three doors;
  - an Arabic file name downloads;
  - a retried part reuses the same file row → **13**.
- **Done when:** request images show as thumbnails (never ids) in the wizard, details and offer panel on live, at 360×740.

#### P1-04 Request model v3: data and one read path (Lane B, L)
- **Status: not started.**
- **Content:** the Community V3 gap plan §4.1–§4.3:
  - `readRequestModel(db, id)` with synthesis from v1 rows;
  - a versioned `canonicalFacts` (the v1 string stays byte-exact for `schema_version = 1`, `worker/lib/requestRevisions.ts:55-82`);
  - writers that write v3 **and** the v1 mirror;
  - a deterministic, idempotent backfill.
- **Migration** `~0206_request_sources_parts.sql`:
  - new tables `community_request_sources` (kind file / link / text_ref / **studio_revision** / **project_post**), `community_request_parts`, `community_request_part_sources`, `community_request_part_materials`;
  - summary columns on `community_print_requests`;
  - `coverage_json`, `substitutions_json` and `covers_all` on `community_offers`.
- **Tests (legacy fixtures):**
  - v1 model request with a pending offer → still acceptable at the same hash → **27** (regression);
  - link request, images request, description-only request;
  - a chat or direct request keeps `legacy_text`;
  - `colors_count = 3`;
  - an accepted order snapshot is untouched;
  - re-publish with no change → `replayed`;
  - back and reload keep every source → **14** (server half), **20** (hash versioning).
- **Done when:** both the old and the new build read every live request coherently (compatibility run in both directions).

#### P1-05 Readers and offers v3 (Lane B, L)
- **Status: not started.**
- **Content:**
  - estimate per part with honest coverage (`priced_parts` / `unpriced_parts`; fixes R10, `printRequests.ts:856-870`);
  - eligibility and matching per part, so a four-part single-colour job never demands a multicolour machine (`worker/lib/eligibility.ts:261,303`);
  - offer coverage and substitutions; acceptance requires `accept_substitutions` (`OFFER_SUBSTITUTION_UNACCEPTED`);
  - snapshot v3; a "partial" chip in `OfferCompare`;
  - a `needs_technical_review` state visible to the customer and to merchants (Scenario D step 2);
  - the admin technical-review view (`adminCommunity.ts:811-870`).
- **Migration:** none (uses `~0206`).
- **Tests:**
  - mixed PLA + TPU job priced per part; an unsupported combination refused with a coded ar/en/ckb reason → **15**;
  - substitutions unaccepted → refusal;
  - money tests unchanged;
  - Scenario D steps 2–3 → `30.D2`, `30.D3`.
- **Done when:** a multi-part request shows a per-part estimate and receives comparable partial and complete offers on live, behind the closed gate (Q1).

#### P1-06 Request UI v3 and entry points (Lane B, L)
- **Status: not started.** Q2 is answered (private budget by default, with the switch).
- **Content:**
  - the route `/requests/new[/:id]` with an action bar;
  - a unified sources area (per-source note, primary, partial success, retry, cancel, explained rejection);
  - an image grid with an in-page viewer;
  - a parts editor;
  - searchable material and colour pickers (name + swatch, «أي لون مناسب», «كما في المرجع»);
  - a «ما يراه الآخرون» panel listing every field as public, merchants-only or private;
  - a budget visibility toggle (**Q2** answered: private by default, with an «اعرض ميزانيتي للتجار» switch).
- **Entry points:**
  - `Requests.tsx` reads `project`: the handoff **copies** the post's downloadable files into the request (new `file_objects` rows by sha256, kind `project_post` source with `post_id`), so a later post edit can never change a request (conflict 5);
  - «اطلب طباعته» on product pages;
  - «لهذا المتجر فقط» (direct request) from the store page, not only from chat (`worker/lib/directRequests.ts`).
- **Migration:** none.
- **Tests:**
  - Playwright `scripts/e2e-request.mjs` at 360×740, 740×360 and with the keyboard open: previews before and after upload, after reload, in a reopened draft, at review and on details → **13**, **14**;
  - a public view carries no phone, address, original or private budget → **34**;
  - a project handoff keeps the request's files when the post is later edited → **20** (part).
- **Done when:** the Scenario D request (STL + images + link + description + two parts with different materials) is created, saved, resumed and published on live behind the closed gate (Q1) → **30.D1**.

#### P1-07 Merchant admin carry-over: saved views and filters (Lane C, M)
- **Status: not started.**
- **Content:** the Shopify gap study next wave:
  - server-side saved views per store (name, closed filter keys, sort);
  - the orders filter catalogue: date, governorate, payment, delivery type (`src/components/merchant/orders/ordersView.ts`, `worker/routes/merchantOrders.ts`);
  - `DataList` columns, sortable headers and a views prop (`src/components/ui/DataList.tsx`, `src/lib/listView.ts`);
  - a bulk **dry-run** that returns affected rows and price/stock deltas before confirm (`worker/routes/merchantCatalog.ts:578-584`, `CatalogManager.tsx:145-180`);
  - an audit row on `/orders/bulk-status` (`merchantOrders.ts:402-427`; verify first).
  - Kanban stays for Phase 3.
- **Migration** `~0207_merchant_saved_views.sql`: `merchant_saved_views(id, store_id, surface, name, filters_json, sort, created_by, created_at, archived_at)`, unique `(store_id, surface, name)`.
- **Tests:**
  - views never cross stores (IDOR row) → **09** (part);
  - filters use server data only → **50** (part);
  - a dry-run equals the real result;
  - Back restores a saved view.
- **Done when:** a merchant saves «طلبات الكاش المتأخرة» and reopens it on another device.

#### P1-08 Merchant Simple/Advanced display mode (Lane C, M; may move to Phase 3)
- **Status: not started.** S6 and S7 are decided (DECISIONS row 262); Studio already ships its own Simple/Advanced mode (P1-10).
- **Content:**
  - S6 (everyone starts in Simple) and S7 (server preference plus local mirror);
  - `navFor(mode)` in `src/components/merchant/shell/nav.ts`;
  - the mode lives in `WorkspaceValue` (`shell/context.ts`) and **never** in `me.can` or `me.selling`;
  - S12 landing on Today with a checklist.
- **Migration** `~0208_merchant_workspace_prefs.sql`: `merchant_workspace_prefs(store_id PK, mode CHECK simple|advanced, updated_at)`.
- **Tests:**
  - money, warnings and the essential amounts render in both modes;
  - the missing table means Simple;
  - shell ≤ 25 KB → **51** (part).

#### P1-09 Studio project lifecycle and pins (Lane D, M)
- **Status: landed and live (run 387); Done-when check open:** a pinned revision still readable after a forced cleanup on staging. Landed as [0913940a](https://github.com/justrandoomis/Levonis/commit/0913940abb40399219908f6e32033c1cbd56c16f) with the review fixes [8cfd2a18](https://github.com/justrandoomis/Levonis/commit/8cfd2a1826852675d68edea3f8fd6506ab144deb) and [78f59088](https://github.com/justrandoomis/Levonis/commit/78f59088c93eec53009c38fc493470208bab4a2c) (shared with P1-10); Studio migration `studio/drizzle/0001_project_archive_pins.sql`; main site [run 387](https://github.com/justrandoomis/Levonis/actions/runs/39315589473), Studio [Studio run 22](https://github.com/justrandoomis/Levonis/actions/runs/39317770773), [verify run 4](https://github.com/justrandoomis/Levonis/actions/runs/39318101437). Acceptance 02 is done; 05 has its Studio half. Still open: the manual two-device evidence (01, 03) and the staging check of a pinned revision after a forced cleanup.
- **Content:**
  - archive and unarchive, kept apart from delete, with restore-from-trash within retention (`studio/worker/api/projects.ts:342-356`);
  - a revision-history sheet that opens or restores any kept revision as a new head (`GET /revisions`, `projects.ts:477`);
  - **pinned revisions**: a revision referenced by a request or order is never pruned or purged (`studio/worker/api/cleanup.ts:13-16`; conflict 19);
  - after sign-in, an explicit «احفظ عملك في حسابي» adopts the guest draft (`studio/app/project-store.ts:93-101`, `studio/app/hooks/use-project-persistence.ts`);
  - optional purge of the previous user's local drafts on explicit logout;
  - correct the stale docs: `docs/STUDIO_GAPS.md` §6/§7, `studio/SLICER_CAPABILITIES.md:44`, `studio/SLICER_SECURITY.md:3-13`, `docs/STUDIO_STORAGE.md:116-119`, `studio/BAMBU_PRINT_PIPELINE.md:100`.
- **Migration** `studio/drizzle/0001_project_archive_pins.sql`: side tables `project_archive(project_id, archived_at)` and `project_revision_pins(id, revision_id, pinned_at, pin_reason, pin_ref)` with a unique holder index (CREATE only, per the Studio migration gate).
- **Tests:**
  - `studio/tests/api-projects.test.mjs` (archive is not delete; a pinned revision survives cleanup);
  - a browser test: sign in as A, open the panel, switch to B, assert no A thumbnail, draft or cached response → **02**;
  - a guest edit survives sign-in and is adopted only on consent → **05** (Studio half);
  - manual two-device evidence → **01**, **03**.
- **Done when:** a revision pinned by a test request is still readable after a forced cleanup run on staging.

#### P1-10 Studio hardening and Simple mode (Lane D, S–M)
- **Status: done.** Landed as [11d0a119](https://github.com/justrandoomis/Levonis/commit/11d0a119b6a84cb0873963302dd7727f9b152856) with the review fixes [8cfd2a18](https://github.com/justrandoomis/Levonis/commit/8cfd2a1826852675d68edea3f8fd6506ab144deb) and [78f59088](https://github.com/justrandoomis/Levonis/commit/78f59088c93eec53009c38fc493470208bab4a2c); Studio migration `studio/drizzle/0002_user_prefs.sql`; main site [run 387](https://github.com/justrandoomis/Levonis/actions/runs/39315589473), Studio [Studio run 22](https://github.com/justrandoomis/Levonis/actions/runs/39317770773), [verify run 4](https://github.com/justrandoomis/Levonis/actions/runs/39318101437). The fail-open liveness and the callback-code log trade-offs are documented in `docs/STUDIO_AUTH.md`.
- **Content:**
  - refuse non-GET `/api` when `Origin` ≠ self, reusing the logout check (`studio/worker/auth/callback.ts:224-236`);
  - a D1 fixed-window rate limit with the main site's key derivation (`worker/lib/ratelimit.ts`);
  - strip `levonis_session` from requests inside the Studio Worker before vinext (conflict 54; scope per **Q8**);
  - a localised certificate-trust prompt (`studio/app/native-printer-bridge.ts:186`);
  - a persisted Studio Simple/Advanced mode: Simple hides the engine sidebar at every width and hides unsupported native controls (`studio/app/editor-theme.ts:172-198`, conflict 23), and slicing warnings and the price appear in both modes;
  - document the fail-open liveness and the callback-code log trade-off (conflicts 55, 59).
- **Migration** `studio/drizzle/0002_user_prefs.sql`: `studio_user_prefs(owner_id PK, mode, updated_at)`, and `studio_rate_limits(key, window_start, count)` for the D1 rate limit.
- **Tests:**
  - cross-site POST refused;
  - rate-limit window;
  - a forged `levonis_session` never reaches app code;
  - warnings present in Simple → **10** (regression), **02**.

#### P1-11 Studio to request handoff, «اطلب تصنيعه» (Lane D, L)
- **Status: not started** (needs P1-04 sources).
- **Content:**
  - the Studio button commits a revision, exports the production 3MF/STL with `export-manager.ts`, and **pins** it (P1-09);
  - the Studio Worker then calls the main Worker `POST /api/studio/request-drafts` server to server (bearer `STUDIO_HANDOFF_SECRET`, purpose `request_draft`, I1), sending `{owner_id, revision_id, content_hash, engine_version, files[{sha256, size, role}]}` and streaming bytes into an internal upload session (`worker/routes/uploadSessions.ts`);
  - main creates a **draft** request with a `studio_revision` source and returns a one-time URL to `/requests/new/:id`;
  - the request stays a draft while `/requests` is closed (**Q1**: no allow-list; the owner opens `/requests` when every task is complete);
  - add Studio entries on product, project and account pages (`01.r05`).
- **Migration:** none on main (uses `~0206` source kind). Studio pin columns from P1-09.
- **Tests:**
  - a forged owner or another user's revision → 404 → **09**;
  - editing the Studio project after handoff leaves the request's files and hash unchanged → **20**;
  - the main bundle still excludes Studio code → **04**;
  - no PII crosses the boundary (`27.no-pii-share`).
- **Done when:** a Studio project reaches a request draft with its production file, measured by `analyseModel`, on live, behind the closed gate (Q1).

#### P1-12 Private files, honest previews, audit log (Lane E, M)
- **Status: not started.**
- **Content:**
  - a `scan_state` on `file_objects` (quarantined → clean after sniff and bounded parse); viewer and analysis accept only clean files (`14.quarantine`);
  - a `geometry_policy` (none / coarse / full) on product and post files, read **before** `viewerMesh` runs (`16.privacy-before-preview`, `16.no-geometry-mode`);
  - an honest preview-role copy in ar/en/ckb: geometry reaches the device and can be extracted (`src/components/merchant/catalog/strings.ts:372`; conflict 61), and the same notice in the post composer;
  - correct the overclaiming comments (`worker/lib/requestFilePolicy.ts:122-124`, `worker/lib/modelGeometry.ts:1000-1004`);
  - Sorani for the viewer and PrintSummary (`src/pages/ModelViewer.tsx:133-188`, `src/components/print/PrintSummary.tsx:33-47`);
  - `X-Robots-Tag: noindex` on `/files/*`, `/model-viewer/*` and request and draft routes;
  - drop `/community` from the sitemap while it is closed (`worker/routes/seo.ts:100-109`);
  - append-only triggers on `audit_log` (first grep that no code updates or deletes audit rows);
  - write `docs/ASSET_THREAT_MODEL.md` (actor × asset × door table, citing the existing guards).
- **Migrations:**
  - `~0209_file_scan_geometry_policy.sql`: `file_objects.scan_state`, `product_files.geometry_policy`, `community_post_files.geometry_policy`;
  - `~0210_audit_log_append_only.sql`: triggers.
- **Tests:**
  - a `none` policy mints no mesh;
  - an unscanned file cannot be analysed;
  - `audit_log` UPDATE and DELETE fail;
  - noindex headers present → **36** (part), **37** (copy part), **43** (part).

#### P1-13 Cross-tenant and regression suites (Lane E, M; tests only)
- **Status: not started.**
- **Tests:**
  - a table-driven IDOR suite with merchant B as the actor: orders, ledger, chats, offers, request files, viewer tokens, layouts, analyses, saved views → **09**;
  - a permission matrix over search, notifications and chat per role → **50**;
  - the public chunks (`Community`, `Storefront`, `StorefrontProduct`) exclude `vendor-webgl` and `ModelViewer` in their static closure → **04**;
  - a locked-download sweep over search results, public API and share-kit payloads, plus Cache-Control on download doors → **36**;
  - malicious fixtures: a 42.zip-style bomb, a 3MF with an external rel to `169.254.169.254`, an SVG with script → **41**;
  - cache revocation: cache a public resource, suspend it, the next read misses → **43**;
  - no review without a qualifying purchase; one review and one reward per order → **47** (store part);
  - the additive-migration gate extended to `migrations/` (`tests/migrationsAdditive.test.ts:25`) → **53** (part);
  - tool and template orders never write cart rows (guard for P2-07) → **11** (part).
- **Migration:** none.

#### P1-14 Commit the matrix and the map (Lane E, S; prose only, so workflow 7 skips the deploy)
- **Status: in progress — this push** (prose only: `docs/LEVO_ACCEPTANCE_MATRIX.md`, `docs/LEVO_GAP_MAP.md`, this plan, `docs/LEVO_REFERENCE_MATRIX.md`, DECISIONS row 262).
- `docs/LEVO_ACCEPTANCE_MATRIX.md` (from the Phase 0 traceability matrix, kept outside the repository, with run links and a manual-evidence column; `docs/ACCEPTANCE.md` is left untouched) → **29.00**.
- `docs/LEVO_GAP_MAP.md`.
- The Phase 0 baseline: PageSpeed numbers, the verify-all run link, Studio perf `.latest.json`.
- A DECISIONS row recording the AI-layer decision and S1–S13 (conflict 8).

### Phase 1 exit check

These rows move to `done` with cited tests:
- acceptance 02, 04, 06, 07, 09, 13, 14, 34, 36, 41, 43, 48, 50;
- 01 and 03: record the manual two-device evidence (automated proof done); 02 and 06 likewise record their real-device pass and live direct-API probe;
- `30.D1`, `30.D2`, `30.D3`.

The tenant and approval journey is proven on live. Request images, sources and parts work on live behind the closed gate (Q1). Studio projects reach a request draft. No public community launch.

---

## 3. Phase 2: the first complete journey

Spec line 807 lists:
- medal, names and organiser generators;
- the template and variable model;
- the merchant capability profile;
- check, slicing and unified pricing;
- an approved quote, acceptance, Production Package, order and delivery;
- user, merchant and admin UI and tests working together.

**Target journey (path A, spec §17):**
1. A customer opens a store's template (or a Levo first-party tool) and customises it in Studio.
2. Geometry is generated deterministically, checked, sliced and priced on the server against that store's approved profile.
3. The quote is READY and the customer accepts; the hold is placed in escrow.
4. The merchant receives a Production Package, confirms, produces, packs and delivers.
5. The customer confirms and leaves a verified review; the ledger settles under the existing rules.
6. Path B (several eligible merchants) uses the same quote engine with bounded fan-out.

### P2-01 Template and variable model (L)
- **Status: not started.**
- **Content:**
  - `packages/templates`:
    - variable types `text | colour | length | count | position_in_area | shape_from_set | part_from_catalogue`;
    - each variable has type, unit, min, max, default, step and requires/excludes rules;
    - one validator shared by server and client;
    - canonical `parameter_hash`.
  - Template kinds `fixed_model | parametric`. Only parametric templates expose variables (`12.stl-not-parametric`).
  - A lifecycle state machine: `draft → testing → in_review → published → archived | withdrawn`.
  - A withdrawn version never deletes ordered copies; pins come from P1-09 and the `production_packages` of P2-08.
  - Provenance `{template_version_id, source_version, generator_id, generator_version, parameter_hash, output_hash}` goes into the Studio manifest (`studio/app/project-sync.ts:88-125`, `schema_version` bumped, absent-tolerant) and later into the order line.
  - Templates are **data**. Only approved first-party generator code runs (`12.no-untrusted-code`).
  - Phase 2 ships Levo first-party templates only: designer publishing, licences and royalties wait for the owner (blocked rows 12.designer-share, 12.rights-ledger).
  - Naming avoids `worker/lib/template.ts` (D12).
- **Migration** `~0211_parametric_templates.sql`:
  - `parametric_templates(id, owner_kind levo|store, store_id NULL, kind, title_ar, title_en, title_ckb, visibility private|unlisted|public, created_at)`;
  - `parametric_template_versions(id, template_id, n, state, generator_id, generator_version, schema_json, limits_json, test_cases_json, source_key NULL (private R2), can_customise, can_order, can_download, manufacture_scope any_approved|authorised_only, published_at, withdrawn_at)`;
  - `parametric_template_events` (append-only trigger, as in `0204:91-98`);
  - `store_template_authorisations(store_id, template_version_id, profile_version_id NULL, enabled, created_at)`.
- **Tests:**
  - an out-of-bounds value is refused by the server even when the client sends it → **18**;
  - a private source key never appears in any response, DOM or source map → **18**, **35** (network part);
  - a published version is immutable; v2 never changes a v1 order → **20**;
  - the state machine rejects illegal moves.

### P2-02 Fonts and Arabic text shaping (M–L)
- **Status: not started.**
- **Content:**
  - a font registry `packages/templates/fonts.ts`: id, file, licence, `outline_allowed`, ar/ckb/en glyph coverage. Cairo (OFL) and the Kurdish patch are audited first (`public/fonts/cairo/LICENSE`);
  - shaping with **harfbuzzjs** (licence checked and recorded in `docs/THIRD_PARTY_NOTICES.md`), loaded only on the Studio and generator path, never in store or community chunks;
  - glyph outlines are extruded; islands (dots, hamza) are detected and joined to the backing plate or reported precisely;
  - a measured spike decides where the server re-run happens: the main Worker (128 MB, CPU) or the Studio Worker. The result goes into the compute runbook.
- **Migration:** none.
- **Tests:**
  - golden tests for connected Arabic, Sorani letters, dots, digits, mixed RTL/LTR and an over-long name: a watertight mesh, or a precise ar/en/ckb warning, never a broken file → **16**;
  - the font gate refuses a font without `outline_allowed`.

### P2-03 Generators v1: keychain/medal from a logo, name sign, drawer organiser (XL)
- **Status: not started.**
- **Content:**
  - `packages/generators`: pure TypeScript, deterministic, bounded (triangle, vertex and time caps), no DOM.
  - **Medal and keychain:**
    - an in-browser canvas pipeline (crop, threshold or flood-fill background, posterise to ≤ N colours, contour trace, simplify) sends **bounded polygons** as the `logo_paths` parameter;
    - the server validates the polygons (closed, simple, vertex cap) and extrudes one body per colour layer, plus the base and the ring hole;
    - background removal is deterministic, with no model (conflict 22);
    - SVG stays refused (`14.svg-sanitize`);
    - the logo image is stored privately as a reference.
  - **Name sign:** the P2-02 pipeline, with height, thickness, base, border, colours and a hanging option.
  - **Drawer organiser:** outer L×W×H in the displayed unit, a divider grid, wall and gap within limits; a fit panel (inner and outer dimensions, tolerance) against `printerEligibility` build volume (`worker/lib/printQuote/printers.ts:279-292`), with a split suggestion through `studio/app/plane-cut.ts`. No measuring from photos.
  - Every output runs through `analyseModel` (`worker/lib/modelGeometry.ts`).
  - The server re-run produces the **authoritative** mesh and `output_hash`; the browser preview must match that hash before a quote.
  - Licensed example assets only, recorded in the dependency list.
  - **Names batch:** CSV or list → N parameter sets → N objects, each row validated for length, duplicates and glyph coverage (`worker/lib/importCsv.ts` parsing).
- **Migration:** none (outputs are request files and Studio revisions).
- **Tests:**
  - each generator yields a real, checkable mesh (watertight or a precise warning) → **17**;
  - the plate check reports overflow, collisions and margins (`studio/tests/arrange.test.mjs` extended) → **21**;
  - 20 names with one invalid → per-piece review and a refusal reason → **19** (names);
  - a killed server re-run leaves no partial output and no price → **42** (part).

### P2-04 Studio Tools screen and customiser (L)
- **Status: not started.**
- **Content:**
  - a Studio start screen with three doors: Tools · My projects · Upload. Only tools whose generator is live are listed (`11.all-in-scope` registry test);
  - a customiser with debounced input, `AbortController`, a low-detail preview tier and a visible «جارٍ تحديث المعاينة والسعر» state. There is never a full slice per keystroke (`28.live-customize`);
  - the manufacture-size control is separate from the camera; changing it writes a new revision and re-runs the check and the quote (`15c.view-vs-manufacture-size`);
  - guest customisation survives sign-in through P1-09 adoption;
  - saving writes a project revision with the template block;
  - the material and build-plate pickers in Setup come from the bundled Orca presets (`10.printer-material`).
  - **Q6** answered (tools live in Studio) and **Q7** answered (1 GiB per user, built in P1-09).
- **Migration:** none.
- **Tests:**
  - a guest customises, signs in and saves without losing the edit → **05**;
  - camera and zoom send no request; a scale change re-quotes → **26**, **39** (scale part);
  - the preview is tied to `output_hash` (no fake demo, `11.no-fake-demo`);
  - store and community bundles unchanged → **04**.

### P2-05 Merchant capability profile v1 (L)
- **Status: not started.**
- **Content:**
  - **versioned, immutable profiles:** printer units (identical machines, for parallel capacity), bed margin, the process-profile ids taken from Studio presets (`studio/app/printer-profiles.ts`, `profile-loader.ts`), materials and colours from `merchant_material_stock`, and a reservation margin;
  - **cost profile:** task minutes (prepare, bed, support removal, finishing, assembly, QC), packaging per piece, margin method (margin or markup, never mixed), and the merchant's own minimum job price (**Q3** answered: allowed in the merchant's profile and shown clearly to the customer; the platform keeps no minimum);
  - spools CRUD (`merchant_spools`, `0078:173-191`; read today in `worker/lib/printQuote/repository.ts`);
  - cost inputs in IQD, USD, EUR or CNY, converted through `worker/lib/fx/officialRate.ts`, storing `{amount, currency, rate, source, at}` (rule 14; rows 252, 254). Recorded IQD history is not migrated;
  - a change creates a new version that affects new quotes only; approved orders keep their copy;
  - a workspace «القدرات والتكلفة» screen in Simple and Advanced (P1-08);
  - a Templates section listing authorised templates with the profile version used.
- **Migration** `~0212_merchant_production_profiles.sql`:
  - `merchant_production_profiles(id, store_id, current_version_id)`;
  - `merchant_profile_versions(id, profile_id, n, printers_json, process_json, materials_json, cost_json, currency_inputs_json, effective_from, approved_by_merchant_at, created_at)` (immutable trigger);
  - `merchant_spools` write route only (the table exists).
- **Tests:**
  - an edit makes v2, and a quote made on v1 still shows v1 figures (`18.versioned-changes`);
  - a staff member (when S10 lands) never reads cost;
  - currency inputs round-trip with their snapshot → **25** (inputs part);
  - another merchant never reads the profile → **09**.

### P2-06 Unified check, slice and price (L)
- **Status: not started.**
- **Content:**
  - **Studio posts slice stats** to the existing, unused `POST /api/print-quote/analyses/:id` (`worker/routes/printQuote.ts:688`) with `slicer_version` and `profile_revision`; the fingerprint invalidates on printer, nozzle, material or profile change (conflict 35).
  - **Plausibility rule:** client stats are accepted for READY only when grams and time fall inside bounds derived from the server's own geometry analysis (volume × density × the profile's wall/infill model, ± tolerance). Otherwise the outcome is `NEEDS_REVIEW`. The client never sends a trusted final amount (`19.server-side-quote`).
  - A quote endpoint takes `{template_version_id | project_revision, parameter_hash, options, quantity, delivery_address_id}` and prices with **engine B only** (`priceForPrinter`, `printQuote.ts:1578`) against the store's approved profile version. Quantity > 1 is supported. Plates come from the real batch layout, not a multiplied single price (`11.9-batch-plates-price`).
  - The delivery fee comes from the merchant's delivery rules (`resolveMerchantDelivery`).
  - Outcomes: `READY_TO_EXECUTE | NEEDS_REVIEW | NOT_EXECUTABLE`, with reason codes (needs material, capacity unavailable, needs repair, expired, not executable at this merchant) in ar/en/ckb. The word «نهائي» never appears outside READY.
  - Engine A stays frozen (D1).
  - The **RIGHTS** cost line exists but stays off until the owner decides royalties.
- **Migration** `~0213_print_quote_outcomes.sql`: on `print_quotes` add `outcome`, `outcome_reasons`, `approval_level`, `currency_snapshot`, `project_revision`, `template_version_id`, `parameter_hash`, `profile_version_id`; on `community_offers` add `quote_id`.
- **Tests:**
  - a free file or an unapproved output never gets READY → **22**;
  - a printer, nozzle or material change invalidates the slice and the quote, with no G-code reuse → **23**;
  - each cost component appears exactly once across quote, offer and order → **24**;
  - fast-check properties: sum(components) = total, rounding idempotent, payouts + commission = escrow gross → **25**, **55** (part);
  - size, quantity, spec or delivery change reprices; zoom does not → **26**;
  - a per-merchant price for the medal batch → **30.A2**, **19** (plates and cost).

### P2-07 Approved offer and acceptance (L)
- **Status: not started.**
- **Content:**
  - **Path A:** a READY quote at a store whose `store_template_authorisations` enables that template becomes an auto-priced offer under the merchant's approved price rule (`quote_id`, `offer_revision`), inside a direct request (`visibility='direct'`).
  - **Path B:** the same for each eligible merchant, bounded (top N by the existing score) and never choosing for the customer (`17.no-auto-choice`).
  - The customer accepts through the existing accept route (`expected_total_iqd`, `offer_revision`, `accept_substitutions`; `worker/routes/marketplace.ts:2010-2140`).
  - **Q4** answered (24 hours): the order is born `funded` with an `awaiting_merchant` sub-state and a policy timeout. A timeout refunds once through `refundEscrow` with the `cancel:` idempotency key and never reassigns the order.
  - **Material and capacity holds** are taken in the fenced acceptance batch (`marketplace.ts:2058-2320`) and released on cancel, timeout or expiry by a sweep in `worker/lib/communityRequests.ts`.
  - Tool orders never enter the cart (P1-13 guard).
- **Migration** `~0214_production_holds.sql`: `merchant_material_holds(id, store_id, order_id, material_id, colour_key, grams, expires_at, released_at)`, `merchant_capacity_holds(id, store_id, order_id, profile_version_id, units, minutes, expires_at, released_at)`, and `community_orders.awaiting_merchant_until` (nullable).
- **Tests:**
  - an expired offer or a fingerprint mismatch is refused → **27**;
  - a double tap or two tabs create one order, one hold and one refund → **28**;
  - two orders racing for the last 200 g: one wins, the other gets `CONFLICT_RETRY` with no oversell → **29**;
  - a merchant refusal or timeout releases holds and refunds once with no reassignment → **30**;
  - every eligible merchant may quote, but only the accepted one gets production files → **31**;
  - Scenario A step 3 → **30.A3**.

### P2-08 Production Package and design-version approval (L)
- **Status: not started.**
- **Content:**
  - At acceptance, inside the same fenced batch, write `production_packages`:
    - order id and revision, design version, template provenance, `output_hash`;
    - files `[{sha256, role production|source|reference, key}]`. Owner answer **Q5**: the accepted merchant also receives the template or Studio source and its parameters, not only the production files; competitors never do;
    - printer and profile version, materials and colours, plates, copies, packaging, instructions, warnings and documented special approvals;
    - a licence snapshot (null for first-party templates);
    - the delivery address per the worker's permission.
  - `order_design_versions` records approval: `approved_by`, `approved_at`, files pinned by sha256.
  - A change after work starts is a `community_order_changes` row (delta price, delta days, new version). Both parties must approve; the package stays frozen while it is pending; any top-up or partial refund goes through the existing escrow paths only (`worker/lib/orderPriceAdjust.ts` lifecycle as the pattern).
  - The merchant sees a package view and a printable sheet in `src/components/merchant/orders/CustomOrderScreen.tsx` (reuse `orderPrint.css`).
  - Files are served only through `mayReadBytes` with a per-order grant.
- **Migration** `~0215_production_packages.sql`:
  - `production_packages` (immutable trigger);
  - `order_design_versions`;
  - `community_order_changes(id, order_id, proposed_by, delta_iqd, delta_days, new_version, state proposed|accepted|rejected|withdrawn, decided_at)`.
- **Tests:**
  - the package reaches the accepted executor only, tied to the order version → **32**;
  - a change after start needs a fresh approval and never swaps the worker's file → **33**;
  - a later Studio, project or request edit leaves the package untouched → **20**, `21.review-freeze`;
  - the merchant gets material, count and packaging without asking again → **30.A4**;
  - the original never reaches competitors → **30.A5** (regression).

### P2-09 Production stages, delivery proof, review, settlement (M–L)
- **Status: not started.**
- **Content:**
  - a `production_stage` sub-machine under `in_progress` (`preparing → printing → finishing → qc → packed → shipped | pickup_ready`), server-validated, written by the merchant, timestamped and notified (`notifyGrouped`, `postSystemCard`). Money states are unchanged (`worker/lib/communityStates.ts`);
  - a QC photo at the `qc` stage (consented portfolio use stays separate);
  - a pickup code or delivery photo as proof;
  - a verified review after completion (`worker/routes/merchantReviews.ts:189-201`);
  - the ledger settles under the existing rules (`worker/lib/merchantLedger.ts`).
- **Migration** `~0216_order_production_stage.sql`: `community_orders.production_stage`, `production_stage_at`; `community_order_events` kinds (if the column is free text, else a side table).
- **Tests:**
  - stage moves are role-checked and forward-only;
  - **one integration test from template to settlement** asserting the ledger rows per party, plus a Playwright journey on staging → **54**;
  - manual evidence of one real print on a real printer (flagged hardware-dependent) → **56**.

### P2-10 Technical review and template review queues (M)
- **Status: not started.**
- **Content:**
  - an admin queue for `NEEDS_REVIEW` quotes and requests, and for `parametric_template_versions` in `in_review`;
  - it reuses the merchant-review pattern: a `TEMPLATE_REVIEW` grant (owner-only issue, C5 default), audited decisions with `reason_public`, id-only notices;
  - this is the first slice of the ops list (assignee and due date columns on the queue rows), ahead of the full ops centre.
- **Migration:** none beyond `~0211`/`~0213` (state and outcome columns).
- **Tests:**
  - scope matrix (assistant without the grant refused) → **07** pattern;
  - a decision needs a reason;
  - no automatic approval → **22**.

### Phase 2 exit check
- **Acceptance done:** 05, 16, 17, 18, 19, 20, 21, 22, 23, 25, 26, 27, 29, 30, 31, 32, 33, 54. Test 24 is done except the RIGHTS line (off until the owner decides).
- **Scenarios:** A runs end to end behind the closed gate (Q1). C runs up to the plate preview, without AR (AR is Phase 5). D works through the request path.
- **Not in Phase 2:** Scenario B (designer rights), E (server render, blocked), F (community).

---

## 4. Deliberately outside Phase 1–2

| Item | Why | Where |
|---|---|---|
| Designer-published templates, licences, royalties (Scenario B, test 24 RIGHTS) | Owner money and legal decision (rules 13 and 18) | Phase 3, after the decision |
| Store families (S1–S5), on-canvas builder, Kanban | Studio 2.0 S3–S5 | Phase 3 |
| Community features (Makes, collections, versions, spaces, contests) | Community closed | Phase 4, behind the gate |
| Server render, iOS/Android AR, privacy tiers in the viewer | Render host; Phase 5 | Phase 5 (P1-12 covers the security parts now) |
| Image-to-3D, AI generation queue, printer camera, cloud printing | GPU host, vendor authorisation | Phase 6 (blocked) |
| AI assistant modes | Task 26 lane under the AI-layer decision; tests 44 and 45 gate it | Parallel lane |
| Full operations centre, compute dashboard | After the first queue (P2-10) | Phase 2+ |

## 5. Risks to watch

- **Worker limits:** the server re-run of generators (P2-02, P2-03) must fit 128 MB and the CPU budget. The spike decides main Worker or Studio Worker before any route ships.
- **Studio AGPL:** first-party generators shared with Studio become public source. Designer templates must stay data (conflict 25).
- **Migration numbering collisions** with parallel lanes: assign at push time and re-run `migrate-check --twice`.
- **Hash compatibility:** P1-04 must keep the v1 `canonicalFacts` byte-exact, or pending offers go stale.
- **Plausibility bounds** for client slice stats (P2-06) are new. Start conservative: anything outside the bounds is `NEEDS_REVIEW`, never a lower price.

## 6. Owner questions (answered 2026-10-19, DECISIONS row 262)

| # | Question | Recommended | Blocks | Owner answer (2026-10-19) |
|---|---|---|---|---|
| **Q1** | While `/community` and `/requests` stay closed, may the Phase 2 journey (a template order sent directly to one store, `visibility='direct'`) run for **allow-listed accounts only**? | Yes, allow-list only; no public entry until you open the community. | P1-11 publish, P2-07 to P2-09 live demo | **No allow-list.** The journeys are built open to everyone; the community and `/requests` open when every task is complete (the owner opens them). |
| **Q2** | Should the request budget be **private by default**, with an explicit «اعرض ميزانيتي للتجار» switch? Today `publicRequest` returns `budget_iqd` and the wizard says merchants see it. | Yes. | P1-06 | **Yes:** private by default, with the «اعرض ميزانيتي للتجار» switch. |
| **Q3** | May a **merchant** set a minimum job price in their own cost profile, given your rule «لا يوجد حد أدنى لأي طلب طباعة» for the platform? | Yes for merchant profiles only; the platform keeps no minimum. | P2-05 field (ships off otherwise) | **Yes:** merchants may set their own minimum job price in their cost profile, shown clearly to the customer; the platform keeps none. |
| **Q4** | For auto-priced (READY) orders, must the merchant **confirm before work starts**, and within how many hours, after which the hold is refunded once? | Yes, 24 hours. | P2-07 | **Yes, 24 hours;** otherwise the hold is refunded once. |
| **Q5** | For template and Studio orders, does the accepted merchant receive **only the production files** (generated mesh or 3MF), not a private template's editable source and parameters? Customer uploads keep row 134 (the merchant reads the originals). | Yes. | P2-08 | **No:** the accepted merchant receives the template or Studio source too, not only the production files. Customer uploads keep row 134. |
| **Q6** | Confirm the tools and the customiser live **in Studio** (one save engine and project model), not as the store-SPA personalisation engine of Programme C; storefronts only link to them. | Yes (newer spec, rule 6). | P2-03, P2-04 | **Yes:** generators and the customiser live in Studio; storefronts link to them. |
| **Q7** | The final per-user **Studio storage quota** (`docs/STUDIO_STORAGE.md:80-83`), with no subscription gate (rule 9), before generated projects add storage. | Your numbers. | P2-04 launch | **1 GiB per user**, no subscription gate; the 64 MiB file limit stays unless changed. Built in P1-09. |
| **Q8** | The session cookie: keep `levonis_session` on `.levonis-iq.com` (documented as Levonis-served subdomains only, and stripped inside Studio), or move to host-only cookies plus handoff? | Keep it, and strip it in Studio (P1-10). | P1-10 scope | **Keep** the shared `.levonis-iq.com` cookie and strip it inside Studio. Built in P1-10. |

**Later, not blocking Phase 1–2 (still open):**
- **L1:** light theme, warm ivory (rows 139/209–211) or the spec's white/grey.
- **L2:** six style families (spec §08) or ten (Studio 2.0 brief).
- **L3:** clamped pan in the 3D viewer, or orbit-only.
- **L4:** retire the admin Gemini translate route, or move it behind the AI adapter (never Sorani).
- **L5:** a dispute/complaint hold check on the 7-day cancelled-order deletion.
- **L6:** licence types and the royalty basis, before Scenario B.
