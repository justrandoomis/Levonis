#!/usr/bin/env node
/**
 * The three reported failures, measured in a real browser against a real
 * build of LEVO Studio.
 *
 * WHAT IT MEASURES
 *  1. Page load — what the editor costs a device before anything is on the
 *     bed: workers constructed, whether the slice worker exists at all, time
 *     to an interactive editor, renderer RSS. Run for a desktop user agent
 *     (which keeps the behaviour Studio has always had) and for a phone user
 *     agent (which takes the deferred path). The desktop row IS the "before".
 *  2. Deferred, not disabled — imports a fixture and slices on the phone path,
 *     and shows the kernel loading at that moment. If this ever shows the
 *     slice failing to start, the deferral has become a removal and must be
 *     reverted, not explained.
 *  3. Duplicate placement — presses the editor's own Duplicate ten times and
 *     records, for each copy, where the ENGINE put it and where the shell then
 *     seated it. The engine's duplicate is synchronous while the shell re-seats
 *     on the objects event a task later, so one run yields both before and
 *     after with no rebuild and no straw man.
 *
 * NOT part of `npm test`: it needs a running Studio, a Chromium binary and
 * playwright-core. Run it by hand:
 *
 *   npm run build
 *   npx wrangler dev --local --port 8799 --ip 127.0.0.1   # in another shell
 *   npm i --no-save playwright-core
 *   node tests/perf-browser-editor.mjs                     # defaults to :8799
 *   node tests/perf-browser-editor.mjs http://127.0.0.1:8799/ --chromium /path/to/chrome
 *
 * Report written to tests/perf-browser-editor.latest.json.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "perf-browser-editor.latest.json");
const FIXTURE = join(STUDIO_ROOT, "tests", "fixtures", "cube-10mm.stl");

const target = process.argv.find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:8799/";

const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** Default bed of the default printer profile, and the packer's margin. */
const BED = 256;
const MARGIN = 8;
const HALF_USABLE = (BED - MARGIN * 2) / 2;

