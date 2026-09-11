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
  assert.match(patch, /viewer\/dist\/Viewport\.js/);
  // One line changed, purely additive. A patch that starts REMOVING engine
  // behaviour needs a different review than this test can stand in for.
  const removed = patch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const added = patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  assert.equal(removed.length, 1, "the patch must touch exactly one line");
  assert.equal(added.length, 1);
  // Everything the original line did is still there — the change only appends
  // a second assignment inside the same `typeof window` guard.
  const originalPrefix = removed[0].slice(1, removed[0].lastIndexOf("(window.__vpWorker = k"));
  assert.ok(originalPrefix.length > 100, "unexpected patch shape");
  assert.ok(added[0].includes(originalPrefix), "the replacement dropped part of the original line");
  assert.ok(added[0].includes("window.__vpWorker = k"), "the engine's own worker handle must survive");
  assert.ok(added[0].includes("window.__vpReleaseWorker"), "the patch must add the release hook");
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
});
