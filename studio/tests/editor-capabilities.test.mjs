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
  const app = await readFile(appUrl, "utf8");

  assert.match(app, /dispatchEvent\(new Event\("change"/);
  assert.match(app, /className="native-file-input"/);
  assert.match(app, /data-supported-formats=\{FILE_PICKER_ACCEPT\}/);
  assert.doesNotMatch(app, /accept=\{FILE_PICKER_ACCEPT\}/);
  assert.match(app, /Object\.defineProperty\(engineInput, "files"/);
  assert.match(app, /typeof DataTransfer !== "function"/);
  assert.match(app, /new File\(\[gcode\], name, \{ type: "text\/x-gcode" \}\)/);
  assert.match(app, /downloadBlob\(file, file\.name\)/);
  assert.match(app, /const data: ShareData = \{ files: \[file\], title: file\.name \}/);
  assert.match(app, /await navigator\.share\(data\)/);
  assert.match(app, /triggerSlice\(true\)/);
  assert.match(app, /https:\/\/wiki\.bambulab\.com\/en\/software\/bambu-connect/);
  assert.match(app, /Bambu Connect or Bambu Studio/);
  assert.match(app, /undocumented private API/);
  assert.match(app, /onExport=\{handleViewportExport\}/);
  assert.match(app, /LEVO-\$\{profile\.shortName\}-Bambu-Handy\.3mf/);
  assert.match(app, /https:\/\/makerworld\.com\/en\/upload/);
  assert.match(app, /Private Model/);
  assert.match(app, /Printer, AMS and heater confirmation happens in Bambu Handy/);
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
  assert.match(app, /LEVO sets no fixed file-size or count cap/);
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
  const [app, engine] = await Promise.all([
    readFile(appUrl, "utf8"),
    readFile(engineUrl, "utf8"),
  ]);

  for (const preset of [
    "Bambu Lab X2D 0.4 nozzle",
    "Bambu Lab H2D 0.4 nozzle",
    "Bambu Lab A2L 0.4 nozzle",
    "0.12mm High Quality @BBL X2D",
    "0.20mm Standard @BBL H2D",
  ]) {
    assert.ok(app.includes(preset), `profile preset ${preset} is missing`);
  }

  for (const id of ["arrange", "orient", "cut", "boolean", "text", "measure", "varlayer"]) {
    assert.ok(engine.includes(`id: "${id}"`), `boundary tool ${id} is missing`);
  }
  assert.match(engine, /Auto arrange[^\n]+Not implemented/);
  assert.match(app, /Direct cloud printing still requires official Bambu Lab partner authorization/);
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

  assert.match(app, /\["lan", "cloud", "usb"\]/);
  assert.match(app, /releases\/latest\/download\/LEVO-Studio-Android-v1\.2\.1\.apk/);
  assert.match(app, /© 2026 LEVONIS/);
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

  assert.match(app, /checkForNativeUpdate/);
  assert.match(app, /installNativeUpdate/);
  assert.match(app, /legal-details/);
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
