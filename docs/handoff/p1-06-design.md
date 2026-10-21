# P1-06 Request UI v3 and entry points — design (no code yet)

Worktree `/home/user/levonis-requi`, branch `feat/req-v3-ui`, on P1-05 `53c0401d` (on live `0c5ad613`).
Spec: `docs/LEVO_PLAN_PHASE1_2.md:205-226` («P1-06 Request UI v3 and entry points»), acceptance 13, 14, 20 (part), 34, Done-when 30.D1.
Owner answers honoured: Q1 (gate stays closed, no allow-list; DECISIONS row 262 (ج)), Q2 (budget private by default + «اعرض ميزانيتي للتجار»), Q5 (accepted merchant also receives the original/template/Studio source).
Builds on row 266 (P1-04: model v3, `readRequestModel`/`projectModel`, migration 0208) and row 267 (P1-05: per-part estimate with coverage, per-part eligibility, offer coverage/substitutions).
**Migration: none.** Every column used exists in 0208 (`community_request_sources.origin_*`, `sha256`, `role`, `note`, `is_primary`; `community_requests.budget_visible`). DECISIONS row 268 is reserved for this push (text in §15).

---

## 0. Decisions this design makes (short list)

| # | Decision | Why |
|---|---|---|
| D1 | One editor replaces the four-step wizard everywhere (new request, draft, edit of a published request). `RequestWizard.tsx` is deleted at the end of the push; its helpers move. | Two editors = duplication risk; the v1 wizard cannot edit a multi-part request (`planModelWrite` answers `REQUEST_MODEL_V3`, `worker/routes/printRequests.ts:1310-1313`). The v3 read of a v1 row is synthesised (`readRequestModel`, `worker/lib/requestModel.ts:1109`), so one editor reads both. |
| D2 | One page, not steps: sources → description → what to print (parts) → delivery and budget → a review sheet with «ما يراه الآخرون» and the publish button. | `17.non-exclusive-sources`: today «ماذا لديك؟» is an exclusive radio (`RequestWizard.tsx:709-741`); v3 derives `source_type` on the server (`readModelInput`, `requestModel.ts:1966-1973`), so the editor never sends it. |
| D3 | The server draft is the source of truth; it is born on the first durable act (first file, link, text reference, explicit save, or an entry from a project/product/store) through a new create door that accepts an empty title. The address becomes `/requests/new/:id` at once (history replace), so reload resumes. | Acceptance 14 «survives going back or losing the connection» needs a server id before any upload; the old create door requires title ≥ 4 and description ≥ 10 (`worker/routes/marketplace.ts:768-769`). |
| D4 | Autosave is throttled (≥ 30 s apart, plus flush on section change, before upload, before review, on `pagehide`/`visibilitychange`), explicit «احفظ» always saves; unsaved text lives in a per-tab `sessionStorage` mirror until the server has it. | Draft PUT is rate-limited 120/h (`printRequests.ts:1653`); 30 s spacing keeps an hour-long session under it. |
| D5 | A stale tab cannot overwrite a newer draft: PUT draft accepts optional `expected_updated_at` → 409 `DRAFT_CHANGED` (old clients unchanged). | Two tabs or two devices on one draft. |
| D6 | Project handoff copies bytes into new private objects, one new `file_objects` row each carrying the post file sha256 (verified while streaming), and one `community_request_sources` row of kind `project_post` with `origin_id = post_id`, `origin_ref = post file id`, `origin_hash = sha256`. Nothing points at the post afterwards. | Conflict 5; row 266 (١) «النسخة من منشور … ملفّ الطلب نفسه دائماً و`origin_*` أثرٌ لا يُتبع لقراءة بايت». |
| D7 | «اطلب طباعته» on a product page makes a DIRECT draft to the product's own store (link source to the product page + a copy of its cover picture). Shown only on a store product page whose product carries a model file and whose store takes custom requests. | The design is the store's (licence, `17.links-reference-only`); it is path A of `17.path-a-template-customisation`; the store's paid files are never copied. |
| D8 | «لهذا المتجر فقط» from the store page makes a DIRECT draft (visibility `direct`, `target_merchant_id`, `origin_chat_id` = the store thread). It is sent with the existing chat send door (`worker/routes/chatCommerce.ts:196-245`); the board publish door refuses a direct request (`REQUEST_IS_DIRECT`). | Only the send door writes the card into the conversation in the same batch; a direct request published through `publishRequest` would open with nobody told (the matcher skips `visibility <> 'public'`, `worker/lib/printMatchingStore.ts:669`). |
| D9 | Q2 is applied on every budget reader with one helper (`worker/lib/requestBudget.ts`); stored bytes (revision snapshots, order snapshots, chat cards) are never rewritten — they are projected at read. | Row 266 (٧): «تطبيقه على قرّاء الميزانية … يُشحن مع المفتاح في P1-06 — وعندها تختفي الميزانية عن كل طلب قائم، وهذا مقصود». |
| D10 | The «ما يراه الآخرون» panel is computed from the contract registry `REQUEST_FIELD_VISIBILITY` (`packages/contracts/src/requestModel.ts:205-231`) plus a new file-class table mirroring `requestFilePolicy.ts:1-27`, and a test proves both against `projectModel` and `mayReadBytes`. | «driven from projectModel audiences». |
| D11 | Old addresses (`/requests?view=new`, `&link=`, `&project=`, router state `printLink`) stay working forever as aliases in `Requests.tsx` that replace-navigate to `/requests/new?…`. | Shared links and notifications already carry them (`PostCard.tsx:64`, `Project.tsx:296`, `LinkCard.tsx:60`, `Storefront.tsx:66`, `Community.tsx:72`, `Tools.tsx:566-567`). |

---

## 1. What this builds on (file:line)

**Model and read path (P1-04, row 266)**
- Contract vocabulary and limits: `packages/contracts/src/requestModel.ts:25` (source kinds), `:29` `CLIENT_SOURCE_KINDS` (client may create only file/link/text_ref), `:44-55` roles and `DEFAULT_SOURCE_ROLE` (project_post → production), `:66` colour modes, `:70-78` `REQUEST_PALETTE`, `:81` finishes, `:102-129` `REQUEST_MODEL_LIMITS` (12 parts, 4 materials/part, 16 colours/material, 4 links, 4 text refs, note 500, part name 80, part notes 1000, region 200, requirements 300), `:205-231` `REQUEST_FIELD_VISIBILITY`.
- V3 body reader: `isModelBody` `worker/lib/requestModel.ts:1519`; `readModelInput` `:1625-1990` (absent = carried; temp ids remapped `:1722-1739`; file sources by `file_id` `:1685-1700`; server copies carried, never re-pointed `:1720`; `SOURCE_ORIGINAL_PRIVATE` `:1952-1963`; derived `source_type` `:1966-1973`); stable ids `keepStableIds` `:1562`.
- Owner projection: `projectModel` `:910-947` (owner/admin get `sha256`, `origin_*`; merchant/public lose role-`source` files); `projectSpec` `:968-1009`.
- Writers: `planModelWrite` `worker/routes/printRequests.ts:1270-1331`; `budgetVisibleSet` `:1187-1191`; draft PUT `:1652-1709`; `draftShape` `:1721-1786` (already returns `model`, `budget_visible`, `schema_version`); publish `publishRequest` `:1390-1628`; `/quote` with a v3 body and `request_id` `:431-470` (answers per-part `coverage`).
- Repeat copies a request with re-copied R2 objects and a moved model: `:2392-2539`, `copyRequestModel` `:2553-2600` (pattern for the handoff copy).

**Readers and offers (P1-05, row 267)**
- Coverage shape: `worker/lib/printEstimate/contract.ts:170-209` (`priced_parts`, `unpriced_parts` with `reason` or `refusal`).
- Publish-only refusals `PART_PROCESS_MIXED`, `PART_RESIN_MULTI_MATERIAL`, `PART_MATERIAL_UNKNOWN` with `{part_id, position}`: `printRequests.ts:1314-1328`; words already in `src/lib/refusalStrings.ts:636` and the part-naming prefix `:2530`.
- Part labels in the reader language: `src/components/community/requests/offerParts.ts:28` (`partName`), `:83-91` (`askedRowLine`, `partMaterialsLine`); `strings.ts:131/500/858` (`partN` «القطعة {n}» / "Part {n}" / «پارچەی {n}»); `strings.ts:109-116` (`reviewChip`, `reviewReasons`, `reviewNote`); `estimateCoverageLine` `strings.ts:1130`.
- Mirrors: `src/components/community/requests/mirrors.ts` (`REQUEST_COLOURS`, `localMaterial`, `localColour`, `jobCountWords`, `entryColour`).

**Files and uploads**
- One limits table: `packages/contracts/src/requestFiles.ts:46-57` (6 files; image 25 MiB, model 300 MiB, document 25 MiB).
- Client checks: `src/components/community/requests/fileRefusals.ts:99` (`requestFileProblemText`), `:127` (`requestFileCheck`), `:148-173` (`requestFilesCheck`), `:176` (`requestUploadRefusal`).
- Doors: whole-body `POST /api/marketplace/requests/:id/files`; session `worker/routes/uploadSessions.ts:618-760` (ledger row with sha256 `:671-683`, `insertRequestFile` in the same batch `:708`); `insertRequestFile` `worker/lib/requestFileHooks.ts:235-262` (guarded, revises a published job); `afterRequestFileAdded` `:353-362`; room check `worker/lib/requestFileRoom.ts:56`.
- Client session upload: `src/lib/uploadSession.ts:59` (`pickRequestUpload`), `:73` (`resumeKey`), `:349` (`uploadLarge`, resumable, `UPLOAD_KEEP_SESSION`); `src/components/upload/UploadTile.tsx` (ring, checksum step, cancel, retry); `src/components/media/RequestAttachments.tsx:83-103` (`uploadRequestFiles`).
- Pictures as pictures: `src/components/community/requests/RequestFileThumbs.tsx` (`requestImageSrc`, `?w=`); widths `packages/contracts/src/imageSizing.ts:30`.
- File policy matrix: `worker/lib/requestFilePolicy.ts:1-27`, `mayReadBytes` `:59-64`, `previewGrantFor` `:67-71`.

**Today's screens**
- Wizard: `src/components/community/requests/RequestWizard.tsx` (draft created after step 1 `:478-531`; exclusive source radio `:709-741`; budget hint «يراها التجار» `:1069`; save `:595-609`; publish `:611-637`).
- Board page: `src/pages/Requests.tsx` (link carried `:111-114`, view state `:123-129`, wizard mount `:243-254`).
- Request page: `src/pages/community/Request.tsx` (in-place wizard `:214-229`, «تعديل»/«أكمل المسودة» `:621-622`, `:703-704`, draft publish with an empty body `:456-469`, «اطلب مثله» `:242`).
- Routes: `src/App.tsx:319` (lazy request page), `:1075-1076` (`/requests`, `/requests/:id` inside `CommunityGate`), `ProtectedRoute` keeps `pathname + search` `:548-556`.
- Entry doors: `src/pages/community/Project.tsx:288-305`, `src/components/community/feed/PostCard.tsx:64-65`, `src/components/community/links/LinkCard.tsx:59-61`, `src/pages/Storefront.tsx:66,318,517-550`, `src/components/storefront/blocks/CustomRequestCta.tsx:20,37`, `src/pages/StorefrontProduct.tsx:88,147,410-412`.

**Direct requests**
- `worker/lib/directRequests.ts` (`directRequest`, `assertDirectStanding`, `assertMayQuote`); chat draft `worker/routes/chatCommerce.ts:159-189`, chat send `:196-245`; store thread `worker/routes/chats.ts:375-410` (`openStoreThread`), E12 `customerKnowsMerchant` `:422-438`, the merchant-id branch of `/open` `:603-640`; database promises `migrations/0151_*.sql` (direct names its store; visibility and target locked; offers only by the target).

**Posts and products**
- `worker/routes/communityPosts.ts:377-387` (`mayRead`), `:427-447` (`postFiles`, `downloadable`), `:452-470` (`GET /posts/:id` with block check), `:1068-1080` (download door: `mine || downloadable`); table `migrations/0157_product_and_post_files.sql:59-75`; `file_objects.sha256` `migrations/0156_asset_platform.sql:47`.
- `worker/routes/productFiles.ts:311-346` (`visibleProduct`: sanction, hidden store, lifecycle, private audience); `community_products.images` `migrations/0001_init.sql:266`.

**Gate**
- `worker/lib/communityGate.ts:109-114` (`communityMayEnter`: open, admin door, allow-list), `:233-237` (`requireCommunityOpen`); client `CommunityGate` around `/requests*` (`src/App.tsx:1075-1076`). Q1: the owner (admin door) runs Scenario D on live while the gate stays closed.

---

## 2. Routes and components

### 2.1 Client routes (`src/App.tsx`)

```
/requests/new           → RequestEditorPage (new; entry from ?project= | ?product=&store= | ?store= | ?link=)
/requests/new/:id       → RequestEditorPage (resume a draft, or edit a published request)
/requests               → Requests (board, «طلباتي», «تنفيذ طلباتي»; aliases ?view=new… to /requests/new?…)
/requests/:id           → request page (unchanged route; «تعديل» now navigates to /requests/new/:id)
```

- Both new routes: `<ProtectedRoute><CommunityGate closedExtra={<RunningCommunityOrders />}><RequestEditorPage/></CommunityGate></ProtectedRoute>`, declared before `/requests/:id` (React Router ranks the static `new` first anyway; declaring it first documents it).
- `const RequestEditorPage = React.lazy(() => import('./pages/community/RequestEditor'))` → its own chunk `RequestEditor-*`. Nothing of it is imported by `Requests.tsx`, the storefront, `Product.tsx` or the entry.

### 2.2 Client files

```
src/pages/community/RequestEditor.tsx            route page: params, entry creation, load, not-editable notice
src/components/community/requests/editor/
  RequestEditor.tsx        the page body: five sections, action bar, review sheet
  state.ts                 types, reducer, hydrate(draft) → state, editorBody(state) → V3Body, dirty(), tmp ids (pure)
  persistence.ts           useDraftPersistence: create-on-demand, throttled autosave, flush points, explicit save,
                           DRAFT_CHANGED handling, leave guard, keepalive flush on pagehide
  sessionMirror.ts         per-tab mirror of unsaved text (pure, try/catch around storage)
  uploads.ts               upload queue (2 at a time), per-file state machine, retry/cancel, door choice
  SourcesArea.tsx          add controls, limits line, partial-success summary, the grid and the rows
  SourceRow.tsx            one model / document / link / written reference / project copy
  SourceThumb.tsx          WizardFileThumb successor + previewUrl/releasePreviews (moved from RequestWizard)
  ImageGrid.tsx            the pictures grid (stored + pending), tile menu
  ImageViewer.tsx          in-page viewer (Overlay), prev/next, keys, swipe, double-tap zoom
  PartsEditor.tsx          single-job form ↔ list of part cards; job quantity/sets and quality
  PartCard.tsx             one part
  MaterialRow.tsx          one material row of a part (material, colours, finish, region, requirements)
  MaterialPicker.tsx       searchable sheet
  ColourPicker.tsx         searchable sheet: «أي لون مناسب», «كما في المرجع», palette, custom
  search.ts                normaliseForSearch(ar/ckb/en) (pure)
  DeliveryFields.tsx       governorate, handover, deadline, notes for merchants
  BudgetField.tsx          budget + the Q2 switch
  audience.ts              audienceRows(state, opts) from the contract registries (pure)
  AudiencePanel.tsx        «ما يراه الآخرون»
  ReviewSheet.tsx          review + estimate + panel + publish/send/save changes
  ActionBar.tsx            save status + «احفظ» + primary; keyboard-aware
  useKeyboardOpen.ts       visualViewport-based keyboard detection
  strings.ts               EDITOR_STRINGS { ar, en, ckb } (typeof ar), fill()
src/components/community/requests/api.ts         + V3Body types, editorApi (createEntry, copyFromProject, saveDraft with
                                                   expected_updated_at, quote v3, publish v3, sendDirect)
```

Deleted at the end: `src/components/community/requests/RequestWizard.tsx` (see §13.4 for the tests re-pointed).

### 2.3 Server files (no migration)

