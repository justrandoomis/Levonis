#!/usr/bin/env node
/**
 * THE 6 MB KERNEL STILL BOOTS — AND THERE IS ONLY ONE OF IT NOW.
 *
 * WHY THIS IS A BROWSER SCRIPT AND NOT A UNIT TEST. `vite.config.ts` rewrites
 * two expressions inside three-slicer's threaded kernel: the URL it spawns its
 * pthread pool from, and the `maximum` of the shared WebAssembly.Memory it
 * reserves. Both are claims about what a BROWSER does with the built bundle.
 * Reading the emitted file proves the text changed; it does not prove the
 * kernel still starts, and a kernel that does not start is Studio not working
 * at all for everybody, not just on phones.
 *
 * So this drives a real Chromium against the real `dist/`, over a server that
 * sends COOP/COEP the way `worker/platform.ts` does — because without those
 * `crossOriginIsolated` is false, the engine silently takes the SINGLE-threaded
 * core, and the whole run would pass while testing nothing.
 *
 * It is not part of `npm test`: it needs a Chromium binary and playwright, and
 * a 6 MB WASM compile is not something to put in every unit run. Run it after
 * a build, and after ANY change to the kernel transform:
 *
 *   npm run build && node tests/browser-kernel-boot.mjs
 *
 * Report written to tests/browser-kernel-boot.latest.json.
 */
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT_DIR = join(STUDIO_ROOT, "dist", "client");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "browser-kernel-boot.latest.json");

if (!existsSync(CLIENT_DIR)) {
  console.error("kernel-boot: dist/client is missing. Run `npm run build` first.");
  process.exit(69);
}

function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if (!existsSync(root)) return null;
  if (existsSync(join(root, "chromium"))) return join(root, "chromium");
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith("chromium")) continue;
    for (const c of ["chrome-linux/chrome", "chrome-linux/headless_shell", "chrome"]) {
      const full = join(root, entry, c);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

const require = createRequire(import.meta.url);
let chromium;
for (const spec of ["playwright-core", "playwright", "/opt/node22/lib/node_modules/playwright/index.js"]) {
  try { ({ chromium } = require(spec)); if (chromium) break; } catch { /* next */ }
}
if (!chromium) {
  console.error("kernel-boot: no playwright available.\n  npm i --no-save playwright-core");
  process.exit(69);
}

const assets = readdirSync(join(CLIENT_DIR, "assets"));
const sliceWorker = assets.find((f) => /^slicer\.worker-.*\.js$/.test(f));
const kernels = assets.filter((f) => /^slicer_core\.mt-.*\.js$/.test(f));
if (!sliceWorker) {
  console.error("kernel-boot: no slicer.worker-*.js in dist/client/assets.");
  process.exit(1);
}

const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };

/**
 * COOP/COEP on every response. `crossOriginIsolated` is the single signal the
 * engine picks its core on, so serving without these would quietly test the
 * single-threaded build — which has none of the behaviour this script is for.
 */
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url || "/").split("?")[0]);
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (path === "/") {
    res.setHeader("Content-Type", "text/html");
    res.end("<!doctype html><meta charset=utf-8><title>kernel boot</title>");
    return;
  }
  const file = join(CLIENT_DIR, path.replace(/^\/+/, ""));
  if (!file.startsWith(CLIENT_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const fail = (m) => { failures += 1; console.log(`  FAIL ${m}`); };
const ok = (m) => console.log(`  ok   ${m}`);

const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
const report = { origin, sliceWorker, kernelsInBuild: kernels };

try {
  // A phone user agent, so the pool cap and the 1 GiB heap ceiling are the
  // branches actually exercised — the ones the owner's device takes.
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();

  const requested = [];
  page.on("request", (r) => requested.push(r.url()));
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(m.text()));

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });

  const isolated = await page.evaluate(() => crossOriginIsolated);
  if (isolated) ok("crossOriginIsolated — the THREADED kernel is the one under test");
  else fail("not crossOriginIsolated: this would silently test the single-threaded core");
  report.crossOriginIsolated = isolated;

  // Boot the kernel exactly as the app does: the built slice worker, warmed up.
  const boot = await page.evaluate(async (workerFile) => {
    const started = performance.now();
    const worker = new Worker(`/assets/${workerFile}`, { type: "module" });
    const outcome = await new Promise((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise({ ok: false, why: "timed out after 120s" }), 120_000);
      worker.onmessage = (event) => {
        if (event.data?.type === "warm") {
          clearTimeout(timer);
          resolvePromise({ ok: true });
        } else if (event.data?.type === "error") {
          clearTimeout(timer);
          resolvePromise({ ok: false, why: String(event.data.error ?? "worker reported an error") });
        }
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        resolvePromise({ ok: false, why: event.message || "worker error" });
      };
      worker.postMessage({ cmd: "warmup" });
    });
    worker.terminate();
    return { ...outcome, ms: Math.round(performance.now() - started) };
  }, sliceWorker);

  report.boot = boot;
  if (boot.ok) ok(`the kernel compiled and reported ready in ${boot.ms} ms`);
  else fail(`the kernel did not boot: ${boot.why}`);

  // THE POINT OF THE TRANSFORM: one kernel URL, fetched once, for the slice
  // worker AND every pthread in its pool.
  const kernelUrls = [...new Set(requested.filter((u) => /slicer_core\.mt-.*\.js$/.test(u)))];
  report.kernelUrlsFetched = kernelUrls;
  if (kernelUrls.length === 1) ok(`one kernel URL served the worker and its pool: ${kernelUrls[0].split("/").pop()}`);
  else fail(`${kernelUrls.length} distinct kernel URLs were fetched: ${kernelUrls.map((u) => u.split("/").pop()).join(", ")}`);

  if (kernels.length === 1) ok("dist/client/assets carries exactly one copy of the threaded kernel");
  else fail(`dist/client/assets carries ${kernels.length} copies: ${kernels.join(", ")}`);

  // The pool cap is the other half of the handheld story and rides the same
  // boot, so a regression in either shows up here.
  const capped = consoleLines.find((line) => line.includes("pthread pool capped"));
  report.poolCapLine = capped ?? null;
  if (capped) ok(capped.trim());
  else fail("the pthread pool cap did not run — patches/three-slicer+0.2.2.patch may not be applied");

  await ctx.close();
} finally {
  await browser.close();
  server.close();
}

report.failures = failures;
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${failures ? `${failures} failure(s)` : "all checks passed"} — report: tests/browser-kernel-boot.latest.json`);
process.exit(failures ? 1 : 0);
