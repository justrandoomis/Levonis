/**
 * THE VIEWER CORE (Programme C, phase C1, lane L7) — src/lib/viewer, extracted
 * once from src/pages/ModelViewer.tsx and extended for the studio.
 *
 *   - `parseLvm` is the page's own function: the OLD one is copied below as the
 *     oracle and both are run over the same fixtures;
 *   - the LVR1 trailer: ranges read, anything we did not write refused;
 *   - `loadMesh`: a gzip round trip (Node 22 has CompressionStream and
 *     DecompressionStream), a plain body, a 404, `{unsupported}`;
 *   - picking: a ray through a known triangle returns it and its part, a miss
 *     returns null, 60k triangles in < 20 ms (the measured figure is printed);
 *   - the shader sources: WebGL1's 8 varyings, `uRegion[16]` indexed only in
 *     the vertex shader, ≤ 4 decal areas, a shared uniform's precision, the
 *     page's shaders statement-for-statement;
 *   - ModelViewer's strings and `data-viewer` hooks, its two 404s and its
 *     no-WebGL branch; the page loads the core and nothing of the studio;
 *   - no ogl `Raycast` anywhere in src/, ogl `Texture` only in decals.ts, no
 *     motion library in the viewer core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseLvm } from '../src/lib/viewer/lvm';
import { loadMesh, MAX_PARTS, readRegions } from '../src/lib/viewer/mesh';
import { partOfTriangle, pickTriangle, rayFromScreen } from '../src/lib/viewer/pick';
import { GRID_FRAG, GRID_VERT, MODEL_FRAG, MODEL_VERT } from '../src/lib/viewer/shaders';
import { MARKER_FRAG, MARKER_VERT, STUDIO_FRAG, STUDIO_VERT } from '../src/lib/viewer/studioShaders';
import { ATLAS_SIZE, ATLAS_SLOTS, atlasRects } from '../src/lib/viewer/decals';
import { FINISHES, MAX_AREAS, MAX_REGIONS } from '../src/lib/viewer/studio';
import { frameDistance } from '../src/lib/viewer/scene';
import { AR_FLOOR_Y, AR_FORWARD_Z, AR_SCALE } from '../src/lib/viewer/xr';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// ------------------------------------------------------------------ oracles

interface OracleMesh {
  triangles: number;
  position: Float32Array;
  normal: Float32Array;
  corner: Uint8Array;
  min: [number, number, number];
  max: [number, number, number];
}

/** src/pages/ModelViewer.tsx `parseLvm` as it was before the extraction, verbatim. */
function oracleParseLvm(buffer: ArrayBuffer): OracleMesh | null {
  if (buffer.byteLength < 32) return null;
  const head = new DataView(buffer);
  if (head.getUint8(0) !== 0x4c || head.getUint8(1) !== 0x56) return null;
  if (head.getUint8(2) !== 0x4d || head.getUint8(3) !== 0x31) return null;

  const triangles = head.getUint32(4, true);
  const floats = triangles * 9;
  if (triangles === 0 || buffer.byteLength < 32 + floats * 4) return null;

  const min: [number, number, number] = [
    head.getFloat32(8, true),
    head.getFloat32(12, true),
    head.getFloat32(16, true),
  ];
  const max: [number, number, number] = [
    head.getFloat32(20, true),
    head.getFloat32(24, true),
    head.getFloat32(28, true),
  ];

  const position = new Float32Array(buffer, 32, floats);
  const normal = new Float32Array(floats);
  const corner = new Uint8Array(triangles * 3);

  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const ax = position[o], ay = position[o + 1], az = position[o + 2];
    const e1x = position[o + 3] - ax, e1y = position[o + 4] - ay, e1z = position[o + 5] - az;
    const e2x = position[o + 6] - ax, e2y = position[o + 7] - ay, e2z = position[o + 8] - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    // A degenerate triangle has no direction to point in. Leaving it at zero
    // drops it to ambient rather than flashing a wrong-facing highlight.
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) { nx /= len; ny /= len; nz /= len; }
    for (let v = 0; v < 3; v++) {
      normal[o + v * 3] = nx;
      normal[o + v * 3 + 1] = ny;
      normal[o + v * 3 + 2] = nz;
      corner[t * 3 + v] = v;
    }
  }

  return { triangles, position, normal, corner, min, max };
}