```
worker/routes/requestEntries.ts   NEW router, mounted app.route('/api/marketplace/print', requestEntryRoutes) right after
                                  printRequestRoutes (worker/index.ts:685): POST /requests, POST /requests/:id/copy-from-project
worker/lib/requestHandoff.ts      NEW: copyIntoRequest (stream + DigestStream sha256 + ledger + guarded insert + source row),
                                  projectCopyPlan, productCoverPlan, replayEntry
worker/lib/requestBudget.ts       NEW: budgetFor, budgetReaderOf, stripSpecBudget, BUDGET_VISIBLE_SQL
worker/lib/productVisibility.ts   NEW: visibleStoreProduct(db, viewer, slug, productId, opts) — the body of
                                  productFiles.ts visibleProduct moved out, no behaviour change
worker/lib/directRequests.ts      + assertStoreTakesDirect, directDraftStatement (extracted from chatCommerce.ts:159-189,
                                  no behaviour change)
worker/routes/printRequests.ts    draftShape (+updated_at, +direct, +files[].origin), PUT draft expected_updated_at,
                                  publishRequest (REQUEST_IS_DIRECT, REQUEST_TITLE_REQUIRED, REQUEST_DESCRIPTION_REQUIRED),
                                  notification budget per Q2, /revisions budget per Q2
worker/routes/marketplace.ts      publicRequest/partyRequest budget per Q2; board/request reads; publicSnapshot per reader
worker/routes/community.ts        community list budget per Q2 (through publicRequest)
worker/routes/merchantWorkshop.ts workshop board budget per Q2
worker/lib/chatCards.ts           print_request card budget per Q2 (write and read)
worker/lib/publicApi/resources/community.ts  budget always null (public audience) + schema text
worker/routes/chatCommerce.ts     uses the extracted directDraftStatement (no behaviour change)
worker/routes/productFiles.ts     uses visibleStoreProduct (no behaviour change)
packages/contracts/src/requestModel.ts  + REQUEST_FILE_VISIBILITY (file class × audience, mirrors requestFilePolicy)
src/lib/refusalStrings.ts         + REQUEST_TITLE_REQUIRED, REQUEST_DESCRIPTION_REQUIRED, REQUEST_IS_DIRECT, DRAFT_CHANGED,
                                  ENTRY_NOT_FOUND, COPY_CHANGED (ar/en/ckb)
```

---

## 3. State, draft persistence (save, resume, reload)

### 3.1 State (`editor/state.ts`)

```ts
type Key = string;                        // stable client key: server id, or `tmp_<kind>_<n>`
interface EditorSource {
  key: Key; id: string | null;            // rps_… once the server has it
  kind: 'file' | 'link' | 'text_ref' | 'studio_revision' | 'project_post';
  fileId: string | null;                  // stored file row (file kinds)
  upload: UploadRow | null;               // a device file still on its way (file kinds only)
  url: string; canonical: string; provider: string;   // link
  refText: string;                        // text_ref
  note: string; primary: boolean; original: boolean;  // original ⇔ role 'source'
  origin: { kind: 'project' | 'product'; title: string } | null;   // owner-only display, from origin_*
}
interface EditorColour { mode: 'any' | 'as_reference' | 'catalogue' | 'custom'; hex: string; label: string; ref: Key | '' }
interface EditorMaterial { key: Key; id: string | null; materialId: string | 'unsure'; colours: EditorColour[];
  finish: '' | 'sanded' | 'primed' | 'painted' | 'polished'; region: string; requirements: string }
interface EditorPart { key: Key; id: string | null; name: string; perSet: number;
  process: 'fdm' | 'resin' | 'unsure'; dims: { x: number|null; y: number|null; z: number|null };
  measuredFileId: string | null; sourceKeys: Key[]; notes: string; assembly: string;
  materials: EditorMaterial[]; reviewState: string; reviewReasons: string[] }       // review read-only, from the server
interface EditorState {
  requestId: string; requestState: string; updatedAt: string; liveOffers: number;
  direct: null | { merchantId: string; storeName: string; storeSlug: string; chatId: string };
  title: string; description: string; notes: string;            // notes = customer_notes
  sets: number; quality: 'draft' | 'standard' | 'fine' | 'ultra';
  sources: EditorSource[]; parts: EditorPart[];
  governorate: string; handover: '' | 'delivery' | 'pickup'; deadline: string;
  budget: number | null; budgetVisible: boolean;
}
```

- `hydrate(draft: DraftShape, catalogue)` builds the state from `draft.model` (owner projection; `printRequests.ts:1756`) joined to `draft.files` by `file_id`. A v1 request hydrates from its synthesised model (origin `synthesized`), so the editor needs no v1 branch.
- `editorBody(state): V3Body` (pure):
  - `schema_version: 3`; `customer_notes`; `quantity: sets`; `quality`; `governorate`, `delivery_pref`, `deadline`, `budget_iqd`, `budget_visible`;
  - `title` only when 4–140 characters and `description` only when ≥ 10 (the PUT validates them when present, `printRequests.ts:1671-1672`; a short title stays in the session mirror until valid);
  - `sources`: stored files `{id?, kind, file_id, note, is_primary, role}` (role `'source'` or `''`); links `{id|tmp, kind:'link', url, note, is_primary}`; written references `{id|tmp, kind:'text_ref', ref_text, note, is_primary}`; server copies `{id, kind:'project_post'|'studio_revision', note, is_primary, role}`; device files not yet stored are absent;
  - `parts`: `{id?, name, quantity: perSet, process, stated_dimensions_mm, measured_file_id, notes, assembly_notes, source_ids, materials:[{id?, material_id | 'unsure', colors, finish, region_reference, requirements}]}`; `source_ids` and colour `ref` use the source key, which is either the server id or the tmp id the same body gives the source (the server remaps, `requestModel.ts:1722-1749`);
  - never `source_type` (the server derives it; sending it would arm the v1 «SOURCE_*_REQUIRED» checks, `requestModel.ts:1975-1988`).
- `dirty(state, baseline)` = `JSON.stringify(editorBody(state)) !== baseline` plus any device upload rows; `baseline` is the body of the last successful save or load.
- Ids are echoed so P1-05 offer coverage and substitutions keep naming the same part and material rows (row 266 (٦), row 267 (٥)).

### 3.2 When the draft is born

| Entry | When the draft is created |
|---|---|
| `/requests/new` blank | On the first durable act: a file picked, a link added, a written reference added, «احفظ», or the first autosave of a non-empty form. Typing alone with nothing else for 30 s counts (autosave). Leaving an untouched blank page creates nothing. |
| `?link=` (Tools, link cards) | Blank, with the add-link box pre-filled and checked on arrival (as `RequestWizard.tsx:452-461`); the add creates the draft. |
| `?project=` | On mount: `POST /api/marketplace/print/requests {entry:{kind:'project', post_id}}`; the page shows «نجهّز طلبك…» then «ننسخ ملفات المشروع…». |
| `?product=&store=` | On mount: `{entry:{kind:'product', product_id, store}}`. |
| `?store=` | On mount: `{entry:{kind:'store', merchant_id}}`. |
| `/requests/new/:id` | Exists; `GET …/draft`. |

After any creation: `navigate('/requests/new/' + id, { replace: true })`. Double-tap and reload-before-replace are covered by the server replay (§10.1).

### 3.3 Saving

- **Autosave**: after a change, wait until the form is idle 2 s, and never within 30 s of the previous autosave; one request in flight, changes made during it coalesce into the next. Flush (bypassing the 30 s spacing but not the in-flight rule) at: leaving a section (focus leaves a `<section>`), before any upload starts (so the server has the request fields the upload door revises), before opening the review sheet, before publish/send, on `visibilitychange → hidden` and `pagehide` (`fetch(..., { keepalive: true })`, body ≤ 64 KB — a body is a few KB).
- **Explicit «احفظ»**: always saves now; toast «حُفظت المسودة. لا يراها أحد غيرك.» on a draft; on a published request the button is not shown — its save is «احفظ التعديلات» in the review (the publish door, which revises honestly; `printRequests.ts:1455-1460`).
- **Status** (in the action bar, `aria-live="polite"`): «محفوظ» · «يُحفظ…» · «تغييرات لم تُحفظ» · «لم يُحفظ — أعد المحاولة» (a button) · «لا اتصال — نحفظ حين يعود» (`navigator.onLine` false; retried on `online`).
- **Conflict**: every PUT carries `expected_updated_at` (the last `updated_at` seen). A 409 `DRAFT_CHANGED` shows a banner «تغيّرت المسودة في نافذة أخرى» with «حمّل الأحدث» (re-hydrate, drop local edits after confirm) and «احفظ نسختي» (re-send without `expected_updated_at`).
- **Refusals** from a save (a v3 code such as `LINK_DUPLICATE`, `COLOURS_TOO_MANY`, `SOURCE_ORIGINAL_PRIVATE`) are shown next to the control they name (`details.part_id`/`position` when present, else under the section), from `apiRefusal`.
- **Leave guard**: while dirty and not yet saved, `setLeaveGuard` (`src/lib/leaveGuard.ts`) and `beforeunload`; an in-app back first flushes, and only asks when the flush failed.

### 3.4 Resume and reload

- `GET /api/marketplace/print/requests/:id/draft` (owner only, 404 otherwise; `printRequests.ts:1788-1793`) → `hydrate`.
- **Session mirror** (`sessionStorage`, key `levonis.request-editor.<requestId>`): `{v:1, base_updated_at, fields:{title, description, notes, …only text fields}}` written on every keystroke batch (300 ms), cleared on a successful save. On load: if `base_updated_at === draft.updated_at`, the mirrored text fields are re-applied and marked dirty (the next autosave sends them). Every storage access in try/catch; an unavailable storage only loses the mirror. Cleared on identity change with the other private drafts (`src/AuthContext.tsx:50` beside `privateDrafts.clear()`).
- **Uploads cut by a reload**: the browser cannot keep a `File`; the resume records of `uploadSession.ts` (key `levonis.upload.request:<id>:…`) are listed as «رفع «{name}» لم يكتمل — اختر الملف نفسه مرة أخرى ليُستأنف من حيث توقف.» (the same rule as `RequestWizard.tsx:182-204`, moved); picking the same file resumes from the parts the server holds.
- **State gate**: `draft` → editor; `open` / `receiving_offers` → editor in edit mode (title and description read-only, as today); any other state → «هذا الطلب لم يعد قابلًا للتعديل.» with «افتح الطلب».
- A DIRECT draft whose store stopped taking work still opens (the customer may still read and delete it); the send refusal says why (`MERCHANT_UNAVAILABLE`, `STORE_NO_CUSTOM_REQUESTS`).

---

## 4. The sources area (one unified area)

Section «ما لديك» — every way to describe the job, together (no exclusive choice):

```
[ أضف ملفات ]  [ التقط صورة ]*  [ أضف رابطًا ]  [ أضف وصفًا مرجعيًا ]       *touch devices only
مجسمات (STL، 3MF، OBJ، STEP…)، صور، أو PDF — حتى 6 ملفات.
┌ الصور ───────────────────────────── grid (§5) ┐
└ الملفات والروابط ─────────────────── rows ─────┘
رُفع 3 من 4 — 1 لم يُرفع                     (aria-live summary, only when something failed or is working)
```

### 4.1 One row per source

Row anatomy (models, PDFs, links, written references, project copies; pictures use the grid tile, §5):

| Part of the row | Content |
|---|---|
| Lead square | `SourceThumb`: model glyph / document glyph / link card thumbnail (`SourceLinkCard` compact) / text glyph. Never an id (acceptance 13). |
| Name | file name (`dir="ltr"`, truncated), link host + title from the card, first line of the reference. |
| State chip | see §4.3; measured dims «82×64×41 ملم», «يُقاس لاحقًا», or the upload state. |
| Badges | «الرئيسي» (primary), «الأصل — للتاجر المقبول فقط» (original), «نسخة من مشروع» / «من منتج» with the title (owner-only provenance). |
| Actions | «اجعله المصدر الرئيسي» (radio semantics across all sources), «أضف ملاحظة»/the note, «هذا هو الأصل القابل للتعديل» (files of kind model/document, project copies), «احذف». Behind a «⋯» menu on phones (44 px target), inline from 640 px. 3D: models with a preview get «عرض ثلاثي الأبعاد», which navigates to the existing viewer route (`POST …/files/:fileId/viewer-token` → `/model-viewer/<token>`); no 3D code in the editor (BASE 6). |

