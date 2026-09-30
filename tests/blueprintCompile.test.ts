/**
 * THE PARTS READER AND THE BLUEPRINT COMPILER (Programme C, C1 lane L4;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.2 items 1, 2 and 6, §0 row 21).
 *
 * Held to real bytes in the shapes real exporters write
 * (tests/fixtures/meshParts.ts) and to answers worked out by hand: a
 * translated component must land where the transform puts it, a trailer must
 * be exactly `'LVR1' | u16 parts | u16 0 | parts × (u32 start, u32 count)`,
 * a hidden part must leave its index behind with a count of 0.
 *
 * And the line this lane must not cross: `analyseModel` and `viewerMesh` are
 * priced and pinned (tests/modelGeometry.test.ts,
 * tests/printQuoteGeometry.test.ts), so for the Bambu assembly they still
 * answer exactly what they answered before `parseModelParts` existed — the
 * snapshot below was taken from the untouched functions before this lane's
 * first edit.
 *
 * Run: node --import tsx --test tests/blueprintCompile.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { analyseModel, parseModelParts, readModelArchive, viewerMesh } from '../worker/lib/modelGeometry';
import {
  BLUEPRINT_MAX_PARTS,
  compileBlueprintMesh,
  compileBlueprintSource,
  draftMeshKey,
  gunzipBytes,
  gzipBytes,
  meshHash,
  meshSnapMm,
  publicMeshKey,
  readLvr1,
  withoutParts,
  type CompileResult,
  type StlSourceFile,
} from '../worker/lib/personalize/compile';
import { isAnonymousPublicMediaKey, isSafeMediaKey } from '../worker/lib/mediaStorage';
import * as F from './fixtures/meshParts';

// ------------------------------------------------------------------ helpers

const near = (actual: number, expected: number, tol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

const nearAll = (actual: readonly number[], expected: readonly number[], tol: number, what: string) => {
  assert.equal(actual.length, expected.length, `${what}: length`);
  actual.forEach((v, i) => near(v, expected[i], tol, `${what}[${i}]`));
};

/** [minX, minY, minZ, maxX, maxY, maxZ] of a flat soup. */
function boxOf(p: Float32Array | number[]): number[] {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const k = i % 3;
    if (p[i] < b[k]) b[k] = p[i];
    if (p[i] > b[k + 3]) b[k + 3] = p[i];
  }
  return b;
}

/** The triangle floats of an LVM1 mesh, read the way the viewer reads them. */
function lvmFloats(lvm: Uint8Array, from = 0, count?: number): number[] {
  const dv = new DataView(lvm.buffer, lvm.byteOffset, lvm.byteLength);
  const n = count ?? dv.getUint32(4, true) - from;
  const out: number[] = [];
  for (let i = 0; i < n * 9; i++) out.push(dv.getFloat32(32 + (from * 9 + i) * 4, true));
  return out;
}

function compiled(r: CompileResult): Extract<CompileResult, { ok: true }> {
  if (!r.ok) assert.fail(`expected a compiled mesh, got ${JSON.stringify(r)}`);
  return r;
}

function partsOf(r: ReturnType<typeof parseModelParts>) {
  if (!r.ok) assert.fail(`expected parts, got ${JSON.stringify(r)}`);
  return r;
}

/** Three 10 mm cubes, each centred on the origin in its own file, placed by stored bboxes along X. */
const threeStl = (): StlSourceFile[] => [
  { name: 'Body.stl', bytes: F.binaryStl(F.boxTriangles(10, 10, 10, -5, -5, -5)), bbox_min_mm: { x: 0, y: 0, z: 0 }, bbox_max_mm: { x: 10, y: 10, z: 10 } },
  { name: 'Cap.stl', bytes: F.binaryStl(F.boxTriangles(10, 10, 10, -5, -5, -5)), bbox_min_mm: [20, 0, 0], bbox_max_mm: [30, 10, 10] },
  { name: 'Ring.stl', bytes: F.binaryStl(F.boxTriangles(10, 10, 10, -5, -5, -5)), bbox_min_mm: { x: 40, y: 0, z: 0 }, bbox_max_mm: { x: 50, y: 10, z: 10 } },
];

