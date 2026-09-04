/**
 * MODEL GEOMETRY, pinned against fixtures whose true answers are known by hand.
 *
 * Everything here is checked against a shape whose volume, area and dimensions
 * can be worked out on paper — a 10mm cube is 1000mm³ and 600mm², a unit
 * tetrahedron is 1/6 — because a geometry test that only compares the code to
 * itself proves the code is consistent, not that it is right. And these numbers
 * become a price, so "consistent" is not enough.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
  analyseModel,
  sniffFormat,
  formatFromName,
  viewerMesh,
  FORMAT_CAPABILITIES,
} from '../worker/lib/modelGeometry';

// ---------------------------------------------------------------- fixtures

/** The 12 triangles of an axis-aligned box, wound so the normals point out. */
function boxTriangles(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): number[][] {
  const v = (i: number, j: number, k: number) => [ox + i * sx, oy + j * sy, oz + k * sz];
  const p000 = v(0, 0, 0), p100 = v(1, 0, 0), p110 = v(1, 1, 0), p010 = v(0, 1, 0);
  const p001 = v(0, 0, 1), p101 = v(1, 0, 1), p111 = v(1, 1, 1), p011 = v(0, 1, 1);
  return [
    // bottom (-Z), wound clockwise seen from below so the normal points down
    [p000, p110, p100].flat(), [p000, p010, p110].flat(),
    // top (+Z)
    [p001, p101, p111].flat(), [p001, p111, p011].flat(),
    // front (-Y)
    [p000, p100, p101].flat(), [p000, p101, p001].flat(),
    // back (+Y)
    [p010, p011, p111].flat(), [p010, p111, p110].flat(),
    // left (-X)
    [p000, p001, p011].flat(), [p000, p011, p010].flat(),
    // right (+X)
    [p100, p110, p111].flat(), [p100, p111, p101].flat(),
  ].map((t) => t as number[]);
}

function binaryStl(triangles: number[][], header = 'levonis test'): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < Math.min(header.length, 79); i++) out[i] = header.charCodeAt(i);
  dv.setUint32(80, triangles.length, true);
  let at = 84;
  for (const t of triangles) {
    dv.setFloat32(at, 0, true); dv.setFloat32(at + 4, 0, true); dv.setFloat32(at + 8, 0, true);
    at += 12;
    for (let i = 0; i < 9; i++) {
      dv.setFloat32(at, t[i], true);
      at += 4;
    }
    dv.setUint16(at, 0, true);
    at += 2;
  }
  return out;
}

function asciiStl(triangles: number[][], name = 'part'): Uint8Array {
  let s = `solid ${name}\n`;
  for (const t of triangles) {
    s += '  facet normal 0 0 0\n    outer loop\n';
    for (let v = 0; v < 3; v++) s += `      vertex ${t[v * 3]} ${t[v * 3 + 1]} ${t[v * 3 + 2]}\n`;
    s += '    endloop\n  endfacet\n';
  }
  s += `endsolid ${name}\n`;
  return new TextEncoder().encode(s);
}

/** An indexed mesh of the same box, for the formats that store indices. */
function boxIndexed(size: number) {
  const c = [
    [0, 0, 0], [size, 0, 0], [size, size, 0], [0, size, 0],
    [0, 0, size], [size, 0, size], [size, size, size], [0, size, size],
  ];
  const f = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return { vertices: c, faces: f };
}