/** The page's strings before the extraction (this lane changes none; ckb is a follow-up). */
const ORIGINAL_STR = {
  ar: {
    loading: 'جارٍ تحميل المجسم',
    title: 'معاينة المجسم',
    simplified: 'معاينة مبسّطة',
    simplifiedHint: 'شكل مبسّط من المجسم للتسعير، والملف الأصلي أدق تفصيلًا.',
    gone: 'هذا الرابط لم يعد صالحًا',
    goneHint: 'اطلب رابط عرض جديدًا ممن أرسله إليك.',
    failed: 'تعذّر فتح العارض',
    failedHint: 'حدّث الصفحة بعد قليل.',
    noPreview: 'لا تتوفر معاينة ثلاثية الأبعاد لهذا الملف، والقياسات معروضة أدناه.',
    noWebgl: 'متصفحك لا يدعم العرض ثلاثي الأبعاد، لذلك تظهر القياسات وحدها.',
    dims: 'الأبعاد',
    volume: 'الحجم',
    triangles: 'المثلثات',
    parts: 'عدد القطع',
    format: 'الصيغة',
    reset: 'إعادة ضبط العرض',
    grid: 'الشبكة الأرضية',
    wireframe: 'الهيكل السلكي',
    ar: 'عرض بالواقع المعزز',
    arExit: 'إنهاء الواقع المعزز',
    arFailed: 'تعذّر تشغيل الواقع المعزز على هذا الجهاز.',
    hint: 'اسحب للتدوير · قرّب للتكبير',
    mm: 'ملم',
    cm3: 'سم³',
  },
  en: {
    loading: 'Loading the model',
    title: 'Model preview',
    simplified: 'Simplified preview',
    simplifiedHint: 'A simplified shape of the model for quoting; the original file is more detailed.',
    gone: 'This link is no longer valid',
    goneHint: 'Ask whoever sent it for a fresh viewing link.',
    failed: 'The viewer could not be opened',
    failedHint: 'Refresh the page shortly.',
    noPreview: 'No 3D preview is available for this file. The measurements are below.',
    noWebgl: 'Your browser cannot render 3D, so only the measurements are shown.',
    dims: 'Dimensions',
    volume: 'Volume',
    triangles: 'Triangles',
    parts: 'Parts',
    format: 'Format',
    reset: 'Reset view',
    grid: 'Ground grid',
    wireframe: 'Wireframe',
    ar: 'View in AR',
    arExit: 'Exit AR',
    arFailed: 'Augmented reality could not start on this device.',
    hint: 'Drag to rotate · pinch to zoom',
    mm: 'mm',
    cm3: 'cm³',
  },
};

/** The page's shaders before the extraction, comments and all. */
const ORIGINAL_MODEL_VERT = `
attribute vec3 position;
attribute vec3 normal;
attribute float corner;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  vNormal = normalMatrix * normal;
  // Barycentric weights unpacked from the corner index — three floats the
  // vertex stage makes up, so the wireframe costs one byte per vertex on the
  // bus instead of twelve.
  vBary = vec3(float(corner < 0.5), float(corner > 0.5 && corner < 1.5), float(corner > 1.5));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ORIGINAL_MODEL_FRAG = `
