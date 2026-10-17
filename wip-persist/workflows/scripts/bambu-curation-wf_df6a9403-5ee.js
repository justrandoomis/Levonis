export const meta = {
  name: 'bambu-curation',
  description: 'Curated enrichment (§F) for the 92 flagship Bambu products: polite document fetch, per-product curation, independent second extraction (25% per class, 100% where disagreement > 2%), adjudication, schema/consistency tests and the reviewed commit',
  phases: [
    { title: 'Fetch', detail: 'one polite fetcher builds the local document cache' },
    { title: 'Curate', detail: 'one agent per product, offline over the cache' },
    { title: 'Second', detail: 'blind second extraction on the sample, field diff' },
    { title: 'Adjudicate', detail: 'resolve every disagreement in the file' },
    { title: 'Commit', detail: 'schema, consistency and range tests, index.json, commit' },
  ],
}

const S = '/tmp/claude-0/-home-user-Levonis/aa8068a2-6eee-5a26-9836-675f1c2740c2/scratchpad'
const SHARED = `${S}/briefs/shared.md`
const CORPUS = `${S}/corpus/p0/raw`
const DOCS = `${S}/curation/docs`
const DRAFT = `${S}/curation/draft`
const SECOND = `${S}/curation/second`
const WT = '/home/user/levonis-curated'
const RUNNER = '/home/user/levonis-runner'
const SPEC = '/home/user/Levonis/docs/bambu-import/IMPORT-SPEC.md'
const MANIFEST = '/home/user/Levonis/docs/bambu-import/p0/manifest.json'

