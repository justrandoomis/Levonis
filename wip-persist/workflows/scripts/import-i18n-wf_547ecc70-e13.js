export const meta = {
  name: 'import-i18n',
  description: 'Owner feedback on the first imported product: Arabic and Sorani for imported text via a reviewed translation memory read at display time (names stay English), correct bidi for mixed text, deduplicated compatibility; design, build, translate the 1,115 products\' strings, review, fix',
  phases: [
    { title: 'Design', detail: 'one architect fixes the design' },
    { title: 'Build', detail: 'one builder implements code, migration, loader and string extraction' },
    { title: 'Glossary', detail: 'a shared ar/ckb glossary of technical terms' },
    { title: 'Translate', detail: 'translation batches in parallel' },
    { title: 'Check', detail: 'independent second translator on a sample, and adversarial code review' },
    { title: 'Fix', detail: 'apply review outcomes, commit the translation data' },
  ],
}

const S = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad'
const SHARED = `${S}/briefs/shared.md`
const WT = '/home/user/levonis-i18n'
const I18N = `${S}/i18n`
const CORPUS = `${S}/corpus/p0/raw`

const owner = `THE OWNER'S FEEDBACK (Arabic, verbatim meaning) on the first imported product https://levonis-iq.com/product/filament-buffer, with two screenshots (${I18N}/owner-shot-1.jpg and owner-shot-2.jpg — look at them): (1) "The description text and the rest are still all English although the language is Arabic. Add translation of the text — taking care of RTL with mixed text that contains words such as English with Arabic, Kurdish with English." (2) "Compatibility is repeated" — the Compatibility tab lists X1 Series, P1 Series, P1 Series, X1 Series, P1 Series, P1 Series as separate chips; the spec table also has a «التوافق» row 'X1 Series and P1 Series (غير مؤكد)'; the page's option chooser shows «التوافق · X1 Series and P1 Series». (3) "The specifications on this product are good — the largest amount of correct information" (keep). (4) "«يتطلب» (requires) AMS Hub — the product must later be linked so the user knows what they need" (incoming pending relations already resolve when the target is imported: worker/lib/catalogImport/writer.ts step (d) ~:1436; confirm the page renders a resolved relation as a link to the product, and make sure a pending/unresolvable one reads as plain text). (5) "The extraction result overall: excellent."`

const houseRules = `House rules that bind every agent: read ${SHARED}. Product NAMES are never translated (worker/lib/translate/localizeProduct.ts header: names, option and colour names stay English on every surface — owner mandate §3/§7); model numbers, part codes, units, brand names stay in Latin script; no external translation service (DECISIONS row 2): translations are written by us (agents) and committed as reviewed data; every Sorani (ckb) string is real Central Kurdish in Arabic script and never a copy of the Arabic (row 183); no price, cost, stock or shipping-time text is ever added. The live site serves real customers: every change ships through CI and workflow 7.`

