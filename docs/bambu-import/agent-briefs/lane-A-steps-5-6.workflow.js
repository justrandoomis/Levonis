export const meta = {
  name: 'bambu-steps-5-6',
  description: 'Bambu import steps 5 and 6 in /home/user/levonis-ops: search aliases + stock gate, then the import writer library, then the ops/admin HTTP layer; adversarial review; fix',
  phases: [
    { title: 'Step 5', detail: 'search aliases + stock gate' },
    { title: 'Step 6a', detail: 'writer library' },
    { title: 'Step 6b', detail: 'ops endpoint, media, publish-finish, complete, admin API, e2e' },
    { title: 'Review', detail: 'security lens + correctness lens' },
    { title: 'Fix', detail: 'fix confirmed findings' },
  ],
}

const SP = '/tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad'
const SHARED = `
SHARED CONTEXT
- Repo: Levonis (Cloudflare Worker + Hono + D1 + R2 + the IMAGES binding; React 19 + Vite + Tailwind v4). The GitHub repository is PUBLIC.
- Task: the owner's one-time Bambu Lab catalogue import (1,115 us.store.bambulab.com products imported as native, catalog-only products: no price, no cost, no stock from the source). Owner decisions: docs/DECISIONS.md rows 239, 240, 241 (read them).
- THE SPEC (FINAL): ${SP}/bambu/import-spec.md (235 KB). Read the sections named for your step and grep it for cross-references. It cites file:line positions from an older tree; re-locate code by name.
- P0 data: ${SP}/bambu/p0/ (crawled pages in raw/<handle>.html.gz, manifest.json, taxonomy-map.json, compat-targets.json, identity-map.json, media-overrides.json, search-synonyms.json, scans.md, owner-questions.md whose §E lists integrator items, parse-report.json).
- Your base: commit 096f2b59 = the live default branch (30215957: Pricing V2 clean start, Services S-P2, catalog-only visibility + «طلب السعر» with migration 0193) + Bambu step 4 (migrations 0194_catalog_knowledge.sql and 0195_catalog_import_runs.sql with generated guard triggers; packages/catalog/src/bambuImport with extraction, mapping, payload allow-list and fingerprints; product deletion registries). Step 4 is about to land on the default branch unchanged.
- Worktree: /home/user/levonis-ops, branch import/ops. Work and commit ONLY there. node_modules are symlinks into /home/user/Levonis/node_modules: never run npm install / npm ci.
- Never push, never touch any remote or the default branch, never contact levonis-iq.com, bambulab.com or any production system: tests are local only.
- Commits: linear history, no merges, no amend of commits you did not make. Every commit message ends with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01D5ebj3qaF1mdriu93x6s5r
  No model names anywhere in the repository.
- Languages: every user-facing string exists in Arabic, English and real Sorani Kurdish (ckb); a ckb slot never copies the Arabic (DECISIONS row 183). You write the translations yourself (no external translation service, row 2).
- Money and privacy: the import never writes a price, cost, stock, package/weight or any other financial column; no cost value in any log; the string IRAQ_PARALLEL_FX_API_KEY never appears anywhere. Customer-facing answers carry no cost, margin, supplier price or stock fact, and no owner-only provenance (store canonical_url, store_page source refs, swatch source_url).
- No new migration. Every new read of a 0194/0195 table or column tolerates its absence through a presence probe (an older database can run newer code; CLAUDE.md rule 2) — test that path.
- Gates before you finish: npm run check exits 0, and every test file you added or changed plus the existing neighbours of every module you touched pass (npx tsx --test --test-concurrency=4 <files>; grep tests/ for the module names). The full suite (about 1,040 files, 2 h) runs later in CI, so choose neighbours generously. Report exact pass/fail counts.
`

