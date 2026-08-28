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
