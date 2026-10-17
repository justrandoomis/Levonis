# Imported text in Arabic and Sorani, mixed-script rendering, compatibility dedupe — design

Status: BUILT on `feat/import-i18n` (surveyed at `3babbb65`). The review of the build (three reviews, 2026-10-17) changed
the points marked **Review:** below, and the landing review the points marked **Landing review:**; everything else is
as designed.
Scope: the owner's feedback on `/product/filament-buffer` (2026-10-16, two screenshots): (1) description and the
other imported text are English on the Arabic page, mixed-script text must read correctly; (2) compatibility is
repeated; (3) the specifications are good, keep them; (4) «يتطلب AMS Hub» must become a link once that product
exists; (5) extraction quality is excellent.

House rules this design keeps: names, option and colour names, model numbers, part codes, units and brand names
stay Latin (`worker/lib/translate/localizeProduct.ts` header; mandate §3/§7). No external translation service
(DECISIONS row 2). Every `ckb` string is real Sorani, never a copy of the Arabic (row 183). No price, cost, stock or
shipping-time text is ever added. Every change ships through CI and workflow 7.

---

## 0. What the screenshots show, traced to the code

| Seen | Cause |
|---|---|
| «وصف المنتج» paragraph in English | The writer fills `description_ar/ckb` from the local dictionary (`writer.ts` step 10, ~:1214–1239, status `review_needed`). Marketing prose is never covered, so the slot holds the English. `Product.tsx` ~:2244 `pick()` shows it. The `<p>` (~:4375) has no `dir`, so an English paragraph is laid out RTL: the final `P1P` and the full stop sit on the wrong side. |
| Spec values `Below 10mA`, `Plastics, PCBA`, `Gray` in English | `product_spec_values.value_text` is single-language. `assembleKnowledge` (`worker/lib/knowledge/answer.ts`) passes it through as-is. `ProductKnowledgeTabs.tsx` ~:333 renders `<bdi>{v.text}</bdi>`. |
| Six chips: X1, P1, P1, X1, P1, P1 | Traced by building the canary's payload from the corpus. There are 7 `product_relations` rows. 3 are scoped to the only value `ov_8de61959…` of the «Compatibility» group (evidence `option_value`): `X1 Series`→`refurbished-x1c`, `P1 Series`→`p1s`, `P1 Series`→`refurbished-p1s`. 3 are the same at product scope (evidence `compat_section`). Family labels expand to one row per member (`relations.ts` `fromEntry`), and each row id differs by handle and scope. The 7th row is `requires` `AMS Hub`→`ams-hub`, pending. `assembleKnowledge` ~:439 emits one item per row. `knowledgeTabs` keeps both scopes because the default selection holds `ov_8de6…`. |
| «التوافق» spec row `X1 Series and P1 Series (غير مؤكد)` | The `compat.statement` row (unverified), drawn in the specs tab next to the chips. |
| Chooser chip `… Series and P1 Series` | The value name is English (correct by §7), but the truncating `<span>` (`Product.tsx` ~:3475) inherits RTL, so the ellipsis eats the start. |
| «يتطلب AMS Hub» plain | Correct today: the pending row has no visible target. The writer's step (d) (~:1436–1445) resolves every pending row naming `ams-hub` when that product is written. `affectedProducts` then purges the buffer's answers. The knowledge read LEFT JOINs a *visible* target, and the tab renders `item.product` as a router `<Link>`. Problem: the unlinked chip is drawn as a bordered pill that looks tappable. |

The storefront draws only `description`, the usage guide and the knowledge tabs. It does not draw
`content_blocks` (Overview / Highlights / FAQ / tables). Only `src/components/adminProducts/*` reads them. They
reach customers only through public API v1 (`content[]`).

Measured over the corpus (1,104 of 1,115 pages built with the runner's own inputs). 11 pages were missing under
the handle-derived file name, and the crawler's name rule is in §D. The count is **8,693 unique translatable
strings, 879k English characters**:
- **page** (drawn today): 3,184 strings / 251k chars. This covers short description, usage, spec values, list
  items, `x.*` labels, box items, document titles.
- **api-only** (content blocks): 5,509 strings / 628k chars.

Relation labels left after excluding names: 0. Strings whose stored form is not normalized: 59.

---

## 1. Decisions

| # | Decision |
|---|---|
| D1 | A **translation memory** (TM) keyed by `sha256(normalized English)`, additive migration **0196**. It is read at display time and overlaid on the outgoing answer. Product rows and 0194 rows are never rewritten. |
| D2 | Which product uses which string comes from a **refs table** `(product_id, h)` written by the loader. The rows come from the committed data, and the extraction knows the products. One indexed join per product serves every surface. There is no hashing in SQL and no dependence on how a source string was stored. |
| D3 | **Loader = the import door** (`POST /api/ops/catalog-import/run/translations`, run token, workflow 60 mode `translations`). The bytes are verified against a **bundled index** of part SHA-256s. See §A.4 for why not cf.mjs or an owner endpoint. |
| D4 | Display uses only rows with status `reviewed` or `machine`, and English is the fallback. The local dictionary is **not** consulted at display time for imported strings: it localises units, which this import keeps Latin. It is used offline as a seed and as the neutral-segment classifier. Compare keeps its existing dictionary fallback, now behind the TM. |
| D5 | Overlay granularity is **one line** of a multi-line slot (bullet prefix kept, table rows split into cells), and **the whole string** for knowledge values. A line without a TM row stays English and gets its own direction. |
| D6 | **Bidi**: direction is set per line **by script presence**, not `dir="auto"`. Inside RTL lines, every Latin/number run is wrapped in `<bdi dir="ltr">`. No `unicode-bidi: plaintext`. |
| D7 | **Compatibility dedupe** happens in `assembleKnowledge`: one item per (bucket, relation, `labelKey(label)`), merged across scopes. Visible targets ride as links on that item. VERIFY expects the same thing because it calls the same function. |
| D8 | The `compat.statement` row leaves the specs tab whenever the Compatibility tab exists. It shows under the chips only when it says more than the chips. The option chooser stays. |
| D9 | Cards' key line: **no TM lookup**. The hot listing path stays as it is, and its values are measurements, codes and names. The existing `<bdi>` is kept. |
| D10 | Translation effort goes in order: **page** strings first (3.2k). The 5.5k content-block strings follow only if the owner decides to draw content blocks, or for API v1 (open question Q1). |

---

## A. The translation memory

### A.1 Normalization and key (exact)

New pure module **`packages/catalog/src/bambuImport/i18n.ts`**. It is shared by the Worker, the scripts, the tests
and the client types, and it has no bindings.

```ts
/** Every run of whitespace, NBSP, ZWSP, LS, PS, BOM → one space; trimmed; then Unicode NFC.
 *  Identical to normalize.ts cleanText(): s.replace(/[\s ​  ﻿]+/g, ' ').trim().normalize('NFC') */
export function normalizeSource(s: string): string;
/** sha256Hex (hash.ts, pure FIPS 180-4) over the UTF-8 bytes of normalizeSource(en): 64 lowercase hex. */
export function sourceHash(en: string): string;
```

The order is collapse, then trim, then NFC. `en` is stored **already normalized**. A row whose
`en !== normalizeSource(en)` is invalid. Both the CI test and the loader enforce this.

Segmentation is shared by the extraction (§D), the overlay (§A.5) and the tests:

```ts
export const BULLET = /^(\s*(?:[•·▪◦*]|-)\s+)/;          // kept verbatim, never translated
export const CELL_SEP = ' | ';                             // content-block table rows (payload.ts withoutMoneyColumns)
/** Multi-line slot → lines; each line → prefix + one segment, or cells. Empty lines kept. */
export function translateLines(text: string, lookup: (normEn: string) => Tr | null): { text: string; hit: number; total: number };
/** One whole value (spec value, list item, box item, label, title): normalizeSource then lookup. */
export function translateWhole(text: string, lookup: (normEn: string) => Tr | null): Tr | null;
export type Tr = { ar: string; ckb: string };
```

`translateLines` rebuilds each line as `prefix + translated segment`, or as cells joined by `' | '`. A segment the
lookup misses keeps what the slot already said in that language: **Review:** `translateLines(text, lookup, stored?)`
takes the slot's stored Arabic and Sorani (the writer's dictionary output) and a missed line keeps its stored line when
the stored slot is cut into the same lines (a table row into the same cells), else its English (§A.6: the overlay
replaces only the lines the TM covers). `hit === 0` means the slot is left untouched.

