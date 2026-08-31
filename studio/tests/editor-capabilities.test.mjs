import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const appUrl = new URL("../app/slicer-client.tsx", import.meta.url);
const cssUrl = new URL("../app/globals.css", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);
const archiveUrl = new URL("../app/archive-import.ts", import.meta.url);
const loadersUrl = new URL("../app/model-loaders.ts", import.meta.url);
const packingUrl = new URL("../app/plate-packing.ts", import.meta.url);
const adapterUrl = new URL("../app/engine-adapter.ts", import.meta.url);
// Fleet-refactor module map (the former monolith is now composed from owned
// modules — these tests follow the behavior to its owning file):
const headerUrl = new URL("../app/components/header.tsx", import.meta.url);
const printSheetUrl = new URL("../app/components/sheets/print.tsx", import.meta.url);
const connectSheetUrl = new URL("../app/components/sheets/connect.tsx", import.meta.url);
const aboutSheetUrl = new URL("../app/components/sheets/about.tsx", import.meta.url);
const i18nEnUrl = new URL("../app/i18n/en.ts", import.meta.url);
const profilesUrl = new URL("../app/printer-profiles.ts", import.meta.url);
const orchestratorUrl = new URL("../app/import-orchestrator.ts", import.meta.url);
const slicingStateUrl = new URL("../app/hooks/use-slicing-state.ts", import.meta.url);
const syncUrl = new URL("../app/project-sync.ts", import.meta.url);
const prepareUrl = new URL("../app/makerworld/prepare.tsx", import.meta.url);
const fflateEsmUrl = new URL("../node_modules/fflate/esm/index.mjs", import.meta.url);
const bridgeUrl = new URL("../app/native-printer-bridge.ts", import.meta.url);
const mobilePackageUrl = new URL("../mobile/package.json", import.meta.url);
const mobileMainUrl = new URL("../mobile/src/main.tsx", import.meta.url);
const iosPluginUrl = new URL("../mobile/ios/App/App/AppDelegate.swift", import.meta.url);
const iosPlistUrl = new URL("../mobile/ios/App/App/Info.plist", import.meta.url);
const androidPluginUrl = new URL("../mobile/android/app/src/main/java/iq/levo/studio/LevoPrinterPlugin.java", import.meta.url);
const androidUpdaterUrl = new URL("../mobile/android/app/src/main/java/iq/levo/studio/LevoUpdaterPlugin.java", import.meta.url);
const androidActivityUrl = new URL("../mobile/android/app/src/main/java/iq/levo/studio/MainActivity.java", import.meta.url);
const androidManifestUrl = new URL("../mobile/android/app/src/main/AndroidManifest.xml", import.meta.url);
const androidStringsUrl = new URL("../mobile/android/app/src/main/res/values/strings.xml", import.meta.url);
const androidBuildUrl = new URL("../mobile/android/app/build.gradle", import.meta.url);
const androidWorkflowUrl = new URL("../.github/workflows/android-apk.yml", import.meta.url);
const apkUrl = new URL("../public/downloads/LEVO-Studio-Android-v1.1.0.apk", import.meta.url);
const apkChecksumUrl = new URL("../public/downloads/LEVO-Studio-Android-v1.1.0.apk.sha256", import.meta.url);

function extractContractArray(source, constName) {
  const match = source.match(new RegExp(`export const ${constName} = \\[([^\\]]+)\\] as const`));
  assert.ok(match, `engine-adapter contract list ${constName} is missing`);
  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
  assert.ok(values.length > 0, `engine-adapter contract list ${constName} is empty`);
  return values;
}

