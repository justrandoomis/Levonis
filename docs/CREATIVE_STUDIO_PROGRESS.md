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

### Built (migration `0215_creative_studio.sql`)

| Part | Where | What it guarantees |
|---|---|---|
| 18 studio tables | `migrations/0215_creative_studio.sql` | additive only (`CREATE … IF NOT EXISTS`); no store table is written; no column for a prompt, an answer or a key in the usage ledger |
| The API (55 routes) | `worker/routes/adminCreativeStudio.ts` at `/api/admin/creative-studio` | apex only; `requireAdmin` → rate limit → studio scope (owner + full admins; assistants `403 CREATIVE_SCOPE_REQUIRED`) or `requireOwner` (key, model, budget, rates, brand kit, claims, JSON import); shapes = `packages/creativeDoc/src/api.ts` (response envelopes at its end) |
| Provider adapter | `worker/lib/creative/anthropic.ts` | the only reader of a key; raw `fetch` through an injectable transport; one host; `redirect: manual`; per-task deadlines; 512 KB body cap; `anthropic-version: 2026-10-21`; structured outputs; effort only when the model lists it; never `temperature`/`top_p`/`top_k`, tools or prefill; 429 retried once (≤ 5 s), 503/529 once, a timeout never; every failure a code |
| Key vault | `worker/lib/creative/keyVault.ts`, `worker/lib/sealbox.ts` | AES-256-GCM under `CREATIVE_STUDIO_ENC_KEY` (rotation ring), ciphertext bound to its row (AAD); 4-character hint for the owner only; stored key first, then the Worker secret |
| Prompts | `worker/lib/creative/prompts.ts` | the §28 rules; data in tagged blocks with `<` escaped; product facts through an allow-list without amounts, links or picture URLs; copy in Arabic or English only — never Sorani |
| Budget | `worker/lib/creative/budget.ts` | one conditional UPDATE reserves the worst case (requests, tokens, USD with rates, parallel calls); settled with real usage, released when the provider did not process the request, the worst case kept when the outcome is unknown; a crashed reservation is released after 5 minutes |
| Jobs | `worker/lib/creative/jobs.ts` | idempotency (same key + same request = stored result, no second call; different request = 409), cancel, applied once; a cancelled job's late result is never stored as usable |
| Store connector | `worker/lib/creative/store.ts` | read-only, through the public card path (`pricingCtxForUser(db, null)`, `resolveListingCards`, `priceFromCard`, `cardAvailability`, `resolveVariantPricing`); an allow-list snapshot with a sha256 hash; unpriced never 0, pre-order never available, membership teaser apart |
| Opportunities + catalogue watch | `worker/lib/creative/opportunities.ts` | live public offers, arrivals after the baseline, back-in-stock from a recorded unavailable → available, coverage gaps (30 days), approved claims, education topics, owner priorities, recent approved designs; the first whole sync pass is a baseline that announces nothing |
| Designs | `worker/lib/creative/documents.ts` | `normalizeDocument` on every write and read; `VERSION_CONFLICT` instead of overwriting; versions at meaningful points (AI, restore, template, relayout, import, checkpoint, ≥ 10 min), 50 kept, approved and final-exported versions never pruned; approval of one version, invalidated by any later content change; approval and a final export re-verify every binding against the store now (`SOURCE_CHANGED`) and re-run the server's checks (`QA_BLOCKERS`) |
| Files | `worker/lib/creative/files.ts` | PNG/JPEG/WebP by magic bytes only (SVG and animated refused), 15 MB, header-only dimensions, stored byte-for-byte in the private bucket under `creative-studio/…`, served `private, no-store` with a sandbox CSP |
| Registries | `packages/contracts/src/ownership.ts` (owner `ads`), `worker/lib/mediaRefs.ts` (the `r2_key` and design columns are media sources), `worker/lib/productDeletion.ts` (studio history keeps its rows), `worker/lib/schemaVersion.ts` (208), `worker/lib/storeLayout.ts`, `tests/routeClass/creativeStudio.ts`, role matrix, gateway routing, `services/gateway/src/uploadClasses.ts` (the two 15 MB upload doors), `tests/listingPredicateGuard.test.ts` (the connector's VISIBLE/SELLABLE calls, counted; `docs/PRICING-V2.md` §9) | the repository's sweeps cover the studio from day one |

Tests: `tests/creativeStudioProvider.test.ts`, `tests/creativeStudioAi.test.ts`,
`tests/creativeStudioDocuments.test.ts`, `tests/creativeStudioStore.test.ts`
(the role-matrix, deploy-ahead and host-guard sweeps walk every studio route too).

### Not built yet (Worker side)

- **No external publishing or calendar** (spec §25–26): there is no
  scheduling table and no publisher; `scheduled`/`published` statuses exist in
  the schema only so a later integration needs no migration.
- **No batch creation** (spec §21): every AI request is one request; there is no
  queue or cron-driven batch, and the parallel limit applies per request.
- **The catalogue watch runs when someone presses sync** (`POST /watch/sync`, a
  bounded page per call). No cron drives it yet; adding one is a new cron entry
  and dispatch branch (`tests/scheduledCronDispatch.test.ts`).
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
