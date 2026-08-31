#!/usr/bin/env node
/**
 * What a stored slice result costs the browser — measured in a real browser.
 *
 * WHY THIS IS A SEPARATE SCRIPT. The claim behind the G-code change in
 * app/hooks/use-slicing-state.ts is a browser claim: a JS string lives on the
 * renderer's heap, a Blob's bytes do not. Node cannot show that (it has no
 * renderer and no blob storage), so this drives a real Chromium and reads the
 * operating system's own accounting of the processes.
 *
 * It is NOT part of `npm test`: it needs a Chromium binary and playwright-core,
 * neither of which belongs in the app's dependencies for a measurement. Run it
 * by hand when the numbers need refreshing:
 *
 *   npm i --no-save playwright-core
 *   node tests/perf-browser-memory.mjs
 *   node tests/perf-browser-memory.mjs --chromium /path/to/chrome
 *
 * A note on the payload, because it is easy to measure nothing here: real
 * G-code is millions of DISTINCT lines. `line.repeat(n)` is not a model of it
 * — V8 can represent a repeat as a cons tree over one shared leaf, so the 20 MB
 * never exists and the measurement reads zero. The builder below emits
 * genuinely different coordinates per line and joins them into one flat string.
 *
 * Report written to tests/perf-browser-memory.latest.json.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "perf-browser-memory.latest.json");

const PLATES = 9;               // the engine's plate cap
const BYTES_PER_PLATE = 20 * 1024 * 1024;

function resolveChromium() {
  const flagIndex = process.argv.indexOf("--chromium");
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) return process.argv[flagIndex + 1];
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
  console.error("perf-browser-memory: playwright-core is not installed.");
  console.error("  npm i --no-save playwright-core");
  process.exit(2);
}

const executablePath = resolveChromium();
if (!executablePath || !existsSync(executablePath)) {
  console.error("perf-browser-memory: no Chromium binary found.");
  console.error("  node tests/perf-browser-memory.mjs --chromium /path/to/chrome");
  process.exit(2);
}

/** Per-process RSS of this Chromium, by process type, straight from /proc. */
function chromiumRssKb(marker) {
  const per = {};
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (!cmdline.includes(marker)) continue;
      const status = readFileSync(`/proc/${entry}/status`, "utf8");
      const rss = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0);
      const type = /--type=([a-z-]+)/.exec(cmdline)?.[1] ?? "browser";
      per[type] = (per[type] ?? 0) + rss;
    } catch {
      /* the process exited between readdir and read */
    }
  }
  return per;
}

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("about:blank");
const cdp = await page.context().newCDPSession(page);

const sample = async () => {
  for (let i = 0; i < 4; i += 1) {
    await cdp.send("HeapProfiler.collectGarbage");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return chromiumRssKb(executablePath);
};

await page.evaluate(({ plates, bytes }) => {
  window.__plates = plates;
  window.__held = [];
  window.__build = (plate) => {
    const lines = [];
    let size = 0;
    let index = 0;
    while (size < bytes) {
      const line = `G1 X${(10 + plate + index * 0.017).toFixed(3)} Y${(10 + index * 0.023).toFixed(3)} E${(index * 0.0011).toFixed(4)} F1800\n`;
      lines.push(line);
      size += line.length;
      index += 1;
    }
    return lines.join("");
  };
}, { plates: PLATES, bytes: BYTES_PER_PLATE });

const baseline = await sample();

// BEFORE: the shell kept the engine's G-code string, one per plate.
const charsHeld = await page.evaluate(() => {
  window.__held = [];
  for (let plate = 0; plate < window.__plates; plate += 1) window.__held.push(window.__build(plate));
  return window.__held.reduce((total, text) => total + text.length, 0);
});
const withStrings = await sample();

await page.evaluate(() => { window.__held = []; });
const dropped = await sample();

// AFTER: the shell keeps a Blob and lets the engine's string go, which is what
// handleSliced does in app/hooks/use-slicing-state.ts.
const blobBytesHeld = await page.evaluate(() => {
  window.__held = [];
  for (let plate = 0; plate < window.__plates; plate += 1) window.__held.push(new Blob([window.__build(plate)]));
  return window.__held.reduce((total, blob) => total + blob.size, 0);
});
const withBlobs = await sample();

const userAgent = await page.evaluate(() => navigator.userAgent);
await browser.close();

const rendererDeltaStrings = (withStrings.renderer ?? 0) - (baseline.renderer ?? 0);
const rendererDeltaBlobs = (withBlobs.renderer ?? 0) - (dropped.renderer ?? 0);
const browserDeltaBlobs = (withBlobs.browser ?? 0) - (dropped.browser ?? 0);

const report = {
  kind: "levo-studio-browser-memory",
  version: 1,
  generatedAt: new Date().toISOString(),
  method: "per-process VmRSS from /proc, sampled after CDP HeapProfiler.collectGarbage",
  userAgent,
  plates: PLATES,
  bytesPerPlate: BYTES_PER_PLATE,
  charsHeld,
  blobBytesHeld,
  samplesKb: { baseline, withStrings, dropped, withBlobs },
  rendererRssDeltaKb: { before: rendererDeltaStrings, after: rendererDeltaBlobs },
  browserProcessRssDeltaKb: { blobs: browserDeltaBlobs },
};

const mb = (kb) => `${(kb / 1024).toFixed(1)} MB`;
console.log(`Stored slice results, ${PLATES} plates x ${mb(BYTES_PER_PLATE / 1024)} of G-code`);
console.log(`  ${userAgent}`);
console.log("");
console.log(`  BEFORE — held as JS strings : renderer RSS +${mb(rendererDeltaStrings)}`);
console.log(`  AFTER  — held as Blobs      : renderer RSS +${mb(rendererDeltaBlobs)}`);
console.log(`  the same bytes, relocated   : browser-process RSS +${mb(browserDeltaBlobs)} (blob storage, spillable to disk)`);
console.log("");
console.log("  The renderer is where the tab's JS heap and the slice worker compete for");
console.log("  one budget, which is the budget the OOM message comes from.");

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(`\nReport written: ${relative(process.cwd(), REPORT_PATH)}`);