precision highp float;
uniform vec3 uBase;
uniform vec3 uAccent;
uniform float uWire;
varying vec3 vNormal;
varying vec3 vBary;
void main() {
  // Uploaded meshes have unreliable winding — a customer's export may hand us
  // inside-out triangles — so instead of culling, the normal is flipped toward
  // whichever side is being looked at. Nothing ever renders black.
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;

  // View space: the key light rides just over the viewer's shoulder, so the
  // form reads the same however the part is turned.
  float key = dot(n, normalize(vec3(0.42, 0.72, 0.55))) * 0.5 + 0.5;
  float fill = max(dot(n, normalize(vec3(-0.7, -0.25, 0.35))), 0.0);
  float rim = pow(1.0 - clamp(abs(n.z), 0.0, 1.0), 3.0);
  vec3 col = uBase * (0.17 + 0.85 * key * key + 0.16 * fill) + uAccent * rim * 0.5;

  if (uWire > 0.5) {
    float edge = min(min(vBary.x, vBary.y), vBary.z);
    // A fixed threshold rather than fwidth(): derivatives need an extension on
    // WebGL1, and this is a toggle, not the primary read of the model.
    float line = 1.0 - smoothstep(0.0, 0.04, edge);
    col = mix(col * 0.3, uAccent, line * 0.85);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const ORIGINAL_GRID_VERT = `
attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uHalf;
varying float vFade;
void main() {
  vFade = 1.0 - clamp(length(position.xz) / uHalf, 0.0, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ORIGINAL_GRID_FRAG = `
precision mediump float;
uniform vec3 uColor;
varying float vFade;
void main() {
  // Squared falloff so the grid dissolves instead of ending on a hard square.
  gl_FragColor = vec4(uColor, vFade * vFade * 0.5);
}
`;

// ------------------------------------------------------------------ fixtures

type Tri = [number, number, number, number, number, number, number, number, number];

/** A deterministic generator: the fixtures are the same on every run. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** LVM1 bytes for a triangle soup (centred on its bbox, as viewerMesh writes), plus an optional LVR1 trailer. */
function lvm(tris: Tri[], ranges?: number[][], extra = 0): ArrayBuffer {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (let i = 0; i < 9; i++) { min[i % 3] = Math.min(min[i % 3], t[i]); max[i % 3] = Math.max(max[i % 3], t[i]); }
  const c = [0, 1, 2].map((k) => (min[k] + max[k]) / 2);
  const trailer = ranges ? 8 + ranges.length * 8 : 0;
  const buf = new ArrayBuffer(32 + tris.length * 36 + trailer + extra);
  const v = new DataView(buf);
  [0x4c, 0x56, 0x4d, 0x31].forEach((b, i) => v.setUint8(i, b));
  v.setUint32(4, tris.length, true);
  for (let k = 0; k < 3; k++) {
    v.setFloat32(8 + k * 4, min[k] - c[k], true);
    v.setFloat32(20 + k * 4, max[k] - c[k], true);
  }
  let o = 32;
  for (const t of tris) for (let i = 0; i < 9; i++, o += 4) v.setFloat32(o, t[i] - c[i % 3], true);
  if (ranges) {
    [0x4c, 0x56, 0x52, 0x31].forEach((b, i) => v.setUint8(o + i, b));
    v.setUint16(o + 4, ranges.length, true);
    v.setUint16(o + 6, 0, true);
    ranges.forEach(([start, count], i) => {
      v.setUint32(o + 8 + i * 8, start, true);
      v.setUint32(o + 12 + i * 8, count, true);
    });
  }
  return buf;
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Tri[] {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const q = (a: number, b: number, c: number, d: number): Tri[] => [[...p[a], ...p[b], ...p[c]] as Tri, [...p[a], ...p[c], ...p[d]] as Tri];
  return [...q(0, 3, 2, 1), ...q(4, 5, 6, 7), ...q(0, 1, 5, 4), ...q(2, 3, 7, 6), ...q(1, 2, 6, 5), ...q(3, 0, 4, 7)];
}

function soup(n: number, seed: number, spread = 100): Tri[] {
  const r = lcg(seed);
  return Array.from({ length: n }, () => {
    const a = [r() * spread, r() * spread, r() * spread];
    return [...a, a[0] + r() * 4, a[1] + r() * 4, a[2] + r() * 4, a[0] + r() * 4, a[1] + r() * 4, a[2] + r() * 4] as Tri;
  });
}

/** A three-part stand: a base, an upright plate, a cylinder accessory. */
const STAND_PARTS: Tri[][] = [box(-40, -30, 0, 40, 30, 8), box(-35, -4, 8, 35, 4, 40), (() => {
  const out: Tri[] = [];
  const n = 24, r = 9, z = 40, h = 14;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const c0 = [Math.cos(a0) * r, Math.sin(a0) * r], c1 = [Math.cos(a1) * r, Math.sin(a1) * r];
    out.push([c0[0], c0[1], z, c1[0], c1[1], z, c1[0], c1[1], z + h], [c0[0], c0[1], z, c1[0], c1[1], z + h, c0[0], c0[1], z + h], [0, 0, z + h, c0[0], c0[1], z + h, c1[0], c1[1], z + h]);
  }
  return out;
})()];
const STAND = STAND_PARTS.flat();
const STAND_RANGES = [[0, 12], [12, 12], [24, STAND_PARTS[2].length]];

function sameMesh(a: OracleMesh | null, b: ReturnType<typeof parseLvm>, label: string, sameInput = true) {
  if (a === null || b === null) {
    assert.equal(b, a, `${label}: both refuse`);
    return;
  }
  assert.equal(b.triangles, a.triangles, `${label}: triangles`);
  assert.deepEqual(b.min, a.min, `${label}: min`);
  assert.deepEqual(b.max, a.max, `${label}: max`);
  assert.deepEqual(Array.from(b.position), Array.from(a.position), `${label}: position`);
  assert.deepEqual(Array.from(b.normal), Array.from(a.normal), `${label}: normal`);
  assert.deepEqual(Array.from(b.corner), Array.from(a.corner), `${label}: corner`);
  if (sameInput) assert.equal(b.position.buffer, a.position.buffer, `${label}: positions stay a view over the response`);
  assert.equal(b.position.byteOffset, 32, `${label}: the view starts after the header`);
}

// ------------------------------------------------------------------ parseLvm

test('parseLvm answers exactly what the page parsed before the extraction', () => {
  const r = lcg(7);
  const fixtures: [string, ArrayBuffer][] = [
    ['the stand', lvm(STAND)],
    ['the stand with its LVR1 trailer (trailing bytes ignored)', lvm(STAND, STAND_RANGES)],
    ['one triangle', lvm([[0, 0, 0, 10, 0, 0, 0, 10, 0]])],
    ['a degenerate triangle (zero normal)', lvm([[1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 0, 0, 5, 0, 0, 0, 5, 0]])],
    ['a random soup', lvm(soup(500, 3))],
    ['random trailing bytes', lvm(soup(40, 11), undefined, 13)],
  ];
  for (let i = 0; i < 6; i++) fixtures.push([`random soup #${i}`, lvm(soup(1 + Math.floor(r() * 300), 100 + i, 1 + r() * 400))]);
  for (const [label, buf] of fixtures) sameMesh(oracleParseLvm(buf), parseLvm(buf), label);

  // Refusals: too short, wrong magic, zero triangles, a body shorter than its count.
  const good = lvm(STAND);
  const bad: [string, ArrayBuffer][] = [
    ['empty', new ArrayBuffer(0)],
    ['31 bytes', good.slice(0, 31)],
    ['header only', good.slice(0, 32)],
    ['truncated body', good.slice(0, 32 + 36 * 10)],
  ];
  const wrong = good.slice(0);
  new DataView(wrong).setUint8(3, 0x32); // 'LVM2'
  bad.push(['wrong magic', wrong]);
  const zero = good.slice(0);
  new DataView(zero).setUint32(4, 0, true);
  bad.push(['zero triangles', zero]);
  for (const [label, buf] of bad) {
    assert.equal(oracleParseLvm(buf), null, `${label}: the old page refused`);
    assert.equal(parseLvm(buf), null, `${label}: the core refuses`);
  }
});