/**
 * `analyseModel` on the Bambu fixture, captured from the UNTOUCHED function
 * before this lane's first edit to worker/lib/modelGeometry.ts (the scratch
 * baseline also hashed `viewerMesh` over fourteen fixtures, before and after:
 * identical). A root object with only `<components>` is not a mesh to
 * `parse3mf`, and that stays its answer.
 */
const BAMBU_ANALYSIS_BEFORE = {
  format: '3mf',
  capability: { previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false },
  measured: false,
  reason: 'PARSE_FAILED: 3MF has no mesh',
  unit: 'mm',
  unit_source: 'assumed',
  dimensions_mm: { x: 0, y: 0, z: 0 },
  bbox_min_mm: { x: 0, y: 0, z: 0 },
  bbox_max_mm: { x: 0, y: 0, z: 0 },
  volume_mm3: 0,
  surface_area_mm2: 0,
  triangle_count: 0,
  shell_count: null,
  watertight: null,
  overhang_area_mm2: 0,
  overhang_ratio: 0,
  bed_contact_area_mm2: 0,
  complexity: 0,
  warnings: [],
};

// ------------------------------------------- 1. the modelGeometry probes

test('a Bambu assembly is read into its parts, while analyseModel and viewerMesh answer exactly as before', () => {
  const bytes = F.bambuAssembly3mf();

  // The untouched path: still unmeasured, still no preview — byte for byte.
  assert.deepEqual(JSON.parse(JSON.stringify(analyseModel(bytes, 'keychain.3mf'))), BAMBU_ANALYSIS_BEFORE);
  assert.equal(viewerMesh(bytes, 'keychain.3mf'), null);

  // The new path: not NO_GEOMETRY — two named, coloured parts; the modifier is no part.
  const r = partsOf(parseModelParts(bytes, 'keychain.3mf'));
  assert.equal(r.format, '3mf');
  assert.equal(r.unit, 'mm');
  assert.equal(r.unit_source, 'declared');
  assert.equal(r.triangles, 24);
  assert.deepEqual(r.parts.map((p) => p.name), ['Body', 'Name plate']);
  assert.deepEqual(r.parts.map((p) => p.colour), ['#ffffff', '#d32f2f'], 'the extruder filament colours from project_settings.config');
  assert.deepEqual(r.parts.map((p) => p.extruder), [1, 2]);
  assert.deepEqual(r.parts.map((p) => p.group), ['Keychain', 'Keychain']);
  assert.ok(r.warnings.includes('MODIFIERS_SKIPPED'));
  // The translated component sits on the body: (2, 8, 5) inside the item's (128, 128, 0).
  assert.deepEqual(boxOf(r.parts[0].positions), [128, 128, 0, 148, 148, 5]);
  assert.deepEqual(boxOf(r.parts[1].positions), [130, 136, 5, 146, 140, 7]);
});

test('transforms compose in order — the component first, then the build item', () => {
  // The item turns the whole assembly 90° about Z and moves it 100 mm along X.
  const turned = partsOf(parseModelParts(F.bambuAssembly3mf({ itemTransform: F.T3.rotZ90(100, 0, 0) }), 'a.3mf'));
  assert.deepEqual(boxOf(turned.parts[0].positions), [80, 0, 0, 100, 20, 5]);
  assert.deepEqual(boxOf(turned.parts[1].positions), [88, 2, 5, 92, 18, 7]);

  // The component itself turns the plate: x' = 10 − y, y' = x + 2, z' = z + 5, then the item's (128, 128, 0).
  const plate = partsOf(parseModelParts(F.bambuAssembly3mf({ plateTransform: F.T3.rotZ90(10, 2, 5) }), 'a.3mf'));
  assert.deepEqual(boxOf(plate.parts[1].positions), [134, 130, 5, 138, 146, 7]);
});

