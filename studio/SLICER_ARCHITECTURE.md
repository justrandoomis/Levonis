# LEVO Studio architecture

> Updated for the LEVO Studio integration phase (docs/STUDIO_PLAN.md). The
> previous revision of this file described the pre-integration snapshot — a
> single client monolith with a static-delivery worker and no accounts — and
> is superseded by this document. Where a capability is not finished, it is
> named as unfinished here, not implied.

## Two applications, one monorepo

LEVO Studio is a fully separate workspace (`studio/`) inside the Levonis
monorepo: its own lockfile, its own Cloudflare worker (`levonis-studio` /
`levonis-studio-staging` in `studio/wrangler.jsonc`), its own D1 database and
private R2 bucket, and its own deploy workflows
(`.github/workflows/deploy-studio-*.yml`). The store worker, database, and
bundle are never shared — the store links here with a plain `<a>` navigation
and loads zero slicer code (enforced by `tests/store-isolation.test.ts` at the
repo root, plus network-trace evidence for T1).

## Worker request pipeline (`worker/index.ts`)

Order matters; every step happens before vinext sees the request:

1. **Header hygiene** — all inbound `oai-*` (forgeable legacy-hosting
   identity) and `x-levo-*` (reserved internal) headers are stripped.
2. **`/auth/*`** (`worker/auth/callback.ts` + `worker/auth/session.ts`) —
   same-origin sign-in via the single-use server-to-server code exchange with
   the main site; host-scoped HttpOnly session cookie; logout; `/auth/me`.
   Details: `docs/STUDIO_AUTH.md`.
3. **`/api/*`** (`worker/api/router.ts` → `projects.ts` / `uploads.ts` /
   `quota.ts` / `cleanup.ts`) — account project storage over the Studio's own
   D1 + R2 with per-request ownership checks. Details:
   `docs/STUDIO_STORAGE.md`.
4. **`/_vinext/image`** — image optimization via the `IMAGES` binding.
5. **vinext SSR/assets** — document navigations carry the validated identity
   to the app through the internal `x-levo-user` header (trustworthy only
   because step 1 stripped inbound copies; consumed by `app/studio-auth.ts`).
6. **Security-header wrap** on every response: CSP, COOP `same-origin`,
   COEP `require-corp`, CORP `same-origin`. HTML is never cached
   (`Cache-Control: private, no-store`), so header changes cannot be dodged
   by a cached page. `crossOriginIsolated` is what lets the engine pick its
   threaded WASM core and do real Atomics-based cancellation; the deploy
   workflows curl-check these headers after every staging deploy (T15's CI
   half).

## Client module layout (`app/`)

The former `slicer-client.tsx` monolith is being decomposed; the shell still
exists but delegates to owned modules:

| Module | Role |
|---|---|
| `engine-adapter.ts` | The ONLY place that touches the three-slicer engine internals: shadow-root discovery (event-driven, no polling loop), theme CSS injection, `data-testid` dispatch, hidden file-input injection, every `window.__vpApi` call. Typed contract; `tests/editor-capabilities.test.mjs` verifies each test id against the installed engine build. |
| `printer-profiles.ts`, `profile-loader.ts` | Printer/process preset resolution with an explicit warning when a preset is missing — no silent fallback presented as "verified". |
| `import-orchestrator.ts`, `archive-import.ts`, `model-loaders.ts` | Picker/drop normalization, ZIP extraction under declared decompression budgets (user confirmation past the limit), lazy per-format loaders, lazy OCCT WASM for STEP/IGES/BREP. |
| `plate-packing.ts` | Pure-geometry arrangement planning: shelf packing across up to 9 plates (`PLATE_CAP` — the engine's real limit, never shown as "unlimited"), rectangular bed, locked objects never moved, overflow reported instead of silently scaling. |
| `hooks/use-slicing-state.ts` | Slice lifecycle: progress, cancellation, and stale-result invalidation when the scene changes after a slice. |
| `project-store.ts` | IndexedDB drafts ONLY — crash recovery, namespaced per user (`user:<id>` / `guest` / `legacy`), never shown as "synced". |
| `project-sync.ts`, `hooks/use-project-persistence.ts` | Account sync client: OPEN → UPLOAD → COMMIT against the storage API, the five visible sync states, 409 conflict surfacing, cancellation on logout/account switch. |
| `components/` (`header.tsx`, `projects-panel.tsx`, `sheets/*`) | Decomposed shell UI (S6): header, My-Projects panel, setup/print/connect/about sheets. |
| `i18n/` (`ar.ts`, `en.ts`, `ckb.ts`) | Extracted dictionaries — Arabic default, English, Sorani (ckb). RTL for ar/ckb in the shell; the editor canvas and coordinate system stay LTR by design. |
| `editor-theme.ts` | LEVONIS theme injected into engine shadow roots via the adapter. |
| `makerworld/` (`preflight.ts`, `prepare.tsx`), `export-manager.ts` | The primary output flow (S7): preflight → real 3MF via the engine save path (structurally verified) → transfer summary → open the official MakerWorld upload page. Honest wording only — "file ready" / "open MakerWorld", never "uploaded"; no sanctioned third-party upload API exists. G-code download is a secondary action. |
| `studio-auth.ts` | Server-side identity reader (`x-levo-user`); replaces the deleted `chatgpt-auth.ts`. Guest = header absent. |
| `native-printer-bridge.ts` | Dormant on the web: without Capacitor every capability reports `false`. No printer credentials or raw sockets in the browser. |

## Trust boundaries

- **`three-slicer` (engine, AGPL)** — parsing, geometry editing, project
  serialization (3MF), Orca settings, WASM slicing in its worker, G-code and
  toolpath preview. Unchanged and pinned (0.2.2); all shell access goes
  through `engine-adapter.ts`.
- **Browser memory / IndexedDB** — the live workspace and local drafts. Large
  G-code stays outside React state.
- **Studio worker** — security headers, sessions, and (new) the account
  project store: when a signed-in user saves to their account, project files
  upload to the Studio's PRIVATE R2 bucket through the worker, which checks
  ownership in D1 on every read and write. This supersedes the old
  "the worker never receives models" line: guest editing is still fully
  local, but account saving is an explicit upload to LEVONIS-controlled
  storage (`docs/STUDIO_PRIVACY.md`).
- **Main-site worker** — identity only, via the single-use code exchange and
  the server-to-server liveness check. The Studio never sees store data
  (no email/phone/wallet/KYC), and its database has no users table.

## Intentional boundaries (honest, current)

- Surface color/MMU painting, seam painting, Cut, mesh Boolean, part
  modifiers, text/SVG emboss, Measure, and variable layer height are NOT
  implemented; native toolbar entries stay disabled and the UI reports the
  limitation. Per-object extruder assignment exists; how far it reaches into
  sliced G-code is verified by S7's tests, and remaining MMU limits are
  disclosed in the UI.
- `.gcode.3mf` printer packaging stays gated until real-hardware fixtures
  pass (`BAMBU_PRINT_PIPELINE.md`); a MakerWorld-accepted Print Profile is
  declared unavailable (MakerWorld rejects non-Bambu-Studio profiles).
- No direct browser-to-printer or cloud printing; no APK download in the web
  UI ("the full LEVONIS app — coming soon", no link). `mobile/` and the APK
  workflows under `studio/.github/` are kept as dormant reference only —
  moving those YMLs to the repo root would re-activate signed APK publishing
  and is expressly forbidden (risk register #9).
- No analytics, no service worker, no third-party requests from the app
  (`connect-src 'self'`).
