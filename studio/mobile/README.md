# LEVO Studio mobile

> **Status (LEVONIS Studio phase): APK distribution is DISABLED.**
>
> - The hosted web app at `studio.levonis-iq.com` no longer links or serves any
>   APK, and its in-app update-check UI has been removed; the UI shows an
>   explicit "تطبيق LEVONIS الكامل — قريبًا" disabled state with no download
>   link (owner mandate §12).
> - This `mobile/` tree (Capacitor sources, the `LevoPrinter`/`LevoUpdater`
>   plugins, signing docs) is kept **as reference only**. Do not develop or
>   publish a new standalone slicer APK in this phase.
> - The workflows under `studio/.github/workflows/` (`android-apk.yml`,
>   `publish-levo-v1.1.0.yml`) are inert where they sit — GitHub only executes
>   workflows from the repository-root `.github/workflows/`. Do NOT move them
>   to the root and do NOT push `studio/` as a standalone repository: either
>   would re-enable signed automatic APK releases on push.
> - The future mobile app is planned to cover the FULL LEVONIS platform
>   (store, account, community, and Studio), not a standalone slicer, and its
>   implementation is a separate later task.
> - Historical sources, signatures, and releases are intentionally left
>   untouched (no deletions without owner approval).

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
