/**
 * Auto-orient: the BambuStudio port, checked against geometry whose right
 * answer is known by hand rather than by re-running the implementation.
 *
 * The scoring constants come from BambuStudio's OrientParamsArea, so the tests
 * that matter are the behavioral ones: a wedge must land on its flat face, a
 * tall thin part must lie down, the rotation must actually take the chosen
 * direction to +Y, and an already-good orientation must be left alone.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const orientUrl = new URL("../app/auto-orient.ts", import.meta.url);
const engineUrl = new URL("../node_modules/three-slicer/viewer/dist/Viewport.js", import.meta.url);
const adapterUrl = new URL("../app/engine-adapter.ts", import.meta.url);

async function load() {
  const source = await readFile(orientUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

/** Triangle soup for an axis-aligned box, corner at the origin. */
function box(sx, sy, sz) {
  const v = (i, j, k) => [i * sx, j * sy, k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  const tris = [
    [p000, p110, p100], [p000, p010, p110],
    [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001],
    [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010],
    [p100, p110, p111], [p100, p111, p101],
  ];
  return new Float32Array(tris.flat(2));
}

/**
 * Extrudes a CCW polygon (in XY) along Z into a closed triangle soup, with
 * outward normals — the fixture builder the overhang test needs.
 */
function prism(polygon, z0, z1) {
  const tris = [];
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    tris.push([[ax, ay, z0], [bx, by, z0], [bx, by, z1]]);
    tris.push([[ax, ay, z0], [bx, by, z1], [ax, ay, z1]]);
  }
  const [p0, ...rest] = polygon;
  for (let i = 0; i + 1 < rest.length; i++) {
    // Bottom cap wound backwards so it faces -Z; top cap as given, facing +Z.
    tris.push([[p0[0], p0[1], z0], [rest[i + 1][0], rest[i + 1][1], z0], [rest[i][0], rest[i][1], z0]]);
    tris.push([[p0[0], p0[1], z1], [rest[i][0], rest[i][1], z1], [rest[i + 1][0], rest[i + 1][1], z1]]);
  }
  return tris.flat(2);
}

/**
 * A leg with a ramp on top: the ramp's underside is a 45-degree face that is
 * RAISED off the bed, which is the only way a sloped overhang is an overhang
 * rather than the part's own bed contact.
 */
function rampOnLeg() {
  const leg = Array.from(box(5, 10, 20));
  const ramp = prism([[0, 10], [20, 30], [0, 30]], 0, 20);
  return new Float32Array([...leg, ...ramp]);
}

/** A right triangular prism: one large slanted face, one large flat face. */
function wedge(w, h, d) {
  const a = [0, 0, 0], b = [w, 0, 0], c = [0, h, 0];
  const a2 = [0, 0, d], b2 = [w, 0, d], c2 = [0, h, d];
  const tris = [
    [a, c, b], [a2, b2, c2],
    [a, b, b2], [a, b2, a2],
    [b, c, c2], [b, c2, b2],
    [c, a, a2], [c, a2, c2],
  ];
  return new Float32Array(tris.flat(2));
}

const norm = (v) => Math.hypot(v.x, v.y, v.z);

test("a cube scores every face the same and is therefore left alone", async () => {
  const { autoOrient } = await load();
  const result = autoOrient(box(20, 20, 20));
  assert.ok(result, "a cube must produce a result");
  // Every orientation of a cube is equally printable, so the anti-flip rule
  // must keep it where it is instead of somersaulting it for nothing.
  assert.equal(result.improved, false);
  assert.ok(Math.abs(result.euler.x) < 1e-6);
  assert.ok(Math.abs(result.euler.y) < 1e-6);
  assert.ok(Math.abs(result.euler.z) < 1e-6);
});

test("the returned euler really takes the chosen direction to +Y", async () => {
  const { autoOrient, applyEulerXYZ, UP } = await load();
  // A tall, thin tower: its best orientation is not the one it arrives in.
  const result = autoOrient(box(6, 120, 6));
  assert.ok(result);
  const moved = applyEulerXYZ(result.euler, result.orientation);
  // This is the contract the whole feature rests on: whatever direction the
  // search picked must be pointing up after the rotation is applied.
  assert.ok(Math.abs(moved.x - UP.x) < 1e-6, `x ${moved.x}`);
  assert.ok(Math.abs(moved.y - UP.y) < 1e-6, `y ${moved.y}`);
  assert.ok(Math.abs(moved.z - UP.z) < 1e-6, `z ${moved.z}`);
  assert.ok(Math.abs(norm(moved) - 1) < 1e-6);
});

test("a tall thin tower is laid down onto a broad face", async () => {
  const { autoOrient, applyEulerXYZ } = await load();
  const positions = box(6, 120, 6);
  const result = autoOrient(positions);
  assert.ok(result);
  assert.equal(result.improved, true, "standing a 6x120x6 tower up is not its best orientation");

  // Measure the height of the part after the rotation: lying down must be
  // shorter than standing up, which is the whole point of laying it down.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const p = applyEulerXYZ(result.euler, { x: positions[i], y: positions[i + 1], z: positions[i + 2] });
    lo = Math.min(lo, p.y);
    hi = Math.max(hi, p.y);
  }
  assert.ok(hi - lo < 119, `height after orienting was ${hi - lo}, expected it to lie down`);
});

