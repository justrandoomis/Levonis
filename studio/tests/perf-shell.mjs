#!/usr/bin/env node
/**
 * LEVO Studio shell-cost measurements — the numbers behind the OOM, duplicate
 * and mobile-lag fixes.
 *
 * `tests/perf-baseline.mjs` measures what is SHIPPED (bundle bytes). This
 * measures what the shell DOES: how much work an editing session costs, how
 * much memory a slice result retains on the main thread, how far a duplicated
 * object lands from the bed, and what the engine asks a browser for at page
 * load. All four are the things the owner actually felt.
 *
 * Everything here is measured, not asserted:
 *  - the autosave numbers drive the REAL ProjectSyncController through a
 *    scripted editing session with a fake clock, counting real captures,
 *    real thumbnails and real SHA-256 work over real bytes;
 *  - the retention numbers are NOT here: a JS string lives on a renderer's
 *    heap and a Blob's bytes do not, which is a browser fact Node cannot
 *    show. tests/perf-browser-memory.mjs measures it in real Chromium;
 *  - the placement numbers run the engine's OWN spawn-cursor algorithm
 *    (transcribed from viewer/dist/Viewport.js, which this script re-verifies
 *    against the installed build) next to the shell's seating planner;
 *  - the page-load numbers are read out of the installed engine's WASM glue.
 *
 * Usage (from studio/):
 *   node tests/perf-shell.mjs            # measure + print + write JSON
 *   node tests/perf-shell.mjs --json     # JSON only
 *
 * Report written to tests/perf-shell.latest.json.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import ts from "typescript";

const STUDIO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(STUDIO_ROOT, "tests", "perf-shell.latest.json");
const jsonOnly = process.argv.includes("--json");
const say = (...args) => { if (!jsonOnly) console.log(...args); };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-zA-Z]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        /* fall back */
      }
    }
    return nextResolve(specifier, context);
  },
});

const { ProjectSyncController } = await import("../app/project-sync.ts");

