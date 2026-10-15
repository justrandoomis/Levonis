export const meta = {
  name: 'bambu-step7-and-package',
  description: 'Bambu import step 7 (customer UI, knowledge route, cards, compare, facets, admin dashboard) in /home/user/levonis-ui, and the step-4 package follow-ups + order-type word fix in /home/user/levonis-pkg; review; fix',
  phases: [
    { title: 'Build', detail: 'step 7 server reads, step 7 client, package follow-ups' },
    { title: 'Review', detail: 'one adversarial reviewer per lane' },
    { title: 'Fix', detail: 'fix confirmed findings per lane' },
  ],
}

const SP = '/tmp/claude-0/-home-user-Levonis/f168c507-ccde-51da-80be-0fda576cd519/scratchpad'
const SHARED = (wt, br) => `
SHARED CONTEXT
- Repo: Levonis (Cloudflare Worker + Hono + D1 + R2 + the IMAGES binding; React 19 + Vite + Tailwind v4). The GitHub repository is PUBLIC.
- Task: the owner's one-time Bambu Lab catalogue import (1,115 us.store.bambulab.com products imported as native, catalog-only products: no price, no cost, no stock from the source). Owner decisions: docs/DECISIONS.md rows 239, 240, 241 (read them).
- THE SPEC (FINAL): ${SP}/bambu/import-spec.md (235 KB). Read the sections named for your job and grep it for cross-references. It cites file:line positions from an older tree; re-locate code by name.
- P0 data: ${SP}/bambu/p0/ (crawled pages in raw/<handle>.html.gz, manifest.json, taxonomy-map.json, compat-targets.json, identity-map.json, media-overrides.json, search-synonyms.json, scans.md, owner-questions.md whose §E lists integrator items, parse-report.json, tools/, work/step4/ with check.ts and corpus.ts).
- Your base: commit 096f2b59 = the live default branch (Pricing V2 clean start, Services S-P2, catalog-only visibility + «طلب السعر» with migration 0193) + Bambu step 4 (migrations 0194_catalog_knowledge.sql and 0195_catalog_import_runs.sql; packages/catalog/src/bambuImport; product deletion registries). Step 4 is about to land on the default branch unchanged. Another lane is building steps 5–6 (search aliases, stock gate, the import writer, the ops endpoint at /api/ops/catalog-import and the owner-only admin API /api/admin/catalog-import of spec §H.1) in another worktree at the same time: do not build those.
- Worktree: ${wt}, branch ${br}. Work and commit ONLY there. node_modules are symlinks into /home/user/Levonis/node_modules: never run npm install / npm ci.
- Never push, never touch any remote or the default branch, never contact levonis-iq.com, bambulab.com or any production system: tests and browsers are local only.
- Commits: linear history, no merges. Every commit message ends with exactly these two lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01D5ebj3qaF1mdriu93x6s5r
  No model names anywhere in the repository.
- Languages: every user-facing string exists in Arabic, English and real Sorani Kurdish (ckb); a ckb slot never copies the Arabic (DECISIONS row 183). You write the translations yourself (no external translation service, row 2).
- Money and privacy: customer-facing answers carry no cost, margin, supplier price or stock fact, and no owner-only provenance (store canonical_url, store_page source refs, swatch source_url). Unpriced products show no number (price null, never 0).
- No new migration. Every new read of a 0194/0195 table or column tolerates its absence through a presence probe (CLAUDE.md rule 2) — test that path.
- Gates before you finish: npm run check exits 0, and every test file you added or changed plus the existing neighbours of every module you touched pass (npx tsx --test --test-concurrency=4 <files>; grep tests/ for the module names). The full suite runs later in CI; choose neighbours generously. Report exact pass/fail counts.
`

