/**
 * Plane cut, checked by the two properties that a capping bug cannot survive:
 *
 *   - both halves stay WATERTIGHT (every edge shared by exactly two facets), so
 *     a missing or mis-wound cap is caught rather than admired in a screenshot;
 *   - their volumes still ADD UP to the original, so a cap that closes the
 *     wrong way — inverting one half — shows as a sign error, not as nothing.
 *
 * Plus the case that separates a real implementation from a demo: cutting a
 * tube must leave the bore open, not fill it in.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const cutUrl = new URL("../app/plane-cut.ts", import.meta.url);

async function load() {
  const source = await readFile(cutUrl, "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
}

function box(sx, sy, sz, ox = 0, oy = 0, oz = 0) {
  const v = (i, j, k) => [ox + i * sx, oy + j * sy, oz + k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  return [
    [p000, p110, p100], [p000, p010, p110],
    [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001],
    [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010],
    [p100, p110, p111], [p100, p111, p101],
  ].flat(2);
}

/** A box with a square bore through it in Y — the hole case. */
function tube(outer, bore, height) {
  const lo = (outer - bore) / 2;
  const hi = lo + bore;
  const ring = [[0, 0], [outer, 0], [outer, outer], [0, outer]];
  const hole = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];
  const tris = [];
  const at = (x, y, z) => [x, y, z];

  // Outer walls: outward normals.
  for (let i = 0; i < 4; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % 4];
    tris.push([at(ax, 0, az), at(bx, 0, bz), at(bx, height, bz)]);
    tris.push([at(ax, 0, az), at(bx, height, bz), at(ax, height, az)]);
  }
  // Bore walls: normals point INTO the bore, i.e. reversed.
  for (let i = 0; i < 4; i++) {
    const [ax, az] = hole[i];
    const [bx, bz] = hole[(i + 1) % 4];
    tris.push([at(ax, 0, az), at(bx, height, bz), at(bx, 0, bz)]);
    tris.push([at(ax, 0, az), at(ax, height, az), at(bx, height, bz)]);
  }
  // End caps: ring minus hole, as four quads each.
  const capQuads = [
    [ring[0], ring[1], [hi, lo], [lo, lo]],
    [ring[1], ring[2], [hi, hi], [hi, lo]],
    [ring[2], ring[3], [lo, hi], [hi, hi]],
    [ring[3], ring[0], [lo, lo], [lo, hi]],
  ];
  for (const [a, b, c, d] of capQuads) {
    // y = 0 cap faces -Y.
    tris.push([at(a[0], 0, a[1]), at(d[0], 0, d[1]), at(c[0], 0, c[1])]);
    tris.push([at(a[0], 0, a[1]), at(c[0], 0, c[1]), at(b[0], 0, b[1])]);
    // y = height cap faces +Y.
    tris.push([at(a[0], height, a[1]), at(c[0], height, c[1]), at(d[0], height, d[1])]);
    tris.push([at(a[0], height, a[1]), at(b[0], height, b[1]), at(c[0], height, c[1])]);
  }
  // Wound inside-out as first written — the volume check caught it, which is
  // the point of testing volume rather than eyeballing a render.
  return new Float32Array(tris.map(([a, b, c]) => [a, c, b]).flat(2));
}

