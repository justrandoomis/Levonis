#!/usr/bin/env node
/**
 * LEVO Studio performance baseline (T16 — docs/STUDIO_PLAN.md slice S8).
 *
 * A SCRIPTED, repeatable measurement of what CAN be measured from a build
 * output, plus an explicit notes template for what CANNOT (runtime metrics
 * need a real browser on a named device — this script never invents them).
 *
 * Usage (run by the verify agent, from studio/):
 *
 *   npm run build                      # or: bash scripts/build-verified.sh
 *   node tests/perf-baseline.mjs                       # measure + write JSON
 *   node tests/perf-baseline.mjs <old-report.json>     # …and diff against a
 *                                                      #    previous baseline
 *
 * What it measures (statically, honestly):
 *   - every file in dist/client: raw size and gzip size (node:zlib, level 9),
 *   - totals and per-type groups (js / wasm / css / html / images / other),
 *   - the 15 largest assets (the slicer WASM cores should dominate),
 *   - environment provenance: node version, git commit, three-slicer version.
 *
 * What it does NOT measure (fill the notes template in a real browser):
 *   time-to-interactive, WASM/engine init, model import (small/medium/large),
 *   slice + cancel latency, memory. Mandate §10 requires those before/after
 *   on the SAME device, browser, files, and cold/warm cache state.
 *
 * The JSON report is written next to this script as
 * tests/perf-baseline.latest.json — commit it (renamed, e.g. with a date)
 * when it becomes an official "before" or "after" point for T16.
 *
 * Exit codes: 0 = report produced; 2 = dist/client missing (build first).
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_CLIENT = join(STUDIO_ROOT, "dist", "client");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "perf-baseline.latest.json");

// --------------------------------------------------------------------------
// Collect
// --------------------------------------------------------------------------

if (!existsSync(DIST_CLIENT)) {
  console.error(`perf-baseline: ${relative(process.cwd(), DIST_CLIENT)} does not exist.`);
  console.error("Build first (from studio/): npm run build");
  console.error("No numbers are invented for a build that has not happened.");
  process.exit(2);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const TYPE_BY_EXT = {
  ".js": "js", ".mjs": "js", ".cjs": "js",
  ".wasm": "wasm",
  ".css": "css",
  ".html": "html",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".svg": "image", ".ico": "image", ".gif": "image",
  ".woff": "font", ".woff2": "font", ".ttf": "font",
  ".map": "sourcemap",
  ".json": "json", ".webmanifest": "json",
};

const files = walk(DIST_CLIENT).map((full) => {
  const buf = readFileSync(full);
  return {
    path: relative(DIST_CLIENT, full).split("\\").join("/"),
    type: TYPE_BY_EXT[extname(full).toLowerCase()] || "other",
    bytes: buf.byteLength,
    gzipBytes: gzipSync(buf, { level: 9 }).byteLength,
  };
});
files.sort((a, b) => b.gzipBytes - a.gzipBytes);

const groups = {};
for (const f of files) {
  const g = (groups[f.type] ||= { files: 0, bytes: 0, gzipBytes: 0 });
  g.files += 1;
  g.bytes += f.bytes;
  g.gzipBytes += f.gzipBytes;
}
const totals = {
  files: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0),
  gzipBytes: files.reduce((n, f) => n + f.gzipBytes, 0),
};

// Provenance -----------------------------------------------------------------

function tryGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: STUDIO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function tryEngineVersion() {
  try {
    const require = createRequire(join(STUDIO_ROOT, "package.json"));
    return require("three-slicer/package.json").version;
  } catch {
    try {
      // Fallback: the lockfile pin (node_modules may be absent in CI stages).
      const lock = JSON.parse(readFileSync(join(STUDIO_ROOT, "package-lock.json"), "utf8"));
      return lock.packages?.["node_modules/three-slicer"]?.version ?? null;
    } catch {
      return null;
    }
  }
}

const report = {
  kind: "levo-studio-perf-baseline",
  version: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  gitCommit: tryGitCommit(),
  threeSlicerVersion: tryEngineVersion(),
  distClient: relative(STUDIO_ROOT, DIST_CLIENT),
  totals,
  groups,
  largest: files.slice(0, 15),
  // Runtime metrics are intentionally null: this script cannot measure them.
  // Copy the printed notes template, measure in a real browser, and attach.
  runtime: null,
};

// --------------------------------------------------------------------------
// Print
// --------------------------------------------------------------------------

const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

console.log("LEVO Studio bundle baseline (static, from dist/client)");
console.log(`  generated : ${report.generatedAt}`);
console.log(`  node      : ${report.node}   commit: ${report.gitCommit ?? "unknown"}`);
console.log(`  engine    : three-slicer ${report.threeSlicerVersion ?? "version unknown"}`);
console.log("");
console.log("  Per-type totals (raw / gzip):");
for (const [type, g] of Object.entries(groups).sort((a, b) => b[1].gzipBytes - a[1].gzipBytes)) {
  console.log(`    ${type.padEnd(10)} ${String(g.files).padStart(4)} files  ${kb(g.bytes).padStart(12)} / ${kb(g.gzipBytes)}`);
}
console.log(`    ${"TOTAL".padEnd(10)} ${String(totals.files).padStart(4)} files  ${kb(totals.bytes).padStart(12)} / ${kb(totals.gzipBytes)}`);
console.log("");
console.log("  15 largest assets (gzip):");
for (const f of report.largest) {
  console.log(`    ${kb(f.gzipBytes).padStart(11)}  ${f.path}`);
}

// Optional diff against a previous baseline ----------------------------------

const previousPath = process.argv[2];
if (previousPath) {
  const prev = JSON.parse(readFileSync(resolve(previousPath), "utf8"));
  if (prev.kind !== "levo-studio-perf-baseline") {
    console.error(`\nperf-baseline: ${previousPath} is not a perf-baseline report — no diff.`);
  } else {
    const delta = totals.gzipBytes - prev.totals.gzipBytes;
    const sign = delta >= 0 ? "+" : "";
    console.log("");
    console.log(`  Diff vs ${previousPath} (${prev.generatedAt}):`);
    console.log(`    total gzip: ${kb(prev.totals.gzipBytes)} -> ${kb(totals.gzipBytes)}  (${sign}${kb(delta)})`);
    const prevByPath = new Map((prev.largest ?? []).map((f) => [f.path, f]));
    for (const f of report.largest) {
      const p = prevByPath.get(f.path);
      if (p && p.gzipBytes !== f.gzipBytes) {
        const d = f.gzipBytes - p.gzipBytes;
        console.log(`    ${d >= 0 ? "+" : ""}${kb(d).padStart(10)}  ${f.path}`);
      }
    }
  }
}

// Notes template for the measurements this script cannot take ----------------

console.log(`
  Runtime notes template (T16 — fill by hand in a REAL browser; this script
  measures none of these and reports none of them as facts):

    device / browser / cache : e.g. iPad (model), Safari 18, cold|warm
    URL                      : staging or production HTTPS origin
    crossOriginIsolated      : true|false (from the console)
    page load -> interactive : ___ ms
    engine + WASM init       : ___ ms
    import small (~1 MB)     : ___ ms   file: ______
    import medium (~20 MB)   : ___ ms   file: ______
    import large  (~80 MB)   : ___ ms   file: ______
    slice (fixture, preset)  : ___ s    fixture: tests/fixtures/______
    cancel mid-slice         : ___ ms until UI is consistent
    memory after open/close  : ___ MB (repeat 5x — look for growth)

  Use the SAME fixtures, device, and cache state for every before/after pair.
`);

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
console.log(`Report written: ${relative(process.cwd(), REPORT_PATH)}`);
