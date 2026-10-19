# Slicer security

## Local-data model

Guest editing is local: files are passed directly to the browser editor and slicer, and output remains in memory until saved/downloaded, intentionally shared through the device's operating-system share sheet, or the page is closed. Crash-recovery drafts stay in the browser's IndexedDB, namespaced per account (a draft is never shown to another account; sign-out can remove the account's drafts from the device).

*Corrected 2026-10-19 (P1-09): this section used to say nothing is ever uploaded.* When a person is **signed in** and saves to their account, the project snapshot (3MF), source files and thumbnail ARE uploaded — to private, per-account storage (Cloudflare R2) behind the Studio worker: server-generated object keys, sha256 and size verified on upload, an ownership check in D1 before every read, no public or signed URLs, `Cache-Control: private, no-store` on every response (`worker/api/*`, `docs/STUDIO_STORAGE.md`). Guest work moves into an account only on the explicit «احفظ عملك في حسابي». Generated G-code is never uploaded. There are no analytics, third-party scripts or printer credentials.

## Input and resource controls

- Format allowlist: STL, OBJ, 3MF, AMF, PLY, STEP/STP, IGES/IGS, BREP/BRP, GLB/GLTF, FBX, DAE, 3DS, VRML/WRL, OFF, USDZ, KMZ, VTK/VTP, MD2, and ZIP containers holding those model types.
- Empty files are rejected.
- Byte and count caps (*corrected 2026-10-19: this line used to say there are none*): the editor refuses a model over 500 MB at selection (`MODEL_FILE_BYTES_CEILING`, `app/import-orchestrator.ts`); ZIP input is read incrementally under declared decompression limits — 512 entries, a 256 MiB soft budget that needs the person's confirmation, a 1 GiB hard ceiling and a 200× expansion-ratio stop (`DEFAULT_ARCHIVE_LIMITS`, `app/archive-import.ts`); an account save is held to 64 MiB per file, 4 MiB per thumbnail, 64 files per revision and 1 GiB per account (`worker/api/quota.ts`). Within those limits, extracted geometry must still fit browser/device memory.
- The same normalization and ZIP-analysis pipeline runs for both the custom file picker and drag-and-drop.
- A project change clears previously generated G-code so stale output is not presented as current.
- The selected printer's machine keys are re-applied after settings changes/import to prevent silent profile or build-volume replacement.
- Engine errors remain errors; an out-of-bed model/toolpath cannot enter LEVO's ready state.

Account storage has the quota above; local editing does not touch it. Parsing and slicing untrusted input still occur in the application's same-origin browser/Worker/WebAssembly contexts, so removing an application cap cannot remove the physical CPU, memory, storage, and browser limits of the user's device.

## Browser policy

Every application response receives:

- a same-origin Content Security Policy; `wasm-unsafe-eval` is required by WebAssembly, `unsafe-eval` is currently required by OpenCascade's generated Emscripten/Embind bindings for CAD import, `blob:` is required for workers/downloads, and current Vinext hydration still requires inline allowances;
- `frame-ancestors 'none'` and `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- a strict-origin referrer policy;
- a permissions policy disabling camera, microphone, geolocation, payment, and USB.

Moving CAD parsing into an isolated worker/build that avoids Emscripten's dynamic binding generation, and replacing `unsafe-inline` with nonce-aware Vinext hydration, are the main CSP hardening items. No third-party script origin is permitted.

## Studio worker request hardening (P1-10)

- **The main site's session cookie never reaches Studio code (owner decision Q8).** `levonis_session` stays on `Domain=.levonis-iq.com` (one Levonis identity across storefronts), so browsers also send it to `studio.levonis-iq.com`. The first thing the Studio worker does with any request is `sanitizeRequestHeaders` (`worker/auth/session.ts`), which drops every inbound `oai-*` and `x-levo-*` header and **every cookie the Studio does not own** — an allow-list on the `levo_studio_` prefix, so a cookie the parent domain adds later is isolated too. Auth routes, the storage API, the SSR render and the Studio's own logging only ever see the sanitized request. Studio identity is unaffected: it is the host-only `levo_studio_session`, minted by the single-use handoff (`docs/STUDIO_AUTH.md`). Tested end to end in `tests/auth-handoff.test.mjs` (Q8): a full sign-in with both cookies present, and a recording database proving the main-site token is never bound into a Studio query.
- **Cross-origin writes are refused.** Every non-GET/HEAD `/api` call goes through `isCrossOriginWrite`, the same rule as `POST /auth/logout`: an `Origin` that is not the Studio's own (including `"null"`) is a 403 `CROSS_ORIGIN_REFUSED`; without an `Origin`, a `Sec-Fetch-Site` of `cross-site` or `same-site` is refused. This is what stops a community-store subdomain, which is same-site with the Studio and therefore carries the Lax cookie. The refusal happens before any session lookup or database work (`tests/api-hardening.test.mjs`).
- **Rate limit.** Signed-in account calls are charged against a D1 fixed window (`worker/api/ratelimit.ts`, table `studio_rate_limits`) with the main site's key derivation (`<bucket>:u:<userId>`, tested side by side with `worker/lib/ratelimit.ts`), separate read and write buckets, and a 429 with `Retry-After` past the budget. Defaults (60 s window, 1200 reads, 600 writes per account) and their env overrides are in `docs/STUDIO_STORAGE.md`.

### Recorded trade-offs (deliberate, not defects)

- **Session liveness fails open** (GAP-MAP conflict 55; `isStudioSessionStillAuthorized`). When the main site cannot answer the liveness check — handoff unconfigured, unreachable, a 5xx, a malformed body — an existing Studio session stays usable until the main site answers again or its 14 days run out. It reaches only that account's Studio projects, never the main site (its cookie is stripped), and it cannot mint anything new: a new sign-in needs a live main-site session at the handoff. A definite `inactive` revokes every Studio session of that user within a minute (the verdict is cached per isolate for 60 s); a Studio sign-out is immediate. Failing closed would sign every Studio user out whenever the main site had a bad minute.
- **The handoff code appears in the invocation log** (GAP-MAP conflict 59). Workers Logs is enabled (`wrangler.jsonc`) and records the `/auth/callback?code=…` request URL; the Worker cannot edit that record, and no Studio code logs the code itself. The risk is low because the code is dead before any log is read: single-use and consumed atomically at redemption, valid for 60 seconds, bound to the destination origin, and redeemable only server-to-server with the shared secret. No long-lived secret reaches a log: the Studio session token appears only in a `Set-Cookie` response header and the main-site cookie is stripped. Moving the code into a POST auto-submit form would add an inline script or an extra click on a main-site page; that is the alternative if the requirement must be met literally.

## Printer credentials and output trust

The website does not request or store Bambu account passwords, printer access codes, cloud tokens, or certificates. The mobile UI may pass an X2D access code to the native `LevoPrinter` bridge only after an explicit local-connect action; it is never written to localStorage, sessionStorage, IndexedDB, logs, or the JavaScript bundle. A future remembered-printer implementation must use iOS Keychain or Android Keystore-backed encrypted storage. Before the bridge pins a printer's MQTT/FTPS certificates it asks the person to compare the fingerprints with the printer in front of them; that question, its cancel message and the connect form's validation errors are in the reader's language (ar/en/ckb, P1-10 — the question used to be English only), with the port numbers and fingerprints left as the printer shows them (`certificateTrustMessage`, `app/native-printer-bridge.ts`).

Raw `.gcode` is a real sliced export, but not a verified Bambu `.gcode.3mf` project. The native bridge therefore advertises packaging, printer upload, and start capabilities as disabled. Direct cloud initiation remains disabled until Bambu Lab grants partner authorization and official credentials; local Developer Mode transport must separately satisfy the security and physical-device tests in `BAMBU_PRINT_PIPELINE.md`.