const B7A = `${SHARED('/home/user/levonis-ui', 'import/ui')}
YOUR JOB: BUILD STEP 7, PART A — the SERVER READS for the new product knowledge (a second agent builds the client UI on top of your work right after you).
Read: spec §G (all), §H.2 (the information-completeness column and card: their server query is yours), §B.2 (0194 tables), §C.4 (image bindings incl. via_variant_id), §K.2 "Step 7". Then worker/routes/products.ts, worker/lib/productOverlay.ts (loadRelationsView, publicRelations incl. the catalog-only path), worker/lib/listing*.ts, worker/lib/compareSpecs.ts, packages/catalog/src/discovery.ts (FACET_FIELDS), worker/lib/listingFacets.ts, worker/lib/templateFamilies.ts, cataloguePaths, tests/d1Waves.test.ts, tests/catalogOnlyProjectionKeys.test.ts, the leak scanners in tests/.
Build:
1. GET /api/products/:slug/knowledge on productRoutes exactly as §G.1 (VISIBLE-gated: hidden and missing products give the same 404; source.url only for official document, wiki, TDS and SDS kinds; a store_page ref is never emitted; visibility='owner' rows never emitted; no CBM to customers (L-4); anonymous edge cache s-maxage=300; empty answer without 0194). Add '/api/products/<slug>/knowledge' to cataloguePaths so every admin product write purges it.
2. The relations view: option values LEFT JOIN product_option_value_swatches (url, width, height, published hex — never source_url) and groups select name_ar, name_ckb, kind, default_value_id, both behind a 0194 presence probe, with NO new D1 wave (tests/d1Waves.test.ts ceilings unchanged). Images carry via_variant_id where the 0194 product_option_source_refs row has one (step 4 fixStep note: a representative image carries its source variant through media, payload, product_option_source_refs and the fingerprint, and the gallery must drop it when that variant clashes with the selection) — carry it in the relations images of BOTH the priced and the catalog-only projection (D-2 rules), and extend tests/catalogOnlyProjectionKeys.test.ts.
3. Cards: key_specs (<= 4 entries of <= 40 chars from spec_fields mirrors for registry keys flagged cardKey per type) and section_name {ar,en,ckb} for sub_category_id from the taxonomy the listing routes already load — no new wave (assert in d1Waves).
4. Compare: worker/lib/compareSpecs.ts reads product_spec_values for registry keys flagged compare when 0194 is present (fallback spec_fields); each cell carries unit, test method, and the state label instead of a blank; update the compare route's d1Waves ceiling with the measured number.
5. Facets: FACET_FIELDS gains product_family: 'family' and spool_type: 'spool' (new template fields in templateFamilies.ts); color_name multi-valued split on ' | '; labels and base colours exactly as §G.5.
6. The information-completeness server query for the admin product list (one GROUP BY product_id, status query for the page's <= 50 ids) and the product form card's data (missing keys by name), staff-only, separate from the commercial product_completeness.
Tests: knowledge route (shape, 404 parity, no store_page/owner rows, no CBM, cache headers, empty without 0194), relations swatch/group/via_variant_id keys (priced and catalog-only), cards key_specs/section_name, compare cells, facets, d1Waves, leak scanners over the new DTOs.
Commit as "bambu import step 7a: ...". Return a plain report: files, the exact JSON shapes the client will consume (knowledge DTO, relations additions, card additions, compare cells, facets, completeness), commits, tests with counts, deviations, open questions.`

