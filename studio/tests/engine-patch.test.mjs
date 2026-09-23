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
  // Two files, four problems. Both files are named here so that a third
  // arriving without its own review is visible.
  assert.match(patch, /viewer\/dist\/Viewport\.js/, "the idle-worker release hook, the stage-cache opt-out, the retry ladder");
  assert.match(patch, /engine\/src\/slicer\.worker\.js/, "the pthread pool cap");
  assert.equal((patch.match(/^diff --git /gm) ?? []).length, 2, "an unreviewed third FILE");

  /**
   * EXACTLY THREE LINES OF ENGINE BEHAVIOUR ARE REPLACED IN THE WHOLE PATCH,
   * and each replacement keeps everything its original did. Every other line
   * is an addition. A patch that starts REMOVING engine behaviour needs a
   * different review than this test can stand in for, and it should fail here
   * first.
   *
   * The count is asserted rather than the shape alone, because the cheapest
   * way to break an engine is to delete one of its lines while adding yours.
   * Raising it is a deliberate act: each of the three is accounted for by
   * name below, and a fourth has to arrive with its own accounting.
   */
  const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  assert.equal(removed.length, 3, "the patch must replace exactly three engine lines");
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
  // Matched on the FORCED assignment, not on the word: the retry ladder's
  // replaced line passes keep_stages through too, and a loose substring would
  // find that one instead.
  const removedStageLine = removed.find((line) => line.includes("k.keep_stages = !0"));
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

  // 3. The retry ladder's LAST rung is the third replaced line: reporting a
  // failed attempt means catching it, and the original returned it straight.
  const removedRungLine = removed.find((line) => line.includes("economy: !0, recovered: !0"));
  assert.ok(removedRungLine, "the economy rung's return should be the third line replaced");
  //
  // THE LADDER'S BEHAVIOUR MUST BE UNCHANGED. The patch adds reporting, not a
  // retry policy: the same three attempts, with the same parameters, in the
  // same order. Each call is asserted VERBATIM, because a reporting change
  // that quietly alters what the engine retries with would look identical in
  // a diff and would only show up as different G-code.
  // The POST-patch text of every hunk: context lines the patch left alone plus
  // the lines it adds. Asserting against `added` alone would be wrong here —
  // rung 1 and rung 2 are untouched, so they appear as context, and their
  // being context is exactly the proof wanted.
  const addedText = patch
    .split("\n")
    .filter((line) => !line.startsWith("-") && !line.startsWith("@@") && !line.startsWith("diff ") && !line.startsWith("index "))
    .join("\n");
  for (const [rung, call] of [
    ["1/3 full", "await L(k, JSON.stringify(F))"],
    ["2/3 classic walls", 'await L(k, JSON.stringify({ ...F, wall_generator: "classic", keep_stages: !1, reuse_stages: 0 }))'],
    ["3/3 economy", "await L(k, JSON.stringify({ ...F, economy: !0, keep_stages: !1, reuse_stages: 0 }))"],
  ]) {
    assert.ok(addedText.includes(call), `rung ${rung} no longer runs the engine's own call`);
  }
  // A cancel must still propagate untouched from every rung — it is the one
  // failure that must NOT advance the ladder or be reported as an attempt.
  assert.ok(addedText.includes("if (ne(O)) throw O;"), "a canceled first rung must still rethrow");
  assert.equal(
    (addedText.match(/if \(ne\(pe\)\) throw pe;/g) ?? []).length,
    2,
    "both later rungs must still rethrow a cancel before reporting it as a failure"
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
  // And a new slice cancels a pending release rather than racing it: the
  // release must be cancelled BEFORE triggerSlice branches, with nothing but
  // comments in between.
  assert.match(
    app,
    /cancelIdleWorkerRelease\(\);\n(?:\s*\/\/[^\n]*\n)*\s*if \(status === "slicing"/,
    "a pending idle release must be cancelled before the slice/cancel branch"
  );
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
    5,
    "a change to the patch must bring its own section here"
  );
});

