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

## Printer credentials and output trust

The website does not request or store Bambu account passwords, printer access codes, cloud tokens, or certificates. The mobile UI may pass an X2D access code to the native `LevoPrinter` bridge only after an explicit local-connect action; it is never written to localStorage, sessionStorage, IndexedDB, logs, or the JavaScript bundle. A future remembered-printer implementation must use iOS Keychain or Android Keystore-backed encrypted storage.

Raw `.gcode` is a real sliced export, but not a verified Bambu `.gcode.3mf` project. The native bridge therefore advertises packaging, printer upload, and start capabilities as disabled. Direct cloud initiation remains disabled until Bambu Lab grants partner authorization and official credentials; local Developer Mode transport must separately satisfy the security and physical-device tests in `BAMBU_PRINT_PIPELINE.md`.