// ------------------------------------------------------------------ LVR1

test('readRegions reads the LVR1 ranges and refuses a trailer we did not write', () => {
  assert.deepEqual(Array.from(readRegions(lvm(STAND, STAND_RANGES))!), STAND_RANGES.flat());
  assert.equal(readRegions(lvm(STAND)), null, 'no trailer: one part');
  // A part the compiler emptied keeps its index.
  assert.deepEqual(Array.from(readRegions(lvm(STAND, [[0, 12], [12, 0], [12, 12], [24, 72]]))!), [0, 12, 12, 0, 12, 12, 24, 72]);
  // Ranges may stop short of the block (the rest is no part), never run past it.
  assert.deepEqual(Array.from(readRegions(lvm(STAND, [[0, 24]]))!), [0, 24]);
  assert.equal(readRegions(lvm(STAND, [[0, 12], [12, 12], [24, 73]])), null, 'past the triangle block');
  assert.equal(readRegions(lvm(STAND, [[1, 12]])), null, 'not from triangle 0');
  assert.equal(readRegions(lvm(STAND, [[0, 12], [13, 12]])), null, 'not contiguous');
  assert.equal(readRegions(lvm(STAND, [[0, 12], [0, 12]])), null, 'out of order');
  const many = Array.from({ length: MAX_PARTS + 1 }, (_, i) => [i, 1]);
  assert.equal(readRegions(lvm(soup(MAX_PARTS + 1, 5), many)), null, `more than ${MAX_PARTS} parts`);
  assert.equal(MAX_PARTS, 64, 'the blueprint limit');
  const ok = lvm(STAND, STAND_RANGES);
  assert.equal(readRegions(ok.slice(0, ok.byteLength - 1)), null, 'a truncated trailer');
  const renamed = ok.slice(0);
  new DataView(renamed).setUint8(32 + STAND.length * 36 + 2, 0x58); // 'LVX1'
  assert.equal(readRegions(renamed), null, 'another magic');
  const none = ok.slice(0);
  new DataView(none).setUint16(32 + STAND.length * 36 + 4, 0, true);
  assert.equal(readRegions(none), null, 'zero parts');
  // Names never enter the file: the trailer is 8 + 8·parts bytes, nothing else.
  assert.equal(ok.byteLength, 32 + STAND.length * 36 + 8 + STAND_RANGES.length * 8);
});

// ------------------------------------------------------------------ loadMesh

const gzip = async (buf: ArrayBuffer) =>
  new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();

async function withFetch<T>(answer: (url: string, init?: RequestInit) => Response, run: (calls: { url: string; init?: RequestInit }[]) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(String(input), init);
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test('loadMesh inflates a published .lvm.gz through DecompressionStream and reads its parts', async () => {
  const raw = lvm(STAND, STAND_RANGES);
  const gz = await gzip(raw);
  assert.ok(gz.byteLength < raw.byteLength, 'the fixture really is compressed');
  const url = '/files/merchants/u_1/public/bp/bp_1-r3-0123456789ab.lvm.gz';
  const signal = new AbortController().signal;
  await withFetch(() => new Response(gz, { headers: { 'content-type': 'application/gzip' } }), async (calls) => {
    const got = await loadMesh(url, { signal });
    assert.ok(got && 'mesh' in got, 'a mesh');
    sameMesh(oracleParseLvm(raw), got.mesh, 'inflated', false);
    assert.deepEqual(Array.from(got.ranges!), STAND_RANGES.flat());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].init?.credentials, 'same-origin');
    assert.equal(calls[0].init?.signal, signal, 'the caller can abort');
  });
  // A plain LVM1 body is read as it is (a builder's draft), whatever the header says.
  await withFetch(() => new Response(raw, { headers: { 'content-type': 'application/octet-stream' } }), async () => {
    const got = await loadMesh('/draft.lvm');
    assert.ok(got && 'mesh' in got);
    assert.equal(got.mesh.triangles, STAND.length);
    assert.equal(got.ranges?.length, 6);
  });
  await withFetch(() => new Response('gone', { status: 404 }), async () => assert.equal(await loadMesh(url), null, 'not ok'));
  await withFetch(() => new Response('not a mesh'), async () => assert.equal(await loadMesh('/x.lvm'), null, 'not LVM1'));
});

test('loadMesh answers {unsupported} where the browser cannot inflate — before spending the download on a .gz', async () => {
  const g = globalThis as { DecompressionStream?: unknown };
  const real = g.DecompressionStream;
  const gz = await gzip(lvm(STAND));
  try {
    delete g.DecompressionStream;
    await withFetch(() => new Response(gz), async (calls) => {
      assert.deepEqual(await loadMesh('/files/merchants/u_1/public/bp/a.lvm.gz'), { unsupported: true });
      assert.deepEqual(await loadMesh('/files/merchants/u_1/public/bp/a.lvm.gz?v=2'), { unsupported: true });
      assert.equal(calls.length, 0, 'nothing fetched for a .gz it cannot read');
      // Sniffed: a gzip body behind a URL that does not say so.
      assert.deepEqual(await loadMesh('/mesh'), { unsupported: true });
      assert.equal(calls.length, 1);
    });
    // A plain mesh still loads without DecompressionStream.
    await withFetch(() => new Response(lvm(STAND)), async () => {
      const got = await loadMesh('/mesh');
      assert.ok(got && 'mesh' in got);
    });
  } finally {
    g.DecompressionStream = real;
  }
});