test("the retry ladder reports each failed attempt", async () => {
  const [engine, adapter, hook, app] = await Promise.all([
    readFile(engineUrl, "utf8"),
    readFile(adapterUrl, "utf8"),
    readFile(new URL("../app/hooks/use-slicing-state.ts", import.meta.url), "utf8"),
    readFile(appUrl, "utf8"),
  ]);

  // THE SILENCE THIS CLOSES. A failed slice is three attempts — full quality,
  // classic walls, economy — each re-booting the 5.28 MB kernel, and the
  // engine shipped reporting none of them until all three were spent. The
  // owner saw a bar stuck at 87% for minutes and then one sentence carrying
  // only the LAST error. See patches/README.md.
  assert.match(engine, /\[vp-retry\]/, "the engine no longer logs its retry rungs");
  assert.match(engine, /__vpRungs/, "the rung log left the installed build");
  assert.match(engine, /"vp-retry"/, "the rung event left the installed build");

  // The DURATION is the diagnostic, not the message: ~60s means the watchdog
  // fired with the worker already unresponsive during emit, while a few
  // seconds means the attempt died loading the kernel and never reached emit.
  // Those are different faults, and without the timing nothing tells them
  // apart.
  assert.match(engine, /failed after \$\{[A-Za-z_$][\w$]*\}s/, "a rung no longer reports how long it ran");
  // The third rung's throw must carry the whole ladder, or the first two
  // errors — the informative ones — are dropped exactly as before.
  assert.match(engine, /attempts: \$\{[A-Za-z_$][\w$]*\.join\(" \| "\)\}/, "the final error dropped the earlier attempts");

  // The shell reaches the log only through the adapter, like every other
  // patched hook, and the contract list is what makes a lost patch loud.
  assert.match(adapter, /onSliceRetry\(/, "the adapter stopped exposing the retry stream");
  assert.match(adapter, /"__vpRungs"/, "__vpRungs left ENGINE_WINDOW_HOOKS");
  assert.ok(!/__vpRungs/.test(app), "slicer-client must not read the engine global directly");

  // Reset belongs on `slicing: true` — the engine raises it ONCE per ladder,
  // not per rung — so resetting on `false` would erase the count a failure
  // message needs.
  assert.match(hook, /setRetry\(\{ attempt: 1, total: 1 \}\)/, "the rung counter is no longer reset at slice start");
  assert.match(hook, /adapter\.onSliceRetry\(/, "the hook stopped subscribing to the ladder");
  // The suffix is a glyph and two numbers on purpose: no ar/en/ckb wording,
  // so no machine-written Sorani string enters the UI for it.
  assert.match(app, /↻ \$\{slicing\.retryAttempt\}\/\$\{slicing\.retryTotal\}/, "the header stopped showing the rung");
});

test("cancel works where the engine's own cancel cannot", async () => {
  const [engine, adapter, app, platform] = await Promise.all([
    readFile(engineUrl, "utf8"),
    readFile(adapterUrl, "utf8"),
    readFile(appUrl, "utf8"),
    readFile(new URL("../worker/platform.ts", import.meta.url), "utf8"),
  ]);

  // THE BUG. The engine cancels by writing a flag in a SharedArrayBuffer, and
  // a SharedArrayBuffer needs cross-origin isolation, which platform.ts
  // withholds from every Apple UA on purpose. So «إلغاء» wrote to a null view
  // on the owner's iPad and the slice ran on. This assertion is the link
  // between those two facts: if the Apple branch ever goes away, the fallback
  // below stops being needed and this test should be revisited deliberately.
  assert.match(platform, /iPhone\|iPad\|iPod/, "the Apple isolation branch is what makes the fallback necessary");
  assert.match(engine, /Atomics\.store\(k\.cancel, 0, 1\)/, "the engine's flag-based cancel should still be there");

  assert.match(engine, /window\.__vpCanCancel = \(\) => !!\(N\.current && N\.current\.cancel\)/, "the capability probe left the build");
  assert.match(engine, /window\.__vpAbortSlice/, "the abort hook left the build");
  // The abort must never fire when nothing is pending, and never terminate a
  // worker that is no longer the live one — the same two guards the release
  // hook carries, for the same reason.
  assert.match(engine, /const V = \$\.current;\s*if \(!V \|\| r\.current !== k\) return !1;/, "the abort lost its pending/live-worker guards");
  // Leaving r.current pointing at a dead worker is the failure patches/README
  // warns about: the next slice posts into nothing and waits out a watchdog.
  assert.match(engine, /k\.terminate\(\); \} catch \{ \} return r\.current = null/, "the abort must null the worker ref it terminated");
  // "canceled" is what both the retry ladder and the error handler test for.
  // Reject with anything else and a deliberate cancel is retried twice more
  // and then reported to the user as a failure.
  assert.match(engine, /V\.reject\(new Error\("slice canceled"\)\)/, "the abort must reject as a cancel, or the ladder retries it");

  assert.match(adapter, /"__vpCanCancel"/, "__vpCanCancel left ENGINE_WINDOW_HOOKS");
  assert.match(adapter, /"__vpAbortSlice"/, "__vpAbortSlice left ENGINE_WINDOW_HOOKS");
  // Prefer the engine's own cancel wherever it can work: it unwinds the kernel
  // and keeps the warm 5.28 MB core for the next slice. Terminating is the
  // fallback, not the default.
  assert.match(adapter, /if \(engineCanCancel\) return this\.clickControl\("slice-btn"\);/, "the adapter stopped preferring the engine's own cancel");
  assert.match(adapter, /cancelSlice\(\): boolean/, "the adapter stopped exposing a cancel");

  // Same rule as every other patched hook: no direct global poking in the shell.
  assert.doesNotMatch(app, /__vpAbortSlice|__vpCanCancel/, "the shell must go through the adapter");
  assert.match(app, /if \(!adapter\.cancelSlice\(\)\) setNotice/, "the shell's cancel branch must use the adapter");
});