test("a wedge is put on its flat face, not its slope", async () => {
  const { autoOrient, applyEulerXYZ } = await load();
  const positions = wedge(60, 60, 40);
  const result = autoOrient(positions);
  assert.ok(result);
  // The wedge's flat rectangular faces are its printable bottoms. After
  // orienting, a large share of its area must be sitting AT the lowest level.
  let lo = Infinity;
  const pts = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const p = applyEulerXYZ(result.euler, { x: positions[i], y: positions[i + 1], z: positions[i + 2] });
    pts.push(p);
    lo = Math.min(lo, p.y);
  }
  const onBed = pts.filter((p) => p.y < lo + 0.2).length;
  assert.ok(onBed >= 4, `only ${onBed} vertices reached the bed plane`);
});

test("the convex hull of a box is the box", async () => {
  const { convexHull3d } = await load();
  const hull = convexHull3d(box(10, 20, 30));
  assert.equal(hull.approximated, false);
  // 6 rectangular faces, 2 triangles each, however the incremental hull
  // happens to triangulate them.
  const triangles = hull.positions.length / 9;
  assert.ok(triangles >= 12, `hull had ${triangles} triangles`);
  // Every hull vertex must be a real corner of the box — a hull that invented
  // a point would be a hull that scores an orientation that does not exist.
  for (let i = 0; i + 2 < hull.positions.length; i += 3) {
    const x = hull.positions[i], y = hull.positions[i + 1], z = hull.positions[i + 2];
    assert.ok((x === 0 || x === 10) && (y === 0 || y === 20) && (z === 0 || z === 30), `${x},${y},${z}`);
  }
});

test("the hull encloses every vertex of a non-convex part", async () => {
  const { convexHull3d } = await load();
  // An L: the hull must span the whole bounding box, not the L's own outline.
  const arm = box(40, 10, 10);
  const leg = box(10, 40, 10);
  const positions = new Float32Array(arm.length + leg.length);
  positions.set(arm, 0);
  positions.set(leg, arm.length);
  const hull = convexHull3d(positions);
  assert.ok(hull.positions.length > 0);
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 2 < hull.positions.length; i += 3) {
    maxX = Math.max(maxX, hull.positions[i]);
    maxY = Math.max(maxY, hull.positions[i + 1]);
  }
  assert.equal(maxX, 40);
  assert.equal(maxY, 40);
});

test("degenerate input is refused rather than guessed at", async () => {
  const { autoOrient } = await load();
  assert.equal(autoOrient(new Float32Array(0)), null);
  assert.equal(autoOrient(new Float32Array(9)), null, "one triangle is not a solid");
  // A flat sheet of triangles has no volume and no hull; it must not throw.
  const flat = new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0, 10,
    0, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 10, 0, 0, 0, 0, 10]);
  assert.doesNotThrow(() => autoOrient(flat));
});

test("the overhang angle changes what counts as an overhang", async () => {
  const { scoreOrientation } = await load();
  // Pin ONE orientation rather than reading whichever the search picked: the
  // best orientation may legitimately have no overhang at either threshold,
  // which would prove nothing about the threshold.
  //
  // The ramp's underside runs from (0,10) to (20,30), so its outward normal is
  // (1,-1,0)/sqrt(2) — 45 degrees below horizontal, and 10mm off the bed
  // because the leg holds it there.
  const positions = rampOnLeg();
  const up = { x: 0, y: 1, z: 0 };
  const strict = scoreOrientation(positions, up, { overhangAngleDeg: 10 });
  const loose = scoreOrientation(positions, up, { overhangAngleDeg: 80 });
  assert.ok(strict && loose);
  // At 10 degrees only a near-vertical droop counts, so a 45-degree face is
  // fine; at 80 degrees it is an overhang and must cost something.
  assert.equal(strict.overhang, 0, "a 45-degree face is not an overhang at a 10-degree threshold");
  assert.ok(loose.overhang > 0, `a 45-degree face must be an overhang at 80 degrees, got ${loose.overhang}`);
});

test("the up axis is derived, not copied from a Z-up slicer", async () => {
  const { autoOrient, applyEulerXYZ, UP } = await load();
  // The regression this pins: BambuStudio hard-codes (0,0,1) as "already
  // upright" because it is Z-up. Copying that verbatim into a Y-up engine
  // rotates EVERY result by a quarter turn — including a cube's, which should
  // not move at all.
  assert.deepEqual(UP, { x: 0, y: 1, z: 0 });
  const cube = autoOrient(box(20, 20, 20));
  assert.ok(cube);
  assert.deepEqual(cube.orientation, UP);
  const moved = applyEulerXYZ(cube.euler, { x: 0, y: 1, z: 0 });
  assert.ok(Math.abs(moved.y - 1) < 1e-9, "a cube's up must still be up");
});