const B7B = (r7a) => `${SHARED('/home/user/levonis-ui', 'import/ui')}
YOUR JOB: BUILD STEP 7, PART B — the CLIENT UI. Part A (server reads) is committed in this worktree; its report:
<<<
${r7a}
>>>
Read: spec §G.2, §G.3, §G.4, §G.5, §G.6, §H.2, §K.2 "Step 7"; .claude/skills/apple-design/SKILL.md (follow it); src/pages/Product.tsx (galleryOf, the option chooser, initial_selection handling, catalog-only rendering), src/lib/productGallery*, packages/pricing/src/productSelectionMedia.ts, src/components/home/ProductCard.tsx, the compare UI, the listing filters UI, the admin products list and form, tests/bundleBudget.test.ts, tests/claySystem.test.ts, the i18n coverage tests.
Build:
1. src/lib/productGallery.ts: the pure gallery-for-a-selection function of §G.3 (drop contradicting images incl. an image whose via_variant_id variant clashes with the selection; rank with productMediaForSelection over the full remaining list; de-duplicate by URL AFTERWARDS) used by Product.tsx; tests/productGallerySelection.test.ts with the §G.3 cases (PEI plate H2C -> FAP035, H2D -> FAP025; H2D AMS Combo -> H2DC with no H2DL or plain-H2D image; A1 Standard -> no A1_C image) plus a test proving an UNBOUND gallery (every existing product today) is unchanged.
2. Default preselection from default_value_id (only while the defaults form a real variant, else the first group's default alone); single-value groups auto-selected; impossible combinations disabled with «غير متاح مع هذا الاختيار» / "Not offered with this choice" / «لەگەڵ ئەم هەڵبژاردنە بەردەست نییە» (never «نفد»), from variants[].combo_key; colour groups (kind = 'color') as 28 px swatch chips (object-fit cover, circle) / published-hex dot / text chip, the accessible name always the value name; images object-fit contain in the main gallery, lazy after the first, responsive widths from stored variants.
3. A lazy ProductKnowledgeTabs (React.lazy, fetched when it nears the viewport via IntersectionObserver rootMargin 400 px; the existing Section accordion on phones, tabs on desktop) with the tabs, value states, labels, documents titles by kind and link behaviour of §G.2/§G.4 (every string ar/en/ckb exactly as the spec tables give them), variant-scoped rows following the current/default selection, numbers in <bdi>.
4. ProductCard: one muted key-spec/section line under the name; measure the first-chunk cost with npm run build + tests/bundleBudget.test.ts before and after (numbers in the commit message); if it does not fit, use the §G.5 fallback and say so. ProductKnowledgeTabs joins the "product opening excludes" list.
5. Compare cells (unit, test method, state label), the new facets in the listing filters (labels ar/en/ckb), the information-completeness column and form card (§H.2).
6. src/components/adminImport/CatalogImportDashboard.tsx: a lazy admin chunk, a tab under products «استيراد Bambu Lab» / "Bambu Lab import" / «هاوردەکردنی Bambu Lab», reading the owner-only API of §H.1 (/api/admin/catalog-import/runs, /runs/:id, /runs/:id/items, /items/:id, report links) exactly as the spec describes it (the other lane builds that API in parallel — code to the spec's shapes, degrade gracefully on 404), with the state labels and the blocked-item resume instruction of §H.2, NO skip button and NO advance-cursor control.
7. A Playwright local e2e on fixture data (follow the pattern of scripts/e2e-catalog-only.mjs: local server, any request to a non-127.0.0.1 host aborted and counted) with screenshots of an imported-style product (swatches, default selection, knowledge tabs, documents) in ar, en and ckb, phone and desktop, light and dark, saved under ${SP}/step7-shots/. Chromium is at /opt/pw-browsers (do not run playwright install).
Tests: productGallerySelection, bundleBudget (measured numbers), claySystem, i18n coverage (ar/en/ckb, no ckb = ar), compare and facet UI tests, the dashboard's states (no skip control) — plus every neighbour you touch.
Commit as "bambu import step 7b: ...". Return a plain report: files, bundle numbers before/after, screenshot paths, commits, tests with counts, deviations, open questions.`

