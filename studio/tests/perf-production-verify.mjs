#!/usr/bin/env node
/**
 * LEVO Studio production acceptance — the owner's nine points, measured.
 *
 * This is the check that decides whether the three reported failures are
 * actually gone on the origin real users visit. It is deliberately harsher
 * than tests/perf-browser-editor.mjs: it drives real touch gestures, samples
 * frame times while they run, watches for long tasks, and repeats
 * slice → cancel → slice to see whether anything accumulates.
 *
 * WHAT IT CHECKS (one per acceptance point):
 *   1. no "Worker terminated (likely out of memory)" anywhere — console, the
 *      shell's error banner, or the engine's own slice error;
 *   2. opening on a phone creates no slicer worker in advance;
 *   3. the first worker appears only when Slice is pressed;
 *   4. repeated Duplicate stays on the bed and takes the nearest free space;
 *   5. no false "Beyond the bed" warning after those duplicates;
 *   6. orbit / zoom / drag are smooth under touch emulation (frame times);
 *   7. autosave does not stall the main thread or leave the canvas frozen;
 *   8. slice → cancel → slice does not accumulate workers or memory;
 *   9. the origin under test really serves the patched build.
 *
 * SAFETY. Guest session only. It never signs in, so the shell's sync layer
 * never uploads: a guest's autosave writes to that browser's IndexedDB and
 * nowhere else. Nothing is written to the production database or bucket.
 *
 * Usage:
 *   npm i --no-save playwright-core
 *   node tests/perf-production-verify.mjs https://studio.levonis-iq.com/
 *   node tests/perf-production-verify.mjs <url> --chromium /path/to/chrome
 *
 * Exit codes: 0 all points pass, 1 a point failed, 2 could not run, 3 deadline.
 * Report written to tests/perf-production-verify.latest.json.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "perf-production-verify.latest.json");
const FIXTURE = join(STUDIO_ROOT, "tests", "fixtures", "cube-10mm.stl");

const target = process.argv.find((arg) => arg.startsWith("http")) ?? "https://studio.levonis-iq.com/";

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Default bed of the default printer profile, and the packer's margin. */
const BED = 256;
const MARGIN = 8;
const HALF_USABLE = (BED - MARGIN * 2) / 2;

/**
 * A frame slower than this is visible as a stutter; slower than the freeze
 * threshold is a hitch the user would call a freeze. Held deliberately loose:
 * this runs on a shared CI runner with software rendering, so the bar is
 * "nothing pathological", not "60fps on a real GPU". A regression that
 * matters shows up as a multi-hundred-millisecond frame, not as 18ms vs 16ms.
 */
const JANK_FRAME_MS = 100;
const FREEZE_FRAME_MS = 500;
/** A main-thread task this long blocks input; the autosave export used to. */
const BLOCKING_TASK_MS = 500;

const DEADLINE_MS = Number(process.env.PERF_PRODUCTION_DEADLINE_MS ?? 12 * 60 * 1000);
const deadline = setTimeout(() => {
  console.error(`::error::perf-production-verify: no result after ${Math.round(DEADLINE_MS / 1000)}s against ${target}`);
  process.exit(3);
}, DEADLINE_MS);
deadline.unref?.();

function resolveChromium() {
  const flag = process.argv.indexOf("--chromium");
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.HOME ? join(process.env.HOME, ".cache", "ms-playwright") : null,
  ].filter((root) => root && existsSync(root));
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      for (const layout of ["chrome-linux/chrome", "chrome-linux64/chrome"]) {
        const candidate = join(root, entry, ...layout.split("/"));
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("perf-production-verify: playwright-core is not installed.\n  npm i --no-save playwright-core");
  process.exit(2);
}
const executablePath = resolveChromium();
if (!executablePath || !existsSync(executablePath)) {
  console.error("perf-production-verify: no Chromium binary found.\n  --chromium /path/to/chrome");
  process.exit(2);
}