test('a compiled Bambu assembly keeps the plate where the transform put it (± half a snap), and no name in the bytes', async () => {
  const r = compiled(await compileBlueprintSource([{ name: 'keychain.3mf', bytes: F.bambuAssembly3mf() }], { maxTriangles: 60_000 }));
  assert.equal(r.format, '3mf');
  assert.equal(r.snap_mm, 0.2);
  assert.equal(r.triangles, 24);
  assert.deepEqual(r.parts.map((p) => [p.n, p.name, p.triangles, p.colour, p.extruder]), [
    [0, 'Body', 12, '#ffffff', 1],
    [1, 'Name plate', 12, '#d32f2f', 2],
  ]);
  // One centring for the whole assembly: its bbox centre (138, 138, 3.5) is the origin.
  const tol = r.snap_mm / 2 + 1e-4;
  nearAll(r.parts[0].bbox_mm, [-10, -10, -3.5, 10, 10, 1.5], tol, 'body');
  nearAll(r.parts[1].bbox_mm, [-8, -2, 1.5, 8, 2, 3.5], tol, 'name plate');
  nearAll(r.dims_mm, [20, 20, 7], r.snap_mm + 1e-4, 'dims');
  // Volume shares: 2000 mm³ of body, 128 mm³ of plate.
  near(r.parts[0].volume_mm3, 2000, 1e-6, 'body volume');
  near(r.parts[0].share + r.parts[1].share, 1, 1e-3, 'shares add up');
  assert.ok(r.parts[0].share > 0.9);

  const text = Buffer.from(r.lvm).toString('latin1');
  for (const secret of ['Body', 'Name plate', 'Keychain', 'd32f2f', 'D32F2F', 'object_1']) {
    assert.equal(text.includes(secret), false, `"${secret}" must never be written into the mesh`);
  }
  assert.equal(r.hash, createHash('sha256').update(r.lvm).digest('hex'));
});

// ---------------------------------------------- 2. the layout, exactly

test('LVM1 header, triangles and the LVR1 trailer are exactly the documented layout', async () => {
  const r = compiled(await compileBlueprintSource(threeStl(), { maxTriangles: 60_000 }));
  const { lvm } = r;
  const T = 36;
  const P = 3;
  assert.equal(lvm.byteLength, 32 + 36 * T + 8 + 8 * P, '32 + 36·T + 8 + 8·parts');
  const dv = new DataView(lvm.buffer, lvm.byteOffset, lvm.byteLength);
  assert.deepEqual([...lvm.subarray(0, 4)], [0x4c, 0x56, 0x4d, 0x31], "'LVM1'");
  assert.equal(dv.getUint32(4, true), T);
  const header = [0, 1, 2, 3, 4, 5].map((k) => dv.getFloat32(8 + k * 4, true));
  // The header box is the box of the floats as stored, and the reported one.
  assert.deepEqual(header, boxOf(lvmFloats(lvm)));
  nearAll(header, r.bbox_mm, 1e-3, 'header vs bbox_mm');

  const at = 32 + 36 * T;
  assert.deepEqual([...lvm.subarray(at, at + 4)], [0x4c, 0x56, 0x52, 0x31], "'LVR1'");
  assert.equal(dv.getUint16(at + 4, true), P);
  assert.equal(dv.getUint16(at + 6, true), 0, 'the reserved u16 is 0');
  const ranges = [0, 1, 2].map((i) => [dv.getUint32(at + 8 + i * 8, true), dv.getUint32(at + 12 + i * 8, true)]);
  assert.deepEqual(ranges, [[0, 12], [12, 12], [24, 12]], 'contiguous, in part order, counted in triangles');
  assert.deepEqual(readLvr1(lvm), { triangles: T, ranges });

  // Each range holds exactly its part's triangles.
  r.parts.forEach((p, i) => {
    nearAll(boxOf(lvmFloats(lvm, ranges[i][0], ranges[i][1])), p.bbox_mm, 1e-3, `range ${i} is part ${p.name}`);
  });
  // Today's viewer parser rejects only a buffer shorter than the triangles — the trailer rides along.
  assert.ok(lvm.byteLength >= 32 + dv.getUint32(4, true) * 9 * 4);
});