phase('Design')
const design = await agent(`${houseRules}

${owner}

You are the ARCHITECT. Read the code in ${WT} (the live default branch; read only in this phase) and write the design for:
A. A TRANSLATION MEMORY for imported English text: an additive migration (0196, next free number — check migrations/) with a table keyed by a hash of the normalized English source string (normalization rule exact and documented: trim, collapse whitespace, NFC), holding ar and ckb, a status (reviewed/machine/needs_review), and timestamps; how it is filled (a loader path: the import door with the run token, or cf.mjs/workflow 60 mode 'translations', or an owner-only admin endpoint — pick the safest, explain; rows arrive from a committed data file data/bambu-import/translations/*.json too big for the Worker bundle, so they are NOT bundled); and how it is READ at display time: which surfaces show imported English text today (the product page body /api/products/:slug — description/content blocks, usage steps, FAQ —; the knowledge answer /api/products/:slug/knowledge — spec value_text, box items, document titles, relation labels that are not product names; cards' key line; compare; the public API v1) and, for each, how the ar/ckb text replaces the English when the visitor's language is ar/ckb, with English as the fallback. Respect the D1 budgets (tests/d1Waves.test.ts: no new wave on the hot paths — fold the lookup into an existing wave; ≤ 100 bound parameters per statement; ≤ 1,000 statements per invocation), the edge cache (s-maxage and the purge paths: a translation load must purge the affected products' cached answers, or the design must say why not), presence probes (an older database without 0196 must keep working: CLAUDE.md rule 2), and the existing local translator (worker/lib/translate/*: how it relates — reuse its dictionary as a fallback or not, decide).
B. BIDI: how every text block that can mix scripts is rendered (dir="auto", unicode-bidi: plaintext, <bdi> for Latin runs in Arabic labels, number/unit ordering) on the product page, the knowledge tabs, cards and compare — in ar, en and ckb.
C. COMPATIBILITY DEDUPE: where the six chips come from (trace the stored product_relations rows for an imported product like filament-buffer: family members resolving to the same label), the rule (one chip per (relation, resolved target or normalized label)), where it applies (the knowledge answer shaping in worker/lib/knowledge/answer.ts, so compare/cards/runner VERIFY stay consistent — note the runner's VERIFY builds its expectation with the same assembleKnowledge, so both sides change together), and whether the compat.* spec row should be hidden when the Compatibility tab has relations (decide; the owner called it repeated). Do not hide the option chooser.
D. STRING EXTRACTION for translation: a script (scripts/bambu-import/i18n-strings.ts) that builds every product's payload exactly as the runner does (the package's buildImportPayload over the crawled pages in ${CORPUS}/<handle>.html.gz with the committed data/bambu-import files) and emits the unique translatable English strings with their kind (description_block, faq_q, faq_a, usage_step, box_item, spec_value_text, doc_title, relation_label …), frequency, and a context sample, excluding names, codes, units-only and numbers-only strings; output under ${I18N}/strings.json and split into batch files of ~250 strings under ${I18N}/batches/ (keep strings of one product together where possible).
E. The translation data format (data/bambu-import/translations/<part>.json: [{h, en, ar, ckb, kind}]) and its schema test, and how the loader proves every row's hash equals the hash of its en.
Write the design to ${WT}/docs/bambu-import/I18N-DESIGN.md (English, concise, precise: files, functions, SQL, tests). Commit nothing. Final answer: the design text.`, { label: 'design', phase: 'Design' })

phase('Build')
const build = await agent(`${houseRules}

${owner}

You are the BUILDER. Implement the design below in ${WT} (branch feat/import-i18n, at the live default 3babbb65) — code, migration, loader, page/knowledge changes, bidi, compatibility dedupe, the extraction script — with tests that fail without each change (real routes and real migrations in node:sqlite worlds, as the repository's tests do; D1 budgets in tests/d1Waves.test.ts; bundle budgets in tests/bundleBudget.test.ts and tests/motionLazy.test.ts; every new UI string in ar/en/ckb). Commit in small titled commits ("bambu import i18n: …") with the shared.md trailers; never push. Gates: npm run check exits 0; the neighbours of every module you touched (grep tests/ generously: productKnowledge*, compare*, d1Waves, productCard*, catalogOnly*, catalogImport*, bambuImport*, translate*, publicApi*, bundleBudget, motionLazy, claySystem, rootShardBalance) with exact counts. If a new test file makes rootShardBalance fail only because it is new, say so.
Then RUN the extraction script over the corpus (${CORPUS}, crawled 2026-10-16; never fetch any Bambu host) and write ${I18N}/strings.json and the batch files ${I18N}/batches/batch-NNN.json (~250 strings each). Final answer (structured): commits, tests, the number of unique strings and of batches, and the batch file paths in order.

THE DESIGN:
${design}`, { label: 'build', phase: 'Build', schema: { type: 'object', properties: { report: { type: 'string' }, strings: { type: 'integer' }, batches: { type: 'array', items: { type: 'string' } } }, required: ['report', 'strings', 'batches'] } })