test("engine adapter contract: every testid and __vpApi member exists in the installed engine", async () => {
  const [adapter, engine] = await Promise.all([
    readFile(adapterUrl, "utf8"),
    readFile(engineUrl, "utf8"),
  ]);

  const staticIds = extractContractArray(adapter, "ENGINE_STATIC_TEST_IDS");
  const actionIds = extractContractArray(adapter, "ENGINE_ACTION_TEST_IDS");
  const apiMethods = extractContractArray(adapter, "ENGINE_API_METHODS");

  for (const testId of staticIds) {
    assert.ok(engine.includes(`data-testid": "${testId}`), `engine control ${testId} is missing from the installed build`);
  }

  // Toolbar actions render through the engine's `tool-${action.id}` template.
  assert.ok(engine.includes('data-testid": `tool-${'), "engine tool-* testid template is missing");
  for (const testId of actionIds) {
    const actionId = testId.replace(/^tool-/, "");
    assert.ok(engine.includes(`id: "${actionId}"`), `engine toolbar action ${actionId} is missing`);
  }

  // Plate tabs render through the engine's `plate-${index}` template.
  assert.ok(engine.includes('data-testid": `plate-${'), "engine plate-* testid template is missing");

  for (const method of apiMethods) {
    assert.match(engine, new RegExp(`${method}: \\(`), `engine __vpApi.${method} is missing from the installed build`);
  }

  // The adapter finds the engine host and dispatches shortcuts via .app-shell.
  assert.ok(engine.includes("app-shell"), "engine .app-shell marker is missing");

  // Every testid hardcoded in the adapter must be covered by the contract
  // lists (the lists are what this test verifies against the engine).
  const declared = new Set([...staticIds, ...actionIds]);
  for (const hit of adapter.matchAll(/data-testid="([a-z][a-z0-9-]*)"/g)) {
    assert.ok(declared.has(hit[1]), `adapter uses testid ${hit[1]} outside the contract lists`);
  }
  for (const hit of adapter.matchAll(/(?:clickControl|queryControl|isControlAvailable|runPrepareAction)\("([a-z][a-z0-9-]*)"\)/g)) {
    assert.ok(declared.has(hit[1]), `adapter clicks testid ${hit[1]} outside the contract lists`);
  }

  // Shadow-root discovery and theme injection are event-driven — the 500 ms
  // polling interval must not come back.
  assert.doesNotMatch(adapter, /setInterval/);

  // Window hooks the adapter reaches for that are not part of __vpApi. The
  // release hook is added by patches/three-slicer+0.2.2.patch — if the patch
  // ever stops being applied, this is where it is caught, not on a phone weeks
  // later. See patches/README.md.
  const windowHooks = extractContractArray(adapter, "ENGINE_WINDOW_HOOKS");
  for (const hook of windowHooks) {
    assert.ok(engine.includes(hook), `engine window hook ${hook} is missing from the installed build`);
  }
  assert.ok(windowHooks.includes("__vpReleaseWorker"), "the worker-release hook left the contract");
});

test("mobile and desktop controls target real editor actions", async () => {
  const [app, engine] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(engineUrl, "utf8"),
  ]);

  for (const id of ["add", "delete", "delete-all", "duplicate", "split", "onbed"]) {
    assert.ok(engine.includes(`id: "${id}"`), `engine action ${id} is missing`);
  }
  for (const testId of [
    "stl-input",
    "gizmo-move",
    "gizmo-rotate",
    "gizmo-scale",
    "gizmo-paint",
    "plate-add",
    "plate-del",
    "slice-current",
    "slice-all",
    "gcode-dl",
    "save-project",
    "undo",
    "redo",
    "layer-range",
  ]) {
    assert.ok(engine.includes(`data-testid\": \"${testId}`), `engine control ${testId} is missing`);
  }

  for (const testId of [
    "tool-delete",
    "tool-delete-all",
    "tool-duplicate",
    "tool-split",
    "tool-onbed",
    "gizmo-move",
    "gizmo-rotate",
    "gizmo-scale",
    "gizmo-paint",
    "plate-add",
    "save-project",
  ]) {
    assert.ok(app.includes(`\"${testId}\"`), `LEVO control ${testId} is not wired`);
  }
});

