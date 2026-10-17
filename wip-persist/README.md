# Work in progress, saved 2026-10-17 (do not land)

This branch only keeps unfinished work safe while the import waits for the
curated files. Nothing here is reviewed, and nothing here is ever merged into
the default branch as it stands. Every file is derived from public Bambu Lab
store and wiki pages, or from this repository's own code. There is no snapshot,
no key, no match candidate and no customer data.

| Folder | What it holds | Next step |
|---|---|---|
| `curation/draft/` | First extraction of the flagship products' curated files (one JSON per store handle) | Adjudicate against `second/`, then commit the agreed files under `data/bambu-import/curated/` |
| `curation/second/` | The independent second extractions, plus the agents' parse outputs | Compared with `draft/`; every class disagreed above 2%, so every class is adjudicated in full |
| `curation/*.json`, `curation/tools/` | Fetch plan, document queue, per-product document lists, link list, helper scripts | Reused by the adjudication |
| `i18n/` | Arabic and Sorani translations of the imported English text: `strings.json` (the extracted strings), `batches/` (the translator inputs), `out/` (the 38 translated batches), `rev0*/` and `review/` (the reviewers' notes), `glossary*.json`, `names.json`, `RULES.md` | Fix the rows the reviewers refused, then land with branch `wip/import-i18n` (migration 0196) |
| `perf/` | Live speed measurement (`live-1.*`), the 25 confirmed findings, the audit script | The fixes are on `wip/perf-edge`, `wip/perf-cats`, `wip/perf-product`, `wip/perf-payload` |
| `workflows/` | The orchestration scripts and their journals (which steps finished) | Re-run only the steps that did not finish |

Branches saved alongside this one:

| Branch | Content |
|---|---|
| `wip/perf-edge` | Edge cache serving stale copies, image renditions (last commit is unfinished work) |
| `wip/perf-cats` | Section pages without request waterfalls |
| `wip/perf-product` | Product page: lead image size and preload, earlier session |
| `wip/perf-payload` | Smaller card payload |
| `wip/import-i18n` | Translation storage and display, compatibility de-duplication (last commit is unfinished work) |
| `wip/product-discount` | "Price before discount" in the product form (migration 0197) |

Each branch is rebased onto the live default branch, checked
(`npm run check`, `npm run test:unit`, the full CI on `ci/<lane>`) and only
then fast-forwarded, per `CLAUDE.md`.