function resolveChromium() {
  const flag = process.argv.indexOf("--chromium");
  if (flag >= 0 && process.argv[flag + 1]) return process.argv[flag + 1];
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const candidate = join(root, entry, "chrome-linux", "chrome");
      if (entry.startsWith("chromium-") && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("perf-browser-editor: playwright-core is not installed.\n  npm i --no-save playwright-core");
  process.exit(2);
}
const executablePath = resolveChromium();
if (!executablePath || !existsSync(executablePath)) {
  console.error("perf-browser-editor: no Chromium binary found.\n  node tests/perf-browser-editor.mjs --chromium /path/to/chrome");
  process.exit(2);
}

function rssKb(marker) {
  const per = {};
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (!cmdline.includes(marker)) continue;
      const rss = Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${entry}/status`, "utf8"))?.[1] ?? 0);
      const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? "browser";
      per[type] = (per[type] ?? 0) + rss;
    } catch {
      /* the process exited between readdir and read */
    }
  }
  return per;
}

/** Counts every Worker the page constructs, before any page script runs. */
const COUNT_WORKERS = () => {
  window.__levoWorkers = [];
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(url, options) {
      window.__levoWorkers.push(String(url));
      super(url, options);
    }
  };
};

/**
 * Depth-first querySelector that also descends into shadow roots — the engine
 * renders its whole UI inside one, so nothing here is reachable otherwise.
 * Shipped to the page as source because page.evaluate cannot close over it.
 */
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

async function openEditor(browser, userAgent, viewport) {
  const context = await browser.newContext({ userAgent, viewport });
  await context.addInitScript(COUNT_WORKERS);
  const page = await context.newPage();
  return { context, page };
}

async function measurePageLoad(browser, label, userAgent, viewport) {
  const { context, page } = await openEditor(browser, userAgent, viewport);
  const before = rssKb(executablePath);
  const startedAt = Date.now();
  await page.goto(target, { waitUntil: "load", timeout: 60_000 });
  const loadMs = Date.now() - startedAt;

  let interactiveMs = null;
  try {
    await page.waitForFunction(() => {
      const findCanvas = (root) => {
        if (root.querySelector?.("canvas[data-webgl]")) return true;
        for (const element of root.querySelectorAll?.("*") ?? []) {
          if (element.shadowRoot && findCanvas(element.shadowRoot)) return true;
        }
        return false;
      };
      return findCanvas(document) || Boolean(document.querySelector(".empty-upload-card"));
    }, null, { timeout: 60_000 });
    interactiveMs = Date.now() - startedAt;
  } catch {
    interactiveMs = null;
  }

  // Give anything the page starts on its own (the warmup) time to happen.
  await page.waitForTimeout(12_000);
  const after = rssKb(executablePath);
  const state = await page.evaluate(() => ({
    workersConstructed: window.__levoWorkers.length,
    workerUrls: window.__levoWorkers.map((url) => url.split("/").pop()),
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    engineMounted: Boolean(window.__vpApi),
    sliceWorkerAlive: Boolean(window.__vpWorker),
    releaseHookPresent: typeof window.__vpReleaseWorker === "function",
  }));
  await context.close();
  return {
    label,
    userAgent,
    loadMs,
    interactiveMs,
    rendererRssDeltaKb: (after.renderer ?? 0) - (before.renderer ?? 0),
    ...state,
  };
}

async function measureSliceOnDemandAndDuplicate(browser) {
  const { context, page } = await openEditor(browser, PHONE_UA, { width: 900, height: 800 });
  const engineLog = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("[slicer.worker]")) engineLog.push(text);
  });

  await page.goto(target, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__vpApi), null, { timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const atLoad = await page.evaluate(() => ({
    workersConstructed: window.__levoWorkers.length,
    sliceWorkerAlive: Boolean(window.__vpWorker),
  }));

  await page.setInputFiles("input.native-file-input", FIXTURE);
  await page.waitForFunction(() => (window.__vpApi?.()?.sceneSnapshot?.() ?? []).length > 0, null, { timeout: 60_000 });
  await page.waitForTimeout(2_500);
  const afterImport = await page.evaluate(() => ({
    objects: window.__vpApi().sceneSnapshot().length,
    workersConstructed: window.__levoWorkers.length,
    sliceWorkerAlive: Boolean(window.__vpWorker),
  }));

  const duplicate = await page.evaluate(async ({ shadowQuerySource, copies }) => {
    const findShadow = new Function(`${shadowQuerySource}; return findShadow;`)();
    const api = window.__vpApi();
    const list = findShadow(document, '[data-testid="obj-list"]');
    const row = [...(list?.querySelectorAll("li, button, div[role='option'], .obj-row") ?? [])]
      .find((candidate) => candidate.textContent && candidate.textContent.trim().length);
    if (!row) return { error: "object list row not found" };
    row.click();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const source = api.sceneSnapshot()[0];
    const enginePlacement = [];
    const shellPlacement = [];
    for (let copy = 0; copy < copies; copy += 1) {
      const button = findShadow(document, '[data-testid="tool-duplicate"]');
      if (!button) return { error: "duplicate control not found" };
      // Synchronous: after click() returns, the copy is exactly where the
      // engine's own placement cursor put it.
      button.click();
      const spawned = api.sceneSnapshot().at(-1);
      enginePlacement.push({ id: spawned.id, x: Number(spawned.pos.x.toFixed(1)), z: Number(spawned.pos.z.toFixed(1)) });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settled = api.sceneSnapshot().find((entry) => entry.id === spawned.id);
      shellPlacement.push({ id: settled.id, x: Number(settled.pos.x.toFixed(1)), z: Number(settled.pos.z.toFixed(1)) });
      // Re-select the original, the way a user pressing the button again does.
      row.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return {
      source: { id: source.id, x: Number(source.pos.x.toFixed(1)), z: Number(source.pos.z.toFixed(1)) },
      plateCentre: api.platePos(0),
      enginePlacement,
      shellPlacement,
    };
  }, { shadowQuerySource: SHADOW_QUERY, copies: 10 });

  // Slicing must still work: the kernel is deferred, not removed.
  await page.evaluate(({ shadowQuerySource }) => {
    const findShadow = new Function(`${shadowQuerySource}; return findShadow;`)();
    findShadow(document, '[data-testid="slice-btn"]')?.click();
  }, { shadowQuerySource: SHADOW_QUERY });
  await page.waitForTimeout(20_000);
  const afterSlice = await page.evaluate(() => ({
    workersConstructed: window.__levoWorkers.length,
    workerUrls: window.__levoWorkers.map((url) => url.split("/").pop()),
    sliceWorkerAlive: Boolean(window.__vpWorker),
  }));
  await context.close();

  return { atLoad, afterImport, duplicate, afterSlice, engineLog };
}

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const desktop = await measurePageLoad(browser, "desktop — the behaviour Studio has always had", DESKTOP_UA, { width: 1440, height: 900 });
const phone = await measurePageLoad(browser, "phone — the deferred path", PHONE_UA, { width: 390, height: 844 });
const editor = await measureSliceOnDemandAndDuplicate(browser);
await browser.close();

function placementSummary(positions, source, plateCentre) {
  const offBed = positions.filter((p) =>
    Math.abs(p.x - plateCentre.x) > HALF_USABLE || Math.abs(p.z - plateCentre.z) > HALF_USABLE).length;
  const furthest = Math.max(...positions.map((p) => Math.hypot(p.x - source.x, p.z - source.z)));
  return { copies: positions.length, offBed, furthestFromSourceMm: Number(furthest.toFixed(1)), positions: positions.map((p) => [p.x, p.z]) };
}

const duplicateReport = editor.duplicate.error ? editor.duplicate : {
  source: editor.duplicate.source,
  plateCentre: editor.duplicate.plateCentre,
  before: placementSummary(editor.duplicate.enginePlacement, editor.duplicate.source, editor.duplicate.plateCentre),
  after: placementSummary(editor.duplicate.shellPlacement, editor.duplicate.source, editor.duplicate.plateCentre),
};

const report = {
  kind: "levo-studio-browser-editor",
  version: 1,
  generatedAt: new Date().toISOString(),
  target,
  pageLoad: { desktop, phone },
  sliceOnDemand: {
    workersAtPageLoad: editor.atLoad.workersConstructed,
    sliceWorkerAtPageLoad: editor.atLoad.sliceWorkerAlive,
    workersAfterImport: editor.afterImport.workersConstructed,
    objectsAfterImport: editor.afterImport.objects,
    workersAfterSlice: editor.afterSlice.workersConstructed,
    sliceWorkerAfterSlice: editor.afterSlice.sliceWorkerAlive,
    engineLog: editor.engineLog,
  },
  duplicatePlacement: duplicateReport,
};

const mb = (kb) => `${(kb / 1024).toFixed(1)} MB`;
console.log(`LEVO Studio in a real browser — ${target}`);
console.log("");
console.log("  Page load");
for (const row of [desktop, phone]) {
  console.log(`    ${row.label}`);
  console.log(`      workers at load : ${row.workersConstructed} (${row.workerUrls.join(", ") || "none"})`);
  console.log(`      slice worker up : ${row.sliceWorkerAlive}`);
  console.log(`      isolated        : ${row.crossOriginIsolated}`);
  console.log(`      interactive     : ${row.interactiveMs === null ? "not reached" : `${row.interactiveMs} ms`}`);
  console.log(`      renderer RSS    : +${mb(row.rendererRssDeltaKb)}`);
  console.log(`      release hook    : ${row.releaseHookPresent}`);
}
console.log("");
console.log("  Deferred, not disabled (phone path)");
console.log(`    workers at load / after import / after slice : ${report.sliceOnDemand.workersAtPageLoad} / ${report.sliceOnDemand.workersAfterImport} / ${report.sliceOnDemand.workersAfterSlice}`);
console.log(`    engine said: ${editor.engineLog.join(" | ") || "(nothing)"}`);
console.log("");
console.log("  Duplicate placement, 10 copies");
if (duplicateReport.error) {
  console.log(`    not measured: ${duplicateReport.error}`);
} else {
  console.log(`    source at ${JSON.stringify(duplicateReport.source)}, plate centre ${JSON.stringify(duplicateReport.plateCentre)}`);
  console.log(`    BEFORE (engine cursor) : ${duplicateReport.before.offBed}/10 off the bed, furthest ${duplicateReport.before.furthestFromSourceMm} mm`);
  console.log(`      ${JSON.stringify(duplicateReport.before.positions)}`);
  console.log(`    AFTER  (shell seating) : ${duplicateReport.after.offBed}/10 off the bed, furthest ${duplicateReport.after.furthestFromSourceMm} mm`);
  console.log(`      ${JSON.stringify(duplicateReport.after.positions)}`);
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(`\nReport written: ${relative(process.cwd(), REPORT_PATH)}`);