test("upload, export, sharing, and official print handoff are real actions", async () => {
  const [app, header, adapter, printSheet, prepare, en, slicingState] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(headerUrl, "utf8"),
    readFile(adapterUrl, "utf8"),
    readFile(printSheetUrl, "utf8"),
    readFile(prepareUrl, "utf8"),
    readFile(i18nEnUrl, "utf8"),
    readFile(slicingStateUrl, "utf8"),
  ]);

  // Engine file injection lives behind the S4 typed adapter now.
  assert.match(adapter, /dispatchEvent\(new Event\("change"/);
  assert.match(adapter, /Object\.defineProperty\(engineInput, "files"/);
  assert.match(adapter, /typeof DataTransfer !== "function"/);
  // The native file input moved into the owned header component.
  assert.match(header, /className="native-file-input"/);
  assert.match(header, /data-supported-formats=\{FILE_PICKER_ACCEPT\}/);
  assert.doesNotMatch(header, /accept=\{FILE_PICKER_ACCEPT\}/);
  assert.doesNotMatch(app, /accept=\{FILE_PICKER_ACCEPT\}/);

  // The download/share/print File now comes from the slicing hook, which keeps
  // the G-code as a Blob rather than a multi-megabyte JS string per plate (see
  // the MEMORY note in use-slicing-state.ts). The shell asks for a named File;
  // the hook is the only place that builds one.
  assert.match(app, /slicing\.freshGcodeFile\(selectedPlate, name\)/);
  assert.match(slicingState, /new File\(\[stored\.gcode\], fileName, \{ type: GCODE_MIME \}\)/);
  assert.match(slicingState, /new Blob\(\[payload\.gcode\], \{ type: GCODE_MIME \}\)/);
  assert.match(slicingState, /gcode: Blob;/);
  // A stale result is still never exportable: the fresh accessor is what the
  // export paths use, and it returns null unless the result matches the scene.
  assert.match(slicingState, /if \(!stored \|\| !isFresh\(stored\)\) return null;/);
  assert.match(app, /downloadBlob\(file, file\.name\)/);
  assert.match(app, /const data: ShareData = \{ files: \[file\], title: file\.name \}/);
  assert.match(app, /await navigator\.share\(data\)/);
  assert.match(app, /triggerSlice\(true\)/);
  assert.match(app, /onExport=\{handleViewportExport\}/);
  assert.match(app, /LEVO-\$\{profile\.shortName\}-Bambu-Handy\.3mf/);

  // Official-path honesty moved into the print sheet + reviewed dictionaries.
  assert.match(printSheet, /https:\/\/wiki\.bambulab\.com\/en\/software\/bambu-connect/);
  assert.match(printSheet, /https:\/\/makerworld\.com\/en\/upload/);
  assert.match(en, /Bambu Connect or Bambu Studio/);
  assert.match(en, /undocumented private API/);
  assert.match(prepare, /Private Model/);
  assert.match(en, /Printer, AMS and heater confirmation happens in Bambu Handy/);
});

test("extended model loaders, streaming ZIP import, and no fixed app cap are wired", async () => {
  const [app, archive, loaders] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(archiveUrl, "utf8"),
    readFile(loadersUrl, "utf8"),
  ]);

  for (const extension of ["step", "stp", "iges", "igs", "brep", "glb", "gltf", "fbx", "dae", "3ds", "wrl", "vrml", "off", "usdz", "kmz", "vtk", "vtp", "md2"]) {
    assert.ok(loaders.includes(`"${extension}"`), `loader extension ${extension} is missing`);
  }
  assert.match(loaders, /registerLoader\(/);
  assert.match(loaders, /occt-import-js\.wasm/);
  assert.match(archive, /new Unzip\(/);
  assert.match(archive, /file\.stream\(\)\.getReader\(\)/);
  assert.match(archive, /UnzipPassThrough/);
  // The old "no fixed cap" marketing claim is gone: ZIPs are untrusted input,
  // so extraction now runs under an explicit decompression budget with a real
  // user confirmation before continuing past the soft limit (mandate §10/T7).
  const orchestrator = await readFile(orchestratorUrl, "utf8");
  assert.match(archive, /class ArchiveLimitError/);
  assert.match(archive, /onBudgetExceeded/);
  assert.match(archive, /"entry-count" \| "expansion-budget" \| "expansion-ratio"/);
  assert.match(orchestrator, /onBudgetExceeded: callbacks\.onBudgetExceeded/);
  assert.doesNotMatch(app, /LEVO sets no fixed file-size or count cap/);
  assert.doesNotMatch(app, /80 \* 1024 \* 1024|160 \* 1024 \* 1024|files\.length > 12/);
});

test("ZIP packing distributes models deterministically across plates", async () => {
  const source = await readFile(packingUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const packingModule = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  const result = packingModule.packModelsAcrossPlates([
    { id: 1, width: 180, depth: 180 },
    { id: 2, width: 180, depth: 180 },
    { id: 3, width: 40, depth: 40 },
  ], 256, 256, 0, 9);
  assert.equal(result.placements.length, 3);
  assert.equal(result.platesUsed, 2);
  assert.equal(result.overflowCount, 0);
  assert.deepEqual(new Set(result.placements.map((placement) => placement.plate)), new Set([0, 1]));
});

test("mobile visual system uses solid surfaces and expandable controls", async () => {
  const [app, css] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(cssUrl, "utf8"),
  ]);

  assert.match(app, /className="mobile-tooltray"/);
  assert.match(app, /className="mobile-toolgrid"/);
  assert.match(app, /className="mobile-primarybar"/);
  assert.match(css, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(max-width: 350px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /(?:linear|radial|conic)-gradient\(/i);
  assert.doesNotMatch(css, /backdrop-filter/i);
});

test("verified profiles and explicit capability boundaries stay present", async () => {
  const [profiles, engine, en] = await Promise.all([
    readFile(profilesUrl, "utf8"),
    readFile(engineUrl, "utf8"),
    readFile(i18nEnUrl, "utf8"),
  ]);

  // Printer/preset data moved out of the monolith into printer-profiles.ts.
  for (const preset of [
    "Bambu Lab X2D 0.4 nozzle",
    "Bambu Lab H2D 0.4 nozzle",
    "Bambu Lab A2L 0.4 nozzle",
    "0.12mm High Quality @BBL X2D",
    "0.20mm Standard @BBL H2D",
  ]) {
    assert.ok(profiles.includes(preset), `profile preset ${preset} is missing`);
  }

  for (const id of ["arrange", "orient", "cut", "boolean", "text", "measure", "varlayer"]) {
    assert.ok(engine.includes(`id: "${id}"`), `boundary tool ${id} is missing`);
  }
  assert.match(engine, /Auto arrange[^\n]+Not implemented/);
  // The cloud-printing boundary statement lives in the reviewed dictionaries.
  assert.match(en, /direct Bambu cloud printing requires official partner authorization that does not exist/);
});

test("web, iOS, and Android share one capability-gated printer connection surface", async () => {
  const [app, bridge, mobilePackageText, mobileMain, iosPlugin, iosPlist, androidPlugin, androidActivity] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(bridgeUrl, "utf8"),
    readFile(mobilePackageUrl, "utf8"),
    readFile(mobileMainUrl, "utf8"),
    readFile(iosPluginUrl, "utf8"),
    readFile(iosPlistUrl, "utf8"),
    readFile(androidPluginUrl, "utf8"),
    readFile(androidActivityUrl, "utf8"),
  ]);
  const mobilePackage = JSON.parse(mobilePackageText);
  const [connectSheet, en] = await Promise.all([
    readFile(connectSheetUrl, "utf8"),
    readFile(i18nEnUrl, "utf8"),
  ]);

  // The connection surface moved into the owned connect sheet.
  assert.match(connectSheet, /\["lan", "cloud", "usb"\]/);
  // APK download links are DISABLED in the web UI (mandate §12): no active
  // download URL anywhere, an explicitly disabled "coming soon" card instead.
  assert.doesNotMatch(app, /LEVO-Studio-Android[^\n]*\.apk/);
  assert.doesNotMatch(connectSheet, /LEVO-Studio-Android[^\n]*\.apk|releases\/latest\/download/);
  assert.match(connectSheet, /className="full-app-soon-card" aria-disabled="true"/);
  assert.match(connectSheet, /t\.fullAppSoon/);
  assert.match(en, /© 2026 LEVONIS/);
  assert.match(app, /nativeEnvironment\.capabilities\.lanConnection/);
  assert.match(app, /required\.packagePrintJob/);
  assert.match(app, /required\.rawGcodePrintJob/);
  assert.match(app, /required\.fileTransfer/);
  assert.match(app, /required\.startPrint/);
  assert.match(app, /printerStatus\.connected/);
  assert.match(app, /sendNativePrintJob/);
  assert.match(bridge, /const CHUNK_BYTES = 192 \* 1024/);
  assert.match(bridge, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(bridge, /idempotencyKey = crypto\.randomUUID\(\)/);
  assert.doesNotMatch(bridge, /localStorage|sessionStorage|indexedDB/i);

  assert.equal(mobilePackage.dependencies["@capacitor/core"], "8.5.0");
  assert.equal(mobilePackage.dependencies["@capacitor/ios"], "8.5.0");
  assert.equal(mobilePackage.dependencies["@capacitor/android"], "8.5.0");
  assert.match(mobileMain, /import SlicerClient from "\.\.\/\.\.\/app\/slicer-client"/);
  assert.match(iosPlugin, /registerPluginType\(LevoPrinterPlugin\.self\)/);
  assert.match(iosPlugin, /"bridgeVersion": "0\.1\.0"/);
  assert.match(iosPlist, /NSLocalNetworkUsageDescription/);
  assert.match(androidPlugin, /@CapacitorPlugin\(name = "LevoPrinter"\)/);
  assert.match(androidActivity, /registerPlugin\(LevoPrinterPlugin\.class\)/);

  assert.match(iosPlugin, /"lanConnection"[^\n]+false/);
  assert.match(androidPlugin, /"lanConnection"[^\n]+true/);
  assert.match(androidPlugin, /requiresTrust/);
  assert.match(androidPlugin, /certificateFingerprint/);
  assert.match(iosPlugin, /"startPrint"[^\n]+false/);
  assert.match(androidPlugin, /"startPrint"[^\n]+true/);
  assert.match(androidPlugin, /"rawGcodePrintJob"[^\n]+true/);
  assert.match(androidPlugin, /"packagePrintJob"[^\n]+false/);
  assert.match(androidPlugin, /LevoMqttClient/);
  assert.match(androidPlugin, /LevoFtpsClient/);
  assert.match(androidPlugin, /"command", "gcode_file"/);
});

test("local printer addresses are restricted to private LAN ranges", async () => {
  const source = await readFile(bridgeUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const bridge = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

  for (const address of ["10.0.0.2", "172.16.1.5", "172.31.255.254", "192.168.50.20", "x2d.local"]) {
    assert.equal(bridge.isPrivatePrinterAddress(address), true, `${address} should be accepted`);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "127.0.0.1", "example.com", "192.168.1.999"]) {
    assert.equal(bridge.isPrivatePrinterAddress(address), false, `${address} should be rejected`);
  }
});

test("Android updates are in-place, origin-locked, and checksum-verified", async () => {
  const [app, bridge, updater, activity, manifest] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(bridgeUrl, "utf8"),
    readFile(androidUpdaterUrl, "utf8"),
    readFile(androidActivityUrl, "utf8"),
    readFile(androidManifestUrl, "utf8"),
  ]);

  // The WEB UI no longer wires the native update check (mandate §12: APK and
  // its auto-update are disabled in this phase; mobile/ sources stay as
  // reference and keep their origin-lock + checksum discipline below).
  assert.doesNotMatch(app, /checkForNativeUpdate|installNativeUpdate/);
  const aboutSheet = await readFile(aboutSheetUrl, "utf8");
  assert.match(aboutSheet, /legal-details/);
  assert.match(bridge, /LevoUpdater/);
  assert.match(activity, /registerPlugin\(LevoUpdaterPlugin\.class\)/);
  assert.match(manifest, /REQUEST_INSTALL_PACKAGES/);
  assert.match(updater, /https:\/\/github\.com\/aliamer229\/Levo_slicer\/releases\/latest\/download\/levo-studio-android\.json/);
  assert.match(updater, /release-assets\.githubusercontent\.com/);
  assert.match(updater, /Untrusted update origin/);
  assert.match(updater, /SHA-256/);
  assert.match(updater, /7a1e2f090ca588687070bf90334812e38c7431ba9f6118473f2b1925e81321e1/);
  assert.match(updater, /GET_SIGNING_CERTIFICATES/);
  assert.match(updater, /Update certificate mismatch/);
  assert.match(updater, /FileProvider\.getUriForFile/);
  assert.doesNotMatch(updater, /setInstanceFollowRedirects\(true\)/);
});

