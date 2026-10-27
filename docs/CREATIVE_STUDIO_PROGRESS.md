# استوديو Levonis الإبداعي — التقدم (Creative Studio progress)

The architecture decision is `docs/CREATIVE_STUDIO.md`; the owner decisions it
needs are DECISIONS row 270. This file says what is built, what is not, and how
to switch it on — one section per side of the studio.

## Worker

> **ملخص للمالك.** خادم الاستوديو جاهز: الحفظ بالإصدارات، الاعتماد لإصدار محدد،
> التصدير الخاص، الأصول، الهوية، الخدمات المعتمدة، بيانات المتجر للقراءة فقط،
> واقتراحات Claude (الأفكار، ثلاثة تكوينات، تعديل محدد، مراجعة بصرية، كاروسيل).
> يعمل الذكاء الاصطناعي بمجرد اختيار النموذج من صفحة الإعدادات، لأن سر العامل
> `ANTHROPIC_API_KEY` موجود أصلاً على الموقع الحي. لكتابة مفتاح آخر في الإعدادات
> أضِف السر `CREATIVE_STUDIO_ENC_KEY` أولاً (طريقته أدناه).
>
> **لم يُنفَّذ بعد أي طلب حي إلى Anthropic** (حتى 2026-10-27): كل اختبارات
> الذكاء الاصطناعي تستخدم مزوداً بديلاً بنفس شكل الطلب والجواب. أول تجربة حية
> تكون من «اختبار الاتصال» في الإعدادات بعد النشر؛ سيُسجَّل هنا تاريخها والنموذج
> والنتيجة.

### Built (migration `0216_creative_studio.sql`)