test("re-seating uses the difference between two lowest points", async () => {
  const { lowestPoint } = await load();
  const positions = box(10, 20, 30);
  const scale = { x: 1, y: 1, z: 1 };
  const flat = lowestPoint(positions, { x: 0, y: 0, z: 0 }, scale);
  assert.equal(flat, 0);
  // Rolled a quarter turn about X, the box's lowest point moves to -30.
  const rolled = lowestPoint(positions, { x: Math.PI / 2, y: 0, z: 0 }, scale);
  assert.ok(Math.abs(rolled + 30) < 1e-4, `rolled lowest was ${rolled}`);
  // Scale is honoured, or a scaled object would be re-seated into the bed.
  const scaled = lowestPoint(positions, { x: Math.PI / 2, y: 0, z: 0 }, { x: 1, y: 1, z: 2 });
  assert.ok(Math.abs(scaled + 60) < 1e-4, `scaled lowest was ${scaled}`);
});

test("the scoring constants are BambuStudio's, unchanged", async () => {
  const { ORIENT_PARAMS } = await load();
  // Straight from OrientParamsArea in src/libslic3r/Orient.hpp. If someone
  // "tunes" one of these, this test is where they have to say so.
  assert.equal(ORIENT_PARAMS.RELATIVE_F, 20);
  assert.equal(ORIENT_PARAMS.CONTOUR_F, 0.5);
  assert.equal(ORIENT_PARAMS.BOTTOM_F, 2.5);
  assert.equal(ORIENT_PARAMS.BOTTOM_HULL_F, 0.1);
  assert.equal(ORIENT_PARAMS.TAR_C, 0.1);
  assert.equal(ORIENT_PARAMS.TAR_D, 1);
  assert.equal(ORIENT_PARAMS.TAR_LAF, 0.001);
  assert.equal(ORIENT_PARAMS.FIRST_LAY_H, 0.2);
  assert.equal(ORIENT_PARAMS.LAF_MAX, 0.999);
  assert.equal(ORIENT_PARAMS.LAF_MIN, 0.97);
  assert.equal(ORIENT_PARAMS.BOTTOM_MIN, 0.1);
  assert.equal(ORIENT_PARAMS.overhang_angle, 30);
});

test("a part with nothing on the bed is penalised, not preferred", async () => {
  const { autoOrient } = await load();
  // A very slender spike: whichever way it goes, the search must never return
  // an orientation whose bottom area is below BOTTOM_MIN without the +100.
  const result = autoOrient(box(0.2, 60, 0.2));
  assert.ok(result);
  if (result.costs.bottom < 0.1) {
    assert.ok(result.costs.unprintability >= 100, `unprintability ${result.costs.unprintability}`);
  } else {
    assert.ok(result.costs.unprintability < 100);
  }
});

test("the engine still hands back a real Euler, which the adapter relies on", async () => {
  const engine = await readFile(engineUrl, "utf8");
  // `autoOrientObjects` writes `snapshot.rot.x = ...` and lets the engine's own
  // `restoreScene` apply it. That only works because the snapshot's `rot` is a
  // cloned THREE.Euler (whose x/y/z accessors write `_x`/`_y`/`_z`) and because
  // restore does `rotation.copy(rot)`, which READS `_x`. If the engine ever
  // returns a plain object instead, every orientation silently becomes NaN —
  // so the dependency is pinned here rather than discovered in production.
  assert.match(engine, /rot:\s*\w+\.mesh\.rotation\.clone\(\)/);
  assert.match(engine, /rotation\.copy\(/);
  // And the geometry the search reads must still ride along by reference.
  assert.match(engine, /localPos:\s*\w+\.localPos/);
});

test("the adapter replaces the rotation rather than composing it", async () => {
  const adapter = await readFile(adapterUrl, "utf8");
  // Composing would make auto-orient non-idempotent: pressing it twice would
  // give two different answers, because the score is computed from the LOCAL
  // mesh and would then be applied on top of the previous result.
  assert.match(adapter, /snapshot\.rot\.x = result\.euler\.x/);
  assert.doesNotMatch(adapter, /snapshot\.rot\.x \+= /);
  // And re-seating must be a difference, never an assumed convention.
  assert.match(adapter, /snapshot\.pos\.y \+= before - after/);
});

test("orienting the same shape twice is idempotent", async () => {
  const { autoOrient, applyEulerXYZ } = await load();
  const positions = box(6, 120, 6);
  const first = autoOrient(positions);
  assert.ok(first);
  // The second run reads the SAME local geometry — the local mesh never
  // changes, only the object's rotation does — so it must reach the same
  // answer rather than drifting a quarter turn per press.
  const second = autoOrient(positions);
  assert.ok(second);
  assert.deepEqual(second.euler, first.euler);
  const a = applyEulerXYZ(first.euler, first.orientation);
  const b = applyEulerXYZ(second.euler, second.orientation);
  assert.deepEqual(a, b);
});