test("Android production releases require the permanent LEVONIS signer", async () => {
  const [build, workflow] = await Promise.all([
    readFile(androidBuildUrl, "utf8"),
    readFile(androidWorkflowUrl, "utf8"),
  ]);

  for (const variable of ["LEVO_KEYSTORE_PATH", "LEVO_KEYSTORE_PASSWORD", "LEVO_KEY_ALIAS", "LEVO_KEY_PASSWORD"]) {
    assert.match(build, new RegExp(variable));
  }
  for (const secret of ["LEVO_KEYSTORE_BASE64", "LEVO_KEYSTORE_PASSWORD", "LEVO_KEY_ALIAS", "LEVO_KEY_PASSWORD"]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.match(workflow, /:app:assembleRelease/);
  assert.match(workflow, /7a1e2f090ca588687070bf90334812e38c7431ba9f6118473f2b1925e81321e1/);
  assert.match(workflow, /Verified using v2 scheme/);
  assert.match(workflow, /Verified using v3 scheme/);
  assert.match(workflow, /gh release create/);
});

test("downloadable Android APK is branded and checksum-verified", async (context) => {
  try {
    await Promise.all([access(apkUrl), access(apkChecksumUrl)]);
  } catch {
    context.skip("The signed distribution artifact is attached only to production/site releases.");
    return;
  }
  const [apk, checksumFile, manifest, strings] = await Promise.all([
    readFile(apkUrl),
    readFile(apkChecksumUrl, "utf8"),
    readFile(androidManifestUrl, "utf8"),
    readFile(androidStringsUrl, "utf8"),
  ]);
  const expected = checksumFile.trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(apk).digest("hex");

  assert.deepEqual([...apk.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(actual, expected);
  assert.ok(apk.byteLength > 5_000_000);
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(strings, /<string name="app_name">LEVO Studio<\/string>/);
  assert.match(strings, /2026 LEVONIS/);
});

// ---------------------------------------------------------------------------
// Archive decompression limits (behavioral — T7: malicious/huge ZIPs fail
// clearly instead of exhausting the tab).
// ---------------------------------------------------------------------------

async function loadArchiveModule() {
  const source = await readFile(archiveUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText
    .replace(/import \{([^}]+)\} from "fflate";/, `import {$1} from "${fflateEsmUrl.href}";`)
    .replace(/import \{[^}]+\} from "\.\/model-loaders";/, 'const MODEL_EXTENSIONS = ["stl", "obj", "3mf"];');
  assert.doesNotMatch(javascript, /from "\.\/model-loaders"|from "fflate"/);
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

function makeZip(entries, zipSync) {
  const zipped = zipSync(entries);
  return new File([zipped], "test.zip", { type: "application/zip" });
}

test("archive extraction skips unsafe entry paths and flattens safe ones", async () => {
  const archive = await loadArchiveModule();
  const { zipSync } = await import("fflate");

  assert.equal(archive.isUnsafeArchivePath("../evil.stl"), true);
  assert.equal(archive.isUnsafeArchivePath("a/../../evil.stl"), true);
  assert.equal(archive.isUnsafeArchivePath("/abs.stl"), true);
  assert.equal(archive.isUnsafeArchivePath("C:\\windows\\evil.stl"), true);
  assert.equal(archive.isUnsafeArchivePath("models/part.stl"), false);

  const stl = new TextEncoder().encode("solid demo\nendsolid demo\n");
  const mixed = makeZip({ "../evil.stl": stl, "models/part.stl": stl }, zipSync);
  const extracted = await archive.extractModelArchive(mixed);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].name, "models__part.stl");

  const onlyUnsafe = makeZip({ "../only-evil.stl": stl }, zipSync);
  await assert.rejects(archive.extractModelArchive(onlyUnsafe), /unsafe paths/);
});

test("archive extraction enforces the declared entry-count limit", async () => {
  const archive = await loadArchiveModule();
  const { zipSync } = await import("fflate");
  const stl = new TextEncoder().encode("solid demo\nendsolid demo\n");
  const zip = makeZip({ "a.stl": stl, "b.stl": stl, "c.stl": stl }, zipSync);
  await assert.rejects(
    archive.extractModelArchive(zip, undefined, { limits: { maxEntries: 2 } }),
    (error) => error instanceof Error && error.name === "ArchiveLimitError" && error.code === "entry-count",
  );
});

test("archive expansion beyond the soft budget requires explicit confirmation", async () => {
  const archive = await loadArchiveModule();
  const { zipSync } = await import("fflate");
  const big = new Uint8Array(4 * 1024 * 1024); // zeros: compresses tiny, expands big
  const zip = makeZip({ "big.stl": big }, zipSync);
  const limits = {
    confirmExpandedBytes: 1024 * 1024,
    maxTotalExpandedBytes: 64 * 1024 * 1024,
    maxExpansionRatio: 1_000_000,
    expansionRatioFloorBytes: Number.MAX_SAFE_INTEGER,
  };

  // No confirmation callback: the declared budget is final.
  await assert.rejects(
    archive.extractModelArchive(zip, undefined, { limits }),
    (error) => error instanceof Error && error.name === "ArchiveLimitError" && error.code === "expansion-budget",
  );

  // Declined confirmation: clear failure, no silent continuation.
  await assert.rejects(
    archive.extractModelArchive(zip, undefined, { limits, onBudgetExceeded: () => false }),
    (error) => error instanceof Error && error.name === "ArchiveLimitError" && error.code === "expansion-budget",
  );

  // Confirmed once: extraction completes within the hard ceiling.
  let prompts = 0;
  const extracted = await archive.extractModelArchive(zip, undefined, {
    limits,
    onBudgetExceeded: (info) => {
      prompts += 1;
      assert.ok(info.expandedBytes > info.budgetBytes);
      return true;
    },
  });
  assert.equal(prompts, 1);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].size, big.byteLength);
});