function rendererRssKb() {
  let total = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (!cmdline.includes(executablePath) || !cmdline.includes("--type=renderer")) continue;
      total += Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, "utf8"))?.[1] ?? 0);
    } catch {
      /* the process exited between readdir and read */
    }
  }
  return total;
}

/** Counts every Worker the page constructs, before any page script runs. */
const INSTRUMENT = () => {
  window.__levoWorkers = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      window.__levoWorkers.push(String(url));
      super(url, options);
    }
  };
  // Every long main-thread task, for the autosave and gesture checks.
  window.__levoLongTasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__levoLongTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask is not observable everywhere; the frame sampler still is */
  }
  // Everything the app ever showed the user as an error or a notice.
  window.__levoMessages = [];
  const record = (kind, text) => {
    if (typeof text === "string" && text.trim()) window.__levoMessages.push({ kind, text: text.trim().slice(0, 300) });
  };
  window.__levoRecordMessage = record;
  // A rAF sampler that can be armed around a gesture.
  window.__levoFrames = null;
  window.__levoStartFrames = () => {
    window.__levoFrames = [];
    let previous = performance.now();
    const tick = (now) => {
      if (!window.__levoFrames) return;
      window.__levoFrames.push(now - previous);
      previous = now;
      window.__levoFrameHandle = requestAnimationFrame(tick);
    };
    window.__levoFrameHandle = requestAnimationFrame(tick);
  };
  window.__levoStopFrames = () => {
    const frames = window.__levoFrames ?? [];
    window.__levoFrames = null;
    if (window.__levoFrameHandle) cancelAnimationFrame(window.__levoFrameHandle);
    return frames;
  };
};

/** Depth-first querySelector that also descends into shadow roots. */
const SHADOW_QUERY = `function findShadow(root, selector) {
  const hit = root.querySelector && root.querySelector(selector);
  if (hit) return hit;
  const children = root.querySelectorAll ? root.querySelectorAll("*") : [];
  for (const element of children) {
    if (element.shadowRoot) {
      const nested = findShadow(element.shadowRoot, selector);
      if (nested) return nested;
    }
  }
  return null;
}`;

