# Bambu Lab one-time import — handoff plan (work stopped 2026-10-15 ≈20:20 UTC on the owner's request)

## ملخص للمالك

**تحديث 2026-10-16: كل شيفرة الاستيراد حيّة الآن على levonis-iq.com**
- ظهور المنتجات بلا سعر و«طلب السعر» (الترحيل 0193)، وأساس الاستيراد (0194 و0195).
- تحسينات الحزمة، والخطوة 5 (بحث الأسماء البديلة وبوابة المخزون).
- الخطوة 6: الكاتب ونقطة الاستيراد المحمية (`a2d9e73`).
- الخطوة 7: تبويبات المعرفة في صفحة المنتج والبطاقات والمقارنة والمرشّحات ولوحة الاستيراد (`c9265b0`).
- الخطوة 8: المشغّل وكل أوضاع سير العمل 60 (`1431708`).
- كل خطوة مرّت بالفحص الكامل وبمراجعة مستقلة ثم بسير العمل 7 أخضر.

**قرارك (2026-10-16):** المنتجات الـ14 المخفية التي تقابل منتجات Bambu تُدمج بياناتها الرسمية وتُنشر بلا سعر (الصف 242).

**ما تبقّى بالترتيب:**
1. ملفات البيانات المراجَعة: المطابقة (جاهزة)، والطابور والهويات والصور والمرادفات، وملفات المنتجات الـ92 المنسّقة.
2. تجربة محلية، ثم منتج تجريبي واحد على الإنتاج (`filament-buffer`).
3. فئات التدقيق الثماني.
4. الاستيراد الكامل للمنتجات منتجاً واحداً في كل مرة، ثم تقرير التغطية.

---

## 0. Read first (next agent)

1. `CLAUDE.md`: work on the default branch `claude/new-session-2hq4ci`. Every non-docs push deploys live through workflow 7.
2. `docs/DECISIONS.md` rows 239 (owner answers), 240 (catalog-only) and 241 (import foundation).
3. **`docs/bambu-import/IMPORT-SPEC.md`**: the FINAL implementation spec.
   - §K.2 is the 15-step build plan; §K.3 is workflow 60; §A is the write route; §B is the schema; §C is mapping; §D is taxonomy; §E covers existing products; §G is the UI; §H is the dashboard; §I is verification.
   - It cites `file:line` positions from an older tree, so re-locate code by name.
4. **`docs/bambu-import/p0/`**: the P0 data drafts built from the 1,115 crawled pages. They are reviewed drafts, not yet copied to `data/bambu-import/`.

   | File | Contents |
   |---|---|
   | `manifest.json` | The queue: 1,115 rows with position, type, leaf, `hold_code`, `value_labels`, plan estimate |
   | `taxonomy-map.json` | Section mapping. Its `snapshot_sha256` is still to be set (§3.5) |
   | `compat-targets.json` | Compatibility targets, with entries marked `resolve_from: step2_snapshot` still to resolve |
   | `identity-map.json`, `media-overrides.json`, `search-synonyms.json` | Identity keys, image overrides, search synonyms |
   | `scans.md` / `scans.json` | Corpus scans |
   | `owner-questions.md` | Every owner question with its safe default. **§E lists the integrator items.** |
   | `parse-report.json` | 1,113 ok, 2 holds |
   | `crawl.py` | The polite crawler (≥ 11 s spacing, robots.txt; never bypass the 403 "Just a moment" challenge) |
   | `tools/*.py`, `work-step4/*.ts` | Corpus tooling (`verify.py` runs 34 checks) |

   The 182 MB crawl corpus (`raw/<handle>.html.gz`) was **not** saved. To regenerate it, run `crawl.py`: about 3.4 h at the polite rate, resumable, with `MAX_FETCH` batches.
5. **`docs/bambu-import/agent-briefs/`**: the exact prompts used for the parallel lanes.
   - `lane-A-steps-5-6.workflow.js` holds the STEP5, STEP6A and STEP6B briefs, two reviewer lenses and the fix brief.
   - `lane-B-C-step7-and-package.workflow.js` holds B7A, B7B, the package brief C, and the reviewers and fixers.
   - `mkwt.sh` creates a worktree with shared `node_modules`; `watch-run.sh` and `watch-deploy.sh` follow CI and workflow 7.
   - Reuse these briefs verbatim: they are the specification of the remaining lanes, adjusted for what is already done.

## 1. Live state (default branch)

**Tip:** `63c66514` (docs) on top of `98b8501e` (workflow 60).