### A.2 Migration `migrations/0196_catalog_translations.sql`

The migration is additive only. Every CREATE has IF NOT EXISTS, so `migrate-check --twice` passes. There are no
foreign keys: refs may precede their product, and a product may be deleted. Nothing is guarded by the 0195
triggers, because no money is involved.

```sql
-- 0196 — the catalogue translation memory: imported English → Arabic and Sorani (docs/bambu-import/I18N-DESIGN.md).
CREATE TABLE IF NOT EXISTS catalog_translations (
  h TEXT PRIMARY KEY CHECK (length(h) = 64 AND h NOT GLOB '*[^0-9a-f]*'),   -- sha256(normalizeSource(en))
  en TEXT NOT NULL CHECK (length(en) BETWEEN 1 AND 4000),                  -- normalized source, as hashed
  ar TEXT NOT NULL CHECK (length(ar) BETWEEN 1 AND 8000),
  ckb TEXT NOT NULL CHECK (length(ckb) BETWEEN 1 AND 8000),
  kind TEXT NOT NULL DEFAULT '' CHECK (length(kind) <= 40),
  status TEXT NOT NULL CHECK (status IN ('reviewed','machine','needs_review','keep')),
  part TEXT NOT NULL DEFAULT '' CHECK (length(part) <= 40),                -- the data part that last wrote it
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS catalog_translation_refs (                       -- which product shows which string
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 80),
  h TEXT NOT NULL CHECK (length(h) = 64),
  PRIMARY KEY (product_id, h)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_ctr_h ON catalog_translation_refs(h);
CREATE TABLE IF NOT EXISTS catalog_translation_parts (                      -- the loader's ledger (idempotency)
  part TEXT PRIMARY KEY CHECK (part GLOB 'p[0-9][0-9][0-9]*' AND length(part) <= 40),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  rows INTEGER NOT NULL CHECK (rows >= 0),
  run_id TEXT NOT NULL DEFAULT '',
  loaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

Status semantics:
- `reviewed`: written by a translating agent and passed by a second, reviewing agent and the validator.
- `machine`: the local deterministic dictionary's full-coverage output that passes the validator (row 2 allows it).
- `needs_review`: stored, **never displayed**. It is also how a bad row is withdrawn; the loader never deletes.
- `keep` (**Review:** added with the translations): the reviewers' decision that the English stays (a name, a code, a
  file name, a creator's handle). Its `ar` and `ckb` are the English itself; it is stored, never displayed (the English
  is), a later extraction does not offer it again, and a row turned `keep` is withdrawn like a `needs_review` one.

The same commit also changes:
- `worker/lib/schemaVersion.ts`: `EXPECTED_MIGRATION = '0196_catalog_translations.sql'`, and `EXPECTED_MIGRATION_COUNT` + 1.
- `runOps.ts` `migrationsPresent()`: gains `'0196'`.

`WORKER_BUILD` changes with it. The runner requires only 0193–0195 (`run.ts` ~:486), so the active run is unaffected.

### A.3 Data files

`data/bambu-import/translations/`:
- `pNNN.json`: the parts, **not bundled**. One per translation batch (§D), at most 1 MB each (the door's body cap is 2 MB). The format is in §E.
- `index.json`: **bundled**, a few KB. `{ "version": 1, "parts": { "p001": { "sha256": "<64 hex of the file bytes>", "rows": 250, "bytes": 181234 } } }`.

`index.json` is imported by `worker/lib/catalogImport/translations.ts` as a plain JSON module. It is **not** added
to `REVIEWED_FILES` (`reviewed.ts` / `discover.ts` / `cf.mjs`). Doing so would change the reviewed-bundle digest of
the active run and make `/hello` report a mismatch.

### A.4 The loader

**Choice: the import door, driven by workflow 60 mode `translations`.**

| Option | Verdict |
|---|---|
| cf.mjs / wrangler | Rejected. `--command` has no bound parameters, so prose would sit inside SQL literals. Validation would happen outside the Worker, no edge purge is possible (only the Worker reaches its colo cache), and it takes about 1,000 wrangler calls. |
| Owner-only admin endpoint | Rejected for now. The owner's browser has no copy of the part bytes: they are not bundled, and fetching them from GitHub would add a CSP/connect dependency. The owner would also have to act on every load from an iPad. The validator and loader below are written as library functions, so this door can be added later without new logic. |
| **Import door + run token** | **Chosen.** It is the sanctioned live-write channel for this import (DECISIONS row 239). The token is per job, expires, is revoked at job end and has a kill switch. Each part's write is one atomic batch, counted by `countingD1`. The Worker validates and purges. The runner already speaks the protocol. Integrity does not rest on the transport: the Worker refuses any part whose SHA-256 is not the one in the **bundled** index, and that index shipped through CI and workflow 7. |

The cost: the door only answers while a run is `open`/`running`/`blocked`. While the bulk run lives, that is the
bulk run. After it closes, a correction is `mode=open`, then `mode=translations`, then `mode=close`. `finishRun`
closes a run with no items as `closed` (runOps.ts ~:351).

**Route** (`worker/routes/catalogImportOps.ts`): `POST /run/translations`, body `{ part: string, text: string }`,
where `text` is the file's exact content. The logic lives in **`worker/lib/catalogImport/translations.ts`**:

```ts
export async function loadTranslationPart(db: CountedD1, run: ImportRun, part: string, text: string):
  Promise<{ part: string; skipped: boolean; rows: number; inserted: number; updated: number; unchanged: number;
            refs_added: number; purge_ids: string[]; purge_truncated: boolean }>;
