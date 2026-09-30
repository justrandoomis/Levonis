/**
 * THE MESH CONTRACT, READ IN THE BROWSER — part of the one viewer core
 * (src/lib/viewer), shared by the model viewer page and the studio.
 *
 * LVM1 is what worker/lib/modelGeometry.ts `viewerMesh` writes:
 * 'LVM1' | u32 triangles | 6×f32 bbox, then 9×f32 per triangle —
 * little-endian, millimetres, centred on the bbox centre. A published
 * blueprint mesh (worker/lib/personalize/compile.ts) appends ONE trailer after
 * the triangle block: 'LVR1' | u16 parts | u16 0 | parts × (u32 start,
 * u32 count), counted in triangles, contiguous, in part order — ranges only,
 * never a name (the names stay merchant-only in product_blueprints.parts).
 * `parseLvm` has always ignored trailing bytes, so the trailer costs the model
 * viewer nothing; `readRegions` (./mesh.ts, the studio's side) is the only
 * reader of it.
 *
 * THE BROWSER NEVER PARSES THE CUSTOMER'S FILE: these are the Worker's derived
 * bytes, which is why a 32-byte header reader stands here instead of a model
 * loader (tests/store-isolation.test.ts keeps slicer payload out of the store).
 */

/** The decoded LVM1 payload, already in the shape the GPU wants. */
export interface ParsedMesh {
  triangles: number;
  position: Float32Array;
  normal: Float32Array;
  /** 0 / 1 / 2 per vertex — the corner index, used only for the wireframe. */
  corner: Uint8Array;
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * LVM1 → GPU buffers.
 *
 * Layout: 'LVM1' | uint32 triangles | 6×float32 bbox | triangles×9 float32,
 * little-endian, millimetres, already centred on the origin. No indices and no
 * normals, so a flat normal is computed per triangle here and repeated across
 * its three vertices — flat shading is also the RIGHT look for a print preview,
 * where facets are what the machine will actually lay down.
 *
 * Positions are a VIEW over the response buffer rather than a copy: at the
 * 250k-triangle ceiling that is 9 MB saved per load, and WebGL requires
 * native-endian typed arrays anyway, so a Float32Array view is what the upload
 * path wants regardless.
 */
export function parseLvm(buffer: ArrayBuffer): ParsedMesh | null {
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
