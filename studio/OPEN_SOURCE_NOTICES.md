# Open-source notices

LEVO Web Slicer is distributed under the GNU Affero General Public License v3.0 or later. The complete license text is in `LICENSE`.

## Slicing stack

### three-slicer 0.2.2

- Source: https://github.com/kimgh06/Web_Three_Slicer
- Package: https://www.npmjs.com/package/three-slicer
- License: GNU AGPL-3.0-or-later
- Role: browser model viewer, Orca-derived WASM slicing worker, settings schema, G-code parsing, and toolpath rendering.

### OrcaSlicer

- Source: https://github.com/SoftFever/OrcaSlicer
- License: GNU AGPL-3.0
- Role: upstream slicer lineage and the reference Bambu X2D/H2D machine, process, and filament profiles used to pin LEVO defaults.

This project does not copy code from the surveyed Bambu MCP repositories. They were used only to understand the integration boundary around `.gcode.3mf`, FTPS/MQTT transport, AMS mapping, and printer-state validation.

### BambuStudio

- Source: https://github.com/bambulab/BambuStudio
- License: GNU AGPL-3.0
- Role: `app/auto-orient.ts` is a TypeScript port of `src/libslic3r/Orient.cpp`
  and `src/libslic3r/Orient.hpp` — the candidate-direction search, the cost
  terms (overhang, bottom, bottom-hull, contour, low-angle faces) and the
  `OrientParamsArea` constants. LEVO Web Slicer is AGPL-3.0-or-later, so the
  port is a derivative work under the same licence.
- `app/plane-cut.ts` follows the SHAPE of upstream's `cut_mesh`
  (`src/libslic3r/TriangleMeshSlicer.cpp`) — split every facet against the
  plane, chain the intersection segments into loops, triangulate, and give each
  half the cap wound to face out of it — but is NOT a port of it: upstream's is
  fused to libslic3r's scaled-integer slicer, ExPolygons and 2D triangulation
  library. The geometry there is written for this codebase and stated as such
  in its own header.
- What was NOT taken: no C++ was vendored, no build artefact, no profile data,
  and no printer-integration code. The auto-orient port is a re-implementation
  of the documented algorithm in this repository's own language and coordinate
  frame (three.js is Y-up; BambuStudio is Z-up), with the differences stated in
  the file's own header.

### occt-import-js 0.0.23

- Source: https://github.com/kovacsv/occt-import-js
- License: GNU LGPL-2.1
- Role: local STEP, IGES, and BREP tessellation through OpenCascade WebAssembly. The package license is installed with `occt-import-js` and is also linked above.

### fflate 0.7.4

- Source: https://github.com/101arrowz/fflate
- License: MIT
- Role: incremental, local ZIP archive decompression.

## Application dependencies

The application also uses React, Next.js, Vinext, Vite, Three.js, Cloudflare Workers tooling, and their transitive dependencies under their respective licenses. Their package metadata and license files remain available in the dependency distribution produced by `npm ci`.

LEVONIS owns LEVO Studio's original integration code and product identity. Names and notices belonging to third-party libraries are retained here because they cannot legally be reassigned.

## Source availability

Because this application includes and modifies an AGPL-covered network application stack, users interacting with a deployed version must be offered the corresponding source. The UI’s About sheet links to https://github.com/aliamer229/Levo_slicer.
