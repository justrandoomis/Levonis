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
