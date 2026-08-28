/**
 * Fixture + preflight tests (slice S7, T10/T11 groundwork).
 *
 * - Validates the committed STL fixtures in tests/fixtures/ (well-formed ASCII
 *   STL with the declared sizes) so the verify agent's in-browser engine smoke
 *   always has deterministic inputs.
 * - Exercises the MakerWorld preflight logic (app/makerworld/preflight.ts)
 *   against real fixture geometry: bounds, materials, plates, and the honest
 *   limitation findings required by the gap table.
 * - Verifies the 3MF structural inspector (app/export-manager.ts) against the
 *   committed mini-project.3mf golden fixture and its broken sibling.
 *
 * Provenance note (honest): mini-project.3mf is hand-authored to mirror the
 * installed three-slicer 0.2.2 save writer's entry names — it is NOT an engine
 * export and has NOT been opened in Bambu Studio/Orca yet; that external check
 * remains pending (see studio/BAMBU_PRINT_PIPELINE.md).
 *
 * Engine-in-browser slicing itself is intentionally NOT run here — that is the
 * verify agent's smoke. The engine evidence below is static (reading the
 * installed build's source), the same style as tests/arrange.test.mjs.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { zipSync, strToU8 } from "fflate";

const fixturesUrl = new URL("./fixtures/", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);

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
    const packingUrl = await transpileToUrl(new URL("../app/plate-packing.ts", import.meta.url));
    const profilesUrl = await transpileToUrl(new URL("../app/printer-profiles.ts", import.meta.url));
    const [preflight, exportManager, packing, profiles] = await Promise.all([
      import(preflightUrl),
      import(exportManagerUrl),
      import(packingUrl),
      import(profilesUrl),
    ]);
    return { preflight, exportManager, packing, profiles };
  })();
  return modulesPromise;
}

// --- ASCII STL parsing (test-local, deliberately independent of app code) ---

function parseAsciiStl(text) {
  const facetCount = (text.match(/facet normal/g) ?? []).length;
  const vertices = [];
  const vertexRe = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  for (const match of text.matchAll(vertexRe)) {
    vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const vertex of vertices) {
    for (let axis = 0; axis < 3; axis += 1) {
      bounds.min[axis] = Math.min(bounds.min[axis], vertex[axis]);
      bounds.max[axis] = Math.max(bounds.max[axis], vertex[axis]);
    }
  }
  return { facetCount, vertices, bounds };
}

function stlObjectInput(id, name, parsed, extruder = 1) {
  return {
    id,
    name,
    extruder,
    visible: true,
    widthMm: parsed.bounds.max[0] - parsed.bounds.min[0],
    depthMm: parsed.bounds.max[1] - parsed.bounds.min[1],
    heightMm: parsed.bounds.max[2] - parsed.bounds.min[2],
  };
}

function profileInput(profile) {
  return {
    id: profile.id,
    model: profile.model,
    shortName: profile.shortName,
    nozzle: profile.nozzle,
    bedWidthMm: profile.bedWidth,
    bedDepthMm: profile.bedDepth,
    bedHeightMm: profile.bedHeight,
  };
}

const STL_FIXTURES = [
  { file: "cube-10mm.stl", facets: 12, size: [10, 10, 10] },
  { file: "cube-300mm.stl", facets: 12, size: [300, 300, 300] },
  { file: "tetra-8mm.stl", facets: 4, size: [8, 8, 8] },
];

test("committed STL fixtures are well-formed ASCII STL with declared sizes", async () => {
  for (const fixture of STL_FIXTURES) {
    const text = await readFile(new URL(fixture.file, fixturesUrl), "utf8");
    assert.match(text, /^solid /, `${fixture.file}: missing solid header`);
    assert.match(text, /endsolid /, `${fixture.file}: missing endsolid`);
    const parsed = parseAsciiStl(text);
    assert.equal(parsed.facetCount, fixture.facets, `${fixture.file}: facet count`);
    assert.equal(parsed.vertices.length, fixture.facets * 3, `${fixture.file}: 3 vertices per facet`);
    for (const vertex of parsed.vertices) {
      for (const value of vertex) assert.ok(Number.isFinite(value), `${fixture.file}: non-finite vertex`);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      assert.equal(parsed.bounds.max[axis] - parsed.bounds.min[axis], fixture.size[axis],
        `${fixture.file}: axis ${axis} extent`);
    }
  }
});

test("preflight passes the small fixtures on every catalogued printer", async () => {
  const { preflight, profiles } = await loadModules();
  const cube10 = parseAsciiStl(await readFile(new URL("cube-10mm.stl", fixturesUrl), "utf8"));
  const tetra8 = parseAsciiStl(await readFile(new URL("tetra-8mm.stl", fixturesUrl), "utf8"));
  for (const profile of Object.values(profiles.PROFILES)) {
    const report = preflight.runPreflight({
      objects: [
        stlObjectInput(1, "cube-10mm", cube10),
        stlObjectInput(2, "tetra-8mm", tetra8),
      ],
      plateCount: 1,
      profile: profileInput(profile),
      profileVerified: true,
    });
    assert.equal(report.ok, true, `${profile.id}: small fixtures should pass`);
    assert.equal(report.checkedObjectCount, 2);
    assert.equal(report.unmeasuredObjectCount, 0);
    assert.ok(!report.findings.some((finding) => finding.severity === "blocker"));
  }
});

test("preflight blocks the 300 mm cube on a 256 mm bed but not on a large-bed printer", async () => {
  const { preflight, profiles } = await loadModules();
  const cube300 = parseAsciiStl(await readFile(new URL("cube-300mm.stl", fixturesUrl), "utf8"));
  const object = stlObjectInput(7, "cube-300mm", cube300);

  const onX2d = preflight.runPreflight({
    objects: [object],
    plateCount: 1,
    profile: profileInput(profiles.PROFILES["bbl-x2d-04"]),
    profileVerified: true,
  });
  assert.equal(onX2d.ok, false);
  const blocker = onX2d.findings.find((finding) => finding.code === "object-exceeds-bed");
  assert.ok(blocker, "expected an object-exceeds-bed blocker");
  assert.equal(blocker.severity, "blocker");
  assert.deepEqual(blocker.objectIds, [7]);

  // H2D: 350 × 320 × 325 mm — the 300 mm cube fits in footprint and height.
  const onH2d = preflight.runPreflight({
    objects: [object],
    plateCount: 1,
    profile: profileInput(profiles.PROFILES["bbl-h2d-04"]),
    profileVerified: true,
  });
  assert.equal(onH2d.ok, true);
  assert.ok(!onH2d.findings.some((finding) => finding.code === "object-exceeds-bed"));
});

test("the bounds check allows an in-plane rotation fit but never a height rotation", async () => {
  const { preflight } = await loadModules();
  // 300 × 200 footprint on a 256 × 320 bed: fits only rotated in-plane.
  assert.equal(preflight.footprintFitsBed(300, 200, 256, 320), true);
  assert.equal(preflight.footprintFitsBed(300, 300, 256, 320), false);
  // Height has no alternative orientation.
  const report = preflight.runPreflight({
    objects: [{ id: 1, name: "tall", extruder: 1, visible: true, widthMm: 10, depthMm: 10, heightMm: 500 }],
    plateCount: 1,
    profile: { id: "p", model: "M", shortName: "M", nozzle: 0.4, bedWidthMm: 256, bedDepthMm: 256, bedHeightMm: 260 },
    profileVerified: true,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === "object-exceeds-bed"));
});

test("no objects blocks; unmeasured and hidden objects warn instead of silently passing", async () => {
  const { preflight } = await loadModules();
  const profile = { id: "p", model: "M", shortName: "M", nozzle: 0.4, bedWidthMm: 256, bedDepthMm: 256, bedHeightMm: 260 };

  const empty = preflight.runPreflight({ objects: [], plateCount: 1, profile, profileVerified: true });
  assert.equal(empty.ok, false);
  assert.ok(empty.findings.some((finding) => finding.code === "no-objects" && finding.severity === "blocker"));

  const report = preflight.runPreflight({
    objects: [
      { id: 1, name: "measured", extruder: 1, visible: true, widthMm: 10, depthMm: 10, heightMm: 10 },
      { id: 2, name: "unmeasured", extruder: 1, visible: true },
      { id: 3, name: "hidden", extruder: 2, visible: false },
    ],
    plateCount: 1,
    profile,
    profileVerified: true,
  });
  assert.equal(report.ok, true, "warnings must not block");
  assert.equal(report.unmeasuredObjectCount, 2, "hidden object has no dims either");
  assert.equal(report.hiddenObjectCount, 1);
  assert.ok(report.findings.some((finding) => finding.code === "objects-unmeasured" && finding.severity === "warning"));
  assert.ok(report.findings.some((finding) => finding.code === "objects-hidden" && finding.severity === "warning"));
  // Hidden objects do not contribute to the used-extruder set.
  assert.deepEqual(report.usedExtruders, [1]);
});

test("materials/profile findings: preset fallback and multi-extruder honesty", async () => {
  const { preflight } = await loadModules();
  const profile = { id: "p", model: "M", shortName: "M", nozzle: 0.4, bedWidthMm: 256, bedDepthMm: 256, bedHeightMm: 260 };
  const report = preflight.runPreflight({
    objects: [
      { id: 1, name: "a", extruder: 1, visible: true, widthMm: 10, depthMm: 10, heightMm: 10 },
      { id: 2, name: "b", extruder: 3, visible: true, widthMm: 10, depthMm: 10, heightMm: 10 },
    ],
    plateCount: 1,
    profile,
    profileVerified: false,
    missingPresets: ["0.20mm Standard @BBL X2D"],
  });
  assert.equal(report.ok, true);
  const fallback = report.findings.find((finding) => finding.code === "preset-fallback");
  assert.ok(fallback && fallback.severity === "warning");
  assert.match(String(fallback.data?.missing), /0\.20mm Standard/);
  const mmu = report.findings.find((finding) => finding.code === "multi-extruder-unverified");
  assert.ok(mmu && mmu.severity === "info", "multi-extruder stays declared, never claimed verified");
  assert.deepEqual(report.usedExtruders, [1, 3]);
  // Fallback settings are honestly "partial" in the transfer summary.
  const settings = report.transfers.find((item) => item.key === "global-settings");
  assert.equal(settings.status, "partial");
});

test("the transfer summary never over-promises (gap-table limits)", async () => {
  const { preflight } = await loadModules();
  const report = preflight.runPreflight({
    objects: [{ id: 1, name: "a", extruder: 1, visible: true, widthMm: 10, depthMm: 10, heightMm: 10 }],
    plateCount: 2,
    profile: { id: "p", model: "M", shortName: "M", nozzle: 0.4, bedWidthMm: 256, bedDepthMm: 256, bedHeightMm: 260 },
    profileVerified: true,
    supportPaintPresent: true,
  });
  const byKey = new Map(report.transfers.map((item) => [item.key, item.status]));
  assert.equal(byKey.get("geometry"), "transfers");
  assert.equal(byKey.get("plates"), "transfers");
  assert.equal(byKey.get("transforms"), "transfers");
  assert.equal(byKey.get("global-settings"), "transfers");
  // Written but with declared limits — never plain "transfers":
  assert.equal(byKey.get("extruder-assignment"), "partial");
  assert.equal(byKey.get("support-paint"), "partial");
  // Absent from the file or rejected by MakerWorld — never claimed:
  assert.equal(byKey.get("surface-colors"), "not-transferred");
  assert.equal(byKey.get("thumbnail"), "not-transferred");
  assert.equal(byKey.get("print-profile"), "not-transferred");
  assert.equal(byKey.get("slice-info"), "not-transferred");
  // The declared-limitation findings are always present.
  for (const code of ["surface-paint-unavailable", "thumbnail-not-embedded", "print-profile-not-accepted"]) {
    assert.ok(report.findings.some((finding) => finding.code === code && finding.severity === "info"), code);
  }
  // Multi-plate + support paint → the documented persistence limit warning.
  assert.ok(report.findings.some((finding) => finding.code === "paint-multi-plate-limit"));
});

test("preflight is deterministic and orders findings stably", async () => {
  const { preflight } = await loadModules();
  const input = {
    objects: [
      { id: 3, name: "big", extruder: 2, visible: true, widthMm: 500, depthMm: 500, heightMm: 500 },
      { id: 1, name: "small", extruder: 1, visible: true, widthMm: 10, depthMm: 10, heightMm: 10 },
      { id: 2, name: "ghost", extruder: 1, visible: false },
    ],
    plateCount: 9,
    profile: { id: "p", model: "M", shortName: "M", nozzle: 0.4, bedWidthMm: 256, bedDepthMm: 256, bedHeightMm: 260 },
    profileVerified: false,
  };
  const first = preflight.runPreflight(input);
  const second = preflight.runPreflight(input);
  assert.deepEqual(first, second);
  // Blockers first, then warnings, then infos.
  const ranks = first.findings.map((finding) => ({ blocker: 0, warning: 1, info: 2 })[finding.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.ok(first.findings.some((finding) => finding.code === "plate-cap"));
});

test("ENGINE_PLATE_CAP matches plate-packing and the installed engine build", async () => {
  const { preflight, packing } = await loadModules();
  const engine = await readFile(engineUrl, "utf8");
  assert.equal(preflight.ENGINE_PLATE_CAP, packing.PLATE_CAP);
  assert.equal(preflight.ENGINE_PLATE_CAP, 9);
  assert.match(engine, /max 9/);
});

test("static engine evidence backs the transfer summary claims (0.2.2 build)", async () => {
  const engine = await readFile(engineUrl, "utf8");
  // The save path writes per-object extruder metadata and plate layout:
  assert.match(engine, /Metadata\/model_settings\.config/);
  assert.match(engine, /<metadata key="extruder" value="/);
  assert.match(engine, /Metadata\/project_settings\.config/);
  // Per-object extruder assignment feeds the slice request (multi-material
  // grouping) — static evidence only; runtime G-code verification stays with
  // the in-browser smoke and the UI keeps saying "unverified in output":
  assert.match(engine, /mm_group_split/);
  assert.match(engine, /mm_group_tools/);
  // Claims the summary must NOT make, because the build does not do this:
  assert.doesNotMatch(engine, /slice_info\.config/);
  assert.doesNotMatch(engine, /Metadata\/plate_\d+\.png/);
});

test("mini-project.3mf golden fixture passes structural 3MF inspection", async () => {
  const { exportManager } = await loadModules();
  const bytes = new Uint8Array(await readFile(new URL("mini-project.3mf", fixturesUrl)));
  const inspection = exportManager.inspectEditable3mf(bytes);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.reason, undefined);
  assert.deepEqual(inspection.modelParts, ["3D/3dmodel.model"]);
  assert.equal(inspection.hasContentTypes, true);
  assert.equal(inspection.hasModelSettings, true);
  assert.equal(inspection.hasProjectSettings, true);
  // The engine embeds no thumbnail and neither does the fixture — the summary
  // relies on this staying false.
  assert.equal(inspection.hasThumbnail, false);
  assert.equal(inspection.entryCount, 5);
});

test("broken/foreign files never pass 3MF inspection", async () => {
  const { exportManager } = await loadModules();

  const truncated = new Uint8Array(await readFile(new URL("broken-truncated.3mf", fixturesUrl)));
  const truncatedResult = exportManager.inspectEditable3mf(truncated);
  assert.equal(truncatedResult.ok, false);
  assert.equal(truncatedResult.reason, "truncated");

  const stlBytes = new Uint8Array(await readFile(new URL("cube-10mm.stl", fixturesUrl)));
  const stlResult = exportManager.inspectEditable3mf(stlBytes);
  assert.equal(stlResult.ok, false);
  assert.equal(stlResult.reason, "not-zip");

  const zipNoModel = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "Metadata/model_settings.config": strToU8("<config/>"),
  }, { level: 0 });
  const noModel = exportManager.inspectEditable3mf(zipNoModel);
  assert.equal(noModel.ok, false);
  assert.equal(noModel.reason, "no-model-part");

  const zipNoTypes = zipSync({ "3D/3dmodel.model": strToU8("<model/>") }, { level: 0 });
  const noTypes = exportManager.inspectEditable3mf(zipNoTypes);
  assert.equal(noTypes.ok, false);
  assert.equal(noTypes.reason, "no-content-types");
});
