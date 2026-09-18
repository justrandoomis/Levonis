/**
 * The engine patch is applied, and it is applied the way it must be.
 *
 * WHY THIS EXISTS. `npm ci` re-downloads node_modules, so an edit made there
 * by hand disappears on the next install and on every CI run. The only thing
 * standing between production and a silent regression is the postinstall hook
 * and this test. Without it, Studio would go back to holding a WASM heap and a
 * whole pthread pool on phones between slices, and the first sign would be the
 * owner reporting the same crash weeks later.
 *
 * See patches/README.md for why the shell cannot free the idle worker without
 * the patch.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageUrl = new URL("../package.json", import.meta.url);
const patchUrl = new URL("../patches/three-slicer+0.2.2.patch", import.meta.url);
const patchReadmeUrl = new URL("../patches/README.md", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);
const adapterUrl = new URL("../app/engine-adapter.ts", import.meta.url);
const appUrl = new URL("../app/slicer-client.tsx", import.meta.url);

test("the patch survives npm ci, and a failed patch fails the install", async () => {
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
  assert.equal(pkg.scripts.postinstall, "patch-package --error-on-fail");
  assert.ok(pkg.devDependencies["patch-package"], "patch-package must be a declared dependency");
  // --error-on-fail is the point: a patch that no longer applies (because the
  // engine was upgraded) must stop the build, not apply with fuzz or warn.
  assert.match(pkg.scripts.postinstall, /--error-on-fail/);
});

test("the patch file matches the installed engine version", async () => {
  const pkg = JSON.parse(await readFile(packageUrl, "utf8"));
  const patch = await readFile(patchUrl, "utf8");
  assert.equal(pkg.dependencies["three-slicer"], "0.2.2", "the patch file name pins this version");
  // Two hunks, in two files, for two different problems. Both are named here
  // so that a third arriving without its own review is visible.
  assert.match(patch, /viewer\/dist\/Viewport\.js/, "the idle-worker release hook and the stage-cache opt-out");
  assert.match(patch, /engine\/src\/slicer\.worker\.js/, "the pthread pool cap");
  assert.equal((patch.match(/^diff --git /gm) ?? []).length, 2, "an unreviewed third FILE");

  /**
   * EXACTLY TWO LINES OF ENGINE BEHAVIOUR ARE REPLACED IN THE WHOLE PATCH, and
   * each replacement keeps everything its original did. Every other line is an
   * addition. A patch that starts REMOVING engine behaviour needs a different
   * review than this test can stand in for, and it should fail here first.
   *
   * The count is asserted rather than the shape alone, because the cheapest
   * way to break an engine is to delete one of its lines while adding yours.
   */
  const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  assert.equal(removed.length, 2, "the patch must replace exactly two engine lines");
  const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));

  // 1. The worker-release hook rides on the line that publishes __vpWorker.
  const removedWorkerLine = removed.find((line) => line.includes("window.__vpWorker = k"));
  assert.ok(removedWorkerLine, "the worker-handle line should be the one replaced");
  const originalPrefix = removedWorkerLine.slice(1, removedWorkerLine.lastIndexOf("(window.__vpWorker = k"));
  assert.ok(originalPrefix.length > 100, "unexpected patch shape");
  const replacement = added.find((line) => line.includes("window.__vpReleaseWorker"));
  assert.ok(replacement, "the patch must add the release hook");
  assert.ok(replacement.includes(originalPrefix), "the replacement dropped part of the original line");
  assert.ok(replacement.includes("window.__vpWorker = k"), "the engine's own worker handle must survive");

  // 2. The stage-cache opt-out replaces the viewer's forced keep_stages.
  const removedStageLine = removed.find((line) => line.includes("keep_stages"));
  assert.ok(removedStageLine, "the forced keep_stages line should be the other one replaced");
  assert.match(removedStageLine, /k\.keep_stages = !0/, "the original forced it on unconditionally");
  const stageReplacement = added.find((line) => line.includes("__vpNoStageCache"));
  assert.ok(stageReplacement, "the patch must add the stage-cache opt-out");
  // Unset flag == the engine's original behaviour, byte for byte.
  assert.ok(
    stageReplacement.includes("k.economy || (k.keep_stages = !(typeof window < \"u\" && window.__vpNoStageCache)"),
    "with the flag unset, keep_stages must still be true"
  );
  // …and reuse_stages must go off WITH it: w.current still holds the mesh hash
  // after a run, so reusing stages that were released is the worse bug.
  assert.ok(
    stageReplacement.includes("k.reuse_stages = k.keep_stages && F && F === w.current ? 2 : 0"),
    "reuse_stages must be gated on keep_stages, not left on its own"
  );
});

