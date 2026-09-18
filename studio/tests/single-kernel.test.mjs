/**
 * ONE COPY OF THE KERNEL IN THE BUILD, AND A HEAP A PHONE CAN RESERVE.
 *
 * `npm test` runs `npm run build` first, so `dist/` here is this commit's real
 * output — which is the only place either of these can be checked. Both fixes
 * are build transforms (see the long comment on `singleKernel` in
 * vite.config.ts for why they cannot be patch-package patches: the kernel is
 * 5.28 MB on one line).
 *
 * WHAT WENT WRONG, so that a future edit that reintroduces it fails here.
 *
 * Vite's `vite:worker-import-meta-url` plugin rewrote the kernel's own
 * `new Worker(new URL("slicer_core.mt.js", import.meta.url))` into a second
 * emitted worker bundle, because the self-reference branch it has compares
 * against the last entry of the bundle chain — `slicer.worker.js` here, not
 * the kernel. The build shipped two byte-identical 6.24 MB modules at two
 * URLs: the slice worker loaded one, every pthread in its pool loaded the
 * other, and a browser shares nothing between two URLs. 12.5 MB of JavaScript
 * for one small model, all of it before a triangle is touched.
 *
 * And the kernel reserves a 4 GiB SHARED WebAssembly.Memory, which is more
 * address space than a 32-bit browser process has at all.
 *
 * `tests/browser-kernel-boot.mjs` is the other half of this: it drives a real
 * Chromium with a phone user agent and proves the transformed kernel still
 * compiles and reports ready. Text assertions cannot show that, and a kernel
 * that does not boot is Studio not working for anybody.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";

const studioRoot = new URL("../", import.meta.url);
const assetsDir = new URL("dist/client/assets/", studioRoot);
const built = existsSync(assetsDir) ? await readdir(assetsDir) : null;

/** `npm test` builds first; a bare `node --test` may not have. */
const needsBuild = { skip: built ? false : "dist/client is missing — run `npm run build` first" };

test("the threaded kernel is emitted ONCE", needsBuild, () => {
  const kernels = built.filter((f) => /^slicer_core\.mt-.*\.js$/.test(f));
  assert.deepEqual(
    kernels.length,
    1,
    `dist/client/assets carries ${kernels.length} copies of the 6.24 MB threaded kernel `
      + `(${kernels.join(", ")}). Two URLs means two downloads and two parses on the device `
      + "that can least afford them."
  );
});

test("the slice worker and its pthread pool load the SAME kernel", needsBuild, async () => {
  const workerFile = built.find((f) => /^slicer\.worker-.*\.js$/.test(f));
  assert.ok(workerFile, "the slice worker must be in the build");
  const [worker, kernel] = await Promise.all([
    readFile(new URL(workerFile, assetsDir), "utf8"),
    readFile(new URL(built.find((f) => /^slicer_core\.mt-.*\.js$/.test(f)), assetsDir), "utf8"),
  ]);

  const imported = [...new Set([...worker.matchAll(/slicer_core\.mt-[A-Za-z0-9_-]+\.js/g)].map((m) => m[0]))];
  assert.equal(imported.length, 1, "the slice worker must import exactly one kernel");

  // The pool spawns from the kernel's OWN url. Not `self.location.href`: inside
  // the slice worker that is slicer.worker-*.js, a different script entirely.
  assert.match(
    kernel,
    /new Worker\(import\.meta\.url,\{type:`module`,workerData:`em-pthread`,name:`em-pthread`\}\)/,
    "the pthread pool must spawn from the kernel's own module URL"
  );
  assert.doesNotMatch(
    kernel,
    /new Worker\(new URL\(`?slicer_core\.mt/,
    "a second kernel URL is back — Vite will emit another copy of it"
  );
});

test("a handheld reserves 1 GiB of shared heap, not 4", needsBuild, async () => {
  /**
   * A shared WebAssembly.Memory cannot be relocated when it grows, so the whole
   * `maximum` is reserved as contiguous address space at construction. 65536
   * pages is 4 GiB — fine on a 64-bit browser, impossible on a 32-bit one, and
   * the failure is the constructor throwing during boot, which the page shows
   * as "Worker terminated (likely out of memory)" on an empty bed.
   *
   * There is no host hook for it: the worker calls the factory with no module
   * argument, and the glue exposes neither Module.wasmMemory nor
   * Module.INITIAL_MEMORY. Hence a build transform.
   */
  const kernel = await readFile(new URL(built.find((f) => /^slicer_core\.mt-.*\.js$/.test(f)), assetsDir), "utf8");
  // Read a window rather than a balanced group: the replacement contains its
  // own parentheses (a RegExp#test call), so `[^)]*` would stop inside it.
  const at = kernel.indexOf("new WebAssembly.Memory(");
  assert.notEqual(at, -1, "the kernel must still construct its shared memory here");
  const memory = kernel.slice(at, at + 300);
  assert.match(memory, /shared:!0|shared:true/, "it is still the SHARED memory that needs the reservation");
  assert.match(memory, /16384/, "handhelds must get the 1 GiB ceiling");
  assert.match(memory, /65536/, "and every other browser must keep the engine's own 4 GiB");
  assert.match(memory, /Android\|iPhone\|iPad\|iPod/, "the ceiling is for handhelds only — not a blanket cut");
});

test("the transform refuses to silently no-op after a three-slicer upgrade", async () => {
  // The whole mechanism rests on two string literals still being in the
  // engine. `replaceOnce` throws when a match count is not exactly 1, so an
  // upgrade FAILS THE BUILD — the same doctrine as `patch-package
  // --error-on-fail`. This test says so out loud, and checks the config still
  // carries the guard rather than a plain `.replace()`.
  const config = await readFile(new URL("vite.config.ts", studioRoot), "utf8");
  assert.match(config, /const hits = code\.split\(from\)\.length - 1;/);
  assert.match(config, /if \(hits !== 1\) \{\s*throw new Error\(/);
  // `config.plugins` does not reach worker bundles in a production build. This
  // is the line that cost a whole build to find.
  assert.match(config, /plugins: \(\) => \[singleKernel\]/, "the transform must be registered under worker.plugins");
});
