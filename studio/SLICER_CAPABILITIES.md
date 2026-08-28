# Capability matrix

Statuses describe the checked-in browser implementation and automated verification. They do not imply a physical-printer test.

| Capability | Status | Evidence / boundary |
|---|---|---|
| Mesh import | Implemented | STL, OBJ, 3MF, AMF, PLY, GLB/GLTF, FBX, DAE, 3DS, VRML/WRL, OFF, USDZ, KMZ, VTK/VTP, and MD2 use native or registered Three.js loaders. Unknown/extensionless common formats are signature-sniffed. |
| CAD import | Implemented | STEP/STP, IGES/IGS, and BREP/BRP are tessellated locally with `occt-import-js`/OpenCascade WebAssembly. |
| ZIP model import | Implemented | ZIP entries are decompressed incrementally, filtered/sniffed, naturally sorted, and the resulting objects are shelf-packed across up to nine plates. |
| Import sizing | Local/device-bounded | LEVO applies no fixed byte, batch, or project-count cap and uploads nothing to an application server. Browser/device memory and CPU are the practical limit. |
| Selection and object list | Implemented | Click and box selection, object visibility, select-all, and per-object extruder controls. |
| Move, rotate, scale | Implemented | Native Three.js transform gizmos plus keyboard nudging/rotation. |
| Delete, delete-all, duplicate | Implemented | Native toolbar, context-menu, keyboard, and mobile actions. |
| Split and place on bed | Implemented | Splits disconnected components into objects and re-seats objects at Z=0. Part-level splitting is not available. |
| Zoom all / zoom bed | Implemented | Native `Z`/`B` camera actions surfaced on the mobile rail and context menu. |
| Undo/redo and clipboard | Implemented | Native undo/redo plus copy, paste, cut, and duplicate shortcuts. |
| Multi-plate editing | Implemented | Add, select, and remove plates; slice current or all plates; project supports up to the engine's nine-plate limit. |
| 3MF project save | Implemented | Serializes geometry, transforms, plate layout, settings, and supported paint data for later reopening. |
| STL export | Implemented | Native selected/project geometry export. |
| Bambu 0.4 mm profiles | Profile-integrated | Bundled Orca machine/material/process presets are selectable for X2D, H2D, H2C, H2S, H2D Pro, P2S, P1S, P1P, X1C, X1, X1E, A1, A1 mini, and A2L. Machine identity and printable volume remain locked. Physical verification is outstanding. |
| Quality, strength, support | Implemented | Real bundled 0.12/0.20/0.24 mm process presets with explicit strength/support overrides. |
| Advanced process/motion/filament settings | Implemented | Schema-driven native settings panels use the same active settings object as slicing. Machine identity and limits stay locked. |
| Support painting | Implemented | Native enforcer/blocker brushes, erase/clear tools, and radius control. |
| Full Bambu color/MMU painting | Partial | Basic filament/material mechanisms exist, but the complete Bambu facet codec and workflow are not wired; the unsupported top-level tool remains disabled. |
| Browser slicing | Implemented | Real WebAssembly slicer in an ES-module worker with progress and cancellation. |
| Bed overflow guard | Implemented | Out-of-volume model or generated path raises an error and prevents a ready/safe result state. |
| Toolpath preview | Implemented | Real G-code rendering with layer range, single-layer, travel toggle, and multiple view legends. |
| Raw G-code export and share | Implemented | Selected-plate and combined local downloads; mobile/desktop Web Share file handoff when supported; no application-server upload. |
| Bambu Connect / Studio handoff | Implemented | Print & Export explains the explicit official desktop handoff and links the Bambu Connect guide. Printer, plate, nozzle, and AMS confirmation remain in Bambu software. |
| Phone-only Bambu Handy handoff | Implemented | Exports the current Bambu/Orca-compatible 3MF project to the phone, then guides a private MakerWorld upload and final confirmation inside Bambu Handy. It does not impersonate an official cloud client or claim the printer started early. |
| Shared web/mobile UI | Implemented | The hosted Site and the Capacitor iOS/Android bundle import the same `SlicerClient`, editor modules, styles, profiles, and model loaders. |
| Native application shells | Implemented | Capacitor 8.5.0 iOS 15+ and Android API 24+ projects are generated and the local application bundle builds successfully. Platform signing is external to this repository. |
| Native printer bridge contract | Implemented, gated | Capability negotiation, private-LAN validation, ordered 192 KiB chunks, SHA-256 verification, idempotency, cancellation, and staging cleanup are wired. The interface never stores credentials in browser storage. |
| ZIP multi-plate arrange | Implemented | Imported ZIP objects are size-sorted and packed across the active printer's bed dimensions. Oversized objects and the nine-plate ceiling produce explicit warnings. |
| General Auto Arrange / Auto Orient | Missing | Visible as disabled native controls; requires the corresponding libslic3r ports. |
| Cut / Boolean / modifier parts | Missing | Visible as disabled native controls; the web engine lacks the geometry/part implementation. |
| Seam paint / Text / Measure / variable layers | Missing | Visible as disabled native controls and described in the platform-status sheet. |
| Background persistence | Implemented | Debounced project snapshots, active profile/settings, plate/object counts, rename/delete, project list, and reopen/resume are stored locally in IndexedDB. Saves resolve only after their transaction commits. |
| Printer discovery and status | Android implemented, hardware-unverified | Android scans private local subnets for MQTT/TLS, requires the serial and LAN access code, pins MQTT/FTPS certificates, and surfaces live reports. Browser and iOS report unavailable; no state is fabricated. |
| AMS mapping and status | Disabled | No fabricated trays, colors, or material availability. |
| Bambu `.gcode.3mf` packaging | Native adapter pending | The bridge accepts the project and G-code as independently checksummed assets, but packaging capability stays `false` until a golden X2D-accepted package and negative fixtures pass. |
| Direct Bambu LAN app print | Android experimental raw-G-code route | Android exposes raw G-code separately from package printing, requires live idle status, verified FTPS, SHA-256/size validation, a final target/profile/plate/checksum confirmation, and a matching MQTT result (or observed live state transition). It is not certified until real X2D/H2D firmware tests pass. |
| Direct Bambu cloud/browser print | Officially gated | Bambu's authorization system requires approved integration documentation and credentials for cloud initiation. LEVO exposes the real blocked state and never fabricates a connection or asks for a Bambu account password. |

“Implemented” means the action exists in source and is covered by type, lint, build, rendered-shell, and engine-control contract checks where applicable. “Profile-integrated” means the bundled Orca profile is used and locked; it is not a claim of hardware certification.