const FETCH = {
  type: 'object',
  properties: {
    products: { type: 'array', items: { type: 'object', properties: {
      handle: { type: 'string' }, type: { type: 'string' },
      docs: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, url: { type: 'string' }, file: { type: 'string' }, text: { type: 'string' } }, required: ['kind', 'url', 'file'] } },
      missing: { type: 'array', items: { type: 'string' } },
    }, required: ['handle', 'type', 'docs'] } },
    summary: { type: 'string' },
  },
  required: ['products', 'summary'],
}
const CURATED = { type: 'object', properties: { handle: { type: 'string' }, file: { type: 'string' }, specs: { type: 'integer' }, not_published: { type: 'integer' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['handle', 'file', 'specs'] }
const DIFF = { type: 'object', properties: { handle: { type: 'string' }, compared: { type: 'integer' }, disagree: { type: 'integer' }, items: { type: 'array', items: { type: 'string' } } }, required: ['handle', 'compared', 'disagree', 'items'] }

const rules = `Rules that bind you: read ${SHARED} (its privacy, money and language rules apply). The spec is ${SPEC}: read §F (Curated enrichment, "## F." heading, line ~1457) completely, plus §B.2 (spec values, excerpts), §C.6 (regions, 220 V / international values), §1 deviations rows 1–28, and the spec key registry packages/catalog/src/bambuImport/registry/specKeys.ts (allowed keys, units, groups). The curated file is consumed by the runner's mergeCurated in ${RUNNER}/scripts/bambu-import/enrich.ts (read it: the exact fields it reads, the allowed status/confidence/source_kind/region values, how scope is resolved, the weight rule) and gated by curatedGate. A third-party lab value is never a manufacturer spec; marketing prose never proves a number; printed-specimen results and raw-material properties use distinct keys; TDS values keep test_method and test_condition; every verified numeric value from a TDS/SDS/manual carries locator and a quote of at most 200 characters; every not_published key is covered by a searched entry. No price, cost, stock or shipping-time value ever.`

phase('Fetch')
const fetched = await agent(`${rules}

YOU ARE THE ONLY AGENT ALLOWED TO USE THE NETWORK in this job. Build the local document cache for the curated scope (§F step 1): the products with curated: true in ${MANIFEST} (92: 48 filament, 18 printer, 13 hotend, 8 build_plate, 4 ams, 1 laser_machine). For each, parse its store page from the corpus ${CORPUS}/<handle>.html.gz (gzip HTML; handle with non [A-Za-z0-9._-] chars replaced by _) with the package packages/catalog/src/bambuImport (see tests/fixtures/bambu/load.ts for how a page is parsed; run node/tsx scripts from ${WT}, which has node_modules) and collect the official documents it links (TDS, SDS, hex-code PDFs, AMS/printer spec PDFs, manuals on store.bblcdn.com or other Bambu-owned hosts), plus the wiki pages §F names (/en/general/filament-guide-material-table, /en/filament/<family>, /en/filament-acc/acc/nozzles, /en/<printer>/manual/acc-in-the-box — find the right <family>/<printer> slugs from the wiki itself). One product's page is withdrawn (halloween-filament-special-combo answers 404 at the store; it has a .status file instead of HTML): record it with docs [] and missing ["page_withdrawn"].
POLITENESS (absolute): a single sequential fetcher; read and obey robots.txt of each host first; ≥ 5 s between wiki.bambulab.com requests, ≥ 1 s between store.bblcdn.com (or other CDN) requests; a descriptive User-Agent 'Mozilla/5.0 (compatible; LevonisCatalogImport/1.0; +https://levonis-iq.com)'; never fetch us.store.bambulab.com (the corpus already has every page); stop and report on any 403 challenge or 429 (never bypass); de-duplicate URLs (many filaments share one wiki page); cache each response once under ${DOCS}/ with a safe file name, and for PDFs also write the text with pdftotext -layout next to it (<file>.txt). Resumable: skip URLs already cached. Write ${DOCS}/index.json (url → file, text file, bytes, sha256, content-type, fetched_at) as you go.
Final answer: per product the docs (kind tds/sds/hex/spec_pdf/manual/wiki, url, file, text = the .txt path or the HTML path) and anything you could not get (missing).`, { label: 'fetch:docs', phase: 'Fetch', schema: FETCH })

const products = (fetched?.products ?? []).filter((p) => p && p.handle)
log(`fetched docs for ${products.length} products; withdrawn or empty: ${products.filter((p) => !p.docs?.length).map((p) => p.handle).join(', ') || 'none'}`)

const curatePrompt = (p, out, blind) => `${rules}

Write the curated file for ONE product, offline: handle "${p.handle}" (type ${p.type}). Inputs: its store page in the corpus ${CORPUS} (parse it with the package as the runner would — run node/tsx from ${WT}); its cached documents (do NOT use the network; if something you need is not cached, list it in problems): ${JSON.stringify(p.docs ?? [])}. Also read the manifest row for "${p.handle}" in ${MANIFEST} (its value_labels, sku_codes, leaf) so scopes name real option values (scope kinds and ids exactly as mergeCurated's scopeOf resolves them).
Extract every manufacturer spec the documents state for this product into §F's JSON (schema 2): handle, schema, curated_by "${blind ? 'agent-2' : 'agent'}", curated_at (ISO now), searched (each document you read, with the key patterns you looked for), specs (key from the registry; scope; value; unit; status verified only when the document states it; confidence; source_kind; source_url; source_title; locator; quote ≤ 200 chars; test_method/test_condition for TDS; region per §C.6), hex (filaments: every colour's hex from the official hex-code document, keyed by the exact value text), relations (compatible_with / not_compatible_with / requires, each with evidence), in_the_box (only from an official list), documents, not_published (registry keys that apply to this type and that the documents you searched do not state). ${blind ? 'You are the INDEPENDENT SECOND extraction: do not read any other curated file for this product.' : ''}
Write it to ${out}/${p.handle}.json (pretty JSON). Self-check before answering: every key is in the registry with its unit; every verified numeric value has locator and quote; every not_published key is covered by a searched entry; ranges are sane for the key (e.g. nozzle 150–350 °C, density 0.9–2.5 g/cm³); every value that also appears on the parsed store page agrees or carries a conflict note. Final answer: the handle, the file path, the number of specs and not_published keys, and any problems.`

phase('Curate')
const firsts = await pipeline(
  products.filter((p) => p.docs?.length),
  (p) => agent(curatePrompt(p, DRAFT, false), { label: `curate:${p.handle}`, phase: 'Curate', schema: CURATED }).then((r) => ({ ...r, type: p.type, p })),
)
const done = firsts.filter(Boolean)
log(`curated ${done.length} of ${products.length}`)

// The 25 % sample per class (at least 1), chosen deterministically by handle order.
const byClass = {}
for (const r of done) (byClass[r.type] ||= []).push(r)
const sample = []
for (const [cls, rs] of Object.entries(byClass)) {
  const sorted = [...rs].sort((a, b) => a.handle.localeCompare(b.handle))
  const n = Math.max(1, Math.ceil(sorted.length * 0.25))
  const step = sorted.length / n
  for (let i = 0; i < n; i++) sample.push(sorted[Math.floor(i * step)])
}
log(`second extraction sample: ${sample.length} (${Object.entries(byClass).map(([c, rs]) => `${c} ${rs.length}`).join(', ')})`)

const diffPrompt = (h) => `${rules}

Compare two INDEPENDENT curated extractions of product "${h}": ${DRAFT}/${h}.json (first) and ${SECOND}/${h}.json (second). Diff them field by field: for every spec (key + scope + region), its value, unit, status, source_url and locator; every hex entry; every relation; every in_the_box item; every not_published key. A field counts as compared when either file has it; it disagrees when the values differ (numbers compared after unit normalisation, text trimmed and case-folded) or one file lacks it. Final answer: compared, disagree, and one line per disagreement ("key|scope|region: first=… second=…").`

phase('Second')
const diffs = await pipeline(
  sample,
  (r) => agent(curatePrompt(r.p, SECOND, true), { label: `second:${r.handle}`, phase: 'Second', schema: CURATED }),
  (_s, r) => agent(diffPrompt(r.handle), { label: `diff:${r.handle}`, phase: 'Second', schema: DIFF }).then((d) => ({ ...d, type: r.type })),
)
const classRate = {}
for (const d of diffs.filter(Boolean)) {
  const c = (classRate[d.type] ||= { compared: 0, disagree: 0, products: 0 })
  c.compared += d.compared; c.disagree += d.disagree; c.products += 1
}
const extend = Object.entries(classRate).filter(([, c]) => c.compared && c.disagree / c.compared > 0.02).map(([cls]) => cls)
log(`disagreement by class: ${Object.entries(classRate).map(([c, v]) => `${c} ${v.disagree}/${v.compared}`).join(', ')}; extended to 100%: ${extend.join(', ') || 'none'}`)

const sampled = new Set(sample.map((r) => r.handle))
const extra = done.filter((r) => extend.includes(r.type) && !sampled.has(r.handle))
const extraDiffs = await pipeline(
  extra,
  (r) => agent(curatePrompt(r.p, SECOND, true), { label: `second+:${r.handle}`, phase: 'Second', schema: CURATED }),
  (_s, r) => agent(diffPrompt(r.handle), { label: `diff+:${r.handle}`, phase: 'Second', schema: DIFF }).then((d) => ({ ...d, type: r.type })),
)
const allDiffs = [...diffs, ...extraDiffs].filter(Boolean)
for (const d of extraDiffs.filter(Boolean)) {
  const c = classRate[d.type]
  c.compared += d.compared; c.disagree += d.disagree; c.products += 1
}

phase('Adjudicate')
const adjudicated = await pipeline(
  allDiffs.filter((d) => d.disagree > 0),
  (d) => agent(`${rules}

Adjudicate the disagreements between two independent extractions of "${d.handle}": ${DRAFT}/${d.handle}.json (the file that will be committed) and ${SECOND}/${d.handle}.json. The disagreements: ${JSON.stringify(d.items)}. For each, read the cached source document yourself (paths are in the files' searched/source_url; the cache index is ${DOCS}/index.json; never use the network) and decide what the document actually states. Edit ONLY ${DRAFT}/${d.handle}.json so it is right (add, correct or remove; keep §F's rules). Final answer: one line per disagreement with your decision and the evidence (locator + quote).`, { label: `adjudicate:${d.handle}`, phase: 'Adjudicate' }),
)

phase('Commit')
const commit = await agent(`${rules}

You commit the reviewed curated files. Worktree ${WT} (branch import/curated, on the live default a2d9e73 + nothing else; never push; commits with the shared.md trailers). The drafts are ${DRAFT}/*.json (${done.length} products; the first extractions, adjudicated where a second extraction disagreed). Class agreement figures (compared/disagree/products per class, before adjudication): ${JSON.stringify(classRate)}; classes extended to 100 %: ${JSON.stringify(extend)}.
1. Write a schema test, a consistency test and a range test for data/bambu-import/curated/*.json (§F "Quality validation per class", the Curated row, items 1, 2 and 4) — put the validator where the runner can also use it (look at ${RUNNER}/scripts/bambu-import/enrich.ts and the package; if the natural home is in the runner lane, put a self-contained validator under scripts/bambu-import/curatedSchema.ts in THIS worktree and say so). The consistency test parses each product's store page from the corpus if present (skip with a clear note when the corpus is absent, e.g. in CI — the committed files must still pass the schema and range tests in CI).
2. Copy every draft that passes into data/bambu-import/curated/<handle>.json; fix or drop (and report) anything that fails; never invent a value.
3. Write data/bambu-import/curated/index.json in the shape the Worker's worker/lib/catalogImport/reviewed.ts parseCurated and the runner's curatedIndexOf both read ({version, files: {handle: sha256}} plus the class agreement figures where the parser allows extra keys — check both parsers; if one refuses extra keys, record the figures in data/bambu-import/curated/AGREEMENT.md instead).
4. Run npm run check (exit 0) and the new tests plus tests/catalogImportReviewed*.test.ts and tests/bambuImportEnrich*.test.ts (if present in this tree; otherwise run ${RUNNER}'s enrich test against these files by pointing it at this data directory, and say how). Report exact counts.
5. Privacy check before committing: no price/cost/stock values, no store_page source URLs, no non-Bambu hosts except the wiki and Bambu CDNs.
Commit in a few titled commits ("bambu import data: curated …"). Final report: commits, files committed per class, dropped files and why, test counts, the agreement figures.`, { label: 'commit:curated', phase: 'Commit' })

return { products: products.length, curated: done.length, classRate, extend, adjudicated: adjudicated.filter(Boolean).length, commit }