// ---------------------------------------------------- 3. every format

test('a core 3MF: two build items, colours from basematerials and a colour group, the declared unit applied', () => {
  const mm = partsOf(parseModelParts(F.twoItem3mf(), 'box.3mf'));
  assert.deepEqual(mm.parts.map((p) => [p.name, p.colour, p.group, p.triangles]), [
    ['Base', '#1b7f3b', 'Base', 12],
    ['Lid', '#ffc107', 'Lid', 12],
  ]);
  assert.deepEqual(boxOf(mm.parts[1].positions), [0, 0, 12, 30, 30, 15], 'the second item is 12 mm up');

  const cm = partsOf(parseModelParts(F.twoItem3mf('centimeter'), 'box.3mf'));
  assert.deepEqual(boxOf(cm.parts[0].positions), [0, 0, 0, 300, 300, 100], 'centimetres read as millimetres × 10');
  assert.deepEqual(boxOf(cm.parts[1].positions), [0, 0, 120, 300, 300, 150], 'the item translation is in the file unit too');
});

test('PrusaSlicer volumes are triangle ranges of one object, named, coloured by extruder; the modifier is no part', () => {
  const r = partsOf(parseModelParts(F.prusaVolumes3mf(), 'sign.3mf'));
  assert.deepEqual(r.parts.map((p) => [p.name, p.triangles, p.extruder, p.colour, p.group]), [
    ['Sign body', 12, 1, '#1e88e5', 'Sign'], // extruder_colour empty → filament_colour
    ['Raised text', 12, 2, '#00ff00', 'Sign'],
  ]);
  assert.deepEqual(boxOf(r.parts[1].positions), [105, 107, 4, 135, 113, 5.5]);
  assert.ok(r.warnings.includes('MODIFIERS_SKIPPED'));
});

test('painted triangles are reported as ignored, never turned into parts', () => {
  const r = partsOf(parseModelParts(F.bambuAssembly3mf({ painted: true }), 'painted.3mf'));
  assert.equal(r.parts.length, 2);
  assert.ok(r.warnings.includes('PAINT_IGNORED'));
});

test('an OBJ splits by o / g / usemtl, relative indices included, millimetres assumed', () => {
  const r = partsOf(parseModelParts(F.objGroups(), 'name.obj'));
  assert.deepEqual(r.parts.map((p) => [p.name, p.triangles, p.group, p.colour]), [
    ['Body', 12, 'Body', undefined],
    ['Letters · White', 6, 'Name', undefined],
    ['Letters · Black', 6, 'Name', undefined],
  ]);
  assert.deepEqual(boxOf(r.parts[1].positions), [2, 8, 5, 18, 12, 7], 'negative indices count back from the last vertex');
  assert.equal(r.unit_source, 'assumed');
  assert.ok(r.warnings.includes('UNIT_ASSUMED'));
});

