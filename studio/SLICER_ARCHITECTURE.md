# Slicer architecture

## Runtime flow

1. `app/slicer-client.tsx` registers the extended loaders, then dynamically imports the editor and settings UI on the client. The page shell can render without touching WebGL or WebAssembly.
2. The full `three-slicer` viewport owns geometry, selection, transforms, plates, undo history, painting, and preview state. LEVO listens to typed viewport events for object, plate, mode, progress, layer, notice, and error updates.
3. A single custom picker/drop pipeline rejects empty input, accepts the full model allowlist, signature-sniffs common extensionless files, and dispatches normalized files to the native loader. It applies no app-defined byte/count cap.
4. `app/archive-import.ts` reads ZIP input incrementally with `fflate`; supported entries are normalized and naturally sorted. After import, `app/plate-packing.ts` measures new scene objects and shelf-packs them across the selected printer's bed dimensions, creating up to nine plates and warning about overflow/oversize.
5. `app/model-loaders.ts` registers Three.js mesh/scene loaders plus local OpenCascade WASM tessellation for STEP, IGES, and BREP.
6. X2D/H2D machine, process, and filament data are loaded from the engine's bundled Orca presets. Machine keys are re-applied after any advanced settings update or project import so a project cannot silently replace the selected machine envelope.
7. Slicing starts from the native current/all-plate controls. The engine performs computation in its WebAssembly worker and reports real progress. Its own cancel action terminates the active work.
8. Toolpath preview parses generated G-code and exposes layer range, single-layer, travel, and feature/speed/height/width/fan/temperature/filament views.
9. Large G-code strings are stored outside React state in a per-workspace `Map`; only progress, counts, modes, and lightweight status reach the component tree.
10. Native project save serializes geometry, transforms, plate placement, painting, and settings into `.3mf`. Reloading the page still clears the in-memory workspace unless the user saved it.
11. After a successful slice, LEVO can materialize the selected G-code as a local file, download it, or pass it to the operating-system Web Share sheet. The Print & Export surface links to the official Bambu Connect handoff; no printer credential or network transport enters the browser application.

## UI composition

- Desktop uses the engine's complete top bar, gizmo rail, object toolbar, plate bar, object/filament/process sidebar, slice controls, and preview controls.
- Mobile hides the cramped native top rails and exposes five fixed primary actions plus an expandable touch-sized tool grid. Buttons dispatch to native controls by stable `data-testid` rather than maintaining a second geometry model.
- Shadow-root CSS changes layout and applies the same opaque charcoal surface system to engine-owned panels. It does not replace engine action handlers.
- Arabic/RTL applies to the LEVO shell; the technical editor canvas and transform coordinate system remain LTR.

## Trust boundaries

- `three-slicer`: model parsing, geometry editing, project serialization, Orca settings, WASM slicing, and G-code/toolpath rendering.
- `app/slicer-client.tsx`: product shell, profile locking, import orchestration, mobile command adapters, status, and capability disclosure.
- `worker/index.ts`: static delivery and response security headers. It does not receive models, projects, or G-code.
- Browser memory: project and generated outputs for the current page lifetime.

## Intentional boundaries

General Auto Arrange, Auto Orient, Cut, mesh Boolean, part modifiers, seam painting, full Bambu color/MMU painting, text/SVG emboss, Measure, variable layers, background persistence, printer discovery, AMS mapping, `.gcode.3mf` packaging, and direct Bambu cloud/network print are not implemented. ZIP-specific multi-plate packing is implemented. The connection sheet states Bambu's partner-authorization gate explicitly; real G-code export/share and the Bambu Connect/Studio handoff remain available.