const STEP5 = `${SHARED}
YOUR JOB: BUILD STEP 5 — shared search aliases and the import stock gate.
Read: spec §K.2 "Step 5", §C.1 "Search aliases", §B.10, §C.11, §G.5 "Search". Then the code: worker/lib/search/ (document.ts toSearchDoc, store.ts INDEX_STAMP + searchDocsForRows/backfillSearchIndex), worker/lib/productPersistence.ts (planProductSave search tokens), worker/lib/pricingEngine/v2/write.ts (v2WriteStatements), worker/lib/operations.ts (fence helpers), tests/fxSweepBudget.test.ts, the product form (src/components/adminProducts/), the refusal catalogue that tests/programmeRefusals.test.ts checks, tests/routeClass/ and the role-matrix tests.
Build:
1. worker/lib/search/aliases.ts: loadSearchAliases(db, productIds) -> Map<productId, string[]>, reading product_external_ids (searchable = 1) and product_spec_values rows identity.model / identity.series, one statement per <= 90 ids; an empty map when 0194 is absent (use the codebase's existing table-presence probe helpers).
2. toSearchDoc gains aliases (indexed in the model field with the variant names). planProductSave uses the loader by default and accepts an explicit intent.searchAliases (the step 6 writer passes it because its own batch writes the aliases). searchDocsForRows / backfillSearchIndex use the loader. INDEX_STAMP becomes '#doc:5' in the same commit; extend tests/fxSweepBudget.test.ts so the quarter-hour tick stays under its limit with the alias read included.
3. The stock gate (§B.10): v2WriteStatements prepends the fence NOT EXISTS (SELECT 1 FROM product_source_refs WHERE product_id = ? AND stock_decision = 'not_configured'), only when a presence probe finds 0194; a miss answers 409 IMPORT_STOCK_NOT_CONFIGURED (ar/en/ckb). Find EVERY path that can make a product SELLABLE through Pricing V2 (product-form publish, procurement apply, save-bulk, FX-5 auto-reprice, TXT round trip, any other writer of the V2 published state) and prove each is refused for a not_configured product (tests), or explain in your report why a path cannot reach it.
4. PUT /api/admin/products/:id/import-stock-decision {decision: 'tracked' | 'untracked'}, behind the same permission as editing stock in the product form; 'tracked' requires a non-null stock at the level inventory_mode makes authoritative, else 400 IMPORT_STOCK_TRACKED_EMPTY; it writes stock_decision, stock_decided_by, stock_decided_at and an audit row. Register it in the route-class registry and the role matrix. Note the 0195 guard triggers: this route runs outside an import batch, so they do not fire — confirm with a test.
5. The admin product GET exposes the stock decision (staff-only; never in a customer DTO). The product form shows the card «إعداد المخزون للمنتج المستورد» / "Stock setup for an imported product" / «ڕێکخستنی کۆگا بۆ بەرهەمی هاوردەکراو» with the two choices of §B.10, only for a product whose decision is not_configured; the V2 pricing panel shows the refusal text instead of the publish button while it is missing. Follow .claude/skills/apple-design/SKILL.md and the Clay primitives (tests/claySystem.test.ts).
6. Tests: tests/searchAliases.test.ts and tests/importStockDecision.test.ts exactly as §C.1 and §B.10 describe, extended fxSweepBudget, programmeRefusals (the two new codes in three languages), route class / role matrix.
Invariants: the SELLABLE predicate is unchanged (tests/listingPredicateGuard.test.ts untouched and green); a product without a product_source_refs row is never gated; a database without 0194 behaves exactly as today (test it).
Commit as "bambu import step 5: ..." (one or two commits).
Return a plain report: what you built (files), commits (hashes + subjects), tests run with pass/fail counts, every deviation from the spec with the reason, and open questions.`