| Commit | What | Live |
|---|---|---|
| `711d1b9e` | Catalog-only + «طلب السعر» (0193, row 240) | yes |
| `30215957` | Workflow 7 waits for the new Worker before probes | yes |
| `e95cdc35..c65cdf58` | **Step 4**: 0194 knowledge model, 0195 run ledger + generated guard triggers, `packages/catalog/src/bambuImport`, deletion registries, two test fixes, shard timings | deployed 19:47 UTC, 21 probes / 0 failed; health `0195_catalog_import_runs.sql` 188/188 |
| `f58956ae`, `8623650b`, `98b8501e` | **Step 2**: `seal.mjs` / `unseal.mjs`, `cf.mjs` (the only code holding Cloudflare credentials), `.github/workflows/bambu-import.yml` (modes `snapshot` and `revoke`; other modes exit "not yet") | landed; workflow 7 run 38799161718 started (verify it ended green) |

- **Restore point** before 0194/0195: `0000162d-0000006e-00005105-46aed4dbc52a01040b2de5a0d8bc24e1`. Never restore after live writes.
- The first **snapshot dispatch** (run 38799215746) was green. It read 43 products (26 active, 1 draft, 16 hidden), 34 catalogs, 7 brands (`bambu-lab` exists), 85 memberships, 110 option values, 205 colours and 47 Bambu image sources.
- The unsealed snapshot and its private key lived only in the old sandbox and are gone **by design**. Take a new snapshot (§4.3); never commit one.

## 2. The build plan (spec §K.2): status

| Step | What | Status |
|---|---|---|
| 1 | Catalog-only + D-1…D-7 | **done, live** |
| 2 | Workflow 60 skeleton, sealing | **done, live** |
| 3 | P0 data | done except **(e) existing-matches** (§3.5) and **(g) curated files** (spec §F: canary + audit classes first) |
| 4 | Schema 0194/0195 + package | **done, live** |
| 5 | Search aliases + import stock gate | **WIP**, branch `wip/import-ops` (§3.1) |
| 6 | Ops endpoint, writer, admin API | not started (briefs STEP6A / STEP6B) |
| 7 | Customer UI, knowledge route, cards, compare, facets, dashboard | **WIP 7a**, branch `wip/import-ui` (§3.2); 7b not started |
| — | Package follow-ups (owner-questions §E 1, 2, 5, 7, 9) + H-1 fix | **done, unreviewed**, branch `wip/import-pkg` (§3.3) |
| 8 | Runner + every workflow 60 mode | not started (§3.4) |
| 9 | Reviewed data commit (`data/bambu-import/*.json`, curated) | not started |
| 10 | Dry runs: in-process, local workerd, workflow `dryrun` | not started |
| 11 | Preflight, open, canary `filament-buffer` | not started |
| 12 | The 8 audit classes, one at a time with the §K.4 review | not started |
| 13 | Bulk run (`max_items=0 chain=true`), about 17–30 h | not started |
| 14 | Close + sealed coverage report + DECISIONS/HANDOFF | not started |
| 15 | Cleanup (later) | not started |

## 3. Saved work-in-progress and how to resume each lane

All three WIP branches are based on `096f2b59` (step 4 before its CI fixes).

- **First:** `git rebase origin/claude/new-session-2hq4ci`.
- **Expect** CI-fix conflicts in `tests/priceProtectionAtomicity.test.ts` and `scripts/test-timings.json`; keep the default branch's side.
- **Then:** review the WIP commit and finish.

**Landing procedure (every lane):**
1. `npm run check`, plus every changed test file and its neighbours.
2. Push to `ci/<lane>`. That is full CI without a deploy.
3. If only `tests/rootShardBalance.test.ts` fails because of new test files, regenerate `scripts/test-timings.json` with `node scripts/update-test-timings.mjs <unzipped run logs>` and commit it.
4. Fast-forward `claude/new-session-2hq4ci` and follow workflow 7 to green.
5. Append the lane's commits to DECISIONS row 241 and to `docs/HANDOFF.md`.

### 3.1 Lane A — steps 5 then 6 (`wip/import-ops`, WIP commit `ef9fa54d`)

- **Brief:** `agent-briefs/lane-A-steps-5-6.workflow.js`, constants `STEP5`, `STEP6A`, `STEP6B`.
- **Saved, partial, unreviewed, may not compile:**
  - new: `worker/lib/search/aliases.ts`, `worker/lib/importStock.ts`, `worker/lib/catalogKnowledge.ts`, `src/components/adminProducts/form/ImportStockCard.tsx`, `tests/searchAliases.test.ts`;
  - edited: `search/document.ts`, `search/store.ts`, `productPersistence.ts`, `pricingEngine/v2/{write,api}.ts`, `pricingEngine/{autoReprice,ratePreview}.ts`, `routes/adminProducts.ts`, `routes/adminProductRelations.ts`, `contracts/costRefusals.ts`, `ProductForm.tsx`, `types.ts`, `tests/{fxSweepBudget,search,searchBackfillBudget}.test.ts`.