// ------------------------------------------------------------------ picking

test('pickTriangle: a ray through a known triangle returns it, both faces, the nearest; a miss is null', () => {
  const one = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const down = pickTriangle({ o: [2, 2, 10], d: [0, 0, -1] }, one);
  assert.deepEqual(down && { t: down.triangle, p: down.point, d: down.distance }, { t: 0, p: [2, 2, 0], d: 10 });
  const up = pickTriangle({ o: [2, 2, -10], d: [0, 0, 1] }, one);
  assert.equal(up?.triangle, 0, 'the back face too: winding is not trusted');
  assert.equal(pickTriangle({ o: [8, 8, 10], d: [0, 0, -1] }, one), null, 'outside the triangle');
  assert.equal(pickTriangle({ o: [2, 2, 10], d: [0, 0, 1] }, one), null, 'behind the ray');
  assert.equal(pickTriangle({ o: [2, 2, 10], d: [1, 0, 0] }, one), null, 'parallel');

  // Two stacked triangles: the nearest wins; `test` skips a hidden one.
  const two = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 0, 10, 5]);
  assert.equal(pickTriangle({ o: [2, 2, 10], d: [0, 0, -1] }, two)?.triangle, 1);
  assert.equal(pickTriangle({ o: [2, 2, 10], d: [0, 0, -1] }, two, { test: (t) => t !== 1 })?.triangle, 0);
  // The bbox rejects a ray that passes the whole mesh by.
  const bbox = { min: [0, 0, 0], max: [10, 10, 5] };
  assert.equal(pickTriangle({ o: [50, 50, 10], d: [0, 0, -1] }, two, { bbox }), null);
  assert.equal(pickTriangle({ o: [2, 2, 10], d: [0, 0, -1] }, two, { bbox })?.triangle, 1);
});

test('a tap finds the part: triangle → LVR1 part by binary search; a part the compiler emptied is skipped', () => {
  const buf = lvm(STAND, STAND_RANGES);
  const mesh = parseLvm(buf)!;
  const ranges = readRegions(buf)!;
  // Straight down onto the plate's top (centred frame: z − 27).
  const plate = pickTriangle({ o: [20, 0, 100], d: [0, 0, -1] }, mesh.position, { bbox: mesh })!;
  assert.equal(partOfTriangle(ranges, plate.triangle), 1);
  assert.deepEqual(plate.point.map((v) => Math.round(v * 1000) / 1000), [20, 0, 13]);
  const base = pickTriangle({ o: [-38, 25, 100], d: [0, 0, -1] }, mesh.position, { bbox: mesh })!;
  assert.equal(partOfTriangle(ranges, base.triangle), 0);
  const top = pickTriangle({ o: [0, 0, 100], d: [0, 0, -1] }, mesh.position, { bbox: mesh })!;
  assert.equal(partOfTriangle(ranges, top.triangle), 2, 'the cylinder accessory');
  assert.equal(pickTriangle({ o: [0, 60, 100], d: [0, 0, -1] }, mesh.position, { bbox: mesh }), null, 'beside the model');

  const gaps = [0, 12, 12, 0, 12, 0, 12, 5];
  assert.equal(partOfTriangle(gaps, 0), 0);
  assert.equal(partOfTriangle(gaps, 11), 0);
  assert.equal(partOfTriangle(gaps, 12), 3, 'the empty parts 1 and 2 hold nothing');
  assert.equal(partOfTriangle(gaps, 16), 3);
  assert.equal(partOfTriangle(gaps, 17), -1, 'past the last range');
  assert.equal(partOfTriangle([], 0), -1);
  const wide = Array.from({ length: 64 }, (_, i) => [i * 10, 10]).flat();
  for (const t of [0, 9, 10, 315, 639]) assert.equal(partOfTriangle(wide, t), Math.floor(t / 10));
});

test('rayFromScreen: the pixel through a perspective camera, into the model\'s own millimetres', () => {
  // Camera at (0, 0, 10) looking down −Z, 90° field, square: projection diagonal 1.
  const camera = {
    projectionMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.02, -1, 0, 0, -0.2, 0],
    worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1],
  };
  const centre = rayFromScreen(camera, 50, 50, 100, 100);
  assert.deepEqual(centre, { o: [0, 0, 10], d: [0, 0, -1] });
  const corner = rayFromScreen(camera, 0, 0, 100, 100);
  const k = 1 / Math.sqrt(3);
  assert.deepEqual(corner.d.map((v) => Math.round(v * 1e6) / 1e6), [-k, k, -k].map((v) => Math.round(v * 1e6) / 1e6), 'top-left: −x, +y');
  // A model scaled ×0.5 about the origin: toLocal = its inverse (×2).
  const local = rayFromScreen(camera, 50, 50, 100, 100, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1]);
  assert.deepEqual(local, { o: [0, 0, 20], d: [0, 0, -1] });
});