const STEP6A = `${SHARED}
YOUR JOB: BUILD STEP 6a — the import WRITER LIBRARY (no HTTP routes yet; a second agent builds the routes on top of your library right after you).
Step 5 is already committed in this worktree (search aliases + stock gate): read git log -5 and its report below.
STEP 5 REPORT:
<<STEP5>>
Read: spec §A.4, §A.5, §A.6, §A.10 (unpublish batch), §B.3–§B.6, §B.8, §B.9, §B.10, §C.2–§C.11, §D.2–§D.3, §E.1–§E.4, and owner-questions.md §E item 4. Read packages/catalog/src/bambuImport (payload.ts with assertImportPayload, fingerprint.ts, the README) — the payload it produces is your input — and worker/lib/productPersistence.ts (planProductSave, preflightProductSave, saveProductAtomic, RequestedRelations), worker/lib/productModel.ts (validateProductDoc), worker/lib/productMediaWrite.ts, worker/routes/adminImport.ts (uniqueProductSlug), worker/lib/quarterHourBudget.ts (D1_INVOCATION_STATEMENT_LIMIT), tests/fixtures/d1Limits.ts (LimitD1), worker/lib/catalogImport/protectedTables.ts and migrations 0194/0195.
Build in worker/lib/catalogImport/:
- doc.ts: newImportProductDoc (§A.4) with a unit test asserting every money, stock, package, warranty, ops, offer and condition field is the schema default or null.
- budget.ts: the counting D1 proxy and IMPORT_INVOCATION_LIMIT = 900 (§A.5).
- writer.ts: planImportWrite / runImportWrite for create and merge exactly as §A.4/§A.5: reviewed-scope checks as pure functions taking the reviewed bundle as an argument, brand + taxonomy resolution read from D1, deterministic ids (§B.8), bv- variant keys, translations, catalogIds, printerFits, actor {adminId: 'system:catalog-import', money: false}, allowComposition false, preflight + media verification + planProductSave reuse, the side statements (option-group 0194 columns, product_source_refs with stock_decision not_configured on create, product_option_source_refs with binding_rule and via_variant_id, product_spec_values, product_documents, product_external_ids, product_relations, product_option_value_swatches), incoming pending-relation resolution, guard row first and last, the lease-fenced WRITTEN event and checkpoint, per-table fingerprint SELECTs before and after for merges, the money-default probe for a new product, explicit intent.searchAliases (step 5).
- PLAN BUDGET (integrator item §E.4 — yours): with one statement per side row pla-basic-filament estimates ~906 statements (> 900) and would BLOCK PLAN_TOO_LARGE. Batch the side-table INSERTs as multi-row INSERTs of <= 100 bound parameters each, verified through LimitD1 (check what it enforces for multi-row VALUES), so the estimate drops to about 643. Prove it with a test that builds the plan for the real pla-basic-filament page (${SP}/bambu/p0/raw/pla-basic-filament.html.gz through the step 4 package; if you add a fixture to tests/fixtures/bambu keep it trimmed, <= 200 KB) and asserts the invocation estimate.
- unpublish.ts (§A.10 batch), verifyD1.ts (the Worker-side D1 recompute of §I.1.10 incl. price-request eligibility via validatePriceRequestSelection from worker/lib/priceRequests.ts), reviewed.ts as a pure parser/validator of the bundled files (the wrangler Text-module wiring is step 6b's).
- worker/lib/productSlug.ts: uniqueProductSlug + productSlugFrom moved out of worker/routes/adminImport.ts (module-private today), adminImport imports them; no behaviour change (existing import tests green). postCommitProductSave(db, plan, auditRows) extracted from saveProductAtomic's body, which calls it; no behaviour change.
Tests (through LimitD1 and the real migrations on node:sqlite): catalogImportWriter (create, merge, colour-model merge, empty-category fill, H2D Standard/standard values, fences, guard-trigger aborts, fingerprints before/after equal, invocation budget), catalogImportIdempotency (a re-send writes the same rows; a duplicate create is impossible via the product_source_refs key), catalogImportAllowList, catalogImportTranslations, catalogImportDoc, catalogImportUnpublish. Use the step 4 fixtures in tests/fixtures/bambu.
Commit as "bambu import step 6a: ...". Return a plain report: files, exported API (signatures the route layer must call, with a one-line description each), commits, tests with counts, deviations from the spec with reasons, open questions.`

