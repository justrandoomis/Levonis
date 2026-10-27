# @levonis/creativeDoc

Levonis Creative Studio as data (`docs/CREATIVE_STUDIO.md`). Pure: no I/O, no
Cloudflare bindings, no imports outside this package (`tests/monorepo.test.ts`
pins it). The Worker imports it as `@levonis/creativeDoc/<module>`; the SPA
imports it by relative path (`packages/creativeDoc/src/<module>`), like
`packages/storeLayout`.

| Module | What it is |
|---|---|
| `schema` | `CreativeDocument` v1 — formats, the closed font registry, layers (text / image / shape / group) with stable ids, relations, bindings, annotations, the caps, and the geometry helpers (`layerBox`, `safeBox`, `viewToDoc` / `docToView`) |
| `text` | `cleanText`, direction detection, the ONE wrapping/fitting algorithm the layout and the renderer share, IQD formatting by brand digits, and the detectors for price-like text, links and unsupported claims |
| `snapshot` | the marketing snapshot (the only product data an ad or Claude sees — no cost, stock count, supplier or sales field exists), change detection for re-verification, and the bound-text renderers (`renderPrice` never prints a zero) |
| `brand` | the versioned brand kit, its binding rules vs preferences, `defaultBrandKit()` (pending the owner's approval), `normalizeBrandKit` |
| `normalize` | `normalizeDocument(input)` → `{doc, issues, ok}` — the one gate on every write, read, import and model proposal |
| `templates` | the five templates (product hero, compact product, service card, comparison, lesson slide), their product-/price-/feature-first variants, the six families and their evidence-gated badges |
| `layout` | `buildFromTemplate`, `relayoutDependents` (only dependents move), conflicts and their deterministic resolutions, `rebuild` for another format/variant/density, `refreshBoundText` |
| `ops` | the bounded edit operations, `applyOps` (all or nothing; Claude's subset is strictly smaller than a person's) |
| `aiContracts` | the JSON schemas sent as `output_config.format` and the validators that decide what is accepted (`validateEditPatch`, `validateIdeas`, …) |
| `quality` | the deterministic checks — blockers / review / optional — with the list of checks that ran and those skipped |
| `api` | the HTTP contract between `worker/routes/adminCreativeStudio.ts` and `src/components/creativeStudio/` |

Tests: `packages/creativeDoc/test/*.test.ts` (run by `npm run test:unit` through
`scripts/test-workspaces.mjs`).
