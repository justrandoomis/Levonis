/**
 * Who pays for the WASM kernel at page load, and who does not.
 *
 * WHY THIS EXISTS. The owner photographed "Worker terminated (likely out of
 * memory): worker error" on a project with NOTHING loaded. Nothing was loaded
 * because loading a model was never what cost the memory — opening the page
 * was. The viewer warms the kernel on mount, and on a cross-origin-isolated
 * page that kernel is `slicer_core.mt.js`, which (verbatim from the installed
 * build, asserted below) reserves a 4 GiB shared WebAssembly.Memory and spawns
 * one extra Worker per logical core, compiling the 5 MB module into each.
 *
 * `classifyDevice` is the whole mechanism for withholding that. A plausible
 * "simplification" of any rule below silently hands phones the eager kernel
 * again, and the only symptom is the owner reporting the same crash later.
 * Every user agent here is a real one and each is here for a reason.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../app/device-profile.ts", import.meta.url);
const mtCoreUrl = new URL("../node_modules/three-slicer/engine/src/slicer_core.mt.js", import.meta.url);
const viewportUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);

const source = await readFile(sourceUrl, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { classifyDevice } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

/** A desktop: mouse, plenty of RAM, big screen. Nothing to withhold. */
const DESKTOP = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  deviceMemoryGb: 8,
  hardwareConcurrency: 16,
  coarsePointerOnly: false,
  screenShortSideCss: 1080,
};

const signals = (patch) => ({ ...DESKTOP, ...patch });

test("the cost this module exists to avoid is really in the installed engine", async () => {
  const [mtCore, viewport] = await Promise.all([
    readFile(mtCoreUrl, "utf8"),
    readFile(viewportUrl, "utf8"),
  ]);
  // A 4 GiB shared reservation…
  assert.match(mtCore, /maximum:65536,shared:true/);
  // …plus one Worker per core, each loading the module before the kernel is ready.
  assert.match(mtCore, /pthreadPoolSize=typeof navigator!=="undefined"&&navigator\.hardwareConcurrency\|\|4/);
  assert.match(mtCore, /while\(pthreadPoolSize--\)\{?PThread\.allocateUnusedWorker\(\)/);
  assert.match(mtCore, /PThread\.loadWasmModuleToAllWorkers\(\)/);
  // …asked for at MOUNT, gated on nothing but features.warmup.
  assert.match(viewport, /postMessage\(\{ cmd: "warmup"/);
});

test("phones and iPads never load the kernel before they slice", () => {
  const constrained = {
    "iPad, mobile-mode Safari":
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    // iPadOS 13+ defaults to "Request Desktop Website" and then says Macintosh
    // with no iPad in it anywhere. Matching only /iPad/ misses the real device.
    "iPad, desktop-mode Safari (claims Macintosh)":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "iPhone Safari":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Chrome on iOS (WebKit underneath)":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
    "Android phone, Chrome":
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    "Android phone, Samsung Internet":
      "Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
    "Firefox on Android phone":
      "Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0",
  };
  for (const [label, userAgent] of Object.entries(constrained)) {
    const profile = classifyDevice(signals({ userAgent }));
    assert.equal(profile.memoryConstrained, true, `${label} must not warm the kernel at mount`);
    assert.ok(profile.reasons.length > 0, `${label} must record why`);
    assert.equal(typeof profile.idleWorkerReleaseMs, "number", `${label} must release its idle worker`);
  }
});

test("desktops keep the warm kernel — this never becomes a blanket slowdown", () => {
  const unconstrained = {
    "Windows Chrome": DESKTOP.userAgent,
    "macOS Chrome (Blink, not WebKit)":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "macOS Firefox (Gecko, not WebKit)":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Linux Chrome":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Windows Edge":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    // An Android TABLET: no `Mobile` token. Tablets keep the warm kernel.
    "Android tablet, Chrome":
      "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
  for (const [label, userAgent] of Object.entries(unconstrained)) {
    const profile = classifyDevice(signals({ userAgent }));
    assert.equal(profile.memoryConstrained, false, `${label} must keep the warm kernel`);
    assert.deepEqual(profile.reasons, [], label);
    assert.equal(profile.idleWorkerReleaseMs, null, `${label} must keep its worker between slices`);
  }
});

test("a real Mac on Safari is accepted collateral, and the cost is one deferred load", () => {
  // Indistinguishable from a desktop-mode iPad from a user agent alone. It
  // costs a Mac the kernel load before its first slice; guessing the other way
  // costs an iPad the session.
  const profile = classifyDevice(signals({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  }));
  assert.equal(profile.memoryConstrained, true);
  assert.deepEqual(profile.reasons, ["apple-webkit"]);
});

test("a low-RAM machine is constrained whatever it claims to be", () => {
  const profile = classifyDevice(signals({ deviceMemoryGb: 4 }));
  assert.equal(profile.memoryConstrained, true);
  assert.deepEqual(profile.reasons, ["low-device-memory"]);
  // 8 GiB is not low. The threshold must not creep up into desktops.
  assert.equal(classifyDevice(signals({ deviceMemoryGb: 8 })).memoryConstrained, false);
});

test("a touchscreen alone does not constrain a desktop", () => {
  // A 27-inch touch monitor reports a coarse pointer. Size is what separates
  // it from a phone, which is why the two conditions are ANDed.
  assert.equal(
    classifyDevice(signals({ coarsePointerOnly: true, screenShortSideCss: 1440 })).memoryConstrained,
    false
  );
  assert.equal(
    classifyDevice(signals({ coarsePointerOnly: true, screenShortSideCss: 390 })).memoryConstrained,
    true
  );
  // A small window on a machine WITH a mouse is a small window, not a phone.
  assert.equal(
    classifyDevice(signals({ coarsePointerOnly: false, screenShortSideCss: 390 })).memoryConstrained,
    false
  );
});

test("unknown signals never crash and never invent a constraint", () => {
  const profile = classifyDevice({
    userAgent: "",
    deviceMemoryGb: null,
    hardwareConcurrency: null,
    coarsePointerOnly: false,
    screenShortSideCss: null,
  });
  assert.equal(profile.memoryConstrained, false);
  assert.deepEqual(profile.reasons, []);
});

test("a constrained device saves less often, and a desktop's cadence is unchanged", () => {
  const phone = classifyDevice(signals({
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  }));
  const desktop = classifyDevice(signals({}));
  // 2500 ms is what the sync controller has always used; it must not change
  // for the machines it was right for.
  assert.equal(desktop.autosaveDebounceMs, 2_500);
  assert.ok(phone.autosaveDebounceMs > desktop.autosaveDebounceMs);
});
