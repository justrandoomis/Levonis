# LEVO Studio mobile

This package builds the same `SlicerClient` used by the hosted site as a local Capacitor 8 application for iOS and Android. The app bundle contains the editor and slicer; it does not frame or redirect to the hosted website.

The `LevoPrinter` native plugin is the only boundary allowed to handle printer IP addresses, access codes, MQTT/FTPS sessions, printer-ready package creation, upload, and print acknowledgement. The shared web UI enables each action only when the installed native bridge reports that exact capability.

## Build

```bash
cd mobile
npm ci
npm run build
npx cap sync
```

iOS requires Xcode and an Apple signing team. Android requires Android Studio and Android SDK 24 or newer.

## Security rules

- Never persist an access code in Web Storage, IndexedDB, logs, crash reports, or the JavaScript bundle.
- Use iOS Keychain and Android Keystore-backed encrypted storage only after explicit user consent.
- Accept private IPv4 or `.local` printer addresses only.
- Pin each connection to the confirmed printer serial and model.
- Advertise raw G-code and `.gcode.3mf` as separate capabilities; never label one as the other.
- Keep `.gcode.3mf` disabled until a deterministic package passes the golden-fixture and hardware gates.
- Require an idle printer and an explicit final confirmation tied to the target, profile, plate, filename, and G-code checksum.
- Report success only after the printer acknowledges the same job identifier/checksum.