```

Steps:
1. Find `part` in the bundled `index.json`, else **409 `TRANSLATIONS_PART_UNKNOWN`** (deploy lagging). Check
   `sha256Hex(text) === index.sha256`, else **409 `TRANSLATIONS_PART_MISMATCH`**. Probe 0196 (the first read below);
   `no such table` gives **409 `TRANSLATIONS_SCHEMA_MISSING`**.
2. Read the ledger: `SELECT sha256 FROM catalog_translation_parts WHERE part = ?`. If it equals the index, answer
   `skipped: true` with no writes and no purge.
3. `JSON.parse(text)`, then `validateTranslationRow` (§E) on **every** row. Any failure refuses the whole part:
   **400 `TRANSLATIONS_ROW_INVALID`**, detail `{index, code}`, never text. **The hash proof is per row:
   `row.h === sourceHash(row.en)` and `row.en === normalizeSource(row.en)`.**
4. Two reads, each with 1 parameter:
   - `SELECT h, ar, ckb, status FROM catalog_translations WHERE h IN (SELECT value FROM json_each(?1))`
   - `SELECT product_id, h FROM catalog_translation_refs WHERE h IN (SELECT value FROM json_each(?1))`
5. One `db.batch` (atomic per part):
   - New or changed rows: `INSERT INTO catalog_translations (h,en,ar,ckb,kind,status,part) VALUES … ON CONFLICT(h) DO UPDATE SET ar=excluded.ar, ckb=excluded.ckb, kind=excluded.kind, status=excluded.status, part=excluded.part, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`. These are packed by `packedInserts` (budget.ts): 7 params, so 14 rows per statement and **≤ 98 parameters**.
   - New refs: `INSERT OR IGNORE INTO catalog_translation_refs (product_id, h) VALUES …`, 50 rows per statement.
   - The ledger upsert `(part, sha256, rows, run_id)`.

   A 250-row part costs about 2 + 18 + 30 + 1 ≈ 50 statements, far below the 900-statement invocation budget and
   the 1,000-statement Worker limit.
6. Purge. The affected products are every product a changed row is linked to — the row's `products` **and the refs
   the database already holds for it** (**Review:** a product dropped from a later version of the row still shows it,
   so its cached copy goes too) — plus those of new refs. One read,
   `SELECT id, slug FROM products WHERE id IN (SELECT value FROM json_each(?))`, keeps the ones that exist, and the
   cap of **60** per part applies to **those** (**Review:** an id not written yet — a create's `p_…`, which sorts
   before every `prd_…` — never takes a live page's place). If more, `purge_truncated` is set and the TTL below
   covers the rest. Then, on the request origin and the root domain (`purgeOrigins`):
   - `purgeAnonymousCache(origin, ['/api/products/<slug>', '/api/products/<slug>/knowledge'])`
   - `publicV1PurgeKeys(origin, { products: slugs })`

   No listing, home or section paths are purged, because cards carry no TM text (D9).

   The purge is best effort, per colo, the same contract as every seam (`purge.ts`). Every other colo ages out
   within s-maxage + stale-while-revalidate:
   - page: 120 s + 600 s (`ANONYMOUS_LIFETIME`, edgePolicy.ts:89)
   - knowledge: 300 s + 600 s (`KNOWLEDGE_LIFETIME`, products.ts:4253)

   So a load is visible everywhere within 15 minutes.

New refusal codes, with ar/en/ckb in `IMPORT_ERROR_MESSAGES` (payload.ts) for the dashboard. The implementer
finalises them with the app's existing vocabulary:
- `TRANSLATIONS_PART_UNKNOWN`: «جزء الترجمات هذا ليس في النسخة المنشورة؛ انتظر اكتمال النشر ثم أعد المحاولة.» / "This translations part is not in the deployed build; wait for the deploy, then retry." / «ئەم بەشەی وەرگێڕانەکان لە وەشانی بڵاوکراوەدا نییە؛ چاوەڕێی تەواوبوونی بڵاوکردنەوە بکە و دووبارە هەوڵ بدەرەوە.»
- `TRANSLATIONS_PART_MISMATCH`: «محتوى جزء الترجمات لا يطابق النسخة المراجَعة، فلم يُحمَّل.» / "The translations part does not match the reviewed copy, so it was not loaded." / «ناوەڕۆکی بەشی وەرگێڕانەکان لەگەڵ وەشانە پێداچوونەوەکراوەکە یەک ناگرێتەوە، بۆیە بار نەکرا.»
- `TRANSLATIONS_ROW_INVALID`: «سطر في جزء الترجمات لم يجتز الفحص، فلم يُحمَّل الجزء.» / "A row of the translations part failed validation, so the part was not loaded." / «دێڕێک لە بەشی وەرگێڕانەکان لە پشکنین دەرنەچوو، بۆیە بەشەکە بار نەکرا.»
- `TRANSLATIONS_SCHEMA_MISSING`: «قاعدة البيانات لا تحوي جداول الترجمات بعد.» / "The database does not have the translation tables yet." / «داتابەیسەکە هێشتا خشتەکانی وەرگێڕانی تێدا نییە.»

**Runner**: `scripts/bambu-import/translations.ts` (CLI) with
`--data data/bambu-import/translations --site <origin> --token-file <f> --run <cir_…>`.
1. Call `/hello` and require `migrations_present['0196']`.
2. For each part in `index.json` order, read the file as UTF-8 and POST it through `opsClient` (new
   `loadTranslations(part, text)`).
3. Log counts only, never text. On a refusal, exit 1.

**Workflow 60** (`.github/workflows/bambu-import.yml`) gains a tenth mode, `translations`:
- `confirm=IMPORT-LIVE`, `run_id` required.
- Steps: `cf.mjs preflight --mode translations --run <id>` (active run, live migrations equal the repository's,
  Time Travel bookmark printed), then `cf.mjs mint --chain-count 0`, then the CLI, then `revoke` (always).
- `cf.mjs` `PREFLIGHT_MODES` gains `translations`, and so does the mode regex at yml ~:198.
- The concurrency group `bambu-import` serializes it with import jobs.

### A.5 Reading at display time

**Read** (`worker/lib/translate/memory.ts`, new):

```ts
export type TranslationMap = ReadonlyMap<string /* normalized en */, Tr>;
/** One statement, 1 parameter, both routes' existing wave. */
export function loadProductTranslationMap(db: D1Database, productId: string): Promise<TranslationMap>;
//  SELECT t.en, t.ar, t.ckb FROM catalog_translation_refs r JOIN catalog_translations t ON t.h = r.h
//   WHERE r.product_id = ?1 AND t.status IN ('reviewed','machine')
export function loadProductsTranslationMaps(db: D1Database, ids: readonly string[]): Promise<Map<string, TranslationMap>>;
//  … WHERE r.product_id IN (SELECT value FROM json_each(?1)) …   (compare, ≤ 4 ids, returns r.product_id too)
```

**Presence probe (CLAUDE.md rule 2).** `translationRead(db, read)` follows `knowledge/schema.ts`. It is
optimistic, with no probe first. When the error is `no such table: catalog_translation(s|_refs)`, it remembers
"absent" per binding for 60 s and answers an empty map. Any **other** failure is logged
(`catalog_translations_read_failed`, error name only) and also answers an empty map. Display text never fails a
page.

With an empty map, every answer is **byte-identical to today**: no new keys, no changed slots.

| Surface | Imported English today | How ar/ckb replace it (English fallback) |
|---|---|---|
| **Product page body** `GET /api/products/:slug` and **public API v1** `/products/{slug}` (both through `catalogProductDetail`, products.ts:3911) | `description_*`, `usage_guide.steps[].title_*/body_*`, `content_blocks[].body_*` (API only), the `sg_bambu_official` spec-group values (API v1 `specifications`) | **Read:** `loadProductTranslationMap` joins the existing `Promise.all` (~:3952), and **only when** `importedSlots(parsed.translation_meta, parsed.spec_groups)` holds. **Review:** the admin form and the template import write `imported` too, always with `en` beside it, so the import's mark is an entry with ar/ckb `imported` and **no** `en` (writer step 10), or the `sg_bambu_official` spec group only the import writes (an imported product the owner later saved in the form keeps it). An ordinary product, saved in the form or not, pays nothing. **Apply:** at the end, on the **outgoing** `body.product`, in both branches. The priced branch re-shapes from `row` (`publicWithDisplayPrice`), so `parsed` cannot carry it. **Function:** `overlayImportedText(product, tm, parsed.translation_meta)` walks `localizableSlots(product)`, restricted to `description`, `how_to_use`, `usage_step:*`, `block:*:body` and `spec:sg_bambu_official:*:value`. It never touches `name`, `option:`, `color:`, `lead_time:`, `warranty:` or `label:`. For each language, it skips a slot whose meta status is `approved`, because human text wins. Otherwise `translateLines(slot.en, lookup)`; with `hit > 0`, `slot.set(lang, text)`. The keys and shape are unchanged (`catalogOnlyProjectionKeys` holds). The client `pick()` and API v1 `localized()` need no change. |
| **Knowledge answer** `GET /api/products/:slug/knowledge` | spec `value_text`, list `items`, box item `text`, `x.*` row labels (`original_label`), `test_method`, document `title_en`, relation labels that are not names | **Read:** `loadProductKnowledge(db, id)` adds `loadProductTranslationMap` as a **seventh statement in its one wave**. **Apply:** `assembleKnowledge(rows, media, { translations })` stays pure and attaches **optional** fields only when a translation exists: `KnowledgeRow.value_i18n?: Tr`, `items_i18n?: (Tr \| null)[]`, `label_i18n?: Tr` (non-registry keys only), `test_method_i18n?: Tr`; `InTheBoxItem.text_i18n?: Tr`; `CompatibilityItem.label_i18n?: Tr`. `KnowledgeDocument.title.ar/ckb` are overwritten with the TM text when `title_en` has a row. VERIFY's `knowledgeProjection` never compares document titles, and its `rowFact`, box and relation facts are allow-lists that ignore every `*_i18n` field. `src/lib/productKnowledge.ts` reads them through one helper, `tx(text, i18n, lang) = lang === 'en' ? text : i18n?.[lang] \|\| text`, inside `valueText` (items joined with «، »), `Row` label/test method, box items and chips. |
| **Compare** `GET /api/compare` | text cells of compare keys (`value_text`) | `loadProductsTranslationMaps(db, ids)` joins the existing wave at compare.ts:536 (`loadCompareKnowledge`). `knowledgeCellsFor(rows, optionId, tm?)` puts `i18n` on the cell. `compareSpecs.ts` `withTranslation` prefers the cell's TM `i18n` and falls back to the dictionary. `SpecTable.tsx` `ValueText` already renders `value.i18n`. |
| **Cards** (home, listing, search) | none in prose. `key_specs` are language-neutral measurements, codes and names; worded facts are already Tri | **No TM read (D9).** The listing is the hottest path, and a per-card lookup would add a statement per listing for no prose. The card already wraps each value in `<bdi>`. |
| Option chooser, product name | names (English by §7) | Not translated. Bidi only (§B). |

**D1 budgets** (`tests/d1Waves.test.ts`). Waves are unchanged everywhere, and every statement binds ≤ 1 parameter.

| Route | waves (warm/cold/member) | prepares |
|---|---|---|
| `/api/products/:slug` (fixture, ordinary) | 2/2/5 unchanged | 23 unchanged (the TM read is skipped) |
| `/api/products/:slug` (**new case: imported product with refs**) | 2/2/5 | 24 (+1 in the existing wave) |
| `/api/products/:slug/knowledge` | 2/2/2 unchanged | 7 → **8** |
| `/api/compare?ids=…` | 5/6/8 unchanged | 25 → **26** |
| `/api/home`, `/api/home/sections`, `/api/products` | unchanged | unchanged |

**Edge cache.** All three answers stay language-neutral: the overlay writes the ar/ckb slots, and `*_i18n` carries
both languages. So the existing cache keys hold, with no `Vary` on language.

The code release bumps `PUBLIC_PROJECTION_REVISION` (edgePolicy.ts:113), for example to `'i18n-dedupe-2026-10'`.
The knowledge answer's compatibility shape changes (§C), and the bump drops every pre-release copy at deploy time.
After that, each TM load purges its products (§A.4).

### A.6 The existing local translator (`worker/lib/translate/*`)

- **Not a display-time fallback for imported strings.** It localises units («0.4 مم»), while this import keeps
  units Latin. On one tab, the two sources would give inconsistent scripts. It also cannot cover marketing prose
  (by design, §3).
- **The stored slots keep its output.** The writer still runs it (`review_needed`). The overlay replaces only the
  lines the TM covers (**Review:** built so — a line the TM misses keeps the stored line, §A.1).
- **Offline**, the extraction uses it twice:
  - as a **seed**: `dict: {ar, ckb}` is attached when `translateText(...).status === 'machine'` for both languages,
    so reviewers edit instead of retyping, and a seed that passes the validator may be committed as `machine`;
  - as the **neutral classifier**: its `IDENTITY_TERMS`, `UNITS` and model-code rule decide what is "numbers, units
    or codes only".
- **Compare keeps** `withTranslation` (dictionary) as its fallback after the TM, so nothing regresses.
- `product_translations` (the admin review backlog) is unchanged. Reconciling it with the TM is a follow-up (Q4).

---

## B. Bidi: mixed Arabic/Kurdish/English text

### B.1 Rules

1. **The direction of a line is decided by its script.** A line that contains any Arabic-script letter
   (`/[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/`) is `rtl`. Every other line is `ltr`.
   `dir="auto"` and `unicode-bidi: plaintext` are **not** used for this. Both take the *first strong character*, and
   a translation that begins with a Latin name (for example `AMS Hub` followed by Arabic) would be laid out LTR.
   In this catalogue, Arabic script present means an ar/ckb translation; absent means the English fallback.
2. **Isolation** comes from the HTML user-agent rule that every element carrying a `dir` attribute is a bidi
   isolate (`[dir] { unicode-bidi: isolate }`). Neighbouring lines and the surrounding layout never reorder each
   other.
3. **Latin and number runs inside an RTL line** become `<bdi dir="ltr">…</bdi>`. A run:
   - **starts** at a Latin letter, a digit, or one of `≤ ≥ < > ± ~ #`. These are mirrored or weak
     characters that must stay inside the run, otherwise `≤` would render as `≥`. **Landing review:** a sign
     `+ - −` starts a run only glued to a digit («-20℉»); a spaced one («بالمسحوق - 0.075mm», «السرير الساخن - LV»,
     «23 حساسًا + 3 كاميرات») separates the sentence's words and stays in the RTL context, between them — isolated
     with the run it was drawn on the run's far side and read as a sign («-0.075mm»).
   - **continues** through Latin letters, digits, spaces and `. , : / \ × * + - – _ ' ’ " % ° ³ ² µ Ω ™ ® © ℃ ℉ & ( )`.
   - **ends** at a Latin letter, a digit, `% ° ³ ² µ Ω ™ ® © ℃ ℉ )`, `"` or `+` (**Review:** «2M+», «PLA Silk+»,
     «Up to 180℃» and «ObXidian™ Hotend» were drawn out of order in Chromium).
   - **trailing punctuation** of the Arabic sentence (`.` `،` `؛` `:`) stays outside.
   - **unbalanced brackets** are trimmed off: a `)` closing Arabic text stays in the RTL context.

   This keeps `256 × 256 × 256 mm`, `389 × 389 × 458 mm`, `220-240 V`, `M3*21.5`, `(SA011)`, `4-Pin` and
   `X1 Series` in reading order. Without it, European numbers separated by neutrals reorder inside an RTL
   paragraph: the defect that `translate/index.ts` version 3 records for «× 389 × 458 مم 389».
4. **Numbers** stay Western digits and **units** stay Latin. The validator (§E) refuses Arabic-Indic digits and
   changed digit runs.
5. **Alignment** is `text-align: start` per line. An English fallback paragraph reads left-aligned, as English
   should. Value cells keep their existing `text-end` alignment.
6. **Truncation**: an element with `truncate` or `line-clamp` gets `dir` from its text, so the ellipsis falls at
   the logical end (`X1 Series and P1 Se…`, not `… Series and P1 Series`).
7. **Names** (always Latin) get `dir="ltr"` plus `text-start rtl:text-right`, the `ProductCard.tsx` ~:190 pattern.
   Parentheses and trailing marks then stay on the right side while the name aligns with the RTL column.
8. **Translators write** Arabic punctuation (`،` `؛` `؟`) between Arabic words and between Latin names inside Arabic
   sentences. They never put bidi control characters (U+200E/F, U+202A–E, U+2066–9) in data; the validator refuses
   them. Isolation is the renderer's job, so search, copy and API v1 get clean text.

### B.2 Code

- **`src/lib/bidi.ts`** (pure): `scriptDir(s): 'rtl' | 'ltr'` and `ltrRuns(s): Array<{ text: string; ltr: boolean }>` (rule 3).
- **`src/components/ui/BidiText.tsx`**: `<BidiText text as?="span|p|div|dd|li|bdi" multiline? className? />`.
  - `multiline` splits on `\n` into one block element per line (replacing `whitespace-pre-line`), each with
    `dir={scriptDir(line)}`.
  - Inside an `rtl` line it renders `ltrRuns` with `<bdi dir="ltr">` around each Latin run. In an `ltr` line it
    renders plain text.
  - It behaves the same in `ar` and `ckb`. In `en` the text is English, so `dir="ltr"` with no runs.

Where it is used:

| Place | Change |
|---|---|
| `Product.tsx` ~:4375 description `<p>` | `<BidiText as="div" multiline>` |
| `Product.tsx` ~:4446–4453 usage step `h5`/`p` (`dir="auto"`) | `BidiText` |
| `Product.tsx` ~:4512 how_to_use | `BidiText` |
| `Product.tsx` ~:4399 legacy box item | `BidiText` |
| `Product.tsx` `Chosen` (~:3125) | `· <bdi dir={scriptDir(value)}>{value}</bdi>` |
| `Product.tsx` chip labels with `truncate` (~:3475, 3540, 3671, 3747) | `dir={scriptDir(label)}` |
| `Product.tsx` h1 name | rule 7 |
| `Product.tsx` the visible desktop name (`<p aria-hidden>`, the h1 is screen-reader-only there) | rule 7 (**Review**) |
| `Product.tsx` the page body's own spec table (the fallback while the knowledge answer is absent) | values through `<BidiText as="bdi">` (**Review:** the overlay writes Arabic and Sorani into those slots) |
| `ProductKnowledgeTabs.tsx` `Row` value (`<bdi>{v.text}</bdi>` ~:333) | `<BidiText as="bdi">` |
| `ProductKnowledgeTabs.tsx` row label, test method, `applies-to` names, `OtherVersions`, checked sources | `BidiText` |
| `ProductKnowledgeTabs.tsx` box item (~:414) | `BidiText`, `text-start rtl:text-right` (**Review:** an English item among translated ones sits beside its bullet) |
| `ProductKnowledgeTabs.tsx` document title (~:235) | `BidiText` |
| `ProductKnowledgeTabs.tsx` compatibility chips | §C.4 |
| `SpecTable.tsx` `ValueText` (~:98–104) | Numeric values are unchanged (`<bdi dir="ltr">`). A text value with Arabic script uses `BidiText`; Latin-only is unchanged. **Landing review:** the server joins a list's items with «، » in every language, so on the English page that separator alone is not Arabic script — a list of English items reads LTR, in order. |
| `ProductCard.tsx` key line | unchanged (already `<bdi>` per value, name `dir="ltr"`) |

---

## C. Compatibility dedupe

### C.1 Rule (in `assembleKnowledge`, answer.ts ~:438)

1. Map each relation row to its bucket, as today (`compatibilityBucketOf`).
2. **Group** rows by `bucket | relation | labelKey(target_label)`, using `labelKey` from normalize.ts.
3. **Scope merge** inside a group:
   - If any row has product scope, the group yields **one** item with product scope. Rows scoped to values or
     variants are dropped: a product-wide fact already applies to every selection.
   - Otherwise it yields one item per distinct `(scope_kind, scope_id)`.
4. Fields of the item:
   - `label`: the code-point-smallest label in the group, so it is deterministic whatever the input order (SQL
     order vs payload order).
   - `target_kind`: the smallest in the group.
   - `state`: `resolved` if any row is resolved, else `pending` if any is pending, else `unresolvable`.
   - `product`: the first visible target by `t_slug`.
   - **new** `more?: Array<{ id; slug; name: Tri; image }>`: the other visible targets, sorted by slug, distinct by id.
5. Result for filament-buffer: **compatible = [`P1 Series`, `X1 Series`], requires = [`AMS Hub`]**. When `p1s` and
   `refurbished-p1s` are both visible, `P1 Series` carries `product` plus one entry in `more`.

### C.2 Consistency

- **VERIFY** (`scripts/bambu-import/verify.ts` `expectedKnowledge`) calls the same `assembleKnowledge`, so both
  sides change together.
- The rule never depends on visibility. Grouping is by label, never by the target id, so the expected side (no
  `t_id`) and the live side (links) produce the same items. The projection fact
  (`bucket, relation, label, target_kind, scope`) then matches, and `state` is already blanked in
  `reducedProjection`.
- **The runner's browser check** uses the page's own `knowledgeTabs` (browser.ts:330), so it changes together too.
- `verifyD1` and `report.ts` count D1 rows, not answer items, so they are unchanged.
- Compare and cards do not read relations.

### C.3 The `compat.statement` row (D8)

This lives in `src/lib/productKnowledge.ts` `knowledgeTabs` (client, pure). The server answer is unchanged, so
VERIFY's rows are untouched.

- When the Compatibility tab exists for the selection, `compat.statement` rows are removed from the specs/materials
  groups. An emptied group disappears.
- The row moves to `tabs.compatibilityNote`, but **only if the statement says more than the chips**. The test: remove
  every chip label (`labelKey`, longest first, word-bounded) and the connectors
  `and or & / , ; + with series printers compatible compatibility`. If any Latin word of two or more letters remains,
  the statement says more. **Review:** exactly these connectors (the build had added `for the all printer`), and a
  statement in which no label was found says more («Compatible with all printers» beside an «AMS Hub» chip).
- When it does, it renders under the chips as one muted line: the translated value through `tx`, with the «غير مؤكد»
  badge kept.
- For filament-buffer, «التوافق: X1 Series and P1 Series» disappears.
- The **option chooser stays** («التوافق · X1 Series and P1 Series»), as the owner asked.

### C.4 «يتطلب» and links (owner item 4)

- **Resolution**: as built. The writer's incoming step resolves `ams-hub`, `affectedProducts` purges the buffer's
  page and knowledge, and the item gains `product`.
- **Rendering** (`ProductKnowledgeTabs.tsx` ~:191):
  - **Linked**: `[product, ...more]`, each an `lv-choice` `<Link>` chip with a picture and a link chevron, name per
    rule B.7. **Landing review:** the name is the target's English name in every language (`pickName`'s rule): a merged
    live product keeps its own Arabic and Sorani names («طابعة Bambu Lab P1S … ثلاثية الأبعاد»), which `dir="ltr"`
    reversed; a row with no English name shows the one it has with `dir={scriptDir(name)}`. For `target_kind === 'family'` with links, the family label is a plain prefix («P1 Series:») followed
    by the member chips. **Review:** one chip per product in a bucket — a compound's two labels may reach the same
    product («H2D and H2D Laser»: the H2D family and the H2D Laser printer), so a product already drawn in the bucket
    is not drawn again, and an item left with no chip is not drawn. Grouping stays by label (§C.2).
  - **Unlinked** (pending or unresolvable): **plain text**. No border, no pill, no hover or min-height affordance;
    items are separated by «، » (an `<li>` of `text-sm text-text-secondary`, through `BidiText`). It cannot be
    mistaken for a button.

---

## D. String extraction: `scripts/bambu-import/i18n-strings.ts`

```
npx tsx scripts/bambu-import/i18n-strings.ts \
  --corpus <scratchpad>/corpus/p0/raw --data data/bambu-import \
  --out <scratchpad>/i18n [--batch-size 250] [--existing data/bambu-import/translations]
```

**Build exactly as the runner does.**
1. `loadReviewedBundle(dataDir)` (discover.ts). Then, for each manifest row in queue order:
   - File: `<corpus>/<handle with every char outside [A-Za-z0-9._-] replaced by "_">.html.gz`. This is the crawler's
     rule (`crawl.py` :26), applied per code point with the `u` flag. A `.status` file means the page was withdrawn:
     report it and skip.
   - `gunzip`, then `extractPage(html).extraction`.
   - Check that `sourceProductId` and `handle` equal the row's (as `run.ts` `extract()` does).
2. Call `buildImportPayload` with the runner's inputs (run.ts ~:992):
   - `writeMode` and `mergeProductId` from `writeModeOf(bundle, sid)`;
   - `extractionSha256: extractionFingerprint(x)`;
   - `manifestRow: row`, `identity: bundle.identity[handle]`, `targets: bundle.targets`, `overrides: bundle.overrides`.
3. Apply `mergeCurated` (enrich.ts) when `curatedGate` gives a file. The index is empty today.
4. Make no network call. A test fails if `fetch` is invoked. Wiki and tracker rows from ENRICH are therefore not in
   the corpus; their strings stay English (Q3).

**Collect**, with the stored transformations mirrored:

| Kind | From | Surface |
|---|---|---|
| `short_description` | `product.short_description_en`, by lines | page |
| `usage_title` / `usage_body` | `usage_steps[].title_en` (whole) / `body_en` lines | page |
| `spec_value_text` | public, non-owner-only (`isOwnerOnlyKey`) spec rows: `value_text` (whole), except lists and the box | page |
| `spec_list_item` | string items of `data_type: 'list'` rows | page |
| `spec_label` | `original_label` of `x.*` keys (registry keys have authored labels) | page |
| `box_item` | `package.contents` `value_list[].text` | page |
| `test_method` | `test_method` | page |
| `doc_title` | `documents[].title_en` when not the registry default (`DOCUMENT_TITLES[kind].en`) | page |
| `relation_label` | `target_label` when not a name (expected empty) | page |
| `block_title` / `block_line` / `block_cell` | text `content_blocks`: the title line once per section (writer `contentBlocksOf`), body lines with bullets stripped, `' \| '` cells. `BLOCK_TITLES` are authored. | api |
| `faq_q` / `faq_a` | FAQ block: pairs split on blank lines; first line is the question | api |

**Exclude**, with a reason counter for each:
- owner-only rows;
- registry-authored strings (`DOCUMENT_TITLES`, `BLOCK_TITLES`, registry labels);
- **names**: the normalized `labelKey` equals a manifest title, a compat-targets `labels`/`compounds`/
  `requirement_targets` key, a registry `MODELS` label or token, or `Bambu Lab`. A string made only of names joined
  by connectors also counts as a name (the §C.3 rule, which needs at least one name);
- **neutral**: after removing numbers, ranges, `× x *` separators, dictionary `UNITS`, `IDENTITY_TERMS`, model and
  part codes (`MODEL_CODE_RE` and `^[A-Z]{2,}\d`), URLs and punctuation, no Latin word of two or more letters is left.
  This removes `24V`, `50 g` and `PLA, PETG`. **Review:** also a measurement with `*`, `x` or `±` between numbers
  and a squared or cubed unit (`300*285 mm²`, `4.0x1.7mm`, `85±5mm°`, `≥60HRC`), a symbol unit the dictionary lacks
  right after a number (`2.45mW`, `16.4ft`, `13.56MHz`), a creator's handle (`@storm879`) and one token of letters and
  digits (`Makerize3D`), never a glued numbered heading (`4.Printability`);
- strings already in Arabic script;
- with `--existing`, strings already in committed parts — **Review:** not offered, but linked (below).

Option and colour value names are **not** a global exclusion. `Black` as a spec value is translated; `Black` as an
option value is never overlaid. **Review:** on the product that HAS that option or colour, an occurrence equal to its
own value name is a name (no ref, so it reads English on that product's every surface, mandate §3/§7); the validator
does not protect value names globally — measured over the corpus, that refused 101 good translations of ordinary
words that happen to be some product's option («Hardened Steel», «LED Light», «1 pc», «Left Side Panel»).

A registry string that is also offered as a value (a box item «Hotend» and a table cell «Hotend») is **one** offered
string serving every product, never also an authored p000 row (**Review:** the same `h` in two parts fails CI).

**A later round** (**Review**), `--existing data/bambu-import/translations`: a committed string is not offered again;
every product of this round that uses it is listed in `strings.json` `linked: [{ h, en, part, products }]`, and the
assembler adds those products to the committed row (their refs). The batches are numbered after the highest committed
part (`nextBatchNumber`), so a round's parts never collide with another's.

**Output**: `<out>/strings.json`.

```json
{ "version": 1, "generated_at": "…", "inputs": { "corpus": "…", "code_commit": "…", "reviewed_bundle_sha256": "…" },
  "counts": { "products_built": 0, "products_failed": [{ "handle": "…", "reason": "…" }], "unique": 0, "occurrences": 0, "chars": 0,
              "by_kind": { "…": { "unique": 0, "occurrences": 0, "chars": 0 } }, "by_surface": { "page": {}, "api": {} },
              "excluded": { "owner_only": 0, "registry": 0, "name": 0, "neutral": 0, "arabic": 0, "existing": 0 } },
  "strings": [ { "h": "<sourceHash(en)>", "en": "<normalized>", "kind": "<first kind>", "kinds": { "spec_value_text": 3 },
                 "surface": "page", "freq": 3, "products": ["p_…"], "handles": ["filament-buffer"],
                 "context": { "handle": "filament-buffer", "title": "Filament Buffer", "field": "specs[electrical.current]", "near": "Electricity" },
                 "dict": null } ] }
```

- `products` are the payload's `product_id`s: the deterministic `p_…` for a create, the reviewed id for a merge.
  They are exactly what the writer stores, and they become the refs.
- `near` is the neighbouring line, block title or spec label, at most 160 characters.
- `dict` is the local dictionary seed (§A.6).
- Strings are sorted by (queue position of the first product, field order).

**Batches**: `<out>/batches/bNNN.json`, `{ batch, surface, handles: [...], strings: [{ h, en, kind, freq, context, dict }] }`.
- Each batch holds about 250 strings. **All page-surface strings come first**, then API-only.
- Products are walked in queue order, and each product's new strings are appended. If adding a product would pass
  250 and the batch already holds 125 or more, a new batch starts. A product with more than 250 strings spans
  consecutive batches. **A string goes into the batch of its first product.**
- Also written: `<out>/glossary.json`, the app's existing vocabulary in en, ar and ckb. Sources: dictionary
  `PHRASES`, registry spec and group labels, `BLOCK_TITLES`, `DOCUMENT_TITLES`, the colour registry, taxonomy-map
  names and search synonyms. Also `<out>/RULES.md`: the house rules of the header plus §B.1 rule 8 for translators.
- Expect about 35 batches (13 page, 22 api) from the measured counts.

**Return path**:
1. Translators write `batches/batch-NNN.out.json` as `[{ h, ar, ckb, status: 'reviewed' | 'needs_review' | 'keep' }]`.
   **Review:** any other status — none, a typo, `draft` — refuses that row (`STATUS`); it is never committed `reviewed`.
2. Reviewers sign off.
3. **`scripts/bambu-import/i18n-assemble.ts`** joins `strings.json` with the outputs and runs
   `validateTranslationRow` on every row, printing all refusals.
4. It writes `data/bambu-import/translations/pNNN.json` (one per batch, same grouping) and regenerates `index.json`.
   A coverage report lists strings without a translation; those show English. **Review:** a part this run owns (p000
   and its batches' numbers) that ends up empty is removed (p000 too with `--no-authored`); a part file holding a
   string of no batch of this run belongs to another round and is never overwritten (a problem, exit 1); a later
   round's `linked` products are added to the committed rows.
5. The output is deterministic: rows in batch order, `products` sorted, and keys in the order
   `h, en, ar, ckb, kind, status, products`.

---

## E. Data format, its test, the hash proof

**Part file** `data/bambu-import/translations/pNNN.json`: a JSON array with one row per line, UTF-8, LF and a
trailing newline.

```json
[
{"h":"<64 hex>","en":"Below 10mA","ar":"أقل من 10mA","ckb":"کەمتر لە 10mA","kind":"spec_value_text","status":"reviewed","products":["p_…"]}
]
```

This deviates from the brief's `{h, en, ar, ckb, kind}` in two ways, both required:
- `status`, so a row can be `needs_review` or withdrawn without a DELETE;
- `products`, so the loader can write refs and purge without reading product content.

**`validateTranslationRow(row, ctx?: { names?: ReadonlySet<string> })`**, in `packages/catalog/src/bambuImport/i18n.ts`,
returns `{ ok: true, row } | { ok: false, code }`. It is the same function for the assembler, the CI test and the
loader:

| Code | Rule |
|---|---|
| `SHAPE` | Exactly the 7 keys, with the right types. |
| `HASH` | `h === sourceHash(en)`: **the proof**. |
| `NOT_NORMALIZED` | `en`, `ar` and `ckb` each equal `normalizeSource` of themselves (no newline, no double space, NFC). |
| `KIND` / `STATUS` | In `TM_KINDS` / in `{reviewed, machine, needs_review, keep}`. |
| `KEEP` | A `keep` row's `ar` and `ckb` are its `en` (no translation slipped in). The script, digit, token and name checks below apply to every other status. |
| `EMPTY` / `TOO_LONG` | `en` is 1–4,000 characters. `ar` and `ckb` are 1–8,000 and at most `max(3 × en.length, en.length + 200)`. |
| `AR_SCRIPT` | `ar` has at least one Arabic letter and no Sorani-only letter (`ە ێ ۆ ڵ ڕ ۊ`). |
| `CKB_SCRIPT` | `ckb` has at least one Arabic-script letter, and once it has two or more Arabic-script words, at least one of `ە ێ ۆ ڵ ڕ`. |
| `CKB_COPIES_AR` | `ckb !== ar` (row 183). |
| `DIGITS` | The multiset of Western digit runs in `en` equals that in `ar` and in `ckb`. No `[٠-٩۰-۹]`. |
| `TOKEN_LOST` | Every code, model or part token (`MODEL_CODE_RE`, `^[A-Z]{2,}\d`), every `IDENTITY_TERMS` hit and every unit attached to a number in `en` appears verbatim in `ar` and `ckb`. **Review:** a numbered heading or a sentence the source glued to the next («3.Spool», «ports.When», «20W.When») is cut at the dot first: the number and the code stay protected, the word after it is a word (96 honest headings were refused). |
| `NAME_TRANSLATED` | With `ctx.names` (CI and assembler: manifest titles and compat labels), every name found in `en` appears verbatim. |
| `BIDI_CONTROL` | No U+200E/F, U+202A–E or U+2066–9. |
| `MONEY_ADDED` | `ar`/`ckb` match no currency or price/stock/shipping-time marker (`د.ع`, `دينار`, `دۆلار`, `$`, `USD`, `IQD`, `سعر`, `أسعار`, `نرخ`, `مخزون`, `کۆگا`, `الشحن خلال`, `التوصيل خلال`), nor a cost (`تكلفة`, `كلفة`, `تكاليف`, `تێچوو`) unless the English states one. The English was already scrubbed by the import's classifier, so any such marker is an addition. **Review:** `نرخ` only at the start of a word — «بەنرخ» is «valuable», «بێنرخ» «worthless». |
| `PRODUCTS` | A non-empty, sorted, unique list of ids matching `^[A-Za-z0-9_-]{1,80}$`, at most 2,000. |

**`tests/catalogTranslationsData.test.ts`** (CI, every shard set) runs over every committed part (and, independently
of the validator, re-proves every row: `h` is the SHA-256 of its `en` under the shared normalization, no empty `ar`
or `ckb`, `ckb ≠ ar` unless `keep`, a `keep` row is its English, no price, cost, stock or shipping word the English
does not carry):
- `index.json` lists exactly the `p*.json` files present. Each entry's `sha256`, `rows` and `bytes` match, and each
  file is 1 MB or less.
- Every row passes `validateTranslationRow` with `names`.
- `h` is unique across all parts, and so is `en`.
- Every `products` id is a manifest product id: a create's `p_…` derived from its source id, or a merge's reviewed
  id (`existing-matches.json`).

An empty directory, holding only `{ version: 1, parts: {} }`, passes, so the code release can land first.

**The loader's proof (§A.4)** has two parts:
- the part's bytes hash to the bundled index entry, so only reviewed and deployed data loads;
- every row is re-validated, including `h === sourceHash(en)` and `en === normalizeSource(en)`, before anything is
  written. One bad row refuses the whole part.

---

## F. Files

| New | Purpose |
|---|---|
| `migrations/0196_catalog_translations.sql` | §A.2 |
| `packages/catalog/src/bambuImport/i18n.ts` | `normalizeSource`, `sourceHash`, `translateLines`, `translateWhole`, `TM_KINDS`, `TM_STATUSES`, `validateTranslationRow`, `namesOnly` (§C.3 / §D) |
| `worker/lib/translate/memory.ts` | `translationRead`, `loadProductTranslationMap`, `loadProductsTranslationMaps`, `importedSlots`, `overlayImportedText`, `OVERLAY_SLOTS` |
| `worker/lib/catalogImport/translations.ts` | the bundled `translations/index.json`, `loadTranslationPart`, purge helper |
| `data/bambu-import/translations/index.json` | `{ "version": 1, "parts": {} }` at first |
| `scripts/bambu-import/i18n-strings.ts`, `scripts/bambu-import/i18n-assemble.ts`, `scripts/bambu-import/translations.ts` | §D, §E, §A.4 |
| `src/lib/bidi.ts`, `src/components/ui/BidiText.tsx` | §B |

| Changed | Change |
|---|---|
| `worker/lib/knowledge/answer.ts` | `assembleKnowledge(rows, media, opts?)`, dedupe (§C.1), `*_i18n` fields, `CompatibilityItem.more` |
| `worker/lib/knowledge/productKnowledge.ts` | seventh read in the wave |
| `worker/routes/products.ts` | `catalogProductDetail`: gated TM read in the wave, overlay on `body.product` |
| `worker/lib/knowledge/compare.ts`, `compareKeys.ts`, `worker/lib/compareSpecs.ts`, `worker/routes/compare.ts` | TM read in the wave, `i18n` on cells, TM before the dictionary |
| `worker/routes/catalogImportOps.ts`, `worker/lib/catalogImport/runOps.ts` (`migrationsPresent` 0196), `packages/catalog/src/bambuImport/payload.ts` (`IMPORT_ERROR_MESSAGES`) | door and codes |
| `scripts/bambu-import/opsClient.ts`, `scripts/bambu-import/cf.mjs` (`PREFLIGHT_MODES`), `.github/workflows/bambu-import.yml` | mode `translations` |
| `worker/lib/schemaVersion.ts`, `worker/lib/edgePolicy.ts` (`PUBLIC_PROJECTION_REVISION`) | §A.2, §A.5 |
| `src/lib/productKnowledge.ts` | types, `tx`, `valueText`, `knowledgeTabs` (C.3), `compatibilityNote` |
| `src/components/product/ProductKnowledgeTabs.tsx`, `src/pages/Product.tsx`, `src/components/compare/SpecTable.tsx` | §B.2, §C.4 |

No product row, 0194 row, guard trigger, reviewed-bundle file or `/stage` budget changes. The writer is untouched.

## G. Tests (new, or neighbours to extend)

- `tests/catalogTranslationsSchema.test.ts`: 0196 applies twice; the CHECKs refuse a bad `h`, status and part; a refs
  PK duplicate is ignored by `INSERT OR IGNORE`.
- `tests/catalogTranslationsData.test.ts`: §E.
- `tests/catalogI18nSegments.test.ts`:
  - `normalizeSource` (NBSP, ZWSP, CRLF, NFD to NFC) and `sourceHash`, checked against `sha256sum`;
  - `translateLines`: a bullet prefix is kept, `' | '` cells, partial hits, `hit 0` leaves the text untouched;
  - the validator: every code, with one failing and one passing example each.
- `tests/catalogTranslationsLoader.test.ts`, through the real Hono ops router, `LimitD1` and a wave and params adapter:
  - unknown part → 409, sha mismatch → 409, one bad row → 400 with nothing written, missing 0196 → 409;
  - a first load inserts rows and refs and purges the products' paths (a cache double records the keys);
  - a re-load of the same sha → `skipped`, no writes, no purge;
  - a changed row → `updated` and purges only its products;
  - every statement has ≤ 100 parameters, the statement count is under budget, and the run token is required
    (404 uniformity).
- `tests/catalogTranslationsDisplay.test.ts`:
  - the page body of an imported product: `description_ar/ckb` replaced, an `approved` slot kept, `lead_time:`,
    names and options untouched, `ckb` never equal to `ar`;
  - API v1 `description`, `usage_guide` and `content` carry the TM;
  - knowledge `*_i18n`, document title, compare cell `i18n`;
  - **a database at 0195 (no 0196) answers byte-identical bodies**, and a non-schema read failure gives English,
    never a 5xx.
- `tests/d1Waves.test.ts`: the new imported-product case (2/2/5, 24), knowledge 8, compare 26, everything else
  unchanged.
- `tests/knowledgeCompatDedupe.test.ts`:
  - the canary's 7 rows (from `filament-buffer.page.html` + `compat-targets.json`) give compatible
    `[P1 Series, X1 Series]` and requires `[AMS Hub]`;
  - the scope merge;
  - visible `p1s` + `refurbished-p1s` give one item with `product` and `more`;
  - order independence (shuffled rows give the same answer).
- Extend `tests/bambuImportVerify.test.ts`: `expectedKnowledge` against a live assembly with visible targets and
  `*_i18n` gives `knowledgeDiff` all 0 and the same `reducedProjection`.
- Extend `tests/productKnowledgeTabs.test.ts` (markup and pure) and `tests/productKnowledgeRoute.test.ts`:
  - `compat.statement` hidden when covered and shown as a note when not;
  - an unlinked chip is plain text with no `<a>` and no pill class;
  - a linked chip is `<a href="/product/ams-hub">`;
  - `«أقل من 10mA»` renders `dir="rtl"` with `<bdi dir="ltr">10mA</bdi>`, and the English fallback renders `dir="ltr"`.
- `tests/bidi.test.ts`: `scriptDir` and `ltrRuns` on `X1 Series و P1 Series`, `389 × 389 × 458 mm` inside Arabic,
  `≤ 300 °C`, `(SA011)`, an Arabic parenthetical, trailing `.`, Sorani with Latin, pure English and pure Arabic.
- `tests/bambuI18nStrings.test.ts`, over the fixtures (`filament-buffer`, `ams-2-pro` pages, the 8 samples):
  - filament-buffer emits `Below 10mA`, `Plastics, PCBA`, `Gray`, the box item and the description;
  - it never emits `24V`, `X1 Series`, `AMS Hub`, `X1 Series and P1 Series` or owner-only text;
  - batches keep a product together, and the output is deterministic (two runs, byte-equal);
  - no `fetch`.
- Neighbours:
  - `catalogImportAuth` (the route list), `catalogImportE2E`, `catalogImportTranslations`, `catalogOnlyProjectionKeys`;
  - `compareKnowledge`, `compareCellsKnowledge`, `productCardKnowledge`;
  - `translate`, `translateStore`;
  - `schemaVersion`, `schemaDriftAlarm`;
  - `programmeRefusals` (the new codes in ar/en/ckb, with no ckb equal to ar);
  - the customer-DTO leak scanners (no `products`, `kind` or `part` reaches a customer);
  - `bundleBudget`, `claySystem`.
- A new test file may trip `tests/rootShardBalance.test.ts` until `scripts/test-timings.json` is regenerated from CI.

## H. Rollout

1. **The code release, one push.** It carries everything in §F with an empty `index.json`, and the
   `PUBLIC_PROJECTION_REVISION` bump. `npm run check` and `npm run test:unit` must be green before pushing. Workflow 7
   applies 0196 and deploys. The dedupe, bidi and chip fixes go live at once, with no data needed.
2. **Before** the next workflow 60 job, wait until workflow 7 is green for that commit. The runner's VERIFY and the
   live Worker must share `assembleKnowledge`: an older runner against a deduping Worker would fail every item's
   knowledge check.
3. **Extraction**, from the scratchpad: `strings.json`, then batches (page surface first), then translators and
   reviewers, then `i18n-assemble.ts`. Commit the parts and `index.json` as data commits. `index.json` is bundled,
   so each data push is a deploy.
4. **Load**: workflow 60 `mode=translations` with the active run, dispatched by the owner. Then check
   `/product/filament-buffer` live in ar, en and ckb, on phone and desktop, in light and dark.
5. The content-block (api) batches wait for Q1.

## I. Open questions

- **Q1** (the translations were made for both surfaces, 8,643 strings, so this no longer decides the effort): Should the storefront draw the content blocks (Overview, Highlights, FAQ)? Today they are carried only to
  API v1. That decides whether the 5.5k api strings (628k characters, 72% of the effort) are translated now.
- **Q2**: For filament-buffer, «يتطلب AMS Hub» comes from "For multiple AMS units, the AMS Hub is required **instead
  of** the Filament buffer". The hub is an alternative, not a requirement. `relations.ts` `scanRequire` does not read
  "instead of". Changing it is a builder change, which alters payloads mid-import, so it is not proposed here. The
  link will work as asked.
- **Q3**: Strings that only ENRICH adds (wiki tables, tracker titles, future curated files) are not in the corpus.
  A later harvest could add them: re-run the extraction with the runner's enriched payloads, or add a door read of
  untranslated displayed strings.
- **Q4**: Should the admin's translation review (`product_translations`, all `review_needed`) show the TM text as the
  suggestion and mark covered slots? This is display-neutral and not required for the owner's request.
- **Q5**: The social preview (`worker/lib/socialPreview.ts`) reads the row directly, so shared links keep the English
  description. Overlaying there would add one statement to the document path.