test('a GLB is read through its scene: names, TRS and matrix composed, metres to millimetres, Y up to Z up', () => {
  const r = partsOf(parseModelParts(F.glbNodes(), 'stand.glb'));
  assert.equal(r.unit_source, 'declared');
  assert.deepEqual(r.parts.map((p) => [p.name, p.colour, p.group, p.triangles]), [
    ['Base', '#808080', 'Stand', 12], // the node's name; baseColorFactor is linear, shown as sRGB
    ['Topper', '#ff0000', 'Stand', 12], // no node name: the mesh's
  ]);
  nearAll(boxOf(r.parts[0].positions), [70, 0, 0, 100, 30, 10], 1e-3, 'base');
  nearAll(boxOf(r.parts[1].positions), [80, 10, 10, 90, 20, 30], 1e-3, 'topper: 10 mm up in glTF Y is 10 mm up in Z');

  // No nodes at all: the meshes, untransformed; ten units long is no ten-metre part.
  const box = F.boxIndexed(10, 10, 10);
  const pos = new Float32Array(box.vertices.flat());
  const idx = new Uint16Array(box.faces.flat());
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const bare = F.glb(
    {
      asset: { version: '2.0' },
      buffers: [{ byteLength: bin.length }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
        { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
      ],
      meshes: [{ name: 'Cube', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    },
    bin
  );
  const b = partsOf(parseModelParts(bare, 'cube.glb'));
  assert.deepEqual(b.parts.map((p) => p.name), ['Cube']);
  assert.ok(b.warnings.includes('NO_SCENE') && b.warnings.includes('UNIT_GUESSED'));
  assert.equal(b.unit_source, 'assumed');
  nearAll(boxOf(b.parts[0].positions), [0, -10, 0, 10, 0, 10], 1e-6, 'read as millimetres, turned Z-up');

  const draco = parseModelParts(F.glbDraco(), 'd.glb');
  assert.deepEqual(draco, { ok: false, code: 'UNSUPPORTED', format: 'glb', hint: 'compressed_gltf' });
});

test('STL: one part per file, one per named solid of an ASCII file', () => {
  const one = partsOf(parseModelParts(F.binaryStl(F.boxTriangles(10, 10, 10)), 'uploads/Door handle.stl'));
  assert.deepEqual(one.parts.map((p) => [p.name, p.triangles]), [['Door handle', 12]]);
  const solids = partsOf(
    parseModelParts(F.asciiStl([{ name: 'shell', tris: F.boxTriangles(10, 10, 10) }, { name: 'insert', tris: F.boxTriangles(5, 5, 5, 20) }]), 'two.stl')
  );
  assert.deepEqual(solids.parts.map((p) => [p.name, p.triangles]), [['shell', 12], ['insert', 12]]);
  assert.deepEqual(boxOf(solids.parts[1].positions), [20, 0, 0, 25, 5, 5]);
});

test('three STL files are placed by their stored bboxes, one part each', async () => {
  const r = compiled(await compileBlueprintSource(threeStl(), { maxTriangles: 60_000 }));
  assert.equal(r.format, 'stl');
  assert.deepEqual(r.parts.map((p) => p.name), ['Body', 'Cap', 'Ring']);
  nearAll(r.dims_mm, [50, 10, 10], 1e-6, 'dims');
  nearAll(r.parts[0].bbox_mm, [-25, -5, -5, -15, 5, 5], 1e-3, 'body');
  nearAll(r.parts[1].bbox_mm, [-5, -5, -5, 5, 5, 5], 1e-3, 'cap');
  nearAll(r.parts[2].bbox_mm, [15, -5, -5, 25, 5, 5], 1e-3, 'ring');
  assert.deepEqual(r.parts.map((p) => p.share), [0.3333, 0.3333, 0.3333]);

  // Without stored bboxes a file keeps its own coordinates.
  const own = compiled(await compileBlueprintMesh({ kind: 'stl_set', files: threeStl().map(({ name, bytes }) => ({ name, bytes })) }, { maxTriangles: 60_000 }));
  nearAll(own.dims_mm, [10, 10, 10], 1e-6, 'all three at the origin');

  // A stored box that is not this file's is named, and the piece still goes to its centre.
  const off = threeStl();
  off[1].bbox_max_mm = [60, 10, 10];
  const mismatch = compiled(await compileBlueprintSource(off, { maxTriangles: 60_000 }));
  assert.ok(mismatch.warnings.includes('BBOX_MISMATCH'));

  const mixed = await compileBlueprintSource([threeStl()[0], { name: 'k.3mf', bytes: F.bambuAssembly3mf() }], { maxTriangles: 60_000 });
  assert.deepEqual(mixed, { ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: '3mf', hint: 'mixed_files' });
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ name: `p${i}.stl`, bytes: F.binaryStl(F.boxTriangles(1, 1, 1, i * 2)) }));
  assert.deepEqual(await compileBlueprintSource(thirteen, { maxTriangles: 60_000 }), {
    ok: false, code: 'BLUEPRINT_MODEL_UNREADABLE', format: 'stl', hint: 'too_many_files',
  });
});

