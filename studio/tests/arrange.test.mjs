/**
 * Behavioral tests for the general auto-arrange planner (S4 editor-core, T8):
 * packing across plates with the engine's real 9-plate cap kept honest,
 * locked objects respected, oversized/overflow objects reported instead of
 * silently scaled, and the footprint math used to feed the packer.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const packingUrl = new URL("../app/plate-packing.ts", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);

async function loadPackingModule() {
  const source = await readFile(packingUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

test("PLATE_CAP matches the installed engine's real plate limit", async () => {
  const [packing, engine] = await Promise.all([loadPackingModule(), readFile(engineUrl, "utf8")]);
  assert.equal(packing.PLATE_CAP, 9);
  // The engine's plate bar advertises the same cap ("Add an empty plate (max 9)").
  assert.match(engine, /max 9/);
});

test("legacy ZIP packing behavior is unchanged", async () => {
  const packing = await loadPackingModule();
  const result = packing.packModelsAcrossPlates([
    { id: 1, width: 180, depth: 180 },
    { id: 2, width: 180, depth: 180 },
    { id: 3, width: 40, depth: 40 },
  ], 256, 256, 0, 9);
  assert.equal(result.placements.length, 3);
  assert.equal(result.platesUsed, 2);
  assert.equal(result.overflowCount, 0);
  assert.deepEqual(new Set(result.placements.map((placement) => placement.plate)), new Set([0, 1]));
});

test("general arrangement places every movable object inside the usable bed", async () => {
  const packing = await loadPackingModule();
  const bedWidth = 256;
  const bedDepth = 256;
  const margin = 8;
  const usableWidth = bedWidth - margin * 2;
  const usableDepth = bedDepth - margin * 2;
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    width: 60 + (index % 3) * 20,
    depth: 50 + (index % 4) * 15,
  }));
  const plan = packing.planGeneralArrangement(candidates, { bedWidth, bedDepth });
  assert.equal(plan.placements.length, candidates.length);
  assert.equal(plan.overflowCount, 0);
  assert.equal(plan.lockedCount, 0);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  for (const placement of plan.placements) {
    const model = byId.get(placement.id);
    assert.ok(model, `placement for unknown id ${placement.id}`);
    assert.ok(Math.abs(placement.offsetX) + model.width / 2 <= usableWidth / 2 + 1e-6,
      `object ${placement.id} exceeds usable width`);
    assert.ok(Math.abs(placement.offsetY) + model.depth / 2 <= usableDepth / 2 + 1e-6,
      `object ${placement.id} exceeds usable depth`);
    assert.ok(placement.plate >= 0 && placement.plate < packing.PLATE_CAP);
  }
  // targetPlates is the ascending list of plates that received placements.
  const plates = [...new Set(plan.placements.map((placement) => placement.plate))].sort((a, b) => a - b);
  assert.deepEqual(plan.targetPlates, plates);
});

test("locked objects are never moved and their plates are excluded from packing", async () => {
  const packing = await loadPackingModule();
  const plan = packing.planGeneralArrangement([
    { id: 1, width: 100, depth: 100, locked: true, plate: 0 },
    { id: 2, width: 100, depth: 100 },
    { id: 3, width: 100, depth: 100 },
  ], { bedWidth: 256, bedDepth: 256 });
  assert.equal(plan.lockedCount, 1);
  assert.deepEqual(plan.lockedPlates, [0]);
  // The locked object receives no placement (it is not moved).
  assert.ok(!plan.placements.some((placement) => placement.id === 1));
  // Movable objects avoid the locked object's plate entirely.
  for (const placement of plan.placements) {
    assert.notEqual(placement.plate, 0, `object ${placement.id} was packed onto the locked plate`);
  }
  assert.equal(plan.placements.length, 2);
  assert.equal(plan.overflowCount, 0);
});

test("objects beyond the plate cap are reported as overflow, never squeezed", async () => {
  const packing = await loadPackingModule();
  // Each object nearly fills a plate, so each needs its own plate.
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    width: 230,
    depth: 230,
  }));
  const plan = packing.planGeneralArrangement(candidates, { bedWidth: 256, bedDepth: 256 });
  assert.equal(plan.platesUsed, packing.PLATE_CAP);
  assert.equal(plan.placements.length, packing.PLATE_CAP);
  assert.equal(plan.overflowCount, candidates.length - packing.PLATE_CAP);
  // No placement was shrunk to force a fit — sizes are the packer's input,
  // and every placement stays inside a real plate index.
  for (const placement of plan.placements) {
    assert.ok(placement.plate >= 0 && placement.plate < packing.PLATE_CAP);
  }
});

test("plateCap above the engine limit is clamped, below is honored", async () => {
  const packing = await loadPackingModule();
  const candidates = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, width: 230, depth: 230 }));
  const clamped = packing.planGeneralArrangement(candidates, { bedWidth: 256, bedDepth: 256, plateCap: 99 });
  assert.ok(clamped.platesUsed <= packing.PLATE_CAP);
  const limited = packing.planGeneralArrangement(candidates, { bedWidth: 256, bedDepth: 256, plateCap: 2 });
  assert.equal(limited.platesUsed, 2);
  assert.equal(limited.overflowCount, 3);
});

test("oversized objects are centered on their own plate and reported", async () => {
  const packing = await loadPackingModule();
  const plan = packing.planGeneralArrangement([
    { id: 1, width: 400, depth: 400 },
    { id: 2, width: 40, depth: 40 },
  ], { bedWidth: 256, bedDepth: 256 });
  assert.equal(plan.oversizedCount, 1);
  const oversized = plan.placements.find((placement) => placement.id === 1);
  assert.ok(oversized);
  assert.equal(oversized.oversized, true);
  assert.equal(oversized.offsetX, 0);
  assert.equal(oversized.offsetY, 0);
});

test("arrangement planning is deterministic", async () => {
  const packing = await loadPackingModule();
  const candidates = Array.from({ length: 9 }, (_, index) => ({
    id: index + 1,
    width: 30 + (index * 13) % 90,
    depth: 30 + (index * 29) % 80,
  }));
  const first = packing.planGeneralArrangement(candidates, { bedWidth: 256, bedDepth: 256 });
  const second = packing.planGeneralArrangement(candidates, { bedWidth: 256, bedDepth: 256 });
  assert.deepEqual(first, second);
});

test("snapshotFootprint applies scale and rotation to the bed footprint", async () => {
  const packing = await loadPackingModule();
  // A 10 × 4 × 20 box (x × y × z) in local space.
  const box = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 4, 0,
    0, 0, 20, 10, 4, 20, 0, 4, 20,
  ]);
  const flat = packing.snapshotFootprint({
    id: 7,
    localPos: box,
    rot: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  assert.equal(flat.id, 7);
  assert.ok(Math.abs(flat.width - 10) < 1e-9);
  assert.ok(Math.abs(flat.depth - 20) < 1e-9);

  // Rotating 90° about X maps local Y onto the depth axis.
  const rotated = packing.snapshotFootprint({
    id: 7,
    localPos: box,
    rot: { x: Math.PI / 2, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
  });
  assert.ok(Math.abs(rotated.width - 10) < 1e-6);
  assert.ok(Math.abs(rotated.depth - 4) < 1e-6);

  // Scale multiplies the footprint.
  const scaled = packing.snapshotFootprint({
    id: 7,
    localPos: box,
    rot: { x: 0, y: 0, z: 0 },
    scale: { x: 2, y: 1, z: 3 },
  });
  assert.ok(Math.abs(scaled.width - 20) < 1e-9);
  assert.ok(Math.abs(scaled.depth - 60) < 1e-9);
});