- **To finish step 5:** search aliases, `INDEX_STAMP '#doc:5'`, the V2-write fence `IMPORT_STOCK_NOT_CONFIGURED`, `PUT /api/admin/products/:id/import-stock-decision`, the product-form card, and the tests `searchAliases`, `importStockDecision`, `programmeRefusals`, the role matrix and `fxSweepBudget`. Every path that can make a product sellable through V2 must be fenced.
- **Then** steps 6a (writer library) and 6b (HTTP layer), then the two adversarial reviews (security, correctness), then fixes.
- **Integrator item for 6a (owner-questions §E.4):** batch the side-table INSERTs as multi-row INSERTs of ≤ 100 bound parameters each. Otherwise `pla-basic-filament` (~906 statements) exceeds the 900 budget.

### 3.2 Lane B — step 7 (`wip/import-ui`, WIP commit `f6c787a1`)

- **Brief:** `agent-briefs/lane-B-C-step7-and-package.workflow.js`, constants `B7A` and `B7B`.
- **Saved, partial 7a (server reads):**
  - new: `worker/lib/knowledge/`, `tests/{productKnowledgeRoute,productCardKnowledge,compareKnowledge}.test.ts`, `tests/fixtures/knowledgeModel.ts`;
  - edited: `routes/products.ts`, `routes/compare.ts`, `lib/productOverlay.ts`, `lib/productRelations.ts`, `lib/compareSpecs.ts`, `lib/edgePolicy.ts`, `docs/PRICING-V2.md`, and tests.
- **To finish 7a:** `GET /api/products/:slug/knowledge` (VISIBLE-gated; no `store_page` ref, no owner rows, no CBM), the relations view's swatch/group 0194 columns and `via_variant_id` with no new D1 wave, card `key_specs` / `section_name`, compare cells, facets, the completeness query.
- **Then** 7b (client: gallery rule incl. `via_variant_id`, default preselection, swatches, `ProductKnowledgeTabs` lazy, card line with measured bundle numbers, dashboard with no skip control, Playwright screenshots), then review and fix.
- Step 7 must be live before step 11.

### 3.3 Lane C — package follow-ups (`wip/import-pkg`, 5 commits, clean)

| Commit | What |
|---|---|
| `d40928de` | H-1: `availabilityFromName` reads "direct" as an order type only as a word of its own. **Verified against the live snapshot: 0 of 358 existing option/colour/product names change.** Unblocks `cyberbrick-omnidirectional-forklift`. |
| `b87cb399` | §E.1: reviewed `value_labels` applied in the option model before media binding (`ams-2-pro` "Bundle Deals" → «باقة ترقية (تشمل الملحقات)» / Upgrade bundle (accessories included) / «پاکێجی بەرزکردنەوە (لەگەڵ پێداویستییەکان)») |
| `709d581e` | §E.2 / §E.9: "A1 Series" per subject; printer questions read by the reviewed labels |
| `6d93bc3d` | §E.5: description format E read whole |
| `42432274` | §E.7: the top unknown spec labels join the registry |

- **Remaining:**
  - brief item 8: re-run the whole-corpus parse after re-crawling, target 1,115 ok;
  - item 4 (§E.6 `ams-2-pro` media rule): confirm it is settled;
  - the adversarial review, using lens `LENS_PKG` from the brief;
  - land it first: it is package-only, and the Worker does not import the package yet.

### 3.4 Step 8 — the runner (not started; worktree was `import/runner` on `63c66514`)

**Brief (as given):**

- **Files:** `scripts/bambu-import/{run,discover,fetch,robots,enrich,wiki,tracker,log,summary,verify,browser,deadline,opsClient,match-candidates}.ts`, and `.github/workflows/bambu-import.yml` with every mode:
  - `preflight`, with its Time Travel bookmark;
  - `open`: creates the run row `cir_` + 24 hex, mints the per-job 256-bit token into a 0600 file, and stores only its SHA-256 via `cf.mjs`;
  - `run` with `max_items`, `resume` and `chain`;
  - `close`, `report`, `dryrun`, `withdraw`, `revoke`;
  - the `always()` revoke after any mode that minted a token;
  - the chain job: `actions: write`, no checkout, no npm, validated inputs, `chain_count < 12`.
- `scripts/e2e-bambu-import.mjs` (the local workerd dry run).
- **opsClient:** written strictly to the spec §A.3 table and tested against a FAKE ops server with a fake clock (`tests/bambuImportRunner.test.ts`). It must cover:
  - retries, and a BLOCKED item stopping the loop;
  - resume;
  - every §A.7 deadline rule (`/write` is never started with < 13 min left);
  - EXTRACT never before the previous COMPLETE;
  - ≥ 11 s between store requests;
  - robots.txt.