test("archive expansion never exceeds the hard ceiling, even when confirmed", async () => {
  const archive = await loadArchiveModule();
  const { zipSync } = await import("fflate");
  const big = new Uint8Array(8 * 1024 * 1024);
  const zip = makeZip({ "bomb.stl": big }, zipSync);
  await assert.rejects(
    archive.extractModelArchive(zip, undefined, {
      limits: {
        confirmExpandedBytes: 1024 * 1024,
        maxTotalExpandedBytes: 2 * 1024 * 1024,
        maxExpansionRatio: 1_000_000,
        expansionRatioFloorBytes: Number.MAX_SAFE_INTEGER,
      },
      onBudgetExceeded: () => true,
    }),
    (error) => error instanceof Error && error.name === "ArchiveLimitError"
      && error.code === "expansion-budget" && /hard/.test(error.message),
  );
});

test("archive extraction refuses zip-bomb expansion ratios", async () => {
  const archive = await loadArchiveModule();
  const { zipSync } = await import("fflate");
  const big = new Uint8Array(4 * 1024 * 1024);
  const zip = makeZip({ "bomb.stl": big }, zipSync);
  await assert.rejects(
    archive.extractModelArchive(zip, undefined, {
      limits: {
        confirmExpandedBytes: 1024 * 1024 * 1024,
        maxTotalExpandedBytes: 1024 * 1024 * 1024,
        maxExpansionRatio: 4,
        expansionRatioFloorBytes: 64 * 1024,
      },
    }),
    (error) => error instanceof Error && error.name === "ArchiveLimitError" && error.code === "expansion-ratio",
  );
});

