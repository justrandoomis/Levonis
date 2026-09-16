/**
 * Which platforms must NOT be told they are cross-origin isolated.
 *
 * This lives in its own file for one reason: `worker/index.ts` imports vinext
 * and the whole Cloudflare runtime, so nothing can load it in a plain test —
 * and this predicate is the only thing standing between an iPad and a worker
 * the operating system kills. It was untested while it carried that weight.
 * A pure function in a file with no imports can be tested directly, and
 * `tests/platform.test.mjs` pins every user agent below.
 *
 * See the ISOLATION_HEADERS comment in `worker/index.ts` for the full
 * reasoning. The short version: three-slicer selects its WASM core on one
 * signal and nothing else —
 *
 *     const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
 *     if (isolated) { ...slicer_core.mt.js... } else { ...st... }
 *
 * (verified verbatim in node_modules/three-slicer/engine/src/slicer.worker.js)
 *
 * — so withholding the isolation headers is what makes the engine take its
 * own single-threaded path. Slower, and it survives.
 */

/**
 * WHY ANDROID IS NOT IN THIS LIST, WHICH IS THE OPPOSITE OF WHAT IT LOOKS LIKE.
 *
 * An Android phone dies with "Worker terminated (likely out of memory)" the
 * moment it slices, and it dies for the same reason an iPad did: the threaded
 * core spawns one module Worker per logical core, each parsing the package's
 * 5.28 MB core, as a blocking dependency before the kernel reports ready. On
 * an eight-core phone that is eight extra isolates and eight parses.
 *
 * So the obvious fix is to add Android here and let the engine take its
 * single-threaded core, exactly as this function already does for iPadOS.
 *
 * DO NOT. The two platforms are not in the same position. `slicer.worker.js`
 * hands the main thread its support-progress and CANCEL pointers only when the
 * buffer behind them is a SharedArrayBuffer, and that exists only on the
 * threaded core. Withholding isolation from Android would therefore remove
 * slice cancellation and live support progress from every Android phone — a
 * feature loss, not a slowdown — on top of a measured 2.2x.
 *
 * Android keeps threads. What it does not keep is a thread per core: the
 * pthread pool is capped to two inside the worker, by the LEVONIS hunk in
 * patches/three-slicer+0.2.2.patch. That removes the memory the pool costs
 * while leaving the SharedArrayBuffer, and therefore cancel, intact.
 * tests/engine-patch.test.mjs asserts both halves of that trade, including
 * that this function still has no Android branch.
 *
 * iOS and iPadOS are different because WebKit's per-tab budget cannot carry
 * the threaded core at ANY pool size, so for them the core itself has to go.
 */

/**
 * iOS and iPadOS, including iPadOS Safari's desktop-class user agent — which
 * claims Macintosh and is only told apart from a real Mac by touch points,
 * which a server cannot see.
 *
 * A real Mac running Safari therefore matches too. That is a deliberate
 * trade: it costs a desktop some slicing speed and costs no correctness,
 * while the alternative — guessing wrong the other way — hands an iPad a
 * threaded core that gets it killed.
 *
 * What actually excludes Chrome and Firefox on macOS is the `Version/N`
 * token: it is a Safari/WebKit marker, and neither of them emits it. The
 * explicit `!/Chrome|Chromium|Firefox/` below is belt-and-braces on top of
 * that — no mainstream user agent carries Macintosh AND `Version/N` AND
 * `Safari` AND a Chromium token at once, so removing it changes nothing
 * today. It is kept as cheap insurance against a future UA that does.
 * tests/platform.test.mjs says the same, so nobody re-derives it.
 */
export function isMemoryConstrainedApple(userAgent: string): boolean {
  const ua = userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && /Version\/\d+.*Safari/i.test(ua) && !/Chrome|Chromium|Firefox/i.test(ua)) {
    return true;
  }
  return false;
}