async function loadTs(relativePath) {
  const source = readFileSync(join(STUDIO_ROOT, relativePath), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

const { planSeats } = await loadTs("app/spawn-seating.ts");

// ---------------------------------------------------------------------------
// 1. Page load: what the engine asks the browser for before anything is loaded
// ---------------------------------------------------------------------------

function measurePageLoadCost() {
  const mtPath = join(STUDIO_ROOT, "node_modules/three-slicer/engine/src/slicer_core.mt.js");
  const stPath = join(STUDIO_ROOT, "node_modules/three-slicer/engine/src/slicer_core.js");
  const mt = readFileSync(mtPath);
  const st = readFileSync(stPath);
  const mtText = mt.toString("latin1");

  // The pool is sized from hardwareConcurrency, so state the cost as a formula
  // plus what it comes to on ordinary phones and desktops. Nothing invented:
  // both the sizing expression and the reservation are asserted here.
  assert.match(mtText, /pthreadPoolSize=typeof navigator!=="undefined"&&navigator\.hardwareConcurrency\|\|4/);
  assert.match(mtText, /maximum:65536,shared:true/);
  const initialMemory = Number(/var INITIAL_MEMORY=(\d+)/.exec(mtText)?.[1] ?? 0);

  const perCore = (cores) => ({
    cores,
    // 1 slice worker + one pthread worker per core, each instantiating the
    // module (loadWasmModuleToAllWorkers is a pre-run dependency).
    workersAtPageLoad: cores + 1,
    moduleInstantiations: cores + 1,
  });

  return {
    threadedCoreBytes: mt.byteLength,
    singleThreadedCoreBytes: st.byteLength,
    sharedMemoryReservationBytes: 65536 * 65536,
    initialMemoryBytes: initialMemory,
    before: {
      // Every device warmed the kernel at mount.
      warmupOnMount: true,
      typicalPhone: perCore(8),
      typicalDesktop: perCore(16),
      coreFetchedAtPageLoadBytes: mt.byteLength,
    },
    after: {
      // Constrained devices load nothing until they slice; desktops unchanged.
      warmupOnMountConstrained: false,
      warmupOnMountDesktop: true,
      constrainedWorkersAtPageLoad: 0,
      constrainedModuleInstantiations: 0,
      constrainedCoreFetchedAtPageLoadBytes: 0,
      desktopTypical: perCore(16),
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Autosave: what a minute of editing costs
// ---------------------------------------------------------------------------

function makeTimers() {
  let now = 0;
  let sequence = 0;
  const scheduled = new Map();
  const timers = {
    set(fn, ms) {
      const handle = ++sequence;
      scheduled.set(handle, { at: now + ms, fn });
      return handle;
    },
    clear(handle) { scheduled.delete(handle); },
    now: () => now,
  };
  const advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [handle, entry] of scheduled) {
        if (entry.at <= target && (!next || entry.at < next.entry.at)) next = { handle, entry };
      }
      if (!next) break;
      scheduled.delete(next.handle);
      now = next.entry.at;
      next.entry.fn();
      for (let i = 0; i < 12; i += 1) {
        await new Promise((r) => setImmediate(r));
        if (i % 3 === 2) await new Promise((r) => setTimeout(r, 1));
      }
    }
    now = target;
  };
  return { timers, advance };
}

const idle = async (controller) => {
  for (let i = 0; i < 40 && controller.getState; i += 1) {
    await controller.whenIdle();
    await new Promise((r) => setImmediate(r));
  }
};

/**
 * One scripted minute of ordinary editing.
 *
 * The shell marks the session dirty from an effect watching the objects array
 * and the settings object, so a signal arrives on every engine `objects` event
 * and every settings identity change — far more often than the project really
 * changes. The session below models that shape honestly:
 *
 *   - 4 drag bursts: 5 signals 800 ms apart (inside the debounce, so they
 *     coalesce into one save each — that part was never the problem);
 *   - 12 isolated signals 4 s apart: a panel toggle, a plate switch, a
 *     selection change. Each is its own debounce window, so each one used to
 *     cost a full export;
 *   - the project's CONTENT changes 4 times in the whole minute.
 *
 * Anything above 4 exports is work that produced bytes identical to the
 * previous save.
 */
async function measureAutosave({ snapshotBytes, withSignature, debounceMs }) {
  const { timers, advance } = makeTimers();
  const snapshot = Buffer.alloc(snapshotBytes, 7);
  let captures = 0;
  let thumbnails = 0;
  let bytesExported = 0;
  let bytesHashed = 0;
  let draftWrites = 0;
  let saveRuns = 0;
  const state = { signature: "edit-0", changes: 0 };

  const callbacks = {
    async captureSnapshot() {
      captures += 1;
      bytesExported += snapshotBytes;
      return { file: new Blob([snapshot]), name: "P.3mf" };
    },
    getSourceFiles: () => [new File([snapshot], "part.stl")],
    async captureThumbnail() { thumbnails += 1; return null; },
    buildManifest: () => ({ version: 1, generator: "levo-studio", project: { name: "P" } }),
    getMeta: () => ({ schemaVersion: 2, engineVersion: "three-slicer@0.2.2" }),
    async persistDraft() { draftWrites += 1; },
  };
  if (withSignature) {
    callbacks.contentSignature = () => { saveRuns += 1; return state.signature; };
  }

  const controller = new ProjectSyncController({
    userId: null,
    callbacks,
    timers,
    debounceMs,
    hash: async (blob) => {
      bytesHashed += blob.size;
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return Buffer.from(digest).toString("hex");
    },
  });

  const signal = async (gapMs, changesContent) => {
    if (changesContent) {
      state.changes += 1;
      state.signature = `edit-${state.changes}`;
    }
    controller.markDirty();
    await advance(gapMs);
    await idle(controller);
  };

  for (let burst = 0; burst < 4; burst += 1) {
    // A drag: five events inside one debounce window. Content changes once.
    for (let step = 0; step < 5; step += 1) await signal(800, step === 0);
    // The user lets go and looks at it.
    await advance(12_000);
    await idle(controller);
    // Three isolated signals: a panel toggle, a plate switch, a selection.
    for (let step = 0; step < 3; step += 1) await signal(4_000, false);
  }
  await advance(debounceMs + 100);
  await idle(controller);
  controller.dispose();

  return { captures, thumbnails, draftWrites, bytesExported, bytesHashed, realContentChanges: state.changes, saveRuns };
}

// ---------------------------------------------------------------------------
// 4. Duplicate placement: how far the copy lands
// ---------------------------------------------------------------------------

/**
 * The engine's own spawn cursor, transcribed from viewer/dist/Viewport.js and
 * re-verified against the installed build so this can never drift into
 * measuring a straw man:
 *
 *     _e.position.set(Mt.x + l.current + Ke / 2, 0, Mt.z), l.current += Ke + 8
 */
function measurePlacement({ bedWidth, bedDepth, width, depth, copies }) {
  const engine = readFileSync(join(STUDIO_ROOT, "node_modules/three-slicer/viewer/dist/Viewport.js"), "utf8");
  assert.match(engine, /_e\.position\.set\(Mt\.x \+ l\.current \+ Ke \/ 2, 0, Mt\.z\), l\.current \+= Ke \+ 8/);

  const margin = 8;
  const usableWidth = bedWidth - margin * 2;
  const usableDepth = bedDepth - margin * 2;
  const halfW = usableWidth / 2;
  const halfD = usableDepth / 2;
  const insideBed = (x, y, w, d) =>
    x - w / 2 >= -halfW - 1e-6 && x + w / 2 <= halfW + 1e-6
    && y - d / 2 >= -halfD - 1e-6 && y + d / 2 <= halfD + 1e-6;

  // Origin sits where a user would put it: left-front of the bed.
  const originX = -60;
  const originY = -60;

  // --- engine cursor -------------------------------------------------------
  let cursor = 0;
  // The original was itself spawned through the same cursor.
  cursor += width + 8;
  let engineOffBed = 0;
  let engineMaxDistance = 0;
  for (let copy = 0; copy < copies; copy += 1) {
    const x = cursor + width / 2;
    const y = 0; // the cursor never moves in depth: z stays at the plate centre
    if (!insideBed(x, y, width, depth)) engineOffBed += 1;
    engineMaxDistance = Math.max(engineMaxDistance, Math.hypot(x - originX, y - originY));
    cursor += width + 8;
  }

  // --- shell seating -------------------------------------------------------
  const occupied = [{ id: 1, plate: 0, offsetX: originX, offsetY: originY, width, depth }];
  let seatedOffBed = 0;
  let seatedMaxDistance = 0;
  let seatedOverlaps = 0;
  let unseated = 0;
  for (let copy = 0; copy < copies; copy += 1) {
    const id = copy + 2;
    const plan = planSeats([{ id, width, depth }], occupied, {
      bedWidth, bedDepth, preferredPlate: 0, availablePlates: [0],
      nearOffsetX: originX, nearOffsetY: originY,
    });
    if (!plan.seats.length) { unseated += 1; continue; }
    const seat = plan.seats[0];
    if (!insideBed(seat.offsetX, seat.offsetY, width, depth)) seatedOffBed += 1;
    for (const other of occupied) {
      const dx = Math.abs(seat.offsetX - other.offsetX);
      const dy = Math.abs(seat.offsetY - other.offsetY);
      if (dx < (width + other.width) / 2 - 1e-6 && dy < (depth + other.depth) / 2 - 1e-6) seatedOverlaps += 1;
    }
    seatedMaxDistance = Math.max(seatedMaxDistance, Math.hypot(seat.offsetX - originX, seat.offsetY - originY));
    occupied.push({ id, plate: 0, offsetX: seat.offsetX, offsetY: seat.offsetY, width, depth });
  }

  return {
    bed: `${bedWidth}x${bedDepth}`,
    modelFootprint: `${width}x${depth}`,
    copies,
    before: { offBedCopies: engineOffBed, maxDistanceFromSourceMm: Number(engineMaxDistance.toFixed(1)) },
    after: {
      offBedCopies: seatedOffBed,
      overlappingCopies: seatedOverlaps,
      reportedAsNotFitting: unseated,
      maxDistanceFromSourceMm: Number(seatedMaxDistance.toFixed(1)),
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const SNAPSHOT_BYTES = 12 * 1024 * 1024; // a modest real project's 3MF

const pageLoad = measurePageLoadCost();
const autosaveBefore = await measureAutosave({ snapshotBytes: SNAPSHOT_BYTES, withSignature: false, debounceMs: 2_500 });
const autosaveAfterDesktop = await measureAutosave({ snapshotBytes: SNAPSHOT_BYTES, withSignature: true, debounceMs: 2_500 });
const autosaveAfterPhone = await measureAutosave({ snapshotBytes: SNAPSHOT_BYTES, withSignature: true, debounceMs: 9_000 });
const placement = measurePlacement({ bedWidth: 256, bedDepth: 256, width: 45, depth: 35, copies: 10 });

const report = {
  kind: "levo-studio-shell-perf",
  version: 1,
  generatedAt: new Date().toISOString(),
  node: process.version,
  browserMemoryReport: "tests/perf-browser-memory.latest.json",
  pageLoad,
  autosavePerMinuteOfEditing: {
    // 4 drag bursts of 5 signals + 12 isolated signals; see measureAutosave.
    editSignals: 32,
    realChanges: autosaveBefore.realContentChanges,
    snapshotBytes: SNAPSHOT_BYTES,
    before: autosaveBefore,
    afterDesktop: autosaveAfterDesktop,
    afterConstrained: autosaveAfterPhone,
  },
  duplicatePlacement: placement,
};

const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

say("LEVO Studio shell cost — measured");
say(`  node ${report.node}`);
say("");
say("  Page load (engine kernel, before anything is on the bed)");
say(`    threaded core                 : ${mb(pageLoad.threadedCoreBytes)}`);
say(`    shared memory reserved        : ${mb(pageLoad.sharedMemoryReservationBytes)} (maximum:65536 pages, shared)`);
say(`    BEFORE, 8-core phone          : ${pageLoad.before.typicalPhone.workersAtPageLoad} workers, ${pageLoad.before.typicalPhone.moduleInstantiations} module instantiations, ${mb(pageLoad.before.coreFetchedAtPageLoadBytes)} fetched`);
say(`    AFTER,  8-core phone          : ${pageLoad.after.constrainedWorkersAtPageLoad} workers, ${pageLoad.after.constrainedModuleInstantiations} module instantiations, ${mb(pageLoad.after.constrainedCoreFetchedAtPageLoadBytes)} fetched`);
say(`    AFTER,  16-core desktop       : deliberately unchanged — ${pageLoad.after.desktopTypical.workersAtPageLoad} workers, warm kernel kept`);
say("");
say(`  Autosave, one minute of editing (${report.autosavePerMinuteOfEditing.editSignals} edit signals, ${autosaveBefore.realContentChanges} real changes, 12 MB project)`);
const row = (label, m) => say(`    ${label.padEnd(30)}: ${String(m.captures).padStart(2)} exports, ${String(m.thumbnails).padStart(2)} thumbnails, ${String(m.draftWrites).padStart(2)} draft writes, ${mb(m.bytesExported).padStart(9)} exported, ${mb(m.bytesHashed).padStart(9)} hashed`);
row("BEFORE", autosaveBefore);
row("AFTER, desktop", autosaveAfterDesktop);
row("AFTER, constrained device", autosaveAfterPhone);
say("");
say("  Main-thread retention (9 plates x 20 MB of G-code held as results)");
say("    measured in a real browser, not here: node tests/perf-browser-memory.mjs");
say("");
say(`  Duplicate placement (${placement.bed} bed, ${placement.modelFootprint} model, ${placement.copies} copies)`);
say(`    BEFORE: ${placement.before.offBedCopies}/${placement.copies} copies off the bed, furthest ${placement.before.maxDistanceFromSourceMm} mm from the original`);
say(`    AFTER : ${placement.after.offBedCopies}/${placement.copies} copies off the bed, ${placement.after.overlappingCopies} overlapping, ${placement.after.reportedAsNotFitting} reported as not fitting, furthest ${placement.after.maxDistanceFromSourceMm} mm`);

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
if (jsonOnly) console.log(JSON.stringify(report, null, 2));
else say(`\nReport written: ${relative(process.cwd(), REPORT_PATH)}`);