const C = `${SHARED('/home/user/levonis-pkg', 'import/pkg')}
YOUR JOB: the STEP 4 PACKAGE FOLLOW-UPS that block step 9 (owner-questions.md §E items 1, 2, 5, 6, 7, 9) and the order-type word fix (owner question H-1, option b), all in packages/catalog/src/bambuImport (+ tests, fixtures) and packages/pricing/src/availability.ts.
Read first: ${SP}/bambu/p0/owner-questions.md (all of it, esp. §A H-1, §C P0-1 and P0-11, §E), ${SP}/bambu/p0/scans.md §2 and §5, the package README, its tests (tests/bambu*.test.ts), ${SP}/bambu/p0/work/step4/check.ts and corpus.ts (how the corpus parse report is produced), and spec §B.6, §C.2, §C.4, §C.5, §C.6, §C.10.
1. §E.1 Reviewed value labels: the builder applies a manifest row's value_labels[<source value id>] = {en, ar, ckb} in the option model after the ids, variant_key and the SKU join are computed from the SOURCE and before media binding, so every derived customer string carries it (name_en/name_ar/name_ckb, variant_label, the value's source_refs.source_label, and the alt_en/alt_ar/alt_ckb of image rows whose selection label names the value). Add a test with a trimmed ams-2-pro fixture (from ${SP}/bambu/p0/raw/ams-2-pro.html.gz, <= 200 KB) asserting the whole payload passes assertImportPayload and no payload string contains the refused source wording, and the 15 variants survive. Define how the builder receives the manifest row (it is also what the step 6 writer and the step 8 runner will pass) and document it in the README.
2. §E.2 "A1 Series" per subject: relations.ts reads compat-targets labels[label].by_subject[<subject handle>].members first and labels[label].default.members otherwise (the entry has no 'to' and no top-level members on purpose); tests cover one subject of each basis (includes, excludes, default) using the real compat-targets.json entries.
3. §E.5 Description format E (h2c, h2s, p2s, refurbished-bambu-lab-p2s-3d-printer, bambu-lab-p2s-combo-starter-kit): check whether describe.ts already parses the component list (SpecTable, Inbox with per-version columns, FAQ, Anchor sections); if not, implement it, with one trimmed E fixture.
4. §E.6 The spec §C.4 rule vs the golden test on ams-2-pro (value_set vs 13 variant rows): check what step 4 settled; if it is still open, settle it per §C.4's intent (no image of another selection shown) and say what you chose.
5. §E.7 The top 50 unknown spec labels (scans.md §5) join the spec key registry (specKeys.ts) with real ar/en/ckb labels, units and types.
6. §E.9 The printer matcher also reads "Select your printer series" (cyberbrick-timelapse-kit) and "Device" (ptfe-tubes) as printer groups when every value is a label compat-targets.json maps or lists as reviewed-unresolvable.
7. H-1: availabilityFromName in packages/pricing/src/availability.ts reads "direct" inside a larger word ("Omnidirectional", "indirect", "directional", "directly") as direct_sale. Fix ONLY the "direct" alternative so it must not be preceded or followed by a Latin letter (keep "Direct", "Direct sale", "direct-sale", "directsale" and the Arabic «بيع مباشر» matching; keep pre-order as it is), with tests for each listed case and for the forklift option names. List every caller of availabilityFromName in worker/ and src/ and state, per caller, what the change means (the read-time fallback in productOverlay/stockAlertResolve applies to a stored variant whose availability_type is empty). Do NOT read any production data; the integrator will check existing names against a sealed snapshot before landing.
8. Re-run the whole-corpus parse (all 1,115 pages, the same way work/step4 does it, with the reviewed value labels from manifest.json) and write the refreshed report to ${SP}/bambu/p0/parse-report.json (keep the previous one as parse-report.prev.json). Report the status table (ok/hold/blocked/failed — target 1,115 ok), the measures table of the previous report with before/after, the relation counts by state, and the plan-size estimate distribution if the corpus tool computes it.
Commit as "bambu import package: ..." (a few focused commits). Return a plain report: per item what you did, commits, tests with counts, the corpus tables, deviations, open questions.`

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
          detail: { type: 'string', description: 'what is wrong, the concrete failure scenario, and how you verified it' },
          fix: { type: 'string', description: 'the minimal correct fix' },
        },
        required: ['severity', 'title', 'file', 'detail', 'fix'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

const review = (wt, br, what, lens, reports) => `${SHARED(wt, br)}
YOU ARE AN ADVERSARIAL REVIEWER of ${what} in ${wt} (review the whole diff: git diff 096f2b59..HEAD). Do not edit or commit anything; scratch files only under ${SP}/review-${br.replace('/', '-')}/.
LENS: ${lens}
Builders' reports:
${reports}
Method: read the spec sections the diff implements, read the diff in full, trace the risky paths and PROVE each finding (a failing test you wrote in the scratch dir, a traced code path with file:line, a reproduced command or screenshot). Real defects only (not style), each with severity, file, line, the concrete failure scenario and the minimal fix. An empty list must mean you checked.`

const fixPrompt = (wt, br, what, findings) => `${SHARED(wt, br)}
YOUR JOB: FIX the review findings for ${what} in ${wt}. For each finding: confirm it is real (if not, say why with evidence and leave the code), fix it minimally, and add or extend a test that fails with the fix reverted and passes with it. Run the gates and commit ("${br.split('/')[1]}, review: ...").
FINDINGS (JSON):
${JSON.stringify(findings, null, 1)}
Return a plain report: per finding fixed / refuted (with evidence), commits, tests with counts, anything left open.`

const LENS_UI = `UI, PRIVACY AND REGRESSION. The knowledge DTO and relations additions never carry owner-only provenance, store_page refs, CBM, stock or cost (check every projection: page body, catalog-only, cards, compare, public API v1, caches); 404 parity for hidden products; the gallery selection rules incl. via_variant_id, and that every EXISTING product (unbound gallery, no 0194 rows) renders exactly as before; default preselection, impossible combinations, swatches and their accessible names; RTL, ar/en/ckb completeness (no ckb copying ar), Clay primitives, apple-design rules, keyboard/focus, reduced motion; bundle budget honesty (measured numbers), lazy loading; d1Waves ceilings; the admin dashboard has no skip/advance control and degrades on 404; test quality (would the tests fail if the code were wrong?).`
const LENS_PKG = `CORPUS CORRECTNESS AND APP-WIDE REGRESSION. Re-run the corpus check yourself and compare against the previous report (${SP}/bambu/p0/parse-report.prev.json): every changed product must be explained; the ams-2-pro label reaches every derived string and changes no id or variant_key; the A1 Series per-subject reading matches compat-targets.json; format E descriptions are complete and carry no store sentence; the new spec keys have correct units and real Sorani; the printer matcher does not pull in non-printer values; the availabilityFromName change affects only letter-embedded "direct" and every caller stays correct (variantLabelFallback, legacyShapeErrors, productOverlay, stockAlertResolve, scripts); test quality.`

phase('Build')
const [ui, pkg] = await parallel([
  async () => {
    const r7a = await agent(B7A, { label: 'build:step7a', phase: 'Build' })
    const r7b = await agent(B7B(r7a), { label: 'build:step7b', phase: 'Build' })
    const reports = `STEP 7a:\n${r7a}\n\nSTEP 7b:\n${r7b}`
    const rv = await agent(review('/home/user/levonis-ui', 'import/ui', 'Bambu import step 7', LENS_UI, reports), { label: 'review:step7', phase: 'Review', schema: REVIEW_SCHEMA })
    const fx = rv && rv.findings.length ? await agent(fixPrompt('/home/user/levonis-ui', 'import/ui', 'Bambu import step 7', rv.findings), { label: 'fix:step7', phase: 'Fix' }) : 'no findings'
    return { r7a, r7b, review: rv, fix: fx }
  },
  async () => {
    const rc = await agent(C, { label: 'build:package', phase: 'Build' })
    const rv = await agent(review('/home/user/levonis-pkg', 'import/pkg', 'the Bambu import package follow-ups and the availabilityFromName fix', LENS_PKG, `PACKAGE:\n${rc}`), { label: 'review:package', phase: 'Review', schema: REVIEW_SCHEMA })
    const fx = rv && rv.findings.length ? await agent(fixPrompt('/home/user/levonis-pkg', 'import/pkg', 'the Bambu import package follow-ups and the availabilityFromName fix', rv.findings), { label: 'fix:package', phase: 'Fix' }) : 'no findings'
    return { rc, review: rv, fix: fx }
  },
])
return { ui, pkg }