// ------------------------------------------------------------ 4. the rules

test('every coordinate is snapped to max(0.2 mm, longest side / 500)', async () => {
  assert.equal(meshSnapMm(20), 0.2);
  assert.equal(meshSnapMm(100), 0.2);
  assert.equal(meshSnapMm(250), 0.5);
  assert.equal(meshSnapMm(1000), 2);

  for (const [label, tris, snap] of [
    ['a 250 mm sphere', F.sphereTriangles(125, 24, 12), 0.5],
    ['a 34 mm sphere', F.sphereTriangles(17, 24, 12), 0.2],
  ] as const) {
    const r = compiled(await compileBlueprintSource([{ name: 's.stl', bytes: F.binaryStl(tris as F.Tri[]) }], { maxTriangles: 60_000 }));
    near(r.snap_mm, snap, 1e-6, `${label}: snap`);
    for (const v of lvmFloats(r.lvm)) {
      const k = v / r.snap_mm;
      assert.ok(Math.abs(k - Math.round(k)) < 1e-3, `${label}: ${v} is not on the ${r.snap_mm} mm grid`);
    }
  }
});

test('above maxTriangles the compile refuses — it never thins the mesh', async () => {
  const set = threeStl();
  assert.deepEqual(await compileBlueprintSource(set, { maxTriangles: 30 }), {
    ok: false, code: 'BLUEPRINT_TOO_HEAVY', triangles: 36, max: 30,
  });
  assert.equal((await compileBlueprintSource(set, { maxTriangles: 36 })).ok, true, 'exactly the limit is allowed');

  // Counted before anything is built: the 3MF tags, the OBJ faces, the glTF accessors.
  assert.deepEqual(parseModelParts(F.bambuAssembly3mf(), 'k.3mf', { maxTriangles: 20 }), {
    ok: false, code: 'TOO_HEAVY', format: '3mf', hint: 'too_heavy', triangles: 24,
  });
  assert.deepEqual(await compileBlueprintSource([{ name: 'k.3mf', bytes: F.bambuAssembly3mf() }], { maxTriangles: 20 }), {
    ok: false, code: 'BLUEPRINT_TOO_HEAVY', triangles: 24, max: 20,
  });
  assert.deepEqual(parseModelParts(F.objManyObjects(70), 'm.obj', { maxTriangles: 100 }), {
    ok: false, code: 'TOO_HEAVY', format: 'obj', hint: 'too_heavy', triangles: 140,
  });
  assert.deepEqual(parseModelParts(F.glbNodes(), 's.glb', { maxTriangles: 23 }), {
    ok: false, code: 'TOO_HEAVY', format: 'glb', hint: 'too_heavy', triangles: 24,
  });
});

test('more than 64 parts: the file\'s own groups merge first, smallest first; then the smallest pieces', async () => {
  // 5 objects × 14 materials = 70 parts in 5 groups: merging ONE group (−13) is enough.
  const grouped = partsOf(parseModelParts(F.objManyObjects(5, 14), 'g.obj'));
  assert.equal(grouped.parts.length, 70);
  const g = compiled(await compileBlueprintMesh({ kind: 'model', parts: grouped.parts, format: 'obj' }, { maxTriangles: 60_000 }));
  assert.equal(g.parts.length, 57);
  assert.deepEqual([g.parts[0].name, g.parts[0].triangles], ['piece_0', 28]);
  assert.equal(g.parts[1].name, 'piece_1 · m0');
  assert.ok(g.warnings.includes('PARTS_MERGED'));

  // 70 one-piece objects: the 63 largest stay, the rest become «Other parts».
  const flat = partsOf(parseModelParts(F.objManyObjects(70), 'f.obj'));
  const f = compiled(await compileBlueprintMesh({ kind: 'model', parts: flat.parts, format: 'obj' }, { maxTriangles: 60_000 }));
  assert.equal(f.parts.length, BLUEPRINT_MAX_PARTS);
  assert.deepEqual([f.parts[63].name, f.parts[63].triangles], ['Other parts', 14]);
  assert.equal(readLvr1(f.lvm)?.ranges.length, 64);
  assert.equal(f.triangles, 140, 'merging never drops a triangle');
});