test("the editor shell does not pay for the WASM kernel before it slices", async () => {
  const [app, engine] = await Promise.all([readFile(appUrl, "utf8"), readFile(engineUrl, "utf8")]);

  // The engine warms the kernel on mount unless features.warmup is false —
  // and on an isolated page that kernel reserves 4 GiB of shared memory and
  // spawns one worker per core. The shell must decide per device.
  assert.match(engine, /postMessage\(\{ cmd: "warmup"/);
  assert.match(app, /features=\{device\.memoryConstrained \? EDITOR_FEATURES_COLD : EDITOR_FEATURES_WARM\}/);
  assert.match(app, /const EDITOR_FEATURES_COLD = \{ warmup: false, logs: false \}/);
  assert.match(app, /const EDITOR_FEATURES_WARM = \{ warmup: true, logs: false \}/);
  // The literal that used to sit inline in the JSX must not come back: it
  // handed the engine a new object on every one of the shell's renders.
  assert.doesNotMatch(app, /features=\{\{/);
  assert.doesNotMatch(app, /defaultExtruderColors=\{\[/);
  assert.match(app, /defaultExtruderColors=\{EXTRUDER_COLORS\}/);
  assert.match(app, /onSliced=\{handleEngineSliced\}/);

  // Nothing is disabled to achieve this: the same kernel loads on the first
  // slice. Only the timing changes.
  assert.doesNotMatch(app, /features=\{\{ *warmup: false/);
});

test("newly spawned objects are seated in free space, and restores are left alone", async () => {
  const [app, adapter] = await Promise.all([readFile(appUrl, "utf8"), readFile(adapterUrl, "utf8")]);

  // Driven by the engine's own objects event, so it covers the toolbar button,
  // the engine's context menu, Ctrl+K, paste and a canvas drop alike.
  assert.match(app, /seatNewObjectsIfNeeded\(ids\)/);
  assert.match(adapter, /export function seatNewObjects\(/);
  assert.match(adapter, /api\.placeObjectOnPlate\(seat\.id, seat\.plate, seat\.offsetX, seat\.offsetY\)/);

  // A split keeps its parts where they were — it removes an id as well as
  // adding some, and that is how the shell tells the two apart.
  assert.match(app, /for \(const id of previous\) if \(!next\.has\(id\)\) return;/);
  // An archive import arranges itself; a project restore carries exact
  // positions. Neither may be re-seated.
  assert.match(app, /orchestrator\.busy \|\| orchestrator\.hasPendingArrangement \|\| suppressSeatingRef\.current/);
  assert.match(app, /suppressSeating\(\);/);
  // Objects that fit nowhere are reported, never squeezed onto a full plate.
  assert.match(app, /result\.ok && result\.unseatedCount/);
  assert.match(adapter, /unseatedCount: plan\.unseated\.length/);
});

test("the expensive autosave capture is gated on a cheap change signal", async () => {
  const [app, sync] = await Promise.all([readFile(appUrl, "utf8"), readFile(syncUrl, "utf8")]);

  assert.match(app, /contentSignature: \(\) => projectContentSignature\(\)/);
  assert.match(app, /debounceMs: device\.autosaveDebounceMs/);
  // The signature must cover everything the 3MF depends on.
  assert.match(app, /adapter\.sceneFingerprint\(\)/);
  assert.match(app, /`plates=\$\{plateCount\}`/);
  assert.match(app, /`\$\{profileId\}:\$\{quality\}:\$\{strength\}:\$\{support\}`/);

  // And the controller must check it BEFORE capturing, not after — a hash of
  // the produced file can only ever skip the upload.
  const signatureIndex = sync.indexOf("signature === this.lastSavedSignature");
  const captureIndex = sync.indexOf("await callbacks.captureSnapshot()");
  assert.ok(signatureIndex > 0 && captureIndex > 0);
  assert.ok(signatureIndex < captureIndex, "the change check must run before the capture");

  // The engine's render loop is stopped for the duration of the export — the
  // engine exposes suspendRendering for exactly this and says so.
  assert.match(app, /adapter\.suspendRendering\(true\)/);
  assert.match(app, /if \(rendering\) adapter\.suspendRendering\(false\)/);
});