| Part | Where | What it guarantees |
|---|---|---|
| 18 studio tables | `migrations/0216_creative_studio.sql` | additive only (`CREATE … IF NOT EXISTS`); no store table is written; no column for a prompt, an answer or a key in the usage ledger |
| The API (62 routes) | `worker/routes/adminCreativeStudio.ts` at `/api/admin/creative-studio` | apex only; `requireAdmin` → rate limit → studio scope (owner + full admins; assistants `403 CREATIVE_SCOPE_REQUIRED`) or `requireOwner` (key, model, budget, rates, brand kit, claims, JSON import); shapes = `packages/creativeDoc/src/api.ts` (response envelopes at its end) |
| Provider adapter | `worker/lib/creative/anthropic.ts`, `readBody.ts` (its own capped reader: the FX module is a money boundary it does not import) | the only reader of a key; raw `fetch` through an injectable transport; one host; `redirect: manual`; per-task deadlines; 512 KB body cap; `anthropic-version: 2026-10-21`; structured outputs; effort only when the model lists it; never `temperature`/`top_p`/`top_k`, tools or prefill; 429 retried once (≤ 5 s), 503/529 once, a timeout never; every failure a code |
| Key vault | `worker/lib/creative/keyVault.ts`, `worker/lib/sealbox.ts` | AES-256-GCM under `CREATIVE_STUDIO_ENC_KEY` (rotation ring), ciphertext bound to its row (AAD); 4-character hint for the owner only; stored key first, then the Worker secret |
| Prompts | `worker/lib/creative/prompts.ts` | the §28 rules; data in tagged blocks with `<` escaped; product facts through an allow-list without amounts, links or picture URLs; copy in Arabic or English only — never Sorani |
| Budget | `worker/lib/creative/budget.ts`, `ai.ts` | one conditional UPDATE reserves the worst case (requests, tokens, USD with rates, parallel calls); settled with real usage, released when the provider did not process the request, the worst case kept when the outcome is unknown; the call and its settle run under `waitUntil`; a reservation stranded by a dead Worker is settled after 5 minutes **at its worst case** with an `INTERRUPTED` usage row — once, however many sweeps race; a picture in a visual review is counted by its pixel allowance, not its base64 size; deadlines 110 s (ideas, compositions, review, carousel) and 45 s (edit) |
| Jobs | `worker/lib/creative/jobs.ts` | idempotency (same key + same request = stored result, no second call; different request = 409), cancel, applied once; a cancelled job's late result is never stored as usable |
| Store connector | `worker/lib/creative/store.ts` | read-only, through the public card path (`pricingCtxForUser(db, null)`, `resolveListingCards`, `priceFromCard`, `cardAvailability`, `resolveVariantPricing`); an allow-list snapshot with a sha256 hash; unpriced never 0, pre-order never available, membership teaser apart |
| Opportunities + catalogue watch | `worker/lib/creative/opportunities.ts`, `evidence.ts` | live public offers, arrivals after the baseline, back-in-stock from a recorded unavailable → available, coverage gaps (30 days), approved claims, education topics, owner priorities (typed in Settings — never inferred), recent approved designs; the first whole sync pass is a baseline that announces nothing; a price or availability change of a product a released design shows marks that design `needs_review`. AI copy may claim an offer, an arrival or a return to stock only with evidence read from the store and the watch **at request time** (`evidence.ts`), never from a stored snapshot |
| Designs | `worker/lib/creative/documents.ts` | `normalizeDocument` on every write and read; `VERSION_CONFLICT` instead of overwriting; versions at meaningful points (AI, restore, template, relayout, import, checkpoint, ≥ 10 min), 50 kept, approved and final-exported versions never pruned; approval of one version, invalidated by any later content change; approved and final-exported versions always keep a version row; the losing side of a concurrent save, approval or AI apply writes nothing (no history row, no job mark, no review); approval and a final export re-verify every binding against the store now (`SOURCE_CHANGED`), re-run the server's checks (`QA_BLOCKERS`, plus `unsupported_claim` for offer words with no live offer and `asset_not_approved`); opening an approved or final-exported design re-verifies it and records price / availability / offer changes in `needs_review` without touching its content; status changes and withdrawn approvals are in `audit_log`; `POST /documents` records `origin` and the AI job (`job_id`, marked applied in the same write); archive search covers titles, visible text and product names, and a bare «to» date includes its day |
| Files | `worker/lib/creative/files.ts` | PNG/JPEG/WebP by magic bytes only (SVG and animated refused), 15 MB, header-only dimensions, stored byte-for-byte in the private bucket under `creative-studio/…`, served `private, no-store` with a sandbox CSP |
| Registries | `packages/contracts/src/ownership.ts` (owner `ads`), `worker/lib/mediaRefs.ts` (the `r2_key` and design columns are media sources), `worker/lib/productDeletion.ts` (studio history keeps its rows), `worker/lib/schemaVersion.ts` (208), `worker/lib/storeLayout.ts`, `tests/routeClass/creativeStudio.ts`, role matrix, gateway routing, `services/gateway/src/uploadClasses.ts` (the two 15 MB upload doors), `tests/listingPredicateGuard.test.ts` (the connector's VISIBLE/SELLABLE calls, counted; `docs/PRICING-V2.md` §9) | the repository's sweeps cover the studio from day one |

Tests: `tests/creativeStudioProvider.test.ts`, `tests/creativeStudioAi.test.ts`,
`tests/creativeStudioDocuments.test.ts`, `tests/creativeStudioStore.test.ts`,
`tests/creativeStudioVersions.test.ts`, `tests/creativeStudioReleased.test.ts`,
`tests/creativeStudioArchive.test.ts`, `tests/creativeStudioAiSpend.test.ts`,
`tests/creativeStudioAiEvidence.test.ts`, `tests/creativeStudioMemory.test.ts`,
`tests/creativeStudioContract.test.ts` and `tests/creativeStudioScreensContract.test.ts`
(the real client driven into the real router)
(the role-matrix, deploy-ahead and host-guard sweeps walk every studio route too).

### Not built yet (Worker side)

- **No external publishing or calendar** (spec §25–26): there is no
  scheduling table and no publisher; `scheduled`/`published` statuses exist in
  the schema only so a later integration needs no migration.
- **No batch creation** (spec §21): every AI request is one request; there is no
  queue or cron-driven batch, and the parallel limit applies per request.
- **The catalogue watch runs when someone presses «تحديث الكتالوج»** on Home
  (it repeats `POST /watch/sync` until a pass completes; the first pass is a
  baseline). No cron drives it yet; adding one is a new cron entry and dispatch
  branch (`tests/scheduledCronDispatch.test.ts`).
- **Uploaded assets**: the owner's uploads are approved at once; a full admin's
  wait for review (`PATCH /assets/:id`), and an unapproved asset blocks approval
  and the final export. A full admin may still approve their own upload (the
  roles were not changed).
- **Advanced engines** (spec §38–46: image generation, background removal, 3D,
  OCR) are not connected; only the visual review (Claude vision, owner-enabled)
  is.
- **Colours and option combinations are not variants** of a snapshot: a
  variant is one active option (`ov:<id>`). A picture bound only to a colour or
  a combination is listed in the product detail with its binding but enters no
  snapshot (it cannot be proven to belong to one model).
- **Capability grants for assistant admins** are not designed; they are
  refused.
- **Text fit, fonts and picture loading are measured in the browser**; the
  Worker re-runs every other check at approval and treats the editor's measured
  blockers as additional blockers only.

### How to configure

1. **Nothing is required for manual work.** Designs, templates, exports and
   approval work without any key.
2. **To use AI with the existing Worker secret** (`ANTHROPIC_API_KEY`, already
   on the live Worker per DECISIONS row 262): open the studio settings as the
   owner, press «اختبار الاتصال», then choose a model from the live list (no
   model id is written in the repository; the choice is a D1 row). Optionally
   set the effort, the daily caps and the rates.
3. **To type a key in the settings instead** (owner decision pending, DECISIONS
   row 270): add the Worker secret `CREATIVE_STUDIO_ENC_KEY` in Cloudflare →
   Workers & Pages → `levonis-staging` → Settings → Variables and Secrets → add
   as **Secret**. Value: `v1:` followed by 32 random bytes in base64, e.g.
   `printf 'v1:%s' "$(openssl rand -base64 32)"`. Never reuse `KYC_ENC_KEY`. Then
   paste the key in the studio settings (a sign-in within the last ten minutes is
   required); only its last 4 characters are ever shown again. To rotate the
   vault key, append `,v2:<new value>` — the last key encrypts, older ones still
   open what they sealed.
4. **Rates** (optional): the provider's input and output prices per million
   tokens, with where they were taken from and the date. With rates, costs are
   shown as estimates and the USD caps apply; without them, only the request and
   token caps apply and no cost is shown.

## Editor (SPA)

`/admin/creative-studio` — `src/pages/CreativeStudio.tsx` (lazy, full-screen,
`AdminRoute`) and `src/components/creativeStudio/`. The admin sidebar's
«العضويات والتسويق / Growth» group has a «الاستوديو الإبداعي» tab (owner and
full admins; hidden from assistant admins) that opens a small launcher for the
route (`StudioLauncher.tsx`): sidebar entries are tabs, so navigating away on
select would have been the one entry that behaves differently.

### Done

- **Renderer** (`stageView.ts`): Konva 10.9.0 (pinned exactly; only
  `konva/lib/Core` plus the Text, Image, Rect, Ellipse, Line, Arrow and
  Transformer shapes). Layers are reconciled by stable id with a per-layer
  signature — a one-layer edit redraws one group; paint order is array order.
  Text is drawn in OUR lines (`wrapText` with the canvas measurer the layout
  engine and the quality check also use), wrapping off, direction from the
  words, physical alignment from the document's direction, no letter spacing.
  The frame handed to Konva is never narrower than a line (Konva otherwise
  cuts a fixed-width line mid-word). Pictures are same-origin only (product
  `/files/…`, studio assets through the studio route, the site logo through
  `src/lib/siteLogo.ts`), crop honoured, one scale. Soft shapes (the product's
  contact shadow) use a canvas shadow, which scales with the view.
- **Interaction**: click / shift-click / marquee; a click on a chip selects its
  group; a Transformer with corner anchors and kept ratio for pictures (no
  rotation for products and the logo), side anchors for text; a lock holds
  through the tree — a locked layer, anything inside a locked group, and a
  group with something locked inside cannot be selected, dragged, deleted or
  changed, by a person or by Claude (`packages/creativeDoc` refuses the same
  ops); a second finger cancels a drag cleanly and two fingers pinch and pan; drag with snapping to the safe area, the centre lines
  and other layers, guides on a layer that is never exported; arrows (Shift
  ×10), Delete, Ctrl/Cmd+Z, Shift+Z / Ctrl+Y, Escape, Enter; Ctrl+wheel and
  pinch zoom, wheel pan, zoom buttons and fit. Every edit is an operation run
  by `applyOps` as a person; an edit that creates a NEW conflict opens the
  conflicts dialog (`resolveConflict` options, re-layout options, or keep / undo).
- **Text editing**: a positioned `<textarea>` with the layer's font, size,
  line height, width and direction at the current zoom (double-click, Enter,
  or the «عدّل النص» button on a phone); Ctrl/Cmd+Enter or leaving keeps it
  (`set_text`), Escape drops it; bound text says why it cannot be typed into.
- **Panels**: layers (role names in three languages, the words a text shows,
  hide / lock / reorder), properties (exact px values, font size with its
  floor, one-factor scale, brand-palette swatches only, alignment, rotation,
  delete; caption and alt text when nothing is selected), assets (the bound
  variant's own same-origin pictures, approved assets, background presets,
  add text). Desktop (spec §16): the stage large, the chat and tools on the
  physical right in Arabic and English, layers in an aside that folds away at
  every width, properties only when something is selected; the stage survives
  crossing the 1024 px breakpoint (an iPad rotation). Phone: the stage owns the
  screen, everything else is a bottom sheet, 44 px targets.
- **History and saving**: undo/redo of whole documents (60 steps); autosave
  1.2 s after the last change with `base_version`; «محفوظ» only after a 200;
  failed / offline / conflict said plainly; 409 → open theirs or keep mine as
  a new design; a save whose answer was lost is checked against the server
  before anything is called a conflict; flush on tab hide, before leaving
  (leave guard and `beforeunload`) and before an AI request or a final export;
  a recovery draft in localStorage (content + base version only) — restored
  only onto the same server version, otherwise offered as a new design or
  deleted, never refreshed during a conflict. **Opening never writes**: bound
  text is drawn with the design's pinned brand kit (`brand_kit`), and when the
  store's data now differs the editor says so and offers «طبّق البيانات
  الحالية» as an ordinary, undoable edit.
- **Chat and pointing**: instructions scoped to the selection with what is
  inside it (named before sending) or explicitly design-wide; the request and
  its answer survive switching panels or closing the phone sheet, and leaving
  the editor cancels an unapplied answer; marks reach Claude with their
  position (a pin's point, a box, an arrow's ends and the layers under them);
  a re-layout an answer needs is named before Apply, and an answer that changes
  nothing is cancelled, never reported as applied; pin / box / arrow marks with a note,
  stored as document coordinates in `doc.annotations` through two new
  people-only operations, never exported; `POST /ai/edit` → the patch is
  re-validated here (`validateEditPatch` on this document and version) and
  shown as a diff (changed, moved, conflicts, reason, warnings, the question
  when Claude asks one) with Apply / Discard; Apply saves an `ai` version with
  the job id and calls `POST /jobs/:id/applied`; an answer for a version that
  moved on is dropped with a retry; Discard and «stop» are honest about what
  the server may still have done; AI not ready → the reason by code and a way
  to Settings, manual editing untouched.
- **Checks**: `qualityReport` with the real measurer, the fonts that really
  loaded, the pictures that really decoded and `POST /snapshots/:id/verify`;
  blockers / needs a look / suggestions, the checks that ran and the ones
  that did not, never a score; the optional visual review (owner-enabled)
  shown as advice.
- **Phone preview**: feed width (360 px) and a 3:4 profile-grid crop, from the
  export path, labelled as a simulation.
- **Export**: PNG / JPEG / WebP at exactly the document size (WebP checked by
  the blob's type), Project JSON (normalised, `schema_version`), import of a
  Project JSON as a new design, background-only when the background is an
  approved asset. Drafts download as «…-draft»; a final export needs zero
  final-mode blockers and the server's re-verification, is uploaded with
  `final: true`, and can then be approved.
- **Flows**: Home («شنو أنشر اليوم؟» opportunities with or without AI, ideas
  with their reason and evidence, recent drafts), New design (product →
  variant → same-origin picture → goal, priority, density, size, language →
  family (new arrival, back in stock, price offer, education, service; badges
  only with evidence) → template → up to three compositions, the chosen visual
  priority first, built with `buildFromTemplate` and drawn by the real renderer
  → choose; a design from Claude's composition or idea records the AI job),
  service posts from approved claims — written, revised and approved by the
  owner in the «الخدمات المعتمدة» tab, which also lists the designs using each
  claim — ideas showing audience, message, CTA, post type, composition, caption
  and alt text and carrying them into New design, «تحديث الكتالوج», other
  sizes as linked designs, variant / priority / density re-layouts, Brand
  (binding rules, preferences saved as a new version that stays on screen,
  any version viewable, a logo picker over approved logos, approval), Assets
  (upload with its real review state, delete), Archive (product, status,
  format and date filters, search, versions, side-by-side comparison, restore,
  duplicate as a draft), Settings (owner priorities; owner: key — password field,
  autocomplete off, cleared once saved, never stored in the browser — test,
  live model list, effort, budget, rates with source and date, vision review,
  usage; others read-only).
- **Fonts**: IBM Plex Sans Arabic 400/600/700 (complete builds, OFL-1.1,
  `public/fonts/ibm-plex-sans-arabic/LICENSE`) registered with the FontFace API
  only when the studio opens; nothing is measured or drawn before
  `document.fonts.load` answered for every family/weight in use; a face that
  fails is a visible warning and the `font_not_loaded` blocker.
- **Words**: every string in Arabic, English and Sorani, a sentence for every
  `ErrorCode` of the contract (`strings.ts`).
- **Tests**: `tests/creativeStudioUiStrings.test.ts`,
  `tests/creativeStudioUiModel.test.ts`, `tests/creativeStudioUiSource.test.ts`,
  `tests/creativeStudioUiRender.test.ts`, `tests/creativeStudioUiEditor.test.ts`,
  `tests/creativeStudioScreensModel.test.ts`; the package's own tests
  (`packages/creativeDoc/test/`: guards, locks, rebuild, compositions, sizes,
  structure, layout, quality); browser e2e
  `scripts/e2e-creative-studio.mjs` with `tests/browser/creative-studio*`
  (new design → editor; the Arabic headline, the mixed line, the test price
  and logo; overlay edit; transformer scale with the ratio held; save →
  reload; leaving with unsaved work asks first; PNG export pixel-identical to
  the stage at 1×; checks; an AI edit applied and saved with its job; a
  slow answer surviving a panel switch, with honest stop/discard; the
  1440 → 800 → 1440 breakpoint; a version conflict with no draft left
  behind; every other tab; phone and Sorani — 18 checks).
- **Bundle**: the studio is one lazy chunk (Konva inside it), nothing in the
  first paint. The studio asks its own leave question (StudioShell) instead of
  importing the dashboard’s `src/lib/leaveGuard.ts`, and `vite.config.ts`
  puts `src/lib/siteLogo.ts` (now read by the install sheet and the studio)
  in `vendor-icons`, which both already load — otherwise each became a
  sub-1 KB chunk of its own (`tests/motionLazy.test.ts` caps them at 45).

### 2026-10-27 — owner's live test: create, opportunities, several products, chat, house look

- **"Creating a post does not work"**: the API path worked (reproduced with the real
  Worker behind the real page, no model chosen). The failure was on the screen:
  «ابنِ التكوينات» built the compositions (or an error) BELOW the form, out of view,
  so the click looked like nothing happened; and with no AI a headline was required.
  New design now scrolls to the result or the error, and an empty headline falls back
  to the product's own name (manual creation needs no AI and no copy).
- Home opportunity rows are buttons: a product row opens New design on that product
  (offer → sell, arrival, back in stock), a service row on its claim, a topic row with
  its goal (`screensModel.opportunityPrefill`).
- **Several products** (`product_grid`, 2–4): New design «منشور عدة منتجات» picks the
  products; each is bound with its own snapshot (`main`, `p2`, `p3`, `p4`), picture,
  name and price. The comparison's `pair` layout became `pair | grid` (2–3 side by
  side, 4 as 2×2).
- **«محادثة»** on Home (`HomeChat.tsx`, `POST /ai/chat`): same adapter, budget and
  jobs; the last 12 turns are sent; `{reply, suggested_ideas[]}` checked by
  `validateChat` (`textProblems`: no price, link or unsupported claim — the whole reply
  is refused; a bad idea is dropped). A suggestion opens New design with its words.
  The 0216 CHECK lists six tasks and is not widened in place, so a chat job and its
  usage row are STORED as `ideas` (`jobs.ts storedTask`) — which also lets a design
  made from a chat idea link that job.
- **House look `levonis_gold`** (the owner's reference post), New design's default:
  near-black stage, gold and red light arcs, logo + wordmark + tagline, the brand in
  white and the model in gold (bound `brand` / new `model` field), «بسعر» + the bound
  price in gold, the product on a podium with a gold rim, the site address in a gold
  pill. Drawn by `layout.ts buildHouse` with shapes; documents gained optional
  `gradient` (shapes, text) and `knockout: 'white'` (product pictures — a flood fill
  from the edges in the renderer, `knockout.ts`; the content box is the crop, not a
  detail shot). The fixed words are `source: {kind: 'brand'}` (`BRAND_TEXT`): the
  checks accept the site address because the app writes it, a changed one is
  reported, and nobody can retype it. `HOUSE_PALETTE` is part of the approved look.
- Not done here: the grid has no house-look variant; the logo is drawn with its own
  black square; the e2e «leaving the editor asks first» check was already failing
  before these changes.

### Not done

- Phase 4 is built (2026-10-27; migration `0217_creative_studio_planning.sql`
  adds `creative_campaigns` and `creative_document_plans`): tabs «كاروسيل»
  (Claude's plan or empty slides → linked `slide` designs, export all as draft
  PNGs), «إنتاج دفعة» (sequential, no AI, per-item state, stop, retry failed),
  «الحملات», «التقويم والشبكة» (Baghdad day, Saturday-first month, 3-column
  grid simulation). Not done in it: a planned day does NOT move a design to
  the `scheduled` status (approval semantics untouched); no week view; no
  manual entry of past real posts beside the grid; no time of day; batch has
  no family choice and one shared headline; a duplicated slide joins its
  source's carousel group (duplicate sets `parent_id`); no browser test of
  the four screens. External publishing is not built and the screens say so.
- Swapping a design's product, and «use this as a reference»; the editor's
  re-layouts still pass no template family; archive filters by variant
  or family (campaigns have their own tab).
- Touch gestures (pinch during a drag, two-finger pan) are fixed in code but
  have no automated touch test.
- Comparison posts (two products) have no picker of their own; New design's
  «منشور عدة منتجات» (product_grid) covers 2–4 products.
- Rebinding a design to a FRESH snapshot after a source change (the checks
  block the final export and say what changed; a new design is the way today).
- Group / ungroup, distribute, and a crop editor (crop is honoured when
  drawing; `set_crop` exists but has no handles).
- The advanced engines (generation, background removal, 3D, OCR) are listed
  as not connected.

### Known limits

- Tested in Chromium (Playwright, headless) only; Safari and Firefox are not
  verified — `ctx.direction` and canvas shadows there are untested.
- `client.ts` reads a DTO either spread or under its name and refuses anything
  else as `INVALID_RESPONSE`; `tests/creativeStudioContract.test.ts` and
  `tests/creativeStudioScreensContract.test.ts` drive the real client into the
  real router, so a path or field mismatch fails a test.
- `POST /ai/edit` is a single request: «stop» aborts the browser's wait, but
  without a job id yet the server is not told; its late answer is never applied,
  and the screen says that a request already sent may still be charged.
- The price, link and claim guards are a pattern check (see
  `docs/CREATIVE_STUDIO.md`), not a proof that no wording slips through.
- A soft shape that is rotated is drawn crisp with a halo (the canvas-shadow
  technique needs an unrotated shape); templates never rotate shadows.
- The recovery draft lives in this browser's localStorage only.
