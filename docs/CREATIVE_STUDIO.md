# استوديو Levonis الإبداعي — Levonis Creative Studio

**Owner request, 2026-10-27** (the full Arabic brief, sections 1–46). This file is
the architecture decision: what was reused, what was added, the editor choice and
the evidence for it, and the rules every part of the studio keeps. Progress, phase
by phase, is in `docs/CREATIVE_STUDIO_PROGRESS.md`.

> **ملخص للمالك.** الاستوديو صفحة داخل لوحة الإدارة على `/admin/creative-studio`،
> للمالك والمسؤولين بصلاحية كاملة. التصميم مستند بطبقات حقيقية (نص، صورة، شكل)
> بمعرّفات ثابتة، يُرسم بمحرك Konva داخل المتصفح، ويُحفظ في قاعدة بيانات المتجر
> بإصدارات. Claude يقترح الأفكار والنصوص والتعديلات المحددة فقط؛ التطبيق يتحقق من
> كل اقتراح قبل تطبيقه. السعر والتوفر واسم المنتج تُرسم من بيانات المتجر الموثقة
> ولا يكتبها الذكاء الاصطناعي أبداً، وصورة المنتج لا تُمدَّد. النص الكردي (السوراني)
> يكتبه شخص، لا النموذج (قرار الصف 262).

## 1. Where it lives and who may use it

| | |
|---|---|
| Page | `/admin/creative-studio` — a full-screen admin route (the canvas needs the viewport), lazy-loaded; linked from the admin sidebar group «النمو / Growth» |
| API | `/api/admin/creative-studio/*` (`worker/routes/adminCreativeStudio.ts`), apex host only like every admin router |
| Shared model | `packages/creativeDoc` — pure; the Worker and the editor run the same normaliser, operations and checks |
| Database | the store's D1, studio tables only (`creative_*`, migration `0215_creative_studio.sql`); store tables are **read**, never written |
| Files | the private R2 bucket under `creative-studio/…`, served only through the studio API |