/** Every edge used exactly twice, and in opposite directions. */
function openEdges(positions) {
  const key = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const seen = new Map();
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const p = [
      key(positions[i], positions[i + 1], positions[i + 2]),
      key(positions[i + 3], positions[i + 4], positions[i + 5]),
      key(positions[i + 6], positions[i + 7], positions[i + 8]),
    ];
    for (let e = 0; e < 3; e++) {
      const a = p[e];
      const b = p[(e + 1) % 3];
      if (a === b) continue; // degenerate sliver, not an edge
      const forward = `${a}|${b}`;
      const backward = `${b}|${a}`;
      if (seen.get(backward)) seen.set(backward, seen.get(backward) - 1);
      else seen.set(forward, (seen.get(forward) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of seen.values()) open += Math.abs(count);
  return open;
}

test("a cube cut in half gives two watertight halves", async () => {
  const { cutByPlane, meshVolume } = await load();
  const positions = new Float32Array(box(20, 20, 20));
  const result = cutByPlane(positions, { normal: { x: 0, y: 1, z: 0 }, offset: 10 });
  assert.ok(result);
  assert.equal(result.openChains, 0, "a closed cube has no open chains");
  assert.equal(result.skippedLoops, 0);
  assert.equal(result.cappedLoops, 1, "one cross-section loop");
  assert.equal(openEdges(result.upper), 0, "upper half is not closed");
  assert.equal(openEdges(result.lower), 0, "lower half is not closed");
});

test("and the two halves still add up to the whole", async () => {
  const { cutByPlane, meshVolume } = await load();
  const positions = new Float32Array(box(20, 20, 20));
  const whole = meshVolume(positions);
  assert.ok(Math.abs(whole - 8000) < 1e-3, `cube volume ${whole}`);
  const result = cutByPlane(positions, { normal: { x: 0, y: 1, z: 0 }, offset: 7 });
  const upper = meshVolume(result.upper);
  const lower = meshVolume(result.lower);
  // A cap wound the wrong way inverts a half and shows up here as a sign error,
  // which no amount of looking at the render would catch.
  assert.ok(Math.abs(lower - 20 * 20 * 7) < 1e-2, `lower ${lower}`);
  assert.ok(Math.abs(upper - 20 * 20 * 13) < 1e-2, `upper ${upper}`);
  assert.ok(Math.abs(upper + lower - whole) < 1e-2, `${upper} + ${lower} != ${whole}`);
});

test("cutting a tube leaves the bore open instead of filling it", async () => {
  const { cutByPlane, meshVolume } = await load();
  const positions = tube(20, 8, 30);
  const whole = meshVolume(positions);
  assert.ok(Math.abs(whole - (20 * 20 - 8 * 8) * 30) < 1e-2, `tube volume ${whole}`);

  const result = cutByPlane(positions, { normal: { x: 0, y: 1, z: 0 }, offset: 12 });
  assert.ok(result);
  // Two loops at this height: the outer square and the bore.
  assert.equal(result.cappedLoops, 1, "one outer loop, with the bore bridged into it as a hole");
  assert.equal(result.openChains, 0);
  const upper = meshVolume(result.upper);
  const lower = meshVolume(result.lower);
  // If the bore were capped over, the lower half would gain 8*8*12 = 768.
  assert.ok(Math.abs(lower - (20 * 20 - 8 * 8) * 12) < 1e-1, `lower ${lower} — bore filled?`);
  assert.ok(Math.abs(upper + lower - whole) < 1e-1, `${upper} + ${lower} != ${whole}`);
});

test("a plane that misses the model leaves it whole on one side", async () => {
  const { cutByPlane, meshVolume } = await load();
  const positions = new Float32Array(box(20, 20, 20));
  const above = cutByPlane(positions, { normal: { x: 0, y: 1, z: 0 }, offset: 50 });
  assert.equal(above.upperTriangles, 0);
  assert.equal(above.lowerTriangles, 12, "everything below, untouched");
  assert.equal(above.cappedLoops, 0, "nothing to cap");
  const below = cutByPlane(positions, { normal: { x: 0, y: 1, z: 0 }, offset: -50 });
  assert.equal(below.lowerTriangles, 0);
  assert.equal(below.upperTriangles, 12);
});

test("a slanted plane cuts just as cleanly", async () => {
  const { cutByPlane, meshVolume } = await load();
  const positions = new Float32Array(box(20, 20, 20));
  const whole = meshVolume(positions);
  const n = { x: 0, y: Math.SQRT1_2, z: Math.SQRT1_2 };
  // Through the centre: n·(10,10,10) = 10*(0.7071+0.7071).
  const offset = 10 * Math.SQRT1_2 + 10 * Math.SQRT1_2;
  const result = cutByPlane(positions, { normal: n, offset });
  assert.ok(result);
  assert.equal(result.openChains, 0);
  assert.equal(openEdges(result.upper), 0, "upper half is not closed");
  assert.equal(openEdges(result.lower), 0, "lower half is not closed");
  // This plane runs along whole cube EDGES, so it must have been moved clear —
  // without that the cross-section produces no segments on those sides and the
  // cap goes silently missing.
  assert.equal(result.nudged, true, "a plane sitting on the geometry must be nudged off it");
  const upper = meshVolume(result.upper);
  const lower = meshVolume(result.lower);
  assert.ok(Math.abs(upper + lower - whole) < 1e-2, `${upper} + ${lower} != ${whole}`);
  // Through the centre of a cube a 45-degree plane halves it, up to the nudge:
  // at most 24*eps of offset across a 20 x 20*sqrt(2) section, so well under
  // half a cubic millimetre out of 8000.
  assert.ok(Math.abs(upper - lower) < 0.5, `${upper} vs ${lower}`);
});

test("capping can be turned off, and says so in the counts", async () => {
  const { cutByPlane } = await load();
  const positions = new Float32Array(box(20, 20, 20));
  const result = cutByPlane(positions, { normal: { x: 0, y: 1, z: 0 }, offset: 10 }, { cap: false });
  assert.equal(result.cappedLoops, 0);
  // Uncapped halves are open by exactly the cross-section's perimeter.
  assert.ok(openEdges(result.upper) > 0, "an uncapped half must be open, and must admit it");
});

test("a mesh with a hole in it reports an open chain instead of pretending", async () => {
  const { cutByPlane } = await load();
  const full = box(20, 20, 20);
  // Drop one side wall: the cut now runs through a gap in the skin.
  const holed = new Float32Array([...full.slice(0, 8 * 9), ...full.slice(10 * 9)]);
  const result = cutByPlane(holed, { normal: { x: 0, y: 1, z: 0 }, offset: 10 });
  assert.ok(result);
  assert.ok(result.openChains > 0 || result.cappedLoops === 0,
    `a holed mesh must not silently claim a clean cap: ${JSON.stringify(result)}`);
});

test("degenerate input is refused rather than guessed at", async () => {
  const { cutByPlane } = await load();
  assert.equal(cutByPlane(new Float32Array(0), { normal: { x: 0, y: 1, z: 0 }, offset: 0 }), null);
  assert.equal(cutByPlane(new Float32Array(9), { normal: { x: 0, y: 0, z: 0 }, offset: 0 }), null,
    "a zero normal is not a plane");
});

test("extentAlong reports what a cut-height control needs", async () => {
  const { extentAlong } = await load();
  const positions = new Float32Array(box(10, 90, 30));
  const y = extentAlong(positions, { x: 0, y: 1, z: 0 });
  assert.equal(y.min, 0);
  assert.equal(y.max, 90);
  const x = extentAlong(positions, { x: 1, y: 0, z: 0 });
  assert.equal(x.max, 10);
});