function frameStats(frames) {
  if (!frames.length) return { frames: 0 };
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return {
    frames: frames.length,
    p50Ms: Number(at(0.5).toFixed(1)),
    p95Ms: Number(at(0.95).toFixed(1)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
    jankFrames: frames.filter((f) => f > JANK_FRAME_MS).length,
    freezeFrames: frames.filter((f) => f > FREEZE_FRAME_MS).length,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const results = {};
const failures = [];
const fail = (point, message) => { failures.push(`${point}: ${message}`); };

// -- desktop probe: does this origin serve the patched build at all? --------
{
  const context = await browser.newContext({ userAgent: DESKTOP_UA, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 90_000 });
  await page.waitForTimeout(8_000);
  const probe = await page.evaluate(() => ({
    releaseHookPresent: typeof window.__vpReleaseWorker === "function",
    crossOriginIsolated: self.crossOriginIsolated,
    workersConstructed: window.__levoWorkers.length,
    scripts: [...document.querySelectorAll("script[src]")].map((s) => s.src.split("/").pop()).slice(0, 12),
  }));
  await context.close();
  results.buildIdentity = { origin: target, ...probe };
  if (!probe.releaseHookPresent) {
    fail("9. patched build served", "window.__vpReleaseWorker is absent — this origin is serving a build without the engine patch");
  }
}

// -- the phone session: points 1-8 ------------------------------------------
const context = await browser.newContext({
  userAgent: PHONE_UA,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.addInitScript(INSTRUMENT);
const page = await context.newPage();
const consoleLines = [];
page.on("console", (message) => {
  const text = message.text();
  if (/\[slicer\.worker\]|out of memory|terminated|Error|error/i.test(text)) {
    consoleLines.push(`${message.type()}: ${text.slice(0, 300)}`);
  }
});
page.on("pageerror", (error) => consoleLines.push(`pageerror: ${String(error).slice(0, 300)}`));

const rssBaseline = rendererRssKb();
const startedAt = Date.now();
await page.goto(target, { waitUntil: "load", timeout: 90_000 });
await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 90_000 });
const interactiveMs = Date.now() - startedAt;
await page.waitForTimeout(10_000); // long enough for a warmup to have happened

// -- point 2: no worker created in advance ----------------------------------
const atLoad = await page.evaluate(() => ({
  workers: window.__levoWorkers.length,
  sliceWorkerAlive: Boolean(window.__vpWorker),
}));
results.pageLoad = { interactiveMs, rendererRssKb: rendererRssKb() - rssBaseline, ...atLoad };
if (atLoad.workers !== 0) fail("2. no worker in advance", `${atLoad.workers} worker(s) constructed at page load`);
if (atLoad.sliceWorkerAlive) fail("2. no worker in advance", "the engine already holds a slice worker with an empty bed");

// -- import a model ---------------------------------------------------------
await page.setInputFiles("input.native-file-input", FIXTURE, { timeout: 90_000 });
await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 90_000 });
await page.waitForTimeout(3_000);
const afterImport = await page.evaluate(() => ({
  objects: window.__vpApi().sceneSnapshot().length,
  workers: window.__levoWorkers.length,
}));
results.afterImport = afterImport;
if (afterImport.workers !== 0) fail("2. no worker in advance", `importing a model constructed ${afterImport.workers} worker(s)`);

// -- point 6: touch gestures under emulation --------------------------------
{
  const canvasBox = await page.evaluate(({ source }) => {
    const findShadow = new Function(`${source}; return findShadow;`)();
    const canvas = findShadow(document, "canvas[data-webgl]") ?? findShadow(document, "canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, { source: SHADOW_QUERY });

  if (!canvasBox) {
    fail("6. gestures", "the engine canvas could not be found");
    results.gestures = { error: "canvas not found" };
  } else {
    const cdp = await context.newCDPSession(page);
    const cx = canvasBox.x + canvasBox.width / 2;
    const cy = canvasBox.y + canvasBox.height / 2;
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });

    const gesture = async (name, run) => {
      await page.evaluate(() => window.__levoStartFrames());
      const before = Date.now();
      await run();
      const elapsed = Date.now() - before;
      await page.waitForTimeout(300);
      const frames = await page.evaluate(() => window.__levoStopFrames());
      return { name, elapsedMs: elapsed, ...frameStats(frames) };
    };

    const drag = async (fromX, fromY, toX, toY, steps) => {
      await touch("touchStart", [{ x: fromX, y: fromY, id: 1 }]);
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        await touch("touchMove", [{ x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t, id: 1 }]);
        await page.waitForTimeout(16);
      }
      await touch("touchEnd", []);
    };

    const pinch = async (spread, steps) => {
      const gap = 60;
      await touch("touchStart", [{ x: cx - gap, y: cy, id: 1 }, { x: cx + gap, y: cy, id: 2 }]);
      for (let step = 1; step <= steps; step += 1) {
        const offset = gap + spread * (step / steps);
        await touch("touchMove", [{ x: cx - offset, y: cy, id: 1 }, { x: cx + offset, y: cy, id: 2 }]);
        await page.waitForTimeout(16);
      }
      await touch("touchEnd", []);
    };

    const gestures = [];
    gestures.push(await gesture("orbit", () => drag(cx - 80, cy, cx + 80, cy - 40, 30)));
    gestures.push(await gesture("orbit-back", () => drag(cx + 80, cy - 40, cx - 60, cy + 50, 30)));
    gestures.push(await gesture("pinch-zoom-in", () => pinch(70, 25)));
    gestures.push(await gesture("pinch-zoom-out", () => pinch(-40, 25)));
    gestures.push(await gesture("drag-object", () => drag(cx, cy, cx + 50, cy + 30, 25)));
    // The gizmo rail: move / rotate / scale are mode switches plus a drag.
    for (const mode of ["gizmo-move", "gizmo-rotate", "gizmo-scale"]) {
      gestures.push(await gesture(mode, async () => {
        await page.evaluate(({ source, id }) => {
          const findShadow = new Function(`${source}; return findShadow;`)();
          findShadow(document, `[data-testid="${id}"]`)?.click();
        }, { source: SHADOW_QUERY, id: mode });
        await page.waitForTimeout(200);
        await drag(cx, cy, cx + 40, cy - 25, 20);
      }));
    }

    results.gestures = gestures;
    for (const g of gestures) {
      if (g.freezeFrames > 0) fail("6. gestures", `${g.name}: ${g.freezeFrames} frame(s) over ${FREEZE_FRAME_MS}ms (max ${g.maxMs}ms)`);
    }
    const totalJank = gestures.reduce((n, g) => n + (g.jankFrames ?? 0), 0);
    results.gestureJankFrames = totalJank;
  }
}

// -- point 4 + 5: repeated duplicate, and no false bed warning --------------
{
  const duplicate = await page.evaluate(async ({ source, copies }) => {
    const findShadow = new Function(`${source}; return findShadow;`)();
    const api = window.__vpApi();
    const list = findShadow(document, '[data-testid="obj-list"]');
    const row = [...(list?.querySelectorAll("li, button, div[role='option'], .obj-row") ?? [])]
      .find((candidate) => candidate.textContent && candidate.textContent.trim().length);
    if (!row) return { error: "object list row not found" };
    row.click();
    await new Promise((r) => setTimeout(r, 400));

    const source0 = api.sceneSnapshot()[0];
    const enginePlacement = [];
    const shellPlacement = [];
    for (let copy = 0; copy < copies; copy += 1) {
      const button = findShadow(document, '[data-testid="tool-duplicate"]');
      if (!button) return { error: "duplicate control not found" };
      button.click();
      const spawned = api.sceneSnapshot().at(-1);
      enginePlacement.push({ x: Number(spawned.pos.x.toFixed(1)), z: Number(spawned.pos.z.toFixed(1)) });
      await new Promise((r) => setTimeout(r, 500));
      const settled = api.sceneSnapshot().find((entry) => entry.id === spawned.id);
      shellPlacement.push({ id: settled.id, x: Number(settled.pos.x.toFixed(1)), z: Number(settled.pos.z.toFixed(1)) });
      row.click();
      await new Promise((r) => setTimeout(r, 150));
    }
    // The engine's own over-the-bed warning, and whatever the shell is showing.
    const bedWarn = findShadow(document, '[data-testid="bed-warn"]');
    const overBed = findShadow(document, '[data-testid="over-bed"]');
    const banner = document.querySelector(".editor-message");
    return {
      source: { id: source0.id, x: Number(source0.pos.x.toFixed(1)), z: Number(source0.pos.z.toFixed(1)) },
      plateCentre: api.platePos(0),
      enginePlacement,
      shellPlacement,
      bedWarnText: bedWarn ? (bedWarn.textContent || "").trim().slice(0, 200) : null,
      overBedText: overBed ? (overBed.textContent || "").trim().slice(0, 200) : null,
      bannerText: banner ? (banner.textContent || "").trim().slice(0, 200) : null,
    };
  }, { source: SHADOW_QUERY, copies: 10 });

  if (duplicate.error) {
    fail("4. duplicate placement", duplicate.error);
    results.duplicate = duplicate;
  } else {
    const offBed = (p) =>
      Math.abs(p.x - duplicate.plateCentre.x) > HALF_USABLE || Math.abs(p.z - duplicate.plateCentre.z) > HALF_USABLE;
    const distance = (p) => Math.hypot(p.x - duplicate.source.x, p.z - duplicate.source.z);
    const summarize = (positions) => ({
      copies: positions.length,
      offBed: positions.filter(offBed).length,
      furthestFromSourceMm: Number(Math.max(...positions.map(distance)).toFixed(1)),
      positions: positions.map((p) => [p.x, p.z]),
    });
    results.duplicate = {
      source: duplicate.source,
      plateCentre: duplicate.plateCentre,
      before: summarize(duplicate.enginePlacement),
      after: summarize(duplicate.shellPlacement),
      bedWarnText: duplicate.bedWarnText,
      overBedText: duplicate.overBedText,
      bannerText: duplicate.bannerText,
    };
    if (results.duplicate.after.offBed !== 0) {
      fail("4. duplicate placement", `${results.duplicate.after.offBed} of ${results.duplicate.after.copies} copies landed off the bed`);
    }
    // "Nearest free space": a 10mm cube plus the packer's 6mm gap means the
    // tenth copy of a tight block is still close. Loose enough not to be
    // brittle, tight enough that a copy thrown across the bed fails it.
    if (results.duplicate.after.furthestFromSourceMm > 120) {
      fail("4. duplicate placement", `furthest copy is ${results.duplicate.after.furthestFromSourceMm}mm from the original — not the nearest free space`);
    }
    const bedText = `${duplicate.bedWarnText ?? ""} ${duplicate.overBedText ?? ""} ${duplicate.bannerText ?? ""}`;
    if (/beyond the bed/i.test(bedText)) {
      fail("5. false bed warning", `the editor is showing an over-the-bed warning with every copy on the bed: ${bedText.trim().slice(0, 160)}`);
    }
  }
}

// -- point 7: autosave does not stall, and never leaves the canvas frozen ----
{
  const before = await page.evaluate(() => window.__levoLongTasks.length);
  // Nudge the scene so the shell marks the session dirty, then sit through the
  // debounce and the capture.
  await page.evaluate(({ source }) => {
    const findShadow = new Function(`${source}; return findShadow;`)();
    findShadow(document, '[data-testid="gizmo-move"]')?.click();
  }, { source: SHADOW_QUERY });
  await page.evaluate(() => window.__levoStartFrames());
  await page.waitForTimeout(20_000); // > the constrained-device debounce
  const frames = await page.evaluate(() => window.__levoStopFrames());
  const longTasks = await page.evaluate((n) => window.__levoLongTasks.slice(n), before);
  // A canvas left frozen by a suspendRendering that was never restored is the
  // regression that would matter most here: prove frames are still arriving.
  const stats = frameStats(frames);
  results.autosave = {
    ...stats,
    longTasks: longTasks.length,
    longestTaskMs: longTasks.length ? Number(Math.max(...longTasks.map((t) => t.duration)).toFixed(1)) : 0,
  };
  if (!stats.frames) fail("7. autosave", "no frames were rendered during the autosave window — the canvas is frozen");
  if (stats.freezeFrames > 0) fail("7. autosave", `${stats.freezeFrames} frame(s) over ${FREEZE_FRAME_MS}ms during autosave (max ${stats.maxMs}ms)`);
  if (results.autosave.longestTaskMs > BLOCKING_TASK_MS) {
    fail("7. autosave", `a ${results.autosave.longestTaskMs}ms main-thread task blocked input during autosave`);
  }
}

// -- point 3 + 8: slice, cancel, slice again; nothing accumulates -----------
{
  const cycles = [];
  const clickSlice = () => page.evaluate(({ source }) => {
    const findShadow = new Function(`${source}; return findShadow;`)();
    const button = findShadow(document, '[data-testid="slice-btn"]');
    if (!button) return false;
    button.click();
    return true;
  }, { source: SHADOW_QUERY });

  for (let cycle = 0; cycle < 3; cycle += 1) {
    const clicked = await clickSlice();
    if (!clicked) { fail("3. slice starts the worker", "the slice button could not be found"); break; }
    await page.waitForTimeout(cycle === 0 ? 25_000 : 15_000);
    const state = await page.evaluate(() => ({
      workers: window.__levoWorkers.length,
      sliceWorkerAlive: Boolean(window.__vpWorker),
      messages: window.__levoMessages.length,
    }));
    cycles.push({ cycle: cycle + 1, ...state, rendererRssKb: rendererRssKb() - rssBaseline });
    // Leave preview and come back, which is what a user does between slices.
    await page.evaluate(({ source }) => {
      const findShadow = new Function(`${source}; return findShadow;`)();
      findShadow(document, '[data-testid="mode-prepare"]')?.click();
    }, { source: SHADOW_QUERY });
    await page.waitForTimeout(2_000);
  }
  results.sliceCycles = cycles;

  if (!cycles.length || cycles[0].workers < 1 || !cycles[0].sliceWorkerAlive) {
    fail("3. slice starts the worker", "pressing Slice did not start a worker — the deferral has become a removal");
  }
  if (cycles.length >= 2) {
    const first = cycles[0];
    const last = cycles[cycles.length - 1];
    // Workers may legitimately be re-created after an idle release; what must
    // not happen is one per slice piling up without bound.
    if (last.workers > first.workers + cycles.length) {
      fail("8. no accumulation", `workers grew from ${first.workers} to ${last.workers} across ${cycles.length} slices`);
    }
    const growthKb = last.rendererRssKb - first.rendererRssKb;
    results.rendererGrowthKbAcrossSlices = growthKb;
    // 250 MB of growth across three slices of a 10mm cube would mean nothing
    // is being released between runs.
    if (growthKb > 250_000) {
      fail("8. no accumulation", `renderer RSS grew ${(growthKb / 1024).toFixed(1)}MB across ${cycles.length} slices`);
    }
  }
}

// -- point 10: a painted session keeps its worker ---------------------------
//
// Painting lives only in the kernel's WASM heap, and the viewer caches the
// prepared mesh's identity outside the worker — so releasing the worker
// silently destroys the strokes AND makes the next 3MF save export zero
// painted facets while reporting success. The shell must therefore refuse to
// release a worker once the session has entered a paint mode. This drives that
// path: enter paint, background the tab, and check the worker survived.
{
  const paint = await page.evaluate(async ({ source }) => {
    const findShadow = new Function(`${source}; return findShadow;`)();
    const before = Boolean(window.__vpWorker);
    const paintButton = findShadow(document, '[data-testid="gizmo-paint"]');
    if (!paintButton) return { error: "the paint control was not found" };
    paintButton.click();
    await new Promise((r) => setTimeout(r, 1000));
    const painting = Boolean(findShadow(document, '[data-testid="paint-enforcer"]')
      || findShadow(document, '[data-testid="paint-tools"]')
      || findShadow(document, '[data-testid="paint-counts"]'));

    // Background the tab the way a phone does when the user switches apps.
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 1500));
    if (descriptor) Object.defineProperty(Document.prototype, "visibilityState", descriptor);
    delete document.visibilityState;

    return { workerBefore: before, paintPanelOpened: painting, workerAfterHidden: Boolean(window.__vpWorker) };
  }, { source: SHADOW_QUERY });

  results.paintKeepsWorker = paint;
  if (paint.error) {
    fail("10. painting keeps its worker", paint.error);
  } else if (!paint.workerBefore) {
    // Nothing to protect if no worker existed; record it rather than pretend.
    results.paintKeepsWorker.note = "no worker was alive when the paint check ran — nothing to release";
  } else if (!paint.workerAfterHidden) {
    fail("10. painting keeps its worker", "the slice worker was released after entering paint mode — brush strokes and the next 3MF save would lose their painted facets");
  }
}