const STEP6B = `${SHARED}
YOUR JOB: BUILD STEP 6b — the ops HTTP endpoint, media ingest, publish-finish, complete, the admin API, the end-to-end test. Steps 5 and 6a are committed in this worktree; read git log -8 and their reports:
STEP 5 REPORT:
<<STEP5>>
STEP 6a REPORT (the writer library you call):
<<STEP6A>>
Read: spec §A.1, §A.3 (every endpoint in its table, the auth middleware, the reviewed scope), §A.7, §A.8, §A.9, §A.10, §B.5, §H.1, §H.3, §I.1, §K.2 "Step 6". Then worker/index.ts (route mounting), worker/lib/deception/gate.ts, the rate limiter, worker/lib/crypto.ts (sha256Hex), worker/lib/productMedia*.ts (ingestProductMediaUrl), worker/routes/publicApi.ts (serve, canonicalUrl, withCacheEpoch), worker/routes/catalog.ts (purgeCatalogTreeCache), cataloguePaths, recomputeMany (completeness), worker/lib/costAccess.ts (requireOwner), wrangler.jsonc, tests/fixtures/imageDoubles.ts, scripts/live-cost-probes.mjs + scripts/live-cost-probes.d/.
Build:
- worker/routes/catalogImportOps.ts at /api/ops/catalog-import with requireImportToken (Bearer 64-hex + X-Levonis-Import-Protocol: 2; sha256 lookup on catalog_import_runs with state open/running/blocked and an unexpired token; every miss the SAME 404 {error:'Not found'} body and timing class; Cache-Control private, no-store on every answer; CSRF-exempt; rate limit keyed by run id; the deception gate knows the prefix — assert it in a test) and every endpoint of the §A.3 table: hello, manifest, items/:sid/{lease,event,stage,media,write,publish-finish,readback,complete,withdraw}, run/{prepare-taxonomy,protect-snapshot,finish,status}. Errors {code, message <= 300 chars from fixed templates plus ids}; never echo input or SQL text.
- worker/lib/catalogImport/{auth,purge,complete}.ts and the reviewed bundle wiring: data/bambu-import/{manifest,taxonomy-map,existing-matches,compat-targets,identity-map,media-overrides,search-synonyms}.json and data/bambu-import/curated/index.json committed as EMPTY, VALID placeholders (zero manifest rows) so the route is inert; wrangler.jsonc rules bundle them as Text modules; /hello returns their SHA-256s.
- media: ingestProductMediaUrl gains allowHost so the import can fetch store.bblcdn.com and nothing else; <= 4 media per call, a 45 s wall budget, skip a medium already stored whose R2 object HEADs; catalog_import_media rows.
- publish-finish: republish an item unpublished on block (guarded batch, REPUBLISHED event), recomputeMany + purge for the product and every product whose relations changed: cataloguePaths(slugs), '/api/products/<slug>/knowledge' (the UI lane builds that route and also adds it to cataloguePaths; include it in your purge list explicitly), the tree cache, '/api/catalog/<leaf>' per affected section, and the public v1 keys built by a purge-key helper you export next to serve in worker/routes/publicApi.ts; then state VERIFYING_LIVE; idempotent.
- complete: runner evidence + the Worker's own D1 recompute (6a's verifyD1) stored in d1_checks/edge_evidence; COMPLETE only when every hard check is true on both sides and the counts agree.
- worker/routes/adminCatalogImport.ts at /api/admin/catalog-import, requireOwner, read-only: GET /runs, /runs/:id, /runs/:id/items (paged 50, state and q filters, cursor), /items/:id, /runs/:id/report.json and report.csv streamed from D1 (§H.3, counts and public URLs only). Classified owner in tests/routeClass/.
- scripts/live-cost-probes.d/import.json: GET /api/ops/catalog-import/run/status -> 404 (the live probe of workflow 7). Check scripts/live-cost-probes.mjs supports the status expectation; extend it minimally if not, with a test in tests/liveCostProbes.test.ts.
- tests/noImportSync.test.ts: wrangler.jsonc crons unchanged and no scheduled() branch references catalog_import.
Tests: catalogImportAuth (404 uniformity across no header / bad token / expired / revoked / closed run; no-store; rate limit; deception gate; reviewed-scope refusals: an unlisted id at /manifest, an unlisted merge, a create for a merge source), catalogImportComplete (D1 recompute; refusal on disagreement; eligibility through validatePriceRequestSelection), catalogImportE2E (in-process: the step 4 sample pages through the real Hono app with the D1 shim, the R2 and IMAGES doubles and a fetcher double — open a run row with a token hash, manifest, lease, stage, media, write, publish-finish, readback, complete — then fingerprints through the real routes and a full re-run that writes zero rows), route class + role matrix, the customer-DTO leak scanner. With no open run every ops path is 404.
Commit as "bambu import step 6b: ...". Return a plain report: files, endpoints, commits, tests with counts, deviations with reasons, open questions.`

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          detail: { type: 'string', description: 'what is wrong, the concrete failure scenario, and how you verified it (test you ran, code path you traced)' },
          fix: { type: 'string', description: 'the minimal correct fix' },
        },
        required: ['severity', 'title', 'file', 'detail', 'fix'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

const reviewPrompt = (lens, reports) => `${SHARED}
YOU ARE AN ADVERSARIAL REVIEWER of Bambu import steps 5 and 6 in /home/user/levonis-ops (git log 096f2b59..HEAD; review the whole diff: git diff 096f2b59..HEAD). Do not edit or commit anything; you may write scratch files only under ${SP}/review-ops/ and run tests.
LENS: ${lens}
Builders' reports:
${reports}
Method: read the spec sections the diff implements, read the diff in full, trace the risky paths, and PROVE each finding (a failing test you wrote in the scratch dir, a traced code path with file:line, or a reproduced command). Report only real defects (not style), each with severity, file, line, the concrete failure scenario and the minimal fix. Look hard; an empty list must mean you checked.`

const LENS_SECURITY = `SECURITY AND PRIVACY. Token auth (404 uniformity incl. timing class, expiry, revocation, closed runs, header checks, rate limit, no-store, deception gate), the reviewed scope enforced by the Worker (unlisted ids, merges, creates, taxonomy, compat targets), the DB guard triggers armed by the ops_guards row (can any path write price/cost/stock/package/warranty columns? can the guard row leak outside a batch?), leaks of owner-only data (store canonical_url, store_page sources, swatch source_url, stock decisions, costs) into any customer DTO, the public API, caches, logs, errors or the admin API's non-owner callers, error messages echoing input, SQL injection, the stock gate bypass paths (any V2 publish path that skips the fence), the import-stock-decision route permission, the live probe file.`
const LENS_CORRECT = `CORRECTNESS AND REGRESSION. The writer vs spec §A.4/§A.5 (deterministic ids, bv- keys, side tables, multi-row INSERT batching under LimitD1 and the 900 budget, pending-relation resolution, fenced checkpoint, fingerprints, idempotent re-send, merge mode never moving money or V2 status), the state machine and lease handling, publish-finish purges and idempotency, complete's D1 recompute, the slug/postCommit refactors (behaviour unchanged for adminImport and saveProductAtomic callers), the search alias loader + INDEX_STAMP bump (cron budget, backfill, admin saves keep aliases, no regression for existing products), the stock gate (existing products never gated, no-0194 database unchanged), deploy-ahead tolerance (newer code on an older database), and test quality (would the tests fail if the code were wrong?).`

const FIX = (findings) => `${SHARED}
YOUR JOB: FIX the review findings for Bambu import steps 5 and 6 in /home/user/levonis-ops (branch import/ops). For each finding: confirm it is real (if it is not, say why with evidence and leave the code), fix it minimally, and add or extend a test that fails with the fix reverted and passes with it. Then run the gates (npm run check; every changed test file and the neighbours of every touched module) and commit as "bambu import steps 5-6, review: ..." (one or a few commits).
FINDINGS (JSON):
${JSON.stringify(findings, null, 1)}
Return a plain report: per finding fixed / refuted (with evidence), commits, tests with counts, and anything left open.`

phase('Step 5')
const r5 = await agent(STEP5, { label: 'build:step5', phase: 'Step 5' })
phase('Step 6a')
const r6a = await agent(STEP6A.replace('<<STEP5>>', String(r5)), { label: 'build:step6a', phase: 'Step 6a' })
phase('Step 6b')
const r6b = await agent(STEP6B.replace('<<STEP5>>', String(r5)).replace('<<STEP6A>>', String(r6a)), { label: 'build:step6b', phase: 'Step 6b' })
const reports = `STEP 5:\n${r5}\n\nSTEP 6a:\n${r6a}\n\nSTEP 6b:\n${r6b}`
phase('Review')
const reviews = await parallel([
  () => agent(reviewPrompt(LENS_SECURITY, reports), { label: 'review:security', phase: 'Review', schema: REVIEW_SCHEMA }),
  () => agent(reviewPrompt(LENS_CORRECT, reports), { label: 'review:correctness', phase: 'Review', schema: REVIEW_SCHEMA }),
])
const findings = reviews.filter(Boolean).flatMap((r) => r.findings)
log(`review findings: ${findings.length}`)
phase('Fix')
const fix = findings.length ? await agent(FIX(findings), { label: 'fix:steps5-6', phase: 'Fix' }) : 'no findings'
return { step5: r5, step6a: r6a, step6b: r6b, reviews: reviews.filter(Boolean).map((r) => r.summary), findings, fix }