test('60k triangles are picked in under 20 ms (measured; the plan asks < 5 ms)', (t) => {
  const tris = soup(60_000, 42, 200);
  const buf = lvm(tris);
  const mesh = parseLvm(buf)!;
  assert.equal(mesh.triangles, 60_000);
  const r = lcg(9);
  // Rays aimed at random triangles' centroids: the walk is always complete.
  const rays = Array.from({ length: 40 }, () => {
    const i = Math.floor(r() * 60_000) * 9;
    const p = mesh.position;
    const c = [(p[i] + p[i + 3] + p[i + 6]) / 3, (p[i + 1] + p[i + 4] + p[i + 7]) / 3, (p[i + 2] + p[i + 5] + p[i + 8]) / 3];
    return { o: [c[0], c[1], c[2] + 500] as [number, number, number], d: [0, 0, -1] as [number, number, number] };
  });
  for (const ray of rays.slice(0, 5)) pickTriangle(ray, mesh.position, { bbox: mesh }); // warm the JIT
  let hits = 0;
  const t0 = performance.now();
  for (const ray of rays) if (pickTriangle(ray, mesh.position, { bbox: mesh })) hits++;
  const each = (performance.now() - t0) / rays.length;
  t.diagnostic(`pickTriangle over 60,000 triangles: ${each.toFixed(3)} ms per pick (${rays.length} picks, Node ${process.version})`);
  assert.equal(hits, rays.length, 'every aimed ray lands');
  assert.ok(each < 20, `${each.toFixed(2)} ms per pick`);
});

// ------------------------------------------------------------------ shaders

const stripComments = (glsl: string) => glsl.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
const varyings = (glsl: string) => (glsl.match(/^\s*varying\s/gm) ?? []).length;