- **Per-source note**: collapsed «أضف ملاحظة»; a `Textarea` (≤ `sourceNoteMax` 500, counter) with hint «يراها كل من يرى الطلب. لا تكتب رقم هاتفك.» (registry `sources.note: public`).
- **Primary**: exactly one or none; default when none chosen: the first stored model, else the first link, else the first picture. The toggle is disabled on an original with the reason «الأصل لا يكون المصدر الرئيسي» (server `SOURCE_ORIGINAL_PRIVATE`, `requestModel.ts:1952-1963`). Turning a primary into an original clears the primary.
- **Original** (role `source`, Q5): checkbox on file rows; when a part is measured from that file the checkbox explains it cannot be both (same code). Link and written reference rows never show it (`SOURCE_ROLE_INVALID`).
- **Remove**: a stored file is deleted at once (`DELETE /api/marketplace/requests/:id/files/:fid`) after a confirm; on a published request with live offers the confirm says the offers will need re-confirming (today's words `RequestWizard.tsx:557-564`). A link or reference is removed from the state (saved with the next save). Removing a source also removes it from parts' `sourceKeys` and turns colour refs to it into «المراجع عمومًا».

### 4.2 Adding

- **Files** (one picker for models, pictures, PDFs; `accept` from `requestFileAccept()`), and «التقط صورة» (`capture="environment"`, touch only). Every picked file is asked the contract table before a byte is sent (`requestFileProblem` per file, `fileRefusals.ts`): an accepted one becomes an upload row; a refused one becomes a **rejected row** with its own sentence (`requestFileProblemText`), which never counts towards the 6 and has only «إخفاء».
- On a **published** request with live offers, adding files first asks «إضافة ملف إلى طلب منشور؟ العروض القائمة ({n}) تتوقف حتى يؤكدها أصحابها، ويُبلَّغون بذلك.» (the doors revise at once, `requestFileHooks.ts:235-262`).
- **Link**: an input (https) + «أضف»; `POST /print/link` (as `RequestWizard.tsx:433-450`), canonical URL, `warmLink` for the card; refusals inline: `BAD_URL` «هذا لا يبدو رابطًا صالحًا (https).», `LINK_DUPLICATE`, `LINKS_TOO_MANY` (4). The hint says a link is a reference only (`17.links-reference-only`).
- **Written reference**: a textarea ≤ 500 («مثال: نفس مقاس الغطاء الأصلي، قطره 62 ملم»); empty is not a source (server drops it, `requestModel.ts:1714-1716`); `TEXT_REFS_TOO_MANY` (4).
- Limits line under the buttons: «{n} من 6 ملفات · {l} من 4 روابط»; at 6 files the file button is disabled with «اكتمل العدد (6 ملفات). احذف ملفًا لتضيف غيره.».

### 4.3 Upload state machine (`editor/uploads.ts`) — partial success, retry, cancel, explained rejection

```
rejected (client check; never sent)            → «لن يُرفع: {reason}»            [إخفاء]
queued                                          → «في الانتظار»                   [إلغاء]
checking (hashing, session door)                → «يُفحص الملف… 40%»              [إلغاء]
uploading {loaded,total,part,parts}             → ring + «3.1 م.ب من 12 م.ب · الجزء 2 من 4»   [إلغاء]
finishing                                       → «يُنهي الرفع…»
measuring (models)                              → «يُقاس…»
done → the row becomes a stored source (thumbnail from the authorised route, `?w=`)
failed {code, text, retryable}                  → «لم يُرفع: {reason}»            [أعد المحاولة] [إلغاء]
cancelled                                       → removed from the list (the session is deleted)
```

- **Door**: `pickRequestUpload(file)` (`uploadSession.ts:59`): a model or anything above 8 MiB → resumable session (`uploadLarge(file, 'request', {entityId})`), else the whole-body door. Both answer `{file:{id,url,inline,…}}` (row 265 (٢)).
- **Concurrency**: two at a time; the rest queued. Each file is independent: one failure never stops the others (**partial success**). The summary line appears while anything is working or failed: «رُفع {ok} من {all} — {failed} لم يُرفع».
- **Retry** re-runs the same `File` with the same `entityId`, so `uploadLarge` finds the same resume record (`resumeKey`) and the server session continues from the parts it holds — no second session, no second file row (acceptance 13 «retrying a failed upload creates no needless copies»; the server half is already `tests/requestFileHardening.test.ts` «a retried part reuses the same file row»). A whole-body retry is a new POST of a file that never landed.
- **Cancel** aborts (`AbortController`, the tile's rule `UploadTile.tsx`: unmount keeps the session, «إلغاء» deletes it).
- **Explained rejection** has three sources, each worded: the client table (kind, size, count — `FORMAT_CAPABILITIES` words), the server refusal of a door (`requestUploadRefusal`: `UPLOAD_KIND_NOT_ALLOWED`, `UPLOAD_TOO_LARGE`, `REQUEST_FILES_FULL`, `CHECKSUM_MISMATCH`, `REQUEST_NOT_EDITABLE`), and a handoff copy that was skipped (§9.1: «لم يُنسخ «{name}»: {reason}» with «أعد المحاولة» calling the copy route).
- **Previews**: a picture is drawn from its `blob:` URL from the moment it is picked (`previewUrl`), revoked when it is removed, when it is stored, or when the editor unmounts (`releasePreviews`, moved from `RequestWizard.tsx:135-149`).
- **Measuring**: after a model is stored, `POST …/files/:fid/analyze` (as `RequestWizard.tsx:513-527`); `measure: 'later'` shows «يُقاس لاحقًا» and its hint.
- **Publish waits**: the primary button is disabled while any row is queued/checking/uploading/finishing with the reason «انتظر حتى يكتمل الرفع ({n})». Failed rows ask «ملفات لم تُرفع … هل تنشر بدونها؟» before publishing.
- A save never waits for uploads (the body names stored files only).

---

## 5. The image grid and the in-page viewer

### 5.1 Grid (`ImageGrid.tsx`)

- Pictures of the request (stored `inline` files and pending picture uploads) in order of arrival. `role="list"`; each tile is a `<button>` with `aria-label` «افتح الصورة {n} من {total}: {name}».
- Columns: 3 at 360 px (tile ≈ 104 px), 4 from 480 px, 6 from 768 px; `aspect-square`, `object-cover`, 8 px gap; no horizontal scroll.
- Stored tile: `requestImageSrc(url, 320)` + `requestImageSrcSet(url)` with `sizes` matching the column width (`RequestFileThumbs.tsx`); `data-editor-thumb="stored"`. Pending tile: the `blob:` URL; `data-editor-thumb="pending"`; an overlay ring for its upload state; failed overlay with «أعد المحاولة»/«إلغاء» buttons (each ≥ 44 px).
- Badges on the tile: «الرئيسي» star, note dot (has a note). The «⋯» button (top end corner, 44 px) opens the same actions as a row (primary, note, remove).
- Images are never measured; they can be a colour reference («كما في المرجع»).

### 5.2 Viewer (`ImageViewer.tsx`)

- `Overlay` (`src/components/ui/Overlay.tsx:357`) modal, full height of the visual viewport, dark scrim, `label` «عارض الصور», focus trapped, Escape closes, focus returns to the tile that opened it.
- Picture: stored → `requestImageSrc(url, 1280)` with `srcSet` up to 1600 (`IMAGE_VARIANT_WIDTHS`, `imageSizing.ts:30`; the route accepts these widths, `marketplace.ts:668`); pending → its `blob:` URL. `alt` = file name.
- Navigation: «الصورة السابقة»/«الصورة التالية» buttons (icons mirrored by reading direction: in RTL «التالية» points left), keys ArrowLeft/ArrowRight mapped by `dir` (ArrowLeft = next in RTL), Home/End, swipe with pointer events (threshold 48 px; reduced motion = no slide animation), position «{n} / {total}» (`aria-live="polite"`).
- Zoom: double-tap/double-click toggles 2×, `touch-action: pinch-zoom` on the picture container, «تكبير»/«تصغير» buttons for keyboards.
- Panel under the picture: name, the note field (same component as the row), «اجعلها المصدر الرئيسي», «احذف».
- Landscape (740×360): the picture fits the height; the panel collapses to one line with a «⋯».
- No library: CSS transforms only; the editor chunk carries it.

---

## 6. The parts editor and the pickers

### 6.1 Single job ↔ parts

- **One part** (the default, and every v1 request): the part card has no header; it reads as «ماذا نطبع»: material row(s), quality, «الكمية», size (measured from a model or typed), notes. Button «أضف قطعة أخرى» (hint «لقطعة من عدة أجزاء بمواد أو ألوان مختلفة.») turns it into the list.
- **Several parts**: a list of cards, each titled with its name or «القطعة {n}» (`strings.ts` `partN`, the label every refusal and offer screen already uses, `refusalStrings.ts:2530`). Job-level fields above the list: «عدد الأطقم» (sets = the request quantity, row 266 (١)), «الدقة» (job quality). The header line uses `jobCountWords` (`mirrors.ts`): «عدد الأجزاء 2 · القطع في الطقم 3».
- Card fields:
  - «اسم القطعة» (≤ 80, optional, placeholder «القطعة {n}»);
  - «كم نسخة منها في الطقم» (1–1000; `quantity` = pieces per set);
  - «طريقة الطباعة»: FDM / ريزن / لست متأكدًا (`Segmented`); a chosen material decides the process (server rule `requestModel.ts:1909-1914`), and the segment follows it;
  - materials: 1–4 `MaterialRow`s; «أضف مادة لهذه القطعة» with the hint that several materials in one part need a multi-material printer and a technical review;
  - size: «يُقاس من» select (the request's stored model files, «بلا ملف — سأكتب المقاس») → measured dims, else three `NumberInput`s (1–5000 mm);
  - «المراجع لهذه القطعة»: chips of the request's sources (multi-select);
  - «ملاحظات القطعة» (≤ 1000), «كيف تُركَّب» (≤ 1000);
  - actions: «انقلها للأعلى»/«انقلها للأسفل» (buttons, keyboard reachable — no drag-only reorder), «كرّرها», «احذف القطعة» (confirm when it has content).
- At 12 parts the add button is disabled: «يمكن أن يضم الطلب 12 قطعة على الأكثر.».
- Review state per part: after each save the draft answer carries `review_state`/`review_reasons` per part (computed by the server, `reviewReasonsFor`, `requestModel.ts:263`); the card shows `reviewChip` «تحتاج مراجعة فنية» with the reasons (`strings.ts:111-115`). The client never computes a review.
- **Per-part estimate**: once the draft exists, `/quote` with the v3 body and `request_id` (debounced 800 ms after the last change, `printRequests.ts:445-470`) returns `coverage`; each card shows «≈ {low}–{high}» for a priced part, or «بلا تقدير: {reason}» for an unpriced one — `NO_GEOMETRY` «لا مجسم مقيس — يسعّرها التاجر», `MATERIAL_UNKNOWN` «اختر مادة ليُقدَّر سعرها», a publish refusal code through `apiRefusal` (e.g. «القطعة 2: …»). So a part the publish would refuse is visible before the publish.

### 6.2 Material row (`MaterialRow.tsx`)

- Material button (shows «لست متأكدًا» or the name + process tag) → `MaterialPicker`.
- Colours: chips of the chosen colours (each removable, `aria-label` «احذف {colour}») + «أضف لونًا» → `ColourPicker`. Display through `entryColour` (`mirrors.ts`).
- «التشطيب»: as printed / sanded / primed / painted / polished (`REQUEST_FINISHES`).
- With ≥ 2 materials in the part: «أي جزء منها بهذه المادة؟» (`region_reference` ≤ 200).
- «متطلبات خاصة» (≤ 300), collapsed by default.
- «احذف هذه المادة» (not on the last row).

### 6.3 Material picker (`MaterialPicker.tsx`)

- `Sheet` (detents medium/large, drag handle) titled «اختر المادة»; search input first (`type="search"`, `enterKeyHint="search"`); process chips «الكل» / «خيوط FDM» / «ريزن», pre-set from the part's process.
- List (`role="listbox"`, `aria-activedescendant`, ArrowUp/Down, Enter selects, Escape closes): first «لست متأكدًا — يقترح التاجر» (material_unsure); then the active catalogue (`GET /print/catalog`, `printRequests.ts:262`) with each item: the local name (`localMaterial`, which carries Sorani from the seed, `mirrors.ts`), the process tag, and traits from the catalogue flags («يحتاج طابعة مغلقة», «كاشطة — فوهة مقوّاة»). The selected one is checked.
- Search (`editor/search.ts`): matches the id, `name_en`, `name_ar` and the Sorani seed name; folds case, Arabic hamza forms (أ إ آ → ا), ى → ي, ة → ه, tatweel and diacritics, Sorani/Arabic letter pairs (ک/ك, ی/ي, ە/ه); a Latin query matches inside Arabic-script names that carry the Latin code (PLA, TPU). Empty result: «لا مادة بهذا الاسم» + «امسح البحث».
- A material outside the active catalogue on a stored part is shown by its name with a warning chip; publishing it answers `PART_MATERIAL_UNKNOWN` (already worded).

### 6.4 Colour picker (`ColourPicker.tsx`)

- `Sheet` «اختر الألوان», multi-select up to 16 per material (`COLOURS_TOO_MANY`), «تم» closes.
- Top two options:
  - «أي لون مناسب» (mode `any`) — exclusive: choosing it clears the named colours; choosing a named colour clears it;
  - «كما في المرجع» (mode `as_reference`) — can sit beside named colours (a part «أسود، كما في المرجع» is a P1-05 case, row 267 (6د)); a follow-up choice «كما في أي مرجع؟»: «المراجع عمومًا» (`ref: ''`) or one of the pictures/links/references (each shown with its thumbnail or name), stored as the source key.
- Search input over the palette names in the three languages and the hex; the palette grid: swatch + name (`REQUEST_COLOURS`, `mirrors.ts`), 44 px targets, the selected marked by a check and `aria-pressed`, never by colour alone.
- «لون آخر»: «اسم اللون» (≤ 60) + «اختر درجته (اختياري)» (native `<input type="color">`); stored as `custom` (or `catalogue` when the hex is a palette hex, server rule `requestModel.ts:1860-1868`).
- Hint when a material row has more than one named colour: «أكثر من لون في قطعة واحدة يحتاج طابعة متعددة الألوان — أو اجعلها قطعًا منفصلة.» (P1-05 eligibility never asks a multicolour machine for single-colour parts, row 267 (٤)).

### 6.5 Job and delivery (`DeliveryFields.tsx`)

The wizard's step 3 fields, unchanged in meaning: «المحافظة» (select; «لم أحدد»), «الاستلام» (توصيل / استلام بنفسي / أيهما), «أحتاجه قبل» (date, today to +366 days), «ملاحظات للتجار» (≤ 1000, with today's hint about the phone number). Quality is job-level.

---

## 7. «ما يراه الآخرون» and the budget switch

### 7.1 Registry-driven rows (`editor/audience.ts`)

Inputs: the contract `REQUEST_FIELD_VISIBILITY` (`requestModel.ts:205-231`) and a new contract table that mirrors the file matrix (`requestFilePolicy.ts:1-27`):

```ts
/** What each class of attachment gives each audience. Mirrors worker/lib/requestFilePolicy.ts mayReadBytes/previewGrantFor. */
export const REQUEST_FILE_VISIBILITY = {
  image:    { listing: 'public', bytes: 'merchants' },
  document: { listing: 'public', bytes: 'merchants' },
  model:    { listing: 'public', preview: 'merchants', bytes: 'accepted' },
  source:   { listing: 'public', bytes: 'accepted' },       // role 'source' of any class (Q5)
} as const;
```

`audienceRows(state, { direct, budgetVisible })` returns `[{ key, label, audience: 'public'|'merchants'|'accepted'|'owner', present }]`, only for what this request actually carries:

| Row (key) | Registry key | Audience |
|---|---|---|
| Title and description | `title`, `description` | public |
| Parts, materials and colours | `parts.*`, `parts.materials.*` | public |
| Quantity and sets | `quantity` | public |
| Governorate only — never the address | `governorate` | public |
| Deadline and handover | `deadline`, `delivery_pref` | public |
| Notes for merchants | `customer_notes` | public |
| Links, written references and their notes; which source is main | `sources.url`, `sources.ref_text`, `sources.note`, `sources.is_primary` | public |
| File names and kinds | `files.listing` | public |
| Pictures and PDF files | file `image`/`document` bytes | merchants |
| A simplified 3D preview of the models | file `model` preview | merchants |
| Your budget (switch on) | `budget_iqd:shown` | merchants |
| The model files themselves | file `model` bytes | accepted |
| The editable original | file `source` bytes, `sources.file:source` | accepted |
| Your name, phone and address | `customer_identity`, `address` | accepted |
| Your budget (switch off) | `budget_iqd` | owner |
| Where the files were copied from | `sources.origin_*`, `sources.sha256` | owner |

Groups: «يراه الجميع على لوحة الطلبات» (public) · «للتجار الذين يمكنهم صنعه فقط» (merchants) · «للتاجر الذي تقبل عرضه فقط» (accepted) · «لك وحدك» (owner). The task's three classes (public, merchants-only, private) map as: public; merchants-only = merchants + accepted (two sub-headings, because the original and the identity wait for acceptance); private = owner.

For a **direct** request nothing is on the board: the public group is headed «يراه هذا المتجر» and the merchants group «يراه هذا المتجر أيضًا» (the store is the only merchant; `isDirectMerchant`, `marketplace.ts:384-385`).

Placement: a collapsed summary card at the end of the page («ما يراه الآخرون» + one line «يراه الجميع: 6 · التجار: 3 · لك وحدك: 2», opens the panel); expanded by default in the review sheet (`17.public-private-preview`: «Before publishing, show what will become public and what stays private»).

Honesty: the model preview line says «معاينة مبسّطة» only; the stronger notice that a preview's geometry reaches the device is P1-12's copy (conflict 61) and is not written here twice.

### 7.2 Budget field (`BudgetField.tsx`)

- «ميزانيتك» (`NumberInput kind="money"`, optional) and below it a `Switch` (`src/components/ui/Switch.tsx`): «اعرض ميزانيتي للتجار» (direct: «اعرض ميزانيتي لهذا المتجر»), default **off** (Q2; `budget_visible` default 0, `migrations/0208…:132`).
- One line under the switch says what it means now: off «مخفية: لا يراها أحد غيرك.»; on «يراها التجار الذين يمكنهم صنع طلبك، ولا تظهر للعموم.»; direct on «يراها هذا المتجر وحده.».
- The switch is enabled even with an empty budget (the flag is stored; the panel shows the row only when a budget exists).
- Sent as `budget_visible` in every body; stored by both writers (`printRequests.ts:1488`, `:1689`), copied by «اطلب مرة أخرى» (`:2555-2558`).
- The old hint «يراها التجار» (`RequestWizard.tsx:1069`) goes with the wizard.

---

## 8. Review, publish, send, save changes

- The primary button opens the **review sheet** (`ReviewSheet.tsx`; pushes `?review=1` so Android Back closes it). Before opening: flush the save; validate title (4–140) and description (≥ 10) and focus the first invalid field (the server refuses the same on publish, §10.3).
- Sheet content, in order: the pictures (thumbnails `data-review-thumb`) and link cards; the parts (`partMaterialsLine`, `jobCountWords`, review chips); job facts (sets, quality, governorate, handover, deadline, notes); budget + switch state; the estimate (`/quote` v3: range, `estimateCoverageLine` «التقدير يشمل القطع المسعّرة فقط (k/n)», models not in the estimate); «ما يراه الآخرون» expanded; the privacy line (today's words `RequestWizard.tsx:1175-1179`); on an edit with live offers the warning (`:1164-1172`).
- Buttons:
  - board draft → «انشر» → `POST /print/requests/:id/publish` with the v3 body (`printRequests.ts:1631-1638`) → `forgetCommunityFeed('requests')` → `navigate(requestPath(id), { state: { published: true } })` (the request page's ChannelNudge, `Request.tsx:148-196`);
  - direct draft → «أرسل إلى {store}» → final PUT draft (v3 body) then `POST /api/chats/:chatId/print-requests/:rid/send` (`chatCommerce.ts:196`) → a sent screen «أُرسل طلبك إلى {store}» with «افتح المحادثة» and «افتح الطلب»;
  - published → «احفظ التعديلات» → the publish door (revises only what changed; `replayed` keeps pending offers, row 266 (٣)); with live offers, the confirm of `RequestWizard.tsx:613-624`;
  - «رجوع للتعديل».
- Publish refusals with a part (`PART_*`): the sheet closes and scrolls to that part card, which shows the sentence.
- The request page: «تعديل» and «أكمل المسودة» navigate to `/requests/new/:id` (no in-place wizard); the draft «انشر» button calls the same publish helper (a direct draft calls the chat send); «اطلب مثله» → `/requests/new`.

---

## 9. Entry points

### 9.1 Project handoff — copy by sha256 (acceptance 20 part, conflict 5)

Doors: `Project.tsx:296` and `PostCard.tsx:64` keep linking `/requests?view=new&project=<id>` (aliased) — or move to `/requests/new?project=<id>` directly (preferred; pinned tests do not pin these two strings).

`POST /api/marketplace/print/requests {entry:{kind:'project', post_id}}`:

1. Read the post as the GET does: `loadPost` + `mayRead(p, viewer, consentParty)` + `blockedEither` (`communityPosts.ts:377-387`, `:452-470`). Any failure → **404 `ENTRY_NOT_FOUND`** (one answer for missing, draft, private, hidden, blocked).
2. Files to copy: `community_post_files` of the post with `mine || downloadable = 1` (the download door's rule, `communityPosts.ts:1073`), in `position` order; plus the post's first picture (`community_post_media` kind image) as a `reference` picture when there is room. At most 6 (`REQUEST_FILE_LIMITS.maxFiles`); models first.
3. Create the draft (one batch): the request row (`state 'draft'`, `status 'closed'`, `visibility 'public'`, title = post title ≤ 140, description '', `expires_at = now + DRAFT_TTL_DAYS`, `budget_visible = 0`), its print row (empty spec: process and material unsure) and an empty v3 model (one part, material unsure, «أي لون»).
4. For each file, `copyIntoRequest` (`worker/lib/requestHandoff.ts`):
   - `getMediaObject(env, 'private', post_file.file_key)` (post files are private; post media public);
   - expected digest = `file_objects.sha256` of the post object (`0156:47`), when present;
   - stream the body into a new private object `requests/<customerId>/<newId>.<ext>` while hashing it (`body.tee()` → one branch to `putMediaObject`, one to `crypto.DigestStream('SHA-256')`; no buffering, so a 300 MiB model fits a Worker);
   - if an expected digest exists and differs → delete the new object, skip with `COPY_CHANGED`; sizes and kinds checked against `REQUEST_FILE_LIMITS` before reading (`COPY_TOO_LARGE`, `COPY_KIND`);
   - `insertRequestFile(db, added, [ledger, sourceRow])` (`requestFileHooks.ts:235`), where `ledger` = `INSERT INTO file_objects (object_key, visibility 'private', domain 'requests', owner_id = customer, entity_id = request, mime, byte_size, original_name, sha256, purpose 'request')` exactly as the session door writes it (`uploadSessions.ts:671-683`) — a **new file_objects row by sha256** — and `sourceRow` = `INSERT INTO community_request_sources (id 'rps_'||fileId, request_id, kind 'project_post', file_id, sha256, role '', origin_id = post_id, origin_ref = post_file_id, origin_hash = sha256, origin_meta = {"title": post title}, position)`. The guard refuses a 7th file (`REQUEST_FILES_FULL` → skipped);
   - a model carries the post row's `analysis` into the request file in the same batch (bytes identical, as «اطلب مرة أخرى» does, `printRequests.ts:2491-2498`), and its preview mesh is derived from the request's own copy under `waitUntil` (`measureOnArrival`), never copied from the post (the post's mesh follows the author's geometry choice).
5. Model write: one part per copied model (name = file name without extension, `measured_file_id` = the copy, material from the post's material when it is an active catalogue id, colour from the post's colour when it is a palette hex), the first model primary; a notice in the editor «جعلنا كل مجسم من المشروع قطعة. احذف ما لا تحتاجه.» when there were several.
6. Answer `{request_id, replayed:false, draft, copied:{files:n, skipped:[{name, code}]}}`.

- **Replay** (double submit, reload before the address changed): a draft of this customer created from this post (`community_request_sources.kind='project_post' AND origin_id=?`, index `idx_request_sources_origin`, `0208:143`) in the last 10 minutes and still `draft` → answered as is, `replayed:true`, nothing copied again.
- **Retry of a skipped file**: `POST /api/marketplace/print/requests/:id/copy-from-project {post_id, file_ids}` — owner, request in `REQUEST_FILE_STATES`, post readable, each file allowed; a file already copied (a source with `origin_ref = post_file_id` and the same `origin_hash`) is answered `already` and **not copied again** (acceptance 13 «no needless copies»).
- **Why it never changes later**: the request reads only its own objects and rows; `origin_*` is provenance, never followed to read a byte (row 266 (١)); the request's hash covers its own files (`factsHashV3`). The post author renaming, replacing or deleting a file, or deleting the post, leaves the request's files, sha256 and revision hash as they were.
- **Q5**: every copied file keeps role '' (production by default for `project_post`, so merchants may price it); the customer may mark one «الأصل القابل للتعديل», which then reaches only the accepted merchant. Nothing is withheld from the accepted merchant.
- **Privacy**: `origin_meta` carries the post title only — never the author's id, name or username (conflict 62); `projectModel` strips `origin_*` and `sha256` below owner/admin (`requestModel.ts:911-926`).

### 9.2 Product page «اطلب طباعته» (direct to the product's store)

- Where: `src/pages/StorefrontProduct.tsx` (both the apex `/community/store/:slug/p/:productSlug` and the store host `/p/:slug`), as a secondary button under the buy controls, when: `store.accepts_custom_requests`, the community is open to the viewer (`useCommunityAccess`, as in `LiveServiceDoors`, `Storefront.tsx:517-530`), the viewer is not the store owner, and the product's files (already fetched, `StorefrontProduct.tsx:147`) include one of kind `model`. Label «اطلب طباعته», second line «لهذا المتجر فقط».
- Href: `/requests/new?product=<productId>&store=<slug>`; on a store host `${MAIN_SITE}/requests/new?…` (the shared cookie keeps the session). An `<a>`, no import of any request module (storefront budget).
- `POST …/print/requests {entry:{kind:'product', product_id, store}}`:
  - `visibleStoreProduct(db, viewer, slug, productId)` (moved out of `productFiles.ts:311-346`, same refusals: `STORE_UNAVAILABLE`, 404);
  - `assertStoreTakesDirect` (accepts custom requests → else 409 `STORE_NO_CUSTOM_REQUESTS`; `merchantTakesNewWork` → else 409 `MERCHANT_UNAVAILABLE`; not the customer's own store → 400 `OWN_REQUEST`);
  - `openStoreThread({contextType:'store', contextId: customerId, storeId, merchantId, customerId, sellerId})` (`chats.ts:375`);
  - the direct draft (`directDraftStatement`: `visibility 'direct'`, `target_merchant_id`, `origin_chat_id`, `created_by 'customer'`; the 0151 triggers hold), title = the product name in the customer language (`lang` in the body; `name_ar` for ar);
  - a `link` source: the apex product URL, `origin_id = product id`, `origin_ref = 'product'`, primary;
  - the product's first picture copied as a `reference` file (public object → private copy, sha256 by `DigestStream`, `origin_ref = 'product_cover'`);
  - nothing of `product_files` is copied (the store holds its own files; paid files stay paid).
- Replay: a direct draft of this customer to this store with a link source `origin_id = product id` in the last 10 minutes.
- Not built: the official catalogue page `src/pages/Product.tsx` (printers and materials are not printable designs; a community product shown there links to its store page, where the door is).

### 9.3 Store page «لهذا المتجر فقط»

- Where: `CustomRequestCta` (`src/components/storefront/blocks/CustomRequestCta.tsx:20-37`) and the Services doors (`Storefront.tsx:517-550`). Today both send «اطلب عرض سعر» to the board wizard (`QUOTE_PATH`, `Storefront.tsx:66`). New: the primary becomes «اطلب طباعة من هذا المتجر» with the line «لهذا المتجر فقط — لا يراه غيره», href `/requests/new?store=<merchantId>` (store host: `${MAIN_SITE}…`); a quiet link under it «أو اطلب عروضًا من كل الورش» keeps the board door (`QUOTE_PATH`, unchanged so `tests/followedStores.test.ts:159` holds).
- Runtime: `src/components/storefront/runtime.tsx` gains `directRequestHref: string` beside `requestsHref` (`:79`, preview `'#'` `:128`), built from `store.merchant.id` (the public merchant id, never the account id).
- `POST …/print/requests {entry:{kind:'store', merchant_id}}`: the merchant-id rules of `/api/chats/open` (`chats.ts:603-640`: exists, not self, public or already known — E12 `customerKnowsMerchant`) + `assertStoreTakesDirect` + `openStoreThread` + `directDraftStatement`. Replay: an untouched direct draft of this customer to this store in the last 10 minutes.
- In the editor a direct request carries the banner «لهذا المتجر فقط: {store}» + «لا يظهر على لوحة الطلبات، ولا يراه غير هذا المتجر.». Visibility is locked by 0151 once the row exists; «انشره لكل الورش بدلًا من ذلك» uses the existing repeat door (`printRequests.ts:2392`, which turns a direct request into a board draft, `:2426`) and then deletes the direct draft (`POST /api/marketplace/requests/:id/cancel`), with a confirm that names both effects.
- The chat sheet (`src/components/chat/commerce/PrintRequestSheet.tsx`) stays as it is (a short in-chat form); its «اكتب طلبًا كاملًا» link (`:266`) moves to `/requests/new?store=<merchantId>`.

### 9.4 Aliases (`Requests.tsx`)

`newRequestAddress(params, state)` (pure, exported): when `view=new`, or a carried `printLink`/`link` exists (`Requests.tsx:111-114`), returns `/requests/new` with only `project`, `product`, `store`, `link` re-encoded; `Requests` renders `<Navigate to={…} replace />`. The board, «طلباتي», «تنفيذ طلباتي» are unchanged. `MyRequestsList` shows «مسودة بلا عنوان» for an empty draft title.

---

## 10. Server changes (no migration)

### 10.1 `POST /api/marketplace/print/requests` (new)

- Middleware `requireCommunityOpen, requireAuth` (gate first, as every starting door, `communityGate.ts:170-187`); `rateLimit(c, 'print-entry', 20, 3600)`.
- Body `{ entry?: {kind:'blank'} | {kind:'store', merchant_id} | {kind:'product', product_id, store} | {kind:'project', post_id}; lang?: 'ar'|'en'|'ckb' }`; absent entry = blank.
- Answer 201 `{ success, request_id, replayed, draft: draftShape(...), copied?: {files, skipped:[{name, code}]} }`; 200 on replay.
- Refusals: 503 `COMMUNITY_CLOSED`; 404 `ENTRY_NOT_FOUND`; 404 `STORE_UNAVAILABLE`; 409 `STORE_NO_CUSTOM_REQUESTS`; 409 `MERCHANT_UNAVAILABLE`; 400 `OWN_REQUEST`.
- Born v3: the request row + `printRowStatement` with an empty `WizardInput` + `modelWriteStatements` (`schema_version 3`) in one batch, so the draft is never read as `legacy` (a request without a print row reads `legacy_text`, row 266 (٢)).
- Audit `print.request_entry` `{kind, origin}` (no identity of a post author).
- `POST /api/marketplace/print/requests/:id/copy-from-project` (new): `requireCommunityOpen, requireAuth`, same rate bucket; §9.1.

### 10.2 Draft read/write (`printRequests.ts`)

- `draftShape` (`:1721-1786`) adds `updated_at`, `direct: {merchant_id, store_id, store_name, store_slug, chat_id} | null` (for `visibility = 'direct'`, owner-only), and `files[].sha256` is NOT added (the model's owner projection already has it).
- PUT draft (`:1652`): optional `expected_updated_at`; when present and different from the row → 409 `DRAFT_CHANGED` with `details.draft = draftShape` (read before the write; the write's own guard is unchanged). Absent → today's behaviour.

### 10.3 Publish (`publishRequest`, `:1390`)

- `visibility = 'direct'` → 409 `REQUEST_IS_DIRECT` before any write (a direct request is sent through its conversation; this also closes today's latent path where `Request.tsx:456-469` could open a direct draft that no store hears of).
- First publish of a draft: title < 4 → 400 `REQUEST_TITLE_REQUIRED`; description < 10 → 400 `REQUEST_DESCRIPTION_REQUIRED` (only a blank-born draft can lack them; every older draft has them from `marketplace.ts:768-769`).

### 10.4 Q2 on every budget reader (`worker/lib/requestBudget.ts`)

```ts
export type BudgetReader = 'owner' | 'admin' | 'merchant' | 'other';
/** The budget a reader may see: the owner and an admin always; a merchant only when the customer shows it; nobody else. */
export function budgetFor(budget: unknown, visible: unknown, reader: BudgetReader): number | null;
/** owner | admin | merchant (an active merchant account) | other — one indexed read per call, never per row. */
export async function budgetReaderOf(db: D1Database, user: SessionUser | null, customerId?: string): Promise<BudgetReader>;
/** A revision or order spec without its budget unless this reader may see it. Stored bytes are never rewritten. */
export function stripSpecBudget(spec: Record<string, unknown>, visible: unknown, reader: BudgetReader): Record<string, unknown>;
```

A missing column (a database before 0208) reads as hidden — private by default, which is Q2 itself.

| Reader | File:line | Change |
|---|---|---|
| Public board / community list / request page for a non-party | `marketplace.ts:192-202` (`publicRequest`), `:334-366`, `:369-380`; `community.ts` list | `budget_iqd: budgetFor(r.budget_iqd, r.budget_visible, reader)` with `reader` computed once per call (guest/customer → null always; a merchant browsing → shown when visible) |
| Party view | `partyRequest` (`marketplace.ts:229`) | owner → budget; engaged or direct merchant → when visible |
| Workshop board («مناسب لي») | `merchantWorkshop.ts:134,187` | select `r.budget_visible` (schema fallback as `notOriginal`, `:128-132`), `budgetFor(…, 'merchant')` |
| Match notification | `printRequests.ts:1539-1590` (forMatching) → `printMatchNotification` `:851-854` | select `budget_visible`; pass `budget_iqd` only when visible (the pure function and its test are unchanged) |
| Revisions | `printRequests.ts:1810-1891` | `stripSpecBudget(spec, request.budget_visible, reader)` for every row (owner/admin keep it) |
| Order snapshots | `publicSnapshot` `marketplace.ts:2595-2598`, sites `:2673`, `:2963`, `:3011` | strip for the merchant party unless visible |
| Chat card of a direct request | `chatCards.ts:194-227` (write), `printRequestCurrents` `:914` (read) | write the budget only when visible; at read drop it from a stored snapshot for the store side when the request is not visible now |
| Public API | `publicApi/resources/community.ts:257,287` | always null; schema text «Never public: a customer shows a budget only to merchants» |
| Admin | `adminCommunity.ts:857` | unchanged (admin) |
| Owner screens | `draftShape`, `/my-requests` | unchanged |

### 10.5 Extractions (no behaviour change)

- `directDraftStatement(db, row)` and `assertStoreTakesDirect(env, merchantId, customerId)` in `directRequests.ts`, used by `chatCommerce.ts:159-189` and the entry route.
- `visibleStoreProduct` in `worker/lib/productVisibility.ts`, used by `productFiles.ts:311` and the entry route.
- `customerKnowsMerchant` exported from `chats.ts` (routes already import `openStoreThread` from it, `marketplace.ts:164`).

### 10.6 Refusal words (`src/lib/refusalStrings.ts`, ar/en/ckb)

| Code | ar | en | ckb |
|---|---|---|---|
| `REQUEST_TITLE_REQUIRED` | اكتب عنوانًا من 4 إلى 140 حرفًا قبل النشر. | Write a title of 4 to 140 characters before publishing. | پێش بڵاوکردنەوە ناونیشانێک بنووسە لە ٤ تا ١٤٠ پیت. |
| `REQUEST_DESCRIPTION_REQUIRED` | صف ما تريده في 10 أحرف على الأقل قبل النشر. | Describe what you need in at least 10 characters before publishing. | پێش بڵاوکردنەوە ئەوەی پێویستتە لانیکەم بە ١٠ پیت باس بکە. |
| `REQUEST_IS_DIRECT` | هذا الطلب لمتجر واحد — أرسله إليه من صفحة الطلب أو من المحادثة. | This request is for one store — send it to the store from the request page or the conversation. | ئەم داواکارییە بۆ یەک فرۆشگایە — لە پەڕەی داواکارییەکەوە یان لە گفتوگۆکەوە بینێرە بۆی. |
| `DRAFT_CHANGED` | تغيّرت المسودة من نافذة أخرى — حمّل الأحدث. | The draft changed in another window — load the latest. | ڕەشنووسەکە لە پەنجەرەیەکی ترەوە گۆڕا — نوێترینەکە بار بکە. |
| `ENTRY_NOT_FOUND` | لم نجد ما تريد أن تطلب طباعته — ربما حُذف أو لم يعد متاحًا. | We could not find what you want printed — it may have been removed or is no longer available. | ئەوەی دەتەوێت چاپ بکرێت نەدۆزرایەوە — لەوانەیە سڕابێتەوە یان ئیتر بەردەست نەبێت. |
| `COPY_CHANGED` | تغيّر الملف أثناء نسخه — حاول مرة أخرى. | The file changed while it was being copied — try again. | فایلەکە لە کاتی کۆپیکردندا گۆڕا — دووبارە هەوڵ بدەرەوە. |

`STORE_NO_CUSTOM_REQUESTS`, `MERCHANT_UNAVAILABLE`, `OWN_REQUEST`, `REQUEST_NOT_DRAFT`, `REQUEST_CHANGED`, `LINK_DUPLICATE`, `LINKS_TOO_MANY`, `COLOURS_TOO_MANY`, `PART_MATERIALS_TOO_MANY`, `SOURCE_NOTE_TOO_LONG`, `COLOUR_REF_INVALID`, `SOURCE_ORIGINAL_PRIVATE` already have words (checked). Verify `STORE_UNAVAILABLE` has a customer sentence; add it if the table only names it in a comment (`refusalStrings.ts:860`).

---

## 11. Every new string, in ar / en / ckb (`editor/strings.ts`)

`{x}` are `fill` placeholders. Digits in Sorani sentences follow the existing tables (Arabic-Indic digits in fixed numbers, Western in filled numbers).

### 11.1 Page and audience

| key | ar | en | ckb |
|---|---|---|---|
| titleNew | طلب طباعة جديد | New print request | داواکاریی چاپی نوێ |
| titleDraft | مسودة طلب | Request draft | ڕەشنووسی داواکاری |
| titleEdit | تعديل طلبك | Edit your request | دەستکاریکردنی داواکارییەکەت |
| audienceBoard | لكل الورش المناسبة | For every workshop that fits | بۆ هەموو ئەو وۆرکشۆپانەی دەگونجێن |
| audienceDirect | لهذا المتجر فقط: {store} | For this store only: {store} | تەنها بۆ ئەم فرۆشگایە: {store} |
| audienceDirectHint | لا يظهر على لوحة الطلبات، ولا يراه غير هذا المتجر. | It is not on the requests board; only this store sees it. | لەسەر تەختەی داواکارییەکان دەرناکەوێت، و جگە لەم فرۆشگایە کەس نایبینێت. |
| toBoardInstead | انشره لكل الورش بدلًا من ذلك | Post it to every workshop instead | لە جیاتی ئەوە بۆ هەموو وۆرکشۆپەکان بڵاوی بکەرەوە |
| toBoardConfirm | ننشئ مسودة جديدة لكل الورش بنفس التفاصيل والملفات، ونحذف هذه المسودة. | We create a new draft for every workshop with the same details and files, and delete this one. | ڕەشنووسێکی نوێ بۆ هەموو وۆرکشۆپەکان بە هەمان وردەکاری و فایل دروست دەکەین، و ئەم ڕەشنووسە دەسڕینەوە. |
| fromProject | من مشروع: {title} | From a project: {title} | لە پڕۆژەیەکەوە: {title} |
| fromProduct | من منتج: {title} | From a product: {title} | لە بەرهەمێکەوە: {title} |
| preparing | نجهّز طلبك… | Preparing your request… | داواکارییەکەت ئامادە دەکەین… |
| copyingProject | ننسخ ملفات المشروع… | Copying the project files… | فایلەکانی پڕۆژەکە کۆپی دەکەین… |
| seededParts | جعلنا كل مجسم من المشروع قطعة. احذف ما لا تحتاجه. | Each model of the project became a part. Remove what you do not need. | هەر مۆدێلێکی پڕۆژەکە کرا بە پارچەیەک. ئەوەی پێویستت نییە لاببە. |
| projectNoFiles | لا ملفات قابلة للتنزيل في هذا المشروع — صف ما تريده أو أضف صورًا. | This project has no downloadable files — describe what you want or add pictures. | ئەم پڕۆژەیە هیچ فایلێکی دابەزاندنی نییە — ئەوەی دەتەوێت باسی بکە یان وێنە زیاد بکە. |
| notEditable | هذا الطلب لم يعد قابلًا للتعديل. | This request can no longer be edited. | ئەم داواکارییە ئیتر دەستکاری ناکرێت. |
| openRequest | افتح الطلب | Open the request | داواکارییەکە بکەرەوە |
| loadFailed | تعذّر فتح الطلب | Could not open the request | نەتوانرا داواکارییەکە بکرێتەوە |
| untitledDraft | مسودة بلا عنوان | Untitled draft | ڕەشنووسی بێ ناونیشان |

### 11.2 Sections

| key | ar | en | ckb |
|---|---|---|---|
| secSources | ما لديك | What you have | ئەوەی هەتە |
| secSourcesHint | أضف ما يساعد التاجر: ملفات، صور، روابط، أو وصفًا. كلها اختيارية ويمكن جمعها. | Add whatever helps the merchant: files, pictures, links or a description. All optional, all together. | هەرچی یارمەتی بازرگان دەدات زیادی بکە: فایل، وێنە، لینک یان وەسف. هەمووی ئارەزوومەندانەیە و دەکرێت پێکەوە بن. |
| secDescribe | صف طلبك | Describe your request | داواکارییەکەت باس بکە |
| secParts | ماذا نطبع | What to print | چی چاپ بکرێت |
| secDelivery | التسليم والميزانية | Delivery and budget | گەیاندن و بودجە |
| secAudience | ما يراه الآخرون | What others see | ئەوەی کەسانی تر دەیبینن |

### 11.3 Sources

| key | ar | en | ckb |
|---|---|---|---|
| addFiles | أضف ملفات | Add files | فایل زیاد بکە |
| addFilesHint | مجسمات (STL، 3MF، OBJ، STEP…)، صور، أو PDF — حتى {n} ملفات. | Models (STL, 3MF, OBJ, STEP…), pictures or PDF — up to {n} files. | مۆدێل (STL، 3MF، OBJ، STEP…)، وێنە یان PDF — تا {n} فایل. |
| takePhoto | التقط صورة | Take a photo | وێنەیەک بگرە |
| addLink | أضف رابطًا | Add a link | لینک زیاد بکە |
| linkLabel | الرابط | The link | لینکەکە |
| linkHint | رابط مجسم أو صفحة منتج — مرجع فقط، لا نحمّل منه شيئًا. | A model or product page — a reference only; nothing is downloaded from it. | لینکی مۆدێل یان پەڕەی بەرهەم — تەنها سەرچاوەیە، هیچی لێ دانابەزێنرێت. |
| linkAddButton | أضف | Add | زیاد بکە |
| linkInvalid | هذا لا يبدو رابطًا صالحًا (https). | That does not look like a valid link (https). | ئەمە وەک لینکێکی دروست (https) نایەتە بەرچاو. |
| addTextRef | أضف وصفًا مرجعيًا | Add a written reference | سەرچاوەیەکی نووسراو زیاد بکە |
| textRefPlaceholder | مثال: نفس مقاس الغطاء الأصلي، قطره 62 ملم | e.g. Same size as the original lid, 62 mm across | بۆ نموونە: هەمان قەبارەی سەرپۆشە ڕەسەنەکە، تیرەکەی ٦٢ ملم |
| limitsLine | {f} من {fm} ملفات · {l} من {lm} روابط | {f} of {fm} files · {l} of {lm} links | {f} لە {fm} فایل · {l} لە {lm} لینک |
| full | اكتمل العدد ({n} ملفات). احذف ملفًا لتضيف غيره. | The request is full ({n} files). Remove one to add another. | داواکارییەکە پڕە ({n} فایل). یەکێک لاببە بۆ ئەوەی یەکێکی تر زیاد بکەیت. |
| picturesLabel | الصور | Pictures | وێنەکان |
| filesLinksLabel | الملفات والروابط | Files and links | فایل و لینکەکان |
| kindModel | مجسم | Model | مۆدێل |
| kindPicture | صورة | Picture | وێنە |
| kindDocument | مستند PDF | PDF document | بەڵگەنامەی PDF |
| kindLink | رابط | Link | لینک |
| kindText | وصف مرجعي | Written reference | سەرچاوەی نووسراو |
| kindProjectCopy | نسخة من مشروع | Copy from a project | کۆپی لە پڕۆژەیەکەوە |
| projectCopyNote | نسخة محفوظة مع طلبك — لا تتغيّر إن عدّل صاحب المشروع منشوره. | A copy kept with your request — it does not change if the author edits the project. | کۆپییەک لەگەڵ داواکارییەکەت هەڵگیراوە — ئەگەر خاوەنی پڕۆژەکە دەستکاری بکات، ناگۆڕێت. |
| noteAdd | أضف ملاحظة | Add a note | تێبینییەک زیاد بکە |
| noteLabel | ملاحظة عن هذا المصدر | Note on this source | تێبینی دەربارەی ئەم سەرچاوەیە |
| noteHint | يراها كل من يرى الطلب. لا تكتب رقم هاتفك. | Everyone who sees the request sees it. Do not write your phone number. | هەر کەسێک داواکارییەکە ببینێت ئەمەش دەبینێت. ژمارەی مۆبایلەکەت مەنووسە. |
| primaryBadge | الرئيسي | Main | سەرەکی |
| makePrimary | اجعله المصدر الرئيسي | Make it the main source | بیکە بە سەرچاوەی سەرەکی |
| primaryHint | الرئيسي هو ما يبدأ به التاجر. | The main source is where the merchant starts. | سەرچاوەی سەرەکی ئەوەیە بازرگان پێی دەست پێدەکات. |
| originalToggle | هذا هو الأصل القابل للتعديل | This is the editable original | ئەمە ڕەسەنە دەستکاریکراوەکەیە |
| originalHint | يصل إلى التاجر الذي تقبل عرضه فقط، ولا يكون المصدر الرئيسي. | It reaches only the merchant whose offer you accept, and cannot be the main source. | تەنها دەگاتە ئەو بازرگانەی ئۆفەرەکەی قبوڵ دەکەیت، و ناتوانێت سەرچاوەی سەرەکی بێت. |
| originalBadge | الأصل — للتاجر المقبول فقط | Original — accepted merchant only | ڕەسەن — تەنها بۆ بازرگانی پەسەندکراو |
| originalNotPrimary | الأصل لا يكون المصدر الرئيسي | The original cannot be the main source | ڕەسەنەکە ناتوانێت سەرچاوەی سەرەکی بێت |
| moreActions | خيارات {name} | Options for {name} | هەڵبژاردەکانی {name} |
| view3d | عرض ثلاثي الأبعاد | View in 3D | بینین بە سێ ڕەهەند |
| remove | احذف | Remove | لابردن |
| removeNamed | احذف {name} | Remove {name} | لابردنی {name} |
| removeTitle | حذف هذا المصدر؟ | Remove this source? | ئەم سەرچاوەیە لاببرێت؟ |
| removeWithOffers | التجار الذين قدّموا عروضًا سعّروا هذا — ستحتاج عروضهم إلى تأكيد جديد. | Merchants priced this — their offers will need re-confirming. | بازرگانەکان نرخیان بۆ ئەمە داناوە — ئۆفەرەکانیان پێویستیان بە پشتڕاستکردنەوەی نوێ دەبێت. |
| removePlain | لن يراه التجار. | Merchants will not see it. | بازرگانەکان نایبینن. |
| addOnPublishedTitle | إضافة ملف إلى طلب منشور؟ | Add a file to a published request? | فایل بۆ داواکارییەکی بڵاوکراوە زیاد بکرێت؟ |
| addOnPublishedBody | العروض القائمة ({n}) تتوقف حتى يؤكدها أصحابها، ويُبلَّغون بذلك. | The standing offers ({n}) pause until their merchants re-confirm them, and they are told. | ئۆفەرە هەنووکەییەکان ({n}) ڕادەگیرێن تا بازرگانەکانیان دووبارە پشتڕاستیان دەکەنەوە، و ئاگادار دەکرێنەوە. |
| addAnyway | أضف | Add | زیاد بکە |

### 11.4 Upload states

| key | ar | en | ckb |
|---|---|---|---|
| stQueued | في الانتظار | Waiting | لە چاوەڕوانیدا |
| stFinishing | يُنهي الرفع… | Finishing the upload… | بارکردنەکە تەواو دەکرێت… |
| stMeasuring | يُقاس… | Measuring… | دەپێورێت… |
| stMeasureLater | يُقاس لاحقًا | Measured later | دواتر دەپێورێت |
| stMeasureLaterHint | المجسمات الأكبر من 40 ميغابايت لا تُقاس هنا: تصل إلى الورش كمرجع، ويمكنك كتابة مقاسها التقريبي. | Models over 40 MB are not measured here: they reach the workshops as a reference, and you can type the approximate size. | ئەو مۆدێلانەی لە ٤٠ مێگابایت گەورەترن لێرە ناپێورێن: وەک سەرچاوە دەگەنە وۆرکشۆپەکان، و دەتوانیت قەبارە نزیکەکەی بنووسیت. |
| stFailed | لم يُرفع: {reason} | Not uploaded: {reason} | بار نەکرا: {reason} |
| stRejected | لن يُرفع: {reason} | Will not be uploaded: {reason} | بار ناکرێت: {reason} |
| retry | أعد المحاولة | Try again | دووبارە هەوڵ بدەرەوە |
| cancel | إلغاء | Cancel | هەڵوەشاندنەوە |
| dismiss | إخفاء | Dismiss | شاردنەوە |
| summaryPartial | رُفع {ok} من {all} — {failed} لم يُرفع | {ok} of {all} uploaded — {failed} did not upload | {ok} لە {all} بارکرا — {failed} بار نەکرا |
| uploadingCount | ملفات قيد الرفع: {n} | Files uploading: {n} | فایل لە بارکردندا: {n} |
| resumeHint | رفع «{name}» لم يكتمل — اختر الملف نفسه مرة أخرى ليُستأنف من حيث توقف. | “{name}” did not finish uploading — pick the same file again to resume where it stopped. | بارکردنی «{name}» تەواو نەبووە — هەمان فایل دووبارە هەڵبژێرە بۆ ئەوەی لەو شوێنەوە بەردەوام بێت کە وەستاوە. |
| copySkipped | لم يُنسخ «{name}»: {reason} | “{name}” was not copied: {reason} | «{name}» کۆپی نەکرا: {reason} |
| copyTooLarge | أكبر من حد الطلب ({limit}) | Larger than the request limit ({limit}) | لە سنووری داواکاری گەورەترە ({limit}) |
| copyKind | نوعه لا يُقبل في الطلبات | Requests do not take its type | جۆرەکەی لە داواکارییەکاندا وەرناگیرێت |
| copyFull | اكتمل عدد ملفات الطلب | The request has no room left | داواکارییەکە شوێنی تێدا نەماوە |
| copyMissing | لم يعد الملف متاحًا | The file is no longer available | فایلەکە ئیتر بەردەست نییە |
| copyChanged | تغيّر الملف أثناء النسخ | The file changed while copying | فایلەکە لە کاتی کۆپیکردندا گۆڕا |

(The ring and byte counter keep `UPLOAD_STRINGS`, `src/components/upload/strings.ts:23`.)

### 11.5 Grid and viewer

| key | ar | en | ckb |
|---|---|---|---|
| openPicture | افتح الصورة {n} من {total}: {name} | Open picture {n} of {total}: {name} | کردنەوەی وێنەی {n} لە {total}: {name} |
| viewerLabel | عارض الصور | Picture viewer | پیشاندەری وێنە |
| prevPicture | الصورة السابقة | Previous picture | وێنەی پێشوو |
| nextPicture | الصورة التالية | Next picture | وێنەی دواتر |
| close | إغلاق | Close | داخستن |
| zoomIn | تكبير | Zoom in | گەورەکردن |
| zoomOut | تصغير | Zoom out | بچووککردنەوە |
| pendingBadge | لم يُرفع بعد | Not uploaded yet | هێشتا بار نەکراوە |

### 11.6 Parts, materials, colours

| key | ar | en | ckb |
|---|---|---|---|
| addPart | أضف قطعة أخرى | Add another part | پارچەیەکی تر زیاد بکە |
| addPartHint | لقطعة من عدة أجزاء بمواد أو ألوان مختلفة. | For a piece made of several parts in different materials or colours. | بۆ پارچەیەک کە لە چەند بەشێک پێکهاتووە بە ماددە یان ڕەنگی جیاواز. |
| partName | اسم القطعة | Part name | ناوی پارچە |
| perSet | كم نسخة منها في الطقم | Copies in one set | چەند دانە لە هەر سێتێکدا |
| sets | عدد الأطقم | Sets | ژمارەی سێت |
| quantity | الكمية | Quantity | بڕ |
| quality | الدقة | Detail | وردی |
| qDraft / qStandard / qFine / qUltra | سريعة / قياسية / دقيقة / فائقة | Quick / Standard / Fine / Ultra | خێرا / ستاندارد / ورد / زۆر ورد |
| process | طريقة الطباعة | Printing process | شێوازی چاپکردن |
| processFdm / processResin / unsure | خيوط FDM / ريزن / لست متأكدًا | FDM filament / Resin / Not sure | دەزووی FDM / ڕێزن / دڵنیا نیم |
| material | المادة | Material | ماددە |
| addMaterial | أضف مادة لهذه القطعة | Add a material to this part | ماددەیەک بۆ ئەم پارچەیە زیاد بکە |
| addMaterialHint | أكثر من مادة في قطعة واحدة يحتاج طابعة متعددة المواد ومراجعة فنية. | More than one material in one part needs a multi-material printer and a technical review. | زیاتر لە ماددەیەک لە یەک پارچەدا پێویستی بە چاپکەری فرە-ماددە و پێداچوونەوەی تەکنیکی هەیە. |
| removeMaterial | احذف هذه المادة | Remove this material | ئەم ماددەیە لاببە |
| region | أي جزء منها بهذه المادة؟ | Which area of it is in this material? | کام بەشی بەم ماددەیەیە؟ |
| requirements | متطلبات خاصة | Special requirements | پێداویستیی تایبەت |
| requirementsPlaceholder | مثال: يتحمّل حرارة السيارة | e.g. Must stand the heat in a car | بۆ نموونە: بەرگەی گەرمای ناو ئۆتۆمبێل بگرێت |
| finish | التشطيب | Finish | ڕووکاری کۆتایی |
| finishStandard | كما يُطبع | As printed | وەک چاپ دەکرێت |
| finishSanded | مصنفر | Sanded | سمپادەکراو |
| finishPrimed | مُجهّز للطلاء | Primed | ئامادەکراو بۆ ڕەنگکردن |
| finishPainted | مطلي | Painted | ڕەنگکراو |
| finishPolished | مصقول | Polished | بریقەدارکراو |
| colours | الألوان | Colours | ڕەنگەکان |
| addColour | أضف لونًا | Add a colour | ڕەنگێک زیاد بکە |
| removeColour | احذف {colour} | Remove {colour} | لابردنی {colour} |
| colourAny | أي لون مناسب | Any suitable colour | هەر ڕەنگێکی گونجاو |
| colourAsRef | كما في المرجع | As in the reference | وەک لە سەرچاوەکەدا |
| asRefWhich | كما في أي مرجع؟ | As in which reference? | وەک لە کام سەرچاوەدا؟ |
| asRefAll | المراجع عمومًا | The references in general | سەرچاوەکان بە گشتی |
| colourCustom | لون آخر | Another colour | ڕەنگێکی تر |
| colourCustomName | اسم اللون | Colour name | ناوی ڕەنگ |
| colourCustomShade | اختر درجته (اختياري) | Pick its shade (optional) | پلەکەی هەڵبژێرە (ئارەزوومەندانە) |
| multicolourHint | أكثر من لون في قطعة واحدة يحتاج طابعة متعددة الألوان — أو اجعلها قطعًا منفصلة. | More than one colour in one part needs a multi-colour printer — or make them separate parts. | زیاتر لە ڕەنگێک لە یەک پارچەدا پێویستی بە چاپکەری فرە-ڕەنگ هەیە — یان بیانکە بە پارچەی جیا. |
| sizeApprox | المقاس التقريبي (ملم) | Approximate size (mm) | قەبارەی نزیکەیی (ملم) |
| measuredFrom | يُقاس من | Measured from | لەم فایلەوە دەپێورێت |
| noModel | بلا ملف — سأكتب المقاس | No file — I will type the size | بێ فایل — قەبارەکە دەنووسم |
| length / width / height | الطول / العرض / الارتفاع | Length / Width / Height | درێژی / پانی / بەرزی |
| partSources | المراجع لهذه القطعة | References for this part | سەرچاوەکان بۆ ئەم پارچەیە |
| partNotes | ملاحظات القطعة | Notes on this part | تێبینی دەربارەی ئەم پارچەیە |
| assembly | كيف تُركَّب | How it is assembled | چۆن پێکەوە دەبەسترێت |
| moveUp | انقلها للأعلى | Move up | بیبە سەرەوە |
| moveDown | انقلها للأسفل | Move down | بیبە خوارەوە |
| duplicatePart | كرّرها | Duplicate | دووبارەی بکەرەوە |
| removePart | احذف القطعة | Remove the part | پارچەکە لاببە |
| removePartTitle | حذف «{name}»؟ | Remove “{name}”? | «{name}» لاببرێت؟ |
| partsMax | يمكن أن يضم الطلب {n} قطعة على الأكثر. | A request can have at most {n} parts. | داواکاری دەتوانێت زۆرترین {n} پارچەی هەبێت. |
| partEstimate | ≈ {range} | ≈ {range} | ≈ {range} |
| partUnpriced | بلا تقدير: {reason} | No estimate: {reason} | بێ خەمڵاندن: {reason} |
| noGeometry | لا مجسم مقيس — يسعّرها التاجر | No measured model — the merchant prices it | مۆدێلی پێوراو نییە — بازرگان نرخی بۆ دادەنێت |
| materialUnknownPrice | اختر مادة ليُقدَّر سعرها | Choose a material to estimate it | ماددەیەک هەڵبژێرە بۆ خەمڵاندنی نرخەکەی |

### 11.7 Pickers

| key | ar | en | ckb |
|---|---|---|---|
| materialPickerTitle | اختر المادة | Choose the material | ماددەکە هەڵبژێرە |
| materialSearch | ابحث عن مادة | Search materials | بەدوای ماددەدا بگەڕێ |
| filterAll | الكل | All | هەموو |
| unsureOption | لست متأكدًا — يقترح التاجر | Not sure — the merchant suggests | دڵنیا نیم — بازرگان پێشنیار دەکات |
| traitEnclosure | يحتاج طابعة مغلقة | Needs an enclosed printer | پێویستی بە چاپکەری داخراو هەیە |
| traitAbrasive | كاشطة — فوهة مقوّاة | Abrasive — hardened nozzle | خڕاشێنەرە — لووتکەی پتەو |
| materialNoMatch | لا مادة بهذا الاسم | No material by that name | هیچ ماددەیەک بەم ناوە نییە |
| clearSearch | امسح البحث | Clear search | گەڕان بسڕەوە |
| materialOutOfCatalogue | لم تعد هذه المادة في الكتالوج | This material is no longer in the catalogue | ئەم ماددەیە ئیتر لە کاتالۆگدا نییە |
| colourPickerTitle | اختر الألوان | Choose colours | ڕەنگەکان هەڵبژێرە |
| colourSearch | ابحث عن لون | Search colours | بەدوای ڕەنگدا بگەڕێ |
| colourNoMatch | لا لون بهذا الاسم — أضفه كلون آخر | No colour by that name — add it as another colour | هیچ ڕەنگێک بەم ناوە نییە — وەک ڕەنگێکی تر زیادی بکە |
| coloursMax | حتى {n} لونًا لكل مادة | Up to {n} colours a material | تا {n} ڕەنگ بۆ هەر ماددەیەک |
| done | تم | Done | تەواو |

### 11.8 Delivery and budget

The wizard's words move as they are (all three languages exist today, `RequestWizard.tsx:1031-1072`): governorate «المحافظة» / "Governorate" / «پارێزگا»; «لم أحدد» / "Not set" / «دیاری نەکراوە»; handover «الاستلام» / "Handover" / «وەرگرتن»; «توصيل» / "Delivery" / «گەیاندن»; «استلام بنفسي» / "I collect" / «خۆم وەریدەگرم»; «أيهما» / "Either" / «هەر کامیان»; «أحتاجه قبل» / "Needed by" / «پێویستە پێش»; «اختر تاريخًا من اليوم إلى سنة قادمة.» / "Choose a date from today to a year ahead." / «بەروارێک لە ئەمڕۆوە تا ساڵێکی تر هەڵبژێرە.»; notes for merchants and its hint (`:1022-1024`). New:

| key | ar | en | ckb |
|---|---|---|---|
| budget | ميزانيتك | Your budget | بودجەکەت |
| budgetOptional | اختيارية. اتركها فارغة إن لم تكن متأكدًا. | Optional. Leave it empty if unsure. | ئارەزوومەندانەیە. ئەگەر دڵنیا نیت بەتاڵی بهێڵەوە. |
| budgetSwitch | اعرض ميزانيتي للتجار | Show my budget to merchants | بودجەکەم نیشانی بازرگانەکان بدە |
| budgetSwitchDirect | اعرض ميزانيتي لهذا المتجر | Show my budget to this store | بودجەکەم نیشانی ئەم فرۆشگایە بدە |
| budgetOff | مخفية: لا يراها أحد غيرك. | Hidden: nobody but you sees it. | شاراوەیە: جگە لە تۆ کەس نایبینێت. |
| budgetOn | يراها التجار الذين يمكنهم صنع طلبك، ولا تظهر للعموم. | Merchants who can make your request see it; it is never public. | ئەو بازرگانانەی دەتوانن داواکارییەکەت دروست بکەن دەیبینن، و هەرگیز گشتی نییە. |
| budgetOnDirect | يراها هذا المتجر وحده. | Only this store sees it. | تەنها ئەم فرۆشگایە دەیبینێت. |
| budgetHiddenNote (request page, owner) | ميزانيتك مخفية عن التجار | Your budget is hidden from merchants | بودجەکەت لە بازرگانەکان شاراوەیە |

### 11.9 «ما يراه الآخرون»

| key | ar | en | ckb |
|---|---|---|---|
| panelTitle | ما يراه الآخرون | What others see | ئەوەی کەسانی تر دەیبینن |
| panelIntro | قبل النشر: هذا ما يصبح عامًا وما يبقى خاصًا. | Before you publish: what becomes public and what stays private. | پێش بڵاوکردنەوە: ئەوەی گشتی دەبێت و ئەوەی تایبەت دەمێنێتەوە. |
| panelSummary | يراه الجميع: {p} · التجار: {m} · لك وحدك: {o} | Everyone: {p} · Merchants: {m} · Only you: {o} | هەمووان: {p} · بازرگانەکان: {m} · تەنها تۆ: {o} |
| groupPublic | يراه الجميع على لوحة الطلبات | Everyone on the requests board | هەمووان لەسەر تەختەی داواکارییەکان |
| groupPublicDirect | يراه هذا المتجر | This store sees | ئەم فرۆشگایە دەیبینێت |
| groupMerchants | للتجار الذين يمكنهم صنعه فقط | Only merchants who can make it | تەنها ئەو بازرگانانەی دەتوانن دروستی بکەن |
| groupMerchantsDirect | يراه هذا المتجر أيضًا | This store also sees | ئەم فرۆشگایە ئەمانەش دەبینێت |
| groupAccepted | للتاجر الذي تقبل عرضه فقط | Only the merchant whose offer you accept | تەنها ئەو بازرگانەی ئۆفەرەکەی قبوڵ دەکەیت |
| groupPrivate | لك وحدك | Only you | تەنها تۆ |
| rowTitle | العنوان والوصف | Title and description | ناونیشان و وەسف |
| rowParts | القطع والمواد والألوان | Parts, materials and colours | پارچە و ماددە و ڕەنگەکان |
| rowQuantity | الكمية والأطقم | Quantity and sets | بڕ و سێتەکان |
| rowPlace | المحافظة فقط — لا العنوان | The governorate only — never the address | تەنها پارێزگا — هەرگیز ناونیشان نا |
| rowWhen | الموعد وطريقة الاستلام | Deadline and handover | کات و شێوازی وەرگرتن |
| rowNotes | ملاحظاتك للتجار | Your notes for merchants | تێبینییەکانت بۆ بازرگانەکان |
| rowLinks | الروابط والأوصاف المرجعية وملاحظاتها | Links, written references and their notes | لینک و سەرچاوە نووسراوەکان و تێبینییەکانیان |
| rowFileNames | أسماء الملفات وأنواعها | File names and kinds | ناو و جۆری فایلەکان |
| rowPictures | الصور وملفات PDF | Pictures and PDF files | وێنە و فایلەکانی PDF |
| rowModelPreview | معاينة مبسّطة للمجسمات | A simplified preview of the models | پێشبینینێکی سادەکراوی مۆدێلەکان |
| rowBudget | ميزانيتك | Your budget | بودجەکەت |
| rowModels | ملفات المجسمات نفسها | The model files themselves | خودی فایلەکانی مۆدێل |
| rowOriginal | الأصل القابل للتعديل | The editable original | ڕەسەنە دەستکاریکراوەکە |
| rowIdentity | اسمك ورقم هاتفك وعنوانك | Your name, phone and address | ناو و ژمارەی مۆبایل و ناونیشانەکەت |
| rowProvenance | من أين نُسخت الملفات | Where the files were copied from | فایلەکان لە کوێوە کۆپی کراون |
| groupEmpty | لا شيء | Nothing | هیچ |

### 11.10 Save, review, publish, send

| key | ar | en | ckb |
|---|---|---|---|
| saved | محفوظ | Saved | پاشەکەوتکرا |
| saving | يُحفظ… | Saving… | پاشەکەوت دەکرێت… |
| unsaved | تغييرات لم تُحفظ | Unsaved changes | گۆڕانکاریی پاشەکەوتنەکراو |
| saveFailed | لم يُحفظ — أعد المحاولة | Not saved — try again | پاشەکەوت نەکرا — دووبارە هەوڵ بدەرەوە |
| offline | لا اتصال — نحفظ حين يعود | Offline — we save when it is back | هێڵ نییە — کاتێک گەڕایەوە پاشەکەوتی دەکەین |
| conflict | تغيّرت المسودة في نافذة أخرى | The draft changed in another window | ڕەشنووسەکە لە پەنجەرەیەکی ترەوە گۆڕا |
| loadLatest | حمّل الأحدث | Load the latest | نوێترینەکە بار بکە |
| keepMine | احفظ نسختي | Keep mine | هی خۆم بهێڵەرەوە |
| save | احفظ | Save | پاشەکەوت بکە |
| savedToast | حُفظت المسودة. لا يراها أحد غيرك. | Draft saved. Nobody but you can see it. | ڕەشنووسەکە پاشەکەوت کرا. جگە لە تۆ کەس نایبینێت. |
| leaveTitle | الخروج بلا حفظ؟ | Leave without saving? | بەبێ پاشەکەوتکردن دەڕۆیت؟ |
| leaveBody | لم نستطع حفظ آخر تغييراتك. | We could not save your last changes. | نەمانتوانی دوایین گۆڕانکارییەکانت پاشەکەوت بکەین. |
| leave | اخرج | Leave | بڕۆ |
| stay | ابقَ | Stay | بمێنەوە |
| review | راجع وانشر | Review and publish | پێدابچۆرەوە و بڵاوی بکەرەوە |
| reviewDirect | راجع وأرسل للمتجر | Review and send to the store | پێدابچۆرەوە و بینێرە بۆ فرۆشگاکە |
| reviewEdit | راجع التعديلات | Review the changes | گۆڕانکارییەکان پێدابچۆرەوە |
| reviewTitle | راجع طلبك | Review your request | داواکارییەکەت پێدابچۆرەوە |
| backToEdit | رجوع للتعديل | Back to editing | گەڕانەوە بۆ دەستکاری |
| publish | انشر | Publish | بڵاوکردنەوە |
| sendTo | أرسل إلى {store} | Send to {store} | بینێرە بۆ {store} |
| saveChanges | احفظ التعديلات | Save changes | گۆڕانکارییەکان پاشەکەوت بکە |
| waitUploads | انتظر حتى يكتمل الرفع ({n}) | Wait for the uploads to finish ({n}) | چاوەڕێ بکە تا بارکردن تەواو دەبێت ({n}) |
| failedUploadsTitle | ملفات لم تُرفع | Files that did not upload | ئەو فایلانەی بار نەکران |
| failedUploadsBody | عدد الملفات التي لم تُرفع: {n}. لن تصل إلى التجار. هل تنشر بدونها؟ | Files not uploaded: {n}. They will not reach the merchants. Publish without them? | ژمارەی ئەو فایلانەی بار نەکران: {n}. ناگەنە بازرگانەکان. بەبێ ئەوان بڵاوی دەکەیتەوە؟ |
| publishWithout | انشر بدونها | Publish without them | بەبێ ئەوان بڵاوی بکەرەوە |
| directSentTitle | أُرسل طلبك إلى {store} | Your request was sent to {store} | داواکارییەکەت بۆ {store} نێردرا |
| directSentBody | تجده في محادثتك مع المتجر، ويصلك عرضه هناك. | It is in your conversation with the store, and its offer arrives there. | لە گفتوگۆکەت لەگەڵ فرۆشگاکەدا هەیە، و ئۆفەرەکەی لەوێ دەگات. |
| openChat | افتح المحادثة | Open the conversation | گفتوگۆکە بکەرەوە |

Kept from the wizard, moved as they are (ar/en/ckb exist): title/description labels, placeholders and errors (`RequestWizard.tsx:466-467`, `:887-892`), «لا يتغير بعد النشر», the estimate words (`:1133-1160`), the publish result words (`:648-655`), the privacy line (`:1175-1179`), the live-offers warning and confirm (`:613-624`, `:1164-1172`).

### 11.11 Entry doors

| key (file) | ar | en | ckb |
|---|---|---|---|
| printThis (`src/components/storefront/strings.ts`) | اطلب طباعته | Ask to have it printed | داوای چاپکردنی بکە |
| forThisStoreOnly (storefront strings) | لهذا المتجر فقط | For this store only | تەنها بۆ ئەم فرۆشگایە |
| requestFromStore (storefront strings) | اطلب طباعة من هذا المتجر | Request a print from this store | داوای چاپ لەم فرۆشگایە بکە |
| requestFromStoreLine (storefront strings) | لهذا المتجر فقط — لا يراه غيره | For this store only — nobody else sees it | تەنها بۆ ئەم فرۆشگایە — کەسی تر نایبینێت |
| orAskEveryWorkshop (storefront strings) | أو اطلب عروضًا من كل الورش | Or ask every workshop for offers | یان داوای ئۆفەر لە هەموو وۆرکشۆپەکان بکە |
| writeFullRequest (chat sheet) | اكتب طلبًا كاملًا | Write a full request | داواکارییەکی تەواو بنووسە |

Side fix while here: `src/components/ui/Sheet.tsx:74` gives Sorani the Arabic («توسيع», «تصغير»); the editor's pickers use the sheet, so it becomes «فراوانکردن» / «بچووککردنەوە» (row 183).

---

## 12. Playwright e2e

### 12.1 Harness

- `tests/browser/request-editor.html` + `tests/browser/request-editor-fixture.tsx`: renders `<RequestEditorPage>` and the request page in a `MemoryRouter`/`BrowserRouter` at `/requests/new…`, `/requests/new/:id`, `/requests/:id`, with `?lang=ar|en|ckb`.
- A **stateful fake server** on `window.fetch` (the pattern of `tests/browser/print-requests-v2-fixture.tsx:62-75`), its state kept in `sessionStorage` so a page reload sees the same draft: entry create (blank, project with one skipped file, store), GET/PUT draft (with `expected_updated_at`), whole-body file door (multipart → `{file:{id,url,inline}}`), the upload-session doors (create, PUT part with a 150 ms delay per part to show progress, complete; a file named `flaky.stl` fails its second part once, then succeeds on «أعد المحاولة» with the same session id), `/analyze` (dims), `/print/link` (canonical + card), `/print/catalog`, `/print/quote` (coverage per part), publish, chat send, the request page reads, and a picture route that serves a PNG for `?w=`.
- Served by the local vite already used by the other fixtures; Chromium from `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), never `playwright install`.

### 12.2 Script

`scripts/e2e-request.mjs` gains the editor passes (the plan names this file; its request-page scenes stay as they are), driving `request-editor.html`; or a sibling `scripts/e2e-request-editor.mjs` called from it — one entry point either way.

**Scenario D (Done-when, 30.D1)**, at 360×740 in ar, then en and ckb:
1. Open `/requests/new` — no draft is created until the first act (fake server count = 0).
2. Add files `bracket.stl`, `front.jpg`, `side.png`, `virus.exe` in one pick → three upload rows + one rejected row with the format sentence; `front.jpg`/`side.png` show `[data-editor-thumb="pending"]` with a `blob:` src **before upload**; the address becomes `/requests/new/<id>`.
3. Wait: the STL shows the ring, then «82×64×41 ملم»; pictures turn `[data-editor-thumb="stored"]` with src containing `/api/marketplace/requests/` and `w=` (**after upload**); no tile or row renders a file id (`crf_`, `rps_` absent from visible text).
4. Add `flaky.stl` → fails («لم يُرفع: …»), summary «رُفع 3 من 4 — 1 لم يُرفع» → «أعد المحاولة» → done; the fake server holds one file row for it and one session (acceptance 13).
5. Add a link (MakerWorld) → link row with its card; add a written reference.
6. Title + description; per-source note on `front.jpg` from the viewer; make the STL primary.
7. «أضف قطعة أخرى»: part 1 PLA black (the material search «PLA» finds it), measured from `bracket.stl`; part 2 TPU red (the search «مرن» in ar, «نەرم» in ckb; «xyz» shows «لا مادة بهذا الاسم») with stated dims, colour «كما في المرجع» → `side.png`.
8. Delivery: governorate, handover, deadline; budget 25 000, switch off.
9. «احفظ» → status «محفوظ»; PUT body carries both parts, four sources, the notes, `budget_visible:false`.
10. **Reload** → everything back: thumbnails stored, link card, parts, materials, colours, note, primary (**after reload**).
11. Navigate away to `/requests?view=mine`, reopen the draft from «طلباتي» → `/requests/new/<id>` with the same state (**reopened draft**).
12. «راجع وانشر» → review: `[data-review-thumb]` pictures (**at review**), estimate with the coverage line, «ما يراه الآخرون» with budget under «لك وحدك»; flip the switch → budget moves under «للتجار الذين يمكنهم صنعه فقط».
13. «انشر» → lands on `/requests/<id>`; the details show the thumbnails `[data-request-thumb]` (**on details**) and both parts.

**740×360 (landscape, ar)**: steps 2, 7, 12 and the viewer: no horizontal overflow; the action bar ≤ 72 px tall and visible; the viewer picture fits the height; the picker sheets reach their large detent and keep the search field visible.

**Keyboard open (360×740 → 360×420 after focus, ar and en)**: focus the title, then a part's notes, then the picker search, then the custom colour name — after each, set the viewport to 360×420 (the visual viewport shrinks as a soft keyboard would) and assert: the focused element's rect is inside `[0, visualViewport.height]`; the action bar is hidden (`data-editor-bar="keyboard"`) or entirely above the focused field; no horizontal overflow; restoring 360×740 brings the bar back.

**Viewer**: open picture 1 → `[data-image-viewer]` with `w=1280` src; ArrowLeft in RTL goes to picture 2 («2 / 2»); Escape closes and focus is on tile 1; in en ArrowRight goes forward.

**Entries**: `/requests/new?project=post_1` → «ننسخ ملفات المشروع…», two copies listed as «نسخة من مشروع», one skipped with its reason and «أعد المحاولة»; `/requests/new?store=cm1` → banner «لهذا المتجر فقط: …», review button «راجع وأرسل للمتجر», send → the sent screen; old address `/requests?view=new&project=post_1` lands on the editor.

Every pass: no page errors, no horizontal overflow, every button has an accessible name, screenshots to `/tmp/claude-0/shots/request-editor/` (out of the repo).

---

## 13. Tests

### 13.1 Per acceptance row

| Row | Test file (new unless noted) | What it proves |
|---|---|---|
| **13** image as image, retry no copies | `tests/requestEditorSources.test.ts` | `SourceThumb` renders a `blob:` img for a pending picture, the authorised route with `w=` for a stored one, a glyph for a model/PDF; SSR of a sources area with ids `crf_*`/`rps_*` shows none in text; `uploads.ts` retry of a failed session upload calls `uploadLarge` with the same `File` and `entityId` (one resume key, one session, fake fetch counts one `POST /api/upload-sessions`); a client-refused file never reaches fetch; the summary counts. |
| 13 (server) | `tests/requestProjectHandoff.test.ts` | Retrying a copied post file through `copy-from-project` answers `already` and writes no second object, file row or source. |
| **14** one request holds all; survives back/reload | `tests/requestEditorDraft.test.ts` (server) | Blank entry → whole-body model + two pictures → PUT v3 body (link, written reference, two parts PLA/TPU, notes per source, primary, original flag) → GET draft returns every source, note, primary, role, part, material, colour, `budget_visible`, `updated_at`; the same body again changes no model hash; a stale `expected_updated_at` → 409 `DRAFT_CHANGED` and nothing written; publish → 200; a blank draft's publish without title → `REQUEST_TITLE_REQUIRED`. |
| 14 (client) | `tests/requestEditorState.test.ts` | `hydrate(draft) → editorBody` reproduces the body that made the draft (round trip, every field); tmp ids for new links are referenced by `source_ids` and colour refs; `source_type` is never sent; a short title is not sent and is kept by the session mirror; `sessionMirror` survives a throwing storage and restores only when `base_updated_at` matches. |
| 14 (compat) | `tests/requestEditorCompat.test.ts` | A published v1 request from `tests/fixtures/v1RequestCorpus.ts` with a pending offer, opened in the editor (`hydrate` of its synthesised model) and saved unchanged through publish → `replayed: true`, the offer still `pending` (acceptance 27 regression). |
| **20** (part) post edit never changes a request | `tests/requestProjectHandoff.test.ts` | Post with two downloadable models, one not downloadable, a cover picture → entry → two model copies + the cover; new object keys under `requests/<customer>/`; `file_objects` rows with the post sha256 and `purpose 'request'`; sources `project_post` with `origin_id = post`, `origin_ref = post file`, `origin_hash = sha256`; a digest mismatch → `COPY_CHANGED`, object deleted; then the author renames, replaces (new bytes) and deletes files and finally deletes the post → the request's files, bytes (read back), sha256, model and revision hash are unchanged; the non-downloadable file never copied; an unreadable post (draft, private, hidden, blocked) → 404 `ENTRY_NOT_FOUND` and no request; replay within 10 minutes answers the same draft; no projection below owner carries `origin_*`, `sha256` or the author. |
| **34** public view: no phone, address, original or private budget | `tests/requestBudgetPrivacy.test.ts` | Budget hidden by default on the board list, the community list, the request page for a guest/customer/merchant, the workshop board, the match notification text, `/revisions` for a board merchant, an order snapshot read by the merchant, a direct request card for the store, the public API; shown with `budget_visible = 1` to the workshop board, a merchant on the request page, the notification, `/revisions` for a merchant, the order snapshot, the store card — never to a guest or the public API; owner and admin always; a database without the column reads hidden. Extended `tests/publicRequestIdentity.test.ts`: a request with a role-`source` file, a profile phone and an address → `publicRequest` and `projectModel(…, 'public'|'merchant')` carry no phone, no address, no original (file id, url or ref), no budget. |
| 34 (panel) | `tests/requestAudiencePanel.test.ts` | Every key of `REQUEST_FIELD_VISIBILITY` maps to a panel row (no orphan either way); for a fixture model with every field, what the panel lists for each audience is exactly what `projectModel(model, 'public'|'merchant'|'accepted'|'owner')` keeps (`sha256`/`origin_*` only for owner, the original only from accepted); `REQUEST_FILE_VISIBILITY` agrees with `mayReadBytes`/`previewGrantFor` for every class × reader × role; a direct request heads the groups with the store words. |
| **30.D1** | `tests/requestScenarioD.test.ts` (extended) | Entry → STL + two pictures + link + description + two parts with different materials (PLA, TPU) → saved → GET equals (resumed) → published; the published revision's model has both parts and four sources; D2/D3 unchanged. |

### 13.2 Other new tests

- `tests/requestDirectEntry.test.ts`: store entry → direct draft with `target_merchant_id`, `origin_chat_id` = the store thread (one thread per pair), not on the board; own store → `OWN_REQUEST`; store without custom requests → `STORE_NO_CUSTOM_REQUESTS`; unapproved/suspended merchant → `STORE_UNAVAILABLE`/`MERCHANT_UNAVAILABLE` (E12: a customer with existing business still passes the visibility rule); `publish` of a direct draft → 409 `REQUEST_IS_DIRECT`, nothing written; chat send of a v3 direct draft → card in the thread, revision 1 recorded with the model, budget per Q2; offers by another store still refused by the 0151 trigger.
- `tests/requestProductEntry.test.ts`: a store product with a model file → direct draft, link source to the apex product URL with `origin_id = product`, the cover copied with its sha256, no `product_files` copied; hidden/archived/private product → 404; store hidden → `STORE_UNAVAILABLE`; replay.
- `tests/requestEditorStrings.test.ts`: every key in ar/en/ckb; no Sorani value equals the Arabic or the English; every Sorani sentence carries a Sorani-only letter (ڕ ێ ۆ ە ڵ ڤ) unless it is a pure technical token; no Latin fragments in ar/ckb except the technical names (PLA, FDM, STL, 3MF, OBJ, STEP, PDF, https); every `{x}` placeholder is present in all three. Add the editor and storefront string files to the Sorani ratchet (`tests/soraniStorefrontGaps.test.ts` pattern).
- `tests/requestEditorUi.test.ts` (source-level and SSR): the route is lazy in `App.tsx` and inside `ProtectedRoute` + `CommunityGate`; `useSuppressBottomNav` in the editor; `Requests.tsx` `newRequestAddress` mapping (view=new, link, printLink, project, product, store; unknown keys dropped); the storefront modules import no request module; the viewer and pickers have accessible names; no inline 3D import (`ogl`, `three`, the slicer) in any editor file.
- `tests/communityGate.test.ts` (extended): `['/api/marketplace/print/requests', {}]` and `['/api/marketplace/print/requests/creq1/copy-from-project', {}]` in `GATED_WRITES` (`:149-158`).
- `tests/refusalStrings.test.ts` (unchanged code, passes with the new entries): each new code has ar/en/ckb and is emitted by a route.
- `tests/bundleBudget.test.ts`: `'RequestEditor'` added to the named chunks (`:310`); the entry and storefront budgets hold (`STOREFRONT_BUDGET` 47 KB, `:447`).
- `tests/imageRenderSites.test.ts` (`:45-58`): register the editor sites (`SourceThumb` objectUrl, `ImageViewer` `requestImageSrc(url, 1280)`) and drop the wizard entry.

### 13.3 Tests changed on purpose (Q2)

- `tests/communityHub.test.ts:237` `budget_iqd === 15000` on the public community list → `null` (and `15000` for a merchant reader with `budget_visible = 1`). Reason: Q2 / row 268.
- `tests/publicApi.test.ts`: budget null in the public request resource.
- Money tests (`escrow`, `merchantLedgerFlows`, `offersV2`, `communityAcceptIntegrity`) untouched; `tests/offerCoverage.test.ts:170` (the agreement never copies the budget) still green.

### 13.4 Tests re-pointed when the wizard is retired (same intent, new file)

| Test | Today pins | Re-pointed to |
|---|---|---|
| `tests/communityP1.test.ts:50` | `useSuppressBottomNav()` in the wizard | the editor component |
| `tests/requestFileThumbsUi.test.ts:62,151-180,328,408` | `WizardFileThumb`, `previewUrl`, `releasePreviews`, the revoke sites, `requestFilesCheck` use, review sources, link card, R9 Sorani count, colour table | `editor/SourceThumb.tsx`, `editor/uploads.ts`, `editor/ReviewSheet.tsx`, `editor/strings.ts` (R9 moves to the strings test) |
| `tests/offerScreensReview6.test.ts:61-63` | `estimateCoverageLine(quote, requestStrings(L))` + `data-wizard-estimate-coverage` in the wizard | the review sheet and the part card (`data-editor-estimate-coverage`) |
| `tests/postFilesUi.test.ts:218-222` | `purpose="request"`, `entityId`, `pickRequestUpload(f) === 'session'`, `capture="environment"` in the wizard | `editor/uploads.ts`, `editor/SourcesArea.tsx` |
| `tests/requestPageUi.test.ts:292` | lazy `RequestWizard` import in the request page | «تعديل» navigates to `/requests/new/:id` |
| `tests/toolsLinkAndPrinterClient.test.ts:51-62` | the wizard opens on the carried link; `Requests.tsx` passes `initialLink` | `Requests.tsx` aliases `printLink`/`link` to `/requests/new?link=` and the editor checks the link on arrival |
| `tests/browser/print-requests-v2-fixture.tsx` | the `wizard` views | the editor (the `viewer` views used by `scripts/e2e-w6-sweep.mjs:110` stay) |

`tests/linkCardsUi.test.ts:142-154`, `tests/communityHubUi.test.ts:73`, `tests/followedStores.test.ts:159`, `tests/communityGate.test.ts:769` keep passing: the old addresses are kept and aliased.

### 13.5 Local runs (one process at a time)

```
cd /home/user/levonis-requi && node --import tsx --test \
  tests/requestEditorState.test.ts tests/requestEditorSources.test.ts tests/requestEditorDraft.test.ts \
  tests/requestEditorCompat.test.ts tests/requestEditorStrings.test.ts tests/requestEditorUi.test.ts \
  tests/requestProjectHandoff.test.ts tests/requestProductEntry.test.ts tests/requestDirectEntry.test.ts \
  tests/requestBudgetPrivacy.test.ts tests/requestAudiencePanel.test.ts tests/requestScenarioD.test.ts \
  tests/publicRequestIdentity.test.ts tests/communityGate.test.ts tests/communityHub.test.ts tests/publicApi.test.ts \
  tests/requestModelWriters.test.ts tests/requestModelPrivacy.test.ts tests/printRequestNotifyLanguage.test.ts \
  tests/communityP1.test.ts tests/requestFileThumbsUi.test.ts tests/offerScreensReview6.test.ts tests/postFilesUi.test.ts \
  tests/requestPageUi.test.ts tests/toolsLinkAndPrinterClient.test.ts tests/linkCardsUi.test.ts tests/imageRenderSites.test.ts \
  tests/bundleBudget.test.ts tests/claySystem.test.ts tests/refusalStrings.test.ts \
  tests/escrow.test.ts tests/merchantLedgerFlows.test.ts tests/offersV2.test.ts tests/communityAcceptIntegrity.test.ts
npm run check
```

(`bundleBudget` needs a fresh `dist/`; build first.)

---

## 14. Budgets, BASE 6, accessibility, direction

- **Bundles**: the editor is its own lazy chunk; `Requests` loses the wizard (smaller); the storefront gets two anchors and five strings and imports nothing of the request code (`tests/store-isolation.test.ts` stays green); the viewer, pickers and panel live in the editor chunk; `refusalStrings` stays a lazy import for failures (the `UploadTile` rule).
- **BASE 6**: no slicer, no 3D library in the editor; «عرض ثلاثي الأبعاد» navigates to the existing viewer route.
- **Clay**: `lv-surface`, `lv-button-*`, `Button`, `Field`, `Segmented`, `Switch`, `Sheet`, `Overlay`; no raw zinc fills, no ad-hoc buttons (claySystem census).
- **No apostrophes in English comments under `src/`** (claySystem census); English UI strings avoid them too where possible.
- **A11y**: 44 px targets; every icon button named; pickers are listboxes with `aria-activedescendant`; the grid is a list of buttons; status lines `aria-live="polite"`, errors `role="alert"`; focus moves to the first invalid field on review; reorder by buttons, not drag only; reduced motion respected.
- **Direction**: names and file names in `<bdi>`/`dir="ltr"` as today; part lines and substitution lines in the reader direction (`readerDir`, row 267 (ت), (6ج)); viewer arrows mirror in RTL.
- **Keyboard**: `useKeyboardOpen` = an editable element focused and `visualViewport.height` < 75 % of the largest height seen; the action bar hides while true, the focused field is scrolled to the centre of the visual viewport (`scrollIntoView({block:'center'})` after the resize), as `adminProducts/ui.tsx:356-385` and `Sheet.tsx:168-178` already track the visual viewport.

---

## 15. DECISIONS row 268 (text to append to `docs/DECISIONS.md`)

| 268 | **واجهة الطلب v3 ومداخله: محرّر واحد للمسودة والتعديل، ومصادر مجتمعة، وقطع ومواد وألوان، و«ما يراه الآخرون»، وميزانية خاصة افتراضياً، ونسخة المشروع ببصمتها، و«اطلب طباعته» و«لهذا المتجر فقط» (Request UI v3 and entry points: one editor for drafts and edits, sources together, parts/materials/colours, «what others see», a private budget by default, the project copy by its sha256, «print this» and «this store only»؛ `src/pages/community/RequestEditor.tsx`؛ `src/components/community/requests/editor/*`؛ `worker/routes/requestEntries.ts`؛ `worker/lib/requestHandoff.ts`؛ `worker/lib/requestBudget.ts`؛ P1-06؛ بلا ترحيل — 0208 يحمل كل عمود)** — سجلّ قرار تصميم. (١) **محرّر واحد** على `/requests/new` و`/requests/new/:id` يحلّ محلّ المعالج ذي الخطوات الأربع في الطلب الجديد والمسودة وتعديل الطلب المنشور، ويُحذف `RequestWizard.tsx`؛ يقرأ الطلب من `draft.model` (إسقاط المالك؛ وطلب v1 مركَّب)، ويكتب جسم v3 كاملاً بمعرّفاته المُعادة فتبقى تغطية العروض وبدائلها على صفوفها، ولا يرسل `source_type` أبداً (يشتقّه الخادم)؛ والعناوين القديمة (`/requests?view=new` و`link` و`project` وحالة `printLink`) أسماء بديلة تنتقل إليه. (٢) **المسودة على الخادم هي الحقيقة**: تولد عند أول فعل دائم (ملف، رابط، وصف مرجعي، حفظ، أو مدخل من مشروع أو منتج أو متجر) عبر باب جديد يقبل عنواناً فارغاً، والنشر يرفض بعدها `REQUEST_TITLE_REQUIRED`/`REQUEST_DESCRIPTION_REQUIRED`؛ والحفظ التلقائي متباعد ثلاثين ثانية على الأقل مع تفريغ عند تغيّر القسم وقبل الرفع والمراجعة وعند مغادرة الصفحة، والنص غير المحفوظ في مرآة لكل لسان في `sessionStorage` تُمسح مع تغيّر الهوية؛ و`expected_updated_at` الاختياري يجيب `DRAFT_CHANGED` لنافذة قديمة. (٣) **المصادر معاً لا اختيار بينها**: لكل مصدر ملاحظته (≤500، عامة كما في السجلّ)، ومصدر رئيسي واحد، وعلامة «الأصل القابل للتعديل» (Q5: للتاجر المقبول وحده، ولا يكون رئيسياً)؛ ولكل ملف حالته (رفض مشروح قبل الرفع، انتظار، فحص، رفع بحلقة، قياس، فشل بسببه مع «أعد المحاولة» و«إلغاء»)، ونجاح جزئي لا يوقفه ملف فاشل، وإعادة المحاولة تستأنف الجلسة نفسها فلا نسخة زائدة (13)؛ والصور شبكة بمعاينة `blob:` ثم المسار المخوَّل بـ`?w=` وعارض داخل الصفحة بلا مكتبة، والمجسم يُفتح في عارضه القائم فلا يحمّل المحرّر شيئاً ثلاثي الأبعاد (BASE 6). (٤) **القطع**: قطعة واحدة افتراضياً، و«أضف قطعة أخرى» حتى 12، ولكل قطعة اسمها («القطعة n» إن غاب، كما في كل شاشة ورفض) ونسخها في الطقم وطريقتها ومواد حتى 4 بألوان حتى 16 وتشطيب ومنطقة ومتطلبات ومقاس مقيس أو مكتوب ومراجعها وملاحظاتها وتركيبها؛ والأطقم كمية الطلب؛ والتقدير لكل قطعة من `/quote` بتغطيته، فقطعة سيرفضها النشر تظهر برمز رفضها قبل النشر؛ والمراجعة الفنية تُقرأ من الخادم ولا تُحسب في المتصفح. ومنتقيا المادة واللون صفحتان بحث (بالعربية والكردية والإنجليزية مع طيّ الهمزات والياء والكاف) بالاسم والعيّنة، و«أي لون مناسب» حصري، و«كما في المرجع» يسمّي مرجعه أو المراجع عموماً، و«لون آخر» باسمه ودرجته. (٥) **«ما يراه الآخرون»** يُبنى من السجلّ `REQUEST_FIELD_VISIBILITY` ومن جدول جديد `REQUEST_FILE_VISIBILITY` يطابق مصفوفة `requestFilePolicy` (الصور وPDF للتجار، معاينة المجسم المبسّطة للتجار وملفه للمقبول، والأصل للمقبول، والهوية والعنوان للمقبول، والمصدر والبصمة للمالك)، ويثبت اختبارٌ أن ما يقوله لكل جمهور هو ما يُبقيه `projectModel`؛ وفي الطلب المباشر يُسمّى الجمهور «هذا المتجر». (٦) **Q2 مطبّقة على كل قارئ للميزانية** بدالة واحدة `budgetFor`: لا تظهر للعموم أبداً (اللوحة، قائمة المجتمع، صفحة الطلب للزائر، الواجهة العامة)، وتظهر للتاجر فقط حين يفعّل الزبون «اعرض ميزانيتي للتجار» (لوحة الورشة، صفحة الطلب، إشعار المطابقة، المراجعات، لقطة الطلبية، بطاقة الطلب المباشر)، والمالك والمشرف دائماً؛ ولا تُعاد كتابة أي بايت مخزَّن (اللقطات والبطاقات تُسقط عند القراءة)، وقاعدة بلا العمود تُقرأ مخفية؛ فتختفي الميزانية عن كل طلب قائم، وهذا مقصود (الصف 266 (٧)). (٧) **نسخة المشروع** (التعارض 5): يُنسخ كل ملف قابل للتنزيل (`mine || downloadable` كباب التنزيل) وصورة الغلاف إلى كائن خاص جديد يُبثّ ويُبصَم أثناء النسخ (`DigestStream`)، بصفّ `file_objects` جديد يحمل sha256 المنشور، ومصدر من نوع `project_post` بـ`origin_id` = المنشور و`origin_ref` = ملفه و`origin_hash` = البصمة؛ وبصمة مختلفة تُسقط النسخة `COPY_CHANGED`؛ ولا يُتبع `origin_*` لقراءة بايت، فتعديل المنشور أو حذفه لا يغيّر ملفات الطلب ولا بصمته (20)؛ وكل مجسم منسوخ قطعة مقيسة منه، والملف الذي لم يُنسخ يُذكر بسببه ويُعاد بباب `copy-from-project` الذي يجيب «منسوخ» ولا ينسخ مرتين؛ ولا تحمل الإسقاطات دون المالك هوية صاحب المنشور. (٨) **«اطلب طباعته» في صفحة منتج المتجر** طلب مباشر إلى ذلك المتجر (التصميم له، ورخصته، والمسار أ)، يظهر حين يقبل المتجر الطلبات الخاصة وفي المنتج ملف مجسم، ويحمل رابط صفحة المنتج ونسخة صورة الغلاف، ولا يُنسخ أي ملف من ملفات المنتج. **«لهذا المتجر فقط»** من صفحة المتجر طلب مباشر (`visibility = 'direct'` والمتجر وخيط المحادثة) بقواعد باب المحادثة نفسها (E12، يقبل الطلبات الخاصة، يأخذ عملاً جديداً، لا متجر الزبون)، ويُرسل بباب الإرسال في المحادثة القائم، وباب النشر يرفض الطلب المباشر `REQUEST_IS_DIRECT` فلا يُفتح طلب مباشر لا يعلم به متجره؛ ونقله إلى اللوحة نسخةٌ بـ«اطلب مرة أخرى» وحذف المسودة. (٩) **Q1**: كل باب جديد خلف `requireCommunityOpen` والمسارات داخل `CommunityGate`؛ يجري المالك سيناريو D على الموقع الحي والبوابة مغلقة. **ما لم يُبنَ**: «اطلب طباعته» في صفحة الكتالوج الرسمي، وعارض الصور في صفحة الطلب، وتقييد الملفات لكل قطعة، ونسخة Studio (P1-11) ومصدر القالب (P2-08)، ونص المعاينة الصريح (P1-12). **English summary**: one v3 editor at `/requests/new[/:id]` replaces the wizard for new, draft and published edits; server draft born on the first durable act, throttled autosave, a per-tab mirror and `DRAFT_CHANGED`; sources together with per-source note, one main source, the Q5 original, explained rejection, partial success and resumable retry; a picture grid with an in-page viewer and no 3D code; parts with materials and colours and a per-part estimate; searchable pickers with «any suitable colour» and «as in the reference»; «what others see» computed from the contract registries and proved against `projectModel`; Q2 applied to every budget reader by projection; the project handoff copies bytes with a verified sha256 into new `file_objects` rows and `project_post` sources, so a post edit never changes a request; «print this» on a store product page and «this store only» on the store page make direct requests sent through the conversation; no migration. **الاختبارات**: `tests/requestEditorState.test.ts`، `tests/requestEditorSources.test.ts` (13)، `tests/requestEditorDraft.test.ts` (14)، `tests/requestEditorCompat.test.ts` (27 انحداراً)، `tests/requestProjectHandoff.test.ts` (20 جزئياً، 13)، `tests/requestBudgetPrivacy.test.ts` و`tests/requestAudiencePanel.test.ts` و`tests/publicRequestIdentity.test.ts` (34)، `tests/requestScenarioD.test.ts` (30.D1)، `tests/requestDirectEntry.test.ts`، `tests/requestProductEntry.test.ts`، `tests/requestEditorStrings.test.ts`، `tests/requestEditorUi.test.ts`، و`scripts/e2e-request.mjs` على 360×740 و740×360 ولوحة المفاتيح مفتوحة؛ واختبارات المال الأربعة بلا تغيير. | ✅ مُسجَّل (P1-06) | `docs/LEVO_PLAN_PHASE1_2.md` P1-06؛ `docs/LEVO_ACCEPTANCE_MATRIX.md` (13، 14، 20، 34، `17.*`، 30.D1)؛ الصفوف 262 (Q1، Q2، Q5) و265 و266 و267؛ التعارضان 5 و62 في `docs/LEVO_GAP_MAP.md` |

---

## 16. Risks and open questions

1. **Vocabulary**: «القطعة n» names a part on every current screen and refusal (`strings.ts:131`, `refusalStrings.ts:2530`), while `jobCountWords` counts parts as «الأجزاء»/«بەش» and pieces as «القطع»/«پارچە» (`mirrors.ts`). The editor follows the existing part label so a refusal and a card name the same thing, and uses «كم نسخة منها في الطقم» (not «قطع») for pieces per set. Aligning the whole vocabulary is a separate, owner-visible change.
2. **Six files** per request (`requestFiles.ts:46`) limits a twelve-part request to six model files; unchanged here (owner number). The editor says so when parts outnumber files.
3. **Project seeding one part per model** can be wrong when the files are alternatives; the notice says so and parts are one tap to remove.
4. **Copy cost**: up to six streamed copies with hashing in one invocation (≤ 6 × 300 MiB worst case); post files are bounded by the post limits (64 MiB), so the realistic worst case is ~384 MiB of streaming. Copies are sequential; a timeout leaves a usable draft and the rest as retryable skips.
5. **`DigestStream` in Node tests**: the unit harness may lack it; `requestHandoff.ts` falls back to buffering + `crypto.subtle.digest` when `crypto.DigestStream` is absent (tests only; the Worker always has it).
6. **Direct send has no estimate**: the chat send door does not price; a direct request shows «لا تقدير» on its page. Acceptable (the store prices it); noted.
7. **Rollback**: an older build reads every v3 row (row 266 (٤) mirror); a direct draft with v3 rows is sent by the older chat door unchanged; the budget would reappear on an older build's board — the rollback note in `docs/CLOUDFLARE_BUILDS_RUNBOOK.md` gains one line («an older build shows budgets publicly again»).
8. **Existing chat cards** store the budget in their snapshot; the read-time strip covers them, but a client cached page may show it until reload.

---

## 17. Implementation order (commits on `feat/req-v3-ui`, no push)

1. Server Q2: `requestBudget.ts` + every reader + `requestBudgetPrivacy`/`publicRequestIdentity`/hub/public API test updates.
2. Server entries: `requestEntries.ts`, `requestHandoff.ts`, `productVisibility.ts`, `directRequests.ts` extraction, `draftShape` additions, `DRAFT_CHANGED`, publish guards, refusal words; server tests (14, 20, 13 server, direct, product, gate).
3. Client editor: `state.ts`, `persistence.ts`, `sessionMirror.ts`, `uploads.ts`, sources area, grid, viewer, parts, pickers, delivery, budget, panel, review, action bar, strings; route wiring and aliases; request page edit/publish; client tests.
4. Entry doors: Project/PostCard, StorefrontProduct, storefront blocks and runtime, chat sheet link; retire the wizard; re-point the tests (§13.4).
5. e2e harness and passes; matrix rows 13/14/20/34/`17.*`/30.D1 with file:line evidence; plan status for P1-06; DECISIONS row 268; `npm run check` and the listed tests.