test("a constrained device declines the stage cache, and only through the adapter", async () => {
  /**
   * THE HEAP THE SECOND SLICE LANDS ON.
   *
   * The engine's own parameter table calls `keep_stages` "a memory trade-off"
   * and defaults it to false; the viewer forces it true on every non-economy
   * slice. Releasing the idle worker does not help here — the loop this is
   * about (slice, look, edit, slice) has no idle window in it.
   */
  const [engine, adapter, app, profile] = await Promise.all([
    readFile(engineUrl, "utf8"),
    readFile(adapterUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(new URL("../app/device-profile.ts", import.meta.url), "utf8"),
  ]);
  assert.match(engine, /window\.__vpNoStageCache/, "the installed build must read the flag");
  assert.match(adapter, /setStageCacheAllowed\(allowed: boolean\): void/);
  assert.match(adapter, /window\.__vpNoStageCache = !allowed/);
  // Same rule as the release hook: no direct global poking outside the adapter.
  assert.doesNotMatch(app, /__vpNoStageCache/);
  assert.match(app, /adapter\.setStageCacheAllowed\(!device\.memoryConstrained\)/);
  // A desktop keeps the cache and keeps the re-slice speedup it buys.
  assert.match(profile, /memoryConstrained/);
});

test("the pool cap keeps threads — it does not fall back to the single-threaded core", async () => {
  /**
   * THE FIX THAT WOULD HAVE COST MORE THAN IT SAVED.
   *
   * The obvious answer to "an Android phone dies when it slices" is to stop
   * telling Android it is cross-origin isolated, because the engine picks its
   * core on that one signal and would then take the single-threaded build.
   *
   * It is the wrong answer. `slicer.worker.js` sends the support-progress and
   * CANCEL pointers to the main thread only when the buffer behind them is a
   * SharedArrayBuffer — which exists only on the threaded core. Dropping
   * isolation would therefore take slice cancellation and live support
   * progress away from every Android phone, on top of a measured 2.2x.
   *
   * So the cap keeps the threaded core and takes the pool size instead. These
   * assertions are what stops someone "simplifying" it back.
   */
  const worker = await readFile(new URL("../node_modules/three-slicer/engine/src/slicer.worker.js", import.meta.url), "utf8");
  // The engine's own core selection is untouched: isolated still means mt.
  assert.match(worker, /const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated/);
  assert.match(worker, /import\('\.\/slicer_core\.mt\.js'\)/);
  // …and the cap runs inside that branch, before the core is imported.
  const branch = /if \(isolated\) \{[\s\S]*?slicer_core\.mt\.js/.exec(worker)?.[0] ?? "";
  assert.ok(branch, "the isolated branch should be findable");
  assert.ok(
    branch.indexOf("capPthreadPool()") > 0 && branch.indexOf("capPthreadPool()") < branch.indexOf("slicer_core.mt.js"),
    "the cap must be applied BEFORE the threaded core reads hardwareConcurrency"
  );
  // The cap shadows the value the core reads, and leaves desktops alone.
  assert.match(worker, /Object\.defineProperty\(navigator, 'hardwareConcurrency', \{ value: cap, configurable: true \}\)/);
  assert.match(worker, /if \(cap >= cores\) return/, "a machine with few cores must not be capped upward");
  // And the thing the whole trade-off is for is still reachable.
  assert.match(worker, /v\.buffer instanceof SharedArrayBuffer/, "cancel + support progress ride on the SAB");
});

test("the server still grants isolation to Android, and says why", async () => {
  /**
   * The counterpart to the test above, on the other side of the wire. If
   * someone adds an Android branch to `isMemoryConstrainedApple`, the headers
   * stop being sent, `crossOriginIsolated` goes false, the engine silently
   * takes the single-threaded core, and cancellation disappears on the exact
   * devices this whole exercise was about — with no error anywhere.
   */
  const platform = await readFile(new URL("../worker/platform.ts", import.meta.url), "utf8");
  const rules = platform.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Android/i.test(rules), "Android must keep isolation — the pool cap is what protects it instead");
  assert.match(platform, /pthread pool/i, "the reasoning must live next to the rule, not only in a test");
});

test("the installed build carries the worker-release hook", async () => {
  const engine = await readFile(engineUrl, "utf8");
  assert.match(engine, /window\.__vpReleaseWorker = \(\) =>/);
  // It refuses while a slice is pending, and only releases the live worker —
  // so it can never truncate work and is never a cancel.
  assert.match(engine, /if \(\$\.current \|\| r\.current !== k\) return !1/);
  // It clears the engine's OWN ref, which is what lets the engine build a
  // fresh worker on the next slice instead of posting into a dead one.
  assert.match(engine, /r\.current = null, N\.current = null/);
  // The engine's original handle is still published, unchanged.
  assert.match(engine, /window\.__vpWorker = k/);
});

test("the shell reaches the hook only through the adapter, and never as a cancel", async () => {
  const [adapter, app] = await Promise.all([readFile(adapterUrl, "utf8"), readFile(appUrl, "utf8")]);
  assert.match(adapter, /releaseSlicerWorker\(\): boolean/);
  assert.match(adapter, /window\.__vpReleaseWorker/);
  // No direct global poking outside the adapter.
  assert.doesNotMatch(app, /__vpReleaseWorker/);
  assert.match(app, /adapter\.releaseSlicerWorker\(\)/);
  // A release is only ever scheduled where memory is worth more than a warm
  // kernel: an idle constrained device, or a backgrounded tab.
  assert.match(app, /device\.idleWorkerReleaseMs/);
  assert.match(app, /document\.visibilityState !== "hidden"/);
  // And a new slice cancels a pending release rather than racing it.
  assert.match(app, /cancelIdleWorkerRelease\(\);\n\s*if \(status === "slicing"/);
});

test("the patch mechanism is documented where the next person will look", async () => {
  const readme = await readFile(patchReadmeUrl, "utf8");
  assert.match(readme, /--error-on-fail/);
  assert.match(readme, /npm ci/);
  assert.match(readme, /__vpReleaseWorker/);
  assert.match(readme, /__vpNoStageCache/);
  // Every replaced engine line needs its own section, because the reason is
  // never obvious from the minified line it changes.
  assert.equal(
    (readme.match(/^## `three-slicer\+0\.2\.2\.patch`/gm) ?? []).length,
    3,
    "a change to the patch must bring its own section here"
  );
});