// ------------------------------------------------- 5. the public copy

test('withoutParts removes a part by range copy and keeps every index', async () => {
  const { lvm } = compiled(await compileBlueprintSource(threeStl(), { maxTriangles: 60_000 }));
  const pub = withoutParts(lvm, [1]);
  assert.equal(pub.byteLength, 32 + 36 * 24 + 8 + 8 * 3);
  assert.deepEqual(readLvr1(pub), { triangles: 24, ranges: [[0, 12], [12, 0], [12, 12]] });
  // Range copies: the kept triangles are the same bytes.
  assert.deepEqual(pub.subarray(32, 32 + 12 * 36), lvm.subarray(32, 32 + 12 * 36));
  assert.deepEqual(pub.subarray(32 + 12 * 36, 32 + 24 * 36), lvm.subarray(32 + 24 * 36, 32 + 36 * 36));

  // The header box is recomputed over what remains; coordinates are not re-centred.
  const noRing = withoutParts(lvm, [2]);
  const dv = new DataView(noRing.buffer);
  near(dv.getFloat32(20, true), 5, 1e-6, 'max x is now the cap\'s');
  near(dv.getFloat32(8, true), -25, 1e-6, 'min x is still the body\'s');

  assert.deepEqual(withoutParts(lvm, []), lvm, 'hiding nothing changes nothing');
  assert.deepEqual(withoutParts(lvm, [7, -1, 1.5]), lvm, 'indices outside the trailer are ignored');
  const none = withoutParts(lvm, [0, 1, 2]);
  assert.deepEqual(readLvr1(none), { triangles: 0, ranges: [[0, 0], [0, 0], [0, 0]] });
  assert.deepEqual([...new Float32Array(none.buffer.slice(8, 32))], [0, 0, 0, 0, 0, 0]);

  // A bare LVM1 (a request preview) is one part; the copy gains a trailer.
  const bare = viewerMesh(F.binaryStl(F.boxTriangles(10, 10, 10)), 'c.stl')!;
  assert.equal(readLvr1(bare), null);
  assert.deepEqual(readLvr1(withoutParts(bare, [])), { triangles: 12, ranges: [[0, 12]] });
  assert.throws(() => withoutParts(new Uint8Array(40), []), /not an LVM1 mesh/);
});

test('readLvr1 refuses anything but a contiguous trailer that covers the mesh', async () => {
  const { lvm } = compiled(await compileBlueprintSource(threeStl(), { maxTriangles: 60_000 }));
  const at = 32 + 36 * 36;
  const broken = (mutate: (dv: DataView) => void) => {
    const copy = lvm.slice();
    mutate(new DataView(copy.buffer));
    return readLvr1(copy);
  };
  assert.equal(broken((dv) => dv.setUint32(at + 16, 13, true)), null, 'a gap');
  assert.equal(broken((dv) => dv.setUint32(at + 20, 11, true)), null, 'short of the total');
  assert.equal(broken((dv) => dv.setUint16(at + 6, 1, true)), null, 'the reserved field set');
  assert.equal(broken((dv) => dv.setUint8(at, 0x58)), null, 'no magic');
  assert.equal(readLvr1(lvm.subarray(0, lvm.byteLength - 1)), null, 'truncated');
  assert.equal(readLvr1(new Uint8Array(8)), null);
});

// ------------------------------------------------- 6. storage and keys

test('the gzip round trip is exact, readable by any gunzip, and the hash is the uncompressed mesh\'s', async () => {
  const r = compiled(await compileBlueprintSource([{ name: 'k.3mf', bytes: F.bambuAssembly3mf() }], { maxTriangles: 60_000 }));
  const gz = await gzipBytes(r.lvm);
  assert.deepEqual([gz[0], gz[1]], [0x1f, 0x8b], 'gzip magic');
  assert.ok(gz.byteLength < r.lvm.byteLength);
  assert.deepEqual(await gunzipBytes(gz), r.lvm);
  assert.deepEqual(new Uint8Array(gunzipSync(gz)), r.lvm, 'what a browser DecompressionStream reads, zlib reads too');
  await assert.rejects(gunzipBytes(gz, 100), /MESH_TOO_LARGE/);
  assert.equal(await meshHash(r.lvm), r.hash);
  assert.match(r.hash, /^[0-9a-f]{64}$/);
});