function threeMf(size: number, unit = 'millimeter'): Uint8Array {
  const { vertices, faces } = boxIndexed(size);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">Bracket A</metadata>` +
    `<resources><basematerials id="1"><base name="PETG" displaycolor="#1B7F3BFF"/></basematerials>` +
    `<object id="2" type="model" name="Bracket A"><mesh><vertices>` +
    vertices.map((v) => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('') +
    `</vertices><triangles>` +
    faces.map((f) => `<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('') +
    `</triangles></mesh></object></resources>` +
    `<build><item objectid="2"/></build></model>`;
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    '3D/3dmodel.model': strToU8(xml),
  });
}

function objFile(size: number): Uint8Array {
  const { vertices, faces } = boxIndexed(size);
  let s = '# levonis test\n';
  for (const v of vertices) s += `v ${v[0]} ${v[1]} ${v[2]}\n`;
  for (const f of faces) s += `f ${f[0] + 1}/1/1 ${f[1] + 1}/1/1 ${f[2] + 1}/1/1\n`;
  return new TextEncoder().encode(s);
}

function amfFile(size: number, unit = 'millimeter'): Uint8Array {
  const { vertices, faces } = boxIndexed(size);
  const xml =
    `<?xml version="1.0"?><amf unit="${unit}"><metadata type="name">AMF Box</metadata><object id="1"><mesh><vertices>` +
    vertices.map((v) => `<vertex><coordinates><x>${v[0]}</x><y>${v[1]}</y><z>${v[2]}</z></coordinates></vertex>`).join('') +
    `</vertices><volume>` +
    faces.map((f) => `<triangle><v1>${f[0]}</v1><v2>${f[1]}</v2><v3>${f[2]}</v3></triangle>`).join('') +
    `</volume></mesh></object></amf>`;
  return new TextEncoder().encode(xml);
}

function glbFile(size: number): Uint8Array {
  const { vertices, faces } = boxIndexed(size);
  const posBytes = new Float32Array(vertices.flat());
  const idxBytes = new Uint16Array(faces.flat());
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const idxOffset = posBytes.byteLength;
  const binLen = idxOffset + idxBytes.byteLength + pad4(idxBytes.byteLength);
  const bin = new Uint8Array(binLen);
  bin.set(new Uint8Array(posBytes.buffer), 0);
  bin.set(new Uint8Array(idxBytes.buffer), idxOffset);

  const json = {
    asset: { version: '2.0', generator: 'levonis-test' },
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices.length, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: faces.length * 3, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = jsonBytes.length + pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set([0x67, 0x6c, 0x54, 0x46], 0); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonLen; i++) out[20 + i] = 0x20; // JSON pads with spaces
  const binChunkAt = 20 + jsonLen;
  dv.setUint32(binChunkAt, binLen, true);
  dv.setUint32(binChunkAt + 4, 0x004e4942, true); // 'BIN'
  out.set(bin, binChunkAt + 8);
  return out;
}

const near = (actual: number, expected: number, tol: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);

// ------------------------------------------------------ 1. format detection

test('the bytes decide the format, not the file name', () => {
  // A 3MF renamed to .stl is still a 3MF, and reading it as an STL would fail.
  assert.equal(sniffFormat(threeMf(10), 'model.stl'), '3mf');
  assert.equal(sniffFormat(binaryStl(boxTriangles(10, 10, 10)), 'anything.bin'), 'stl');
  assert.equal(sniffFormat(glbFile(10), 'x.glb'), 'glb');
  assert.equal(sniffFormat(new TextEncoder().encode("ISO-10303-21;\nHEADER;\n"), 'p.step'), 'step');
  assert.equal(sniffFormat(objFile(10), 'box.obj'), 'obj');
  assert.equal(sniffFormat(amfFile(10), 'box.amf'), 'amf');
});

test('a binary STL whose header starts with "solid" is still read as binary', () => {
  // The classic trap: the length arithmetic must decide, not the leading word.
  const bytes = binaryStl(boxTriangles(10, 10, 10), 'solid exported by something');
  assert.equal(sniffFormat(bytes, 'a.stl'), 'stl');
  const a = analyseModel(bytes, 'a.stl');
  assert.equal(a.triangle_count, 12);
  near(a.volume_mm3, 1000, 0.01, 'volume');
});

test('capabilities are stated per promise, not as one supported flag', () => {
  assert.deepEqual(FORMAT_CAPABILITIES.stl, {
    previewable: true, measurable: true, sliceable: true, convertible: true, reference_only: false,
  });
  // glTF renders and measures but no slicer opens it — so it is not sliceable.
  assert.equal(FORMAT_CAPABILITIES.glb.sliceable, false);
  assert.equal(FORMAT_CAPABILITIES.glb.measurable, true);
  // STEP promises exactly one thing.
  assert.deepEqual(FORMAT_CAPABILITIES.step, {
    previewable: false, measurable: false, sliceable: false, convertible: false, reference_only: true,
  });
  assert.equal(formatFromName('a.STP'), 'step');
});

// ---------------------------------------------- 2. the numbers are the truth

test('a 10mm cube measures 1000mm3, 600mm2 and 10x10x10', () => {
  for (const [label, bytes] of [
    ['binary STL', binaryStl(boxTriangles(10, 10, 10))],
    ['ASCII STL', asciiStl(boxTriangles(10, 10, 10))],
    ['3MF', threeMf(10)],
    ['OBJ', objFile(10)],
    ['AMF', amfFile(10)],
    ['GLB', glbFile(10)],
  ] as Array<[string, Uint8Array]>) {
    const a = analyseModel(bytes, `cube.${label.toLowerCase().includes('stl') ? 'stl' : label.toLowerCase()}`);
    assert.equal(a.measured, true, `${label}: should measure`);
    assert.equal(a.triangle_count, 12, `${label}: triangles`);
    near(a.volume_mm3, 1000, 0.01, `${label} volume`);
    near(a.surface_area_mm2, 600, 0.01, `${label} area`);
    near(a.dimensions_mm.x, 10, 0.001, `${label} x`);
    near(a.dimensions_mm.y, 10, 0.001, `${label} y`);
    near(a.dimensions_mm.z, 10, 0.001, `${label} z`);
  }
});

test('a non-cubic box keeps its three dimensions apart', () => {
  const a = analyseModel(binaryStl(boxTriangles(40, 20, 5)), 'plate.stl');
  near(a.dimensions_mm.x, 40, 0.001, 'x');
  near(a.dimensions_mm.y, 20, 0.001, 'y');
  near(a.dimensions_mm.z, 5, 0.001, 'z');
  near(a.volume_mm3, 4000, 0.01, 'volume');
  // 2*(40*20 + 20*5 + 40*5) = 2*(800+100+200) = 2200
  near(a.surface_area_mm2, 2200, 0.01, 'area');
});

test('the bounding box is where the part actually is, not at the origin', () => {
  const a = analyseModel(binaryStl(boxTriangles(10, 10, 10, 100, -50, 7)), 'offset.stl');
  near(a.bbox_min_mm.x, 100, 0.001, 'min x');
  near(a.bbox_min_mm.y, -50, 0.001, 'min y');
  near(a.bbox_max_mm.z, 17, 0.001, 'max z');
  near(a.dimensions_mm.x, 10, 0.001, 'x is still 10');
});

test('a closed box is watertight and is one part', () => {
  const a = analyseModel(binaryStl(boxTriangles(10, 10, 10)), 'cube.stl');
  assert.equal(a.watertight, true);
  assert.equal(a.shell_count, 1);
  assert.equal(a.warnings.some((w) => w.code === 'NOT_WATERTIGHT'), false);
});

test('two separated boxes are counted as two parts', () => {
  const bytes = binaryStl([...boxTriangles(10, 10, 10), ...boxTriangles(10, 10, 10, 50, 0, 0)]);
  const a = analyseModel(bytes, 'two.stl');
  assert.equal(a.shell_count, 2);
  near(a.volume_mm3, 2000, 0.01, 'both volumes add up');
  assert.equal(a.warnings.some((w) => w.code === 'MANY_PARTS'), true);
});

test('a hole in the mesh is reported, not silently measured', () => {
  const tris = boxTriangles(10, 10, 10);
  tris.pop(); // one face of the box removed
  const a = analyseModel(binaryStl(tris), 'open.stl');
  assert.equal(a.watertight, false);
  const w = a.warnings.find((x) => x.code === 'NOT_WATERTIGHT');
  assert.ok(w, 'the hole is named');
  assert.equal(w!.severity, 'warning');
  assert.ok((w!.detail!.open_edges as number) > 0);
});

// ------------------------------------------------------------- 3. the units

test('3MF is trusted about its unit; STL is only assumed to be millimetres', () => {
  const mm = analyseModel(threeMf(10, 'millimeter'), 'a.3mf');
  assert.equal(mm.unit_source, 'declared');
  near(mm.dimensions_mm.x, 10, 0.001, 'mm');

  const cm = analyseModel(threeMf(10, 'centimeter'), 'a.3mf');
  assert.equal(cm.unit_source, 'declared');
  near(cm.dimensions_mm.x, 100, 0.001, 'a 10cm box is 100mm');
  near(cm.volume_mm3, 1_000_000, 1, '10cm cube = 1,000,000 mm3');

  const inch = analyseModel(threeMf(1, 'inch'), 'a.3mf');
  near(inch.dimensions_mm.x, 25.4, 0.001, 'one inch');

  const stl = analyseModel(binaryStl(boxTriangles(10, 10, 10)), 'a.stl');
  assert.equal(stl.unit_source, 'assumed');
  assert.equal(stl.warnings.some((w) => w.code === 'UNIT_ASSUMED'), true);
});

// -------------------------------------------------- 4. what the file tells us

test('3MF metadata is read instead of being asked for', () => {
  const a = analyseModel(threeMf(10), 'bracket.3mf');
  assert.equal(a.title, 'Bracket A');
  assert.equal(a.suggested_material, 'PETG');
  assert.deepEqual(a.suggested_colors, ['#1b7f3b']);
});

test('an ASCII STL solid name becomes the title', () => {
  const a = analyseModel(asciiStl(boxTriangles(10, 10, 10), 'gearbox_lid'), 'x.stl');
  assert.equal(a.title, 'gearbox_lid');
});

test('a STEP file is accepted, named, and honestly not measured', () => {
  const step = new TextEncoder().encode(
    "ISO-10303-21;\nHEADER;\nFILE_NAME('flange_v3.step','2026-01-01',(''),(''),'','','');\nENDSEC;\n"
  );
  const a = analyseModel(step, 'flange.step');
  assert.equal(a.measured, false);
  assert.equal(a.reason, 'STEP_NEEDS_CAD_KERNEL');
  assert.equal(a.title, 'flange_v3.step');
  assert.equal(a.capability.reference_only, true);
  assert.equal(a.volume_mm3, 0, 'no invented volume');
});

// ------------------------------------------------------- 5. the printability

test('overhang area is measured, not guessed', () => {
  // A box has exactly one fully downward face: 100mm2 of 600mm2.
  const a = analyseModel(binaryStl(boxTriangles(10, 10, 10)), 'cube.stl');
  near(a.overhang_area_mm2, 100, 0.01, 'the underside');
  near(a.overhang_ratio, 100 / 600, 0.001, 'ratio');
});

test('a thin sheet is flagged as thin', () => {
  const a = analyseModel(binaryStl(boxTriangles(50, 50, 0.4)), 'sheet.stl');
  assert.equal(a.warnings.some((w) => w.code === 'THIN_FEATURES'), true);
});

test('a part far larger than any bed is flagged as a probable unit mistake', () => {
  const a = analyseModel(binaryStl(boxTriangles(2000, 30, 30)), 'huge.stl');
  assert.equal(a.warnings.some((w) => w.code === 'VERY_LARGE'), true);
});

test('inverted normals are noticed but do not change the volume', () => {
  // Reverse the winding of every triangle: the signed sum flips, the size does not.
  const flipped = boxTriangles(10, 10, 10).map((t) => [
    t[0], t[1], t[2], t[6], t[7], t[8], t[3], t[4], t[5],
  ]);
  const a = analyseModel(binaryStl(flipped), 'inside-out.stl');
  near(a.volume_mm3, 1000, 0.01, 'still a 1cm3 cube');
  assert.equal(a.warnings.some((w) => w.code === 'INVERTED_NORMALS'), true);
});

test('complexity separates a plain box from a finely tessellated one', () => {
  const plain = analyseModel(binaryStl(boxTriangles(20, 20, 20)), 'plain.stl');
  // The same box, subdivided: each face split into many small triangles.
  const dense: number[][] = [];
  const N = 12;
  for (const t of boxTriangles(20, 20, 20)) {
    for (let i = 0; i < N; i++) {
      // Degenerate-free subdivision is not needed for the ratio being tested:
      // repeat the face as N slivers by interpolating toward its centroid.
      const cx = (t[0] + t[3] + t[6]) / 3, cy = (t[1] + t[4] + t[7]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
      const f = (i + 1) / (N + 1);
      dense.push([
        t[0] + (cx - t[0]) * f, t[1] + (cy - t[1]) * f, t[2] + (cz - t[2]) * f,
        t[3] + (cx - t[3]) * f, t[4] + (cy - t[4]) * f, t[5] + (cz - t[5]) * f,
        t[6] + (cx - t[6]) * f, t[7] + (cy - t[7]) * f, t[8] + (cz - t[8]) * f,
      ]);
    }
  }
  const complex = analyseModel(binaryStl(dense), 'dense.stl');
  assert.ok(complex.complexity > plain.complexity, `${complex.complexity} should exceed ${plain.complexity}`);
  assert.ok(plain.complexity >= 0 && complex.complexity <= 1, 'stays in 0..1');
});

// ------------------------------------------------------------ 6. the refusals

test('an unreadable file is a result with a reason, never a crash', () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const a = analyseModel(junk, 'mystery.stl');
  assert.equal(a.measured, false);
  assert.ok(a.reason, 'says why');
  assert.equal(a.volume_mm3, 0);
});

test('an empty file does not measure', () => {
  const a = analyseModel(new Uint8Array(0), 'empty.stl');
  assert.equal(a.measured, false);
});

test('a truncated 3MF reports a parse failure rather than a wrong size', () => {
  const good = threeMf(10);
  const a = analyseModel(good.subarray(0, Math.floor(good.length / 2)), 'broken.3mf');
  assert.equal(a.measured, false);
  assert.ok(String(a.reason).startsWith('PARSE_FAILED') || a.reason === 'NO_GEOMETRY', a.reason);
});

test('a face index outside the vertex list drops that face, not the model', () => {
  const obj = new TextEncoder().encode('v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\nf 1 2 99\n');
  const a = analyseModel(obj, 'partial.obj');
  assert.equal(a.triangle_count, 1, 'the good face survived');
  assert.equal(a.measured, true);
});

// -------------------------------------------------------- 7. the viewer mesh

test('the viewer mesh is a derived preview, not the uploaded file', () => {
  const src = binaryStl(boxTriangles(10, 10, 10));
  const mesh = viewerMesh(src, 'cube.stl');
  assert.ok(mesh, 'a mesh is produced');
  // The header says what it is and how big, and the geometry is centred.
  assert.deepEqual([...mesh!.subarray(0, 4)], [0x4c, 0x56, 0x4d, 0x31], "magic is 'LVM1'");
  const dv = new DataView(mesh!.buffer, mesh!.byteOffset, mesh!.byteLength);
  assert.equal(dv.getUint32(4, true), 12, 'twelve triangles');
  near(dv.getFloat32(8, true), -5, 0.001, 'centred: min x');
  near(dv.getFloat32(20, true), 5, 0.001, 'centred: max x');
  assert.equal(mesh!.length, 32 + 12 * 9 * 4, 'positions only — no names, no materials');
  // Nothing of the original container survives: no 80-byte STL header text.
  assert.equal(new TextDecoder().decode(mesh!).includes('levonis test'), false);
});

test('a big model is decimated for the viewer rather than refused', () => {
  const many: number[][] = [];
  for (let i = 0; i < 3000; i++) many.push(...boxTriangles(1, 1, 1, i * 2, 0, 0));
  const mesh = viewerMesh(binaryStl(many), 'many.stl', 1000);
  assert.ok(mesh);
  const dv = new DataView(mesh!.buffer, mesh!.byteOffset, mesh!.byteLength);
  const kept = dv.getUint32(4, true);
  assert.ok(kept <= 1000 && kept > 0, `kept ${kept}`);
});

test('a reference-only format yields no viewer mesh at all', () => {
  const step = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\n');
  assert.equal(viewerMesh(step, 'a.step'), null);
});
