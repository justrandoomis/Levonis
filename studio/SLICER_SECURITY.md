# Slicer security

## Local-data model

LEVO does not upload models, projects, or generated G-code to an application server. Files are passed directly to the browser editor and slicer; output remains in memory until saved/downloaded, intentionally shared through the device's operating-system share sheet, or the page is closed. There are no analytics, third-party scripts, cloud-model storage calls, printer credentials, or background synchronization endpoints.

## Input and resource controls

- Format allowlist: STL, OBJ, 3MF, AMF, PLY, STEP/STP, IGES/IGS, BREP/BRP, GLB/GLTF, FBX, DAE, 3DS, VRML/WRL, OFF, USDZ, KMZ, VTK/VTP, MD2, and ZIP containers holding those model types.
- Empty files are rejected.
- LEVO applies no fixed per-file, batch, or workspace byte/count cap. Import is local and ZIP input is read incrementally, but extracted geometry must still fit browser/device memory; users should expect very large or adversarial files to exhaust local resources.
- The same normalization and ZIP-analysis pipeline runs for both the custom file picker and drag-and-drop.
- A project change clears previously generated G-code so stale output is not presented as current.
- The selected printer's machine keys are re-applied after settings changes/import to prevent silent profile or build-volume replacement.
- Engine errors remain errors; an out-of-bed model/toolpath cannot enter LEVO's ready state.

No application-server storage or upload quota is involved. Parsing and slicing untrusted input still occur in the application's same-origin browser/Worker/WebAssembly contexts, so removing an application cap cannot remove the physical CPU, memory, storage, and browser limits of the user's device.

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