test('the mesh keys: a public one /files serves as is, a private one it refuses', () => {
  const hash = 'ab'.repeat(32);
  const pub = publicMeshKey('u_1', 'bp_7f3a', 3, hash);
  assert.equal(pub, 'merchants/u_1/public/bp/bp_7f3a-r3-abababababab.lvm.gz');
  assert.ok(isSafeMediaKey(pub));
  assert.equal(isAnonymousPublicMediaKey(pub), true, 'the existing public prefix — no reader change needed');

  const draft = draftMeshKey('u_1', 'cp_9', hash);
  assert.equal(draft, 'merchants/u_1/blueprints/cp_9-abababababab.lvm.gz');
  assert.ok(isSafeMediaKey(draft));
  assert.equal(isAnonymousPublicMediaKey(draft), false, 'private: /files answers 404');

  assert.throws(() => publicMeshKey('u_1', 'bp_7f3a', 0, hash), /revision/);
  assert.throws(() => publicMeshKey('u_1', 'bp_7f3a', 1, 'XYZ'), /hash/);
  assert.throws(() => publicMeshKey('../u', 'bp', 1, hash), /owner/);
  assert.throws(() => draftMeshKey('u_1', 'a/b', hash), /product/);
});

// --------------------------------------------- 7. refusals and the reader

test('a file the reader cannot use says why, never throws', () => {
  const step = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_NAME('x.step');\nENDSEC;\n");
  assert.deepEqual(parseModelParts(step, 'x.step'), { ok: false, code: 'UNSUPPORTED', format: 'step', hint: 'export_mesh' });
  const good = F.bambuAssembly3mf();
  assert.deepEqual(parseModelParts(good.subarray(0, good.length >> 1), 'half.3mf'), {
    ok: false, code: 'UNREADABLE', format: '3mf', hint: 'damaged',
  });
  assert.deepEqual(parseModelParts(new TextEncoder().encode('# nothing\nv 0 0 0\n'), 'empty.obj'), {
    ok: false, code: 'NO_GEOMETRY', format: 'obj', hint: 'empty',
  });
  // A ZIP that inflates far past its size is a bomb to the shared bound, and damaged to the merchant.
  const bomb = zipSync({ '3D/3dmodel.model': strToU8('<model>' + ' '.repeat(3 * 1024 * 1024) + '</model>') });
  assert.throws(() => readModelArchive(bomb), /ARCHIVE_TOO_DEEP/, 'the shared bound, counted before a byte inflates');
  assert.deepEqual(parseModelParts(bomb, 'bomb.3mf'), { ok: false, code: 'UNREADABLE', format: '3mf', hint: 'damaged' });
  assert.equal(parseModelParts(F.bambuAssembly3mf().buffer as ArrayBuffer, 'k.3mf').ok, true, 'an ArrayBuffer is read too');
});

test('the bounded ZIP reader is shared from modelGeometry, and fflate stays in its one allowed file', () => {
  const bytes = F.bambuAssembly3mf();
  const models = readModelArchive(bytes, { want: (n) => n.endsWith('.model') });
  assert.deepEqual(Object.keys(models).sort(), ['3D/3dmodel.model', '3D/Objects/object_1.model']);
  assert.throws(() => readModelArchive(bytes, { maxWantedBytes: 100 }), /ARCHIVE_TOO_LARGE/);
  const source = readFileSync(new URL('../worker/lib/personalize/compile.ts', import.meta.url), 'utf8');
  assert.equal(/from\s+['"]fflate/.test(source), false, 'the compiler reads packages through readModelArchive');
});
