# LEVO Studio

Copyright © 2026 LEVONIS. LEVO Studio, its brand identity, product copy, and original project code are owned by LEVONIS and licensed as described in [LICENSE](LICENSE). Third-party components retain their original licenses; see [OPEN_SOURCE_NOTICES.md](OPEN_SOURCE_NOTICES.md) and [COPYRIGHT.md](COPYRIGHT.md).

LEVO Studio is an Arabic-first, mobile-first browser workspace for preparing and slicing models with Bambu Lab X2D and H2D profiles. The editor, model parser, Orca-derived settings, WebAssembly slicer, G-code generation, and toolpath preview run locally in the browser through `three-slicer` 0.2.2. This application does not upload models or generated G-code to an application server.

## Editor workspace

- Import STL, OBJ, 3MF, AMF, PLY, STEP/STP, IGES/IGS, BREP, GLB/GLTF, FBX, DAE, 3DS, VRML/WRL, OFF, USDZ, KMZ, VTK/VTP, or MD2 files by picker or drag-and-drop.
- Open a ZIP archive locally, stream its entries, identify supported models, and shelf-pack the imported objects across as many as nine plates.
- Work without an application-defined file-size, batch-size, or project-count cap. Files never upload to the LEVO application server; practical capacity is still bounded by browser/device memory.
- Select, move, rotate, scale, duplicate, delete, split disconnected components, and place objects on the bed.
- Use multiple plates, switch the active plate, delete plates, and slice the current plate or every plate.
- Use undo/redo, copy/paste/cut, box selection, zoom-all, zoom-bed, object visibility, and per-object extruder selection.
- Paint support enforcers/blockers and manage filaments from the complete desktop sidebar.
- Save a `.3mf` project, export STL, preview real G-code by layer and feature, and download per-plate or combined output.
- Download the selected plate's actual `.gcode` or share it with the device share sheet after a successful slice.
- Work from the full desktop interface or a five-action phone bar with an expandable, touch-sized editing tray.

The quick setup sheet uses the Orca profile and process presets shipped by the engine:

- `Bambu Lab X2D 0.4 nozzle` (GM045), clamped to the published 256 × 256 × 260 mm primary-nozzle volume.
- `Bambu Lab H2D 0.4 nozzle` (GM033), using its bundled 350 × 320 × 325 mm profile.
- Real 0.12, 0.20, and 0.24 mm process presets, plus strength and automatic-support overrides.

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm ci
npm run dev
```

Verification:

```bash
npm run lint
npx tsc --noEmit
npm test
```

## Print and export workflow

After a successful slice, the Print & Export sheet downloads the selected plate's actual G-code, shares it through the operating system when Web Share files are supported, saves the editable 3MF project, or exports all sliced plates. The connection center exposes three explicit methods:

1. **Same Wi-Fi / IP** — available only in the signed LEVO iOS/Android app through the native `LevoPrinter` bridge. The hosted website cannot open the printer's raw MQTT/FTPS sockets.
2. **Cloud** — export the 3MF project, upload it privately to MakerWorld, and make the final printer/AMS confirmation in Bambu Handy.
3. **USB** — download the sliced plate, copy it to FAT32/exFAT removable storage, and select it on the X2D screen. Raw G-code remains labeled as such until a printer-ready `.gcode.3mf` passes real-hardware validation.

See Bambu Lab's official [Bambu Connect guide](https://wiki.bambulab.com/en/software/bambu-connect) and [third-party integration notice](https://wiki.bambulab.com/en/software/third-party-integration).

## Honest compatibility boundary

The current web engine does not implement Bambu Studio's Auto Arrange, Auto Orient, Cut, Boolean, modifier/negative parts, seam painting, complete color/MMU painting, text/SVG emboss, Measure, or variable layer-height tools. Their native toolbar entries stay disabled and LEVO reports the limitation instead of simulating success.

LEVO supports real G-code export and explicit Bambu handoffs, but direct browser-to-printer/cloud networking remains disabled. Handy-style cloud printing requires Bambu Lab partner authorization. Android 1.2.1 also contains an opt-in LAN Only/Developer Mode bridge: it pins the printer's MQTT/FTPS certificates, authenticates with the local access code, reports live status, checks staged G-code by size and SHA-256, and requires a final file/printer confirmation before issuing the raw-G-code start command. Bambu `.gcode.3mf` packaging remains disabled and the LAN path is explicitly hardware-unverified until it passes the documented X2D/H2D matrix. LEVO never converts an unverified transport attempt into a connected/printing success state. See [SLICER_CAPABILITIES.md](SLICER_CAPABILITIES.md) and [BAMBU_PRINT_PIPELINE.md](BAMBU_PRINT_PIPELINE.md).

## Shared mobile application

`mobile/` is a Capacitor 8 project for iOS 15+ and Android 7+. It bundles the same `app/slicer-client.tsx` used by the hosted site, rather than framing or redirecting to the website. The native bridge is registered on both platforms and already provides capability negotiation, private-address validation, ordered chunk staging, SHA-256 verification, cancellation, and cleanup. Printer credentials are reserved for native Keychain/Keystore storage and never enter Web Storage.

```bash
cd mobile
npm ci
npm run sync
```

Building/signing an iOS binary still requires Xcode and an Apple signing team. Android's Developer Mode raw-G-code transport is implemented but remains marked experimental until it is validated against the target X2D/H2D firmware matrix; `.gcode.3mf` packaging stays gated.

The Android build workflow produces an installable `LEVO-Studio-Android-v1.0.0.apk` for direct testing. Google Play production distribution must use a private LEVONIS release key stored outside the public repository.

## License

GNU Affero General Public License v3.0 or later. The slicing integration is based on the AGPL-licensed `three-slicer`/OrcaSlicer line. See [LICENSE](LICENSE) and [OPEN_SOURCE_NOTICES.md](OPEN_SOURCE_NOTICES.md).