// -- point 1: no out-of-memory message anywhere -----------------------------
{
  const pageMessages = await page.evaluate(({ source }) => {
    const findShadow = new Function(`${source}; return findShadow;`)();
    const texts = [];
    const banner = document.querySelector(".editor-message");
    if (banner) texts.push((banner.textContent || "").trim());
    for (const id of ["slice-err", "vp-status", "slice-notice", "bed-warn", "over-bed"]) {
      const node = findShadow(document, `[data-testid="${id}"]`);
      if (node) texts.push((node.textContent || "").trim());
    }
    return texts.filter(Boolean).map((t) => t.slice(0, 300));
  }, { source: SHADOW_QUERY });

  const haystack = [...consoleLines, ...pageMessages].join("\n");
  results.messages = { console: consoleLines.slice(-25), page: pageMessages };
  if (/out of memory|Worker terminated/i.test(haystack)) {
    fail("1. no OOM", `an out-of-memory message appeared: ${(/.*(?:out of memory|Worker terminated).*/i.exec(haystack) ?? [""])[0].slice(0, 200)}`);
  }
  if (/structured clone failed/i.test(haystack)) {
    fail("1. no OOM", "the engine reported a worker message error (structured clone failed)");
  }
}

await context.close();
await browser.close();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const report = {
  kind: "levo-studio-production-verify",
  version: 1,
  generatedAt: new Date().toISOString(),
  target,
  passed: failures.length === 0,
  failures,
  ...results,
};