Roles (spec §32, mapped onto the repository's model, server-side on every route):

| Spec role | Here | May |
|---|---|---|
| Owner | the verified owner (`INITIAL_ADMIN_EMAIL`, `requireOwner`) | provider key, model, effort, budget, rates; brand-kit versions and their approval; service claims |
| Designer + Reviewer | owner and full-scope admins | documents, AI requests, exports, approval of a specific version |
| — | assistant admins | refused (`403 CREATIVE_SCOPE_REQUIRED`) until a capability grant is designed |
| Publisher | — | no external publishing exists (spec §26 is a later integration) |

## 2. The editor engine — decision and evidence (spec §3)

**Decision: Konva 10.9.0 as the view layer, driven by our own versioned JSON
document (`packages/creativeDoc/src/schema.ts`). Text is edited in a DOM overlay
`<textarea>`, never inside the canvas.**

The mandatory selection test (connected Arabic headline, mixed Arabic/Latin
paragraph, marked test price, a non-square original picture contain-fitted, a
marked test logo; edit, save, reopen, export PNG; preview vs export) was run in
headless Chromium 153 with Playwright on 2026-10-27, with IBM Plex Sans Arabic
(OFL-1.1, `@ibm/plex-sans-arabic@1.1.0`):

| | Canvas 2D (own) | **Konva 10.9.0** | Fabric 7.4.0 |
|---|---|---|---|
| Arabic joining | correct | correct (native `fillText` per line) | breaks as soon as one word has its own style (lam-alef split) |
| Mixed BiDi ("Bambu Lab A1 Combo" inside Arabic) | correct | correct, pixel-identical to Canvas 2D | word order reversed with any per-character style |
| Preview vs export | 0 % pixels differ | 0 % | 0 % |
| Save → reopen → export | 0 % | 0 % | 0.95 % (numbers rounded to 4 digits on save) |
| Uniform scale lock | must be written | `Transformer({keepRatio, corner anchors only})` held 1.5:1 under a skewed drag | held with `uniformScaling` |
| Arabic text editing | none built in | DOM overlay: caret and selection correct, also inside the Latin run | built-in editing draws the caret mirrored inside Latin runs; Home/End swapped |
| Size (min+gzip) | 0 | 44.4 KB (core + Text, Image, Rect, Transformer) | 87.8 KB |

The complete apps were read, not embedded:

- **OpenDesign** (`nexu-io/open-design` @ `26d6029`, Apache-2.0): a Node daemon +
  Next.js (React 18) / Electron app whose output is generated HTML, not editable
  layers; its BYOK key is kept in browser localStorage. None of that fits a
  Cloudflare Worker + D1 store, and code output cannot be validated operation by
  operation. Ideas borrowed: design-system prompts.
- **OpenPencil** (`open-pencil/open-pencil` @ `38b6a04`, MIT): the right model —
  a scene graph with stable ids, AI edits as typed tool calls on nodes, per-node
  text direction — but a Vue SDK on 7 MB of CanvasKit WASM with local-file
  persistence. **Its model is what we copied**: stable ids, bounded operations,
  per-layer `direction`.

Limits recorded: tested in Chromium only (Safari/Firefox `ctx.direction` and
HiDPI untested); one style per text layer (a highlighted word is its own layer —
styling part of a word breaks Arabic joining in every canvas engine); the Worker
has no canvas, so measuring, rendering and export happen in the browser.

## 3. The document (spec §15)

`CreativeDocument` v1: format (1080×1080, 1080×1350, 1080×1920 or a bounded
custom size), locale and base direction, objective, visual priority, density,
template + variant, brand version, safe area, product bindings (slot →
product, variant, snapshot), service bindings (claim, version), layers,
relations, annotations, caption and alt text.

- **Coordinates** are document pixels at 1× export size, origin top-left, y down.
  The editor draws at `scale` with a pan offset; `viewToDoc`/`docToView` are the
  only conversion (pointing and annotations survive zoom and phones).
- **A product picture has ONE `scale`** — its box is derived from the picture's
  own size — so a stretch cannot be stored; there is no flip, skew or
  perspective field; a crop is a deliberate `detail` shot that keeps the crop's
  own ratio.
- **A price, availability or product name is a binding**, rendered from the
  marketing snapshot by the app; a model (or a person) writing into it is refused.
  Unpriced renders «السعر عند الطلب», never 0; a membership price is never drawn
  as the public price; a `test` snapshot is labelled «تجريبي».
- **No letter-spacing field** (it breaks Arabic joining).
- Approval, version counters and authorship live in the Worker's tables, not in
  the JSON.

`normalizeDocument` is the one gate (Worker write and read, editor load and
import, anything built from a model's proposal): unknown is stripped, out of
range is clamped, dangerous is refused (foreign image URLs, invented fonts,
duplicate ids, future schemas, oversize documents).

## 4. Claude (spec §27, §28)

- **Provider adapter** `worker/lib/creative/anthropic.ts`: raw `fetch` to
  `https://api.anthropic.com/v1/messages` through an injectable transport (host
  allow-list, `redirect: 'manual'`, timeout, body cap, every failure mapped to a
  code) — the same shape as the planned AI layer (`docs/handoff/assist-ai-layer-B1-plan.md`).
  Structured outputs via `output_config.format` (`json_schema`); the schemas and
  the second, local validation live in `packages/creativeDoc/src/aiContracts.ts`.
- **Key sources**, in order: (1) a key the owner typed in the studio settings,
  sealed with AES-256-GCM under the Worker secret `CREATIVE_STUDIO_ENC_KEY`
  (key kept apart from the database; ciphertext bound to its row), never returned
  — only a 4-character hint; (2) the existing Worker secret `ANTHROPIC_API_KEY`
  (already set on the live Worker, DECISIONS row 262). Without either, the studio
  works fully by hand and says AI is not configured.
- **No model id is written in the repository**: the owner picks from the live
  `GET /v1/models` list; the choice is a D1 row.
- **What a model never does**: state a price, an availability or a claim the
  request did not prove (discount, cheapest, last piece, rating, warranty term,
  arrival, back in stock); write a link; write Sorani; touch a locked layer (or
  anything inside a locked group); approve, publish or change settings. Each is
  enforced by code, not only by the prompt. The text guards are a **pattern
  check** over a normalised copy of the words (invisible characters, harakat
  and tatweel dropped, Persian and Arabic-Indic digits read as digits) — they
  catch the common phrasings in Arabic, English and Sorani, not every possible
  wording; the final checks re-run them on every visible free text at approval.
- **Budget**: daily requests and tokens always capped; USD caps when the owner
  sets rates (costs are always labelled *estimated*). A worst-case reservation
  is taken before every call and settled after; usage rows carry no text, key
  or prompt.
- **Jobs**: every AI call has a job row (idempotency key, base document version,
  target ids); a cancelled job's late result is never applied; a stale result
  (document moved on) is refused by version.

## 5. Store data (spec §9, §10)

Read-only, through the public card path (the price a guest sees now —
`resolveProductCards` / `priceFromCard` / `cardAvailability`). A **marketing
snapshot** keeps only allow-listed fields (no cost, margin, supplier, stock
count, sales, investor or customer field exists in the type) with a hash; a
document binds to the snapshot id. Before approval or a final export the Worker
re-reads the product and compares (`compareSnapshots`); a change to what the
design shows blocks the final export until reviewed. Arrivals and back-in-stock
are detected from the studio's own availability snapshots (the first sync is a
baseline and announces nothing).

## 6. Decisions this needs from the owner (DECISIONS row 270, 🟡)

| Point | Row 262 says | The brief says | Built |
|---|---|---|---|
| Where the key lives | Worker secret `ANTHROPIC_API_KEY` | entered in protected settings, encrypted | both: the Worker secret works today; typing a key needs the new secret `CREATIVE_STUDIO_ENC_KEY` |
| Prices from a model | never | never | bindings only |
| Sorani copy | never machine-written | Arabic-first | Claude writes ar/en copy; a ckb ad's words are typed by a person |
| Model ids | in D1 only | choose the available model | live list → D1 |

## 7. Performance (spec §31)

The studio is one lazy route; Konva, the studio strings and the studio fonts
load only there (`tests/bundleBudget.test.ts` keeps them out of the public
first paint). IBM Plex Sans Arabic (400/600/700, ≈ 74 KB each, OFL) is
self-hosted under `public/fonts/ibm-plex-sans-arabic/` and loaded with the
`FontFace` API when the editor opens; Cairo is the site's own font.

## 8. Advanced production engines (spec §38–46)

A capability registry lists `generate_image`, `edit_image_region`,
`remove_background`, `image_to_3d`, `render_scene`, `recognize_text`,
`review_design`. Only `review_design` (Claude vision, owner-enabled) is
connected; every other capability shows «غير متصل» with what it needs (a
licensed engine or a GPU service) and no button pretends otherwise. The order
and the candidate engines (TRELLIS.2, rembg, PaddleOCR, Blender…) are in the
progress file; none is installed or claimed as tested.