const batches = build?.batches ?? []
log(`unique strings: ${build?.strings ?? 0}; batches: ${batches.length}`)

phase('Glossary')
const glossary = await agent(`${houseRules}

Build the SHARED GLOSSARY every translator will follow, so the same English term is always the same Arabic and Sorani term across 1,115 products. Read ${I18N}/strings.json (the unique English strings with frequencies and kinds). Pick the 400–600 most frequent technical terms and phrases of 3D printing, filament, electronics, mechanics, lasers and packaging (e.g. hotend, nozzle, extruder, build plate, heatbed, AMS, filament, spool, refill, tensile strength, layer height, print speed, enclosure, firmware, PCBA, carbon fiber, matte, silk …). For each: en, ar, ckb, and a keep_latin flag where Iraqi users and the shop already say the Latin term (brand and product-line names, AMS, PEI, PLA/PETG/ABS/TPU, USB-C, Wi-Fi …). Arabic: Modern Standard Arabic as an Iraqi shop writes it; Sorani: Central Kurdish in Arabic script, never a copy of the Arabic. Reuse the app's existing vocabulary first: grep src/ and worker/lib/translate/dictionary.ts in ${WT} for terms already used in ar/ckb. Write ${I18N}/glossary.json ([{en, ar, ckb, keep_latin, note}]). Final answer: the path and the number of entries.`, { label: 'glossary', phase: 'Glossary' })

const translatorRules = `${houseRules}

TRANSLATION RULES: Translate every string of the batch from English into Arabic (ar) and Central Kurdish/Sorani in Arabic script (ckb). Follow the glossary ${I18N}/glossary.json exactly (read it first). Keep in Latin script and unchanged: product and brand names (Bambu Lab, H2D, X1 Series, AMS 2 Pro …), model numbers, part codes, SKUs, URLs, units and numbers with their units (24V, 10mA, 0.4 mm, 220–240 V, 1 kg), file formats, standard names (ISO 527). Keep meaning exact: never add, drop or soften a fact, a warning or a limitation; keep list structure, line breaks and bullet markers; keep any markdown-like markers as they are. Natural, clear shop language — not word-for-word. For mixed text, write it so it reads correctly right-to-left with the Latin runs embedded (do not insert control characters; the page uses dir="auto"). If a string must not be translated (it is a name or code only), return ar and ckb equal to the English and mark keep: true. Never translate a string you cannot read with confidence: return needs_review: true with your best attempt.`

phase('Translate')
const translated = await pipeline(
  batches,
  (file, _orig, i) => agent(`${translatorRules}

Your batch: ${file} (a JSON array of {h, en, kind, context?}). Write ${I18N}/out/${String(i + 1).padStart(3, '0')}.json as a JSON array of {h, en, ar, ckb, kind, keep?, needs_review?} with EVERY string of the batch, in the same order, h and en copied exactly. Validate before answering: same count, same h values, valid JSON, every ckb differs from its ar unless keep is true. Final answer: the output path, the count, and the number marked needs_review.`, { label: `translate:${i + 1}`, phase: 'Translate' }),
)
log(`batches translated: ${translated.filter(Boolean).length} of ${batches.length}`)