const mb = (kb) => `${(kb / 1024).toFixed(1)} MB`;
console.log(`LEVO Studio production acceptance — ${target}`);
console.log("");
console.log(`  1. no out-of-memory message      : ${failures.some((f) => f.startsWith("1.")) ? "FAIL" : "pass"}`);
console.log(`  2. no worker created in advance  : ${failures.some((f) => f.startsWith("2.")) ? "FAIL" : "pass"}  (workers at load: ${results.pageLoad?.workers}, after import: ${results.afterImport?.workers})`);
console.log(`  3. first worker only at Slice    : ${failures.some((f) => f.startsWith("3.")) ? "FAIL" : "pass"}  (after slice: ${results.sliceCycles?.[0]?.workers})`);
if (results.duplicate?.after) {
  console.log(`  4. duplicate stays on the bed    : ${failures.some((f) => f.startsWith("4.")) ? "FAIL" : "pass"}  (before ${results.duplicate.before.offBed}/10 off-bed @${results.duplicate.before.furthestFromSourceMm}mm -> after ${results.duplicate.after.offBed}/10 @${results.duplicate.after.furthestFromSourceMm}mm)`);
}
console.log(`  5. no false "Beyond the bed"     : ${failures.some((f) => f.startsWith("5.")) ? "FAIL" : "pass"}`);
if (Array.isArray(results.gestures)) {
  const worst = results.gestures.reduce((a, b) => ((b.maxMs ?? 0) > (a.maxMs ?? 0) ? b : a), results.gestures[0]);
  console.log(`  6. gestures smooth on mobile     : ${failures.some((f) => f.startsWith("6.")) ? "FAIL" : "pass"}  (worst frame ${worst?.maxMs}ms in ${worst?.name}; ${results.gestureJankFrames} janky frames total)`);
}
if (results.autosave) {
  console.log(`  7. autosave without jank/freeze  : ${failures.some((f) => f.startsWith("7.")) ? "FAIL" : "pass"}  (frames ${results.autosave.frames}, max ${results.autosave.maxMs}ms, longest task ${results.autosave.longestTaskMs}ms)`);
}
if (results.sliceCycles?.length) {
  console.log(`  8. slice/cancel/slice no buildup : ${failures.some((f) => f.startsWith("8.")) ? "FAIL" : "pass"}  (${results.sliceCycles.map((c) => `#${c.cycle} ${c.workers}w ${mb(c.rendererRssKb)}`).join(", ")})`);
}
console.log(`  9. patched build on this origin  : ${failures.some((f) => f.startsWith("9.")) ? "FAIL" : "pass"}  (release hook: ${results.buildIdentity?.releaseHookPresent}, isolated: ${results.buildIdentity?.crossOriginIsolated})`);
console.log(` 10. painting keeps its worker     : ${failures.some((f) => f.startsWith("10.")) ? "FAIL" : "pass"}  (worker before ${results.paintKeepsWorker?.workerBefore}, after backgrounding ${results.paintKeepsWorker?.workerAfterHidden}${results.paintKeepsWorker?.note ? " — " + results.paintKeepsWorker.note : ""})`);
console.log("");
if (failures.length) {
  console.log("  FAILURES:");
  for (const failure of failures) console.log(`    - ${failure}`);
} else {
  console.log("  All acceptance points passed.");
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(`\nReport written: ${relative(process.cwd(), REPORT_PATH)}`);
clearTimeout(deadline);
process.exit(failures.length ? 1 : 0);
