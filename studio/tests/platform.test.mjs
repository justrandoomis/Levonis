/**
 * Who gets cross-origin isolation, and who must not.
 *
 * WHY THIS EXISTS. The owner photographed "Worker terminated (likely out of
 * memory): worker error" on an iPad, on a project with nothing loaded. The
 * cause is not our code: three-slicer picks its WASM core on exactly one
 * signal (verified verbatim in the vendored engine at
 * node_modules/three-slicer/engine/src/slicer.worker.js) —
 *
 *     const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
 *     if (isolated) { ...slicer_core.mt.js... } else { ...st... }
 *
 * — and `mt` is a SharedArrayBuffer heap plus a pthread pool sized from
 * hardwareConcurrency. WebKit's per-tab budget on iPadOS kills that worker
 * shortly after it boots. A kill is not a thrown error, so the engine's own
 * catch cannot save it; it arrives as an ErrorEvent with an empty message and
 * the engine prints its stock guess.
 *
 * So the fix is to stop advertising isolation to those platforms and let the
 * engine take its own single-threaded branch. `isMemoryConstrainedApple` is
 * the entire mechanism — and it had NO test while carrying that weight. A
 * plausible-looking "simplification" of either regex would silently hand
 * iPads the threaded core again, and the only symptom would be the owner
 * reporting the same crash weeks later.
 *
 * Every user agent below is a real one, and each is here for a reason.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../worker/platform.ts", import.meta.url);

// platform.ts has no imports at all, precisely so this works.
const source = await readFile(sourceUrl, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isMemoryConstrainedApple } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

/** Must take the single-threaded core, or the OS kills the worker. */
const CONSTRAINED = {
  "iPad, mobile-mode Safari":
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  // The one that matters most and is hardest to spot: iPadOS 13+ defaults to
  // "Request Desktop Website", and then the UA says Macintosh with no iPad in
  // it anywhere. Matching only /iPad/ would miss the owner's actual device.
  "iPad, desktop-mode Safari (claims Macintosh)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "iPhone Safari":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  // Chrome and Firefox on iOS are WebKit underneath — same budget, same kill.
  "Chrome on iOS (WebKit underneath)":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
  // A real Mac on Safari is indistinguishable from the desktop-mode iPad
  // above from the server side. Deliberately included: costs a desktop some
  // speed, costs no correctness, and guessing the other way kills iPads.
  "macOS Safari (accepted collateral — see platform.ts)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
};

/** Must keep threads — these are the platforms the headers were added for. */
const ISOLATED = {
  "Windows Chrome":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  // NOTE ON COVERAGE, so nobody trusts more than is here: these two pass
  // because neither emits Safari's `Version/N` token, NOT because of the
  // explicit !/Chrome|Chromium|Firefox/ clause in platform.ts. Deleting that
  // clause leaves this whole file green. It is kept as insurance against a
  // future UA carrying Macintosh + Version/N + Safari + a Chromium token,
  // which no mainstream browser does today — so no honest test can pin it.
  "macOS Chrome (Blink, not WebKit)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "macOS Firefox (Gecko, not WebKit)":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Linux Chrome":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Android Chrome":
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Windows Edge":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
};

test("platforms whose worker the OS would kill are never told they are isolated", () => {
  for (const [label, ua] of Object.entries(CONSTRAINED)) {
    assert.equal(
      isMemoryConstrainedApple(ua),
      true,
      `${label} must NOT get isolation — the threaded core gets its worker killed`
    );
  }
});

test("every other platform keeps cross-origin isolation, and its threads", () => {
  for (const [label, ua] of Object.entries(ISOLATED)) {
    assert.equal(
      isMemoryConstrainedApple(ua),
      false,
      `${label} must keep isolation — withholding it costs ~2.2x slicing speed for nothing`
    );
  }
});

test("a missing or empty user agent keeps isolation rather than crashing", () => {
  // A worker must never throw while deciding response headers. Absent a UA we
  // cannot tell, and the safe default is the documented one: no header change
  // for the platforms this was never about.
  for (const value of ["", undefined, null]) {
    assert.equal(isMemoryConstrainedApple(value), false, `user agent ${JSON.stringify(value)}`);
  }
});