test('the page\'s shaders are its own, statement for statement (only the in-string comments left for JS comments)', () => {
  assert.equal(MODEL_VERT, stripComments(ORIGINAL_MODEL_VERT));
  assert.equal(MODEL_FRAG, stripComments(ORIGINAL_MODEL_FRAG));
  assert.equal(GRID_VERT, stripComments(ORIGINAL_GRID_VERT));
  assert.equal(GRID_FRAG, stripComments(ORIGINAL_GRID_FRAG));
  for (const s of [MODEL_VERT, MODEL_FRAG, GRID_VERT, GRID_FRAG]) assert.doesNotMatch(s, /\/\//, 'no comment ships to the GPU');
});

test('the studio shaders fit WebGL1: 8 varyings, uRegion[16] indexed only in the vertex shader, ≤ 4 decal areas', () => {
  const on = (glsl: string) => '#define DECALS\n' + glsl;
  for (const [name, glsl] of Object.entries({ STUDIO_VERT, STUDIO_FRAG, MARKER_VERT, MARKER_FRAG, MODEL_VERT, MODEL_FRAG, GRID_VERT, GRID_FRAG })) {
    assert.ok(varyings(on(glsl)) <= 8, `${name}: ${varyings(glsl)} varyings`);
    assert.doesNotMatch(glsl, /#version|\btexture\(|^\s*(in|out)\s/m, `${name}: GLSL ES 1.00`);
    assert.doesNotMatch(glsl, /#[0-9a-fA-F]{3,8}\b/, `${name}: no colour literal written as hex`);
  }
  assert.equal(varyings(STUDIO_VERT), varyings(STUDIO_FRAG), 'the stages agree on the varyings');
  assert.ok(varyings(STUDIO_VERT) <= 7, 'the plan: ≤ 7 of WebGL1\'s 8');

  // Regions: a Uint8 attribute into uRegion[16], dynamic indexing in the vertex stage ONLY.
  assert.match(STUDIO_VERT, /attribute float region;/);
  assert.match(STUDIO_VERT, /uniform vec3 uRegion\[16\];/);
  assert.match(STUDIO_VERT, /uRegion\[r\]/, 'indexed by the vertex\'s region');
  assert.doesNotMatch(STUDIO_FRAG, /uRegion|uFinish/, 'never in the fragment shader');
  for (const [, index] of STUDIO_FRAG.matchAll(/\w\[([^\]]+)\]/g)) assert.match(index, /^\d+$/, `fragment index ${index} is a constant`);
  assert.equal(MAX_REGIONS, 16);

  // Decals: four areas, the projection in the vertex stage, the fragment only samples.
  for (const u of ['uAO', 'uAN', 'uAU']) assert.match(STUDIO_VERT, new RegExp(`uniform vec3 ${u}\\[4\\];`));
  assert.match(STUDIO_VERT, /uniform vec4 uAS\[4\];/);
  assert.match(STUDIO_FRAG, /uniform vec4 uRect\[4\];/);
  assert.equal((STUDIO_VERT.match(/decal\(\d\)/g) ?? []).length, 4);
  assert.doesNotMatch(STUDIO_FRAG, /uAO|uAN|uAU|uAS|cross\(/, 'no projection in the fragment stage');
  assert.equal(MAX_AREAS, 4);
  assert.equal(ATLAS_SLOTS, 4);
  assert.equal(ATLAS_SIZE, 1024);

  // Fragment uniforms: WebGL1 guarantees 16 vectors.
  let vectors = 0;
  for (const [, type, size] of STUDIO_FRAG.matchAll(/uniform\s+(?:\w+p\s+)?(\w+)\s+\w+(?:\[(\d+)\])?;/g)) if (type !== 'sampler2D') vectors += Number(size ?? 1);
  assert.ok(vectors <= 16, `${vectors} fragment uniform vectors`);

  // A uniform both stages declare must agree on precision (or the program does not link):
  // the fragment stage defaults to mediump, so the vertex stage says it.
  const declared = (glsl: string) => new Set([...glsl.matchAll(/uniform\s+(?:\w+p\s+)?\w+\s+(\w+)/g)].map((m) => m[1]));
  const vert = declared(STUDIO_VERT);
  for (const name of declared(STUDIO_FRAG)) {
    if (!vert.has(name)) continue;
    assert.match(STUDIO_VERT, new RegExp(`uniform mediump \\w+ ${name};`), `${name}: mediump in the vertex stage`);
  }
});

test('the atlas: four slots of one 1024² canvas, each shaped like its area and inside its own quadrant', () => {
  const rects = atlasRects([62 / 18, 1, 0.5]);
  assert.equal(rects.length, 4);
  rects.forEach((r, k) => {
    const qx = (k % 2) * 512, qy = (k >> 1) * 512;
    assert.ok(r.x >= qx + 2 && r.y >= qy + 2 && r.x + r.w <= qx + 510 && r.y + r.h <= qy + 510, `slot ${k} keeps its gutter`);
    for (const v of [r.x, r.y, r.w, r.h]) assert.ok(Number.isInteger(v), 'whole pixels (getImageData)');
  });
  assert.ok(Math.abs(rects[0].w / rects[0].h - 62 / 18) < 0.02, 'a name plate stays wide');
  assert.equal(rects[1].w, rects[1].h, 'a QR stays square');
  assert.ok(Math.abs(rects[2].w / rects[2].h - 0.5) < 0.01, 'a tall area stays tall');
  assert.equal(rects[3].w, rects[3].h, 'an undeclared slot is square');
});

test('finishes are parameters; the studio\'s presets stay inside 0–1', () => {
  for (const [name, f] of Object.entries(FINISHES)) {
    for (const v of Object.values(f)) assert.ok(v >= 0 && v <= 1, `${name}`);
  }
  assert.deepEqual(Object.keys(FINISHES), ['classic', 'matte', 'shiny', 'silk', 'glow']);
});

// ------------------------------------------------------------------ the scene's numbers

test('the scene keeps the page\'s camera, framing, orbit, grid, clear colour and AR numbers', () => {
  const scene = read('src/lib/viewer/scene.ts');
  for (const pinned of [
    "new Camera(gl, { fov: 35, near: 0.03, far: 200 })",
    "antialias: true,",
    "dpr: Math.min(window.devicePixelRatio || 1, 2),",
    "[0.0196, 0.0196, 0.0235, 1]",
    "const radius = 0.5 * Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;",
    "corner: { size: 1, data: data.corner, type: raw.UNSIGNED_BYTE },",
    "uBase: { value: [0.70, 0.71, 0.74] },",
    "uAccent: { value: [0.729, 0.639, 0.412] },",
    "cullFace: false,",
    "frustumCulled: false",
    "model.rotation.x = -Math.PI / 2;",
    "const half = Math.max((Math.max(ex, ey) / 2) * fit * 1.7, 1.25);",
    "const divisions = 14;",
    "uniforms: { uColor: { value: [0.45, 0.42, 0.33] }, uHalf: { value: half } },",
    "grid.position.y = floorY - 0.004;",
    "const az = Math.PI * 0.3;",
    "const el = Math.PI * 0.17;",
    "enablePan: false,",
    "ease: o.reducedMotion ? 1 : 0.2,",
    "inertia: o.reducedMotion ? 0 : 0.72,",
    "rotateSpeed: 0.13,",
    "zoomSpeed: 1,",
    "minDistance: 0.55,",
    "maxDistance: initialDistance * 4,",
    "controls.maxDistance = d * 4;",
    "document.addEventListener('visibilitychange', onVisibility);",
    "raw.getExtension('WEBGL_lose_context')",
  ]) assert.ok(scene.includes(pinned), `scene.ts keeps: ${pinned}`);
  // The page's loop: a frame per refresh while visible, unless the caller renders on demand.
  assert.match(scene, /raf = o\.tick \? 0 : window\.requestAnimationFrame\(frame\);/);
  const vFov = (35 * Math.PI) / 180;
  assert.equal(frameDistance(35, 1.5), 1.18 / Math.sin(vFov / 2), 'wide: the vertical field is the tight one');
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * 0.46);
  assert.equal(frameDistance(35, 0.46), 1.18 / Math.sin(hFov / 2), 'a phone: the horizontal one');
  assert.equal(frameDistance(35, 0), frameDistance(35, 1), 'no aspect yet: square');
  assert.equal(AR_SCALE, 0.001);
  assert.equal(AR_FLOOR_Y, -0.45);
  assert.equal(AR_FORWARD_Z, -0.7);
  const xr = read('src/lib/viewer/xr.ts');
  assert.ok(xr.includes(".requestSession('immersive-ar', { optionalFeatures: ['local-floor'] })"));
  assert.ok(xr.includes("await session.requestReferenceSpace('local')"));
  assert.ok(xr.includes('return xr && Layer ? { xr, Layer } : null;'), 'both halves or nothing');
});

// ------------------------------------------------------------------ the page

test('ModelViewer keeps its strings, hooks, two 404s and no-WebGL branch — and loads the core, never the studio', () => {
  const page = read('src/pages/ModelViewer.tsx');
  for (const lang of ['ar', 'en'] as const) {
    for (const [key, value] of Object.entries(ORIGINAL_STR[lang])) {
      assert.ok(page.includes(`    ${key}: '${value}',`), `STR.${lang}.${key} unchanged`);
    }
  }
  assert.equal((page.match(/^ {4}\w+: '/gm) ?? []).length, Object.keys(ORIGINAL_STR.ar).length * 2, 'no string added or dropped');
  assert.ok(page.includes("const t = lang === 'en' ? STR.en : STR.ar;"), 'Sorani readers still get the Arabic (ckb is a follow-up)');
  for (const hook of [
    'data-page="model-viewer"',
    "data-viewer={ready ? 'ready' : undefined}",
    'data-viewer="canvas"',
    'data-viewer="simplified"',
    'data-viewer="ar"',
    'data-viewer="grid"',
    'data-viewer="wireframe"',
    'data-viewer="reset"',
    'data-viewer="info"',
    'data-viewer-field="dimensions"',
    'data-viewer-field="volume"',
    'data-viewer-field="triangles"',
    'data-viewer-field="parts"',
  ]) assert.ok(page.includes(hook), `hook ${hook}`);
  // Two 404s, two meanings: the metadata one is the dead link, the mesh one is «no preview».
  assert.ok(page.includes("setFatal(e instanceof ApiError && e.status === 404 ? 'gone' : 'failed');"));
  assert.ok(page.includes('/api/marketplace/print/viewer/${encodeURIComponent(token)}/mesh'));
  assert.match(page, /if \(!res\.ok\) \{\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*setNoPreview\(true\);/);
  assert.match(page, /viewer = mountScene\(canvas, mesh, \{[\s\S]*?\}\);\s*\} catch \{\s*setNoWebgl\(true\);/, 'no WebGL → the measurements alone');
  assert.ok(page.includes("const showCanvas = !fatal && !noWebgl && !noPreview;"));
  // The page is the page: the 3D is the core's, and the studio never rides along.
  assert.doesNotMatch(page, /from 'ogl'/);
  const imports = [...page.matchAll(/from '(\.\.\/lib\/viewer\/[^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../lib/viewer/lvm', '../lib/viewer/scene', '../lib/viewer/xr']);
  // …and neither do the core modules import the studio's (the pair budget).
  const graph = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const [, spec] of read(`src/lib/viewer/${file}.ts`).matchAll(/^import (?!type )[^;]*from '\.\/(\w+)';/gm)) graph(spec, seen);
    return seen;
  };
  const core = new Set<string>();
  for (const f of ['lvm', 'scene', 'xr']) for (const m of graph(f)) core.add(m);
  assert.deepEqual([...core].sort(), ['lvm', 'scene', 'shaders', 'xr'], 'the chunk the page loads: lvm, scene, shaders, xr');
});

// ------------------------------------------------------------------ imports across src/

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

test('ogl: no Raycast anywhere in src/, Texture only in the decals module, the page\'s set plus Texture', () => {
  const files = sources('src');
  const oglNames = new Map<string, string[]>();
  for (const f of files) {
    for (const [, names] of readFileSync(join(ROOT, f), 'utf8').matchAll(/^import\s+\{([^}]*)\}\s+from\s+'ogl';/gm)) {
      oglNames.set(f, [...(oglNames.get(f) ?? []), ...names.split(',').map((n) => n.trim()).filter(Boolean)]);
    }
  }
  /** A module nothing in src/ imports is dead code: it never reaches a chunk. */
  const imported = (f: string) => {
    const base = f.replace(/^.*\//, '').replace(/\.tsx?$/, '');
    return files.some((g) => g !== f && new RegExp(`from '[^']*/${base}'`).test(readFileSync(join(ROOT, g), 'utf8')));
  };
  const live = [...oglNames].filter(([f]) => imported(f) || f.startsWith('src/pages/'));
  for (const [f, names] of oglNames) assert.ok(!names.includes('Raycast'), `${f} imports Raycast`);
  for (const [f, names] of live) {
    if (names.includes('Texture')) assert.equal(relative('.', f), join('src', 'lib', 'viewer', 'decals.ts'), `${f} imports Texture`);
  }
  const shipped = new Set(live.flatMap(([, names]) => names));
  assert.deepEqual([...shipped].sort(), ['Camera', 'Geometry', 'Mesh', 'Orbit', 'Program', 'Renderer', 'Texture', 'Transform'], 'vendor-webgl grows by Texture alone');
});

test('the viewer core imports no motion library, never a remote font, and writes no colour as hex', () => {
  for (const f of sources(join('src', 'lib', 'viewer'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    // Code only: a comment may name the token a number stands for (the page's ground, the gold).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
    assert.doesNotMatch(src, /from '(motion|motion\/react|motion\/react-m|framer-motion)[^']*'/, `${f}: motion`);
    assert.doesNotMatch(src, /fonts\.(googleapis|gstatic)\.com/, `${f}: a remote font`);
    assert.doesNotMatch(code, /\bdark:|#[0-9a-fA-F]{6}\b/, `${f}: a theme hex or dark: class`);
  }
});