- **Bot challenge:** never bypass it; a 403 challenge is a retryable stop.
- **Logs:** the allow-list logger, plus `tests/catalogImportLogs.test.ts` with planted secrets. Every artifact is sealed.
- `match-candidates.ts` reproduces the §E.1 candidate set.

### 3.5 P0 step 3(e) — existing-matches (not started; private data)

1. Take a fresh snapshot (§4.3) and unseal it **in the sandbox only**.
2. Candidates by brand, model tokens, Bambu image source URLs and slug/handle overlap. The last session found **31 Bambu-model products**:
   - 16 are **active**: the 15 PLA/PETG filaments and accessories, plus the H2C, H2D and P1S printers and the H2/P2S/X2D standard-flow hotend. Decision: `merge`.
   - 15 are **owner-hidden**. Default `hold_owner_hidden` (spec L-7), queued last. Owner question pending; the recommendation is `merge_publish`.
   - One **open-box X2D** listing: `distinct` (a used unit, not the new product).
   - Two hidden Levonis tungsten-carbide hotends against the single Bambu `tungsten-carbide-nozzle-h2-p2s`: decide from its parsed options.
3. Build `value_map` per merge (Bambu variant id → existing option value ids or `product_colors` id, by exact names) and `unmapped_variants`.
4. Write `existing-matches.json` in the §E.1 shape: ids, decision and reason only, and slugs **only for active** products.
5. Resolve the `compat-targets.json` entries marked `resolve_from: step2_snapshot`.
6. Set `taxonomy-map.json` `snapshot_sha256` to the sealed file's SHA-256, and check that referenced catalog ids exist and new slugs are free.
7. Extend and run `tools/verify.py`.

## 4. Procedures

### 4.1 Worktrees

`agent-briefs/mkwt.sh <path> <branch> <base>`: a git worktree whose `node_modules` entries are symlinks into `/home/user/Levonis/node_modules`, with `@levonis/*` pointing at the worktree's own packages. Never run `npm install` inside one.

### 4.2 CI and deploy

- `ci/*` side branches run the whole CI with no deploy.
- Workflow 7 runs on the default branch: verify-all (16 shards) → fresh → migrate-check `--twice` → bookmark → migrations → deploy → probes.
- Job logs: `mcp__github__get_job_logs` with `return_content:false` gives a URL; curl that URL.
- The run log archive: `mcp__github__actions_get get_workflow_run_logs_url`.

### 4.3 A sealed snapshot

1. `node scripts/bambu-import/seal.mjs --keygen <dir outside any checkout>`. It prints the 43-character public key and writes a 0600 `.pem`.
2. Dispatch: `POST /repos/justrandoomis/Levonis/actions/workflows/bambu-import.yml/dispatches` with `{"ref":"claude/new-session-2hq4ci","inputs":{"mode":"snapshot","seal_pubkey":"<key>"}}`.
3. Download artifact `bambu-import-sealed`. Use `actions_get download_workflow_run_artifact`, then curl into a new empty directory.
4. Check `sha256sum` against the log.
5. `node scripts/bambu-import/unseal.mjs --key <pem> snapshot.sealed snapshot.json`.

## 5. Owner questions (a safe default is in force for each)

- **15 owner-hidden Bambu products.** Default: hold, queued last, so the run closes "partial". Recommended: `merge_publish`, which publishes them unpriced with official data; names, prices and stock are unchanged.
- **Tungsten-carbide 2-to-1 case.** Decide when building the matches file.
- **Q7: pricing of bundles and mystery offers in USD.** Unanswered; compositions stay hidden.
- **P0-2:** the Sorani names of the four seeded «مواد الصيانة» shelves are empty (since 0148).
- **P0-1 … P0-11 and L-1 … L-21:** see `p0/owner-questions.md`. The defaults are in force.

## 6. Never

- **Privacy:**
  - Never commit or upload a snapshot, a private key, the match candidates, or names/slugs of non-active products.
  - The repository is public.
  - Logs print counts, codes and public URLs only.
  - `IRAQ_PARALLEL_FX_API_KEY` appears nowhere, and no cost value appears in any log.
- **Source data:** never write a price, cost, stock, package/weight, warranty or offer value from the source; an unpriced product shows `null`, never 0.
- **Bambu store:** never bypass a bot challenge, never ignore robots.txt, never fetch store pages faster than 11 s apart.
- **Queue:** one product at a time with a live check before the next; no SKIP; a BLOCKED item stops the queue.
- **Migrations and history:** additive migrations only; never rewrite old orders, wallet, lots or costs; never force-push the default branch.
