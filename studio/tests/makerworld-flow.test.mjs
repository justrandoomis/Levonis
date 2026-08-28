/**
 * MakerWorld flow tests (slice S7, T11/T12 groundwork).
 *
 * Behavioral tests of the export manager's four-step state machine
 * (app/export-manager.ts) with a fake engine port — deterministic, no browser:
 *
 * - the mandatory three-kind output classification never mislabels a file;
 * - preflight blockers stop preparation;
 * - the engine save path is verified structurally before "file ready";
 * - opening MakerWorld is a handoff, never an upload: the machine has NO
 *   "uploaded" state and `uploadConfirmed` is always false (T12);
 * - scene/settings invalidation discards prepared files (stale honesty);
 * - timeouts and engine failures fail loudly and retry cleanly.
 *
 * What is NOT tested here (and not claimed): a real MakerWorld upload — no
 * sanctioned third-party upload API exists; the external upload check remains
 * a consented manual step (see studio/BAMBU_PRINT_PIPELINE.md).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const fixturesUrl = new URL("./fixtures/", import.meta.url);

async function transpileToUrl(fileUrl, importMap = {}) {
  let source = await readFile(fileUrl, "utf8");
  for (const [specifier, url] of Object.entries(importMap)) {
    source = source.split(`"${specifier}"`).join(`"${url}"`);
  }
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
}

let modulesPromise = null;
function loadModules() {
  modulesPromise ??= (async () => {
    const preflightUrl = await transpileToUrl(new URL("../app/makerworld/preflight.ts", import.meta.url));
    const exportManagerUrl = await transpileToUrl(
      new URL("../app/export-manager.ts", import.meta.url),
      { "./makerworld/preflight": preflightUrl },
    );
    const [preflight, exportManager] = await Promise.all([import(preflightUrl), import(exportManagerUrl)]);
    return { preflight, exportManager };
  })();
  return modulesPromise;
}

const X2D_PROFILE = {
  id: "bbl-x2d-04",
  model: "Bambu Lab X2D",
  shortName: "X2D",
  nozzle: 0.4,
  bedWidthMm: 256,
  bedDepthMm: 256,
  bedHeightMm: 260,
};

const OK_INPUT = {
  objects: [{ id: 1, name: "cube", extruder: 1, visible: true, widthMm: 10, depthMm: 10, heightMm: 10 }],
  plateCount: 1,
  profile: X2D_PROFILE,
  profileVerified: true,
};

const BLOCKED_INPUT = {
  ...OK_INPUT,
  objects: [{ id: 1, name: "huge", extruder: 1, visible: true, widthMm: 500, depthMm: 500, heightMm: 500 }],
};

function makeDeps({ saveResult = true, saveTimeoutMs = 500 } = {}) {
  const calls = { downloads: [], opened: [], saveRequests: 0 };
  const deps = {
    engine: {
      requestSave: () => {
        calls.saveRequests += 1;
        return saveResult;
      },
    },
    download: (file) => calls.downloads.push(file),
    openExternal: (url) => calls.opened.push(url),
    saveTimeoutMs,
  };
  return { deps, calls };
}

function waitForPhase(manager, phase, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    if (manager.getState().phase === phase) return resolve(manager.getState());
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for phase "${phase}" (at "${manager.getState().phase}")`));
    }, timeoutMs);
    const unsubscribe = manager.subscribe(() => {
      if (manager.getState().phase === phase) {
        clearTimeout(timer);
        unsubscribe();
        resolve(manager.getState());
      }
    });
  });
}

async function valid3mfFile(name = "project.3mf") {
  const bytes = await readFile(new URL("mini-project.3mf", fixturesUrl));
  return new File([bytes], name, { type: "model/3mf" });
}

test("the state machine has no uploaded state and never confirms an upload", async () => {
  const { exportManager } = await loadModules();
  assert.ok(Array.isArray(exportManager.EXPORT_PHASES));
  for (const phase of exportManager.EXPORT_PHASES) {
    assert.ok(!phase.includes("upload"), `phase "${phase}" must not suggest an upload`);
  }
  const manager = exportManager.createMakerWorldExportManager(makeDeps().deps);
  assert.equal(manager.getState().phase, "idle");
  assert.equal(manager.getState().step, 1);
  assert.equal(manager.getState().uploadConfirmed, false);
});

test("EXPORT_KINDS keeps the mandatory three-kind distinction honest", async () => {
  const { exportManager } = await loadModules();
  const byKind = new Map(exportManager.EXPORT_KINDS.map((info) => [info.kind, info]));

  const project = byKind.get("editable-3mf");
  assert.equal(project.available, true);
  assert.equal(project.primary, true, "the editable 3MF project is the primary output");

  const profile = byKind.get("print-profile");
  assert.equal(profile.available, false, "no MakerWorld-accepted print profile can be produced");
  assert.equal(profile.reason, "makerworld-rejects-non-bambu-studio-profiles");

  const gcode = byKind.get("gcode");
  assert.equal(gcode.available, true);
  assert.equal(gcode.primary, false, "G-code is demoted to a secondary action");
  assert.equal(gcode.reason, "secondary-advanced-action");

  const pkg = byKind.get("gcode-3mf-package");
  assert.equal(pkg.available, false, ".gcode.3mf stays gated until golden fixtures pass");

  assert.equal(exportManager.EXPORT_KINDS.filter((info) => info.primary).length, 1);
});

test("filename classification never mislabels the three kinds", async () => {
  const { exportManager } = await loadModules();
  assert.equal(exportManager.classifyExportFilename("LEVO-X2D-plate-1.gcode.3mf"), "gcode-3mf-package");
  assert.equal(exportManager.classifyExportFilename("project.3mf"), "editable-3mf");
  assert.equal(exportManager.classifyExportFilename("Project.3MF"), "editable-3mf");
  assert.equal(exportManager.classifyExportFilename("plate_1.gcode"), "gcode");
  assert.equal(exportManager.classifyExportFilename("model.stl"), "unknown");
});

test("prepared filenames are clear and sanitized", async () => {
  const { exportManager } = await loadModules();
  assert.equal(exportManager.makerWorld3mfFilename("My Project??", "X2D"), "LEVO-My-Project-X2D.3mf");
  assert.equal(exportManager.makerWorld3mfFilename("", "X2D"), "LEVO-Project-X2D.3mf");
  assert.equal(exportManager.makerWorld3mfFilename("مشروع جديد", "X2D"), "LEVO-مشروع-جديد-X2D.3mf");
  assert.equal(exportManager.gcodeFilename("X2D", 0), "LEVO-X2D-plate-1.gcode");
});

test("a blocked preflight stops the flow before any engine call", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  const report = manager.runCheck(BLOCKED_INPUT);
  assert.equal(report.ok, false);
  assert.equal(manager.getState().phase, "blocked");
  assert.equal(manager.getState().step, 1);

  assert.equal(manager.prepare(), false, "prepare must refuse after a blocked check");
  assert.equal(manager.getState().phase, "blocked");
  assert.equal(calls.saveRequests, 0);
  assert.equal(calls.downloads.length, 0);
});

test("happy path: check → prepare → verified file → summary → handoff (never an upload)", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  const report = manager.runCheck(OK_INPUT);
  assert.equal(report.ok, true);
  assert.equal(manager.getState().phase, "checked");
  assert.equal(manager.getState().step, 2);

  assert.equal(manager.prepare({ projectName: "Cube Demo" }), true);
  assert.equal(manager.getState().phase, "preparing");
  assert.equal(calls.saveRequests, 1);

  // Files that are not the editable project are never consumed as one:
  assert.equal(manager.handleViewportExport(new File(["G1"], "plate_1.gcode"), "plate_1.gcode"), false);
  assert.equal(manager.handleViewportExport(new File(["x"], "job.gcode.3mf"), "job.gcode.3mf"), false,
    "a .gcode.3mf package must never be mislabeled as the editable project");
  assert.equal(manager.getState().phase, "preparing");

  const file = await valid3mfFile();
  assert.equal(manager.handleViewportExport(file, file.name), true);
  const ready = await waitForPhase(manager, "file-ready");
  assert.equal(ready.step, 3);
  assert.equal(ready.failure, null);
  assert.equal(ready.file.filename, "LEVO-Cube-Demo-X2D.3mf");
  assert.equal(ready.file.inspection.ok, true);
  assert.equal(ready.uploadConfirmed, false);
  assert.equal(calls.downloads.length, 1, "the verified file is downloaded exactly once");
  assert.equal(calls.downloads[0].name, "LEVO-Cube-Demo-X2D.3mf");

  assert.equal(manager.openMakerWorld(), true);
  const handoff = manager.getState();
  assert.equal(handoff.phase, "handoff-opened");
  assert.equal(handoff.step, 4);
  assert.deepEqual(calls.opened, [exportManager.MAKERWORLD_UPLOAD_URL]);
  assert.equal(handoff.uploadConfirmed, false, "opening the page must never read as an upload (T12)");
  assert.ok(handoff.file, "the prepared file summary survives the handoff");
  assert.ok(handoff.handoffOpenedAt !== null);

  // markHandoffOpened (anchor navigation) records without opening again.
  assert.equal(manager.markHandoffOpened(), true);
  assert.equal(calls.opened.length, 1);
});

test("openMakerWorld is refused before a file is ready", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);
  assert.equal(manager.openMakerWorld(), false);
  manager.runCheck(OK_INPUT);
  assert.equal(manager.openMakerWorld(), false);
  assert.equal(manager.markHandoffOpened(), false);
  assert.equal(calls.opened.length, 0);
});

test("scene/settings invalidation discards the prepared file (stale honesty)", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  manager.runCheck(OK_INPUT);
  manager.prepare({ projectName: "Cube" });
  const file = await valid3mfFile();
  manager.handleViewportExport(file, file.name);
  await waitForPhase(manager, "file-ready");

  manager.invalidate("scene-edited");
  const state = manager.getState();
  assert.equal(state.phase, "idle");
  assert.equal(state.file, null);
  assert.equal(state.report, null);
  assert.equal(state.invalidatedBy, "scene-edited");
  assert.equal(manager.prepare(), false, "prepare requires a fresh passing check after invalidation");
  assert.equal(calls.downloads.length, 1, "no new download without a new prepare");
});

test("a late engine export from a cancelled prepare is ignored", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  manager.runCheck(OK_INPUT);
  manager.prepare();
  manager.invalidate("settings-changed");
  const file = await valid3mfFile();
  assert.equal(manager.handleViewportExport(file, file.name), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.getState().phase, "idle");
  assert.equal(calls.downloads.length, 0);
});

test("save timeout fails loudly and a retry works", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps({ saveTimeoutMs: 25 });
  const manager = exportManager.createMakerWorldExportManager(deps);

  manager.runCheck(OK_INPUT);
  manager.prepare();
  const failed = await waitForPhase(manager, "failed");
  assert.equal(failed.failure, "save-timeout");
  assert.equal(failed.step, 2);
  assert.equal(calls.downloads.length, 0);

  // Retry from the failure without a new check.
  assert.equal(manager.prepare({ projectName: "Retry" }), true);
  const file = await valid3mfFile();
  manager.handleViewportExport(file, file.name);
  const ready = await waitForPhase(manager, "file-ready");
  assert.equal(ready.file.filename, "LEVO-Retry-X2D.3mf");
  assert.equal(calls.downloads.length, 1);
});

test("an unavailable engine fails immediately (sync and async ports)", async () => {
  const { exportManager } = await loadModules();

  const sync = makeDeps({ saveResult: false });
  const syncManager = exportManager.createMakerWorldExportManager(sync.deps);
  syncManager.runCheck(OK_INPUT);
  syncManager.prepare();
  const syncFailed = await waitForPhase(syncManager, "failed");
  assert.equal(syncFailed.failure, "engine-unavailable");

  const asyncDeps = makeDeps();
  asyncDeps.deps.engine.requestSave = () => Promise.resolve(false);
  const asyncManager = exportManager.createMakerWorldExportManager(asyncDeps.deps);
  asyncManager.runCheck(OK_INPUT);
  asyncManager.prepare();
  const asyncFailed = await waitForPhase(asyncManager, "failed");
  assert.equal(asyncFailed.failure, "engine-unavailable");
});

test("a structurally invalid 3MF is never presented as ready", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  manager.runCheck(OK_INPUT);
  manager.prepare();
  const garbage = new File([new Uint8Array([1, 2, 3, 4, 5])], "broken.3mf", { type: "model/3mf" });
  assert.equal(manager.handleViewportExport(garbage, garbage.name), true);
  const failed = await waitForPhase(manager, "failed");
  assert.equal(failed.failure, "invalid-3mf");
  assert.equal(failed.failedInspection?.reason, "not-zip");
  assert.equal(failed.file, null);
  assert.equal(calls.downloads.length, 0, "an unverified file must never be downloaded as ready");
});

test("the truncated golden sibling also fails preparation", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  manager.runCheck(OK_INPUT);
  manager.prepare();
  const bytes = await readFile(new URL("broken-truncated.3mf", fixturesUrl));
  const file = new File([bytes], "truncated.3mf", { type: "model/3mf" });
  manager.handleViewportExport(file, file.name);
  const failed = await waitForPhase(manager, "failed");
  assert.equal(failed.failure, "invalid-3mf");
  assert.equal(failed.failedInspection?.reason, "truncated");
  assert.equal(calls.downloads.length, 0);
});

test("re-running the check while preparing cancels the in-flight save", async () => {
  const { exportManager } = await loadModules();
  const { deps, calls } = makeDeps();
  const manager = exportManager.createMakerWorldExportManager(deps);

  manager.runCheck(OK_INPUT);
  manager.prepare();
  assert.equal(manager.getState().phase, "preparing");
  manager.runCheck(OK_INPUT);
  assert.equal(manager.getState().phase, "checked");
  const file = await valid3mfFile();
  assert.equal(manager.handleViewportExport(file, file.name), false, "the old save no longer consumes files");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.getState().phase, "checked");
  assert.equal(calls.downloads.length, 0);
});

test("UI wording stays honest: file-ready/open labels present, upload claims absent", async () => {
  const prepareSource = await readFile(new URL("../app/makerworld/prepare.tsx", import.meta.url), "utf8");
  assert.ok(prepareSource.includes("الملف جاهز"), 'primary label "الملف جاهز" must exist');
  assert.ok(prepareSource.includes("فتح MakerWorld"), 'primary label "فتح MakerWorld" must exist');
  assert.ok(!prepareSource.includes("تم الرفع"), 'the UI must never say "تم الرفع"');
  assert.ok(!/uploaded successfully/i.test(prepareSource), "the UI must never claim a successful upload");

  const managerSource = await readFile(new URL("../app/export-manager.ts", import.meta.url), "utf8");
  assert.ok(!/phase\s*[:=]\s*"uploaded"/.test(managerSource), "no uploaded phase may be introduced");
});