phase('Check')
const sampleIdx = batches.map((_, i) => i).filter((i) => i % 5 === 2)
const [qa, review] = await parallel([
  () => parallel(sampleIdx.map((i) => () => agent(`${translatorRules}

You are the INDEPENDENT SECOND TRANSLATOR and REVIEWER for batch ${i + 1}. Without looking at the first translation, translate 40 strings of ${batches[i]} spread across the batch (every k-th string). Then open the first translation ${I18N}/out/${String(i + 1).padStart(3, '0')}.json and compare string by string: count disagreements of MEANING (a wrong, missing or added fact, a wrong term against the glossary, a Sorani that copies the Arabic, a name or unit translated that must stay Latin), not of style. Correct the first file in place where it is wrong (keep everything else). Write ${I18N}/review/${String(i + 1).padStart(3, '0')}.json with {compared, meaning_disagreements, fixed, notes[]}. Final answer: compared, disagreements, fixed.`, { label: `qa:${i + 1}`, phase: 'Check', schema: { type: 'object', properties: { compared: { type: 'integer' }, disagreements: { type: 'integer' }, fixed: { type: 'integer' } }, required: ['compared', 'disagreements', 'fixed'] } }))),
  () => parallel(['correctness', 'perf-cache-privacy', 'ui-bidi-languages'].map((lens) => () => agent(`${houseRules}

You are an adversarial CODE REVIEWER (lens: ${lens}) of the branch feat/import-i18n in ${WT} (diff against 3babbb65; read only — write probes only under ${I18N}/codereview-${lens}/). The design: ${WT}/docs/bambu-import/I18N-DESIGN.md. ${lens === 'correctness' ? 'Check: the hash/normalization is identical on the loader, the extraction script and the read path; every surface that shows imported English text uses the memory with English fallback; names/codes never translated; the compatibility dedupe is right and the runner VERIFY (assembleKnowledge) agrees; the migration is additive and an older database (no 0196) keeps working; tests prove each claim against real routes.' : lens === 'perf-cache-privacy' ? 'Check: no new D1 wave on hot paths, statement and parameter budgets, edge cache keys and purge after a translation load, bundle budgets, nothing private or owner-only leaks into a public answer, the loader cannot be called without its authority, no store_page refs exposed.' : 'Check: every new string in ar/en/ckb with real Sorani; dir/unicode-bidi on every mixed-text surface in ar, en and ckb (product page, knowledge tabs, cards, compare); the compatibility tab shows one chip per target; a resolved relation is a link and a pending one plain text; take real screenshots with Playwright (Chromium at /opt/pw-browsers; playwright package /opt/node22/lib/node_modules/playwright) of a local build (npm run build + wrangler dev --local with a seeded imported product and a few memory rows) in ar, en and ckb, and look at them.'} Report only real defects, each with proof (file:line, failing probe or screenshot path). Final answer: the findings.`, { label: `review:${lens}`, phase: 'Check' }))),
])
const qaTotals = (qa ?? []).filter(Boolean).reduce((a, r) => ({ compared: a.compared + r.compared, disagreements: a.disagreements + r.disagreements, fixed: a.fixed + r.fixed }), { compared: 0, disagreements: 0, fixed: 0 })
log(`translation QA: ${qaTotals.disagreements} meaning disagreements in ${qaTotals.compared} compared strings (${qaTotals.fixed} fixed)`)

phase('Fix')
const fix = await agent(`${houseRules}

You FINISH the branch feat/import-i18n in ${WT} (never push). 
1. Code review findings to fix (verify each; fix the real ones with a failing test first; report any you reject with the reason):
${(review ?? []).filter(Boolean).map((r, i) => `--- review ${i + 1} ---\n${r}`).join('\n\n')}
2. Translation QA totals: ${JSON.stringify(qaTotals)} over sampled batches ${JSON.stringify(sampleIdx.map((i) => i + 1))}. If meaning disagreements exceed 2 % of compared strings, re-check every batch not sampled the same way (you may run more checks yourself) before committing.
3. Merge ${I18N}/out/*.json into the committed data files data/bambu-import/translations/part-NNN.json in the design's format (h, en, ar, ckb, kind), add the schema test (every h equals the hash of its en under the shared normalization; ckb ≠ ar unless keep; no empty ar/ckb; no price/cost/stock words added), and commit ("bambu import i18n: the reviewed translations of the imported text").
4. Gates: npm run check exits 0; all neighbour tests with exact counts.
Final answer: commits (hash + subject), what was fixed or rejected, translation counts (total, keep, needs_review), QA figures, test counts, and the exact steps to load the memory into production after this lands (the loader path from the design).`, { label: 'fix', phase: 'Fix' })

return { design, build: build?.report, strings: build?.strings, batches: batches.length, glossary, qaTotals, fix }